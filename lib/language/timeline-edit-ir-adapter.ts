import { hash } from "../core/stable";
import type {
  CutAVIR,
  IREditorial,
  IREditorialInterval,
  IRNode,
  IRProvenance,
  IRValue,
} from "./ir";
import {
  executeTimelineEditPlan,
  timelineEditOperationsFromInput,
  TimelineEditError,
  type TimelineEditExecutionV1,
  type TimelineEditItemV1,
  type TimelineEditPlanV1,
  type TimelineEditSourceView,
  type TimelineEditTrackV1,
} from "./timeline-edit-operations";
import {
  compareRational,
  divideRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";

export type TimelineEditIrRequestV1 = Readonly<{
  id: string;
  compositionId: string;
  sceneId: string;
  duration?: Rational;
  operations: readonly IRValue[];
  operationProvenances: readonly IRProvenance[];
  provenance: IRProvenance;
}>;

export type TimelineEditIrTrackBindingV1 = Readonly<{
  trackNodeId: string;
  trackId: string;
  kind: "picture-track" | "audio-track";
}>;

export type TimelineEditIrStageV1 = Readonly<{
  plan: TimelineEditPlanV1;
  execution: TimelineEditExecutionV1;
  trackBindings: readonly TimelineEditIrTrackBindingV1[];
  stageIdentity: string;
}>;

function fail(
  code: TimelineEditError["code"],
  path: string,
  message: string,
): never {
  throw new TimelineEditError(code, message, path);
}

function same(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function timeInput(node: IRNode, name: string, fallback = zeroRational) {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== "time") {
    fail("CUT_TIMELINE_EDIT_SHAPE", `$.nodes.${node.id}.inputs.${name}`, "must be one exact Time.");
  }
  return value.magnitude;
}

function authorityId(kind: string, content: unknown) {
  return `${kind}_${hash(content).slice(0, 24)}`;
}

export const timelineEditStaticPrecompPresentationInputNames = Object.freeze([
  "x",
  "y",
  "scale",
  "rotation",
  "opacity",
] as const);

export const timelineEditStaticPrecompInputNames = Object.freeze([
  "source",
  "range",
  ...timelineEditStaticPrecompPresentationInputNames,
] as const);

const timelineEditStaticPrecompInputs: ReadonlySet<string> = new Set(
  timelineEditStaticPrecompInputNames,
);

/**
 * Closed nested operand shape for canonical same-track placement copy.
 * Editorial editId/role/metadata are compiler-only attributes and never reach
 * this renderer node. Structural slicing separately preserves authenticated
 * static presentation inputs. The complete public Precomp presentation
 * allowlist remains copyable because it is immutable, authority-bound, and
 * cloned verbatim by materialization. Dynamic properties, children, effects,
 * and unknown inputs never gain this capability.
 */
export function isTimelineEditStaticPrecompOperand(node: IRNode) {
  return node.op === "cut.visual.precomp"
    && node.domain === "visual"
    && node.children.length === 0
    && Object.keys(node.properties).length === 0
    && node.effects.length === 1
    && node.effects[0] === "pure"
    && Object.keys(node.inputs).every((name) =>
      timelineEditStaticPrecompInputs.has(name));
}

const timelineEditableSourceInputs = new Set([
  "duration",
  "range",
  "destination",
  "link",
  "headHandle",
  "tailHandle",
  "fadeIn",
  "fadeOut",
  "playback",
  "rate",
  "freezeAt",
  "speedRamp",
  // Authority-backed TranscriptPicture owns one immutable transcript/media
  // origin while each canonical structural slice derives a fresh segment
  // identity from its exact source/destination/time-map tuple.
  "transcriptPictureSegmentIdentity",
]);

/**
 * One edit-invariant source authority. Placement, source-window, declared
 * handles, fades and time maps live explicitly in TimelineEditSourceView and
 * therefore must not make source lineage change merely because the canonical
 * algebra slices or moves a clip. Resource declaration identity and every
 * remaining executable node input/property/effect are authenticated here.
 * The applied cut.lock and verified-input session independently bind immutable
 * resource bytes; lock application must not rewrite this pre-lock edit
 * lineage into a different semantic transaction.
 */
export function timelineEditSourceAuthority(ir: CutAVIR, node: IRNode) {
  const resourceIds = Object.values(node.inputs)
    .flatMap((value) => value.kind === "resource-ref" ? [value.id] : [])
    .sort();
  const invariantInputs = Object.fromEntries(
    Object.entries(node.inputs)
      .filter(([name]) => !timelineEditableSourceInputs.has(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return authorityId("authority", {
    version: 2,
    node: {
      op: node.op,
      inputs: invariantInputs,
      properties: node.properties,
      effects: node.effects,
    },
    resources: resourceIds.map((id) => {
      const resource = ir.resources[id];
      return resource
        ? { id, kind: resource.kind, locator: resource.locator }
        : { id, missing: true };
    }),
  });
}

function processorChain(ir: CutAVIR, region: IRNode, sourceNodeId: string) {
  if (region.children.length !== 1) {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.nodes.${region.id}`, "processed AudioRegion requires one closed single-child processor chain.");
  }
  const chain: string[] = [];
  const seen = new Set<string>([region.id]);
  let current = ir.nodes[region.children[0]!];
  while (current && current.id !== sourceNodeId) {
    if (seen.has(current.id) || current.children.length !== 1 || current.domain !== "audio") {
      fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.nodes.${region.id}`, "processed AudioRegion chain must be bounded, acyclic, and single-child.");
    }
    seen.add(current.id);
    chain.push(current.id);
    current = ir.nodes[current.children[0]!];
  }
  if (!current || current.id !== sourceNodeId || current.op !== "cut.audio.clip") {
    fail("CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${region.id}`, "processed AudioRegion lost its exact AudioClip source leaf.");
  }
  return { source: current, processors: chain };
}

/** Recompute the exact processed-chain authority at compile and runtime. The
 * exported helper prevents the strict validator from drifting to a second
 * graph-identity law. */
export function timelineEditProcessedGraphAuthority(
  ir: CutAVIR,
  region: IRNode,
  sourceNodeId: string,
) {
  const chain = processorChain(ir, region, sourceNodeId);
  const graphAuthorityId = authorityId("graph", {
    version: 2,
    // Node contentHash intentionally includes lock-expanded resource bytes for
    // render/cache invalidation. Canonical edit lineage is authored before
    // cut.lock is applied, so this authority binds the same executable graph
    // semantics without importing that later lock-state transition.
    region: {
      id: region.id,
      op: region.op,
      inputs: region.inputs,
      properties: region.properties,
      effects: region.effects,
      children: region.children,
    },
    source: {
      id: chain.source.id,
      authorityId: timelineEditSourceAuthority(ir, chain.source),
    },
    processors: chain.processors.map((id) => {
      const processor = ir.nodes[id]!;
      return {
        id,
        op: processor.op,
        inputs: processor.inputs,
        properties: processor.properties,
        effects: processor.effects,
        children: processor.children,
      };
    }),
  });
  return Object.freeze({
    source: chain.source,
    processors: Object.freeze(chain.processors),
    graphAuthorityId,
  });
}

function relativeInterval(interval: IREditorialInterval, origin: Rational) {
  return { start: subtractRational(interval.start, origin), duration: interval.duration };
}

function sourceView(
  ir: CutAVIR,
  track: IRNode,
  editorial: Extract<IREditorial, { kind: "picture-track" | "audio-track" }>,
  item: typeof editorial.items[number],
  node: IRNode,
): TimelineEditSourceView {
  if (item.kind === "gap") {
    return {
      kind: "gap",
      authorityId: authorityId("gap", { trackId: track.id, nodeId: node.id, contentHash: node.contentHash }),
    };
  }
  if (!item.source) fail("CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${track.id}.editorial.items`, "media item is missing its exact source interval.");
  const handles = {
    head: timeInput(node, "headHandle"),
    tail: timeInput(node, "tailHandle"),
  };
  if (editorial.kind === "picture-track") {
    if (item.kind !== "picture") {
      fail("CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${track.id}.editorial.items`, "picture track contains a non-picture media item.");
    }
    if (node.op === "cut.visual.precomp") {
      const source = node.inputs.source;
      if (source?.kind !== "timeline-ref") {
        fail("CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${node.id}.inputs.source`, "Precomp nested operand lost its exact source composition.");
      }
      return {
        kind: "nested",
        nodeId: node.id,
        compositionId: source.id,
        source: { ...item.source },
        handles,
        authorityId: timelineEditSourceAuthority(ir, node),
        rate: rational(1),
        sharedClock: true,
        placementPolicy: isTimelineEditStaticPrecompOperand(node)
          ? "static-same-track-copy"
          : "structural-only",
      };
    }
    return {
      kind: "picture",
      nodeId: node.id,
      source: { ...item.source },
      handles,
      authorityId: timelineEditSourceAuthority(ir, node),
      timeMap: item.timeMap ?? { kind: "constant", direction: "forward", rate: rational(1) },
    };
  }
  if (item.kind !== "audio") {
    fail("CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${track.id}.editorial.items`, "audio track contains a non-audio media item.");
  }
  const sourceNodeId = item.sourceNodeId;
  if (sourceNodeId) {
    const chain = timelineEditProcessedGraphAuthority(ir, node, sourceNodeId);
    return {
      kind: "processed-audio",
      regionId: node.id,
      sourceNodeId,
      processorNodeIds: chain.processors,
      graphAuthorityId: chain.graphAuthorityId,
      source: { ...item.source },
      handles,
      authorityId: timelineEditSourceAuthority(ir, chain.source),
      rate: divideRational(item.source.duration, item.destination.duration),
      fadeIn: timeInput(chain.source, "fadeIn"),
      fadeOut: timeInput(chain.source, "fadeOut"),
      presentationClock: {
        originDuration: item.destination.duration,
        sliceOffset: zeroRational,
        fadePolicy: "origin-relative",
      },
      statePolicy: "single-authorized-evaluation",
    };
  }
  return {
    kind: "audio",
    nodeId: node.id,
    source: { ...item.source },
    handles,
    authorityId: timelineEditSourceAuthority(ir, node),
    rate: divideRational(item.source.duration, item.destination.duration),
    fadeIn: timeInput(node, "fadeIn"),
    fadeOut: timeInput(node, "fadeOut"),
    presentationClock: {
      originDuration: item.destination.duration,
      sliceOffset: zeroRational,
      fadePolicy: "origin-relative",
    },
  };
}

function sequencePictureOrders(ir: CutAVIR, sceneId: string) {
  const result = new Map<string, number>();
  const sequences = Object.values(ir.nodes)
    .filter((node): node is IRNode & { editorial: Extract<IREditorial, { kind: "sequence" }> } =>
      node.sceneId === sceneId && node.editorial?.kind === "sequence")
    .sort((left, right) => left.id.localeCompare(right.id));
  let base = 0;
  for (const sequence of sequences) {
    for (const item of sequence.editorial.tracks) result.set(item.nodeId, base + item.order);
    base += sequence.editorial.tracks.length;
  }
  return result;
}

function selectedTrackIds(operations: TimelineEditPlanV1["operations"]) {
  const result = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "transition") {
      operation.left.trackIds.forEach((id) => result.add(id));
      operation.right.trackIds.forEach((id) => result.add(id));
    } else if (operation.kind === "insert" || operation.kind === "overwrite") {
      Object.values(operation.targets).forEach((selection) =>
        selection?.trackIds.forEach((id) => result.add(id)));
    } else operation.selection.trackIds.forEach((id) => result.add(id));
  }
  return result;
}

function selectedLinkIds(operations: TimelineEditPlanV1["operations"]) {
  const result = new Set<string>();
  for (const operation of operations) {
    const selections = operation.kind === "transition"
      ? [operation.left, operation.right]
      : operation.kind === "insert" || operation.kind === "overwrite"
        ? Object.values(operation.targets)
        : [operation.selection];
    for (const selection of selections) selection?.linkIds?.forEach((id) => result.add(id));
  }
  return result;
}

function operandSourceOriginIds(
  operations: TimelineEditPlanV1["operations"],
) {
  return new Set(operations.flatMap((operation) =>
    operation.kind === "insert" || operation.kind === "overwrite"
      ? operation.operand.parts.map((part) => part.sourceOriginId)
      : []));
}

function buildTrack(
  ir: CutAVIR,
  node: IRNode,
  order: number,
  sceneDuration: Rational,
): TimelineEditTrackV1 {
  const editorial = node.editorial;
  if (!editorial || (editorial.kind !== "picture-track" && editorial.kind !== "audio-track")) {
    fail("CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${node.id}`, "is not one editorial track.");
  }
  if (!same(node.interval.start, zeroRational) || !same(node.interval.duration, sceneDuration)) {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.nodes.${node.id}.interval`, "v1 selected tracks must cover the complete scene clock.");
  }
  const trackId = editorial.trackId ?? authorityId("track", { nodeId: node.id, contentHash: node.contentHash });
  const domain = editorial.kind === "picture-track" ? "picture" as const : "audio" as const;
  const items: TimelineEditItemV1[] = editorial.items.map((item, itemIndex) => {
    const child = ir.nodes[item.nodeId];
    if (!child || child.sceneId !== node.sceneId) {
      fail("CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${node.id}.editorial.items[${itemIndex}].nodeId`, "does not own one same-scene child.");
    }
    const originId = item.editId ?? authorityId("origin", {
      trackNodeId: node.id,
      childNodeId: child.id,
      contentHash: child.contentHash,
      order: item.order,
    });
    return {
      originId,
      segmentId: authorityId("segment", { trackId, originId, itemIndex }),
      trackId,
      domain,
      ...(item.linkId ? { linkId: item.linkId } : {}),
      destination: relativeInterval(item.destination, node.interval.start),
      sourceView: sourceView(ir, node, editorial, item, child),
      ...(item.role ? { role: item.role } : {}),
      metadata: { ...(item.metadata ?? {}) },
      provenance: structuredClone(child.provenance),
    };
  });
  return {
    trackId,
    domain,
    order,
    duration: sceneDuration,
    ...(editorial.role ? { role: editorial.role } : {}),
    metadata: { ...(editorial.metadata ?? {}) },
    items,
  };
}

export function stageTimelineEditIrV1(
  ir: CutAVIR,
  request: TimelineEditIrRequestV1,
): TimelineEditIrStageV1 {
  const scene = ir.scenes[request.sceneId];
  if (!scene || !ir.compositions.some((composition) =>
    composition.id === request.compositionId && composition.sceneIds.includes(request.sceneId))) {
    fail("CUT_TIMELINE_EDIT_REFERENCE", "$.sceneId", "does not identify one scene in the declared composition.");
  }
  const duration = request.duration ?? scene.duration;
  if (!same(duration, scene.duration)) {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", "$.duration", "v1 requires the fixed owning scene duration.");
  }
  const operations = timelineEditOperationsFromInput(request.operations, request.operationProvenances);
  const requestedTrackIds = selectedTrackIds(operations);
  const requestedLinks = selectedLinkIds(operations);
  const requestedSourceOrigins = operandSourceOriginIds(operations);
  const candidates = Object.values(ir.nodes)
    .filter((node) =>
      node.sceneId === request.sceneId
      && (node.editorial?.kind === "picture-track" || node.editorial?.kind === "audio-track"));
  const nestedSequenceRoots = scene.rootAVIds
    .map((nodeId) => ir.nodes[nodeId])
    .filter((node): node is IRNode => node?.op === "cut.edit.nested_sequence");
  const authored = new Map<string, IRNode>();
  for (const node of candidates) {
    const trackId = node.editorial?.kind === "picture-track" || node.editorial?.kind === "audio-track"
      ? node.editorial.trackId
      : undefined;
    if (!trackId) continue;
    if (authored.has(trackId)) fail("CUT_TIMELINE_EDIT_SHAPE", "$.tracks", `authored trackId ${JSON.stringify(trackId)} is not unique in its scene.`);
    authored.set(trackId, node);
  }
  const unresolvedTrackIds = [...requestedTrackIds].filter((id) =>
    !authored.has(id));
  if (unresolvedTrackIds.length && nestedSequenceRoots.length) {
    const unresolved = new Set(unresolvedTrackIds);
    const operationIndex = operations.findIndex((operation) =>
      [...selectedTrackIds([operation])].some((id) => unresolved.has(id)));
    throw new TimelineEditError(
      "CUT_TIMELINE_EDIT_UNSUPPORTED",
      `TimelineEdit v1 edits canonical PictureTrack and AudioTrack items; requested track ${JSON.stringify(unresolvedTrackIds[0])} is absent, and a scene-local NestedSequence is one audiovisual execution owner, not one editable track.`,
      operationIndex < 0 ? "$.tracks" : `$.operations[${operationIndex}]`,
      operationIndex < 0 ? undefined : operationIndex,
    );
  }
  const included = new Set<IRNode>();
  for (const id of requestedTrackIds) {
    const node = authored.get(id);
    if (node) included.add(node);
  }
  // An insert/overwrite operand may be sourced from a different canonical
  // track than its target. Include every authored owner candidate here; the
  // closed planner later requires exactly one domain-matching source origin.
  for (const node of candidates) {
    const editorial = node.editorial!;
    if ((editorial.kind === "picture-track" || editorial.kind === "audio-track")
      && editorial.items.some((item) =>
        item.editId !== undefined && requestedSourceOrigins.has(item.editId))) {
      included.add(node);
    }
  }
  for (const node of candidates) {
    const editorial = node.editorial!;
    if (editorial.kind !== "picture-track" && editorial.kind !== "audio-track") continue;
    if (editorial.items.some((item) => item.linkId && requestedLinks.has(item.linkId))) included.add(node);
  }
  // Include every owner of a link carried by a selected track so the canonical
  // algebra can reject partial linked mutation even when selection named an
  // authored item/track rather than spelling linkIds explicitly.
  let changed = true;
  while (changed) {
    changed = false;
    const links = new Set([...included].flatMap((node) => {
      const editorial = node.editorial!;
      return editorial.kind === "picture-track" || editorial.kind === "audio-track"
        ? editorial.items.flatMap((item) => item.linkId ? [item.linkId] : [])
        : [];
    }));
    for (const node of candidates) {
      const editorial = node.editorial!;
      if ((editorial.kind === "picture-track" || editorial.kind === "audio-track")
        && editorial.items.some((item) => item.linkId && links.has(item.linkId))
        && !included.has(node)) {
        included.add(node);
        changed = true;
      }
    }
  }
  const pictureOrders = sequencePictureOrders(ir, request.sceneId);
  const sceneOrder = new Map(scene.items.map((item, index) => [item.id, index]));
  const orderedNodes = [...included].sort((left, right) => {
    const leftPicture = left.editorial?.kind === "picture-track";
    const rightPicture = right.editorial?.kind === "picture-track";
    if (leftPicture !== rightPicture) return leftPicture ? -1 : 1;
    const leftOrder = leftPicture ? pictureOrders.get(left.id) ?? Number.MAX_SAFE_INTEGER : sceneOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = rightPicture ? pictureOrders.get(right.id) ?? Number.MAX_SAFE_INTEGER : sceneOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });
  const tracks = orderedNodes.map((node, index) => buildTrack(ir, node, index, duration));
  const plan: TimelineEditPlanV1 = {
    version: 1,
    id: request.id,
    compositionId: request.compositionId,
    sceneId: request.sceneId,
    initialDuration: duration,
    finalDuration: duration,
    tracks,
    operations,
    provenance: structuredClone(request.provenance),
  };
  const execution = executeTimelineEditPlan(plan);
  const trackBindings = orderedNodes.map((node, index): TimelineEditIrTrackBindingV1 => ({
    trackNodeId: node.id,
    trackId: tracks[index]!.trackId,
    kind: node.editorial!.kind as "picture-track" | "audio-track",
  }));
  return Object.freeze({
    plan,
    execution,
    trackBindings,
    stageIdentity: hash({
      format: "cut-timeline-edit-ir-stage",
      version: 1,
      plan,
      execution,
      trackBindings,
    }),
  });
}
