import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  validateReferenceLocalSpaceGraph,
} from "../lib/runtime/reference/local-space";
import {
  referenceParallaxCameraInspect,
  referenceParallaxCameraPlanAt,
  validateReferenceParallaxCameraGraph,
} from "../lib/runtime/reference/parallax-camera";
import { validateReferenceStaticVisualGraphs } from "../lib/runtime/reference/static-visual-validation";
import {
  prepareReferenceTrack2D,
  referenceTrack2DConfig,
  referenceTrack2DLocalSpacePlanAt,
} from "../lib/runtime/reference/tracking-2d";
import {
  planReferenceLocalSpaceCompositionTransformWork,
  planReferenceLocalSpaceTileTransformWork,
  ReferenceLocalSpaceTransformWorkError,
  referenceLocalSpaceTransformWorkLimits,
} from "../lib/runtime/reference/local-space-transform-work";
import { transformReferencePoint } from "../lib/runtime/reference/retained-visual";

function parse(program: string) {
  const result = parseCutLanguage(program);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics.filter((item) => item.severity === "error"), []);
  return result.module;
}

function compile(program: string) {
  const cutModule = parse(program), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(cutModule).ir;
  finalizeGraphHashes(ir);
  return ir;
}

function node(ir: CutAVIR, op: string, index = 0) {
  const result = Object.values(ir.nodes).filter((candidate) => candidate.op === op)[index];
  assert.ok(result, `missing ${op}[${index}]`);
  return result;
}

function trackSource(child: string) {
  return `cut 0.4;
project "retained tracking owner proof";
import { Group, LocalSpace, Rect, Track2D } from "cut:visual";
asset tracking: DataAsset = data("assets/subject.track.json");
timeline main(duration: 1s, fps: 4, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Track2D(
      source: tracking,
      minConfidence: 60%,
      lowConfidence: "hold",
      occluded: "hold",
      outOfFrame: "hide",
      interpolation: "linear",
      bindScale: true,
      bindRotation: true,
      x: 2px,
      y: -3px,
      scale: 0.5,
      rotation: 10deg,
      opacity: 80%
    ) {
      ${child}
    }
  }
}
export out = render(main, codec: "h264");`;
}

const directTrackLocal = `LocalSpace(width: 20px, height: 10px, origin: { x: 7px, y: 3px }) {
  Rect(width: 4px, height: 2px, x: 0px, y: 0px, fill: #ef233c);
}`;

function trackingSidecar(scale = { numerator: "2", denominator: "1" }, rotation = { numerator: "90", denominator: "1" }) {
  return Buffer.from(JSON.stringify({
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 100,
    height: 80,
    samples: [
      { at: { numerator: "0", denominator: "1" }, x: { numerator: "10", denominator: "1" }, y: { numerator: "20", denominator: "1" }, scale, rotation, confidence: { numerator: "1", denominator: "1" }, status: "visible" },
      { at: { numerator: "1", denominator: "1" }, x: { numerator: "90", denominator: "1" }, y: { numerator: "70", denominator: "1" }, scale, rotation, confidence: { numerator: "1", denominator: "1" }, status: "visible" },
    ],
  }));
}

function parallaxSource(farBody = `LocalSpace(width: 60px, height: 40px, origin: { x: 10px, y: 20px }) {
  Rect(width: 12px, height: 8px, x: 0px, y: 0px, fill: #ef233c);
}`) {
  return `cut 0.4;
project "retained depth plane owner proof";
import { Circle, DepthLayer, LocalSpace, ParallaxCamera, Rect } from "cut:visual";
import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 4, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) as camera {
      DepthLayer(depth: 100px, edge: "transparent") {
        ${farBody}
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        LocalSpace(width: 20px, height: 10px, origin: { x: 5px, y: 5px }) {
          Circle(radius: 2px, x: 0px, y: 0px, fill: #2457d6);
        }
      }
    }
    animate camera.x from 0px to 10px over 1s ease linear;
  }
}
export out = render(main, codec: "h264");`;
}

test("direct Track2D LocalSpace lowers ordinarily and plans local zero at the exact tracked point plus authored offset", () => {
  const ir = compile(trackSource(directTrackLocal)), composition = ir.compositions[0];
  assert.equal(loadCutAvIr(JSON.stringify(ir)).format, "cut-av-ir");
  const trackNode = node(ir, "cut.visual.track_2d"), localNode = node(ir, "cut.visual.local_space");
  assert.deepEqual(trackNode.children, [localNode.id]);
  const local = validateReferenceLocalSpaceGraph(ir, composition).get(localNode.id);
  assert.ok(local);
  assert.equal(local.owner, "track-2d");
  assert.equal(local.ownerNodeId, trackNode.id);
  const config = referenceTrack2DConfig(ir, trackNode);
  assert.ok(config);
  const sidecar = trackingSidecar();
  const prepared = prepareReferenceTrack2D(trackNode, config, composition, sidecar);
  const plan = referenceTrack2DLocalSpacePlanAt(ir, composition, trackNode, prepared, config, local, rational(0));
  assert.equal(plan.rendererHandoff, "connected-reference-visual-renderer");
  assert.equal(plan.hidden, false);
  assert.deepEqual(plan.sourceSpace.rasterRegistration, { x: 7, y: 3 });
  assert.deepEqual(plan.observedCompositionPoint, { x: 10, y: 20 });
  assert.deepEqual(plan.destinationRegistration, { x: 12, y: 17 });
  assert.equal(plan.scale, 1);
  assert.equal(plan.rotation, 100);
  assert.equal(plan.opacity, 0.8);
  assert.equal(plan.work.kind, "retained-tile-transform");
  if (plan.work.kind !== "retained-tile-transform") assert.fail("visible Track2D plan unexpectedly has no transform work");
  assert.deepEqual({
    kind: plan.work.kind,
    requiredExecutionDiscipline: plan.work.scheduling.requiredDiscipline,
    schedulingEnforcement: plan.work.scheduling.enforcement,
    resized: [plan.work.requestedResize.width, plan.work.requestedResize.height],
    transformed: [plan.work.rotation.width, plan.work.rotation.height],
  }, {
    kind: "retained-tile-transform",
    requiredExecutionDiscipline: "serialize-tile-transform-allocation-per-composition",
    schedulingEnforcement: "reference-visual-renderer-fifo-v1",
    resized: [20, 10],
    transformed: [13, 21],
  });
  assert.ok(plan.localToComposition);
  const registration = transformReferencePoint(plan.localToComposition, 0, 0);
  assert.ok(Math.abs(registration.x - 12) < 1e-12 && Math.abs(registration.y - 17) < 1e-12);
  const inspectedTrack = inspectCutIr(ir, "track-owner.cut").graph.nodes.find((candidate) => candidate.id === trackNode.id)?.tracking2D;
  assert.deepEqual(inspectedTrack?.directLocalSpace, {
    nodeId: local.nodeId,
    dimensions: { width: 20, height: 10 },
    rasterOriginQ16: { x: String(7 * 65_536), y: String(3 * 65_536) },
    semanticIdentity: local.semanticIdentity,
    rendererHandoff: "connected-reference-visual-renderer",
    sampledPlacement: "requires-locked-runtime-data",
  });
});

test("shared LocalSpace transform planning closes combined Track2D work before renderer handoff", () => {
  const ir = compile(trackSource(directTrackLocal)), composition = ir.compositions[0], trackNode = node(ir, "cut.visual.track_2d");
  const request = (source: { width: number; height: number }, scale: number, rotation: number, opacity = 1) =>
    planReferenceLocalSpaceTileTransformWork(trackNode, {
      source,
      destination: { width: composition.width, height: composition.height },
      scale,
      rotation,
      opacity,
    });
  const legal = request({ width: 4, height: 1 }, 2364, 0);
  assert.deepEqual([legal.requestedResize.width, legal.requestedResize.height], [9456, 2364]);
  assert.equal(legal.perTransform.peakLiveBytesUpperBound, 536_495_696);
  assert.ok(legal.perTransform.peakLiveBytesUpperBound <= referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes);
  assert.equal(legal.scheduling.enforcement, "reference-visual-renderer-fifo-v1");
  const destinationClipped = request({ width: 4, height: 1 }, 2365, 0);
  assert.equal(destinationClipped.version, 4);
  if (destinationClipped.version !== 4) throw new Error("ceiling fallback must produce V4 work");
  assert.equal(destinationClipped.stages.rgb16TransformPath, false);
  assert.equal(destinationClipped.stages.directDestinationClippedScaleTranslation, true);
  assert.equal(destinationClipped.supersededLegacy.peakLiveBytesUpperBound, 536_949_680);
  assert.equal(destinationClipped.supersededLegacy.refusedByMaximumPerTransformPeakBytes, 536_870_912);
  assert.ok(destinationClipped.perTransform.peakLiveBytesUpperBound <= 536_870_912);
  assert.throws(
    () => request({ width: 4, height: 1 }, 4096.25, 0),
    /CUT_LOCAL_SPACE_TRANSFORM_LIMIT:.*16385x4096/u,
  );
  assert.throws(
    () => request({ width: 8192, height: 8193 }, 1, 0),
    /CUT_LOCAL_SPACE_TRANSFORM_LIMIT:.*pixels/u,
  );
  assert.throws(
    () => request({ width: 4096, height: 4096 }, 2, 45),
    /CUT_LOCAL_SPACE_TRANSFORM_LIMIT:.*Sharp rotation output/u,
  );

  const extreme = compile(trackSource(directTrackLocal).replace("scale: 0.5", "scale: 8"));
  const extremeComposition = extreme.compositions[0], extremeTrack = node(extreme, "cut.visual.track_2d"), extremeLocalNode = node(extreme, "cut.visual.local_space");
  const extremeConfig = referenceTrack2DConfig(extreme, extremeTrack), extremeLocal = validateReferenceLocalSpaceGraph(extreme, extremeComposition).get(extremeLocalNode.id);
  assert.ok(extremeConfig && extremeLocal);
  const prepared = prepareReferenceTrack2D(extremeTrack, extremeConfig, extremeComposition, trackingSidecar({ numerator: "1000", denominator: "1" }, { numerator: "0", denominator: "1" }));
  assert.throws(
    () => referenceTrack2DLocalSpacePlanAt(extreme, extremeComposition, extremeTrack, prepared, extremeConfig, extremeLocal, rational(0)),
    /CUT_LOCAL_SPACE_TRANSFORM_LIMIT:.*160000x80000/u,
  );
});

test("shared LocalSpace transform planning binds Sharp cover and rotation geometry exactly", () => {
  const ir = compile(trackSource(directTrackLocal)), composition = ir.compositions[0], trackNode = node(ir, "cut.visual.track_2d");
  const request = (source: { width: number; height: number }, scale: number, rotation: number) =>
    planReferenceLocalSpaceTileTransformWork(trackNode, {
      source,
      destination: { width: composition.width, height: composition.height },
      scale,
      rotation,
      opacity: 1,
    });

  assert.throws(
    () => request({ width: 3640, height: 1 }, 4.5, 0),
    /CUT_LOCAL_SPACE_TRANSFORM_LIMIT:.*Sharp cover intermediate requires 18200x5/u,
    "a legal-looking 16380x5 request must not hide Sharp's 18200x5 cover intermediate",
  );
  assert.throws(
    () => request({ width: 1, height: 86 }, 190.5, 0),
    /CUT_LOCAL_SPACE_TRANSFORM_LIMIT:.*Sharp cover intermediate requires 191x16426/u,
    "a legal-looking 191x16383 request must not hide Sharp's 191x16426 cover intermediate",
  );

  const wide = request({ width: 3640, height: 1 }, 1, 45);
  if (wide.version === 4) {
    assert.fail("a rotated transform must remain on the separately bounded RGB16 path");
  }
  assert.deepEqual([wide.requestedResize.width, wide.requestedResize.height], [3640, 1]);
  assert.deepEqual([wide.sharpCover.width, wide.sharpCover.height], [3640, 1]);
  assert.deepEqual([wide.rotation.width, wide.rotation.height], [2575, 2575]);
  const tall = request({ width: 1, height: 86 }, 1, 45);
  if (tall.version === 4) {
    assert.fail("a rotated transform must remain on the separately bounded RGB16 path");
  }
  assert.deepEqual([tall.rotation.width, tall.rotation.height], [62, 62]);
  assert.equal(wide.stages.rotation?.associatedInputCopyBytes, 3640 * 8);
  assert.equal(wide.stages.rotation?.backendOutputBytes, 2575 * 2575 * 8);
  assert.equal(wide.stages.rotation?.copiedOutputBytes, 2575 * 2575 * 8);
});

test("shared LocalSpace transform work canonicalizes full turns and accounts for fractional opacity", () => {
  const ir = compile(trackSource(directTrackLocal)), composition = ir.compositions[0], trackNode = node(ir, "cut.visual.track_2d");
  const request = (rotation: number, opacity = 1) => planReferenceLocalSpaceTileTransformWork(trackNode, {
    source: { width: 20, height: 10 },
    destination: { width: composition.width, height: composition.height },
    scale: 1,
    rotation,
    opacity,
  });
  const zero = request(0), positive = request(360), negative = request(-360);
  assert.equal(zero.rotation.canonicalDegrees, 0);
  assert.equal(positive.rotation.canonicalDegrees, 0);
  assert.equal(negative.rotation.canonicalDegrees, 0);
  assert.equal(positive.workIdentity, zero.workIdentity);
  assert.equal(negative.workIdentity, zero.workIdentity);
  assert.equal(zero.stages.rgb16TransformPath, false);

  const fractional = request(0, 0.375);
  assert.equal(fractional.stages.opacityDestinationCopies, 1);
  assert.equal(fractional.stages.opacityDestinationCopyBytes, composition.width * composition.height * 4);
  assert.equal(zero.stages.opacityDestinationCopies, 0);
  assert.equal(zero.stages.opacityDestinationCopyBytes, 0);
  assert.ok(fractional.perTransform.peakLiveBytesUpperBound > zero.perTransform.peakLiveBytesUpperBound);
});

test("shared LocalSpace composition aggregation uses an unscheduled safety envelope and bounds multi-owner live outputs", () => {
  const ir = compile(trackSource(directTrackLocal)), base = ir.compositions[0], trackNode = node(ir, "cut.visual.track_2d");
  const composition = { ...base, width: 8192, height: 8192 };
  const transform = {
    source: { width: 1, height: 1 },
    destination: { width: composition.width, height: composition.height },
    scale: 1,
    rotation: 0,
    opacity: 1,
  };
  const owner = planReferenceLocalSpaceTileTransformWork(trackNode, transform);
  const request = { node: trackNode, transform };
  const legal = planReferenceLocalSpaceCompositionTransformWork(trackNode, composition, [request, request, request, request]);
  assert.equal(legal.compositionLiveOutputBytes, referenceLocalSpaceTransformWorkLimits.maximumCompositionLiveOutputBytes);
  assert.equal(legal.unscheduledCompositionPeakBytesUpperBound, owner.perTransform.peakLiveBytesUpperBound * 4);
  assert.equal(legal.conservativeSafetyEnvelope, "unscheduled-sum");
  assert.equal(legal.scheduling.enforcement, "reference-visual-renderer-fifo-v1");
  assert.ok(legal.serializedCompositionPeakBytesUpperBound > legal.compositionLiveOutputBytes);
  assert.throws(
    () => planReferenceLocalSpaceCompositionTransformWork(trackNode, composition, [request, request, request, request, request]),
    /CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE:.*composition-live outputs require 1342177280 bytes/u,
  );
});

test("Track2D LocalSpace cache identity ignores source provenance but binds locked data identity", () => {
  const source = trackSource(directTrackLocal), baseline = compile(source);
  const changed = compile(source.replace(
    'asset tracking: DataAsset = data("assets/subject.track.json");',
    '// Formatting and comments are non-semantic.\n\nasset tracking: DataAsset = data("assets/subject.track.json");',
  ));
  const sourceId = node(baseline, "cut.visual.track_2d").inputs.source;
  assert.ok(sourceId?.kind === "resource-ref");
  const baselineResource = baseline.resources[sourceId.id], changedResource = changed.resources[sourceId.id];
  assert.ok(baselineResource && changedResource);
  const plan = (ir: CutAVIR) => {
    const composition = ir.compositions[0], trackNode = node(ir, "cut.visual.track_2d"), localNode = node(ir, "cut.visual.local_space");
    const config = referenceTrack2DConfig(ir, trackNode), local = validateReferenceLocalSpaceGraph(ir, composition).get(localNode.id);
    assert.ok(config && local);
    return referenceTrack2DLocalSpacePlanAt(ir, composition, trackNode, prepareReferenceTrack2D(trackNode, config, composition, trackingSidecar()), config, local, rational(0));
  };
  assert.notDeepEqual(changedResource.provenance.span, baselineResource.provenance.span);
  assert.equal(plan(changed).cacheIdentity, plan(baseline).cacheIdentity, "comments and source position are not execution identity");
  changedResource.metadata = { ...(changedResource.metadata ?? {}), lockedTrackSchemaIdentity: "v2" };
  assert.notEqual(plan(changed).cacheIdentity, plan(baseline).cacheIdentity, "locked schema/byte metadata must invalidate the plan");
});

test("direct DepthLayer LocalSpace plans bounded source geometry, registration, work, and cache identity without claiming pixels", () => {
  const ir = compile(parallaxSource()), composition = ir.compositions[0];
  assert.equal(loadCutAvIr(JSON.stringify(ir)).format, "cut-av-ir");
  const localConfigs = validateReferenceLocalSpaceGraph(ir, composition);
  assert.deepEqual([...localConfigs.values()].map((config) => config.owner), ["depth-layer", "depth-layer"]);
  const configs = validateReferenceParallaxCameraGraph(ir, composition), camera = node(ir, "cut.visual.parallax_camera");
  const config = configs.get(camera.id);
  assert.ok(config);
  const plan = referenceParallaxCameraPlanAt(ir, composition, config, rational(0));
  assert.equal(plan.pipeline[0], "materialize-layer-source");
  const far = plan.layers.find((layer) => layer.depth === 100);
  assert.ok(far);
  assert.equal(far.materialization, "retained-local-space");
  assert.deepEqual(far.sourceSpace, {
    kind: "local-space",
    width: 60,
    height: 40,
    authoredParentBounds: { minX: rational(40), minY: rational(20), maxX: rational(100), maxY: rational(60) },
    rasterParentBounds: { minX: 40, minY: 20, maxX: 100, maxY: 60 },
    rasterRegistration: { x: 10, y: 20 },
    parentRegistration: { x: 50, y: 40 },
    localSpaceNodeId: far.sourceSpace.localSpaceNodeId,
    localSpaceSemanticIdentity: far.sourceSpace.localSpaceSemanticIdentity,
    rendererHandoff: "connected-reference-visual-renderer",
  });
  assert.deepEqual(far.projectedSourceBounds, { minX: 45, minY: 30, maxX: 75, maxY: 50 });
  assert.deepEqual(far.sourcePlacement, {
    rasterRegistration: { x: 10, y: 20 },
    destinationRegistration: { x: 50, y: 40 },
    scale: 0.5,
  });
  assert.equal(far.activeDirectChildPixels, 60 * 40);
  assert.ok(far.localSpaceTransformWork);
  assert.deepEqual(
    { width: far.localSpaceTransformWork.source.width, height: far.localSpaceTransformWork.source.height },
    { width: 60, height: 40 },
  );
  assert.deepEqual(
    { width: far.localSpaceTransformWork.requestedResize.width, height: far.localSpaceTransformWork.requestedResize.height },
    { width: 30, height: 20 },
  );
  assert.equal(far.localSpaceTransformWork.rotation.canonicalDegrees, 0);
  const near = plan.layers.find((layer) => layer.depth === 0);
  assert.ok(near?.localSpaceTransformWork);
  assert.equal(near.localSpaceTransformWork.stages.rgb16TransformPath, false, "scale 1, rotation 0 must retain the shared neutral fast path");
  assert.equal(plan.work.aggregateDirectChildPixels, 60 * 40 + 20 * 10);
  assert.equal(plan.work.aggregateLayerPixels, 54_000);
  assert.equal(plan.work.localSpaceTransformAggregate?.transformCount, 2);
  assert.equal(plan.work.localSpaceTransformAggregate?.compositionLiveOutputSurfaces, 2);
  assert.equal(plan.work.localSpaceTransformAggregate?.conservativeSafetyEnvelope, "unscheduled-sum");
  assert.match(plan.cacheIdentity, /^[a-f0-9]{64}$/u);
  const inspected = referenceParallaxCameraInspect(ir, composition, config), inspectedFar = inspected.layers.find((layer) => layer.nodeId === far.nodeId);
  assert.equal(inspectedFar?.materialization, "retained-local-space");
  assert.deepEqual(inspectedFar?.sample?.sourceSpace.rasterParentBounds, far.sourceSpace.rasterParentBounds);
  assert.deepEqual(inspectedFar?.sample?.sourcePlacement, far.sourcePlacement);
  assert.equal(inspectedFar?.sample.localSpaceTransformWork?.workIdentity, far.localSpaceTransformWork.workIdentity);
  assert.equal(inspected.inspectionSample.work.localSpaceTransformAggregate?.workIdentity, plan.work.localSpaceTransformAggregate?.workIdentity);
});

test("ordinary composition-canvas Parallax layers never claim retained LocalSpace transform work", () => {
  const ir = compile(`cut 0.4;
project "ordinary canvas parallax";
import { Circle, DepthLayer, ParallaxCamera, Rect } from "cut:visual";
import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 4, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) as camera {
      DepthLayer(depth: 100px, edge: "transparent") {
        Rect(width: 12px, height: 8px, fill: #ef233c);
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        Circle(radius: 2px, fill: #2457d6);
      }
    }
    animate camera.x from 0px to 10px over 1s ease linear;
  }
}
export out = render(main, codec: "h264");`);
  const composition = ir.compositions[0], camera = node(ir, "cut.visual.parallax_camera");
  const config = validateReferenceParallaxCameraGraph(ir, composition).get(camera.id);
  assert.ok(config);
  const plan = referenceParallaxCameraPlanAt(ir, composition, config, rational(0));
  assert.equal(Object.hasOwn(plan.work, "localSpaceTransformAggregate"), false);
  assert.ok(plan.layers.every((layer) => !Object.hasOwn(layer, "localSpaceTransformWork")));
  const inspected = referenceParallaxCameraInspect(ir, composition, config);
  assert.equal(Object.hasOwn(inspected.inspectionSample.work, "localSpaceTransformAggregate"), false);
  assert.ok(inspected.layers.every((layer) => !Object.hasOwn(layer.sample, "localSpaceTransformWork")));
});

test("DepthLayer LocalSpace uses one Q16 raster registration for projection, clamp, and placement", () => {
  const planFor = (originX: string) => {
    const program = parallaxSource()
      .replace('DepthLayer(depth: 100px, edge: "transparent")', 'DepthLayer(depth: 100px, edge: "clamp")')
      .replace('origin: { x: 10px, y: 20px }', `origin: { x: ${originX}px, y: 0px }`);
    const ir = compile(program), composition = ir.compositions[0], camera = node(ir, "cut.visual.parallax_camera");
    const config = validateReferenceParallaxCameraGraph(ir, composition).get(camera.id);
    assert.ok(config);
    const plan = referenceParallaxCameraPlanAt(ir, composition, config, rational(0));
    const layer = plan.layers.find((candidate) => candidate.depth === 100);
    assert.ok(layer && layer.sourceSpace.kind === "local-space");
    return { layer, plan };
  };
  const belowResult = planFor("0.00000762939453124"), below = belowResult.layer;
  const tieResult = planFor("0.00000762939453125"), tie = tieResult.layer;
  const aboveResult = planFor("0.00000762939453126"), above = aboveResult.layer;
  assert.equal(below.sourceSpace.rasterRegistration.x, 0);
  assert.equal(tie.sourceSpace.rasterRegistration.x, 1 / 65_536);
  assert.equal(above.sourceSpace.rasterRegistration.x, 1 / 65_536);
  assert.notDeepEqual(below.sourceSpace.authoredParentBounds.minX, tie.sourceSpace.authoredParentBounds.minX);
  assert.notDeepEqual(tie.sourceSpace.authoredParentBounds.minX, above.sourceSpace.authoredParentBounds.minX);
  assert.deepEqual(tie.sourceSpace.rasterParentBounds, above.sourceSpace.rasterParentBounds);
  assert.equal(below.sourceSpace.rasterParentBounds.maxX, 110);
  assert.equal(tie.sourceSpace.rasterParentBounds.maxX, 110 - 1 / 65_536);
  assert.equal(below.sourcePlacement.rasterRegistration.x, below.clamp.left);
  assert.equal(tie.sourcePlacement.rasterRegistration.x, tie.clamp.left + 1 / 65_536);
  assert.equal(below.clamp.right, 42, "a zero-phase border lands exactly on the clamp boundary");
  assert.equal(tie.clamp.right, 43, "the Q16 phase crosses that boundary and must allocate one more border pixel");
  assert.deepEqual(
    { width: tie.localSpaceTransformWork?.source.width, height: tie.localSpaceTransformWork?.source.height },
    { width: tie.clamp.width, height: tie.clamp.height },
    "shared allocation planning must consume the post-clamp source raster",
  );
  assert.deepEqual(
    { width: tie.localSpaceTransformWork?.requestedResize.width, height: tie.localSpaceTransformWork?.requestedResize.height },
    { width: tie.projectedRaster.width, height: tie.projectedRaster.height },
  );
  assert.notEqual(below.localSpaceTransformWork?.workIdentity, tie.localSpaceTransformWork?.workIdentity);
  assert.notEqual(belowResult.plan.work.localSpaceTransformAggregate?.workIdentity, tieResult.plan.work.localSpaceTransformAggregate?.workIdentity);
  assert.notEqual(belowResult.plan.cacheIdentity, tieResult.plan.cacheIdentity, "a one-pixel post-clamp allocation change must invalidate the frame cache");
});

test("ParallaxCamera rejects the 3640x1 at scale 4.5 Sharp-cover bypass at the owning DepthLayer", () => {
  const program = parallaxSource(`LocalSpace(width: 3640px, height: 1px, origin: { x: 0px, y: 0px }) {
  Rect(width: 1px, height: 1px, x: 0px, y: 0px, fill: #ef233c);
}`)
    .replace("ParallaxCamera(focalLength: 100px)", "ParallaxCamera(focalLength: 90px)")
    .replace("DepthLayer(depth: 100px", "DepthLayer(depth: -70px");
  const ir = compile(program), composition = ir.compositions[0], farLayer = node(ir, "cut.visual.depth_layer", 0);
  const diagnostics = validateReferenceStaticVisualGraphs(ir);
  const failure = diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_TRANSFORM_LIMIT");
  assert.ok(failure, JSON.stringify(diagnostics));
  assert.deepEqual(failure.span, farLayer.provenance.span);
  assert.match(failure.message, /Sharp cover intermediate requires 18200x5/u);
  assert.throws(() => validateReferenceParallaxCameraGraph(ir, composition), (error: unknown) => {
    assert.ok(error instanceof ReferenceLocalSpaceTransformWorkError);
    assert.equal(error.code, "CUT_LOCAL_SPACE_TRANSFORM_LIMIT");
    assert.equal(error.source.nodeId, farLayer.id);
    assert.match(error.message, /Sharp cover intermediate requires 18200x5/u);
    return true;
  });
});

test("checker rejects a mixed local/canvas DepthLayer at the owner source span", () => {
  const program = parallaxSource(`${directTrackLocal}
        Rect(width: 8px, height: 8px, fill: #ffffff);`);
  const cutModule = parse(program), diagnostics = checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error");
  const failure = diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_GRAPH");
  assert.ok(failure, JSON.stringify(diagnostics));
  assert.ok(failure.span.start.line > 0 && failure.span.start.column > 0);
  assert.match(failure.message, /exactly one direct LocalSpace.*no delivery-canvas siblings/u);
});

test("asset-free planner refuses an indirect Track2D LocalSpace before tracking bytes are opened", () => {
  const ir = compile(trackSource(`Group() { ${directTrackLocal} }`));
  const diagnostics = validateReferenceStaticVisualGraphs(ir);
  const failure = diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_UNSUPPORTED");
  assert.ok(failure, JSON.stringify(diagnostics));
  assert.ok(failure.span.start.line > 0 && failure.span.start.column > 0);
  assert.match(failure.message, /Track2D.*Group.*LocalSpace|owner chain/u);
});

test("strict loaded IR rejects mixed and duplicate LocalSpace ownership even after hostile graph rehash", () => {
  const base = compile(parallaxSource()), farLayer = node(base, "cut.visual.depth_layer", 0), farLocal = node(base, "cut.visual.local_space", 0);
  const mixed = structuredClone(base), mixedLayer = mixed.nodes[farLayer.id], mixedLocal = mixed.nodes[farLocal.id];
  const originalLeaf = mixed.nodes[mixedLocal.children[0]];
  assert.ok(originalLeaf);
  const sibling: IRNode = structuredClone(originalLeaf);
  sibling.id = "hostile-canvas-sibling";
  sibling.contentHash = "hostile-canvas-sibling";
  sibling.provenance = { ...sibling.provenance, symbol: "hostile-canvas-sibling" };
  mixed.nodes[sibling.id] = sibling;
  mixedLayer.children.push(sibling.id);
  finalizeGraphHashes(mixed);
  assert.throws(() => loadCutAvIr(JSON.stringify(mixed)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError);
    assert.equal(error.code, "CUT_IR_IDENTITY");
    assert.ok(error.path.endsWith(`.nodes[${JSON.stringify(mixedLayer.id)}].children`) || error.path.endsWith(`.nodes.${mixedLayer.id}.children`), error.path);
    assert.match(error.message, /exactly one direct LocalSpace.*no delivery-canvas siblings/u);
    return true;
  });

  const duplicate = structuredClone(base), firstLocal = node(duplicate, "cut.visual.local_space", 0), otherLayer = node(duplicate, "cut.visual.depth_layer", 1);
  otherLayer.children.push(firstLocal.id);
  finalizeGraphHashes(duplicate);
  assert.throws(() => loadCutAvIr(JSON.stringify(duplicate)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError);
    assert.equal(error.code, "CUT_IR_IDENTITY");
    assert.match(error.path, /\.ownership$/u);
    return true;
  });
});

test("strict loader and runtime reject detached and root-owned-but-unlisted LocalSpace coordinate contexts", () => {
  const base = compile(`cut 0.4;
project "hostile detached local context";
import { LocalSpace, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    LocalSpace(width: 20px, height: 10px, origin: { x: 7px, y: 3px }) {
      Rect(width: 4px, height: 2px, fill: #ef233c);
    }
  }
}
export out = render(main, codec: "h264");`);

  const orphanedRoot = structuredClone(base), orphanedComposition = orphanedRoot.compositions[0];
  const orphanedLocal = node(orphanedRoot, "cut.visual.local_space"), orphanedScene = orphanedRoot.scenes[orphanedComposition.sceneIds[0]];
  orphanedScene.rootVisualIds = orphanedScene.rootVisualIds.filter((id) => id !== orphanedLocal.id);
  orphanedScene.items = orphanedScene.items.filter((item) => item.id !== orphanedLocal.id);
  finalizeGraphHashes(orphanedRoot);
  assert.equal(orphanedLocal.ownership, "root");
  assert.throws(() => loadCutAvIr(JSON.stringify(orphanedRoot)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError);
    assert.equal(error.code, "CUT_IR_IDENTITY");
    assert.match(error.path, /\.ownership$/u);
    assert.match(error.message, /root node must appear in exactly one owner/u);
    return true;
  });
  assert.throws(() => validateReferenceLocalSpaceGraph(orphanedRoot, orphanedComposition), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /CUT_LOCAL_SPACE_GRAPH:.*exactly one scene\/composition item owner; found 0/u);
    return true;
  });

  const detached = structuredClone(base), detachedComposition = detached.compositions[0];
  const detachedLocal = node(detached, "cut.visual.local_space"), detachedScene = detached.scenes[detachedComposition.sceneIds[0]];
  detachedScene.rootVisualIds = detachedScene.rootVisualIds.filter((id) => id !== detachedLocal.id);
  detachedScene.items = detachedScene.items.filter((item) => item.id !== detachedLocal.id);
  detachedLocal.ownership = "detached";
  finalizeGraphHashes(detached);
  assert.throws(() => loadCutAvIr(JSON.stringify(detached)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError);
    assert.equal(error.code, "CUT_IR_IDENTITY");
    assert.match(error.path, /\.ownership$/u);
    assert.match(error.message, /parentless LocalSpace.*root/u);
    return true;
  });
  assert.throws(() => validateReferenceLocalSpaceGraph(detached, detachedComposition), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /CUT_LOCAL_SPACE_GRAPH:.*parentless LocalSpace.*root/u);
    return true;
  });
});

test("selected LocalSpace validation sees a hostile duplicate parent outside the selection", () => {
  const ir = compile(trackSource(directTrackLocal)), composition = ir.compositions[0];
  const track = node(ir, "cut.visual.track_2d"), local = node(ir, "cut.visual.local_space");
  const hiddenParent: IRNode = structuredClone(track);
  hiddenParent.id = "hostile-off-scope-duplicate-parent";
  hiddenParent.contentHash = "hostile-off-scope-duplicate-parent";
  hiddenParent.ownership = "detached";
  hiddenParent.provenance = { ...hiddenParent.provenance, symbol: "hostile-off-scope-duplicate-parent" };
  ir.nodes[hiddenParent.id] = hiddenParent;
  finalizeGraphHashes(ir);

  const selected = new Set([track.id, local.id, ...local.children]);
  assert.throws(() => validateReferenceLocalSpaceGraph(ir, composition, selected), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /CUT_LOCAL_SPACE_GRAPH:.*at most one structural parent.*hostile-off-scope-duplicate-parent/u);
    return true;
  });
});

test("strict loader and runtime reject LocalSpace intervals escaping direct Track2D and DepthLayer owners", () => {
  const cases = [
    { label: "Track2D", ir: compile(trackSource(directTrackLocal)), ownerOp: "cut.visual.track_2d", localIndex: 0 },
    { label: "DepthLayer", ir: compile(parallaxSource()), ownerOp: "cut.visual.depth_layer", localIndex: 0 },
  ];
  for (const item of cases) {
    const composition = item.ir.compositions[0], owner = node(item.ir, item.ownerOp), local = node(item.ir, "cut.visual.local_space", item.localIndex);
    owner.interval = { start: rational(1, 2), duration: rational(1, 2) };
    finalizeGraphHashes(item.ir);
    assert.throws(() => loadCutAvIr(JSON.stringify(item.ir)), (error: unknown) => {
      assert.ok(error instanceof CutAvIrValidationError, item.label);
      assert.equal(error.code, "CUT_IR_TIMING", item.label);
      assert.match(error.path, /\.interval$/u, item.label);
      assert.match(error.message, /escapes direct owner/u, item.label);
      return true;
    });
    assert.throws(() => validateReferenceLocalSpaceGraph(item.ir, composition), (error: unknown) => {
      assert.ok(error instanceof Error, item.label);
      assert.match(error.message, /CUT_LOCAL_SPACE_GRAPH:.*interval escapes its direct owner/u, item.label);
      return true;
    });
    assert.equal(local.interval.start.numerator, "0", item.label);
  }
});

test("ParallaxCamera inspect samples every layer at its first active frame and never drops retained materialization", () => {
  const ir = compile(parallaxSource()), composition = ir.compositions[0];
  const farLayer = node(ir, "cut.visual.depth_layer", 0), farLocal = node(ir, "cut.visual.local_space", 0);
  for (const id of [farLayer.id, farLocal.id, ...farLocal.children]) {
    ir.nodes[id].interval = { start: rational(1, 2), duration: rational(1, 2) };
  }
  finalizeGraphHashes(ir);

  const configs = validateReferenceParallaxCameraGraph(ir, composition);
  const config = configs.get(node(ir, "cut.visual.parallax_camera").id);
  assert.ok(config);
  const inspected = referenceParallaxCameraInspect(ir, composition, config);
  const far = inspected.layers.find((layer) => layer.nodeId === farLayer.id);
  const near = inspected.layers.find((layer) => layer.nodeId !== farLayer.id);
  assert.equal(far?.materialization, "retained-local-space");
  assert.deepEqual(far?.sample.exactTime, rational(1, 2));
  assert.deepEqual(near?.sample.exactTime, rational(0));
  assert.deepEqual(inspected.inspectionSample.exactTime, rational(0));
  assert.match(inspected.edgeBoundary.transparent, /selected materialized source surface's declared boundary/u);
  assert.match(inspected.edgeBoundary.clamp, /LocalSpace boundary is not recovered/u);
});

test("aggregate LocalSpace work limits cannot be bypassed through multiple DepthLayer owners", () => {
  const layers = Array.from({ length: 5 }, (_, index) => `
      DepthLayer(depth: ${index * 100}px, edge: "transparent") {
        LocalSpace(width: 3600px, height: 3600px, origin: { x: 1800px, y: 1800px }) {
          Rect(width: 1px, height: 1px, x: 0px, y: 0px, fill: #ffffff);
        }
      }`).join("");
  const program = `cut 0.4;
project "bounded retained planes";
import { DepthLayer, LocalSpace, ParallaxCamera, Rect } from "cut:visual";
import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 2, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) as camera {${layers}
    }
    animate camera.x from 0px to 1px over 1s ease linear;
  }
}
export out = render(main, codec: "h264");`;
  const ir = compile(program), enlarged = node(ir, "cut.visual.local_space", 4);
  enlarged.inputs.width = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(4096) };
  enlarged.inputs.height = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(4096) };
  enlarged.inputs.origin = {
    kind: "object",
    entries: {
      x: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(2048) },
      y: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(2048) },
    },
  };
  finalizeGraphHashes(ir);
  const diagnostics = validateReferenceStaticVisualGraphs(ir);
  const failure = diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_LIMIT");
  assert.ok(failure, JSON.stringify(diagnostics));
  assert.match(failure.message, /aggregate declared local tiles exceed/u);
  assert.throws(() => loadCutAvIr(JSON.stringify(ir)), (error: unknown) => error instanceof CutAvIrValidationError
    && error.code === "CUT_IR_LIMIT"
    && /aggregate declared LocalSpace tiles exceed/u.test(error.message));
});
