import type { CutAVIR, IRComposition, IRNode, IRSignal, IRSignalEvent, IRValue } from "../../language/ir";
import { addRational, compareRational, multiplyRational, rational, rationalToNumber, zeroRational, type Rational } from "../../language/rational";
import { referenceCompressorLimits } from "./audio-compressor";
import { referenceStateVariableFilterLimits, referenceStateVariableFilterMaximumCutoff } from "./audio-filter";
import { referenceParametricEqAutomationLimits, referenceParametricEqLimits } from "./audio-parametric-eq";
import { referenceAudioNodeConfig, referenceLimiterLimits } from "./audio-config";
import {
  referenceSidechainControlsAreCalibrated,
  referenceSidechainLimits,
  referenceSidechainMaximumReductionDb,
} from "./audio-sidechain";
import {
  planReferenceDeEsserWork,
  referenceDeEsserCoreLimits,
  ReferenceDeEsserCoreError,
} from "./audio-deesser";

const maximumAutomationEvents = 64;
const maximumExpressionCharacters = 16_384;

export type ReferenceAudioAutomationProperty = "intensity" | "amount" | "position" | "wet" | "frequency" | "gain" | "q" | "threshold" | "ceiling" | "ratio" | "attack" | "release" | "makeup";

export type ReferenceAudioAutomation = {
  property: ReferenceAudioAutomationProperty;
  valueExpression: string;
  /** Deterministic CUT-owned evaluation of the same control at an output frame. */
  valueAtSample(sample: number): number;
  eventCount: number;
  /** Every authored/default control value admitted into the expression. */
  controlValues: readonly number[];
};

export type ReferenceParametricEqAutomations = Partial<Record<"frequency" | "gain" | "q", ReferenceAudioAutomation>>;
export type ReferenceStateVariableFilterAutomations = Partial<Record<"frequency" | "q", ReferenceAudioAutomation>>;

export type ReferenceCompressorAutomations = Partial<Record<
  "threshold" | "ratio" | "attack" | "release" | "makeup",
  ReferenceAudioAutomation
>>;

export type ReferenceSidechainAutomations = Partial<Record<"amount" | "threshold" | "attack" | "release", ReferenceAudioAutomation>>;
export type ReferenceDeEsserAutomations = Partial<Record<"intensity" | "amount", ReferenceAudioAutomation>>;
export type ReferenceLimiterAutomations = Partial<Record<"ceiling" | "release", ReferenceAudioAutomation>>;

export type ReferenceAudioAutomationErrorCode =
  | "CUT_AUDIO_AUTOMATION_TYPE"
  | "CUT_AUDIO_AUTOMATION_VALUE_RANGE"
  | "CUT_AUDIO_AUTOMATION_SAMPLE_GRID"
  | "CUT_AUDIO_AUTOMATION_EASING"
  | "CUT_AUDIO_AUTOMATION_SIGNAL"
  | "CUT_AUDIO_AUTOMATION_TIMING"
  | "CUT_AUDIO_AUTOMATION_LIMIT"
  | "CUT_AUDIO_AUTOMATION_GRAPH"
  | "CUT_AUDIO_DEESSER_WORK_LIMIT";

export type ReferenceAudioAutomationErrorSource = {
  module: string;
  line: number;
  column: number;
  nodeId: string;
};

export class ReferenceAudioAutomationError extends Error {
  readonly source: ReferenceAudioAutomationErrorSource;

  constructor(
    readonly code: ReferenceAudioAutomationErrorCode,
    readonly nodeId: string,
    node: IRNode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceAudioAutomationError";
    this.source = {
      module: node.provenance.module,
      line: node.provenance.span.start.line,
      column: node.provenance.span.start.column,
      nodeId,
    };
  }
}

function fail(node: IRNode, code: ReferenceAudioAutomationErrorCode, message: string): never {
  throw new ReferenceAudioAutomationError(code, node.id, node, message);
}

function sourceLabel(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function rationalLiteral(value: Rational) {
  return value.numerator === "0" ? "0" : value.denominator === "1" ? value.numerator : `(${value.numerator}/${value.denominator})`;
}

function exactSample(node: IRNode, time: Rational, sampleRate: number, context: string) {
  const samples = multiplyRational(time, rational(sampleRate));
  if (samples.denominator !== "1") fail(node, "CUT_AUDIO_AUTOMATION_SAMPLE_GRID", `${context} does not land on a ${sampleRate} Hz sample boundary.`);
  const value = Number(samples.numerator);
  if (!Number.isSafeInteger(value) || value < 0) fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `${context} has an invalid sample position.`);
  return value;
}

function localEventTime(event: IRSignalEvent) { return event.kind === "set" ? event.time : event.start; }

function propertyValueType(node: IRNode, property: ReferenceAudioAutomationProperty) {
  if (node.op === "cut.audio.deesser" && (property === "intensity" || property === "amount")) return "Number";
  return property === "ceiling" ? "TruePeak"
    : property === "amount" || property === "gain" || property === "threshold" || property === "makeup" ? "Gain"
    : property === "frequency" ? "Frequency"
      : property === "attack" || property === "release" ? "Time"
        : property === "q" || property === "ratio" ? "Number"
          : "Ratio";
}

function quantityControl(node: IRNode, composition: IRComposition, property: ReferenceAudioAutomationProperty, value: IRValue) {
  const deEsserControl = node.op === "cut.audio.deesser" && (property === "intensity" || property === "amount");
  const expected = property === "ceiling" ? "true-peak"
    : deEsserControl ? "scalar"
    : property === "amount" || property === "gain" || property === "threshold" || property === "makeup" ? "gain"
    : property === "frequency" ? "frequency"
      : property === "attack" || property === "release" ? "time"
        : property === "q" || property === "ratio" ? "scalar"
          : "ratio";
  if (value.kind !== "quantity" || value.dimension !== expected) {
    fail(node, "CUT_AUDIO_AUTOMATION_TYPE", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} requires a ${expected} quantity.`);
  }
  const number = rationalToNumber(value.magnitude);
  if (!Number.isFinite(number)) fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} is non-finite.`);
  // Keep expression evaluation and decoded sample magnitudes bounded.
  // Constructor values are validated separately; these bounds close the
  // per-sample signal path.
  if (deEsserControl && (number < 0 || number > 1)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation DeEsser.${property} at ${sourceLabel(node)} must stay between 0 and 1.`);
  }
  if (property === "amount" && !deEsserControl) {
    const send = node.op === "cut.audio.send", sidechain = node.op === "cut.audio.sidechain";
    const minimum = send ? -120 : sidechain ? referenceSidechainLimits.minimumAmountDb : -192;
    const maximum = send ? 12 : sidechain ? referenceSidechainLimits.maximumAmountDb : 60;
    if (number < minimum || number > maximum) {
      const label = send ? "Send" : sidechain ? "Sidechain" : "Gain";
      const formattedMaximum = maximum > 0 ? `+${maximum}` : String(maximum);
      fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${label}.amount at ${sourceLabel(node)} must stay between ${minimum} dB and ${formattedMaximum} dB.`);
    }
  }
  if (property === "position" && (number < -1 || number > 1)) fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation Pan.position at ${sourceLabel(node)} must stay between -100% and +100%.`);
  if (property === "wet" && (number < 0 || number > 1)) {
    const processor = node.op === "cut.audio.delay" ? "Delay" : "Reverb";
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${processor}.wet at ${sourceLabel(node)} must stay between 0% and 100%.`);
  }
  if (property === "frequency" && (node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass")) {
    const maximum = referenceStateVariableFilterMaximumCutoff(composition.sampleRate);
    if (number < referenceStateVariableFilterLimits.minimumCutoffHz || number > maximum) {
      fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${node.op}.frequency at ${sourceLabel(node)} must stay between ${referenceStateVariableFilterLimits.minimumCutoffHz} Hz and ${maximum} Hz for the ${composition.sampleRate} Hz state-variable filter.`);
    }
  }
  if (property === "frequency" && node.op === "cut.audio.eq" && (number < referenceParametricEqLimits.minimumFrequencyHz || number >= composition.sampleRate * referenceParametricEqLimits.maximumFrequencySampleRateRatio)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ParametricEQ.frequency at ${sourceLabel(node)} must be at least ${referenceParametricEqLimits.minimumFrequencyHz} Hz and below the ${composition.sampleRate / 2} Hz Nyquist limit.`);
  }
  if (property === "gain" && (number < referenceParametricEqLimits.minimumGainDb || number > referenceParametricEqLimits.maximumGainDb)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ParametricEQ.gain at ${sourceLabel(node)} must stay between ${referenceParametricEqLimits.minimumGainDb} dB and +${referenceParametricEqLimits.maximumGainDb} dB.`);
  }
  if (property === "q") {
    const limits = node.op === "cut.audio.eq" ? referenceParametricEqLimits : referenceStateVariableFilterLimits;
    if (number < limits.minimumQ || number > limits.maximumQ) {
      fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${node.op === "cut.audio.eq" ? "ParametricEQ" : node.op}.q at ${sourceLabel(node)} must stay between ${limits.minimumQ} and ${limits.maximumQ}.`);
    }
  }
  if (property === "threshold" && (number < referenceCompressorLimits.minimumThresholdDb || number > referenceCompressorLimits.maximumThresholdDb)) {
    const label = node.op === "cut.audio.sidechain" ? "Sidechain" : "Compressor";
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${label}.threshold at ${sourceLabel(node)} must stay between ${referenceCompressorLimits.minimumThresholdDb} dB and ${referenceCompressorLimits.maximumThresholdDb} dB.`);
  }
  if (property === "ceiling" && (number < referenceLimiterLimits.minimumCeilingDbtp || number > referenceLimiterLimits.maximumCeilingDbtp)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation Limiter.ceiling at ${sourceLabel(node)} must stay between ${referenceLimiterLimits.minimumCeilingDbtp} dBTP and ${referenceLimiterLimits.maximumCeilingDbtp} dBTP.`);
  }
  if (property === "ratio" && (number < referenceCompressorLimits.minimumRatio || number > referenceCompressorLimits.maximumRatio)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation Compressor.ratio at ${sourceLabel(node)} must stay between ${referenceCompressorLimits.minimumRatio}:1 and ${referenceCompressorLimits.maximumRatio}:1.`);
  }
  if (property === "attack" && (number < referenceCompressorLimits.minimumAttackSeconds || number > referenceCompressorLimits.maximumAttackSeconds)) {
    const label = node.op === "cut.audio.sidechain" ? "Sidechain" : "Compressor";
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${label}.attack at ${sourceLabel(node)} must stay between ${referenceCompressorLimits.minimumAttackSeconds * 1_000} ms and ${referenceCompressorLimits.maximumAttackSeconds * 1_000} ms.`);
  }
  if (property === "release") {
    const limits = node.op === "cut.audio.limiter" ? referenceLimiterLimits : referenceCompressorLimits;
    if (number < limits.minimumReleaseSeconds || number > limits.maximumReleaseSeconds) {
      const label = node.op === "cut.audio.sidechain" ? "Sidechain" : node.op === "cut.audio.limiter" ? "Limiter" : "Compressor";
      fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${label}.release at ${sourceLabel(node)} must stay between ${limits.minimumReleaseSeconds * 1_000} ms and ${limits.maximumReleaseSeconds * 1_000} ms.`);
    }
  }
  if (property === "makeup" && (number < referenceCompressorLimits.minimumMakeupDb || number > referenceCompressorLimits.maximumMakeupDb)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation Compressor.makeup at ${sourceLabel(node)} must stay between ${referenceCompressorLimits.minimumMakeupDb} dB and +${referenceCompressorLimits.maximumMakeupDb} dB.`);
  }
  return { expression: rationalLiteral(value.magnitude), value: number };
}

function easingKind(expression: IRValue, node: IRNode): "linear" | "outCubic" {
  if (expression.kind !== "symbol") fail(node, "CUT_AUDIO_AUTOMATION_EASING", `Reference audio automation at ${sourceLabel(node)} supports only linear and outCubic symbol easings.`);
  const name = expression.name.split("#").at(-1)?.toLowerCase();
  if (name === "linear") return "linear";
  if (name === "outcubic" || name === "out_cubic") return "outCubic";
  fail(node, "CUT_AUDIO_AUTOMATION_EASING", `Reference audio automation at ${sourceLabel(node)} does not implement easing “${name ?? expression.name}”.`);
}

function easingExpression(kind: "linear" | "outCubic", progress: string) {
  return kind === "linear" ? progress : `(1-pow(1-(${progress}),3))`;
}

function easingValue(kind: "linear" | "outCubic", progress: number) {
  return kind === "linear" ? progress : 1 - (1 - progress) ** 3;
}

function nodeIntervalEnd(node: IRNode) { return addRational(node.interval.start, node.interval.duration); }

function validateLocalTime(node: IRNode, time: Rational, label: string, allowIntervalEnd = false) {
  const endComparison = compareRational(time, nodeIntervalEnd(node));
  if (compareRational(time, node.interval.start) < 0 || endComparison > 0 || (!allowIntervalEnd && endComparison === 0)) {
    const boundary = allowIntervalEnd ? "owning node interval" : "half-open owning node interval";
    fail(node, "CUT_AUDIO_AUTOMATION_TIMING", `Reference audio automation ${label} at ${sourceLabel(node)} lies outside its ${boundary}.`);
  }
}

/**
 * Canonical baseline for a property track whose typed IR initial is null.
 *
 * A null initial means "use the processor's public runtime default until the
 * first event". It never revives a same-named constructor input: the compiler
 * copies an authored constructor baseline into the track initial when it
 * attaches the first signal. Keeping this helper public lets validation and
 * no-op proof share that exact loaded-IR meaning.
 */
export function referenceAudioAutomationDefaultValue(node: IRNode, property: ReferenceAudioAutomationProperty): IRValue | undefined {
  if (node.op === "cut.audio.deesser") {
    if (property === "intensity") return { kind: "quantity", dimension: "scalar", magnitude: rational(35, 100), unit: "scalar" };
    if (property === "amount") return { kind: "quantity", dimension: "scalar", magnitude: rational(1, 2), unit: "scalar" };
  }
  if (node.op === "cut.audio.compressor") {
    if (property === "threshold") return { kind: "quantity", dimension: "gain", magnitude: rational(-18), unit: "db" };
    if (property === "ratio") return { kind: "quantity", dimension: "scalar", magnitude: rational(3), unit: "scalar" };
    if (property === "attack") return { kind: "quantity", dimension: "time", magnitude: rational(1, 50), unit: "s" };
    if (property === "release") return { kind: "quantity", dimension: "time", magnitude: rational(9, 50), unit: "s" };
    if (property === "makeup") return { kind: "quantity", dimension: "gain", magnitude: zeroRational, unit: "db" };
  }
  if (node.op === "cut.audio.limiter") {
    if (property === "ceiling") return { kind: "quantity", dimension: "true-peak", magnitude: rational(-1), unit: "dbtp" };
    if (property === "release") return { kind: "quantity", dimension: "time", magnitude: rational(1, 20), unit: "s" };
  }
  if (node.op === "cut.audio.sidechain" && property === "threshold") {
    return { kind: "quantity", dimension: "gain", magnitude: rational(-22), unit: "db" };
  }
  if (node.op === "cut.audio.sidechain" && property === "attack") {
    return { kind: "quantity", dimension: "time", magnitude: rational(2, 25), unit: "s" };
  }
  if (node.op === "cut.audio.sidechain" && property === "release") {
    return { kind: "quantity", dimension: "time", magnitude: rational(7, 20), unit: "s" };
  }
  if ((node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") && property === "q") {
    return { kind: "quantity", dimension: "scalar", magnitude: rational(707, 1_000), unit: "scalar" };
  }
  if (node.op === "cut.audio.eq") {
    if (property === "frequency") return { kind: "quantity", dimension: "frequency", magnitude: rational(180), unit: "hz" };
    if (property === "gain") return { kind: "quantity", dimension: "gain", magnitude: zeroRational, unit: "db" };
    if (property === "q") return { kind: "quantity", dimension: "scalar", magnitude: rational(1), unit: "scalar" };
  }
  if (node.op === "cut.audio.reverb" && property === "wet") {
    return { kind: "quantity", dimension: "ratio", magnitude: rational(18, 100), unit: "ratio" };
  }
  if (node.op === "cut.audio.delay" && property === "wet") {
    return { kind: "quantity", dimension: "ratio", magnitude: rational(25, 100), unit: "ratio" };
  }
  return undefined;
}

function signalExpression(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  property: ReferenceAudioAutomation["property"],
  signal: IRSignal,
) {
  const expectedValueType = propertyValueType(node, property);
  if (signal.valueType !== expectedValueType) {
    fail(node, "CUT_AUDIO_AUTOMATION_TYPE", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} requires signal valueType ${expectedValueType}; received ${JSON.stringify(signal.valueType)}.`);
  }
  if (signal.kind !== "track") fail(node, "CUT_AUDIO_AUTOMATION_SIGNAL", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} requires a track signal; ${signal.kind} is unsupported.`);
  if (signal.events.length > maximumAutomationEvents) fail(node, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} exceeds the ${maximumAutomationEvents}-event limit.`);

  const sceneOffset = node.sceneId ? ir.scenes[node.sceneId]?.start : zeroRational;
  if (!sceneOffset) fail(node, "CUT_AUDIO_AUTOMATION_GRAPH", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} belongs to a missing scene.`);
  const initial = signal.initial.kind === "null"
    ? referenceAudioAutomationDefaultValue(node, property) ?? signal.initial
    : signal.initial;
  const initialControl = quantityControl(node, composition, property, initial);
  const controlValues = [initialControl.value];
  const segments: Array<{ startSample: number; expression: string; valueAtSample(sample: number): number }> = [{
    startSample: 0,
    expression: initialControl.expression,
    valueAtSample: () => initialControl.value,
  }];
  let previousStart: Rational | undefined;

  for (const event of signal.events) {
    if (event.kind !== "set" && event.kind !== "animate") fail(node, "CUT_AUDIO_AUTOMATION_SIGNAL", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} has an unsupported event kind.`);
    const start = localEventTime(event);
    validateLocalTime(node, start, `${event.kind} start`);
    if (previousStart && compareRational(start, previousStart) < 0) fail(node, "CUT_AUDIO_AUTOMATION_TIMING", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} has unsorted events.`);
    previousStart = start;
    const startSample = exactSample(node, addRational(sceneOffset, start), composition.sampleRate, `${node.op}.${property} event start`);

    // Later authored writes replace the tail beginning at their exact sample.
    // Keeping only ordered piecewise segments lets the final expression use a
    // balanced decision tree instead of recursively nesting every old event.
    while (segments.length && segments[segments.length - 1].startSample >= startSample) segments.pop();

    if (event.kind === "set") {
      const value = quantityControl(node, composition, property, event.value);
      controlValues.push(value.value);
      segments.push({ startSample, expression: value.expression, valueAtSample: () => value.value });
      continue;
    }

    validateLocalTime(node, event.end, "animate end", true);
    if (compareRational(event.end, event.start) <= 0) fail(node, "CUT_AUDIO_AUTOMATION_TIMING", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} has a non-positive animation interval.`);
    const endSample = exactSample(node, addRational(sceneOffset, event.end), composition.sampleRate, `${node.op}.${property} event end`);
    if (endSample <= startSample) fail(node, "CUT_AUDIO_AUTOMATION_TIMING", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} has no decoded samples in its animation interval.`);
    const from = quantityControl(node, composition, property, event.from), to = quantityControl(node, composition, property, event.to);
    controlValues.push(from.value, to.value);
    const progress = `((n-${startSample})/${endSample - startSample})`;
    const curve = easingKind(event.curve, node), curved = easingExpression(curve, progress);
    const animated = `((${from.expression})+((${to.expression})-(${from.expression}))*(${curved}))`;
    segments.push({
      startSample,
      expression: animated,
      valueAtSample: (sample) => {
        const progressAtSample = (sample - startSample) / (endSample - startSample);
        return from.value + (to.value - from.value) * easingValue(curve, progressAtSample);
      },
    });
    segments.push({ startSample: endSample, expression: to.expression, valueAtSample: () => to.value });
  }
  if (!segments.length) fail(node, "CUT_AUDIO_AUTOMATION_GRAPH", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} produced no executable sample segments.`);
  const balanced = (start: number, end: number): string => {
    if (end - start === 1) return segments[start].expression;
    const middle = start + Math.floor((end - start) / 2);
    return `if(lt(n,${segments[middle].startSample}),(${balanced(start, middle)}),(${balanced(middle, end)}))`;
  };
  const expression = balanced(0, segments.length);
  if (expression.length > maximumExpressionCharacters) fail(node, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} exceeds the ${maximumExpressionCharacters}-character expression limit.`);
  const valueAtSample = (sample: number) => {
    if (!Number.isSafeInteger(sample) || sample < 0) {
      fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} requires a non-negative safe-integer sample index; received ${String(sample)}.`);
    }
    let low = 0, high = segments.length;
    while (low + 1 < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (segments[middle].startSample <= sample) low = middle;
      else high = middle;
    }
    return segments[low].valueAtSample(sample);
  };
  return { expression, controlValues, valueAtSample };
}

/**
 * Compile the closed sample-domain property set currently promised by the
 * reference backend. The CUT-owned evaluator and FFmpeg `n` expression share
 * one validated segment plan. Expressions are intentionally unescaped; the
 * filter-graph boundary escapes them once.
 */
export function compileReferenceAudioAutomation(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  requestedProperty?: ReferenceAudioAutomationProperty,
): ReferenceAudioAutomation | undefined {
  const property = requestedProperty ?? (node.op === "cut.audio.gain" || node.op === "cut.audio.send" ? "amount"
    : node.op === "cut.audio.pan" ? "position"
      : node.op === "cut.audio.reverb" || node.op === "cut.audio.delay" ? "wet"
        : node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass" || node.op === "cut.audio.eq" ? "frequency"
          : undefined);
  if (!property) return undefined;
  const allowed = node.op === "cut.audio.compressor"
    ? compressorAutomationProperties.includes(property as typeof compressorAutomationProperties[number])
    : node.op === "cut.audio.limiter"
      ? limiterAutomationProperties.includes(property as typeof limiterAutomationProperties[number])
    : node.op === "cut.audio.sidechain"
      ? sidechainAutomationProperties.includes(property as typeof sidechainAutomationProperties[number])
    : node.op === "cut.audio.deesser"
      ? deEsserAutomationProperties.includes(property as typeof deEsserAutomationProperties[number])
    : ((node.op === "cut.audio.gain" || node.op === "cut.audio.send") && property === "amount")
      || (node.op === "cut.audio.pan" && property === "position")
      || (node.op === "cut.audio.reverb" && property === "wet")
      || (node.op === "cut.audio.delay" && property === "wet")
      || (node.op === "cut.audio.eq" && (property === "frequency" || property === "gain" || property === "q"))
      || ((node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") && (property === "frequency" || property === "q"));
  if (!allowed) return undefined;
  const authored = node.properties[property];
  if (!authored) return undefined;
  if (!("signal" in authored)) {
    const control = quantityControl(node, composition, property, authored);
    return { property, valueExpression: control.expression, valueAtSample: () => control.value, eventCount: 0, controlValues: [control.value] };
  }
  const signal = ir.signals[authored.signal];
  if (!signal) fail(node, "CUT_AUDIO_AUTOMATION_GRAPH", `Reference audio automation ${node.op}.${property} at ${sourceLabel(node)} references missing signal ${authored.signal}.`);
  const compiled = signalExpression(ir, composition, node, property, signal);
  return { property, valueExpression: compiled.expression, valueAtSample: compiled.valueAtSample, eventCount: signal.kind === "track" ? signal.events.length : 0, controlValues: compiled.controlValues };
}

function enforceGroupedAutomationBudget(
  node: IRNode,
  label: string,
  automations: readonly ReferenceAudioAutomation[],
  maximumEvents: number,
  maximumCharacters: number,
) {
  const events = automations.reduce((sum, automation) => sum + automation.eventCount, 0);
  if (events > maximumEvents) {
    fail(node, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference ${label} automation at ${sourceLabel(node)} declares ${events} total events; maximum is ${maximumEvents}.`);
  }
  const characters = automations.reduce((sum, automation) => sum + automation.valueExpression.length, 0);
  if (characters > maximumCharacters) {
    fail(node, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference ${label} automation at ${sourceLabel(node)} requires ${characters} expression characters; maximum is ${maximumCharacters}.`);
  }
}

function validateParametricEqAutomationDomain(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  automations: ReferenceParametricEqAutomations,
) {
  if (!Object.values(automations).some((automation) => automation.eventCount > 0)) return;
  const config = referenceAudioNodeConfig(ir, composition, node);
  if (config?.kind !== "eq") fail(node, "CUT_AUDIO_AUTOMATION_GRAPH", `Reference ParametricEQ automation at ${sourceLabel(node)} has no executable static control baseline.`);
  const values = {
    frequency: automations.frequency?.controlValues ?? [config.frequency],
    gain: automations.gain?.controlValues ?? [config.gainDb],
    q: automations.q?.controlValues ?? [config.q],
  };
  const maximumFrequency = composition.sampleRate * referenceParametricEqAutomationLimits.maximumFrequencySampleRateRatio;
  if (values.frequency.some((value) => value < referenceParametricEqAutomationLimits.minimumFrequencyHz || value > maximumFrequency)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Time-varying ParametricEQ.frequency at ${sourceLabel(node)} must stay between ${referenceParametricEqAutomationLimits.minimumFrequencyHz} Hz and ${maximumFrequency} Hz; static-only ParametricEQ retains its broader documented range.`);
  }
  if (values.gain.some((value) => value < referenceParametricEqAutomationLimits.minimumGainDb || value > referenceParametricEqAutomationLimits.maximumGainDb)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Time-varying ParametricEQ.gain at ${sourceLabel(node)} must stay between ${referenceParametricEqAutomationLimits.minimumGainDb} dB and +${referenceParametricEqAutomationLimits.maximumGainDb} dB.`);
  }
  if (values.q.some((value) => value < referenceParametricEqAutomationLimits.minimumQ || value > referenceParametricEqAutomationLimits.maximumQ)) {
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Time-varying ParametricEQ.q at ${sourceLabel(node)} must stay between ${referenceParametricEqAutomationLimits.minimumQ} and ${referenceParametricEqAutomationLimits.maximumQ}.`);
  }
}

export function compileReferenceParametricEqAutomations(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceParametricEqAutomations {
  if (node.op !== "cut.audio.eq") return {};
  const result: ReferenceParametricEqAutomations = {};
  for (const property of ["frequency", "gain", "q"] as const) {
    const automation = compileReferenceAudioAutomation(ir, composition, node, property);
    if (automation) result[property] = automation;
  }
  enforceGroupedAutomationBudget(
    node,
    "ParametricEQ",
    Object.values(result),
    referenceParametricEqLimits.maximumAutomationEventsPerNode,
    referenceParametricEqLimits.maximumAutomationExpressionCharactersPerNode,
  );
  validateParametricEqAutomationDomain(ir, composition, node, result);
  return result;
}

export function compileReferenceStateVariableFilterAutomations(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceStateVariableFilterAutomations {
  if (node.op !== "cut.audio.highpass" && node.op !== "cut.audio.lowpass") return {};
  const result: ReferenceStateVariableFilterAutomations = {};
  for (const property of ["frequency", "q"] as const) {
    const automation = compileReferenceAudioAutomation(ir, composition, node, property);
    if (automation) result[property] = automation;
  }
  enforceGroupedAutomationBudget(
    node,
    node.op === "cut.audio.highpass" ? "HighPass" : "LowPass",
    Object.values(result),
    referenceStateVariableFilterLimits.maximumAutomationEventsPerNode,
    referenceStateVariableFilterLimits.maximumAutomationExpressionCharactersPerNode,
  );
  return result;
}

export const compressorAutomationProperties = ["threshold", "ratio", "attack", "release", "makeup"] as const;

export function compileReferenceCompressorAutomations(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceCompressorAutomations {
  if (node.op !== "cut.audio.compressor") return {};
  const result: ReferenceCompressorAutomations = {};
  for (const property of compressorAutomationProperties) {
    const automation = compileReferenceAudioAutomation(ir, composition, node, property);
    if (automation) result[property] = automation;
  }
  enforceGroupedAutomationBudget(
    node,
    "Compressor",
    Object.values(result),
    referenceCompressorLimits.maximumAutomationEventsPerNode,
    referenceCompressorLimits.maximumAutomationExpressionCharactersPerNode,
  );
  return result;
}

export const limiterAutomationProperties = ["ceiling", "release"] as const;

export function compileReferenceLimiterAutomations(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceLimiterAutomations {
  if (node.op !== "cut.audio.limiter") return {};
  const result: ReferenceLimiterAutomations = {};
  for (const property of limiterAutomationProperties) {
    const automation = compileReferenceAudioAutomation(ir, composition, node, property);
    if (automation) result[property] = automation;
  }
  enforceGroupedAutomationBudget(
    node,
    "Limiter",
    Object.values(result),
    referenceLimiterLimits.maximumAutomationEventsPerNode,
    referenceLimiterLimits.maximumAutomationExpressionCharactersPerNode,
  );
  return result;
}

export const sidechainAutomationProperties = ["amount", "threshold", "attack", "release"] as const;

export function compileReferenceSidechainAutomations(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceSidechainAutomations {
  if (node.op !== "cut.audio.sidechain") return {};
  const result: ReferenceSidechainAutomations = {};
  for (const property of sidechainAutomationProperties) {
    const automation = compileReferenceAudioAutomation(ir, composition, node, property);
    if (automation) result[property] = automation;
  }
  enforceGroupedAutomationBudget(
    node,
    "Sidechain",
    Object.values(result),
    referenceSidechainLimits.maximumAutomationEventsPerNode,
    referenceSidechainLimits.maximumAutomationExpressionCharactersPerNode,
  );

  const config = referenceAudioNodeConfig(ir, composition, node);
  if (config?.kind !== "sidechain") fail(node, "CUT_AUDIO_AUTOMATION_GRAPH", `Reference Sidechain automation at ${sourceLabel(node)} has no executable static control baseline.`);
  const amountValues = result.amount?.controlValues ?? [config.amountDb];
  const thresholdValues = result.threshold?.controlValues ?? [config.thresholdDb];
  const mostReductionDb = Math.min(...amountValues);
  const leastThresholdSpanDb = Math.max(...thresholdValues);
  if (!referenceSidechainControlsAreCalibrated(mostReductionDb, leastThresholdSpanDb)) {
    const maximumReductionDb = referenceSidechainMaximumReductionDb(leastThresholdSpanDb);
    fail(node, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", `Reference Sidechain automation at ${sourceLabel(node)} can combine amount ${mostReductionDb} dB with threshold ${leastThresholdSpanDb} dB, exceeding the ${-maximumReductionDb} dB maximum reduction for the bounded ${referenceSidechainLimits.maximumEquivalentRatio}:1 calibration.`);
  }
  return result;
}

export const deEsserAutomationProperties = ["intensity", "amount"] as const;

export function compileReferenceDeEsserAutomations(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceDeEsserAutomations {
  if (node.op !== "cut.audio.deesser") return {};
  const result: ReferenceDeEsserAutomations = {};
  for (const property of deEsserAutomationProperties) {
    const automation = compileReferenceAudioAutomation(ir, composition, node, property);
    if (automation) result[property] = automation;
  }
  enforceGroupedAutomationBudget(
    node,
    "DeEsser",
    Object.values(result),
    maximumAutomationEvents * deEsserAutomationProperties.length,
    maximumExpressionCharacters * deEsserAutomationProperties.length,
  );
  return result;
}

export function validateReferenceAudioAutomationBudget(
  ir: CutAVIR,
  composition: IRComposition,
  reachableNodeIds: ReadonlySet<string>,
) {
  const automatedNodes: IRNode[] = [];
  const automatedSimple: IRNode[] = [];
  const automatedFilters: IRNode[] = [];
  const automatedEqs: IRNode[] = [];
  const automatedCompressors: IRNode[] = [];
  const automatedLimiters: IRNode[] = [];
  const automatedSidechains: IRNode[] = [];
  const automatedDeEssers: IRNode[] = [];
  const deEssers: IRNode[] = [];
  for (const id of reachableNodeIds) {
    const node = ir.nodes[id];
    if (!node) continue;
    if (node.op === "cut.audio.deesser") deEssers.push(node);
    let classified: IRNode[] | undefined;
    if ((node.op === "cut.audio.gain" || node.op === "cut.audio.send" || node.op === "cut.audio.pan" || node.op === "cut.audio.reverb" || node.op === "cut.audio.delay") && Object.keys(node.properties).length) classified = automatedSimple;
    else if ((node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") && (node.properties.frequency || node.properties.q)) classified = automatedFilters;
    else if (node.op === "cut.audio.eq" && (node.properties.frequency || node.properties.gain || node.properties.q)) classified = automatedEqs;
    else if (node.op === "cut.audio.compressor" && compressorAutomationProperties.some((property) => node.properties[property])) classified = automatedCompressors;
    else if (node.op === "cut.audio.limiter" && limiterAutomationProperties.some((property) => node.properties[property])) classified = automatedLimiters;
    else if (node.op === "cut.audio.sidechain" && sidechainAutomationProperties.some((property) => node.properties[property])) classified = automatedSidechains;
    else if (node.op === "cut.audio.deesser" && deEsserAutomationProperties.some((property) => node.properties[property])) classified = automatedDeEssers;
    if (!classified) continue;
    classified.push(node);
    automatedNodes.push(node);
  }
  if (!automatedSimple.length && !automatedFilters.length && !automatedEqs.length && !automatedCompressors.length && !automatedLimiters.length && !automatedSidechains.length && !automatedDeEssers.length && !deEssers.length) return;
  const owner = automatedNodes[0] ?? deEssers[0]!;
  if (automatedNodes.length > referenceAudioAutomationLimits.maximumAutomatedNodesPerComposition) {
    fail(automatedNodes[referenceAudioAutomationLimits.maximumAutomatedNodesPerComposition], "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} declares ${automatedNodes.length} automated processor nodes; maximum is ${referenceAudioAutomationLimits.maximumAutomatedNodesPerComposition}.`);
  }
  if (automatedFilters.length > referenceStateVariableFilterLimits.maximumAutomatedNodesPerComposition) {
    fail(automatedFilters[0]!, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} declares ${automatedFilters.length} automated HighPass/LowPass nodes; maximum is ${referenceStateVariableFilterLimits.maximumAutomatedNodesPerComposition}.`);
  }
  if (automatedCompressors.length > referenceCompressorLimits.maximumAutomatedNodesPerComposition) {
    fail(automatedCompressors[0]!, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} declares ${automatedCompressors.length} automated Compressor nodes; maximum is ${referenceCompressorLimits.maximumAutomatedNodesPerComposition}.`);
  }
  if (automatedLimiters.length > referenceLimiterLimits.maximumAutomatedNodesPerComposition) {
    fail(automatedLimiters[0]!, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} declares ${automatedLimiters.length} automated Limiter nodes; maximum is ${referenceLimiterLimits.maximumAutomatedNodesPerComposition}.`);
  }
  if (automatedSidechains.length > referenceSidechainLimits.maximumAutomatedNodesPerComposition) {
    fail(automatedSidechains[0]!, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} declares ${automatedSidechains.length} automated Sidechain nodes; maximum is ${referenceSidechainLimits.maximumAutomatedNodesPerComposition}.`);
  }
  if (automatedDeEssers.length > referenceDeEsserCoreLimits.maximumNodesPerComposition) {
    fail(automatedDeEssers[referenceDeEsserCoreLimits.maximumNodesPerComposition]!, "CUT_AUDIO_DEESSER_WORK_LIMIT", `Reference audio automation in ${composition.name} declares ${automatedDeEssers.length} automated DeEsser nodes; maximum is ${referenceDeEsserCoreLimits.maximumNodesPerComposition}.`);
  }
  if (automatedEqs.length > referenceParametricEqLimits.maximumAutomatedNodesPerComposition) {
    fail(automatedEqs[0]!, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} declares ${automatedEqs.length} automated ParametricEQ nodes; maximum is ${referenceParametricEqLimits.maximumAutomatedNodesPerComposition}.`);
  }

  let renderedExpressionCharacters = 0;
  for (const automatedNode of automatedNodes) {
    let expressions: readonly ReferenceAudioAutomation[];
    let multiplicity: number;
    if (automatedNode.op === "cut.audio.gain" || automatedNode.op === "cut.audio.send" || automatedNode.op === "cut.audio.pan" || automatedNode.op === "cut.audio.reverb" || automatedNode.op === "cut.audio.delay") {
      const automation = compileReferenceAudioAutomation(ir, composition, automatedNode);
      expressions = automation ? [automation] : [];
      if (automatedNode.op === "cut.audio.gain" || automatedNode.op === "cut.audio.send") multiplicity = 2;
      else if (automatedNode.op === "cut.audio.delay") {
        const config = referenceAudioNodeConfig(ir, composition, automatedNode);
        if (config?.kind !== "delay") fail(automatedNode, "CUT_AUDIO_AUTOMATION_GRAPH", `Reference Delay automation at ${sourceLabel(automatedNode)} has no executable static control baseline.`);
        multiplicity = config.repeats + 1;
      } else multiplicity = 4;
    } else if (automatedNode.op === "cut.audio.eq") {
      expressions = Object.values(compileReferenceParametricEqAutomations(ir, composition, automatedNode));
      multiplicity = 2;
    } else if (automatedNode.op === "cut.audio.highpass" || automatedNode.op === "cut.audio.lowpass") {
      expressions = Object.values(compileReferenceStateVariableFilterAutomations(ir, composition, automatedNode));
      multiplicity = 2;
    } else if (automatedNode.op === "cut.audio.compressor") {
      expressions = Object.values(compileReferenceCompressorAutomations(ir, composition, automatedNode));
      multiplicity = 2;
    } else if (automatedNode.op === "cut.audio.limiter") {
      expressions = Object.values(compileReferenceLimiterAutomations(ir, composition, automatedNode));
      multiplicity = 2;
    } else if (automatedNode.op === "cut.audio.sidechain") {
      expressions = Object.values(compileReferenceSidechainAutomations(ir, composition, automatedNode));
      multiplicity = 2;
    } else {
      expressions = Object.values(compileReferenceDeEsserAutomations(ir, composition, automatedNode));
      multiplicity = 2;
    }
    renderedExpressionCharacters += multiplicity * expressions.reduce((sum, automation) => sum + automation.valueExpression.length, 0);
    if (renderedExpressionCharacters > referenceAudioAutomationLimits.maximumRenderedExpressionCharactersPerComposition) {
      fail(automatedNode, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} requires ${renderedExpressionCharacters} rendered expression characters; maximum is ${referenceAudioAutomationLimits.maximumRenderedExpressionCharactersPerComposition}.`);
    }
  }
  const exactFrames = multiplyRational(composition.duration, rational(composition.sampleRate));
  if (exactFrames.denominator !== "1") fail(owner, "CUT_AUDIO_AUTOMATION_SAMPLE_GRID", `Reference audio automation composition ${composition.name} does not end on its ${composition.sampleRate} Hz sample grid.`);
  const channelSamples = Number(exactFrames.numerator) * 2 * automatedFilters.length;
  if (!Number.isSafeInteger(channelSamples) || channelSamples > referenceStateVariableFilterLimits.maximumAutomatedChannelSamplesPerComposition) {
    fail(owner, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} requires ${channelSamples} time-varying filter channel-samples; maximum is ${referenceStateVariableFilterLimits.maximumAutomatedChannelSamplesPerComposition}.`);
  }
  const eqChannelSamples = Number(exactFrames.numerator) * 2 * automatedEqs.length;
  if (!Number.isSafeInteger(eqChannelSamples) || eqChannelSamples > referenceParametricEqLimits.maximumAutomatedChannelSamplesPerComposition) {
    fail(automatedEqs[0] ?? owner, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} requires ${eqChannelSamples} time-varying ParametricEQ channel-samples; maximum is ${referenceParametricEqLimits.maximumAutomatedChannelSamplesPerComposition}.`);
  }
  const compressorChannelSamples = Number(exactFrames.numerator) * 2 * automatedCompressors.length;
  if (!Number.isSafeInteger(compressorChannelSamples) || compressorChannelSamples > referenceCompressorLimits.maximumAutomatedChannelSamplesPerComposition) {
    fail(automatedCompressors[0] ?? owner, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} requires ${compressorChannelSamples} time-varying Compressor channel-samples; maximum is ${referenceCompressorLimits.maximumAutomatedChannelSamplesPerComposition}.`);
  }
  const limiterChannelSamples = Number(exactFrames.numerator) * 2 * automatedLimiters.length;
  if (!Number.isSafeInteger(limiterChannelSamples) || limiterChannelSamples > referenceLimiterLimits.maximumAutomatedChannelSamplesPerComposition) {
    fail(automatedLimiters[0] ?? owner, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} requires ${limiterChannelSamples} time-varying Limiter channel-samples; maximum is ${referenceLimiterLimits.maximumAutomatedChannelSamplesPerComposition}.`);
  }
  const sidechainChannelSamples = Number(exactFrames.numerator) * 2 * automatedSidechains.length;
  if (!Number.isSafeInteger(sidechainChannelSamples) || sidechainChannelSamples > referenceSidechainLimits.maximumAutomatedChannelSamplesPerComposition) {
    fail(automatedSidechains[0] ?? owner, "CUT_AUDIO_AUTOMATION_LIMIT", `Reference audio automation in ${composition.name} requires ${sidechainChannelSamples} time-varying Sidechain channel-samples; maximum is ${referenceSidechainLimits.maximumAutomatedChannelSamplesPerComposition}.`);
  }
  if (deEssers.length) {
    try {
      planReferenceDeEsserWork(Number(exactFrames.numerator), deEssers.length);
    } catch (error) {
      if (error instanceof ReferenceDeEsserCoreError) {
        const blamed = deEssers[Math.min(deEssers.length - 1, referenceDeEsserCoreLimits.maximumNodesPerComposition)]!;
        fail(blamed, "CUT_AUDIO_DEESSER_WORK_LIMIT", `${error.message.replace(/^CUT_AUDIO_DEESSER_WORK_LIMIT:\s*/u, "")} This is preflighted before backend or output allocation.`);
      }
      throw error;
    }
  }
}

export function escapeFfmpegAudioExpression(expression: string) {
  return expression.replaceAll("\\", "\\\\").replaceAll(",", "\\,");
}

export const referenceAudioAutomationLimits = Object.freeze({
  maximumEvents: maximumAutomationEvents,
  maximumExpressionCharacters,
  maximumAutomatedNodesPerComposition: 128,
  maximumRenderedExpressionCharactersPerComposition: 131_072,
  easings: ["linear", "outCubic"] as const,
  properties: [
    "Gain.amount",
    "Send.amount",
    "Pan.position",
    "Reverb.wet",
    "Delay.wet",
    "HighPass.frequency",
    "HighPass.q",
    "LowPass.frequency",
    "LowPass.q",
    "ParametricEQ.frequency",
    "ParametricEQ.gain",
    "ParametricEQ.q",
    "Compressor.threshold",
    "Compressor.ratio",
    "Compressor.attack",
    "Compressor.release",
    "Compressor.makeup",
    "Limiter.ceiling",
    "Limiter.release",
    "DeEsser.intensity",
    "DeEsser.amount",
    "Sidechain.amount",
    "Sidechain.threshold",
    "Sidechain.attack",
    "Sidechain.release",
  ] as const,
});
