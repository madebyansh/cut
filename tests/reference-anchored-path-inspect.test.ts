import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { inspectCutIr } from "../lib/runtime/inspect";
import { ReferenceAnchoredPathError } from "../lib/runtime/reference/anchored-path";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function source(inner = `
    Plate() as plate;
    Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
        segments: [anchoredLineTo(to: { x: 100px, y: 50px })],
        closed: false
      ),
      stroke: #ffffff,
      width: 2px,
      dash: [6px, 3px],
      dashOffset: 1px,
      trimStart: 10%,
      trimEnd: 90%
    );
    MotionPath(
      geometry: anchoredPath(
        start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
        segments: [anchoredLineTo(to: { x: 120px, y: 40px })],
        closed: false
      ),
      progress: 50%,
      orientToPath: true
    ) { Circle(radius: 3px, fill: #ff0000); }`) {
  return `cut 0.4;
project "anchored path inspect proof";
import { LocalSpace, Rect, Circle, Path, MotionPath, visualAnchor, anchoredLineTo, anchoredPath } from "cut:visual";

component Plate() -> Visual {
  LocalSpace(width: 100px, height: 80px, origin: { x: 50px, y: 40px }) {
    Rect(width: 20px, height: 20px, fill: #ffffff);
  }
}

timeline main(duration: 1s, fps: 24, width: 200px, height: 100px, sampleRate: 48khz) {
  scene only(duration: 1s) {${inner}
  }
}
export out = render(main);`;
}

function compile(program = source()) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  return compileCutModule(parsed.module).ir;
}

test("cut inspect reports validated anchored Path and MotionPath plans without running legacy preparation or inventing coordinates", () => {
  const ir = compile();
  assert.equal(validateReferenceSession(ir).composition.id, "main");
  const report = inspectCutIr(ir, "main.cut");
  const path = report.graph.nodes.find((node) => node.op === "cut.visual.path");
  const motion = report.graph.nodes.find((node) => node.op === "cut.visual.motion_path");
  assert.ok(path?.anchoredPath);
  assert.ok(motion?.anchoredPath);
  assert.equal(path.vectorPath, undefined, "anchored geometry must not run the legacy VectorPath preparation path");
  assert.equal(motion.motionPath, undefined, "anchored geometry must not run the legacy MotionPath preparation path");

  const pathInspection = path.anchoredPath;
  assert.equal(pathInspection.consumer, "Path");
  assert.equal(pathInspection.requiresExactOwnerPlacement, true);
  assert.equal(pathInspection.preRender.status, "validated-requires-exact-owner-placement");
  assert.equal(pathInspection.preRender.coordinateEvidence, "not-sampled-by-cut-inspect");
  assert.equal(pathInspection.geometry.algorithmVersion, "cut-reference-anchored-path-v1");
  assert.equal(pathInspection.geometry.visualAnchorCount, 1);
  assert.equal(pathInspection.ownerBindings.length, 1);
  assert.equal(pathInspection.ownerBindings[0]?.ownerKind, "component-fragment");
  assert.equal(path.references.includes(pathInspection.ownerBindings[0]!.ownerNodeId), true);
  assert.deepEqual(pathInspection.paint, {
    stroke: "#ffffff",
    strokeWidth: 2,
    dash: [6, 3],
    lineCap: "round",
    lineJoin: "round",
  });
  assert.deepEqual(pathInspection.controls.animatedProperties, []);
  assert.equal(pathInspection.controls.trimRangeDynamic, false);
  assert.equal(pathInspection.controls.trimStart.kind, "static-input");
  assert.equal(pathInspection.controls.trimEnd.kind, "static-input");
  assert.deepEqual(pathInspection.structuralWork, {
    authoredSegmentFrames: 24,
    spatialPointFrames: 48,
    ownerSampleFrames: 24,
    activeFrames: 24,
  });
  const retainedInstance = pathInspection.retainedCompositor?.instances[0] as { status?: string } | undefined;
  assert.equal(retainedInstance?.status, "exact-owner-placement-required");

  const motionInspection = motion.anchoredPath;
  assert.equal(motionInspection.consumer, "MotionPath");
  assert.equal(motionInspection.plan.pathForm, "anchored-geometry");
  assert.equal(motionInspection.paint.kind, "subject-placement-no-self-paint");
  assert.equal(motionInspection.controls.progress.kind, "static-input");
  assert.equal(motionInspection.controls.orientToPath.kind, "static-input");
  assert.deepEqual(motionInspection.structuralWork, {
    status: "owner-aware-frame-work-deferred-to-pre-render",
    authoredSegments: 1,
    spatialPointCount: 2,
    ownerCount: 1,
  });

  const inspectionJson = JSON.stringify({ path: pathInspection, motion: motionInspection });
  for (const fabricatedField of ["resolvedGeometry", "resolvedPoint", "placementMatrix", "sampledAnchors"]) {
    assert.doesNotMatch(inspectionJson, new RegExp(`"${fabricatedField}"`, "u"));
  }
});

test("cut inspect preserves the legacy vector report for vectorPath geometry", () => {
  const program = `cut 0.4;
project "legacy inspect";
import { Path, lineTo, vectorPath } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 200px, height: 100px) {
  scene only(duration: 1s) {
    Path(geometry: vectorPath(start: { x: 0px, y: 0px }, segments: [lineTo(to: { x: 100px, y: 50px })], closed: false), stroke: #ffffff, width: 2px);
  }
}
export out = render(main);`;
  const report = inspectCutIr(compile(program), "legacy.cut");
  const path = report.graph.nodes.find((node) => node.op === "cut.visual.path");
  assert.ok(path?.vectorPath);
  assert.equal(path.anchoredPath, undefined);
});

test("cut inspect enforces the root composition-space consumer boundary", () => {
  const program = source(`
    Plate() as plate;
    LocalSpace(width: 200px, height: 100px, origin: { x: 0px, y: 0px }) {
      Path(
        geometry: anchoredPath(
          start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
          segments: [anchoredLineTo(to: { x: 100px, y: 50px })],
          closed: false
        ),
        stroke: #ffffff,
        width: 2px
      );
    }`);
  const ir = compile(program);
  assert.throws(() => inspectCutIr(ir, "nested.cut"), (error: unknown) => {
    assert.ok(error instanceof ReferenceAnchoredPathError, String(error));
    assert.equal(error.code, "CUT_ANCHORED_PATH_UNSUPPORTED");
    assert.match(error.message, /consumer is nested under LocalSpace/u);
    return true;
  });
});
