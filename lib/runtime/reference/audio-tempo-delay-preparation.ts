import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { nodeReferences } from "../graph";
import {
  processReferenceTempoDelayStereo,
  referenceTempoDelayLimits,
  type ReferenceTempoDelayPlan,
  type ReferenceTempoDelayResult,
} from "./audio-tempo-delay";
import {
  referenceTempoDelayConfig,
  validateReferenceTempoDelayPlans,
  ReferenceTempoDelayConfigError,
} from "./audio-tempo-delay-config";

export type ReferenceAudioTempoDelayExecutionEvidence = Readonly<{
  format: "cut-reference-audio-tempo-delay-execution-evidence";
  version: 1;
  nodeId: string;
  algorithm: ReferenceTempoDelayPlan["algorithm"];
  planIntegrity: string;
  outputIntegrity: string;
  frames: number;
  delayedFrames: number;
  maximumAbsoluteOutputSample: number;
  integrity: string;
}>;

export type ReferenceAudioTempoDelayBuildEvidence = Readonly<{
  format: "cut-reference-audio-tempo-delay-build-evidence";
  version: 1;
  preparedExecutions: number;
  executions: readonly ReferenceAudioTempoDelayExecutionEvidence[];
  integrity: string;
}>;

export type ReferenceAudioTempoDelayPreparedSource = Readonly<{
  path: string;
  format: "raw-stereo-f32le";
  channels: 2;
  sampleRate: number;
  renderedSamples: number;
  evidence: ReferenceAudioTempoDelayExecutionEvidence;
}>;

export type ReferenceAudioTempoDelayPreparation = Readonly<{
  sources: Map<string, ReferenceAudioTempoDelayPreparedSource>;
  cleanup: () => Promise<void>;
}>;

export const referenceAudioTempoDelayEvidenceLimits = Object.freeze({
  maximumPreparedExecutions: 10_000,
});

type RenderTempoDelayChildren = (childIds: readonly string[], output: string) => Promise<void>;

function fail(node: IRNode, code: ReferenceTempoDelayConfigError["code"], message: string, cause?: unknown): never {
  throw new ReferenceTempoDelayConfigError(
    code,
    node.id,
    `${message} at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}.`,
    Object.freeze({
      module: node.provenance.module,
      line: node.provenance.span.start.line,
      column: node.provenance.span.start.column,
      nodeId: node.id,
    }),
    cause === undefined ? undefined : { cause },
  );
}

function frontierTempoDelayNodeIds(ir: CutAVIR, rootIds: readonly string[]) {
  const pending = [...rootIds], visited = new Set<string>(), result = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) throw new Error(`CUT_AUDIO_TEMPO_DELAY_GRAPH: audio graph references missing node ${id}.`);
    if (node.op === "cut.audio.tempo_delay") {
      result.add(id);
      continue;
    }
    // Each CUT-owned PCM materialization recursively owns processors below
    // its boundary. Stopping here avoids duplicate hidden executions.
    if (node.op === "cut.audio.limiter" || node.op === "cut.audio.time_stretch") continue;
    pending.push(...nodeReferences(node));
  }
  return [...result].sort();
}

function ioCode(error: unknown) {
  const value = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  return /^[A-Z0-9_]{1,64}$/u.test(value) ? value : "UNKNOWN";
}

async function readExactPrivateStereoF32(path: string, frames: number, node: IRNode) {
  const expectedBytes = frames * 8;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") fail(node, "CUT_AUDIO_TEMPO_DELAY_RESOURCE", "platform cannot bind the private TempoDelay child through a no-follow handle");
    const pathMetadata = await lstat(path);
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.size !== expectedBytes) {
      fail(node, "CUT_AUDIO_TEMPO_DELAY_PCM", `private TempoDelay child must be one direct ${expectedBytes}-byte stereo f32le file`);
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expectedBytes)) fail(node, "CUT_AUDIO_TEMPO_DELAY_PCM", `private TempoDelay child must contain exactly ${expectedBytes} bytes`);
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    if (bytes.byteLength !== expectedBytes
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      fail(node, "CUT_AUDIO_TEMPO_DELAY_PCM", "private TempoDelay child changed while CUT read its exact stereo f32le boundary");
    }
    const samples = new Float32Array(frames * 2);
    for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readFloatLE(index * 4);
    return samples;
  } catch (error) {
    if (error instanceof ReferenceTempoDelayConfigError) throw error;
    fail(node, "CUT_AUDIO_TEMPO_DELAY_PCM", `private TempoDelay child could not be read (${ioCode(error)})`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeExactPrivateStereoF32(path: string, result: ReferenceTempoDelayResult, node: IRNode) {
  const bytes = Buffer.allocUnsafe(result.samples.length * 4);
  for (let index = 0; index < result.samples.length; index += 1) {
    const sample = result.samples[index]!;
    if (!Number.isFinite(sample)) fail(node, "CUT_AUDIO_TEMPO_DELAY_PCM", `CUT-owned TempoDelay returned a non-finite sample at index ${index}`);
    bytes.writeFloatLE(sample, index * 4);
  }
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== result.frames * 8) {
    fail(node, "CUT_AUDIO_TEMPO_DELAY_PCM", "private TempoDelay output did not preserve the exact stereo frame boundary");
  }
}

function executionEvidence(
  node: IRNode,
  result: ReferenceTempoDelayResult,
  planIntegrity: string,
  algorithm: ReferenceTempoDelayPlan["algorithm"],
): ReferenceAudioTempoDelayExecutionEvidence {
  const content = Object.freeze({
    format: "cut-reference-audio-tempo-delay-execution-evidence" as const,
    version: 1 as const,
    nodeId: node.id,
    algorithm,
    planIntegrity,
    outputIntegrity: result.integrity,
    frames: result.frames,
    delayedFrames: result.delayedFrames,
    maximumAbsoluteOutputSample: result.maximumAbsoluteOutputSample,
  });
  return Object.freeze({ ...content, integrity: hash(content) });
}

function closedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors);
    return actual.length === keys.length
      && actual.every((key) => keys.includes(key) && "value" in descriptors[key]!);
  } catch {
    return false;
  }
}

function exactArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) return false;
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.entries(descriptors).every(([key, descriptor]) => key === "length"
      || (/^(?:0|[1-9]\d*)$/u.test(key) && "value" in descriptor));
  } catch {
    return false;
  }
}

export function isReferenceAudioTempoDelayExecutionEvidence(
  value: unknown,
): value is ReferenceAudioTempoDelayExecutionEvidence {
  if (!closedRecord(value, [
    "format", "version", "nodeId", "algorithm", "planIntegrity", "outputIntegrity",
    "frames", "delayedFrames", "maximumAbsoluteOutputSample", "integrity",
  ])
    || value.format !== "cut-reference-audio-tempo-delay-execution-evidence"
    || value.version !== 1
    || typeof value.nodeId !== "string"
    || value.nodeId.length < 1
    || value.nodeId.length > 512
    || value.algorithm !== "causal-recursive-stereo-f32-linear-fractional-read-v1"
    || typeof value.planIntegrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.planIntegrity)
    || typeof value.outputIntegrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.outputIntegrity)
    || !Number.isSafeInteger(value.frames)
    || (value.frames as number) < 1
    || (value.frames as number) > referenceTempoDelayLimits.maximumFrames
    || !Number.isSafeInteger(value.delayedFrames)
    || (value.delayedFrames as number) < 1
    || (value.delayedFrames as number) > (value.frames as number)
    || typeof value.maximumAbsoluteOutputSample !== "number"
    || !Number.isFinite(value.maximumAbsoluteOutputSample)
    || value.maximumAbsoluteOutputSample < 0
    || value.maximumAbsoluteOutputSample > referenceTempoDelayLimits.maximumAbsoluteInternalSample
    || typeof value.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.integrity)) return false;
  const content = { ...value } as Record<string, unknown>;
  delete content.integrity;
  return value.integrity === hash(content);
}

export function createReferenceAudioTempoDelayBuildEvidence(
  authored: readonly ReferenceAudioTempoDelayExecutionEvidence[],
): ReferenceAudioTempoDelayBuildEvidence {
  if (!exactArray(authored, referenceAudioTempoDelayEvidenceLimits.maximumPreparedExecutions)
    || authored.some((execution) => !isReferenceAudioTempoDelayExecutionEvidence(execution))) {
    throw new Error("CUT_AUDIO_TEMPO_DELAY_EVIDENCE: build evidence requires only closed integrity-valid TempoDelay executions.");
  }
  const executions = Object.freeze([...authored].sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.integrity.localeCompare(right.integrity)));
  const content = Object.freeze({
    format: "cut-reference-audio-tempo-delay-build-evidence" as const,
    version: 1 as const,
    preparedExecutions: executions.length,
    executions,
  });
  return Object.freeze({ ...content, integrity: hash(content) });
}

export function isReferenceAudioTempoDelayBuildEvidence(
  value: unknown,
): value is ReferenceAudioTempoDelayBuildEvidence {
  if (!closedRecord(value, ["format", "version", "preparedExecutions", "executions", "integrity"])
    || value.format !== "cut-reference-audio-tempo-delay-build-evidence"
    || value.version !== 1
    || !Number.isSafeInteger(value.preparedExecutions)
    || (value.preparedExecutions as number) < 0
    || (value.preparedExecutions as number) > referenceAudioTempoDelayEvidenceLimits.maximumPreparedExecutions
    || !exactArray(value.executions, referenceAudioTempoDelayEvidenceLimits.maximumPreparedExecutions)
    || typeof value.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.integrity)) return false;
  const executions = value.executions as unknown[];
  if (executions.length !== value.preparedExecutions
    || executions.some((execution) => !isReferenceAudioTempoDelayExecutionEvidence(execution))
    || executions.some((execution, index) => index > 0 && (
      (executions[index - 1] as ReferenceAudioTempoDelayExecutionEvidence).nodeId.localeCompare((execution as ReferenceAudioTempoDelayExecutionEvidence).nodeId) > 0
      || ((executions[index - 1] as ReferenceAudioTempoDelayExecutionEvidence).nodeId === (execution as ReferenceAudioTempoDelayExecutionEvidence).nodeId
        && (executions[index - 1] as ReferenceAudioTempoDelayExecutionEvidence).integrity.localeCompare((execution as ReferenceAudioTempoDelayExecutionEvidence).integrity) > 0)
    ))) return false;
  const content = { ...value } as Record<string, unknown>;
  delete content.integrity;
  return value.integrity === hash(content);
}

/** Materialize this render invocation's TempoDelay frontiers as private exact f32le. */
export async function prepareReferenceAudioTempoDelaySources(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  renderChildren: RenderTempoDelayChildren,
): Promise<ReferenceAudioTempoDelayPreparation> {
  validateReferenceTempoDelayPlans(ir, composition, rootIds);
  const ids = frontierTempoDelayNodeIds(ir, rootIds);
  if (!ids.length) return Object.freeze({ sources: new Map(), cleanup: async () => undefined });
  const directory = await mkdtemp(resolve(tmpdir(), "cut-audio-tempo-delay-"));
  await chmod(directory, 0o700);
  const sources = new Map<string, ReferenceAudioTempoDelayPreparedSource>();
  try {
    for (const [index, id] of ids.entries()) {
      const node = ir.nodes[id];
      if (!node) throw new Error(`CUT_AUDIO_TEMPO_DELAY_GRAPH: audio graph references missing node ${id}.`);
      const plan = referenceTempoDelayConfig(ir, composition, node);
      if (!plan) fail(node, "CUT_AUDIO_TEMPO_DELAY_GRAPH", "TempoDelay frontier has no executable plan");
      const base = `tempo-delay-${String(index).padStart(3, "0")}`;
      const childPath = resolve(directory, `${base}-child.f32le`), outputPath = resolve(directory, `${base}.f32le`);
      await renderChildren(node.children, childPath);
      const input = await readExactPrivateStereoF32(childPath, plan.tempo.totalFrames, node);
      let result: ReferenceTempoDelayResult;
      try { result = processReferenceTempoDelayStereo(input, plan); }
      catch (error) {
        if (error instanceof ReferenceTempoDelayConfigError) throw error;
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
          const message = "message" in error && typeof error.message === "string" ? error.message : "CUT-owned TempoDelay processor failed";
          fail(node, error.code as ReferenceTempoDelayConfigError["code"], message.replace(/^[A-Z0-9_]+: /u, ""), error);
        }
        throw error;
      }
      await writeExactPrivateStereoF32(outputPath, result, node);
      sources.set(node.id, Object.freeze({
        path: outputPath,
        format: "raw-stereo-f32le",
        channels: 2,
        sampleRate: composition.sampleRate,
        renderedSamples: result.frames,
        evidence: executionEvidence(node, result, plan.integrity, plan.algorithm),
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
