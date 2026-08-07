import type { LockedResourceProbe } from "../../language/lock";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import {
  cutAudioBusKinds,
  cutAudioRoles,
  isCutAudioBusKind,
  isCutAudioRole,
  type CutAudioBusKind,
  type CutAudioRole,
} from "../../language/audio-role";
import { boundedDiagnosticString } from "../../core/stable";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import { referenceCompressorLimits } from "./audio-compressor";
import {
  referenceSidechainControlsAreCalibrated,
  referenceSidechainLimits,
  referenceSidechainMaximumReductionDb,
} from "./audio-sidechain";
import { referenceStateVariableFilterLimits, referenceStateVariableFilterMaximumCutoff } from "./audio-filter";
import { referenceParametricEqLimits } from "./audio-parametric-eq";
import { compileReferenceTimeStretchPlan, type ReferenceTimeStretchPlan } from "./audio-time-stretch";
import { referenceTempoDelayConfig } from "./audio-tempo-delay-config";
import type { ReferenceTempoDelayPlan } from "./audio-tempo-delay";
import {
  compileReferenceDeEsserPlan,
  defaultReferenceDeEsserConfig,
  ReferenceDeEsserCoreError,
  type ReferenceDeEsserPlan,
} from "./audio-deesser";

export type ReferenceAudioConfigErrorCode =
  | "CUT_AUDIO_INPUT_TYPE"
  | "CUT_AUDIO_VALUE_RANGE"
  | "CUT_AUDIO_SAMPLE_GRID"
  | "CUT_AUDIO_ENUM"
  | "CUT_AUDIO_SOURCE"
  | "CUT_AUDIO_GRAPH"
  | "CUT_AUDIO_DEESSER_CONFIG"
  | "CUT_AUDIO_RESOURCE_LIMIT";

export type ReferenceAudioConfigSource = { module: string; line: number; column: number; nodeId: string };

export class ReferenceAudioConfigError extends Error {
  constructor(
    readonly code: ReferenceAudioConfigErrorCode,
    readonly nodeId: string,
    message: string,
    readonly source: ReferenceAudioConfigSource | { nodeId: string } = { nodeId },
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceAudioConfigError";
  }
}

export type ReferenceMediaAudioConfig = {
  kind: "media-source";
  resourceId: string;
  streamIndex: number;
  sourceSampleRate: number;
  sourceStartSamples: number;
  sourceEndSamples: number;
  durationSamples: number;
  durationMapping: "exact" | "nearest-ties-to-even";
  resampleKernel: "polyphase" | "short-range-2-tap";
  fadeInSamples: number;
  fadeOutSamples: number;
};

export type ReferenceProceduralAudioConfig = {
  kind: "tone" | "noise";
  durationSamples: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  amplitude: number;
  frequency?: number;
  color?: "white" | "pink" | "brown" | "blue" | "violet" | "velvet";
  seed?: number;
};

export type ReferenceAudioNodeConfig =
  | ReferenceMediaAudioConfig
  | ReferenceProceduralAudioConfig
  | { kind: "bus"; busKind: CutAudioBusKind; name?: string; role?: CutAudioRole }
  | { kind: "submix"; name: string }
  | { kind: "send"; amountDb: number; tap: "post" | "pre-fader"; sourceNodeId?: string }
  | { kind: "return"; sendNodeIds: string[] }
  | { kind: "gain"; amountDb: number }
  | { kind: "pan"; position: number }
  | { kind: "channel-matrix"; leftToLeft: number; leftToRight: number; rightToLeft: number; rightToRight: number }
  | { kind: "eq"; frequency: number; gainDb: number; q: number }
  | { kind: "highpass" | "lowpass"; frequency: number; q: number }
  | { kind: "compressor"; thresholdDb: number; ratio: number; attackSeconds: number; releaseSeconds: number; makeupDb: number }
  | ReferenceTimeStretchPlan
  | { kind: "deesser"; intensity: number; amount: number; plan: ReferenceDeEsserPlan }
  | { kind: "limiter"; ceilingDbtp: number; releaseSeconds: number; lookaheadSamples: number }
  | { kind: "reverb"; wet: number }
  | { kind: "delay"; delaySamples: number; repeats: number; decay: number; wet: number; tailSamples: number; taps: Array<{ offsetSamples: number; normalizedWeight: number }> }
  | { kind: "tempo-delay"; plan: ReferenceTempoDelayPlan }
  | { kind: "sidechain"; sourceNodeId: string; amountDb: number; thresholdDb: number; attackSeconds: number; releaseSeconds: number }
  | { kind: "meter"; targetLufs: number; truePeakDbtp: number; samplePeakDbfs: number; loudnessRangeLu: number };

function sourceLabel(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function source(node: IRNode): ReferenceAudioConfigSource {
  return {
    module: node.provenance.module,
    line: node.provenance.span.start.line,
    column: node.provenance.span.start.column,
    nodeId: node.id,
  };
}

function fail(node: IRNode, code: ReferenceAudioConfigErrorCode, message: string): never {
  throw new ReferenceAudioConfigError(code, node.id, `${node.op} at ${sourceLabel(node)} ${message}`, source(node));
}

function quantity(
  node: IRNode,
  name: string,
  dimension: string,
  fallback?: Rational,
) {
  const authored = node.inputs[name];
  if (authored === undefined) {
    if (fallback === undefined) fail(node, "CUT_AUDIO_INPUT_TYPE", `requires ${name}: ${dimension}.`);
    return { exact: fallback, value: rationalToNumber(fallback) };
  }
  if (authored.kind !== "quantity" || authored.dimension !== dimension) {
    fail(node, "CUT_AUDIO_INPUT_TYPE", `requires ${name} to have dimension ${dimension}; received ${authored.kind}${authored.kind === "quantity" ? `:${authored.dimension}` : ""}.`);
  }
  const value = rationalToNumber(authored.magnitude);
  if (!Number.isFinite(value)) fail(node, "CUT_AUDIO_VALUE_RANGE", `has a non-finite ${name}.`);
  return { exact: authored.magnitude, value };
}

function stringInput(node: IRNode, name: string, fallback?: string) {
  const authored = node.inputs[name];
  if (authored === undefined) {
    if (fallback === undefined) fail(node, "CUT_AUDIO_INPUT_TYPE", `requires ${name}: String.`);
    return fallback;
  }
  if (authored.kind !== "string") fail(node, "CUT_AUDIO_INPUT_TYPE", `requires ${name}: String; received ${authored.kind}.`);
  return authored.value;
}

/**
 * Validate optional Bus routing metadata at every runtime boundary. The role
 * is deliberately transparent to DSP, but malformed loaded IR must still fail
 * with the same stable, source-located audio diagnostic as executable inputs.
 */
export function referenceAudioBusRole(node: IRNode): CutAudioRole | undefined {
  const authored = node.inputs.role;
  if (authored === undefined) return undefined;
  const role = stringInput(node, "role");
  if (!isCutAudioRole(role)) {
    fail(node, "CUT_AUDIO_ENUM", `requires role to be one of: ${cutAudioRoles.join(", ")}; received ${boundedDiagnosticString(role)}.`);
  }
  return role;
}

/**
 * Resolve the executable top-level Bus routing contract. Omitting kind keeps
 * historical IR compatible and is exactly equivalent to kind: "program".
 * Loaded IR is checked again so a forged enum cannot reach stem planning.
 */
export function referenceAudioBusKind(node: IRNode): CutAudioBusKind {
  const kind = stringInput(node, "kind", "program");
  if (!isCutAudioBusKind(kind)) {
    fail(node, "CUT_AUDIO_ENUM", `requires kind to be one of: ${cutAudioBusKinds.join(", ")}; received ${boundedDiagnosticString(kind)}.`);
  }
  return kind;
}

function nodeReferenceList(node: IRNode, name: string) {
  const authored = node.inputs[name];
  if (authored?.kind !== "array") fail(node, "CUT_AUDIO_INPUT_TYPE", `requires ${name}: List<AudioNode>.`);
  const result: string[] = [];
  for (const [index, value] of authored.items.entries()) {
    if (value.kind !== "node-ref") fail(node, "CUT_AUDIO_INPUT_TYPE", `requires ${name}[${index}] to be an AudioNode reference; received ${value.kind}.`);
    result.push(value.id);
  }
  return result;
}

function bounded(node: IRNode, name: string, value: number, minimum: number, maximum: number) {
  if (value < minimum || value > maximum) {
    fail(node, "CUT_AUDIO_VALUE_RANGE", `requires ${name} between ${minimum} and ${maximum}; received ${value}.`);
  }
  return value;
}

export const referenceDelayLimits = Object.freeze({
  maximumTimeSeconds: 10,
  maximumRepeats: 16,
  maximumTailSeconds: 30,
});

/** Closed public control bounds shared by Limiter config and automation. */
export const referenceLimiterLimits = Object.freeze({
  minimumCeilingDbtp: -23.5,
  maximumCeilingDbtp: 0,
  minimumReleaseSeconds: 0.001,
  maximumReleaseSeconds: 2,
  minimumLookaheadSeconds: 0,
  maximumLookaheadSeconds: 0.02,
  maximumAutomationEventsPerNode: 128,
  maximumAutomatedNodesPerComposition: 16,
  maximumAutomatedChannelSamplesPerComposition: 268_435_456,
  maximumAutomationExpressionCharactersPerNode: 32_768,
});

function delayConfig(node: IRNode, composition: IRComposition): Extract<ReferenceAudioNodeConfig, { kind: "delay" }> {
  const time = quantity(node, "time", "time");
  const delaySamples = exactSamples(node, time.exact, composition.sampleRate, "Delay.time");
  if (delaySamples < 1) fail(node, "CUT_AUDIO_VALUE_RANGE", "requires Delay.time to be at least one output sample.");
  if (compareRational(time.exact, rational(referenceDelayLimits.maximumTimeSeconds)) > 0) {
    fail(node, "CUT_AUDIO_VALUE_RANGE", `requires Delay.time to be at most ${referenceDelayLimits.maximumTimeSeconds} seconds.`);
  }

  const repeatValue = quantity(node, "repeats", "scalar", rational(3));
  if (repeatValue.exact.denominator !== "1") fail(node, "CUT_AUDIO_VALUE_RANGE", "requires Delay.repeats to be an integer.");
  const repeats = bounded(node, "repeats", repeatValue.value, 1, referenceDelayLimits.maximumRepeats);
  if (!Number.isSafeInteger(repeats)) fail(node, "CUT_AUDIO_VALUE_RANGE", "requires Delay.repeats to be a safe integer.");

  const decay = bounded(node, "decay", quantity(node, "decay", "ratio", rational(1, 2)).value, 0, 1);
  if (decay === 0) fail(node, "CUT_AUDIO_VALUE_RANGE", "requires Delay.decay to be greater than 0%; zero would make every tap after the first a silent no-op.");
  const wet = bounded(node, "wet", quantity(node, "wet", "ratio", rational(1, 4)).value, 0, 1);
  const tailSamples = delaySamples * repeats;
  if (!Number.isSafeInteger(tailSamples)) fail(node, "CUT_AUDIO_RESOURCE_LIMIT", "has an unsafe cumulative tail sample count.");
  if (tailSamples > composition.sampleRate * referenceDelayLimits.maximumTailSeconds) {
    fail(node, "CUT_AUDIO_RESOURCE_LIMIT", `requires Delay.time × Delay.repeats to be at most ${referenceDelayLimits.maximumTailSeconds} seconds; received ${tailSamples} samples at ${composition.sampleRate} Hz.`);
  }
  const compositionSamples = exactSamples(node, composition.duration, composition.sampleRate, "composition duration");
  if (tailSamples >= compositionSamples) {
    fail(node, "CUT_AUDIO_VALUE_RANGE", `requires the final Delay tap to begin before the ${compositionSamples}-sample composition output boundary; tap ${repeats} begins at sample ${tailSamples}.`);
  }

  const rawWeights = Array.from({ length: repeats }, (_, index) => decay ** index);
  const weightTotal = rawWeights.reduce((total, value) => total + value, 0);
  const taps = rawWeights.map((value, index) => ({ offsetSamples: delaySamples * (index + 1), normalizedWeight: value / weightTotal }));
  return { kind: "delay", delaySamples, repeats, decay, wet, tailSamples, taps };
}

function exactSamples(node: IRNode, value: Rational, sampleRate: number, label: string) {
  if (compareRational(value, zeroRational) < 0) fail(node, "CUT_AUDIO_VALUE_RANGE", `requires non-negative ${label}.`);
  const samples = multiplyRational(value, rational(sampleRate));
  if (samples.denominator !== "1") fail(node, "CUT_AUDIO_SAMPLE_GRID", `${label} does not land on the ${sampleRate} Hz sample grid.`);
  const result = Number(samples.numerator);
  if (!Number.isSafeInteger(result) || result < 0) fail(node, "CUT_AUDIO_VALUE_RANGE", `has an unsafe ${label} sample count.`);
  return result;
}

/** Map an exact positive source duration onto the destination sample grid.
 * Sample-rate conversion cannot preserve every rational duration exactly. CUT
 * uses nearest-integer, ties-to-even mapping (with one sample as the minimum
 * for a non-empty source interval) instead of toolchain-dependent rounding. */
function destinationSamples(node: IRNode, value: Rational, sampleRate: number, label: string) {
  if (compareRational(value, zeroRational) <= 0) fail(node, "CUT_AUDIO_VALUE_RANGE", `requires positive ${label}.`);
  const ideal = multiplyRational(value, rational(sampleRate));
  const numerator = BigInt(ideal.numerator), denominator = BigInt(ideal.denominator);
  if (numerator < 0n || denominator <= 0n) fail(node, "CUT_AUDIO_VALUE_RANGE", `has an invalid ${label} sample ratio.`);
  let samples = numerator / denominator;
  const remainder = numerator % denominator, doubled = remainder * 2n;
  if (doubled > denominator || (doubled === denominator && samples % 2n !== 0n)) samples += 1n;
  if (samples === 0n) samples = 1n;
  if (samples > BigInt(Number.MAX_SAFE_INTEGER)) fail(node, "CUT_AUDIO_VALUE_RANGE", `has an unsafe ${label} sample count.`);
  return { samples: Number(samples), mapping: denominator === 1n ? "exact" as const : "nearest-ties-to-even" as const };
}

function validateSourcePlacement(ir: CutAVIR, composition: IRComposition, node: IRNode) {
  let placement = node.interval.start;
  if (node.sceneId) {
    const scene = ir.scenes[node.sceneId];
    if (!scene) fail(node, "CUT_AUDIO_GRAPH", `references missing owning scene ${node.sceneId}.`);
    placement = addRational(scene.start, placement);
  }
  exactSamples(node, placement, composition.sampleRate, "destination placement");
}

function fades(node: IRNode, composition: IRComposition, duration: Rational, durationSamples: number) {
  const fadeIn = quantity(node, "fadeIn", "time", zeroRational).exact;
  const fadeOut = quantity(node, "fadeOut", "time", zeroRational).exact;
  const fadeInSamples = exactSamples(node, fadeIn, composition.sampleRate, "fadeIn");
  const fadeOutSamples = exactSamples(node, fadeOut, composition.sampleRate, "fadeOut");
  if (fadeInSamples + fadeOutSamples > durationSamples || compareRational(fadeIn, duration) > 0 || compareRational(fadeOut, duration) > 0) {
    fail(node, "CUT_AUDIO_VALUE_RANGE", "requires fadeIn + fadeOut not to exceed the rendered source duration.");
  }
  return { fadeInSamples, fadeOutSamples };
}

function lockedAudioSource(ir: CutAVIR, node: IRNode) {
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") fail(node, "CUT_AUDIO_SOURCE", "requires source to reference a locked AudioAsset.");
  const resource = ir.resources[source.id];
  if (!resource || resource.kind !== "audio") fail(node, "CUT_AUDIO_SOURCE", `references missing or non-audio resource ${source.id}.`);
  const probe = resource.metadata?.probe as LockedResourceProbe | undefined;
  const selection = probe?.kind === "media" ? probe.selected.audio : undefined;
  if (probe?.kind !== "media" || !selection || !Number.isSafeInteger(selection.streamIndex) || selection.streamIndex < 0) {
    fail(node, "CUT_AUDIO_SOURCE", `resource ${source.id} has no lock-selected audio stream.`);
  }
  const streamIndex = selection.streamIndex;
  const stream = probe.identity.streams.find((candidate) => candidate.index === streamIndex && candidate.type === "audio");
  if (!stream?.sampleRate || !Number.isSafeInteger(stream.sampleRate) || stream.sampleRate < 1) {
    fail(node, "CUT_AUDIO_SOURCE", `resource ${source.id} selected stream ${streamIndex} has no exact sample rate.`);
  }
  return { resourceId: source.id, streamIndex, sampleRate: stream.sampleRate, duration: selection.duration };
}

function mediaSourceConfig(ir: CutAVIR, composition: IRComposition, node: IRNode): ReferenceMediaAudioConfig {
  validateSourcePlacement(ir, composition, node);
  const source = lockedAudioSource(ir, node);
  const authoredRange = node.inputs.range;
  let start = zeroRational;
  let end = node.interval.duration;
  if (authoredRange !== undefined) {
    if (authoredRange.kind !== "range") fail(node, "CUT_AUDIO_INPUT_TYPE", `requires range: Range<Time>; received ${authoredRange.kind}.`);
    const startValue = authoredRange.start, endValue = authoredRange.end;
    if (startValue.kind !== "quantity" || startValue.dimension !== "time" || endValue.kind !== "quantity" || endValue.dimension !== "time") {
      fail(node, "CUT_AUDIO_INPUT_TYPE", "requires both range endpoints to be exact Time quantities.");
    }
    start = startValue.magnitude;
    end = endValue.magnitude;
  }
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    fail(node, "CUT_AUDIO_VALUE_RANGE", "requires a positive source range that does not begin before zero.");
  }
  if (compareRational(end, source.duration) > 0) {
    fail(node, "CUT_AUDIO_VALUE_RANGE", `source range ends after the locked ${rationalToNumber(source.duration)}s audio-stream duration.`);
  }
  const duration = subtractRational(end, start);
  const sourceStartSamples = exactSamples(node, start, source.sampleRate, "source-range start");
  const sourceEndSamples = exactSamples(node, end, source.sampleRate, "source-range end");
  const destination = destinationSamples(node, duration, composition.sampleRate, "rendered source duration");
  const durationSamples = destination.samples;
  if (durationSamples <= 0) fail(node, "CUT_AUDIO_VALUE_RANGE", "requires a source range containing at least one output sample.");
  const renderedDuration = rational(durationSamples, composition.sampleRate);
  return {
    kind: "media-source",
    ...source,
    sourceSampleRate: source.sampleRate,
    sourceStartSamples,
    sourceEndSamples,
    durationSamples,
    durationMapping: destination.mapping,
    resampleKernel: sourceEndSamples - sourceStartSamples < 32 ? "short-range-2-tap" : "polyphase",
    ...fades(node, composition, renderedDuration, durationSamples),
  };
}

function proceduralConfig(ir: CutAVIR, composition: IRComposition, node: IRNode): ReferenceProceduralAudioConfig {
  validateSourcePlacement(ir, composition, node);
  const duration = quantity(node, "duration", "time").exact;
  if (compareRational(duration, zeroRational) <= 0) fail(node, "CUT_AUDIO_VALUE_RANGE", "requires duration greater than zero.");
  if (compareRational(duration, node.interval.duration) > 0) fail(node, "CUT_AUDIO_VALUE_RANGE", "duration exceeds the remaining owning timeline/scene interval.");
  const durationSamples = exactSamples(node, duration, composition.sampleRate, "duration");
  if (durationSamples <= 0) fail(node, "CUT_AUDIO_VALUE_RANGE", "requires duration containing at least one sample.");
  const amplitudeDefault = node.op === "cut.audio.tone" ? rational(1, 5) : rational(2, 25);
  const amplitude = bounded(node, "amplitude", quantity(node, "amplitude", "ratio", amplitudeDefault).value, 0, 1);
  const common = { durationSamples, amplitude, ...fades(node, composition, duration, durationSamples) };
  if (node.op === "cut.audio.tone") {
    const frequency = quantity(node, "frequency", "frequency").value;
    if (frequency <= 0 || frequency >= composition.sampleRate / 2) {
      fail(node, "CUT_AUDIO_VALUE_RANGE", `requires frequency greater than zero and below the ${composition.sampleRate / 2} Hz Nyquist limit; received ${frequency}.`);
    }
    return { kind: "tone", frequency, ...common };
  }
  const color = stringInput(node, "color", "pink");
  const colors = new Set(["white", "pink", "brown", "blue", "violet", "velvet"] as const);
  if (!colors.has(color as "white")) fail(node, "CUT_AUDIO_ENUM", `requires color to be one of: ${[...colors].join(", ")}; received ${boundedDiagnosticString(color)}.`);
  const seed = quantity(node, "seed", "scalar", rational(1)).value;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) fail(node, "CUT_AUDIO_VALUE_RANGE", `requires seed to be an integer from 0 through ${0xffffffff}; received ${seed}.`);
  return { kind: "noise", color: color as ReferenceProceduralAudioConfig["color"], seed, ...common };
}

function stateVariableFilterFrequency(node: IRNode, composition: IRComposition) {
  const value = quantity(node, "frequency", "frequency").value;
  const maximum = referenceStateVariableFilterMaximumCutoff(composition.sampleRate);
  if (value < referenceStateVariableFilterLimits.minimumCutoffHz || value > maximum) {
    fail(node, "CUT_AUDIO_VALUE_RANGE", `requires frequency between ${referenceStateVariableFilterLimits.minimumCutoffHz} Hz and ${maximum} Hz for the ${composition.sampleRate} Hz state-variable filter; received ${value}.`);
  }
  return value;
}

function parametricEqFrequency(node: IRNode, composition: IRComposition) {
  const value = quantity(node, "frequency", "frequency", rational(180)).value;
  const maximum = composition.sampleRate * referenceParametricEqLimits.maximumFrequencySampleRateRatio;
  if (value < referenceParametricEqLimits.minimumFrequencyHz || value >= maximum) {
    fail(node, "CUT_AUDIO_VALUE_RANGE", `requires frequency at least ${referenceParametricEqLimits.minimumFrequencyHz} Hz and below the ${maximum} Hz Nyquist limit; received ${value}.`);
  }
  return value;
}

function deEsserConfig(node: IRNode, composition: IRComposition): Extract<ReferenceAudioNodeConfig, { kind: "deesser" }> {
  const intensity = bounded(node, "intensity", quantity(node, "intensity", "scalar", rational(35, 100)).value, 0, 1);
  const amount = bounded(node, "amount", quantity(node, "amount", "scalar", rational(1, 2)).value, 0, 1);
  try {
    // Public controls do not alter topology. Compile and close the static
    // crossover/detector plan once, then retain it in executable/cache identity.
    const plan = compileReferenceDeEsserPlan(defaultReferenceDeEsserConfig(composition.sampleRate));
    return { kind: "deesser", intensity, amount, plan };
  } catch (error) {
    if (error instanceof ReferenceDeEsserCoreError) fail(node, "CUT_AUDIO_DEESSER_CONFIG", error.message.replace(/^CUT_AUDIO_DEESSER_CONFIG:\s*/u, ""));
    throw error;
  }
}

export function referenceAudioNodeConfig(ir: CutAVIR, composition: IRComposition, node: IRNode): ReferenceAudioNodeConfig | undefined {
  if (node.op === "cut.audio.clip" || node.op === "cut.documentary.narration") return mediaSourceConfig(ir, composition, node);
  if (node.op === "cut.audio.tone" || node.op === "cut.audio.noise") return proceduralConfig(ir, composition, node);
  if (node.op === "cut.audio.bus") {
    const role = referenceAudioBusRole(node);
    return {
      kind: "bus",
      busKind: referenceAudioBusKind(node),
      ...(node.inputs.name === undefined ? {} : { name: stringInput(node, "name") }),
      ...(role === undefined ? {} : { role }),
    };
  }
  if (node.op === "cut.audio.submix") return { kind: "submix", name: stringInput(node, "name") };
  if (node.op === "cut.audio.send") {
    const amountDb = bounded(node, "amount", quantity(node, "amount", "gain").value, -120, 12);
    const tap = stringInput(node, "tap", "post");
    if (tap !== "post" && tap !== "pre-fader") fail(node, "CUT_AUDIO_ENUM", `requires tap to be one of: post, pre-fader; received ${boundedDiagnosticString(tap)}.`);
    const authoredSource = node.inputs.source;
    if (authoredSource === undefined) {
      if (!node.children.length) fail(node, "CUT_AUDIO_GRAPH", "requires at least one structural audio child when source: is omitted.");
      if (tap === "pre-fader") fail(node, "CUT_AUDIO_GRAPH", "tap: pre-fader requires a detached source: that references one explicit Gain node.");
      return { kind: "send", amountDb, tap };
    }
    if (authoredSource.kind !== "node-ref") fail(node, "CUT_AUDIO_INPUT_TYPE", `requires source: AudioNode; received ${authoredSource.kind}.`);
    if (node.children.length) fail(node, "CUT_AUDIO_GRAPH", "cannot combine source: with structural audio children.");
    if (node.ownership !== "reference") fail(node, "CUT_AUDIO_GRAPH", "with source: must be a detached let-bound reference rather than a rendered structural/root node.");
    return { kind: "send", amountDb, tap, sourceNodeId: authoredSource.id };
  }
  if (node.op === "cut.audio.return") return { kind: "return", sendNodeIds: nodeReferenceList(node, "sends") };
  if (node.op === "cut.audio.gain") return { kind: "gain", amountDb: bounded(node, "amount", quantity(node, "amount", "gain").value, -192, 60) };
  if (node.op === "cut.audio.pan") return { kind: "pan", position: bounded(node, "position", quantity(node, "position", "ratio").value, -1, 1) };
  if (node.op === "cut.audio.channel_matrix") return {
    kind: "channel-matrix",
    leftToLeft: bounded(node, "leftToLeft", quantity(node, "leftToLeft", "scalar").value, -4, 4),
    leftToRight: bounded(node, "leftToRight", quantity(node, "leftToRight", "scalar").value, -4, 4),
    rightToLeft: bounded(node, "rightToLeft", quantity(node, "rightToLeft", "scalar").value, -4, 4),
    rightToRight: bounded(node, "rightToRight", quantity(node, "rightToRight", "scalar").value, -4, 4),
  };
  if (node.op === "cut.audio.eq") return {
    kind: "eq",
    frequency: parametricEqFrequency(node, composition),
    gainDb: bounded(node, "gain", quantity(node, "gain", "gain", zeroRational).value, referenceParametricEqLimits.minimumGainDb, referenceParametricEqLimits.maximumGainDb),
    q: bounded(node, "q", quantity(node, "q", "scalar", rational(1)).value, referenceParametricEqLimits.minimumQ, referenceParametricEqLimits.maximumQ),
  };
  if (node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") return {
    kind: node.op === "cut.audio.highpass" ? "highpass" : "lowpass",
    frequency: stateVariableFilterFrequency(node, composition),
    q: bounded(node, "q", quantity(node, "q", "scalar", rational(707, 1_000)).value, referenceStateVariableFilterLimits.minimumQ, referenceStateVariableFilterLimits.maximumQ),
  };
  if (node.op === "cut.audio.time_stretch") return compileReferenceTimeStretchPlan(ir, composition, node);
  if (node.op === "cut.audio.compressor") return {
    kind: "compressor",
    thresholdDb: bounded(node, "threshold", quantity(node, "threshold", "gain", rational(-18)).value, referenceCompressorLimits.minimumThresholdDb, referenceCompressorLimits.maximumThresholdDb),
    ratio: bounded(node, "ratio", quantity(node, "ratio", "scalar", rational(3)).value, referenceCompressorLimits.minimumRatio, referenceCompressorLimits.maximumRatio),
    attackSeconds: bounded(node, "attack", quantity(node, "attack", "time", rational(1, 50)).value, referenceCompressorLimits.minimumAttackSeconds, referenceCompressorLimits.maximumAttackSeconds),
    releaseSeconds: bounded(node, "release", quantity(node, "release", "time", rational(9, 50)).value, referenceCompressorLimits.minimumReleaseSeconds, referenceCompressorLimits.maximumReleaseSeconds),
    makeupDb: bounded(node, "makeup", quantity(node, "makeup", "gain", zeroRational).value, referenceCompressorLimits.minimumMakeupDb, referenceCompressorLimits.maximumMakeupDb),
  };
  if (node.op === "cut.audio.deesser") return deEsserConfig(node, composition);
  if (node.op === "cut.audio.limiter") {
    const lookahead = quantity(node, "lookahead", "time", rational(1, 200));
    bounded(
      node,
      "lookahead",
      lookahead.value,
      referenceLimiterLimits.minimumLookaheadSeconds,
      referenceLimiterLimits.maximumLookaheadSeconds,
    );
    const lookaheadSamples = exactSamples(node, lookahead.exact, composition.sampleRate, "Limiter.lookahead");
    // `exactSamples` is the topology boundary: fractional-sample lookahead is
    // rejected rather than rounded by a backend.
    return {
      kind: "limiter",
      ceilingDbtp: bounded(node, "ceiling", quantity(node, "ceiling", "true-peak", rational(-1)).value, referenceLimiterLimits.minimumCeilingDbtp, referenceLimiterLimits.maximumCeilingDbtp),
      releaseSeconds: bounded(node, "release", quantity(node, "release", "time", rational(1, 20)).value, referenceLimiterLimits.minimumReleaseSeconds, referenceLimiterLimits.maximumReleaseSeconds),
      lookaheadSamples,
    };
  }
  if (node.op === "cut.audio.reverb") return { kind: "reverb", wet: bounded(node, "wet", quantity(node, "wet", "ratio", rational(18, 100)).value, 0, 1) };
  if (node.op === "cut.audio.delay") return delayConfig(node, composition);
  if (node.op === "cut.audio.tempo_delay") {
    const plan = referenceTempoDelayConfig(ir, composition, node);
    return plan ? { kind: "tempo-delay", plan } : undefined;
  }
  if (node.op === "cut.audio.sidechain") {
    const source = node.inputs.source;
    if (source?.kind !== "node-ref") fail(node, "CUT_AUDIO_INPUT_TYPE", "requires source to be an AudioNode reference.");
    const referenced = ir.nodes[source.id];
    if (!referenced || referenced.domain !== "audio") fail(node, "CUT_AUDIO_GRAPH", `references missing or non-audio sidechain source ${source.id}.`);
    const amountDb = bounded(node, "amount", quantity(node, "amount", "gain").value, referenceSidechainLimits.minimumAmountDb, referenceSidechainLimits.maximumAmountDb);
    const thresholdDb = bounded(node, "threshold", quantity(node, "threshold", "gain", rational(-22)).value, referenceSidechainLimits.minimumThresholdDb, referenceSidechainLimits.maximumThresholdDb);
    const maximumReductionDb = referenceSidechainMaximumReductionDb(thresholdDb);
    if (!referenceSidechainControlsAreCalibrated(amountDb, thresholdDb)) {
      fail(node, "CUT_AUDIO_VALUE_RANGE", `amount ${amountDb} dB exceeds the ${-maximumReductionDb} dB maximum reduction achievable at threshold ${thresholdDb} dB with the bounded ${referenceSidechainLimits.maximumEquivalentRatio}:1 calibration.`);
    }
    return {
      kind: "sidechain",
      sourceNodeId: source.id,
      amountDb,
      thresholdDb,
      attackSeconds: bounded(node, "attack", quantity(node, "attack", "time", rational(2, 25)).value, referenceSidechainLimits.minimumAttackSeconds, referenceSidechainLimits.maximumAttackSeconds),
      releaseSeconds: bounded(node, "release", quantity(node, "release", "time", rational(7, 20)).value, referenceSidechainLimits.minimumReleaseSeconds, referenceSidechainLimits.maximumReleaseSeconds),
    };
  }
  if (node.op === "cut.audio.meter") return {
    kind: "meter",
    targetLufs: bounded(node, "target", quantity(node, "target", "loudness", rational(-14)).value, -70, -5),
    truePeakDbtp: bounded(node, "truePeak", quantity(node, "truePeak", "true-peak", rational(-1)).value, -9, 0),
    samplePeakDbfs: bounded(node, "samplePeak", quantity(node, "samplePeak", "sample-peak", zeroRational).value, -24, 0),
    loudnessRangeLu: bounded(node, "range", quantity(node, "range", "scalar", rational(9)).value, 1, 50),
  };
  return undefined;
}
