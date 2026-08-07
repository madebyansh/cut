import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  referenceMediaCamera2DAnchorPlanAt,
  referenceMediaCamera2DFramePlanAt,
  validateReferenceMediaCamera2DGraph,
} from "../lib/runtime/reference/media-camera2d";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

type ProgramOptions = Readonly<{
  opacityAnimation?: boolean;
  title?: string;
}>;

function program(branch: string, options: ProgramOptions = {}) {
  return `cut 0.4;
project "${options.title ?? "MediaCamera2D native effects"}";
import { Blur, ColorGrade, Duotone, Grain, Image, MediaCamera2D, Shadow, Sharpen, Vignette } from "cut:visual";
import { linear } from "@cut/motion";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 8px, height: 6px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%${options.opacityAnimation ? ", opacity: 0%" : ""}) as camera {
      ${branch}
    }
    ${options.opacityAnimation ? "animate camera.opacity from 0% to 100% over 1s ease linear;" : ""}
  }
}
export out = render(main, width: 8px, height: 6px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return parsed.module;
}

function compile(source: string) {
  const parsedModule = parse(source);
  const checked = checkCutModule(parsedModule);
  assert.deepEqual(
    checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(checked.diagnostics),
  );
  return compileCutModule(parsedModule).ir;
}

function expectDiagnostic(source: string, code: string, message: RegExp) {
  const parsedModule = parse(source);
  const checked = checkCutModule(parsedModule);
  const checkerDiagnostic = checked.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error" && diagnostic.code === code,
  );
  if (checkerDiagnostic) {
    assert.match(checkerDiagnostic.message, message);
    assert.ok(checkerDiagnostic.span.start.line > 0 && checkerDiagnostic.span.start.column > 0);
    return;
  }
  assert.throws(() => compileCutModule(parsedModule), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, String(error));
    const diagnostic = error.result.diagnostics.find(
      (candidate) => candidate.severity === "error" && candidate.code === code,
    );
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.match(diagnostic.message, message);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    return true;
  });
}

function imageBytes() {
  const data = Buffer.alloc(8 * 6 * 4);
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 8; x += 1) {
    const offset = (y * 8 + x) * 4;
    data[offset] = (x * 37 + y * 19) % 256;
    data[offset + 1] = (x * 11 + y * 53) % 256;
    data[offset + 2] = (255 - x * 23 + y * 7) % 256;
    data[offset + 3] = x === 0 && y % 2 === 0 ? 128 : 255;
  }
  return data;
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-media-camera-effects-"));
  await mkdir(resolve(root, "assets"));
  await sharp(imageBytes(), { raw: { width: 8, height: 6, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/source.png"));
  return root;
}

async function locked(root: string, source: string) {
  const ir = compile(source);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

async function render(ir: CutAVIR, root: string, frame = 0, cache = "native-effects") {
  const { composition } = validateReferenceSession(ir, "out");
  const scene = ir.scenes[composition.sceneIds[0]!]!;
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", cache));
  try {
    await renderer.prepare();
    const surface = await renderer.sceneFrame(scene, frame, false);
    const evidence = renderer.referenceMediaCamera2DEvidence();
    assert.equal(evidence.length, 1);
    return { surface, evidence: evidence[0]! };
  } finally {
    await renderer.closeAndWait();
  }
}

const chainA = `Vignette(amount: 35%, radius: 45%, softness: 60%, color: #101820) {
  Grain(amount: 12%, size: 1px, seed: 73, mode: "static", monochrome: false) {
    Duotone(shadows: #101830, highlights: #f2d398, amount: 65%) {
      Image(source: media, fit: "fill");
    }
  }
}`;

const chainB = `Duotone(shadows: #101830, highlights: #f2d398, amount: 65%) {
  Grain(amount: 12%, size: 1px, seed: 73, mode: "static", monochrome: false) {
    Vignette(amount: 35%, radius: 45%, softness: 60%, color: #101820) {
      Image(source: media, fit: "fill");
    }
  }
}`;

const outerGradeChain = `ColorGrade(exposure: 0.3, saturation: 0.75) {
  Grain(amount: 14%, size: 1px, seed: 91, mode: "static", monochrome: false) {
    Image(source: media, fit: "fill");
  }
}`;

const innerGradeChain = `Grain(amount: 14%, size: 1px, seed: 91, mode: "static", monochrome: false) {
  ColorGrade(exposure: 0.3, saturation: 0.75) {
    Image(source: media, fit: "fill");
  }
}`;

test("MediaCamera2D plans a closed inner-to-outer native-crop chain without changing source-anchor geometry", async () => {
  const root = await fixture();
  try {
    const effected = await locked(root, program(chainA));
    const direct = await locked(root, program('Image(source: media, fit: "fill");'));
    const effectedComposition = effected.compositions[0]!, directComposition = direct.compositions[0]!;
    const effectedPlan = [...validateReferenceMediaCamera2DGraph(effected, effectedComposition).values()][0]!;
    const directPlan = [...validateReferenceMediaCamera2DGraph(direct, directComposition).values()][0]!;
    const effectedFrame = referenceMediaCamera2DFramePlanAt(
      effected,
      effectedComposition,
      effectedPlan,
      rational(0),
    );
    const directFrame = referenceMediaCamera2DFramePlanAt(direct, directComposition, directPlan, rational(0));

    assert.ok(effectedPlan.nativeEffectChain);
    assert.equal(directPlan.nativeEffectChain, undefined);
    assert.deepEqual(
      effectedPlan.nativeEffectChain.operations.map((operation) => operation.op),
      ["cut.visual.duotone", "cut.visual.grain", "cut.visual.vignette"],
    );
    assert.deepEqual(
      effectedPlan.nativeEffectChain.operations.map((operation) => operation.inspectionOrder),
      [2, 1, 0],
    );
    assert.deepEqual(
      effectedFrame.geometry.sourceToDeliveryQ16,
      directFrame.geometry.sourceToDeliveryQ16,
    );
    const effectedAnchor = referenceMediaCamera2DAnchorPlanAt(
      effected,
      effectedComposition,
      effectedPlan,
      rational(0),
    );
    const directAnchor = referenceMediaCamera2DAnchorPlanAt(
      direct,
      directComposition,
      directPlan,
      rational(0),
    );
    assert.deepEqual(effectedAnchor.basis, directAnchor.basis);
    assert.equal(effectedAnchor.affineIdentity, directAnchor.affineIdentity);
    assert.notEqual(effectedAnchor.ownerPlanIdentity, directAnchor.ownerPlanIdentity);

    const inspected = inspectCutIr(effected, "out");
    const inspectedCamera = inspected.graph.nodes.find((node) => node.op === "cut.visual.media_camera2d") as unknown as {
      mediaCamera2D?: {
        nativeEffectChain?: {
          order: string;
          executionOrder: readonly Readonly<{ op: string }>[];
          firstFrame?: { planIdentity: string };
        };
      };
    };
    assert.equal(
      inspectedCamera.mediaCamera2D?.nativeEffectChain?.order,
      "inner-to-outer-before-edge-and-affine",
    );
    assert.deepEqual(
      inspectedCamera.mediaCamera2D?.nativeEffectChain?.executionOrder.map((operation) => operation.op),
      ["cut.visual.duotone", "cut.visual.grain", "cut.visual.vignette"],
    );
    assert.equal(
      inspectedCamera.mediaCamera2D?.nativeEffectChain?.firstFrame?.planIdentity,
      effectedFrame.nativeEffectChain?.planIdentity,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native-crop effects execute deterministically before the sole Q16 affine and chain order changes pixels", { timeout: 60_000 }, async () => {
  const root = await fixture();
  try {
    const firstIr = await locked(root, program(chainA));
    const repeatedIr = await locked(root, program(chainA));
    const reversedIr = await locked(root, program(chainB));
    const first = await render(firstIr, root, 0, "first");
    const repeated = await render(repeatedIr, root, 0, "repeated");
    const reversed = await render(reversedIr, root, 0, "reversed");
    const firstHash = createHash("sha256").update(first.surface.data).digest("hex");
    assert.equal(
      firstHash,
      createHash("sha256").update(repeated.surface.data).digest("hex"),
      "same locked source and chain must reproduce exact output bytes",
    );
    assert.notEqual(
      firstHash,
      createHash("sha256").update(reversed.surface.data).digest("hex"),
      "authored effect order must be causal",
    );
    assert.equal(first.evidence.nativeEffectChain?.status, "executed");
    assert.deepEqual(
      first.evidence.nativeEffectChain?.operations.map((operation) => operation.op),
      ["cut.visual.duotone", "cut.visual.grain", "cut.visual.vignette"],
    );
    assert.equal(first.evidence.nativeEffectChain?.operations.length, 3);
    assert.equal(first.evidence.allocations.nativeEffectSurfaces, 3);
    assert.equal(first.evidence.allocations.nativeEffectRgbaBytes, 3 * 8 * 6 * 4);
    assert.equal(first.evidence.allocations.compositionPrerasterCount, 0);
    assert.equal(first.evidence.allocations.geometricResampleCount, 1);
    assert.equal(first.evidence.work.nativeEffectOperationCount, 3);
    assert.ok((first.evidence.work.maximumNativeEffectPixelWork ?? 0) > 0);
    assert.equal(
      first.evidence.sceneAdmission.aggregate.nativeEffectOperations,
      3,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project, scene, and alias renaming cannot select a fixture-specific media finishing path", { timeout: 60_000 }, async () => {
  const root = await fixture();
  try {
    const originalSource = program(chainA);
    const renamedSource = program(chainA, { title: "Unrelated renamed media program" })
      .replace("scene only", "scene renamed_scene")
      .replace("as camera", "as renamedCamera");
    const original = await render(await locked(root, originalSource), root, 0, "metamorphic-original");
    const renamed = await render(await locked(root, renamedSource), root, 0, "metamorphic-renamed");
    assert.deepEqual(renamed.surface.data, original.surface.data);
    assert.deepEqual(renamed.evidence.geometry, original.evidence.geometry);
    assert.deepEqual(renamed.evidence.work, original.evidence.work);
    assert.deepEqual(renamed.evidence.allocations, original.evidence.allocations);
    assert.deepEqual(
      renamed.evidence.nativeEffectChain?.operations.map(({ op, outputRgbaSha256 }) => ({ op, outputRgbaSha256 })),
      original.evidence.nativeEffectChain?.operations.map(({ op, outputRgbaSha256 }) => ({ op, outputRgbaSha256 })),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiler, runtime, CLI, scripts, and schemas contain no V10/V17 fixture fingerprints", async () => {
  const forbidden = [
    "Source-Anchored Callouts — One Photograph, One Affine",
    "Raster Coordinates Stay With the Camera",
    "market-and-turk-after-fire-1906.tif",
    "exterior.webm",
    "v17-source-anchored-callouts",
    "v10-native-raster-anchors",
    "37d7b7dad15052ee7e0f7eccd4cfeff03b8ae3919e51cf1d346ec68e6e3780c7",
    "ce16bc8a",
  ] as const;
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const directory of ["lib", "cli", "scripts", "schemas"]) await visit(resolve(process.cwd(), directory));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const fingerprint of forbidden) {
      assert.equal(source.includes(fingerprint), false, `${file} contains forbidden fixture fingerprint ${fingerprint}`);
    }
  }
});

test("ColorGrade executes at its authored inner-to-outer chain position while direct grade remains a legacy special case", { timeout: 60_000 }, async () => {
  const root = await fixture();
  try {
    const outerIr = await locked(root, program(outerGradeChain));
    const innerIr = await locked(root, program(innerGradeChain));
    const outerComposition = outerIr.compositions[0]!, innerComposition = innerIr.compositions[0]!;
    const outerPlan = [...validateReferenceMediaCamera2DGraph(outerIr, outerComposition).values()][0]!;
    const innerPlan = [...validateReferenceMediaCamera2DGraph(innerIr, innerComposition).values()][0]!;
    const outerFramePlan = referenceMediaCamera2DFramePlanAt(outerIr, outerComposition, outerPlan, rational(0));
    const innerFramePlan = referenceMediaCamera2DFramePlanAt(innerIr, innerComposition, innerPlan, rational(0));
    assert.deepEqual(outerFramePlan.geometry.sourceToDeliveryQ16, innerFramePlan.geometry.sourceToDeliveryQ16);
    const outerAnchor = referenceMediaCamera2DAnchorPlanAt(outerIr, outerComposition, outerPlan, rational(0));
    const innerAnchor = referenceMediaCamera2DAnchorPlanAt(innerIr, innerComposition, innerPlan, rational(0));
    assert.deepEqual(outerAnchor.basis, innerAnchor.basis);
    assert.equal(outerAnchor.affineIdentity, innerAnchor.affineIdentity);
    assert.notEqual(outerAnchor.ownerPlanIdentity, innerAnchor.ownerPlanIdentity);

    const outer = await render(outerIr, root, 0, "outer-grade");
    const inner = await render(innerIr, root, 0, "inner-grade");
    assert.deepEqual(
      outer.evidence.nativeEffectChain?.operations.map((operation) => operation.op),
      ["cut.visual.grain", "cut.visual.color_grade"],
    );
    assert.deepEqual(
      inner.evidence.nativeEffectChain?.operations.map((operation) => operation.op),
      ["cut.visual.color_grade", "cut.visual.grain"],
    );
    assert.equal(outer.evidence.allocations.colorGradeSurfaces, 2);
    assert.equal(inner.evidence.allocations.colorGradeSurfaces, 2);
    assert.equal(outer.evidence.allocations.nativeEffectSurfaces, 1);
    assert.equal(inner.evidence.allocations.nativeEffectSurfaces, 1);
    assert.notEqual(
      createHash("sha256").update(outer.surface.data).digest("hex"),
      createHash("sha256").update(inner.surface.data).digest("hex"),
      "grade-before-grain and grain-before-grade must remain observably different programs",
    );

    const directGradeIr = await locked(
      root,
      program('ColorGrade(exposure: 0.3, saturation: 0.75) { Image(source: media, fit: "fill"); }'),
    );
    const directGrade = await render(directGradeIr, root, 0, "direct-grade-legacy");
    assert.equal(directGrade.evidence.nativeEffectChain, undefined);
    assert.equal(directGrade.evidence.allocations.nativeEffectSurfaces, undefined);
    assert.equal(directGrade.evidence.work.nativeEffectOperationCount, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opacity-zero skips decode and every native-crop effect while retaining a closed evidence receipt", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program(chainA, { opacityAnimation: true }));
    const frame = await render(ir, root, 0, "opacity-zero");
    assert.equal(frame.evidence.status, "opacity-zero");
    assert.equal(frame.evidence.nativeEffectChain?.status, "skipped-opacity-zero");
    assert.ok(frame.evidence.nativeEffectChain?.operations.every(
      (operation) => operation.outputRgbaSha256 === undefined && operation.outputRgbaBytes === 0,
    ));
    assert.equal(frame.evidence.allocations.sourceOpens, 0);
    assert.equal(frame.evidence.allocations.decodedSurfaces, 0);
    assert.equal(frame.evidence.allocations.nativeEffectSurfaces, 0);
    assert.equal(frame.evidence.allocations.nativeEffectRgbaBytes, 0);
    assert.equal(frame.evidence.work.maximumNativeEffectPixelWork, 0);
    assert.equal(frame.evidence.work.maximumNativeEffectOutputRgbaBytes, 0);
    assert.equal(frame.evidence.allocations.geometricResampleCount, 0);
    assert.ok(frame.surface.data.every((value) => value === 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("effect-chain receipt schema is strict while legacy direct and direct-grade receipts stay field-compatible", { timeout: 60_000 }, async () => {
  const root = await fixture();
  try {
    const rootSchema = JSON.parse(
      await readFile(resolve(process.cwd(), "schemas/cut-reference-frame-v2.schema.json"), "utf8"),
    ) as { definitions: Record<string, unknown> };
    const validate = new Ajv({ allErrors: true }).compile({
      ...(rootSchema.definitions.mediaCamera2DFrameEvidence as object),
      definitions: rootSchema.definitions,
    });
    const effected = await render(await locked(root, program(chainA)), root, 0, "schema-effected");
    const direct = await render(
      await locked(root, program('Image(source: media, fit: "fill");')),
      root,
      0,
      "schema-direct",
    );
    const graded = await render(
      await locked(root, program('ColorGrade(exposure: 0.25) { Image(source: media, fit: "fill"); }')),
      root,
      0,
      "schema-graded",
    );
    for (const evidence of [effected.evidence, direct.evidence, graded.evidence]) {
      assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
    }
    for (const legacy of [direct.evidence, graded.evidence]) {
      assert.equal(legacy.nativeEffectChain, undefined);
      assert.equal(legacy.allocations.nativeEffectSurfaces, undefined);
      assert.equal(legacy.allocations.nativeEffectRgbaBytes, undefined);
      assert.equal(legacy.work.nativeEffectOperationCount, undefined);
      assert.equal(legacy.sceneAdmission.aggregate.nativeEffectOperations, undefined);
    }
    const hostile = structuredClone(effected.evidence) as unknown as {
      nativeEffectChain: { operations: Array<Record<string, unknown>> };
    };
    hostile.nativeEffectChain.operations[0]!.silentlyIgnored = true;
    assert.equal(validate(hostile), false, "unknown effect evidence fields must fail closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a native-effect edit invalidates only its picture ancestry while media decode, audio, and unrelated scenes remain reusable", () => {
  const cacheProgram = (seed: number) => `cut 0.4;
project "MediaCamera2D native-effect cache locality";
import { Grain, Image, MediaCamera2D, Rect, Vignette } from "cut:visual";
import { Tone } from "@cut/audio";
asset media: ImageAsset = image("assets/source.png");
timeline main(duration: 2s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene camera(duration: 1s) {
    MediaCamera2D(focusX: 25%) {
      Vignette(amount: 30%, radius: 50%, softness: 60%) {
        Grain(amount: 8%, size: 1px, seed: ${seed}, mode: "static") {
          Image(source: media, fit: "fill");
        }
      }
    }
    Tone(frequency: 440hz, duration: 1s);
  }
  scene unrelated(duration: 1s) {
    Rect(width: 320px, height: 180px, fill: #203040);
    Tone(frequency: 330hz, duration: 1s);
  }
}
export out = render(main);`;
  const before = compile(cacheProgram(17));
  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = compile(cacheProgram(18));
  const incremental = createIncrementalRenderPlan(after, "main", previous);
  const status = (op: string, sceneName: string) => {
    const scene = Object.values(after.scenes).find((candidate) => candidate.name === sceneName)!;
    const node = Object.values(after.nodes).find(
      (candidate) => candidate.op === op && candidate.sceneId === scene.id,
    )!;
    return incremental.nodes.find((candidate) => candidate.id === node.id)?.status;
  };
  assert.equal(status("cut.visual.grain", "camera"), "miss");
  assert.equal(status("cut.visual.vignette", "camera"), "miss");
  assert.equal(status("cut.visual.media_camera2d", "camera"), "miss");
  assert.equal(status("cut.visual.image", "camera"), "hit");
  assert.equal(status("cut.audio.tone", "camera"), "hit");
  assert.equal(status("cut.visual.rect", "unrelated"), "hit");
  assert.equal(status("cut.audio.tone", "unrelated"), "hit");
  const cameraScene = Object.values(after.scenes).find((candidate) => candidate.name === "camera")!;
  const unrelatedScene = Object.values(after.scenes).find((candidate) => candidate.name === "unrelated")!;
  assert.equal(incremental.scenes.find((candidate) => candidate.id === cameraScene.id)?.status, "miss");
  assert.equal(incremental.scenes.find((candidate) => candidate.id === unrelatedScene.id)?.status, "hit");
});

test("unsupported, temporal, no-op, over-depth, duplicate-grade, and stale effect chains fail before pixels", async () => {
  expectDiagnostic(
    program('Shadow(radius: 2px) { Image(source: media, fit: "fill"); }'),
    "CUT_MEDIA_CAMERA_GRAPH",
    /admits only ColorGrade, Blur, Sharpen/u,
  );
  expectDiagnostic(
    program('Grain(amount: 8%, mode: "temporal") { Image(source: media, fit: "fill"); }'),
    "CUT_MEDIA_CAMERA_GRAPH",
    /static Grain only/u,
  );
  expectDiagnostic(
    program('Blur(radius: 0px) { Image(source: media, fit: "fill"); }'),
    "CUT2085",
    /Blur radius is zero/u,
  );
  const nested = Array.from({ length: 9 }).fill(0).reduce<string>(
    (child) => `Blur(radius: 1px) { ${child} }`,
    'Image(source: media, fit: "fill");',
  );
  expectDiagnostic(program(nested), "CUT_MEDIA_CAMERA_GRAPH", /depth exceeds 8/u);
  expectDiagnostic(
    program('ColorGrade(exposure: 0.2) { ColorGrade(exposure: 0.3) { Image(source: media, fit: "fill"); } }'),
    "CUT_MEDIA_CAMERA_GRAPH",
    /at most one ColorGrade/u,
  );

  const root = await fixture();
  try {
    const oversized = await locked(root, program(chainA));
    const oversizedResource = Object.values(oversized.resources)[0]!;
    const oversizedProbe = structuredClone(oversizedResource.metadata?.probe) as {
      identity?: { image?: { width?: number; height?: number } };
    } | undefined;
    const imageProbe = oversizedProbe?.identity?.image;
    assert.ok(imageProbe);
    imageProbe.width = 5_000;
    imageProbe.height = 4_000;
    oversizedResource.metadata = { ...oversizedResource.metadata, probe: oversizedProbe };
    assert.throws(
      () => validateReferenceMediaCamera2DGraph(oversized, oversized.compositions[0]!),
      /CUT_MEDIA_CAMERA_LIMIT: MediaCamera2D at .*native-crop visual effects are bounded to 16777216 source pixels/u,
    );

    const ir = await locked(root, program(chainA));
    const composition = ir.compositions[0]!;
    const plan = [...validateReferenceMediaCamera2DGraph(ir, composition).values()][0]!;
    const grain = Object.values(ir.nodes).find((node) => node.op === "cut.visual.grain")!;
    grain.inputs.seed = {
      kind: "quantity",
      dimension: "scalar",
      unit: "scalar",
      magnitude: rational(74),
    };
    assert.throws(
      () => referenceMediaCamera2DFramePlanAt(ir, composition, plan, rational(0)),
      /CUT_MEDIA_CAMERA_PREFLIGHT: MediaCamera2D at .*native-crop effect .*changed after locked static planning/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
