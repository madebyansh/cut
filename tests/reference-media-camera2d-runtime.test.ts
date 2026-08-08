import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Ajv from "ajv";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { registerAppliedCutLockIr } from "../lib/language/locked-ir-state";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import { inspectCutIr } from "../lib/runtime/inspect";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import {
  admitReferenceMediaCamera2DSceneFrame,
  closeReferenceMediaCamera2DSceneAdmission,
  executeReferenceMediaCamera2DFrame,
  referenceMediaCamera2DLimits,
  referenceMediaCamera2DFramePlanAt,
  validateReferenceMediaCamera2DGraph,
} from "../lib/runtime/reference/media-camera2d";
import { validateReferenceLocalSpaceGraph } from "../lib/runtime/reference/local-space";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  createReferenceRetainedMediaViewportQ16TapDiagnostic,
  ReferenceStaticMediaGradeCache,
  ReferenceVisualRenderer,
  validateReferenceRetainedMediaViewportQ16TapKernelEvidence,
} from "../lib/runtime/reference/visual";
import { deriveReferencePrivateRgbaSourceAlphaBounds } from "../lib/runtime/reference/compositing";
import { prepareReferenceVerifiedInputSession } from "../lib/runtime/reference/verified-input-session";

const exec = promisify(execFile);
const q16Units = 65_536;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const result = compileCutModule(parsed.module);
  assert.deepEqual(result.check.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(result.check.diagnostics));
  return result.ir;
}

function imageProgram(camera: string, fit: "cover" | "contain" | "fill" = "fill", width = 8, height = 8) {
  return `cut 0.4;
project "MediaCamera2D runtime proof";
import { Image, MediaCamera2D } from "cut:visual";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(${camera}) as camera { Image(source: media, fit: "${fit}"); }
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function animatedOpacityProgram() {
  return `cut 0.4;
project "MediaCamera2D zero-work opacity frame";
import { Image, MediaCamera2D } from "cut:visual";
import { linear } from "@cut/motion";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%) as camera { Image(source: media, fit: "fill"); }
    animate camera.opacity from 0% to 100% over 1s ease linear;
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function gradedImageProgram(grade = "exposure: 0.5, saturation: 0.75") {
  return `cut 0.4;
project "MediaCamera2D native grade proof";
import { ColorGrade, Image, MediaCamera2D } from "cut:visual";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%) as camera {
      ColorGrade(${grade}) { Image(source: media, fit: "fill"); }
    }
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function animatedGradeSignal() {
  const ir = compile(`cut 0.4;
project "MediaCamera2D dynamic grade signal fixture";
import { ColorGrade, Rect } from "cut:visual";
import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ColorGrade() as grade { Rect(width: 8px, height: 8px, fill: #ff0000); }
    animate grade.exposure from 0 to 0.5 over 1s ease linear;
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`);
  const grade = Object.values(ir.nodes).find((node) => node.op === "cut.visual.color_grade")!;
  const property = grade.properties.exposure;
  assert.ok(property && "signal" in property);
  return structuredClone(ir.signals[property.signal]);
}

async function lockedAnimatedCameraGrade(root: string) {
  const ir = structuredClone(await locked(root, gradedImageProgram("exposure: 0.5")));
  const grade = Object.values(ir.nodes).find((node) => node.op === "cut.visual.color_grade")!;
  const signal = animatedGradeSignal();
  assert.equal(ir.signals[signal.id], undefined);
  ir.signals[signal.id] = signal;
  delete grade.inputs.exposure;
  grade.properties.exposure = { signal: signal.id };
  finalizeGraphHashes(ir);
  registerAppliedCutLockIr(ir);
  return ir;
}

function twoCameraProgram() {
  return `cut 0.4;
project "MediaCamera2D whole-scene preflight";
import { Image, MediaCamera2D } from "cut:visual";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%, opacity: 75%) as first { Image(source: media, fit: "fill"); }
    MediaCamera2D(focusX: 75%, opacity: 75%) as second { Image(source: media, fit: "fill"); }
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function twoGradedCameraProgram() {
  return `cut 0.4;
project "MediaCamera2D exclusive grade ownership";
import { ColorGrade, Image, MediaCamera2D } from "cut:visual";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%) as first { ColorGrade(exposure: 0.2) { Image(source: media, fit: "fill"); } }
    MediaCamera2D(focusX: 75%) as second { ColorGrade(exposure: 0.4) { Image(source: media, fit: "fill"); } }
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function multiVideoCameraProgram(count: number) {
  const cameras = Array.from({ length: count }, (_, index) => `
    MediaCamera2D(focusX: ${15 + index * 10}%, zoom: 1.1) as camera${index} {
      Video(source: media, range: 0s..<1s, fit: "cover", endBehavior: "hold");
    }`).join("");
  return `cut 0.4;
project "MediaCamera2D decoder admission";
import { MediaCamera2D, Video } from "cut:visual";
asset media: VideoAsset = video("assets/source.mkv", proxy: "assets/source-proxy.mkv");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {${cameras}
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function multiSourceImageProgram(count: number) {
  const assets = Array.from({ length: count }, (_, index) => `asset media${index}: ImageAsset = image("assets/source.png");`).join("\n");
  const scenes = Array.from({ length: count }, (_, index) => `
  scene shot${index}(duration: 1s) {
    MediaCamera2D(focusX: ${25 + index * 10}%) { Image(source: media${index}, fit: "fill"); }
  }`).join("");
  return `cut 0.4;
project "MediaCamera2D composition source admission";
import { Image, MediaCamera2D } from "cut:visual";
${assets}
timeline main(duration: ${count}s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {${scenes}
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function videoProgram() {
  return `cut 0.4;
project "MediaCamera2D moving media proof";
import { MediaCamera2D, Video } from "cut:visual";
asset media: VideoAsset = video("assets/source.mkv", proxy: "assets/source-proxy.mkv");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%, focusY: 60%, zoom: 1.1, rotation: 7deg) as camera {
      Video(source: media, range: 0s..<1s, fit: "cover", endBehavior: "hold");
    }
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function catchUpVideoProgram(durationSeconds = 4, inputColor = "linear-srgb") {
  return `cut 0.4;
project "MediaCamera2D catch-up admission";
import { MediaCamera2D, Video } from "cut:visual";
import { linear } from "@cut/motion";
asset media: VideoAsset = video("assets/source.mkv", proxy: "assets/source-proxy.mkv");
timeline main(duration: ${durationSeconds}s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: ${durationSeconds}s) {
    MediaCamera2D(focusX: 25%, zoom: 1.1) as camera {
      Video(source: media, fit: "cover", loop: true, inputColor: "${inputColor}");
    }
    animate camera.opacity from 0% to 100% over ${durationSeconds}s ease linear;
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function cameraNullTrackProgram() {
  return `cut 0.4;
project "MediaCamera2D null-track default";
import { Image, MediaCamera2D } from "cut:visual";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(opacity: 25%) as camera { Image(source: media, fit: "fill"); }
    at 500ms { set camera.opacity = 50%; }
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function ordinaryProgram() {
  return `cut 0.4;
project "ordinary retained-media regression";
import { Image, LocalSpace } from "cut:visual";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 8px, height: 6px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    LocalSpace(width: 8px, height: 6px, origin: { x: 4px, y: 3px }) { Image(source: media, fit: "fill"); }
  }
}
export out = render(main, width: 8px, height: 6px, codec: "h264");`;
}

function highFrequencyRgba(width = 8, height = 6) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4, checker = (x + y) % 2 === 0;
    data[offset] = checker ? 245 : (x * 31 + y * 13) % 211;
    data[offset + 1] = checker ? (y * 43) % 256 : 235;
    data[offset + 2] = checker ? 18 : (x * 47) % 256;
    data[offset + 3] = 255;
  }
  return data;
}

async function imageFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-media-camera2d-"));
  await mkdir(resolve(root, "assets"));
  const rgba = highFrequencyRgba();
  await sharp(rgba, { raw: { width: 8, height: 6, channels: 4 } }).png().toFile(resolve(root, "assets/source.png"));
  return { root, rgba };
}

async function videoFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-media-camera2d-video-"));
  await mkdir(resolve(root, "assets"));
  for (let frame = 0; frame < 4; frame += 1) {
    const master = Buffer.alloc(8 * 6 * 4);
    for (let y = 0; y < 6; y += 1) for (let x = 0; x < 8; x += 1) {
      const pixelIndex = y * 8 + x;
      master[pixelIndex * 4] = (frame * 61 + Math.floor(x / 2) * 31) % 256;
      master[pixelIndex * 4 + 1] = (Math.floor(y / 2) * 73 + frame * 29) % 256;
      master[pixelIndex * 4 + 2] = (255 - frame * 47 + Math.floor(x / 2) * 11) % 256;
      master[pixelIndex * 4 + 3] = 255;
    }
    await sharp(master, { raw: { width: 8, height: 6, channels: 4 } }).png().toFile(resolve(root, `assets/master-${frame}.png`));
    await sharp(master, { raw: { width: 8, height: 6, channels: 4 } })
      .resize(4, 3, { fit: "fill", kernel: sharp.kernel.nearest })
      .png()
      .toFile(resolve(root, `assets/proxy-${frame}.png`));
  }
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-framerate", "4", "-start_number", "0", "-i", resolve(root, "assets/master-%d.png"),
    "-vf", "format=bgra,setparams=range=full:color_primaries=bt709:color_trc=linear:colorspace=gbr",
    "-c:v", "ffv1", "-pix_fmt", "bgra", resolve(root, "assets/source.mkv"),
  ]);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-framerate", "4", "-start_number", "0", "-i", resolve(root, "assets/proxy-%d.png"),
    "-vf", "format=bgra,setparams=range=full:color_primaries=bt709:color_trc=linear:colorspace=gbr",
    "-c:v", "ffv1", "-pix_fmt", "bgra", resolve(root, "assets/source-proxy.mkv"),
  ]);
  return root;
}

async function locked(root: string, source: string) {
  const ir = compile(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

function rgbaSha256(surface: { data: Uint8Array }) {
  return createHash("sha256").update(surface.data).digest("hex");
}

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

async function renderWithCameraEvidence(
  ir: CutAVIR,
  root: string,
  frames: readonly number[] = [0],
  cache = "camera",
  staticMediaGradeCacheByteLimit?: number,
  staticMediaGradeHandoffMode?: "copied" | "immutable-lease",
) {
  const { composition } = validateReferenceSession(ir, "out"), scene = ir.scenes[composition.sceneIds[0]!]!;
  const renderer = new ReferenceVisualRenderer(
    ir,
    composition,
    root,
    resolve(root, ".cut", cache),
    undefined,
    undefined,
    undefined,
    staticMediaGradeCacheByteLimit === undefined && staticMediaGradeHandoffMode === undefined
      ? undefined
      : {
        ...(staticMediaGradeCacheByteLimit === undefined ? {} : { staticMediaGradeCacheByteLimit }),
        ...(staticMediaGradeHandoffMode === undefined ? {} : { staticMediaGradeHandoffMode }),
      },
  );
  const results: Array<{
    frame: number;
    surface: Awaited<ReturnType<ReferenceVisualRenderer["sceneFrame"]>>;
    evidence: ReturnType<ReferenceVisualRenderer["referenceMediaCamera2DEvidence"]>[number];
  }> = [];
  let decoder: ReturnType<ReferenceVisualRenderer["referenceVideoDecoderEvidence"]> = [];
  try {
    await renderer.prepare();
    for (const frame of frames) {
      const surface = await renderer.sceneFrame(scene, frame, false), entries = renderer.referenceMediaCamera2DEvidence();
      assert.equal(entries.length, 1);
      results.push({ frame, surface, evidence: entries[0]! });
    }
    decoder = renderer.referenceVideoDecoderEvidence();
  } finally { await renderer.closeAndWait(); }
  const cacheAfterClose = (renderer as unknown as {
    rendererTreeContext: { staticMediaGradeCache: ReferenceStaticMediaGradeCache };
  }).rendererTreeContext.staticMediaGradeCache;
  return { results, decoder, cacheAfterClose };
}

function directQ16Oracle(
  source: Readonly<{ data: Uint8Array; width: number; height: number }>,
  output: Readonly<{ width: number; height: number }>,
  affine: Readonly<{ a: number; b: number; c: number; d: number; tx: number; ty: number }>,
  opacity: number,
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>,
) {
  const result = new Uint8Array(output.width * output.height * 4);
  const quantize = (value: number) => Math.round(value * q16Units) / q16Units;
  const matrix = Object.freeze({
    a: quantize(affine.a), b: quantize(affine.b), c: quantize(affine.c), d: quantize(affine.d),
    tx: quantize(affine.tx), ty: quantize(affine.ty),
  });
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const inverse = { a: matrix.d / determinant, b: -matrix.b / determinant, c: -matrix.c / determinant, d: matrix.a / determinant };
  const sample = (x: number, y: number, channel: number) => x < 0 || y < 0 || x >= source.width || y >= source.height
    ? 0 : source.data[(y * source.width + x) * 4 + channel]!;
  for (let y = Math.max(0, bounds.top); y < Math.min(output.height, bounds.bottom); y += 1) {
    for (let x = Math.max(0, bounds.left); x < Math.min(output.width, bounds.right); x += 1) {
      const dx = x - matrix.tx, dy = y - matrix.ty;
      const sx = quantize(inverse.a * dx + inverse.c * dy), sy = quantize(inverse.b * dx + inverse.d * dy);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const weights: readonly (readonly [number, number, number])[] = [
        [(1 - fx) * (1 - fy), x0, y0],
        [fx * (1 - fy), x0 + 1, y0],
        [(1 - fx) * fy, x0, y0 + 1],
        [fx * fy, x0 + 1, y0 + 1],
      ];
      let alpha = 0, red = 0, green = 0, blue = 0;
      for (const [weight, px, py] of weights) {
        if (weight === 0) continue;
        const a = sample(px, py, 3);
        alpha += a * weight;
        red += sample(px, py, 0) * a * weight;
        green += sample(px, py, 1) * a * weight;
        blue += sample(px, py, 2) * a * weight;
      }
      const scaledAlpha = Math.round(Math.max(0, Math.min(255, alpha * opacity)));
      if (scaledAlpha === 0 || alpha <= 0) continue;
      const offset = (y * output.width + x) * 4;
      result[offset] = Math.round(Math.max(0, Math.min(255, red / alpha)));
      result[offset + 1] = Math.round(Math.max(0, Math.min(255, green / alpha)));
      result[offset + 2] = Math.round(Math.max(0, Math.min(255, blue / alpha)));
      result[offset + 3] = scaledAlpha;
    }
  }
  return result;
}

function affineFromQ16(value: Readonly<{ a: string; b: string; c: string; d: string; tx: string; ty: string }>) {
  return Object.freeze({
    a: Number(value.a) / q16Units, b: Number(value.b) / q16Units,
    c: Number(value.c) / q16Units, d: Number(value.d) / q16Units,
    tx: Number(value.tx) / q16Units, ty: Number(value.ty) / q16Units,
  });
}

test("static Image ColorGrade cache is byte-authoritative, bounded, mutation-detecting, and failure-clean", async () => {
  const sourceA = { data: Buffer.from([10, 20, 30, 255]), width: 1, height: 1 };
  const sourceB = { data: Buffer.from([11, 20, 30, 255]), width: 1, height: 1 };
  const gradeExecutionIdentity = "1".repeat(64);
  const request = (
    cache: ReferenceStaticMediaGradeCache,
    source: typeof sourceA,
    semantic: string,
    materialize: () => Promise<{ surface: typeof sourceA; linearBalanceSurfaces: 0 | 1; backendGradeSurfaces: 0 | 1 }>,
    overrides: Partial<Readonly<{ gradeNodeId: string; gradeExecutionIdentity: string; backendIdentity: string }>> = {},
  ) => cache.request({
    source,
    sourceSemanticIdentity: semantic,
    gradeNodeId: overrides.gradeNodeId ?? "grade",
    gradeExecutionIdentity: overrides.gradeExecutionIdentity ?? gradeExecutionIdentity,
    backendIdentity: overrides.backendIdentity ?? "test-backend-v1",
    materialize,
  });

  const cache = new ReferenceStaticMediaGradeCache(16, 4, "copied");
  let renders = 0;
  const render = async (source: typeof sourceA) => {
    renders += 1;
    return {
      surface: { ...source, data: Buffer.from(source.data.map((value, index) => index === 0 ? value + 1 : value)) },
      linearBalanceSurfaces: 1 as const,
      backendGradeSurfaces: 0 as const,
    };
  };
  const first = await request(cache, sourceA, "locked-source", () => render(sourceA));
  const hit = await request(cache, sourceA, "locked-source", () => render(sourceA));
  assert.notStrictEqual(first.surface!.data, hit.surface!.data, "a cache hit must hand off an isolated buffer");
  assert.equal(first.evidence.residentCopies, 1);
  assert.equal(first.evidence.residentCopyRgbaBytes, 4);
  assert.equal(first.evidence.handoffCopies, 0);
  assert.equal(first.evidence.handoffRgbaBytes, 0);
  assert.equal(hit.evidence.residentCopies, 0);
  assert.equal(hit.evidence.residentCopyRgbaBytes, 0);
  assert.equal(hit.evidence.handoffCopies, 1);
  assert.equal(hit.evidence.handoffRgbaBytes, 4);
  first.surface!.data[0] ^= 0xff;
  hit.surface!.data[1] ^= 0xff;
  const isolatedHit = await request(cache, sourceA, "locked-source", () => render(sourceA));
  assert.deepEqual([...isolatedHit.surface!.data], [11, 20, 30, 255], "consumer mutation must not alter resident cache authority");
  const changedBytes = await request(cache, sourceB, "locked-source", () => render(sourceB));
  const changedSource = await request(cache, sourceA, "other-source", () => render(sourceA));
  const changedGrade = await request(cache, sourceA, "locked-source", () => render(sourceA), { gradeExecutionIdentity: "2".repeat(64) });
  const changedNode = await request(cache, sourceA, "locked-source", () => render(sourceA), { gradeNodeId: "other-grade" });
  const changedBackend = await request(cache, sourceA, "locked-source", () => render(sourceA), { backendIdentity: "test-backend-v2" });
  assert.equal(first.evidence.status, "miss");
  assert.equal(hit.evidence.status, "hit");
  assert.ok([changedBytes, changedSource, changedGrade, changedNode, changedBackend]
    .every((result) => result.evidence.status === "miss"));
  assert.equal(new Set([
    first.evidence.cacheIdentity,
    changedBytes.evidence.cacheIdentity,
    changedSource.evidence.cacheIdentity,
    changedGrade.evidence.cacheIdentity,
    changedNode.evidence.cacheIdentity,
    changedBackend.evidence.cacheIdentity,
  ]).size, 6, "every source/config/backend authority mutation must miss");
  assert.equal(renders, 6, "only the exact repeated authority may hit");

  const coalesced = new ReferenceStaticMediaGradeCache(4, 1, "copied");
  let releaseMaterialization!: () => void;
  const materializationBarrier = new Promise<void>((resolveBarrier) => { releaseMaterialization = resolveBarrier; });
  let concurrentMaterializations = 0;
  const concurrentMaterialize = async () => {
    concurrentMaterializations += 1;
    await materializationBarrier;
    return {
      surface: { ...sourceA, data: Buffer.from(sourceA.data) },
      linearBalanceSurfaces: 1 as const,
      backendGradeSurfaces: 0 as const,
    };
  };
  const concurrentFirst = request(coalesced, sourceA, "shared", concurrentMaterialize);
  const concurrentSecond = request(coalesced, sourceA, "shared", concurrentMaterialize);
  let competingMaterializations = 0;
  const concurrentCompeting = request(coalesced, sourceB, "competing", async () => {
    competingMaterializations += 1;
    return {
      surface: { ...sourceB, data: Buffer.from(sourceB.data) },
      linearBalanceSurfaces: 1 as const,
      backendGradeSurfaces: 0 as const,
    };
  });
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(concurrentMaterializations, 1, "same-key requests must share one pending materialization");
  releaseMaterialization();
  const concurrentResults = await Promise.all([concurrentFirst, concurrentSecond, concurrentCompeting]);
  assert.deepEqual(concurrentResults.map((result) => result.evidence.status), ["miss", "hit", "miss"]);
  assert.notStrictEqual(concurrentResults[0]!.surface!.data, concurrentResults[1]!.surface!.data);
  assert.equal(competingMaterializations, 1);
  assert.equal(coalesced.residentBytes, 4);
  assert.equal(coalesced.entryCount, 1);
  assert.equal(coalesced.pendingCount, 0);

  const leasedCache = new ReferenceStaticMediaGradeCache(4, 1, "immutable-lease");
  await request(leasedCache, sourceA, "leased", () => render(sourceA));
  const leasedHit = await request(leasedCache, sourceA, "leased", () => render(sourceA));
  assert.ok(leasedHit.lease);
  let releaseLease!: () => void;
  let announceLease!: () => void;
  const leaseStarted = new Promise<void>((resolveStarted) => { announceLease = resolveStarted; });
  const leaseBarrier = new Promise<void>((resolveBarrier) => { releaseLease = resolveBarrier; });
  const consumed = leasedCache.consumeLease(leasedHit.lease, async (surface) => {
    announceLease();
    await leaseBarrier;
    return rgbaSha256(surface);
  });
  await leaseStarted;
  assert.equal(leasedCache.activeLeaseCount, 1, "an asynchronous consumer must keep its resident lease pinned");
  const pinnedCompeting = await request(leasedCache, sourceB, "pinned-competing", () => render(sourceB));
  assert.equal(pinnedCompeting.evidence.status, "bypass-capacity", "a pinned resident cannot be evicted to admit competing bytes");
  releaseLease();
  assert.match(await consumed, /^[a-f0-9]{64}$/u);
  assert.equal(leasedCache.activeLeaseCount, 0);
  assert.throws(
    () => leasedCache.consumeLease(leasedHit.lease!, () => undefined),
    /foreign, stale, duplicated, or detached/u,
    "a one-shot resident lease cannot be replayed",
  );
  const throwingLease = await request(leasedCache, sourceA, "leased", () => render(sourceA));
  assert.ok(throwingLease.lease);
  assert.throws(
    () => leasedCache.consumeLease(throwingLease.lease!, () => { throw new Error("injected sampler failure"); }),
    /injected sampler failure/u,
  );
  assert.equal(leasedCache.activeLeaseCount, 0, "a synchronous sampler failure must release its pin");
  const staleLease = await request(leasedCache, sourceA, "leased", () => render(sourceA));
  assert.ok(staleLease.lease);
  leasedCache.clear();
  assert.equal(leasedCache.activeLeaseCount, 0);
  assert.throws(
    () => leasedCache.consumeLease(staleLease.lease!, () => undefined),
    /live renderer-tree authority/u,
    "renderer-tree close revokes every outstanding lease",
  );

  const eviction = new ReferenceStaticMediaGradeCache(4, 1, "copied");
  let evictionRenders = 0;
  const evictingRender = async (source: typeof sourceA) => {
    evictionRenders += 1;
    return { surface: { ...source, data: Buffer.from(source.data) }, linearBalanceSurfaces: 0 as const, backendGradeSurfaces: 1 as const };
  };
  await request(eviction, sourceA, "a", () => evictingRender(sourceA));
  await request(eviction, sourceB, "b", () => evictingRender(sourceB));
  await request(eviction, sourceA, "a", () => evictingRender(sourceA));
  assert.equal(evictionRenders, 3, "one-entry LRU must evict deterministically");
  eviction.clear();
  assert.equal(eviction.residentBytes, 0);
  assert.equal(eviction.entryCount, 0);

  const failed = new ReferenceStaticMediaGradeCache(4, 1, "copied");
  await assert.rejects(
    request(failed, sourceA, "failed", async () => { throw new Error("injected grade failure"); }),
    /injected grade failure/u,
  );
  assert.equal(failed.residentBytes, 0);
  assert.equal(failed.entryCount, 0);

  const mutable = new ReferenceStaticMediaGradeCache(4, 1, "copied");
  await request(mutable, sourceA, "mutable", () => evictingRender(sourceA));
  const mutableInternals = mutable as unknown as {
    entries: Map<string, { surface: { data: Buffer } }>;
  };
  mutableInternals.entries.values().next().value!.surface.data[0] ^= 1;
  await assert.rejects(
    request(mutable, sourceA, "mutable", () => evictingRender(sourceA)),
    /CUT_STATIC_MEDIA_GRADE_CACHE_MUTATION/u,
  );
  assert.throws(() => mutable.clear(), /CUT_STATIC_MEDIA_GRADE_CACHE_MUTATION/u);
  assert.equal(mutable.residentBytes, 0, "clear must release a corrupt entry even while reporting mutation");
  assert.equal(mutable.entryCount, 0);

  const closing = new ReferenceStaticMediaGradeCache(4, 1, "copied");
  let releaseClosing!: () => void;
  let announceClosing!: () => void;
  const closingStarted = new Promise<void>((resolveStarted) => { announceClosing = resolveStarted; });
  const closingBarrier = new Promise<void>((resolveBarrier) => { releaseClosing = resolveBarrier; });
  const closingRequest = request(closing, sourceA, "closing", async () => {
    announceClosing();
    await closingBarrier;
    return evictingRender(sourceA);
  });
  await closingStarted;
  closing.clear();
  assert.equal(closing.pendingCount, 0, "close must immediately release pending request tracking");
  releaseClosing();
  await assert.rejects(closingRequest, /CUT_STATIC_MEDIA_GRADE_CACHE_CLOSED/u);
  assert.equal(closing.residentBytes, 0);
  assert.equal(closing.entryCount, 0);
  assert.equal(closing.pendingCount, 0);
  await assert.rejects(
    request(closing, sourceA, "after-close", () => evictingRender(sourceA)),
    /CUT_STATIC_MEDIA_GRADE_CACHE_CLOSED/u,
  );
});

test("MediaCamera2D static grade reuse has truthful hit/bypass evidence and exact forced-off pixels", { timeout: 120_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const staticIr = await locked(root, gradedImageProgram("exposure: 0.5, saturation: 0.75"));
    const automatic = await renderWithCameraEvidence(staticIr, root, [0, 1, 2], "static-grade-auto");
    const copied = await renderWithCameraEvidence(staticIr, root, [0, 1, 2], "static-grade-copied", undefined, "copied");
    const forcedOff = await renderWithCameraEvidence(staticIr, root, [0, 1, 2], "static-grade-off", 4);
    assert.deepEqual(automatic.results.map(({ evidence }) => evidence.staticGradeCache?.status), ["miss", "hit", "hit"]);
    assert.deepEqual(automatic.results.map(({ evidence }) => ({
      copied: evidence.staticGradeCache?.handoffCopies,
      leased: evidence.staticGradeCache?.leaseHandoffs,
    })), [{ copied: 0, leased: 0 }, { copied: 0, leased: 1 }, { copied: 0, leased: 1 }]);
    assert.deepEqual(forcedOff.results.map(({ evidence }) => evidence.staticGradeCache?.status), ["bypass-capacity", "bypass-capacity", "bypass-capacity"]);
    assert.deepEqual(copied.results.map(({ evidence }) => ({
      copied: evidence.staticGradeCache?.handoffCopies,
      leased: evidence.staticGradeCache?.leaseHandoffs,
    })), [{ copied: 0, leased: 0 }, { copied: 1, leased: 0 }, { copied: 1, leased: 0 }]);
    assert.deepEqual(
      automatic.results.map(({ surface }) => rgbaSha256(surface)),
      forcedOff.results.map(({ surface }) => rgbaSha256(surface)),
      "cache admission may change allocation evidence but never RGBA",
    );
    assert.deepEqual(
      automatic.results.map(({ surface }) => rgbaSha256(surface)),
      copied.results.map(({ surface }) => rgbaSha256(surface)),
      "lease and copied handoffs must preserve exact final RGBA",
    );
    assert.equal(automatic.cacheAfterClose.activeLeaseCount, 0);
    assert.equal(automatic.cacheAfterClose.residentBytes, 0);
    assert.equal(copied.cacheAfterClose.activeLeaseCount, 0);
    assert.deepEqual(automatic.results.slice(1).map(({ evidence }) => evidence.allocations.colorGradeSurfaces), [0, 0]);
    assert.ok(automatic.results.slice(1).every(({ evidence }) => evidence.work.colorGradePixelPasses > 0), "preflight work ceiling must remain conservative on hits");

    const dynamicIr = await lockedAnimatedCameraGrade(root);
    const dynamic = await renderWithCameraEvidence(dynamicIr, root, [0, 1, 2], "static-grade-dynamic");
    assert.deepEqual(dynamic.results.map(({ evidence }) => evidence.staticGradeCache?.status), ["bypass-dynamic", "bypass-dynamic", "bypass-dynamic"]);
    assert.ok(dynamic.results.every(({ evidence }) =>
      evidence.allocations.colorGradeSurfaces === evidence.work.colorGradePixelPasses));
    assert.ok(dynamic.results.some(({ evidence }) => evidence.allocations.colorGradeSurfaces > 0),
      "a signal-bearing non-default sample must execute the admitted grade work");

    const hostileInputSignal = structuredClone(dynamicIr);
    const hostileGrade = Object.values(hostileInputSignal.nodes)
      .find((node) => node.op === "cut.visual.color_grade")!;
    hostileGrade.inputs.exposure = {
      kind: "signal-ref",
      signal: Object.keys(hostileInputSignal.signals)[0]!,
    } as unknown as typeof hostileGrade.inputs.exposure;
    delete hostileGrade.properties.exposure;
    finalizeGraphHashes(hostileInputSignal);
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(hostileInputSignal, hostileInputSignal.compositions[0]!),
      /CUT_COLOR_INPUT_TYPE/u,
      "a forged signal-valued ColorGrade input must fail before cache or pixels rather than reuse one raw reference",
    );

    const renderer = new ReferenceVisualRenderer(staticIr, staticIr.compositions[0]!, root, resolve(root, ".cut", "signal-input-proof"));
    try {
      const signalCheck = renderer as unknown as { irValueContainsSignal(value: unknown): boolean };
      assert.equal(signalCheck.irValueContainsSignal({ nested: [{ signal: "track" }] }), true, "signal-valued inputs must fail closed");
      assert.equal(signalCheck.irValueContainsSignal({ nested: [{ kind: "signal-ref", id: "track" }] }), true);
      assert.equal(signalCheck.irValueContainsSignal({ nested: [{ value: 1 }] }), false);
      const cycle: { self?: unknown } = {};
      cycle.self = cycle;
      assert.equal(signalCheck.irValueContainsSignal(cycle), true, "unknown recursive inputs must fail closed");
    } finally { await renderer.closeAndWait(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MediaCamera2D lease output mutation cannot alter the renderer-owned graded resident", { timeout: 120_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, gradedImageProgram("exposure: 0.5, saturation: 0.75"));
    const { composition } = validateReferenceSession(ir, "out"), scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "lease-output-isolation"));
    try {
      await renderer.prepare();
      const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d")!;
      const plan = validateReferenceMediaCamera2DGraph(ir, composition).get(camera.id)!;
      const leaf = ir.nodes[plan.leafNodeId]!;
      const internals = renderer as unknown as {
        retainedMediaCroppedFrame(
          node: IRNode,
          plan: unknown,
          frame: number,
        ): Promise<unknown>;
        retainedMediaStaticImages: Map<string, { sourceAuthority?: unknown }>;
      };
      await internals.retainedMediaCroppedFrame(leaf, plan.decodePlan, 0);
      assert.equal(internals.retainedMediaStaticImages.get(plan.decodePlan.semanticIdentity)?.sourceAuthority, undefined,
        "an ordinary decoded-image cache entry starts without static-grade source authority");
      const first = await renderer.sceneFrame(scene, 0, false);
      assert.ok(internals.retainedMediaStaticImages.get(plan.decodePlan.semanticIdentity)?.sourceAuthority,
        "the first eligible static grade must lazily bind authority to an existing decoded image entry");
      const expected = rgbaSha256(first);
      const leasedOutput = await renderer.sceneFrame(scene, 1, false);
      assert.equal(renderer.referenceMediaCamera2DEvidence()[0]!.staticGradeCache?.leaseHandoffs, 1);
      leasedOutput.data.fill(0);
      const later = await renderer.sceneFrame(scene, 2, false);
      assert.equal(rgbaSha256(later), expected, "mutating a completed Q16 output cannot modify the cache-private graded source");
      assert.equal(renderer.referenceMediaCamera2DEvidence()[0]!.staticGradeCache?.leaseHandoffs, 1);
      const cache = (renderer as unknown as {
        rendererTreeContext: { staticMediaGradeCache: ReferenceStaticMediaGradeCache };
      }).rendererTreeContext.staticMediaGradeCache;
      assert.equal(cache.activeLeaseCount, 0);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MediaCamera2D renderer cleanup releases static grade residency after a nested close failure", { timeout: 120_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, gradedImageProgram("exposure: 0.5, saturation: 0.75"));
    const { composition } = validateReferenceSession(ir, "out"), scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "cleanup-failure"));
    await renderer.prepare();
    await renderer.sceneFrame(scene, 0, false);
    assert.ok(renderer.referenceStaticMediaGradeCacheEvidence().residentBytes > 0);
    const internals = renderer as unknown as {
      precompRenderers: Map<string, { closeAndWait(): Promise<void> }>;
    };
    internals.precompRenderers.set("injected-hostile-close", {
      async closeAndWait() { throw new Error("injected nested close failure"); },
    });
    await assert.rejects(renderer.closeAndWait(), /injected nested close failure/u);
    assert.deepEqual(renderer.referenceStaticMediaGradeCacheEvidence(), {
      hit: 0,
      miss: 1,
      bypassCapacity: 0,
      bypassDynamic: 0,
      residentCopies: 1,
      residentCopyRgbaBytes: 8 * 6 * 4,
      handoffCopies: 0,
      handoffRgbaBytes: 0,
      leaseHandoffs: 0,
      leaseRgbaBytes: 0,
      residentBytes: 0,
      entries: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public MediaCamera2D controls are causal at zoom one and execute one direct native-crop affine", { timeout: 120_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const variants = Object.freeze({
      base: "focusX: 25%",
      focusX: "focusX: 75%",
      focusY: "focusX: 25%, focusY: 25%",
      zoom: "focusX: 25%, zoom: 1.5",
      rotation: "focusX: 25%, rotation: 17deg",
      opacity: "focusX: 25%, opacity: 50%",
    });
    const rendered = new Map<string, Awaited<ReturnType<typeof renderWithCameraEvidence>>["results"][number]>();
    for (const [name, controls] of Object.entries(variants)) {
      const ir = await locked(root, imageProgram(controls));
      const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d")!;
      assert.equal(camera.ownership, "root");
      const plan = validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!).get(camera.id)!;
      assert.equal(plan.decodePlan.resample, "cut-q16-associated-bilinear-direct-affine");
      assert.deepEqual(plan.transformOrder, ["fit-scale", "focus-to-delivery-centre", "zoom", "rotate-about-delivery-centre", "opacity"]);
      const execution = (await renderWithCameraEvidence(ir, root, [0], `causal-${name}`)).results[0]!;
      rendered.set(name, execution);
      assert.equal(execution.evidence.allocations.compositionPrerasterCount, 0);
      assert.equal(execution.evidence.allocations.geometricResampleCount, 1);
      assert.equal(execution.evidence.work.geometricResampleCount, 1);
      assert.doesNotMatch(JSON.stringify({ plan, evidence: execution.evidence }), /sharp|bicubic/iu);
    }
    const base = rendered.get("base")!;
    for (const name of ["focusX", "focusY", "zoom", "rotation", "opacity"] as const) {
      assert.notEqual(rgbaSha256(rendered.get(name)!.surface), rgbaSha256(base.surface), `${name} must causally change pixels`);
    }
    assert.equal(base.evidence.controls.zoom, 1);
    assert.notEqual(
      base.evidence.geometry.sourceToDeliveryQ16.tx,
      rendered.get("focusX")!.evidence.geometry.sourceToDeliveryQ16.tx,
      "focusX is a camera target and must pan even at zoom=1",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("direct Q16 oracle preserves associated alpha and differs from a two-resample counterfactual", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, imageProgram("focusX: 37%, focusY: 62%, zoom: 1.2, rotation: 19deg, opacity: 80%", "fill", 12, 8));
    const composition = ir.compositions[0]!, camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d")!;
    const plan = validateReferenceMediaCamera2DGraph(ir, composition).get(camera.id)!;
    const framePlan = referenceMediaCamera2DFramePlanAt(ir, composition, plan, rational(0));
    const sceneAdmission = admitReferenceMediaCamera2DSceneFrame(
      ir,
      composition,
      plan.sceneId,
      rational(0),
      [Object.freeze({ plan, framePlan })],
    );
    assert.ok(framePlan.geometry.outputBounds);
    const hostile = Buffer.alloc(plan.decodedCrop.pixels * 4);
    for (let y = 0; y < plan.decodedCrop.height; y += 1) for (let x = 0; x < plan.decodedCrop.width; x += 1) {
      const offset = (y * plan.decodedCrop.width + x) * 4, opaque = x < Math.ceil(plan.decodedCrop.width / 2);
      hostile[offset] = opaque ? 255 : 0;
      hostile[offset + 2] = opaque ? 0 : 255; // hostile blue hidden RGB
      hostile[offset + 3] = opaque ? 255 : 0;
    }
    const controlDiagnostic = createReferenceRetainedMediaViewportQ16TapDiagnostic(
      "forced-allocated-control",
    );
    const executionInput = {
      source: { data: hostile, width: plan.decodedCrop.width, height: plan.decodedCrop.height },
      plan,
      framePlan,
      diagnosticNode: camera,
      outputFrame: "0",
      sceneAdmission,
      q16TapDiagnostic: controlDiagnostic,
      decoded: { sourceOpens: 1, readerPullAttempts: 1, decodedFramesRead: 1, decodedSurfaces: 1, managedColorConversionSurfaces: 0, linearBalanceSurfaces: 0, backendGradeSurfaces: 0 },
    } as const;
    const executed = executeReferenceMediaCamera2DFrame(executionInput);
    const automaticDiagnostic = createReferenceRetainedMediaViewportQ16TapDiagnostic(
      "automatic",
    );
    const automaticAdmission = admitReferenceMediaCamera2DSceneFrame(
      ir,
      composition,
      plan.sceneId,
      rational(0),
      [Object.freeze({ plan, framePlan })],
    );
    const automatic = executeReferenceMediaCamera2DFrame({
      ...executionInput,
      sceneAdmission: automaticAdmission,
      q16TapDiagnostic: automaticDiagnostic,
    });
    assert.deepEqual(
      automatic.surface.data,
      executed.surface.data,
      "MediaCamera2D must preserve exact pixels through allocated-control and native Q16 paths",
    );
    const controlKernel = validateReferenceRetainedMediaViewportQ16TapKernelEvidence(
      controlDiagnostic.snapshot(),
    );
    const automaticKernel = validateReferenceRetainedMediaViewportQ16TapKernelEvidence(
      automaticDiagnostic.snapshot(),
    );
    assert.ok(controlKernel.visibleRasterRequests > 0);
    assert.equal(
      controlKernel.visibleDestinationPixels,
      automaticKernel.visibleDestinationPixels,
    );
    assert.equal(controlKernel.tapEvaluations, automaticKernel.tapEvaluations);
    assert.equal(controlKernel.zeroWeightTaps, automaticKernel.zeroWeightTaps);
    assert.equal(controlKernel.outputPixelsWritten, automaticKernel.outputPixelsWritten);
    assert.equal(controlKernel.allocatedControlPixels, controlKernel.visibleDestinationPixels);
    const nativeHost = process.platform === "darwin" && process.arch === "arm64";
    assert.equal(automaticKernel.reusableScratchPixels, nativeHost ? 0 : automaticKernel.visibleDestinationPixels);
    assert.equal(automaticKernel.nativePixels, nativeHost ? automaticKernel.visibleDestinationPixels : 0);
    assert.equal(automaticKernel.nativeExecutions, nativeHost ? automaticKernel.visibleRasterRequests : 0);
    assert.equal(automaticKernel.scalarExecutions, nativeHost ? 0 : automaticKernel.visibleRasterRequests);
    const affine = affineFromQ16(framePlan.geometry.sourceToDeliveryQ16);
    const oracle = directQ16Oracle(hostile.length ? { data: hostile, width: plan.decodedCrop.width, height: plan.decodedCrop.height } : assert.fail(), plan.output, affine, framePlan.controls.opacityPhase / 255, framePlan.geometry.outputBounds!);
    assert.deepEqual(executed.surface.data, oracle, "runtime bytes must equal an independent Q16 associated-alpha inverse-affine oracle");
    const exactSupport = deriveReferencePrivateRgbaSourceAlphaBounds({
      ...executed.surface,
      alphaMode: "straight",
    });
    let left = executed.surface.width, top = executed.surface.height, right = 0, bottom = 0, nonzeroAlphaPixels = 0;
    for (let y = 0; y < executed.surface.height; y += 1) for (let x = 0; x < executed.surface.width; x += 1) {
      if (executed.surface.data[(y * executed.surface.width + x) * 4 + 3] === 0) continue;
      nonzeroAlphaPixels += 1;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    assert.deepEqual(exactSupport, {
      format: "cut-reference-private-rgba-source-alpha-bounds",
      version: 1,
      empty: nonzeroAlphaPixels === 0,
      left: nonzeroAlphaPixels === 0 ? 0 : left,
      top: nonzeroAlphaPixels === 0 ? 0 : top,
      right: nonzeroAlphaPixels === 0 ? 0 : right,
      bottom: nonzeroAlphaPixels === 0 ? 0 : bottom,
      nonzeroAlphaPixels,
      pixelsScanned: 0,
    }, "the Q16 write loop must publish independently exact alpha support without a second full-surface scan");
    let partial = 0;
    for (let offset = 0; offset < executed.surface.data.length; offset += 4) {
      const alpha = executed.surface.data[offset + 3]!;
      if (alpha === 0) assert.deepEqual([...executed.surface.data.subarray(offset, offset + 3)], [0, 0, 0], "hidden output RGB is cleared");
      else {
        assert.deepEqual([...executed.surface.data.subarray(offset, offset + 3)], [255, 0, 0], "transparent blue cannot contaminate associated-alpha filtering");
        if (alpha < 204) partial += 1;
      }
    }
    assert.ok(partial > 0, "rotated hostile-alpha edge must exercise partial coverage");

    const prefit = await sharp(hostile, { raw: { width: plan.decodedCrop.width, height: plan.decodedCrop.height, channels: 4 } })
      .resize(plan.output.width, plan.output.height, { fit: "fill", kernel: sharp.kernel.cubic }).raw().toBuffer();
    const baseScaleX = plan.output.width / plan.decodedCrop.width, baseScaleY = plan.output.height / plan.decodedCrop.height;
    const residual = Object.freeze({
      a: affine.a / baseScaleX, b: affine.b / baseScaleX, c: affine.c / baseScaleY, d: affine.d / baseScaleY,
      tx: affine.tx, ty: affine.ty,
    });
    const doubleRaster = directQ16Oracle(
      { data: prefit, width: plan.output.width, height: plan.output.height },
      plan.output,
      residual,
      framePlan.controls.opacityPhase / 255,
      { left: 0, top: 0, right: plan.output.width, bottom: plan.output.height },
    );
    assert.notEqual(createHash("sha256").update(doubleRaster).digest("hex"), executed.evidence.outputRgbaSha256, "a Sharp cubic fit followed by a second affine is observably not CUT's direct one-resample result");
    assert.equal(executed.evidence.allocations.geometricResampleCount, 1);
    assert.equal(executed.evidence.samplerExecutionIdentity?.length, 64);
    assert.throws(
      () => executeReferenceMediaCamera2DFrame(executionInput),
      /CUT_MEDIA_CAMERA_RASTER: MediaCamera2D at .*exact same-invocation aggregate scene admission receipt/u,
      "one admission member can authorize completion exactly once",
    );
    assert.throws(
      () => executeReferenceMediaCamera2DFrame({ ...executionInput, sceneAdmission: structuredClone(sceneAdmission) }),
      /CUT_MEDIA_CAMERA_RASTER: MediaCamera2D at .*exact same-invocation aggregate scene admission receipt/u,
      "a serialized/copied receipt is evidence, never invocation authority",
    );
    const revokedAdmission = admitReferenceMediaCamera2DSceneFrame(
      ir,
      composition,
      plan.sceneId,
      rational(0),
      [Object.freeze({ plan, framePlan })],
    );
    closeReferenceMediaCamera2DSceneAdmission(revokedAdmission);
    assert.throws(
      () => executeReferenceMediaCamera2DFrame({ ...executionInput, sceneAdmission: revokedAdmission }),
      /CUT_MEDIA_CAMERA_RASTER: MediaCamera2D at .*exact same-invocation aggregate scene admission receipt/u,
      "closing a renderer frame revokes every unused completion member",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the sole ColorGrade branch executes on the native crop before the same one-resample camera path", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const direct = (await renderWithCameraEvidence(await locked(root, imageProgram("focusX: 25%")), root, [0], "grade-direct")).results[0]!;
    const identity = (await renderWithCameraEvidence(await lockedAnimatedCameraGrade(root), root, [0], "grade-dynamic-identity-frame")).results[0]!;
    const linear = (await renderWithCameraEvidence(await locked(root, gradedImageProgram("exposure: 0.5")), root, [0], "grade-linear")).results[0]!;
    const backend = (await renderWithCameraEvidence(await locked(root, gradedImageProgram("saturation: 0.75")), root, [0], "grade-backend")).results[0]!;
    const ir = await locked(root, gradedImageProgram()), graded = (await renderWithCameraEvidence(ir, root, [0], "grade-native")).results[0]!;
    const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d")!;
    const plan = validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!).get(camera.id)!;
    assert.ok(plan.gradeNodeId);
    assert.equal(graded.evidence.gradeNodeId, plan.gradeNodeId);
    const cropBytes = plan.decodedCrop.pixels * 4;
    assert.deepEqual([
      identity.evidence.allocations.linearBalanceSurfaces,
      identity.evidence.allocations.backendGradeSurfaces,
      identity.evidence.allocations.colorGradeSurfaces,
      identity.evidence.work.colorGradePixelPasses,
      identity.evidence.work.maximumColorGradePixelWork,
    ], [0, 0, 0, 0, 0], "a useful dynamic grade's identity frame is an exact no-allocation passthrough");
    assert.equal(rgbaSha256(identity.surface), rgbaSha256(direct.surface), "a dynamic identity frame must not change sampled pixels");
    assert.equal(identity.evidence.work.maximumPixelWork, direct.evidence.work.maximumPixelWork, "a dynamic identity frame contributes no grade work");
    assert.deepEqual([
      linear.evidence.allocations.linearBalanceSurfaces,
      linear.evidence.allocations.backendGradeSurfaces,
      linear.evidence.allocations.colorGradeSurfaces,
      linear.evidence.work.colorGradePixelPasses,
      linear.evidence.work.maximumColorGradePixelWork,
    ], [1, 0, 1, 1, plan.decodedCrop.pixels]);
    assert.deepEqual([
      backend.evidence.allocations.linearBalanceSurfaces,
      backend.evidence.allocations.backendGradeSurfaces,
      backend.evidence.allocations.colorGradeSurfaces,
      backend.evidence.work.colorGradePixelPasses,
      backend.evidence.work.maximumColorGradePixelWork,
    ], [0, 1, 1, 1, plan.decodedCrop.pixels]);
    assert.deepEqual([
      graded.evidence.allocations.linearBalanceSurfaces,
      graded.evidence.allocations.backendGradeSurfaces,
      graded.evidence.allocations.colorGradeSurfaces,
      graded.evidence.work.colorGradePixelPasses,
      graded.evidence.work.maximumColorGradePixelWork,
    ], [1, 1, 2, 2, plan.decodedCrop.pixels * 2]);
    assert.equal(graded.evidence.allocations.linearBalanceRgbaBytes, cropBytes);
    assert.equal(graded.evidence.allocations.backendGradeRgbaBytes, cropBytes);
    assert.equal(graded.evidence.allocations.colorGradeRgbaBytes, cropBytes * 2);
    assert.equal(graded.evidence.work.maximumPixelWork, direct.evidence.work.maximumPixelWork + plan.decodedCrop.pixels * 2);
    assert.equal(graded.evidence.allocations.geometricResampleCount, 1);
    assert.equal(graded.evidence.allocations.compositionPrerasterCount, 0);
    assert.notEqual(rgbaSha256(graded.surface), rgbaSha256(direct.surface));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("static and exact-frame identities bind camera controls and sampled ColorGrade values without poisoning leaf decode reuse", async () => {
  const { root } = await imageFixture();
  try {
    const cameraA = await locked(root, imageProgram("focusX: 25%"));
    const cameraB = await locked(root, imageProgram("focusX: 35%"));
    const cameraPlanA = [...validateReferenceMediaCamera2DGraph(cameraA, cameraA.compositions[0]!).values()][0]!;
    const cameraPlanB = [...validateReferenceMediaCamera2DGraph(cameraB, cameraB.compositions[0]!).values()][0]!;
    assert.notEqual(cameraPlanA.semanticIdentity, cameraPlanB.semanticIdentity);
    assert.notEqual(
      referenceMediaCamera2DFramePlanAt(cameraA, cameraA.compositions[0]!, cameraPlanA, rational(0)).planIdentity,
      referenceMediaCamera2DFramePlanAt(cameraB, cameraB.compositions[0]!, cameraPlanB, rational(0)).planIdentity,
    );
    assert.equal(cameraPlanA.decodePlan.sourceSha256, cameraPlanB.decodePlan.sourceSha256);

    const gradeA = await locked(root, gradedImageProgram("exposure: 0.2"));
    const gradeB = await locked(root, gradedImageProgram("exposure: 0.4"));
    const gradePlanA = [...validateReferenceMediaCamera2DGraph(gradeA, gradeA.compositions[0]!).values()][0]!;
    const gradePlanB = [...validateReferenceMediaCamera2DGraph(gradeB, gradeB.compositions[0]!).values()][0]!;
    const gradeFrameA = referenceMediaCamera2DFramePlanAt(gradeA, gradeA.compositions[0]!, gradePlanA, rational(0));
    const gradeFrameB = referenceMediaCamera2DFramePlanAt(gradeB, gradeB.compositions[0]!, gradePlanB, rational(0));
    assert.notEqual(gradePlanA.semanticIdentity, gradePlanB.semanticIdentity);
    assert.notEqual(gradeFrameA.gradeExecutionIdentity, gradeFrameB.gradeExecutionIdentity);
    assert.notEqual(gradeFrameA.planIdentity, gradeFrameB.planIdentity);
    assert.equal(gradePlanA.decodePlan.sourceSha256, gradePlanB.decodePlan.sourceSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("frame admission rejects post-plan camera and ColorGrade signal mutation even when owner node hashes are stale", async () => {
  const { root } = await imageFixture();
  try {
    const cameraIr = await locked(root, cameraNullTrackProgram());
    const cameraNode = Object.values(cameraIr.nodes).find((node) => node.op === "cut.visual.media_camera2d")!;
    const cameraPlan = validateReferenceMediaCamera2DGraph(cameraIr, cameraIr.compositions[0]!).get(cameraNode.id)!;
    const cameraProperty = cameraNode.properties.opacity;
    assert.ok(cameraProperty && "signal" in cameraProperty);
    const cameraSignal = cameraIr.signals[cameraProperty.signal]!;
    assert.equal(cameraSignal.kind, "track");
    const cameraEvent = cameraSignal.events[0]!;
    assert.equal(cameraEvent.kind, "set");
    cameraEvent.value = { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(3, 4) };
    assert.throws(
      () => referenceMediaCamera2DFramePlanAt(cameraIr, cameraIr.compositions[0]!, cameraPlan, rational(3, 4)),
      /CUT_MEDIA_CAMERA_PREFLIGHT: MediaCamera2D at .*executable content changed after locked static planning/u,
    );

    const gradeIr = await lockedAnimatedCameraGrade(root);
    const gradeNode = Object.values(gradeIr.nodes).find((node) => node.op === "cut.visual.color_grade")!;
    const gradePlan = [...validateReferenceMediaCamera2DGraph(gradeIr, gradeIr.compositions[0]!).values()][0]!;
    const gradeProperty = gradeNode.properties.exposure;
    assert.ok(gradeProperty && "signal" in gradeProperty);
    const gradeSignal = gradeIr.signals[gradeProperty.signal]!;
    assert.equal(gradeSignal.kind, "track");
    const gradeEvent = gradeSignal.events[0]!;
    assert.equal(gradeEvent.kind, "animate");
    gradeEvent.to = { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(3, 4) };
    assert.throws(
      () => referenceMediaCamera2DFramePlanAt(gradeIr, gradeIr.compositions[0]!, gradePlan, rational(3, 4)),
      /CUT_MEDIA_CAMERA_PREFLIGHT: MediaCamera2D at .*executable content changed after locked static planning/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("grade execution rechecks the exact-frame identity after asynchronous media decode", async () => {
  const { root, rgba } = await imageFixture();
  try {
    const ir = await lockedAnimatedCameraGrade(root), composition = ir.compositions[0]!;
    const plan = [...validateReferenceMediaCamera2DGraph(ir, composition).values()][0]!;
    const framePlan = referenceMediaCamera2DFramePlanAt(ir, composition, plan, rational(3, 4));
    assert.ok(framePlan.gradeExecutionIdentity);
    const grade = ir.nodes[plan.gradeNodeId!]!, property = grade.properties.exposure;
    assert.ok(property && "signal" in property);
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "grade-race"));
    try {
      await renderer.prepare();
      const signal = ir.signals[property.signal]!;
      assert.equal(signal.kind, "track");
      const event = signal.events[0]!;
      assert.equal(event.kind, "animate");
      event.to = { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(3, 4) };
      const runtime = renderer as unknown as {
        colorGradeExecution(
          node: IRNode,
          surface: { data: Uint8Array; width: number; height: number },
          time: ReturnType<typeof rational>,
          expectedExecutionIdentity: string,
        ): Promise<unknown>;
      };
      await assert.rejects(
        runtime.colorGradeExecution(
          grade,
          { data: rgba, width: 8, height: 6 },
          rational(3, 4),
          framePlan.gradeExecutionIdentity,
        ),
        /CUT_MEDIA_CAMERA_PREFLIGHT: MediaCamera2D at .*configuration changed after exact-frame camera preflight/u,
      );
    } finally { await renderer.closeAndWait(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("graph admission rejects shared media leaves and shared ColorGrade children before decoder preparation", async () => {
  const { root } = await imageFixture();
  try {
    const sharedLeaf = structuredClone(await locked(root, twoCameraProgram()));
    const leafCameras = Object.values(sharedLeaf.nodes).filter((node) => node.op === "cut.visual.media_camera2d").sort((a, b) => a.id.localeCompare(b.id));
    const firstLeafId = leafCameras[0]!.children[0]!;
    leafCameras[1]!.children = [firstLeafId];
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(sharedLeaf, sharedLeaf.compositions[0]!),
      /CUT_MEDIA_CAMERA_GRAPH: MediaCamera2D at .*media leaf must have exactly one structural parent/u,
    );

    const sharedGrade = structuredClone(await locked(root, twoGradedCameraProgram()));
    const gradeCameras = Object.values(sharedGrade.nodes).filter((node) => node.op === "cut.visual.media_camera2d").sort((a, b) => a.id.localeCompare(b.id));
    const firstGradeId = gradeCameras[0]!.children[0]!;
    gradeCameras[1]!.children = [firstGradeId];
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(sharedGrade, sharedGrade.compositions[0]!),
      /CUT_MEDIA_CAMERA_GRAPH: MediaCamera2D at .*ColorGrade must have exactly one structural parent/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MediaCamera2D rejects static and dynamically default-equivalent ColorGrade wrappers on the complete output grid", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const staticIdentity = structuredClone(await locked(root, gradedImageProgram("exposure: 0.5")));
    const staticGrade = Object.values(staticIdentity.nodes).find((node) => node.op === "cut.visual.color_grade")!;
    delete staticGrade.inputs.exposure;
    finalizeGraphHashes(staticIdentity);
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(staticIdentity, staticIdentity.compositions[0]!),
      /CUT_MEDIA_CAMERA_GRAPH: MediaCamera2D at .*ColorGrade is identity on every exact output-frame sample; remove the no-op wrapper/u,
    );

    const dynamicIdentity = structuredClone(await lockedAnimatedCameraGrade(root));
    const grade = Object.values(dynamicIdentity.nodes).find((node) => node.op === "cut.visual.color_grade")!;
    const property = grade.properties.exposure;
    assert.ok(property && "signal" in property);
    const signal = dynamicIdentity.signals[property.signal], zero = { kind: "quantity" as const, dimension: "scalar", unit: "scalar", magnitude: rational(0) };
    if (signal.kind === "constant") signal.value = zero;
    else if (signal.kind === "step") for (const point of signal.points) point.value = zero;
    else if (signal.kind === "keyframes") for (const keyframe of signal.keyframes) keyframe.value = zero;
    else {
      signal.initial = zero;
      for (const event of signal.events) {
        if (event.kind === "set") event.value = zero;
        else { event.from = zero; event.to = zero; }
      }
    }
    signal.contentHash = cutSignalContentHash(signal);
    finalizeGraphHashes(dynamicIdentity);
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(dynamicIdentity, dynamicIdentity.compositions[0]!),
      /CUT_MEDIA_CAMERA_GRAPH: MediaCamera2D at .*ColorGrade is identity on every exact output-frame sample; remove the no-op wrapper/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ColorGrade exact-grid no-op proof shares the closed composition admission budget", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = structuredClone(await locked(root, twoGradedCameraProgram()));
    const composition = ir.compositions[0]!, scene = ir.scenes[composition.sceneIds[0]!]!;
    const duration = rational(251_000);
    composition.fps = rational(1);
    composition.duration = duration;
    composition.width = 1;
    composition.height = 1;
    scene.duration = duration;
    for (const node of Object.values(ir.nodes)) {
      node.interval.duration = duration;
      if (node.op === "cut.visual.media_camera2d") {
        delete node.inputs.focusX;
        node.inputs.opacity = { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(1, 2) };
      }
    }
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(ir, composition),
      /CUT_MEDIA_CAMERA_LIMIT: MediaCamera2D at .*ColorGrade exact-grid no-op proof requires 1757000 property evaluations across 251000 frames; 1741000 remain/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transparent and clamp edge policies are executable and opacity-zero never decodes media", { timeout: 90_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const transparentIr = await locked(root, imageProgram("focusX: 25%", "contain"));
    const clampIr = await locked(root, imageProgram('focusX: 25%, edge: "clamp"', "contain"));
    const transparentFrame = (await renderWithCameraEvidence(transparentIr, root, [0], "edge-transparent")).results[0]!;
    const clampFrame = (await renderWithCameraEvidence(clampIr, root, [0], "edge-clamp")).results[0]!;
    assert.equal(pixel(transparentFrame.surface, 4, 0)[3], 0);
    assert.equal(pixel(clampFrame.surface, 4, 0)[3], 255);
    assert.notEqual(rgbaSha256(transparentFrame.surface), rgbaSha256(clampFrame.surface));
    assert.equal(transparentFrame.evidence.allocations.clampPaddingSurfaces, 0);
    assert.equal(clampFrame.evidence.allocations.clampPaddingSurfaces, 1);
    assert.ok(clampFrame.evidence.work.clampPaddedPixels > 0);

    const zero = await locked(root, animatedOpacityProgram());
    const opacityFrames = (await renderWithCameraEvidence(zero, root, [0, 2], "opacity-zero")).results;
    const zeroFrame = opacityFrames[0]!, liveFrame = opacityFrames[1]!;
    assert.equal(zeroFrame.evidence.status, "opacity-zero");
    assert.deepEqual(zeroFrame.evidence.allocations, {
      sourceOpens: 0, readerPullAttempts: 0, decodedFramesRead: 0, decodedSurfaces: 0, decodedRgbaBytes: 0,
      managedColorConversionSurfaces: 0, managedColorConversionRgbaBytes: 0,
      decoderRetainedFrameCopies: 0, decoderRetainedFrameCopyRgbaBytes: 0,
      linearBalanceSurfaces: 0, linearBalanceRgbaBytes: 0,
      backendGradeSurfaces: 0, backendGradeRgbaBytes: 0,
      colorGradeSurfaces: 0, colorGradeRgbaBytes: 0, clampPaddingSurfaces: 0, clampPaddingRgbaBytes: 0,
      compositionPrerasterCount: 0, compositionPrerasterRgbaBytes: 0, geometricResampleCount: 0,
      outputSurfaces: 1, outputRgbaBytes: 8 * 8 * 4,
      outputHandoffCopies: 0, outputHandoffRgbaBytes: 0,
    });
    assert.ok(zeroFrame.surface.data.every((value) => value === 0));
    assert.equal(liveFrame.evidence.controls.opacity, 0.5);
    assert.equal(liveFrame.evidence.allocations.sourceOpens, 1);
    assert.equal(liveFrame.evidence.allocations.geometricResampleCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("clamp execution applies the admitted Q8 opacity phase to opaque replicated edges", async () => {
  const { root } = await imageFixture();
  try {
    const execution = (await renderWithCameraEvidence(
      await locked(root, imageProgram('focusX: 25%, opacity: 50%, edge: "clamp"', "contain")),
      root,
      [0],
      "clamp-q8-opacity",
    )).results[0]!;
    assert.equal(execution.evidence.controls.opacityPhase, 128);
    assert.equal(execution.evidence.controls.opacity, 0.5);
    assert.equal(pixel(execution.surface, 0, 0)[3], 128);
    assert.equal(execution.evidence.allocations.clampPaddingSurfaces, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Video camera preserves selected master/proxy native grids and locked cadence", { timeout: 120_000 }, async () => {
  const root = await videoFixture();
  try {
    const canonical = await locked(root, videoProgram());
    const masterIr = selectReferenceMediaProfile(canonical, "master").ir, proxyIr = selectReferenceMediaProfile(canonical, "proxy").ir;
    const master = await renderWithCameraEvidence(masterIr, root, [0, 1, 2, 3], "video-master");
    const proxy = await renderWithCameraEvidence(proxyIr, root, [0, 1, 2, 3], "video-proxy");
    assert.deepEqual(master.results[0]!.evidence.source.selectedVariant, "master");
    assert.deepEqual(proxy.results[0]!.evidence.source.selectedVariant, "proxy");
    assert.deepEqual(master.results[0]!.evidence.geometry.rasterSource, { width: 8, height: 6, pixels: 48, rgbaBytes: 192 });
    assert.deepEqual(proxy.results[0]!.evidence.geometry.rasterSource, { width: 4, height: 3, pixels: 12, rgbaBytes: 48 });
    assert.notEqual(master.results[0]!.evidence.source.sha256, proxy.results[0]!.evidence.source.sha256);
    assert.match(master.results[0]!.evidence.source.cadenceIdentity ?? "", /^[a-f0-9]{64}$/u);
    assert.match(proxy.results[0]!.evidence.source.cadenceIdentity ?? "", /^[a-f0-9]{64}$/u);
    assert.ok(master.results.every((entry) => entry.evidence.leafKind === "video" && entry.evidence.allocations.geometricResampleCount === 1));
    assert.ok(proxy.results.every((entry) => entry.evidence.leafKind === "video" && entry.evidence.allocations.geometricResampleCount === 1));
    assert.deepEqual(master.decoder.map((entry) => entry.mode), ["retained-native-crop-cfr-frame-index"]);
    assert.deepEqual(proxy.decoder.map((entry) => entry.mode), ["retained-native-crop-cfr-frame-index"]);
    assert.deepEqual(master.decoder[0]?.outputFps, rational(4));
    assert.deepEqual(proxy.decoder[0]?.outputFps, rational(4));
    assert.ok(new Set(master.results.map((entry) => rgbaSha256(entry.surface))).size > 1, "moving master frames must not collapse to a static decode");
    assert.ok(new Set(proxy.results.map((entry) => rgbaSha256(entry.surface))).size > 1, "moving proxy frames must not collapse to a static decode");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Video catch-up after an opacity-zero gap is fully admitted, color-accounted, peak-bounded, and receipt-bound", { timeout: 120_000 }, async () => {
  const root = await videoFixture();
  try {
    const ir = await locked(root, catchUpVideoProgram()), composition = ir.compositions[0]!, scene = ir.scenes[composition.sceneIds[0]!]!;
    const plan = [...validateReferenceMediaCamera2DGraph(ir, composition).values()][0]!;
    const framePlan = referenceMediaCamera2DFramePlanAt(ir, composition, plan, rational(3));
    assert.deepEqual(framePlan.videoDecode?.stateAtPreflight, { status: "unopened", lastFrame: -1, hasCurrentFrame: false });
    assert.equal(framePlan.videoDecode?.targetFrame, 12);
    assert.equal(framePlan.videoDecode?.frameLimit, 16);
    assert.equal(framePlan.videoDecode?.strategy, "sequential-catch-up");
    assert.deepEqual(framePlan.videoDecode?.planned, {
      sourceOpens: 1,
      readerPullAttempts: 13,
      decodedFramesRead: 13,
      decodedSurfaces: 13,
      decodedRgbaBytes: 13 * 8 * 6 * 4,
      managedColorConversionPasses: 13,
      managedColorConversionSurfaces: 13,
      managedColorConversionRgbaBytes: 13 * 8 * 6 * 4,
      decoderRetainedFrameCopies: 0,
      decoderRetainedFrameCopyRgbaBytes: 0,
    });
    assert.deepEqual(framePlan.videoDecode?.maximum, {
      decodePixelWork: 13 * 8 * 6,
      managedColorConversionPixelWork: 13 * 8 * 6,
      decoderPeakResidentSurfaces: 3,
      decoderPeakResidentRgbaBytes: 3 * 8 * 6 * 4,
    });
    const admission = admitReferenceMediaCamera2DSceneFrame(ir, composition, scene.id, rational(3), [{ plan, framePlan }]);
    assert.equal(admission.aggregate.plannedDecodedFramesRead, 13);
    assert.equal(admission.aggregate.plannedDecodedRgbaBytes, 13 * 8 * 6 * 4);
    assert.equal(admission.aggregate.plannedManagedColorConversionPasses, 13);
    assert.equal(admission.aggregate.plannedManagedColorConversionRgbaBytes, 13 * 8 * 6 * 4);
    assert.equal(admission.aggregate.maximumDecoderPeakResidentSurfaces, 3);
    assert.equal(admission.aggregate.maximumDecoderPeakResidentRgbaBytes, 3 * 8 * 6 * 4);
    assert.equal(admission.aggregate.conservativePeakRgbaBytes, 8 * 8 * 4 + 8 * 6 * 4 + 3 * 8 * 6 * 4);

    const rendered = await renderWithCameraEvidence(ir, root, [0, 12], "video-catch-up");
    const skipped = rendered.results[0]!.evidence, caughtUp = rendered.results[1]!.evidence;
    assert.equal(skipped.videoDecode?.strategy, "opacity-zero-skip");
    assert.equal(skipped.videoDecode?.planned.decodedFramesRead, 0);
    assert.deepEqual([
      caughtUp.allocations.sourceOpens,
      caughtUp.allocations.readerPullAttempts,
      caughtUp.allocations.decodedFramesRead,
      caughtUp.allocations.decodedSurfaces,
      caughtUp.allocations.managedColorConversionSurfaces,
    ], [1, 13, 13, 13, 13]);
    assert.deepEqual([
      caughtUp.allocations.decoderRetainedFrameCopies,
      caughtUp.allocations.decoderRetainedFrameCopyRgbaBytes,
      caughtUp.allocations.outputHandoffCopies,
      caughtUp.allocations.outputHandoffRgbaBytes,
    ], [0, 0, 0, 0], "camera execution retains the final decode/output allocations by shared view instead of hidden crop/delivery copies");
    assert.equal(caughtUp.videoDecode?.planIdentity, framePlan.videoDecode?.planIdentity);
    assert.equal(caughtUp.work.maximumDecodePixelWork, 13 * 8 * 6);
    assert.equal(caughtUp.work.maximumManagedColorConversionPixelWork, 13 * 8 * 6);
    const rootSchema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
    const validateCameraEvidence = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true })
      .compile({ ...rootSchema.definitions.mediaCamera2DFrameEvidence, definitions: rootSchema.definitions });
    assert.equal(validateCameraEvidence(caughtUp), true, JSON.stringify(validateCameraEvidence.errors));
    const missingDecodePlan = structuredClone(caughtUp) as unknown as { videoDecode?: unknown };
    delete missingDecodePlan.videoDecode;
    assert.equal(validateCameraEvidence(missingDecodePlan), false, "Video evidence requires the exact decoder-state/target plan");
    const hiddenRetainedCopy = structuredClone(caughtUp) as unknown as { allocations: { decoderRetainedFrameCopies: number } };
    hiddenRetainedCopy.allocations.decoderRetainedFrameCopies = 1;
    assert.equal(validateCameraEvidence(hiddenRetainedCopy), false, "the closed receipt cannot hide a crop-sized retained-frame copy");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("late sparse Video access fails before decoder open until bounded cadence-locked semantic seek exists", { timeout: 120_000 }, async () => {
  const root = await videoFixture();
  try {
    const ir = await locked(root, catchUpVideoProgram(200)), composition = ir.compositions[0]!, scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "video-sparse-bound"));
    try {
      await renderer.prepare();
      await assert.rejects(
        renderer.sceneFrame(scene, 600, false),
        new RegExp(`CUT_MEDIA_CAMERA_LIMIT: MediaCamera2D at .*sequential catch-up needs 601 decoded frames for target 600, exceeding ${referenceMediaCamera2DLimits.maximumSequentialVideoFramesReadPerSceneFrame}; bounded cadence-locked sparse seek is not implemented`, "u"),
      );
      const internals = renderer as unknown as { retainedMediaDecoders: Map<string, unknown> };
      assert.equal(internals.retainedMediaDecoders.size, 0, "the explicit sparse-seek limitation fails before FFmpeg opens");
    } finally { await renderer.closeAndWait(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("camera frame preflight is transactional and ordinary retained media keeps its legacy identity and pixels", { timeout: 90_000 }, async () => {
  const { root, rgba } = await imageFixture();
  try {
    const cameraIr = await locked(root, imageProgram("focusX: 25%"));
    const { composition } = validateReferenceSession(cameraIr, "out"), scene = cameraIr.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(cameraIr, composition, root, resolve(root, ".cut", "transaction"));
    try {
      await renderer.prepare();
      await renderer.sceneFrame(scene, 0, false);
      const completed = renderer.referenceMediaCamera2DEvidence();
      const camera = Object.values(cameraIr.nodes).find((node) => node.op === "cut.visual.media_camera2d")!;
      camera.inputs.zoom = { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(9) };
      await assert.rejects(renderer.sceneFrame(scene, 1, false), /CUT_MEDIA_CAMERA_PREFLIGHT.*executable content changed/u);
      assert.deepEqual(renderer.referenceMediaCamera2DEvidence(), completed, "failed whole-scene preflight must not publish partial/replacement camera receipts");
    } finally { await renderer.closeAndWait(); }

    const ordinaryIr = await locked(root, ordinaryProgram()), ordinaryComposition = ordinaryIr.compositions[0]!;
    const local = [...validateReferenceLocalSpaceGraph(ordinaryIr, ordinaryComposition).values()]
      .find((config) => config.retainedMediaViewport)?.retainedMediaViewport;
    assert.ok(local);
    assert.equal(local.resample, "sharp-bicubic-fit-then-cut-q16-associated-bilinear-affine", "ordinary retained-media identity remains unchanged");
    const ordinaryScene = ordinaryIr.scenes[ordinaryComposition.sceneIds[0]!]!, ordinaryRenderer = new ReferenceVisualRenderer(ordinaryIr, ordinaryComposition, root, resolve(root, ".cut", "ordinary-regression"));
    try {
      await ordinaryRenderer.prepare();
      const surface = await ordinaryRenderer.sceneFrame(ordinaryScene, 0, false);
      assert.deepEqual(surface.data, rgba, "legacy identity widening must not alter ordinary same-size retained Image pixels");
      assert.equal(ordinaryRenderer.referenceMediaCamera2DEvidence().length, 0);
    } finally { await ordinaryRenderer.closeAndWait(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a hostile loaded null-initial camera track cannot discard its canonical constructor baseline", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = structuredClone(await locked(root, cameraNullTrackProgram()));
    const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d")!;
    const property = camera.properties.opacity;
    assert.ok(property && "signal" in property);
    const signal = ir.signals[property.signal];
    assert.equal(signal.kind, "track");
    if (signal.kind !== "track") return;
    signal.initial = { kind: "null" };
    signal.contentHash = cutSignalContentHash(signal);
    finalizeGraphHashes(ir);
    assert.throws(
      () => loadCutAvIr(JSON.stringify(ir)),
      /CUT_MEDIA_CAMERA_VALUE at .*: opacity track must carry its exact constructor\/public-default baseline/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all camera roots preflight before concurrent root work or media decode begins", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, twoCameraProgram()), { composition } = validateReferenceSession(ir, "out"), scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "whole-set-preflight"));
    try {
      await renderer.prepare();
      const cameras = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.media_camera2d").sort((left, right) => left.id.localeCompare(right.id));
      assert.equal(cameras.length, 2);
      cameras[1]!.inputs.zoom = { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(9) };
      await assert.rejects(renderer.sceneFrame(scene, 0, false), /CUT_MEDIA_CAMERA_PREFLIGHT.*executable content changed/u);
      const internals = renderer as unknown as { retainedMediaStaticImages: Map<string, unknown> };
      assert.equal(internals.retainedMediaStaticImages.size, 0, "a later failing camera plan must prevent an earlier sibling from decoding");
      assert.deepEqual(renderer.referenceMediaCamera2DEvidence(), [], "failed whole-set admission cannot publish sibling receipts");
    } finally { await renderer.closeAndWait(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scene-wide camera admission closes aggregate work and unique-source accounting before root execution", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, twoCameraProgram()), composition = ir.compositions[0]!, scene = ir.scenes[composition.sceneIds[0]!]!;
    const plans = validateReferenceMediaCamera2DGraph(ir, composition);
    const frames = [...plans.values()].map((plan) => ({ plan, framePlan: referenceMediaCamera2DFramePlanAt(ir, composition, plan, rational(0)) }));
    const admission = admitReferenceMediaCamera2DSceneFrame(ir, composition, scene.id, rational(0), frames);
    const one = frames[0]!, sourceBytes = one.plan.source.resourceBytes;
    assert.equal(admission.cameraCount, 2);
    assert.equal(admission.visibleCameraCount, 2);
    assert.equal(admission.opacityZeroCameraCount, 0);
    assert.equal(admission.aggregate.uniqueSourceFileBytes, sourceBytes, "a shared locked source is counted once in the scene byte set");
    assert.equal(admission.aggregate.nativePixels, one.plan.native.pixels * 2);
    assert.equal(admission.aggregate.nativeRgbaBytes, one.plan.native.pixels * 2 * 4);
    assert.equal(admission.aggregate.decodedCropPixels, one.plan.decodedCrop.pixels * 2);
    assert.equal(admission.aggregate.decodedCropRgbaBytes, one.plan.decodedCrop.pixels * 2 * 4);
    assert.equal(admission.aggregate.outputPixels, one.plan.output.pixels * 2);
    assert.equal(admission.aggregate.outputRgbaBytes, one.plan.output.rgbaBytes * 2);
    assert.equal(admission.aggregate.colorGradePixelPasses, 0);
    assert.equal(admission.aggregate.maximumColorGradePixelWork, 0);
    assert.equal(admission.aggregate.concurrentVideoDecoders, 0);
    assert.equal(admission.aggregate.maximumBilinearSampleVisits, frames.reduce((sum, item) => sum + item.framePlan.work.maximumBilinearSampleVisits, 0));
    assert.equal(admission.aggregate.maximumPixelWork, frames.reduce((sum, item) => sum + item.framePlan.work.maximumPixelWork, 0));
    assert.match(admission.admissionIdentity, /^[a-f0-9]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("static scene admission rejects a fifth concurrent camera Video decoder before resource preparation", { timeout: 120_000 }, async () => {
  const root = await videoFixture();
  try {
    const canonical = await locked(root, multiVideoCameraProgram(referenceMediaCamera2DLimits.maximumConcurrentVideoDecoders + 1));
    const ir = selectReferenceMediaProfile(canonical, "master").ir, composition = ir.compositions[0]!;
    assert.throws(
      () => new ReferenceVisualRenderer(ir, composition, resolve(root, "unavailable-before-admission"), resolve(root, ".cut", "decoder-admission")),
      new RegExp(`CUT_MEDIA_CAMERA_LIMIT: MediaCamera2D at .*static scene aggregate concurrent video decoders ${referenceMediaCamera2DLimits.maximumConcurrentVideoDecoders + 1} exceeds ${referenceMediaCamera2DLimits.maximumConcurrentVideoDecoders} before resource locators are resolved`, "u"),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("composition admission caps distinct camera snapshot bytes across otherwise-local scenes", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = structuredClone(await locked(root, multiSourceImageProgram(3)));
    for (const resource of Object.values(ir.resources)) {
      resource.metadata!.bytes = referenceMediaCamera2DLimits.maximumSourceBytes;
    }
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!),
      new RegExp(`CUT_MEDIA_CAMERA_LIMIT: MediaCamera2D at .*composition camera source bytes ${referenceMediaCamera2DLimits.maximumSourceBytes * 3} exceed ${referenceMediaCamera2DLimits.maximumCompositionUniqueSourceBytes} before verified-input snapshots are created`, "u"),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scene admission derives the complete unique camera-root set and canonicalizes caller order", async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, twoCameraProgram()), composition = ir.compositions[0]!;
    const plans = [...validateReferenceMediaCamera2DGraph(ir, composition).values()];
    const frames = plans.map((plan) => Object.freeze({
      plan,
      framePlan: referenceMediaCamera2DFramePlanAt(ir, composition, plan, rational(0)),
    }));
    assert.equal(frames.length, 2);
    assert.throws(
      () => admitReferenceMediaCamera2DSceneFrame(ir, composition, frames[0]!.plan.sceneId, rational(0), [frames[0]!]),
      /CUT_MEDIA_CAMERA_PREFLIGHT: MediaCamera2D at .*exactly one frame plan for each direct MediaCamera2D root/u,
    );
    assert.throws(
      () => admitReferenceMediaCamera2DSceneFrame(ir, composition, frames[0]!.plan.sceneId, rational(0), [frames[0]!, frames[0]!]),
      /CUT_MEDIA_CAMERA_PREFLIGHT: MediaCamera2D at .*exactly one frame plan for each direct MediaCamera2D root/u,
    );
    const admission = admitReferenceMediaCamera2DSceneFrame(
      ir,
      composition,
      frames[0]!.plan.sceneId,
      rational(0),
      [...frames].reverse(),
    );
    assert.deepEqual(admission.members.map((member) => member.cameraNodeId), plans.map((plan) => plan.cameraNodeId).sort());
    assert.equal(new Set(admission.members.map((member) => member.cameraNodeId)).size, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every camera completed by one renderer frame embeds the same complete one-member-per-camera admission", async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, twoCameraProgram());
    const { composition } = validateReferenceSession(ir, "out"), scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "multi-camera-admission"));
    try {
      await renderer.prepare();
      await renderer.sceneFrame(scene, 0, false);
      const evidence = renderer.referenceMediaCamera2DEvidence();
      assert.equal(evidence.length, 2);
      const [first, second] = evidence;
      assert.equal(first!.sceneAdmission.admissionIdentity, second!.sceneAdmission.admissionIdentity);
      assert.deepEqual(first!.sceneAdmission.members, second!.sceneAdmission.members);
      assert.equal(first!.sceneAdmission.cameraCount, 2);
      assert.equal(new Set(first!.sceneAdmission.members.map((member) => member.cameraNodeId)).size, 2);
      for (const item of evidence) {
        const member = item.sceneAdmission.members.filter((candidate) => candidate.cameraNodeId === item.cameraNodeId);
        assert.equal(member.length, 1);
        assert.equal(member[0]!.framePlanIdentity, item.framePlanIdentity);
      }
    } finally { await renderer.closeAndWait(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verified-input session enforces its locked-byte budget before creating snapshots", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, multiSourceImageProgram(3));
    await assert.rejects(
      prepareReferenceVerifiedInputSession(ir, root, "master", { limits: { maxAggregateBytes: 1n } }),
      /CUT_INPUT_SESSION_RESOURCE_LIMIT: Locked master resource .* exceeds the exact per-file input budget/u,
    );
    await assert.rejects(lstat(resolve(root, ".cut")), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspect and frame-v2 expose closed direct-affine camera semantics without private paths", { timeout: 90_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, gradedImageProgram("exposure: 0.5, saturation: 0.75"));
    const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.media_camera2d")!;
    const inspectedNode = inspectCutIr(ir, "main.cut").graph.nodes.find((node) => node.id === camera.id);
    const inspected = (inspectedNode as unknown as { mediaCamera2D?: {
      backendIdentity: string;
      framing: { transformOrder: readonly string[]; decodedCrop: { width: number; height: number } };
      sampling: { mode: string; sourceResolutionDecode: boolean; compositionPrerasterCount: number; geometricResampleCount: string };
      firstFrame: { controls: { focusX: number; focusY: number; zoom: number; rotationDegrees: number; edge: string } };
    } } | undefined)?.mediaCamera2D;
    assert.ok(inspected);
    assert.equal(inspected.backendIdentity, "cut-q16-associated-alpha-bilinear-direct-affine-v1");
    assert.deepEqual(inspected.framing.transformOrder, ["fit-scale", "focus-to-delivery-centre", "zoom", "rotate-about-delivery-centre", "opacity"]);
    assert.deepEqual(inspected.framing.decodedCrop, { left: 0, top: 0, width: 8, height: 6, pixels: 48 });
    assert.deepEqual(inspected.sampling, {
      mode: "cut-q16-associated-bilinear-direct-affine",
      sourceResolutionDecode: true,
      compositionPrerasterCount: 0,
      geometricResampleCount: "zero-when-opacity-zero-otherwise-one",
    });
    assert.deepEqual(inspected.firstFrame.controls, { focusX: 0.25, focusY: 0.5, zoom: 1, rotationDegrees: 0, opacity: 1, opacityPhase: 255, edge: "transparent" });
    assert.doesNotMatch(JSON.stringify(inspected), /(?:source\.png|\/private\/|\/Users\/|sharp|bicubic)/iu);

    const output = resolve(root, "review", "media-camera2d.png");
    const manifest = await renderReferenceFrameArtifact(ir, root, output, { frame: 0, mediaProfile: "master" });
    const mediaCamera2Ds = (manifest.execution as unknown as { mediaCamera2Ds?: Array<Record<string, unknown>> }).mediaCamera2Ds;
    assert.equal(mediaCamera2Ds?.length, 1);
    assert.equal(mediaCamera2Ds?.[0]?.cameraNodeId, camera.id);
    assert.equal((mediaCamera2Ds?.[0]?.allocations as { colorGradeSurfaces?: number }).colorGradeSurfaces, 2);
    assert.match(String(mediaCamera2Ds?.[0]?.gradeExecutionIdentity), /^[a-f0-9]{64}$/u);
    assert.equal((mediaCamera2Ds?.[0]?.work as { colorGradePixelPasses?: number }).colorGradePixelPasses, 2);
    assert.equal((mediaCamera2Ds?.[0]?.allocations as { compositionPrerasterCount?: number }).compositionPrerasterCount, 0);
    assert.equal((mediaCamera2Ds?.[0]?.allocations as { geometricResampleCount?: number }).geometricResampleCount, 1);
    const admission = mediaCamera2Ds?.[0]?.sceneAdmission as {
      admissionIdentity?: string;
      cameraCount?: number;
      members?: Array<{ cameraNodeId?: string; planIdentity?: string; framePlanIdentity?: string }>;
    };
    assert.equal(admission.admissionIdentity?.length, 64);
    assert.equal(admission.cameraCount, 1);
    assert.equal(admission.members?.length, 1);
    assert.equal(admission.members?.[0]?.cameraNodeId, camera.id);
    assert.equal(admission.members?.[0]?.framePlanIdentity, mediaCamera2Ds?.[0]?.framePlanIdentity);
    assert.equal(admission.members?.[0]?.planIdentity?.length, 64);
    assert.equal((mediaCamera2Ds?.[0]?.observability as { format?: string }).format, "cut-reference-media-camera2d-q16-observability");

    const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
    const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
    const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
    assert.equal(validate(persisted), true, JSON.stringify(validate.errors));
    const persistedCache = persisted.execution.mediaCamera2Ds[0].staticGradeCache;
    assert.deepEqual({
      status: persistedCache.status,
      residentCopies: persistedCache.residentCopies,
      residentCopyRgbaBytes: persistedCache.residentCopyRgbaBytes,
      handoffCopies: persistedCache.handoffCopies,
      handoffRgbaBytes: persistedCache.handoffRgbaBytes,
      leaseHandoffs: persistedCache.leaseHandoffs,
      leaseRgbaBytes: persistedCache.leaseRgbaBytes,
    }, {
      status: "miss",
      residentCopies: 1,
      residentCopyRgbaBytes: 8 * 6 * 4,
      handoffCopies: 0,
      handoffRgbaBytes: 0,
      leaseHandoffs: 0,
      leaseRgbaBytes: 0,
    });
    const legacyCacheOmission = structuredClone(persisted);
    delete legacyCacheOmission.execution.mediaCamera2Ds[0].staticGradeCache;
    assert.equal(validate(legacyCacheOmission), true, "historical direct-grade frame evidence may omit the additive cache receipt");
    for (const mutate of [
      (entry: any) => { entry.staticGradeCache.sourceRgbaSha256 = "0".repeat(63); },
      (entry: any) => { entry.staticGradeCache.outputRgbaSha256 = "0".repeat(63); },
      (entry: any) => { entry.staticGradeCache.cacheIdentity = "0".repeat(63); },
      (entry: any) => { entry.staticGradeCache.residentCopies = 0; },
      (entry: any) => { entry.staticGradeCache.residentCopyRgbaBytes = 0; },
      (entry: any) => { entry.staticGradeCache.handoffCopies = 1; },
      (entry: any) => { entry.staticGradeCache.handoffRgbaBytes = 4; },
      (entry: any) => { entry.staticGradeCache.leaseHandoffs = 1; },
      (entry: any) => { entry.staticGradeCache.leaseRgbaBytes = 4; },
      (entry: any) => { entry.staticGradeCache.entries = 9; },
      (entry: any) => { entry.staticGradeCache.residentBytes = 67_108_865; },
    ]) {
      const hostile = structuredClone(persisted);
      mutate(hostile.execution.mediaCamera2Ds[0]);
      assert.equal(validate(hostile), false, "static-grade cache receipt mutations must fail the closed frame schema");
    }
    const validHit = structuredClone(persisted);
    const hitEntry = validHit.execution.mediaCamera2Ds[0];
    Object.assign(hitEntry.staticGradeCache, {
      status: "hit",
      residentCopies: 0,
      residentCopyRgbaBytes: 0,
      handoffCopies: 1,
      handoffRgbaBytes: 8 * 6 * 4,
      leaseHandoffs: 0,
      leaseRgbaBytes: 0,
    });
    Object.assign(hitEntry.allocations, {
      linearBalanceSurfaces: 0,
      linearBalanceRgbaBytes: 0,
      backendGradeSurfaces: 0,
      backendGradeRgbaBytes: 0,
      colorGradeSurfaces: 0,
      colorGradeRgbaBytes: 0,
    });
    assert.equal(validate(validHit), true, JSON.stringify(validate.errors));
    const historicalV1CopiedHit = structuredClone(validHit);
    historicalV1CopiedHit.execution.mediaCamera2Ds[0].staticGradeCache.algorithmVersion = "cut-reference-static-media-grade-cache-v1";
    delete historicalV1CopiedHit.execution.mediaCamera2Ds[0].staticGradeCache.leaseHandoffs;
    delete historicalV1CopiedHit.execution.mediaCamera2Ds[0].staticGradeCache.leaseRgbaBytes;
    assert.equal(validate(historicalV1CopiedHit), true, JSON.stringify(validate.errors));
    const forgedV1Lease = structuredClone(historicalV1CopiedHit);
    Object.assign(forgedV1Lease.execution.mediaCamera2Ds[0].staticGradeCache, {
      handoffCopies: 0,
      handoffRgbaBytes: 0,
      leaseHandoffs: 1,
      leaseRgbaBytes: 8 * 6 * 4,
    });
    assert.equal(validate(forgedV1Lease), false, "historical v1 evidence cannot claim the v2 cache-private lease branch");
    const hitWithGradeAllocation = structuredClone(validHit);
    hitWithGradeAllocation.execution.mediaCamera2Ds[0].allocations.linearBalanceSurfaces = 1;
    hitWithGradeAllocation.execution.mediaCamera2Ds[0].allocations.linearBalanceRgbaBytes = 8 * 6 * 4;
    assert.equal(validate(hitWithGradeAllocation), false, "cache hits cannot claim repeated grade allocation");

    const noGradeBase = structuredClone(persisted);
    const noGradeEntry = noGradeBase.execution.mediaCamera2Ds[0];
    delete noGradeEntry.staticGradeCache;
    delete noGradeEntry.gradeNodeId;
    delete noGradeEntry.gradeExecutionIdentity;
    Object.assign(noGradeEntry.allocations, {
      linearBalanceSurfaces: 0,
      linearBalanceRgbaBytes: 0,
      backendGradeSurfaces: 0,
      backendGradeRgbaBytes: 0,
      colorGradeSurfaces: 0,
      colorGradeRgbaBytes: 0,
    });
    Object.assign(noGradeEntry.work, {
      colorGradePixelPasses: 0,
      maximumColorGradePixelWork: 0,
    });
    assert.equal(validate(noGradeBase), true, JSON.stringify(validate.errors));
    const illegalCacheOwner = structuredClone(noGradeBase);
    illegalCacheOwner.execution.mediaCamera2Ds[0].staticGradeCache = persistedCache;
    assert.equal(validate(illegalCacheOwner), false, "an otherwise-valid no-grade camera cannot carry cache evidence");
    const illegalCacheSkip = structuredClone(persisted);
    illegalCacheSkip.execution.mediaCamera2Ds[0].status = "opacity-zero";
    assert.equal(validate(illegalCacheSkip), false, "cache evidence cannot attach to an opacity-zero camera");

    const unknown = structuredClone(persisted);
    unknown.execution.mediaCamera2Ds[0].silentlyIgnored = true;
    assert.equal(validate(unknown), false, "camera receipts reject unknown fields");
    const missing = structuredClone(persisted);
    delete missing.execution.mediaCamera2Ds[0].controls;
    assert.equal(validate(missing), false, "camera receipts require sampled controls");
    const missingObservability = structuredClone(persisted);
    delete missingObservability.execution.mediaCamera2Ds[0].observability;
    assert.equal(validate(missingObservability), false, "current-writer camera receipts require locked-grid observability");
    const missingAdmission = structuredClone(persisted);
    delete missingAdmission.execution.mediaCamera2Ds[0].sceneAdmission;
    assert.equal(validate(missingAdmission), false, "current-writer camera receipts require aggregate scene admission");
    const contradictorySampler = structuredClone(persisted);
    contradictorySampler.execution.mediaCamera2Ds[0].allocations.geometricResampleCount = 0;
    assert.equal(validate(contradictorySampler), false, "rendered direct-affine receipts require exactly one resample");
    const contradictoryBackend = structuredClone(persisted);
    contradictoryBackend.execution.mediaCamera2Ds[0].backendIdentity = "sharp-bicubic-fit";
    assert.equal(validate(contradictoryBackend), false, "camera evidence cannot claim a preliminary Sharp fit backend");
    const missingGradeOwner = structuredClone(persisted);
    delete missingGradeOwner.execution.mediaCamera2Ds[0].gradeNodeId;
    assert.equal(validate(missingGradeOwner), false, "grade allocations require an admitted public ColorGrade node");
    const missingGradeExecutionIdentity = structuredClone(persisted);
    delete missingGradeExecutionIdentity.execution.mediaCamera2Ds[0].gradeExecutionIdentity;
    assert.equal(validate(missingGradeExecutionIdentity), false, "a rendered ColorGrade camera requires explicit sampled grade identity");
    const missingLinearAllocation = structuredClone(persisted);
    missingLinearAllocation.execution.mediaCamera2Ds[0].allocations.linearBalanceSurfaces = 0;
    assert.equal(validate(missingLinearAllocation), false, "linear-balance bytes cannot survive a zero-surface receipt");
    const contradictorySource = structuredClone(persisted);
    contradictorySource.execution.mediaCamera2Ds[0].source.leafKind = "video";
    contradictorySource.execution.mediaCamera2Ds[0].source.selectedVariant = "master";
    assert.equal(validate(contradictorySource), false, "an Image receipt cannot claim a Video/profile source shape");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime graph admission rejects hostile descendant transforms with a source-located stable code", { timeout: 60_000 }, async () => {
  const { root } = await imageFixture();
  try {
    const ir = await locked(root, imageProgram("focusX: 25%")), composition = ir.compositions[0]!;
    const leaf = Object.values(ir.nodes).find((node) => node.op === "cut.visual.image")! as IRNode;
    leaf.inputs.x = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(1) };
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(ir, composition),
      (error: unknown) => error instanceof Error && /CUT_MEDIA_CAMERA_GRAPH: MediaCamera2D at .*Image inputs contains unsupported field x/u.test(error.message),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
