import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(
    [...parsed.diagnostics, ...checked.diagnostics].filter((item) => item.severity === "error"),
    [],
    JSON.stringify([...parsed.diagnostics, ...checked.diagnostics]),
  );
  const compiled = compileCutModule(parsed.module);
  assert.deepEqual(compiled.check.diagnostics.filter((item) => item.severity === "error"), []);
  return compiled.ir;
}

async function lock(ir: CutAVIR, root: string) {
  const manifest = await createCutLock(ir, root);
  await applyCutLock(ir, manifest, root);
}

async function frameValidator() {
  const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
  return new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
}

function resolvedSource() {
  return `cut 0.4;
project "anchored frame evidence";
import { LocalSpace, Rect, Circle, Path, MotionPath, visualAnchor, anchoredLineTo, anchoredPath } from "cut:visual";

component Plate() -> Visual {
  LocalSpace(width: 100px, height: 80px, origin: { x: 50px, y: 40px }) {
    Rect(width: 80px, height: 60px, fill: #294c73);
  }
}

timeline main(duration: 1s, fps: 24, width: 200px, height: 100px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Plate() as plate;
    set plate.x = -30px;
    set plate.y = 5px;
    Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
        segments: [anchoredLineTo(to: { x: 185px, y: 50px })],
        closed: false
      ),
      stroke: #ffcc33,
      width: 3px
    );
    MotionPath(
      geometry: anchoredPath(
        start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
        segments: [anchoredLineTo(to: { x: 185px, y: 50px })],
        closed: false
      ),
      progress: 50%
    ) { Circle(radius: 4px, fill: #ff3b30); }
  }
}
export proof = render(main);`;
}

function policyHiddenSource() {
  return `cut 0.4;
project "anchored policy-hidden frame evidence";
import { Circle, LocalSpace, MotionPath, Rect, Track2D, Path, visualAnchor, anchoredLineTo, anchoredPath } from "cut:visual";
asset observations: DataAsset = data("assets/hidden.track.json");

timeline main(duration: 1s, fps: 4, width: 80px, height: 60px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Track2D(
      source: observations,
      minConfidence: 60%,
      lowConfidence: "fail",
      occluded: "fail",
      outOfFrame: "hide",
      interpolation: "hold"
    ) as tracked {
      LocalSpace(width: 20px, height: 12px, origin: { x: 10px, y: 6px }) {
        Rect(width: 18px, height: 10px, fill: #294c73);
      }
    }
    let route = anchoredPath(
      start: visualAnchor(owner: tracked, local: { x: 0px, y: 0px }),
      segments: [anchoredLineTo(to: { x: 70px, y: 30px })],
      closed: false
    );
    Path(geometry: route, stroke: #ffcc33, width: 3px);
    MotionPath(geometry: route, progress: 60%) {
      LocalSpace(width: 8px, height: 8px, origin: { x: 4px, y: 4px }) {
        Circle(radius: 3px, fill: #ff3b30);
      }
    }
  }
}
export proof = render(main);`;
}

function hiddenTrackSidecar() {
  const q = (numerator: string) => ({ numerator, denominator: "1" });
  return {
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 80,
    height: 60,
    samples: [
      { at: q("0"), x: q("20"), y: q("30"), confidence: q("1"), status: "out-of-frame" },
      { at: q("1"), x: q("20"), y: q("30"), confidence: q("1"), status: "out-of-frame" },
    ],
  };
}

test("frame v2 publishes closed resolved anchored Path/MotionPath evidence and remains additive for legacy manifests", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-anchored-frame-evidence-"));
  try {
    const ir = compile(resolvedSource());
    await lock(ir, root);
    const output = resolve(root, "review", "resolved.png");
    const manifest = await renderReferenceFrameArtifact(ir, root, output, { frame: 0 });
    const evidence = manifest.execution.anchoredPaths;
    assert.ok(evidence);
    assert.equal(evidence.length, 2);
    assert.deepEqual([...new Set(evidence.map((item) => item.consumerOp))].sort(), ["cut.visual.motion_path", "cut.visual.path"]);
    assert.deepEqual([...new Set(evidence.map((item) => item.status))], ["resolved"]);
    assert.deepEqual([...new Set(evidence.map((item) => item.outputFrame))], ["0"]);
    assert.equal(new Set(evidence.map((item) => item.authoredGeometryIdentity)).size, 1);
    assert.equal(new Set(evidence.map((item) => item.geometryIdentity)).size, 1);
    assert.equal(new Set(evidence.map((item) => item.anchors?.[0]?.affineIdentity)).size, 1);
    for (const item of evidence) {
      assert.equal(item.anchors?.length, 1);
      assert.equal(item.anchors?.[0]?.compositionPoint.x, 70);
      assert.equal(item.geometry?.start.x, item.anchors?.[0]?.compositionPoint.x);
      assert.equal(item.geometry?.start.y, item.anchors?.[0]?.compositionPoint.y);
      assert.match(item.geometryIdentity ?? "", /^[a-f0-9]{64}$/u);
      assert.match(item.anchors?.[0]?.affineIdentity ?? "", /^[a-f0-9]{64}$/u);
      assert.match(item.evidenceIdentity, /^[a-f0-9]{64}$/u);
    }

    const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
    assert.deepEqual(persisted.execution.anchoredPaths, evidence);
    const validate = await frameValidator();
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

    const unknown = structuredClone(manifest) as unknown as { execution: { anchoredPaths: Array<Record<string, unknown>> } };
    unknown.execution.anchoredPaths[0]!.ignored = true;
    assert.equal(validate(unknown), false, "anchored-path receipts must reject unknown properties");
    const missingFrame = structuredClone(manifest) as unknown as { execution: { anchoredPaths: Array<Record<string, unknown>> } };
    delete missingFrame.execution.anchoredPaths[0]!.outputFrame;
    assert.equal(validate(missingFrame), false, "frame-v2 anchored-path receipts must bind their output frame");

    const historical = structuredClone(manifest) as typeof manifest;
    delete historical.execution.anchoredPaths;
    assert.equal(validate(historical), true, JSON.stringify(validate.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frame v2 publishes Track2D policy-hidden anchored evidence as an exclusive zero-work branch", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-anchored-hidden-evidence-"));
  try {
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets", "hidden.track.json"), JSON.stringify(hiddenTrackSidecar()));
    const ir = compile(policyHiddenSource());
    await lock(ir, root);
    const manifest = await renderReferenceFrameArtifact(ir, root, resolve(root, "review", "hidden.png"), { frame: 0 });
    const evidence = manifest.execution.anchoredPaths;
    assert.ok(evidence);
    assert.equal(evidence.length, 2);
    assert.deepEqual([...new Set(evidence.map((item) => item.consumerOp))].sort(), ["cut.visual.motion_path", "cut.visual.path"]);
    for (const hidden of evidence) {
      assert.equal(hidden.status, "policy-hidden");
      assert.deepEqual(hidden.zeroWork, {
        kind: "anchored-path-policy-hidden-no-raster",
        geometryPreparations: 0,
        rasterRequests: 0,
        ownerPolicySkips: 1,
      });
      assert.equal(hidden.suppressedBy?.length, 1);
      assert.equal(hidden.suppressedBy?.[0]?.ownerKind, "track-2d");
      assert.equal(hidden.geometry, undefined);
      assert.equal(hidden.geometryIdentity, undefined);
      assert.equal(hidden.anchors, undefined);
    }
    const affineSkips = manifest.execution.localSpaceTransformPreflight?.skips ?? [];
    const transitive = affineSkips.find((skip) => skip.ownerKind === "motion-path");
    const direct = affineSkips.find((skip) => skip.ownerKind === "track-2d");
    assert.ok(transitive?.policyHiddenBy);
    assert.equal(transitive.policyHiddenBy.executionIdentity, evidence.find((item) => item.consumerOp === "cut.visual.motion_path")?.executionIdentity);
    assert.deepEqual(transitive.policyHiddenBy.trackOwnerNodeIds, [direct?.ownerNodeId]);
    assert.equal(direct?.policyHiddenBy, undefined);

    const validate = await frameValidator();
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
    const workLie = structuredClone(manifest) as unknown as {
      execution: { anchoredPaths: Array<{ zeroWork: { rasterRequests: number } }> };
    };
    workLie.execution.anchoredPaths[0]!.zeroWork.rasterRequests = 1;
    assert.equal(validate(workLie), false, "policy-hidden evidence cannot claim raster work");
    const geometryLie = structuredClone(manifest) as unknown as {
      execution: { anchoredPaths: Array<Record<string, unknown>> };
    };
    geometryLie.execution.anchoredPaths[0]!.geometry = { start: { x: 0, y: 0 }, segments: [], closed: false };
    assert.equal(validate(geometryLie), false, "policy-hidden evidence cannot smuggle resolved geometry");
    const missingCause = structuredClone(manifest) as unknown as {
      execution: { localSpaceTransformPreflight: { skips: Array<Record<string, unknown>> } };
    };
    delete missingCause.execution.localSpaceTransformPreflight.skips.find((skip) => skip.ownerKind === "motion-path")!.policyHiddenBy;
    assert.equal(validate(missingCause), false, "a transitive MotionPath LocalSpace skip must publish its authenticated Track2D cause");
    const causeOnDirectOwner = structuredClone(manifest) as unknown as {
      execution: { localSpaceTransformPreflight: { skips: Array<Record<string, unknown>> } };
    };
    const cause = causeOnDirectOwner.execution.localSpaceTransformPreflight.skips.find((skip) => skip.ownerKind === "motion-path")!.policyHiddenBy;
    causeOnDirectOwner.execution.localSpaceTransformPreflight.skips.find((skip) => skip.ownerKind === "track-2d")!.policyHiddenBy = cause;
    assert.equal(validate(causeOnDirectOwner), false, "a direct Track2D skip cannot impersonate transitive MotionPath evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an anchored exact-frame artifact that cannot publish leaks neither pixels nor evidence manifest", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-anchored-frame-atomic-"));
  try {
    const ir = compile(resolvedSource());
    await lock(ir, root);
    const blockedParent = resolve(root, "blocked");
    await writeFile(blockedParent, "not a directory");
    const output = resolve(blockedParent, "frame.png");
    await assert.rejects(renderReferenceFrameArtifact(ir, root, output, { frame: 0 }));
    await assert.rejects(readFile(output));
    await assert.rejects(readFile(`${output}.manifest.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
