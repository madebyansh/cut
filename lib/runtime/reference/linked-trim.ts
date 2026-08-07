import { stableJsonStringify } from "../../core/stable";
import {
  audioEditMaterializedNodeId,
  AudioEditOperationError,
  executeAudioEditOperationPlan,
  type AudioEditItem,
} from "../../language/audio-edit-operations";
import type {
  CutAVIR,
  IRComposition,
  IREditorial,
  IREditorialInterval,
  IRLinkedTrim,
  IRNode,
  IRProvenance,
  IRValue,
} from "../../language/ir";
import {
  executePictureTrackOperationPlan,
  pictureEditMaterializedNodeId,
  PictureEditOperationError,
  type IRPictureEditItem,
} from "../../language/picture-edit-operations";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import { validateReferenceTimelineEditMaterializations } from "./timeline-edit";

export const referenceLinkedTrimLimits = Object.freeze({
  maxTransactions: 256,
  maxCorrelatedOperations: 512,
});

export type ReferenceLinkedTrimErrorCode =
  | "CUT_LINKED_TRIM_LIMIT"
  | "CUT_LINKED_TRIM_SCOPE"
  | "CUT_LINKED_TRIM_TIME"
  | "CUT_LINKED_TRIM_CARDINALITY"
  | "CUT_LINKED_TRIM_CORRELATION"
  | "CUT_LINKED_TRIM_PLAN"
  | "CUT_LINKED_TRIM_MATERIALIZATION";

export class ReferenceLinkedTrimError extends Error {
  readonly source: {
    module: string;
    line: number;
    column: number;
    transactionId?: string;
    trackId?: string;
  };

  constructor(
    readonly code: ReferenceLinkedTrimErrorCode,
    message: string,
    provenance: IRProvenance,
    identity: { transactionId?: string; trackId?: string } = {},
  ) {
    super(`${code}: ${message} at ${provenance.module}:${provenance.span.start.line}:${provenance.span.start.column}.`);
    this.name = "ReferenceLinkedTrimError";
    this.source = {
      module: provenance.module,
      line: provenance.span.start.line,
      column: provenance.span.start.column,
      ...identity,
    };
  }
}

export type ReferenceLinkedTrimSideAuthorization = Readonly<{
  transactionId: string;
  linkId: string;
  trackId: string;
  kind: "picture" | "audio";
  operationIndex: number;
  materializedItemIndex: number;
  materializedNodeId: string;
  translatedKeep: Readonly<IREditorialInterval>;
}>;

export type ReferenceLinkedTrimAuthorization = Readonly<{
  transactionId: string;
  compositionId: string;
  sceneId: string;
  linkId: string;
  keep: Readonly<IREditorialInterval>;
  picture: ReferenceLinkedTrimSideAuthorization;
  audio: ReferenceLinkedTrimSideAuthorization;
}>;

export type ReferenceLinkedTrimAuthorizations = Readonly<{
  compositionId: string;
  byTransactionId: ReadonlyMap<string, ReferenceLinkedTrimAuthorization>;
  bySceneLink: ReadonlyMap<string, ReferenceLinkedTrimAuthorization>;
  pictureByTrackId: ReadonlyMap<string, ReadonlyMap<string, ReferenceLinkedTrimSideAuthorization>>;
  audioByTrackId: ReadonlyMap<string, ReadonlyMap<string, ReferenceLinkedTrimSideAuthorization>>;
}>;

type PictureTrack = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrack = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };
type LinkedOperationOwner = Readonly<{
  track: PictureTrack | AudioTrack;
  kind: "picture" | "audio";
  operationIndex: number;
  operation: Extract<NonNullable<PictureTrack["editorial"]["operationPlan"]>["operations"][number], { kind: "trim" }>
    | Extract<NonNullable<AudioTrack["editorial"]["operationPlan"]>["operations"][number], { kind: "trim" }>;
}>;

function fail(
  code: ReferenceLinkedTrimErrorCode,
  message: string,
  provenance: IRProvenance,
  identity?: { transactionId?: string; trackId?: string },
): never {
  throw new ReferenceLinkedTrimError(code, message, provenance, identity);
}

function same(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function intervalEnd(interval: IREditorialInterval) {
  return addRational(interval.start, interval.duration);
}

function sameInterval(left: IREditorialInterval, right: IREditorialInterval) {
  return same(left.start, right.start) && same(left.duration, right.duration);
}

function equal(left: unknown, right: unknown) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function immutableMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const data = new Map<K, V>(entries);
  const immutable = {
    get size() { return data.size; },
    has(key: K) { return data.has(key); },
    get(key: K) { return data.get(key); },
    entries() { return data.entries(); },
    keys() { return data.keys(); },
    values() { return data.values(); },
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      data.forEach((value, key) => callback.call(thisArg, value, key, immutable));
    },
    [Symbol.iterator]() { return data[Symbol.iterator](); },
  };
  return Object.freeze(immutable) as ReadonlyMap<K, V>;
}

function freezeRational(value: Rational): Readonly<Rational> {
  return Object.freeze({ numerator: value.numerator, denominator: value.denominator });
}

function freezeInterval(value: IREditorialInterval): Readonly<IREditorialInterval> {
  return Object.freeze({ start: freezeRational(value.start), duration: freezeRational(value.duration) });
}

export function referenceLinkedTrimSceneLinkKey(compositionId: string, sceneId: string, linkId: string) {
  return `${compositionId}\0${sceneId}\0${linkId}`;
}

function timeValue(value: Rational): IRValue {
  return { kind: "quantity", dimension: "time", magnitude: value, unit: "s" };
}

function rangeValue(value: IREditorialInterval): IRValue {
  return { kind: "range", start: timeValue(value.start), end: timeValue(intervalEnd(value)), exclusive: true };
}

function pictureLink(item: IRPictureEditItem) {
  return item.kind === "picture" && item.inputs.link?.kind === "string" ? item.inputs.link.value : undefined;
}

function audioLink(item: AudioEditItem) {
  return item.kind === "clip" ? item.inputs.linkId : undefined;
}

function expectedAudioInputs(item: AudioEditItem): Record<string, IRValue> {
  if (item.kind === "gap") return { destination: rangeValue(item.destination) };
  return {
    source: { kind: "resource-ref", id: item.inputs.resourceId },
    range: rangeValue(item.source),
    destination: rangeValue(item.destination),
    ...(item.inputs.linkId ? { link: { kind: "string", value: item.inputs.linkId } as IRValue } : {}),
    ...(item.inputs.headHandle ? { headHandle: timeValue(item.inputs.headHandle) } : {}),
    ...(item.inputs.tailHandle ? { tailHandle: timeValue(item.inputs.tailHandle) } : {}),
  };
}

function materializedNodeCore(node: IRNode) {
  const core = { ...node } as unknown as Record<string, unknown>;
  delete core.contentHash;
  delete core.provenance;
  return core;
}

function expectedMaterializedNode(
  track: PictureTrack | AudioTrack,
  id: string,
  kind: "picture" | "picture-gap" | "audio" | "audio-gap",
  interval: IREditorialInterval,
  inputs: Record<string, IRValue>,
) {
  const picture = kind === "picture" || kind === "picture-gap";
  return {
    id,
    op: kind === "picture" ? "cut.edit.picture_clip" : kind === "picture-gap" ? "cut.edit.gap" : kind === "audio" ? "cut.audio.clip" : "cut.edit.audio_gap",
    domain: picture ? "visual" : "audio",
    ownership: "child",
    ...(track.sceneId ? { sceneId: track.sceneId } : {}),
    interval,
    inputs,
    children: [],
    properties: {},
    effects: ["pure"],
  };
}

function validateTrackClock(track: PictureTrack | AudioTrack, sceneDuration: Rational, transaction: IRLinkedTrim) {
  if (compareRational(track.interval.start, zeroRational) < 0
    || compareRational(track.interval.duration, zeroRational) <= 0
    || compareRational(intervalEnd(track.interval), sceneDuration) > 0) {
    fail("CUT_LINKED_TRIM_TIME", `declared track ${track.id} must remain inside transaction scene ${transaction.sceneId}`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
  }
}

function validatePictureMaterialization(ir: CutAVIR, track: PictureTrack, transactions: readonly IRLinkedTrim[]) {
  const plan = track.editorial.operationPlan;
  if (!plan) fail("CUT_LINKED_TRIM_CORRELATION", `declared picture track ${track.id} has no operation plan`, transactions[0].provenance, { transactionId: transactions[0].id, trackId: track.id });
  if (track.editorial.transitions?.length) fail("CUT_LINKED_TRIM_CORRELATION", `declared picture track ${track.id} has an extra transition mutation`, track.provenance, { trackId: track.id });
  if (!same(plan.sourceDuration, track.interval.duration)) fail("CUT_LINKED_TRIM_PLAN", `picture track ${track.id} plan duration does not equal its track duration`, track.provenance, { trackId: track.id });
  let execution: ReturnType<typeof executePictureTrackOperationPlan>;
  try {
    execution = executePictureTrackOperationPlan(plan);
  } catch (error) {
    if (!(error instanceof PictureEditOperationError)) throw error;
    const provenance = error.operationIndex === undefined ? track.provenance : plan.operations[error.operationIndex]?.provenance ?? track.provenance;
    fail("CUT_LINKED_TRIM_PLAN", `picture track ${track.id} replay failed: ${error.message}`, provenance, { trackId: track.id });
  }
  if (execution.transitions.length) fail("CUT_LINKED_TRIM_CORRELATION", `picture track ${track.id} replay produced an unauthorized transition`, track.provenance, { trackId: track.id });
  if (execution.items.length !== track.children.length || execution.items.length !== track.editorial.items.length) {
    fail("CUT_LINKED_TRIM_MATERIALIZATION", `picture track ${track.id} materialized item count does not match replay`, track.provenance, { trackId: track.id });
  }
  for (const [index, expected] of execution.items.entries()) {
    const id = pictureEditMaterializedNodeId(track.id, index, expected);
    const destination = { start: addRational(track.interval.start, expected.destination.start), duration: expected.destination.duration };
    const encodedExpected = {
      nodeId: id,
      order: index,
      kind: expected.kind,
      destination,
      ...(expected.source ? { source: expected.source } : {}),
      ...(expected.timeMap ? { timeMap: expected.timeMap } : {}),
      ...(pictureLink(expected) ? { linkId: pictureLink(expected) } : {}),
    };
    const encoded = track.editorial.items[index], child = ir.nodes[id];
    if (track.children[index] !== id || !equal(encoded, encodedExpected) || !child) {
      fail("CUT_LINKED_TRIM_MATERIALIZATION", `picture track ${track.id} item ${index} has forged identity, order, timing, source, link, or ownership`, expected.provenance, { trackId: track.id });
    }
    const nodeExpected = expectedMaterializedNode(track, id, expected.kind === "picture" ? "picture" : "picture-gap", destination, expected.inputs);
    if (!equal(materializedNodeCore(child), nodeExpected)) {
      fail("CUT_LINKED_TRIM_MATERIALIZATION", `picture track ${track.id} child ${id} does not match replayed node semantics`, expected.provenance, { trackId: track.id });
    }
  }
  const duration = execution.items.length ? intervalEnd(execution.items.at(-1)!.destination) : zeroRational;
  if (!same(duration, track.interval.duration)) fail("CUT_LINKED_TRIM_MATERIALIZATION", `picture track ${track.id} replay duration does not equal the owning track`, track.provenance, { trackId: track.id });
  return execution;
}

function validateAudioMaterialization(ir: CutAVIR, track: AudioTrack, transactions: readonly IRLinkedTrim[]) {
  const plan = track.editorial.operationPlan;
  if (!plan) fail("CUT_LINKED_TRIM_CORRELATION", `declared audio track ${track.id} has no operation plan`, transactions[0].provenance, { transactionId: transactions[0].id, trackId: track.id });
  if (track.editorial.transitions?.length) fail("CUT_LINKED_TRIM_CORRELATION", `declared audio track ${track.id} has an extra crossfade mutation`, track.provenance, { trackId: track.id });
  if (!same(plan.sourceDuration, track.interval.duration)) fail("CUT_LINKED_TRIM_PLAN", `audio track ${track.id} plan duration does not equal its track duration`, track.provenance, { trackId: track.id });
  let execution: ReturnType<typeof executeAudioEditOperationPlan>;
  try {
    execution = executeAudioEditOperationPlan(plan);
  } catch (error) {
    if (!(error instanceof AudioEditOperationError)) throw error;
    const provenance = error.operationIndex === undefined ? track.provenance : plan.operations[error.operationIndex]?.provenance ?? track.provenance;
    fail("CUT_LINKED_TRIM_PLAN", `audio track ${track.id} replay failed: ${error.message}`, provenance, { trackId: track.id });
  }
  if (execution.transitions.length) fail("CUT_LINKED_TRIM_CORRELATION", `audio track ${track.id} replay produced an unauthorized crossfade`, track.provenance, { trackId: track.id });
  if (execution.items.length !== track.children.length || execution.items.length !== track.editorial.items.length) {
    fail("CUT_LINKED_TRIM_MATERIALIZATION", `audio track ${track.id} materialized item count does not match replay`, track.provenance, { trackId: track.id });
  }
  for (const [index, expected] of execution.items.entries()) {
    const id = audioEditMaterializedNodeId(track.id, index, expected);
    const destination = { start: addRational(track.interval.start, expected.destination.start), duration: expected.destination.duration };
    const encodedExpected = {
      nodeId: id,
      order: index,
      kind: expected.kind === "clip" ? "audio" : "gap",
      destination,
      ...(expected.kind === "clip" ? { source: expected.source } : {}),
      ...(audioLink(expected) ? { linkId: audioLink(expected) } : {}),
    };
    const encoded = track.editorial.items[index], child = ir.nodes[id];
    if (track.children[index] !== id || !equal(encoded, encodedExpected) || !child) {
      fail("CUT_LINKED_TRIM_MATERIALIZATION", `audio track ${track.id} item ${index} has forged identity, order, timing, source, link, or ownership`, expected.provenance, { trackId: track.id });
    }
    const nodeExpected = expectedMaterializedNode(track, id, expected.kind === "clip" ? "audio" : "audio-gap", destination, expectedAudioInputs(expected));
    if (!equal(materializedNodeCore(child), nodeExpected)) {
      fail("CUT_LINKED_TRIM_MATERIALIZATION", `audio track ${track.id} child ${id} does not match replayed node semantics`, expected.provenance, { trackId: track.id });
    }
  }
  if (!same(execution.duration, track.interval.duration)) fail("CUT_LINKED_TRIM_MATERIALIZATION", `audio track ${track.id} replay duration does not equal the owning track`, track.provenance, { trackId: track.id });
  return execution;
}

function transactionTrack(
  ir: CutAVIR,
  transaction: IRLinkedTrim,
  kind: "picture" | "audio",
): PictureTrack | AudioTrack {
  const id = kind === "picture" ? transaction.pictureTrackId : transaction.audioTrackId;
  const node = ir.nodes[id];
  const expectedEditorial = kind === "picture" ? "picture-track" : "audio-track";
  const expectedOp = kind === "picture" ? "cut.edit.picture_track" : "cut.edit.audio_track";
  const expectedDomain = kind === "picture" ? "visual" : "audio";
  if (!node || node.sceneId !== transaction.sceneId || node.editorial?.kind !== expectedEditorial || node.op !== expectedOp || node.domain !== expectedDomain) {
    fail("CUT_LINKED_TRIM_SCOPE", `transaction ${transaction.id} ${kind}TrackId must reference one ${expectedEditorial} in scene ${transaction.sceneId}`, transaction.provenance, { transactionId: transaction.id, trackId: id });
  }
  return node as PictureTrack | AudioTrack;
}

function validateTransactionScope(ir: CutAVIR, transaction: IRLinkedTrim) {
  if (transaction.kind !== "linked-trim" || transaction.version !== 1) {
    fail("CUT_LINKED_TRIM_SCOPE", `transaction ${transaction.id} must be a linked-trim v1 transaction`, transaction.provenance, { transactionId: transaction.id });
  }
  const owners = ir.compositions.filter((candidate) => candidate.sceneIds.includes(transaction.sceneId));
  const declared = ir.compositions.filter((candidate) => candidate.id === transaction.compositionId);
  const scene = ir.scenes[transaction.sceneId];
  if (declared.length !== 1 || owners.length !== 1 || owners[0].id !== transaction.compositionId || !scene) {
    fail("CUT_LINKED_TRIM_SCOPE", `transaction ${transaction.id} does not resolve to one declared composition/scene owner`, transaction.provenance, { transactionId: transaction.id });
  }
  if (!transaction.linkId || transaction.linkId !== transaction.linkId.trim() || transaction.linkId.length > 128 || /[\u0000-\u001f\u007f]/u.test(transaction.linkId)) {
    fail("CUT_LINKED_TRIM_CARDINALITY", `transaction ${transaction.id} has an invalid editorial link identity`, transaction.provenance, { transactionId: transaction.id });
  }
  const end = intervalEnd(transaction.keep);
  if (compareRational(transaction.keep.start, zeroRational) < 0 || compareRational(transaction.keep.duration, zeroRational) <= 0 || compareRational(end, scene.duration) > 0) {
    fail("CUT_LINKED_TRIM_TIME", `transaction ${transaction.id} keep must be positive and remain inside scene ${transaction.sceneId}`, transaction.provenance, { transactionId: transaction.id });
  }
  const absoluteStart = addRational(scene.start, transaction.keep.start), absoluteEnd = addRational(scene.start, end);
  if (multiplyRational(absoluteStart, declared[0].fps).denominator !== "1" || multiplyRational(absoluteEnd, declared[0].fps).denominator !== "1") {
    fail("CUT_LINKED_TRIM_TIME", `transaction ${transaction.id} keep does not land on the picture frame grid`, transaction.provenance, { transactionId: transaction.id });
  }
  if (multiplyRational(absoluteStart, rational(declared[0].sampleRate)).denominator !== "1" || multiplyRational(absoluteEnd, rational(declared[0].sampleRate)).denominator !== "1") {
    fail("CUT_LINKED_TRIM_TIME", `transaction ${transaction.id} keep does not land on the audio sample grid`, transaction.provenance, { transactionId: transaction.id });
  }
  const picture = transactionTrack(ir, transaction, "picture") as PictureTrack;
  const audio = transactionTrack(ir, transaction, "audio") as AudioTrack;
  validateTrackClock(picture, scene.duration, transaction);
  validateTrackClock(audio, scene.duration, transaction);
  return { scene, picture, audio };
}

function collectLinkedOperationOwners(
  ir: CutAVIR,
  transactions: ReadonlyMap<string, IRLinkedTrim>,
  otherLinkedTransactionIds: ReadonlySet<string>,
) {
  const owners = new Map<string, LinkedOperationOwner[]>();
  let count = 0;
  for (const track of Object.values(ir.nodes).sort((left, right) => left.id.localeCompare(right.id))) {
    const editorial = track.editorial;
    if (!editorial || (editorial.kind !== "picture-track" && editorial.kind !== "audio-track") || !editorial.operationPlan) continue;
    for (const [operationIndex, operation] of editorial.operationPlan.operations.entries()) {
      const transactionId = (operation as { transactionId?: unknown }).transactionId;
      if (transactionId === undefined) continue;
      // Another closed linked-edit kind is authorized by the central
      // dispatcher and its own validator. Do not mistake its correlated
      // operations for forged LinkedTrim mutations here.
      if (typeof transactionId === "string" && otherLinkedTransactionIds.has(transactionId)) continue;
      count += 1;
      if (count > referenceLinkedTrimLimits.maxCorrelatedOperations) {
        fail("CUT_LINKED_TRIM_LIMIT", `linked trim graph exceeds maxCorrelatedOperations=${referenceLinkedTrimLimits.maxCorrelatedOperations}`, operation.provenance, { trackId: track.id });
      }
      if (operation.kind !== "trim" || typeof transactionId !== "string" || !transactions.has(transactionId)) {
        fail("CUT_LINKED_TRIM_CORRELATION", `track ${track.id} has an unknown or non-trim correlated mutation`, operation.provenance, { trackId: track.id, ...(typeof transactionId === "string" ? { transactionId } : {}) });
      }
      const list = owners.get(transactionId) ?? [];
      list.push({
        track: track as PictureTrack | AudioTrack,
        kind: editorial.kind === "picture-track" ? "picture" : "audio",
        operationIndex,
        operation: operation as LinkedOperationOwner["operation"],
      });
      owners.set(transactionId, list);
    }
  }
  return owners;
}

function assertEditorialLinkShape(
  ir: CutAVIR,
  timelineEditTrackNodeIds: ReadonlySet<string>,
) {
  const materializedLinks = new Map<string, string>();
  const timelineEditChildNodeIds = new Set<string>();
  const assertLink = (sceneId: string | undefined, linkId: unknown, provenance: IRProvenance, subject: string) => {
    if (!sceneId || typeof linkId !== "string" || !linkId || linkId !== linkId.trim() || linkId.length > 128 || /[\u0000-\u001f\u007f]/u.test(linkId)) {
      fail("CUT_LINKED_TRIM_CARDINALITY", `${subject} has malformed or unscoped link metadata`, provenance);
    }
  };

  for (const track of Object.values(ir.nodes)) {
    const editorial = track.editorial;
    if (!editorial || (editorial.kind !== "picture-track" && editorial.kind !== "audio-track")) continue;
    if (timelineEditTrackNodeIds.has(track.id)) {
      track.children.forEach((nodeId) => timelineEditChildNodeIds.add(nodeId));
      continue;
    }
    if (editorial.operationPlan) {
      for (const item of editorial.operationPlan.baseItems) {
        if (editorial.kind === "picture-track") {
          const pictureItem = item as IRPictureEditItem;
          const link = pictureItem.inputs.link;
          if (link === undefined) continue;
          if (pictureItem.kind !== "picture") fail("CUT_LINKED_TRIM_CARDINALITY", `picture gap on track ${track.id} cannot carry link metadata`, pictureItem.provenance, { trackId: track.id });
          assertLink(track.sceneId, link.kind === "string" ? link.value : undefined, pictureItem.provenance, `picture source member on track ${track.id}`);
        } else {
          const linkId = (item as unknown as { inputs: { linkId?: unknown } }).inputs.linkId;
          if (linkId === undefined) continue;
          if (item.kind !== "clip" && item.kind !== "region") fail("CUT_LINKED_TRIM_CARDINALITY", `audio gap on track ${track.id} cannot carry link metadata`, item.provenance, { trackId: track.id });
          assertLink(track.sceneId, linkId, item.provenance, `audio source member on track ${track.id}`);
        }
      }
    }
    for (const item of editorial.items) {
      if (item.linkId === undefined) continue;
      const expectedKind = editorial.kind === "picture-track" ? "picture" : "audio";
      if (item.kind !== expectedKind) fail("CUT_LINKED_TRIM_CARDINALITY", `${editorial.kind} gap on track ${track.id} cannot carry link metadata`, track.provenance, { trackId: track.id });
      assertLink(track.sceneId, item.linkId, track.provenance, `materialized member on track ${track.id}`);
      if (materializedLinks.has(item.nodeId)) fail("CUT_LINKED_TRIM_CARDINALITY", `materialized node ${item.nodeId} is claimed by more than one linked track item`, track.provenance, { trackId: track.id });
      materializedLinks.set(item.nodeId, item.linkId);
    }
  }

  for (const node of Object.values(ir.nodes)) {
    if (timelineEditChildNodeIds.has(node.id)) continue;
    if (node.op !== "cut.edit.picture_clip" && node.op !== "cut.audio.clip" && node.op !== "cut.edit.gap" && node.op !== "cut.edit.audio_gap") continue;
    const link = node.inputs.link;
    if (link === undefined) continue;
    if (node.op === "cut.edit.gap" || node.op === "cut.edit.audio_gap") {
      fail("CUT_LINKED_TRIM_CARDINALITY", `materialized gap ${node.id} cannot carry link metadata`, node.provenance);
    }
    assertLink(node.sceneId, link.kind === "string" ? link.value : undefined, node.provenance, `materialized node ${node.id}`);
    if (link.kind !== "string" || materializedLinks.get(node.id) !== link.value) {
      fail("CUT_LINKED_TRIM_CARDINALITY", `materialized node ${node.id} link is not owned by exactly one matching track item`, node.provenance);
    }
  }
}

function assertTransactionLinkCardinality(ir: CutAVIR, transaction: IRLinkedTrim, picture: PictureTrack, audio: AudioTrack) {
  const sceneTracks = Object.values(ir.nodes).filter((node) => node.sceneId === transaction.sceneId && (node.editorial?.kind === "picture-track" || node.editorial?.kind === "audio-track"));
  const basePicture = sceneTracks.flatMap((node) => node.editorial?.kind === "picture-track" && node.editorial.operationPlan
    ? node.editorial.operationPlan.baseItems.flatMap((item) => item.inputs.link?.kind === "string" && item.inputs.link.value === transaction.linkId ? [{ track: node, item }] : [])
    : []);
  const baseAudio = sceneTracks.flatMap((node) => node.editorial?.kind === "audio-track" && node.editorial.operationPlan
    ? node.editorial.operationPlan.baseItems.flatMap((item) => item.kind === "clip" && item.inputs.linkId === transaction.linkId ? [{ track: node, item }] : [])
    : []);
  if (basePicture.length !== 1 || basePicture[0].track.id !== picture.id || basePicture[0].item.kind !== "picture") {
    fail("CUT_LINKED_TRIM_CARDINALITY", `transaction ${transaction.id} must own exactly one source picture member for link ${JSON.stringify(transaction.linkId)}`, transaction.provenance, { transactionId: transaction.id, trackId: picture.id });
  }
  if (baseAudio.length !== 1 || baseAudio[0].track.id !== audio.id || baseAudio[0].item.kind !== "clip") {
    fail("CUT_LINKED_TRIM_CARDINALITY", `transaction ${transaction.id} must own exactly one source audio member for link ${JSON.stringify(transaction.linkId)}`, transaction.provenance, { transactionId: transaction.id, trackId: audio.id });
  }

  const pictureItems = sceneTracks.flatMap((node) => node.editorial?.kind === "picture-track"
    ? node.editorial.items.flatMap((item) => item.linkId === transaction.linkId ? [{ track: node, item }] : [])
    : []);
  const audioItems = sceneTracks.flatMap((node) => node.editorial?.kind === "audio-track"
    ? node.editorial.items.flatMap((item) => item.linkId === transaction.linkId ? [{ track: node, item }] : [])
    : []);
  if (pictureItems.length !== 1 || pictureItems[0].track.id !== picture.id || pictureItems[0].item.kind !== "picture" || !sameInterval(pictureItems[0].item.destination, transaction.keep)) {
    fail("CUT_LINKED_TRIM_CARDINALITY", `transaction ${transaction.id} must materialize exactly one picture member at keep`, transaction.provenance, { transactionId: transaction.id, trackId: picture.id });
  }
  if (audioItems.length !== 1 || audioItems[0].track.id !== audio.id || audioItems[0].item.kind !== "audio" || !sameInterval(audioItems[0].item.destination, transaction.keep)) {
    fail("CUT_LINKED_TRIM_CARDINALITY", `transaction ${transaction.id} must materialize exactly one audio member at keep`, transaction.provenance, { transactionId: transaction.id, trackId: audio.id });
  }

  const pictureNodes = Object.values(ir.nodes).filter((node) => node.sceneId === transaction.sceneId && node.op === "cut.edit.picture_clip" && node.inputs.link?.kind === "string" && node.inputs.link.value === transaction.linkId);
  const audioNodes = Object.values(ir.nodes).filter((node) => node.sceneId === transaction.sceneId && node.op === "cut.audio.clip" && node.inputs.link?.kind === "string" && node.inputs.link.value === transaction.linkId);
  if (pictureNodes.length !== 1 || pictureNodes[0].id !== pictureItems[0].item.nodeId || audioNodes.length !== 1 || audioNodes[0].id !== audioItems[0].item.nodeId) {
    fail("CUT_LINKED_TRIM_CARDINALITY", `transaction ${transaction.id} link must have exactly one materialized picture node and one audio node in its scene`, transaction.provenance, { transactionId: transaction.id });
  }
}

function assertTransactionOperationCardinality(
  transaction: IRLinkedTrim,
  picture: PictureTrack,
  audio: AudioTrack,
  operationOwners: ReadonlyMap<string, readonly LinkedOperationOwner[]>,
) {
  const owners = operationOwners.get(transaction.id) ?? [];
  const pictureOwners = owners.filter((owner) => owner.kind === "picture" && owner.track.id === picture.id);
  const audioOwners = owners.filter((owner) => owner.kind === "audio" && owner.track.id === audio.id);
  if (owners.length !== 2 || pictureOwners.length !== 1 || audioOwners.length !== 1) {
    fail(
      "CUT_LINKED_TRIM_CORRELATION",
      `transaction ${transaction.id} has an extra or missing correlated mutation; exactly one trim must belong to each declared track`,
      transaction.provenance,
      { transactionId: transaction.id },
    );
  }
}

function assertTrackOperations(
  track: PictureTrack | AudioTrack,
  kind: "picture" | "audio",
  transactions: readonly IRLinkedTrim[],
  operationOwners: ReadonlyMap<string, readonly LinkedOperationOwner[]>,
) {
  const plan = track.editorial.operationPlan;
  if (!plan) fail("CUT_LINKED_TRIM_CORRELATION", `declared ${kind} track ${track.id} has no correlated operation plan`, transactions[0].provenance, { transactionId: transactions[0].id, trackId: track.id });
  const expected = new Set(transactions.map((transaction) => transaction.id));
  if (plan.operations.length !== expected.size) fail("CUT_LINKED_TRIM_CORRELATION", `${kind} track ${track.id} has an extra or missing correlated mutation`, track.provenance, { trackId: track.id });
  const seen = new Set<string>();
  for (const operation of plan.operations) {
    if (operation.kind !== "trim" || !operation.transactionId || !expected.has(operation.transactionId) || seen.has(operation.transactionId)) {
      fail("CUT_LINKED_TRIM_CORRELATION", `${kind} track ${track.id} contains a forged, duplicate, or uncorrelated operation`, operation.provenance, { trackId: track.id, ...(operation.kind === "trim" && operation.transactionId ? { transactionId: operation.transactionId } : {}) });
    }
    seen.add(operation.transactionId);
  }
  for (const transaction of transactions) {
    const owners = operationOwners.get(transaction.id) ?? [];
    const matching = owners.filter((owner) => owner.kind === kind && owner.track.id === track.id);
    if (matching.length !== 1) fail("CUT_LINKED_TRIM_CORRELATION", `transaction ${transaction.id} requires exactly one ${kind} trim on declared track ${track.id}`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
    const translated = { start: subtractRational(transaction.keep.start, track.interval.start), duration: transaction.keep.duration };
    if (compareRational(translated.start, zeroRational) < 0 || !sameInterval(matching[0].operation.keep, translated)) {
      fail("CUT_LINKED_TRIM_CORRELATION", `transaction ${transaction.id} ${kind} trim keep is not translated into track ${track.id}'s local clock`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
    }
  }
}

function sideAuthorization(
  transaction: IRLinkedTrim,
  track: PictureTrack | AudioTrack,
  kind: "picture" | "audio",
  operationOwners: ReadonlyMap<string, readonly LinkedOperationOwner[]>,
) {
  const owner = (operationOwners.get(transaction.id) ?? []).find((candidate) => candidate.kind === kind && candidate.track.id === track.id)!;
  const itemIndex = track.editorial.items.findIndex((item) => item.linkId === transaction.linkId);
  if (itemIndex < 0) fail("CUT_LINKED_TRIM_CARDINALITY", `transaction ${transaction.id} lost its materialized ${kind} link member`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
  return Object.freeze({
    transactionId: transaction.id,
    linkId: transaction.linkId,
    trackId: track.id,
    kind,
    operationIndex: owner.operationIndex,
    materializedItemIndex: itemIndex,
    materializedNodeId: track.editorial.items[itemIndex].nodeId,
    translatedKeep: freezeInterval(owner.operation.keep),
  }) satisfies ReferenceLinkedTrimSideAuthorization;
}

function groupedImmutableMaps(
  sides: readonly ReferenceLinkedTrimSideAuthorization[],
) {
  const mutable = new Map<string, Array<readonly [string, ReferenceLinkedTrimSideAuthorization]>>();
  for (const side of sides) {
    const entries = mutable.get(side.trackId) ?? [];
    entries.push([side.transactionId, side]);
    mutable.set(side.trackId, entries);
  }
  return immutableMap([...mutable].map(([trackId, entries]) => [trackId, immutableMap(entries)] as const));
}

/**
 * Validate and authorize the current bounded LinkedTrim transaction slice.
 *
 * This function deliberately does not mutate IR or relax the ordinary track
 * validators. Its deeply read-only maps are the integration boundary those
 * validators can consume to distinguish compiler-correlated trims from forged
 * one-sided edit plans.
 */
export function validateReferenceLinkedTrimTransactions(
  ir: CutAVIR,
  composition: IRComposition,
): ReferenceLinkedTrimAuthorizations {
  const declaredComposition = ir.compositions.filter((candidate) => candidate.id === composition.id);
  if (declaredComposition.length !== 1) fail("CUT_LINKED_TRIM_SCOPE", `requested composition ${composition.id} is not uniquely declared in CutAVIR`, composition.provenance);
  const linkedEdits = ir.linkedEdits ?? [];
  const transactions: IRLinkedTrim[] = linkedEdits.filter((transaction): transaction is IRLinkedTrim => transaction.kind === "linked-trim");
  if (transactions.length > referenceLinkedTrimLimits.maxTransactions) {
    fail("CUT_LINKED_TRIM_LIMIT", `linked trim graph exceeds maxTransactions=${referenceLinkedTrimLimits.maxTransactions}`, transactions[0]?.provenance ?? composition.provenance);
  }

  const transactionsById = new Map<string, IRLinkedTrim>(), transactionsByScope = new Map<string, IRLinkedTrim>();
  for (const transaction of transactions) {
    if (transactionsById.has(transaction.id)) fail("CUT_LINKED_TRIM_CARDINALITY", `linked trim transaction id ${transaction.id} is duplicated`, transaction.provenance, { transactionId: transaction.id });
    transactionsById.set(transaction.id, transaction);
    validateTransactionScope(ir, transaction);
    const scope = referenceLinkedTrimSceneLinkKey(transaction.compositionId, transaction.sceneId, transaction.linkId);
    if (transactionsByScope.has(scope)) fail("CUT_LINKED_TRIM_CARDINALITY", `scene link ${JSON.stringify(transaction.linkId)} has more than one LinkedTrim transaction`, transaction.provenance, { transactionId: transaction.id });
    transactionsByScope.set(scope, transaction);
  }
  // Direct trim callers cannot supply or forge the TimelineEdit exemption:
  // derive it only from a fresh exact replay over this IR.
  const timelineEdit = validateReferenceTimelineEditMaterializations(ir);
  const timelineEditTrackNodeIds = new Set(
    timelineEdit.plans.flatMap((plan) =>
      plan.trackBindings.map((binding) => binding.trackNodeId)),
  );
  assertEditorialLinkShape(ir, timelineEditTrackNodeIds);
  const otherLinkedTransactionIds = new Set(linkedEdits.filter((transaction) => transaction.kind !== "linked-trim").map((transaction) => transaction.id));
  const operationOwners = collectLinkedOperationOwners(ir, transactionsById, otherLinkedTransactionIds);
  const selected = transactions.filter((transaction) => transaction.compositionId === composition.id);

  const pictureGroups = new Map<string, { track: PictureTrack; transactions: IRLinkedTrim[] }>();
  const audioGroups = new Map<string, { track: AudioTrack; transactions: IRLinkedTrim[] }>();
  for (const transaction of transactions) {
    const { picture, audio } = validateTransactionScope(ir, transaction);
    assertTransactionOperationCardinality(transaction, picture, audio, operationOwners);
    assertTransactionLinkCardinality(ir, transaction, picture, audio);
    const pictureGroup = pictureGroups.get(picture.id) ?? { track: picture, transactions: [] };
    pictureGroup.transactions.push(transaction); pictureGroups.set(picture.id, pictureGroup);
    const audioGroup = audioGroups.get(audio.id) ?? { track: audio, transactions: [] };
    audioGroup.transactions.push(transaction); audioGroups.set(audio.id, audioGroup);
  }

  for (const group of pictureGroups.values()) {
    assertTrackOperations(group.track, "picture", group.transactions, operationOwners);
    validatePictureMaterialization(ir, group.track, group.transactions);
  }
  for (const group of audioGroups.values()) {
    assertTrackOperations(group.track, "audio", group.transactions, operationOwners);
    validateAudioMaterialization(ir, group.track, group.transactions);
  }

  const pictureSides: ReferenceLinkedTrimSideAuthorization[] = [];
  const audioSides: ReferenceLinkedTrimSideAuthorization[] = [];
  const authorized: Array<readonly [string, ReferenceLinkedTrimAuthorization]> = [];
  const sceneLinks: Array<readonly [string, ReferenceLinkedTrimAuthorization]> = [];
  for (const transaction of selected) {
    const picture = transactionTrack(ir, transaction, "picture") as PictureTrack;
    const audio = transactionTrack(ir, transaction, "audio") as AudioTrack;
    const pictureSide = sideAuthorization(transaction, picture, "picture", operationOwners);
    const audioSide = sideAuthorization(transaction, audio, "audio", operationOwners);
    pictureSides.push(pictureSide); audioSides.push(audioSide);
    const authorization = Object.freeze({
      transactionId: transaction.id,
      compositionId: transaction.compositionId,
      sceneId: transaction.sceneId,
      linkId: transaction.linkId,
      keep: freezeInterval(transaction.keep),
      picture: pictureSide,
      audio: audioSide,
    }) satisfies ReferenceLinkedTrimAuthorization;
    authorized.push([transaction.id, authorization]);
    sceneLinks.push([referenceLinkedTrimSceneLinkKey(transaction.compositionId, transaction.sceneId, transaction.linkId), authorization]);
  }

  return Object.freeze({
    compositionId: composition.id,
    byTransactionId: immutableMap(authorized),
    bySceneLink: immutableMap(sceneLinks),
    pictureByTrackId: groupedImmutableMaps(pictureSides),
    audioByTrackId: groupedImmutableMaps(audioSides),
  });
}
