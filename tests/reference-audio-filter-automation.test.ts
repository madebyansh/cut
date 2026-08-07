import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan, cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import {
  compileReferenceAudioAutomation,
  compileReferenceParametricEqAutomations,
  compileReferenceStateVariableFilterAutomations,
  ReferenceAudioAutomationError,
  referenceAudioAutomationLimits,
  validateReferenceAudioAutomationBudget,
} from "../lib/runtime/reference/audio-automation";
import {
  createReferenceStateVariableFilterState,
  processReferenceStateVariableFilterSample,
  referenceStateVariableFilterLimits,
} from "../lib/runtime/reference/audio-filter";
import {
  createReferenceParametricEqState,
  processReferenceParametricEqSample,
  referenceParametricEqLimits,
} from "../lib/runtime/reference/audio-parametric-eq";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function program(body: string, duration = "100ms", fps = 100, sampleRate = "48khz") {
  return `cut 0.4;
project "stateful filter automation";
import { Compressor, EQ, Gain, ParametricEQ, HighPass, LowPass, Noise, Pan, Reverb, Tone } from "@cut/audio";
import { linear, outCubic, spring } from "@cut/motion";
timeline main(duration: ${duration}, fps: ${fps}, width: 64px, height: 64px, sampleRate: ${sampleRate}) {
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
  return compileCutModule(parse(source)).ir;
}

function node(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(result, `missing ${op}`);
  return result;
}

type Pcm24 = {
  frames: number;
  bytes: Buffer<ArrayBufferLike>;
  sample(frame: number, channel: number): number;
};

function pcm24(buffer: Buffer, expectedSampleRate = 48_000): Pcm24 {
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
    if (id === "data") { bytes = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.deepEqual({ channels, sampleRate, blockAlign, bits }, { channels: 2, sampleRate: expectedSampleRate, blockAlign: 6, bits: 24 });
  return {
    frames: bytes.length / blockAlign,
    bytes,
    sample(frame: number, channel: number) {
      const position = frame * blockAlign + channel * 3;
      let value = bytes[position] | bytes[position + 1] << 8 | bytes[position + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

async function render(source: string, root: string, name: string, expectedSampleRate = 48_000) {
  const ir = compile(source); ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  const output = resolve(root, name);
  await renderReferenceAudio(ir, ir.compositions[0], root, output);
  return { ir, pcm: pcm24(await readFile(output), expectedSampleRate) };
}

function model(
  dry: Pcm24,
  kind: "highpass" | "lowpass",
  cutoff: (sample: number) => number,
  q: number | ((sample: number) => number) = 0.707,
) {
  const states = [createReferenceStateVariableFilterState(), createReferenceStateVariableFilterState()];
  const values = Array.from({ length: dry.frames }, () => [0, 0]);
  for (let frame = 0; frame < dry.frames; frame += 1) {
    for (const channel of [0, 1]) {
      values[frame][channel] = processReferenceStateVariableFilterSample(kind, dry.sample(frame, channel), cutoff(frame), typeof q === "number" ? q : q(frame), 48_000, states[channel]);
    }
  }
  return values;
}

function eqModel(
  dry: Pcm24,
  frequency: (sample: number) => number,
  gainDb: (sample: number) => number,
  q: (sample: number) => number,
  sampleRate = 48_000,
) {
  const states = [createReferenceParametricEqState(), createReferenceParametricEqState()];
  const values = Array.from({ length: dry.frames }, () => [0, 0]);
  for (let frame = 0; frame < dry.frames; frame += 1) {
    for (const channel of [0, 1]) {
      values[frame][channel] = processReferenceParametricEqSample(
        dry.sample(frame, channel),
        frequency(frame),
        gainDb(frame),
        q(frame),
        sampleRate,
        states[channel],
      );
    }
  }
  return values;
}

function rms(pcm: Pcm24, start: number, end: number, channel = 0) {
  let energy = 0;
  for (let frame = start; frame < end; frame += 1) energy += pcm.sample(frame, channel) ** 2;
  return Math.sqrt(energy / (end - start));
}

test("ParametricEQ and HighPass/LowPass controls are closed typed signal properties", () => {
  const source = program(`
    HighPass(frequency: 80hz) as high { Noise(duration: 100ms, color: "white", seed: 1); }
    LowPass(frequency: 12khz) as low { Noise(duration: 100ms, color: "white", seed: 2); }
    ParametricEQ(frequency: 1khz, gain: -3db, q: 0.8) as eq { Noise(duration: 100ms, color: "white", seed: 3); }
    animate high.frequency from 80hz to 8khz over 50ms ease linear;
    animate high.q from 0.5 to 4 over 50ms ease outCubic;
    animate low.frequency from 12khz to 400hz over 50ms ease outCubic;
    animate low.q from 4 to 0.5 over 50ms ease linear;
    animate eq.frequency from 1khz to 4khz over 50ms ease linear;
    animate eq.gain from -3db to 9db over 50ms ease outCubic;
    animate eq.q from 0.8 to 3 over 50ms ease linear;
  `);
  const ir = compile(source), high = node(ir, "cut.audio.highpass"), low = node(ir, "cut.audio.lowpass"), eq = node(ir, "cut.audio.eq");
  assert.ok("signal" in high.properties.frequency && "signal" in high.properties.q);
  assert.ok("signal" in low.properties.frequency && "signal" in low.properties.q);
  assert.ok("signal" in eq.properties.frequency && "signal" in eq.properties.gain && "signal" in eq.properties.q);
  for (const [target, property, valueType] of [
    [high, "frequency", "Frequency"], [high, "q", "Number"], [low, "frequency", "Frequency"], [low, "q", "Number"],
    [eq, "frequency", "Frequency"], [eq, "gain", "Gain"], [eq, "q", "Number"],
  ] as const) {
    const reference = target.properties[property];
    assert.ok("signal" in reference);
    if ("signal" in reference) assert.equal(ir.signals[reference.signal].valueType, valueType);
  }
  assert.equal(compileReferenceAudioAutomation(ir, ir.compositions[0], high)?.property, "frequency");
  assert.equal(compileReferenceStateVariableFilterAutomations(ir, ir.compositions[0], low).q?.eventCount, 1);
  assert.deepEqual(Object.keys(compileReferenceParametricEqAutomations(ir, ir.compositions[0], eq)).sort(), ["frequency", "gain", "q"]);
  ir.determinism.semantic = "locked";
  assert.doesNotThrow(() => validateReferenceSession(ir));
  assert.deepEqual(referenceAudioAutomationLimits.properties, [
    "Gain.amount",
    "Send.amount",
    "Pan.position",
    "Reverb.wet",
    "Delay.wet",
    "HighPass.frequency",
    "HighPass.q",
    "LowPass.frequency",
    "LowPass.q",
    "ParametricEQ.frequency",
    "ParametricEQ.gain",
    "ParametricEQ.q",
    "Compressor.threshold",
    "Compressor.ratio",
    "Compressor.attack",
    "Compressor.release",
    "Compressor.makeup",
    "Limiter.ceiling",
    "Limiter.release",
    "DeEsser.intensity",
    "DeEsser.amount",
    "Sidechain.amount",
    "Sidechain.threshold",
    "Sidechain.attack",
    "Sidechain.release",
  ]);
});

test("static EQ/filter controls and equivalent sample-zero properties are PCM-identical", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-filter-parity-"));
  for (const kind of ["HighPass", "LowPass"] as const) {
    const plain = await render(program(`${kind}(frequency: 1200hz, q: 0.707) { Noise(duration: 100ms, color: "white", seed: 11, amplitude: 20%); }`), root, `${kind}-plain.wav`);
    const property = await render(program(`${kind}(frequency: 1200hz, q: 0.707) as filter { Noise(duration: 100ms, color: "white", seed: 11, amplitude: 20%); } set filter.frequency = 1200hz; set filter.q = 0.707;`), root, `${kind}-property.wav`);
    assert.deepEqual(property.pcm.bytes, plain.pcm.bytes, kind);
  }
  const source = 'Noise(duration: 100ms, color: "white", seed: 12, amplitude: 20%);';
  const plain = await render(program(`ParametricEQ(frequency: 1200hz, gain: 6db, q: 1.25) { ${source} }`), root, "eq-plain.wav");
  const alias = await render(program(`EQ(frequency: 1200hz, gain: 6db, q: 1.25) { ${source} }`), root, "eq-alias.wav");
  const property = await render(program(`ParametricEQ(frequency: 1200hz, gain: 6db, q: 1.25) as eq { ${source} } set eq.frequency = 1200hz; set eq.gain = 6db; set eq.q = 1.25;`), root, "eq-property.wav");
  assert.deepEqual(alias.pcm.bytes, plain.pcm.bytes, "EQ compatibility spelling drifted");
  assert.deepEqual(property.pcm.bytes, plain.pcm.bytes, "constant ParametricEQ properties changed PCM");
});

test("ParametricEQ 0 dB is exact bypass and authored center gain is independently measurable", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-eq-response-"));
  const tone = 'Tone(frequency: 1khz, duration: 100ms, amplitude: 5%);';
  const dry = await render(program(tone), root, "dry.wav");
  const bypass = await render(program(`ParametricEQ(gain: 0db) { ${tone} }`), root, "bypass.wav");
  assert.deepEqual(bypass.pcm.bytes, dry.pcm.bytes, "0 dB bell must be a decoded-byte bypass");
  for (const gainDb of [-6, 6]) {
    const filtered = await render(program(`ParametricEQ(frequency: 1khz, gain: ${gainDb}db, q: 1) { ${tone} }`), root, `${gainDb}.wav`);
    const measured = rms(filtered.pcm, 2_400, 4_800) / rms(dry.pcm, 2_400, 4_800);
    const expected = 10 ** (gainDb / 20);
    assert.ok(Math.abs(measured - expected) < 0.002, `${gainDb} dB center response ${measured} versus ${expected}`);
  }
});

test("simultaneous cutoff/Q sets change the exact sample without resetting either filter integrator", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-filter-event-")), eventSample = 2_400;
  const source = 'Noise(duration: 100ms, color: "white", seed: 23, amplitude: 30%);';
  const dry = await render(program(source), root, "dry.wav");
  const high = await render(program(`LowPass(frequency: 12khz, q: 0.707) { ${source} }`), root, "high.wav");
  const dynamic = await render(program(`LowPass(frequency: 12khz, q: 0.707) as filter { ${source} } at 50ms { set filter.frequency = 300hz; set filter.q = 5; }`), root, "dynamic.wav");
  assert.deepEqual(dynamic.pcm.bytes.subarray(0, eventSample * 6), high.pcm.bytes.subarray(0, eventSample * 6));
  assert.ok(Math.abs(dynamic.pcm.sample(eventSample, 0) - high.pcm.sample(eventSample, 0)) > 1e-4, "the event sample still used the old cutoff");

  const continuous = model(
    dry.pcm,
    "lowpass",
    (sample) => sample < eventSample ? 12_000 : 300,
    (sample) => sample < eventSample ? 0.707 : 5,
  );
  for (const frame of [eventSample, eventSample + 1, eventSample + 17, eventSample + 200]) {
    for (const channel of [0, 1]) {
      assert.ok(Math.abs(dynamic.pcm.sample(frame, channel) - continuous[frame][channel]) < 3e-5, `continuous model mismatch at ${frame}:${channel}`);
    }
  }
  const resetState = createReferenceStateVariableFilterState();
  const resetEvent = processReferenceStateVariableFilterSample("lowpass", dry.pcm.sample(eventSample, 0), 300, 5, 48_000, resetState);
  const actualEvent = dynamic.pcm.sample(eventSample, 0);
  assert.ok(Math.abs(actualEvent - continuous[eventSample][0]) < Math.abs(actualEvent - resetEvent) / 20, `${actualEvent} continuous=${continuous[eventSample][0]} reset=${resetEvent}`);
  const openBand = rms(dynamic.pcm, 480, 1_920), closedBand = rms(dynamic.pcm, 3_360, 4_800);
  assert.ok(closedBand < openBand * 0.4, `cutoff event did not materially change subsequent wideband response: ${openBand} -> ${closedBand}`);
});

test("linear and outCubic cutoff/Q sweeps share the exact sample clock and continuous scalar state", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-filter-curves-")), end = 3_840;
  const dry = await render(program('Noise(duration: 100ms, color: "white", seed: 31, amplitude: 20%);'), root, "dry.wav");
  for (const kind of ["HighPass", "LowPass"] as const) {
    for (const curve of ["linear", "outCubic"] as const) {
      const filtered = await render(program(`${kind}(frequency: 200hz, q: 0.5) as sweep { Noise(duration: 100ms, color: "white", seed: 31, amplitude: 20%); } animate sweep.frequency from 200hz to 12khz over 80ms ease ${curve}; animate sweep.q from 0.5 to 5 over 80ms ease ${curve};`), root, `${kind}-${curve}.wav`);
      const cutoff = (sample: number) => {
        if (sample >= end) return 12_000;
        const progress = sample / end, eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
        return 200 + (12_000 - 200) * eased;
      };
      const q = (sample: number) => {
        if (sample >= end) return 5;
        const progress = sample / end, eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
        return 0.5 + (5 - 0.5) * eased;
      };
      const expected = model(dry.pcm, kind === "LowPass" ? "lowpass" : "highpass", cutoff, q);
      for (const frame of [0, 1, 127, 2_400, end - 1, end, 4_200]) {
        for (const channel of [0, 1]) assert.ok(Math.abs(filtered.pcm.sample(frame, channel) - expected[frame][channel]) < 4e-5, `${kind} ${curve} ${frame}:${channel}`);
      }
    }
  }
});

test("ParametricEQ changes frequency/gain/Q on the exact event sample without resetting its two integrators", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-eq-event-")), eventSample = 2_400;
  const source = 'Pan(position: -100%) { Tone(frequency: 330hz, duration: 100ms, amplitude: 8%); } Pan(position: 100%) { Tone(frequency: 2400hz, duration: 100ms, amplitude: 8%); }';
  const dry = await render(program(source), root, "dry.wav");
  const baseline = await render(program(`ParametricEQ(frequency: 800hz, gain: -6db, q: 0.8) { ${source} }`), root, "baseline.wav");
  const dynamic = await render(program(`ParametricEQ(frequency: 800hz, gain: -6db, q: 0.8) as eq { ${source} } at 50ms { set eq.frequency = 4200hz; set eq.gain = 6db; set eq.q = 2.5; }`), root, "dynamic.wav");
  assert.deepEqual(dynamic.pcm.bytes.subarray(0, eventSample * 6), baseline.pcm.bytes.subarray(0, eventSample * 6));
  assert.ok(Math.abs(dynamic.pcm.sample(eventSample, 0) - baseline.pcm.sample(eventSample, 0)) > 1e-5, "event sample retained old EQ coefficients");

  const expected = eqModel(
    dry.pcm,
    (sample) => sample < eventSample ? 800 : 4_200,
    (sample) => sample < eventSample ? -6 : 6,
    (sample) => sample < eventSample ? 0.8 : 2.5,
  );
  for (const frame of [eventSample, eventSample + 1, eventSample + 19, eventSample + 300]) {
    for (const channel of [0, 1]) {
      assert.ok(Math.abs(dynamic.pcm.sample(frame, channel) - expected[frame][channel]) < 5e-5, `ParametricEQ recurrence mismatch at ${frame}:${channel}`);
    }
  }
  const reset = createReferenceParametricEqState();
  const resetEvent = processReferenceParametricEqSample(dry.pcm.sample(eventSample, 0), 4_200, 6, 2.5, 48_000, reset);
  const actualEvent = dynamic.pcm.sample(eventSample, 0), continuousEvent = expected[eventSample][0];
  assert.ok(Math.abs(actualEvent - continuousEvent) < Math.abs(actualEvent - resetEvent) / 20, `${actualEvent} continuous=${continuousEvent} reset=${resetEvent}`);
  assert.notEqual(dry.pcm.sample(137, 0), dry.pcm.sample(137, 1), "stereo fixture is not asymmetric");
});

test("ParametricEQ linear/outCubic multi-property automation matches independent stereo scalar recurrences", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-eq-curves-")), end = 3_840;
  const source = 'Pan(position: -100%) { Tone(frequency: 440hz, duration: 100ms, amplitude: 6%); } Pan(position: 100%) { Tone(frequency: 3200hz, duration: 100ms, amplitude: 6%); }';
  const dry = await render(program(source), root, "dry.wav");
  for (const curve of ["linear", "outCubic"] as const) {
    const filtered = await render(program(`ParametricEQ(frequency: 500hz, gain: -6db, q: 0.5) as eq { ${source} } animate eq.frequency from 500hz to 5khz over 80ms ease ${curve}; animate eq.gain from -6db to 6db over 80ms ease ${curve}; animate eq.q from 0.5 to 4 over 80ms ease ${curve};`), root, `eq-${curve}.wav`);
    const progress = (sample: number) => {
      if (sample >= end) return 1;
      const linear = sample / end;
      return curve === "linear" ? linear : 1 - (1 - linear) ** 3;
    };
    const expected = eqModel(
      dry.pcm,
      (sample) => 500 + (5_000 - 500) * progress(sample),
      (sample) => -6 + 12 * progress(sample),
      (sample) => 0.5 + 3.5 * progress(sample),
    );
    for (const frame of [0, 1, 137, 2_399, end - 1, end, 4_200]) {
      for (const channel of [0, 1]) {
        assert.ok(Math.abs(filtered.pcm.sample(frame, channel) - expected[frame][channel]) < 6e-5, `${curve} ${frame}:${channel}`);
      }
    }
  }
});

test("ParametricEQ adversarial boundary modulation stays finite without clipping or hidden limiting", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-eq-adversarial-"));
  const source = 'Noise(duration: 100ms, color: "white", seed: 9182, amplitude: 0.001%);';
  const writes = Array.from({ length: 42 }, (_, index) => {
    const sample = index + 1, high = sample % 2 === 1;
    return `at ${sample * 0.125}ms { set eq.frequency = ${high ? "3600hz" : "20hz"}; set eq.gain = ${high ? "24db" : "-24db"}; set eq.q = ${high ? "20" : "0.1"}; }`;
  }).join("\n");
  const dry = await render(program(source, "100ms", 100, "8khz"), root, "dry.wav", 8_000);
  const dynamic = await render(program(`ParametricEQ(frequency: 20hz, gain: -24db, q: 0.1) as eq { ${source} } ${writes}`, "100ms", 100, "8khz"), root, "dynamic.wav", 8_000);
  const control = (sample: number) => {
    const event = Math.min(sample, 42);
    if (event === 0 || event % 2 === 0) return { frequency: 20, gainDb: -24, q: 0.1 };
    return { frequency: 3_600, gainDb: 24, q: 20 };
  };
  const expected = eqModel(
    dry.pcm,
    (sample) => control(sample).frequency,
    (sample) => control(sample).gainDb,
    (sample) => control(sample).q,
    8_000,
  );
  let scalarPeak = 0, renderedPeak = 0, clipped = 0;
  for (let frame = 0; frame < dynamic.pcm.frames; frame += 1) {
    for (const channel of [0, 1]) {
      assert.ok(Number.isFinite(expected[frame][channel]), `non-finite scalar state at ${frame}:${channel}`);
      scalarPeak = Math.max(scalarPeak, Math.abs(expected[frame][channel]));
      const rendered = Math.abs(dynamic.pcm.sample(frame, channel));
      renderedPeak = Math.max(renderedPeak, rendered);
      if (rendered >= 1 - 1 / 0x800000) clipped += 1;
    }
  }
  assert.equal(clipped, 0, "accepted boundary modulation reached PCM saturation");
  assert.ok(scalarPeak < 0.01 && renderedPeak < 0.01, `unexpected modulation energy scalar=${scalarPeak} rendered=${renderedPeak}`);
  for (const frame of [0, 1, 2, 7, 17, 41, 42, 43, 137, 799]) {
    for (const channel of [0, 1]) {
      assert.ok(Math.abs(dynamic.pcm.sample(frame, channel) - expected[frame][channel]) < 3e-5, `TPT scalar/aeval mismatch at ${frame}:${channel}`);
    }
  }

  automationError(
    program(`ParametricEQ(frequency: 3999.999hz, gain: 60db, q: 0.001) as eq { ${source} } at 0.125ms { set eq.frequency = 1hz; }`, "100ms", 100, "8khz"),
    "CUT_AUDIO_AUTOMATION_VALUE_RANGE",
    /Time-varying ParametricEQ\.frequency.*between 20 Hz and 3600 Hz/,
  );
  const staticExtreme = await render(program(`ParametricEQ(frequency: 3999.999hz, gain: 60db, q: 0.001) { ${source} }`, "100ms", 100, "8khz"), root, "static-extreme.wav", 8_000);
  let staticClipped = 0;
  for (let frame = 0; frame < staticExtreme.pcm.frames; frame += 1) for (const channel of [0, 1]) {
    if (Math.abs(staticExtreme.pcm.sample(frame, channel)) >= 1 - 1 / 0x800000) staticClipped += 1;
  }
  assert.equal(staticClipped, 0, "the broader documented static-only domain is not numerically clean");
});

test("audio property events execute inside the half-open node interval and may reach its last sample", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-event-boundary-"));
  const source = 'ParametricEQ(gain: 0db) as eq { Tone(frequency: 180hz, duration: 100ms, amplitude: 5%); }';
  const baseline = await render(program(source, "100ms", 100, "8khz"), root, "baseline.wav", 8_000);
  const lastSample = await render(program(`${source} at 99.875ms { set eq.gain = 6db; }`, "100ms", 100, "8khz"), root, "last-sample.wav", 8_000);
  assert.equal(lastSample.pcm.frames, 800);
  assert.ok(Math.abs(lastSample.pcm.sample(799, 0) - baseline.pcm.sample(799, 0)) > 1e-5, "the exact last-sample write did not execute");

  automationError(
    program(`${source} at 100ms { set eq.gain = 6db; }`, "100ms", 100, "8khz"),
    "CUT_AUDIO_AUTOMATION_TIMING",
    /set start.*outside its half-open owning node interval/,
  );

  const hostile = compile(program(`${source} at 50ms { set eq.gain = 6db; }`, "100ms", 100, "8khz"));
  const eq = node(hostile, "cut.audio.eq"), property = eq.properties.gain;
  assert.ok("signal" in property);
  if ("signal" in property) {
    const signal = hostile.signals[property.signal];
    assert.equal(signal.kind, "track");
    if (signal.kind === "track" && signal.events[0]?.kind === "set") signal.events[0].time = { numerator: "1", denominator: "10" };
    signal.contentHash = cutSignalContentHash(signal);
  }
  finalizeGraphHashes(hostile);
  const loaded = loadCutAvIr(JSON.stringify(hostile));
  assert.throws(
    () => validateReferenceSession(loaded),
    (error: unknown) => error instanceof ReferenceAudioAutomationError
      && error.code === "CUT_AUDIO_AUTOMATION_TIMING"
      && /set start.*outside its half-open owning node interval/.test(error.message),
  );
});

test("balanced automation expressions render exact public and aggregate complexity boundaries", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-expression-boundary-"));
  const animations = (target: string, from: string, to: string, count: number) => Array.from({ length: count }, (_, index) =>
    `at ${index * 0.125}ms { animate ${target} from ${from} to ${to} over 0.125ms ease outCubic; }`).join("\n");
  const source = 'Noise(duration: 100ms, color: "white", seed: 7, amplitude: 0.001%);';
  const single = [
    ["gain", `Gain(amount: -12db) as p { ${source} } ${animations("p.amount", "-12db", "0db", 64)}`],
    ["pan", `Pan(position: -100%) as p { ${source} } ${animations("p.position", "-100%", "100%", 64)}`],
    ["reverb", `Reverb(wet: 0%) as p { ${source} } ${animations("p.wet", "0%", "100%", 64)}`],
    ["highpass", `HighPass(frequency: 20hz, q: 1) as p { ${source} } ${animations("p.frequency", "1hz", "3600hz", 64)}`],
    ["lowpass", `LowPass(frequency: 20hz, q: 1) as p { ${source} } ${animations("p.frequency", "1hz", "3600hz", 64)}`],
    ["eq", `ParametricEQ(frequency: 20hz, gain: 3db, q: 1) as p { ${source} } ${animations("p.frequency", "20hz", "3600hz", 64)}`],
    ["compressor", `Compressor() as p { ${source} } ${animations("p.threshold", "-60db", "0db", 64)}`],
  ] as const;
  for (const [name, body] of single) {
    const rendered = await render(program(body, "100ms", 100, "8khz"), root, `${name}.wav`, 8_000);
    assert.equal(Object.values(rendered.ir.signals).reduce((sum, signal) => sum + (signal.kind === "track" ? signal.events.length : 0), 0), 64, name);
  }

  const grouped = [
    ["eq-group", `ParametricEQ(frequency: 20hz, gain: 0db, q: 1) as p { ${source} }
      ${animations("p.frequency", "20hz", "3600hz", 43)}
      ${animations("p.gain", "-24db", "24db", 43)}
      ${animations("p.q", "0.1", "20", 42)}`],
    ["filter-group", `LowPass(frequency: 20hz, q: 1) as p { ${source} }
      ${animations("p.frequency", "1hz", "3600hz", 64)}
      ${animations("p.q", "0.1", "20", 64)}`],
    ["compressor-group", `Compressor() as p { ${source} }
      ${animations("p.threshold", "-60db", "0db", 26)}
      ${animations("p.ratio", "1", "20", 26)}
      ${animations("p.attack", "0.01ms", "2s", 26)}
      ${animations("p.release", "0.01ms", "9s", 25)}
      ${animations("p.makeup", "-24db", "24db", 25)}`],
  ] as const;
  for (const [name, body] of grouped) {
    const rendered = await render(program(body, "100ms", 100, "8khz"), root, `${name}.wav`, 8_000);
    assert.equal(Object.values(rendered.ir.signals).reduce((sum, signal) => sum + (signal.kind === "track" ? signal.events.length : 0), 0), 128, name);
  }

  for (const [name, body] of single) {
    const expanded = body.replace(/(\n|\r|$)/, `\nat 8ms { animate p.${name === "gain" ? "amount" : name === "pan" ? "position" : name === "reverb" ? "wet" : name === "compressor" ? "threshold" : "frequency"} from ${name === "gain" ? "-12db" : name === "pan" ? "-100%" : name === "reverb" ? "0%" : name === "compressor" ? "-60db" : name === "eq" ? "20hz" : "1hz"} to ${name === "gain" ? "0db" : name === "pan" ? "100%" : name === "reverb" ? "100%" : name === "compressor" ? "0db" : "3600hz"} over 0.125ms ease outCubic; }\n`);
    automationError(program(expanded, "100ms", 100, "8khz"), "CUT_AUDIO_AUTOMATION_LIMIT", /exceeds the 64-event limit/);
  }

  const gainNode = (index: number, eventCount = 64) => `Gain(amount: -12db) as p${index} { Noise(duration: 100ms, color: "white", seed: ${index + 1}, amplitude: 0.0001%); }
    ${animations(`p${index}.amount`, "-12db", "0db", eventCount)}`;
  const expressionMaximum = 15;
  const expressionAccepted = await render(program(Array.from({ length: expressionMaximum }, (_, index) => gainNode(index)).join("\n"), "100ms", 100, "8khz"), root, "aggregate-expression-max.wav", 8_000);
  const expressionCharacters = Object.values(expressionAccepted.ir.nodes)
    .filter((candidate) => candidate.op === "cut.audio.gain")
    .reduce((sum, candidate) => sum + 2 * (compileReferenceAudioAutomation(expressionAccepted.ir, expressionAccepted.ir.compositions[0], candidate)?.valueExpression.length ?? 0), 0);
  assert.ok(expressionCharacters <= referenceAudioAutomationLimits.maximumRenderedExpressionCharactersPerComposition);
  automationError(
    program(Array.from({ length: expressionMaximum + 1 }, (_, index) => gainNode(index)).join("\n"), "100ms", 100, "8khz"),
    "CUT_AUDIO_AUTOMATION_LIMIT",
    /rendered expression characters; maximum is 131072/,
  );

  const minimalGain = (index: number) => `Gain(amount: 0db) as n${index} { Tone(frequency: ${220 + index}hz, duration: 10ms, amplitude: 0.0001%); } set n${index}.amount = 0db;`;
  const nodeAccepted = await render(program(Array.from({ length: 128 }, (_, index) => minimalGain(index)).join("\n"), "10ms", 100, "8khz"), root, "aggregate-node-max.wav", 8_000);
  assert.equal(Object.values(nodeAccepted.ir.nodes).filter((candidate) => candidate.op === "cut.audio.gain").length, 128);
  automationError(
    program(Array.from({ length: 129 }, (_, index) => minimalGain(index)).join("\n"), "10ms", 100, "8khz"),
    "CUT_AUDIO_AUTOMATION_LIMIT",
    /129 automated processor nodes; maximum is 128/,
  );
});

function automationError(source: string, code: ReferenceAudioAutomationError["code"], message: RegExp) {
  const ir = compile(source); ir.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioAutomationError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });
}

test("EQ/filter automation fails closed on types, bounds, grids, easings, hostile signals, and budgets", () => {
  const invalidType = checkCutModule(parse(program('LowPass(frequency: 1khz) as filter { Tone(frequency: 440hz, duration: 100ms); } set filter.frequency = 50%;'))).diagnostics;
  assert.ok(invalidType.some((diagnostic) => diagnostic.code === "CUT2035" && /Frequency.*Ratio/.test(diagnostic.message)), JSON.stringify(invalidType));
  const invalidQType = checkCutModule(parse(program('ParametricEQ() as eq { Tone(frequency: 440hz, duration: 100ms); } set eq.q = 50%;'))).diagnostics;
  assert.ok(invalidQType.some((diagnostic) => diagnostic.code === "CUT2035" && /Number.*Ratio/.test(diagnostic.message)), JSON.stringify(invalidQType));

  for (const [body, code, message] of [
    ['LowPass(frequency: 1khz) as filter { Tone(frequency: 440hz, duration: 100ms); } set filter.frequency = 0hz;', "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between 1 Hz and 21600 Hz/],
    ['LowPass(frequency: 1khz) as filter { Tone(frequency: 440hz, duration: 100ms); } set filter.q = 0.01;', "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between 0.1 and 20/],
    ['HighPass(frequency: 1khz) as filter { Tone(frequency: 440hz, duration: 100ms); } at 0.1ms { set filter.frequency = 2khz; }', "CUT_AUDIO_AUTOMATION_SAMPLE_GRID", /event start does not land/],
    ['LowPass(frequency: 200hz) as filter { Tone(frequency: 440hz, duration: 100ms); } animate filter.frequency from 200hz to 12khz over 80ms ease spring();', "CUT_AUDIO_AUTOMATION_EASING", /only linear and outCubic/],
    ['ParametricEQ(gain: 3db) as eq { Tone(frequency: 440hz, duration: 100ms); } set eq.frequency = 24khz;', "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /below the 24000 Hz Nyquist limit/],
    ['ParametricEQ() as eq { Tone(frequency: 440hz, duration: 100ms); } set eq.gain = 61db;', "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between -192 dB and \+60 dB/],
    ['ParametricEQ(gain: 3db) as eq { Tone(frequency: 440hz, duration: 100ms); } set eq.q = 1001;', "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between 0.001 and 1000/],
    ['ParametricEQ() as eq { Tone(frequency: 440hz, duration: 100ms); } animate eq.gain from 0db to 6db over 80ms ease spring();', "CUT_AUDIO_AUTOMATION_EASING", /only linear and outCubic/],
  ] as const) automationError(program(body), code, message);

  const missing = compile(program('LowPass(frequency: 1khz) as filter { Tone(frequency: 440hz, duration: 100ms); } set filter.frequency = 2khz;'));
  missing.determinism.semantic = "locked";
  const low = node(missing, "cut.audio.lowpass"), property = low.properties.frequency;
  assert.ok("signal" in property); if ("signal" in property) delete missing.signals[property.signal];
  assert.throws(() => validateReferenceSession(missing), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_GRAPH");

  const wrongRuntimeType = compile(program('ParametricEQ(gain: 3db) as eq { Tone(frequency: 440hz, duration: 100ms); } set eq.q = 2;'));
  wrongRuntimeType.determinism.semantic = "locked";
  const eq = node(wrongRuntimeType, "cut.audio.eq"), qProperty = eq.properties.q;
  assert.ok("signal" in qProperty);
  if ("signal" in qProperty) wrongRuntimeType.signals[qProperty.signal].valueType = "Gain";
  assert.throws(() => validateReferenceSession(wrongRuntimeType), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_TYPE" && /valueType Number/.test(error.message));
  assert.throws(() => loadCutAvIr(JSON.stringify(wrongRuntimeType)), (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_TYPE" && /must be Number for cut\.audio\.eq\.q/.test(error.message));

  const wrongShape = compile(program('ParametricEQ() as eq { Tone(frequency: 440hz, duration: 100ms); } set eq.gain = 3db;'));
  wrongShape.determinism.semantic = "locked";
  const shapeEq = node(wrongShape, "cut.audio.eq"), gainProperty = shapeEq.properties.gain;
  assert.ok("signal" in gainProperty);
  if ("signal" in gainProperty) {
    const signal = wrongShape.signals[gainProperty.signal];
    wrongShape.signals[gainProperty.signal] = { id: signal.id, kind: "constant", valueType: "Gain", value: { kind: "quantity", dimension: "gain", magnitude: { numerator: "3", denominator: "1" }, unit: "db" }, contentHash: signal.contentHash, provenance: signal.provenance };
  }
  assert.throws(() => validateReferenceSession(wrongShape), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_SIGNAL");

  const many = Array.from({ length: referenceStateVariableFilterLimits.maximumAutomatedNodesPerComposition + 1 }, (_, index) => `LowPass(frequency: 1khz) as filter${index} { Tone(frequency: ${440 + index}hz, duration: 100ms); } set filter${index}.frequency = 2khz;`).join("\n");
  automationError(program(many), "CUT_AUDIO_AUTOMATION_LIMIT", /33 automated HighPass\/LowPass nodes; maximum is 32/);
  automationError(
    program('LowPass(frequency: 1khz) as filter { Tone(frequency: 440hz, duration: 1800s); } set filter.frequency = 2khz;', "1800s", 1, "192khz"),
    "CUT_AUDIO_AUTOMATION_LIMIT",
    /691200000 time-varying filter channel-samples; maximum is 536870912/,
  );
  const tooManyEvents = Array.from({ length: referenceAudioAutomationLimits.maximumEvents + 1 }, (_, index) => `at ${index}ms { set eq.q = 2; }`).join("\n");
  automationError(program(`ParametricEQ(gain: 3db) as eq { Tone(frequency: 440hz, duration: 100ms); } ${tooManyEvents}`), "CUT_AUDIO_AUTOMATION_LIMIT", /exceeds the 64-event limit/);
  const grouped = ["frequency", "gain", "q"].flatMap((property) => Array.from({ length: 43 }, () => `set eq.${property} = ${property === "frequency" ? "1khz" : property === "gain" ? "3db" : "2"};`)).join("\n");
  automationError(program(`ParametricEQ() as eq { Tone(frequency: 440hz, duration: 100ms); } ${grouped}`), "CUT_AUDIO_AUTOMATION_LIMIT", /129 total events; maximum is 128/);
  const manyEqs = Array.from({ length: referenceParametricEqLimits.maximumAutomatedNodesPerComposition + 1 }, (_, index) => `ParametricEQ(gain: 3db) as eq${index} { Tone(frequency: ${440 + index}hz, duration: 100ms); } set eq${index}.q = 2;`).join("\n");
  automationError(program(manyEqs), "CUT_AUDIO_AUTOMATION_LIMIT", /33 automated ParametricEQ nodes; maximum is 32/);
});

test("aggregate automation preflight is linear at the 100,000-node hostile bound", { timeout: 10_000 }, () => {
  const seed = compile(program('Gain(amount: 0db) as automated { Tone(frequency: 440hz, duration: 10ms); } set automated.amount = 0db;', "10ms", 100, "8khz"));
  const template = node(seed, "cut.audio.gain");
  const nodes = { ...seed.nodes };
  const reachable = new Set<string>();
  for (let index = 0; index < 100_000; index += 1) {
    const id = `hostile-automated-gain-${index}`;
    nodes[id] = { ...template, id };
    reachable.add(id);
  }
  const hostile = { ...seed, nodes };
  const started = process.hrtime.bigint();
  assert.throws(
    () => validateReferenceAudioAutomationBudget(hostile, hostile.compositions[0], reachable),
    (error: unknown) => error instanceof ReferenceAudioAutomationError
      && error.code === "CUT_AUDIO_AUTOMATION_LIMIT"
      && /100000 automated processor nodes; maximum is 128/.test(error.message),
  );
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert.ok(elapsedMilliseconds < 5_000, `aggregate preflight took ${elapsedMilliseconds.toFixed(1)}ms`);
});

function cacheFixture(cutoff: number, eqGain = 3) {
  return compile(`cut 0.4; project "filter cache";
import { LowPass, ParametricEQ, Tone } from "@cut/audio"; import { Rect } from "cut:visual"; import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Rect(width: 64px, height: 64px, fill: #123456);
    LowPass(frequency: 200hz) as sweep { Tone(frequency: 440hz, duration: 1s); }
    ParametricEQ(frequency: 1khz, gain: 0db, q: 1) as eq { Tone(frequency: 880hz, duration: 1s); }
    animate sweep.frequency from 200hz to ${cutoff}hz over 1s ease linear;
    animate eq.gain from 0db to ${eqGain}db over 1s ease linear;
  }
} export out = render(main);`);
}

test("cutoff-signal edits invalidate the filter audio graph but preserve unrelated picture scenes", () => {
  const before = cacheFixture(8_000), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = cacheFixture(12_000), plan = createIncrementalRenderPlan(after, "main", previous), filter = node(after, "cut.audio.lowpass");
  assert.equal(plan.nodes.find((candidate) => candidate.id === filter.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});

test("ParametricEQ signal edits change semantic/cache identity while preserving unrelated picture locality", () => {
  const before = cacheFixture(8_000, 3), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = cacheFixture(8_000, 6), plan = createIncrementalRenderPlan(after, "main", previous), eq = node(after, "cut.audio.eq");
  assert.notEqual(before.buildId, after.buildId);
  assert.notEqual(node(before, "cut.audio.eq").contentHash, eq.contentHash);
  assert.equal(plan.nodes.find((candidate) => candidate.id === eq.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});
