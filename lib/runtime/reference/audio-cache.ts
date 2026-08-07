import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { hash, stableJsonStringify } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { packageSpecifierForNative } from "../../language/packages";
import { multiplyRational, rational } from "../../language/rational";
import { atomicWriteFile, ensureProjectWriteDirectory, publishStagedFile } from "../../project/write-boundary";
import { assertCutGraphExecutionBudget, cutExecutableNodeInputs, cutSignalContentHash, nodeReferences } from "../graph";
import { cutReferenceRuntimeIdentity } from "../../version";
import { referenceAudioNodeConfig } from "./audio-config";
import { referenceMasterAudioRootIds, renderReferenceAudioSelection } from "./audio";
import { runFfmpegCapture } from "./ffmpeg";
import { compileReferenceSynthPlan } from "./synth";
import { referenceTransitionContract } from "./transition-config";
import { referenceLinkedSplitContract } from "./linked-split-config";
import { referenceAudioCompositionRootIds } from "./audio-resource";
import {
  referenceAudioPeakLimits,
  ReferenceAudioPeakError,
  scanReferenceStereoF32Le,
  scanReferenceStereoF32LeFile,
  type ReferenceAudioPeakScan,
  type ReferenceAudioPeakSource,
} from "./audio-peak";
import { referencePrecompConfig, validateReferencePrecompGraph } from "./precomp-config";
import {
  collectReferenceAudioLimiterCompatibilityToolchain,
  isReferenceAudioLimiterCompatibilityToolchain,
  referenceAudioLimiterCompatibilityIdentity,
  type ReferenceAudioLimiterCompatibilityToolchain,
} from "./audio-limiter-compatibility";
import { referenceAudioLimiterIdentity } from "./audio-limiter";
import {
  isReferenceAudioLimiterBuildEvidence,
  type ReferenceAudioLimiterBuildEvidence,
} from "./audio-limiter-preparation";
import { validateReferenceLinkedEditTransactions } from "./linked-edit";
import { authorizeReachableReferenceAudioRegions } from "./audio-region";
import { validateReachableReferenceAudioRegionCrossfadePlans } from "./audio-edit-operations";
import type { ReferenceVerifiedInputSession } from "./verified-input-session";
import { assertReferenceMediaProfileExecutionState } from "./media-profile-state";
import { cutAudioProxyExecutionIdentity, type CutAudioProxyAlignment } from "../../language/audio-proxy-alignment";
import { referenceLinkedClipAudioExecutionPlan } from "./linked-av-presentation";
import { validateReferenceTimelineEditMaterializations } from "./timeline-edit";
import {
  cutTimelineAudioOriginInputs,
  cutTimelineAudioOriginOp,
  cutTimelineAudioViewInputs,
  cutTimelineAudioViewOp,
} from "../../language/timeline-edit-audio-origin-contract";

const cacheFormat = "cut-reference-audio-cache" as const;
const cacheVersion = 3 as const;
const evidenceFormat = "cut-reference-audio-cache-evidence" as const;
const toolchainFormat = "cut-reference-audio-toolchain" as const;

export type ReferenceAudioCacheReason =
  | "CUT_AUDIO_CACHE_HIT"
  | "CUT_AUDIO_CACHE_COLD"
  | "CUT_AUDIO_CACHE_KEY_CHANGED"
  | "CUT_AUDIO_CACHE_ARTIFACT_MISSING"
  | "CUT_AUDIO_CACHE_MANIFEST_INVALID"
  | "CUT_AUDIO_CACHE_ARTIFACT_CORRUPT"
  | "CUT_AUDIO_CACHE_ARTIFACT_CONTRACT";

export type ReferenceAudioToolchainIdentity = Readonly<{
  format: typeof toolchainFormat;
  version: 1;
  runtime: string;
  platform: NodeJS.Platform;
  architecture: string;
  node: string;
  ffmpeg: { version: string; identitySha256: string };
  integrity: string;
}>;

export type ReferenceAudioGraphIdentity = Readonly<{
  format: "cut-reference-audio-graph";
  version: 3;
  composition: {
    id: string;
    duration: { numerator: string; denominator: string };
    sampleRate: number;
    channels: 2;
    sampleFormat: "f32le";
    samples: number;
  };
  roots: Array<{ id: string; op: string }>;
  reachableNodes: number;
  signals: number;
  resources: number;
  packages: number;
  nodesSha256: string;
  signalsSha256: string;
  resourcesSha256: string;
  packagesSha256: string;
  limiter?: {
    nodes: number;
    processor: typeof referenceAudioLimiterIdentity;
    compatibilityPolicy: typeof referenceAudioLimiterCompatibilityIdentity;
    toolchain: ReferenceAudioLimiterCompatibilityToolchain;
  };
  sha256: string;
}>;

export type ReferenceAudioCacheEvidence = Readonly<{
  format: typeof evidenceFormat;
  version: 3;
  stage: "pre-master-f32le";
  status: "hit" | "miss";
  reason: ReferenceAudioCacheReason;
  key: string;
  previousKey?: string;
  artifact: {
    locator: string;
    sha256: string;
    bytes: number;
    sampleRate: number;
    channels: 2;
    sampleFormat: "f32le";
    samples: number;
    verification: "sha256+exact-f32le+sample-peak";
  };
  /** A new bounded scan of the exact artifact for this invocation. */
  peak: ReferenceAudioPeakScan;
  limiter: ReferenceAudioLimiterBuildEvidence;
  identity: {
    runtime: string;
    toolchain: ReferenceAudioToolchainIdentity;
    graph: ReferenceAudioGraphIdentity;
  };
}>;

type ReferenceAudioCacheManifest = {
  format: typeof cacheFormat;
  version: 3;
  key: string;
  runtime: string;
  toolchainIntegrity: string;
  graphSha256: string;
  sha256: string;
  bytes: number;
  sampleRate: number;
  channels: 2;
  sampleFormat: "f32le";
  samples: number;
  build: { roots: number; filters: number };
  limiter: ReferenceAudioLimiterBuildEvidence;
};

type ReferenceAudioCachePlan = {
  key: string;
  rootIds: string[];
  graph: ReferenceAudioGraphIdentity;
  toolchain: ReferenceAudioToolchainIdentity;
};

type CachedArtifactInspection =
  | { status: "hit"; manifest: ReferenceAudioCacheManifest }
  | { status: "miss"; reason: Exclude<ReferenceAudioCacheReason, "CUT_AUDIO_CACHE_HIT" | "CUT_AUDIO_CACHE_COLD" | "CUT_AUDIO_CACHE_KEY_CHANGED"> };

export class ReferenceAudioCacheError extends Error {
  constructor(readonly code: "CUT_AUDIO_CACHE_GRAPH" | "CUT_AUDIO_CACHE_TOOLCHAIN" | "CUT_AUDIO_CACHE_WAVE" | "CUT_AUDIO_CACHE_SELECTION", message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceAudioCacheError";
  }
}

function fail(code: ReferenceAudioCacheError["code"], message: string): never {
  throw new ReferenceAudioCacheError(code, message);
}

function exactTotalSamples(composition: IRComposition) {
  const exact = multiplyRational(composition.duration, rational(composition.sampleRate));
  if (exact.denominator !== "1") fail("CUT_AUDIO_CACHE_GRAPH", `Timeline “${composition.name}” duration does not land on the ${composition.sampleRate} Hz sample grid.`);
  const samples = Number(exact.numerator);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > referenceAudioPeakLimits.maximumFrames || !Number.isSafeInteger(samples * 8)) {
    fail("CUT_AUDIO_CACHE_GRAPH", `Timeline “${composition.name}” exceeds the bounded exact stereo f32le cache artifact.`);
  }
  return samples;
}

function normalizedToolOutput(value: string) {
  return value.replaceAll("\r\n", "\n").trim();
}

export function createReferenceAudioToolchainIdentity(ffmpegVersionOutput: string, environment: {
  platform?: NodeJS.Platform;
  architecture?: string;
  node?: string;
  runtime?: string;
} = {}): ReferenceAudioToolchainIdentity {
  const output = normalizedToolOutput(ffmpegVersionOutput), version = output.split("\n", 1)[0] ?? "";
  if (!version.startsWith("ffmpeg version ") || output.length < version.length || output.length > 128_000) {
    fail("CUT_AUDIO_CACHE_TOOLCHAIN", "FFmpeg did not provide one bounded implementation identity.");
  }
  const content = {
    format: toolchainFormat,
    version: 1 as const,
    runtime: environment.runtime ?? cutReferenceRuntimeIdentity,
    platform: environment.platform ?? process.platform,
    architecture: environment.architecture ?? process.arch,
    node: environment.node ?? process.version,
    ffmpeg: { version, identitySha256: hash(output) },
  };
  for (const [name, value] of Object.entries({ runtime: content.runtime, platform: content.platform, architecture: content.architecture, node: content.node })) {
    if (typeof value !== "string" || !value || value.length > 256 || /[\r\n\0]/u.test(value)) fail("CUT_AUDIO_CACHE_TOOLCHAIN", `${name} identity is missing or invalid.`);
  }
  return Object.freeze({ ...content, integrity: hash(content) });
}

let collectedToolchain: Promise<ReferenceAudioToolchainIdentity> | undefined;

export function collectReferenceAudioToolchainIdentity() {
  collectedToolchain ??= runFfmpegCapture(["-version"], 30_000).then(({ stdout }) => createReferenceAudioToolchainIdentity(stdout));
  return collectedToolchain;
}

function withoutEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEvidence);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (key === "provenance" || key === "contentHash" || item === undefined) return [];
      return [[key, withoutEvidence(item)]];
    }));
  }
  return value;
}

function selectedInputs(node: IRNode, names: readonly string[]) {
  return Object.fromEntries(names.flatMap((name) => node.inputs[name] === undefined ? [] : [[name, withoutEvidence(node.inputs[name])]]));
}

function packageIdentity(ir: CutAVIR, node: IRNode) {
  const pinned = [...ir.modules].sort((left, right) => right.specifier.length - left.specifier.length || left.specifier.localeCompare(right.specifier));
  const provenanceModules = [node.provenance.module, ...(node.provenance.expandedFrom ?? []).map((item) => item.module)];
  const provenanceSpecifiers = provenanceModules.map((source) => pinned.find((module) => source === module.specifier || source.startsWith(`${module.specifier}/`))?.specifier).filter((value): value is string => Boolean(value));
  const owner = packageSpecifierForNative(node.op);
  return [...new Set([...(owner ? [owner] : []), ...provenanceSpecifiers])].sort().map((specifier) => {
    const pinnedModule = ir.modules.find((candidate) => candidate.specifier === specifier);
    if (!pinnedModule) fail("CUT_AUDIO_CACHE_GRAPH", `Audio node ${node.id} references unpinned package ${specifier}.`);
    return pinnedModule;
  });
}

function nodeComposition(ir: CutAVIR, fallback: IRComposition, node: IRNode) {
  const sceneId = node.sceneId;
  if (sceneId) return ir.compositions.find((candidate) => candidate.sceneIds.includes(sceneId)) ?? fallback;
  return ir.compositions.find((candidate) => candidate.items.some((item) => item.kind === "node" && item.id === node.id)) ?? fallback;
}

function nestedAudioReferences(ir: CutAVIR, composition: IRComposition, node: IRNode) {
  if (node.op !== "cut.edit.nested_sequence") return nodeReferences(node);
  const owner = nodeComposition(ir, composition, node), config = referencePrecompConfig(ir, owner, node);
  if (!config || config.kind !== "av") fail("CUT_AUDIO_CACHE_GRAPH", `NestedSequence ${node.id} has no closed audiovisual source configuration.`);
  const source = ir.compositions.find((candidate) => candidate.id === config.sourceCompositionId);
  if (!source) fail("CUT_AUDIO_CACHE_GRAPH", `NestedSequence ${node.id} references missing source composition ${config.sourceCompositionId}.`);
  return [...nodeReferences(node), ...referenceAudioCompositionRootIds(ir, source)];
}

function audioExecutionIdentity(ir: CutAVIR, composition: IRComposition, node: IRNode) {
  const owner = nodeComposition(ir, composition, node);
  let execution: unknown;
  if (node.op === "cut.edit.clip") {
    execution = {
      kind: "linked-clip",
      inputs: selectedInputs(node, ["source", "range", "duration", "fadeIn", "fadeOut"]),
      audioExecution: referenceLinkedClipAudioExecutionPlan(ir, owner, node),
    };
  } else if (node.op === "cut.edit.transition") {
    const transition = referenceTransitionContract(ir, composition, node);
    execution = {
      kind: "audio-overlap-transition",
      outgoingNodeId: transition.outgoingNodeId,
      incomingNodeId: transition.incomingNodeId,
      overlapStart: transition.overlapStart,
      overlapDuration: transition.overlapDuration,
      parentStart: transition.parentStart,
      parentDuration: transition.parentDuration,
    };
  } else if (node.op === "cut.edit.jcut" || node.op === "cut.edit.lcut") {
    const split = referenceLinkedSplitContract(ir, composition, node);
    execution = {
      kind: "linked-split-audio-overlap",
      outgoingNodeId: split.outgoingNodeId,
      incomingNodeId: split.incomingNodeId,
      overlapStart: split.overlapStart,
      overlapDuration: split.overlapDuration,
      audioCut: split.audioCut,
      parentStart: split.parentStart,
      parentDuration: split.parentDuration,
    };
  } else if (node.op === "cut.edit.audio_track") {
    const editorial = node.editorial?.kind === "audio-track" ? { ...node.editorial } : node.editorial;
    if (editorial?.kind === "audio-track") delete editorial.operationPlan;
    execution = { kind: "audio-track", editorial: withoutEvidence(editorial) };
  } else if (node.op === "cut.edit.audio_gap") {
    execution = { kind: "audio-gap" };
  } else if (node.op === "cut.edit.audio_region") {
    // AudioRegion owns destination/link identity while its only child owns the
    // executable unary processor chain. The child hashes are projected
    // recursively, so changing one take's source or processing invalidates
    // only that region and its ancestors.
    execution = { kind: "processed-audio-region", inputs: withoutEvidence(cutExecutableNodeInputs(ir, node)) };
  } else if (node.op === cutTimelineAudioOriginOp) {
    // One immutable TimelineEdit origin owns the original direct/processed
    // source graph. Bind its generated owner identity and every authenticated
    // origin degree of freedom; the sole child digest binds source bytes and
    // processor implementation recursively.
    execution = {
      kind: "timeline-edit-audio-origin",
      originOwnerIdentity: hash({
        format: "cut-timeline-edit-audio-origin-owner",
        version: 1,
        nodeId: node.id,
      }),
      inputs: selectedInputs(node, cutTimelineAudioOriginInputs),
    };
  } else if (node.op === cutTimelineAudioViewOp) {
    // Views never evaluate or flatten the source graph themselves. Their
    // node-ref binds the immutable origin digest, while this closed projection
    // binds the exact segment/source/origin clocks, placement, link, and
    // authority fields that select samples from that one evaluation.
    execution = {
      kind: "timeline-edit-audio-view",
      segmentIdentity: hash({
        format: "cut-timeline-edit-audio-segment",
        version: 1,
        nodeId: node.id,
      }),
      destination: withoutEvidence(node.interval),
      inputs: selectedInputs(node, cutTimelineAudioViewInputs),
    };
  } else if (node.op === "cut.edit.nested_sequence") {
    const config = referencePrecompConfig(ir, owner, node);
    if (!config || config.kind !== "av") fail("CUT_AUDIO_CACHE_GRAPH", `NestedSequence ${node.id} has no closed audiovisual source configuration.`);
    const source = ir.compositions.find((candidate) => candidate.id === config.sourceCompositionId);
    if (!source) fail("CUT_AUDIO_CACHE_GRAPH", `NestedSequence ${node.id} references missing source composition ${config.sourceCompositionId}.`);
    execution = {
      kind: "nested-sequence-pre-master-root-mix",
      sourceDuration: source.duration,
      sourceSampleRate: source.sampleRate,
      sourceAudioRoots: referenceAudioCompositionRootIds(ir, source).length,
      sourceRange: config.sourceRange,
      selectedDuration: config.duration,
    };
  } else if (node.op === "cut.audio.synth") {
    execution = compileReferenceSynthPlan(ir, composition, node);
  } else if (node.op === "cut.audio.time_stretch") {
    const config = referenceAudioNodeConfig(ir, owner, node);
    if (!config || config.kind !== "time-stretch") fail("CUT_AUDIO_CACHE_GRAPH", `Audio artifact cache cannot project TimeStretch node ${node.id}.`);
    // audioRegionId is authorization/ownership evidence, not a downstream DSP
    // dependency. Hashing the ancestor ID as a node reference would create a
    // false Region -> TimeStretch -> Region cycle. Keep an explicit ownership
    // marker while the enclosing Region recursively owns this DSP identity.
    const { audioRegionId, ...dsp } = config;
    execution = audioRegionId === undefined ? dsp : { ...dsp, placementOwner: "audio-region" };
  } else if (["cut.kernel.fragment", "cut.audio.bus", "cut.audio.submix", "cut.audio.meter"].includes(node.op)) {
    // Names affect stems and Meter values affect post-cache mastering, but all
    // four kernels are transparent in the pre-master PCM artifact itself.
    execution = { kind: "transparent-mix" };
  } else {
    const config = referenceAudioNodeConfig(ir, owner, node);
    if (!config) fail("CUT_AUDIO_CACHE_GRAPH", `Audio artifact cache cannot project unsupported kernel ${node.op} at node ${node.id}.`);
    execution = config;
  }
  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  if (node.sceneId && !scene) fail("CUT_AUDIO_CACHE_GRAPH", `Audio node ${node.id} references missing scene ${node.sceneId}.`);
  const signals = Object.entries(node.properties).flatMap(([property, value]) => {
    if (!("signal" in value)) return [];
    const signal = ir.signals[value.signal];
    if (!signal) fail("CUT_AUDIO_CACHE_GRAPH", `Audio node ${node.id}.${property} references missing signal ${value.signal}.`);
    return [{ property, id: signal.id, sha256: cutSignalContentHash(signal) }];
  }).sort((left, right) => left.property.localeCompare(right.property));
  const staticProperties = Object.fromEntries(Object.entries(node.properties)
    .filter(([, value]) => !("signal" in value))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, value]) => [property, withoutEvidence(value)]));
  const projectedExecution = Object.keys(staticProperties).length
    ? { kernel: withoutEvidence(execution), staticProperties }
    : withoutEvidence(execution);
  return {
    id: node.id,
    op: node.op,
    domain: node.domain,
    interval: node.interval,
    ...(scene ? { scene: { id: scene.id, start: scene.start } } : {}),
    children: [...node.children],
    references: nestedAudioReferences(ir, composition, node).filter((id) => !node.children.includes(id)),
    execution: projectedExecution,
    signals,
    packages: packageIdentity(ir, node),
  };
}

function referencedResourceIds(node: IRNode, execution: unknown) {
  const result = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.kind === "resource-ref" && typeof record.id === "string") result.add(record.id);
      if (record.kind === "media-source" && typeof record.resourceId === "string") result.add(record.resourceId);
      Object.values(record).forEach(visit);
    }
  };
  visit(execution);
  if (node.op === "cut.edit.clip") visit(selectedInputs(node, ["source"]));
  return result;
}

function resourceExecutionIdentity(resource: CutAVIR["resources"][string]) {
  const projected = withoutEvidence(resource) as Record<string, unknown>;
  const projectedMetadata = projected.metadata as Record<string, unknown> | undefined;
  const sourceMetadata = resource.metadata as { activeMediaVariant?: unknown; audioProxyAlignment?: CutAudioProxyAlignment } | undefined;
  if (projectedMetadata && sourceMetadata?.activeMediaVariant === "proxy" && sourceMetadata.audioProxyAlignment) {
    projectedMetadata.audioProxyAlignment = cutAudioProxyExecutionIdentity(sourceMetadata.audioProxyAlignment);
  }
  // Picture correspondence authorizes which decoded frames a linked A/V proxy
  // may show; it cannot affect decoded samples. Keeping the pairwise master
  // picture witness here would spuriously invalidate a proxy audio cache after
  // a master-only picture revision.
  if (projectedMetadata) delete projectedMetadata.videoProxyAlignment;
  // Compiler-assigned IDs and source binding names are evidence, not decoder
  // inputs. Locator, byte hash, kind, lock state, and exact probe/selection
  // metadata remain part of the executable resource identity.
  delete projected.id;
  delete projected.name;
  return projected;
}

function canonicalExecutionReferences(
  value: unknown,
  currentNodeId: string,
  reachable: ReadonlySet<string>,
  nodeDigest: (id: string) => string,
  resourceDigests: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    if (value === currentNodeId) return "$self";
    if (reachable.has(value)) return { nodeSha256: nodeDigest(value) };
    const resource = resourceDigests.get(value);
    return resource === undefined ? value : { resourceSha256: resource };
  }
  if (Array.isArray(value)) return value.map((item) => canonicalExecutionReferences(item, currentNodeId, reachable, nodeDigest, resourceDigests));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, canonicalExecutionReferences(item, currentNodeId, reachable, nodeDigest, resourceDigests)]));
  }
  return value;
}

export function createReferenceAudioCachePlan(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  toolchain: ReferenceAudioToolchainIdentity,
  limiterCompatibilityToolchain?: ReferenceAudioLimiterCompatibilityToolchain,
): ReferenceAudioCachePlan {
  // The pre-master cache identifies terminal PCM rather than edit history, so
  // two different valid transactions may intentionally converge on one key.
  // That is never authority to skip validation: replay and correlate every
  // canonical TimelineEdit before executable graph projection, key
  // construction, filesystem allocation, or cache lookup so a forged plan
  // cannot reuse already-published PCM.
  validateReferenceTimelineEditMaterializations(ir);
  // Media-profile selection is process-authorized state. Reject serialized,
  // forged, or mutated activeMediaVariant markers before a cache key can make
  // them appear executable, including for audio-only graphs.
  assertReferenceMediaProfileExecutionState(ir);
  // Reject forged processed-region graphs before toolchain/cache identity is
  // considered. A warm artifact must never authorize semantics that direct
  // execution would refuse.
  validateReachableReferenceAudioRegionCrossfadePlans(ir, composition, rootIds);
  authorizeReachableReferenceAudioRegions(ir, composition, rootIds);
  const toolchainContent = { ...toolchain } as { integrity?: string };
  delete toolchainContent.integrity;
  if (toolchain.integrity !== hash(toolchainContent)) fail("CUT_AUDIO_CACHE_TOOLCHAIN", "Audio toolchain integrity does not match its canonical content.");
  assertCutGraphExecutionBudget(ir, rootIds);
  validateReferencePrecompGraph(ir, composition);
  const pending = [...rootIds], reachable = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    const node = ir.nodes[id];
    if (!node) fail("CUT_AUDIO_CACHE_GRAPH", `Audio root graph references missing node ${id}.`);
    if (node.domain !== "audio" && node.domain !== "av") fail("CUT_AUDIO_CACHE_GRAPH", `Audio root graph reaches non-audio kernel ${node.op} at node ${id}.`);
    reachable.add(id); pending.push(...nestedAudioReferences(ir, composition, node));
  }
  const nodes = [...reachable].sort().map((id) => audioExecutionIdentity(ir, composition, ir.nodes[id]));
  const limiterNodes = nodes.filter((node) => node.op === "cut.audio.limiter").length;
  if (limiterNodes > 0 && !isReferenceAudioLimiterCompatibilityToolchain(limiterCompatibilityToolchain)) {
    fail("CUT_AUDIO_CACHE_TOOLCHAIN", "Reachable Limiter execution requires one closed current compatibility-meter toolchain identity.");
  }
  const limiter = limiterNodes > 0 ? Object.freeze({
    nodes: limiterNodes,
    processor: referenceAudioLimiterIdentity,
    compatibilityPolicy: referenceAudioLimiterCompatibilityIdentity,
    toolchain: limiterCompatibilityToolchain!,
  }) : undefined;
  const resourceIds = new Set<string>();
  for (const identity of nodes) {
    const node = ir.nodes[identity.id];
    referencedResourceIds(node, identity.execution).forEach((id) => resourceIds.add(id));
  }
  const resourcesById = new Map([...resourceIds].sort().map((id) => {
    const resource = ir.resources[id];
    if (!resource) fail("CUT_AUDIO_CACHE_GRAPH", `Audio graph references missing resource ${id}.`);
    if (resource.state !== "locked" || !resource.sha256) fail("CUT_AUDIO_CACHE_GRAPH", `Audio graph resource ${id} is not byte-locked.`);
    return [id, resourceExecutionIdentity(resource)] as const;
  }));
  const resourceDigests = new Map([...resourcesById].map(([id, resource]) => [id, hash(resource)]));
  const resources = [...resourcesById.values()].sort((left, right) => hash(left).localeCompare(hash(right)));
  const corePackage = ir.modules.find((candidate) => candidate.specifier === "cut:core");
  if (!corePackage) fail("CUT_AUDIO_CACHE_GRAPH", "Audio artifact execution has no pinned cut:core runtime package.");
  // cut:core owns render dispatch and fingerprints this cache/runtime boundary,
  // including the silent-mix case where no @cut/audio source node exists.
  const packages = [...new Map([corePackage, ...nodes.flatMap((node) => node.packages)].map((pinnedModule) => [pinnedModule.specifier, pinnedModule])).values()].sort((left, right) => left.specifier.localeCompare(right.specifier));
  const identities = new Map(nodes.map((node) => [node.id, node])), digests = new Map<string, string>(), visiting = new Set<string>();
  const nodeDigest = (id: string): string => {
    const cached = digests.get(id);
    if (cached) return cached;
    if (visiting.has(id)) fail("CUT_AUDIO_CACHE_GRAPH", `Audio cache graph contains a cycle at ${id}.`);
    const identity = identities.get(id);
    if (!identity) fail("CUT_AUDIO_CACHE_GRAPH", `Audio cache graph references missing projected node ${id}.`);
    visiting.add(id);
    const content = {
      op: identity.op,
      domain: identity.domain,
      interval: identity.interval,
      ...(identity.scene ? { sceneStart: identity.scene.start } : {}),
      children: identity.children.map(nodeDigest),
      references: identity.references.map(nodeDigest),
      execution: canonicalExecutionReferences(identity.execution, id, reachable, nodeDigest, resourceDigests),
      signals: identity.signals.map(({ property, sha256 }) => ({ property, sha256 })),
      packages: identity.packages,
    };
    const digest = hash(content);
    visiting.delete(id); digests.set(id, digest); return digest;
  };
  const rootDigests = rootIds.map(nodeDigest), nodeDigests = nodes.map((node) => nodeDigest(node.id)).sort();
  const signalEntries = nodes.flatMap((node) => node.signals.map(({ property, sha256 }) => ({ nodeSha256: nodeDigest(node.id), property, sha256 }))).sort((left, right) => `${left.nodeSha256}\0${left.property}\0${left.sha256}`.localeCompare(`${right.nodeSha256}\0${right.property}\0${right.sha256}`));
  const samples = exactTotalSamples(composition);
  const roots = rootIds.map((id) => {
    const node = ir.nodes[id];
    if (!node) fail("CUT_AUDIO_CACHE_GRAPH", `Audio graph references missing root ${id}.`);
    return { id, op: node.op };
  });
  const nodesSha256 = hash(nodeDigests), signalsSha256 = hash(signalEntries), resourcesSha256 = hash(resources), packagesSha256 = hash(packages);
  const graphContent = {
    format: "cut-reference-audio-graph" as const,
    version: 3 as const,
    composition: { id: composition.id, duration: composition.duration, sampleRate: composition.sampleRate, channels: 2 as const, sampleFormat: "f32le" as const, samples },
    roots,
    reachableNodes: nodes.length,
    signals: signalEntries.length,
    resources: resources.length,
    packages: packages.length,
    nodesSha256,
    signalsSha256,
    resourcesSha256,
    packagesSha256,
    ...(limiter ? { limiter } : {}),
  };
  // Public evidence keeps source-level IDs for inspectability, but the cache
  // key deliberately hashes only recursive executable digests. An unrelated
  // picture insertion may renumber audio nodes without changing one sample.
  const semanticGraphContent = {
    format: graphContent.format,
    version: graphContent.version,
    composition: { duration: composition.duration, sampleRate: composition.sampleRate, channels: 2, sampleFormat: "f32le", samples },
    rootDigests,
    reachableNodes: nodes.length,
    signals: signalEntries.length,
    resources: resources.length,
    packages: packages.length,
    nodesSha256,
    signalsSha256,
    resourcesSha256,
    packagesSha256,
    ...(limiter ? { limiter } : {}),
  };
  const graph = Object.freeze({ ...graphContent, sha256: hash(semanticGraphContent) });
  const key = hash({ format: cacheFormat, version: cacheVersion, graphSha256: graph.sha256, toolchainIntegrity: toolchain.integrity });
  return { key, rootIds: [...rootIds], graph, toolchain };
}

async function sha256(path: string) {
  return new Promise<string>((accept, reject) => {
    const digest = createHash("sha256");
    createReadStream(path).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => accept(digest.digest("hex")));
  });
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function validLimiterEvidence(value: unknown, plan: ReferenceAudioCachePlan) {
  if (!isReferenceAudioLimiterBuildEvidence(value)) return false;
  const contract = plan.graph.limiter;
  if (!contract) return value.preparedExecutions === 0;
  if (value.preparedExecutions < contract.nodes) return false;
  return value.executions.every((execution) => execution.compatibility.status !== "verified-static"
    || execution.compatibility.passes.every((report) => report.toolchain.integrity === contract.toolchain.integrity));
}

function validManifest(value: unknown, plan: ReferenceAudioCachePlan): value is ReferenceAudioCacheManifest {
  if (!record(value) || value.format !== cacheFormat || value.version !== cacheVersion || value.key !== plan.key || value.runtime !== cutReferenceRuntimeIdentity || value.toolchainIntegrity !== plan.toolchain.integrity || value.graphSha256 !== plan.graph.sha256) return false;
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256) || value.bytes !== plan.graph.composition.samples * 8) return false;
  if (value.sampleRate !== plan.graph.composition.sampleRate || value.channels !== 2 || value.sampleFormat !== "f32le" || value.samples !== plan.graph.composition.samples) return false;
  if (!record(value.build) || !Number.isSafeInteger(value.build.roots) || !Number.isSafeInteger(value.build.filters) || (value.build.roots as number) < 0 || (value.build.filters as number) < 1) return false;
  if (!validLimiterEvidence(value.limiter, plan)) return false;
  return true;
}

async function inspectArtifact(target: string, plan: ReferenceAudioCachePlan): Promise<CachedArtifactInspection> {
  const manifestPath = resolve(target, "manifest.json"), artifact = resolve(target, "mix.f32le");
  let manifestMetadata, artifactMetadata;
  try {
    [manifestMetadata, artifactMetadata] = await Promise.all([lstat(manifestPath), lstat(artifact)]);
  } catch {
    return { status: "miss", reason: "CUT_AUDIO_CACHE_ARTIFACT_MISSING" };
  }
  if (!manifestMetadata.isFile() || !artifactMetadata.isFile()) return { status: "miss", reason: "CUT_AUDIO_CACHE_MANIFEST_INVALID" };
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { return { status: "miss", reason: "CUT_AUDIO_CACHE_MANIFEST_INVALID" }; }
  if (!validManifest(parsed, plan)) return { status: "miss", reason: "CUT_AUDIO_CACHE_MANIFEST_INVALID" };
  if (artifactMetadata.size !== parsed.bytes || await sha256(artifact) !== parsed.sha256) return { status: "miss", reason: "CUT_AUDIO_CACHE_ARTIFACT_CORRUPT" };
  return { status: "hit", manifest: parsed };
}

async function inspectArtifactPresence(target: string): Promise<
  | { status: "present" }
  | {
    status: "miss";
    reason:
      | "CUT_AUDIO_CACHE_ARTIFACT_MISSING"
      | "CUT_AUDIO_CACHE_MANIFEST_INVALID"
      | "CUT_AUDIO_CACHE_ARTIFACT_CORRUPT"
      | "CUT_AUDIO_CACHE_ARTIFACT_CONTRACT";
  }
> {
  try {
    const [manifestMetadata, artifactMetadata] = await Promise.all([
      lstat(resolve(target, "manifest.json")),
      lstat(resolve(target, "mix.f32le")),
    ]);
    if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
      return { status: "miss", reason: "CUT_AUDIO_CACHE_MANIFEST_INVALID" };
    }
    if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isFile()) {
      return { status: "miss", reason: "CUT_AUDIO_CACHE_ARTIFACT_CORRUPT" };
    }
    return { status: "present" };
  } catch (error) {
    return {
      status: "miss",
      reason: isMissingSystemError(error)
        ? "CUT_AUDIO_CACHE_ARTIFACT_MISSING"
        : "CUT_AUDIO_CACHE_ARTIFACT_CONTRACT",
    };
  }
}

async function previousKey(audioRoot: string, compositionId: string) {
  const path = resolve(audioRoot, `composition-${hash(compositionId)}.json`);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) return undefined;
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (record(parsed) && parsed.format === "cut-reference-audio-cache-index" && parsed.version === 1 && parsed.compositionId === compositionId && typeof parsed.key === "string" && /^[a-f0-9]{64}$/u.test(parsed.key)) return parsed.key;
  } catch { /* A missing or malformed advisory index cannot authorize reuse. */ }
  return undefined;
}

async function previousKeyBound(audioRoot: string, compositionId: string) {
  const path = resolve(audioRoot, `composition-${hash(compositionId)}.json`);
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissingSystemError(error)) return undefined;
    throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size < 1n
    || metadata.size > 65_536n
  ) {
    throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  }
  const bound = await boundDirectFile(
    path,
    "CUT_AUDIO_CACHE_ARTIFACT_CONTRACT",
    Number(metadata.size),
    65_536,
  );
  try {
    const text = await bound.handle.readFile({ encoding: "utf8" });
    await verifyBoundDirectFile(path, bound, "CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (
      record(parsed)
      && parsed.format === "cut-reference-audio-cache-index"
      && parsed.version === 1
      && parsed.compositionId === compositionId
      && typeof parsed.key === "string"
      && /^[a-f0-9]{64}$/u.test(parsed.key)
    ) {
      return parsed.key;
    }
    return undefined;
  } finally {
    await bound.handle.close().catch(() => undefined);
  }
}

async function writeIndex(audioRoot: string, compositionId: string, key: string) {
  await atomicWriteFile(resolve(audioRoot, `composition-${hash(compositionId)}.json`), `${stableJsonStringify({ format: "cut-reference-audio-cache-index", version: 1, compositionId, key })}\n`);
}

function evidence(
  plan: ReferenceAudioCachePlan,
  manifest: ReferenceAudioCacheManifest,
  peak: ReferenceAudioPeakScan,
  status: "hit" | "miss",
  reason: ReferenceAudioCacheReason,
  previous?: string,
): ReferenceAudioCacheEvidence {
  return Object.freeze({
    format: evidenceFormat,
    version: 3,
    stage: "pre-master-f32le",
    status,
    reason,
    key: plan.key,
    ...(previous === undefined ? {} : { previousKey: previous }),
    artifact: Object.freeze({
      locator: `.cut/cache/reference/audio/${plan.key}/mix.f32le`,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      sampleRate: manifest.sampleRate,
      channels: 2 as const,
      sampleFormat: "f32le" as const,
      samples: manifest.samples,
      verification: "sha256+exact-f32le+sample-peak" as const,
    }),
    peak,
    limiter: manifest.limiter,
    identity: Object.freeze({ runtime: cutReferenceRuntimeIdentity, toolchain: plan.toolchain, graph: plan.graph }),
  });
}

export type ReferenceAudioArtifactOptions = Readonly<{
  /** Post-mix sample ceiling. It is deliberately not part of the PCM cache key. */
  samplePeakDbfs?: number;
  /** Source location attached to a clipping/non-finite/structure diagnostic. */
  source?: ReferenceAudioPeakSource;
  /** @internal One invocation-scoped verified snapshot resolver. */
  __verifiedResourcePath?: ReferenceVerifiedInputSession["pathFor"];
}>;

export type ReferenceAudioCacheSliceEvidence = Readonly<{
  format: "cut-reference-audio-cache-slice";
  version: 1;
  semantics: "half-open";
  startSample: number;
  endSampleExclusive: number;
  samples: number;
  byteStart: number;
  byteEndExclusive: number;
  bytes: number;
  sha256: string;
  verification: "no-follow+path-handle-identity+full-sha256+exact-f32le+slice-sha256";
}>;

type ReferenceAudioCacheSelectionCommon = Readonly<{
  format: "cut-reference-audio-cache-selection";
  version: 1;
  key: string;
  sampleRange: {
    semantics: "half-open";
    startSample: number;
    endSampleExclusive: number;
    samples: number;
  };
  identity: {
    runtime: string;
    toolchain: ReferenceAudioToolchainIdentity;
    graph: ReferenceAudioGraphIdentity;
  };
}>;

export type ReferenceAudioCacheSelectionEvidence =
  | (ReferenceAudioCacheSelectionCommon & Readonly<{
    status: "hit";
    mode: "full-program-cache-slice";
    cache: ReferenceAudioCacheEvidence;
    slice: ReferenceAudioCacheSliceEvidence;
  }>)
  | (ReferenceAudioCacheSelectionCommon & Readonly<{
    status: "miss";
    mode: "selected-execution";
    reason: Exclude<ReferenceAudioCacheReason, "CUT_AUDIO_CACHE_HIT">;
    previousKey?: string;
  }>);

export type ReferenceAudioCachedSelectionOptions = ReferenceAudioArtifactOptions & Readonly<{
  sampleRange: Readonly<{ start: number; end: number }>;
  output: string;
  /** @internal Deterministic filesystem-race injection for focused tests. */
  __testHooks?: ReferenceAudioCacheSelectionTestHooks;
}>;

export type ReferenceAudioCacheSelectionTestHooks = Readonly<{
  afterOutputBoundaryBound?: () => void | Promise<void>;
  afterCacheBoundaryBound?: () => void | Promise<void>;
  beforeArtifactPresence?: () => void | Promise<void>;
}>;

export type ReferenceAudioCachedSelectionResult =
  | Readonly<{
    status: "hit";
    path: string;
    build: { roots: number; filters: number };
    evidence: Extract<ReferenceAudioCacheSelectionEvidence, { status: "hit" }>;
  }>
  | Readonly<{
    status: "miss";
    evidence: Extract<ReferenceAudioCacheSelectionEvidence, { status: "miss" }>;
  }>;

class ReferenceAudioCacheSelectionMiss extends Error {
  constructor(readonly reason: Exclude<ReferenceAudioCacheReason, "CUT_AUDIO_CACHE_HIT">) {
    super(reason);
    this.name = "ReferenceAudioCacheSelectionMiss";
  }
}

type DirectFileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type BoundDirectFile = Readonly<{
  handle: FileHandle;
  identity: DirectFileIdentity;
}>;

type BoundDirectory = Readonly<{
  path: string;
  handle: FileHandle;
  identity: DirectFileIdentity;
}>;

type BoundDirectoryChain = Readonly<{
  root: string;
  target: string;
  directories: readonly BoundDirectory[];
}>;

const maximumCacheManifestBytes = 4 * 1_024 * 1_024;
const maximumCacheBoundaryDirectories = 128;

function directFileIdentity(metadata: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): DirectFileIdentity {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameDirectFile(left: DirectFileIdentity, right: DirectFileIdentity) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameDirectDirectory(left: DirectFileIdentity, right: DirectFileIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissingSystemError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function closeDirectoryChain(chain: BoundDirectoryChain | undefined) {
  if (!chain) return;
  await Promise.all(chain.directories.map((directory) => directory.handle.close().catch(() => undefined)));
}

async function bindDirectoryChain(root: string, target: string): Promise<
  | { status: "bound"; chain: BoundDirectoryChain }
  | { status: "missing" }
> {
  if (!pathInside(root, target)) {
    throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  }
  const local = relative(root, target);
  const parts = local === "" ? [] : local.split(sep);
  if (parts.length + 1 > maximumCacheBoundaryDirectories) {
    throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  }
  const paths = [root];
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    paths.push(current);
  }
  const directories: BoundDirectory[] = [];
  try {
    for (const path of paths) {
      let pathMetadata;
      try {
        pathMetadata = await lstat(path, { bigint: true });
      } catch (error) {
        if (isMissingSystemError(error)) {
          await closeDirectoryChain({ root, target, directories });
          return { status: "missing" };
        }
        throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
      }
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isDirectory()) {
        throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
      }
      if (typeof fsConstants.O_NOFOLLOW !== "number") {
        throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
      }
      let handle: FileHandle | undefined;
      try {
        const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
        handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | directoryFlag);
        const handleMetadata = await handle.stat({ bigint: true });
        const pathIdentity = directFileIdentity(pathMetadata);
        const handleIdentity = directFileIdentity(handleMetadata);
        if (!handleMetadata.isDirectory() || !sameDirectDirectory(pathIdentity, handleIdentity)) {
          throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
        }
        directories.push(Object.freeze({ path, handle, identity: handleIdentity }));
        handle = undefined;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    return {
      status: "bound",
      chain: Object.freeze({ root, target, directories: Object.freeze([...directories]) }),
    };
  } catch (error) {
    await closeDirectoryChain({ root, target, directories });
    if (error instanceof ReferenceAudioCacheSelectionMiss) throw error;
    throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  }
}

async function verifyDirectoryChain(chain: BoundDirectoryChain) {
  try {
    for (const directory of chain.directories) {
      const [handleMetadata, pathMetadata] = await Promise.all([
        directory.handle.stat({ bigint: true }),
        lstat(directory.path, { bigint: true }),
      ]);
      if (
        pathMetadata.isSymbolicLink()
        || !handleMetadata.isDirectory()
        || !pathMetadata.isDirectory()
        || !sameDirectDirectory(directory.identity, directFileIdentity(handleMetadata))
        || !sameDirectDirectory(directory.identity, directFileIdentity(pathMetadata))
      ) {
        throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
      }
    }
  } catch (error) {
    if (error instanceof ReferenceAudioCacheSelectionMiss) throw error;
    throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  }
}

async function verifyOutputDirectoryChain(chain: BoundDirectoryChain) {
  try {
    await verifyDirectoryChain(chain);
  } catch {
    fail("CUT_AUDIO_CACHE_SELECTION", "selected cache-slice output ancestry changed during the exact operation.");
  }
}

async function boundDirectFile(
  path: string,
  reason: Exclude<ReferenceAudioCacheReason, "CUT_AUDIO_CACHE_HIT">,
  expectedBytes?: number,
  maximumBytes?: number,
): Promise<BoundDirectFile> {
  let handle: FileHandle | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
    }
    const pathMetadata = await lstat(path, { bigint: true });
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
      throw new ReferenceAudioCacheSelectionMiss(reason);
    }
    if (expectedBytes !== undefined && pathMetadata.size !== BigInt(expectedBytes)) {
      throw new ReferenceAudioCacheSelectionMiss(reason);
    }
    if (maximumBytes !== undefined && (pathMetadata.size < 1n || pathMetadata.size > BigInt(maximumBytes))) {
      throw new ReferenceAudioCacheSelectionMiss(reason);
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const handleMetadata = await handle.stat({ bigint: true });
    const pathIdentity = directFileIdentity(pathMetadata);
    const handleIdentity = directFileIdentity(handleMetadata);
    if (!handleMetadata.isFile() || !sameDirectFile(pathIdentity, handleIdentity)) {
      throw new ReferenceAudioCacheSelectionMiss(reason);
    }
    return Object.freeze({ handle, identity: handleIdentity });
  } catch (error) {
    if (error instanceof ReferenceAudioCacheSelectionMiss) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
    await handle?.close().catch(() => undefined);
    throw new ReferenceAudioCacheSelectionMiss(reason);
  }
}

async function verifyBoundDirectFile(path: string, bound: BoundDirectFile, reason: Exclude<ReferenceAudioCacheReason, "CUT_AUDIO_CACHE_HIT">) {
  try {
    const handleMetadata = await bound.handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    if (
      pathMetadata.isSymbolicLink()
      || !handleMetadata.isFile()
      || !pathMetadata.isFile()
      || !sameDirectFile(bound.identity, directFileIdentity(handleMetadata))
      || !sameDirectFile(bound.identity, directFileIdentity(pathMetadata))
    ) {
      throw new ReferenceAudioCacheSelectionMiss(reason);
    }
  } catch (error) {
    if (error instanceof ReferenceAudioCacheSelectionMiss) throw error;
    throw new ReferenceAudioCacheSelectionMiss(reason);
  }
}

function cacheSelectionRange(plan: ReferenceAudioCachePlan, authored: Readonly<{ start: number; end: number }>) {
  const { start, end } = authored;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end <= start
    || end > plan.graph.composition.samples
  ) {
    fail(
      "CUT_AUDIO_CACHE_SELECTION",
      `sampleRange must be one non-empty half-open interval inside [0, ${plan.graph.composition.samples}); received ${String(start)}:${String(end)}.`,
    );
  }
  const samples = end - start;
  const byteStart = start * referenceAudioPeakLimits.bytesPerFrame;
  const byteEndExclusive = end * referenceAudioPeakLimits.bytesPerFrame;
  const bytes = samples * referenceAudioPeakLimits.bytesPerFrame;
  if (
    !Number.isSafeInteger(byteStart)
    || !Number.isSafeInteger(byteEndExclusive)
    || !Number.isSafeInteger(bytes)
  ) {
    fail("CUT_AUDIO_CACHE_SELECTION", "sampleRange does not reduce to one bounded exact stereo f32le byte interval.");
  }
  return Object.freeze({ start, end, samples, byteStart, byteEndExclusive, bytes });
}

function cacheSelectionCommon(plan: ReferenceAudioCachePlan, range: ReturnType<typeof cacheSelectionRange>): ReferenceAudioCacheSelectionCommon {
  return Object.freeze({
    format: "cut-reference-audio-cache-selection",
    version: 1,
    key: plan.key,
    sampleRange: Object.freeze({
      semantics: "half-open",
      startSample: range.start,
      endSampleExclusive: range.end,
      samples: range.samples,
    }),
    identity: Object.freeze({
      runtime: cutReferenceRuntimeIdentity,
      toolchain: plan.toolchain,
      graph: plan.graph,
    }),
  });
}

function cacheSelectionMissEvidence(
  plan: ReferenceAudioCachePlan,
  range: ReturnType<typeof cacheSelectionRange>,
  reason: Exclude<ReferenceAudioCacheReason, "CUT_AUDIO_CACHE_HIT">,
  prior?: string,
): Extract<ReferenceAudioCacheSelectionEvidence, { status: "miss" }> {
  return Object.freeze({
    ...cacheSelectionCommon(plan, range),
    status: "miss",
    mode: "selected-execution",
    reason,
    ...(prior === undefined ? {} : { previousKey: prior }),
  });
}

function writeAllAt(handle: FileHandle, bytes: Uint8Array, position: number) {
  return (async () => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
      if (bytesWritten < 1) fail("CUT_AUDIO_CACHE_SELECTION", "CUT could not complete the selected cache-slice output.");
      offset += bytesWritten;
    }
  })();
}

async function readBoundManifest(path: string, plan: ReferenceAudioCachePlan) {
  const bound = await boundDirectFile(
    path,
    "CUT_AUDIO_CACHE_MANIFEST_INVALID",
    undefined,
    maximumCacheManifestBytes,
  );
  try {
    const text = await bound.handle.readFile({ encoding: "utf8" });
    await verifyBoundDirectFile(path, bound, "CUT_AUDIO_CACHE_MANIFEST_INVALID");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_MANIFEST_INVALID");
    }
    if (!validManifest(parsed, plan)) {
      throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_MANIFEST_INVALID");
    }
    return parsed;
  } finally {
    await bound.handle.close().catch(() => undefined);
  }
}

async function copyVerifiedCacheSlice(
  artifactPath: string,
  output: string,
  manifest: ReferenceAudioCacheManifest,
  plan: ReferenceAudioCachePlan,
  range: ReturnType<typeof cacheSelectionRange>,
  composition: IRComposition,
  options: ReferenceAudioArtifactOptions,
  cacheBoundary: BoundDirectoryChain,
  outputBoundary: BoundDirectoryChain,
) {
  await verifyDirectoryChain(cacheBoundary);
  await verifyOutputDirectoryChain(outputBoundary);
  const input = await boundDirectFile(
    artifactPath,
    "CUT_AUDIO_CACHE_ARTIFACT_CORRUPT",
    manifest.bytes,
  );
  let outputHandle: FileHandle | undefined;
  let outputCreated = false;
  let shouldRemoveOutput = true;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
    }
    try {
      outputHandle = await open(
        output,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      outputCreated = true;
    } catch (error) {
      fail("CUT_AUDIO_CACHE_SELECTION", `CUT could not reserve the selected cache-slice output (${systemCode(error)}).`);
    }
    const fullDigest = createHash("sha256");
    const sliceDigest = createHash("sha256");
    let position = 0;
    let slicePosition = 0;
    const chunks = async function* () {
      const buffer = Buffer.allocUnsafe(Math.min(referenceAudioPeakLimits.fileReadChunkBytes, manifest.bytes));
      while (position < manifest.bytes) {
        const requested = Math.min(buffer.byteLength, manifest.bytes - position);
        const { bytesRead } = await input.handle.read(buffer, 0, requested, position);
        if (bytesRead !== requested) {
          throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CORRUPT");
        }
        const chunk = buffer.subarray(0, bytesRead);
        fullDigest.update(chunk);
        const overlapStart = Math.max(position, range.byteStart);
        const overlapEnd = Math.min(position + bytesRead, range.byteEndExclusive);
        if (overlapEnd > overlapStart) {
          const selected = chunk.subarray(overlapStart - position, overlapEnd - position);
          sliceDigest.update(selected);
          await writeAllAt(outputHandle!, selected, slicePosition);
          slicePosition += selected.byteLength;
        }
        position += bytesRead;
        yield chunk;
      }
    };
    let peak: ReferenceAudioPeakScan;
    try {
      peak = await scanReferenceStereoF32Le(chunks(), {
        expectedFrames: plan.graph.composition.samples,
        thresholdDbfs: options.samplePeakDbfs,
        source: options.source ?? defaultPeakSource(composition),
      });
    } catch (error) {
      if (error instanceof ReferenceAudioPeakError) {
        throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
      }
      throw error;
    }
    if (
      position !== manifest.bytes
      || slicePosition !== range.bytes
      || fullDigest.digest("hex") !== manifest.sha256
    ) {
      throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CORRUPT");
    }
    await verifyBoundDirectFile(artifactPath, input, "CUT_AUDIO_CACHE_ARTIFACT_CORRUPT");
    await outputHandle.sync();
    const outputMetadata = await outputHandle.stat({ bigint: true });
    let outputPathMetadata;
    try {
      outputPathMetadata = await lstat(output, { bigint: true });
    } catch (error) {
      fail("CUT_AUDIO_CACHE_SELECTION", `CUT could not revalidate the selected cache-slice output (${systemCode(error)}).`);
    }
    if (
      !outputMetadata.isFile()
      || outputMetadata.size !== BigInt(range.bytes)
      || outputPathMetadata.isSymbolicLink()
      || !outputPathMetadata.isFile()
      || !sameDirectFile(directFileIdentity(outputMetadata), directFileIdentity(outputPathMetadata))
    ) {
      fail("CUT_AUDIO_CACHE_SELECTION", "selected cache-slice output path and open handle no longer identify the same exact file.");
    }
    await verifyDirectoryChain(cacheBoundary);
    await verifyOutputDirectoryChain(outputBoundary);
    try {
      await outputHandle.close();
      outputHandle = undefined;
    } catch (error) {
      fail("CUT_AUDIO_CACHE_SELECTION", `CUT could not close the selected cache-slice output (${systemCode(error)}).`);
    }
    const slice: ReferenceAudioCacheSliceEvidence = Object.freeze({
      format: "cut-reference-audio-cache-slice",
      version: 1,
      semantics: "half-open",
      startSample: range.start,
      endSampleExclusive: range.end,
      samples: range.samples,
      byteStart: range.byteStart,
      byteEndExclusive: range.byteEndExclusive,
      bytes: range.bytes,
      sha256: sliceDigest.digest("hex"),
      verification: "no-follow+path-handle-identity+full-sha256+exact-f32le+slice-sha256",
    });
    shouldRemoveOutput = false;
    return { peak, slice };
  } finally {
    await input.handle.close().catch(() => undefined);
    await outputHandle?.close().catch(() => undefined);
    if (shouldRemoveOutput && outputCreated) await rm(output, { force: true }).catch(() => undefined);
  }
}

function systemCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)) {
    return error.code;
  }
  return "UNKNOWN";
}

function pathInside(root: string, target: string) {
  const local = relative(root, target);
  return local === "" || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
}

async function canonicalSelectionOutput(projectRoot: string, authoredOutput: string) {
  try {
    const canonicalProject = await realpath(projectRoot);
    const lexicalProject = resolve(projectRoot);
    const lexicalOutput = resolve(authoredOutput);
    let output: string;
    if (pathInside(lexicalProject, lexicalOutput)) {
      output = resolve(canonicalProject, relative(lexicalProject, lexicalOutput));
    } else {
      const canonicalParent = await realpath(dirname(lexicalOutput));
      output = resolve(canonicalParent, basename(authoredOutput));
    }
    const audioRoot = resolve(canonicalProject, ".cut/cache/reference/audio");
    if (!pathInside(canonicalProject, output) || pathInside(audioRoot, output)) {
      fail("CUT_AUDIO_CACHE_SELECTION", "selected cache-slice output must remain inside the project and outside the immutable full-program cache.");
    }
    return Object.freeze({ canonicalProject, audioRoot, output });
  } catch (error) {
    if (error instanceof ReferenceAudioCacheError) throw error;
    fail("CUT_AUDIO_CACHE_SELECTION", `CUT could not bind the selected cache-slice output parent (${systemCode(error)}).`);
  }
}

/**
 * Reuse an already-published exact full-program pre-master cache artifact for
 * one selected half-open sample interval. This probe is read-only with respect
 * to the full-program cache: a miss, invalidation, or corrupt artifact never
 * triggers a whole-program render or cache publication.
 */
export async function readReferenceAudioSelectionFromCache(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  options: ReferenceAudioCachedSelectionOptions,
): Promise<ReferenceAudioCachedSelectionResult> {
  const rootIds = referenceMasterAudioRootIds(ir, composition);
  validateReachableReferenceAudioRegionCrossfadePlans(ir, composition, rootIds);
  validateReferenceLinkedEditTransactions(ir, composition);
  authorizeReachableReferenceAudioRegions(ir, composition, rootIds);
  const toolchain = await collectReferenceAudioToolchainIdentity();
  const limiterCompatibilityToolchain = hasReachableLimiter(ir, composition, rootIds)
    ? await collectReferenceAudioLimiterCompatibilityToolchain()
    : undefined;
  const plan = createReferenceAudioCachePlan(ir, composition, rootIds, toolchain, limiterCompatibilityToolchain);
  const range = cacheSelectionRange(plan, options.sampleRange);
  const { canonicalProject, audioRoot, output } = await canonicalSelectionOutput(projectRoot, options.output);
  let outputBinding: Awaited<ReturnType<typeof bindDirectoryChain>>;
  try {
    outputBinding = await bindDirectoryChain(canonicalProject, dirname(output));
  } catch {
    fail("CUT_AUDIO_CACHE_SELECTION", "selected cache-slice output parent must be one stable direct project directory.");
  }
  if (outputBinding.status === "missing") {
    fail("CUT_AUDIO_CACHE_SELECTION", "selected cache-slice output parent does not exist as one direct project directory.");
  }
  let audioBoundary: BoundDirectoryChain | undefined;
  let cacheBoundary: BoundDirectoryChain | undefined;
  try {
    try {
      await options.__testHooks?.afterOutputBoundaryBound?.();
    } catch (error) {
      fail("CUT_AUDIO_CACHE_SELECTION", `selected cache-slice output-boundary hook failed (${systemCode(error)}).`);
    }
    await verifyOutputDirectoryChain(outputBinding.chain);
    const audioBinding = await bindDirectoryChain(canonicalProject, audioRoot);
    if (audioBinding.status === "missing") {
      return Object.freeze({
        status: "miss",
        evidence: cacheSelectionMissEvidence(plan, range, "CUT_AUDIO_CACHE_COLD"),
      });
    }
    audioBoundary = audioBinding.chain;
    const prior = await previousKeyBound(audioRoot, composition.id);
    await verifyDirectoryChain(audioBoundary);
    const target = resolve(audioRoot, plan.key);
    const cacheBinding = await bindDirectoryChain(canonicalProject, target);
    if (cacheBinding.status === "missing") {
      const reason = prior === undefined
        ? "CUT_AUDIO_CACHE_COLD"
        : prior === plan.key
          ? "CUT_AUDIO_CACHE_ARTIFACT_MISSING"
          : "CUT_AUDIO_CACHE_KEY_CHANGED";
      await verifyDirectoryChain(audioBoundary);
      return Object.freeze({ status: "miss", evidence: cacheSelectionMissEvidence(plan, range, reason, prior) });
    }
    cacheBoundary = cacheBinding.chain;
    try {
      await options.__testHooks?.afterCacheBoundaryBound?.();
      await verifyDirectoryChain(audioBoundary);
      await verifyDirectoryChain(cacheBoundary);
      await options.__testHooks?.beforeArtifactPresence?.();
    } catch (error) {
      if (error instanceof ReferenceAudioCacheSelectionMiss) throw error;
      throw new ReferenceAudioCacheSelectionMiss("CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
    }
    const presence = await inspectArtifactPresence(target);
    await verifyDirectoryChain(audioBoundary);
    await verifyDirectoryChain(cacheBoundary);
    if (presence.status === "miss") {
      const reason = presence.reason === "CUT_AUDIO_CACHE_ARTIFACT_MISSING"
        ? prior === undefined
          ? "CUT_AUDIO_CACHE_COLD"
          : prior === plan.key
            ? "CUT_AUDIO_CACHE_ARTIFACT_MISSING"
            : "CUT_AUDIO_CACHE_KEY_CHANGED"
        : presence.reason;
      return Object.freeze({ status: "miss", evidence: cacheSelectionMissEvidence(plan, range, reason, prior) });
    }
    const manifestPath = resolve(target, "manifest.json");
    const artifactPath = resolve(target, "mix.f32le");
    const manifest = await readBoundManifest(manifestPath, plan);
    const { peak, slice } = await copyVerifiedCacheSlice(
      artifactPath,
      output,
      manifest,
      plan,
      range,
      composition,
      options,
      cacheBoundary,
      outputBinding.chain,
    );
    const fullCache = evidence(plan, manifest, peak, "hit", "CUT_AUDIO_CACHE_HIT", prior);
    const selectionEvidence: Extract<ReferenceAudioCacheSelectionEvidence, { status: "hit" }> = Object.freeze({
      ...cacheSelectionCommon(plan, range),
      status: "hit",
      mode: "full-program-cache-slice",
      cache: fullCache,
      slice,
    });
    return Object.freeze({
      status: "hit",
      path: output,
      build: manifest.build,
      evidence: selectionEvidence,
    });
  } catch (error) {
    if (error instanceof ReferenceAudioCacheSelectionMiss) {
      return Object.freeze({
        status: "miss",
        evidence: cacheSelectionMissEvidence(plan, range, error.reason),
      });
    }
    throw error;
  } finally {
    await Promise.all([
      closeDirectoryChain(cacheBoundary),
      closeDirectoryChain(audioBoundary),
      closeDirectoryChain(outputBinding.chain),
    ]);
  }
}

function defaultPeakSource(composition: IRComposition): ReferenceAudioPeakSource {
  return Object.freeze({
    module: composition.provenance.module,
    line: composition.provenance.span.start.line,
    column: composition.provenance.span.start.column,
    nodeId: composition.id,
  });
}

function scanArtifact(
  path: string,
  plan: ReferenceAudioCachePlan,
  composition: IRComposition,
  options: ReferenceAudioArtifactOptions,
) {
  return scanReferenceStereoF32LeFile(path, {
    expectedFrames: plan.graph.composition.samples,
    thresholdDbfs: options.samplePeakDbfs,
    source: options.source ?? defaultPeakSource(composition),
  });
}

function hasReachableLimiter(ir: CutAVIR, composition: IRComposition, rootIds: readonly string[]) {
  const pending = [...rootIds], visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) fail("CUT_AUDIO_CACHE_GRAPH", `Audio root graph references missing node ${id}.`);
    if (node.op === "cut.audio.limiter") return true;
    pending.push(...nestedAudioReferences(ir, composition, node));
  }
  return false;
}

/**
 * Materialize or reuse the exact pre-master stereo PCM artifact for one
 * composition. Final loudness normalization, delivery encoding, and stems are
 * intentionally downstream and are not claimed as cached by this boundary.
 */
export async function renderReferenceAudioArtifact(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  options: ReferenceAudioArtifactOptions = {},
) {
  // A cache key identifies executed PCM, not the compiler operation history
  // that authorized it. Corrupting a linked transaction can therefore leave
  // the projected PCM key unchanged. Close both picture/audio sides before
  // executable graph projection, cache lookup, or filesystem allocation so a
  // warm artifact can never launder a forged one-sided edit plan.
  const rootIds = referenceMasterAudioRootIds(ir, composition);
  validateReachableReferenceAudioRegionCrossfadePlans(ir, composition, rootIds);
  validateReferenceLinkedEditTransactions(ir, composition);
  authorizeReachableReferenceAudioRegions(ir, composition, rootIds);
  const toolchain = await collectReferenceAudioToolchainIdentity();
  const limiterCompatibilityToolchain = hasReachableLimiter(ir, composition, rootIds)
    ? await collectReferenceAudioLimiterCompatibilityToolchain()
    : undefined;
  const plan = createReferenceAudioCachePlan(ir, composition, rootIds, toolchain, limiterCompatibilityToolchain);
  const audioRoot = await ensureProjectWriteDirectory(projectRoot, ".cut/cache/reference/audio");
  const target = await ensureProjectWriteDirectory(projectRoot, `.cut/cache/reference/audio/${plan.key}`);
  const prior = await previousKey(audioRoot, composition.id), inspected = await inspectArtifact(target, plan);
  if (inspected.status === "hit") {
    // The Meter sample-peak target is a post-cache assertion, so it cannot
    // invalidate identical PCM. Re-scan every invocation: a stricter target
    // must never inherit a looser render's authorization.
    const path = resolve(target, "mix.f32le");
    const peak = await scanArtifact(path, plan, composition, options);
    await writeIndex(audioRoot, composition.id, plan.key);
    return { path, build: inspected.manifest.build, cache: evidence(plan, inspected.manifest, peak, "hit", "CUT_AUDIO_CACHE_HIT", prior) };
  }
  const missReason = inspected.reason === "CUT_AUDIO_CACHE_ARTIFACT_MISSING"
    ? prior === undefined ? "CUT_AUDIO_CACHE_COLD" : prior === plan.key ? "CUT_AUDIO_CACHE_ARTIFACT_MISSING" : "CUT_AUDIO_CACHE_KEY_CHANGED"
    : inspected.reason;
  const staging = await mkdtemp(resolve(target, ".cut-audio-")), temporary = resolve(staging, "mix.f32le");
  try {
    const build = await renderReferenceAudioSelection(ir, composition, projectRoot, temporary, rootIds, {
      outputFormat: "raw-stereo-f32le",
      __verifiedResourcePath: options.__verifiedResourcePath,
    });
    // Scan before publication. Clipping, non-finite samples, truncation, or
    // any structural failure leaves neither a cache artifact nor manifest.
    const peak = await scanArtifact(temporary, plan, composition, options), digest = await sha256(temporary);
    const manifest: ReferenceAudioCacheManifest = {
      format: cacheFormat,
      version: cacheVersion,
      key: plan.key,
      runtime: cutReferenceRuntimeIdentity,
      toolchainIntegrity: plan.toolchain.integrity,
      graphSha256: plan.graph.sha256,
      sha256: digest,
      bytes: peak.observedBytes,
      sampleRate: composition.sampleRate,
      channels: 2,
      sampleFormat: "f32le",
      samples: plan.graph.composition.samples,
      build: { roots: build.roots, filters: build.filters },
      limiter: build.limiter,
    };
    // The compatibility executable is snapshotted before the cache key is
    // derived and again by every static limiter measurement. Refuse to
    // publish if it changed during this invocation: otherwise the artifact
    // would be stored under an identity that did not authorize its samples.
    if (!validLimiterEvidence(manifest.limiter, plan)) {
      fail("CUT_AUDIO_CACHE_TOOLCHAIN", "The limiter compatibility toolchain changed while rendering; retry with one stable FFmpeg executable.");
    }
    await publishStagedFile(temporary, resolve(target, "mix.f32le"));
    await atomicWriteFile(resolve(target, "manifest.json"), `${stableJsonStringify(manifest)}\n`);
    await writeIndex(audioRoot, composition.id, plan.key);
    return { path: resolve(target, "mix.f32le"), build: manifest.build, cache: evidence(plan, manifest, peak, "miss", missReason, prior) };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
