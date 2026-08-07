import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { executeTimelineEditPlan } from "../lib/language/timeline-edit-operations";
import {
  referenceMasterAudioRootIds,
  renderReferenceAudioSelection,
} from "../lib/runtime/reference/audio";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const sampleRate = 48_000;
const channels = 2;
const bytesPerFloatSample = 4;
const frameBytes = channels * bytesPerFloatSample;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function monoPcm16Wave(samples: readonly number[]) {
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

function stereoF32Wave(pcm: Buffer) {
  assert.equal(pcm.length % frameBytes, 0);
  const buffer = Buffer.alloc(44 + pcm.length);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + pcm.length, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(3, 20); // IEEE float
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * frameBytes, 28);
  buffer.writeUInt16LE(frameBytes, 32);
  buffer.writeUInt16LE(32, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(pcm.length, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

function fixtureVoice() {
  return monoPcm16Wave(Array.from({ length: sampleRate }, (_, index) => {
    // The draft time-stretcher intentionally prioritizes determinism over
    // mastering quality and can ring sharply at its terminal boundary. Keep
    // this semantic splice witness well below full scale so the public cache
    // entrypoint's independent clipping refusal remains active.
    const carrier = Math.sin(index / 17) * 300;
    const overtone = Math.cos(index / 43) * 100;
    const step = (Math.floor(index / 480) % 11) * 6;
    return Math.max(-30_000, Math.min(30_000, Math.round(carrier + overtone + step)));
  }));
}

function retimedSlideProgram(mode: "origin" | "slide", by = "40ms") {
  return `cut 0.4;
project "constant-retimed processed slide ${mode}";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editSlide
} from "@cut/edit";
import { AudioClip, Gain, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 600ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 600ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 600ms,
        editId: "slow-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          TimeStretch(
            sourceDuration: 300ms,
            duration: 600ms,
            pitch: 0,
            quality: "draft"
          ) {
            AudioClip(
              source: voice,
              range: 100ms ..< 400ms,
              fadeIn: 60ms,
              fadeOut: 60ms
            );
          }
        }
      }
    }
    ${mode === "slide" ? `TimelineEdit(
      id: "retimed-processed-slide",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          at: avTime(audio: 200ms)
        ),
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          at: avTime(audio: 400ms)
        ),
        editSlide(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["slow-line"]
          ),
          range: 200ms ..< 400ms,
          by: avTime(audio: ${by})
        )
      ]
    );` : ""}
  }
}
export out = render(main);`;
}

function explicitFinalStateControlProgram() {
  return `cut 0.4;
project "explicit final-state control for retimed processed slide";
import { AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset processed: AudioAsset = audio("processed.wav");
timeline main(duration: 600ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 600ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: processed,
        range: 0ms ..< 240ms,
        destination: 0ms ..< 240ms
      );
      AudioClip(
        source: processed,
        range: 200ms ..< 400ms,
        destination: 240ms ..< 440ms
      );
      AudioClip(
        source: processed,
        range: 440ms ..< 600ms,
        destination: 440ms ..< 600ms
      );
    }
  }
}
export out = render(main);`;
}

async function lockProject(ir: CutAVIR, root: string) {
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  assert.doesNotThrow(() => validateReferenceSession(ir));
}

async function renderRaw(ir: CutAVIR, root: string) {
  await lockProject(ir, root);
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
  return readFile(output);
}

function sliceMilliseconds(pcm: Buffer, start: number, end: number) {
  const startByte = start * 48 * frameBytes;
  const endByte = end * 48 * frameBytes;
  assert.ok(startByte >= 0 && endByte <= pcm.length && endByte > startByte);
  return pcm.subarray(startByte, endByte);
}

test("constant-retimed processed editSlide equals an explicit final-state control and evaluates one origin", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-retimed-processed-slide-"));
  const originRoot = resolve(root, "origin");
  const slideRoot = resolve(root, "slide");
  const controlRoot = resolve(root, "control");
  await Promise.all([
    mkdir(originRoot, { recursive: true }),
    mkdir(slideRoot, { recursive: true }),
    mkdir(controlRoot, { recursive: true }),
  ]);
  try {
    const voice = fixtureVoice();
    await Promise.all([
      writeFile(resolve(originRoot, "voice.wav"), voice),
      writeFile(resolve(slideRoot, "voice.wav"), voice),
    ]);

    const originIr = compile(retimedSlideProgram("origin"));
    const originPcm = await renderRaw(originIr, originRoot);
    await writeFile(resolve(controlRoot, "processed.wav"), stereoF32Wave(originPcm));

    const slideIr = compile(retimedSlideProgram("slide"));
    const slidePcm = await renderRaw(slideIr, slideRoot);
    const controlIr = compile(explicitFinalStateControlProgram());
    const controlPcm = await renderRaw(controlIr, controlRoot);

    const plan = slideIr.timelineEdits?.[0];
    assert.ok(plan);
    const items = executeTimelineEditPlan(plan).tracks
      .find((track) => track.trackId === "dialogue")?.items
      .filter((item) => item.sourceView.kind === "processed-audio")
      .sort((left, right) =>
        Number(left.destination.start.numerator) / Number(left.destination.start.denominator)
        - Number(right.destination.start.numerator) / Number(right.destination.start.denominator));
    assert.ok(items);
    assert.deepEqual(items.map((item) => item.destination), [
      { start: rational(0), duration: rational(6, 25) },
      { start: rational(6, 25), duration: rational(1, 5) },
      { start: rational(11, 25), duration: rational(4, 25) },
    ]);
    assert.deepEqual(items.map((item) => item.sourceView.kind === "processed-audio"
      ? item.sourceView.source
      : undefined), [
      { start: rational(1, 10), duration: rational(3, 25) },
      { start: rational(1, 5), duration: rational(1, 10) },
      { start: rational(8, 25), duration: rational(2, 25) },
    ]);
    assert.deepEqual(items.map((item) => item.sourceView.kind === "processed-audio"
      ? item.sourceView.presentationClock.sliceOffset
      : undefined), [rational(0), rational(1, 5), rational(11, 25)]);
    assert.ok(items.every((item) =>
      item.sourceView.kind === "processed-audio"
      && JSON.stringify(item.sourceView.rate) === JSON.stringify(rational(1, 2))
      && item.sourceView.statePolicy === "single-authorized-evaluation"));
    assert.equal(
      Object.values(slideIr.nodes).filter((node) =>
        node.op === "cut.edit.timeline_audio_origin").length,
      1,
      "slide cloned the authenticated processed origin",
    );
    assert.equal(
      Object.values(slideIr.nodes).filter((node) =>
        node.op === "cut.audio.time_stretch").length,
      1,
      "slide cloned or restarted TimeStretch",
    );

    const expected = Buffer.concat([
      sliceMilliseconds(originPcm, 0, 240),
      sliceMilliseconds(originPcm, 200, 400),
      sliceMilliseconds(originPcm, 440, 600),
    ]);
    assert.deepEqual(
      slidePcm,
      expected,
      "slide did not splice exact presentation-clock slices from one processed origin",
    );
    assert.deepEqual(
      slidePcm,
      controlPcm,
      "slide differs from the explicitly authored final-state media ranges",
    );

    const cold = await renderReferenceAudioArtifact(
      slideIr,
      slideIr.compositions[0]!,
      slideRoot,
    );
    const replay = await renderReferenceAudioArtifact(
      slideIr,
      slideIr.compositions[0]!,
      slideRoot,
    );
    assert.equal(cold.cache.status, "miss");
    assert.equal(replay.cache.status, "hit");
    assert.equal(cold.cache.key, replay.cache.key);
    assert.deepEqual(await readFile(cold.path), slidePcm);
    assert.deepEqual(await readFile(replay.path), slidePcm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retimed slide admits the last non-collapsing audio-grid boundary and refuses collapse", () => {
  const exact = compile(retimedSlideProgram("slide", "199ms"));
  const plan = exact.timelineEdits?.[0];
  assert.ok(plan);
  const items = executeTimelineEditPlan(plan).tracks[0]!.items;
  assert.deepEqual(items.map((item) => item.destination), [
    { start: rational(0), duration: rational(399, 1_000) },
    { start: rational(399, 1_000), duration: rational(1, 5) },
    { start: rational(599, 1_000), duration: rational(1, 1_000) },
  ]);

  assert.throws(
    () => compile(retimedSlideProgram("slide", "200ms")),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "CUT_TIMELINE_EDIT_TIME"
        && /slide would collapse an adjacent item/u.test(diagnostic.message)),
    "a slide that collapses its right neighbor must fail before runtime",
  );
});
