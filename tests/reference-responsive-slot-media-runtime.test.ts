import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Ajv from "ajv";
import sharp from "sharp";
import { hash } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { cutMediaCamera2DResponsiveSlotContextInput } from "../lib/language/media-camera2d-contract";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  decodeReferenceAnchoredPathGeometry,
  validateReferenceAnchoredPathGeometry,
} from "../lib/runtime/reference/anchored-path";
import {
  referenceMediaCamera2DAnchorPlanAt,
  referenceMediaCamera2DFramePlanAt,
  validateReferenceMediaCamera2DGraph,
} from "../lib/runtime/reference/media-camera2d";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import {
  referenceResponsiveStackMediaPlacementAlgorithm,
  validateReferenceResponsiveStackGraph,
  validateReferenceResponsiveStackMediaFrameEvidence,
} from "../lib/runtime/reference/responsive-layout";
import {
  bindReferenceResponsiveSlotMediaAnchorFrameEvidence,
  referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame,
} from "../lib/runtime/reference/responsive-slot-media-anchor";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import { referenceReachableCompositionNodes, validateReferenceSession } from "../lib/runtime/reference/validate";
import { prepareReferenceVerifiedInputSession } from "../lib/runtime/reference/verified-input-session";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

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
  const result = compileCutModule(parsed.module);
  assert.deepEqual(
    result.check.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(result.check.diagnostics),
  );
  return result.ir;
}

function responsiveImageProgram(options: Readonly<{
  weights?: string;
  opacityAnimation?: boolean;
  anchorHost?: boolean;
}> = {}) {
  return `cut 0.4;
project "ResponsiveSlot native Image runtime proof";
import {
  Callout, CalloutLayer, Image, LocalSpace, MediaCamera2D, Path, Rect,
  ResponsiveSlot, ResponsiveStack, Vignette, anchoredLineTo, anchoredPath,
  responsiveStackPlan, visualAnchor
} from "cut:visual";
import { linear } from "@cut/motion";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    let plan = responsiveStackPlan(weights: [${options.weights ?? "2, 1"}], safeX: 0%, safeY: 0%, gap: 4px);
    ResponsiveStack(plan: plan) {
      ResponsiveSlot() {
        MediaCamera2D(focusX: 25%, focusY: 45%, zoom: 1.2${options.opacityAnimation ? ", opacity: 0%" : ""}) as camera {
          Vignette(amount: 30%, radius: 48%, softness: 60%, color: #101820) {
            Image(source: media, fit: "cover");
          }
        }
        animate camera.focusX from 25% to 75% over 1s ease linear;
        ${options.opacityAnimation ? "animate camera.opacity from 0% to 100% over 1s ease linear;" : ""}
      }
      ResponsiveSlot() {
        Rect(width: 20px, height: 36px, fill: #d85b45);
      }
    }
    ${options.anchorHost ? `Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: camera, local: { x: 2px, y: 2px }),
        segments: [anchoredLineTo(to: { x: 35px, y: 18px })],
        closed: false
      ),
      stroke: #ffffff,
      width: 1px
    );
    CalloutLayer() {
      Callout(
        anchor: visualAnchor(owner: camera, local: { x: 4px, y: 3px }),
        placements: ["right", "left"],
        offset: 2px,
        safeArea: 1px,
        leader: "straight",
        leaderColor: #ffffff,
        leaderWidth: 1px
      ) {
        LocalSpace(width: 8px, height: 4px, origin: { x: 0px, y: 0px }) {
          Rect(width: 8px, height: 4px, x: 4px, y: 2px, fill: #101820);
        }
      }
    }` : ""}
  }
}
export out = render(main, width: 64px, height: 36px, codec: "h264");`;
}

function responsiveVideoProgram() {
  return `cut 0.4;
project "ResponsiveSlot native Video runtime proof";
import {
  MediaCamera2D, Rect, ResponsiveSlot, ResponsiveStack, Video, responsiveStackPlan
} from "cut:visual";
asset media: VideoAsset = video("assets/source.mkv");
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    let plan = responsiveStackPlan(weights: [2, 1], safeX: 0%, safeY: 0%, gap: 4px);
    ResponsiveStack(plan: plan) {
      ResponsiveSlot() {
        MediaCamera2D(focusX: 35%, focusY: 55%, zoom: 1.15) {
          Video(source: media, range: 0s..<1s, fit: "cover", endBehavior: "hold", inputColor: "linear-srgb");
        }
      }
      ResponsiveSlot() {
        Rect(width: 20px, height: 36px, fill: #294d68);
      }
    }
  }
}
export out = render(main, width: 64px, height: 36px, codec: "h264");`;
}

function multiCompositionProgram() {
  const timeline = (
    id: string,
    width: number,
    height: number,
    weights: string,
    color: string,
  ) => `timeline ${id}(duration: 1s, fps: 4, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    let plan = responsiveStackPlan(weights: [${weights}], safeX: 0%, safeY: 0%, gap: 4px);
    ResponsiveStack(plan: plan) {
      ResponsiveSlot() {
        MediaCamera2D(focusX: 35%, zoom: 1.1) {
          Image(source: media, fit: "cover");
        }
      }
      ResponsiveSlot() {
        Rect(width: 12px, height: 12px, fill: ${color});
      }
    }
  }
}`;
  return `cut 0.4;
project "ResponsiveSlot multi-composition verified input";
import {
  Image, MediaCamera2D, Rect, ResponsiveSlot, ResponsiveStack, responsiveStackPlan
} from "cut:visual";
asset media: ImageAsset = image("assets/source.png");
${timeline("landscape", 64, 36, "2, 1", "#d85b45")}
${timeline("square", 48, 48, "1, 1", "#cfb85a")}
${timeline("portrait", 36, 64, "1, 2", "#4b7b9d")}
export landscapeProof = render(landscape, width: 64px, height: 36px, codec: "h264");
export squareProof = render(square, width: 48px, height: 48px, codec: "h264");
export portraitProof = render(portrait, width: 36px, height: 64px, codec: "h264");`;
}

function imagePixels() {
  const data = Buffer.alloc(8 * 6 * 4);
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 8; x += 1) {
    const offset = (y * 8 + x) * 4;
    data[offset] = (x * 41 + y * 17) % 256;
    data[offset + 1] = (255 - x * 19 + y * 7) % 256;
    data[offset + 2] = (x * 13 + y * 53) % 256;
    data[offset + 3] = 255;
  }
  return data;
}

async function imageFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-responsive-slot-media-"));
  await mkdir(resolve(root, "assets"));
  await sharp(imagePixels(), { raw: { width: 8, height: 6, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/source.png"));
  return root;
}

async function videoFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-responsive-slot-video-"));
  await mkdir(resolve(root, "assets"));
  for (let frame = 0; frame < 4; frame += 1) {
    const data = Buffer.alloc(8 * 6 * 4);
    for (let pixel = 0; pixel < 8 * 6; pixel += 1) {
      data[pixel * 4] = frame * 61;
      data[pixel * 4 + 1] = (pixel * 17 + frame * 29) % 256;
      data[pixel * 4 + 2] = 255 - frame * 47;
      data[pixel * 4 + 3] = 255;
    }
    await sharp(data, { raw: { width: 8, height: 6, channels: 4 } })
      .png()
      .toFile(resolve(root, `assets/frame-${frame}.png`));
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
    resolve(root, "assets/frame-%d.png"),
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

function rgbaSha256(surface: Readonly<{ data: Uint8Array }>) {
  return createHash("sha256").update(surface.data).digest("hex");
}

function pixel(surface: Readonly<{ data: Uint8Array; width: number }>, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function onlyCamera(ir: CutAVIR) {
  const cameras = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.media_camera2d");
  assert.equal(cameras.length, 1);
  return cameras[0]!;
}

function onlyStack(ir: CutAVIR) {
  const stacks = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.responsive_stack");
  assert.equal(stacks.length, 1);
  return stacks[0]!;
}

test("a public slot Image branch executes effects and camera controls directly on the quantized slot grid", { timeout: 90_000 }, async () => {
  const root = await imageFixture();
  try {
    const ir = await locked(root, responsiveImageProgram());
    const { composition } = validateReferenceSession(ir, "out");
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const camera = onlyCamera(ir);
    const stack = onlyStack(ir);
    const cameraPlan = validateReferenceMediaCamera2DGraph(ir, composition).get(camera.id);
    const stackPlan = validateReferenceResponsiveStackGraph(ir, composition).get(stack.id);
    assert.ok(cameraPlan);
    assert.ok(stackPlan);
    assert.equal(stackPlan.slots[0]?.mediaCamera2D?.cameraNodeId, camera.id);
    assert.equal(cameraPlan.outputContext.kind, "responsive-slot");
    if (cameraPlan.outputContext.kind !== "responsive-slot") return;
    assert.deepEqual(cameraPlan.output, { width: 40, height: 36, pixels: 1_440, rgbaBytes: 5_760 });
    assert.deepEqual(cameraPlan.outputContext.rasterSlot, {
      left: 0,
      top: 0,
      right: 40,
      bottom: 36,
      width: 40,
      height: 36,
    });
    assert.equal(cameraPlan.outputContext.stackNodeId, stack.id);
    assert.equal(cameraPlan.outputContext.slotNodeId, stackPlan.slots[0]?.slotNodeId);
    assert.equal(cameraPlan.outputContext.compilerContextIdentity, stackPlan.slots[0]?.mediaCamera2D?.compilerContext.contextIdentity);
    const framePlan = referenceMediaCamera2DFramePlanAt(ir, composition, cameraPlan, rational(0));
    assert.equal(framePlan.outputContext.semanticIdentity, cameraPlan.outputContext.semanticIdentity);
    assert.equal(framePlan.work.outputPixels, 40 * 36);
    assert.equal(framePlan.work.compositionPrerasterCount, 0);
    assert.equal(framePlan.work.geometricResampleCount, 1);

    const inspection = inspectCutIr(ir, "responsive-slot-media.cut");
    const inspected = inspection.graph.nodes.find((node) => node.id === camera.id) as unknown as {
      mediaCamera2D?: {
        framing?: { output?: { width: number; height: number }; outputContext?: { kind: string } };
        sampling?: {
          responsiveStackPlacement?: { algorithmVersion: string; geometricResampleCount: number; clip: string };
          visualAnchorComposition?: {
            status: string;
            coordinateChain: readonly string[];
            geometricResampleCount: number;
          };
        };
      };
    };
    assert.deepEqual(inspected.mediaCamera2D?.framing?.output, cameraPlan.output);
    assert.equal(inspected.mediaCamera2D?.framing?.outputContext?.kind, "responsive-slot");
    assert.deepEqual(inspected.mediaCamera2D?.sampling?.responsiveStackPlacement, {
      algorithmVersion: referenceResponsiveStackMediaPlacementAlgorithm,
      geometricResampleCount: 0,
      placementSurfaceCount: "zero-when-opacity-zero-otherwise-one",
      clip: "half-open-raster-slot",
      stackNodeId: stack.id,
      slotNodeId: stackPlan.slots[0]?.slotNodeId,
    });
    assert.deepEqual(
      inspected.mediaCamera2D?.sampling?.visualAnchorComposition?.coordinateChain,
      [
        "post-crop-source-pixel-centres",
        "responsive-slot-pixel-centres",
        "integer-slot-placement",
        "composition-pixel-centres",
      ],
    );
    assert.equal(
      inspected.mediaCamera2D?.sampling?.visualAnchorComposition?.status,
      "supported-exact-chain",
    );
    assert.equal(
      inspected.mediaCamera2D?.sampling?.visualAnchorComposition?.geometricResampleCount,
      0,
    );

    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "responsive-image"));
    try {
      await renderer.prepare();
      const first = await renderer.sceneFrame(scene, 0, false);
      const firstCamera = renderer.referenceMediaCamera2DEvidence();
      const firstStacks = renderer.referenceResponsiveStackEvidence();
      assert.equal(firstCamera.length, 1);
      assert.equal(firstStacks.length, 1);
      const cameraEvidence = firstCamera[0]!;
      const stackEvidence = firstStacks[0]!;
      const media = stackEvidence.slots[0]?.mediaCamera2D;
      assert.ok(media);
      assert.equal(cameraEvidence.outputContext.kind, "responsive-slot");
      assert.equal(cameraEvidence.outputContext.semanticIdentity, cameraPlan.outputContext.semanticIdentity);
      assert.equal(cameraEvidence.allocations.compositionPrerasterCount, 0);
      assert.equal(cameraEvidence.allocations.geometricResampleCount, 1);
      assert.equal(cameraEvidence.allocations.outputRgbaBytes, 40 * 36 * 4);
      assert.equal(cameraEvidence.work.outputPixels, 40 * 36);
      assert.equal(media.outputRgbaSha256, cameraEvidence.outputRgbaSha256);
      assert.equal(media.placement.algorithmVersion, referenceResponsiveStackMediaPlacementAlgorithm);
      assert.equal(media.placement.status, "placed");
      assert.equal(media.placement.geometricResampleCount, 0);
      assert.equal(media.placement.placementSurfaceCount, 1);
      assert.deepEqual(media.placement.destination, cameraPlan.outputContext.rasterSlot);
      assert.match(stackEvidence.outputRgbaSha256, /^[a-f0-9]{64}$/u);
      assert.deepEqual(pixel(first, 40, 10), [0, 0, 0, 0], "the exact gap after the camera slot remains transparent");
      assert.ok(stackEvidence.slots[0]!.visibleAlphaPixels > 0);
      assert.deepEqual(
        validateReferenceResponsiveStackMediaFrameEvidence(firstStacks, firstCamera),
        { responsiveStackCount: 1, claimedMediaCameraCount: 1 },
      );

      const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8")) as {
        definitions: Record<string, unknown>;
      };
      const ajv = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true });
      const validateCamera = ajv.compile({
        ...(schema.definitions.mediaCamera2DFrameEvidence as object),
        definitions: schema.definitions,
      });
      const validateStack = ajv.compile({
        ...(schema.definitions.responsiveStackFrameEvidence as object),
        definitions: schema.definitions,
      });
      assert.equal(validateCamera(cameraEvidence), true, JSON.stringify(validateCamera.errors));
      assert.equal(validateStack(stackEvidence), true, JSON.stringify(validateStack.errors));

      const second = await renderer.sceneFrame(scene, 2, false);
      const secondCamera = renderer.referenceMediaCamera2DEvidence()[0]!;
      const secondStack = renderer.referenceResponsiveStackEvidence()[0]!;
      assert.notEqual(secondCamera.framePlanIdentity, cameraEvidence.framePlanIdentity);
      assert.notEqual(secondCamera.controls.focusX, cameraEvidence.controls.focusX);
      assert.notEqual(secondStack.slots[0]?.tileIdentity, stackEvidence.slots[0]?.tileIdentity);
      assert.notEqual(rgbaSha256(second), rgbaSha256(first));
      assert.deepEqual(secondStack.slots[0]?.rasterSlot, stackEvidence.slots[0]?.rasterSlot);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified-input preparation isolates slot cameras to each of three active composition graphs", { timeout: 90_000 }, async () => {
  const root = await imageFixture();
  try {
    const ir = await locked(root, multiCompositionProgram());
    assert.equal(ir.compositions.length, 3);
    assert.equal(
      Object.values(ir.nodes).filter((node) => node.op === "cut.visual.media_camera2d").length,
      3,
    );
    const session = await prepareReferenceVerifiedInputSession(ir, root, "master");
    try {
      assert.equal(session.ir.compositions.length, 3);
      for (const outputName of ["landscapeProof", "squareProof", "portraitProof"]) {
        const { composition } = validateReferenceSession(session.ir, outputName);
        const cameras = validateReferenceMediaCamera2DGraph(
          session.ir,
          composition,
          referenceReachableCompositionNodes(session.ir, composition),
        );
        assert.equal(cameras.size, 1, `${outputName} must admit only its reachable slot camera`);
        const plan = [...cameras.values()][0]!;
        assert.equal(plan.outputContext.kind, "responsive-slot");
        if (plan.outputContext.kind !== "responsive-slot") continue;
        assert.equal(plan.outputContext.compositionId, composition.id);
      }
    } finally {
      await session.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public Path and Callout slot-camera anchors render and cross-bind the exact source-slot-composition chain", { timeout: 90_000 }, async () => {
  const root = await imageFixture();
  try {
    const ir = await locked(root, responsiveImageProgram({ anchorHost: true }));
    const { composition } = validateReferenceSession(ir, "out");
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const camera = onlyCamera(ir);
    const path = Object.values(ir.nodes).find((node) => node.op === "cut.visual.path");
    assert.ok(path);
    const geometry = decodeReferenceAnchoredPathGeometry(path, path.inputs.geometry, "geometry");
    const plans = validateReferenceMediaCamera2DGraph(ir, composition);
    const validated = validateReferenceAnchoredPathGeometry(
      ir,
      composition,
      path,
      geometry,
      new Map(),
      plans,
    );
    const binding = validated.ownerBindings.find((candidate) =>
      candidate.ownerNodeId === camera.id);
    assert.ok(binding && binding.ownerKind === "media-camera-2d");
    assert.ok(binding.responsiveSlotComposition);
    assert.equal(binding.responsiveSlotComposition.compositionId, composition.id);
    assert.equal(binding.responsiveSlotComposition.stackNodeId, onlyStack(ir).id);
    const cameraPlan = plans.get(camera.id);
    assert.ok(cameraPlan);
    const anchorPlan = referenceMediaCamera2DAnchorPlanAt(
      ir,
      composition,
      cameraPlan,
      rational(0),
    );
    assert.ok(anchorPlan.responsiveSlotComposition);
    assert.deepEqual(
      anchorPlan.responsiveSlotComposition.rasterSlot,
      binding.responsiveSlotComposition.rasterSlot,
    );
    assert.equal(
      anchorPlan.sourceToDeliveryQ16.tx,
      String(
        BigInt(anchorPlan.responsiveSlotComposition.sourceToSlotQ16.tx)
          + BigInt(anchorPlan.responsiveSlotComposition.slotToCompositionQ16.tx),
      ),
    );
    assert.equal(
      anchorPlan.sourceToDeliveryQ16.ty,
      String(
        BigInt(anchorPlan.responsiveSlotComposition.sourceToSlotQ16.ty)
          + BigInt(anchorPlan.responsiveSlotComposition.slotToCompositionQ16.ty),
      ),
    );

    const renderer = new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, ".cut", "responsive-anchor"),
    );
    try {
      await renderer.prepare();
      const surface = await renderer.sceneFrame(scene, 0, false);
      const cameras = renderer.referenceMediaCamera2DEvidence();
      const stacks = renderer.referenceResponsiveStackEvidence();
      const paths = renderer.referenceAnchoredPathEvidence();
      const callouts = renderer.referenceCalloutLayerEvidence();
      const links = renderer.referenceResponsiveSlotMediaAnchorEvidence();
      assert.deepEqual(
        [cameras.length, stacks.length, paths.length, callouts.length, links.length],
        [1, 1, 1, 1, 2],
      );
      assert.deepEqual(
        links.map((link) => link.consumerOp).sort(),
        ["cut.visual.callout", "cut.visual.path"],
      );
      const cameraReceipt = cameras[0]!;
      const stackReceipt = stacks[0]!;
      const placement = stackReceipt.slots[0]?.mediaCamera2D?.placement;
      assert.ok(placement);
      assert.equal(cameraReceipt.allocations.sourceOpens, 1);
      assert.equal(cameraReceipt.allocations.decodedSurfaces, 1);
      assert.equal(cameraReceipt.allocations.geometricResampleCount, 1);
      assert.equal(cameraReceipt.allocations.compositionPrerasterCount, 0);
      assert.equal(placement.geometricResampleCount, 0);
      assert.equal(placement.placementSurfaceCount, 1);
      for (const link of links) {
        assert.equal(link.cameraExecutionIdentity, cameraReceipt.executionIdentity);
        assert.equal(link.responsiveStackExecutionIdentity, stackReceipt.executionIdentity);
        assert.equal(link.responsivePlacementIdentity, placement.placementIdentity);
        assert.equal(link.geometricResampleCount, 0);
        assert.equal(link.clip, "half-open-raster-slot");
        assert.equal(
          link.sourceToCompositionQ16.tx,
          String(BigInt(link.sourceToSlotQ16.tx) + BigInt(link.slotToCompositionQ16.tx)),
        );
        assert.equal(
          link.sourceToCompositionQ16.ty,
          String(BigInt(link.sourceToSlotQ16.ty) + BigInt(link.slotToCompositionQ16.ty)),
        );
        const apply = (
          affine: typeof link.sourceToCompositionQ16,
          pointValue: Readonly<{ x: number; y: number }>,
        ) => ({
          x: (
            Number(affine.a) * pointValue.x
            + Number(affine.c) * pointValue.y
            + Number(affine.tx)
          ) / 65_536,
          y: (
            Number(affine.b) * pointValue.x
            + Number(affine.d) * pointValue.y
            + Number(affine.ty)
          ) / 65_536,
        });
        const exactSlotPoint = apply(link.sourceToSlotQ16, link.sourcePoint);
        const exactCompositionPoint = apply(link.sourceToCompositionQ16, link.sourcePoint);
        assert.ok(Math.abs(link.slotPoint.x - exactSlotPoint.x) <= 1e-9);
        assert.ok(Math.abs(link.slotPoint.y - exactSlotPoint.y) <= 1e-9);
        assert.ok(Math.abs(link.compositionPoint.x - exactCompositionPoint.x) <= 1e-9);
        assert.ok(Math.abs(link.compositionPoint.y - exactCompositionPoint.y) <= 1e-9);
        assert.ok(Math.abs(link.compositionPoint.x - (link.slotPoint.x + link.rasterSlot.left)) <= 1e-9);
        assert.ok(Math.abs(link.compositionPoint.y - (link.slotPoint.y + link.rasterSlot.top)) <= 1e-9);
      }
      assert.ok(
        links.some((link) => {
          const x = Math.round(link.compositionPoint.x);
          const y = Math.round(link.compositionPoint.y);
          if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return false;
          const [red, green, blue, alpha] = pixel(surface, x, y);
          return alpha > 0 && red > 180 && green > 180 && blue > 180;
        }),
        "at least one authored leader/path begins visibly at its exact resolved composition pixel",
      );

      assert.deepEqual(
        bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          composition.id,
          paths,
          callouts,
          cameras,
          stacks,
        ),
        links,
      );
      const forgedPaths = structuredClone(paths);
      const forgedPathAnchor = forgedPaths[0]?.anchors?.find((anchor) =>
        anchor.basisKind === "post-crop-source-pixel-centres"
        && anchor.responsiveSlotComposition);
      assert.ok(
        forgedPathAnchor?.basisKind === "post-crop-source-pixel-centres"
          && forgedPathAnchor.responsiveSlotComposition,
      );
      const forgedSlot = forgedPathAnchor.responsiveSlotComposition as unknown as {
        sourceToCompositionQ16: { tx: string };
      };
      forgedSlot.sourceToCompositionQ16.tx =
        String(BigInt(forgedSlot.sourceToCompositionQ16.tx) + 1n);
      assert.throws(
        () => bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          composition.id,
          forgedPaths,
          callouts,
          cameras,
          stacks,
        ),
        /CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY/u,
      );
      const crossedStacks = structuredClone(stacks);
      const crossedMedia = crossedStacks[0]?.slots[0]?.mediaCamera2D;
      assert.ok(crossedMedia);
      (crossedMedia as unknown as { cameraExecutionIdentity: string })
        .cameraExecutionIdentity = "0".repeat(64);
      assert.throws(
        () => bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          composition.id,
          paths,
          callouts,
          cameras,
          crossedStacks,
        ),
        /CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY/u,
      );
      assert.throws(
        () => bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          "foreign-composition",
          paths,
          callouts,
          cameras,
          stacks,
        ),
        /CUT_RESPONSIVE_SLOT_ANCHOR_IDENTITY/u,
      );

      const secondSurface = await renderer.sceneFrame(scene, 2, false);
      const secondLinks = renderer.referenceResponsiveSlotMediaAnchorEvidence();
      assert.equal(secondLinks.length, links.length);
      assert.notDeepEqual(
        secondLinks.map((link) => link.linkIdentity),
        links.map((link) => link.linkIdentity),
        "signal-driven camera framing must invalidate exact anchor/link identities",
      );
      assert.notDeepEqual(
        secondLinks.map((link) => link.compositionPoint),
        links.map((link) => link.compositionPoint),
        "signal-driven camera framing must move source anchors through the exact composed affine",
      );
      assert.notEqual(
        rgbaSha256(secondSurface),
        rgbaSha256(surface),
        "the rendered frame must change with the same camera signal that changed anchor geometry",
      );
      const completed = {
        paths: renderer.referenceAnchoredPathEvidence(),
        callouts: renderer.referenceCalloutLayerEvidence(),
        cameras: renderer.referenceMediaCamera2DEvidence(),
        stacks: renderer.referenceResponsiveStackEvidence(),
        links: secondLinks,
      };
      const responsiveContext =
        camera.inputs[cutMediaCamera2DResponsiveSlotContextInput];
      assert.ok(responsiveContext);
      delete camera.inputs[cutMediaCamera2DResponsiveSlotContextInput];
      await assert.rejects(
        renderer.sceneFrame(scene, 1, false),
        /CUT_MEDIA_CAMERA_PREFLIGHT.*executable content changed/u,
      );
      assert.deepEqual(renderer.referenceAnchoredPathEvidence(), completed.paths);
      assert.deepEqual(renderer.referenceCalloutLayerEvidence(), completed.callouts);
      assert.deepEqual(renderer.referenceMediaCamera2DEvidence(), completed.cameras);
      assert.deepEqual(renderer.referenceResponsiveStackEvidence(), completed.stacks);
      assert.deepEqual(renderer.referenceResponsiveSlotMediaAnchorEvidence(), completed.links);
      camera.inputs[cutMediaCamera2DResponsiveSlotContextInput] = responsiveContext;
    } finally {
      await renderer.closeAndWait();
    }

    const manifest = await renderReferenceFrameArtifact(
      ir,
      root,
      resolve(root, "review", "responsive-anchor.png"),
      { frame: 0, mediaProfile: "master" },
    );
    assert.equal(manifest.execution.responsiveSlotMediaAnchors?.length, 2);
    const schema = JSON.parse(
      await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"),
    ) as object;
    const ajv = new Ajv({
      schemaId: "auto",
      meta: false,
      validateSchema: false,
      allErrors: true,
      jsonPointers: true,
    });
    const validateFrame = ajv.compile(schema);
    assert.equal(validateFrame(manifest), true, JSON.stringify(validateFrame.errors));
    const unknownField = structuredClone(manifest) as typeof manifest & {
      execution: typeof manifest.execution & {
        responsiveSlotMediaAnchors: Array<Record<string, unknown>>;
      };
    };
    assert.ok(unknownField.execution.responsiveSlotMediaAnchors?.[0]);
    unknownField.execution.responsiveSlotMediaAnchors[0]!.invented = true;
    assert.equal(validateFrame(unknownField), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slot-camera visualAnchor rejects an exact source point outside the locked post-crop basis", { timeout: 60_000 }, async () => {
  const root = await imageFixture();
  try {
    const source = responsiveImageProgram({ anchorHost: true }).replace(
      "local: { x: 2px, y: 2px }",
      "local: { x: 8px, y: 2px }",
    );
    const ir = await locked(root, source);
    assert.throws(
      () => validateReferenceSession(ir, "out"),
      /CUT_ANCHORED_PATH_RANGE.*exact source point \(8\/1, 2\/1\).*\[0, 7\] x \[0, 5\]/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("responsive slot-camera anchor links enforce one aggregate 4096-link pre-map bound", { timeout: 120_000 }, async () => {
  const frameSchema = JSON.parse(
    await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"),
  ) as {
    properties: {
      execution: {
        properties: {
          responsiveSlotMediaAnchors: { maxItems: number };
        };
      };
    };
  };
  assert.equal(
    frameSchema.properties.execution.properties.responsiveSlotMediaAnchors.maxItems,
    referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame,
    "runtime admission and the closed frame-v2 ledger must share one aggregate bound",
  );
  const root = await imageFixture();
  try {
    const ir = await locked(root, responsiveImageProgram({ anchorHost: true }));
    const { composition } = validateReferenceSession(ir, "out");
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, ".cut", "responsive-anchor-limit"),
    );
    try {
      await renderer.prepare();
      await renderer.sceneFrame(scene, 0, false);
      const paths = renderer.referenceAnchoredPathEvidence();
      const callouts = renderer.referenceCalloutLayerEvidence();
      const cameras = renderer.referenceMediaCamera2DEvidence();
      const stacks = renderer.referenceResponsiveStackEvidence();
      const basePath = paths[0]!;
      assert.ok(basePath);
      assert.equal(callouts.length, 1);
      assert.equal(
        bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          composition.id,
          paths,
          callouts,
          cameras,
          stacks,
        ).length,
        2,
        "the fixture must contribute one Path and one Callout anchor link",
      );

      const {
        evidenceIdentity: basePathEvidenceIdentity,
        ...basePathBody
      } = basePath;
      assert.match(basePathEvidenceIdentity, /^[a-f0-9]{64}$/u);
      const exactPaths = Array.from(
        {
          length:
            referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame - 1,
        },
        (_, index): typeof basePath => {
          const body = Object.freeze({
            ...basePathBody,
            consumerNodeId: `limit-path-${String(index).padStart(4, "0")}`,
          });
          return Object.freeze({
            ...body,
            evidenceIdentity: hash(body),
          });
        },
      );
      const exact = bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
        composition.id,
        exactPaths,
        callouts,
        cameras,
        stacks,
      );
      assert.equal(
        exact.length,
        referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame,
      );
      assert.equal(
        exact.filter((link) => link.consumerOp === "cut.visual.callout").length,
        1,
        "the accepted boundary is aggregate across Path and Callout candidates",
      );
      assert.equal(
        new Set(exact.map((link) => link.linkIdentity)).size,
        referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame,
      );

      const bindingTrap = new Proxy(cameras, {
        get() {
          throw new Error("CUT_TEST_EXPENSIVE_BINDING_WAS_TOUCHED");
        },
      });
      assert.throws(
        () => bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          composition.id,
          Array(referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame)
            .fill(basePath),
          callouts,
          bindingTrap,
          stacks,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /^CUT_RESPONSIVE_SLOT_ANCHOR_LIMIT:/u);
          assert.match(error.message, /exceeds 4096 per composition frame/u);
          assert.doesNotMatch(
            error.message,
            /CUT_TEST_EXPENSIVE_BINDING_WAS_TOUCHED/u,
          );
          return true;
        },
        "4096 Path candidates plus one Callout must fail before receipt authentication or binding",
      );

      let oversizedReads = 0;
      const lazyOversizedPaths = Object.freeze({
        *[Symbol.iterator]() {
          for (let index = 0; index < 1_000_000; index += 1) {
            oversizedReads += 1;
            if (
              oversizedReads
              > referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame + 1
            ) {
              throw new Error("CUT_TEST_UNBOUNDED_CANDIDATE_READ");
            }
            yield basePath;
          }
        },
      }) as unknown as readonly typeof basePath[];
      assert.throws(
        () => bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          composition.id,
          lazyOversizedPaths,
          [],
          bindingTrap,
          stacks,
        ),
        /^Error: CUT_RESPONSIVE_SLOT_ANCHOR_LIMIT:/u,
      );
      assert.equal(
        oversizedReads,
        referenceResponsiveSlotMediaAnchorMaximumLinksPerCompositionFrame + 1,
        "a much larger hostile iterable must stop at the first over-limit candidate",
      );
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slot opacity-zero skips decode, affine, and outer placement while failed re-preflight preserves both completed ledgers", { timeout: 90_000 }, async () => {
  const root = await imageFixture();
  try {
    const ir = await locked(root, responsiveImageProgram({ opacityAnimation: true }));
    const { composition } = validateReferenceSession(ir, "out");
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "responsive-zero"));
    try {
      await renderer.prepare();
      await renderer.sceneFrame(scene, 0, false);
      const completedCamera = renderer.referenceMediaCamera2DEvidence();
      const completedStack = renderer.referenceResponsiveStackEvidence();
      const cameraEvidence = completedCamera[0]!;
      const media = completedStack[0]?.slots[0]?.mediaCamera2D;
      assert.ok(media);
      assert.equal(cameraEvidence.status, "opacity-zero");
      assert.deepEqual([
        cameraEvidence.allocations.sourceOpens,
        cameraEvidence.allocations.decodedSurfaces,
        cameraEvidence.allocations.geometricResampleCount,
      ], [0, 0, 0]);
      assert.equal(cameraEvidence.work.maximumDecodePixelWork, 0);
      assert.equal(cameraEvidence.work.maximumBilinearSampleVisits, 0);
      assert.equal(
        cameraEvidence.work.maximumPixelWork,
        cameraEvidence.work.outputPixels,
        "opacity-zero work is limited to producing the authenticated transparent slot surface",
      );
      assert.equal(media.placement.status, "skipped-opacity-zero");
      assert.equal(media.placement.placementSurfaceCount, 0);
      assert.equal(media.placement.placedRgbaSha256, undefined);
      assert.equal(completedStack[0]?.slots[0]?.visibleAlphaPixels, 0);
      assert.deepEqual(
        validateReferenceResponsiveStackMediaFrameEvidence(completedStack, completedCamera),
        { responsiveStackCount: 1, claimedMediaCameraCount: 1 },
      );

      const camera = onlyCamera(ir);
      delete camera.inputs[cutMediaCamera2DResponsiveSlotContextInput];
      await assert.rejects(
        renderer.sceneFrame(scene, 1, false),
        /CUT_MEDIA_CAMERA_PREFLIGHT.*executable content changed/u,
      );
      assert.deepEqual(
        renderer.referenceMediaCamera2DEvidence(),
        completedCamera,
        "a failed frame cannot replace the last completed native-camera ledger",
      );
      assert.deepEqual(
        renderer.referenceResponsiveStackEvidence(),
        completedStack,
        "a failed frame cannot replace the last completed responsive placement ledger",
      );
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slot geometry changes bind output, frame, raster, and cache identities instead of reusing composition-sized media work", { timeout: 60_000 }, async () => {
  const root = await imageFixture();
  try {
    const wide = await locked(root, responsiveImageProgram({ weights: "2, 1" }));
    const narrow = await locked(root, responsiveImageProgram({ weights: "1, 2" }));
    const wideComposition = wide.compositions[0]!;
    const narrowComposition = narrow.compositions[0]!;
    const widePlan = validateReferenceMediaCamera2DGraph(wide, wideComposition).get(onlyCamera(wide).id)!;
    const narrowPlan = validateReferenceMediaCamera2DGraph(narrow, narrowComposition).get(onlyCamera(narrow).id)!;
    const wideFrame = referenceMediaCamera2DFramePlanAt(wide, wideComposition, widePlan, rational(0));
    const narrowFrame = referenceMediaCamera2DFramePlanAt(narrow, narrowComposition, narrowPlan, rational(0));
    assert.deepEqual([widePlan.output.width, widePlan.output.height], [40, 36]);
    assert.deepEqual([narrowPlan.output.width, narrowPlan.output.height], [20, 36]);
    assert.notEqual(widePlan.outputContext.semanticIdentity, narrowPlan.outputContext.semanticIdentity);
    assert.notEqual(widePlan.semanticIdentity, narrowPlan.semanticIdentity);
    assert.notEqual(wideFrame.outputContext.semanticIdentity, narrowFrame.outputContext.semanticIdentity);
    assert.notEqual(wideFrame.rasterPlan?.semanticIdentity, narrowFrame.rasterPlan?.semanticIdentity);
    assert.notEqual(wideFrame.planIdentity, narrowFrame.planIdentity);
    assert.notEqual(wideFrame.work.outputPixels, narrowFrame.work.outputPixels);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a public slot Video branch preserves locked cadence and executes moving native frames on the slot grid", { timeout: 120_000 }, async () => {
  const root = await videoFixture();
  try {
    const canonical = await locked(root, responsiveVideoProgram());
    const ir = selectReferenceMediaProfile(canonical, "master").ir;
    const { composition } = validateReferenceSession(ir, "out");
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const cameraPlan = validateReferenceMediaCamera2DGraph(ir, composition).get(onlyCamera(ir).id)!;
    assert.equal(cameraPlan.leafKind, "video");
    assert.equal(cameraPlan.outputContext.kind, "responsive-slot");
    assert.deepEqual(cameraPlan.output, { width: 40, height: 36, pixels: 1_440, rgbaBytes: 5_760 });
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "responsive-video"));
    try {
      await renderer.prepare();
      const frameHashes: string[] = [];
      for (const frame of [0, 1, 2, 3]) {
        const surface = await renderer.sceneFrame(scene, frame, false);
        const camera = renderer.referenceMediaCamera2DEvidence()[0]!;
        const stack = renderer.referenceResponsiveStackEvidence()[0]!;
        const media = stack.slots[0]?.mediaCamera2D;
        assert.ok(media);
        assert.equal(camera.leafKind, "video");
        assert.equal(camera.source.selectedVariant, "master");
        assert.match(camera.source.cadenceIdentity ?? "", /^[a-f0-9]{64}$/u);
        assert.equal(camera.allocations.geometricResampleCount, 1);
        assert.equal(camera.allocations.compositionPrerasterCount, 0);
        assert.equal(camera.allocations.outputRgbaBytes, 40 * 36 * 4);
        assert.equal(media.placement.geometricResampleCount, 0);
        assert.equal(media.placement.placementSurfaceCount, 1);
        assert.deepEqual(
          validateReferenceResponsiveStackMediaFrameEvidence([stack], [camera]),
          { responsiveStackCount: 1, claimedMediaCameraCount: 1 },
        );
        frameHashes.push(rgbaSha256(surface));
      }
      assert.equal(new Set(frameHashes).size, 4, "locked moving Video frames must not collapse to one slot tile");
      assert.deepEqual(renderer.referenceVideoDecoderEvidence().map((entry) => entry.mode), [
        "retained-native-crop-cfr-frame-index",
      ]);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
