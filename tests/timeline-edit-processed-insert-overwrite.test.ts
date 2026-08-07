import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { inspectCutIr } from "../lib/runtime/inspect";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import {
  ReferenceTimelineEditMaterializationError,
  validateReferenceTimelineEditMaterializations,
} from "../lib/runtime/reference/timeline-edit";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function source(withEdit: boolean) {
  return `cut 0.4;
project "processed insert overwrite";
import {
  AudioTrack, AudioRegion, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, editInsert, editOverwrite
} from "@cut/edit";
import { AudioClip, Gain, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 400ms, fps: 25, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 400ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(destination: 0ms ..< 100ms, editId: "processed-source", role: "dialogue") {
        Gain(amount: -3db) {
          TimeStretch(sourceDuration: 50ms, duration: 100ms, pitch: 0, quality: "draft") {
            AudioClip(source: voice, range: 0ms ..< 50ms, fadeIn: 10ms, fadeOut: 10ms);
          }
        }
      }
      AudioClip(
        source: voice,
        range: 100ms ..< 300ms,
        destination: 100ms ..< 300ms,
        editId: "body",
        role: "dialogue"
      );
      AudioGap(destination: 300ms ..< 400ms);
    }
    ${withEdit ? `TimelineEdit(id: "processed-placement", operations: [
      editInsert(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 100ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "processed-source",
            originId: "inserted-processed",
            duration: 100ms
          )
        ])
      ),
      editOverwrite(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 300ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "processed-source",
            originId: "overwritten-processed",
            duration: 100ms
          )
        ])
      )
    ]);` : ""}
  }
}
export out = render(main);`;
}

function directFadedSource(withEdit: boolean) {
  return `cut 0.4;
project "faded direct insert overwrite";
import {
  AudioTrack, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, editInsert, editOverwrite
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 400ms, fps: 25, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 400ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 0ms ..< 100ms,
        destination: 0ms ..< 100ms,
        fadeIn: 10ms,
        fadeOut: 10ms,
        editId: "faded-source",
        role: "dialogue"
      );
      AudioClip(
        source: voice,
        range: 100ms ..< 300ms,
        destination: 100ms ..< 300ms,
        editId: "body",
        role: "dialogue"
      );
      AudioGap(destination: 300ms ..< 400ms);
    }
    ${withEdit ? `TimelineEdit(id: "faded-placement", operations: [
      editInsert(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 100ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "faded-source",
            originId: "inserted-faded",
            duration: 100ms
          )
        ])
      ),
      editOverwrite(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 300ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "faded-source",
            originId: "overwritten-faded",
            duration: 100ms
          )
        ])
      )
    ]);` : ""}
  }
}
export out = render(main);`;
}

function exactOneProcessedSource(withEdit: boolean) {
  return `cut 0.4;
project "exact-1x processed insert overwrite";
import {
  AudioTrack, AudioRegion, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, editInsert, editOverwrite
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 400ms, fps: 25, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 400ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(destination: 0ms ..< 100ms, editId: "processed-source", role: "dialogue") {
        Gain(amount: -3db) {
          HighPass(frequency: 800hz) {
            AudioClip(
              source: voice,
              range: 0ms ..< 100ms,
              fadeIn: 10ms,
              fadeOut: 10ms
            );
          }
        }
      }
      AudioClip(
        source: voice,
        range: 100ms ..< 300ms,
        destination: 100ms ..< 300ms,
        editId: "body",
        role: "dialogue"
      );
      AudioGap(destination: 300ms ..< 400ms);
    }
    ${withEdit ? `TimelineEdit(id: "exact-1x-processed-placement", operations: [
      editInsert(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 100ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "processed-source",
            originId: "inserted-processed",
            duration: 100ms
          )
        ])
      ),
      editOverwrite(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 300ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "processed-source",
            originId: "overwritten-processed",
            duration: 100ms
          )
        ])
      )
    ]);` : ""}
  }
}
export out = render(main);`;
}

function crossTrackProcessedSource(targetTrackId = "dialogue") {
  return `cut 0.4;
project "cross-track processed insert overwrite";
import {
  AudioTrack, AudioRegion, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, editInsert, editOverwrite
} from "@cut/edit";
import { AudioClip, Gain, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 400ms, fps: 25, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 400ms) {
    AudioTrack(trackId: "source-track", role: "dialogue") {
      AudioRegion(destination: 0ms ..< 100ms, editId: "processed-source", role: "dialogue") {
        Gain(amount: -3db) {
          TimeStretch(sourceDuration: 50ms, duration: 100ms, pitch: 0, quality: "draft") {
            AudioClip(source: voice, range: 0ms ..< 50ms, fadeIn: 10ms, fadeOut: 10ms);
          }
        }
      }
      AudioGap(destination: 100ms ..< 400ms);
    }
    AudioTrack(trackId: "${targetTrackId}", role: "dialogue") {
      AudioGap(destination: 0ms ..< 400ms);
    }
    TimelineEdit(id: "cross-track-processed-placement", operations: [
      editInsert(
        audio: editSelection(trackIds: ["${targetTrackId}"]),
        at: avTime(audio: 100ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "processed-source",
            originId: "inserted-processed",
            duration: 100ms
          )
        ])
      ),
      editOverwrite(
        audio: editSelection(trackIds: ["${targetTrackId}"]),
        at: avTime(audio: 200ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "processed-source",
            originId: "overwritten-processed",
            duration: 100ms
          )
        ])
      )
    ]);
  }
}
export out = render(main);`;
}

function crossTrackFadedDirectSource() {
  return `cut 0.4;
project "cross-track faded direct insert overwrite";
import {
  AudioTrack, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, editInsert, editOverwrite
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 400ms, fps: 25, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 400ms) {
    AudioTrack(trackId: "source-track", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 0ms ..< 100ms,
        destination: 0ms ..< 100ms,
        fadeIn: 10ms,
        fadeOut: 10ms,
        editId: "faded-source",
        role: "dialogue"
      );
      AudioGap(destination: 100ms ..< 400ms);
    }
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioGap(destination: 0ms ..< 400ms);
    }
    TimelineEdit(id: "cross-track-faded-placement", operations: [
      editInsert(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 100ms),
        operand: editOperand(parts: [
          editOperandPart(domain: "audio", sourceOriginId: "faded-source", originId: "inserted-faded", duration: 100ms)
        ])
      ),
      editOverwrite(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 200ms),
        operand: editOperand(parts: [
          editOperandPart(domain: "audio", sourceOriginId: "faded-source", originId: "overwritten-faded", duration: 100ms)
        ])
      )
    ]);
  }
}
export out = render(main);`;
}

function linkedPictureProcessedAudioSource() {
  return `cut 0.4;
project "linked picture processed audio insert overwrite";
import {
  Sequence, PictureTrack, PictureClip, Gap,
  AudioTrack, AudioRegion, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, editInsert, editOverwrite
} from "@cut/edit";
import { AudioClip, Gain, TimeStretch } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 480ms, fps: 25, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 480ms) {
    Sequence(duration: 480ms) {
      PictureTrack(trackId: "v1", role: "primary") {
        PictureClip(
          source: picture,
          range: 0ms ..< 120ms,
          duration: 120ms,
          link: "source-pair",
          editId: "source-picture",
          role: "primary"
        );
        PictureClip(
          source: picture,
          range: 120ms ..< 360ms,
          duration: 240ms,
          editId: "body-picture",
          role: "primary"
        );
        Gap(duration: 120ms);
      }
    }
    AudioTrack(trackId: "source-track", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 120ms,
        link: "source-pair",
        editId: "processed-source",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          TimeStretch(sourceDuration: 60ms, duration: 120ms, pitch: 0, quality: "draft") {
            AudioClip(source: voice, range: 0ms ..< 60ms, fadeIn: 10ms, fadeOut: 10ms);
          }
        }
      }
      AudioGap(destination: 120ms ..< 480ms);
    }
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioGap(destination: 0ms ..< 480ms);
    }
    TimelineEdit(id: "linked-processed-placement", operations: [
      editInsert(
        picture: editSelection(trackIds: ["v1"]),
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(picture: 120ms, audio: 120ms),
        operand: editOperand(
          linkId: "inserted-pair",
          parts: [
            editOperandPart(
              domain: "picture",
              sourceOriginId: "source-picture",
              originId: "inserted-picture",
              duration: 120ms
            ),
            editOperandPart(
              domain: "audio",
              sourceOriginId: "processed-source",
              originId: "inserted-audio",
              duration: 120ms
            )
          ]
        )
      ),
      editOverwrite(
        picture: editSelection(trackIds: ["v1"]),
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(picture: 240ms, audio: 240ms),
        operand: editOperand(
          linkId: "overwritten-pair",
          parts: [
            editOperandPart(
              domain: "picture",
              sourceOriginId: "source-picture",
              originId: "overwritten-picture",
              duration: 120ms
            ),
            editOperandPart(
              domain: "audio",
              sourceOriginId: "processed-source",
              originId: "overwritten-audio",
              duration: 120ms
            )
          ]
        )
      )
    ]);
  }
}
export out = render(main);`;
}

function compile(text: string) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  try {
    return compileCutModule(parsed.module).ir;
  } catch (error) {
    if (error instanceof CutCompileError) {
      assert.fail(JSON.stringify(error.result.diagnostics));
    }
    throw error;
  }
}

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const result = Buffer.alloc(44 + samples.length * 2);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + samples.length * 2, 4);
  result.write("WAVE", 8, "ascii");
  result.write("fmt ", 12, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => result.writeInt16LE(sample, 44 + index * 2));
  return result;
}

async function locked(text: string, root: string) {
  await writeFile(
    resolve(root, "voice.wav"),
    monoPcm16Wave(
      48_000,
      Array.from({ length: 24_000 }, (_, index) =>
        Math.round(Math.sin(index / 17) * 200 + Math.cos(index / 43) * 50)),
    ),
  );
  const ir = compile(text);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

async function lockedLinkedPictureProcessedAudio(root: string) {
  const red = Buffer.from(Array.from({ length: 16 * 16 }, () => [160, 24, 12]).flat());
  const blue = Buffer.from(Array.from({ length: 16 * 16 }, () => [16, 48, 176]).flat());
  const raw = Buffer.concat([
    ...Array.from({ length: 3 }, () => red),
    ...Array.from({ length: 9 }, () => blue),
  ]);
  const rawPath = resolve(root, "picture.rgb");
  await writeFile(rawPath, raw);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "16x16",
    "-framerate", "25", "-i", rawPath,
    "-frames:v", "12", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrp",
    resolve(root, "picture.mkv"),
  ]);
  await writeFile(
    resolve(root, "voice.wav"),
    monoPcm16Wave(
      48_000,
      Array.from({ length: 24_000 }, (_, index) =>
        Math.round(Math.sin(index / 17) * 200 + Math.cos(index / 43) * 50)),
    ),
  );
  const ir = compile(linkedPictureProcessedAudioSource());
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

function audioTrack(ir: CutAVIR, insertedEditId = "inserted-processed") {
  const track = Object.values(ir.nodes).find((node) =>
    node.op === "cut.edit.audio_track"
    && node.editorial?.kind === "audio-track"
    && node.editorial.trackId === "dialogue"
    && node.editorial.items.some((item) =>
      item.editId === insertedEditId));
  assert.ok(track?.editorial?.kind === "audio-track");
  return track as IRNode & {
    editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }>;
  };
}

test("public insert and overwrite share one authenticated processed origin and exact constant-retimed PCM", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-placement-"));
  const controlRoot = resolve(root, "control");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(controlRoot), mkdir(editedRoot)]);
  try {
    const control = await locked(source(false), controlRoot);
    const edited = await locked(source(true), editedRoot);
    assert.doesNotThrow(() => validateReferenceSession(edited));
    const receipt = validateReferenceTimelineEditMaterializations(edited);
    assert.equal(receipt.plans.length, 1);

    const track = audioTrack(edited);
    const views = track.children.map((id) => edited.nodes[id]!)
      .filter((node) => node.op === "cut.edit.timeline_audio_view");
    assert.equal(
      views.length,
      3,
      JSON.stringify(track.children.map((id) => [
        id,
        edited.nodes[id]?.op,
      ])),
    );
    const originIds = views.map((view) => {
      const origin = view.inputs.origin;
      assert.equal(origin?.kind, "node-ref");
      return origin.kind === "node-ref" ? origin.id : "";
    });
    assert.equal(new Set(originIds).size, 1, "copied operands restarted the origin graph");
    assert.equal(
      Object.values(edited.nodes).filter((node) =>
        node.op === "cut.edit.timeline_audio_origin").length,
      1,
    );
    assert.equal(
      Object.values(edited.nodes).filter((node) =>
        node.op === "cut.audio.time_stretch").length,
      1,
      "constant retime was flattened or cloned per placement",
    );
    const inspected = inspectCutIr(edited, "processed-placement.cut");
    const plan = inspected.timelineEdits?.find((item) =>
      item.id === "processed-placement");
    assert.ok(plan);
    const processed = plan.execution.tracks[0]!.items.filter((item) =>
      item.sourceView.kind === "processed-audio");
    assert.equal(processed.length, 3);
    assert.deepEqual(
      processed.map((item) =>
        item.sourceView.kind === "processed-audio"
          ? [
              item.originId,
              item.sourceView.rate,
              item.sourceView.presentationClock.authorityOriginId
                ?? item.originId,
              item.sourceView.presentationClock.sliceOffset,
            ]
          : undefined),
      [
        ["processed-source", rational(1, 2), "processed-source", rational(0)],
        ["inserted-processed", rational(1, 2), "processed-source", rational(0)],
        ["overwritten-processed", rational(1, 2), "processed-source", rational(0)],
      ],
    );

    const [controlArtifact, editedArtifact] = await Promise.all([
      renderReferenceAudioArtifact(control, control.compositions[0]!, controlRoot),
      renderReferenceAudioArtifact(edited, edited.compositions[0]!, editedRoot),
    ]);
    const [controlData, editedData] = await Promise.all([
      readFile(controlArtifact.path),
      readFile(editedArtifact.path),
    ]);
    const frames100ms = 4_800;
    const bytesPerStereoF32Frame = 8;
    const chunk = frames100ms * bytesPerStereoF32Frame;
    assert.deepEqual(
      editedData,
      Buffer.concat([
        controlData.subarray(0, chunk),
        controlData.subarray(0, chunk),
        controlData.subarray(chunk, chunk * 2),
        controlData.subarray(0, chunk),
      ]),
      "placed processed items changed the unsliced fade/retime/processor law",
    );
    const replay = await renderReferenceAudioArtifact(
      edited,
      edited.compositions[0]!,
      editedRoot,
    );
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), editedData);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faded direct insert and overwrite preserve one origin fade and exact PCM", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-faded-placement-"));
  const controlRoot = resolve(root, "control");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(controlRoot), mkdir(editedRoot)]);
  try {
    const control = await locked(directFadedSource(false), controlRoot);
    const edited = await locked(directFadedSource(true), editedRoot);
    assert.doesNotThrow(() => validateReferenceSession(edited));

    const track = audioTrack(edited, "inserted-faded");
    const views = track.children.map((id) => edited.nodes[id]!)
      .filter((node) => node.op === "cut.edit.timeline_audio_view");
    assert.equal(views.length, 3);
    const originIds = views.map((view) => {
      const origin = view.inputs.origin;
      assert.equal(origin?.kind, "node-ref");
      return origin.kind === "node-ref" ? origin.id : "";
    });
    assert.equal(new Set(originIds).size, 1, "placed fades restarted the direct origin");
    assert.equal(
      Object.values(edited.nodes).filter((node) =>
        node.op === "cut.edit.timeline_audio_origin").length,
      1,
    );

    const [controlArtifact, editedArtifact] = await Promise.all([
      renderReferenceAudioArtifact(control, control.compositions[0]!, controlRoot),
      renderReferenceAudioArtifact(edited, edited.compositions[0]!, editedRoot),
    ]);
    const [controlData, editedData] = await Promise.all([
      readFile(controlArtifact.path),
      readFile(editedArtifact.path),
    ]);
    const chunk = 4_800 * 8;
    assert.deepEqual(
      editedData,
      Buffer.concat([
        controlData.subarray(0, chunk),
        controlData.subarray(0, chunk),
        controlData.subarray(chunk, chunk * 2),
        controlData.subarray(0, chunk),
      ]),
      "same-track placement changed or restarted the authored direct fade",
    );

    const replay = await renderReferenceAudioArtifact(
      edited,
      edited.compositions[0]!,
      editedRoot,
    );
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), editedData);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact-1x processed AudioRegion complete-item insert and overwrite preserve one origin and exact PCM/cache identity", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-exact-1x-processed-placement-"));
  const controlRoot = resolve(root, "control");
  const editedRoot = resolve(root, "edited");
  await Promise.all([mkdir(controlRoot), mkdir(editedRoot)]);
  try {
    const control = await locked(exactOneProcessedSource(false), controlRoot);
    const edited = await locked(exactOneProcessedSource(true), editedRoot);
    assert.doesNotThrow(() => validateReferenceSession(edited));
    const receipt = validateReferenceTimelineEditMaterializations(edited);
    assert.equal(receipt.plans.length, 1);

    const track = audioTrack(edited);
    const views = track.children.map((id) => edited.nodes[id]!)
      .filter((node) => node.op === "cut.edit.timeline_audio_view");
    assert.equal(views.length, 3);
    const originIds = views.map((view) => {
      const origin = view.inputs.origin;
      assert.equal(origin?.kind, "node-ref");
      return origin.kind === "node-ref" ? origin.id : "";
    });
    assert.equal(
      new Set(originIds).size,
      1,
      "same-track complete-item placement restarted the processed origin",
    );
    assert.equal(
      Object.values(edited.nodes).filter((node) =>
        node.op === "cut.edit.timeline_audio_origin").length,
      1,
    );
    assert.equal(
      Object.values(edited.nodes).filter((node) =>
        node.op === "cut.audio.highpass").length,
      1,
      "same-track placement cloned the authored HighPass graph",
    );
    const plan = inspectCutIr(edited, "exact-1x-processed-placement.cut")
      .timelineEdits?.find((item) => item.id === "exact-1x-processed-placement");
    assert.ok(plan);
    const processed = plan.execution.tracks[0]!.items.filter((item) =>
      item.sourceView.kind === "processed-audio");
    assert.equal(processed.length, 3);
    assert.deepEqual(
      processed.map((item) => item.sourceView.kind === "processed-audio"
        ? [
            item.originId,
            item.sourceView.rate,
            item.sourceView.presentationClock.authorityOriginId ?? item.originId,
            item.sourceView.presentationClock.sliceOffset,
          ]
        : undefined),
      [
        ["processed-source", rational(1), "processed-source", rational(0)],
        ["inserted-processed", rational(1), "processed-source", rational(0)],
        ["overwritten-processed", rational(1), "processed-source", rational(0)],
      ],
    );

    const [controlArtifact, editedArtifact] = await Promise.all([
      renderReferenceAudioArtifact(control, control.compositions[0]!, controlRoot),
      renderReferenceAudioArtifact(edited, edited.compositions[0]!, editedRoot),
    ]);
    const [controlData, editedData] = await Promise.all([
      readFile(controlArtifact.path),
      readFile(editedArtifact.path),
    ]);
    const chunk = 4_800 * 8;
    assert.deepEqual(
      editedData,
      Buffer.concat([
        controlData.subarray(0, chunk),
        controlData.subarray(0, chunk),
        controlData.subarray(chunk, chunk * 2),
        controlData.subarray(0, chunk),
      ]),
      "same-track complete-item placement changed the exact-1x processed PCM law",
    );
    assert.equal(editedArtifact.cache.status, "miss");
    const replay = await renderReferenceAudioArtifact(
      edited,
      edited.compositions[0]!,
      editedRoot,
    );
    assert.equal(replay.cache.status, "hit");
    assert.equal(replay.cache.key, editedArtifact.cache.key);
    assert.deepEqual(await readFile(replay.path), editedData);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed placement authority, source, and materialized origin mutations fail before cache publication", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-placement-hostile-"));
  try {
    const valid = await locked(source(true), root);
    assert.doesNotThrow(() => validateReferenceSession(valid));
    const mutations: ReadonlyArray<Readonly<{
      label: string;
      mutate(ir: CutAVIR): void;
    }>> = [
      {
        label: "copied presentation origin",
        mutate(ir) {
          const item = ir.timelineEdits?.[0]?.tracks[0]?.items.find((entry) =>
            entry.originId === "processed-source");
          assert.ok(item?.sourceView.kind === "processed-audio");
          (item.sourceView.presentationClock as {
            authorityOriginId?: string;
          }).authorityOriginId = "forged-origin";
        },
      },
      {
        label: "operand source lineage",
        mutate(ir) {
          const operation = ir.timelineEdits?.[0]?.operations[0];
          assert.ok(operation?.kind === "insert");
          if (operation?.kind === "insert") {
            (operation.operand.parts[0] as { sourceOriginId: string }).sourceOriginId = "missing";
          }
        },
      },
      {
        label: "materialized origin reference",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view");
          assert.ok(view);
          view.inputs.origin = { kind: "node-ref", id: "missing-origin" };
        },
      },
    ];
    const before = (await readdir(root, { recursive: true })).sort();
    for (const mutation of mutations) {
      const hostile = structuredClone(valid);
      mutation.mutate(hostile);
      assert.throws(
        () => validateReferenceSession(hostile),
        (error: unknown) =>
          (error instanceof ReferenceTimelineEditMaterializationError
            || (error instanceof Error && /CUT_TIMELINE_EDIT/u.test(error.message))),
        mutation.label,
      );
      await assert.rejects(
        renderReferenceAudioArtifact(
          hostile,
          hostile.compositions[0]!,
          root,
        ),
        /CUT_(?:TIMELINE_EDIT|IR_)/u,
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

test("cross-track processed insert and overwrite bind one source-track origin and preserve exact PCM/cache identity", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cross-track-processed-placement-"));
  try {
    const sourceIr = compile(crossTrackProcessedSource());
    assert.deepEqual(
      diffCutAVIR(sourceIr, compile(crossTrackProcessedSource())).changes,
      [],
    );
    const renamedTrack = compile(crossTrackProcessedSource("dialogue-alt"));
    const authorityChange = diffCutAVIR(sourceIr, renamedTrack).changes.find(
      (change) =>
        change.entity === "timeline-edit"
        && change.id === "cross-track-processed-placement",
    );
    assert.equal(authorityChange?.operation, "modify");
    assert.ok(
      authorityChange?.operation === "modify"
      && authorityChange.fields.some((field) =>
        /^\/tracks\/1\/trackId$/u.test(field.path)),
      JSON.stringify(authorityChange),
    );

    const ir = await locked(crossTrackProcessedSource(), root);
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const receipt = validateReferenceTimelineEditMaterializations(ir);
    assert.equal(receipt.plans.length, 1);

    const plan = inspectCutIr(ir, "cross-track-processed-placement.cut")
      .timelineEdits?.find((item) =>
        item.id === "cross-track-processed-placement");
    assert.ok(plan);
    const target = plan.execution.tracks.find((track) =>
      track.trackId === "dialogue");
    assert.ok(target);
    const placed = target.items.filter((item) =>
      item.sourceView.kind === "processed-audio");
    assert.deepEqual(
      placed.map((item) => item.sourceView.kind === "processed-audio"
        ? [
            item.originId,
            item.sourceView.presentationClock.authorityTrackId,
            item.sourceView.presentationClock.authorityOriginId,
          ]
        : undefined),
      [
        ["inserted-processed", "source-track", "processed-source"],
        ["overwritten-processed", "source-track", "processed-source"],
      ],
    );

    const track = audioTrack(ir);
    const views = track.children.map((id) => ir.nodes[id]!)
      .filter((node) => node.op === "cut.edit.timeline_audio_view");
    assert.equal(views.length, 2);
    const origins = views.map((view) => {
      assert.equal(view.inputs.originTrackId?.kind, "string");
      assert.equal(
        view.inputs.originTrackId?.kind === "string"
          ? view.inputs.originTrackId.value
          : undefined,
        "source-track",
      );
      assert.equal(view.inputs.origin?.kind, "node-ref");
      return view.inputs.origin?.kind === "node-ref"
        ? view.inputs.origin.id
        : "";
    });
    assert.equal(new Set(origins).size, 1);
    const origin = ir.nodes[origins[0]!]!;
    assert.equal(origin.op, "cut.edit.timeline_audio_origin");
    assert.equal(origin.inputs.originTrackId, undefined);
    assert.equal(
      Object.values(ir.nodes).filter((node) =>
        node.op === "cut.audio.time_stretch").length,
      1,
      "cross-track placement cloned the authenticated processor graph",
    );
    const allViews = Object.values(ir.nodes).filter((node) =>
      node.op === "cut.edit.timeline_audio_view");
    assert.equal(allViews.length, 3);
    assert.deepEqual(
      [...new Set(allViews.map((view) =>
        view.inputs.origin?.kind === "node-ref"
          ? view.inputs.origin.id
          : ""))],
      [origin.id],
      "source and destination tracks did not share one authenticated origin",
    );

    const artifact = await renderReferenceAudioArtifact(
      ir,
      ir.compositions[0]!,
      root,
    );
    assert.equal(artifact.cache.status, "miss");
    const pcm = await readFile(artifact.path);
    const chunk = 4_800 * 8;
    assert.deepEqual(pcm.subarray(0, chunk), pcm.subarray(chunk, chunk * 2));
    assert.deepEqual(pcm.subarray(0, chunk), pcm.subarray(chunk * 2, chunk * 3));
    assert.deepEqual(
      pcm.subarray(chunk * 3, chunk * 4),
      Buffer.alloc(chunk),
    );
    const replay = await renderReferenceAudioArtifact(
      ir,
      ir.compositions[0]!,
      root,
    );
    assert.equal(replay.cache.status, "hit");
    assert.equal(replay.cache.key, artifact.cache.key);
    assert.deepEqual(await readFile(replay.path), pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coupled picture plus cross-track processed audio insert and overwrite preserve one linked transaction and exact pixels/PCM", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-processed-placement-"));
  try {
    const ir = await lockedLinkedPictureProcessedAudio(root);
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const receipt = validateReferenceTimelineEditMaterializations(ir);
    assert.equal(receipt.plans.length, 1);
    const inspected = inspectCutIr(ir, "linked-picture-processed-audio.cut")
      .timelineEdits?.find((item) => item.id === "linked-processed-placement");
    assert.ok(inspected);
    const picture = inspected.execution.tracks.find((track) => track.trackId === "v1");
    const dialogue = inspected.execution.tracks.find((track) => track.trackId === "dialogue");
    assert.ok(picture && dialogue);
    assert.deepEqual(
      picture.items.filter((item) =>
        item.originId === "inserted-picture" || item.originId === "overwritten-picture")
        .map((item) => [item.originId, item.linkId]),
      [
        ["inserted-picture", "inserted-pair"],
        ["overwritten-picture", "overwritten-pair"],
      ],
    );
    assert.deepEqual(
      dialogue.items.filter((item) =>
        item.originId === "inserted-audio" || item.originId === "overwritten-audio")
        .map((item) => [
          item.originId,
          item.linkId,
          item.sourceView.kind === "processed-audio"
            ? item.sourceView.presentationClock.authorityTrackId
            : undefined,
        ]),
      [
        ["inserted-audio", "inserted-pair", "source-track"],
        ["overwritten-audio", "overwritten-pair", "source-track"],
      ],
    );
    assert.equal(
      Object.values(ir.nodes).filter((node) =>
        node.op === "cut.audio.time_stretch").length,
      1,
    );
    assert.equal(
      Object.values(ir.nodes).filter((node) =>
        node.op === "cut.edit.timeline_audio_origin").length,
      1,
    );
    assert.equal(
      Object.values(ir.nodes).filter((node) =>
        node.op === "cut.edit.timeline_audio_view").length,
      3,
    );

    const composition = ir.compositions[0]!;
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, "visual-cache"),
    );
    await renderer.prepare();
    let frames: Buffer[];
    try {
      frames = [];
      for (const frame of [1, 4, 7, 10]) {
        frames.push(Buffer.from((await renderer.sceneFrame(scene, frame, false)).data));
      }
    } finally {
      renderer.close();
    }
    assert.deepEqual(frames[1], frames[0], "inserted picture diverged from its source frame");
    assert.deepEqual(frames[2], frames[0], "overwritten picture diverged from its source frame");
    assert.notDeepEqual(frames[3], frames[0], "unreplaced body picture lost its distinct source frame");

    const audio = await renderReferenceAudioArtifact(ir, composition, root);
    const pcm = await readFile(audio.path);
    const chunk = 5_760 * 8;
    assert.deepEqual(pcm.subarray(0, chunk), pcm.subarray(chunk, chunk * 2));
    assert.deepEqual(pcm.subarray(0, chunk), pcm.subarray(chunk * 2, chunk * 3));
    assert.deepEqual(pcm.subarray(chunk * 3, chunk * 4), Buffer.alloc(chunk));
    const replay = await renderReferenceAudioArtifact(ir, composition, root);
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-track audio authority mutations fail before cache publication", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cross-track-authority-hostile-"));
  try {
    const valid = await locked(crossTrackProcessedSource(), root);
    assert.doesNotThrow(() => validateReferenceSession(valid));
    const mutations: ReadonlyArray<Readonly<{
      label: string;
      mutate(ir: CutAVIR): void;
    }>> = [
      {
        label: "missing target origin track",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view"
            && node.inputs.originTrackId?.kind === "string");
          assert.ok(view);
          delete view.inputs.originTrackId;
        },
      },
      {
        label: "altered target origin track",
        mutate(ir) {
          const view = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_view"
            && node.inputs.originTrackId?.kind === "string");
          assert.ok(view);
          view.inputs.originTrackId = { kind: "string", value: "dialogue" };
        },
      },
      {
        label: "redundant owner origin track",
        mutate(ir) {
          const origin = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.timeline_audio_origin");
          assert.ok(origin);
          origin.inputs.originTrackId = {
            kind: "string",
            value: "source-track",
          };
        },
      },
    ];
    const before = (await readdir(root, { recursive: true })).sort();
    for (const mutation of mutations) {
      const hostile = structuredClone(valid);
      mutation.mutate(hostile);
      assert.throws(
        () => validateReferenceSession(hostile),
        /CUT_(?:TIMELINE_EDIT|EDIT_AUDIO_REGION|IR_)/u,
        mutation.label,
      );
      await assert.rejects(
        renderReferenceAudioArtifact(
          hostile,
          hostile.compositions[0]!,
          root,
        ),
        /CUT_(?:TIMELINE_EDIT|EDIT_AUDIO_REGION|IR_)/u,
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

test("cross-track faded direct insert and overwrite preserve one source-owned fade clock and exact PCM", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cross-track-faded-placement-"));
  try {
    const ir = await locked(crossTrackFadedDirectSource(), root);
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const views = Object.values(ir.nodes).filter((node) =>
      node.op === "cut.edit.timeline_audio_view");
    assert.equal(views.length, 3);
    const origins = new Set(views.map((view) =>
      view.inputs.origin?.kind === "node-ref" ? view.inputs.origin.id : ""));
    assert.equal(origins.size, 1);
    assert.deepEqual(
      views.filter((view) => view.inputs.originTrackId?.kind === "string")
        .map((view) => view.inputs.originTrackId),
      [
        { kind: "string", value: "source-track" },
        { kind: "string", value: "source-track" },
      ],
    );
    const artifact = await renderReferenceAudioArtifact(
      ir,
      ir.compositions[0]!,
      root,
    );
    const pcm = await readFile(artifact.path);
    const chunk = 4_800 * 8;
    assert.deepEqual(pcm.subarray(0, chunk), pcm.subarray(chunk, chunk * 2));
    assert.deepEqual(pcm.subarray(0, chunk), pcm.subarray(chunk * 2, chunk * 3));
    assert.deepEqual(pcm.subarray(chunk * 3), Buffer.alloc(chunk));
    const replay = await renderReferenceAudioArtifact(
      ir,
      ir.compositions[0]!,
      root,
    );
    assert.equal(replay.cache.status, "hit");
    assert.deepEqual(await readFile(replay.path), pcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
