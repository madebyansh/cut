import { stableJsonStringify } from "../core/stable";
import type { CutAVIR, IRNode, IRSignal, IRValue } from "./ir";
import {
  referenceKernelRegistry,
  referenceKernelSchema,
} from "./kernel-registry";
import { rational } from "./rational";

// MediaCamera2D owns a separate source-resolution contract. Keep this module's
// closure independent from that implementation so its audit can move without
// weakening or destabilizing the ordinary visual-property ABI.
const excludedMediaCamera2DOp = "cut.visual.media_camera2d";

/**
 * Canonical ownership of the value before the first ordinary visual property
 * event. This is a language/typed-IR ABI, not a renderer convenience:
 * specialized kernels may not reinterpret `track.initial: null` differently.
 *
 * `input-required` is deliberately distinct from a guessed default. It is
 * used when the public operation is static without that control, or when its
 * omission has context/time-derived semantics which cannot be represented by
 * one exact typed IR value. Authors must establish the property baseline with
 * the same-named constructor input before attaching a track.
 */
export type CutVisualPropertyBaselinePolicy = Readonly<
  | {
    kind: "default";
    value: IRValue;
    /** Whether a same-named constructor input is the pre-event value or an
     * independent primitive-geometry coordinate with the same spelling. */
    constructorInput: "baseline" | "independent";
  }
  | { kind: "input-required"; reason: string }
>;

export type CutResolvedVisualPropertyBaseline = Readonly<
  | { kind: "value"; origin: "constructor-input" | "public-default"; value: IRValue }
  | { kind: "missing-input"; reason: string }
>;

const quantity = (
  dimension: "angle" | "length" | "ratio" | "scalar",
  unit: "deg" | "px" | "ratio" | "scalar",
  numerator: number,
  denominator = 1,
): IRValue => Object.freeze({
  kind: "quantity" as const,
  dimension,
  unit,
  magnitude: Object.freeze(rational(numerator, denominator)),
});

const angle = (value: number) => quantity("angle", "deg", value);
const length = (value: number) => quantity("length", "px", value);
const ratio = (numerator: number, denominator = 1) => quantity("ratio", "ratio", numerator, denominator);
const scalar = (value: number) => quantity("scalar", "scalar", value);
const defaultValue = (
  value: IRValue,
  constructorInput: "baseline" | "independent" = "baseline",
): CutVisualPropertyBaselinePolicy => Object.freeze({ kind: "default", value, constructorInput });
const requiredInput = (reason: string): CutVisualPropertyBaselinePolicy => Object.freeze({ kind: "input-required", reason });

const zeroLength = defaultValue(length(0));
const zeroAngle = defaultValue(angle(0));
const zeroRatio = defaultValue(ratio(0));
const oneRatio = defaultValue(ratio(1));
const zeroScalar = defaultValue(scalar(0));
const oneScalar = defaultValue(scalar(1));

const transform = Object.freeze({
  opacity: oneRatio,
  x: zeroLength,
  y: zeroLength,
  scale: oneScalar,
  rotation: zeroAngle,
});

const independentlyPositionedTransform = Object.freeze({
  ...transform,
  // These primitive inputs place geometry internally. A property signal with
  // the same spelling is an additional compositor displacement.
  x: defaultValue(length(0), "independent"),
  y: defaultValue(length(0), "independent"),
});

const retainedTransform = Object.freeze({
  ...transform,
  anchorX: zeroLength,
  anchorY: zeroLength,
  skewX: zeroAngle,
  skewY: zeroAngle,
});

type MutablePolicies = Record<string, Record<string, CutVisualPropertyBaselinePolicy>>;
const policies: MutablePolicies = Object.create(null) as MutablePolicies;

function register(
  operations: readonly string[],
  values: Readonly<Record<string, CutVisualPropertyBaselinePolicy>>,
) {
  for (const operation of operations) {
    if (policies[operation]) throw new Error(`CUT visual property baselines register ${operation} more than once.`);
    policies[operation] = { ...values };
  }
}

register([
  "cut.kernel.fragment",
  "cut.visual.video",
  "cut.visual.image",
  "cut.visual.image_sequence",
  "cut.visual.precomp",
  "cut.visual.flow_text",
  "cut.visual.trace",
  "cut.visual.track_2d",
  "cut.visual.stack",
  "cut.visual.composite",
  "cut.visual.mask",
  "cut.visual.camera2d",
  "cut.geo.marker",
  "cut.edit.clip",
  "cut.edit.picture_clip",
], transform);

register([
  "cut.visual.text",
  "cut.visual.rect",
  "cut.visual.circle",
  "cut.documentary.evidence",
], independentlyPositionedTransform);

register(["cut.visual.group"], retainedTransform);

register(["cut.visual.motion_path"], {
  ...retainedTransform,
  progress: zeroRatio,
});

register(["cut.visual.planar_track"], { opacity: oneRatio });

register(["cut.visual.path"], {
  ...transform,
  morph: zeroRatio,
  trimStart: zeroRatio,
  trimEnd: oneRatio,
  dashOffset: zeroLength,
});

register(["cut.diagram.layout"], {
  progress: requiredInput("DiagramLayout transition progress is meaningful only with the paired fromState/progress constructor contract."),
});

register(["cut.visual.parallax_camera"], {
  x: zeroLength,
  y: zeroLength,
  z: zeroLength,
  focusDepth: requiredInput("ParallaxCamera focusDepth automation requires focus: linear and an explicit focusDepth constructor baseline."),
});

register(["cut.visual.camera3d"], {
  focalLength: requiredInput("Camera3D focalLength is required and establishes the track baseline."),
  x: zeroLength,
  y: zeroLength,
  z: zeroLength,
  targetX: zeroLength,
  targetY: zeroLength,
  targetZ: defaultValue(length(1_000)),
  roll: zeroAngle,
});

register(["cut.visual.plane3d"], {
  x: zeroLength,
  y: zeroLength,
  z: requiredInput("Plane3D z is required and establishes the track baseline."),
  rotationX: zeroAngle,
  rotationY: zeroAngle,
  rotationZ: zeroAngle,
  scale: oneScalar,
  opacity: oneRatio,
});

register(["cut.visual.lut"], { strength: oneRatio });

register(["cut.visual.color_grade"], {
  ...transform,
  exposure: zeroScalar,
  temperature: zeroScalar,
  tint: zeroScalar,
  brightness: oneScalar,
  saturation: oneScalar,
  hue: zeroAngle,
  contrast: oneScalar,
});

register(["cut.geo.annotation"], { opacity: oneRatio });
register(["cut.visual.callout"], { opacity: oneRatio });

register(["cut.geo.map_camera"], {
  latitude: zeroScalar,
  longitude: zeroScalar,
  scale: oneScalar,
  bearing: zeroAngle,
  pitch: zeroAngle,
});

register(["cut.geo.globe"], {
  ...independentlyPositionedTransform,
  // Unlike x/y, Globe.rotation automation and the constructor input are one
  // intrinsic projection control. The outer compositor never consumes it.
  rotation: zeroAngle,
  reveal: oneRatio,
});

register([
  "cut.geo.map",
  "cut.geo.route",
  "cut.geo.connections",
  "cut.data.waveform",
  "cut.data.spectrogram",
  "cut.data.series_chart",
], { ...transform, reveal: oneRatio });

register(["cut.geo.route_subject"], {
  progress: zeroRatio,
  opacity: oneRatio,
});

register(["cut.data.chart"], { ...independentlyPositionedTransform, reveal: oneRatio });

register(["cut.geo.wavefront"], {
  ...independentlyPositionedTransform,
  reveal: requiredInput("Wavefront omission owns an interval-relative automatic reveal, so an authored reveal track requires one exact constructor baseline."),
});

/**
 * Closed matrix for every current supported non-audio visual/AV property.
 * MediaCamera2D owns its independent source-resolution contract and is the
 * sole deliberate exclusion from this matrix.
 */
export const cutVisualPropertyBaselineRegistry: Readonly<
  Record<string, Readonly<Record<string, CutVisualPropertyBaselinePolicy>>>
> = Object.freeze(Object.fromEntries(Object.entries(policies).map(([operation, entries]) => [operation, Object.freeze(entries)])));

function assertClosedRegistry() {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [operation, schema] of Object.entries(referenceKernelRegistry)) {
    if (schema.support !== "supported" || schema.domain === "audio" || operation === excludedMediaCamera2DOp) continue;
    for (const property of schema.properties) if (!cutVisualPropertyBaselineRegistry[operation]?.[property]) {
      missing.push(`${operation}.${property}`);
    }
  }
  for (const [operation, entries] of Object.entries(cutVisualPropertyBaselineRegistry)) {
    const schema = referenceKernelSchema(operation);
    for (const property of Object.keys(entries)) if (schema?.support !== "supported" || !schema.properties.includes(property)) {
      extra.push(`${operation}.${property}`);
    }
  }
  if (missing.length || extra.length) {
    throw new Error(`CUT visual property baseline registry drift${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; extra: ${extra.join(", ")}` : ""}.`);
  }
}

assertClosedRegistry();

export function cutVisualPropertyBaselinePolicy(operation: string, property: string) {
  return cutVisualPropertyBaselineRegistry[operation]?.[property];
}

function cloneValue(value: IRValue): IRValue {
  // Baselines are tiny canonical quantity values. Returning a fresh value keeps
  // compiler/test mutation from changing the module-level ABI registry.
  return JSON.parse(stableJsonStringify(value)) as IRValue;
}

export function resolveCutVisualPropertyTrackBaseline(
  node: IRNode,
  property: string,
): CutResolvedVisualPropertyBaseline | undefined {
  if (node.domain !== "visual" && node.domain !== "av") return undefined;
  if (node.op === excludedMediaCamera2DOp) return undefined;
  const schema = referenceKernelSchema(node.op);
  if (schema?.support !== "supported" || !schema.properties.includes(property)) return undefined;
  const policy = cutVisualPropertyBaselinePolicy(node.op, property);
  if (!policy) return undefined;
  const input = policy.kind === "default" && policy.constructorInput === "independent"
    ? undefined
    : node.inputs[property];
  if (input !== undefined && input.kind !== "null") {
    return Object.freeze({ kind: "value", origin: "constructor-input", value: cloneValue(input) });
  }
  if (policy.kind === "input-required") return Object.freeze({ kind: "missing-input", reason: policy.reason });
  return Object.freeze({ kind: "value", origin: "public-default", value: cloneValue(policy.value) });
}

export type CutVisualPropertyBaselineIssue = Readonly<{
  code: "CUT_VISUAL_BASELINE";
  nodeId: string;
  operation: string;
  property: string;
  signalId: string;
  kind: "missing-input" | "null" | "conflict";
  expected?: IRValue;
  origin?: "constructor-input" | "public-default";
  message: string;
}>;

function ordinaryTrack(signal: IRSignal | undefined): signal is Extract<IRSignal, { kind: "track" }> {
  return signal?.kind === "track" && signal.producer === undefined;
}

/** Return the first strict ABI disagreement without invoking any renderer. */
export function cutVisualPropertyBaselineIssue(ir: CutAVIR, node: IRNode): CutVisualPropertyBaselineIssue | undefined {
  if (node.domain !== "visual" && node.domain !== "av") return undefined;
  if (node.op === excludedMediaCamera2DOp) return undefined;
  for (const [property, authored] of Object.entries(node.properties)) {
    if (!("signal" in authored)) continue;
    const signal = ir.signals[authored.signal];
    if (!ordinaryTrack(signal)) continue;
    const baseline = resolveCutVisualPropertyTrackBaseline(node, property);
    if (!baseline) continue;
    if (baseline.kind === "missing-input") {
      return Object.freeze({
        code: "CUT_VISUAL_BASELINE",
        nodeId: node.id,
        operation: node.op,
        property,
        signalId: signal.id,
        kind: "missing-input",
        message: `${node.op}.${property} track ${signal.id} requires a same-named constructor baseline: ${baseline.reason}`,
      });
    }
    if (signal.initial.kind === "null") {
      return Object.freeze({
        code: "CUT_VISUAL_BASELINE",
        nodeId: node.id,
        operation: node.op,
        property,
        signalId: signal.id,
        kind: "null",
        expected: baseline.value,
        origin: baseline.origin,
        message: `${node.op}.${property} track ${signal.id}.initial is null; it must equal the canonical ${baseline.origin === "constructor-input" ? "constructor input" : "public default"}.`,
      });
    }
    if (stableJsonStringify(signal.initial) !== stableJsonStringify(baseline.value)) {
      return Object.freeze({
        code: "CUT_VISUAL_BASELINE",
        nodeId: node.id,
        operation: node.op,
        property,
        signalId: signal.id,
        kind: "conflict",
        expected: baseline.value,
        origin: baseline.origin,
        message: `${node.op}.${property} track ${signal.id}.initial conflicts with the canonical ${baseline.origin === "constructor-input" ? "constructor input" : "public default"}.`,
      });
    }
  }
  return undefined;
}

export class CutVisualPropertyBaselineError extends Error {
  readonly code = "CUT_VISUAL_BASELINE" as const;

  constructor(readonly issue: CutVisualPropertyBaselineIssue, readonly node: IRNode) {
    super(`${issue.code}: ${issue.message} at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}.`);
    this.name = "CutVisualPropertyBaselineError";
  }
}

export function validateCutVisualPropertyTrackBaselines(ir: CutAVIR, node: IRNode) {
  const issue = cutVisualPropertyBaselineIssue(ir, node);
  if (issue) throw new CutVisualPropertyBaselineError(issue, node);
}
