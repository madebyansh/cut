import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseCutLanguage } from "../lib/language/parser";
import { compileCutModule } from "../lib/language/compiler";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { CutMediaPresentationPlanError } from "../lib/language/media-presentation";
import { rational } from "../lib/language/rational";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const exec = promisify(execFile);

function wave(sampleRate: number, samples: readonly number[]) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + samples.length * 2, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function source(range: string) {
  return `cut 0.4;
project "Linked source grid";
import { Clip } from "@cut/edit";
asset take: VideoAsset = video("media/take.mov");
timeline main(duration: 1s, fps: 24, width: 32px, height: 32px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Clip(source: take, range: ${range}, duration: 1s);
  }
}
export out = render(main, width: 32px, height: 32px, codec: "h264");
`;
}

function compile(text: string) {
  const parsed = parseCutLanguage(text); assert.ok(parsed.module); assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function pcm24Sample(buffer: Buffer, frame: number) {
  let cursor = 12, blockAlign = 0, dataOffset = -1, dataBytes = 0;
  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString("ascii", cursor, cursor + 4), size = buffer.readUInt32LE(cursor + 4), body = cursor + 8;
    if (id === "fmt ") { assert.equal(buffer.readUInt16LE(body + 2), 2); assert.equal(buffer.readUInt32LE(body + 4), 48_000); blockAlign = buffer.readUInt16LE(body + 12); }
    if (id === "data") { dataOffset = body; dataBytes = size; break; }
    cursor = body + size + size % 2;
  }
  assert.equal(blockAlign, 6); assert.ok(dataOffset >= 0); assert.equal(dataBytes / blockAlign, 48_000);
  const offset = dataOffset + frame * blockAlign;
  let value = buffer[offset] | buffer[offset + 1] << 8 | buffer[offset + 2] << 16;
  if (value & 0x800000) value -= 0x1000000;
  return value / 0x800000;
}

test("linked AV Clip rejects source times that split a lock-selected audio sample", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-source-grid-")); await mkdir(resolve(root, "media"));
  const sampleRate = 44_100, samples = Array.from({ length: sampleRate * 2 }, (_, index) => index < sampleRate / 2 || index >= sampleRate * 3 / 2 ? 12_000 : -12_000);
  const raw = resolve(root, "take.wav"), media = resolve(root, "media", "take.mov"); await writeFile(raw, wave(sampleRate, samples));
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=24:d=2", "-i", raw, "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "24000", "-c:a", "pcm_s24le", media]);

  const offGrid = compile(source("1f ..< 25f"));
  await assert.rejects(
    () => createCutLock(offGrid, root),
    (error) => error instanceof CutMediaPresentationPlanError
      && error.code === "CUT_MEDIA_PRESENTATION_OFFSET_GRID"
      && error.source.line === 7
      && /44100 Hz sample grid/.test(error.message),
  );

  const exact = compile(source("500ms ..< 1500ms")), exactLock = await createCutLock(exact, root); await applyCutLock(exact, exactLock, root);
  const { composition } = validateReferenceSession(exact), output = resolve(root, "exact.wav"); await renderReferenceAudio(exact, composition, root, output);
  assert.ok(pcm24Sample(await readFile(output), 2_000) < -.25, "the exact 22,050-source-sample trim must begin in the negative segment");

  const hostile = structuredClone(exact), clip = Object.values(hostile.nodes).find((node) => node.op === "cut.edit.clip")!;
  assert.equal(clip.inputs.range?.kind, "range");
  if (clip.inputs.range?.kind === "range") {
    clip.inputs.range.start = { kind: "quantity", dimension: "time", magnitude: rational(1, 24), unit: "s" };
    clip.inputs.range.end = { kind: "quantity", dimension: "time", magnitude: rational(25, 24), unit: "s" };
  }
  assert.throws(
    () => validateReferenceSession(hostile),
    (error) => error instanceof CutMediaPresentationPlanError
      && error.code === "CUT_MEDIA_PRESENTATION_OFFSET_GRID"
      && error.source.line === 7
      && /44100 Hz sample grid/.test(error.message),
  );
});
