import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { cutAnchoredSpatialOps } from "../lib/language/anchored-path-contract";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  decodeReferenceAnchoredPathGeometry,
  type ReferenceAnchoredPathOwnerResolver,
  type ReferenceValidatedAnchoredPathGeometry,
} from "../lib/runtime/reference/anchored-path";
import type { ReferenceLocalSpaceConfig, ReferenceLocalSpacePlacement } from "../lib/runtime/reference/local-space";
import {
  prepareReferenceAnchoredMotionPathNode,
  referenceAnchoredMotionPathResolutionAt,
  validateReferenceAnchoredMotionPathCompositionWork,
  validateReferenceAnchoredMotionPathFrameStates,
} from "../lib/runtime/reference/motion-path";
import {
  referenceRetainedPathChain,
  referenceRetainedPathChainExecutionAt,
} from "../lib/runtime/reference/retained-path-chain";
import {
  prepareReferenceAnchoredVectorPathNode,
  prepareReferenceVectorPathNode,
  referenceAnchoredVectorPathFrameResolutionAt,
  ReferenceVectorPathError,
  validateReferenceAnchoredVectorPathFrameStates,
} from "../lib/runtime/reference/vector-path";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const px = (value: number): IRValue => ({ kind: "quantity", dimension: "length", magnitude: rational(value), unit: "px" });
const ratio = (numerator: number, denominator = 1): IRValue => ({ kind: "quantity", dimension: "ratio", magnitude: rational(numerator, denominator), unit: "ratio" });
const point = (x: number, y: number): IRValue => ({ kind: "object", entries: { x: px(x), y: px(y) } });
const call = (op: string, named: Record<string, IRValue>): IRValue => ({ kind: "call", op, positional: [], named, effect: "pure" });
const anchor = (owner: string, x: number, y: number) => call(cutAnchoredSpatialOps.visualAnchor, {
  owner: { kind: "node-ref", id: owner },
  local: point(x, y),
});
const anchoredLine = (to: IRValue) => call(cutAnchoredSpatialOps.anchoredLineTo, { to });
const anchoredGeometry = (start: IRValue, end: IRValue, closed = false) => call(cutAnchoredSpatialOps.anchoredPath, {
  start,
  segments: { kind: "array", items: [anchoredLine(end)] },
  closed: { kind: "boolean", value: closed },
});
const vectorGeometry = (start: IRValue, end: IRValue): IRValue => ({
  kind: "object",
  entries: {
    start,
    segments: { kind: "array", items: [{ kind: "object", entries: { to: end } }] },
    closed: { kind: "boolean", value: false },
  },
});

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const compiled = compileCutModule(parsed.module);
  assert.deepEqual(compiled.check.diagnostics.filter((item) => item.severity === "error"), []);
  return compiled.ir;
}

function visualNode(id: string, op: string, inputs: Record<string, IRValue>, duration = 2): IRNode {
  return {
    id,
    op,
    domain: "visual",
    ownership: "root",
    sceneId: "scene",
    interval: { start: rational(0), duration: rational(duration) },
    inputs,
    children: [],
    properties: {},
    effects: ["pure"],
    contentHash: id.padEnd(64, "0").slice(0, 64),
    provenance: { module: "anchor.cut", span: { start: { line: 7, column: 3, offset: 0 }, end: { line: 7, column: 12, offset: 9 } } },
  };
}

function composition(fps = 2): IRComposition {
  return {
    id: "timeline",
    name: "anchor proof",
    width: 200,
    height: 200,
    fps: rational(fps),
    sampleRate: 48_000,
    duration: rational(2),
    sceneIds: ["scene"],
    items: [],
    rootVisualIds: ["owner", "path"],
    rootAudioIds: [],
    rootAVIds: [],
    provenance: { module: "anchor.cut", span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 8, offset: 7 } } },
  };
}

function runtime(nodes: IRNode[]): CutAVIR {
  return { nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), signals: {} } as unknown as CutAVIR;
}

const localSpace = {
  nodeId: "local",
  width: 200,
  height: 200,
  origin: { x: rational(0), y: rational(0) },
  rasterOriginQ16: { x: "0", y: "0" },
  view: { minX: rational(0), minY: rational(0), maxX: rational(200), maxY: rational(200) },
  childIds: [],
  nestingDepth: 0,
  estimatedPixelPassesPerFrame: 0,
  preparedTracePointsPerFrame: 0,
  owner: "group",
  ownerNodeId: "owner",
  semanticIdentity: "local-space-semantics",
  localCompositing: {},
} as unknown as ReferenceLocalSpaceConfig;

const placement = {
  owner: "group",
  contextIdentity: "context-evidence-only",
  destinationX: 100,
  destinationY: 80,
  registrationRasterX: 0,
  registrationRasterY: 0,
  scale: 1,
  skewX: 0,
  skewY: 0,
  rotation: 0,
  opacity: 1,
} satisfies ReferenceLocalSpacePlacement;

function ownerResolver(
  status: "visible" | "opacity-zero" | "policy-hidden" = "visible",
  ownerPlanIdentity = "owner-plan-a",
): ReferenceAnchoredPathOwnerResolver {
  return (ownerNodeId) => status === "policy-hidden"
    ? { status, ownerNodeId, ownerKind: "track-2d", localSpaceNodeId: "local", ownerPlanIdentity }
    : {
      status,
      ownerNodeId,
      localSpace,
      placement: { ...placement, opacity: status === "opacity-zero" ? 0 : 1 },
      ownerPlanIdentity,
    };
}

function validatedGeometry(node: IRNode): ReferenceValidatedAnchoredPathGeometry {
  const decoded = decodeReferenceAnchoredPathGeometry(node, node.inputs.geometry, "geometry");
  return Object.freeze({
    ...decoded,
    ownerBindings: Object.freeze(decoded.ownerNodeIds.map((ownerNodeId) => Object.freeze({
      ownerNodeId,
      localSpaceNodeId: localSpace.nodeId,
      ownerKind: "group" as const,
      localSpaceSemanticIdentity: localSpace.semanticIdentity,
    }))),
    validationIdentity: "test-validated-same-composition-owner-graph",
  });
}

test("anchored Path resolves at exact time, preserves opacity-zero coordinates, and exposes policy hide", () => {
  const owner = visualNode("owner", "cut.visual.group", {});
  const path = visualNode("path", "cut.visual.path", {
    geometry: anchoredGeometry(anchor(owner.id, 10, 20), point(180, 160)),
    stroke: { kind: "color", value: "#ffcc00" },
    width: px(3),
  });
  const ir = runtime([owner, path]), plan = prepareReferenceAnchoredVectorPathNode(ir, path, validatedGeometry(path))!;
  const visible = referenceAnchoredVectorPathFrameResolutionAt(ir, path, plan, rational(0), ownerResolver("visible"), 0n);
  const opacityZero = referenceAnchoredVectorPathFrameResolutionAt(ir, path, plan, rational(0), ownerResolver("opacity-zero", "unrelated-plan"), 0n);
  assert.equal(visible.status, "resolved");
  assert.equal(opacityZero.status, "resolved");
  if (visible.status !== "resolved" || opacityZero.status !== "resolved") return;
  assert.deepEqual(visible.frame.geometry.points[0], { x: 110, y: 100 });
  assert.equal(opacityZero.geometryIdentity, visible.geometryIdentity, "opacity and opaque owner-plan evidence must not poison spatial identity");
  const hidden = referenceAnchoredVectorPathFrameResolutionAt(ir, path, plan, rational(0), ownerResolver("policy-hidden"), 0n);
  assert.equal(hidden.status, "policy-hidden");
  if (hidden.status === "policy-hidden") assert.deepEqual(hidden.anchored.zeroWork, {
    kind: "anchored-path-policy-hidden-no-raster",
    geometryPreparations: 0,
    rasterRequests: 0,
    ownerPolicySkips: 1,
  });
  const work = validateReferenceAnchoredVectorPathFrameStates(ir, composition(), path, plan, ownerResolver("visible"));
  assert.deepEqual({ resolved: work.resolvedFrames, hidden: work.policyHiddenFrames, painted: work.visiblePaintFrames }, { resolved: 4, hidden: 0, painted: 4 });
  assert.deepEqual({ spatialPointFrames: work.spatialPointFrames, ownerSampleFrames: work.ownerSampleFrames }, { spatialPointFrames: 8, ownerSampleFrames: 4 });
});

test("owner-resolved execution refuses a decoded geometry that skipped graph validation", () => {
  const owner = visualNode("owner", "cut.visual.group", {});
  const path = visualNode("path", "cut.visual.path", {
    geometry: anchoredGeometry(anchor(owner.id, 10, 20), point(180, 160)),
  });
  const ir = runtime([owner, path]), decodedOnly = prepareReferenceAnchoredVectorPathNode(ir, path)!;
  assert.throws(
    () => referenceAnchoredVectorPathFrameResolutionAt(ir, path, decodedOnly, rational(0), ownerResolver()),
    /CUT_ANCHORED_PATH_VALIDATION/u,
  );
});

test("anchored Path morph is rejected by a stable runtime diagnostic", () => {
  const owner = visualNode("owner", "cut.visual.group", {});
  const geometry = anchoredGeometry(anchor(owner.id, 0, 0), point(100, 100));
  const path = visualNode("path", "cut.visual.path", {
    geometry,
    morphTo: geometry,
    morph: ratio(1, 2),
  });
  assert.throws(() => prepareReferenceAnchoredVectorPathNode(runtime([owner, path]), path), (error: unknown) => {
    assert.ok(error instanceof ReferenceVectorPathError);
    assert.equal(error.code, "CUT_ANCHORED_PATH_MORPH");
    assert.equal(error.source.nodeId, path.id);
    return true;
  });
});

test("anchored MotionPath exact preflight proves orientation and refuses all-hidden or inert tangents", () => {
  const owner = visualNode("owner", "cut.visual.group", {});
  const motion = visualNode("motion", "cut.visual.motion_path", {
    geometry: anchoredGeometry(anchor(owner.id, 0, 0), point(180, 160)),
    progress: ratio(1, 2),
    orientToPath: { kind: "boolean", value: true },
  });
  const ir = runtime([owner, motion]), plan = prepareReferenceAnchoredMotionPathNode(motion, validatedGeometry(motion))!;
  const sample = referenceAnchoredMotionPathResolutionAt(ir, composition(), motion, rational(0), plan, ownerResolver(), 0n);
  assert.equal(sample.status, "resolved");
  if (sample.status === "resolved") assert.ok(sample.sample.rotation > 0);
  const work = validateReferenceAnchoredMotionPathFrameStates(ir, composition(), motion, plan, ownerResolver());
  assert.equal(work.orientControlChanged, true);
  assert.deepEqual({ spatialPointFrames: work.spatialPointFrames, ownerSampleFrames: work.ownerSampleFrames }, { spatialPointFrames: 8, ownerSampleFrames: 4 });
  assert.throws(
    () => validateReferenceAnchoredMotionPathFrameStates(ir, composition(), motion, plan, ownerResolver("policy-hidden")),
    /CUT_MOTION_PATH_NOOP.*orientToPath/u,
  );

  const horizontal = { ...motion, id: "horizontal", inputs: {
    ...motion.inputs,
    geometry: anchoredGeometry(anchor(owner.id, 0, 0), point(180, 80)),
  } } satisfies IRNode;
  assert.throws(
    () => validateReferenceAnchoredMotionPathFrameStates(runtime([owner, horizontal]), composition(), horizontal, prepareReferenceAnchoredMotionPathNode(horizontal, validatedGeometry(horizontal))!, ownerResolver()),
    /CUT_MOTION_PATH_NOOP.*orientToPath/u,
  );
  assert.throws(
    () => validateReferenceAnchoredMotionPathCompositionWork([
      { node: motion, work: { authoredSegmentFrames: 1, spatialPointFrames: 1, ownerSampleFrames: 1, flattenedPointFrames: 24_000_001, resolvedFrames: 1, policyHiddenFrames: 0, orientControlChanged: true } },
      { node: motion, work: { authoredSegmentFrames: 1, spatialPointFrames: 1, ownerSampleFrames: 1, flattenedPointFrames: 24_000_001, resolvedFrames: 1, policyHiddenFrames: 0, orientControlChanged: true } },
    ]),
    /CUT_MOTION_PATH_LIMIT.*composition anchored MotionPath flattened point-frame work/u,
  );
});

test("retained Path chain keys cache by resolved spatial geometry and bypasses hidden owner policy", () => {
  const owner = visualNode("owner", "cut.visual.group", {});
  const path = visualNode("path", "cut.visual.path", {
    geometry: anchoredGeometry(anchor(owner.id, 10, 20), point(180, 160)),
    stroke: { kind: "color", value: "#ffffff" },
    width: px(2),
  });
  const ir = runtime([owner, path]), plan = prepareReferenceAnchoredVectorPathNode(ir, path, validatedGeometry(path))!;
  const chain = referenceRetainedPathChain(ir, path.id)!;
  const first = referenceRetainedPathChainExecutionAt(ir, composition(), chain, plan, rational(0), {
    resolveAnchoredPathOwner: ownerResolver("visible", "media-grade-plan-a"),
    outputFrame: 0n,
  });
  const opacityOnly = referenceRetainedPathChainExecutionAt(ir, composition(), chain, plan, rational(0), {
    resolveAnchoredPathOwner: ownerResolver("opacity-zero", "media-grade-plan-b"),
    outputFrame: 0n,
  });
  assert.equal(first.geometryIdentity, opacityOnly.geometryIdentity);
  assert.equal(first.cacheIdentity?.sha256, opacityOnly.cacheIdentity?.sha256);
  assert.equal(first.anchoredPathResolution?.status, "resolved");
  const hidden = referenceRetainedPathChainExecutionAt(ir, composition(), chain, plan, rational(0), {
    resolveAnchoredPathOwner: ownerResolver("policy-hidden"),
    outputFrame: 0n,
  });
  assert.equal(hidden.geometryPolicyHidden, true);
  assert.equal(hidden.anchoredPathResolution?.status, "policy-hidden");
  assert.deepEqual(hidden.work, { rasterPixels: 0, rgbaBytes: 0, pixelWork: 0 });
  assert.equal(hidden.vectorRasterizations, 0);
});

function publicRendererSource(ownerOpacity = "100%") {
  const opacityStatement = ownerOpacity === "100%" ? "" : `    set plate.opacity = ${ownerOpacity};\n`;
  return `cut 0.4;
project "public anchored renderer proof";
import { LocalSpace, Rect, Circle, Path, MotionPath, visualAnchor, anchoredLineTo, anchoredPath } from "cut:visual";
import { inOutCubic } from "@cut/motion";

component Plate() -> Visual {
  LocalSpace(width: 100px, height: 80px, origin: { x: 50px, y: 40px }) {
    Rect(width: 80px, height: 60px, fill: #294c73);
  }
}

timeline main(duration: 1s, fps: 24, width: 200px, height: 100px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Plate() as plate;
    set plate.y = 5px;
${opacityStatement}    animate plate.x from -30px to 30px over 1s ease inOutCubic;
    Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
        segments: [anchoredLineTo(to: { x: 185px, y: 50px })],
        closed: false
      ),
      stroke: #ffcc33,
      width: 3px
    );
    MotionPath(
      geometry: anchoredPath(
        start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
        segments: [anchoredLineTo(to: { x: 185px, y: 50px })],
        closed: false
      ),
      progress: 50%
    ) { Circle(radius: 4px, fill: #ff3b30); }
  }
}
export proof = render(main);`;
}

test("public anchored Path and MotionPath execute through one owner affine and publish exact frame evidence", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-anchored-render-"));
  const ir = compile(publicRendererSource()), session = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[session.composition.sceneIds[0]!]!;
    const first = await renderer.sceneFrame(scene, 0, false);
    const firstEvidence = renderer.referenceAnchoredPathEvidence();
    assert.equal(firstEvidence.length, 2);
    assert.ok(first.data.some((value) => value !== 0), "public anchored consumers must paint pixels");
    assert.deepEqual([...new Set(firstEvidence.map((item) => item.status))], ["resolved"]);
    assert.equal(new Set(firstEvidence.map((item) => item.authoredGeometryIdentity)).size, 1);
    assert.equal(new Set(firstEvidence.map((item) => item.geometryIdentity)).size, 1);
    const firstX = firstEvidence[0]!.anchors?.[0]?.compositionPoint.x;
    assert.equal(firstX, 70);

    await renderer.sceneFrame(scene, 12, false);
    const middleEvidence = renderer.referenceAnchoredPathEvidence();
    assert.equal(middleEvidence.length, 2);
    assert.equal(new Set(middleEvidence.map((item) => item.geometryIdentity)).size, 1);
    const middleX = middleEvidence[0]!.anchors?.[0]?.compositionPoint.x;
    assert.ok(typeof middleX === "number" && middleX > firstX!, "owner animation must move both route consumers through the resolved affine");
    assert.notEqual(middleEvidence[0]!.geometryIdentity, firstEvidence[0]!.geometryIdentity);
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("zero owner opacity hides owner pixels but preserves its anchored coordinate", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-anchored-opacity-"));
  const ir = compile(publicRendererSource("0%")), session = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[session.composition.sceneIds[0]!]!;
    const frame = await renderer.sceneFrame(scene, 0, false);
    const evidence = renderer.referenceAnchoredPathEvidence();
    assert.equal(evidence.length, 2);
    assert.deepEqual([...new Set(evidence.flatMap((item) => item.anchors?.map((anchor) => anchor.ownerStatus) ?? []))], ["opacity-zero"]);
    assert.ok(frame.data.some((value) => value !== 0), "anchored Path/MotionPath pixels must remain visible when only the owner opacity is zero");
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("retained MotionPath wrapper propagates the actual anchored resolution and hides its complete subject", () => {
  const owner = visualNode("owner", "cut.visual.group", {});
  const path = visualNode("path", "cut.visual.path", {
    geometry: vectorGeometry(point(-5, 0), point(5, 0)),
    stroke: { kind: "color", value: "#ffffff" },
    width: px(2),
  });
  const motion = {
    ...visualNode("motion", "cut.visual.motion_path", {
      geometry: anchoredGeometry(anchor(owner.id, 0, 0), point(180, 160)),
      progress: ratio(1, 2),
    }),
    children: [path.id],
  } satisfies IRNode;
  const ir = runtime([owner, path, motion]), pathPlan = prepareReferenceVectorPathNode(ir, path)!;
  const motionPlan = prepareReferenceAnchoredMotionPathNode(motion, validatedGeometry(motion))!;
  const chain = referenceRetainedPathChain(ir, motion.id)!;
  const resolved = referenceRetainedPathChainExecutionAt(ir, composition(), chain, pathPlan, rational(0), {
    resolveAnchoredMotionPath: () => motionPlan,
    resolveAnchoredPathOwner: ownerResolver(),
  });
  assert.equal(resolved.state.anchoredMotionPathResolution?.status, "resolved");
  const hidden = referenceRetainedPathChainExecutionAt(ir, composition(), chain, pathPlan, rational(0), {
    resolveAnchoredMotionPath: () => motionPlan,
    resolveAnchoredPathOwner: ownerResolver("policy-hidden"),
  });
  assert.equal(hidden.state.hidden, true);
  assert.equal(hidden.state.anchoredMotionPathResolution?.status, "policy-hidden");
  assert.equal(hidden.vectorRasterizations, 0);
});
