import { hash } from "../../core/stable";
import { cutAnchoredSpatialOps } from "../../language/anchored-path-contract";
import type {
  CutAVIR,
  IRComposition,
  IRNode,
  IRScene,
  IRValue,
} from "../../language/ir";
import { compareRational, rational, type Rational } from "../../language/rational";
import {
  createReferenceComponentFragmentLocalSpaceAdmissionIndex,
  type ReferenceComponentFragmentLocalSpaceAdmissionIndex,
} from "./component-fragment-local-space";

export const referenceIdentityComponentFragmentAlgorithmVersion =
  "cut-reference-identity-component-fragment-v1" as const;

export const referenceIdentityComponentFragmentExecutionAlgorithmVersion =
  "cut-reference-identity-component-fragment-frame-v1" as const;

export type ReferenceIdentityComponentFragmentDiagnosticCode =
  | "CUT_IDENTITY_FRAGMENT_GRAPH"
  | "CUT_IDENTITY_FRAGMENT_UNSUPPORTED"
  | "CUT_IDENTITY_FRAGMENT_EVIDENCE";

export class ReferenceIdentityComponentFragmentError extends Error {
  readonly source: Readonly<{
    module: string;
    line: number;
    column: number;
    nodeId: string;
  }>;

  constructor(
    readonly code: ReferenceIdentityComponentFragmentDiagnosticCode,
    readonly node: IRNode,
    detail: string,
  ) {
    const { module, span } = node.provenance;
    super(`${code}: identity component fragment at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceIdentityComponentFragmentError";
    this.source = Object.freeze({
      module,
      line: span.start.line,
      column: span.start.column,
      nodeId: node.id,
    });
  }
}

function fail(
  node: IRNode,
  code: ReferenceIdentityComponentFragmentDiagnosticCode,
  detail: string,
): never {
  throw new ReferenceIdentityComponentFragmentError(code, node, detail);
}

function sameInterval(left: IRNode, right: IRNode) {
  return compareRational(left.interval.start, right.interval.start) === 0
    && compareRational(left.interval.duration, right.interval.duration) === 0;
}

function sameSpan(
  left: IRNode["provenance"]["span"],
  right: IRNode["provenance"]["span"],
) {
  return left.start.offset === right.start.offset
    && left.start.line === right.start.line
    && left.start.column === right.start.column
    && left.end.offset === right.end.offset
    && left.end.line === right.end.line
    && left.end.column === right.end.column;
}

function spanContains(
  outer: IRNode["provenance"]["span"],
  inner: IRNode["provenance"]["span"],
) {
  return inner.start.offset >= outer.start.offset
    && inner.end.offset <= outer.end.offset;
}

function selectedNode(
  selectedNodeIds: ReadonlySet<string> | undefined,
  nodeId: string,
) {
  return selectedNodeIds === undefined || selectedNodeIds.has(nodeId);
}

function semanticProvenance(
  value: IRNode["provenance"],
) {
  return Object.freeze({
    module: value.module,
    ...(value.symbol ? { symbol: value.symbol } : {}),
    ...(value.expandedFrom?.length
      ? {
        expandedFrom: Object.freeze(value.expandedFrom.map((frame) =>
          Object.freeze({
            module: frame.module,
            ...(frame.symbol ? { symbol: frame.symbol } : {}),
          }))),
      }
      : {}),
  });
}

function visualAnchorOwnerIds(node: IRNode) {
  const value = node.op === "cut.visual.path"
    ? node.inputs.geometry
    : node.op === "cut.visual.callout"
      ? node.inputs.anchor
      : undefined;
  if (value === undefined) {
    fail(
      node,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      `expected Path or Callout anchor consumer; found ${node.op}.`,
    );
  }
  if (node.op === "cut.visual.path"
    && (value.kind !== "call" || value.op !== cutAnchoredSpatialOps.anchoredPath)) {
    fail(
      node,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      "direct Path consumer must use public anchoredPath geometry.",
    );
  }
  const owners = new Set<string>();
  const visit = (candidate: IRValue) => {
    if (candidate.kind === "call") {
      if (candidate.op === cutAnchoredSpatialOps.visualAnchor) {
        const owner = candidate.named.owner;
        if (owner?.kind !== "node-ref") {
          fail(
            node,
            "CUT_IDENTITY_FRAGMENT_GRAPH",
            "visualAnchor owner must be one explicit node reference.",
          );
        }
        owners.add(owner.id);
      }
      for (const nested of candidate.positional) visit(nested);
      for (const nested of Object.values(candidate.named)) visit(nested);
      return;
    }
    if (candidate.kind === "array") {
      for (const nested of candidate.items) visit(nested);
    } else if (candidate.kind === "object") {
      for (const nested of Object.values(candidate.entries)) visit(nested);
    } else if (candidate.kind === "range") {
      visit(candidate.start);
      visit(candidate.end);
    } else if (candidate.kind === "unary") {
      visit(candidate.value);
    } else if (candidate.kind === "binary") {
      visit(candidate.left);
      visit(candidate.right);
    } else if (candidate.kind === "member") {
      visit(candidate.object);
    } else if (candidate.kind === "index") {
      visit(candidate.object);
    }
  };
  visit(value);
  if (owners.size < 1) {
    fail(
      node,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      "consumer must contain at least one public visualAnchor.",
    );
  }
  return Object.freeze([...owners].sort());
}

function exactComponentProvenance(fragment: IRNode, child: IRNode) {
  const symbol = fragment.provenance.symbol;
  const expanded = fragment.provenance.expandedFrom;
  if (!symbol
    || expanded?.length !== 2
    || !expanded[0]?.symbol.endsWith(":definition")
    || expanded[0].symbol.length <= ":definition".length
    || (expanded[0].module === fragment.provenance.module
      && expanded[0].symbol !== `${symbol}:definition`)
    || expanded[1]?.symbol !== `${symbol}:invocation`
    // Imported components deliberately retain the definition module in frame
    // zero and the call-site module in frame one. Requiring both modules to be
    // the call-site module would make accepted imported source fail only in
    // the renderer.
    || expanded[1].module !== fragment.provenance.module
    || !sameSpan(fragment.provenance.span, expanded[1].span)) {
    fail(
      fragment,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      "must retain exactly its matching component definition/invocation provenance and call-site span.",
    );
  }
  const childExpanded = child.provenance.expandedFrom;
  if (childExpanded?.length !== 2
    || hash(childExpanded) !== hash(expanded)
    || child.provenance.module !== expanded[0].module
    || !spanContains(expanded[0].span, child.provenance.span)) {
    fail(
      child,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      `direct child ${child.id} is not authenticated by the same component definition/invocation expansion as fragment ${fragment.id}.`,
    );
  }
}

export type ReferenceIdentityComponentFragmentConfig = Readonly<{
  algorithmVersion: typeof referenceIdentityComponentFragmentAlgorithmVersion;
  compositionId: string;
  sceneId: string;
  fragmentNodeId: string;
  fragmentContentHash: string;
  rootSourceOrder: number;
  childNodeIds: readonly string[];
  childContent: readonly Readonly<{
    nodeId: string;
    op: string;
    contentHash: string;
  }>[];
  stackNodeId: string;
  slotNodeId: string;
  cameraNodeId: string;
  pathNodeId?: string;
  calloutLayerNodeId?: string;
  calloutNodeIds: readonly string[];
  provenanceIdentity: string;
  cacheIdentity: string;
  semanticIdentity: string;
}>;

export type ReferenceIdentityComponentFragmentChildBinding = Readonly<{
  fragmentNodeId: string;
  fragmentSemanticIdentity: string;
  fragmentCacheIdentity: string;
  rootSourceOrder: number;
  childIndex: number;
  childNodeId: string;
  executionPathIdentity: string;
}>;

export type ReferenceIdentityComponentFragmentFrameChildEvidence = Readonly<{
  index: number;
  nodeId: string;
  op: string;
  contentHash: string;
  cacheIdentity: string;
  outputRgbaSha256: string;
}>;

export type ReferenceIdentityComponentFragmentFrameEvidence = Readonly<{
  format: "cut-reference-identity-component-fragment-frame";
  version: 1;
  algorithmVersion: typeof referenceIdentityComponentFragmentExecutionAlgorithmVersion;
  compositionId: string;
  sceneId: string;
  fragmentNodeId: string;
  exactTime: Rational;
  outputFrame: string;
  fragmentContentHash: string;
  structuralIdentity: string;
  cacheIdentity: string;
  rootSourceOrder: number;
  children: readonly ReferenceIdentityComponentFragmentFrameChildEvidence[];
  cameraExecutions: readonly Readonly<{ nodeId: string; executionIdentity: string }>[];
  responsiveStackExecutions: readonly Readonly<{ nodeId: string; executionIdentity: string }>[];
  anchoredPathExecutions: readonly Readonly<{
    nodeId: string;
    executionIdentity: string;
    evidenceIdentity: string;
  }>[];
  calloutLayerExecutions: readonly Readonly<{ nodeId: string; executionIdentity: string }>[];
  slotMediaAnchorLinks: readonly Readonly<{
    consumerNodeId: string;
    linkIdentity: string;
  }>[];
  executionPath: readonly Readonly<{
    compositionId: string;
    fragmentNodeId: string;
    structuralIdentity: string;
  }>[];
  work: Readonly<{
    childDispatches: number;
    wrapperRasterMaterializations: 0;
    wrapperCanvasAllocations: 0;
    wrapperTransforms: 0;
    wrapperClips: 0;
    wrapperGeometricResamples: 0;
  }>;
  sceneOutputRgbaSha256: string;
  executionIdentity: string;
}>;

function relevantFragment(fragment: IRNode, ir: CutAVIR) {
  if (fragment.op !== "cut.kernel.fragment") return false;
  const children = fragment.children.map((childId) => ir.nodes[childId]);
  return children[0]?.op === "cut.visual.responsive_stack"
    && children.slice(1).some((child) =>
      child?.op === "cut.visual.path" || child?.op === "cut.visual.callout_layer");
}

function validateOne(
  ir: CutAVIR,
  composition: IRComposition,
  fragment: IRNode,
  index: ReferenceComponentFragmentLocalSpaceAdmissionIndex,
): ReferenceIdentityComponentFragmentConfig {
  const scene = fragment.sceneId ? ir.scenes[fragment.sceneId] : undefined;
  if (fragment.domain !== "visual"
    || fragment.ownership !== "root"
    || fragment.effects.length !== 1
    || fragment.effects[0] !== "pure"
    || fragment.editorial !== undefined
    || Object.keys(fragment.inputs).length !== 0
    || Object.keys(fragment.properties).length !== 0) {
    fail(
      fragment,
      "CUT_IDENTITY_FRAGMENT_UNSUPPORTED",
      "must be one pure, property-free, input-free visual root without editorial or transform semantics.",
    );
  }
  if (!scene
    || index.parentIdsForChild(fragment.id).length !== 0
    || index.sceneMembershipsForNode(fragment.id).length !== 1
    || index.sceneMembershipsForNode(fragment.id)[0]?.sceneId !== scene.id
    || index.sceneMembershipsForNode(fragment.id)[0]?.domain !== "visual"
    || index.compositionRootIdsForNode(fragment.id).length !== 0
    || index.compositionIdsForScene(scene.id).length !== 1
    || index.compositionIdsForScene(scene.id)[0] !== composition.id) {
    fail(
      fragment,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      "must be one direct visual scene root with no structural parent, composition-root membership, or foreign composition.",
    );
  }
  const rootSourceOrder = scene.items.findIndex((item) =>
    item.id === fragment.id && item.domain === "visual");
  if (rootSourceOrder < 0
    || compareRational(fragment.interval.start, rational(0)) !== 0
    || compareRational(fragment.interval.duration, scene.duration) !== 0) {
    fail(
      fragment,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      "must span its complete owning scene from exact zero at one stable root source position.",
    );
  }
  if (fragment.children.length < 2
    || fragment.children.length > 3
    || new Set(fragment.children).size !== fragment.children.length) {
    fail(
      fragment,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      "must contain exactly one ResponsiveStack followed by Path and/or CalloutLayer direct consumers.",
    );
  }
  const children = fragment.children.map((childId) => ir.nodes[childId]);
  const [stack, ...consumers] = children;
  if (!stack || stack.op !== "cut.visual.responsive_stack"
    || consumers.length < 1
    || consumers.some((child) =>
      !child || (child.op !== "cut.visual.path" && child.op !== "cut.visual.callout_layer"))
    || consumers.filter((child) => child?.op === "cut.visual.path").length > 1
    || consumers.filter((child) => child?.op === "cut.visual.callout_layer").length > 1) {
    fail(
      fragment,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      "ordered children must be ResponsiveStack first, then at most one anchored Path and at most one CalloutLayer.",
    );
  }
  for (const child of children) {
    if (!child
      || child.op === "cut.kernel.fragment"
      || child.domain !== "visual"
      || child.ownership !== "child"
      || child.sceneId !== scene.id
      || !sameInterval(fragment, child)
      || index.parentIdsForChild(child.id).length !== 1
      || index.parentIdsForChild(child.id)[0] !== fragment.id
      || index.sceneMembershipsForNode(child.id).length !== 0
      || index.compositionRootIdsForNode(child.id).length !== 0) {
      fail(
        child ?? fragment,
        "CUT_IDENTITY_FRAGMENT_GRAPH",
        `direct child ${child?.id ?? "missing"} must be an exact-interval, child-owned, exclusively parented visual node with no root membership.`,
      );
    }
    exactComponentProvenance(fragment, child);
  }
  const cameraNodes: IRNode[] = [];
  const cameraSlots: IRNode[] = [];
  for (const slotId of stack.children) {
    const slot = ir.nodes[slotId];
    if (slot?.op !== "cut.visual.responsive_slot") continue;
    const camera = slot.children.length === 1 ? ir.nodes[slot.children[0]!] : undefined;
    if (camera?.op === "cut.visual.media_camera2d") {
      cameraSlots.push(slot);
      cameraNodes.push(camera);
    }
  }
  if (cameraNodes.length !== 1) {
    fail(
      stack,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      `first ResponsiveStack must retain exactly one direct ResponsiveSlot -> MediaCamera2D chain; found ${cameraNodes.length}.`,
    );
  }
  const slot = cameraSlots[0]!;
  const camera = cameraNodes[0]!;
  for (const descendant of [slot, camera]) {
    const expectedParent = descendant.id === slot.id ? stack.id : slot.id;
    if (descendant.domain !== "visual"
      || descendant.ownership !== "child"
      || descendant.sceneId !== scene.id
      || !sameInterval(fragment, descendant)
      || index.parentIdsForChild(descendant.id).length !== 1
      || index.parentIdsForChild(descendant.id)[0] !== expectedParent
      || index.sceneMembershipsForNode(descendant.id).length !== 0
      || index.compositionRootIdsForNode(descendant.id).length !== 0) {
      fail(
        descendant,
        "CUT_IDENTITY_FRAGMENT_GRAPH",
        `${descendant.op} ${descendant.id} must be an exact-interval, child-owned, exclusively parented descendant of the admitted ResponsiveStack.`,
      );
    }
    exactComponentProvenance(fragment, descendant);
  }
  const path = consumers.find((child) => child?.op === "cut.visual.path");
  if (path) {
    const ownerIds = visualAnchorOwnerIds(path);
    if (ownerIds.length !== 1 || ownerIds[0] !== camera.id) {
      fail(
        path,
        "CUT_IDENTITY_FRAGMENT_GRAPH",
        `Path visualAnchor must reference only same-fragment slot camera ${camera.id}.`,
      );
    }
  }
  const layer = consumers.find((child) => child?.op === "cut.visual.callout_layer");
  const authenticatedNestedNodes: IRNode[] = [slot, camera];
  if (layer) {
    if (layer.children.length < 1) {
      fail(layer, "CUT_IDENTITY_FRAGMENT_GRAPH", "CalloutLayer cannot be empty.");
    }
    for (const calloutId of layer.children) {
      const callout = ir.nodes[calloutId];
      if (!callout || callout.op !== "cut.visual.callout") {
        fail(layer, "CUT_IDENTITY_FRAGMENT_GRAPH", `CalloutLayer child ${calloutId} is not Callout.`);
      }
      if (callout.domain !== "visual"
        || callout.ownership !== "child"
        || callout.sceneId !== scene.id
        || !sameInterval(fragment, callout)
        || index.parentIdsForChild(callout.id).length !== 1
        || index.parentIdsForChild(callout.id)[0] !== layer.id
        || index.sceneMembershipsForNode(callout.id).length !== 0
        || index.compositionRootIdsForNode(callout.id).length !== 0
        || callout.children.length !== 1) {
        fail(
          callout,
          "CUT_IDENTITY_FRAGMENT_GRAPH",
          `Callout ${callout.id} must be one exact-interval, child-owned descendant with exactly one LocalSpace.`,
        );
      }
      exactComponentProvenance(fragment, callout);
      const localSpace = ir.nodes[callout.children[0]!];
      if (!localSpace
        || localSpace.op !== "cut.visual.local_space"
        || localSpace.domain !== "visual"
        || localSpace.ownership !== "child"
        || localSpace.sceneId !== scene.id
        || !sameInterval(fragment, localSpace)
        || index.parentIdsForChild(localSpace.id).length !== 1
        || index.parentIdsForChild(localSpace.id)[0] !== callout.id
        || index.sceneMembershipsForNode(localSpace.id).length !== 0
        || index.compositionRootIdsForNode(localSpace.id).length !== 0) {
        fail(
          localSpace ?? callout,
          "CUT_IDENTITY_FRAGMENT_GRAPH",
          `Callout ${callout.id} must retain one same-expansion, exact-interval LocalSpace child.`,
        );
      }
      exactComponentProvenance(fragment, localSpace);
      authenticatedNestedNodes.push(callout, localSpace);
      const ownerIds = visualAnchorOwnerIds(callout);
      if (ownerIds.length !== 1 || ownerIds[0] !== camera.id) {
        fail(
          callout,
          "CUT_IDENTITY_FRAGMENT_GRAPH",
          `Callout visualAnchor must reference only same-fragment slot camera ${camera.id}.`,
        );
      }
    }
  }
  const provenanceIdentity = hash({
    // Spans remain mandatory for graph authentication and diagnostics above,
    // but they are source formatting, not audiovisual semantics. Project only
    // stable module/symbol expansion roles into semantic and cache identity.
    fragment: semanticProvenance(fragment.provenance),
    children: children.map((child) =>
      semanticProvenance(child!.provenance)),
    authenticatedNestedNodes: authenticatedNestedNodes.map((node) => Object.freeze({
      nodeId: node.id,
      op: node.op,
      contentHash: node.contentHash,
      provenance: semanticProvenance(node.provenance),
    })),
  });
  const structuralReceipt = Object.freeze({
    algorithmVersion: referenceIdentityComponentFragmentAlgorithmVersion,
    compositionId: composition.id,
    sceneId: scene.id,
    fragmentNodeId: fragment.id,
    fragmentContentHash: fragment.contentHash,
    rootSourceOrder,
    childNodeIds: Object.freeze([...fragment.children]),
    childContent: Object.freeze(children.map((child, childIndex) => Object.freeze({
      childIndex,
      nodeId: child!.id,
      op: child!.op,
      contentHash: child!.contentHash,
    }))),
    stackNodeId: stack.id,
    slotNodeId: slot.id,
    cameraNodeId: camera.id,
    ...(path ? { pathNodeId: path.id } : {}),
    ...(layer ? { calloutLayerNodeId: layer.id } : {}),
    calloutNodeIds: Object.freeze(layer ? [...layer.children] : []),
    provenanceIdentity,
  });
  const semanticIdentity = hash(structuralReceipt);
  return Object.freeze({
    algorithmVersion: referenceIdentityComponentFragmentAlgorithmVersion,
    compositionId: composition.id,
    sceneId: scene.id,
    fragmentNodeId: fragment.id,
    fragmentContentHash: fragment.contentHash,
    rootSourceOrder,
    childNodeIds: Object.freeze([...fragment.children]),
    childContent: Object.freeze(children.map((child) => Object.freeze({
      nodeId: child!.id,
      op: child!.op,
      contentHash: child!.contentHash,
    }))),
    stackNodeId: stack.id,
    slotNodeId: slot.id,
    cameraNodeId: camera.id,
    ...(path ? { pathNodeId: path.id } : {}),
    ...(layer ? { calloutLayerNodeId: layer.id } : {}),
    calloutNodeIds: Object.freeze(layer ? [...layer.children] : []),
    provenanceIdentity,
    cacheIdentity: hash({
      kind: "identity-component-fragment-cache",
      structuralIdentity: semanticIdentity,
    }),
    semanticIdentity,
  });
}

export function validateReferenceIdentityComponentFragments(
  ir: CutAVIR,
  composition: IRComposition,
  selectedNodeIds?: ReadonlySet<string>,
  admissionIndex = createReferenceComponentFragmentLocalSpaceAdmissionIndex(ir),
) {
  const result = new Map<string, ReferenceIdentityComponentFragmentConfig>();
  for (const fragment of Object.values(ir.nodes)) {
    if (!selectedNode(selectedNodeIds, fragment.id) || !relevantFragment(fragment, ir)) continue;
    const config = validateOne(ir, composition, fragment, admissionIndex);
    result.set(fragment.id, config);
  }
  return result;
}

export function referenceIdentityComponentFragmentForChild(
  configs: ReadonlyMap<string, ReferenceIdentityComponentFragmentConfig>,
  childNodeId: string,
) {
  const matches = [...configs.values()].filter((config) =>
    config.childNodeIds.includes(childNodeId));
  if (matches.length > 1) {
    throw new Error(
      `CUT_IDENTITY_FRAGMENT_GRAPH: child ${childNodeId} belongs to ${matches.length} admitted identity fragments.`,
    );
  }
  return matches[0];
}

export function referenceIdentityComponentFragmentChildBinding(
  config: ReferenceIdentityComponentFragmentConfig,
  childNodeId: string,
): ReferenceIdentityComponentFragmentChildBinding {
  const childIndex = config.childNodeIds.indexOf(childNodeId);
  if (childIndex < 0) {
    throw new Error(
      `CUT_IDENTITY_FRAGMENT_GRAPH: child ${childNodeId} is not in admitted fragment ${config.fragmentNodeId}.`,
    );
  }
  const receipt = Object.freeze({
    fragmentNodeId: config.fragmentNodeId,
    fragmentSemanticIdentity: config.semanticIdentity,
    fragmentCacheIdentity: config.cacheIdentity,
    rootSourceOrder: config.rootSourceOrder,
    childIndex,
    childNodeId,
  });
  return Object.freeze({
    ...receipt,
    executionPathIdentity: hash({
      kind: "identity-component-fragment-execution-path",
      compositionId: config.compositionId,
      ...receipt,
    }),
  });
}

export function assertReferenceIdentityComponentFragmentFresh(
  ir: CutAVIR,
  composition: IRComposition,
  scene: IRScene,
  config: ReferenceIdentityComponentFragmentConfig,
  admissionIndex = createReferenceComponentFragmentLocalSpaceAdmissionIndex(ir),
) {
  const fragment = ir.nodes[config.fragmentNodeId];
  if (!fragment || fragment.sceneId !== scene.id || config.compositionId !== composition.id) {
    throw new Error(
      `CUT_IDENTITY_FRAGMENT_GRAPH: admitted fragment ${config.fragmentNodeId} is missing or belongs to a foreign active scene/composition.`,
    );
  }
  const fresh = validateOne(ir, composition, fragment, admissionIndex);
  if (fresh.semanticIdentity !== config.semanticIdentity
    || fresh.cacheIdentity !== config.cacheIdentity) {
    fail(
      fragment,
      "CUT_IDENTITY_FRAGMENT_GRAPH",
      "structure, provenance, content, order, or ownership changed after admission.",
    );
  }
  return fresh;
}

type ReferenceIdentityComponentFragmentRenderedChild = Readonly<{
  nodeId: string;
  op: string;
  contentHash: string;
  outputRgbaSha256: string;
}>;

type ReferenceIdentityComponentFragmentCameraReceipt = Readonly<{
  cameraNodeId: string;
  exactTime: Rational;
  outputFrame: string;
  executionIdentity: string;
}>;

type ReferenceIdentityComponentFragmentStackReceipt = Readonly<{
  nodeId: string;
  exactTime: Rational;
  outputFrame: string;
  executionIdentity: string;
}>;

type ReferenceIdentityComponentFragmentPathReceipt = Readonly<{
  consumerNodeId: string;
  exactTime: Rational;
  outputFrame?: string;
  executionIdentity: string;
  evidenceIdentity: string;
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
}>;

type ReferenceIdentityComponentFragmentCalloutReceipt = Readonly<{
  layerNodeId: string;
  exactTime: Rational;
  outputFrame: string;
  executionIdentity: string;
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
  decisions: readonly Readonly<{ nodeId: string }>[];
}>;

type ReferenceIdentityComponentFragmentLinkReceipt = Readonly<{
  consumerNodeId: string;
  ownerCameraNodeId: string;
  responsiveStackNodeId: string;
  exactTime: Rational;
  outputFrame: string;
  linkIdentity: string;
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
}>;

export type ReferenceIdentityComponentFragmentFrameInput = Readonly<{
  config: ReferenceIdentityComponentFragmentConfig;
  exactTime: Rational;
  outputFrame: string;
  children: readonly ReferenceIdentityComponentFragmentRenderedChild[];
  cameras: readonly ReferenceIdentityComponentFragmentCameraReceipt[];
  responsiveStacks: readonly ReferenceIdentityComponentFragmentStackReceipt[];
  anchoredPaths: readonly ReferenceIdentityComponentFragmentPathReceipt[];
  calloutLayers: readonly ReferenceIdentityComponentFragmentCalloutReceipt[];
  slotMediaAnchorLinks: readonly ReferenceIdentityComponentFragmentLinkReceipt[];
  sceneOutputRgbaSha256: string;
}>;

function sameTime(left: Rational, right: Rational) {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;

function frameFail(detail: string): never {
  throw new Error(`CUT_IDENTITY_FRAGMENT_EVIDENCE: ${detail}`);
}

function sameFragmentBinding(
  binding: ReferenceIdentityComponentFragmentChildBinding | undefined,
  config: ReferenceIdentityComponentFragmentConfig,
  childNodeId: string,
) {
  if (!binding) return false;
  const expected = referenceIdentityComponentFragmentChildBinding(config, childNodeId);
  return hash(binding) === hash(expected);
}

/**
 * Cross-bind one exact transparent fragment dispatch to the independently
 * completed camera, layout, anchor, Callout and slot-link ledgers. The
 * fragment owns only ordered dispatch: every wrapper raster/work count is
 * statically zero.
 */
export function referenceIdentityComponentFragmentFrameEvidence(
  input: ReferenceIdentityComponentFragmentFrameInput,
): ReferenceIdentityComponentFragmentFrameEvidence {
  const { config } = input;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(input.outputFrame)) {
    frameFail(`fragment ${config.fragmentNodeId} outputFrame is not canonical.`);
  }
  if (!sha256Pattern.test(input.sceneOutputRgbaSha256)) {
    frameFail(`fragment ${config.fragmentNodeId} scene output hash is not SHA-256.`);
  }
  if (input.children.length !== config.childNodeIds.length) {
    frameFail(`fragment ${config.fragmentNodeId} dispatched ${input.children.length} children; expected ${config.childNodeIds.length}.`);
  }
  const children = Object.freeze(input.children.map((child, index) => {
    if (child.nodeId !== config.childNodeIds[index]
      || !sha256Pattern.test(child.contentHash)
      || !sha256Pattern.test(child.outputRgbaSha256)) {
      frameFail(`fragment ${config.fragmentNodeId} child ${index} contradicts its admitted source order, content, or output hash.`);
    }
    return Object.freeze({
      index,
      nodeId: child.nodeId,
      op: child.op,
      contentHash: child.contentHash,
      cacheIdentity: hash({
        kind: "identity-component-fragment-child-cache",
        fragmentCacheIdentity: config.cacheIdentity,
        index,
        nodeId: child.nodeId,
        contentHash: child.contentHash,
      }),
      outputRgbaSha256: child.outputRgbaSha256,
    });
  }));
  const cameras = input.cameras.filter((receipt) =>
    receipt.cameraNodeId === config.cameraNodeId
    && receipt.outputFrame === input.outputFrame
    && sameTime(receipt.exactTime, input.exactTime));
  const stacks = input.responsiveStacks.filter((receipt) =>
    receipt.nodeId === config.stackNodeId
    && receipt.outputFrame === input.outputFrame
    && sameTime(receipt.exactTime, input.exactTime));
  if (cameras.length !== 1 || stacks.length !== 1) {
    frameFail(`fragment ${config.fragmentNodeId} requires exactly one same-frame camera and ResponsiveStack execution.`);
  }
  const fragmentPaths = input.anchoredPaths.filter((receipt) =>
    receipt.identityComponentFragment?.fragmentNodeId === config.fragmentNodeId);
  const expectedPaths = config.pathNodeId ? 1 : 0;
  if (fragmentPaths.length !== expectedPaths
    || (config.pathNodeId !== undefined
      && (fragmentPaths[0]?.consumerNodeId !== config.pathNodeId
        || fragmentPaths[0].outputFrame !== input.outputFrame
        || !sameTime(fragmentPaths[0].exactTime, input.exactTime)
        || !sameFragmentBinding(
          fragmentPaths[0].identityComponentFragment,
          config,
          config.pathNodeId,
        )))) {
    frameFail(`fragment ${config.fragmentNodeId} anchored Path receipt set is incomplete or cross-bound.`);
  }
  const fragmentCallouts = input.calloutLayers.filter((receipt) =>
    receipt.identityComponentFragment?.fragmentNodeId === config.fragmentNodeId);
  const expectedCallouts = config.calloutLayerNodeId ? 1 : 0;
  if (fragmentCallouts.length !== expectedCallouts
    || (config.calloutLayerNodeId !== undefined
      && (fragmentCallouts[0]?.layerNodeId !== config.calloutLayerNodeId
        || fragmentCallouts[0].outputFrame !== input.outputFrame
        || !sameTime(fragmentCallouts[0].exactTime, input.exactTime)
        || !sameFragmentBinding(
          fragmentCallouts[0].identityComponentFragment,
          config,
          config.calloutLayerNodeId,
        )))) {
    frameFail(`fragment ${config.fragmentNodeId} CalloutLayer receipt set is incomplete or cross-bound.`);
  }
  if (fragmentCallouts.length
    && hash(fragmentCallouts[0]!.decisions.map((decision) => decision.nodeId).sort())
      !== hash([...config.calloutNodeIds].sort())) {
    frameFail(`fragment ${config.fragmentNodeId} CalloutLayer receipt does not cover its exact admitted Callout set.`);
  }
  const permittedConsumers = new Set<string>([
    ...(config.pathNodeId ? [config.pathNodeId] : []),
    ...config.calloutNodeIds,
  ]);
  const links = input.slotMediaAnchorLinks.filter((receipt) =>
    receipt.identityComponentFragment?.fragmentNodeId === config.fragmentNodeId);
  for (const link of links) {
    if (!permittedConsumers.has(link.consumerNodeId)
      || link.ownerCameraNodeId !== config.cameraNodeId
      || link.responsiveStackNodeId !== config.stackNodeId
      || link.outputFrame !== input.outputFrame
      || !sameTime(link.exactTime, input.exactTime)
      || !link.identityComponentFragment
      || link.identityComponentFragment.fragmentSemanticIdentity !== config.semanticIdentity
      || link.identityComponentFragment.fragmentCacheIdentity !== config.cacheIdentity) {
      frameFail(`fragment ${config.fragmentNodeId} contains a foreign or stale slot-camera anchor link.`);
    }
  }
  const structuralIdentity = config.semanticIdentity;
  const executionPath = Object.freeze([Object.freeze({
    compositionId: config.compositionId,
    fragmentNodeId: config.fragmentNodeId,
    structuralIdentity,
  })]);
  const body = Object.freeze({
    format: "cut-reference-identity-component-fragment-frame" as const,
    version: 1 as const,
    algorithmVersion: referenceIdentityComponentFragmentExecutionAlgorithmVersion,
    compositionId: config.compositionId,
    sceneId: config.sceneId,
    fragmentNodeId: config.fragmentNodeId,
    exactTime: Object.freeze({ ...input.exactTime }),
    outputFrame: input.outputFrame,
    fragmentContentHash: config.fragmentContentHash,
    structuralIdentity,
    cacheIdentity: config.cacheIdentity,
    rootSourceOrder: config.rootSourceOrder,
    children,
    cameraExecutions: Object.freeze(cameras.map((receipt) => Object.freeze({
      nodeId: receipt.cameraNodeId,
      executionIdentity: receipt.executionIdentity,
    }))),
    responsiveStackExecutions: Object.freeze(stacks.map((receipt) => Object.freeze({
      nodeId: receipt.nodeId,
      executionIdentity: receipt.executionIdentity,
    }))),
    anchoredPathExecutions: Object.freeze(fragmentPaths.map((receipt) => Object.freeze({
      nodeId: receipt.consumerNodeId,
      executionIdentity: receipt.executionIdentity,
      evidenceIdentity: receipt.evidenceIdentity,
    }))),
    calloutLayerExecutions: Object.freeze(fragmentCallouts.map((receipt) => Object.freeze({
      nodeId: receipt.layerNodeId,
      executionIdentity: receipt.executionIdentity,
    }))),
    slotMediaAnchorLinks: Object.freeze(links.map((receipt) => Object.freeze({
      consumerNodeId: receipt.consumerNodeId,
      linkIdentity: receipt.linkIdentity,
    })).sort((left, right) =>
      left.consumerNodeId.localeCompare(right.consumerNodeId)
      || left.linkIdentity.localeCompare(right.linkIdentity))),
    executionPath,
    work: Object.freeze({
      childDispatches: children.length,
      wrapperRasterMaterializations: 0 as const,
      wrapperCanvasAllocations: 0 as const,
      wrapperTransforms: 0 as const,
      wrapperClips: 0 as const,
      wrapperGeometricResamples: 0 as const,
    }),
    sceneOutputRgbaSha256: input.sceneOutputRgbaSha256,
  });
  return validateReferenceIdentityComponentFragmentFrameEnvelope(
    Object.freeze({ ...body, executionIdentity: hash(body) }),
    config,
  );
}

/**
 * Validate the fragment receipt's closed envelope and admitted structure.
 *
 * This deliberately does not claim cross-ledger authentication. Persisted or
 * externally supplied evidence must additionally pass
 * `validateReferenceIdentityComponentFragmentFrameEvidence`, which binds this
 * envelope to the complete camera/stack/path/Callout/slot-anchor ledgers.
 */
export function validateReferenceIdentityComponentFragmentFrameEnvelope(
  evidence: ReferenceIdentityComponentFragmentFrameEvidence,
  config: ReferenceIdentityComponentFragmentConfig,
) {
  if (evidence.format !== "cut-reference-identity-component-fragment-frame"
    || evidence.version !== 1
    || evidence.algorithmVersion !== referenceIdentityComponentFragmentExecutionAlgorithmVersion
    || !/^(?:0|[1-9][0-9]*)$/u.test(evidence.outputFrame)
    || !sha256Pattern.test(evidence.fragmentContentHash)
    || !sha256Pattern.test(evidence.structuralIdentity)
    || !sha256Pattern.test(evidence.cacheIdentity)
    || !sha256Pattern.test(evidence.sceneOutputRgbaSha256)) {
    frameFail("receipt header, frame index, or digest is outside the closed v1 contract.");
  }
  if (evidence.children.length < 2
    || evidence.children.length > 3
    || evidence.work.childDispatches !== evidence.children.length
    || evidence.work.wrapperRasterMaterializations !== 0
    || evidence.work.wrapperCanvasAllocations !== 0
    || evidence.work.wrapperTransforms !== 0
    || evidence.work.wrapperClips !== 0
    || evidence.work.wrapperGeometricResamples !== 0) {
    frameFail(`fragment ${evidence.fragmentNodeId} wrapper work or child dispatch count is contradictory.`);
  }
  for (const [index, child] of evidence.children.entries()) {
    const expectedCacheIdentity = hash({
      kind: "identity-component-fragment-child-cache",
      fragmentCacheIdentity: evidence.cacheIdentity,
      index,
      nodeId: child.nodeId,
      contentHash: child.contentHash,
    });
    if (child.index !== index
      || child.cacheIdentity !== expectedCacheIdentity
      || !sha256Pattern.test(child.contentHash)
      || !sha256Pattern.test(child.outputRgbaSha256)) {
      frameFail(`fragment ${evidence.fragmentNodeId} child ${index} cache/output receipt is contradictory.`);
    }
  }
  if (evidence.executionPath.length !== 1
    || evidence.executionPath[0]?.compositionId !== evidence.compositionId
    || evidence.executionPath[0]?.fragmentNodeId !== evidence.fragmentNodeId
    || evidence.executionPath[0]?.structuralIdentity !== evidence.structuralIdentity) {
    frameFail(`fragment ${evidence.fragmentNodeId} execution path is not its exact composition-space structural scope.`);
  }
  if (evidence.compositionId !== config.compositionId
      || evidence.sceneId !== config.sceneId
      || evidence.fragmentNodeId !== config.fragmentNodeId
      || evidence.fragmentContentHash !== config.fragmentContentHash
      || evidence.structuralIdentity !== config.semanticIdentity
      || evidence.cacheIdentity !== config.cacheIdentity
      || evidence.rootSourceOrder !== config.rootSourceOrder
      || hash(evidence.children.map(({ nodeId, op, contentHash }) =>
        ({ nodeId, op, contentHash }))) !== hash(config.childContent)
      || evidence.cameraExecutions.length !== 1
      || evidence.cameraExecutions[0]?.nodeId !== config.cameraNodeId
      || evidence.responsiveStackExecutions.length !== 1
      || evidence.responsiveStackExecutions[0]?.nodeId !== config.stackNodeId
      || evidence.anchoredPathExecutions.length !== (config.pathNodeId ? 1 : 0)
      || (config.pathNodeId !== undefined
        && evidence.anchoredPathExecutions[0]?.nodeId !== config.pathNodeId)
      || evidence.calloutLayerExecutions.length !== (config.calloutLayerNodeId ? 1 : 0)
      || (config.calloutLayerNodeId !== undefined
        && evidence.calloutLayerExecutions[0]?.nodeId !== config.calloutLayerNodeId)
      || evidence.slotMediaAnchorLinks.some((link) =>
        link.consumerNodeId !== config.pathNodeId
        && !config.calloutNodeIds.includes(link.consumerNodeId))) {
    frameFail(`fragment ${evidence.fragmentNodeId} receipt contradicts its admitted structural configuration.`);
  }
  for (const receipt of [
    ...evidence.cameraExecutions,
    ...evidence.responsiveStackExecutions,
    ...evidence.anchoredPathExecutions,
    ...evidence.calloutLayerExecutions,
  ]) {
    if (!sha256Pattern.test(receipt.executionIdentity)) {
      frameFail(`fragment ${evidence.fragmentNodeId} references a malformed child execution identity.`);
    }
  }
  if (evidence.anchoredPathExecutions.some((receipt) =>
    !sha256Pattern.test(receipt.evidenceIdentity))
    || evidence.slotMediaAnchorLinks.some((receipt) =>
      !sha256Pattern.test(receipt.linkIdentity))) {
    frameFail(`fragment ${evidence.fragmentNodeId} references a malformed anchor evidence identity.`);
  }
  const { executionIdentity, ...body } = evidence;
  if (hash(body) !== executionIdentity) {
    frameFail(`fragment ${evidence.fragmentNodeId} executionIdentity does not authenticate its complete receipt.`);
  }
  return evidence;
}

export function referenceIdentityComponentFragmentInspect(
  config: ReferenceIdentityComponentFragmentConfig,
) {
  return Object.freeze({
    status: "public-identity-composition-scope" as const,
    algorithmVersion: config.algorithmVersion,
    fragmentNodeId: config.fragmentNodeId,
    sceneId: config.sceneId,
    rootSourceOrder: config.rootSourceOrder,
    orderedChildren: config.childNodeIds,
    orderedChildContent: config.childContent,
    stackNodeId: config.stackNodeId,
    slotNodeId: config.slotNodeId,
    cameraNodeId: config.cameraNodeId,
    ...(config.pathNodeId ? { pathNodeId: config.pathNodeId } : {}),
    ...(config.calloutLayerNodeId
      ? { calloutLayerNodeId: config.calloutLayerNodeId }
      : {}),
    calloutNodeIds: config.calloutNodeIds,
    execution: Object.freeze({
      coordinateSpace: "composition" as const,
      wrapperRasterMaterializations: 0 as const,
      wrapperCanvasAllocations: 0 as const,
      wrapperTransforms: 0 as const,
      wrapperClips: 0 as const,
      wrapperGeometricResamples: 0 as const,
      childDispatch: "ordered-scene-layers" as const,
    }),
    cacheIdentity: config.cacheIdentity,
    semanticIdentity: config.semanticIdentity,
  });
}
