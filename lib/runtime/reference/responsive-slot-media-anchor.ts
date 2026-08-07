import { hash } from "../../core/stable";
import type { Rational } from "../../language/rational";
import {
  validateReferenceCalloutFrameEvidenceSemantics,
  type ReferenceCalloutRenderedFrameEvidence,
} from "./callout";
import {
  referenceMediaCamera2DAnchorAlgorithmVersion,
  referenceMediaCamera2DResponsiveSlotAnchorAlgorithmVersion,
  referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion,
  type ReferenceMediaCamera2DExecutionEvidence,
} from "./media-camera2d";
import {
  referenceAnchoredPathAlgorithmVersion,
  referenceAnchoredPathPolicyHiddenExecutionIdentity,
  referenceMediaCamera2DAnchoredPathAlgorithmVersion,
  type ReferenceAnchoredPathAnchorEvidence,
} from "./anchored-path";
import {
  validateReferenceResponsiveStackMediaFrameEvidence,
  type ReferenceResponsiveStackFrameEvidence,
  type ReferenceResponsiveStackRasterSlot,
} from "./responsive-layout";
import type { ReferenceAnchoredPathFrameEvidence } from "./visual";
import type { ReferenceIdentityComponentFragmentChildBinding } from "./identity-component-fragment";

export const referenceResponsiveSlotMediaAnchorLinkAlgorithmVersion =
  "cut-reference-responsive-slot-media-anchor-link-v1" as const;

export const referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame =
  4_096 as const;

type Q16Affine = Readonly<{
  a: string;
  b: string;
  c: string;
  d: string;
  tx: string;
  ty: string;
}>;

type MediaCameraAnchor = Extract<
  ReferenceAnchoredPathAnchorEvidence,
  Readonly<{ basisKind: "post-crop-source-pixel-centres" }>
>;

type SlotAnchor = NonNullable<MediaCameraAnchor["responsiveSlotComposition"]>;

type ResponsiveSlotMediaCameraAnchor = MediaCameraAnchor & Readonly<{
  responsiveSlotComposition: SlotAnchor;
}>;

export type ReferenceResponsiveSlotMediaAnchorLinkEvidence = Readonly<{
  format: "cut-reference-responsive-slot-media-anchor-link";
  version: 1;
  algorithmVersion: typeof referenceResponsiveSlotMediaAnchorLinkAlgorithmVersion;
  compositionId: string;
  exactTime: Rational;
  outputFrame: string;
  consumerNodeId: string;
  consumerOp: "cut.visual.path" | "cut.visual.motion_path" | "cut.visual.callout";
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
  anchorOccurrence: number;
  anchorExecutionIdentity: string;
  anchorReceiptIdentity: string;
  ownerCameraNodeId: string;
  ownerStatus: "visible" | "opacity-zero";
  ownerPlanIdentity: string;
  cameraExecutionIdentity: string;
  cameraFramePlanIdentity: string;
  cameraOutputContextIdentity: string;
  responsiveStackNodeId: string;
  responsiveStackExecutionIdentity: string;
  responsiveSlotNodeId: string;
  responsiveSlotIndex: number;
  responsivePlacementIdentity: string;
  responsivePlacementStatus: "placed" | "skipped-opacity-zero";
  sourceBasis: Readonly<{
    kind: "post-crop-source-pixel-centres";
    width: number;
    height: number;
    semanticIdentity: string;
  }>;
  sourcePoint: Readonly<{ x: number; y: number }>;
  sourceToSlotQ16: Q16Affine;
  sourceToSlotAffineIdentity: string;
  slotBasis: SlotAnchor["slotBasis"];
  slotPoint: Readonly<{ x: number; y: number }>;
  slotToCompositionQ16: SlotAnchor["slotToCompositionQ16"];
  compositionBasis: SlotAnchor["compositionBasis"];
  compositionPoint: Readonly<{ x: number; y: number }>;
  sourceToCompositionQ16: Q16Affine;
  sourceToCompositionAffineIdentity: string;
  rasterSlot: ReferenceResponsiveStackRasterSlot;
  clip: "half-open-raster-slot";
  geometricResampleCount: 0;
  linkIdentity: string;
}>;

function sameTime(left: Rational, right: Rational) {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

function sameSlot(left: ReferenceResponsiveStackRasterSlot, right: ReferenceResponsiveStackRasterSlot) {
  return left.left === right.left
    && left.top === right.top
    && left.right === right.right
    && left.bottom === right.bottom
    && left.width === right.width
    && left.height === right.height;
}

function sameQ16(left: Q16Affine, right: Q16Affine) {
  return left.a === right.a
    && left.b === right.b
    && left.c === right.c
    && left.d === right.d
    && left.tx === right.tx
    && left.ty === right.ty;
}

function q16Number(value: string) {
  if (value.length > 32 || !/^(?:0|-?[1-9][0-9]*)$/u.test(value)) {
    throw new Error("CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: affine contains a non-canonical Q16 integer.");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: affine exceeds the safe Q16 coordinate envelope.");
  }
  return Number(parsed) / 65_536;
}

function assertQ16Affine(affine: Q16Affine) {
  for (const value of [
    affine.a,
    affine.b,
    affine.c,
    affine.d,
    affine.tx,
    affine.ty,
  ]) q16Number(value);
}

function pointAt(affine: Q16Affine, point: Readonly<{ x: number; y: number }>) {
  return Object.freeze({
    x: q16Number(affine.a) * point.x + q16Number(affine.c) * point.y + q16Number(affine.tx),
    y: q16Number(affine.b) * point.x + q16Number(affine.d) * point.y + q16Number(affine.ty),
  });
}

function samePoint(left: Readonly<{ x: number; y: number }>, right: Readonly<{ x: number; y: number }>) {
  return Number.isFinite(left.x)
    && Number.isFinite(left.y)
    && Number.isFinite(right.x)
    && Number.isFinite(right.y)
    && Math.abs(left.x - right.x) <= 1e-9
    && Math.abs(left.y - right.y) <= 1e-9;
}

type AnchorCandidate = Readonly<{
  consumerNodeId: string;
  consumerOp: ReferenceResponsiveSlotMediaAnchorLinkEvidence["consumerOp"];
  anchorExecutionIdentity: string;
  anchorReceiptIdentity: string;
  exactTime: Rational;
  outputFrame: string;
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
  anchor: ResponsiveSlotMediaCameraAnchor;
}>;

function isResponsiveSlotMediaCameraAnchor(
  anchor: ReferenceAnchoredPathAnchorEvidence,
): anchor is ResponsiveSlotMediaCameraAnchor {
  return anchor.basisKind === "post-crop-source-pixel-centres"
    && anchor.responsiveSlotComposition !== undefined;
}

function collectResponsiveSlotMediaAnchorCandidates(
  paths: readonly ReferenceAnchoredPathFrameEvidence[],
  callouts: readonly ReferenceCalloutRenderedFrameEvidence[],
) {
  const candidates: AnchorCandidate[] = [];
  const append = (candidate: AnchorCandidate) => {
    if (candidates.length >= referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame) {
      throw new Error(
        `CUT_RESPONSIVE_SLOT_ANCHOR_LIMIT: responsive slot-camera anchor link count exceeds ${referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame} per composition frame.`,
      );
    }
    candidates.push(Object.freeze(candidate));
  };
  for (const receipt of paths) {
    const outputFrame = receipt.outputFrame;
    if (receipt.status !== "resolved" || !receipt.anchors || outputFrame === undefined) continue;
    for (const anchor of receipt.anchors) {
      if (!isResponsiveSlotMediaCameraAnchor(anchor)) continue;
      append({
        consumerNodeId: receipt.consumerNodeId,
        consumerOp: receipt.consumerOp,
        anchorExecutionIdentity: receipt.executionIdentity,
        anchorReceiptIdentity: receipt.evidenceIdentity,
        exactTime: receipt.exactTime,
        outputFrame,
        ...(receipt.identityComponentFragment
          ? { identityComponentFragment: receipt.identityComponentFragment }
          : {}),
        anchor: Object.freeze({
          ...anchor,
          responsiveSlotComposition: anchor.responsiveSlotComposition,
        }),
      });
    }
  }
  for (const receipt of callouts) {
    for (const decision of receipt.decisions) {
      if (!decision.anchors || !decision.anchorExecutionIdentity) continue;
      for (const anchor of decision.anchors) {
        if (!isResponsiveSlotMediaCameraAnchor(anchor)) continue;
        append({
          consumerNodeId: decision.nodeId,
          consumerOp: "cut.visual.callout",
          anchorExecutionIdentity: decision.anchorExecutionIdentity,
          anchorReceiptIdentity: receipt.executionIdentity,
          exactTime: receipt.exactTime,
          outputFrame: receipt.outputFrame,
          ...(receipt.identityComponentFragment
            ? { identityComponentFragment: receipt.identityComponentFragment }
            : {}),
          anchor: Object.freeze({
            ...anchor,
            responsiveSlotComposition: anchor.responsiveSlotComposition,
          }),
        });
      }
    }
  }
  return Object.freeze(candidates);
}

/**
 * Close every slot-camera anchor over the three independently completed
 * receipts that authorize it: native camera execution, ResponsiveStack
 * placement, and Path/MotionPath/Callout resolution. This runs before any
 * evidence ledger is committed by the renderer.
 */
function bindReferenceResponsiveSlotMediaAnchorFrameEvidenceUnchecked(
  compositionId: string,
  candidates: readonly AnchorCandidate[],
  cameras: readonly ReferenceMediaCamera2DExecutionEvidence[],
  stacks: readonly ReferenceResponsiveStackFrameEvidence[],
) {
  const links = candidates.map((candidate): ReferenceResponsiveSlotMediaAnchorLinkEvidence => {
    const { anchor } = candidate;
    const slot = anchor.responsiveSlotComposition;
    assertQ16Affine(slot.sourceToSlotQ16);
    assertQ16Affine(slot.slotToCompositionQ16);
    assertQ16Affine(slot.sourceToCompositionQ16);
    const cameraMatches = cameras.filter((camera) =>
      camera.cameraNodeId === anchor.ownerNodeId
      && camera.outputFrame === candidate.outputFrame
      && sameTime(camera.exactTime, candidate.exactTime));
    if (cameraMatches.length !== 1) {
      throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchor consumer ${candidate.consumerNodeId} expected one completed camera ${anchor.ownerNodeId}; found ${cameraMatches.length}.`);
    }
    const camera = cameraMatches[0]!;
    const stackMatches = stacks.filter((stack) =>
      stack.nodeId === slot.stackNodeId
      && stack.outputFrame === candidate.outputFrame
      && sameTime(stack.exactTime, candidate.exactTime));
    if (stackMatches.length !== 1) {
      throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchor consumer ${candidate.consumerNodeId} expected one completed ResponsiveStack ${slot.stackNodeId}; found ${stackMatches.length}.`);
    }
    const stack = stackMatches[0]!;
    const stackSlot = stack.slots.find((entry) =>
      entry.slotNodeId === slot.slotNodeId && entry.index === slot.index);
    const media = stackSlot?.mediaCamera2D;
    const expectedOwnerStatus = camera.status === "opacity-zero" ? "opacity-zero" as const : "visible" as const;
    const expectedPlacementStatus = camera.status === "opacity-zero"
      ? "skipped-opacity-zero" as const
      : "placed" as const;
    const expectedSourceToSlotAffineIdentity = hash({
      algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
      coordinateSpace: "responsive-slot",
      cameraNodeId: camera.cameraNodeId,
      basisSemanticIdentity: anchor.basisSemanticIdentity,
      outputContextIdentity: camera.outputContext.semanticIdentity,
      sourceToSlotQ16: slot.sourceToSlotQ16,
    });
    const expectedSlotBasisIdentity = hash({
      kind: "responsive-slot-pixel-centres",
      compositionId,
      stackNodeId: slot.stackNodeId,
      slotNodeId: slot.slotNodeId,
      index: slot.index,
      outputContextIdentity: slot.outputContextIdentity,
      width: slot.rasterSlot.width,
      height: slot.rasterSlot.height,
    });
    const expectedCompositionBasisIdentity = hash({
      kind: "composition-pixel-centres",
      compositionId,
      width: slot.compositionBasis.width,
      height: slot.compositionBasis.height,
    });
    const placementReceipt = {
      algorithmVersion: referenceMediaCamera2DResponsiveSlotAnchorAlgorithmVersion,
      pixelPlacementAlgorithmVersion: referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion,
      compositionId,
      stackNodeId: slot.stackNodeId,
      slotNodeId: slot.slotNodeId,
      index: slot.index,
      compilerContextIdentity: slot.compilerContextIdentity,
      outputContextIdentity: slot.outputContextIdentity,
      responsivePlanIdentity: slot.responsivePlanIdentity,
      sourceToSlotQ16: slot.sourceToSlotQ16,
      sourceToSlotAffineIdentity: slot.sourceToSlotAffineIdentity,
      slotBasis: slot.slotBasis,
      slotToCompositionQ16: slot.slotToCompositionQ16,
      compositionBasis: slot.compositionBasis,
      rasterSlot: slot.rasterSlot,
      clip: slot.clip,
    } as const;
    const expectedSourceToCompositionQ16 = Object.freeze({
      a: slot.sourceToSlotQ16.a,
      b: slot.sourceToSlotQ16.b,
      c: slot.sourceToSlotQ16.c,
      d: slot.sourceToSlotQ16.d,
      tx: String(BigInt(slot.sourceToSlotQ16.tx) + BigInt(slot.slotToCompositionQ16.tx)),
      ty: String(BigInt(slot.sourceToSlotQ16.ty) + BigInt(slot.slotToCompositionQ16.ty)),
    });
    const expectedAffineIdentity = hash({
      algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
      cameraNodeId: camera.cameraNodeId,
      basisSemanticIdentity: anchor.basisSemanticIdentity,
      sourceToDeliveryQ16: expectedSourceToCompositionQ16,
      coordinateSpace: "responsive-slot-composition",
      responsiveSlotPlacementPlanIdentity: slot.placementPlanIdentity,
    });
    const expectedSlotPoint = pointAt(slot.sourceToSlotQ16, anchor.localPoint);
    const expectedCompositionPoint = pointAt(expectedSourceToCompositionQ16, anchor.localPoint);
    if (camera.compositionId !== compositionId
      || camera.outputContext.kind !== "responsive-slot"
      || camera.outputContext.compositionId !== compositionId
      || camera.outputContext.semanticIdentity !== slot.outputContextIdentity
      || camera.outputContext.compilerContextIdentity !== slot.compilerContextIdentity
      || camera.outputContext.planIdentity !== slot.responsivePlanIdentity
      || camera.outputContext.stackNodeId !== slot.stackNodeId
      || camera.outputContext.slotNodeId !== slot.slotNodeId
      || camera.outputContext.index !== slot.index
      || !sameSlot(camera.outputContext.rasterSlot, slot.rasterSlot)
      || !sameQ16(camera.geometry.sourceToDeliveryQ16, slot.sourceToSlotQ16)
      || stack.compositionId !== compositionId
      || stack.planIdentity !== slot.responsivePlanIdentity
      || !stackSlot
      || !sameSlot(stackSlot.rasterSlot, slot.rasterSlot)
      || !media
      || media.cameraNodeId !== camera.cameraNodeId
      || media.cameraExecutionIdentity !== camera.executionIdentity
      || media.framePlanIdentity !== camera.framePlanIdentity
      || media.outputContextIdentity !== slot.outputContextIdentity
      || media.placement.placementIdentity.length !== 64
      || media.placement.status !== expectedPlacementStatus
      || media.placement.algorithmVersion !== referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion
      || media.placement.geometricResampleCount !== 0
      || anchor.ownerStatus !== expectedOwnerStatus
      || slot.algorithmVersion !== referenceMediaCamera2DResponsiveSlotAnchorAlgorithmVersion
      || slot.pixelPlacementAlgorithmVersion !== referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion
      || slot.sourceToSlotAffineIdentity !== expectedSourceToSlotAffineIdentity
      || slot.slotBasis.semanticIdentity !== expectedSlotBasisIdentity
      || slot.slotBasis.width !== slot.rasterSlot.width
      || slot.slotBasis.height !== slot.rasterSlot.height
      || slot.slotToCompositionQ16.a !== "65536"
      || slot.slotToCompositionQ16.b !== "0"
      || slot.slotToCompositionQ16.c !== "0"
      || slot.slotToCompositionQ16.d !== "65536"
      || slot.slotToCompositionQ16.tx !== String(BigInt(slot.rasterSlot.left) * 65_536n)
      || slot.slotToCompositionQ16.ty !== String(BigInt(slot.rasterSlot.top) * 65_536n)
      || slot.compositionBasis.kind !== "composition-pixel-centres"
      || slot.compositionBasis.width !== camera.outputContext.compositionWidth
      || slot.compositionBasis.height !== camera.outputContext.compositionHeight
      || slot.compositionBasis.semanticIdentity !== expectedCompositionBasisIdentity
      || slot.placementPlanIdentity !== hash(placementReceipt)
      || !sameQ16(slot.sourceToCompositionQ16, expectedSourceToCompositionQ16)
      || anchor.affineIdentity !== expectedAffineIdentity
      || !samePoint(expectedCompositionPoint, anchor.compositionPoint)) {
      throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchor consumer ${candidate.consumerNodeId} contradicts its camera, slot placement, or exact source/slot/composition coordinate chain.`);
    }
    const receipt = Object.freeze({
      format: "cut-reference-responsive-slot-media-anchor-link" as const,
      version: 1 as const,
      algorithmVersion: referenceResponsiveSlotMediaAnchorLinkAlgorithmVersion,
      compositionId,
      exactTime: Object.freeze({ ...candidate.exactTime }),
      outputFrame: candidate.outputFrame,
      consumerNodeId: candidate.consumerNodeId,
      consumerOp: candidate.consumerOp,
      ...(candidate.identityComponentFragment
        ? { identityComponentFragment: candidate.identityComponentFragment }
        : {}),
      anchorOccurrence: anchor.occurrence,
      anchorExecutionIdentity: candidate.anchorExecutionIdentity,
      anchorReceiptIdentity: candidate.anchorReceiptIdentity,
      ownerCameraNodeId: camera.cameraNodeId,
      ownerStatus: anchor.ownerStatus,
      ownerPlanIdentity: anchor.ownerPlanIdentity,
      cameraExecutionIdentity: camera.executionIdentity,
      cameraFramePlanIdentity: camera.framePlanIdentity,
      cameraOutputContextIdentity: camera.outputContext.semanticIdentity,
      responsiveStackNodeId: stack.nodeId,
      responsiveStackExecutionIdentity: stack.executionIdentity,
      responsiveSlotNodeId: stackSlot.slotNodeId,
      responsiveSlotIndex: stackSlot.index,
      responsivePlacementIdentity: media.placement.placementIdentity,
      responsivePlacementStatus: media.placement.status,
      sourceBasis: Object.freeze({
        kind: anchor.basisKind,
        width: anchor.basisWidth,
        height: anchor.basisHeight,
        semanticIdentity: anchor.basisSemanticIdentity,
      }),
      sourcePoint: anchor.localPoint,
      sourceToSlotQ16: slot.sourceToSlotQ16,
      sourceToSlotAffineIdentity: slot.sourceToSlotAffineIdentity,
      slotBasis: slot.slotBasis,
      slotPoint: expectedSlotPoint,
      slotToCompositionQ16: slot.slotToCompositionQ16,
      compositionBasis: slot.compositionBasis,
      compositionPoint: anchor.compositionPoint,
      sourceToCompositionQ16: slot.sourceToCompositionQ16,
      sourceToCompositionAffineIdentity: anchor.affineIdentity,
      rasterSlot: slot.rasterSlot,
      clip: slot.clip,
      geometricResampleCount: 0 as const,
    });
    return Object.freeze({ ...receipt, linkIdentity: hash(receipt) });
  });
  const keys = links.map((link) =>
    `${link.consumerNodeId}\0${link.anchorExecutionIdentity}\0${link.ownerCameraNodeId}\0${link.anchorOccurrence}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: duplicate slot-camera anchor occurrence escaped the completed evidence ledgers.");
  }
  return Object.freeze([...links].sort((left, right) =>
    left.consumerNodeId.localeCompare(right.consumerNodeId)
    || left.anchorOccurrence - right.anchorOccurrence
    || left.linkIdentity.localeCompare(right.linkIdentity)));
}

function authenticateAnchoredPathReceipt(receipt: ReferenceAnchoredPathFrameEvidence) {
  const { evidenceIdentity, ...body } = receipt;
  if (hash(body) !== evidenceIdentity) {
    throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchored receipt ${receipt.consumerNodeId} evidenceIdentity is not authentic.`);
  }
  const algorithm = receipt.algorithmVersion
    ?? referenceAnchoredPathAlgorithmVersion;
  if (receipt.status === "policy-hidden") {
    if (!receipt.suppressedBy) {
      throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchored receipt ${receipt.consumerNodeId} hidden payload is incomplete.`);
    }
    const expected = referenceAnchoredPathPolicyHiddenExecutionIdentity(
      receipt.authoredGeometryIdentity,
      receipt.exactTime,
      receipt.suppressedBy.map(
        ({ ownerNodeId, ownerKind, localSpaceNodeId }) =>
          ({ ownerNodeId, ownerKind, localSpaceNodeId }),
      ),
      algorithm,
    );
    if (receipt.executionIdentity !== expected) {
      throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchored receipt ${receipt.consumerNodeId} hidden executionIdentity is not derivable.`);
    }
    return;
  }
  if (!receipt.anchors || !receipt.geometry || !receipt.geometryIdentity) {
    throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchored receipt ${receipt.consumerNodeId} resolved payload is incomplete.`);
  }
  const spatialBases = new Map<string, string>();
  for (const anchor of receipt.anchors) {
    const previous = spatialBases.get(anchor.ownerNodeId);
    if (previous !== undefined && previous !== anchor.affineIdentity) {
      throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchored receipt ${receipt.consumerNodeId} assigns contradictory affine identities to owner ${anchor.ownerNodeId}.`);
    }
    spatialBases.set(anchor.ownerNodeId, anchor.affineIdentity);
  }
  const expectedGeometryIdentity = hash({
    algorithm,
    geometrySemanticIdentity: receipt.authoredGeometryIdentity,
    spatialBases: [...spatialBases].map(([ownerNodeId, affineIdentity]) =>
      ({ ownerNodeId, affineIdentity }))
      .sort((left, right) => left.ownerNodeId.localeCompare(right.ownerNodeId)),
    geometry: receipt.geometry,
  });
  const expectedExecutionIdentity = hash({
    algorithm,
    status: "resolved",
    geometryIdentity: expectedGeometryIdentity,
    exactTime: `${receipt.exactTime.numerator}/${receipt.exactTime.denominator}`,
  });
  if (receipt.geometryIdentity !== expectedGeometryIdentity
    || receipt.executionIdentity !== expectedExecutionIdentity
    || (receipt.algorithmVersion !== undefined
      && receipt.algorithmVersion !== referenceMediaCamera2DAnchoredPathAlgorithmVersion)) {
    throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: anchored receipt ${receipt.consumerNodeId} geometry/execution identity is not derivable.`);
  }
}

function authenticateSourceReceipts(
  paths: readonly ReferenceAnchoredPathFrameEvidence[],
  callouts: readonly ReferenceCalloutRenderedFrameEvidence[],
  cameras: readonly ReferenceMediaCamera2DExecutionEvidence[],
  stacks: readonly ReferenceResponsiveStackFrameEvidence[],
) {
  for (const path of paths) authenticateAnchoredPathReceipt(path);
  for (const callout of callouts) {
    validateReferenceCalloutFrameEvidenceSemantics(callout);
  }
  for (const camera of cameras) {
    const { executionIdentity, ...body } = camera;
    if (hash(body) !== executionIdentity) {
      throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: camera receipt ${camera.cameraNodeId} executionIdentity is not authentic.`);
    }
  }
  for (const stack of stacks) {
    const { executionIdentity, ...body } = stack;
    if (hash(body) !== executionIdentity) {
      throw new Error(`CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: ResponsiveStack receipt ${stack.nodeId} executionIdentity is not authentic.`);
    }
  }
  validateReferenceResponsiveStackMediaFrameEvidence(stacks, cameras);
}

export function bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
  compositionId: string,
  paths: readonly ReferenceAnchoredPathFrameEvidence[],
  callouts: readonly ReferenceCalloutRenderedFrameEvidence[],
  cameras: readonly ReferenceMediaCamera2DExecutionEvidence[],
  stacks: readonly ReferenceResponsiveStackFrameEvidence[],
) {
  const candidates = collectResponsiveSlotMediaAnchorCandidates(paths, callouts);
  authenticateSourceReceipts(paths, callouts, cameras, stacks);
  return bindReferenceResponsiveSlotMediaAnchorFrameEvidenceUnchecked(
    compositionId,
    candidates,
    cameras,
    stacks,
  );
}

/** Authenticate a serialized/structured-cloned link ledger against the exact
 * completed source receipts. Rebuilding the expected ledger prevents a caller
 * from mutating a source identity and merely rehashing the link around it. */
export function validateReferenceResponsiveSlotMediaAnchorFrameEvidence(
  links: readonly ReferenceResponsiveSlotMediaAnchorLinkEvidence[],
  compositionId: string,
  paths: readonly ReferenceAnchoredPathFrameEvidence[],
  callouts: readonly ReferenceCalloutRenderedFrameEvidence[],
  cameras: readonly ReferenceMediaCamera2DExecutionEvidence[],
  stacks: readonly ReferenceResponsiveStackFrameEvidence[],
) {
  const candidates = collectResponsiveSlotMediaAnchorCandidates(paths, callouts);
  authenticateSourceReceipts(paths, callouts, cameras, stacks);
  const expected = bindReferenceResponsiveSlotMediaAnchorFrameEvidenceUnchecked(
    compositionId,
    candidates,
    cameras,
    stacks,
  );
  if (hash(links) !== hash(expected)) {
    throw new Error("CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY: serialized link ledger does not equal the complete recomputed same-frame ledger.");
  }
  return Object.freeze([...links]);
}
