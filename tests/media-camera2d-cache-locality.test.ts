import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan, type IncrementalRenderPlan } from "../lib/runtime/graph";

type CameraFixture = Readonly<{
  focusX?: string;
  focusY?: string;
  zoom?: string;
  rotation?: string;
  opacity?: string;
  edge?: "transparent" | "clamp";
  exposure?: string;
  source?: "stillA" | "stillB";
}>;

function compile(options: CameraFixture = {}) {
  const source = `cut 0.4;
project "MediaCamera2D cache locality";

import { ColorGrade, Image, MediaCamera2D, Rect } from "cut:visual";
import { Tone } from "@cut/audio";

asset stillA: ImageAsset = image("media/still-a.png");
asset stillB: ImageAsset = image("media/still-b.png");

timeline main(duration: 2s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene unrelated(duration: 1s) {
    Rect(width: 320px, height: 180px, fill: #102030);
    Tone(frequency: 330hz, duration: 1s);
  }

  scene camera(duration: 1s) {
    MediaCamera2D(
      focusX: ${options.focusX ?? "55%"},
      focusY: ${options.focusY ?? "45%"},
      zoom: ${options.zoom ?? "1.25"},
      rotation: ${options.rotation ?? "2deg"},
      opacity: ${options.opacity ?? "90%"}${options.edge ? `,
      edge: "${options.edge}"` : ""}
    ) {
      ColorGrade(exposure: ${options.exposure ?? "0.2"}) {
        Image(source: ${options.source ?? "stillA"}, fit: "cover");
      }
    }
    Tone(frequency: 440hz, duration: 1s);
  }
}

export out = render(main);`;
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function scene(ir: CutAVIR, name: "unrelated" | "camera") {
  const result = Object.values(ir.scenes).find((item) => item.name === name);
  assert.ok(result, name);
  return result;
}

function node(ir: CutAVIR, op: string, sceneName: "unrelated" | "camera") {
  const sceneId = scene(ir, sceneName).id;
  const matches = Object.values(ir.nodes).filter((item) => item.op === op && item.sceneId === sceneId);
  assert.equal(matches.length, 1, `${sceneName}:${op}`);
  return matches[0]!;
}

function status(plan: IncrementalRenderPlan, current: IRNode) {
  const result = plan.nodes.find((item) => item.id === current.id);
  assert.ok(result, current.id);
  return result.status;
}

function planAfter(options: CameraFixture) {
  const before = compile();
  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = compile(options);
  return { after, plan: createIncrementalRenderPlan(after, "main", previous) };
}

function assertCameraSceneMissWithLocality(after: CutAVIR, plan: IncrementalRenderPlan) {
  const cameraScene = scene(after, "camera"), unrelatedScene = scene(after, "unrelated");
  assert.equal(plan.scenes.find((item) => item.id === cameraScene.id)?.status, "miss", "the owning picture scene must invalidate");
  assert.equal(plan.scenes.find((item) => item.id === unrelatedScene.id)?.status, "hit", "an unrelated picture scene must remain reusable");
  assert.equal(status(plan, node(after, "cut.visual.media_camera2d", "camera")), "miss", "the camera picture node must invalidate");
  for (const audio of Object.values(after.nodes).filter((item) => item.domain === "audio")) {
    assert.equal(status(plan, audio), "hit", `unrelated audio node ${audio.id} must remain reusable`);
  }
  assert.equal(status(plan, node(after, "cut.visual.rect", "unrelated")), "hit", "the unrelated scene's picture node must remain reusable");
}

test("every MediaCamera2D control invalidates only its owning picture scene cache identity", () => {
  const variants = [
    ["focusX", { focusX: "65%" }],
    ["focusY", { focusY: "35%" }],
    ["zoom", { zoom: "1.50" }],
    ["rotation", { rotation: "5deg" }],
    ["opacity", { opacity: "80%" }],
    ["edge", { edge: "clamp" }],
  ] as const satisfies readonly (readonly [string, CameraFixture])[];

  for (const [label, options] of variants) {
    const { after, plan } = planAfter(options);
    assertCameraSceneMissWithLocality(after, plan);
    assert.equal(status(plan, node(after, "cut.visual.color_grade", "camera")), "hit", `${label}: unchanged grade remains reusable`);
    assert.equal(status(plan, node(after, "cut.visual.image", "camera")), "hit", `${label}: unchanged media leaf remains reusable`);
  }
});

test("MediaCamera2D child grade and source selection invalidate the affected picture chain without poisoning unrelated work", () => {
  const gradeEdit = planAfter({ exposure: "0.4" });
  assertCameraSceneMissWithLocality(gradeEdit.after, gradeEdit.plan);
  assert.equal(status(gradeEdit.plan, node(gradeEdit.after, "cut.visual.color_grade", "camera")), "miss");
  assert.equal(status(gradeEdit.plan, node(gradeEdit.after, "cut.visual.image", "camera")), "hit", "a grade-only edit keeps the unchanged image leaf reusable");

  const sourceEdit = planAfter({ source: "stillB" });
  assertCameraSceneMissWithLocality(sourceEdit.after, sourceEdit.plan);
  assert.equal(status(sourceEdit.plan, node(sourceEdit.after, "cut.visual.color_grade", "camera")), "miss");
  assert.equal(status(sourceEdit.plan, node(sourceEdit.after, "cut.visual.image", "camera")), "miss", "source selection belongs to the media leaf identity");
});
