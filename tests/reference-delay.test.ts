import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { builtinPackages } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { referenceMasterAudioRootIds, renderReferenceAudio } from "../lib/runtime/reference/audio";
import {
  compileReferenceAudioAutomation,
  ReferenceAudioAutomationError,
  referenceAudioAutomationLimits,
} from "../lib/runtime/reference/audio-automation";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity } from "../lib/runtime/reference/audio-cache";
import {
  ReferenceAudioConfigError,
  referenceAudioNodeConfig,
  referenceDelayLimits,
} from "../lib/runtime/reference/audio-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function program(body: string, duration = "50ms") {
  return `cut 0.4;
project "finite delay";
import { Delay, Noise, Tone } from "@cut/audio";
import { linear, outCubic, spring } from "@cut/motion";
timeline main(duration: ${duration}, fps: 24, sampleRate: 48khz) { ${body} }
export out = render(main);`;
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

function delayNode(ir: ReturnType<typeof compile>) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.audio.delay");
  assert.ok(node, "missing cut.audio.delay in typed IR");
  return node;
}

function assertConfigError(action: () => unknown, code: ReferenceAudioConfigError["code"], message: RegExp) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioConfigError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.ok("module" in error.source, "audio diagnostics must retain source provenance");
    assert.equal(error.source.module, "project.cut");
    assert.ok(error.source.line > 0 && error.source.column > 0);
    assert.equal(error.source.nodeId, error.nodeId);
    return true;
  });
}

type Pcm24 = {
  frames: number;
  data: Buffer<ArrayBufferLike>;
  sample(frame: number, channel: number): number;
};

function pcm24(buffer: Buffer): Pcm24 {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
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
  assert.equal(channels, 2);
  assert.equal(sampleRate, 48_000);
  assert.equal(blockAlign, 6);
  assert.equal(bits, 24);
  assert.ok(data.length > 0);
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
  return pcm24(await readFile(output));
}

test("Delay public syntax lowers to a closed typed IR node and strict finite-tap plan", () => {
  const ir = compile(program('Delay(time: 10ms, repeats: 3, decay: 50%, wet: 25%) { Noise(duration: 1ms, color: "white", seed: 7); }'));
  const node = delayNode(ir);
  assert.deepEqual(Object.keys(node.inputs).sort(), ["decay", "repeats", "time", "wet"]);
  assert.deepEqual(node.properties, {});
  assert.equal(node.children.length, 1);
  const config = referenceAudioNodeConfig(ir, ir.compositions[0], node);
  assert.equal(config?.kind, "delay");
  if (config?.kind === "delay") {
    assert.equal(config.delaySamples, 480);
    assert.equal(config.repeats, 3);
    assert.equal(config.decay, .5);
    assert.equal(config.wet, .25);
    assert.equal(config.tailSamples, 1_440);
    assert.deepEqual(config.taps.map(({ offsetSamples, normalizedWeight }) => [offsetSamples, Number(normalizedWeight.toFixed(9))]), [[480, 0.571428571], [960, 0.285714286], [1_440, 0.142857143]]);
  }
  assert.doesNotThrow(() => validateReferenceSession(ir));

  const defaults = compile(program('Delay(time: 10ms) { Noise(duration: 1ms, color: "white", seed: 7); }'));
  assert.deepEqual(referenceAudioNodeConfig(defaults, defaults.compositions[0], delayNode(defaults)), config);

  const manifest = builtinPackages.get("@cut/audio")?.symbols.Delay;
  assert.equal(manifest?.native, "cut.audio.delay");
  assert.deepEqual(manifest?.parameters?.map(({ name, type }) => [name, type]), [["time", "Time"], ["repeats", "Number"], ["decay", "Ratio"], ["wet", "Ratio"]]);
  const kernel = referenceKernelSchema("cut.audio.delay");
  assert.equal(kernel?.support, "supported");
  if (kernel?.support === "supported") {
    assert.deepEqual(kernel.inputs, ["time", "repeats", "decay", "wet"]);
    assert.deepEqual(kernel.properties, ["wet"]);
    assert.equal(kernel.minimumChildren, 1);
  }
});

test("Delay.wet is a closed typed sample-automation property while structural controls remain static", () => {
  const source = program('Delay(time: 10ms, wet: 40%) as echo { Tone(frequency: 440hz, duration: 20ms); } animate echo.wet from 40% to 100% over 10ms ease linear;');
  assert.deepEqual(checkCutModule(parse(source)).diagnostics, []);
  const ir = compile(source), node = delayNode(ir);
  assert.ok("signal" in node.properties.wet);
  const automation = compileReferenceAudioAutomation(ir, ir.compositions[0], node);
  assert.equal(automation?.property, "wet");
  assert.equal(automation?.eventCount, 1);
  assert.deepEqual(automation?.controlValues, [.4, .4, 1]);
  assert.doesNotThrow(() => validateReferenceSession(ir));

  const structural = checkCutModule(parse(program('Delay(time: 10ms) as echo { Tone(frequency: 440hz, duration: 20ms); } animate echo.time from 10ms to 20ms over 10ms;'))).diagnostics;
  assert.ok(structural.some((diagnostic) => diagnostic.code === "CUT2060" && /cut\.audio\.delay.*property.*time/.test(diagnostic.message)), JSON.stringify(structural));

  const unknown = checkCutModule(parse(program('Delay(time: 10ms, feedback: 50%) { Tone(frequency: 440hz, duration: 20ms); }'))).diagnostics;
  assert.ok(unknown.some((diagnostic) => diagnostic.code === "CUT2059" && /feedback/.test(diagnostic.message)), JSON.stringify(unknown));

  const wrongType = checkCutModule(parse(program('Delay(time: 50%) { Tone(frequency: 440hz, duration: 20ms); }'))).diagnostics;
  assert.ok(wrongType.some((diagnostic) => diagnostic.code === "CUT2029" && /expects Time, found Ratio/.test(diagnostic.message)), JSON.stringify(wrongType));
  assert.ok(referenceAudioAutomationLimits.properties.includes("Delay.wet"));
});

test("Delay refuses empty graphs and graph-dependent no-op controls at source locations", () => {
  const rejects = (body: string, message: RegExp) => assert.throws(() => compile(program(body)), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === "CUT2085");
    assert.ok(diagnostic);
    assert.match(diagnostic.message, message);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    return true;
  });
  rejects("Delay(time: 10ms);", /cut\.audio\.delay requires at least one audio child/);
  rejects('Delay(time: 10ms, repeats: 1, decay: 50%) { Tone(frequency: 440hz, duration: 20ms); }', /decay cannot affect a single-tap delay/);
  assert.doesNotThrow(() => compile(program('Delay(time: 10ms, repeats: 1) { Tone(frequency: 440hz, duration: 20ms); }')));
});

test("Delay runtime config enforces sample grid, value bounds, and cumulative resource cost", () => {
  const cases: Array<[string, ReferenceAudioConfigError["code"], RegExp, string?]> = [
    ['Delay(time: 0ms, wet: 25%) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /at least one output sample/],
    ['Delay(time: 0.1ms) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_SAMPLE_GRID", /does not land on the 48000 Hz sample grid/],
    ['Delay(time: 11s) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /at most 10 seconds/],
    ['Delay(time: 10ms, repeats: 1.5) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /repeats to be an integer/],
    ['Delay(time: 10ms, repeats: 0) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /repeats between 1 and 16/],
    ['Delay(time: 10ms, repeats: 17) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /repeats between 1 and 16/],
    ['Delay(time: 10ms, repeats: 2, decay: 0%) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /decay to be greater than 0%/],
    ['Delay(time: 10ms, repeats: 2, decay: 101%) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /decay between 0 and 1/],
    ['Delay(time: 10ms, wet: -1%) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /wet between 0 and 1/],
    ['Delay(time: 10ms, wet: 101%) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /wet between 0 and 1/],
    ['Delay(time: 4s, repeats: 8) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_RESOURCE_LIMIT", /at most 30 seconds/],
    ['Delay(time: 10ms, repeats: 5) { Tone(frequency: 440hz, duration: 20ms); }', "CUT_AUDIO_VALUE_RANGE", /final Delay tap.*before.*composition output boundary/, "50ms"],
  ];
  for (const [body, code, message, duration = "12s"] of cases) {
    const ir = compile(program(body, duration));
    assertConfigError(() => validateReferenceSession(ir), code, message);
  }

  const hostile = compile(program('Delay(time: 10ms) { Tone(frequency: 440hz, duration: 20ms); }'));
  delayNode(hostile).inputs.repeats = { kind: "string", value: "forever" };
  assertConfigError(() => validateReferenceSession(hostile), "CUT_AUDIO_INPUT_TYPE", /requires repeats to have dimension scalar; received string/);
  assert.deepEqual(referenceDelayLimits, { maximumTimeSeconds: 10, maximumRepeats: 16, maximumTailSeconds: 30 });
});

test("Delay renders exact finite taps and normalized decay while explicit inert controls fail closed", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-delay-"));
  const noise = 'Noise(duration: 1ms, color: "white", seed: 919, amplitude: 50%);';
  const dry = await render(program(noise), root, "dry.wav");
  const bypassIr = compile(program(`Delay(time: 10ms, repeats: 3, decay: 50%, wet: 25%) { ${noise} }`));
  delayNode(bypassIr).inputs.wet = { kind: "quantity", dimension: "ratio", magnitude: { numerator: "0", denominator: "1" }, unit: "ratio" };
  const bypassOutput = resolve(root, "bypass.wav");
  await assert.rejects(
    renderReferenceAudio(bypassIr, bypassIr.compositions[0], root, bypassOutput),
    /CUT_NODE_NOOP: Delay wet is 0%.*inert explicitly authored control/,
  );
  await assert.rejects(access(bypassOutput), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const delayIdentityA = delayNode(compile(program(`Delay(time: 10ms, repeats: 3, decay: 50%, wet: 25%) { ${noise} }`))).contentHash;
  const delayIdentityB = delayNode(compile(program(`Delay(time: 12ms, repeats: 3, decay: 50%, wet: 25%) { ${noise} }`))).contentHash;
  assert.notEqual(delayIdentityA, delayIdentityB, "executed structural controls must remain part of graph/cache identity");

  const delayedSource = program(`Delay(time: 10ms, repeats: 3, decay: 50%, wet: 100%) { ${noise} }`);
  const delayed = await render(delayedSource, root, "delayed.wav");
  const repeated = await render(delayedSource, root, "delayed-repeat.wav");
  const defaultMix = await render(program(`Delay(time: 10ms) { ${noise} }`), root, "default.wav");
  assert.equal(delayed.frames, 2_400);
  assert.equal(createHash("sha256").update(delayed.data).digest("hex"), createHash("sha256").update(repeated.data).digest("hex"));

  for (let frame = 0; frame < 480; frame += 1) {
    assert.equal(delayed.sample(frame, 0), 0, `100% wet emitted dry audio at frame ${frame}`);
    assert.equal(delayed.sample(frame, 1), 0, `100% wet emitted dry audio at frame ${frame}`);
  }
  const weights = [4 / 7, 2 / 7, 1 / 7], tolerance = 3 / 0x800000;
  for (const [tap, weight] of weights.entries()) {
    const offset = 480 * (tap + 1);
    for (let frame = 0; frame < 48; frame += 1) {
      for (const channel of [0, 1]) {
        const expected = dry.sample(frame, channel) * weight;
        assert.ok(Math.abs(delayed.sample(offset + frame, channel) - expected) <= tolerance, `tap ${tap + 1}, frame ${frame}, channel ${channel}`);
      }
    }
  }
  const insideTap = (frame: number) => weights.some((_, tap) => frame >= 480 * (tap + 1) && frame < 480 * (tap + 1) + 48);
  for (let frame = 0; frame < delayed.frames; frame += 1) {
    if (insideTap(frame)) continue;
    assert.equal(delayed.sample(frame, 0), 0, `unexpected recursive/tail audio at frame ${frame}`);
    assert.equal(delayed.sample(frame, 1), 0, `unexpected recursive/tail audio at frame ${frame}`);
  }
  for (let frame = 0; frame < defaultMix.frames; frame += 1) {
    for (const channel of [0, 1]) {
      let expected = frame < 48 ? dry.sample(frame, channel) * .75 : 0;
      for (const [tap, weight] of weights.entries()) {
        const sourceFrame = frame - 480 * (tap + 1);
        if (sourceFrame >= 0 && sourceFrame < 48) expected += dry.sample(sourceFrame, channel) * weight * .25;
      }
      assert.ok(Math.abs(defaultMix.sample(frame, channel) - expected) <= tolerance, `default mix frame ${frame}, channel ${channel}`);
    }
  }
});

test("Delay.wet set/linear/outCubic automation follows the destination sample clock without restarting taps", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-delay-automation-"));
  const noise = 'Noise(duration: 30ms, color: "white", seed: 1109, amplitude: 35%);';
  const dry = await render(program(noise, "60ms"), root, "dry.wav");
  const weights = [2 / 3, 1 / 3], offsets = [480, 960], tolerance = 7 / 0x800000;
  const expected = (frame: number, channel: number, wet: number) => {
    let value = frame < dry.frames ? dry.sample(frame, channel) * (1 - wet) : 0;
    for (let tap = 0; tap < offsets.length; tap += 1) {
      const sourceFrame = frame - offsets[tap];
      if (sourceFrame >= 0 && sourceFrame < dry.frames) value += dry.sample(sourceFrame, channel) * wet * weights[tap];
    }
    return value;
  };

  for (const curve of ["linear", "outCubic"] as const) {
    const source = program(`Delay(time: 10ms, repeats: 2, decay: 50%, wet: 0%) as echo { ${noise} }
      animate echo.wet from 0% to 100% over 40ms ease ${curve};`, "60ms");
    const rendered = await render(source, root, `${curve}.wav`), end = 1_920;
    for (const frame of [0, 1, 479, 480, 959, 960, 1_200, end - 1, end, 2_200, 2_879]) {
      const progress = Math.min(1, frame / end);
      const wet = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
      for (const channel of [0, 1]) {
        assert.ok(Math.abs(rendered.sample(frame, channel) - expected(frame, channel, wet)) <= tolerance, `${curve} frame ${frame}:${channel}`);
      }
    }
  }

  const old = await render(program(`Delay(time: 10ms, repeats: 2, decay: 50%, wet: 25%) { ${noise} }`, "60ms"), root, "old.wav");
  const stepped = await render(program(`Delay(time: 10ms, repeats: 2, decay: 50%, wet: 25%) as echo { ${noise} }
    at 20ms { set echo.wet = 100%; }`, "60ms"), root, "stepped.wav");
  const event = 960;
  for (let frame = 0; frame < event; frame += 1) {
    for (const channel of [0, 1]) {
      assert.ok(Math.abs(stepped.sample(frame, channel) - old.sample(frame, channel)) <= tolerance, `sample before set boundary changed at ${frame}:${channel}`);
    }
  }
  for (const channel of [0, 1]) {
    assert.ok(Math.abs(stepped.sample(event, channel) - expected(event, channel, 1)) <= tolerance, `set boundary ${channel}`);
  }
});

test("Delay.wet automation fails closed for type, bounds, easing, timing, and hostile signals", () => {
  const wrongType = checkCutModule(parse(program('Delay(time: 10ms) as echo { Tone(frequency: 440hz, duration: 20ms); } set echo.wet = 3db;'))).diagnostics;
  assert.ok(wrongType.some((diagnostic) => diagnostic.code === "CUT2035" && /Cannot set Ratio to Gain/.test(diagnostic.message)), JSON.stringify(wrongType));

  const springCurve = compile(program('Delay(time: 10ms) as echo { Tone(frequency: 440hz, duration: 20ms); } animate echo.wet from 0% to 100% over 10ms ease spring();'));
  assert.throws(() => validateReferenceSession(springCurve), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioAutomationError);
    assert.equal(error.code, "CUT_AUDIO_AUTOMATION_EASING");
    assert.equal(error.source.module, "project.cut");
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });

  const offGrid = compile(program('Delay(time: 10ms) as echo { Tone(frequency: 440hz, duration: 20ms); } at 0.1ms { set echo.wet = 50%; }'));
  assert.throws(() => validateReferenceSession(offGrid), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_SAMPLE_GRID");

  const hostile = compile(program('Delay(time: 10ms) as echo { Tone(frequency: 440hz, duration: 20ms); } set echo.wet = 50%;'));
  const reference = delayNode(hostile).properties.wet;
  assert.ok("signal" in reference);
  if ("signal" in reference) {
    const signal = hostile.signals[reference.signal];
    assert.equal(signal.kind, "track");
    if (signal.kind === "track" && signal.events[0]?.kind === "set") signal.events[0].value = { kind: "quantity", dimension: "ratio", magnitude: { numerator: "2", denominator: "1" }, unit: "ratio" };
  }
  assert.throws(() => validateReferenceSession(hostile), (error: unknown) => error instanceof ReferenceAudioAutomationError && error.code === "CUT_AUDIO_AUTOMATION_VALUE_RANGE" && /Delay\.wet/.test(error.message));
});

test("Delay.wet signal content participates in semantic and pre-master audio cache identity", () => {
  const source = (curve: "linear" | "outCubic") => program(`Delay(time: 10ms, repeats: 2) as echo {
    Noise(duration: 30ms, color: "white", seed: 31, amplitude: 20%);
  }
  animate echo.wet from 10% to 90% over 40ms ease ${curve};`, "50ms");
  const linear = compile(source("linear")), repeated = compile(source("linear")), cubic = compile(source("outCubic"));
  assert.equal(linear.buildId, repeated.buildId);
  assert.notEqual(linear.buildId, cubic.buildId);
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-delay-automation-test");
  const cache = (ir: ReturnType<typeof compile>) => createReferenceAudioCachePlan(
    ir,
    ir.compositions[0],
    referenceMasterAudioRootIds(ir, ir.compositions[0]),
    toolchain,
  ).key;
  assert.equal(cache(linear), cache(repeated));
  assert.notEqual(cache(linear), cache(cubic));
});
