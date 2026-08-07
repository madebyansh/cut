import type {
  CutAVIR,
  IRComposition,
  IREditorial,
  IREditorialInterval,
  IRLinkedRippleDelete,
  IRNode,
  IRProvenance,
} from "../../language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../../language/ir-loader";
import { isNeutralLinkedRipplePictureInputs } from "../../language/linked-ripple-neutral";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";

export const referenceLinkedRippleDeleteLimits = Object.freeze({
  maxTransactions: 256,
  maxCorrelatedOperations: 1_024,
});

export type ReferenceLinkedRippleDeleteErrorCode =
  | "CUT_LINKED_RIPPLE_LIMIT"
  | "CUT_LINKED_RIPPLE_SCOPE"
  | "CUT_LINKED_RIPPLE_TIME"
  | "CUT_LINKED_RIPPLE_CARDINALITY"
  | "CUT_LINKED_RIPPLE_CORRELATION"
  | "CUT_LINKED_RIPPLE_PLAN"
  | "CUT_LINKED_RIPPLE_MATERIALIZATION";

export class ReferenceLinkedRippleDeleteError extends Error {
  readonly source: {
    module: string;
    line: number;
    column: number;
    transactionId?: string;
    trackId?: string;
  };

  constructor(
    readonly code: ReferenceLinkedRippleDeleteErrorCode,
    message: string,
    provenance: IRProvenance,
    identity: { transactionId?: string; trackId?: string } = {},
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message} at ${provenance.module}:${provenance.span.start.line}:${provenance.span.start.column}.`, options);
    this.name = "ReferenceLinkedRippleDeleteError";
    this.source = {
      module: provenance.module,
      line: provenance.span.start.line,
      column: provenance.span.start.column,
      ...identity,
    };
  }
}

export type ReferenceLinkedRippleDeleteSideAuthorization = Readonly<{
  transactionId: string;
  version: 1 | 2;
  linkId: string;
  trackId: string;
  kind: "picture" | "audio";
  insertOperationIndex: number;
  deleteOperationIndex: number;
  insertionAt: Readonly<Rational>;
  translatedRange: Readonly<IREditorialInterval>;
  insertedGapDuration: Readonly<Rational>;
  linkSegmentIds?: Readonly<{ before: string; after: string }>;
}>;

export type ReferenceLinkedRippleDeleteAuthorization = Readonly<{
  transactionId: string;
  version: 1 | 2;
  compositionId: string;
  sceneId: string;
  linkId: string;
  range: Readonly<IREditorialInterval>;
  linkSegmentIds?: Readonly<{ before: string; after: string }>;
  picture: ReferenceLinkedRippleDeleteSideAuthorization;
  audio: ReferenceLinkedRippleDeleteSideAuthorization;
}>;

export type ReferenceLinkedRippleDeleteAuthorizations = Readonly<{
  compositionId: string;
  byTransactionId: ReadonlyMap<string, ReferenceLinkedRippleDeleteAuthorization>;
  pictureByTrackId: ReadonlyMap<string, ReadonlyMap<string, ReferenceLinkedRippleDeleteSideAuthorization>>;
  audioByTrackId: ReadonlyMap<string, ReadonlyMap<string, ReferenceLinkedRippleDeleteSideAuthorization>>;
}>;

type PictureTrack = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrack = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };

function fail(
  code: ReferenceLinkedRippleDeleteErrorCode,
  message: string,
  provenance: IRProvenance,
  identity?: { transactionId?: string; trackId?: string },
  cause?: unknown,
): never {
  throw new ReferenceLinkedRippleDeleteError(
    code,
    message,
    provenance,
    identity,
    cause === undefined ? undefined : { cause },
  );
}

function same(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function end(interval: IREditorialInterval) {
  return addRational(interval.start, interval.duration);
}

function sameInterval(left: IREditorialInterval, right: IREditorialInterval) {
  return same(left.start, right.start) && same(left.duration, right.duration);
}

function freezeRational(value: Rational): Readonly<Rational> {
  return Object.freeze({ numerator: value.numerator, denominator: value.denominator });
}

function freezeInterval(value: IREditorialInterval): Readonly<IREditorialInterval> {
  return Object.freeze({ start: freezeRational(value.start), duration: freezeRational(value.duration) });
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

function groupedImmutableMaps(
  sides: readonly ReferenceLinkedRippleDeleteSideAuthorization[],
) {
  const mutable = new Map<string, Array<readonly [string, ReferenceLinkedRippleDeleteSideAuthorization]>>();
  for (const side of sides) {
    const entries = mutable.get(side.trackId) ?? [];
    entries.push([side.transactionId, side]);
    mutable.set(side.trackId, entries);
  }
  return immutableMap([...mutable].map(([trackId, entries]) => [trackId, immutableMap(entries)] as const));
}

function firstLinkedRippleTransactionMetadata(ir: CutAVIR) {
  for (const node of Object.values(ir.nodes)) {
    const editorial = node.editorial;
    if (editorial?.kind !== "picture-track" && editorial?.kind !== "audio-track") continue;
    if (editorial.items.some((item) => "linkSegmentId" in item && item.linkSegmentId !== undefined)) {
      return { provenance: node.provenance, trackId: node.id };
    }
    const plan = editorial.operationPlan;
    if (!plan) continue;
    if (plan.baseItems.some((item) => "linkSegmentId" in item && item.linkSegmentId !== undefined)) {
      return { provenance: node.provenance, trackId: node.id };
    }
    for (const operation of plan.operations) {
      if ((operation.kind === "ripple-insert" || operation.kind === "ripple-delete")
        && "transactionId" in operation
        && operation.transactionId !== undefined) {
        return { provenance: operation.provenance, trackId: node.id };
      }
      if (operation.kind === "ripple-delete"
        && operation.transactionVersion !== undefined) {
        return { provenance: operation.provenance, trackId: node.id };
      }
      if ("linkSegmentIds" in operation && operation.linkSegmentIds !== undefined) {
        return { provenance: operation.provenance, trackId: node.id };
      }
      if ("item" in operation
        && "linkSegmentId" in operation.item
        && operation.item.linkSegmentId !== undefined) {
        return { provenance: operation.provenance, trackId: node.id };
      }
    }
  }
  return undefined;
}

function transactionTrack(
  ir: CutAVIR,
  transaction: IRLinkedRippleDelete,
  kind: "picture" | "audio",
): PictureTrack | AudioTrack {
  const id = kind === "picture" ? transaction.pictureTrackId : transaction.audioTrackId;
  const node = ir.nodes[id];
  const editorialKind = kind === "picture" ? "picture-track" : "audio-track";
  const op = kind === "picture" ? "cut.edit.picture_track" : "cut.edit.audio_track";
  const domain = kind === "picture" ? "visual" : "audio";
  if (!node
    || node.sceneId !== transaction.sceneId
    || node.editorial?.kind !== editorialKind
    || node.op !== op
    || node.domain !== domain) {
    fail(
      "CUT_LINKED_RIPPLE_SCOPE",
      `transaction ${transaction.id} ${kind}TrackId must reference one ${editorialKind} in scene ${transaction.sceneId}`,
      transaction.provenance,
      { transactionId: transaction.id, trackId: id },
    );
  }
  return node as PictureTrack | AudioTrack;
}

function validateScope(ir: CutAVIR, transaction: IRLinkedRippleDelete) {
  if (transaction.kind !== "linked-ripple-delete" || (transaction.version !== 1 && transaction.version !== 2)) {
    fail("CUT_LINKED_RIPPLE_SCOPE", `transaction ${transaction.id} must be linked-ripple-delete v1 or v2`, transaction.provenance, { transactionId: transaction.id });
  }
  const composition = ir.compositions.find((candidate) => candidate.id === transaction.compositionId);
  const scene = ir.scenes[transaction.sceneId];
  if (!composition || !scene || !composition.sceneIds.includes(scene.id)) {
    fail("CUT_LINKED_RIPPLE_SCOPE", `transaction ${transaction.id} does not resolve to one declared composition/scene owner`, transaction.provenance, { transactionId: transaction.id });
  }
  if (!transaction.linkId
    || transaction.linkId !== transaction.linkId.trim()
    || transaction.linkId.length > 128
    || /[\u0000-\u001f\u007f]/u.test(transaction.linkId)) {
    fail("CUT_LINKED_RIPPLE_CARDINALITY", `transaction ${transaction.id} has an invalid editorial link identity`, transaction.provenance, { transactionId: transaction.id });
  }
  if (compareRational(transaction.range.start, zeroRational) < 0
    || compareRational(transaction.range.duration, zeroRational) <= 0
    || compareRational(end(transaction.range), scene.duration) > 0) {
    fail("CUT_LINKED_RIPPLE_TIME", `transaction ${transaction.id} range must be positive and remain inside scene ${scene.id}`, transaction.provenance, { transactionId: transaction.id });
  }
  const absoluteStart = addRational(scene.start, transaction.range.start);
  const absoluteEnd = addRational(scene.start, end(transaction.range));
  if (multiplyRational(absoluteStart, composition.fps).denominator !== "1"
    || multiplyRational(absoluteEnd, composition.fps).denominator !== "1") {
    fail("CUT_LINKED_RIPPLE_TIME", `transaction ${transaction.id} range does not land on the picture frame grid`, transaction.provenance, { transactionId: transaction.id });
  }
  if (multiplyRational(absoluteStart, rational(composition.sampleRate)).denominator !== "1"
    || multiplyRational(absoluteEnd, rational(composition.sampleRate)).denominator !== "1") {
    fail("CUT_LINKED_RIPPLE_TIME", `transaction ${transaction.id} range does not land on the audio sample grid`, transaction.provenance, { transactionId: transaction.id });
  }
  return {
    composition,
    scene,
    picture: transactionTrack(ir, transaction, "picture") as PictureTrack,
    audio: transactionTrack(ir, transaction, "audio") as AudioTrack,
  };
}

function sideAuthorization(
  transaction: IRLinkedRippleDelete,
  track: PictureTrack | AudioTrack,
  kind: "picture" | "audio",
): ReferenceLinkedRippleDeleteSideAuthorization {
  const plan = track.editorial.operationPlan;
  if (!plan || plan.operations.length !== 2) {
    fail("CUT_LINKED_RIPPLE_CORRELATION", `${kind} track ${track.id} must contain exactly two correlated operations`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
  }
  const insertion = plan.operations[0];
  const deletion = plan.operations[1];
  if (insertion.kind !== "ripple-insert"
    || insertion.transactionId !== transaction.id
    || deletion.kind !== "ripple-delete"
    || deletion.transactionId !== transaction.id) {
    fail("CUT_LINKED_RIPPLE_CORRELATION", `${kind} track ${track.id} must tail-insert then ripple-delete for transaction ${transaction.id}`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
  }
  const translatedRange = {
    start: subtractRational(transaction.range.start, track.interval.start),
    duration: transaction.range.duration,
  };
  if (compareRational(translatedRange.start, zeroRational) < 0
    || !sameInterval(deletion.range, translatedRange)
    || !same(insertion.at, plan.sourceDuration)
    || !same(plan.sourceDuration, track.interval.duration)
    || insertion.item.kind !== "gap"
    || !same(insertion.item.destination.start, zeroRational)
    || !same(insertion.item.destination.duration, transaction.range.duration)) {
    fail("CUT_LINKED_RIPPLE_PLAN", `${kind} track ${track.id} operations do not implement the fixed-duration linked ripple closure`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
  }
  if (transaction.version === 1 && deletion.linkSegmentIds !== undefined) {
    fail("CUT_LINKED_RIPPLE_CORRELATION", `${kind} track ${track.id} complete-pair v1 deletion cannot declare survivor segment identities`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
  }
  if (deletion.transactionVersion !== transaction.version) {
    fail("CUT_LINKED_RIPPLE_CORRELATION", `${kind} track ${track.id} deletion transactionVersion does not match owning v${transaction.version} transaction`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
  }
  if (transaction.version === 2 && (deletion.linkSegmentIds?.before !== transaction.linkSegmentIds.before
    || deletion.linkSegmentIds.after !== transaction.linkSegmentIds.after)) {
    fail("CUT_LINKED_RIPPLE_CORRELATION", `${kind} track ${track.id} deletion does not carry the authorized v2 before/after segment identities`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
  }
  if (kind === "picture" && track.editorial.kind === "picture-track") {
    const members = track.editorial.operationPlan!.baseItems.filter((item) => item.kind === "picture" && item.inputs.link?.kind === "string" && item.inputs.link.value === transaction.linkId);
    if (members.length !== 1) fail("CUT_LINKED_RIPPLE_CARDINALITY", `picture track ${track.id} must contain exactly one linked plan-base member`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
    const member = members[0], memberEnd = end(member.destination), rangeEnd = end(translatedRange);
    if (transaction.version === 1 && !sameInterval(member.destination, translatedRange)) {
      fail("CUT_LINKED_RIPPLE_PLAN", `picture track ${track.id} v1 base member must equal the complete deleted range`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
    }
    if (transaction.version === 2) {
      const handleIsNeutral = (name: "headHandle" | "tailHandle") => {
        const value = member.inputs[name];
        return value === undefined || (value.kind === "quantity" && value.dimension === "time" && same(value.magnitude, zeroRational));
      };
      const timeMapIsNeutral = member.timeMap === undefined
        || (member.timeMap.kind === "constant"
          && member.timeMap.direction === "forward"
          && same(member.timeMap.rate, rational(1)));
      if (compareRational(translatedRange.start, member.destination.start) <= 0
        || compareRational(rangeEnd, memberEnd) >= 0
        || member.linkSegmentId !== undefined
        || !member.source
        || !same(member.source.duration, member.destination.duration)
        || !timeMapIsNeutral
        || !isNeutralLinkedRipplePictureInputs(member.inputs)
        || !handleIsNeutral("headHandle")
        || !handleIsNeutral("tailHandle")) {
        fail("CUT_LINKED_RIPPLE_PLAN", `picture track ${track.id} v2 requires one unsegmented neutral forward-1x base clip without transform, opacity, animation, handles, or retime treatment strictly containing the deleted range`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
      }
    }
  }
  if (kind === "audio" && track.editorial.kind === "audio-track") {
    const members = track.editorial.operationPlan!.baseItems.filter((item) => item.kind === "clip" && item.inputs.linkId === transaction.linkId);
    if (members.length !== 1) fail("CUT_LINKED_RIPPLE_CARDINALITY", `audio track ${track.id} must contain exactly one linked plan-base member`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
    const member = members[0], memberEnd = end(member.destination), rangeEnd = end(translatedRange);
    if (member.kind !== "clip") fail("CUT_LINKED_RIPPLE_CARDINALITY", `audio track ${track.id} linked plan-base member must be a direct clip`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
    if (transaction.version === 1 && !sameInterval(member.destination, translatedRange)) {
      fail("CUT_LINKED_RIPPLE_PLAN", `audio track ${track.id} v1 base member must equal the complete deleted range`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
    }
    const neutralAudioHandle = (value: Rational | undefined) => value === undefined || same(value, zeroRational);
    if (transaction.version === 2 && (compareRational(translatedRange.start, member.destination.start) <= 0
      || compareRational(rangeEnd, memberEnd) >= 0
      || member.linkSegmentId !== undefined
      || !same(member.source.duration, member.destination.duration)
      || !neutralAudioHandle(member.inputs.headHandle)
      || !neutralAudioHandle(member.inputs.tailHandle))) {
      fail("CUT_LINKED_RIPPLE_PLAN", `audio track ${track.id} v2 requires one unsegmented neutral forward-1x base clip strictly containing the deleted range`, transaction.provenance, { transactionId: transaction.id, trackId: track.id });
    }
  }
  return Object.freeze({
    transactionId: transaction.id,
    version: transaction.version,
    linkId: transaction.linkId,
    trackId: track.id,
    kind,
    insertOperationIndex: 0,
    deleteOperationIndex: 1,
    insertionAt: freezeRational(insertion.at),
    translatedRange: freezeInterval(translatedRange),
    insertedGapDuration: freezeRational(insertion.item.destination.duration),
    ...(transaction.version === 2 ? { linkSegmentIds: Object.freeze({ ...transaction.linkSegmentIds }) } : {}),
  });
}

/**
 * Validate and authorize one exact complete-pair v1 or strict interior v2
 * LinkedRippleDelete slice.
 *
 * The strict public CutAVIR validator first closes all cross-track ownership,
 * operation and materialization identities. The returned maps then let the
 * picture/audio runtime validators independently replay the two operations
 * without treating either side as an unauthorized linked mutation.
 */
export function validateReferenceLinkedRippleDeleteTransactions(
  ir: CutAVIR,
  composition: IRComposition,
): ReferenceLinkedRippleDeleteAuthorizations {
  const transactions = (ir.linkedEdits ?? []).filter(
    (transaction): transaction is IRLinkedRippleDelete => transaction.kind === "linked-ripple-delete",
  );
  if (transactions.length > referenceLinkedRippleDeleteLimits.maxTransactions) {
    fail("CUT_LINKED_RIPPLE_LIMIT", `linked ripple graph exceeds maxTransactions=${referenceLinkedRippleDeleteLimits.maxTransactions}`, transactions[0]?.provenance ?? composition.provenance);
  }
  // Segment ids are compiler-reserved v2 transaction state. Run the strict
  // whole-IR ownership pass even when a hostile in-memory graph removed the
  // transaction/plan envelope but retained apparently valid paired survivors.
  // This happens before picture preparation, audio rendering, or cache lookup.
  const transactionMetadata = firstLinkedRippleTransactionMetadata(ir);
  if (transactions.length || transactionMetadata) {
    try {
      validateCutAvIr(ir);
    } catch (error) {
      if (!(error instanceof CutAvIrValidationError)) throw error;
      const linkedEditIndex = /^\$\.linkedEdits\[(\d+)\](?:\.|$)/u.exec(error.path)?.[1];
      const topLevelOwner = linkedEditIndex === undefined ? undefined : (ir.linkedEdits ?? [])[Number(linkedEditIndex)];
      const trackOwner = transactions
        .flatMap((transaction) => [
          { transaction, trackId: transaction.pictureTrackId },
          { transaction, trackId: transaction.audioTrackId },
        ])
        .flatMap(({ transaction, trackId }) => [trackId, ...(ir.nodes[trackId]?.children ?? [])].map((nodeId) => ({ transaction, trackId, nodeId })))
        .filter(({ nodeId }) => error.path === `$.nodes.${nodeId}` || error.path.startsWith(`$.nodes.${nodeId}.`))
        .sort((left, right) => right.nodeId.length - left.nodeId.length)[0];
      const owner = topLevelOwner?.kind === "linked-ripple-delete" ? topLevelOwner : trackOwner?.transaction;
      // The strict loader validates the whole IR. Do not launder an unrelated
      // output/node/package defect into the first ripple transaction's source
      // location merely because this graph happens to contain a ripple edit.
      // Defects under either declared track do belong to its atomic transaction
      // and receive the authored transaction provenance below.
      if (!owner) {
        if (transactionMetadata && /(?:transactionId|transactionVersion|linkSegmentId|linkSegmentIds)(?:\.|$)/u.test(error.path)) {
          fail(
            "CUT_LINKED_RIPPLE_MATERIALIZATION",
            `strict CutAVIR transaction/survivor ownership failed at ${error.path}: ${error.message}`,
            transactionMetadata.provenance,
            { trackId: transactionMetadata.trackId },
            error,
          );
        }
        throw error;
      }
      const localPath = linkedEditIndex !== undefined
        ? error.path.replace(/^\$\.linkedEdits\[\d+\]\.?(.*)$/u, "$1")
        : trackOwner
          ? error.path.slice(`$.nodes.${trackOwner.nodeId}`.length).replace(/^\./u, "")
          : error.path;
      const runtimeCode: ReferenceLinkedRippleDeleteErrorCode = error.code === "CUT_IR_LIMIT"
        ? "CUT_LINKED_RIPPLE_LIMIT"
        : error.code === "CUT_IR_TIMING" || localPath === "range" || localPath.startsWith("range.")
          ? "CUT_LINKED_RIPPLE_TIME"
          : /(?:^|\.)(?:linkSegmentId|linkSegmentIds)(?:\.|$)/u.test(localPath)
            || (/^editorial\.operationPlan\.operations(?:\.|\[)/u.test(localPath) && /(?:transactionId|transactionVersion|linkId)(?:\.|$)/u.test(localPath))
            || (/^editorial\.items(?:\.|\[)/u.test(localPath) && /(?:linkId|linkSegmentId)(?:\.|$)/u.test(localPath))
            || (trackOwner?.nodeId !== trackOwner?.trackId && /^inputs\.link(?:\.|$)/u.test(localPath))
            ? "CUT_LINKED_RIPPLE_CORRELATION"
          : /^(?:pictureTrackId|audioTrackId)$/u.test(localPath)
            && /(?:plan[ -]?base|operation plan|neutral direct|forward-1x|retime treatment)/iu.test(error.message)
            ? "CUT_LINKED_RIPPLE_PLAN"
          : localPath === "id" || localPath === "linkId" || localPath.startsWith("linkId.")
            ? "CUT_LINKED_RIPPLE_CARDINALITY"
            : /^(?:compositionId|sceneId|pictureTrackId|audioTrackId|kind|version)(?:\.|$)/u.test(localPath)
              ? "CUT_LINKED_RIPPLE_SCOPE"
          : "CUT_LINKED_RIPPLE_MATERIALIZATION";
      fail(
        runtimeCode,
        `strict CutAVIR correlation failed at ${error.path}: ${error.message}`,
        owner.provenance,
        { transactionId: owner.id, ...(trackOwner ? { trackId: trackOwner.trackId } : {}) },
        error,
      );
    }
  }

  const ids = new Set<string>();
  const pictureSides: ReferenceLinkedRippleDeleteSideAuthorization[] = [];
  const audioSides: ReferenceLinkedRippleDeleteSideAuthorization[] = [];
  const selected: Array<readonly [string, ReferenceLinkedRippleDeleteAuthorization]> = [];
  let correlatedOperations = 0;
  for (const transaction of transactions) {
    if (ids.has(transaction.id)) {
      fail("CUT_LINKED_RIPPLE_CARDINALITY", `linked ripple transaction id ${transaction.id} is duplicated`, transaction.provenance, { transactionId: transaction.id });
    }
    ids.add(transaction.id);
    const resolved = validateScope(ir, transaction);
    const picture = sideAuthorization(transaction, resolved.picture, "picture");
    const audio = sideAuthorization(transaction, resolved.audio, "audio");
    correlatedOperations += 4;
    if (correlatedOperations > referenceLinkedRippleDeleteLimits.maxCorrelatedOperations) {
      fail("CUT_LINKED_RIPPLE_LIMIT", `linked ripple graph exceeds maxCorrelatedOperations=${referenceLinkedRippleDeleteLimits.maxCorrelatedOperations}`, transaction.provenance, { transactionId: transaction.id });
    }
    if (transaction.compositionId !== composition.id) continue;
    pictureSides.push(picture);
    audioSides.push(audio);
    selected.push([transaction.id, Object.freeze({
      transactionId: transaction.id,
      version: transaction.version,
      compositionId: transaction.compositionId,
      sceneId: transaction.sceneId,
      linkId: transaction.linkId,
      range: freezeInterval(transaction.range),
      ...(transaction.version === 2 ? { linkSegmentIds: Object.freeze({ ...transaction.linkSegmentIds }) } : {}),
      picture,
      audio,
    })]);
  }

  return Object.freeze({
    compositionId: composition.id,
    byTransactionId: immutableMap(selected),
    pictureByTrackId: groupedImmutableMaps(pictureSides),
    audioByTrackId: groupedImmutableMaps(audioSides),
  });
}
