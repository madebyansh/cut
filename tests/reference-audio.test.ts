import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseCutLanguage } from "../lib/language/parser";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRSignal } from "../lib/language/ir";
import { normalizeReferenceAudio, renderReferenceAudio } from "../lib/runtime/reference/audio";
import { ReferenceAudioConfigError, referenceAudioNodeConfig } from "../lib/runtime/reference/audio-config";
import { ReferenceAudioAutomationError, type ReferenceAudioAutomationErrorCode } from "../lib/runtime/reference/audio-automation";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function audioNode(ir: CutAVIR, op: string): IRNode {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(node, `missing ${op}`);
  return node;
}

function assertAudioConfigError(action: () => unknown, code: ReferenceAudioConfigError["code"]) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioConfigError);
    assert.equal(error.code, code);
    assert.match(error.message, /CUT_AUDIO_[A-Z_]+: .* at .*:\d+:\d+ /);
    return true;
  });
}

function hostileDiagnosticString() {
  const preview = `${"x\u0000\n".repeat(31)}xx😀`;
  assert.equal([...preview].length, 96, "the preview boundary must end on a supplementary Unicode scalar");
  return { preview, value: `${preview}${"🧪\u0000\n".repeat(5_000)}` };
}

function assertBoundedHostileDiagnostic(message: string, preview: string, value: string) {
  assert.ok(Buffer.byteLength(message, "utf8") < 1_024, "hostile value must not amplify the diagnostic past 1 KiB");
  assert.ok(message.includes(JSON.stringify(preview)), "the bounded preview must retain the complete boundary scalar");
  assert.ok(message.includes(`${[...value].length} Unicode code points; ${Buffer.byteLength(value, "utf8")} UTF-8 bytes`));
  assert.equal(Buffer.from(message, "utf8").toString("utf8"), message, "the diagnostic must not contain a split surrogate pair");
  assert.doesNotMatch(message, /[\u0000-\u001f\u007f]/u, "control characters must remain JSON escaped");
}

async function renderProgram(source: string, directory: string, name: string) {
  const ir = compile(source), output = resolve(directory, name);
  await renderReferenceAudio(ir, ir.compositions[0], directory, output);
  return readFile(output);
}

function pcm24Data(buffer: Buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.equal(channels, 2); assert.equal(sampleRate, 48_000); assert.equal(blockAlign, 6); assert.equal(bits, 24); assert.ok(data.length > 0);
  const sample = (frame: number, channel: number) => {
    const position = frame * blockAlign + channel * 3; let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000; return value / 0x800000;
  };
  return { frames: data.length / blockAlign, sample };
}

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2, buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(Math.max(-32_768, Math.min(32_767, sample)), 44 + index * 2));
  return buffer;
}

function channelRms(pcm: ReturnType<typeof pcm24Data>, startFrame = 0, endFrame = pcm.frames, channel = 0) {
  let energy = 0, count = 0;
  for (let frame = startFrame; frame < Math.min(endFrame, pcm.frames); frame += 1) {
    const value = pcm.sample(frame, channel); energy += value * value; count += 1;
  }
  assert.ok(count > 0);
  return Math.sqrt(energy / count);
}

test("reference audio keeps procedural placement sample-exact and compensates limiter latency", { timeout: 30_000 }, async () => {
  const ir = compile('cut 0.4; project "placed tone"; import { Tone, Limiter } from "@cut/audio"; timeline main(duration: 2s, fps: 24, sampleRate: 48khz) { Limiter(ceiling: -1dbtp) { at 1s { Tone(frequency: 1000hz, duration: 250ms, amplitude: 50%); } } } export out = render(main);');
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-audio-")), output = resolve(directory, "placed.wav");
  await renderReferenceAudio(ir, ir.compositions[0], directory, output);
  const pcm = pcm24Data(await readFile(output)); assert.equal(pcm.frames, 96_000);
  let first = -1, peak = 0;
  for (let frame = 0; frame < pcm.frames; frame += 1) {
    const value = Math.abs(pcm.sample(frame, 0)); if (first < 0 && value > 1e-6) first = frame; peak = Math.max(peak, value);
  }
  // A sine starts at zero, so its first non-zero sample is one sample after the
  // exact 48,000-sample placement. Limiter lookahead must not move that onset.
  assert.equal(first, 48_001); assert.ok(peak > .35 && peak < .36, `unexpected channel peak ${peak}`);
});

test("reference Pan at center is unity rather than an accidental minus 3 dB", { timeout: 30_000 }, async () => {
  const source = (pan: boolean) => `cut 0.4; project "pan"; import { Tone${pan ? ", Pan" : ""} } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { ${pan ? "Pan(position: 0%) {" : ""} Tone(frequency: 1000hz, duration: 1s, amplitude: 25%); ${pan ? "}" : ""} } export out = render(main);`;
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-pan-"));
  const peaks: number[] = [];
  for (const [index, pan] of [false, true].entries()) {
    const ir = compile(source(pan)), output = resolve(directory, `${index}.wav`); await renderReferenceAudio(ir, ir.compositions[0], directory, output); const pcm = pcm24Data(await readFile(output));
    let peak = 0; for (let frame = 0; frame < pcm.frames; frame += 1) peak = Math.max(peak, Math.abs(pcm.sample(frame, 0))); peaks.push(peak);
  }
  assert.ok(Math.abs(peaks[0] - peaks[1]) < 1e-6, `${peaks[0]} versus ${peaks[1]}`);
});

test("ChannelMatrix lowers one closed stereo matrix and swaps decoded channels exactly", { timeout: 30_000 }, async () => {
  const child = 'Submix(name: "stereo-source") { Pan(position: -100%) { Tone(frequency: 440hz, duration: 100ms, amplitude: 10%); } Pan(position: 100%) { Tone(frequency: 880hz, duration: 100ms, amplitude: 7%); } }';
  const source = (matrix: boolean) => `cut 0.4; project "channel matrix ${matrix}"; import { ChannelMatrix, Pan, Submix, Tone } from "@cut/audio"; timeline main(duration: 100ms, fps: 20, sampleRate: 48khz) { ${matrix ? "ChannelMatrix(leftToLeft: 0, leftToRight: 1, rightToLeft: 1, rightToRight: 0) {" : ""} ${child} ${matrix ? "}" : ""} } export out = render(main);`;
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-channel-matrix-"));
  const dryIr = compile(source(false)), dryPath = resolve(directory, "dry.wav");
  const swapIr = compile(source(true)), swapPath = resolve(directory, "swap.wav");
  await renderReferenceAudio(dryIr, dryIr.compositions[0], directory, dryPath);
  await renderReferenceAudio(swapIr, swapIr.compositions[0], directory, swapPath);
  const dry = pcm24Data(await readFile(dryPath)), swap = pcm24Data(await readFile(swapPath));
  assert.equal(swap.frames, dry.frames);
  for (let frame = 0; frame < dry.frames; frame += 1) {
    assert.equal(swap.sample(frame, 0), dry.sample(frame, 1), `right-to-left mismatch at frame ${frame}`);
    assert.equal(swap.sample(frame, 1), dry.sample(frame, 0), `left-to-right mismatch at frame ${frame}`);
  }
  const matrix = audioNode(swapIr, "cut.audio.channel_matrix");
  assert.deepEqual(referenceAudioNodeConfig(swapIr, swapIr.compositions[0], matrix), {
    kind: "channel-matrix",
    leftToLeft: 0,
    leftToRight: 1,
    rightToLeft: 1,
    rightToRight: 0,
  });
});

test("ChannelMatrix rejects inert, malformed, and out-of-range matrices before backend work", () => {
  assert.throws(
    () => compile('cut 0.4; project "identity matrix"; import { ChannelMatrix, Tone } from "@cut/audio"; timeline main(duration: 100ms, fps: 20, sampleRate: 48khz) { ChannelMatrix(leftToLeft: 1, leftToRight: 0, rightToLeft: 0, rightToRight: 1) { Tone(frequency: 440hz, duration: 100ms); } } export out = render(main);'),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "result" in error);
      const diagnostics = (error as { result: { diagnostics: Array<{ message: string }> } }).result.diagnostics;
      assert.ok(diagnostics.some((item) => /ChannelMatrix is the exact stereo identity/.test(item.message)), JSON.stringify(diagnostics));
      return true;
    },
  );
  const ir = compile('cut 0.4; project "hostile matrix"; import { ChannelMatrix, Tone } from "@cut/audio"; timeline main(duration: 100ms, fps: 20, sampleRate: 48khz) { ChannelMatrix(leftToLeft: 0, leftToRight: 1, rightToLeft: 1, rightToRight: 0) { Tone(frequency: 440hz, duration: 100ms); } } export out = render(main);');
  const matrix = audioNode(ir, "cut.audio.channel_matrix");
  matrix.inputs.leftToLeft = { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: { numerator: "5", denominator: "1" } };
  assertAudioConfigError(
    () => referenceAudioNodeConfig(ir, ir.compositions[0], matrix),
    "CUT_AUDIO_VALUE_RANGE",
  );
  matrix.inputs.leftToLeft = { kind: "string", value: "1" };
  assertAudioConfigError(
    () => referenceAudioNodeConfig(ir, ir.compositions[0], matrix),
    "CUT_AUDIO_INPUT_TYPE",
  );
});

test("Gain.amount set automation switches on the exact decoded sample", { timeout: 30_000 }, async () => {
  const source = 'cut 0.4; project "gain set"; import { Gain, Tone } from "@cut/audio"; timeline main(duration: 1.5s, fps: 24, sampleRate: 48khz) { scene lead(duration: 500ms) {} scene audio(duration: 1s) { Gain(amount: -18db) as fader { Tone(frequency: 1000hz, duration: 1s, amplitude: 25%); } at 500ms { set fader.amount = 0db; } } } export out = render(main);';
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-gain-set-")), output = resolve(directory, "gain-set.wav"), ir = compile(source);
  await renderReferenceAudio(ir, ir.compositions[0], directory, output);
  const pcm = pcm24Data(await readFile(output));
  // The audio scene begins at sample 24,000. Its local 500 ms write therefore
  // lands at global sample 48,000. Adjacent samples have equal-magnitude sine
  // values on opposite sides of that exact zero crossing.
  const before = Math.abs(pcm.sample(47_999, 0)), after = Math.abs(pcm.sample(48_001, 0));
  assert.ok(Math.abs(after / before - 10 ** (18 / 20)) < .03, `${before} -> ${after}`);
});

test("Gain.amount linear and outCubic automation execute in dB at each sample", { timeout: 30_000 }, async () => {
  const source = (curve: "linear" | "outCubic") => `cut 0.4; project "gain ${curve}"; import { Gain, Tone } from "@cut/audio"; import { ${curve} } from "@cut/motion"; timeline main(duration: 2s, fps: 24, sampleRate: 48khz) { Gain(amount: -12db) as fader { Tone(frequency: 1000hz, duration: 2s, amplitude: 25%); } animate fader.amount from -12db to 0db over 1s ease ${curve}; } export out = render(main);`;
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-gain-curve-"));
  for (const curve of ["linear", "outCubic"] as const) {
    const ir = compile(source(curve)), output = resolve(directory, `${curve}.wav`); await renderReferenceAudio(ir, ir.compositions[0], directory, output);
    const pcm = pcm24Data(await readFile(output)), sample = 24_012, progress = sample / 48_000;
    const eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3, expectedDb = -12 + 12 * eased, decodedStereoPeak = .25 / Math.sqrt(2), expected = decodedStereoPeak * 10 ** (expectedDb / 20);
    assert.ok(Math.abs(Math.abs(pcm.sample(sample, 0)) - expected) < 5e-5, `${curve}: ${pcm.sample(sample, 0)} versus ${expected}`);
    assert.ok(Math.abs(Math.abs(pcm.sample(48_012, 0)) - decodedStereoPeak) < 5e-5, `${curve} did not hold its final value`);
  }
});

test("Pan.position automation moves stereo energy on exact sample-domain coefficients", { timeout: 30_000 }, async () => {
  const source = 'cut 0.4; project "pan automate"; import { Pan, Tone } from "@cut/audio"; import { linear } from "@cut/motion"; timeline main(duration: 2s, fps: 24, sampleRate: 48khz) { Pan(position: -100%) as camera { Tone(frequency: 1000hz, duration: 2s, amplitude: 25%); } animate camera.position from -100% to 100% over 1s ease linear; } export out = render(main);';
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-pan-automation-")), output = resolve(directory, "pan.wav"), ir = compile(source);
  await renderReferenceAudio(ir, ir.compositions[0], directory, output);
  const pcm = pcm24Data(await readFile(output));
  const early = [Math.abs(pcm.sample(12, 0)), Math.abs(pcm.sample(12, 1))];
  const middle = [Math.abs(pcm.sample(24_012, 0)), Math.abs(pcm.sample(24_012, 1))];
  const final = [Math.abs(pcm.sample(48_012, 0)), Math.abs(pcm.sample(48_012, 1))];
  const decodedStereoPeak = .25 / Math.sqrt(2);
  assert.ok(Math.abs(early[0] - decodedStereoPeak) < 1e-4 && early[1] < .001, JSON.stringify(early));
  assert.ok(Math.abs(middle[0] - decodedStereoPeak) < 5e-5 && Math.abs(middle[1] - decodedStereoPeak) < .001, JSON.stringify(middle));
  assert.ok(final[0] < 1e-6 && Math.abs(final[1] - decodedStereoPeak) < 5e-5, JSON.stringify(final));
});

test("Reverb.wet lowers through the public property surface into an executable track signal", () => {
  const ir = compile('cut 0.4; project "wet signal"; import { Reverb, Tone } from "@cut/audio"; import { linear } from "@cut/motion"; timeline main(duration: 2s, fps: 24, sampleRate: 48khz) { Reverb(wet: 0%) as room { Tone(frequency: 440hz, duration: 2s); } animate room.wet from 0% to 100% over 1s ease linear; } export out = render(main);');
  const room = audioNode(ir, "cut.audio.reverb"), property = room.properties.wet;
  assert.ok(property && "signal" in property);
  const signal = property && "signal" in property ? ir.signals[property.signal] : undefined;
  assert.equal(signal?.kind, "track");
  if (signal?.kind === "track") {
    assert.equal(signal.initial.kind, "quantity");
    assert.equal(signal.events.length, 1);
  }
  assert.doesNotThrow(() => validateReferenceSession(ir));
});

test("Reverb.wet set and curves mix one continuously running effect state at exact samples", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-reverb-automation-"));
  const program = (name: string, wet: string, mutation = "", motionImport = "") => `cut 0.4; project "${name}"; import { Noise, Reverb } from "@cut/audio"; ${motionImport} timeline main(duration: 2s, fps: 24, sampleRate: 48khz) { Reverb(wet: ${wet}) as room { Noise(duration: 2s, color: "white", seed: 9182, amplitude: 20%); } ${mutation} } export out = render(main);`;
  const render = async (name: string, wet: string, mutation = "", motionImport = "") => pcm24Data(await renderProgram(program(name, wet, mutation, motionImport), directory, `${name}.wav`));
  const dry = await render("dry", "0%"), wet = await render("wet", "100%");
  const switched = await render("switched", "0%", "at 1s { set room.wet = 100%; }");
  const linear = await render("linear-wet", "0%", "animate room.wet from 0% to 100% over 1s ease linear;", 'import { linear } from "@cut/motion";');
  const cubic = await render("cubic-wet", "0%", "animate room.wet from 0% to 100% over 1s ease outCubic;", 'import { outCubic } from "@cut/motion";');

  assert.equal(dry.frames, 96_000); assert.equal(wet.frames, 96_000);
  for (const channel of [0, 1]) {
    for (const sample of [12_345, 47_999]) assert.equal(switched.sample(sample, channel), dry.sample(sample, channel), `dry parity at ${sample}:${channel}`);
    for (const sample of [48_000, 60_123, 90_001]) assert.equal(switched.sample(sample, channel), wet.sample(sample, channel), `wet parity at ${sample}:${channel}`);
    for (const [rendered, weight] of [[linear, .5], [cubic, .875]] as const) {
      const sample = 24_000, expected = dry.sample(sample, channel) * (1 - weight) + wet.sample(sample, channel) * weight;
      assert.ok(Math.abs(rendered.sample(sample, channel) - expected) <= 4 / 0x800000, `${weight} wet at ${sample}:${channel}`);
      assert.equal(rendered.sample(48_012, channel), wet.sample(48_012, channel), `held wet endpoint at ${channel}`);
    }
  }
  assert.notEqual(dry.sample(48_000, 0), wet.sample(48_000, 0), "fixture must distinguish dry and continuously running wet state at the switch");
});

test("audio automation validator refuses unsupported curves, signal kinds, values, and sample positions", () => {
  const source = 'cut 0.4; project "automation refusal"; import { Gain, Tone } from "@cut/audio"; import { linear } from "@cut/motion"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { scene only(duration: 1s) { Gain(amount: -12db) as fader { Tone(frequency: 1000hz, duration: 1s); } animate fader.amount from -12db to 0db over 500ms ease linear; } } export out = render(main);';
  const fresh = () => compile(source), signalOf = (ir: ReturnType<typeof compile>) => Object.values(ir.signals)[0] as Extract<IRSignal, { kind: "track" }>;
  const rejected = (ir: ReturnType<typeof compile>, code: ReferenceAudioAutomationErrorCode, message: RegExp) => assert.throws(() => validateReferenceSession(ir), (error) => {
    assert.ok(error instanceof ReferenceAudioAutomationError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.equal(error.source.nodeId, error.nodeId);
    assert.equal(error.source.module, "project.cut");
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });

  const curveIr = fresh(), curveSignal = signalOf(curveIr), curveEvent = curveSignal.events[0]; assert.equal(curveEvent.kind, "animate");
  if (curveEvent.kind === "animate") curveEvent.curve = { kind: "symbol", name: "@cut/motion#spring" };
  rejected(curveIr, "CUT_AUDIO_AUTOMATION_EASING", /does not implement easing.*spring/);

  const shapeIr = fresh(), shapeSignal = signalOf(shapeIr), node = Object.values(shapeIr.nodes).find((item) => item.op === "cut.audio.gain")!;
  shapeIr.signals[shapeSignal.id] = { id: shapeSignal.id, kind: "constant", valueType: "Gain", value: { kind: "quantity", dimension: "gain", magnitude: { numerator: "0", denominator: "1" }, unit: "db" }, contentHash: shapeSignal.contentHash, provenance: shapeSignal.provenance };
  rejected(shapeIr, "CUT_AUDIO_AUTOMATION_SIGNAL", /requires a track signal; constant is unsupported/);

  const valueIr = fresh(), valueSignal = signalOf(valueIr); valueSignal.initial = { kind: "string", value: "loud" };
  rejected(valueIr, "CUT_AUDIO_AUTOMATION_TYPE", /requires a gain quantity/);

  const sampleIr = fresh(), sampleSignal = signalOf(sampleIr), sampleEvent = sampleSignal.events[0]; assert.equal(sampleEvent.kind, "animate");
  if (sampleEvent.kind === "animate") sampleEvent.start = { numerator: "1", denominator: "48001" };
  rejected(sampleIr, "CUT_AUDIO_AUTOMATION_SAMPLE_GRID", /does not land on a 48000 Hz sample boundary/);

  const timingIr = fresh(), timingSignal = signalOf(timingIr), timingEvent = timingSignal.events[0]; assert.equal(timingEvent.kind, "animate");
  if (timingEvent.kind === "animate") timingEvent.end = { numerator: "2", denominator: "1" };
  rejected(timingIr, "CUT_AUDIO_AUTOMATION_TIMING", /animate end.*lies outside its owning node interval/);

  const budgetIr = fresh(), budgetSignal = signalOf(budgetIr); budgetSignal.events = Array.from({ length: 65 }, () => ({ ...budgetSignal.events[0] }));
  rejected(budgetIr, "CUT_AUDIO_AUTOMATION_LIMIT", /exceeds the 64-event limit/);

  const boundIr = fresh(), boundSignal = signalOf(boundIr), boundEvent = boundSignal.events[0]; assert.equal(boundEvent.kind, "animate");
  if (boundEvent.kind === "animate") boundEvent.from = { kind: "quantity", dimension: "gain", magnitude: { numerator: "-193", denominator: "1" }, unit: "db" };
  rejected(boundIr, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /must stay between -192 dB and \+60 dB/);

  const missingIr = fresh(), missingNode = audioNode(missingIr, "cut.audio.gain");
  missingNode.properties.amount = { signal: "cut.signal.missing" };
  rejected(missingIr, "CUT_AUDIO_AUTOMATION_GRAPH", /references missing signal cut\.signal\.missing/);

  const wetIr = compile('cut 0.4; project "bad wet automation"; import { Reverb, Tone } from "@cut/audio"; import { linear } from "@cut/motion"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Reverb(wet: 0%) as room { Tone(frequency: 440hz, duration: 1s); } animate room.wet from 0% to 100% over 1s ease linear; } export out = render(main);');
  const wetSignal = Object.values(wetIr.signals)[0]; assert.equal(wetSignal.kind, "track");
  if (wetSignal.kind === "track" && wetSignal.events[0].kind === "animate") wetSignal.events[0].to = { kind: "quantity", dimension: "ratio", magnitude: { numerator: "2", denominator: "1" }, unit: "ratio" };
  rejected(wetIr, "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /Reverb\.wet.*between 0% and 100%/);

  node.properties.gain = node.properties.amount;
  assert.throws(() => validateReferenceSession(shapeIr), /does not execute property.*gain/);
});

test("reference audio configuration rejects malformed loaded IR instead of clamping or substituting defaults", () => {
  const tone = compile('cut 0.4; project "bad tone"; import { Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Tone(frequency: 440hz, duration: 1s); } export out = render(main);');
  audioNode(tone, "cut.audio.tone").inputs.frequency = { kind: "quantity", dimension: "frequency", magnitude: { numerator: "-10", denominator: "1" }, unit: "hz" };
  assertAudioConfigError(() => referenceAudioNodeConfig(tone, tone.compositions[0], audioNode(tone, "cut.audio.tone")), "CUT_AUDIO_VALUE_RANGE");

  const noise = compile('cut 0.4; project "bad noise"; import { Noise } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Noise(duration: 1s, color: "pink", seed: 7); } export out = render(main);');
  audioNode(noise, "cut.audio.noise").inputs.color = { kind: "string", value: "infrared" };
  assertAudioConfigError(() => referenceAudioNodeConfig(noise, noise.compositions[0], audioNode(noise, "cut.audio.noise")), "CUT_AUDIO_ENUM");

  const pan = compile('cut 0.4; project "bad pan"; import { Pan, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Pan(position: 0%) { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  audioNode(pan, "cut.audio.pan").inputs.position = { kind: "quantity", dimension: "ratio", magnitude: { numerator: "3", denominator: "2" }, unit: "ratio" };
  assertAudioConfigError(() => referenceAudioNodeConfig(pan, pan.compositions[0], audioNode(pan, "cut.audio.pan")), "CUT_AUDIO_VALUE_RANGE");

  const eq = compile('cut 0.4; project "bad eq"; import { EQ, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { EQ() { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  audioNode(eq, "cut.audio.eq").inputs.frequency = { kind: "string", value: "voice" };
  assertAudioConfigError(() => referenceAudioNodeConfig(eq, eq.compositions[0], audioNode(eq, "cut.audio.eq")), "CUT_AUDIO_INPUT_TYPE");

  const subHertzEq = compile('cut 0.4; project "sub hertz eq"; import { ParametricEQ, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 8khz) { ParametricEQ(frequency: 0.5hz, gain: 3db) { Tone(frequency: 440hz, duration: 1s); } } export out = render(main);');
  assertAudioConfigError(() => referenceAudioNodeConfig(subHertzEq, subHertzEq.compositions[0], audioNode(subHertzEq, "cut.audio.eq")), "CUT_AUDIO_VALUE_RANGE");

  const sidechain = compile('cut 0.4; project "bad sidechain"; import { Tone, Sidechain } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Tone(frequency: 2000hz, duration: 1s, amplitude: 5%) as key; Sidechain(source: key, amount: -8db) { Tone(frequency: 220hz, duration: 1s); } } export out = render(main);');
  audioNode(sidechain, "cut.audio.sidechain").inputs.amount = { kind: "quantity", dimension: "gain", magnitude: { numerator: "6", denominator: "1" }, unit: "db" };
  assertAudioConfigError(() => referenceAudioNodeConfig(sidechain, sidechain.compositions[0], audioNode(sidechain, "cut.audio.sidechain")), "CUT_AUDIO_VALUE_RANGE");

  const offGrid = compile('cut 0.4; project "bad fade"; import { Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Tone(frequency: 440hz, duration: 1s); } export out = render(main);');
  audioNode(offGrid, "cut.audio.tone").inputs.fadeIn = { kind: "quantity", dimension: "time", magnitude: { numerator: "1", denominator: "48001" }, unit: "s" };
  assertAudioConfigError(() => referenceAudioNodeConfig(offGrid, offGrid.compositions[0], audioNode(offGrid, "cut.audio.tone")), "CUT_AUDIO_SAMPLE_GRID");

  const placement = compile('cut 0.4; project "bad placement"; import { Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Tone(frequency: 440hz, duration: 1s); } export out = render(main);');
  audioNode(placement, "cut.audio.tone").interval.start = { numerator: "1", denominator: "48001" };
  assertAudioConfigError(() => referenceAudioNodeConfig(placement, placement.compositions[0], audioNode(placement, "cut.audio.tone")), "CUT_AUDIO_SAMPLE_GRID");
});

test("Noise.color runtime diagnostics bound hostile Unicode and control strings", () => {
  const ir = compile('cut 0.4; project "bounded noise diagnostic"; import { Noise } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Noise(duration: 1s, color: "pink", seed: 7); } export out = render(main);');
  const noise = audioNode(ir, "cut.audio.noise"), hostile = hostileDiagnosticString();
  noise.inputs.color = { kind: "string", value: hostile.value };
  assert.throws(() => referenceAudioNodeConfig(ir, ir.compositions[0], noise), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioConfigError);
    assert.equal(error.code, "CUT_AUDIO_ENUM");
    assert.deepEqual(error.source, {
      module: "project.cut",
      line: noise.provenance.span.start.line,
      column: noise.provenance.span.start.column,
      nodeId: noise.id,
    });
    assertBoundedHostileDiagnostic(error.message, hostile.preview, hostile.value);
    return true;
  });
});

test("AudioClip and Narration enforce locked source and output sample grids plus non-negative fades", () => {
  const fixtures = [
    { op: "cut.audio.clip", source: 'import { AudioClip } from "@cut/audio"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { AudioClip(source: voice, range: 0s ..< 1s); }' },
    { op: "cut.documentary.narration", source: 'import { Narration } from "@cut/documentary"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { Narration(source: voice, range: 0s ..< 1s); }' },
  ];
  for (const fixture of fixtures) {
    const ir = compile(`cut 0.4; project "sample grid"; ${fixture.source} export out = render(main);`);
    const resource = Object.values(ir.resources)[0]; assert.ok(resource);
    (resource as unknown as { metadata: Record<string, unknown> }).metadata = {
      probe: {
        kind: "media",
        identity: { streams: [{ index: 0, type: "audio", sampleRate: 48_000 }] },
        selected: { audio: { streamIndex: 0, duration: { numerator: "1", denominator: "1" }, durationSource: "stream", timeBase: { numerator: "1", denominator: "48000" } } },
      },
    };
    const node = audioNode(ir, fixture.op), range = node.inputs.range;
    const valid = referenceAudioNodeConfig(ir, ir.compositions[0], node);
    assert.equal(valid?.kind, "media-source");
    if (valid?.kind === "media-source") assert.deepEqual([valid.sourceStartSamples, valid.sourceEndSamples, valid.durationSamples], [0, 48_000, 48_000]);
    assert.equal(range?.kind, "range");
    if (range?.kind !== "range" || range.start.kind !== "quantity" || range.end.kind !== "quantity") assert.fail("missing compiled source range");
    range.end.magnitude = { numerator: "2", denominator: "1" };
    assertAudioConfigError(() => referenceAudioNodeConfig(ir, ir.compositions[0], node), "CUT_AUDIO_VALUE_RANGE");
    range.end.magnitude = { numerator: "1", denominator: "1" };
    range.start.magnitude = { numerator: "1", denominator: "48001" };
    assertAudioConfigError(() => referenceAudioNodeConfig(ir, ir.compositions[0], node), "CUT_AUDIO_SAMPLE_GRID");
    range.start.magnitude = { numerator: "0", denominator: "1" };
    node.inputs.fadeOut = { kind: "quantity", dimension: "time", magnitude: { numerator: "-1", denominator: "48000" }, unit: "s" };
    assertAudioConfigError(() => referenceAudioNodeConfig(ir, ir.compositions[0], node), "CUT_AUDIO_VALUE_RANGE");
  }
});

test("cross-rate media trims use an explicit nearest-ties-to-even destination sample policy", () => {
  const ir = compile('cut 0.4; project "cross-rate trim"; import { AudioClip } from "@cut/audio"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { AudioClip(source: voice, range: 0s ..< 1s); } export out = render(main);');
  const resource = Object.values(ir.resources)[0]; assert.ok(resource);
  (resource as unknown as { metadata: Record<string, unknown> }).metadata = {
    probe: {
      kind: "media",
      identity: { streams: [{ index: 0, type: "audio", sampleRate: 44_100 }] },
      selected: { audio: { streamIndex: 0, duration: { numerator: "1", denominator: "44100" }, durationSource: "stream", timeBase: { numerator: "1", denominator: "44100" } } },
    },
  };
  const node = audioNode(ir, "cut.audio.clip"), range = node.inputs.range;
  assert.equal(range?.kind, "range");
  if (range?.kind !== "range" || range.end.kind !== "quantity") assert.fail("missing compiled source range");
  range.end.magnitude = { numerator: "1", denominator: "44100" };
  const config = referenceAudioNodeConfig(ir, ir.compositions[0], node);
  assert.equal(config?.kind, "media-source");
  if (config?.kind !== "media-source") assert.fail("missing media-source config");
  assert.deepEqual(
    { sourceStartSamples: config.sourceStartSamples, sourceEndSamples: config.sourceEndSamples, durationSamples: config.durationSamples, durationMapping: config.durationMapping, resampleKernel: config.resampleKernel },
    { sourceStartSamples: 0, sourceEndSamples: 1, durationSamples: 1, durationMapping: "nearest-ties-to-even", resampleKernel: "short-range-2-tap" },
  );
});

test("cross-rate nearest-even mapping reaches decoded destination samples", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-cross-rate-"));
  await writeFile(resolve(directory, "voice.wav"), monoPcm16Wave(44_100, [24_000]));
  const ir = compile('cut 0.4; project "cross-rate render"; import { AudioClip } from "@cut/audio"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { AudioClip(source: voice, range: 0s ..< 1s); } export out = render(main);');
  const resource = Object.values(ir.resources)[0]; assert.ok(resource);
  resource.state = "locked"; resource.sha256 = "0".repeat(64); resource.metadata = {
    bytes: 46,
    probe: {
      kind: "media",
      identity: { streams: [{ index: 0, type: "audio", codec: "pcm_s16le", timeBase: { numerator: "1", denominator: "44100" }, sampleRate: 44_100 }] },
      selected: { audio: { streamIndex: 0, duration: { numerator: "1", denominator: "44100" }, durationSource: "stream", timeBase: { numerator: "1", denominator: "44100" } } },
    },
  };
  ir.determinism.semantic = "locked";
  const node = audioNode(ir, "cut.audio.clip"), range = node.inputs.range;
  assert.equal(range?.kind, "range");
  if (range?.kind !== "range" || range.end.kind !== "quantity") assert.fail("missing compiled source range");
  range.end.magnitude = { numerator: "1", denominator: "44100" };
  const output = resolve(directory, "cross-rate.wav");
  await renderReferenceAudio(ir, ir.compositions[0], directory, output);
  const pcm = pcm24Data(await readFile(output));
  assert.equal(pcm.frames, 48_000);
  assert.ok(Math.abs(pcm.sample(0, 0)) > .1, `first mapped sample must contain decoded source energy: ${pcm.sample(0, 0)}`);
  assert.equal(pcm.sample(1, 0), 0, "a one-sample destination mapping must not leak into the next sample");
});

test("sidechain routing responds dynamically to key presence in decoded samples", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-audio-differential-"));
  const dynamic = pcm24Data(await renderProgram('cut 0.4; project "dynamic duck"; import { Tone, Sidechain } from "@cut/audio"; timeline main(duration: 2s, fps: 24, sampleRate: 48khz) { Tone(frequency: 3000hz, duration: 1s, amplitude: 5%) as key; Sidechain(source: key, amount: -40db, threshold: -60db, attack: 1ms, release: 50ms) { Tone(frequency: 220hz, duration: 2s, amplitude: 50%); } } export out = render(main);', directory, "sidechain.wav"));
  const keyed = channelRms(dynamic, 12_000, 43_200), released = channelRms(dynamic, 60_000, 91_200);
  assert.ok(keyed < released * .45, `${keyed} keyed versus ${released} released`);
});

test("sidechain reasserts stereo layout after a filtered key and program", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-sidechain-layout-"));
  const rendered = pcm24Data(await renderProgram(`cut 0.4; project "filtered sidechain layout";
import { Compressor, Gain, HighPass, LowPass, Sidechain, Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  Gain(amount: 1db) as key {
    Compressor(threshold: -22db, ratio: 2.4, attack: 14ms, release: 180ms) {
      HighPass(frequency: 72hz) { Tone(frequency: 3000hz, duration: 1s, amplitude: 20%); }
    }
  }
  Sidechain(source: key, amount: -12db, threshold: -30db, attack: 18ms, release: 340ms) {
    LowPass(frequency: 8500hz) { Tone(frequency: 220hz, duration: 1s, amplitude: 30%); }
  }
}
export out = render(main);`, directory, "filtered-sidechain.wav"));
  assert.equal(rendered.frames, 48_000);
  assert.ok(channelRms(rendered, 12_000, 36_000) > 0, "filtered sidechain output must contain decoded samples");
});

test("loudness report distinguishes measured input from measured normalized output", { timeout: 30_000 }, async () => {
  const ir = compile('cut 0.4; project "measure"; import { Tone } from "@cut/audio"; timeline main(duration: 3s, fps: 24, sampleRate: 48khz) { Tone(frequency: 440hz, duration: 3s, amplitude: 5%); } export out = render(main);');
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-loudness-")), raw = resolve(directory, "raw.wav"), normalized = resolve(directory, "normalized.wav");
  await renderReferenceAudio(ir, ir.compositions[0], directory, raw); const report = await normalizeReferenceAudio(raw, normalized, -20, -2, 7, 48_000);
  assert.equal(report.normalization, "two-pass"); assert.equal(report.target.integratedLufs, -20); assert.ok(report.input.integratedLufs !== null && Math.abs(report.input.integratedLufs + 20) > 3);
  assert.ok(report.normalized.integratedLufs !== null && Math.abs(report.normalized.integratedLufs + 20) < .2, JSON.stringify(report));
});

test("mastering reconciles a short gated mix after loudnorm while preserving the PCM contract", { timeout: 30_000 }, async () => {
  const ir = compile(`cut 0.4; project "short gated mix"; import { Tone, Noise, Bus, Gain, Limiter } from "@cut/audio"; timeline main(duration: 6s, fps: 30, sampleRate: 48khz) {
    scene first(duration: 3s) { Limiter(ceiling: -1.3dbtp) { Bus(name: "first") { Gain(amount: -12db) { at 120ms { Tone(frequency: 180hz, duration: 550ms, amplitude: 25%, fadeIn: 80ms, fadeOut: 320ms); } } Gain(amount: -28db) { Noise(duration: 3s, color: "pink", amplitude: 4%, seed: 404, fadeIn: 250ms, fadeOut: 450ms); } } } }
    scene second(duration: 3s) { Limiter(ceiling: -1.3dbtp) { Bus(name: "second") { Gain(amount: -12db) { at 120ms { Tone(frequency: 270hz, duration: 550ms, amplitude: 25%, fadeIn: 80ms, fadeOut: 320ms); } } Gain(amount: -28db) { Noise(duration: 3s, color: "pink", amplitude: 4%, seed: 505, fadeIn: 250ms, fadeOut: 450ms); } } } }
  } export out = render(main);`);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-reconcile-")), raw = resolve(directory, "raw.wav"), normalized = resolve(directory, "normalized.wav"), replay = resolve(directory, "replay.wav");
  await renderReferenceAudio(ir, ir.compositions[0], directory, raw); const report = await normalizeReferenceAudio(raw, normalized, -14, -1.3, 9, 48_000);
  assert.ok(report.reconciliation.residualBeforeLu !== null && Math.abs(report.reconciliation.residualBeforeLu) > .2, JSON.stringify(report));
  assert.equal(report.reconciliation.status, "applied"); assert.equal(report.reconciliation.limitingConstraint, "none"); assert.equal(report.reconciliation.withinTargetTolerance, true);
  assert.ok(report.normalized.integratedLufs !== null && Math.abs(report.normalized.integratedLufs + 14) <= .2, JSON.stringify(report));
  assert.ok(report.normalized.truePeakDbtp !== null && report.normalized.truePeakDbtp <= -1.3); assert.equal(pcm24Data(await readFile(normalized)).frames, 288_000);
  await normalizeReferenceAudio(raw, replay, -14, -1.3, 9, 48_000); assert.deepEqual(await readFile(replay), await readFile(normalized));
});

test("mastering reports when authored true peak prevents the loudness target", { timeout: 30_000 }, async () => {
  const ir = compile('cut 0.4; project "peak constrained"; import { Tone } from "@cut/audio"; timeline main(duration: 3s, fps: 24, sampleRate: 48khz) { Tone(frequency: 440hz, duration: 3s, amplitude: 90%); } export out = render(main);');
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-peak-limit-")), raw = resolve(directory, "raw.wav"), normalized = resolve(directory, "normalized.wav");
  await renderReferenceAudio(ir, ir.compositions[0], directory, raw); const report = await normalizeReferenceAudio(raw, normalized, -5, -9, 7, 48_000);
  assert.equal(report.reconciliation.status, "limited"); assert.equal(report.reconciliation.limitingConstraint, "true-peak"); assert.equal(report.reconciliation.withinTargetTolerance, false);
  assert.ok(report.normalized.truePeakDbtp !== null && report.normalized.truePeakDbtp <= -9, JSON.stringify(report));
  assert.ok(report.reconciliation.requestedGainDb !== null && report.reconciliation.appliedGainDb < report.reconciliation.requestedGainDb);
});

test("reference audio refuses a timeline that cannot end on an output sample", async () => {
  const ir = compile('cut 0.4; project "fractional sample"; timeline main(duration: 1ms, fps: 24, sampleRate: 44.1khz) {} export out = render(main);');
  const directory = await mkdtemp(resolve(tmpdir(), "cut-reference-fractional-"));
  await assert.rejects(() => renderReferenceAudio(ir, ir.compositions[0], directory, resolve(directory, "bad.wav")), /sample boundary/);
});
