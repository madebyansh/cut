import assert from "node:assert/strict";
import { access, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  ReferenceAudioLimiterError,
  processReferenceAudioLimiter,
  referenceAudioLimiterLimits,
} from "../lib/runtime/reference/audio-limiter";
import {
  assertReferenceAudioLimiterFileWorkContract,
  measureReferenceAudioLimiterFileTruePeak,
  processReferenceAudioLimiterFile,
  referenceAudioLimiterFileLimits,
} from "../lib/runtime/reference/audio-limiter-file";

const sampleRate = 48_000;
const source = Object.freeze({
  module: "file-limiter-test.cut",
  line: 7,
  column: 5,
  nodeId: "limiter-test",
});

function encode(samples: Float32Array) {
  const bytes = Buffer.allocUnsafe(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) bytes.writeFloatLE(samples[index], index * 4);
  return bytes;
}

function decode(bytes: Buffer) {
  assert.equal(bytes.byteLength % 8, 0);
  const samples = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readFloatLE(index * 4);
  return samples;
}

test("phase-specialized file FIR remains exact at programme and chunk boundaries", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-file-phase-parity-"));
  try {
    const lengths = [
      1,
      2,
      11,
      12,
      13,
      referenceAudioLimiterFileLimits.chunkFrames - 1,
      referenceAudioLimiterFileLimits.chunkFrames,
      referenceAudioLimiterFileLimits.chunkFrames + 1,
    ];
    for (const [caseIndex, frames] of lengths.entries()) {
      const input = new Float32Array(frames * 2);
      let state = (0x9e37_79b9 ^ frames) >>> 0;
      for (let frame = 0; frame < frames; frame += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        const random = state / 0xffff_ffff;
        input[frame * 2] = Math.fround((random * 2 - 1) * 0.7);
        input[frame * 2 + 1] = Math.fround(((frame & 1) ? -1 : 1) * random * 0.65);
      }
      input[0] = -0;
      input[1] = Math.fround(1.401298464324817e-45);
      for (const frame of [0, 1, 11, 12, frames - 13, frames - 2, frames - 1]) {
        if (frame < 0 || frame >= frames) continue;
        input[frame * 2] = Math.fround(frame === 0 && frames === 13 ? 64 : 1.7);
        input[frame * 2 + 1] = Math.fround(frame === 0 && frames === 13 ? -64 : -1.55);
      }
      const inputPath = resolve(root, `input-${caseIndex}.f32le`);
      const outputPath = resolve(root, `output-${caseIndex}.f32le`);
      const inputBytes = encode(input);
      await writeFile(inputPath, inputBytes);
      const controls = {
        sampleRate,
        lookaheadSamples: caseIndex % 2 === 0 ? 0 : Math.min(960, frames),
        ceilingDbtp: () => -1,
        releaseSeconds: () => 0.075,
        source,
      };
      const expected = processReferenceAudioLimiter(input, controls);
      const actual = await processReferenceAudioLimiterFile(inputPath, outputPath, {
        ...controls,
        expectedFrames: frames,
      });
      assert.deepEqual(await readFile(outputPath), encode(expected.output), `output drifted for ${frames} frames`);
      assert.deepEqual(await readFile(inputPath), inputBytes, `input mutated for ${frames} frames`);
      assert.equal(actual.maximumOutputTruePeakLinear, expected.maximumOutputTruePeakLinear);
      assert.equal(actual.maximumOutputTruePeakFrame, expected.maximumOutputTruePeakFrame);
      assert.equal(actual.minimumAppliedGain, expected.minimumAppliedGain);
      assert.equal(actual.reconciliationFactor, expected.reconciliationFactor);

      let expectedInputPeak = 0;
      let expectedInputPeakFrame: number | null = null;
      for (let frame = 0; frame < expected.truePeakEnvelope.length; frame += 1) {
        if (expected.truePeakEnvelope[frame] > expectedInputPeak) {
          expectedInputPeak = expected.truePeakEnvelope[frame];
          expectedInputPeakFrame = frame;
        }
      }
      const measured = await measureReferenceAudioLimiterFileTruePeak(inputPath, {
        expectedFrames: frames,
        sampleRate,
        source,
      });
      assert.equal(measured.maximumLinear, expectedInputPeak);
      assert.equal(measured.maximumFrame, expectedInputPeakFrame);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk-backed limiter is byte-identical to the frozen in-memory law across FIR, lookahead, control, and release boundaries", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-file-parity-"));
  try {
    const frames = referenceAudioLimiterFileLimits.chunkFrames + 1_337;
    const input = new Float32Array(frames * 2);
    let state = 0x21c0ffee;
    for (let frame = 0; frame < frames; frame += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const noise = ((state / 0xffff_ffff) * 2 - 1) * 0.12;
      input[frame * 2] = Math.fround(noise + 0.18 * Math.sin(frame * 0.071));
      input[frame * 2 + 1] = Math.fround(-noise + 0.16 * Math.cos(frame * 0.053));
    }
    for (const frame of [
      referenceAudioLimiterFileLimits.chunkFrames - 7,
      referenceAudioLimiterFileLimits.chunkFrames - 1,
      referenceAudioLimiterFileLimits.chunkFrames,
      referenceAudioLimiterFileLimits.chunkFrames + 5,
    ]) {
      input[frame * 2] = 1.7;
      input[frame * 2 + 1] = -1.55;
    }
    const inputPath = resolve(root, "input.f32le");
    const outputPath = resolve(root, "output.f32le");
    await writeFile(inputPath, encode(input));
    const controls = {
      sampleRate,
      lookaheadSamples: 311,
      ceilingDbtp: (frame: number) => {
        if (frame < referenceAudioLimiterFileLimits.chunkFrames - 3) return -1;
        if (frame <= referenceAudioLimiterFileLimits.chunkFrames + 5) return -6;
        return -2;
      },
      releaseSeconds: (frame: number) => frame < referenceAudioLimiterFileLimits.chunkFrames ? 0.017 : 0.19,
      source,
    };
    const expected = processReferenceAudioLimiter(input, controls);
    const actual = await processReferenceAudioLimiterFile(inputPath, outputPath, {
      ...controls,
      expectedFrames: frames,
    });
    assert.deepEqual(await readFile(outputPath), encode(expected.output));
    assert.equal(actual.algorithm, expected.algorithm);
    assert.equal(actual.frames, expected.frames);
    assert.equal(actual.ceilingMode, "dynamic");
    assert.equal(actual.minimumAppliedGain, expected.minimumAppliedGain);
    assert.equal(actual.reconciliationFactor, expected.reconciliationFactor);
    assert.equal(actual.maximumOutputTruePeakLinear, expected.maximumOutputTruePeakLinear);
    assert.equal(actual.maximumOutputTruePeakFrame, expected.maximumOutputTruePeakFrame);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("240-second limiter preserves sparse transients and exact output length through bounded chunks", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-file-240s-"));
  try {
    const frames = sampleRate * 240;
    const inputPath = resolve(root, "input.f32le");
    const outputPath = resolve(root, "output.f32le");
    const handle = await open(inputPath, "wx", 0o600);
    try {
      await handle.truncate(frames * 8);
      const impulse = Buffer.alloc(16);
      impulse.writeFloatLE(1.8, 0);
      impulse.writeFloatLE(-1.6, 4);
      impulse.writeFloatLE(-1.7, 8);
      impulse.writeFloatLE(1.5, 12);
      await handle.write(impulse, 0, impulse.length, (referenceAudioLimiterFileLimits.chunkFrames - 1) * 8);
      await handle.write(impulse.subarray(0, 8), 0, 8, (frames - 3) * 8);
    } finally {
      await handle.close();
    }
    const result = await processReferenceAudioLimiterFile(inputPath, outputPath, {
      expectedFrames: frames,
      sampleRate,
      lookaheadSamples: 960,
      ceilingDbtp: () => -1,
      releaseSeconds: () => 0.08,
      source,
    });
    assert.equal((await stat(outputPath)).size, frames * 8);
    assert.equal(result.frames, frames);
    assert.equal(result.lookaheadSamples, 960);
    assert.equal(result.ceilingMode, "static");
    assert.ok(result.minimumAppliedGain < 1);
    assert.ok(result.maximumOutputTruePeakDbtp !== null && result.maximumOutputTruePeakDbtp <= -1);
    const output = await open(outputPath, "r");
    try {
      const boundary = Buffer.alloc(8 * 8);
      await output.read(boundary, 0, boundary.length, (referenceAudioLimiterFileLimits.chunkFrames - 4) * 8);
      assert.ok([...decode(boundary)].some((sample) => sample !== 0));
    } finally {
      await output.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file-backed domain keeps a source-located five-minute ceiling and cleans failed output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-file-refusal-"));
  try {
    const output = resolve(root, "never-created.f32le");
    assert.throws(
      () => assertReferenceAudioLimiterFileWorkContract({
        expectedFrames: referenceAudioLimiterFileLimits.maximumFrames + 1,
        sampleRate,
        lookaheadSamples: 0,
        source,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceAudioLimiterError);
        assert.equal(error.code, "CUT_AUDIO_LIMITER_WORK_LIMIT");
        assert.deepEqual(error.source, source);
        assert.equal(error.detail.reason, "file-fir-multiply-adds");
        return true;
      },
    );
    await assert.rejects(access(output));

    // The original in-memory ceiling remains unchanged and continues to fail
    // before programme allocation.
    assert.ok(referenceAudioLimiterLimits.maximumFrames < sampleRate * 80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk-backed callback failure is source-located and removes every private output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-file-cleanup-"));
  try {
    const frames = referenceAudioLimiterFileLimits.chunkFrames + 16;
    const input = resolve(root, "input.f32le");
    const output = resolve(root, "output.f32le");
    const handle = await open(input, "wx", 0o600);
    await handle.truncate(frames * 8);
    await handle.close();
    await assert.rejects(
      processReferenceAudioLimiterFile(input, output, {
        expectedFrames: frames,
        sampleRate,
        lookaheadSamples: 3,
        ceilingDbtp: (frame) => {
          if (frame === referenceAudioLimiterFileLimits.chunkFrames + 2) throw new Error("sensitive callback detail");
          return -1;
        },
        releaseSeconds: () => 0.05,
        source,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceAudioLimiterError);
        assert.equal(error.code, "CUT_AUDIO_LIMITER_CONTROL");
        assert.equal(error.detail.frame, referenceAudioLimiterFileLimits.chunkFrames + 2);
        assert.deepEqual(error.source, source);
        assert.doesNotMatch(error.message, /sensitive callback detail/u);
        return true;
      },
    );
    for (const path of [
      output,
      `${output}.unreconciled`,
      `${output}.corrected`,
      `${output}.ceilings`,
    ]) await assert.rejects(access(path));
    assert.deepEqual(await readdir(root), ["input.f32le"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk-backed dynamic reconstruction overshoot fails closed deterministically and leaves no output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-file-dynamic-refusal-"));
  try {
    const boundary = referenceAudioLimiterFileLimits.chunkFrames;
    const frames = boundary + 6;
    const inputPath = resolve(root, "input.f32le");
    const outputPath = resolve(root, "output.f32le");
    const handle = await open(inputPath, "wx", 0o600);
    try {
      await handle.truncate(frames * 8);
      const fixture = new Float32Array([
        0.2, -0.1,
        0.6675620675086975, -1.3456135988235474,
        1.3896294832229614, 1.8730218410491943,
        0.6350957751274109, 1.7300646305084229,
        0.7005090713500977, -0.19993992149829865,
        -0.061311110854148865, -0.935623049736023,
        1.0199644565582275, 1.2565211057662964,
        0, 0,
      ]);
      await handle.write(encode(fixture), 0, fixture.byteLength, (boundary - 2) * 8);
    } finally {
      await handle.close();
    }
    const run = () => processReferenceAudioLimiterFile(inputPath, outputPath, {
      expectedFrames: frames,
      sampleRate,
      lookaheadSamples: 0,
      ceilingDbtp: (frame) => frame < boundary ? -1 : -5,
      releaseSeconds: () => 0.05,
      source,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof ReferenceAudioLimiterError);
        assert.equal(error.code, "CUT_AUDIO_LIMITER_RECONCILIATION");
        assert.equal(error.detail.reason, "dynamic-ceiling-reconciliation-unsupported");
        assert.ok((error.detail.frame ?? -1) >= boundary);
        assert.ok((error.detail.reconciliationFactor ?? 1) < 1);
        return true;
      });
      assert.deepEqual(await readdir(root), ["input.f32le"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing output collision refuses source-located and preserves exact bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-file-collision-"));
  try {
    const frames = referenceAudioLimiterFileLimits.chunkFrames + 1;
    const input = resolve(root, "input.f32le");
    const output = resolve(root, "output.f32le");
    const handle = await open(input, "wx", 0o600);
    await handle.truncate(frames * 8);
    await handle.close();
    const sentinel = Buffer.from("do-not-overwrite");
    await writeFile(output, sentinel);
    await assert.rejects(
      processReferenceAudioLimiterFile(input, output, {
        expectedFrames: frames,
        sampleRate,
        lookaheadSamples: 0,
        ceilingDbtp: () => -1,
        releaseSeconds: () => 0.05,
        source,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceAudioLimiterError);
        assert.equal(error.code, "CUT_AUDIO_LIMITER_STRUCTURE");
        assert.equal(error.detail.reason, "output-reservation-failed");
        assert.deepEqual(error.source, source);
        return true;
      },
    );
    assert.deepEqual(await readFile(output), sentinel);
    assert.deepEqual((await readdir(root)).sort(), ["input.f32le", "output.f32le"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
