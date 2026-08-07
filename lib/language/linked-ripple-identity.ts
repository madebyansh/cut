import { hash } from "../core/stable";

/**
 * Derive the two survivor identities of a partial linked ripple transaction.
 * These are compiler-owned semantic identities, not author-controlled labels:
 * the strict IR loader recomputes them from the transaction id.
 */
export function linkedRippleSegmentIds(transactionId: string) {
  return {
    before: `linked_segment_before_${hash({ transactionId, role: "before" }).slice(0, 16)}`,
    after: `linked_segment_after_${hash({ transactionId, role: "after" }).slice(0, 16)}`,
  } as const;
}
