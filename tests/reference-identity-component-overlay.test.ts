import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import sharp from "sharp";
import { hash } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import {
  referenceMediaCamera2DAnchoredPathAlgorithmVersion,
} from "../lib/runtime/reference/anchored-path";
import {
  referenceCalloutDecisionIdentity,
  referenceCalloutExecutionIdentity,
  validateReferenceCalloutFrameEvidenceSemantics,
} from "../lib/runtime/reference/callout";
import {
  validateReferenceIdentityComponentFragments,
} from "../lib/runtime/reference/identity-component-fragment";
import {
  validateReferenceIdentityComponentFragmentFrameEvidence,
} from "../lib/runtime/reference/identity-component-fragment-evidence";
import {
  referenceMediaCamera2DAnchorAlgorithmVersion,
  referenceMediaCamera2DResponsiveSlotAnchorAlgorithmVersion,
  referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion,
} from "../lib/runtime/reference/media-camera2d";
import {
  bindReferenceResponsiveSlotMediaAnchorFrameEvidence,
  validateReferenceResponsiveSlotMediaAnchorFrameEvidence,
} from "../lib/runtime/reference/responsive-slot-media-anchor";
import {
  referenceReachableCompositionNodes,
  validateReferenceSession,
} from "../lib/runtime/reference/validate";
import { validateReferenceStaticVisualGraphs } from "../lib/runtime/reference/static-visual-validation";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(invocations = "AnnotatedShot(still);") {
  return `cut 0.4;
project "Identity component runtime";
import {
  Callout, CalloutLayer, Image, LocalSpace, MediaCamera2D, Path, Rect,
  ResponsiveSlot, ResponsiveStack, anchoredLineTo, anchoredPath,
  responsiveStackPlan, visualAnchor
} from "cut:visual";
import { linear } from "@cut/motion";
component AnnotatedShot(still: ImageAsset) -> Visual {
  let plan = responsiveStackPlan(weights: [2, 1], safeX: 0%, safeY: 0%, gap: 4px);
  ResponsiveStack(plan: plan) {
    ResponsiveSlot() {
      MediaCamera2D(focusX: 25%, focusY: 45%, zoom: 1.2) as shot {
        Image(source: still, fit: "cover");
      }
      animate shot.focusX from 25% to 75% over 1s ease linear;
    }
    ResponsiveSlot() {
      Rect(width: 20px, height: 36px, fill: #d85b45);
    }
  }
  Path(
    geometry: anchoredPath(
      start: visualAnchor(owner: shot, local: { x: 2px, y: 2px }),
      segments: [anchoredLineTo(to: { x: 35px, y: 18px })],
      closed: false
    ),
    stroke: #ffffff,
    width: 1px
  );
  CalloutLayer() {
    Callout(
      anchor: visualAnchor(owner: shot, local: { x: 4px, y: 3px }),
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
  }
}
asset still: ImageAsset = image("assets/source.png");
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${invocations}
  }
}
export out = render(main, width: 64px, height: 36px, codec: "h264");`;
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
  return compileCutModule(parsed.module).ir;
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

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-identity-component-"));
  await mkdir(resolve(root, "assets"));
  await sharp(imagePixels(), { raw: { width: 8, height: 6, channels: 4 } })
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

function rgbaSha256(surface: Readonly<{ data: Uint8Array }>) {
  return createHash("sha256").update(surface.data).digest("hex");
}

function nodes(ir: CutAVIR, op: string) {
  return Object.values(ir.nodes).filter((node) => node.op === op);
}

function identityConfigs(ir: CutAVIR) {
  const composition = ir.compositions[0]!;
  return validateReferenceIdentityComponentFragments(
    ir,
    composition,
    referenceReachableCompositionNodes(ir, composition),
  );
}

function rehashedClone<T>(value: T, mutate: (clone: T) => void) {
  const clone = structuredClone(value);
  mutate(clone);
  finalizeGraphHashes(clone as CutAVIR);
  return clone;
}

test("formatting-only comments preserve identity-component semantic, cache, and inspect identities", { timeout: 90_000 }, async () => {
  const root = await fixture();
  try {
    const plain = await locked(root, program());
    const commented = await locked(
      root,
      `// formatting-only comment\n${program()}`,
    );
    const plainFragment = nodes(plain, "cut.kernel.fragment")[0]!;
    const commentedFragment = nodes(commented, "cut.kernel.fragment")[0]!;
    const plainConfig = identityConfigs(plain).get(plainFragment.id);
    const commentedConfig =
      identityConfigs(commented).get(commentedFragment.id);
    assert.ok(plainConfig && commentedConfig);
    assert.equal(commented.buildId, plain.buildId);
    assert.equal(commentedFragment.contentHash, plainFragment.contentHash);
    assert.equal(
      commentedConfig.provenanceIdentity,
      plainConfig.provenanceIdentity,
    );
    assert.equal(
      commentedConfig.semanticIdentity,
      plainConfig.semanticIdentity,
    );
    assert.equal(commentedConfig.cacheIdentity, plainConfig.cacheIdentity);
    const inspectIdentity = (ir: CutAVIR, fragmentId: string) => {
      const inspection = inspectCutIr(ir, "identity-component.cut");
      const fragment = inspection.graph.nodes.find((node) =>
        node.id === fragmentId) as unknown as {
          identityComponentFragment?: Readonly<{
            cacheIdentity: string;
            semanticIdentity: string;
          }>;
        };
      return fragment.identityComponentFragment;
    };
    assert.deepEqual(
      inspectIdentity(commented, commentedFragment.id),
      inspectIdentity(plain, plainFragment.id),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identity Visual component executes Stack, anchored Path, and CalloutLayer as zero-wrapper composition layers", { timeout: 90_000 }, async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program());
    const { composition } = validateReferenceSession(ir, "out");
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const fragment = nodes(ir, "cut.kernel.fragment")[0]!;
    const config = identityConfigs(ir).get(fragment.id);
    assert.ok(config);
    assert.equal(config.slotNodeId, ir.nodes[config.stackNodeId]!.children[0]);
    assert.deepEqual(validateReferenceStaticVisualGraphs(ir), []);
    const inspection = inspectCutIr(ir, "identity-component.cut");
    const inspectedFragment = inspection.graph.nodes.find((node) =>
      node.id === fragment.id) as unknown as {
        identityComponentFragment?: {
          fragmentNodeId: string;
          execution?: { wrapperRasterMaterializations: number };
        };
      };
    const inspectedStack = inspection.graph.nodes.find((node) =>
      node.id === config.stackNodeId) as unknown as {
        responsiveStack?: {
          identityComponentFragment?: { fragmentNodeId: string };
        };
      };
    const inspectedLayer = inspection.graph.nodes.find((node) =>
      node.id === config.calloutLayerNodeId) as unknown as {
        calloutLayer?: {
          identityComponentFragment?: { fragmentNodeId: string };
        };
      };
    assert.equal(
      inspectedFragment.identityComponentFragment?.fragmentNodeId,
      fragment.id,
    );
    assert.equal(
      inspectedFragment.identityComponentFragment?.execution
        ?.wrapperRasterMaterializations,
      0,
    );
    assert.equal(
      inspectedStack.responsiveStack?.identityComponentFragment?.fragmentNodeId,
      fragment.id,
    );
    assert.equal(
      inspectedLayer.calloutLayer?.identityComponentFragment?.fragmentNodeId,
      fragment.id,
    );

    const renderer = new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, ".cut", "identity-component"),
    );
    try {
      await renderer.prepare();
      const firstSurface = await renderer.sceneFrame(scene, 0, false);
      const first = renderer.referenceIdentityComponentFragmentEvidence();
      const paths = renderer.referenceAnchoredPathEvidence();
      const callouts = renderer.referenceCalloutLayerEvidence();
      const cameras = renderer.referenceMediaCamera2DEvidence();
      const stacks = renderer.referenceResponsiveStackEvidence();
      const links = renderer.referenceResponsiveSlotMediaAnchorEvidence();
      assert.equal(first.length, 1);
      const receipt = first[0]!;
      validateReferenceIdentityComponentFragmentFrameEvidence(receipt, config, {
        anchoredPaths: paths,
        calloutLayers: callouts,
        cameras,
        responsiveStacks: stacks,
        slotMediaAnchorLinks: links,
      }, rgbaSha256(firstSurface));
      const forgedFragment = structuredClone(receipt);
      (forgedFragment.cameraExecutions[0] as { executionIdentity: string })
        .executionIdentity = "0".repeat(64);
      const forgedFragmentBody = Object.fromEntries(
        Object.entries(forgedFragment).filter(([key]) =>
          key !== "executionIdentity"),
      ) as Omit<typeof forgedFragment, "executionIdentity">;
      (forgedFragment as { executionIdentity: string }).executionIdentity =
        hash(forgedFragmentBody);
      assert.throws(
        () => validateReferenceIdentityComponentFragmentFrameEvidence(
          forgedFragment,
          config,
          {
            anchoredPaths: paths,
            calloutLayers: callouts,
            cameras,
            responsiveStacks: stacks,
            slotMediaAnchorLinks: links,
          },
          rgbaSha256(firstSurface),
        ),
        /cameraExecutions.*authenticated same-frame source ledger/u,
      );
      const rehashFragment = (candidate: typeof receipt) => {
        const body = Object.fromEntries(
          Object.entries(candidate).filter(([key]) =>
            key !== "executionIdentity"),
        ) as Omit<typeof candidate, "executionIdentity">;
        (candidate as { executionIdentity: string }).executionIdentity =
          hash(body);
      };
      const forgedPathPixels = structuredClone(receipt);
      const forgedPathChild = forgedPathPixels.children.find((child) =>
        child.nodeId === config.pathNodeId);
      assert.ok(forgedPathChild);
      (forgedPathChild as { outputRgbaSha256: string }).outputRgbaSha256 =
        "1".repeat(64);
      rehashFragment(forgedPathPixels);
      assert.throws(
        () => validateReferenceIdentityComponentFragmentFrameEvidence(
          forgedPathPixels,
          config,
          {
            anchoredPaths: paths,
            calloutLayers: callouts,
            cameras,
            responsiveStacks: stacks,
            slotMediaAnchorLinks: links,
          },
          rgbaSha256(firstSurface),
        ),
        /anchored Path child pixels.*authenticated rendered-output ledger/u,
      );
      const forgedScenePixels = structuredClone(receipt);
      (forgedScenePixels as { sceneOutputRgbaSha256: string })
        .sceneOutputRgbaSha256 = "2".repeat(64);
      rehashFragment(forgedScenePixels);
      assert.throws(
        () => validateReferenceIdentityComponentFragmentFrameEvidence(
          forgedScenePixels,
          config,
          {
            anchoredPaths: paths,
            calloutLayers: callouts,
            cameras,
            responsiveStacks: stacks,
            slotMediaAnchorLinks: links,
          },
          rgbaSha256(firstSurface),
        ),
        /scene output.*trusted completed renderer surface/u,
      );
      assert.deepEqual(receipt.children.map((child) => child.op), [
        "cut.visual.responsive_stack",
        "cut.visual.path",
        "cut.visual.callout_layer",
      ]);
      assert.deepEqual(receipt.work, {
        childDispatches: 3,
        wrapperRasterMaterializations: 0,
        wrapperCanvasAllocations: 0,
        wrapperTransforms: 0,
        wrapperClips: 0,
        wrapperGeometricResamples: 0,
      });
      assert.deepEqual(
        [receipt.cameraExecutions.length, receipt.responsiveStackExecutions.length,
          receipt.anchoredPathExecutions.length, receipt.calloutLayerExecutions.length,
          receipt.slotMediaAnchorLinks.length],
        [1, 1, 1, 1, 2],
      );
      assert.equal(cameras[0]?.allocations.compositionPrerasterCount, 0);
      assert.equal(cameras[0]?.allocations.geometricResampleCount, 1);
      assert.equal(stacks[0]?.slots[0]?.mediaCamera2D?.placement.geometricResampleCount, 0);
      assert.ok(paths[0]?.identityComponentFragment);
      assert.ok(callouts[0]?.identityComponentFragment);
      assert.ok(links.every((link) =>
        link.identityComponentFragment?.fragmentNodeId === fragment.id));
      assert.deepEqual(
        callouts[0]?.executionPath.map((entry) => entry.instanceNodeId ?? null),
        [null],
      );
      validateReferenceResponsiveSlotMediaAnchorFrameEvidence(
        structuredClone(links),
        composition.id,
        structuredClone(paths),
        structuredClone(callouts),
        structuredClone(cameras),
        structuredClone(stacks),
      );

      const secondSurface = await renderer.sceneFrame(scene, 2, false);
      const second = renderer.referenceIdentityComponentFragmentEvidence();
      assert.equal(second[0]?.cacheIdentity, receipt.cacheIdentity);
      assert.notEqual(second[0]?.executionIdentity, receipt.executionIdentity);
      assert.notEqual(rgbaSha256(secondSurface), rgbaSha256(firstSurface));
      assert.notDeepEqual(
        second[0]?.slotMediaAnchorLinks,
        receipt.slotMediaAnchorLinks,
      );

      const completed = {
        fragments: renderer.referenceIdentityComponentFragmentEvidence(),
        paths: renderer.referenceAnchoredPathEvidence(),
        callouts: renderer.referenceCalloutLayerEvidence(),
        cameras: renderer.referenceMediaCamera2DEvidence(),
        stacks: renderer.referenceResponsiveStackEvidence(),
        links: renderer.referenceResponsiveSlotMediaAnchorEvidence(),
      };
      fragment.properties.x = {
        kind: "quantity",
        dimension: "length",
        magnitude: { numerator: "1", denominator: "1" },
        unit: "px",
      };
      await assert.rejects(
        renderer.sceneFrame(scene, 1, false),
        /CUT_IDENTITY_FRAGMENT_UNSUPPORTED/u,
      );
      assert.deepEqual(renderer.referenceIdentityComponentFragmentEvidence(), completed.fragments);
      assert.deepEqual(renderer.referenceAnchoredPathEvidence(), completed.paths);
      assert.deepEqual(renderer.referenceCalloutLayerEvidence(), completed.callouts);
      assert.deepEqual(renderer.referenceMediaCamera2DEvidence(), completed.cameras);
      assert.deepEqual(renderer.referenceResponsiveStackEvidence(), completed.stacks);
      assert.deepEqual(renderer.referenceResponsiveSlotMediaAnchorEvidence(), completed.links);
      delete fragment.properties.x;
    } finally {
      await renderer.closeAndWait();
    }

    const manifest = await renderReferenceFrameArtifact(
      ir,
      root,
      resolve(root, "review", "identity-component.png"),
      { frame: 0, mediaProfile: "master" },
    );
    assert.equal(manifest.execution.identityComponentFragments?.length, 1);
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
    const unknown = structuredClone(manifest) as typeof manifest & {
      execution: typeof manifest.execution & {
        identityComponentFragments: Array<Record<string, unknown>>;
      };
    };
    unknown.execution.identityComponentFragments[0]!.invented = true;
    assert.equal(validateFrame(unknown), false);
    const oversizedQ16 = structuredClone(manifest);
    const link = oversizedQ16.execution.responsiveSlotMediaAnchors?.[0];
    assert.ok(link);
    (link.sourceToSlotQ16 as { tx: string }).tx = "9".repeat(128);
    assert.equal(validateFrame(oversizedQ16), false);
    const negativeZeroAnchorQ16 = structuredClone(manifest);
    const negativeZeroLink =
      negativeZeroAnchorQ16.execution.responsiveSlotMediaAnchors?.[0];
    assert.ok(negativeZeroLink);
    (negativeZeroLink.sourceToSlotQ16 as { b: string }).b = "-0";
    assert.equal(validateFrame(negativeZeroAnchorQ16), false);
    const negativeZeroCameraQ16 = structuredClone(manifest);
    const negativeZeroCamera =
      negativeZeroCameraQ16.execution.mediaCamera2Ds?.[0];
    assert.ok(negativeZeroCamera);
    (negativeZeroCamera.geometry.sourceToDeliveryQ16 as { b: string }).b =
      "-0";
    assert.equal(validateFrame(negativeZeroCameraQ16), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serialized slot-anchor receipts reject rehashed-looking source mutations and oversized Q16 before BigInt", { timeout: 90_000 }, async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program());
    const { composition } = validateReferenceSession(ir, "out");
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, ".cut", "identity-receipts"),
    );
    try {
      await renderer.prepare();
      await renderer.sceneFrame(scene, 0, false);
      const source = {
        links: renderer.referenceResponsiveSlotMediaAnchorEvidence(),
        paths: renderer.referenceAnchoredPathEvidence(),
        callouts: renderer.referenceCalloutLayerEvidence(),
        cameras: renderer.referenceMediaCamera2DEvidence(),
        stacks: renderer.referenceResponsiveStackEvidence(),
      };
      const validate = (overrides: Partial<typeof source>) =>
        validateReferenceResponsiveSlotMediaAnchorFrameEvidence(
          overrides.links ?? source.links,
          composition.id,
          overrides.paths ?? source.paths,
          overrides.callouts ?? source.callouts,
          overrides.cameras ?? source.cameras,
          overrides.stacks ?? source.stacks,
        );
      assert.doesNotThrow(() => validate({
        links: structuredClone(source.links),
        paths: structuredClone(source.paths),
        callouts: structuredClone(source.callouts),
        cameras: structuredClone(source.cameras),
        stacks: structuredClone(source.stacks),
      }));

      const negativeZeroPath = structuredClone(source.paths[0]!);
      const negativeZeroCamera = structuredClone(source.cameras[0]!);
      const negativeZeroStack = structuredClone(source.stacks[0]!);
      const negativeZeroAnchor = negativeZeroPath.anchors?.find((candidate) =>
        candidate.basisKind === "post-crop-source-pixel-centres"
          && candidate.responsiveSlotComposition);
      assert.ok(
        negativeZeroAnchor?.basisKind === "post-crop-source-pixel-centres"
          && negativeZeroAnchor.responsiveSlotComposition,
      );
      const negativeZeroSlot = negativeZeroAnchor.responsiveSlotComposition;
      (negativeZeroSlot.sourceToSlotQ16 as { b: string }).b = "-0";
      (negativeZeroSlot.sourceToCompositionQ16 as { b: string }).b = "-0";
      (negativeZeroCamera.geometry.sourceToDeliveryQ16 as { b: string }).b =
        "-0";
      (
        negativeZeroSlot as unknown as {
          sourceToSlotAffineIdentity: string;
        }
      ).sourceToSlotAffineIdentity = hash({
        algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
        coordinateSpace: "responsive-slot",
        cameraNodeId: negativeZeroCamera.cameraNodeId,
        basisSemanticIdentity: negativeZeroAnchor.basisSemanticIdentity,
        outputContextIdentity:
          negativeZeroCamera.outputContext.semanticIdentity,
        sourceToSlotQ16: negativeZeroSlot.sourceToSlotQ16,
      });
      (
        negativeZeroSlot as unknown as {
          placementPlanIdentity: string;
        }
      ).placementPlanIdentity = hash({
        algorithmVersion:
          referenceMediaCamera2DResponsiveSlotAnchorAlgorithmVersion,
        pixelPlacementAlgorithmVersion:
          referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion,
        compositionId: composition.id,
        stackNodeId: negativeZeroSlot.stackNodeId,
        slotNodeId: negativeZeroSlot.slotNodeId,
        index: negativeZeroSlot.index,
        compilerContextIdentity: negativeZeroSlot.compilerContextIdentity,
        outputContextIdentity: negativeZeroSlot.outputContextIdentity,
        responsivePlanIdentity: negativeZeroSlot.responsivePlanIdentity,
        sourceToSlotQ16: negativeZeroSlot.sourceToSlotQ16,
        sourceToSlotAffineIdentity:
          negativeZeroSlot.sourceToSlotAffineIdentity,
        slotBasis: negativeZeroSlot.slotBasis,
        slotToCompositionQ16: negativeZeroSlot.slotToCompositionQ16,
        compositionBasis: negativeZeroSlot.compositionBasis,
        rasterSlot: negativeZeroSlot.rasterSlot,
        clip: negativeZeroSlot.clip,
      });
      (
        negativeZeroAnchor as unknown as {
          affineIdentity: string;
        }
      ).affineIdentity = hash({
        algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
        cameraNodeId: negativeZeroCamera.cameraNodeId,
        basisSemanticIdentity: negativeZeroAnchor.basisSemanticIdentity,
        sourceToDeliveryQ16: negativeZeroSlot.sourceToCompositionQ16,
        coordinateSpace: "responsive-slot-composition",
        responsiveSlotPlacementPlanIdentity:
          negativeZeroSlot.placementPlanIdentity,
      });
      const negativeZeroPathAlgorithm = negativeZeroPath.algorithmVersion
        ?? referenceMediaCamera2DAnchoredPathAlgorithmVersion;
      const negativeZeroSpatialBases = new Map<string, string>();
      for (const anchor of negativeZeroPath.anchors ?? []) {
        negativeZeroSpatialBases.set(anchor.ownerNodeId, anchor.affineIdentity);
      }
      const negativeZeroGeometryIdentity = hash({
        algorithm: negativeZeroPathAlgorithm,
        geometrySemanticIdentity: negativeZeroPath.authoredGeometryIdentity,
        spatialBases: [...negativeZeroSpatialBases]
          .map(([ownerNodeId, affineIdentity]) =>
            ({ ownerNodeId, affineIdentity }))
          .sort((left, right) =>
            left.ownerNodeId.localeCompare(right.ownerNodeId)),
        geometry: negativeZeroPath.geometry,
      });
      (
        negativeZeroPath as unknown as {
          geometryIdentity: string;
          executionIdentity: string;
          evidenceIdentity: string;
        }
      ).geometryIdentity = negativeZeroGeometryIdentity;
      (
        negativeZeroPath as unknown as {
          executionIdentity: string;
        }
      ).executionIdentity = hash({
        algorithm: negativeZeroPathAlgorithm,
        status: "resolved",
        geometryIdentity: negativeZeroGeometryIdentity,
        exactTime:
          `${negativeZeroPath.exactTime.numerator}/${negativeZeroPath.exactTime.denominator}`,
      });
      const negativeZeroPathBody = Object.fromEntries(
        Object.entries(negativeZeroPath).filter(([key]) =>
          key !== "evidenceIdentity"),
      );
      (
        negativeZeroPath as unknown as {
          evidenceIdentity: string;
        }
      ).evidenceIdentity = hash(negativeZeroPathBody);
      const negativeZeroCameraBody = Object.fromEntries(
        Object.entries(negativeZeroCamera).filter(([key]) =>
          key !== "executionIdentity"),
      );
      (
        negativeZeroCamera as unknown as {
          executionIdentity: string;
        }
      ).executionIdentity = hash(negativeZeroCameraBody);
      const negativeZeroMedia =
        negativeZeroStack.slots[0]?.mediaCamera2D;
      assert.ok(negativeZeroMedia);
      (
        negativeZeroMedia as unknown as {
          cameraExecutionIdentity: string;
        }
      ).cameraExecutionIdentity = negativeZeroCamera.executionIdentity;
      const negativeZeroMediaBody = Object.fromEntries(
        Object.entries(negativeZeroMedia).filter(([key]) =>
          key !== "semanticIdentity"),
      );
      (
        negativeZeroMedia as unknown as {
          semanticIdentity: string;
        }
      ).semanticIdentity = hash(negativeZeroMediaBody);
      const negativeZeroStackBody = Object.fromEntries(
        Object.entries(negativeZeroStack).filter(([key]) =>
          key !== "executionIdentity"),
      );
      (
        negativeZeroStack as unknown as {
          executionIdentity: string;
        }
      ).executionIdentity = hash(negativeZeroStackBody);
      assert.throws(
        () => bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          composition.id,
          [negativeZeroPath],
          [],
          [negativeZeroCamera],
          [negativeZeroStack],
        ),
        /non-canonical Q16 integer/u,
      );

      const forgedPath = structuredClone(source.paths);
      (forgedPath[0] as unknown as { executionIdentity: string }).executionIdentity =
        "0".repeat(64);
      assert.throws(() => validate({ paths: forgedPath }), /anchored receipt/u);

      const forgedCallout = structuredClone(source.callouts);
      (forgedCallout[0] as unknown as { executionIdentity: string }).executionIdentity =
        "0".repeat(64);
      assert.throws(() => validate({ callouts: forgedCallout }), /CUT_CALLOUT_EVIDENCE/u);

      const shortenedCalloutOrder = structuredClone(source.callouts);
      const calloutReceipt = shortenedCalloutOrder[0]!;
      const decision = calloutReceipt.decisions[0]!;
      (decision as unknown as { sourceOrder: number[] }).sourceOrder = [
        decision.sourceOrder[0]!,
        decision.sourceOrder[2]!,
      ];
      (calloutReceipt as unknown as { decisionIdentity: string }).decisionIdentity =
        referenceCalloutDecisionIdentity(
          calloutReceipt.layerSemanticIdentity,
          calloutReceipt.sceneLocalTime,
          calloutReceipt.decisions,
        );
      const calloutBody = Object.fromEntries(
        Object.entries(calloutReceipt).filter(([key]) =>
          key !== "executionIdentity"),
      ) as Omit<typeof calloutReceipt, "executionIdentity">;
      (calloutReceipt as unknown as { executionIdentity: string }).executionIdentity =
        referenceCalloutExecutionIdentity(calloutBody);
      assert.throws(
        () => validateReferenceCalloutFrameEvidenceSemantics(calloutReceipt),
        /identityComponentFragment.*three-segment/u,
      );

      const forgedCamera = structuredClone(source.cameras);
      (forgedCamera[0] as unknown as { executionIdentity: string }).executionIdentity =
        "0".repeat(64);
      assert.throws(() => validate({ cameras: forgedCamera }), /camera receipt/u);

      const forgedStack = structuredClone(source.stacks);
      (forgedStack[0] as unknown as { executionIdentity: string }).executionIdentity =
        "0".repeat(64);
      assert.throws(() => validate({ stacks: forgedStack }), /ResponsiveStack receipt/u);

      const forgedLink = structuredClone(source.links);
      (forgedLink[0] as unknown as { linkIdentity: string }).linkIdentity =
        "0".repeat(64);
      assert.throws(() => validate({ links: forgedLink }), /serialized link ledger/u);

      const oversized = structuredClone(source.paths);
      const anchor = oversized[0]?.anchors?.find((candidate) =>
        candidate.basisKind === "post-crop-source-pixel-centres"
          && candidate.responsiveSlotComposition);
      assert.ok(
        anchor?.basisKind === "post-crop-source-pixel-centres"
          && anchor.responsiveSlotComposition,
      );
      (anchor.responsiveSlotComposition.sourceToSlotQ16 as { tx: string }).tx =
        "9".repeat(100_000);
      const oversizedReceipt = oversized[0]!;
      const oversizedBody = Object.fromEntries(
        Object.entries(oversizedReceipt).filter(([key]) =>
          key !== "evidenceIdentity"),
      ) as Omit<typeof oversizedReceipt, "evidenceIdentity">;
      (oversizedReceipt as unknown as { evidenceIdentity: string }).evidenceIdentity =
        hash(oversizedBody);
      assert.throws(
        () => validate({ paths: oversized }),
        /non-canonical Q16 integer/u,
      );
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two valid invocations remain distinct while fully rehashed descendant transplants are refused", async () => {
  const canonical = compile(program("AnnotatedShot(still); AnnotatedShot(still);"));
  const configs = identityConfigs(canonical);
  assert.equal(configs.size, 2);
  const ordered = [...configs.values()].sort(
    (left, right) => left.rootSourceOrder - right.rootSourceOrder,
  );
  assert.notEqual(ordered[0]?.semanticIdentity, ordered[1]?.semanticIdentity);

  const definitionForgery = rehashedClone(canonical, (hostile) => {
    const fragment = nodes(hostile, "cut.kernel.fragment")
      .sort((left, right) =>
        left.provenance.span.start.offset - right.provenance.span.start.offset)[0]!;
    const pending = [fragment.id], seen = new Set<string>();
    while (pending.length) {
      const node = hostile.nodes[pending.pop()!];
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      if (node.provenance.expandedFrom?.length === 2) {
        node.provenance.expandedFrom[0]!.symbol =
          "ForgedButWellFormed:definition";
      }
      pending.push(...node.children);
    }
  });
  assert.throws(
    () => identityConfigs(definitionForgery),
    /CUT_IDENTITY_FRAGMENT_GRAPH.*matching component definition\/invocation provenance/u,
  );

  const cameraTransplant = rehashedClone(canonical, (hostile) => {
    const current = identityConfigs(hostile);
    const [left, right] = [...current.values()].sort(
      (a, b) => a.rootSourceOrder - b.rootSourceOrder,
    );
    const leftSlot = hostile.nodes[left!.slotNodeId]!;
    const rightSlot = hostile.nodes[right!.slotNodeId]!;
    [leftSlot.children[0], rightSlot.children[0]] =
      [rightSlot.children[0]!, leftSlot.children[0]!];
  });
  assert.throws(
    () => identityConfigs(cameraTransplant),
    /CUT_IDENTITY_FRAGMENT_GRAPH.*authenticated by the same component/u,
  );

  const localSpaceTransplant = rehashedClone(canonical, (hostile) => {
    const fragments = nodes(hostile, "cut.kernel.fragment")
      .sort((left, right) =>
        left.provenance.span.start.offset - right.provenance.span.start.offset);
    const callout = (fragment: IRNode) => {
      const layer = fragment.children
        .map((id) => hostile.nodes[id]!)
        .find((node) => node.op === "cut.visual.callout_layer")!;
      return hostile.nodes[layer.children[0]!]!;
    };
    const left = callout(fragments[0]!);
    const right = callout(fragments[1]!);
    [left.children[0], right.children[0]] = [right.children[0]!, left.children[0]!];
  });
  assert.throws(
    () => identityConfigs(localSpaceTransplant),
    /CUT_IDENTITY_FRAGMENT_GRAPH.*same component definition\/invocation expansion/u,
  );
});
