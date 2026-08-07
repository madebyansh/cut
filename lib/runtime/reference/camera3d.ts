import { createHash } from "node:crypto";
import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import { addRational, compareRational, rational, rationalToNumber, type Rational } from "../../language/rational";
import { propertyAt } from "./signals";
import {
  planReferenceProjectiveWarp,
  ReferenceProjectiveWarpError,
  referenceProjectiveWarpPhaseUnits,
  referenceProjectiveWarpLimits,
  type ReferenceProjectiveQuad,
  type ReferenceProjectiveWarpPlan,
} from "./projective-warp-kernel";
import {
  referenceLocalSpaceTileIdentity,
  validateReferenceLocalSpaceGraph,
  type ReferenceLocalSpaceConfig,
} from "./local-space";

/**
 * CUT's first Camera3D slice is deliberately planar and retained. It maps a
 * bounded set of LocalSpace rectangles through one closed look-at camera and
 * the existing exact-Q16 projective warp. It is not a mesh, light, z-buffer,
 * depth-of-field, or general 3D engine.
 */
export const referenceCamera3DAlgorithmVersion = "cut-reference-camera3d-planar-v1" as const;
export const referenceCamera3DModel = "planar-3d" as const;
export const referenceCamera3DFrameEvidenceFormat = "cut-reference-camera3d-frame-evidence" as const;

export const referenceCamera3DLimits = Object.freeze({
  minimumPlanes: 2,
  maximumPlanes: 16,
  minimumFocalLengthPx: 1,
  maximumFocalLengthPx: 65_536,
  maximumAbsoluteCoordinatePx: 65_536,
  maximumAbsoluteAngleDeg: 360_000,
  minimumScale: 1 / 1_024,
  maximumScale: 64,
  nearPlanePx: 1,
  minimumLookAtRightLength: 1 / 4_096,
  maximumValidationFrameSamples: 250_000,
  maximumAggregateDestinationPixelTests: 268_435_456,
  maximumAggregateDestinationRgbaBytes: 1_073_741_824,
});

export type ReferenceCamera3DErrorCode =
  | "CUT_CAMERA3D_TYPE"
  | "CUT_CAMERA3D_GRAPH"
  | "CUT_CAMERA3D_RANGE"
  | "CUT_CAMERA3D_LOOK_AT_UNSUPPORTED"
  | "CUT_CAMERA3D_NEAR_PLANE_UNSUPPORTED"
  | "CUT_CAMERA3D_BACKFACE_UNSUPPORTED"
  | "CUT_CAMERA3D_OCCLUSION_UNSUPPORTED"
  | "CUT_CAMERA3D_PROJECTIVE"
  | "CUT_CAMERA3D_MOTION_BLUR_UNSUPPORTED"
  | "CUT_CAMERA3D_LIMIT"
  | "CUT_CAMERA3D_NOOP";

export class ReferenceCamera3DError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceCamera3DErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    const name = node.op === "cut.visual.plane3d" ? "Plane3D" : "Camera3D";
    super(`${code}: ${name} at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceCamera3DError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

type Vec3 = Readonly<{ x: number; y: number; z: number }>;
type Matrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export type ReferencePlane3DConfig = Readonly<{
  nodeId: string;
  localSpaceNodeId: string;
  sourceOrder: number;
  edge: "transparent";
  localSpace: ReferenceLocalSpaceConfig;
  semanticIdentity: string;
}>;

export type ReferenceCamera3DConfig = Readonly<{
  nodeId: string;
  model: typeof referenceCamera3DModel;
  planes: readonly ReferencePlane3DConfig[];
  semanticIdentity: string;
}>;

export type ReferenceCamera3DState = Readonly<{
  focalLength: number;
  position: Vec3;
  target: Vec3;
  roll: number;
}>;

export type ReferencePlane3DState = Readonly<{
  position: Vec3;
  rotation: Vec3;
  scale: number;
  opacity: number;
}>;

export type ReferenceCamera3DVisiblePlanePlan = Readonly<{
  status: "visible";
  nodeId: string;
  localSpaceNodeId: string;
  sourceOrder: number;
  paintOrder: number;
  edge: "transparent";
  state: ReferencePlane3DState;
  worldMatrix: Matrix4;
  cameraCorners: readonly [Vec3, Vec3, Vec3, Vec3];
  depthInterval: Readonly<{ minimum: number; maximum: number }>;
  projectedQuad: ReferenceProjectiveQuad;
  intersectsOutput: boolean;
  projectivePlan: ReferenceProjectiveWarpPlan;
  projectedOverlapNodeIds: readonly string[];
  localTileSemanticIdentity: string;
  tileCacheIdentity: string;
  projectionCacheIdentity: string;
}>;

export type ReferenceCamera3DHiddenPlanePlan = Readonly<{
  status: "opacity-zero";
  nodeId: string;
  localSpaceNodeId: string;
  sourceOrder: number;
  edge: "transparent";
  state: ReferencePlane3DState;
  worldMatrix: Matrix4;
  localTileSemanticIdentity: string;
}>;

export type ReferenceCamera3DPlanePlan = ReferenceCamera3DVisiblePlanePlan | ReferenceCamera3DHiddenPlanePlan;

export type ReferenceCamera3DFramePlan = Readonly<{
  algorithmVersion: typeof referenceCamera3DAlgorithmVersion;
  model: typeof referenceCamera3DModel;
  compositionId: string;
  nodeId: string;
  exactTime: Rational;
  camera: ReferenceCamera3DState;
  viewMatrix: Matrix4;
  planes: readonly ReferenceCamera3DPlanePlan[];
  paintOrder: readonly string[];
  work: Readonly<{
    activePlanes: number;
    opacityZeroPlanes: number;
    projectivePlans: number;
    maximumDestinationPixelTests: number;
    maximumDestinationRgbaBytes: number;
    cameraComposites: number;
  }>;
  cache: Readonly<{
    tileContent: "local-content-and-exact-time";
    cameraProjection: string;
    composite: string;
    audio: "unaffected";
  }>;
  planIdentity: string;
}>;

export type ReferenceCamera3DPlaneExecution = Readonly<{
  nodeId: string;
  localSpaceNodeId: string;
  tileRgbaSha256: string;
  tightWarpRgbaSha256: string;
  canvasRgbaSha256: string;
  observed: Readonly<{
    destinationPixelsTested: number;
    insideQuadPixels: number;
    integerSamplesCopied: number;
    bilinearSamplesEvaluated: number;
    sourceTapsRead: number;
  }>;
  canvasCopy: Readonly<{
    coveredPixels: number;
    copiedPixels: number;
    copiedRgbaBytes: number;
    opacityScaledPixels: number;
  }>;
}>;

export type ReferenceCamera3DPlaneEvidence =
  | Readonly<{
    status: "opacity-zero";
    nodeId: string;
    localSpaceNodeId: string;
    sourceOrder: number;
    edge: "transparent";
    state: ReferencePlane3DState;
    worldMatrix: Matrix4;
    localTileSemanticIdentity: string;
  }>
  | Readonly<{
    status: "visible";
    nodeId: string;
    localSpaceNodeId: string;
    sourceOrder: number;
    paintOrder: number;
    edge: "transparent";
    state: ReferencePlane3DState;
    worldMatrix: Matrix4;
    cameraCorners: readonly [Vec3, Vec3, Vec3, Vec3];
    depthInterval: Readonly<{ minimum: number; maximum: number }>;
    projectedQuadQ16: ReferenceProjectiveWarpPlan["destination"]["quadQ16"];
    intersectsOutput: boolean;
    homography: Readonly<{ forward: readonly string[]; determinant: string }>;
    projectedOverlapNodeIds: readonly string[];
    localTileSemanticIdentity: string;
    tileCacheIdentity: string;
    projectionCacheIdentity: string;
    projectivePlanIdentity: string;
  }>;

export type ReferenceCamera3DFrameEvidence = Readonly<{
  format: typeof referenceCamera3DFrameEvidenceFormat;
  version: 1;
  evidenceKind: "completed-frame-execution";
  algorithmVersion: typeof referenceCamera3DAlgorithmVersion;
  model: typeof referenceCamera3DModel;
  compositionId: string;
  nodeId: string;
  exactTime: Rational;
  backendIdentity: string;
  camera: ReferenceCamera3DState;
  viewMatrix: Matrix4;
  planes: readonly ReferenceCamera3DPlaneEvidence[];
  paintOrder: readonly string[];
  work: ReferenceCamera3DFramePlan["work"];
  cache: ReferenceCamera3DFramePlan["cache"];
  executions: readonly ReferenceCamera3DPlaneExecution[];
  output: Readonly<{ width: number; height: number; rgbaSha256: string }>;
  planIdentity: string;
  executionIdentity: string;
}>;

const cameraInputs = Object.freeze(["focalLength", "x", "y", "z", "targetX", "targetY", "targetZ", "roll"] as const);
const cameraProperties = cameraInputs;
const planeInputs = Object.freeze(["x", "y", "z", "rotationX", "rotationY", "rotationZ", "scale", "opacity", "edge"] as const);
const planeProperties = Object.freeze(["x", "y", "z", "rotationX", "rotationY", "rotationZ", "scale", "opacity"] as const);

function fail(node: IRNode, code: ReferenceCamera3DErrorCode, detail: string): never {
  throw new ReferenceCamera3DError(code, node, detail);
}

function active(node: IRNode, time: Rational) {
  const end = addRational(node.interval.start, node.interval.duration);
  return compareRational(time, node.interval.start) >= 0 && compareRational(time, end) < 0;
}

function sameInterval(left: IRNode, right: IRNode) {
  return compareRational(left.interval.start, right.interval.start) === 0
    && compareRational(left.interval.duration, right.interval.duration) === 0;
}

function signalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [{ label: ".value", value: signal.value, allowNull: false }];
  if (signal.kind === "step") return signal.points.map((point, index) => ({ label: `.points[${index}].value`, value: point.value, allowNull: false }));
  if (signal.kind === "keyframes") return signal.keyframes.map((point, index) => ({ label: `.keyframes[${index}].value`, value: point.value, allowNull: false }));
  return [
    { label: ".initial", value: signal.initial, allowNull: true },
    ...signal.events.flatMap((event, index) => event.kind === "set"
      ? [{ label: `.events[${index}].value`, value: event.value, allowNull: false }]
      : [
        { label: `.events[${index}].from`, value: event.from, allowNull: false },
        { label: `.events[${index}].to`, value: event.to, allowNull: false },
      ]),
  ];
}

type QuantityContract = Readonly<{
  dimension: "length" | "angle" | "scalar" | "ratio";
  valueType: "Length" | "Angle" | "Number" | "Ratio";
  minimum: number;
  maximum: number;
}>;

function quantity(node: IRNode, value: IRValue | undefined, label: string, contract: QuantityContract) {
  const unit = contract.dimension === "length" ? "px"
    : contract.dimension === "angle" ? "deg"
      : contract.dimension === "scalar" ? "scalar"
        : "ratio";
  if (value?.kind !== "quantity" || value.dimension !== contract.dimension || value.unit !== unit) {
    fail(node, "CUT_CAMERA3D_TYPE", `${label} must be a canonical ${contract.valueType}${contract.dimension === "length" ? " in px" : ""}.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < contract.minimum || result > contract.maximum) {
    fail(node, "CUT_CAMERA3D_RANGE", `${label} must be finite from ${contract.minimum} through ${contract.maximum}.`);
  }
  return Object.is(result, -0) ? 0 : result;
}

const lengthContract: QuantityContract = Object.freeze({
  dimension: "length", valueType: "Length", minimum: -referenceCamera3DLimits.maximumAbsoluteCoordinatePx, maximum: referenceCamera3DLimits.maximumAbsoluteCoordinatePx,
});
const focalContract: QuantityContract = Object.freeze({
  dimension: "length", valueType: "Length", minimum: referenceCamera3DLimits.minimumFocalLengthPx, maximum: referenceCamera3DLimits.maximumFocalLengthPx,
});
const angleContract: QuantityContract = Object.freeze({
  dimension: "angle", valueType: "Angle", minimum: -referenceCamera3DLimits.maximumAbsoluteAngleDeg, maximum: referenceCamera3DLimits.maximumAbsoluteAngleDeg,
});
const scaleContract: QuantityContract = Object.freeze({
  dimension: "scalar", valueType: "Number", minimum: referenceCamera3DLimits.minimumScale, maximum: referenceCamera3DLimits.maximumScale,
});
const opacityContract: QuantityContract = Object.freeze({
  dimension: "ratio", valueType: "Ratio", minimum: 0, maximum: 1,
});

function validateControl(ir: CutAVIR, node: IRNode, name: string, contract: QuantityContract, required = false) {
  const input = node.inputs[name];
  if (required && input === undefined) fail(node, "CUT_CAMERA3D_TYPE", `input “${name}” is required.`);
  if (input !== undefined) quantity(node, input, `input “${name}”`, contract);
  const property = node.properties[name];
  if (property === undefined) return;
  if (!("signal" in property)) {
    quantity(node, property, `property “${name}”`, contract);
    if (input !== undefined) fail(node, "CUT_CAMERA3D_NOOP", `property “${name}” shadows the same-named constructor input for the complete interval; author one control path.`);
    return;
  }
  const signal = ir.signals[property.signal];
  if (!signal) fail(node, "CUT_CAMERA3D_TYPE", `property “${name}” references missing signal ${property.signal}.`);
  if (signal.valueType !== contract.valueType) fail(node, "CUT_CAMERA3D_TYPE", `property “${name}” signal ${signal.id} must declare valueType ${contract.valueType}.`);
  for (const item of signalValues(signal)) {
    if (item.allowNull && item.value.kind === "null") continue;
    quantity(node, item.value, `property “${name}” signal ${signal.id}${item.label}`, contract);
  }
  if (input !== undefined) {
    const executed = propertyAt(ir, node, name, node.interval.start);
    if (executed !== undefined) {
      const baseline = quantity(node, executed, `property “${name}” first executed sample`, contract);
      const constructor = quantity(node, input, `input “${name}”`, contract);
      if (baseline !== constructor) {
        fail(node, "CUT_CAMERA3D_NOOP", `input “${name}” is immediately shadowed at the first executed sample; its value must equal the signal baseline or be omitted.`);
      }
    }
  }
}

function validateUnknownControls(node: IRNode, inputs: readonly string[], properties: readonly string[]) {
  const unknownInput = Object.keys(node.inputs).find((name) => !inputs.includes(name));
  if (unknownInput !== undefined) fail(node, "CUT_CAMERA3D_TYPE", `input “${unknownInput}” is not part of the closed public contract.`);
  const unknownProperty = Object.keys(node.properties).find((name) => !properties.includes(name));
  if (unknownProperty !== undefined) fail(node, "CUT_CAMERA3D_TYPE", `property “${unknownProperty}” is not part of the closed public contract.`);
}

function validateCameraControls(ir: CutAVIR, node: IRNode) {
  validateUnknownControls(node, cameraInputs, cameraProperties);
  validateControl(ir, node, "focalLength", focalContract, true);
  for (const name of ["x", "y", "z", "targetX", "targetY", "targetZ"]) validateControl(ir, node, name, lengthContract);
  validateControl(ir, node, "roll", angleContract);
}

function validatePlaneControls(ir: CutAVIR, node: IRNode) {
  validateUnknownControls(node, planeInputs, planeProperties);
  for (const name of ["x", "y"]) validateControl(ir, node, name, lengthContract);
  validateControl(ir, node, "z", lengthContract, true);
  for (const name of ["rotationX", "rotationY", "rotationZ"]) validateControl(ir, node, name, angleContract);
  validateControl(ir, node, "scale", scaleContract);
  validateControl(ir, node, "opacity", opacityContract);
  const edge = node.inputs.edge;
  if (edge?.kind !== "string" || edge.value !== "transparent") {
    fail(node, "CUT_CAMERA3D_TYPE", "input “edge” must be the closed V1 value transparent; clamp is not implemented.");
  }
  if (node.properties.edge !== undefined) fail(node, "CUT_CAMERA3D_TYPE", "edge is static and cannot be automated.");
  if (node.inputs.opacity?.kind === "quantity" && compareRational(node.inputs.opacity.magnitude, rational(0)) === 0 && node.properties.opacity === undefined) {
    fail(node, "CUT_CAMERA3D_NOOP", "a permanently zero-opacity plane is inert; remove it or animate opacity from an exact zero baseline.");
  }
}

function parentMap(ir: CutAVIR) {
  const result = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) for (const childId of parent.children) {
    const parents = result.get(childId) ?? [];
    parents.push(parent);
    result.set(childId, parents);
  }
  return result;
}

/** Close graph shape, ownership, loaded-IR controls, and retained-tile basis. */
export function validateReferenceCamera3DGraph(
  ir: CutAVIR,
  composition: IRComposition,
  selectedNodeIds?: ReadonlySet<string>,
  localSpaceConfigs?: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
) {
  const selected = (id: string) => selectedNodeIds === undefined || selectedNodeIds.has(id);
  const parents = parentMap(ir);
  const cameraNodes = Object.values(ir.nodes).filter((node) => selected(node.id) && node.op === "cut.visual.camera3d");
  // Camera3D must not broaden compile-time LocalSpace validation for projects
  // that do not contain this owner. Other retained owners keep their own
  // established validation phase and diagnostics.
  const localSpaces = cameraNodes.length
    ? localSpaceConfigs ?? validateReferenceLocalSpaceGraph(ir, composition, selectedNodeIds)
    : new Map<string, ReferenceLocalSpaceConfig>();
  const cameras = new Map<string, ReferenceCamera3DConfig>();
  for (const camera of cameraNodes) {
    if (camera.domain !== "visual") fail(camera, "CUT_CAMERA3D_GRAPH", `must have visual domain, found ${camera.domain}.`);
    if (camera.ownership !== "root" || !camera.sceneId) fail(camera, "CUT_CAMERA3D_GRAPH", "must be a direct scene-root visual in V1.");
    const scene = ir.scenes[camera.sceneId];
    if (!scene || !composition.sceneIds.includes(scene.id) || !scene.items.some((item) => item.id === camera.id && item.domain === "visual")) {
      fail(camera, "CUT_CAMERA3D_GRAPH", "must belong to exactly one selected composition scene root.");
    }
    if ((parents.get(camera.id) ?? []).length) {
      const parent = (parents.get(camera.id) ?? [])[0]!;
      if (parent.op === "cut.visual.motion_blur") {
        fail(camera, "CUT_CAMERA3D_MOTION_BLUR_UNSUPPORTED", "outer MotionBlur is not admitted until Camera3D shutter-time work and evidence are closed; author exact-time camera/plane automation without the wrapper.");
      }
      fail(camera, "CUT_CAMERA3D_GRAPH", `cannot be nested under ${parent.op}; V1 is direct scene-root only.`);
    }
    if (camera.children.length < referenceCamera3DLimits.minimumPlanes || camera.children.length > referenceCamera3DLimits.maximumPlanes) {
      fail(camera, "CUT_CAMERA3D_GRAPH", `requires ${referenceCamera3DLimits.minimumPlanes} through ${referenceCamera3DLimits.maximumPlanes} direct Plane3D children; found ${camera.children.length}.`);
    }
    validateCameraControls(ir, camera);
    const planes = camera.children.map((planeId, sourceOrder): ReferencePlane3DConfig => {
      const plane = ir.nodes[planeId];
      if (!plane || plane.op !== "cut.visual.plane3d" || plane.domain !== "visual" || plane.ownership !== "child" || plane.sceneId !== camera.sceneId) {
        fail(camera, "CUT_CAMERA3D_GRAPH", `child ${planeId} must be one direct child-owned visual Plane3D in the same scene.`);
      }
      if (!sameInterval(camera, plane)) fail(plane, "CUT_CAMERA3D_GRAPH", "must share its Camera3D owner's exact half-open interval.");
      const planeParents = parents.get(plane.id) ?? [];
      if (planeParents.length !== 1 || planeParents[0]!.id !== camera.id) fail(plane, "CUT_CAMERA3D_GRAPH", "must have exactly one direct Camera3D structural owner.");
      if (plane.children.length !== 1) fail(plane, "CUT_CAMERA3D_GRAPH", "must own exactly one direct LocalSpace tile and no delivery-canvas sibling.");
      validatePlaneControls(ir, plane);
      const localSpace = ir.nodes[plane.children[0]!] as IRNode | undefined;
      const localConfig = localSpace ? localSpaces.get(localSpace.id) : undefined;
      if (!localSpace || localSpace.op !== "cut.visual.local_space" || !localConfig || localConfig.owner !== "plane-3d" || localConfig.ownerNodeId !== plane.id) {
        fail(plane, "CUT_CAMERA3D_GRAPH", "must own one validated direct LocalSpace retained tile.");
      }
      if (!sameInterval(plane, localSpace)) fail(plane, "CUT_CAMERA3D_GRAPH", "its LocalSpace must share the exact Plane3D interval.");
      const config = Object.freeze({
        nodeId: plane.id,
        localSpaceNodeId: localSpace.id,
        sourceOrder,
        edge: "transparent" as const,
        localSpace: localConfig,
        semanticIdentity: hash({
          algorithmVersion: referenceCamera3DAlgorithmVersion,
          nodeContentHash: plane.contentHash,
          localTileSemanticIdentity: localConfig.semanticIdentity,
          edge: "transparent",
        }),
      });
      return config;
    });
    const config = Object.freeze({
      nodeId: camera.id,
      model: referenceCamera3DModel,
      planes: Object.freeze(planes),
      semanticIdentity: hash({
        algorithmVersion: referenceCamera3DAlgorithmVersion,
        nodeContentHash: camera.contentHash,
        planes: planes.map((plane) => plane.semanticIdentity),
      }),
    });
    cameras.set(camera.id, config);
  }
  for (const plane of Object.values(ir.nodes).filter((node) => selected(node.id) && node.op === "cut.visual.plane3d")) {
    const owners = parents.get(plane.id) ?? [];
    if (owners.length !== 1 || owners[0]!.op !== "cut.visual.camera3d") {
      fail(plane, "CUT_CAMERA3D_GRAPH", "is valid only as a direct child of exactly one Camera3D.");
    }
  }
  return cameras;
}

function sampledAt(ir: CutAVIR, node: IRNode, name: string, contract: QuantityContract, time: Rational, fallback: number) {
  const value = propertyAt(ir, node, name, time) ?? node.inputs[name];
  return value === undefined ? fallback : quantity(node, value, `executed ${name}`, contract);
}

function cameraStateAt(ir: CutAVIR, node: IRNode, time: Rational): ReferenceCamera3DState {
  return Object.freeze({
    focalLength: sampledAt(ir, node, "focalLength", focalContract, time, 0),
    position: Object.freeze({
      x: sampledAt(ir, node, "x", lengthContract, time, 0),
      y: sampledAt(ir, node, "y", lengthContract, time, 0),
      z: sampledAt(ir, node, "z", lengthContract, time, 0),
    }),
    target: Object.freeze({
      x: sampledAt(ir, node, "targetX", lengthContract, time, 0),
      y: sampledAt(ir, node, "targetY", lengthContract, time, 0),
      z: sampledAt(ir, node, "targetZ", lengthContract, time, 1_000),
    }),
    roll: sampledAt(ir, node, "roll", angleContract, time, 0),
  });
}

function planeStateAt(ir: CutAVIR, node: IRNode, time: Rational): ReferencePlane3DState {
  return Object.freeze({
    position: Object.freeze({
      x: sampledAt(ir, node, "x", lengthContract, time, 0),
      y: sampledAt(ir, node, "y", lengthContract, time, 0),
      z: sampledAt(ir, node, "z", lengthContract, time, 0),
    }),
    rotation: Object.freeze({
      x: sampledAt(ir, node, "rotationX", angleContract, time, 0),
      y: sampledAt(ir, node, "rotationY", angleContract, time, 0),
      z: sampledAt(ir, node, "rotationZ", angleContract, time, 0),
    }),
    scale: sampledAt(ir, node, "scale", scaleContract, time, 1),
    opacity: sampledAt(ir, node, "opacity", opacityContract, time, 1),
  });
}

function length3(value: Vec3) { return Math.hypot(value.x, value.y, value.z); }
function subtract3(left: Vec3, right: Vec3): Vec3 { return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }; }
function dot3(left: Vec3, right: Vec3) { return left.x * right.x + left.y * right.y + left.z * right.z; }
function cross3(left: Vec3, right: Vec3): Vec3 {
  return { x: left.y * right.z - left.z * right.y, y: left.z * right.x - left.x * right.z, z: left.x * right.y - left.y * right.x };
}
function scale3(value: Vec3, scale: number): Vec3 { return { x: value.x * scale, y: value.y * scale, z: value.z * scale }; }
function normalize3(node: IRNode, value: Vec3, label: string): Vec3 {
  const magnitude = length3(value);
  if (!Number.isFinite(magnitude) || magnitude <= 0) fail(node, "CUT_CAMERA3D_LOOK_AT_UNSUPPORTED", `${label} must have a finite nonzero direction.`);
  return scale3(value, 1 / magnitude);
}

function canonicalFloat(value: number) {
  if (!Number.isFinite(value)) throw new Error("non-finite matrix value");
  if (Math.abs(value) < 1e-15) return 0;
  return value;
}

function matrix(values: readonly number[]): Matrix4 {
  if (values.length !== 16 || values.some((value) => !Number.isFinite(value))) throw new Error("CUT internal Camera3D matrix must contain sixteen finite values.");
  return Object.freeze(values.map(canonicalFloat)) as unknown as Matrix4;
}

function multiply4(left: Matrix4, right: Matrix4): Matrix4 {
  const result = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
    let value = 0;
    for (let inner = 0; inner < 4; inner += 1) value += left[row * 4 + inner]! * right[inner * 4 + column]!;
    result[row * 4 + column] = value;
  }
  return matrix(result);
}

function translation4(x: number, y: number, z: number) {
  return matrix([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
}

function scale4(value: number) {
  return matrix([value, 0, 0, 0, 0, value, 0, 0, 0, 0, value, 0, 0, 0, 0, 1]);
}

function rotationX4(degrees: number) {
  const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  return matrix([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]);
}

function rotationY4(degrees: number) {
  const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  return matrix([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]);
}

function rotationZ4(degrees: number) {
  const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  return matrix([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function transformPoint(matrix_: Matrix4, point: Vec3): Vec3 {
  return Object.freeze({
    x: canonicalFloat(matrix_[0]! * point.x + matrix_[1]! * point.y + matrix_[2]! * point.z + matrix_[3]!),
    y: canonicalFloat(matrix_[4]! * point.x + matrix_[5]! * point.y + matrix_[6]! * point.z + matrix_[7]!),
    z: canonicalFloat(matrix_[8]! * point.x + matrix_[9]! * point.y + matrix_[10]! * point.z + matrix_[11]!),
  });
}

function planeWorldMatrix(config: ReferencePlane3DConfig, state: ReferencePlane3DState): Matrix4 {
  const origin = config.localSpace.origin;
  const originX = rationalToNumber(origin.x), originY = rationalToNumber(origin.y);
  // Registration -> scale -> Rx -> Ry -> Rz -> world translation.
  return multiply4(
    translation4(state.position.x, state.position.y, state.position.z),
    multiply4(rotationZ4(state.rotation.z), multiply4(rotationY4(state.rotation.y), multiply4(rotationX4(state.rotation.x), multiply4(scale4(state.scale), translation4(-originX, -originY, 0))))),
  );
}

function cameraView(node: IRNode, state: ReferenceCamera3DState): { viewMatrix: Matrix4; right: Vec3; down: Vec3; forward: Vec3 } {
  const forward = normalize3(node, subtract3(state.target, state.position), "target minus camera position");
  const worldDown: Vec3 = { x: 0, y: 1, z: 0 };
  const unrolledRight = cross3(worldDown, forward), rightLength = length3(unrolledRight);
  if (!Number.isFinite(rightLength) || rightLength < referenceCamera3DLimits.minimumLookAtRightLength) {
    fail(node, "CUT_CAMERA3D_LOOK_AT_UNSUPPORTED", `look direction is too nearly parallel to world-down; cross length must be at least ${referenceCamera3DLimits.minimumLookAtRightLength}. V1 refuses rather than choosing an implicit alternate up axis.`);
  }
  const baseRight = scale3(unrolledRight, 1 / rightLength), baseDown = cross3(forward, baseRight);
  const roll = state.roll * Math.PI / 180, c = Math.cos(roll), s = Math.sin(roll);
  // In x-right/y-down screen coordinates positive roll is clockwise: the
  // screen-right basis rotates toward screen-down.
  const right = Object.freeze({ x: canonicalFloat(baseRight.x * c + baseDown.x * s), y: canonicalFloat(baseRight.y * c + baseDown.y * s), z: canonicalFloat(baseRight.z * c + baseDown.z * s) });
  const down = Object.freeze({ x: canonicalFloat(-baseRight.x * s + baseDown.x * c), y: canonicalFloat(-baseRight.y * s + baseDown.y * c), z: canonicalFloat(-baseRight.z * s + baseDown.z * c) });
  const viewMatrix = matrix([
    right.x, right.y, right.z, -dot3(right, state.position),
    down.x, down.y, down.z, -dot3(down, state.position),
    forward.x, forward.y, forward.z, -dot3(forward, state.position),
    0, 0, 0, 1,
  ]);
  return { viewMatrix, right, down, forward };
}

function screenSignedTwiceArea(quad: ReferenceProjectiveQuad) {
  let total = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const point = quad[index]!, next = quad[(index + 1) % quad.length]!;
    total += point.x * next.y - point.y * next.x;
  }
  return total;
}

type Q16Point = Readonly<{ x: bigint; y: bigint }>;

function q16Quad(plan: ReferenceProjectiveWarpPlan): readonly [Q16Point, Q16Point, Q16Point, Q16Point] {
  return plan.destination.quadQ16.map((point) => Object.freeze({ x: BigInt(point.x), y: BigInt(point.y) })) as unknown as readonly [Q16Point, Q16Point, Q16Point, Q16Point];
}

function orientQ16(a: Q16Point, b: Q16Point, p: Q16Point) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** Strict exact-Q16 separation. Touching counts as overlap because raster edge
 * coverage may share a pixel and therefore requires one unambiguous depth. */
function convexQ16QuadsOverlap(a: readonly Q16Point[], b: readonly Q16Point[], touchingCounts: boolean) {
  const strictlySeparatedBy = (owner: readonly Q16Point[], other: readonly Q16Point[]) => owner.some((point, index) => {
    const next = owner[(index + 1) % owner.length]!;
    return other.every((candidate) => touchingCounts
      ? orientQ16(point, next, candidate) < 0n
      : orientQ16(point, next, candidate) <= 0n);
  });
  return !strictlySeparatedBy(a, b) && !strictlySeparatedBy(b, a);
}

function projectedQuadsOverlap(left: ReferenceProjectiveWarpPlan, right: ReferenceProjectiveWarpPlan) {
  return convexQ16QuadsOverlap(q16Quad(left), q16Quad(right), true);
}

function projectedQuadIntersectsOutput(plan: ReferenceProjectiveWarpPlan, width: number, height: number) {
  const phase = BigInt(referenceProjectiveWarpPhaseUnits);
  const canvas = Object.freeze([
    Object.freeze({ x: 0n, y: 0n }),
    Object.freeze({ x: BigInt(width) * phase, y: 0n }),
    Object.freeze({ x: BigInt(width) * phase, y: BigInt(height) * phase }),
    Object.freeze({ x: 0n, y: BigInt(height) * phase }),
  ]);
  return convexQ16QuadsOverlap(q16Quad(plan), canvas, false);
}

function topologicalPaintOrder(node: IRNode, planes: ReferenceCamera3DVisiblePlanePlan[]) {
  const outgoing = new Map<string, Set<string>>(planes.map((plane) => [plane.nodeId, new Set()]));
  const incoming = new Map<string, number>(planes.map((plane) => [plane.nodeId, 0]));
  const overlaps = new Map<string, string[]>(planes.map((plane) => [plane.nodeId, []]));
  for (let first = 0; first < planes.length; first += 1) for (let second = first + 1; second < planes.length; second += 1) {
    const left = planes[first]!, right = planes[second]!;
    if (!projectedQuadsOverlap(left.projectivePlan, right.projectivePlan)) continue;
    overlaps.get(left.nodeId)!.push(right.nodeId); overlaps.get(right.nodeId)!.push(left.nodeId);
    let far: ReferenceCamera3DVisiblePlanePlan | undefined, near: ReferenceCamera3DVisiblePlanePlan | undefined;
    if (left.depthInterval.minimum > right.depthInterval.maximum) { far = left; near = right; }
    else if (right.depthInterval.minimum > left.depthInterval.maximum) { far = right; near = left; }
    else {
      fail(
        node,
        "CUT_CAMERA3D_OCCLUSION_UNSUPPORTED",
        `projected planes ${left.nodeId} and ${right.nodeId} touch or overlap while camera-depth intervals [${left.depthInterval.minimum}, ${left.depthInterval.maximum}] and [${right.depthInterval.minimum}, ${right.depthInterval.maximum}] are not strictly separated. V1 refuses intersecting/crossing geometry instead of faking a z-buffer.`,
      );
    }
    outgoing.get(far.nodeId)!.add(near.nodeId);
    incoming.set(near.nodeId, incoming.get(near.nodeId)! + 1);
  }
  const byId = new Map(planes.map((plane) => [plane.nodeId, plane]));
  const ready = planes.filter((plane) => incoming.get(plane.nodeId) === 0).sort((a, b) => a.sourceOrder - b.sourceOrder);
  const order: string[] = [];
  while (ready.length) {
    const plane = ready.shift()!;
    order.push(plane.nodeId);
    for (const nextId of [...outgoing.get(plane.nodeId)!].sort((a, b) => byId.get(a)!.sourceOrder - byId.get(b)!.sourceOrder)) {
      const remaining = incoming.get(nextId)! - 1;
      incoming.set(nextId, remaining);
      if (remaining === 0) {
        ready.push(byId.get(nextId)!);
        ready.sort((a, b) => a.sourceOrder - b.sourceOrder);
      }
    }
  }
  if (order.length !== planes.length) fail(node, "CUT_CAMERA3D_OCCLUSION_UNSUPPORTED", "projected overlap constraints do not admit one deterministic far-to-near paint order.");
  return { order, overlaps };
}

function wrapProjective(node: IRNode, work: () => ReferenceProjectiveWarpPlan) {
  try { return work(); }
  catch (error) {
    if (!(error instanceof ReferenceProjectiveWarpError)) throw error;
    fail(node, error.code === "CUT_PROJECTIVE_WARP_WORK_LIMIT" ? "CUT_CAMERA3D_LIMIT" : "CUT_CAMERA3D_PROJECTIVE", `${error.code}: ${error.message.replace(/^CUT_[A-Z0-9_]+:\s*/u, "")}`);
  }
}

/** Plan the exact camera/plane state and bounded projective work at one time. */
export function referenceCamera3DPlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  config: ReferenceCamera3DConfig,
  exactTime: Rational,
  backendIdentity: string,
): ReferenceCamera3DFramePlan {
  const cameraNode = ir.nodes[config.nodeId];
  if (!cameraNode || cameraNode.op !== "cut.visual.camera3d") throw new Error(`CUT Camera3D config ${config.nodeId} lost its camera node.`);
  if (!active(cameraNode, exactTime)) fail(cameraNode, "CUT_CAMERA3D_GRAPH", "frame plan time lies outside the Camera3D half-open interval.");
  const camera = cameraStateAt(ir, cameraNode, exactTime), { viewMatrix } = cameraView(cameraNode, camera);
  const provisional: ReferenceCamera3DPlanePlan[] = config.planes.map((planeConfig) => {
    const planeNode = ir.nodes[planeConfig.nodeId]!;
    const state = planeStateAt(ir, planeNode, exactTime), worldMatrix = planeWorldMatrix(planeConfig, state);
    if (state.opacity === 0) return Object.freeze({
      status: "opacity-zero" as const,
      nodeId: planeNode.id,
      localSpaceNodeId: planeConfig.localSpaceNodeId,
      sourceOrder: planeConfig.sourceOrder,
      edge: planeConfig.edge,
      state,
      worldMatrix,
      localTileSemanticIdentity: planeConfig.localSpace.semanticIdentity,
    });
    const worldCorners = [
      transformPoint(worldMatrix, { x: 0, y: 0, z: 0 }),
      transformPoint(worldMatrix, { x: planeConfig.localSpace.width, y: 0, z: 0 }),
      transformPoint(worldMatrix, { x: planeConfig.localSpace.width, y: planeConfig.localSpace.height, z: 0 }),
      transformPoint(worldMatrix, { x: 0, y: planeConfig.localSpace.height, z: 0 }),
    ] as const;
    const cameraCorners = worldCorners.map((corner) => transformPoint(viewMatrix, corner)) as unknown as readonly [Vec3, Vec3, Vec3, Vec3];
    const depths = cameraCorners.map((corner) => corner.z);
    if (depths.some((depth) => !Number.isFinite(depth) || depth <= referenceCamera3DLimits.nearPlanePx)) {
      fail(planeNode, "CUT_CAMERA3D_NEAR_PLANE_UNSUPPORTED", `all four corners must remain strictly beyond the ${referenceCamera3DLimits.nearPlanePx}px near plane; observed [${depths.join(", ")}]. V1 performs no clipping or split.`);
    }
    const projectedQuad = cameraCorners.map((corner) => Object.freeze({
      x: composition.width / 2 + camera.focalLength * corner.x / corner.z,
      y: composition.height / 2 + camera.focalLength * corner.y / corner.z,
    })) as unknown as ReferenceProjectiveQuad;
    if (projectedQuad.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || Math.abs(point.x) > referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate
      || Math.abs(point.y) > referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate)) {
      fail(planeNode, "CUT_CAMERA3D_LIMIT", `projected corners must remain finite within +/-${referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate}px.`);
    }
    if (screenSignedTwiceArea(projectedQuad) <= 0) {
      fail(planeNode, "CUT_CAMERA3D_BACKFACE_UNSUPPORTED", "projected TL,TR,BR,BL winding is not positive clockwise in x-right/y-down screen coordinates. V1 refuses backfaces and edge-on planes before warp allocation.");
    }
    const projectivePlan = wrapProjective(planeNode, () => planReferenceProjectiveWarp({
      sourceWidth: planeConfig.localSpace.width,
      sourceHeight: planeConfig.localSpace.height,
      destinationQuad: projectedQuad,
      destinationBounds: { left: 0, top: 0, right: composition.width, bottom: composition.height },
    }));
    const intersectsOutput = projectedQuadIntersectsOutput(projectivePlan, composition.width, composition.height);
    const tileCacheIdentity = referenceLocalSpaceTileIdentity(planeConfig.localSpace, exactTime, backendIdentity);
    const projectionCacheIdentity = hash({
      kind: "camera3d-plane-projection",
      algorithmVersion: referenceCamera3DAlgorithmVersion,
      camera: { state: camera, viewMatrix },
      plane: { state, worldMatrix, projectivePlanIdentity: projectivePlan.planIdentity },
      tileCacheIdentity,
      edge: planeConfig.edge,
      opacity: state.opacity,
      output: { width: composition.width, height: composition.height },
      backendIdentity,
    });
    return Object.freeze({
      status: "visible" as const,
      nodeId: planeNode.id,
      localSpaceNodeId: planeConfig.localSpaceNodeId,
      sourceOrder: planeConfig.sourceOrder,
      paintOrder: -1,
      edge: planeConfig.edge,
      state,
      worldMatrix,
      cameraCorners,
      depthInterval: Object.freeze({ minimum: Math.min(...depths), maximum: Math.max(...depths) }),
      projectedQuad: Object.freeze(projectedQuad),
      intersectsOutput,
      projectivePlan,
      projectedOverlapNodeIds: Object.freeze([]),
      localTileSemanticIdentity: planeConfig.localSpace.semanticIdentity,
      tileCacheIdentity,
      projectionCacheIdentity,
    });
  });
  const visible = provisional.filter((plane): plane is ReferenceCamera3DVisiblePlanePlan => plane.status === "visible");
  const { order, overlaps } = topologicalPaintOrder(cameraNode, visible);
  const paintOrder = new Map(order.map((id, index) => [id, index]));
  const planes = Object.freeze(provisional.map((plane): ReferenceCamera3DPlanePlan => plane.status === "opacity-zero" ? plane : Object.freeze({
    ...plane,
    paintOrder: paintOrder.get(plane.nodeId)!,
    projectedOverlapNodeIds: Object.freeze([...overlaps.get(plane.nodeId)!].sort()),
  })));
  const maximumDestinationPixelTests = visible.reduce((total, plane) => total + plane.projectivePlan.work.maximumDestinationPixelTests, 0);
  const maximumDestinationRgbaBytes = visible.reduce((total, plane) => total + plane.projectivePlan.destination.rgbaBytes, 0);
  if (!Number.isSafeInteger(maximumDestinationPixelTests) || !Number.isSafeInteger(maximumDestinationRgbaBytes)
    || maximumDestinationPixelTests > referenceCamera3DLimits.maximumAggregateDestinationPixelTests
    || maximumDestinationRgbaBytes > referenceCamera3DLimits.maximumAggregateDestinationRgbaBytes) {
    fail(cameraNode, "CUT_CAMERA3D_LIMIT", `aggregate projective work exceeds ${referenceCamera3DLimits.maximumAggregateDestinationPixelTests} destination pixel tests or ${referenceCamera3DLimits.maximumAggregateDestinationRgbaBytes} RGBA bytes.`);
  }
  const work = Object.freeze({
    activePlanes: visible.length,
    opacityZeroPlanes: planes.length - visible.length,
    projectivePlans: visible.length,
    maximumDestinationPixelTests,
    maximumDestinationRgbaBytes,
    cameraComposites: Math.max(0, visible.length - 1),
  });
  const cameraProjection = hash({ algorithmVersion: referenceCamera3DAlgorithmVersion, camera, viewMatrix, output: { width: composition.width, height: composition.height } });
  const composite = hash({ cameraProjection, paintOrder: order, planes: visible.map((plane) => ({ nodeId: plane.nodeId, projection: plane.projectionCacheIdentity })) });
  const cache = Object.freeze({
    tileContent: "local-content-and-exact-time" as const,
    cameraProjection,
    composite,
    audio: "unaffected" as const,
  });
  const receipt = Object.freeze({
    algorithmVersion: referenceCamera3DAlgorithmVersion,
    model: referenceCamera3DModel,
    compositionId: composition.id,
    nodeId: cameraNode.id,
    exactTime: Object.freeze({ ...exactTime }),
    camera,
    viewMatrix,
    planes,
    paintOrder: Object.freeze(order),
    work,
    cache,
  });
  return Object.freeze({ ...receipt, planIdentity: hash(receipt) });
}

export function referenceCamera3DInspect(ir: CutAVIR, composition: IRComposition, config: ReferenceCamera3DConfig) {
  const camera = ir.nodes[config.nodeId]!;
  const firstTime = camera.interval.start;
  const plan = referenceCamera3DPlanAt(ir, composition, config, firstTime, "inspect-plan-only");
  return Object.freeze({
    kind: referenceCamera3DModel,
    algorithmVersion: referenceCamera3DAlgorithmVersion,
    coordinateSystem: Object.freeze({ x: "right", y: "down", z: "away", defaultLook: "+z", screenOrigin: "composition-center" }),
    transformOrder: Object.freeze(["registration", "scale", "rotation-x", "rotation-y", "rotation-z", "world-translation"] as const),
    projection: Object.freeze({ kind: "perspective", retainedPlanesOnly: true, nearPlanePx: referenceCamera3DLimits.nearPlanePx }),
    cameraNodeId: config.nodeId,
    planeNodeIds: Object.freeze(config.planes.map((plane) => plane.nodeId)),
    firstExactFramePlan: plan,
    cacheDependencies: Object.freeze({ tileContent: "plane LocalSpace subtree plus exact time", projection: "camera and plane sampled transforms plus tile identity", audio: "unaffected" }),
    limitations: Object.freeze(["transparent-edge-only", "no-meshes", "no-lights", "no-shadows", "no-z-buffer", "no-near-plane-clipping", "no-backfaces", "no-depth-of-field", "outer-motion-blur-unavailable"]),
    limits: referenceCamera3DLimits,
    semanticIdentity: config.semanticIdentity,
  });
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

export function referenceCamera3DFrameEvidence(input: Readonly<{
  plan: ReferenceCamera3DFramePlan;
  backendIdentity: string;
  executions: readonly ReferenceCamera3DPlaneExecution[];
  output: Readonly<{ data: Uint8Array; width: number; height: number }>;
}>): ReferenceCamera3DFrameEvidence {
  const expected = input.plan.planes.filter((plane): plane is ReferenceCamera3DVisiblePlanePlan => plane.status === "visible").sort((a, b) => a.paintOrder - b.paintOrder);
  if (input.executions.length !== expected.length || input.executions.some((entry, index) => entry.nodeId !== expected[index]!.nodeId || entry.localSpaceNodeId !== expected[index]!.localSpaceNodeId)) {
    throw new Error("CUT Camera3D execution evidence does not match the admitted visible-plane paint order.");
  }
  const planes: readonly ReferenceCamera3DPlaneEvidence[] = Object.freeze(input.plan.planes.map((plane): ReferenceCamera3DPlaneEvidence => plane.status === "opacity-zero"
    ? Object.freeze({
      status: plane.status,
      nodeId: plane.nodeId,
      localSpaceNodeId: plane.localSpaceNodeId,
      sourceOrder: plane.sourceOrder,
      edge: plane.edge,
      state: plane.state,
      worldMatrix: plane.worldMatrix,
      localTileSemanticIdentity: plane.localTileSemanticIdentity,
    })
    : Object.freeze({
      status: plane.status,
      nodeId: plane.nodeId,
      localSpaceNodeId: plane.localSpaceNodeId,
      sourceOrder: plane.sourceOrder,
      paintOrder: plane.paintOrder,
      edge: plane.edge,
      state: plane.state,
      worldMatrix: plane.worldMatrix,
      cameraCorners: plane.cameraCorners,
      depthInterval: plane.depthInterval,
      projectedQuadQ16: plane.projectivePlan.destination.quadQ16,
      intersectsOutput: plane.intersectsOutput,
      homography: Object.freeze({ forward: plane.projectivePlan.homography.forward, determinant: plane.projectivePlan.homography.determinant }),
      projectedOverlapNodeIds: plane.projectedOverlapNodeIds,
      localTileSemanticIdentity: plane.localTileSemanticIdentity,
      tileCacheIdentity: plane.tileCacheIdentity,
      projectionCacheIdentity: plane.projectionCacheIdentity,
      projectivePlanIdentity: plane.projectivePlan.planIdentity,
    })));
  const receipt = Object.freeze({
    format: referenceCamera3DFrameEvidenceFormat,
    version: 1 as const,
    evidenceKind: "completed-frame-execution" as const,
    algorithmVersion: referenceCamera3DAlgorithmVersion,
    model: referenceCamera3DModel,
    compositionId: input.plan.compositionId,
    nodeId: input.plan.nodeId,
    exactTime: input.plan.exactTime,
    backendIdentity: input.backendIdentity,
    camera: input.plan.camera,
    viewMatrix: input.plan.viewMatrix,
    planes,
    paintOrder: input.plan.paintOrder,
    work: input.plan.work,
    cache: input.plan.cache,
    executions: Object.freeze(input.executions.map((entry) => Object.freeze({ ...entry }))),
    output: Object.freeze({ width: input.output.width, height: input.output.height, rgbaSha256: sha256(input.output.data) }),
    planIdentity: input.plan.planIdentity,
  });
  return Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
}

/** Utility used by runtime tests to prove the constructor defaults are sampled
 * through the same property path as automation. */
export function referenceCamera3DStaticState(ir: CutAVIR, node: IRNode) {
  return node.op === "cut.visual.camera3d" ? cameraStateAt(ir, node, node.interval.start)
    : node.op === "cut.visual.plane3d" ? planeStateAt(ir, node, node.interval.start)
      : undefined;
}
