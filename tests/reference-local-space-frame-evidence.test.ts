import assert from "node:assert/strict";
import Ajv from "ajv";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import {
  ReferenceLocalSpaceFrameEvidenceError,
  validateCurrentReferenceFrameLocalSpaceExecutionTree,
} from "../lib/runtime/reference/local-space-frame-evidence";
import {
  referenceLocalSpaceRendererFrameExecutionTreeLimits,
  referenceLocalSpaceRendererFrameExecutionTreeWork,
} from "../lib/runtime/reference/visual";

test("renderer-tree pre-scan rejects depth-weighted copy work below the raw-record ceiling", () => {
  const depth = 17;
  const targetRecords = Math.floor(
    referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceCopyUnits / depth,
  ) + 1;
  assert.ok(targetRecords < referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords);

  // The pre-scan only needs the five evidence arrays and execution-path depth.
  // Reusing one inert record keeps this hostile fixture small and proves the
  // copy-unit failure occurs before record hashing or recursive evidence copy.
  const inertRecord = Object.freeze({ hostile: "must-not-be-inspected" });
  const receipt = {
    executionPath: Array.from({ length: depth }, (_, index) => ({ compositionId: `depth-${index}` })),
    execution: {
      tiles: [],
      placements: [],
      skips: Array(targetRecords - 1).fill(inertRecord),
    },
    preflight: {
      admissions: [],
      skips: [],
    },
  } as unknown as Parameters<typeof referenceLocalSpaceRendererFrameExecutionTreeWork>[0][number];
  const copyUnits = targetRecords * depth;

  assert.throws(
    () => referenceLocalSpaceRendererFrameExecutionTreeWork([receipt]),
    (error: unknown) => error instanceof Error
      && error.message === `CUT_LOCAL_SPACE_RASTER: renderer execution tree evidence requires ${copyUnits} depth-weighted copy units; maximum is ${referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceCopyUnits}.`,
  );
});

test("renderer-tree pre-scan counts embedded local-compositing operations before evidence copy", () => {
  const receiptWithOperations = (depth: number, operations: readonly unknown[]) => ({
    executionPath: Array.from({ length: depth }, (_, index) => ({ compositionId: `depth-${index}` })),
    execution: {
      tiles: [{ localCompositing: { operations } }],
      placements: [],
      skips: [],
    },
    preflight: {
      admissions: [],
      skips: [],
    },
  }) as unknown as Parameters<typeof referenceLocalSpaceRendererFrameExecutionTreeWork>[0][number];

  const normalDepth = 4;
  const normalOperation = Object.freeze({ kind: "normal-operation" });
  assert.deepEqual(
    referenceLocalSpaceRendererFrameExecutionTreeWork([
      receiptWithOperations(normalDepth, Array(3).fill(normalOperation)),
    ]),
    { records: 5, copyUnits: 20 },
    "one wrapper, one tile, and three embedded operations must each count at depth four",
  );

  const mustNotBeInspected = Object.freeze(Object.defineProperty({}, "hostile", {
    enumerable: true,
    get: () => {
      throw new Error("embedded operation was inspected before the aggregate bound");
    },
  }));
  const operationCount = referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords - 1;
  const topLevelRecordsIfOperationsWereIgnored = 2;
  assert.ok(topLevelRecordsIfOperationsWereIgnored
    < referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords);
  assert.ok(topLevelRecordsIfOperationsWereIgnored
    < referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceCopyUnits);
  const requiredRecords = topLevelRecordsIfOperationsWereIgnored + operationCount;

  assert.throws(
    () => referenceLocalSpaceRendererFrameExecutionTreeWork([
      receiptWithOperations(1, Array(operationCount).fill(mustNotBeInspected)),
    ]),
    (error: unknown) => error instanceof Error
      && error.message === `CUT_LOCAL_SPACE_RASTER: renderer execution tree evidence requires ${requiredRecords} records; maximum is ${referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords}.`,
    "nested operations must trigger the raw-record ceiling without being hashed or copied",
  );
});

function compile(groupControls = "x: 3px, y: -2px, opacity: 80%") {
  const parsed = parseCutLanguage(`cut 0.4;
project "public LocalSpace frame evidence";
import { Group, LocalSpace, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 40px, height: 40px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Group(${groupControls}) {
      LocalSpace(width: 9px, height: 7px, origin: { x: 4.5px, y: 3.5px }) {
        Rect(width: 3px, height: 3px, fill: #ef233c);
      }
    }
  }
}
export out = render(main, width: 40px, height: 40px, codec: "h264");`);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

test("cut frame publishes closed same-invocation LocalSpace execution work without invalidating frozen v2 receipts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-public-frame-"));
  try {
    const output = resolve(root, "review/frame.png"), ir = compile();
    const first = await renderReferenceFrameArtifact(ir, root, output, { frame: 0, mediaProfile: "master" });
    assert.equal(first.execution.localSpaces.length, 1);
    const preflight = first.execution.localSpaceTransformPreflight;
    assert.equal(preflight.format, "cut-reference-local-space-composition-transform-preflight");
    assert.equal(preflight.outputFrame, "0");
    assert.equal(preflight.status, "admitted");
    assert.equal(preflight.admissions.length, 1);
    assert.equal(preflight.aggregate?.transformCount, 1);
    assert.equal(first.execution.localSpaceExecutions.length, 1);
    assert.equal(first.execution.evidenceProfile, "cut-reference-frame-execution/current-v2");
    assert.equal(first.execution.localSpaceExecutionTree.rendererFrameCount, 1);
    const rendererExecution = first.execution.localSpaceExecutions[0]!;
    assert.deepEqual(rendererExecution.executionPath, [{ compositionId: ir.compositions[0]!.id }]);
    assert.equal(rendererExecution.execution.executionIdentity, first.execution.localSpaces[0]!.executionIdentity);
    assert.equal(rendererExecution.preflight.preflightIdentity, preflight.preflightIdentity);
    const receipt = first.execution.localSpaces[0];
    assert.equal(receipt.format, "cut-reference-local-space-frame-evidence");
    assert.equal(receipt.evidenceKind, "completed-frame-execution");
    assert.equal(receipt.outputFrame, "0");
    assert.equal(receipt.counters.tileRequests, 1);
    assert.equal(receipt.counters.tileRasterizations, 1);
    assert.equal(receipt.counters.placementRequests, 1);
    assert.equal(receipt.counters.placementRasterizations, 1);
    assert.equal(receipt.counters.localNodePixelsRasterized, 9 * 7);
    assert.equal(receipt.counters.localNodeRgbaBytesRasterized, 9 * 7 * 4);
    assert.equal(receipt.tiles.length, 1);
    assert.equal(receipt.placements.length, 1);

    const second = await renderReferenceFrameArtifact(ir, root, output, { frame: 0, mediaProfile: "master" });
    assert.equal(second.execution.localSpaces[0].executionIdentity, receipt.executionIdentity);
    assert.equal(second.artifact.rgbaSha256, first.artifact.rgbaSha256);

    const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
    const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
    const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
    assert.equal(validate(persisted), true, JSON.stringify(validate.errors));
    assert.equal(validateCurrentReferenceFrameLocalSpaceExecutionTree(persisted), persisted);

    const missingCurrentTree = structuredClone(persisted);
    delete missingCurrentTree.execution.localSpaceExecutionTree;
    assert.equal(validate(missingCurrentTree), false, "the current writer profile cannot omit its complete-tree summary");
    const missingCurrentExecutions = structuredClone(persisted);
    delete missingCurrentExecutions.execution.localSpaceExecutions;
    assert.equal(validate(missingCurrentExecutions), false, "the current writer profile cannot omit renderer executions");
    const changedTreeCount = structuredClone(persisted);
    changedTreeCount.execution.localSpaceExecutionTree.rendererFrameCount += 1;
    assert.equal(validate(changedTreeCount), true, JSON.stringify(validate.errors));
    assert.throws(() => validateCurrentReferenceFrameLocalSpaceExecutionTree(changedTreeCount),
      (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
        && /does not close over the complete ordered renderer execution tree/u.test(error.message));
    for (const field of ["executionPathsIdentity", "rendererFramesIdentity", "rendererTreeIdentity"] as const) {
      const changedDigest = structuredClone(persisted);
      changedDigest.execution.localSpaceExecutionTree[field] = "0".repeat(64);
      assert.equal(validate(changedDigest), true, JSON.stringify(validate.errors));
      assert.throws(() => validateCurrentReferenceFrameLocalSpaceExecutionTree(changedDigest),
        (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
          && /does not close over the complete ordered renderer execution tree/u.test(error.message), field);
    }
    const oversizedEvidence = structuredClone(persisted);
    oversizedEvidence.execution.localSpaceExecutions[0].execution.skips = Array(
      referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords,
    ).fill({
      nodeId: "bounded-hostile-skip",
      sampleTime: { numerator: "0", denominator: "1" },
      kind: "local-node-opacity",
      reason: "opacity-zero",
    });
    assert.throws(() => validateCurrentReferenceFrameLocalSpaceExecutionTree(oversizedEvidence),
      (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
        && /maximum is 65536/u.test(error.message),
      "aggregate evidence bound must fail from array lengths before per-record hashing");

    const hostile = structuredClone(persisted);
    hostile.execution.localSpaces[0].counters.silentlyIgnored = 1;
    assert.equal(validate(hostile), false, "LocalSpace receipts must reject unknown nested fields");

    const incomplete = structuredClone(persisted);
    delete incomplete.execution.localSpaces[0].counters.tileRasterizations;
    assert.equal(validate(incomplete), false, "LocalSpace receipts must retain every observed counter");
    for (const counter of [
      "localPaintSurfaceCacheHits",
      "localPaintSurfaceCacheMisses",
      "localPaintSurfaceCacheBypasses",
      "localPaintSurfaceCacheEvictions",
      "localPaintSurfaceCacheResidentBytes",
    ] as const) {
      const missingRootCounter = structuredClone(persisted);
      delete missingRootCounter.execution.localSpaces[0].counters[counter];
      assert.equal(validate(missingRootCounter), false, `current root receipt must retain ${counter}`);
      const missingTreeCounter = structuredClone(persisted);
      delete missingTreeCounter.execution.localSpaceExecutions[0].execution.counters[counter];
      assert.equal(validate(missingTreeCounter), false, `current renderer-tree receipt must retain ${counter}`);
    }
    const missingRootObservation = structuredClone(persisted);
    delete missingRootObservation.execution.localSpaces[0].observationIdentity;
    assert.equal(validate(missingRootObservation), false, "current root receipt must retain cache observation identity");
    const missingTreeObservation = structuredClone(persisted);
    delete missingTreeObservation.execution.localSpaceExecutions[0].execution.observationIdentity;
    assert.equal(validate(missingTreeObservation), false, "current renderer-tree receipt must retain cache observation identity");

    const hostilePreflight = structuredClone(persisted);
    hostilePreflight.execution.localSpaceTransformPreflight.admissions[0].work.silentlyIgnored = true;
    assert.equal(validate(hostilePreflight), false, "affine preflight planning work must reject unknown fields");
    const incompletePreflight = structuredClone(persisted);
    delete incompletePreflight.execution.localSpaceTransformPreflight.admissions[0].work.perTransform;
    assert.equal(validate(incompletePreflight), false, "affine preflight planning work must retain its allocation envelope");
    const hostileRendererTree = structuredClone(persisted);
    hostileRendererTree.execution.localSpaceExecutions[0].silentlyIgnored = true;
    assert.equal(validate(hostileRendererTree), false, "renderer-tree wrappers must remain closed");
    const incompleteRendererTree = structuredClone(persisted);
    delete incompleteRendererTree.execution.localSpaceExecutions[0].preflight;
    assert.equal(validate(incompleteRendererTree), false, "each renderer-tree execution must retain its exact preflight pair");
    const halfPathSegment = structuredClone(persisted);
    halfPathSegment.execution.localSpaceExecutions[0].executionPath[0].instanceNodeId = "forged-instance";
    assert.equal(validate(halfPathSegment), false, "renderer paths cannot publish a partial nested-instance segment");

    const missingTrackTransform = structuredClone(persisted);
    missingTrackTransform.execution.localSpaces[0].placements[0].owner = "track-2d";
    delete missingTrackTransform.execution.localSpaces[0].placements[0].transform;
    assert.equal(validate(missingTrackTransform), false, "Track/Depth placement evidence cannot conceal its executed transform");
    missingTrackTransform.execution.localSpaces[0].placements[0].transform = {
      destinationX: 20,
      destinationY: 20,
      registrationRasterX: 4.5,
      registrationRasterY: 3.5,
      scale: 1,
      skewX: 0,
      skewY: 0,
      rotation: 0,
      opacity: 0.8,
    };
    assert.equal(validate(missingTrackTransform), true, JSON.stringify(validate.errors));
    for (const owner of ["track-2d", "depth-layer"] as const) {
      const missingTrackedWork = structuredClone(missingTrackTransform);
      missingTrackedWork.execution.localSpaces[0].placements[0].owner = owner;
      delete missingTrackedWork.execution.localSpaces[0].placements[0].transformWork;
      assert.equal(validate(missingTrackedWork), false, `${owner} execution cannot omit its admitted transform work`);
    }

    const ownerPolicy = structuredClone(persisted);
    ownerPolicy.execution.localSpaces[0].skips.push({
      nodeId: receipt.tiles[0].nodeId,
      kind: "owner-policy",
      reason: "tracking-policy-hidden",
    });
    assert.equal(validate(ownerPolicy), false, "a tracking-policy skip must identify its owner");
    ownerPolicy.execution.localSpaces[0].skips.at(-1).ownerNodeId = receipt.placements[0].nodeId;
    assert.equal(validate(ownerPolicy), false, "a current-profile skip must bind its exact renderer sample");
    ownerPolicy.execution.localSpaces[0].skips.at(-1).sampleTime = { numerator: "0", denominator: "1" };
    assert.equal(validate(ownerPolicy), true, JSON.stringify(validate.errors));

    // v2 predates LocalSpace receipts. The additive schema field intentionally
    // remains optional so frozen v2 manifests do not become retroactively
    // invalid; every current writer is separately required by this test to
    // emit it after a successful frame.
    const frozenCompatible = structuredClone(persisted);
    delete frozenCompatible.execution.evidenceProfile;
    delete frozenCompatible.execution.localSpaceExecutionTree;
    delete frozenCompatible.execution.localSpaceExecutions;
    delete frozenCompatible.execution.localSpaces[0].observationIdentity;
    delete frozenCompatible.execution.localSpaces[0].counters.ownerPolicySkips;
    for (const counter of [
      "localPaintSurfaceCacheHits",
      "localPaintSurfaceCacheMisses",
      "localPaintSurfaceCacheBypasses",
      "localPaintSurfaceCacheEvictions",
      "localPaintSurfaceCacheResidentBytes",
    ] as const) delete frozenCompatible.execution.localSpaces[0].counters[counter];
    assert.equal(validate(frozenCompatible), true, JSON.stringify(validate.errors));
    delete frozenCompatible.execution.localSpaces;
    assert.equal(validate(frozenCompatible), true, JSON.stringify(validate.errors));

    const frozenWithoutPreflight = structuredClone(persisted);
    delete frozenWithoutPreflight.execution.evidenceProfile;
    delete frozenWithoutPreflight.execution.localSpaceExecutionTree;
    delete frozenWithoutPreflight.execution.localSpaceTransformPreflight;
    delete frozenWithoutPreflight.execution.localSpaceExecutions;
    assert.equal(validate(frozenWithoutPreflight), true, "the additive aggregate field remains optional for frozen non-component frame-v2 receipts");

    const skewOutput = resolve(root, "review/skew.png");
    const skewed = await renderReferenceFrameArtifact(
      compile("x: 3px, y: -2px, opacity: 80%, skewX: 11deg, skewY: -7deg"),
      root,
      skewOutput,
      { frame: 0, mediaProfile: "master" },
    );
    const skewPreflight = skewed.execution.localSpaceTransformPreflight;
    assert.equal(skewPreflight.admissions[0]?.work.version, 3);
    assert.equal(skewPreflight.aggregate?.version, 3);
    assert.ok(skewed.execution.localSpaces[0]?.placements[0]?.transformWork?.skew);
    const skewPersisted = JSON.parse(await readFile(`${skewOutput}.manifest.json`, "utf8"));
    assert.equal(validate(skewPersisted), true, JSON.stringify(validate.errors));
    const missingSkew = structuredClone(skewPersisted);
    delete missingSkew.execution.localSpaceTransformPreflight.admissions[0].work.skew;
    assert.equal(validate(missingSkew), false, "V3 planning evidence cannot omit the executed skew stage");
    const mismatchedSkewExecution = structuredClone(skewPersisted);
    delete mismatchedSkewExecution.execution.localSpaces[0].placements[0].transformWork.skew;
    assert.equal(validate(mismatchedSkewExecution), false, "V3 execution evidence cannot omit observed skew dimensions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
