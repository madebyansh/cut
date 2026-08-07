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
  compileReferenceSidechainAutomations,
  ReferenceAudioAutomationError,
} from "../lib/runtime/reference/audio-automation";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
} from "../lib/runtime/reference/audio-cache";
import { referenceMasterAudioRootIds, renderReferenceAudio } from "../lib/runtime/reference/audio";
import {
  createReferenceSidechainState,
  processReferenceSidechainFrame,
  referenceSidechainLimits,
  type ReferenceSidechainControls,
} from "../lib/runtime/reference/audio-sidechain";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const programSignal = `
  Pan(position: -100%) { Noise(duration: 100ms, color: "white", seed: 71, amplitude: 35%); }
  Pan(position: 100%) { Noise(duration: 100ms, color: "white", seed: 72, amplitude: 12%); }
`;
const keySignal = "Tone(frequency: 3000hz, duration: 100ms, amplitude: 80%);";

function program(body: string, duration = "100ms", fps = 100, sampleRate = "48khz") {
  return `cut 0.4;
project "stateful sidechain automation";
import { Noise, Pan, Sidechain, Tone } from "@cut/audio";
import { linear, outCubic, spring } from "@cut/motion";
timeline main(duration: ${duration}, fps: ${fps}, width: 64px, height: 64px, sampleRate: ${sampleRate}) {
  ${body}
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function sidechain(body = programSignal, controls = "amount: -6db, threshold: -30db, attack: 5ms, release: 100ms") {
  return sidechainFromKey("Tone(frequency: 3000hz, duration: 100ms, amplitude: 80%)", body, controls);
}

function sidechainFromKey(key: string, body = programSignal, controls = "amount: -6db, threshold: -30db, attack: 5ms, release: 100ms") {
  return `let key = ${key};
Sidechain(source: key, ${controls}) as duck { ${body} }`;
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
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0;
  let bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      blockAlign = buffer.readUInt16LE(body + 12);
      bits = buffer.readUInt16LE(body + 14);
    }
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

function sidechainModel(
  dry: Pcm24,
  key: Pcm24,
  controls: (sample: number) => ReferenceSidechainControls,
  resetAt?: number,
) {
  let state = createReferenceSidechainState();
  const values = Array.from({ length: dry.frames }, () => [0, 0]);
  for (let frame = 0; frame < dry.frames; frame += 1) {
    if (frame === resetAt) state = createReferenceSidechainState();
    values[frame] = processReferenceSidechainFrame(
      dry.sample(frame, 0),
      dry.sample(frame, 1),
      key.sample(frame, 0),
      key.sample(frame, 1),
      controls(frame),
      48_000,
      state,
    );
  }
  return values;
}

test("all Sidechain controls are closed public signal properties", () => {
  const source = program(`${sidechain()}
    set duck.amount = -9db;
    animate duck.threshold from -30db to -20db over 80ms ease outCubic;
    animate duck.attack from 5ms to 1ms over 80ms ease linear;
    set duck.release = 200ms;`);
  const checked = checkCutModule(parse(source));
  assert.deepEqual(checked.diagnostics, []);
  const ir = compileCutModule(checked.module).ir, duck = node(ir, "cut.audio.sidechain");
  for (const [property, valueType] of [["amount", "Gain"], ["threshold", "Gain"], ["attack", "Time"], ["release", "Time"]] as const) {
    const value = duck.properties[property];
    assert.ok("signal" in value, property);
    if ("signal" in value) assert.equal(ir.signals[value.signal].valueType, valueType, property);
  }
  const automations = compileReferenceSidechainAutomations(ir, ir.compositions[0], duck);
  assert.deepEqual(Object.keys(automations), ["amount", "threshold", "attack", "release"]);
  assert.deepEqual(
    { amount: automations.amount?.eventCount, threshold: automations.threshold?.eventCount, attack: automations.attack?.eventCount, release: automations.release?.eventCount },
    { amount: 1, threshold: 1, attack: 1, release: 1 },
  );
  ir.determinism.semantic = "locked";
  assert.doesNotThrow(() => validateReferenceSession(ir));

  const wrongTypes = checkCutModule(parse(program(`${sidechain()} set duck.amount = 50%; set duck.threshold = 1;`))).diagnostics;
  assert.equal(wrongTypes.filter((diagnostic) => diagnostic.code === "CUT2035").length, 2, JSON.stringify(wrongTypes));
  const wrongTimes = checkCutModule(parse(program(`${sidechain()} set duck.attack = -6db; set duck.release = 50%;`))).diagnostics;
  assert.equal(wrongTimes.filter((diagnostic) => diagnostic.code === "CUT2035").length, 2, JSON.stringify(wrongTimes));
});

test("static Sidechain controls match equivalent exact sample-zero property writes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-sidechain-parity-"));
  for (const [property, value] of [["amount", "-12db"], ["threshold", "-36db"], ["attack", "2ms"], ["release", "120ms"]] as const) {
    const controls = {
      amount: "amount: -12db, threshold: -36db, attack: 5ms, release: 100ms",
      threshold: "amount: -12db, threshold: -36db, attack: 5ms, release: 100ms",
      attack: "amount: -12db, threshold: -36db, attack: 2ms, release: 100ms",
      release: "amount: -12db, threshold: -36db, attack: 5ms, release: 120ms",
    }[property];
    const plain = await render(program(sidechain(programSignal, controls)), root, `${property}-plain.wav`);
    const written = await render(program(`${sidechain(programSignal, controls)} set duck.${property} = ${value};`), root, `${property}-property.wav`);
    assert.deepEqual(written.pcm.bytes, plain.pcm.bytes, property);
  }
});

test("an exact amount event changes that destination sample without resetting the key envelope", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-sidechain-event-")), eventSample = 2_400;
  const dry = await render(program(programSignal), root, "dry.wav");
  const key = await render(program(keySignal), root, "key.wav");
  const old = await render(program(sidechain()), root, "old.wav");
  const dynamic = await render(program(`${sidechain()} at 50ms { set duck.amount = -18db; }`), root, "dynamic.wav");
  assert.deepEqual(dynamic.pcm.bytes.subarray(0, eventSample * 6), old.pcm.bytes.subarray(0, eventSample * 6));
  assert.ok(Math.abs(dynamic.pcm.sample(eventSample, 0) - old.pcm.sample(eventSample, 0)) > 1e-4, "event sample retained the old amount");

  const controls = (sample: number): ReferenceSidechainControls => ({
    amountDb: sample < eventSample ? -6 : -18,
    thresholdDb: -30,
    attackSeconds: 0.005,
    releaseSeconds: 0.1,
  });
  const continuous = sidechainModel(dry.pcm, key.pcm, controls);
  const reset = sidechainModel(dry.pcm, key.pcm, controls, eventSample);
  let continuousError = 0, resetError = 0;
  for (let frame = eventSample; frame < eventSample + 256; frame += 1) {
    for (const channel of [0, 1]) {
      const actual = dynamic.pcm.sample(frame, channel);
      continuousError += (actual - continuous[frame][channel]) ** 2;
      resetError += (actual - reset[frame][channel]) ** 2;
    }
  }
  assert.ok(continuousError < 1e-6, `decoded PCM diverged from the continuous sidechain recurrence: ${continuousError}`);
  assert.ok(continuousError * 1_000 < resetError, `a reset model was not decisively worse: continuous=${continuousError} reset=${resetError}`);
});

test("exact attack and release events change their destination samples without resetting the key envelope", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-sidechain-time-events-"));
  const dry = await render(program(programSignal), root, "dry.wav");

  const attackEventSample = 481;
  const attackKey = await render(program(keySignal), root, "attack-key.wav");
  const attackControls = "amount: -18db, threshold: -30db, attack: 20ms, release: 100ms";
  const attackOld = await render(program(sidechain(programSignal, attackControls)), root, "attack-old.wav");
  const attackDynamic = await render(program(`${sidechain(programSignal, attackControls)} at seconds(481 / 48000) { set duck.attack = 1ms; }`), root, "attack-dynamic.wav");
  assert.deepEqual(attackDynamic.pcm.bytes.subarray(0, attackEventSample * 6), attackOld.pcm.bytes.subarray(0, attackEventSample * 6));
  assert.ok(Math.abs(attackDynamic.pcm.sample(attackEventSample, 0) - attackOld.pcm.sample(attackEventSample, 0)) > 1e-5, "attack event sample retained the old coefficient");
  const expectedAttack = sidechainModel(dry.pcm, attackKey.pcm, (sample) => ({
    amountDb: -18,
    thresholdDb: -30,
    attackSeconds: sample < attackEventSample ? 0.02 : 0.001,
    releaseSeconds: 0.1,
  }));
  const resetAttack = sidechainModel(dry.pcm, attackKey.pcm, (sample) => ({
    amountDb: -18,
    thresholdDb: -30,
    attackSeconds: sample < attackEventSample ? 0.02 : 0.001,
    releaseSeconds: 0.1,
  }), attackEventSample);

  const releaseEventSample = 1_440;
  const shortKeySource = "Tone(frequency: 3000hz, duration: 20ms, amplitude: 80%)";
  const releaseKey = await render(program(`${shortKeySource};`), root, "release-key.wav");
  const releaseControls = "amount: -18db, threshold: -30db, attack: 1ms, release: 100ms";
  const releaseOld = await render(program(sidechainFromKey(shortKeySource, programSignal, releaseControls)), root, "release-old.wav");
  const releaseDynamic = await render(program(`${sidechainFromKey(shortKeySource, programSignal, releaseControls)} at 30ms { set duck.release = 5ms; }`), root, "release-dynamic.wav");
  assert.deepEqual(releaseDynamic.pcm.bytes.subarray(0, releaseEventSample * 6), releaseOld.pcm.bytes.subarray(0, releaseEventSample * 6));
  assert.ok(Math.abs(releaseDynamic.pcm.sample(releaseEventSample, 0) - releaseOld.pcm.sample(releaseEventSample, 0)) > 1e-5, "release event sample retained the old coefficient");
  const expectedRelease = sidechainModel(dry.pcm, releaseKey.pcm, (sample) => ({
    amountDb: -18,
    thresholdDb: -30,
    attackSeconds: 0.001,
    releaseSeconds: sample < releaseEventSample ? 0.1 : 0.005,
  }));
  const resetRelease = sidechainModel(dry.pcm, releaseKey.pcm, (sample) => ({
    amountDb: -18,
    thresholdDb: -30,
    attackSeconds: 0.001,
    releaseSeconds: sample < releaseEventSample ? 0.1 : 0.005,
  }), releaseEventSample);

  for (const [name, actual, expected, reset, eventSample] of [
    ["attack", attackDynamic.pcm, expectedAttack, resetAttack, attackEventSample],
    ["release", releaseDynamic.pcm, expectedRelease, resetRelease, releaseEventSample],
  ] as const) {
    let continuousError = 0, resetError = 0;
    for (let frame = eventSample; frame < eventSample + 256; frame += 1) {
      for (const channel of [0, 1]) {
        continuousError += (actual.sample(frame, channel) - expected[frame][channel]) ** 2;
        resetError += (actual.sample(frame, channel) - reset[frame][channel]) ** 2;
      }
    }
    assert.ok(continuousError < 1e-6, `${name} decoded PCM diverged from the continuous recurrence: ${continuousError}`);
    assert.ok(continuousError * 1_000 < resetError, `${name} reset model was not decisively worse: continuous=${continuousError} reset=${resetError}`);
  }
});

test("linear and outCubic amount/threshold curves follow the normative scalar model", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-sidechain-curves-")), endSample = 3_840;
  const dry = await render(program(programSignal), root, "dry.wav");
  const key = await render(program(keySignal), root, "key.wav");
  const cases = [
    { property: "amount", from: "-3db", to: "-18db", fromNumber: -3, toNumber: -18, amountDb: -3, thresholdDb: -30 },
    { property: "threshold", from: "-40db", to: "-20db", fromNumber: -40, toNumber: -20, amountDb: -12, thresholdDb: -40 },
  ] as const;
  for (const item of cases) {
    for (const curve of ["linear", "outCubic"] as const) {
      const controls = `amount: ${item.amountDb}db, threshold: ${item.thresholdDb}db, attack: 5ms, release: 100ms`;
      const filtered = await render(program(`${sidechain(programSignal, controls)} animate duck.${item.property} from ${item.from} to ${item.to} over 80ms ease ${curve};`), root, `${item.property}-${curve}.wav`);
      const expected = sidechainModel(dry.pcm, key.pcm, (sample) => {
        const progress = Math.min(1, sample / endSample), eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
        const value = item.fromNumber + (item.toNumber - item.fromNumber) * eased;
        return {
          amountDb: item.property === "amount" ? value : item.amountDb,
          thresholdDb: item.property === "threshold" ? value : item.thresholdDb,
          attackSeconds: 0.005,
          releaseSeconds: 0.1,
        };
      });
      for (const frame of [0, 1, 127, 2_400, endSample - 1, endSample, 4_200]) {
        for (const channel of [0, 1]) {
          assert.ok(Math.abs(filtered.pcm.sample(frame, channel) - expected[frame][channel]) < 1.5e-4, `${item.property} ${curve} ${frame}:${channel}`);
        }
      }
    }
  }
});

test("linear and outCubic attack/release curves follow the normative scalar model", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-sidechain-time-curves-"));
  const dry = await render(program(programSignal), root, "dry.wav");
  const longKey = await render(program(keySignal), root, "long-key.wav");
  const shortKeySource = "Tone(frequency: 3000hz, duration: 20ms, amplitude: 80%)";
  const shortKey = await render(program(`${shortKeySource};`), root, "short-key.wav");

  for (const curve of ["linear", "outCubic"] as const) {
    const attack = await render(program(`${sidechain(programSignal, "amount: -18db, threshold: -30db, attack: 20ms, release: 100ms")} animate duck.attack from 20ms to 1ms over 80ms ease ${curve};`), root, `attack-${curve}.wav`);
    const expectedAttack = sidechainModel(dry.pcm, longKey.pcm, (sample) => {
      const progress = Math.min(1, sample / 3_840), eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
      return { amountDb: -18, thresholdDb: -30, attackSeconds: 0.02 + (0.001 - 0.02) * eased, releaseSeconds: 0.1 };
    });

    const release = await render(program(`${sidechainFromKey(shortKeySource, programSignal, "amount: -18db, threshold: -30db, attack: 1ms, release: 100ms")} at 20ms { animate duck.release from 100ms to 5ms over 60ms ease ${curve}; }`), root, `release-${curve}.wav`);
    const expectedRelease = sidechainModel(dry.pcm, shortKey.pcm, (sample) => {
      const progress = Math.max(0, Math.min(1, (sample - 960) / 2_880)), eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
      return { amountDb: -18, thresholdDb: -30, attackSeconds: 0.001, releaseSeconds: 0.1 + (0.005 - 0.1) * eased };
    });

    for (const [name, actual, expected] of [["attack", attack.pcm, expectedAttack], ["release", release.pcm, expectedRelease]] as const) {
      for (const frame of [0, 1, 959, 960, 1_440, 2_400, 3_839, 3_840, 4_200]) {
        for (const channel of [0, 1]) {
          assert.ok(Math.abs(actual.sample(frame, channel) - expected[frame][channel]) < 1.5e-4, `${name} ${curve} ${frame}:${channel}`);
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

test("Sidechain automation fails closed on hostile values, clocks, easings, graphs, and work excess", () => {
  for (const [body, code, message] of [
    [`${sidechain()} set duck.amount = -41db;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /Sidechain\.amount.*between -40 dB and 0 dB/],
    [`${sidechain()} set duck.threshold = -61db;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /Sidechain\.threshold.*between -60 dB and 0 dB/],
    [`${sidechain()} set duck.attack = 0ms;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /Sidechain\.attack.*between 0\.01 ms and 2000 ms/],
    [`${sidechain()} set duck.release = 10s;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /Sidechain\.release.*between 0\.01 ms and 9000 ms/],
    [`${sidechain(programSignal, "amount: -6db, threshold: -20db, attack: 5ms, release: 100ms")} animate duck.amount from -6db to -30db over 80ms ease linear;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /can combine amount -30 dB with threshold -20 dB/],
    [`${sidechain()} at 0.1ms { set duck.amount = -9db; }`, "CUT_AUDIO_AUTOMATION_SAMPLE_GRID", /event start does not land/],
    [`${sidechain()} animate duck.threshold from -30db to -20db over 80ms ease spring\(\);`, "CUT_AUDIO_AUTOMATION_EASING", /only linear and outCubic/],
  ] as const) automationError(program(body), code, message);

  const missing = compile(program(`${sidechain()} set duck.amount = -9db;`));
  missing.determinism.semantic = "locked";
  const duck = node(missing, "cut.audio.sidechain"), amount = duck.properties.amount;
  assert.ok("signal" in amount); if ("signal" in amount) delete missing.signals[amount.signal];
  assert.throws(() => validateReferenceSession(missing), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_GRAPH");

  const wrongSignal = compile(program(`${sidechain()} set duck.threshold = -24db;`));
  wrongSignal.determinism.semantic = "locked";
  const threshold = node(wrongSignal, "cut.audio.sidechain").properties.threshold;
  assert.ok("signal" in threshold); if ("signal" in threshold) wrongSignal.signals[threshold.signal].valueType = "Number";
  assert.throws(() => validateReferenceSession(wrongSignal), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_TYPE");

  const wrongTimeSignal = compile(program(`${sidechain()} set duck.attack = 5ms;`));
  wrongTimeSignal.determinism.semantic = "locked";
  const attack = node(wrongTimeSignal, "cut.audio.sidechain").properties.attack;
  assert.ok("signal" in attack); if ("signal" in attack) wrongTimeSignal.signals[attack.signal].valueType = "Gain";
  assert.throws(() => validateReferenceSession(wrongTimeSignal), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_TYPE");

  const events = Array.from({ length: referenceSidechainLimits.maximumAutomationEventsPerNode / 2 + 1 }, (_, index) => `at ${index + 1}ms { set duck.amount = -9db; }`).join("\n");
  automationError(program(`${sidechain()} ${events}`), "CUT_AUDIO_AUTOMATION_LIMIT", /exceeds the 64-event limit/);

  const grouped = (["amount", "threshold", "attack", "release"] as const).flatMap((property) => Array.from({ length: 33 }, (_, index) => {
    const value = property === "amount" ? "-6db" : property === "threshold" ? "-30db" : property === "attack" ? "5ms" : "100ms";
    return `at ${index + 1}ms { set duck.${property} = ${value}; }`;
  })).join("\n");
  automationError(program(`${sidechain()} ${grouped}`), "CUT_AUDIO_AUTOMATION_LIMIT", /declares 132 total events; maximum is 128/);

  const many = Array.from({ length: referenceSidechainLimits.maximumAutomatedNodesPerComposition + 1 }, (_, index) => `let key${index} = Tone(frequency: ${3_000 + index}hz, duration: 100ms, amplitude: 80%); Sidechain(source: key${index}, amount: -6db, threshold: -30db) as duck${index} { Tone(frequency: ${440 + index}hz, duration: 100ms); } set duck${index}.amount = -9db;`).join("\n");
  automationError(program(many), "CUT_AUDIO_AUTOMATION_LIMIT", /17 automated Sidechain nodes; maximum is 16/);
  automationError(
    program('let key = Tone(frequency: 3000hz, duration: 1800s); Sidechain(source: key, amount: -6db, threshold: -30db) as duck { Tone(frequency: 440hz, duration: 1800s); } set duck.amount = -9db;', "1800s", 1, "192khz"),
    "CUT_AUDIO_AUTOMATION_LIMIT",
    /691200000 time-varying Sidechain channel-samples; maximum is 268435456/,
  );
});

function cacheFixture(target: number) {
  return compile(`cut 0.4; project "sidechain cache";
import { Sidechain, Tone } from "@cut/audio"; import { Rect } from "cut:visual"; import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Rect(width: 64px, height: 64px, fill: #123456);
    let key = Tone(frequency: 3000hz, duration: 1s, amplitude: 80%);
    Sidechain(source: key, amount: -6db, threshold: -30db) as duck { Tone(frequency: 440hz, duration: 1s); }
    animate duck.amount from -6db to ${target}db over 1s ease linear;
  }
} export out = render(main);`);
}

function timingCacheFixture(targetMs: number, fill: string) {
  return compile(`cut 0.4; project "sidechain timing cache";
import { Sidechain, Tone } from "@cut/audio"; import { Rect } from "cut:visual"; import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Rect(width: 64px, height: 64px, fill: ${fill});
    let key = Tone(frequency: 3000hz, duration: 1s, amplitude: 80%);
    Sidechain(source: key, amount: -12db, threshold: -30db, attack: 20ms, release: 100ms) as duck { Tone(frequency: 440hz, duration: 1s); }
    animate duck.attack from 20ms to ${targetMs}ms over 1s ease linear;
  }
} export out = render(main);`);
}

test("Sidechain signal edits invalidate audio identity while preserving unrelated picture scenes", () => {
  const before = cacheFixture(-9), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = cacheFixture(-12), plan = createIncrementalRenderPlan(after, "main", previous), duck = node(after, "cut.audio.sidechain");
  assert.equal(plan.nodes.find((candidate) => candidate.id === duck.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});

test("Sidechain timing signals enter pre-master cache identity while picture-only edits stay local", () => {
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-sidechain-timing-test");
  const cachePlan = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), toolchain);
  const base = timingCacheFixture(1, "#112233"), timingEdit = timingCacheFixture(2, "#112233"), pictureEdit = timingCacheFixture(1, "#fedcba");
  assert.notEqual(base.buildId, timingEdit.buildId, "attack automation edit preserved semantic build identity");
  assert.notEqual(cachePlan(base).key, cachePlan(timingEdit).key, "attack automation edit reused pre-master PCM identity");
  assert.equal(cachePlan(base).key, cachePlan(pictureEdit).key, "picture-only edit invalidated pre-master PCM identity");
});
