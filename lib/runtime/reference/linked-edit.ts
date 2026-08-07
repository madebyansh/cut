import type { CutAVIR, IRComposition } from "../../language/ir";
import {
  validateReferenceLinkedRippleDeleteTransactions,
  type ReferenceLinkedRippleDeleteAuthorization,
  type ReferenceLinkedRippleDeleteSideAuthorization,
} from "./linked-ripple-delete";
import {
  validateReferenceLinkedTrimTransactions,
  type ReferenceLinkedTrimAuthorization,
  type ReferenceLinkedTrimSideAuthorization,
} from "./linked-trim";
import { validateReferenceAudioTrackOperationPlan } from "./audio-edit-operations";
import { validateReferencePictureTrackOperationPlan } from "./picture-edit-operations";

export type ReferenceLinkedEditSideAuthorization =
  | ReferenceLinkedTrimSideAuthorization
  | ReferenceLinkedRippleDeleteSideAuthorization;

export type ReferenceLinkedEditAuthorization =
  | ReferenceLinkedTrimAuthorization
  | ReferenceLinkedRippleDeleteAuthorization;

export type ReferenceLinkedEditAuthorizations = Readonly<{
  compositionId: string;
  byTransactionId: ReadonlyMap<string, ReferenceLinkedEditAuthorization>;
  pictureByTrackId: ReadonlyMap<string, ReadonlyMap<string, ReferenceLinkedEditSideAuthorization>>;
  audioByTrackId: ReadonlyMap<string, ReadonlyMap<string, ReferenceLinkedEditSideAuthorization>>;
}>;

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

function mergeTrackMaps(
  left: ReadonlyMap<string, ReadonlyMap<string, ReferenceLinkedEditSideAuthorization>>,
  right: ReadonlyMap<string, ReadonlyMap<string, ReferenceLinkedEditSideAuthorization>>,
) {
  const trackIds = new Set([...left.keys(), ...right.keys()]);
  return immutableMap([...trackIds].sort().map((trackId) => {
    const entries = [...(left.get(trackId)?.entries() ?? []), ...(right.get(trackId)?.entries() ?? [])];
    const ids = new Set<string>();
    for (const [transactionId] of entries) {
      if (ids.has(transactionId)) throw new Error(`CUT_LINKED_EDIT_CORRELATION: transaction ${transactionId} authorizes ${trackId} more than once.`);
      ids.add(transactionId);
    }
    return [trackId, immutableMap(entries)] as const;
  }));
}

/** Validate every supported linked-edit kind before either media side runs. */
export function validateReferenceLinkedEditTransactions(
  ir: CutAVIR,
  composition: IRComposition,
): ReferenceLinkedEditAuthorizations {
  const trim = validateReferenceLinkedTrimTransactions(ir, composition);
  const ripple = validateReferenceLinkedRippleDeleteTransactions(ir, composition);
  const transactions = [...trim.byTransactionId.entries(), ...ripple.byTransactionId.entries()] as Array<readonly [string, ReferenceLinkedEditAuthorization]>;
  const ids = new Set<string>();
  for (const [transactionId] of transactions) {
    if (ids.has(transactionId)) throw new Error(`CUT_LINKED_EDIT_CORRELATION: transaction ${transactionId} is authorized by more than one linked-edit kind.`);
    ids.add(transactionId);
  }
  const authorizations = Object.freeze({
    compositionId: composition.id,
    byTransactionId: immutableMap(transactions),
    pictureByTrackId: mergeTrackMaps(trim.pictureByTrackId, ripple.pictureByTrackId),
    audioByTrackId: mergeTrackMaps(trim.audioByTrackId, ripple.audioByTrackId),
  });
  // A linked edit authorizes one atomic audiovisual mutation. Replaying only
  // the media side selected by a direct audio or picture runtime would let a
  // schema-valid forged materialization on the opposite side survive until a
  // later full-session validation (or be hidden behind a warm cache hit).
  // Close every affected plan here before returning either side's capability.
  for (const [trackId, trackAuthorizations] of authorizations.pictureByTrackId) {
    const track = ir.nodes[trackId];
    if (!track) throw new Error(`CUT_LINKED_EDIT_CORRELATION: authorized picture track ${trackId} is missing.`);
    validateReferencePictureTrackOperationPlan(ir, composition, track, trackAuthorizations);
  }
  for (const [trackId, trackAuthorizations] of authorizations.audioByTrackId) {
    const track = ir.nodes[trackId];
    if (!track) throw new Error(`CUT_LINKED_EDIT_CORRELATION: authorized audio track ${trackId} is missing.`);
    validateReferenceAudioTrackOperationPlan(ir, composition, track, trackAuthorizations);
  }
  return authorizations;
}
