import test from "node:test";
import assert from "node:assert/strict";
import { validateSceneVision } from "../lib/core/vision";

const scenes = [{ id: "s001", start: 0, end: 2 }, { id: "s002", start: 2, end: 4 }];
const valid = { scenes: [
  { sceneId: "s001", description: "A mechanical arm beside a red target.", subjects: ["mechanical arm", "target"], setting: "dark studio", composition: "wide shot with negative space on left", camera: "static", motion: "arm moving", visibleText: "", usability: "hero" as const, confidence: .94 },
  { sceneId: "s002", description: "The arm stops short of the target.", subjects: ["mechanical arm", "target"], setting: "dark studio", composition: "centered medium shot", camera: "static", motion: "motion ends", visibleText: "ARM MISSED", usability: "broll" as const, confidence: .91 },
] };

test("vision analysis must preserve locked scene order", () => assert.throws(() => validateSceneVision({ scenes: [...valid.scenes].reverse() }, scenes), /invalid analysis/));
test("vision analysis rejects non-finite confidence", () => assert.throws(() => validateSceneVision({ scenes: [{ ...valid.scenes[0], confidence: Number.NaN }, valid.scenes[1]] }, scenes), /invalid analysis/));
test("grounded scene descriptions pass validation", () => assert.equal(validateSceneVision(valid, scenes).scenes[0].sceneId, "s001"));
