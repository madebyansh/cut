import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRComposition } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  ReferenceRetainedPathChainError,
  referenceRetainedPathChain,
  referenceRetainedPathChainExecutionAt,
  referenceRetainedPathChainsFromRoots,
} from "../lib/runtime/reference/retained-path-chain";
import { prepareReferenceVectorPathNode } from "../lib/runtime/reference/vector-path";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(body: string, width = 80, height = 64) {
  return `cut 0.4;
project "public retained chain proof";
import { Camera2D, Group, MotionBlur, MotionPath, Path, lineTo, vectorPath } from "cut:visual";
timeline main(duration: 1s, fps: 10, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function compileProgram(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  return ir;
}

const path = (startX = 20, endX = 30) => `Path(
  geometry: vectorPath(start: { x: ${startX}px, y: 20px }, segments: [lineTo(to: { x: ${endX}px, y: 20px })], closed: false),
  stroke: #ff3300,
  width: 4px
);`;

function nodeByOp(ir: CutAVIR, op: string) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(node, `expected ${op}`);
  return node;
}

async function renderBody(body: string, frame = 0, width = 80, height = 64) {
  const ir = compileProgram(program(body, width, height));
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-retained-chain-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[composition.sceneIds[0]]!;
    return { ir, composition, frame: await renderer.sceneFrame(scene, frame, false) };
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
}

function alphaBounds(frame: { data: Uint8Array; width: number; height: number }) {
  let left = frame.width, top = frame.height, right = -1, bottom = -1;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    if (frame.data[(y * frame.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  assert.ok(right >= left && bottom >= top, "expected visible retained pixels");
  return { left, top, right, bottom };
}

type RetainedInspection = {
  status: string;
  wrapperOps: string[];
  coordinateBasis: "canvas" | "motion-path-local";
  composedMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  combinedOpacity: number;
  frameVisibility?: "visible" | "transparent-trim";
  semanticFrameIdentity?: string;
  cacheDisposition?: "raster-cache" | "transparent-bypass";
  localBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  worldBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  visibleRasterBounds?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  rasterization: { vectorRasterizations: number; placementPasses: number; arcLengthSpace: string };
  cacheIdentity?: { schema: string; sha256: string; includes: string[] };
};

function retainedInspection(ir: CutAVIR) {
  const report = inspectCutIr(ir, "main.cut");
  const pathNode = report.graph.nodes.find((node) => node.op === "cut.visual.path");
  assert.ok(pathNode?.vectorPath?.retainedCompositor);
  const instance = pathNode.vectorPath.retainedCompositor.instances[0] as RetainedInspection | undefined;
  assert.ok(instance);
  return instance;
}

test("public CUT Path, Group, Camera2D, MotionPath, and Track2D source reaches only the exact unary retained classifier", () => {
  for (const [op, body] of [
    ["cut.visual.group", `Group(x: 4px) { ${path()} }`],
    ["cut.visual.camera2d", `Camera2D(x: 4px) { ${path()} }`],
    ["cut.visual.motion_path", `MotionPath(points: [{ x: 20px, y: 32px }, { x: 60px, y: 32px }], progress: 50%) { ${path()} }`],
  ] as const) {
    const ir = compileProgram(program(body));
    const wrapper = nodeByOp(ir, op), leaf = nodeByOp(ir, "cut.visual.path");
    assert.deepEqual(wrapper.effects, ["pure"]);
    assert.deepEqual(leaf.effects, ["pure"]);
    assert.deepEqual(referenceRetainedPathChain(ir, wrapper.id)?.nodeIds, [wrapper.id, leaf.id]);
  }

  const unknownInputIr = compileProgram(program(`Group(x: 4px) { ${path()} }`));
  const unknownInputGroup = nodeByOp(unknownInputIr, "cut.visual.group");
  unknownInputGroup.inputs.unknown = { kind: "boolean", value: true };
  assert.equal(referenceRetainedPathChain(unknownInputIr, unknownInputGroup.id), undefined, "an unknown wrapper input cannot enter the retained executor");

  const trackSource = `cut 0.4;
project "public retained Track2D classification";
import { Path, Track2D, lineTo, vectorPath } from "cut:visual";
asset tracking: DataAsset = data("assets/original.track.json");
timeline main(duration: 1s, fps: 10, width: 80px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Track2D(source: tracking, minConfidence: 70%, lowConfidence: "hold", occluded: "hold", outOfFrame: "hide", interpolation: "linear", bindScale: false, bindRotation: false) {
      ${path()}
    }
  }
}
export out = render(main, width: 80px, height: 64px, codec: "h264");`;
  const trackIr = compileProgram(trackSource), track = nodeByOp(trackIr, "cut.visual.track_2d");
  assert.deepEqual(track.effects, ["pure"]);
  assert.equal(referenceRetainedPathChain(trackIr, track.id)?.requiresTrack2D, true);

  const boundaryIr = compileProgram(program(`Group() { ${path(8, 18)} ${path(48, 58)} }`));
  const group = nodeByOp(boundaryIr, "cut.visual.group");
  assert.equal(referenceRetainedPathChain(boundaryIr, group.id), undefined, "a multi-child group remains a materialization boundary");
  assert.equal(referenceRetainedPathChainsFromRoots(boundaryIr, [group.id]).length, 2, "each exact child may retain below the boundary");
  nodeByOp(boundaryIr, "cut.visual.path").effects = ["external"];
  assert.equal(referenceRetainedPathChainsFromRoots(boundaryIr, [group.id]).length, 1, "non-pure capability annotations fail closed");
});

test("one final vector raster preserves translated and cancelling nested transforms byte-for-byte", async () => {
  const baseline = await renderBody(path());
  const translated = await renderBody(`Group(x: 40px) { ${path(-20, -10)} }`);
  const cancelled = await renderBody(`Group(scale: 0.5) { Group(scale: 2) { Group(x: 40px) { Group(x: -40px) { ${path()} } } } }`);
  assert.deepEqual(translated.frame.data, baseline.frame.data);
  assert.deepEqual(cancelled.frame.data, baseline.frame.data);

  const inspection = retainedInspection(cancelled.ir);
  assert.equal(inspection.status, "flattenable");
  assert.deepEqual(inspection.wrapperOps, ["cut.visual.group", "cut.visual.group", "cut.visual.group", "cut.visual.group"]);
  assert.deepEqual(inspection.composedMatrix, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
  assert.deepEqual(inspection.rasterization, {
    vectorRasterizations: 1,
    placementPasses: 1,
    deliveryClipped: false,
    arcLengthSpace: "path-local-before-affine",
  });
  assert.equal(inspection.cacheIdentity?.schema, "cut.reference.retained-visual.v1");
  assert.ok(inspection.cacheIdentity?.includes.includes("composed-matrix"));
  assert.ok(inspection.cacheIdentity?.includes.includes("backend"));
});

test("public dynamic trim renders an exact transparent retained frame with zero work before visible pixels", async () => {
  const body = `${path().replace(
    "width: 4px",
    "width: 4px,\n  trimEnd: 0%",
  ).replace(/\n\);$/u, "\n) as route;")} animate route.trimEnd from 0% to 100% over 1s;`;
  const ir = compileProgram(program(body)), composition = ir.compositions[0]!;
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const leaf = nodeByOp(ir, "cut.visual.path"), chain = referenceRetainedPathChain(ir, leaf.id), plan = prepareReferenceVectorPathNode(ir, leaf);
  assert.ok(chain && plan);
  const first = referenceRetainedPathChainExecutionAt(ir, composition, chain, plan, rational(0), { outputFrame: 0n });
  const replay = referenceRetainedPathChainExecutionAt(ir, composition, chain, plan, rational(0), { outputFrame: 0n });
  const later = referenceRetainedPathChainExecutionAt(ir, composition, chain, plan, rational(1, 2), { outputFrame: 5n });
  assert.equal(first.frameVisibility, "transparent-trim");
  assert.deepEqual(first.work, { rasterPixels: 0, rgbaBytes: 0, pixelWork: 0 });
  assert.equal(first.vectorRasterizations, 0);
  assert.equal(first.placementPasses, 0);
  assert.equal(first.localBounds, undefined);
  assert.equal(first.visibleRasterBounds, undefined);
  assert.equal(first.cacheIdentity, undefined, "transparent exact frames bypass the raster cache");
  assert.match(first.semanticFrameIdentity ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(replay.semanticFrameIdentity, first.semanticFrameIdentity);
  assert.equal(later.frameVisibility, "visible");
  assert.notEqual(later.semanticFrameIdentity, first.semanticFrameIdentity);
  assert.equal(later.vectorRasterizations, 1);
  assert.equal(later.placementPasses, 1);

  const inspection = retainedInspection(ir);
  assert.equal(inspection.frameVisibility, "transparent-trim");
  assert.equal(inspection.cacheDisposition, "transparent-bypass");
  assert.equal(inspection.rasterization.vectorRasterizations, 0);
  assert.equal(inspection.rasterization.placementPasses, 0);
  assert.equal(inspection.cacheIdentity, undefined);
  assert.equal(inspection.semanticFrameIdentity, first.semanticFrameIdentity);

  const zero = await renderBody(body, 0), visible = await renderBody(body, 5);
  assert.equal(zero.frame.data.some((value, index) => index % 4 === 3 && value !== 0), false);
  assert.equal(visible.frame.data.some((value, index) => index % 4 === 3 && value !== 0), true);

  const hostileCanvas = { ...composition, width: 8_192, height: 8_192 };
  const bypassed = referenceRetainedPathChainExecutionAt(ir, hostileCanvas, chain, plan, rational(0), { outputFrame: 0n });
  assert.deepEqual(bypassed.work, { rasterPixels: 0, rgbaBytes: 0, pixelWork: 0 });
  assert.throws(
    () => referenceRetainedPathChainExecutionAt(ir, hostileCanvas, chain, plan, rational(1, 2), { outputFrame: 5n }),
    /CUT_RETAINED_VISUAL_RESOURCE_LIMIT/u,
  );
});

test("a near-origin Path under Group x remains an additive canvas translation on a wide composition", async () => {
  const translated = await renderBody(`Group(x: 72px) { ${path(0, 10)} }`, 0, 640, 360);
  const pixels = alphaBounds(translated.frame), inspection = retainedInspection(translated.ir);
  assert.deepEqual(inspection.composedMatrix, { a: 1, b: 0, c: 0, d: 1, tx: 72, ty: 0 });
  assert.ok(pixels.left >= 69 && pixels.left <= 71, `expected stroked local x=0 edge near canvas x=70, got ${pixels.left}`);
  assert.ok(pixels.right >= 82 && pixels.right <= 84, `expected stroked local x=10 edge near canvas x=83, got ${pixels.right}`);
});

test("a direct local VectorPath subject follows MotionPath without canvas-half compensation across aspects", async () => {
  const localArrow = `Path(
    geometry: vectorPath(
      start: { x: 6px, y: 0px },
      segments: [lineTo(to: { x: -6px, y: -4px }), lineTo(to: { x: -6px, y: 4px })],
      closed: true
    ),
    fill: #ff3300
  );`;
  const body = `MotionPath(
    points: [{ x: 20px, y: 20px }, { x: 60px, y: 44px }],
    progress: 50%,
    orientToPath: true
  ) { ${localArrow} }`;
  const landscape = await renderBody(body, 0, 80, 64);
  const wide = await renderBody(body, 0, 160, 90);
  const landscapePixels = alphaBounds(landscape.frame), widePixels = alphaBounds(wide.frame);
  assert.deepEqual(widePixels, landscapePixels, "canvas dimensions must not alter an absolute MotionPath destination or its local subject bounds");
  assert.ok(landscapePixels.left <= 40 && landscapePixels.right >= 40);
  assert.ok(landscapePixels.top <= 32 && landscapePixels.bottom >= 32);
  assert.ok(landscapePixels.right - landscapePixels.left >= 10 && landscapePixels.right - landscapePixels.left <= 20);
  assert.ok(landscapePixels.bottom - landscapePixels.top >= 8 && landscapePixels.bottom - landscapePixels.top <= 20);
  const root = nodeByOp(landscape.ir, "cut.visual.motion_path"), chain = referenceRetainedPathChain(landscape.ir, root.id);
  assert.equal(chain?.coordinateBasis, "motion-path-local");
  assert.deepEqual(chain?.wrapperOps, ["cut.visual.motion_path"]);
  const inspection = retainedInspection(landscape.ir);
  assert.equal(inspection.coordinateBasis, "motion-path-local");
  assert.ok(Math.abs(inspection.composedMatrix.tx - 40) < 1e-12);
  assert.ok(Math.abs(inspection.composedMatrix.ty - 32) < 1e-12);
});

test("nested MotionPath wrappers preserve an ordinary materialization boundary instead of accumulating local bases", async () => {
  const body = `MotionPath(
    points: [{ x: 10px, y: 10px }, { x: 70px, y: 30px }],
    progress: 50%
  ) {
    MotionPath(
      points: [{ x: 20px, y: 54px }, { x: 60px, y: 10px }],
      progress: 50%
    ) {
      Path(
        geometry: vectorPath(start: { x: -5px, y: 0px }, segments: [lineTo(to: { x: 5px, y: 0px })], closed: false),
        stroke: #ff3300,
        width: 4px
      );
    }
  }`;
  const rendered = await renderBody(body);
  assert.ok(alphaBounds(rendered.frame).right >= 0, "nested public paths remain executable through materialization");
  const motions = Object.values(rendered.ir.nodes).filter((node) => node.op === "cut.visual.motion_path");
  assert.equal(motions.length, 2);
  const outer = motions.find((node) => rendered.ir.nodes[node.children[0]!]?.op === "cut.visual.motion_path"), inner = motions.find((node) => node !== outer);
  assert.ok(outer && inner);
  assert.equal(referenceRetainedPathChain(rendered.ir, outer.id), undefined, "two MotionPath wrappers must never enter one retained affine chain");
  const innerChain = referenceRetainedPathChain(rendered.ir, inner.id);
  assert.equal(innerChain?.coordinateBasis, "motion-path-local");
  assert.deepEqual(referenceRetainedPathChainsFromRoots(rendered.ir, [outer.id]).map((chain) => chain.rootId), [inner.id]);
  const leaf = nodeByOp(rendered.ir, "cut.visual.path"), plan = prepareReferenceVectorPathNode(rendered.ir, leaf);
  assert.ok(innerChain && plan);
  const forged = {
    ...innerChain,
    rootId: outer.id,
    nodeIds: [outer.id, ...innerChain.nodeIds],
    wrapperOps: ["cut.visual.motion_path", ...innerChain.wrapperOps],
  };
  assert.throws(
    () => referenceRetainedPathChainExecutionAt(rendered.ir, rendered.composition, forged, plan, rational(0)),
    (error: unknown) => error instanceof ReferenceRetainedPathChainError
      && error.code === "CUT_RETAINED_PATH_CHAIN"
      && /cannot contain multiple MotionPath wrappers.*exactly one local origin/u.test(error.message),
  );
});

test("anchor, skew, rotation, nested opacity, and conservative final-space bounds execute in the retained chain", async () => {
  const body = `Group(x: 7px, y: -3px, anchorX: 5px, anchorY: -4px, scale: 1.35, skewX: 12deg, skewY: -7deg, rotation: 31deg, opacity: 50%) {
    Path(
      geometry: vectorPath(start: { x: 25px, y: 19px }, segments: [lineTo(to: { x: 46px, y: 19px }), lineTo(to: { x: 46px, y: 39px }), lineTo(to: { x: 25px, y: 39px })], closed: true),
      fill: #20d6a5,
      opacity: 50%
    );
  }`;
  const rendered = await renderBody(body), pixels = alphaBounds(rendered.frame), inspection = retainedInspection(rendered.ir);
  assert.equal(inspection.combinedOpacity, 0.25);
  assert.notDeepEqual(inspection.composedMatrix, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
  assert.ok(inspection.worldBounds && inspection.worldBounds.minX < inspection.worldBounds.maxX && inspection.worldBounds.minY < inspection.worldBounds.maxY);
  assert.ok(inspection.visibleRasterBounds);
  assert.ok(pixels.left >= inspection.visibleRasterBounds.left);
  assert.ok(pixels.top >= inspection.visibleRasterBounds.top);
  assert.ok(pixels.right < inspection.visibleRasterBounds.right);
  assert.ok(pixels.bottom < inspection.visibleRasterBounds.bottom);
});

test("exact-time matrix changes participate in cache identity and bounded failures keep Path source locations", () => {
  const ir = compileProgram(program(`Group(x: 0px) as mover { ${path()} } animate mover.x from 0px to 12px over 1s;`));
  const composition = ir.compositions[0]!, root = nodeByOp(ir, "cut.visual.group"), leaf = nodeByOp(ir, "cut.visual.path");
  const chain = referenceRetainedPathChain(ir, root.id), plan = prepareReferenceVectorPathNode(ir, leaf);
  assert.ok(chain && plan);
  const first = referenceRetainedPathChainExecutionAt(ir, composition, chain, plan, rational(0));
  const middle = referenceRetainedPathChainExecutionAt(ir, composition, chain, plan, rational(1, 2));
  assert.equal(first.state.affine.tx, 0);
  assert.equal(middle.state.affine.tx, 6);
  assert.notEqual(first.cacheIdentity?.sha256, middle.cacheIdentity?.sha256);

  const hostileComposition: IRComposition = { ...composition, width: 8_192, height: 8_192 };
  assert.throws(
    () => referenceRetainedPathChainExecutionAt(ir, hostileComposition, chain, plan, rational(0)),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceRetainedPathChainError);
      assert.equal(error.code, "CUT_RETAINED_VISUAL_RESOURCE_LIMIT");
      assert.equal(error.source.module, leaf.provenance.module);
      assert.equal(error.source.nodeId, leaf.id);
      return true;
    },
  );
});

test("MotionBlur remains a materialization boundary but samples an exact retained child chain at every shutter time", async () => {
  const moving = `${path().replace(/\n\);$/u, "\n) as route;")} animate route.x from 0px to 30px over 1s;`;
  const sharpFrame = await renderBody(moving, 5);
  const blurred = await renderBody(`MotionBlur(shutterAngle: 360deg, samples: 8) { ${moving} }`, 5);
  assert.notDeepEqual(blurred.frame.data, sharpFrame.frame.data);
  const blurNode = nodeByOp(blurred.ir, "cut.visual.motion_blur"), leaf = nodeByOp(blurred.ir, "cut.visual.path");
  assert.equal(referenceRetainedPathChain(blurred.ir, blurNode.id), undefined);
  assert.ok(referenceRetainedPathChain(blurred.ir, leaf.id));
});

test("MotionBlur safely mixes transparent-trim and later-visible retained Path shutter samples", async () => {
  const revealing = `${path().replace(
    "width: 4px",
    "width: 4px,\n  trimEnd: 0%",
  ).replace(/\n\);$/u, "\n) as route;")} animate route.trimEnd from 0% to 100% over 1s;`;
  const sharp = await renderBody(revealing, 0);
  const blurred = await renderBody(`MotionBlur(shutterAngle: 360deg, samples: 4) { ${revealing} }`, 0);
  assert.equal(sharp.frame.data.some((value, index) => index % 4 === 3 && value !== 0), false, "the exact output-time Path is a transparent trim frame");
  const alpha = blurred.frame.data.filter((_, index) => index % 4 === 3);
  assert.ok(alpha.some((value) => value > 0), "positive shutter samples after t=0 must reveal retained pixels");
  assert.ok(alpha.some((value) => value > 0 && value < 255), "transparent pre-roll/zero samples must mix without a bounds or raster crash");
});
