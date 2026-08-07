import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  ReferenceLocalCompositingError,
  referenceLocalCompositingAdmittedOps,
} from "../lib/runtime/reference/local-compositing";
import {
  referenceLocalSpaceTileIdentity,
  validateReferenceLocalSpaceGraph,
} from "../lib/runtime/reference/local-space";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(body: string, frequency = 440) {
  return `cut 0.4;
project "retained local compositing v1";
import { Blur, ChromaKey, ClipPath, ColorGrade, Composite, curvePoint, Duotone, Glow, Grain, LocalSpace, Mask, MotionBlur, Rect, Shadow, Sharpen, Stack, TonalCurve, Vignette } from "cut:visual";
import { Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 2, width: 80px, height: 60px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    ${body}
    Tone(frequency: ${frequency}hz, duration: 1s, amplitude: 10%);
  }
}
export out = render(main, width: 80px, height: 60px, codec: "h264");`;
}

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function localNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.local_space");
  assert.ok(node);
  return node;
}

function localConfig(ir: CutAVIR) {
  const node = localNode(ir), config = validateReferenceLocalSpaceGraph(ir, ir.compositions[0]!).get(node.id);
  assert.ok(config);
  return config;
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function visibleBounds(surface: { data: Uint8Array; width: number; height: number }) {
  let left = surface.width, top = surface.height, right = -1, bottom = -1;
  for (let y = 0; y < surface.height; y += 1) for (let x = 0; x < surface.width; x += 1) {
    if (surface.data[(y * surface.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? undefined : { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

const allOperationsBody = `LocalSpace(width: 20px, height: 14px, origin: { x: 10px, y: 7px }) {
  Composite(blend: "screen") {
    ClipPath(points: [{ x: 1px, y: 1px }, { x: 19px, y: 1px }, { x: 19px, y: 13px }, { x: 1px, y: 13px }]) {
      Mask(mode: "alpha", feather: 1px, expand: 1px) {
        ColorGrade(exposure: 0.5, temperature: 0.2, saturation: 1.2) {
          Blur(radius: 0.8px) { Rect(width: 12px, height: 8px, fill: #d94b64); }
        }
        Rect(width: 14px, height: 10px, fill: #ffffffcc);
      }
    }
    Vignette(amount: 25%, radius: 50%, softness: 50%, color: #101820) {
      Sharpen(radius: 1px, amount: 50%) {
        Grain(amount: 15%, size: 1px, seed: 7, mode: "temporal", monochrome: false) {
          Rect(width: 8px, height: 6px, x: 3px, fill: #4b77d9);
        }
      }
    }
    Duotone(shadows: #201040, highlights: #f2c879, amount: 60%) {
      Rect(width: 5px, height: 5px, x: -5px, y: 3px, fill: #70a090);
    }
  }
}`;

async function renderFrames(ir: CutAVIR, frames: readonly number[], forbidDeliveryDescendants = false) {
  const { composition } = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-local-compositing-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/cache"));
  const local = localNode(ir), descendants = new Set<string>();
  const visit = (id: string) => {
    const node = ir.nodes[id];
    if (!node || descendants.has(id)) return;
    descendants.add(id); node.children.forEach(visit);
  };
  local.children.forEach(visit);
  if (forbidDeliveryDescendants) {
    const instrumented = renderer as unknown as { nodeFrame: (id: string, ...rest: unknown[]) => Promise<unknown> };
    const original = instrumented.nodeFrame.bind(renderer);
    instrumented.nodeFrame = (id: string, ...rest: unknown[]) => {
      if (descendants.has(id)) throw new Error(`delivery-sized nodeFrame fallback reached ${id}`);
      return original(id, ...rest);
    };
  }
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const rendered = [], evidence = [];
    for (const frame of frames) {
      rendered.push(await renderer.sceneFrame(scene, frame, false));
      evidence.push(renderer.referenceLocalSpaceEvidence());
    }
    const clipPlans = (renderer as unknown as { clipPathPlans: Map<string, { width: number; height: number }> }).clipPathPlans;
    return { rendered, evidence, clipPlans: [...clipPlans.values()] };
  } finally {
    await renderer.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("LocalSpace V1 plans and executes every admitted graphical compositor on the exact tile", { timeout: 30_000 }, async () => {
  const ir = compile(program(allOperationsBody)), config = localConfig(ir);
  assert.deepEqual(config.localCompositing.operations.map((operation) => operation.op), [
    "cut.visual.composite",
    "cut.visual.clip_path",
    "cut.visual.mask",
    "cut.visual.color_grade",
    "cut.visual.blur",
    "cut.visual.vignette",
    "cut.visual.sharpen",
    "cut.visual.grain",
    "cut.visual.duotone",
  ]);
  assert.deepEqual([...new Set(config.localCompositing.operations.map((operation) => operation.op))].sort(), [...referenceLocalCompositingAdmittedOps].sort());
  assert.deepEqual(config.localCompositing.dimensions, { width: 20, height: 14 });
  assert.equal(config.localCompositing.alphaBoundary, "straight-rgba8");
  assert.ok(config.localCompositing.estimatedPixelWorkPerFrame > 20 * 14);

  const result = await renderFrames(ir, [0, 1, 0], true);
  assert.ok(result.clipPlans.some((plan) => plan.width === 20 && plan.height === 14));
  assert.ok(result.clipPlans.every((plan) => plan.width !== 80 || plan.height !== 60), "local ClipPath must not prepare a delivery-sized coverage plane");
  assert.equal(sha256(result.rendered[0]!.data), sha256(result.rendered[2]!.data), "same absolute frame repeats byte-for-byte");
  assert.notEqual(sha256(result.rendered[0]!.data), sha256(result.rendered[1]!.data), "temporal Grain uses the absolute output frame");
  const bounds = visibleBounds(result.rendered[0]!);
  assert.ok(bounds && bounds.width <= 20 && bounds.height <= 14, `small retained tile escaped its 20x14 bounds: ${JSON.stringify(bounds)}`);
  const firstTile = result.evidence[0]?.tiles[0];
  assert.equal(firstTile?.localCompositing?.planIdentity, config.localCompositing.semanticIdentity);
  assert.equal(firstTile?.localCompositing?.operations.length, 9);
  assert.equal(firstTile?.localCompositing?.finalRgbaSha256.length, 64);
  const inspected = inspectCutIr(ir, "main.cut").graph.nodes.find((node) => node.id === localNode(ir).id)?.localSpace;
  assert.equal(inspected?.localCompositing.semanticIdentity, config.localCompositing.semanticIdentity);
  assert.deepEqual(inspected?.localCompositing.dimensions, { width: 20, height: 14 });
});

test("local Composite preserves authored order and Mask clears hidden RGB at zero alpha", async () => {
  const ordered = compile(program(`LocalSpace(width: 8px, height: 8px, origin: { x: 4px, y: 4px }) {
    Composite() { Rect(width: 8px, height: 8px, fill: #ff0000); Rect(width: 8px, height: 8px, fill: #0000ff); }
  }`));
  const reversed = compile(program(`LocalSpace(width: 8px, height: 8px, origin: { x: 4px, y: 4px }) {
    Composite() { Rect(width: 8px, height: 8px, fill: #0000ff); Rect(width: 8px, height: 8px, fill: #ff0000); }
  }`));
  const first = (await renderFrames(ordered, [0])).rendered[0]!, second = (await renderFrames(reversed, [0])).rendered[0]!;
  assert.deepEqual(pixel(first, 40, 30), [0, 0, 255, 255]);
  assert.deepEqual(pixel(second, 40, 30), [255, 0, 0, 255]);

  const hidden = compile(program(`LocalSpace(width: 8px, height: 8px, origin: { x: 4px, y: 4px }) {
    ColorGrade(contrast: 0.5) {
      Mask(mode: "alpha") { Rect(width: 8px, height: 8px, fill: #ff00ff); Rect(width: 4px, height: 4px, fill: #00ff00); }
    }
  }`));
  const cleared = (await renderFrames(hidden, [0])).rendered[0]!;
  for (let offset = 0; offset < cleared.data.length; offset += 4) {
    if (cleared.data[offset + 3] === 0) assert.deepEqual([...cleared.data.subarray(offset, offset + 3)], [0, 0, 0]);
  }
});

test("leaf-only graphical edits invalidate operation, tile, diff and picture cache identities without invalidating audio", () => {
  const visual = (fill: string) => `LocalSpace(width: 12px, height: 10px, origin: { x: 6px, y: 5px }) {
    Composite(blend: "screen") { Rect(width: 8px, height: 6px, fill: ${fill}); Rect(width: 4px, height: 4px, fill: #204060); }
  }`;
  const before = compile(program(visual("#b04050"))), after = compile(program(visual("#50b040")));
  const beforeConfig = localConfig(before), afterConfig = localConfig(after);
  assert.notEqual(beforeConfig.localCompositing.operations[0]!.subtreeSemanticIdentity, afterConfig.localCompositing.operations[0]!.subtreeSemanticIdentity);
  assert.notEqual(beforeConfig.localCompositing.operations[0]!.semanticIdentity, afterConfig.localCompositing.operations[0]!.semanticIdentity);
  assert.notEqual(beforeConfig.localCompositing.semanticIdentity, afterConfig.localCompositing.semanticIdentity);
  assert.notEqual(referenceLocalSpaceTileIdentity(beforeConfig, rational(0), "test-backend"), referenceLocalSpaceTileIdentity(afterConfig, rational(0), "test-backend"));
  const diff = diffCutAVIR(before, after);
  assert.ok(diff.changes.some((change) => change.entity === "node" && change.operation === "modify"));

  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const incremental = createIncrementalRenderPlan(after, "main", previous);
  const local = localNode(after), tone = Object.values(after.nodes).find((node) => node.op === "cut.audio.tone");
  assert.ok(tone);
  assert.equal(incremental.nodes.find((node) => node.id === local.id)?.status, "miss");
  assert.equal(incremental.nodes.find((node) => node.id === tone.id)?.status, "hit");

  const audioOnly = compile(program(visual("#b04050"), 880)), audioOnlyConfig = localConfig(audioOnly);
  assert.equal(beforeConfig.localCompositing.semanticIdentity, audioOnlyConfig.localCompositing.semanticIdentity);
  assert.equal(referenceLocalSpaceTileIdentity(beforeConfig, rational(0), "test-backend"), referenceLocalSpaceTileIdentity(audioOnlyConfig, rational(0), "test-backend"));
});

test("LocalSpace refuses halo effects and excluded wrappers before raster or decode, including media-bearing halos", () => {
  for (const effect of ["Shadow(x: 1px, radius: 1px)", "Glow(radius: 1px)"]) {
    const ir = compile(program(`LocalSpace(width: 8px, height: 8px, origin: { x: 4px, y: 4px }) { ${effect} { Rect(width: 4px, height: 4px); } }`));
    assert.throws(() => validateReferenceLocalSpaceGraph(ir, ir.compositions[0]!), (error: unknown) => {
      assert.ok(error instanceof ReferenceLocalCompositingError);
      assert.equal(error.code, "CUT_LOCAL_COMPOSITING_UNSUPPORTED");
      assert.match(error.message, /halo.*bounds policy|halo.*clipping policy/u);
      assert.ok(error.source.line > 0 && error.source.column > 0);
      return true;
    });
    assert.throws(() => loadCutAvIr(JSON.stringify(ir)), (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_UNKNOWN_FIELD"
      && /halo.*no public halo-bounds policy/u.test(error.message));
  }

  for (const excluded of [
    "MotionBlur(shutterAngle: 180deg, samples: 3) { Rect(width: 4px, height: 4px); }",
    "ChromaKey(key: #00ff00, tolerance: 10%, softness: 5%, spill: 0%) { Rect(width: 4px, height: 4px); }",
    "TonalCurve(points: [curvePoint(input: 0%, output: 0%), curvePoint(input: 50%, output: 25%), curvePoint(input: 100%, output: 100%)], space: \"srgb\") { Rect(width: 4px, height: 4px); }",
    "Stack(direction: \"horizontal\", gap: 1px) { Rect(width: 2px, height: 2px); Rect(width: 2px, height: 2px); }",
  ]) {
    const ir = compile(program(`LocalSpace(width: 8px, height: 8px, origin: { x: 4px, y: 4px }) { ${excluded} }`));
    assert.throws(() => validateReferenceLocalSpaceGraph(ir, ir.compositions[0]!), /delivery-canvas fallback is forbidden/u);
  }

  const media = `cut 0.4;
project "media halo refusal";
import { Image, LocalSpace, Shadow } from "cut:visual";
asset still: ImageAsset = image("assets/not-opened.png");
timeline main(duration: 1s, fps: 2, width: 80px, height: 60px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    LocalSpace(width: 20px, height: 14px, origin: { x: 10px, y: 7px }) { Shadow(x: 1px, radius: 1px) { Image(source: still); } }
  }
}
export out = render(main);`;
  const mediaIr = compile(media);
  assert.throws(
    () => validateReferenceLocalSpaceGraph(mediaIr, mediaIr.compositions[0]!),
    /halo expansion\/clipping policy is public/u,
  );
});

test("strict loader and runtime planner bound hostile local compositing operation counts", () => {
  const excessiveWork = compile(program(`LocalSpace(width: 2048px, height: 2048px, origin: { x: 1024px, y: 1024px }) {
    Blur(radius: 64px) { Rect(width: 1px, height: 1px, fill: #808080); }
  }`));
  assert.throws(() => validateReferenceLocalSpaceGraph(excessiveWork, excessiveWork.compositions[0]!), (error: unknown) => error instanceof ReferenceLocalCompositingError
    && error.code === "CUT_LOCAL_COMPOSITING_LIMIT"
    && /operator work .* exceeds 536870912/u.test(error.message));

  const ir = compile(program(`LocalSpace(width: 1px, height: 1px, origin: { x: 0px, y: 0px }) {
    Blur(radius: 1px) { Rect(width: 1px, height: 1px, fill: #808080); }
  }`));
  const local = localNode(ir), original = Object.values(ir.nodes).find((node) => node.op === "cut.visual.blur");
  assert.ok(original);
  let childId = original.id;
  for (let index = 1; index < 513; index += 1) {
    const id = `hostile-local-blur-${index}`;
    const clone: IRNode = { ...original, id, children: [childId], contentHash: original.contentHash };
    ir.nodes[id] = clone;
    childId = id;
  }
  local.children = [childId];
  assert.throws(() => loadCutAvIr(JSON.stringify(ir)), (error: unknown) => error instanceof CutAvIrValidationError
    && error.code === "CUT_IR_LIMIT"
    && /operation count 513 exceeds 512/u.test(error.message));
  assert.throws(() => validateReferenceLocalSpaceGraph(ir, ir.compositions[0]!), (error: unknown) => error instanceof ReferenceLocalCompositingError
    && error.code === "CUT_LOCAL_COMPOSITING_LIMIT"
    && /operation count 513 exceeds 512/u.test(error.message));
});
