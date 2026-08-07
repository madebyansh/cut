import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { referenceGeoMapCameraPoint } from "../lib/runtime/reference/geo-projection";
import { validateReferenceStaticVisualGraphs } from "../lib/runtime/reference/static-visual-validation";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const staticPitchSource = `cut 0.4;
project "Public projective map camera";
import { MapCamera, Map, Marker, GeoAnnotation } from "@cut/geo";
import { LocalSpace, Rect } from "cut:visual";

timeline main(duration: 1s, fps: 4, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MapCamera(scale: 2, pitch: 38deg) {
      Map(detail: "110m", background: #f4efe4, land: #b9d2c2, border: #375c50, graticule: #375c5044);
      Marker(point: { latitude: 25, longitude: 0 }, color: #ff00ff, radius: 6px);
      GeoAnnotation(
        anchor: { latitude: 25, longitude: 0 },
        placements: ["right"],
        offset: 8px,
        safeArea: 4px,
        leader: "straight",
        leaderColor: #23342e,
        leaderWidth: 1px
      ) {
        LocalSpace(width: 36px, height: 16px, origin: { x: 0px, y: 0px }) {
          Rect(width: 36px, height: 16px, x: 18px, y: 8px, fill: #fff8e8);
        }
      }
    }
  }
}

export out = render(main, width: 320px, height: 180px, codec: "h264");`;

const animatedPitchSource = `cut 0.4;
project "Animated projective map camera";
import { MapCamera, Map, Marker } from "@cut/geo";
import { linear } from "@cut/motion";

timeline main(duration: 1s, fps: 4, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MapCamera(scale: 2, pitch: 0deg) as camera {
      Map(detail: "110m", background: #f4efe4, land: #b9d2c2, border: #375c50, graticule: #375c5044);
      Marker(point: { latitude: 25, longitude: 0 }, color: #ff00ff, radius: 6px);
    }
    animate camera.pitch from 0deg to 48deg over 1s ease linear;
  }
}

export out = render(main, width: 320px, height: 180px, codec: "h264");`;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  return { ir, session: validateReferenceSession(ir) };
}

function exactRgbBounds(frame: { data: Uint8Array; width: number; height: number }, rgb: readonly [number, number, number]) {
  let left = frame.width, top = frame.height, right = -1, bottom = -1, count = 0;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    const offset = (y * frame.width + x) * 4;
    if (frame.data[offset] !== rgb[0] || frame.data[offset + 1] !== rgb[1]
      || frame.data[offset + 2] !== rgb[2] || frame.data[offset + 3] !== 255) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count += 1;
  }
  assert.ok(count > 0, `expected opaque rgb(${rgb.join(",")}) pixels`);
  return { centerX: (left + right) / 2, centerY: (top + bottom) / 2, count };
}

test("public static pitch executes one bounded projective stream shared by retained geometry and GeoAnnotation", async () => {
  const { ir, session } = compile(staticPitchSource);
  const root = await mkdtemp(resolve(tmpdir(), "cut-public-map-pitch-"));
  const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, ".cut-cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[session.composition.sceneIds[0]];
    const frame = await renderer.sceneFrame(scene, 0, false);
    const receipt = renderer.referenceMapCameraEvidence()[0];
    const annotation = renderer.referenceGeoAnnotationEvidence()[0];
    assert.equal(receipt.version, 5);
    assert.equal(receipt.retainedGeoPass.version, 5);
    assert.equal(receipt.retainedGeoPass.cameraAlgorithmVersion, "cut-reference-map-camera-v4");
    assert.equal(receipt.retainedGeoPass.projectionAlgorithm, "cut-reference-natural-earth-map-camera-v3");
    assert.equal(receipt.retainedGeoPass.algorithmVersion, "cut-reference-map-camera-final-space-render-v5");
    assert.equal(receipt.retainedGeoPass.state.pitch, 38);
    assert.deepEqual(receipt.retainedGeoPass.state.exact.pitch, { numerator: "38", denominator: "1" });
    assert.equal(receipt.retainedGeoPass.projectivePitch.applied, true);
    assert.equal(receipt.retainedGeoPass.projectivePitch.transformOrder, "bearing-then-pitch");
    assert.equal(receipt.retainedGeoPass.projectivePitch.focalDistance, 180);
    assert.ok(receipt.retainedGeoPass.projectivePitch.projectedStreamPointEvents > 0);
    assert.ok(receipt.retainedGeoPass.projectivePitch.projectedStreamPointEvents <= 2_097_152);
    assert.equal(receipt.retainedGeoPass.projectivePitch.preimage.limit, 8);
    assert.ok(receipt.retainedGeoPass.projectivePitch.preimage.maximumExpansion <= 8);
    assert.equal(receipt.retainedGeoPass.projectivePitch.forwardDenominator.finite, true);
    assert.equal(receipt.retainedGeoPass.projectivePitch.forwardDenominator.positive, true);
    assert.equal(receipt.retainedGeoPass.projectivePitch.inverseDenominator.finite, true);
    assert.equal(receipt.retainedGeoPass.projectivePitch.inverseDenominator.positive, true);
    assert.equal(receipt.retainedGeoPass.counters.preProjectiveClipConfigurations, 1);
    assert.equal(receipt.retainedGeoPass.counters.postProjectiveClipConfigurations, 1);
    assert.equal(receipt.retainedGeoPass.counters.resizePasses, 0);
    assert.equal(receipt.retainedGeoPass.counters.resamplePasses, 0);
    assert.equal(receipt.retainedGeoPass.counters.projectivePitchPointEvents, receipt.retainedGeoPass.projectivePitch.projectedStreamPointEvents);

    const expected = referenceGeoMapCameraPoint(
      320, 180,
      { latitude: 0, longitude: 0 }, 2,
      { latitude: 25, longitude: 0 }, 0, 38,
    );
    const marker = exactRgbBounds(frame, [255, 0, 255]);
    assert.ok(Math.abs(marker.centerX - expected[0]) <= 1 && Math.abs(marker.centerY - expected[1]) <= 1, JSON.stringify({ marker, expected }));
    assert.ok("pitch" in annotation.camera.state);
    assert.equal("pitch" in annotation.camera.state ? annotation.camera.state.pitch : undefined, 38);
    assert.ok(Math.abs(annotation.decisions[0].exactAnchor.x - expected[0]) < 1e-9);
    assert.ok(Math.abs(annotation.decisions[0].exactAnchor.y - expected[1]) < 1e-9);
    assert.equal(receipt.annotations.executionIdentity, annotation.executionIdentity);
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("animated pitch keeps the zero branch exact and produces distinct sampled pixels, work, and cache identity", async () => {
  const { ir, session } = compile(animatedPitchSource);
  const root = await mkdtemp(resolve(tmpdir(), "cut-public-map-pitch-motion-"));
  const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, ".cut-cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[session.composition.sceneIds[0]];
    const zeroFrame = await renderer.sceneFrame(scene, 0, false);
    const zero = renderer.referenceMapCameraEvidence()[0];
    const pitchedFrame = await renderer.sceneFrame(scene, 2, false);
    const pitched = renderer.referenceMapCameraEvidence()[0];
    assert.equal(zero.retainedGeoPass.state.pitch, 0);
    assert.equal(zero.retainedGeoPass.projectivePitch.applied, false);
    assert.equal(zero.retainedGeoPass.projectivePitch.projectedStreamPointEvents, 0);
    assert.deepEqual(zero.retainedGeoPass.projectivePitch.preimage, {
      left: 0, top: 0, right: 320, bottom: 180,
      expansionX: 1, expansionY: 1, maximumExpansion: 1, limit: 8,
    });
    assert.equal(pitched.retainedGeoPass.state.pitch, 24);
    assert.equal(pitched.retainedGeoPass.projectivePitch.applied, true);
    assert.ok(pitched.retainedGeoPass.projectivePitch.projectedStreamPointEvents > 0);
    assert.notEqual(pitched.retainedGeoPass.surface.sha256, zero.retainedGeoPass.surface.sha256);
    assert.notEqual(pitched.retainedGeoPass.cacheIdentity, zero.retainedGeoPass.cacheIdentity);
    assert.notEqual(pitched.cacheIdentity, zero.cacheIdentity);
    assert.notDeepEqual(exactRgbBounds(pitchedFrame, [255, 0, 255]), exactRgbBounds(zeroFrame, [255, 0, 255]));
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("static default-equivalent and out-of-range pitch fail with source-located stable runtime diagnostics", () => {
  for (const [authored, expectedCode] of [["0deg", "CUT_MAP_CAMERA_NOOP"], ["61deg", "CUT_MAP_CAMERA_RANGE"]] as const) {
    const parsed = parseCutLanguage(staticPitchSource.replace("pitch: 38deg", `pitch: ${authored}`));
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    const checked = checkCutModule(parsed.module);
    assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
    const ir = compileCutModule(parsed.module).ir;
    const diagnostic = validateReferenceStaticVisualGraphs(ir).find((item) => item.code === expectedCode);
    assert.ok(diagnostic, JSON.stringify(validateReferenceStaticVisualGraphs(ir)));
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    assert.match(diagnostic.message, /pitch/u);
  }
});
