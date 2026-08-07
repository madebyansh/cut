import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import { cutMediaCamera2DControlDefaults } from "../../language/media-camera2d-contract";
import { hash } from "../../core/stable";
import { cutSignalContentHash } from "../graph";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  type Rational,
} from "../../language/rational";
import { propertyAt } from "./signals";
import { referenceSignalItemCount, referenceSignalWithItemRemoved } from "./noop-contract";
import {
  referenceRetainedMediaViewportQ16BilinearTapsAt,
  referenceRetainedMediaViewportQ16SamplingTransform,
  referenceRetainedMediaViewportQ16Units,
} from "./retained-media-viewport";

export const referenceMediaCamera2DObservabilityAlgorithmVersion = "cut-reference-media-camera2d-sampler-q8-observability-v2" as const;
export const referenceMediaCamera2DPhaseUnits = referenceRetainedMediaViewportQ16Units;
/** The normative RGBA8 opacity phase. Quantizing before interpolation makes
 * admission and the sampler identical for every integer/fractional alpha. */
export const referenceMediaCamera2DOpacityPhaseUnits = 255;

export const referenceMediaCamera2DObservabilityLimits = Object.freeze({
  // One camera can cover more than nine hours at 30fps. The aggregate bound
  // admits five minutes at 30fps with seventeen 25-pixel plan evaluations per
  // frame while remaining a finite hostile-IR envelope.
  maximumOutputFrameSamplesPerCamera: 1_000_000,
  maximumWorkUnitsPerComposition: 4_000_000,
});

export type ReferenceMediaCamera2DObservabilityDiagnosticCode =
  | "CUT_MEDIA_CAMERA_INPUT"
  | "CUT_MEDIA_CAMERA_LIMIT"
  | "CUT_MEDIA_CAMERA_NOOP"
  | "CUT_MEDIA_CAMERA_PREFLIGHT";

export class ReferenceMediaCamera2DObservabilityError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(
    readonly code: ReferenceMediaCamera2DObservabilityDiagnosticCode,
    readonly node: IRNode,
    detail: string,
  ) {
    const { module, span } = node.provenance;
    super(`${code}: MediaCamera2D at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceMediaCamera2DObservabilityError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceMediaCamera2DSpatialControl = "focusX" | "focusY" | "zoom" | "rotation";

export type ReferenceMediaCamera2DObservabilityGrid = Readonly<{
  source: Readonly<{ width: number; height: number }>;
  output: Readonly<{ width: number; height: number }>;
  fit: "cover" | "contain" | "fill";
  edge: "transparent" | "clamp";
}>;

export type ReferenceMediaCamera2DSpatialControls = Readonly<{
  focusX: number;
  focusY: number;
  zoom: number;
  rotationDegrees: number;
}>;

export type ReferenceMediaCamera2DQ16Affine = Readonly<{
  a: string;
  b: string;
  c: string;
  d: string;
  tx: string;
  ty: string;
}>;

export type ReferenceMediaCamera2DQuantizedAffine = Readonly<{
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}>;

export type ReferenceMediaCamera2DObservabilityReport = Readonly<{
  format: "cut-reference-media-camera2d-q16-observability";
  version: 1;
  algorithmVersion: typeof referenceMediaCamera2DObservabilityAlgorithmVersion;
  cameraNodeId: string;
  authoredControlIdentity: string;
  samples: number;
  workUnits: number;
  witnessPixelsPerPlan: number;
  planEvaluations: number;
  grid: ReferenceMediaCamera2DObservabilityGrid;
  authoredSpatialControls: readonly ReferenceMediaCamera2DSpatialControl[];
  observableSpatialControls: readonly ReferenceMediaCamera2DSpatialControl[];
  opacityAuthored: boolean;
  opacityObservable: boolean;
  opacityPhaseUnits: typeof referenceMediaCamera2DOpacityPhaseUnits;
  signalsProved: readonly Readonly<{
    property: ReferenceMediaCamera2DSpatialControl | "opacity";
    signalId: string;
    kind: IRSignal["kind"];
  }>[];
  signalItemsProved: readonly Readonly<{
    property: ReferenceMediaCamera2DSpatialControl | "opacity";
    signalId: string;
    kind: "set" | "animate" | "point" | "keyframe";
    index: number;
  }>[];
  edgeAuthored: boolean;
  edgeObservable: boolean;
}>;

const controlDefaults: Readonly<Record<ReferenceMediaCamera2DSpatialControl | "opacity", number>> = Object.freeze(
  Object.fromEntries(Object.entries(cutMediaCamera2DControlDefaults).map(([property, value]) => [
    property,
    rationalToNumber(value),
  ])) as Record<ReferenceMediaCamera2DSpatialControl | "opacity", number>,
);

function fail(
  node: IRNode,
  code: ReferenceMediaCamera2DObservabilityDiagnosticCode,
  detail: string,
): never {
  throw new ReferenceMediaCamera2DObservabilityError(code, node, detail);
}

function q16Number(node: IRNode, value: number, label: string) {
  if (!Number.isFinite(value)) fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", `${label} is not finite.`);
  const scaled = Math.round(value * referenceMediaCamera2DPhaseUnits);
  if (!Number.isSafeInteger(scaled)) {
    fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", `${label} cannot be represented as a safe Q16 value.`);
  }
  return scaled / referenceMediaCamera2DPhaseUnits;
}

function q16(value: number) {
  return String(Math.round(value * referenceMediaCamera2DPhaseUnits));
}

/** Normative camera opacity code used by both admission and execution. The
 * sampler applies phase/255, never the unquantized authored float. */
export function referenceMediaCamera2DOpacityPhase(node: IRNode, opacity: number) {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    fail(node, "CUT_MEDIA_CAMERA_INPUT", "resolved opacity must remain between zero and one before Q8 planning.");
  }
  return Math.round(opacity * referenceMediaCamera2DOpacityPhaseUnits);
}

function finitePositiveInteger(node: IRNode, value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(node, "CUT_MEDIA_CAMERA_INPUT", `${label} must be a positive safe integer.`);
  }
  return value;
}

/**
 * The exact Q16 source-to-delivery matrix used by MediaCamera2D. Keeping this
 * pure function outside the decoder/runtime state lets locked admission prove
 * whether authored controls can reach a distinct executed grid before any
 * source path is copied or opened.
 */
export function referenceMediaCamera2DQuantizedAffine(
  node: IRNode,
  grid: ReferenceMediaCamera2DObservabilityGrid,
  controls: ReferenceMediaCamera2DSpatialControls,
): ReferenceMediaCamera2DQuantizedAffine {
  const sourceWidth = finitePositiveInteger(node, grid.source.width, "locked post-crop width");
  const sourceHeight = finitePositiveInteger(node, grid.source.height, "locked post-crop height");
  const outputWidth = finitePositiveInteger(node, grid.output.width, "delivery width");
  const outputHeight = finitePositiveInteger(node, grid.output.height, "delivery height");
  if (grid.fit !== "cover" && grid.fit !== "contain" && grid.fit !== "fill") {
    fail(node, "CUT_MEDIA_CAMERA_INPUT", "fit must be exactly cover, contain, or fill.");
  }
  if (grid.edge !== "transparent" && grid.edge !== "clamp") {
    fail(node, "CUT_MEDIA_CAMERA_INPUT", "edge must be exactly transparent or clamp.");
  }
  const values = [controls.focusX, controls.focusY, controls.zoom, controls.rotationDegrees];
  if (values.some((value) => !Number.isFinite(value))) {
    fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", "resolved spatial controls must be finite before Q16 planning.");
  }

  const outputCenterX = (outputWidth - 1) / 2;
  const outputCenterY = (outputHeight - 1) / 2;
  const uniform = grid.fit === "contain"
    ? Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight)
    : Math.max(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const baseScaleX = grid.fit === "fill" ? outputWidth / sourceWidth : uniform;
  const baseScaleY = grid.fit === "fill" ? outputHeight / sourceHeight : uniform;
  const focusSourceX = controls.focusX * (sourceWidth - 1);
  const focusSourceY = controls.focusY * (sourceHeight - 1);
  const zoomA = controls.zoom * baseScaleX;
  const zoomD = controls.zoom * baseScaleY;
  const radians = controls.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const affine = Object.freeze({
    a: q16Number(node, cosine * zoomA, "matrix.a"),
    b: q16Number(node, sine * zoomA, "matrix.b"),
    c: q16Number(node, -sine * zoomD, "matrix.c"),
    d: q16Number(node, cosine * zoomD, "matrix.d"),
    tx: q16Number(
      node,
      outputCenterX - cosine * zoomA * focusSourceX + sine * zoomD * focusSourceY,
      "matrix.tx",
    ),
    ty: q16Number(
      node,
      outputCenterY - sine * zoomA * focusSourceX - cosine * zoomD * focusSourceY,
      "matrix.ty",
    ),
  });
  const determinant = affine.a * affine.d - affine.b * affine.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1 / referenceMediaCamera2DPhaseUnits ** 2) {
    fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", "source-to-delivery matrix is singular after Q16 quantization.");
  }
  return affine;
}

export function referenceMediaCamera2DQ16Affine(
  node: IRNode,
  grid: ReferenceMediaCamera2DObservabilityGrid,
  controls: ReferenceMediaCamera2DSpatialControls,
): ReferenceMediaCamera2DQ16Affine {
  const affine = referenceMediaCamera2DQuantizedAffine(node, grid, controls);
  return Object.freeze({
    a: q16(affine.a), b: q16(affine.b), c: q16(affine.c),
    d: q16(affine.d), tx: q16(affine.tx), ty: q16(affine.ty),
  });
}

export function referenceMediaCamera2DInverseAffine(affine: ReferenceMediaCamera2DQuantizedAffine) {
  const determinant = affine.a * affine.d - affine.b * affine.c;
  return Object.freeze({
    a: affine.d / determinant,
    b: -affine.b / determinant,
    c: -affine.c / determinant,
    d: affine.a / determinant,
    tx: (affine.c * affine.ty - affine.d * affine.tx) / determinant,
    ty: (affine.b * affine.tx - affine.a * affine.ty) / determinant,
  });
}

export function referenceMediaCamera2DClampPadding(
  affine: ReferenceMediaCamera2DQuantizedAffine,
  source: Readonly<{ width: number; height: number }>,
  output: Readonly<{ width: number; height: number }>,
) {
  const transform = referenceMediaCamera2DInverseAffine(affine);
  const apply = (x: number, y: number) => Object.freeze({
    x: transform.a * x + transform.c * y + transform.tx,
    y: transform.b * x + transform.d * y + transform.ty,
  });
  const corners = [
    apply(0, 0),
    apply(output.width - 1, 0),
    apply(output.width - 1, output.height - 1),
    apply(0, output.height - 1),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return Object.freeze({
    left: Math.max(0, -Math.floor(Math.min(...xs))),
    top: Math.max(0, -Math.floor(Math.min(...ys))),
    right: Math.max(0, Math.ceil(Math.max(...xs)) - (source.width - 1)),
    bottom: Math.max(0, Math.ceil(Math.max(...ys)) - (source.height - 1)),
  });
}

function quantity(node: IRNode, value: IRValue | undefined, property: ReferenceMediaCamera2DSpatialControl | "opacity") {
  const fallback = controlDefaults[property];
  if (value === undefined || value.kind === "null") return fallback;
  if (value.kind !== "quantity") fail(node, "CUT_MEDIA_CAMERA_INPUT", `${property} must be a canonical quantity.`);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_MEDIA_CAMERA_INPUT", `${property} must resolve to a finite quantity.`);
  return result;
}

function resolved(
  ir: CutAVIR,
  node: IRNode,
  property: ReferenceMediaCamera2DSpatialControl | "opacity",
  time: Rational,
) {
  const sampled = propertyAt(ir, node, property, time);
  // A track `initial: null` is the runtime-default sentinel. The compiler
  // materializes an authored constructor baseline into the track whenever it
  // must survive before the first event, so falling back to node.inputs here
  // would let a hostile loaded IR execute different geometry in admission and
  // the real frame planner.
  return quantity(node, sampled?.kind === "null" ? undefined : sampled ?? node.inputs[property], property);
}

function ceilRational(value: Rational) {
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  return numerator >= 0n ? (numerator + denominator - 1n) / denominator : numerator / denominator;
}

function referenceMediaCamera2DObservabilityFrameRange(
  composition: IRComposition,
  node: IRNode,
  maximumSamples: number = referenceMediaCamera2DObservabilityLimits.maximumOutputFrameSamplesPerCamera,
) {
  if (!Number.isSafeInteger(maximumSamples) || maximumSamples < 1
    || maximumSamples > referenceMediaCamera2DObservabilityLimits.maximumOutputFrameSamplesPerCamera) {
    fail(node, "CUT_MEDIA_CAMERA_LIMIT", "Q16 observability sample allowance is outside the closed per-camera bound.");
  }
  const startFrame = ceilRational(multiplyRational(node.interval.start, composition.fps));
  const endFrame = ceilRational(multiplyRational(addRational(node.interval.start, node.interval.duration), composition.fps));
  const count = endFrame - startFrame;
  if (count < 1n) fail(node, "CUT_MEDIA_CAMERA_INPUT", "has no exact output-frame sample in its half-open interval.");
  if (count > BigInt(maximumSamples)) {
    fail(
      node,
      "CUT_MEDIA_CAMERA_LIMIT",
      `requires ${count} Q16 observability samples; the closed per-camera bound is ${maximumSamples}.`,
    );
  }
  return Object.freeze({ startFrame, endFrame, count: Number(count) });
}

/** Exact ordinary output-frame samples in the camera's half-open interval. */
export function referenceMediaCamera2DObservabilityTimes(
  composition: IRComposition,
  node: IRNode,
  maximumSamples: number = referenceMediaCamera2DObservabilityLimits.maximumOutputFrameSamplesPerCamera,
) {
  const { startFrame, endFrame } = referenceMediaCamera2DObservabilityFrameRange(
    composition,
    node,
    maximumSamples,
  );
  const result: Rational[] = [];
  for (let frame = startFrame; frame < endFrame; frame += 1n) {
    result.push(divideRational(rational(frame), composition.fps));
  }
  return Object.freeze(result);
}

function authoredControl(
  node: IRNode,
  property: ReferenceMediaCamera2DSpatialControl | "opacity",
) {
  if (node.properties[property] !== undefined) return true;
  const input = node.inputs[property];
  if (input === undefined) return false;
  if (input.kind !== "quantity") return true; // the strict camera input validator owns the stable type failure
  return compareRational(input.magnitude, cutMediaCamera2DControlDefaults[property]) !== 0;
}

function controlsAt(ir: CutAVIR, node: IRNode, time: Rational): ReferenceMediaCamera2DSpatialControls {
  return Object.freeze({
    focusX: resolved(ir, node, "focusX", time),
    focusY: resolved(ir, node, "focusY", time),
    zoom: resolved(ir, node, "zoom", time),
    rotationDegrees: resolved(ir, node, "rotation", time),
  });
}

function authoredControlIdentity(ir: CutAVIR, node: IRNode) {
  const properties = Object.fromEntries(
    [...Object.entries(node.properties)]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, Object.freeze({
        value,
        ...(value && "signal" in value ? {
          signalExecutableIdentity: ir.signals[value.signal]
            ? cutSignalContentHash(ir.signals[value.signal]!)
            : undefined,
        } : {}),
      })]),
  );
  return hash(Object.freeze({
    op: node.op,
    inputs: node.inputs,
    properties,
  }));
}

type ProvedSignalItem = ReferenceMediaCamera2DObservabilityReport["signalItemsProved"][number];

function controlSignals(ir: CutAVIR, node: IRNode) {
  const result: Array<Readonly<{
    property: ReferenceMediaCamera2DSpatialControl | "opacity";
    signal: IRSignal;
  }>> = [];
  for (const property of ["focusX", "focusY", "zoom", "rotation", "opacity"] as const) {
    const attached = node.properties[property];
    if (!attached || !("signal" in attached)) continue;
    const signal = ir.signals[attached.signal];
    if (!signal) fail(node, "CUT_MEDIA_CAMERA_INPUT", `${property} references missing signal ${attached.signal}.`);
    result.push(Object.freeze({ property, signal }));
  }
  return Object.freeze(result);
}

function signalItems(signals: ReturnType<typeof controlSignals>) {
  const result: Array<Readonly<{ property: ReferenceMediaCamera2DSpatialControl | "opacity"; signal: IRSignal; item: ProvedSignalItem }>> = [];
  for (const { property, signal } of signals) {
    for (let index = 0; index < referenceSignalItemCount(signal); index += 1) {
      const kind = signal.kind === "track"
        ? signal.events[index]!.kind
        : signal.kind === "step"
          ? "point" as const
          : "keyframe" as const;
      result.push(Object.freeze({
        property,
        signal,
        item: Object.freeze({ property, signalId: signal.id, kind, index }),
      }));
    }
  }
  return Object.freeze(result);
}

function executedBackendPlanKey(
  ir: CutAVIR,
  node: IRNode,
  grid: ReferenceMediaCamera2DObservabilityGrid,
  time: Rational,
) {
  const opacityPhase = referenceMediaCamera2DOpacityPhase(node, resolved(ir, node, "opacity", time));
  if (opacityPhase === 0) return `opacity:${opacityPhase};hidden`;
  return executedBackendPlanKeyFromControls(node, grid, controlsAt(ir, node, time), opacityPhase);
}

function witnessAxis(length: number) {
  const last = length - 1;
  return [...new Set([0, Math.floor(last / 4), Math.floor(last / 2), Math.floor(last * 3 / 4), last])].sort((a, b) => a - b);
}

function witnessPixelCount(grid: ReferenceMediaCamera2DObservabilityGrid) {
  return witnessAxis(grid.output.width).length * witnessAxis(grid.output.height).length;
}

/** Content-independent linear sampling operator at a fixed bounded lattice of
 * real output pixel centres. Equality means the same original source taps and
 * exact Q16 bilinear weights, not merely similar affine coefficients. Failure
 * to find a witness is a conservative rejection, never an unproved accept. */
function executedBackendPlanKeyFromControls(
  node: IRNode,
  grid: ReferenceMediaCamera2DObservabilityGrid,
  controls: ReferenceMediaCamera2DSpatialControls,
  opacityPhase: number,
) {
  const affine = referenceMediaCamera2DQuantizedAffine(node, grid, controls);
  const padding = grid.edge === "clamp"
    ? referenceMediaCamera2DClampPadding(affine, grid.source, grid.output)
    : Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
  const samplingAffine = grid.edge === "clamp"
    ? Object.freeze({
      ...affine,
      tx: affine.tx - affine.a * padding.left - affine.c * padding.top,
      ty: affine.ty - affine.b * padding.left - affine.d * padding.top,
    })
    : affine;
  const samplingTransform = referenceRetainedMediaViewportQ16SamplingTransform(samplingAffine);
  if (!samplingTransform) fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", "source-to-delivery matrix is singular in the shared Q16 sampler kernel.");
  const pixels: string[] = [];
  for (const y of witnessAxis(grid.output.height)) for (const x of witnessAxis(grid.output.width)) {
    const taps = referenceRetainedMediaViewportQ16BilinearTapsAt(samplingTransform, x, y);
    const contributions = new Map<string, number>();
    for (const [weight, paddedTapX, paddedTapY] of taps) {
      if (weight === 0) continue;
      const tapX = paddedTapX - padding.left, tapY = paddedTapY - padding.top;
      if (grid.edge === "transparent"
        && (tapX < 0 || tapY < 0 || tapX >= grid.source.width || tapY >= grid.source.height)) continue;
      const sourceX = grid.edge === "clamp" ? Math.max(0, Math.min(grid.source.width - 1, tapX)) : tapX;
      const sourceY = grid.edge === "clamp" ? Math.max(0, Math.min(grid.source.height - 1, tapY)) : tapY;
      const key = `${sourceX},${sourceY}`;
      contributions.set(key, (contributions.get(key) ?? 0) + weight);
    }
    pixels.push(`${x},${y}:${[...contributions].sort(([left], [right]) => left.localeCompare(right)).map(([key, weight]) => `${key}@${weight}`).join("|")}`);
  }
  return `opacity:${opacityPhase};samples:${pixels.join(";")}`;
}

/**
 * Prove every authored spatial control and non-default edge policy reaches a
 * distinct executed sampling plan on a preregistered bounded lattice of real
 * output pixels. A changed shared-kernel tap/weight is a positive proof;
 * changes outside the lattice are conservatively refused rather than accepted.
 */
export function validateReferenceMediaCamera2DQ16Observability(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  grid: ReferenceMediaCamera2DObservabilityGrid,
  options: Readonly<{ maximumWorkUnits?: number }> = {},
): ReferenceMediaCamera2DObservabilityReport {
  if (node.op !== "cut.visual.media_camera2d") {
    fail(node, "CUT_MEDIA_CAMERA_INPUT", "Q16 observability requires one MediaCamera2D node.");
  }
  if (Object.keys(options).some((key) => key !== "maximumWorkUnits")) {
    fail(node, "CUT_MEDIA_CAMERA_INPUT", "Q16 observability options contain an unknown property.");
  }
  const maximumWork = options.maximumWorkUnits
    ?? referenceMediaCamera2DObservabilityLimits.maximumWorkUnitsPerComposition;
  if (!Number.isSafeInteger(maximumWork) || maximumWork < 0
    || maximumWork > referenceMediaCamera2DObservabilityLimits.maximumWorkUnitsPerComposition) {
    fail(node, "CUT_MEDIA_CAMERA_LIMIT", "sampler-observability work allowance is outside the closed composition bound.");
  }
  const frameRange = referenceMediaCamera2DObservabilityFrameRange(composition, node);
  const signals = controlSignals(ir, node);
  let itemCount = 0;
  for (const { signal } of signals) {
    const next = itemCount + referenceSignalItemCount(signal);
    if (!Number.isSafeInteger(next)) fail(node, "CUT_MEDIA_CAMERA_LIMIT", "signal-item observability count exceeds safe integer accounting.");
    itemCount = next;
  }
  const authored = (["focusX", "focusY", "zoom", "rotation"] as const)
    .filter((property) => authoredControl(node, property));
  const opacityAuthored = authoredControl(node, "opacity");
  const witnessPixelsPerPlan = witnessPixelCount(grid);
  const planEvaluationsPerSample = 1 + signals.length + itemCount + authored.length
    + Number(opacityAuthored) + Number(grid.edge === "clamp");
  const planEvaluationsBig = BigInt(frameRange.count) * BigInt(planEvaluationsPerSample);
  const workUnitsBig = planEvaluationsBig * BigInt(witnessPixelsPerPlan);
  if (workUnitsBig > BigInt(maximumWork) || planEvaluationsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(
      node,
      "CUT_MEDIA_CAMERA_LIMIT",
      `requires ${workUnitsBig} Q16/Q8 sampler-observability work units for ${planEvaluationsBig} worst-case plan evaluations across ${frameRange.count} output samples and ${witnessPixelsPerPlan} real witness pixels per plan; ${maximumWork} remain in the bounded composition admission budget.`,
    );
  }
  const planEvaluations = Number(planEvaluationsBig), workUnits = Number(workUnitsBig);
  const times = referenceMediaCamera2DObservabilityTimes(composition, node);
  const items = signalItems(signals);
  if (times.every((time) => referenceMediaCamera2DOpacityPhase(node, resolved(ir, node, "opacity", time)) === 0)) {
    fail(
      node,
      "CUT_MEDIA_CAMERA_NOOP",
      `opacity quantizes to Q8 phase zero at all ${times.length} locked output-frame samples, so the camera performs no decode or resample and remains transparent for its complete interval.`,
    );
  }
  const actualBackendPlans = times.map((time) => executedBackendPlanKey(ir, node, grid, time));
  for (const { property, signal } of signals) {
    const properties = { ...node.properties };
    Reflect.deleteProperty(properties, property);
    const candidateNode: IRNode = { ...node, properties };
    const candidateIr: CutAVIR = { ...ir, nodes: { ...ir.nodes, [node.id]: candidateNode } };
    if (times.every((time, index) => executedBackendPlanKey(candidateIr, candidateNode, grid, time) === actualBackendPlans[index])) {
      fail(
        node,
        "CUT_MEDIA_CAMERA_NOOP",
        `authored ${property} signal ${signal.id} never changes the executed Q16 affine, Q8 opacity, or edge-padding plan at any locked output-frame sample relative to the signal-free constructor/default.`,
      );
    }
  }
  for (const { property, signal, item } of items) {
    const counterfactual = referenceSignalWithItemRemoved(signal, item.index);
    if (!counterfactual) continue;
    const candidateIr: CutAVIR = { ...ir, signals: { ...ir.signals, [signal.id]: counterfactual } };
    if (times.every((time, index) => executedBackendPlanKey(candidateIr, node, grid, time) === actualBackendPlans[index])) {
      const path = signal.kind === "track"
        ? `events[${item.index}]`
        : signal.kind === "step"
          ? `points[${item.index}]`
          : `keyframes[${item.index}]`;
      fail(
        node,
        "CUT_MEDIA_CAMERA_NOOP",
        `authored ${property} signal ${signal.id}.${path} ${item.kind} never changes the executed Q16 affine, Q8 opacity, or edge-padding plan at any locked output-frame sample when that item is removed.`,
      );
    }
  }
  const observable = new Set<ReferenceMediaCamera2DSpatialControl>();
  let opacityObservable = false;
  let hasVisibleOpacityPhase = false;
  let edgeObservable = false;
  for (const time of times) {
    const opacity = resolved(ir, node, "opacity", time);
    const opacityPhase = referenceMediaCamera2DOpacityPhase(node, opacity);
    if (opacityPhase !== referenceMediaCamera2DOpacityPhaseUnits) opacityObservable = true;
    // If a full-alpha byte quantizes to zero, every bounded source alpha does
    // too. Spatial geometry and clamp policy are then causally unobservable.
    if (opacityPhase === 0) continue;
    hasVisibleOpacityPhase = true;
    const controls = controlsAt(ir, node, time);
    const actual = executedBackendPlanKeyFromControls(node, grid, controls, opacityPhase);
    for (const property of authored) {
      if (observable.has(property)) continue;
      const counterfactual = Object.freeze({
        ...controls,
        ...(property === "rotation"
          ? { rotationDegrees: controlDefaults.rotation }
          : { [property]: controlDefaults[property] }),
      }) as ReferenceMediaCamera2DSpatialControls;
      if (actual !== executedBackendPlanKeyFromControls(node, grid, counterfactual, opacityPhase)) {
        observable.add(property);
      }
    }
    if (grid.edge === "clamp" && !edgeObservable) {
      edgeObservable = actual !== executedBackendPlanKeyFromControls(
        node,
        Object.freeze({ ...grid, edge: "transparent" as const }),
        controls,
        opacityPhase,
      );
    }
  }
  for (const property of authored) {
    if (!observable.has(property)) {
      fail(
        node,
        "CUT_MEDIA_CAMERA_NOOP",
        `authored ${property} has no changed shared-kernel tap/weight witness against its default on the preregistered output-pixel lattice at any of ${times.length} locked output-frame samples; remove it or author a change with an admitted executed witness.`,
      );
    }
  }
  if (opacityAuthored && !opacityObservable) {
    fail(
      node,
      "CUT_MEDIA_CAMERA_NOOP",
      `authored opacity preserves the default Q8 opacity phase at all ${times.length} locked output-frame samples; remove it or author a change large enough to execute in the RGBA8 opacity stage.`,
    );
  }
  if (!hasVisibleOpacityPhase) {
    fail(
      node,
      "CUT_MEDIA_CAMERA_NOOP",
      `opacity quantizes to Q8 phase zero at all ${times.length} locked output-frame samples, so the camera performs no decode or resample and remains transparent for its complete interval.`,
    );
  }
  if (grid.edge === "clamp" && !edgeObservable) {
    fail(
      node,
      "CUT_MEDIA_CAMERA_NOOP",
      `edge clamp has no changed shared-kernel tap/weight witness against transparent on the preregistered output-pixel lattice at any of ${times.length} locked output-frame samples; remove it or author geometry with an admitted executed witness.`,
    );
  }
  return Object.freeze({
    format: "cut-reference-media-camera2d-q16-observability",
    version: 1,
    algorithmVersion: referenceMediaCamera2DObservabilityAlgorithmVersion,
    cameraNodeId: node.id,
    authoredControlIdentity: authoredControlIdentity(ir, node),
    samples: times.length,
    workUnits,
    witnessPixelsPerPlan,
    planEvaluations,
    grid: Object.freeze({
      source: Object.freeze({ ...grid.source }),
      output: Object.freeze({ ...grid.output }),
      fit: grid.fit,
      edge: grid.edge,
    }),
    authoredSpatialControls: Object.freeze([...authored]),
    observableSpatialControls: Object.freeze([...observable].sort()),
    opacityAuthored,
    opacityObservable,
    opacityPhaseUnits: referenceMediaCamera2DOpacityPhaseUnits,
    signalsProved: Object.freeze(signals.map(({ property, signal }) => Object.freeze({
      property,
      signalId: signal.id,
      kind: signal.kind,
    }))),
    signalItemsProved: Object.freeze(items.map(({ item }) => item)),
    edgeAuthored: grid.edge === "clamp",
    edgeObservable,
  });
}
