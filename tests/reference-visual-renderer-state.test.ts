import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer, ReferenceVisualRendererStateError } from "../lib/runtime/reference/visual";

function fixture() {
  const parsed = parseCutLanguage(`cut 0.4;
project "visual renderer state";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 2, width: 32px, height: 32px, sampleRate: 8khz) {
  scene only(duration: 1s) { Rect(width: 32px, height: 32px, fill: #c45f39); }
}
export out = render(main);`);
  assert.ok(parsed.module); assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

test("ReferenceVisualRenderer fails closed on same-instance concurrent sceneFrame calls without poisoning sequential or separate instances", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-visual-renderer-state-"));
  const ir = fixture(), { composition } = validateReferenceSession(ir), scene = ir.scenes[composition.sceneIds[0]];
  const first = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache-first"));
  const second = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache-second"));
  await Promise.all([first.prepare(), second.prepare()]);
  try {
    const active = first.sceneFrame(scene, 0, false);
    await assert.rejects(
      first.sceneFrame(scene, 1, false),
      (error: unknown) => error instanceof ReferenceVisualRendererStateError
        && error.code === "CUT_VISUAL_RENDER_REENTRANT"
        && error.compositionId === composition.id,
    );
    const frame0 = await active;
    const frame1 = await first.sceneFrame(scene, 1, false);
    assert.deepEqual(frame0.data, frame1.data, "sequential calls on one instance remain valid after the refused overlap");

    const [left, right] = await Promise.all([
      first.sceneFrame(scene, 0, false),
      second.sceneFrame(scene, 0, false),
    ]);
    assert.deepEqual(left.data, right.data, "separate renderer instances remain safely concurrent");
  } finally {
    first.close(); second.close();
    await rm(root, { recursive: true, force: true });
  }
});
