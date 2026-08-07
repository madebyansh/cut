import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { deliverReferenceAac, prepareReferenceAacDelivery } from "../lib/runtime/reference/delivery";
import { measureReferenceAudio, measureReferenceAudioAuthoredBoundary } from "../lib/runtime/reference/audio";
import { ReferenceAudioDeliveryError } from "../lib/runtime/reference/audio-delivery-inspection";
import { ReferenceAudioTruePeakError } from "../lib/runtime/reference/audio-true-peak";
import { runFfmpeg } from "../lib/runtime/reference/ffmpeg";

const source = Object.freeze({ module: "delivery.cut", line: 4, column: 3, nodeId: "node.master" });

function deliveryContract(expectedFrames: number) {
  return { sampleRate: 48_000, expectedFrames, source };
}

async function withDefensiveFfmpegWrapper<T>(
  root: string,
  environment: Readonly<Record<string, string>>,
  action: () => Promise<T>,
) {
  const bin = resolve(root, "defensive-bin");
  const wrapper = resolve(bin, "ffmpeg");
  await mkdir(bin, { recursive: true });
  await writeFile(wrapper, `#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.CUT_TEST_DELIVERY_CHANGE;
if (mode === "authored-input" && args.at(-1).includes("delivery-pass-1.mp4")) {
  fs.copyFileSync(process.env.CUT_TEST_REPLACEMENT, process.env.CUT_TEST_TARGET);
}
if (mode === "candidate" && args.some((argument) => argument.includes("loudnorm="))) {
  const input = args[args.indexOf("-i") + 1];
  if (input && input.includes("delivery-pass-1.mp4")) fs.copyFileSync(process.env.CUT_TEST_REPLACEMENT, input);
}
if (mode === "output-parent" && args.some((argument) => argument.includes("loudnorm="))) {
  fs.unlinkSync(process.env.CUT_TEST_TARGET);
  fs.symlinkSync(process.env.CUT_TEST_REPLACEMENT, process.env.CUT_TEST_TARGET);
}
const result = childProcess.spawnSync(process.env.CUT_TEST_REAL_FFMPEG, args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`);
  await chmod(wrapper, 0o700);
  const previous = new Map<string, string | undefined>();
  const next = {
    ...environment,
    CUT_TEST_REAL_FFMPEG: execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim(),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  for (const [name, value] of Object.entries(next)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function overshootFixture(root: string) {
  const picture = resolve(root, "picture.mp4"), normalizedPcm = resolve(root, "normalized.wav");
  await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
  // This 16 kHz PCM master measures just below -1 dBTP, but the reference
  // AAC encoder deterministically decodes above it. It exercises an actual
  // codec overshoot rather than a synthetic/mock measurement.
  await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=16000:sample_rate=48000:duration=3", "-af", "volume=7.8", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", normalizedPcm]);
  return { picture, normalizedPcm };
}

test("AAC delivery re-encodes a PCM overshoot fixture until its muxed true peak is compliant", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-overshoot-"));
  try {
    const { picture, normalizedPcm } = await overshootFixture(root);
    const pcmMeasurement = await measureReferenceAudio(normalizedPcm, -14, -1, 9);
    assert.ok(pcmMeasurement.truePeakDbtp !== null && pcmMeasurement.truePeakDbtp <= -1, JSON.stringify(pcmMeasurement));
    const output = resolve(root, "delivery.mp4"), target = { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 };
    const report = await deliverReferenceAac({ silentVideo: picture, normalizedPcm, output, target, ...deliveryContract(144_000) });

    assert.equal(report.format, "cut-reference-aac-delivery");
    assert.equal(report.version, 2);
    assert.deepEqual(report.codec, {
      name: "aac",
      implementation: "ffmpeg-native-aac",
      bitrate: 256_000,
      container: "mp4",
      movieTimescale: 48_000,
      primingFrames: 1_024,
    });
    assert.equal(report.truePeakAuthority, "cut-bs1770-5-with-conservative-ffmpeg-cross-check");
    assert.equal(report.toolchain.format, "cut-reference-audio-toolchain");
    assert.equal(report.toolchain.version, 1);
    assert.match(report.toolchain.integrity, /^[a-f0-9]{64}$/u);
    assert.match(report.toolchain.ffmpeg.identitySha256, /^[a-f0-9]{64}$/u);
    assert.match(report.toolchain.ffmpeg.version, /^ffmpeg version /u);
    assert.equal(report.source, "normalized-pcm");
    assert.equal(report.passes[0].source, "normalized-pcm");
    assert.equal(report.normalizedPcm.framing.expectedFrames, 144_000);
    assert.equal(report.normalizedPcm.framing.trailingPaddingFrames, 0);
    assert.equal(report.passes[0].decoded.leadingPrimingFrames, 1_024);
    assert.ok(report.passes[0].decoded.trailingPaddingFrames >= 0 && report.passes[0].decoded.trailingPaddingFrames < 1_024);
    assert.equal(report.passes[0].cutTruePeak.algorithm, report.normalizedPcm.truePeak.algorithm);
    assert.match(report.normalizedPcm.authoredPcmSha256, /^[a-f0-9]{64}$/u);
    for (const pass of report.passes) {
      assert.match(pass.encodedSha256, /^[a-f0-9]{64}$/u);
      assert.match(pass.authoredPcmSha256, /^[a-f0-9]{64}$/u);
    }
    assert.ok(report.passes[0].truePeakResidualDb !== null && report.passes[0].truePeakResidualDb > 0, JSON.stringify(report));
    assert.ok(report.passCount >= 2, JSON.stringify(report));
    assert.ok(report.appliedGainDb < 0, JSON.stringify(report));
    assert.equal(report.truePeakCompliant, true, JSON.stringify(report));
    assert.ok(report.residuals.truePeakDb !== null && report.residuals.truePeakDb <= 0, JSON.stringify(report));
    assert.equal(report.passes.at(-1)?.cutTruePeakCompliant, true);
    assert.notEqual(report.passes.at(-1)?.ffmpegTruePeakCompliant, false);
    assert.ok(report.finalFfmpegMeasurement.truePeakDbtp !== null && report.finalFfmpegMeasurement.truePeakDbtp <= -1, JSON.stringify(report));
    assert.ok((await stat(output)).size > 1_000);

    const decodedMeasurement = await measureReferenceAudioAuthoredBoundary(output, {
      expectedFrames: 144_000,
      sampleRate: 48_000,
      targetLufs: target.integratedLufs,
      truePeakDbtp: target.truePeakDbtp,
      loudnessRangeLu: target.loudnessRangeLu,
    });
    assert.ok(decodedMeasurement.truePeakDbtp !== null && decodedMeasurement.truePeakDbtp <= target.truePeakDbtp, JSON.stringify(decodedMeasurement));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AAC delivery fails closed when the required PCM correction exceeds its bounded budget", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-bound-"));
  try {
    const { picture, normalizedPcm } = await overshootFixture(root);
    const output = resolve(root, "rejected.mp4");
    await assert.rejects(
      () => deliverReferenceAac({ silentVideo: picture, normalizedPcm, output, target: { integratedLufs: -14, truePeakDbtp: -9, loudnessRangeLu: 9 }, ...deliveryContract(144_000) }),
      /beyond the bounded 6 dB delivery stage/,
    );
    await assert.rejects(() => stat(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AAC delivery preserves silent and unmeasurable output without inventing a correction", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-silence-"));
  try {
    const picture = resolve(root, "picture.mp4"), normalizedPcm = resolve(root, "silent.wav"), output = resolve(root, "silent.mp4");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=1", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", normalizedPcm]);

    const report = await deliverReferenceAac({ silentVideo: picture, normalizedPcm, output, target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 }, ...deliveryContract(48_000) });
    assert.equal(report.status, "loudness-unmeasurable");
    assert.equal(report.passCount, 1);
    assert.equal(report.appliedGainDb, 0);
    assert.equal(report.normalizedPcm.truePeak.silent, true);
    assert.equal(report.passes[0].cutTruePeak.silent, true);
    assert.equal(report.truePeakCompliant, true);
    assert.equal(report.residuals.truePeakDb, null);
    assert.ok((await stat(output)).size > 1_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AAC framing excludes priming and trailing codec padding from the authored true-peak boundary", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-padding-"));
  try {
    const picture = resolve(root, "picture.mp4"), normalizedPcm = resolve(root, "short.wav"), output = resolve(root, "short.mp4");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=8:d=0.25", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=0.25", "-af", "volume=0.2", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", normalizedPcm]);

    const report = await deliverReferenceAac({
      silentVideo: picture,
      normalizedPcm,
      output,
      target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 },
      ...deliveryContract(12_000),
    });
    const framing = report.passes.at(-1)!.decoded;
    assert.equal(framing.streamDurationFrames, 12_000);
    assert.equal(framing.leadingPrimingFrames, 1_024);
    assert.equal(framing.decodedFrames, 12_288);
    assert.equal(framing.trailingPaddingFrames, 288);
    assert.equal(report.passes.at(-1)!.cutTruePeak.expectedFrames, 12_000);
    assert.equal(report.passes.at(-1)!.cutTruePeak.observedFrames, 12_000);
    assert.equal(report.passes.at(-1)!.cutTruePeak.observedBytes, 12_000 * 8);
    const authored = await measureReferenceAudioAuthoredBoundary(output, {
      expectedFrames: 12_000,
      sampleRate: 48_000,
      targetLufs: -14,
      truePeakDbtp: -1,
      loudnessRangeLu: 9,
    });
    assert.deepEqual(authored, report.finalFfmpegMeasurement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AAC delivery preserves exact non-millisecond authored durations down to one sample", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-exact-clock-"));
  try {
    for (const expectedFrames of [1, 100, 1_000, 1_600, 2_000]) {
      const picture = resolve(root, `exact-${expectedFrames}-picture.mp4`);
      const raw = resolve(root, `exact-${expectedFrames}.f32le`);
      const normalizedPcm = resolve(root, `exact-${expectedFrames}.wav`);
      const output = resolve(root, `exact-${expectedFrames}.mp4`);
      // One video frame at an exact rational frame rate gives picture and
      // audio the same authored boundary, even for a one-sample composition.
      await runFfmpeg([
        "-y", "-v", "error",
        "-f", "lavfi", "-i", `color=c=black:s=64x64:r=48000/${expectedFrames}`,
        "-frames:v", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-video_track_timescale", "48000", picture,
      ]);
      await writeFile(raw, Buffer.alloc(expectedFrames * 8));
      await runFfmpeg([
        "-y", "-v", "error",
        "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", raw,
        "-c:a", "pcm_s24le", normalizedPcm,
      ]);
      const report = await deliverReferenceAac({
        silentVideo: picture,
        normalizedPcm,
        output,
        target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 },
        ...deliveryContract(expectedFrames),
      });
      assert.equal(report.codec.movieTimescale, 48_000);
      assert.equal(report.normalizedPcm.framing.streamDurationFrames, expectedFrames);
      assert.equal(report.passes.at(-1)!.decoded.streamDurationFrames, expectedFrames);
      assert.equal(report.passes.at(-1)!.cutTruePeak.observedFrames, expectedFrames);
      assert.equal(report.status, "loudness-unmeasurable");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AAC delivery refuses a candidate whose picture does not share the authored boundary", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-picture-boundary-"));
  try {
    const picture = resolve(root, "one-second-picture.mp4");
    const raw = resolve(root, "one-sample.f32le");
    const normalizedPcm = resolve(root, "one-sample.wav");
    const output = resolve(root, "must-not-publish.mp4");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
    await writeFile(raw, Buffer.alloc(8));
    await runFfmpeg(["-y", "-v", "error", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", raw, "-c:a", "pcm_s24le", normalizedPcm]);
    await assert.rejects(
      deliverReferenceAac({
        silentVideo: picture,
        normalizedPcm,
        output,
        target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 },
        ...deliveryContract(1),
      }),
      (error) => error instanceof ReferenceAudioDeliveryError
        && (error.detail.reason === "media-stream-contract" || error.detail.reason === "video-duration"),
    );
    await assert.rejects(() => stat(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AAC delivery rejects hostile option shapes before backend work with stable diagnostics", async () => {
  const invoke = (value: unknown) => deliverReferenceAac(value as Parameters<typeof deliverReferenceAac>[0]);
  const base = {
    silentVideo: "/must/not/be/read.mp4",
    normalizedPcm: "/must/not/be/read.wav",
    output: "/must/not/be/written.mp4",
    target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 },
    ...deliveryContract(48_000),
  };
  for (const [value, reason] of [
    [{ ...base, target: { ...base.target, truePeakDbtp: "-1:evil" } }, "invalid-target.truePeakDbtp"],
    [{ ...base, target: { ...base.target, integratedLufs: Number.POSITIVE_INFINITY } }, "invalid-target.integratedLufs"],
  ] as const) {
    await assert.rejects(invoke(value), (error) => error instanceof ReferenceAudioDeliveryError
      && error.code === "CUT_AUDIO_DELIVERY_STRUCTURE"
      && error.detail.reason === reason
      && error.source.nodeId === source.nodeId);
  }

  await assert.rejects(
    invoke({ ...base, expectedFrames: 1n }),
    (error) => error instanceof ReferenceAudioTruePeakError
      && error.code === "CUT_AUDIO_TRUE_PEAK_STRUCTURE"
      && error.detail.reason === "invalid-expected-frames",
  );

  let getterRead = false;
  const accessor = { ...base } as Record<string, unknown>;
  Object.defineProperty(accessor, "output", { enumerable: true, get() { getterRead = true; return base.output; } });
  await assert.rejects(invoke(accessor), (error) => error instanceof ReferenceAudioDeliveryError
    && error.code === "CUT_AUDIO_DELIVERY_STRUCTURE"
    && error.detail.reason === "invalid-options");
  assert.equal(getterRead, false);

  const prepare = (toolchain: unknown) => prepareReferenceAacDelivery({
    silentVideo: base.silentVideo,
    normalizedPcm: base.normalizedPcm,
    target: base.target,
    sampleRate: base.sampleRate,
    expectedFrames: base.expectedFrames,
    source: base.source,
    stagingRoot: "/must/not/be-used",
    toolchain,
  } as Parameters<typeof prepareReferenceAacDelivery>[0]);
  await assert.rejects(
    prepare({ format: "cut-reference-audio-toolchain", version: 1 }),
    (error) => error instanceof ReferenceAudioDeliveryError
      && error.code === "CUT_AUDIO_DELIVERY_STRUCTURE"
      && error.detail.reason === "invalid-toolchain",
  );
  const forged = {
    format: "cut-reference-audio-toolchain",
    version: 1,
    runtime: "cut-reference/forged",
    platform: "darwin",
    architecture: "arm64",
    node: "v0.0.0",
    ffmpeg: { version: "ffmpeg version forged", identitySha256: "a".repeat(64) },
    integrity: "b".repeat(64),
  };
  await assert.rejects(
    prepare(forged),
    (error) => error instanceof ReferenceAudioDeliveryError
      && error.code === "CUT_AUDIO_DELIVERY_STRUCTURE"
      && error.detail.reason === "invalid-toolchain-integrity",
  );
});

test("AAC leaf publication replaces a symlink without following its target and leaves no private stage", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-symlink-"));
  try {
    const picture = resolve(root, "picture.mp4");
    const normalizedPcm = resolve(root, "normalized.wav");
    const output = resolve(root, "delivery.mp4");
    const sentinel = resolve(root, "outside-sentinel.txt");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=1", "-c:a", "pcm_s24le", normalizedPcm]);
    await writeFile(sentinel, "sentinel-must-not-change");
    await symlink(sentinel, output);

    await deliverReferenceAac({
      silentVideo: picture,
      normalizedPcm,
      output,
      target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 },
      ...deliveryContract(48_000),
    });

    assert.equal(await readFile(sentinel, "utf8"), "sentinel-must-not-change");
    assert.equal((await lstat(output)).isSymbolicLink(), false);
    assert.ok((await stat(output)).size > 1_000);
    assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(".cut-aac-delivery-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every delivery authority consumes one private authored-input snapshot", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-input-snapshot-"));
  try {
    const picture = resolve(root, "picture.mp4");
    const normalizedPcm = resolve(root, "normalized.wav");
    const replacement = resolve(root, "replacement.wav");
    const output = resolve(root, "delivery.mp4");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=1", "-c:a", "pcm_s24le", normalizedPcm]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=1", "-af", "volume=0.2", "-ac", "2", "-c:a", "pcm_s24le", replacement]);

    const report = await withDefensiveFfmpegWrapper(root, {
      CUT_TEST_DELIVERY_CHANGE: "authored-input",
      CUT_TEST_TARGET: normalizedPcm,
      CUT_TEST_REPLACEMENT: replacement,
    }, () => deliverReferenceAac({
      silentVideo: picture,
      normalizedPcm,
      output,
      target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 },
      ...deliveryContract(48_000),
    }));

    assert.equal(report.normalizedPcm.truePeak.silent, true);
    assert.equal(report.passes.at(-1)!.cutTruePeak.silent, true);
    assert.equal(report.finalFfmpegMeasurement.truePeakDbtp, null);
    assert.ok((await measureReferenceAudio(normalizedPcm)).truePeakDbtp !== null, "the authored path was not changed by the deterministic boundary test");
    assert.equal((await measureReferenceAudioAuthoredBoundary(output, { expectedFrames: 48_000, sampleRate: 48_000 })).truePeakDbtp, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate changes between CUT and FFmpeg authorities fail before publication", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-candidate-snapshot-"));
  try {
    const picture = resolve(root, "picture.mp4");
    const normalizedPcm = resolve(root, "normalized.wav");
    const replacementPcm = resolve(root, "replacement.wav");
    const replacement = resolve(root, "replacement.mp4");
    const output = resolve(root, "must-not-publish.mp4");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=1", "-c:a", "pcm_s24le", normalizedPcm]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=1", "-af", "volume=0.2", "-ac", "2", "-c:a", "pcm_s24le", replacementPcm]);
    await runFfmpeg([
      "-y", "-v", "error", "-i", picture, "-i", replacementPcm,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "256000",
      "-movie_timescale", "48000", "-shortest", replacement,
    ]);

    await assert.rejects(
      withDefensiveFfmpegWrapper(root, {
        CUT_TEST_DELIVERY_CHANGE: "candidate",
        CUT_TEST_TARGET: normalizedPcm,
        CUT_TEST_REPLACEMENT: replacement,
      }, () => deliverReferenceAac({
        silentVideo: picture,
        normalizedPcm,
        output,
        target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 },
        ...deliveryContract(48_000),
      })),
      (error) => error instanceof ReferenceAudioDeliveryError
        && error.code === "CUT_AUDIO_DELIVERY_STRUCTURE"
        && error.detail.reason === "candidate-changed",
    );
    await assert.rejects(() => stat(output), { code: "ENOENT" });
    assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(".cut-aac-delivery-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed lexical output ancestor cannot redirect verified publication", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-parent-snapshot-"));
  try {
    const picture = resolve(root, "picture.mp4");
    const normalizedPcm = resolve(root, "normalized.wav");
    const first = resolve(root, "first");
    const second = resolve(root, "second");
    const link = resolve(root, "current");
    await mkdir(resolve(first, "output"), { recursive: true });
    await mkdir(resolve(second, "output"), { recursive: true });
    await symlink(first, link);
    const output = resolve(link, "output", "delivery.mp4");
    const redirected = resolve(second, "output", "delivery.mp4");
    await writeFile(redirected, "redirect-sentinel");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=1", "-c:a", "pcm_s24le", normalizedPcm]);

    await assert.rejects(
      withDefensiveFfmpegWrapper(root, {
        CUT_TEST_DELIVERY_CHANGE: "output-parent",
        CUT_TEST_TARGET: link,
        CUT_TEST_REPLACEMENT: second,
      }, () => deliverReferenceAac({
        silentVideo: picture,
        normalizedPcm,
        output,
        target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 },
        ...deliveryContract(48_000),
      })),
      (error) => error instanceof ReferenceAudioDeliveryError
        && error.code === "CUT_AUDIO_DELIVERY_STRUCTURE"
        && error.detail.reason === "publication-parent-changed",
    );
    assert.equal(await readFile(redirected, "utf8"), "redirect-sentinel");
    await assert.rejects(() => stat(resolve(first, "output", "delivery.mp4")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery rate and duration contracts fail closed with stable source diagnostics", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aac-delivery-contract-"));
  try {
    const picture = resolve(root, "picture.mp4"), pcm = resolve(root, "audio.wav");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=8:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", picture]);
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=1", "-c:a", "pcm_s24le", pcm]);
    const target = { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 9 };

    await assert.rejects(
      deliverReferenceAac({ silentVideo: picture, normalizedPcm: pcm, output: resolve(root, "wrong-rate.mp4"), target, expectedFrames: 48_000, sampleRate: 44_100, source }),
      (error) => error instanceof ReferenceAudioTruePeakError
        && error.code === "CUT_AUDIO_TRUE_PEAK_SAMPLE_RATE_UNSUPPORTED"
        && error.source.nodeId === source.nodeId,
    );
    await assert.rejects(
      deliverReferenceAac({ silentVideo: picture, normalizedPcm: pcm, output: resolve(root, "wrong-duration.mp4"), target, ...deliveryContract(47_999) }),
      (error) => error instanceof ReferenceAudioDeliveryError
        && error.code === "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE"
        && error.detail.reason === "stream-duration"
        && error.source.nodeId === source.nodeId,
    );
    await assert.rejects(() => stat(resolve(root, "wrong-rate.mp4")), { code: "ENOENT" });
    await assert.rejects(() => stat(resolve(root, "wrong-duration.mp4")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
