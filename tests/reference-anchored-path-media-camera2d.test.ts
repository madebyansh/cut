import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import sharp from "sharp";
import { cutAnchoredSpatialOps } from "../lib/language/anchored-path-contract";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRValue } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  decodeReferenceAnchoredPathGeometry,
  ReferenceAnchoredPathError,
  referenceMediaCamera2DAnchoredPathAlgorithmVersion,
  resolveReferenceAnchoredPathGeometryAt,
  validateReferenceAnchoredPathGeometry,
} from "../lib/runtime/reference/anchored-path";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import type {
  ReferenceLocalSpaceConfig,
  ReferenceLocalSpacePlacement,
} from "../lib/runtime/reference/local-space";
import {
  referenceMediaCamera2DAnchorPlanAt,
  validateReferenceMediaCamera2DGraph,
} from "../lib/runtime/reference/media-camera2d";

function source(
  startX = "1.5px",
  startY = "2.25px",
  zeroAtHalf = false,
) {
  return `cut 0.4;
project "MediaCamera2D anchored path runtime proof";
import { Image, MediaCamera2D, Path, visualAnchor, anchoredLineTo, anchoredCubicTo, anchoredPath } from "cut:visual";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 16px, height: 12px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%, focusY: 40%, zoom: 1.25, opacity: 80%) as camera {
      Image(source: media, fit: "fill");
    }
    ${zeroAtHalf ? "at 500ms { set camera.opacity = 0%; }" : ""}
    Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: camera, local: { x: ${startX}, y: ${startY} }),
        segments: [
          anchoredLineTo(to: visualAnchor(owner: camera, local: { x: 7px, y: 0px })),
          anchoredCubicTo(
            control1: visualAnchor(owner: camera, local: { x: 0px, y: 0px }),
            control2: { x: 8px, y: 6px },
            to: visualAnchor(owner: camera, local: { x: 7px, y: 5px })
          )
        ],
        closed: false
      ),
      stroke: #ffffff,
      width: 1px
    );
  }
}
export out = render(main, codec: "h264");`;
}

function compile(text: string) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(
    checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(checked.diagnostics),
  );
  return compileCutModule(parsed.module).ir;
}

async function fixtureRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-anchored-media-camera2d-"));
  await mkdir(resolve(root, "assets"));
  const pixels = Buffer.alloc(8 * 6 * 4);
  for (let index = 0; index < 8 * 6; index += 1) {
    pixels[index * 4] = (index * 41) % 256;
    pixels[index * 4 + 1] = 255 - (index * 23) % 256;
    pixels[index * 4 + 2] = (index * 67) % 256;
    pixels[index * 4 + 3] = 255;
  }
  await sharp(pixels, { raw: { width: 8, height: 6, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/source.png"));
  return root;
}

async function locked(root: string, text: string) {
  const ir = compile(text);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

function nodes(ir: CutAVIR) {
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d");
  const path = Object.values(ir.nodes).find((node) => node.op === "cut.visual.path");
  assert.ok(camera);
  assert.ok(path);
  return { camera, path };
}

function decoded(ir: CutAVIR) {
  const { path } = nodes(ir);
  return {
    path,
    geometry: decodeReferenceAnchoredPathGeometry(path, path.inputs.geometry, "geometry"),
  };
}

function ownerResolution(
  ownerNodeId: string,
  anchorPlan: ReturnType<typeof referenceMediaCamera2DAnchorPlanAt>,
  ownerPlanIdentity = anchorPlan.ownerPlanIdentity,
) {
  return {
    status: anchorPlan.status,
    ownerNodeId,
    ownerKind: "media-camera-2d" as const,
    coordinatePlan: anchorPlan,
    basis: anchorPlan.basis,
    sourceToComposition: anchorPlan.sourceToDelivery,
    affineIdentity: anchorPlan.affineIdentity,
    ownerPlanIdentity,
  };
}

test("validation binds a locked MediaCamera2D post-crop basis without manufacturing LocalSpace", { timeout: 30_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, source());
    const composition = ir.compositions[0]!;
    const { camera } = nodes(ir);
    const { path, geometry } = decoded(ir);
    const plans = validateReferenceMediaCamera2DGraph(ir, composition);
    const cameraPlan = plans.get(camera.id);
    assert.ok(cameraPlan);
    const validated = validateReferenceAnchoredPathGeometry(
      ir,
      composition,
      path,
      geometry,
      new Map(),
      plans,
    );
    assert.equal(validated.resolutionAlgorithmVersion, referenceMediaCamera2DAnchoredPathAlgorithmVersion);
    assert.deepEqual(validated.ownerBindings, [{
      ownerNodeId: camera.id,
      ownerKind: "media-camera-2d",
      basisKind: "post-crop-source-pixel-centres",
      basisNodeId: camera.id,
      basisWidth: 8,
      basisHeight: 6,
      basisSemanticIdentity: validated.ownerBindings[0] && "basisSemanticIdentity" in validated.ownerBindings[0]
        ? validated.ownerBindings[0].basisSemanticIdentity
        : assert.fail("expected MediaCamera2D binding"),
    }]);
    assert.equal(
      Object.values(ir.nodes).some((node) => node.op === "cut.visual.local_space"),
      false,
      "source media pixels are the basis; a fake retained tile is forbidden",
    );
    assert.equal(cameraPlan.decodedCrop.width, 8);
    assert.equal(cameraPlan.decodedCrop.height, 6);

    assert.throws(
      () => validateReferenceAnchoredPathGeometry(ir, composition, path, geometry, new Map()),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceAnchoredPathError);
        assert.equal(error.code, "CUT_ANCHORED_PATH_GRAPH");
        assert.equal(error.source.nodeId, path.id);
        assert.match(error.message, /no matching locked source-coordinate plan/u);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact camera affine resolves fractional pixels and all four post-crop corners with media-basis evidence", { timeout: 30_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, source());
    const composition = ir.compositions[0]!;
    const { camera } = nodes(ir);
    const { path, geometry } = decoded(ir);
    const plans = validateReferenceMediaCamera2DGraph(ir, composition);
    const cameraPlan = plans.get(camera.id);
    assert.ok(cameraPlan);
    const validated = validateReferenceAnchoredPathGeometry(
      ir,
      composition,
      path,
      geometry,
      new Map(),
      plans,
    );
    const exactTime = rational(1, 2);
    const anchorPlan = referenceMediaCamera2DAnchorPlanAt(
      ir,
      composition,
      cameraPlan,
      exactTime,
    );
    const result = resolveReferenceAnchoredPathGeometryAt(
      path,
      validated,
      exactTime,
      (ownerNodeId) => ownerResolution(ownerNodeId, anchorPlan),
      2n,
    );
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") assert.fail("unexpected policy-hidden result");
    assert.equal(result.algorithmVersion, referenceMediaCamera2DAnchoredPathAlgorithmVersion);
    assert.deepEqual(result.geometry, {
      start: { x: 6.875, y: 6.125 },
      segments: [
        { kind: "line", to: { x: 20.625, y: 0.5 } },
        {
          kind: "cubic",
          control1: { x: 3.125, y: 0.5 },
          control2: { x: 8, y: 6 },
          to: { x: 20.625, y: 13 },
        },
      ],
      closed: false,
    });
    assert.deepEqual(
      result.anchors.map((anchor) => ({
        localPoint: anchor.localPoint,
        compositionPoint: anchor.compositionPoint,
      })),
      [
        { localPoint: { x: 1.5, y: 2.25 }, compositionPoint: { x: 6.875, y: 6.125 } },
        { localPoint: { x: 7, y: 0 }, compositionPoint: { x: 20.625, y: 0.5 } },
        { localPoint: { x: 0, y: 0 }, compositionPoint: { x: 3.125, y: 0.5 } },
        { localPoint: { x: 7, y: 5 }, compositionPoint: { x: 20.625, y: 13 } },
      ],
    );
    for (const anchor of result.anchors) {
      assert.equal(anchor.ownerNodeId, camera.id);
      assert.equal(anchor.ownerStatus, "visible");
      assert.equal(anchor.affineIdentity, anchorPlan.affineIdentity);
      assert.equal(anchor.ownerPlanIdentity, anchorPlan.ownerPlanIdentity);
      assert.equal("localSpaceNodeId" in anchor, false);
      assert.equal(anchor.basisKind, "post-crop-source-pixel-centres");
      assert.equal(anchor.basisNodeId, camera.id);
      assert.equal(anchor.basisWidth, 8);
      assert.equal(anchor.basisHeight, 6);
      assert.equal(anchor.basisSemanticIdentity, anchorPlan.basis.semanticIdentity);
    }
    assert.match(result.geometryIdentity, /^[0-9a-f]{64}$/u);
    assert.match(result.executionIdentity, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locked post-crop bounds reject globally legal but source-impossible anchor coordinates before rendering", { timeout: 30_000 }, async () => {
  const root = await fixtureRoot();
  try {
    for (const [x, y, pattern] of [
      ["7.5px", "2px", /exact source point \(15\/2, 2\/1\).*bounds \[0, 7\] x \[0, 5\]/u],
      ["2px", "5.25px", /exact source point \(2\/1, 21\/4\).*bounds \[0, 7\] x \[0, 5\]/u],
    ] as const) {
      const ir = await locked(root, source(x, y));
      const composition = ir.compositions[0]!;
      const { path, geometry } = decoded(ir);
      const plans = validateReferenceMediaCamera2DGraph(ir, composition);
      assert.throws(
        () => validateReferenceAnchoredPathGeometry(
          ir,
          composition,
          path,
          geometry,
          new Map(),
          plans,
        ),
        (error: unknown) => {
          assert.ok(error instanceof ReferenceAnchoredPathError);
          assert.equal(error.code, "CUT_ANCHORED_PATH_RANGE");
          assert.equal(error.source.nodeId, path.id);
          assert.match(error.message, pattern);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opacity-zero and audit-only owner receipts preserve coordinate/cache identity but remain visible in evidence", { timeout: 30_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const resolveProgram = async (text: string) => {
      const ir = await locked(root, text);
      const composition = ir.compositions[0]!;
      const { camera, path } = nodes(ir);
      const { geometry } = decoded(ir);
      const plans = validateReferenceMediaCamera2DGraph(ir, composition);
      const cameraPlan = plans.get(camera.id);
      assert.ok(cameraPlan);
      const validated = validateReferenceAnchoredPathGeometry(
        ir,
        composition,
        path,
        geometry,
        new Map(),
        plans,
      );
      const anchorPlan = referenceMediaCamera2DAnchorPlanAt(
        ir,
        composition,
        cameraPlan,
        rational(3, 4),
      );
      const resolved = resolveReferenceAnchoredPathGeometryAt(
        path,
        validated,
        rational(3, 4),
        (ownerNodeId) => ownerResolution(ownerNodeId, anchorPlan),
      );
      assert.equal(resolved.status, "resolved");
      if (resolved.status !== "resolved") assert.fail("unexpected policy-hidden result");
      return { resolved, anchorPlan, path, validated };
    };

    const visible = await resolveProgram(source());
    const hidden = await resolveProgram(source("1.5px", "2.25px", true));
    assert.equal(visible.anchorPlan.status, "visible");
    assert.equal(hidden.anchorPlan.status, "opacity-zero");
    assert.equal(hidden.anchorPlan.affineIdentity, visible.anchorPlan.affineIdentity);
    assert.notEqual(hidden.anchorPlan.ownerPlanIdentity, visible.anchorPlan.ownerPlanIdentity);
    assert.deepEqual(hidden.resolved.geometry, visible.resolved.geometry);
    assert.equal(hidden.resolved.geometryIdentity, visible.resolved.geometryIdentity);
    assert.equal(hidden.resolved.executionIdentity, visible.resolved.executionIdentity);
    assert.ok(hidden.resolved.anchors.every((anchor) => anchor.ownerStatus === "opacity-zero"));

    const changedAuditOnly = resolveReferenceAnchoredPathGeometryAt(
      visible.path,
      visible.validated,
      rational(3, 4),
      (ownerNodeId) => ownerResolution(ownerNodeId, visible.anchorPlan, "audit-only-owner-receipt-b"),
    );
    assert.equal(changedAuditOnly.status, "resolved");
    if (changedAuditOnly.status !== "resolved") assert.fail("unexpected policy-hidden result");
    assert.equal(changedAuditOnly.geometryIdentity, visible.resolved.geometryIdentity);
    assert.equal(changedAuditOnly.executionIdentity, visible.resolved.executionIdentity);
    assert.notEqual(
      changedAuditOnly.anchors[0]?.ownerPlanIdentity,
      visible.resolved.anchors[0]?.ownerPlanIdentity,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed frame evidence publishes the closed media-camera anchored-path v2 receipt", { timeout: 60_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, source());
    const manifest = await renderReferenceFrameArtifact(
      ir,
      root,
      resolve(root, "review", "media-anchor.png"),
      { frame: 0 },
    );
    const evidence = manifest.execution.anchoredPaths;
    assert.ok(evidence);
    assert.equal(evidence.length, 1);
    const path = evidence[0]!;
    assert.equal(path.schema, "cut.reference.anchored-path-frame.v2");
    assert.equal(path.algorithmVersion, referenceMediaCamera2DAnchoredPathAlgorithmVersion);
    assert.equal(path.consumerOp, "cut.visual.path");
    assert.equal(path.status, "resolved");
    assert.equal(path.outputFrame, "0");
    assert.equal(path.anchors?.length, 4);
    for (const anchor of path.anchors ?? []) {
      assert.equal(anchor.basisKind, "post-crop-source-pixel-centres");
      assert.equal(anchor.basisWidth, 8);
      assert.equal(anchor.basisHeight, 6);
      assert.equal("localSpaceNodeId" in anchor, false);
    }
    assert.match(path.geometryIdentity ?? "", /^[0-9a-f]{64}$/u);
    assert.match(path.executionIdentity, /^[0-9a-f]{64}$/u);
    assert.match(path.evidenceIdentity, /^[0-9a-f]{64}$/u);

    const schema = JSON.parse(
      await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"),
    );
    const validate = new Ajv({
      schemaId: "auto",
      meta: false,
      validateSchema: false,
      allErrors: true,
      jsonPointers: true,
    }).compile(schema);
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

    const legacyLie = structuredClone(manifest) as unknown as {
      execution: { anchoredPaths: Array<Record<string, unknown>> };
    };
    legacyLie.execution.anchoredPaths[0]!.schema = "cut.reference.anchored-path-frame.v1";
    delete legacyLie.execution.anchoredPaths[0]!.algorithmVersion;
    assert.equal(
      validate(legacyLie),
      false,
      "media-source basis evidence cannot be relabeled as legacy LocalSpace evidence",
    );
    const mixedBasis = structuredClone(manifest) as unknown as {
      execution: { anchoredPaths: Array<{ anchors: Array<Record<string, unknown>> }> };
    };
    mixedBasis.execution.anchoredPaths[0]!.anchors[0]!.localSpaceNodeId = "forged-local";
    assert.equal(validate(mixedBasis), false, "one anchor cannot claim two coordinate bases");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const px = (value: number): IRValue => ({
  kind: "quantity",
  dimension: "length",
  unit: "px",
  magnitude: rational(value),
});
const point = (x: number, y: number): IRValue => ({
  kind: "object",
  entries: { x: px(x), y: px(y) },
});
const call = (op: string, named: Record<string, IRValue>): IRValue => ({
  kind: "call",
  op,
  positional: [],
  named,
  effect: "pure",
});

test("the established LocalSpace resolver branch keeps its signed authored-point semantics", () => {
  const ir = compile(source());
  const { path } = nodes(ir);
  const geometry = decodeReferenceAnchoredPathGeometry(
    path,
    call(cutAnchoredSpatialOps.anchoredPath, {
      start: call(cutAnchoredSpatialOps.visualAnchor, {
        owner: { kind: "node-ref", id: "legacy-owner" },
        local: point(2, 3),
      }),
      segments: {
        kind: "array",
        items: [call(cutAnchoredSpatialOps.anchoredLineTo, { to: point(50, 50) })],
      },
      closed: { kind: "boolean", value: false },
    }),
    "geometry",
  );
  const localSpace = Object.freeze({
    nodeId: "legacy-local",
    width: 20,
    height: 10,
    origin: Object.freeze({ x: rational(10), y: rational(5) }),
    rasterOriginQ16: Object.freeze({ x: String(10 * 65_536), y: String(5 * 65_536) }),
    view: Object.freeze({
      minX: rational(-10),
      minY: rational(-5),
      maxX: rational(10),
      maxY: rational(5),
    }),
    childIds: Object.freeze([]),
    nestingDepth: 1,
    estimatedPixelPassesPerFrame: 0,
    preparedTracePointsPerFrame: 0,
    owner: "component-fragment" as const,
    ownerNodeId: "legacy-owner",
    semanticIdentity: "legacy-local-basis",
    localCompositing: Object.freeze({}),
  }) as unknown as ReferenceLocalSpaceConfig;
  const placement: ReferenceLocalSpacePlacement = Object.freeze({
    owner: "component-fragment",
    contextIdentity: "legacy-content",
    destinationX: 100,
    destinationY: 50,
    registrationRasterX: 10,
    registrationRasterY: 5,
    scale: 1,
    skewX: 0,
    skewY: 0,
    rotation: 0,
    opacity: 1,
  });
  const result = resolveReferenceAnchoredPathGeometryAt(
    path,
    geometry,
    rational(1, 2),
    (ownerNodeId) => ({
      status: "visible",
      ownerNodeId,
      localSpace,
      placement,
      ownerPlanIdentity: "legacy-owner-plan",
    }),
  );
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") assert.fail("unexpected policy-hidden result");
  assert.equal("algorithmVersion" in result, false, "legacy v1 wire stays unchanged");
  assert.deepEqual(result.geometry.start, { x: 102, y: 53 });
  assert.deepEqual(result.geometry.segments, [{ kind: "line", to: { x: 50, y: 50 } }]);
  assert.deepEqual(result.anchors, [{
    occurrence: 0,
    ownerNodeId: "legacy-owner",
    ownerStatus: "visible",
    localPoint: { x: 2, y: 3 },
    compositionPoint: { x: 102, y: 53 },
    affineIdentity: result.anchors[0]?.affineIdentity,
    ownerPlanIdentity: "legacy-owner-plan",
    localSpaceNodeId: "legacy-local",
  }]);
});
