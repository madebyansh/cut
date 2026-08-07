import type { CutAVIR, IRNode, IRSignal, IRValue } from "./ir";
import {
  compareRational,
  divideRational,
  rational,
  type Rational,
  zeroRational,
} from "./rational";
import {
  CutResponsiveStackError,
  decodeCutResponsiveSlotMediaContext,
} from "./responsive-layout";

export const cutMediaCamera2DOp = "cut.visual.media_camera2d" as const;

export const cutMediaCamera2DInputs = Object.freeze([
  "focusX",
  "focusY",
  "zoom",
  "rotation",
  "opacity",
  "edge",
] as const);

export const cutMediaCamera2DResponsiveSlotContextInput = "responsiveSlotContext" as const;

/** Closed CutAVIR inputs. `responsiveSlotContext` is compiler-owned and is
 * intentionally absent from the public constructor signature above. */
export const cutMediaCamera2DIRInputs = Object.freeze([
  ...cutMediaCamera2DInputs,
  cutMediaCamera2DResponsiveSlotContextInput,
] as const);

export const cutMediaCamera2DProperties = Object.freeze([
  "focusX",
  "focusY",
  "zoom",
  "rotation",
  "opacity",
] as const);

export const cutMediaCamera2DEdges = Object.freeze(["transparent", "clamp"] as const);

/** Closed native-crop finishing grammar. These are existing public CUT
 * wrappers; MediaCamera2D only adds a bounded execution placement for them.
 * ColorGrade remains the sole signal-driven member. */
export const cutMediaCamera2DNativeEffectOps = Object.freeze([
  "cut.visual.color_grade",
  "cut.visual.blur",
  "cut.visual.sharpen",
  "cut.visual.vignette",
  "cut.visual.grain",
  "cut.visual.duotone",
] as const);

export const cutMediaCamera2DMaximumNativeEffectDepth = 8;

export const cutMediaCamera2DLimits = Object.freeze({
  minimumFocus: zeroRational,
  maximumFocus: rational(1),
  minimumZoom: rational(1),
  maximumZoom: rational(8),
  minimumOpacity: zeroRational,
  maximumOpacity: rational(1),
  minimumRotationDegrees: rational(-360_000),
  maximumRotationDegrees: rational(360_000),
});

export type CutMediaCamera2DDiagnosticCode =
  | "CUT_MEDIA_CAMERA_SCOPE"
  | "CUT_MEDIA_CAMERA_GRAPH"
  | "CUT_MEDIA_CAMERA_CONTEXT"
  | "CUT_MEDIA_CAMERA_VALUE"
  | "CUT_MEDIA_CAMERA_NOOP";

export class CutMediaCamera2DContractError extends Error {
  constructor(
    readonly code: CutMediaCamera2DDiagnosticCode,
    readonly path: string,
    readonly nodeId: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CutMediaCamera2DContractError";
  }
}

export type CutMediaCamera2DControl = typeof cutMediaCamera2DProperties[number];
type CameraControl = CutMediaCamera2DControl;
type CameraInput = typeof cutMediaCamera2DInputs[number];

/** Canonical public defaults shared by language admission and the generic
 * sampled-output no-op validator. Keep one source of truth: omitted inputs
 * must behave exactly like their documented constructor defaults. */
export const cutMediaCamera2DControlDefaults: Readonly<Record<CameraControl, Rational>> = Object.freeze({
  focusX: rational(1, 2),
  focusY: rational(1, 2),
  zoom: rational(1),
  rotation: zeroRational,
  opacity: rational(1),
});

export function cutMediaCamera2DDefaultIRValue(property: string): IRValue | undefined {
  if (!cutMediaCamera2DProperties.includes(property as CameraControl)) return undefined;
  const magnitude = cutMediaCamera2DControlDefaults[property as CameraControl];
  if (property === "focusX" || property === "focusY" || property === "opacity") {
    return { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude };
  }
  if (property === "zoom") return { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude };
  return { kind: "quantity", dimension: "angle", unit: "deg", magnitude };
}

const cameraValueContracts: Readonly<Record<CameraControl, Readonly<{
  dimension: "ratio" | "scalar" | "angle";
  unit: "ratio" | "scalar" | "deg";
  minimum: Rational;
  maximum: Rational;
}>>> = Object.freeze({
  focusX: Object.freeze({
    dimension: "ratio",
    unit: "ratio",
    minimum: cutMediaCamera2DLimits.minimumFocus,
    maximum: cutMediaCamera2DLimits.maximumFocus,
  }),
  focusY: Object.freeze({
    dimension: "ratio",
    unit: "ratio",
    minimum: cutMediaCamera2DLimits.minimumFocus,
    maximum: cutMediaCamera2DLimits.maximumFocus,
  }),
  zoom: Object.freeze({
    dimension: "scalar",
    unit: "scalar",
    minimum: cutMediaCamera2DLimits.minimumZoom,
    maximum: cutMediaCamera2DLimits.maximumZoom,
  }),
  rotation: Object.freeze({
    dimension: "angle",
    unit: "deg",
    minimum: cutMediaCamera2DLimits.minimumRotationDegrees,
    maximum: cutMediaCamera2DLimits.maximumRotationDegrees,
  }),
  opacity: Object.freeze({
    dimension: "ratio",
    unit: "ratio",
    minimum: cutMediaCamera2DLimits.minimumOpacity,
    maximum: cutMediaCamera2DLimits.maximumOpacity,
  }),
});

const mediaLeafOps = new Set(["cut.visual.image", "cut.visual.video"]);
const mediaSpatialInputs = new Set(["x", "y", "scale", "rotation", "opacity"]);
const colorGradeSpatialInputs = new Set(["x", "y", "scale", "rotation", "opacity"]);
const nativeEffectOps = new Set<string>(cutMediaCamera2DNativeEffectOps);

function nodePath(node: IRNode) {
  return `$.nodes[${JSON.stringify(node.id)}]`;
}

function fail(node: IRNode, code: CutMediaCamera2DDiagnosticCode, path: string, message: string): never {
  throw new CutMediaCamera2DContractError(code, path, node.id, message);
}

function sameRational(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function sameInterval(left: IRNode["interval"], right: IRNode["interval"]) {
  return sameRational(left.start, right.start) && sameRational(left.duration, right.duration);
}

function quantity(
  owner: IRNode,
  value: IRValue | undefined,
  property: CameraControl,
  path: string,
) {
  const contract = cameraValueContracts[property];
  if (value?.kind !== "quantity" || value.dimension !== contract.dimension || value.unit !== contract.unit) {
    fail(
      owner,
      "CUT_MEDIA_CAMERA_VALUE",
      path,
      `${property} must be one canonical ${contract.dimension} quantity in ${JSON.stringify(contract.unit)}.`,
    );
  }
  if (compareRational(value.magnitude, contract.minimum) < 0 || compareRational(value.magnitude, contract.maximum) > 0) {
    const bounds = property === "focusX" || property === "focusY" || property === "opacity"
      ? "0% through 100%"
      : property === "zoom"
        ? "1 through 8"
        : "-360000deg through 360000deg";
    fail(owner, "CUT_MEDIA_CAMERA_VALUE", path, `${property} must remain within ${bounds}.`);
  }
  return value.magnitude;
}

function validateSignalTimes(owner: IRNode, signal: IRSignal, sceneDuration: Rational, signalPath: string) {
  const beforeEnd = (time: Rational, path: string) => {
    if (compareRational(time, sceneDuration) >= 0) {
      fail(owner, "CUT_MEDIA_CAMERA_VALUE", path, "a set/step camera value must occur before the exclusive scene end so it can execute.");
    }
  };
  const throughEnd = (time: Rational, path: string) => {
    if (compareRational(time, sceneDuration) > 0) {
      fail(owner, "CUT_MEDIA_CAMERA_VALUE", path, "camera animation/keyframe time must not exceed the complete scene interval.");
    }
  };
  if (signal.kind === "step") {
    signal.points.forEach((point, index) => beforeEnd(point.time, `${signalPath}.points[${index}].time`));
  } else if (signal.kind === "keyframes") {
    signal.keyframes.forEach((point, index) => throughEnd(point.time, `${signalPath}.keyframes[${index}].time`));
  } else if (signal.kind === "track") {
    signal.events.forEach((event, index) => {
      if (event.kind === "set") beforeEnd(event.time, `${signalPath}.events[${index}].time`);
      else {
        beforeEnd(event.start, `${signalPath}.events[${index}].start`);
        throughEnd(event.end, `${signalPath}.events[${index}].end`);
      }
    });
  }
}

function isDefaultValue(property: CameraControl, value: Rational) {
  if (property === "rotation") {
    // The reference affine contract normalizes whole turns. Authoring 360deg,
    // -720deg, and so on cannot make a default camera non-default.
    return divideRational(value, rational(360)).denominator === "1";
  }
  return sameRational(value, cutMediaCamera2DControlDefaults[property]);
}

function signalActivity(
  owner: IRNode,
  signal: IRSignal,
  property: CameraControl,
  authored: Rational | undefined,
  sceneDuration: Rational,
  signalPath: string,
) {
  validateSignalTimes(owner, signal, sceneDuration, signalPath);
  const magnitude = (value: IRValue, path: string) => quantity(owner, value, property, `${signalPath}.${path}`);
  const fallback = authored ?? cutMediaCamera2DControlDefaults[property];
  const result = (values: readonly Rational[], interpolatedPairs: readonly (readonly [Rational, Rational])[] = []) => ({
    nonDefault: values.some((value) => !isDefaultValue(property, value))
      || property === "rotation" && interpolatedPairs.some(([left, right]) => !sameRational(left, right)),
    positive: property === "opacity" && values.some((value) => compareRational(value, zeroRational) > 0),
  });

  if (signal.kind === "constant") return result([magnitude(signal.value, "value")]);
  if (signal.kind === "step") {
    if (!signal.points.length) return result([fallback]);
    return result(signal.points.map((point, index) => magnitude(point.value, `points[${index}].value`)));
  }
  if (signal.kind === "keyframes") {
    if (!signal.keyframes.length) return result([fallback]);
    const values = signal.keyframes.map((point, index) => magnitude(point.value, `keyframes[${index}].value`));
    const pairs = values.slice(1).flatMap((value, index) => compareRational(signal.keyframes[index]!.time, signal.keyframes[index + 1]!.time) < 0
      ? [[values[index]!, value] as const]
      : []);
    return result(values, pairs);
  }

  const values: Rational[] = [];
  const pairs: Array<readonly [Rational, Rational]> = [];
  const first = signal.events[0];
  const firstTime = first ? first.kind === "set" ? first.time : first.start : sceneDuration;
  if (compareRational(firstTime, zeroRational) > 0 || !first) {
    values.push(signal.initial.kind === "null" ? fallback : magnitude(signal.initial, "initial"));
  } else if (signal.initial.kind !== "null") {
    // The initial payload remains part of the closed typed contract even when
    // a zero-time event immediately supersedes it.
    magnitude(signal.initial, "initial");
  }
  signal.events.forEach((event, index) => {
    if (event.kind === "set") values.push(magnitude(event.value, `events[${index}].value`));
    else {
      const from = magnitude(event.from, `events[${index}].from`);
      const to = magnitude(event.to, `events[${index}].to`);
      values.push(from, to);
      pairs.push([from, to]);
    }
  });
  return result(values, pairs);
}

function validateCompleteChild(owner: IRNode, child: IRNode, parentCounts: ReadonlyMap<string, number>, path: string) {
  if (child.ownership !== "child" || child.sceneId !== owner.sceneId || !sameInterval(child.interval, owner.interval)) {
    fail(owner, "CUT_MEDIA_CAMERA_GRAPH", path, "every MediaCamera2D branch node must be an exact child on the camera's complete scene interval.");
  }
  if (parentCounts.get(child.id) !== 1) {
    fail(owner, "CUT_MEDIA_CAMERA_GRAPH", path, "every MediaCamera2D branch node must have exactly one direct structural parent.");
  }
}

function validateMediaLeaf(owner: IRNode, leaf: IRNode, parentCounts: ReadonlyMap<string, number>, path: string) {
  validateCompleteChild(owner, leaf, parentCounts, path);
  if (!mediaLeafOps.has(leaf.op) || leaf.children.length !== 0) {
    fail(owner, "CUT_MEDIA_CAMERA_GRAPH", path, "MediaCamera2D must terminate in exactly one childless Image or Video leaf.");
  }
  const spatialInput = Object.keys(leaf.inputs).find((name) => mediaSpatialInputs.has(name));
  if (spatialInput) {
    fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${path}.inputs.${spatialInput}`, "Image/Video spatial transforms are forbidden here; MediaCamera2D owns the only sampling transform.");
  }
  const spatialProperty = Object.keys(leaf.properties).find((name) => mediaSpatialInputs.has(name));
  if (spatialProperty) {
    fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${path}.properties.${spatialProperty}`, "Image/Video spatial property signals are forbidden here; MediaCamera2D owns the only sampling transform.");
  }
}

function validateBranch(owner: IRNode, ir: CutAVIR, parentCounts: ReadonlyMap<string, number>) {
  const path = nodePath(owner);
  if (owner.children.length !== 1) {
    fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${path}.children`, "MediaCamera2D requires exactly one direct unary branch ending in Image or Video.");
  }
  let branch = ir.nodes[owner.children[0]!];
  if (!branch) fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${path}.children[0]`, "references a missing direct media branch.");
  let parent = owner, depth = 0, colorGradeCount = 0;
  const visited = new Set<string>();
  while (branch && !mediaLeafOps.has(branch.op)) {
    if (visited.has(branch.id)) {
      fail(owner, "CUT_MEDIA_CAMERA_GRAPH", nodePath(branch), "native-crop effect branch cycles.");
    }
    visited.add(branch.id);
    validateCompleteChild(owner, branch, parentCounts, nodePath(branch));
    if (!parent.children.includes(branch.id)) {
      fail(owner, "CUT_MEDIA_CAMERA_GRAPH", nodePath(branch), `native-crop wrapper is detached from its expected parent ${parent.id}.`);
    }
    if (!nativeEffectOps.has(branch.op) || branch.children.length !== 1) {
      fail(
        owner,
        "CUT_MEDIA_CAMERA_GRAPH",
        nodePath(branch),
        "the admitted native-crop wrappers are ColorGrade, Blur, Sharpen, Vignette, Grain, and Duotone, each with exactly one child.",
      );
    }
    depth += 1;
    if (depth > cutMediaCamera2DMaximumNativeEffectDepth) {
      fail(
        owner,
        "CUT_MEDIA_CAMERA_GRAPH",
        nodePath(branch),
        `native-crop effect depth exceeds ${cutMediaCamera2DMaximumNativeEffectDepth}.`,
      );
    }
    if (branch.op === "cut.visual.color_grade") {
      colorGradeCount += 1;
      if (colorGradeCount > 1) {
        fail(owner, "CUT_MEDIA_CAMERA_GRAPH", nodePath(branch), "MediaCamera2D permits at most one ColorGrade in its native-crop effect chain.");
      }
      const spatialInput = Object.keys(branch.inputs).find((name) => colorGradeSpatialInputs.has(name));
      if (spatialInput) {
        fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${nodePath(branch)}.inputs.${spatialInput}`, "ColorGrade spatial transforms are forbidden here; MediaCamera2D owns the only sampling transform.");
      }
      const spatialProperty = Object.keys(branch.properties).find((name) => colorGradeSpatialInputs.has(name));
      if (spatialProperty) {
        fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${nodePath(branch)}.properties.${spatialProperty}`, "ColorGrade spatial property signals are forbidden here; MediaCamera2D owns the only sampling transform.");
      }
    } else {
      const property = Object.keys(branch.properties)[0];
      if (property) {
        fail(
          owner,
          "CUT_MEDIA_CAMERA_GRAPH",
          `${nodePath(branch)}.properties.${property}`,
          `${branch.op} is static in the MediaCamera2D native-crop V1 chain; property signals are unsupported.`,
        );
      }
      if (branch.op === "cut.visual.grain") {
        const mode = branch.inputs.mode;
        if (mode?.kind === "string" && mode.value === "temporal") {
          fail(
            owner,
            "CUT_MEDIA_CAMERA_GRAPH",
            `${nodePath(branch)}.inputs.mode`,
            "MediaCamera2D native-crop V1 accepts static Grain only; temporal output-frame phase is not yet part of this camera plan.",
          );
        }
      }
    }
    parent = branch;
    branch = ir.nodes[branch.children[0]!];
    if (!branch) fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${nodePath(parent)}.children[0]`, "references a missing native-crop child.");
  }
  if (!branch) fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${path}.children[0]`, "does not terminate in a media leaf.");
  validateMediaLeaf(owner, branch, parentCounts, nodePath(branch));
  if (!parent.children.includes(branch.id)) {
    fail(owner, "CUT_MEDIA_CAMERA_GRAPH", nodePath(branch), `media leaf is detached from its expected parent ${parent.id}.`);
  }
}

function validateCameraValues(owner: IRNode, ir: CutAVIR, sceneDuration: Rational) {
  const path = nodePath(owner);
  let nonDefault = false;
  let opacityCanBeVisible = true;
  for (const property of cutMediaCamera2DProperties) {
    const authored = owner.inputs[property];
    const authoredMagnitude = authored === undefined
      ? undefined
      : quantity(owner, authored, property, `${path}.inputs.${property}`);
    if (authoredMagnitude !== undefined && isDefaultValue(property, authoredMagnitude)) {
      fail(
        owner,
        "CUT_MEDIA_CAMERA_NOOP",
        `${path}.inputs.${property}`,
        `explicit ${property} repeats the canonical MediaCamera2D default; omit the argument.`,
      );
    }
    const attached = owner.properties[property];
    if (attached === undefined) {
      const effective = authoredMagnitude ?? cutMediaCamera2DControlDefaults[property];
      if (!isDefaultValue(property, effective)) nonDefault = true;
      if (property === "opacity") opacityCanBeVisible = compareRational(effective, zeroRational) > 0;
      continue;
    }
    if (!("signal" in attached)) {
      fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${path}.properties.${property}`, "camera property state must reference one ordinary typed signal; static values belong in inputs.");
    }
    const signal = ir.signals[attached.signal];
    if (!signal) fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${path}.properties.${property}.signal`, "references a missing camera property signal.");
    if (signal.kind === "track" && signal.producer) {
      fail(owner, "CUT_MEDIA_CAMERA_GRAPH", `${path}.properties.${property}.signal`, "MediaCamera2D V1 accepts authored property tracks, not analysis-producer signals.");
    }
    const expectedType = property === "focusX" || property === "focusY" || property === "opacity"
      ? "Ratio"
      : property === "zoom"
        ? "Number"
        : "Angle";
    if (signal.valueType !== expectedType) {
      fail(owner, "CUT_MEDIA_CAMERA_VALUE", `$.signals[${JSON.stringify(signal.id)}].valueType`, `${property} signal must declare ${expectedType}.`);
    }
    const signalPath = `$.signals[${JSON.stringify(signal.id)}]`;
    if (signal.kind === "track") {
      if (signal.initial.kind === "null") {
        fail(
          owner,
          "CUT_MEDIA_CAMERA_VALUE",
          `${signalPath}.initial`,
          `${property} track must carry its exact constructor/public-default baseline; null cannot discard pre-event camera semantics.`,
        );
      }
      const initial = quantity(owner, signal.initial, property, `${signalPath}.initial`);
      const expected = authoredMagnitude ?? cutMediaCamera2DControlDefaults[property];
      if (!sameRational(initial, expected)) {
        fail(
          owner,
          "CUT_MEDIA_CAMERA_VALUE",
          `${signalPath}.initial`,
          `${property} track baseline conflicts with its exact constructor/public-default value.`,
        );
      }
    }
    const activity = signalActivity(owner, signal, property, authoredMagnitude, sceneDuration, signalPath);
    if (activity.nonDefault) nonDefault = true;
    if (property === "opacity") opacityCanBeVisible = activity.positive;
  }
  const edge = owner.inputs.edge;
  if (edge !== undefined) {
    if (edge.kind !== "string" || !cutMediaCamera2DEdges.includes(edge.value as typeof cutMediaCamera2DEdges[number])) {
      fail(owner, "CUT_MEDIA_CAMERA_VALUE", `${path}.inputs.edge`, "edge must be the static String transparent or clamp.");
    }
    if (edge.value === "transparent") {
      fail(
        owner,
        "CUT_MEDIA_CAMERA_NOOP",
        `${path}.inputs.edge`,
        "explicit edge transparent repeats the canonical MediaCamera2D default; omit the argument.",
      );
    }
    nonDefault = true;
  }
  if (!nonDefault) {
    fail(owner, "CUT_MEDIA_CAMERA_NOOP", path, "all camera controls remain at their defaults for the complete scene; remove the redundant MediaCamera2D wrapper or author an executable reframe.");
  }
  if (!opacityCanBeVisible) {
    fail(owner, "CUT_MEDIA_CAMERA_NOOP", `${path}.inputs.opacity`, "opacity remains 0% for the complete scene, so the media branch and every other camera control are permanently unobservable.");
  }
}

/**
 * Close the compiler/loaded-IR half of MediaCamera2D V1. This function proves
 * only public graph, value, signal, and semantic-identity admission. Pixel
 * sampling, decode work, and frame evidence belong to the reference runtime.
 */
export function validateCutMediaCamera2DLanguageIR(ir: CutAVIR) {
  const cameras = Object.values(ir.nodes).filter((node) => node.op === cutMediaCamera2DOp);
  if (!cameras.length) return ir;
  const parentCounts = new Map<string, number>();
  const directParents = new Map<string, IRNode[]>();
  for (const node of Object.values(ir.nodes)) for (const childId of node.children) {
    parentCounts.set(childId, (parentCounts.get(childId) ?? 0) + 1);
    const parents = directParents.get(childId) ?? [];
    parents.push(node);
    directParents.set(childId, parents);
  }
  for (const camera of cameras) {
    const path = nodePath(camera), scene = camera.sceneId ? ir.scenes[camera.sceneId] : undefined;
    if (!scene) {
      fail(camera, "CUT_MEDIA_CAMERA_SCOPE", `${path}.sceneId`, "MediaCamera2D must belong to one declared scene.");
    }
    const rootCount = scene
      ? scene.rootVisualIds.filter((id) => id === camera.id).length
        + scene.items.filter((item) => item.id === camera.id && item.domain === "visual").length
      : 0;
    const parents = directParents.get(camera.id) ?? [];
    const rootCamera = Boolean(
      scene
      && camera.domain === "visual"
      && camera.ownership === "root"
      && rootCount === 2
      && parents.length === 0,
    );
    const slot = parents.length === 1 && parents[0]?.op === "cut.visual.responsive_slot"
      ? parents[0]
      : undefined;
    const slotParents = slot ? directParents.get(slot.id) ?? [] : [];
    const stack = slotParents.length === 1 && slotParents[0]?.op === "cut.visual.responsive_stack"
      ? slotParents[0]
      : undefined;
    const slotCamera = Boolean(
      scene
      && camera.domain === "visual"
      && camera.ownership === "child"
      && rootCount === 0
      && slot
      && stack,
    );
    if (!rootCamera && !slotCamera) {
      fail(
        camera,
        "CUT_MEDIA_CAMERA_SCOPE",
        path,
        "MediaCamera2D must be one direct visual scene root or the sole direct child of one ResponsiveSlot.",
      );
    }
    if (camera.editorial !== undefined) {
      fail(camera, "CUT_MEDIA_CAMERA_GRAPH", `${path}.editorial`, "MediaCamera2D is a scene camera, not an editorial container, and cannot carry hidden editorial semantics.");
    }
    if (!sameRational(camera.interval.start, zeroRational) || !sameRational(camera.interval.duration, scene.duration)) {
      fail(camera, "CUT_MEDIA_CAMERA_SCOPE", `${path}.interval`, "MediaCamera2D must span its complete scene exactly.");
    }
    const responsiveContext = camera.inputs[cutMediaCamera2DResponsiveSlotContextInput];
    if (rootCamera && responsiveContext !== undefined) {
      fail(
        camera,
        "CUT_MEDIA_CAMERA_CONTEXT",
        `${path}.inputs.${cutMediaCamera2DResponsiveSlotContextInput}`,
        "a direct scene-root MediaCamera2D cannot carry ResponsiveSlot context.",
      );
    }
    if (slotCamera) {
      if (!slot || !stack) throw new Error("Internal CUT MediaCamera2D slot narrowing failed.");
      const slotPath = nodePath(slot), stackPath = nodePath(stack);
      if (slot.ownership !== "child"
        || slot.domain !== "visual"
        || slot.sceneId !== camera.sceneId
        || slot.children.length !== 1
        || slot.children[0] !== camera.id
        || !sameInterval(slot.interval, camera.interval)
        || Object.keys(slot.inputs).length !== 0
        || Object.keys(slot.properties).length !== 0) {
        fail(
          camera,
          "CUT_MEDIA_CAMERA_GRAPH",
          slotPath,
          "the owning ResponsiveSlot must be one property-free unary visual node on the camera's exact interval.",
        );
      }
      const index = stack.children.indexOf(slot.id);
      if (index < 0
        || stack.children.filter((id) => id === slot.id).length !== 1
        || stack.sceneId !== camera.sceneId
        || !sameInterval(stack.interval, camera.interval)) {
        fail(
          camera,
          "CUT_MEDIA_CAMERA_GRAPH",
          stackPath,
          "the owning ResponsiveStack must contain this slot exactly once on the camera's exact scene interval.",
        );
      }
      const plan = stack.inputs.plan;
      if (plan === undefined || responsiveContext === undefined) {
        fail(
          camera,
          "CUT_MEDIA_CAMERA_CONTEXT",
          responsiveContext === undefined
            ? `${path}.inputs.${cutMediaCamera2DResponsiveSlotContextInput}`
            : `${stackPath}.inputs.plan`,
          "a slot-owned MediaCamera2D requires its compiler-derived responsive context and owning stack plan.",
        );
      }
      try {
        decodeCutResponsiveSlotMediaContext(
          responsiveContext,
          plan,
          { stackNodeId: stack.id, slotNodeId: slot.id, index },
          `${path}.inputs.${cutMediaCamera2DResponsiveSlotContextInput}`,
        );
      } catch (error) {
        if (!(error instanceof CutResponsiveStackError)) throw error;
        const prefix = `${error.code}: `;
        fail(
          camera,
          "CUT_MEDIA_CAMERA_CONTEXT",
          error.path,
          error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
        );
      }
    }
    validateBranch(camera, ir, parentCounts);
    validateCameraValues(camera, ir, scene.duration);
  }
  return ir;
}

export function isCutMediaCamera2DInput(value: string): value is CameraInput {
  return cutMediaCamera2DInputs.includes(value as CameraInput);
}
