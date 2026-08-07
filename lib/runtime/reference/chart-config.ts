import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import { addRational, compareRational, multiplyRational, rationalToNumber, type Rational } from "../../language/rational";
import { propertyAt } from "./signals";

export const referenceChartLimits = Object.freeze({
  maximumValues: 512,
  maximumAbsoluteValue: 1_000_000_000_000,
  maximumDimension: 65_536,
  maximumStrokeWidth: 1_024,
});

export type ReferenceChartKind = "bar" | "line" | "area";

export type ReferenceChartConfig = Readonly<{
  nodeId: string;
  kind: ReferenceChartKind;
  values: readonly number[];
  width: number;
  height: number;
  x: number;
  y: number;
  minimum: number;
  maximum: number;
  primary: string;
  secondary: string;
  background?: string;
  showAxes: boolean;
  axisColor: string;
  gap: number;
  strokeWidth: number;
}>;

export type ReferenceChartErrorCode =
  | "CUT_CHART_INPUT_TYPE"
  | "CUT_CHART_VALUE_RANGE"
  | "CUT_CHART_COMBINATION"
  | "CUT_CHART_LIMIT";

export class ReferenceChartError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceChartErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: Chart ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceChartError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

function fail(node: IRNode, code: ReferenceChartErrorCode, message: string): never {
  throw new ReferenceChartError(code, node, message);
}

function scalar(node: IRNode, name: string, value: IRValue | undefined, required = false) {
  if (value === undefined) {
    if (required) fail(node, "CUT_CHART_INPUT_TYPE", `requires input “${name}”: Number.`);
    return undefined;
  }
  if (value.kind !== "quantity" || value.dimension !== "scalar" || value.unit !== "scalar") {
    fail(node, "CUT_CHART_INPUT_TYPE", `input “${name}” must be a canonical Number.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_CHART_VALUE_RANGE", `input “${name}” must be finite.`);
  if (Math.abs(result) > referenceChartLimits.maximumAbsoluteValue) {
    fail(node, "CUT_CHART_VALUE_RANGE", `input “${name}” cannot exceed +/-${referenceChartLimits.maximumAbsoluteValue}.`);
  }
  return result;
}

function length(node: IRNode, name: string, value: IRValue | undefined, required: boolean, fallback = 0) {
  if (value === undefined) {
    if (required) fail(node, "CUT_CHART_INPUT_TYPE", `requires input “${name}”: Length.`);
    return fallback;
  }
  if (value.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(node, "CUT_CHART_INPUT_TYPE", `input “${name}” must be a canonical Length in px.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_CHART_VALUE_RANGE", `input “${name}” must be finite.`);
  return result;
}

function ratio(node: IRNode, name: string, value: IRValue | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_CHART_INPUT_TYPE", `input “${name}” must be a canonical Ratio.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < 0 || result > 1) {
    fail(node, "CUT_CHART_VALUE_RANGE", `input “${name}” must be between 0% and 100%.`);
  }
  return result;
}

function color(node: IRNode, name: string, value: IRValue | undefined, fallback?: string) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    fail(node, "CUT_CHART_INPUT_TYPE", `requires input “${name}”: Color.`);
  }
  if (value.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(value.value)) {
    fail(node, "CUT_CHART_INPUT_TYPE", `input “${name}” must be a canonical lowercase #RRGGBB or #RRGGBBAA Color.`);
  }
  if (value.value.length === 9 && value.value.endsWith("00")) {
    fail(node, "CUT_CHART_COMBINATION", `input “${name}” cannot be fully transparent because it would not affect output.`);
  }
  return value.value;
}

function boolean(node: IRNode, name: string, value: IRValue | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  if (value.kind !== "boolean") fail(node, "CUT_CHART_INPUT_TYPE", `input “${name}” must be Boolean.`);
  return value.value;
}

function kind(node: IRNode): ReferenceChartKind {
  const value = node.inputs.kind;
  if (value === undefined) return "bar";
  if (value.kind !== "string" || !["bar", "line", "area"].includes(value.value)) {
    fail(node, "CUT_CHART_INPUT_TYPE", "input “kind” must be one of: bar, line, area.");
  }
  return value.value as ReferenceChartKind;
}

function chartValues(node: IRNode) {
  const value = node.inputs.values;
  if (value?.kind !== "array") fail(node, "CUT_CHART_INPUT_TYPE", "input “values” must be a List<Number>.");
  if (value.items.length < 1) fail(node, "CUT_CHART_VALUE_RANGE", "input “values” must contain at least one number.");
  if (value.items.length > referenceChartLimits.maximumValues) {
    fail(node, "CUT_CHART_LIMIT", `input “values” exceeds the ${referenceChartLimits.maximumValues}-value budget.`);
  }
  return value.items.map((item, index) => scalar(node, `values[${index}]`, item, true)!);
}

function explicitDomain(node: IRNode, values: readonly number[]) {
  const hasMinimum = Object.hasOwn(node.inputs, "min");
  const hasMaximum = Object.hasOwn(node.inputs, "max");
  if (hasMinimum !== hasMaximum) {
    fail(node, "CUT_CHART_COMBINATION", "inputs “min” and “max” must be supplied together.");
  }
  const dataMinimum = Math.min(...values);
  const dataMaximum = Math.max(...values);
  if (!hasMinimum) {
    let minimum = Math.min(0, dataMinimum);
    let maximum = Math.max(0, dataMaximum);
    if (minimum === maximum) {
      minimum = -1;
      maximum = 1;
    }
    return { minimum, maximum };
  }
  const minimum = scalar(node, "min", node.inputs.min, true)!;
  const maximum = scalar(node, "max", node.inputs.max, true)!;
  if (minimum >= maximum) fail(node, "CUT_CHART_VALUE_RANGE", "input “min” must be strictly less than input “max”.");
  if (dataMinimum < minimum || dataMaximum > maximum) {
    fail(node, "CUT_CHART_VALUE_RANGE", `explicit domain [${minimum}, ${maximum}] does not contain every authored value.`);
  }
  return { minimum, maximum };
}

function signalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [signal.value];
  if (signal.kind === "step") return signal.points.map((point) => point.value);
  if (signal.kind === "keyframes") return signal.keyframes.map((keyframe) => keyframe.value);
  return [
    signal.initial,
    ...signal.events.flatMap((event) => event.kind === "set" ? [event.value] : [event.from, event.to]),
  ];
}

function validateRevealValue(node: IRNode, value: IRValue, label: string) {
  // A track may deliberately inherit its authored input/default before its
  // first event. The shared no-op/signal validator owns malformed null-only
  // tracks; null itself is not an out-of-range chart value.
  if (value.kind === "null") return;
  if (value.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_CHART_INPUT_TYPE", `${label} must be a canonical Ratio.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < 0 || result > 1) {
    fail(node, "CUT_CHART_VALUE_RANGE", `${label} must be between 0% and 100%.`);
  }
}

function validateAuthoredReveal(ir: CutAVIR, node: IRNode) {
  if (node.inputs.reveal !== undefined) validateRevealValue(node, node.inputs.reveal, "input “reveal”");
  const property = node.properties.reveal;
  if (property === undefined) return;
  if (!("signal" in property)) {
    validateRevealValue(node, property, "property “reveal”");
    return;
  }
  const signal = ir.signals[property.signal];
  if (!signal) fail(node, "CUT_CHART_INPUT_TYPE", `property “reveal” references missing signal ${property.signal}.`);
  signalValues(signal).forEach((value, index) => validateRevealValue(node, value, `property “reveal” signal value ${index}`));
}

function revealValueIsZero(value: IRValue | undefined) {
  return value?.kind === "quantity"
    && value.dimension === "ratio"
    && value.unit === "ratio"
    && value.magnitude.numerator === "0";
}

function sampledFrameSpan(start: Rational, end: Rational, fps: Rational) {
  try {
    const scaledStart = multiplyRational(start, fps), scaledEnd = multiplyRational(end, fps);
    const startNumerator = BigInt(scaledStart.numerator), startDenominator = BigInt(scaledStart.denominator);
    const endNumerator = BigInt(scaledEnd.numerator), endDenominator = BigInt(scaledEnd.denominator);
    if (startNumerator < 0n || endNumerator < 0n || startDenominator <= 0n || endDenominator <= 0n) return undefined;
    const first = (startNumerator + startDenominator - 1n) / startDenominator;
    const last = (endNumerator + endDenominator - 1n) / endDenominator - 1n;
    return first <= last ? { first, last, scaledStart } : undefined;
  } catch {
    // Ordinary rational/timing validation retains precedence for hostile IR.
    return undefined;
  }
}

function trackRevealIsZeroOnEverySampledFrame(node: IRNode, composition: IRComposition, signal: Extract<IRSignal, { kind: "track" }>, fallback: IRValue) {
  const intervalEnd = addRational(node.interval.start, node.interval.duration);
  const events: typeof signal.events = [];
  for (const event of signal.events) {
    const start = event.kind === "set" ? event.time : event.start;
    const previous = events.at(-1), previousStart = previous && (previous.kind === "set" ? previous.time : previous.start);
    // The evaluator uses source order as the exact-time tie break, so only the
    // final write at an identical start owns a non-empty selected segment.
    if (previousStart && compareRational(previousStart, start) === 0) events[events.length - 1] = event;
    else events.push(event);
  }

  const initial = signal.initial.kind === "null" ? fallback : signal.initial;
  const firstEventStart = events[0] && (events[0].kind === "set" ? events[0].time : events[0].start);
  if (sampledFrameSpan(node.interval.start, firstEventStart ?? intervalEnd, composition.fps) && !revealValueIsZero(initial)) return false;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const start = event.kind === "set" ? event.time : event.start;
    const next = events[index + 1];
    const selectedEnd = next ? (next.kind === "set" ? next.time : next.start) : intervalEnd;
    const span = sampledFrameSpan(start, selectedEnd, composition.fps);
    if (!span) continue;
    if (event.kind === "set") {
      if (!revealValueIsZero(event.value)) return false;
      continue;
    }
    if (revealValueIsZero(event.from) && revealValueIsZero(event.to)) continue;
    // One output sample exactly at an animation's start observes `from`. This
    // closes the common end-boundary trap without claiming that an arbitrary
    // multi-frame easing with a nonzero endpoint is invisible.
    if (span.first === span.last
      && span.scaledStart.denominator === "1"
      && BigInt(span.scaledStart.numerator) === span.first
      && revealValueIsZero(event.from)) continue;
    return false;
  }
  return true;
}

function revealIsProvablyAlwaysZero(ir: CutAVIR, node: IRNode, composition: IRComposition) {
  const fallback = node.inputs.reveal ?? { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: { numerator: "1", denominator: "1" } } satisfies IRValue;
  const property = node.properties.reveal;
  if (property === undefined) return revealValueIsZero(fallback);
  if (!("signal" in property)) return revealValueIsZero(property);
  const signal = ir.signals[property.signal];
  if (!signal) return false;
  if (signal.kind === "track") {
    return trackRevealIsZeroOnEverySampledFrame(node, composition, signal, fallback);
  }
  const values = signalValues(signal);
  return values.length > 0 && values.every((value) => revealValueIsZero(value));
}

/** Close the public Chart input boundary before SVG construction or caching. */
export function referenceChartConfig(ir: CutAVIR, node: IRNode, composition: IRComposition): ReferenceChartConfig | undefined {
  if (node.op !== "cut.data.chart") return undefined;
  validateAuthoredReveal(ir, node);
  if (revealIsProvablyAlwaysZero(ir, node, composition)) {
    fail(node, "CUT_CHART_COMBINATION", "reveal is 0% for the complete node interval, so values and chart appearance would never affect output.");
  }
  const chartKind = kind(node);
  const values = chartValues(node);
  if (chartKind !== "bar" && values.length < 2) {
    fail(node, "CUT_CHART_VALUE_RANGE", `${chartKind} charts require at least two values.`);
  }
  const width = length(node, "width", node.inputs.width, true);
  const height = length(node, "height", node.inputs.height, true);
  if (width <= 0 || width > referenceChartLimits.maximumDimension) {
    fail(node, "CUT_CHART_VALUE_RANGE", `input “width” must be greater than 0px and at most ${referenceChartLimits.maximumDimension}px.`);
  }
  if (height <= 0 || height > referenceChartLimits.maximumDimension) {
    fail(node, "CUT_CHART_VALUE_RANGE", `input “height” must be greater than 0px and at most ${referenceChartLimits.maximumDimension}px.`);
  }
  const x = length(node, "x", node.inputs.x, false, composition.width / 2);
  const y = length(node, "y", node.inputs.y, false, composition.height / 2);
  if (Math.abs(x) > referenceChartLimits.maximumDimension || Math.abs(y) > referenceChartLimits.maximumDimension) {
    fail(node, "CUT_CHART_VALUE_RANGE", `inputs “x” and “y” must remain within +/-${referenceChartLimits.maximumDimension}px.`);
  }

  const showAxes = boolean(node, "showAxes", node.inputs.showAxes, false);
  if (!showAxes && Object.hasOwn(node.inputs, "axisColor")) {
    fail(node, "CUT_CHART_COMBINATION", "input “axisColor” requires showAxes: true.");
  }
  if (chartKind !== "bar" && Object.hasOwn(node.inputs, "gap")) {
    fail(node, "CUT_CHART_COMBINATION", "input “gap” is executable only for kind: \"bar\".");
  }
  if (chartKind === "bar" && Object.hasOwn(node.inputs, "strokeWidth")) {
    fail(node, "CUT_CHART_COMBINATION", "input “strokeWidth” is executable only for kind: \"line\" or \"area\".");
  }
  const gap = ratio(node, "gap", node.inputs.gap, 0.2);
  if (gap >= 0.95) fail(node, "CUT_CHART_VALUE_RANGE", "input “gap” must be less than 95% so every bar has visible width.");
  const strokeWidth = length(node, "strokeWidth", node.inputs.strokeWidth, false, 4);
  if (strokeWidth <= 0 || strokeWidth > referenceChartLimits.maximumStrokeWidth || strokeWidth > Math.min(width, height) / 4) {
    fail(node, "CUT_CHART_VALUE_RANGE", `input “strokeWidth” must be positive and no more than one quarter of the smaller chart dimension or ${referenceChartLimits.maximumStrokeWidth}px.`);
  }

  const primary = color(node, "primary", node.inputs.primary, "#2563eb");
  const secondary = color(node, "secondary", node.inputs.secondary, primary);
  const background = node.inputs.background === undefined ? undefined : color(node, "background", node.inputs.background);
  const axisColor = color(node, "axisColor", node.inputs.axisColor, "#6b7280");
  const domain = explicitDomain(node, values);
  return Object.freeze({
    nodeId: node.id,
    kind: chartKind,
    values: Object.freeze(values),
    width,
    height,
    x,
    y,
    ...domain,
    primary,
    secondary,
    ...(background ? { background } : {}),
    showAxes,
    axisColor,
    gap,
    strokeWidth,
  });
}

export function referenceChartRevealAt(ir: CutAVIR, node: IRNode, time: Rational) {
  const executed = propertyAt(ir, node, "reveal", time);
  // Current lowering and strict IR give an ordinary delayed track Chart's exact
  // non-null 100% public baseline. Keep this fallback only for the static path
  // and archived/direct helper callers; session validation rejects a current
  // ordinary null track before this executor runs.
  const value = executed === undefined || executed.kind === "null" ? node.inputs.reveal : executed;
  if (value === undefined || value.kind === "null") return 1;
  if (value.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_CHART_INPUT_TYPE", "executed reveal must be a canonical Ratio.");
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_CHART_VALUE_RANGE", "executed reveal must be finite.");
  // Authored constructor/property/signal payloads were already validated in
  // referenceChartConfig. An easing curve may intentionally overshoot those
  // valid endpoints; reveal is a bounded coverage control, so its explicit
  // execution rule saturates only the derived interpolated value.
  return Math.max(0, Math.min(1, result));
}

function number(value: number) {
  if (!Number.isFinite(value)) throw new Error("Internal CUT Chart geometry is not finite.");
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Deterministic, text-free SVG plan. Typography remains a separately locked layer. */
export function referenceChartSvg(config: ReferenceChartConfig, reveal: number, canvasWidth: number, canvasHeight: number) {
  if (!Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight) || canvasWidth < 1 || canvasHeight < 1) {
    throw new Error("Internal CUT Chart canvas must have positive safe-integer dimensions.");
  }
  if (!Number.isFinite(reveal) || reveal < 0 || reveal > 1) throw new Error("Internal CUT Chart reveal lies outside [0, 1].");
  const left = config.x - config.width / 2;
  const top = config.y - config.height / 2;
  const inset = config.showAxes ? Math.max(1, config.strokeWidth / 2) : 0;
  const plotLeft = left + inset;
  const plotTop = top + inset;
  const plotWidth = Math.max(1, config.width - inset * 2);
  const plotHeight = Math.max(1, config.height - inset * 2);
  const mapY = (value: number) => plotTop + (config.maximum - value) / (config.maximum - config.minimum) * plotHeight;
  const baseline = Math.min(config.maximum, Math.max(config.minimum, 0));
  const baselineY = mapY(baseline);
  const background = config.background
    ? `<rect x="${number(left)}" y="${number(top)}" width="${number(config.width)}" height="${number(config.height)}" fill="${config.background}"/>`
    : "";
  const axes = config.showAxes
    ? `<path d="M${number(plotLeft)},${number(plotTop)}V${number(plotTop + plotHeight)}M${number(plotLeft)},${number(baselineY)}H${number(plotLeft + plotWidth)}" fill="none" stroke="${config.axisColor}" stroke-width="1"/>`
    : "";
  const gradient = `<linearGradient id="cut-chart-series" gradientUnits="userSpaceOnUse" x1="${number(plotLeft)}" y1="0" x2="${number(plotLeft + plotWidth)}" y2="0"><stop offset="0" stop-color="${config.primary}"/><stop offset="1" stop-color="${config.secondary}"/></linearGradient>`;

  let marks = "";
  if (reveal > 0 && config.kind === "bar") {
    const slot = plotWidth / config.values.length;
    const barWidth = Math.max(0.5, slot * (1 - config.gap));
    const eased = 1 - (1 - reveal) ** 3;
    marks = config.values.map((value, index) => {
      const valueY = mapY(value);
      const rawHeight = Math.abs(valueY - baselineY);
      // A datum exactly on the selected baseline has zero visual magnitude.
      // Giving it the normal sub-pixel reveal floor creates a false 1px bar at
      // full reveal, which is a data-semantic error rather than antialiasing.
      if (rawHeight === 0) return "";
      const visibleHeight = Math.max(Math.min(1, eased), rawHeight * eased);
      const y = value >= baseline ? baselineY - visibleHeight : baselineY;
      const x = plotLeft + slot * index + (slot - barWidth) / 2;
      return `<rect x="${number(x)}" y="${number(y)}" width="${number(barWidth)}" height="${number(visibleHeight)}" fill="url(#cut-chart-series)"/>`;
    }).join("");
  } else if (reveal > 0) {
    const points = config.values.map((value, index) => ({
      x: plotLeft + (config.values.length === 1 ? plotWidth / 2 : index * plotWidth / (config.values.length - 1)),
      y: mapY(value),
    }));
    const path = points.map((point, index) => `${index ? "L" : "M"}${number(point.x)},${number(point.y)}`).join("");
    const clippedWidth = Math.max(0.000001, plotWidth * reveal);
    const area = config.kind === "area"
      ? `<path d="${path}L${number(points.at(-1)!.x)},${number(baselineY)}L${number(points[0].x)},${number(baselineY)}Z" fill="url(#cut-chart-series)" fill-opacity="0.4"/>`
      : "";
    const dots = points.map((point) => `<circle cx="${number(point.x)}" cy="${number(point.y)}" r="${number(Math.max(1, config.strokeWidth * 0.9))}" fill="url(#cut-chart-series)"/>`).join("");
    marks = `<g clip-path="url(#cut-chart-reveal)">${area}<path d="${path}" fill="none" stroke="url(#cut-chart-series)" stroke-width="${number(config.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>${dots}</g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}"><defs>${gradient}<clipPath id="cut-chart-reveal"><rect x="${number(plotLeft)}" y="${number(plotTop - config.strokeWidth * 2)}" width="${number(clippedWidth)}" height="${number(plotHeight + config.strokeWidth * 4)}"/></clipPath></defs>${background}${axes}${marks}</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}"><defs>${gradient}</defs>${background}${axes}${marks}</svg>`;
}
