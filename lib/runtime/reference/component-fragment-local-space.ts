import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { defaultCutAvIrValidationLimits } from "../../language/ir-loader";
import { addRational, compareRational, rational, type Rational } from "../../language/rational";
import {
  decodeReferenceAnchoredPathGeometry,
  decodeReferenceSpatialPointGeometry,
  referenceAnchoredPathPolicyHiddenExecutionIdentity,
} from "./anchored-path";
import type { ReferenceLocalSpaceConfig, ReferenceLocalSpacePlacement } from "./local-space";
import {
  planReferenceLocalSpaceAffineCompositionTransformWork,
  planReferenceLocalSpaceAffineTileTransformWork,
  planReferenceLocalSpaceTileTransformWork,
  referenceLocalSpaceTransformWorkLimits,
  type ReferenceLocalSpaceAffineCompositionTransformRequest,
  type ReferenceLocalSpaceAffineCompositionTransformWork,
  type ReferenceLocalSpaceAffineTileTransformWork,
  type ReferenceLocalSpaceAffineTransformRequest,
  type ReferenceLocalSpaceCompositionTransformWork,
  type ReferenceLocalSpaceDestinationClippedCompositionTransformWork,
  type ReferenceLocalSpaceUniformTileTransformWork,
} from "./local-space-transform-work";
import { referenceRetainedSurfacePhaseUnits } from "./retained-surface";
import type { ReferencePreparedSignalResolver } from "./signals";
import {
  ReferenceVisualConfigError,
  referenceVisualTransformAt,
} from "./visual-config";

/** Additive retained-owner branch for the exact public shape
 * `scene root Visual component fragment -> one LocalSpace`. The component's
 * authored name is never a dispatch key. */
export const referenceComponentFragmentLocalSpaceAlgorithmVersion = "cut-reference-local-space-component-fragment-owner-v1" as const;
export const referenceLocalSpaceCompositionTransformPreflightAlgorithmVersion = "cut-reference-local-space-composition-transform-preflight-v1" as const;

export const referenceComponentFragmentLocalSpaceTransformOrder = Object.freeze([
  "local-registration",
  "scale",
  "rotation",
  "delivery-translation",
  "opacity",
] as const);

export const referenceComponentFragmentLocalSpaceProperties = Object.freeze([
  "opacity",
  "x",
  "y",
  "scale",
  "rotation",
] as const);

const acceptedProperties = new Set<string>(referenceComponentFragmentLocalSpaceProperties);

type ReferenceComponentFragmentSceneMembership = Readonly<{ sceneId: string; domain: string }>;

/** One linear graph index shared by every component-fragment admission in an
 * untrusted IR document. Without this index, each LocalSpace would rescan the
 * complete node/scene/composition graph and turn the public 100k-node/4096-
 * LocalSpace limits into a quadratic CPU and allocation surface. */
export type ReferenceComponentFragmentLocalSpaceAdmissionIndex = Readonly<{
  parentIdsForChild(id: string): readonly string[];
  sceneMembershipsForNode(id: string): readonly ReferenceComponentFragmentSceneMembership[];
  compositionRootIdsForNode(id: string): readonly string[];
  compositionIdsForScene(id: string): readonly string[];
}>;

function appendIndexValue<T>(index: Map<string, T[]>, key: string, value: T) {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

function freezeIndexValues<T>(source: Map<string, T[]>): (id: string) => readonly T[] {
  const closed = new Map([...source].map(([key, values]) => [key, Object.freeze([...values])]));
  const empty = Object.freeze([]) as readonly T[];
  // The mutable Map never crosses this closure. `ReadonlyMap` is only a
  // compile-time view and can still be mutated by JavaScript or a TypeScript
  // cast; a lookup capability has no such `.set/.delete/.clear` back door.
  return (id: string) => closed.get(id) ?? empty;
}

export function createReferenceComponentFragmentLocalSpaceAdmissionIndex(
  ir: CutAVIR,
): ReferenceComponentFragmentLocalSpaceAdmissionIndex {
  const parentIdsByChild = new Map<string, string[]>();
  const sceneMembershipsByNode = new Map<string, ReferenceComponentFragmentSceneMembership[]>();
  const compositionRootIdsByNode = new Map<string, string[]>();
  const compositionIdsByScene = new Map<string, string[]>();
  for (const candidate of Object.values(ir.nodes)) {
    for (const childId of candidate.children) appendIndexValue(parentIdsByChild, childId, candidate.id);
  }
  for (const scene of Object.values(ir.scenes)) {
    for (const item of scene.items) {
      appendIndexValue(sceneMembershipsByNode, item.id, Object.freeze({ sceneId: scene.id, domain: item.domain }));
    }
  }
  for (const composition of ir.compositions) {
    for (const item of composition.items) {
      if (item.kind === "node") appendIndexValue(compositionRootIdsByNode, item.id, composition.id);
    }
    for (const sceneId of composition.sceneIds) appendIndexValue(compositionIdsByScene, sceneId, composition.id);
  }
  return Object.freeze({
    parentIdsForChild: freezeIndexValues(parentIdsByChild),
    sceneMembershipsForNode: freezeIndexValues(sceneMembershipsByNode),
    compositionRootIdsForNode: freezeIndexValues(compositionRootIdsByNode),
    compositionIdsForScene: freezeIndexValues(compositionIdsByScene),
  });
}

export type ReferenceComponentFragmentLocalSpaceAdmissionIssue = Readonly<{
  subject: "owner" | "local-space";
  field: "op" | "domain" | "effects" | "editorial" | "inputs" | "properties" | "children" | "interval" | "ownership" | "sceneId";
  key?: string;
  runtimeCode: "CUT_LOCAL_SPACE_TYPE" | "CUT_LOCAL_SPACE_GRAPH" | "CUT_LOCAL_SPACE_UNSUPPORTED";
  loaderCode: "CUT_IR_TYPE" | "CUT_IR_IDENTITY" | "CUT_IR_TIMING" | "CUT_IR_UNKNOWN_FIELD";
  detail: string;
}>;

function issue(
  subject: ReferenceComponentFragmentLocalSpaceAdmissionIssue["subject"],
  field: ReferenceComponentFragmentLocalSpaceAdmissionIssue["field"],
  runtimeCode: ReferenceComponentFragmentLocalSpaceAdmissionIssue["runtimeCode"],
  loaderCode: ReferenceComponentFragmentLocalSpaceAdmissionIssue["loaderCode"],
  detail: string,
  key?: string,
): ReferenceComponentFragmentLocalSpaceAdmissionIssue {
  return Object.freeze({ subject, field, ...(key === undefined ? {} : { key }), runtimeCode, loaderCode, detail });
}

function exactInterval(left: IRNode, right: IRNode) {
  return compareRational(left.interval.start, right.interval.start) === 0
    && compareRational(left.interval.duration, right.interval.duration) === 0;
}

/** One shared indexed admission predicate for the runtime validator and the
 * strict untrusted-IR loader. It intentionally rejects composition roots and
 * every nested owner form; matrix-composed ownership is a separate future
 * slice. */
export function referenceComponentFragmentLocalSpaceAdmissionIssue(
  index: ReferenceComponentFragmentLocalSpaceAdmissionIndex,
  owner: IRNode,
  localSpace: IRNode,
  expectedComposition?: IRComposition,
): ReferenceComponentFragmentLocalSpaceAdmissionIssue | undefined {
  if (owner.op !== "cut.kernel.fragment") {
    return issue("owner", "op", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_UNKNOWN_FIELD", `owner ${owner.op} is not the exact cut.kernel.fragment retained-owner slice.`);
  }
  if (localSpace.op !== "cut.visual.local_space") {
    return issue("local-space", "op", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_TYPE", `component fragment child ${localSpace.id} is not cut.visual.local_space.`);
  }
  if (owner.domain !== "visual") {
    return issue("owner", "domain", "CUT_LOCAL_SPACE_TYPE", "CUT_IR_TYPE", `component fragment owner must have visual domain; found ${owner.domain}.`);
  }
  if (owner.effects.length !== 1 || owner.effects[0] !== "pure") {
    return issue("owner", "effects", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_UNKNOWN_FIELD", "component fragment owner must declare exactly the single pure effect capability.");
  }
  if (owner.editorial !== undefined) {
    return issue("owner", "editorial", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_UNKNOWN_FIELD", "component fragment owner cannot carry an editorial payload in the direct retained-owner slice.");
  }
  const input = Object.keys(owner.inputs).sort()[0];
  if (input !== undefined) {
    return issue("owner", "inputs", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_UNKNOWN_FIELD", `component fragment owner accepts no IR inputs after parameter substitution; found ${JSON.stringify(input)}.`, input);
  }
  const property = Object.keys(owner.properties).sort().find((name) => !acceptedProperties.has(name));
  if (property !== undefined) {
    return issue("owner", "properties", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_UNKNOWN_FIELD", `component fragment owner property ${JSON.stringify(property)} is outside the closed opacity/x/y/scale/rotation placement contract.`, property);
  }
  if (owner.children.length !== 1 || owner.children[0] !== localSpace.id) {
    return issue("local-space", "children", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_UNKNOWN_FIELD", `component fragment owner must contain exactly this LocalSpace and no siblings; found ${owner.children.length} children.`);
  }
  if (!exactInterval(owner, localSpace)) {
    return issue("local-space", "interval", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_TIMING", "component fragment and LocalSpace must share exactly equal start and duration.");
  }
  if (owner.ownership !== "root") {
    return issue("owner", "ownership", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_IDENTITY", "component fragment owner must be a direct scene root; nested, reference, and detached ownership are unsupported.");
  }
  if (!owner.sceneId) {
    return issue("owner", "sceneId", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_IDENTITY", "component fragment owner must belong to one scene; composition-root ownership is unsupported.");
  }
  if (localSpace.sceneId !== owner.sceneId) {
    return issue("local-space", "sceneId", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_IDENTITY", `LocalSpace sceneId must equal its component fragment owner's sceneId ${owner.sceneId}.`);
  }

  const ownerParentIds = index.parentIdsForChild(owner.id);
  if (ownerParentIds.length !== 0) {
    return issue("owner", "ownership", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_IDENTITY", `component fragment owner must have zero structural parents; found ${ownerParentIds.join(", ")}.`);
  }
  const sceneMemberships = index.sceneMembershipsForNode(owner.id);
  if (sceneMemberships.length !== 1) {
    return issue("owner", "ownership", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_IDENTITY", `component fragment owner must appear in exactly one scene root list; found ${sceneMemberships.length}.`);
  }
  const sceneMembership = sceneMemberships[0]!;
  if (sceneMembership.sceneId !== owner.sceneId || sceneMembership.domain !== "visual") {
    return issue("owner", "sceneId", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_IDENTITY", `component fragment owner must be the visual root of scene ${owner.sceneId}; found ${sceneMembership.sceneId}/${sceneMembership.domain}.`);
  }
  const compositionRootMemberships = index.compositionRootIdsForNode(owner.id);
  if (compositionRootMemberships.length !== 0) {
    return issue("owner", "ownership", "CUT_LOCAL_SPACE_UNSUPPORTED", "CUT_IR_IDENTITY", "component fragment owner cannot also be a composition root.");
  }
  const sceneCompositionOwnerIds = index.compositionIdsForScene(owner.sceneId!);
  if (sceneCompositionOwnerIds.length !== 1
    || (expectedComposition !== undefined && sceneCompositionOwnerIds[0] !== expectedComposition.id)) {
    return issue("owner", "sceneId", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_IDENTITY", `component fragment scene ${owner.sceneId} must belong to exactly the active composition.`);
  }
  if (localSpace.ownership !== "child") {
    return issue("local-space", "ownership", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_IDENTITY", "component-owned LocalSpace must have child ownership.");
  }
  const localParentIds = index.parentIdsForChild(localSpace.id);
  if (localParentIds.length !== 1 || localParentIds[0] !== owner.id) {
    return issue("local-space", "ownership", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_IDENTITY", `component-owned LocalSpace must have exactly its fragment as structural parent; found ${localParentIds.join(", ") || "none"}.`);
  }
  const localRootMemberships = index.sceneMembershipsForNode(localSpace.id).length
    + index.compositionRootIdsForNode(localSpace.id).length;
  if (localRootMemberships !== 0) {
    return issue("local-space", "ownership", "CUT_LOCAL_SPACE_GRAPH", "CUT_IR_IDENTITY", "component-owned LocalSpace cannot also appear as a scene or composition root.");
  }
  return undefined;
}

export type ReferenceComponentFragmentLocalSpaceErrorCode =
  | "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH"
  | "CUT_COMPONENT_FRAGMENT_LOCAL_TRANSFORM";

export class ReferenceComponentFragmentLocalSpaceError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceComponentFragmentLocalSpaceErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: component-fragment LocalSpace at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceComponentFragmentLocalSpaceError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceComponentFragmentLocalSpacePlan = Readonly<{
  algorithmVersion: typeof referenceComponentFragmentLocalSpaceAlgorithmVersion;
  ownerNodeId: string;
  localSpaceNodeId: string;
  sceneId: string;
  exactTime: Rational;
  transformOrder: typeof referenceComponentFragmentLocalSpaceTransformOrder;
  status: "visible" | "opacity-zero";
  placement: ReferenceLocalSpacePlacement;
  transformWork?: ReferenceLocalSpaceUniformTileTransformWork;
  planIdentity: string;
}>;

function fail(node: IRNode, code: ReferenceComponentFragmentLocalSpaceErrorCode, detail: string): never {
  throw new ReferenceComponentFragmentLocalSpaceError(code, node, detail);
}

function assertValidatedBinding(owner: IRNode, localSpace: ReferenceLocalSpaceConfig) {
  if (owner.op !== "cut.kernel.fragment" || owner.domain !== "visual"
    || owner.effects.length !== 1 || owner.effects[0] !== "pure"
    || owner.editorial !== undefined || Object.keys(owner.inputs).length !== 0
    || Object.keys(owner.properties).some((property) => !acceptedProperties.has(property))
    || owner.children.length !== 1 || owner.children[0] !== localSpace.nodeId
    || owner.ownership !== "root" || !owner.sceneId
    || localSpace.owner !== "component-fragment" || localSpace.ownerNodeId !== owner.id) {
    fail(owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `owner/config binding for LocalSpace ${localSpace.nodeId} is outside the validated direct scene-root unary fragment slice.`);
  }
}

function rasterOrigin(localSpace: ReferenceLocalSpaceConfig) {
  return Object.freeze({
    x: Number(BigInt(localSpace.rasterOriginQ16.x)) / referenceRetainedSurfacePhaseUnits,
    y: Number(BigInt(localSpace.rasterOriginQ16.y)) / referenceRetainedSurfacePhaseUnits,
  });
}

export function referenceComponentFragmentLocalSpaceContextIdentity(
  composition: IRComposition,
  owner: IRNode,
  localSpace: ReferenceLocalSpaceConfig,
) {
  assertValidatedBinding(owner, localSpace);
  return hash({
    kind: "component-fragment-local-space-placement-context",
    algorithmVersion: referenceComponentFragmentLocalSpaceAlgorithmVersion,
    composition: { id: composition.id, width: composition.width, height: composition.height },
    sceneId: owner.sceneId,
    // Sampled transform values and exact work live in the placement itself.
    // Excluding whole-fragment content prevents a child/media-only edit (or a
    // track edit with the same exact-frame sample) from invalidating placement.
    ownerNodeId: owner.id,
    localSpaceNodeId: localSpace.nodeId,
  });
}

/** Resolve and bound the exact fragment placement before the renderer asks
 * the LocalSpace for pixels. The context identity is deliberately local: no
 * project-wide buildId or unrelated scene state participates. */
export function referenceComponentFragmentLocalSpacePlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  owner: IRNode,
  localSpace: ReferenceLocalSpaceConfig,
  exactTime: Rational,
  resolver?: ReferencePreparedSignalResolver,
): ReferenceComponentFragmentLocalSpacePlan {
  assertValidatedBinding(owner, localSpace);
  let transform;
  try {
    transform = referenceVisualTransformAt(
      ir,
      // Fragment x/y and the public scale ceiling live in the delivery
      // composition. Exact retained-tile intermediate work is bounded
      // separately below from the LocalSpace source dimensions.
      composition,
      owner,
      exactTime,
      { staticPosition: true, staticRotation: true },
      resolver,
    );
  } catch (error) {
    if (!(error instanceof ReferenceVisualConfigError)) throw error;
    fail(owner, "CUT_COMPONENT_FRAGMENT_LOCAL_TRANSFORM", error.message);
  }
  if (transform.anchorX !== 0 || transform.anchorY !== 0 || transform.skewX !== 0 || transform.skewY !== 0) {
    fail(owner, "CUT_COMPONENT_FRAGMENT_LOCAL_TRANSFORM", "accepts only opacity, x, y, scale, and rotation; anchor/skew cannot alter the retained branch.");
  }
  const origin = rasterOrigin(localSpace);
  const placement: ReferenceLocalSpacePlacement = Object.freeze({
    owner: "component-fragment",
    contextIdentity: referenceComponentFragmentLocalSpaceContextIdentity(composition, owner, localSpace),
    destinationX: composition.width / 2 + transform.x,
    destinationY: composition.height / 2 + transform.y,
    registrationRasterX: origin.x,
    registrationRasterY: origin.y,
    scale: transform.scale,
    skewX: 0,
    skewY: 0,
    rotation: transform.rotation,
    opacity: transform.opacity,
  });
  const transformWork = transform.opacity === 0 ? undefined : planReferenceLocalSpaceTileTransformWork(owner, {
    source: Object.freeze({ width: localSpace.width, height: localSpace.height }),
    destination: Object.freeze({ width: composition.width, height: composition.height }),
    scale: transform.scale,
    rotation: transform.rotation,
    opacity: transform.opacity,
  });
  const receipt = Object.freeze({
    algorithmVersion: referenceComponentFragmentLocalSpaceAlgorithmVersion,
    ownerNodeId: owner.id,
    localSpaceNodeId: localSpace.nodeId,
    sceneId: owner.sceneId!,
    exactTime: Object.freeze({ ...exactTime }),
    transformOrder: referenceComponentFragmentLocalSpaceTransformOrder,
    status: transform.opacity === 0 ? "opacity-zero" as const : "visible" as const,
    placement,
    ...(transformWork ? { transformWork } : {}),
  });
  return Object.freeze({ ...receipt, planIdentity: hash(receipt) });
}

export type ReferenceComponentFragmentLocalSpaceCompositionEntry = Readonly<{
  owner: IRNode;
  localSpace: ReferenceLocalSpaceConfig;
  exactTime: Rational;
}>;

export type ReferenceLocalSpaceCompositionTransformPreflightContext = Readonly<{
  sceneId: string;
  exactTime: Rational;
  outputFrame?: string;
}>;

export type ReferenceAffineLocalSpaceOwnerKind = Extract<ReferenceLocalSpaceConfig["owner"],
  | "scene-root"
  | "component-fragment"
  | "group"
  | "motion-path"
  | "camera-2d"
  | "local-space"
  | "geo-annotation"
  | "callout"
  | "track-2d"
  | "depth-layer">;

export type ReferenceLocalSpaceCompositionTransformPreflightEntry = Readonly<{
  owner: IRNode;
  localSpace: ReferenceLocalSpaceConfig;
  ownerKind: ReferenceAffineLocalSpaceOwnerKind;
  exactTime: Rational;
  status: "visible" | "opacity-zero" | "policy-hidden";
  transform?: ReferenceLocalSpaceAffineTransformRequest;
  policyHiddenBy?: Readonly<{
    kind: "anchored-path-owner-policy";
    executionIdentity: string;
    trackOwnerNodeIds: readonly string[];
  }>;
}>;

export type ReferenceLocalSpaceCompositionTransformPreflightEvidence = Readonly<{
  format: "cut-reference-local-space-composition-transform-preflight";
  version: 1;
  algorithmVersion: typeof referenceLocalSpaceCompositionTransformPreflightAlgorithmVersion;
  compositionId: string;
  sceneId: string;
  exactTime: Rational;
  outputFrame?: string;
  status: "admitted" | "zero-visible-affine-placements";
  admissions: readonly Readonly<{
    ownerNodeId: string;
    localSpaceNodeId: string;
    ownerKind: ReferenceAffineLocalSpaceOwnerKind;
    sampleTime: Rational;
    planIdentity: string;
    work: ReferenceLocalSpaceAffineTileTransformWork;
  }>[];
  skips: readonly Readonly<{
    ownerNodeId: string;
    localSpaceNodeId: string;
    ownerKind: ReferenceAffineLocalSpaceOwnerKind;
    sampleTime: Rational;
    status: "opacity-zero" | "policy-hidden";
    planIdentity: string;
    policyHiddenBy?: ReferenceLocalSpaceCompositionTransformPreflightEntry["policyHiddenBy"];
  }>[];
  aggregate?: ReferenceLocalSpaceCompositionTransformWork
    | ReferenceLocalSpaceAffineCompositionTransformWork
    | ReferenceLocalSpaceDestinationClippedCompositionTransformWork;
  preflightIdentity: string;
}>;

export type ReferenceComponentFragmentLocalSpaceFramePreflight = ReferenceLocalSpaceCompositionTransformPreflightEvidence & Readonly<{
  /** Additive compatibility evidence for the component-only wrapper. */
  plans: readonly Readonly<{
    ownerNodeId: string;
    localSpaceNodeId: string;
    plan: ReferenceComponentFragmentLocalSpacePlan;
  }>[];
}>;

function activeAt(node: IRNode, time: Rational) {
  return compareRational(time, node.interval.start) >= 0
    && compareRational(time, addRational(node.interval.start, node.interval.duration)) < 0;
}

function assertClosedPreflightRecord(
  node: IRNode,
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} must have a plain or null prototype.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} cannot contain symbol properties.`);
  }
  const names = keys as string[], accepted = new Set([...required, ...optional]);
  const unknown = names.find((name) => !accepted.has(name));
  if (unknown !== undefined) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} does not accept property ${JSON.stringify(unknown)}.`);
  }
  const missing = required.find((name) => !names.includes(name));
  if (missing !== undefined) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} requires property ${JSON.stringify(missing)}.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const accessor = names.find((name) => !descriptors[name] || !("value" in descriptors[name]!) || !descriptors[name]!.enumerable);
  if (accessor !== undefined) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label}.${accessor} must be one enumerable data property.`);
  }
}

function assertExactPreflightTime(node: IRNode, value: unknown, label: string): asserts value is Rational {
  assertClosedPreflightRecord(node, value, label, ["numerator", "denominator"]);
  const candidate = value as Partial<Rational>;
  if (typeof candidate.numerator !== "string" || typeof candidate.denominator !== "string"
    || !/^-?(?:0|[1-9][0-9]*)$/u.test(candidate.numerator)
    || candidate.numerator === "-0"
    || !/^(?:[1-9][0-9]*)$/u.test(candidate.denominator)) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} must be one canonical exact rational with a positive denominator.`);
  }
  const numeratorDigits = candidate.numerator.startsWith("-") ? candidate.numerator.length - 1 : candidate.numerator.length;
  if (numeratorDigits > defaultCutAvIrValidationLimits.maxRationalDigits
    || candidate.denominator.length > defaultCutAvIrValidationLimits.maxRationalDigits) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} exceeds the ${defaultCutAvIrValidationLimits.maxRationalDigits}-digit exact-rational budget.`);
  }
  const canonical = rational(candidate.numerator, candidate.denominator);
  if (canonical.numerator !== candidate.numerator || canonical.denominator !== candidate.denominator) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} must be reduced to canonical lowest terms.`);
  }
}

function assertClosedDenseStringArray(node: IRNode, value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} must be one dense array.`);
  const unsupported = Reflect.ownKeys(value).find((key) => {
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return true;
    const index = Number(key);
    return !Number.isSafeInteger(index) || index < 0 || index >= value.length;
  });
  if (unsupported !== undefined) {
    fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label} cannot contain property ${JSON.stringify(String(unsupported))}.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      fail(node, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${label}[${index}] must be one enumerable string data item.`);
    }
  }
}

/** One source-located, exact-frame admission boundary for every affine
 * LocalSpace placement that can retain a delivery-canvas output. Raw requests
 * cross this boundary; callers cannot provide aggregate or work receipts. */
export function referenceLocalSpaceCompositionTransformPreflight(
  ir: CutAVIR,
  composition: IRComposition,
  context: ReferenceLocalSpaceCompositionTransformPreflightContext,
  entries: readonly ReferenceLocalSpaceCompositionTransformPreflightEntry[],
): ReferenceLocalSpaceCompositionTransformPreflightEvidence {
  const fallback = Object.values(ir.nodes)[0];
  if (!fallback) throw new Error("CUT_LOCAL_SPACE_GRAPH: affine frame preflight requires at least one source-located IR node.");
  assertClosedPreflightRecord(fallback, context, "affine frame preflight context", ["sceneId", "exactTime"], ["outputFrame"]);
  assertExactPreflightTime(fallback, context.exactTime, "affine frame preflight context.exactTime");
  if (typeof context.sceneId !== "string" || (context.outputFrame !== undefined && typeof context.outputFrame !== "string")) {
    fail(fallback, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", "affine frame preflight context sceneId/outputFrame must be strings.");
  }
  if (context.outputFrame !== undefined
    && (!/^(?:0|[1-9][0-9]*)$/u.test(context.outputFrame)
      || context.outputFrame.length > defaultCutAvIrValidationLimits.maxRationalDigits)) {
    fail(fallback, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `affine frame preflight outputFrame must be one canonical nonnegative integer within ${defaultCutAvIrValidationLimits.maxRationalDigits} digits.`);
  }
  if (!Array.isArray(entries)) {
    fail(fallback, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", "affine frame preflight entries must be one dense array.");
  }
  if (entries.length > referenceLocalSpaceTransformWorkLimits.maximumCompositionPreflightEntries) {
    fail(
      fallback,
      "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH",
      `affine frame preflight entry count ${entries.length} exceeds ${referenceLocalSpaceTransformWorkLimits.maximumCompositionPreflightEntries}.`,
    );
  }
  if (!composition.sceneIds.includes(context.sceneId) || !ir.scenes[context.sceneId]) {
    fail(fallback, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `frame preflight scene ${context.sceneId} is not owned by composition ${composition.id}.`);
  }
  const contextScene = ir.scenes[context.sceneId]!;
  if (compareRational(context.exactTime, rational(0)) < 0
    || compareRational(context.exactTime, contextScene.duration) >= 0) {
    fail(fallback, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `frame preflight exact time must fall inside scene ${context.sceneId}'s half-open local duration.`);
  }
  const pairs = new Set<string>();
  const admissions: Array<ReferenceLocalSpaceCompositionTransformPreflightEvidence["admissions"][number]> = [];
  const skips: Array<ReferenceLocalSpaceCompositionTransformPreflightEvidence["skips"][number]> = [];
  const requests: ReferenceLocalSpaceAffineCompositionTransformRequest[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (!Object.hasOwn(entries, index)) {
      fail(fallback, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `affine frame preflight entries cannot contain a hole at index ${index}.`);
    }
    const unknownEntry = entries[index] as unknown;
    assertClosedPreflightRecord(fallback, unknownEntry, `affine frame preflight entry ${index}`, ["owner", "localSpace", "ownerKind", "exactTime", "status"], ["transform", "policyHiddenBy"]);
    const entry = unknownEntry as ReferenceLocalSpaceCompositionTransformPreflightEntry;
    assertExactPreflightTime(fallback, entry.exactTime, `affine frame preflight entry ${index}.exactTime`);
    if (entry.status !== "visible" && entry.status !== "opacity-zero" && entry.status !== "policy-hidden") {
      fail(fallback, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `affine frame preflight entry ${index} has unsupported status ${JSON.stringify(entry.status)}.`);
    }
    const ownerId = entry.owner && typeof entry.owner === "object"
      ? Object.getOwnPropertyDescriptor(entry.owner, "id")?.value
      : undefined;
    const localSpaceNodeId = entry.localSpace && typeof entry.localSpace === "object"
      ? Object.getOwnPropertyDescriptor(entry.localSpace, "nodeId")?.value
      : undefined;
    const canonicalOwner = typeof ownerId === "string" ? ir.nodes[ownerId] : undefined;
    const localNode = typeof localSpaceNodeId === "string" ? ir.nodes[localSpaceNodeId] : undefined;
    if (!canonicalOwner || canonicalOwner !== entry.owner || !localNode || localNode.op !== "cut.visual.local_space") {
      fail(canonicalOwner ?? fallback, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `frame preflight entry ${index} is not bound to canonical IR owner/LocalSpace nodes.`);
    }
    if (entry.ownerKind !== entry.localSpace.owner
      || (entry.ownerKind !== "scene-root" && entry.localSpace.ownerNodeId !== entry.owner.id)
      || (entry.ownerKind === "scene-root" && entry.owner.id !== localNode.id)) {
      fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `frame preflight entry ${index} owner/local-space binding is inconsistent for ${entry.ownerKind}.`);
    }
    if (entry.owner.sceneId !== context.sceneId || localNode.sceneId !== context.sceneId) {
      fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `frame preflight entry ${index} must bind scene ${context.sceneId}.`);
    }
    if (!activeAt(entry.owner, entry.exactTime) || !activeAt(localNode, entry.exactTime)) {
      fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `frame preflight entry ${index} is inactive at its claimed exact frame.`);
    }
    const pair = `${entry.owner.id}\u0000${entry.localSpace.nodeId}\u0000${entry.exactTime.numerator}/${entry.exactTime.denominator}`;
    if (pairs.has(pair)) {
      fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `frame preflight entry ${index} duplicates owner/LocalSpace pair ${entry.owner.id}/${entry.localSpace.nodeId}.`);
    }
    pairs.add(pair);
    if (entry.status === "policy-hidden") {
      if (entry.ownerKind === "track-2d") {
        if (entry.policyHiddenBy !== undefined) fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", "direct Track2D policy-hidden placement cannot claim a transitive policy source.");
      } else if (entry.ownerKind === "motion-path" || entry.ownerKind === "callout") {
        const ownerLabel = entry.ownerKind === "motion-path" ? "MotionPath" : "Callout";
        const cause = entry.policyHiddenBy;
        if (!cause) {
          fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${ownerLabel} policy-hidden placement requires one canonical anchored-path Track2D suppression cause.`);
        }
        assertClosedPreflightRecord(
          entry.owner,
          cause,
          `${ownerLabel} policyHiddenBy`,
          ["kind", "executionIdentity", "trackOwnerNodeIds"],
        );
        assertClosedDenseStringArray(entry.owner, cause.trackOwnerNodeIds, `${ownerLabel} policyHiddenBy.trackOwnerNodeIds`);
        if (cause.kind !== "anchored-path-owner-policy"
          || typeof cause.executionIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(cause.executionIdentity)
          || cause.trackOwnerNodeIds.length < 1
          || cause.trackOwnerNodeIds.some((id) => typeof id !== "string" || ir.nodes[id]?.op !== "cut.visual.track_2d")
          || [...cause.trackOwnerNodeIds].sort().some((id, causeIndex) => cause.trackOwnerNodeIds[causeIndex] !== id)
          || new Set(cause.trackOwnerNodeIds).size !== cause.trackOwnerNodeIds.length) {
          fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${ownerLabel} policy-hidden placement requires one canonical anchored-path Track2D suppression cause.`);
        }
        let geometry;
        try {
          geometry = entry.ownerKind === "motion-path"
            ? decodeReferenceAnchoredPathGeometry(entry.owner, entry.owner.inputs.geometry, "input \u201cgeometry\u201d")
            : decodeReferenceSpatialPointGeometry(entry.owner, entry.owner.inputs.anchor, "input \u201canchor\u201d");
        } catch {
          fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${ownerLabel} policy-hidden placement must own one valid public anchored geometry.`);
        }
        const identitySuppressions = cause.trackOwnerNodeIds.map((trackOwnerNodeId) => {
          if (!geometry.ownerNodeIds.includes(trackOwnerNodeId)) {
            fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${ownerLabel} policy-hidden Track2D cause ${trackOwnerNodeId} is not referenced by its anchored geometry.`);
          }
          const trackOwner = ir.nodes[trackOwnerNodeId]!;
          const localSpaceNodeIds = trackOwner.children.filter((childId) => ir.nodes[childId]?.op === "cut.visual.local_space");
          if (localSpaceNodeIds.length !== 1) {
            fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `MotionPath policy-hidden Track2D cause ${trackOwnerNodeId} must own exactly one direct LocalSpace.`);
          }
          return Object.freeze({
            ownerNodeId: trackOwnerNodeId,
            ownerKind: "track-2d" as const,
            localSpaceNodeId: localSpaceNodeIds[0]!,
          });
        });
        const expectedExecutionIdentity = referenceAnchoredPathPolicyHiddenExecutionIdentity(
          geometry.semanticIdentity,
          entry.exactTime,
          identitySuppressions,
        );
        if (cause.executionIdentity !== expectedExecutionIdentity) {
          fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `${ownerLabel} policy-hidden placement carries an unauthenticated anchored-path execution identity.`);
        }
      } else {
        fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `only Track2D may claim a policy-hidden affine placement directly; an anchored MotionPath or Callout additionally requires canonical transitive Track2D evidence; found ${entry.ownerKind}.`);
      }
    } else if (entry.policyHiddenBy !== undefined) {
      fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", "policyHiddenBy is valid only for a policy-hidden MotionPath or Callout placement.");
    }
    if (entry.status === "visible") {
      if (!entry.transform) fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_TRANSFORM", `visible frame preflight entry ${index} has no raw transform request.`);
      const work = planReferenceLocalSpaceAffineTileTransformWork(entry.owner, entry.transform!);
      const planIdentity = hash({
        algorithmVersion: referenceLocalSpaceCompositionTransformPreflightAlgorithmVersion,
        compositionId: composition.id,
        sceneId: context.sceneId,
        outputExactTime: context.exactTime,
        sampleTime: entry.exactTime,
        owner: { id: entry.owner.id, op: entry.owner.op, contentHash: entry.owner.contentHash },
        localSpace: { nodeId: entry.localSpace.nodeId, semanticIdentity: entry.localSpace.semanticIdentity },
        ownerKind: entry.ownerKind,
        status: entry.status,
        transform: entry.transform,
        workIdentity: work.workIdentity,
      });
      requests.push(Object.freeze({ node: entry.owner, transform: entry.transform! }));
      admissions.push(Object.freeze({
        ownerNodeId: entry.owner.id,
        localSpaceNodeId: entry.localSpace.nodeId,
        ownerKind: entry.ownerKind,
        sampleTime: Object.freeze({ ...entry.exactTime }),
        planIdentity,
        work,
      }));
    } else {
      if (entry.transform !== undefined) fail(entry.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_TRANSFORM", `skipped frame preflight entry ${index} cannot carry transform work.`);
      const planIdentity = hash({
        algorithmVersion: referenceLocalSpaceCompositionTransformPreflightAlgorithmVersion,
        compositionId: composition.id,
        sceneId: context.sceneId,
        outputExactTime: context.exactTime,
        sampleTime: entry.exactTime,
        owner: { id: entry.owner.id, op: entry.owner.op, contentHash: entry.owner.contentHash },
        localSpace: { nodeId: entry.localSpace.nodeId, semanticIdentity: entry.localSpace.semanticIdentity },
        ownerKind: entry.ownerKind,
        status: entry.status,
        ...(entry.policyHiddenBy ? { policyHiddenBy: entry.policyHiddenBy } : {}),
      });
      skips.push(Object.freeze({
        ownerNodeId: entry.owner.id,
        localSpaceNodeId: entry.localSpace.nodeId,
        ownerKind: entry.ownerKind,
        sampleTime: Object.freeze({ ...entry.exactTime }),
        status: entry.status,
        planIdentity,
        ...(entry.policyHiddenBy ? { policyHiddenBy: entry.policyHiddenBy } : {}),
      }));
    }
  }
  const aggregate = requests.length
    ? planReferenceLocalSpaceAffineCompositionTransformWork(requests.at(-1)!.node, composition, requests)
    : undefined;
  const receipt = Object.freeze({
    format: "cut-reference-local-space-composition-transform-preflight" as const,
    version: 1 as const,
    algorithmVersion: referenceLocalSpaceCompositionTransformPreflightAlgorithmVersion,
    compositionId: composition.id,
    sceneId: context.sceneId,
    exactTime: Object.freeze({ ...context.exactTime }),
    ...(context.outputFrame === undefined ? {} : { outputFrame: context.outputFrame }),
    status: aggregate ? "admitted" as const : "zero-visible-affine-placements" as const,
    admissions: Object.freeze(admissions),
    skips: Object.freeze(skips),
    ...(aggregate ? { aggregate } : {}),
  });
  return Object.freeze({
    ...receipt,
    preflightIdentity: hash({
      ...receipt,
      admissions: receipt.admissions.map((entry) => Object.freeze({ ...entry, work: entry.work.workIdentity })),
      aggregate: aggregate?.workIdentity,
    }),
  });
}

export function referenceComponentFragmentLocalSpaceFramePreflight(
  ir: CutAVIR,
  composition: IRComposition,
  context: ReferenceLocalSpaceCompositionTransformPreflightContext,
  entries: readonly ReferenceComponentFragmentLocalSpaceCompositionEntry[],
  resolver?: ReferencePreparedSignalResolver,
): ReferenceComponentFragmentLocalSpaceFramePreflight {
  const mismatchedTime = entries.find((entry) => compareRational(entry.exactTime, context.exactTime) !== 0);
  if (mismatchedTime) {
    fail(mismatchedTime.owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `component frame preflight requires one exact scene time ${context.exactTime.numerator}/${context.exactTime.denominator}.`);
  }
  const plans = entries.map((entry) => Object.freeze({
    ownerNodeId: entry.owner.id,
    localSpaceNodeId: entry.localSpace.nodeId,
    plan: referenceComponentFragmentLocalSpacePlanAt(
      ir,
      composition,
      entry.owner,
      entry.localSpace,
      entry.exactTime,
      resolver,
    ),
  }));
  const requests: ReferenceLocalSpaceCompositionTransformPreflightEntry[] = plans.map((entry, index) => {
    const source = entries[index]!;
    const plan = entry.plan;
    return Object.freeze({
      owner: source.owner,
      localSpace: source.localSpace,
      ownerKind: "component-fragment" as const,
      exactTime: source.exactTime,
      status: plan.status,
      ...(plan.status === "visible" ? { transform: Object.freeze({
        source: Object.freeze({ width: source.localSpace.width, height: source.localSpace.height }),
        destination: Object.freeze({ width: composition.width, height: composition.height }),
        scale: plan.placement.scale,
        skewX: 0,
        skewY: 0,
        rotation: plan.placement.rotation,
        opacity: plan.placement.opacity,
      }) } : {}),
    });
  });
  const general = referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, requests);
  return Object.freeze({
    ...general,
    plans: Object.freeze(plans),
    preflightIdentity: hash({
      generalPreflightIdentity: general.preflightIdentity,
      plans: plans.map((entry) => Object.freeze({
        ownerNodeId: entry.ownerNodeId,
        localSpaceNodeId: entry.localSpaceNodeId,
        planIdentity: entry.plan.planIdentity,
      })),
    }),
  });
}

export function referenceComponentFragmentLocalSpaceInspect(
  ir: CutAVIR,
  composition: IRComposition,
  owner: IRNode,
  localSpace: ReferenceLocalSpaceConfig,
  admissionIndex: ReferenceComponentFragmentLocalSpaceAdmissionIndex,
) {
  const localNode = ir.nodes[localSpace.nodeId];
  if (!localNode) fail(owner, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", `references missing LocalSpace ${localSpace.nodeId}.`);
  const admission = referenceComponentFragmentLocalSpaceAdmissionIssue(admissionIndex, owner, localNode, composition);
  if (admission) fail(admission.subject === "owner" ? owner : localNode, "CUT_COMPONENT_FRAGMENT_LOCAL_GRAPH", admission.detail);
  const initialPreflight = referenceComponentFragmentLocalSpacePlanAt(ir, composition, owner, localSpace, owner.interval.start);
  const receipt = Object.freeze({
    algorithmVersion: referenceComponentFragmentLocalSpaceAlgorithmVersion,
    materialization: "bounded-local-tile-before-component-fragment-transform" as const,
    ownerNodeId: owner.id,
    localSpaceNodeId: localSpace.nodeId,
    sceneId: owner.sceneId!,
    dimensions: Object.freeze({ width: localSpace.width, height: localSpace.height }),
    registrationRasterQ16: Object.freeze({ ...localSpace.rasterOriginQ16 }),
    transformOrder: referenceComponentFragmentLocalSpaceTransformOrder,
    controls: referenceComponentFragmentLocalSpaceProperties,
    placementContextIdentity: initialPreflight.placement.contextIdentity,
    initialPreflight: Object.freeze({
      exactTime: initialPreflight.exactTime,
      status: initialPreflight.status,
      placement: initialPreflight.placement,
      ...(initialPreflight.transformWork ? { transformWork: initialPreflight.transformWork } : {}),
      planIdentity: initialPreflight.planIdentity,
    }),
    cache: Object.freeze({
      tileIdentity: "local-content-and-exact-time",
      placementIdentity: "tile-plus-sampled-fragment-placement-and-transform-work",
      unrelatedBuildIdentity: "excluded" as const,
    }),
    limits: referenceLocalSpaceTransformWorkLimits,
    localTileSemanticIdentity: localSpace.semanticIdentity,
  });
  return Object.freeze({ ...receipt, semanticIdentity: hash(receipt) });
}
