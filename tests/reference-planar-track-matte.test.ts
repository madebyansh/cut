import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { parseStrictPackageJson } from "../lib/package/json";
import { inspectCutIr } from "../lib/runtime/inspect";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import {
  ReferencePlanarTrackFrameEvidenceError,
  validateReferencePlanarTrackFrameEvidenceSemantics,
} from "../lib/runtime/reference/planar-track-evidence";
import {
  ReferencePlanarTrackMatteError,
  referencePlanarTrackMatteConfig,
} from "../lib/runtime/reference/planar-track-matte";
import { validateReferenceLocalSpaceGraph } from "../lib/runtime/reference/local-space";

const q = (numerator: number | string, denominator: number | string = 1) =>
  ({ numerator: String(numerator), denominator: String(denominator) });
const corners = (left: number, top: number, right: number, bottom: number) => ({
  topLeft: { x: q(left), y: q(top) },
  topRight: { x: q(right), y: q(top) },
  bottomRight: { x: q(right), y: q(bottom) },
  bottomLeft: { x: q(left), y: q(bottom) },
});

const sidecar = {
  format: "cut-planar-track",
  version: 1,
  coordinateSpace: "composition-pixel-edges",
  width: 64,
  height: 48,
  samples: [
    { at: q(0), confidence: q(1), status: "visible", corners: corners(10, 10, 18, 14) },
    { at: q(1), confidence: q(1), status: "visible", corners: corners(10, 10, 18, 14) },
  ],
};

type SourceOptions = Readonly<{
  mode?: "alpha" | "luminance";
  matteWidth?: number;
  secondMask?: boolean;
  animate?: boolean;
}>;

function source(options: SourceOptions = {}) {
  const mode = options.mode ?? "alpha", matteWidth = options.matteWidth ?? 4;
  const mask = (suffix: string, x: number) => `Mask(mode: "${mode}", feather: 0px, expand: 0px) as masked${suffix} {
          Rect(width: 8px, height: 4px, x: 4px, y: 2px, fill: #ff2000);
          Rect(width: ${matteWidth}px, height: 4px, x: ${x}px, y: 2px, fill: #ffffffff);
        }
        ${options.animate && suffix === "A" ? "animate maskedA.x from 0px to 2px over 1s ease linear;" : ""}`;
  return `cut 0.4;
project "bounded planar local alpha matte";
import { LocalSpace, Mask, PlanarTrack, Rect } from "cut:visual";
import { Tone } from "@cut/audio";
import { linear } from "@cut/motion";
asset tracking: DataAsset = data("assets/plane.planar-track.json");
timeline main(duration: 2s, fps: 4, width: 64px, height: 48px, sampleRate: 8khz) {
  scene replacement(duration: 1s) {
    PlanarTrack(
      source: tracking,
      minConfidence: 75%,
      lowConfidence: "fail",
      occluded: "fail",
      outOfFrame: "fail"
    ) {
      LocalSpace(width: 8px, height: 4px, origin: { x: 0px, y: 0px }) {
        ${mask("A", matteWidth / 2)}
        ${options.secondMask ? mask("B", 8 - matteWidth / 2) : ""}
      }
    }
    Tone(frequency: 220hz, duration: 1s, amplitude: 5%);
  }
  scene control(duration: 1s) {
    Rect(width: 12px, height: 12px, x: 20px, y: 20px, fill: #2050a0);
    Tone(frequency: 330hz, duration: 1s, amplitude: 5%);
  }
}
export out = render(main, width: 64px, height: 48px, codec: "h264");`;
}

function parse(sourceText: string) {
  const parsed = parseCutLanguage(sourceText);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return parsed;
}

function compile(sourceText = source()) {
  const parsed = parse(sourceText);
  const checked = checkCutModule(parsed.module!);
  assert.deepEqual(
    [...parsed.diagnostics, ...checked.diagnostics].filter((item) => item.severity === "error"),
    [],
  );
  return compileCutModule(parsed.module!).ir;
}

function one(ir: CutAVIR, op: string, predicate: (node: IRNode) => boolean = () => true) {
  const nodes = Object.values(ir.nodes).filter((node) => node.op === op && predicate(node));
  assert.equal(nodes.length, 1, op);
  return nodes[0]!;
}

function alphaBounds(surface: { data: Uint8Array; width: number; height: number }) {
  let left = surface.width, top = surface.height, right = -1, bottom = -1;
  for (let y = 0; y < surface.height; y += 1) for (let x = 0; x < surface.width; x += 1) {
    if (surface.data[(y * surface.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom };
}

test("public syntax lowers one animated alpha Mask into typed direct PlanarTrack LocalSpace IR and inspect", () => {
  const ir = compile(source({ animate: true }));
  const owner = one(ir, "cut.visual.planar_track");
  const local = one(ir, "cut.visual.local_space");
  const mask = one(ir, "cut.visual.mask");
  assert.deepEqual(owner.children, [local.id]);
  assert.deepEqual(local.children, [mask.id]);
  assert.equal(mask.inputs.mode?.kind, "string");
  assert.equal(mask.inputs.mode?.kind === "string" ? mask.inputs.mode.value : undefined, "alpha");
  assert.equal(mask.children.length, 2);
  assert.ok(mask.properties.x && "signal" in mask.properties.x, "existing visual-property automation must remain typed");

  const matte = referencePlanarTrackMatteConfig(ir, owner);
  assert.ok(matte);
  assert.deepEqual({
    maskNodeId: matte.maskNodeId,
    targetNodeId: matte.targetNodeId,
    matteNodeId: matte.matteNodeId,
    mode: matte.mode,
    coordinateSpace: matte.coordinateSpace,
    evaluationStage: matte.evaluationStage,
    authoring: matte.authoring,
  }, {
    maskNodeId: mask.id,
    targetNodeId: mask.children[0],
    matteNodeId: mask.children[1],
    mode: "alpha",
    coordinateSpace: "direct-planar-local-pixels",
    evaluationStage: "before-projective-warp",
    authoring: "manual",
  });

  const inspected = inspectCutIr(ir, "project.cut") as {
    graph: { nodes: Array<{ id: string; planarTrack?: { partialOcclusionMatte?: Record<string, unknown> } }> };
  };
  const value = inspected.graph.nodes.find((node) => node.id === owner.id)?.planarTrack?.partialOcclusionMatte;
  assert.ok(value);
  assert.equal(value.maskNodeId, mask.id);
  assert.equal(value.mode, "alpha");
  assert.equal(value.evaluationStage, "before-projective-warp");
  assert.equal(value.operationSemanticIdentity, validateReferenceLocalSpaceGraph(ir, ir.compositions[0]!)
    .get(local.id)?.localCompositing.operations[0]?.semanticIdentity);
});

test("contextual diagnostics reject non-alpha or multiple direct plane mattes while ordinary LocalSpace Mask remains unchanged", () => {
  const luminance = parse(source({ mode: "luminance" }));
  const luminanceCheck = checkCutModule(luminance.module!);
  assert.ok(luminanceCheck.diagnostics.some((item) =>
    item.code === "CUT_PLANAR_TRACK_MATTE_MODE"
      && item.span.start.line > 0
      && /alpha Mask only/u.test(item.message)));
  assert.throws(
    () => compileCutModule(luminance.module!),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT_PLANAR_TRACK_MATTE_MODE"),
  );

  const multiple = parse(source({ secondMask: true }));
  const multipleCheck = checkCutModule(multiple.module!);
  assert.ok(multipleCheck.diagnostics.some((item) =>
    item.code === "CUT_PLANAR_TRACK_MATTE_LIMIT" && item.span.start.line > 0));

  const ordinary = `cut 0.4;
project "ordinary luminance local mask";
import { LocalSpace, Mask, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 2, width: 16px, height: 12px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    LocalSpace(width: 8px, height: 6px, origin: { x: 4px, y: 3px }) {
      Mask(mode: "luminance") {
        Rect(width: 8px, height: 6px, fill: #ff0000);
        Rect(width: 4px, height: 6px, fill: #ffffff);
      }
    }
  }
}
export out = render(main, width: 16px, height: 12px, codec: "h264");`;
  assert.doesNotThrow(() => compile(ordinary), "PlanarTrack's bounded alpha rule must not narrow ordinary public Mask");
});

test("strict loaded IR and direct runtime admission fail closed on contextual matte forgery", () => {
  const baseline = compile();
  const forgedMode = structuredClone(baseline), modeMask = one(forgedMode, "cut.visual.mask");
  modeMask.inputs.mode = { kind: "string", value: "luminance" };
  finalizeGraphHashes(forgedMode);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(forgedMode)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_PLANAR_TRACK_MATTE_MODE"
      && error.path.endsWith(`.${"inputs.mode"}`),
  );
  assert.throws(
    () => validateReferenceLocalSpaceGraph(forgedMode, forgedMode.compositions[0]!),
    (error: unknown) => error instanceof ReferencePlanarTrackMatteError
      && error.code === "CUT_PLANAR_TRACK_MATTE_MODE"
      && error.source.nodeId === modeMask.id,
  );

  const forgedCount = structuredClone(baseline);
  const local = one(forgedCount, "cut.visual.local_space"), original = one(forgedCount, "cut.visual.mask");
  const duplicateId = "node_2222222222222222";
  forgedCount.nodes[duplicateId] = {
    ...structuredClone(original),
    id: duplicateId,
    contentHash: "0".repeat(64),
  };
  local.children.push(duplicateId);
  finalizeGraphHashes(forgedCount);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(forgedCount)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_PLANAR_TRACK_MATTE_LIMIT"
      && error.path.endsWith(`.${"op"}`),
  );
});

test("the alpha matte executes on the bounded local tile before warp with authenticated evidence and changing pixels", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-matte-"));
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/plane.planar-track.json"), JSON.stringify(sidecar));
    const ir = compile(source({ animate: true })), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir, "out");
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/cache"));
    await renderer.prepare();
    try {
      const scene = ir.scenes[composition.sceneIds[0]!]!;
      const first = await renderer.sceneFrame(scene, 0, false);
      const firstReceipt = renderer.referencePlanarTrackEvidence()[0];
      const firstAuthority = renderer.referencePlanarTrackEvidenceTrustedContexts()[0];
      assert.ok(firstReceipt && firstReceipt.status === "rendered" && firstAuthority);
      if (!firstReceipt || firstReceipt.status !== "rendered" || !firstAuthority) return;
      const firstLocal = renderer.referenceLocalSpaceEvidence();
      assert.ok(firstLocal);
      const tile = firstLocal.tiles.find((candidate) => candidate.nodeId === firstReceipt.localSpaceNodeId);
      assert.ok(tile?.localCompositing);
      assert.equal(tile.localCompositing.operations.length, 1);
      assert.equal(tile.localCompositing.operations[0]?.op, "cut.visual.mask");
      assert.equal(tile.localCompositing.finalRgbaSha256, firstReceipt.tile.rgbaSha256);
      assert.equal(firstReceipt.tile.preProjectiveMatte?.operationSemanticIdentity, tile.localCompositing.operations[0]?.semanticIdentity);
      assert.equal(firstReceipt.tile.preProjectiveMatte?.localCompositingPlanIdentity, tile.localCompositing.planIdentity);
      assert.equal(firstReceipt.tile.preProjectiveMatte?.evaluationStage, "before-projective-warp");
      assert.deepEqual(alphaBounds(first), { left: 10, top: 10, right: 13, bottom: 13 });

      const frameSchema = parseStrictPackageJson(await readFile("schemas/cut-reference-frame-v2.schema.json", "utf8")) as { definitions: Record<string, unknown> };
      const receiptSchema = { ...(frameSchema.definitions.planarTrackFrameEvidence as object), definitions: frameSchema.definitions };
      const validateReceipt = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true })
        .compile(receiptSchema);
      assert.equal(validateReceipt(firstReceipt), true, JSON.stringify(validateReceipt.errors));
      assert.equal(validateReferencePlanarTrackFrameEvidenceSemantics(firstReceipt, {
        trustedContext: firstAuthority,
        outputWidth: 64,
        outputHeight: 48,
        minimumExactTime: q(0),
        maximumExactTime: q(1),
        outputFrame: "0",
      }), firstReceipt);

      const later = await renderer.sceneFrame(scene, 2, false);
      const laterReceipt = renderer.referencePlanarTrackEvidence()[0];
      assert.ok(laterReceipt && laterReceipt.status === "rendered");
      if (!laterReceipt || laterReceipt.status !== "rendered") return;
      assert.deepEqual(alphaBounds(later), { left: 11, top: 10, right: 14, bottom: 13 });
      assert.notEqual(createHash("sha256").update(first.data).digest("hex"), createHash("sha256").update(later.data).digest("hex"));
      assert.notEqual(firstReceipt.tile.rgbaSha256, laterReceipt.tile.rgbaSha256);

      const forged = JSON.parse(JSON.stringify(firstReceipt)) as {
        status: string;
        tile: { preProjectiveMatte?: { evaluationStage: string } };
      };
      if (forged.status === "rendered" && forged.tile.preProjectiveMatte) {
        forged.tile.preProjectiveMatte.evaluationStage = "after-projective-warp";
        assert.equal(validateReceipt(forged), false, "closed evidence must refuse a false post-warp matte claim");
        assert.throws(
          () => validateReferencePlanarTrackFrameEvidenceSemantics(forged, {
            trustedContext: firstAuthority,
            outputWidth: 64,
            outputHeight: 48,
            minimumExactTime: q(0),
            maximumExactTime: q(1),
            outputFrame: "0",
          }),
          (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError
            && error.path === "$.tile.preProjectiveMatte.evaluationStage",
        );
      }
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matte-only edits invalidate the owning picture path while retaining sidecar, unrelated scene, and audio identities", () => {
  const before = compile(source({ matteWidth: 4 })), after = compile(source({ matteWidth: 2 }));
  const beforeOwner = one(before, "cut.visual.planar_track"), afterOwner = one(after, "cut.visual.planar_track");
  const beforeMatte = referencePlanarTrackMatteConfig(before, beforeOwner), afterMatte = referencePlanarTrackMatteConfig(after, afterOwner);
  assert.ok(beforeMatte && afterMatte);
  assert.notEqual(beforeMatte.semanticIdentity, afterMatte.semanticIdentity);
  assert.equal(before.resources.tracking?.locator, after.resources.tracking?.locator);
  assert.ok(diffCutAVIR(before, after).changes.some((change) => change.entity === "node" && change.operation === "modify"));

  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const incremental = createIncrementalRenderPlan(after, "main", previous);
  const replacement = Object.values(after.scenes).find((scene) => scene.name === "replacement");
  const control = Object.values(after.scenes).find((scene) => scene.name === "control");
  assert.ok(replacement && control);
  assert.equal(incremental.scenes.find((scene) => scene.id === replacement.id)?.status, "miss");
  assert.equal(incremental.scenes.find((scene) => scene.id === control.id)?.status, "hit");
  assert.equal(incremental.nodes.find((node) => node.id === afterOwner.id)?.status, "miss");
  for (const tone of Object.values(after.nodes).filter((node) => node.op === "cut.audio.tone")) {
    assert.equal(incremental.nodes.find((node) => node.id === tone.id)?.status, "hit");
  }
});
