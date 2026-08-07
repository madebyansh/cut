import type { CutAVIR, IRComposition, IREditorialInterval, IRNode, IRValue } from "../../language/ir";
import { hash } from "../../core/stable";
import { addRational, compareRational, multiplyRational, rational, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { nodeReferences } from "../graph";
import {
  compileReferenceAudioAutomation,
  compileReferenceCompressorAutomations,
  compileReferenceDeEsserAutomations,
  compileReferenceParametricEqAutomations,
  compileReferenceStateVariableFilterAutomations,
} from "./audio-automation";
import { referenceAudioNodeConfig, type ReferenceMediaAudioConfig } from "./audio-config";
import { ReferenceNoOpContractError, validateReferenceNoOpContract } from "./noop-contract";
import { referenceAudioCompositionRootIds } from "./audio-resource";
import { kernelAcceptsInput, kernelAcceptsProperty, kernelStringInputValues, referenceKernelSchema } from "../../language/kernel-registry";
import { ReferencePrecompError, referencePrecompLimits, validateReferencePrecompGraph } from "./precomp-config";
import type { LockedResourceProbe } from "../../language/lock";
import { compileReferenceTimeStretchPlan, type ReferenceTimeStretchPlan } from "./audio-time-stretch";
import { referenceTimelineEditAudioTrackTransitions } from "./timeline-edit";

export const referenceAudioRegionInsertOps = Object.freeze([
  "cut.audio.gain",
  "cut.audio.pan",
  "cut.audio.eq",
  "cut.audio.highpass",
  "cut.audio.lowpass",
  "cut.audio.compressor",
  "cut.audio.deesser",
  "cut.audio.time_stretch",
] as const);

const insertOps = new Set<string>(referenceAudioRegionInsertOps);
const leafInputs = new Set(["source", "range", "fadeIn", "fadeOut"]);

export class ReferenceAudioRegionError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly nodeId: string, node: IRNode, message: string, readonly code: "CUT_EDIT_AUDIO_REGION" | "CUT_AUDIO_REGION_RETIME_TOPOLOGY" | "CUT_AUDIO_REGION_RETIME_PLAN" | "CUT_AUDIO_REGION_RETIME_AUTOMATION" = "CUT_EDIT_AUDIO_REGION") {
    const { module, span } = node.provenance;
    super(`${code}: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceAudioRegionError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId };
  }
}

export class ReferenceAudioGraphAuthorizationError extends Error {
  readonly code = "CUT_AUDIO_GRAPH" as const;
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(owner: Pick<IRNode | IRComposition, "id" | "provenance">, message: string) {
    const { module, span } = owner.provenance;
    super(`CUT_AUDIO_GRAPH: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceAudioGraphAuthorizationError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: owner.id };
  }
}

function fail(node: IRNode, message: string, code?: ReferenceAudioRegionError["code"]): never {
  throw new ReferenceAudioRegionError(node.id, node, message, code);
}

function graphFail(owner: Pick<IRNode | IRComposition, "id" | "provenance">, message: string): never {
  throw new ReferenceAudioGraphAuthorizationError(owner, message);
}

function sameInterval(left: IREditorialInterval, right: IREditorialInterval) {
  return compareRational(left.start, right.start) === 0 && compareRational(left.duration, right.duration) === 0;
}

function exactSamples(node: IRNode, value: Rational, sampleRate: number, label: string) {
  const samples = multiplyRational(value, rational(sampleRate));
  if (samples.denominator !== "1") fail(node, `${label} does not land on the ${sampleRate} Hz destination sample grid`);
  const result = Number(samples.numerator);
  if (!Number.isSafeInteger(result) || result < 0) fail(node, `${label} has an invalid exact sample position`);
  return result;
}

function exactTimeRange(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "range" || !value.exclusive
    || value.start.kind !== "quantity" || value.start.dimension !== "time"
    || value.end.kind !== "quantity" || value.end.dimension !== "time") {
    fail(node, `${label} must be one exact half-open Range<Time>`);
  }
  const start = value.start.magnitude, end = value.end.magnitude;
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) fail(node, `${label} must be positive and cannot begin before zero`);
  return { start, duration: subtractRational(end, start) };
}

function boundedLinkText(node: IRNode, value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(node, `${label} must be a non-empty trimmed String of at most 128 characters without control characters`);
  }
  return value;
}

function authoredLink(node: IRNode) {
  const value = node.inputs.link;
  if (value === undefined) return undefined;
  if (value.kind !== "string") fail(node, "link must be a non-empty trimmed String of at most 128 characters without control characters");
  return boundedLinkText(node, value.value, "link");
}

function authoredRegionHandle(node: IRNode, name: "headHandle" | "tailHandle") {
  const value = node.inputs[name];
  if (value === undefined) return zeroRational;
  if (value.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s"
    || compareRational(value.magnitude, zeroRational) < 0) {
    fail(node, `${name} must be a non-negative exact Time in seconds`);
  }
  return value.magnitude;
}

function directParents(ir: CutAVIR) {
  const result = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) for (const childId of parent.children) {
    const values = result.get(childId) ?? [];
    values.push(parent); result.set(childId, values);
  }
  return result;
}

function collectValueNodeReferences(value: IRValue, result: Set<string>) {
  if (value.kind === "node-ref") result.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => collectValueNodeReferences(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => collectValueNodeReferences(item, result));
  else if (value.kind === "range") { collectValueNodeReferences(value.start, result); collectValueNodeReferences(value.end, result); }
  else if (value.kind === "unary") collectValueNodeReferences(value.value, result);
  else if (value.kind === "binary") { collectValueNodeReferences(value.left, result); collectValueNodeReferences(value.right, result); }
  else if (value.kind === "member") collectValueNodeReferences(value.object, result);
  else if (value.kind === "index") { collectValueNodeReferences(value.object, result); collectValueNodeReferences(value.index, result); }
  else if (value.kind === "call") {
    value.positional.forEach((item) => collectValueNodeReferences(item, result));
    Object.values(value.named).forEach((item) => collectValueNodeReferences(item, result));
  }
}

function nonStructuralReferenceParents(ir: CutAVIR) {
  const result = new Map<string, IRNode[]>();
  for (const node of Object.values(ir.nodes)) {
    const references = new Set<string>();
    Object.values(node.inputs).forEach((value) => collectValueNodeReferences(value, references));
    for (const value of Object.values(node.properties)) if (!("signal" in value)) collectValueNodeReferences(value, references);
    for (const targetId of references) {
      const parents = result.get(targetId) ?? [];
      parents.push(node); result.set(targetId, parents);
    }
  }
  return result;
}

type AudioRegionGraphRelations = Readonly<{
  structuralParents: ReturnType<typeof directParents>;
  referenceParents: ReturnType<typeof nonStructuralReferenceParents>;
}>;

type AudioRegionBatchAuthorization = {
  validatedTrackIds: Set<string>;
  itemsByTrackId: Map<string, Map<string, { item: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }>["items"][number]; index: number }>>;
};

function audioRegionGraphRelations(ir: CutAVIR): AudioRegionGraphRelations {
  return { structuralParents: directParents(ir), referenceParents: nonStructuralReferenceParents(ir) };
}

function canonicalAudioRoots(ir: CutAVIR, composition: IRComposition) {
  const compareRoots = (
    owner: Pick<IRComposition, "id" | "name" | "provenance"> | CutAVIR["scenes"][string],
    items: readonly { id: string; domain: string }[],
    rootAudioIds: readonly string[],
    rootAVIds: readonly string[],
  ) => {
    const itemIds = items.filter((item) => item.domain === "audio" || item.domain === "av").map((item) => item.id);
    const listIds = [...rootAudioIds, ...rootAVIds];
    if (new Set(itemIds).size !== itemIds.length || new Set(listIds).size !== listIds.length) {
      graphFail(owner, `audio root declarations for ${JSON.stringify(owner.name)} contain a duplicate executable root`);
    }
    const sortedItems = [...itemIds].sort(), sortedLists = [...listIds].sort();
    if (sortedItems.length !== sortedLists.length || sortedItems.some((id, index) => id !== sortedLists[index])) {
      graphFail(owner, `audio root items and rootAudioIds/rootAVIds disagree for ${JSON.stringify(owner.name)}`);
    }
    for (const item of items) {
      if (item.domain !== "audio" && item.domain !== "av") continue;
      const node = ir.nodes[item.id];
      if (!node || node.domain !== item.domain) graphFail(owner, `audio root item ${item.id} has missing or mismatched node/domain data`);
      const expectedSceneId = "start" in owner ? owner.id : undefined;
      if (node.sceneId !== expectedSceneId) graphFail(node, `audio root ${item.id} has scene ownership inconsistent with ${JSON.stringify(owner.name)}`);
      if (item.domain === "audio" && !rootAudioIds.includes(item.id)) graphFail(owner, `audio root item ${item.id} is absent from rootAudioIds`);
      if (item.domain === "av" && !rootAVIds.includes(item.id)) graphFail(owner, `AV root item ${item.id} is absent from rootAVIds`);
    }
    return itemIds;
  };

  const compositionItems = composition.items.flatMap((item) => item.kind === "node" ? [item] : []);
  const roots = compareRoots(composition, compositionItems, composition.rootAudioIds, composition.rootAVIds);
  const seenScenes = new Set<string>();
  for (const sceneId of composition.sceneIds) {
    if (seenScenes.has(sceneId)) graphFail(composition, `scene ${sceneId} is listed more than once`);
    seenScenes.add(sceneId);
    const scene = ir.scenes[sceneId];
    if (!scene) graphFail(composition, `references missing scene ${sceneId}`);
    roots.push(...compareRoots(scene, scene.items, scene.rootAudioIds, scene.rootAVIds));
  }
  return roots;
}

function validateSelectedAudioRoots(ir: CutAVIR, composition: IRComposition, rootIds: readonly string[]) {
  const canonical = canonicalAudioRoots(ir, composition), allowed = new Set(canonical);
  // Limiter and TimeStretch own explicit child-render preparation boundaries.
  // Their CUT-core implementations recursively request those exact direct
  // child subgraphs as raw f32 input.
  const pending = [...canonical], reachable = new Set<string>(), preparationRoots = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    const node = ir.nodes[id];
    if (!node) continue;
    reachable.add(id);
    if (node.op === "cut.audio.limiter" || node.op === "cut.audio.time_stretch") {
      node.children.forEach((child) => preparationRoots.add(child));
    }
    pending.push(...nodeReferences(node));
  }

  // Stem planning documents Meter and component fragments as transparent
  // top-level wrappers. Starting only at canonical roots, follow structural
  // children while every wrapper is exactly one of those two operations. A
  // reached Bus is selectable and terminates this traversal. This admits
  // Meter -> fragment -> Bus without granting selection authority to a Tone,
  // Gain, nested Bus, AudioRegion/private processor, referenced node, or a
  // different composition's graph.
  const transparentRoots = new Set<string>(), transparentPending = [...canonical], transparentSeen = new Set<string>();
  while (transparentPending.length) {
    const id = transparentPending.pop()!;
    if (transparentSeen.has(id)) continue;
    transparentSeen.add(id);
    const node = ir.nodes[id];
    if (!node || (node.op !== "cut.audio.meter" && node.op !== "cut.kernel.fragment")) continue;
    for (const childId of node.children) {
      const child = ir.nodes[childId];
      if (child?.op === "cut.audio.bus") transparentRoots.add(childId);
      else if (child?.op === "cut.audio.meter" || child?.op === "cut.kernel.fragment") transparentPending.push(childId);
    }
  }

  // One additional CUT-owned selection boundary is intentionally narrower
  // than arbitrary descendant selection. A direct Bus child of exactly
  // Submix(name: "pre-master") is selectable only when that Submix is reached
  // from a canonical master root through transparent Meter/component
  // fragments and a one-child chain of the closed linear insert set. This
  // lets stem export serialize the authored route before shared mastering
  // without granting selection authority to a processor, source, nested Bus,
  // routing/duration effect, or an inferred Limiter { Bus } boundary.
  const linearPreMasterInsertOps = new Set([
    "cut.audio.gain",
    "cut.audio.highpass",
    "cut.audio.lowpass",
    "cut.audio.eq",
    "cut.audio.compressor",
    "cut.audio.deesser",
    "cut.audio.limiter",
  ]);
  const preMasterRoots = new Set<string>(), preMasterPending = [...canonical], preMasterSeen = new Set<string>();
  while (preMasterPending.length) {
    const id = preMasterPending.pop()!;
    if (preMasterSeen.has(id)) continue;
    preMasterSeen.add(id);
    const node = ir.nodes[id];
    if (!node) continue;
    if (node.op === "cut.audio.submix") {
      const name = node.inputs.name;
      if (name?.kind === "string"
        && name.value === "pre-master"
        && node.children.length > 0
        && node.children.every((childId) => ir.nodes[childId]?.op === "cut.audio.bus")) {
        node.children.forEach((childId) => preMasterRoots.add(childId));
      }
      continue;
    }
    if (node.op === "cut.audio.meter" || node.op === "cut.kernel.fragment") {
      preMasterPending.push(...node.children);
    } else if (linearPreMasterInsertOps.has(node.op) && node.children.length === 1) {
      preMasterPending.push(node.children[0]);
    }
  }
  if (new Set(rootIds).size !== rootIds.length) graphFail(composition, "selected audio roots contain a duplicate executable root");
  for (const id of rootIds) {
    if (!allowed.has(id) && !preparationRoots.has(id) && !transparentRoots.has(id) && !preMasterRoots.has(id)) {
      graphFail(ir.nodes[id] ?? composition, `selected audio root ${id} is not owned by timeline ${JSON.stringify(composition.name)} or one reachable CUT-core preparation boundary`);
    }
  }
  return canonical;
}

function validateGenericReachableAudioKernel(ir: CutAVIR, composition: IRComposition, node: IRNode, deferEmptyBus = false) {
  const schema = referenceKernelSchema(node.op);
  if (!schema || schema.support !== "supported") graphFail(node, `${node.op} is not one supported closed reference kernel`);
  if (schema.domain !== "any" && schema.domain !== node.domain) graphFail(node, `${node.op} requires domain ${schema.domain}; found ${node.domain}`);
  const unknownInput = Object.keys(node.inputs).find((name) => !kernelAcceptsInput(schema, name));
  if (unknownInput) throw new ReferenceNoOpContractError(node, `${node.op} does not execute input ${unknownInput}; refusing a silent no-op`);
  const unknownProperty = Object.keys(node.properties).find((name) => !kernelAcceptsProperty(schema, name));
  if (unknownProperty) throw new ReferenceNoOpContractError(node, `${node.op} does not execute property ${unknownProperty}; refusing a silent no-op`);
  // Bus routing metadata already has a stable, source-located public runtime
  // diagnostic contract. Preserve it at this shared preflight boundary instead
  // of laundering a recognized-but-malformed kind/role into a generic no-op
  // error. Unknown fields above still fail closed before config evaluation.
  if (node.op === "cut.audio.bus") referenceAudioNodeConfig(ir, composition, node);
  for (const [name, value] of Object.entries(node.inputs)) {
    const allowed = kernelStringInputValues(schema, name);
    if (allowed && (value.kind !== "string" || !allowed.includes(value.value))) {
      throw new ReferenceNoOpContractError(node, `${node.op}.${name} must be one of: ${allowed.join(", ")}`);
    }
  }
  for (const [name, value] of Object.entries(node.properties)) {
    if ("signal" in value && !ir.signals[value.signal]) graphFail(node, `${node.op}.${name} references missing signal ${value.signal}`);
  }
  const deferredStemEmpty = deferEmptyBus && node.op === "cut.audio.bus" && node.children.length === 0;
  if (!deferredStemEmpty && (node.children.length < schema.minimumChildren || (schema.maximumChildren !== undefined && node.children.length > schema.maximumChildren))) {
    throw new ReferenceNoOpContractError(node, `${node.op} has invalid direct child cardinality ${node.children.length}`);
  }
  if (schema.children !== "none" && schema.children !== "any") for (const childId of node.children) {
    const child = ir.nodes[childId];
    if (!child || child.domain !== schema.children) graphFail(node, `${node.op} requires ${schema.children} children; ${child?.op ?? childId} is incompatible`);
  }
  if (!deferredStemEmpty) validateReferenceNoOpContract(node, ir);
}

function genericRootOwners(ir: CutAVIR, nodeId: string) {
  const owners: string[] = [];
  for (const composition of ir.compositions) {
    if (composition.items.some((item) => item.kind === "node" && item.id === nodeId)
      || composition.rootAudioIds.includes(nodeId) || composition.rootAVIds.includes(nodeId)) owners.push(`composition:${composition.id}`);
  }
  for (const scene of Object.values(ir.scenes)) {
    if (scene.items.some((item) => item.id === nodeId) || scene.rootAudioIds.includes(nodeId) || scene.rootAVIds.includes(nodeId)) owners.push(`scene:${scene.id}`);
  }
  return [...new Set(owners)];
}

function validateGenericReachableAudioStructure(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  canonicalRoots: ReadonlySet<string>,
  parents: ReadonlyMap<string, IRNode[]>,
  deferSharedChildren = false,
) {
  const owners = genericRootOwners(ir, node.id), structuralParents = parents.get(node.id) ?? [];
  if (node.ownership === "root") {
    const expected = node.sceneId ? `scene:${node.sceneId}` : `composition:${composition.id}`;
    if (!canonicalRoots.has(node.id) || owners.length !== 1 || owners[0] !== expected || structuralParents.length) {
      graphFail(node, "root audio node must have exactly one selected composition/scene root owner and no structural parent");
    }
  } else if (node.ownership === "child") {
    const deferredStemAmbiguity = deferSharedChildren && owners.length === 0 && structuralParents.length > 1;
    if (!deferredStemAmbiguity && (owners.length || structuralParents.length !== 1 || structuralParents[0].children.filter((id) => id === node.id).length !== 1)) {
      graphFail(node, "child audio node must have exactly one structural parent, no root owner, and one parent edge");
    }
    if (!deferredStemAmbiguity && structuralParents[0].sceneId !== node.sceneId) graphFail(node, "child audio node and its structural parent must share one scene");
  } else if (node.ownership === "reference") {
    if (owners.length || structuralParents.length) graphFail(node, "reference audio node cannot also be a structural child or executable root");
  } else {
    graphFail(node, "a reachable detached audio node has no executable ownership semantics");
  }
  if (node.editorial !== undefined && node.op !== "cut.edit.audio_track") {
    graphFail(node, `${node.op} cannot carry editorial metadata; AudioTrack is the only reachable audio editorial carrier`);
  }
}

function validateProcessedTrackOwnership(ir: CutAVIR, composition: IRComposition, track: IRNode, parents: ReadonlyMap<string, IRNode[]>) {
  const rootOwners: string[] = [];
  for (const candidate of ir.compositions) {
    const itemCount = candidate.items.filter((item) => item.kind === "node" && item.id === track.id).length;
    const listCount = [...candidate.rootAudioIds, ...candidate.rootAVIds].filter((id) => id === track.id).length;
    if (itemCount || listCount) {
      if (itemCount !== 1 || listCount !== 1) fail(track, `AudioTrack root declaration is inconsistent or duplicated in timeline ${JSON.stringify(candidate.name)}`);
      rootOwners.push(`composition:${candidate.id}`);
    }
  }
  for (const scene of Object.values(ir.scenes)) {
    const itemCount = scene.items.filter((item) => item.id === track.id && (item.domain === "audio" || item.domain === "av")).length;
    const listCount = [...scene.rootAudioIds, ...scene.rootAVIds].filter((id) => id === track.id).length;
    if (itemCount || listCount) {
      if (itemCount !== 1 || listCount !== 1) fail(track, `AudioTrack root declaration is inconsistent or duplicated in scene ${JSON.stringify(scene.name)}`);
      rootOwners.push(`scene:${scene.id}`);
    }
  }
  const structuralParents = parents.get(track.id) ?? [];
  if (track.ownership === "root") {
    const expectedOwner = track.sceneId ? `scene:${track.sceneId}` : `composition:${composition.id}`;
    if (rootOwners.length !== 1 || rootOwners[0] !== expectedOwner || structuralParents.length) {
      fail(track, "root AudioTrack must have exactly one selected composition/scene root owner and no structural parent");
    }
    if (track.sceneId && !composition.sceneIds.includes(track.sceneId)) fail(track, "root AudioTrack scene is not owned by the selected composition");
    return;
  }
  if (track.ownership === "child") {
    if (rootOwners.length || structuralParents.length !== 1 || structuralParents[0].children.filter((id) => id === track.id).length !== 1) {
      fail(track, "child AudioTrack must have exactly one structural parent, no root owner, and one parent edge");
    }
    if (structuralParents[0].sceneId !== track.sceneId) fail(track, "child AudioTrack and its structural parent must share one scene");
    return;
  }
  fail(track, `AudioTrack ownership ${track.ownership} is not executable for a processed region`);
}

function validateProcessedRegionParentTrack(ir: CutAVIR, composition: IRComposition, track: IRNode, parents: ReadonlyMap<string, IRNode[]>) {
  validateProcessedTrackOwnership(ir, composition, track, parents);
  if (!track.editorial || track.editorial.kind !== "audio-track") fail(track, "AudioRegion parent requires closed audio-track editorial metadata");
  if (Object.keys(track.inputs).length) {
    fail(track, "processed AudioRegion tracks cannot retain compile-time sourceDuration/edits operands or any other AudioTrack input");
  }
  const operationPlan = track.editorial.operationPlan;
  const timelineTransitions = referenceTimelineEditAudioTrackTransitions(ir, track);
  if (operationPlan && operationPlan.version !== 2) {
    fail(track, "processed AudioRegion tracks cannot carry structural edit plans; only the closed version-2 transition plan is executable");
  }
  if (track.editorial.transitions?.length
    && operationPlan?.version !== 2
    && !timelineTransitions?.length) {
    fail(track, "processed AudioRegion transition metadata requires one closed version-2 transition plan");
  }
  if (operationPlan?.version === 2 && !(track.editorial.transitions?.length)) {
    fail(track, "processed AudioRegion version-2 transition plan requires materialized transition metadata");
  }
  if (!track.children.length || track.editorial.items.length !== track.children.length) {
    fail(track, "processed AudioRegion track metadata must cover every child exactly once");
  }
  if (new Set(track.children).size !== track.children.length) fail(track, "processed AudioRegion track children cannot be duplicated or shared");

  let coverageEnd = track.interval.start;
  let previousStart = track.interval.start;
  let latestGapEnd = track.interval.start;
  for (const [index, item] of track.editorial.items.entries()) {
    const child = ir.nodes[item.nodeId];
    if (item.order !== index || track.children[index] !== item.nodeId) fail(track, `processed AudioRegion track item ${index} must exactly match child order`);
    if (!child || child.domain !== "audio") fail(track, `processed AudioRegion track item ${index} must reference one existing audio child`);
    if (child.sceneId !== track.sceneId) fail(track, `processed AudioRegion track item ${index} must share its AudioTrack scene`);
    const expectedOp = item.kind === "gap"
      ? "cut.edit.audio_gap"
      : child.op === "cut.edit.timeline_audio_view"
        ? "cut.edit.timeline_audio_view"
        : item.sourceNodeId === undefined
          ? "cut.audio.clip"
          : "cut.edit.audio_region";
    if (child.op !== expectedOp) fail(track, `processed AudioRegion track item ${index} kind/sourceNodeId disagrees with child ${child.op}`);
    if (compareRational(item.destination.duration, zeroRational) <= 0 || !sameInterval(item.destination, child.interval)) {
      fail(track, `processed AudioRegion track item ${index} destination must be positive and exactly equal its child interval`);
    }
    const itemEnd = addRational(item.destination.start, item.destination.duration);
    if (compareRational(item.destination.start, previousStart) < 0) fail(track, `processed AudioRegion track item ${index} is out of nondecreasing temporal order`);
    if (compareRational(item.destination.start, coverageEnd) > 0) fail(track, `processed AudioRegion track item ${index} leaves an uncovered interval that requires AudioGap`);
    if (item.kind === "gap" && compareRational(item.destination.start, coverageEnd) !== 0) fail(track, `processed AudioRegion track gap ${index} overlaps audio or another gap`);
    if (item.kind === "audio" && compareRational(item.destination.start, latestGapEnd) < 0) fail(track, `processed AudioRegion track audio item ${index} overlaps an explicit AudioGap`);

    if (child.op !== "cut.edit.timeline_audio_view") {
      const authoredDestination = exactTimeRange(child, child.inputs.destination, `${child.op} destination`);
      const translatedDestination = { start: addRational(track.interval.start, authoredDestination.start), duration: authoredDestination.duration };
      if (!sameInterval(item.destination, translatedDestination)) fail(track, `processed AudioRegion track item ${index} destination metadata disagrees with its authored track-relative range`);
    }
    if (item.kind === "gap") {
      if (item.source !== undefined || item.sourceNodeId !== undefined || item.linkId !== undefined || child.inputs.link !== undefined) {
        fail(track, `processed AudioRegion track gap ${index} cannot claim source or link metadata`);
      }
    } else {
      if (!item.source) fail(track, `processed AudioRegion track audio item ${index} requires source metadata`);
      const itemLinkId = boundedLinkText(child, item.linkId, `audio-track item ${index} linkId`);
      const childLinkId = authoredLink(child);
      if (itemLinkId !== childLinkId) fail(child, `audio-track item ${index} linkId must exactly equal ${child.op}.link`);
      if (child.op === "cut.audio.clip") {
        if (item.sourceNodeId !== undefined) fail(track, `direct AudioClip item ${index} cannot claim a separate sourceNodeId`);
        const sourceRange = exactTimeRange(child, child.inputs.range, "AudioClip source range");
        if (!sameInterval(item.source, sourceRange)) fail(track, `direct AudioClip item ${index} source metadata disagrees with its authored range`);
        if (compareRational(item.source.duration, item.destination.duration) !== 0) fail(track, `direct AudioClip item ${index} source and destination durations must match exactly`);
      } else if (child.op === "cut.edit.timeline_audio_view") {
        if (!item.sourceNodeId) fail(track, `timeline audio view item ${index} requires its exact origin AudioClip sourceNodeId`);
        const sourceRange = exactTimeRange(child, child.inputs.source, "timeline audio view source range");
        if (!sameInterval(item.source, sourceRange)) fail(track, `timeline audio view item ${index} source metadata disagrees with its authenticated source slice`);
      } else if (!item.sourceNodeId) {
        fail(track, `AudioRegion item ${index} requires the exact descendant AudioClip sourceNodeId`);
      }
    }
    previousStart = item.destination.start;
    if (compareRational(itemEnd, coverageEnd) > 0) coverageEnd = itemEnd;
    if (item.kind === "gap") latestGapEnd = itemEnd;
  }
  if (compareRational(coverageEnd, addRational(track.interval.start, track.interval.duration)) !== 0) {
    fail(track, "processed AudioRegion track coverage must fill the complete interval; intentional silence requires AudioGap");
  }
}

function validateClosedKernel(ir: CutAVIR, node: IRNode) {
  const schema = referenceKernelSchema(node.op);
  if (!schema || schema.support !== "supported") fail(node, `${node.op} is not one supported closed reference kernel`);
  if (schema.domain !== "any" && schema.domain !== node.domain) fail(node, `${node.op} requires domain ${schema.domain}; found ${node.domain}`);
  const unknownInput = Object.keys(node.inputs).find((name) => !kernelAcceptsInput(schema, name));
  if (unknownInput) fail(node, `${node.op} does not execute input ${unknownInput}; refusing a silent no-op`);
  const unknownProperty = Object.keys(node.properties).find((name) => !kernelAcceptsProperty(schema, name));
  if (unknownProperty) fail(node, `${node.op} does not execute property ${unknownProperty}; refusing a silent no-op`);
  for (const [name, value] of Object.entries(node.inputs)) {
    const allowed = kernelStringInputValues(schema, name);
    if (allowed && (value.kind !== "string" || !allowed.includes(value.value))) fail(node, `${node.op}.${name} must be one of: ${allowed.join(", ")}`);
  }
  for (const [name, value] of Object.entries(node.properties)) {
    if ("signal" in value && !ir.signals[value.signal]) fail(node, `${node.op}.${name} references missing signal ${value.signal}`);
  }
  if (node.children.length < schema.minimumChildren || (schema.maximumChildren !== undefined && node.children.length > schema.maximumChildren)) {
    fail(node, `${node.op} requires ${schema.maximumChildren === schema.minimumChildren ? `exactly ${schema.minimumChildren}` : `at least ${schema.minimumChildren}`} direct child node(s); found ${node.children.length}`);
  }
  if (schema.children !== "none" && schema.children !== "any") for (const childId of node.children) {
    const child = ir.nodes[childId];
    if (!child || child.domain !== schema.children) fail(node, `${node.op} requires ${schema.children} children; ${child?.op ?? childId} is incompatible`);
  }
}

function validateProcessorConfig(ir: CutAVIR, composition: IRComposition, node: IRNode) {
  validateClosedKernel(ir, node);
  validateReferenceNoOpContract(node, ir);
  const config = referenceAudioNodeConfig(ir, composition, node);
  if (!config) fail(node, `${node.op} has no executable reference-audio configuration`);
  if (node.op === "cut.audio.gain" || node.op === "cut.audio.pan") compileReferenceAudioAutomation(ir, composition, node);
  else if (node.op === "cut.audio.eq") compileReferenceParametricEqAutomations(ir, composition, node);
  else if (node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") compileReferenceStateVariableFilterAutomations(ir, composition, node);
  else if (node.op === "cut.audio.compressor") compileReferenceCompressorAutomations(ir, composition, node);
  else if (node.op === "cut.audio.deesser") compileReferenceDeEsserAutomations(ir, composition, node);
  return config;
}

export type ReferenceAudioRegionPlan = Readonly<{
  regionId: string;
  trackId: string;
  processorRootId: string;
  processorNodeIds: readonly string[];
  sourceNodeId: string;
  source: ReferenceMediaAudioConfig;
  sourceRange: IREditorialInterval;
  destination: IREditorialInterval;
  destinationStartSamples: number;
  destinationEndSamples: number;
  authorizationHash: string;
  headHandle: Rational;
  tailHandle: Rational;
  timeStretchNodeId?: string;
  linkId?: string;
}>;

function promotedToRoot(ir: CutAVIR, nodeId: string) {
  return ir.compositions.some((candidate) => candidate.rootAudioIds.includes(nodeId)
    || candidate.rootAVIds.includes(nodeId)
    || candidate.items.some((item) => item.kind === "node" && item.id === nodeId))
    || Object.values(ir.scenes).some((scene) => scene.rootAudioIds.includes(nodeId)
      || scene.rootAVIds.includes(nodeId)
      || scene.items.some((item) => item.id === nodeId));
}

/**
 * Authorize one loaded AudioRegion as a closed, independently owned graph.
 * This is the single runtime/cache/stem contract and must run before any path,
 * temporary file, cache lookup, or output materialization.
 */
function authorizeReferenceAudioRegionWithRelations(
  ir: CutAVIR,
  composition: IRComposition,
  region: IRNode,
  relations: AudioRegionGraphRelations,
  batch?: AudioRegionBatchAuthorization,
): ReferenceAudioRegionPlan {
  if (region.op !== "cut.edit.audio_region" || region.domain !== "audio") fail(region, "authorization requires one audio-domain cut.edit.audio_region node");
  if (region.ownership !== "child") fail(region, "AudioRegion ownership must be child");
  if (region.editorial !== undefined || Object.keys(region.properties).length) fail(region, "AudioRegion cannot carry editorial metadata or dynamic properties");
  if (region.children.length !== 1) fail(region, "requires exactly one direct audio processor/source root");
  validateClosedKernel(ir, region);
  validateReferenceNoOpContract(region, ir);
  if (promotedToRoot(ir, region.id)) fail(region, "AudioRegion cannot also be promoted to any composition or scene root");

  const parents = relations.structuralParents, regionParents = parents.get(region.id) ?? [];
  if (regionParents.length !== 1
    || (regionParents[0].op !== "cut.edit.audio_track"
      && regionParents[0].op !== "cut.edit.timeline_audio_origin")) {
    fail(region, "AudioRegion requires exactly one direct AudioTrack or authenticated TimelineEdit origin parent and no shared structural owner");
  }
  const timelineOrigin = regionParents[0].op === "cut.edit.timeline_audio_origin"
    ? regionParents[0]
    : undefined;
  const originViews = timelineOrigin
    ? (relations.referenceParents.get(timelineOrigin.id) ?? [])
      .filter((candidate) => candidate.op === "cut.edit.timeline_audio_view")
    : [];
  if (timelineOrigin) {
    if (timelineOrigin.ownership !== "reference"
      || timelineOrigin.children.length !== 1
      || timelineOrigin.children[0] !== region.id
      || timelineOrigin.sceneId !== region.sceneId
      || !sameInterval(timelineOrigin.interval, region.interval)
      || !originViews.length
      || (relations.referenceParents.get(timelineOrigin.id) ?? []).length !== originViews.length) {
      fail(timelineOrigin, "TimelineEdit processed-audio origin must be one same-scene reference owner reached only by bounded timeline audio views");
    }
  }
  const tracks = timelineOrigin
    ? [...new Map(originViews.flatMap((view) =>
      (parents.get(view.id) ?? [])
        .filter((candidate) => candidate.op === "cut.edit.audio_track")
        .map((candidate) => [candidate.id, candidate] as const))).values()]
    : [regionParents[0]];
  const ownerTracks = timelineOrigin
    ? tracks.filter((candidate) => originViews.some((view) =>
      (parents.get(view.id) ?? []).some((parent) => parent.id === candidate.id)
      && view.inputs.originTrackId === undefined))
    : tracks;
  if (ownerTracks.length !== 1) {
    fail(timelineOrigin ?? region, "TimelineEdit audio origin must have exactly one source-track owner view; cross-track views require the explicit owner track identity");
  }
  const track = ownerTracks[0]!;
  if (timelineOrigin) {
    if (!track.editorial || track.editorial.kind !== "audio-track") {
      fail(track, "TimelineEdit audio origin owner requires closed audio-track editorial metadata");
    }
    const ownerTrackId = track.editorial.trackId;
    for (const view of originViews) {
      const viewTracks = (parents.get(view.id) ?? []).filter((candidate) =>
        candidate.op === "cut.edit.audio_track");
      if (viewTracks.length !== 1
        || !viewTracks[0]!.editorial
        || viewTracks[0]!.editorial!.kind !== "audio-track") {
        fail(view, "TimelineEdit audio origin view must belong to exactly one AudioTrack");
      }
      const viewTrackId = viewTracks[0]!.editorial!.trackId;
      const originTrackId = view.inputs.originTrackId;
      const claimedOwner = originTrackId?.kind === "string"
        ? originTrackId.value
        : undefined;
      if (viewTrackId === ownerTrackId
        ? claimedOwner !== undefined
        : claimedOwner !== ownerTrackId) {
        fail(view, "TimelineEdit cross-track audio view must name the exact source-track owner and same-track views must omit that redundant input");
      }
    }
  }
  if (track.domain !== "audio") fail(track, "AudioRegion parent AudioTrack must be audio-domain");
  validateClosedKernel(ir, track);
  validateReferenceNoOpContract(track, ir);
  if (track.sceneId !== region.sceneId) fail(region, "AudioRegion and its AudioTrack parent must share one scene");
  if (region.sceneId && !composition.sceneIds.includes(region.sceneId)) fail(region, "AudioRegion scene does not belong to the selected composition");
  if (!batch?.validatedTrackIds.has(track.id)) {
    validateProcessedRegionParentTrack(ir, composition, track, parents);
    batch?.validatedTrackIds.add(track.id);
  }
  if (!track.editorial || track.editorial.kind !== "audio-track") fail(track, "AudioRegion parent requires closed audio-track editorial metadata");
  let indexedItem = batch?.itemsByTrackId.get(track.id)?.get(region.id);
  if (batch && !batch.itemsByTrackId.has(track.id)) {
    const index = new Map(track.editorial.items.map((item, itemIndex) => [item.nodeId, { item, index: itemIndex }]));
    batch.itemsByTrackId.set(track.id, index);
    indexedItem = index.get(region.id);
  }
  const matchingItems = timelineOrigin
    ? []
    : indexedItem ? [indexedItem.item] : track.editorial.items.filter((item) => item.nodeId === region.id);
  if (!timelineOrigin && (matchingItems.length !== 1 || matchingItems[0].kind !== "audio")) {
    fail(track, "AudioRegion must own exactly one audio-track item");
  }
  const item = matchingItems[0];
  const itemIndex = item
    ? indexedItem?.index ?? track.editorial.items.indexOf(item)
    : -1;
  if (item
    && (item.order !== itemIndex
      || track.children[itemIndex] !== region.id
      || track.children.filter((id) => id === region.id).length !== 1)) {
    fail(track, "AudioRegion item order/index must exactly match its sole AudioTrack child position");
  }

  const destination = exactTimeRange(region, region.inputs.destination, "destination");
  if (compareRational(addRational(destination.start, destination.duration), track.interval.duration) > 0) fail(region, "destination lies outside its AudioTrack parent interval");
  const expectedInterval = { start: addRational(track.interval.start, destination.start), duration: destination.duration };
  if (!sameInterval(region.interval, expectedInterval)
    || (item !== undefined && !sameInterval(item.destination, region.interval))) {
    fail(region, "authored destination, lowered interval, and audio-track item destination must match exactly");
  }
  const scene = region.sceneId ? ir.scenes[region.sceneId] : undefined;
  if (region.sceneId && !scene) fail(region, `references missing owning scene ${region.sceneId}`);
  const absoluteStart = addRational(scene?.start ?? zeroRational, region.interval.start);
  const absoluteEnd = addRational(absoluteStart, region.interval.duration);
  const destinationStartSamples = exactSamples(region, absoluteStart, composition.sampleRate, "destination start");
  const destinationEndSamples = exactSamples(region, absoluteEnd, composition.sampleRate, "destination end");
  const totalSamples = exactSamples(region, composition.duration, composition.sampleRate, "composition duration");
  if (destinationEndSamples > totalSamples) fail(region, "destination ends outside the owning composition");
  const linkId = authoredLink(region);
  const headHandle = authoredRegionHandle(region, "headHandle");
  const tailHandle = authoredRegionHandle(region, "tailHandle");
  if (item !== undefined && item.linkId !== linkId) fail(region, "audio-track link metadata must exactly equal AudioRegion.link");

  const processorRootId = region.children[0], processorNodeIds: string[] = [], visited = new Set<string>();
  const processorSnapshots: unknown[] = [];
  let expectedParent = region, current = ir.nodes[processorRootId], sourceNode: IRNode | undefined, source: ReferenceMediaAudioConfig | undefined, sourceRange: IREditorialInterval | undefined;
  let timeStretchNode: IRNode | undefined, timeStretchPlan: ReferenceTimeStretchPlan | undefined;
  for (let depth = 0; depth <= 32; depth += 1) {
    if (!current || current.domain !== "audio" || visited.has(current.id)) fail(region, "must contain one finite acyclic audio source chain");
    visited.add(current.id);
    if (current.editorial !== undefined) fail(current, "AudioRegion processors and AudioClip leaf cannot carry editorial metadata");
    const currentParents = parents.get(current.id) ?? [];
    if (current.ownership !== "child" || currentParents.length !== 1 || currentParents[0].id !== expectedParent.id) {
      fail(current, "every AudioRegion insert/source must have ownership child and exactly one structural parent in its owning chain");
    }
    if (promotedToRoot(ir, current.id)) fail(current, "AudioRegion descendants cannot also be promoted to any composition or scene root");
    if (!sameInterval(current.interval, region.interval) || current.sceneId !== region.sceneId) fail(current, "every insert and source leaf must share the exact AudioRegion interval and scene");
    if (current.op === "cut.audio.clip") {
      if (current.children.length) fail(current, "AudioClip leaf cannot have children");
      const unexpected = Object.keys(current.inputs).find((name) => !leafInputs.has(name));
      if (unexpected) fail(current, `AudioClip leaf accepts only source/range/fadeIn/fadeOut; found ${unexpected}`);
      sourceRange = exactTimeRange(current, current.inputs.range, "AudioClip source range");
      if (item !== undefined && (!item.source || !sameInterval(item.source, sourceRange))) fail(region, "audio-track source metadata must exactly equal the AudioClip leaf range");
      if (!timeStretchPlan && compareRational(sourceRange.duration, region.interval.duration) !== 0) fail(region, "AudioClip source and AudioRegion destination durations must match exactly unless the closed chain owns one TimeStretch");
      if (timeStretchPlan) {
        const expectedSourceDuration = rational(timeStretchPlan.sourceSamples, composition.sampleRate);
        if (timeStretchPlan.audioRegionId !== region.id
          || compareRational(sourceRange.duration, expectedSourceDuration) !== 0
          || timeStretchPlan.destinationSamples !== destinationEndSamples - destinationStartSamples) {
          fail(region, "TimeStretch sourceDuration/duration must exactly reconcile the AudioClip source range and outer destination", "CUT_AUDIO_REGION_RETIME_PLAN");
        }
      }
      if (item !== undefined && item.sourceNodeId !== current.id) fail(region, "audio-track sourceNodeId must identify the exact AudioClip descendant");
      validateClosedKernel(ir, current);
      validateReferenceNoOpContract(current, ir);
      const config = referenceAudioNodeConfig(ir, composition, current);
      if (config?.kind !== "media-source") fail(current, "AudioClip leaf requires one locked executable audio source");
      sourceNode = current; source = config;
      processorSnapshots.push({ node: current, config, resource: ir.resources[config.resourceId] });
      break;
    }
    if (!insertOps.has(current.op)) fail(current, `unsupported processed-region insert ${current.op}; intentional-tail, routing, and topology-changing processors are excluded`);
    if (current.children.length !== 1) fail(current, "every processed-region insert requires exactly one direct audio child");
    if (current.op === "cut.audio.time_stretch") {
      if (timeStretchNode) fail(current, "AudioRegion supports one TimeStretch only; nested or repeated retimes are refused", "CUT_AUDIO_REGION_RETIME_TOPOLOGY");
      timeStretchNode = current;
      timeStretchPlan = compileReferenceTimeStretchPlan(ir, composition, current);
    }
    processorNodeIds.push(current.id);
    const config = validateProcessorConfig(ir, composition, current);
    processorSnapshots.push({ node: current, config, signals: Object.values(current.properties).flatMap((value) => "signal" in value ? ir.signals[value.signal] ?? [] : []) });
    expectedParent = current;
    current = ir.nodes[current.children[0]];
  }
  if (!sourceNode || !source || !sourceRange) fail(region, "insert depth exceeds the 32-node bound or has no AudioClip source leaf");
  if (timeStretchNode) {
    if (!timelineOrigin && (region.inputs.headHandle !== undefined || region.inputs.tailHandle !== undefined)) {
      fail(region, "ordinary AudioRegion TimeStretch cannot declare headHandle/tailHandle; source-clock handles require one authenticated TimelineEdit origin/view", "CUT_AUDIO_REGION_RETIME_TOPOLOGY");
    }
    if (track.editorial.operationPlan !== undefined
      || (!timelineOrigin && track.editorial.transitions !== undefined)
      || Object.keys(track.inputs).length) {
      fail(track, "ordinary AudioRegion TimeStretch cannot participate in AudioTrack edits or crossfades; retimed transitions require one authenticated TimelineEdit origin/view", "CUT_AUDIO_REGION_RETIME_PLAN");
    }
    const automated = [sourceNode, ...processorNodeIds.map((id) => ir.nodes[id])].find((node) => node && Object.keys(node.properties).length > 0);
    if (automated) fail(automated, "AudioRegion TimeStretch chains must be fully static because source-clock versus destination-clock automation mapping is undefined", "CUT_AUDIO_REGION_RETIME_AUTOMATION");
  }
  const probe = ir.resources[source.resourceId]?.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.audio : undefined;
  if (!selected) fail(sourceNode, "AudioClip source requires one locked selected audio duration for region handle validation");
  const availableStart = subtractRational(sourceRange.start, headHandle), availableEnd = addRational(addRational(sourceRange.start, sourceRange.duration), tailHandle);
  if (compareRational(availableStart, zeroRational) < 0 || compareRational(availableEnd, selected.duration) > 0) {
    fail(region, "declared AudioRegion head/tail handle availability exceeds the locked selected audio stream");
  }
  for (const [label, value] of [["available source start", availableStart], ["available source end", availableEnd]] as const) {
    const samples = multiplyRational(value, rational(source.sourceSampleRate));
    if (samples.denominator !== "1") fail(region, `${label} does not land on the locked ${source.sourceSampleRate} Hz source sample grid`);
  }
  const privateChain = new Set([region.id, ...processorNodeIds, sourceNode.id]);
  for (const targetId of privateChain) {
    for (const referrer of relations.referenceParents.get(targetId) ?? []) {
      if (!privateChain.has(referrer.id)) {
        fail(ir.nodes[targetId] ?? region, `AudioRegion private processor/source chain cannot receive a non-structural node reference from outside the chain (${referrer.op})`);
      }
    }
  }
  const authorizationHash = hash({
    composition: { id: composition.id, duration: composition.duration, sampleRate: composition.sampleRate, sceneIds: composition.sceneIds },
    scene,
    track: { id: track.id, ownership: track.ownership, sceneId: track.sceneId, interval: track.interval, children: track.children, editorial: track.editorial },
    ...(timelineOrigin
      ? {
          timelineOrigin,
          originViews: originViews
            .map((view) => ({ ...view }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : {}),
    region,
    processors: processorSnapshots,
  });
  return Object.freeze({
    regionId: region.id,
    trackId: track.id,
    processorRootId,
    processorNodeIds: Object.freeze([...processorNodeIds]),
    sourceNodeId: sourceNode.id,
    source,
    sourceRange: Object.freeze({ ...sourceRange }),
    destination: Object.freeze({ ...region.interval }),
    destinationStartSamples,
    destinationEndSamples,
    authorizationHash,
    headHandle,
    tailHandle,
    ...(timeStretchNode ? { timeStretchNodeId: timeStretchNode.id } : {}),
    ...(linkId === undefined ? {} : { linkId }),
  });
}

export function authorizeReferenceAudioRegion(ir: CutAVIR, composition: IRComposition, region: IRNode): ReferenceAudioRegionPlan {
  return authorizeReferenceAudioRegionWithRelations(ir, composition, region, audioRegionGraphRelations(ir));
}

export function authorizeReferenceAudioRegions(
  ir: CutAVIR,
  composition: IRComposition,
  nodeIds: Iterable<string>,
) {
  const result = new Map<string, ReferenceAudioRegionPlan>();
  const relations = audioRegionGraphRelations(ir);
  const batch: AudioRegionBatchAuthorization = { validatedTrackIds: new Set(), itemsByTrackId: new Map() };
  for (const id of nodeIds) {
    const node = ir.nodes[id];
    if (node?.op === "cut.edit.audio_region") result.set(id, authorizeReferenceAudioRegionWithRelations(ir, composition, node, relations, batch));
  }
  return result as ReadonlyMap<string, ReferenceAudioRegionPlan>;
}

export function authorizeReachableReferenceAudioRegions(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  options: Readonly<{ validateSelectedRoots?: boolean; deferEmptyBus?: boolean; deferSharedChildren?: boolean }> = {},
) {
  const result = new Map<string, ReferenceAudioRegionPlan>(), visitedCompositions = new Set<string>(), compositionStack = new Set<string>();
  const typedNestedFailure = (incoming: IRNode | undefined, code: "CUT_NESTED_CYCLE" | "CUT_NESTED_BUDGET", message: string): never => {
    // The shared audio gate intentionally runs before the cache/direct
    // backends. When traversal discovers a composition error, reuse the
    // canonical precomp validator so JSON callers receive its stable typed,
    // source-located diagnostic rather than a plain Error from this walker.
    validateReferencePrecompGraph(ir, composition);
    if (incoming) throw new ReferencePrecompError(code, incoming, message);
    graphFail(composition, message);
  };
  const visit = (owner: IRComposition, roots: readonly string[], depth: number, validateRoots: boolean, incoming?: IRNode) => {
    if (depth > referencePrecompLimits.maxDepth) {
      typedNestedFailure(incoming, "CUT_NESTED_BUDGET", `AudioRegion authorization exceeds maxDepth=${referencePrecompLimits.maxDepth}`);
    }
    if (compositionStack.has(owner.id)) {
      typedNestedFailure(incoming, "CUT_NESTED_CYCLE", `AudioRegion authorization found a composition cycle at ${owner.id}`);
    }
    if (visitedCompositions.has(owner.id)) return;
    compositionStack.add(owner.id);
    const pending = [...roots], reachable = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      const node = ir.nodes[id];
      if (!node) continue;
      reachable.add(id);
      pending.push(...nodeReferences(node));
    }
    for (const [id, plan] of authorizeReferenceAudioRegions(ir, owner, reachable)) result.set(id, plan);
    const canonicalRoots = new Set(validateRoots ? validateSelectedAudioRoots(ir, owner, roots) : canonicalAudioRoots(ir, owner));
    const parents = directParents(ir);
    for (const id of reachable) {
      const node = ir.nodes[id];
      if (node) {
        validateGenericReachableAudioKernel(ir, owner, node, options.deferEmptyBus === true);
        validateGenericReachableAudioStructure(ir, owner, node, canonicalRoots, parents, options.deferSharedChildren === true);
      }
    }
    for (const id of reachable) {
      const node = ir.nodes[id];
      if (node?.op !== "cut.edit.nested_sequence") continue;
      const source = node.inputs.source;
      if (source?.kind !== "timeline-ref") continue;
      const nested = ir.compositions.find((candidate) => candidate.id === source.id);
      if (nested) visit(nested, referenceAudioCompositionRootIds(ir, nested), depth + 1, true, node);
    }
    compositionStack.delete(owner.id);
    visitedCompositions.add(owner.id);
  };
  visit(composition, rootIds, 0, options.validateSelectedRoots !== false);
  return result as ReadonlyMap<string, ReferenceAudioRegionPlan>;
}

/** One batched post-await mutation guard for every reachable region graph. */
export function assertReachableReferenceAudioRegionPlansCurrent(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  authorized: ReadonlyMap<string, ReferenceAudioRegionPlan>,
  options: Readonly<{ validateSelectedRoots?: boolean; deferEmptyBus?: boolean; deferSharedChildren?: boolean }> = {},
) {
  const current = authorizeReachableReferenceAudioRegions(ir, composition, rootIds, options);
  if (current.size !== authorized.size) graphFail(composition, "reachable AudioRegion set changed after preflight");
  for (const [id, plan] of authorized) {
    const next = current.get(id), region = ir.nodes[id];
    if (!next || next.authorizationHash !== plan.authorizationHash) {
      if (region) fail(region, "authorized processor/source graph changed after preflight");
      graphFail(composition, `authorized AudioRegion ${id} disappeared after preflight`);
    }
  }
  return current;
}
