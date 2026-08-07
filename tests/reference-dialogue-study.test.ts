import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { referenceMasterAudioRootIds, renderReferenceAudioSelection } from "../lib/runtime/reference/audio";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
  renderReferenceAudioArtifact,
} from "../lib/runtime/reference/audio-cache";
import { renderReferenceIr, testRenderLockSha256 } from "./reference-render-test-helper";
import { planReferenceAudioStems } from "../lib/runtime/reference/stems";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);
const projectDurationSeconds = 15;
const sampleRate = 48_000;
const frameRate = 25;
const expectedSamples = projectDurationSeconds * sampleRate;
const expectedFrames = projectDurationSeconds * frameRate;
const silenceStartSample = 14_200 * sampleRate / 1_000;

const rawAnswerA = "AudioClip(source: dialoguePcm, range: 0ms ..< 5800ms);";
const rawAnswerB = "AudioClip(source: dialoguePcm, range: 5800ms ..< 11s);";
const processedAnswerA = `Compressor(threshold: -20db, ratio: 2.5, attack: 12ms, release: 160ms, makeup: 1db) {
              ParametricEQ(frequency: 240hz, gain: -2db, q: 1.1) {
                DeEsser(intensity: 0.35, amount: 0.5) {
                  HighPass(frequency: 75hz) {
                    ${rawAnswerA}
                  }
                }
              }
            }`;
const processedAnswerB = `Compressor(threshold: -20db, ratio: 2.5, attack: 12ms, release: 160ms, makeup: 1db) {
              ParametricEQ(frequency: 240hz, gain: -2db, q: 1.1) {
                DeEsser(intensity: 0.35, amount: 0.5) {
                  HighPass(frequency: 75hz) {
                    ${rawAnswerB}
                  }
                }
              }
            }`;

function studySource(captionColor = "#ffffff", duckAmount = "-18db", answerA = processedAnswerA, answerB = processedAnswerB) {
  return `cut 0.4;
project "The Sound of an Empty Room";
import { Captions } from "cut:visual";
import { Sequence, PictureTrack, PictureClip, AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
import { AudioClip, Bus, Compressor, DeEsser, HighPass, Meter, ParametricEQ, Sidechain } from "@cut/audio";

asset establish: VideoAsset = video("media/establish.mkv");
asset interview: VideoAsset = video("media/interview.mkv");
asset details: VideoAsset = video("media/details.mkv");
asset closing: VideoAsset = video("media/closing.mkv");
asset dialoguePcm: AudioAsset = audio("audio/dialogue.wav");
asset scorePcm: AudioAsset = audio("audio/score.wav");
asset roomTonePcm: AudioAsset = audio("audio/room-tone.wav");
asset transitionPcm: AudioAsset = audio("audio/transition.wav");
asset subtitles: DataAsset = data("captions/dialogue.vtt");
asset geist: FontAsset = font("fonts/Geist-Regular.ttf");

timeline main(duration: 15s, fps: 25, width: 320px, height: 180px, sampleRate: 48khz) {
  scene room(duration: 15s) {
    Sequence(duration: 15s) {
      PictureTrack() {
        PictureClip(source: establish, range: 0s ..< 2s, duration: 2s);
        PictureClip(source: interview, range: 800ms ..< 4s, duration: 3200ms, link: "answer-a");
        PictureClip(source: details, range: 0s ..< 2800ms, duration: 2800ms);
        PictureClip(source: interview, range: 6400ms ..< 10s, duration: 3600ms, link: "answer-b");
        PictureClip(source: closing, range: 0s ..< 3400ms, duration: 3400ms);
      }
    }

    Captions(source: subtitles, font: geist, format: "webvtt", size: 22px, color: ${captionColor}, background: #07090cdd, safeX: 6%, safeY: 7%, maxWidth: 86%, padding: 8px, radius: 5px, lineHeight: 112%);

    Meter(target: -16lufs, truePeak: -1dbtp, samplePeak: -1dbfs, range: 9) {
      Bus(name: "dialogue", role: "dialogue") as dialogue {
        AudioTrack() {
          AudioGap(destination: 0s ..< 1200ms);
          AudioRegion(destination: 1200ms ..< 7s, link: "answer-a") {
            ${answerA}
          }
          AudioGap(destination: 7s ..< 7400ms);
          AudioRegion(destination: 7400ms ..< 12600ms, link: "answer-b") {
            ${answerB}
          }
          AudioGap(destination: 12600ms ..< 15s);
        }
      }

      Bus(name: "music", role: "music") {
        Sidechain(source: dialogue, amount: ${duckAmount}, threshold: -42db, attack: 10ms, release: 120ms) {
          AudioTrack() {
            AudioRegion(destination: 0s ..< 14200ms) {
              AudioClip(source: scorePcm, range: 0s ..< 14200ms);
            }
            AudioGap(destination: 14200ms ..< 15s);
          }
        }
      }

      Bus(name: "ambience", role: "ambience") {
        AudioTrack() {
          AudioRegion(destination: 0s ..< 14200ms) {
            AudioClip(source: roomTonePcm, range: 0s ..< 14200ms);
          }
          AudioGap(destination: 14200ms ..< 15s);
        }
      }

      Bus(name: "sfx", role: "sfx") {
        AudioTrack() {
          AudioGap(destination: 0s ..< 5150ms);
          AudioRegion(destination: 5150ms ..< 5400ms) {
            AudioClip(source: transitionPcm, range: 0ms ..< 250ms);
          }
          AudioGap(destination: 5400ms ..< 15s);
        }
      }
    }
  }
}

export out = render(main, width: 320px, height: 180px, codec: "h264");`;
}

function compile(source = studySource()) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics, []);
  const result = compileCutModule(parsed.module);
  assert.deepEqual(result.check.diagnostics, []);
  return result.ir;
}

function byOp(ir: CutAVIR, op: string) {
  return Object.values(ir.nodes).filter((node) => node.op === op);
}

function editorialTrack(node: IRNode, kind: "picture-track" | "audio-track") {
  assert.equal(node.editorial?.kind, kind);
  return node.editorial as Extract<IREditorial, { kind: typeof kind }>;
}

function linkedItemMap(ir: CutAVIR) {
  type PictureItem = Extract<IREditorial, { kind: "picture-track" }>["items"][number];
  type AudioItem = Extract<IREditorial, { kind: "audio-track" }>["items"][number];
  const result = new Map<string, { picture?: PictureItem; audio?: AudioItem }>();
  for (const node of Object.values(ir.nodes)) {
    if (node.editorial?.kind !== "picture-track" && node.editorial?.kind !== "audio-track") continue;
    for (const item of node.editorial.items) {
      if (!item.linkId) continue;
      const pair = result.get(item.linkId) ?? {};
      if (node.editorial.kind === "picture-track" && item.kind === "picture") pair.picture = item;
      if (node.editorial.kind === "audio-track" && item.kind === "audio") pair.audio = item;
      result.set(item.linkId, pair);
    }
  }
  return result;
}

function pcm16MonoFixture(frames: number, sampleAt: (frame: number) => number) {
  const bytes = frames * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + bytes, 4);
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
  buffer.writeUInt32LE(bytes, 40);
  for (let frame = 0; frame < frames; frame += 1) buffer.writeInt16LE(sampleAt(frame), 44 + frame * 2);
  return buffer;
}

function pcm24Wave(buffer: Buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let cursor = 12;
  let channels = 0;
  let rate = 0;
  let blockAlign = 0;
  let bits = 0;
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString("ascii", cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    const body = cursor + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2);
      rate = buffer.readUInt32LE(body + 4);
      blockAlign = buffer.readUInt16LE(body + 12);
      bits = buffer.readUInt16LE(body + 14);
    }
    if (id === "data") {
      data = buffer.subarray(body, body + size);
      break;
    }
    cursor = body + size + size % 2;
  }
  assert.deepEqual({ channels, rate, blockAlign, bits }, { channels: 2, rate: sampleRate, blockAlign: 6, bits: 24 });
  return {
    frames: data.length / blockAlign,
    sample(frame: number, channel = 0) {
      const position = frame * blockAlign + channel * 3;
      let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

function rawF32(buffer: Buffer) {
  assert.equal(buffer.length % 8, 0);
  return {
    frames: buffer.length / 8,
    sample(frame: number, channel = 0) { return buffer.readFloatLE(frame * 8 + channel * 4); },
  };
}

function rms(pcm: ReturnType<typeof pcm24Wave>, start: number, end: number) {
  let sum = 0;
  let count = 0;
  for (let frame = start; frame < end; frame += 1) {
    for (const channel of [0, 1]) {
      const value = pcm.sample(frame, channel);
      sum += value * value;
      count += 1;
    }
  }
  return Math.sqrt(sum / count);
}

function peak(
  pcm: { sample(frame: number, channel?: number): number },
  start: number,
  end: number,
) {
  let maximum = 0;
  for (let frame = start; frame < end; frame += 1) {
    maximum = Math.max(maximum, Math.abs(pcm.sample(frame, 0)), Math.abs(pcm.sample(frame, 1)));
  }
  return maximum;
}

async function createFixtures(root: string) {
  const media = resolve(root, "media");
  const audio = resolve(root, "audio");
  const captions = resolve(root, "captions");
  const fonts = resolve(root, "fonts");
  await Promise.all([mkdir(media), mkdir(audio), mkdir(captions), mkdir(fonts)]);
  const colors = [
    ["establish", "0x9d3b38"],
    ["interview", "0x3c7f58"],
    ["details", "0x365d93"],
    ["closing", "0x805393"],
  ] as const;
  await Promise.all(colors.map(([name, color]) => exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=25:d=11`,
    "-frames:v", String(11 * frameRate), "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrp",
    resolve(media, `${name}.mkv`),
  ])));
  const audioFrames = 14_200 * sampleRate / 1_000;
  await Promise.all([
    writeFile(resolve(audio, "dialogue.wav"), pcm16MonoFixture(audioFrames, (frame) => Math.floor(frame / 24) % 2 === 0 ? 2_000 : -2_000)),
    writeFile(resolve(audio, "score.wav"), pcm16MonoFixture(audioFrames, (frame) => Math.round(Math.sin(2 * Math.PI * 220 * frame / sampleRate) * 3_000))),
    writeFile(resolve(audio, "room-tone.wav"), pcm16MonoFixture(audioFrames, (frame) => Math.floor(frame / 48) % 2 === 0 ? 180 : -180)),
    writeFile(resolve(audio, "transition.wav"), pcm16MonoFixture(250 * sampleRate / 1_000, (frame) => Math.round((1 - frame / 12_000) * (Math.floor(frame / 8) % 2 === 0 ? 3_000 : -3_000)))),
    writeFile(resolve(captions, "dialogue.vtt"), `WEBVTT

take-a
00:00:01.200 --> 00:00:07.000
A room is never actually silent.

take-b
00:00:07.400 --> 00:00:12.600
Take that bed away, and every picture cut sounds like a jump.
`),
    copyFile(resolve("examples/fixtures/Geist-Regular.ttf"), resolve(fonts, "Geist-Regular.ttf")),
  ]);
}

test("the dialogue study lowers one public timeline with independent linked J/L boundaries and explicit OTIO loss", () => {
  const ir = compile();
  assert.equal(ir.compositions[0].duration.numerator, "15");
  assert.equal(ir.compositions[0].fps.numerator, "25");
  assert.equal(ir.compositions[0].sampleRate, sampleRate);

  const pictureTracks = byOp(ir, "cut.edit.picture_track");
  assert.equal(pictureTracks.length, 1);
  const picture = editorialTrack(pictureTracks[0], "picture-track");
  assert.deepEqual(picture.items.map((item) => [item.linkId, item.destination]), [
    [undefined, { start: rational(0), duration: rational(2) }],
    ["answer-a", { start: rational(2), duration: rational(16, 5) }],
    [undefined, { start: rational(26, 5), duration: rational(14, 5) }],
    ["answer-b", { start: rational(8), duration: rational(18, 5) }],
    [undefined, { start: rational(58, 5), duration: rational(17, 5) }],
  ]);

  const links = linkedItemMap(ir);
  assert.deepEqual([...links.keys()].sort(), ["answer-a", "answer-b"]);
  assert.deepEqual(links.get("answer-a")?.picture?.destination, { start: rational(2), duration: rational(16, 5) });
  assert.deepEqual(links.get("answer-a")?.audio?.destination, { start: rational(6, 5), duration: rational(29, 5) });
  assert.deepEqual(links.get("answer-b")?.picture?.destination, { start: rational(8), duration: rational(18, 5) });
  assert.deepEqual(links.get("answer-b")?.audio?.destination, { start: rational(37, 5), duration: rational(26, 5) });
  assert.deepEqual(links.get("answer-a")!.audio!.destination.start, rational(6, 5), "answer A dialogue leads its picture by 800 ms (J-cut)");
  assert.deepEqual(links.get("answer-a")!.audio!.destination.duration, rational(29, 5), "answer A dialogue runs 1.8 seconds beyond its picture (L-cut)");
  assert.deepEqual(links.get("answer-b")!.audio!.destination.start, rational(37, 5), "answer B dialogue leads its picture by 600 ms (J-cut)");
  assert.deepEqual(links.get("answer-b")!.audio!.destination.duration, rational(26, 5), "answer B dialogue runs one second beyond its picture (L-cut)");
  assert.equal(byOp(ir, "cut.visual.captions").length, 1);
  assert.equal(byOp(ir, "cut.audio.sidechain").length, 1);
  assert.equal(byOp(ir, "cut.audio.highpass").length, 2);
  assert.equal(byOp(ir, "cut.audio.deesser").length, 2);
  assert.equal(byOp(ir, "cut.audio.eq").length, 2);
  assert.equal(byOp(ir, "cut.audio.compressor").length, 2);

  const exported = exportCutTimelineToOtio(ir);
  assert.equal(exported.report.status, "lossy-editorial");
  const regionLoss = exported.report.unsupportedSemantics.filter((issue) => issue.code === "CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED");
  assert.equal(regionLoss.length, 5);
  assert.ok(regionLoss.every((issue) => issue.disposition === "flattened" && issue.subject.property === "processing-link-automation"));
  assert.ok(exported.report.unsupportedSemantics.some((issue) => issue.subject.op === "cut.audio.sidechain"), "OTIO must report rather than hide dialogue-keyed music semantics");
});

test("the synthetic 15-second study executes captions, J/L audio, dynamic ducking, stems, silence, delivery, and localized cache identity", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-dialogue-study-"));
  try {
    await createFixtures(root);
    const ir = compile();
    const lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir, "out");

    const stemPlan = planReferenceAudioStems(ir, composition);
    assert.equal(stemPlan.version, 3);
    assert.equal(stemPlan.totalSamples, expectedSamples);
    assert.deepEqual(stemPlan.routes.map(({ name, role, kind }) => ({ name, role, kind })), [
      { name: "dialogue", role: "dialogue", kind: "program" },
      { name: "music", role: "music", kind: "program" },
      { name: "ambience", role: "ambience", kind: "program" },
      { name: "sfx", role: "sfx", kind: "program" },
    ]);
    assert.deepEqual(stemPlan.routes.find((route) => route.name === "dialogue")?.sidechainInputs, []);
    const musicControl = stemPlan.routes.find((route) => route.name === "music")?.sidechainInputs;
    assert.equal(musicControl?.length, 1);
    assert.equal(musicControl?.[0].sourceStem, "dialogue");
    assert.equal(musicControl?.[0].sidechainNodeId, byOp(ir, "cut.audio.sidechain")[0].id);
    assert.equal(musicControl?.[0].keyNodeId, byOp(ir, "cut.audio.bus").find((node) => node.inputs.name?.kind === "string" && node.inputs.name.value === "dialogue")?.id);
    assert.match(musicControl?.[0].sidechainGraphHash ?? "", /^[a-f0-9]{64}$/u);
    assert.match(musicControl?.[0].keyGraphHash ?? "", /^[a-f0-9]{64}$/u);

    const visual = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "visual-preflight-cache"));
    await visual.prepare();
    try {
      const scene = ir.scenes[composition.sceneIds[0]];
      const at = async (frame: number) => visual.sceneFrame(scene, frame);
      const center = (surface: Awaited<ReturnType<typeof at>>) => {
        const offset = (90 * surface.width + 160) * 4;
        return [...surface.data.subarray(offset, offset + 3)];
      };
      const sampledFrames = [29, 30, 49, 50, 129, 130, 174, 175, 184, 185, 199, 200, 289, 290, 314, 315, 374];
      const frames: Awaited<ReturnType<typeof at>>[] = [];
      for (const sampledFrame of sampledFrames) frames.push(await at(sampledFrame));
      const frame = (number: number) => frames[sampledFrames.indexOf(number)];
      for (const [before, after] of [[29, 30], [174, 175], [184, 185], [314, 315]] as const) {
        assert.notDeepEqual(frame(before).data, frame(after).data, `locked WebVTT/Geist pixels must switch exactly between frames ${before} and ${after}`);
      }
      assert.ok(center(frame(49))[0] > center(frame(49))[1], JSON.stringify(center(frame(49))));
      assert.ok(center(frame(50))[1] > center(frame(50))[0] && center(frame(50))[1] > center(frame(50))[2], JSON.stringify(center(frame(50))));
      assert.ok(center(frame(129))[1] > center(frame(129))[0] && center(frame(129))[1] > center(frame(129))[2], JSON.stringify(center(frame(129))));
      assert.ok(center(frame(130))[2] > center(frame(130))[0], JSON.stringify(center(frame(130))));
      assert.ok(center(frame(199))[2] > center(frame(199))[0], JSON.stringify(center(frame(199))));
      assert.ok(center(frame(200))[1] > center(frame(200))[0] && center(frame(200))[1] > center(frame(200))[2], JSON.stringify(center(frame(200))));
      assert.ok(center(frame(289))[1] > center(frame(289))[0] && center(frame(289))[1] > center(frame(289))[2], JSON.stringify(center(frame(289))));
      assert.ok(center(frame(290))[0] > center(frame(290))[1] && center(frame(290))[2] > center(frame(290))[1], JSON.stringify(center(frame(290))));
      assert.ok(center(frame(374))[0] > center(frame(374))[1] && center(frame(374))[2] > center(frame(374))[1], "the delivery ends on authored closing picture rather than a dead frame");
    } finally {
      visual.close();
    }

    const output = resolve(root, "empty-room.mp4");
    const stems = resolve(root, "stems");
    const manifest = await renderReferenceIr(ir, root, output, "out", { stemsDirectory: stems });
    assert.equal(manifest.duration, projectDurationSeconds);
    assert.deepEqual(manifest.canvas, { width: 320, height: 180, fps: "25/1" });
    assert.equal(manifest.audio.sampleRate, sampleRate);
    assert.equal(manifest.audio.samplePeak.observedFrames, expectedSamples);
    assert.equal(manifest.cache.audio.artifact.samples, expectedSamples);
    assert.equal(manifest.audio.delivery.normalizedPcm.framing.expectedFrames, expectedSamples);
    assert.equal(manifest.audio.delivery.passes.at(-1)?.cutTruePeak.observedFrames, expectedSamples);
    assert.equal(manifest.audio.delivery.truePeakCompliant, true);
    assert.equal(manifest.stems?.count, 4);

    const probe = JSON.parse((await exec("ffprobe", [
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,avg_frame_rate,nb_read_frames",
      "-of", "json", output,
    ])).stdout) as { streams: Array<Record<string, string | number>> };
    assert.deepEqual(probe.streams, [{ codec_name: "h264", width: 320, height: 180, avg_frame_rate: "25/1", nb_read_frames: String(expectedFrames) }]);

    const writtenStemManifest = JSON.parse(await readFile(resolve(stems, "cut-stems.json"), "utf8")) as {
      format: string;
      version: number;
      runtime: string;
      lock: { sha256: string };
      buildId: string;
      composition: { id: string; samples: number; sampleRate: number; channels: number; sampleFormat: string };
      relationship: { stage: string; mix: string; normalization: string; peakValidation: string; quantization: string };
      stems: Array<{ name: string; samples: number; sidechainInputs: unknown[]; peak: { observedFrames: number } }>;
    };
    assert.equal(writtenStemManifest.format, "cut-reference-stems");
    assert.equal(writtenStemManifest.version, 5);
    assert.equal(writtenStemManifest.runtime, "cut-reference/0.4.0-alpha.2");
    assert.deepEqual(writtenStemManifest.lock, { sha256: testRenderLockSha256 });
    assert.equal(writtenStemManifest.buildId, manifest.executionBuildId, "stem identity must bind the verified-input execution graph used for delivery");
    assert.equal(manifest.buildId, ir.buildId, "the render manifest must preserve the canonical pre-snapshot graph identity separately");
    assert.deepEqual({
      id: writtenStemManifest.composition.id,
      samples: writtenStemManifest.composition.samples,
      sampleRate: writtenStemManifest.composition.sampleRate,
      channels: writtenStemManifest.composition.channels,
      sampleFormat: writtenStemManifest.composition.sampleFormat,
    }, { id: composition.id, samples: expectedSamples, sampleRate, channels: 2, sampleFormat: "s24le" });
    assert.deepEqual(writtenStemManifest.relationship, {
      stage: "pre-master",
      mix: "decoded-sum-with-s24-rounding",
      normalization: "none",
      peakValidation: "exact-f32le-before-quantization",
      quantization: "nearest-ties-to-even",
    });
    assert.deepEqual(writtenStemManifest.stems.map((stem) => [stem.name, stem.samples]), [
      ["dialogue", expectedSamples], ["music", expectedSamples], ["ambience", expectedSamples], ["sfx", expectedSamples],
    ]);
    assert.ok(writtenStemManifest.stems.every((stem) => stem.peak.observedFrames === expectedSamples));
    assert.equal(writtenStemManifest.stems.find((stem) => stem.name === "music")?.sidechainInputs.length, 1);

    const dialogue = pcm24Wave(await readFile(resolve(stems, "dialogue.wav")));
    const music = pcm24Wave(await readFile(resolve(stems, "music.wav")));
    const ambience = pcm24Wave(await readFile(resolve(stems, "ambience.wav")));
    const sfx = pcm24Wave(await readFile(resolve(stems, "sfx.wav")));
    for (const stem of [dialogue, music, ambience, sfx]) assert.equal(stem.frames, expectedSamples);

    const controlIr = compile(studySource("#ffffff", "-18db", rawAnswerA, rawAnswerB));
    const controlLock = await createCutLock(controlIr, root);
    await applyCutLock(controlIr, controlLock, root);
    const processedDialogueBus = byOp(ir, "cut.audio.bus").find((node) => node.inputs.name?.kind === "string" && node.inputs.name.value === "dialogue");
    const controlDialogueBus = byOp(controlIr, "cut.audio.bus").find((node) => node.inputs.name?.kind === "string" && node.inputs.name.value === "dialogue");
    assert.ok(processedDialogueBus && controlDialogueBus);
    const comparisonRange = { start: 1_500 * sampleRate / 1_000, end: 1_700 * sampleRate / 1_000 };
    const processedDialoguePath = resolve(root, "processed-dialogue-comparison.f32");
    const controlDialoguePath = resolve(root, "control-dialogue-comparison.f32");
    await renderReferenceAudioSelection(ir, ir.compositions[0], root, processedDialoguePath, [processedDialogueBus.id], { outputFormat: "raw-stereo-f32le", sampleRange: comparisonRange });
    await renderReferenceAudioSelection(controlIr, controlIr.compositions[0], root, controlDialoguePath, [controlDialogueBus.id], { outputFormat: "raw-stereo-f32le", sampleRange: comparisonRange });
    const processedDialogue = await readFile(processedDialoguePath), controlDialogue = await readFile(controlDialoguePath);
    assert.equal(processedDialogue.byteLength, (comparisonRange.end - comparisonRange.start) * 8);
    assert.equal(controlDialogue.byteLength, processedDialogue.byteLength);
    assert.notDeepEqual(processedDialogue, controlDialogue, "the source-specific HighPass → DeEsser → ParametricEQ → Compressor chain must change decoded dialogue samples");
    assert.ok(peak(rawF32(processedDialogue), 0, comparisonRange.end - comparisonRange.start) > 0);
    assert.ok(peak(rawF32(controlDialogue), 0, comparisonRange.end - comparisonRange.start) > 0);

    assert.equal(dialogue.sample(1_200 * sampleRate / 1_000 - 1), 0);
    assert.notEqual(dialogue.sample(1_200 * sampleRate / 1_000), 0);
    assert.notEqual(dialogue.sample(7_000 * sampleRate / 1_000 - 1), 0);
    assert.equal(dialogue.sample(7_000 * sampleRate / 1_000), 0);
    assert.equal(dialogue.sample(7_400 * sampleRate / 1_000 - 1), 0);
    assert.notEqual(dialogue.sample(7_400 * sampleRate / 1_000), 0);
    assert.notEqual(dialogue.sample(12_600 * sampleRate / 1_000 - 1), 0);
    assert.equal(dialogue.sample(12_600 * sampleRate / 1_000), 0);
    assert.notEqual(ambience.sample(0), 0);
    assert.notEqual(ambience.sample(silenceStartSample - 1), 0, "room tone must remain continuous through its authored end");
    for (const boundaryMs of [2_000, 5_200, 8_000, 11_600]) {
      const boundary = boundaryMs * sampleRate / 1_000;
      assert.notEqual(ambience.sample(boundary - 1), 0, `room tone dropped before the ${boundaryMs} ms picture cut`);
      assert.notEqual(ambience.sample(boundary), 0, `room tone dropped on the ${boundaryMs} ms picture cut`);
    }
    assert.equal(sfx.sample(5_150 * sampleRate / 1_000 - 1), 0);
    assert.notEqual(sfx.sample(5_150 * sampleRate / 1_000), 0);
    assert.equal(sfx.sample(5_400 * sampleRate / 1_000), 0);
    const keyedMusic = rms(music, 2 * sampleRate, 3 * sampleRate);
    const releasedMusic = rms(music, 7_220 * sampleRate / 1_000, 7_380 * sampleRate / 1_000);
    assert.ok(keyedMusic < releasedMusic * 0.6, `music must duck from decoded dialogue, then dynamically release into the authored breath (${keyedMusic} keyed versus ${releasedMusic} released)`);
    for (const stem of [dialogue, music, ambience, sfx]) {
      assert.equal(peak(stem, silenceStartSample, expectedSamples), 0, "stem leaked into the complete authored 14.2–15.0 second silence");
    }

    const mixPath = resolve(root, manifest.cache.audio.artifact.locator);
    const mix = rawF32(await readFile(mixPath));
    assert.equal(mix.frames, expectedSamples);
    assert.equal(peak(mix, silenceStartSample, expectedSamples), 0, "master leaked into the complete authored 14.2–15.0 second silence");

    const visualIr = compile(studySource("#ffe7a8"));
    const visualLock = await createCutLock(visualIr, root);
    await applyCutLock(visualIr, visualLock, root);
    const duckIr = compile(studySource("#ffffff", "-24db"));
    const duckLock = await createCutLock(duckIr, root);
    await applyCutLock(duckIr, duckLock, root);
    const previous = createIncrementalRenderPlan(ir, "main").manifest;
    const picturePlan = createIncrementalRenderPlan(visualIr, "main", previous);
    const duckPlan = createIncrementalRenderPlan(duckIr, "main", previous);
    assert.ok(picturePlan.scenes.every((scene) => scene.status === "miss"), "caption pixels must invalidate picture scenes");
    assert.ok(duckPlan.scenes.every((scene) => scene.status === "hit"), "ducking edits must not invalidate picture scenes");

    const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-dialogue-study");
    const audioPlan = (candidate: CutAVIR) => createReferenceAudioCachePlan(candidate, candidate.compositions[0], referenceMasterAudioRootIds(candidate, candidate.compositions[0]), toolchain);
    assert.equal(audioPlan(visualIr).key, audioPlan(ir).key, "caption-only edits must not invalidate pre-master audio");
    assert.notEqual(audioPlan(duckIr).key, audioPlan(ir).key, "dialogue-keyed ducking controls must invalidate pre-master audio");
    const baselineAudio = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
    const pictureAudio = await renderReferenceAudioArtifact(visualIr, visualIr.compositions[0], root);
    assert.equal(pictureAudio.cache.status, "hit", "the executed audio cache must remain warm across a visual-only revision");
    assert.equal(pictureAudio.cache.key, baselineAudio.cache.key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
