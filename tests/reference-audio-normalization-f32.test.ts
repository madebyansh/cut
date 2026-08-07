import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { normalizeReferenceAudio } from "../lib/runtime/reference/audio";
import { scanReferenceStereoF32LeFile } from "../lib/runtime/reference/audio-peak";

function stereoF32(frames: readonly (readonly [number, number])[]) {
  const bytes = Buffer.alloc(frames.length * 8);
  frames.forEach(([left, right], frame) => {
    bytes.writeFloatLE(left, frame * 8);
    bytes.writeFloatLE(right, frame * 8 + 4);
  });
  return bytes;
}

const source = Object.freeze({ module: "normalization.cut", line: 1, column: 1, nodeId: "meter" });

test("raw-f32 normalization distinguishes exact silence from short unmeasurable sound", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-normalization-f32-"));
  const cases = [
    { name: "silent", samples: stereoF32([[0, 0], [0, 0], [0, 0], [0, 0]]), expected: "skipped-silence" },
    { name: "short-sound", samples: stereoF32([[0.25, -0.25], [0.125, -0.125], [0.25, -0.25], [0.125, -0.125]]), expected: "skipped-unmeasurable" },
  ] as const;

  for (const item of cases) {
    const input = resolve(root, `${item.name}.f32le`), output = resolve(root, `${item.name}.wav`);
    await writeFile(input, item.samples);
    const peak = await scanReferenceStereoF32LeFile(input, { expectedFrames: 4, source, thresholdDbfs: 0 });
    const report = await normalizeReferenceAudio(input, output, -14, -1, 9, 48_000, {
      inputFormat: "raw-stereo-f32le",
      inputPeak: peak,
    });
    assert.equal(report.normalization, item.expected);
    assert.equal(peak.silent, item.name === "silent");
    const delivered = await readFile(output);
    assert.equal(delivered.toString("ascii", 0, 4), "RIFF");
    assert.equal(delivered.toString("ascii", 8, 12), "WAVE");
  }
});

test("raw-f32 normalization refuses missing or structurally inconsistent scan evidence before FFmpeg", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-normalization-f32-proof-"));
  const input = resolve(root, "input.f32le"), output = resolve(root, "output.wav");
  await writeFile(input, stereoF32([[0.1, 0.1]]));
  await assert.rejects(
    normalizeReferenceAudio(input, output, -14, -1, 9, 48_000, { inputFormat: "raw-stereo-f32le" }),
    /requires a fresh exact stereo peak scan/,
  );
  await assert.rejects(readFile(output));
});
