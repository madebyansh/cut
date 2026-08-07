import assert from "node:assert/strict";
import test from "node:test";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../lib/language/ir";
import { rational } from "../lib/language/rational";
import {
  ReferenceParallaxCameraError,
  referenceParallaxCameraInspect,
  referenceParallaxCameraPlanAt,
  validateReferenceParallaxCameraGraph,
} from "../lib/runtime/reference/parallax-camera";
import { ReferenceEasingConfigError } from "../lib/runtime/reference/easing";

const span = { start: { offset: 0, line: 7, column: 3 }, end: { offset: 1, line: 7, column: 4 } };
const provenance = (symbol: string) => ({ module: "proof.cut", span, symbol });

function length(value: number): IRValue {
  return { kind: "quantity", dimension: "length", magnitude: rational(Math.round(value * 1_000), 1_000), unit: "px" };
}

function string(value: string): IRValue { return { kind: "string", value }; }
function scalar(value: number): IRValue { return { kind: "quantity", dimension: "scalar", magnitude: rational(Math.round(value * 1_000), 1_000), unit: "scalar" }; }

function node(
  id: string,
  op: string,
  inputs: Record<string, IRValue>,
  children: string[],
  properties: IRNode["properties"] = {},
): IRNode {
  return {
    id,
    op,
    domain: "visual",
    ownership: id === "camera" ? "root" : "child",
    sceneId: "scene",
    interval: { start: rational(0), duration: rational(1) },
    inputs,
    children,
    properties,
    effects: ["pure"],
    contentHash: `${id}-hash`,
    provenance: provenance(id),
  };
}

function fixture(options: {
  cameraInputs?: Record<string, IRValue>;
  cameraProperties?: IRNode["properties"];
  layers?: Array<{ id: string; depth: number; edge: "transparent" | "clamp" }>;
  signals?: Record<string, IRSignal>;
} = {}) {
  const layers = options.layers ?? [
    { id: "far", depth: 1_000, edge: "clamp" as const },
    { id: "near", depth: 0, edge: "transparent" as const },
  ];
  const camera = node(
    "camera",
    "cut.visual.parallax_camera",
    { focalLength: length(1_000), ...(options.cameraInputs ?? {}) },
    layers.map((layer) => layer.id),
    options.cameraProperties,
  );
  const nodes: Record<string, IRNode> = { camera };
  for (const layer of layers) {
    const leaf = `${layer.id}-leaf`;
    nodes[layer.id] = node(layer.id, "cut.visual.depth_layer", { depth: length(layer.depth), edge: string(layer.edge) }, [leaf]);
    nodes[leaf] = node(leaf, "cut.visual.rect", { width: length(10), height: length(10) }, []);
  }
  const composition: IRComposition = {
    id: "composition",
    name: "proof",
    width: 100,
    height: 80,
    fps: rational(24),
    sampleRate: 48_000,
    duration: rational(1),
    sceneIds: ["scene"],
    rootVisualIds: [camera.id],
    rootAudioIds: [],
    rootAVIds: [],
    items: [{ kind: "scene", id: "scene" }],
    provenance: provenance("composition"),
  };
  const ir: CutAVIR = {
    format: "cut-av-ir",
    version: 3,
    language: "0.4",
    compiler: "cut-ts/test",
    project: "parallax proof",
    sourceHash: "source",
    buildId: "build",
    determinism: { semantic: "locked", decodedMedia: "verified", bitstream: "unverified" },
    timebase: { defaultFps: rational(24), audioSampleRate: 48_000 },
    modules: [],
    resources: {},
    compositions: [composition],
    scenes: {
      scene: {
        id: "scene",
        name: "only",
        start: rational(0),
        duration: rational(1),
        rootVisualIds: [camera.id],
        rootAudioIds: [],
        rootAVIds: [],
        items: [{ id: camera.id, domain: "visual" }],
        provenance: provenance("scene"),
      },
    },
    nodes,
    signals: options.signals ?? {},
    jobs: [],
    outputs: [],
    assertions: [],
    annotations: { markers: [], regions: [] },
    linkedEdits: [],
  };
  return { ir, composition, camera, nodes };
}

function configOf(result: ReturnType<typeof fixture>) {
  return validateReferenceParallaxCameraGraph(result.ir, result.composition).get("camera")!;
}

function appendTransparentCamera(result: ReturnType<typeof fixture>, prefix: string, sceneId = "scene") {
  const farId = `${prefix}-far`, nearId = `${prefix}-near`, farLeafId = `${farId}-leaf`, nearLeafId = `${nearId}-leaf`;
  const camera = node(prefix, "cut.visual.parallax_camera", { focalLength: length(1_000) }, [farId, nearId]);
  camera.ownership = "root";
  camera.sceneId = sceneId;
  const far = node(farId, "cut.visual.depth_layer", { depth: length(1_000), edge: string("transparent") }, [farLeafId]);
  const near = node(nearId, "cut.visual.depth_layer", { depth: length(0), edge: string("transparent") }, [nearLeafId]);
  const farLeaf = node(farLeafId, "cut.visual.rect", { width: length(10), height: length(10) }, []);
  const nearLeaf = node(nearLeafId, "cut.visual.rect", { width: length(10), height: length(10) }, []);
  for (const child of [far, near, farLeaf, nearLeaf]) child.sceneId = sceneId;
  Object.assign(result.nodes, { [camera.id]: camera, [far.id]: far, [near.id]: near, [farLeaf.id]: farLeaf, [nearLeaf.id]: nearLeaf });
  return camera;
}

function expectCode(work: () => unknown, code: ReferenceParallaxCameraError["code"], message?: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceParallaxCameraError);
    assert.equal(error.code, code);
    assert.deepEqual(error.source, { module: "proof.cut", line: 7, column: 3, nodeId: error.nodeId });
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("ParallaxCamera derives one exact planar-perspective path for ordered generic layers", () => {
  const result = fixture({ cameraInputs: { x: length(100), y: length(20) } });
  const config = configOf(result);
  const plan = referenceParallaxCameraPlanAt(result.ir, result.composition, config, rational(0));
  assert.equal(plan.projection, "planar-perspective");
  assert.deepEqual(plan.layers.map((layer) => layer.nodeId), ["far", "near"]);
  assert.equal(plan.layers[0].projectionScale, 0.5);
  assert.deepEqual(plan.layers[0].matrix, { a: 0.5, b: 0, c: 0, d: 0.5, tx: -25, ty: 10 });
  assert.equal(plan.layers[1].projectionScale, 1);
  assert.deepEqual(plan.layers[1].matrix, { a: 1, b: 0, c: 0, d: 1, tx: -100, ty: -20 });
  assert.notEqual(plan.layers[0].matrix.tx / 100, plan.layers[1].matrix.tx / 100, "depth must derive motion rather than duplicate authored rates");
});

test("Depth ordering and source ordering are explicit, deterministic, and source-stable for ties", () => {
  const depth = fixture({
    layers: [
      { id: "near", depth: 0, edge: "transparent" },
      { id: "far-a", depth: 1_000, edge: "clamp" },
      { id: "far-b", depth: 1_000, edge: "clamp" },
    ],
  });
  assert.deepEqual(referenceParallaxCameraPlanAt(depth.ir, depth.composition, configOf(depth), rational(0)).layers.map((layer) => layer.nodeId), ["far-a", "far-b", "near"]);

  const source = fixture({
    cameraInputs: { ordering: string("source") },
    layers: [
      { id: "near", depth: 0, edge: "transparent" },
      { id: "far", depth: 1_000, edge: "clamp" },
    ],
  });
  assert.deepEqual(referenceParallaxCameraPlanAt(source.ir, source.composition, configOf(source), rational(0)).layers.map((layer) => layer.nodeId), ["near", "far"]);
});

test("ordering source must differ from depth for an actually co-active layer subset", () => {
  const result = fixture({
    cameraInputs: { ordering: string("source") },
    layers: [
      { id: "far", depth: 100, edge: "transparent" },
      { id: "near", depth: 0, edge: "transparent" },
      { id: "later-extreme", depth: 200, edge: "transparent" },
    ],
  });
  for (const id of ["far", "near"]) {
    result.nodes[id].interval.duration = rational(1, 2);
    result.nodes[`${id}-leaf`].interval.duration = rational(1, 2);
  }
  for (const id of ["later-extreme", "later-extreme-leaf"]) {
    result.nodes[id].interval.start = rational(1, 2);
    result.nodes[id].interval.duration = rational(1, 2);
  }
  expectCode(() => configOf(result), "CUT_PARALLAX_NOOP", /every executed active layer subset/);
});

test("linear focus is an exact delivery-pixel sigma and inspect refuses a Camera3D claim", () => {
  const result = fixture({
    cameraInputs: {
      focus: string("linear"),
      focusDepth: length(0),
      focusRange: length(2_000),
      maxBlur: length(10),
    },
  });
  const config = configOf(result);
  const plan = referenceParallaxCameraPlanAt(result.ir, result.composition, config, rational(0));
  assert.deepEqual(plan.layers.map((layer) => [layer.nodeId, layer.focusRawSigma, layer.focusBlurSigma]), [["far", 5, 5], ["near", 0, 0]]);
  const inspect = referenceParallaxCameraInspect(result.ir, result.composition, config);
  assert.equal(inspect.kind, "deterministic-2.5d");
  assert.equal(inspect.projection.isCamera3D, false);
  assert.match(inspect.focus.mode === "linear" ? inspect.focus.rawFormula : "", /abs\(layer\.depth - focusDepth\)/);
  assert.equal(inspect.focus.mode === "linear" ? inspect.focus.executedFormula : "", "rawSigma < 0.3px ? 0px : rawSigma");
});

test("linear focus shares the bounded Gaussian contract at every executed layer sample", () => {
  const belowKernelFloor = fixture({
    cameraInputs: {
      focus: string("linear"),
      focusDepth: length(0),
      focusRange: length(1_000),
      maxBlur: length(0.299),
    },
  });
  expectCode(() => configOf(belowKernelFloor), "CUT_PARALLAX_FOCUS", /from 0\.3px through/);

  const intermediateSigma = fixture({
    cameraInputs: {
      focus: string("linear"),
      focusDepth: length(0),
      focusRange: length(1_000),
      maxBlur: length(1),
    },
    layers: [
      { id: "far", depth: 1_000, edge: "clamp" },
      { id: "executed", depth: 400, edge: "transparent" },
      { id: "mid", depth: 100, edge: "transparent" },
      { id: "near", depth: 0, edge: "transparent" },
    ],
  });
  const deadbandConfig = configOf(intermediateSigma);
  const deadbandPlan = referenceParallaxCameraPlanAt(intermediateSigma.ir, intermediateSigma.composition, deadbandConfig, rational(0));
  const deadbandLayer = deadbandPlan.layers.find((layer) => layer.nodeId === "mid")!;
  assert.equal(deadbandLayer.focusRawSigma, 0.1);
  assert.equal(deadbandLayer.focusBlurSigma, 0);

  const exactFloor = fixture({
    cameraInputs: {
      focus: string("linear"),
      focusDepth: length(0),
      focusRange: length(2_000),
      maxBlur: length(0.6),
    },
  });
  const config = configOf(exactFloor);
  const plan = referenceParallaxCameraPlanAt(exactFloor.ir, exactFloor.composition, config, rational(0));
  assert.deepEqual(plan.layers.map((layer) => layer.focusBlurSigma), [0.3, 0]);
});

test("focusDepth/range must influence an executed unsaturated sigma and automation must change the profile", () => {
  const saturatedStatic = fixture({ cameraInputs: {
    focus: string("linear"), focusDepth: length(65_536), focusRange: length(1), maxBlur: length(10),
  } });
  expectCode(() => configOf(saturatedStatic), "CUT_PARALLAX_NOOP", /saturated or inside the 0\.3px deadband/);

  const saturatedSignal: IRSignal = {
    id: "saturated-focus",
    kind: "track",
    valueType: "Length",
    initial: length(60_000),
    events: [{
      kind: "animate", start: rational(0), end: rational(1), from: length(60_000), to: length(61_000),
      curve: { kind: "symbol", name: "cut:intrinsic#linear" },
    }],
    contentHash: "saturated-focus-hash",
    provenance: provenance("saturated-focus"),
  };
  const saturatedTrack = fixture({
    cameraInputs: { focus: string("linear"), focusDepth: length(60_000), focusRange: length(1), maxBlur: length(10) },
    cameraProperties: { focusDepth: { signal: saturatedSignal.id } },
    signals: { [saturatedSignal.id]: saturatedSignal },
  });
  expectCode(() => configOf(saturatedTrack), "CUT_PARALLAX_NOOP", /focusDepth automation leaves every executed per-layer sigma profile unchanged/);
});

test("clamp coverage extends only materialized border samples and is allocation-bounded", () => {
  const result = fixture();
  const plan = referenceParallaxCameraPlanAt(result.ir, result.composition, configOf(result), rational(0));
  const far = plan.layers.find((layer) => layer.nodeId === "far")!;
  assert.deepEqual(far.clamp, {
    left: 52,
    top: 42,
    right: 52,
    bottom: 42,
    width: 204,
    height: 164,
    pixels: 33_456,
    needed: true,
    sourceBoundary: "materialized-canvas-border",
  });
  assert.deepEqual(far.projectedRaster, {
    sourceWidth: 204,
    sourceHeight: 164,
    width: 102,
    height: 82,
    pixels: 8_364,
    bytes: 33_456,
    allocated: true,
  });
  assert.deepEqual(plan.work, {
    layerSurfaces: 2,
    clampLayers: 1,
    focusPasses: 0,
    aggregateDirectChildPixels: 16_000,
    aggregateLayerCompositePixels: 32_000,
    aggregateClampPixels: 33_456,
    aggregateProjectedResizePixels: 8_364,
    aggregateProjectedDeliveryPixels: 8_000,
    aggregateFocusPixels: 0,
    aggregateCameraCompositePixels: 16_000,
    aggregateLayerPixels: 113_820,
    aggregateLayerBytes: 455_280,
  });
  const inspect = referenceParallaxCameraInspect(result.ir, result.composition, configOf(result));
  assert.match(inspect.edgeBoundary.clamp, /off-canvas authored geometry is not recovered/);
});

test("clamp is refused when unreachable, and transparent remains the honest covered-plane policy", () => {
  const result = fixture({
    layers: [
      { id: "far", depth: 1_000, edge: "transparent" },
      { id: "near", depth: -500, edge: "clamp" },
    ],
  });
  expectCode(() => configOf(result), "CUT_PARALLAX_NOOP", /edge: clamp is never reached/);
});

test("authored defaults and neutral controls fail instead of becoming public no-ops", () => {
  const cases: Array<[ReturnType<typeof fixture>, ReferenceParallaxCameraError["code"], RegExp]> = [
    [fixture({ cameraInputs: { ordering: string("depth") } }), "CUT_PARALLAX_NOOP", /ordering: depth repeats the default/],
    [fixture({ cameraInputs: { focus: string("off") } }), "CUT_PARALLAX_NOOP", /focus: off repeats the default/],
    [fixture({ cameraInputs: { x: length(0) } }), "CUT_PARALLAX_NOOP", /x remains exactly 0px/],
    [fixture({ cameraInputs: { projection: string("perspective") } }), "CUT_PARALLAX_PROJECTION", /fixed to planar-perspective/],
  ];
  for (const [result, code, message] of cases) expectCode(() => configOf(result), code, message);
});

test("focus combinations, parentage, layer depths, and projection singularities fail source-located", () => {
  const focus = fixture({ cameraInputs: { focusDepth: length(0) } });
  expectCode(() => configOf(focus), "CUT_PARALLAX_FOCUS", /focus is off/);

  const equal = fixture({ layers: [
    { id: "a", depth: 10, edge: "transparent" },
    { id: "b", depth: 10, edge: "transparent" },
  ] });
  expectCode(() => configOf(equal), "CUT_PARALLAX_NOOP", /two distinct authored layer depths/);

  const orphan = fixture();
  orphan.nodes.orphan = node("orphan", "cut.visual.depth_layer", { depth: length(250), edge: string("transparent") }, ["orphan-leaf"]);
  orphan.nodes["orphan-leaf"] = node("orphan-leaf", "cut.visual.rect", { width: length(10), height: length(10) }, []);
  expectCode(() => validateReferenceParallaxCameraGraph(orphan.ir, orphan.composition), "CUT_PARALLAX_GRAPH", /exactly one direct ParallaxCamera parent/);

  const singular = fixture({ cameraInputs: { z: length(2_000) } });
  expectCode(() => configOf(singular), "CUT_PARALLAX_PROJECTION", /non-positive optical distance/);
});

test("camera signals change every layer from one shared path and bind exact cache identity", () => {
  const signal: IRSignal = {
    id: "camera-x",
    kind: "track",
    valueType: "Length",
    initial: length(0),
    events: [{
      kind: "animate",
      start: rational(0),
      end: rational(1),
      from: length(0),
      to: length(24),
      curve: { kind: "symbol", name: "cut:intrinsic#linear" },
    }],
    contentHash: "signal-hash",
    provenance: provenance("camera-x"),
  };
  const result = fixture({ cameraProperties: { x: { signal: signal.id } }, signals: { [signal.id]: signal } });
  const config = configOf(result);
  const start = referenceParallaxCameraPlanAt(result.ir, result.composition, config, rational(0));
  const middle = referenceParallaxCameraPlanAt(result.ir, result.composition, config, rational(1, 2));
  assert.equal(start.state.x, 0);
  assert.equal(middle.state.x, 12);
  assert.notEqual(start.layers[0].matrix.tx, middle.layers[0].matrix.tx);
  assert.notEqual(start.layers[1].matrix.tx, middle.layers[1].matrix.tx);
  assert.notEqual(start.cacheIdentity, middle.cacheIdentity);
  assert.equal(start.semanticIdentity, middle.semanticIdentity);
  assert.notEqual(
    middle.cacheIdentity,
    referenceParallaxCameraPlanAt(result.ir, result.composition, config, rational(1, 2), "different-backend").cacheIdentity,
  );
});

test("constructor camera values cannot be shadowed by an immediate property path", () => {
  const signal: IRSignal = {
    id: "shadow-x",
    kind: "track",
    valueType: "Length",
    initial: length(10),
    events: [{
      kind: "animate",
      start: rational(0),
      end: rational(1),
      from: length(20),
      to: length(30),
      curve: { kind: "symbol", name: "cut:intrinsic#linear" },
    }],
    contentHash: "shadow-hash",
    provenance: provenance("shadow-x"),
  };
  const shadowed = fixture({
    cameraInputs: { x: length(10) },
    cameraProperties: { x: { signal: signal.id } },
    signals: { [signal.id]: signal },
  });
  expectCode(() => configOf(shadowed), "CUT_PARALLAX_NOOP", /immediately shadowed/);

  const anchoredSignal = structuredClone(signal);
  anchoredSignal.events[0] = { ...anchoredSignal.events[0], from: length(10) } as typeof anchoredSignal.events[number];
  const anchored = fixture({
    cameraInputs: { x: length(10) },
    cameraProperties: { x: { signal: anchoredSignal.id } },
    signals: { [anchoredSignal.id]: anchoredSignal },
  });
  assert.doesNotThrow(() => configOf(anchored));

  const staticShadow = fixture({ cameraInputs: { y: length(10) }, cameraProperties: { y: length(10) } });
  expectCode(() => configOf(staticShadow), "CUT_PARALLAX_NOOP", /property “y” shadows.*constructor input/);

  for (const property of ["x", "y", "z", "focusDepth"] as const) {
    const propertySignal: IRSignal = {
      ...structuredClone(signal),
      id: `shadow-${property}`,
      contentHash: `shadow-${property}-hash`,
      provenance: provenance(`shadow-${property}`),
    };
    const cameraInputs: Record<string, IRValue> = property === "focusDepth"
      ? { focus: string("linear"), focusDepth: length(10), focusRange: length(1_000), maxBlur: length(10) }
      : { [property]: length(10) };
    const perProperty = fixture({
      cameraInputs,
      cameraProperties: { [property]: { signal: propertySignal.id } },
      signals: { [propertySignal.id]: propertySignal },
    });
    expectCode(() => configOf(perProperty), "CUT_PARALLAX_NOOP", new RegExp(`input “${property}”.*immediately shadowed`));
  }
});

test("semantic and frame cache identities recursively bind deep descendants even before canonical hashes are refreshed", () => {
  const result = fixture();
  const config = configOf(result);
  const before = referenceParallaxCameraPlanAt(result.ir, result.composition, config, rational(0));
  result.nodes["far-leaf"].inputs.width = length(11);
  const after = referenceParallaxCameraPlanAt(result.ir, result.composition, config, rational(0));
  assert.notEqual(after.semanticIdentity, before.semanticIdentity);
  assert.notEqual(after.cacheIdentity, before.cacheIdentity);
});

test("aggregate per-camera layer raster work is bounded across all active planes", () => {
  const layers = Array.from({ length: 9 }, (_, index) => ({
    id: `layer-${index}`,
    depth: index,
    edge: "transparent" as const,
  }));
  const result = fixture({ layers });
  result.composition.width = 4_096;
  result.composition.height = 4_096;
  expectCode(() => configOf(result), "CUT_PARALLAX_LIMIT", /active layer rasters total .*aggregate limits/);
});

test("simultaneously active cameras share one composition logical-work ceiling", () => {
  const result = fixture({ layers: [
    { id: "far", depth: 1_000, edge: "transparent" },
    { id: "near", depth: 0, edge: "transparent" },
  ] });
  result.composition.width = 4_096;
  result.composition.height = 4_096;
  const second = appendTransparentCamera(result, "camera-two");
  result.composition.rootVisualIds.push(second.id);
  result.ir.scenes.scene.rootVisualIds.push(second.id);
  result.ir.scenes.scene.items.push({ id: second.id, domain: "visual" });
  expectCode(
    () => validateReferenceParallaxCameraGraph(result.ir, result.composition),
    "CUT_PARALLAX_LIMIT",
    /simultaneously active cameras camera, camera-two total .*composition camera limits/,
  );
});

test("composition camera work uses absolute scene time and does not sum sequential scenes", () => {
  const result = fixture({ layers: [
    { id: "far", depth: 1_000, edge: "transparent" },
    { id: "near", depth: 0, edge: "transparent" },
  ] });
  result.composition.width = 4_096;
  result.composition.height = 4_096;
  result.composition.duration = rational(2);
  const firstScene = structuredClone(result.ir.scenes.scene);
  firstScene.id = "scene-a";
  firstScene.name = "a";
  firstScene.start = rational(0);
  firstScene.provenance = provenance("scene-a");
  for (const item of Object.values(result.nodes)) item.sceneId = "scene-a";
  const second = appendTransparentCamera(result, "camera-two", "scene-b");
  const secondScene = {
    ...structuredClone(firstScene),
    id: "scene-b",
    name: "b",
    start: rational(1),
    rootVisualIds: [second.id],
    items: [{ id: second.id, domain: "visual" as const }],
    provenance: provenance("scene-b"),
  };
  result.ir.scenes = { "scene-a": firstScene, "scene-b": secondScene };
  result.composition.sceneIds = ["scene-a", "scene-b"];
  result.composition.items = [{ kind: "scene", id: "scene-a" }, { kind: "scene", id: "scene-b" }];
  result.composition.rootVisualIds = [];
  assert.equal(validateReferenceParallaxCameraGraph(result.ir, result.composition).size, 2);
});

test("projected resize axes are bounded before Sharp can allocate a scale-20 intermediate", () => {
  const result = fixture({
    cameraInputs: { focalLength: length(1), ordering: string("source") },
    layers: [
      { id: "almost-focal-a", depth: -0.95, edge: "transparent" },
      { id: "almost-focal-b", depth: -0.94, edge: "transparent" },
    ],
  });
  result.composition.width = 4_096;
  result.composition.height = 4_096;
  expectCode(() => configOf(result), "CUT_PARALLAX_LIMIT", /resize the 4096x4096 source raster to 81920x81920/);
});

test("DepthLayer direct fan-out is locally bounded while recursive subtree scratch remains a separate contract", () => {
  const result = fixture();
  for (let index = 0; index < 16; index += 1) {
    const id = `near-extra-${index}`;
    result.nodes[id] = node(id, "cut.visual.rect", { width: length(1), height: length(1) }, []);
    result.nodes.near.children.push(id);
  }
  expectCode(() => configOf(result), "CUT_PARALLAX_LIMIT", /at most 16 direct visual children/);
});

test("output-frame validation executes spring interiors and catches overshoot beyond endpoint bounds", () => {
  const spring: IRValue = {
    kind: "call",
    op: "cut.motion.spring",
    positional: [],
    named: { mass: scalar(1), stiffness: scalar(100), damping: scalar(1) },
    effect: "pure",
  };
  const signal: IRSignal = {
    id: "overshoot-x",
    kind: "track",
    valueType: "Length",
    initial: length(0),
    events: [{ kind: "animate", start: rational(0), end: rational(1), from: length(0), to: length(60_000), curve: spring }],
    contentHash: "overshoot-hash",
    provenance: provenance("overshoot-x"),
  };
  const result = fixture({
    cameraProperties: { x: { signal: signal.id } },
    signals: { [signal.id]: signal },
    layers: [
      { id: "far", depth: 1_000, edge: "transparent" },
      { id: "near", depth: 0, edge: "transparent" },
    ],
  });
  expectCode(() => configOf(result), "CUT_PARALLAX_RANGE", /executed x.*65536px/);
});

test("direct camera validation preflights malformed easing before property sampling", () => {
  const invalidCurve: IRValue = {
    kind: "call",
    op: "cut.motion.cubic_bezier",
    positional: [scalar(2), scalar(0), scalar(0.5), scalar(1)],
    named: {},
    effect: "pure",
  };
  const signal: IRSignal = {
    id: "invalid-easing-x",
    kind: "track",
    valueType: "Length",
    initial: length(0),
    events: [{ kind: "animate", start: rational(0), end: rational(1), from: length(0), to: length(10), curve: invalidCurve }],
    contentHash: "invalid-easing-hash",
    provenance: provenance("invalid-easing-x"),
  };
  const result = fixture({ cameraProperties: { x: { signal: signal.id } }, signals: { [signal.id]: signal } });
  assert.throws(
    () => validateReferenceParallaxCameraGraph(result.ir, result.composition),
    (error: unknown) => error instanceof ReferenceEasingConfigError
      && error.code === "CUT_EASING_INVALID"
      && /proof\.cut:7:3 cubicBezier x1 and x2/.test(error.message),
  );
});

test("camera, layer, and direct-child half-open intervals cannot hide accepted content", () => {
  const outside = fixture();
  outside.nodes.near.interval.start = rational(1);
  expectCode(() => configOf(outside), "CUT_PARALLAX_GRAPH", /interval must be contained/);

  const emptySample = fixture();
  emptySample.nodes["near-leaf"].interval.start = rational(1, 2);
  emptySample.nodes["near-leaf"].interval.duration = rational(1, 2);
  expectCode(() => configOf(emptySample), "CUT_PARALLAX_GRAPH", /active.*no direct child is active/);

  const neverActiveChild = fixture();
  neverActiveChild.nodes.never = node("never", "cut.visual.rect", { width: length(1), height: length(1) }, []);
  neverActiveChild.nodes.never.interval.duration = rational(0);
  neverActiveChild.nodes.near.children.push("never");
  expectCode(() => configOf(neverActiveChild), "CUT_PARALLAX_NOOP", /never active at an exact output-frame sample/);
});

test("ParallaxCamera refuses a reachable MotionBlur ancestor until shutter-time closure exists", () => {
  const result = fixture();
  result.camera.ownership = "child";
  result.nodes.blur = node("blur", "cut.visual.motion_blur", {}, [result.camera.id]);
  result.nodes.blur.ownership = "root";
  result.composition.rootVisualIds = ["blur"];
  result.composition.items = [{ kind: "scene", id: "scene" }];
  result.ir.scenes.scene.rootVisualIds = ["blur"];
  result.ir.scenes.scene.items = [{ id: "blur", domain: "visual" }];
  expectCode(
    () => validateReferenceParallaxCameraGraph(result.ir, result.composition),
    "CUT_PARALLAX_GRAPH",
    /beneath a reachable MotionBlur ancestor.*shutter subframes/,
  );
});

test("a shared camera requires two simultaneously active distinct planes", () => {
  const result = fixture();
  result.nodes.far.interval.duration = rational(1, 2);
  result.nodes["far-leaf"].interval.duration = rational(1, 2);
  result.nodes.near.interval.start = rational(1, 2);
  result.nodes.near.interval.duration = rational(1, 2);
  result.nodes["near-leaf"].interval.start = rational(1, 2);
  result.nodes["near-leaf"].interval.duration = rational(1, 2);
  expectCode(() => configOf(result), "CUT_PARALLAX_NOOP", /no exact output frame contains two active layers/);
});
