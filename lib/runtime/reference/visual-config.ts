import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import { rationalToNumber, type Rational } from "../../language/rational";
import { propertyAt, type ReferencePreparedSignalResolver } from "./signals";

export type ReferenceVisualConfigErrorCode =
  | "CUT_VISUAL_INPUT_TYPE"
  | "CUT_VISUAL_INPUT_ENUM"
  | "CUT_VISUAL_INPUT_COMBINATION"
  | "CUT_VISUAL_VALUE_RANGE";

export class ReferenceVisualConfigError extends Error {
  constructor(readonly code: ReferenceVisualConfigErrorCode, readonly nodeId: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceVisualConfigError";
  }
}

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(node: IRNode, code: ReferenceVisualConfigErrorCode, message: string): never {
  throw new ReferenceVisualConfigError(code, node.id, `${node.op} at ${location(node)} ${message}`);
}

type LabeledVisualValue = { value: IRValue; label: string };

function signalValues(signal: IRSignal, prefix: string): LabeledVisualValue[] {
  if (signal.kind === "constant") return [{ value: signal.value, label: `${prefix}.value` }];
  if (signal.kind === "step") return signal.points.map((point, index) => ({ value: point.value, label: `${prefix}.points[${index}].value` }));
  if (signal.kind === "keyframes") return signal.keyframes.map((keyframe, index) => ({ value: keyframe.value, label: `${prefix}.keyframes[${index}].value` }));
  return [
    { value: signal.initial, label: `${prefix}.initial` },
    ...signal.events.flatMap((event, index) => event.kind === "set"
      ? [{ value: event.value, label: `${prefix}.events[${index}].value` }]
      : [
        { value: event.from, label: `${prefix}.events[${index}].from` },
        { value: event.to, label: `${prefix}.events[${index}].to` },
      ]),
  ];
}

function propertyValues(ir: CutAVIR, node: IRNode, name: string) {
  const property = node.properties[name];
  if (!property) return [];
  if (!("signal" in property)) return [{ value: property, label: `property “${name}”` }];
  const signal = ir.signals[property.signal];
  if (!signal) fail(node, "CUT_VISUAL_INPUT_TYPE", `property “${name}” references missing signal ${property.signal}.`);
  return signalValues(signal, `property “${name}” signal ${property.signal}`);
}

function checkedQuantity(
  node: IRNode,
  label: string,
  value: IRValue | undefined,
  dimension: "length" | "ratio" | "scalar" | "angle",
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (value === undefined || value.kind === "null") return fallback;
  const unit = { length: "px", ratio: "ratio", scalar: "scalar", angle: "deg" }[dimension];
  if (value.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail(node, "CUT_VISUAL_INPUT_TYPE", `${label} must be a canonical ${dimension} quantity in ${unit}.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < minimum || result > maximum) fail(node, "CUT_VISUAL_VALUE_RANGE", `${label} must be between ${minimum} and ${maximum}.`);
  return result;
}

function maximumScale(composition: IRComposition) {
  const maxDimension = Math.min(8, 16_384 / composition.width, 16_384 / composition.height);
  const maxPixels = Math.sqrt(67_108_864 / (composition.width * composition.height));
  return Math.max(0.001, Math.min(maxDimension, maxPixels));
}

export type ReferenceVisualTransform = {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  scale: number;
  skewX: number;
  skewY: number;
  rotation: number;
  opacity: number;
};

type ReferenceVisualTransformControl = keyof ReferenceVisualTransform;

/**
 * Same spelling does not imply compositor ownership. These controls belong to
 * a closed kernel-specific executor and must not also be sampled as an outer
 * visual transform. Keeping this list beside the generic resolver makes a new
 * collision fail review in one place instead of relying on a post-render reset.
 *
 * Context-dependent retained MapCamera children are deliberately absent: their
 * standalone form owns the ordinary compositor controls, while MapCamera
 * consumes the retained form before it can reach this resolver.
 */
const nonCompositorControls = (...controls: ReferenceVisualTransformControl[]) => Object.freeze(controls);
const referenceNonCompositorControls: Readonly<Record<string, readonly ReferenceVisualTransformControl[]>> = Object.freeze({
  "cut.geo.annotation": nonCompositorControls("opacity"),
  "cut.geo.globe": nonCompositorControls("rotation"),
  "cut.geo.map_camera": nonCompositorControls("scale"),
  "cut.visual.glow": nonCompositorControls("opacity"),
  "cut.visual.parallax_camera": nonCompositorControls("x", "y"),
  "cut.visual.shadow": nonCompositorControls("x", "y", "opacity"),
});

function referenceCompositorControlValue(
  ir: CutAVIR,
  node: IRNode,
  name: ReferenceVisualTransformControl,
  time: Rational,
  input: IRValue | undefined,
  resolver?: ReferencePreparedSignalResolver,
) {
  if (referenceNonCompositorControls[node.op]?.includes(name)) return undefined;
  return propertyAt(ir, node, name, time, resolver) ?? input;
}

export function validateReferenceVisualTransformAllocation(node: IRNode, composition: IRComposition, transform: ReferenceVisualTransform) {
  const radians = Math.PI / 180;
  const scaledWidth = Math.max(1, Math.round(composition.width * transform.scale));
  const scaledHeight = Math.max(1, Math.round(composition.height * transform.scale));
  const shearedWidth = scaledWidth + Math.abs(Math.tan(transform.skewX * radians)) * scaledHeight;
  const shearedHeight = scaledHeight + Math.abs(Math.tan(transform.skewY * radians)) * scaledWidth;
  const normalizedRotation = ((transform.rotation % 360) + 360) % 360;
  const cosine = Math.abs(Math.cos(normalizedRotation * radians));
  const sine = Math.abs(Math.sin(normalizedRotation * radians));
  const outputWidth = Math.ceil(cosine * shearedWidth + sine * shearedHeight);
  const outputHeight = Math.ceil(sine * shearedWidth + cosine * shearedHeight);
  if (outputWidth > 16_384 || outputHeight > 16_384 || outputWidth * outputHeight > 67_108_864) {
    fail(node, "CUT_VISUAL_VALUE_RANGE", `combined scale/skew/rotation would allocate an intermediate larger than 16384px on an axis or 67108864 pixels (estimated ${outputWidth}x${outputHeight}).`);
  }
}

export function validateReferenceVisualTransform(ir: CutAVIR, composition: IRComposition, node: IRNode) {
  // MapCamera.scale is geographic camera zoom, not a compositor transform.
  // Its closed [0.25, 64] contract and sampled allocation-free execution are
  // validated by map-camera.ts; the visual renderer consumes MapCamera before
  // the generic transform path. Applying the shared visual-scale ceiling here
  // would incorrectly reject valid regional camera states such as scale 15.
  if (node.op === "cut.geo.map_camera") return;
  const scaleMaximum = maximumScale(composition);
  const contracts = [
    ["x", "length", -65_536, 65_536, 0],
    ["y", "length", -65_536, 65_536, 0],
    ["anchorX", "length", -65_536, 65_536, 0],
    ["anchorY", "length", -65_536, 65_536, 0],
    ["scale", "scalar", 0.001, scaleMaximum, 1],
    ["skewX", "angle", -30, 30, 0],
    ["skewY", "angle", -30, 30, 0],
    ["rotation", "angle", -360_000, 360_000, 0],
    ["opacity", "ratio", 0, 1, 1],
  ] as const;
  for (const [name, dimension, minimum, maximum, fallback] of contracts) {
    if (node.inputs[name] !== undefined) checkedQuantity(node, `input “${name}”`, node.inputs[name], dimension, minimum, maximum, fallback);
    for (const item of propertyValues(ir, node, name)) checkedQuantity(node, item.label, item.value, dimension, minimum, maximum, fallback);
  }
}

export function referenceVisualTransformAt(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  time: Rational,
  options: { staticPosition: boolean; staticRotation: boolean },
  resolver?: ReferencePreparedSignalResolver,
): ReferenceVisualTransform {
  const scaleMaximum = maximumScale(composition);
  const transform = {
    x: checkedQuantity(node, "executed x", referenceCompositorControlValue(ir, node, "x", time, options.staticPosition ? node.inputs.x : undefined, resolver), "length", -65_536, 65_536, 0),
    y: checkedQuantity(node, "executed y", referenceCompositorControlValue(ir, node, "y", time, options.staticPosition ? node.inputs.y : undefined, resolver), "length", -65_536, 65_536, 0),
    anchorX: checkedQuantity(node, "executed anchorX", referenceCompositorControlValue(ir, node, "anchorX", time, node.inputs.anchorX, resolver), "length", -65_536, 65_536, 0),
    anchorY: checkedQuantity(node, "executed anchorY", referenceCompositorControlValue(ir, node, "anchorY", time, node.inputs.anchorY, resolver), "length", -65_536, 65_536, 0),
    scale: checkedQuantity(node, "executed scale", referenceCompositorControlValue(ir, node, "scale", time, node.inputs.scale, resolver), "scalar", 0.001, scaleMaximum, 1),
    skewX: checkedQuantity(node, "executed skewX", referenceCompositorControlValue(ir, node, "skewX", time, node.inputs.skewX, resolver), "angle", -30, 30, 0),
    skewY: checkedQuantity(node, "executed skewY", referenceCompositorControlValue(ir, node, "skewY", time, node.inputs.skewY, resolver), "angle", -30, 30, 0),
    rotation: checkedQuantity(node, "executed rotation", referenceCompositorControlValue(ir, node, "rotation", time, options.staticRotation ? node.inputs.rotation : undefined, resolver), "angle", -360_000, 360_000, 0),
    opacity: checkedQuantity(node, "executed opacity", referenceCompositorControlValue(ir, node, "opacity", time, node.inputs.opacity, resolver), "ratio", 0, 1, 1),
  };
  validateReferenceVisualTransformAllocation(node, composition, transform);
  return transform;
}

function coordinate(node: IRNode, input: string, value: IRValue | undefined) {
  if (value?.kind !== "quantity" || (value.dimension !== "scalar" && value.dimension !== "angle")) fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}” must be a scalar or angle quantity.`);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_VISUAL_VALUE_RANGE", `input “${input}” must be finite.`);
  return result;
}

function validateGeoPoint(node: IRNode, input: string, value: IRValue | undefined, allowLabel: boolean) {
  if (value?.kind !== "object") fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}” must be a GeoPoint object.`);
  const allowed = new Set(["latitude", "longitude", ...(allowLabel ? ["label"] : [])]), keys = Object.keys(value.entries);
  if (keys.some((key) => !allowed.has(key)) || !keys.includes("latitude") || !keys.includes("longitude")) {
    fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}” must contain exactly latitude, longitude${allowLabel ? ", and optional label" : ""}.`);
  }
  const latitude = coordinate(node, `${input}.latitude`, value.entries.latitude), longitude = coordinate(node, `${input}.longitude`, value.entries.longitude);
  if (latitude < -90 || latitude > 90) fail(node, "CUT_VISUAL_VALUE_RANGE", `input “${input}.latitude” must be between -90 and 90 degrees.`);
  if (longitude < -180 || longitude > 180) fail(node, "CUT_VISUAL_VALUE_RANGE", `input “${input}.longitude” must be between -180 and 180 degrees.`);
  if (value.entries.label !== undefined && value.entries.label.kind !== "string") fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}.label” must be a String.`);
}

function validateGeoPointList(node: IRNode, input: string, value: IRValue | undefined, minimum: number, maximum: number) {
  if (value?.kind !== "array") fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}” must be a List<GeoPoint>.`);
  if (value.items.length < minimum || value.items.length > maximum) fail(node, "CUT_VISUAL_VALUE_RANGE", `input “${input}” must contain ${minimum} through ${maximum} points.`);
  value.items.forEach((point, index) => validateGeoPoint(node, `${input}[${index}]`, point, false));
}

function validateColor(node: IRNode, input: string) {
  const value = node.inputs[input];
  if (value !== undefined && value.kind !== "color") fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}” must be a canonical Color.`);
}

function validateDataResource(ir: CutAVIR, node: IRNode, input: string) {
  const value = node.inputs[input]; if (value === undefined) return;
  if (value.kind !== "resource-ref" || ir.resources[value.id]?.kind !== "data") fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}” must reference a DataAsset.`);
}

function validateOptionalQuantity(node: IRNode, input: string, dimension: "length" | "ratio" | "scalar" | "angle", minimum: number, maximum: number) {
  const value = node.inputs[input];
  if (value !== undefined) checkedQuantity(node, `input “${input}”`, value, dimension, minimum, maximum, minimum);
}

export function validateReferenceVisualReveal(ir: CutAVIR, node: IRNode) {
  if (node.inputs.reveal === undefined && node.properties.reveal === undefined) return;
  validateOptionalQuantity(node, "reveal", "ratio", 0, 1);
  for (const item of propertyValues(ir, node, "reveal")) checkedQuantity(node, item.label, item.value, "ratio", 0, 1, 1);
}

function validateInteger(node: IRNode, input: string, minimum: number, maximum: number) {
  const value = node.inputs[input]; if (value === undefined) return;
  const number = checkedQuantity(node, `input “${input}”`, value, "scalar", minimum, maximum, minimum);
  if (!Number.isInteger(number)) fail(node, "CUT_VISUAL_VALUE_RANGE", `input “${input}” must be an integer from ${minimum} through ${maximum}.`);
}

export type ReferenceWavefrontProjection = "canvas" | "map" | "globe";

/** Resolve Wavefront without accepting an input the selected projection ignores. */
export function referenceWavefrontProjection(node: IRNode): ReferenceWavefrontProjection | undefined {
  if (node.op !== "cut.geo.wavefront") return undefined;
  const authored = node.inputs.projection;
  if (authored !== undefined && authored.kind !== "string") fail(node, "CUT_VISUAL_INPUT_TYPE", "input “projection” must be a String.");
  const value = authored?.kind === "string" ? authored.value : undefined;
  if (value !== undefined && value !== "canvas" && value !== "map" && value !== "globe") fail(node, "CUT_VISUAL_INPUT_ENUM", "input “projection” must be one of: canvas, map, globe.");
  const projection: ReferenceWavefrontProjection = value ?? (node.inputs.origin === undefined ? "canvas" : "map");
  const forbidden = projection === "canvas"
    ? ["origin", "globeRotation", "globeTilt", "globeX", "globeY", "globeRadius"]
    : projection === "map"
      ? ["x", "y", "globeRotation", "globeTilt", "globeX", "globeY", "globeRadius"]
      : ["x", "y"];
  const supplied = forbidden.filter((input) => node.inputs[input] !== undefined);
  if (supplied.length) fail(node, "CUT_VISUAL_INPUT_COMBINATION", `${projection} projection does not execute input${supplied.length === 1 ? "" : "s"} ${supplied.map((input) => `“${input}”`).join(", ")}.`);
  if (projection !== "canvas") validateGeoPoint(node, "origin", node.inputs.origin, false);
  return projection;
}

export function validateReferenceGeoConfig(ir: CutAVIR, _composition: IRComposition, node: IRNode) {
  if (!node.op.startsWith("cut.geo.")) return;
  // GeoAnnotation owns a composition-relative viewport, closed graph, style,
  // and sample proof in geo-annotation.ts. Applying this legacy generic geo
  // width<=4096 validator would contradict its public delivery-width bound.
  if (node.op === "cut.geo.annotation") return;
  for (const color of ["ocean", "land", "line", "signal", "color", "stroke"]) validateColor(node, color);
  validateReferenceVisualReveal(ir, node);
  for (const input of ["x", "y", "globeX", "globeY"]) validateOptionalQuantity(node, input, "length", -65_536, 65_536);
  for (const input of ["radius", "markerRadius", "globeRadius"]) validateOptionalQuantity(node, input, "length", 0.001, 65_536);
  validateOptionalQuantity(node, "width", "length", 0.001, 4_096);
  validateOptionalQuantity(node, "tilt", "angle", -90, 90);
  validateOptionalQuantity(node, "globeTilt", "angle", -90, 90);
  validateOptionalQuantity(node, "globeRotation", "angle", -360_000, 360_000);

  if (node.op === "cut.geo.globe") {
    if (node.inputs.points !== undefined && node.inputs.stations !== undefined) fail(node, "CUT_VISUAL_INPUT_COMBINATION", "inputs “points” and “stations” are aliases; supply exactly one.");
    validateDataResource(ir, node, "points"); validateDataResource(ir, node, "stations");
  } else if (node.op === "cut.geo.map") validateDataResource(ir, node, "points");
  else if (node.op === "cut.geo.route") {
    validateGeoPointList(node, "points", node.inputs.points, 2, 10_000);
    if (node.inputs.color !== undefined && node.inputs.stroke !== undefined) fail(node, "CUT_VISUAL_INPUT_COMBINATION", "inputs “color” and “stroke” are aliases; supply exactly one.");
  } else if (node.op === "cut.geo.marker") {
    validateGeoPoint(node, "point", node.inputs.point, true);
    const projection = node.inputs.projection?.kind === "string" ? node.inputs.projection.value : "map";
    if (projection !== "map" && projection !== "globe") fail(node, "CUT_VISUAL_INPUT_ENUM", "input “projection” must be one of: map, globe.");
    const globeInputs = ["globeRotation", "globeTilt", "globeX", "globeY", "globeRadius"].filter((input) => node.inputs[input] !== undefined);
    if (projection !== "globe" && globeInputs.length) fail(node, "CUT_VISUAL_INPUT_COMBINATION", `map projection does not execute inputs ${globeInputs.map((input) => `“${input}”`).join(", ")}.`);
  } else if (node.op === "cut.geo.wavefront") {
    referenceWavefrontProjection(node); validateInteger(node, "count", 1, 12);
  } else if (node.op === "cut.geo.connections") {
    const sources = ["points", "stations"].filter((input) => node.inputs[input] !== undefined);
    if (sources.length !== 1) fail(node, "CUT_VISUAL_INPUT_COMBINATION", "requires exactly one of “points” or “stations”.");
    validateDataResource(ir, node, "points"); validateDataResource(ir, node, "stations"); validateGeoPoint(node, "target", node.inputs.target, true); validateInteger(node, "count", 1, 500);
  }
}
