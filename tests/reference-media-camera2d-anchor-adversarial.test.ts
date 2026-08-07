import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Ajv from "ajv";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type {
  CutAVIR,
  IRComposition,
  IRNode,
} from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import {
  rational,
  rationalToNumber,
  type Rational,
} from "../lib/language/rational";
import {
  decodeReferenceAnchoredPathGeometry,
  ReferenceAnchoredPathError,
  resolveReferenceAnchoredPathGeometryAt,
  validateReferenceAnchoredPathGeometry,
  type ReferenceAnchoredPathOwnerResolution,
  type ReferenceAnchoredPathResolvedMediaCameraOwner,
} from "../lib/runtime/reference/anchored-path";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import {
  ReferenceMediaCamera2DError,
  admitReferenceMediaCamera2DSceneFrame,
  referenceMediaCamera2DAnchorPlanAt,
  referenceMediaCamera2DAnchorPlanFromFramePlan,
  referenceMediaCamera2DFramePlanAt,
  validateReferenceMediaCamera2DGraph,
  type ReferenceMediaCamera2DAnchorPlan,
  type ReferenceMediaCamera2DFramePlan,
  type ReferenceMediaCamera2DPlan,
} from "../lib/runtime/reference/media-camera2d";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function program(kind: "image" | "video" = "image", focusX = "25%") {
  const assetType = kind === "image" ? "ImageAsset" : "VideoAsset";
  const asset = kind === "image" ? 'image("assets/source.png")' : 'video("assets/source.mkv")';
  const leaf = kind === "image"
    ? 'Image(source: media, fit: "fill")'
    : 'Video(source: media, range: 0s..<1s, fit: "fill", endBehavior: "hold", inputColor: "linear-srgb")';
  return `cut 0.4;
project "MediaCamera2D anchor adversarial fixture";
import { Image, MediaCamera2D, Path, Video, visualAnchor, anchoredLineTo, anchoredPath } from "cut:visual";
asset media: ${assetType} = ${asset};
timeline main(duration: 1s, fps: 4, width: 16px, height: 12px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: ${focusX}, focusY: 40%, zoom: 1.25, opacity: 80%) as camera {
      ${leaf};
    }
    Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: camera, local: { x: 1px, y: 2px }),
        segments: [anchoredLineTo(to: visualAnchor(owner: camera, local: { x: 7px, y: 5px }))],
        closed: false
      ),
      stroke: #ffffff,
      width: 1px
    );
  }
}
export out = render(main, codec: "h264");`;
}

function shutterProgram() {
  return `cut 0.4;
project "MediaCamera2D anchor shutter-time proof";
import { Circle, MediaCamera2D, MotionBlur, MotionPath, Path, Video, visualAnchor, anchoredLineTo, anchoredPath } from "cut:visual";
asset media: VideoAsset = video("assets/source.mkv");
timeline main(duration: 1s, fps: 4, width: 16px, height: 12px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%, focusY: 40%, zoom: 1.25, opacity: 80%) as camera {
      Video(source: media, range: 0s..<1s, fit: "fill", endBehavior: "hold", inputColor: "linear-srgb");
    }
    MotionBlur(shutterAngle: 180deg, samples: 4) {
      Path(
        geometry: anchoredPath(
          start: visualAnchor(owner: camera, local: { x: 0px, y: 0px }),
          segments: [anchoredLineTo(to: visualAnchor(owner: camera, local: { x: 7px, y: 5px }))],
          closed: false
        ),
        stroke: #ffffff,
        width: 1px
      );
    }
    MotionBlur(shutterAngle: 180deg, samples: 4) {
      MotionPath(
        geometry: anchoredPath(
          start: visualAnchor(owner: camera, local: { x: 0px, y: 5px }),
          segments: [anchoredLineTo(to: visualAnchor(owner: camera, local: { x: 7px, y: 0px }))],
          closed: false
        ),
        progress: 50%
      ) {
        Circle(radius: 1px, fill: #ffcc00);
      }
    }
  }
}
export out = render(main, codec: "h264");`;
}

function compile(source: string) {
  const parsed = parseCutLanguage(source);
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
  const compiled = compileCutModule(parsed.module);
  assert.deepEqual(
    compiled.check.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(compiled.check.diagnostics),
  );
  return compiled.ir;
}

async function fixtureRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-media-camera2d-anchor-adversarial-"));
  await mkdir(resolve(root, "assets"));
  const pixels = Buffer.alloc(8 * 6 * 4);
  for (let index = 0; index < 8 * 6; index += 1) {
    pixels[index * 4] = (index * 29) % 256;
    pixels[index * 4 + 1] = (index * 47) % 256;
    pixels[index * 4 + 2] = 255 - (index * 13) % 256;
    pixels[index * 4 + 3] = 255;
  }
  await sharp(pixels, { raw: { width: 8, height: 6, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/source.png"));
  for (let frame = 0; frame < 4; frame += 1) {
    const videoPixels = Buffer.from(pixels);
    for (let index = 0; index < 8 * 6; index += 1) {
      videoPixels[index * 4] = (videoPixels[index * 4]! + frame * 31) % 256;
    }
    await sharp(videoPixels, { raw: { width: 8, height: 6, channels: 4 } })
      .png()
      .toFile(resolve(root, `assets/video-${frame}.png`));
  }
  await exec("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    "4",
    "-start_number",
    "0",
    "-i",
    resolve(root, "assets/video-%d.png"),
    "-vf",
    "format=bgra,setparams=range=full:color_primaries=bt709:color_trc=linear:colorspace=gbr",
    "-c:v",
    "ffv1",
    "-pix_fmt",
    "bgra",
    resolve(root, "assets/source.mkv"),
  ]);
  return root;
}

async function locked(root: string, source: string) {
  const ir = compile(source);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

function cameraState(ir: CutAVIR) {
  const composition = ir.compositions[0]!;
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d");
  assert.ok(camera);
  const plan = validateReferenceMediaCamera2DGraph(ir, composition).get(camera.id);
  assert.ok(plan);
  return { camera, composition, plan };
}

function pathState(ir: CutAVIR) {
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d");
  const path = Object.values(ir.nodes).find((node) => node.op === "cut.visual.path");
  assert.ok(camera);
  assert.ok(path);
  const geometry = decodeReferenceAnchoredPathGeometry(path, path.inputs.geometry, "geometry");
  return { camera, path, geometry };
}

function expectMediaPreflight(work: () => unknown, message: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceMediaCamera2DError);
    assert.equal(error.code, "CUT_MEDIA_CAMERA_PREFLIGHT");
    assert.match(error.message, message);
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });
}

function expectAnchorResolution(work: () => unknown, message: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceAnchoredPathError);
    assert.equal(error.code, "CUT_ANCHORED_PATH_RESOLUTION");
    assert.match(error.message, message);
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });
}

test("anchored Path and MotionPath under MotionBlur resolve shutter subframes without extra media decode, open, or resample", { timeout: 90_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, shutterProgram());
    const { composition } = validateReferenceSession(ir, "out");
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, ".cut", "media-anchor-shutter"),
    );
    try {
      await renderer.prepare();
      const surface = await renderer.sceneFrame(scene, 1, false);
      assert.ok(surface.data.some((value) => value !== 0));

      const media = renderer.referenceMediaCamera2DEvidence();
      assert.equal(media.length, 1, "the camera executes once at the current output-frame time");
      assert.deepEqual(media[0]!.exactTime, rational(1, 4));
      assert.deepEqual({
        sourceOpens: media[0]!.allocations.sourceOpens,
        readerPullAttempts: media[0]!.allocations.readerPullAttempts,
        decodedFramesRead: media[0]!.allocations.decodedFramesRead,
        geometricResampleCount: media[0]!.allocations.geometricResampleCount,
      }, {
        sourceOpens: 1,
        readerPullAttempts: 2,
        decodedFramesRead: 2,
        geometricResampleCount: 1,
      });

      const anchored = renderer.referenceAnchoredPathEvidence();
      const byConsumer = new Map<string, typeof anchored>();
      for (const item of anchored) {
        const values = byConsumer.get(item.consumerOp) ?? [];
        byConsumer.set(item.consumerOp, Object.freeze([...values, item]));
      }
      for (const consumerOp of ["cut.visual.path", "cut.visual.motion_path"] as const) {
        const receipts = byConsumer.get(consumerOp) ?? [];
        assert.equal(receipts.length, 4, `${consumerOp} must execute all four shutter samples`);
        assert.equal(
          new Set(receipts.map((receipt) => `${receipt.exactTime.numerator}/${receipt.exactTime.denominator}`)).size,
          4,
          `${consumerOp} must retain four distinct exact shutter times`,
        );
        assert.ok(
          receipts.every((receipt) => receipt.exactTime.denominator !== "1"
            && !(receipt.exactTime.numerator === "1" && receipt.exactTime.denominator === "4")),
          `${consumerOp} shutter evidence must not be relabeled as the current output-frame sample`,
        );
        assert.ok(receipts.every((receipt) => receipt.schema === "cut.reference.anchored-path-frame.v2"));
      }
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("anchor reuse accepts only the exact admitted frame-plan object and rejects clones, mutations, cross-plan receipts, and stale IR", { timeout: 60_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, program("image"));
    const { composition, plan } = cameraState(ir);
    const framePlan = referenceMediaCamera2DFramePlanAt(ir, composition, plan, rational(1, 2));
    assert.doesNotThrow(() => referenceMediaCamera2DAnchorPlanFromFramePlan(ir, plan, framePlan));

    const unchangedClone = structuredClone(framePlan);
    expectMediaPreflight(
      () => referenceMediaCamera2DAnchorPlanFromFramePlan(ir, plan, unchangedClone),
      /exact same-invocation|foreign|authority|frame plan/iu,
    );
    expectMediaPreflight(
      () => admitReferenceMediaCamera2DSceneFrame(
        ir,
        composition,
        plan.sceneId,
        rational(1, 2),
        [{ plan, framePlan: unchangedClone }],
      ),
      /exact authorized|cloned|forged|frame-plan/iu,
    );

    const mutations: Array<Readonly<{
      label: string;
      mutate: (clone: ReferenceMediaCamera2DFramePlan) => void;
    }>> = [
      {
        label: "Q16",
        mutate: (clone) => {
          (clone.geometry.sourceToDeliveryQ16 as { tx: string }).tx =
            String(BigInt(clone.geometry.sourceToDeliveryQ16.tx) + 1n);
        },
      },
      {
        label: "controls",
        mutate: (clone) => {
          (clone.controls as { focusX: number }).focusX += 0.125;
        },
      },
      {
        label: "time",
        mutate: (clone) => {
          (clone as { exactTime: Rational }).exactTime = rational(3, 4);
        },
      },
      {
        label: "status",
        mutate: (clone) => {
          (clone as { status: "visible" | "opacity-zero" }).status =
            clone.status === "visible" ? "opacity-zero" : "visible";
        },
      },
    ];
    for (const mutation of mutations) {
      const clone = structuredClone(framePlan);
      mutation.mutate(clone);
      expectMediaPreflight(
        () => referenceMediaCamera2DAnchorPlanFromFramePlan(ir, plan, clone),
        /exact same-invocation|foreign|authority|frame plan/iu,
      );
    }

    const otherIr = await locked(root, program("image", "75%"));
    const other = cameraState(otherIr);
    const otherFrame = referenceMediaCamera2DFramePlanAt(
      otherIr,
      other.composition,
      other.plan,
      rational(1, 2),
    );
    expectMediaPreflight(
      () => referenceMediaCamera2DAnchorPlanFromFramePlan(ir, plan, otherFrame),
      /exact same-invocation|foreign|authority|frame plan/iu,
    );

    const staleIr = structuredClone(ir);
    const staleCamera = staleIr.nodes[plan.cameraNodeId]!;
    staleCamera.inputs.focusX = {
      kind: "quantity",
      dimension: "ratio",
      unit: "ratio",
      magnitude: rational(3, 4),
    };
    expectMediaPreflight(
      () => referenceMediaCamera2DAnchorPlanFromFramePlan(staleIr, plan, framePlan),
      /changed after locked static planning|forged, detached, or stale/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function replaceStartX(path: IRNode, magnitude: Rational) {
  const geometry = path.inputs.geometry;
  assert.equal(geometry?.kind, "call");
  if (geometry?.kind !== "call") assert.fail("expected anchoredPath call");
  const start = geometry.named.start;
  assert.equal(start?.kind, "call");
  if (start?.kind !== "call") assert.fail("expected visualAnchor start");
  const local = start.named.local;
  assert.equal(local?.kind, "object");
  if (local?.kind !== "object") assert.fail("expected local Vec2");
  const x = local.entries.x;
  assert.equal(x?.kind, "quantity");
  if (x?.kind !== "quantity") assert.fail("expected exact px quantity");
  x.magnitude = magnitude;
}

test("locked source bounds compare exact Rational coordinates on both sides of each crop edge", { timeout: 60_000 }, async (t) => {
  const root = await fixtureRoot();
  try {
    const baseline = await locked(root, program("image"));
    const denominator = 1_000_000_000_000_000_000n;
    const lowerOutside = rational(-1n, denominator);
    const lowerInside = rational(1n, denominator);
    const upperInside = rational(7n * denominator - 1n, denominator);
    const upperOutside = rational(7n * denominator + 1n, denominator);
    assert.equal(
      rationalToNumber(upperInside),
      rationalToNumber(upperOutside),
      "the adversarial pair deliberately collapses to the same JavaScript Number",
    );

    const validateAt = (magnitude: Rational) => {
      const ir = structuredClone(baseline);
      const { path } = pathState(ir);
      replaceStartX(path, magnitude);
      const composition = ir.compositions[0]!;
      const plans = validateReferenceMediaCamera2DGraph(ir, composition);
      const geometry = decodeReferenceAnchoredPathGeometry(path, path.inputs.geometry, "geometry");
      return validateReferenceAnchoredPathGeometry(
        ir,
        composition,
        path,
        geometry,
        new Map(),
        plans,
      );
    };

    for (const [label, value] of [
      ["just inside lower edge", lowerInside],
      ["just inside upper edge", upperInside],
    ] as const) {
      await t.test(label, () => assert.doesNotThrow(() => validateAt(value)));
    }
    for (const [label, value] of [
      ["just below lower edge", lowerOutside],
      ["just above upper edge despite Number collapse", upperOutside],
    ] as const) {
      await t.test(label, () => {
        assert.throws(
          () => validateAt(value),
          (error: unknown) => {
            assert.ok(error instanceof ReferenceAnchoredPathError);
            assert.equal(error.code, "CUT_ANCHORED_PATH_RANGE");
            assert.match(error.message, /outside locked post-crop pixel-centre bounds/u);
            return true;
          },
        );
      });
    }
    assert.notEqual(
      validateAt(upperInside).validationIdentity,
      validateAt(rational(7)).validationIdentity,
      "distinct exact in-bounds Rational coordinates must not collapse to one validated semantic identity",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("anchor planning authenticates its static plan, locked resource, and composition snapshot", { timeout: 60_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, program("image"));
    const { composition, plan } = cameraState(ir);
    assert.doesNotThrow(() => referenceMediaCamera2DAnchorPlanAt(
      ir,
      composition,
      plan,
      rational(0),
    ));

    const forgedPlan = structuredClone(plan);
    (forgedPlan.decodedCrop as { width: number; pixels: number }).width += 1;
    (forgedPlan.decodedCrop as { width: number; pixels: number }).pixels =
      forgedPlan.decodedCrop.width * forgedPlan.decodedCrop.height;
    expectMediaPreflight(
      () => referenceMediaCamera2DAnchorPlanAt(ir, composition, forgedPlan, rational(0)),
      /static plan|authority|identity|forged|changed/iu,
    );

    const staleResourceIr = structuredClone(ir);
    const resource = staleResourceIr.resources[plan.source.resourceId]!;
    resource.sha256 = "0".repeat(64);
    expectMediaPreflight(
      () => referenceMediaCamera2DAnchorPlanAt(
        staleResourceIr,
        staleResourceIr.compositions[0]!,
        plan,
        rational(0),
      ),
      /resource|static plan|authority|identity|changed/iu,
    );

    const staleComposition = structuredClone(composition);
    staleComposition.width += 1;
    expectMediaPreflight(
      () => referenceMediaCamera2DAnchorPlanAt(
        ir,
        staleComposition,
        plan,
        rational(0),
      ),
      /composition|static plan|authority|identity|changed/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function mediaBinding(
  ir: CutAVIR,
  composition: IRComposition,
  plan: ReferenceMediaCamera2DPlan,
) {
  const { path, geometry } = pathState(ir);
  const validated = validateReferenceAnchoredPathGeometry(
    ir,
    composition,
    path,
    geometry,
    new Map(),
    new Map([[plan.cameraNodeId, plan]]),
  );
  return { path, validated };
}

function ownerResolution(
  anchor: ReferenceMediaCamera2DAnchorPlan,
): ReferenceAnchoredPathResolvedMediaCameraOwner {
  return Object.freeze({
    status: anchor.status,
    ownerNodeId: anchor.cameraNodeId,
    ownerKind: "media-camera-2d" as const,
    coordinatePlan: anchor,
    basis: anchor.basis,
    sourceToComposition: anchor.sourceToDelivery,
    affineIdentity: anchor.affineIdentity,
    ownerPlanIdentity: anchor.ownerPlanIdentity,
  });
}

test("exported anchored resolver authenticates media basis dimensions, owner id, basis hash, affine, and affine hash against validation", { timeout: 60_000 }, async (t) => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, program("image"));
    const { composition, plan } = cameraState(ir);
    const { path, validated } = mediaBinding(ir, composition, plan);
    const exactTime = rational(1, 2);
    const anchor = referenceMediaCamera2DAnchorPlanAt(ir, composition, plan, exactTime);
    const valid = ownerResolution(anchor);
    assert.doesNotThrow(() => resolveReferenceAnchoredPathGeometryAt(
      path,
      validated,
      exactTime,
      () => valid,
    ));

    const variants: Array<Readonly<{
      label: string;
      value: ReferenceAnchoredPathOwnerResolution;
    }>> = [
      {
        label: "basis width",
        value: {
          ...valid,
          basis: { ...anchor.basis, width: anchor.basis.width + 1 },
        },
      },
      {
        label: "basis height",
        value: {
          ...valid,
          basis: { ...anchor.basis, height: anchor.basis.height + 1 },
        },
      },
      {
        label: "basis semantic identity",
        value: {
          ...valid,
          basis: { ...anchor.basis, semanticIdentity: "0".repeat(64) },
        },
      },
      {
        label: "basis owner id",
        value: {
          ...valid,
          ownerNodeId: `${anchor.cameraNodeId}-forged`,
        },
      },
      {
        label: "source affine",
        value: {
          ...valid,
          sourceToComposition: {
            ...anchor.sourceToDelivery,
            tx: anchor.sourceToDelivery.tx + 1,
          },
        },
      },
      {
        label: "affine identity",
        value: {
          ...valid,
          affineIdentity: "0".repeat(64),
        },
      },
    ];
    for (const variant of variants) {
      await t.test(variant.label, () => {
        expectAnchorResolution(
          () => resolveReferenceAnchoredPathGeometryAt(
            path,
            validated,
            exactTime,
            () => variant.value,
          ),
          new RegExp(`MediaCamera2D|owner|basis|affine|${variant.label}`, "iu"),
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exported anchored resolver revokes an exact anchor plan after its bound IR or composition becomes stale", { timeout: 60_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, program("image"));
    const { camera, composition, plan } = cameraState(ir);
    const { path, validated } = mediaBinding(ir, composition, plan);
    const exactTime = rational(1, 2);
    const anchor = referenceMediaCamera2DAnchorPlanAt(ir, composition, plan, exactTime);
    const resolution = ownerResolution(anchor);
    const resolveAnchor = () => resolveReferenceAnchoredPathGeometryAt(
      path,
      validated,
      exactTime,
      () => resolution,
    );
    assert.doesNotThrow(resolveAnchor);

    const originalFocusX = camera.inputs.focusX;
    camera.inputs.focusX = {
      kind: "quantity",
      dimension: "ratio",
      unit: "ratio",
      magnitude: rational(3, 4),
    };
    expectAnchorResolution(resolveAnchor, /cloned, forged, stale, or wrong-time coordinate plan/iu);
    camera.inputs.focusX = originalFocusX;
    assert.doesNotThrow(resolveAnchor, "restoring the exact locked IR must restore the same-invocation authority");

    const originalWidth = composition.width;
    composition.width += 1;
    expectAnchorResolution(resolveAnchor, /cloned, forged, stale, or wrong-time coordinate plan/iu);
    composition.width = originalWidth;
    assert.doesNotThrow(resolveAnchor, "restoring the exact bound composition must restore authority");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("anchored-path frame v2 requires a real media anchor and rejects an all-v1 anchor relabel", { timeout: 60_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, program("image"));
    const manifest = await renderReferenceFrameArtifact(
      ir,
      root,
      resolve(root, "review", "media-anchor-schema.png"),
      { frame: 0 },
    );
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

    const allLegacy = structuredClone(manifest) as unknown as {
      execution: {
        anchoredPaths: Array<{
          schema: string;
          algorithmVersion?: string;
          anchors?: Array<Record<string, unknown>>;
        }>;
      };
    };
    const v2 = allLegacy.execution.anchoredPaths.find(
      (evidence) => evidence.schema === "cut.reference.anchored-path-frame.v2",
    );
    assert.ok(v2?.anchors?.length);
    for (const anchor of v2.anchors ?? []) {
      delete anchor.basisKind;
      delete anchor.basisNodeId;
      delete anchor.basisWidth;
      delete anchor.basisHeight;
      delete anchor.basisSemanticIdentity;
      anchor.localSpaceNodeId = "forged-legacy-local-space";
    }
    assert.equal(
      validate(allLegacy),
      false,
      "a v2 receipt cannot relabel every source-basis anchor as legacy LocalSpace",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
