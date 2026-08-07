import { hash } from "../../core/stable";
import type { CutAVIR, IRNode } from "../../language/ir";
import { rgbaBlendModes, type RgbaBlendMode } from "./compositing";
import { referenceClipPathConfig, referenceClipPathWorkUnits, validateReferenceClipPathCanvas } from "./clip-path";
import { validateReferenceColorGradeConfig } from "./color-grade-config";
import { referenceMaskConfig } from "./mask-config";
import { referenceVisualEffectConfig, type ReferenceVisualEffectConfig } from "./visual-effects";

export const referenceLocalCompositingAlgorithmVersion = "cut-reference-local-compositing-v1" as const;

export const referenceLocalCompositingLimits = Object.freeze({
  maximumOperationsPerLocalSpace: 512,
  maximumOperationsPerExecutionDomain: 4_096,
  maximumOperatorPixelWorkPerLocalSpace: 536_870_912,
  maximumOperatorPixelWorkPerExecutionDomain: 1_073_741_824,
});

export const referenceLocalCompositingAdmittedOps = Object.freeze([
  "cut.visual.composite",
  "cut.visual.mask",
  "cut.visual.clip_path",
  "cut.visual.blur",
  "cut.visual.vignette",
  "cut.visual.sharpen",
  "cut.visual.grain",
  "cut.visual.duotone",
  "cut.visual.color_grade",
] as const);

export const referenceLocalCompositingRefusedHaloOps = Object.freeze([
  "cut.visual.shadow",
  "cut.visual.glow",
] as const);

type ReferenceLocalCompositingOp = typeof referenceLocalCompositingAdmittedOps[number];

export type ReferenceLocalCompositingErrorCode =
  | "CUT_LOCAL_COMPOSITING_GRAPH"
  | "CUT_LOCAL_COMPOSITING_UNSUPPORTED"
  | "CUT_LOCAL_COMPOSITING_LIMIT";

export class ReferenceLocalCompositingError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceLocalCompositingErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${node.op} at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceLocalCompositingError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceLocalCompositingOperation = Readonly<{
  sourceOrder: number;
  traversalPath: readonly number[];
  nodeId: string;
  op: ReferenceLocalCompositingOp;
  childIds: readonly string[];
  config: Readonly<Record<string, unknown>>;
  signalIdentities: readonly Readonly<{ property: string; signalId: string; contentHash: string }>[];
  /** Recomputed from the complete graphical subtree rather than trusting
   * wrapper topology or a possibly stale externally supplied contentHash. */
  subtreeSemanticIdentity: string;
  estimatedPixelWorkPerFrame: number;
  semanticIdentity: string;
}>;

export type ReferenceLocalCompositingPlan = Readonly<{
  algorithmVersion: typeof referenceLocalCompositingAlgorithmVersion;
  localSpaceNodeId: string;
  dimensions: Readonly<{ width: number; height: number }>;
  alphaBoundary: "straight-rgba8";
  sourceOrder: "authored-depth-first";
  operations: readonly ReferenceLocalCompositingOperation[];
  estimatedPixelWorkPerFrame: number;
  semanticIdentity: string;
}>;

const admitted = new Set<string>(referenceLocalCompositingAdmittedOps);
const refusedHalo = new Set<string>(referenceLocalCompositingRefusedHaloOps);

function fail(node: IRNode, code: ReferenceLocalCompositingErrorCode, detail: string): never {
  throw new ReferenceLocalCompositingError(code, node, detail);
}

/** Closed public Composite configuration shared by local admission and execution. */
export function referenceCompositeBlendMode(node: IRNode): RgbaBlendMode {
  if (node.op !== "cut.visual.composite") fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", "is not a Composite node.");
  if (node.domain !== "visual" || node.children.length < 1) {
    fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", `requires at least one visual child; found ${node.children.length}.`);
  }
  const value = node.inputs.blend;
  if (value === undefined) return "normal";
  if (value.kind !== "string" || !rgbaBlendModes.includes(value.value as RgbaBlendMode)) {
    fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", `input “blend” must be one of: ${rgbaBlendModes.join(", ")}.`);
  }
  return value.value as RgbaBlendMode;
}

function signalIdentities(ir: CutAVIR, node: IRNode) {
  return Object.freeze(Object.entries(node.properties).flatMap(([property, value]) => {
    if (!("signal" in value)) return [];
    const signal = ir.signals[value.signal];
    if (!signal) fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", `property “${property}” references missing signal ${value.signal}.`);
    return [Object.freeze({ property, signalId: signal.id, contentHash: signal.contentHash })];
  }).sort((left, right) => left.property.localeCompare(right.property) || left.signalId.localeCompare(right.signalId)));
}

function effectWork(pixels: number, config: ReferenceVisualEffectConfig) {
  switch (config.kind) {
    case "blur": return pixels * (2 + Math.max(1, Math.ceil(config.radius) * 4));
    case "sharpen": return pixels * (3 + Math.max(1, Math.ceil(config.radius) * 4));
    case "vignette":
    case "grain":
    case "duotone": return pixels * 2;
    case "shadow":
    case "glow": return 0;
  }
}

function operationConfigAndWork(ir: CutAVIR, node: IRNode, width: number, height: number) {
  const pixels = width * height;
  if (node.op === "cut.visual.composite") {
    const blend = referenceCompositeBlendMode(node);
    return Object.freeze({ config: Object.freeze({ blend }), work: pixels * Math.max(1, node.children.length) });
  }
  if (node.op === "cut.visual.mask") {
    const config = referenceMaskConfig(ir, node);
    if (!config) fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", "did not produce a public Mask configuration.");
    const radiusPasses = 2 * (Math.abs(config.expandPx) + config.featherPx);
    return Object.freeze({ config: Object.freeze({ ...config }), work: pixels * (3 + radiusPasses) });
  }
  if (node.op === "cut.visual.clip_path") {
    const config = referenceClipPathConfig(ir, node);
    if (!config) fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", "did not produce a public ClipPath configuration.");
    validateReferenceClipPathCanvas(node, config, width, height);
    return Object.freeze({
      config: Object.freeze({ fillRule: config.fillRule, invert: config.invert, pointCount: config.points.length }),
      work: referenceClipPathWorkUnits(width, height, config.points.length) + pixels,
    });
  }
  if (node.op === "cut.visual.color_grade") {
    validateReferenceColorGradeConfig(ir, node);
    return Object.freeze({
      config: Object.freeze({ parameters: Object.freeze(["exposure", "temperature", "tint", "brightness", "saturation", "hue", "contrast"]) }),
      work: pixels * 3,
    });
  }
  const effect = referenceVisualEffectConfig(node);
  if (!effect) fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", "did not produce a public visual-effect configuration.");
  if (effect.kind === "shadow" || effect.kind === "glow") {
    fail(node, "CUT_LOCAL_COMPOSITING_UNSUPPORTED", "is refused inside LocalSpace V1 because its halo can extend outside declared tile bounds; no clipping policy is yet public.");
  }
  return Object.freeze({ config: Object.freeze({ ...effect }), work: effectWork(pixels, effect) });
}

/**
 * Build one deterministic operation plan over the exact LocalSpace tile. The
 * traversal stops at nested LocalSpace and retained-media materialization
 * boundaries. It never asks the delivery renderer to materialize descendants.
 */
export function planReferenceLocalCompositing(
  ir: CutAVIR,
  localSpace: IRNode,
  dimensions: Readonly<{ width: number; height: number }>,
  retainedMediaNodeIds: ReadonlySet<string>,
): ReferenceLocalCompositingPlan {
  const operations: ReferenceLocalCompositingOperation[] = [];
  const visiting = new Set<string>();
  const subtreeMemo = new Map<string, string>();
  const subtreeIdentity = (nodeId: string, stack = new Set<string>()): string => {
    const memoized = subtreeMemo.get(nodeId);
    if (memoized) return memoized;
    const node = ir.nodes[nodeId];
    if (!node) fail(localSpace, "CUT_LOCAL_COMPOSITING_GRAPH", `references missing descendant ${nodeId}.`);
    if (stack.has(node.id)) fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", "descendant graph cycles while deriving semantic identity.");
    if (node.op === "cut.visual.local_space" || retainedMediaNodeIds.has(node.id)) {
      const boundary = hash({ kind: "materialization-boundary", nodeId: node.id, contentHash: node.contentHash });
      subtreeMemo.set(node.id, boundary);
      return boundary;
    }
    stack.add(node.id);
    const identity = hash({
      op: node.op,
      domain: node.domain,
      inputs: node.inputs,
      properties: node.properties,
      effects: node.effects,
      interval: node.interval,
      ownership: node.ownership,
      signals: signalIdentities(ir, node),
      children: node.children.map((childId) => Object.freeze({ childId, identity: subtreeIdentity(childId, stack) })),
    });
    stack.delete(node.id);
    subtreeMemo.set(node.id, identity);
    return identity;
  };
  let sourceOrder = 0, totalWork = 0;
  const visit = (nodeId: string, path: readonly number[]) => {
    const node = ir.nodes[nodeId];
    if (!node) fail(localSpace, "CUT_LOCAL_COMPOSITING_GRAPH", `references missing descendant ${nodeId}.`);
    if (visiting.has(node.id)) fail(node, "CUT_LOCAL_COMPOSITING_GRAPH", "descendant graph cycles.");
    if (node.op === "cut.visual.local_space" || retainedMediaNodeIds.has(node.id)) return;
    if (node.op === "cut.visual.image" || node.op === "cut.visual.video") {
      fail(node, "CUT_LOCAL_COMPOSITING_UNSUPPORTED", "media beneath a local compositing wrapper is refused before decode; use the existing direct retained-media viewport grammar.");
    }
    if (refusedHalo.has(node.op)) {
      fail(node, "CUT_LOCAL_COMPOSITING_UNSUPPORTED", "is refused inside LocalSpace V1 because its halo can extend outside declared tile bounds; no clipping policy is yet public.");
    }
    if (admitted.has(node.op)) {
      const { config, work } = operationConfigAndWork(ir, node, dimensions.width, dimensions.height);
      const signals = signalIdentities(ir, node);
      const subtreeSemanticIdentity = subtreeIdentity(node.id);
      const semanticIdentity = hash({
        algorithm: referenceLocalCompositingAlgorithmVersion,
        node: {
          op: node.op,
          inputs: node.inputs,
          properties: node.properties,
          children: node.children,
          interval: node.interval,
        },
        signals,
        subtreeSemanticIdentity,
        dimensions,
        config,
      });
      totalWork += work;
      if (!Number.isSafeInteger(totalWork) || totalWork > referenceLocalCompositingLimits.maximumOperatorPixelWorkPerLocalSpace) {
        fail(node, "CUT_LOCAL_COMPOSITING_LIMIT", `operator work ${Number.isSafeInteger(totalWork) ? totalWork : "non-safe"} exceeds ${referenceLocalCompositingLimits.maximumOperatorPixelWorkPerLocalSpace} per LocalSpace frame.`);
      }
      operations.push(Object.freeze({
        sourceOrder: sourceOrder++,
        traversalPath: Object.freeze([...path]),
        nodeId: node.id,
        op: node.op as ReferenceLocalCompositingOp,
        childIds: Object.freeze([...node.children]),
        config,
        signalIdentities: signals,
        subtreeSemanticIdentity,
        estimatedPixelWorkPerFrame: work,
        semanticIdentity,
      }));
      if (operations.length > referenceLocalCompositingLimits.maximumOperationsPerLocalSpace) {
        fail(node, "CUT_LOCAL_COMPOSITING_LIMIT", `operation count ${operations.length} exceeds ${referenceLocalCompositingLimits.maximumOperationsPerLocalSpace} per LocalSpace.`);
      }
    }
    visiting.add(node.id);
    node.children.forEach((childId, index) => visit(childId, Object.freeze([...path, index])));
    visiting.delete(node.id);
  };
  localSpace.children.forEach((childId, index) => visit(childId, Object.freeze([index])));
  const frozen = Object.freeze([...operations]);
  const plan = Object.freeze({
    algorithmVersion: referenceLocalCompositingAlgorithmVersion,
    localSpaceNodeId: localSpace.id,
    dimensions: Object.freeze({ ...dimensions }),
    alphaBoundary: "straight-rgba8" as const,
    sourceOrder: "authored-depth-first" as const,
    operations: frozen,
    estimatedPixelWorkPerFrame: totalWork,
  });
  return Object.freeze({ ...plan, semanticIdentity: hash(plan) });
}

export function referenceLocalCompositingInspect(plan: ReferenceLocalCompositingPlan) {
  return Object.freeze({
    algorithmVersion: plan.algorithmVersion,
    dimensions: plan.dimensions,
    alphaBoundary: plan.alphaBoundary,
    sourceOrder: plan.sourceOrder,
    operationCount: plan.operations.length,
    estimatedPixelWorkPerFrame: plan.estimatedPixelWorkPerFrame,
    operations: plan.operations.map((operation) => Object.freeze({ ...operation })),
    semanticIdentity: plan.semanticIdentity,
    refusedWithinLocalSpace: Object.freeze({
      halo: [...referenceLocalCompositingRefusedHaloOps],
      reason: "halo-bounds-policy-not-public",
    }),
  });
}
