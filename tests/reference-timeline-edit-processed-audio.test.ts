import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { executeTimelineEditPlan } from "../lib/language/timeline-edit-operations";
import { inspectCutIr } from "../lib/runtime/inspect";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import {
  referenceMasterAudioRootIds,
  renderReferenceAudioSelection,
} from "../lib/runtime/reference/audio";
import { renderReferenceAudioStems } from "../lib/runtime/reference/stems";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { validateReferenceTimelineEditMaterializations } from "../lib/runtime/reference/timeline-edit";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function audioTrack(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.edit.audio_track");
  assert.ok(node?.editorial?.kind === "audio-track");
  return node as IRNode & {
    editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }>;
  };
}

function program(authority: "timeline" | "legacy") {
  const trackInputs = authority === "legacy"
    ? `trackId: "dialogue", role: "dialogue", sourceDuration: 20ms,
      edits: [audioCrossfadeAt(at: 10ms, duration: 4ms, curve: "equal-power")]`
    : `trackId: "dialogue", role: "dialogue"`;
  const timelineEdit = authority === "timeline"
    ? `
    TimelineEdit(
      id: "processed-transition",
      operations: [
        editTransition(
          left: editSelection(trackIds: ["dialogue"], originIds: ["left"]),
          right: editSelection(trackIds: ["dialogue"], originIds: ["right"]),
          at: avTime(audio: 10ms),
          duration: avTime(audio: 4ms),
          audioCurve: "equal-power"
        )
      ]
    );`
    : "";
  return `cut 0.4;
project "TimelineEdit processed audio runtime";
import {
  AudioTrack, AudioRegion, TimelineEdit, audioCrossfadeAt,
  editSelection, avTime, editTransition, editSplit
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(${trackInputs}) {
      AudioRegion(
        destination: 0ms ..< 10ms,
        tailHandle: 2ms,
        editId: "left",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 80hz) {
            AudioClip(source: voice, range: 2ms ..< 12ms);
          }
        }
      }
      AudioRegion(
        destination: 10ms ..< 20ms,
        headHandle: 2ms,
        editId: "right",
        role: "dialogue"
      ) {
        Gain(amount: -6db) {
          HighPass(frequency: 120hz) {
            AudioClip(source: voice, range: 12ms ..< 22ms);
          }
        }
      }
    }${timelineEdit}
  }
}
export out = render(main);`;
}

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

async function lockProject(ir: CutAVIR, root: string) {
  await writeFile(
    resolve(root, "voice.wav"),
    monoPcm16Wave(
      48_000,
      Array.from({ length: 48_000 }, (_, index) =>
        Math.round(Math.sin(index / 13) * 500 + Math.cos(index / 31) * 100)),
    ),
  );
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return lock;
}

test("public TimelineEdit processed transition renders exact PCM equal to the established AudioRegion crossfade law", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-audio-"));
  const timelineRoot = resolve(root, "timeline");
  const legacyRoot = resolve(root, "legacy");
  await Promise.all([mkdir(timelineRoot), mkdir(legacyRoot)]);
  try {
    const timeline = compile(program("timeline"));
    const legacy = compile(program("legacy"));
    await lockProject(timeline, timelineRoot);
    await lockProject(legacy, legacyRoot);

    assert.equal(timeline.timelineEdits?.length, 1);
    assert.equal(audioTrack(timeline).editorial.operationPlan, undefined);
    assert.equal(audioTrack(timeline).editorial.transitions?.length, 1);
    assert.equal(audioTrack(legacy).editorial.operationPlan?.version, 2);
    assert.doesNotThrow(() => validateReferenceSession(timeline));
    assert.doesNotThrow(() => validateReferenceSession(legacy));

    const processedOrigins = Object.values(timeline.nodes)
      .filter((node) => node.op === "cut.edit.timeline_audio_origin")
      .sort((left, right) => {
        const leftSource = left.inputs.evaluationSource;
        const rightSource = right.inputs.evaluationSource;
        assert.ok(leftSource?.kind === "range");
        assert.ok(rightSource?.kind === "range");
        assert.ok(leftSource.start.kind === "quantity");
        assert.ok(rightSource.start.kind === "quantity");
        const leftStart = leftSource.start.magnitude;
        const rightStart = rightSource.start.magnitude;
        return Number(leftStart.numerator) / Number(leftStart.denominator)
          - Number(rightStart.numerator) / Number(rightStart.denominator);
      });
    assert.equal(processedOrigins.length, 2);
    assert.deepEqual(
      processedOrigins.map((origin) => ({
        originKind: origin.inputs.originKind,
        evaluationSource: origin.inputs.evaluationSource,
        presentationZero: origin.inputs.presentationZero,
        fadeAnchorPolicy: origin.inputs.fadeAnchorPolicy,
        evaluationPolicy: origin.inputs.evaluationPolicy,
      })),
      [
        {
          originKind: { kind: "string", value: "processed-audio" },
          evaluationSource: {
            kind: "range",
            start: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(1, 500) },
            end: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(7, 500) },
            exclusive: true,
          },
          presentationZero: {
            kind: "quantity",
            dimension: "time",
            unit: "s",
            magnitude: rational(0),
          },
          fadeAnchorPolicy: { kind: "string", value: "origin-relative-at-presentation-zero" },
          evaluationPolicy: { kind: "string", value: "full-declared-handle-domain-v1" },
        },
        {
          originKind: { kind: "string", value: "processed-audio" },
          evaluationSource: {
            kind: "range",
            start: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(1, 100) },
            end: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(11, 500) },
            exclusive: true,
          },
          presentationZero: {
            kind: "quantity",
            dimension: "time",
            unit: "s",
            magnitude: rational(1, 500),
          },
          fadeAnchorPolicy: { kind: "string", value: "origin-relative-at-presentation-zero" },
          evaluationPolicy: { kind: "string", value: "full-declared-handle-domain-v1" },
        },
      ],
    );
    const validation = validateReferenceTimelineEditMaterializations(timeline);
    assert.deepEqual(
      validation.audioEvaluation?.origins,
      processedOrigins
        .map((origin) => ({
          originNodeId: origin.id,
          evaluationPolicy: "full-declared-handle-domain-v1" as const,
          sourceSamples: 576,
          processingSamples: 576,
          processorCount: 2,
          processorSampleWork: 1_728,
        }))
        .sort((left, right) => left.originNodeId.localeCompare(right.originNodeId)),
    );
    assert.equal(validation.audioEvaluation?.aggregateSourceSamples, 1_152);
    assert.equal(validation.audioEvaluation?.aggregateProcessorSampleWork, 3_456);

    const [timelineArtifact, legacyArtifact] = await Promise.all([
      renderReferenceAudioArtifact(timeline, timeline.compositions[0]!, timelineRoot),
      renderReferenceAudioArtifact(legacy, legacy.compositions[0]!, legacyRoot),
    ]);
    const [timelinePcm, legacyPcm] = await Promise.all([
      readFile(timelineArtifact.path),
      readFile(legacyArtifact.path),
    ]);
    assert.deepEqual(timelinePcm, legacyPcm);
    const replay = await renderReferenceAudioArtifact(
      timeline,
      timeline.compositions[0]!,
      timelineRoot,
    );
    assert.equal(timelineArtifact.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), timelinePcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TimelineEdit processed graph mutation is refused by full session validation before cache or output allocation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-hostile-"));
  try {
    const ir = compile(program("timeline"));
    await lockProject(ir, root);
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const before = (await readdir(root, { recursive: true })).sort();
    const gain = Object.values(ir.nodes).find((node) => node.op === "cut.audio.gain");
    assert.ok(gain?.inputs.amount?.kind === "quantity");
    gain.inputs.amount.magnitude = { numerator: "-9", denominator: "1" };
    assert.throws(
      () => validateReferenceSession(ir),
      /CUT_TIMELINE_EDIT_RESULT/u,
    );
    assert.deepEqual(
      (await readdir(root, { recursive: true })).sort(),
      before,
      "session-level graph rejection created cache/output state",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function directFadeProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit origin-clock direct fade";
import { AudioTrack, TimelineEdit, editSelection, avTime, editSplit } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 0ms ..< 20ms,
        destination: 0ms ..< 20ms,
        fadeIn: 4ms,
        fadeOut: 4ms,
        editId: "line"
      );
    }
    ${withEdit ? `TimelineEdit(
      id: "split-faded-line",
      operations: [
        editSplit(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
          at: avTime(audio: 10ms)
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function directFadeSlipProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit origin-clock direct fade slip";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editTrim, editSlip
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 10ms ..< 30ms,
        destination: 0ms ..< 20ms,
        fadeIn: 4ms,
        fadeOut: 4ms,
        editId: "line"
      );
    }
    ${withEdit ? `TimelineEdit(
      id: "trim-slip-faded-line",
      operations: [
        editTrim(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
          keep: 4ms ..< 16ms
        ),
        editSlip(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
          range: 4ms ..< 16ms,
          by: avTime(audio: 2ms)
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function directFadeSlideProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit origin-clock direct fade slide";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editSplit, editSlide
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 60ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 60ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 0ms ..< 60ms,
        destination: 0ms ..< 60ms,
        fadeIn: 6ms,
        fadeOut: 6ms,
        editId: "line"
      );
    }
    ${withEdit ? `TimelineEdit(
      id: "split-slide-faded-line",
      operations: [
        editSplit(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
          at: avTime(audio: 20ms)
        ),
        editSplit(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
          at: avTime(audio: 40ms)
        ),
        editSlide(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
          range: 20ms ..< 40ms,
          by: avTime(audio: 4ms)
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function directFadeExternalHeadProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit direct fade external head";
import {
  AudioTrack, AudioGap, TimelineEdit, editSelection, avTime, editSlip
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioGap(destination: 0ms ..< 10ms);
      AudioClip(
        source: voice,
        range: 10ms ..< 30ms,
        destination: 10ms ..< 30ms,
        headHandle: 10ms,
        tailHandle: 10ms,
        fadeIn: 2ms,
        fadeOut: 2ms,
        editId: "line"
      );
      AudioGap(destination: 30ms ..< 40ms);
    }
    ${withEdit ? `TimelineEdit(
      id: "external-head-faded-line",
      operations: [
        editSlip(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["line"]
          ),
          range: 10ms ..< 30ms,
          by: avTime(audio: -4ms)
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function directFadeSceneBoundaryHandleProgram(
  direction: "head" | "tail",
  withEdit: boolean,
) {
  const by = direction === "head" ? "-4ms" : "4ms";
  const fades = direction === "head" ? "fadeOut: 2ms," : "fadeIn: 2ms,";
  return `cut 0.4;
project "TimelineEdit direct fade ${direction} scene boundary";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editSlip
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 10ms ..< 30ms,
        destination: 0ms ..< 20ms,
        headHandle: 10ms,
        tailHandle: 10ms,
        ${fades}
        editId: "line"
      );
    }
    ${withEdit ? `TimelineEdit(
      id: "external-${direction}-faded-line",
      operations: [
        editSlip(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["line"]
          ),
          range: 0ms ..< 20ms,
          by: avTime(audio: ${by})
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function directFadeSceneBoundaryHandleControlProgram(direction: "head" | "tail") {
  const start = direction === "head" ? "6ms" : "14ms";
  const end = direction === "head" ? "26ms" : "34ms";
  return `cut 0.4;
project "TimelineEdit direct fade ${direction} scene-boundary control";
import { AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: ${start} ..< ${end},
        destination: 0ms ..< 20ms
      );
    }
  }
}
export out = render(main);`;
}

function directFadeTransitionProgram(faded = true) {
  return `cut 0.4;
project "TimelineEdit direct faded transition";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editSplit, editTransition
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 0ms ..< 20ms,
        destination: 0ms ..< 20ms,
        ${faded ? "fadeIn: 4ms, fadeOut: 4ms," : ""}
        editId: "line"
      );
    }
    TimelineEdit(
      id: "direct-faded-transition",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["line"]
          ),
          at: avTime(audio: 10ms)
        ),
        editTransition(
          left: editSelection(
            trackIds: ["dialogue"],
            originIds: ["line"]
          ),
          right: editSelection(
            trackIds: ["dialogue"],
            originIds: ["line"]
          ),
          at: avTime(audio: 10ms),
          duration: avTime(audio: 4ms),
          audioCurve: "equal-power"
        )
      ]
    );
  }
}
export out = render(main);`;
}

function directTwoOriginTransitionProgram(options: Readonly<{
  faded: boolean;
  transition: boolean;
}>) {
  return `cut 0.4;
project "TimelineEdit direct two-origin faded transition";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editTransition
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 2ms ..< 12ms,
        destination: 0ms ..< 10ms,
        tailHandle: 2ms,
        ${options.faded ? "fadeIn: 4ms," : ""}
        editId: "left"
      );
      AudioClip(
        source: voice,
        range: 12ms ..< 22ms,
        destination: 10ms ..< 20ms,
        headHandle: 2ms,
        ${options.faded ? "fadeOut: 4ms," : ""}
        editId: "right"
      );
    }
    ${options.transition ? `TimelineEdit(
      id: "direct-two-origin-transition",
      operations: [
        editTransition(
          left: editSelection(trackIds: ["dialogue"], originIds: ["left"]),
          right: editSelection(trackIds: ["dialogue"], originIds: ["right"]),
          at: avTime(audio: 10ms),
          duration: avTime(audio: 4ms),
          audioCurve: "equal-power"
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function processedTrimProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit origin-clock processed trim";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editTrim
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 20ms,
        editId: "processed-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 800hz) {
            AudioClip(
              source: voice,
              range: 0ms ..< 20ms,
              fadeIn: 4ms,
              fadeOut: 4ms
            );
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "split-trim-processed-line",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          at: avTime(audio: 10ms)
        ),
        editTrim(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          keep: 0ms ..< 15ms
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function processedExternalStateProgram(kind: "candidate" | "control") {
  const candidate = kind === "candidate";
  return `cut 0.4;
project "TimelineEdit processed external state ${kind}";
import {
  AudioTrack, AudioRegion, AudioGap, TimelineEdit,
  editSelection, avTime, editSlip, editTrim
} from "@cut/edit";
import { AudioClip, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: ${candidate ? "0ms ..< 20ms" : "0ms ..< 40ms"},
        ${candidate ? "headHandle: 10ms, tailHandle: 10ms," : ""}
        editId: "processed-line",
        role: "dialogue"
      ) {
        HighPass(frequency: 800hz) {
          AudioClip(
            source: voice,
            range: ${candidate ? "10ms ..< 30ms" : "0ms ..< 40ms"}
          );
        }
      }
      ${candidate ? "AudioGap(destination: 20ms ..< 40ms);" : ""}
    }
    TimelineEdit(
      id: "processed-external-state",
      operations: [
        ${candidate
          ? `editSlip(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["processed-line"]),
          range: 0ms ..< 20ms,
          by: avTime(audio: -4ms)
        )`
          : `editTrim(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["processed-line"]),
          keep: 6ms ..< 26ms
        )`}
      ]
    );
  }
}
export out = render(main);`;
}

function processedExternalFadeProgram() {
  return `cut 0.4;
project "TimelineEdit processed external fade";
import {
  AudioTrack, AudioRegion, AudioGap, TimelineEdit,
  editSelection, avTime, editSlip
} from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioGap(destination: 0ms ..< 10ms);
      AudioRegion(
        destination: 10ms ..< 30ms,
        headHandle: 10ms,
        tailHandle: 10ms,
        editId: "processed-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          AudioClip(
            source: voice,
            range: 10ms ..< 30ms,
            fadeIn: 2ms,
            fadeOut: 2ms
          );
        }
      }
      AudioGap(destination: 30ms ..< 40ms);
    }
    TimelineEdit(
      id: "processed-external-fade",
      operations: [
        editSlip(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["processed-line"]),
          range: 10ms ..< 30ms,
          by: avTime(audio: -4ms)
        )
      ]
    );
  }
}
export out = render(main);`;
}

function processedExternalFadeControlProgram() {
  return `cut 0.4;
project "TimelineEdit processed external fade control";
import { AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioGap(destination: 0ms ..< 14ms);
      AudioRegion(
        destination: 14ms ..< 30ms,
        editId: "processed-control",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          AudioClip(
            source: voice,
            range: 10ms ..< 26ms,
            fadeIn: 2ms
          );
        }
      }
      AudioGap(destination: 30ms ..< 40ms);
    }
  }
}
export out = render(main);`;
}

function multiTrackProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit atomic processed multi-track";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 0ms ..< 20ms,
        destination: 0ms ..< 20ms,
        fadeIn: 4ms,
        fadeOut: 4ms,
        editId: "direct-a"
      );
      AudioClip(
        source: voice,
        range: 20ms ..< 40ms,
        destination: 20ms ..< 40ms,
        fadeIn: 4ms,
        fadeOut: 4ms,
        editId: "direct-b"
      );
    }
    AudioTrack(trackId: "effects", role: "sfx") {
      AudioRegion(
        destination: 0ms ..< 20ms,
        editId: "processed-a",
        role: "sfx"
      ) {
        Gain(amount: -9db) {
          HighPass(frequency: 500hz) {
            AudioClip(
              source: voice,
              range: 0ms ..< 20ms,
              fadeIn: 4ms,
              fadeOut: 4ms
            );
          }
        }
      }
      AudioRegion(
        destination: 20ms ..< 40ms,
        editId: "processed-b",
        role: "sfx"
      ) {
        Gain(amount: -12db) {
          HighPass(frequency: 1200hz) {
            AudioClip(
              source: voice,
              range: 20ms ..< 40ms,
              fadeIn: 4ms,
              fadeOut: 4ms
            );
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "atomic-two-track-splits",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue", "effects"],
            originIds: ["direct-a", "processed-a"]
          ),
          at: avTime(audio: 10ms)
        ),
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue", "effects"],
            originIds: ["direct-b", "processed-b"]
          ),
          at: avTime(audio: 30ms)
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function processedMultiItemRemovalProgram(
  operation: "none" | "lift" | "extract",
) {
  const edit = operation === "none"
    ? ""
    : `TimelineEdit(
      id: "${operation}-two-processed-origins",
      operations: [
        ${operation === "lift" ? "editLift" : "editExtract"}(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["first-line", "second-line"]
          ),
          range: 10ms ..< 30ms
        )
      ]
    );`;
  return `cut 0.4;
project "TimelineEdit processed multi-item removal";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, editLift, editExtract
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 20ms,
        editId: "first-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 500hz) {
            AudioClip(
              source: voice,
              range: 0ms ..< 20ms,
              fadeIn: 4ms,
              fadeOut: 4ms
            );
          }
        }
      }
      AudioRegion(
        destination: 20ms ..< 40ms,
        editId: "second-line",
        role: "dialogue"
      ) {
        Gain(amount: -9db) {
          HighPass(frequency: 1200hz) {
            AudioClip(
              source: voice,
              range: 20ms ..< 40ms,
              fadeIn: 4ms,
              fadeOut: 4ms
            );
          }
        }
      }
    }
    ${edit}
  }
}
export out = render(main);`;
}

function processedExactOneRippleProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit exact-1x processed ripple";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, editRippleDelete
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 40ms,
        editId: "processed-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 800hz) {
            AudioClip(
              source: voice,
              range: 0ms ..< 40ms,
              fadeIn: 8ms,
              fadeOut: 8ms
            );
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "ripple-exact-1x-processed-middle",
      operations: [
        editRippleDelete(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          range: 10ms ..< 30ms
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function fadedDirectRemovalProgram(
  operation: "none" | "lift" | "extract" | "ripple-delete",
) {
  const operationCall = operation === "none"
    ? ""
    : operation === "lift"
      ? "editLift"
      : operation === "extract"
        ? "editExtract"
        : "editRippleDelete";
  const edit = operation === "none"
    ? ""
    : `TimelineEdit(
      id: "${operation}-faded-direct-middle",
      operations: [
        ${operationCall}(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["faded-line"]
          ),
          range: 10ms ..< 30ms
        )
      ]
    );`;
  return `cut 0.4;
project "TimelineEdit faded direct removal";
import {
  AudioTrack, TimelineEdit,
  editSelection, editLift, editExtract, editRippleDelete
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 0ms ..< 40ms,
        destination: 0ms ..< 40ms,
        fadeIn: 8ms,
        fadeOut: 8ms,
        editId: "faded-line"
      );
    }
    ${edit}
  }
}
export out = render(main);`;
}

async function renderLockedSource(source: string, root: string) {
  const ir = compile(source);
  await lockProject(ir, root);
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const artifact = await renderReferenceAudioArtifact(ir, ir.compositions[0]!, root);
  return { ir, artifact, pcm: await readFile(artifact.path) };
}

async function renderLockedRawSource(source: string, root: string) {
  const ir = compile(source);
  await lockProject(ir, root);
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const output = resolve(root, "selection.f32le");
  const composition = ir.compositions[0]!;
  await renderReferenceAudioSelection(
    ir,
    composition,
    root,
    output,
    referenceMasterAudioRootIds(ir, composition),
    { outputFormat: "raw-stereo-f32le" },
  );
  return { ir, pcm: await readFile(output) };
}

function stereoF32SliceWithSilence(
  pcm: Buffer,
  keptFrames: number,
  totalFrames: number,
) {
  const frameBytes = 2 * 4;
  assert.equal(pcm.length, totalFrames * frameBytes);
  return Buffer.concat([
    pcm.subarray(0, keptFrames * frameBytes),
    Buffer.alloc((totalFrames - keptFrames) * frameBytes),
  ]);
}

function assertStereoF32ValuesEqual(
  actual: Buffer,
  expected: Buffer,
  message: string,
) {
  assert.equal(actual.length, expected.length, `${message}: byte length`);
  for (let offset = 0; offset < actual.length; offset += 4) {
    const actualValue = actual.readFloatLE(offset);
    const expectedValue = expected.readFloatLE(offset);
    assert.ok(
      actualValue === expectedValue,
      `${message}: float sample ${offset / 4} differs (${actualValue} !== ${expectedValue})`,
    );
  }
}

test("canonical split of a faded direct AudioClip preserves one origin-clock envelope and exact PCM", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-direct-fade-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(directFadeProgram(false), originRoot);
    const edited = await renderLockedSource(directFadeProgram(true), editedRoot);
    assert.equal(edited.ir.timelineEdits?.length, 1);
    const track = audioTrack(edited.ir);
    assert.equal(track.editorial.items.filter((item) => item.kind === "audio").length, 2);
    assert.deepEqual(
      edited.pcm,
      origin.pcm,
      "the second slice restarted or otherwise changed the origin-relative fade",
    );

    const replay = await renderReferenceAudioArtifact(
      edited.ir,
      edited.ir.compositions[0]!,
      editedRoot,
    );
    assert.equal(edited.artifact.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), edited.pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faded direct AudioClip transition preserves the origin fade before the established crossfade law", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-direct-fade-transition-"));
  const candidateRoot = resolve(root, "candidate");
  const originRoot = resolve(root, "origin");
  const transitionRoot = resolve(root, "transition");
  await Promise.all([mkdir(candidateRoot), mkdir(originRoot), mkdir(transitionRoot)]);
  try {
    const candidate = await renderLockedRawSource(
      directFadeTransitionProgram(true),
      candidateRoot,
    );
    const origin = await renderLockedRawSource(
      directFadeProgram(false),
      originRoot,
    );
    const transition = await renderLockedRawSource(
      directFadeTransitionProgram(false),
      transitionRoot,
    );
    const frameBytes = 8;
    const overlapStart = 8 * 48;
    const overlapEnd = 12 * 48;
    assert.equal(candidate.pcm.length, 960 * frameBytes);
    assert.deepEqual(
      candidate.pcm.subarray(0, overlapStart * frameBytes),
      origin.pcm.subarray(0, overlapStart * frameBytes),
      "pre-overlap samples changed before the transition law",
    );
    assert.deepEqual(
      candidate.pcm.subarray(overlapStart * frameBytes, overlapEnd * frameBytes),
      transition.pcm.subarray(overlapStart * frameBytes, overlapEnd * frameBytes),
      "crossfade was not applied after the already-evaluated origin fade",
    );
    assert.deepEqual(
      candidate.pcm.subarray(overlapEnd * frameBytes),
      origin.pcm.subarray(overlapEnd * frameBytes),
      "post-overlap samples changed after the transition law",
    );
    assert.equal(
      Object.values(candidate.ir.nodes)
        .filter((node) => node.op === "cut.edit.timeline_audio_origin").length,
      1,
    );
    assert.equal(audioTrack(candidate.ir).editorial.transitions?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transition-only faded direct clips virtualize both external-handle origins and preserve exact PCM", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-direct-fade-two-origin-"));
  const candidateRoot = resolve(root, "candidate");
  const hardCutRoot = resolve(root, "hard-cut");
  const transitionRoot = resolve(root, "transition");
  await Promise.all([mkdir(candidateRoot), mkdir(hardCutRoot), mkdir(transitionRoot)]);
  try {
    const candidate = await renderLockedRawSource(
      directTwoOriginTransitionProgram({ faded: true, transition: true }),
      candidateRoot,
    );
    const hardCut = await renderLockedRawSource(
      directTwoOriginTransitionProgram({ faded: true, transition: false }),
      hardCutRoot,
    );
    const transition = await renderLockedRawSource(
      directTwoOriginTransitionProgram({ faded: false, transition: true }),
      transitionRoot,
    );
    const origins = Object.values(candidate.ir.nodes)
      .filter((node) => node.op === "cut.edit.timeline_audio_origin")
      .sort((left, right) => {
        const leftSource = left.inputs.evaluationSource;
        const rightSource = right.inputs.evaluationSource;
        assert.ok(leftSource?.kind === "range");
        assert.ok(rightSource?.kind === "range");
        assert.ok(leftSource.start.kind === "quantity");
        assert.ok(rightSource.start.kind === "quantity");
        const a = leftSource.start.magnitude;
        const b = rightSource.start.magnitude;
        return Number(a.numerator) / Number(a.denominator)
          - Number(b.numerator) / Number(b.denominator);
      });
    assert.equal(origins.length, 2, "transition-only faded clips bypassed origin virtualization");
    assert.deepEqual(
      origins.map((origin) => ({
        kind: origin.inputs.originKind,
        source: origin.inputs.evaluationSource,
        policy: origin.inputs.evaluationPolicy,
      })),
      [
        {
          kind: { kind: "string", value: "direct-audio" },
          source: {
            kind: "range",
            start: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(1, 500) },
            end: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(7, 500) },
            exclusive: true,
          },
          policy: { kind: "string", value: "selected-source-union-v1" },
        },
        {
          kind: { kind: "string", value: "direct-audio" },
          source: {
            kind: "range",
            start: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(1, 100) },
            end: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(11, 500) },
            exclusive: true,
          },
          policy: { kind: "string", value: "selected-source-union-v1" },
        },
      ],
    );
    const frameBytes = 8;
    const overlapStart = 8 * 48;
    const overlapEnd = 12 * 48;
    assert.deepEqual(
      candidate.pcm.subarray(0, overlapStart * frameBytes),
      hardCut.pcm.subarray(0, overlapStart * frameBytes),
    );
    assert.deepEqual(
      candidate.pcm.subarray(overlapStart * frameBytes, overlapEnd * frameBytes),
      transition.pcm.subarray(overlapStart * frameBytes, overlapEnd * frameBytes),
    );
    assert.deepEqual(
      candidate.pcm.subarray(overlapEnd * frameBytes),
      hardCut.pcm.subarray(overlapEnd * frameBytes),
    );

    const first = await renderReferenceAudioArtifact(
      candidate.ir,
      candidate.ir.compositions[0]!,
      candidateRoot,
    );
    const replay = await renderReferenceAudioArtifact(
      candidate.ir,
      candidate.ir.compositions[0]!,
      candidateRoot,
    );
    assert.equal(first.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(first.path), await readFile(replay.path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faded direct-audio slip selects the shifted origin interval while preserving the destination envelope", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-direct-fade-slip-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(
      directFadeSlipProgram(false),
      originRoot,
    );
    const edited = await renderLockedSource(
      directFadeSlipProgram(true),
      editedRoot,
    );
    const plan = edited.ir.timelineEdits?.[0];
    assert.ok(plan);
    const item = executeTimelineEditPlan(plan).tracks
      .find((track) => track.trackId === "dialogue")?.items
      .find((candidate) =>
        candidate.originId === "line"
        && candidate.sourceView.kind === "audio");
    assert.ok(item?.sourceView.kind === "audio");
    assert.deepEqual(item.destination, {
      start: rational(1, 250),
      duration: rational(3, 250),
    });
    assert.deepEqual(item.sourceView.source, {
      start: rational(2, 125),
      duration: rational(3, 250),
    });
    assert.deepEqual(item.sourceView.handles, {
      head: rational(3, 500),
      tail: rational(1, 500),
    });
    assert.deepEqual(item.sourceView.presentationClock, {
      originDuration: rational(1, 50),
      sliceOffset: rational(3, 500),
      fadePolicy: "origin-relative",
    });
    const frameBytes = 8;
    const totalFrames = 960;
    const destinationStartFrames = 192;
    const originSourceStartFrames = 288;
    const selectedFrames = 576;
    assert.deepEqual(
      edited.pcm,
      Buffer.concat([
        Buffer.alloc(destinationStartFrames * frameBytes),
        origin.pcm.subarray(
          originSourceStartFrames * frameBytes,
          (originSourceStartFrames + selectedFrames) * frameBytes,
        ),
        Buffer.alloc(
          (totalFrames - destinationStartFrames - selectedFrames)
            * frameBytes,
        ),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faded direct-audio slide uses only split-created in-origin slack and preserves one origin fade", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-direct-fade-slide-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(
      directFadeSlideProgram(false),
      originRoot,
    );
    const edited = await renderLockedSource(
      directFadeSlideProgram(true),
      editedRoot,
    );
    const plan = edited.ir.timelineEdits?.[0];
    assert.ok(plan);
    const items = executeTimelineEditPlan(plan).tracks
      .find((track) => track.trackId === "dialogue")?.items
      .filter((candidate) =>
        candidate.originId === "line"
        && candidate.sourceView.kind === "audio");
    assert.ok(items);
    assert.deepEqual(
      items.map((item) => item.destination),
      [
        { start: rational(0), duration: rational(3, 125) },
        { start: rational(3, 125), duration: rational(1, 50) },
        { start: rational(11, 250), duration: rational(2, 125) },
      ],
    );
    assert.deepEqual(
      items.map((item) => item.sourceView.kind === "audio"
        ? item.sourceView.source
        : undefined),
      [
        { start: rational(0), duration: rational(3, 125) },
        { start: rational(1, 50), duration: rational(1, 50) },
        { start: rational(11, 250), duration: rational(2, 125) },
      ],
    );
    assert.deepEqual(
      items.map((item) => item.sourceView.kind === "audio"
        ? item.sourceView.presentationClock.sliceOffset
        : undefined),
      [rational(0), rational(1, 50), rational(11, 250)],
    );
    assert.equal(
      Object.values(edited.ir.nodes)
        .filter((node) => node.op === "cut.edit.timeline_audio_origin")
        .length,
      1,
      "slide cloned the faded source instead of retaining one origin owner",
    );
    const frameBytes = 2 * 4;
    const framesPerMillisecond = 48;
    assert.deepEqual(
      edited.pcm,
      Buffer.concat([
        origin.pcm.subarray(0, 24 * framesPerMillisecond * frameBytes),
        origin.pcm.subarray(
          20 * framesPerMillisecond * frameBytes,
          40 * framesPerMillisecond * frameBytes,
        ),
        origin.pcm.subarray(44 * framesPerMillisecond * frameBytes),
      ]),
      "slide restarted the fade or consumed samples outside the one authenticated origin",
    );
    assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(edited.ir)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faded direct-audio external head handle evaluates one authenticated envelope without restarting the origin fade", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-direct-fade-external-head-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(
      directFadeExternalHeadProgram(false),
      originRoot,
    );
    const edited = await renderLockedSource(
      directFadeExternalHeadProgram(true),
      editedRoot,
    );
    const originOwner = Object.values(edited.ir.nodes).find((node) =>
      node.op === "cut.edit.timeline_audio_origin"
      && node.inputs.evaluationSource !== undefined);
    assert.ok(originOwner);
    assert.deepEqual(originOwner.inputs.evaluationSource, {
      kind: "range",
      start: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(3, 500) },
      end: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(3, 100) },
      exclusive: true,
    });
    assert.deepEqual(originOwner.inputs.presentationZero, {
      kind: "quantity",
      dimension: "time",
      unit: "s",
      magnitude: rational(1, 250),
    });
    assert.deepEqual(originOwner.inputs.fadeAnchorPolicy, {
      kind: "string",
      value: "origin-relative-at-presentation-zero",
    });
    assert.deepEqual(originOwner.inputs.evaluationPolicy, {
      kind: "string",
      value: "selected-source-union-v1",
    });

    const frameBytes = 2 * 4;
    const totalFrames = 1_920;
    const editedStart = 480;
    const preservedFadeStart = 672;
    const preservedFrames = 768;
    assert.equal(origin.pcm.length, totalFrames * frameBytes);
    assert.deepEqual(
      edited.pcm,
      Buffer.concat([
        Buffer.alloc(preservedFadeStart * frameBytes),
        origin.pcm.subarray(
          editedStart * frameBytes,
          (editedStart + preservedFrames) * frameBytes,
        ),
        Buffer.alloc((totalFrames - preservedFadeStart - preservedFrames) * frameBytes),
      ]),
      "external source history restarted the fade or escaped the authenticated envelope",
    );
    const replay = await renderReferenceAudioArtifact(
      edited.ir,
      edited.ir.compositions[0]!,
      editedRoot,
    );
    assert.equal(edited.artifact.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), edited.pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faded direct-audio head and tail handles remain exact at both scene boundaries", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-direct-fade-scene-boundaries-"));
  try {
    for (const direction of ["head", "tail"] as const) {
      const originRoot = resolve(root, `${direction}-control`);
      const editedRoot = resolve(root, `${direction}-edited`);
      await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
      const origin = await renderLockedSource(
        directFadeSceneBoundaryHandleControlProgram(direction),
        originRoot,
      );
      const edited = await renderLockedSource(
        directFadeSceneBoundaryHandleProgram(direction, true),
        editedRoot,
      );
      assertStereoF32ValuesEqual(
        edited.pcm,
        origin.pcm,
        `${direction} handle differs from its independent explicit-source control`,
      );
      const externalFrame = direction === "head" ? 0 : 16 * 48;
      assert.notEqual(
        edited.pcm.readFloatLE(externalFrame * 2 * 4),
        0,
        `${direction} handle was not executed at the scene boundary`,
      );
      const replay = await renderReferenceAudioArtifact(
        edited.ir,
        edited.ir.compositions[0]!,
        editedRoot,
      );
      assert.equal(edited.artifact.cache.status, "miss");
      assert.equal(replay.cache.status, "hit");
      assert.deepEqual(await readFile(replay.path), edited.pcm);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed AudioRegion split plus trim equals one unsliced stateful origin evaluation sliced afterward", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-trim-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(processedTrimProgram(false), originRoot);
    const edited = await renderLockedSource(processedTrimProgram(true), editedRoot);
    assert.equal(edited.ir.timelineEdits?.length, 1);
    assert.deepEqual(
      edited.pcm,
      stereoF32SliceWithSilence(origin.pcm, 720, 960),
      "TimelineEdit re-evaluated/restarted the HighPass or fade per structural slice",
    );

    const replay = await renderReferenceAudioArtifact(
      edited.ir,
      edited.ir.compositions[0]!,
      editedRoot,
    );
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), edited.pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed exact-1x external handle evaluates the full declared domain once before stateful slicing", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-external-state-"));
  const candidateRoot = resolve(root, "candidate");
  const controlRoot = resolve(root, "control");
  await Promise.all([mkdir(candidateRoot), mkdir(controlRoot)]);
  try {
    const candidate = await renderLockedSource(
      processedExternalStateProgram("candidate"),
      candidateRoot,
    );
    const control = await renderLockedSource(
      processedExternalStateProgram("control"),
      controlRoot,
    );
    const origin = Object.values(candidate.ir.nodes).find((node) =>
      node.op === "cut.edit.timeline_audio_origin"
      && node.inputs.originKind?.kind === "string"
      && node.inputs.originKind.value === "processed-audio");
    assert.ok(origin);
    assert.equal(origin.inputs.evaluationPolicy?.kind === "string"
      ? origin.inputs.evaluationPolicy.value : undefined, "full-declared-handle-domain-v1");
    assert.deepEqual(origin.inputs.evaluationSource, {
      kind: "range",
      start: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(0) },
      end: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(1, 25) },
      exclusive: true,
    });
    const frameBytes = 2 * 4;
    const sixMs = 288;
    const twentyMs = 960;
    assert.deepEqual(
      candidate.pcm.subarray(0, twentyMs * frameBytes),
      control.pcm.subarray(sixMs * frameBytes, (sixMs + twentyMs) * frameBytes),
      "processed handle evaluation restarted the HighPass at the selected view instead of preserving full-domain state",
    );
    assert.deepEqual(
      candidate.pcm.subarray(twentyMs * frameBytes),
      Buffer.alloc(candidate.pcm.length - twentyMs * frameBytes),
    );
    validateReferenceSession(candidate.ir);
    const validation = validateReferenceTimelineEditMaterializations(candidate.ir);
    assert.equal(validation.audioEvaluation?.origins.length, 1);
    assert.deepEqual(validation.audioEvaluation?.origins[0], {
      originNodeId: origin.id,
      evaluationPolicy: "full-declared-handle-domain-v1",
      sourceSamples: 1_920,
      processingSamples: 1_920,
      processorCount: 1,
      processorSampleWork: 3_840,
    });
    const replay = await renderReferenceAudioArtifact(
      candidate.ir,
      candidate.ir.compositions[0]!,
      candidateRoot,
    );
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), candidate.pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed external handle anchors the authored fade before its static Gain and matches the direct frozen PCM law", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-external-fade-"));
  const controlRoot = resolve(root, "control");
  const processedRoot = resolve(root, "processed");
  await Promise.all([mkdir(controlRoot), mkdir(processedRoot)]);
  try {
    const control = await renderLockedSource(
      processedExternalFadeControlProgram(),
      controlRoot,
    );
    const processed = await renderLockedSource(
      processedExternalFadeProgram(),
      processedRoot,
    );
    assert.deepEqual(
      processed.pcm,
      control.pcm,
      "processed external evaluation moved or restarted the authored fade relative to the static Gain",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed external work evidence charges native decode and high-rate processor clocks separately", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-external-work-clocks-"));
  try {
    const rendered = await renderLockedSource(
      processedExternalStateProgram("candidate").replace("sampleRate: 48khz", "sampleRate: 96khz"),
      root,
    );
    const receipt = validateReferenceTimelineEditMaterializations(rendered.ir);
    const origin = Object.values(rendered.ir.nodes).find((node) =>
      node.op === "cut.edit.timeline_audio_origin"
      && node.inputs.originKind?.kind === "string"
      && node.inputs.originKind.value === "processed-audio");
    assert.ok(origin);
    assert.equal(receipt.audioEvaluation?.origins.length, 1);
    assert.deepEqual(receipt.audioEvaluation?.origins[0], {
      originNodeId: origin.id,
      evaluationPolicy: "full-declared-handle-domain-v1",
      sourceSamples: 1_920,
      processingSamples: 3_840,
      processorCount: 1,
      processorSampleWork: 5_760,
    });
    assert.equal(receipt.audioEvaluation?.aggregateSourceSamples, 1_920);
    assert.equal(receipt.audioEvaluation?.aggregateProcessorSampleWork, 5_760);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one canonical transaction atomically splits multiple direct and processed items on two audio tracks", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-atomic-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(multiTrackProgram(false), originRoot);
    const edited = await renderLockedSource(multiTrackProgram(true), editedRoot);
    assert.deepEqual(edited.pcm, origin.pcm);
    assert.equal(edited.ir.timelineEdits?.length, 1);
    const tracks = Object.values(edited.ir.nodes)
      .filter((node): node is ReturnType<typeof audioTrack> =>
        node.editorial?.kind === "audio-track")
      .sort((left, right) =>
        (left.editorial.trackId ?? "").localeCompare(right.editorial.trackId ?? ""));
    assert.ok(tracks.every((track) => track.editorial.trackId !== undefined));
    assert.deepEqual(
      tracks.map((track) => [
        track.editorial.trackId,
        track.editorial.items.filter((item) => item.kind === "audio").length,
      ]),
      [["dialogue", 4], ["effects", 4]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lift and extract span two processed origins without flattening or restarting either graph", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-removal-"));
  const originRoot = resolve(root, "origin");
  const liftRoot = resolve(root, "lift");
  const extractRoot = resolve(root, "extract");
  await Promise.all([mkdir(originRoot), mkdir(liftRoot), mkdir(extractRoot)]);
  try {
    const origin = await renderLockedSource(
      processedMultiItemRemovalProgram("none"),
      originRoot,
    );
    const lifted = await renderLockedSource(
      processedMultiItemRemovalProgram("lift"),
      liftRoot,
    );
    const extracted = await renderLockedSource(
      processedMultiItemRemovalProgram("extract"),
      extractRoot,
    );
    const frameBytes = 2 * 4;
    const tenMilliseconds = 480;
    const twentyMilliseconds = 960;
    const fortyMilliseconds = 1_920;

    assert.deepEqual(
      lifted.pcm,
      Buffer.concat([
        origin.pcm.subarray(0, tenMilliseconds * frameBytes),
        Buffer.alloc(twentyMilliseconds * frameBytes),
        origin.pcm.subarray(3 * tenMilliseconds * frameBytes),
      ]),
      "lift restarted or flattened one of the two stateful processed origins",
    );
    assert.deepEqual(
      extracted.pcm,
      Buffer.concat([
        origin.pcm.subarray(0, tenMilliseconds * frameBytes),
        origin.pcm.subarray(3 * tenMilliseconds * frameBytes),
        Buffer.alloc(twentyMilliseconds * frameBytes),
      ]),
      "extract did not splice two independently evaluated origin slices exactly",
    );

    for (const edited of [lifted, extracted]) {
      const track = audioTrack(edited.ir);
      assert.equal(
        Object.values(edited.ir.nodes)
          .filter((node) => node.op === "cut.edit.timeline_audio_origin")
          .length,
        2,
      );
      assert.equal(
        track.editorial.items.filter((item) => item.kind === "audio").length,
        2,
      );
      assert.equal(edited.pcm.length, fortyMilliseconds * frameBytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact-1x processed AudioRegion ripple-delete preserves one origin evaluation and exact PCM/cache identity", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-exact-1x-ripple-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(
      processedExactOneRippleProgram(false),
      originRoot,
    );
    const edited = await renderLockedSource(
      processedExactOneRippleProgram(true),
      editedRoot,
    );
    const track = audioTrack(edited.ir);
    const views = track.children.map((id) => edited.ir.nodes[id]!)
      .filter((node) => node.op === "cut.edit.timeline_audio_view");
    assert.equal(views.length, 2, "ripple did not retain both processed slices");
    const originIds = views.map((view) => {
      const originRef = view.inputs.origin;
      assert.equal(originRef?.kind, "node-ref");
      return originRef.kind === "node-ref" ? originRef.id : "";
    });
    assert.equal(
      new Set(originIds).size,
      1,
      "ripple restarted the stateful processor for one retained slice",
    );
    assert.equal(
      Object.values(edited.ir.nodes).filter((node) =>
        node.op === "cut.edit.timeline_audio_origin").length,
      1,
      "ripple did not retain exactly one processed origin authority",
    );
    assert.equal(
      Object.values(edited.ir.nodes).filter((node) =>
        node.op === "cut.audio.highpass").length,
      1,
      "ripple cloned the authored HighPass graph",
    );
    const processedViews = edited.ir.timelineEdits?.[0]?.tracks[0]?.items
      .filter((item) => item.sourceView.kind === "processed-audio");
    assert.equal(
      processedViews?.length,
      1,
      "the canonical operation ledger must retain one authored processed operand; the two materialized runtime slices are proved above",
    );
    assert.ok(processedViews?.every((item) =>
      item.sourceView.kind === "processed-audio"
      && JSON.stringify(item.sourceView.rate) === JSON.stringify(rational(1))));

    assert.deepEqual(
      edited.pcm,
      stereoF32RippleWithSilence(origin.pcm, 480, 1_440, 1_920),
      "ripple changed or restarted the exact-1x processed origin law",
    );
    assert.equal(edited.artifact.cache.status, "miss");
    const replay = await renderReferenceAudioArtifact(
      edited.ir,
      edited.ir.compositions[0]!,
      editedRoot,
    );
    assert.equal(replay.cache.status, "hit");
    assert.equal(replay.cache.key, edited.artifact.cache.key);
    assert.deepEqual(await readFile(replay.path), edited.pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faded direct ripple, lift, and extract preserve one origin fade and exact PCM/cache identity", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-faded-direct-removal-"));
  const originRoot = resolve(root, "origin");
  await mkdir(originRoot);
  try {
    const origin = await renderLockedSource(
      fadedDirectRemovalProgram("none"),
      originRoot,
    );
    const tenMilliseconds = 480;
    const thirtyMilliseconds = 1_440;
    const totalFrames = 1_920;

    for (const operation of ["lift", "extract", "ripple-delete"] as const) {
      const editedRoot = resolve(root, operation);
      await mkdir(editedRoot);
      const edited = await renderLockedSource(
        fadedDirectRemovalProgram(operation),
        editedRoot,
      );
      const track = audioTrack(edited.ir);
      const views = track.children.map((id) => edited.ir.nodes[id]!)
        .filter((node) => node.op === "cut.edit.timeline_audio_view");
      assert.equal(views.length, 2, `${operation} did not expose both retained slices`);
      const originIds = views.map((view) => {
        const originRef = view.inputs.origin;
        assert.equal(originRef?.kind, "node-ref", operation);
        return originRef.kind === "node-ref" ? originRef.id : "";
      });
      assert.equal(
        new Set(originIds).size,
        1,
        `${operation} restarted the fade for one retained slice`,
      );
      assert.equal(
        Object.values(edited.ir.nodes).filter((node) =>
          node.op === "cut.edit.timeline_audio_origin").length,
        1,
        `${operation} did not preserve exactly one direct-audio origin`,
      );
      const expected = operation === "lift"
        ? stereoF32LiftWithSilence(
            origin.pcm,
            tenMilliseconds,
            thirtyMilliseconds,
          )
        : stereoF32RippleWithSilence(
            origin.pcm,
            tenMilliseconds,
            thirtyMilliseconds,
            totalFrames,
          );
      assert.deepEqual(
        edited.pcm,
        expected,
        `${operation} moved or restarted the origin-relative fade`,
      );
      assert.equal(edited.artifact.cache.status, "miss", operation);
      const replay = await renderReferenceAudioArtifact(
        edited.ir,
        edited.ir.compositions[0]!,
        editedRoot,
      );
      assert.equal(replay.cache.status, "hit", operation);
      assert.equal(replay.cache.key, edited.artifact.cache.key, operation);
      assert.deepEqual(await readFile(replay.path), edited.pcm, operation);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hostile processed graph and origin-clock mutations fail before cache/output publication", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-processed-hostile-"));
  try {
    const valid = compile(processedTrimProgram(true));
    await lockProject(valid, root);
    assert.doesNotThrow(() => validateReferenceSession(valid));
    const before = (await readdir(root, { recursive: true })).sort();
    const mutations: ReadonlyArray<Readonly<{
      label: string;
      mutate(ir: CutAVIR): void;
    }>> = [
      {
        label: "processor graph",
        mutate(ir) {
          const gain = Object.values(ir.nodes).find((node) => node.op === "cut.audio.gain");
          assert.ok(gain?.inputs.amount?.kind === "quantity");
          gain.inputs.amount.magnitude = rational(-18);
        },
      },
      {
        label: "presentation clock",
        mutate(ir) {
          const track = ir.timelineEdits?.[0]?.tracks.find((candidate) =>
            candidate.trackId === "dialogue");
          const item = track?.items.find((candidate) =>
            candidate.sourceView.kind === "processed-audio");
          assert.ok(item?.sourceView.kind === "processed-audio");
          (item.sourceView.presentationClock as {
            sliceOffset: ReturnType<typeof rational>;
          }).sliceOffset = rational(1, 48_000);
        },
      },
      {
        label: "processed graph authority",
        mutate(ir) {
          const track = ir.timelineEdits?.[0]?.tracks.find((candidate) =>
            candidate.trackId === "dialogue");
          const item = track?.items.find((candidate) =>
            candidate.sourceView.kind === "processed-audio");
          assert.ok(item?.sourceView.kind === "processed-audio");
          (item.sourceView as {
            graphAuthorityId: string;
          }).graphAuthorityId = "0".repeat(64);
        },
      },
    ];

    for (const mutation of mutations) {
      const hostile = structuredClone(valid);
      mutation.mutate(hostile);
      assert.throws(
        () => validateReferenceSession(hostile),
        /CUT_TIMELINE_EDIT/u,
        mutation.label,
      );
      await assert.rejects(
        renderReferenceAudioArtifact(
          hostile,
          hostile.compositions[0]!,
          root,
        ),
        (error: unknown) =>
          Boolean(error && typeof error === "object" && "code" in error
            && /^CUT_(?:TIMELINE_EDIT|IR_)/u.test(String(error.code))),
        mutation.label,
      );
      assert.deepEqual(
        (await readdir(root, { recursive: true })).sort(),
        before,
        `${mutation.label} allocated cache/output state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forged TimelineEdit authority fails at the outer stem entrypoint before its directory or temporary files exist", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-stem-hostile-"));
  const destination = resolve(root, "must-not-publish");
  try {
    const ir = compile(processedTrimProgram(true));
    await lockProject(ir, root);
    const track = ir.timelineEdits?.[0]?.tracks.find((candidate) =>
      candidate.trackId === "dialogue");
    const item = track?.items.find((candidate) =>
      candidate.sourceView.kind === "processed-audio");
    assert.ok(item?.sourceView.kind === "processed-audio");
    (item.sourceView.presentationClock as {
      sliceOffset: ReturnType<typeof rational>;
    }).sliceOffset = rational(1, 48_000);
    await assert.rejects(
      renderReferenceAudioStems(
        ir,
        ir.compositions[0]!,
        root,
        destination,
        { lockSha256: "a".repeat(64) },
      ),
      /CUT_TIMELINE_EDIT/u,
    );
    await assert.rejects(
      access(destination),
      "forged TimelineEdit authority allocated the public stem directory",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function retimedTrimProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit half-speed processed trim";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editTrim
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 200ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 200ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 200ms,
        editId: "slow-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 700hz) {
            TimeStretch(
              sourceDuration: 100ms,
              duration: 200ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 0ms ..< 100ms,
                fadeIn: 20ms,
                fadeOut: 20ms
              );
            }
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "split-trim-half-speed",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          at: avTime(audio: 100ms)
        ),
        editTrim(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          keep: 0ms ..< 150ms
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function retimedExternalHandleProgram(mode: "edited" | "full-control") {
  const fullControl = mode === "full-control";
  const sourceStart = fullControl ? 0 : 40;
  const sourceEnd = fullControl ? 180 : 140;
  const sourceDuration = fullControl ? 180 : 100;
  const destinationDuration = fullControl ? 360 : 200;
  return `cut 0.4;
project "TimelineEdit retimed processed external handle ${mode}";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSlip
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: ${destinationDuration}ms, fps: 25, sampleRate: 48khz) {
  scene only(duration: ${destinationDuration}ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< ${destinationDuration}ms,
        ${fullControl ? "" : "headHandle: 40ms, tailHandle: 40ms,"}
        editId: "slow-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 700hz) {
            TimeStretch(
              sourceDuration: ${sourceDuration}ms,
              duration: ${destinationDuration}ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(source: voice, range: ${sourceStart}ms ..< ${sourceEnd}ms);
            }
          }
        }
      }
    }
    ${fullControl ? "" : `TimelineEdit(
      id: "retimed-external-slip",
      operations: [
        editSlip(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          range: 0ms ..< 200ms,
          by: avTime(audio: -40ms)
        )
      ]
    );`}
  }
}
export out = render(main);`;
}

function retimedBoundaryProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit in-origin retimed boundary";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editBoundary
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 120ms, fps: 25, sampleRate: 48khz) {
  scene only(duration: 120ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 120ms,
        editId: "slow-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 700hz) {
            TimeStretch(
              sourceDuration: 60ms,
              duration: 120ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 100ms ..< 160ms,
                fadeIn: 12ms,
                fadeOut: 12ms
              );
            }
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "split-boundary-retimed-line",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          at: avTime(audio: 60ms)
        ),
        editBoundary(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          at: avTime(audio: 72ms)
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function retimedSlipProgram(
  withEdit: boolean,
  externalSource = false,
  slipExpressions?: readonly string[],
) {
  const slips = slipExpressions
    ?? [externalSource ? "120ms" : "40ms"];
  const slipOperations = slips.map((by) => `editSlip(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          range: 80ms ..< 320ms,
          by: avTime(audio: ${by})
        )`).join(",\n        ");
  return `cut 0.4;
project "TimelineEdit half-speed processed slip";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editTrim, editSlip
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 400ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 400ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 400ms,
        editId: "slow-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 700hz) {
            TimeStretch(
              sourceDuration: 200ms,
              duration: 400ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 100ms ..< 300ms,
                fadeIn: 40ms,
                fadeOut: 40ms
              );
            }
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "trim-slip-half-speed",
      operations: [
        editTrim(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          keep: 80ms ..< 320ms
        ),
        ${slipOperations}
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function retimedDoubleSlipProgram(
  withEdit: boolean,
  by = "20ms",
) {
  return `cut 0.4;
project "TimelineEdit double-speed processed slip";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editTrim, editSlip
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 200ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 200ms) {
    AudioTrack(trackId: "effects", role: "sfx") {
      AudioRegion(
        destination: 0ms ..< 200ms,
        editId: "fast-line",
        role: "sfx"
      ) {
        Gain(amount: -6db) {
          HighPass(frequency: 900hz) {
            TimeStretch(
              sourceDuration: 400ms,
              duration: 200ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 100ms ..< 500ms,
                fadeIn: 20ms,
                fadeOut: 20ms
              );
            }
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "trim-slip-double-speed",
      operations: [
        editTrim(
          selection: editSelection(
            trackIds: ["effects"],
            originIds: ["fast-line"]
          ),
          keep: 40ms ..< 160ms
        ),
        editSlip(
          selection: editSelection(
            trackIds: ["effects"],
            originIds: ["fast-line"]
          ),
          range: 40ms ..< 160ms,
          by: avTime(audio: ${by})
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function retimedRemoveProgram(
  withEdit: boolean,
  operation: "ripple" | "lift" | "extract" = "ripple",
) {
  const removal = operation === "ripple"
    ? `editRippleDelete(
          selection: editSelection(
            trackIds: ["effects"],
            originIds: ["fast-origin", "slow-origin"]
          ),
          range: 25ms ..< 50ms
        )`
    : `${operation === "lift" ? "editLift" : "editExtract"}(
          selection: editSelection(
            trackIds: ["effects"],
            originIds: ["fast-origin", "slow-origin"]
          ),
          range: 25ms ..< 50ms
        )`;
  return `cut 0.4;
project "TimelineEdit mixed retimed origin ${operation}";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editRippleDelete, editLift, editExtract
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 300ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 300ms) {
    AudioTrack(trackId: "effects", role: "sfx") {
      AudioRegion(
        destination: 0ms ..< 100ms,
        editId: "fast-origin",
        role: "sfx"
      ) {
        Gain(amount: -6db) {
          HighPass(frequency: 500hz) {
            TimeStretch(
              sourceDuration: 200ms,
              duration: 100ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 0ms ..< 200ms,
                fadeIn: 20ms,
                fadeOut: 20ms
              );
            }
          }
        }
      }
      AudioRegion(
        destination: 100ms ..< 300ms,
        editId: "slow-origin",
        role: "sfx"
      ) {
        Gain(amount: -9db) {
          HighPass(frequency: 1300hz) {
            TimeStretch(
              sourceDuration: 100ms,
              duration: 200ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 200ms ..< 300ms,
                fadeIn: 20ms,
                fadeOut: 20ms
              );
            }
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "split-${operation}-mixed-rates",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["effects"],
            originIds: ["fast-origin"]
          ),
          at: avTime(audio: 50ms)
        ),
        editSplit(
          selection: editSelection(
            trackIds: ["effects"],
            originIds: ["slow-origin"]
          ),
          at: avTime(audio: 200ms)
        ),
        ${removal}
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function retimedTransitionProgram(withEdit: boolean) {
  return `cut 0.4;
project "TimelineEdit retimed source-clock transition";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editTransition
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 400ms, fps: 25, sampleRate: 48khz) {
  scene only(duration: 400ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 400ms,
        editId: "slow-origin",
        role: "dialogue"
      ) {
        Gain(amount: -9db) {
          HighPass(frequency: 700hz) {
            TimeStretch(
              sourceDuration: 200ms,
              duration: 400ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 100ms ..< 300ms,
                fadeIn: 40ms,
                fadeOut: 40ms
              );
            }
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "retimed-transition",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-origin"]
          ),
          at: avTime(audio: 200ms)
        ),
        editTransition(
          left: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-origin"]
          ),
          right: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-origin"]
          ),
          at: avTime(audio: 200ms),
          duration: avTime(audio: 80ms),
          audioCurve: "equal-power"
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function retimedSlipTransitionProgram(
  rate: "half" | "double",
  withEdit: boolean,
  slips?: Readonly<{
    left: readonly string[];
    right: readonly string[];
  }>,
) {
  const half = rate === "half";
  const timelineDuration = half ? "400ms" : "200ms";
  const sourceDuration = half ? "200ms" : "400ms";
  const sourceRange = half ? "100ms ..< 300ms" : "100ms ..< 500ms";
  const cut = half ? "200ms" : "100ms";
  const transition = half ? "80ms" : "40ms";
  const fade = half ? "40ms" : "20ms";
  const slip = half ? "20ms" : "10ms";
  const selectedSlips = slips ?? {
    left: [slip, slip],
    right: [`-${slip}`, `-${slip}`],
  };
  const slipCalls = [
    ...selectedSlips.left.map((by) => `editSlip(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["retimed-origin"]
          ),
          range: 0ms ..< ${cut},
          by: avTime(audio: ${by})
        )`),
    ...selectedSlips.right.map((by) => `editSlip(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["retimed-origin"]
          ),
          range: ${cut} ..< ${timelineDuration},
          by: avTime(audio: ${by})
        )`),
  ].join(",\n        ");
  return `cut 0.4;
project "TimelineEdit ${rate}-speed slip transition";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSlip, editSplit, editTransition
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: ${timelineDuration}, fps: 25, sampleRate: 48khz) {
  scene only(duration: ${timelineDuration}) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< ${timelineDuration},
        editId: "retimed-origin",
        role: "dialogue"
      ) {
        Gain(amount: -9db) {
          HighPass(frequency: 700hz) {
            TimeStretch(
              sourceDuration: ${sourceDuration},
              duration: ${timelineDuration},
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: ${sourceRange},
                fadeIn: ${fade},
                fadeOut: ${fade}
              );
            }
          }
        }
      }
    }
    ${withEdit ? `TimelineEdit(
      id: "${rate}-speed-slip-transition",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["retimed-origin"]
          ),
          at: avTime(audio: ${cut})
        ),
        ${slipCalls},
        editTransition(
          left: editSelection(
            trackIds: ["dialogue"],
            originIds: ["retimed-origin"]
          ),
          right: editSelection(
            trackIds: ["dialogue"],
            originIds: ["retimed-origin"]
          ),
          at: avTime(audio: ${cut}),
          duration: avTime(audio: ${transition}),
          audioCurve: "equal-power"
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function equalPowerSelfCrossfade(pcm: Buffer, startFrame: number, durationFrames: number) {
  const frameBytes = 8;
  assert.equal(pcm.length % frameBytes, 0);
  const result = Buffer.from(pcm);
  for (let frame = startFrame; frame < startFrame + durationFrames; frame += 1) {
    const progress = (frame - startFrame) / durationFrames;
    const incoming = Math.sin(Math.PI * progress / 2);
    const outgoing = Math.cos(Math.PI * progress / 2);
    for (const channel of [0, 1]) {
      const offset = frame * frameBytes + channel * 4;
      const value = pcm.readFloatLE(offset);
      result.writeFloatLE(
        Math.fround(value * (outgoing + incoming)),
        offset,
      );
    }
  }
  return result;
}

function equalPowerTwoSourceTransition(
  pcm: Buffer,
  totalFrames: number,
  leftOriginStart: number,
  rightOriginStart: number,
  overlapStart: number,
  overlapFrames: number,
) {
  const frameBytes = 8;
  assert.equal(pcm.length, totalFrames * frameBytes);
  const result = Buffer.alloc(pcm.length);
  for (let frame = 0; frame < totalFrames; frame += 1) {
    if (frame < overlapStart) {
      pcm.copy(
        result,
        frame * frameBytes,
        (leftOriginStart + frame) * frameBytes,
        (leftOriginStart + frame + 1) * frameBytes,
      );
      continue;
    }
    if (frame >= overlapStart + overlapFrames) {
      const sourceFrame = rightOriginStart + frame - overlapStart;
      pcm.copy(
        result,
        frame * frameBytes,
        sourceFrame * frameBytes,
        (sourceFrame + 1) * frameBytes,
      );
      continue;
    }
    const offset = frame - overlapStart;
    const progress = offset / overlapFrames;
    const outgoing = Math.cos(Math.PI * progress / 2);
    const incoming = Math.sin(Math.PI * progress / 2);
    const leftFrame = leftOriginStart + frame;
    const rightFrame = rightOriginStart + offset;
    for (const channel of [0, 1]) {
      const destinationOffset = frame * frameBytes + channel * 4;
      const leftOffset = leftFrame * frameBytes + channel * 4;
      const rightOffset = rightFrame * frameBytes + channel * 4;
      result.writeFloatLE(
        Math.fround(
          pcm.readFloatLE(leftOffset) * outgoing
            + pcm.readFloatLE(rightOffset) * incoming,
        ),
        destinationOffset,
      );
    }
  }
  return result;
}

function stereoF32RippleWithSilence(
  pcm: Buffer,
  removedStartFrame: number,
  removedEndFrame: number,
  totalFrames: number,
) {
  const frameBytes = 2 * 4;
  assert.equal(pcm.length, totalFrames * frameBytes);
  const removedFrames = removedEndFrame - removedStartFrame;
  assert.ok(removedFrames > 0);
  return Buffer.concat([
    pcm.subarray(0, removedStartFrame * frameBytes),
    pcm.subarray(removedEndFrame * frameBytes),
    Buffer.alloc(removedFrames * frameBytes),
  ]);
}

function stereoF32LiftWithSilence(
  pcm: Buffer,
  removedStartFrame: number,
  removedEndFrame: number,
) {
  const frameBytes = 2 * 4;
  assert.equal(pcm.length % frameBytes, 0);
  const result = Buffer.from(pcm);
  result.fill(0, removedStartFrame * frameBytes, removedEndFrame * frameBytes);
  return result;
}

test("0.5x processed external handles evaluate one expanded TimeStretch origin and match the explicit full-domain control", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-external-"));
  const controlRoot = resolve(root, "control");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(controlRoot), mkdir(editedRoot)]);
  try {
    const control = await renderLockedRawSource(
      retimedExternalHandleProgram("full-control"),
      controlRoot,
    );
    const edited = await renderLockedRawSource(
      retimedExternalHandleProgram("edited"),
      editedRoot,
    );
    const origin = Object.values(edited.ir.nodes).find((node) =>
      node.op === "cut.edit.timeline_audio_origin"
      && node.inputs.evaluationSource !== undefined);
    assert.ok(origin);
    assert.deepEqual(origin.inputs.rate, {
      kind: "quantity",
      dimension: "scalar",
      unit: "scalar",
      magnitude: rational(1, 2),
    });
    assert.deepEqual(origin.inputs.evaluationSource, {
      kind: "range",
      start: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(0) },
      end: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(9, 50) },
      exclusive: true,
    });
    assert.deepEqual(origin.inputs.presentationZero, {
      kind: "quantity",
      dimension: "time",
      unit: "s",
      magnitude: rational(2, 25),
    });
    const validation = validateReferenceTimelineEditMaterializations(edited.ir);
    assert.deepEqual(validation.audioEvaluation?.origins, [{
      originNodeId: origin.id,
      evaluationPolicy: "full-declared-handle-domain-v1",
      sourceSamples: 8_640,
      processingSamples: 17_280,
      processorCount: 3,
      processorSampleWork: 51_840,
    }]);
    const frameBytes = 2 * 4;
    const expected = control.pcm.subarray(1_920 * frameBytes, (1_920 + 9_600) * frameBytes);
    assert.equal(edited.pcm.length, 9_600 * frameBytes);
    assert.deepEqual(
      edited.pcm,
      expected,
      "retimed handle selection differs from one explicit full-domain TimeStretch evaluation sliced afterward",
    );
    assert.equal(
      Object.values(edited.ir.nodes).filter((node) => node.op === "cut.audio.time_stretch").length,
      1,
      "retimed external handle cloned or restarted TimeStretch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("0.5x TimeStretch split plus trim preserves one faded processed origin and exact presentation-clock PCM", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-half-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(retimedTrimProgram(false), originRoot);
    const edited = await renderLockedSource(retimedTrimProgram(true), editedRoot);
    const view = edited.ir.timelineEdits?.[0]?.tracks
      .find((track) => track.trackId === "dialogue")?.items
      .find((item) => item.sourceView.kind === "processed-audio")?.sourceView;
    assert.ok(view?.kind === "processed-audio");
    assert.deepEqual(view.rate, rational(1, 2));
    assert.deepEqual(
      edited.pcm,
      stereoF32SliceWithSilence(origin.pcm, 7_200, 9_600),
      "the half-speed origin was retimed/evaluated or faded once per structural slice",
    );

    const replay = await renderReferenceAudioArtifact(
      edited.ir,
      edited.ir.compositions[0]!,
      editedRoot,
    );
    assert.equal(edited.artifact.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), edited.pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("constant-retimed processed boundary adjustment moves a split-created in-origin cut without graph restart", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-boundary-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(
      retimedBoundaryProgram(false),
      originRoot,
    );
    const edited = await renderLockedSource(
      retimedBoundaryProgram(true),
      editedRoot,
    );
    const plan = edited.ir.timelineEdits?.[0];
    assert.ok(plan);
    const items = executeTimelineEditPlan(plan).tracks
      .find((track) => track.trackId === "dialogue")?.items
      .filter((candidate) =>
        candidate.originId === "slow-line"
        && candidate.sourceView.kind === "processed-audio");
    assert.ok(items);
    assert.deepEqual(
      items.map((item) => item.destination),
      [
        { start: rational(0), duration: rational(9, 125) },
        { start: rational(9, 125), duration: rational(6, 125) },
      ],
    );
    assert.deepEqual(
      items.map((item) => item.sourceView.kind === "processed-audio"
        ? item.sourceView.source
        : undefined),
      [
        { start: rational(1, 10), duration: rational(9, 250) },
        { start: rational(17, 125), duration: rational(3, 125) },
      ],
    );
    assert.deepEqual(
      items.map((item) => item.sourceView.kind === "processed-audio"
        ? item.sourceView.presentationClock.sliceOffset
        : undefined),
      [rational(0), rational(9, 125)],
    );
    assert.ok(items.every((item) =>
      item.sourceView.kind === "processed-audio"
      && item.sourceView.rate.numerator === "1"
      && item.sourceView.rate.denominator === "2"
      && item.sourceView.statePolicy === "single-authorized-evaluation"));
    assert.equal(
      Object.values(edited.ir.nodes)
        .filter((node) => node.op === "cut.audio.time_stretch")
        .length,
      1,
      "boundary adjustment cloned or restarted the TimeStretch graph",
    );
    assert.deepEqual(
      edited.pcm,
      origin.pcm,
      "boundary adjustment changed PCM instead of moving one cut through the same processed origin",
    );
    assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(edited.ir)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("0.5x processed slip selects new source samples from one authenticated origin without restarting fades", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-slip-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(
      retimedSlipProgram(false),
      originRoot,
    );
    const edited = await renderLockedSource(
      retimedSlipProgram(true),
      editedRoot,
    );
    const plan = edited.ir.timelineEdits?.[0];
    assert.ok(plan);
    const item = executeTimelineEditPlan(plan).tracks
      .find((track) => track.trackId === "dialogue")?.items
      .find((candidate) =>
        candidate.originId === "slow-line"
        && candidate.sourceView.kind === "processed-audio");
    assert.ok(item?.sourceView.kind === "processed-audio");
    assert.deepEqual(item.destination, {
      start: rational(2, 25),
      duration: rational(6, 25),
    });
    assert.deepEqual(item.sourceView.source, {
      start: rational(4, 25),
      duration: rational(3, 25),
    });
    assert.deepEqual(item.sourceView.handles, {
      head: rational(3, 50),
      tail: rational(1, 50),
    });
    assert.deepEqual(item.sourceView.presentationClock, {
      originDuration: rational(2, 5),
      sliceOffset: rational(3, 25),
      fadePolicy: "origin-relative",
    });
    assert.doesNotThrow(
      () => loadCutAvIr(JSON.stringify(edited.ir)),
      "trim plus slip must survive the strict serialized IR boundary with one exact source/presentation clock",
    );
    const frameBytes = 8;
    const totalFrames = 19_200;
    const destinationStartFrames = 3_840;
    const originSourceStartFrames = 5_760;
    const selectedFrames = 11_520;
    const expected = Buffer.concat([
      Buffer.alloc(destinationStartFrames * frameBytes),
      origin.pcm.subarray(
        originSourceStartFrames * frameBytes,
        (originSourceStartFrames + selectedFrames) * frameBytes,
      ),
      Buffer.alloc(
        (totalFrames - destinationStartFrames - selectedFrames) * frameBytes,
      ),
    ]);
    assert.deepEqual(
      edited.pcm,
      expected,
      "slip reused destination offsets instead of selecting the shifted source-clock interval from the one processed origin",
    );

    const replay = await renderReferenceAudioArtifact(
      edited.ir,
      edited.ir.compositions[0]!,
      editedRoot,
    );
    assert.equal(edited.artifact.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), edited.pcm);

    assert.throws(
      () => compile(retimedSlipProgram(true, true)),
      (error: unknown) => error instanceof CutCompileError
        && error.result.diagnostics.some((diagnostic) =>
          diagnostic.code === "CUT_TIMELINE_EDIT_HANDLE"
          && /slip exceeds declared source handles/u.test(
            diagnostic.message,
          )),
      "source samples outside the authenticated origin must not be treated as evaluated processor history",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("2x processed slip converts destination motion to source clock and preserves the one origin fade", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-double-slip-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(
      retimedDoubleSlipProgram(false),
      originRoot,
    );
    const edited = await renderLockedSource(
      retimedDoubleSlipProgram(true),
      editedRoot,
    );
    const plan = edited.ir.timelineEdits?.[0];
    assert.ok(plan);
    const item = executeTimelineEditPlan(plan).tracks
      .find((track) => track.trackId === "effects")?.items
      .find((candidate) =>
        candidate.originId === "fast-line"
        && candidate.sourceView.kind === "processed-audio");
    assert.ok(item?.sourceView.kind === "processed-audio");
    assert.deepEqual(item.destination, {
      start: rational(1, 25),
      duration: rational(3, 25),
    });
    assert.deepEqual(item.sourceView.source, {
      start: rational(11, 50),
      duration: rational(6, 25),
    });
    assert.deepEqual(item.sourceView.handles, {
      head: rational(3, 25),
      tail: rational(1, 25),
    });
    assert.deepEqual(item.sourceView.presentationClock, {
      originDuration: rational(1, 5),
      sliceOffset: rational(3, 50),
      fadePolicy: "origin-relative",
    });
    assert.deepEqual(item.sourceView.rate, rational(2));
    const frameBytes = 8;
    const totalFrames = 9_600;
    const destinationStartFrames = 1_920;
    const originSourceStartFrames = 2_880;
    const selectedFrames = 5_760;
    assert.deepEqual(
      edited.pcm,
      Buffer.concat([
        Buffer.alloc(destinationStartFrames * frameBytes),
        origin.pcm.subarray(
          originSourceStartFrames * frameBytes,
          (originSourceStartFrames + selectedFrames) * frameBytes,
        ),
        Buffer.alloc(
          (totalFrames - destinationStartFrames - selectedFrames) * frameBytes,
        ),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated opposite processed slips compose exactly and changed source intervals miss the PCM cache", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-slip-repeat-"));
  const repeatedRoot = resolve(root, "repeated");
  const singleRoot = resolve(root, "single");
  const cacheRoot = resolve(root, "cache");
  await Promise.all([mkdir(repeatedRoot), mkdir(singleRoot), mkdir(cacheRoot)]);
  try {
    const repeated = await renderLockedSource(
      retimedSlipProgram(true, false, ["40ms", "-20ms"]),
      repeatedRoot,
    );
    const single = await renderLockedSource(
      retimedSlipProgram(true, false, ["20ms"]),
      singleRoot,
    );
    assert.deepEqual(
      repeated.pcm,
      single.pcm,
      "opposite slips did not compose to the exact net source-clock delta",
    );

    const first = compile(retimedSlipProgram(true, false, ["20ms"]));
    await lockProject(first, cacheRoot);
    const firstArtifact = await renderReferenceAudioArtifact(
      first,
      first.compositions[0]!,
      cacheRoot,
    );
    const second = compile(retimedSlipProgram(true, false, ["40ms"]));
    await lockProject(second, cacheRoot);
    const secondArtifact = await renderReferenceAudioArtifact(
      second,
      second.compositions[0]!,
      cacheRoot,
    );
    const replay = await renderReferenceAudioArtifact(
      second,
      second.compositions[0]!,
      cacheRoot,
    );
    assert.equal(firstArtifact.cache.status, "miss");
    assert.equal(secondArtifact.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.notDeepEqual(
      await readFile(firstArtifact.path),
      await readFile(secondArtifact.path),
      "different authenticated slip intervals collided in the PCM cache",
    );
    assert.deepEqual(await readFile(replay.path), await readFile(secondArtifact.path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("half-speed slip admits the exact residual-handle boundary and refuses one source sample beyond it", () => {
  const exact = compile(
    retimedSlipProgram(true, false, ["3840s / 48000"]),
  );
  const plan = exact.timelineEdits?.[0];
  assert.ok(plan);
  const item = executeTimelineEditPlan(plan).tracks[0]!.items
    .find((candidate) =>
      candidate.originId === "slow-line"
      && candidate.sourceView.kind === "processed-audio");
  assert.ok(item?.sourceView.kind === "processed-audio");
  assert.deepEqual(item.sourceView.source, {
    start: rational(9, 50),
    duration: rational(3, 25),
  });
  assert.deepEqual(item.sourceView.handles, {
    head: rational(2, 25),
    tail: rational(0),
  });

  assert.throws(
    () => compile(retimedSlipProgram(true, false, ["3842s / 48000"])),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "CUT_TIMELINE_EDIT_HANDLE"
        && /slip exceeds declared source handles/u.test(diagnostic.message)),
  );
});

test("direct audio selection rejects forged slipped origin views before path or output allocation", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-slip-direct-hostile-"));
  try {
    const valid = compile(retimedSlipProgram(true));
    await lockProject(valid, root);
    assert.doesNotThrow(() => validateReferenceSession(valid));
    const before = (await readdir(root, { recursive: true })).sort();
    const mutations: ReadonlyArray<Readonly<{
      label: string;
      mutate(ir: CutAVIR): void;
    }>> = [
      {
        label: "canonical source interval",
        mutate(ir) {
          const item = ir.timelineEdits?.[0]?.tracks
            .find((track) => track.trackId === "dialogue")?.items
            .find((candidate) => candidate.sourceView.kind === "processed-audio");
          assert.ok(item?.sourceView.kind === "processed-audio");
          item.sourceView.source.start = rational(161, 1_000);
        },
      },
      {
        label: "materialized source interval",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view");
          assert.ok(view?.inputs.source?.kind === "range");
          assert.equal(view.inputs.source.start.kind, "quantity");
          view.inputs.source.start.magnitude = rational(161, 1_000);
        },
      },
      {
        label: "materialized presentation slice",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view");
          assert.ok(view?.inputs.sliceOffset?.kind === "quantity");
          view.inputs.sliceOffset.magnitude = rational(3_841, 48_000);
        },
      },
      {
        label: "materialized residual handle",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view");
          assert.ok(view?.inputs.headHandle?.kind === "quantity");
          view.inputs.headHandle.magnitude = rational(2_879, 48_000);
        },
      },
      {
        label: "materialized origin reference",
        mutate(ir) {
          const track = audioTrack(ir);
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view");
          assert.ok(view?.inputs.origin?.kind === "node-ref");
          view.inputs.origin.id = track.id;
        },
      },
      {
        label: "materialized origin authority",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view");
          assert.ok(view?.inputs.originAuthorityId?.kind === "string");
          view.inputs.originAuthorityId.value = "0".repeat(64);
        },
      },
      {
        label: "authenticated origin leaf range",
        mutate(ir) {
          const clip = Object.values(ir.nodes).find((node) =>
            node.op === "cut.audio.clip");
          assert.ok(clip?.inputs.range?.kind === "range");
          assert.equal(clip.inputs.range.start.kind, "quantity");
          clip.inputs.range.start.magnitude = rational(101, 1_000);
        },
      },
    ];

    for (const mutation of mutations) {
      const hostile = structuredClone(valid);
      mutation.mutate(hostile);
      const composition = hostile.compositions[0]!;
      const output = resolve(
        root,
        `must-not-exist-${mutation.label.replaceAll(" ", "-")}.f32le`,
      );
      await assert.rejects(
        renderReferenceAudioSelection(
          hostile,
          composition,
          root,
          output,
          referenceMasterAudioRootIds(hostile, composition),
          { outputFormat: "raw-stereo-f32le" },
        ),
        /CUT_TIMELINE_EDIT/u,
        mutation.label,
      );
      assert.deepEqual(
        (await readdir(root, { recursive: true })).sort(),
        before,
        `${mutation.label} resolved media or allocated output state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("2x and 0.5x processed origins survive multi-item split plus ripple as one exact presentation splice", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-ripple-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(retimedRemoveProgram(false), originRoot);
    const edited = await renderLockedSource(retimedRemoveProgram(true), editedRoot);
    const views = edited.ir.timelineEdits?.[0]?.tracks
      .find((track) => track.trackId === "effects")?.items
      .filter((item) => item.sourceView.kind === "processed-audio")
      .map((item) => item.sourceView.kind === "processed-audio"
        ? item.sourceView.rate
        : undefined);
    assert.deepEqual(views, [rational(2), rational(1, 2)]);
    assert.deepEqual(
      edited.pcm,
      stereoF32RippleWithSilence(origin.pcm, 1_200, 2_400, 14_400),
      "ripple must splice one completed pair of origin-clock retimes, then append exact silence",
    );

    const replay = await renderReferenceAudioArtifact(
      edited.ir,
      edited.ir.compositions[0]!,
      editedRoot,
    );
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), edited.pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("constant-retimed processed lift and extract preserve one origin evaluation and exact PCM", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-remove-"));
  const originRoot = resolve(root, "origin");
  await mkdir(originRoot);
  try {
    const origin = await renderLockedSource(retimedRemoveProgram(false), originRoot);
    for (const operation of ["lift", "extract"] as const) {
      const editedRoot = resolve(root, operation);
      await mkdir(editedRoot);
      const edited = await renderLockedSource(
        retimedRemoveProgram(true, operation),
        editedRoot,
      );
      assert.equal(
        Object.values(edited.ir.nodes).filter((node) =>
          node.op === "cut.audio.time_stretch").length,
        2,
        `${operation} cloned or restarted one authored TimeStretch`,
      );
      assert.equal(
        Object.values(edited.ir.nodes).filter((node) =>
          node.op === "cut.edit.timeline_audio_origin").length,
        2,
        `${operation} did not preserve one authority per authored origin`,
      );
      const expected = operation === "lift"
        ? stereoF32LiftWithSilence(origin.pcm, 1_200, 2_400)
        : stereoF32RippleWithSilence(origin.pcm, 1_200, 2_400, 14_400);
      assert.deepEqual(edited.pcm, expected, `${operation} PCM law`);

      const replay = await renderReferenceAudioArtifact(
        edited.ir,
        edited.ir.compositions[0]!,
        editedRoot,
      );
      assert.equal(replay.cache.status, "hit", operation);
      assert.deepEqual(await readFile(replay.path), edited.pcm, operation);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("0.5x retimed transition converts destination handles to source clock and crossfades one unsliced origin evaluation", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-transition-"));
  const originRoot = resolve(root, "origin");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
  try {
    const origin = await renderLockedSource(retimedTransitionProgram(false), originRoot);
    const edited = await renderLockedSource(retimedTransitionProgram(true), editedRoot);
    const track = audioTrack(edited.ir);
    assert.equal(track.editorial.transitions?.length, 1);
    assert.equal(
      Object.values(edited.ir.nodes).filter((node) => node.op === "cut.audio.time_stretch").length,
      1,
      "structural transition cloned or independently evaluated the TimeStretch graph",
    );
    const views = track.children.map((id) => edited.ir.nodes[id]!);
    assert.equal(views.length, 2);
    assert.ok(views.every((view) => view.op === "cut.edit.timeline_audio_view"));
    assert.deepEqual(
      track.editorial.transitions?.[0]?.outgoingSource,
      { start: rational(1, 5), duration: rational(1, 50) },
      "40ms of destination tail must consume exactly 20ms at 0.5x source rate",
    );
    assert.deepEqual(
      track.editorial.transitions?.[0]?.incomingSource,
      { start: rational(9, 50), duration: rational(1, 50) },
      "40ms of destination head must consume exactly 20ms at 0.5x source rate",
    );
    const inspected = inspectCutIr(edited.ir, "retimed-transition.cut");
    const inspectedEdit = inspected.timelineEdits?.find((candidate) =>
      candidate.id === "retimed-transition");
    assert.ok(inspectedEdit);
    assert.equal(inspectedEdit.execution.transitions.length, 1);
    assert.ok(inspectedEdit.tracks
      .flatMap((candidate) => candidate.items)
      .filter((item) => item.sourceView.kind === "processed-audio")
      .every((item) =>
        item.sourceView.kind === "processed-audio"
        && JSON.stringify(item.sourceView.rate) === JSON.stringify(rational(1, 2))));
    assert.deepEqual(
      edited.pcm,
      equalPowerSelfCrossfade(origin.pcm, 7_680, 3_840),
      "retimed crossfade differs from one unsliced origin evaluation under the exact equal-power law",
    );

    const replay = await renderReferenceAudioArtifact(
      edited.ir,
      edited.ir.compositions[0]!,
      editedRoot,
    );
    assert.equal(edited.artifact.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), edited.pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slip followed by transition preserves exact 0.5x and 2x source clocks, fades, and equal-power PCM", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-slip-transition-rates-"));
  try {
    const cases = [
      {
        rate: "half" as const,
        totalFrames: 19_200,
        leftOriginStart: 1_920,
        rightOriginStart: 5_760,
        overlapStart: 7_680,
        overlapFrames: 3_840,
        sources: [
          { start: rational(3, 25), duration: rational(1, 10) },
          { start: rational(9, 50), duration: rational(1, 10) },
        ],
        handles: [
          { head: rational(1, 50), tail: rational(2, 25) },
          { head: rational(2, 25), tail: rational(1, 50) },
        ],
        slices: [rational(1, 25), rational(4, 25)],
        transitionSources: {
          outgoing: { start: rational(11, 50), duration: rational(1, 50) },
          incoming: { start: rational(4, 25), duration: rational(1, 50) },
        },
      },
      {
        rate: "double" as const,
        totalFrames: 9_600,
        leftOriginStart: 960,
        rightOriginStart: 2_880,
        overlapStart: 3_840,
        overlapFrames: 1_920,
        sources: [
          { start: rational(7, 50), duration: rational(1, 5) },
          { start: rational(13, 50), duration: rational(1, 5) },
        ],
        handles: [
          { head: rational(1, 25), tail: rational(4, 25) },
          { head: rational(4, 25), tail: rational(1, 25) },
        ],
        slices: [rational(1, 50), rational(2, 25)],
        transitionSources: {
          outgoing: { start: rational(17, 50), duration: rational(1, 25) },
          incoming: { start: rational(11, 50), duration: rational(1, 25) },
        },
      },
    ] as const;
    for (const entry of cases) {
      const originRoot = resolve(root, `${entry.rate}-origin`);
      const editedRoot = resolve(root, `${entry.rate}-edited`);
      await Promise.all([mkdir(originRoot), mkdir(editedRoot)]);
      const origin = await renderLockedSource(
        retimedSlipTransitionProgram(entry.rate, false),
        originRoot,
      );
      const edited = await renderLockedSource(
        retimedSlipTransitionProgram(entry.rate, true),
        editedRoot,
      );
      const plan = edited.ir.timelineEdits?.[0];
      assert.ok(plan);
      const execution = executeTimelineEditPlan(plan);
      assert.equal(execution.transitions.length, 1);
      const views = execution.tracks[0]!.items
        .filter((item) => item.sourceView.kind === "processed-audio");
      assert.equal(views.length, 2);
      assert.deepEqual(
        views.map((item) => item.sourceView.kind === "processed-audio"
          ? item.sourceView.rate
          : undefined),
        entry.rate === "half"
          ? [rational(1, 2), rational(1, 2)]
          : [rational(2), rational(2)],
      );
      assert.deepEqual(
        views.map((item) => item.sourceView.kind === "processed-audio"
          ? item.sourceView.source
          : undefined),
        entry.sources,
      );
      assert.deepEqual(
        views.map((item) => item.sourceView.kind === "processed-audio"
          ? item.sourceView.handles
          : undefined),
        entry.handles,
      );
      assert.deepEqual(
        views.map((item) => item.sourceView.kind === "processed-audio"
          ? item.sourceView.presentationClock.sliceOffset
          : undefined),
        entry.slices,
      );
      assert.deepEqual(execution.transitions[0]!.outgoingSource, entry.transitionSources.outgoing);
      assert.deepEqual(execution.transitions[0]!.incomingSource, entry.transitionSources.incoming);
      assert.deepEqual(
        edited.pcm,
        equalPowerTwoSourceTransition(
          origin.pcm,
          entry.totalFrames,
          entry.leftOriginStart,
          entry.rightOriginStart,
          entry.overlapStart,
          entry.overlapFrames,
        ),
        `${entry.rate}-speed slip/transition diverged from one origin evaluation and the frozen equal-power law`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retimed slip-transition admits exact residual handles and refuses one source sample over on either side", () => {
  const cases = [
    {
      rate: "half" as const,
      exact: "160ms",
      over: "(3841s / 24000)",
      outgoing: { start: rational(7, 25), duration: rational(1, 50) },
      incoming: { start: rational(1, 10), duration: rational(1, 50) },
    },
    {
      rate: "double" as const,
      exact: "80ms",
      over: "(7681s / 96000)",
      outgoing: { start: rational(23, 50), duration: rational(1, 25) },
      incoming: { start: rational(1, 10), duration: rational(1, 25) },
    },
  ] as const;
  for (const entry of cases) {
    const exact = compile(retimedSlipTransitionProgram(
      entry.rate,
      true,
      { left: [entry.exact], right: [`-${entry.exact}`] },
    ));
    const plan = exact.timelineEdits?.[0];
    assert.ok(plan);
    const transition = executeTimelineEditPlan(plan).transitions[0];
    assert.ok(transition);
    assert.deepEqual(transition.outgoingSource, entry.outgoing);
    assert.deepEqual(transition.incomingSource, entry.incoming);

    for (const [label, slips] of [
      ["outgoing", { left: [entry.over], right: [`-${entry.exact}`] }],
      ["incoming", { left: [entry.exact], right: [`-${entry.over}`] }],
    ] as const) {
      assert.throws(
        () => compile(retimedSlipTransitionProgram(
          entry.rate,
          true,
          slips,
        )),
        (error: unknown) => error instanceof CutCompileError
          && error.result.diagnostics.some((diagnostic) =>
            diagnostic.code === "CUT_TIMELINE_EDIT_HANDLE"
            && /handle|transition/u.test(diagnostic.message)),
        `${entry.rate} ${label} accepted one source sample beyond its residual transition handle`,
      );
    }
  }
});

test("combined slipped-transition authority mutations fail before direct or cached PCM publication", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-slip-transition-hostile-"));
  try {
    const valid = compile(retimedSlipTransitionProgram("half", true));
    await lockProject(valid, root);
    const published = await renderReferenceAudioArtifact(
      valid,
      valid.compositions[0]!,
      root,
    );
    assert.equal(published.cache.status, "miss");
    const before = (await readdir(root, { recursive: true })).sort();
    const mutations: ReadonlyArray<Readonly<{
      label: string;
      mutate(ir: CutAVIR): void;
    }>> = [
      {
        label: "consumed transition source",
        mutate(ir) {
          const track = audioTrack(ir);
          assert.ok(track.editorial.transitions?.[0]);
          track.editorial.transitions[0].outgoingSource.start =
            rational(10_561, 48_000);
        },
      },
      {
        label: "materialized slipped source",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view");
          assert.ok(view?.inputs.source?.kind === "range");
          assert.equal(view.inputs.source.start.kind, "quantity");
          view.inputs.source.start.magnitude = rational(5_761, 48_000);
        },
      },
      {
        label: "residual slipped handle",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view");
          assert.ok(view?.inputs.tailHandle?.kind === "quantity");
          view.inputs.tailHandle.magnitude = rational(3_839, 48_000);
        },
      },
      {
        label: "processed origin graph",
        mutate(ir) {
          const stretch = Object.values(ir.nodes).find((node) =>
            node.op === "cut.audio.time_stretch");
          assert.ok(stretch?.inputs.duration?.kind === "quantity");
          stretch.inputs.duration.magnitude = rational(19_199, 48_000);
        },
      },
    ];
    for (const mutation of mutations) {
      const hostile = structuredClone(valid);
      mutation.mutate(hostile);
      const composition = hostile.compositions[0]!;
      await assert.rejects(
        renderReferenceAudioSelection(
          hostile,
          composition,
          root,
          resolve(root, `must-not-exist-${mutation.label.replaceAll(" ", "-")}.f32le`),
          referenceMasterAudioRootIds(hostile, composition),
          { outputFormat: "raw-stereo-f32le" },
        ),
        /CUT_(?:TIMELINE_EDIT|AUDIO_REGION)/u,
        `${mutation.label} direct selection`,
      );
      await assert.rejects(
        renderReferenceAudioArtifact(hostile, composition, root),
        `${mutation.label} cache path`,
      );
      assert.deepEqual(
        (await readdir(root, { recursive: true })).sort(),
        before,
        `${mutation.label} allocated or published output/cache state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retimed transition handle, grid, rate, and origin tampering fail before cache publication", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-transition-hostile-"));
  try {
    const valid = compile(retimedTransitionProgram(true));
    await lockProject(valid, root);
    assert.doesNotThrow(() => validateReferenceSession(valid));
    const before = (await readdir(root, { recursive: true })).sort();
    const mutations: ReadonlyArray<Readonly<{
      label: string;
      mutate(ir: CutAVIR): void;
    }>> = [
      {
        label: "insufficient source-clock tail",
        mutate(ir) {
          const track = audioTrack(ir);
          const view = ir.nodes[track.editorial.transitions![0]!.outgoingNodeId]!;
          view.inputs.tailHandle = {
            kind: "quantity",
            dimension: "time",
            magnitude: rational(1, 100),
            unit: "s",
          };
        },
      },
      {
        label: "off-grid consumed source handle",
        mutate(ir) {
          const track = audioTrack(ir);
          track.editorial.transitions![0]!.outgoingSource.start = rational(9_601, 48_000);
        },
      },
      {
        label: "forged view rate",
        mutate(ir) {
          const track = audioTrack(ir);
          const view = ir.nodes[track.children[0]!]!;
          view.inputs.rate = {
            kind: "quantity",
            dimension: "scalar",
            magnitude: rational(3, 4),
            unit: "scalar",
          };
        },
      },
      {
        label: "forged origin reference",
        mutate(ir) {
          const track = audioTrack(ir);
          const view = ir.nodes[track.children[0]!]!;
          view.inputs.origin = { kind: "node-ref", id: track.id };
        },
      },
      {
        label: "external source beyond unsliced origin",
        mutate(ir) {
          const track = audioTrack(ir);
          const transition = track.editorial.transitions![0]!;
          transition.outgoingSource.start = rational(29, 100);
          transition.outgoingSource.duration = rational(1, 50);
        },
      },
    ];
    for (const mutation of mutations) {
      const hostile = structuredClone(valid);
      mutation.mutate(hostile);
      assert.throws(
        () => validateReferenceSession(hostile),
        /CUT_(?:TIMELINE_EDIT|AUDIO_REGION|IR_)/u,
        mutation.label,
      );
      await assert.rejects(
        renderReferenceAudioArtifact(hostile, hostile.compositions[0]!, root),
        mutation.label,
      );
      assert.deepEqual(
        (await readdir(root, { recursive: true })).sort(),
        before,
        `${mutation.label} allocated or published cache/output state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retimed origin rate, clock, and TimeStretch graph mutations reject before cache/output allocation", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-retimed-hostile-"));
  try {
    const valid = compile(retimedTrimProgram(true));
    await lockProject(valid, root);
    assert.doesNotThrow(() => validateReferenceSession(valid));
    const before = (await readdir(root, { recursive: true })).sort();
    const mutations: ReadonlyArray<Readonly<{
      label: string;
      mutate(ir: CutAVIR): void;
    }>> = [
      {
        label: "declared origin rate",
        mutate(ir) {
          const view = ir.timelineEdits?.[0]?.tracks
            .find((track) => track.trackId === "dialogue")?.items
            .find((item) => item.sourceView.kind === "processed-audio")?.sourceView;
          assert.ok(view?.kind === "processed-audio");
          (view as { rate: ReturnType<typeof rational> }).rate = rational(3, 4);
        },
      },
      {
        label: "origin presentation duration",
        mutate(ir) {
          const view = ir.timelineEdits?.[0]?.tracks
            .find((track) => track.trackId === "dialogue")?.items
            .find((item) => item.sourceView.kind === "processed-audio")?.sourceView;
          assert.ok(view?.kind === "processed-audio");
          (view.presentationClock as {
            originDuration: ReturnType<typeof rational>;
          }).originDuration = rational(199, 1_000);
        },
      },
      {
        label: "TimeStretch duration",
        mutate(ir) {
          const stretch = Object.values(ir.nodes).find((node) =>
            node.op === "cut.audio.time_stretch");
          assert.ok(stretch);
          stretch.inputs.duration = {
            kind: "quantity",
            dimension: "time",
            magnitude: rational(199, 1_000),
            unit: "s",
          };
        },
      },
    ];

    for (const mutation of mutations) {
      const hostile = structuredClone(valid);
      mutation.mutate(hostile);
      assert.throws(
        () => validateReferenceSession(hostile),
        /CUT_(?:TIMELINE_EDIT|AUDIO_REGION|AUDIO_TIME_STRETCH|IR_)/u,
        mutation.label,
      );
      await assert.rejects(
        renderReferenceAudioArtifact(
          hostile,
          hostile.compositions[0]!,
          root,
        ),
        mutation.label,
      );
      assert.deepEqual(
        (await readdir(root, { recursive: true })).sort(),
        before,
        `${mutation.label} allocated cache/output state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("variable TimeStretch inside a canonical structural edit remains a stable source-located refusal", () => {
  const source = `cut 0.4;
project "TimelineEdit variable audio retime refusal";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit
} from "@cut/edit";
import { AudioClip, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
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
    TimelineEdit(id: "split-variable", operations: [
      editSplit(
        selection: editSelection(
          trackIds: ["dialogue"],
          originIds: ["variable"]
        ),
        at: avTime(audio: 100ms)
      )
    ]);
  }
}
export out = render(main);`;
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.throws(
    () => compileCutModule(parsed.module!),
    (error: unknown) => {
      assert.ok(error instanceof CutCompileError);
      const diagnostic = error.result.diagnostics.find((candidate) =>
        candidate.code === "CUT2060"
        && /time_stretch.*pitch/u.test(candidate.message));
      assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
      assert.ok(diagnostic.span.start.line > 0);
      assert.ok(diagnostic.span.start.column > 0);
      return true;
    },
  );
});
