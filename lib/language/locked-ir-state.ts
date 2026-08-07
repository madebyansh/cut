import { hash } from "../core/stable";
import type { CutAVIR } from "./ir";

const appliedLocks = new WeakMap<CutAVIR, string>();

export class CutProxyLockStateError extends Error {
  readonly code = "CUT_PROXY_LOCK_STATE" as const;

  constructor(message: string) {
    super(`CUT_PROXY_LOCK_STATE: ${message}`);
    this.name = "CutProxyLockStateError";
  }
}

function appliedLockSnapshot(ir: CutAVIR) {
  // Bind the complete applied result, not merely its derived buildId or media
  // table. A caller must not be able to edit executable nodes, timelines,
  // packages, jobs, or source identity after lock verification and then use
  // media-profile selection as a new execution authority.
  return hash(ir);
}

export function registerAppliedCutLockIr(ir: CutAVIR) {
  appliedLocks.set(ir, appliedLockSnapshot(ir));
}

export function assertAppliedCutLockIr(ir: CutAVIR) {
  const expected = appliedLocks.get(ir);
  if (!expected || expected !== appliedLockSnapshot(ir)) {
    throw new CutProxyLockStateError("media-profile selection requires the unchanged invocation-local result of applyCutLock.");
  }
}
