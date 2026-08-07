import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseCutLanguage } from "../lib/language/parser";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { rational } from "../lib/language/rational";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { renderReferenceIr } from "./reference-render-test-helper";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const exec = promisify(execFile);

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

const overlapSource = (root = "media") => `cut 0.4;
project "linked overlap";
import { Clip } from "@cut/edit";
asset red: VideoAsset = video("${root}/red.mkv");
asset blue: VideoAsset = video("${root}/blue.mkv");
timeline main(duration: 1500ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene overlap(duration: 1500ms) {
    at 0s { Clip(source: red, range: 0s ..< 1s, duration: 1s, fadeOut: 500ms); }
    at 500ms { Clip(source: blue, range: 0s ..< 1s, duration: 1s, fadeIn: 500ms); }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;

function lockedWithoutFiles(source: string) {
  const ir = compile(source);
  const decodedVideoCadence = {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: "phase-floor",
    phaseNumerator: "0",
    streamIndex: 0,
    firstPts: "0",
    lastPts: "7",
    quantizedEndPts: "8",
    frameCount: "8",
    durationPresentCount: "8",
    durationCoverage: "complete",
    recordsSha256: "0".repeat(64),
    timeBase: rational(1, 4),
    frameRate: rational(4),
  } as const;
  const decodedAudioSamples = {
    format: "cut-decoded-audio-samples",
    version: 2,
    method: "ffprobe-show-frames-audio-v2",
    quantization: "phase-floor-start-or-exact-end",
    trimSemantics: "decoder-output-sequence-plus-terminal-duration",
    phaseNumerator: "0",
    streamIndex: 1,
    firstPts: "0",
    lastPts: "95999",
    frameCount: "2",
    decoderOutputSampleCount: "96000",
    decoderPcmSha256: "0".repeat(64),
    decodedSampleCount: "96000",
    terminalTrimSamples: "0",
    durationPresentCount: "2",
    durationCoverage: "complete",
    recordsSha256: "0".repeat(64),
    timeBase: rational(1, 48_000),
    sampleRate: 48_000,
    leadingDiscontinuityFrameCount: "0",
    leadingDiscontinuitySampleCount: "0",
  } as const;
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [
          { index: 0, type: "video", frameRate: rational(4), timeBase: rational(1, 4), start: rational(0), duration: rational(2), width: 64, height: 64 },
          { index: 1, type: "audio", sampleRate: 48_000, channels: 2, timeBase: rational(1, 48_000), start: rational(0), duration: rational(2) },
        ] },
        selected: {
          video: {
            streamIndex: 0,
            duration: rational(2),
            durationSource: "decoded-video-cadence",
            timeBase: rational(1, 4),
            frameRate: rational(4),
            decodedVideoCadence,
          },
          audio: {
            streamIndex: 1,
            duration: rational(2),
            durationSource: "decoded-audio-samples",
            timeBase: rational(1, 48_000),
            decodedAudioSamples,
          },
        },
      },
    } as never;
  }
  ir.determinism.semantic = "locked";
  return ir;
}

function linkedClips(ir: CutAVIR) { return Object.values(ir.nodes).filter((node) => node.op === "cut.edit.clip"); }

function pcm24Data(buffer: Buffer<ArrayBufferLike>) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF"); assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + size % 2;
  }
  assert.equal(channels, 2); assert.equal(sampleRate, 48_000); assert.equal(blockAlign, 6); assert.equal(bits, 24);
  const sample = (frame: number, channel: number) => {
    const position = frame * blockAlign + channel * 3; let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000; return value / 0x800000;
  };
  return { frames: data.length / blockAlign, sample };
}

test("Clip duration lowers to an exact destination interval while omission preserves owner duration", () => {
  const ir = compile(overlapSource()), clips = linkedClips(ir);
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map((node) => node.interval), [
    { start: { numerator: "0", denominator: "1" }, duration: { numerator: "1", denominator: "1" } },
    { start: { numerator: "1", denominator: "2" }, duration: { numerator: "1", denominator: "1" } },
  ]);
  assert.deepEqual(clips.map((node) => node.inputs.duration), [
    { kind: "quantity", dimension: "time", magnitude: { numerator: "1", denominator: "1" }, unit: "s" },
    { kind: "quantity", dimension: "time", magnitude: { numerator: "1", denominator: "1" }, unit: "s" },
  ]);

  const omitted = compile('cut 0.4; project "owner"; import { Clip } from "@cut/edit"; asset source: VideoAsset = video("media/source.mkv"); timeline main(duration: 2s, fps: 4, sampleRate: 48khz) { scene only(duration: 2s) { at 500ms { Clip(source: source); } } } export out = render(main);');
  const node = linkedClips(omitted)[0];
  assert.deepEqual(node.interval, { start: { numerator: "1", denominator: "2" }, duration: { numerator: "3", denominator: "2" } });
  assert.equal(node.inputs.duration, undefined);
});

test("Clip compiler rejects invalid destination, fade, source-range, and timebase bounds at the source", () => {
  const program = (body: string, header = "timeline main(duration: 1500ms, fps: 4, sampleRate: 48khz)") => `cut 0.4; project "bad clip"; import { Clip } from "@cut/edit"; asset source: VideoAsset = video("media/source.mkv"); ${header} { scene only(duration: 1500ms) { ${body} } } export out = render(main);`;
  assert.throws(() => compile(program("Clip(source: source, duration: 0s);")), /project\.cut:1:\d+: Clip duration must be positive/);
  assert.throws(() => compile(program("at 1s { Clip(source: source, duration: 1s); }")), /destination interval lies outside its owning scene/);
  assert.throws(() => compile(program("Clip(source: source, range: 0s ..< 500ms, duration: 1s);")), /source range is shorter than the explicit destination duration/);
  assert.throws(() => compile(program("Clip(source: source, duration: 1s, fadeIn: 750ms, fadeOut: 500ms);")), /Clip fadeIn \+ fadeOut cannot exceed its media duration/);
  assert.throws(() => compile(program("Clip(source: source, duration: 1s, fadeIn: 100ms);")), /fadeIn does not land on the 4\/1 fps frame boundary/);
  assert.throws(() => compile('cut 0.4; project "bad sample"; import { Clip } from "@cut/edit"; asset source: VideoAsset = video("media/source.mkv"); timeline main(duration: 2f, fps: 24, sampleRate: 44.1khz) { scene only(duration: 2f) { at 1f { Clip(source: source, duration: 1f); } } } export out = render(main);'), /does not land on the 44100 Hz sample boundary/);
});

test("loaded IR cannot bypass linked Clip interval and fade validation", () => {
  const fresh = () => lockedWithoutFiles(overlapSource()), first = (ir: CutAVIR) => linkedClips(ir)[0];
  const zero = fresh(); first(zero).interval.duration = { numerator: "0", denominator: "1" };
  assert.throws(() => validateReferenceSession(zero), /destination interval.*must be positive/);

  const outside = fresh(); first(outside).interval.start = { numerator: "1", denominator: "1" };
  assert.throws(() => validateReferenceSession(outside), /destination interval.*remain inside/);

  const mismatch = fresh(); first(mismatch).interval.duration = { numerator: "3", denominator: "4" };
  assert.throws(() => validateReferenceSession(mismatch), /was not lowered exactly/);

  const offFrame = fresh(); first(offFrame).inputs.fadeOut = { kind: "quantity", dimension: "time", magnitude: { numerator: "1", denominator: "10" }, unit: "s" };
  assert.throws(() => validateReferenceSession(offFrame), /fadeOut.*does not land on the 4\/1 fps frame boundary/);

  const excessive = fresh(); first(excessive).inputs.fadeIn = { kind: "quantity", dimension: "time", magnitude: { numerator: "3", denominator: "4" }, unit: "s" };
  assert.throws(() => validateReferenceSession(excessive), /fadeIn \+ fadeOut.*cannot exceed/);
});

test("JCut and LCut refuse the former childless convenience shape instead of masquerading as coupled edits", () => {
  for (const [name, argument] of [["JCut", "overlap: 500ms"], ["LCut", "overlap: 500ms"]] as const) {
    const parsed = parseCutLanguage(`cut 0.4; project "refused"; import { ${name} } from "@cut/edit"; timeline main(duration: 1s, fps: 4) { scene only(duration: 1s) { ${name}(${argument}); } } export out = render(main);`);
    assert.ok(parsed.module); assert.deepEqual(parsed.diagnostics, []);
    assert.throws(() => compileCutModule(parsed.module!), (error) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === "CUT2094" && item.message.includes("exactly two source-ordered Clip children")));
  }
});

test("overlapping linked Clips render picture and source-audio edge fades from the same program", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-overlap-")), media = resolve(root, "media"); await mkdir(media);
  const generate = (name: string, color: string) => exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=64x64:r=4:d=1`, "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=1", "-shortest", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le", resolve(media, `${name}.mkv`)]);
  await Promise.all([generate("red", "red"), generate("blue", "blue")]);
  const ir = compile(overlapSource()), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root); validateReferenceSession(ir);

  const rawAudio = resolve(root, "overlap.wav"); await renderReferenceAudio(ir, ir.compositions[0], root, rawAudio);
  const pcm = pcm24Data(await readFile(rawAudio)); assert.equal(pcm.frames, 72_000);
  const peakAt = (frame: number) => Math.abs(pcm.sample(frame + 12, 0));
  const before = peakAt(12_000), middle = peakAt(36_000), after = peakAt(60_000);
  assert.ok(before > .05 && after > .05, `${before}, ${after}`);
  assert.ok(Math.abs(middle / before - 1) < .03, `linear linked fades should sum without an audio dip: ${before} -> ${middle}`);
  assert.ok(Math.abs(after / before - 1) < .03, `incoming linked source changed level: ${before} -> ${after}`);

  const output = resolve(root, "overlap.mp4"); await renderReferenceIr(ir, root, output, "out");
  const decoded = resolve(root, "decoded.rgb"); await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", decoded]);
  const frames = await readFile(decoded), frameBytes = 64 * 64 * 3; assert.equal(frames.length, frameBytes * 6);
  const pixel = (frame: number) => { const offset = frame * frameBytes + (32 * 64 + 32) * 3; return [frames[offset], frames[offset + 1], frames[offset + 2]]; };
  const red = pixel(0), dissolve = pixel(3), blue = pixel(4);
  assert.ok(red[0] > 180 && red[2] < 40, JSON.stringify(red)); assert.ok(blue[2] > 180 && blue[0] < 40, JSON.stringify(blue));
  assert.ok(dissolve[0] > 35 && dissolve[2] > 70 && dissolve[0] < red[0] && dissolve[2] < blue[2], JSON.stringify(dissolve));
});
