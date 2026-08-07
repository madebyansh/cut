import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRSignal, IRValue } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { validateReferenceLocalSpaceGraph } from "../lib/runtime/reference/local-space";
import {
  planReferenceLocalSpaceAffineTileTransformWork,
  planReferenceLocalSpaceCompositionTransformWork,
  planReferenceLocalSpaceTileTransformWork,
  ReferenceLocalSpaceTransformWorkError,
} from "../lib/runtime/reference/local-space-transform-work";
import { ReferencePreparedSignalResolver, ReferenceProducedSignalStateError } from "../lib/runtime/reference/signals";
import {
  prepareReferenceTrack2D,
  referenceTrack2DConfig,
  referenceTrack2DLocalSpacePlanAt,
} from "../lib/runtime/reference/tracking-2d";
import { validateReferenceLocalSpaceTransformExecutionPlan } from "../lib/runtime/reference/visual";

const provenance = Object.freeze({
  module: "allocation-proof.cut",
  span: Object.freeze({
    start: Object.freeze({ offset: 40, line: 7, column: 11 }),
    end: Object.freeze({ offset: 80, line: 7, column: 51 }),
  }),
});

const ownerNode: IRNode = {
  id: "owner",
  op: "cut.visual.group",
  domain: "visual",
  ownership: "root",
  sceneId: "scene",
  interval: { start: rational(0), duration: rational(1) },
  inputs: {},
  children: [],
  properties: {},
  effects: ["pure"],
  contentHash: "owner",
  provenance,
};

const composition = {
  id: "composition",
  name: "composition",
  width: 100,
  height: 80,
  fps: rational(4),
  sampleRate: 48_000,
  duration: rational(1),
  sceneIds: ["scene"],
} as CutAVIR["compositions"][number];

function expectWorkError(work: () => unknown, code: ReferenceLocalSpaceTransformWorkError["code"], message: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceLocalSpaceTransformWorkError);
    assert.equal(error.code, code);
    assert.deepEqual(error.source, { module: "allocation-proof.cut", line: 7, column: 11, nodeId: "owner" });
    assert.match(error.message, message);
    return true;
  });
}

test("shared LocalSpace allocation failures are stable and source-located", () => {
  expectWorkError(
    () => planReferenceLocalSpaceTileTransformWork(ownerNode, {
      source: { width: 20, height: 10 },
      destination: { width: 100, height: 80 },
      scale: Number.NaN,
      rotation: 0,
      opacity: 1,
    }),
    "CUT_LOCAL_SPACE_TRANSFORM_TYPE",
    /scale must be finite and positive/u,
  );
  expectWorkError(
    () => planReferenceLocalSpaceTileTransformWork(ownerNode, {
      source: { width: 20, height: 10 },
      destination: { width: 100, height: 80 },
      scale: 1,
      rotation: 0,
      opacity: 1.0001,
    }),
    "CUT_LOCAL_SPACE_TRANSFORM_TYPE",
    /opacity must be finite in the closed range/u,
  );
  expectWorkError(
    () => planReferenceLocalSpaceTileTransformWork(ownerNode, {
      source: { width: 20, height: 10 },
      destination: { width: 100, height: 80 },
      scale: 1,
      rotation: 0,
      opacity: 1,
      skewX: 5,
    } as unknown as Parameters<typeof planReferenceLocalSpaceTileTransformWork>[1]),
    "CUT_LOCAL_SPACE_TRANSFORM_TYPE",
    /transform request does not accept property "skewX"/u,
  );
});

test("planned arbitrary-rotation cover dimensions match the installed Sharp backend", async () => {
  for (const [width, height, expected] of [
    [3640, 1, [2575, 2575]],
    [1, 86, [62, 62]],
  ] as const) {
    const plan = planReferenceLocalSpaceTileTransformWork(ownerNode, {
      source: { width, height },
      destination: { width: 100, height: 80 },
      scale: 1,
      rotation: 45,
      opacity: 1,
    });
    const rendered = await sharp(Buffer.alloc(width * height * 4), {
      raw: { width, height, channels: 4 },
    }).rotate(45, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([plan.rotation.width, plan.rotation.height], expected);
    assert.deepEqual([rendered.info.width, rendered.info.height], expected);
  }
});

test("skew-aware V3 planning matches installed Sharp affine bounds across signed non-square cases", async () => {
  for (const [width, height, skewX, skewY] of [
    [7, 3, 30, 0],
    [7, 3, -30, 0],
    [3, 7, 0, 30],
    [3, 7, 0, -30],
    [13, 17, -17, 23],
    [19, 5, 11, -29],
  ] as const) {
    const plan = planReferenceLocalSpaceAffineTileTransformWork(ownerNode, {
      source: { width, height },
      destination: { width: 100, height: 80 },
      scale: 1,
      skewX,
      skewY,
      rotation: 0,
      opacity: 1,
    });
    assert.equal(plan.version, 3);
    if (plan.version !== 3) throw new Error("nonzero skew must produce V3 work");
    const rendered = await sharp(Buffer.alloc(width * height * 4), {
      raw: { width, height, channels: 4 },
    }).affine([
      [1, Math.tan(skewX * Math.PI / 180)],
      [Math.tan(skewY * Math.PI / 180), 1],
    ], {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      interpolator: sharp.interpolators.bicubic,
    }).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual(
      [plan.skew.width, plan.skew.height],
      [rendered.info.width, rendered.info.height],
      `${width}x${height} at skew ${skewX}/${skewY}`,
    );
    assert.equal(plan.stages.skew.input.width, width);
    assert.equal(plan.stages.skew.input.height, height);
    assert.deepEqual(plan.stages.skew.output, {
      width: plan.skew.width,
      height: plan.skew.height,
      pixels: plan.skew.pixels,
    });
  }
});

test("zero-skew affine planning preserves V2 identity and tampered V3 work fails runtime re-derivation", () => {
  const request = {
    source: { width: 13, height: 7 },
    destination: { width: 100, height: 80 },
    scale: 1.5,
    skewX: 17,
    skewY: -11,
    rotation: 23,
    opacity: 0.75,
  } as const;
  const v2 = planReferenceLocalSpaceTileTransformWork(ownerNode, {
    source: request.source,
    destination: request.destination,
    scale: request.scale,
    rotation: request.rotation,
    opacity: request.opacity,
  });
  const delegated = planReferenceLocalSpaceAffineTileTransformWork(ownerNode, { ...request, skewX: 0, skewY: 0 });
  assert.deepEqual(delegated, v2);
  const admitted = planReferenceLocalSpaceAffineTileTransformWork(ownerNode, request);
  assert.equal(admitted.version, 3);
  if (admitted.version !== 3) throw new Error("nonzero skew must produce V3 work");
  const forged = {
    ...admitted,
    skew: { ...admitted.skew, width: admitted.skew.width - 1 },
  } as typeof admitted;
  assert.throws(
    () => validateReferenceLocalSpaceTransformExecutionPlan(ownerNode, forged, request),
    (error: unknown) => error instanceof Error
      && /CUT_LOCAL_SPACE_RASTER/u.test(error.message)
      && /does not match runtime-derived work/u.test(error.message),
  );
});

test("a full 4K tile rotation fails closed until cropped or streaming affine execution exists", () => {
  expectWorkError(
    () => planReferenceLocalSpaceTileTransformWork(ownerNode, {
      source: { width: 4096, height: 4096 },
      destination: { width: 3840, height: 2160 },
      scale: 1,
      rotation: 45,
      opacity: 1,
    }),
    "CUT_LOCAL_SPACE_TRANSFORM_LIMIT",
    /maximum is 536870912 until the renderer provides a measured cropped or streaming affine path/u,
  );
});

test("composition aggregation rejects hostile sparse or forged-small work without trusting receipts", () => {
  const valid = planReferenceLocalSpaceTileTransformWork(ownerNode, {
    source: { width: 20, height: 10 },
    destination: { width: composition.width, height: composition.height },
    scale: 1,
    rotation: 0,
    opacity: 1,
  });
  const sparse = new Array<{ node: IRNode; transform: Parameters<typeof planReferenceLocalSpaceTileTransformWork>[1] }>(2);
  sparse[1] = {
    node: ownerNode,
    transform: {
      source: { width: 20, height: 10 },
      destination: { width: composition.width, height: composition.height },
      scale: 1,
      rotation: 0,
      opacity: 1,
    },
  };
  expectWorkError(
    () => planReferenceLocalSpaceCompositionTransformWork(ownerNode, composition, sparse),
    "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE",
    /requests cannot contain a hole at index 0/u,
  );
  const forged = [{
    ...valid,
    perTransform: { totalAllocatedBytesUpperBound: 1, peakLiveBytesUpperBound: 1 },
    compositionLiveOutput: { surfaces: 1, pixels: composition.width * composition.height, rgba8Bytes: 1 },
  }] as unknown as Parameters<typeof planReferenceLocalSpaceCompositionTransformWork>[2];
  expectWorkError(
    () => planReferenceLocalSpaceCompositionTransformWork(ownerNode, composition, forged),
    "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE",
    /precomputed or forged work receipts are forbidden/u,
  );
});

function compile(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  finalizeGraphHashes(ir);
  return ir;
}

function visualNode(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((node) => node.op === op);
  assert.ok(result, `missing ${op}`);
  return result;
}

function preparedScale(initial: IRValue, signal: Extract<IRSignal, { kind: "track" }>): Extract<IRSignal, { kind: "track" }> {
  return Object.freeze({
    id: signal.id,
    kind: "track" as const,
    valueType: signal.valueType,
    initial,
    events: [],
    contentHash: "prepared-scale-proof",
    provenance: signal.provenance,
  });
}

test("Track2D forwards its invocation-owned prepared signal resolver into shared transform planning", () => {
  const ir = compile(`cut 0.4;
project "prepared retained transform proof";
import { LocalSpace, Rect, Track2D } from "cut:visual";
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
      bindRotation: false,
      scale: 0.5
    ) as owner {
      LocalSpace(width: 20px, height: 10px, origin: { x: 0px, y: 0px }) {
        Rect(width: 4px, height: 2px, fill: #ef233c);
      }
    }
    animate owner.scale from 0.5 to 0.75 over 1s;
  }
}
export out = render(main, codec: "h264");`);
  const trackNode = visualNode(ir, "cut.visual.track_2d"), localNode = visualNode(ir, "cut.visual.local_space"), selectedComposition = ir.compositions[0];
  const property = trackNode.properties.scale;
  assert.ok(property && "signal" in property);
  const signal = ir.signals[property.signal];
  assert.ok(signal?.kind === "track");
  signal.producer = {} as Extract<IRSignal, { kind: "track" }>["producer"];
  const resolver = new ReferencePreparedSignalResolver(ir);
  resolver.install(signal.id, preparedScale({ kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(3, 4) }, signal));

  const local = validateReferenceLocalSpaceGraph(ir, selectedComposition).get(localNode.id), config = referenceTrack2DConfig(ir, trackNode);
  assert.ok(local && config);
  const sidecar = Buffer.from(JSON.stringify({
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 100,
    height: 80,
    samples: [
      {
        at: { numerator: "0", denominator: "1" },
        x: { numerator: "50", denominator: "1" },
        y: { numerator: "40", denominator: "1" },
        scale: { numerator: "2", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status: "visible",
      },
      {
        at: { numerator: "1", denominator: "1" },
        x: { numerator: "50", denominator: "1" },
        y: { numerator: "40", denominator: "1" },
        scale: { numerator: "2", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status: "visible",
      },
    ],
  }));
  const track = prepareReferenceTrack2D(trackNode, config, selectedComposition, sidecar);
  assert.throws(
    () => referenceTrack2DLocalSpacePlanAt(ir, selectedComposition, trackNode, track, config, local, rational(0)),
    (error: unknown) => error instanceof ReferenceProducedSignalStateError,
  );
  const plan = referenceTrack2DLocalSpacePlanAt(ir, selectedComposition, trackNode, track, config, local, rational(0), resolver);
  assert.equal(plan.scale, 1.5);
  assert.equal(plan.work.kind, "retained-tile-transform");
  if (plan.work.kind === "retained-tile-transform") assert.equal(plan.work.requestedResize.width, 30);
  resolver.close();
});

function fullTurnTrackSource(rotation: number, opacityPercent?: number) {
  return `cut 0.4;
project "canonical retained turn proof";
import { LocalSpace, Rect, Track2D } from "cut:visual";
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
      bindScale: false,
      bindRotation: false,
      rotation: ${rotation}deg${opacityPercent === undefined ? "" : `,
      opacity: ${opacityPercent}%`}
    ) {
      LocalSpace(width: 20px, height: 10px, origin: { x: 0px, y: 0px }) {
        Rect(width: 4px, height: 2px, fill: #ef233c);
      }
    }
  }
}
export out = render(main, codec: "h264");`;
}

test("Track2D exposes exact authored bounds separately from Q16 raster placement at the half-unit tie", () => {
  const ir = compile(fullTurnTrackSource(0).replace(
    "LocalSpace(width: 20px, height: 10px, origin: { x: 0px, y: 0px })",
    "LocalSpace(width: 20px, height: 10px, origin: { x: 0.00000762939453125px, y: 0px })",
  ));
  const selectedComposition = ir.compositions[0], trackNode = visualNode(ir, "cut.visual.track_2d"), localNode = visualNode(ir, "cut.visual.local_space");
  const config = referenceTrack2DConfig(ir, trackNode), local = validateReferenceLocalSpaceGraph(ir, selectedComposition).get(localNode.id);
  assert.ok(config && local);
  const sidecar = Buffer.from(JSON.stringify({
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 100,
    height: 80,
    samples: [
      {
        at: { numerator: "0", denominator: "1" },
        x: { numerator: "50", denominator: "1" },
        y: { numerator: "40", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status: "visible",
      },
      {
        at: { numerator: "1", denominator: "1" },
        x: { numerator: "50", denominator: "1" },
        y: { numerator: "40", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status: "visible",
      },
    ],
  }));
  const prepared = prepareReferenceTrack2D(trackNode, config, selectedComposition, sidecar);
  const plan = referenceTrack2DLocalSpacePlanAt(ir, selectedComposition, trackNode, prepared, config, local, rational(0));
  assert.deepEqual(plan.sourceSpace.rasterRegistration, { x: 1 / 65_536, y: 0 });
  assert.ok(plan.authoredProjectedSourceBounds && plan.rasterProjectedSourceBounds);
  assert.equal(plan.authoredProjectedSourceBounds.minX, 50 - 1 / 131_072);
  assert.equal(plan.rasterProjectedSourceBounds.minX, 50 - 1 / 65_536);
  assert.equal(plan.authoredProjectedSourceBounds.maxX, 70 - 1 / 131_072);
  assert.equal(plan.rasterProjectedSourceBounds.maxX, 70 - 1 / 65_536);
  assert.notDeepEqual(plan.authoredProjectedSourceBounds, plan.rasterProjectedSourceBounds);
});

test("Track2D owner opacity zero is a distinct counter-facing no-raster skip", () => {
  const ir = compile(fullTurnTrackSource(0, 0)), selectedComposition = ir.compositions[0];
  const trackNode = visualNode(ir, "cut.visual.track_2d"), localNode = visualNode(ir, "cut.visual.local_space");
  const config = referenceTrack2DConfig(ir, trackNode), local = validateReferenceLocalSpaceGraph(ir, selectedComposition).get(localNode.id);
  assert.ok(config && local);
  const sidecar = (status: "visible" | "out-of-frame") => Buffer.from(JSON.stringify({
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 100,
    height: 80,
    samples: [
      {
        at: { numerator: "0", denominator: "1" },
        x: { numerator: "50", denominator: "1" },
        y: { numerator: "40", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status,
      },
      {
        at: { numerator: "1", denominator: "1" },
        x: { numerator: "50", denominator: "1" },
        y: { numerator: "40", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status: "visible",
      },
    ],
  }));
  const plan = (status: "visible" | "out-of-frame") => referenceTrack2DLocalSpacePlanAt(
    ir,
    selectedComposition,
    trackNode,
    prepareReferenceTrack2D(trackNode, config, selectedComposition, sidecar(status)),
    config,
    local,
    rational(0),
  );

  const ownerOpacity = plan("visible");
  assert.equal(ownerOpacity.hidden, false);
  assert.equal(ownerOpacity.opacity, 0);
  assert.deepEqual(ownerOpacity.skip, {
    classification: "owner-opacity",
    reason: "opacity-zero",
    executionEvidence: {
      skipKind: "owner-opacity",
      skipReason: "opacity-zero",
      counter: "ownerOpacitySkips",
    },
  });
  const ownerWork = ownerOpacity.work;
  assert.equal(ownerWork.kind, "owner-opacity-no-raster");
  assert.equal(ownerWork.allocatedBytes, 0);
  assert.equal(ownerWork.compositionLiveOutputSurfaces, 0);
  assert.deepEqual(ownerWork.expectedExecutionCounters, {
    tileRequests: 0,
    placementRequests: 0,
    ownerOpacitySkips: 1,
    ownerPolicySkips: 0,
  });
  assert.equal(ownerOpacity.rendererHandoff, "connected-reference-visual-renderer");

  const trackingPolicy = plan("out-of-frame");
  assert.equal(trackingPolicy.hidden, true);
  assert.equal(trackingPolicy.skip?.classification, "tracking-policy-hidden");
  const trackingWork = trackingPolicy.work;
  assert.equal(trackingWork.kind, "tracking-policy-hidden-no-raster");
  assert.equal(trackingWork.expectedExecutionCounters.ownerOpacitySkips, 0);
  assert.equal(trackingWork.expectedExecutionCounters.ownerPolicySkips, 1);
  assert.deepEqual(trackingPolicy.skip?.executionEvidence, {
    skipKind: "owner-policy",
    skipReason: "tracking-policy-hidden",
    counter: "ownerPolicySkips",
  });
  assert.equal(trackingPolicy.rendererHandoff, "connected-reference-visual-renderer");
  assert.notEqual(trackingPolicy.cacheIdentity, ownerOpacity.cacheIdentity);
});

test("Track2D plan cache identity canonicalizes authored 0, +360, and -360 degree turns", () => {
  const sidecar = Buffer.from(JSON.stringify({
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 100,
    height: 80,
    samples: [
      {
        at: { numerator: "0", denominator: "1" },
        x: { numerator: "50", denominator: "1" },
        y: { numerator: "40", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status: "visible",
      },
      {
        at: { numerator: "1", denominator: "1" },
        x: { numerator: "50", denominator: "1" },
        y: { numerator: "40", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status: "visible",
      },
    ],
  }));
  const planned = (rotation: number) => {
    const ir = compile(fullTurnTrackSource(rotation)), selectedComposition = ir.compositions[0];
    const trackNode = visualNode(ir, "cut.visual.track_2d"), localNode = visualNode(ir, "cut.visual.local_space");
    const config = referenceTrack2DConfig(ir, trackNode), local = validateReferenceLocalSpaceGraph(ir, selectedComposition).get(localNode.id);
    assert.ok(config && local);
    const prepared = prepareReferenceTrack2D(trackNode, config, selectedComposition, sidecar);
    return { nodeContentHash: trackNode.contentHash, plan: referenceTrack2DLocalSpacePlanAt(ir, selectedComposition, trackNode, prepared, config, local, rational(0)) };
  };
  const zero = planned(0), positive = planned(360), negative = planned(-360);
  assert.notEqual(positive.nodeContentHash, zero.nodeContentHash, "the source forms genuinely differ before execution canonicalization");
  assert.notEqual(negative.nodeContentHash, zero.nodeContentHash, "the source forms genuinely differ before execution canonicalization");
  assert.equal(zero.plan.rotation, 0);
  assert.equal(positive.plan.rotation, 0);
  assert.equal(negative.plan.rotation, 0);
  assert.equal(positive.plan.cacheIdentity, zero.plan.cacheIdentity);
  assert.equal(negative.plan.cacheIdentity, zero.plan.cacheIdentity);
});
