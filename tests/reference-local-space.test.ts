import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { decimalRational, rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  ReferenceLocalSpaceError,
  referenceLocalSpaceFrameEvidence,
  referenceLocalSpaceOriginQ16,
  referenceLocalSpacePlacementIdentity,
  referenceLocalSpaceTileIdentity,
  validateReferenceLocalSpaceGraph,
} from "../lib/runtime/reference/local-space";
import {
  ReferenceLocalSpaceFrameEvidenceError,
  validateCurrentReferenceFrameLocalSpaceExecutionTree,
  validateReferenceLocalSpaceRendererFrameExecutionSemantics,
  validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics,
} from "../lib/runtime/reference/local-space-frame-evidence";
import { validateReferenceStaticVisualGraphs } from "../lib/runtime/reference/static-visual-validation";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import { ReferenceFlowTextError } from "../lib/runtime/reference/text-flow";
import { ReferenceTextConfigError } from "../lib/runtime/reference/text-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  ReferenceVisualRenderer,
  referenceLocalSpaceRendererFrameExecutionEvidence,
} from "../lib/runtime/reference/visual";

function source(body: string, width = 40, height = 40) {
  return `cut 0.4;
project "LocalSpace unrelated proof";
import { Circle, Composite, Group, LocalSpace, MotionPath, Path, Rect, Stack, vectorPath, lineTo } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localMotionDescendantSource(endpointX = 12, orient = true) {
  return `cut 0.4;
project "LocalSpace MotionPath descendant proof";
import { Camera2D, Group, LocalSpace, MotionPath, Path, Rect, cubicTo, vectorPath } from "cut:visual";
import { linear } from "@cut/motion";

const journey = vectorPath(
  start: { x: -10px, y: -4px },
  segments: [
    cubicTo(
      control1: { x: -2px, y: -4px },
      control2: { x: 4px, y: 6px },
      to: { x: ${endpointX}px, y: 6px }
    )
  ],
  closed: false
);

component Token() -> Visual {
  Group() {
    Rect(width: 9px, height: 3px, fill: #ef6a42, radius: 1px);
    Rect(width: 3px, height: 7px, fill: #fff2cf, radius: 1px);
  }
}

timeline main(duration: 2s, fps: 4, width: 48px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    Camera2D(scale: 1) {
      LocalSpace(width: 34px, height: 24px, origin: { x: 10px, y: 6px }) {
        Path(geometry: journey, stroke: #4fc3b4, width: 1px, opacity: 45%);
        MotionPath(geometry: journey, progress: 0%${orient ? ", orientToPath: true" : ""}, opacity: 35%) as moving {
          Token();
        }
        animate moving.progress from 0% to 100% over 1s ease linear;
        animate moving.opacity from 35% to 100% over 1s ease linear;
      }
    }
  }
}
export out = render(main, width: 48px, height: 36px, codec: "h264");`;
}

function compile(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function typographySource(body: string, options: { width?: number; height?: number; duration?: string; fps?: number } = {}) {
  const width = options.width ?? 160, height = options.height ?? 100, duration = options.duration ?? "1s", fps = options.fps ?? 4;
  return `cut 0.4;
project "LocalSpace locked typography proof";
import { FlowText, Image, LocalSpace, Text, textSpan, textUnitMotion, textUnitPose } from "cut:visual";
asset face: FontAsset = font("assets/face.ttf");
timeline main(duration: ${duration}, fps: ${fps}, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: ${duration}) {
    ${body}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

async function lockedTypographyProject(program: string) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-type-")), assets = resolve(root, "assets");
  await mkdir(assets);
  await copyFile(resolve("examples/fixtures/Geist-Regular.ttf"), resolve(assets, "face.ttf"));
  const ir = compile(program), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { root, ir };
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

async function render(program: string, frame = 0) {
  const ir = compile(program), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[composition.sceneIds[0]]!;
    const rendered = await renderer.sceneFrame(scene, frame, false);
    return { ir, composition, frame: rendered, evidence: renderer.referenceLocalSpaceEvidence() };
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
}

function alpha(frame: { data: Uint8Array; width: number; height: number }) {
  const values: Array<{ x: number; y: number; alpha: number }> = [];
  let weight = 0, xWeight = 0, yWeight = 0;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    const value = frame.data[(y * frame.width + x) * 4 + 3];
    if (value === 0) continue;
    values.push({ x, y, alpha: value });
    weight += value; xWeight += x * value; yWeight += y * value;
  }
  return { values, weight, x: xWeight / weight, y: yWeight / weight };
}

function localNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.local_space");
  assert.ok(node);
  return node;
}

test("LocalSpace is public typed IR with exact rational origin and inspectable bounded work", () => {
  const ir = compile(source(`LocalSpace(width: 9px, height: 7px, origin: { x: 4.5px, y: 2.25px }) {
    Rect(width: 2px, height: 2px, fill: #ef233c);
  }`));
  const node = localNode(ir);
  assert.deepEqual(node.inputs.origin, {
    kind: "object",
    entries: {
      x: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(9, 2) },
      y: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(9, 4) },
    },
  });
  const config = validateReferenceLocalSpaceGraph(ir, ir.compositions[0]).get(node.id);
  assert.ok(config);
  assert.deepEqual(config.origin, { x: rational(9, 2), y: rational(9, 4) });
  assert.ok(config.estimatedPixelPassesPerFrame > 0);
  const inspected = inspectCutIr(ir, "main.cut").graph.nodes.find((candidate) => candidate.id === node.id)?.localSpace;
  assert.deepEqual(inspected?.origin, { x: rational(9, 2), y: rational(9, 4) });
  assert.equal(inspected?.retainedSurface.width, 9);
  assert.equal(inspected?.retainedSurface.height, 7);
  assert.equal(inspected?.retainedSurface.clip, "declared-half-open-tile");
  assert.equal(inspected?.work.kind, "preflight-estimate");
});

test("completed-frame evidence reports actual LocalSpace work deterministically and separately from inspect estimates", async () => {
  const program = source(`LocalSpace(width: 9px, height: 7px, origin: { x: 4.5px, y: 3.5px }) {
    Rect(width: 2px, height: 2px, fill: #ef233c);
  }`);
  const first = await render(program), second = await render(program);
  assert.ok(first.evidence && second.evidence);
  assert.equal(first.evidence.evidenceKind, "completed-frame-execution");
  assert.deepEqual(first.evidence.exactTime, rational(0));
  assert.equal(first.evidence.outputFrame, "0");
  assert.deepEqual(first.evidence.counters, {
    tileRequests: 1,
    tileRasterizations: 1,
    tileMemoHits: 0,
    tilePixelsRasterized: 63,
    placementRequests: 1,
    placementRasterizations: 1,
    placementMemoHits: 0,
    placementDestinationPixels: 1600,
    transformExecutions: 1,
    maximumConcurrentTransforms: 1,
    localNodeRasterizations: 1,
    localNodePixelsRasterized: 63,
    localNodeRgbaBytesRasterized: 252,
    localPaintSurfaceCacheHits: 0,
    localPaintSurfaceCacheMisses: 1,
    localPaintSurfaceCacheBypasses: 0,
    localPaintSurfaceCacheEvictions: 0,
    localPaintSurfaceCacheResidentBytes: 252,
    inactiveNodeSkips: 0,
    ownerOpacitySkips: 0,
    ownerPolicySkips: 0,
    localNodeOpacitySkips: 0,
  });
  assert.equal(first.evidence.tiles.length, 1);
  assert.equal(first.evidence.placements.length, 1);
  assert.equal(first.evidence.tiles[0]?.tileIdentity, first.evidence.placements[0]?.tileIdentity);
  assert.equal(first.evidence.executionIdentity, second.evidence.executionIdentity);
});

test("LocalSpace reuses only validated static Rect and Path paint surfaces with honest bounded counters", { timeout: 30_000 }, async () => {
  const program = source(`LocalSpace(width: 30px, height: 20px, origin: { x: 15px, y: 10px }) {
    Rect(width: 6px, height: 4px, x: -5px, y: -4px, fill: #ef6a42);
    Rect(width: 6px, height: 4px, x: -5px, y: -4px, fill: #ef6a42);
    Path(points: [{ x: -12px, y: 6px }, { x: 12px, y: 6px }], stroke: #f6c85f, width: 1px);
    Path(
      geometry: vectorPath(start: { x: -12px, y: 0px }, segments: [lineTo(to: { x: 12px, y: 0px })], closed: false),
      stroke: #4fc3b4, width: 2px
    );
    Path(
      geometry: vectorPath(start: { x: -12px, y: -6px }, segments: [lineTo(to: { x: 12px, y: -6px })], closed: false),
      stroke: #fff2cf, width: 2px, trimEnd: 25%
    ) as changing;
    animate changing.trimEnd from 25% to 100% over 1s;
  }`, 40, 30);
  const ir = compile(program), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-static-paint-cache-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  const internals = renderer as unknown as {
    rendererTreeContext: {
      localPaintSurfaceCache: { entryCount: number; residentBytes: number };
    };
  };
  try {
    await renderer.prepare();
    const scene = ir.scenes[composition.sceneIds[0]]!;
    const first = await renderer.sceneFrame(scene, 0, false);
    const cold = renderer.referenceLocalSpaceEvidence();
    assert.ok(cold);
    assert.equal(cold.counters.localPaintSurfaceCacheMisses, 3);
    assert.equal(cold.counters.localPaintSurfaceCacheHits, 1,
      "the duplicate static Rect must share one exact immutable base raster");
    assert.equal(cold.counters.localPaintSurfaceCacheBypasses, 1,
      "the animated trim path must remain outside the static cache");
    assert.equal(cold.counters.localPaintSurfaceCacheEvictions, 0);
    assert.equal(cold.counters.localPaintSurfaceCacheResidentBytes, 30 * 20 * 4 * 3);
    assert.equal(cold.counters.localNodeRasterizations, 4,
      "three admitted cache misses plus one dynamic bypass are the only rasterizations");

    const middle = await renderer.sceneFrame(scene, 1, false);
    const warm = renderer.referenceLocalSpaceEvidence();
    assert.ok(warm);
    assert.equal(warm.counters.localPaintSurfaceCacheMisses, 0);
    assert.equal(warm.counters.localPaintSurfaceCacheHits, 4);
    assert.equal(warm.counters.localPaintSurfaceCacheBypasses, 1);
    assert.equal(warm.counters.localPaintSurfaceCacheEvictions, 0);
    assert.equal(warm.counters.localPaintSurfaceCacheResidentBytes, 30 * 20 * 4 * 3);
    assert.equal(warm.counters.localNodeRasterizations, 1);
    assert.notEqual(sha256(first.data), sha256(middle.data),
      "the dynamic path must change while every static raster is reused");

    const repeated = await renderer.sceneFrame(scene, 0, false);
    const outOfOrder = renderer.referenceLocalSpaceEvidence();
    assert.ok(outOfOrder);
    assert.equal(sha256(repeated.data), sha256(first.data));
    assert.equal(outOfOrder.executionIdentity, cold.executionIdentity,
      "cache history must not alter the exact rendered-execution identity");
    assert.notEqual(outOfOrder.observationIdentity, cold.observationIdentity,
      "cold and warm cache behavior must remain independently auditable");
    assert.equal(outOfOrder.counters.localPaintSurfaceCacheHits, 4);
    assert.equal(outOfOrder.counters.localPaintSurfaceCacheMisses, 0);
    assert.equal(outOfOrder.counters.localPaintSurfaceCacheBypasses, 1);
    assert.equal(internals.rendererTreeContext.localPaintSurfaceCache.entryCount, 3);
    assert.equal(internals.rendererTreeContext.localPaintSurfaceCache.residentBytes, 30 * 20 * 4 * 3);
  } finally {
    await renderer.closeAndWait();
    assert.equal(internals.rendererTreeContext.localPaintSurfaceCache.entryCount, 0);
    assert.equal(internals.rendererTreeContext.localPaintSurfaceCache.residentBytes, 0);
    await rm(root, { recursive: true, force: true });
  }
});

test("LocalSpace vector Path producer bounds preserve full-surface RGBA across clipped and animated frames", { timeout: 30_000 }, async () => {
  const ir = compile(source(`LocalSpace(width: 30px, height: 20px, origin: { x: 15px, y: 10px }) {
    Rect(width: 9px, height: 6px, x: -10px, y: -7px, radius: 2px, fill: #fff2cf);
    Circle(radius: 4px, x: 11px, y: 7px, fill: #a978d1);
    Path(points: [{ x: -20px, y: 9px }, { x: 20px, y: 9px }], stroke: #f6c85f, width: 3px);
    Path(
      geometry: vectorPath(start: { x: -24px, y: -8px }, segments: [lineTo(to: { x: 24px, y: 8px })], closed: false),
      stroke: #4fc3b4, width: 5px, trimEnd: 10%
    ) as changing;
    animate changing.trimEnd from 10% to 100% over 1s;
    Path(
      geometry: vectorPath(
        start: { x: -7px, y: -4px },
        segments: [lineTo(to: { x: 8px, y: -4px }), lineTo(to: { x: 0px, y: 7px })],
        closed: true
      ),
      fill: #ef6a42
    );
  }`, 40, 30));
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-vector-alpha-bounds-"));
  assert.throws(
    () => new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, "cache-hostile"),
      undefined,
      undefined,
      1,
      { privateLocalPaintAlphaBoundsMode: "hostile" as never },
    ),
    /private LocalSpace paint alpha-bounds mode is invalid/,
  );
  const renderMode = async (mode: "automatic" | "forced-full-surface") => {
    const renderer = new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, `cache-${mode}`),
      undefined,
      undefined,
      1,
      { privateLocalPaintAlphaBoundsMode: mode },
    );
    try {
      await renderer.prepare();
      const scene = ir.scenes[composition.sceneIds[0]!]!;
      const hashes = [];
      for (const frame of [0, 1, 2, 3]) {
        hashes.push(sha256((await renderer.sceneFrame(scene, frame, false)).data));
      }
      return hashes;
    } finally {
      await renderer.closeAndWait();
    }
  };
  try {
    const full = await renderMode("forced-full-surface");
    const bounded = await renderMode("automatic");
    assert.deepEqual(bounded, full, "producer-bounded support must preserve every delivery RGBA byte");
    assert.ok(new Set(bounded).size > 1, "animated trim must exercise distinct vector Path pixels");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LocalSpace Text uses its declared layout context for explicit and omitted coordinates without delivery-canvas fallback", { timeout: 30_000 }, async () => {
  const omittedProgram = typographySource(`LocalSpace(width: 80px, height: 40px, origin: { x: 20px, y: 10px }) {
    Text(content: "A", font: face, size: 8px, color: #f5f1e8);
  }`);
  const omitted = await lockedTypographyProject(omittedProgram);
  const { composition } = validateReferenceSession(omitted.ir);
  const renderer = new ReferenceVisualRenderer(omitted.ir, composition, omitted.root, resolve(omitted.root, "cache"));
  let omittedPixels: Buffer;
  try {
    const internals = renderer as unknown as {
      textConfigs: Map<string, { x: number; y: number; maxWidth: number; lineHeight: number; maxLines: number }>;
      text: () => Promise<never>;
      localTextSurfaces: Map<string, { data: Buffer; width: number; height: number }>;
    };
    const config = [...internals.textConfigs.values()][0];
    assert.ok(config);
    assert.equal(config.x, 20, "omitted x must use the local authored-view centre, not delivery x=96");
    assert.equal(config.y, 10, "omitted y must use the local authored-view centre");
    assert.equal(config.maxWidth, 40, "omitted maxWidth must stop at the local right edge");
    assert.equal(config.lineHeight, 8.64);
    assert.equal(config.maxLines, 3, "omitted maxLines must use the local bottom edge");
    await renderer.prepare();
    internals.text = async () => { throw new Error("ordinary delivery-size Text raster path must not execute"); };
    const rendered = await renderer.sceneFrame(omitted.ir.scenes[composition.sceneIds[0]]!, 0, false);
    omittedPixels = rendered.data;
    const localSurfaces = [...internals.localTextSurfaces.values()];
    assert.equal(localSurfaces.length, 1);
    assert.deepEqual(localSurfaces.map(({ width, height, data }) => ({ width, height, bytes: data.byteLength })), [
      { width: 80, height: 40, bytes: 80 * 40 * 4 },
    ]);
    const evidence = renderer.referenceLocalSpaceEvidence();
    assert.ok(evidence);
    assert.equal(evidence.counters.localNodeRasterizations, 1);
    assert.equal(evidence.counters.localNodePixelsRasterized, 80 * 40);
    assert.equal(evidence.counters.localNodeRgbaBytesRasterized, 80 * 40 * 4);
    assert.ok(alpha(rendered).weight > 0);
    await renderer.sceneFrame(omitted.ir.scenes[composition.sceneIds[0]]!, 1, false);
    const warmEvidence = renderer.referenceLocalSpaceEvidence();
    assert.ok(warmEvidence);
    assert.equal(warmEvidence.counters.localNodeRasterizations, 0, "a reused locked local Text surface must not be reported as a new rasterization");
    assert.equal(warmEvidence.counters.localNodePixelsRasterized, 0);
    assert.equal(warmEvidence.counters.localNodeRgbaBytesRasterized, 0);
  } finally {
    await renderer.closeAndWait();
    await rm(omitted.root, { recursive: true, force: true });
  }

  const explicit = await lockedTypographyProject(typographySource(`LocalSpace(width: 80px, height: 40px, origin: { x: 20px, y: 10px }) {
    Text(content: "A", font: face, size: 8px, color: #f5f1e8, x: 20px, y: 10px);
  }`));
  const explicitSession = validateReferenceSession(explicit.ir);
  const explicitRenderer = new ReferenceVisualRenderer(explicit.ir, explicitSession.composition, explicit.root, resolve(explicit.root, "cache"));
  try {
    await explicitRenderer.prepare();
    const frame = await explicitRenderer.sceneFrame(explicit.ir.scenes[explicitSession.composition.sceneIds[0]]!, 0, false);
    assert.equal(sha256(frame.data), sha256(omittedPixels!), "explicit local-centre coordinates must match the local omitted-coordinate contract exactly");
  } finally {
    await explicitRenderer.closeAndWait();
    await rm(explicit.root, { recursive: true, force: true });
  }
});

test("LocalSpace FlowText wraps and samples exact motion frames on a local-sized surface", { timeout: 30_000 }, async () => {
  const program = typographySource(`LocalSpace(width: 120px, height: 60px, origin: { x: 20px, y: 10px }) {
    FlowText(
      spans: [textSpan(id: "lead", content: "A A A A")],
      font: face,
      size: 10px,
      color: #ffcf66,
      motions: [textUnitMotion(span: "lead", by: "word", at: 125ms, duration: 500ms, from: textUnitPose(y: 8px, opacity: 0%), before: "from")],
      layoutX: -18px,
      baselineY: 0px,
      maxWidth: 22px,
      lineHeight: 12px,
      maxLines: 3
    );
  }`, { duration: "1s", fps: 4 });
  const project = await lockedTypographyProject(program), { composition } = validateReferenceSession(project.ir);
  const renderer = new ReferenceVisualRenderer(project.ir, composition, project.root, resolve(project.root, "cache"));
  try {
    const internals = renderer as unknown as {
      flowText: () => Promise<never>;
      preparedFlowTexts: Map<string, { lineCount: number }>;
      localFlowTextSurface: (node: IRNode, config: unknown, local: unknown) => Promise<{ data: Buffer; width: number; height: number }>;
    };
    await renderer.prepare();
    assert.ok([...internals.preparedFlowTexts.values()][0]!.lineCount >= 2, "the locked local layout must execute multiline wrapping");
    internals.flowText = async () => { throw new Error("ordinary delivery-size FlowText raster path must not execute"); };
    const originalLocalFlowText = internals.localFlowTextSurface.bind(renderer), dimensions: Array<{ width: number; height: number; bytes: number }> = [];
    internals.localFlowTextSurface = async (node, config, local) => {
      const surface = await originalLocalFlowText(node, config, local);
      dimensions.push({ width: surface.width, height: surface.height, bytes: surface.data.byteLength });
      return surface;
    };
    const scene = project.ir.scenes[composition.sceneIds[0]]!, frames: Buffer[] = [], evidenceTimes: unknown[] = [];
    for (const frame of [0, 1, 2, 3]) {
      frames.push((await renderer.sceneFrame(scene, frame, false)).data);
      const evidence = renderer.referenceLocalSpaceEvidence();
      assert.ok(evidence);
      evidenceTimes.push(evidence.exactTime);
      assert.equal(evidence.counters.localNodeRasterizations, 1);
      assert.equal(evidence.counters.localNodePixelsRasterized, 120 * 60);
      assert.equal(evidence.counters.localNodeRgbaBytesRasterized, 120 * 60 * 4);
    }
    assert.deepEqual(evidenceTimes, [rational(0), rational(1, 4), rational(1, 2), rational(3, 4)]);
    assert.ok(frames[0]!.every((value, offset) => offset % 4 !== 3 || value === 0), "before: from must hold exact zero opacity before 125ms");
    assert.notEqual(sha256(frames[1]!), sha256(frames[2]!), "the exact 1/4s and 1/2s samples must execute distinct motion poses");
    assert.ok(frames[1]!.some((value, offset) => offset % 4 === 3 && value > 0));
    assert.ok(dimensions.every(({ width, height, bytes }) => width === 120 && height === 60 && bytes === 120 * 60 * 4));
  } finally {
    await renderer.closeAndWait();
    await rm(project.root, { recursive: true, force: true });
  }

  const omitted = await lockedTypographyProject(typographySource(`LocalSpace(width: 120px, height: 60px, origin: { x: 20px, y: 10px }) {
    FlowText(spans: [textSpan(id: "lead", content: "A A")], font: face, size: 10px, color: #ffcf66);
  }`));
  const omittedSession = validateReferenceSession(omitted.ir);
  const omittedRenderer = new ReferenceVisualRenderer(omitted.ir, omittedSession.composition, omitted.root, resolve(omitted.root, "cache"));
  try {
    const configs = (omittedRenderer as unknown as { flowTextConfigs: Map<string, { layoutX: number; baselineY: number; maxWidth: number; lineHeight: number; maxLines: number }> }).flowTextConfigs;
    assert.deepEqual([...configs.values()].map(({ layoutX, baselineY, maxWidth, lineHeight, maxLines }) => ({ layoutX, baselineY, maxWidth, lineHeight, maxLines })), [
      { layoutX: 40, baselineY: 20, maxWidth: 60, lineHeight: 10.8, maxLines: 3 },
    ]);
  } finally {
    await omittedRenderer.closeAndWait();
    await rm(omitted.root, { recursive: true, force: true });
  }
});

test("whole dimensions remain exact and origin Q16 uses one BigInt round-half-up decision", () => {
  const exactWhole = compile(source(`LocalSpace(width: 1.00000000000000000000px, height: 1px, origin: { x: 0px, y: 0px }) {
    Rect(width: 1px, height: 1px, fill: #ef233c);
  }`));
  assert.equal(validateReferenceLocalSpaceGraph(exactWhole, exactWhole.compositions[0]).get(localNode(exactWhole).id)?.width, 1);
  const nearWhole = parseCutLanguage(source(`LocalSpace(width: 1.00000000000000000001px, height: 1px, origin: { x: 0px, y: 0px }) {
    Rect(width: 1px, height: 1px, fill: #ef233c);
  }`));
  assert.ok(nearWhole.module);
  const diagnostics = checkCutModule(nearWhole.module!).diagnostics;
  assert.equal(diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_BOUNDS")?.severity, "error");
  const forged = structuredClone(exactWhole), forgedNode = localNode(forged);
  forgedNode.inputs.width = { kind: "quantity", dimension: "length", unit: "px", magnitude: decimalRational("1.00000000000000000001") };
  finalizeGraphHashes(forged);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(forged)),
    (error: unknown) => error instanceof CutAvIrValidationError && error.path.endsWith(".inputs.width"),
  );

  const below = decimalRational("0.0000076293945312499");
  const tie = decimalRational("0.00000762939453125");
  const above = decimalRational("0.0000076293945312501");
  assert.equal(referenceLocalSpaceOriginQ16(below), 0n);
  assert.equal(referenceLocalSpaceOriginQ16(tie), 1n);
  assert.equal(referenceLocalSpaceOriginQ16(above), 1n);

  const compiledBelow = compile(source(`LocalSpace(width: 1px, height: 1px, origin: { x: 0.0000076293945312499px, y: 0px }) {
    Rect(width: 1px, height: 1px, fill: #ef233c);
  }`));
  const compiledAbove = compile(source(`LocalSpace(width: 1px, height: 1px, origin: { x: 0.0000076293945312501px, y: 0px }) {
    Rect(width: 1px, height: 1px, fill: #ef233c);
  }`));
  const belowConfig = validateReferenceLocalSpaceGraph(compiledBelow, compiledBelow.compositions[0]).get(localNode(compiledBelow).id);
  const aboveConfig = validateReferenceLocalSpaceGraph(compiledAbove, compiledAbove.compositions[0]).get(localNode(compiledAbove).id);
  assert.equal(belowConfig?.rasterOriginQ16.x, "0");
  assert.equal(aboveConfig?.rasterOriginQ16.x, "1");
});

test("static cut-check preflight admits bounded local Composite while rejecting unsupported owner chains", () => {
  const supported = compile(source(`LocalSpace(width: 12px, height: 12px, origin: { x: 6px, y: 6px }) {
    Composite(blend: "screen") {
      Rect(width: 2px, height: 2px, fill: #ef233c);
      Rect(width: 2px, height: 2px, fill: #ffffff);
    }
  }`));
  assert.deepEqual(validateReferenceStaticVisualGraphs(supported), []);

  const ownerChain = compile(source(`Group(x: 1px) { Group(rotation: 10deg) {
    LocalSpace(width: 12px, height: 12px, origin: { x: 6px, y: 6px }) {
      Rect(width: 2px, height: 2px, fill: #ef233c);
    }
  } }`));
  const chainDiagnostics = validateReferenceStaticVisualGraphs(ownerChain);
  assert.equal(chainDiagnostics[0]?.code, "CUT_LOCAL_SPACE_UNSUPPORTED");
  assert.match(chainDiagnostics[0]!.message, /delivery-sized intermediate/u);

  const motion = compile(source(`MotionPath(points: [{ x: 5px, y: 5px }, { x: 35px, y: 35px }]) {
    LocalSpace(width: 8px, height: 8px, origin: { x: 4px, y: 4px }) {
      Rect(width: 2px, height: 2px, fill: #ef233c);
    }
  }
  Rect(width: 1px, height: 1px, fill: #ffffff);`));
  const motionNode = Object.values(motion.nodes).find((node) => node.op === "cut.visual.motion_path");
  const otherRoot = Object.values(motion.nodes).find((node) => node.op === "cut.visual.rect" && node.sceneId === motionNode?.sceneId && !motionNode?.children.includes(node.id));
  assert.ok(motionNode && otherRoot);
  motionNode.children.push(otherRoot.id);
  otherRoot.ownership = "child";
  const motionDiagnostics = validateReferenceStaticVisualGraphs(motion);
  assert.equal(motionDiagnostics[0]?.code, "CUT_LOCAL_SPACE_UNSUPPORTED");
  assert.match(motionDiagnostics[0]!.message, /exact unary/u);
});

test("LocalSpace typography fails source-located and retained media separates asset-free check from locked planning", () => {
  const textIr = compile(typographySource(`LocalSpace(width: 80px, height: 40px, origin: { x: 20px, y: 10px }) {
    Text(content: "A", font: face, size: 8px, color: #f5f1e8);
  }`));
  const text = Object.values(textIr.nodes).find((node) => node.op === "cut.visual.text");
  assert.ok(text);
  delete text.inputs.font;
  assert.throws(
    () => validateReferenceLocalSpaceGraph(textIr, textIr.compositions[0]),
    (error: unknown) => error instanceof ReferenceTextConfigError
      && error.code === "CUT_TEXT_RESOURCE"
      && error.source?.nodeId === text.id
      && /host font fallback is forbidden/u.test(error.message),
  );

  const flowIr = compile(typographySource(`LocalSpace(width: 120px, height: 60px, origin: { x: 20px, y: 10px }) {
    FlowText(spans: [textSpan(id: "lead", content: "A")], font: face, size: 10px, color: #ffcf66);
  }`));
  const flow = Object.values(flowIr.nodes).find((node) => node.op === "cut.visual.flow_text");
  assert.ok(flow);
  flow.inputs.font = { kind: "string", value: "system-ui" };
  assert.throws(
    () => validateReferenceLocalSpaceGraph(flowIr, flowIr.compositions[0]),
    (error: unknown) => error instanceof ReferenceFlowTextError
      && error.code === "CUT_FLOW_TEXT_RESOURCE"
      && error.source.nodeId === flow.id
      && /fallback.*forbidden/u.test(error.message),
  );

  const imageProgram = `cut 0.4;
project "LocalSpace refuses media fallback";
import { Image, LocalSpace } from "cut:visual";
asset still: ImageAsset = image("assets/not-opened.png");
timeline main(duration: 1s, fps: 4, width: 160px, height: 100px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    LocalSpace(width: 80px, height: 40px, origin: { x: 20px, y: 10px }) { Image(source: still); }
  }
}
export out = render(main, width: 160px, height: 100px, codec: "h264");`;
  const imageIr = compile(imageProgram), diagnostics = validateReferenceStaticVisualGraphs(imageIr);
  assert.deepEqual(diagnostics, [], "asset-free check validates public retained-media topology before lock");
  assert.throws(
    () => validateReferenceLocalSpaceGraph(imageIr, imageIr.compositions[0]),
    /CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE:.*complete locked cut-image-probe/u,
    "locked runtime planning still requires exact probe metadata",
  );
});

test("ordinary non-LocalSpace Text and FlowText retain the frozen pre-slice pixels", { timeout: 30_000 }, async () => {
  const program = `cut 0.4;
project "LocalSpace nonlocal regression baseline";
import { FlowText, Text, textSpan } from "cut:visual";
asset face: FontAsset = font("assets/face.ttf");
timeline main(duration: 1s, fps: 4, width: 160px, height: 90px) {
 scene only(duration: 1s) {
  Text(content: "CUT TEXT", font: face, size: 13px, color: #f5f1e8, x: 12px, y: 20px, maxWidth: 130px, lineHeight: 15px, maxLines: 2, tracking: 0.4px);
  FlowText(spans: [textSpan(id: "lead", content: "FLOW TYPE")], font: face, size: 11px, color: #ffcf66, layoutX: 12px, baselineY: 48px, maxWidth: 130px, lineHeight: 13px, maxLines: 2);
 }
}
export out = render(main, width: 160px, height: 90px, codec: "h264");`;
  const project = await lockedTypographyProject(program), { composition } = validateReferenceSession(project.ir);
  const renderer = new ReferenceVisualRenderer(project.ir, composition, project.root, resolve(project.root, "cache"));
  try {
    await renderer.prepare();
    const rendered = await renderer.sceneFrame(project.ir.scenes[composition.sceneIds[0]]!, 0, false);
    assert.equal(sha256(rendered.data), "a7b59174ec31a51b6b053065584a0f18228970cf16c664042484eaba4129bd78");
    assert.equal(renderer.referenceLocalSpaceEvidence()?.counters.tileRequests, 0);
  } finally {
    await renderer.closeAndWait();
    await rm(project.root, { recursive: true, force: true });
  }
});

test("fractional origin reaches the CUT Q16 placement path with analytic alpha", async () => {
  const result = await render(source(`LocalSpace(width: 1px, height: 1px, origin: { x: 0.25px, y: 0.25px }) {
    Rect(width: 1px, height: 1px, fill: #c86432);
  }`, 5, 5));
  const visible = alpha(result.frame).values;
  assert.deepEqual(visible, [
    { x: 2, y: 2, alpha: 143 },
    { x: 3, y: 2, alpha: 48 },
    { x: 2, y: 3, alpha: 48 },
    { x: 3, y: 3, alpha: 16 },
  ]);
});

test("root, Group, and MotionPath consume registration instead of tile centre", async () => {
  const ordinary = alpha((await render(source(`LocalSpace(width: 12px, height: 8px, origin: { x: 1px, y: 7px }) {
    Rect(width: 2px, height: 2px, x: 0px, y: 0px, fill: #ef233c);
  }`))).frame);
  assert.ok(Math.abs(ordinary.x - 19.5) < .6 && Math.abs(ordinary.y - 19.5) < .6, JSON.stringify(ordinary));

  const grouped = alpha((await render(source(`Group(x: 5px, y: -4px, rotation: 90deg) {
    LocalSpace(width: 12px, height: 8px, origin: { x: 1px, y: 7px }) {
      Rect(width: 2px, height: 2px, x: 3px, y: 0px, fill: #ef233c);
    }
  }`))).frame);
  assert.ok(Math.abs(grouped.x - 25.5) < .8 && Math.abs(grouped.y - 18.5) < .8, JSON.stringify(grouped));

  const moved = alpha((await render(source(`MotionPath(points: [{ x: 6px, y: 30px }, { x: 34px, y: 30px }], progress: 50%) {
    LocalSpace(width: 12px, height: 8px, origin: { x: 1px, y: 7px }) {
      Rect(width: 2px, height: 2px, x: 0px, y: 0px, fill: #ef233c);
    }
  }`))).frame);
  assert.ok(Math.abs(moved.x - 19.5) < .6 && Math.abs(moved.y - 29.5) < .6, JSON.stringify(moved));
});

test("LocalSpace MotionPath descendants execute local geometry, animation, orientation, opacity, clipping, nested components, inspect, and deterministic seeking", { timeout: 30_000 }, async () => {
  const program = localMotionDescendantSource(), ir = compile(program);
  assert.deepEqual(validateReferenceStaticVisualGraphs(ir), []);
  const { composition } = validateReferenceSession(ir), space = localNode(ir);
  const motion = Object.values(ir.nodes).find((node) => node.op === "cut.visual.motion_path");
  assert.ok(motion);
  const config = validateReferenceLocalSpaceGraph(ir, composition).get(space.id);
  assert.ok(config?.localMotionPath);
  assert.deepEqual(config.localMotionPath.nodeIds, [motion.id]);
  assert.equal(config.localMotionPath.algorithmVersion, "cut-reference-local-motion-path-v1");
  assert.equal(config.localMotionPath.coordinateBasis, "authored-local-pixel-edges");
  assert.equal(config.localMotionPath.authoredSampleContract, "path-head-before-centre-relative-raster-placement");

  const inspected = inspectCutIr(ir, "main.cut").graph.nodes.find((candidate) => candidate.id === motion.id)?.motionPath;
  assert.ok(inspected);
  assert.ok("localExecution" in inspected, "local MotionPath inspect must disclose its retained execution basis");
  const localExecution = inspected.localExecution;
  assert.ok(isRecord(localExecution));
  assert.equal(localExecution.algorithmVersion, "cut-reference-local-motion-path-v1");
  assert.equal(localExecution.localSpaceNodeId, space.id);
  assert.equal(localExecution.coordinateBasis, "authored-local-pixel-edges");
  assert.deepEqual(localExecution.rasterOriginQ16, config.rasterOriginQ16);
  assert.equal(localExecution.deliveryCanvasFallback, "forbidden");
  assert.ok(Math.abs(inspected.executedAtActiveStart.x - -27) < 1e-9,
    "the top-level direct-canvas MotionPath inspect contract must remain unchanged");
  assert.ok(Math.abs(inspected.executedAtActiveStart.y - -16) < 1e-9,
    "the top-level direct-canvas MotionPath inspect contract must remain unchanged");
  assert.deepEqual(localExecution.authoredLocalAtActiveStart, {
    time: { numerator: "0", denominator: "1" },
    progress: 0,
    x: -10,
    y: -4,
    rotation: inspected.executedAtActiveStart.rotation,
  });
  const localExecutionIdentity = localExecution.semanticIdentity;
  assert.ok(typeof localExecutionIdentity === "string");
  assert.match(localExecutionIdentity, /^[a-f0-9]{64}$/u);
  const localInspection = inspectCutIr(ir, "main.cut").graph.nodes.find((candidate) => candidate.id === space.id)?.localSpace;
  assert.deepEqual(localInspection?.localMotionPath?.nodeIds, [motion.id]);

  const root = await mkdtemp(resolve(tmpdir(), "cut-local-motion-descendant-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[composition.sceneIds[0]]!;
    const firstFrame4 = await renderer.sceneFrame(scene, 4, false);
    const frame0 = await renderer.sceneFrame(scene, 0, false);
    const frame2 = await renderer.sceneFrame(scene, 2, false);
    const frame4 = await renderer.sceneFrame(scene, 4, false);
    assert.notEqual(sha256(frame0.data), sha256(frame2.data), "progress and opacity must change local pixels before the midpoint");
    assert.notEqual(sha256(frame2.data), sha256(frame4.data), "the exact completion frame must produce a new local pose");
    assert.equal(sha256(frame4.data), sha256(firstFrame4.data),
      "4 → 0 → 2 → 4 out-of-order local MotionPath seeking must be byte deterministic");
    const start = alpha(frame0), middle = alpha(frame2), end = alpha(frame4);
    assert.ok(start.weight > 0 && middle.weight > start.weight && end.weight >= middle.weight,
      "clipped low-opacity start must accumulate visible alpha as the subject enters and its authored opacity rises");
    assert.ok(start.x < middle.x && middle.x < end.x, "local progress must move the nested component along the authored path");
    const evidence = renderer.referenceLocalSpaceEvidence();
    assert.ok(evidence);
    assert.equal(evidence.tiles.length, 1);
    assert.equal(evidence.placements.length, 1);
    assert.equal(evidence.counters.localNodeRasterizations, 0,
      "the final out-of-order frame must reuse the static retained path and two component shape rasters");
    assert.equal(evidence.counters.localPaintSurfaceCacheHits, 3);
    assert.equal(evidence.counters.localPaintSurfaceCacheMisses, 0);
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }

  const unoriented = await render(localMotionDescendantSource(12, false), 2);
  const oriented = await render(program, 2);
  assert.notEqual(sha256(oriented.frame.data), sha256(unoriented.frame.data),
    "orientToPath must rotate the non-square nested component in local coordinates");

  const changed = compile(localMotionDescendantSource(15));
  const changedConfig = validateReferenceLocalSpaceGraph(changed, changed.compositions[0]).get(localNode(changed).id);
  assert.ok(changedConfig);
  assert.notEqual(
    referenceLocalSpaceTileIdentity(config, rational(1, 2), "local-motion-test-backend"),
    referenceLocalSpaceTileIdentity(changedConfig, rational(1, 2), "local-motion-test-backend"),
    "local MotionPath geometry must invalidate the retained tile identity",
  );
});

test("LocalSpace MotionPath descendants retain closed resource limits and reject unsupported anchored coordinate ownership", () => {
  const excessive = localMotionDescendantSource(65_537);
  const excessiveParsed = parseCutLanguage(excessive);
  const excessiveModule = excessiveParsed.module;
  assert.ok(excessiveModule, JSON.stringify(excessiveParsed.diagnostics));
  const excessiveCheck = checkCutModule(excessiveModule);
  assert.deepEqual(excessiveCheck.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), [],
    "the typed public source is valid before the exact compiled geometry bound is applied");
  let excessiveError: unknown;
  try { compileCutModule(excessiveModule); }
  catch (error) { excessiveError = error; }
  assert.ok(excessiveError instanceof CutCompileError);
  const excessiveDiagnostic = excessiveError.result.diagnostics.find((diagnostic) =>
    diagnostic.code === "CUT_MOTION_PATH_LIMIT");
  assert.ok(excessiveDiagnostic);
  assert.match(
    excessiveDiagnostic.message,
    /^CUT_MOTION_PATH_LIMIT: .* input “geometry”\.segments\[0\]\.to exceeds the ±65536px coordinate envelope$/u,
  );
  assert.deepEqual(excessiveDiagnostic.span, {
    start: { offset: 898, line: 30, column: 9 },
    end: { offset: 975, line: 30, column: 86 },
  });

  const anchored = compile(`cut 0.4;
project "LocalSpace anchored MotionPath refusal";
import { Group, LocalSpace, MotionPath, Rect, anchoredLineTo, anchoredPath, visualAnchor } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 40px, height: 40px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Group() as owner {
      LocalSpace(width: 20px, height: 20px, origin: { x: 10px, y: 10px }) {
        Rect(width: 4px, height: 4px, fill: #ffffff);
      }
    }
    LocalSpace(width: 20px, height: 20px, origin: { x: 10px, y: 10px }) {
      MotionPath(
        geometry: anchoredPath(
          start: visualAnchor(owner: owner, local: { x: -4px, y: 0px }),
          segments: [anchoredLineTo(to: visualAnchor(owner: owner, local: { x: 4px, y: 0px }))],
          closed: false
        )
      ) {
        Rect(width: 2px, height: 2px, fill: #ef233c);
      }
    }
  }
}
export out = render(main, width: 40px, height: 40px, codec: "h264");`);
  assert.throws(
    () => validateReferenceLocalSpaceGraph(anchored, anchored.compositions[0]),
    (error: unknown) => error instanceof ReferenceLocalSpaceError
      && error.code === "CUT_LOCAL_SPACE_UNSUPPORTED"
      && /AnchoredPathGeometry.*local-coordinate basis/u.test(error.message)
      && error.source.nodeId === Object.values(anchored.nodes).find((node) => node.op === "cut.visual.motion_path")?.id,
  );

  const legal = compile(localMotionDescendantSource());
  finalizeGraphHashes(legal);
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(legal)),
    "the strict public CutAVIR loader must admit the same ordinary local MotionPath graph as the runtime");
  finalizeGraphHashes(anchored);
  const anchoredMotion = Object.values(anchored.nodes).find((node) => node.op === "cut.visual.motion_path");
  assert.ok(anchoredMotion);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(anchored)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_UNKNOWN_FIELD"
      && error.path === `$.nodes.${anchoredMotion.id}.inputs.geometry`
      && /no ordinary LocalSpace coordinate basis/u.test(error.message),
    "strict hostile-IR loading must refuse owner-resolved anchored geometry inside an ordinary local basis",
  );
});

test("the packaged retained-camera LocalSpace MotionPath fixture changes pixels deterministically", { timeout: 30_000 }, async () => {
  const program = await readFile(resolve("examples/local-motion-path-camera.cut"), "utf8");
  const ir = compile(program), { composition } = validateReferenceSession(ir);
  assert.deepEqual(validateReferenceStaticVisualGraphs(ir), []);
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-motion-camera-fixture-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[composition.sceneIds[0]]!;
    const start = await renderer.sceneFrame(scene, 0, false);
    const middle = await renderer.sceneFrame(scene, 12, false);
    const end = await renderer.sceneFrame(scene, 23, false);
    const repeatedMiddle = await renderer.sceneFrame(scene, 12, false);
    assert.notEqual(sha256(start.data), sha256(middle.data));
    assert.notEqual(sha256(middle.data), sha256(end.data));
    assert.equal(sha256(middle.data), sha256(repeatedMiddle.data));
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("unary Group transforms a raw nested tile into view before the outer clip", async () => {
  const result = await render(source(`LocalSpace(width: 20px, height: 20px, origin: { x: 10px, y: 10px }) {
    Group(x: 5px, y: -20px, rotation: 90deg) {
      LocalSpace(width: 30px, height: 10px, origin: { x: 0px, y: 0px }) {
        Rect(width: 3px, height: 3px, x: 25px, y: 2px, fill: #ef233c);
      }
    }
  }`));
  const visible = alpha(result.frame);
  assert.ok(visible.weight > 0, "content outside the untransformed outer tile must survive until Group brings it into view");
  assert.ok(Math.abs(visible.x - 23.5) < 1 && Math.abs(visible.y - 24.5) < 1, JSON.stringify(visible));
});

test("non-neutral LocalSpace filtering associates low-coverage color and prevents transform halos", async () => {
  const result = await render(source(`Group(scale: 5, skewX: 11deg, rotation: 17deg) {
    LocalSpace(width: 4px, height: 2px, origin: { x: 2px, y: 1px }) {
      Rect(width: 2px, height: 2px, x: -1px, fill: #ff000001);
      Rect(width: 2px, height: 2px, x: 1px, fill: #0000ffff);
    }
  }`, 48, 48));
  let mixedPixels = 0, maximumRed = 0, maximumBlue = 0;
  for (let offset = 0; offset < result.frame.data.length; offset += 4) {
    const red = result.frame.data[offset], blue = result.frame.data[offset + 2], coverage = result.frame.data[offset + 3];
    if (coverage < 8 || blue < 8) continue;
    mixedPixels += 1;
    maximumRed = Math.max(maximumRed, red);
    maximumBlue = Math.max(maximumBlue, blue);
  }
  assert.ok(mixedPixels > 0 && maximumBlue > 200, "the adversarial low-alpha/opaque edge must pass through scale, skew, and rotation filters");
  assert.ok(maximumRed <= 16, `low-coverage red leaked into visible blue edge pixels (maximum red ${maximumRed})`);
  assert.ok(result.frame.data.every((value, offset) => offset % 4 === 3 || result.frame.data[offset - offset % 4 + 3] !== 0 || value === 0), "filtered alpha-zero pixels must not retain hidden RGB");
});

test("LocalSpace opacity clears hidden RGB and zero owner opacity skips tile rasterization", async () => {
  const quantizedAway = await render(source(`Group(opacity: 0.1%) {
    LocalSpace(width: 3px, height: 3px, origin: { x: 1px, y: 1px }) {
      Rect(width: 3px, height: 3px, fill: #ef233c);
    }
  }`));
  assert.ok(quantizedAway.frame.data.every((byte) => byte === 0), "alpha quantized to zero must clear RGB at the LocalSpace boundary");

  const program = source(`Group(opacity: 0%) {
    LocalSpace(width: 3px, height: 3px, origin: { x: 1px, y: 1px }) {
      Rect(width: 3px, height: 3px, fill: #ef233c);
    }
  }`);
  const ir = compile(program), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-zero-opacity-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const internals = renderer as unknown as { localSpaceTile: () => never };
    internals.localSpaceTile = () => { throw new Error("tile rasterization must not run"); };
    const frame = await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]]!, 0, false);
    assert.ok(frame.data.every((byte) => byte === 0));
    const evidence = renderer.referenceLocalSpaceEvidence();
    assert.ok(evidence);
    assert.equal(evidence.counters.tileRequests, 0);
    assert.equal(evidence.counters.tileRasterizations, 0);
    assert.equal(evidence.counters.ownerOpacitySkips, 1);
    assert.deepEqual(evidence.skips.map((item) => ({ kind: item.kind, reason: item.reason })), [
      { kind: "owner-opacity", reason: "opacity-zero" },
    ]);
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Precomp accepts a LocalSpace inside its source timeline but LocalSpace refuses a Precomp descendant at its source span", async () => {
  const accepted = `cut 0.4;
project "LocalSpace precomposition boundary acceptance";
import { LocalSpace, Precomp, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 40px, height: 40px, sampleRate: 48khz) {
  scene delivery(duration: 1s) { Precomp(source: insert); }
}
timeline insert(duration: 1s, fps: 4, width: 40px, height: 40px, sampleRate: 48khz) {
  scene source(duration: 1s) {
    LocalSpace(width: 8px, height: 6px, origin: { x: 1px, y: 5px }) {
      Rect(width: 2px, height: 2px, x: 0px, y: 0px, fill: #ef233c);
    }
  }
}
export out = render(main);`;
  const rendered = await render(accepted);
  const visible = alpha(rendered.frame);
  assert.ok(visible.weight > 0);
  assert.ok(Math.abs(visible.x - 19.5) < .6 && Math.abs(visible.y - 19.5) < .6, JSON.stringify(visible));

  const refused = `cut 0.4;
project "LocalSpace precomposition boundary refusal";
import { LocalSpace, Precomp, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 40px, height: 40px, sampleRate: 48khz) {
  scene delivery(duration: 1s) {
    LocalSpace(width: 12px, height: 12px, origin: { x: 6px, y: 6px }) {
      Precomp(source: insert);
    }
  }
}
timeline insert(duration: 1s, fps: 4, width: 40px, height: 40px, sampleRate: 48khz) {
  scene source(duration: 1s) { Rect(width: 2px, height: 2px, fill: #ef233c); }
}
export out = render(main);`;
  const refusedIr = compile(refused);
  const diagnostics = validateReferenceStaticVisualGraphs(refusedIr);
  assert.equal(diagnostics[0]?.code, "CUT_LOCAL_SPACE_UNSUPPORTED");
  assert.equal(diagnostics[0]?.span.start.line, 7);
  assert.match(diagnostics[0]?.message ?? "", /precomp.*no local-coordinate raster slice/iu);
});

test("renderer-tree evidence retains each visible Precomp/NestedSequence LocalSpace execution and shares one structural index", async () => {
  const program = `cut 0.4;
project "nested LocalSpace renderer-tree evidence";
import { LocalSpace, Precomp, Rect } from "cut:visual";
import { NestedSequence } from "@cut/edit";
timeline main(duration: 1s, fps: 4, width: 40px, height: 40px, sampleRate: 48khz) {
  scene delivery(duration: 1s) {
    Precomp(source: insert, x: -5px);
    Precomp(source: insert, x: 5px);
    NestedSequence(source: insert);
  }
}
timeline insert(duration: 1s, fps: 4, width: 40px, height: 40px, sampleRate: 48khz) {
  scene source(duration: 1s) {
    LocalSpace(width: 8px, height: 6px, origin: { x: 1px, y: 5px }) {
      Rect(width: 2px, height: 2px, x: 0px, y: 0px, fill: #ef233c);
    }
  }
}
export out = render(main);`;
  const ir = compile(program), composition = ir.compositions.find((candidate) => candidate.name === "main")!;
  const sourceComposition = ir.compositions.find((candidate) => candidate.name === "insert")!;
  const scene = ir.scenes[composition.sceneIds[0]]!;
  const instanceIds = scene.items.map((item) => item.id)
    .filter((id) => ir.nodes[id]?.op === "cut.visual.precomp" || ir.nodes[id]?.op === "cut.edit.nested_sequence")
    .sort();
  assert.equal(instanceIds.length, 3);
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-renderer-tree-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const internals = renderer as unknown as {
      localSpaceStructuralIndex: object;
      precompRenderers: Map<string, { localSpaceStructuralIndex: object }>;
    };
    assert.equal(internals.precompRenderers.size, 3);
    for (const nested of internals.precompRenderers.values()) {
      assert.equal(nested.localSpaceStructuralIndex, internals.localSpaceStructuralIndex,
        "one immutable whole-IR structural index must be shared by every renderer instance");
    }

    const frame = await renderer.sceneFrame(scene, 0, false);
    assert.ok(frame.data.some((byte, index) => index % 4 === 3 && byte > 0), "nested LocalSpaces must contribute visible pixels");
    const receipts = renderer.referenceLocalSpaceRendererFrameExecutionEvidence();
    const trusted = renderer.referenceLocalSpaceRendererFrameExecutionTrustedContexts();
    const tree = renderer.referenceLocalSpaceRendererFrameExecutionTreeEvidence();
    const authority = renderer.referenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority();
    assert.equal(receipts.length, 4, "root plus three distinct Precomp/NestedSequence renderer instances");
    assert.equal(trusted.length, receipts.length);
    assert.deepEqual(validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics(receipts, {
      ir,
      rootCompositionId: composition.id,
      treeEvidence: tree,
      trustedAuthority: authority,
    }), receipts);
    assert.equal(tree.rendererFrameCount, 4);
    assert.throws(() => validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics(receipts.slice(0, 1), {
      ir,
      rootCompositionId: composition.id,
      treeEvidence: tree,
      trustedAuthority: authority,
    }), (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
      && /exact complete ordered receipt array|every root and nested renderer execution/u.test(error.message));
    assert.throws(() => validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics(receipts, {
      ir,
      rootCompositionId: composition.id,
      treeEvidence: tree,
      trustedAuthority: { ...authority },
    }), (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
      && /was not issued/u.test(error.message));
    assert.throws(() => validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics(receipts, {
      ir: structuredClone(ir),
      rootCompositionId: composition.id,
      treeEvidence: tree,
      trustedAuthority: authority,
    }), (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
      && /different locked IR object or root composition/u.test(error.message));
    assert.deepEqual(receipts[0]!.executionPath, [{ compositionId: composition.id }]);
    assert.equal(receipts[0]!.execution.placements.length, 0);
    assert.equal(receipts[0]!.preflight.status, "zero-visible-affine-placements");

    const children = receipts.slice(1);
    assert.deepEqual(children.map((entry) => entry.executionPath[0]?.instanceNodeId), instanceIds);
    for (const [index, entry] of children.entries()) {
      assert.deepEqual(entry.executionPath, [
        { compositionId: composition.id, instanceNodeId: instanceIds[index], sourceCompositionId: sourceComposition.id },
        { compositionId: sourceComposition.id },
      ]);
      assert.equal(entry.execution.placements.length, 1);
      assert.equal(entry.execution.counters.transformExecutions, 1);
      assert.equal(entry.preflight.status, "admitted");
      assert.equal(entry.preflight.admissions.length, 1);
      assert.equal(entry.execution.placements[0]?.transformWork?.workIdentity, entry.preflight.admissions[0]?.work.workIdentity);
      assert.notEqual(trusted[index + 1]!.expected, entry);
      assert.notEqual(trusted[index + 1]!.expected.execution, entry.execution);
      assert.deepEqual(trusted[index + 1]!.expected, entry);
      assert.equal(trusted[index + 1]!.authority, "locked-ir-and-live-frame-execution");
    }
    assert.equal(new Set(children.map((entry) => entry.execution.executionIdentity)).size, 1,
      "identical source renderer work may have the same child receipt identity");
    assert.equal(new Set(children.map((entry) => entry.rendererFrameIdentity)).size, 3,
      "distinct instance paths must remain distinct instead of identity-deduping real work");
    assert.equal(receipts.reduce((sum, entry) => sum + entry.execution.counters.transformExecutions, 0), 3);

    const child = children[0]!;
    const matchingAuthority = (expected: typeof child) => Object.freeze({
      authority: "locked-ir-and-live-frame-execution" as const,
      expected,
    });
    const falseZeroPreflight = (() => {
      const copy = structuredClone(child.preflight);
      Reflect.deleteProperty(copy, "aggregate");
      return Object.freeze({
        ...copy,
        status: "zero-visible-affine-placements" as const,
        admissions: Object.freeze([]),
        skips: Object.freeze([]),
      });
    })();
    const falseZero = referenceLocalSpaceRendererFrameExecutionEvidence({
      executionPath: child.executionPath,
      execution: child.execution,
      preflight: falseZeroPreflight,
    });
    assert.throws(() => validateReferenceLocalSpaceRendererFrameExecutionSemantics(falseZero, matchingAuthority(falseZero), {
      ir,
      rootCompositionId: composition.id,
    }), (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
      && /without a one-to-one composition admission/u.test(error.message));

    const fakeOwnerPreflight = Object.freeze({
      ...child.preflight,
      admissions: Object.freeze(child.preflight.admissions.map((admission, index) => Object.freeze({
        ...admission,
        ...(index === 0 ? { ownerNodeId: "forged-owner" } : {}),
      }))),
    });
    const fakeOwner = referenceLocalSpaceRendererFrameExecutionEvidence({
      executionPath: child.executionPath,
      execution: child.execution,
      preflight: fakeOwnerPreflight,
    });
    assert.throws(() => validateReferenceLocalSpaceRendererFrameExecutionSemantics(fakeOwner, matchingAuthority(fakeOwner), {
      ir,
      rootCompositionId: composition.id,
    }), (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
      && /validated LocalSpace owner/u.test(error.message));

    const originalPlacement = child.execution.placements[0]!;
    assert.ok(originalPlacement.transform);
    const changedPlacement = Object.freeze({
      ...originalPlacement,
      transform: Object.freeze({ ...originalPlacement.transform, scale: originalPlacement.transform.scale + 0.125 }),
    });
    const changedExecution = referenceLocalSpaceFrameEvidence({
      compositionId: child.execution.compositionId,
      exactTime: child.execution.exactTime,
      outputFrame: child.execution.outputFrame,
      backendIdentity: child.execution.backendIdentity,
      counters: child.execution.counters,
      tiles: child.execution.tiles,
      placements: [changedPlacement],
      skips: child.execution.skips,
    });
    const changedTransform = referenceLocalSpaceRendererFrameExecutionEvidence({
      executionPath: child.executionPath,
      execution: changedExecution,
      preflight: child.preflight,
    });
    assert.throws(() => validateReferenceLocalSpaceRendererFrameExecutionSemantics(changedTransform, matchingAuthority(changedTransform), {
      ir,
      rootCompositionId: composition.id,
    }), (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
      && /public transform planner|admitted work and observed transform geometry/u.test(error.message));

    await renderer.sceneFrame(scene, 0, false);
    const repeated = renderer.referenceLocalSpaceRendererFrameExecutionEvidence();
    const repeatedTree = renderer.referenceLocalSpaceRendererFrameExecutionTreeEvidence();
    const repeatedAuthority = renderer.referenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority();
    assert.equal(repeated.length, 4, "a repeated frame replaces rather than accumulates renderer-tree receipts");
    assert.deepEqual(repeated.map((entry) => entry.rendererFrameIdentity), receipts.map((entry) => entry.rendererFrameIdentity));
    assert.deepEqual(repeatedTree, tree);
    assert.notEqual(repeatedAuthority, authority, "each successful invocation must mint a fresh live authority");
    assert.throws(() => validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics(receipts, {
      ir,
      rootCompositionId: composition.id,
      treeEvidence: tree,
      trustedAuthority: authority,
    }), (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError && /was not issued/u.test(error.message));
    assert.deepEqual(validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics(repeated, {
      ir,
      rootCompositionId: composition.id,
      treeEvidence: repeatedTree,
      trustedAuthority: repeatedAuthority,
    }), repeated);

    const published = await renderReferenceFrameArtifact(ir, root, resolve(root, "nested-local-space.png"), {
      frame: 0,
      mediaProfile: "master",
    });
    assert.equal(published.execution.localSpaces.length, 1, "the frozen-compatible field remains the root receipt");
    assert.equal(published.execution.localSpaces[0]!.placements.length, 0);
    assert.equal(published.execution.localSpaceExecutions.length, 4,
      "the public exact-frame manifest must retain root plus all nested renderer instances");
    assert.equal(published.execution.localSpaceExecutionTree.rendererFrameCount, 4);
    assert.equal(published.execution.localSpaceExecutions.reduce((sum, entry) =>
      sum + entry.execution.counters.transformExecutions, 0), 3);
    assert.deepEqual(published.execution.localSpaceExecutions.map((entry) => entry.rendererFrameIdentity),
      receipts.map((entry) => entry.rendererFrameIdentity));
    assert.equal(validateCurrentReferenceFrameLocalSpaceExecutionTree(published), published);
    const truncated = structuredClone(published);
    (truncated.execution.localSpaceExecutions as unknown as Array<(typeof truncated.execution.localSpaceExecutions)[number]>).splice(1, 1);
    assert.throws(() => validateCurrentReferenceFrameLocalSpaceExecutionTree(truncated),
      (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
        && /does not close over the complete ordered renderer execution tree/u.test(error.message));
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed sibling rendering drains the captured evidence generation before another frame may begin", async () => {
  const ir = compile(source(`
    Rect(width: 4px, height: 4px, x: -5px, fill: #ef233c);
    Rect(width: 4px, height: 4px, x: 5px, fill: #33aa77);
  `));
  const { composition } = validateReferenceSession(ir), scene = ir.scenes[composition.sceneIds[0]]!;
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-generation-drain-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const roots = scene.items.filter((item) => item.domain === "visual").map((item) => item.id);
    assert.equal(roots.length, 2);
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    const siblingStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const internals = renderer as unknown as {
      nodeFrameExecution: (nodeId: string) => Promise<undefined>;
      rendererTreeContext: { evidenceBudget: { current?: { active: boolean; records: number; copyUnits: number } } };
      reserveLocalSpaceRendererTreeEvidenceRecords: (count: number) => void;
    };
    internals.nodeFrameExecution = async (nodeId: string) => {
      if (nodeId === roots[0]) throw new Error("forced root failure");
      started();
      await held;
      internals.reserveLocalSpaceRendererTreeEvidenceRecords(0);
      return undefined;
    };
    const rendering = renderer.sceneFrame(scene, 0, false);
    let settled = false;
    void rendering.then(() => { settled = true; }, () => { settled = true; });
    await siblingStarted;
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    assert.equal(settled, false, "sceneFrame must remain active while its rejected sibling graph still has work");
    assert.equal(internals.rendererTreeContext.evidenceBudget.current?.active, true);
    await assert.rejects(() => renderer.sceneFrame(scene, 1, false), /CUT_VISUAL_RENDER_REENTRANT/u);
    release();
    await assert.rejects(rendering, /forced root failure/u);
    assert.equal(internals.rendererTreeContext.evidenceBudget.current, undefined);
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("tile identity binds exact local content while placement identity binds its owner context", () => {
  const ir = compile(source(`Group(x: 2px) {
    LocalSpace(width: 9px, height: 7px, origin: { x: 4.5px, y: 3.5px }) {
      Rect(width: 2px, height: 2px, fill: #ef233c);
    }
  }`));
  const config = validateReferenceLocalSpaceGraph(ir, ir.compositions[0]).get(localNode(ir).id);
  assert.ok(config);
  const tile = referenceLocalSpaceTileIdentity(config, rational(0), "test-backend");
  const base = {
    owner: "group" as const,
    contextIdentity: "context-a",
    destinationX: 20,
    destinationY: 20,
    registrationRasterX: 4.5,
    registrationRasterY: 3.5,
    scale: 1,
    skewX: 0,
    skewY: 0,
    rotation: 0,
    opacity: 1,
  };
  assert.notEqual(
    referenceLocalSpacePlacementIdentity(config, tile, base),
    referenceLocalSpacePlacementIdentity(config, tile, { ...base, destinationX: 21 }),
  );
  assert.notEqual(
    referenceLocalSpacePlacementIdentity(config, tile, base),
    referenceLocalSpacePlacementIdentity(config, tile, { ...base, contextIdentity: "context-b" }),
  );
});

test("LocalSpace typography tile identity binds locked font, content, local context, and FlowText motion", () => {
  const identity = (program: string, fontHash: string) => {
    const ir = compile(program), resource = Object.values(ir.resources).find((candidate) => candidate.kind === "font");
    assert.ok(resource);
    resource.state = "locked";
    resource.sha256 = fontHash;
    finalizeGraphHashes(ir);
    const config = validateReferenceLocalSpaceGraph(ir, ir.compositions[0]).get(localNode(ir).id);
    assert.ok(config);
    return referenceLocalSpaceTileIdentity(config, rational(1, 4), "locked-typography-test-backend");
  };
  const text = (content: string, originX = 20) => typographySource(`LocalSpace(width: 80px, height: 40px, origin: { x: ${originX}px, y: 10px }) {
    Text(content: "${content}", font: face, size: 8px, color: #f5f1e8);
  }`);
  const base = identity(text("A"), "a".repeat(64));
  assert.notEqual(base, identity(text("A"), "b".repeat(64)), "locked font-byte identity must invalidate the tile");
  assert.notEqual(base, identity(text("AA"), "a".repeat(64)), "Text content must invalidate the tile");
  assert.notEqual(base, identity(text("A", 21), "a".repeat(64)), "local width/height/origin context must invalidate the tile");

  const flow = (duration: string) => typographySource(`LocalSpace(width: 120px, height: 60px, origin: { x: 20px, y: 10px }) {
    FlowText(
      spans: [textSpan(id: "lead", content: "A A")],
      font: face,
      size: 10px,
      color: #ffcf66,
      motions: [textUnitMotion(span: "lead", by: "word", duration: ${duration}, from: textUnitPose(y: 8px, opacity: 0%))]
    );
  }`, { duration: "2s", fps: 4 });
  assert.notEqual(
    identity(flow("500ms"), "a".repeat(64)),
    identity(flow("750ms"), "a".repeat(64)),
    "FlowText exact motion schedule must invalidate the local tile",
  );
});

test("hostile IR cannot forge LocalSpace dimensions, origin, properties, or graph support", () => {
  const hostile = (mutate: (node: IRNode, ir: CutAVIR) => void) => {
    const ir = compile(source(`LocalSpace(width: 9px, height: 7px, origin: { x: 4px, y: 3px }) {
      Rect(width: 2px, height: 2px, fill: #ef233c);
    }`));
    mutate(localNode(ir), ir);
    finalizeGraphHashes(ir);
    return () => loadCutAvIr(JSON.stringify(ir));
  };
  const cases: Array<[string, (node: IRNode, ir: CutAVIR) => void]> = [
    ["fractional width", (node) => { node.inputs.width = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(3, 2) }; }],
    ["origin outside", (node) => {
      if (node.inputs.origin.kind === "object") node.inputs.origin.entries.x = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(10) };
    }],
    ["property", (node) => { node.properties.opacity = { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(1, 2) }; }],
  ];
  for (const [name, mutate] of cases) {
    assert.throws(hostile(mutate), (error: unknown) => {
      assert.ok(error instanceof CutAvIrValidationError, `${name}: ${String(error)}`);
      assert.match(error.path, /\.nodes(?:\[|\.)/u);
      return true;
    });
  }

  const ir = compile(source(`LocalSpace(width: 9px, height: 7px, origin: { x: 4px, y: 3px }) {
    Rect(width: 2px, height: 2px, fill: #ef233c);
  }`));
  const space = localNode(ir), child = ir.nodes[space.children[0]]!;
  child.op = "cut.visual.stack";
  finalizeGraphHashes(ir);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(ir)),
    (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD",
  );
});

test("LocalSpace keeps its 4096 structural bound while affine frame admission caps visible transforms at 256", async () => {
  const base = compile(source(`LocalSpace(width: 1px, height: 1px, origin: { x: 0px, y: 0px }) {
    Rect(width: 1px, height: 1px, fill: #ffffff);
  }`, 1, 1));
  const scene = Object.values(base.scenes)[0]!, templateLocal = localNode(base);
  const templateChild = base.nodes[templateLocal.children[0]!]!;
  const withCount = (count: number) => {
    const ir = structuredClone(base);
    const targetScene = ir.scenes[scene.id]!;
    ir.nodes = {};
    targetScene.rootVisualIds = [];
    targetScene.items = [];
    for (let index = 0; index < count; index += 1) {
      const childId = `evidence_rect_${index}`, localId = `evidence_local_${index}`;
      ir.nodes[childId] = { ...structuredClone(templateChild), id: childId };
      ir.nodes[localId] = { ...structuredClone(templateLocal), id: localId, children: [childId] };
      targetScene.rootVisualIds.push(localId);
      targetScene.items.push({ id: localId, domain: "visual" });
    }
    finalizeGraphHashes(ir);
    return ir;
  };

  const structurallyAdmitted = withCount(4_096);
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(structurallyAdmitted)));
  assert.equal(validateReferenceLocalSpaceGraph(structurallyAdmitted, structurallyAdmitted.compositions[0]).size, 4_096);
  const admitted = withCount(256);
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-count-bound-"));
  const renderer = new ReferenceVisualRenderer(admitted, admitted.compositions[0], root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    await renderer.sceneFrame(admitted.scenes[scene.id]!, 0, false);
    const receipt = renderer.referenceLocalSpaceEvidence()!;
    assert.equal(receipt.tiles.length, 256);
    assert.equal(receipt.placements.length, 256);
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }

  const overflowRoot = await mkdtemp(resolve(tmpdir(), "cut-local-space-affine-count-bound-"));
  const overflowRenderer = new ReferenceVisualRenderer(
    structurallyAdmitted,
    structurallyAdmitted.compositions[0],
    overflowRoot,
    resolve(overflowRoot, "cache"),
  );
  try {
    await overflowRenderer.prepare();
    await assert.rejects(
      () => overflowRenderer.sceneFrame(structurallyAdmitted.scenes[scene.id]!, 0, false),
      /composition transform count exceeds 256/u,
    );
    assert.equal(overflowRenderer.referenceLocalSpaceEvidence(), undefined);
    assert.equal(overflowRenderer.referenceLocalSpaceCompositionTransformPreflightEvidence(), undefined);
  } finally {
    await overflowRenderer.closeAndWait();
    await rm(overflowRoot, { recursive: true, force: true });
  }

  const refused = withCount(4_097);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(refused)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_LIMIT"
      && /LocalSpace count 4097 exceeds 4096/u.test(error.message),
  );
  assert.throws(
    () => validateReferenceLocalSpaceGraph(refused, refused.compositions[0]),
    (error: unknown) => error instanceof ReferenceLocalSpaceError
      && error.code === "CUT_LOCAL_SPACE_LIMIT"
      && /LocalSpace count 4097 exceeds 4096/u.test(error.message),
  );
});
