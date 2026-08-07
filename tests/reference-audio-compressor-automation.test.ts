import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import {
  compileReferenceCompressorAutomations,
  ReferenceAudioAutomationError,
} from "../lib/runtime/reference/audio-automation";
import {
  createReferenceCompressorState,
  processReferenceCompressorFrame,
  referenceCompressorLimits,
  type ReferenceCompressorControls,
} from "../lib/runtime/reference/audio-compressor";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const excitation = `
  Pan(position: -100%) { Noise(duration: 100ms, color: "white", seed: 41, amplitude: 35%); }
  Pan(position: 100%) { Noise(duration: 100ms, color: "white", seed: 42, amplitude: 12%); }
`;

function program(body: string, duration = "100ms", fps = 100, sampleRate = "48khz") {
  return `cut 0.4;
project "stateful compressor automation";
import { Compressor, EQ, Limiter, Noise, Pan, Sidechain, Tone } from "@cut/audio";
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

function pcm24(buffer: Buffer): Pcm24 {
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
    if (id === "data") { bytes = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.deepEqual({ channels, sampleRate, blockAlign, bits }, { channels: 2, sampleRate: 48_000, blockAlign: 6, bits: 24 });
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

async function render(source: string, root: string, name: string) {
  const ir = compile(source); ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  const output = resolve(root, name);
  await renderReferenceAudio(ir, ir.compositions[0], root, output);
  return { ir, pcm: pcm24(await readFile(output)) };
}

function compressorModel(
  dry: Pcm24,
  controls: (sample: number) => ReferenceCompressorControls,
  resetAt?: number,
) {
  let state = createReferenceCompressorState();
  const values = Array.from({ length: dry.frames }, () => [0, 0]);
  for (let frame = 0; frame < dry.frames; frame += 1) {
    if (frame === resetAt) state = createReferenceCompressorState();
    values[frame] = processReferenceCompressorFrame(
      dry.sample(frame, 0),
      dry.sample(frame, 1),
      controls(frame),
      48_000,
      state,
    );
  }
  return values;
}

test("all Compressor controls are closed public signal properties", () => {
  const source = program(`
    Compressor(threshold: -18db, ratio: 3, attack: 20ms, release: 180ms, makeup: 0db) as dynamics {
      ${excitation}
    }
    set dynamics.threshold = -20db;
    animate dynamics.ratio from 3 to 8 over 80ms ease linear;
    animate dynamics.attack from 20ms to 2ms over 80ms ease outCubic;
    set dynamics.release = 240ms;
    animate dynamics.makeup from 0db to 4db over 80ms ease linear;
  `);
  const ir = compile(source), compressor = node(ir, "cut.audio.compressor");
  for (const property of ["threshold", "ratio", "attack", "release", "makeup"] as const) {
    assert.ok("signal" in compressor.properties[property], property);
  }
  const automations = compileReferenceCompressorAutomations(ir, ir.compositions[0], compressor);
  assert.deepEqual(Object.keys(automations), ["threshold", "ratio", "attack", "release", "makeup"]);
  assert.deepEqual(Object.fromEntries(Object.entries(automations).map(([property, automation]) => [property, automation.eventCount])), {
    threshold: 1,
    ratio: 1,
    attack: 1,
    release: 1,
    makeup: 1,
  });
  ir.determinism.semantic = "locked";
  assert.doesNotThrow(() => validateReferenceSession(ir));
});

test("every static Compressor control matches an equivalent sample-zero property write byte-for-byte", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-compressor-parity-"));
  const controls = [
    ["threshold", "-12db"],
    ["ratio", "6"],
    ["attack", "5ms"],
    ["release", "400ms"],
    ["makeup", "3db"],
  ] as const;
  for (const [property, value] of controls) {
    const child = `Compressor(${property}: ${value}) { ${excitation} }`;
    const propertyChild = `Compressor(${property}: ${value}) as dynamics { ${excitation} } set dynamics.${property} = ${value};`;
    const plain = await render(program(child), root, `${property}-plain.wav`);
    const written = await render(program(propertyChild), root, `${property}-property.wav`);
    assert.deepEqual(written.pcm.bytes, plain.pcm.bytes, property);
  }
});

test("an exact threshold event changes that sample without resetting the running envelope", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-compressor-event-")), eventSample = 2_400;
  const dry = await render(program(excitation), root, "dry.wav");
  const old = await render(program(`Compressor(ratio: 10, attack: 5ms, release: 200ms) { ${excitation} }`), root, "old.wav");
  const dynamic = await render(program(`Compressor(ratio: 10, attack: 5ms, release: 200ms) as dynamics { ${excitation} } at 50ms { set dynamics.threshold = -36db; }`), root, "dynamic.wav");
  assert.deepEqual(dynamic.pcm.bytes.subarray(0, eventSample * 6), old.pcm.bytes.subarray(0, eventSample * 6));
  assert.ok(Math.abs(dynamic.pcm.sample(eventSample, 0) - old.pcm.sample(eventSample, 0)) > 1e-4, "event sample retained the old threshold");

  const controls = (sample: number): ReferenceCompressorControls => ({
    thresholdDb: sample < eventSample ? -18 : -36,
    ratio: 10,
    attackSeconds: 0.005,
    releaseSeconds: 0.2,
    makeupDb: 0,
  });
  const continuous = compressorModel(dry.pcm, controls);
  const reset = compressorModel(dry.pcm, controls, eventSample);
  let continuousError = 0, resetError = 0;
  for (let frame = eventSample; frame < eventSample + 256; frame += 1) {
    for (const channel of [0, 1]) {
      const actual = dynamic.pcm.sample(frame, channel);
      continuousError += (actual - continuous[frame][channel]) ** 2;
      resetError += (actual - reset[frame][channel]) ** 2;
    }
  }
  assert.ok(continuousError < 1e-6, `decoded PCM diverged from the continuous recurrence: ${continuousError}`);
  assert.ok(continuousError * 1_000 < resetError, `a reset model was not decisively worse: continuous=${continuousError} reset=${resetError}`);
});

test("linear and outCubic automation for every Compressor control follows one exact stereo-linked recurrence", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-compressor-curves-")), end = 3_840;
  const dry = await render(program(excitation), root, "dry.wav");
  const base: ReferenceCompressorControls = { thresholdDb: -24, ratio: 6, attackSeconds: 0.005, releaseSeconds: 0.08, makeupDb: -3 };
  const cases = [
    { property: "threshold", from: "-6db", to: "-30db", fromNumber: -6, toNumber: -30, field: "thresholdDb" },
    { property: "ratio", from: "1.5", to: "12", fromNumber: 1.5, toNumber: 12, field: "ratio" },
    { property: "attack", from: "1ms", to: "80ms", fromNumber: 0.001, toNumber: 0.08, field: "attackSeconds" },
    { property: "release", from: "20ms", to: "500ms", fromNumber: 0.02, toNumber: 0.5, field: "releaseSeconds" },
    { property: "makeup", from: "-6db", to: "6db", fromNumber: -6, toNumber: 6, field: "makeupDb" },
  ] as const;
  for (const item of cases) {
    for (const curve of ["linear", "outCubic"] as const) {
      const constructor = `threshold: ${item.property === "threshold" ? item.from : "-24db"}, ratio: ${item.property === "ratio" ? item.from : "6"}, attack: ${item.property === "attack" ? item.from : "5ms"}, release: ${item.property === "release" ? item.from : "80ms"}, makeup: ${item.property === "makeup" ? item.from : "-3db"}`;
      const filtered = await render(program(`Compressor(${constructor}) as dynamics { ${excitation} } animate dynamics.${item.property} from ${item.from} to ${item.to} over 80ms ease ${curve};`), root, `${item.property}-${curve}.wav`);
      const expected = compressorModel(dry.pcm, (sample) => {
        const progress = Math.min(1, sample / end), eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
        return { ...base, [item.field]: item.fromNumber + (item.toNumber - item.fromNumber) * eased };
      });
      for (const frame of [0, 1, 127, 2_400, end - 1, end, 4_200]) {
        for (const channel of [0, 1]) {
          assert.ok(Math.abs(filtered.pcm.sample(frame, channel) - expected[frame][channel]) < 1.5e-4, `${item.property} ${curve} ${frame}:${channel}`);
        }
      }
    }
  }
});

function automationError(source: string, code: ReferenceAudioAutomationError["code"], message: RegExp) {
  const ir = compile(source); ir.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioAutomationError);
    assert.equal(error.code, code, source);
    assert.match(error.message, message);
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });
}

test("Compressor automation fails closed on types, bounds, clocks, easings, graphs, and resource excess", () => {
  const invalidTypes = checkCutModule(parse(program(`
    Compressor() as dynamics { ${excitation} }
    set dynamics.threshold = 1;
    set dynamics.ratio = 50%;
    set dynamics.attack = -3db;
    set dynamics.release = 1;
    set dynamics.makeup = 50%;
  `))).diagnostics.filter((diagnostic) => diagnostic.code === "CUT2035");
  assert.equal(invalidTypes.length, 5, JSON.stringify(invalidTypes));
  assert.ok(invalidTypes.some((diagnostic) => /Gain.*Number/.test(diagnostic.message)), JSON.stringify(invalidTypes));
  assert.ok(invalidTypes.some((diagnostic) => /Number.*Ratio/.test(diagnostic.message)), JSON.stringify(invalidTypes));
  assert.ok(invalidTypes.some((diagnostic) => /Time.*Gain/.test(diagnostic.message)), JSON.stringify(invalidTypes));
  assert.ok(invalidTypes.some((diagnostic) => /Time.*Number/.test(diagnostic.message)), JSON.stringify(invalidTypes));
  assert.ok(invalidTypes.some((diagnostic) => /Gain.*Ratio/.test(diagnostic.message)), JSON.stringify(invalidTypes));

  for (const [body, code, message] of [
    [`Compressor() as dynamics { ${excitation} } set dynamics.threshold = -61db;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between -60 dB and 0 dB/],
    [`Compressor() as dynamics { ${excitation} } set dynamics.ratio = 21;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between 1:1 and 20:1/],
    [`Compressor() as dynamics { ${excitation} } set dynamics.attack = 0ms;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between 0.01 ms and 2000 ms/],
    [`Compressor() as dynamics { ${excitation} } set dynamics.release = 10s;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between 0.01 ms and 9000 ms/],
    [`Compressor() as dynamics { ${excitation} } set dynamics.makeup = 25db;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /between -24 dB and \+24 dB/],
    [`Compressor() as dynamics { ${excitation} } at 0.1ms { set dynamics.threshold = -20db; }`, "CUT_AUDIO_AUTOMATION_SAMPLE_GRID", /event start does not land/],
    [`Compressor() as dynamics { ${excitation} } animate dynamics.ratio from 2 to 8 over 80ms ease spring();`, "CUT_AUDIO_AUTOMATION_EASING", /only linear and outCubic/],
  ] as const) automationError(program(body), code, message);

  for (const body of [
    `Limiter() as limiter { ${excitation} } set limiter.lookahead = 3ms;`,
  ]) {
    const diagnostics = checkCutModule(parse(program(body))).diagnostics;
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "CUT2060"), JSON.stringify(diagnostics));
  }
  const sidechainDiagnostics = checkCutModule(parse(program(`Tone(frequency: 220hz, duration: 100ms) as key; Sidechain(source: key, amount: -6db) as duck { ${excitation} } set duck.threshold = -20db;`))).diagnostics;
  assert.deepEqual(sidechainDiagnostics, []);

  const missing = compile(program(`Compressor() as dynamics { ${excitation} } set dynamics.makeup = 3db;`));
  missing.determinism.semantic = "locked";
  const compressor = node(missing, "cut.audio.compressor"), property = compressor.properties.makeup;
  assert.ok("signal" in property); if ("signal" in property) delete missing.signals[property.signal];
  assert.throws(() => validateReferenceSession(missing), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_GRAPH");

  const many = Array.from({ length: referenceCompressorLimits.maximumAutomatedNodesPerComposition + 1 }, (_, index) => `Compressor() as dynamics${index} { Tone(frequency: ${440 + index}hz, duration: 100ms); } set dynamics${index}.threshold = -20db;`).join("\n");
  automationError(program(many), "CUT_AUDIO_AUTOMATION_LIMIT", /17 automated Compressor nodes; maximum is 16/);
  automationError(
    program('Compressor() as dynamics { Tone(frequency: 440hz, duration: 1800s); } set dynamics.threshold = -20db;', "1800s", 1, "192khz"),
    "CUT_AUDIO_AUTOMATION_LIMIT",
    /691200000 time-varying Compressor channel-samples; maximum is 268435456/,
  );

  const events = ["threshold", "ratio", "attack", "release", "makeup"].flatMap((property, propertyIndex) =>
    Array.from({ length: propertyIndex === 4 ? 25 : 26 }, (_, index) => `at ${index + 1}ms { set dynamics.${property} = ${property === "threshold" ? "-20db" : property === "ratio" ? "4" : property === "attack" ? "5ms" : property === "release" ? "100ms" : "1db"}; }`));
  automationError(program(`Compressor() as dynamics { ${excitation} } ${events.join("\n")}`), "CUT_AUDIO_AUTOMATION_LIMIT", /129 total events; maximum is 128/);
});

function cacheFixture(makeup: number) {
  return compile(`cut 0.4; project "compressor cache";
import { Compressor, Tone } from "@cut/audio"; import { Rect } from "cut:visual"; import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Rect(width: 64px, height: 64px, fill: #123456);
    Compressor(threshold: -18db, ratio: 4) as dynamics { Tone(frequency: 440hz, duration: 1s); }
    animate dynamics.makeup from 0db to ${makeup}db over 1s ease linear;
  }
} export out = render(main);`);
}

test("Compressor signal edits invalidate its audio identity while preserving unrelated picture scenes", () => {
  const before = cacheFixture(3), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = cacheFixture(6), plan = createIncrementalRenderPlan(after, "main", previous), compressor = node(after, "cut.audio.compressor");
  assert.equal(plan.nodes.find((candidate) => candidate.id === compressor.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});
