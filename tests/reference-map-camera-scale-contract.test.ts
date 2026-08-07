import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function source(imports: string, body: string) {
  return `cut 0.4;
project "MapCamera scale ownership regression";
${imports}

timeline main(duration: 250ms, fps: 4, width: 96px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 250ms) {
    ${body}
  }
}

export out = render(main, width: 96px, height: 64px, codec: "h264");`;
}

function compile(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  return ir;
}

test("public MapCamera scale 15 executes as geographic zoom while generic Group scale 15 remains invalid", async () => {
  const mapIr = compile(source(
    'import { MapCamera, Map, Marker } from "@cut/geo";',
    `MapCamera(latitude: 12, longitude: 77, scale: 15) {
      Map(detail: "110m");
      Marker(point: { latitude: 12, longitude: 77 }, color: #ef233c, radius: 6px);
    }`,
  ));
  const session = validateReferenceSession(mapIr);
  const root = await mkdtemp(resolve(tmpdir(), "cut-map-camera-scale-contract-"));
  const renderer = new ReferenceVisualRenderer(mapIr, session.composition, root, resolve(root, ".cut-cache"));
  await renderer.prepare();
  try {
    const scene = mapIr.scenes[session.composition.sceneIds[0]]!;
    const frame = await renderer.sceneFrame(scene, 0, false);
    const evidence = renderer.referenceMapCameraEvidence();
    assert.equal(frame.width, 96);
    assert.equal(frame.height, 64);
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0].retainedGeoPass.state.exact.scale, { numerator: "15", denominator: "1" });
    assert.equal(evidence[0].retainedGeoPass.counters.rasterizations, 1);
    assert.equal(evidence[0].retainedGeoPass.counters.resizePasses, 0);
    assert.equal(evidence[0].retainedGeoPass.counters.resamplePasses, 0);
    assert.ok(frame.data.some((value, index) => index % 4 === 3 && value > 0), "scale 15 must execute visible final-space pixels");
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }

  const groupIr = compile(source(
    'import { Group, Rect } from "cut:visual";',
    "Group(scale: 15) { Rect(width: 8px, height: 8px, fill: #ef233c); }",
  ));
  assert.throws(
    () => validateReferenceSession(groupIr),
    (error: unknown) => error instanceof ReferenceVisualConfigError
      && error.code === "CUT_VISUAL_VALUE_RANGE"
      && /cut\.visual\.group at project\.cut:\d+:\d+ input .scale. must be between 0\.001 and 8/u.test(error.message),
  );
});
