import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseCutLanguage } from "../lib/language/parser";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { defaultReferenceMasteringTarget, deriveReferenceMasteringTarget } from "../lib/runtime/reference/mastering";
import { renderReferenceIr } from "./reference-render-test-helper";
import { measureReferenceAudio } from "../lib/runtime/reference/audio";
import { ReferenceAudioPeakError } from "../lib/runtime/reference/audio-peak";
import { ReferenceAudioTruePeakError } from "../lib/runtime/reference/audio-true-peak";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

test("mastering target uses stable defaults with no reachable authored values", () => {
  const ir = compile('cut 0.4; project "defaults"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { Meter() { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  assert.deepEqual(deriveReferenceMasteringTarget(ir, ir.compositions[0]), defaultReferenceMasteringTarget);
});

test("a reachable Meter authors all release normalization targets", () => {
  const ir = compile('cut 0.4; project "authored"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { Meter(target: -10lufs, truePeak: -3dbtp, samplePeak: -2dbfs, range: 2) as detached { Tone(frequency: 220hz, duration: 1s); } Meter(target: -16lufs, truePeak: -2.25dbtp, samplePeak: -6.25dbfs, range: 7) { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  const detached = Object.values(ir.nodes).find((node) => node.op === "cut.audio.meter" && node.inputs.target.kind === "quantity" && node.inputs.target.magnitude.numerator === "-10");
  assert.ok(detached);
  ir.compositions[0].items = ir.compositions[0].items.filter((item) => item.kind !== "node" || item.id !== detached.id);
  ir.compositions[0].rootAudioIds = ir.compositions[0].rootAudioIds.filter((id) => id !== detached.id);
  assert.deepEqual(deriveReferenceMasteringTarget(ir, ir.compositions[0]), { integratedLufs: -16, truePeakDbtp: -2.25, samplePeakDbfs: -6.25, loudnessRangeLu: 7 });
});

test("conflicting reachable Meter targets are rejected instead of silently choosing", () => {
  const ir = compile('cut 0.4; project "conflict"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { Meter(target: -14lufs) { Tone(frequency: 440hz, duration: 1s); } Meter(target: -16lufs) { Tone(frequency: 220hz, duration: 1s); } } export out = render(main);');
  assert.throws(() => deriveReferenceMasteringTarget(ir, ir.compositions[0]), /Conflicting master Meter targets/);
});

test("samplePeak has an independent default, bounded dBFS contract, and participates in reachable Meter conflicts", () => {
  const atFloor = compile('cut 0.4; project "sample floor"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { Meter(samplePeak: -24dbfs) { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  const meter = Object.values(atFloor.nodes).find((node) => node.op === "cut.audio.meter");
  assert.ok(meter?.inputs.samplePeak?.kind === "quantity");
  assert.deepEqual(meter.inputs.samplePeak, { kind: "quantity", dimension: "sample-peak", magnitude: { numerator: "-24", denominator: "1" }, unit: "dbfs" });
  assert.equal(deriveReferenceMasteringTarget(atFloor, atFloor.compositions[0]).samplePeakDbfs, -24);
  const atCeiling = compile('cut 0.4; project "sample ceiling"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { Meter(samplePeak: 0dbfs) { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  assert.equal(deriveReferenceMasteringTarget(atCeiling, atCeiling.compositions[0]).samplePeakDbfs, 0);
  for (const value of ["-24.01dbfs", "0.01dbfs"]) {
    const ir = compile(`cut 0.4; project "sample bound"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { Meter(samplePeak: ${value}) { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);`);
    assert.throws(
      () => deriveReferenceMasteringTarget(ir, ir.compositions[0]),
      /Master Meter at project\.cut:1:\d+ samplePeak must be between -24 and 0 dBFS\./,
    );
  }
  const conflict = compile('cut 0.4; project "sample conflict"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { Meter(samplePeak: -3dbfs) { Tone(frequency: 440hz, duration: 1s); } Meter(samplePeak: -6dbfs) { Tone(frequency: 220hz, duration: 1s); } } export out = render(main);');
  assert.throws(() => deriveReferenceMasteringTarget(conflict, conflict.compositions[0]), /Conflicting master Meter targets at project\.cut:1:\d+ and project\.cut:1:\d+/);

  const wrong = parseCutLanguage('cut 0.4; project "wrong sample unit"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { Meter(samplePeak: -1dbtp) { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  assert.ok(wrong.module, JSON.stringify(wrong.diagnostics));
  assert.throws(
    () => compileCutModule(wrong.module!),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === "CUT2029" && /samplePeak.*SamplePeak.*TruePeak/.test(item.message)),
  );
});

test("reference export passes the authored Meter target into normalization", { timeout: 30_000 }, async () => {
  const ir = compile('cut 0.4; project "render target"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 3s, fps: 24, width: 320px, height: 180px) { scene only(duration: 3s) { Meter(target: -20lufs, truePeak: -2.5dbtp, range: 7) { Tone(frequency: 440hz, duration: 3s, amplitude: 5%); } } } export out = render(main);');
  const directory = await mkdtemp(resolve(tmpdir(), "cut-mastering-target-"));
  const output = resolve(directory, "mastered.mp4"); const manifest = await renderReferenceIr(ir, directory, output);
  assert.equal(manifest.version, 11);
  assert.equal(manifest.audio.samplePeak.thresholdDbfs, 0);
  assert.equal(manifest.audio.samplePeak.observedFrames, 144_000);
  assert.deepEqual(manifest.audio.loudness.target, { integratedLufs: -20, truePeakDbtp: -2.5, loudnessRangeLu: 7 });
  assert.deepEqual(manifest.audio.delivery.target, manifest.audio.loudness.target);
  assert.equal(manifest.audio.delivery.format, "cut-reference-aac-delivery");
  assert.equal(manifest.audio.delivery.version, 2);
  assert.deepEqual(manifest.audio.delivery.toolchain, manifest.cache.audio.identity.toolchain);
  assert.match(manifest.audio.delivery.toolchain.integrity, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.audio.delivery.normalizedPcm.truePeak.sampleRate, 48_000);
  assert.equal(manifest.audio.delivery.normalizedPcm.truePeak.expectedFrames, 144_000);
  assert.equal(manifest.audio.delivery.passes.at(-1)?.cutTruePeakCompliant, true);
  assert.notEqual(manifest.audio.delivery.passes.at(-1)?.ffmpegTruePeakCompliant, false);
  assert.deepEqual(manifest.audio.delivery.codec, {
    name: "aac",
    implementation: "ffmpeg-native-aac",
    bitrate: 256_000,
    container: "mp4",
    movieTimescale: 48_000,
    primingFrames: 1_024,
  });
  assert.match(manifest.audio.delivery.normalizedPcm.authoredPcmSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.audio.delivery.passes.at(-1)!.encodedSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.audio.delivery.passes.at(-1)!.authoredPcmSha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.audio.delivery.truePeakCompliant, true, JSON.stringify(manifest.audio.delivery));
  assert.ok(manifest.audio.delivery.residuals.truePeakDb !== null && manifest.audio.delivery.residuals.truePeakDb <= 0, JSON.stringify(manifest.audio.delivery));
  const written = JSON.parse(await readFile(`${output}.manifest.json`, "utf8")) as typeof manifest;
  assert.deepEqual(written.audio.delivery, manifest.audio.delivery);
  const measured = await measureReferenceAudio(output, -20, -2.5, 7);
  assert.ok(measured.truePeakDbtp !== null && measured.truePeakDbtp <= -2.5, JSON.stringify(measured));
});

test("final render refuses an over-range pre-master mix before replacing output and accepts downstream attenuation", { timeout: 60_000 }, async () => {
  const program = (body: string) => `cut 0.4;
project "sample peak publication gate";
import { Gain, Meter, Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 10, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { Meter(samplePeak: 0dbfs) { ${body} } }
}
export out = render(main);`;
  const clipped = compile(program("Tone(frequency: 1khz, duration: 1s, amplitude: 90%); Tone(frequency: 1khz, duration: 1s, amplitude: 90%);"));
  const clippedRoot = await mkdtemp(resolve(tmpdir(), "cut-mastering-clipped-"));
  const existingOutput = resolve(clippedRoot, "existing.mp4"), existingManifest = `${existingOutput}.manifest.json`;
  await writeFile(existingOutput, "existing-output");
  await writeFile(existingManifest, "existing-manifest");
  await assert.rejects(renderReferenceIr(clipped, clippedRoot, existingOutput), (error) => {
    assert.ok(error instanceof ReferenceAudioPeakError, String(error));
    assert.equal(error.code, "CUT_AUDIO_CLIPPING");
    assert.equal(error.detail.thresholdDbfs, 0);
    assert.equal(error.source.nodeId, Object.values(clipped.nodes).find((node) => node.op === "cut.audio.meter")?.id);
    return true;
  });
  assert.equal(await readFile(existingOutput, "utf8"), "existing-output");
  assert.equal(await readFile(existingManifest, "utf8"), "existing-manifest");

  const controlled = compile(program("Gain(amount: -6db) { Tone(frequency: 1khz, duration: 1s, amplitude: 90%); Tone(frequency: 1khz, duration: 1s, amplitude: 90%); }"));
  const controlledRoot = await mkdtemp(resolve(tmpdir(), "cut-mastering-controlled-"));
  const controlledOutput = resolve(controlledRoot, "controlled.mp4");
  const manifest = await renderReferenceIr(controlled, controlledRoot, controlledOutput);
  assert.equal(manifest.audio.samplePeak.thresholdDbfs, 0);
  assert.ok(manifest.audio.samplePeak.peakLinear > 0.6 && manifest.audio.samplePeak.peakLinear < 0.7, JSON.stringify(manifest.audio.samplePeak));
  assert.equal(manifest.cache.audio.artifact.sampleFormat, "f32le");
  assert.deepEqual(manifest.audio.samplePeak, manifest.cache.audio.peak);
});

test("render rejects a non-conformant true-peak sample rate before creating delivery output", async () => {
  const ir = compile('cut 0.4; project "rate preflight"; import { Meter, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 44.1khz) { Meter(truePeak: -1dbtp) { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  const root = await mkdtemp(resolve(tmpdir(), "cut-mastering-rate-preflight-"));
  const output = resolve(root, "must-not-exist.mp4");
  try {
    await assert.rejects(
      renderReferenceIr(ir, root, output),
      (error) => error instanceof ReferenceAudioTruePeakError
        && error.code === "CUT_AUDIO_TRUE_PEAK_SAMPLE_RATE_UNSUPPORTED"
        && error.source.nodeId === Object.values(ir.nodes).find((node) => node.op === "cut.audio.meter")?.id,
    );
    await assert.rejects(() => readFile(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
