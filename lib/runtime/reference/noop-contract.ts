import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import { cutMediaCamera2DDefaultIRValue, cutMediaCamera2DOp } from "../../language/media-camera2d-contract";
import { kernelPropertyInputIsIntrinsic, referenceKernelSchema } from "../../language/kernel-registry";
import { addRational, compareRational, divideRational, multiplyRational, rational, zeroRational, type Rational } from "../../language/rational";
import {
  compileReferenceAudioAutomation,
  compileReferenceCompressorAutomations,
  compileReferenceDeEsserAutomations,
  compileReferenceLimiterAutomations,
  compileReferenceParametricEqAutomations,
  compileReferenceSidechainAutomations,
  compileReferenceStateVariableFilterAutomations,
  ReferenceAudioAutomationError,
  referenceAudioAutomationDefaultValue,
  type ReferenceAudioAutomationProperty,
} from "./audio-automation";
import { ReferenceAudioConfigError } from "./audio-config";
import {
  createReferenceMotionBlurBoundaryPlan,
  prepareReferenceMotionBlurBoundary,
} from "./motion-blur-boundary";
import { referenceMotionBlurConfig } from "./motion-blur";
import { evaluateSignal } from "./signals";

export const referenceNoOpDiagnosticCode = "CUT_NODE_NOOP" as const;

export type ReferenceNoOpSource = {
  module: string;
  line: number;
  column: number;
  nodeId: string;
};

/**
 * An accepted CUT argument must influence executable output. This error closes
 * combinations whose individual values are well typed but whose surrounding
 * graph makes them provably irrelevant.
 */
export class ReferenceNoOpContractError extends Error {
  readonly code = referenceNoOpDiagnosticCode;
  readonly source: ReferenceNoOpSource;

  constructor(readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${referenceNoOpDiagnosticCode}: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceNoOpContractError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

function fail(node: IRNode, message: string): never {
  throw new ReferenceNoOpContractError(node, message);
}

const emptyVisualContainers = new Set([
  "cut.visual.group",
  "cut.visual.stack",
  "cut.visual.composite",
  "cut.visual.camera2d",
  "cut.visual.parallax_camera",
  "cut.visual.depth_layer",
]);

/**
 * A five-minute 30fps scene has 9,000 ordinary output samples; the supported
 * nested MotionBlur ceiling can amplify that to 576,000 exact child samples.
 * Keep the proof bounded against hostile graphs while covering that complete
 * professional-duration execution grid and several counterfactual items.
 */
const maximumVisualSignalNoOpProofWork = 4_000_000n;

class VisualSignalNoOpProofBudgetError extends Error {
  constructor() {
    super("CUT visual signal exact execution proof exceeded its closed work budget.");
    this.name = "VisualSignalNoOpProofBudgetError";
  }
}

function authoredControls(node: IRNode) {
  return [...Object.keys(node.inputs), ...Object.keys(node.properties).map((name) => `property:${name}`)].sort();
}

function stringValue(value: IRValue | undefined, fallback: string) {
  return value?.kind === "string" ? value.value : fallback;
}

function exactLengthMagnitude(value: IRValue | undefined) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") return undefined;
  try {
    return compareRational(value.magnitude, zeroRational);
  } catch {
    // The ordinary typed value validator owns malformed rational diagnostics.
    return undefined;
  }
}

function exactRatioMagnitude(value: IRValue | undefined) {
  if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") return undefined;
  try {
    return compareRational(value.magnitude, zeroRational);
  } catch {
    // The ordinary typed value validator owns malformed rational diagnostics.
    return undefined;
  }
}

function exactScalarInteger(value: IRValue | undefined) {
  if (value?.kind !== "quantity" || value.dimension !== "scalar" || value.unit !== "scalar") return undefined;
  try {
    if (value.magnitude.denominator !== "1") return undefined;
    const result = Number(value.magnitude.numerator);
    return Number.isSafeInteger(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

function exactQuantityEquals(
  value: IRValue | undefined,
  dimension: "gain" | "ratio" | "scalar" | "time",
  unit: "db" | "ratio" | "scalar" | "s",
  numerator: number,
  denominator = 1,
) {
  if (value?.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) return false;
  try {
    return compareRational(value.magnitude, rational(numerator, denominator)) === 0;
  } catch {
    // The ordinary typed/rational validator owns malformed-value diagnostics.
    return false;
  }
}

function exactQuantityIsPositive(
  value: IRValue | undefined,
  dimension: "ratio" | "time",
  unit: "ratio" | "s",
) {
  if (value?.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) return false;
  try {
    return compareRational(value.magnitude, zeroRational) > 0;
  } catch {
    return false;
  }
}

function exactQuantitiesEqual(
  left: IRValue | undefined,
  right: IRValue | undefined,
  dimension: "time",
  unit: "s",
) {
  if (
    left?.kind !== "quantity" || right?.kind !== "quantity"
    || left.dimension !== dimension || right.dimension !== dimension
    || left.unit !== unit || right.unit !== unit
  ) return false;
  try {
    return compareRational(left.magnitude, right.magnitude) === 0;
  } catch {
    return false;
  }
}

function fullyTransparentColor(value: IRValue | undefined) {
  return value?.kind === "color" && /^#[0-9a-f]{8}$/i.test(value.value) && value.value.toLowerCase().endsWith("00");
}

/** Canonical typed-IR equality. Object key order is not semantic, while exact
 * rationals compare by value so hostile-but-well-typed inputs cannot evade the
 * compiler/runtime no-op contract through a different in-memory object. */
export function canonicalIrValuesEqual(left: IRValue, right: IRValue): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "null": return true;
    case "boolean": return left.value === (right as Extract<IRValue, { kind: "boolean" }>).value;
    case "string": return left.value === (right as Extract<IRValue, { kind: "string" }>).value;
    case "color": return left.value === (right as Extract<IRValue, { kind: "color" }>).value;
    case "quantity": {
      const candidate = right as Extract<IRValue, { kind: "quantity" }>;
      try {
        return left.dimension === candidate.dimension
          && left.unit === candidate.unit
          && compareRational(left.magnitude, candidate.magnitude) === 0;
      } catch {
        return false;
      }
    }
    case "array": {
      const candidate = right as Extract<IRValue, { kind: "array" }>;
      return left.items.length === candidate.items.length
        && left.items.every((item, index) => canonicalIrValuesEqual(item, candidate.items[index]!));
    }
    case "object": {
      const candidate = right as Extract<IRValue, { kind: "object" }>;
      const keys = Object.keys(left.entries).sort(), candidateKeys = Object.keys(candidate.entries).sort();
      return keys.length === candidateKeys.length
        && keys.every((key, index) => key === candidateKeys[index]
          && canonicalIrValuesEqual(left.entries[key]!, candidate.entries[key]!));
    }
    case "range": {
      const candidate = right as Extract<IRValue, { kind: "range" }>;
      return left.exclusive === candidate.exclusive
        && canonicalIrValuesEqual(left.start, candidate.start)
        && canonicalIrValuesEqual(left.end, candidate.end);
    }
    case "node-ref": return left.id === (right as Extract<IRValue, { kind: "node-ref" }>).id;
    case "resource-ref": return left.id === (right as Extract<IRValue, { kind: "resource-ref" }>).id;
    case "timeline-ref": return left.id === (right as Extract<IRValue, { kind: "timeline-ref" }>).id;
    case "symbol": return left.name === (right as Extract<IRValue, { kind: "symbol" }>).name;
    case "unary": {
      const candidate = right as Extract<IRValue, { kind: "unary" }>;
      return left.operator === candidate.operator && canonicalIrValuesEqual(left.value, candidate.value);
    }
    case "binary": {
      const candidate = right as Extract<IRValue, { kind: "binary" }>;
      return left.operator === candidate.operator
        && canonicalIrValuesEqual(left.left, candidate.left)
        && canonicalIrValuesEqual(left.right, candidate.right);
    }
    case "member": {
      const candidate = right as Extract<IRValue, { kind: "member" }>;
      return left.property === candidate.property && canonicalIrValuesEqual(left.object, candidate.object);
    }
    case "index": {
      const candidate = right as Extract<IRValue, { kind: "index" }>;
      return canonicalIrValuesEqual(left.object, candidate.object)
        && canonicalIrValuesEqual(left.index, candidate.index);
    }
    case "call": {
      const candidate = right as Extract<IRValue, { kind: "call" }>;
      const names = Object.keys(left.named).sort(), candidateNames = Object.keys(candidate.named).sort();
      return left.op === candidate.op
        && left.effect === candidate.effect
        && left.positional.length === candidate.positional.length
        && left.positional.every((item, index) => canonicalIrValuesEqual(item, candidate.positional[index]!))
        && names.length === candidateNames.length
        && names.every((name, index) => name === candidateNames[index]
          && canonicalIrValuesEqual(left.named[name]!, candidate.named[name]!));
    }
  }
}

function explicitControls(node: IRNode, inputs: readonly string[], properties: readonly string[] = inputs) {
  return [
    ...inputs.filter((name) => Object.hasOwn(node.inputs, name)),
    ...properties.filter((name) => Object.hasOwn(node.properties, name)).map((name) => `property:${name}`),
  ].sort();
}

function failInertControls(node: IRNode, reason: string, controls: readonly string[]) {
  if (!controls.length) return;
  fail(node, `${reason}; inert explicitly authored control(s): ${controls.join(", ")}`);
}

function validTrackEventTime(node: IRNode, signal: Extract<IRSignal, { kind: "track" }>) {
  try {
    const intervalEnd = addRational(node.interval.start, node.interval.duration);
    let previousStart: Rational | undefined;
    for (const event of signal.events) {
      const start = event.kind === "set" ? event.time : event.start;
      if (
        compareRational(start, node.interval.start) < 0
        || compareRational(start, intervalEnd) >= 0
        || (previousStart !== undefined && compareRational(start, previousStart) < 0)
      ) return false;
      if (event.kind === "animate" && (
        compareRational(event.end, event.start) <= 0
        || compareRational(event.end, intervalEnd) > 0
      )) return false;
      previousStart = start;
    }
    return true;
  } catch {
    // The ordinary signal/timing validator owns malformed rationals.
    return false;
  }
}

function compositionContainsNode(ir: CutAVIR, composition: IRComposition, nodeId: string) {
  const pending = [...composition.rootVisualIds, ...composition.rootAudioIds, ...composition.rootAVIds];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === nodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = ir.nodes[current];
    if (node) pending.push(...node.children);
  }
  return false;
}

function owningVisualComposition(ir: CutAVIR, node: IRNode) {
  if (node.sceneId) {
    const direct = ir.compositions.find((composition) => composition.sceneIds.includes(node.sceneId!));
    if (direct) return direct;
  }
  return ir.compositions.find((composition) => compositionContainsNode(ir, composition, node.id));
}

function owningAudioComposition(ir: CutAVIR, node: IRNode) {
  if (node.sceneId) {
    const direct = ir.compositions.find((composition) => composition.sceneIds.includes(node.sceneId!));
    if (direct) return direct;
  }
  return ir.compositions.find((composition) => compositionContainsNode(ir, composition, node.id));
}

const audioNoOpControllerOps = new Set([
  "cut.audio.gain",
  "cut.audio.send",
  "cut.audio.pan",
  "cut.audio.eq",
  "cut.audio.highpass",
  "cut.audio.lowpass",
  "cut.audio.compressor",
  "cut.audio.deesser",
  "cut.audio.reverb",
  "cut.audio.delay",
  "cut.audio.limiter",
  "cut.audio.sidechain",
]);

/**
 * No-op proof is deliberately downstream of the owning audio automation
 * contract. If a signal is malformed, off-grid, out of range, unsupported, or
 * over budget, decline the inactivity proof so the normal session pass emits
 * its stable audio diagnostic. Valid signals still receive the strict inert-
 * control closure below.
 */
function audioAutomationIsValidForNoOpProof(ir: CutAVIR | undefined, node: IRNode) {
  if (!audioNoOpControllerOps.has(node.op)) return true;
  if (!Object.keys(node.properties).length) return true;
  if (!ir) return false;
  const composition = owningAudioComposition(ir, node);
  if (!composition) return false;
  try {
    if (node.op === "cut.audio.eq") compileReferenceParametricEqAutomations(ir, composition, node);
    else if (node.op === "cut.audio.compressor") compileReferenceCompressorAutomations(ir, composition, node);
    else if (node.op === "cut.audio.deesser") compileReferenceDeEsserAutomations(ir, composition, node);
    else if (node.op === "cut.audio.limiter") compileReferenceLimiterAutomations(ir, composition, node);
    else if (node.op === "cut.audio.sidechain") compileReferenceSidechainAutomations(ir, composition, node);
    else if (node.op === "cut.audio.delay") compileReferenceAudioAutomation(ir, composition, node, "wet");
    else if (node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") compileReferenceStateVariableFilterAutomations(ir, composition, node);
    else compileReferenceAudioAutomation(ir, composition, node);
    return true;
  } catch (error) {
    if (error instanceof ReferenceAudioAutomationError || error instanceof ReferenceAudioConfigError) return false;
    throw error;
  }
}

/**
 * Conservative whole-interval proof for controller properties. Audio
 * automation currently lowers only track signals. Invalid, missing or future
 * signal forms return false so their owning validator retains diagnostic
 * precedence. An interpolation can stay at one inactive value only when both
 * endpoints are that value.
 */
function controllerIsProvablyInactive(
  ir: CutAVIR | undefined,
  node: IRNode,
  property: ReferenceAudioAutomationProperty,
  fallback: IRValue | undefined,
  inactive: (value: IRValue | undefined) => boolean,
) {
  const propertyValue = node.properties[property];
  if (propertyValue === undefined) return inactive(fallback);
  if (!("signal" in propertyValue)) return inactive(propertyValue);
  const signal = ir?.signals[propertyValue.signal];
  if (!signal || signal.kind !== "track" || !validTrackEventTime(node, signal)) return false;
  const initial = signal.initial.kind === "null"
    ? referenceAudioAutomationDefaultValue(node, property)
    : signal.initial;
  const intervalEnd = addRational(node.interval.start, node.interval.duration);
  const segments: Array<{ start: Rational; inactive: boolean }> = [
    { start: node.interval.start, inactive: inactive(initial) },
  ];
  for (const event of signal.events) {
    const start = event.kind === "set" ? event.time : event.start;
    // Match the public audio automation evaluator: an authored write replaces
    // every tail segment beginning at the same or a later exact time. This is
    // especially important for a sample-zero set that replaces an active
    // constructor/default value for the whole node interval.
    while (segments.length && compareRational(segments[segments.length - 1].start, start) >= 0) segments.pop();
    if (event.kind === "set") {
      segments.push({ start, inactive: inactive(event.value) });
      continue;
    }
    segments.push({ start, inactive: inactive(event.from) && inactive(event.to) });
    if (compareRational(event.end, intervalEnd) < 0) {
      segments.push({ start: event.end, inactive: inactive(event.to) });
    }
  }
  return segments.length > 0 && segments.every((segment) => segment.inactive);
}

function defaultQuantity(
  dimension: "gain" | "ratio" | "scalar",
  unit: "db" | "ratio" | "scalar",
  numerator: number,
  denominator = 1,
): IRValue {
  return { kind: "quantity", dimension, unit, magnitude: rational(numerator, denominator) };
}

function exactPoint(value: IRValue | undefined) {
  if (value?.kind !== "object" || Object.keys(value.entries).length !== 2) return undefined;
  const x = value.entries.x, y = value.entries.y;
  if (x?.kind !== "quantity" || x.dimension !== "length" || x.unit !== "px") return undefined;
  if (y?.kind !== "quantity" || y.dimension !== "length" || y.unit !== "px") return undefined;
  try {
    // Force malformed rationals through the existing geometry validator rather
    // than masking them as a no-op diagnostic.
    compareRational(x.magnitude, zeroRational);
    compareRational(y.magnitude, zeroRational);
  } catch { return undefined; }
  return { x: x.magnitude, y: y.magnitude };
}

function validateTrace(node: IRNode) {
  if (node.op !== "cut.visual.trace") return;
  const arrow = node.inputs.arrow;
  if (arrow?.kind === "object") {
    const color = arrow.entries.color;
    if (fullyTransparentColor(color)) fail(node, "Trace arrow.color cannot be fully transparent; omit arrow to disable the tangent-oriented endpoint marker");
  }
  const radius = node.inputs.headRadius;
  if (radius === undefined) {
    if (node.inputs.headColor !== undefined || node.inputs.headFade !== undefined) {
      fail(node, "Trace headColor/headFade requires an explicitly authored positive headRadius");
    }
  } else {
    const comparison = exactLengthMagnitude(radius);
    if (comparison === 0) {
      fail(node, "Trace headRadius must be positive when authored; omit it to disable the endpoint head");
    }
    if (comparison !== undefined && comparison > 0 && fullyTransparentColor(node.inputs.headColor)) {
      fail(node, "Trace headColor cannot be fully transparent when a positive endpoint head is authored; omit the endpoint head controls to disable it");
    }
  }

  const points = node.inputs.points;
  if (points?.kind !== "array" || points.items.length < 2 || points.items.length > 4_096) return;
  const decoded = points.items.map(exactPoint);
  if (decoded.some((point) => point === undefined)) return;
  const first = decoded[0]!;
  const hasLength = decoded.slice(1).some((point) => point !== undefined && (
    compareRational(point.x, first.x) !== 0 || compareRational(point.y, first.y) !== 0
  ));
  if (!hasLength) fail(node, "Trace points must describe a positive-length path; easing and reveal controls cannot execute on coincident points");
}

function validateVisualEffectNoOps(node: IRNode) {
  if (node.op === "cut.visual.blur") {
    if (exactLengthMagnitude(node.inputs.radius) === 0) {
      fail(node, "Blur radius is zero for the whole node interval; remove the identity wrapper");
    }
    return;
  }

  if (node.op === "cut.visual.shadow") {
    if (fullyTransparentColor(node.inputs.color)) {
      fail(node, "Shadow color cannot be fully transparent because its color channels cannot affect output");
    }
    if (exactRatioMagnitude(node.inputs.opacity) === 0) {
      failInertControls(node, "Shadow opacity is zero for the whole node interval", explicitControls(node, ["x", "y", "radius", "color"]));
    }
    return;
  }

  if (node.op === "cut.visual.glow") {
    if (fullyTransparentColor(node.inputs.color)) {
      fail(node, "Glow color cannot be fully transparent because its color channels cannot affect output");
    }
    if (exactRatioMagnitude(node.inputs.opacity) === 0) {
      failInertControls(node, "Glow opacity is zero for the whole node interval", explicitControls(node, ["radius", "color"]));
    }
    return;
  }

  if (node.op === "cut.visual.vignette") {
    if (fullyTransparentColor(node.inputs.color)) {
      fail(node, "Vignette color cannot be fully transparent because its color channels cannot affect output");
    }
    if (exactRatioMagnitude(node.inputs.amount) === 0) {
      failInertControls(node, "Vignette amount is zero for the whole node interval", explicitControls(node, ["radius", "softness", "color"]));
    }
    if (exactQuantityEquals(node.inputs.radius, "ratio", "ratio", 1)) {
      failInertControls(node, "Vignette radius is 100%, so no finite pixel center reaches the vignette", explicitControls(node, ["amount", "softness", "color"]));
    }
    return;
  }

  if (node.op === "cut.visual.sharpen") {
    if (exactRatioMagnitude(node.inputs.amount) === 0) {
      failInertControls(node, "Sharpen amount is zero for the whole node interval", explicitControls(node, ["radius"]));
    }
    if (exactLengthMagnitude(node.inputs.radius) === 0) {
      failInertControls(node, "Sharpen radius is zero for the whole node interval", explicitControls(node, ["amount"]));
    }
    return;
  }

  if (node.op === "cut.visual.grain" && exactRatioMagnitude(node.inputs.amount) === 0) {
    failInertControls(node, "Grain amount is zero for the whole node interval", explicitControls(node, ["size", "seed", "mode", "monochrome"]));
    return;
  }

  if (node.op === "cut.visual.duotone" && exactRatioMagnitude(node.inputs.amount) === 0) {
    failInertControls(node, "Duotone amount is zero for the whole node interval", explicitControls(node, ["shadows", "highlights"]));
  }
}

function validateGeoNoOps(node: IRNode, ir?: CutAVIR) {
  if (node.op === "cut.geo.globe" && node.inputs.points === undefined && node.inputs.stations === undefined) {
    failInertControls(
      node,
      "Globe has no points or stations to reveal or mark",
      explicitControls(node, ["markerRadius", "reveal"]),
    );
    return;
  }
  if (node.op === "cut.geo.map" && node.inputs.points === undefined) {
    const retainedOwner = ir && Object.values(ir.nodes).find((candidate) => candidate.op === "cut.geo.map_camera" && candidate.children.includes(node.id));
    if (retainedOwner) return;
    failInertControls(node, "Map has no points to reveal or signal", explicitControls(node, ["signal", "reveal"]));
    return;
  }
  if (node.op !== "cut.geo.marker") return;
  const point = node.inputs.point;
  const embeddedLabel = point?.kind === "object" ? point.entries.label : undefined;
  if (embeddedLabel?.kind === "string" && node.inputs.label?.kind === "string") {
    fail(node, "Marker label is authored both in point.label and as label; the separate label would silently override point.label");
  }
}

function validateTextNoOps(node: IRNode) {
  if (node.op !== "cut.visual.text") return;
  const content = node.inputs.content;
  if (content?.kind === "string" && content.value.trim().length === 0) {
    fail(node, "Text content must contain a visible non-whitespace character");
  }
  const names = ["shadowColor", "shadowOpacity", "shadowBlur"] as const;
  if (!names.every((name) => node.inputs[name] !== undefined)) return;
  if (exactRatioMagnitude(node.inputs.shadowOpacity) === 0) {
    fail(node, "Text shadowOpacity must be positive when a shadow is authored; omit the shadow inputs to disable it");
  }
  const color = node.inputs.shadowColor;
  if (color?.kind === "color" && /^#[0-9a-f]{8}$/.test(color.value) && color.value.endsWith("00")) {
    fail(node, "Text shadowColor cannot be fully transparent when a shadow is authored; omit the shadow inputs to disable it");
  }
}

function validateTransparentMainPaint(node: IRNode) {
  if (node.op === "cut.visual.text" && fullyTransparentColor(node.inputs.color)) {
    fail(node, "Text color cannot be fully transparent because the glyph alpha also supplies the authored shadow's source alpha");
  }

  if (node.op === "cut.visual.rect") {
    const from = node.inputs.gradientFrom, to = node.inputs.gradientTo;
    if (from?.kind === "color" && to?.kind === "color" && from.value === to.value) {
      fail(node, `Rect gradientFrom and gradientTo are both ${from.value}; use fill for the same executable solid paint`);
    }
    if (from === undefined && to === undefined && fullyTransparentColor(node.inputs.fill)) {
      fail(node, "Rect fill cannot be fully transparent when no independently visible gradient paint is authored");
    }
    if (from !== undefined && to !== undefined && fullyTransparentColor(from) && fullyTransparentColor(to)) {
      fail(node, "Rect gradient endpoints cannot both be fully transparent because the complete main paint is invisible");
    }
  }

  if (node.op === "cut.visual.circle" && fullyTransparentColor(node.inputs.fill)) {
    fail(node, "Circle fill cannot be fully transparent because the node has no independently visible paint");
  }

  if (node.op === "cut.visual.path" && node.inputs.points !== undefined && fullyTransparentColor(node.inputs.stroke)) {
    fail(node, "Path stroke cannot be fully transparent because the node has no independently visible paint");
  }

  if (node.op === "cut.visual.trace" && fullyTransparentColor(node.inputs.stroke)) {
    const radius = exactLengthMagnitude(node.inputs.headRadius);
    const headPaint = node.inputs.headColor ?? node.inputs.stroke;
    if (!(radius !== undefined && radius > 0 && headPaint?.kind === "color" && !fullyTransparentColor(headPaint))) {
      fail(node, "Trace stroke cannot be fully transparent without an independently visible positive-radius endpoint head");
    }
  }
}

function validateMotionPathNoOps(node: IRNode) {
  if (node.op !== "cut.visual.motion_path" || node.inputs.closed?.kind !== "boolean" || !node.inputs.closed.value) return;
  const points = node.inputs.points;
  if (points?.kind !== "array" || points.items.length < 2 || points.items.length > 1_024) return;
  const first = exactPoint(points.items[0]), terminal = exactPoint(points.items.at(-1));
  if (first && terminal
    && compareRational(first.x, terminal.x) === 0
    && compareRational(first.y, terminal.y) === 0) {
    fail(node, "closed MotionPath must omit a terminal point equal to its first point because closed: true already materializes that exact closing edge");
  }
}

function validateColorConvertNoOp(node: IRNode) {
  if (node.op !== "cut.visual.color_convert") return;
  const from = node.inputs.from, to = node.inputs.to;
  if (from?.kind === "string" && to?.kind === "string" && from.value === to.value) {
    fail(node, `ColorConvert from and to are both “${from.value}”; an identity color conversion cannot affect pixels`);
  }
}

function validateAudioNoOps(ir: CutAVIR | undefined, node: IRNode) {
  if (
    node.op === "cut.audio.channel_matrix"
    && exactQuantityEquals(node.inputs.leftToLeft, "scalar", "scalar", 1)
    && exactQuantityEquals(node.inputs.leftToRight, "scalar", "scalar", 0)
    && exactQuantityEquals(node.inputs.rightToLeft, "scalar", "scalar", 0)
    && exactQuantityEquals(node.inputs.rightToRight, "scalar", "scalar", 1)
  ) {
    fail(node, "ChannelMatrix is the exact stereo identity; remove the inert processor");
  }
  if (node.op === "cut.audio.delay" && exactScalarInteger(node.inputs.repeats) === 1 && node.inputs.decay !== undefined) {
    fail(node, "Delay decay cannot affect a single-tap delay; omit decay or author at least two repeats");
  }

  if (node.op === "cut.audio.tone" && exactRatioMagnitude(node.inputs.amplitude) === 0) {
    fail(node, "Tone amplitude must be positive; use AudioGap for intentional silence because frequency and fades cannot execute at zero amplitude");
  }
  if (node.op === "cut.audio.noise" && exactRatioMagnitude(node.inputs.amplitude) === 0) {
    fail(node, "Noise amplitude must be positive; use AudioGap for intentional silence because color, seed, and fades cannot execute at zero amplitude");
  }

  if (node.op === "cut.audio.synth") {
    const sustain = node.inputs.sustain ?? { kind: "quantity", dimension: "ratio", magnitude: rational(1), unit: "ratio" } satisfies IRValue;
    if (exactQuantityEquals(sustain, "ratio", "ratio", 1) && exactQuantityIsPositive(node.inputs.decay, "time", "s")) {
      fail(node, "Synth decay cannot affect the envelope while sustain is 100%; omit decay or lower sustain");
    }
    if (exactQuantityEquals(sustain, "ratio", "ratio", 0) && exactQuantityIsPositive(node.inputs.release, "time", "s")) {
      fail(node, "Synth release cannot affect the rendered envelope while sustain is 0%; omit release or raise sustain");
    }
  }

  if (!audioAutomationIsValidForNoOpProof(ir, node)) return;

  for (const [property, authored] of Object.entries(node.properties)) {
    if (!("signal" in authored)) continue;
    const signal = ir?.signals[authored.signal];
    if (signal) validateCanonicalEqualTrackAnimations(node, property, signal);
  }

  if (node.op === "cut.audio.eq") {
    const fallback = node.inputs.gain ?? defaultQuantity("gain", "db", 0);
    if (controllerIsProvablyInactive(ir, node, "gain", fallback, (value) => exactQuantityEquals(value, "gain", "db", 0))) {
      failInertControls(
        node,
        "ParametricEQ gain is 0 dB for the whole node interval",
        explicitControls(node, ["frequency", "q"]),
      );
    }
  }

  if (node.op === "cut.audio.compressor") {
    const fallback = node.inputs.ratio ?? defaultQuantity("scalar", "scalar", 3);
    if (controllerIsProvablyInactive(ir, node, "ratio", fallback, (value) => exactQuantityEquals(value, "scalar", "scalar", 1))) {
      failInertControls(
        node,
        "Compressor ratio is 1:1 for the whole node interval",
        explicitControls(node, ["threshold", "attack", "release"]),
      );
    }
  }

  if (node.op === "cut.audio.deesser") {
    const intensityFallback = node.inputs.intensity ?? defaultQuantity("scalar", "scalar", 35, 100);
    const amountFallback = node.inputs.amount ?? defaultQuantity("scalar", "scalar", 1, 2);
    const scalarZero = (value: IRValue | undefined) => exactQuantityEquals(value, "scalar", "scalar", 0);
    if (controllerIsProvablyInactive(ir, node, "intensity", intensityFallback, scalarZero)) {
      failInertControls(
        node,
        "DeEsser intensity is zero for the whole node interval",
        explicitControls(node, ["amount"]),
      );
    }
    if (controllerIsProvablyInactive(ir, node, "amount", amountFallback, scalarZero)) {
      failInertControls(
        node,
        "DeEsser amount is zero for the whole node interval",
        explicitControls(node, ["intensity"]),
      );
    }
  }

  if (node.op === "cut.audio.delay") {
    const fallback = node.inputs.wet ?? defaultQuantity("ratio", "ratio", 25, 100);
    if (controllerIsProvablyInactive(ir, node, "wet", fallback, (value) => exactQuantityEquals(value, "ratio", "ratio", 0))) {
      failInertControls(
        node,
        "Delay wet is 0% for the whole node interval",
        explicitControls(node, ["time", "repeats", "decay"]),
      );
    }
  }

  if (node.op === "cut.audio.sidechain") {
    if (controllerIsProvablyInactive(ir, node, "amount", node.inputs.amount, (value) => exactQuantityEquals(value, "gain", "db", 0))) {
      failInertControls(
        node,
        "Sidechain amount is 0 dB for the whole node interval",
        explicitControls(node, ["source", "threshold", "attack", "release"], ["threshold", "attack", "release"]),
      );
    }
  }

  if (
    node.op === "cut.audio.time_stretch"
    && exactQuantitiesEqual(node.inputs.sourceDuration, node.inputs.duration, "time", "s")
    && exactQuantityEquals(node.inputs.pitch ?? defaultQuantity("scalar", "scalar", 0), "scalar", "scalar", 0)
  ) {
    failInertControls(
      node,
      "TimeStretch has identity duration and pitch, so quality cannot select an executable algorithm",
      explicitControls(node, ["quality"]),
    );
  }
}

function visualPropertyDefault(node: IRNode, property: string): IRValue | undefined {
  if (node.op === cutMediaCamera2DOp) {
    const mediaCameraDefault = cutMediaCamera2DDefaultIRValue(property);
    if (mediaCameraDefault) return mediaCameraDefault;
  }
  if (property === "x" || property === "y" || property === "anchorX" || property === "anchorY") {
    return { kind: "quantity", dimension: "length", unit: "px", magnitude: zeroRational };
  }
  if (property === "rotation" || property === "skewX" || property === "skewY" || property === "hue") {
    return { kind: "quantity", dimension: "angle", unit: "deg", magnitude: zeroRational };
  }
  if (property === "scale" || property === "brightness" || property === "saturation" || property === "contrast") {
    return { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(1) };
  }
  if (property === "exposure" || property === "temperature" || property === "tint") {
    return { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: zeroRational };
  }
  if (property === "opacity" || property === "reveal" || property === "strength") {
    return { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(1) };
  }
  if (property === "progress") {
    return { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: zeroRational };
  }
  return undefined;
}

function signalFreeVisualPropertyValue(node: IRNode, property: string) {
  const schema = referenceKernelSchema(node.op);
  if (schema?.support === "supported" && !kernelPropertyInputIsIntrinsic(schema, property)) {
    const input = node.inputs[property];
    if (input !== undefined) return input;
  }
  return visualPropertyDefault(node, property);
}

function validateCanonicalEqualTrackAnimations(node: IRNode, property: string, signal: IRSignal) {
  if (signal.kind !== "track") return;
  for (const [eventIndex, event] of signal.events.entries()) {
    if (event.kind === "animate" && canonicalIrValuesEqual(event.from, event.to)) {
      fail(node, `${node.domain === "audio" ? "audio" : "visual"} property “${property}” signal ${signal.id}.events[${eventIndex}] has canonically equal animation endpoints and cannot change output`);
    }
  }
}

function activeAt(node: IRNode, time: Rational) {
  return compareRational(time, node.interval.start) >= 0
    && compareRational(time, addRational(node.interval.start, node.interval.duration)) < 0;
}

function rationalKey(value: Rational) {
  return `${value.numerator}/${value.denominator}`;
}

/**
 * Enumerate the exact times at which the reference renderer can evaluate one
 * visual node. Ordinary ancestors preserve scene-local output time. A
 * MotionBlur ancestor expands that time through the same validated boundary
 * planner used by rendering, including start-hold remapping and nested
 * shutters. Precomp/NestedSequence are separate execution domains and never
 * leak their private source clock into this composition proof.
 *
 * Traversal is restricted to structural root-to-target paths and memoized by
 * node/time within each output frame, matching `ReferenceVisualRenderer`'s
 * frame memo. Malformed graphs and unsupported cross-domain paths fail open so
 * their owning validators keep diagnostic precedence. Closed work overflow is
 * itself refused: accepting the property without completing its executability
 * proof would reintroduce a silent no-op path.
 */
function sampledVisualExecutionTimes(ir: CutAVIR, node: IRNode, composition: IRComposition) {
  const frameDuration = divideRational(rational(1), composition.fps);
  const result = new Map<string, Rational>();
  const reachability = new Map<string, boolean>();
  const reachabilityVisiting = new Set<string>();
  const motionConfigs = new Map<string, ReturnType<typeof prepareReferenceMotionBlurBoundary>>();
  let work = 0n;

  const charge = (amount = 1n) => {
    work += amount;
    if (work > maximumVisualSignalNoOpProofWork) throw new VisualSignalNoOpProofBudgetError();
  };
  const canReach = (nodeId: string): boolean => {
    if (nodeId === node.id) return true;
    const cached = reachability.get(nodeId);
    if (cached !== undefined) return cached;
    if (reachabilityVisiting.has(nodeId)) throw new Error("CUT_NOOP_PROOF_CYCLE");
    const candidate = ir.nodes[nodeId];
    if (!candidate || candidate.op === "cut.visual.precomp" || candidate.op === "cut.edit.nested_sequence") {
      reachability.set(nodeId, false);
      return false;
    }
    reachabilityVisiting.add(nodeId);
    const reachable = candidate.children.some((childId) => canReach(childId));
    reachabilityVisiting.delete(nodeId);
    reachability.set(nodeId, reachable);
    return reachable;
  };
  const boundaryConfig = (wrapper: IRNode) => {
    const cached = motionConfigs.get(wrapper.id);
    if (cached) return cached;
    const child = ir.nodes[wrapper.children[0]!];
    const motion = referenceMotionBlurConfig(wrapper);
    if (!child || !motion) throw new Error("CUT_NOOP_PROOF_MOTION_GRAPH");
    const prepared = prepareReferenceMotionBlurBoundary(wrapper, child, frameDuration, motion);
    motionConfigs.set(wrapper.id, prepared);
    return prepared;
  };
  const visit = (nodeId: string, time: Rational, visited: Set<string>) => {
    if (!canReach(nodeId)) return;
    const visitKey = `${nodeId}\u0000${rationalKey(time)}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    charge();
    const current = ir.nodes[nodeId];
    if (!current || !activeAt(current, time)) return;
    if (current.id === node.id) {
      result.set(rationalKey(time), Object.freeze({ ...time }));
      return;
    }
    if (current.op === "cut.visual.motion_blur") {
      const child = ir.nodes[current.children[0]!];
      if (!child) throw new Error("CUT_NOOP_PROOF_MOTION_CHILD");
      const boundary = createReferenceMotionBlurBoundaryPlan(current, child, time, boundaryConfig(current));
      for (const sample of boundary.samples) {
        if (sample.sourceTime !== null) visit(child.id, sample.sourceTime, visited);
      }
      return;
    }
    if (current.op === "cut.visual.precomp" || current.op === "cut.edit.nested_sequence") return;
    for (const childId of current.children) visit(childId, time, visited);
  };
  const executeGrid = (duration: Rational, roots: readonly string[]) => {
    if (!roots.some((root) => canReach(root))) return;
    const frames = multiplyRational(duration, composition.fps);
    if (frames.denominator !== "1") throw new Error("CUT_NOOP_PROOF_FRAME_GRID");
    const frameCount = BigInt(frames.numerator);
    if (frameCount < 0n) throw new Error("CUT_NOOP_PROOF_FRAME_GRID");
    charge(frameCount);
    for (let frame = 0n; frame < frameCount; frame += 1n) {
      const time = divideRational(rational(frame), composition.fps);
      const visited = new Set<string>();
      for (const root of roots) visit(root, time, visited);
    }
  };

  try {
    let reachedFromScene = false;
    for (const sceneId of composition.sceneIds) {
      const scene = ir.scenes[sceneId];
      if (!scene || (node.sceneId !== undefined && node.sceneId !== scene.id)) continue;
      const roots = scene.items
        .filter((item) => item.domain === "visual" || item.domain === "av")
        .map((item) => item.id);
      if (!roots.some((root) => canReach(root))) continue;
      reachedFromScene = true;
      executeGrid(scene.duration, roots);
    }
    if (!reachedFromScene) {
      const roots = [...composition.rootVisualIds, ...composition.rootAVIds];
      executeGrid(composition.duration, roots);
    }
    return [...result.values()].sort(compareRational);
  } catch (error) {
    if (error instanceof VisualSignalNoOpProofBudgetError) {
      fail(
        node,
        `visual signal exact execution/no-op proof requires more than ${maximumVisualSignalNoOpProofWork} bounded graph visits; reduce scene duration, nested temporal amplification, or visual path depth`,
      );
    }
    return undefined;
  }
}

function effectiveSignalValue(value: IRValue, nullSignalFallback: IRValue | undefined) {
  return value.kind === "null" ? nullSignalFallback : value;
}

export function referenceSignalWithItemRemoved(signal: IRSignal, index: number): IRSignal | undefined {
  if (signal.kind === "track") return { ...signal, events: signal.events.filter((_event, candidate) => candidate !== index) };
  if (signal.kind === "step") return { ...signal, points: signal.points.filter((_point, candidate) => candidate !== index) };
  if (signal.kind === "keyframes") return { ...signal, keyframes: signal.keyframes.filter((_point, candidate) => candidate !== index) };
  return undefined;
}

export function referenceSignalItemCount(signal: IRSignal) {
  if (signal.kind === "track") return signal.events.length;
  if (signal.kind === "step") return signal.points.length;
  if (signal.kind === "keyframes") return signal.keyframes.length;
  return 0;
}

/** Compare exact typed signal values on the owning composition's complete
 * visual execution grid, including temporal-exposure samples introduced by
 * MotionBlur ancestors. Pixel-grid quantization and content-dependent equality
 * still belong to the owning runtime. */
function validateVisualSignalNoOps(ir: CutAVIR | undefined, node: IRNode, property: string, signal: IRSignal) {
  if (!ir || (node.domain !== "visual" && node.domain !== "av")) return;
  const composition = owningVisualComposition(ir, node);
  if (!composition) return;
  const times = sampledVisualExecutionTimes(ir, node, composition);
  if (!times) return;
  const signalFreeFallback = signalFreeVisualPropertyValue(node, property);
  // A present property signal whose current value is null uses the property's
  // public runtime default, not a conflicting same-named constructor input.
  // Normal lowering copies an explicit constructor baseline into track.initial.
  // Loaded IR can contain a hostile null initial even though public lowering
  // normally captures a same-named constructor baseline. Specialized kernels
  // do not yet share one null policy (some use their input, some a property
  // default, and some reject null), so only apply a fallback for the closed
  // contracts whose runtime semantics are known here. Unknown nulls make the
  // counterfactual inconclusive and therefore fail open rather than producing
  // a false no-op diagnostic.
  const nullSignalFallback = node.op === cutMediaCamera2DOp || node.op === "cut.visual.group"
    ? visualPropertyDefault(node, property)
    : undefined;
  try {
    const itemCount = referenceSignalItemCount(signal);
    const counterfactualWork = BigInt(times.length) * BigInt(itemCount + 1);
    if (counterfactualWork > maximumVisualSignalNoOpProofWork) {
      fail(
        node,
        `visual property “${property}” signal ${signal.id} exact counterfactual proof requires ${counterfactualWork} comparisons and exceeds the closed ${maximumVisualSignalNoOpProofWork}-comparison limit`,
      );
    }
    // The authored value is invariant across every remove-one-item
    // counterfactual. Evaluate it exactly once per admitted execution sample.
    // More importantly, construct each immutable counterfactual IR once per
    // item—not once per sample. The previous sample-local object spread copied
    // the complete signal table millions of times in long-form programmes even
    // though neither the candidate signal nor the surrounding IR changed.
    const authoredValues = times.map((time) =>
      effectiveSignalValue(evaluateSignal(ir, signal.id, time), nullSignalFallback));
    for (let index = 0; index < itemCount; index += 1) {
      const counterfactual = referenceSignalWithItemRemoved(signal, index);
      if (!counterfactual) continue;
      const counterfactualIr: CutAVIR = {
        ...ir,
        signals: { ...ir.signals, [signal.id]: counterfactual },
      };
      const invisible = times.every((time, sampleIndex) => {
        const authored = authoredValues[sampleIndex];
        const removed = effectiveSignalValue(
          evaluateSignal(counterfactualIr, signal.id, time),
          nullSignalFallback,
        );
        return authored !== undefined && removed !== undefined && canonicalIrValuesEqual(authored, removed);
      });
      if (invisible) {
        const kind = signal.kind === "track" ? signal.events[index]!.kind : signal.kind === "step" ? "point" : "keyframe";
        const path = signal.kind === "track" ? `events[${index}]` : signal.kind === "step" ? `points[${index}]` : `keyframes[${index}]`;
        fail(node, `visual property “${property}” signal ${signal.id}.${path} ${kind} never changes an exact output-frame sample or temporal-exposure sample relative to the same signal with that item removed`);
      }
    }

    if (signalFreeFallback && authoredValues.every((value) => {
      return value !== undefined && canonicalIrValuesEqual(value, signalFreeFallback);
    })) {
      fail(node, `visual property “${property}” signal ${signal.id} never differs from its signal-free input/default on any output-frame sample or temporal-exposure sample in its reachable half-open execution interval`);
    }
  } catch (error) {
    if (error instanceof ReferenceNoOpContractError) throw error;
    // Malformed/effectful signals retain their ordinary validator/runtime
    // diagnostic. This bounded proof must never manufacture a false no-op.
  }
}

function validatePropertySignalValue(node: IRNode, property: string, label: string, value: IRValue) {
  if (value.kind === "null") fail(node, `property “${property}” ${label} is null and would silently fall back to an authored input or runtime default`);
}

function validateVisualPropertyTrackTiming(node: IRNode, property: string, signal: IRSignal) {
  if ((node.domain !== "visual" && node.domain !== "av") || signal.kind !== "track") return;
  const intervalEnd = addRational(node.interval.start, node.interval.duration);
  for (const [index, event] of signal.events.entries()) {
    const start = event.kind === "set" ? event.time : event.start;
    if (compareRational(start, node.interval.start) < 0 || compareRational(start, intervalEnd) >= 0) {
      fail(node, `visual property “${property}” signal ${signal.id}.events[${index}] ${event.kind} start lies outside its half-open owning node interval`);
    }
    if (event.kind === "animate" && compareRational(event.end, intervalEnd) > 0) {
      fail(node, `visual property “${property}” signal ${signal.id}.events[${index}] animate end lies outside its owning node interval`);
    }
  }
}

function validatePropertySignal(ir: CutAVIR | undefined, node: IRNode, property: string, signal: IRSignal) {
  const label = `signal ${signal.id}`;
  if (signal.kind === "constant") {
    validatePropertySignalValue(node, property, `${label}.value`, signal.value);
  } else if (signal.kind === "step") {
    if (!signal.points.length) fail(node, `property “${property}” ${label} has no step points and would always resolve to null`);
    signal.points.forEach((point, index) => validatePropertySignalValue(node, property, `${label}.points[${index}].value`, point.value));
  } else if (signal.kind === "keyframes") {
    if (!signal.keyframes.length) fail(node, `property “${property}” ${label} has no keyframes and would always resolve to null`);
    signal.keyframes.forEach((keyframe, index) => validatePropertySignalValue(node, property, `${label}.keyframes[${index}].value`, keyframe.value));
  } else {
    if (signal.initial.kind === "null" && !signal.events.length) {
      fail(node, `property “${property}” ${label} has neither an initial value nor an event and would always resolve to null`);
    }
    if (signal.initial.kind !== "null") validatePropertySignalValue(node, property, `${label}.initial`, signal.initial);
    signal.events.forEach((event, index) => {
      if (event.kind === "set") validatePropertySignalValue(node, property, `${label}.events[${index}].value`, event.value);
      else {
        validatePropertySignalValue(node, property, `${label}.events[${index}].from`, event.from);
        validatePropertySignalValue(node, property, `${label}.events[${index}].to`, event.to);
      }
    });
    validateVisualPropertyTrackTiming(node, property, signal);
  }
  // Audio owns easing, grid, range, and work diagnostics before downstream
  // no-op proof. validateAudioNoOps invokes the equal-endpoint closure only
  // after that owning automation contract succeeds; repeating it here would
  // incorrectly replace a malformed audio-automation diagnostic with CUT2085.
  if (node.domain !== "audio") validateCanonicalEqualTrackAnimations(node, property, signal);
  validateVisualSignalNoOps(ir, node, property, signal);
}

function validatePropertyNoOps(ir: CutAVIR | undefined, node: IRNode) {
  for (const [property, value] of Object.entries(node.properties)) {
    if (!("signal" in value)) {
      validatePropertySignalValue(node, property, "value", value);
      continue;
    }
    const signal = ir?.signals[value.signal];
    // The registry/IR validator owns a missing-reference diagnostic. This
    // contract closes only references whose valid shape resolves to no value.
    if (signal) {
      const schema = referenceKernelSchema(node.op);
      if (
        signal.kind === "track"
        && signal.initial.kind === "null"
        && (node.domain === "visual" || node.domain === "av")
        && schema?.support === "supported"
        && !kernelPropertyInputIsIntrinsic(schema, property)
        && Object.hasOwn(node.inputs, property)
      ) {
        fail(
          node,
          `visual property “${property}” signal ${signal.id}.initial is null even though the same-named constructor input exists; canonical lowering must capture that input as the track baseline`,
        );
      }
      validatePropertySignal(ir, node, property, signal);
    }
  }
}

/**
 * Close graph-dependent no-op combinations after lowering. The compiler and
 * reference runtime call this same function, so loaded IR cannot bypass the
 * public source contract.
 */
export function validateReferenceNoOpContract(node: IRNode, ir?: CutAVIR) {
  const schema = referenceKernelSchema(node.op);
  if (schema?.support === "supported") {
    const count = node.children.length;
    if (count < schema.minimumChildren || (schema.maximumChildren !== undefined && count > schema.maximumChildren)) {
      const domain = schema.children === "any" || schema.children === "none" ? "direct" : schema.children;
      if (node.op === "cut.visual.mask") {
        fail(node, `cut.visual.mask requires exactly two visual children: target, then matte; found ${count}`);
      }
      if (schema.minimumChildren === 1 && schema.maximumChildren === 1) {
        fail(node, `${node.op} requires exactly one ${domain} child; found ${count}`);
      }
      if (schema.minimumChildren === 2 && schema.maximumChildren === 2) {
        fail(node, `${node.op} requires exactly two ${domain} children; found ${count}`);
      }
      if (schema.minimumChildren === 1 && schema.maximumChildren === undefined) {
        fail(node, `${node.op} requires at least one ${domain} child; found ${count}`);
      }
      const expected = schema.maximumChildren === undefined
        ? `at least ${schema.minimumChildren}`
        : `${schema.minimumChildren} through ${schema.maximumChildren}`;
      fail(node, `${node.op} requires ${expected} ${domain} children; found ${count}`);
    }
  }

  if (emptyVisualContainers.has(node.op) && node.children.length === 0) {
    const authored = authoredControls(node);
    if (authored.length) {
      fail(node, `${node.op} has no visual children, so authored control(s) ${authored.join(", ")} would not affect output`);
    }
  }

  if (node.op === "cut.visual.composite" && node.children.length < 2 && node.inputs.blend !== undefined) {
    fail(node, "Composite blend requires at least two visual children; one source cannot exercise a blend operation");
  }

  if (node.op === "cut.visual.stack" && node.children.length < 2) {
    const distribution = stringValue(node.inputs.distribution, "center");
    if (node.inputs.gap !== undefined && distribution !== "space-around" && distribution !== "space-evenly") {
      fail(node, "Stack gap requires at least two visual children for this distribution");
    }
    const align = stringValue(node.inputs.align, "center");
    const directionCanPlace = align === "start"
      || align === "end"
      || distribution === "start"
      || distribution === "end"
      || ((distribution === "space-around" || distribution === "space-evenly") && node.inputs.gap !== undefined);
    if (node.inputs.direction !== undefined && !directionCanPlace) {
      fail(node, "Stack direction with one child requires a non-centered align or start/end distribution to affect placement");
    }
    if (node.children.length === 1 && align === "center" && distribution === "center") {
      failInertControls(
        node,
        "A centered one-child Stack places the child's rendered bounds at the canvas center regardless of its symmetric frame or inset",
        explicitControls(node, ["width", "height", "padding", "safeArea"], []),
      );
    }
  }

  validateTrace(node);
  validateTextNoOps(node);
  validateTransparentMainPaint(node);
  validateColorConvertNoOp(node);
  validateMotionPathNoOps(node);
  validateVisualEffectNoOps(node);
  validateGeoNoOps(node, ir);
  validateAudioNoOps(ir, node);
  validatePropertyNoOps(ir, node);
}
