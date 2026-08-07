import sharp from "sharp";
import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { addRational, compareRational, type Rational } from "../../language/rational";
import {
  ReferenceRetainedVisualError,
  combineReferenceRetainedWork,
  composeReferenceAffine2D,
  intersectReferenceRects,
  referenceAffine2D,
  referenceIdentityAffine2D,
  referenceIntegerRasterBounds,
  referenceRect,
  referenceRetainedCacheIdentity,
  referenceRetainedRasterWork,
  type ReferenceAffine2D,
  type ReferenceIntegerRasterBounds,
  type ReferenceRect,
  type ReferenceRetainedCacheIdentity,
  type ReferenceRetainedVisualErrorCode,
  type ReferenceRetainedVisualWork,
} from "./retained-visual";
import {
  referenceAnchoredMotionPathResolutionAt,
  referenceMotionPathAt,
  type ReferenceAnchoredMotionPathResolution,
  type ReferenceAnchoredMotionPathPlan,
  type ReferenceMotionPathPlan,
} from "./motion-path";
import {
  isReferenceAnchoredPathGeometryValue,
  type ReferenceAnchoredPathOwnerResolver,
  type ReferenceAnchoredPathResolution,
} from "./anchored-path";
import type { ReferenceTrack2DTransform } from "./tracking-2d";
import { referenceVisualTransformAt, validateReferenceVisualTransformAllocation, type ReferenceVisualTransform } from "./visual-config";
import type { ReferencePreparedSignalResolver } from "./signals";
import {
  referenceAnchoredVectorPathFrameResolutionAt,
  referenceVectorPathFrameAt,
  referenceVectorPathVisibleBounds,
  type ReferenceAnchoredVectorPathPlan,
  type ReferenceVectorPathFrame,
  type ReferenceVectorPathPlan,
} from "./vector-path";

export const referenceRetainedPathChainAlgorithmVersion = "cut-reference-retained-path-chain-v2" as const;
export const referenceRetainedPathBackendIdentity = `sharp@${sharp.versions.sharp ?? "missing"};libvips@${sharp.versions.vips ?? "missing"}`;

export type ReferenceRetainedPathChainErrorCode = ReferenceRetainedVisualErrorCode | "CUT_RETAINED_PATH_CHAIN";

export class ReferenceRetainedPathChainError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceRetainedPathChainErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: retained Path chain at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceRetainedPathChainError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

export type ReferenceRetainedPathChain = Readonly<{
  rootId: string;
  pathId: string;
  nodeIds: readonly string[];
  wrapperOps: readonly string[];
  /** VectorPath coordinates become subject-local when a MotionPath owns the
   * exact unary chain; ordinary retained chains remain in canvas space. */
  coordinateBasis: "canvas" | "motion-path-local";
  requiresTrack2D: boolean;
}>;

export type ReferenceRetainedPathTransformStep = Readonly<{
  nodeId: string;
  op: string;
  affine: ReferenceAffine2D;
  opacity: number;
}>;

export type ReferenceRetainedPathChainState = Readonly<{
  active: boolean;
  hidden: boolean;
  affine: ReferenceAffine2D;
  opacity: number;
  steps: readonly ReferenceRetainedPathTransformStep[];
  anchoredMotionPathResolution?: ReferenceAnchoredMotionPathResolution;
}>;

export type ReferenceRetainedPathChainExecution = Readonly<{
  chain: ReferenceRetainedPathChain;
  state: ReferenceRetainedPathChainState;
  frame?: ReferenceVectorPathFrame;
  localBounds?: ReferenceRect;
  worldBounds?: ReferenceRect;
  visibleRasterBounds?: ReferenceIntegerRasterBounds;
  frameVisibility?: "visible" | "transparent-trim";
  /** Stable semantic identity exists even when an exact transparent-trim
   * frame bypasses the raster cache entirely. */
  semanticFrameIdentity?: string;
  geometryIdentity?: string;
  geometryPolicyHidden?: boolean;
  anchoredPathResolution?: ReferenceAnchoredPathResolution;
  cacheIdentity?: ReferenceRetainedCacheIdentity;
  work: ReferenceRetainedVisualWork;
  vectorRasterizations: 0 | 1;
  placementPasses: 0 | 1;
  deliveryClipped: boolean;
}>;

export type ReferenceRetainedTrack2DResolver = (node: IRNode, time: Rational) => ReferenceTrack2DTransform;
export type ReferenceRetainedMotionPathResolver = (node: IRNode) => ReferenceMotionPathPlan;
export type ReferenceRetainedAnchoredMotionPathResolver = (node: IRNode) => ReferenceAnchoredMotionPathPlan;

const wrapperInputs: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "cut.visual.group": new Set(["x", "y", "anchorX", "anchorY", "scale", "skewX", "skewY", "rotation", "opacity"]),
  "cut.visual.camera2d": new Set(["x", "y", "scale", "rotation", "opacity"]),
  "cut.visual.motion_path": new Set(["points", "geometry", "progress", "closed", "orientToPath", "x", "y", "anchorX", "anchorY", "scale", "skewX", "skewY", "rotation", "opacity"]),
  "cut.visual.track_2d": new Set(["source", "minConfidence", "lowConfidence", "occluded", "outOfFrame", "interpolation", "bindScale", "bindRotation", "x", "y", "scale", "rotation", "opacity"]),
});

const wrapperProperties: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "cut.visual.group": new Set(["x", "y", "anchorX", "anchorY", "scale", "skewX", "skewY", "rotation", "opacity"]),
  "cut.visual.camera2d": new Set(["x", "y", "scale", "rotation", "opacity"]),
  "cut.visual.motion_path": new Set(["progress", "x", "y", "anchorX", "anchorY", "scale", "skewX", "skewY", "rotation", "opacity"]),
  "cut.visual.track_2d": new Set(["x", "y", "scale", "rotation", "opacity"]),
});

// IR `effects` records the callable capability that produced the node. Public
// visual components compile to exactly `["pure"]`; it is not a post-effect
// chain. Anything else must stay on the conservative materializing path.
function exactPureCapability(node: IRNode) {
  return node.effects.length === 1 && node.effects[0] === "pure";
}

function pathLeaf(node: IRNode) {
  return node.op === "cut.visual.path"
    && node.domain === "visual"
    && node.inputs.geometry !== undefined
    && node.inputs.points === undefined
    && node.children.length === 0
    && exactPureCapability(node)
    && node.editorial === undefined;
}

function exactWrapper(node: IRNode) {
  const inputs = wrapperInputs[node.op], properties = wrapperProperties[node.op];
  return Boolean(inputs && properties)
    && node.domain === "visual"
    && node.children.length === 1
    && exactPureCapability(node)
    && node.editorial === undefined
    && Object.keys(node.inputs).every((name) => inputs.has(name))
    && Object.keys(node.properties).every((name) => properties.has(name));
}

/**
 * Classify only a structurally exact unary transform chain. Undefined means
 * the existing materializing renderer remains authoritative for that root.
 */
export function referenceRetainedPathChain(ir: CutAVIR, rootId: string): ReferenceRetainedPathChain | undefined {
  const nodeIds: string[] = [], wrapperOps: string[] = [], visited = new Set<string>();
  let current = ir.nodes[rootId];
  for (let depth = 0; current && depth <= 512; depth += 1) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id); nodeIds.push(current.id);
    if (pathLeaf(current)) {
      return Object.freeze({
        rootId,
        pathId: current.id,
        nodeIds: Object.freeze(nodeIds),
        wrapperOps: Object.freeze(wrapperOps),
        coordinateBasis: wrapperOps.includes("cut.visual.motion_path") ? "motion-path-local" as const : "canvas" as const,
        requiresTrack2D: wrapperOps.includes("cut.visual.track_2d"),
      });
    }
    if (!exactWrapper(current)) return undefined;
    if (current.op === "cut.visual.motion_path" && wrapperOps.includes("cut.visual.motion_path")) {
      // One retained subject has one unambiguous local origin. Nested
      // MotionPath remains executable through the ordinary materialization
      // boundary; it must never accumulate two implicit centre bases here.
      return undefined;
    }
    wrapperOps.push(current.op);
    current = ir.nodes[current.children[0]];
  }
  return undefined;
}

/** Find maximal retained chains beneath arbitrary materialization boundaries. */
export function referenceRetainedPathChainsFromRoots(ir: CutAVIR, roots: readonly string[]) {
  const result: ReferenceRetainedPathChain[] = [], visited = new Set<string>(), emitted = new Set<string>();
  const visit = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const chain = referenceRetainedPathChain(ir, nodeId);
    if (chain) {
      const key = `${chain.rootId}:${chain.pathId}`;
      if (!emitted.has(key)) { emitted.add(key); result.push(chain); }
      return;
    }
    const node = ir.nodes[nodeId];
    if (node) node.children.forEach(visit);
  };
  roots.forEach(visit);
  return Object.freeze(result);
}

function active(node: IRNode, time: Rational) {
  return compareRational(time, node.interval.start) >= 0
    && compareRational(time, addRational(node.interval.start, node.interval.duration)) < 0;
}

function rotationComponents(degrees: number) {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) return { cosine: 1, sine: 0 };
  if (normalized === 90) return { cosine: 0, sine: 1 };
  if (normalized === 180) return { cosine: -1, sine: 0 };
  if (normalized === 270) return { cosine: 0, sine: -1 };
  const signed = normalized > 180 ? normalized - 360 : normalized, radians = signed * Math.PI / 180;
  return { cosine: Math.cos(radians), sine: Math.sin(radians) };
}

/** Convert CUT's centre-relative scale -> skew -> rotation -> position stack. */
export function referenceRetainedVisualAffine(composition: IRComposition, transform: ReferenceVisualTransform): ReferenceAffine2D {
  const centerX = composition.width / 2, centerY = composition.height / 2;
  const radians = Math.PI / 180, tangentX = Math.tan(transform.skewX * radians), tangentY = Math.tan(transform.skewY * radians);
  const { cosine, sine } = rotationComponents(transform.rotation);
  const origin = referenceAffine2D({ a: 1, b: 0, c: 0, d: 1, tx: -(centerX + transform.anchorX), ty: -(centerY + transform.anchorY) });
  const scale = referenceAffine2D({ a: transform.scale, b: 0, c: 0, d: transform.scale, tx: 0, ty: 0 });
  const skew = referenceAffine2D({ a: 1, b: tangentY, c: tangentX, d: 1, tx: 0, ty: 0 });
  const rotation = referenceAffine2D({ a: cosine, b: sine, c: -sine, d: cosine, tx: 0, ty: 0 });
  const destination = referenceAffine2D({ a: 1, b: 0, c: 0, d: 1, tx: centerX + transform.x, ty: centerY + transform.y });
  return composeReferenceAffine2D(destination, composeReferenceAffine2D(rotation, composeReferenceAffine2D(skew, composeReferenceAffine2D(scale, origin))));
}

function wrapFoundation(node: IRNode, work: () => ReferenceAffine2D) {
  try { return work(); }
  catch (error) {
    if (error instanceof ReferenceRetainedVisualError) throw new ReferenceRetainedPathChainError(error.code, node, error.message);
    throw error;
  }
}

export function referenceRetainedPathChainStateAt(
  ir: CutAVIR,
  composition: IRComposition,
  chain: ReferenceRetainedPathChain,
  time: Rational,
  options: Readonly<{
    resolveTrack2D?: ReferenceRetainedTrack2DResolver;
    resolveMotionPath?: ReferenceRetainedMotionPathResolver;
    resolveAnchoredMotionPath?: ReferenceRetainedAnchoredMotionPathResolver;
    resolveAnchoredPathOwner?: ReferenceAnchoredPathOwnerResolver;
    preparedSignalResolver?: ReferencePreparedSignalResolver;
  }> = {},
): ReferenceRetainedPathChainState {
  const motionPathIds = chain.nodeIds.filter((nodeId) => ir.nodes[nodeId]?.op === "cut.visual.motion_path");
  const expectedBasis = motionPathIds.length === 1 ? "motion-path-local" : "canvas";
  if (motionPathIds.length > 1) {
    const conflicting = ir.nodes[motionPathIds[1]!] ?? ir.nodes[chain.rootId];
    if (!conflicting) throw new Error(`CUT_RETAINED_PATH_CHAIN: retained chain ${chain.rootId} has multiple missing MotionPath wrappers.`);
    throw new ReferenceRetainedPathChainError(
      "CUT_RETAINED_PATH_CHAIN",
      conflicting,
      "cannot contain multiple MotionPath wrappers because one retained subject has exactly one local origin; keep the ordinary materialization boundary between nested paths.",
    );
  }
  if (chain.coordinateBasis !== expectedBasis) {
    const root = ir.nodes[chain.rootId];
    if (!root) throw new Error(`CUT_RETAINED_PATH_CHAIN: retained chain ${chain.rootId} has no root for coordinate-basis validation.`);
    throw new ReferenceRetainedPathChainError(
      "CUT_RETAINED_PATH_CHAIN",
      root,
      `declares coordinate basis ${chain.coordinateBasis} but its exact wrappers require ${expectedBasis}.`,
    );
  }
  let affine = referenceIdentityAffine2D, opacity = 1;
  let anchoredMotionPathResolution: ReferenceAnchoredMotionPathResolution | undefined;
  const steps: ReferenceRetainedPathTransformStep[] = [];
  for (const nodeId of chain.nodeIds) {
    const node = ir.nodes[nodeId];
    if (!node || !active(node, time)) return Object.freeze({
      active: false,
      hidden: false,
      affine,
      opacity: 0,
      steps: Object.freeze(steps),
      ...(anchoredMotionPathResolution ? { anchoredMotionPathResolution } : {}),
    });
    const transform = referenceVisualTransformAt(ir, composition, node, time, { staticPosition: true, staticRotation: true }, options.preparedSignalResolver);
    if (node.op === "cut.visual.motion_path") {
      let path;
      if (isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) {
        if (!options.resolveAnchoredMotionPath || !options.resolveAnchoredPathOwner) {
          throw new ReferenceRetainedPathChainError(
            "CUT_RETAINED_PATH_CHAIN",
            node,
            "AnchoredPathGeometry MotionPath requires validated anchored-plan and exact owner-placement resolvers.",
          );
        }
        const resolution = referenceAnchoredMotionPathResolutionAt(
          ir,
          composition,
          node,
          time,
          options.resolveAnchoredMotionPath(node),
          options.resolveAnchoredPathOwner,
        );
        anchoredMotionPathResolution = resolution;
        if (resolution.status === "policy-hidden") {
          return Object.freeze({
            active: true,
            hidden: true,
            affine,
            opacity: 0,
            steps: Object.freeze(steps),
            anchoredMotionPathResolution,
          });
        }
        path = resolution.sample;
      } else {
        path = referenceMotionPathAt(ir, composition, node, time, options.resolveMotionPath?.(node));
      }
      transform.x += path.x; transform.y += path.y; transform.rotation += path.rotation;
      validateReferenceVisualTransformAllocation(node, composition, transform);
    }
    if (node.op === "cut.visual.track_2d") {
      if (!options.resolveTrack2D) throw new ReferenceRetainedPathChainError("CUT_RETAINED_PATH_CHAIN", node, "Track2D needs its prepared locked-data resolver before a composed matrix exists.");
      const tracked = options.resolveTrack2D(node, time);
      if (tracked.hidden) return Object.freeze({
        active: true,
        hidden: true,
        affine,
        opacity: 0,
        steps: Object.freeze(steps),
        ...(anchoredMotionPathResolution ? { anchoredMotionPathResolution } : {}),
      });
      transform.x += tracked.x; transform.y += tracked.y; transform.scale *= tracked.scale; transform.rotation += tracked.rotation;
      validateReferenceVisualTransformAllocation(node, composition, transform);
    }
    const local = wrapFoundation(node, () => referenceRetainedVisualAffine(composition, transform));
    affine = wrapFoundation(node, () => composeReferenceAffine2D(affine, local));
    if (node.op === "cut.visual.motion_path") {
      // MotionPath subjects use a real local origin. The generic raster path
      // carries a canvas-centred child, while the retained VectorPath path has
      // no intermediate canvas; insert that basis exactly here so local (0,0)
      // lands on the sampled point without an authored half-canvas shim.
      const localOrigin = referenceAffine2D({
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        tx: composition.width / 2,
        ty: composition.height / 2,
      });
      affine = wrapFoundation(node, () => composeReferenceAffine2D(affine, localOrigin));
    }
    opacity *= transform.opacity;
    steps.push(Object.freeze({ nodeId, op: node.op, affine: local, opacity: transform.opacity }));
  }
  return Object.freeze({
    active: true,
    hidden: false,
    affine,
    opacity,
    steps: Object.freeze(steps),
    ...(anchoredMotionPathResolution ? { anchoredMotionPathResolution } : {}),
  });
}

function sameRect(left: ReferenceRect, right: ReferenceRect) {
  return left.minX === right.minX && left.minY === right.minY && left.maxX === right.maxX && left.maxY === right.maxY;
}

export function referenceRetainedPathChainExecutionAt(
  ir: CutAVIR,
  composition: IRComposition,
  chain: ReferenceRetainedPathChain,
  plan: ReferenceVectorPathPlan | ReferenceAnchoredVectorPathPlan,
  time: Rational,
  options: Readonly<{
    resolveTrack2D?: ReferenceRetainedTrack2DResolver;
    resolveMotionPath?: ReferenceRetainedMotionPathResolver;
    resolveAnchoredMotionPath?: ReferenceRetainedAnchoredMotionPathResolver;
    resolveAnchoredPathOwner?: ReferenceAnchoredPathOwnerResolver;
    preparedSignalResolver?: ReferencePreparedSignalResolver;
    outputFrame?: bigint;
  }> = {},
): ReferenceRetainedPathChainExecution {
  const root = ir.nodes[chain.rootId], path = ir.nodes[chain.pathId];
  const diagnosticNode = root ?? path;
  if (!diagnosticNode) throw new Error(`CUT_RETAINED_PATH_CHAIN: retained Path chain ${chain.rootId} references missing root and Path nodes.`);
  if (!root || !path) throw new ReferenceRetainedPathChainError("CUT_RETAINED_PATH_CHAIN", diagnosticNode, "references a missing root or Path node.");
  try {
    const state = referenceRetainedPathChainStateAt(ir, composition, chain, time, options);
    const zeroWork = Object.freeze({ rasterPixels: 0, rgbaBytes: 0, pixelWork: 0 });
    if (!state.active || state.hidden || state.opacity === 0) {
      return Object.freeze({ chain, state, work: zeroWork, vectorRasterizations: 0, placementPasses: 0, deliveryClipped: false });
    }
    let frame: ReferenceVectorPathFrame;
    let geometryIdentity: string | undefined;
    let geometryExecutionIdentity: string | undefined;
    let anchoredPathResolution: ReferenceAnchoredPathResolution | undefined;
    if (plan.geometryKind === "anchored-v1") {
      if (!options.resolveAnchoredPathOwner) {
        throw new ReferenceRetainedPathChainError(
          "CUT_RETAINED_PATH_CHAIN",
          path,
          "AnchoredPathGeometry requires an exact validated owner-placement resolver.",
        );
      }
      const resolution = referenceAnchoredVectorPathFrameResolutionAt(
        ir,
        path,
        plan,
        time,
        options.resolveAnchoredPathOwner,
        options.outputFrame,
      );
      anchoredPathResolution = resolution.anchored;
      if (resolution.status === "policy-hidden") {
        return Object.freeze({
          chain,
          state,
          geometryPolicyHidden: true,
          anchoredPathResolution,
          semanticFrameIdentity: resolution.executionIdentity,
          work: zeroWork,
          vectorRasterizations: 0,
          placementPasses: 0,
          deliveryClipped: false,
        });
      }
      frame = resolution.frame;
      geometryIdentity = resolution.geometryIdentity;
      geometryExecutionIdentity = resolution.executionIdentity;
    } else {
      frame = referenceVectorPathFrameAt(ir, path, plan, time, options.outputFrame);
    }
    const dependencies = chain.nodeIds.map((nodeId) => {
      const node = ir.nodes[nodeId]!;
      return `node:${nodeId}:${node.contentHash ?? hash({ op: node.op, inputs: node.inputs, properties: node.properties, children: node.children })}`;
    });
    dependencies.push(`canvas:${composition.width}x${composition.height}`);
    if (geometryIdentity) dependencies.push(`anchored-geometry:${geometryIdentity}`);
    const legacySemanticFrame = {
      schema: "cut.reference.retained-path-frame.v1",
      algorithmVersion: referenceRetainedPathChainAlgorithmVersion,
      time: `${time.numerator}/${time.denominator}`,
      affine: state.affine,
      opacity: state.opacity,
      visibility: frame.visibility,
      dependencies,
    };
    const semanticFrameIdentity = hash(geometryIdentity
      ? { ...legacySemanticFrame, anchoredGeometry: { geometryIdentity, executionIdentity: geometryExecutionIdentity } }
      : legacySemanticFrame);
    const localBounds = referenceVectorPathVisibleBounds(frame, referenceIdentityAffine2D);
    if (!localBounds) {
      if (frame.visibility !== "transparent-trim") {
        throw new ReferenceRetainedPathChainError("CUT_RETAINED_PATH_CHAIN", path, "a visible Path frame produced no local paint bounds.");
      }
      return Object.freeze({
        chain, state, frame, frameVisibility: frame.visibility, semanticFrameIdentity,
        ...(geometryIdentity ? { geometryIdentity } : {}),
        ...(anchoredPathResolution ? { anchoredPathResolution } : {}),
        work: zeroWork, vectorRasterizations: 0, placementPasses: 0, deliveryClipped: false,
      });
    }
    const worldBounds = referenceVectorPathVisibleBounds(frame, state.affine);
    if (!worldBounds) {
      throw new ReferenceRetainedPathChainError("CUT_RETAINED_PATH_CHAIN", path, "a locally visible Path frame produced no transformed paint bounds.");
    }
    const deliveryBounds = referenceRect(0, 0, composition.width, composition.height);
    const visible = intersectReferenceRects(worldBounds, deliveryBounds);
    if (!visible) {
      return Object.freeze({
        chain, state, frame, localBounds, worldBounds, frameVisibility: frame.visibility, semanticFrameIdentity,
        ...(geometryIdentity ? { geometryIdentity } : {}),
        ...(anchoredPathResolution ? { anchoredPathResolution } : {}),
        work: zeroWork, vectorRasterizations: 0, placementPasses: 0, deliveryClipped: true,
      });
    }
    const visibleRasterBounds = referenceIntegerRasterBounds(visible);
    const deliveryRasterBounds = referenceIntegerRasterBounds(deliveryBounds);
    const work = combineReferenceRetainedWork([
      referenceRetainedRasterWork(visibleRasterBounds, 1),
      referenceRetainedRasterWork(deliveryRasterBounds, 1),
    ]);
    dependencies.push(`bounds:${worldBounds.minX},${worldBounds.minY},${worldBounds.maxX},${worldBounds.maxY}`);
    const cacheIdentity = referenceRetainedCacheIdentity({
      algorithmVersion: referenceRetainedPathChainAlgorithmVersion,
      backendIdentity: referenceRetainedPathBackendIdentity,
      semanticIdentity: hash(dependencies),
      timeIdentity: `${time.numerator}/${time.denominator}`,
      affine: state.affine,
      rasterBounds: visibleRasterBounds,
      dependencies,
    });
    return Object.freeze({
      chain, state, frame, localBounds, worldBounds, visibleRasterBounds,
      ...(geometryIdentity ? { geometryIdentity } : {}),
      ...(anchoredPathResolution ? { anchoredPathResolution } : {}),
      frameVisibility: frame.visibility, semanticFrameIdentity, cacheIdentity, work,
      vectorRasterizations: 1, placementPasses: 1, deliveryClipped: !sameRect(visible, worldBounds),
    });
  } catch (error) {
    if (error instanceof ReferenceRetainedVisualError) throw new ReferenceRetainedPathChainError(error.code, path, error.message);
    throw error;
  }
}

export function referenceRetainedPathChainInspection(execution: ReferenceRetainedPathChainExecution, time: Rational) {
  const matrix = execution.state.affine;
  return Object.freeze({
    status: execution.chain.requiresTrack2D ? "runtime-resolved" as const : "flattenable" as const,
    algorithmVersion: referenceRetainedPathChainAlgorithmVersion,
    backendIdentity: referenceRetainedPathBackendIdentity,
    exactTime: { ...time },
    rootId: execution.chain.rootId,
    pathId: execution.chain.pathId,
    nodeIds: [...execution.chain.nodeIds],
    wrapperOps: [...execution.chain.wrapperOps],
    coordinateBasis: execution.chain.coordinateBasis,
    composedMatrix: { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, tx: matrix.tx, ty: matrix.ty },
    combinedOpacity: execution.state.opacity,
    ...(execution.geometryIdentity ? { geometryIdentity: execution.geometryIdentity } : {}),
    ...(execution.geometryPolicyHidden ? { geometryPolicyHidden: true as const } : {}),
    ...(execution.frameVisibility ? { frameVisibility: execution.frameVisibility } : {}),
    ...(execution.semanticFrameIdentity ? { semanticFrameIdentity: execution.semanticFrameIdentity } : {}),
    ...(execution.frameVisibility ? {
      cacheDisposition: execution.frameVisibility === "transparent-trim" ? "transparent-bypass" as const : "raster-cache" as const,
    } : {}),
    ...(execution.localBounds ? { localBounds: { ...execution.localBounds } } : {}),
    ...(execution.worldBounds ? { worldBounds: { ...execution.worldBounds } } : {}),
    ...(execution.visibleRasterBounds ? { visibleRasterBounds: { ...execution.visibleRasterBounds } } : {}),
    rasterization: {
      vectorRasterizations: execution.vectorRasterizations,
      placementPasses: execution.placementPasses,
      deliveryClipped: execution.deliveryClipped,
      arcLengthSpace: "path-local-before-affine" as const,
    },
    work: { ...execution.work },
    ...(execution.cacheIdentity ? { cacheIdentity: {
      schema: "cut.reference.retained-visual.v1" as const,
      sha256: execution.cacheIdentity.sha256,
      includes: ["algorithm", "backend", "semantic-chain", "exact-time", "composed-matrix", "visible-raster-bounds", "canvas", "world-bounds"],
    } } : {}),
    boundariesStillMaterialized: ["multi-child", "effects", "mask", "clip-path", "stack", "non-normal-blend", "precomposition"],
  });
}

export function referenceRetainedPathChainInspectionTime(ir: CutAVIR, chain: ReferenceRetainedPathChain) {
  let start = ir.nodes[chain.nodeIds[0]]!.interval.start;
  for (const nodeId of chain.nodeIds.slice(1)) {
    const candidate = ir.nodes[nodeId]!.interval.start;
    if (compareRational(candidate, start) > 0) start = candidate;
  }
  return start;
}
