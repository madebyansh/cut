import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { multiplyRational, rational } from "../../language/rational";
import { ReferenceAudioConfigError } from "./audio-config";

/**
 * Composition-wide limits for the reference audio backend.
 *
 * - 2^37 expanded node-channel-samples admits roughly 198 execution visits
 *   across a two-hour 48 kHz stereo program while refusing shared DAGs whose
 *   recursive backend expansion grows into hundreds of billions of samples.
 * - 4,294,967,196 is the largest stereo PCM24 frame-aligned payload whose
 *   ordinary 102-byte reference WAVE (RIFF chunk size = payload + 94) remains
 *   representable without RF64; the bit-exact path also requests `rf64=never`.
 * - 2,048 filter clauses and 1 MiB of graph text retain the independently
 *   rendered 2,000-source stress class while bounding libav parser/fan-in work.
 * - Audio graphs are supplied through `-filter_complex_script`; the remaining
 *   24 KiB argv budget leaves headroom below the 32,767-character Windows
 *   CreateProcess boundary and far below ordinary POSIX exec limits.
 */
export const referenceAudioBackendLimits = Object.freeze({
  maximumExpandedNodeChannelSamples: 137_438_953_472n,
  maximumEmittedFilterChannelSamples: 137_438_953_472n,
  maximumPcmPayloadBytes: 4_294_967_196n,
  maximumFilterEntries: 2_048,
  maximumFilterGraphUtf8Bytes: 1_048_576,
  maximumArgumentCount: 4_096,
  maximumArgumentUtf8Bytes: 24_576,
  maximumSingleArgumentUtf8Bytes: 8_192,
});

function source(node: IRNode) {
  return {
    module: node.provenance.module,
    line: node.provenance.span.start.line,
    column: node.provenance.span.start.column,
    nodeId: node.id,
  };
}

function sourceLabel(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function compositionSource(composition: IRComposition) {
  return {
    module: composition.provenance.module,
    line: composition.provenance.span.start.line,
    column: composition.provenance.span.start.column,
    nodeId: composition.id,
  };
}

function fail(owner: IRNode | undefined, composition: IRComposition, message: string): never {
  if (owner) {
    throw new ReferenceAudioConfigError(
      "CUT_AUDIO_RESOURCE_LIMIT",
      owner.id,
      `${owner.op} at ${sourceLabel(owner)} ${message}`,
      source(owner),
    );
  }
  const location = `${composition.provenance.module}:${composition.provenance.span.start.line}:${composition.provenance.span.start.column}`;
  throw new ReferenceAudioConfigError(
    "CUT_AUDIO_RESOURCE_LIMIT",
    composition.id,
    `timeline ${JSON.stringify(composition.name)} at ${location} ${message}`,
    compositionSource(composition),
  );
}

function exactCompositionSamples(composition: IRComposition) {
  const result = multiplyRational(composition.duration, rational(composition.sampleRate));
  if (result.denominator !== "1") return undefined;
  return BigInt(result.numerator);
}

function audioOwner(ir: CutAVIR, rootNodeIds: readonly string[]) {
  for (const id of rootNodeIds) {
    const node = ir.nodes[id];
    if (node && (node.domain === "audio" || node.domain === "av")) return node;
  }
  return undefined;
}

/**
 * The exact ordered roots expanded by the reference master-audio backend.
 * Derive these from executable composition/scene items rather than trusting a
 * unique-node reachability set: repeated roots and repeated child references
 * are independent backend work and must retain multiplicity.
 */
export function referenceAudioCompositionRootIds(ir: CutAVIR, composition: IRComposition) {
  const roots: string[] = [];
  for (const item of composition.items) {
    if (item.kind === "node" && (item.domain === "audio" || item.domain === "av")) roots.push(item.id);
  }
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (!scene) throw new Error(`Timeline “${composition.name}” references missing scene ${sceneId}.`);
    for (const item of scene.items) if (item.domain === "audio" || item.domain === "av") roots.push(item.id);
  }
  return roots;
}

/** IR-level preflight that runs during validateReferenceSession, before build. */
export function validateReferenceAudioCompositionResources(
  ir: CutAVIR,
  composition: IRComposition,
  rootNodeIds: readonly string[],
  expansionVisits: number,
) {
  const samples = exactCompositionSamples(composition);
  if (samples === undefined) return;
  const owner = audioOwner(ir, rootNodeIds);
  if (!Number.isSafeInteger(expansionVisits) || expansionVisits < 0) {
    fail(owner, composition, `has an invalid expanded audio graph visit count ${expansionVisits}.`);
  }
  const nodeChannelSamples = samples * 2n * BigInt(expansionVisits);
  if (nodeChannelSamples > referenceAudioBackendLimits.maximumExpandedNodeChannelSamples) {
    fail(owner, composition, `requires ${nodeChannelSamples} expanded audio node-channel-samples across ${expansionVisits} recursive graph visits; maximum is ${referenceAudioBackendLimits.maximumExpandedNodeChannelSamples}.`);
  }
  const pcmPayloadBytes = samples * 2n * 3n;
  if (pcmPayloadBytes > referenceAudioBackendLimits.maximumPcmPayloadBytes) {
    fail(owner, composition, `requires ${pcmPayloadBytes} bytes of stereo PCM24 output; maximum is ${referenceAudioBackendLimits.maximumPcmPayloadBytes} so the canonical WAVE artifact remains below 4 GiB without RF64.`);
  }
}

function utf8ArgumentBytes(value: string) {
  return Buffer.byteLength(value, "utf8") + 1;
}

export type ReferenceAudioBackendPlanCost = {
  filterEntries: number;
  filterGraphUtf8Bytes: number;
  argumentCount: number;
  argumentUtf8Bytes: number;
  maximumSingleArgumentUtf8Bytes: number;
};

export type ValidatedReferenceAudioBackendPlanCost = ReferenceAudioBackendPlanCost & {
  emittedFilterChannelSamples: bigint;
};

export function measureReferenceAudioBackendPlan(filters: readonly string[], args: readonly string[]): ReferenceAudioBackendPlanCost {
  const filterGraphUtf8Bytes = Buffer.byteLength(filters.join(";"), "utf8");
  let argumentUtf8Bytes = utf8ArgumentBytes("ffmpeg");
  let maximumSingleArgumentUtf8Bytes = argumentUtf8Bytes;
  for (const argument of args) {
    const size = utf8ArgumentBytes(argument);
    argumentUtf8Bytes += size;
    maximumSingleArgumentUtf8Bytes = Math.max(maximumSingleArgumentUtf8Bytes, size);
  }
  return {
    filterEntries: filters.length,
    filterGraphUtf8Bytes,
    argumentCount: args.length + 1,
    argumentUtf8Bytes,
    maximumSingleArgumentUtf8Bytes,
  };
}

/** Exact emitted-plan guard. It is called after graph construction and before spawn. */
export function validateReferenceAudioBackendPlan(
  owner: IRNode | undefined,
  composition: IRComposition,
  filters: readonly string[],
  args: readonly string[],
): ValidatedReferenceAudioBackendPlanCost {
  const cost = measureReferenceAudioBackendPlan(filters, args);
  if (cost.filterEntries > referenceAudioBackendLimits.maximumFilterEntries) {
    fail(owner, composition, `emits ${cost.filterEntries} backend filter entries; maximum is ${referenceAudioBackendLimits.maximumFilterEntries}.`);
  }
  if (cost.filterGraphUtf8Bytes > referenceAudioBackendLimits.maximumFilterGraphUtf8Bytes) {
    fail(owner, composition, `emits ${cost.filterGraphUtf8Bytes} UTF-8 bytes of backend filter graph; maximum is ${referenceAudioBackendLimits.maximumFilterGraphUtf8Bytes}.`);
  }
  const samples = exactCompositionSamples(composition);
  if (samples === undefined) fail(owner, composition, `does not have an exact output-sample duration for backend work budgeting.`);
  // Every emitted entry is conservatively charged as a stereo full-program
  // filter. This is intentionally tied to the recursively expanded backend
  // plan, not unique IR IDs; clauses that process mono or a shorter active
  // interval do not buy an unsafe graph more budget.
  const emittedFilterChannelSamples = samples * 2n * BigInt(cost.filterEntries);
  if (emittedFilterChannelSamples > referenceAudioBackendLimits.maximumEmittedFilterChannelSamples) {
    fail(owner, composition, `emits ${cost.filterEntries} backend filter entries across ${samples} samples, requiring ${emittedFilterChannelSamples} conservative filter-channel-samples; maximum is ${referenceAudioBackendLimits.maximumEmittedFilterChannelSamples}.`);
  }
  if (cost.argumentCount > referenceAudioBackendLimits.maximumArgumentCount) {
    fail(owner, composition, `emits ${cost.argumentCount} backend arguments; maximum is ${referenceAudioBackendLimits.maximumArgumentCount}.`);
  }
  if (cost.maximumSingleArgumentUtf8Bytes > referenceAudioBackendLimits.maximumSingleArgumentUtf8Bytes) {
    fail(owner, composition, `emits a ${cost.maximumSingleArgumentUtf8Bytes}-byte backend argument including its NUL terminator; maximum is ${referenceAudioBackendLimits.maximumSingleArgumentUtf8Bytes}.`);
  }
  if (cost.argumentUtf8Bytes > referenceAudioBackendLimits.maximumArgumentUtf8Bytes) {
    fail(owner, composition, `emits ${cost.argumentUtf8Bytes} UTF-8 argv bytes including NUL terminators; maximum is ${referenceAudioBackendLimits.maximumArgumentUtf8Bytes}.`);
  }
  return { ...cost, emittedFilterChannelSamples };
}

/** Private 0600 graph-script lifecycle shared by every reference audio spawn. */
export async function withReferenceAudioFilterScript<T>(
  filters: readonly string[],
  action: (path: string) => Promise<T>,
) {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-audio-graph-"));
  const path = resolve(directory, "graph.ffgraph");
  try {
    await writeFile(path, filters.join(";"), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
