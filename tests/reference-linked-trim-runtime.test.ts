import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { validateReferenceAudioTrackOperationPlan } from "../lib/runtime/reference/audio-edit-operations";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import {
  ReferenceLinkedTrimError,
  validateReferenceLinkedTrimTransactions,
} from "../lib/runtime/reference/linked-trim";
import { validateReferencePictureTrackOperationPlan } from "../lib/runtime/reference/picture-edit-operations";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

type PictureTrack = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrack = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };

const source = `cut 0.4;
project "linked trim runtime proof";
import { LinkedTrim, Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("source.mkv");
asset voice: AudioAsset = audio("source.wav");
timeline main(duration: 4s, fps: 4, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    LinkedTrim(link: "take-a", keep: 1s ..< 3s);
    Sequence(duration: 4s) {
      PictureTrack() {
        PictureClip(source: picture, range: 0s ..< 4s, duration: 4s, link: "take-a");
      }
    }
    AudioTrack() {
      AudioClip(source: voice, range: 0s ..< 4s, destination: 0s ..< 4s, link: "take-a");
    }
  }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;

function compile() {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function tracks(ir: CutAVIR) {
  const picture = Object.values(ir.nodes).find((node): node is PictureTrack => node.editorial?.kind === "picture-track");
  const audio = Object.values(ir.nodes).find((node): node is AudioTrack => node.editorial?.kind === "audio-track");
  assert.ok(picture);
  assert.ok(audio);
  return { picture, audio };
}

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2, buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function pcm24Data(buffer: Buffer) {
  let offset = 12, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.deepEqual({ sampleRate, blockAlign, bits }, { sampleRate: 48_000, blockAlign: 6, bits: 24 });
  const sample = (frame: number, channel = 0) => {
    const position = frame * blockAlign + channel * 3;
    let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000;
    return value / 0x800000;
  };
  return { frames: data.length / blockAlign, sample };
}

async function lockedProject() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-trim-runtime-"));
  const colors = [
    ...[64, 96, 128, 160].map((red) => [red, 0, 0]),
    ...[64, 96, 128, 160].map((green) => [0, green, 0]),
    ...[64, 96, 128, 160].map((blue) => [0, 0, blue]),
    ...[64, 96, 128, 160].map((yellow) => [yellow, yellow, 0]),
  ];
  const rawFrames = Buffer.concat(colors.map((color) => Buffer.from(Array.from({ length: 16 * 16 }, () => color).flat())));
  const rawPath = resolve(root, "source.rgb");
  await writeFile(rawPath, rawFrames);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "16x16", "-framerate", "4", "-i", rawPath,
    "-frames:v", "16", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrp", resolve(root, "source.mkv"),
  ]);
  const second = 48_000;
  const pcm = [
    ...Array.from({ length: second }, () => 1_000),
    ...Array.from({ length: second }, () => 5_000),
    ...Array.from({ length: second }, () => -10_000),
    ...Array.from({ length: second }, () => 15_000),
  ];
  await writeFile(resolve(root, "source.wav"), monoPcm16Wave(second, pcm));
  const ir = compile(), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { root, ir, composition: ir.compositions[0], scene: ir.scenes[ir.compositions[0].sceneIds[0]] };
}

function center(surface: { data: Buffer; width: number; height: number }) {
  const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function nearColor(actual: readonly number[], expected: readonly number[]) {
  assert.equal(actual.length, 4);
  expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) <= 3, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`));
}

test("locked session and direct track validators require one central LinkedTrim authorization", { timeout: 30_000 }, async () => {
  const { ir, composition } = await lockedProject(), { picture, audio } = tracks(ir);
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const authorizations = validateReferenceLinkedTrimTransactions(ir, composition);
  assert.throws(() => validateReferencePictureTrackOperationPlan(ir, composition, picture), /LinkedTrim transaction|cannot mutate linked audio independently/);
  assert.throws(() => validateReferenceAudioTrackOperationPlan(ir, composition, audio), /LinkedTrim transaction|cannot mutate linked picture independently/);
  assert.doesNotThrow(() => validateReferencePictureTrackOperationPlan(ir, composition, picture, authorizations.pictureByTrackId.get(picture.id)));
  assert.doesNotThrow(() => validateReferenceAudioTrackOperationPlan(ir, composition, audio, authorizations.audioByTrackId.get(audio.id)));
});

test("direct picture and audio rendering decode the exact LinkedTrim range with destination gaps", { timeout: 45_000 }, async () => {
  const { root, ir, composition, scene } = await lockedProject();
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "visual-cache"));
  await renderer.prepare();
  try {
    const pixels: number[][] = [];
    for (const frame of [0, 3, 4, 5, 7, 8, 11, 12, 15]) pixels.push(center(await renderer.sceneFrame(scene, frame, false)));
    nearColor(pixels[0], [0, 0, 0, 0]);
    nearColor(pixels[1], [0, 0, 0, 0]);
    nearColor(pixels[2], [0, 64, 0, 255]);
    nearColor(pixels[3], [0, 96, 0, 255]);
    nearColor(pixels[4], [0, 160, 0, 255]);
    nearColor(pixels[5], [0, 0, 64, 255]);
    nearColor(pixels[6], [0, 0, 160, 255]);
    nearColor(pixels[7], [0, 0, 0, 0]);
    nearColor(pixels[8], [0, 0, 0, 0]);
  } finally {
    renderer.close();
  }

  const output = resolve(root, "linked-trim.wav");
  await renderReferenceAudio(ir, composition, root, output);
  const decoded = pcm24Data(await readFile(output)), monoToStereo = Math.SQRT1_2 / 32_768;
  assert.equal(decoded.frames, 192_000);
  const near = (frame: number, expected: number) => assert.ok(
    Math.abs(decoded.sample(frame) - expected * monoToStereo) < .002,
    `sample ${frame}: ${decoded.sample(frame)} != ${expected * monoToStereo}`,
  );
  near(0, 0); near(47_999, 0);
  near(48_000, 5_000); near(95_999, 5_000);
  near(96_000, -10_000); near(143_999, -10_000);
  near(144_000, 0); near(191_999, 0);
});

test("direct visual and audio entry points reject a one-sided transaction before output publication", { timeout: 30_000 }, async () => {
  const { root, ir } = await lockedProject();
  const hostile = structuredClone(ir), { audio } = tracks(hostile);
  audio.editorial.operationPlan!.operations = [];
  assert.throws(
    () => new ReferenceVisualRenderer(hostile, hostile.compositions[0], root, resolve(root, "hostile-visual-cache")),
    (error: unknown) => error instanceof ReferenceLinkedTrimError && error.code === "CUT_LINKED_TRIM_CORRELATION",
  );
  const output = resolve(root, "must-not-publish.wav");
  await assert.rejects(
    renderReferenceAudio(hostile, hostile.compositions[0], root, output),
    (error: unknown) => error instanceof ReferenceLinkedTrimError && error.code === "CUT_LINKED_TRIM_CORRELATION",
  );
  await assert.rejects(access(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});
