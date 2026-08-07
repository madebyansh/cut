import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { boundedDiagnosticString, stableJsonStringify } from "../../core/stable";
import {
  publishStagedFileTransaction,
  StagedFileTransactionError,
  type StagedFilePublication,
} from "../../project/write-boundary";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { isCutAudioBusKind, isCutAudioRole, type CutAudioBusKind, type CutAudioRole } from "../../language/audio-role";
import { multiplyRational, rational } from "../../language/rational";
import { cutReferenceRuntimeIdentity } from "../../version";
import { assertCutGraphExecutionBudget, cutSignalContentHash, finalizeGraphHashes } from "../graph";
import { referenceMasterAudioRootIds, renderReferenceAudioSelection } from "./audio";
import {
  quantizeReferenceStereoF32LeFileToPcm24Wave,
  type ReferenceAudioPeakScan,
  type ReferenceAudioPeakSource,
} from "./audio-peak";
import { validateReferenceAudioCompositionResources } from "./audio-resource";
import { planReferenceAudioRouting, referenceAudioRoutingLimits } from "./audio-routing";
import { referenceAudioBusKind, referenceAudioBusRole } from "./audio-config";
import { authorizeReachableReferenceAudioRegions } from "./audio-region";
import { validateReachableReferenceAudioRegionCrossfadePlans } from "./audio-edit-operations";
import type { ReferenceVerifiedInputSession } from "./verified-input-session";
import {
  assertReferenceMediaProfileExecutionState,
  isReferenceMediaProfileExecution,
  registerReferenceMediaProfileExecution,
} from "./media-profile-state";
import { validateReferenceTimelineEditMaterializations } from "./timeline-edit";

export type ReferenceStemErrorCode =
  | "CUT_STEM_OPTION_CONTRACT"
  | "CUT_STEM_LOCK_SHA256"
  | "CUT_STEM_MISSING"
  | "CUT_STEM_NAME_MISSING"
  | "CUT_STEM_NAME_EMPTY"
  | "CUT_STEM_NAME_UNSAFE"
  | "CUT_STEM_NAME_DUPLICATE"
  | "CUT_STEM_EMPTY"
  | "CUT_STEM_AUX_DIRECT_SOURCE"
  | "CUT_STEM_AUX_DIRECTION"
  | "CUT_STEM_AUX_DEPENDENCY"
  | "CUT_STEM_CONTROL_UNOWNED"
  | "CUT_STEM_CONTROL_AMBIGUOUS"
  | "CUT_STEM_CONTROL_AUX"
  | "CUT_STEM_CONTROL_CYCLE"
  | "CUT_STEM_CONTROL_GRAPH"
  | "CUT_STEM_CONTROL_LIMIT"
  | "CUT_STEM_ROUTING_AMBIGUOUS"
  | "CUT_STEM_GRAPH_INVALID"
  | "CUT_STEM_LIMIT"
  | "CUT_STEM_PUBLISH"
  | "CUT_STEM_WAVE_INVALID";

export class ReferenceStemError extends Error {
  readonly source?: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceStemErrorCode, message: string, owner?: Pick<IRNode | IRComposition, "id" | "provenance">) {
    super(`${code}: ${message}`);
    this.name = "ReferenceStemError";
    if (owner) {
      const { module, span } = owner.provenance;
      this.source = { module, line: span.start.line, column: span.start.column, nodeId: owner.id };
    }
  }
}

export type ReferenceStemAuxiliaryInput = {
  returnNodeId: string;
  sendNodeId: string;
  sourceStem: string;
};

/**
 * One explicit signal-only dependency used while rendering a stem. The key is
 * decoded to drive the named Sidechain node, but it is not mixed into the
 * controlled route. Both graph identities are retained so a manifest consumer
 * can distinguish a routing-name edit from an executable control-graph edit.
 */
export type ReferenceStemSidechainInput = {
  sidechainNodeId: string;
  keyNodeId: string;
  sourceStem: string;
  sidechainGraphHash: string;
  keyGraphHash: string;
};

export type ReferenceStemRoute = {
  name: string;
  role?: CutAudioRole;
  kind: CutAudioBusKind;
  auxiliaryInputs: ReferenceStemAuxiliaryInput[];
  sidechainInputs: ReferenceStemSidechainInput[];
  nodeId: string;
  graphHash: string;
  file: string;
};

export type ReferenceStemPlan = {
  format: "cut-reference-stem-plan";
  version: 3;
  buildId: string;
  compositionId: string;
  sampleRate: number;
  channels: 2;
  sampleFormat: "s24le";
  totalSamples: number;
  routes: ReferenceStemRoute[];
};

export type ReferenceStemManifestEntry = ReferenceStemRoute & {
  sha256: string;
  bytes: number;
  sampleRate: number;
  channels: 2;
  sampleFormat: "s24le";
  samples: number;
  peak: ReferenceAudioPeakScan;
};

export type ReferenceStemManifest = {
  format: "cut-reference-stems";
  version: 5;
  runtime: string;
  /** SHA-256 of the exact verified cut.lock bytes applied by the caller. */
  lock: { sha256: string };
  buildId: string;
  composition: {
    id: string;
    name: string;
    duration: { numerator: string; denominator: string };
    sampleRate: number;
    channels: 2;
    sampleFormat: "s24le";
    samples: number;
  };
  relationship: {
    stage: "pre-master";
    mix: "decoded-sum-with-s24-rounding";
    normalization: "none";
    peakValidation: "exact-f32le-before-quantization";
    quantization: "nearest-ties-to-even";
  };
  stems: ReferenceStemManifestEntry[];
};

export type ReferenceAudioStemRenderOptions = Readonly<{
  /** SHA-256 of the exact verified cut.lock bytes applied to this export. */
  lockSha256: string;
  /** Decoded sample ceiling already derived from the public Meter contract. */
  samplePeakDbfs?: number;
  /** Source attached to a peak/structure diagnostic; defaults to composition. */
  source?: ReferenceAudioPeakSource;
  /** @internal One invocation-scoped verified snapshot resolver. */
  __verifiedResourcePath?: ReferenceVerifiedInputSession["pathFor"];
}>;

const transparentTopLevelOps = new Set(["cut.kernel.fragment", "cut.audio.meter"]);
const linearPreMasterInsertOps = new Set([
  "cut.audio.gain",
  "cut.audio.highpass",
  "cut.audio.lowpass",
  "cut.audio.eq",
  "cut.audio.compressor",
  "cut.audio.deesser",
  "cut.audio.limiter",
]);
const renderedSourceOps = new Set([
  "cut.audio.clip",
  "cut.documentary.narration",
  "cut.audio.synth",
  "cut.audio.tone",
  "cut.audio.noise",
  "cut.edit.clip",
  "cut.edit.nested_sequence",
  // TimelineEdit materializes a rich processed AudioRegion once behind a
  // private reference origin, then exposes immutable source-clock slices as
  // child views. A view is therefore the audible route leaf owned by the
  // delivered Bus even though its authenticated origin is not duplicated into
  // the structural child chain.
  "cut.edit.timeline_audio_view",
]);
const portableStemName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const maximumStemCount = 64;
const maximumStemSidechainInputs = 1_024;
const maximumStemManifestBytes = 1_048_576;
// Leave a conservative 4 KiB envelope for RIFF/WAVE headers and chunks so the
// uint32 RIFF size cannot overflow even when FFmpeg adds a format extension.
const maximumClassicWaveDataBytes = 0xffffffff - 4096;

function fail(code: ReferenceStemErrorCode, message: string, owner?: Pick<IRNode | IRComposition, "id" | "provenance">): never {
  throw new ReferenceStemError(code, message, owner);
}

function validateReferenceAudioStemRenderOptions(value: unknown): ReferenceAudioStemRenderOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("CUT_STEM_OPTION_CONTRACT", "stem export options must be one plain closed object containing lockSha256.");
  }
  const options = value as Record<string, unknown>;
  const allowed = new Set(["lockSha256", "samplePeakDbfs", "source", "__verifiedResourcePath"]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail("CUT_STEM_OPTION_CONTRACT", `unknown stem export option ${JSON.stringify(unknown[0])}.`);
  if (typeof options.lockSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(options.lockSha256)) {
    fail("CUT_STEM_LOCK_SHA256", "lockSha256 must be one lowercase SHA-256 digest of the verified cut.lock bytes.");
  }
  if (options.samplePeakDbfs !== undefined && (typeof options.samplePeakDbfs !== "number" || !Number.isFinite(options.samplePeakDbfs))) {
    fail("CUT_STEM_OPTION_CONTRACT", "samplePeakDbfs must be finite when supplied.");
  }
  if (options.__verifiedResourcePath !== undefined && typeof options.__verifiedResourcePath !== "function") {
    fail("CUT_STEM_OPTION_CONTRACT", "__verifiedResourcePath must be a function when supplied.");
  }
  return options as ReferenceAudioStemRenderOptions;
}

function sourceLabel(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function canonicalTextOrder(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalSidechainOrder(left: ReferenceStemSidechainInput, right: ReferenceStemSidechainInput) {
  return canonicalTextOrder(left.sidechainNodeId, right.sidechainNodeId)
    || canonicalTextOrder(left.keyNodeId, right.keyNodeId);
}

function canonicalStemComposition(ir: CutAVIR, supplied: IRComposition) {
  const canonical = ir.compositions.find((candidate) => candidate.id === supplied.id);
  if (!canonical) fail("CUT_STEM_GRAPH_INVALID", `Stem composition ${boundedDiagnosticString(supplied.id)} is not a member of this CutAVIR.`, supplied);
  if (stableJsonStringify(canonical) !== stableJsonStringify(supplied)) {
    fail("CUT_STEM_GRAPH_INVALID", `Stem composition ${boundedDiagnosticString(supplied.id)} differs from the canonical composition represented by buildId ${ir.buildId}.`, supplied);
  }
  return canonical;
}

function assertCanonicalStemGraphIdentity(ir: CutAVIR, composition: IRComposition) {
  // The JSON loader verifies these identities at the public artifact boundary,
  // but the TypeScript API also accepts an in-memory IR. Recompute on a clone
  // so a caller cannot mutate executable values while retaining plausible old
  // graph hashes in a published stem plan/manifest.
  const expected = structuredClone(ir);
  for (const signal of Object.values(expected.signals)) signal.contentHash = cutSignalContentHash(signal);
  if (isReferenceMediaProfileExecution(ir)) {
    assertReferenceMediaProfileExecutionState(ir);
    registerReferenceMediaProfileExecution(expected);
  }
  try { finalizeGraphHashes(expected); }
  catch (error) {
    fail("CUT_STEM_GRAPH_INVALID", `Cannot derive canonical stem graph identity: ${error instanceof Error ? error.message : String(error)}`, composition);
  }

  for (const [signalId, signal] of Object.entries(ir.signals)) {
    if (expected.signals[signalId]?.contentHash === signal.contentHash) continue;
    const owner = Object.values(ir.nodes).find((node) => Object.values(node.properties).some((property) => "signal" in property && property.signal === signalId));
    fail("CUT_STEM_GRAPH_INVALID", `Signal ${signalId} has stale contentHash; reload canonical CutAVIR or rebuild after the semantic edit.`, owner ?? composition);
  }
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    if (expected.nodes[nodeId]?.contentHash === node.contentHash) continue;
    fail("CUT_STEM_GRAPH_INVALID", `Audio graph node ${nodeId} at ${sourceLabel(node)} has stale contentHash; reload canonical CutAVIR or rebuild after the semantic edit.`, node);
  }
  if (expected.buildId !== ir.buildId) {
    fail("CUT_STEM_GRAPH_INVALID", `CutAVIR buildId is stale; reload canonical CutAVIR or rebuild after the semantic edit.`, composition);
  }
}

function exactTotalSamples(composition: IRComposition) {
  const exact = multiplyRational(composition.duration, rational(composition.sampleRate));
  if (exact.denominator !== "1") fail("CUT_STEM_LIMIT", `Timeline “${composition.name}” duration does not land on a ${composition.sampleRate} Hz sample boundary.`);
  const total = Number(exact.numerator);
  if (!Number.isSafeInteger(total) || total < 0) fail("CUT_STEM_LIMIT", `Timeline “${composition.name}” has an invalid stem sample count.`);
  if (total * 2 * 3 > maximumClassicWaveDataBytes) fail("CUT_STEM_LIMIT", `Timeline “${composition.name}” exceeds the classic 24-bit stereo WAVE stem limit.`);
  return total;
}

/**
 * Resolve one of the two closed delivery topologies:
 *
 * 1. legacy transparent wrappers -> named Bus roots; or
 * 2. transparent wrappers / one-child linear mastering inserts ->
 *    Submix(name: "pre-master") -> direct named Bus children.
 *
 * The second form deliberately keeps the authored master graph intact while
 * making the selected Bus nodes the pre-master serialization roots. It does
 * not infer a boundary from an arbitrary processor above a Bus.
 */
function topLevelBuses(ir: CutAVIR, roots: readonly string[]) {
  const legacyBuses: IRNode[] = [];
  const boundaryBuses: IRNode[] = [];
  const boundaries: IRNode[] = [];
  const visit = (nodeId: string, stack: Set<string>, insideLinearInsert = false) => {
    if (stack.has(nodeId)) fail("CUT_STEM_GRAPH_INVALID", `Audio graph cycle reaches ${nodeId}.`);
    const node = ir.nodes[nodeId];
    if (!node) fail("CUT_STEM_GRAPH_INVALID", `Audio root references missing node ${nodeId}.`);
    if (node.op === "cut.audio.bus") {
      if (insideLinearInsert) {
        fail(
          "CUT_STEM_ROUTING_AMBIGUOUS",
          `${node.op} at ${sourceLabel(node)} is directly below a shared mastering insert. Wrap every delivered Bus in one explicit Submix(name: "pre-master") boundary; Limiter { Bus(...) } and other inferred processor boundaries are not stem-safe.`,
          node,
        );
      }
      legacyBuses.push(node);
      return;
    }
    const next = new Set(stack); next.add(nodeId);
    if (node.op === "cut.audio.submix") {
      const name = node.inputs.name;
      if (name?.kind !== "string" || name.value !== "pre-master") {
        fail(
          "CUT_STEM_ROUTING_AMBIGUOUS",
          `Top-level Submix at ${sourceLabel(node)} is not the explicit pre-master stem boundary. Use exactly Submix(name: "pre-master") or place the Submix inside one delivered Bus.`,
          node,
        );
      }
      boundaries.push(node);
      if (node.children.length === 0) {
        fail("CUT_STEM_ROUTING_AMBIGUOUS", `Pre-master Submix at ${sourceLabel(node)} has no delivered Bus children.`, node);
      }
      for (const childId of node.children) {
        const child = ir.nodes[childId];
        if (!child) fail("CUT_STEM_GRAPH_INVALID", `Pre-master Submix at ${sourceLabel(node)} references missing child ${childId}.`, node);
        if (child.op !== "cut.audio.bus") {
          fail(
            "CUT_STEM_ROUTING_AMBIGUOUS",
            `Pre-master Submix at ${sourceLabel(node)} has non-Bus child ${child.op} at ${sourceLabel(child)}. Its direct children must be the unique named Bus routes; put route-local processors inside a Bus and shared mastering inserts outside the Submix.`,
            child,
          );
        }
        boundaryBuses.push(child);
      }
      return;
    }
    if (linearPreMasterInsertOps.has(node.op)) {
      if (node.children.length !== 1) {
        fail(
          "CUT_STEM_ROUTING_AMBIGUOUS",
          `Shared pre-master insert ${node.op} at ${sourceLabel(node)} must form one linear chain with exactly one child ending at Submix(name: "pre-master"); found ${node.children.length}.`,
          node,
        );
      }
      const before = boundaries.length;
      visit(node.children[0], next, true);
      if (boundaries.length === before) {
        fail(
          "CUT_STEM_ROUTING_AMBIGUOUS",
          `Shared pre-master insert ${node.op} at ${sourceLabel(node)} does not end at Submix(name: "pre-master"). CUT will not infer a stem boundary from a processor above Bus nodes.`,
          node,
        );
      }
      return;
    }
    if (!transparentTopLevelOps.has(node.op)) {
      fail(
        "CUT_STEM_ROUTING_AMBIGUOUS",
        `${node.op} at ${sourceLabel(node)} is above or outside a delivered Bus. Stem export accepts direct named Bus roots, or one explicit Submix(name: "pre-master") below only Gain, HighPass, LowPass, EQ, Compressor, DeEsser, Limiter, Meter, and component fragments.`,
        node,
      );
    }
    for (const child of node.children) visit(child, next, insideLinearInsert);
  };
  for (const root of roots) visit(root, new Set());
  if (boundaries.length > 1) {
    fail(
      "CUT_STEM_ROUTING_AMBIGUOUS",
      `Timeline audio resolves to ${boundaries.length} Submix(name: "pre-master") boundaries; stem export requires exactly one shared pre-master boundary.`,
      boundaries[1],
    );
  }
  if (boundaries.length === 1 && legacyBuses.length) {
    fail(
      "CUT_STEM_ROUTING_AMBIGUOUS",
      `Top-level Bus at ${sourceLabel(legacyBuses[0])} sits outside Submix(name: "pre-master") at ${sourceLabel(boundaries[0])}; every delivered Bus must be a direct child of the one explicit boundary.`,
      legacyBuses[0],
    );
  }
  return boundaries.length === 1 ? boundaryBuses : legacyBuses;
}

function stemName(node: IRNode) {
  const authored = node.inputs.name;
  if (authored === undefined) fail("CUT_STEM_NAME_MISSING", `Top-level Bus at ${sourceLabel(node)} needs name: "..." for stem export.`);
  if (authored.kind !== "string") fail("CUT_STEM_NAME_UNSAFE", `Top-level Bus at ${sourceLabel(node)} has a non-string stem name in CutAVIR.`);
  if (authored.value.length === 0) fail("CUT_STEM_NAME_EMPTY", `Top-level Bus at ${sourceLabel(node)} has an empty stem name.`);
  if (!portableStemName.test(authored.value) || windowsDeviceName.test(authored.value)) {
    fail("CUT_STEM_NAME_UNSAFE", `Stem name ${boundedDiagnosticString(authored.value)} at ${sourceLabel(node)} is not a portable file name; use 1–64 ASCII letters, digits, _ or -, beginning with a letter and excluding Windows device names.`);
  }
  return authored.value;
}

function claimAudibleBranch(
  ir: CutAVIR,
  route: ReferenceStemRoute,
  owners: Map<string, string>,
  sidechainKeyIds: ReadonlySet<string>,
  nodeId: string,
  stack: Set<string>,
): IRNode | undefined {
  const node = ir.nodes[nodeId];
  if (!node) fail("CUT_STEM_GRAPH_INVALID", `Stem ${JSON.stringify(route.name)} references missing node ${nodeId}.`);
  if (stack.has(nodeId)) fail("CUT_STEM_GRAPH_INVALID", `Audio graph cycle reaches ${nodeId} from stem ${JSON.stringify(route.name)}.`, node);
  if (node.id !== route.nodeId && node.op === "cut.audio.bus" && referenceAudioBusKind(node) === "aux") {
    fail("CUT_STEM_AUX_DIRECTION", `Aux Bus at ${sourceLabel(node)} is nested inside stem ${JSON.stringify(route.name)}; auxiliary delivery buses must be top-level.`, node);
  }
  const previousOwner = owners.get(nodeId);
  if (previousOwner) {
    if (previousOwner !== route.name && (sidechainKeyIds.has(nodeId) || node.op === "cut.audio.sidechain")) {
      fail("CUT_STEM_CONTROL_AMBIGUOUS", `Sidechain control node/key ${nodeId} at ${sourceLabel(node)} is structurally owned by both stems ${JSON.stringify(previousOwner)} and ${JSON.stringify(route.name)}.`, node);
    }
    fail("CUT_STEM_ROUTING_AMBIGUOUS", `Audio node ${nodeId} at ${sourceLabel(node)} is reachable more than once${previousOwner === route.name ? ` within stem ${JSON.stringify(route.name)}` : ` from stems ${JSON.stringify(previousOwner)} and ${JSON.stringify(route.name)}`}.`, node);
  }
  owners.set(nodeId, route.name);
  const next = new Set(stack); next.add(nodeId);
  let source = renderedSourceOps.has(node.op) ? node : undefined;
  for (const child of node.children) {
    const childSource = claimAudibleBranch(ir, route, owners, sidechainKeyIds, child, next);
    source ??= childSource;
  }
  return source;
}

function sidechainControlPathIds(ir: CutAVIR, buses: readonly IRNode[]) {
  const keyIds = new Set<string>(), visited = new Set<string>(), pending = buses.map((bus) => bus.id), parents = new Map<string, Set<string>>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) continue;
    if (node.op === "cut.audio.sidechain" && node.inputs.source?.kind === "node-ref") keyIds.add(node.inputs.source.id);
    for (const child of node.children) {
      const owners = parents.get(child) ?? new Set<string>(); owners.add(id); parents.set(child, owners);
      pending.push(child);
    }
  }
  // Ambiguity in any structural ancestor of a referenced key makes the key's
  // stem ownership ambiguous too. Mark that complete control path so a shared
  // Gain/processor above the direct key cannot fall through to a generic
  // routing diagnostic.
  const result = new Set(keyIds), controlPending = [...keyIds];
  while (controlPending.length) {
    const id = controlPending.pop()!;
    for (const parent of parents.get(id) ?? []) {
      if (result.has(parent)) continue;
      result.add(parent); controlPending.push(parent);
    }
  }
  return result;
}

function planStemSidechainInputs(
  ir: CutAVIR,
  routes: ReferenceStemRoute[],
  owners: ReadonlyMap<string, string>,
) {
  const routesByName = new Map(routes.map((route) => [route.name, route]));
  const controls: Array<{ target: ReferenceStemRoute; source: ReferenceStemRoute; node: IRNode; input: ReferenceStemSidechainInput }> = [];
  for (const node of Object.values(ir.nodes)) {
    if (node.op !== "cut.audio.sidechain") continue;
    const targetName = owners.get(node.id);
    if (!targetName) continue;
    const target = routesByName.get(targetName);
    const source = node.inputs.source;
    if (!target || source?.kind !== "node-ref") {
      fail("CUT_STEM_CONTROL_GRAPH", `Sidechain at ${sourceLabel(node)} has no closed stem route or AudioNode key reference.`, node);
    }
    const key = ir.nodes[source.id];
    if (!key || key.domain !== "audio") {
      fail("CUT_STEM_CONTROL_GRAPH", `Sidechain at ${sourceLabel(node)} references missing or non-audio key ${source.id}.`, node);
    }
    const sourceName = owners.get(key.id);
    if (!sourceName) {
      fail("CUT_STEM_CONTROL_UNOWNED", `Sidechain at ${sourceLabel(node)} uses key ${key.id} at ${sourceLabel(key)} without a top-level stem owner. Put the key in one named program Bus.`, node);
    }
    const sourceRoute = routesByName.get(sourceName);
    if (!sourceRoute) {
      fail("CUT_STEM_CONTROL_GRAPH", `Sidechain at ${sourceLabel(node)} resolves key ${key.id} to missing stem ${JSON.stringify(sourceName)}.`, node);
    }
    if (sourceRoute.name !== target.name && (sourceRoute.kind === "aux" || target.kind === "aux")) {
      fail("CUT_STEM_CONTROL_AUX", `Sidechain at ${sourceLabel(node)} creates unsupported cross-stem control from ${JSON.stringify(sourceRoute.name)} (${sourceRoute.kind}) to ${JSON.stringify(target.name)} (${target.kind}); cross-stem controls require two program stems.`, node);
    }
    if (!/^[a-f0-9]{64}$/u.test(node.contentHash) || !/^[a-f0-9]{64}$/u.test(key.contentHash)) {
      fail("CUT_STEM_CONTROL_GRAPH", `Sidechain at ${sourceLabel(node)} or its key ${key.id} lacks canonical graph identity.`, node);
    }
    const input: ReferenceStemSidechainInput = {
      sidechainNodeId: node.id,
      keyNodeId: key.id,
      sourceStem: sourceRoute.name,
      sidechainGraphHash: node.contentHash,
      keyGraphHash: key.contentHash,
    };
    if (controls.length >= maximumStemSidechainInputs) {
      fail("CUT_STEM_CONTROL_LIMIT", `Timeline stem delivery declares more than ${maximumStemSidechainInputs} Sidechain control dependencies.`, node);
    }
    target.sidechainInputs.push(input);
    controls.push({ target, source: sourceRoute, node, input });
  }
  for (const route of routes) {
    route.sidechainInputs.sort(canonicalSidechainOrder);
  }

  // A cross-stem detector graph is feed-forward. Detect cycles at the authored
  // routing level before the generic graph walker can collapse the failure into
  // a less useful CUT_AUDIO_GRAPH diagnostic.
  const outgoing = new Map<string, typeof controls>();
  for (const control of controls) {
    if (control.target.name === control.source.name) continue;
    const entries = outgoing.get(control.target.name) ?? [];
    entries.push(control); outgoing.set(control.target.name, entries);
  }
  const states = new Map<string, "visiting" | "done">(), stack: string[] = [];
  const visit = (name: string) => {
    if (states.get(name) === "done") return;
    states.set(name, "visiting"); stack.push(name);
    for (const control of outgoing.get(name) ?? []) {
      if (states.get(control.source.name) === "visiting") {
        const start = stack.indexOf(control.source.name), cycle = [...stack.slice(Math.max(0, start)), control.source.name];
        fail("CUT_STEM_CONTROL_CYCLE", `Sidechain at ${sourceLabel(control.node)} closes cross-stem control cycle ${cycle.map((item) => JSON.stringify(item)).join(" -> ")}.`, control.node);
      }
      visit(control.source.name);
    }
    stack.pop(); states.set(name, "done");
  };
  for (const route of routes) visit(route.name);
}

/**
 * Validate the authored stem topology without touching resources or spawning
 * FFmpeg. The resulting routes point at existing Bus nodes in the original IR.
 */
export function planReferenceAudioStems(ir: CutAVIR, composition: IRComposition): ReferenceStemPlan {
  composition = canonicalStemComposition(ir, composition);
  const roots = referenceMasterAudioRootIds(ir, composition);
  validateReachableReferenceAudioRegionCrossfadePlans(ir, composition, roots);
  // Preserve the stem-specific CUT_STEM_EMPTY diagnostic for an empty named
  // Bus while still closing unknown fields, ownership, roots and every other
  // reachable-audio invariant before any stem path is allocated.
  authorizeReachableReferenceAudioRegions(ir, composition, roots, { deferEmptyBus: true, deferSharedChildren: true });
  if (!roots.length) fail("CUT_STEM_MISSING", `Timeline “${composition.name}” has no audible roots to export as stems.`);
  const buses = topLevelBuses(ir, roots);
  if (!buses.length) fail("CUT_STEM_MISSING", `Timeline “${composition.name}” has no top-level Bus nodes to export as stems.`);
  if (buses.length > maximumStemCount) fail("CUT_STEM_LIMIT", `Timeline “${composition.name}” declares ${buses.length} top-level buses; the reference stem exporter permits ${maximumStemCount}.`);

  const routes: ReferenceStemRoute[] = [];
  const names = new Map<string, IRNode>();
  const busIds = new Set<string>();
  for (const bus of buses) {
    if (busIds.has(bus.id)) fail("CUT_STEM_ROUTING_AMBIGUOUS", `Top-level Bus ${bus.id} at ${sourceLabel(bus)} is routed to the master more than once.`);
    busIds.add(bus.id);
    const name = stemName(bus), folded = name.toLowerCase(), previous = names.get(folded);
    if (previous) fail("CUT_STEM_NAME_DUPLICATE", `Top-level buses at ${sourceLabel(previous)} and ${sourceLabel(bus)} use the case-insensitively duplicate name ${boundedDiagnosticString(name)}.`);
    names.set(folded, bus);
    const role = referenceAudioBusRole(bus), kind = referenceAudioBusKind(bus);
    routes.push({ name, ...(role === undefined ? {} : { role }), kind, auxiliaryInputs: [], sidechainInputs: [], nodeId: bus.id, graphHash: bus.contentHash, file: `${name}.wav` });
  }

  const owners = new Map<string, string>();
  const firstSource = new Map<string, IRNode | undefined>();
  const controlKeys = sidechainControlPathIds(ir, buses);
  for (const route of routes) {
    firstSource.set(route.name, claimAudibleBranch(ir, route, owners, controlKeys, route.nodeId, new Set()));
  }
  planStemSidechainInputs(ir, routes, owners);
  const graph = assertCutGraphExecutionBudget(ir, roots);
  validateReferenceAudioCompositionResources(ir, composition, roots, graph.expansionVisits);

  const routesByName = new Map(routes.map((route) => [route.name, route]));
  const routing = planReferenceAudioRouting(ir, composition);
  for (const [returnId, sendIds] of routing.returns) {
    const returnOwner = owners.get(returnId);
    const returned = ir.nodes[returnId];
    if (!returnOwner || !returned) fail("CUT_STEM_AUX_DEPENDENCY", `Return ${returnId} has no unambiguous top-level Bus owner.`, returned ?? composition);
    const returnRoute = routesByName.get(returnOwner);
    if (!returnRoute) fail("CUT_STEM_AUX_DEPENDENCY", `Return at ${sourceLabel(returned)} resolves to missing stem ${JSON.stringify(returnOwner)}.`, returned);
    for (const sendId of sendIds) {
      const send = ir.nodes[sendId];
      const sendPlan = routing.sends.get(sendId);
      const sendOwner = owners.get(sendId) ?? (sendPlan?.sourceNodeId === undefined ? undefined : owners.get(sendPlan.sourceNodeId));
      if (!sendOwner || !send) fail("CUT_STEM_AUX_DEPENDENCY", `Return at ${sourceLabel(returned)} references Send ${sendId} without an unambiguous top-level Bus owner.`, returned);
      const sendRoute = routesByName.get(sendOwner);
      if (!sendRoute) fail("CUT_STEM_AUX_DEPENDENCY", `Send at ${sourceLabel(send)} resolves to missing stem ${JSON.stringify(sendOwner)}.`, send);
      if (returnOwner === sendOwner) {
        if (returnRoute.kind === "aux") fail("CUT_STEM_AUX_DIRECTION", `Return at ${sourceLabel(returned)} in aux stem ${JSON.stringify(returnOwner)} references a Send owned by the same aux stem; aux inputs must come from program stems.`, returned);
        continue;
      }
      if (returnRoute.kind !== "aux") {
        fail("CUT_STEM_AUX_DIRECTION", `Return at ${sourceLabel(returned)} in program stem ${JSON.stringify(returnOwner)} references Send at ${sourceLabel(send)} in another stem ${JSON.stringify(sendOwner)}; only an aux stem may receive a cross-stem Send.`, returned);
      }
      if (sendRoute.kind !== "program") {
        fail("CUT_STEM_AUX_DIRECTION", `Return at ${sourceLabel(returned)} in aux stem ${JSON.stringify(returnOwner)} references Send at ${sourceLabel(send)} in aux stem ${JSON.stringify(sendOwner)}; aux-to-aux routing is unsupported.`, returned);
      }
      returnRoute.auxiliaryInputs.push({ returnNodeId: returnId, sendNodeId: sendId, sourceStem: sendOwner });
    }
  }

  for (const route of routes) {
    const source = firstSource.get(route.name), node = ir.nodes[route.nodeId];
    if (route.kind === "aux") {
      if (source) fail("CUT_STEM_AUX_DIRECT_SOURCE", `Aux stem ${JSON.stringify(route.name)} at ${sourceLabel(node)} structurally contains rendered source ${source.op} at ${sourceLabel(source)}; author the source in a program Bus and feed this aux only through Return.`, source);
      if (!route.auxiliaryInputs.length) fail("CUT_STEM_AUX_DEPENDENCY", `Aux stem ${JSON.stringify(route.name)} at ${sourceLabel(node)} has no cross-stem Return dependency on a program Send.`, node);
    } else if (!source) {
      fail("CUT_STEM_EMPTY", `Top-level program Bus ${JSON.stringify(route.name)} at ${sourceLabel(node)} contains no rendered audio source.`, node);
    }
  }

  assertCanonicalStemGraphIdentity(ir, composition);

  return {
    format: "cut-reference-stem-plan",
    version: 3,
    buildId: ir.buildId,
    compositionId: composition.id,
    sampleRate: composition.sampleRate,
    channels: 2,
    sampleFormat: "s24le",
    totalSamples: exactTotalSamples(composition),
    routes,
  };
}

function assertStemManifestPreflight(plan: ReferenceStemPlan, composition: IRComposition, lockSha256: string) {
  // Use the real topology and deliberately maximum-width scalar evidence for
  // every field populated after rendering. This is a conservative upper bound
  // on the canonical v5 JSON, so oversized identities fail before mkdir,
  // decoding, quantization, or public-path inspection.
  const widest = -Number.MAX_VALUE;
  const peakEnvelope: ReferenceAudioPeakScan = {
    format: "cut-reference-audio-peak-scan",
    version: 1,
    sampleFormat: "f32le",
    channels: 2,
    expectedFrames: Number.MAX_SAFE_INTEGER,
    observedFrames: Number.MAX_SAFE_INTEGER,
    expectedBytes: Number.MAX_SAFE_INTEGER,
    observedBytes: Number.MAX_SAFE_INTEGER,
    thresholdDbfs: widest,
    thresholdLinear: widest,
    silent: false,
    peakLinear: widest,
    peakDbfs: widest,
    peakFrame: Number.MAX_SAFE_INTEGER,
    peakChannel: 1,
    peakChannelName: "right",
    peakSample: widest,
  };
  const envelope: ReferenceStemManifest = {
    format: "cut-reference-stems",
    version: 5,
    runtime: cutReferenceRuntimeIdentity,
    lock: { sha256: lockSha256 },
    buildId: plan.buildId,
    composition: {
      id: composition.id,
      name: composition.name,
      duration: composition.duration,
      sampleRate: plan.sampleRate,
      channels: 2,
      sampleFormat: "s24le",
      samples: plan.totalSamples,
    },
    relationship: { stage: "pre-master", mix: "decoded-sum-with-s24-rounding", normalization: "none", peakValidation: "exact-f32le-before-quantization", quantization: "nearest-ties-to-even" },
    stems: plan.routes.map((route) => ({
      ...route,
      sha256: "f".repeat(64),
      bytes: 0xffff_ffff,
      sampleRate: Number.MAX_SAFE_INTEGER,
      channels: 2,
      sampleFormat: "s24le",
      samples: Number.MAX_SAFE_INTEGER,
      peak: peakEnvelope,
    })),
  };
  if (Buffer.byteLength(`${stableJsonStringify(envelope)}\n`) > maximumStemManifestBytes) {
    fail("CUT_STEM_LIMIT", `Stem manifest for timeline “${composition.name}” exceeds the ${maximumStemManifestBytes}-byte closed manifest limit.`, composition);
  }
}

async function sha256(path: string) {
  return new Promise<string>((accept, reject) => {
    const digest = createHash("sha256");
    createReadStream(path).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => accept(digest.digest("hex")));
  });
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, length: number, position: number) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) fail("CUT_STEM_WAVE_INVALID", `Unexpected end of WAVE file at byte ${position + offset}.`);
    offset += bytesRead;
  }
  return buffer;
}

async function verifyPcm24Wave(path: string, expectedSampleRate: number, expectedSamples: number) {
  const handle = await open(path, "r");
  try {
    const file = await handle.stat(), header = await readExactly(handle, 12, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") fail("CUT_STEM_WAVE_INVALID", `${path} is not a classic RIFF/WAVE file.`);
    let cursor = 12, format: { code: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number; validBits?: number; channelMask?: number; subformat?: number } | undefined, dataBytes: number | undefined;
    while (cursor + 8 <= file.size && (format === undefined || dataBytes === undefined)) {
      const chunk = await readExactly(handle, 8, cursor), id = chunk.toString("ascii", 0, 4), size = chunk.readUInt32LE(4), body = cursor + 8;
      if (body + size > file.size) fail("CUT_STEM_WAVE_INVALID", `${path} has a truncated ${JSON.stringify(id)} chunk.`);
      if (id === "fmt ") {
        if (size < 16) fail("CUT_STEM_WAVE_INVALID", `${path} has a short WAVE format chunk.`);
        const value = await readExactly(handle, size >= 40 ? 40 : 16, body), code = value.readUInt16LE(0);
        format = {
          code,
          channels: value.readUInt16LE(2),
          sampleRate: value.readUInt32LE(4),
          byteRate: value.readUInt32LE(8),
          blockAlign: value.readUInt16LE(12),
          bits: value.readUInt16LE(14),
          ...(code === 0xfffe && value.length >= 40 ? { validBits: value.readUInt16LE(18), channelMask: value.readUInt32LE(20), subformat: value.readUInt32LE(24) } : {}),
        };
      } else if (id === "data") dataBytes = size;
      cursor = body + size + (size % 2);
    }
    if (!format || dataBytes === undefined) fail("CUT_STEM_WAVE_INVALID", `${path} is missing a WAVE format or data chunk.`);
    const pcmFormat = format.code === 1 || (format.code === 0xfffe && format.validBits === 24 && format.channelMask === 3 && format.subformat === 1);
    if (!pcmFormat || format.channels !== 2 || format.sampleRate !== expectedSampleRate || format.byteRate !== expectedSampleRate * 6 || format.blockAlign !== 6 || format.bits !== 24) {
      fail("CUT_STEM_WAVE_INVALID", `${path} violates the ${expectedSampleRate} Hz stereo signed-24-bit PCM contract.`);
    }
    if (dataBytes !== expectedSamples * format.blockAlign) fail("CUT_STEM_WAVE_INVALID", `${path} contains ${dataBytes / format.blockAlign} samples per channel; expected exactly ${expectedSamples}.`);
    return { bytes: file.size, samples: expectedSamples, sampleRate: format.sampleRate, channels: 2 as const, sampleFormat: "s24le" as const };
  } finally {
    await handle.close();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function closedRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!record(value)) return false;
  const allowed = new Set([...required, ...optional]), keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validPriorPeak(value: unknown, expectedFrames: number) {
  if (!closedRecord(value, [
    "format", "version", "sampleFormat", "channels", "expectedFrames", "observedFrames",
    "expectedBytes", "observedBytes", "thresholdDbfs", "thresholdLinear", "silent",
    "peakLinear", "peakDbfs", "peakFrame", "peakChannel", "peakChannelName", "peakSample",
  ])
    || value.format !== "cut-reference-audio-peak-scan"
    || value.version !== 1
    || value.sampleFormat !== "f32le"
    || value.channels !== 2
    || value.expectedFrames !== expectedFrames
    || value.observedFrames !== expectedFrames
    || value.expectedBytes !== expectedFrames * 8
    || value.observedBytes !== expectedFrames * 8
    || typeof value.thresholdDbfs !== "number" || !Number.isFinite(value.thresholdDbfs)
    || typeof value.thresholdLinear !== "number" || !Number.isFinite(value.thresholdLinear)
    || typeof value.silent !== "boolean"
    || typeof value.peakLinear !== "number" || !Number.isFinite(value.peakLinear)
    || !finiteOrNull(value.peakDbfs)
    || !(value.peakFrame === null || safeInteger(value.peakFrame))
    || !(value.peakChannel === null || value.peakChannel === 0 || value.peakChannel === 1)
    || !(value.peakChannelName === null || value.peakChannelName === "left" || value.peakChannelName === "right")
    || !finiteOrNull(value.peakSample)) return false;
  return value.silent
    ? value.peakFrame === null && value.peakChannel === null && value.peakChannelName === null && value.peakSample === null && value.peakDbfs === null
    : safeInteger(value.peakFrame) && value.peakFrame < expectedFrames && (value.peakChannel === 0 || value.peakChannel === 1) && value.peakChannelName === (value.peakChannel === 0 ? "left" : "right") && value.peakSample !== null && value.peakDbfs !== null;
}

/**
 * Return only direct portable WAVE leaves owned by a prior canonical v3/v4/v5
 * CUT manifest. Invalid, obsolete, non-canonical, oversized, or symlinked
 * manifests confer no deletion authority, so their neighbouring files are
 * left untouched. V3 remains readable only under its exact historical shape;
 * new manifests use v5, close every sidechain control dependency, and bind the
 * exact verified cut.lock bytes used for their export.
 */
async function priorOwnedStemFiles(directory: string) {
  const manifestPath = resolve(directory, "cut-stems.json");
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumStemManifestBytes) return [];
  let parsed: unknown;
  try {
    const encoded = await readFile(manifestPath, "utf8");
    parsed = JSON.parse(encoded);
    if (encoded !== `${stableJsonStringify(parsed)}\n`) return [];
  } catch {
    return [];
  }
  if (!record(parsed)) return [];
  const version = parsed.version;
  const topLevelFields = ["format", "version", "runtime", ...(version === 5 ? ["lock"] : []), "buildId", "composition", "relationship", "stems"];
  if (!closedRecord(parsed, topLevelFields)
    || parsed.format !== "cut-reference-stems"
    || (version !== 3 && version !== 4 && version !== 5)
    || typeof parsed.runtime !== "string" || parsed.runtime.length === 0
    || (version === 5 && (!closedRecord(parsed.lock, ["sha256"])
      || typeof parsed.lock.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.lock.sha256)))
    || typeof parsed.buildId !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.buildId)
    || !closedRecord(parsed.composition, ["id", "name", "duration", "sampleRate", "channels", "sampleFormat", "samples"])
    || !closedRecord(parsed.relationship, ["stage", "mix", "normalization", "peakValidation", "quantization"])
    || !Array.isArray(parsed.stems)
    || parsed.stems.length === 0
    || parsed.stems.length > maximumStemCount) return [];
  const composition = parsed.composition;
  if (typeof composition.id !== "string" || composition.id.length === 0
    || typeof composition.name !== "string"
    || !closedRecord(composition.duration, ["numerator", "denominator"])
    || typeof composition.duration.numerator !== "string" || !/^-?\d+$/u.test(composition.duration.numerator)
    || typeof composition.duration.denominator !== "string" || !/^[1-9]\d*$/u.test(composition.duration.denominator)
    || !safeInteger(composition.sampleRate, 1)
    || composition.channels !== 2
    || composition.sampleFormat !== "s24le"
    || !safeInteger(composition.samples)) return [];
  if (parsed.relationship.stage !== "pre-master"
    || parsed.relationship.mix !== "decoded-sum-with-s24-rounding"
    || parsed.relationship.normalization !== "none"
    || parsed.relationship.peakValidation !== "exact-f32le-before-quantization"
    || parsed.relationship.quantization !== "nearest-ties-to-even") return [];

  const files: string[] = [];
  const claimed = new Set<string>();
  const routes = new Map<string, { name: string; kind: CutAudioBusKind; auxiliaryInputs: ReferenceStemAuxiliaryInput[]; sidechainInputs: ReferenceStemSidechainInput[] }>();
  const claimedSidechains = new Set<string>();
  let totalAuxiliaryInputs = 0, totalSidechainInputs = 0;
  for (const candidate of parsed.stems) {
    const requiredEntryKeys = [
      "name", "kind", "auxiliaryInputs", ...(version === 4 || version === 5 ? ["sidechainInputs"] : []),
      "nodeId", "graphHash", "file", "sha256", "bytes", "sampleRate", "channels",
      "sampleFormat", "samples", "peak",
    ];
    if (!closedRecord(candidate, requiredEntryKeys, ["role"])
      || typeof candidate.name !== "string"
      || !portableStemName.test(candidate.name)
      || windowsDeviceName.test(candidate.name)
      || candidate.file !== `${candidate.name}.wav`
      || typeof candidate.kind !== "string" || !isCutAudioBusKind(candidate.kind)
      || !(candidate.role === undefined || (typeof candidate.role === "string" && isCutAudioRole(candidate.role)))
      || !Array.isArray(candidate.auxiliaryInputs)
      || candidate.auxiliaryInputs.length > referenceAudioRoutingLimits.maximumSends
      || ((version === 4 || version === 5) && !Array.isArray(candidate.sidechainInputs))
      || typeof candidate.nodeId !== "string" || candidate.nodeId.length === 0
      || typeof candidate.graphHash !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.graphHash)
      || typeof candidate.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(candidate.sha256)
      || !safeInteger(candidate.bytes, 1)
      || candidate.sampleRate !== composition.sampleRate
      || candidate.channels !== 2
      || candidate.sampleFormat !== "s24le"
      || candidate.samples !== composition.samples
      || !validPriorPeak(candidate.peak, composition.samples)) return [];
    const auxiliaryInputs: ReferenceStemAuxiliaryInput[] = [];
    const auxiliaryClaims = new Set<string>();
    for (const input of candidate.auxiliaryInputs) {
      if (!closedRecord(input, ["returnNodeId", "sendNodeId", "sourceStem"])
        || typeof input.returnNodeId !== "string" || input.returnNodeId.length === 0
        || typeof input.sendNodeId !== "string" || input.sendNodeId.length === 0
        || typeof input.sourceStem !== "string" || !portableStemName.test(input.sourceStem)) return [];
      const claim = `${input.returnNodeId}\0${input.sendNodeId}\0${input.sourceStem.toLowerCase()}`;
      if (auxiliaryClaims.has(claim)) return [];
      auxiliaryClaims.add(claim);
      auxiliaryInputs.push({ returnNodeId: input.returnNodeId, sendNodeId: input.sendNodeId, sourceStem: input.sourceStem });
    }
    totalAuxiliaryInputs += auxiliaryInputs.length;
    if (totalAuxiliaryInputs > referenceAudioRoutingLimits.maximumSends) return [];
    const sidechainInputs: ReferenceStemSidechainInput[] = [];
    const sidechainClaims = new Set<string>();
    for (const input of version === 4 || version === 5 ? candidate.sidechainInputs as unknown[] : []) {
      if (!closedRecord(input, ["sidechainNodeId", "keyNodeId", "sourceStem", "sidechainGraphHash", "keyGraphHash"])
        || typeof input.sidechainNodeId !== "string" || input.sidechainNodeId.length === 0
        || typeof input.keyNodeId !== "string" || input.keyNodeId.length === 0
        || typeof input.sourceStem !== "string" || !portableStemName.test(input.sourceStem) || windowsDeviceName.test(input.sourceStem)
        || typeof input.sidechainGraphHash !== "string" || !/^[a-f0-9]{64}$/u.test(input.sidechainGraphHash)
        || typeof input.keyGraphHash !== "string" || !/^[a-f0-9]{64}$/u.test(input.keyGraphHash)) return [];
      const claim = `${input.sidechainNodeId}\0${input.keyNodeId}\0${input.sourceStem.toLowerCase()}`;
      if (sidechainClaims.has(claim) || claimedSidechains.has(input.sidechainNodeId)) return [];
      sidechainClaims.add(claim); claimedSidechains.add(input.sidechainNodeId);
      sidechainInputs.push({
        sidechainNodeId: input.sidechainNodeId,
        keyNodeId: input.keyNodeId,
        sourceStem: input.sourceStem,
        sidechainGraphHash: input.sidechainGraphHash,
        keyGraphHash: input.keyGraphHash,
      });
    }
    totalSidechainInputs += sidechainInputs.length;
    if (totalSidechainInputs > maximumStemSidechainInputs) return [];
    const orderedSidechains = [...sidechainInputs].sort(canonicalSidechainOrder);
    if (stableJsonStringify(sidechainInputs) !== stableJsonStringify(orderedSidechains)) return [];
    if ((candidate.kind === "program" && auxiliaryInputs.length !== 0) || (candidate.kind === "aux" && auxiliaryInputs.length === 0)) return [];
    const folded = candidate.file.toLowerCase();
    if (claimed.has(folded)) return [];
    claimed.add(folded);
    routes.set(candidate.name.toLowerCase(), { name: candidate.name, kind: candidate.kind, auxiliaryInputs, sidechainInputs });
    files.push(candidate.file);
  }
  for (const route of routes.values()) {
    for (const input of route.auxiliaryInputs) {
      const source = routes.get(input.sourceStem.toLowerCase());
      if (!source || source.name !== input.sourceStem || source.kind !== "program") return [];
    }
    for (const input of route.sidechainInputs) {
      const source = routes.get(input.sourceStem.toLowerCase());
      if (!source || source.name !== input.sourceStem) return [];
      if (source.name !== route.name && (source.kind === "aux" || route.kind === "aux")) return [];
    }
  }
  const states = new Map<string, "visiting" | "done">();
  const visit = (name: string): boolean => {
    if (states.get(name) === "visiting") return false;
    if (states.get(name) === "done") return true;
    const route = routes.get(name); if (!route) return false;
    states.set(name, "visiting");
    for (const input of route.sidechainInputs) {
      const source = routes.get(input.sourceStem.toLowerCase());
      if (source && source.name !== route.name && !visit(source.name.toLowerCase())) return false;
    }
    states.set(name, "done"); return true;
  };
  for (const name of routes.keys()) if (!visit(name)) return [];
  return files;
}

function defaultPeakSource(composition: IRComposition): ReferenceAudioPeakSource {
  return {
    module: composition.provenance.module,
    line: composition.provenance.span.start.line,
    column: composition.provenance.span.start.column,
    nodeId: composition.id,
  };
}

export async function renderReferenceAudioStems(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  outputDirectory: string,
  options: ReferenceAudioStemRenderOptions,
) {
  const prepared = await prepareReferenceAudioStems(ir, composition, projectRoot, outputDirectory, options);
  try {
    await publishStagedFileTransaction(prepared.publications);
    return { directory: prepared.directory, manifestPath: prepared.manifestPath, manifest: prepared.manifest, manifestSha256: prepared.manifestSha256 };
  } catch (error) {
    if (!(error instanceof StagedFileTransactionError)) throw error;
    const code = error.code === "CUT_PUBLISH_ROLLBACK" ? "rollback could not fully restore the prior set; inspect the destination before retrying" : error.code === "CUT_PUBLISH_COMMIT" ? "the prior complete set was restored" : "preflight made no public changes";
    fail("CUT_STEM_PUBLISH", `Stem publication failed (${error.code}); ${code}.`);
  } finally {
    await prepared.cleanup().catch(() => undefined);
  }
}

export type PreparedReferenceAudioStems = Readonly<{
  directory: string;
  manifestPath: string;
  manifest: ReferenceStemManifest;
  /** SHA-256 of the exact canonical staged cut-stems.json bytes. */
  manifestSha256: string;
  publications: readonly StagedFilePublication[];
  cleanup: () => Promise<void>;
}>;

/**
 * Render and validate a complete stem set without changing public leaves.
 * The caller owns one eventual transaction and must always invoke cleanup.
 */
export async function prepareReferenceAudioStems(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  outputDirectory: string,
  authoredOptions: ReferenceAudioStemRenderOptions,
): Promise<PreparedReferenceAudioStems> {
  // A public stem set without a verified-lock digest is not reproducible
  // evidence. Close this option surface before graph validation, allocation,
  // resource probing, cache access, or backend work.
  const options = validateReferenceAudioStemRenderOptions(authoredOptions);
  // Stems create their own staging directory before delegating each route to
  // the shared audio selector. Revalidate canonical TimelineEdit authority at
  // this outermost entrypoint so a forged plan cannot allocate even that
  // wrapper-owned directory or temporary file before the shared selector sees
  // it.
  validateReferenceTimelineEditMaterializations(ir);
  // Never trust a caller-supplied route/file plan. Derive names and node roots
  // again from the validated IR immediately before creating output paths.
  const plan = planReferenceAudioStems(ir, composition);
  composition = canonicalStemComposition(ir, composition);
  assertStemManifestPreflight(plan, composition, options.lockSha256);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    fail("CUT_STEM_PUBLISH", `Stem destination ${boundedDiagnosticString(directory)} must be a direct, non-symlink directory.`);
  }
  const temporary = await mkdtemp(resolve(directory, ".cut-stems-"));
  let prepared = false;
  try {
    const stems: ReferenceStemManifestEntry[] = [];
    for (const [index, route] of plan.routes.entries()) {
      const prefix = `${String(index).padStart(2, "0")}-${route.name}`;
      const rawPath = resolve(temporary, `${prefix}.f32le`);
      const wavePath = resolve(temporary, `${prefix}.wav`);
      await renderReferenceAudioSelection(ir, composition, projectRoot, rawPath, [route.nodeId], {
        outputFormat: "raw-stereo-f32le",
        __verifiedResourcePath: options.__verifiedResourcePath,
      });
      const quantized = await quantizeReferenceStereoF32LeFileToPcm24Wave(rawPath, wavePath, {
        expectedFrames: plan.totalSamples,
        sampleRate: plan.sampleRate,
        thresholdDbfs: options.samplePeakDbfs ?? 0,
        source: options.source ?? defaultPeakSource(composition),
      });
      const observed = await verifyPcm24Wave(wavePath, plan.sampleRate, plan.totalSamples);
      stems.push({ ...route, sha256: await sha256(wavePath), ...observed, peak: quantized.peak });
    }
    const manifest: ReferenceStemManifest = {
      format: "cut-reference-stems",
      version: 5,
      runtime: cutReferenceRuntimeIdentity,
      lock: { sha256: options.lockSha256 },
      buildId: ir.buildId,
      composition: {
        id: composition.id,
        name: composition.name,
        duration: composition.duration,
        sampleRate: plan.sampleRate,
        channels: 2,
        sampleFormat: "s24le",
        samples: plan.totalSamples,
      },
      relationship: { stage: "pre-master", mix: "decoded-sum-with-s24-rounding", normalization: "none", peakValidation: "exact-f32le-before-quantization", quantization: "nearest-ties-to-even" },
      stems,
    };
    const temporaryManifest = resolve(temporary, "cut-stems.json"), encodedManifest = `${stableJsonStringify(manifest)}\n`;
    if (Buffer.byteLength(encodedManifest) > maximumStemManifestBytes) {
      fail("CUT_STEM_LIMIT", `Stem manifest for timeline “${composition.name}” exceeds the ${maximumStemManifestBytes}-byte closed manifest limit.`, composition);
    }
    const manifestSha256 = createHash("sha256").update(encodedManifest).digest("hex");
    await writeFile(temporaryManifest, encodedManifest);
    const currentFiles = new Set(stems.map((stem) => stem.file.toLowerCase()));
    const staleFiles = (await priorOwnedStemFiles(directory)).filter((file) => !currentFiles.has(file.toLowerCase()));
    const publications: StagedFilePublication[] = [
      ...stems.map((stem, index) => ({
        staged: resolve(temporary, `${String(index).padStart(2, "0")}-${stem.name}.wav`),
        destination: resolve(directory, stem.file),
        order: 100,
        role: `stem:${stem.name}`,
      })),
      ...staleFiles.map((file) => ({ action: "remove" as const, destination: resolve(directory, file), order: 200, role: `stale-stem:${file}` })),
      { staged: temporaryManifest, destination: resolve(directory, "cut-stems.json"), order: 300, role: "stem-manifest" },
    ];
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      // Publication has already reached its caller-owned commit boundary when
      // this runs. A private staging cleanup failure must never masquerade as
      // rollback; best effort may leave only a hidden `.cut-stems-*` residue.
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    };
    prepared = true;
    return { directory, manifestPath: resolve(directory, "cut-stems.json"), manifest, manifestSha256, publications, cleanup };
  } finally {
    if (!prepared) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
