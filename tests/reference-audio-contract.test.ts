import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { ReferenceAudioConfigError } from "../lib/runtime/reference/audio-config";
import { measureReferenceAudio, renderReferenceAudio } from "../lib/runtime/reference/audio";
import { ReferenceAudioPeakError } from "../lib/runtime/reference/audio-peak";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function source(body: string, imports = "Tone, EQ, HighPass, LowPass, Compressor, DeEsser, Limiter, Reverb, Pan, Gain, Noise, Sidechain") {
  return `cut 0.4;
project "closed audio contract";
import { ${imports} } from "@cut/audio";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function parse(value: string) {
  const parsed = parseCutLanguage(value);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function locked(body: string) {
  const ir = compileCutModule(parse(source(body))).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

test("every accepted static audio processor input is typed at the public CUT boundary", () => {
  const invalid = source('EQ(frequency: "wrong", gain: "wrong", q: "wrong") { Tone(frequency: 440hz, duration: 1s); }');
  const diagnostics = checkCutModule(parse(invalid)).diagnostics.filter((item) => item.code === "CUT2029");
  assert.equal(diagnostics.length, 3);
  assert.throws(() => compileCutModule(parse(invalid)), CutCompileError);
});

test("audio preflight rejects out-of-range authored values with stable source-located codes", () => {
  const cases: Array<[string, string, RegExp]> = [
    ['Tone(frequency: -10hz, duration: 1s);', "CUT_AUDIO_VALUE_RANGE", /frequency greater than zero/],
    ['Pan(position: 150%) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /position between -1 and 1/],
    ['EQ(gain: 3db, q: 0) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /q between 0\.001 and 1000/],
    ['HighPass(frequency: 24khz) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /between 1 Hz and 21600 Hz.*state-variable filter/],
    ['LowPass(frequency: 12khz, q: 21) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /q between 0\.1 and 20/],
    ['Compressor(threshold: 1db) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /threshold between -60 and 0/],
    ['Compressor(makeup: 25db) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /makeup between -24 and 24/],
    ['DeEsser(intensity: 2) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /intensity between 0 and 1/],
    ['Limiter(ceiling: 1dbtp) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /ceiling between -23\.5 and 0/],
    ['Reverb(wet: 120%) { Tone(frequency: 440hz, duration: 1s); }', "CUT_AUDIO_VALUE_RANGE", /wet between 0 and 1/],
    ['Gain(amount: -6db) { Tone(frequency: 440hz, duration: 1s, fadeOut: -1ms); }', "CUT_AUDIO_VALUE_RANGE", /non-negative fadeOut/],
  ];
  for (const [body, code, message] of cases) {
    assert.throws(
      () => validateReferenceSession(locked(body)),
      (error) => error instanceof ReferenceAudioConfigError && error.code === code && /project\.cut:\d+:\d+/.test(error.message) && message.test(error.message),
      body,
    );
  }

  const invalidNoise = source('Noise(duration: 1s, color: "ultraviolet");');
  const sourceDiagnostics = checkCutModule(parse(invalidNoise)).diagnostics;
  assert.ok(sourceDiagnostics.some((diagnostic) => diagnostic.code === "CUT2068" && diagnostic.message.includes("white, pink, brown, blue, violet, velvet")));
  assert.throws(() => compileCutModule(parse(invalidNoise)), CutCompileError);

  const loaded = locked('Noise(duration: 1s, color: "pink");');
  const noise = Object.values(loaded.nodes).find((node) => node.op === "cut.audio.noise");
  assert.ok(noise);
  noise.inputs.color = { kind: "string", value: "ultraviolet" };
  assert.throws(
    () => validateReferenceSession(loaded),
    (error) => error instanceof ReferenceAudioConfigError
      && error.code === "CUT_AUDIO_ENUM"
      && /project\.cut:\d+:\d+/.test(error.message)
      && /white, pink, brown, blue, violet, velvet/.test(error.message),
  );
});

test("closed valid audio defaults and explicit controls survive syntax through runtime preflight", () => {
  const ir = locked(`
    Tone(frequency: 440hz, duration: 1s) as key;
    Sidechain(source: key, amount: -8db, threshold: -22db, attack: 80ms, release: 350ms) { Tone(frequency: 330hz, duration: 1s); }
    Reverb(wet: 18%) { Tone(frequency: 340hz, duration: 1s); }
    Limiter(ceiling: -1dbtp) { Tone(frequency: 350hz, duration: 1s); }
    DeEsser(intensity: 0.35, amount: 0.5) { Noise(duration: 1s, color: "white", seed: 2); }
    Compressor(threshold: -18db, ratio: 3, attack: 20ms, release: 180ms, makeup: 0db) { Tone(frequency: 360hz, duration: 1s); }
    EQ(frequency: 180hz, gain: 3db, q: 1) { Tone(frequency: 370hz, duration: 1s); }
    LowPass(frequency: 12khz) { Tone(frequency: 380hz, duration: 1s); }
    HighPass(frequency: 80hz) { Tone(frequency: 390hz, duration: 1s); }
    Pan(position: 0%) { Tone(frequency: 400hz, duration: 1s); }
    Gain(amount: -6db) { Noise(duration: 1s, color: "pink", seed: 1); }
  `);
  assert.doesNotThrow(() => validateReferenceSession(ir));
});

function waveData(buffer: Buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (name === "data") return buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  throw new Error("Missing WAVE data chunk.");
}

async function pcmHash(body: string, sampleRate = "48khz") {
  const program = source(body).replaceAll("duration: 1s", "duration: 250ms").replace("sampleRate: 48khz", `sampleRate: ${sampleRate}`);
  const ir = compileCutModule(parse(program)).ir;
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-contract-")), output = resolve(root, "mix.wav");
  await renderReferenceAudio(ir, ir.compositions[0], root, output);
  return createHash("sha256").update(waveData(await readFile(output))).digest("hex");
}

test("closed processor controls produce different decoded samples instead of validated no-ops", { timeout: 30_000 }, async () => {
  const cases: Array<[string, string, string]> = [
    ["EQ", 'EQ(frequency: 500hz, gain: -18db, q: 2) { Noise(duration: 250ms, color: "white", seed: 1); }', 'EQ(frequency: 500hz, gain: 18db, q: 2) { Noise(duration: 250ms, color: "white", seed: 1); }'],
    ["HighPass", 'HighPass(frequency: 40hz) { Noise(duration: 250ms, color: "white", seed: 2); }', 'HighPass(frequency: 8khz) { Noise(duration: 250ms, color: "white", seed: 2); }'],
    ["LowPass", 'LowPass(frequency: 200hz) { Noise(duration: 250ms, color: "white", seed: 3); }', 'LowPass(frequency: 12khz) { Noise(duration: 250ms, color: "white", seed: 3); }'],
    ["Compressor", 'Compressor(threshold: -50db, ratio: 20, attack: 1ms, release: 20ms) { Tone(frequency: 440hz, duration: 250ms, amplitude: 90%); }', 'Compressor(ratio: 1) { Tone(frequency: 440hz, duration: 250ms, amplitude: 90%); }'],
    ["DeEsser", 'DeEsser(intensity: 0) { Tone(frequency: 220hz, duration: 250ms, amplitude: 15%); at 0ms { HighPass(frequency: 4khz) { Noise(duration: 40ms, color: "white", seed: 4, amplitude: 80%); } } at 80ms { HighPass(frequency: 4khz) { Noise(duration: 40ms, color: "white", seed: 5, amplitude: 80%); } } at 160ms { HighPass(frequency: 4khz) { Noise(duration: 40ms, color: "white", seed: 6, amplitude: 80%); } } }', 'DeEsser(intensity: 1, amount: 1) { Tone(frequency: 220hz, duration: 250ms, amplitude: 15%); at 0ms { HighPass(frequency: 4khz) { Noise(duration: 40ms, color: "white", seed: 4, amplitude: 80%); } } at 80ms { HighPass(frequency: 4khz) { Noise(duration: 40ms, color: "white", seed: 5, amplitude: 80%); } } at 160ms { HighPass(frequency: 4khz) { Noise(duration: 40ms, color: "white", seed: 6, amplitude: 80%); } } }'],
    ["Limiter", 'Limiter(ceiling: -12dbtp) { Tone(frequency: 440hz, duration: 250ms, amplitude: 90%); }', 'Limiter(ceiling: -1dbtp) { Tone(frequency: 440hz, duration: 250ms, amplitude: 90%); }'],
    ["Reverb", 'Reverb(wet: 0%) { Tone(frequency: 440hz, duration: 250ms, amplitude: 30%); }', 'Reverb(wet: 100%) { Tone(frequency: 440hz, duration: 250ms, amplitude: 30%); }'],
    ["Sidechain", 'Tone(frequency: 220hz, duration: 250ms, amplitude: 80%) as key; Sidechain(source: key, amount: -2db) { Noise(duration: 250ms, color: "white", seed: 5); }', 'Tone(frequency: 220hz, duration: 250ms, amplitude: 80%) as key; Sidechain(source: key, amount: -20db) { Noise(duration: 250ms, color: "white", seed: 5); }'],
    ["Sidechain calibrated near zero", 'Tone(frequency: 220hz, duration: 250ms, amplitude: 80%) as key; Sidechain(source: key, amount: -1db) { Noise(duration: 250ms, color: "white", seed: 5); }', 'Tone(frequency: 220hz, duration: 250ms, amplitude: 80%) as key; Sidechain(source: key, amount: -4db) { Noise(duration: 250ms, color: "white", seed: 5); }'],
  ];
  for (const [name, first, second] of cases) assert.notEqual(await pcmHash(first), await pcmHash(second), `${name} authored controls must alter decoded PCM`);
});

test("Reverb 0% is exact dry bypass and DeEsser remains effective at the minimum sample rate", { timeout: 30_000 }, async () => {
  const dry = 'Tone(frequency: 440hz, duration: 250ms, amplitude: 30%);';
  assert.equal(await pcmHash(dry), await pcmHash(`Reverb(wet: 0%) { ${dry} }`));
  const noise = 'Noise(duration: 250ms, color: "white", seed: 17, amplitude: 80%);';
  assert.notEqual(await pcmHash(`DeEsser(intensity: 0) { ${noise} }`, "8khz"), await pcmHash(`DeEsser(intensity: 1, amount: 1) { ${noise} }`, "8khz"));
});

test("selected-output preflight does not validate unreachable audio against the wrong sample rate", () => {
  const program = `cut 0.4; project "two outputs"; import { Tone } from "@cut/audio";
timeline high(duration: 1s, fps: 24, sampleRate: 48khz) { scene highScene(duration: 1s) { Tone(frequency: 440hz, duration: 1s); } }
timeline low(duration: 1s, fps: 24, sampleRate: 8khz) { scene lowScene(duration: 1s) { Tone(frequency: 3000hz, duration: 1s); } }
export highOut = render(high); export lowOut = render(low);`;
  const ir = compileCutModule(parse(program)).ir; ir.determinism.semantic = "locked";
  const lowTone = Object.values(ir.nodes).find((node) => node.op === "cut.audio.tone" && node.inputs.frequency?.kind === "quantity" && node.inputs.frequency.magnitude.numerator === "3000");
  assert.ok(lowTone); lowTone.inputs.frequency = { kind: "quantity", dimension: "frequency", magnitude: { numerator: "5000", denominator: "1" }, unit: "hz" };
  assert.doesNotThrow(() => validateReferenceSession(ir, "highOut"));
  assert.throws(() => validateReferenceSession(ir, "lowOut"), (error) => error instanceof ReferenceAudioConfigError && error.code === "CUT_AUDIO_VALUE_RANGE");
});

test("4x limiter keeps measured delivered true peak at its authored ceiling", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-limiter-"));
  try {
    const render = async (body: string, name: string) => {
      const ir = compileCutModule(parse(source(body))).ir, output = resolve(root, name);
      await renderReferenceAudio(ir, ir.compositions[0], root, output);
      return measureReferenceAudio(output, -14, -1, 9);
    };
    const driven = 'Gain(amount: 12db) { Noise(duration: 1s, color: "white", seed: 71, amplitude: 90%); }';
    await assert.rejects(
      () => render(driven, "raw.wav"),
      (error: unknown) => error instanceof ReferenceAudioPeakError
        && error.code === "CUT_AUDIO_CLIPPING"
        && error.detail.reason === "sample-peak-ceiling"
        && error.detail.sampleDbfs !== undefined
        && error.detail.sampleDbfs > 0,
      "the intentionally hot unmastered control must now fail the canonical public PCM24 clipping boundary",
    );
    const limited = await render(`Limiter(ceiling: -1dbtp) { ${driven} }`, "limited.wav");
    assert.ok(limited.truePeakDbtp !== null && limited.truePeakDbtp <= -1, JSON.stringify(limited));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
