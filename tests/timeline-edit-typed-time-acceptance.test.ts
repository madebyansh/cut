import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { validateCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { pictureSpeedRampSourceOffset } from "../lib/language/picture-time-map";
import { rational } from "../lib/language/rational";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  referencePictureDecoderFrame,
  referencePictureTimeMapConfig,
} from "../lib/runtime/reference/picture-time-map";

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) {
  return compileCutModule(moduleFor(source)).ir;
}

function pictureProgram(
  controls: string,
  range = "0s ..< 1s",
  project = "typed time direct picture",
) {
  return `cut 0.4;
project "${project}";
import { Sequence, PictureTrack, PictureClip, speedPoint } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 8, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(trackId: "picture", role: "primary") {
        PictureClip(
          source: source,
          range: ${range},
          duration: 1s,
          editId: "mapped"${controls}
        );
      }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function structurallySlicedRampProgram() {
  return `cut 0.4;
project "typed time structural picture";
import {
  Sequence, PictureTrack, PictureClip, TimelineEdit,
  editSelection, avTime, editSplit, speedPoint
} from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 8, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(trackId: "picture", role: "primary") {
        PictureClip(
          source: source,
          range: 0s ..< 1s,
          duration: 1s,
          editId: "ramp",
          speedRamp: [
            speedPoint(at: 0s, rate: 0.5),
            speedPoint(at: 500ms, rate: 1.5),
            speedPoint(at: 1s, rate: 0.5)
          ],
          frameSelection: "nearest"
        );
      }
    }
    TimelineEdit(id: "split-ramp", operations: [
      editSplit(
        selection: editSelection(
          trackIds: ["picture"],
          originIds: ["ramp"]
        ),
        at: avTime(picture: 500ms)
      )
    ]);
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function audioRegionProgram(quality: "draft" | "balanced" | "studio") {
  return `cut 0.4;
project "typed time audio policy";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 200ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 200ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(destination: 0ms ..< 200ms, editId: "retimed") {
        TimeStretch(
          sourceDuration: 100ms,
          duration: 200ms,
          pitch: 3,
          quality: "${quality}"
        ) {
          AudioClip(source: voice, range: 0ms ..< 100ms);
        }
      }
    }
  }
}
export out = render(main);`;
}

function pictureClip(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) =>
    candidate.op === "cut.edit.picture_clip");
  assert.ok(node);
  return node;
}

function pictureTrack(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) =>
    candidate.op === "cut.edit.picture_track");
  assert.ok(node?.editorial?.kind === "picture-track");
  return node as IRNode & {
    editorial: Extract<NonNullable<IRNode["editorial"]>, {
      kind: "picture-track";
    }>;
  };
}

function withLockedEightFpsVideo(ir: CutAVIR) {
  const exact = structuredClone(ir);
  for (const resource of Object.values(exact.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = {
      bytes: 1,
      probe: {
        kind: "media",
        identity: {
          streams: [{
            index: 0,
            type: "video",
            frameRate: rational(8),
            timeBase: rational(1, 8),
            start: rational(0),
            duration: rational(2),
            width: 64,
            height: 64,
          }],
        },
        selected: {
          video: {
            streamIndex: 0,
            duration: rational(2),
            durationSource: "decoded-video-cadence",
            timeBase: rational(1, 8),
            decodedVideoCadence: {
              format: "cut-decoded-video-cadence",
              version: 2,
              method: "ffprobe-show-frames-cfr-v2",
              quantization: "phase-floor",
              phaseNumerator: "0",
              streamIndex: 0,
              firstPts: "0",
              lastPts: "15",
              quantizedEndPts: "16",
              frameCount: "16",
              durationPresentCount: "16",
              durationCoverage: "complete",
              recordsSha256: "a".repeat(64),
              timeBase: rational(1, 8),
              frameRate: rational(8),
            },
          },
        },
      },
    } as never;
  }
  exact.determinism.semantic = "locked";
  return exact;
}

function configOf(ir: CutAVIR) {
  const locked = withLockedEightFpsVideo(ir);
  const config = referencePictureTimeMapConfig(
    locked,
    locked.compositions[0]!,
    pictureClip(locked),
  );
  assert.ok(config);
  return config;
}

function compileDiagnostic(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module!);
  if (checked.diagnostics.length) return checked.diagnostics[0]!;
  try {
    compileCutModule(parsed.module!);
  } catch (error) {
    assert.ok(error instanceof CutCompileError);
    assert.ok(error.result.diagnostics.length > 0);
    return error.result.diagnostics[0]!;
  }
  assert.fail("expected source to fail before IR publication");
}

test("public PictureClip maps forward hold, nearest, reverse, freeze, and a variable ramp with exact rational clocks", () => {
  const floor = configOf(compile(pictureProgram(
    ', rate: 0.75, frameSelection: "floor"',
    "0s ..< 750ms",
  )));
  assert.deepEqual(floor.map, {
    kind: "constant",
    direction: "forward",
    rate: rational(3, 4),
  });
  assert.deepEqual(
    Array.from({ length: 8 }, (_, frame) =>
      referencePictureDecoderFrame(floor, frame)),
    [0, 0, 1, 2, 3, 3, 4, 5],
    "phase-floor must hold the preceding decoded frame",
  );

  const nearest = configOf(compile(pictureProgram(
    ', rate: 0.75, frameSelection: "nearest"',
    "0s ..< 750ms",
  )));
  assert.deepEqual(nearest.map, {
    kind: "constant",
    direction: "forward",
    rate: rational(3, 4),
    frameSelection: "nearest",
  });
  assert.deepEqual(
    Array.from({ length: 8 }, (_, frame) =>
      referencePictureDecoderFrame(nearest, frame)),
    [0, 1, 1, 2, 3, 4, 4, 5],
    "nearest must advance only above one half and retain the preceding frame on ties",
  );

  const reverse = configOf(compile(pictureProgram(
    ', playback: "reverse", rate: 1',
  )));
  assert.deepEqual(reverse.map, {
    kind: "constant",
    direction: "reverse",
    rate: rational(1),
  });
  assert.equal(reverse.reverseDecode, true);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, frame) =>
      referencePictureDecoderFrame(reverse, frame)),
    [0, 1, 2, 3, 4, 5, 6, 7],
    "the reverse decoder plan must publish its already-reversed frames in order",
  );

  const freeze = configOf(compile(pictureProgram(
    ', playback: "freeze", freezeAt: 375ms',
  )));
  assert.deepEqual(freeze.map, { kind: "freeze", at: rational(3, 8) });
  assert.deepEqual(freeze.decodeStart, rational(3, 8));
  assert.equal(freeze.sourceFrameCount, 1);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, frame) =>
      referencePictureDecoderFrame(freeze, frame)),
    Array(8).fill(0),
  );

  const ramp = configOf(compile(pictureProgram(
    `, speedRamp: [
      speedPoint(at: 0s, rate: 0.5),
      speedPoint(at: 500ms, rate: 1.5),
      speedPoint(at: 1s, rate: 0.5)
    ]`,
  )));
  assert.equal(ramp.map.kind, "speed-ramp");
  if (ramp.map.kind !== "speed-ramp") throw new Error("missing speed ramp");
  const rampMap = ramp.map;
  assert.deepEqual(
    [
      rational(0),
      rational(1, 8),
      rational(1, 4),
      rational(3, 8),
      rational(1, 2),
      rational(5, 8),
      rational(3, 4),
      rational(7, 8),
      rational(1),
    ].map((time) => pictureSpeedRampSourceOffset(rampMap, time)),
    [
      rational(0),
      rational(5, 64),
      rational(3, 16),
      rational(21, 64),
      rational(1, 2),
      rational(43, 64),
      rational(13, 16),
      rational(59, 64),
      rational(1),
    ],
  );
  assert.deepEqual(
    Array.from({ length: 8 }, (_, frame) =>
      referencePictureDecoderFrame(ramp, frame)),
    [0, 0, 1, 2, 4, 5, 6, 7],
  );
});

test("TimelineEdit split preserves both exact halves of one variable source-time map", () => {
  const ir = compile(structurallySlicedRampProgram());
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
  const track = pictureTrack(ir);
  assert.equal(track.editorial.items.length, 2);
  assert.deepEqual(
    track.editorial.items.map((item) => ({
      destination: item.destination,
      source: item.source,
      timeMap: item.timeMap,
    })),
    [
      {
        destination: { start: rational(0), duration: rational(1, 2) },
        source: { start: rational(0), duration: rational(1, 2) },
        timeMap: {
          kind: "speed-ramp",
          interpolation: "linear-rate",
          frameSelection: "nearest",
          points: [
            { at: rational(0), rate: rational(1, 2) },
            { at: rational(1, 2), rate: rational(3, 2) },
          ],
        },
      },
      {
        destination: { start: rational(1, 2), duration: rational(1, 2) },
        source: { start: rational(1, 2), duration: rational(1, 2) },
        timeMap: {
          kind: "speed-ramp",
          interpolation: "linear-rate",
          frameSelection: "nearest",
          points: [
            { at: rational(0), rate: rational(3, 2) },
            { at: rational(1, 2), rate: rational(1, 2) },
          ],
        },
      },
    ],
  );
  const inspected = inspectCutIr(ir, "typed-time-structural.cut");
  const inspectedTrack = inspected.graph.nodes.find((node) =>
    node.pictureEditorial?.kind === "picture-track");
  assert.deepEqual(
    inspectedTrack?.pictureEditorial?.items.map((item) => item.timeMap),
    track.editorial.items.map((item) => item.timeMap),
  );
});

test("public AudioRegion binds exact constant duration, pitch, and quality policy", () => {
  const draft = compile(audioRegionProgram("draft"));
  const balanced = compile(audioRegionProgram("balanced"));
  const stretch = Object.values(draft.nodes).find((node) =>
    node.op === "cut.audio.time_stretch");
  assert.ok(stretch);
  assert.deepEqual(stretch.inputs.sourceDuration, {
    kind: "quantity",
    dimension: "time",
    magnitude: rational(1, 10),
    unit: "s",
  });
  assert.deepEqual(stretch.inputs.duration, {
    kind: "quantity",
    dimension: "time",
    magnitude: rational(1, 5),
    unit: "s",
  });
  assert.deepEqual(stretch.inputs.pitch, {
    kind: "quantity",
    dimension: "scalar",
    magnitude: rational(3),
    unit: "scalar",
  });
  assert.deepEqual(stretch.inputs.quality, {
    kind: "string",
    value: "draft",
  });
  assert.notEqual(
    draft.buildId,
    balanced.buildId,
    "the selected executable quality tier must participate in build identity",
  );
});

test("reserved picture sampling and unsupported audio quality fail source-located before allocation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-typed-time-refusal-"));
  try {
    const before = await readdir(root, { recursive: true });
    assert.deepEqual(before, []);
    const cases = [
      {
        label: "optical flow",
        source: pictureProgram(', frameSelection: "optical-flow"'),
        code: "CUT2086",
        message: /optical-flow.*not executable/u,
        sourceNeedle: "PictureClip(",
      },
      {
        label: "unsupported audio quality",
        source: audioRegionProgram("studio"),
        code: "CUT2068",
        message: /quality.*draft.*balanced/u,
        sourceNeedle: 'quality: "studio"',
      },
    ] as const;

    for (const item of cases) {
      const diagnostic = compileDiagnostic(item.source);
      assert.equal(diagnostic.code, item.code, item.label);
      assert.match(diagnostic.message, item.message, item.label);
      assert.equal(
        diagnostic.span.start.line,
        item.source.split("\n").findIndex((line) =>
          line.includes(item.sourceNeedle)) + 1,
        `${item.label} diagnostic lost its authored source line`,
      );
      assert.ok(diagnostic.span.start.column > 0, item.label);
      assert.deepEqual(
        await readdir(root, { recursive: true }),
        before,
        `${item.label} allocated cache/output state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("general variable audio remap and animated TimeStretch refuse instead of executing a constant substitute", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-variable-audio-refusal-"));
  try {
    const generalRemap = `cut 0.4;
project "variable audio TimeRemap refusal";
import { TimeRemap } from "@cut/edit";
import { Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 1s) {
    TimeRemap(curve: "variable") {
      Tone(frequency: 440hz, duration: 1s);
    }
  }
}
export out = render(main);`;
    const generalDiagnostic = compileDiagnostic(generalRemap);
    assert.equal(generalDiagnostic.code, "CUT2058");
    assert.match(
      generalDiagnostic.message,
      /cut\.edit\.time_remap.*not implemented/u,
    );
    assert.equal(
      generalDiagnostic.span.start.line,
      generalRemap.split("\n").findIndex((line) =>
        line.includes("TimeRemap(")) + 1,
    );

    const animatedStretch = `cut 0.4;
project "animated TimeStretch refusal";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 200ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 200ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(destination: 0ms ..< 200ms, editId: "variable") {
        TimeStretch(
          sourceDuration: 100ms,
          duration: 200ms,
          pitch: 0,
          quality: "draft"
        ) as retime {
          AudioClip(source: voice, range: 0ms ..< 100ms);
        }
        at 50ms { set retime.pitch = 1; }
      }
    }
  }
}
export out = render(main);`;
    const animatedDiagnostic = compileDiagnostic(animatedStretch);
    assert.equal(animatedDiagnostic.code, "CUT2060");
    assert.match(animatedDiagnostic.message, /time_stretch.*pitch/u);
    assert.equal(
      animatedDiagnostic.span.start.line,
      animatedStretch.split("\n").findIndex((line) =>
        line.includes("set retime.pitch")) + 1,
    );
    assert.deepEqual(
      await readdir(root, { recursive: true }),
      [],
      "a refused variable audio clock allocated cache/output state",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
