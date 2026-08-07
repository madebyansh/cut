import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { inspectCutIr } from "../lib/runtime/inspect";
import type { ReferenceLocalSpaceFrameEvidence } from "../lib/runtime/reference/local-space";
import { planReferenceLocalSpaceTileTransformWork } from "../lib/runtime/reference/local-space-transform-work";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  assertReferenceLocalSpaceObservedDimensions,
  ReferenceVisualRenderer,
  validateReferenceLocalSpaceTransformExecutionPlan,
} from "../lib/runtime/reference/visual";

const q = (numerator: number | string, denominator: number | string = 1) => ({
  numerator: String(numerator),
  denominator: String(denominator),
});

type TrackStatus = "visible" | "occluded" | "out-of-frame";

function trackingSidecar(samples: ReadonlyArray<{
  at: ReturnType<typeof q>;
  x: ReturnType<typeof q>;
  y: ReturnType<typeof q>;
  status: TrackStatus;
  confidence?: ReturnType<typeof q>;
  scale?: ReturnType<typeof q>;
  rotation?: ReturnType<typeof q>;
}>) {
  return {
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 40,
    height: 30,
    samples: samples.map((sample) => ({
      confidence: q(1),
      ...sample,
    })),
  };
}

function trackSource(options: { opacity?: string; animateOpacity?: boolean } = {}) {
  return `cut 0.4;
project "locked direct retained tracking pixels";
import { LocalSpace, Rect, Track2D } from "cut:visual";
import { linear } from "@cut/motion";
asset tracking: DataAsset = data("assets/subject.track.json");
timeline main(duration: 1s, fps: 4, width: 40px, height: 30px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Track2D(
      source: tracking,
      minConfidence: 60%,
      lowConfidence: "fail",
      occluded: "fail",
      outOfFrame: "hide",
      interpolation: "hold",
      bindScale: true,
      bindRotation: true,
      x: 2px,
      y: -1px,
      scale: 0.5,
      rotation: 10deg,
      opacity: ${options.opacity ?? "80%"}
    ) as tracked {
      LocalSpace(width: 5px, height: 3px, origin: { x: 0.25px, y: 0.75px }) {
        Rect(width: 1px, height: 1px, x: 0px, y: 0px, fill: #c86432);
      }
    }
    ${options.animateOpacity ? "animate tracked.opacity from 0% to 100% over 1s ease linear;" : ""}
  }
}
export out = render(main, width: 40px, height: 30px, codec: "h264");`;
}

function depthSource(edge: "transparent" | "clamp") {
  return `cut 0.4;
project "locked direct retained depth pixels";
import { Circle, DepthLayer, LocalSpace, ParallaxCamera, Rect } from "cut:visual";
import { linear } from "@cut/motion";
timeline main(duration: 2s, fps: 4, width: 40px, height: 30px, sampleRate: 48khz) {
  scene intro(duration: 1s) {
    Rect(width: 40px, height: 30px, x: 20px, y: 15px, fill: #101820);
  }
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 20px) as camera {
      DepthLayer(depth: 20px, edge: "${edge}") {
        LocalSpace(width: 8px, height: 6px, origin: { x: 4.25px, y: 3.5px }) {
          Rect(width: 8px, height: 6px, x: -0.25px, y: -0.5px, fill: #2eb872);
        }
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        Circle(radius: 1px, x: 34px, y: 24px, fill: #2855d9);
      }
    }
    animate camera.x from 0px to 8px over 1s ease linear;
  }
}
export out = render(main, width: 40px, height: 30px, codec: "h264");`;
}

function concurrentSiblingSource() {
  return `cut 0.4;
project "serialized sibling retained transforms";
import { Group, LocalSpace, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 40px, height: 30px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Group(x: -8px) {
      LocalSpace(width: 5px, height: 5px, origin: { x: 2.5px, y: 2.5px }) {
        Rect(width: 3px, height: 3px, x: 0px, y: 0px, fill: #ef233c);
      }
    }
    Group(x: 8px) {
      LocalSpace(width: 5px, height: 5px, origin: { x: 2.5px, y: 2.5px }) {
        Rect(width: 3px, height: 3px, x: 0px, y: 0px, fill: #2855d9);
      }
    }
  }
}
export out = render(main, width: 40px, height: 30px, codec: "h264");`;
}

function compile(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

async function lockedProject(program: string, sidecar?: object) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-owner-render-"));
  if (sidecar) {
    const assets = resolve(root, "assets");
    await mkdir(assets);
    await writeFile(resolve(assets, "subject.track.json"), JSON.stringify(sidecar));
  }
  const ir = compile(program), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { root, ir };
}

async function rendererFor(project: { root: string; ir: CutAVIR }) {
  const { composition } = validateReferenceSession(project.ir, "out");
  const renderer = new ReferenceVisualRenderer(project.ir, composition, project.root, resolve(project.root, ".cut", "owner-render-cache"));
  await renderer.prepare();
  return { renderer, composition, scene: project.ir.scenes[composition.sceneIds[0]]! };
}

function rgba(frame: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * frame.width + x) * 4;
  return [...frame.data.subarray(offset, offset + 4)];
}

function alpha(frame: { data: Uint8Array; width: number; height: number }) {
  const values: Array<{ x: number; y: number; alpha: number }> = [];
  let weight = 0, xWeight = 0, yWeight = 0;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    const value = frame.data[(y * frame.width + x) * 4 + 3];
    if (value === 0) continue;
    values.push({ x, y, alpha: value });
    weight += value;
    xWeight += x * value;
    yWeight += y * value;
  }
  return { values, weight, x: weight ? xWeight / weight : Number.NaN, y: weight ? yWeight / weight : Number.NaN };
}

function onlyPlacement(evidence: ReferenceLocalSpaceFrameEvidence | undefined) {
  assert.ok(evidence);
  assert.equal(evidence.placements.length, 1);
  const placement = evidence.placements[0];
  assert.ok(placement?.transform);
  return { evidence, placement, transform: placement.transform };
}

test("locked public Track2D LocalSpace paints the Q16-registered tile through the exact owner transform and reports completed work", { timeout: 30_000 }, async () => {
  const sidecar = trackingSidecar([
    { at: q(0), x: q(10), y: q(12), scale: q(2), rotation: q(90), status: "visible" },
    { at: q(1), x: q(10), y: q(12), scale: q(2), rotation: q(90), status: "visible" },
  ]);
  const project = await lockedProject(trackSource(), sidecar);
  try {
    const { renderer, scene } = await rendererFor(project);
    try {
      const frame = await renderer.sceneFrame(scene, 0, false), rendered = alpha(frame);
      assert.ok(rendered.weight > 0, "a visible retained tracking sample must paint pixels");
      assert.deepEqual(rendered.values, [
        { x: 12, y: 9, alpha: 1 },
        { x: 11, y: 10, alpha: 2 },
        { x: 12, y: 10, alpha: 7 },
        { x: 11, y: 11, alpha: 7 },
        { x: 12, y: 11, alpha: 22 },
      ], "the locked Q16 registration plus composed scale/rotation/opacity must have exact output pixels");

      const { evidence, placement, transform } = onlyPlacement(renderer.referenceLocalSpaceEvidence());
      assert.equal(placement.owner, "track-2d");
      assert.deepEqual(transform, {
        destinationX: 12,
        destinationY: 11,
        registrationRasterX: 0.25,
        registrationRasterY: 0.75,
        scale: 1,
        skewX: 0,
        skewY: 0,
        rotation: 100,
        opacity: 0.8,
      });
      assert.match(placement.transformWork?.workIdentity ?? "", /^[a-f0-9]{64}$/);
      assert.deepEqual(placement.transformWork && { ...placement.transformWork, workIdentity: "<bound>" }, {
        workIdentity: "<bound>",
        algorithmVersion: "cut-reference-local-space-transform-work-v2",
        rendererHandoff: "connected-reference-visual-renderer",
        schedulingEnforcement: "reference-visual-renderer-fifo-v1",
        source: { width: 5, height: 3 },
        requestedResize: { width: 5, height: 3 },
        sharpCover: { width: 5, height: 3 },
        rotation: { width: 4, height: 5, canonicalDegrees: 100 },
        destination: { width: 40, height: 30 },
        opacityDestinationCopies: 1,
      });
      assert.deepEqual(evidence.counters, {
        tileRequests: 1,
        tileRasterizations: 1,
        tileMemoHits: 0,
        tilePixelsRasterized: 15,
        placementRequests: 1,
        placementRasterizations: 1,
        placementMemoHits: 0,
        placementDestinationPixels: 1_200,
        transformExecutions: 1,
        maximumConcurrentTransforms: 1,
        localNodeRasterizations: 1,
        localNodePixelsRasterized: 15,
        localNodeRgbaBytesRasterized: 60,
        localPaintSurfaceCacheHits: 0,
        localPaintSurfaceCacheMisses: 1,
        localPaintSurfaceCacheBypasses: 0,
        localPaintSurfaceCacheEvictions: 0,
        localPaintSurfaceCacheResidentBytes: 60,
        inactiveNodeSkips: 0,
        ownerOpacitySkips: 0,
        ownerPolicySkips: 0,
        localNodeOpacitySkips: 0,
      });
      assert.deepEqual(evidence.exactTime, rational(0));
      assert.equal(evidence.outputFrame, "0");
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("locked Track2D hide policy terminates before any LocalSpace tile or placement raster", { timeout: 30_000 }, async () => {
  const sidecar = trackingSidecar([
    { at: q(0), x: q(10), y: q(12), scale: q(1), rotation: q(0), status: "visible" },
    { at: q(1, 2), x: q(-1), y: q(12), status: "out-of-frame" },
    { at: q(1), x: q(20), y: q(15), scale: q(1), rotation: q(0), status: "visible" },
  ]);
  const project = await lockedProject(trackSource(), sidecar);
  try {
    const { renderer, scene } = await rendererFor(project);
    try {
      const frame = await renderer.sceneFrame(scene, 2, false), evidence = renderer.referenceLocalSpaceEvidence();
      assert.ok(frame.data.every((byte) => byte === 0));
      assert.ok(evidence);
      assert.deepEqual(evidence.counters, {
        tileRequests: 0,
        tileRasterizations: 0,
        tileMemoHits: 0,
        tilePixelsRasterized: 0,
        placementRequests: 0,
        placementRasterizations: 0,
        placementMemoHits: 0,
        placementDestinationPixels: 0,
        transformExecutions: 0,
        maximumConcurrentTransforms: 0,
        localNodeRasterizations: 0,
        localNodePixelsRasterized: 0,
        localNodeRgbaBytesRasterized: 0,
        localPaintSurfaceCacheHits: 0,
        localPaintSurfaceCacheMisses: 0,
        localPaintSurfaceCacheBypasses: 0,
        localPaintSurfaceCacheEvictions: 0,
        localPaintSurfaceCacheResidentBytes: 0,
        inactiveNodeSkips: 0,
        ownerOpacitySkips: 0,
        ownerPolicySkips: 1,
        localNodeOpacitySkips: 0,
      });
      const localNode = Object.values(project.ir.nodes).find((node) => node.op === "cut.visual.local_space");
      const ownerNode = Object.values(project.ir.nodes).find((node) => node.op === "cut.visual.track_2d");
      assert.ok(localNode && ownerNode);
      assert.deepEqual(evidence.skips, [{
        nodeId: localNode.id,
        ownerNodeId: ownerNode.id,
        sampleTime: q(1, 2),
        kind: "owner-policy",
        reason: "tracking-policy-hidden",
      }]);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("locked Track2D owner opacity zero terminates before any LocalSpace tile or placement raster", { timeout: 30_000 }, async () => {
  const sidecar = trackingSidecar([
    { at: q(0), x: q(10), y: q(12), scale: q(1), rotation: q(0), status: "visible" },
    { at: q(1), x: q(20), y: q(15), scale: q(1), rotation: q(0), status: "visible" },
  ]);
  const project = await lockedProject(trackSource({ opacity: "0%", animateOpacity: true }), sidecar);
  try {
    const { renderer, scene } = await rendererFor(project);
    try {
      const frame = await renderer.sceneFrame(scene, 0, false), evidence = renderer.referenceLocalSpaceEvidence();
      assert.ok(frame.data.every((byte) => byte === 0));
      assert.ok(evidence);
      assert.deepEqual(evidence.counters, {
        tileRequests: 0,
        tileRasterizations: 0,
        tileMemoHits: 0,
        tilePixelsRasterized: 0,
        placementRequests: 0,
        placementRasterizations: 0,
        placementMemoHits: 0,
        placementDestinationPixels: 0,
        transformExecutions: 0,
        maximumConcurrentTransforms: 0,
        localNodeRasterizations: 0,
        localNodePixelsRasterized: 0,
        localNodeRgbaBytesRasterized: 0,
        localPaintSurfaceCacheHits: 0,
        localPaintSurfaceCacheMisses: 0,
        localPaintSurfaceCacheBypasses: 0,
        localPaintSurfaceCacheEvictions: 0,
        localPaintSurfaceCacheResidentBytes: 0,
        inactiveNodeSkips: 0,
        ownerOpacitySkips: 1,
        ownerPolicySkips: 0,
        localNodeOpacitySkips: 0,
      });
      const localNode = Object.values(project.ir.nodes).find((node) => node.op === "cut.visual.local_space");
      const ownerNode = Object.values(project.ir.nodes).find((node) => node.op === "cut.visual.track_2d");
      assert.ok(localNode && ownerNode);
      assert.deepEqual(evidence.skips, [{
        nodeId: localNode.id,
        ownerNodeId: ownerNode.id,
        sampleTime: q(0),
        kind: "owner-opacity",
        reason: "opacity-zero",
      }]);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("two concurrently requested sibling LocalSpace branches execute through one renderer-local FIFO transform slot", { timeout: 30_000 }, async () => {
  const project = await lockedProject(concurrentSiblingSource());
  try {
    const { renderer, scene } = await rendererFor(project);
    try {
      const frame = await renderer.sceneFrame(scene, 0, false), evidence = renderer.referenceLocalSpaceEvidence();
      assert.ok(evidence);
      assert.equal(evidence.tiles.length, 2);
      assert.equal(evidence.placements.length, 2);
      assert.deepEqual(evidence.placements.map((placement) => placement.owner), ["group", "group"]);
      assert.deepEqual(evidence.counters, {
        tileRequests: 2,
        tileRasterizations: 2,
        tileMemoHits: 0,
        tilePixelsRasterized: 50,
        placementRequests: 2,
        placementRasterizations: 2,
        placementMemoHits: 0,
        placementDestinationPixels: 2_400,
        transformExecutions: 2,
        maximumConcurrentTransforms: 1,
        localNodeRasterizations: 2,
        localNodePixelsRasterized: 50,
        localNodeRgbaBytesRasterized: 200,
        localPaintSurfaceCacheHits: 0,
        localPaintSurfaceCacheMisses: 2,
        localPaintSurfaceCacheBypasses: 0,
        localPaintSurfaceCacheEvictions: 0,
        localPaintSurfaceCacheResidentBytes: 200,
        inactiveNodeSkips: 0,
        ownerOpacitySkips: 0,
        ownerPolicySkips: 0,
        localNodeOpacitySkips: 0,
      });
      let red = 0, blue = 0;
      for (let offset = 0; offset < frame.data.length; offset += 4) {
        if (frame.data[offset] > frame.data[offset + 2] + 80 && frame.data[offset + 3] > 0) red += 1;
        if (frame.data[offset + 2] > frame.data[offset] + 80 && frame.data[offset + 3] > 0) blue += 1;
      }
      assert.ok(red >= 4 && blue >= 4, `both serialized sibling transforms must remain visible: red=${red}, blue=${blue}`);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("retained transform execution rejects forged admitted work and backend geometry drift at the owner source", () => {
  const ir = compile(trackSource());
  const owner = Object.values(ir.nodes).find((node) => node.op === "cut.visual.track_2d");
  assert.ok(owner);
  const request = {
    source: { width: 5, height: 3 },
    destination: { width: 40, height: 30 },
    scale: 1,
    rotation: 100,
    opacity: 0.8,
    skewX: 0,
    skewY: 0,
  } as const;
  const admitted = planReferenceLocalSpaceTileTransformWork(owner, {
    source: request.source,
    destination: request.destination,
    scale: request.scale,
    rotation: request.rotation,
    opacity: request.opacity,
  });
  const forged = {
    ...admitted,
    requestedResize: { ...admitted.requestedResize, width: admitted.requestedResize.width + 1 },
  } as typeof admitted;
  assert.throws(
    () => validateReferenceLocalSpaceTransformExecutionPlan(owner, forged, request),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CUT_LOCAL_SPACE_RASTER:/);
      assert.match(error.message, /admitted transform work .* does not match runtime-derived work/);
      assert.deepEqual((error as { source?: unknown }).source, {
        module: owner.provenance.module,
        line: owner.provenance.span.start.line,
        column: owner.provenance.span.start.column,
        nodeId: owner.id,
      });
      return true;
    },
  );
  assert.throws(
    () => assertReferenceLocalSpaceObservedDimensions(owner, "rotation output", { width: 5, height: 5 }, admitted.rotation),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CUT_LOCAL_SPACE_RASTER:/);
      assert.match(error.message, /rotation output produced 5x5; admitted transform work requires 4x5/);
      assert.equal((error as { source?: { nodeId?: string } }).source?.nodeId, owner.id);
      return true;
    },
  );
});

test("Track2D executes the admitted non-square Sharp-cover request and records its cropped output", { timeout: 30_000 }, async () => {
  const program = trackSource()
    .replace("rotation: 10deg", "rotation: 0deg")
    .replace("LocalSpace(width: 5px, height: 3px", "LocalSpace(width: 7px, height: 3px");
  const sidecar = trackingSidecar([
    { at: q(0), x: q(10), y: q(12), scale: q(1), rotation: q(0), status: "visible" },
    { at: q(1), x: q(10), y: q(12), scale: q(1), rotation: q(0), status: "visible" },
  ]);
  const project = await lockedProject(program, sidecar);
  try {
    const { renderer, scene } = await rendererFor(project);
    try {
      const frame = await renderer.sceneFrame(scene, 0, false);
      assert.ok(alpha(frame).weight > 0);
      const { placement } = onlyPlacement(renderer.referenceLocalSpaceEvidence());
      assert.equal(placement.owner, "track-2d");
      assert.deepEqual(placement.transformWork?.source, { width: 7, height: 3 });
      assert.deepEqual(placement.transformWork?.sharpCover, { width: 5, height: 2 });
      assert.deepEqual(placement.transformWork?.requestedResize, { width: 4, height: 2 });
      assert.deepEqual(placement.transformWork?.rotation, { width: 4, height: 2, canonicalDegrees: 0 });
      assert.equal(placement.transformWork?.opacityDestinationCopies, 1);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

for (const edge of ["transparent", "clamp"] as const) test(`locked public DepthLayer LocalSpace executes ${edge} source bounds, later-scene activation, exact evidence, and camera motion`, { timeout: 30_000 }, async () => {
  const project = await lockedProject(depthSource(edge));
  try {
    const { renderer, composition } = await rendererFor(project);
    const scene = project.ir.scenes[composition.sceneIds[1]];
    assert.ok(scene, "the retained depth camera must remain in the public timeline's later scene");
    try {
      const first = await renderer.sceneFrame(scene, 0, false), firstProof = onlyPlacement(renderer.referenceLocalSpaceEvidence());
      assert.equal(firstProof.placement.owner, "depth-layer");
      assert.deepEqual(firstProof.transform, edge === "transparent" ? {
        destinationX: 20,
        destinationY: 15,
        registrationRasterX: 4.25,
        registrationRasterY: 3.5,
        scale: 0.5,
        skewX: 0,
        skewY: 0,
        rotation: 0,
        opacity: 1,
      } : {
        destinationX: 20,
        destinationY: 15,
        registrationRasterX: 42.25,
        registrationRasterY: 32.5,
        scale: 0.5,
        skewX: 0,
        skewY: 0,
        rotation: 0,
        opacity: 1,
      });
      assert.match(firstProof.placement.transformWork?.workIdentity ?? "", /^[a-f0-9]{64}$/);
      const scaleTranslation = firstProof.placement.transformWork?.scaleTranslation;
      assert.ok(scaleTranslation, "fractional retained DepthLayer placement must fuse resize and translation");
      assert.equal(scaleTranslation.algorithmVersion, "cut-reference-local-space-scale-translation-v2");
      assert.equal(scaleTranslation.sampler, "cut-q16-associated-bilinear-destination-clipped-affine");
      assert.match(scaleTranslation.planIdentity, /^[a-f0-9]{64}$/u);
      assert.match(scaleTranslation.projectivePlanIdentity, /^[a-f0-9]{64}$/u);
      assert.equal(
        scaleTranslation.observedWork.insideQuadPixels,
        scaleTranslation.observedWork.integerSamplesCopied + scaleTranslation.observedWork.bilinearSamplesEvaluated,
      );
      assert.deepEqual(
        firstProof.placement.transformWork && {
          ...firstProof.placement.transformWork,
          workIdentity: "<bound>",
          scaleTranslation: undefined,
        },
        edge === "transparent" ? {
          workIdentity: "<bound>",
          algorithmVersion: "cut-reference-local-space-transform-work-v2",
          rendererHandoff: "connected-reference-visual-renderer",
          schedulingEnforcement: "reference-visual-renderer-fifo-v1",
          source: { width: 8, height: 6 },
          requestedResize: { width: 4, height: 3 },
          sharpCover: { width: 4, height: 3 },
          rotation: { width: 4, height: 3, canonicalDegrees: 0 },
          destination: { width: 40, height: 30 },
          opacityDestinationCopies: 0,
          scaleTranslation: undefined,
        } : {
          workIdentity: "<bound>",
          algorithmVersion: "cut-reference-local-space-transform-work-v2",
          rendererHandoff: "connected-reference-visual-renderer",
          schedulingEnforcement: "reference-visual-renderer-fifo-v1",
          source: { width: 85, height: 65 },
          requestedResize: { width: 43, height: 33 },
          sharpCover: { width: 43, height: 33 },
          rotation: { width: 43, height: 33, canonicalDegrees: 0 },
          destination: { width: 40, height: 30 },
          opacityDestinationCopies: 0,
          scaleTranslation: undefined,
        },
      );
      assert.deepEqual(firstProof.evidence.counters, {
        tileRequests: 1,
        tileRasterizations: 1,
        tileMemoHits: 0,
        tilePixelsRasterized: 48,
        placementRequests: 1,
        placementRasterizations: 1,
        placementMemoHits: 0,
        placementDestinationPixels: 1_200,
        transformExecutions: 1,
        maximumConcurrentTransforms: 1,
        localNodeRasterizations: 1,
        localNodePixelsRasterized: 48,
        localNodeRgbaBytesRasterized: 192,
        localPaintSurfaceCacheHits: 0,
        localPaintSurfaceCacheMisses: 1,
        localPaintSurfaceCacheBypasses: 0,
        localPaintSurfaceCacheEvictions: 0,
        localPaintSurfaceCacheResidentBytes: 192,
        inactiveNodeSkips: 0,
        ownerOpacitySkips: 0,
        ownerPolicySkips: 0,
        localNodeOpacitySkips: 0,
      });
      assert.deepEqual(firstProof.evidence.exactTime, rational(0));
      assert.equal(firstProof.evidence.outputFrame, "4", "the retained owner must activate in the second public scene without losing global frame provenance");

      if (edge === "transparent") {
        assert.equal(rgba(first, 0, 0)[3], 0, "outside a declared local tile must remain transparent");
        assert.ok(rgba(first, 20, 15)[1] > rgba(first, 20, 15)[0] + 40, `retained green tile missing at plane centre: ${rgba(first, 20, 15)}`);
      } else {
        assert.ok(rgba(first, 0, 0)[1] > rgba(first, 0, 0)[0] + 40, `clamp must replicate the declared local border into the corner: ${rgba(first, 0, 0)}`);
      }

      const later = await renderer.sceneFrame(scene, 2, false), laterProof = onlyPlacement(renderer.referenceLocalSpaceEvidence());
      assert.deepEqual(laterProof.evidence.exactTime, rational(1, 2));
      assert.equal(laterProof.evidence.outputFrame, "6");
      assert.equal(laterProof.transform.destinationX, 18, "the farther plane must move by camera.x times its 0.5 projection scale");
      assert.notEqual(laterProof.placement.placementIdentity, firstProof.placement.placementIdentity);
      if (edge === "transparent") {
        const firstPixels = alpha(first), laterPixels = alpha(later);
        assert.ok(firstPixels.weight > 0 && laterPixels.weight > 0);
        assert.ok(firstPixels.x - laterPixels.x > 1.5, `${firstPixels.x} -> ${laterPixels.x}`);
      }
    } finally {
      await renderer.closeAndWait();
    }

    const camera = Object.values(project.ir.nodes).find((node) => node.op === "cut.visual.parallax_camera");
    assert.ok(camera);
    const inspected = inspectCutIr(project.ir, "main.cut").graph.nodes.find((node) => node.id === camera.id)?.parallaxCamera;
    assert.ok(inspected);
    const retained = inspected.layers.find((layer) => layer.materialization === "retained-local-space");
    assert.ok(retained);
    assert.equal(retained.sample.sourceSpace.kind, "local-space");
    assert.ok(retained.sample.sourceSpace.localSpaceNodeId);
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});
