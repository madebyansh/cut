import assert from "node:assert/strict";
import test from "node:test";
import { cutAnchoredPathLimits, cutAnchoredSpatialOps } from "../lib/language/anchored-path-contract";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { rational } from "../lib/language/rational";
import {
  decodeReferenceAnchoredPathGeometry,
  isReferenceAnchoredPathGeometryValue,
  ReferenceAnchoredPathError,
  referenceAnchoredPathInspect,
  resolveReferenceAnchoredPathGeometryAt,
  validateReferenceAnchoredPathGeometry,
  type ReferenceAnchoredPathOwnerResolver,
} from "../lib/runtime/reference/anchored-path";
import type { ReferenceLocalSpaceConfig, ReferenceLocalSpacePlacement } from "../lib/runtime/reference/local-space";

const provenance = (offset: number, line: number) => Object.freeze({
  module: "anchored-proof.cut",
  span: Object.freeze({
    start: Object.freeze({ offset, line, column: 3 }),
    end: Object.freeze({ offset: offset + 10, line, column: 13 }),
  }),
});

function node(
  id: string,
  op: string,
  offset: number,
  options: Partial<Pick<IRNode, "ownership" | "sceneId" | "children" | "interval">> = {},
): IRNode {
  return {
    id,
    op,
    domain: "visual",
    ownership: options.ownership ?? "root",
    sceneId: options.sceneId ?? "scene",
    interval: options.interval ?? { start: rational(0), duration: rational(2) },
    inputs: {},
    children: options.children ?? [],
    properties: {},
    effects: ["pure"],
    contentHash: `${id}-content`,
    provenance: provenance(offset, Math.floor(offset / 10) + 1),
  };
}

const owner = node("owner", "cut.kernel.fragment", 10, { children: ["local"] });
const localNode = node("local", "cut.visual.local_space", 20, { ownership: "child", children: ["rect"] });
const rectNode = node("rect", "cut.visual.rect", 30, { ownership: "child" });
const consumer = node("route", "cut.visual.path", 100);

const composition: CutAVIR["compositions"][number] = {
  id: "composition",
  name: "composition",
  width: 200,
  height: 100,
  fps: rational(24),
  sampleRate: 48_000,
  duration: rational(2),
  sceneIds: ["scene"],
  rootVisualIds: [owner.id, consumer.id],
  rootAudioIds: [],
  rootAVIds: [],
  items: [{ kind: "scene", id: "scene" }],
  provenance: provenance(0, 1),
};

const ir: CutAVIR = {
  format: "cut-av-ir",
  version: 3,
  language: "0.4",
  compiler: "cut-ts/test",
  project: "unrelated anchored path proof",
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
      name: "scene",
      start: rational(0),
      duration: rational(2),
      rootVisualIds: [owner.id, consumer.id],
      rootAudioIds: [],
      rootAVIds: [],
      items: [{ id: owner.id, domain: "visual" }, { id: consumer.id, domain: "visual" }],
      provenance: provenance(1, 1),
    },
  },
  nodes: { owner, local: localNode, rect: rectNode, route: consumer },
  signals: {},
  jobs: [],
  outputs: [],
  assertions: [],
};

const localConfig = Object.freeze({
  nodeId: "local",
  width: 20,
  height: 10,
  origin: Object.freeze({ x: rational(10), y: rational(5) }),
  rasterOriginQ16: Object.freeze({ x: String(10 * 65_536), y: String(5 * 65_536) }),
  view: Object.freeze({ minX: rational(-10), minY: rational(-5), maxX: rational(10), maxY: rational(5) }),
  childIds: Object.freeze(["rect"]),
  nestingDepth: 1,
  estimatedPixelPassesPerFrame: 1,
  preparedTracePointsPerFrame: 0,
  owner: "component-fragment" as const,
  ownerNodeId: "owner",
  semanticIdentity: "local-content-and-basis-evidence",
  localCompositing: Object.freeze({}),
}) as unknown as ReferenceLocalSpaceConfig;

const q = (value: number): IRValue => ({ kind: "quantity", dimension: "length", unit: "px", magnitude: rational(value) });
const vec = (x: number, y: number): IRValue => ({ kind: "object", entries: { x: q(x), y: q(y) } });
const call = (op: string, named: Record<string, IRValue>, effect: "pure" | "read" = "pure", positional: IRValue[] = []): IRValue => ({
  kind: "call",
  op,
  positional,
  named,
  effect,
});
const anchor = (ownerNodeId: string, x: number, y: number) => call(cutAnchoredSpatialOps.visualAnchor, {
  owner: { kind: "node-ref", id: ownerNodeId },
  local: vec(x, y),
});
const offset = (point: IRValue, x: number, y: number) => call(cutAnchoredSpatialOps.compositionOffset, { point, by: vec(x, y) });
const line = (to: IRValue) => call(cutAnchoredSpatialOps.anchoredLineTo, { to });
const cubic = (control1: IRValue, control2: IRValue, to: IRValue) => call(cutAnchoredSpatialOps.anchoredCubicTo, { control1, control2, to });
const path = (start: IRValue, segments: IRValue[], closed = false) => call(cutAnchoredSpatialOps.anchoredPath, {
  start,
  segments: { kind: "array", items: segments },
  closed: { kind: "boolean", value: closed },
});

function exampleValue() {
  return path(
    anchor("owner", 2, 3),
    [
      line(vec(50, 50)),
      cubic(vec(55, 48), offset(anchor("owner", 1, 1), 4, -2), vec(70, 70)),
    ],
  );
}

function expectError(work: () => unknown, code: ReferenceAnchoredPathError["code"], pattern: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceAnchoredPathError);
    assert.equal(error.code, code);
    assert.deepEqual(error.source, { module: "anchored-proof.cut", line: 11, column: 3, nodeId: "route" });
    assert.match(error.message, pattern);
    return true;
  });
}

test("strict anchored decoder preserves symbolic owners while admitting raw composition points", () => {
  const value = exampleValue();
  assert.equal(isReferenceAnchoredPathGeometryValue(value), true);
  const geometry = decodeReferenceAnchoredPathGeometry(consumer, value, "geometry");
  assert.equal(geometry.geometryKind, "anchored");
  assert.equal(geometry.segments.length, 2);
  assert.equal(geometry.spatialPointCount, 5, "offset wrappers do not consume point-bearing path slots");
  assert.equal(geometry.visualAnchorCount, 2);
  assert.deepEqual(geometry.ownerNodeIds, ["owner"]);
  assert.equal(geometry.segments[0]?.kind, "line");
  assert.equal(geometry.segments[1]?.kind, "cubic");
  assert.match(geometry.semanticIdentity, /^[0-9a-f]{64}$/u);
  assert.deepEqual(referenceAnchoredPathInspect(geometry), {
    algorithmVersion: "cut-reference-anchored-path-v1",
    geometryKind: "anchored",
    segments: 2,
    spatialPointCount: 5,
    visualAnchorCount: 2,
    ownerNodeIds: ["owner"],
    closed: false,
    semanticIdentity: geometry.semanticIdentity,
    resolution: "exact-frame-owner-placement",
    policy: {
      opacityZero: "coordinate-remains-resolvable",
      trackPolicyHidden: "suppresses-dependent-geometry",
      projectiveOwners: "unsupported-v1",
    },
  });
});

test("anchored calls and records are closed, versioned, pure, and bounded", () => {
  const malformedRoot = { ...(exampleValue() as Extract<IRValue, { kind: "call" }>), privateGraph: true } as unknown as IRValue;
  expectError(() => decodeReferenceAnchoredPathGeometry(consumer, malformedRoot, "geometry"), "CUT_ANCHORED_PATH_SHAPE", /unsupported privateGraph/u);
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, call("cut.visual.anchored_path.v2", {}, "pure"), "geometry"),
    "CUT_ANCHORED_PATH_TYPE",
    /op must be exactly/u,
  );
  const impure = exampleValue() as Extract<IRValue, { kind: "call" }>;
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, { ...impure, effect: "read" }, "geometry"),
    "CUT_ANCHORED_PATH_TYPE",
    /effect must be pure/u,
  );
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, { ...impure, positional: [vec(1, 2)] }, "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /positional must be empty/u,
  );
  const sparse = exampleValue() as Extract<IRValue, { kind: "call" }>;
  const sparseSegments = new Array<IRValue>(2);
  sparseSegments[1] = line(vec(10, 10));
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, {
      ...sparse,
      named: { ...sparse.named, segments: { kind: "array", items: sparseSegments } },
    }, "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /must be dense/u,
  );
  const hiddenPoint = vec(10, 10);
  Object.defineProperty(hiddenPoint, "privateCoordinate", { value: 99, enumerable: false });
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(anchor("owner", 0, 0), [line(hiddenPoint)]), "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /unsupported privateCoordinate/u,
  );
  const nonCanonical = {
    kind: "quantity",
    dimension: "length",
    unit: "px",
    magnitude: { numerator: "2", denominator: "2" },
  } as IRValue;
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(anchor("owner", 0, 0), [line({ kind: "object", entries: { x: nonCanonical, y: q(1) } })]), "geometry"),
    "CUT_ANCHORED_PATH_TYPE",
    /canonical reduced Rational/u,
  );
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(anchor("owner", 0, 0), [line(vec(cutAnchoredPathLimits.maximumAbsoluteCoordinatePx + 1, 0))]), "geometry"),
    "CUT_ANCHORED_PATH_LIMIT",
    /coordinate envelope/u,
  );
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(anchor("owner", 0, 0), Array.from({ length: cutAnchoredPathLimits.maximumSegments + 1 }, (_, index) => line(vec(index + 1, 0)))), "geometry"),
    "CUT_ANCHORED_PATH_LIMIT",
    /1 through 256/u,
  );
});

test("decoder rejects composition-only misuse, no-op offsets, zero segments, and redundant closure", () => {
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(vec(0, 0), [line(vec(10, 0))]), "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /at least one visualAnchor/u,
  );
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(offset(anchor("owner", 0, 0), 0, 0), [line(vec(10, 0))]), "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /zero compositionOffset/u,
  );
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(offset(offset(anchor("owner", 0, 0), 4, -2), -4, 2), [line(vec(10, 0))]), "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /zero net offset/u,
  );
  const same = anchor("owner", 1, 1);
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(same, [line(same)]), "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /zero-length line/u,
  );
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(offset(vec(0, 0), 10, 0), [line(vec(10, 0)), line(anchor("owner", 1, 1))]), "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /zero-length line/u,
  );
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(offset(anchor("owner", 1, 1), 4, 0), [line(offset(offset(anchor("owner", 1, 1), 2, 0), 2, 0))]), "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /zero-length line/u,
  );
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(anchor("owner", 1, 1), [line(vec(2, 2)), line(anchor("owner", 1, 1))], true), "geometry"),
    "CUT_ANCHORED_PATH_SHAPE",
    /redundantly repeats/u,
  );
  let deep = anchor("owner", 1, 1);
  for (let index = 0; index <= cutAnchoredPathLimits.maximumOffsetDepth; index += 1) deep = offset(deep, 1, 0);
  expectError(
    () => decodeReferenceAnchoredPathGeometry(consumer, path(deep, [line(vec(10, 0))]), "geometry"),
    "CUT_ANCHORED_PATH_LIMIT",
    /compositionOffset depth/u,
  );
});

test("owner validation binds one earlier affine LocalSpace and enforces closed local bounds", () => {
  const geometry = decodeReferenceAnchoredPathGeometry(consumer, exampleValue(), "geometry");
  const validated = validateReferenceAnchoredPathGeometry(ir, composition, consumer, geometry, new Map([[localConfig.nodeId, localConfig]]));
  assert.deepEqual(validated.ownerBindings, [{
    ownerNodeId: "owner",
    localSpaceNodeId: "local",
    ownerKind: "component-fragment",
    localSpaceSemanticIdentity: localConfig.semanticIdentity,
  }]);
  assert.match(validated.validationIdentity, /^[0-9a-f]{64}$/u);

  const outside = decodeReferenceAnchoredPathGeometry(consumer, path(anchor("owner", 11, 0), [line(vec(10, 10))]), "geometry");
  expectError(
    () => validateReferenceAnchoredPathGeometry(ir, composition, consumer, outside, new Map([[localConfig.nodeId, localConfig]])),
    "CUT_ANCHORED_PATH_RANGE",
    /outside LocalSpace local's closed authored view/u,
  );
  expectError(
    () => validateReferenceAnchoredPathGeometry(ir, composition, consumer, geometry, new Map()),
    "CUT_ANCHORED_PATH_GRAPH",
    /exactly one validated LocalSpace/u,
  );
  expectError(
    () => validateReferenceAnchoredPathGeometry(ir, composition, consumer, geometry, new Map([
      ["a", { ...localConfig, nodeId: "a" } as ReferenceLocalSpaceConfig],
      ["b", { ...localConfig, nodeId: "b" } as ReferenceLocalSpaceConfig],
    ])),
    "CUT_ANCHORED_PATH_GRAPH",
    /found 2/u,
  );
});

test("nested, motion, geo, depth, and projective LocalSpace owners fail closed in anchored v1", () => {
  const geometry = decodeReferenceAnchoredPathGeometry(consumer, exampleValue(), "geometry");
  for (const ownerKind of ["local-space", "motion-path", "geo-annotation", "depth-layer", "planar-track", "plane-3d"] as const) {
    expectError(
      () => validateReferenceAnchoredPathGeometry(ir, composition, consumer, geometry, new Map([["local", {
        ...localConfig,
        owner: ownerKind,
      } as ReferenceLocalSpaceConfig]])),
      "CUT_ANCHORED_PATH_UNSUPPORTED",
      new RegExp(`unsupported ${ownerKind}`, "u"),
    );
  }
});

test("consumer-under-LocalSpace, structural dependency, later owner, and interval escape fail before rendering", () => {
  const geometry = decodeReferenceAnchoredPathGeometry(consumer, exampleValue(), "geometry");
  const nestedIr = {
    ...ir,
    nodes: {
      ...ir.nodes,
      local: { ...localNode, children: ["rect", "route"] },
    },
  };
  expectError(
    () => validateReferenceAnchoredPathGeometry(nestedIr, composition, consumer, geometry, new Map([["local", {
      ...localConfig,
      childIds: ["rect", "route"],
    } as ReferenceLocalSpaceConfig]])),
    "CUT_ANCHORED_PATH_UNSUPPORTED",
    /nested under LocalSpace/u,
  );
  const dependentIr = { ...ir, nodes: { ...ir.nodes, owner: { ...owner, children: ["local", "route"] } } };
  expectError(
    () => validateReferenceAnchoredPathGeometry(dependentIr, composition, consumer, geometry, new Map([["local", localConfig]])),
    "CUT_ANCHORED_PATH_GRAPH",
    /ancestor\/descendant/u,
  );
  const lateOwner = { ...owner, provenance: provenance(120, 13) };
  expectError(
    () => validateReferenceAnchoredPathGeometry({ ...ir, nodes: { ...ir.nodes, owner: lateOwner } }, composition, consumer, geometry, new Map([["local", localConfig]])),
    "CUT_ANCHORED_PATH_GRAPH",
    /bound earlier/u,
  );
  const foreignOwner = { ...owner, provenance: { ...owner.provenance, module: "foreign.cut" } };
  expectError(
    () => validateReferenceAnchoredPathGeometry({ ...ir, nodes: { ...ir.nodes, owner: foreignOwner } }, composition, consumer, geometry, new Map([["local", localConfig]])),
    "CUT_ANCHORED_PATH_GRAPH",
    /same source module/u,
  );
  const shortOwner = { ...owner, interval: { start: rational(0), duration: rational(1) } };
  expectError(
    () => validateReferenceAnchoredPathGeometry({ ...ir, nodes: { ...ir.nodes, owner: shortOwner } }, composition, consumer, geometry, new Map([["local", localConfig]])),
    "CUT_ANCHORED_PATH_RANGE",
    /consumer interval/u,
  );
});

const placement: ReferenceLocalSpacePlacement = Object.freeze({
  owner: "component-fragment",
  contextIdentity: "owner-content-a",
  destinationX: 100,
  destinationY: 50,
  registrationRasterX: 10,
  registrationRasterY: 5,
  scale: 1,
  skewX: 0,
  skewY: 0,
  rotation: 0,
  opacity: 0,
});

test("opacity-zero retains exact coordinates and owner resolver samples once per unique owner", () => {
  const geometry = decodeReferenceAnchoredPathGeometry(consumer, exampleValue(), "geometry");
  let calls = 0;
  const resolver: ReferenceAnchoredPathOwnerResolver = (ownerNodeId) => {
    calls += 1;
    return { status: "opacity-zero", ownerNodeId, localSpace: localConfig, placement, ownerPlanIdentity: "audit-plan-a" };
  };
  const result = resolveReferenceAnchoredPathGeometryAt(consumer, geometry, rational(1, 2), resolver, 12n);
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") assert.fail("unexpected policy-hidden result");
  assert.equal(calls, 1);
  assert.deepEqual(result.geometry.start, { x: 102, y: 53 });
  assert.equal(result.anchors.length, 2);
  assert.ok(result.anchors.every((anchor) => anchor.ownerStatus === "opacity-zero"));
  assert.deepEqual(result.anchors[1]?.compositionPoint, { x: 101, y: 51 });
  assert.match(result.geometryIdentity, /^[0-9a-f]{64}$/u);

  const nonSpatialChanged = resolveReferenceAnchoredPathGeometryAt(consumer, geometry, rational(1, 2), () => ({
    status: "visible",
    ownerNodeId: "owner",
    localSpace: { ...localConfig, semanticIdentity: "changed-child-grade-and-media" } as ReferenceLocalSpaceConfig,
    placement: { ...placement, contextIdentity: "owner-content-b", opacity: 1 },
    ownerPlanIdentity: "audit-plan-b",
  }));
  assert.equal(nonSpatialChanged.status, "resolved");
  if (nonSpatialChanged.status !== "resolved") assert.fail("unexpected policy-hidden result");
  assert.equal(nonSpatialChanged.geometryIdentity, result.geometryIdentity);
  assert.equal(nonSpatialChanged.executionIdentity, result.executionIdentity);
  assert.notEqual(nonSpatialChanged.anchors[0]?.ownerPlanIdentity, result.anchors[0]?.ownerPlanIdentity);

  const moved = resolveReferenceAnchoredPathGeometryAt(consumer, geometry, rational(1, 2), () => ({
    status: "visible",
    ownerNodeId: "owner",
    localSpace: localConfig,
    placement: { ...placement, destinationX: 101, opacity: 1 },
    ownerPlanIdentity: "audit-plan-c",
  }));
  assert.equal(moved.status, "resolved");
  if (moved.status === "resolved") assert.notEqual(moved.geometryIdentity, result.geometryIdentity);
});

test("Track2D policy-hidden suppresses the complete dependent geometry with zero raster work", () => {
  const geometry = decodeReferenceAnchoredPathGeometry(consumer, exampleValue(), "geometry");
  const hidden = (planIdentity: string) => resolveReferenceAnchoredPathGeometryAt(consumer, geometry, rational(1, 2), () => ({
    status: "policy-hidden",
    ownerNodeId: "owner",
    ownerKind: "track-2d",
    localSpaceNodeId: "local",
    ownerPlanIdentity: planIdentity,
  }));
  const result = hidden("track-plan-a");
  assert.equal(result.status, "policy-hidden");
  if (result.status !== "policy-hidden") assert.fail("unexpected resolved result");
  assert.deepEqual(result.zeroWork, {
    kind: "anchored-path-policy-hidden-no-raster",
    geometryPreparations: 0,
    rasterRequests: 0,
    ownerPolicySkips: 1,
  });
  assert.deepEqual(result.suppressedBy, [{
    ownerNodeId: "owner",
    ownerKind: "track-2d",
    localSpaceNodeId: "local",
    ownerPlanIdentity: "track-plan-a",
  }]);
  assert.equal(hidden("changed-audit-only-plan").executionIdentity, result.executionIdentity);
});

test("upstream owner fail-policy errors propagate unchanged", () => {
  const geometry = decodeReferenceAnchoredPathGeometry(consumer, exampleValue(), "geometry"), upstream = new Error("CUT_TRACK2D_POLICY: fail");
  assert.throws(
    () => resolveReferenceAnchoredPathGeometryAt(consumer, geometry, rational(0), () => { throw upstream; }),
    (error: unknown) => error === upstream,
  );
});

test("resolver status and placement opacity cannot contradict each other", () => {
  const geometry = decodeReferenceAnchoredPathGeometry(consumer, exampleValue(), "geometry");
  expectError(
    () => resolveReferenceAnchoredPathGeometryAt(consumer, geometry, rational(0), () => ({
      status: "opacity-zero",
      ownerNodeId: "owner",
      localSpace: localConfig,
      placement: { ...placement, opacity: 1 },
      ownerPlanIdentity: "forged",
    })),
    "CUT_ANCHORED_PATH_RESOLUTION",
    /claimed opacity-zero with nonzero/u,
  );
  expectError(
    () => resolveReferenceAnchoredPathGeometryAt(consumer, geometry, rational(0), () => ({
      status: "visible",
      ownerNodeId: "owner",
      localSpace: localConfig,
      placement,
      ownerPlanIdentity: "forged",
    })),
    "CUT_ANCHORED_PATH_RESOLUTION",
    /claimed visible with zero/u,
  );
});
