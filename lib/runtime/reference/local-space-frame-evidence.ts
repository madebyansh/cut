import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { compareRational } from "../../language/rational";
import {
  createReferenceLocalSpaceStructuralValidationIndex,
  referenceLocalSpaceFrameEvidence,
  referenceLocalSpacePlacementIdentity,
  referenceLocalSpaceTileIdentity,
  validateReferenceLocalSpaceGraph,
  type ReferenceLocalSpaceConfig,
  type ReferenceLocalSpaceFrameEvidence,
  type ReferenceLocalSpacePlacement,
  type ReferenceLocalSpaceQuantizedOpacitySkipEvidence,
  type ReferenceLocalSpaceStructuralValidationIndex,
  type ReferenceLocalSpaceTransformExecutionEvidence,
} from "./local-space";
import {
  referenceLocalSpaceCompositionTransformPreflight,
  type ReferenceLocalSpaceCompositionTransformPreflightEntry,
  type ReferenceLocalSpaceCompositionTransformPreflightEvidence,
} from "./component-fragment-local-space";
import { planReferenceLocalSpaceAffineTileTransformWork } from "./local-space-transform-work";
import { planReferenceLocalSpaceScaleTranslation } from "./local-space-scale-translation";
import { referenceReachableCompositionNodes } from "./validate";
import {
  validateReferenceCalloutFrameEvidenceSemantics,
  type ReferenceCalloutRenderedFrameEvidence,
} from "./callout";
import {
  referenceLocalSpaceRendererFrameExecutionTreeEvidence,
  referenceLocalSpaceRendererFrameExecutionTreeRecordCount,
  referenceLocalSpaceRendererFrameExecutionEvidence,
  requireReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority,
  maximumLocalPaintSurfaceCacheBytes,
  type ReferenceLocalSpaceRendererFrameExecutionEvidence,
  type ReferenceLocalSpaceRendererFrameExecutionTreeEvidence,
  type ReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority,
  type ReferenceLocalSpaceRendererFrameExecutionTrustedContext,
} from "./visual";

export class ReferenceLocalSpaceFrameEvidenceError extends Error {
  readonly code = "CUT_LOCAL_SPACE_FRAME_EVIDENCE" as const;

  constructor(readonly path: string, message: string) {
    super(`CUT_LOCAL_SPACE_FRAME_EVIDENCE: ${path} ${message}`);
    this.name = "ReferenceLocalSpaceFrameEvidenceError";
  }
}

type ValidationContext = Readonly<{
  ir: CutAVIR;
  rootCompositionId: string;
  structuralIndex?: ReferenceLocalSpaceStructuralValidationIndex;
}>;

type TreeValidationContext = ValidationContext & Readonly<{
  treeEvidence: ReferenceLocalSpaceRendererFrameExecutionTreeEvidence;
  trustedAuthority: ReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority;
}>;

function fail(path: string, message: string): never {
  throw new ReferenceLocalSpaceFrameEvidenceError(path, message);
}

function exactIdentity(candidate: unknown, expected: unknown, path: string, message: string) {
  if (hash(candidate) !== hash(expected)) fail(path, message);
}

function composition(ir: CutAVIR, id: string, path: string) {
  const value = ir.compositions.find((candidate) => candidate.id === id);
  if (!value) fail(path, `references missing composition ${JSON.stringify(id)}.`);
  return value;
}

function executionPathIdentity(receipt: ReferenceLocalSpaceRendererFrameExecutionEvidence) {
  return receipt.executionPath.map((segment) =>
    `${segment.compositionId}\u0000${segment.instanceNodeId ?? ""}\u0000${segment.sourceCompositionId ?? ""}`).join("\u0001");
}

function validateExecutionPath(
  receipt: ReferenceLocalSpaceRendererFrameExecutionEvidence,
  context: ValidationContext,
  reachable: Map<string, ReadonlySet<string>>,
  path: string,
) {
  if (receipt.executionPath[0]?.compositionId !== context.rootCompositionId) {
    fail(`${path}.executionPath[0].compositionId`, `must start at root composition ${JSON.stringify(context.rootCompositionId)}.`);
  }
  for (let index = 0; index < receipt.executionPath.length - 1; index += 1) {
    const segment = receipt.executionPath[index]!;
    const parent = composition(context.ir, segment.compositionId, `${path}.executionPath[${index}].compositionId`);
    let selected = reachable.get(parent.id);
    if (!selected) {
      selected = referenceReachableCompositionNodes(context.ir, parent);
      reachable.set(parent.id, selected);
    }
    const node = segment.instanceNodeId ? context.ir.nodes[segment.instanceNodeId] : undefined;
    if (!node || !selected.has(node.id)
      || (node.op !== "cut.visual.precomp" && node.op !== "cut.edit.nested_sequence")) {
      fail(`${path}.executionPath[${index}].instanceNodeId`, "must identify one reachable public Precomp or NestedSequence instance.");
    }
    const source = node.inputs.source;
    if (source?.kind !== "timeline-ref" || source.id !== segment.sourceCompositionId) {
      fail(`${path}.executionPath[${index}].sourceCompositionId`, "does not match the instance's typed timeline reference.");
    }
  }
  const terminal = receipt.executionPath.at(-1)?.compositionId;
  if (!terminal || receipt.execution.compositionId !== terminal || receipt.preflight.compositionId !== terminal) {
    fail(path, "must pair execution and preflight from its terminal renderer composition.");
  }
}

function rebuiltExecution(receipt: ReferenceLocalSpaceFrameEvidence) {
  return referenceLocalSpaceFrameEvidence({
    compositionId: receipt.compositionId,
    exactTime: receipt.exactTime,
    outputFrame: receipt.outputFrame,
    backendIdentity: receipt.backendIdentity,
    counters: receipt.counters,
    tiles: receipt.tiles,
    placements: receipt.placements,
    skips: receipt.skips,
  });
}

function expectedTransformExecution(
  node: IRNode,
  planned: ReturnType<typeof planReferenceLocalSpaceAffineTileTransformWork>,
  placement: ReferenceLocalSpacePlacement,
  destination: Readonly<{ width: number; height: number }>,
  observedScaleTranslation?: ReferenceLocalSpaceTransformExecutionEvidence["scaleTranslation"],
): ReferenceLocalSpaceTransformExecutionEvidence {
  const scaleTranslationPlan = planReferenceLocalSpaceScaleTranslation(
    node,
    { width: planned.source.width, height: planned.source.height },
    destination,
    placement,
  );
  if (Boolean(scaleTranslationPlan) !== Boolean(observedScaleTranslation)) {
    fail(
      "$.execution.placements[].transformWork.scaleTranslation",
      scaleTranslationPlan
        ? "is required for this destination-clipped scale+translation placement."
        : "must be absent from the neutral, admitted integer-phase, rotated, or skewed placement path.",
    );
  }
  if (scaleTranslationPlan && observedScaleTranslation) {
    exactIdentity(
      {
        algorithmVersion: observedScaleTranslation.algorithmVersion,
        sampler: observedScaleTranslation.sampler,
        projectiveAlgorithmVersion: observedScaleTranslation.projectiveAlgorithmVersion,
        planIdentity: observedScaleTranslation.planIdentity,
        projectivePlanIdentity: observedScaleTranslation.projectivePlanIdentity,
        transformWorkIdentity: observedScaleTranslation.transformWorkIdentity,
        activation: observedScaleTranslation.activation,
        destinationClip: observedScaleTranslation.destinationClip,
        effectiveScale: observedScaleTranslation.effectiveScale,
        legacyTranslationQ16: observedScaleTranslation.legacyTranslationQ16,
      },
      {
        algorithmVersion: scaleTranslationPlan.algorithmVersion,
        sampler: scaleTranslationPlan.sampler,
        projectiveAlgorithmVersion: scaleTranslationPlan.projectiveAlgorithmVersion,
        planIdentity: scaleTranslationPlan.planIdentity,
        projectivePlanIdentity: scaleTranslationPlan.projective?.planIdentity ?? hash({
          algorithmVersion: scaleTranslationPlan.algorithmVersion,
          status: "off-canvas",
          destinationClip: scaleTranslationPlan.destinationClip,
        }),
        transformWorkIdentity: scaleTranslationPlan.transformWorkIdentity,
        activation: scaleTranslationPlan.activation,
        destinationClip: scaleTranslationPlan.destinationClip,
        effectiveScale: scaleTranslationPlan.raster.effectiveScale,
        legacyTranslationQ16: scaleTranslationPlan.raster.legacyTranslationQ16,
      },
      "$.execution.placements[].transformWork.scaleTranslation",
      "does not match the source-derived one-pass scale+translation plan.",
    );
    const work = observedScaleTranslation.observedWork;
    const destinationPixels = destination.width * destination.height;
    const sampledPixels = scaleTranslationPlan.destinationClip.pixels;
    if (work.destinationPixelsTested !== sampledPixels
      || work.insideQuadPixels !== work.integerSamplesCopied + work.bilinearSamplesEvaluated
      || work.insideQuadPixels > sampledPixels
      || work.sourceTapsRead < work.integerSamplesCopied
      || work.sourceTapsRead > work.integerSamplesCopied + work.bilinearSamplesEvaluated * 4
      || work.canvasPixelsAllocated !== destinationPixels
      || work.canvasRgbaBytesAllocated !== destinationPixels * 4
      || work.canvasPixelsCopied < 0
      || work.canvasPixelsCopied > sampledPixels
      || work.canvasRgbaBytesCopied !== work.canvasPixelsCopied * 4) {
      fail(
        "$.execution.placements[].transformWork.scaleTranslation.observedWork",
        "does not close over the bounded direct-affine destination samples.",
      );
    }
  }
  return Object.freeze({
    workIdentity: planned.workIdentity,
    algorithmVersion: planned.algorithmVersion,
    rendererHandoff: "connected-reference-visual-renderer" as const,
    schedulingEnforcement: "reference-visual-renderer-fifo-v1" as const,
    source: Object.freeze({ width: planned.source.width, height: planned.source.height }),
    requestedResize: Object.freeze({ width: planned.requestedResize.width, height: planned.requestedResize.height }),
    sharpCover: Object.freeze({ width: planned.sharpCover.width, height: planned.sharpCover.height }),
    ...(planned.version === 3 ? { skew: Object.freeze({
      width: planned.skew.width,
      height: planned.skew.height,
      skewXDegrees: planned.skew.skewXDegrees,
      skewYDegrees: planned.skew.skewYDegrees,
    }) } : {}),
    rotation: Object.freeze({
      width: planned.rotation.width,
      height: planned.rotation.height,
      canonicalDegrees: planned.rotation.canonicalDegrees,
    }),
    destination: Object.freeze({ ...destination }),
    opacityDestinationCopies: placement.opacity === 1 ? 0 as const : 1 as const,
    ...(observedScaleTranslation ? { scaleTranslation: observedScaleTranslation } : {}),
  });
}

function configOwner(ir: CutAVIR, config: ReferenceLocalSpaceConfig, path: string) {
  const id = config.ownerNodeId ?? config.nodeId, node = ir.nodes[id];
  if (!node) fail(path, `cannot resolve LocalSpace owner ${JSON.stringify(id)}.`);
  return node;
}

function localSpaceConfigs(
  ir: CutAVIR,
  composition: IRComposition,
  structuralIndex: ReferenceLocalSpaceStructuralValidationIndex,
) {
  return validateReferenceLocalSpaceGraph(
    ir,
    composition,
    referenceReachableCompositionNodes(ir, composition),
    { structuralIndex },
  );
}

function validateCounters(execution: ReferenceLocalSpaceFrameEvidence, path: string) {
  const counters = execution.counters;
  for (const counter of [
    "localPaintSurfaceCacheHits",
    "localPaintSurfaceCacheMisses",
    "localPaintSurfaceCacheBypasses",
    "localPaintSurfaceCacheEvictions",
    "localPaintSurfaceCacheResidentBytes",
  ] as const) {
    if (!Number.isSafeInteger(counters[counter]) || counters[counter] < 0) {
      fail(`${path}.counters.${counter}`, "must be a non-negative safe integer.");
    }
  }
  if (counters.localPaintSurfaceCacheResidentBytes > maximumLocalPaintSurfaceCacheBytes
    || counters.localPaintSurfaceCacheResidentBytes % 4 !== 0) {
    fail(`${path}.counters.localPaintSurfaceCacheResidentBytes`,
      `must be a whole rgba8 allocation no larger than ${maximumLocalPaintSurfaceCacheBytes} bytes.`);
  }
  if (counters.localPaintSurfaceCacheMisses + counters.localPaintSurfaceCacheBypasses
    > counters.localNodeRasterizations) {
    fail(`${path}.counters.localPaintSurfaceCacheMisses`,
      "cache misses plus bypasses cannot exceed actual local-node rasterizations.");
  }
  if (counters.tileRequests !== counters.tileRasterizations + counters.tileMemoHits) {
    fail(`${path}.counters.tileRequests`, "must equal rasterizations plus memo hits.");
  }
  if (counters.placementRequests !== counters.placementRasterizations + counters.placementMemoHits) {
    fail(`${path}.counters.placementRequests`, "must equal rasterizations plus memo hits.");
  }
  if (counters.tileRasterizations !== execution.tiles.length) {
    fail(`${path}.tiles`, "must contain one receipt per tile rasterization.");
  }
  if (counters.placementRasterizations !== execution.placements.length) {
    fail(`${path}.placements`, "must contain one receipt per placement rasterization.");
  }
  const tilePixels = execution.tiles.reduce((total, tile) => total + tile.width * tile.height, 0);
  const destinationPixels = execution.placements.reduce((total, placement) =>
    total + placement.destinationWidth * placement.destinationHeight, 0);
  if (counters.tilePixelsRasterized !== tilePixels) fail(`${path}.counters.tilePixelsRasterized`, "does not close over rendered tiles.");
  if (counters.placementDestinationPixels !== destinationPixels) {
    fail(`${path}.counters.placementDestinationPixels`, "does not close over rendered placement canvases.");
  }
  if (counters.localNodeRgbaBytesRasterized !== counters.localNodePixelsRasterized * 4) {
    fail(`${path}.counters.localNodeRgbaBytesRasterized`, "must equal four bytes per local RGBA8 pixel.");
  }
  if (counters.maximumConcurrentTransforms !== (counters.transformExecutions === 0 ? 0 : 1)) {
    fail(`${path}.counters.maximumConcurrentTransforms`, "does not match the installed serialized transform scheduler.");
  }
  for (const [kind, counter] of [
    ["inactive-node", "inactiveNodeSkips"],
    ["owner-opacity", "ownerOpacitySkips"],
    ["owner-policy", "ownerPolicySkips"],
    ["local-node-opacity", "localNodeOpacitySkips"],
  ] as const) {
    if (counters[counter] !== execution.skips.filter((skip) => skip.kind === kind).length) {
      fail(`${path}.counters.${counter}`, `does not close over ${kind} skips.`);
    }
  }
}

function validatePreflightAgainstExecution(
  ir: CutAVIR,
  compositionValue: IRComposition,
  configs: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
  execution: ReferenceLocalSpaceFrameEvidence,
  preflight: ReferenceLocalSpaceCompositionTransformPreflightEvidence,
  path: string,
) {
  if (compareRational(execution.exactTime, preflight.exactTime) !== 0
    || execution.outputFrame !== preflight.outputFrame) {
    fail(path, "execution and preflight do not describe the same exact renderer frame.");
  }
  const tiles = new Map<string, ReferenceLocalSpaceFrameEvidence["tiles"][number]>();
  for (const [index, tile] of execution.tiles.entries()) {
    if (tiles.has(tile.tileIdentity)) fail(`${path}.execution.tiles[${index}].tileIdentity`, "is duplicated.");
    const config = configs.get(tile.nodeId);
    if (!config || tile.width !== config.width || tile.height !== config.height) {
      fail(`${path}.execution.tiles[${index}]`, "does not match one validated LocalSpace tile.");
    }
    tiles.set(tile.tileIdentity, tile);
  }

  const affineOwnerKinds = new Set<ReferenceLocalSpaceConfig["owner"]>([
    "scene-root",
    "component-fragment",
    "group",
    "motion-path",
    "camera-2d",
    "local-space",
    "geo-annotation",
    "callout",
    "track-2d",
    "depth-layer",
  ]);
  const skipKey = (input: Readonly<{
    nodeId: string;
    ownerNodeId: string;
    kind: "owner-opacity" | "owner-policy";
    sampleTime: Readonly<{ numerator: string; denominator: string }>;
  }>) => `${input.nodeId}\u0000${input.ownerNodeId}\u0000${input.kind}\u0000${input.sampleTime.numerator}/${input.sampleTime.denominator}`;
  const quantizedSkipKey = (input: Readonly<{
    nodeId: string;
    ownerNodeId: string;
    sampleTime: Readonly<{ numerator: string; denominator: string }>;
  }>) => `${input.nodeId}\u0000${input.ownerNodeId}\u0000${input.sampleTime.numerator}/${input.sampleTime.denominator}`;
  const remainingOwnerSkips = new Map<string, number>();
  const remainingQuantizedOpacitySkips = new Map<string, Readonly<{
    index: number;
    skip: ReferenceLocalSpaceQuantizedOpacitySkipEvidence;
  }>>();
  for (const [index, skip] of execution.skips.entries()) {
    if (skip.kind !== "owner-opacity" && skip.kind !== "owner-policy") continue;
    const config = configs.get(skip.nodeId);
    if (!config || !affineOwnerKinds.has(config.owner)) continue;
    if (!skip.ownerNodeId) {
      fail(`${path}.execution.skips[${index}].ownerNodeId`, "must identify its affine LocalSpace owner.");
    }
    if (!skip.sampleTime) {
      fail(`${path}.execution.skips[${index}].sampleTime`, "must bind the exact affine renderer sample that was skipped.");
    }
    if (skip.reason === "opacity-quantized-transparent") {
      if (config.owner !== "callout" || skip.kind !== "owner-opacity") {
        fail(`${path}.execution.skips[${index}]`, "quantized transparent admission skips are valid only for Callout-owned LocalSpace.");
      }
      const key = quantizedSkipKey({
        nodeId: skip.nodeId,
        ownerNodeId: skip.ownerNodeId,
        sampleTime: skip.sampleTime,
      });
      if (remainingQuantizedOpacitySkips.has(key)) {
        fail(`${path}.execution.skips[${index}]`, "duplicates one Callout quantized transparent admission skip.");
      }
      remainingQuantizedOpacitySkips.set(key, Object.freeze({ index, skip }));
      continue;
    }
    const key = skipKey({
      nodeId: skip.nodeId,
      ownerNodeId: skip.ownerNodeId,
      kind: skip.kind,
      sampleTime: skip.sampleTime,
    });
    remainingOwnerSkips.set(key, (remainingOwnerSkips.get(key) ?? 0) + 1);
  }

  const unusedPlacements = new Set(execution.placements.map((_, index) => index));
  const rebuiltEntries: ReferenceLocalSpaceCompositionTransformPreflightEntry[] = [];
  for (const [index, admission] of preflight.admissions.entries()) {
    const config = configs.get(admission.localSpaceNodeId);
    if (!config || config.owner !== admission.ownerKind) {
      fail(`${path}.preflight.admissions[${index}]`, "does not match a validated LocalSpace owner.");
    }
    const owner = configOwner(ir, config, `${path}.preflight.admissions[${index}].ownerNodeId`);
    if (owner.id !== admission.ownerNodeId) {
      fail(`${path}.preflight.admissions[${index}].ownerNodeId`, "does not match the validated LocalSpace owner.");
    }
    const expectedTileIdentity = referenceLocalSpaceTileIdentity(config, admission.sampleTime, execution.backendIdentity);
    const placementIndex = [...unusedPlacements].find((candidate) => {
      const placement = execution.placements[candidate]!;
      return placement.nodeId === config.nodeId
        && placement.owner === config.owner
        && placement.tileIdentity === expectedTileIdentity
        && placement.transformWork?.workIdentity === admission.work.workIdentity;
    });
    if (placementIndex === undefined) {
      const quantizedKey = quantizedSkipKey({
        nodeId: config.nodeId,
        ownerNodeId: owner.id,
        sampleTime: admission.sampleTime,
      });
      const quantized = remainingQuantizedOpacitySkips.get(quantizedKey);
      if (config.owner !== "callout" || !quantized) {
        fail(`${path}.preflight.admissions[${index}]`, "has no one-to-one executed placement or explicit Callout quantized-transparent skip with the same owner, tile, and work identity.");
      }
      remainingQuantizedOpacitySkips.delete(quantizedKey);
      const skip = quantized.skip;
      if (skip.tileIdentity !== expectedTileIdentity
        || skip.admissionPlanIdentity !== admission.planIdentity
        || skip.destinationWidth !== compositionValue.width
        || skip.destinationHeight !== compositionValue.height
        || skip.placement.owner !== "callout") {
        fail(`${path}.execution.skips[${quantized.index}]`, "does not bind its exact admitted Callout tile, plan, destination, and placement owner.");
      }
      const tile = tiles.get(skip.tileIdentity);
      if (!tile || tile.nodeId !== config.nodeId) {
        fail(`${path}.execution.skips[${quantized.index}].tileIdentity`, "does not resolve to the retained Callout tile materialized in this renderer invocation.");
      }
      const request = Object.freeze({
        source: Object.freeze({ width: config.width, height: config.height }),
        destination: Object.freeze({
          width: skip.destinationWidth,
          height: skip.destinationHeight,
        }),
        scale: skip.placement.scale,
        skewX: skip.placement.skewX,
        skewY: skip.placement.skewY,
        rotation: skip.placement.rotation,
        opacity: skip.placement.opacity,
      });
      const planned = planReferenceLocalSpaceAffineTileTransformWork(owner, request);
      exactIdentity(
        admission.work,
        planned,
        `${path}.preflight.admissions[${index}].work`,
        "does not match the public transform planner for its quantized-transparent admission.",
      );
      const placementIdentity = referenceLocalSpacePlacementIdentity(
        config,
        skip.tileIdentity,
        skip.placement,
        admission.work.workIdentity,
      );
      if (skip.placementIdentity !== placementIdentity) {
        fail(`${path}.execution.skips[${quantized.index}].placementIdentity`, "does not bind its exact admitted tile, placement descriptor, and transform work.");
      }
      rebuiltEntries.push(Object.freeze({
        owner,
        localSpace: config,
        ownerKind: admission.ownerKind,
        exactTime: admission.sampleTime,
        status: "visible" as const,
        transform: request,
      }));
      continue;
    }
    unusedPlacements.delete(placementIndex);
    const observed = execution.placements[placementIndex]!, transform = observed.transform;
    if (!transform || !observed.transformWork) {
      fail(`${path}.execution.placements[${placementIndex}]`, "omits its admitted transform execution.");
    }
    const tile = tiles.get(observed.tileIdentity);
    if (!tile || tile.nodeId !== config.nodeId) {
      fail(`${path}.execution.placements[${placementIndex}].tileIdentity`, "does not resolve to its LocalSpace tile.");
    }
    const placement: ReferenceLocalSpacePlacement = Object.freeze({
      owner: observed.owner,
      contextIdentity: observed.contextIdentity,
      destinationX: transform.destinationX,
      destinationY: transform.destinationY,
      registrationRasterX: transform.registrationRasterX,
      registrationRasterY: transform.registrationRasterY,
      scale: transform.scale,
      skewX: transform.skewX,
      skewY: transform.skewY,
      rotation: transform.rotation,
      opacity: transform.opacity,
    });
    const request = Object.freeze({
      source: Object.freeze({ width: config.width, height: config.height }),
      destination: Object.freeze({ width: observed.destinationWidth, height: observed.destinationHeight }),
      scale: placement.scale,
      skewX: placement.skewX,
      skewY: placement.skewY,
      rotation: placement.rotation,
      opacity: placement.opacity,
    });
    const planned = planReferenceLocalSpaceAffineTileTransformWork(owner, request);
    exactIdentity(admission.work, planned, `${path}.preflight.admissions[${index}].work`, "does not match the public transform planner.");
    exactIdentity(
      observed.transformWork,
      expectedTransformExecution(owner, planned, placement, {
        width: observed.destinationWidth,
        height: observed.destinationHeight,
      }, observed.transformWork.scaleTranslation),
      `${path}.execution.placements[${placementIndex}].transformWork`,
      "does not match the admitted work and observed transform geometry.",
    );
    const placementIdentity = referenceLocalSpacePlacementIdentity(
      config,
      observed.tileIdentity,
      placement,
      admission.work.workIdentity,
    );
    if (observed.placementIdentity !== placementIdentity) {
      fail(`${path}.execution.placements[${placementIndex}].placementIdentity`, "does not bind its exact tile, placement, and admitted work.");
    }
    rebuiltEntries.push(Object.freeze({
      owner,
      localSpace: config,
      ownerKind: admission.ownerKind,
      exactTime: admission.sampleTime,
      status: "visible" as const,
      transform: request,
    }));
  }
  if (unusedPlacements.size) {
    fail(`${path}.execution.placements`, "contains an affine placement without a one-to-one composition admission.");
  }
  if (remainingQuantizedOpacitySkips.size) {
    fail(`${path}.execution.skips`, "contains an unmatched Callout quantized-transparent skip outside the composition preflight.");
  }

  for (const [index, skip] of preflight.skips.entries()) {
    const config = configs.get(skip.localSpaceNodeId);
    if (!config || config.owner !== skip.ownerKind) {
      fail(`${path}.preflight.skips[${index}]`, "does not match a validated LocalSpace owner.");
    }
    const owner = configOwner(ir, config, `${path}.preflight.skips[${index}].ownerNodeId`);
    if (owner.id !== skip.ownerNodeId) {
      fail(`${path}.preflight.skips[${index}].ownerNodeId`, "does not match the validated LocalSpace owner.");
    }
    const kind = skip.status === "opacity-zero" ? "owner-opacity" as const : "owner-policy" as const;
    const key = skipKey({
      nodeId: config.nodeId,
      ownerNodeId: owner.id,
      kind,
      sampleTime: skip.sampleTime,
    });
    const remaining = remainingOwnerSkips.get(key) ?? 0;
    if (remaining < 1) {
      fail(`${path}.preflight.skips[${index}]`, "has no one-to-one executed owner skip at the same exact sample time.");
    }
    if (remaining === 1) remainingOwnerSkips.delete(key);
    else remainingOwnerSkips.set(key, remaining - 1);
    rebuiltEntries.push(Object.freeze({
      owner,
      localSpace: config,
      ownerKind: skip.ownerKind,
      exactTime: skip.sampleTime,
      status: skip.status,
      ...(skip.policyHiddenBy ? { policyHiddenBy: skip.policyHiddenBy } : {}),
    }));
  }
  if (remainingOwnerSkips.size) {
    fail(`${path}.execution.skips`, "contains an unmatched affine owner skip outside the composition preflight.");
  }

  const rebuilt = referenceLocalSpaceCompositionTransformPreflight(ir, compositionValue, {
    sceneId: preflight.sceneId,
    exactTime: preflight.exactTime,
    ...(preflight.outputFrame === undefined ? {} : { outputFrame: preflight.outputFrame }),
  }, rebuiltEntries);
  exactIdentity(preflight, rebuilt, `${path}.preflight`, "does not reproduce from locked IR, executed placements, and public admission semantics.");
}

export function validateReferenceLocalSpaceRendererFrameExecutionSemantics(
  receipt: ReferenceLocalSpaceRendererFrameExecutionEvidence,
  trustedContext: ReferenceLocalSpaceRendererFrameExecutionTrustedContext,
  context: ValidationContext,
  state?: Readonly<{
    structuralIndex: ReferenceLocalSpaceStructuralValidationIndex;
    configs: Map<string, ReadonlyMap<string, ReferenceLocalSpaceConfig>>;
    reachable: Map<string, ReadonlySet<string>>;
  }>,
) {
  const path = "$";
  if (trustedContext.authority !== "locked-ir-and-live-frame-execution") {
    fail("$.trustedContext.authority", "must be the independently retained locked live-frame authority.");
  }
  exactIdentity(receipt, trustedContext.expected, "$.trustedContext.expected", "does not match the independently retained live-frame evidence.");
  validateExecutionPath(receipt, context, state?.reachable ?? new Map(), path);
  const rebuiltWrapper = referenceLocalSpaceRendererFrameExecutionEvidence({
    executionPath: receipt.executionPath,
    execution: receipt.execution,
    preflight: receipt.preflight,
  });
  if (rebuiltWrapper.rendererFrameIdentity !== receipt.rendererFrameIdentity) {
    fail("$.rendererFrameIdentity", "does not bind the renderer path and paired receipts.");
  }
  const execution = rebuiltExecution(receipt.execution);
  if (execution.executionIdentity !== receipt.execution.executionIdentity) {
    fail("$.execution.executionIdentity", "does not bind the closed semantic completed-frame records.");
  }
  if (execution.observationIdentity !== receipt.execution.observationIdentity) {
    fail("$.execution.observationIdentity", "does not bind the exact cache and raster observations.");
  }
  validateCounters(receipt.execution, "$.execution");
  const compositionValue = composition(context.ir, receipt.execution.compositionId, "$.execution.compositionId");
  const structuralIndex = state?.structuralIndex ?? context.structuralIndex ?? createReferenceLocalSpaceStructuralValidationIndex(context.ir);
  const configsByComposition = state?.configs ?? new Map<string, ReadonlyMap<string, ReferenceLocalSpaceConfig>>();
  let configs = configsByComposition.get(compositionValue.id);
  if (!configs) {
    configs = localSpaceConfigs(context.ir, compositionValue, structuralIndex);
    configsByComposition.set(compositionValue.id, configs);
  }
  validatePreflightAgainstExecution(context.ir, compositionValue, configs, receipt.execution, receipt.preflight, path);
  return receipt;
}

export function validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics(
  receipts: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[],
  context: TreeValidationContext,
) {
  let authority: ReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority;
  try {
    authority = requireReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority(context.trustedAuthority);
  } catch (error) {
    fail("$.trustedAuthority", error instanceof Error ? error.message : String(error));
  }
  if (authority.ir !== context.ir || authority.rootCompositionId !== context.rootCompositionId) {
    fail("$.trustedAuthority", "belongs to a different locked IR object or root composition.");
  }
  if (receipts !== authority.executions) {
    fail("$", "must be the exact complete ordered receipt array issued by the locked live renderer invocation.");
  }
  if (receipts.length < 1 || receipts.length !== authority.expectedReceipts.length) {
    fail("$", "must contain every root and nested renderer execution from the locked live-frame authority.");
  }
  exactIdentity(context.treeEvidence, authority.expectedTree, "$.treeEvidence", "does not match the locked live-frame renderer-tree authority.");
  if (context.treeEvidence.rendererFrameCount !== receipts.length) {
    fail("$.treeEvidence.rendererFrameCount", "must equal the serialized renderer execution count.");
  }
  let rebuiltTree: ReferenceLocalSpaceRendererFrameExecutionTreeEvidence;
  try {
    rebuiltTree = referenceLocalSpaceRendererFrameExecutionTreeEvidence(context.rootCompositionId, receipts);
  } catch (error) {
    fail("$.treeEvidence", error instanceof Error ? error.message : String(error));
  }
  exactIdentity(context.treeEvidence, rebuiltTree, "$.treeEvidence", "does not close over the ordered renderer paths and frame identities.");
  const structuralIndex = context.structuralIndex ?? createReferenceLocalSpaceStructuralValidationIndex(context.ir);
  const state = {
    structuralIndex,
    configs: new Map<string, ReadonlyMap<string, ReferenceLocalSpaceConfig>>(),
    reachable: new Map<string, ReadonlySet<string>>(),
  };
  const paths = new Set<string>();
  const validated = receipts.map((receipt, index) => {
    const identity = executionPathIdentity(receipt);
    if (paths.has(identity)) fail(`$[${index}].executionPath`, "duplicates another renderer-instance path.");
    paths.add(identity);
    return validateReferenceLocalSpaceRendererFrameExecutionSemantics(
      receipt,
      Object.freeze({
        authority: "locked-ir-and-live-frame-execution" as const,
        expected: authority.expectedReceipts[index]!,
      }),
      context,
      state,
    );
  });
  if (validated[0]?.executionPath.length !== 1
    || validated[0]?.executionPath[0]?.compositionId !== context.rootCompositionId) {
    fail("$[0].executionPath", "must be the root renderer entry.");
  }
  return Object.freeze(validated);
}

export const currentReferenceFrameExecutionEvidenceProfile = "cut-reference-frame-execution/current-v2" as const;

/** Strict persisted-current-profile closure. This is an integrity check, not a
 * signature: same-process authenticity is established separately by the
 * private live authority above, while stored artifacts are externally bound by
 * their manifest digest or reproduced by deterministic rerender. */
export function validateCurrentReferenceFrameLocalSpaceExecutionTree(manifest: unknown) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("$", "current frame manifest must be one object.");
  }
  const execution = (manifest as { execution?: unknown }).execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    fail("$.execution", "current frame manifest must contain one execution object.");
  }
  const value = execution as {
    evidenceProfile?: unknown;
    localSpaces?: unknown;
    localSpaceTransformPreflight?: unknown;
    localSpaceExecutionTree?: unknown;
    localSpaceExecutions?: unknown;
    calloutLayers?: unknown;
  };
  if (value.evidenceProfile !== currentReferenceFrameExecutionEvidenceProfile) {
    fail("$.execution.evidenceProfile", `must equal ${JSON.stringify(currentReferenceFrameExecutionEvidenceProfile)}.`);
  }
  if (!Array.isArray(value.localSpaces) || value.localSpaces.length !== 1) {
    fail("$.execution.localSpaces", "must retain exactly the root renderer's frozen-compatible execution receipt.");
  }
  if (!value.localSpaceTransformPreflight || typeof value.localSpaceTransformPreflight !== "object"
    || Array.isArray(value.localSpaceTransformPreflight)) {
    fail("$.execution.localSpaceTransformPreflight", "must retain the root renderer affine preflight.");
  }
  if (!Array.isArray(value.localSpaceExecutions) || value.localSpaceExecutions.length < 1) {
    fail("$.execution.localSpaceExecutions", "must contain the complete ordered renderer execution tree.");
  }
  if (!value.localSpaceExecutionTree || typeof value.localSpaceExecutionTree !== "object"
    || Array.isArray(value.localSpaceExecutionTree)) {
    fail("$.execution.localSpaceExecutionTree", "must contain the closed renderer-tree summary.");
  }
  const receipts = value.localSpaceExecutions as readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[];
  const tree = value.localSpaceExecutionTree as ReferenceLocalSpaceRendererFrameExecutionTreeEvidence;
  const hasCalloutOwnerEvidence = receipts.some((receipt) =>
    receipt.preflight.admissions.some((entry) => entry.ownerKind === "callout")
    || receipt.preflight.skips.some((entry) => entry.ownerKind === "callout")
    || receipt.execution.placements.some((entry) => entry.owner === "callout"));
  if (hasCalloutOwnerEvidence
    && (!Array.isArray(value.calloutLayers) || value.calloutLayers.length < 1)) {
    fail(
      "$.execution.calloutLayers",
      "is required when the renderer tree contains Callout-owned LocalSpace admission, skip, or placement evidence.",
    );
  }
  try {
    referenceLocalSpaceRendererFrameExecutionTreeRecordCount(receipts);
  } catch (error) {
    fail("$.execution.localSpaceExecutions", error instanceof Error ? error.message : String(error));
  }
  for (const [index, receipt] of receipts.entries()) {
    let rebuilt: ReferenceLocalSpaceRendererFrameExecutionEvidence;
    try {
      rebuilt = referenceLocalSpaceRendererFrameExecutionEvidence({
        executionPath: receipt.executionPath,
        execution: receipt.execution,
        preflight: receipt.preflight,
      });
    } catch (error) {
      fail(`$.execution.localSpaceExecutions[${index}]`, error instanceof Error ? error.message : String(error));
    }
    exactIdentity(receipt, rebuilt, `$.execution.localSpaceExecutions[${index}]`, "does not close over its renderer path, execution, and preflight.");
    const closedExecution = rebuiltExecution(receipt.execution);
    if (closedExecution.executionIdentity !== receipt.execution.executionIdentity) {
      fail(`$.execution.localSpaceExecutions[${index}].execution.executionIdentity`, "does not close over its completed-frame records.");
    }
    if (closedExecution.observationIdentity !== receipt.execution.observationIdentity) {
      fail(`$.execution.localSpaceExecutions[${index}].execution.observationIdentity`, "does not close over its exact cache and raster observations.");
    }
    validateCounters(receipt.execution, `$.execution.localSpaceExecutions[${index}].execution`);
  }
  let rebuiltTree: ReferenceLocalSpaceRendererFrameExecutionTreeEvidence;
  try {
    rebuiltTree = referenceLocalSpaceRendererFrameExecutionTreeEvidence(tree.rootCompositionId, receipts);
  } catch (error) {
    fail("$.execution.localSpaceExecutionTree", error instanceof Error ? error.message : String(error));
  }
  exactIdentity(tree, rebuiltTree, "$.execution.localSpaceExecutionTree", "does not close over the complete ordered renderer execution tree.");
  exactIdentity(receipts[0]!.execution, value.localSpaces[0], "$.execution.localSpaces[0]", "does not match the root renderer-tree execution.");
  exactIdentity(receipts[0]!.preflight, value.localSpaceTransformPreflight, "$.execution.localSpaceTransformPreflight", "does not match the root renderer-tree preflight.");
  if (value.calloutLayers !== undefined) {
    if (!Array.isArray(value.calloutLayers)) {
      fail("$.execution.calloutLayers", "must be an array when present.");
    }
    const receiptByPath = new Map(receipts.map((receipt) => [
      receipt.executionPath.map((segment) =>
        `${segment.compositionId}\u0000${segment.instanceNodeId ?? ""}\u0000${segment.sourceCompositionId ?? ""}`).join("\u0001"),
      receipt,
    ]));
    for (const [layerIndex, unknownLayer] of value.calloutLayers.entries()) {
      if (!unknownLayer || typeof unknownLayer !== "object" || Array.isArray(unknownLayer)) {
        fail(`$.execution.calloutLayers[${layerIndex}]`, "must be one Callout frame receipt.");
      }
      try {
        validateReferenceCalloutFrameEvidenceSemantics(
          unknownLayer as ReferenceCalloutRenderedFrameEvidence,
        );
      } catch (error) {
        fail(
          `$.execution.calloutLayers[${layerIndex}]`,
          error instanceof Error ? error.message : String(error),
        );
      }
      const layer = unknownLayer as {
        compositionId?: unknown;
        sceneId?: unknown;
        sceneLocalTime?: unknown;
        outputFrame?: unknown;
        executionPath?: unknown;
        decisions?: unknown;
      };
      if (!Array.isArray(layer.executionPath)) {
        fail(`$.execution.calloutLayers[${layerIndex}].executionPath`, "must identify its renderer instance.");
      }
      const key = layer.executionPath.map((unknownSegment, segmentIndex) => {
        if (!unknownSegment || typeof unknownSegment !== "object" || Array.isArray(unknownSegment)) {
          fail(`$.execution.calloutLayers[${layerIndex}].executionPath[${segmentIndex}]`, "must be one renderer path segment.");
        }
        const segment = unknownSegment as {
          compositionId?: unknown;
          instanceNodeId?: unknown;
          sourceCompositionId?: unknown;
        };
        return `${String(segment.compositionId ?? "")}\u0000${String(segment.instanceNodeId ?? "")}\u0000${String(segment.sourceCompositionId ?? "")}`;
      }).join("\u0001");
      const receipt = receiptByPath.get(key);
      if (!receipt) {
        fail(`$.execution.calloutLayers[${layerIndex}].executionPath`, "has no matching LocalSpace renderer execution.");
      }
      if (layer.compositionId !== receipt.execution.compositionId
        || layer.sceneId !== receipt.preflight.sceneId
        || layer.outputFrame !== receipt.execution.outputFrame
        || hash(layer.sceneLocalTime) !== hash(receipt.execution.exactTime)) {
        fail(`$.execution.calloutLayers[${layerIndex}]`, "does not share its terminal LocalSpace composition, scene, exact local time, and output frame.");
      }
      if (!Array.isArray(layer.decisions)) {
        fail(`$.execution.calloutLayers[${layerIndex}].decisions`, "must be an array.");
      }
      for (const [decisionIndex, unknownDecision] of layer.decisions.entries()) {
        if (!unknownDecision || typeof unknownDecision !== "object" || Array.isArray(unknownDecision)) {
          fail(`$.execution.calloutLayers[${layerIndex}].decisions[${decisionIndex}]`, "must be one Callout decision.");
        }
        const decision = unknownDecision as {
          nodeId?: unknown;
          localSpaceNodeId?: unknown;
          status?: unknown;
          renderedDecision?: {
            status?: unknown;
            tile?: {
              tileIdentity?: unknown;
              admittedPlacementIdentity?: unknown;
              affinePlanIdentity?: unknown;
              transformWorkIdentity?: unknown;
              width?: unknown;
              height?: unknown;
            };
          };
        };
        if (decision.status !== "accepted" || !decision.renderedDecision?.tile) continue;
        const tile = decision.renderedDecision.tile;
        const admission = receipt.preflight.admissions.find((entry) =>
          entry.ownerKind === "callout"
          && entry.ownerNodeId === decision.nodeId
          && entry.localSpaceNodeId === decision.localSpaceNodeId);
        if (!admission
          || admission.planIdentity !== tile.affinePlanIdentity
          || admission.work.workIdentity !== tile.transformWorkIdentity) {
          fail(
            `$.execution.calloutLayers[${layerIndex}].decisions[${decisionIndex}].renderedDecision.tile`,
            "does not bind its exact Callout affine admission and transform work.",
          );
        }
        const renderedTile = receipt.execution.tiles.find((entry) =>
          entry.nodeId === decision.localSpaceNodeId && entry.tileIdentity === tile.tileIdentity);
        if (!renderedTile || renderedTile.width !== tile.width || renderedTile.height !== tile.height) {
          fail(
            `$.execution.calloutLayers[${layerIndex}].decisions[${decisionIndex}].renderedDecision.tile`,
            "does not match the LocalSpace tile materialized by the same renderer invocation.",
          );
        }
        const placement = receipt.execution.placements.find((entry) =>
          entry.owner === "callout"
          && entry.nodeId === decision.localSpaceNodeId
          && entry.tileIdentity === tile.tileIdentity);
        const quantizedSkip = receipt.execution.skips.find(
          (entry): entry is ReferenceLocalSpaceQuantizedOpacitySkipEvidence =>
          entry.reason === "opacity-quantized-transparent"
          && entry.nodeId === decision.localSpaceNodeId
          && entry.ownerNodeId === decision.nodeId
          && entry.tileIdentity === tile.tileIdentity,
        );
        if (decision.renderedDecision.status === "painted") {
          if (!placement
            || placement.placementIdentity !== tile.admittedPlacementIdentity
            || placement.transformWork?.workIdentity !== tile.transformWorkIdentity
            || quantizedSkip) {
            fail(
              `$.execution.calloutLayers[${layerIndex}].decisions[${decisionIndex}].renderedDecision.tile`,
              "does not bind the exact painted LocalSpace placement from the same renderer invocation.",
            );
          }
        } else {
          if (placement) {
            fail(
              `$.execution.calloutLayers[${layerIndex}].decisions[${decisionIndex}].renderedDecision`,
              "claims opacity-quantized-transparent while a Callout placement was rasterized.",
            );
          }
          if (!quantizedSkip
            || quantizedSkip.admissionPlanIdentity !== tile.affinePlanIdentity
            || quantizedSkip.placementIdentity !== tile.admittedPlacementIdentity
            || hash(quantizedSkip.sampleTime) !== hash(receipt.execution.exactTime)) {
            fail(
              `$.execution.calloutLayers[${layerIndex}].decisions[${decisionIndex}].renderedDecision.tile`,
              "does not bind the explicit zero-transform Callout quantized-opacity admission skip.",
            );
          }
        }
      }
    }
  }
  return manifest;
}
