import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import {
  compileReferenceDeEsserAutomations,
  ReferenceAudioAutomationError,
  validateReferenceAudioAutomationBudget,
} from "../lib/runtime/reference/audio-automation";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
} from "../lib/runtime/reference/audio-cache";
import { referenceAudioNodeConfig } from "../lib/runtime/reference/audio-config";
import {
  referenceMasterAudioRootIds,
  renderReferenceAudio,
  renderReferenceAudioSelection,
} from "../lib/runtime/reference/audio";
import {
  createReferenceDeEsserState,
  processReferenceDeEsserFrame,
  referenceDeEsserCoreLimits,
  type ReferenceDeEsserControls,
} from "../lib/runtime/reference/audio-deesser";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const excitation = `
  Pan(position: -100%) { Noise(duration: 100ms, color: "white", seed: 401, amplitude: 70%); }
  Pan(position: 100%) { Noise(duration: 100ms, color: "blue", seed: 402, amplitude: 35%); }
`;

function program(body: string, duration = "100ms", sampleRate = "48khz") {
  return `cut 0.4;
project "dynamic deesser conformance";
import { DeEsser, Noise, Pan, Tone } from "@cut/audio";
import { linear, outCubic, spring } from "@cut/motion";
timeline main(duration: ${duration}, fps: 100, width: 64px, height: 64px, sampleRate: ${sampleRate}) {
  ${body}
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function deEsser(body = excitation, controls = "intensity: 0.35, amount: 0.5") {
  return `DeEsser(${controls}) as deess { ${body} }`;
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
  sampleRate: number;
  frames: number;
  bytes: Buffer<ArrayBufferLike>;
  sample(frame: number, channel: number): number;
};

type StereoPcm = Pick<Pcm24, "sampleRate" | "frames" | "sample">;

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
  assert.equal(channels, 2);
  assert.equal(blockAlign, 6);
  assert.equal(bits, 24);
  return {
    sampleRate,
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
  const ir = compile(source);
  ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  const output = resolve(root, name);
  await renderReferenceAudio(ir, ir.compositions[0], root, output);
  return { ir, pcm: pcm24(await readFile(output)) };
}

async function renderRaw(source: string, root: string, name: string) {
  const ir = compile(source);
  ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  const output = resolve(root, name);
  await renderReferenceAudioSelection(
    ir,
    ir.compositions[0],
    root,
    output,
    referenceMasterAudioRootIds(ir, ir.compositions[0]),
    { outputFormat: "raw-stereo-f32le" },
  );
  const bytes = await readFile(output), frames = bytes.byteLength / 8;
  assert.equal(bytes.byteLength % 8, 0);
  return {
    ir,
    pcm: {
      sampleRate: ir.compositions[0].sampleRate,
      frames,
      sample(frame: number, channel: number) {
        return bytes.readFloatLE(frame * 8 + channel * 4);
      },
    } satisfies StereoPcm,
  };
}

function coreModel(
  dry: StereoPcm,
  ir: CutAVIR,
  controls: (frame: number) => ReferenceDeEsserControls,
  resetAt?: number,
) {
  const processor = node(ir, "cut.audio.deesser");
  const config = referenceAudioNodeConfig(ir, ir.compositions[0], processor);
  assert.ok(config?.kind === "deesser");
  let state = createReferenceDeEsserState();
  const output = Array.from({ length: dry.frames }, () => [0, 0] as [number, number]);
  for (let frame = 0; frame < dry.frames; frame += 1) {
    if (frame === resetAt) state = createReferenceDeEsserState();
    const value = processReferenceDeEsserFrame(dry.sample(frame, 0), dry.sample(frame, 1), controls(frame), config.plan, state);
    output[frame] = [value.left, value.right];
  }
  return output;
}

function assertModelSamples(actual: Pcm24, expected: readonly (readonly [number, number])[], frames: readonly number[], label: string) {
  // The core consumes the exact raw f32 source handed to the backend, while
  // the delivered artifact is canonical PCM24. One half-LSB of output
  // quantization plus the bounded JS/FFmpeg scalar-recurrence spelling
  // difference must remain strictly below one normalized PCM24 LSB.
  const tolerance = 1e-7;
  for (const frame of frames) for (const channel of [0, 1]) {
    assert.ok(Math.abs(actual.sample(frame, channel) - expected[frame][channel]) < tolerance, `${label} ${frame}:${channel}`);
  }
}

function assertFullModel(actual: Pcm24, expected: readonly (readonly [number, number])[], label: string) {
  let maximum = 0;
  for (let frame = 0; frame < actual.frames; frame += 1) for (const channel of [0, 1]) {
    maximum = Math.max(maximum, Math.abs(actual.sample(frame, channel) - expected[frame][channel]));
  }
  assert.ok(maximum < 1e-7, `${label} full decoded/core maximum error ${maximum}`);
}

test("DeEsser intensity and amount are closed public Number properties over one static plan", () => {
  const source = program(`${deEsser()}
    set deess.intensity = 0.6;
    animate deess.amount from 0.2 to 0.9 over 80ms ease outCubic;`);
  const checked = checkCutModule(parse(source));
  assert.deepEqual(checked.diagnostics, []);
  const ir = compileCutModule(checked.module).ir, processor = node(ir, "cut.audio.deesser");
  const kernel = referenceKernelSchema(processor.op);
  assert.ok(kernel?.support === "supported");
  assert.deepEqual(kernel.properties, ["intensity", "amount"]);
  assert.deepEqual(kernel.propertyTypes, { intensity: "Number", amount: "Number" });
  for (const property of ["intensity", "amount"] as const) {
    const reference = processor.properties[property];
    assert.ok("signal" in reference);
    if ("signal" in reference) assert.equal(ir.signals[reference.signal].valueType, "Number");
  }
  const config = referenceAudioNodeConfig(ir, ir.compositions[0], processor);
  assert.ok(config?.kind === "deesser");
  assert.equal(config.plan.format, "cut-reference-deesser-plan");
  assert.ok(Object.isFrozen(config.plan));
  assert.deepEqual(Object.keys(compileReferenceDeEsserAutomations(ir, ir.compositions[0], processor)), ["intensity", "amount"]);
});

test("static controls match equivalent exact sample-zero property writes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-deesser-static-parity-"));
  for (const [property, value] of [["intensity", "0.65"], ["amount", "0.8"]] as const) {
    const controls = property === "intensity" ? "intensity: 0.65, amount: 0.8" : "intensity: 0.65, amount: 0.8";
    const plain = await render(program(deEsser(excitation, controls)), root, `${property}-plain.wav`);
    const written = await render(program(`${deEsser(excitation, controls)} set deess.${property} = ${value};`), root, `${property}-property.wav`);
    assert.deepEqual(written.pcm.bytes, plain.pcm.bytes, property);
  }
});

test("an exact-sample amount event follows the TS core recurrence without resetting state", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-deesser-event-")), event = 1_440;
  const dry = await renderRaw(program(excitation), root, "dry.f32le");
  const before = await render(program(deEsser(excitation, "intensity: 0.8, amount: 0.2")), root, "before.wav");
  const dynamic = await render(program(`${deEsser(excitation, "intensity: 0.8, amount: 0.2")} at 30ms { set deess.amount = 1; }`), root, "dynamic.wav");
  assert.deepEqual(dynamic.pcm.bytes.subarray(0, event * 6), before.pcm.bytes.subarray(0, event * 6));
  assert.ok(Math.abs(dynamic.pcm.sample(event, 0) - before.pcm.sample(event, 0)) > 1e-5, "event sample retained the old amount");

  const controls = (frame: number) => ({ intensity: 0.8, amount: frame < event ? 0.2 : 1 });
  const continuous = coreModel(dry.pcm, dynamic.ir, controls);
  const reset = coreModel(dry.pcm, dynamic.ir, controls, event);
  assertModelSamples(dynamic.pcm, continuous, [0, 1, event - 1, event, event + 1, event + 64, 4_799], "exact event");
  assertFullModel(dynamic.pcm, continuous, "exact event");
  let continuousError = 0, resetError = 0;
  for (let frame = event; frame < event + 512; frame += 1) for (const channel of [0, 1]) {
    continuousError += (dynamic.pcm.sample(frame, channel) - continuous[frame][channel]) ** 2;
    resetError += (dynamic.pcm.sample(frame, channel) - reset[frame][channel]) ** 2;
  }
  assert.ok(continuousError * 100 < resetError, `state reset was not decisively disproved: continuous=${continuousError} reset=${resetError}`);
});

test("linear and outCubic intensity/amount tracks match the TS core recurrence", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-deesser-curves-")), end = 3_840;
  const dry = await renderRaw(program(excitation), root, "dry.f32le");
  for (const property of ["intensity", "amount"] as const) for (const curve of ["linear", "outCubic"] as const) {
    const filtered = await render(
      program(`${deEsser(excitation, "intensity: 0.2, amount: 0.2")} animate deess.${property} from 0.2 to 0.9 over 80ms ease ${curve};`),
      root,
      `${property}-${curve}.wav`,
    );
    const expected = coreModel(dry.pcm, filtered.ir, (frame) => {
      const progress = Math.min(1, frame / end), eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
      const value = 0.2 + 0.7 * eased;
      return { intensity: property === "intensity" ? value : 0.2, amount: property === "amount" ? value : 0.2 };
    });
    assertModelSamples(filtered.pcm, expected, [0, 1, 127, 1_440, end - 1, end, 4_799], `${property} ${curve}`);
    assertFullModel(filtered.pcm, expected, `${property} ${curve}`);
  }
});

function automationError(source: string, code: ReferenceAudioAutomationError["code"], message: RegExp) {
  const ir = compile(source);
  ir.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioAutomationError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });
}

test("DeEsser automation fails closed on source and hostile loaded IR boundaries", () => {
  const wrongType = checkCutModule(parse(program(`${deEsser()} set deess.amount = 50%;`))).diagnostics;
  assert.ok(wrongType.some((item) => item.code === "CUT2035" && /Number.*Ratio/.test(item.message)), JSON.stringify(wrongType));
  const unknown = checkCutModule(parse(program(`${deEsser()} set deess.threshold = -20db;`))).diagnostics;
  assert.ok(unknown.some((item) => item.code === "CUT2060" && /no executable property.*threshold/.test(item.message)), JSON.stringify(unknown));
  for (const [body, code, message] of [
    [`${deEsser()} set deess.intensity = 1.01;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /DeEsser\.intensity.*between 0 and 1/],
    [`${deEsser()} set deess.amount = -0.01;`, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /DeEsser\.amount.*between 0 and 1/],
    [`${deEsser()} at 0.1ms { set deess.amount = 0.8; }`, "CUT_AUDIO_AUTOMATION_SAMPLE_GRID", /event start does not land/],
    [`${deEsser()} animate deess.intensity from 0.2 to 0.8 over 80ms ease spring();`, "CUT_AUDIO_AUTOMATION_EASING", /only linear and outCubic/],
  ] as const) automationError(program(body), code, message);

  const missing = compile(program(`${deEsser()} set deess.amount = 0.8;`));
  missing.determinism.semantic = "locked";
  const amount = node(missing, "cut.audio.deesser").properties.amount;
  assert.ok("signal" in amount);
  if ("signal" in amount) delete missing.signals[amount.signal];
  assert.throws(() => validateReferenceSession(missing), (error: unknown) => error instanceof ReferenceAudioAutomationError
    && error.code === "CUT_AUDIO_AUTOMATION_GRAPH"
    && error.source.line > 0);

  const hostile = compile(program(`${deEsser()} set deess.intensity = 0.8;`));
  hostile.determinism.semantic = "locked";
  const intensity = node(hostile, "cut.audio.deesser").properties.intensity;
  assert.ok("signal" in intensity);
  if ("signal" in intensity) hostile.signals[intensity.signal].valueType = "Ratio";
  assert.throws(() => validateReferenceSession(hostile), (error: unknown) => error instanceof ReferenceAudioAutomationError
    && error.code === "CUT_AUDIO_AUTOMATION_TYPE"
    && /valueType Number/.test(error.message)
    && error.source.line > 0);
  assert.throws(() => loadCutAvIr(JSON.stringify(hostile)), (error: unknown) => error instanceof CutAvIrValidationError
    && error.code === "CUT_IR_TYPE"
    && /must be Number for cut\.audio\.deesser\.intensity/.test(error.message));
});

test("DeEsser work limits fail source-located before a direct render allocates output", async () => {
  const many = Array.from({ length: referenceDeEsserCoreLimits.maximumNodesPerComposition + 1 }, (_, index) =>
    `DeEsser() { Tone(frequency: ${220 + index}hz, duration: 10ms, amplitude: 1%); }`).join("\n");
  const ir = compile(program(many, "10ms"));
  const reachable = new Set(Object.keys(ir.nodes));
  assert.throws(
    () => validateReferenceAudioAutomationBudget(ir, ir.compositions[0], reachable),
    (error: unknown) => error instanceof ReferenceAudioAutomationError
      && error.code === "CUT_AUDIO_DEESSER_WORK_LIMIT"
      && /nodes must stay between 1 and 16/.test(error.message)
      && error.source.line > 0,
  );
  const root = await mkdtemp(resolve(tmpdir(), "cut-deesser-work-")), output = resolve(root, "must-not-exist.wav");
  await assert.rejects(
    () => renderReferenceAudio(ir, ir.compositions[0], root, output),
    (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_DEESSER_WORK_LIMIT",
  );
  await assert.rejects(() => access(output), { code: "ENOENT" });

  const long = compile(program(
    "DeEsser() { Tone(frequency: 440hz, duration: 700s, amplitude: 1%); }",
    "700s",
    "192khz",
  ));
  assert.throws(
    () => validateReferenceAudioAutomationBudget(long, long.compositions[0], new Set(Object.keys(long.nodes))),
    (error: unknown) => error instanceof ReferenceAudioAutomationError
      && error.code === "CUT_AUDIO_DEESSER_WORK_LIMIT"
      && /268800000 channel-samples; maximum is 268435456/.test(error.message)
      && error.source.line > 0,
  );
});

function cacheFixture(target: number, fill: string) {
  return compile(`cut 0.4; project "DeEsser cache identity";
import { DeEsser, Noise } from "@cut/audio"; import { Rect } from "cut:visual"; import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Rect(width: 64px, height: 64px, fill: ${fill});
    DeEsser(intensity: 0.2, amount: 0.5) as deess { Noise(duration: 1s, color: "white", seed: 22); }
    animate deess.intensity from 0.2 to ${target} over 1s ease linear;
  }
} export out = render(main);`);
}

test("DeEsser plan and signals enter pre-master identity while picture edits stay local", () => {
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-deesser-test");
  const audioPlan = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), toolchain);
  const base = cacheFixture(0.8, "#112233"), signalEdit = cacheFixture(0.9, "#112233"), pictureEdit = cacheFixture(0.8, "#fedcba");
  const previous = createIncrementalRenderPlan(base, "main").manifest;
  const incremental = createIncrementalRenderPlan(signalEdit, "main", previous), processor = node(signalEdit, "cut.audio.deesser");
  assert.equal(incremental.nodes.find((item) => item.id === processor.id)?.status, "miss");
  assert.ok(incremental.scenes.every((scene) => scene.status === "hit"));
  assert.notEqual(base.buildId, signalEdit.buildId);
  assert.notEqual(audioPlan(base).key, audioPlan(signalEdit).key);
  assert.equal(audioPlan(base).key, audioPlan(pictureEdit).key);
  const execution = audioPlan(base).graph.nodesSha256;
  assert.equal(typeof execution, "string");
});
