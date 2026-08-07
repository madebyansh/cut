import type { CutAVIR, IRNode, IRSignal, IRValue } from "../../language/ir";
import { rationalToNumber, type Rational } from "../../language/rational";
import { propertyAt } from "./signals";

export type ReferenceColorGradeConfigErrorCode =
  | "CUT_COLOR_INPUT_TYPE"
  | "CUT_COLOR_VALUE_RANGE"
  | "CUT_COLOR_SIGNAL"
  | "CUT_COLOR_GRAPH";

export class ReferenceColorGradeConfigError extends Error {
  constructor(readonly code: ReferenceColorGradeConfigErrorCode, readonly nodeId: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceColorGradeConfigError";
  }
}

/**
 * The exact authored domain accepted by the CPU reference grade. Values are
 * bounded before Sharp/libvips is invoked, so native parameter coercion never
 * becomes part of CUT semantics.
 */
export const referenceColorGradeLimits = Object.freeze({
  exposure: Object.freeze({ minimum: -16, maximum: 16, default: 0 }),
  temperature: Object.freeze({ minimum: -1, maximum: 1, default: 0 }),
  tint: Object.freeze({ minimum: -1, maximum: 1, default: 0 }),
  brightness: Object.freeze({ minimum: 0.01, maximum: 4, default: 1 }),
  saturation: Object.freeze({ minimum: 0, maximum: 4, default: 1 }),
  contrast: Object.freeze({ minimum: 0, maximum: 4, default: 1 }),
  hue: Object.freeze({ minimumDegrees: -360_000, maximumDegrees: 360_000, defaultDegrees: 0 }),
});

export type ReferenceColorGradeConfig = Readonly<{
  /** Linear-light multiplier expressed as exact authored stops. */
  exposureStops: number;
  /** Bounded creative blue-to-amber balance; this is not Kelvin metadata. */
  temperature: number;
  /** Bounded creative green-to-magenta balance; this is not camera tint metadata. */
  tint: number;
  brightness: number;
  saturation: number;
  hueDegrees: number;
  contrast: number;
}>;

type LabeledValue = { value: IRValue; label: string };

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(node: IRNode, code: ReferenceColorGradeConfigErrorCode, message: string): never {
  throw new ReferenceColorGradeConfigError(code, node.id, `${node.op} at ${location(node)} ${message}`);
}

function canonicalRational(node: IRNode, label: string, value: Rational) {
  try {
    const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
    if (denominator <= 0n) fail(node, "CUT_COLOR_INPUT_TYPE", `${label} must use a canonical rational with a positive denominator.`);
    return { numerator, denominator };
  } catch (error) {
    if (error instanceof ReferenceColorGradeConfigError) throw error;
    fail(node, "CUT_COLOR_INPUT_TYPE", `${label} must use a canonical rational quantity.`);
  }
}

function scalar(
  node: IRNode,
  label: string,
  value: IRValue | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== "scalar" || value.unit !== "scalar") {
    fail(node, "CUT_COLOR_INPUT_TYPE", `${label} must be a canonical scalar quantity.`);
  }
  canonicalRational(node, label, value.magnitude);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    fail(node, "CUT_COLOR_VALUE_RANGE", `${label} must be between ${minimum} and ${maximum}, inclusive.`);
  }
  return result;
}

function hue(
  node: IRNode,
  label: string,
  value: IRValue | undefined,
  fallback: number,
) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== "angle" || value.unit !== "deg") {
    fail(node, "CUT_COLOR_INPUT_TYPE", `${label} must be a canonical angle quantity in degrees.`);
  }
  const exact = canonicalRational(node, label, value.magnitude);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < referenceColorGradeLimits.hue.minimumDegrees || result > referenceColorGradeLimits.hue.maximumDegrees) {
    fail(
      node,
      "CUT_COLOR_VALUE_RANGE",
      `${label} must be between ${referenceColorGradeLimits.hue.minimumDegrees}deg and ${referenceColorGradeLimits.hue.maximumDegrees}deg, inclusive.`,
    );
  }
  // Normalize the authored exact rational before converting to a native
  // number. JavaScript remainder and backend-specific wrapping are therefore
  // not part of CUT's hue semantics.
  const cycle = 360n * exact.denominator;
  const normalizedNumerator = ((exact.numerator % cycle) + cycle) % cycle;
  return Number(normalizedNumerator) / Number(exact.denominator);
}

function signalValues(node: IRNode, signal: IRSignal, prefix: string, allowUnsetTrackInitial: boolean): LabeledValue[] {
  if (signal.kind === "constant") return [{ value: signal.value, label: `${prefix}.value` }];
  if (signal.kind === "step") {
    if (!signal.points.length) fail(node, "CUT_COLOR_SIGNAL", `${prefix} must contain at least one step point.`);
    return signal.points.map((point, index) => ({ value: point.value, label: `${prefix}.points[${index}].value` }));
  }
  if (signal.kind === "keyframes") {
    if (!signal.keyframes.length) fail(node, "CUT_COLOR_SIGNAL", `${prefix} must contain at least one keyframe.`);
    return signal.keyframes.map((keyframe, index) => ({ value: keyframe.value, label: `${prefix}.keyframes[${index}].value` }));
  }
  if (signal.initial.kind === "null" && !signal.events.length) {
    fail(node, "CUT_COLOR_SIGNAL", `${prefix} has neither an initial value nor an event to execute.`);
  }
  return [
    ...(allowUnsetTrackInitial && signal.initial.kind === "null" ? [] : [{ value: signal.initial, label: `${prefix}.initial` }]),
    ...signal.events.flatMap((event, index) => event.kind === "set"
      ? [{ value: event.value, label: `${prefix}.events[${index}].value` }]
      : [
        { value: event.from, label: `${prefix}.events[${index}].from` },
        { value: event.to, label: `${prefix}.events[${index}].to` },
      ]),
  ];
}

function propertyValues(ir: CutAVIR, node: IRNode, name: string): LabeledValue[] {
  const property = node.properties[name];
  if (!property) return [];
  if (!("signal" in property)) return [{ value: property, label: `property “${name}”` }];
  const signal = ir.signals[property.signal];
  if (!signal) fail(node, "CUT_COLOR_SIGNAL", `property “${name}” references missing signal ${property.signal}.`);
  return signalValues(node, signal, `property “${name}” signal ${property.signal}`, node.inputs[name] === undefined);
}

function executedProperty(ir: CutAVIR, node: IRNode, name: string, time: Rational) {
  const authored = node.properties[name];
  if (authored && "signal" in authored && !ir.signals[authored.signal]) {
    fail(node, "CUT_COLOR_SIGNAL", `property “${name}” references missing signal ${authored.signal}.`);
  }
  const value = propertyAt(ir, node, name, time);
  // A compiler-created track uses null only as the explicit "no authored
  // property before the first event" sentinel. It resolves to the node input
  // or the documented identity default; authored/direct nulls still fail in
  // preflight above.
  return value?.kind === "null" ? node.inputs[name] : value ?? node.inputs[name];
}

type ReferenceColorGradeValueName = "exposure" | "temperature" | "tint" | "brightness" | "saturation" | "hue" | "contrast";
type ReferenceColorGradeScalarName = Exclude<ReferenceColorGradeValueName, "hue">;

function configFromValues(node: IRNode, values: Record<ReferenceColorGradeValueName, IRValue | undefined>): ReferenceColorGradeConfig {
  return Object.freeze({
    exposureStops: scalar(node, "exposure", values.exposure, referenceColorGradeLimits.exposure.minimum, referenceColorGradeLimits.exposure.maximum, referenceColorGradeLimits.exposure.default),
    temperature: scalar(node, "temperature", values.temperature, referenceColorGradeLimits.temperature.minimum, referenceColorGradeLimits.temperature.maximum, referenceColorGradeLimits.temperature.default),
    tint: scalar(node, "tint", values.tint, referenceColorGradeLimits.tint.minimum, referenceColorGradeLimits.tint.maximum, referenceColorGradeLimits.tint.default),
    brightness: scalar(node, "brightness", values.brightness, referenceColorGradeLimits.brightness.minimum, referenceColorGradeLimits.brightness.maximum, referenceColorGradeLimits.brightness.default),
    saturation: scalar(node, "saturation", values.saturation, referenceColorGradeLimits.saturation.minimum, referenceColorGradeLimits.saturation.maximum, referenceColorGradeLimits.saturation.default),
    hueDegrees: hue(node, "hue", values.hue, referenceColorGradeLimits.hue.defaultDegrees),
    contrast: scalar(node, "contrast", values.contrast, referenceColorGradeLimits.contrast.minimum, referenceColorGradeLimits.contrast.maximum, referenceColorGradeLimits.contrast.default),
  });
}

function validateGraph(node: IRNode) {
  if (node.children.length !== 1) fail(node, "CUT_COLOR_GRAPH", `requires exactly one visual child to grade; found ${node.children.length}.`);
}

/** Close static inputs and every stored signal value before native image work. */
export function validateReferenceColorGradeConfig(ir: CutAVIR, node: IRNode) {
  if (node.op !== "cut.visual.color_grade") return;
  validateGraph(node);
  configFromValues(node, {
    exposure: node.inputs.exposure,
    temperature: node.inputs.temperature,
    tint: node.inputs.tint,
    brightness: node.inputs.brightness,
    saturation: node.inputs.saturation,
    hue: node.inputs.hue,
    contrast: node.inputs.contrast,
  });
  for (const name of ["exposure", "temperature", "tint", "brightness", "saturation", "hue", "contrast"] as const) {
    for (const item of propertyValues(ir, node, name)) {
      if (name === "hue") hue(node, item.label, item.value, referenceColorGradeLimits.hue.defaultDegrees);
      else {
        const limit = referenceColorGradeLimits[name as ReferenceColorGradeScalarName];
        scalar(node, item.label, item.value, limit.minimum, limit.maximum, limit.default);
      }
    }
  }
}

/** Evaluate one frame through the same strict value parser used by preflight. */
export function referenceColorGradeConfigAt(ir: CutAVIR, node: IRNode, time: Rational): ReferenceColorGradeConfig {
  if (node.op !== "cut.visual.color_grade") fail(node, "CUT_COLOR_GRAPH", "is not a ColorGrade node.");
  validateGraph(node);
  return configFromValues(node, {
    exposure: executedProperty(ir, node, "exposure", time),
    temperature: executedProperty(ir, node, "temperature", time),
    tint: executedProperty(ir, node, "tint", time),
    brightness: executedProperty(ir, node, "brightness", time),
    saturation: executedProperty(ir, node, "saturation", time),
    hue: executedProperty(ir, node, "hue", time),
    contrast: executedProperty(ir, node, "contrast", time),
  });
}
