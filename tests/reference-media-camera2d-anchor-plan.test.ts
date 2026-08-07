import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  referenceMediaCamera2DAnchorAlgorithmVersion,
  referenceMediaCamera2DAnchorPlanAt,
  referenceMediaCamera2DAnchorPlanFromFramePlan,
  referenceMediaCamera2DFramePlanAt,
  validateReferenceMediaCamera2DGraph,
  type ReferenceMediaCamera2DAnchorPlan,
} from "../lib/runtime/reference/media-camera2d";

const exec = promisify(execFile);
const q16 = 65_536;

type ProgramOptions = Readonly<{
  kind?: "image" | "video";
  opacity?: string;
  edge?: "transparent" | "clamp";
  grade?: boolean;
  focusX?: string;
  focusY?: string;
  zoom?: string;
  rotation?: string;
  zeroAtHalf?: boolean;
}>;

function program(options: ProgramOptions = {}) {
  const kind = options.kind ?? "image";
  const leaf = kind === "image"
    ? `Image(source: media, fit: "fill")`
    : `Video(source: media, range: 0s..<1s, fit: "fill", endBehavior: "hold", inputColor: "linear-srgb")`;
  const branch = options.grade
    ? `ColorGrade(exposure: 0.25) { ${leaf}; }`
    : `${leaf};`;
  const controls = [
    `focusX: ${options.focusX ?? "25%"}`,
    `focusY: ${options.focusY ?? "40%"}`,
    `zoom: ${options.zoom ?? "1.25"}`,
    `opacity: ${options.opacity ?? "80%"}`,
    ...(options.rotation ? [`rotation: ${options.rotation}`] : []),
    ...(options.edge ? [`edge: "${options.edge}"`] : []),
  ];
  return `cut 0.4;
project "MediaCamera2D pure source-anchor plan";
import { ColorGrade, Image, MediaCamera2D, Video } from "cut:visual";
asset media: ${kind === "image" ? "ImageAsset = image(\"assets/source.png\")" : "VideoAsset = video(\"assets/source.mkv\")"};
timeline main(duration: 1s, fps: 4, width: 16px, height: 12px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(${controls.join(", ")}) as camera {
      ${branch}
    }
    ${options.zeroAtHalf ? "at 500ms { set camera.opacity = 0%; }" : ""}
  }
}
export out = render(main, width: 16px, height: 12px, codec: "h264");`;
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

async function locked(root: string, source: string) {
  const ir = compile(source);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

function cameraPlan(ir: CutAVIR) {
  const composition = ir.compositions[0]!;
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d");
  assert.ok(camera);
  const plan = validateReferenceMediaCamera2DGraph(ir, composition).get(camera.id);
  assert.ok(plan);
  return { camera, composition, plan };
}

async function fixtureRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-media-camera2d-anchor-"));
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

function assertPureClosedPlan(plan: ReferenceMediaCamera2DAnchorPlan) {
  assert.deepEqual(Object.keys(plan).sort(), [
    "affineIdentity",
    "algorithmVersion",
    "basis",
    "cameraNodeId",
    "controls",
    "exactTime",
    "ownerPlanIdentity",
    "sourceToDelivery",
    "sourceToDeliveryQ16",
    "status",
  ]);
  assert.equal(plan.algorithmVersion, referenceMediaCamera2DAnchorAlgorithmVersion);
  assert.equal("source" in plan, false);
  assert.equal("videoDecode" in plan, false);
  assert.equal("work" in plan, false);
  assert.equal("rasterPlan" in plan, false);
  assert.equal("rasterState" in plan, false);
  assert.equal("gradeExecutionIdentity" in plan, false);
}

test("pure anchor planning exports the exact post-crop pixel-centre Q16 basis and reuses an admitted frame exactly", { timeout: 60_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const ir = await locked(root, program());
    const { composition, plan } = cameraPlan(ir);
    const exactTime = rational(1, 2);
    const anchor = referenceMediaCamera2DAnchorPlanAt(ir, composition, plan, exactTime);
    assertPureClosedPlan(anchor);
    assert.equal(anchor.status, "visible");
    assert.deepEqual(anchor.exactTime, exactTime);
    assert.deepEqual(anchor.basis, {
      kind: "post-crop-source-pixel-centres",
      width: 8,
      height: 6,
      semanticIdentity: anchor.basis.semanticIdentity,
    });
    assert.match(anchor.basis.semanticIdentity, /^[0-9a-f]{64}$/u);
    assert.deepEqual(anchor.controls, {
      focusX: 0.25,
      focusY: 0.4,
      zoom: 1.25,
      rotationDegrees: 0,
      opacity: 0.8,
      opacityPhase: 204,
    });
    assert.deepEqual(anchor.sourceToDeliveryQ16, {
      a: String(2.5 * q16),
      b: "0",
      c: "0",
      d: String(2.5 * q16),
      tx: String(3.125 * q16),
      ty: String(0.5 * q16),
    });
    assert.deepEqual(anchor.sourceToDelivery, {
      a: 2.5,
      b: 0,
      c: 0,
      d: 2.5,
      tx: 3.125,
      ty: 0.5,
    });
    assert.match(anchor.affineIdentity, /^[0-9a-f]{64}$/u);
    assert.match(anchor.ownerPlanIdentity, /^[0-9a-f]{64}$/u);

    const framePlan = referenceMediaCamera2DFramePlanAt(ir, composition, plan, exactTime);
    assert.deepEqual(
      referenceMediaCamera2DAnchorPlanFromFramePlan(ir, plan, framePlan),
      anchor,
      "frame reuse must not resample signals or invent a second affine",
    );
    assert.deepEqual(framePlan.geometry.sourceToDeliveryQ16, anchor.sourceToDeliveryQ16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nonspatial opacity, edge, grade, and source-byte edits stay out of affine identity while audit identity remains honest", { timeout: 60_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const planFor = async (source: string) => {
      const ir = await locked(root, source);
      const { composition, plan } = cameraPlan(ir);
      return referenceMediaCamera2DAnchorPlanAt(ir, composition, plan, rational(0));
    };
    const baseline = await planFor(program());
    const opacityZeroIr = await locked(root, program({ zeroAtHalf: true }));
    const opacityZeroCamera = cameraPlan(opacityZeroIr);
    const opacityZero = referenceMediaCamera2DAnchorPlanAt(
      opacityZeroIr,
      opacityZeroCamera.composition,
      opacityZeroCamera.plan,
      rational(3, 4),
    );
    const clamp = await planFor(program({ edge: "clamp" }));
    const graded = await planFor(program({ grade: true }));

    const changedPixels = Buffer.alloc(8 * 6 * 4, 255);
    for (let index = 0; index < 8 * 6; index += 1) {
      changedPixels[index * 4 + 1] = (index * 17) % 256;
      changedPixels[index * 4 + 2] = 0;
    }
    await sharp(changedPixels, { raw: { width: 8, height: 6, channels: 4 } })
      .png()
      .toFile(resolve(root, "assets/source.png"));
    const changedSource = await planFor(program());

    for (const variant of [opacityZero, clamp, graded, changedSource]) {
      assert.deepEqual(variant.basis, baseline.basis);
      assert.deepEqual(variant.sourceToDeliveryQ16, baseline.sourceToDeliveryQ16);
      assert.equal(variant.affineIdentity, baseline.affineIdentity);
      assert.notEqual(
        variant.ownerPlanIdentity,
        baseline.ownerPlanIdentity,
        "audit identity must still distinguish the complete locked owner plan",
      );
    }
    assert.equal(opacityZero.status, "opacity-zero");
    assert.equal(opacityZero.controls.opacityPhase, 0);
    assert.equal(baseline.status, "visible");

    const moved = await planFor(program({ focusX: "75%" }));
    assert.notDeepEqual(moved.sourceToDeliveryQ16, baseline.sourceToDeliveryQ16);
    assert.notEqual(moved.affineIdentity, baseline.affineIdentity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image and video share the pure coordinate contract without decoder, grade, or resample claims", { timeout: 60_000 }, async () => {
  const root = await fixtureRoot();
  try {
    const imageIr = await locked(root, program({ kind: "image" }));
    const videoIr = await locked(root, program({ kind: "video" }));
    const image = cameraPlan(imageIr);
    const video = cameraPlan(videoIr);
    assert.equal(image.plan.leafKind, "image");
    assert.equal(video.plan.leafKind, "video");

    const exactTime = rational(1, 2);
    const imageAnchor = referenceMediaCamera2DAnchorPlanAt(
      imageIr,
      image.composition,
      image.plan,
      exactTime,
    );
    const videoAnchor = referenceMediaCamera2DAnchorPlanAt(
      videoIr,
      video.composition,
      video.plan,
      exactTime,
    );
    assertPureClosedPlan(imageAnchor);
    assertPureClosedPlan(videoAnchor);
    assert.deepEqual(videoAnchor.basis, imageAnchor.basis);
    assert.deepEqual(videoAnchor.sourceToDeliveryQ16, imageAnchor.sourceToDeliveryQ16);
    assert.equal(videoAnchor.affineIdentity, imageAnchor.affineIdentity);
    assert.notEqual(videoAnchor.ownerPlanIdentity, imageAnchor.ownerPlanIdentity);

    const videoFrame = referenceMediaCamera2DFramePlanAt(
      videoIr,
      video.composition,
      video.plan,
      exactTime,
    );
    assert.ok(videoFrame.videoDecode, "the full frame planner may budget video decoding");
    const reused = referenceMediaCamera2DAnchorPlanFromFramePlan(videoIr, video.plan, videoFrame);
    assertPureClosedPlan(reused);
    assert.equal("videoDecode" in reused, false, "coordinate reuse cannot relabel decode work as anchor work");
    assert.deepEqual(reused, videoAnchor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
