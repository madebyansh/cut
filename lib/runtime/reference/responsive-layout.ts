import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  CutResponsiveStackError,
  cutResponsiveStackLimits,
  decodeCutResponsiveSlotMediaContext,
  decodeCutResponsiveStackPlan,
  type CutResponsiveSlotMediaContext,
  type CutResponsiveStackSlot,
} from "../../language/responsive-layout";
import { compareRational, rational, type Rational, zeroRational } from "../../language/rational";
import type { ReferenceMediaCamera2DExecutionEvidence } from "./media-camera2d";
import {
  referenceIdentityComponentFragmentChildBinding,
  referenceIdentityComponentFragmentForChild,
  validateReferenceIdentityComponentFragments,
  type ReferenceIdentityComponentFragmentChildBinding,
  type ReferenceIdentityComponentFragmentConfig,
} from "./identity-component-fragment";

export const referenceResponsiveStackExecutionVersion = "cut-reference-responsive-stack-v1" as const;
export const referenceResponsiveStackRasterPolicy = "exact-edge-round-half-up-v1" as const;
export const referenceResponsiveStackMediaPlacementAlgorithm =
  "cut-reference-responsive-slot-integer-translate-clip-v1" as const;

export type ReferenceResponsiveStackRasterSlot = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}>;

export type ReferenceResponsiveStackChild = Readonly<{
  /** Input-derived child content/package/resource identity, never output bytes. */
  semanticIdentity: string;
  /** Exact intrinsic minimums after any child-specific responsive reflow. */
  minimumWidth: Rational;
  minimumHeight: Rational;
}>;

export type ReferenceResponsiveStackAssignment = Readonly<{
  index: number;
  semanticIdentity: string;
  slot: CutResponsiveStackSlot;
  rasterSlot: ReferenceResponsiveStackRasterSlot;
  localLayoutContext: Readonly<{
    originX: Rational;
    originY: Rational;
    width: Rational;
    height: Rational;
  }>;
}>;

export type ReferenceResponsiveStackExecution = Readonly<{
  algorithm: typeof referenceResponsiveStackExecutionVersion;
  planIdentity: string;
  axis: "horizontal" | "vertical";
  rasterPolicy: typeof referenceResponsiveStackRasterPolicy;
  assignments: readonly ReferenceResponsiveStackAssignment[];
  semanticIdentity: string;
}>;

const digestPattern = /^[a-f0-9]{64}$/u;

function canonicalConstraint(value: Rational, path: string) {
  const digitCount = (part: string) => part.startsWith("-") ? part.length - 1 : part.length;
  if (digitCount(value.numerator) > cutResponsiveStackLimits.maximumRationalDigits
    || value.denominator.length > cutResponsiveStackLimits.maximumRationalDigits) {
    throw new CutResponsiveStackError(
      "CUT_RESPONSIVE_STACK_LIMIT",
      path,
      `exact rational exceeds the ${cutResponsiveStackLimits.maximumRationalDigits}-digit budget`,
    );
  }
  let canonical: Rational;
  try { canonical = rational(value.numerator, value.denominator); }
  catch { throw new CutResponsiveStackError("CUT_RESPONSIVE_STACK_SHAPE", path, "must be a valid exact rational length"); }
  if (canonical.numerator !== value.numerator || canonical.denominator !== value.denominator) {
    throw new CutResponsiveStackError("CUT_RESPONSIVE_STACK_SHAPE", path, "must be reduced canonical exact rational length");
  }
  if (canonical.numerator.startsWith("-")
    || BigInt(canonical.numerator) > BigInt(cutResponsiveStackLimits.maximumCompositionAxisPx) * BigInt(canonical.denominator)) {
    throw new CutResponsiveStackError(
      "CUT_RESPONSIVE_STACK_BOUNDS",
      path,
      `must be from 0px through ${cutResponsiveStackLimits.maximumCompositionAxisPx}px`,
    );
  }
  return canonical;
}

/** One nonnegative exact edge to the nearest whole delivery-pixel boundary.
 * Ties move toward the positive edge. All neighboring slots reuse the same
 * edge function, so rounding cannot reorder their exact monotone boundaries. */
export function referenceResponsiveStackRasterBoundary(value: Rational, path = "$") {
  const canonical = canonicalConstraint(value, path);
  const numerator = BigInt(canonical.numerator), denominator = BigInt(canonical.denominator);
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  const result = Number(rounded);
  if (!Number.isSafeInteger(result) || result < 0 || result > cutResponsiveStackLimits.maximumCompositionAxisPx) {
    throw new CutResponsiveStackError("CUT_RESPONSIVE_STACK_BOUNDS", path, "quantized edge escapes the bounded composition raster");
  }
  return result;
}

export function referenceResponsiveStackRasterSlots(planValue: IRValue, path = "$") {
  const plan = decodeCutResponsiveStackPlan(planValue, path);
  const raster = Object.freeze(plan.slots.map((slot, index): ReferenceResponsiveStackRasterSlot => {
    const slotPath = `${path}.slots[${index}]`;
    const left = referenceResponsiveStackRasterBoundary(slot.left, `${slotPath}.left`);
    const top = referenceResponsiveStackRasterBoundary(slot.top, `${slotPath}.top`);
    const right = referenceResponsiveStackRasterBoundary(slot.right, `${slotPath}.right`);
    const bottom = referenceResponsiveStackRasterBoundary(slot.bottom, `${slotPath}.bottom`);
    const width = right - left, height = bottom - top;
    if (width < 1 || height < 1) {
      throw new CutResponsiveStackError(
        "CUT_RESPONSIVE_STACK_BOUNDS",
        slotPath,
        "exact positive slot collapses below one whole pixel at the documented raster boundary; change weights, safe area, gap, or output size",
      );
    }
    return Object.freeze({ left, top, right, bottom, width, height });
  }));
  for (let index = 1; index < raster.length; index += 1) {
    const previous = raster[index - 1], current = raster[index];
    const rasterGap = plan.axis === "horizontal" ? current.left - previous.right : current.top - previous.bottom;
    if (rasterGap < 0) {
      throw new CutResponsiveStackError("CUT_RESPONSIVE_STACK_BOUNDS", `${path}.slots[${index}]`, "quantized slot boundaries overlap");
    }
    if (compareRational(plan.gap, zeroRational) > 0 && rasterGap === 0) {
      throw new CutResponsiveStackError(
        "CUT_RESPONSIVE_STACK_NOOP",
        `${path}.gap`,
        "positive exact gap quantizes to 0px for this active composition; increase the gap or output size",
      );
    }
  }
  return raster;
}

/**
 * Bind an exact plan to child semantic identities and responsive intrinsic
 * minimums. Rendering can give each child the returned local layout context;
 * FlowText therefore wraps against its slot before the slot is composited.
 */
export function referenceResponsiveStackExecution(
  planValue: IRValue,
  children: readonly ReferenceResponsiveStackChild[],
  path = "$",
): ReferenceResponsiveStackExecution {
  const plan = decodeCutResponsiveStackPlan(planValue, `${path}.plan`);
  const rasterSlots = referenceResponsiveStackRasterSlots(planValue, `${path}.plan`);
  if (children.length !== plan.slots.length) {
    throw new CutResponsiveStackError(
      "CUT_RESPONSIVE_STACK_GRAPH",
      `${path}.children`,
      `must contain exactly ${plan.slots.length} direct children because the plan retains ${plan.weights.length} weights`,
    );
  }
  const assignments = Object.freeze(children.map((child, index): ReferenceResponsiveStackAssignment => {
    const childPath = `${path}.children[${index}]`;
    if (!digestPattern.test(child.semanticIdentity)) {
      throw new CutResponsiveStackError(
        "CUT_RESPONSIVE_STACK_SHAPE",
        `${childPath}.semanticIdentity`,
        "must be a lowercase SHA-256 digest derived from child inputs, packages, resources, and toolchain",
      );
    }
    const minimumWidth = canonicalConstraint(child.minimumWidth, `${childPath}.minimumWidth`);
    const minimumHeight = canonicalConstraint(child.minimumHeight, `${childPath}.minimumHeight`);
    const slot = plan.slots[index];
    const rasterSlot = rasterSlots[index];
    if (compareRational(minimumWidth, rational(rasterSlot.width)) > 0) {
      throw new CutResponsiveStackError(
        "CUT_RESPONSIVE_STACK_OVERFLOW",
        `${childPath}.minimumWidth`,
        `exceeds ${rasterSlot.width}px slot-local raster width; reflow, reduce the intrinsic minimum, or change weights/gap/safe area`,
      );
    }
    if (compareRational(minimumHeight, rational(rasterSlot.height)) > 0) {
      throw new CutResponsiveStackError(
        "CUT_RESPONSIVE_STACK_OVERFLOW",
        `${childPath}.minimumHeight`,
        `exceeds ${rasterSlot.height}px slot-local raster height; reflow, reduce the intrinsic minimum, or change weights/gap/safe area`,
      );
    }
    return Object.freeze({
      index,
      semanticIdentity: child.semanticIdentity,
      slot,
      rasterSlot,
      localLayoutContext: Object.freeze({
        originX: zeroRational,
        originY: zeroRational,
        width: rational(rasterSlot.width),
        height: rational(rasterSlot.height),
      }),
    });
  }));
  // The identity is deliberately input-derived. Minimums are validation-only;
  // successful pixels depend on the plan and the child semantic graphs.
  const semanticIdentity = hash({
    algorithm: referenceResponsiveStackExecutionVersion,
    planIdentity: plan.id,
    rasterPolicy: referenceResponsiveStackRasterPolicy,
    rasterSlots,
    children: assignments.map((assignment) => assignment.semanticIdentity),
  });
  return Object.freeze({
    algorithm: referenceResponsiveStackExecutionVersion,
    planIdentity: plan.id,
    axis: plan.axis,
    rasterPolicy: referenceResponsiveStackRasterPolicy,
    assignments,
    semanticIdentity,
  });
}

export const referenceResponsiveStackTransparentMinimum = Object.freeze({
  minimumWidth: zeroRational,
  minimumHeight: zeroRational,
});

export class ReferenceResponsiveStackError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: CutResponsiveStackError["code"], readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: ResponsiveStack at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceResponsiveStackError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceResponsiveStackLocalContext = Readonly<{
  contextKind: "responsive-slot";
  nodeId: string;
  stackNodeId: string;
  childId: string;
  index: number;
  width: number;
  height: number;
  origin: Readonly<{ x: Rational; y: Rational }>;
  rasterOriginQ16: Readonly<{ x: string; y: string }>;
  view: Readonly<{ minX: Rational; minY: Rational; maxX: Rational; maxY: Rational }>;
  childIds: readonly [string];
  exactSlot: CutResponsiveStackSlot;
  rasterSlot: ReferenceResponsiveStackRasterSlot;
  semanticIdentity: string;
}>;

export type ReferenceResponsiveStackSlotConfig = Readonly<{
  slotNodeId: string;
  childId: string;
  descendantIds: readonly string[];
  context: ReferenceResponsiveStackLocalContext;
  mediaCamera2D?: Readonly<{
    cameraNodeId: string;
    compilerContext: CutResponsiveSlotMediaContext;
    semanticIdentity: string;
  }>;
}>;

export type ReferenceResponsiveStackConfig = Readonly<{
  nodeId: string;
  plan: ReturnType<typeof decodeCutResponsiveStackPlan>;
  execution: ReferenceResponsiveStackExecution;
  slots: readonly ReferenceResponsiveStackSlotConfig[];
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
  semanticIdentity: string;
}>;

export type ReferenceResponsiveStackFrameSlotEvidence = Readonly<{
  index: number;
  slotNodeId: string;
  childId: string;
  exactSlot: CutResponsiveStackSlot;
  rasterSlot: ReferenceResponsiveStackRasterSlot;
  semanticIdentity: string;
  tileIdentity: string;
  rgbaSha256: string;
  visibleAlphaPixels: number;
  flowText: readonly Readonly<{ nodeId: string; lineCount: number; maxWidth: number }>[];
  mediaCamera2D?: Readonly<{
    cameraNodeId: string;
    status: "rendered" | "opacity-zero";
    backendIdentity: string;
    outputContextIdentity: string;
    staticPlanIdentity: string;
    framePlanIdentity: string;
    cameraExecutionIdentity: string;
    source: Readonly<{
      resourceId: string;
      sha256: string;
      selectedVariant: "master" | "proxy" | "not-applicable";
      leafKind: "image" | "video";
    }>;
    controlsIdentity: string;
    workIdentity: string;
    allocationsIdentity: string;
    outputRgbaSha256: string;
    placement: Readonly<{
      algorithmVersion: typeof referenceResponsiveStackMediaPlacementAlgorithm;
      status: "placed" | "skipped-opacity-zero";
      source: Readonly<{ width: number; height: number; rgbaSha256: string }>;
      destination: ReferenceResponsiveStackRasterSlot;
      clip: "half-open-raster-slot";
      geometricResampleCount: 0;
      placementSurfaceCount: 0 | 1;
      placedRgbaSha256?: string;
      placementIdentity: string;
    }>;
    semanticIdentity: string;
  }>;
}>;

export type ReferenceResponsiveStackFrameEvidence = Readonly<{
  format: "cut-reference-responsive-stack-frame-evidence";
  version: 1;
  evidenceKind: "completed-public-responsive-stack-frame";
  algorithmVersion: typeof referenceResponsiveStackExecutionVersion;
  compositionId: string;
  nodeId: string;
  exactTime: Rational;
  outputFrame: string;
  planIdentity: string;
  axis: "horizontal" | "vertical";
  rasterPolicy: typeof referenceResponsiveStackRasterPolicy;
  slots: readonly ReferenceResponsiveStackFrameSlotEvidence[];
  outputRgbaSha256: string;
  executionIdentity: string;
}>;

const responsiveDescendantOps = new Set([
  "cut.kernel.fragment",
  "cut.visual.group",
  "cut.visual.rect",
  "cut.visual.circle",
  "cut.visual.path",
  "cut.visual.text",
  "cut.visual.flow_text",
]);

const responsiveMediaCameraBranchOps = new Set([
  "cut.visual.media_camera2d",
  "cut.visual.color_grade",
  "cut.visual.blur",
  "cut.visual.sharpen",
  "cut.visual.vignette",
  "cut.visual.grain",
  "cut.visual.duotone",
  "cut.visual.image",
  "cut.visual.video",
]);

function graphFail(node: IRNode, code: CutResponsiveStackError["code"], detail: string): never {
  throw new ReferenceResponsiveStackError(code, node, detail);
}

function exactInterval(left: IRNode, right: IRNode) {
  return compareRational(left.interval.start, right.interval.start) === 0
    && compareRational(left.interval.duration, right.interval.duration) === 0;
}

function containsInterval(parent: IRNode, child: IRNode) {
  const end = (node: IRNode) => {
    const numerator = BigInt(node.interval.start.numerator) * BigInt(node.interval.duration.denominator)
      + BigInt(node.interval.duration.numerator) * BigInt(node.interval.start.denominator);
    const denominator = BigInt(node.interval.start.denominator) * BigInt(node.interval.duration.denominator);
    return rational(numerator, denominator);
  };
  return compareRational(child.interval.start, parent.interval.start) >= 0
    && compareRational(end(child), end(parent)) <= 0;
}

function reachableCompositionNodes(ir: CutAVIR, composition: IRComposition) {
  const pending = [...composition.rootVisualIds, ...composition.rootAVIds];
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (scene) pending.push(...scene.rootVisualIds, ...scene.rootAVIds);
  }
  const result = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const node = ir.nodes[id];
    if (node) pending.push(...node.children);
  }
  return result;
}

function responsiveError(node: IRNode, operation: () => void): void {
  try { operation(); }
  catch (error) {
    if (error instanceof CutResponsiveStackError) graphFail(node, error.code, error.message.replace(`${error.code}: `, ""));
    throw error;
  }
}

/**
 * Validate and bind the closed public responsive grammar. A slot is a real
 * local materialization boundary; unsupported descendants fail instead of
 * falling back to delivery-canvas rendering and post-scale.
 */
export function validateReferenceResponsiveStackGraph(
  ir: CutAVIR,
  composition: IRComposition,
  selectedNodeIds: ReadonlySet<string> = reachableCompositionNodes(ir, composition),
  identityComponentFragments?: ReadonlyMap<string, ReferenceIdentityComponentFragmentConfig>,
) {
  const selected = (id: string) => selectedNodeIds.has(id);
  const admittedIdentityFragments = identityComponentFragments
    ?? validateReferenceIdentityComponentFragments(ir, composition, selectedNodeIds);
  const parents = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) {
    if (!selected(parent.id)) continue;
    for (const childId of parent.children) {
      if (!selected(childId)) continue;
      const values = parents.get(childId) ?? [];
      values.push(parent);
      parents.set(childId, values);
    }
  }
  const result = new Map<string, ReferenceResponsiveStackConfig>();
  const claimedDescendants = new Map<string, string>();
  for (const stack of Object.values(ir.nodes).filter((node) => selected(node.id) && node.op === "cut.visual.responsive_stack")) {
    if (stack.domain !== "visual") graphFail(stack, "CUT_RESPONSIVE_STACK_GRAPH", `must have visual domain, found ${stack.domain}.`);
    if (Object.keys(stack.inputs).length !== 1 || !Object.hasOwn(stack.inputs, "plan")) {
      graphFail(stack, "CUT_RESPONSIVE_STACK_PLAN_TYPE", "must contain exactly the compiler-derived plan input.");
    }
    if (Object.keys(stack.properties).length) graphFail(stack, "CUT_RESPONSIVE_STACK_UNSUPPORTED", "does not accept transform properties; transform content inside slots.");
    let plan!: ReturnType<typeof decodeCutResponsiveStackPlan>;
    let rasterSlots!: readonly ReferenceResponsiveStackRasterSlot[];
    responsiveError(stack, () => {
      plan = decodeCutResponsiveStackPlan(stack.inputs.plan, `${stack.id}.inputs.plan`);
      rasterSlots = referenceResponsiveStackRasterSlots(stack.inputs.plan, `${stack.id}.inputs.plan`);
    });
    if (compareRational(plan.context.width, rational(composition.width)) !== 0
      || compareRational(plan.context.height, rational(composition.height)) !== 0) {
      graphFail(stack, "CUT_RESPONSIVE_STACK_CONTEXT", `retains ${plan.context.width.numerator}x${plan.context.height.numerator}px but belongs to ${composition.width}x${composition.height}px composition ${composition.id}; stale or cross-context plans cannot execute.`);
    }
    if (stack.children.length !== plan.slots.length) {
      graphFail(stack, "CUT_RESPONSIVE_STACK_GRAPH", `requires exactly ${plan.slots.length} ResponsiveSlot children for ${plan.weights.length} retained weights; found ${stack.children.length}.`);
    }

    let ancestor: IRNode = stack;
    let identityComponentFragment: ReferenceIdentityComponentFragmentChildBinding | undefined;
    const ancestorIds = new Set<string>([stack.id]);
    while ((parents.get(ancestor.id) ?? []).length) {
      const candidates = parents.get(ancestor.id)!;
      if (candidates.length !== 1) graphFail(stack, "CUT_RESPONSIVE_STACK_GRAPH", `owner chain is ambiguous at ${ancestor.id}.`);
      const parent = candidates[0];
      const admitted = ancestor.id === stack.id
        ? referenceIdentityComponentFragmentForChild(admittedIdentityFragments, stack.id)
        : undefined;
      if (admitted?.fragmentNodeId === parent.id
        && admitted.stackNodeId === stack.id
        && admitted.childNodeIds[0] === stack.id
        && exactInterval(parent, ancestor)) {
        identityComponentFragment =
          referenceIdentityComponentFragmentChildBinding(admitted, stack.id);
        ancestorIds.add(parent.id);
        ancestor = parent;
        continue;
      }
      if (parent.op !== "cut.kernel.fragment" || parent.children.length !== 1 || !exactInterval(parent, ancestor)) {
        graphFail(stack, "CUT_RESPONSIVE_STACK_UNSUPPORTED", `owner ${parent.op} is not a unary, interval-preserving public component fragment; post-layout transforms are not silently applied.`);
      }
      if (Object.keys(parent.inputs).length || Object.keys(parent.properties).length) {
        graphFail(stack, "CUT_RESPONSIVE_STACK_UNSUPPORTED", `component fragment ${parent.id} carries inputs or self transforms that the ResponsiveStack placement boundary does not execute; move transforms inside slots.`);
      }
      if (ancestorIds.has(parent.id)) graphFail(stack, "CUT_RESPONSIVE_STACK_GRAPH", `owner chain cycles through ${parent.id}.`);
      ancestorIds.add(parent.id);
      ancestor = parent;
    }

    const slots: ReferenceResponsiveStackSlotConfig[] = [];
    const executionChildren: ReferenceResponsiveStackChild[] = [];
    for (const [index, slotId] of stack.children.entries()) {
      const slot = ir.nodes[slotId];
      if (!slot || slot.op !== "cut.visual.responsive_slot") graphFail(stack, "CUT_RESPONSIVE_STACK_GRAPH", `child ${index} must be an existing ResponsiveSlot; found ${slot?.op ?? "missing"}.`);
      if (slot.domain !== "visual" || Object.keys(slot.inputs).length || Object.keys(slot.properties).length) {
        graphFail(slot, "CUT_RESPONSIVE_STACK_GRAPH", "must be a property-free visual structural node.");
      }
      const slotParents = parents.get(slot.id) ?? [];
      if (slotParents.length !== 1 || slotParents[0]?.id !== stack.id) graphFail(slot, "CUT_RESPONSIVE_STACK_GRAPH", "must be owned directly and exclusively by one ResponsiveStack.");
      if (!exactInterval(stack, slot)) graphFail(slot, "CUT_RESPONSIVE_STACK_GRAPH", "interval must exactly equal its ResponsiveStack interval.");
      if (slot.children.length !== 1) graphFail(slot, "CUT_RESPONSIVE_STACK_GRAPH", `requires exactly one direct visual child; found ${slot.children.length}.`);
      const child = ir.nodes[slot.children[0]];
      if (!child || child.domain !== "visual") graphFail(slot, "CUT_RESPONSIVE_STACK_GRAPH", "must reference one existing visual child.");
      if (!exactInterval(slot, child)) graphFail(child, "CUT_RESPONSIVE_STACK_GRAPH", "direct child interval must exactly equal its ResponsiveSlot interval.");
      const mediaCameraBranch = child.op === "cut.visual.media_camera2d";

      const descendantIds: string[] = [];
      const visiting = new Set<string>();
      const visit = (node: IRNode) => {
        if (visiting.has(node.id)) graphFail(node, "CUT_RESPONSIVE_STACK_GRAPH", `descendant graph cycles through ${node.id}.`);
        const owners = parents.get(node.id) ?? [];
        if (owners.length !== 1) graphFail(node, "CUT_RESPONSIVE_STACK_GRAPH", `must belong to exactly one structural responsive coordinate context; found ${owners.length}.`);
        if (node.domain !== "visual") graphFail(node, "CUT_RESPONSIVE_STACK_GRAPH", `must have visual domain, found ${node.domain}.`);
        if (!containsInterval(slot, node)) graphFail(node, "CUT_RESPONSIVE_STACK_GRAPH", "interval escapes its ResponsiveSlot interval.");
        const admittedOps = mediaCameraBranch ? responsiveMediaCameraBranchOps : responsiveDescendantOps;
        if (!admittedOps.has(node.op)) {
          graphFail(node, "CUT_RESPONSIVE_STACK_UNSUPPORTED", `${node.op} has no slot-local raster implementation in ${referenceResponsiveStackExecutionVersion}; delivery-canvas fallback is forbidden.`);
        }
        if (mediaCameraBranch) {
          if (node.op === "cut.visual.image" || node.op === "cut.visual.video") {
            if (node.children.length !== 0) graphFail(node, "CUT_RESPONSIVE_STACK_GRAPH", "slot-bound MediaCamera2D media leaf must be childless.");
          } else if (node.children.length !== 1) {
            graphFail(node, "CUT_RESPONSIVE_STACK_GRAPH", `${node.op} must remain one unary node in the slot-bound MediaCamera2D branch.`);
          }
        }
        if ((node.op === "cut.kernel.fragment" || node.op === "cut.visual.group") && node.children.length < 1) {
          graphFail(node, "CUT_RESPONSIVE_STACK_NOOP", `${node.op} cannot be empty inside ResponsiveSlot.`);
        }
        const claimed = claimedDescendants.get(node.id);
        if (claimed && claimed !== slot.id) graphFail(node, "CUT_RESPONSIVE_STACK_GRAPH", `is claimed by ResponsiveSlots ${claimed} and ${slot.id}.`);
        claimedDescendants.set(node.id, slot.id);
        descendantIds.push(node.id);
        visiting.add(node.id);
        for (const nestedId of node.children) {
          const nested = ir.nodes[nestedId];
          if (!nested) graphFail(node, "CUT_RESPONSIVE_STACK_GRAPH", `references missing descendant ${nestedId}.`);
          visit(nested);
        }
        visiting.delete(node.id);
      };
      visit(child);
      if (mediaCameraBranch) {
        const leaves = descendantIds
          .map((nodeId) => ir.nodes[nodeId])
          .filter((node): node is IRNode => node?.op === "cut.visual.image" || node?.op === "cut.visual.video");
        if (leaves.length !== 1) {
          graphFail(child, "CUT_RESPONSIVE_STACK_GRAPH", `slot-bound MediaCamera2D branch must terminate in exactly one native Image or Video leaf; found ${leaves.length}.`);
        }
      }
      let compilerMediaContext: CutResponsiveSlotMediaContext | undefined;
      if (mediaCameraBranch) {
        const contextValue = child.inputs.responsiveSlotContext;
        if (!contextValue) graphFail(child, "CUT_RESPONSIVE_STACK_GRAPH", "is missing compiler-owned responsiveSlotContext.");
        responsiveError(child, () => {
          compilerMediaContext = decodeCutResponsiveSlotMediaContext(
            contextValue,
            stack.inputs.plan,
            { stackNodeId: stack.id, slotNodeId: slot.id, index },
            `${child.id}.inputs.responsiveSlotContext`,
          );
        });
        if (compilerMediaContext!.rasterSlot.left !== rasterSlots[index].left
          || compilerMediaContext!.rasterSlot.top !== rasterSlots[index].top
          || compilerMediaContext!.rasterSlot.right !== rasterSlots[index].right
          || compilerMediaContext!.rasterSlot.bottom !== rasterSlots[index].bottom
          || compilerMediaContext!.rasterSlot.width !== rasterSlots[index].width
          || compilerMediaContext!.rasterSlot.height !== rasterSlots[index].height) {
          graphFail(child, "CUT_RESPONSIVE_STACK_IDENTITY", "compiler responsiveSlotContext raster geometry diverges from the reference runtime raster boundary.");
        }
      }
      const semanticIdentity = hash({
        algorithm: referenceResponsiveStackExecutionVersion,
        planIdentity: plan.id,
        slotIndex: index,
        slotNode: slot.contentHash,
        child: child.contentHash,
        descendants: descendantIds.map((nodeId) => {
          const descendant = ir.nodes[nodeId]!;
          return Object.freeze({ nodeId, op: descendant.op, contentHash: descendant.contentHash });
        }),
        ...(compilerMediaContext ? {
          mediaCamera2D: Object.freeze({
            cameraNodeId: child.id,
            compilerContextIdentity: compilerMediaContext.contextIdentity,
          }),
        } : {}),
        rasterSlot: rasterSlots[index],
      });
      const context: ReferenceResponsiveStackLocalContext = Object.freeze({
        contextKind: "responsive-slot",
        nodeId: slot.id,
        stackNodeId: stack.id,
        childId: child.id,
        index,
        width: rasterSlots[index].width,
        height: rasterSlots[index].height,
        origin: Object.freeze({ x: zeroRational, y: zeroRational }),
        rasterOriginQ16: Object.freeze({ x: "0", y: "0" }),
        view: Object.freeze({ minX: zeroRational, minY: zeroRational, maxX: rational(rasterSlots[index].width), maxY: rational(rasterSlots[index].height) }),
        childIds: Object.freeze([child.id]) as readonly [string],
        exactSlot: plan.slots[index],
        rasterSlot: rasterSlots[index],
        semanticIdentity,
      });
      const mediaCamera2D = compilerMediaContext
        ? Object.freeze({
          cameraNodeId: child.id,
          compilerContext: compilerMediaContext,
          semanticIdentity: hash({
            algorithm: referenceResponsiveStackExecutionVersion,
            cameraNodeId: child.id,
            compilerContextIdentity: compilerMediaContext.contextIdentity,
            slotSemanticIdentity: semanticIdentity,
          }),
        })
        : undefined;
      slots.push(Object.freeze({
        slotNodeId: slot.id,
        childId: child.id,
        descendantIds: Object.freeze(descendantIds),
        context,
        ...(mediaCamera2D ? { mediaCamera2D } : {}),
      }));
      executionChildren.push(Object.freeze({ semanticIdentity, ...referenceResponsiveStackTransparentMinimum }));
    }
    let execution!: ReferenceResponsiveStackExecution;
    responsiveError(stack, () => { execution = referenceResponsiveStackExecution(stack.inputs.plan, executionChildren, stack.id); });
    const semanticIdentity = hash({
      algorithm: referenceResponsiveStackExecutionVersion,
      stack: stack.contentHash,
      plan: plan.id,
      slots: slots.map((slot) => slot.context.semanticIdentity),
      execution: execution.semanticIdentity,
      ...(identityComponentFragment ? { identityComponentFragment } : {}),
    });
    result.set(stack.id, Object.freeze({
      nodeId: stack.id,
      plan,
      execution,
      slots: Object.freeze(slots),
      ...(identityComponentFragment ? { identityComponentFragment } : {}),
      semanticIdentity,
    }));
  }

  for (const slot of Object.values(ir.nodes).filter((node) => selected(node.id) && node.op === "cut.visual.responsive_slot")) {
    const owners = parents.get(slot.id) ?? [];
    if (owners.length !== 1 || owners[0].op !== "cut.visual.responsive_stack") {
      graphFail(slot, "CUT_RESPONSIVE_STACK_GRAPH", "is orphaned or owned outside ResponsiveStack.");
    }
  }
  return result;
}

export function referenceResponsiveStackDescendantContexts(
  configs: ReadonlyMap<string, ReferenceResponsiveStackConfig>,
) {
  const contexts = new Map<string, ReferenceResponsiveStackLocalContext>();
  for (const config of configs.values()) for (const slot of config.slots) for (const nodeId of slot.descendantIds) {
    const previous = contexts.get(nodeId);
    if (previous && previous.nodeId !== slot.context.nodeId) {
      const synthetic = { provenance: { module: "project.cut", span: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } }, id: nodeId } as IRNode;
      graphFail(synthetic, "CUT_RESPONSIVE_STACK_GRAPH", `descendant belongs to responsive contexts ${previous.nodeId} and ${slot.context.nodeId}.`);
    }
    contexts.set(nodeId, slot.context);
  }
  return contexts;
}

export function referenceResponsiveStackTextLayoutContext(context: ReferenceResponsiveStackLocalContext) {
  return Object.freeze({
    kind: "responsive-slot" as const,
    width: context.width,
    height: context.height,
    originX: 0,
    originY: 0,
  });
}

export function referenceResponsiveStackInspect(config: ReferenceResponsiveStackConfig) {
  return Object.freeze({
    status: "public-vertical" as const,
    algorithmVersion: referenceResponsiveStackExecutionVersion,
    planIdentity: config.plan.id,
    axis: config.plan.axis,
    context: { ...config.plan.context },
    safeArea: { x: config.plan.safeX, y: config.plan.safeY },
    gap: config.plan.gap,
    rasterPolicy: referenceResponsiveStackRasterPolicy,
    ...(config.identityComponentFragment
      ? { identityComponentFragment: config.identityComponentFragment }
      : {}),
    slots: config.slots.map((slot) => Object.freeze({
      index: slot.context.index,
      slotNodeId: slot.slotNodeId,
      childId: slot.childId,
      exact: slot.context.exactSlot,
      raster: slot.context.rasterSlot,
      localContext: { width: slot.context.width, height: slot.context.height, origin: { x: zeroRational, y: zeroRational } },
      ...(slot.mediaCamera2D ? {
        mediaCamera2D: Object.freeze({
          cameraNodeId: slot.mediaCamera2D.cameraNodeId,
          branch: "direct-native-image-or-video" as const,
          compilerContextIdentity: slot.mediaCamera2D.compilerContext.contextIdentity,
          clip: "half-open-raster-slot" as const,
          output: Object.freeze({
            width: slot.mediaCamera2D.compilerContext.rasterSlot.width,
            height: slot.mediaCamera2D.compilerContext.rasterSlot.height,
          }),
          visualAnchorComposition: Object.freeze({
            status: "supported-exact-chain" as const,
            sourceBasis: "post-crop-source-pixel-centres" as const,
            slotBasis: "responsive-slot-pixel-centres" as const,
            compositionBasis: "composition-pixel-centres" as const,
            placement: "integer-translate-half-open-clip-zero-resample" as const,
          }),
          semanticIdentity: slot.mediaCamera2D.semanticIdentity,
        }),
      } : {}),
      semanticIdentity: slot.context.semanticIdentity,
    })),
    semanticIdentity: config.semanticIdentity,
    executionSupport: Object.freeze({
      descendants: [...responsiveDescendantOps].sort(),
      mediaCamera2D: Object.freeze({
        directBranch: [...responsiveMediaCameraBranchOps].sort(),
        nativeImageVideo: true as const,
        nativeEffects: true as const,
        visualAnchorComposition: true as const,
      }),
      unsupported: ["arbitrary media/effect descendants", "LocalSpace nesting", "nested ResponsiveStack", "post-layout transforms"],
      fallback: "CUT_RESPONSIVE_STACK_UNSUPPORTED" as const,
    }),
  });
}

function sameRasterSlot(left: ReferenceResponsiveStackRasterSlot, right: ReferenceResponsiveStackRasterSlot) {
  return left.left === right.left
    && left.top === right.top
    && left.right === right.right
    && left.bottom === right.bottom
    && left.width === right.width
    && left.height === right.height;
}

/**
 * Close the persisted cross-receipt relationship. This is a semantic
 * consistency check, not live execution authority: the renderer performs it
 * before committing either receipt, while offline tools use it to reject
 * contradictory frame-v2 JSON.
 */
export function validateReferenceResponsiveStackMediaFrameEvidence(
  stacks: readonly ReferenceResponsiveStackFrameEvidence[],
  cameras: readonly ReferenceMediaCamera2DExecutionEvidence[],
) {
  const cameraByExecution = new Map(cameras.map((camera) => [camera.executionIdentity, camera]));
  const claimed = new Set<string>();
  for (const stack of stacks) {
    const { executionIdentity, ...stackReceipt } = stack;
    if (hash(stackReceipt) !== executionIdentity) {
      throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: responsive frame ${stack.nodeId} executionIdentity does not authenticate its closed receipt.`);
    }
    for (const slot of stack.slots) {
      const media = slot.mediaCamera2D;
      if (!media) continue;
      const camera = cameraByExecution.get(media.cameraExecutionIdentity);
      if (!camera) {
        throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: slot ${slot.slotNodeId} references missing MediaCamera2D execution ${media.cameraExecutionIdentity}.`);
      }
      if (claimed.has(camera.executionIdentity)) {
        throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: MediaCamera2D execution ${camera.executionIdentity} is claimed by more than one ResponsiveSlot.`);
      }
      claimed.add(camera.executionIdentity);
      if (camera.outputContext.kind !== "responsive-slot"
        || camera.outputContext.stackNodeId !== stack.nodeId
        || camera.outputContext.slotNodeId !== slot.slotNodeId
        || camera.outputContext.index !== slot.index
        || camera.outputContext.planIdentity !== stack.planIdentity
        || camera.outputContext.semanticIdentity !== media.outputContextIdentity
        || !sameRasterSlot(camera.outputContext.rasterSlot, slot.rasterSlot)
        || camera.cameraNodeId !== media.cameraNodeId
        || camera.status !== media.status
        || camera.backendIdentity !== media.backendIdentity
        || camera.framePlanIdentity !== media.framePlanIdentity
        || camera.executionIdentity !== media.cameraExecutionIdentity
        || camera.outputRgbaSha256 !== media.outputRgbaSha256
        || camera.outputRgbaSha256 !== slot.rgbaSha256
        || camera.source.resourceId !== media.source.resourceId
        || camera.source.sha256 !== media.source.sha256
        || camera.source.selectedVariant !== media.source.selectedVariant
        || camera.source.leafKind !== media.source.leafKind
        || hash(camera.controls) !== media.controlsIdentity
        || hash(camera.work) !== media.workIdentity
        || hash(camera.allocations) !== media.allocationsIdentity) {
        throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: slot ${slot.slotNodeId} MediaCamera2D summary contradicts its completed native camera receipt.`);
      }
      const placement = media.placement;
      const { placementIdentity, ...placementReceipt } = placement;
      if (hash(placementReceipt) !== placementIdentity
        || placement.algorithmVersion !== referenceResponsiveStackMediaPlacementAlgorithm
        || placement.source.width !== slot.rasterSlot.width
        || placement.source.height !== slot.rasterSlot.height
        || placement.source.rgbaSha256 !== slot.rgbaSha256
        || !sameRasterSlot(placement.destination, slot.rasterSlot)
        || placement.clip !== "half-open-raster-slot"
        || placement.geometricResampleCount !== 0) {
        throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: slot ${slot.slotNodeId} has contradictory native camera placement evidence.`);
      }
      if (camera.status === "opacity-zero") {
        if (slot.visibleAlphaPixels !== 0
          || placement.status !== "skipped-opacity-zero"
          || placement.placementSurfaceCount !== 0
          || placement.placedRgbaSha256 !== undefined) {
          throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: opacity-zero slot camera ${camera.cameraNodeId} claims placement or visible pixels.`);
        }
      } else if (placement.status !== "placed"
        || placement.placementSurfaceCount !== 1
        || !digestPattern.test(placement.placedRgbaSha256 ?? "")) {
        throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: rendered slot camera ${camera.cameraNodeId} must have exactly one authenticated integer placement.`);
      }
      const { semanticIdentity, ...mediaReceipt } = media;
      if (hash(mediaReceipt) !== semanticIdentity) {
        throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: slot ${slot.slotNodeId} MediaCamera2D semanticIdentity does not authenticate its summary.`);
      }
    }
  }
  for (const camera of cameras) {
    if (camera.outputContext.kind === "responsive-slot" && !claimed.has(camera.executionIdentity)) {
      throw new Error(`CUT_RESPONSIVE_STACK_IDENTITY: slot-bound MediaCamera2D ${camera.cameraNodeId} completed without one ResponsiveStack placement receipt.`);
    }
  }
  return Object.freeze({ responsiveStackCount: stacks.length, claimedMediaCameraCount: claimed.size });
}
