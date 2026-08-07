import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { hash } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { parseStrictPackageJson } from "../lib/package/json";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import { ReferenceLocalSpaceError } from "../lib/runtime/reference/local-space";
import {
  ReferencePlanarTrackFrameEvidenceError,
  type ReferencePlanarTrackFrameEvidence,
  validateReferencePlanarTrackFrameEvidenceSemantics,
} from "../lib/runtime/reference/planar-track-evidence";
import { ReferencePlanarTrackError, referencePlanarTrackLimits } from "../lib/runtime/reference/planar-tracking";
import { placeReferenceProjectiveWarpOnCanvas } from "../lib/runtime/reference/projective-warp-canvas";
import type { ReferenceProjectiveWarpResult } from "../lib/runtime/reference/projective-warp-kernel";

const q = (numerator: number | string, denominator: number | string = 1) => ({ numerator: String(numerator), denominator: String(denominator) });
const corners = (left: number, top: number, right: number, bottom: number) => ({
  topLeft: { x: q(left), y: q(top) },
  topRight: { x: q(right), y: q(top) },
  bottomRight: { x: q(right), y: q(bottom) },
  bottomLeft: { x: q(left), y: q(bottom) },
});

const program = `cut 0.4;
project "public animated planar evidence";
import { LocalSpace, PlanarTrack, Rect } from "cut:visual";
import { linear } from "@cut/motion";
asset tracking: DataAsset = data("assets/exhibit.planar-track.json");
timeline main(duration: 1s, fps: 4, width: 64px, height: 48px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    PlanarTrack(
      source: tracking,
      minConfidence: 75%,
      lowConfidence: "fail",
      occluded: "fail",
      outOfFrame: "hide",
      interpolation: "linear",
      opacity: 100%
    ) as tracked {
      LocalSpace(width: 8px, height: 4px, origin: { x: 0px, y: 0px }) {
        Rect(width: 8px, height: 4px, x: 4px, y: 2px, fill: #ff2000);
      }
    }
    animate tracked.opacity from 0% to 100% over 1s ease linear;
  }
}
export out = render(main, width: 64px, height: 48px, codec: "h264");`;

const sidecar = {
  format: "cut-planar-track",
  version: 1,
  coordinateSpace: "composition-pixel-edges",
  width: 64,
  height: 48,
  samples: [
    { at: q(0), confidence: q(1), status: "visible", corners: corners(10, 10, 26, 18) },
    { at: q(3, 4), confidence: q(1), status: "occluded", corners: corners(20, 14, 40, 24) },
    { at: q(1), confidence: q(1), status: "visible", corners: corners(28, 18, 52, 32) },
  ],
};

function compile() {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function rgbaSha256(surface: { data: Uint8Array }) {
  return createHash("sha256").update(surface.data).digest("hex");
}

function resignReceipt<T extends { executionIdentity: string }>(receipt: T) {
  const payload: Partial<T> = { ...receipt };
  delete payload.executionIdentity;
  receipt.executionIdentity = hash(payload);
  return receipt;
}

test("projective canvas copy reports only actual nonzero-alpha writes", () => {
  const warp: ReferenceProjectiveWarpResult = Object.freeze({
    surface: Object.freeze({
      data: Uint8Array.from([255, 0, 0, 0, 10, 20, 30, 255]),
      width: 2,
      height: 1,
      originX: 1,
      originY: 1,
      alphaMode: "straight" as const,
    }),
    observedWork: Object.freeze({ destinationPixelsTested: 2, insideQuadPixels: 2, integerSamplesCopied: 2, bilinearSamplesEvaluated: 0, sourceTapsRead: 2 }),
  });
  const result = placeReferenceProjectiveWarpOnCanvas(warp, 4, 3, 0.5);
  assert.deepEqual(result.copy, {
    sourceOriginX: 1, sourceOriginY: 1,
    clippedLeft: 1, clippedTop: 1, clippedRight: 3, clippedBottom: 2,
    coveredPixels: 2, copiedPixels: 1, copiedRgbaBytes: 4, opacityScaledPixels: 1,
  });
  assert.deepEqual([...result.surface.data.subarray((1 * 4 + 1) * 4, (1 * 4 + 3) * 4)], [0, 0, 0, 0, 10, 20, 30, 128]);
});

test("public PlanarTrack renders projective pixels, samples animated opacity, publishes closed receipts, and never publishes failed partial work", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-track-render-"));
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/exhibit.planar-track.json"), JSON.stringify(sidecar));
    const ir = compile(), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir, "out");
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/planar-render-cache"));
    await renderer.prepare();
    try {
      const scene = ir.scenes[composition.sceneIds[0]];
      const zero = await renderer.sceneFrame(scene, 0, false), zeroReceipts = renderer.referencePlanarTrackEvidence();
      const zeroContexts = renderer.referencePlanarTrackEvidenceTrustedContexts();
      assert.equal(zero.data.some((value) => value !== 0), false);
      assert.equal(zeroReceipts.length, 1);
      assert.equal(zeroReceipts[0]?.status, "skipped");
      if (zeroReceipts[0]?.status === "skipped") {
        assert.deepEqual(zeroReceipts[0].sample.opacity, q(0));
        assert.deepEqual(zeroReceipts[0].skip, { classification: "owner-opacity", reason: "opacity-zero" });
        assert.deepEqual(zeroReceipts[0].work, { projectivePlans: 0, destinationPixels: 0, destinationRgbaBytes: 0 });
      }
      const zeroLocal = renderer.referenceLocalSpaceEvidence();
      assert.ok(zeroLocal);
      assert.deepEqual({ tiles: zeroLocal.counters.tileRequests, placements: zeroLocal.counters.placementRequests, transforms: zeroLocal.counters.transformExecutions }, { tiles: 0, placements: 0, transforms: 0 });

      const half = await renderer.sceneFrame(scene, 2, false), renderedReceipts = renderer.referencePlanarTrackEvidence();
      const renderedContexts = renderer.referencePlanarTrackEvidenceTrustedContexts();
      assert.equal(renderedReceipts.length, 1);
      const rendered = renderedReceipts[0];
      assert.equal(rendered?.status, "rendered");
      if (!rendered || rendered.status !== "rendered") return;
      assert.equal(zeroContexts.length, 1);
      assert.equal(renderedContexts.length, 1);
      const expected = (trustedContext: typeof renderedContexts[number], outputFrame: string) => ({
        trustedContext,
        outputWidth: 64,
        outputHeight: 48,
        minimumExactTime: q(0),
        maximumExactTime: q(1),
        outputFrame,
      });
      const renderedExpected = expected(renderedContexts[0]!, "2");
      const zeroExpected = expected(zeroContexts[0]!, "0");
      assert.deepEqual(rendered.sample.opacity, q(1, 2), "public property automation, not static input opacity, must drive the owner");
      assert.equal(rendered.output.rgbaSha256, rgbaSha256(half));
      assert.equal(rendered.tile.width, 8);
      assert.equal(rendered.tile.height, 4);
      assert.equal(rendered.work.projectivePlans, 1);
      assert.ok(rendered.projective.observed.insideQuadPixels > 0);
      assert.equal(rendered.canvasCopy.opacityScaledPixels, rendered.canvasCopy.copiedPixels);
      const inside = (12 * half.width + 12) * 4;
      assert.ok(half.data[inside] > 200 && half.data[inside + 3] >= 126 && half.data[inside + 3] <= 129, `expected half-opacity warped red at 12,12, observed ${[...half.data.subarray(inside, inside + 4)]}`);
      const halfLocal = renderer.referenceLocalSpaceEvidence();
      assert.ok(halfLocal);
      assert.equal(halfLocal.placements.length, 0, "PlanarTrack must not synthesize an affine LocalSpace placement");
      assert.deepEqual({ tiles: halfLocal.counters.tileRequests, placements: halfLocal.counters.placementRequests, transforms: halfLocal.counters.transformExecutions }, { tiles: 1, placements: 0, transforms: 1 });

      const frameSchema = parseStrictPackageJson(await readFile("schemas/cut-reference-frame-v2.schema.json")) as { definitions: Record<string, unknown> };
      const receiptSchema = { ...(frameSchema.definitions.planarTrackFrameEvidence as object), definitions: frameSchema.definitions };
      const validateReceipt = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(receiptSchema);
      assert.equal(validateReceipt(rendered), true, JSON.stringify(validateReceipt.errors));
      assert.equal(validateReceipt(zeroReceipts[0]), true, JSON.stringify(validateReceipt.errors));
      assert.equal(validateReferencePlanarTrackFrameEvidenceSemantics(rendered, renderedExpected), rendered);
      assert.equal(validateReferencePlanarTrackFrameEvidenceSemantics(zeroReceipts[0], zeroExpected), zeroReceipts[0]);
      assert.throws(
        () => validateReferencePlanarTrackFrameEvidenceSemantics(rendered),
        (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError
          && error.path === "$.trustedContext"
          && /receipt self-identity is not an authenticity boundary/u.test(error.message),
        "receipt validation must fail closed without independently retained live locked-render authority",
      );
      const outOfRangeRendered = JSON.parse(JSON.stringify(rendered)) as { sample: { opacity: { numerator: string; denominator: string } } };
      outOfRangeRendered.sample.opacity = q(2);
      assert.equal(validateReceipt(outOfRangeRendered), true, "the structural schema deliberately delegates rational ordering to the semantic verifier");
      assert.throws(
        () => validateReferencePlanarTrackFrameEvidenceSemantics(outOfRangeRendered, renderedExpected),
        (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError
          && error.code === "CUT_PLANAR_TRACK_EVIDENCE"
          && error.path === "$.sample.opacity"
          && /outside its declared exact range/u.test(error.message),
      );
      const noncanonicalRendered = JSON.parse(JSON.stringify(rendered)) as { sample: { opacity: { numerator: string; denominator: string } } };
      noncanonicalRendered.sample.opacity = q(2, 2);
      assert.equal(validateReceipt(noncanonicalRendered), true, "the structural schema deliberately delegates lowest terms to the semantic verifier");
      assert.throws(
        () => validateReferencePlanarTrackFrameEvidenceSemantics(noncanonicalRendered, renderedExpected),
        (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError
          && error.path === "$.sample.opacity"
          && /lowest terms/u.test(error.message),
      );
      const impossibleResolution = JSON.parse(JSON.stringify(rendered)) as {
        sample: { resolution: { classification: string; selectedSampleIndex?: number } };
      };
      impossibleResolution.sample.resolution.classification = "linear-visible";
      impossibleResolution.sample.resolution.selectedSampleIndex = 0;
      assert.equal(validateReceipt(impossibleResolution), false, "linear-visible cannot carry a held/exact selected sample field");
      const noncanonicalQ16 = JSON.parse(JSON.stringify(rendered)) as { quadQ16: Array<{ x: string; y: string }> };
      noncanonicalQ16.quadQ16[0]!.x = "00";
      assert.equal(validateReceipt(noncanonicalQ16), false, "Q16 evidence rejects leading-zero and negative-zero identities");
      const impossibleSkip = JSON.parse(JSON.stringify(zeroReceipts[0])) as { skip: { classification: string; reason: string } };
      impossibleSkip.skip.reason = "occluded";
      assert.equal(validateReceipt(impossibleSkip), false, "owner-opacity can only report opacity-zero");
      const nonzeroOwnerSkip = JSON.parse(JSON.stringify(zeroReceipts[0])) as { sample: { opacity: { numerator: string; denominator: string } } };
      nonzeroOwnerSkip.sample.opacity = q(1, 2);
      assert.equal(validateReceipt(nonzeroOwnerSkip), false, "owner-opacity skips require exact canonical zero opacity");
      assert.throws(
        () => validateReferencePlanarTrackFrameEvidenceSemantics(nonzeroOwnerSkip, zeroExpected),
        (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError && /owner-opacity skip/u.test(error.message),
      );
      const zeroRendered = JSON.parse(JSON.stringify(rendered)) as { sample: { opacity: { numerator: string; denominator: string } } };
      zeroRendered.sample.opacity = q(0);
      assert.equal(validateReceipt(zeroRendered), false, "a rendered projective receipt cannot claim zero owner opacity");
      assert.throws(
        () => validateReferencePlanarTrackFrameEvidenceSemantics(zeroRendered, renderedExpected),
        (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError && /greater than zero/u.test(error.message),
      );
      const trackingHiddenAtZero = JSON.parse(JSON.stringify(zeroReceipts[0])) as {
        skip: { classification: string; reason: string };
        sample: { resolution: Record<string, unknown> };
      };
      trackingHiddenAtZero.skip = { classification: "tracking-policy-hidden", reason: "out-of-frame" };
      trackingHiddenAtZero.sample.resolution = {
        classification: "policy-hidden", status: "out-of-frame",
        leftSampleIndex: 0, rightSampleIndex: 0, progress: q(0), leftConfidence: q(1), rightConfidence: q(1),
        policy: { reason: "out-of-frame", action: "hide", observationSampleIndex: 0 },
      };
      resignReceipt(trackingHiddenAtZero as typeof trackingHiddenAtZero & { executionIdentity: string });
      assert.equal(validateReceipt(trackingHiddenAtZero), true, JSON.stringify(validateReceipt.errors));
      const trackingHiddenExpected = expected({
        authority: "locked-ir-and-live-frame-execution",
        expected: structuredClone(trackingHiddenAtZero) as typeof zeroContexts[number]["expected"],
      }, "0");
      assert.equal(validateReferencePlanarTrackFrameEvidenceSemantics(trackingHiddenAtZero, trackingHiddenExpected), trackingHiddenAtZero,
        "tracking-policy-hidden evidence may honestly retain exact zero opacity");

      const semanticReject = (candidate: unknown, path: string, message?: string) => assert.throws(
        () => validateReferencePlanarTrackFrameEvidenceSemantics(candidate, renderedExpected),
        (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError && error.path === path,
        message,
      );
      const impossibleTile = JSON.parse(JSON.stringify(rendered)) as { tile: { width: number }; executionIdentity: string };
      impossibleTile.tile.width = 20_000;
      assert.equal(validateReceipt(impossibleTile), false, "receipt schema uses the public LocalSpace axis ceiling");
      semanticReject(resignReceipt(impossibleTile), "$.tile.width");
      const impossibleOutput = JSON.parse(JSON.stringify(rendered)) as { output: { width: number }; executionIdentity: string };
      impossibleOutput.output.width = 4_097;
      assert.equal(validateReceipt(impossibleOutput), false, "receipt schema uses the public composition axis ceiling");
      semanticReject(resignReceipt(impossibleOutput), "$.output.width");
      const impossibleBounds = JSON.parse(JSON.stringify(rendered)) as { destinationBounds: { left: number }; executionIdentity: string };
      impossibleBounds.destinationBounds.left = -1;
      assert.equal(validateReceipt(impossibleBounds), false, "Planar destination bounds are composition-clipped in public evidence");
      semanticReject(resignReceipt(impossibleBounds), "$.destinationBounds.left");
      const inconsistentWork = JSON.parse(JSON.stringify(rendered)) as { work: { destinationRgbaBytes: number }; executionIdentity: string };
      inconsistentWork.work.destinationRgbaBytes = 4;
      assert.equal(validateReceipt(inconsistentWork), true, JSON.stringify(validateReceipt.errors));
      semanticReject(resignReceipt(inconsistentWork), "$.work");
      const inconsistentCopy = JSON.parse(JSON.stringify(rendered)) as { canvasCopy: { copiedRgbaBytes: number; copiedPixels: number }; executionIdentity: string };
      inconsistentCopy.canvasCopy.copiedRgbaBytes = inconsistentCopy.canvasCopy.copiedPixels > 1 ? 4 : 8;
      assert.equal(validateReceipt(inconsistentCopy), true, JSON.stringify(validateReceipt.errors));
      semanticReject(resignReceipt(inconsistentCopy), "$.canvasCopy");
      const noncanonicalTime = JSON.parse(JSON.stringify(rendered)) as { exactTime: { numerator: string }; executionIdentity: string };
      noncanonicalTime.exactTime.numerator = "02";
      assert.equal(validateReceipt(noncanonicalTime), true, JSON.stringify(validateReceipt.errors));
      semanticReject(resignReceipt(noncanonicalTime), "$.exactTime");
      const excessiveConfidence = JSON.parse(JSON.stringify(rendered)) as { sample: { resolution: { leftConfidence: { numerator: string; denominator: string } } }; executionIdentity: string };
      excessiveConfidence.sample.resolution.leftConfidence = q(2);
      assert.equal(validateReceipt(excessiveConfidence), true, JSON.stringify(validateReceipt.errors));
      semanticReject(resignReceipt(excessiveConfidence), "$.sample.resolution.leftConfidence");
      const forgedExecutionIdentity = JSON.parse(JSON.stringify(rendered)) as { executionIdentity: string };
      forgedExecutionIdentity.executionIdentity = "0".repeat(64);
      assert.equal(validateReceipt(forgedExecutionIdentity), true, JSON.stringify(validateReceipt.errors));
      semanticReject(forgedExecutionIdentity, "$.executionIdentity");
      const staleOutputHash = JSON.parse(JSON.stringify(rendered)) as { output: { rgbaSha256: string }; executionIdentity: string };
      staleOutputHash.output.rgbaSha256 = "0".repeat(64);
      assert.equal(validateReceipt(staleOutputHash), true, JSON.stringify(validateReceipt.errors));
      semanticReject(resignReceipt(staleOutputHash), "$.output.rgbaSha256");

      type RenderedReceipt = Extract<ReferencePlanarTrackFrameEvidence, { status: "rendered" }>;
      const coherentlyResignedForgeries: Array<readonly [string, (receipt: RenderedReceipt) => RenderedReceipt, string]> = [
        ["local tile RGBA", (receipt) => ({ ...receipt, tile: { ...receipt.tile, rgbaSha256: "0".repeat(64) } }), "$.tile.rgbaSha256"],
        ["tight projective RGBA", (receipt) => ({ ...receipt, projective: { ...receipt.projective, tightSurface: { ...receipt.projective.tightSurface, rgbaSha256: "1".repeat(64) } } }), "$.projective.tightSurface.rgbaSha256"],
        ["locked source SHA", (receipt) => ({ ...receipt, source: { ...receipt.source, sha256: "2".repeat(64) } }), "$.source.sha256"],
        ["locked resource identity", (receipt) => ({ ...receipt, source: { ...receipt.source, resourceIdentity: "3".repeat(64) } }), "$.source.resourceIdentity"],
        ["prepared track identity", (receipt) => ({ ...receipt, source: { ...receipt.source, preparationIdentity: "4".repeat(64) } }), "$.source.preparationIdentity"],
        ["sample identity", (receipt) => ({ ...receipt, sample: { ...receipt.sample, sampleIdentity: "5".repeat(64) } }), "$.sample.sampleIdentity"],
        ["backend identity", (receipt) => ({ ...receipt, backendIdentity: "forged-backend" }), "$.backendIdentity"],
        ["owner node identity", (receipt) => ({ ...receipt, nodeId: "node_0000000000000000" }), "$.nodeId"],
        ["LocalSpace node identity", (receipt) => ({ ...receipt, localSpaceNodeId: "node_1111111111111111" }), "$.localSpaceNodeId"],
        ["composition identity", (receipt) => ({ ...receipt, compositionId: "forged-composition" }), "$.compositionId"],
      ];
      for (const [label, mutate, path] of coherentlyResignedForgeries) {
        const forged = mutate(structuredClone(rendered));
        semanticReject(resignReceipt(forged), path, `coherently re-signed ${label} forgery must fail against trusted live execution`);
      }

      const wrongTrustedSource = {
        ...renderedExpected,
        trustedContext: {
          ...renderedExpected.trustedContext,
          expected: {
            ...renderedExpected.trustedContext.expected,
            source: { ...renderedExpected.trustedContext.expected.source, sha256: "6".repeat(64) },
          },
        },
      };
      assert.throws(
        () => validateReferencePlanarTrackFrameEvidenceSemantics(rendered, wrongTrustedSource),
        (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError && error.path === "$.source.sha256",
        "a caller-supplied context for the wrong locked source must fail closed",
      );
      const wrongTrustedFrame = { ...renderedExpected, outputFrame: "1" };
      assert.throws(
        () => validateReferencePlanarTrackFrameEvidenceSemantics(rendered, wrongTrustedFrame),
        (error: unknown) => error instanceof ReferencePlanarTrackFrameEvidenceError && error.path === "$.outputFrame",
        "a caller-supplied context for another completed frame must fail closed",
      );
      assert.equal(JSON.stringify(rendered).includes(root), false, "public execution evidence must not expose a private absolute path");

      const completedBeforeFailure = renderer.referencePlanarTrackEvidence();
      await assert.rejects(renderer.sceneFrame(scene, 3, false), (error: unknown) => error instanceof ReferencePlanarTrackError
        && error.code === "CUT_PLANAR_TRACK_SAMPLE" && error.source.line > 0);
      assert.deepEqual(renderer.referencePlanarTrackEvidence(), completedBeforeFailure, "a failed frame must not replace the last completed evidence with partial work");
    } finally {
      await renderer.closeAndWait();
    }

    const artifactPath = resolve(root, "review/planar.png");
    const artifactIr = compile(), artifactLock = await createCutLock(artifactIr, root);
    await applyCutLock(artifactIr, artifactLock, root);
    const artifact = await renderReferenceFrameArtifact(artifactIr, root, artifactPath, { frame: 2, mediaProfile: "master" });
    assert.equal(artifact.execution.planarTracks.length, 1);
    assert.equal(artifact.execution.localSpaces.length, 1);
    assert.equal(artifact.execution.planarTracks[0]?.status, "rendered");
    const persistedArtifact = JSON.parse(await readFile(`${artifactPath}.manifest.json`, "utf8"));
    const sharpModule = await import("sharp"), sharp = sharpModule.default ?? sharpModule;
    const decoded = await sharp(artifactPath).ensureAlpha().raw().toBuffer();
    assert.equal(createHash("sha256").update(decoded).digest("hex"), artifact.artifact.rgbaSha256,
      "the persisted lossless frame must decode to the exact trusted completed-frame RGBA hash");
    assert.equal(JSON.stringify(persistedArtifact).includes("locked-ir-and-live-frame-execution"), false,
      "live trusted context must not be serialized beside the receipt it authenticates");
    const completeFrameSchema = JSON.parse(await readFile("schemas/cut-reference-frame-v2.schema.json", "utf8"));
    const validateArtifact = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(completeFrameSchema);
    assert.equal(validateArtifact(persistedArtifact), true, JSON.stringify(validateArtifact.errors));

    const forged = structuredClone(ir), forgedOwner = Object.values(forged.nodes).find((node) => node.op === "cut.visual.planar_track");
    assert.ok(forgedOwner);
    const opacityProperty = forgedOwner.properties.opacity;
    assert.ok(opacityProperty && "signal" in opacityProperty);
    const forgedSignal = forged.signals[opacityProperty.signal];
    assert.ok(forgedSignal);
    const poison = { kind: "quantity" as const, dimension: "ratio", unit: "ratio", magnitude: { numerator: "2", denominator: "2" } };
    if (forgedSignal.kind === "constant") forgedSignal.value = poison;
    else if (forgedSignal.kind === "step") forgedSignal.points[0]!.value = poison;
    else if (forgedSignal.kind === "keyframes") forgedSignal.keyframes[0]!.value = poison;
    else forgedSignal.initial = poison;
    const forgedRenderer = new ReferenceVisualRenderer(forged, forged.compositions[0], root, resolve(root, ".cut/planar-forged-opacity-cache"));
    try {
      await assert.rejects(forgedRenderer.prepare(), (error: unknown) => error instanceof ReferencePlanarTrackError
        && error.code === "CUT_PLANAR_TRACK_INPUT_TYPE"
        && error.source.nodeId === forgedOwner.id
        && /reduced to canonical lowest terms/u.test(error.message));
      assert.deepEqual(forgedRenderer.referencePlanarTrackEvidence(), []);
    } finally {
      await forgedRenderer.closeAndWait();
    }

    const excessive = structuredClone(ir), excessiveOwner = Object.values(excessive.nodes).find((node) => node.op === "cut.visual.planar_track");
    assert.ok(excessiveOwner);
    const excessiveProperty = excessiveOwner.properties.opacity;
    assert.ok(excessiveProperty && "signal" in excessiveProperty);
    const excessiveSignal = excessive.signals[excessiveProperty.signal];
    assert.ok(excessiveSignal && excessiveSignal.kind === "track" && excessiveSignal.events.length > 0);
    const repeatedEvent = excessiveSignal.events[0]!;
    excessiveSignal.events = Array(referencePlanarTrackLimits.maxOpacitySignalValuesPerComposition).fill(repeatedEvent);
    const excessiveRenderer = new ReferenceVisualRenderer(excessive, excessive.compositions[0], root, resolve(root, ".cut/planar-excessive-opacity-cache"));
    try {
      await assert.rejects(excessiveRenderer.prepare(), (error: unknown) => error instanceof ReferencePlanarTrackError
        && error.code === "CUT_PLANAR_TRACK_LIMIT"
        && error.source.nodeId === excessiveOwner.id
        && error.message.includes(`${referencePlanarTrackLimits.maxOpacitySignalValuesPerComposition} prepared values`));
      assert.deepEqual(excessiveRenderer.referencePlanarTrackEvidence(), []);
    } finally {
      await excessiveRenderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact-frame artifacts preserve distinct MotionBlur shutter receipt times while binding one output frame", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-track-motion-artifact-"));
  const motionProgram = `cut 0.4;
project "planar shutter receipt clock";
import { LocalSpace, MotionBlur, PlanarTrack, Rect } from "cut:visual";
asset tracking: DataAsset = data("assets/motion.planar-track.json");
timeline main(duration: 1s, fps: 4, width: 16px, height: 12px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    MotionBlur(shutterAngle: 180deg, samples: 3) {
      PlanarTrack(source: tracking, minConfidence: 50%, lowConfidence: "fail", occluded: "fail", outOfFrame: "fail") {
        LocalSpace(width: 2px, height: 2px, origin: { x: 0px, y: 0px }) {
          Rect(width: 2px, height: 2px, x: 1px, y: 1px, fill: #ffffff);
        }
      }
    }
  }
}
export out = render(main, width: 16px, height: 12px, codec: "h264");`;
  const motionSidecar = {
    format: "cut-planar-track", version: 1, coordinateSpace: "composition-pixel-edges", width: 16, height: 12,
    samples: [
      { at: q(0), confidence: q(1), status: "visible", corners: corners(4, 3, 8, 7) },
      { at: q(1), confidence: q(1), status: "visible", corners: corners(6, 4, 10, 8) },
    ],
  };
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/motion.planar-track.json"), JSON.stringify(motionSidecar));
    const parsed = parseCutLanguage(motionProgram);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.deepEqual([...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error"), []);
    const ir = compileCutModule(parsed.module).ir, lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const artifact = await renderReferenceFrameArtifact(ir, root, resolve(root, "review/motion.png"), { frame: 2, mediaProfile: "master" });
    assert.equal(artifact.execution.planarTracks.length, 3);
    assert.ok(artifact.execution.planarTracks.every((receipt) => receipt.outputFrame === "2"));
    const shutterTimes = artifact.execution.planarTracks.map((receipt) => `${receipt.exactTime.numerator}/${receipt.exactTime.denominator}`);
    assert.equal(new Set(shutterTimes).size, 3, "each shutter sample retains its distinct composition-absolute execution time");
    assert.ok(shutterTimes.some((time) => time !== "1/2"), "shutter execution time must not be rewritten to the selected frame timestamp");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composition-frame aggregate PlanarTrack work refuses before any LocalSpace tile starts", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-track-budget-"));
  const width = 4096, height = 4096;
  const repeated = Array.from({ length: 5 }, (_, index) => `
    PlanarTrack(
      source: tracking,
      minConfidence: 75%, lowConfidence: "fail", occluded: "fail", outOfFrame: "fail",
      interpolation: "hold", opacity: 100%
    ) as plane${index} {
      LocalSpace(width: 1px, height: 1px, origin: { x: 0px, y: 0px }) {
        Rect(width: 1px, height: 1px, x: 0.5px, y: 0.5px, fill: #ffffff);
      }
    }`).join("\n");
  const budgetProgram = `cut 0.4;
project "planar aggregate refusal";
import { Group, LocalSpace, PlanarTrack, Rect } from "cut:visual";
asset tracking: DataAsset = data("assets/full-frame.planar-track.json");
timeline main(duration: 1s, fps: 1, width: ${width}px, height: ${height}px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Group() {${repeated}
    }
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
  const budgetSidecar = {
    format: "cut-planar-track", version: 1, coordinateSpace: "composition-pixel-edges", width, height,
    samples: [
      { at: q(0), confidence: q(1), status: "visible", corners: corners(0, 0, width, height) },
      { at: q(1), confidence: q(1), status: "visible", corners: corners(0, 0, width, height) },
    ],
  };
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/full-frame.planar-track.json"), JSON.stringify(budgetSidecar));
    const parsed = parseCutLanguage(budgetProgram);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.deepEqual([...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error"), []);
    const ir = compileCutModule(parsed.module).ir, lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir, "out");
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/planar-budget-cache"));
    await renderer.prepare();
    try {
      const instrumented = renderer as unknown as { localSpaceTile: (...arguments_: unknown[]) => unknown };
      const original = instrumented.localSpaceTile.bind(renderer);
      let tileStarts = 0;
      instrumented.localSpaceTile = (...arguments_: unknown[]) => {
        tileStarts += 1;
        return original(...arguments_);
      };
      await assert.rejects(renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false), (error: unknown) => error instanceof ReferencePlanarTrackError
        && error.code === "CUT_PLANAR_TRACK_LIMIT" && /before tile rasterization/u.test(error.message));
      assert.equal(tileStarts, 0, "the whole-scene reservation pass must fail before any sibling begins tile/projective/canvas work");
      assert.deepEqual(renderer.referencePlanarTrackEvidence(), []);
      assert.equal(renderer.referenceLocalSpaceEvidence(), undefined);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested temporal sampling cannot exceed the closed PlanarTrack/LocalSpace receipt cardinality", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-track-execution-budget-"));
  const planeCount = 65;
  const planes = Array.from({ length: planeCount }, (_, index) => `
      PlanarTrack(
        source: tracking,
        minConfidence: 75%, lowConfidence: "fail", occluded: "fail", outOfFrame: "fail",
        interpolation: "hold", opacity: 100%
      ) as plane${index} {
        LocalSpace(width: 1px, height: 1px, origin: { x: 0px, y: 0px }) {
          Rect(width: 1px, height: 1px, x: 0.5px, y: 0.5px, fill: #ffffff);
        }
      }`).join("\n");
  const nestedProgram = `cut 0.4;
project "planar nested temporal admission";
import { Group, LocalSpace, MotionBlur, PlanarTrack, Rect } from "cut:visual";
asset tracking: DataAsset = data("assets/tiny.planar-track.json");
timeline main(duration: 1s, fps: 2, width: 2px, height: 2px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    MotionBlur(shutterAngle: 360deg, samples: 8) {
      MotionBlur(shutterAngle: 359deg, samples: 8) {
        Group() {${planes}
        }
      }
    }
  }
}
export out = render(main, width: 2px, height: 2px, codec: "h264");`;
  const tinySidecar = {
    format: "cut-planar-track", version: 1, coordinateSpace: "composition-pixel-edges", width: 2, height: 2,
    samples: [
      { at: q(0), confidence: q(1), status: "visible", corners: corners(0, 0, 1, 1) },
      { at: q(1), confidence: q(1), status: "visible", corners: corners(0, 0, 1, 1) },
    ],
  };
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/tiny.planar-track.json"), JSON.stringify(tinySidecar));
    const parsed = parseCutLanguage(nestedProgram);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.deepEqual([...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error"), []);
    const ir = compileCutModule(parsed.module).ir, lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir, "out");
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/planar-execution-budget-cache"));
    await renderer.prepare();
    try {
      const instrumented = renderer as unknown as { localSpaceTile: (...arguments_: unknown[]) => unknown };
      const original = instrumented.localSpaceTile.bind(renderer);
      let tileStarts = 0;
      instrumented.localSpaceTile = (...arguments_: unknown[]) => {
        tileStarts += 1;
        return original(...arguments_);
      };
      await assert.rejects(
        renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 1, false),
        (error: unknown) => error instanceof ReferencePlanarTrackError
          && error.code === "CUT_PLANAR_TRACK_LIMIT"
          && error.message.includes(`${referencePlanarTrackLimits.maxExecutionsPerCompositionFrame + 1}`)
          && error.message.includes(`${referencePlanarTrackLimits.maxExecutionsPerCompositionFrame}-execution limit`),
      );
      assert.equal(planeCount * 8 * 8, 4_160, "the regression must remain above the public 4096-receipt bound");
      assert.equal(tileStarts, 0, "nested temporal over-admission must fail during the whole-frame reservation pass");
      assert.deepEqual(renderer.referencePlanarTrackEvidence(), []);
      assert.equal(renderer.referenceLocalSpaceEvidence(), undefined);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Planar and ordinary LocalSpace tiles share one closed frame-receipt budget", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-track-shared-tile-budget-"));
  const planes = Array.from({ length: 64 }, (_, index) => `
      PlanarTrack(
        source: tracking,
        minConfidence: 75%, lowConfidence: "fail", occluded: "fail", outOfFrame: "fail",
        interpolation: "hold", opacity: 100%
      ) as plane${index} {
        LocalSpace(width: 1px, height: 1px, origin: { x: 0px, y: 0px }) {
          Rect(width: 1px, height: 1px, x: 0.5px, y: 0.5px, fill: #ffffff);
        }
      }`).join("\n");
  const source = `cut 0.4;
project "planar shared local tile admission";
import { Group, LocalSpace, MotionBlur, PlanarTrack, Rect } from "cut:visual";
asset tracking: DataAsset = data("assets/tiny.planar-track.json");
timeline main(duration: 1s, fps: 2, width: 2px, height: 2px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    MotionBlur(shutterAngle: 360deg, samples: 8) {
      MotionBlur(shutterAngle: 359deg, samples: 8) {
        Group() {${planes}
        }
      }
    }
    LocalSpace(width: 1px, height: 1px, origin: { x: 0px, y: 0px }) {
      Rect(width: 1px, height: 1px, x: 0.5px, y: 0.5px, fill: #ffffff);
    }
  }
}
export out = render(main, width: 2px, height: 2px, codec: "h264");`;
  const tinySidecar = {
    format: "cut-planar-track", version: 1, coordinateSpace: "composition-pixel-edges", width: 2, height: 2,
    samples: [
      { at: q(0), confidence: q(1), status: "visible", corners: corners(0, 0, 1, 1) },
      { at: q(1), confidence: q(1), status: "visible", corners: corners(0, 0, 1, 1) },
    ],
  };
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/tiny.planar-track.json"), JSON.stringify(tinySidecar));
    const parsed = parseCutLanguage(source);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.deepEqual([...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error"), []);
    const ir = compileCutModule(parsed.module).ir, lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir, "out");
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/planar-shared-tile-budget-cache"));
    await renderer.prepare();
    try {
      const instrumented = renderer as unknown as { localSpaceTile: (...arguments_: unknown[]) => unknown };
      const original = instrumented.localSpaceTile.bind(renderer);
      let tileStarts = 0;
      instrumented.localSpaceTile = (...arguments_: unknown[]) => {
        tileStarts += 1;
        return original(...arguments_);
      };
      await assert.rejects(
        renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 1, false),
        (error: unknown) => error instanceof ReferenceLocalSpaceError
          && error.code === "CUT_LOCAL_SPACE_LIMIT"
          && /4097 LocalSpace tile receipts.*before tile rasterization/u.test(error.message),
      );
      assert.equal(tileStarts, 0, "the combined ordinary/projective LocalSpace receipt budget must fail before any tile starts");
      assert.deepEqual(renderer.referencePlanarTrackEvidence(), []);
      assert.equal(renderer.referenceLocalSpaceEvidence(), undefined);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("temporal PlanarTrack preflight bounds retained source tiles before allocating them", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-track-source-tile-budget-"));
  const planes = Array.from({ length: 2 }, (_, index) => `
      PlanarTrack(
        source: tracking,
        minConfidence: 75%, lowConfidence: "fail", occluded: "fail", outOfFrame: "fail",
        interpolation: "hold", opacity: 100%
      ) as plane${index} {
        LocalSpace(width: 4096px, height: 4096px, origin: { x: 0px, y: 0px }) {
          Rect(width: 1px, height: 1px, x: 0.5px, y: 0.5px, fill: #ffffff);
        }
      }`).join("\n");
  const source = `cut 0.4;
project "planar temporal source tile admission";
import { Group, LocalSpace, MotionBlur, PlanarTrack, Rect } from "cut:visual";
asset tracking: DataAsset = data("assets/tiny.planar-track.json");
timeline main(duration: 1s, fps: 2, width: 2px, height: 2px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    MotionBlur(shutterAngle: 360deg, samples: 8) {
      MotionBlur(shutterAngle: 359deg, samples: 8) {
        Group() {${planes}
        }
      }
    }
  }
}
export out = render(main, width: 2px, height: 2px, codec: "h264");`;
  const tinySidecar = {
    format: "cut-planar-track", version: 1, coordinateSpace: "composition-pixel-edges", width: 2, height: 2,
    samples: [
      { at: q(0), confidence: q(1), status: "visible", corners: corners(0, 0, 1, 1) },
      { at: q(1), confidence: q(1), status: "visible", corners: corners(0, 0, 1, 1) },
    ],
  };
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/tiny.planar-track.json"), JSON.stringify(tinySidecar));
    const parsed = parseCutLanguage(source);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.deepEqual([...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error"), []);
    const ir = compileCutModule(parsed.module).ir, lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir, "out");
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/planar-source-tile-budget-cache"));
    await renderer.prepare();
    try {
      const instrumented = renderer as unknown as { localSpaceTile: (...arguments_: unknown[]) => unknown };
      const original = instrumented.localSpaceTile.bind(renderer);
      let tileStarts = 0;
      instrumented.localSpaceTile = (...arguments_: unknown[]) => {
        tileStarts += 1;
        return original(...arguments_);
      };
      await assert.rejects(
        renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 1, false),
        (error: unknown) => error instanceof ReferencePlanarTrackError
          && error.code === "CUT_PLANAR_TRACK_LIMIT"
          && /temporally sampled source LocalSpace tiles.*before tile rasterization/u.test(error.message),
      );
      assert.equal(tileStarts, 0, "preflight must reject the retained tile amplification without allocating a 4096-square source tile");
      assert.deepEqual(renderer.referencePlanarTrackEvidence(), []);
      assert.equal(renderer.referenceLocalSpaceEvidence(), undefined);
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Precomp fails closed during lowering instead of rendering nested PlanarTrack without top-level execution evidence", () => {
  const nestedSource = `cut 0.4;
project "planar nested evidence boundary";
import { LocalSpace, PlanarTrack, Precomp, Rect } from "cut:visual";
asset tracking: DataAsset = data("assets/nested.planar-track.json");
timeline main(duration: 1s, fps: 2, width: 16px, height: 12px, sampleRate: 8khz) {
  scene host(duration: 1s) { Precomp(source: insert); }
}
timeline insert(duration: 1s, fps: 2, width: 16px, height: 12px, sampleRate: 8khz) {
  scene nested(duration: 1s) {
    PlanarTrack(source: tracking, minConfidence: 50%, lowConfidence: "fail", occluded: "fail", outOfFrame: "fail") {
      LocalSpace(width: 2px, height: 2px, origin: { x: 0px, y: 0px }) {
        Rect(width: 2px, height: 2px, x: 1px, y: 1px, fill: #ffffff);
      }
    }
  }
}
export out = render(main, width: 16px, height: 12px, codec: "h264");`;
  const parsed = parseCutLanguage(nestedSource);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual([...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error"), []);
  const parsedModule = parsed.module;
  assert.throws(
    () => compileCutModule(parsedModule),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT_PRECOMP_INPUT"
        && diagnostic.span.start.line === 6
        && /refuses nested projective execution.*collision-free composition-instance path/u.test(diagnostic.message)),
  );
});

test("PlanarTrack receipt exactTime is composition-absolute while sampling stays node-local", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-track-second-scene-"));
  const secondSceneProgram = `cut 0.4;
project "planar second scene clock";
import { LocalSpace, PlanarTrack, Rect } from "cut:visual";
asset tracking: DataAsset = data("assets/second.planar-track.json");
timeline main(duration: 2s, fps: 1, width: 16px, height: 12px, sampleRate: 8khz) {
  scene first(duration: 1s) { Rect(width: 1px, height: 1px, fill: #000000); }
  scene second(duration: 1s) {
    PlanarTrack(source: tracking, minConfidence: 50%, lowConfidence: "fail", occluded: "fail", outOfFrame: "fail") {
      LocalSpace(width: 2px, height: 2px, origin: { x: 0px, y: 0px }) {
        Rect(width: 2px, height: 2px, x: 1px, y: 1px, fill: #ffffff);
      }
    }
  }
}
export out = render(main, width: 16px, height: 12px, codec: "h264");`;
  const secondSidecar = {
    format: "cut-planar-track", version: 1, coordinateSpace: "composition-pixel-edges", width: 16, height: 12,
    samples: [
      { at: q(0), confidence: q(1), status: "visible", corners: corners(4, 3, 8, 7) },
      { at: q(1), confidence: q(1), status: "visible", corners: corners(4, 3, 8, 7) },
    ],
  };
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/second.planar-track.json"), JSON.stringify(secondSidecar));
    const parsed = parseCutLanguage(secondSceneProgram);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.deepEqual([...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error"), []);
    const ir = compileCutModule(parsed.module).ir, lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir, "out"), renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/second-scene-cache"));
    await renderer.prepare();
    try {
      await renderer.sceneFrame(ir.scenes[composition.sceneIds[1]], 0, false);
      const [receipt] = renderer.referencePlanarTrackEvidence();
      assert.ok(receipt);
      assert.deepEqual(receipt.exactTime, q(1));
      assert.equal(receipt.outputFrame, "1");
      assert.deepEqual(receipt.sample.exactNodeLocalTime, q(0));
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
