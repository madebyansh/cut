import { boundedDiagnosticString } from "../../core/stable";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  zeroRational,
  type Rational,
} from "../../language/rational";
import type { CutAVIR, IRNode } from "../../language/ir";
import type { RgbaAlphaMode, RgbaSurface } from "./compositing";

export type ReferenceMotionBlurErrorCode =
  | "CUT_MOTION_BLUR_BUDGET"
  | "CUT_MOTION_BLUR_CONFIG"
  | "CUT_MOTION_BLUR_NOOP"
  | "CUT_MOTION_BLUR_PLAN"
  | "CUT_MOTION_BLUR_RATIONAL"
  | "CUT_MOTION_BLUR_SURFACE";

export class ReferenceMotionBlurError extends Error {
  constructor(
    readonly code: ReferenceMotionBlurErrorCode,
    message: string,
    readonly source?: ReferenceMotionBlurSource,
  ) {
    super(source ? `${code}: ${message} at ${source.module}:${source.line}:${source.column}.` : message);
    this.name = "ReferenceMotionBlurError";
  }
}

export type ReferenceMotionBlurSource = Readonly<{
  module: string;
  line: number;
  column: number;
  nodeId: string;
}>;

export type ReferenceMotionBlurConfig = Readonly<{
  /** Exact shutter angle in degrees: greater than zero and at most 360. */
  shutterAngle: Rational;
  /** Uniform midpoint samples across the centered shutter interval. */
  samples: number;
}>;

export type ReferenceMotionBlurSample = Readonly<{
  index: number;
  time: Rational;
  weight: Rational;
}>;

export type ReferenceMotionBlurPlan = Readonly<{
  outputTime: Rational;
  frameDuration: Rational;
  shutterAngle: Rational;
  exposureDuration: Rational;
  samples: readonly ReferenceMotionBlurSample[];
}>;

export type ReferenceMotionBlurNodeConfig = ReferenceMotionBlurConfig & Readonly<{
  nodeId: string;
  /** Omission resolves to transparent; authored transparent is rejected by boundary preflight. */
  startEdge: "transparent" | "hold";
  authoredStartEdge: boolean;
}>;

export type ReferenceMotionBlurLimits = Readonly<{
  maxSamples: number;
  maxPixels: number;
  maxPixelSamples: number;
  maxRationalDigits: number;
}>;

export const defaultReferenceMotionBlurLimits: ReferenceMotionBlurLimits = Object.freeze({
  maxSamples: 32,
  maxPixels: 8_294_400,
  maxPixelSamples: 33_177_600,
  maxRationalDigits: 256,
});

const hardReferenceMotionBlurLimits: ReferenceMotionBlurLimits = Object.freeze({
  maxSamples: 256,
  maxPixels: 33_177_600,
  maxPixelSamples: 134_217_728,
  maxRationalDigits: 4_096,
});

export const referenceMotionBlurCompositionLimits = Object.freeze({
  maxNodes: 32,
  maxAggregatePixelSamples: 67_108_864,
  maxNestedTemporalSamples: 64,
});

// These nodes currently share one forward-only raw-video reader per retained
// node. One MotionBlur visits its exact samples monotonically, but composing
// two shutters produces a depth-first schedule that is not generally monotonic
// (and different exact times can select an uncached earlier discrete frame).
// Refuse that graph before constructing a decoder until CUT owns a bounded
// seek/cache policy that can preserve the exact authored shutter schedule.
const forwardOnlyMediaDecoderOps = new Set([
  "cut.visual.video",
  "cut.edit.clip",
  "cut.edit.picture_clip",
]);

export type ReferenceMotionBlurSurface = {
  data: Uint8Array;
  width: number;
  height: number;
  alphaMode: RgbaAlphaMode;
};

export type ReferenceMotionBlurApplyOptions = Readonly<{
  outputAlphaMode?: RgbaAlphaMode;
  limits?: Partial<ReferenceMotionBlurLimits>;
}>;

const srgbToLinearBytes = Float64Array.from({ length: 256 }, (_, byte) => {
  const encoded = byte / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const clampUnit = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value;
const byte = (value: number) => Math.round(clampUnit(value) * 255);

function fail(code: ReferenceMotionBlurErrorCode, message: string): never {
  throw new ReferenceMotionBlurError(code, message);
}

function nodeSource(node: IRNode): ReferenceMotionBlurSource {
  return {
    module: node.provenance.module,
    line: node.provenance.span.start.line,
    column: node.provenance.span.start.column,
    nodeId: node.id,
  };
}

export function throwReferenceMotionBlurNodeError(node: IRNode, error: unknown): never {
  if (error instanceof ReferenceMotionBlurError && error.source) throw error;
  const code = error instanceof ReferenceMotionBlurError ? error.code : "CUT_MOTION_BLUR_CONFIG";
  const message = error instanceof Error ? error.message : "CUT MotionBlur failed with a non-Error value.";
  throw new ReferenceMotionBlurError(code, message, nodeSource(node));
}

function boundedValue(value: unknown) {
  return typeof value === "string" ? boundedDiagnosticString(value) : `<${value === null ? "null" : typeof value}>`;
}

function closedDataObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) fail("CUT_MOTION_BLUR_CONFIG", `${label} must be a plain data object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("CUT_MOTION_BLUR_CONFIG", `${label} must have a plain or null prototype.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail("CUT_MOTION_BLUR_CONFIG", `${label} cannot contain symbol keys.`);
  const unknown = (ownKeys as string[]).find((key) => !allowed.includes(key));
  if (unknown !== undefined) fail("CUT_MOTION_BLUR_CONFIG", `${label} does not accept property ${boundedValue(unknown)}.`);
  if (ownKeys.length > allowed.length) fail("CUT_MOTION_BLUR_CONFIG", `${label} contains more than ${allowed.length} accepted properties.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) fail("CUT_MOTION_BLUR_CONFIG", `${label} property ${boundedValue(key)} must be enumerable data.`);
    result[key] = descriptor.value;
  }
  return result;
}

function resolveLimits(overrides: Partial<ReferenceMotionBlurLimits> | undefined): ReferenceMotionBlurLimits {
  const allowed = ["maxSamples", "maxPixels", "maxPixelSamples", "maxRationalDigits"] as const;
  const values = overrides === undefined ? {} : closedDataObject(overrides, allowed, "CUT MotionBlur limits");
  const resolved = { ...defaultReferenceMotionBlurLimits, ...values } as ReferenceMotionBlurLimits;
  for (const key of allowed) {
    const value = resolved[key];
    const minimum = key === "maxSamples" ? 2 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > hardReferenceMotionBlurLimits[key]) {
      fail("CUT_MOTION_BLUR_CONFIG", `CUT MotionBlur ${key} must be an integer from ${minimum} through ${hardReferenceMotionBlurLimits[key]}.`);
    }
  }
  return resolved;
}

function canonicalRational(value: unknown, label: string, limits: ReferenceMotionBlurLimits): Rational {
  if (!isRecord(value) || typeof value.numerator !== "string" || typeof value.denominator !== "string") {
    fail("CUT_MOTION_BLUR_RATIONAL", `${label} must be an exact rational with string numerator and denominator.`);
  }
  const numerator = value.numerator;
  const denominator = value.denominator;
  const digits = numerator.startsWith("-") ? numerator.length - 1 : numerator.length;
  if (digits > limits.maxRationalDigits || denominator.length > limits.maxRationalDigits) {
    fail("CUT_MOTION_BLUR_BUDGET", `${label} exceeds maxRationalDigits=${limits.maxRationalDigits}.`);
  }
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(numerator) || numerator === "-0" || !/^[1-9][0-9]*$/u.test(denominator)) {
    fail("CUT_MOTION_BLUR_RATIONAL", `${label} must be a canonical exact rational.`);
  }
  const normalized = rational(numerator, denominator);
  if (normalized.numerator !== numerator || normalized.denominator !== denominator) {
    fail("CUT_MOTION_BLUR_RATIONAL", `${label} must be reduced to canonical form.`);
  }
  return normalized;
}

function checkedIntermediate(value: Rational, label: string, limits: ReferenceMotionBlurLimits): Rational {
  const digits = value.numerator.startsWith("-") ? value.numerator.length - 1 : value.numerator.length;
  if (digits > limits.maxRationalDigits || value.denominator.length > limits.maxRationalDigits) {
    fail("CUT_MOTION_BLUR_BUDGET", `${label} exceeds maxRationalDigits=${limits.maxRationalDigits} during exact scheduling.`);
  }
  return value;
}

function exactAdd(left: Rational, right: Rational, label: string, limits: ReferenceMotionBlurLimits) {
  return checkedIntermediate(addRational(left, right), label, limits);
}

function exactSubtract(left: Rational, right: Rational, label: string, limits: ReferenceMotionBlurLimits) {
  return checkedIntermediate(subtractRational(left, right), label, limits);
}

function exactMultiply(left: Rational, right: Rational, label: string, limits: ReferenceMotionBlurLimits) {
  return checkedIntermediate(multiplyRational(left, right), label, limits);
}

function exactDivide(left: Rational, right: Rational, label: string, limits: ReferenceMotionBlurLimits) {
  return checkedIntermediate(divideRational(left, right), label, limits);
}

function frozenRational(value: Rational): Rational {
  return Object.freeze({ numerator: value.numerator, denominator: value.denominator });
}

/**
 * Build the exact centered-shutter schedule for one unary MotionBlur node.
 *
 * Samples use uniform midpoint integration. For exposure E and N samples,
 * sample i is `outputTime - E/2 + E*(2i+1)/(2N)`. The schedule intentionally
 * does not clamp to a clip/timeline boundary; the unary runtime supplies a
 * transparent sample when the child is inactive at an exact shutter time.
 */
export function createReferenceMotionBlurPlan(
  outputTimeValue: Rational,
  frameDurationValue: Rational,
  configValue: ReferenceMotionBlurConfig,
  options: { limits?: Partial<ReferenceMotionBlurLimits> } = {},
): ReferenceMotionBlurPlan {
  const optionValues = closedDataObject(options, ["limits"], "CUT MotionBlur plan options");
  const limits = resolveLimits(optionValues.limits as Partial<ReferenceMotionBlurLimits> | undefined);
  const config = closedDataObject(configValue, ["shutterAngle", "samples"], "CUT MotionBlur config");
  if (!hasOwn(config, "shutterAngle") || !hasOwn(config, "samples")) fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur config requires shutterAngle and samples.");
  const outputTime = canonicalRational(outputTimeValue, "CUT MotionBlur outputTime", limits);
  const frameDuration = canonicalRational(frameDurationValue, "CUT MotionBlur frameDuration", limits);
  const shutterAngle = canonicalRational(config.shutterAngle, "CUT MotionBlur shutterAngle", limits);
  if (compareRational(frameDuration, zeroRational) <= 0) fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur frameDuration must be positive.");
  if (compareRational(shutterAngle, zeroRational) === 0) fail("CUT_MOTION_BLUR_NOOP", "CUT MotionBlur shutterAngle must be greater than zero; a zero shutter is a no-op.");
  if (compareRational(shutterAngle, zeroRational) < 0 || compareRational(shutterAngle, rational(360)) > 0) {
    fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur shutterAngle must be greater than zero and at most 360 degrees.");
  }
  const sampleCountValue = config.samples;
  if (typeof sampleCountValue !== "number" || !Number.isSafeInteger(sampleCountValue) || sampleCountValue < 1) fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur samples must be a positive safe integer.");
  const sampleCount = sampleCountValue;
  if (sampleCount === 1) fail("CUT_MOTION_BLUR_NOOP", "CUT MotionBlur requires at least two temporal samples; one sample is a no-op.");
  if (sampleCount > limits.maxSamples) fail("CUT_MOTION_BLUR_BUDGET", `CUT MotionBlur exceeds maxSamples=${limits.maxSamples}.`);

  const exposureDuration = exactMultiply(frameDuration, exactDivide(shutterAngle, rational(360), "CUT MotionBlur shutter fraction", limits), "CUT MotionBlur exposure duration", limits);
  if (compareRational(exposureDuration, zeroRational) <= 0) fail("CUT_MOTION_BLUR_NOOP", "CUT MotionBlur exposure must span positive exact time.");
  const open = exactSubtract(outputTime, exactDivide(exposureDuration, rational(2), "CUT MotionBlur half exposure", limits), "CUT MotionBlur shutter open", limits);
  const weight = exactDivide(rational(1), rational(sampleCount), "CUT MotionBlur sample weight", limits);
  const denominator = rational(sampleCount * 2);
  const samples = Array.from({ length: sampleCount }, (_, index): ReferenceMotionBlurSample => {
    const phase = exactDivide(rational(index * 2 + 1), denominator, `CUT MotionBlur sample ${index} phase`, limits);
    const offset = exactMultiply(exposureDuration, phase, `CUT MotionBlur sample ${index} offset`, limits);
    return Object.freeze({ index, time: frozenRational(exactAdd(open, offset, `CUT MotionBlur sample ${index} time`, limits)), weight: frozenRational(weight) });
  });
  if (compareRational(samples[0]!.time, samples[samples.length - 1]!.time) === 0) fail("CUT_MOTION_BLUR_NOOP", "CUT MotionBlur temporal samples collapse to one instant.");
  return Object.freeze({
    outputTime: frozenRational(outputTime),
    frameDuration: frozenRational(frameDuration),
    shutterAngle: frozenRational(shutterAngle),
    exposureDuration: frozenRational(exposureDuration),
    samples: Object.freeze(samples),
  });
}

/** Decode and close one loaded typed-IR MotionBlur node before frame work. */
export function referenceMotionBlurConfig(node: IRNode): ReferenceMotionBlurNodeConfig | undefined {
  if (node.op !== "cut.visual.motion_blur") return undefined;
  try {
    const inputs = closedDataObject(node.inputs, ["shutterAngle", "samples", "startEdge"], "CUT MotionBlur inputs");
    if (!hasOwn(inputs, "shutterAngle") || !hasOwn(inputs, "samples")) fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur requires shutterAngle and samples.");
    if (node.children.length !== 1) fail("CUT_MOTION_BLUR_CONFIG", `CUT MotionBlur requires exactly one visual child; found ${node.children.length}.`);
    if (Object.keys(node.properties).length) fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur has no executable properties; shutterAngle and samples are static inputs.");
    const angleValue = inputs.shutterAngle;
    if (!isRecord(angleValue) || angleValue.kind !== "quantity" || angleValue.dimension !== "angle" || angleValue.unit !== "deg") {
      fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur shutterAngle must be an exact Angle in canonical degrees.");
    }
    const samplesValue = inputs.samples;
    if (!isRecord(samplesValue) || samplesValue.kind !== "quantity" || samplesValue.dimension !== "scalar" || samplesValue.unit !== "scalar") {
      fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur samples must be an exact Number integer.");
    }
    const limits = defaultReferenceMotionBlurLimits;
    const shutterAngle = canonicalRational(angleValue.magnitude, "CUT MotionBlur shutterAngle", limits);
    const sampleMagnitude = canonicalRational(samplesValue.magnitude, "CUT MotionBlur samples", limits);
    if (sampleMagnitude.denominator !== "1") fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur samples must be an exact integer.");
    const samples = Number(sampleMagnitude.numerator);
    if (!Number.isSafeInteger(samples)) fail("CUT_MOTION_BLUR_BUDGET", "CUT MotionBlur samples exceeds the safe integer range.");
    const authoredStartEdge = hasOwn(inputs, "startEdge");
    let startEdge: ReferenceMotionBlurNodeConfig["startEdge"] = "transparent";
    if (authoredStartEdge) {
      const value = inputs.startEdge;
      if (!isRecord(value) || value.kind !== "string" || typeof value.value !== "string") {
        fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur startEdge must be the static String transparent or hold.");
      }
      if (value.value !== "transparent" && value.value !== "hold") {
        fail("CUT_MOTION_BLUR_CONFIG", `CUT MotionBlur startEdge must be transparent or hold; received ${boundedDiagnosticString(value.value)}.`);
      }
      startEdge = value.value;
    }
    // Reuse the public scheduler as the single no-op/range/sample-budget
    // validator without duplicating subtly different accepted semantics.
    createReferenceMotionBlurPlan(zeroRational, rational(1), { shutterAngle, samples });
    return Object.freeze({ nodeId: node.id, shutterAngle: frozenRational(shutterAngle), samples, startEdge, authoredStartEdge });
  } catch (error) {
    throwReferenceMotionBlurNodeError(node, error);
  }
}

/**
 * Preflight aggregate and nested temporal amplification for one composition.
 * This is intentionally conservative: each reachable MotionBlur is charged a
 * full-canvas sample workload even when its child draws only a small region.
 */
export function validateReferenceMotionBlurCompositionBudget(
  ir: CutAVIR,
  reachable: ReadonlySet<string>,
  width: number,
  height: number,
) {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels < 1) fail("CUT_MOTION_BLUR_BUDGET", "CUT MotionBlur composition canvas is not addressable.");
  const configs = new Map<string, ReferenceMotionBlurNodeConfig>();
  for (const id of reachable) {
    const node = ir.nodes[id];
    if (!node) continue;
    const config = referenceMotionBlurConfig(node);
    if (config) configs.set(id, config);
  }
  // This validator owns only temporal exposure work. In particular, it must
  // not walk an unrelated malformed visual subtree and pre-empt the closed
  // kernel/child diagnostic that owns that graph. The generic session
  // validator closes every reachable node separately.
  if (configs.size === 0) return;
  const firstNode = ir.nodes[configs.keys().next().value as string]!;
  if (pixels > defaultReferenceMotionBlurLimits.maxPixels) {
    throwReferenceMotionBlurNodeError(firstNode, new ReferenceMotionBlurError(
      "CUT_MOTION_BLUR_BUDGET",
      `direct accumulation canvas has ${pixels} pixels and exceeds maxPixels=${defaultReferenceMotionBlurLimits.maxPixels}`,
    ));
  }
  for (const [id, config] of configs) {
    const pixelSamples = BigInt(pixels) * BigInt(config.samples);
    if (pixelSamples > BigInt(defaultReferenceMotionBlurLimits.maxPixelSamples)) {
      throwReferenceMotionBlurNodeError(ir.nodes[id]!, new ReferenceMotionBlurError(
        "CUT_MOTION_BLUR_BUDGET",
        `direct accumulation requires ${pixelSamples} pixel-samples and exceeds maxPixelSamples=${defaultReferenceMotionBlurLimits.maxPixelSamples}`,
      ));
    }
  }
  if (configs.size > referenceMotionBlurCompositionLimits.maxNodes) {
    throwReferenceMotionBlurNodeError(firstNode, new ReferenceMotionBlurError("CUT_MOTION_BLUR_BUDGET", `composition exceeds the ${referenceMotionBlurCompositionLimits.maxNodes}-MotionBlur-node limit`));
  }
  const nestedMotionBlurIds = new Set<string>();
  for (const [id, config] of configs) {
    const descendants = (ir.nodes[id]?.children ?? []).map((descendantId) => ({
      id: descendantId,
      belowNestedMotionBlur: false,
    }));
    const visited = new Set<string>();
    while (descendants.length) {
      const pending = descendants.pop()!;
      const visitKey = `${pending.id}:${pending.belowNestedMotionBlur ? 1 : 0}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const descendantId = pending.id;
      const descendant = ir.nodes[descendantId];
      if (!descendant || !reachable.has(descendantId)) continue;
      const belowNestedMotionBlur = pending.belowNestedMotionBlur || configs.has(descendantId);
      if (configs.has(descendantId)) nestedMotionBlurIds.add(descendantId);
      if (belowNestedMotionBlur && forwardOnlyMediaDecoderOps.has(descendant.op)) {
        throwReferenceMotionBlurNodeError(ir.nodes[id]!, new ReferenceMotionBlurError(
          "CUT_MOTION_BLUR_PLAN",
          `nested MotionBlur cannot sample forward-only media node ${descendant.id}; author one shutter around the media or move one shutter outside that media subtree until bounded decoder seeking is implemented`,
        ));
      }
      if (descendant.op === "cut.visual.precomp" || descendant.op === "cut.edit.nested_sequence") {
        throwReferenceMotionBlurNodeError(ir.nodes[id]!, new ReferenceMotionBlurError(
          "CUT_MOTION_BLUR_PLAN",
          "MotionBlur cannot cross a Precomp/NestedSequence composition boundary until subframe nested sampling and cross-composition temporal amplification are implemented",
        ));
      }
      descendants.push(...descendant.children.map((childId) => ({ id: childId, belowNestedMotionBlur })));
    }
    // Reading the sample count here is intentional: `referenceMotionBlurConfig`
    // has already closed and bounded the value before any graph walk.
    void config.samples;
  }

  const amplificationMemo = new Map<string, bigint>();
  const visiting = new Set<string>();
  const amplification = (id: string): bigint => {
    const cached = amplificationMemo.get(id); if (cached !== undefined) return cached;
    const node = ir.nodes[id]; if (!node || !reachable.has(id)) return 1n;
    if (visiting.has(id)) throwReferenceMotionBlurNodeError(node, new ReferenceMotionBlurError("CUT_MOTION_BLUR_PLAN", "MotionBlur child graph contains a cycle"));
    visiting.add(id);
    let childMaximum = 1n;
    for (const child of node.children) {
      const value = amplification(child);
      if (value > childMaximum) childMaximum = value;
    }
    visiting.delete(id);
    const value = childMaximum * BigInt(configs.get(id)?.samples ?? 1);
    if (value > BigInt(referenceMotionBlurCompositionLimits.maxNestedTemporalSamples)) {
      throwReferenceMotionBlurNodeError(node, new ReferenceMotionBlurError("CUT_MOTION_BLUR_BUDGET", `nested temporal amplification ${value} exceeds maxNestedTemporalSamples=${referenceMotionBlurCompositionLimits.maxNestedTemporalSamples}`));
    }
    amplificationMemo.set(id, value); return value;
  };
  // Starting at MotionBlur nodes is sufficient to cover every temporal
  // subtree while leaving unrelated graphs to their own validators.
  for (const id of configs.keys()) amplification(id);

  // Charge the work the renderer will actually perform, including temporal
  // amplification of nested MotionBlur descendants. A node with N samples
  // performs N full-canvas accumulations and evaluates its child subtree N
  // times, so its cost is N * (1 + childCost). Ordinary grouping nodes sum
  // their child costs. Shared DAG descendants may be charged more than once;
  // that is a deliberate conservative resource bound, independent of cache
  // scheduling details.
  const costMemo = new Map<string, bigint>();
  const costVisiting = new Set<string>();
  const maximumCost = BigInt(referenceMotionBlurCompositionLimits.maxAggregatePixelSamples) / BigInt(pixels);
  const temporalCost = (id: string): bigint => {
    const cached = costMemo.get(id); if (cached !== undefined) return cached;
    const node = ir.nodes[id]; if (!node || !reachable.has(id)) return 0n;
    if (costVisiting.has(id)) throwReferenceMotionBlurNodeError(node, new ReferenceMotionBlurError("CUT_MOTION_BLUR_PLAN", "MotionBlur child graph contains a cycle"));
    costVisiting.add(id);
    let childCost = 0n;
    for (const child of node.children) {
      childCost += temporalCost(child);
      if (childCost > maximumCost) break;
    }
    costVisiting.delete(id);
    const samples = BigInt(configs.get(id)?.samples ?? 1);
    const cost = configs.has(id) ? samples * (1n + childCost) : childCost;
    costMemo.set(id, cost);
    return cost;
  };

  // Sum only outermost temporal wrappers. An inner MotionBlur is already
  // charged by its outer wrapper's child cost; starting from ordinary graph
  // roots would traverse unrelated cycles and starting from every blur would
  // double-charge nested work. A temporal cycle can mark every blur nested,
  // so retain all configs as the fail-closed fallback in that hostile case.
  const roots = [...configs.keys()].filter((id) => !nestedMotionBlurIds.has(id));
  const costRoots = roots.length ? roots : [...configs.keys()];
  let aggregateCost = 0n;
  let failureNode: IRNode | undefined;
  for (const id of costRoots) {
    const cost = temporalCost(id);
    if (cost > 0n) failureNode = ir.nodes[id];
    aggregateCost += cost;
    if (aggregateCost > maximumCost) break;
  }
  const aggregatePixelSamples = aggregateCost * BigInt(pixels);
  if (aggregatePixelSamples > BigInt(referenceMotionBlurCompositionLimits.maxAggregatePixelSamples)) {
    const node = failureNode ?? ir.nodes[configs.keys().next().value as string]!;
    throwReferenceMotionBlurNodeError(node, new ReferenceMotionBlurError(
      "CUT_MOTION_BLUR_BUDGET",
      `composition temporal accumulation requires at least ${aggregatePixelSamples} pixel-samples and exceeds maxAggregatePixelSamples=${referenceMotionBlurCompositionLimits.maxAggregatePixelSamples}`,
    ));
  }
}

function validateDenseArray(value: unknown, label: string, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value)) fail("CUT_MOTION_BLUR_PLAN", `${label} must be an array.`);
  if (value.length > maximumLength) fail("CUT_MOTION_BLUR_BUDGET", `${label} exceeds the ${maximumLength}-entry budget.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail("CUT_MOTION_BLUR_PLAN", `${label} must be a dense data array.`);
  }
  if (Reflect.ownKeys(value).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) {
    fail("CUT_MOTION_BLUR_PLAN", `${label} cannot contain non-index properties.`);
  }
  return value;
}

function sameRational(left: Rational, right: Rational) {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

function validatePlan(planValue: ReferenceMotionBlurPlan, limits: ReferenceMotionBlurLimits): ReferenceMotionBlurPlan {
  const plan = closedDataObject(planValue, ["outputTime", "frameDuration", "shutterAngle", "exposureDuration", "samples"], "CUT MotionBlur plan");
  for (const required of ["outputTime", "frameDuration", "shutterAngle", "exposureDuration", "samples"] as const) {
    if (!hasOwn(plan, required)) fail("CUT_MOTION_BLUR_PLAN", `CUT MotionBlur plan is missing ${required}.`);
  }
  const samples = validateDenseArray(plan.samples, "CUT MotionBlur plan samples", limits.maxSamples);
  if (samples.length < 2 || samples.length > limits.maxSamples) fail("CUT_MOTION_BLUR_PLAN", "CUT MotionBlur plan has an invalid sample count.");
  const expected = createReferenceMotionBlurPlan(
    canonicalRational(plan.outputTime, "CUT MotionBlur plan outputTime", limits),
    canonicalRational(plan.frameDuration, "CUT MotionBlur plan frameDuration", limits),
    { shutterAngle: canonicalRational(plan.shutterAngle, "CUT MotionBlur plan shutterAngle", limits), samples: samples.length },
    { limits },
  );
  const exposure = canonicalRational(plan.exposureDuration, "CUT MotionBlur plan exposureDuration", limits);
  if (!sameRational(exposure, expected.exposureDuration)) fail("CUT_MOTION_BLUR_PLAN", "CUT MotionBlur plan exposureDuration does not match its exact config.");
  for (let index = 0; index < samples.length; index += 1) {
    const sample = closedDataObject(samples[index], ["index", "time", "weight"], `CUT MotionBlur plan sample ${index}`);
    if (sample.index !== index) fail("CUT_MOTION_BLUR_PLAN", `CUT MotionBlur plan sample ${index} has a non-canonical index.`);
    const time = canonicalRational(sample.time, `CUT MotionBlur plan sample ${index} time`, limits);
    const weight = canonicalRational(sample.weight, `CUT MotionBlur plan sample ${index} weight`, limits);
    if (!sameRational(time, expected.samples[index]!.time) || !sameRational(weight, expected.samples[index]!.weight)) {
      fail("CUT_MOTION_BLUR_PLAN", `CUT MotionBlur plan sample ${index} does not match the exact midpoint schedule.`);
    }
  }
  return expected;
}

function surfaceAlphaMode(surface: RgbaSurface, label: string): RgbaAlphaMode {
  if (!surface || typeof surface !== "object") fail("CUT_MOTION_BLUR_SURFACE", `${label} must be an RGBA surface.`);
  if (!Number.isSafeInteger(surface.width) || !Number.isSafeInteger(surface.height) || surface.width < 1 || surface.height < 1) {
    fail("CUT_MOTION_BLUR_SURFACE", `${label} dimensions must be positive safe integers.`);
  }
  const pixels = surface.width * surface.height;
  if (!Number.isSafeInteger(pixels) || pixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)) fail("CUT_MOTION_BLUR_SURFACE", `${label} dimensions exceed the RGBA addressable range.`);
  if (!(surface.data instanceof Uint8Array) || surface.data.byteLength !== pixels * 4) fail("CUT_MOTION_BLUR_SURFACE", `${label} must contain exactly width x height x 4 RGBA bytes.`);
  const mode = surface.alphaMode ?? "straight";
  if (mode !== "straight" && mode !== "premultiplied") fail("CUT_MOTION_BLUR_SURFACE", `${label} alphaMode must be straight or premultiplied.`);
  return mode;
}

function linearToSrgb(value: number) {
  const linear = clampUnit(value);
  if (linear === 0 || linear === 1) return linear;
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}

function straightLinearChannel(surface: RgbaSurface, mode: RgbaAlphaMode, offset: number, alpha: number) {
  if (alpha <= 0) return 0;
  if (mode === "straight") return srgbToLinearBytes[surface.data[offset]]!;
  const encoded = clampUnit((surface.data[offset] / 255) / alpha);
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

/**
 * Uniformly accumulate already-rendered child samples in premultiplied
 * linear-light sRGB and return deterministic 8-bit RGBA. Transparent hidden
 * RGB never enters the accumulator. The default public boundary is straight
 * alpha; a conventional encoded-sRGB-premultiplied boundary is explicit.
 */
export function accumulateReferenceMotionBlur(
  planValue: ReferenceMotionBlurPlan,
  surfacesValue: readonly RgbaSurface[],
  optionsValue: ReferenceMotionBlurApplyOptions = {},
): ReferenceMotionBlurSurface {
  const options = closedDataObject(optionsValue, ["outputAlphaMode", "limits"], "CUT MotionBlur apply options");
  const limits = resolveLimits(options.limits as Partial<ReferenceMotionBlurLimits> | undefined);
  const outputAlphaMode = options.outputAlphaMode ?? "straight";
  if (outputAlphaMode !== "straight" && outputAlphaMode !== "premultiplied") fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur outputAlphaMode must be straight or premultiplied.");
  const plan = validatePlan(planValue, limits);
  const surfaces = validateDenseArray(surfacesValue, "CUT MotionBlur surfaces", limits.maxSamples) as readonly RgbaSurface[];
  if (surfaces.length !== plan.samples.length) fail("CUT_MOTION_BLUR_SURFACE", `CUT MotionBlur needs exactly ${plan.samples.length} rendered child surfaces.`);

  const modes = surfaces.map((surface, index) => surfaceAlphaMode(surface, `CUT MotionBlur sample ${index}`));
  const first = surfaces[0]!;
  const pixels = first.width * first.height;
  if (pixels > limits.maxPixels) fail("CUT_MOTION_BLUR_BUDGET", `CUT MotionBlur exceeds maxPixels=${limits.maxPixels}.`);
  const pixelSamples = pixels * surfaces.length;
  if (!Number.isSafeInteger(pixelSamples) || pixelSamples > limits.maxPixelSamples) {
    fail("CUT_MOTION_BLUR_BUDGET", `CUT MotionBlur exceeds maxPixelSamples=${limits.maxPixelSamples}.`);
  }
  for (let index = 1; index < surfaces.length; index += 1) {
    if (surfaces[index]!.width !== first.width || surfaces[index]!.height !== first.height) {
      fail("CUT_MOTION_BLUR_SURFACE", "CUT MotionBlur sample surfaces must have identical dimensions.");
    }
  }

  const output = new Uint8Array(first.data.byteLength);
  for (let offset = 0; offset < output.length; offset += 4) {
    let alphaSum = 0;
    const premultipliedLinear = [0, 0, 0];
    for (let sampleIndex = 0; sampleIndex < surfaces.length; sampleIndex += 1) {
      const surface = surfaces[sampleIndex]!;
      const alpha = surface.data[offset + 3] / 255;
      alphaSum += alpha;
      for (let channel = 0; channel < 3; channel += 1) {
        premultipliedLinear[channel] += straightLinearChannel(surface, modes[sampleIndex]!, offset + channel, alpha) * alpha;
      }
    }
    const alpha = alphaSum / surfaces.length;
    for (let channel = 0; channel < 3; channel += 1) {
      const straightLinear = alphaSum > 0 ? premultipliedLinear[channel]! / alphaSum : 0;
      const encoded = linearToSrgb(straightLinear);
      output[offset + channel] = byte(outputAlphaMode === "premultiplied" ? encoded * alpha : encoded);
    }
    output[offset + 3] = byte(alpha);
  }
  return { data: output, width: first.width, height: first.height, alphaMode: outputAlphaMode };
}
