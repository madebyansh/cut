import { geoDistance } from "d3-geo";
import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  type Rational,
} from "../../language/rational";
import {
  referenceGeoMapCameraPoint,
  referenceGeoMapCameraProjectionAlgorithm,
} from "./geo-projection";
import { referenceLocalSpaceStaticConfig } from "./local-space";
import { parseReferenceEasing } from "./easing";
import { propertyAt } from "./signals";
import { referenceIdentityAffine2D } from "./retained-visual";
import {
  ReferenceGeoAnnotationError,
  referenceGeoAnnotationMapCameraAlgorithmVersion,
  referenceGeoAnnotationActive,
  referenceGeoAnnotationConfig,
  referenceGeoAnnotationOpacityAt,
  resolveReferenceGeoAnnotationsAt,
  type ReferenceGeoAnnotationConfig,
  type ReferenceGeoAnnotationFramePlan,
  type ReferenceGeoAnnotationProjectedEntry,
} from "./geo-annotation";

/** Static retained-camera planner used by the connected public renderer. Its
 * receipts remain preflight evidence; completed pixel evidence is published
 * separately by the same-invocation frame runtime. */
export const referenceMapCameraAlgorithmVersion = "cut-reference-map-camera-v4" as const;
export const referenceMapCameraPlanBackendIdentity = "cut-reference-map-camera-planner-v1" as const;
/** The final-space raster algorithm is separate from the retained-camera
 * planner identity. V2 keeps CUT's closed stream/canvas/work ceilings but
 * explicitly authorizes librsvg's large-input mode after those ceilings pass. */
export const referenceMapCameraFinalSpaceRasterAlgorithmVersion = "cut-reference-map-camera-final-space-render-v5" as const;
/** Closed moving-subject rule. The owning MapCamera planner/render/evidence
 * family is versioned separately because admitting this child changes the
 * semantic package closure even when unrelated authored pixels are unchanged. */
export const referenceMapCameraRouteSubjectAlgorithmVersion = "cut-reference-map-camera-route-subject-v1" as const;

export const referenceMapCameraLimits = Object.freeze({
  maximumDirectChildren: 64,
  maximumMaps: 1,
  maximumRoutePointsPerRoute: 4_096,
  maximumAuthoredGeoPointsPerCamera: 65_536,
  maximumRouteSubjectSegmentFrameEvaluations: 4_000_000,
  // An annotation is also one direct child, so this limit must not claim more
  // work than the closed direct-child grammar can ever admit.
  maximumAnnotationsPerCamera: 64,
  maximumValidationSamplesPerComposition: 250_000,
  maximumCanonicalDrawingStreamBytesPerSample: 33_554_432,
  maximumGeographicRastersPerSample: 1,
  minimumScale: rational(1, 4),
  maximumScale: rational(64),
  minimumLatitude: rational(-90),
  maximumLatitude: rational(90),
  minimumLongitude: rational(-180),
  maximumLongitude: rational(180),
  minimumBearing: rational(-360_000),
  maximumBearing: rational(360_000),
  minimumPitch: rational(0),
  maximumPitch: rational(60),
  maximumRationalDigits: 256,
});

export const referenceMapCameraAtlasIdentity = Object.freeze({
  worldAtlas: "world-atlas@2.0.2",
  topojsonClient: "topojson-client@3.1.0",
  d3Geo: "d3-geo@3.1.1",
  licenseSha256: "8048290dfdb6e83fbed17e8985c8cfc4ce9da9b842642f3d3e497280790cfa31",
  details: Object.freeze({
    "110m": Object.freeze({ bytes: 107_761, arcs: 595, coordinateRecords: 8_246, sha256: "2516c915867c7baf18ddec727aec46c315541a07cfb3d79a6559b05d5e94eee8" }),
    "50m": Object.freeze({ bytes: 756_420, arcs: 1_959, coordinateRecords: 80_617, sha256: "04342cdc1e3016bcd7db1630de95684d67b79fe3c8c460321e87aef469502394" }),
    "10m": Object.freeze({ bytes: 3_661_071, arcs: 4_635, coordinateRecords: 477_295, sha256: "3bc6f1d367a9bcec479841bae0e76092f512838411d0cef124e92eec4db45f79" }),
  }),
});

/** Style defaults shared by preflight and retained rendering. Explicitly
 * authoring one of these values is a source-located no-op error. */
export const referenceMapCameraRetainedStyleDefaults = Object.freeze({
  map: Object.freeze({ background: "#07141f", land: "#193b46", border: "#557e87", borderWidth: 1, graticule: "#557e8733", graticuleWidth: 1 }),
  route: Object.freeze({ color: "#ff6b45", width: 5 }),
  routeSubject: Object.freeze({ color: "#ffd166", radius: 7 }),
  marker: Object.freeze({ color: "#ff6b45", radius: 9 }),
  wavefront: Object.freeze({ color: "#ff6b45", count: 5 }),
});

export type ReferenceMapCameraAtlasDetail = keyof typeof referenceMapCameraAtlasIdentity.details;

export type ReferenceMapCameraErrorCode =
  | "CUT_MAP_CAMERA_TYPE"
  | "CUT_MAP_CAMERA_GRAPH"
  | "CUT_MAP_CAMERA_INTERVAL"
  | "CUT_MAP_CAMERA_SIGNAL"
  | "CUT_MAP_CAMERA_RANGE"
  | "CUT_MAP_CAMERA_PROJECTION"
  | "CUT_MAP_CAMERA_CHILD"
  | "CUT_MAP_CAMERA_NOOP"
  | "CUT_MAP_CAMERA_LIMIT";

export type ReferenceMapCameraSource = Readonly<{
  module: string;
  line: number;
  column: number;
  nodeId: string;
}>;

export class ReferenceMapCameraError extends Error {
  readonly source: ReferenceMapCameraSource;

  constructor(readonly code: ReferenceMapCameraErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    const label = node.op === "cut.geo.map_camera" ? "MapCamera" : node.op;
    super(`${code}: ${label} at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceMapCameraError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceMapCameraChildKind =
  | "map"
  | "route"
  | "route-subject"
  | "marker"
  | "wavefront"
  | "connections"
  | "annotation";

export type ReferenceMapCameraExactState = Readonly<{
  latitude: Rational;
  longitude: Rational;
  scale: Rational;
  /** Authored/sample-exact unwrapped compass bearing. */
  bearing: Rational;
  /** Canonical planar equivalent in [0deg,360deg). */
  effectiveBearing: Rational;
  /** Bounded flat-plane projective tilt in degrees. */
  pitch: Rational;
}>;

export type ReferenceMapCameraState = Readonly<{
  latitude: number;
  longitude: number;
  scale: number;
  bearing: number;
  effectiveBearing: number;
  pitch: number;
  exact: ReferenceMapCameraExactState;
}>;

export type ReferenceMapCameraChildConfig = Readonly<{
  nodeId: string;
  kind: ReferenceMapCameraChildKind;
  sourceOrder: number;
  authoredGeoPoints: number;
  authoredInputs: readonly string[];
  authoredProperties: readonly string[];
  semanticIdentity: string;
  routeSubject?: Readonly<{
    algorithmVersion: typeof referenceMapCameraRouteSubjectAlgorithmVersion;
    distanceAlgorithm: "d3-geo@3.1.1.geoDistance";
    metric: "cumulative-spherical-great-circle-angular-distance";
    interpolation: "d3-geo-geoInterpolate";
    segments: number;
    exactFrameSamples: number;
    segmentAngularDistancesRadians: readonly number[];
    totalAngularDistanceRadians: number;
  }>;
  atlas?: Readonly<{
    detail: ReferenceMapCameraAtlasDetail;
    bytes: number;
    arcs: number;
    coordinateRecords: number;
    sha256: string;
  }>;
  localSpace?: Readonly<{
    nodeId: string;
    width: number;
    height: number;
    origin: Readonly<{ x: Rational; y: Rational }>;
  }>;
}>;

export type ReferenceMapCameraConfig = Readonly<{
  nodeId: string;
  projectionAlgorithm: typeof referenceGeoMapCameraProjectionAlgorithm;
  children: readonly ReferenceMapCameraChildConfig[];
  authoredGeoPoints: number;
  semanticIdentity: string;
  validation: Readonly<{
    exactSamples: number;
    activeChildIds: readonly string[];
    distinctCameraStates: number;
    routeSubjectSegments: number;
    routeSubjectSegmentFrameEvaluations: number;
    routeSubjectSegmentFrameEvaluationLimit: typeof referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations;
  }>;
}>;

export type ReferenceMapCameraAnnotationBinding = Readonly<{
  config: ReferenceGeoAnnotationConfig;
  sourceOrder: number;
  childSemanticIdentity: string;
}>;

export type ReferenceMapCameraAnnotationConfig = Readonly<{
  cameraId: string;
  annotations: readonly ReferenceMapCameraAnnotationBinding[];
  validation: Readonly<{
    exactSamples: number;
    fallbackReached: Readonly<Record<string, readonly number[]>>;
    priorityAffected: readonly string[];
    everAccepted: readonly string[];
  }>;
}>;

export type ReferenceMapCameraPlanningFrame = Readonly<{
  format: "cut-reference-map-camera-planning-frame";
  version: 4;
  evidenceKind: "preflight-plan-not-render-evidence";
  algorithmVersion: typeof referenceMapCameraAlgorithmVersion;
  projectionAlgorithm: typeof referenceGeoMapCameraProjectionAlgorithm;
  exactTime: Rational;
  state: ReferenceMapCameraState;
  projectedCenter: readonly [number, number];
  finalClip: Readonly<{ left: 0; top: 0; right: number; bottom: number }>;
  activeChildren: readonly Readonly<{ nodeId: string; kind: ReferenceMapCameraChildKind; sourceOrder: number }>[];
  pipelineRequired: readonly [
    "sample-exact-camera-and-child-signals",
    "project-visible-geometry-in-final-space",
    "apply-bounded-projective-pitch-in-final-space",
    "clip-and-canonicalize-drawing-stream",
    "rasterize-once-at-delivery-resolution",
    "place-local-space-annotations",
    "composite-without-resize",
  ];
  execution: Readonly<{
    retainedGeometry: "not-executed";
    raster: "not-executed";
    requiredRasterPasses: 1;
    requiredResamplePasses: 0;
  }>;
  work: Readonly<{
    activeChildren: number;
    authoredGeoPoints: number;
    atlasCoordinateRecords: number;
    plannedDeliveryRasterPixels: number;
    canonicalDrawingStreamByteLimit: number;
    routeSubjectSegments: number;
    routeSubjectSegmentFrameEvaluations: number;
    routeSubjectSegmentFrameEvaluationLimit: typeof referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations;
  }>;
  semanticIdentity: string;
  planCacheIdentity: string;
}>;

const childKinds = Object.freeze(new Map<string, ReferenceMapCameraChildKind>([
  ["cut.geo.map", "map"],
  ["cut.geo.route", "route"],
  ["cut.geo.route_subject", "route-subject"],
  ["cut.geo.marker", "marker"],
  ["cut.geo.wavefront", "wavefront"],
  ["cut.geo.connections", "connections"],
  ["cut.geo.annotation", "annotation"],
]));

const cameraProperties = ["latitude", "longitude", "scale", "bearing", "pitch"] as const;
type CameraProperty = typeof cameraProperties[number];

const cameraPropertyValueTypes: Readonly<Record<CameraProperty, "Number" | "Angle">> = Object.freeze({
  latitude: "Number",
  longitude: "Number",
  scale: "Number",
  bearing: "Angle",
  pitch: "Angle",
});

const cameraDefaults: Readonly<Record<CameraProperty, Rational>> = Object.freeze({
  latitude: rational(0),
  longitude: rational(0),
  scale: rational(1),
  bearing: rational(0),
  pitch: rational(0),
});

const cameraRanges: Readonly<Record<CameraProperty, readonly [Rational, Rational]>> = Object.freeze({
  latitude: Object.freeze([referenceMapCameraLimits.minimumLatitude, referenceMapCameraLimits.maximumLatitude] as const),
  longitude: Object.freeze([referenceMapCameraLimits.minimumLongitude, referenceMapCameraLimits.maximumLongitude] as const),
  scale: Object.freeze([referenceMapCameraLimits.minimumScale, referenceMapCameraLimits.maximumScale] as const),
  bearing: Object.freeze([referenceMapCameraLimits.minimumBearing, referenceMapCameraLimits.maximumBearing] as const),
  pitch: Object.freeze([referenceMapCameraLimits.minimumPitch, referenceMapCameraLimits.maximumPitch] as const),
});

const childControls: Readonly<Record<ReferenceMapCameraChildKind, Readonly<{
  inputs: readonly string[];
  properties: readonly string[];
}>>> = Object.freeze({
  map: Object.freeze({
    inputs: Object.freeze(["detail", "background", "land", "border", "borderWidth", "graticule", "graticuleWidth", "opacity"]),
    properties: Object.freeze(["opacity"]),
  }),
  route: Object.freeze({
    inputs: Object.freeze(["points", "color", "stroke", "width", "reveal", "opacity"]),
    properties: Object.freeze(["reveal", "opacity"]),
  }),
  "route-subject": Object.freeze({
    inputs: Object.freeze(["points", "progress", "color", "radius", "opacity"]),
    properties: Object.freeze(["progress", "opacity"]),
  }),
  marker: Object.freeze({
    inputs: Object.freeze(["point", "font", "color", "radius", "label", "opacity"]),
    properties: Object.freeze(["opacity"]),
  }),
  wavefront: Object.freeze({
    inputs: Object.freeze(["origin", "radius", "color", "count", "reveal", "opacity"]),
    properties: Object.freeze(["reveal", "opacity"]),
  }),
  connections: Object.freeze({
    inputs: Object.freeze(["points", "stations", "target", "font", "count", "color", "width", "reveal", "opacity"]),
    properties: Object.freeze(["reveal", "opacity"]),
  }),
  annotation: Object.freeze({
    // width/height are recognized here only so the migration-specific
    // diagnostic below can refuse them rather than reporting an unknown key.
    inputs: Object.freeze(["anchor", "width", "height", "placements", "offset", "safeArea", "priority", "leader", "leaderColor", "leaderWidth", "opacity"]),
    properties: Object.freeze(["opacity"]),
  }),
});

function fail(node: IRNode, code: ReferenceMapCameraErrorCode, detail: string): never {
  throw new ReferenceMapCameraError(code, node, detail);
}

function safeRational(
  node: IRNode,
  value: Rational,
  label: string,
  code: ReferenceMapCameraErrorCode = "CUT_MAP_CAMERA_TYPE",
  requireCanonical = true,
) {
  const integer = /^-?(?:0|[1-9]\d*)$/u;
  const positive = /^(?:[1-9]\d*)$/u;
  if (!integer.test(value.numerator)
    || !positive.test(value.denominator)
    || value.numerator.length > referenceMapCameraLimits.maximumRationalDigits
    || value.denominator.length > referenceMapCameraLimits.maximumRationalDigits) {
    fail(node, code, `${label} must contain a bounded canonical Rational.`);
  }
  let canonical: Rational;
  try { canonical = rational(value.numerator, value.denominator); }
  catch { fail(node, code, `${label} must contain a bounded canonical Rational.`); }
  if (requireCanonical && (canonical.numerator !== value.numerator || canonical.denominator !== value.denominator)) {
    fail(node, code, `${label} must be reduced and canonically encoded.`);
  }
  return canonical;
}

function scalar(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  minimum: Rational,
  maximum: Rational,
  code: ReferenceMapCameraErrorCode = "CUT_MAP_CAMERA_RANGE",
  requireCanonical = true,
) {
  if (value?.kind !== "quantity" || value.dimension !== "scalar" || value.unit !== "scalar") {
    fail(node, "CUT_MAP_CAMERA_TYPE", `${label} must be a canonical Number.`);
  }
  const exact = safeRational(node, value.magnitude, label, "CUT_MAP_CAMERA_TYPE", requireCanonical);
  if (compareRational(exact, minimum) < 0 || compareRational(exact, maximum) > 0) {
    fail(node, code, `${label} must be from ${minimum.numerator}/${minimum.denominator} through ${maximum.numerator}/${maximum.denominator}.`);
  }
  return exact;
}

function angle(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  minimum: Rational,
  maximum: Rational,
  code: ReferenceMapCameraErrorCode = "CUT_MAP_CAMERA_RANGE",
  requireCanonical = true,
) {
  if (value?.kind !== "quantity" || value.dimension !== "angle" || value.unit !== "deg") {
    fail(node, "CUT_MAP_CAMERA_TYPE", `${label} must be a canonical Angle in degrees.`);
  }
  const exact = safeRational(node, value.magnitude, label, "CUT_MAP_CAMERA_TYPE", requireCanonical);
  if (compareRational(exact, minimum) < 0 || compareRational(exact, maximum) > 0) {
    fail(node, code, `${label} must be from ${minimum.numerator}/${minimum.denominator}deg through ${maximum.numerator}/${maximum.denominator}deg.`);
  }
  return exact;
}

function cameraValue(
  node: IRNode,
  property: CameraProperty,
  value: IRValue | undefined,
  label: string,
  code: ReferenceMapCameraErrorCode = "CUT_MAP_CAMERA_RANGE",
  requireCanonical = true,
) {
  const [minimum, maximum] = cameraRanges[property];
  return property === "bearing" || property === "pitch"
    ? angle(node, value, label, minimum, maximum, code, requireCanonical)
    : scalar(node, value, label, minimum, maximum, code, requireCanonical);
}

/** Exact modulo used only for projection/output equivalence. Authored bearing
 * stays unwrapped so interpolation direction and revolutions remain explicit. */
function effectiveBearingExact(value: Rational): Rational {
  const denominator = BigInt(value.denominator);
  const period = 360n * denominator;
  let numerator = BigInt(value.numerator) % period;
  if (numerator < 0n) numerator += period;
  return rational(numerator, denominator);
}

function effectiveCameraValue(property: CameraProperty, value: Rational) {
  return property === "bearing" ? effectiveBearingExact(value) : value;
}

function cameraValuesEqual(property: CameraProperty, left: Rational, right: Rational) {
  return compareRational(effectiveCameraValue(property, left), effectiveCameraValue(property, right)) === 0;
}

function exactTime(node: IRNode, value: Rational, label: string) {
  return safeRational(node, value, label, "CUT_MAP_CAMERA_SIGNAL");
}

function signalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [{ label: ".value", value: signal.value }];
  if (signal.kind === "step") return signal.points.map((point, index) => ({ label: `.points[${index}].value`, value: point.value }));
  if (signal.kind === "keyframes") return signal.keyframes.map((point, index) => ({ label: `.keyframes[${index}].value`, value: point.value }));
  return [
    ...(signal.initial.kind === "null" ? [] : [{ label: ".initial", value: signal.initial }]),
    ...signal.events.flatMap((event, index) => event.kind === "set"
      ? [{ label: `.events[${index}].value`, value: event.value }]
      : [
        { label: `.events[${index}].from`, value: event.from },
        { label: `.events[${index}].to`, value: event.to },
      ]),
  ];
}

function validateSignalStructure(ir: CutAVIR, node: IRNode, property: CameraProperty) {
  const authored = node.properties[property];
  if (!authored || !("signal" in authored)) return undefined;
  const signal = ir.signals[authored.signal];
  if (!signal) fail(node, "CUT_MAP_CAMERA_SIGNAL", `property “${property}” references missing signal ${authored.signal}.`);
  const expectedValueType = cameraPropertyValueTypes[property];
  if (signal.valueType !== expectedValueType) {
    fail(node, "CUT_MAP_CAMERA_SIGNAL", `property “${property}” signal ${signal.id} must declare valueType ${expectedValueType}.`);
  }
  for (const item of signalValues(signal)) cameraValue(node, property, item.value, `property “${property}” signal ${signal.id}${item.label}`);

  let previous: Rational | undefined;
  const ordered = (value: Rational, label: string, strict: boolean) => {
    const current = exactTime(node, value, `signal ${signal.id}${label}`);
    if (previous && (strict ? compareRational(current, previous) <= 0 : compareRational(current, previous) < 0)) {
      fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id}${label} is not in ${strict ? "strictly increasing" : "nondecreasing"} exact-time order.`);
    }
    previous = current;
  };
  if (signal.kind === "step") {
    if (!signal.points.length) fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id} needs at least one step point.`);
    signal.points.forEach((point, index) => ordered(point.time, `.points[${index}].time`, true));
  } else if (signal.kind === "keyframes") {
    if (!signal.keyframes.length) fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id} needs at least one keyframe.`);
    signal.keyframes.forEach((keyframe, index) => {
      ordered(keyframe.time, `.keyframes[${index}].time`, true);
      try { parseReferenceEasing(keyframe.curve); }
      catch (error) { fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id}.keyframes[${index}].curve is not executable: ${error instanceof Error ? error.message : String(error)}`); }
    });
  } else if (signal.kind === "track") {
    if (signal.initial.kind === "null" && !signal.events.length) {
      fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id} has neither an initial value nor an event to execute.`);
    }
    signal.events.forEach((event, index) => {
      const at = event.kind === "set" ? event.time : event.start;
      ordered(at, `.events[${index}].${event.kind === "set" ? "time" : "start"}`, false);
      if (event.kind === "animate") {
        const end = exactTime(node, event.end, `signal ${signal.id}.events[${index}].end`);
        if (compareRational(end, at) <= 0) fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id}.events[${index}] needs start < end.`);
        try { parseReferenceEasing(event.curve); }
        catch (error) { fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id}.events[${index}].curve is not executable: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  }
  return signal;
}

function valueAt(ir: CutAVIR, node: IRNode, property: CameraProperty, time: Rational) {
  let sampled: IRValue | undefined;
  try {
    const propertyValue = propertyAt(ir, node, property, time);
    sampled = propertyValue?.kind === "null" ? node.inputs[property] : propertyValue ?? node.inputs[property];
  }
  catch (error) { fail(node, "CUT_MAP_CAMERA_SIGNAL", `property “${property}” failed at ${time.numerator}/${time.denominator}s: ${error instanceof Error ? error.message : String(error)}`); }
  // Signal interpolation is deterministically quantized by signals.ts and may
  // carry an unreduced 1e6 denominator. Normalize that derived value here;
  // authored IR values above remain required to be canonical.
  return sampled === undefined ? cameraDefaults[property] : cameraValue(node, property, sampled, `executed ${property}`, "CUT_MAP_CAMERA_RANGE", false);
}

function validateCameraControls(ir: CutAVIR, node: IRNode, times: readonly Rational[]) {
  const unknownInput = Object.keys(node.inputs).find((name) => !cameraProperties.includes(name as CameraProperty));
  if (unknownInput === "projection") {
    fail(node, "CUT_MAP_CAMERA_PROJECTION", "projection is fixed to the versioned Natural Earth 1 MapCamera algorithm; an authored selector would be a no-op.");
  }
  if (unknownInput !== undefined) fail(node, "CUT_MAP_CAMERA_TYPE", `input “${unknownInput}” is not part of the closed MapCamera contract.`);
  const unknownProperty = Object.keys(node.properties).find((name) => !cameraProperties.includes(name as CameraProperty));
  if (unknownProperty !== undefined) fail(node, "CUT_MAP_CAMERA_TYPE", `property “${unknownProperty}” is not part of the closed MapCamera contract.`);

  for (const property of cameraProperties) {
    const input = node.inputs[property], authored = node.properties[property];
    const inputExact = input === undefined ? undefined : cameraValue(node, property, input, `input “${property}”`);
    const signal = validateSignalStructure(ir, node, property);
    if (input !== undefined && authored !== undefined && !("signal" in authored)) {
      fail(node, "CUT_MAP_CAMERA_NOOP", `property “${property}” shadows the same-named constructor input for the complete interval; author one control path.`);
    }
    if (inputExact && signal) {
      const baseline = valueAt(ir, node, property, node.interval.start);
      if (compareRational(baseline, inputExact) !== 0) {
        fail(node, "CUT_MAP_CAMERA_NOOP", `input “${property}” is immediately shadowed; it must equal signal ${signal.id}'s exact interval-start baseline or be omitted.`);
      }
    }
    const sampled = times.map((time) => valueAt(ir, node, property, time));
    const authoredStatic = authored && !("signal" in authored) ? cameraValue(node, property, authored, `property “${property}”`) : undefined;
    if (authoredStatic && cameraValuesEqual(property, authoredStatic, cameraDefaults[property])) {
      fail(node, "CUT_MAP_CAMERA_NOOP", `static property “${property}” repeats the default; omit it.`);
    }
    if (inputExact && !authored && cameraValuesEqual(property, inputExact, cameraDefaults[property])) {
      fail(node, "CUT_MAP_CAMERA_NOOP", `input “${property}” repeats the default; omit it.`);
    }
    if (signal) {
      const distinct = new Set(sampled.map((value) => {
        const effective = effectiveCameraValue(property, value);
        return `${effective.numerator}/${effective.denominator}`;
      }));
      if (distinct.size < 2) {
        fail(node, "CUT_MAP_CAMERA_NOOP", `property “${property}” signal ${signal.id} is constant at every bounded exact output-frame sample.`);
      }
      if (inputExact && cameraValuesEqual(property, inputExact, cameraDefaults[property])
        && !sampled.some((value) => !cameraValuesEqual(property, value, cameraDefaults[property]))) {
        fail(node, "CUT_MAP_CAMERA_NOOP", `default-valued input “${property}” never reaches a non-default bounded sample.`);
      }
    }
  }
}

function ceilRational(value: Rational) {
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  return numerator >= 0n ? (numerator + denominator - 1n) / denominator : numerator / denominator;
}

/** Exact ordinary output-frame samples in MapCamera's half-open interval. */
export function referenceMapCameraValidationTimes(composition: IRComposition, node: IRNode) {
  if (!Number.isSafeInteger(composition.width) || composition.width <= 0
    || !Number.isSafeInteger(composition.height) || composition.height <= 0) {
    fail(node, "CUT_MAP_CAMERA_LIMIT", `delivery dimensions must be positive safe integers; found ${composition.width}x${composition.height}.`);
  }
  const fps = safeRational(node, composition.fps, "composition fps", "CUT_MAP_CAMERA_TYPE");
  if (compareRational(fps, rational(0)) <= 0) fail(node, "CUT_MAP_CAMERA_TYPE", "composition fps must be positive.");
  const start = safeRational(node, node.interval.start, "camera interval start", "CUT_MAP_CAMERA_INTERVAL");
  const duration = safeRational(node, node.interval.duration, "camera interval duration", "CUT_MAP_CAMERA_INTERVAL");
  if (compareRational(duration, rational(0)) <= 0) fail(node, "CUT_MAP_CAMERA_INTERVAL", "requires a positive half-open interval duration.");
  const startFrame = ceilRational(multiplyRational(start, fps));
  const endFrame = ceilRational(multiplyRational(addRational(start, duration), fps));
  const count = endFrame - startFrame;
  if (count < 1n) fail(node, "CUT_MAP_CAMERA_INTERVAL", "has no exact output-frame sample in its half-open interval.");
  if (count > BigInt(referenceMapCameraLimits.maximumValidationSamplesPerComposition)) {
    fail(node, "CUT_MAP_CAMERA_LIMIT", `requires ${count} output-frame samples; the composition validation limit is ${referenceMapCameraLimits.maximumValidationSamplesPerComposition}.`);
  }
  const result: Rational[] = [];
  for (let frame = startFrame; frame < endFrame; frame += 1n) result.push(divideRational(rational(frame), fps));
  return Object.freeze(result);
}

function active(node: IRNode, time: Rational) {
  const end = addRational(node.interval.start, node.interval.duration);
  return compareRational(time, node.interval.start) >= 0 && compareRational(time, end) < 0;
}

function intervalContains(outer: IRNode, inner: IRNode) {
  const outerEnd = addRational(outer.interval.start, outer.interval.duration);
  const innerEnd = addRational(inner.interval.start, inner.interval.duration);
  return compareRational(inner.interval.start, outer.interval.start) >= 0 && compareRational(innerEnd, outerEnd) <= 0;
}

function validateContainedInterval(outer: IRNode, inner: IRNode, label: string) {
  safeRational(inner, inner.interval.start, `${label} interval start`, "CUT_MAP_CAMERA_INTERVAL");
  const duration = safeRational(inner, inner.interval.duration, `${label} interval duration`, "CUT_MAP_CAMERA_INTERVAL");
  if (compareRational(duration, rational(0)) <= 0) fail(inner, "CUT_MAP_CAMERA_INTERVAL", `${label} needs a positive half-open duration.`);
  if (!intervalContains(outer, inner)) fail(inner, "CUT_MAP_CAMERA_INTERVAL", `${label} half-open interval must be contained by ${outer.op}.`);
}

function directParents(ir: CutAVIR) {
  const result = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) for (const childId of parent.children) {
    const parents = result.get(childId) ?? [];
    parents.push(parent);
    result.set(childId, parents);
  }
  return result;
}

function closedGeoPoint(node: IRNode, value: IRValue | undefined, label: string, allowLabel: boolean) {
  if (value?.kind !== "object") fail(node, "CUT_MAP_CAMERA_CHILD", `${label} must be one GeoPoint object.`);
  const allowed = new Set(["latitude", "longitude", ...(allowLabel ? ["label"] : [])]);
  const keys = Object.keys(value.entries);
  if (!keys.includes("latitude") || !keys.includes("longitude") || keys.some((key) => !allowed.has(key))) {
    fail(node, "CUT_MAP_CAMERA_CHILD", `${label} must contain exactly latitude, longitude${allowLabel ? ", and optional label" : ""}.`);
  }
  scalar(node, value.entries.latitude, `${label}.latitude`, referenceMapCameraLimits.minimumLatitude, referenceMapCameraLimits.maximumLatitude);
  scalar(node, value.entries.longitude, `${label}.longitude`, referenceMapCameraLimits.minimumLongitude, referenceMapCameraLimits.maximumLongitude);
  if (value.entries.label !== undefined && value.entries.label.kind !== "string") fail(node, "CUT_MAP_CAMERA_CHILD", `${label}.label must be a String.`);
  return 1;
}

function pointList(node: IRNode, value: IRValue | undefined, label: string, minimum: number, maximum: number) {
  if (value?.kind !== "array") fail(node, "CUT_MAP_CAMERA_CHILD", `${label} must be an inline List<GeoPoint> in the phase-one planner.`);
  if (value.items.length < minimum || value.items.length > maximum) {
    fail(node, value.items.length > maximum ? "CUT_MAP_CAMERA_LIMIT" : "CUT_MAP_CAMERA_CHILD", `${label} must contain ${minimum} through ${maximum} points; found ${value.items.length}.`);
  }
  value.items.forEach((point, index) => closedGeoPoint(node, point, `${label}[${index}]`, false));
  return value.items.length;
}

function colorAlpha(node: IRNode, name: string) {
  const value = node.inputs[name];
  if (value === undefined) return undefined;
  if (value.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(value.value)) {
    fail(node, "CUT_MAP_CAMERA_CHILD", `input “${name}” must be a canonical lowercase #rrggbb or #rrggbbaa Color.`);
  }
  return value.value.length === 9 ? Number.parseInt(value.value.slice(7, 9), 16) : 255;
}

function rejectDefaultColor(node: IRNode, name: string, fallback: string) {
  colorAlpha(node, name);
  const value = node.inputs[name];
  if (value?.kind === "color" && value.value === fallback) {
    fail(node, "CUT_MAP_CAMERA_NOOP", `input “${name}” repeats the retained renderer default ${fallback}; omit it.`);
  }
}

function positiveLength(node: IRNode, name: string) {
  const value = node.inputs[name];
  if (value === undefined) return undefined;
  if (value.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(node, "CUT_MAP_CAMERA_CHILD", `input “${name}” must be a canonical delivery-pixel Length.`);
  }
  const exact = safeRational(node, value.magnitude, `input “${name}”`);
  if (compareRational(exact, rational(0)) <= 0 || compareRational(exact, rational(4_096)) > 0) {
    fail(node, "CUT_MAP_CAMERA_RANGE", `input “${name}” must be greater than 0px and no larger than 4096px.`);
  }
  return exact;
}

function rejectDefaultLength(node: IRNode, name: string, fallback: number) {
  const exact = positiveLength(node, name);
  if (exact && compareRational(exact, rational(fallback)) === 0) {
    fail(node, "CUT_MAP_CAMERA_NOOP", `input “${name}” repeats the retained renderer default ${fallback}px; omit it.`);
  }
}

function optionalInteger(node: IRNode, name: string, minimum: number, maximum: number) {
  const value = node.inputs[name];
  if (value === undefined) return undefined;
  const exact = scalar(node, value, `input “${name}”`, rational(minimum), rational(maximum), "CUT_MAP_CAMERA_RANGE");
  if (exact.denominator !== "1") fail(node, "CUT_MAP_CAMERA_TYPE", `input “${name}” must be a whole Number.`);
  return Number(exact.numerator);
}

function optionalString(node: IRNode, name: string, allowed?: readonly string[]) {
  const value = node.inputs[name];
  if (value === undefined) return undefined;
  if (value.kind !== "string" || value.value.length < 1 || value.value.length > 4_096) {
    fail(node, "CUT_MAP_CAMERA_CHILD", `input “${name}” must be a nonempty bounded String.`);
  }
  if (allowed && !allowed.includes(value.value)) fail(node, "CUT_MAP_CAMERA_CHILD", `input “${name}” must be one of: ${allowed.join(", ")}.`);
  return value.value;
}

function validateFont(node: IRNode, ir: CutAVIR, hasLabel: boolean) {
  const value = node.inputs.font;
  if (value === undefined) return;
  if (!hasLabel) fail(node, "CUT_MAP_CAMERA_NOOP", "input “font” has no label text to shape.");
  if (value.kind !== "resource-ref") fail(node, "CUT_MAP_CAMERA_CHILD", "input “font” must reference one locked FontAsset.");
  const resource = ir.resources[value.id];
  if (!resource || resource.kind !== "font" || resource.state !== "locked" || !/^[0-9a-f]{64}$/u.test(resource.sha256 ?? "")) {
    fail(node, "CUT_MAP_CAMERA_CHILD", `input “font” resource ${value.id} must be a locked font with SHA-256 identity.`);
  }
}

function pointHasLabel(value: IRValue | undefined) {
  return value?.kind === "object" && value.entries.label?.kind === "string" && value.entries.label.value.length > 0;
}

function validateAnnotationStyle(node: IRNode) {
  const placements = node.inputs.placements;
  if (placements !== undefined) {
    if (placements.kind !== "array" || placements.items.length < 1 || placements.items.length > 4) {
      fail(node, "CUT_MAP_CAMERA_CHILD", "input “placements” must contain 1 through 4 directions.");
    }
    const allowed = new Set(["right", "above", "below", "left"]), seen = new Set<string>();
    placements.items.forEach((item, index) => {
      if (item.kind !== "string" || !allowed.has(item.value)) fail(node, "CUT_MAP_CAMERA_CHILD", `input “placements[${index}]” must be right, above, below, or left.`);
      if (seen.has(item.value)) fail(node, "CUT_MAP_CAMERA_NOOP", `input “placements[${index}]” duplicates ${item.value}.`);
      seen.add(item.value);
    });
  }
  positiveLength(node, "offset"); positiveLength(node, "safeArea"); positiveLength(node, "leaderWidth");
  const priority = optionalInteger(node, "priority", -1_000_000, 1_000_000);
  if (priority === 0) fail(node, "CUT_MAP_CAMERA_NOOP", "input “priority” repeats the default ordering weight; omit it.");
  const leader = optionalString(node, "leader", ["none", "straight", "elbow"]);
  const leaderColor = colorAlpha(node, "leaderColor");
  if (leader === undefined) {
    fail(node, "CUT_MAP_CAMERA_CHILD", "GeoAnnotation requires an explicit leader policy: none, straight, or elbow.");
  }
  if (leader === "none") {
    if (leaderColor !== undefined || node.inputs.leaderWidth !== undefined) fail(node, "CUT_MAP_CAMERA_NOOP", "leaderColor/leaderWidth cannot execute without a visible leader.");
  } else {
    if (leaderColor === undefined || node.inputs.leaderWidth === undefined) fail(node, "CUT_MAP_CAMERA_CHILD", `${leader} leader requires leaderColor and leaderWidth.`);
    if (leaderColor === 0) fail(node, "CUT_MAP_CAMERA_NOOP", "fully transparent leaderColor makes the leader inert.");
  }
}

function validateMapStyle(node: IRNode) {
  const detail = node.inputs.detail;
  if (detail?.kind !== "string" || !["110m", "50m", "10m"].includes(detail.value)) {
    fail(node, "CUT_MAP_CAMERA_CHILD", "Map inside MapCamera requires detail: 110m, 50m, or 10m.");
  }
  rejectDefaultColor(node, "background", referenceMapCameraRetainedStyleDefaults.map.background);
  rejectDefaultColor(node, "land", referenceMapCameraRetainedStyleDefaults.map.land);
  rejectDefaultColor(node, "border", referenceMapCameraRetainedStyleDefaults.map.border);
  rejectDefaultColor(node, "graticule", referenceMapCameraRetainedStyleDefaults.map.graticule);
  rejectDefaultLength(node, "borderWidth", referenceMapCameraRetainedStyleDefaults.map.borderWidth);
  rejectDefaultLength(node, "graticuleWidth", referenceMapCameraRetainedStyleDefaults.map.graticuleWidth);
  const background = colorAlpha(node, "background"), land = colorAlpha(node, "land");
  if (background === 0 || land === 0) fail(node, "CUT_MAP_CAMERA_NOOP", "Map background and land cannot be fully transparent in the retained camera stream.");
  const border = colorAlpha(node, "border"), graticule = colorAlpha(node, "graticule");
  if (border === 0 && node.inputs.borderWidth !== undefined) fail(node, "CUT_MAP_CAMERA_NOOP", "transparent border makes borderWidth inert; omit borderWidth.");
  if (graticule === 0 && node.inputs.graticuleWidth !== undefined) fail(node, "CUT_MAP_CAMERA_NOOP", "transparent graticule makes graticuleWidth inert; omit graticuleWidth.");
  const selected = detail.value as ReferenceMapCameraAtlasDetail;
  return Object.freeze({ detail: selected, ...referenceMapCameraAtlasIdentity.details[selected] });
}

function ratio(node: IRNode, value: IRValue | undefined, label: string, requireCanonical = true) {
  if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_MAP_CAMERA_CHILD", `${label} must be a canonical Ratio.`);
  }
  const exact = safeRational(node, value.magnitude, label, "CUT_MAP_CAMERA_CHILD", requireCanonical);
  if (compareRational(exact, rational(0)) < 0 || compareRational(exact, rational(1)) > 0) {
    fail(node, "CUT_MAP_CAMERA_RANGE", `${label} must be from 0% through 100%.`);
  }
  return exact;
}

function validateRatioSignalTimeline(node: IRNode, signal: IRSignal) {
  let previous: Rational | undefined;
  const ordered = (value: Rational, label: string, strict: boolean) => {
    const current = exactTime(node, value, `signal ${signal.id}${label}`);
    if (previous && (strict ? compareRational(current, previous) <= 0 : compareRational(current, previous) < 0)) {
      fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id}${label} is not in ${strict ? "strictly increasing" : "nondecreasing"} exact-time order.`);
    }
    previous = current;
  };
  if (signal.kind === "step") {
    if (!signal.points.length) fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id} needs at least one step point.`);
    signal.points.forEach((point, index) => ordered(point.time, `.points[${index}].time`, true));
  } else if (signal.kind === "keyframes") {
    if (!signal.keyframes.length) fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id} needs at least one keyframe.`);
    signal.keyframes.forEach((keyframe, index) => {
      ordered(keyframe.time, `.keyframes[${index}].time`, true);
      try { parseReferenceEasing(keyframe.curve); }
      catch (error) { fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id}.keyframes[${index}].curve is not executable: ${error instanceof Error ? error.message : String(error)}`); }
    });
  } else if (signal.kind === "track") {
    if (signal.initial.kind === "null" && !signal.events.length) {
      fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id} has neither an initial value nor an event to execute.`);
    }
    signal.events.forEach((event, index) => {
      const at = event.kind === "set" ? event.time : event.start;
      ordered(at, `.events[${index}].${event.kind === "set" ? "time" : "start"}`, false);
      if (event.kind === "animate") {
        const end = exactTime(node, event.end, `signal ${signal.id}.events[${index}].end`);
        if (compareRational(end, at) <= 0) fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id}.events[${index}] needs start < end.`);
        try { parseReferenceEasing(event.curve); }
        catch (error) { fail(node, "CUT_MAP_CAMERA_SIGNAL", `signal ${signal.id}.events[${index}].curve is not executable: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  }
}

const childRatioDefaults = Object.freeze({
  opacity: rational(1),
  reveal: rational(1),
  progress: rational(0),
});

type ChildRatioProperty = keyof typeof childRatioDefaults;

function ratioAt(ir: CutAVIR, node: IRNode, name: ChildRatioProperty, time: Rational) {
  let value: IRValue | undefined;
  try {
    const propertyValue = propertyAt(ir, node, name, time);
    value = propertyValue?.kind === "null" ? node.inputs[name] : propertyValue ?? node.inputs[name];
  }
  catch (error) { fail(node, "CUT_MAP_CAMERA_SIGNAL", `property “${name}” failed at ${time.numerator}/${time.denominator}s: ${error instanceof Error ? error.message : String(error)}`); }
  return value === undefined ? childRatioDefaults[name] : ratio(node, value, `executed ${name}`, false);
}

function validateChildRatioControls(ir: CutAVIR, node: IRNode, kind: ReferenceMapCameraChildKind, times: readonly Rational[]) {
  const names = childControls[kind].properties.filter((name): name is ChildRatioProperty => name === "opacity" || name === "reveal" || name === "progress");
  for (const name of names) {
    const input = node.inputs[name], property = node.properties[name];
    const inputExact = input === undefined ? undefined : ratio(node, input, `input “${name}”`);
    if (input !== undefined && property !== undefined && !("signal" in property)) {
      fail(node, "CUT_MAP_CAMERA_NOOP", `property “${name}” shadows the same-named constructor input; author one control path.`);
    }
    let signal: IRSignal | undefined;
    if (property && "signal" in property) {
      signal = ir.signals[property.signal];
      if (!signal) fail(node, "CUT_MAP_CAMERA_SIGNAL", `property “${name}” references missing signal ${property.signal}.`);
      if (signal.valueType !== "Ratio") fail(node, "CUT_MAP_CAMERA_SIGNAL", `property “${name}” signal ${signal.id} must declare valueType Ratio.`);
      for (const item of signalValues(signal)) ratio(node, item.value, `property “${name}” signal ${signal.id}${item.label}`);
      validateRatioSignalTimeline(node, signal);
      if (inputExact) {
        const baseline = ratioAt(ir, node, name, node.interval.start);
        if (compareRational(baseline, inputExact) !== 0) fail(node, "CUT_MAP_CAMERA_NOOP", `input “${name}” is immediately shadowed by signal ${signal.id}.`);
      }
    }
    const staticProperty = property && !("signal" in property) ? ratio(node, property, `property “${name}”`) : undefined;
    if (staticProperty && compareRational(staticProperty, childRatioDefaults[name]) === 0) fail(node, "CUT_MAP_CAMERA_NOOP", `static property “${name}” repeats the default; omit it.`);
    if (inputExact && !property && compareRational(inputExact, childRatioDefaults[name]) === 0) fail(node, "CUT_MAP_CAMERA_NOOP", `input “${name}” repeats the default; omit it.`);
    if (signal) {
      const sampled = times.map((time) => ratioAt(ir, node, name, time));
      if (new Set(sampled.map((value) => `${value.numerator}/${value.denominator}`)).size < 2) {
        fail(node, "CUT_MAP_CAMERA_NOOP", `property “${name}” signal ${signal.id} is constant at every active bounded output-frame sample.`);
      }
    }
  }
}

function validateChildControls(node: IRNode, kind: ReferenceMapCameraChildKind) {
  const contract = childControls[kind];
  const unknownInput = Object.keys(node.inputs).find((name) => !contract.inputs.includes(name));
  if (unknownInput === "projection") {
    fail(node, "CUT_MAP_CAMERA_PROJECTION", `input “projection” is owned by MapCamera and is forbidden on direct ${kind} children.`);
  }
  if (unknownInput === "scale" || unknownInput === "rotation") {
    fail(node, "CUT_MAP_CAMERA_CHILD", `input “${unknownInput}” would create a second camera transform inside MapCamera.`);
  }
  if (unknownInput !== undefined) fail(node, "CUT_MAP_CAMERA_CHILD", `input “${unknownInput}” is not executed by a MapCamera-owned ${kind}.`);
  const unknownProperty = Object.keys(node.properties).find((name) => !contract.properties.includes(name));
  if (unknownProperty === "scale" || unknownProperty === "rotation") {
    fail(node, "CUT_MAP_CAMERA_CHILD", `property “${unknownProperty}” would create a second camera transform inside MapCamera.`);
  }
  if (unknownProperty !== undefined) fail(node, "CUT_MAP_CAMERA_CHILD", `property “${unknownProperty}” is not executed by a MapCamera-owned ${kind}.`);
  if (node.effects.some((effect) => effect !== "pure")) fail(node, "CUT_MAP_CAMERA_CHILD", "effectful direct geographic children are outside the retained v1 stream.");
}

function childConfig(
  ir: CutAVIR,
  camera: IRNode,
  node: IRNode,
  kind: ReferenceMapCameraChildKind,
  sourceOrder: number,
  parents: ReadonlyMap<string, readonly IRNode[]>,
  cameraTimes: readonly Rational[],
) {
  validateChildControls(node, kind);
  if (node.domain !== "visual" || node.ownership !== "child") fail(node, "CUT_MAP_CAMERA_GRAPH", `must be a directly owned visual child; found domain ${node.domain}, ownership ${node.ownership}.`);
  validateContainedInterval(camera, node, `${kind} child`);
  const owners = parents.get(node.id) ?? [];
  if (owners.length !== 1 || owners[0].id !== camera.id) {
    fail(node, "CUT_MAP_CAMERA_GRAPH", `must have exactly one direct MapCamera owner; found ${owners.length === 0 ? "none" : owners.map((owner) => owner.id).join(", ")}.`);
  }
  const activeTimes = cameraTimes.filter((time) => active(node, time));
  if (!activeTimes.length) fail(node, "CUT_MAP_CAMERA_NOOP", "has no exact output-frame sample inside its owning MapCamera interval.");
  validateChildRatioControls(ir, node, kind, activeTimes);

  let authoredGeoPoints = 0;
  let localSpace: ReferenceMapCameraChildConfig["localSpace"];
  let atlas: ReferenceMapCameraChildConfig["atlas"];
  let routeSubject: ReferenceMapCameraChildConfig["routeSubject"];
  if (kind !== "annotation" && node.children.length !== 0) {
    fail(node, "CUT_MAP_CAMERA_GRAPH", `MapCamera-owned ${kind} is a retained geographic leaf and cannot own generic visual children.`);
  }
  if (kind === "map") atlas = validateMapStyle(node);
  else if (kind === "route") {
    authoredGeoPoints = pointList(node, node.inputs.points, "input “points”", 2, referenceMapCameraLimits.maximumRoutePointsPerRoute);
    if (node.inputs.color !== undefined && node.inputs.stroke !== undefined) fail(node, "CUT_MAP_CAMERA_CHILD", "Route color and stroke are aliases; supply exactly one.");
    rejectDefaultColor(node, "color", referenceMapCameraRetainedStyleDefaults.route.color);
    rejectDefaultColor(node, "stroke", referenceMapCameraRetainedStyleDefaults.route.color);
    rejectDefaultLength(node, "width", referenceMapCameraRetainedStyleDefaults.route.width);
  } else if (kind === "route-subject") {
    authoredGeoPoints = pointList(node, node.inputs.points, "input “points”", 2, referenceMapCameraLimits.maximumRoutePointsPerRoute);
    const authored = node.inputs.points;
    if (authored?.kind !== "array") fail(node, "CUT_MAP_CAMERA_CHILD", "RouteSubject points must be an inline List<GeoPoint>.");
    const exactPoint = (value: IRValue, label: string) => {
      if (value.kind !== "object") fail(node, "CUT_MAP_CAMERA_CHILD", `${label} must be one GeoPoint.`);
      return Object.freeze({
        latitude: scalar(node, value.entries.latitude, `${label}.latitude`, referenceMapCameraLimits.minimumLatitude, referenceMapCameraLimits.maximumLatitude),
        longitude: scalar(node, value.entries.longitude, `${label}.longitude`, referenceMapCameraLimits.minimumLongitude, referenceMapCameraLimits.maximumLongitude),
      });
    };
    const exact = authored.items.map((value, index) => exactPoint(value, `input “points”[${index}]`));
    const segmentAngularDistancesRadians = exact.slice(1).map((to, index) => {
      const from = exact[index]!;
      const sameLatitude = compareRational(from.latitude, to.latitude) === 0;
      const sameLongitude = compareRational(from.longitude, to.longitude) === 0;
      const antimeridianAliases = sameLatitude
        && ((compareRational(from.longitude, referenceMapCameraLimits.minimumLongitude) === 0
          && compareRational(to.longitude, referenceMapCameraLimits.maximumLongitude) === 0)
          || (compareRational(from.longitude, referenceMapCameraLimits.maximumLongitude) === 0
            && compareRational(to.longitude, referenceMapCameraLimits.minimumLongitude) === 0));
      const samePole = sameLatitude
        && (compareRational(from.latitude, referenceMapCameraLimits.minimumLatitude) === 0
          || compareRational(from.latitude, referenceMapCameraLimits.maximumLatitude) === 0);
      if ((sameLatitude && sameLongitude) || antimeridianAliases || samePole) {
        fail(node, "CUT_MAP_CAMERA_NOOP", `RouteSubject segment ${index} has zero spherical length; every consecutive authored point must be geographically distinct.`);
      }
      const radians = geoDistance(
        [rationalToNumber(from.longitude), rationalToNumber(from.latitude)],
        [rationalToNumber(to.longitude), rationalToNumber(to.latitude)],
      );
      if (!Number.isFinite(radians) || radians <= 0 || radians > Math.PI) {
        fail(node, radians === 0 ? "CUT_MAP_CAMERA_NOOP" : "CUT_MAP_CAMERA_CHILD", `RouteSubject segment ${index} has invalid d3-geo@3.1.1.geoDistance ${radians}.`);
      }
      return radians;
    });
    const totalAngularDistanceRadians = segmentAngularDistancesRadians.reduce((total, radians) => total + radians, 0);
    if (!Number.isFinite(totalAngularDistanceRadians) || totalAngularDistanceRadians <= 0) {
      fail(node, "CUT_MAP_CAMERA_NOOP", "RouteSubject route has zero total geographic length.");
    }
    rejectDefaultColor(node, "color", referenceMapCameraRetainedStyleDefaults.routeSubject.color);
    if (colorAlpha(node, "color") === 0) {
      fail(node, "CUT_MAP_CAMERA_NOOP", "RouteSubject color is fully transparent at every sample; author a visible color or omit it.");
    }
    rejectDefaultLength(node, "radius", referenceMapCameraRetainedStyleDefaults.routeSubject.radius);
    routeSubject = Object.freeze({
      algorithmVersion: referenceMapCameraRouteSubjectAlgorithmVersion,
      distanceAlgorithm: "d3-geo@3.1.1.geoDistance" as const,
      metric: "cumulative-spherical-great-circle-angular-distance" as const,
      interpolation: "d3-geo-geoInterpolate" as const,
      segments: authoredGeoPoints - 1,
      exactFrameSamples: activeTimes.length,
      segmentAngularDistancesRadians: Object.freeze(segmentAngularDistancesRadians),
      totalAngularDistanceRadians,
    });
  } else if (kind === "marker") {
    authoredGeoPoints = closedGeoPoint(node, node.inputs.point, "input “point”", true);
    rejectDefaultColor(node, "color", referenceMapCameraRetainedStyleDefaults.marker.color);
    rejectDefaultLength(node, "radius", referenceMapCameraRetainedStyleDefaults.marker.radius);
    const label = optionalString(node, "label"), embedded = pointHasLabel(node.inputs.point);
    if (label && embedded) fail(node, "CUT_MAP_CAMERA_CHILD", "Marker label duplicates point.label; author exactly one text source.");
    validateFont(node, ir, Boolean(label || embedded));
  } else if (kind === "wavefront") {
    authoredGeoPoints = closedGeoPoint(node, node.inputs.origin, "input “origin”", false);
    rejectDefaultColor(node, "color", referenceMapCameraRetainedStyleDefaults.wavefront.color);
    positiveLength(node, "radius");
    const count = optionalInteger(node, "count", 1, 12);
    if (count === referenceMapCameraRetainedStyleDefaults.wavefront.count) fail(node, "CUT_MAP_CAMERA_NOOP", `input “count” repeats the retained renderer default ${count}; omit it.`);
  } else if (kind === "connections") {
    const sources = ["points", "stations"].filter((name) => node.inputs[name] !== undefined);
    if (sources.length !== 1) fail(node, "CUT_MAP_CAMERA_CHILD", "Connections requires exactly one inline points or stations list in the phase-one planner.");
    authoredGeoPoints = pointList(node, node.inputs[sources[0]], `input “${sources[0]}”`, 1, referenceMapCameraLimits.maximumAuthoredGeoPointsPerCamera);
    authoredGeoPoints += closedGeoPoint(node, node.inputs.target, "input “target”", true);
    colorAlpha(node, "color"); positiveLength(node, "width");
    const count = optionalInteger(node, "count", 1, 500);
    if (count !== undefined && count > authoredGeoPoints - 1) fail(node, "CUT_MAP_CAMERA_NOOP", `input “count” ${count} exceeds the ${authoredGeoPoints - 1} authored source points.`);
    validateFont(node, ir, pointHasLabel(node.inputs.target));
  } else {
    authoredGeoPoints = closedGeoPoint(node, node.inputs.anchor, "input “anchor”", false);
    validateAnnotationStyle(node);
    if (node.inputs.width !== undefined || node.inputs.height !== undefined) {
      fail(node, "CUT_MAP_CAMERA_CHILD", "MapCamera-owned GeoAnnotation derives its viewport from LocalSpace; width and height are forbidden.");
    }
    if (node.children.length !== 1) fail(node, "CUT_MAP_CAMERA_GRAPH", `GeoAnnotation requires exactly one LocalSpace child; found ${node.children.length}.`);
    const localNode = ir.nodes[node.children[0]];
    if (!localNode || localNode.op !== "cut.visual.local_space") fail(node, "CUT_MAP_CAMERA_GRAPH", "GeoAnnotation's only child must be cut.visual.local_space.");
    if (localNode.domain !== "visual" || localNode.ownership !== "child") fail(localNode, "CUT_MAP_CAMERA_GRAPH", "annotation LocalSpace must be a directly owned visual child.");
    const localOwners = parents.get(localNode.id) ?? [];
    if (localOwners.length !== 1 || localOwners[0].id !== node.id) fail(localNode, "CUT_MAP_CAMERA_GRAPH", "annotation LocalSpace must have exactly one direct GeoAnnotation owner.");
    validateContainedInterval(node, localNode, "annotation LocalSpace");
    if (compareRational(localNode.interval.start, node.interval.start) !== 0
      || compareRational(localNode.interval.duration, node.interval.duration) !== 0) {
      fail(localNode, "CUT_MAP_CAMERA_INTERVAL", "annotation LocalSpace must exactly equal its GeoAnnotation half-open interval.");
    }
    const staticConfig = referenceLocalSpaceStaticConfig(localNode)!;
    for (const childId of localNode.children) {
      const localChild = ir.nodes[childId];
      if (!localChild) fail(localNode, "CUT_MAP_CAMERA_GRAPH", `annotation LocalSpace references missing child ${childId}.`);
      if (localChild.domain !== "visual" || localChild.ownership !== "child") fail(localChild, "CUT_MAP_CAMERA_GRAPH", "LocalSpace descendants must be directly owned visual nodes.");
      const childOwners = parents.get(localChild.id) ?? [];
      if (childOwners.length !== 1 || childOwners[0].id !== localNode.id) fail(localChild, "CUT_MAP_CAMERA_GRAPH", "LocalSpace descendant must have exactly one direct LocalSpace owner.");
      validateContainedInterval(localNode, localChild, "LocalSpace descendant");
    }
    localSpace = Object.freeze({
      nodeId: localNode.id,
      width: staticConfig.width,
      height: staticConfig.height,
      origin: Object.freeze({ ...staticConfig.origin }),
    });
  }
  return Object.freeze({
    nodeId: node.id,
    kind,
    sourceOrder,
    authoredGeoPoints,
    authoredInputs: Object.freeze(Object.keys(node.inputs).sort()),
    authoredProperties: Object.freeze(Object.keys(node.properties).sort()),
    semanticIdentity: nodeIdentity(ir, node.id),
    ...(routeSubject ? { routeSubject } : {}),
    ...(atlas ? { atlas } : {}),
    ...(localSpace ? { localSpace } : {}),
  });
}

function semanticValue(ir: CutAVIR, value: IRValue): unknown {
  if (value.kind === "resource-ref") {
    const resource = ir.resources[value.id];
    return { ...value, resource: resource ? { kind: resource.kind, locator: resource.locator, state: resource.state, sha256: resource.sha256, metadata: resource.metadata } : null };
  }
  if (value.kind === "array") return { ...value, items: value.items.map((item) => semanticValue(ir, item)) };
  if (value.kind === "object") return { ...value, entries: Object.fromEntries(Object.entries(value.entries).map(([name, item]) => [name, semanticValue(ir, item)])) };
  if (value.kind === "range") return { ...value, start: semanticValue(ir, value.start), end: semanticValue(ir, value.end) };
  if (value.kind === "unary") return { ...value, value: semanticValue(ir, value.value) };
  if (value.kind === "binary") return { ...value, left: semanticValue(ir, value.left), right: semanticValue(ir, value.right) };
  if (value.kind === "member") return { ...value, object: semanticValue(ir, value.object) };
  if (value.kind === "index") return { ...value, object: semanticValue(ir, value.object), index: semanticValue(ir, value.index) };
  if (value.kind === "call") return {
    ...value,
    positional: value.positional.map((item) => semanticValue(ir, item)),
    named: Object.fromEntries(Object.entries(value.named).map(([name, item]) => [name, semanticValue(ir, item)])),
  };
  return value;
}

function nodeIdentity(ir: CutAVIR, nodeId: string, memo = new Map<string, string>(), visiting = new Set<string>()): string {
  const cached = memo.get(nodeId);
  if (cached) return cached;
  const node = ir.nodes[nodeId];
  if (!node) throw new Error(`CUT MapCamera identity references missing node ${nodeId}.`);
  if (visiting.has(nodeId)) fail(node, "CUT_MAP_CAMERA_GRAPH", `semantic identity found a child cycle at ${nodeId}.`);
  visiting.add(nodeId);
  const identity = hash({
    op: node.op,
    domain: node.domain,
    ownership: node.ownership,
    interval: node.interval,
    inputs: Object.fromEntries(Object.entries(node.inputs).map(([name, value]) => [name, semanticValue(ir, value)])),
    properties: Object.fromEntries(Object.entries(node.properties).map(([name, authored]) => [name, "signal" in authored
      ? { signal: authored.signal, semantic: ir.signals[authored.signal] ? Object.fromEntries(Object.entries(ir.signals[authored.signal]).filter(([key]) => key !== "provenance" && key !== "contentHash")) : null }
      : semanticValue(ir, authored)])),
    children: node.children.map((child) => ({ id: child, identity: nodeIdentity(ir, child, memo, visiting) })),
    effects: node.effects,
    editorial: node.editorial,
  });
  visiting.delete(nodeId);
  memo.set(nodeId, identity);
  return identity;
}

export function referenceMapCameraStateAt(ir: CutAVIR, node: IRNode, time: Rational): ReferenceMapCameraState {
  const bearing = Object.freeze({ ...valueAt(ir, node, "bearing", time) });
  const effectiveBearing = Object.freeze({ ...effectiveBearingExact(bearing) });
  const exact = Object.freeze({
    latitude: Object.freeze({ ...valueAt(ir, node, "latitude", time) }),
    longitude: Object.freeze({ ...valueAt(ir, node, "longitude", time) }),
    scale: Object.freeze({ ...valueAt(ir, node, "scale", time) }),
    bearing,
    effectiveBearing,
    pitch: Object.freeze({ ...valueAt(ir, node, "pitch", time) }),
  });
  return Object.freeze({
    latitude: rationalToNumber(exact.latitude),
    longitude: rationalToNumber(exact.longitude),
    scale: rationalToNumber(exact.scale),
    bearing: rationalToNumber(exact.bearing),
    effectiveBearing: rationalToNumber(exact.effectiveBearing),
    pitch: rationalToNumber(exact.pitch),
    exact,
  });
}

function cameraConfig(ir: CutAVIR, composition: IRComposition, node: IRNode, parents: ReadonlyMap<string, readonly IRNode[]>) {
  const nestedOwner = Object.values(ir.nodes).find((candidate) => {
    if (candidate.op !== "cut.visual.precomp" && candidate.op !== "cut.edit.nested_sequence") return false;
    const source = candidate.inputs.source;
    return source?.kind === "timeline-ref" && source.id === composition.id;
  });
  if (nestedOwner) {
    fail(node, "CUT_MAP_CAMERA_GRAPH", `phase-one MapCamera cannot execute inside composition ${composition.id} because ${nestedOwner.op} ${nestedOwner.id} instantiates that timeline and would resample its final-space raster; render the MapCamera composition directly.`);
  }
  if (node.domain !== "visual" || node.ownership !== "root") fail(node, "CUT_MAP_CAMERA_GRAPH", `phase-one MapCamera must be an untransformed scene-root visual; found domain ${node.domain}, ownership ${node.ownership}.`);
  if ((parents.get(node.id) ?? []).length) fail(node, "CUT_MAP_CAMERA_GRAPH", "phase-one MapCamera cannot have a visual parent that could resample its final-space raster.");
  if (node.effects.some((effect) => effect !== "pure")) fail(node, "CUT_MAP_CAMERA_GRAPH", "phase-one MapCamera cannot carry an effectful wrapper around its final-space raster.");
  if (node.children.length < 1 || node.children.length > referenceMapCameraLimits.maximumDirectChildren) {
    fail(node, node.children.length > referenceMapCameraLimits.maximumDirectChildren ? "CUT_MAP_CAMERA_LIMIT" : "CUT_MAP_CAMERA_GRAPH", `requires 1 through ${referenceMapCameraLimits.maximumDirectChildren} direct geographic children; found ${node.children.length}.`);
  }
  if (new Set(node.children).size !== node.children.length) fail(node, "CUT_MAP_CAMERA_GRAPH", "direct child IDs must be unique and source ordered.");
  const times = referenceMapCameraValidationTimes(composition, node);
  validateCameraControls(ir, node, times);
  const children = node.children.map((childId, sourceOrder) => {
    const child = ir.nodes[childId];
    if (!child) fail(node, "CUT_MAP_CAMERA_GRAPH", `references missing direct child ${childId}.`);
    const kind = childKinds.get(child.op);
    if (!kind) fail(child, "CUT_MAP_CAMERA_GRAPH", `direct child ${child.op} is outside the closed retained geographic grammar.`);
    return childConfig(ir, node, child, kind, sourceOrder, parents, times);
  });
  const maps = children.filter((child) => child.kind === "map").length;
  if (maps > referenceMapCameraLimits.maximumMaps) fail(node, "CUT_MAP_CAMERA_LIMIT", `accepts at most one direct Map; found ${maps}.`);
  if (children.every((child) => child.kind === "annotation")) {
    fail(node, "CUT_MAP_CAMERA_GRAPH", "requires at least one retained Map, Route, RouteSubject, Marker, Wavefront, or Connections leaf beneath its delivery-space annotations.");
  }
  const annotations = children.filter((child) => child.kind === "annotation").length;
  if (annotations > referenceMapCameraLimits.maximumAnnotationsPerCamera) fail(node, "CUT_MAP_CAMERA_LIMIT", `accepts at most ${referenceMapCameraLimits.maximumAnnotationsPerCamera} annotations; found ${annotations}.`);
  const authoredGeoPoints = children.reduce((total, child) => total + child.authoredGeoPoints, 0);
  if (!Number.isSafeInteger(authoredGeoPoints) || authoredGeoPoints > referenceMapCameraLimits.maximumAuthoredGeoPointsPerCamera) {
    fail(node, "CUT_MAP_CAMERA_LIMIT", `authored geographic points total ${authoredGeoPoints}; the camera limit is ${referenceMapCameraLimits.maximumAuthoredGeoPointsPerCamera}.`);
  }
  const routeSubjectSegments = children.reduce((total, child) => total + (child.routeSubject?.segments ?? 0), 0);
  const routeSubjectSegmentFrameEvaluations = children.reduce(
    (total, child) => total + (child.routeSubject
      ? child.routeSubject.segments * child.routeSubject.exactFrameSamples
      : 0),
    0,
  );
  if (!Number.isSafeInteger(routeSubjectSegments)
    || !Number.isSafeInteger(routeSubjectSegmentFrameEvaluations)
    || routeSubjectSegmentFrameEvaluations > referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations) {
    fail(
      node,
      "CUT_MAP_CAMERA_LIMIT",
      `RouteSubject paths require ${routeSubjectSegmentFrameEvaluations} segment × exact-frame evaluations; the camera limit is ${referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations}.`,
    );
  }
  const deliveryPixels = composition.width * composition.height;
  if (!Number.isSafeInteger(deliveryPixels) || deliveryPixels < 1) fail(node, "CUT_MAP_CAMERA_LIMIT", "one delivery raster does not fit safe-integer work accounting.");

  const activeChildIds = new Set<string>();
  const states = new Set<string>();
  for (const time of times) {
    const activeChildren = children.filter((child) => {
      const childNode = ir.nodes[child.nodeId]!;
      if (!active(childNode, time)) return false;
      if (child.localSpace && !active(ir.nodes[child.localSpace.nodeId]!, time)) return false;
      if (compareRational(ratioAt(ir, childNode, "opacity", time), rational(0)) <= 0) return false;
      if ((child.kind === "route" || child.kind === "wavefront" || child.kind === "connections")
        && compareRational(ratioAt(ir, childNode, "reveal", time), rational(0)) <= 0) return false;
      return true;
    });
    if (!activeChildren.length) fail(node, "CUT_MAP_CAMERA_NOOP", `has no active direct child at exact output sample ${time.numerator}/${time.denominator}s.`);
    if (!activeChildren.some((child) => child.kind !== "annotation")) {
      fail(node, "CUT_MAP_CAMERA_NOOP", `has only annotation overlays and no retained geographic raster child at exact output sample ${time.numerator}/${time.denominator}s.`);
    }
    activeChildren.forEach((child) => activeChildIds.add(child.nodeId));
    const state = referenceMapCameraStateAt(ir, node, time);
    states.add(`${state.exact.latitude.numerator}/${state.exact.latitude.denominator}|${state.exact.longitude.numerator}/${state.exact.longitude.denominator}|${state.exact.scale.numerator}/${state.exact.scale.denominator}|${state.exact.effectiveBearing.numerator}/${state.exact.effectiveBearing.denominator}|${state.exact.pitch.numerator}/${state.exact.pitch.denominator}`);
  }
  for (const child of children) if (!activeChildIds.has(child.nodeId)) {
    fail(ir.nodes[child.nodeId]!, "CUT_MAP_CAMERA_NOOP", "has no active exact output-frame sample inside its owning MapCamera interval.");
  }
  const semanticIdentity = hash({
    algorithmVersion: referenceMapCameraAlgorithmVersion,
    projectionAlgorithm: referenceGeoMapCameraProjectionAlgorithm,
    delivery: { width: composition.width, height: composition.height, fps: composition.fps },
    cameraSubgraph: nodeIdentity(ir, node.id),
    atlasIdentity: referenceMapCameraAtlasIdentity,
    selectedAtlases: children.flatMap((child) => child.atlas ? [{ nodeId: child.nodeId, ...child.atlas }] : []),
    ...(children.some((child) => child.kind === "route-subject")
      ? { routeSubjectAlgorithmVersion: referenceMapCameraRouteSubjectAlgorithmVersion }
      : {}),
    modules: ir.modules,
  });
  return Object.freeze({
    nodeId: node.id,
    projectionAlgorithm: referenceGeoMapCameraProjectionAlgorithm,
    children: Object.freeze(children),
    authoredGeoPoints,
    semanticIdentity,
    validation: Object.freeze({
      exactSamples: times.length,
      activeChildIds: Object.freeze([...activeChildIds]),
      distinctCameraStates: states.size,
      routeSubjectSegments,
      routeSubjectSegmentFrameEvaluations,
      routeSubjectSegmentFrameEvaluationLimit: referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations,
    }),
  });
}

/**
 * Validate all selected phase-one camera graphs and the composition-wide exact
 * sample ceiling. This does not register a public language symbol or renderer.
 */
export function validateReferenceMapCameraGraph(ir: CutAVIR, composition: IRComposition, selectedNodeIds?: ReadonlySet<string>) {
  const selected = (node: IRNode) => selectedNodeIds === undefined || selectedNodeIds.has(node.id);
  const parents = directParents(ir);
  const configs = new Map<string, ReferenceMapCameraConfig>();
  let samples = 0;
  for (const node of Object.values(ir.nodes)) {
    if (!selected(node) || node.op !== "cut.geo.map_camera") continue;
    const config = cameraConfig(ir, composition, node, parents);
    samples += config.validation.exactSamples;
    if (!Number.isSafeInteger(samples) || samples > referenceMapCameraLimits.maximumValidationSamplesPerComposition) {
      fail(node, "CUT_MAP_CAMERA_LIMIT", `composition MapCamera plans require ${samples} exact samples; the limit is ${referenceMapCameraLimits.maximumValidationSamplesPerComposition}.`);
    }
    configs.set(node.id, config);
  }
  return configs;
}

function mapAnnotationOpacityIdentity(ir: CutAVIR, node: IRNode) {
  const property = node.properties.opacity;
  const signal = property && "signal" in property ? ir.signals[property.signal] : undefined;
  return hash({ input: node.inputs.opacity, property, signal: signal ? { id: signal.id, contentHash: signal.contentHash } : undefined });
}

/** Resolve MapCamera annotations through the same final Q_t projection used by
 * retained routes and markers. This function performs no raster work. */
export function referenceMapCameraGeoAnnotationPlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  cameraConfig: ReferenceMapCameraConfig,
  annotationConfig: ReferenceMapCameraAnnotationConfig,
  time: Rational,
  priorityOverrides: ReadonlyMap<string, number> = new Map(),
): ReferenceGeoAnnotationFramePlan {
  const camera = ir.nodes[cameraConfig.nodeId];
  if (!camera || camera.op !== "cut.geo.map_camera" || annotationConfig.cameraId !== camera.id) {
    const node = ir.nodes[annotationConfig.annotations[0]?.config.nodeId ?? cameraConfig.nodeId];
    if (!node) throw new Error(`CUT MapCamera annotation owner ${cameraConfig.nodeId} is missing.`);
    throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_GRAPH", node, `retained annotation configuration does not belong to MapCamera ${cameraConfig.nodeId}.`);
  }
  const state = referenceMapCameraStateAt(ir, camera, time);
  const entries = Object.freeze(annotationConfig.annotations.flatMap((binding): ReferenceGeoAnnotationProjectedEntry[] => {
    const node = ir.nodes[binding.config.nodeId], local = binding.config.localSpace ? ir.nodes[binding.config.localSpace.nodeId] : undefined;
    if (!node || !referenceGeoAnnotationActive(node, time) || (local && !referenceGeoAnnotationActive(local, time))) return [];
    let projected: readonly [number, number];
    try {
      projected = referenceGeoMapCameraPoint(
        composition.width,
        composition.height,
        { latitude: state.latitude, longitude: state.longitude },
        state.scale,
        binding.config.anchor,
        state.effectiveBearing,
        state.pitch,
      );
      if (binding.config.anchor.latitude === state.latitude && binding.config.anchor.longitude === state.longitude) {
        const center: readonly [number, number] = [composition.width / 2, composition.height / 2];
        if (Math.abs(projected[0] - center[0]) > 1e-9 || Math.abs(projected[1] - center[1]) > 1e-9) {
          throw new Error(`camera-centre anchor resolved to ${projected[0]},${projected[1]} instead of ${center[0]},${center[1]}`);
        }
        projected = center;
      }
    } catch (error) {
      throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_PROJECTION", node, `failed MapCamera's exact Q_t projection: ${error instanceof Error ? error.message : String(error)}.`);
    }
    return [Object.freeze({
      config: binding.config,
      layerId: camera.id,
      layerSourceOrder: 0,
      childSourceOrder: binding.sourceOrder,
      anchor: Object.freeze({ x: projected[0], y: projected[1] }),
      opacity: referenceGeoAnnotationOpacityAt(ir, node, time),
      opacitySemanticIdentity: mapAnnotationOpacityIdentity(ir, node),
      childSemanticIdentity: binding.childSemanticIdentity,
      retainedChildSurfaceIds: Object.freeze([]),
      layerMatrix: referenceIdentityAffine2D,
    })];
  }));
  return resolveReferenceGeoAnnotationsAt(ir, composition, time, entries, {
    nodeId: camera.id,
    state: Object.freeze({
      latitude: state.latitude,
      longitude: state.longitude,
      scale: state.scale,
      bearing: state.bearing,
      effectiveBearing: state.effectiveBearing,
      pitch: state.pitch,
    }),
    semanticIdentity: cameraConfig.semanticIdentity,
  }, priorityOverrides, referenceGeoAnnotationMapCameraAlgorithmVersion);
}

function sameMapAnnotationPlacement(left: ReturnType<typeof referenceMapCameraGeoAnnotationPlanAt>["decisions"][number] | undefined, right: ReturnType<typeof referenceMapCameraGeoAnnotationPlanAt>["decisions"][number] | undefined) {
  return left?.status === right?.status
    && left?.chosenPlacement === right?.chosenPlacement
    && left?.chosenPlacementIndex === right?.chosenPlacementIndex;
}

/** Validate the LocalSpace-backed annotation subgrammar across every bounded
 * exact MapCamera output sample before rendering atlas or tile bytes. */
export function validateReferenceMapCameraGeoAnnotations(
  ir: CutAVIR,
  composition: IRComposition,
  cameraConfig: ReferenceMapCameraConfig,
): ReferenceMapCameraAnnotationConfig | undefined {
  const camera = ir.nodes[cameraConfig.nodeId];
  if (!camera) throw new Error(`CUT MapCamera ${cameraConfig.nodeId} is missing.`);
  const bindings = Object.freeze(cameraConfig.children.flatMap((child): ReferenceMapCameraAnnotationBinding[] => {
    if (child.kind !== "annotation") return [];
    const node = ir.nodes[child.nodeId], config = node ? referenceGeoAnnotationConfig(ir, composition, node) : undefined;
    if (!node || !config || !config.localSpace || config.childId !== child.localSpace?.nodeId) {
      if (!node) throw new Error(`CUT MapCamera annotation ${child.nodeId} is missing.`);
      throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_VIEWPORT", node, "MapCamera requires the exact direct LocalSpace retained-tile form.");
    }
    return [Object.freeze({ config, sourceOrder: child.sourceOrder, childSemanticIdentity: child.semanticIdentity })];
  }));
  if (!bindings.length) return undefined;

  const provisional: ReferenceMapCameraAnnotationConfig = Object.freeze({
    cameraId: camera.id,
    annotations: bindings,
    validation: Object.freeze({ exactSamples: 0, fallbackReached: Object.freeze({}), priorityAffected: Object.freeze([]), everAccepted: Object.freeze([]) }),
  });
  const times = referenceMapCameraValidationTimes(composition, camera);
  const fallbackReached = new Map(bindings.map((binding) => [binding.config.nodeId, new Set<number>([0])]));
  const priorityAffected = new Set<string>(), everAccepted = new Set<string>(), rgba8VisibleOpacity = new Set<string>();
  const sampledOpacity = new Map<string, Set<number>>();
  for (const time of times) {
    const plan = referenceMapCameraGeoAnnotationPlanAt(ir, composition, cameraConfig, provisional, time);
    for (const decision of plan.decisions) {
      if (Math.round(255 * decision.opacity) > 0) rgba8VisibleOpacity.add(decision.nodeId);
      const values = sampledOpacity.get(decision.nodeId) ?? new Set<number>();
      values.add(decision.opacity); sampledOpacity.set(decision.nodeId, values);
      if (decision.status === "accepted") {
        everAccepted.add(decision.nodeId);
        fallbackReached.get(decision.nodeId)?.add(decision.chosenPlacementIndex!);
      }
    }
    for (const binding of bindings.filter((candidate) => candidate.config.priorityAuthored)) {
      const reset = referenceMapCameraGeoAnnotationPlanAt(ir, composition, cameraConfig, provisional, time, new Map([[binding.config.nodeId, 0]]));
      const actualDecision = plan.decisions.find((decision) => decision.nodeId === binding.config.nodeId);
      const resetDecision = reset.decisions.find((decision) => decision.nodeId === binding.config.nodeId);
      if (!sameMapAnnotationPlacement(actualDecision, resetDecision)) priorityAffected.add(binding.config.nodeId);
    }
  }
  for (const binding of bindings) {
    const node = ir.nodes[binding.config.nodeId]!;
    if (!rgba8VisibleOpacity.has(node.id)) throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_NOOP", node, "opacity never reaches the first fully-opaque RGBA8 visibility step at an exact MapCamera sample.");
    if (!everAccepted.has(node.id)) throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_NOOP", node, "never produces an accepted MapCamera viewport at any exact sample.");
    const reached = fallbackReached.get(node.id)!;
    for (let index = 1; index < binding.config.placements.length; index += 1) if (!reached.has(index)) {
      throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_NOOP", node, `placement fallback index ${index} (${binding.config.placements[index]}) is never selected at a bounded exact MapCamera sample.`);
    }
    if (binding.config.priorityAuthored && !priorityAffected.has(node.id)) {
      throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_NOOP", node, "authored priority does not change MapCamera placement or visibility versus priority zero at any bounded exact sample.");
    }
    const baseline = node.inputs.opacity?.kind === "quantity" ? rationalToNumber(node.inputs.opacity.magnitude) : 1;
    if (node.properties.opacity !== undefined && [...(sampledOpacity.get(node.id) ?? [])].every((value) => value === baseline)) {
      throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_NOOP", node, "authored opacity property never differs from its constructor/default baseline at an exact MapCamera sample.");
    }
  }
  return Object.freeze({
    cameraId: camera.id,
    annotations: bindings,
    validation: Object.freeze({
      exactSamples: times.length,
      fallbackReached: Object.freeze(Object.fromEntries([...fallbackReached].map(([id, values]) => [id, Object.freeze([...values].sort((left, right) => left - right))]))),
      priorityAffected: Object.freeze([...priorityAffected].sort()),
      everAccepted: Object.freeze([...everAccepted].sort()),
    }),
  });
}

/** Resolve one immutable planning receipt. It is intentionally not render evidence. */
export function referenceMapCameraPlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  config: ReferenceMapCameraConfig,
  time: Rational,
  backendIdentity = referenceMapCameraPlanBackendIdentity,
): ReferenceMapCameraPlanningFrame {
  const node = ir.nodes[config.nodeId];
  if (!node || node.op !== "cut.geo.map_camera") throw new Error(`Internal CUT MapCamera ${config.nodeId} is missing.`);
  if (!active(node, time)) fail(node, "CUT_MAP_CAMERA_INTERVAL", `planning time ${time.numerator}/${time.denominator}s is outside the camera interval.`);
  const state = referenceMapCameraStateAt(ir, node, time);
  let projectedCenter: readonly [number, number];
  try {
    const measured = referenceGeoMapCameraPoint(
      composition.width,
      composition.height,
      { latitude: state.latitude, longitude: state.longitude },
      state.scale,
      { latitude: state.latitude, longitude: state.longitude },
      state.effectiveBearing,
      state.pitch,
    );
    const center: readonly [number, number] = [composition.width / 2, composition.height / 2];
    if (Math.abs(measured[0] - center[0]) > 1e-9 || Math.abs(measured[1] - center[1]) > 1e-9) {
      fail(node, "CUT_MAP_CAMERA_PROJECTION", `sampled camera centre resolved to ${measured[0]},${measured[1]} instead of exact delivery centre ${center[0]},${center[1]}.`);
    }
    // Q_t(center)=C algebraically. d3's transcendental implementation can
    // return an IEEE-754 ulp around C, so the plan publishes the exact
    // delivery-space invariant after verifying the measured result above.
    projectedCenter = Object.freeze([...center]) as readonly [number, number];
  } catch (error) {
    if (error instanceof ReferenceMapCameraError) throw error;
    fail(node, "CUT_MAP_CAMERA_PROJECTION", `sampled projection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const activeChildren = Object.freeze(config.children.filter((child) => {
    const childNode = ir.nodes[child.nodeId];
    return Boolean(childNode
      && active(childNode, time)
      && (!child.localSpace || active(ir.nodes[child.localSpace.nodeId]!, time))
      && compareRational(ratioAt(ir, childNode, "opacity", time), rational(0)) > 0
      && ((child.kind !== "route" && child.kind !== "wavefront" && child.kind !== "connections")
        || compareRational(ratioAt(ir, childNode, "reveal", time), rational(0)) > 0));
  }).map((child) => Object.freeze({ nodeId: child.nodeId, kind: child.kind, sourceOrder: child.sourceOrder })));
  if (!activeChildren.length) fail(node, "CUT_MAP_CAMERA_NOOP", "planning sample has no active retained geographic child.");
  const deliveryPixels = composition.width * composition.height;
  const activeChildIds = new Set(activeChildren.map((child) => child.nodeId));
  const work = Object.freeze({
    activeChildren: activeChildren.length,
    authoredGeoPoints: config.authoredGeoPoints,
    atlasCoordinateRecords: config.children.reduce((total, child) => total + (activeChildIds.has(child.nodeId) ? child.atlas?.coordinateRecords ?? 0 : 0), 0),
    plannedDeliveryRasterPixels: deliveryPixels,
    canonicalDrawingStreamByteLimit: referenceMapCameraLimits.maximumCanonicalDrawingStreamBytesPerSample,
    routeSubjectSegments: config.validation.routeSubjectSegments,
    routeSubjectSegmentFrameEvaluations: config.validation.routeSubjectSegmentFrameEvaluations,
    routeSubjectSegmentFrameEvaluationLimit: config.validation.routeSubjectSegmentFrameEvaluationLimit,
  });
  const planCacheIdentity = hash({
    algorithmVersion: referenceMapCameraAlgorithmVersion,
    projectionAlgorithm: referenceGeoMapCameraProjectionAlgorithm,
    backendIdentity,
    semanticIdentity: config.semanticIdentity,
    exactTime: time,
    state: state.exact,
    activeChildren,
    work,
    executionKind: "preflight-plan-not-render-evidence",
  });
  return Object.freeze({
    format: "cut-reference-map-camera-planning-frame",
    version: 4,
    evidenceKind: "preflight-plan-not-render-evidence",
    algorithmVersion: referenceMapCameraAlgorithmVersion,
    projectionAlgorithm: referenceGeoMapCameraProjectionAlgorithm,
    exactTime: Object.freeze({ ...time }),
    state,
    projectedCenter,
    finalClip: Object.freeze({ left: 0 as const, top: 0 as const, right: composition.width, bottom: composition.height }),
    activeChildren,
    pipelineRequired: Object.freeze([
      "sample-exact-camera-and-child-signals",
      "project-visible-geometry-in-final-space",
      "apply-bounded-projective-pitch-in-final-space",
      "clip-and-canonicalize-drawing-stream",
      "rasterize-once-at-delivery-resolution",
      "place-local-space-annotations",
      "composite-without-resize",
    ] as const),
    execution: Object.freeze({
      retainedGeometry: "not-executed" as const,
      raster: "not-executed" as const,
      requiredRasterPasses: 1 as const,
      requiredResamplePasses: 0 as const,
    }),
    work,
    semanticIdentity: config.semanticIdentity,
    planCacheIdentity,
  });
}

/** Machine-facing static inspect projection. Pixel/cache evidence remains a
 * same-frame runtime receipt and is never inferred here. */
export function referenceMapCameraInspectPlan(ir: CutAVIR, composition: IRComposition, config: ReferenceMapCameraConfig) {
  const node = ir.nodes[config.nodeId];
  if (!node) throw new Error(`Internal CUT MapCamera ${config.nodeId} is missing.`);
  const sample = referenceMapCameraPlanAt(ir, composition, config, referenceMapCameraValidationTimes(composition, node)[0]);
  return Object.freeze({
    kind: "retained-geographic-camera" as const,
    status: "public-reference-runtime-executable" as const,
    algorithmVersion: referenceMapCameraAlgorithmVersion,
    projection: Object.freeze({
      algorithm: referenceGeoMapCameraProjectionAlgorithm,
      selector: false,
      formula: "q=C+R_b(t)*(scale(t)*(P(g)-P(center(t)))); Q=C+H_pitch(t)*(q-C)" as const,
      defaultState: Object.freeze({ latitude: 0, longitude: 0, scale: 1, bearing: 0, effectiveBearing: 0, pitch: 0 }),
      latitudeRange: Object.freeze([-90, 90] as const),
      longitudeRange: Object.freeze([-180, 180] as const),
      scaleRange: Object.freeze([0.25, 64] as const),
      bearing: Object.freeze({
        supported: true as const,
        unit: "deg" as const,
        default: 0 as const,
        authoredRange: Object.freeze([-360_000, 360_000] as const),
        effectiveRange: "[0,360)" as const,
        effectiveModulo: 360 as const,
        positiveCameraHeading: "clockwise" as const,
        projectedGeography: "counterclockwise" as const,
        interpolation: "unwrapped-no-shortest-path" as const,
      }),
      pitch: Object.freeze({
        supported: true as const,
        unit: "deg" as const,
        default: 0 as const,
        authoredRange: Object.freeze([0, 60] as const),
        positiveDirection: "top-far-bottom-near" as const,
        transformOrder: "bearing-then-pitch" as const,
        model: "bounded-flat-plane-projective" as const,
        deliveryHeightFocalDistance: true as const,
        preimageExpansionLimit: 8 as const,
      }),
      threeDimensional: false as const,
    }),
    children: config.children.map((child) => ({
      nodeId: child.nodeId,
      kind: child.kind,
      sourceOrder: child.sourceOrder,
      authoredGeoPoints: child.authoredGeoPoints,
      authoredInputs: [...child.authoredInputs],
      authoredProperties: [...child.authoredProperties],
      semanticIdentity: child.semanticIdentity,
      ...(child.routeSubject ? { routeSubject: { ...child.routeSubject } } : {}),
      ...(child.atlas ? { atlas: { ...child.atlas } } : {}),
      ...(child.localSpace ? { localSpace: { ...child.localSpace, origin: { ...child.localSpace.origin } } } : {}),
    })),
    validation: { ...config.validation, activeChildIds: [...config.validation.activeChildIds] },
    inspectionSample: sample,
    runtime: Object.freeze({
      publicSource: true as const,
      checkerAndTypedIr: true as const,
      hostileIrLoader: true as const,
      finalSpaceRetainedRaster: true as const,
      finalSpaceRasterAlgorithm: referenceMapCameraFinalSpaceRasterAlgorithmVersion,
      localSpaceAnnotationPlacement: config.children.some((child) => child.kind === "annotation"),
      cache: "renderer-invocation-canonical-raster-cache-no-persistent-cache" as const,
      frameEvidence: "cut-reference-map-camera-public-frame-evidence-v5" as const,
    }),
    limitations: Object.freeze([
      "Connections remains source-refused inside MapCamera because its public DataAsset API is not the retained inline-point contract",
      "Marker labels/fonts and second projection/transform controls are source-refused inside MapCamera",
      "pitch is a bounded flat-plane projective camera only; terrain, 3D buildings, occlusion, lighting, and globe-camera behavior remain unsupported",
      "this static inspect sample is not pixel, persistent-cache-locality, cross-platform, or creative-playback evidence; use cut frame/render receipts and watch the output",
    ]),
  });
}

export function referenceMapCameraGeoAnnotationInspect(
  ir: CutAVIR,
  composition: IRComposition,
  cameraConfig: ReferenceMapCameraConfig,
  annotationConfig: ReferenceMapCameraAnnotationConfig,
) {
  const camera = ir.nodes[cameraConfig.nodeId];
  if (!camera) throw new Error(`Internal CUT MapCamera ${cameraConfig.nodeId} is missing.`);
  const exactTime = referenceMapCameraValidationTimes(composition, camera)[0];
  const plan = referenceMapCameraGeoAnnotationPlanAt(ir, composition, cameraConfig, annotationConfig, exactTime);
  return new Map(annotationConfig.annotations.map((binding) => {
    const decision = plan.decisions.find((candidate) => candidate.nodeId === binding.config.nodeId);
    if (!decision) throw new Error(`Internal CUT MapCamera GeoAnnotation ${binding.config.nodeId} has no first-sample decision.`);
    return [binding.config.nodeId, Object.freeze({
      kind: "fixed-map-camera-local-space-overlay" as const,
      algorithmVersion: referenceGeoMapCameraProjectionAlgorithm,
      owningCameraId: camera.id,
      structuralOrder: binding.sourceOrder,
      anchor: { ...binding.config.anchor },
      viewport: Object.freeze({
        width: binding.config.width,
        height: binding.config.height,
        source: "direct-LocalSpace-retained-tile" as const,
        localSpaceId: binding.config.localSpace!.nodeId,
        origin: { ...binding.config.localSpace!.origin },
        legacyDeliveryCanvasCrop: false as const,
        coordinateSpace: "MapCamera-output-delivery-pixels" as const,
      }),
      projection: "q=C+R_b(t)*(scale(t)*(P(g)-P(center(t)))); Q=C+H_pitch(t)*(q-C)" as const,
      validation: Object.freeze({
        exactSamples: annotationConfig.validation.exactSamples,
        fallbackReached: annotationConfig.validation.fallbackReached[binding.config.nodeId] ?? [],
        priorityAffected: annotationConfig.validation.priorityAffected.includes(binding.config.nodeId),
        everAccepted: annotationConfig.validation.everAccepted.includes(binding.config.nodeId),
      }),
      firstSample: Object.freeze({ exactTime: { ...plan.exactTime }, camera: { ...plan.camera }, decision: { ...decision }, decisionIdentity: plan.decisionIdentity, work: { ...plan.work } }),
    })];
  }));
}
