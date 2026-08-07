import type { CutAVIR } from "../lib/language/ir";
import { registerAppliedCutLockIr } from "../lib/language/locked-ir-state";
import {
  renderReferenceIr as renderLockedReferenceIr,
  type ReferenceRenderOptions,
} from "../lib/runtime/reference/render";

export const testRenderLockSha256 = "5e815f4f735f4def477e2a0c5560ae077a98f73b41655d128936f34b4a201294";

type TestReferenceRenderOptions = Omit<ReferenceRenderOptions, "lockSha256"> & { lockSha256?: string };

/** Test-only convenience. Production callers must supply the verified digest. */
export function renderReferenceIr(
  ir: CutAVIR,
  projectRoot: string,
  outputPath: string,
  outputName?: string,
  options: TestReferenceRenderOptions = {},
) {
  // Test fixtures often construct already-locked synthetic IR without an
  // external source+cut.lock round trip. Production code cannot call this
  // helper; explicitly brand only this exact in-memory test object so later
  // mutation/serialization still fails the runtime authority check.
  registerAppliedCutLockIr(ir);
  return renderLockedReferenceIr(ir, projectRoot, outputPath, outputName, {
    ...options,
    lockSha256: options.lockSha256 ?? testRenderLockSha256,
  });
}
