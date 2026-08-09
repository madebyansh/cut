import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import {
  referenceLocalSpacePlacementIdentity,
  referenceLocalSpaceTileIdentity,
  validateReferenceLocalSpaceGraph,
  type ReferenceLocalSpacePlacement,
} from "../lib/runtime/reference/local-space";
import {
  executeReferenceLocalSpaceScaleTranslation,
  planReferenceLocalSpaceScaleTranslation,
  ReferenceLocalSpaceScaleTranslationError,
  referenceLocalSpaceScaleTranslationAlgorithmVersion,
  referenceLocalSpaceScaleTranslationSampler,
} from "../lib/runtime/reference/local-space-scale-translation";
import {
  planReferenceLocalSpaceAffineCompositionTransformWork,
  planReferenceLocalSpaceCompositionTransformWork,
  planReferenceLocalSpaceTileTransformWork,
  ReferenceLocalSpaceTransformWorkError,
  referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion,
  referenceLocalSpaceResizeGeometry,
  referenceLocalSpaceTransformWorkLimits,
} from "../lib/runtime/reference/local-space-transform-work";
import { placeReferenceProjectiveWarpOnCanvas } from "../lib/runtime/reference/projective-warp-canvas";
import {
  planReferenceProjectiveWarp,
  rasterReferenceProjectiveWarp,
  referenceProjectiveWarpPhaseUnits,
} from "../lib/runtime/reference/projective-warp-kernel";
import {
  referenceRetainedSurfaceAlphaSupportAlgorithmVersion,
  translateReferenceRetainedSurface,
} from "../lib/runtime/reference/retained-surface";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  referenceLocalSpaceAlphaBoundedTranslationAlgorithmVersion,
  ReferenceVisualRenderer,
  validateReferenceLocalSpaceTransformExecutionPlan,
} from "../lib/runtime/reference/visual";

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

const diagnosticNode: IRNode = {
  id: "scale_translation_owner",
  op: "cut.visual.group",
  domain: "visual",
  ownership: "detached",
  sceneId: "scene",
  interval: { start: rational(0), duration: rational(1) },
  inputs: {},
  children: [],
  properties: {},
  effects: ["pure"],
  contentHash: "scale-translation-owner",
  provenance: {
    module: "scale-translation-proof.cut",
    span: {
      start: { offset: 20, line: 4, column: 3 },
      end: { offset: 40, line: 4, column: 23 },
    },
  },
};

function placement(overrides: Partial<ReferenceLocalSpacePlacement> = {}): ReferenceLocalSpacePlacement {
  return Object.freeze({
    owner: "group",
    contextIdentity: "scale-translation-proof",
    destinationX: 2.2,
    destinationY: 1.7,
    registrationRasterX: 2,
    registrationRasterY: 2,
    scale: 0.75,
    skewX: 0,
    skewY: 0,
    rotation: 0,
    opacity: 1,
    ...overrides,
  });
}

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(
    checked.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(checked.diagnostics),
  );
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  return ir;
}

function publicSource(owner: "camera" | "group", motionBlur = false) {
  const retained = `${owner === "camera"
    ? "Camera2D(x: 0.25px, y: 0.3px, scale: 0.68)"
    : "Group(x: 0.25px, y: 0.3px, scale: 0.68)"} {
      LocalSpace(width: 96px, height: 60px, origin: { x: 48px, y: 30px }) {
        Rect(width: 96px, height: 60px, fill: #102d38);
        Rect(width: 2px, height: 52px, x: -18px, fill: #f3e9d2);
        Rect(width: 2px, height: 52px, x: 0px, fill: #f27443);
        Rect(width: 2px, height: 52px, x: 18px, fill: #4fc3b4);
      }
    }`;
  const body = motionBlur
    ? `MotionBlur(shutterAngle: 180deg, samples: 2, startEdge: "hold") { ${retained} }`
    : retained;
  return `cut 0.4;
project "retained scale translation ${owner} proof";
import { Camera2D, Group, LocalSpace, MotionBlur, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 64px, height: 40px, sampleRate: 8khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 64px, height: 40px, codec: "h264");`;
}

function sharpnessSource(scale = 0.68, x = 0.25, y = 0.3) {
  return `cut 0.4;
project "retained scale translation sharpness proof";
import { Camera2D, LocalSpace, Path, Rect, Text } from "cut:visual";
asset face: FontAsset = font("assets/face.ttf");
timeline main(duration: 1s, fps: 4, width: 64px, height: 40px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Camera2D(x: ${x}px, y: ${y}px, scale: ${scale}) {
      LocalSpace(width: 96px, height: 60px, origin: { x: 48px, y: 30px }) {
        Rect(width: 96px, height: 60px, fill: #102d38);
        Path(points: [{ x: -44px, y: 9px }, { x: -18px, y: -6px }, { x: 3px, y: 8px }, { x: 43px, y: -11px }], stroke: #f27443, width: 1px);
        Path(points: [{ x: -44px, y: 13px }, { x: -12px, y: 13px }, { x: 8px, y: -2px }, { x: 43px, y: -2px }], stroke: #4fc3b4, width: 1px);
        Text(content: "FLOW 23.2M", font: face, size: 11px, color: #f3e9d2, x: 0px, y: -13px, maxWidth: 84px, tracking: 0.2px);
        Rect(width: 1px, height: 48px, x: -31px, fill: #f3e9d2);
        Rect(width: 1px, height: 48px, x: 31px, fill: #f3e9d2);
      }
    }
  }
}
export out = render(main, width: 64px, height: 40px, codec: "h264");`;
}

async function lockedSharpnessProject(source = sharpnessSource()) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-scale-translation-font-"));
  await mkdir(resolve(root, "assets"));
  await copyFile(resolve("examples/fixtures/Geist-Regular.ttf"), resolve(root, "assets", "face.ttf"));
  const ir = compile(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { root, ir };
}

type CapturedSurface = Readonly<{ data: Buffer; width: number; height: number }>;

async function renderFrames(ir: CutAVIR, frames: readonly number[], projectRoot?: string) {
  const scratch = await mkdtemp(resolve(tmpdir(), "cut-local-scale-translation-"));
  const root = projectRoot ?? scratch;
  const session = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(
    ir,
    session.composition,
    root,
    resolve(root, ".cut-cache-test"),
  );
  await renderer.prepare();
  try {
    const scene = ir.scenes[session.composition.sceneIds[0]]!;
    const results = [];
    for (const frame of frames) {
      const surface = await renderer.sceneFrame(scene, frame, false);
      const tilePromise = [...(renderer as unknown as {
        localSpaceTileMemo: Map<string, Promise<CapturedSurface>>;
      }).localSpaceTileMemo.values()][0];
      const tile = tilePromise ? await tilePromise : undefined;
      results.push({
        surface,
        ...(tile ? {
          tile: {
            data: Buffer.from(tile.data),
            width: tile.width,
            height: tile.height,
          },
        } : {}),
        evidence: renderer.referenceLocalSpaceEvidence()!,
      });
    }
    return results;
  } finally {
    await renderer.closeAndWait();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function legacyResizeThenTranslate(
  tile: CapturedSurface,
  destination: Readonly<{ width: number; height: number }>,
  transform: NonNullable<
    ReturnType<ReferenceVisualRenderer["referenceLocalSpaceEvidence"]>
  >["placements"][number]["transform"],
) {
  assert.ok(transform);
  const resize = referenceLocalSpaceResizeGeometry(tile.width, tile.height, transform.scale);
  let resized: CapturedSurface = tile;
  if (resize.requestedWidth !== tile.width || resize.requestedHeight !== tile.height) {
    const straight = new Uint16Array(tile.width * tile.height * 4);
    for (let offset = 0; offset < straight.length; offset += 4) {
      straight[offset] = tile.data[offset]! * 257;
      straight[offset + 1] = tile.data[offset + 1]! * 257;
      straight[offset + 2] = tile.data[offset + 2]! * 257;
      straight[offset + 3] = tile.data[offset + 3]! * 257;
    }
    const associated = new Uint16Array(straight.length);
    for (let offset = 0; offset < associated.length; offset += 4) {
      const alpha = straight[offset + 3]!;
      associated[offset] = Math.round(straight[offset]! * alpha / 65_535);
      associated[offset + 1] = Math.round(straight[offset + 1]! * alpha / 65_535);
      associated[offset + 2] = Math.round(straight[offset + 2]! * alpha / 65_535);
      associated[offset + 3] = alpha;
    }
    let pipeline = sharp(associated, {
      raw: { width: tile.width, height: tile.height, channels: 4, premultiplied: true },
    }).pipelineColourspace("rgb16")
      .resize(resize.sharpCoverWidth, resize.sharpCoverHeight, { fit: "fill" });
    if (resize.sharpCoverWidth !== resize.requestedWidth
      || resize.sharpCoverHeight !== resize.requestedHeight) {
      pipeline = pipeline.extract({
        left: resize.cropLeft,
        top: resize.cropTop,
        width: resize.requestedWidth,
        height: resize.requestedHeight,
      });
    }
    const filtered = await pipeline.toColourspace("rgb16")
      .raw({ depth: "ushort" })
      .toBuffer({ resolveWithObject: true });
    const words = new Uint16Array(
      filtered.data.buffer,
      filtered.data.byteOffset,
      filtered.data.byteLength / Uint16Array.BYTES_PER_ELEMENT,
    );
    const bytes = Buffer.alloc(resize.requestedWidth * resize.requestedHeight * 4);
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const alpha = Math.max(0, Math.min(255, Math.round(words[offset + 3]! / 257)));
      bytes[offset + 3] = alpha;
      if (alpha === 0) continue;
      bytes[offset] = Math.max(0, Math.min(255, Math.round(words[offset]! / 257)));
      bytes[offset + 1] = Math.max(0, Math.min(255, Math.round(words[offset + 1]! / 257)));
      bytes[offset + 2] = Math.max(0, Math.min(255, Math.round(words[offset + 2]! / 257)));
    }
    resized = { data: bytes, width: resize.requestedWidth, height: resize.requestedHeight };
  }
  const resizedGeometryChanged =
    resize.requestedWidth !== tile.width || resize.requestedHeight !== tile.height;
  const transformedRegistrationX = resizedGeometryChanged
    ? transform.registrationRasterX * resize.effectiveScale + resize.reductionPhase - resize.cropLeft
    : transform.registrationRasterX;
  const transformedRegistrationY = resizedGeometryChanged
    ? transform.registrationRasterY * resize.effectiveScale + resize.reductionPhase - resize.cropTop
    : transform.registrationRasterY;
  const placed = translateReferenceRetainedSurface(
    resized,
    destination.width,
    destination.height,
    transform.destinationX - transformedRegistrationX,
    transform.destinationY - transformedRegistrationY,
  );
  return {
    data: Buffer.from(placed.data.buffer, placed.data.byteOffset, placed.data.byteLength),
    width: placed.width,
    height: placed.height,
  };
}

/**
 * Frozen pre-v2 scale+translation law: the same Q16 quad and associated-alpha
 * projective kernel scan the complete destination canvas before placement.
 * This independent oracle proves that clipping changes work, not pixels.
 */
function priorFullCanvasScaleTranslation(
  source: Readonly<{ data: Uint8Array; width: number; height: number }>,
  plan: NonNullable<ReturnType<typeof planReferenceLocalSpaceScaleTranslation>>,
) {
  assert.ok(plan.projective);
  const q16Point = (point: Readonly<{ x: string; y: string }>) => Object.freeze({
    x: Number(BigInt(point.x)) / referenceProjectiveWarpPhaseUnits,
    y: Number(BigInt(point.y)) / referenceProjectiveWarpPhaseUnits,
  });
  const quad = plan.projective.destination.quadQ16.map(q16Point) as unknown as readonly [
    Readonly<{ x: number; y: number }>,
    Readonly<{ x: number; y: number }>,
    Readonly<{ x: number; y: number }>,
    Readonly<{ x: number; y: number }>,
  ];
  const fullPlan = planReferenceProjectiveWarp({
    sourceWidth: source.width,
    sourceHeight: source.height,
    destinationQuad: quad,
    destinationBounds: {
      left: 0,
      top: 0,
      right: plan.destination.width,
      bottom: plan.destination.height,
    },
  });
  return placeReferenceProjectiveWarpOnCanvas(
    rasterReferenceProjectiveWarp(
      { ...source, alphaMode: "straight" },
      fullPlan,
    ),
    plan.destination.width,
    plan.destination.height,
    1,
  );
}

function deterministicSurface(width: number, height: number, seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state & 0xff;
  };
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = next();
    data[offset + 1] = next();
    data[offset + 2] = next();
    const mode = (offset / 4 + seed) % 7;
    data[offset + 3] = mode === 0 ? 0 : mode === 1 ? 255 : next();
    if (data[offset + 3] === 0) {
      data[offset] = 255;
      data[offset + 1] = next();
      data[offset + 2] = next();
    }
  }
  return Object.freeze({ data, width, height });
}

function laplacianVariance(surface: Readonly<{ data: Uint8Array; width: number; height: number }>) {
  const luma = (x: number, y: number) => {
    const offset = (y * surface.width + x) * 4;
    return surface.data[offset]! * 0.2126
      + surface.data[offset + 1]! * 0.7152
      + surface.data[offset + 2]! * 0.0722;
  };
  let sum = 0, sumSquares = 0, count = 0;
  for (let y = 1; y < surface.height - 1; y += 1) {
    for (let x = 1; x < surface.width - 1; x += 1) {
      const value = 4 * luma(x, y)
        - luma(x - 1, y) - luma(x + 1, y)
        - luma(x, y - 1) - luma(x, y + 1);
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

test("one-pass planning is limited to real resize plus fractional translation and preserves established paths", () => {
  const source = { width: 8, height: 8 }, destination = { width: 8, height: 8 };
  assert.equal(planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    source,
    destination,
    placement({ scale: 1 }),
  ), undefined, "neutral scale keeps its byte path");
  assert.equal(planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    source,
    destination,
    placement({ scale: 0.5, registrationRasterX: 4, registrationRasterY: 4, destinationX: 2.5, destinationY: 2.5 }),
  ), undefined, "an integer final placement keeps Sharp resize plus byte-copy translation");
  assert.equal(planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    source,
    destination,
    placement({ rotation: 1 }),
  ), undefined, "rotation retains its established tested path");
  assert.equal(planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    source,
    destination,
    placement({ skewX: 1 }),
  ), undefined, "skew retains its established tested path");

  const fused = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: 4, height: 4 },
    { width: 4, height: 4 },
    placement(),
  );
  assert.ok(fused);
  assert.equal(fused.algorithmVersion, referenceLocalSpaceScaleTranslationAlgorithmVersion);
  assert.equal(fused.sampler, referenceLocalSpaceScaleTranslationSampler);
  assert.equal(fused.activation, "fractional-phase");
  assert.match(fused.transformWorkIdentity, /^[a-f0-9]{64}$/u);
  assert.ok(fused.raster.legacyTranslationQ16.phaseX > 0 || fused.raster.legacyTranslationQ16.phaseY > 0);
  assert.ok(fused.projective);
  assert.deepEqual(fused.destinationClip, {
    status: "visible",
    bounds: { left: 0, top: 0, right: 3, bottom: 3 },
    width: 3,
    height: 3,
    pixels: 9,
    rgbaBytes: 36,
  });
  assert.equal(fused.projective.destination.width, 3);
  assert.equal(fused.projective.destination.height, 3);
  const q16 = (value: number) => String(BigInt(Math.round(value * 65_536)));
  assert.deepEqual(fused.projective.destination.quadQ16, [
    { x: q16(0.325), y: q16(-0.175) },
    { x: q16(3.325), y: q16(-0.175) },
    { x: q16(3.325), y: q16(2.825) },
    { x: q16(0.325), y: q16(2.825) },
  ], "source outer edges must bind the authored registration and effective scale on the exact Q16 destination quad");
  assert.equal(
    fused.authored.destinationX,
    2.2,
    "the authored registration point maps to destinationX without a phase/snap rewrite",
  );
  assert.equal(fused.authored.destinationY, 1.7);
});

test("the fused sampler is deterministic, clips the canvas and cannot leak transparent hidden RGB", () => {
  const source = new Uint8Array(4 * 4 * 4);
  for (let offset = 0; offset < source.length; offset += 4) {
    source[offset] = 255;
    source[offset + 3] = 0;
  }
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
    const offset = (y * 4 + x) * 4;
    source[offset] = 0;
    source[offset + 2] = 255;
    source[offset + 3] = 255;
  }
  const plan = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: 4, height: 4 },
    { width: 4, height: 4 },
    placement({ destinationX: -0.2, destinationY: 1.7 }),
  );
  assert.ok(plan);
  const first = executeReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { data: source, width: 4, height: 4, alphaMode: "straight" },
    plan,
  );
  const second = executeReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { data: source.slice(), width: 4, height: 4, alphaMode: "straight" },
    structuredClone(plan),
  );
  const scalar = executeReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { data: source.slice(), width: 4, height: 4, alphaMode: "straight" },
    structuredClone(plan),
    { disableNativeScaleTranslation: true },
  );
  assert.deepEqual(second.surface.data, first.surface.data);
  assert.deepEqual(first.surface.data, scalar.surface.data, "authenticated native Q16 pixels must equal the scalar law");
  assert.deepEqual(first.evidence.observedWork, scalar.evidence.observedWork, "native execution must preserve semantic work evidence");
  assert.equal(first.surface.width, 4);
  assert.equal(first.surface.height, 4);
  assert.equal(first.surface.originX, 0);
  assert.equal(first.surface.originY, 0);
  assert.ok(first.surface.data.some((value, index) => index % 4 === 3 && value > 0));
  for (let offset = 0; offset < first.surface.data.length; offset += 4) {
    if (first.surface.data[offset + 3]! > 0) {
      assert.equal(first.surface.data[offset], 0, "transparent hidden red must not bleed into a visible sample");
    }
  }
  assert.equal(
    first.evidence.observedWork.insideQuadPixels,
    first.evidence.observedWork.integerSamplesCopied + first.evidence.observedWork.bilinearSamplesEvaluated,
  );
});

test("destination clipping is byte-identical to the frozen full-canvas affine law across edges, corners and alpha adversaries", () => {
  const source = deterministicSurface(7, 5, 0x5ca1e);
  const before = source.data.slice();
  const cases = [
    { label: "full field", destinationX: 5.2, destinationY: 4.7, scale: 1.5 },
    { label: "left clip", destinationX: 0.2, destinationY: 4.1, scale: 0.75 },
    { label: "right clip", destinationX: 10.7, destinationY: 4.1, scale: 0.75 },
    { label: "top clip", destinationX: 5.2, destinationY: 0.2, scale: 0.75 },
    { label: "bottom clip", destinationX: 5.2, destinationY: 8.7, scale: 0.75 },
    { label: "top-left corner", destinationX: 0.2, destinationY: 0.2, scale: 0.75 },
    { label: "top-right corner", destinationX: 10.7, destinationY: 0.2, scale: 0.75 },
    { label: "bottom-left corner", destinationX: 0.2, destinationY: 8.7, scale: 0.75 },
    { label: "bottom-right corner", destinationX: 10.7, destinationY: 8.7, scale: 0.75 },
  ] as const;
  for (const fixture of cases) {
    const plan = planReferenceLocalSpaceScaleTranslation(
      diagnosticNode,
      { width: source.width, height: source.height },
      { width: 11, height: 9 },
      placement({
        destinationX: fixture.destinationX,
        destinationY: fixture.destinationY,
        registrationRasterX: 3,
        registrationRasterY: 2,
        scale: fixture.scale,
      }),
    );
    assert.ok(plan, fixture.label);
    assert.equal(plan.destinationClip.status, "visible", fixture.label);
    const optimized = executeReferenceLocalSpaceScaleTranslation(
      diagnosticNode,
      { ...source, alphaMode: "straight" },
      plan,
    );
    const repeated = executeReferenceLocalSpaceScaleTranslation(
      diagnosticNode,
      { data: source.data.slice(), width: source.width, height: source.height, alphaMode: "straight" },
      structuredClone(plan),
    );
    const frozen = priorFullCanvasScaleTranslation(source, plan);
    assert.deepEqual(optimized.surface.data, frozen.surface.data, `${fixture.label} must preserve the frozen scalar law`);
    assert.deepEqual(repeated.surface.data, optimized.surface.data, `${fixture.label} must repeat deterministically`);
    assert.equal(
      optimized.evidence.observedWork.destinationPixelsTested,
      plan.destinationClip.pixels,
      `${fixture.label} must scan only the exact destination clip`,
    );
    assert.ok(
      optimized.evidence.observedWork.destinationPixelsTested <= 11 * 9,
      `${fixture.label} cannot scan beyond delivery`,
    );
  }
  assert.deepEqual(source.data, before, "the shared/cached retained source surface must remain immutable");
});

test("one-pass plan identity binds every raster-relevant source, destination, transform and opacity input", () => {
  const source = { width: 7, height: 5 };
  const destination = { width: 11, height: 9 };
  const authored = placement({
    destinationX: 5.2,
    destinationY: 4.7,
    registrationRasterX: 3,
    registrationRasterY: 2,
    scale: 1.5,
    opacity: 0.75,
  });
  const base = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    source,
    destination,
    authored,
  );
  assert.ok(base);
  const variants = [
    planReferenceLocalSpaceScaleTranslation(diagnosticNode, { width: 8, height: 5 }, destination, authored),
    planReferenceLocalSpaceScaleTranslation(diagnosticNode, source, { width: 12, height: 9 }, authored),
    planReferenceLocalSpaceScaleTranslation(diagnosticNode, source, destination, { ...authored, destinationX: 5.3 }),
    planReferenceLocalSpaceScaleTranslation(diagnosticNode, source, destination, { ...authored, destinationY: 4.8 }),
    planReferenceLocalSpaceScaleTranslation(diagnosticNode, source, destination, { ...authored, registrationRasterX: 2.9 }),
    planReferenceLocalSpaceScaleTranslation(diagnosticNode, source, destination, { ...authored, registrationRasterY: 1.9 }),
    planReferenceLocalSpaceScaleTranslation(diagnosticNode, source, destination, { ...authored, scale: 1.4 }),
    planReferenceLocalSpaceScaleTranslation(diagnosticNode, source, destination, { ...authored, opacity: 0.5 }),
  ];
  assert.ok(variants.every(Boolean));
  assert.equal(
    new Set([base.planIdentity, ...variants.map((candidate) => candidate!.planIdentity)]).size,
    variants.length + 1,
  );
  assert.notEqual(
    variants.at(-1)!.transformWorkIdentity,
    base.transformWorkIdentity,
    "opacity changes allocation/work identity even though the sampled color bytes precede the public opacity stage",
  );
});

test("one-pixel and completely off-canvas clips remain bounded and canonical", () => {
  const source = deterministicSurface(4, 4, 0x0ffca);
  const onePixel = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: 4, height: 4 },
    { width: 8, height: 8 },
    placement({
      scale: 0.75,
      registrationRasterX: 2,
      registrationRasterY: 2,
      destinationX: -0.5,
      destinationY: -0.5,
    }),
  );
  assert.ok(onePixel);
  assert.equal(onePixel.destinationClip.pixels, 1);
  const one = executeReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { ...source, alphaMode: "straight" },
    onePixel,
  );
  assert.deepEqual(one.surface.data, priorFullCanvasScaleTranslation(source, onePixel).surface.data);
  assert.equal(one.evidence.observedWork.destinationPixelsTested, 1);

  const offCanvas = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: 4, height: 4 },
    { width: 8, height: 8 },
    placement({
      scale: 0.75,
      registrationRasterX: 2,
      registrationRasterY: 2,
      destinationX: -20.25,
      destinationY: -20.25,
    }),
  );
  assert.ok(offCanvas);
  assert.equal(offCanvas.destinationClip.status, "off-canvas");
  assert.equal(offCanvas.projective, undefined);
  const rendered = executeReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { ...source, alphaMode: "straight" },
    offCanvas,
  );
  assert.deepEqual(rendered.surface.data, new Uint8Array(8 * 8 * 4));
  assert.deepEqual(rendered.evidence.observedWork, {
    destinationPixelsTested: 0,
    insideQuadPixels: 0,
    integerSamplesCopied: 0,
    bilinearSamplesEvaluated: 0,
    sourceTapsRead: 0,
    canvasPixelsAllocated: 64,
    canvasRgbaBytesAllocated: 256,
    canvasPixelsCopied: 0,
    canvasRgbaBytesCopied: 0,
  });
  assert.throws(
    () => executeReferenceLocalSpaceScaleTranslation(
      diagnosticNode,
      { data: new Uint8Array(4), width: 1, height: 1, alphaMode: "straight" },
      offCanvas,
    ),
    /CUT_LOCAL_SPACE_SCALE_TRANSLATION_RASTER.*input must match the admitted/u,
    "off-canvas execution must not bypass source authentication",
  );
  assert.throws(
    () => planReferenceLocalSpaceScaleTranslation(
      diagnosticNode,
      { width: 4, height: 4 },
      { width: 8, height: 8 },
      placement({ scale: 0.75, destinationX: 200_000.25, destinationY: 0.25 }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceLocalSpaceScaleTranslationError);
      assert.equal(error.code, "CUT_LOCAL_SPACE_SCALE_TRANSLATION_PLAN");
      assert.match(error.message, /131072/u);
      return true;
    },
  );
});

test("the fused execution boundary rejects stale plans before output allocation", () => {
  const plan = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: 4, height: 4 },
    { width: 4, height: 4 },
    placement(),
  );
  assert.ok(plan);
  const forged = {
    ...structuredClone(plan),
    planIdentity: "0".repeat(64),
  };
  let allocations = 0;
  assert.throws(
    () => executeReferenceLocalSpaceScaleTranslation(
      diagnosticNode,
      { data: new Uint8Array(4 * 4 * 4), width: 4, height: 4, alphaMode: "straight" },
      forged,
      { allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceLocalSpaceScaleTranslationError);
      assert.equal(error.code, "CUT_LOCAL_SPACE_SCALE_TRANSLATION_RASTER");
      assert.equal(error.source.nodeId, diagnosticNode.id);
      return true;
    },
  );
  assert.equal(allocations, 0, "plan validation must complete before the output allocator is called");
});

test("nested scale plan mutation is refused even when a stale caller preserves the outer planIdentity", () => {
  const plan = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: 4, height: 4 },
    { width: 4, height: 4 },
    placement(),
  );
  assert.ok(plan?.projective);
  const cloned = structuredClone(plan);
  const projective = cloned.projective!;
  const forged = {
    ...cloned,
    projective: {
      ...projective,
      destination: {
        ...projective.destination,
        bounds: {
          ...projective.destination.bounds,
          right: projective.destination.bounds.right - 1,
        },
      },
    },
  };
  let allocations = 0;
  assert.throws(
    () => executeReferenceLocalSpaceScaleTranslation(
      diagnosticNode,
      { data: new Uint8Array(4 * 4 * 4), width: 4, height: 4, alphaMode: "straight" },
      forged,
      { allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceLocalSpaceScaleTranslationError);
      assert.equal(error.code, "CUT_LOCAL_SPACE_SCALE_TRANSLATION_RASTER");
      return true;
    },
  );
  assert.equal(allocations, 0);
});

test("native-HD integer placement falls back to direct destination-clipped work without raising the 512 MiB ceiling", () => {
  const source = { width: 4_560, height: 2_280 };
  const destination = { width: 1_920, height: 1_080 };
  const transform = {
    source,
    destination,
    scale: 1.55,
    rotation: 0,
    opacity: 1,
  } as const;
  const work = planReferenceLocalSpaceTileTransformWork(diagnosticNode, transform);
  assert.equal(work.version, 4);
  if (work.version !== 4) throw new Error("native-HD fixture must produce V4 work");
  assert.equal(work.algorithmVersion, referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion);
  assert.equal(work.stages.rgb16TransformPath, false);
  assert.equal(work.stages.directDestinationClippedScaleTranslation, true);
  assert.ok(work.perTransform.peakLiveBytesUpperBound <= referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes);
  assert.equal(referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes, 536_870_912);

  const plan = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    source,
    destination,
    placement({
      owner: "camera-2d",
      scale: 1.55,
      registrationRasterX: source.width / 2,
      registrationRasterY: source.height / 2,
      destinationX: destination.width / 2,
      destinationY: destination.height / 2,
    }),
  );
  assert.ok(plan);
  assert.equal(plan.activation, "legacy-work-ceiling");
  assert.equal(plan.transformWorkIdentity, work.workIdentity);
  assert.deepEqual(plan.destinationClip.bounds, { left: 0, top: 0, right: 1_920, bottom: 1_080 });
  assert.equal(plan.destinationClip.pixels, 2_073_600);

  const smallInteger = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: 96, height: 60 },
    { width: 64, height: 40 },
    placement({
      scale: 0.5,
      registrationRasterX: 48,
      registrationRasterY: 30,
      destinationX: 32.5,
      destinationY: 20.5,
    }),
  );
  assert.equal(smallInteger, undefined, "an admitted integer-phase resize retains its historical Sharp bytes");

  assert.throws(
    () => planReferenceLocalSpaceTileTransformWork(diagnosticNode, {
      source: { width: 4_000, height: 4_000 },
      destination: { width: 8_000, height: 5_000 },
      scale: 2,
      rotation: 0,
      opacity: 0.5,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceLocalSpaceTransformWorkError);
      assert.equal(error.code, "CUT_LOCAL_SPACE_TRANSFORM_LIMIT");
      assert.equal(error.source.nodeId, diagnosticNode.id);
      assert.match(error.message, /destination-clipped direct scale\+translation peak is 544000000 bytes; maximum remains 536870912/u);
      return true;
    },
    "the direct fallback must refuse its own source + clip + canvas + opacity-copy peak before raster execution",
  );
});

test("ceiling-triggered V4 executes the direct sampler and preserves the frozen scalar law", () => {
  // A four-pixel source scaled by 2365 would materialize a legacy
  // 9460x2365 RGB16 intermediate, while its authored delivery clip is only
  // 100x80. This executes the real V4 branch without allocating the
  // superseded intermediate or turning the focused test into an HD stress run.
  const source = deterministicSurface(4, 1, 0x4d31);
  const destination = { width: 100, height: 80 };
  const authored = placement({
    owner: "camera-2d",
    scale: 2365,
    registrationRasterX: 2,
    registrationRasterY: 0,
    destinationX: 50,
    destinationY: 40,
  });
  const work = planReferenceLocalSpaceTileTransformWork(diagnosticNode, {
    source: { width: source.width, height: source.height },
    destination,
    scale: authored.scale,
    rotation: 0,
    opacity: 1,
  });
  assert.equal(work.version, 4);
  if (work.version !== 4) throw new Error("bounded execution fixture must produce V4 work");
  assert.ok(work.supersededLegacy.peakLiveBytesUpperBound > 536_870_912);
  assert.ok(work.perTransform.peakLiveBytesUpperBound <= 536_870_912);

  const plan = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: source.width, height: source.height },
    destination,
    authored,
  );
  assert.ok(plan);
  assert.equal(plan.activation, "legacy-work-ceiling");
  assert.equal(plan.transformWorkIdentity, work.workIdentity);
  assert.deepEqual(plan.destinationClip.bounds, { left: 0, top: 0, right: 100, bottom: 80 });

  const before = source.data.slice();
  const rendered = executeReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { ...source, alphaMode: "straight" },
    plan,
  );
  const frozen = priorFullCanvasScaleTranslation(source, plan);
  assert.deepEqual(rendered.surface.data, frozen.surface.data);
  assert.deepEqual(source.data, before, "direct V4 execution cannot mutate the retained source");
  assert.equal(rendered.evidence.activation, "legacy-work-ceiling");
  assert.equal(rendered.evidence.transformWorkIdentity, work.workIdentity);
  assert.equal(rendered.evidence.observedWork.destinationPixelsTested, 8_000);
  assert.equal(rendered.evidence.observedWork.canvasPixelsAllocated, 8_000);

  const offCanvasPlan = planReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { width: source.width, height: source.height },
    destination,
    { ...authored, destinationX: 20_000, destinationY: 20_000 },
  );
  assert.ok(offCanvasPlan);
  assert.equal(offCanvasPlan.activation, "legacy-work-ceiling");
  assert.equal(offCanvasPlan.destinationClip.status, "off-canvas");
  const offCanvas = executeReferenceLocalSpaceScaleTranslation(
    diagnosticNode,
    { ...source, alphaMode: "straight" },
    offCanvasPlan,
  );
  assert.deepEqual(offCanvas.surface.data, new Uint8Array(100 * 80 * 4));
  assert.equal(offCanvas.evidence.observedWork.destinationPixelsTested, 0);
  assert.equal(offCanvas.evidence.observedWork.canvasPixelsAllocated, 8_000);
});

test("V4 planning evidence is schema-valid and a forged admission is rejected by runtime re-derivation", async () => {
  const request = {
    source: { width: 4_560, height: 2_280 },
    destination: { width: 1_920, height: 1_080 },
    scale: 1.55,
    rotation: 0,
    opacity: 1,
  } as const;
  const work = planReferenceLocalSpaceTileTransformWork(diagnosticNode, request);
  assert.equal(work.version, 4);
  if (work.version !== 4) throw new Error("schema fixture must produce V4 work");
  const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
  const ajv = new Ajv({
    schemaId: "auto",
    meta: false,
    validateSchema: false,
    allErrors: true,
    jsonPointers: true,
  });
  ajv.addSchema(schema, "cut-reference-frame-v2");
  const validateWork = ajv.compile({
    $ref: "cut-reference-frame-v2#/definitions/localSpaceTransformPlanningWork",
  });
  assert.equal(validateWork(work), true, JSON.stringify(validateWork.errors));
  const wideSamplerWork = planReferenceLocalSpaceTileTransformWork(diagnosticNode, {
    source: { width: 4, height: 1 },
    destination: { width: 5_000, height: 4_000 },
    scale: 2365,
    rotation: 0,
    opacity: 1,
  });
  assert.equal(wideSamplerWork.version, 4);
  if (wideSamplerWork.version !== 4) throw new Error("wide schema fixture must produce V4 work");
  assert.equal(wideSamplerWork.stages.maximumSamplerOutputRgba8Bytes, 80_000_000);
  assert.equal(
    validateWork(wideSamplerWork),
    true,
    `V4 schema must retain the planner's full destination-canvas bound: ${JSON.stringify(validateWork.errors)}`,
  );
  assert.throws(
    () => validateReferenceLocalSpaceTransformExecutionPlan(
      diagnosticNode,
      { ...work, workIdentity: "0".repeat(64) },
      { ...request, skewX: 0, skewY: 0 },
    ),
    /CUT_LOCAL_SPACE_RASTER.*does not match runtime-derived work/u,
  );
});

test("mixed affine V3/V4 aggregation is honest and hostile unscheduled direct work still fails closed", () => {
  const ir = compile(publicSource("group"));
  const composition = ir.compositions[0]!;
  const v4 = {
    node: diagnosticNode,
    transform: {
      source: { width: 4_560, height: 2_280 },
      destination: { width: 1_920, height: 1_080 },
      scale: 1.55,
      skewX: 0,
      skewY: 0,
      rotation: 0,
      opacity: 1,
    },
  } as const;
  const v3 = {
    node: { ...diagnosticNode, id: "skew_owner" },
    transform: {
      source: { width: 96, height: 60 },
      destination: { width: 64, height: 40 },
      scale: 0.75,
      skewX: 2,
      skewY: -1,
      rotation: 0,
      opacity: 1,
    },
  } as const;
  const mixed = planReferenceLocalSpaceAffineCompositionTransformWork(
    diagnosticNode,
    composition,
    [v4, v3],
  );
  assert.equal(mixed.version, 4);
  assert.equal(mixed.algorithmVersion, referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion);
  assert.equal(mixed.transformCount, 2);
  assert.ok(mixed.maximumPerTransformPeakBytes <= referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes);

  const requests = Array.from({ length: 38 }, (_, index) => Object.freeze({
    node: { ...diagnosticNode, id: `direct_owner_${index}` },
    transform: v4.transform,
  }));
  assert.throws(
    () => planReferenceLocalSpaceAffineCompositionTransformWork(diagnosticNode, composition, requests),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceLocalSpaceTransformWorkError);
      assert.equal(error.code, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE");
      assert.match(error.message, /unscheduled transform peaks/u);
      return true;
    },
  );
});

test("Camera2D and unrelated Group retained owners execute stable one-pass held pixels and authenticated evidence", { timeout: 30_000 }, async () => {
  for (const owner of ["camera", "group"] as const) {
    const ir = compile(publicSource(owner));
    const [first, second] = await renderFrames(ir, [0, 1]);
    assert.deepEqual(second.surface.data, first.surface.data, `${owner} stationary held pixels must be byte-stable`);
    const placementEvidence = first.evidence.placements[0]!;
    assert.equal(placementEvidence.owner, owner === "camera" ? "camera-2d" : "group");
    assert.equal(placementEvidence.transformWork?.scaleTranslation?.algorithmVersion, referenceLocalSpaceScaleTranslationAlgorithmVersion);
    assert.equal(placementEvidence.transformWork?.scaleTranslation?.sampler, referenceLocalSpaceScaleTranslationSampler);
    assert.match(first.evidence.backendIdentity, /local-space@2/u);
    assert.match(first.evidence.backendIdentity, /scale-translation@cut-reference-local-space-scale-translation-v2/u);
    assert.match(
      first.evidence.backendIdentity,
      new RegExp(`retained-alpha-support@${referenceRetainedSurfaceAlphaSupportAlgorithmVersion}`, "u"),
    );
    assert.match(
      first.evidence.backendIdentity,
      new RegExp(`alpha-bounded-translation@${referenceLocalSpaceAlphaBoundedTranslationAlgorithmVersion}`, "u"),
    );

    const localNode = Object.values(ir.nodes).find((node) => node.op === "cut.visual.local_space");
    assert.ok(localNode);
    const local = validateReferenceLocalSpaceGraph(ir, ir.compositions[0]!).get(localNode.id);
    assert.ok(local);
    const oldBackend = first.evidence.backendIdentity
      .replace(
        `alpha-bounded-translation@${referenceLocalSpaceAlphaBoundedTranslationAlgorithmVersion}`,
        "alpha-bounded-translation@cut-reference-local-space-alpha-bounded-translation-v0",
      );
    assert.notEqual(
      referenceLocalSpaceTileIdentity(local, rational(0), oldBackend),
      first.evidence.tiles[0]!.tileIdentity,
      "sampler/backend change must invalidate retained tile/cache identity",
    );
    assert.equal(
      referenceLocalSpacePlacementIdentity(
        local,
        first.evidence.tiles[0]!.tileIdentity,
        {
          owner: placementEvidence.owner,
          contextIdentity: placementEvidence.contextIdentity,
          ...placementEvidence.transform!,
        },
        placementEvidence.transformWork!.workIdentity,
      ),
      placementEvidence.placementIdentity,
    );

    const inspected = inspectCutIr(ir, `${owner}.cut`);
    const localInspect = inspected.graph.nodes.find((candidate) => candidate.id === localNode.id)?.localSpace;
    assert.equal(localInspect?.executionSupport.scaleTranslationSampling.algorithmVersion, referenceLocalSpaceScaleTranslationAlgorithmVersion);
    if (owner === "camera") {
      const cameraInspect = inspected.graph.nodes.find((candidate) => candidate.camera2D)?.camera2D;
      assert.equal(cameraInspect?.scaleTranslationSampling.sampler, referenceLocalSpaceScaleTranslationSampler);
    }
  }
});

test("public Text, Path and high-frequency held content is quantitatively sharper than the former two-stage baseline", { timeout: 30_000 }, async () => {
  const project = await lockedSharpnessProject();
  try {
    const [first, second] = await renderFrames(project.ir, [0, 1], project.root);
    assert.ok(first.tile);
    assert.deepEqual(second.surface.data, first.surface.data, "stationary public Text/Path content must remain byte-stable");
    const transform = first.evidence.placements[0]?.transform;
    assert.ok(transform);
    const legacy = await legacyResizeThenTranslate(
      first.tile,
      { width: first.surface.width, height: first.surface.height },
      transform,
    );
    const fusedSharpness = laplacianVariance(first.surface);
    const legacySharpness = laplacianVariance(legacy);
    assert.ok(
      fusedSharpness > legacySharpness * 1.25,
      `one-pass Text/Path sharpness ${fusedSharpness} must exceed the resize-then-fractional-translate baseline ${legacySharpness}`,
    );
    assert.notEqual(digest(first.surface.data), digest(legacy.data));
    assert.equal(
      first.evidence.placements[0]?.transformWork?.scaleTranslation?.sampler,
      referenceLocalSpaceScaleTranslationSampler,
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("neutral and integer-phase public Text/Path output remains byte-identical to the established placement law", { timeout: 30_000 }, async () => {
  const fixtures = [
    { label: "neutral", source: sharpnessSource(1, 0, 0) },
    // 96x60 at 0.5 has resized registration (23.5,14.5); x/y 0.5
    // place it at the integer offset (9,6) on the 64x40 canvas.
    { label: "integer-phase resized", source: sharpnessSource(0.5, 0.5, 0.5) },
  ];
  for (const fixture of fixtures) {
    const project = await lockedSharpnessProject(fixture.source);
    try {
      const [rendered] = await renderFrames(project.ir, [0], project.root);
      assert.ok(rendered.tile);
      const transform = rendered.evidence.placements[0]?.transform;
      assert.ok(transform);
      assert.equal(
        rendered.evidence.placements[0]?.transformWork?.scaleTranslation,
        undefined,
        `${fixture.label} must not opt into fused sampling`,
      );
      const expected = await legacyResizeThenTranslate(
        rendered.tile,
        { width: rendered.surface.width, height: rendered.surface.height },
        transform,
      );
      assert.deepEqual(
        rendered.surface.data,
        expected.data,
        `${fixture.label} pixels must remain byte-identical to the established resize/translation law`,
      );
    } finally {
      await rm(project.root, { recursive: true, force: true });
    }
  }
});

test("MotionBlur shutter samples share the one-pass retained scale+translation semantics", { timeout: 30_000 }, async () => {
  const ir = compile(publicSource("camera", true));
  const [rendered] = await renderFrames(ir, [1]);
  assert.ok(rendered.evidence.placements.length >= 2);
  assert.ok(rendered.evidence.placements.every((entry) =>
    entry.transformWork?.scaleTranslation?.algorithmVersion === referenceLocalSpaceScaleTranslationAlgorithmVersion));
  assert.equal(rendered.evidence.counters.maximumConcurrentTransforms, 1);
});

test("frame-v2 persists and validates the one-pass scale+translation receipt", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-scale-translation-schema-"));
  try {
    const output = resolve(root, "frame.png");
    const ir = compile(publicSource("camera"));
    await renderReferenceFrameArtifact(ir, root, output, { frame: 0, mediaProfile: "master" });
    const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
    const receipt = persisted.execution.localSpaces[0].placements[0].transformWork.scaleTranslation;
    assert.equal(receipt.algorithmVersion, referenceLocalSpaceScaleTranslationAlgorithmVersion);
    assert.equal(receipt.sampler, referenceLocalSpaceScaleTranslationSampler);
    const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
    const validate = new Ajv({
      schemaId: "auto",
      meta: false,
      validateSchema: false,
      allErrors: true,
      jsonPointers: true,
    }).compile(schema);
    assert.equal(validate(persisted), true, JSON.stringify(validate.errors));
    const forged = structuredClone(persisted);
    forged.execution.localSpaces[0].placements[0].transformWork.scaleTranslation.planIdentity = "0".repeat(64);
    assert.equal(validate(forged), true, "JSON schema validates shape; semantic frame validation owns identity");
    assert.notEqual(digest(await readFile(output)), digest(await readFile(`${output}.manifest.json`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
