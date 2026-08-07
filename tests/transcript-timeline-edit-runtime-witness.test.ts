import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import {
  compileCutModule,
  type CutCompileInputs,
} from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  renderReferenceAudioArtifact,
} from "../lib/runtime/reference/audio-cache";
import {
  renderReferenceFrameArtifact,
  renderReferencePreviewArtifact,
} from "../lib/runtime/reference/authoring-review";
import { referenceTranscriptCaptionConfig } from "../lib/runtime/reference/caption-render";

const exec = promisify(execFile);
const frameBytes = 2 * 4;
const sampleRate = 48_000;

const combinedTranscriptOperations = `editSplit(
        selection: editSelection(trackIds: ["picture.lesson", "audio.lesson"]),
        at: avTime(picture: 2s, audio: 2s)
      ),
      editTrim(
        selection: editSelection(trackIds: ["picture.lesson", "audio.lesson"]),
        keep: 1s..<3s
      ),
      editRippleDelete(
        selection: editSelection(trackIds: ["picture.lesson", "audio.lesson"]),
        range: 2s..<3s
      )`;

const trimOnlyTranscriptOperation = `editTrim(
        selection: editSelection(trackIds: ["picture.lesson", "audio.lesson"]),
        keep: 1s..<2s
      )`;

const middleRippleTranscriptOperation = `editRippleDelete(
        selection: editSelection(trackIds: ["picture.lesson", "audio.lesson"]),
        range: 2s..<3s
      )`;

function editedSource(
  from = "line.1",
  through = "line.2",
  mediaDurationSeconds = 2,
  operations = combinedTranscriptOperations,
) {
  const mediaEndSeconds = 1 + mediaDurationSeconds;
  const pictureTail = mediaEndSeconds < 4
    ? `\n        Gap(duration: ${4 - mediaEndSeconds}s);`
    : "";
  const audioTail = mediaEndSeconds < 4
    ? `\n      AudioGap(destination: ${mediaEndSeconds}s..<4s);`
    : "";
  return `cut 0.4;
project "transcript TimelineEdit decoded runtime witness";
import {
  AudioGap, AudioTrack, Gap, PictureTrack, Sequence, TimelineEdit,
  TranscriptAudio, TranscriptPicture, avTime, editRippleDelete,
  editSelection, editSplit, editTrim, transcriptEdit, transcriptMedia
} from "@cut/edit";

asset words: DataAsset = data("assets/lesson.cut-transcript.json");
asset narration: AudioAsset = audio("assets/narration.wav", stream: 0);
asset lesson: VideoAsset = video("assets/lesson.mkv", videoStream: 0);

timeline main(duration: 4s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene lesson_scene(duration: 4s) {
    let sync: TranscriptMediaAuthority = transcriptMedia(
      transcript: words,
      audio: narration,
      audioStream: 0,
      video: lesson,
      videoStream: 0,
      videoFrameRate: 4,
      videoDuration: 6s,
      audioAt: 0s,
      videoAt: 0s,
      videoRate: 1
    );
    let excerpt: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: narration,
      from: "${from}",
      through: "${through}",
      at: 1s,
      link: "lesson-av",
      media: sync
    );
    Sequence(duration: 4s) {
      PictureTrack(trackId: "picture.lesson", role: "primary") {
        Gap(duration: 1s);
        TranscriptPicture(edit: excerpt, source: lesson, duration: ${mediaDurationSeconds}s, rate: 1);${pictureTail}
      }
    }
    AudioTrack(trackId: "audio.lesson", role: "dialogue") {
      AudioGap(destination: 0s..<1s);
      TranscriptAudio(edit: excerpt);${audioTail}
    }
    TimelineEdit(id: "lesson-transcript-split-trim-ripple", operations: [
      ${operations}
    ]);
  }
}

export proof = render(main, width: 64px, height: 64px, codec: "h264");
`;
}

function captionedSource(source: string) {
  return source
    .replace(
      '} from "@cut/edit";',
      '} from "@cut/edit";\nimport { TranscriptCaptions } from "cut:visual";',
    )
    .replace(
      'asset lesson: VideoAsset = video("assets/lesson.mkv", videoStream: 0);',
      'asset lesson: VideoAsset = video("assets/lesson.mkv", videoStream: 0);\nasset face: FontAsset = font("assets/Geist-Regular.ttf");',
    )
    .replace(
      '    TimelineEdit(id: "lesson-transcript-split-trim-ripple"',
      '    TranscriptCaptions(edit: excerpt, font: face, maxWords: 1, size: 12px, position: "bottom", safeX: 5%, safeY: 5%, maxWidth: 90%, padding: 0px);\n    TimelineEdit(id: "lesson-transcript-split-trim-ripple"',
    );
}

function captionedEditedSource() {
  return captionedSource(editedSource());
}

const controlSource = `cut 0.4;
project "ordinary decoded runtime counterfactual";
import {
  AudioGap, AudioTrack, Gap, PictureClip, PictureTrack, Sequence
} from "@cut/edit";
import { AudioClip } from "@cut/audio";

asset narration: AudioAsset = audio("assets/narration.wav", stream: 0);
asset lesson: VideoAsset = video("assets/lesson.mkv", videoStream: 0);

timeline main(duration: 4s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene lesson_scene(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(trackId: "picture.lesson", role: "primary") {
        Gap(duration: 1s);
        PictureClip(source: lesson, range: 1s..<2s, duration: 1s);
        Gap(duration: 2s);
      }
    }
    AudioTrack(trackId: "audio.lesson", role: "dialogue") {
      AudioGap(destination: 0s..<1s);
      AudioClip(
        source: narration,
        range: 1s..<2s,
        destination: 1s..<2s
      );
      AudioGap(destination: 2s..<4s);
    }
  }
}

export proof = render(main, width: 64px, height: 64px, codec: "h264");
`;

const middleRippleControlSource = `cut 0.4;
project "ordinary middle-ripple decoded runtime counterfactual";
import {
  AudioGap, AudioTrack, Gap, PictureClip, PictureTrack, Sequence
} from "@cut/edit";
import { AudioClip } from "@cut/audio";

asset narration: AudioAsset = audio("assets/narration.wav", stream: 0);
asset lesson: VideoAsset = video("assets/lesson.mkv", videoStream: 0);

timeline main(duration: 4s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene lesson_scene(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(trackId: "picture.lesson", role: "primary") {
        Gap(duration: 1s);
        PictureClip(source: lesson, range: 1s..<2s, duration: 1s);
        PictureClip(source: lesson, range: 3s..<4s, duration: 1s);
        Gap(duration: 1s);
      }
    }
    AudioTrack(trackId: "audio.lesson", role: "dialogue") {
      AudioGap(destination: 0s..<1s);
      AudioClip(source: narration, range: 1s..<2s, destination: 1s..<2s);
      AudioClip(source: narration, range: 3s..<4s, destination: 2s..<3s);
      AudioGap(destination: 3s..<4s);
    }
  }
}

export proof = render(main, width: 64px, height: 64px, codec: "h264");
`;

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [
    ...parsed.diagnostics,
    ...checkCutModule(parsed.module).diagnostics,
  ].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return parsed.module;
}

function compile(source: string, sidecar?: string) {
  const inputs: CutCompileInputs | undefined = sidecar
    ? { transcriptSidecars: new Map([["words", sidecar]]) }
    : undefined;
  return compileCutModule(
    moduleFor(source),
    {},
    undefined,
    undefined,
    inputs,
  ).ir;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pcm24Wave(frames = 6 * sampleRate) {
  const payloadBytes = frames * 2 * 3;
  const result = Buffer.alloc(44 + payloadBytes);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.byteLength - 8, 4);
  result.write("WAVE", 8, "ascii");
  result.write("fmt ", 12, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(2, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2 * 3, 28);
  result.writeUInt16LE(2 * 3, 32);
  result.writeUInt16LE(24, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(payloadBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const left = (frame * 9_973 % 4_194_304) - 2_097_152;
    const right = (frame * 7_919 % 4_194_304) - 2_097_152;
    result.writeIntLE(left, 44 + frame * 6, 3);
    result.writeIntLE(right, 47 + frame * 6, 3);
  }
  return result;
}

function sidecar(audioSha256: string) {
  return `${JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: audioSha256,
      audioStreamIndex: 0,
      audioSampleRate: sampleRate,
      duration: { numerator: "6", denominator: "1" },
    },
    words: [
      {
        id: "line.1",
        start: { numerator: "1", denominator: "1" },
        end: { numerator: "2", denominator: "1" },
        text: "Canonical",
        join: "none",
      },
      {
        id: "line.2",
        start: { numerator: "2", denominator: "1" },
        end: { numerator: "3", denominator: "1" },
        text: "editing",
        join: "space",
      },
      {
        id: "line.3",
        start: { numerator: "3", denominator: "1" },
        end: { numerator: "4", denominator: "1" },
        text: "continues.",
        join: "space",
      },
    ],
  })}\n`;
}

async function makeVideo(root: string) {
  const frames = resolve(root, "source-frames");
  await mkdir(frames, { recursive: true });
  await Promise.all(Array.from({ length: 24 }, (_, index) =>
    sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        // Every source frame is unique. The middle-ripple witness compares
        // source seconds one and three, so a short repeating color cycle
        // would make an incorrect, unshifted picture accidentally look equal.
        background: {
          r: (31 + index * 47) % 256,
          g: (73 + index * 71) % 256,
          b: (127 + index * 101) % 256,
        },
      },
    }).png().toFile(resolve(frames, `${String(index).padStart(2, "0")}.png`))));
  await exec("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    "4",
    "-i",
    resolve(frames, "%02d.png"),
    "-c:v",
    "ffv1",
    "-pix_fmt",
    "yuv444p",
    resolve(root, "lesson.mkv"),
  ]);
}

type Fixture = Readonly<{
  root: string;
  audio: string;
  video: string;
  transcript: string;
}>;

async function baseFixture(t: TestContext) {
  const base = await mkdtemp(resolve(tmpdir(), "cut-transcript-timeline-runtime-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const audio = resolve(base, "narration.wav");
  await Promise.all([
    writeFile(audio, pcm24Wave()),
    makeVideo(base),
  ]);
  return {
    base,
    audio,
    video: resolve(base, "lesson.mkv"),
    transcript: sidecar(sha256(await readFile(audio))),
  };
}

async function projectFixture(
  base: Awaited<ReturnType<typeof baseFixture>>,
  name: string,
  includeTranscript = true,
): Promise<Fixture> {
  const root = resolve(base.base, name);
  const assets = resolve(root, "assets");
  await mkdir(assets, { recursive: true });
  const audio = resolve(assets, "narration.wav");
  const video = resolve(assets, "lesson.mkv");
  const transcript = resolve(assets, "lesson.cut-transcript.json");
  await Promise.all([
    copyFile(base.audio, audio),
    copyFile(base.video, video),
    copyFile(
      resolve("examples/fixtures/Geist-Regular.ttf"),
      resolve(assets, "Geist-Regular.ttf"),
    ),
    ...(includeTranscript
      ? [writeFile(transcript, base.transcript)]
      : []),
  ]);
  return { root, audio, video, transcript };
}

async function locked(
  fixture: Fixture,
  source: string,
  transcript?: string,
) {
  const ir = compile(source, transcript);
  const lock = await createCutLock(ir, fixture.root);
  await applyCutLock(ir, lock, fixture.root);
  return ir;
}

async function frame(
  ir: CutAVIR,
  root: string,
  index: number,
  name: string,
) {
  return renderReferenceFrameArtifact(
    ir,
    root,
    resolve(root, "review", `${name}.png`),
    { frame: index, mediaProfile: "master" },
  );
}

async function missing(path: string) {
  await assert.rejects(access(path), (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error
      && error.code === "ENOENT"));
}

test("EDT-09 public linked transcript split+trim+ripple executes exact picture/PCM, deterministic cache identity, and fail-closed authority", { timeout: 240_000 }, async (t) => {
  const base = await baseFixture(t);
  const editedFixture = await projectFixture(base, "edited");
  const controlFixture = await projectFixture(base, "control", false);
  const captionedFixture = await projectFixture(base, "captioned");
  const edited = await locked(editedFixture, editedSource(), base.transcript);
  const control = await locked(controlFixture, controlSource);
  const captioned = await locked(
    captionedFixture,
    captionedEditedSource(),
    base.transcript,
  );

  assert.deepEqual(
    edited.timelineEdits?.[0]?.operations.map((operation) => operation.kind),
    ["split", "trim", "ripple-delete"],
  );
  assert.deepEqual(edited.timelineEdits?.[0]?.tracks.map((track) => [
    track.trackId,
    track.domain,
  ]), [
    ["picture.lesson", "picture"],
    ["audio.lesson", "audio"],
  ]);

  const selectedFrames = [3, 5, 8] as const;
  const editedFrames = [];
  const controlFrames = [];
  for (const index of selectedFrames) {
    editedFrames.push(await frame(edited, editedFixture.root, index, `edited-${index}`));
    controlFrames.push(await frame(control, controlFixture.root, index, `control-${index}`));
  }
  assert.deepEqual(
    editedFrames.map((manifest) => manifest.artifact.rgbaSha256),
    controlFrames.map((manifest) => manifest.artifact.rgbaSha256),
    "linked transcript TimelineEdit pixels must exactly equal ordinary decoded source selection before/interior/after",
  );
  assert.equal(
    editedFrames[0]!.artifact.rgbaSha256,
    editedFrames[2]!.artifact.rgbaSha256,
    "before and after witnesses must both be canonical transparent-black",
  );
  assert.notEqual(
    editedFrames[1]!.artifact.rgbaSha256,
    editedFrames[0]!.artifact.rgbaSha256,
    "the interior witness must execute decoded picture bytes",
  );
  const repeatedFrame = await frame(edited, editedFixture.root, 5, "edited-5-repeat");
  assert.equal(
    repeatedFrame.artifact.rgbaSha256,
    editedFrames[1]!.artifact.rgbaSha256,
  );

  const captionNode = Object.values(captioned.nodes).find((node) =>
    node.op === "cut.visual.transcript_captions");
  assert.ok(captionNode);
  const captionConfig = referenceTranscriptCaptionConfig(
    captionNode,
    captioned,
    captioned.compositions[0]!,
  );
  assert.ok(captionConfig);
  assert.deepEqual(captionConfig.track.cues.map((cue) => ({
    start: cue.start,
    end: cue.end,
    lines: cue.lines,
  })), [{
    start: { numerator: "1", denominator: "1" },
    end: { numerator: "2", denominator: "1" },
    lines: ["Canonical"],
  }]);
  const captionFrames = [];
  for (const index of selectedFrames) {
    captionFrames.push(await frame(
      captioned,
      captionedFixture.root,
      index,
      `captioned-${index}`,
    ));
  }
  assert.equal(
    captionFrames[0]!.artifact.rgbaSha256,
    editedFrames[0]!.artifact.rgbaSha256,
    "caption lineage must be blank before its retained destination word",
  );
  assert.notEqual(
    captionFrames[1]!.artifact.rgbaSha256,
    editedFrames[1]!.artifact.rgbaSha256,
    "the retained canonical word must materially change decoded picture pixels",
  );
  assert.equal(
    captionFrames[2]!.artifact.rgbaSha256,
    editedFrames[2]!.artifact.rgbaSha256,
    "ripple-deleted transcript words must not leave stale caption pixels",
  );
  const repeatedCaption = await frame(
    captioned,
    captionedFixture.root,
    5,
    "captioned-5-repeat",
  );
  assert.equal(
    repeatedCaption.artifact.rgbaSha256,
    captionFrames[1]!.artifact.rgbaSha256,
  );

  const editedAudio = await renderReferenceAudioArtifact(
    edited,
    edited.compositions[0]!,
    editedFixture.root,
  );
  const controlAudio = await renderReferenceAudioArtifact(
    control,
    control.compositions[0]!,
    controlFixture.root,
  );
  const [editedPcm, controlPcm] = await Promise.all([
    readFile(editedAudio.path),
    readFile(controlAudio.path),
  ]);
  assert.deepEqual(
    editedPcm,
    controlPcm,
    "linked transcript TimelineEdit PCM must exactly equal ordinary decoded source selection",
  );
  assert.ok(
    editedPcm.subarray(0, sampleRate * frameBytes).every((byte) => byte === 0),
    "PCM before the retained transcript interval must be exact silence",
  );
  assert.ok(
    editedPcm
      .subarray(sampleRate * frameBytes, 2 * sampleRate * frameBytes)
      .some((byte) => byte !== 0),
    "PCM inside the retained transcript interval must contain decoded source",
  );
  assert.ok(
    editedPcm
      .subarray(2 * sampleRate * frameBytes)
      .every((byte) => byte === 0),
    "PCM after the retained transcript interval must be exact silence",
  );
  const replayAudio = await renderReferenceAudioArtifact(
    edited,
    edited.compositions[0]!,
    editedFixture.root,
  );
  assert.equal(editedAudio.cache.status, "miss");
  assert.equal(replayAudio.cache.status, "hit");
  assert.equal(replayAudio.cache.key, editedAudio.cache.key);
  assert.deepEqual(await readFile(replayAudio.path), editedPcm);

  const firstPreview = await renderReferencePreviewArtifact(
    edited,
    editedFixture.root,
    resolve(editedFixture.root, "review", "edited-preview.mp4"),
    { range: "0s:4s", width: 64, mediaProfile: "proxy" },
  );
  const replayPreview = await renderReferencePreviewArtifact(
    edited,
    editedFixture.root,
    resolve(editedFixture.root, "review", "edited-preview-repeat.mp4"),
    { range: "0s:4s", width: 64, mediaProfile: "proxy" },
  );
  assert.equal(firstPreview.execution.cache.status, "miss");
  assert.equal(replayPreview.execution.cache.status, "hit");
  assert.equal(replayPreview.execution.cache.key, firstPreview.execution.cache.key);
  assert.equal(replayPreview.artifact.sha256, firstPreview.artifact.sha256);

  const changed = await locked(
    editedFixture,
    editedSource("line.2", "line.3"),
    base.transcript,
  );
  const editedBinding = edited.transcriptBindings?.[0];
  const changedBinding = changed.transcriptBindings?.[0];
  assert.ok(editedBinding);
  assert.ok(changedBinding);
  const inspectedBinding = inspectCutIr(
    edited,
    "transcript-timeline-runtime.cut",
  ).transcriptBindings.find((binding) => binding.id === editedBinding.id);
  const inspectedChangedBinding = inspectCutIr(
    changed,
    "transcript-timeline-runtime-changed.cut",
  ).transcriptBindings.find((binding) => binding.id === changedBinding.id);
  assert.deepEqual(
    inspectedBinding && {
      id: inspectedBinding.id,
      from: inspectedBinding.from,
      through: inspectedBinding.through,
      selectedWordCount: inspectedBinding.selectedWordCount,
      selectedIdsSha256: inspectedBinding.selectedIdsSha256,
      words: inspectedBinding.words.map((word) => word.id),
    },
    {
      id: editedBinding.id,
      from: "line.1",
      through: "line.2",
      selectedWordCount: 2,
      selectedIdsSha256: editedBinding.selectedIdsSha256,
      words: ["line.1", "line.2"],
    },
    "inspect must publish the exact selected-word authority used by execution",
  );
  assert.deepEqual(
    inspectedChangedBinding && {
      id: inspectedChangedBinding.id,
      from: inspectedChangedBinding.from,
      through: inspectedChangedBinding.through,
      selectedWordCount: inspectedChangedBinding.selectedWordCount,
      selectedIdsSha256: inspectedChangedBinding.selectedIdsSha256,
      words: inspectedChangedBinding.words.map((word) => word.id),
    },
    {
      id: changedBinding.id,
      from: "line.2",
      through: "line.3",
      selectedWordCount: 2,
      selectedIdsSha256: changedBinding.selectedIdsSha256,
      words: ["line.2", "line.3"],
    },
    "changed inspect output must bind the changed selected-word authority",
  );
  const selectionDiff = diffCutAVIR(edited, changed);
  assert.deepEqual(
    selectionDiff.changes
      .filter((change) => change.entity === "transcript-binding")
      .map((change) => [change.id, change.operation])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    [
      [editedBinding.id, "remove"],
      [changedBinding.id, "add"],
    ].sort(([left], [right]) => String(left).localeCompare(String(right))),
    "semantic diff must replace the exact inspect-visible selected-word authority",
  );
  assert.equal(
    selectionDiff.changes.find((change) =>
      change.entity === "timeline-edit"
      && change.id === "lesson-transcript-split-trim-ripple")?.operation,
    "modify",
    "the canonical edit identity must correlate with the changed word selection",
  );
  const changedAudio = await renderReferenceAudioArtifact(
    changed,
    changed.compositions[0]!,
    editedFixture.root,
  );
  const changedPreview = await renderReferencePreviewArtifact(
    changed,
    editedFixture.root,
    resolve(editedFixture.root, "review", "changed-selection.mp4"),
    { range: "0s:4s", width: 64, mediaProfile: "proxy" },
  );
  assert.equal(changedAudio.cache.status, "miss");
  assert.notEqual(changedAudio.cache.key, editedAudio.cache.key);
  assert.equal(changedPreview.execution.cache.status, "miss");
  assert.notEqual(
    changedPreview.execution.cache.key,
    firstPreview.execution.cache.key,
  );

  const wordMutationFixture = await projectFixture(base, "word-mutation");
  const wordMutation = await locked(
    wordMutationFixture,
    editedSource(),
    base.transcript,
  );
  await writeFile(
    wordMutationFixture.transcript,
    base.transcript.replace("Canonical", "Hostile"),
  );
  const wordOutput = resolve(wordMutationFixture.root, "review", "must-not-word.png");
  await assert.rejects(
    renderReferenceFrameArtifact(
      wordMutation,
      wordMutationFixture.root,
      wordOutput,
      { frame: 5, mediaProfile: "master" },
    ),
    /CUT_LOCK_INTEGRITY: Locked (?:master input (?:size|sha256|bytes)|resource bytes) changed/u,
  );
  await missing(wordOutput);
  await missing(`${wordOutput}.manifest.json`);

  const mediaMutationFixture = await projectFixture(base, "media-mutation");
  const mediaMutation = await locked(
    mediaMutationFixture,
    editedSource(),
    base.transcript,
  );
  const originalAudio = await readFile(mediaMutationFixture.audio);
  const hostileAudio = Buffer.from(originalAudio);
  hostileAudio[hostileAudio.byteLength - 1] ^= 0xff;
  await writeFile(mediaMutationFixture.audio, hostileAudio);
  const mediaOutput = resolve(mediaMutationFixture.root, "review", "must-not-media.png");
  await assert.rejects(
    renderReferenceFrameArtifact(
      mediaMutation,
      mediaMutationFixture.root,
      mediaOutput,
      { frame: 5, mediaProfile: "master" },
    ),
    /CUT_LOCK_INTEGRITY: Locked (?:master input (?:size|sha256|bytes)|resource bytes) changed/u,
  );
  await missing(mediaOutput);
  await missing(`${mediaOutput}.manifest.json`);
});

test("EDT-09 trim and middle ripple independently execute decoded picture, PCM, captions, cache replay, and fail-closed authority", { timeout: 240_000 }, async (t) => {
  const base = await baseFixture(t);
  const trimSource = editedSource(
    "line.1",
    "line.2",
    2,
    trimOnlyTranscriptOperation,
  );
  const rippleSource = editedSource(
    "line.1",
    "line.3",
    3,
    middleRippleTranscriptOperation,
  );
  const [
    trimFixture,
    trimControlFixture,
    trimCaptionFixture,
    rippleFixture,
    rippleControlFixture,
    rippleCaptionFixture,
    rippleMutationFixture,
  ] = await Promise.all([
    projectFixture(base, "trim-only"),
    projectFixture(base, "trim-control", false),
    projectFixture(base, "trim-captioned"),
    projectFixture(base, "middle-ripple"),
    projectFixture(base, "middle-ripple-control", false),
    projectFixture(base, "middle-ripple-captioned"),
    projectFixture(base, "middle-ripple-mutation"),
  ]);
  const trim = await locked(trimFixture, trimSource, base.transcript);
  const trimControl = await locked(trimControlFixture, controlSource);
  const trimCaptioned = await locked(
    trimCaptionFixture,
    captionedSource(trimSource),
    base.transcript,
  );
  const ripple = await locked(rippleFixture, rippleSource, base.transcript);
  const rippleControl = await locked(
    rippleControlFixture,
    middleRippleControlSource,
  );
  const rippleCaptioned = await locked(
    rippleCaptionFixture,
    captionedSource(rippleSource),
    base.transcript,
  );

  assert.deepEqual(
    trim.timelineEdits?.[0]?.operations.map((operation) => operation.kind),
    ["trim"],
  );
  const trimFrames = [];
  const trimControlFrames = [];
  for (const index of [3, 5, 8] as const) {
    trimFrames.push(await frame(trim, trimFixture.root, index, `trim-${index}`));
    trimControlFrames.push(await frame(
      trimControl,
      trimControlFixture.root,
      index,
      `trim-control-${index}`,
    ));
  }
  assert.deepEqual(
    trimFrames.map((manifest) => manifest.artifact.rgbaSha256),
    trimControlFrames.map((manifest) => manifest.artifact.rgbaSha256),
    "trim-only transcript pixels must exactly equal the ordinary decoded one-second control",
  );
  assert.notEqual(
    trimFrames[1]!.artifact.rgbaSha256,
    trimFrames[0]!.artifact.rgbaSha256,
    "trim-only interior must execute decoded picture bytes",
  );
  assert.equal(
    trimFrames[0]!.artifact.rgbaSha256,
    trimFrames[2]!.artifact.rgbaSha256,
    "trim-only exterior frames must be canonical transparent-black",
  );
  const trimRepeat = await frame(trim, trimFixture.root, 5, "trim-5-repeat");
  assert.equal(trimRepeat.artifact.rgbaSha256, trimFrames[1]!.artifact.rgbaSha256);

  const trimCaptionNode = Object.values(trimCaptioned.nodes).find((node) =>
    node.op === "cut.visual.transcript_captions");
  assert.ok(trimCaptionNode);
  const trimCaptionConfig = referenceTranscriptCaptionConfig(
    trimCaptionNode,
    trimCaptioned,
    trimCaptioned.compositions[0]!,
  );
  assert.deepEqual(trimCaptionConfig?.track.cues.map((cue) => ({
    start: cue.start,
    end: cue.end,
    lines: cue.lines,
  })), [{
    start: { numerator: "1", denominator: "1" },
    end: { numerator: "2", denominator: "1" },
    lines: ["Canonical"],
  }]);
  const trimCaptionBefore = await frame(
    trimCaptioned,
    trimCaptionFixture.root,
    3,
    "trim-caption-before",
  );
  const trimCaptionInside = await frame(
    trimCaptioned,
    trimCaptionFixture.root,
    5,
    "trim-caption-inside",
  );
  const trimCaptionAfter = await frame(
    trimCaptioned,
    trimCaptionFixture.root,
    8,
    "trim-caption-after",
  );
  assert.equal(trimCaptionBefore.artifact.rgbaSha256, trimFrames[0]!.artifact.rgbaSha256);
  assert.notEqual(trimCaptionInside.artifact.rgbaSha256, trimFrames[1]!.artifact.rgbaSha256);
  assert.equal(trimCaptionAfter.artifact.rgbaSha256, trimFrames[2]!.artifact.rgbaSha256);

  const trimAudio = await renderReferenceAudioArtifact(
    trim,
    trim.compositions[0]!,
    trimFixture.root,
  );
  const trimControlAudio = await renderReferenceAudioArtifact(
    trimControl,
    trimControl.compositions[0]!,
    trimControlFixture.root,
  );
  const trimPcm = await readFile(trimAudio.path);
  assert.deepEqual(
    trimPcm,
    await readFile(trimControlAudio.path),
    "trim-only transcript PCM must exactly equal its ordinary decoded control",
  );
  const trimAudioRepeat = await renderReferenceAudioArtifact(
    trim,
    trim.compositions[0]!,
    trimFixture.root,
  );
  assert.equal(trimAudio.cache.status, "miss");
  assert.equal(trimAudioRepeat.cache.status, "hit");
  assert.equal(trimAudioRepeat.cache.key, trimAudio.cache.key);
  assert.deepEqual(await readFile(trimAudioRepeat.path), trimPcm);

  assert.deepEqual(
    ripple.timelineEdits?.[0]?.operations.map((operation) => operation.kind),
    ["ripple-delete"],
  );
  const rippleFrames = [];
  const rippleControlFrames = [];
  for (const index of [3, 5, 9, 13] as const) {
    rippleFrames.push(await frame(ripple, rippleFixture.root, index, `ripple-${index}`));
    rippleControlFrames.push(await frame(
      rippleControl,
      rippleControlFixture.root,
      index,
      `ripple-control-${index}`,
    ));
  }
  assert.deepEqual(
    rippleFrames.map((manifest) => manifest.artifact.rgbaSha256),
    rippleControlFrames.map((manifest) => manifest.artifact.rgbaSha256),
    "middle-ripple transcript pixels must exactly equal a control that moves source 3s..<4s to destination 2s..<3s",
  );
  assert.equal(rippleFrames[0]!.artifact.rgbaSha256, rippleFrames[3]!.artifact.rgbaSha256);
  assert.notEqual(rippleFrames[1]!.artifact.rgbaSha256, rippleFrames[0]!.artifact.rgbaSha256);
  assert.notEqual(
    rippleFrames[2]!.artifact.rgbaSha256,
    rippleFrames[1]!.artifact.rgbaSha256,
    "the shifted survivor must expose distinct source picture bytes",
  );
  const rippleRepeat = await frame(ripple, rippleFixture.root, 9, "ripple-9-repeat");
  assert.equal(rippleRepeat.artifact.rgbaSha256, rippleFrames[2]!.artifact.rgbaSha256);

  const rippleCaptionNode = Object.values(rippleCaptioned.nodes).find((node) =>
    node.op === "cut.visual.transcript_captions");
  assert.ok(rippleCaptionNode);
  const rippleCaptionConfig = referenceTranscriptCaptionConfig(
    rippleCaptionNode,
    rippleCaptioned,
    rippleCaptioned.compositions[0]!,
  );
  assert.deepEqual(rippleCaptionConfig?.track.cues.map((cue) => ({
    start: cue.start,
    end: cue.end,
    lines: cue.lines,
  })), [{
    start: { numerator: "1", denominator: "1" },
    end: { numerator: "2", denominator: "1" },
    lines: ["Canonical"],
  }, {
    start: { numerator: "2", denominator: "1" },
    end: { numerator: "3", denominator: "1" },
    lines: ["continues."],
  }]);
  for (const [index, baseFrame] of [[3, 0], [5, 1], [9, 2], [13, 3]] as const) {
    const rendered = await frame(
      rippleCaptioned,
      rippleCaptionFixture.root,
      index,
      `ripple-caption-${index}`,
    );
    if (index === 5 || index === 9) {
      assert.notEqual(rendered.artifact.rgbaSha256, rippleFrames[baseFrame]!.artifact.rgbaSha256);
    } else {
      assert.equal(rendered.artifact.rgbaSha256, rippleFrames[baseFrame]!.artifact.rgbaSha256);
    }
  }

  const rippleAudio = await renderReferenceAudioArtifact(
    ripple,
    ripple.compositions[0]!,
    rippleFixture.root,
  );
  const rippleControlAudio = await renderReferenceAudioArtifact(
    rippleControl,
    rippleControl.compositions[0]!,
    rippleControlFixture.root,
  );
  const ripplePcm = await readFile(rippleAudio.path);
  assert.deepEqual(
    ripplePcm,
    await readFile(rippleControlAudio.path),
    "middle-ripple PCM must exactly equal a control that moves source 3s..<4s to destination 2s..<3s",
  );
  assert.notDeepEqual(
    ripplePcm.subarray(sampleRate * frameBytes, 2 * sampleRate * frameBytes),
    ripplePcm.subarray(2 * sampleRate * frameBytes, 3 * sampleRate * frameBytes),
    "the retained first word and shifted third word must expose distinct source PCM",
  );
  assert.ok(ripplePcm.subarray(0, sampleRate * frameBytes).every((byte) => byte === 0));
  assert.ok(ripplePcm.subarray(3 * sampleRate * frameBytes).every((byte) => byte === 0));
  const rippleAudioRepeat = await renderReferenceAudioArtifact(
    ripple,
    ripple.compositions[0]!,
    rippleFixture.root,
  );
  assert.equal(rippleAudio.cache.status, "miss");
  assert.equal(rippleAudioRepeat.cache.status, "hit");
  assert.equal(rippleAudioRepeat.cache.key, rippleAudio.cache.key);
  assert.deepEqual(await readFile(rippleAudioRepeat.path), ripplePcm);

  const rippleMutation = await locked(
    rippleMutationFixture,
    rippleSource,
    base.transcript,
  );
  await writeFile(
    rippleMutationFixture.transcript,
    base.transcript.replace("continues.", "continues!"),
  );
  const hostileOutput = resolve(
    rippleMutationFixture.root,
    "review",
    "must-not-publish-middle-ripple.png",
  );
  await assert.rejects(
    renderReferenceFrameArtifact(
      rippleMutation,
      rippleMutationFixture.root,
      hostileOutput,
      { frame: 9, mediaProfile: "master" },
    ),
    /CUT_LOCK_INTEGRITY: Locked (?:master input (?:size|sha256|bytes)|resource bytes) changed/u,
  );
  await missing(hostileOutput);
  await missing(`${hostileOutput}.manifest.json`);
});
