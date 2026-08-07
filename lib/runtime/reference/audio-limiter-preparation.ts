import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { multiplyRational, rational } from "../../language/rational";
import { cutGraphLimits, nodeReferences } from "../graph";
import { compileReferenceLimiterAutomations } from "./audio-automation";
import { referenceAudioNodeConfig } from "./audio-config";
import {
  assertReferenceAudioLimiterWorkContract,
  processReferenceAudioLimiter,
  referenceAudioLimiterIdentity,
  referenceAudioLimiterLimits,
  type ReferenceAudioLimiterResult,
  type ReferenceAudioLimiterSummary,
} from "./audio-limiter";
import {
  applyReferenceAudioLimiterUniformFileCorrection,
  assertReferenceAudioLimiterFileWorkContract,
  processReferenceAudioLimiterFile,
  referenceAudioLimiterFileLimits,
} from "./audio-limiter-file";
import {
  issueReferenceAudioLimiterCoreCutPeakWitness,
  issueReferenceAudioLimiterCorrectedCutPeakWitness,
  isReferenceAudioLimiterStaticCompatibilityReport,
  measureReferenceAudioLimiterStaticCompatibility,
  referenceAudioLimiterCompatibilityIdentity,
  type ReferenceAudioLimiterStaticCompatibilityReport,
} from "./audio-limiter-compatibility";
import type { ReferenceAudioPeakSource } from "./audio-peak";

export type ReferenceAudioLimiterCoreEvidence = Readonly<{
  format: "cut-reference-audio-limiter-core-evidence";
  version: 2;
  algorithm: ReferenceAudioLimiterResult["algorithm"];
  sampleRate: number;
  frames: number;
  lookaheadSamples: number;
  guardDb: number;
  execution: {
    mode: "in-memory" | "chunked-file";
    chunkFrames: number | null;
  };
  ceiling: {
    mode: ReferenceAudioLimiterResult["ceilingMode"];
    minimumDbtp: number | null;
    maximumDbtp: number | null;
  };
  gain: {
    minimumApplied: number;
    reconciliationFactor: number;
    minimumFinal: number;
  };
  outputTruePeak: {
    linear: number;
    dbtp: number | null;
    frame: number | null;
  };
  integrity: string;
}>;

export type ReferenceAudioLimiterPreparedSource = Readonly<{
  path: string;
  format: "raw-stereo-f32le";
  channels: 2;
  sampleRate: number;
  renderedSamples: number;
  core: ReferenceAudioLimiterCoreEvidence;
  evidence: ReferenceAudioLimiterExecutionEvidence;
}>;

export type ReferenceAudioLimiterExecutionEvidence = Readonly<{
  format: "cut-reference-audio-limiter-execution-evidence";
  version: 1;
  core: ReferenceAudioLimiterCoreEvidence;
  authoredCeilingMode: "static" | "dynamic";
  compatibility:
    | {
      status: "verified-static";
      policy: typeof referenceAudioLimiterCompatibilityIdentity;
      correctionFactor: number;
      passes: readonly ReferenceAudioLimiterStaticCompatibilityReport[];
    }
    | {
      status: "not-applicable-dynamic-ceiling";
      policy: typeof referenceAudioLimiterCompatibilityIdentity;
    };
  minimumFinalGain: number;
  integrity: string;
}>;

export type ReferenceAudioLimiterBuildEvidence = Readonly<{
  format: "cut-reference-audio-limiter-build-evidence";
  version: 1;
  preparedExecutions: number;
  executions: readonly ReferenceAudioLimiterExecutionEvidence[];
  integrity: string;
}>;

export const referenceAudioLimiterEvidenceLimits = Object.freeze({
  maximumPreparedExecutions: 10_000,
});

export type ReferenceAudioLimiterPreparation = Readonly<{
  sources: Map<string, ReferenceAudioLimiterPreparedSource>;
  cleanup: () => Promise<void>;
}>;

export type ReferenceAudioLimiterPreparationErrorCode =
  | "CUT_AUDIO_LIMITER_GRAPH"
  | "CUT_AUDIO_LIMITER_SOURCE"
  | "CUT_AUDIO_LIMITER_WORK_LIMIT"
  | "CUT_AUDIO_LIMITER_COMPATIBILITY";

export class ReferenceAudioLimiterPreparationError extends Error {
  readonly source: ReferenceAudioPeakSource;

  constructor(
    readonly code: ReferenceAudioLimiterPreparationErrorCode,
    node: IRNode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceAudioLimiterPreparationError";
    this.source = Object.freeze({
      module: node.provenance.module,
      line: node.provenance.span.start.line,
      column: node.provenance.span.start.column,
      nodeId: node.id,
    });
  }
}

type RenderLimiterChildren = (
  childIds: readonly string[],
  output: string,
) => Promise<void>;

type LimiterPlan = Readonly<{
  node: IRNode;
  childIds: readonly string[];
  sampleRate: number;
  frames: number;
  lookaheadSamples: number;
  authoredCeilingMode: "static" | "dynamic";
  staticCeilingDbtp?: number;
  ceilingDbtp: (frame: number) => number;
  releaseSeconds: (frame: number) => number;
}>;

function fail(
  node: IRNode,
  code: ReferenceAudioLimiterPreparationErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new ReferenceAudioLimiterPreparationError(
    code,
    node,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactCompositionFrames(composition: IRComposition, owner: IRNode) {
  const exact = multiplyRational(composition.duration, rational(composition.sampleRate));
  if (exact.denominator !== "1") {
    fail(owner, "CUT_AUDIO_LIMITER_GRAPH", `owning timeline duration does not land on the ${composition.sampleRate} Hz sample grid.`);
  }
  const frames = Number(exact.numerator);
  if (!Number.isSafeInteger(frames) || frames < 1) {
    fail(owner, "CUT_AUDIO_LIMITER_GRAPH", "owning timeline has an invalid exact sample count.");
  }
  return frames;
}

const referenceAudioLimiterMaterializationAuditLimits = Object.freeze({
  maximumNodeVisits: 1_000_000,
  maximumContexts: 100_000,
  maximumDepth: cutGraphLimits.maxDepth,
});

const referenceAudioMaterializationBoundaryOps = new Set([
  "cut.audio.limiter",
  "cut.audio.time_stretch",
  "cut.audio.tempo_delay",
]);

/**
 * Count the limiter sources that the recursive reference renderer will
 * actually materialize. One render context deduplicates every processor
 * frontier by node id; a processor's private child render creates a new
 * context in which the same limiter id is charged again when reuse is no
 * longer valid.
 */
function materializedLimiterInvocations(ir: CutAVIR, rootIds: readonly string[]) {
  const limiterInvocations = new Map<string, number>();
  const activeBoundaries = new Set<string>();
  let nodeVisits = 0;
  let contexts = 0;
  let materializedExecutions = 0;

  const visitContext = (contextRootIds: readonly string[], depth = 1, contextOwner?: IRNode) => {
    contexts += 1;
    const owner = contextRootIds.map((id) => ir.nodes[id]).find((node): node is IRNode => Boolean(node)) ?? contextOwner;
    if (depth > referenceAudioLimiterMaterializationAuditLimits.maximumDepth) {
      if (owner) {
        fail(
          owner,
          "CUT_AUDIO_LIMITER_WORK_LIMIT",
          `limiter materialization exceeds the bounded processor-context depth ${referenceAudioLimiterMaterializationAuditLimits.maximumDepth}.`,
        );
      }
      throw new Error(`CUT_AUDIO_LIMITER_WORK_LIMIT: limiter materialization exceeds the bounded processor-context depth ${referenceAudioLimiterMaterializationAuditLimits.maximumDepth}.`);
    }
    if (contexts > referenceAudioLimiterMaterializationAuditLimits.maximumContexts) {
      if (owner) {
        fail(
          owner,
          "CUT_AUDIO_LIMITER_WORK_LIMIT",
          `limiter materialization audit exceeded ${referenceAudioLimiterMaterializationAuditLimits.maximumContexts} recursive processor contexts.`,
        );
      }
      throw new Error("CUT_AUDIO_LIMITER_WORK_LIMIT: limiter materialization audit exceeded its bounded recursive processor contexts.");
    }

    const pending = contextRootIds.map((id) => ({ id, referrer: contextOwner }));
    const visited = new Set<string>();
    const frontier = new Map<string, IRNode>();
    while (pending.length) {
      const { id, referrer } = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      nodeVisits += 1;
      const node = ir.nodes[id];
      if (!node) {
        if (referrer) fail(referrer, "CUT_AUDIO_LIMITER_GRAPH", `audio graph references missing node ${id}.`);
        throw new Error(`CUT_AUDIO_LIMITER_GRAPH: audio graph references missing root node ${id}.`);
      }
      if (nodeVisits > referenceAudioLimiterMaterializationAuditLimits.maximumNodeVisits) {
        fail(
          node,
          "CUT_AUDIO_LIMITER_WORK_LIMIT",
          `limiter materialization audit exceeded ${referenceAudioLimiterMaterializationAuditLimits.maximumNodeVisits} bounded node visits.`,
        );
      }
      if (referenceAudioMaterializationBoundaryOps.has(node.op)) {
        frontier.set(node.id, node);
        continue;
      }
      pending.push(...nodeReferences(node).map((referencedId) => ({ id: referencedId, referrer: node })));
    }

    for (const node of [...frontier.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      if (activeBoundaries.has(node.id)) {
        fail(
          node,
          "CUT_AUDIO_LIMITER_GRAPH",
          "recursive audio processor materialization contains a cycle.",
        );
      }
      if (node.op === "cut.audio.limiter") {
        materializedExecutions += 1;
        if (materializedExecutions > referenceAudioLimiterEvidenceLimits.maximumPreparedExecutions) {
          fail(
            node,
            "CUT_AUDIO_LIMITER_WORK_LIMIT",
            `limiter materialization requires more than ${referenceAudioLimiterEvidenceLimits.maximumPreparedExecutions} prepared executions, exceeding the closed build-evidence domain.`,
          );
        }
        const next = (limiterInvocations.get(node.id) ?? 0) + 1;
        if (!Number.isSafeInteger(next)) {
          fail(node, "CUT_AUDIO_LIMITER_WORK_LIMIT", "limiter materialization count exceeds the safe integer domain.");
        }
        limiterInvocations.set(node.id, next);
      }
      activeBoundaries.add(node.id);
      visitContext(node.children, depth + 1, node);
      activeBoundaries.delete(node.id);
    }
  };

  visitContext(rootIds);
  return limiterInvocations;
}

/**
 * Return only limiter boundaries owned by this render invocation. Descendants
 * of another limiter are prepared recursively with that limiter's child mix;
 * descendants of TimeStretch are owned by the stretch child-render boundary.
 */
function frontierLimiterNodeIds(ir: CutAVIR, rootIds: readonly string[]) {
  const pending = [...rootIds];
  const visited = new Set<string>();
  const limiterIds = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) throw new Error(`CUT_AUDIO_LIMITER_GRAPH: audio graph references missing node ${id}.`);
    if (node.op === "cut.audio.limiter") {
      limiterIds.add(id);
      continue;
    }
    if (node.op === "cut.audio.time_stretch" || node.op === "cut.audio.tempo_delay") continue;
    pending.push(...nodeReferences(node));
  }
  return [...limiterIds].sort();
}

function limiterPlan(ir: CutAVIR, composition: IRComposition, node: IRNode): LimiterPlan {
  const config = referenceAudioNodeConfig(ir, composition, node);
  if (config?.kind !== "limiter") {
    fail(node, "CUT_AUDIO_LIMITER_GRAPH", "limiter node does not have one closed runtime configuration.");
  }
  const frames = exactCompositionFrames(composition, node);
  const work = {
    expectedFrames: frames,
    sampleRate: composition.sampleRate,
    lookaheadSamples: config.lookaheadSamples,
    source: {
      module: node.provenance.module,
      line: node.provenance.span.start.line,
      column: node.provenance.span.start.column,
      nodeId: node.id,
    },
  };
  if (frames <= referenceAudioLimiterLimits.maximumFrames) {
    assertReferenceAudioLimiterWorkContract(work);
  } else {
    assertReferenceAudioLimiterFileWorkContract(work);
  }
  const automation = compileReferenceLimiterAutomations(ir, composition, node);
  return Object.freeze({
    node,
    childIds: Object.freeze([...node.children]),
    sampleRate: composition.sampleRate,
    frames,
    lookaheadSamples: config.lookaheadSamples,
    authoredCeilingMode: automation.ceiling ? "dynamic" : "static",
    ...(automation.ceiling ? {} : { staticCeilingDbtp: config.ceilingDbtp }),
    ceilingDbtp: automation.ceiling?.valueAtSample ?? (() => config.ceilingDbtp),
    releaseSeconds: automation.release?.valueAtSample ?? (() => config.releaseSeconds),
  });
}

/** Validate every reachable limiter before any recursive DSP preparation. */
export function validateReferenceAudioLimiterPlans(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
) {
  const invocations = materializedLimiterInvocations(ir, rootIds);
  const ids = [...invocations.keys()].sort();
  if (!ids.length) return [];
  const plans = ids.map((id) => {
    const node = ir.nodes[id];
    if (!node) throw new Error(`CUT_AUDIO_LIMITER_GRAPH: audio graph references missing node ${id}.`);
    return limiterPlan(ir, composition, node);
  });
  const firMultiplyAdds = plans.reduce(
    (total, plan) => total
      + plan.frames
      * referenceAudioLimiterLimits.firMultiplyAddsPerFrame
      * referenceAudioLimiterLimits.maximumFirPasses
      * invocations.get(plan.node.id)!,
    0,
  );
  const allInMemory = plans.every((plan) => plan.frames <= referenceAudioLimiterLimits.maximumFrames);
  const aggregateLimit = allInMemory
    ? referenceAudioLimiterLimits.maximumFirMultiplyAdds
    : referenceAudioLimiterFileLimits.maximumAggregateFirMultiplyAdds;
  if (!Number.isSafeInteger(firMultiplyAdds) || firMultiplyAdds > aggregateLimit) {
    fail(
      plans[0]!.node,
      "CUT_AUDIO_LIMITER_WORK_LIMIT",
      `reachable limiter graph requires ${Number.isSafeInteger(firMultiplyAdds) ? firMultiplyAdds : "an unsafe number of"} FIR multiply-adds across ${[...invocations.values()].reduce((sum, count) => sum + count, 0)} materialized executions; maximum for the selected ${allInMemory ? "in-memory" : "chunk-backed"} domain is ${aggregateLimit}.`,
    );
  }
  return plans;
}

function ioCode(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "UNKNOWN";
}

async function readExactPrivateF32(path: string, plan: LimiterPlan) {
  const expectedBytes = plan.frames * 8;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      fail(plan.node, "CUT_AUDIO_LIMITER_SOURCE", "platform cannot bind the private limiter child to a no-follow handle.");
    }
    const pathMetadata = await lstat(path);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.size !== expectedBytes) {
      fail(plan.node, "CUT_AUDIO_LIMITER_SOURCE", `private child must be one direct ${expectedBytes}-byte stereo f32le file.`);
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expectedBytes)) {
      fail(plan.node, "CUT_AUDIO_LIMITER_SOURCE", `private child must contain exactly ${expectedBytes} bytes.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.byteLength !== expectedBytes
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      fail(plan.node, "CUT_AUDIO_LIMITER_SOURCE", "private child changed while CUT read its exact stereo f32le boundary.");
    }
    const samples = new Float32Array(plan.frames * 2);
    for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readFloatLE(index * 4);
    return samples;
  } catch (error) {
    if (error instanceof ReferenceAudioLimiterPreparationError) throw error;
    fail(plan.node, "CUT_AUDIO_LIMITER_SOURCE", `private child could not be read (${ioCode(error)}).`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function encodeExactPrivateF32(samples: Float32Array, plan: LimiterPlan) {
  if (samples.length !== plan.frames * 2) {
    fail(plan.node, "CUT_AUDIO_LIMITER_SOURCE", "CUT-owned limiter returned an invalid stereo frame count.");
  }
  const output = Buffer.allocUnsafe(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    if (!Number.isFinite(value)) {
      fail(plan.node, "CUT_AUDIO_LIMITER_SOURCE", `CUT-owned limiter returned a non-finite sample at index ${index}.`);
    }
    output.writeFloatLE(value, index * 4);
  }
  return output;
}

function closedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Object.keys(descriptors);
    return ownKeys.length === keys.length
      && ownKeys.every((key) => keys.includes(key) && "value" in descriptors[key]);
  } catch {
    return false;
  }
}

function finiteUnit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Closed path-free validator used before persisted cache evidence is trusted. */
export function isReferenceAudioLimiterCoreEvidence(value: unknown): value is ReferenceAudioLimiterCoreEvidence {
  if (!closedRecord(value, ["format", "version", "algorithm", "sampleRate", "frames", "lookaheadSamples", "guardDb", "execution", "ceiling", "gain", "outputTruePeak", "integrity"])) return false;
  if (value.format !== "cut-reference-audio-limiter-core-evidence"
    || value.version !== 2
    || value.algorithm !== referenceAudioLimiterIdentity
    || value.sampleRate !== referenceAudioLimiterLimits.supportedSampleRate
    || !Number.isSafeInteger(value.frames)
    || (value.frames as number) < 0
    || (value.frames as number) > referenceAudioLimiterFileLimits.maximumFrames
    || !Number.isSafeInteger(value.lookaheadSamples)
    || (value.lookaheadSamples as number) < 0
    || (value.lookaheadSamples as number) > referenceAudioLimiterLimits.maximumLookaheadSamples
    || value.guardDb !== referenceAudioLimiterLimits.guardDb
    || typeof value.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.integrity)) return false;
  if (!closedRecord(value.execution, ["mode", "chunkFrames"])) return false;
  const longForm = (value.frames as number) > referenceAudioLimiterLimits.maximumFrames;
  if (longForm
    ? value.execution.mode !== "chunked-file"
      || value.execution.chunkFrames !== referenceAudioLimiterFileLimits.chunkFrames
    : value.execution.mode !== "in-memory"
      || value.execution.chunkFrames !== null) return false;
  if (!closedRecord(value.ceiling, ["mode", "minimumDbtp", "maximumDbtp"])
    || (value.ceiling.mode !== "static" && value.ceiling.mode !== "dynamic")) return false;
  const minimum = value.ceiling.minimumDbtp;
  const maximum = value.ceiling.maximumDbtp;
  if (value.frames === 0) {
    if (minimum !== null || maximum !== null || value.ceiling.mode !== "static") return false;
  } else if (typeof minimum !== "number"
    || typeof maximum !== "number"
    || !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || minimum < referenceAudioLimiterLimits.minimumCeilingDbtp
    || maximum > referenceAudioLimiterLimits.maximumCeilingDbtp
    || minimum > maximum
    || (value.ceiling.mode === "static" ? minimum !== maximum : minimum === maximum)) return false;
  if (!closedRecord(value.gain, ["minimumApplied", "reconciliationFactor", "minimumFinal"])
    || !finiteUnit(value.gain.minimumApplied)
    || !finiteUnit(value.gain.reconciliationFactor)
    || !finiteUnit(value.gain.minimumFinal)
    || value.gain.minimumFinal !== (value.gain.minimumApplied as number) * (value.gain.reconciliationFactor as number)) return false;
  if (!closedRecord(value.outputTruePeak, ["linear", "dbtp", "frame"])
    || typeof value.outputTruePeak.linear !== "number"
    || !Number.isFinite(value.outputTruePeak.linear)
    || value.outputTruePeak.linear < 0
    || value.outputTruePeak.linear > referenceAudioLimiterLimits.maximumEnvelopeLinear) return false;
  if (value.outputTruePeak.linear === 0) {
    if (value.outputTruePeak.dbtp !== null || value.outputTruePeak.frame !== null) return false;
  } else if (typeof value.outputTruePeak.dbtp !== "number"
    || !Number.isFinite(value.outputTruePeak.dbtp)
    || value.outputTruePeak.dbtp !== 20 * Math.log10(value.outputTruePeak.linear)
    || !Number.isSafeInteger(value.outputTruePeak.frame)
    || (value.outputTruePeak.frame as number) < 0
    || (value.outputTruePeak.frame as number) >= (value.frames as number)) return false;
  const content = { ...value } as Record<string, unknown>;
  delete content.integrity;
  return value.integrity === hash(content);
}

export function createReferenceAudioLimiterCoreEvidence(
  result: ReferenceAudioLimiterResult | ReferenceAudioLimiterSummary,
): ReferenceAudioLimiterCoreEvidence {
  const content = Object.freeze({
    format: "cut-reference-audio-limiter-core-evidence" as const,
    version: 2 as const,
    algorithm: result.algorithm,
    sampleRate: result.sampleRate,
    frames: result.frames,
    lookaheadSamples: result.lookaheadSamples,
    guardDb: result.guardDb,
    execution: Object.freeze(result.frames > referenceAudioLimiterLimits.maximumFrames
      ? {
        mode: "chunked-file" as const,
        chunkFrames: referenceAudioLimiterFileLimits.chunkFrames,
      }
      : {
        mode: "in-memory" as const,
        chunkFrames: null,
      }),
    ceiling: Object.freeze({
      mode: result.ceilingMode,
      minimumDbtp: result.minimumCeilingDbtp,
      maximumDbtp: result.maximumCeilingDbtp,
    }),
    gain: Object.freeze({
      minimumApplied: result.minimumAppliedGain,
      reconciliationFactor: result.reconciliationFactor,
      minimumFinal: result.minimumFinalGain,
    }),
    outputTruePeak: Object.freeze({
      linear: result.maximumOutputTruePeakLinear,
      dbtp: result.maximumOutputTruePeakDbtp,
      frame: result.maximumOutputTruePeakFrame,
    }),
  });
  return Object.freeze({ ...content, integrity: hash(content) });
}

function exactArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) return false;
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.entries(descriptors).every(([key, descriptor]) => key === "length" || (/^(?:0|[1-9]\d*)$/u.test(key) && "value" in descriptor));
  } catch {
    return false;
  }
}

export function isReferenceAudioLimiterExecutionEvidence(value: unknown): value is ReferenceAudioLimiterExecutionEvidence {
  if (!closedRecord(value, ["format", "version", "core", "authoredCeilingMode", "compatibility", "minimumFinalGain", "integrity"])
    || value.format !== "cut-reference-audio-limiter-execution-evidence"
    || value.version !== 1
    || !isReferenceAudioLimiterCoreEvidence(value.core)
    || (value.authoredCeilingMode !== "static" && value.authoredCeilingMode !== "dynamic")
    || typeof value.minimumFinalGain !== "number"
    || !Number.isFinite(value.minimumFinalGain)
    || value.minimumFinalGain < 0
    || value.minimumFinalGain > 1
    || typeof value.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.integrity)) return false;
  if (value.authoredCeilingMode === "dynamic") {
    if (!closedRecord(value.compatibility, ["status", "policy"])
      || value.compatibility.status !== "not-applicable-dynamic-ceiling"
      || value.compatibility.policy !== referenceAudioLimiterCompatibilityIdentity
      || value.minimumFinalGain !== value.core.gain.minimumFinal) return false;
  } else {
    if (!closedRecord(value.compatibility, ["status", "policy", "correctionFactor", "passes"])
      || value.compatibility.status !== "verified-static"
      || value.compatibility.policy !== referenceAudioLimiterCompatibilityIdentity
      || typeof value.compatibility.correctionFactor !== "number"
      || !Number.isFinite(value.compatibility.correctionFactor)
      || value.compatibility.correctionFactor <= 0
      || value.compatibility.correctionFactor > 1
      || !exactArray(value.compatibility.passes, 2)
      || value.compatibility.passes.length < 1
      || value.compatibility.passes.some((report) => !isReferenceAudioLimiterStaticCompatibilityReport(report))
      || value.core.ceiling.mode !== "static"
      || value.core.ceiling.minimumDbtp === null
      || value.core.ceiling.minimumDbtp !== value.core.ceiling.maximumDbtp
      || value.minimumFinalGain !== value.core.gain.minimumFinal * value.compatibility.correctionFactor) return false;
    const passes = value.compatibility.passes as ReferenceAudioLimiterStaticCompatibilityReport[];
    const initial = passes[0];
    const final = passes.at(-1)!;
    if (initial.targetCeilingDbtp !== value.core.ceiling.minimumDbtp
      || initial.boundary.sampleRate !== value.core.sampleRate
      || initial.boundary.expectedFrames !== value.core.frames
      || initial.boundary.suffixBytesExcluded !== 0
      || initial.cut.truePeakLinear !== value.core.outputTruePeak.linear
      || initial.cut.truePeakDbtp !== value.core.outputTruePeak.dbtp
      || initial.correctionFactor !== value.compatibility.correctionFactor
      || passes.some((report) => report.targetCeilingDbtp !== initial.targetCeilingDbtp
        || report.boundary.sampleRate !== initial.boundary.sampleRate
        || report.boundary.expectedFrames !== initial.boundary.expectedFrames
        || report.boundary.suffixBytesExcluded !== 0
        || report.toolchain.integrity !== initial.toolchain.integrity)) return false;
    if (value.compatibility.correctionFactor < 1) {
      if (passes.length !== 2
        || final.correctionFactor !== 1
        || final.boundary.sha256 === initial.boundary.sha256) return false;
    } else if (passes.length !== 1 || final !== initial) return false;
  }
  const content = { ...value } as Record<string, unknown>;
  delete content.integrity;
  return value.integrity === hash(content);
}

export function createReferenceAudioLimiterBuildEvidence(
  authoredExecutions: readonly ReferenceAudioLimiterExecutionEvidence[],
): ReferenceAudioLimiterBuildEvidence {
  if (!exactArray(authoredExecutions, referenceAudioLimiterEvidenceLimits.maximumPreparedExecutions)
    || authoredExecutions.some((execution) => !isReferenceAudioLimiterExecutionEvidence(execution))) {
    throw new Error("CUT_AUDIO_LIMITER_EVIDENCE: limiter build evidence requires only closed integrity-valid executions.");
  }
  const executions = Object.freeze([...authoredExecutions].sort((left, right) => left.integrity.localeCompare(right.integrity)));
  const content = Object.freeze({
    format: "cut-reference-audio-limiter-build-evidence" as const,
    version: 1 as const,
    preparedExecutions: executions.length,
    executions,
  });
  return Object.freeze({ ...content, integrity: hash(content) });
}

export function isReferenceAudioLimiterBuildEvidence(value: unknown): value is ReferenceAudioLimiterBuildEvidence {
  if (!closedRecord(value, ["format", "version", "preparedExecutions", "executions", "integrity"])
    || value.format !== "cut-reference-audio-limiter-build-evidence"
    || value.version !== 1
    || !Number.isSafeInteger(value.preparedExecutions)
    || (value.preparedExecutions as number) < 0
    || (value.preparedExecutions as number) > referenceAudioLimiterEvidenceLimits.maximumPreparedExecutions
    || !exactArray(value.executions, referenceAudioLimiterEvidenceLimits.maximumPreparedExecutions)
    || typeof value.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.integrity)) return false;
  const executions = value.executions as unknown[];
  if (executions.length !== value.preparedExecutions
    || executions.some((execution) => !isReferenceAudioLimiterExecutionEvidence(execution))
    || executions.some((execution, index) => index > 0
      && (executions[index - 1] as ReferenceAudioLimiterExecutionEvidence).integrity.localeCompare((execution as ReferenceAudioLimiterExecutionEvidence).integrity) > 0)) return false;
  const content = { ...value } as Record<string, unknown>;
  delete content.integrity;
  return value.integrity === hash(content);
}

function planSource(plan: LimiterPlan): ReferenceAudioPeakSource {
  return Object.freeze({
    module: plan.node.provenance.module,
    line: plan.node.provenance.span.start.line,
    column: plan.node.provenance.span.start.column,
    nodeId: plan.node.id,
  });
}

async function writeExactPrivateF32(path: string, samples: Float32Array, plan: LimiterPlan) {
  await writeFile(path, encodeExactPrivateF32(samples, plan), { flag: "wx", mode: 0o600 });
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== plan.frames * 8) {
    fail(plan.node, "CUT_AUDIO_LIMITER_SOURCE", "private limiter output did not preserve the exact stereo frame boundary.");
  }
}

function executionEvidence(
  core: ReferenceAudioLimiterCoreEvidence,
  plan: LimiterPlan,
  compatibility:
    | Extract<ReferenceAudioLimiterExecutionEvidence["compatibility"], { status: "verified-static" }>
    | Extract<ReferenceAudioLimiterExecutionEvidence["compatibility"], { status: "not-applicable-dynamic-ceiling" }>,
): ReferenceAudioLimiterExecutionEvidence {
  const correctionFactor = compatibility.status === "verified-static" ? compatibility.correctionFactor : 1;
  const content = Object.freeze({
    format: "cut-reference-audio-limiter-execution-evidence" as const,
    version: 1 as const,
    core,
    authoredCeilingMode: plan.authoredCeilingMode,
    compatibility,
    minimumFinalGain: core.gain.minimumFinal * correctionFactor,
  });
  return Object.freeze({ ...content, integrity: hash(content) });
}

/**
 * Materialize the current invocation's limiter frontiers as private exact-f32
 * sources. No codec or media filter implements the limiter control law.
 */
export async function prepareReferenceAudioLimiterSources(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  renderChildren: RenderLimiterChildren,
): Promise<ReferenceAudioLimiterPreparation> {
  const ids = frontierLimiterNodeIds(ir, rootIds);
  if (!ids.length) return Object.freeze({ sources: new Map(), cleanup: async () => undefined });
  const directory = await mkdtemp(resolve(tmpdir(), "cut-audio-limiter-"));
  await chmod(directory, 0o700);
  const sources = new Map<string, ReferenceAudioLimiterPreparedSource>();
  try {
    for (const [index, id] of ids.entries()) {
      const node = ir.nodes[id];
      if (!node) throw new Error(`CUT_AUDIO_LIMITER_GRAPH: audio graph references missing node ${id}.`);
      const plan = limiterPlan(ir, composition, node);
      const base = `limiter-${String(index).padStart(3, "0")}`;
      const childPath = resolve(directory, `${base}-child.f32le`);
      const coreOutputPath = resolve(directory, `${base}-core.f32le`);
      const reconciledOutputPath = resolve(directory, `${base}.f32le`);
      await renderChildren(plan.childIds, childPath);
      const longForm = plan.frames > referenceAudioLimiterLimits.maximumFrames;
      const processOptions = {
        expectedFrames: plan.frames,
        sampleRate: plan.sampleRate,
        lookaheadSamples: plan.lookaheadSamples,
        ceilingDbtp: plan.ceilingDbtp,
        releaseSeconds: plan.releaseSeconds,
        source: planSource(plan),
      };
      const inMemoryResult = longForm
        ? undefined
        : processReferenceAudioLimiter(await readExactPrivateF32(childPath, plan), {
          sampleRate: plan.sampleRate,
          lookaheadSamples: plan.lookaheadSamples,
          ceilingDbtp: plan.ceilingDbtp,
          releaseSeconds: plan.releaseSeconds,
          source: planSource(plan),
        });
      const result: ReferenceAudioLimiterResult | ReferenceAudioLimiterSummary = inMemoryResult
        ?? await processReferenceAudioLimiterFile(childPath, coreOutputPath, processOptions);
      const core = createReferenceAudioLimiterCoreEvidence(result);
      if (inMemoryResult) await writeExactPrivateF32(coreOutputPath, inMemoryResult.output, plan);
      let outputPath = coreOutputPath;
      let evidence: ReferenceAudioLimiterExecutionEvidence;
      if (plan.authoredCeilingMode === "static") {
        const targetCeilingDbtp = plan.staticCeilingDbtp;
        if (targetCeilingDbtp === undefined) {
          fail(plan.node, "CUT_AUDIO_LIMITER_COMPATIBILITY", "static limiter plan has no exact authored ceiling.");
        }
        const coreCutPeakWitness = await issueReferenceAudioLimiterCoreCutPeakWitness(coreOutputPath, {
          producer: result,
          coreEvidenceIntegrity: core.integrity,
          source: planSource(plan),
        });
        const initial = await measureReferenceAudioLimiterStaticCompatibility(coreOutputPath, {
          expectedFrames: plan.frames,
          sampleRate: plan.sampleRate,
          targetCeilingDbtp,
          source: planSource(plan),
        }, coreCutPeakWitness);
        if (initial.boundary.suffixBytesExcluded !== 0
          || initial.cut.truePeakLinear !== core.outputTruePeak.linear
          || initial.cut.truePeakDbtp !== core.outputTruePeak.dbtp) {
          fail(plan.node, "CUT_AUDIO_LIMITER_COMPATIBILITY", "static compatibility meter did not bind to the exact CUT core output.");
        }
        const passes: ReferenceAudioLimiterStaticCompatibilityReport[] = [initial];
        if (initial.correctionFactor < 1) {
          const correction = await applyReferenceAudioLimiterUniformFileCorrection(
            coreOutputPath,
            reconciledOutputPath,
            {
              expectedFrames: plan.frames,
              factor: initial.correctionFactor,
              source: planSource(plan),
            },
          );
          const correctedCutPeakWitness = await issueReferenceAudioLimiterCorrectedCutPeakWitness(
            reconciledOutputPath,
            {
              coreWitness: coreCutPeakWitness,
              correction,
              source: planSource(plan),
            },
          );
          const final = await measureReferenceAudioLimiterStaticCompatibility(reconciledOutputPath, {
            expectedFrames: plan.frames,
            sampleRate: plan.sampleRate,
            targetCeilingDbtp,
            source: planSource(plan),
          }, correctedCutPeakWitness);
          if (final.boundary.suffixBytesExcluded !== 0
            || final.correctionFactor !== 1
            || final.toolchain.integrity !== initial.toolchain.integrity) {
            fail(plan.node, "CUT_AUDIO_LIMITER_COMPATIBILITY", "one bounded static correction did not satisfy both peak authorities with one unchanged toolchain.");
          }
          passes.push(final);
          outputPath = reconciledOutputPath;
        }
        const compatibility = Object.freeze({
          status: "verified-static" as const,
          policy: referenceAudioLimiterCompatibilityIdentity,
          correctionFactor: initial.correctionFactor,
          passes: Object.freeze(passes),
        });
        evidence = executionEvidence(core, plan, compatibility);
      } else {
        evidence = executionEvidence(core, plan, Object.freeze({
          status: "not-applicable-dynamic-ceiling" as const,
          policy: referenceAudioLimiterCompatibilityIdentity,
        }));
      }
      sources.set(plan.node.id, Object.freeze({
        path: outputPath,
        format: "raw-stereo-f32le",
        channels: 2,
        sampleRate: plan.sampleRate,
        renderedSamples: plan.frames,
        core,
        evidence,
      }));
    }
    let cleaned = false;
    return Object.freeze({
      sources,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
