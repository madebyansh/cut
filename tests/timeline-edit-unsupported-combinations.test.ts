import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function expectSourceRefusal(
  source: string,
  code: string,
  message: RegExp,
) {
  assert.throws(
    () => compile(source),
    (error: unknown) => {
      if (!(error instanceof CutCompileError)) return false;
      const diagnostic = error.result.diagnostics.find((candidate) =>
        candidate.code === code && message.test(candidate.message));
      assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
      assert.ok(diagnostic.span.start.line > 0);
      assert.ok(diagnostic.span.start.column > 0);
      return true;
    },
  );
}

const fadedSlide = `cut 0.4;
project "faded slide refusal";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editSlide
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 60ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 60ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(source: voice, range: 10ms ..< 30ms, destination: 0ms ..< 20ms, headHandle: 10ms, tailHandle: 10ms, fadeIn: 2ms, fadeOut: 2ms, editId: "left");
      AudioClip(source: voice, range: 30ms ..< 50ms, destination: 20ms ..< 40ms, headHandle: 10ms, tailHandle: 10ms, fadeIn: 2ms, fadeOut: 2ms, editId: "middle");
      AudioClip(source: voice, range: 50ms ..< 70ms, destination: 40ms ..< 60ms, headHandle: 10ms, tailHandle: 10ms, fadeIn: 2ms, fadeOut: 2ms, editId: "right");
    }
    TimelineEdit(
      id: "slide-faded",
      operations: [
        editSlide(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["middle"]
          ),
          range: 20ms ..< 40ms,
          by: avTime(audio: 4ms)
        )
      ]
    );
  }
}
export out = render(main);`;

const fadedBoundary = `cut 0.4;
project "faded boundary refusal";
import {
  Sequence, PictureTrack, PictureClip, AudioTrack, TimelineEdit,
  editSelection, avTime, editBoundary
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(trackId: "v1") {
        PictureClip(source: picture, range: 1s ..< 3s, duration: 2s, headHandle: 1s, tailHandle: 1s, link: "left", editId: "picture-left");
        PictureClip(source: picture, range: 3s ..< 5s, duration: 2s, headHandle: 1s, tailHandle: 1s, link: "right", editId: "picture-right");
      }
    }
    AudioTrack(trackId: "a1") {
      AudioClip(source: voice, range: 1s ..< 3s, destination: 0s ..< 2s, headHandle: 1s, tailHandle: 1s, fadeIn: 100ms, fadeOut: 100ms, link: "left", editId: "audio-left");
      AudioClip(source: voice, range: 3s ..< 5s, destination: 2s ..< 4s, headHandle: 1s, tailHandle: 1s, fadeIn: 100ms, fadeOut: 100ms, link: "right", editId: "audio-right");
    }
    TimelineEdit(
      id: "boundary-faded",
      operations: [
        editBoundary(
          selection: editSelection(trackIds: ["v1", "a1"]),
          at: avTime(picture: 2250ms, audio: 1750ms)
        )
      ]
    );
  }
}
export out = render(main);`;

const audiovisualNestedSequence = `cut 0.4;
project "audiovisual nested edit refusal";
import {
  NestedSequence, TimelineEdit, editSelection, editTrim
} from "@cut/edit";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 32px, height: 24px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    NestedSequence(source: child);
    TimelineEdit(
      id: "edit-nested-av",
      operations: [
        editTrim(
          selection: editSelection(
            trackIds: ["nested-av"],
            allowUnlinked: true
          ),
          keep: 0s ..< 500ms
        )
      ]
    );
  }
}
timeline child(duration: 1s, fps: 24, width: 32px, height: 24px, sampleRate: 48khz) {
  scene childScene(duration: 1s) {
    Rect(width: 32px, height: 24px, fill: #ffffff);
  }
}
export out = render(main);`;

const processedExternalHandle = `cut 0.4;
project "processed external handle refusal";
import { AudioTrack, AudioRegion, TimelineEdit, editSelection, avTime, editSlip } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue") {
      AudioRegion(destination: 0ms ..< 20ms, headHandle: 10ms, tailHandle: 10ms, editId: "line") {
        Gain(amount: -3db) {
          AudioClip(source: voice, range: 10ms ..< 30ms, fadeIn: 2ms);
        }
      }
    }
    TimelineEdit(id: "processed-external", operations: [
      editSlip(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        range: 0ms ..< 20ms,
        by: avTime(audio: -4ms)
      )
    ]);
  }
}
export out = render(main);`;

const retimedExternalHandle = `cut 0.4;
project "retimed external handle";
import { AudioTrack, AudioRegion, TimelineEdit, editSelection, editSlip, avTime } from "@cut/edit";
import { AudioClip, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 200ms, fps: 25, sampleRate: 48khz) {
  scene only(duration: 200ms) {
    AudioTrack(trackId: "dialogue") {
      AudioRegion(destination: 0ms ..< 200ms, headHandle: 40ms, tailHandle: 40ms, editId: "line") {
        TimeStretch(sourceDuration: 100ms, duration: 200ms, quality: "draft") {
          AudioClip(source: voice, range: 40ms ..< 140ms);
        }
      }
    }
    TimelineEdit(id: "retimed-external", operations: [
      editSlip(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        range: 0ms ..< 200ms,
        by: avTime(audio: -40ms)
      )
    ]);
  }
}
export out = render(main);`;

test("faded direct audio slide admits declared media handles through one authenticated evaluation envelope", () => {
  const ir = compile(fadedSlide);
  const origins = Object.values(ir.nodes).filter((node) =>
    node.op === "cut.edit.timeline_audio_origin"
    && node.inputs.evaluationSource !== undefined);
  assert.ok(origins.length >= 1);
});

test("linked boundary adjustment admits faded audio history inside declared handles", () => {
  const ir = compile(fadedBoundary);
  const origins = Object.values(ir.nodes).filter((node) =>
    node.op === "cut.edit.timeline_audio_origin"
    && node.inputs.evaluationSource !== undefined);
  assert.ok(origins.length >= 1);
});

test("static exact-1x and constant-retimed processed handles compile into authenticated full-domain origins", () => {
  const processed = compile(processedExternalHandle);
  const origin = Object.values(processed.nodes).find((node) =>
    node.op === "cut.edit.timeline_audio_origin"
    && node.inputs.originKind?.kind === "string"
    && node.inputs.originKind.value === "processed-audio");
  assert.ok(origin);
  assert.equal(origin.inputs.evaluationPolicy?.kind === "string"
    ? origin.inputs.evaluationPolicy.value : undefined, "full-declared-handle-domain-v1");
  const retimed = compile(retimedExternalHandle);
  const retimedOrigin = Object.values(retimed.nodes).find((node) =>
    node.op === "cut.edit.timeline_audio_origin"
    && node.inputs.originKind?.kind === "string"
    && node.inputs.originKind.value === "processed-audio");
  assert.ok(retimedOrigin);
  assert.equal(retimedOrigin.inputs.evaluationPolicy?.kind === "string"
    ? retimedOrigin.inputs.evaluationPolicy.value : undefined, "full-declared-handle-domain-v1");
  assert.deepEqual(retimedOrigin.inputs.rate, {
    kind: "quantity",
    dimension: "scalar",
    unit: "scalar",
    magnitude: { numerator: "1", denominator: "2" },
  });
});

test("scene-local audiovisual NestedSequence cannot masquerade as one editable track", () => {
  expectSourceRefusal(
    audiovisualNestedSequence,
    "CUT_TIMELINE_EDIT_UNSUPPORTED",
    /NestedSequence is one audiovisual execution owner, not one editable track/u,
  );
});
