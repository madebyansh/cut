import { hash } from "../core/stable";
import { referenceDependencyIdentity } from "../language/dependency-identity";
import type { ReferenceColorProfile } from "./reference/color-management";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../language/ir";
import { cutReferenceRuntimeIdentity } from "../version";
import { packageSpecifierForNative } from "../language/packages";
import { pictureEditOperationExecutableIdentity } from "../language/picture-edit-operations";
import { compareRational, divideRational, rational, zeroRational } from "../language/rational";
import { referenceSceneEncodingContract } from "./reference/scene-encoding";
import { decodedVideoCadenceDuration, decodedVideoCadenceQuantizations, type CutDecodedVideoCadence } from "../language/video-cadence";
import { directNodeConsumedMediaKinds, type CutConsumedMediaKind } from "../language/media-consumption";
import { decodedAudioSamplesDuration, type CutDecodedAudioSamples } from "../language/audio-sample-witness";
import {
  cutAudioProxyAlignmentContractV1,
  cutAudioProxyAlignmentContractV2,
  cutAudioProxyExecutionIdentity,
  type CutAudioProxyAlignment,
} from "../language/audio-proxy-alignment";
import {
  cutVideoProxyAlignmentContract,
  cutVideoProxyAlignmentIntegrity,
  cutVideoProxyExecutionIdentity,
  type CutVideoProxyAlignment,
} from "../language/video-proxy-alignment";
import { cutAnchoredSpatialOps } from "../language/anchored-path-contract";
import { timelineEditGraphIdentity } from "../language/timeline-edit-identity";
import {
  assertReferenceMediaProfileExecutionState,
  isReferenceMediaProfileExecution,
  referenceMediaProfileResourceState,
} from "./reference/media-profile-state";

export type CutGraphErrorCode = "CUT_AUDIO_GRAPH" | "CUT_GRAPH_CYCLE" | "CUT_GRAPH_REFERENCE" | "CUT_GRAPH_BUDGET" | "CUT_GRAPH_RESOURCE";

export type CutGraphLimits = {
  maxReachableNodes: number;
  maxReferences: number;
  maxDepth: number;
  maxExpansionVisits: number;
};

export const cutGraphLimits: Readonly<CutGraphLimits> = Object.freeze({
  maxReachableNodes: 100_000,
  maxReferences: 262_144,
  maxDepth: 512,
  // FFmpeg filter construction recursively expands shared audio subgraphs.
  // Bound path expansion, not only the number of unique IR nodes.
  maxExpansionVisits: 32_768,
});

export class CutGraphError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string } | { nodeId: string };

  constructor(readonly code: CutGraphErrorCode, readonly nodeId: string, node: IRNode | undefined, message: string) {
    const source = node
      ? { module: node.provenance.module, line: node.provenance.span.start.line, column: node.provenance.span.start.column, nodeId }
      : { nodeId };
    const location = "module" in source ? `${source.module}:${source.line}:${source.column}` : "unknown source";
    super(`${code}: ${message} at ${location}.`);
    this.name = "CutGraphError";
    this.source = source;
  }
}

function normalizedGraphLimits(overrides: Partial<CutGraphLimits>): CutGraphLimits {
  const limits = { ...cutGraphLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`CUT graph limit ${name} must be a positive safe integer.`);
  }
  return limits;
}

function nodeReferenceEdges(node: IRNode): string[] {
  const references: string[] = [...node.children];
  const visit = (value: IRValue) => {
    if (value.kind === "node-ref") references.push(value.id);
    else if (value.kind === "array") value.items.forEach(visit);
    else if (value.kind === "object") Object.values(value.entries).forEach(visit);
    else if (value.kind === "range") { visit(value.start); visit(value.end); }
    else if (value.kind === "unary") visit(value.value);
    else if (value.kind === "binary") { visit(value.left); visit(value.right); }
    else if (value.kind === "member") visit(value.object);
    else if (value.kind === "index") { visit(value.object); visit(value.index); }
    else if (value.kind === "call") { value.positional.forEach(visit); Object.values(value.named).forEach(visit); }
  };
  Object.values(node.inputs).forEach(visit);
  for (const value of Object.values(node.properties)) if (!("signal" in value)) visit(value);
  return references;
}

type GraphAnalysis = {
  references: Map<string, string[]>;
  topological: string[];
  reachableNodes: number;
  referenceEdges: number;
};

function analyzeCutNodeGraph(ir: CutAVIR, roots: readonly string[], overrides: Partial<CutGraphLimits> = {}): GraphAnalysis {
  const limits = normalizedGraphLimits(overrides), states = new Map<string, "visiting" | "done">(), references = new Map<string, string[]>(), topological: string[] = [];
  let referenceEdges = 0, reachableNodes = 0;
  type Frame = { id: string; node: IRNode; edges: string[]; next: number; depth: number };

  const push = (id: string, node: IRNode, depth: number, stack: Frame[]) => {
    reachableNodes += 1;
    if (reachableNodes > limits.maxReachableNodes) throw new CutGraphError("CUT_GRAPH_BUDGET", id, node, `CUT graph exceeds maxReachableNodes=${limits.maxReachableNodes}`);
    if (depth > limits.maxDepth) throw new CutGraphError("CUT_GRAPH_BUDGET", id, node, `CUT graph exceeds maxDepth=${limits.maxDepth}`);
    const edges = nodeReferenceEdges(node); references.set(id, edges); referenceEdges += edges.length;
    if (referenceEdges > limits.maxReferences) throw new CutGraphError("CUT_GRAPH_BUDGET", id, node, `CUT graph exceeds maxReferences=${limits.maxReferences}`);
    states.set(id, "visiting"); stack.push({ id, node, edges, next: 0, depth });
  };

  for (const root of roots) {
    if (states.get(root) === "done") continue;
    const rootNode = ir.nodes[root];
    if (!rootNode) throw new CutGraphError("CUT_GRAPH_REFERENCE", root, undefined, `CUT graph references missing root node ${root}`);
    const stack: Frame[] = []; push(root, rootNode, 1, stack);
    while (stack.length) {
      const current = stack.at(-1)!;
      if (current.next >= current.edges.length) {
        states.set(current.id, "done"); topological.push(current.id); stack.pop(); continue;
      }
      const referencedId = current.edges[current.next++], state = states.get(referencedId), referenced = ir.nodes[referencedId];
      if (!referenced) {
        const code = current.node.domain === "audio" ? "CUT_AUDIO_GRAPH" : "CUT_GRAPH_REFERENCE";
        throw new CutGraphError(code, current.id, current.node, `${current.node.op} references missing node ${referencedId}`);
      }
      if (state === "visiting") {
        const cycleStart = stack.findIndex((frame) => frame.id === referencedId), cycle = [...stack.slice(Math.max(0, cycleStart)).map((frame) => frame.id), referencedId];
        const audioCycle = stack.slice(Math.max(0, cycleStart)).some((frame) => frame.node.domain === "audio") || referenced.domain === "audio";
        throw new CutGraphError(audioCycle ? "CUT_AUDIO_GRAPH" : "CUT_GRAPH_CYCLE", current.id, current.node, `CUT graph cycle ${cycle.join(" -> ")} requires an explicit supported feedback/delay primitive`);
      }
      if (state === "done") continue;
      push(referencedId, referenced, current.depth + 1, stack);
    }
  }
  return { references, topological, reachableNodes, referenceEdges };
}

export function compositionNodeRoots(ir: CutAVIR, compositionId: string) {
  const composition = ir.compositions.find((item) => item.id === compositionId || item.name === compositionId);
  if (!composition) return undefined;
  const roots = new Set<string>([...composition.rootVisualIds, ...composition.rootAudioIds, ...composition.rootAVIds]);
  for (const item of composition.items) if (item.kind === "node") roots.add(item.id);
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId]; if (!scene) continue;
    for (const id of [...scene.rootVisualIds, ...scene.rootAudioIds, ...scene.rootAVIds]) roots.add(id);
    for (const item of scene.items) roots.add(item.id);
  }
  return { composition, roots: [...roots] };
}

/**
 * Refuse DAGs whose recursive execution would expand into an unsafe number of
 * compositor/audio-filter visits. This is deliberately checked before any
 * reference renderer constructs an FFmpeg command.
 */
export function assertCutGraphExecutionBudget(ir: CutAVIR, roots: readonly string[], overrides: Partial<CutGraphLimits> = {}) {
  const limits = normalizedGraphLimits(overrides), analysis = analyzeCutNodeGraph(ir, roots, limits), expansion = new Map<string, number>(), depths = new Map<string, number>();
  for (const id of analysis.topological) {
    let visits = 1, depth = 1;
    for (const referenced of analysis.references.get(id) ?? []) {
      visits += expansion.get(referenced) ?? 1;
      depth = Math.max(depth, 1 + (depths.get(referenced) ?? 1));
      if (!Number.isSafeInteger(visits) || visits > limits.maxExpansionVisits) {
        throw new CutGraphError("CUT_GRAPH_BUDGET", id, ir.nodes[id], `CUT graph recursive expansion exceeds maxExpansionVisits=${limits.maxExpansionVisits}`);
      }
    }
    if (depth > limits.maxDepth) throw new CutGraphError("CUT_GRAPH_BUDGET", id, ir.nodes[id], `CUT graph recursive expansion exceeds maxDepth=${limits.maxDepth}`);
    expansion.set(id, visits); depths.set(id, depth);
  }
  let expansionVisits = 0;
  for (const root of roots) {
    expansionVisits += expansion.get(root) ?? 0;
    if (!Number.isSafeInteger(expansionVisits) || expansionVisits > limits.maxExpansionVisits) {
      throw new CutGraphError("CUT_GRAPH_BUDGET", root, ir.nodes[root], `CUT graph recursive expansion exceeds maxExpansionVisits=${limits.maxExpansionVisits}`);
    }
  }
  return { reachableNodes: analysis.reachableNodes, referenceEdges: analysis.referenceEdges, expansionVisits };
}

function omitKeys(value: object, keys: ReadonlySet<string>) {
  // Match JSON's object-field semantics at the public IR boundary. In-memory
  // producers may represent an absent optional field as `undefined`, but that
  // field does not exist after serialization and therefore cannot affect the
  // canonical executable identity.
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !keys.has(key) && item !== undefined));
}

function withoutProvenance<T extends { provenance: unknown }>(value: T): Omit<T, "provenance"> {
  return omitKeys(value, new Set(["provenance"])) as Omit<T, "provenance">;
}

/**
 * A selected proxy executes only the proxy bytes.  The canonical locked IR
 * retains the complete pairwise master/proxy alignment witness for audit and
 * replay, but a newly proved master revision must not perturb the executable
 * identity of an unchanged proxy preview.  Project the already-validated
 * witness to its selected side at the same boundary used by node/cache
 * identity; canonical (non-profile) IR identity remains unchanged.
 */
function executionProfileResourceIdentity(resource: CutAVIR["resources"][string]) {
  const projected = structuredClone(withoutProvenance(resource)) as Omit<typeof resource, "provenance">;
  const sourceMetadata = resource.metadata as {
    activeMediaVariant?: unknown;
    audioProxyAlignment?: CutAudioProxyAlignment;
    videoProxyAlignment?: CutVideoProxyAlignment;
  } | undefined;
  const metadata = projected.metadata as Record<string, unknown> | undefined;
  if (metadata && sourceMetadata?.activeMediaVariant === "proxy" && sourceMetadata.audioProxyAlignment) {
    metadata.audioProxyAlignment = cutAudioProxyExecutionIdentity(sourceMetadata.audioProxyAlignment);
  }
  if (metadata && sourceMetadata?.activeMediaVariant === "proxy" && sourceMetadata.videoProxyAlignment) {
    metadata.videoProxyAlignment = cutVideoProxyExecutionIdentity(sourceMetadata.videoProxyAlignment);
  }
  return projected;
}

function consumedHandles(ir: CutAVIR, nodeId: string, kind: "picture-track" | "audio-track") {
  let head: IRValue | undefined, tail: IRValue | undefined;
  for (const track of Object.values(ir.nodes)) {
    if (track.editorial?.kind !== kind) continue;
    for (const transition of track.editorial.transitions ?? []) {
      if (transition.incomingNodeId === nodeId) head = { kind: "quantity", dimension: "time", magnitude: transition.incomingSource.duration, unit: "s" };
      if (transition.outgoingNodeId === nodeId) tail = { kind: "quantity", dimension: "time", magnitude: transition.outgoingSource.duration, unit: "s" };
    }
  }
  return { head, tail };
}

function selectedVideoColorInputs(ir: CutAVIR, node: IRNode, inputs: Record<string, IRValue>) {
  const source = inputs.source, interpretation = inputs.inputColorInterpretation;
  if (!isReferenceMediaProfileExecution(ir)
    || source?.kind !== "resource-ref"
    || interpretation?.kind !== "object") return inputs;
  const authority = referenceMediaProfileResourceState(ir, source.id);
  if (!authority) throw new CutGraphError("CUT_GRAPH_RESOURCE", node.id, node, `selected video resource ${source.id} has no invocation-local media-profile authority`);
  const variant = authority.selected;
  const selected = interpretation.entries[variant];
  if (!selected) throw new CutGraphError("CUT_GRAPH_RESOURCE", node.id, node, `selected ${variant} color interpretation is missing from resource ${source.id}`);
  return {
    ...inputs,
    inputColorInterpretation: {
      kind: "object" as const,
      entries: {
        ...(interpretation.entries.profile ? { profile: interpretation.entries.profile } : {}),
        [variant]: selected,
      },
    },
  };
}

function cutExecutableNodeInputsUnchecked(ir: CutAVIR, node: IRNode) {
  let inputs = { ...node.inputs };
  if (node.op === "cut.edit.nested_sequence") {
    const source = inputs.source, range = inputs.range;
    const composition = source?.kind === "timeline-ref"
      ? ir.compositions.find((candidate) => candidate.id === source.id)
      : undefined;
    if (composition
      && range?.kind === "range"
      && range.exclusive
      && range.start.kind === "quantity"
      && range.start.dimension === "time"
      && range.start.unit === "s"
      && range.end.kind === "quantity"
      && range.end.dimension === "time"
      && range.end.unit === "s"
      && compareRational(range.start.magnitude, zeroRational) === 0
      && compareRational(range.end.magnitude, composition.duration) === 0) {
      // Omission is the canonical spelling of the complete source interval.
      // Preserve the authored field in CutAVIR evidence, but do not let an
      // explicit neutral range perturb executable/build/cache identity.
      delete inputs.range;
    }
  }
  if (node.op === "cut.edit.picture_clip" || node.op === "cut.audio.clip" || node.op === "cut.edit.audio_region") {
    const consumed = consumedHandles(ir, node.id, node.op === "cut.edit.picture_clip" ? "picture-track" : "audio-track");
    delete inputs.headHandle;
    delete inputs.tailHandle;
    if (consumed.head) inputs.headHandle = consumed.head;
    if (consumed.tail) inputs.tailHandle = consumed.tail;
  }
  if (["cut.visual.video", "cut.edit.clip", "cut.edit.picture_clip"].includes(node.op)) inputs = selectedVideoColorInputs(ir, node, inputs);
  return inputs;
}

export function cutExecutableNodeInputs(ir: CutAVIR, node: IRNode) {
  assertReferenceMediaProfileExecutionState(ir);
  return cutExecutableNodeInputsUnchecked(ir, node);
}

function pictureTrackEditorialExecutableIdentity(ir: CutAVIR, node: IRNode) {
  if (node.editorial?.kind !== "picture-track") throw new CutGraphError("CUT_GRAPH_RESOURCE", node.id, node, "picture-track executable identity received a non-picture track");
  const editorial = node.editorial;
  const selected = isReferenceMediaProfileExecution(ir);
  const base = { ...editorial };
  if (selected) delete base.operationPlan;
  const itemIndex = new Map(editorial.items.map((item, index) => [item.nodeId, index]));
  const transitions = editorial.transitions?.map((transition) => {
    const projected = withoutProvenance(transition) as Record<string, unknown>;
    if (!selected) return projected;
    const outgoingIndex = itemIndex.get(transition.outgoingNodeId), incomingIndex = itemIndex.get(transition.incomingNodeId);
    if (outgoingIndex === undefined || incomingIndex === undefined) {
      throw new CutGraphError("CUT_GRAPH_RESOURCE", node.id, node, "selected picture transition endpoints do not resolve to ordered materialized items");
    }
    delete projected.outgoingNodeId;
    delete projected.incomingNodeId;
    return { ...projected, outgoingIndex, incomingIndex };
  });
  return {
    ...base,
    ...(selected ? { items: editorial.items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== "nodeId"))) } : {}),
    ...(!selected && editorial.operationPlan ? { operationPlan: pictureEditOperationExecutableIdentity(editorial.operationPlan) } : {}),
    ...(transitions ? { transitions } : {}),
  };
}

function audioTrackEditorialExecutableIdentity(editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }>) {
  // The operation plan is validated by the reference runtime and remains in
  // source/inspect evidence, but the compiler has already materialized its
  // complete executable result as ordered children plus editorial items. Two
  // histories that reconcile to the same result must share render/cache
  // identity; otherwise provenance-only edits would invalidate audio work.
  const materialized = { ...editorial };
  delete materialized.operationPlan;
  return {
    ...materialized,
    ...(materialized.transitions ? { transitions: materialized.transitions.map((transition) => withoutProvenance(transition)) } : {}),
  };
}

function nodeWithoutSourceEvidence(ir: CutAVIR, node: IRNode) {
  const executable = { ...withoutProvenance(node), inputs: cutExecutableNodeInputsUnchecked(ir, node) };
  if (node.editorial?.kind === "picture-track") return { ...executable, editorial: pictureTrackEditorialExecutableIdentity(ir, node) };
  if (node.editorial?.kind === "audio-track") return { ...executable, editorial: audioTrackEditorialExecutableIdentity(node.editorial) };
  return executable;
}

/** Hash one signal's executable meaning, excluding source-location evidence. */
export function cutSignalContentHash(signal: IRSignal) {
  return hash(omitKeys(signal, new Set(["contentHash", "provenance"])));
}

/**
 * Hash the canonical audiovisual graph, not the spelling of its source.
 * Exact source bytes remain independently pinned by sourceHash/cut.lock.
 */
export function cutIrIdentity(ir: CutAVIR) {
  assertReferenceMediaProfileExecutionState(ir);
  const {
    resources, compositions, scenes, nodes, signals, jobs, outputs, assertions,
    annotations, linkedEdits, semanticMatches, transcriptMediaAuthorities,
    transcriptBindings, timelineEdits,
  } = ir;
  const header = omitKeys(ir, new Set([
    "sourceHash", "sourceModules", "buildId", "resources", "compositions",
    "scenes", "nodes", "signals", "jobs", "outputs", "assertions",
    "annotations", "linkedEdits", "semanticMatches",
    "transcriptMediaAuthorities", "transcriptBindings", "timelineEdits",
  ]));
  const semanticMatchIdentity = semanticMatches ? {
    version: semanticMatches.version,
    subjects: semanticMatches.subjects.map(withoutProvenance),
    transitions: semanticMatches.transitions.map(withoutProvenance),
  } : undefined;
  if (isReferenceMediaProfileExecution(ir)) {
    const nodeDigest = (id: string) => nodes[id]?.contentHash ?? `missing:${id}`;
    return hash({
      ...header,
      resources: Object.fromEntries(Object.entries(resources).map(([id, resource]) => [id, executionProfileResourceIdentity(resource)])),
      compositions: compositions.map((composition) => ({
        ...withoutProvenance(composition),
        rootVisualIds: composition.rootVisualIds.map(nodeDigest),
        rootAudioIds: composition.rootAudioIds.map(nodeDigest),
        rootAVIds: composition.rootAVIds.map(nodeDigest),
        items: composition.items.map((item) => item.kind === "node" ? { ...item, id: nodeDigest(item.id) } : item),
      })),
      scenes: Object.fromEntries(Object.entries(scenes).map(([id, scene]) => [id, {
        ...withoutProvenance(scene),
        rootVisualIds: scene.rootVisualIds.map(nodeDigest),
        rootAudioIds: scene.rootAudioIds.map(nodeDigest),
        rootAVIds: scene.rootAVIds.map(nodeDigest),
        items: scene.items.map((item) => ({ ...item, id: nodeDigest(item.id) })),
      }])),
      nodes: Object.values(nodes).map((node) => node.contentHash).sort(),
      signals: Object.fromEntries(Object.entries(signals).map(([id, signal]) => [id, withoutProvenance(signal)])),
      jobs: jobs.map(withoutProvenance),
      outputs: outputs.map(withoutProvenance),
      assertions: assertions.map(withoutProvenance),
      ...(annotations ? { annotations: { markers: annotations.markers.map(withoutProvenance), regions: annotations.regions.map(withoutProvenance) } } : {}),
      ...(linkedEdits ? { linkedEdits: linkedEdits.map(withoutProvenance) } : {}),
      ...(semanticMatchIdentity ? { semanticMatches: semanticMatchIdentity } : {}),
      ...(transcriptMediaAuthorities
        ? {
          transcriptMediaAuthorities:
            transcriptMediaAuthorities.map(withoutProvenance),
        }
        : {}),
      ...(transcriptBindings ? { transcriptBindings: transcriptBindings.map(withoutProvenance) } : {}),
      ...(timelineEdits ? { timelineEdits: timelineEdits.map(timelineEditGraphIdentity) } : {}),
    });
  }
  return hash({
    ...header,
    resources: Object.fromEntries(Object.entries(resources).map(([id, resource]) => [id, withoutProvenance(resource)])),
    compositions: compositions.map(withoutProvenance),
    scenes: Object.fromEntries(Object.entries(scenes).map(([id, scene]) => [id, withoutProvenance(scene)])),
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, nodeWithoutSourceEvidence(ir, node)])),
    signals: Object.fromEntries(Object.entries(signals).map(([id, signal]) => [id, withoutProvenance(signal)])),
    jobs: jobs.map(withoutProvenance),
    outputs: outputs.map(withoutProvenance),
    assertions: assertions.map(withoutProvenance),
    ...(annotations ? {
      annotations: {
        markers: annotations.markers.map(withoutProvenance),
        regions: annotations.regions.map(withoutProvenance),
      },
    } : {}),
    ...(linkedEdits ? { linkedEdits: linkedEdits.map(withoutProvenance) } : {}),
    ...(semanticMatchIdentity ? { semanticMatches: semanticMatchIdentity } : {}),
    ...(transcriptMediaAuthorities
      ? {
        transcriptMediaAuthorities:
          transcriptMediaAuthorities.map(withoutProvenance),
      }
      : {}),
    ...(transcriptBindings ? { transcriptBindings: transcriptBindings.map(withoutProvenance) } : {}),
    ...(timelineEdits ? { timelineEdits: timelineEdits.map(timelineEditGraphIdentity) } : {}),
  });
}

/** Side-projected TimelineEdit meaning for localized scene cache identity.
 * Omission remains exact for every pre-feature graph. */
export function timelineEditSceneCacheIdentity(
  ir: CutAVIR,
  compositionId: string,
  sceneId: string,
) {
  const relevant = ir.timelineEdits?.filter((plan) =>
    plan.compositionId === compositionId && plan.sceneId === sceneId);
  return relevant?.length
    ? Object.freeze(relevant.map(timelineEditGraphIdentity))
    : undefined;
}

function semanticMatchPositionIdentity(ir: CutAVIR, cameraNodeId: string) {
  const camera = ir.nodes[cameraNodeId];
  if (!camera) return Object.freeze({ cameraNodeId, missing: true as const });
  const control = (name: "x" | "y") => {
    const property = camera.properties[name];
    return Object.freeze({
      input: camera.inputs[name],
      ...(property === undefined ? {} : "signal" in property
        ? { signal: property.signal, contentHash: ir.signals[property.signal]?.contentHash ?? `missing:${property.signal}` }
        : { property }),
    });
  };
  return Object.freeze({ cameraNodeId, x: control("x"), y: control("y") });
}

/** Side-projected semantic-match picture dependency. Absence is represented
 * by `undefined`, allowing historical scene cache keys to remain exact. */
export function semanticMatchSceneCacheIdentity(ir: CutAVIR, compositionId: string, sceneId: string) {
  const matches = ir.semanticMatches;
  if (!matches) return undefined;
  const subjects = new Map(matches.subjects.filter((subject) => subject.compositionId === compositionId).map((subject) => [subject.id, subject]));
  const relevant = matches.transitions.filter((transition) => transition.compositionId === compositionId
    && (transition.outgoing.sceneId === sceneId || transition.incoming.sceneId === sceneId));
  if (!relevant.length) return undefined;
  return Object.freeze(relevant.map((transition) => {
    const { provenance, ...semantic } = transition;
    void provenance;
    const outgoing = subjects.get(transition.outgoing.subjectId), incoming = subjects.get(transition.incoming.subjectId);
    const side = transition.outgoing.sceneId === sceneId ? "outgoing" as const : "incoming" as const;
    return Object.freeze({
      algorithm: "cut-reference-semantic-match-v1",
      side,
      transition: semantic,
      bases: Object.freeze({ outgoing: outgoing?.basis, incoming: incoming?.basis }),
      ...(transition.velocity === "carry" ? {
        carryPositionEndpoints: Object.freeze({
          outgoing: semanticMatchPositionIdentity(ir, transition.outgoing.cameraNodeId),
          incoming: semanticMatchPositionIdentity(ir, transition.incoming.cameraNodeId),
        }),
      } : {}),
    });
  }));
}

type SelectedMediaKind = CutConsumedMediaKind;

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalRationalIdentity(value: unknown) {
  const candidate = unknownRecord(value);
  if (!candidate
    || Object.keys(candidate).length !== 2
    || !Object.hasOwn(candidate, "numerator")
    || !Object.hasOwn(candidate, "denominator")
    || typeof candidate.numerator !== "string"
    || typeof candidate.denominator !== "string"
    || !/^(?:0|-?[1-9][0-9]*)$/u.test(candidate.numerator)
    || !/^[1-9][0-9]*$/u.test(candidate.denominator)
    || candidate.numerator.replace(/^-/, "").length > 256
    || candidate.denominator.length > 256) return undefined;
  const normalized = rational(candidate.numerator, candidate.denominator);
  if (normalized.numerator !== candidate.numerator || normalized.denominator !== candidate.denominator) return undefined;
  return normalized;
}

function selectedMediaStreamIdentity(value: unknown, kind: SelectedMediaKind, streamIndex: number) {
  const stream = unknownRecord(value);
  if (!stream
    || stream.index !== streamIndex
    || stream.type !== kind
    || typeof stream.codec !== "string"
    || !Array.isArray(stream.disposition)
    || !stream.disposition.every((item) => typeof item === "string")) return undefined;

  const result: Record<string, unknown> = {
    index: streamIndex,
    type: kind,
    codec: stream.codec,
    disposition: [...stream.disposition],
  };
  const stringFields = kind === "video"
    ? ["profile", "pixelFormat", "fieldOrder", "colorRange", "colorSpace", "colorTransfer", "colorPrimaries", "language"] as const
    : ["profile", "channelLayout", "language"] as const;
  for (const field of stringFields) {
    if (stream[field] === undefined) continue;
    if (typeof stream[field] !== "string") return undefined;
    result[field] = stream[field];
  }
  const rationalFields = kind === "video"
    ? ["timeBase", "start", "duration", "frameRate", "averageFrameRate"] as const
    : ["timeBase", "start", "duration"] as const;
  for (const field of rationalFields) {
    if (stream[field] === undefined) continue;
    const rational = canonicalRationalIdentity(stream[field]);
    if (!rational) return undefined;
    result[field] = rational;
  }
  const integerFields = kind === "video" ? ["width", "height"] as const : ["sampleRate", "channels"] as const;
  for (const field of integerFields) {
    if (stream[field] === undefined) continue;
    if (!Number.isSafeInteger(stream[field]) || Number(stream[field]) <= 0) return undefined;
    result[field] = stream[field];
  }
  if (!result.timeBase || integerFields.some((field) => result[field] === undefined)) return undefined;
  return result;
}

function decodedVideoCadenceIdentity(value: unknown): CutDecodedVideoCadence | undefined {
  const object = unknownRecord(value);
  const fields = ["durationCoverage", "durationPresentCount", "firstPts", "format", "frameCount", "frameRate", "lastPts", "method", "phaseNumerator", "quantization", "quantizedEndPts", "recordsSha256", "streamIndex", "timeBase", "version"];
  if (!object || Object.keys(object).length !== fields.length || fields.some((field) => !Object.hasOwn(object, field))) return undefined;
  if (object.format !== "cut-decoded-video-cadence" || object.version !== 2 || object.method !== "ffprobe-show-frames-cfr-v2" || !decodedVideoCadenceQuantizations.includes(object.quantization as CutDecodedVideoCadence["quantization"])) return undefined;
  if (!Number.isSafeInteger(object.streamIndex) || Number(object.streamIndex) < 0) return undefined;
  const integer = (entry: unknown, positive: boolean) => typeof entry === "string"
    && entry.length <= 256
    && (positive ? /^[1-9][0-9]*$/u : /^(?:0|-?[1-9][0-9]*)$/u).test(entry)
    ? entry : undefined;
  const firstPts = integer(object.firstPts, false), lastPts = integer(object.lastPts, false), quantizedEndPts = integer(object.quantizedEndPts, false), phaseNumerator = integer(object.phaseNumerator, false), frameCount = integer(object.frameCount, true), durationPresentCount = integer(object.durationPresentCount, false);
  const timeBase = canonicalRationalIdentity(object.timeBase), frameRate = canonicalRationalIdentity(object.frameRate);
  if (!firstPts || !lastPts || !quantizedEndPts || phaseNumerator === undefined || !frameCount || durationPresentCount === undefined || !timeBase || !frameRate || typeof object.recordsSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(object.recordsSha256) || !["complete", "partial", "none"].includes(String(object.durationCoverage))) return undefined;
  return { format: "cut-decoded-video-cadence", version: 2, method: "ffprobe-show-frames-cfr-v2", quantization: object.quantization as CutDecodedVideoCadence["quantization"], phaseNumerator, streamIndex: Number(object.streamIndex), firstPts, lastPts, quantizedEndPts, frameCount, durationPresentCount, durationCoverage: object.durationCoverage as CutDecodedVideoCadence["durationCoverage"], recordsSha256: object.recordsSha256, timeBase, frameRate };
}

function decodedAudioSamplesIdentity(value: unknown): CutDecodedAudioSamples | undefined {
  const object = unknownRecord(value);
  const commonFields = [
    "decodedSampleCount", "decoderOutputSampleCount", "decoderPcmSha256", "durationCoverage", "durationPresentCount", "firstPts", "format", "frameCount", "lastPts",
    "method", "phaseNumerator", "quantization", "recordsSha256", "sampleRate", "streamIndex", "terminalTrimSamples",
    "timeBase", "trimSemantics", "version",
  ];
  const current = object?.version === 2;
  const fields = current ? [...commonFields, "leadingDiscontinuityFrameCount", "leadingDiscontinuitySampleCount"] : commonFields;
  if (!object || Object.keys(object).length !== fields.length || fields.some((field) => !Object.hasOwn(object, field))) return undefined;
  const historical = object.format === "cut-decoded-audio-samples" && object.version === 1 && object.method === "ffprobe-show-frames-audio-v1"
    && object.quantization === "phase-floor" && object.trimSemantics === "decoder-output-plus-terminal-duration";
  const supportedCurrent = object.format === "cut-decoded-audio-samples" && object.version === 2 && object.method === "ffprobe-show-frames-audio-v2"
    && object.quantization === "phase-floor-start-or-exact-end" && object.trimSemantics === "decoder-output-sequence-plus-terminal-duration";
  if (!historical && !supportedCurrent) return undefined;
  if (!Number.isSafeInteger(object.streamIndex) || Number(object.streamIndex) < 0
    || !Number.isSafeInteger(object.sampleRate) || Number(object.sampleRate) < 1) return undefined;
  const integer = (entry: unknown, positive: boolean) => typeof entry === "string"
    && entry.length <= 256
    && (positive ? /^[1-9][0-9]*$/u : /^(?:0|-?[1-9][0-9]*)$/u).test(entry)
    ? entry : undefined;
  const nonNegative = (entry: unknown) => typeof entry === "string" && entry.length <= 256 && /^(?:0|[1-9][0-9]*)$/u.test(entry) ? entry : undefined;
  const firstPts = integer(object.firstPts, false), lastPts = integer(object.lastPts, false);
  const frameCount = integer(object.frameCount, true), decodedSampleCount = integer(object.decodedSampleCount, true), decoderOutputSampleCount = integer(object.decoderOutputSampleCount, true);
  const phaseNumerator = nonNegative(object.phaseNumerator), terminalTrimSamples = nonNegative(object.terminalTrimSamples), durationPresentCount = nonNegative(object.durationPresentCount);
  const timeBase = canonicalRationalIdentity(object.timeBase);
  if (!firstPts || !lastPts || !frameCount || !decodedSampleCount || !decoderOutputSampleCount || phaseNumerator === undefined || terminalTrimSamples === undefined
    || durationPresentCount === undefined || !timeBase || typeof object.recordsSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(object.recordsSha256)
    || typeof object.decoderPcmSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(object.decoderPcmSha256)
    || !["complete", "partial", "none"].includes(String(object.durationCoverage))) return undefined;
  const common = {
    phaseNumerator, streamIndex: Number(object.streamIndex), firstPts,
    lastPts, frameCount, decoderOutputSampleCount, decoderPcmSha256: object.decoderPcmSha256, decodedSampleCount, terminalTrimSamples, durationPresentCount,
    durationCoverage: object.durationCoverage as CutDecodedAudioSamples["durationCoverage"], recordsSha256: object.recordsSha256,
    timeBase, sampleRate: Number(object.sampleRate),
  };
  if (current) {
    const leadingDiscontinuityFrameCount = nonNegative(object.leadingDiscontinuityFrameCount);
    const leadingDiscontinuitySampleCount = nonNegative(object.leadingDiscontinuitySampleCount);
    if (leadingDiscontinuityFrameCount === undefined || leadingDiscontinuitySampleCount === undefined) return undefined;
    return {
      format: "cut-decoded-audio-samples", version: 2, method: "ffprobe-show-frames-audio-v2", quantization: "phase-floor-start-or-exact-end",
      trimSemantics: "decoder-output-sequence-plus-terminal-duration", ...common, leadingDiscontinuityFrameCount, leadingDiscontinuitySampleCount,
    };
  }
  return {
    format: "cut-decoded-audio-samples", version: 1, method: "ffprobe-show-frames-audio-v1", quantization: "phase-floor",
    trimSemantics: "decoder-output-plus-terminal-duration", ...common,
  };
}

function selectedMediaExecutionIdentity(ir: CutAVIR, node: IRNode, resourceId: string, consumedKinds?: readonly SelectedMediaKind[]) {
  const resource = ir.resources[resourceId];
  if (!resource || resource.state !== "locked" || (resource.kind !== "video" && resource.kind !== "audio")) return undefined;
  // Frozen CUT 0.4 artifacts predate lock v2 media probes. Their verified node
  // identity therefore binds the locked locator/bytes hash only, exactly as
  // the 0.3 writer did. Current compiler identities must take the closed v2
  // path below; this exception preserves archival verification rather than
  // making incomplete current media locks executable.
  if (ir.compiler === "cut-ts/0.3.0") return undefined;
  const kinds = consumedKinds ?? directNodeConsumedMediaKinds(node, resource.kind);
  if (kinds.length === 0) return undefined;
  const fail = (message: string): never => {
    throw new CutGraphError("CUT_GRAPH_RESOURCE", node.id, node, `${node.op} resource ${resourceId} ${message}`);
  };
  const metadata = unknownRecord(resource.metadata), probe = unknownRecord(metadata?.probe), identity = unknownRecord(probe?.identity), selected = unknownRecord(probe?.selected);
  if (!metadata || metadata.lockVersion !== 2) fail("has incomplete canonical locked media metadata");
  if (!probe || probe.kind !== "media") fail("has incomplete canonical locked media metadata");
  if (!identity || identity.format !== "cut-media-probe" || identity.version !== 1 || !Array.isArray(identity.streams)) {
    fail("has incomplete canonical locked media metadata");
  }
  if (!selected) fail("has incomplete canonical locked media metadata");
  const canonicalMetadata = metadata!, canonicalIdentity = identity!, canonicalSelected = selected!;
  const streams = canonicalIdentity.streams as unknown[];
  if (!Number.isSafeInteger(canonicalMetadata.bytes) || Number(canonicalMetadata.bytes) < 0) fail("has an invalid locked byte count");
  if (canonicalMetadata.activeMediaVariant !== undefined && canonicalMetadata.activeMediaVariant !== "master" && canonicalMetadata.activeMediaVariant !== "proxy") {
    fail("has an unrecognized active media variant");
  }

  const selectedIdentity: Record<string, unknown> = {};
  for (const kind of kinds) {
    const selection = unknownRecord(canonicalSelected[kind]);
    if (!selection) fail(`has no canonical selected ${kind} tuple`);
    const canonicalSelection = selection!;
    if (!Number.isSafeInteger(canonicalSelection.streamIndex)
      || Number(canonicalSelection.streamIndex) < 0
      || (canonicalSelection.durationSource !== "stream" && canonicalSelection.durationSource !== "decoded-video-cadence" && canonicalSelection.durationSource !== "decoded-audio-samples")) {
      fail(`has no canonical selected ${kind} tuple`);
    }
    const duration = canonicalRationalIdentity(canonicalSelection.duration), timeBase = canonicalRationalIdentity(canonicalSelection.timeBase);
    if (!duration || !timeBase || compareRational(duration, zeroRational) <= 0 || compareRational(timeBase, zeroRational) <= 0) {
      fail(`has an invalid selected ${kind} duration or time base`);
    }
    const canonicalDuration = duration!, canonicalTimeBase = timeBase!;
    const streamIndex = Number(canonicalSelection.streamIndex);
    const matching = streams.find((stream) => unknownRecord(stream)?.index === streamIndex && unknownRecord(stream)?.type === kind);
    const stream = selectedMediaStreamIdentity(matching, kind, streamIndex);
    if (!stream) fail(`selected ${kind} stream ${streamIndex} has no canonical matching stream metadata`);
    const canonicalStream = stream!;
    if (kind === "video") {
      const streamStart = canonicalRationalIdentity(canonicalStream.start), streamFrameRate = canonicalRationalIdentity(canonicalStream.frameRate), streamAverageFrameRate = canonicalRationalIdentity(canonicalStream.averageFrameRate);
      if (!streamStart || compareRational(streamStart, zeroRational) < 0) fail(`selected video stream ${streamIndex} has no exact non-negative start`);
      if ((!streamFrameRate || compareRational(streamFrameRate, zeroRational) <= 0) && (!streamAverageFrameRate || compareRational(streamAverageFrameRate, zeroRational) <= 0)) fail(`selected video stream ${streamIndex} has no positive exact frame-rate candidate`);
      if (divideRational(streamStart!, canonicalTimeBase).denominator !== "1") fail(`selected video stream ${streamIndex} start does not land on its exact codec time base`);
    }
    const streamTimeBase = canonicalRationalIdentity(canonicalStream.timeBase);
    if (!streamTimeBase || compareRational(canonicalTimeBase, streamTimeBase) !== 0) {
      fail(`selected ${kind} tuple does not match stream ${streamIndex} time-base metadata`);
    }
    const selectedFrameRate = kind === "video"
      ? canonicalRationalIdentity(canonicalSelection.frameRate) ?? canonicalRationalIdentity(canonicalStream.frameRate)
      : undefined;
    if (kind === "video" && (!selectedFrameRate || ![canonicalStream.frameRate, canonicalStream.averageFrameRate].some((candidate) => {
      const rate = canonicalRationalIdentity(candidate); return rate && compareRational(rate, selectedFrameRate) === 0;
    }))) fail(`selected video frame rate does not match a retained stream candidate`);
    if (canonicalSelection.durationSource === "stream") {
      const streamDuration = canonicalRationalIdentity(canonicalStream.duration);
      if (!streamDuration || compareRational(canonicalDuration, streamDuration) !== 0) {
        fail(`selected ${kind} duration does not match stream ${streamIndex} duration metadata`);
      }
      if (canonicalSelection.decodedVideoCadence !== undefined || canonicalSelection.decodedAudioSamples !== undefined) fail(`selected ${kind} stream authority cannot carry a decoded witness`);
    } else if (canonicalSelection.durationSource === "decoded-video-cadence") {
      if (kind !== "video") fail("decoded-video-cadence authority is valid only for video");
      if (canonicalSelection.decodedAudioSamples !== undefined) fail("decoded-video-cadence authority cannot carry a decoded-audio-samples witness");
      const cadence = decodedVideoCadenceIdentity(canonicalSelection.decodedVideoCadence);
      if (!cadence) fail(`has no canonical decoded-video-cadence witness`);
      let derived;
      try { derived = decodedVideoCadenceDuration(cadence!, { index: streamIndex, start: canonicalStream.start as ReturnType<typeof canonicalRationalIdentity>, timeBase: streamTimeBase, frameRate: canonicalStream.frameRate as ReturnType<typeof canonicalRationalIdentity>, averageFrameRate: canonicalStream.averageFrameRate as ReturnType<typeof canonicalRationalIdentity> }); }
      catch (error) { fail(`decoded-video-cadence witness is invalid (${error instanceof Error ? error.message : String(error)})`); }
      if (compareRational(canonicalDuration, derived!) !== 0) fail(`selected video duration does not match its decoded-video-cadence witness`);
      if (!selectedFrameRate || compareRational(selectedFrameRate, cadence!.frameRate) !== 0) fail(`selected video frame rate does not match its decoded-video-cadence witness`);
    } else {
      if (kind !== "audio") fail("decoded-audio-samples authority is valid only for audio");
      if (canonicalSelection.decodedVideoCadence !== undefined) fail("decoded-audio-samples authority cannot carry a decoded-video-cadence witness");
      const samples = decodedAudioSamplesIdentity(canonicalSelection.decodedAudioSamples);
      if (!samples) fail("has no canonical decoded-audio-samples witness");
      let derived;
      try { derived = decodedAudioSamplesDuration(samples!, { index: streamIndex, timeBase: streamTimeBase, sampleRate: canonicalStream.sampleRate as number, duration: canonicalStream.duration as ReturnType<typeof canonicalRationalIdentity> }); }
      catch (error) { fail(`decoded-audio-samples witness is invalid (${error instanceof Error ? error.message : String(error)})`); }
      if (compareRational(canonicalDuration, derived!) !== 0) fail("selected audio duration does not match its decoded-audio-samples witness");
    }
    const cadence = canonicalSelection.decodedVideoCadence === undefined ? undefined : decodedVideoCadenceIdentity(canonicalSelection.decodedVideoCadence);
    const samples = canonicalSelection.decodedAudioSamples === undefined ? undefined : decodedAudioSamplesIdentity(canonicalSelection.decodedAudioSamples);
    selectedIdentity[kind] = {
      selection: { streamIndex, duration: canonicalDuration, durationSource: canonicalSelection.durationSource, timeBase: canonicalTimeBase, ...(selectedFrameRate ? { frameRate: selectedFrameRate } : {}), ...(cadence ? { decodedVideoCadence: cadence } : {}), ...(samples ? { decodedAudioSamples: samples } : {}) },
      stream: canonicalStream,
    };
  }
  const activeMediaVariant = canonicalMetadata.activeMediaVariant === "master" || canonicalMetadata.activeMediaVariant === "proxy"
    ? canonicalMetadata.activeMediaVariant
    : undefined;
  const audioProxyAlignment = canonicalMetadata.audioProxyAlignment;
  const selectedAudioTuple = unknownRecord(canonicalSelected.audio);
  const proxyCarriesAudio = activeMediaVariant === "proxy" && selectedAudioTuple !== undefined;
  let canonicalAudioProxyAlignment: CutAudioProxyAlignment | undefined;
  if (proxyCarriesAudio) {
    const alignment = unknownRecord(audioProxyAlignment);
    const analysis = unknownRecord(alignment?.analysis), proxy = unknownRecord(alignment?.proxy), policy = unknownRecord(alignment?.policy);
    const supportedAlignment = alignment?.format === "cut-audio-proxy-alignment"
      && ((alignment.version === cutAudioProxyAlignmentContractV1.version && alignment.method === cutAudioProxyAlignmentContractV1.method)
        || (alignment.version === cutAudioProxyAlignmentContractV2.version && alignment.method === cutAudioProxyAlignmentContractV2.method));
    if (!alignment || !supportedAlignment || alignment.decision !== "equivalent"
      || typeof alignment.integrity !== "string" || !/^[a-f0-9]{64}$/u.test(alignment.integrity)
      || !analysis || !proxy || !policy) {
      fail("selected proxy audio has no canonical audio-alignment evidence");
    }
    canonicalAudioProxyAlignment = alignment as unknown as CutAudioProxyAlignment;
  } else if (audioProxyAlignment !== undefined) {
    fail("audio-proxy alignment evidence is valid only on a selected proxy that carries audio");
  }
  let selectedAudioProxyExecutionEvidence: unknown;
  if (activeMediaVariant === "proxy" && selectedIdentity.audio !== undefined) {
    const selectedAlignment = canonicalAudioProxyAlignment;
    if (!selectedAlignment) fail("selected proxy audio has no canonical audio-alignment evidence");
    // Full pairwise evidence remains authoritative in cut.lock, canonical IR,
    // inspect, and every native/private rescan. Cache identity projects only
    // the selected proxy side plus the fixed algorithm/policy: a master-only
    // revision that freshly proves the same proxy equivalent cannot alter the
    // bytes this preview decodes, while any proxy/decoder/policy change still
    // invalidates it.
    selectedAudioProxyExecutionEvidence = cutAudioProxyExecutionIdentity(selectedAlignment as CutAudioProxyAlignment);
  }
  const videoProxyAlignment = canonicalMetadata.videoProxyAlignment;
  const selectedVideoTuple = unknownRecord(canonicalSelected.video);
  const proxyCarriesVideo = activeMediaVariant === "proxy" && selectedVideoTuple !== undefined;
  let canonicalVideoProxyAlignment: CutVideoProxyAlignment | undefined;
  if (proxyCarriesVideo) {
    const alignment = unknownRecord(videoProxyAlignment);
    const analysis = unknownRecord(alignment?.analysis), master = unknownRecord(alignment?.master);
    const proxy = unknownRecord(alignment?.proxy), policy = unknownRecord(alignment?.policy), metrics = unknownRecord(alignment?.metrics);
    if (!alignment || alignment.format !== cutVideoProxyAlignmentContract.format
      || alignment.version !== cutVideoProxyAlignmentContract.version
      || alignment.method !== cutVideoProxyAlignmentContract.method
      || alignment.decision !== "equivalent"
      || typeof alignment.integrity !== "string" || !/^[a-f0-9]{64}$/u.test(alignment.integrity)
      || !analysis || !master || !proxy || !policy || !metrics) {
      fail("selected proxy video has no canonical video-alignment evidence");
    }
    const canonicalAlignment = alignment as Record<string, unknown>;
    const { integrity, ...base } = canonicalAlignment;
    if (integrity !== cutVideoProxyAlignmentIntegrity(base as unknown as Omit<CutVideoProxyAlignment, "integrity">)) {
      fail("selected proxy video alignment evidence has invalid integrity");
    }
    canonicalVideoProxyAlignment = canonicalAlignment as unknown as CutVideoProxyAlignment;
  } else if (videoProxyAlignment !== undefined) {
    fail("video-proxy alignment evidence is valid only on a selected proxy that carries video");
  }
  let selectedVideoProxyExecutionEvidence: unknown;
  if (activeMediaVariant === "proxy" && selectedIdentity.video !== undefined) {
    if (!canonicalVideoProxyAlignment) fail("selected proxy video has no canonical video-alignment evidence");
    selectedVideoProxyExecutionEvidence = cutVideoProxyExecutionIdentity(canonicalVideoProxyAlignment!);
  }
  return {
    format: "cut-execution-selected-media",
    version: 1,
    resourceKind: resource.kind,
    ...(activeMediaVariant === undefined ? {} : { activeMediaVariant }),
    bytes: Number(canonicalMetadata.bytes),
    selected: selectedIdentity,
    ...(selectedAudioProxyExecutionEvidence === undefined ? {} : { audioProxyAlignment: selectedAudioProxyExecutionEvidence }),
    ...(selectedVideoProxyExecutionEvidence === undefined ? {} : { videoProxyAlignment: selectedVideoProxyExecutionEvidence }),
  };
}

const anchoredOwnerTransformFields = new Set([
  "x", "y", "anchorX", "anchorY", "scale", "skewX", "skewY", "rotation",
]);

const anchoredTrack2DSpatialInputs = new Set([
  ...anchoredOwnerTransformFields,
  "source", "minConfidence", "lowConfidence", "occluded", "outOfFrame",
  "interpolation", "bindScale", "bindRotation",
]);

const anchoredMediaCamera2DSpatialInputs = new Set([
  "focusX", "focusY", "zoom", "rotation", "responsiveSlotContext",
]);

const anchoredMediaCamera2DSpatialProperties = new Set([
  "focusX", "focusY", "zoom", "rotation",
]);

/**
 * Project a visualAnchor owner onto only the public facts that can move an
 * authored LocalSpace point. The owner's ordinary node hash still owns its
 * pixels and therefore the enclosing scene cache. Keeping this projection
 * separate prevents an inner grade/media/opacity edit from invalidating an
 * otherwise identical anchored Path or MotionPath geometry cache entry.
 */
function anchoredOwnerSpatialIdentity(
  ir: CutAVIR,
  ownerId: string,
  consumer: IRNode,
  nodeHash: (id: string) => string,
  compositionHash: (id: string) => string,
) {
  const owner = ir.nodes[ownerId];
  if (!owner) return { schema: "cut.visual.anchor-owner-spatial.v1", ownerId, missing: true };
  const acceptedInputs = owner.op === "cut.visual.track_2d"
    ? anchoredTrack2DSpatialInputs
    : owner.op === "cut.visual.media_camera2d"
      ? anchoredMediaCamera2DSpatialInputs
      : anchoredOwnerTransformFields;
  const acceptedProperties = owner.op === "cut.visual.media_camera2d"
    ? anchoredMediaCamera2DSpatialProperties
    : anchoredOwnerTransformFields;
  const inputs = Object.fromEntries(Object.entries(owner.inputs)
    .filter(([name]) => acceptedInputs.has(name))
    .map(([name, value]) => [name, valueIdentity(value, ir, consumer, nodeHash, compositionHash)]));
  const properties = Object.fromEntries(Object.entries(owner.properties)
    .filter(([name]) => acceptedProperties.has(name))
    .map(([name, value]) => [name, "signal" in value
      ? { signal: value.signal, contentHash: ir.signals[value.signal]?.contentHash }
      : valueIdentity(value, ir, consumer, nodeHash, compositionHash)]));
  const localSpace = owner.op === "cut.visual.local_space"
    ? owner
    : owner.children.length === 1 && ir.nodes[owner.children[0]!]?.op === "cut.visual.local_space"
      ? ir.nodes[owner.children[0]!]
      : undefined;
  const localSpaceBasis = localSpace ? {
    id: localSpace.id,
    op: localSpace.op,
    sceneId: localSpace.sceneId,
    interval: localSpace.interval,
    inputs: Object.fromEntries(["width", "height", "origin"].flatMap((name) => {
      const value = localSpace.inputs[name];
      return value === undefined ? [] : [[name, valueIdentity(value, ir, consumer, nodeHash, compositionHash)] as const];
    })),
  } : undefined;
  const semanticMatches = owner.op === "cut.visual.camera2d" && ir.semanticMatches
    ? (() => {
        const subjects = ir.semanticMatches.subjects.filter((subject) => subject.cameraNodeId === owner.id);
        const subjectIds = new Set(subjects.map((subject) => subject.id));
        const transitions = ir.semanticMatches!.transitions.filter((transition) =>
          subjectIds.has(transition.outgoing.subjectId) || subjectIds.has(transition.incoming.subjectId));
        return subjects.length || transitions.length ? {
          subjects: subjects.map(withoutProvenance),
          transitions: transitions.map(withoutProvenance),
        } : undefined;
      })()
    : undefined;
  return {
    schema: "cut.visual.anchor-owner-spatial.v1",
    ownerId: owner.id,
    op: owner.op,
    domain: owner.domain,
    sceneId: owner.sceneId,
    interval: owner.interval,
    inputs,
    properties,
    ...(localSpaceBasis ? { localSpace: localSpaceBasis } : {}),
    ...(semanticMatches ? { semanticMatches } : {}),
  };
}

function exactVisualAnchorCall(value: Extract<IRValue, { kind: "call" }>) {
  return value.op === cutAnchoredSpatialOps.visualAnchor
    && value.effect === "pure"
    && value.positional.length === 0
    && Object.keys(value.named).length === 2
    && Object.hasOwn(value.named, "owner")
    && Object.hasOwn(value.named, "local")
    && value.named.owner?.kind === "node-ref";
}

function valueIdentity(value: IRValue, ir: CutAVIR, node: IRNode, nodeHash: (id: string) => string, compositionHash: (id: string) => string, consumedKinds?: readonly SelectedMediaKind[]): unknown {
  if (value.kind === "resource-ref") {
    const resource = ir.resources[value.id], selectedMedia = selectedMediaExecutionIdentity(ir, node, value.id, consumedKinds);
    return {
      ...value,
      sha256: resource?.sha256,
      locator: resource?.locator,
      state: resource?.state,
      ...(selectedMedia === undefined ? {} : { selectedMedia }),
    };
  }
  if (value.kind === "node-ref") return { ...value, contentHash: nodeHash(value.id) };
  if (value.kind === "timeline-ref") return { ...value, contentHash: compositionHash(value.id) };
  if (value.kind === "array") return { ...value, items: value.items.map((item) => valueIdentity(item, ir, node, nodeHash, compositionHash)) };
  if (value.kind === "object") return { ...value, entries: Object.fromEntries(Object.entries(value.entries).map(([key, item]) => [key, valueIdentity(item, ir, node, nodeHash, compositionHash)])) };
  if (value.kind === "range") return { ...value, start: valueIdentity(value.start, ir, node, nodeHash, compositionHash), end: valueIdentity(value.end, ir, node, nodeHash, compositionHash) };
  if (value.kind === "unary") return { ...value, value: valueIdentity(value.value, ir, node, nodeHash, compositionHash) };
  if (value.kind === "binary") return { ...value, left: valueIdentity(value.left, ir, node, nodeHash, compositionHash), right: valueIdentity(value.right, ir, node, nodeHash, compositionHash) };
  if (value.kind === "member") return { ...value, object: valueIdentity(value.object, ir, node, nodeHash, compositionHash) };
  if (value.kind === "index") return { ...value, object: valueIdentity(value.object, ir, node, nodeHash, compositionHash), index: valueIdentity(value.index, ir, node, nodeHash, compositionHash) };
  if (value.kind === "call") {
    if (exactVisualAnchorCall(value)) {
      const owner = value.named.owner as Extract<IRValue, { kind: "node-ref" }>;
      return {
        ...value,
        positional: [],
        named: {
          owner: {
            ...owner,
            spatialContentHash: hash(anchoredOwnerSpatialIdentity(ir, owner.id, node, nodeHash, compositionHash)),
          },
          local: valueIdentity(value.named.local!, ir, node, nodeHash, compositionHash),
        },
      };
    }
    return { ...value, positional: value.positional.map((item) => valueIdentity(item, ir, node, nodeHash, compositionHash)), named: Object.fromEntries(Object.entries(value.named).map(([key, item]) => [key, valueIdentity(item, ir, node, nodeHash, compositionHash)])) };
  }
  return value;
}

/**
 * Hash one composition's executable picture/audio meaning. A Timeline value
 * is not merely a symbolic ID: Precomp instances must invalidate when any
 * reachable source scene, root, ordering decision, or format setting changes.
 */
export function cutCompositionContentHash(ir: CutAVIR, composition: IRComposition, nodeHash: (id: string) => string) {
  const roots = (ids: readonly string[]) => ids.map((id) => ({ id, contentHash: nodeHash(id) }));
  const items = (values: readonly ({ kind: "scene"; id: string } | { kind: "node"; id: string; domain: string })[]) => values.map((item) => item.kind === "scene"
    ? { kind: item.kind, id: item.id }
    : { ...item, contentHash: nodeHash(item.id) });
  return hash({
    id: composition.id,
    name: composition.name,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    sampleRate: composition.sampleRate,
    duration: composition.duration,
    roots: {
      visual: roots(composition.rootVisualIds),
      audio: roots(composition.rootAudioIds),
      av: roots(composition.rootAVIds),
    },
    items: items(composition.items),
    scenes: composition.sceneIds.map((sceneId) => {
      const scene = ir.scenes[sceneId];
      if (!scene) throw new CutGraphError("CUT_GRAPH_REFERENCE", sceneId, undefined, `CUT composition ${composition.id} references missing scene ${sceneId}`);
      return {
        id: scene.id,
        name: scene.name,
        start: scene.start,
        duration: scene.duration,
        roots: {
          visual: roots(scene.rootVisualIds),
          audio: roots(scene.rootAudioIds),
          av: roots(scene.rootAVIds),
        },
        items: scene.items.map((item) => ({ ...item, contentHash: nodeHash(item.id) })),
      };
    }),
  });
}

/**
 * Hash one node's executable meaning. Optional IR fields are present in the
 * identity only when they are present in the serialized node. This matters for
 * backwards-compatible schema extensions: adding an absent optional field must
 * not rewrite every pre-extension node hash, while authoring that field must
 * still change the executable identity.
 */
function cutNodeContentHashUnchecked(ir: CutAVIR, node: IRNode, nodeHash: (id: string) => string, compositionHash: (id: string) => string) {
  const properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [
    key,
    "signal" in value
      ? (() => {
          const signal = ir.signals[value.signal];
          return {
            signal: value.signal,
            contentHash: signal?.contentHash,
            // Producer-backed signals derive picture pixels from locked media
            // that is not a node input. Bind the same selected byte/stream
            // identity used by ordinary media consumers so a relock cannot
            // reuse stale scene frames. Authored signal identity remains
            // lock-independent; this expansion belongs only to executable
            // graph/cache identity.
            ...(signal?.kind === "track" && signal.producer
              ? (() => {
                  const producerPackageSpecifier = packageSpecifierForNative("cut.data.amplitude_envelope");
                  return {
                    producerSource: valueIdentity(signal.producer.source, ir, node, nodeHash, compositionHash, ["audio"]),
                    ...(producerPackageSpecifier === undefined ? {} : {
                      producerPackage: {
                        specifier: producerPackageSpecifier,
                        integrity: ir.modules.find((module) => module.specifier === producerPackageSpecifier)?.integrity,
                      },
                    }),
                  };
                })()
              : {}),
          };
        })()
      : valueIdentity(value, ir, node, nodeHash, compositionHash),
  ]));
  const pinnedBySpecificity = [...ir.modules].sort((left, right) => right.specifier.length - left.specifier.length || left.specifier.localeCompare(right.specifier));
  const provenanceModules = [node.provenance.module, ...(node.provenance.expandedFrom ?? []).map((item) => item.module)];
  const sourcePackages = provenanceModules.map((source) => pinnedBySpecificity.find((module) => source === module.specifier || source.startsWith(`${module.specifier}/`))?.specifier).filter((specifier): specifier is string => Boolean(specifier));
  const legacyPackageIntegrity = ir.modules.find((module) => node.provenance.module === module.specifier)?.integrity;
  const packageSpecifier = packageSpecifierForNative(node.op) ?? sourcePackages[0];
  const packageIntegrity = packageSpecifier ? ir.modules.find((module) => module.specifier === packageSpecifier)?.integrity : undefined;
  const additionalPackageDependencies = [...new Set(sourcePackages.filter((specifier) => specifier !== packageSpecifier))].sort().map((specifier) => ({ specifier, integrity: ir.modules.find((module) => module.specifier === specifier)?.integrity }));
  // Frozen CUT 0.4 artifacts bound only the implementation digest matched by
  // the node's direct provenance module. Current compilers additionally bind
  // the owning package specifier and every expanded source-package dependency.
  const packageIdentity = ir.compiler === "cut-ts/0.3.0"
    ? { packageIntegrity: legacyPackageIntegrity }
    : {
        ...(packageSpecifier === undefined ? {} : { packageSpecifier, packageIntegrity }),
        ...(additionalPackageDependencies.length ? { additionalPackageDependencies } : {}),
      };
  return hash({
    op: node.op,
    domain: node.domain,
    sceneId: node.sceneId,
    interval: node.interval,
    ...(node.op === "cut.visual.flow_text" && node.inputs.shaping?.kind === "object"
      ? { complexTextShaping: ir.features?.complexTextShaping }
      : {}),
    inputs: Object.fromEntries(Object.entries(cutExecutableNodeInputsUnchecked(ir, node)).map(([key, value]) => [key, valueIdentity(value, ir, node, nodeHash, compositionHash)])),
    children: node.children.map((child) => isReferenceMediaProfileExecution(ir)
      ? { contentHash: nodeHash(child) }
      : { id: child, contentHash: nodeHash(child) }),
    ...(node.editorial === undefined ? {} : {
      editorial: node.editorial.kind === "picture-track"
        ? pictureTrackEditorialExecutableIdentity(ir, node)
        : node.editorial.kind === "audio-track"
          ? audioTrackEditorialExecutableIdentity(node.editorial)
          : node.editorial,
    }),
    properties,
    effects: node.effects,
    ...packageIdentity,
  });
}

export function cutNodeContentHash(ir: CutAVIR, node: IRNode, nodeHash: (id: string) => string, compositionHash: (id: string) => string) {
  assertReferenceMediaProfileExecutionState(ir);
  return cutNodeContentHashUnchecked(ir, node, nodeHash, compositionHash);
}

export function finalizeGraphHashes(ir: CutAVIR) {
  assertReferenceMediaProfileExecutionState(ir);
  analyzeCutNodeGraph(ir, Object.keys(ir.nodes).sort());
  const visiting = new Set<string>(), finished = new Map<string, string>();
  const compositionVisiting = new Set<string>(), compositionFinished = new Map<string, string>();
  const compositionHash = (id: string): string => {
    const cached = compositionFinished.get(id); if (cached) return cached;
    const composition = ir.compositions.find((candidate) => candidate.id === id);
    if (compositionVisiting.has(id)) throw new CutGraphError("CUT_GRAPH_CYCLE", id, undefined, `CUT composition graph contains a cycle at ${id}`);
    if (!composition) throw new CutGraphError("CUT_GRAPH_REFERENCE", id, undefined, `CUT graph references missing composition ${id}`);
    compositionVisiting.add(id);
    const result = cutCompositionContentHash(ir, composition, nodeHash);
    compositionVisiting.delete(id); compositionFinished.set(id, result); return result;
  };
  const nodeHash = (id: string): string => {
    const cached = finished.get(id); if (cached) return cached;
    const node = ir.nodes[id];
    if (visiting.has(id)) throw new CutGraphError(node?.domain === "audio" ? "CUT_AUDIO_GRAPH" : "CUT_GRAPH_CYCLE", id, node, `CUT graph contains a cycle at node ${id}`);
    if (!node) throw new CutGraphError("CUT_GRAPH_REFERENCE", id, undefined, `CUT graph references missing node ${id}`);
    visiting.add(id);
    const result = cutNodeContentHashUnchecked(ir, node, nodeHash, compositionHash); node.contentHash = result; visiting.delete(id); finished.set(id, result); return result;
  };
  Object.keys(ir.nodes).forEach(nodeHash);
  ir.buildId = cutIrIdentity(ir); return ir;
}

export type RenderCacheManifest = {
  format: "cut-render-cache";
  version: 3;
  runtime: string;
  backendIntegrity: string;
  sceneToolchainIntegrity: string;
  target: { width: number; height: number; fps: string; sampleRate: number; color?: ReferenceColorProfile };
  nodes: Record<string, string>;
  scenes: Record<string, string>;
};

export type IncrementalRenderPlan = {
  manifest: RenderCacheManifest;
  nodes: Array<{ id: string; key: string; status: "hit" | "miss" }>;
  scenes: Array<{ id: string; key: string; status: "hit" | "miss" }>;
  hits: number;
  misses: number;
};

export function createIncrementalRenderPlan(ir: CutAVIR, compositionId: string, previous?: RenderCacheManifest, runtime = cutReferenceRuntimeIdentity, backendIntegrity = referenceDependencyIdentity.integrity, color: ReferenceColorProfile | "legacy" = "legacy", sceneToolchainIntegrity = "cut-scene-toolchain-unbound"): IncrementalRenderPlan {
  finalizeGraphHashes(ir);
  const selected = compositionNodeRoots(ir, compositionId), composition = selected?.composition;
  if (!composition || !selected) throw new Error(`Unknown CUT composition “${compositionId}”.`);
  assertCutGraphExecutionBudget(ir, selected.roots);
  const target = { width: composition.width, height: composition.height, fps: `${composition.fps.numerator}/${composition.fps.denominator}`, sampleRate: composition.sampleRate, ...(color === "legacy" ? {} : { color }) };
  // Picture and sound have different execution dependencies. Keeping their
  // target identities separate is what lets a gain edit or sample-rate-only
  // change reuse decoded/composited picture frames without pretending the
  // audio graph is unchanged.
  const visualTargetHash = hash({ runtime, backendIntegrity, sceneToolchainIntegrity, sceneEncoding: referenceSceneEncodingContract, width: target.width, height: target.height, fps: target.fps, ...(target.color === undefined ? {} : { color: target.color }) });
  const audioTargetHash = hash({ runtime, backendIntegrity, sampleRate: target.sampleRate, duration: composition.duration });
  // Timeline references are full semantic dependencies in build identity, but
  // the picture cache must not depend on an unrelated source-timeline mix.
  // Re-project the same typed graph through picture roots only. This keeps a
  // NestedSequence audio edit in the audio artifact key while preserving its
  // parent scene frames; a source picture edit still invalidates transitively.
  const visualNodeMemo = new Map<string, string>(), visualCompositionMemo = new Map<string, string>(), visualCompositions = new Set<string>(), visualNodes = new Set<string>();
  const visualCompositionHash = (id: string): string => {
    const cached = visualCompositionMemo.get(id); if (cached) return cached;
    if (visualCompositions.has(id)) throw new CutGraphError("CUT_GRAPH_CYCLE", id, undefined, `CUT visual composition cache graph contains a cycle at ${id}`);
    const source = ir.compositions.find((candidate) => candidate.id === id);
    if (!source) throw new CutGraphError("CUT_GRAPH_REFERENCE", id, undefined, `CUT visual cache references missing composition ${id}`);
    visualCompositions.add(id);
    const roots = (ids: readonly string[]) => ids.map((nodeId) => visualNodeHash(nodeId));
    const result = hash({
      width: source.width,
      height: source.height,
      fps: source.fps,
      duration: source.duration,
      roots: [...roots(source.rootVisualIds), ...roots(source.rootAVIds)],
      scenes: source.sceneIds.map((sceneId) => {
        const scene = ir.scenes[sceneId];
        if (!scene) throw new CutGraphError("CUT_GRAPH_REFERENCE", sceneId, undefined, `CUT visual cache composition ${id} references missing scene ${sceneId}`);
        return { start: scene.start, duration: scene.duration, roots: [...roots(scene.rootVisualIds), ...roots(scene.rootAVIds)] };
      }),
    });
    visualCompositions.delete(id); visualCompositionMemo.set(id, result); return result;
  };
  const visualNodeHash = (id: string): string => {
    const cached = visualNodeMemo.get(id); if (cached) return cached;
    if (visualNodes.has(id)) throw new CutGraphError("CUT_GRAPH_CYCLE", id, ir.nodes[id], `CUT visual cache graph contains a cycle at node ${id}`);
    const node = ir.nodes[id];
    if (!node) throw new CutGraphError("CUT_GRAPH_REFERENCE", id, undefined, `CUT visual cache references missing node ${id}`);
    visualNodes.add(id);
    const result = cutNodeContentHashUnchecked(ir, node, visualNodeHash, visualCompositionHash);
    visualNodes.delete(id); visualNodeMemo.set(id, result); return result;
  };
  const selectedAliases = new Map<string, string>();
  if (isReferenceMediaProfileExecution(ir)) for (const track of Object.values(ir.nodes)) {
    if (track.editorial?.kind !== "picture-track") continue;
    track.children.forEach((childId, index) => selectedAliases.set(childId, `${track.id}:materialized:${index}`));
  }
  const plannedNodes = Object.values(ir.nodes).filter((node) => !node.sceneId || composition.sceneIds.includes(node.sceneId)).map((node) => {
    const pictureBearing = node.domain === "visual" || node.domain === "av";
    const targetHash = pictureBearing ? visualTargetHash : audioTargetHash;
    const key = hash({ node: pictureBearing ? visualNodeHash(node.id) : node.contentHash, targetHash }), cacheId = selectedAliases.get(node.id) ?? node.id;
    return { id: node.id, cacheId, key, status: previous?.nodes[cacheId] === key ? "hit" as const : "miss" as const };
  });
  const nodeKeys = Object.fromEntries(plannedNodes.map((item) => [item.id, item.key]));
  const scenes = composition.sceneIds.map((id) => {
    const scene = ir.scenes[id]; const roots = [...scene.rootVisualIds, ...scene.rootAVIds];
    const semanticMatch = semanticMatchSceneCacheIdentity(ir, composition.id, id);
    const timelineEdit = timelineEditSceneCacheIdentity(ir, composition.id, id);
    const key = hash({
      scene: { start: scene.start, duration: scene.duration },
      roots: roots.map((root) => nodeKeys[root]),
      targetHash: visualTargetHash,
      ...(semanticMatch ? { semanticMatch } : {}),
      ...(timelineEdit ? { timelineEdit } : {}),
    });
    return { id, key, status: previous?.scenes[id] === key ? "hit" as const : "miss" as const };
  });
  const manifestNodes = Object.fromEntries(plannedNodes.map((item) => [item.cacheId, item.key]));
  const manifest: RenderCacheManifest = { format: "cut-render-cache", version: 3, runtime, backendIntegrity, sceneToolchainIntegrity, target, nodes: manifestNodes, scenes: Object.fromEntries(scenes.map((item) => [item.id, item.key])) };
  const nodes = plannedNodes.map((item) => ({ id: item.id, key: item.key, status: item.status }));
  const hits = [...nodes, ...scenes].filter((item) => item.status === "hit").length; return { manifest, nodes, scenes, hits, misses: nodes.length + scenes.length - hits };
}

export function nodeReferences(node: IRNode): string[] {
  return [...new Set(nodeReferenceEdges(node))];
}

export function signalWriteIntervals(signal: IRSignal) {
  if (signal.kind === "constant") return [];
  if (signal.kind === "step") return signal.points.map((point) => ({ start: point.time, end: point.time }));
  if (signal.kind === "track") return signal.events.map((event) => event.kind === "set" ? { start: event.time, end: event.time } : { start: event.start, end: event.end });
  return signal.keyframes.length < 2 ? [] : [{ start: signal.keyframes[0].time, end: signal.keyframes.at(-1)!.time }];
}
