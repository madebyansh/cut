import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { builtinPackages } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { ReferenceAudioConfigError, referenceAudioNodeConfig } from "../lib/runtime/reference/audio-config";
import {
  ReferenceTimeStretchError,
  referenceTimeStretchLimits,
} from "../lib/runtime/reference/audio-time-stretch";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function program(body: string, duration = "1s", sampleRate = "48khz") {
  return `cut 0.4;
project "owned time stretch";
import { Bus, Noise, Pan, TimeStretch, Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: ${duration}, fps: 24, width: 64px, height: 64px, sampleRate: ${sampleRate}) {
  ${body}
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source: string) {
  const ir = compileCutModule(parse(source)).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function node(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(result, `missing ${op}`);
  return result;
}

type Pcm24 = {
  frames: number;
  data: Buffer<ArrayBufferLike>;
  sample(frame: number, channel: number): number;
};

function pcm24(buffer: Buffer): Pcm24 {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0;
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      blockAlign = buffer.readUInt16LE(body + 12);
      bits = buffer.readUInt16LE(body + 14);
    }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.deepEqual({ channels, sampleRate, blockAlign, bits }, { channels: 2, sampleRate: 48_000, blockAlign: 6, bits: 24 });
  return {
    frames: data.length / blockAlign,
    data,
    sample(frame: number, channel: number) {
      const position = frame * blockAlign + channel * 3;
      let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

async function render(source: string, root: string, name: string) {
  const ir = compile(source), output = resolve(root, name);
  validateReferenceSession(ir);
  await renderReferenceAudio(ir, ir.compositions[0], root, output);
  return { ir, pcm: pcm24(await readFile(output)) };
}

function rms(pcm: Pcm24, start: number, end: number, channel = 0) {
  let energy = 0;
  for (let frame = start; frame < end; frame += 1) energy += pcm.sample(frame, channel) ** 2;
  return Math.sqrt(energy / Math.max(1, end - start));
}

function dominantFrequency(pcm: Pcm24, start: number, end: number, channel: number, minimum = 200, maximum = 1_200) {
  let bestFrequency = minimum, bestPower = -Infinity;
  const samples = end - start;
  for (let frequency = minimum; frequency <= maximum; frequency += 1) {
    const omega = 2 * Math.PI * frequency / 48_000, coefficient = 2 * Math.cos(omega);
    let previous = 0, previousTwo = 0;
    for (let frame = start; frame < end; frame += 1) {
      const current = pcm.sample(frame, channel) + coefficient * previous - previousTwo;
      previousTwo = previous;
      previous = current;
    }
    const power = previousTwo ** 2 + previous ** 2 - coefficient * previous * previousTwo;
    if (power > bestPower) { bestPower = power; bestFrequency = frequency; }
  }
  assert.ok(samples > 0 && Number.isFinite(bestPower));
  return bestFrequency;
}

function assertStretchError(source: string, code: ReferenceTimeStretchError["code"], message: RegExp) {
  const ir = compile(source);
  assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
    assert.ok(error instanceof ReferenceTimeStretchError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.equal(error.source.module, "project.cut");
    assert.ok(error.source.line > 0 && error.source.column > 0);
    assert.equal(error.source.nodeId, error.nodeId);
    assert.deepEqual(cutDiagnosticsFromError(error), [{
      code,
      severity: "error",
      message: error.message.slice(`${code}: `.length),
      source: error.source,
    }]);
    return true;
  });
}

test("TimeStretch lowers to one closed typed audio node and an exact bounded DSP plan", () => {
  const ir = compile(program(`TimeStretch(sourceDuration: 200ms, duration: 400ms, pitch: 7, quality: "draft") {
    Tone(frequency: 440hz, duration: 200ms, amplitude: 50%);
  }`));
  const stretch = node(ir, "cut.audio.time_stretch");
  assert.deepEqual(Object.keys(stretch.inputs).sort(), ["duration", "pitch", "quality", "sourceDuration"]);
  assert.deepEqual(stretch.properties, {});
  assert.equal(stretch.children.length, 1);
  const config = referenceAudioNodeConfig(ir, ir.compositions[0], stretch);
  assert.equal(config?.kind, "time-stretch");
  if (config?.kind === "time-stretch") {
    assert.deepEqual({ source: config.sourceSamples, destination: config.destinationSamples, placement: config.placementSamples }, { source: 9_600, destination: 19_200, placement: 0 });
    assert.equal(config.pitchSemitones, 7);
    assert.equal(config.quality, "draft");
    assert.deepEqual({ window: config.windowSize, hop: config.analysisHop }, { window: 512, hop: 128 });
    assert.equal(config.intermediateSamples, Math.floor(19_200 * 2 ** (7 / 12) + .5));
  }
  assert.doesNotThrow(() => validateReferenceSession(ir));

  const symbol = builtinPackages.get("@cut/audio")?.symbols.TimeStretch;
  assert.equal(symbol?.native, "cut.audio.time_stretch");
  assert.deepEqual(symbol?.parameters?.map(({ name, type }) => [name, type]), [["sourceDuration", "Time"], ["duration", "Time"], ["pitch", "Number"], ["quality", "String"]]);
  const kernel = referenceKernelSchema("cut.audio.time_stretch");
  assert.equal(kernel?.support, "supported");
  if (kernel?.support === "supported") {
    assert.deepEqual(kernel.inputs, ["sourceDuration", "duration", "pitch", "quality"]);
    assert.deepEqual(kernel.properties, []);
    assert.equal(kernel.minimumChildren, 1);
    assert.equal(kernel.maximumChildren, 1);
  }

  const defaults = compile(program(`TimeStretch(sourceDuration: 200ms, duration: 400ms) { Tone(frequency: 440hz, duration: 200ms); }`));
  const defaultConfig = referenceAudioNodeConfig(defaults, defaults.compositions[0], node(defaults, "cut.audio.time_stretch"));
  assert.equal(defaultConfig?.kind, "time-stretch");
  if (defaultConfig?.kind === "time-stretch") {
    assert.equal(defaultConfig.pitchSemitones, 0);
    assert.equal(defaultConfig.quality, "balanced");
  }
});

test("TimeStretch is static-only and source syntax fails closed on unknown arguments, types, enums, and child cardinality", () => {
  const animated = checkCutModule(parse(program(`TimeStretch(sourceDuration: 200ms, duration: 400ms) as stretch { Tone(frequency: 440hz, duration: 200ms); }
    set stretch.pitch = 4;`))).diagnostics;
  assert.ok(animated.some((diagnostic) => diagnostic.code === "CUT2060" && /time_stretch.*pitch/.test(diagnostic.message)), JSON.stringify(animated));

  const unknown = checkCutModule(parse(program(`TimeStretch(sourceDuration: 200ms, duration: 400ms, preserveFormants: true) { Tone(frequency: 440hz, duration: 200ms); }`))).diagnostics;
  assert.ok(unknown.some((diagnostic) => diagnostic.code === "CUT2059" && /preserveFormants/.test(diagnostic.message)), JSON.stringify(unknown));

  for (const [body, expected] of [
    [`TimeStretch(sourceDuration: 50%, duration: 400ms) { Tone(frequency: 440hz, duration: 200ms); }`, /expects Time, found Ratio/],
    [`TimeStretch(sourceDuration: 200ms, duration: 50%) { Tone(frequency: 440hz, duration: 200ms); }`, /expects Time, found Ratio/],
    [`TimeStretch(sourceDuration: 200ms, duration: 400ms, pitch: 50%) { Tone(frequency: 440hz, duration: 200ms); }`, /expects Number, found Ratio/],
    [`TimeStretch(sourceDuration: 200ms, duration: 400ms, quality: 1) { Tone(frequency: 440hz, duration: 200ms); }`, /expects String, found Number/],
  ] as const) {
    const diagnostics = checkCutModule(parse(program(body))).diagnostics;
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "CUT2029" && expected.test(diagnostic.message)), JSON.stringify(diagnostics));
  }

  const unsupportedQuality = checkCutModule(parse(program(`TimeStretch(sourceDuration: 200ms, duration: 400ms, quality: "studio") { Tone(frequency: 440hz, duration: 200ms); }`))).diagnostics;
  assert.ok(unsupportedQuality.some((diagnostic) => diagnostic.code === "CUT2068" && /draft, balanced/.test(diagnostic.message)), JSON.stringify(unsupportedQuality));

  for (const [body, code, message] of [
    [`TimeStretch(sourceDuration: 200ms, duration: 400ms);`, "CUT2085", /requires exactly one audio child; found 0/],
    [`TimeStretch(sourceDuration: 200ms, duration: 400ms) { Tone(frequency: 440hz, duration: 200ms); Tone(frequency: 660hz, duration: 200ms); }`, "CUT2085", /requires exactly one audio child; found 2/],
  ] as const) assert.throws(() => compile(program(body)), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === code);
    assert.ok(diagnostic);
    assert.match(diagnostic.message, message);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    return true;
  });
});

test("TimeStretch renders exact destination samples and exact silence boundaries", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-time-stretch-boundary-"));
  const stretched = await render(program(`at 100ms {
    TimeStretch(sourceDuration: 200ms, duration: 400ms, pitch: 0, quality: "draft") {
      Tone(frequency: 440hz, duration: 200ms, amplitude: 50%);
    }
  }`), root, "stretched.wav");
  assert.equal(stretched.pcm.frames, 48_000);
  assert.equal(rms(stretched.pcm, 0, 4_800), 0, "processor leaked before exact destination placement");
  assert.ok(rms(stretched.pcm, 7_200, 21_600) > .1, "stretched destination is unexpectedly silent");
  assert.equal(rms(stretched.pcm, 24_000, 48_000), 0, "processor leaked beyond its exact 400 ms destination");
});

test("duration and pitch are independent: time stretch preserves pitch and pitch shift preserves exact duration", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-time-stretch-frequency-"));
  const stretched = await render(program(`TimeStretch(sourceDuration: 200ms, duration: 400ms, pitch: 0, quality: "draft") {
    Tone(frequency: 440hz, duration: 200ms, amplitude: 50%);
  }`), root, "duration.wav");
  const pitched = await render(program(`TimeStretch(sourceDuration: 300ms, duration: 300ms, pitch: 12, quality: "draft") {
    Tone(frequency: 440hz, duration: 300ms, amplitude: 50%);
  }`), root, "pitch.wav");
  assert.equal(stretched.pcm.frames, 48_000);
  assert.equal(pitched.pcm.frames, 48_000);
  const stretchedPeak = dominantFrequency(stretched.pcm, 4_800, 14_400, 0);
  const pitchedPeak = dominantFrequency(pitched.pcm, 2_400, 12_000, 0);
  assert.ok(Math.abs(stretchedPeak - 440) <= 3, `2x duration moved 440 Hz to ${stretchedPeak} Hz`);
  assert.ok(Math.abs(pitchedPeak - 880) <= 5, `+12 semitones moved 440 Hz to ${pitchedPeak} Hz`);
});

test("TimeStretch preserves independent stereo channel evidence", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-time-stretch-stereo-"));
  const rendered = await render(program(`TimeStretch(sourceDuration: 300ms, duration: 450ms, pitch: 0, quality: "draft") {
    Bus(name: "stereo evidence") {
      Pan(position: -100%) { Tone(frequency: 440hz, duration: 300ms, amplitude: 12%); }
      Pan(position: 100%) { Tone(frequency: 660hz, duration: 300ms, amplitude: 12%); }
    }
  }`), root, "stereo.wav");
  const left = dominantFrequency(rendered.pcm, 4_800, 16_800, 0);
  const right = dominantFrequency(rendered.pcm, 4_800, 16_800, 1);
  assert.ok(Math.abs(left - 440) <= 3, `left channel collapsed or moved: ${left} Hz`);
  assert.ok(Math.abs(right - 660) <= 3, `right channel collapsed or moved: ${right} Hz`);
  assert.ok(rms(rendered.pcm, 4_800, 16_800, 0) > .05);
  assert.ok(rms(rendered.pcm, 4_800, 16_800, 1) > .05);
});

test("identity is decoded-PCM exact, repeated processing is deterministic, and authored controls stay in cache identity", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-time-stretch-determinism-"));
  const tone = `Tone(frequency: 440hz, duration: 300ms, amplitude: 10%);`;
  const dry = await render(program(tone), root, "dry.wav");
  const identitySource = program(`TimeStretch(sourceDuration: 300ms, duration: 300ms, pitch: 0) { ${tone} }`);
  const identity = await render(identitySource, root, "identity.wav");
  const repeated = await render(identitySource, root, "identity-repeat.wav");
  assert.deepEqual(identity.pcm.data, dry.pcm.data, "identity path changed decoded PCM");
  assert.equal(createHash("sha256").update(identity.pcm.data).digest("hex"), createHash("sha256").update(repeated.pcm.data).digest("hex"));

  const a = node(compile(program(`TimeStretch(sourceDuration: 300ms, duration: 450ms, pitch: 0, quality: "draft") { ${tone} }`)), "cut.audio.time_stretch");
  const b = node(compile(program(`TimeStretch(sourceDuration: 300ms, duration: 450ms, pitch: 3, quality: "draft") { ${tone} }`)), "cut.audio.time_stretch");
  const c = node(compile(program(`TimeStretch(sourceDuration: 300ms, duration: 450ms, pitch: 0, quality: "balanced") { ${tone} }`)), "cut.audio.time_stretch");
  assert.notEqual(a.contentHash, b.contentHash);
  assert.notEqual(a.contentHash, c.contentHash);

  const draft = await render(program(`TimeStretch(sourceDuration: 300ms, duration: 450ms, pitch: 0, quality: "draft") { ${tone} }`), root, "draft.wav");
  const balanced = await render(program(`TimeStretch(sourceDuration: 300ms, duration: 450ms, pitch: 0, quality: "balanced") { ${tone} }`), root, "balanced.wav");
  const shorterSource = await render(program(`TimeStretch(sourceDuration: 225ms, duration: 450ms, pitch: 0, quality: "draft") { ${tone} }`), root, "short-source.wav");
  assert.notDeepEqual(draft.pcm.data, balanced.pcm.data, "quality was accepted but did not change the processing kernel");
  assert.notDeepEqual(draft.pcm.data, shorterSource.pcm.data, "sourceDuration was accepted but did not change source selection and processing");
});

test("TimeStretch refuses off-grid, out-of-range, nested, hostile, and over-budget plans with stable diagnostics", () => {
  for (const [source, code, message] of [
    [program(`TimeStretch(sourceDuration: 0.1ms, duration: 100ms, quality: "draft") { Tone(frequency: 440hz, duration: 100ms); }`), "CUT_AUDIO_TIME_STRETCH_SAMPLE_GRID", /sourceDuration does not land/],
    [program(`TimeStretch(sourceDuration: 100ms, duration: 300ms, quality: "draft") { Tone(frequency: 440hz, duration: 100ms); }`), "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", /ratio must stay between 0.5 and 2/],
    [program(`TimeStretch(sourceDuration: 200ms, duration: 200ms, pitch: 13, quality: "draft") { Tone(frequency: 440hz, duration: 200ms); }`), "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", /between -12 and \+12/],
    [program(`TimeStretch(sourceDuration: 10ms, duration: 10ms, pitch: 1, quality: "draft") { Tone(frequency: 440hz, duration: 10ms); }`), "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", /at least 2048 samples/],
    [program(`TimeStretch(sourceDuration: 200ms, duration: 200ms) { TimeStretch(sourceDuration: 100ms, duration: 100ms) { Tone(frequency: 440hz, duration: 100ms); } }`), "CUT_AUDIO_TIME_STRETCH_GRAPH", /cannot contain another TimeStretch/],
    [program(`TimeStretch(sourceDuration: 42s, duration: 42s) { Tone(frequency: 440hz, duration: 42s); }`, "42s"), "CUT_AUDIO_TIME_STRETCH_RESOURCE", /sourceDuration exceeds the 2000000-sample/],
  ] as const) assertStretchError(source, code, message);

  const hostile = compile(program(`TimeStretch(sourceDuration: 200ms, duration: 200ms) { Tone(frequency: 440hz, duration: 200ms); }`));
  node(hostile, "cut.audio.time_stretch").inputs.pitch = { kind: "string", value: "up" };
  assert.throws(() => validateReferenceSession(hostile), (error: unknown) => error instanceof ReferenceTimeStretchError && error.code === "CUT_AUDIO_TIME_STRETCH_TYPE");

  const hostilePlacement = compile(program(`TimeStretch(sourceDuration: 200ms, duration: 200ms) { Tone(frequency: 440hz, duration: 200ms); }`));
  const moved = node(hostilePlacement, "cut.audio.time_stretch");
  moved.interval.start = rational(1, 10_000);
  moved.interval.duration = rational(9_999, 10_000);
  assert.throws(() => validateReferenceSession(hostilePlacement), (error: unknown) => error instanceof ReferenceTimeStretchError && error.code === "CUT_AUDIO_TIME_STRETCH_SAMPLE_GRID" && /destination placement/.test(error.message));

  const publicPlacement = compile(program(`at 0.1ms { TimeStretch(sourceDuration: 100ms, duration: 100ms) { Tone(frequency: 440hz, duration: 100ms); } }`));
  assert.throws(() => validateReferenceSession(publicPlacement), (error: unknown) => error instanceof ReferenceAudioConfigError && error.code === "CUT_AUDIO_SAMPLE_GRID" && "line" in error.source && error.source.line > 0);

  const many = Array.from({ length: referenceTimeStretchLimits.maximumNodesPerComposition + 1 }, (_, index) => `TimeStretch(sourceDuration: 100ms, duration: 100ms) { Tone(frequency: ${440 + index}hz, duration: 100ms); }`).join("\n");
  assertStretchError(program(many), "CUT_AUDIO_TIME_STRETCH_RESOURCE", /contains 9 TimeStretch nodes; maximum is 8/);

  const excessiveOutput = Array.from({ length: 5 }, (_, index) => `TimeStretch(sourceDuration: 225s, duration: 225s) { Tone(frequency: ${440 + index}hz, duration: 225s); }`).join("\n");
  assertStretchError(program(excessiveOutput, "225s", "8khz"), "CUT_AUDIO_TIME_STRETCH_RESOURCE", /graph requires 9000000 destination samples; maximum is 8000000/);

  const excessiveFft = Array.from({ length: 2 }, (_, index) => `TimeStretch(sourceDuration: 225s, duration: 225s, pitch: 1, quality: "balanced") { Tone(frequency: ${440 + index}hz, duration: 225s); }`).join("\n");
  assertStretchError(program(excessiveFft, "225s", "8khz"), "CUT_AUDIO_TIME_STRETCH_RESOURCE", /graph requires .* FFT work units; maximum is 400000000/);
});

function cacheFixture(pitch: number) {
  return compile(program(`scene only(duration: 1s) {
    Rect(width: 64px, height: 64px, fill: #123456);
    TimeStretch(sourceDuration: 300ms, duration: 450ms, pitch: ${pitch}, quality: "draft") { Tone(frequency: 440hz, duration: 300ms); }
  }`));
}

test("TimeStretch audio edits invalidate its node while preserving unrelated picture scene keys", () => {
  const before = cacheFixture(0), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = cacheFixture(4), plan = createIncrementalRenderPlan(after, "main", previous), stretch = node(after, "cut.audio.time_stretch");
  assert.equal(plan.nodes.find((candidate) => candidate.id === stretch.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});
