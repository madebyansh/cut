import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { addRational, compareRational, multiplyRational, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { compositionNodeRoots, nodeReferences } from "../graph";
import { referenceAudioBackendLimits, referenceAudioCompositionRootIds } from "./audio-resource";

export type ReferencePrecompErrorCode =
  | "CUT_PRECOMP_INPUT"
  | "CUT_PRECOMP_REFERENCE"
  | "CUT_PRECOMP_TIMING"
  | "CUT_PRECOMP_FORMAT"
  | "CUT_PRECOMP_AUDIO"
  | "CUT_PRECOMP_CYCLE"
  | "CUT_PRECOMP_BUDGET"
  | "CUT_NESTED_INPUT"
  | "CUT_NESTED_REFERENCE"
  | "CUT_NESTED_TIMING"
  | "CUT_NESTED_FORMAT"
  | "CUT_NESTED_CYCLE"
  | "CUT_NESTED_BUDGET"
  | "CUT_MATCH_NESTING";

export const referencePrecompLimits = Object.freeze({
  maxDepth: 16,
  maxExpandedInstances: 1_024,
  maxExpandedFrames: 1_000_000,
  /**
   * Exact source samples evaluated from time zero while preparing nested audio
   * selections. Equal source+range preparations inside one composition are
   * charged once because the runtime reuses one prepared artifact.
   */
  maxExpandedSamples: 2_000_000_000,
  /**
   * Aggregate recursively prepared selected raw stereo f32le bytes. Reuse the
   * conservative non-RF64 media ceiling, rounded down to a complete 8-byte
   * stereo float frame.
   */
  maxRetainedRawF32Bytes: Number((referenceAudioBackendLimits.maximumPcmPayloadBytes / 8n) * 8n),
  /** Every recursively executed CUT composition obeys the ordinary runtime cap. */
  maxCompositionSeconds: 7_200,
});

export class ReferencePrecompError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferencePrecompErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferencePrecompError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

type ReferencePrecompConfigBase = Readonly<{
  nodeId: string;
  sourceCompositionId: string;
  sourceRange: Readonly<{ start: Rational; end: Rational }>;
  duration: Rational;
  frames: bigint;
  samples: bigint;
}>;

export type ReferencePrecompConfig =
  | (ReferencePrecompConfigBase & Readonly<{ kind: "visual" }>)
  | (ReferencePrecompConfigBase & Readonly<{ kind: "av" }>);

export function referenceNestedAudioPreparationKey(config: Extract<ReferencePrecompConfig, { kind: "av" }>) {
  return `${config.sourceCompositionId}\0${config.sourceRange.start.numerator}/${config.sourceRange.start.denominator}\0${config.sourceRange.end.numerator}/${config.sourceRange.end.denominator}`;
}

function fail(node: IRNode, code: ReferencePrecompErrorCode, message: string): never {
  throw new ReferencePrecompError(code, node, message);
}

function sameRational(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function localCompositionNodes(ir: CutAVIR, composition: IRComposition) {
  const selected = compositionNodeRoots(ir, composition.id);
  if (!selected) return new Set<string>();
  const pending = [...selected.roots], result = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const node = ir.nodes[id];
    if (node) pending.push(...node.children, ...nodeReferences(node));
  }
  return result;
}

function compositionHasAudioRoots(ir: CutAVIR, composition: IRComposition) {
  return referenceAudioCompositionRootIds(ir, composition).length > 0;
}

type TimelineRootOwners = ReadonlyMap<string, ReadonlySet<string>>;

function timelineRootOwners(ir: CutAVIR): TimelineRootOwners {
  const mutable = new Map<string, Set<string>>();
  const mark = (nodeId: string, compositionId: string) => {
    const owners = mutable.get(nodeId) ?? new Set<string>();
    owners.add(compositionId);
    mutable.set(nodeId, owners);
  };
  for (const composition of ir.compositions) {
    const rootIds = new Set([
      ...composition.rootVisualIds,
      ...composition.rootAudioIds,
      ...composition.rootAVIds,
      ...composition.items.flatMap((item) => item.kind === "node" ? [item.id] : []),
    ]);
    for (const nodeId of rootIds) mark(nodeId, composition.id);
  }
  return mutable;
}

function sourceTimeline(node: IRNode, value: IRValue | undefined) {
  if (value?.kind !== "timeline-ref") fail(node, node.op === "cut.edit.nested_sequence" ? "CUT_NESTED_INPUT" : "CUT_PRECOMP_INPUT", `${node.op === "cut.edit.nested_sequence" ? "NestedSequence" : "Precomp"} source must be a canonical Timeline reference`);
  return value.id;
}

function selectedSourceRange(node: IRNode, source: IRComposition) {
  const nested = node.op === "cut.edit.nested_sequence";
  const label = nested ? "NestedSequence" : "Precomp";
  const authored = node.inputs.range;
  if (authored === undefined) return { start: zeroRational, end: source.duration };
  if (authored.kind !== "range") fail(node, codeFor(node, "INPUT"), `${label} range must be Range<Time>`);
  if (!authored.exclusive) fail(node, codeFor(node, "INPUT"), `${label} range must use the half-open start ..< end form`);
  const start = authored.start, end = authored.end;
  if (start.kind !== "quantity" || start.dimension !== "time" || start.unit !== "s" || end.kind !== "quantity" || end.dimension !== "time" || end.unit !== "s") {
    fail(node, codeFor(node, "INPUT"), `${label} range endpoints must be canonical exact Time values`);
  }
  if (compareRational(start.magnitude, zeroRational) < 0 || compareRational(end.magnitude, start.magnitude) <= 0 || compareRational(end.magnitude, source.duration) > 0) {
    fail(node, codeFor(node, "TIMING"), `${label} range must be positive and remain inside source timeline “${source.name}”`);
  }
  return { start: start.magnitude, end: end.magnitude };
}

function codeFor(node: IRNode, suffix: "INPUT" | "REFERENCE" | "TIMING" | "FORMAT" | "CYCLE" | "BUDGET"): ReferencePrecompErrorCode {
  return `CUT_${node.op === "cut.edit.nested_sequence" ? "NESTED" : "PRECOMP"}_${suffix}` as ReferencePrecompErrorCode;
}

function exactFrameCount(node: IRNode, duration: Rational, fps: Rational, label: string) {
  const frames = multiplyRational(duration, fps);
  if (frames.denominator !== "1") fail(node, codeFor(node, "TIMING"), `${label} does not land on the exact ${fps.numerator}/${fps.denominator} fps frame grid`);
  const count = BigInt(frames.numerator);
  if (count < 0n) fail(node, codeFor(node, "TIMING"), `${label} cannot have a negative frame count`);
  return count;
}

function exactSampleCount(node: IRNode, duration: Rational, sampleRate: number, label: string) {
  const samples = multiplyRational(duration, { numerator: String(sampleRate), denominator: "1" });
  if (samples.denominator !== "1") fail(node, codeFor(node, "TIMING"), `${label} does not land on the exact ${sampleRate} Hz sample grid`);
  const count = BigInt(samples.numerator);
  if (count < 0n) fail(node, codeFor(node, "TIMING"), `${label} cannot have a negative sample count`);
  return count;
}

function validatePictureOnlySource(ir: CutAVIR, node: IRNode, source: IRComposition) {
  if (!source.sceneIds.length) fail(node, "CUT_PRECOMP_TIMING", `source timeline “${source.name}” has no picture scenes`);
  if (source.rootVisualIds.length || source.rootAudioIds.length || source.rootAVIds.length || source.items.some((item) => item.kind === "node")) {
    fail(node, "CUT_PRECOMP_AUDIO", `source timeline “${source.name}” contains timeline-level nodes; the 0.4 alpha Precomp slice accepts scene-contained picture only`);
  }
  let cursor = zeroRational;
  for (const sceneId of source.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (!scene) fail(node, "CUT_PRECOMP_REFERENCE", `source timeline “${source.name}” references missing scene ${sceneId}`);
    if (!sameRational(scene.start, cursor)) fail(node, "CUT_PRECOMP_TIMING", `source timeline “${source.name}” scenes must be contiguous and non-overlapping`);
    exactFrameCount(node, scene.start, source.fps, `source scene “${scene.name}” start`);
    exactFrameCount(node, scene.duration, source.fps, `source scene “${scene.name}” duration`);
    if (scene.rootAudioIds.length || scene.rootAVIds.length || scene.items.some((item) => item.domain !== "visual")) {
      fail(node, "CUT_PRECOMP_AUDIO", `source timeline “${source.name}” contains audio or linked AV; visual Precomp refuses to discard it`);
    }
    cursor = addRational(scene.start, scene.duration);
  }
  if (!sameRational(cursor, source.duration)) fail(node, "CUT_PRECOMP_TIMING", `source timeline “${source.name}” scenes must cover its duration exactly`);
  for (const nodeId of localCompositionNodes(ir, source)) {
    const sourceNode = ir.nodes[nodeId];
    if (!sourceNode) fail(node, "CUT_PRECOMP_REFERENCE", `source timeline “${source.name}” references missing node ${nodeId}`);
    if (sourceNode.domain !== "visual") fail(node, "CUT_PRECOMP_AUDIO", `source timeline “${source.name}” reaches non-picture node ${sourceNode.op}; visual Precomp refuses to discard audio or linked AV`);
    if (!sourceNode.sceneId || !source.sceneIds.includes(sourceNode.sceneId)) {
      fail(node, "CUT_PRECOMP_REFERENCE", `source timeline “${source.name}” reaches ${sourceNode.op} outside one of its picture scenes`);
    }
  }
}

function validateNestedSequenceSource(ir: CutAVIR, node: IRNode, source: IRComposition, rootOwners: TimelineRootOwners) {
  if (compareRational(source.duration, { numerator: String(referencePrecompLimits.maxCompositionSeconds), denominator: "1" }) > 0) {
    fail(node, "CUT_NESTED_BUDGET", `source timeline “${source.name}” exceeds the reference runtime's ${referencePrecompLimits.maxCompositionSeconds}-second composition limit`);
  }
  if (!source.sceneIds.length) fail(node, "CUT_NESTED_TIMING", `source timeline “${source.name}” has no picture scene clock`);
  if (source.rootVisualIds.length || source.rootAVIds.length || source.items.some((item) => item.kind === "node" && item.domain !== "audio")) {
    fail(node, "CUT_NESTED_INPUT", `source timeline “${source.name}” has unsupported timeline-level picture/AV nodes; place picture and linked AV inside scenes`);
  }
  let cursor = zeroRational;
  for (const sceneId of source.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (!scene) fail(node, "CUT_NESTED_REFERENCE", `source timeline “${source.name}” references missing scene ${sceneId}`);
    if (!sameRational(scene.start, cursor)) fail(node, "CUT_NESTED_TIMING", `source timeline “${source.name}” scenes must be contiguous and non-overlapping`);
    exactFrameCount(node, scene.start, source.fps, `source scene “${scene.name}” start`);
    exactFrameCount(node, scene.duration, source.fps, `source scene “${scene.name}” duration`);
    exactSampleCount(node, scene.start, source.sampleRate, `source scene “${scene.name}” start`);
    exactSampleCount(node, scene.duration, source.sampleRate, `source scene “${scene.name}” duration`);
    cursor = addRational(scene.start, scene.duration);
  }
  if (!sameRational(cursor, source.duration)) fail(node, "CUT_NESTED_TIMING", `source timeline “${source.name}” scenes must cover its duration exactly`);
  for (const nodeId of localCompositionNodes(ir, source)) {
    const sourceNode = ir.nodes[nodeId];
    if (!sourceNode) fail(node, "CUT_NESTED_REFERENCE", `source timeline “${source.name}” references missing node ${nodeId}`);
    if (sourceNode.sceneId && !source.sceneIds.includes(sourceNode.sceneId)) {
      fail(node, "CUT_NESTED_REFERENCE", `source timeline “${source.name}” reaches ${sourceNode.op} owned by another composition`);
    }
    if (!sourceNode.sceneId) {
      // The strict loader reconciles these root arrays with ordered items and
      // rejects multiple owners. Check both representations here as defence in
      // depth for direct in-memory runtime callers that have not loaded JSON.
      const timelineOwners = rootOwners.get(sourceNode.id);
      if (timelineOwners && [...timelineOwners].some((compositionId) => compositionId !== source.id)) {
        fail(node, "CUT_NESTED_REFERENCE", `source timeline “${source.name}” reaches timeline-level ${sourceNode.op} owned by another composition`);
      }
    }
  }
}

function closeReferencePrecompConfig(
  ir: CutAVIR,
  parent: IRComposition,
  node: IRNode,
  rootOwners: TimelineRootOwners,
): ReferencePrecompConfig | undefined {
  if (node.op !== "cut.visual.precomp" && node.op !== "cut.edit.nested_sequence") return undefined;
  const kind = node.op === "cut.edit.nested_sequence" ? "av" : "visual";
  const label = kind === "av" ? "NestedSequence" : "Precomp";
  const sourceId = sourceTimeline(node, node.inputs.source);
  const source = ir.compositions.find((candidate) => candidate.id === sourceId);
  if (!source) fail(node, codeFor(node, "REFERENCE"), `${label} references missing source timeline ${sourceId}`);
  const nestedSemanticMatch = ir.semanticMatches
    && (ir.semanticMatches.subjects.some((subject) => subject.compositionId === source.id)
      || ir.semanticMatches.transitions.some((transition) => transition.compositionId === source.id));
  if (nestedSemanticMatch) {
    fail(
      node,
      "CUT_MATCH_NESTING",
      `${label} source timeline “${source.name}” declares semantic-match subjects or transitions; the 0.4 alpha refuses nested match execution until match windows, scene ownership, cache identity, and frame evidence carry a collision-free composition-instance path`,
    );
  }
  if (!node.sceneId || !parent.sceneIds.includes(node.sceneId)) {
    fail(node, codeFor(node, "REFERENCE"), `${label} must belong to exactly one picture scene in its parent timeline`);
  }
  const owner = ir.scenes[node.sceneId];
  if (!owner) fail(node, codeFor(node, "REFERENCE"), `${label} parent scene ${node.sceneId} is missing`);
  if (node.domain !== kind || node.children.length) fail(node, codeFor(node, "INPUT"), `${label} must be a childless ${kind === "av" ? "audiovisual" : "visual"} timeline instance`);
  if (parent.width !== source.width || parent.height !== source.height) {
    fail(node, codeFor(node, "FORMAT"), `source timeline “${source.name}” canvas ${source.width}x${source.height} must equal parent ${parent.width}x${parent.height}; cross-canvas adaptation is not implicit`);
  }
  if (!sameRational(parent.fps, source.fps)) {
    fail(node, codeFor(node, "FORMAT"), `source timeline “${source.name}” fps ${source.fps.numerator}/${source.fps.denominator} must equal parent ${parent.fps.numerator}/${parent.fps.denominator}; frame-rate conversion is not implicit`);
  }
  if (parent.sampleRate !== source.sampleRate) {
    fail(node, codeFor(node, "FORMAT"), `source timeline “${source.name}” sample rate ${source.sampleRate} must equal parent ${parent.sampleRate}`);
  }
  const sourceRange = selectedSourceRange(node, source);
  const duration = subtractRational(sourceRange.end, sourceRange.start);
  if (compareRational(node.interval.start, zeroRational) < 0 || compareRational(node.interval.duration, zeroRational) <= 0 || compareRational(addRational(node.interval.start, node.interval.duration), owner.duration) > 0) {
    fail(node, codeFor(node, "TIMING"), `${label} destination interval must be positive and remain inside its parent scene`);
  }
  if (!sameRational(node.interval.duration, duration)) {
    fail(node, codeFor(node, "TIMING"), `${label} interval must equal its selected source duration exactly; hold, looping, and time stretching are not implicit`);
  }
  const placement = addRational(owner.start, node.interval.start);
  exactFrameCount(node, placement, parent.fps, `${label} destination start`);
  exactFrameCount(node, sourceRange.start, source.fps, `${label} source-range start`);
  exactFrameCount(node, sourceRange.end, source.fps, `${label} source-range end`);
  const frames = exactFrameCount(node, node.interval.duration, parent.fps, `${label} duration`);
  const samples = kind === "av"
    ? (exactSampleCount(node, sourceRange.start, source.sampleRate, `${label} source-range start`), exactSampleCount(node, sourceRange.end, source.sampleRate, `${label} source-range end`), exactSampleCount(node, placement, parent.sampleRate, `${label} destination start`), exactSampleCount(node, node.interval.duration, parent.sampleRate, `${label} duration`))
    : 0n;
  if (kind === "av") validateNestedSequenceSource(ir, node, source, rootOwners);
  else validatePictureOnlySource(ir, node, source);
  const nestedPlanarTrack = [...localCompositionNodes(ir, source)]
    .map((nodeId) => ir.nodes[nodeId])
    .find((candidate) => candidate?.op === "cut.visual.planar_track");
  if (nestedPlanarTrack) {
    fail(
      node,
      codeFor(node, "INPUT"),
      `${label} source timeline “${source.name}” contains PlanarTrack ${nestedPlanarTrack.id}; the 0.4 alpha refuses nested projective execution until frame evidence carries a collision-free composition-instance path`,
    );
  }
  return Object.freeze({
    kind,
    nodeId: node.id,
    sourceCompositionId: source.id,
    sourceRange: Object.freeze({ start: sourceRange.start, end: sourceRange.end }),
    duration,
    frames,
    samples,
  });
}

/** Close one visual Precomp/NestedSequence instance against its owner and source. */
export function referencePrecompConfig(ir: CutAVIR, parent: IRComposition, node: IRNode): ReferencePrecompConfig | undefined {
  return closeReferencePrecompConfig(ir, parent, node, timelineRootOwners(ir));
}

/**
 * Validate the reachable composition DAG and bound recursive render work.
 * Each Precomp instance is counted independently, including repeated instances
 * of the same source timeline, because each owns an independent playback clock.
 */
export function validateReferencePrecompGraph(ir: CutAVIR, root: IRComposition) {
  const rootOwners = timelineRootOwners(ir);
  const configs = new Map<string, ReferencePrecompConfig>();
  const compositionConfigs = new Map<string, Array<{ node: IRNode; config: ReferencePrecompConfig }>>();
  const collect = (composition: IRComposition) => {
    const cached = compositionConfigs.get(composition.id);
    if (cached) return cached;
    const entries: Array<{ node: IRNode; config: ReferencePrecompConfig }> = [];
    for (const nodeId of localCompositionNodes(ir, composition)) {
      const node = ir.nodes[nodeId];
      if (!node || (node.op !== "cut.visual.precomp" && node.op !== "cut.edit.nested_sequence")) continue;
      const config = closeReferencePrecompConfig(ir, composition, node, rootOwners)!;
      entries.push({ node, config }); configs.set(node.id, config);
    }
    compositionConfigs.set(composition.id, entries);
    return entries;
  };

  const visiting: string[] = [], visited = new Set<string>(), reachableCompositions = new Set<string>();
  const visit = (composition: IRComposition, incoming?: IRNode) => {
    const cycleAt = visiting.indexOf(composition.id);
    if (cycleAt >= 0) {
      const culprit = incoming ?? collect(composition)[0]?.node;
      if (!culprit) throw new Error(`Internal CUT Precomp cycle has no source node: ${[...visiting.slice(cycleAt), composition.id].join(" -> ")}`);
      fail(culprit, codeFor(culprit, "CYCLE"), `nested composition cycle ${[...visiting.slice(cycleAt), composition.id].join(" -> ")}`);
    }
    if (visiting.length >= referencePrecompLimits.maxDepth) {
      const culprit = incoming ?? collect(composition)[0]?.node;
      if (!culprit) throw new Error("Internal CUT Precomp depth overflow has no source node.");
      fail(culprit, codeFor(culprit, "BUDGET"), `nested composition depth exceeds maxDepth=${referencePrecompLimits.maxDepth}`);
    }
    if (visited.has(composition.id)) { reachableCompositions.add(composition.id); return; }
    visiting.push(composition.id); reachableCompositions.add(composition.id);
    for (const entry of collect(composition)) {
      const source = ir.compositions.find((candidate) => candidate.id === entry.config.sourceCompositionId);
      if (!source) fail(entry.node, codeFor(entry.node, "REFERENCE"), `nested composition references missing source timeline ${entry.config.sourceCompositionId}`);
      visit(source, entry.node);
    }
    visiting.pop(); visited.add(composition.id);
  };
  visit(root);

  const statsMemo = new Map<string, { instances: bigint; frames: bigint }>();
  const stats = (composition: IRComposition): { instances: bigint; frames: bigint } => {
    const cached = statsMemo.get(composition.id); if (cached) return cached;
    let instances = 0n, frames = 0n;
    for (const entry of collect(composition)) {
      const source = ir.compositions.find((candidate) => candidate.id === entry.config.sourceCompositionId)!;
      const nested = stats(source);
      instances += 1n + nested.instances;
      frames += entry.config.frames + nested.frames;
      if (instances > BigInt(referencePrecompLimits.maxExpandedInstances)) {
        fail(entry.node, codeFor(entry.node, "BUDGET"), `expanded nested graph exceeds maxExpandedInstances=${referencePrecompLimits.maxExpandedInstances}`);
      }
      if (frames > BigInt(referencePrecompLimits.maxExpandedFrames)) {
        fail(entry.node, codeFor(entry.node, "BUDGET"), `expanded nested graph exceeds maxExpandedFrames=${referencePrecompLimits.maxExpandedFrames}`);
      }
    }
    const result = { instances, frames }; statsMemo.set(composition.id, result); return result;
  };
  stats(root);

  type AudioPreparationStats = { historySamples: bigint; retainedRawF32Bytes: bigint; selections: bigint };
  const audioMemo = new Map<string, AudioPreparationStats>();
  const audioStats = (composition: IRComposition): AudioPreparationStats => {
    const cached = audioMemo.get(composition.id); if (cached) return cached;
    let historySamples = 0n, retainedRawF32Bytes = 0n, selections = 0n;
    const preparations = new Map<string, { node: IRNode; config: Extract<ReferencePrecompConfig, { kind: "av" }>; source: IRComposition }>();
    for (const entry of collect(composition)) {
      if (entry.config.kind !== "av") continue;
      const source = ir.compositions.find((candidate) => candidate.id === entry.config.sourceCompositionId)!;
      const key = referenceNestedAudioPreparationKey(entry.config);
      if (!preparations.has(key)) preparations.set(key, { node: entry.node, config: entry.config, source });
    }
    for (const { node, config, source } of preparations.values()) {
      // An audio-empty source becomes parent-clock silence directly and does
      // not allocate a nested preparation artifact.
      if (!compositionHasAudioRoots(ir, source)) continue;
      const nested = audioStats(source);
      // The causal source graph is evaluated from zero through the selected
      // range end. Only the selected raw stereo f32le interval is retained.
      historySamples += exactSampleCount(node, config.sourceRange.end, source.sampleRate, "NestedSequence prepared source history") + nested.historySamples;
      retainedRawF32Bytes += config.samples * 2n * 4n + nested.retainedRawF32Bytes;
      selections += 1n + nested.selections;
      if (historySamples > BigInt(referencePrecompLimits.maxExpandedSamples)) {
        fail(node, "CUT_NESTED_BUDGET", `deduplicated nested audio preparation exceeds maxExpandedSamples=${referencePrecompLimits.maxExpandedSamples} evaluated source-history samples`);
      }
      if (retainedRawF32Bytes > BigInt(referencePrecompLimits.maxRetainedRawF32Bytes)) {
        fail(node, "CUT_NESTED_BUDGET", `deduplicated nested audio preparation exceeds maxRetainedRawF32Bytes=${referencePrecompLimits.maxRetainedRawF32Bytes} selected raw stereo f32le bytes`);
      }
    }
    const result = { historySamples, retainedRawF32Bytes, selections }; audioMemo.set(composition.id, result); return result;
  };
  const audioPreparation = Object.freeze(audioStats(root));
  return Object.freeze({ configs, compositionIds: reachableCompositions, audioPreparation });
}
