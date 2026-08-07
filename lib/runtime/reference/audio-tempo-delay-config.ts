import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { multiplyRational, rational, rationalToNumber, type Rational } from "../../language/rational";
import { nodeReferences } from "../graph";
import {
  compileReferenceTempoDelayPlan,
  compileReferenceTempoMap,
  referenceTempoDelayLimits,
  ReferenceTempoDelayError,
  type ReferenceTempoDelayPlan,
  type ReferenceTempoPoint,
} from "./audio-tempo-delay";

export type ReferenceTempoDelayConfigSource = Readonly<{
  module: string;
  line: number;
  column: number;
  nodeId: string;
}>;

export class ReferenceTempoDelayConfigError extends Error {
  constructor(
    readonly code: ReferenceTempoDelayError["code"] | "CUT_AUDIO_TEMPO_DELAY_GRAPH",
    readonly nodeId: string,
    message: string,
    readonly source: ReferenceTempoDelayConfigSource,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceTempoDelayConfigError";
  }
}

function source(node: IRNode): ReferenceTempoDelayConfigSource {
  return Object.freeze({
    module: node.provenance.module,
    line: node.provenance.span.start.line,
    column: node.provenance.span.start.column,
    nodeId: node.id,
  });
}

function fail(
  node: IRNode,
  code: ReferenceTempoDelayConfigError["code"],
  message: string,
  cause?: unknown,
): never {
  throw new ReferenceTempoDelayConfigError(
    code,
    node.id,
    `${message} at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}.`,
    source(node),
    cause === undefined ? undefined : { cause },
  );
}

function exactCompositionFrames(node: IRNode, composition: IRComposition) {
  const exact = multiplyRational(composition.duration, rational(composition.sampleRate));
  if (exact.denominator !== "1") fail(node, "CUT_AUDIO_TEMPO_MAP_SAMPLE_GRID", `Timeline “${composition.name}” duration does not land on its ${composition.sampleRate} Hz sample grid`);
  const frames = Number(exact.numerator);
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > referenceTempoDelayLimits.maximumFrames) {
    fail(node, "CUT_AUDIO_TEMPO_DELAY_RESOURCE", `Timeline “${composition.name}” requires an invalid or over-budget ${frames}-frame tempo delay`);
  }
  return frames;
}

function closedObject(node: IRNode, value: IRValue | undefined, keys: readonly string[], label: string) {
  if (value?.kind !== "object") fail(node, "CUT_AUDIO_TEMPO_DELAY_TYPE", `${label} must be one closed compile-time object`);
  const actual = Object.keys(value.entries).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(node, "CUT_AUDIO_TEMPO_DELAY_TYPE", `${label} must contain exactly ${expected.join(", ")}; unsupported or missing fields are refused`);
  }
  return value.entries;
}

function quantity(node: IRNode, value: IRValue | undefined, dimension: string, label: string, fallback?: Rational) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value?.kind !== "quantity" || value.dimension !== dimension) {
    fail(node, "CUT_AUDIO_TEMPO_DELAY_TYPE", `${label} must be one exact ${dimension === "scalar" ? "Number" : dimension === "ratio" ? "Ratio" : dimension === "beat" ? "Beat" : "Time"} quantity`);
  }
  return value.magnitude;
}

function ratio(node: IRNode, value: IRValue | undefined, label: string, fallback: Rational) {
  const exact = quantity(node, value, "ratio", label, fallback), number = rationalToNumber(exact);
  if (!Number.isFinite(number)) fail(node, "CUT_AUDIO_TEMPO_DELAY_VALUE", `${label} is not finite`);
  return number;
}

function decodeTempoPoints(node: IRNode, value: IRValue | undefined): ReferenceTempoPoint[] {
  const tempo = closedObject(node, value, ["points"], "TempoDelay.tempo");
  const points = tempo.points;
  if (points?.kind !== "array") fail(node, "CUT_AUDIO_TEMPO_DELAY_TYPE", "TempoDelay.tempo.points must be a List<TempoPoint>");
  return points.items.map((candidate, index) => {
    const point = closedObject(node, candidate, ["at", "bpm"], `TempoDelay.tempo.points[${index}]`);
    return Object.freeze({
      at: quantity(node, point.at, "time", `TempoDelay.tempo.points[${index}].at`),
      bpm: quantity(node, point.bpm, "scalar", `TempoDelay.tempo.points[${index}].bpm`),
    });
  });
}

/** Reduce one public TempoDelay node to the exact core plan used by check, inspect and render. */
export function referenceTempoDelayConfig(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceTempoDelayPlan | undefined {
  if (node.op !== "cut.audio.tempo_delay") return undefined;
  if (node.domain !== "audio") fail(node, "CUT_AUDIO_TEMPO_DELAY_GRAPH", `TempoDelay must have audio domain, found ${node.domain}`);
  const allowed = new Set(["tempo", "delay", "feedback", "mix"]);
  const unknown = Object.keys(node.inputs).filter((name) => !allowed.has(name));
  if (unknown.length) fail(node, "CUT_AUDIO_TEMPO_DELAY_GRAPH", `TempoDelay has unsupported input${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  if (Object.keys(node.properties).length) fail(node, "CUT_AUDIO_TEMPO_DELAY_GRAPH", "TempoDelay has no settable or animatable properties in this version");
  if (node.children.length !== 1) fail(node, "CUT_AUDIO_TEMPO_DELAY_GRAPH", `TempoDelay requires exactly one audio child; found ${node.children.length}`);
  const child = ir.nodes[node.children[0]!];
  if (!child || child.domain !== "audio") fail(node, "CUT_AUDIO_TEMPO_DELAY_GRAPH", "TempoDelay must reference one existing audio child");
  const totalFrames = exactCompositionFrames(node, composition);
  try {
    const tempo = compileReferenceTempoMap({
      sampleRate: composition.sampleRate,
      totalFrames,
      points: decodeTempoPoints(node, node.inputs.tempo),
    });
    return compileReferenceTempoDelayPlan({
      tempo,
      delayBeats: quantity(node, node.inputs.delay, "beat", "TempoDelay.delay"),
      feedback: ratio(node, node.inputs.feedback, "TempoDelay.feedback", rational(35, 100)),
      mix: ratio(node, node.inputs.mix, "TempoDelay.mix", rational(25, 100)),
    });
  } catch (error) {
    if (error instanceof ReferenceTempoDelayConfigError) throw error;
    if (error instanceof ReferenceTempoDelayError) {
      const prefix = `${error.code}: `;
      fail(node, error.code, error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message, error);
    }
    throw error;
  }
}

/** Aggregate semantic invocation cost before any child render or temporary allocation. */
export function validateReferenceTempoDelayPlans(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
) {
  const pending = [...rootIds], invocationCounts = new Map<string, number>();
  let expansionVisits = 0;
  while (pending.length) {
    const id = pending.pop()!;
    expansionVisits += 1;
    if (expansionVisits > 1_000_000) {
      const owner = ir.nodes[rootIds[0] ?? ""];
      if (!owner) throw new Error("CUT_AUDIO_TEMPO_DELAY_RESOURCE: graph expansion exceeded the bounded invocation audit.");
      fail(owner, "CUT_AUDIO_TEMPO_DELAY_RESOURCE", "TempoDelay graph expansion exceeded 1,000,000 semantic visits");
    }
    const node = ir.nodes[id];
    if (!node) throw new Error(`CUT_AUDIO_TEMPO_DELAY_GRAPH: audio graph references missing node ${id}.`);
    if (node.op === "cut.audio.tempo_delay") invocationCounts.set(id, (invocationCounts.get(id) ?? 0) + 1);
    pending.push(...nodeReferences(node));
  }
  const ids = [...invocationCounts.keys()].sort();
  if (!ids.length) return [];
  if (ids.length > referenceTempoDelayLimits.maximumNodesPerComposition) {
    fail(ir.nodes[ids[0]!]!, "CUT_AUDIO_TEMPO_DELAY_RESOURCE", `composition contains ${ids.length} distinct TempoDelay nodes; maximum is ${referenceTempoDelayLimits.maximumNodesPerComposition}`);
  }
  const plans = ids.map((id) => referenceTempoDelayConfig(ir, composition, ir.nodes[id]!)!);
  const total = plans.reduce((sum, plan, index) => sum + plan.tempo.totalFrames * invocationCounts.get(ids[index]!)!, 0);
  if (!Number.isSafeInteger(total) || total > referenceTempoDelayLimits.maximumTotalProcessedFrames) {
    fail(ir.nodes[ids[0]!]!, "CUT_AUDIO_TEMPO_DELAY_RESOURCE", `reachable TempoDelay graph requires ${Number.isSafeInteger(total) ? total : "an unsafe number of"} processed frames; maximum is ${referenceTempoDelayLimits.maximumTotalProcessedFrames}`);
  }
  return plans;
}

export function referenceTempoDelayInspect(plan: ReferenceTempoDelayPlan) {
  return Object.freeze({
    format: plan.format,
    version: plan.version,
    algorithm: plan.algorithm,
    delayBeats: plan.delayBeats,
    feedback: plan.feedback,
    mix: plan.mix,
    firstEchoFrame: plan.firstEchoFrame,
    tempo: {
      points: plan.tempo.points,
      segments: plan.tempo.segments.map((segment) => ({
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        startBeat: segment.startBeat,
        endBeat: segment.endBeat,
        bpm: segment.bpm,
      })),
      integrity: plan.tempo.integrity,
    },
    spans: plan.spans,
    integrity: plan.integrity,
  });
}
