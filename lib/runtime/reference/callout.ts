import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  rational,
  rationalToNumber,
  type Rational,
} from "../../language/rational";
import {
  decodeReferenceSpatialPointGeometry,
  resolveReferenceAnchoredPathGeometryAt,
  validateReferenceAnchoredPathGeometry,
  type ReferenceAnchoredPathAnchorEvidence,
  type ReferenceAnchoredPathOwnerResolution,
  type ReferenceAnchoredPathPolicyHiddenResolution,
  type ReferenceValidatedAnchoredPathGeometry,
} from "./anchored-path";
import {
  referenceCalloutLayoutAlgorithmVersion,
  referenceCalloutLayoutLimits,
  referenceCalloutRectsCollide,
  resolveReferenceCalloutLayout,
  type ReferenceCalloutCandidate,
  type ReferenceCalloutHiddenReason,
  type ReferenceCalloutLeader,
  type ReferenceCalloutLeaderKind,
  type ReferenceCalloutPlacement,
  type ReferenceCalloutRect,
} from "./callout-layout";
import type { ReferenceLocalSpaceConfig } from "./local-space";
import type { ReferenceMediaCamera2DPlan } from "./media-camera2d";
import { propertyAt } from "./signals";
import {
  referenceIdentityComponentFragmentChildBinding,
  referenceIdentityComponentFragmentForChild,
  validateReferenceIdentityComponentFragments,
  type ReferenceIdentityComponentFragmentChildBinding,
  type ReferenceIdentityComponentFragmentConfig,
} from "./identity-component-fragment";

export const referenceCalloutAlgorithmVersion = "cut-reference-callout-v1" as const;

export const referenceCalloutLimits = Object.freeze({
  maximumCalloutsPerLayer: referenceCalloutLayoutLimits.maximumEntries,
  maximumCalloutsPerComposition: 128,
  maximumAbsolutePriority: 1_000_000,
  maximumAbsoluteDeliveryLengthPx: 65_536,
});

export type ReferenceCalloutErrorCode =
  | "CUT_CALLOUT_TYPE"
  | "CUT_CALLOUT_GRAPH"
  | "CUT_CALLOUT_ANCHOR"
  | "CUT_CALLOUT_VIEWPORT"
  | "CUT_CALLOUT_LAYOUT"
  | "CUT_CALLOUT_STYLE"
  | "CUT_CALLOUT_LIMIT"
  | "CUT_CALLOUT_NOOP";

export class ReferenceCalloutError extends Error {
  readonly source: Readonly<{
    module: string;
    line: number;
    column: number;
    nodeId: string;
  }>;

  constructor(
    readonly code: ReferenceCalloutErrorCode,
    readonly node: IRNode,
    detail: string,
    readonly execution?: Readonly<{ time: Rational; frame?: bigint }>,
  ) {
    const { module, span } = node.provenance;
    const exact = execution
      ? ` at exact time ${execution.time.numerator}/${execution.time.denominator}s${execution.frame === undefined ? "" : ` (output frame ${execution.frame})`}`
      : "";
    super(`${code}: Callout at ${module}:${span.start.line}:${span.start.column} ${detail}${exact}`);
    this.name = "ReferenceCalloutError";
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
  code: ReferenceCalloutErrorCode,
  detail: string,
  execution?: Readonly<{ time: Rational; frame?: bigint }>,
): never {
  throw new ReferenceCalloutError(code, node, detail, execution);
}

function isSourceLocatedStableError(error: unknown): error is Error & Readonly<{
  code: string;
  source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;
}> {
  if (!(error instanceof Error)) return false;
  const candidate = error as {
    code?: unknown;
    source?: { module?: unknown; line?: unknown; column?: unknown; nodeId?: unknown };
  };
  return typeof candidate.code === "string"
    && typeof candidate.source?.module === "string"
    && typeof candidate.source.line === "number"
    && typeof candidate.source.column === "number"
    && typeof candidate.source.nodeId === "string";
}

export type ReferenceCalloutConfig = Readonly<{
  nodeId: string;
  localSpaceNodeId: string;
  localSpaceSemanticIdentity: string;
  width: number;
  height: number;
  anchor: ReferenceValidatedAnchoredPathGeometry;
  placements: readonly ReferenceCalloutPlacement[];
  offset: number;
  safeArea: number;
  priority: number;
  priorityAuthored: boolean;
  leader: ReferenceCalloutLeaderKind;
  leaderColor?: string;
  leaderWidth?: number;
  semanticIdentity: string;
}>;

export type ReferenceCalloutBinding = Readonly<{
  config: ReferenceCalloutConfig;
  sourceOrder: readonly number[];
}>;

export type ReferenceCalloutLayerConfig = Readonly<{
  nodeId: string;
  sceneId: string;
  sourceOrder: number;
  structuralSourceOrder: readonly number[];
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
  callouts: readonly ReferenceCalloutBinding[];
  semanticIdentity: string;
}>;

export type ReferenceCalloutOwnerResolver = (
  consumer: IRNode,
  anchor: ReferenceValidatedAnchoredPathGeometry,
  ownerNodeId: string,
  exactTime: Rational,
) => ReferenceAnchoredPathOwnerResolution;

export type ReferenceCalloutDecision = Readonly<{
  nodeId: string;
  localSpaceNodeId: string;
  calloutSemanticIdentity: string;
  localSpaceSemanticIdentity: string;
  opacitySourceIdentity: string;
  opacitySampleIdentity: string;
  sourceOrder: readonly number[];
  priority: number;
  resolutionOrder: number;
  paintOrder?: number;
  opacity: number;
  status: "accepted" | "hidden";
  reason?: ReferenceCalloutHiddenReason | "owner-policy-hidden";
  exactAnchor?: Readonly<{ x: number; y: number }>;
  candidates: readonly ReferenceCalloutCandidate[];
  chosenPlacement?: ReferenceCalloutPlacement;
  chosenPlacementIndex?: number;
  rect?: ReferenceCalloutRect;
  leader?: ReferenceCalloutLeader;
  anchorExecutionIdentity?: string;
  anchors?: readonly ReferenceAnchoredPathAnchorEvidence[];
  suppressedBy?: ReferenceAnchoredPathPolicyHiddenResolution["suppressedBy"];
}>;

export type ReferenceCalloutFramePlan = Readonly<{
  format: "cut-reference-callout-frame-decisions";
  version: 1;
  algorithmVersion: typeof referenceCalloutAlgorithmVersion;
  layoutAlgorithmVersion: typeof referenceCalloutLayoutAlgorithmVersion;
  compositionId: string;
  sceneId: string;
  exactTime: Rational;
  sceneLocalTime: Rational;
  outputFrame?: string;
  layerNodeId: string;
  layerSemanticIdentity: string;
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
  decisions: readonly ReferenceCalloutDecision[];
  resolutionOrder: readonly string[];
  paintOrder: readonly string[];
  work: Readonly<{
    activeCallouts: number;
    acceptedCallouts: number;
    anchorResolutions: number;
    ownerPolicySkips: number;
    candidateEvaluations: number;
    candidateCollisionTests: number;
    leaderSegments: number;
  }>;
  decisionIdentity: string;
}>;

export type ReferenceCalloutVisibleAlpha = Readonly<{
  sourceVisiblePixels: number;
  sourceMaximum: number;
  visiblePixels: number;
  maximum: number;
}>;

type ReferenceCalloutRenderedDecisionBase = Readonly<{
  sourceVisiblePixels: number;
  sourceMaximum: number;
  tile: Readonly<{
    tileIdentity: string;
    admittedPlacementIdentity: string;
    affinePlanIdentity: string;
    transformWorkIdentity: string;
    width: number;
    height: number;
    rgbaSha256: string;
  }>;
}>;

export type ReferenceCalloutRenderedDecision =
  | (ReferenceCalloutRenderedDecisionBase & Readonly<{
    status: "painted";
    maximumQuantizedAlpha: number;
    overlayRgbaSha256: string;
    work: Readonly<{
      calloutOverlayPlacements: 1;
      calloutOverlayComposites: 1;
      overlayCanvasPixels: number;
      overlayCanvasBytes: number;
    }>;
  }>)
  | (ReferenceCalloutRenderedDecisionBase & Readonly<{
    status: "opacity-quantized-transparent";
    maximumQuantizedAlpha: 0;
    work: Readonly<{
      calloutOverlayPlacements: 0;
      calloutOverlayComposites: 0;
      overlayCanvasPixels: 0;
      overlayCanvasBytes: 0;
    }>;
  }>);

export type ReferenceCalloutRenderedFrameEvidenceBody =
  Omit<ReferenceCalloutFramePlan, "decisions" | "work" | "outputFrame"> & Readonly<{
    outputFrame: string;
    decisions: readonly (ReferenceCalloutDecision & Readonly<{
      visibleAlpha?: ReferenceCalloutVisibleAlpha;
      renderedDecision?: ReferenceCalloutRenderedDecision;
    }>)[];
    executionPath: readonly Readonly<{
      compositionId: string;
      instanceNodeId?: string;
      sourceCompositionId?: string;
    }>[];
    outputRgbaSha256: string;
    work: ReferenceCalloutFramePlan["work"] & Readonly<{
      tileRequests: number;
      tilePixels: number;
      paintedCallouts: number;
      opacityQuantizedTransparentCallouts: number;
      leaderRasterizations: number;
      calloutOverlayPlacements: number;
      calloutOverlayComposites: number;
      layerSourceOverComposites: number;
      overlayCanvasPixels: number;
      overlayCanvasBytes: number;
    }>;
  }>;

export type ReferenceCalloutRenderedFrameEvidence =
  ReferenceCalloutRenderedFrameEvidenceBody & Readonly<{ executionIdentity: string }>;

export function referenceCalloutExecutionIdentity(
  receipt: ReferenceCalloutRenderedFrameEvidenceBody,
) {
  return hash({
    algorithm: referenceCalloutAlgorithmVersion,
    receipt,
  });
}

export class ReferenceCalloutFrameEvidenceError extends Error {
  readonly code = "CUT_CALLOUT_EVIDENCE" as const;

  constructor(readonly path: string, detail: string) {
    super(`CUT_CALLOUT_EVIDENCE: ${path} ${detail}`);
    this.name = "ReferenceCalloutFrameEvidenceError";
  }
}

function evidenceFail(path: string, detail: string): never {
  throw new ReferenceCalloutFrameEvidenceError(path, detail);
}

function sameEvidence(left: unknown, right: unknown) {
  return hash(left) === hash(right);
}

/** Rebuild every derivable Callout receipt invariant before publication or
 * persisted-current-profile acceptance. Pixel hashes remain opaque facts, but
 * the complete receipt identity binds them and the LocalSpace evidence layer
 * independently binds the admitted tile/placement/work identities. */
export function validateReferenceCalloutFrameEvidenceSemantics(
  evidence: ReferenceCalloutRenderedFrameEvidence,
) {
  if (evidence.format !== "cut-reference-callout-frame-decisions"
    || evidence.version !== 1
    || evidence.algorithmVersion !== referenceCalloutAlgorithmVersion
    || evidence.layoutAlgorithmVersion !== referenceCalloutLayoutAlgorithmVersion) {
    evidenceFail("$", "does not declare the closed Callout frame evidence contract.");
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(evidence.outputFrame)) {
    evidenceFail("$.outputFrame", "must be one canonical non-negative decimal frame index.");
  }
  if (evidence.decisions.length < 1
    || evidence.decisions.length > referenceCalloutLimits.maximumCalloutsPerLayer) {
    evidenceFail("$.decisions", `must contain 1 through ${referenceCalloutLimits.maximumCalloutsPerLayer} decisions.`);
  }
  const nodeIds = evidence.decisions.map((decision) => decision.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) {
    evidenceFail("$.decisions", "contains duplicate Callout node IDs.");
  }
  const fragment = evidence.identityComponentFragment;
  if (fragment) {
    const bindingReceipt = Object.freeze({
      fragmentNodeId: fragment.fragmentNodeId,
      fragmentSemanticIdentity: fragment.fragmentSemanticIdentity,
      fragmentCacheIdentity: fragment.fragmentCacheIdentity,
      rootSourceOrder: fragment.rootSourceOrder,
      childIndex: fragment.childIndex,
      childNodeId: fragment.childNodeId,
    });
    if (fragment.childNodeId !== evidence.layerNodeId
      || fragment.childIndex < 1
      || fragment.childIndex > 2
      || fragment.executionPathIdentity !== hash({
        kind: "identity-component-fragment-execution-path",
        compositionId: evidence.compositionId,
        ...bindingReceipt,
      })
      || evidence.decisions.some((decision) =>
        decision.sourceOrder.length !== 3
        || decision.sourceOrder[0] !== fragment.rootSourceOrder
        || decision.sourceOrder[1] !== fragment.childIndex)) {
      evidenceFail(
        "$.identityComponentFragment",
        "does not authenticate the exact fragment root, CalloutLayer child, and three-segment decision source order.",
      );
    }
  } else if (evidence.decisions.some((decision) => decision.sourceOrder.length !== 2)) {
    evidenceFail(
      "$.decisions",
      "direct-root Callout decisions require exactly two source-order segments.",
    );
  }
  const terminalSourceOrders = evidence.decisions.map(
    (decision) => decision.sourceOrder.at(-1),
  );
  if (terminalSourceOrders.some((value) =>
    value === undefined || !Number.isSafeInteger(value) || value < 0 || value > 63)
    || new Set(terminalSourceOrders).size !== terminalSourceOrders.length) {
    evidenceFail("$.decisions", "must retain one unique bounded terminal Callout source index.");
  }
  const expectedResolutionOrder = [...evidence.decisions]
    .sort((left, right) =>
      right.priority - left.priority || compareSourceOrder(left.sourceOrder, right.sourceOrder))
    .map((decision) => decision.nodeId);
  if (!sameEvidence(nodeIds, expectedResolutionOrder)
    || !sameEvidence(evidence.resolutionOrder, expectedResolutionOrder)) {
    evidenceFail("$.resolutionOrder", "must equal the complete priority/source resolution order.");
  }
  const accepted = evidence.decisions.filter((decision) => decision.status === "accepted");
  const expectedPaintOrder = [...accepted].reverse().map((decision) => decision.nodeId);
  if (!sameEvidence(evidence.paintOrder, expectedPaintOrder)) {
    evidenceFail("$.paintOrder", "must reverse accepted resolution order.");
  }
  const acceptedRects: Array<Readonly<{ nodeId: string; rect: ReferenceCalloutRect }>> = [];
  let candidateEvaluations = 0;
  let candidateCollisionTests = 0;
  let leaderSegments = 0;
  for (const [index, decision] of evidence.decisions.entries()) {
    const path = `$.decisions[${index}]`;
    if (decision.resolutionOrder !== index) {
      evidenceFail(`${path}.resolutionOrder`, "must equal its array position.");
    }
    if (!Number.isFinite(decision.opacity) || decision.opacity < 0 || decision.opacity > 1) {
      evidenceFail(`${path}.opacity`, "must be finite from 0 through 1.");
    }
    candidateEvaluations += decision.candidates.length;
    for (const [candidateIndex, candidate] of decision.candidates.entries()) {
      if (candidate.placementIndex !== candidateIndex) {
        evidenceFail(`${path}.candidates[${candidateIndex}].placementIndex`, "must equal deterministic candidate order.");
      }
      let collisionWith: string | undefined;
      if (candidate.safe) {
        for (const acceptedRect of acceptedRects) {
          candidateCollisionTests += 1;
          if (referenceCalloutRectsCollide(candidate.rect, acceptedRect.rect)) {
            collisionWith = acceptedRect.nodeId;
            break;
          }
        }
      }
      if (candidate.collisionWith !== collisionWith) {
        evidenceFail(`${path}.candidates[${candidateIndex}].collisionWith`, "does not match prior accepted half-open rectangles.");
      }
    }
    if (decision.status === "accepted") {
      if (decision.reason !== undefined
        || decision.opacity <= 0
        || decision.paintOrder === undefined
        || decision.paintOrder !== expectedPaintOrder.indexOf(decision.nodeId)
        || !decision.exactAnchor
        || !decision.anchorExecutionIdentity
        || !decision.anchors
        || decision.chosenPlacement === undefined
        || decision.chosenPlacementIndex === undefined
        || !decision.rect
        || !decision.renderedDecision) {
        evidenceFail(path, "accepted decision is missing its complete resolved, paint, or render state.");
      }
      const chosen = decision.candidates.at(-1);
      if (!chosen
        || !chosen.safe
        || chosen.collisionWith !== undefined
        || chosen.placement !== decision.chosenPlacement
        || chosen.placementIndex !== decision.chosenPlacementIndex
        || !sameEvidence(chosen.rect, decision.rect)) {
        evidenceFail(path, "accepted decision does not end at its first eligible candidate.");
      }
      if (decision.renderedDecision.tile.width !== decision.rect.width
        || decision.renderedDecision.tile.height !== decision.rect.height) {
        evidenceFail(`${path}.renderedDecision.tile`, "dimensions do not match the accepted layout rectangle.");
      }
      if (decision.renderedDecision.status === "painted") {
        if (!decision.visibleAlpha
          || decision.visibleAlpha.sourceVisiblePixels !== decision.renderedDecision.sourceVisiblePixels
          || decision.visibleAlpha.sourceMaximum !== decision.renderedDecision.sourceMaximum
          || decision.visibleAlpha.maximum !== decision.renderedDecision.maximumQuantizedAlpha
          || decision.visibleAlpha.visiblePixels < 1
          || decision.visibleAlpha.maximum < 1
          || decision.renderedDecision.work.overlayCanvasBytes
            !== decision.renderedDecision.work.overlayCanvasPixels * 4) {
          evidenceFail(`${path}.visibleAlpha`, "does not close over the painted overlay and its RGBA work.");
        }
      } else if (decision.visibleAlpha !== undefined
        || decision.renderedDecision.maximumQuantizedAlpha !== 0
        || decision.renderedDecision.work.calloutOverlayPlacements !== 0
        || decision.renderedDecision.work.calloutOverlayComposites !== 0
        || decision.renderedDecision.work.overlayCanvasPixels !== 0
        || decision.renderedDecision.work.overlayCanvasBytes !== 0) {
        evidenceFail(`${path}.renderedDecision`, "transparent quantization contradicts raster or alpha evidence.");
      }
      if (decision.leader) leaderSegments += decision.leader.vertices.length - 1;
      acceptedRects.push(Object.freeze({ nodeId: decision.nodeId, rect: decision.rect }));
      continue;
    }
    if (decision.paintOrder !== undefined
      || decision.chosenPlacement !== undefined
      || decision.chosenPlacementIndex !== undefined
      || decision.rect !== undefined
      || decision.leader !== undefined
      || decision.visibleAlpha !== undefined
      || decision.renderedDecision !== undefined) {
      evidenceFail(path, "hidden decision contains paint, geometry, or raster evidence.");
    }
    if (decision.reason === "opacity-zero") {
      if (decision.opacity !== 0
        || decision.candidates.length !== 0
        || decision.exactAnchor !== undefined
        || decision.anchorExecutionIdentity !== undefined
        || decision.anchors !== undefined
        || decision.suppressedBy !== undefined) {
        evidenceFail(path, "opacity-zero must carry zero anchor, layout, and raster work.");
      }
    } else if (decision.reason === "owner-policy-hidden") {
      if (decision.opacity <= 0
        || decision.candidates.length !== 0
        || decision.exactAnchor !== undefined
        || decision.anchors !== undefined
        || !decision.anchorExecutionIdentity
        || decision.suppressedBy?.length !== 1
        || decision.suppressedBy[0]?.ownerKind !== "track-2d") {
        evidenceFail(path, "owner-policy-hidden must contain exactly one causative Track2D suppression and no resolved geometry.");
      }
    } else if (decision.reason === "anchor-offscreen") {
      if (decision.opacity <= 0
        || decision.candidates.length !== 0
        || !decision.exactAnchor
        || !decision.anchorExecutionIdentity
        || !decision.anchors
        || decision.suppressedBy !== undefined) {
        evidenceFail(path, "anchor-offscreen must retain resolved anchor evidence and perform no candidate/raster work.");
      }
    } else if (decision.reason === "collision-overflow") {
      if (decision.opacity <= 0
        || decision.candidates.length < 1
        || !decision.exactAnchor
        || !decision.anchorExecutionIdentity
        || !decision.anchors
        || decision.suppressedBy !== undefined
        || decision.candidates.some((candidate) => candidate.safe && candidate.collisionWith === undefined)) {
        evidenceFail(path, "collision-overflow must retain only rejected candidates and no raster work.");
      }
    } else {
      evidenceFail(`${path}.reason`, "hidden decision has no supported reason.");
    }
  }
  const rendered = accepted.map((decision) => decision.renderedDecision!);
  const expectedWork = Object.freeze({
    activeCallouts: evidence.decisions.length,
    acceptedCallouts: accepted.length,
    anchorResolutions: evidence.decisions.filter((decision) => decision.exactAnchor !== undefined).length,
    ownerPolicySkips: evidence.decisions.filter((decision) => decision.reason === "owner-policy-hidden").length,
    candidateEvaluations,
    candidateCollisionTests,
    leaderSegments,
    tileRequests: rendered.length,
    tilePixels: rendered.reduce((total, decision) =>
      total + decision.tile.width * decision.tile.height, 0),
    paintedCallouts: rendered.filter((decision) => decision.status === "painted").length,
    opacityQuantizedTransparentCallouts: rendered.filter(
      (decision) => decision.status === "opacity-quantized-transparent",
    ).length,
    leaderRasterizations: accepted.filter(
      (decision) => decision.renderedDecision?.status === "painted" && decision.leader,
    ).length,
    calloutOverlayPlacements: rendered.reduce(
      (total, decision) => total + decision.work.calloutOverlayPlacements, 0),
    calloutOverlayComposites: rendered.reduce(
      (total, decision) => total + decision.work.calloutOverlayComposites, 0),
    layerSourceOverComposites: rendered.filter((decision) => decision.status === "painted").length,
    overlayCanvasPixels: rendered.reduce(
      (total, decision) => total + decision.work.overlayCanvasPixels, 0),
    overlayCanvasBytes: rendered.reduce(
      (total, decision) => total + decision.work.overlayCanvasBytes, 0),
  });
  if (!sameEvidence(evidence.work, expectedWork)) {
    evidenceFail("$.work", "does not equal work derivable from the complete decision set.");
  }
  const expectedDecisionIdentity = referenceCalloutDecisionIdentity(
    evidence.layerSemanticIdentity,
    evidence.sceneLocalTime,
    evidence.decisions,
  );
  if (evidence.decisionIdentity !== expectedDecisionIdentity) {
    evidenceFail("$.decisionIdentity", "does not bind the complete deterministic layout decision.");
  }
  const { executionIdentity, ...body } = evidence;
  if (executionIdentity !== referenceCalloutExecutionIdentity(body)) {
    evidenceFail("$.executionIdentity", "does not bind the complete rendered Callout receipt.");
  }
  return evidence;
}

function quantity(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  dimension: "length" | "ratio" | "scalar",
  minimum: number,
  maximum: number,
  code: ReferenceCalloutErrorCode = "CUT_CALLOUT_TYPE",
) {
  const unit = dimension === "length" ? "px" : dimension;
  if (value?.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail(node, code, `${label} must be one canonical ${dimension} quantity in ${unit}.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    fail(node, code, `${label} must be finite from ${minimum} through ${maximum}.`);
  }
  return Object.is(result, -0) ? 0 : result;
}

function wholeQuantity(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  dimension: "length" | "scalar",
  minimum: number,
  maximum: number,
  code: ReferenceCalloutErrorCode = "CUT_CALLOUT_TYPE",
) {
  const result = quantity(node, value, label, dimension, minimum, maximum, code);
  if (!Number.isSafeInteger(result)) fail(node, code, `${label} must be a whole safe integer.`);
  return result;
}

function placements(node: IRNode): readonly ReferenceCalloutPlacement[] {
  const value = node.inputs.placements;
  if (value?.kind !== "array") {
    fail(node, "CUT_CALLOUT_TYPE", "input “placements” must be a List<String>.");
  }
  if (value.items.length < 1
    || value.items.length > referenceCalloutLayoutLimits.maximumPlacementsPerEntry) {
    fail(
      node,
      "CUT_CALLOUT_LIMIT",
      `input “placements” must contain 1 through ${referenceCalloutLayoutLimits.maximumPlacementsPerEntry} directions.`,
    );
  }
  const allowed = new Set<ReferenceCalloutPlacement>(["right", "above", "below", "left"]);
  const seen = new Set<string>();
  return Object.freeze(value.items.map((item, index) => {
    if (item.kind !== "string" || !allowed.has(item.value as ReferenceCalloutPlacement)) {
      fail(
        node,
        "CUT_CALLOUT_TYPE",
        `input “placements[${index}]” must be one of: right, above, below, left.`,
      );
    }
    if (seen.has(item.value)) {
      fail(
        node,
        "CUT_CALLOUT_NOOP",
        `input “placements[${index}]” duplicates “${item.value}” and can never execute.`,
      );
    }
    seen.add(item.value);
    return item.value as ReferenceCalloutPlacement;
  }));
}

function color(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value.value)) {
    fail(node, "CUT_CALLOUT_STYLE", `${label} must be a canonical six- or eight-digit CUT color.`);
  }
  if (value.value.length === 9 && value.value.slice(-2).toLowerCase() === "00") {
    fail(node, "CUT_CALLOUT_NOOP", `${label} cannot be fully transparent.`);
  }
  return value.value.toLowerCase();
}

function signalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [signal.value];
  if (signal.kind === "step") return signal.points.map((point) => point.value);
  if (signal.kind === "keyframes") return signal.keyframes.map((keyframe) => keyframe.value);
  return [
    signal.initial,
    ...signal.events.flatMap((event) =>
      event.kind === "set" ? [event.value] : [event.from, event.to]),
  ];
}

function validateOpacityValues(ir: CutAVIR, node: IRNode) {
  const baselineValue = node.inputs.opacity === undefined
    ? 1
    : quantity(node, node.inputs.opacity, "input “opacity”", "ratio", 0, 1);
  const property = node.properties.opacity;
  if (property === undefined) {
    if (node.inputs.opacity !== undefined) {
      if (baselineValue === 0) {
        fail(
          node,
          "CUT_CALLOUT_NOOP",
          "static opacity 0% hides the callout for its complete interval.",
        );
      }
      if (baselineValue === 1) {
        fail(
          node,
          "CUT_CALLOUT_NOOP",
          "explicit opacity 100% repeats the default without an executing property signal; omit it.",
        );
      }
    }
    return;
  }
  const values = "signal" in property
    ? (() => {
      const signal = ir.signals[property.signal];
      if (!signal) {
        fail(
          node,
          "CUT_CALLOUT_TYPE",
          `property “opacity” references missing signal ${property.signal}.`,
        );
      }
      if (signal.valueType !== "Ratio") {
        fail(
          node,
          "CUT_CALLOUT_TYPE",
          `property “opacity” signal ${signal.id} must declare valueType Ratio.`,
        );
      }
      return signalValues(signal);
    })()
    : [property];
  const effectiveValues: number[] = [];
  for (const value of values) {
    effectiveValues.push(value.kind === "null"
      ? baselineValue
      : quantity(node, value, "property “opacity” value", "ratio", 0, 1));
  }
  if (effectiveValues.length > 0 && effectiveValues.every((value) => value === 0)) {
    fail(
      node,
      "CUT_CALLOUT_NOOP",
      "property “opacity” is demonstrably 0% for every authored state and hides the callout for its complete interval.",
    );
  }
  if (effectiveValues.length > 0 && effectiveValues.every((value) => value === 1)) {
    fail(
      node,
      "CUT_CALLOUT_NOOP",
      "property “opacity” is demonstrably 100% for every authored state and repeats the runtime default.",
    );
  }
}

function intervalsEqual(left: IRNode, right: IRNode) {
  return compareRational(left.interval.start, right.interval.start) === 0
    && compareRational(left.interval.duration, right.interval.duration) === 0;
}

function intervalContains(parent: IRNode, child: IRNode) {
  return compareRational(child.interval.start, parent.interval.start) >= 0
    && compareRational(
      addRational(child.interval.start, child.interval.duration),
      addRational(parent.interval.start, parent.interval.duration),
    ) <= 0;
}

function active(node: IRNode, time: Rational) {
  return compareRational(time, node.interval.start) >= 0
    && compareRational(time, addRational(node.interval.start, node.interval.duration)) < 0;
}

function parentIndex(ir: CutAVIR) {
  const parents = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) {
    for (const childId of parent.children) {
      const values = parents.get(childId) ?? [];
      values.push(parent);
      parents.set(childId, values);
    }
  }
  return parents;
}

function rootMembership(ir: CutAVIR, nodeId: string) {
  let count = 0;
  for (const composition of ir.compositions) {
    count += composition.items.filter((item) => item.kind === "node" && item.id === nodeId).length;
  }
  for (const scene of Object.values(ir.scenes)) {
    count += scene.items.filter((item) => item.id === nodeId).length;
  }
  return count;
}

function calloutStaticFields(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  localSpace: ReferenceLocalSpaceConfig,
) {
  const allowedInputs = new Set([
    "anchor",
    "placements",
    "offset",
    "safeArea",
    "priority",
    "leader",
    "leaderColor",
    "leaderWidth",
    "opacity",
  ]);
  const unknownInput = Object.keys(node.inputs).find((name) => !allowedInputs.has(name));
  if (unknownInput !== undefined) {
    fail(
      node,
      "CUT_CALLOUT_TYPE",
      `input “${unknownInput}” is not part of the closed public contract.`,
    );
  }
  const unknownProperty = Object.keys(node.properties).find((name) => name !== "opacity");
  if (unknownProperty !== undefined) {
    fail(
      node,
      "CUT_CALLOUT_TYPE",
      `property “${unknownProperty}” is not part of the closed public contract.`,
    );
  }
  if (node.domain !== "visual") {
    fail(node, "CUT_CALLOUT_GRAPH", `must have visual domain, found ${node.domain}.`);
  }
  const offset = quantity(
    node,
    node.inputs.offset,
    "input “offset”",
    "length",
    Number.MIN_VALUE,
    referenceCalloutLimits.maximumAbsoluteDeliveryLengthPx,
    "CUT_CALLOUT_LAYOUT",
  );
  const safeArea = quantity(
    node,
    node.inputs.safeArea,
    "input “safeArea”",
    "length",
    0,
    Math.min(composition.width, composition.height) / 2,
    "CUT_CALLOUT_LAYOUT",
  );
  if (composition.width - 2 * safeArea <= 0 || composition.height - 2 * safeArea <= 0) {
    fail(
      node,
      "CUT_CALLOUT_VIEWPORT",
      "input “safeArea” leaves no positive half-open delivery rectangle.",
    );
  }
  if (localSpace.width > composition.width - 2 * safeArea
    || localSpace.height > composition.height - 2 * safeArea) {
    fail(
      node,
      "CUT_CALLOUT_VIEWPORT",
      `LocalSpace ${localSpace.width}x${localSpace.height} tile can never fit inside the uniform ${safeArea}px safe rectangle.`,
    );
  }
  const priorityAuthored = node.inputs.priority !== undefined;
  const priority = priorityAuthored
    ? wholeQuantity(
      node,
      node.inputs.priority,
      "input “priority”",
      "scalar",
      -referenceCalloutLimits.maximumAbsolutePriority,
      referenceCalloutLimits.maximumAbsolutePriority,
      "CUT_CALLOUT_LAYOUT",
    )
    : 0;
  if (priorityAuthored && priority === 0) {
    fail(
      node,
      "CUT_CALLOUT_NOOP",
      "authored priority zero repeats omitted structural ordering.",
    );
  }
  const leaderValue = node.inputs.leader;
  if (leaderValue?.kind !== "string"
    || !["none", "straight", "elbow"].includes(leaderValue.value)) {
    fail(
      node,
      "CUT_CALLOUT_STYLE",
      "input “leader” must be one of: none, straight, elbow.",
    );
  }
  const leader = leaderValue.value as ReferenceCalloutLeaderKind;
  let leaderColor: string | undefined;
  let leaderWidth: number | undefined;
  if (leader === "none") {
    if (node.inputs.leaderColor !== undefined || node.inputs.leaderWidth !== undefined) {
      fail(
        node,
        "CUT_CALLOUT_NOOP",
        "leader: none forbids leaderColor and leaderWidth because neither could execute.",
      );
    }
  } else {
    if (node.inputs.leaderColor === undefined || node.inputs.leaderWidth === undefined) {
      fail(
        node,
        "CUT_CALLOUT_STYLE",
        `leader: ${leader} requires both leaderColor and leaderWidth.`,
      );
    }
    leaderColor = color(node, node.inputs.leaderColor, "input “leaderColor”");
    leaderWidth = quantity(
      node,
      node.inputs.leaderWidth,
      "input “leaderWidth”",
      "length",
      Number.MIN_VALUE,
      Math.min(composition.width, composition.height),
      "CUT_CALLOUT_STYLE",
    );
  }
  validateOpacityValues(ir, node);
  const staticValue = Object.freeze({
    nodeId: node.id,
    localSpaceNodeId: localSpace.nodeId,
    localSpaceSemanticIdentity: localSpace.semanticIdentity,
    width: localSpace.width,
    height: localSpace.height,
    placements: placements(node),
    offset,
    safeArea,
    priority,
    priorityAuthored,
    leader,
    ...(leaderColor === undefined ? {} : { leaderColor }),
    ...(leaderWidth === undefined ? {} : { leaderWidth }),
  });
  return staticValue;
}

function calloutStaticConfig(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  localSpace: ReferenceLocalSpaceConfig,
  anchor: ReferenceValidatedAnchoredPathGeometry,
): ReferenceCalloutConfig {
  const staticValue = calloutStaticFields(ir, composition, node, localSpace);
  return Object.freeze({
    ...staticValue,
    anchor,
    semanticIdentity: hash({
      algorithm: referenceCalloutAlgorithmVersion,
      purpose: "layout-semantics",
      nodeId: node.id,
      localSpaceNodeId: localSpace.nodeId,
      viewport: { width: localSpace.width, height: localSpace.height },
      anchorValidationIdentity: anchor.validationIdentity,
      placements: staticValue.placements,
      offset: staticValue.offset,
      safeArea: staticValue.safeArea,
      priority: staticValue.priority,
      leader: staticValue.leader,
      leaderColor: staticValue.leaderColor,
      leaderWidth: staticValue.leaderWidth,
    }),
  });
}

/**
 * Close CalloutLayer ownership, retained tile bounds and spatial owner binding
 * before any source is opened or pixel is allocated.
 */
export function validateReferenceCalloutGraph(
  ir: CutAVIR,
  composition: IRComposition,
  selectedNodeIds: ReadonlySet<string> | undefined,
  localSpaceConfigs: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
  mediaCameraPlans: ReadonlyMap<string, ReferenceMediaCamera2DPlan> = new Map(),
  options: Readonly<{ mediaCameraPlanning?: "locked" | "asset-free" }> = {},
  identityComponentFragments?: ReadonlyMap<string, ReferenceIdentityComponentFragmentConfig>,
) {
  const assetFree = options.mediaCameraPlanning === "asset-free";
  const admittedIdentityFragments = identityComponentFragments
    ?? validateReferenceIdentityComponentFragments(ir, composition, selectedNodeIds);
  const selected = (node: IRNode) =>
    selectedNodeIds === undefined || selectedNodeIds.has(node.id);
  const parents = parentIndex(ir);
  const layers = Object.values(ir.nodes)
    .filter((node) => selected(node) && node.op === "cut.visual.callout_layer");
  const callouts = Object.values(ir.nodes)
    .filter((node) => selected(node) && node.op === "cut.visual.callout");
  for (const callout of callouts) {
    const directParents = parents.get(callout.id) ?? [];
    if (callout.ownership !== "child"
      || rootMembership(ir, callout.id) !== 0
      || directParents.length !== 1
      || directParents[0]?.op !== "cut.visual.callout_layer") {
      fail(
        callout,
        "CUT_CALLOUT_GRAPH",
        "must have exactly one direct CalloutLayer parent and no root membership.",
      );
    }
  }
  const calloutCount = callouts.length;
  if (calloutCount > referenceCalloutLimits.maximumCalloutsPerComposition) {
    fail(
      layers[0]!,
      "CUT_CALLOUT_LIMIT",
      `composition contains ${calloutCount} Callouts; maximum is ${referenceCalloutLimits.maximumCalloutsPerComposition}.`,
    );
  }
  const result = new Map<string, ReferenceCalloutLayerConfig>();
  for (const layer of layers) {
    const identityFragmentConfig = referenceIdentityComponentFragmentForChild(
      admittedIdentityFragments,
      layer.id,
    );
    const identityComponentFragment = identityFragmentConfig
      ? referenceIdentityComponentFragmentChildBinding(identityFragmentConfig, layer.id)
      : undefined;
    if (layer.domain !== "visual"
      || layer.effects.length !== 1
      || layer.effects[0] !== "pure"
      || layer.editorial !== undefined
      || Object.keys(layer.inputs).length !== 0
      || Object.keys(layer.properties).length !== 0) {
      fail(
        layer,
        "CUT_CALLOUT_GRAPH",
        "CalloutLayer must be a parameterless pure visual coordination root without editorial payload.",
      );
    }
    const layerParents = parents.get(layer.id) ?? [];
    const directRootLayer = layer.ownership === "root"
      && layerParents.length === 0
      && rootMembership(ir, layer.id) === 1;
    const identityFragmentLayer = identityFragmentConfig !== undefined
      && layer.ownership === "child"
      && layerParents.length === 1
      && layerParents[0]?.id === identityFragmentConfig.fragmentNodeId
      && rootMembership(ir, layer.id) === 0;
    if (!directRootLayer && !identityFragmentLayer) {
      fail(
        layer,
        "CUT_CALLOUT_GRAPH",
        "must be one direct scene root or one authenticated direct child of an admitted identity component fragment.",
      );
    }
    if (!layer.sceneId) {
      fail(
        layer,
        "CUT_CALLOUT_GRAPH",
        "CalloutLayer must declare exactly one owning scene.",
      );
    }
    const scene = ir.scenes[layer.sceneId];
    const sceneItem = directRootLayer
      ? scene?.items.find((item) => item.id === layer.id)
      : scene?.items.find((item) => item.id === identityFragmentConfig?.fragmentNodeId);
    if (!scene || !sceneItem || sceneItem.domain !== "visual"
      || (identityFragmentConfig && identityFragmentConfig.sceneId !== scene.id)) {
      fail(
        layer,
        "CUT_CALLOUT_GRAPH",
        `CalloutLayer or its admitted identity fragment must be one direct visual root in declared scene ${layer.sceneId}.`,
      );
    }
    if (compareRational(layer.interval.start, rational(0)) !== 0
      || compareRational(layer.interval.duration, scene.duration) !== 0) {
      fail(
        layer,
        "CUT_CALLOUT_GRAPH",
        "CalloutLayer must span its complete scene interval from exact zero.",
      );
    }
    if (layer.children.length < 1
      || layer.children.length > referenceCalloutLimits.maximumCalloutsPerLayer) {
      fail(
        layer,
        "CUT_CALLOUT_LIMIT",
        `CalloutLayer must own 1 through ${referenceCalloutLimits.maximumCalloutsPerLayer} direct Callouts; found ${layer.children.length}.`,
      );
    }
    const layerSourceOrder = identityFragmentConfig?.rootSourceOrder
      ?? scene.items.findIndex((item) => item.id === layer.id);
    const structuralLayerSourceOrder = identityComponentFragment
      ? Object.freeze([layerSourceOrder, identityComponentFragment.childIndex])
      : Object.freeze([layerSourceOrder]);
    const bindings: ReferenceCalloutBinding[] = [];
    for (const [childSourceOrder, calloutId] of layer.children.entries()) {
      const node = ir.nodes[calloutId];
      if (!node || node.op !== "cut.visual.callout") {
        fail(
          layer,
          "CUT_CALLOUT_GRAPH",
          `direct child ${calloutId} must be a Callout; ordinary visual children are forbidden.`,
        );
      }
      if (node.domain !== "visual"
        || node.effects.length !== 1
        || node.effects[0] !== "pure"
        || node.editorial !== undefined) {
        fail(
          node,
          "CUT_CALLOUT_GRAPH",
          "Callout must be pure visual and cannot carry an editorial payload.",
        );
      }
      if (node.sceneId !== layer.sceneId
        || node.ownership !== "child"
        || (parents.get(node.id)?.length ?? 0) !== 1
        || parents.get(node.id)?.[0]?.id !== layer.id
        || rootMembership(ir, node.id) !== 0) {
        fail(
          node,
          "CUT_CALLOUT_GRAPH",
          "must be owned directly and exclusively by its one scene-root CalloutLayer.",
        );
      }
      if (!intervalContains(layer, node) || !intervalsEqual(layer, node)) {
        fail(
          node,
          "CUT_CALLOUT_GRAPH",
          "must share its CalloutLayer's exact start and duration.",
        );
      }
      if (node.children.length !== 1) {
        fail(
          node,
          "CUT_CALLOUT_GRAPH",
          `requires exactly one direct LocalSpace child; found ${node.children.length}.`,
        );
      }
      const localNode = ir.nodes[node.children[0]!];
      const local = localNode?.op === "cut.visual.local_space"
        ? localSpaceConfigs.get(localNode.id)
        : undefined;
      if (!localNode || !local
        || local.owner !== "callout"
        || local.ownerNodeId !== node.id
        || !intervalsEqual(node, localNode)) {
        fail(
          node,
          "CUT_CALLOUT_VIEWPORT",
          "requires one exact-interval direct LocalSpace tile validated as its exclusive retained child.",
        );
      }
      const decodedAnchor = decodeReferenceSpatialPointGeometry(
        node,
        node.inputs.anchor,
        "input “anchor”",
      );
      let anchor: ReferenceValidatedAnchoredPathGeometry | undefined;
      try {
        const mediaOwner = decodedAnchor.ownerNodeIds.some(
          (ownerNodeId) => ir.nodes[ownerNodeId]?.op === "cut.visual.media_camera2d",
        );
        if (!assetFree || !mediaOwner) {
          anchor = validateReferenceAnchoredPathGeometry(
            ir,
            composition,
            node,
            decodedAnchor,
            localSpaceConfigs,
            mediaCameraPlans,
            admittedIdentityFragments,
          );
        }
      } catch (error) {
        if (error instanceof ReferenceCalloutError) throw error;
        fail(
          node,
          "CUT_CALLOUT_ANCHOR",
          error instanceof Error ? error.message : String(error),
        );
      }
      for (const ownerNodeId of decodedAnchor.ownerNodeIds) {
        const owner = ir.nodes[ownerNodeId];
        const cameraPlan = owner?.op === "cut.visual.media_camera2d"
          ? mediaCameraPlans.get(owner.id)
          : undefined;
        const slotParent = owner?.op === "cut.visual.media_camera2d"
          && owner.ownership === "child"
          ? parents.get(owner.id)?.[0]
          : undefined;
        const stackParent = slotParent?.op === "cut.visual.responsive_slot"
          ? parents.get(slotParent.id)?.[0]
          : undefined;
        const responsiveSlotOwner = owner?.op === "cut.visual.media_camera2d"
          && owner.ownership === "child"
          && slotParent?.op === "cut.visual.responsive_slot"
          && stackParent?.op === "cut.visual.responsive_stack"
          ? { slot: slotParent, stack: stackParent }
          : undefined;
        const orderingRoot = responsiveSlotOwner?.stack ?? owner;
        const ownerSourceOrder = orderingRoot
          ? scene.items.findIndex((item) => item.id === orderingRoot.id)
          : -1;
        const rootOwner = owner?.ownership === "root"
          && (parents.get(owner.id)?.length ?? 0) === 0
          && rootMembership(ir, owner.id) === 1;
        const directResponsiveOwner = responsiveSlotOwner !== undefined
          && responsiveSlotOwner.stack.ownership === "root"
          && responsiveSlotOwner.slot.ownership === "child"
          && (parents.get(responsiveSlotOwner.slot.id)?.length ?? 0) === 1
          && parents.get(responsiveSlotOwner.slot.id)?.[0]?.id === responsiveSlotOwner.stack.id
          && responsiveSlotOwner.slot.children.length === 1
          && responsiveSlotOwner.slot.children[0] === owner?.id
          && rootMembership(ir, owner!.id) === 0
          && rootMembership(ir, responsiveSlotOwner.slot.id) === 0
          && rootMembership(ir, responsiveSlotOwner.stack.id) === 1
          && (assetFree || (cameraPlan?.outputContext.kind === "responsive-slot"
            && cameraPlan.outputContext.stackNodeId === responsiveSlotOwner.stack.id
            && cameraPlan.outputContext.slotNodeId === responsiveSlotOwner.slot.id));
        const fragmentResponsiveOwner = responsiveSlotOwner !== undefined
          && identityFragmentConfig !== undefined
          && identityFragmentConfig.stackNodeId === responsiveSlotOwner.stack.id
          && identityFragmentConfig.slotNodeId === responsiveSlotOwner.slot.id
          && identityFragmentConfig.cameraNodeId === owner?.id
          && identityFragmentConfig.childNodeIds[0] === responsiveSlotOwner.stack.id
          && identityComponentFragment !== undefined
          && identityComponentFragment.childIndex > 0
          && responsiveSlotOwner.stack.ownership === "child"
          && responsiveSlotOwner.slot.ownership === "child"
          && owner?.ownership === "child"
          && rootMembership(ir, responsiveSlotOwner.stack.id) === 0
          && rootMembership(ir, responsiveSlotOwner.slot.id) === 0
          && rootMembership(ir, owner.id) === 0
          && (assetFree || (cameraPlan?.outputContext.kind === "responsive-slot"
            && cameraPlan.outputContext.stackNodeId === responsiveSlotOwner.stack.id
            && cameraPlan.outputContext.slotNodeId === responsiveSlotOwner.slot.id));
        const ownerOrderingValid = fragmentResponsiveOwner
          || ((!identityFragmentConfig || directRootLayer)
            && ownerSourceOrder >= 0
            && ownerSourceOrder < layerSourceOrder);
        if (!owner
          || owner.domain !== "visual"
          || owner.sceneId !== layer.sceneId
          || (!rootOwner && !directResponsiveOwner && !fragmentResponsiveOwner)
          || !ownerOrderingValid
          || !intervalContains(owner, node)
          || owner.provenance.module !== node.provenance.module
          || owner.provenance.span.start.offset >= node.provenance.span.start.offset) {
          fail(
            node,
            "CUT_CALLOUT_ANCHOR",
            `visualAnchor owner ${ownerNodeId} must be an earlier direct root/ResponsiveStack chain or the exact slot camera in the same admitted identity component fragment as CalloutLayer ${layer.id}.`,
          );
        }
      }
      if (assetFree) {
        void calloutStaticFields(ir, composition, node, local);
      } else {
        if (!anchor) {
          fail(
            node,
            "CUT_CALLOUT_ANCHOR",
            "runtime validation did not produce one locked anchor plan.",
          );
        }
        const config = calloutStaticConfig(ir, composition, node, local, anchor);
        bindings.push(Object.freeze({
          config,
          sourceOrder: Object.freeze([
            ...structuralLayerSourceOrder,
            childSourceOrder,
          ]),
        }));
      }
    }
    if (assetFree) continue;
    const layerConfig = Object.freeze({
      nodeId: layer.id,
      sceneId: layer.sceneId,
      sourceOrder: layerSourceOrder,
      structuralSourceOrder: structuralLayerSourceOrder,
      ...(identityComponentFragment ? { identityComponentFragment } : {}),
      callouts: Object.freeze(bindings),
      semanticIdentity: hash({
        algorithm: referenceCalloutAlgorithmVersion,
        purpose: "layout-semantics",
        layerNodeId: layer.id,
        sceneId: layer.sceneId,
        sourceOrder: layerSourceOrder,
        structuralSourceOrder: structuralLayerSourceOrder,
        ...(identityComponentFragment ? { identityComponentFragment } : {}),
        callouts: bindings.map((binding) => ({
          semanticIdentity: binding.config.semanticIdentity,
          sourceOrder: binding.sourceOrder,
        })),
      }),
    });
    result.set(layer.id, layerConfig);
  }
  return result;
}

/** Asset-free `cut check` closure. MediaCamera2D source bounds remain a lock
 * fact, but Callout fields, ownership, ordering and graph invariants are still
 * validated without manufacturing a source-coordinate plan. */
export function validateReferenceCalloutStaticGraph(
  ir: CutAVIR,
  composition: IRComposition,
  selectedNodeIds: ReadonlySet<string> | undefined,
  localSpaceConfigs: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
  identityComponentFragments?: ReadonlyMap<string, ReferenceIdentityComponentFragmentConfig>,
) {
  void validateReferenceCalloutGraph(
    ir,
    composition,
    selectedNodeIds,
    localSpaceConfigs,
    new Map(),
    { mediaCameraPlanning: "asset-free" },
    identityComponentFragments,
  );
}

export function referenceCalloutOpacityAt(
  ir: CutAVIR,
  node: IRNode,
  time: Rational,
) {
  const property = propertyAt(ir, node, "opacity", time);
  const baseline = node.inputs.opacity ?? {
    kind: "quantity",
    dimension: "ratio",
    unit: "ratio",
    magnitude: rational(1),
  } as IRValue;
  const sampled = property?.kind === "null" ? baseline : property ?? baseline;
  return quantity(node, sampled, "executed opacity", "ratio", 0, 1);
}

export function referenceCalloutOpacitySourceIdentity(ir: CutAVIR, node: IRNode) {
  const property = node.properties.opacity;
  return hash({
    algorithm: referenceCalloutAlgorithmVersion,
    nodeId: node.id,
    baseline: node.inputs.opacity ?? {
      kind: "quantity",
      dimension: "ratio",
      unit: "ratio",
      magnitude: rational(1),
    },
    property: property && "signal" in property
      ? {
        signalId: property.signal,
        signalContentHash: ir.signals[property.signal]?.contentHash,
      }
      : property,
  });
}

type PreparedCallout = Readonly<{
  binding: ReferenceCalloutBinding;
  node: IRNode;
  opacity: number;
  anchor?: Readonly<{
    point: Readonly<{ x: number; y: number }>;
    executionIdentity: string;
    anchors: readonly ReferenceAnchoredPathAnchorEvidence[];
  }>;
  suppressed?: ReferenceAnchoredPathPolicyHiddenResolution;
}>;

function compareSourceOrder(left: readonly number[], right: readonly number[]) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function referenceCalloutDecisionIdentity(
  layerSemanticIdentity: string,
  time: Rational,
  decisions: readonly ReferenceCalloutDecision[],
) {
  return hash({
    algorithm: referenceCalloutAlgorithmVersion,
    layoutAlgorithm: referenceCalloutLayoutAlgorithmVersion,
    layerSemanticIdentity,
    exactTime: `${time.numerator}/${time.denominator}`,
    decisions: decisions.map((decision) => ({
      nodeId: decision.nodeId,
      calloutSemanticIdentity: decision.calloutSemanticIdentity,
      opacitySourceIdentity: decision.opacitySourceIdentity,
      opacitySampleIdentity: decision.opacitySampleIdentity,
      sourceOrder: decision.sourceOrder,
      priority: decision.priority,
      resolutionOrder: decision.resolutionOrder,
      paintOrder: decision.paintOrder,
      opacity: decision.opacity,
      status: decision.status,
      reason: decision.reason,
      exactAnchor: decision.exactAnchor,
      candidates: decision.candidates,
      chosenPlacement: decision.chosenPlacement,
      chosenPlacementIndex: decision.chosenPlacementIndex,
      rect: decision.rect,
      leader: decision.leader,
      anchorExecutionIdentity: decision.anchorExecutionIdentity,
      suppressedBy: decision.suppressedBy?.map(
        ({ ownerNodeId, ownerKind, localSpaceNodeId }) => ({
          ownerNodeId,
          ownerKind,
          localSpaceNodeId,
        }),
      ),
    })),
  });
}

/** Resolve one exact scene frame without reading pixels or materializing tiles. */
export function referenceCalloutPlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  layer: ReferenceCalloutLayerConfig,
  time: Rational,
  resolveOwner: ReferenceCalloutOwnerResolver,
  frame?: bigint,
): ReferenceCalloutFramePlan {
  const layerNode = ir.nodes[layer.nodeId];
  if (!layerNode) throw new Error(`CUT CalloutLayer ${layer.nodeId} is missing.`);
  const execution = Object.freeze({
    time: Object.freeze({ ...time }),
    ...(frame === undefined ? {} : { frame }),
  });
  const scene = ir.scenes[layer.sceneId];
  if (!scene) {
    fail(layerNode, "CUT_CALLOUT_GRAPH", `references missing scene ${layer.sceneId}.`);
  }
  const prepared: PreparedCallout[] = [];
  for (const binding of layer.callouts) {
    const node = ir.nodes[binding.config.nodeId];
    if (!node || !active(node, time)) continue;
    const opacity = referenceCalloutOpacityAt(ir, node, time);
    if (opacity === 0) {
      prepared.push(Object.freeze({ binding, node, opacity }));
      continue;
    }
    let resolution;
    try {
      resolution = resolveReferenceAnchoredPathGeometryAt(
        node,
        binding.config.anchor,
        time,
        (ownerNodeId, exactTime) =>
          resolveOwner(node, binding.config.anchor, ownerNodeId, exactTime),
        frame,
      );
    } catch (error) {
      // Track2D fail-policy and anchored-coordinate failures already carry the
      // causative source and stable public code. Preserve them verbatim.
      if (error instanceof ReferenceCalloutError || isSourceLocatedStableError(error)) throw error;
      fail(
        node,
        "CUT_CALLOUT_ANCHOR",
        error instanceof Error ? error.message : String(error),
        execution,
      );
    }
    if (resolution.status === "policy-hidden") {
      prepared.push(Object.freeze({
        binding,
        node,
        opacity,
        suppressed: resolution,
      }));
      continue;
    }
    prepared.push(Object.freeze({
      binding,
      node,
      opacity,
      anchor: Object.freeze({
        point: resolution.geometry.start,
        executionIdentity: resolution.executionIdentity,
        anchors: resolution.anchors,
      }),
    }));
  }
  const layoutInputs = prepared.flatMap((item) =>
    item.anchor ? [Object.freeze({
      id: item.node.id,
      sourceOrder: item.binding.sourceOrder,
      priority: item.binding.config.priority,
      anchor: item.anchor.point,
      width: item.binding.config.width,
      height: item.binding.config.height,
      placements: item.binding.config.placements,
      offset: item.binding.config.offset,
      safeArea: item.binding.config.safeArea,
      opacity: item.opacity,
      leader: item.binding.config.leader,
      leaderColor: item.binding.config.leaderColor,
      leaderWidth: item.binding.config.leaderWidth,
    })] : []);
  let layout;
  try {
    layout = resolveReferenceCalloutLayout(
      { width: composition.width, height: composition.height },
      layoutInputs,
      {
        fail: (entry, kind, detail): never => {
          const node = ir.nodes[entry?.id ?? layer.nodeId] ?? layerNode;
          fail(
            node,
            kind === "limit" ? "CUT_CALLOUT_LIMIT"
              : kind === "style" ? "CUT_CALLOUT_STYLE"
                : "CUT_CALLOUT_LAYOUT",
            detail,
            execution,
          );
        },
      },
    );
  } catch (error) {
    if (error instanceof ReferenceCalloutError) throw error;
    fail(
      layerNode,
      "CUT_CALLOUT_LAYOUT",
      error instanceof Error ? error.message : String(error),
      execution,
    );
  }
  const layoutById = new Map(layout.decisions.map((decision) => [decision.id, decision]));
  const resolutionOrdered = [...prepared].sort((left, right) =>
    right.binding.config.priority - left.binding.config.priority
    || compareSourceOrder(left.binding.sourceOrder, right.binding.sourceOrder));
  const decisions: ReferenceCalloutDecision[] = resolutionOrdered.map((item, resolutionOrder) => {
    const base = {
      nodeId: item.node.id,
      localSpaceNodeId: item.binding.config.localSpaceNodeId,
      calloutSemanticIdentity: item.binding.config.semanticIdentity,
      localSpaceSemanticIdentity: item.binding.config.localSpaceSemanticIdentity,
      opacitySourceIdentity: referenceCalloutOpacitySourceIdentity(ir, item.node),
      opacitySampleIdentity: hash({
        source: referenceCalloutOpacitySourceIdentity(ir, item.node),
        exactTime: `${time.numerator}/${time.denominator}`,
        opacity: item.opacity,
      }),
      sourceOrder: item.binding.sourceOrder,
      priority: item.binding.config.priority,
      resolutionOrder,
      opacity: item.opacity,
    } as const;
    if (item.opacity === 0) {
      return Object.freeze({
        ...base,
        status: "hidden" as const,
        reason: "opacity-zero" as const,
        candidates: Object.freeze([]),
      });
    }
    if (item.suppressed) {
      return Object.freeze({
        ...base,
        status: "hidden" as const,
        reason: "owner-policy-hidden" as const,
        candidates: Object.freeze([]),
        anchorExecutionIdentity: item.suppressed.executionIdentity,
        suppressedBy: item.suppressed.suppressedBy,
      });
    }
    const decision = layoutById.get(item.node.id);
    if (!decision || !item.anchor) {
      fail(
        item.node,
        "CUT_CALLOUT_LAYOUT",
        "resolved anchor is absent from the deterministic layout plan.",
        execution,
      );
    }
    return Object.freeze({
      ...base,
      status: decision.status,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      exactAnchor: decision.exactAnchor,
      candidates: decision.candidates,
      ...(decision.chosenPlacement === undefined
        ? {}
        : {
          chosenPlacement: decision.chosenPlacement,
          chosenPlacementIndex: decision.chosenPlacementIndex,
          rect: decision.rect,
          ...(decision.leader === undefined ? {} : { leader: decision.leader }),
        }),
      anchorExecutionIdentity: item.anchor.executionIdentity,
      anchors: item.anchor.anchors,
    });
  });
  const accepted = decisions.filter((decision) => decision.status === "accepted");
  const paintOrder = [...accepted].reverse().map((decision) => decision.nodeId);
  const paintOrderById = new Map(paintOrder.map((id, index) => [id, index]));
  const finalized = Object.freeze(decisions.map((decision) =>
    decision.status === "accepted"
      ? Object.freeze({ ...decision, paintOrder: paintOrderById.get(decision.nodeId)! })
      : decision));
  const decisionIdentity = referenceCalloutDecisionIdentity(
    layer.semanticIdentity,
    time,
    finalized,
  );
  return Object.freeze({
    format: "cut-reference-callout-frame-decisions" as const,
    version: 1 as const,
    algorithmVersion: referenceCalloutAlgorithmVersion,
    layoutAlgorithmVersion: referenceCalloutLayoutAlgorithmVersion,
    compositionId: composition.id,
    sceneId: layer.sceneId,
    exactTime: Object.freeze(addRational(scene.start, time)),
    sceneLocalTime: execution.time,
    ...(frame === undefined ? {} : { outputFrame: String(frame) }),
    layerNodeId: layer.nodeId,
    layerSemanticIdentity: layer.semanticIdentity,
    ...(layer.identityComponentFragment
      ? { identityComponentFragment: layer.identityComponentFragment }
      : {}),
    decisions: finalized,
    resolutionOrder: Object.freeze(finalized.map((decision) => decision.nodeId)),
    paintOrder: Object.freeze(paintOrder),
    work: Object.freeze({
      activeCallouts: prepared.length,
      acceptedCallouts: accepted.length,
      anchorResolutions: prepared.filter((item) => item.anchor !== undefined).length,
      ownerPolicySkips: prepared.filter((item) => item.suppressed !== undefined).length,
      candidateEvaluations: layout.work.candidateEvaluations,
      candidateCollisionTests: layout.work.candidateCollisionTests,
      leaderSegments: layout.work.leaderSegments,
    }),
    decisionIdentity,
  });
}

export function referenceCalloutInspect(config: ReferenceCalloutLayerConfig) {
  return Object.freeze({
    algorithmVersion: referenceCalloutAlgorithmVersion,
    layoutAlgorithmVersion: referenceCalloutLayoutAlgorithmVersion,
    nodeId: config.nodeId,
    sceneId: config.sceneId,
    sourceOrder: config.sourceOrder,
    structuralSourceOrder: config.structuralSourceOrder,
    ...(config.identityComponentFragment
      ? { identityComponentFragment: config.identityComponentFragment }
      : {}),
    callouts: Object.freeze(config.callouts.map((binding) => Object.freeze({
      nodeId: binding.config.nodeId,
      localSpaceNodeId: binding.config.localSpaceNodeId,
      localSpaceSemanticIdentity: binding.config.localSpaceSemanticIdentity,
      sourceOrder: binding.sourceOrder,
      viewport: Object.freeze({
        width: binding.config.width,
        height: binding.config.height,
      }),
      placements: binding.config.placements,
      offset: binding.config.offset,
      safeArea: binding.config.safeArea,
      priority: binding.config.priority,
      leader: binding.config.leader,
      anchorOwnerNodeIds: binding.config.anchor.ownerNodeIds,
      semanticIdentity: binding.config.semanticIdentity,
    }))),
    semanticIdentity: config.semanticIdentity,
    policy: Object.freeze({
      collision: "half-open-bounds-priority-then-source-order" as const,
      paint: "reverse-resolution-order-leader-before-own-tile" as const,
      opacityZero: "zero-anchor-and-raster-work" as const,
      trackPolicyHidden: "zero-layout-and-raster-work" as const,
      anchorInference: "not-claimed-explicit-spatial-point-only" as const,
    }),
  });
}
