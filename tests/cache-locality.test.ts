import test from "node:test";
import assert from "node:assert/strict";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";

function fixture() {
  const parsed = parseCutLanguage(`
    cut 0.4;
    project "cache locality";
    import { Rect } from "cut:visual";
    import { Gain, Tone } from "@cut/audio";
    timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
      scene only(duration: 1s) {
        Rect(width: 64px, height: 64px, fill: #102030);
        Gain(amount: -6db) { Tone(frequency: 440hz, duration: 1s); }
      }
    }
    export out = render(main);
  `);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function reverbFixture(targetWet: number) {
  const parsed = parseCutLanguage(`
    cut 0.4;
    project "reverb automation cache locality";
    import { Rect } from "cut:visual";
    import { Noise, Reverb } from "@cut/audio";
    timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
      scene only(duration: 1s) {
        Rect(width: 64px, height: 64px, fill: #102030);
        Reverb(wet: 0%) as room { Noise(duration: 1s, color: "white", seed: 9182, amplitude: 20%); }
        animate room.wet from 0% to ${targetWet}% over 1s;
      }
    }
    export out = render(main);
  `);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function delayFixture(time: number) {
  const parsed = parseCutLanguage(`
    cut 0.4;
    project "delay cache locality";
    import { Rect } from "cut:visual";
    import { Delay, Noise } from "@cut/audio";
    timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
      scene only(duration: 1s) {
        Rect(width: 64px, height: 64px, fill: #102030);
        Delay(time: ${time}ms, repeats: 3, decay: 50%, wet: 25%) { Noise(duration: 100ms, color: "white", seed: 9182, amplitude: 20%); }
      }
    }
    export out = render(main);
  `);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function colorGradeFixture(targetExposure: number) {
  const parsed = parseCutLanguage(`
    cut 0.4;
    project "color grade cache locality";
    import { ColorGrade, Rect } from "cut:visual";
    import { Tone } from "@cut/audio";
    timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
      scene only(duration: 1s) {
        ColorGrade() as look { Rect(width: 64px, height: 64px, fill: #406080); }
        animate look.exposure from 0 to ${targetExposure} over 1s;
        Tone(frequency: 440hz, duration: 1s);
      }
    }
    export out = render(main);
  `);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function motionPathFixture(targetProgress: number) {
  const parsed = parseCutLanguage(`
    cut 0.4;
    project "motion path cache locality";
    import { MotionPath, Rect } from "cut:visual";
    import { Tone } from "@cut/audio";
    timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
      scene only(duration: 1s) {
        MotionPath(points: [{ x: 8px, y: 32px }, { x: 56px, y: 32px }]) as mover {
          Rect(width: 8px, height: 8px, fill: #ef233c);
        }
        animate mover.progress from 0% to ${targetProgress}% over 1s;
        Tone(frequency: 440hz, duration: 1s);
      }
    }
    export out = render(main);
  `);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function pictureSpeedRampFixture(startRate: number, middleRate: number, finalRate: number) {
  const parsed = parseCutLanguage(`
    cut 0.4;
    project "picture speed-ramp cache locality";
    import { Sequence, PictureTrack, PictureClip, speedPoint } from "@cut/edit";
    import { Tone } from "@cut/audio";
    asset source: VideoAsset = video("media/source.mkv");
    timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
      scene only(duration: 1s) {
        Sequence(duration: 1s) {
          PictureTrack() {
            PictureClip(
              source: source,
              range: 0s ..< 1s,
              duration: 1s,
              speedRamp: [
                speedPoint(at: 0s, rate: ${startRate}),
                speedPoint(at: 500ms, rate: ${middleRate}),
                speedPoint(at: 1s, rate: ${finalRate})
              ]
            );
          }
        }
        Tone(frequency: 440hz, duration: 1s);
      }
    }
    export out = render(main);
  `);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

test("audio-only edits do not invalidate picture scene cache keys", () => {
  const before = fixture();
  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = fixture();
  const gain = Object.values(after.nodes).find((node) => node.op === "cut.audio.gain");
  assert.ok(gain);
  gain.inputs.amount = { kind: "quantity", dimension: "gain", magnitude: rational(-12), unit: "db" };

  const plan = createIncrementalRenderPlan(after, "main", previous);
  const gainPlan = plan.nodes.find((node) => node.id === gain.id);
  assert.equal(gainPlan?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});

test("visual edits invalidate picture scenes while pure sample-rate changes do not", () => {
  const before = fixture();
  const previous = createIncrementalRenderPlan(before, "main").manifest;

  const sampleRateOnly = fixture();
  sampleRateOnly.compositions[0].sampleRate = 96_000;
  const ratePlan = createIncrementalRenderPlan(sampleRateOnly, "main", previous);
  assert.ok(ratePlan.scenes.every((scene) => scene.status === "hit"));

  const changedPicture = fixture();
  const rect = Object.values(changedPicture.nodes).find((node) => node.op === "cut.visual.rect");
  assert.ok(rect);
  rect.inputs.fill = { kind: "color", value: "#ffeedd" };
  const picturePlan = createIncrementalRenderPlan(changedPicture, "main", previous);
  assert.ok(picturePlan.scenes.every((scene) => scene.status === "miss"));
});

test("Reverb.wet automation changes audio graph identity without invalidating picture scenes", () => {
  const before = reverbFixture(50), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = reverbFixture(100), reverb = Object.values(after.nodes).find((node) => node.op === "cut.audio.reverb");
  assert.ok(reverb);
  const plan = createIncrementalRenderPlan(after, "main", previous);
  assert.equal(plan.nodes.find((node) => node.id === reverb.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});

test("Delay.time changes audio graph identity without invalidating picture scenes", () => {
  const before = delayFixture(40), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = delayFixture(80), delay = Object.values(after.nodes).find((node) => node.op === "cut.audio.delay");
  assert.ok(delay);
  const plan = createIncrementalRenderPlan(after, "main", previous);
  assert.equal(plan.nodes.find((node) => node.id === delay.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});

test("ColorGrade exposure automation changes picture identity without invalidating audio nodes", () => {
  const before = colorGradeFixture(1), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = colorGradeFixture(2), grade = Object.values(after.nodes).find((node) => node.op === "cut.visual.color_grade");
  const tone = Object.values(after.nodes).find((node) => node.op === "cut.audio.tone");
  assert.ok(grade); assert.ok(tone);
  const plan = createIncrementalRenderPlan(after, "main", previous);
  assert.equal(plan.nodes.find((node) => node.id === grade.id)?.status, "miss");
  assert.equal(plan.nodes.find((node) => node.id === tone.id)?.status, "hit");
  assert.ok(plan.scenes.every((scene) => scene.status === "miss"));
});

test("MotionPath progress changes picture identity without invalidating audio nodes", () => {
  const before = motionPathFixture(50), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = motionPathFixture(100), motionPath = Object.values(after.nodes).find((node) => node.op === "cut.visual.motion_path");
  const tone = Object.values(after.nodes).find((node) => node.op === "cut.audio.tone");
  assert.ok(motionPath); assert.ok(tone);
  const plan = createIncrementalRenderPlan(after, "main", previous);
  assert.equal(plan.nodes.find((node) => node.id === motionPath.id)?.status, "miss");
  assert.equal(plan.nodes.find((node) => node.id === tone.id)?.status, "hit");
  assert.ok(plan.scenes.every((scene) => scene.status === "miss"));
});

test("PictureClip speed-ramp edits invalidate picture identity without invalidating audio nodes", () => {
  const before = pictureSpeedRampFixture(0.5, 1.5, 0.5), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = pictureSpeedRampFixture(1, 0.5, 2), clip = Object.values(after.nodes).find((node) => node.op === "cut.edit.picture_clip");
  const tone = Object.values(after.nodes).find((node) => node.op === "cut.audio.tone");
  assert.ok(clip); assert.ok(tone);
  const plan = createIncrementalRenderPlan(after, "main", previous);
  assert.equal(plan.nodes.find((node) => node.id === clip.id)?.status, "miss");
  assert.equal(plan.nodes.find((node) => node.id === tone.id)?.status, "hit");
  assert.ok(plan.scenes.every((scene) => scene.status === "miss"));
});
