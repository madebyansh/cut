import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRSignal, IRValue } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import {
  compileReferenceDeEsserAutomations,
  ReferenceAudioAutomationError,
} from "../lib/runtime/reference/audio-automation";
import {
  ReferenceNoOpContractError,
  referenceNoOpDiagnosticCode,
} from "../lib/runtime/reference/noop-contract";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const imports = `import { Duotone, Glow, Grain, Rect, Shadow, Sharpen, Trace, Vignette } from "cut:visual";
import { Globe, Map, Marker } from "@cut/geo";
import { Compressor, DeEsser, Delay, EQ, Noise, Sidechain, Synth, TimeStretch, Tone } from "@cut/audio";
import { spring } from "@cut/motion";`;

function program(body: string) {
  const assets = body.includes("font: face") ? 'asset face: FontAsset = font("face.ttf");' : "";
  return `cut 0.4;
project "inert control contract";
${imports}
${assets}
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function parsed(body: string) {
  const result = parseCutLanguage(program(body));
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compileUnlocked(body: string) {
  return compileCutModule(parsed(body)).ir;
}

function compile(body: string) {
  const ir = compileUnlocked(body);
  ir.determinism.semantic = "locked";
  return ir;
}

function expectSourceNoOp(body: string, expected: RegExp) {
  assert.throws(() => compileCutModule(parsed(body)), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, body);
    const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === "CUT2085");
    assert.ok(diagnostic, `${body}: ${JSON.stringify(error.result.diagnostics)}`);
    assert.match(diagnostic.message, expected, body);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0, body);
    return true;
  });
}

const tone = "Tone(frequency: 440hz, duration: 1s)";
const rect = "Rect(width: 8px, height: 8px, fill: #607080)";
const synthEvent = "[{ start: 0ms, duration: 300ms, pitch: 69, velocity: 50% }]";

test("typed source rejects visual, geographic, source, envelope, processor, and identity no-ops", () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    [`Shadow(x: 2px, opacity: 0%) { ${rect}; }`, /Shadow opacity.*inert.*x/],
    [`Shadow(color: #12345600) { ${rect}; }`, /Shadow color cannot be fully transparent/],
    [`Glow(radius: 2px, opacity: 0%) { ${rect}; }`, /Glow opacity.*inert.*radius/],
    [`Glow(color: #12345600) { ${rect}; }`, /Glow color cannot be fully transparent/],
    [`Vignette(amount: 0%, softness: 20%) { ${rect}; }`, /Vignette amount.*inert.*softness/],
    [`Vignette(radius: 100%, amount: 40%) { ${rect}; }`, /Vignette radius is 100%.*inert.*amount/],
    [`Vignette(color: #12345600) { ${rect}; }`, /Vignette color cannot be fully transparent/],
    [`Sharpen(radius: 2px, amount: 0%) { ${rect}; }`, /Sharpen amount.*inert.*radius/],
    [`Sharpen(radius: 0px, amount: 50%) { ${rect}; }`, /Sharpen radius.*inert.*amount/],
    [`Grain(amount: 0%, seed: 7) { ${rect}; }`, /Grain amount.*inert.*seed/],
    [`Duotone(shadows: #102030, amount: 0%) { ${rect}; }`, /Duotone amount.*inert.*shadows/],
    ["Trace(points: [{ x: 0px, y: 0px }, { x: 8px, y: 0px }], stroke: #ffffff, width: 1px, duration: 1s, headRadius: 2px, headColor: #ff000000);", /Trace headColor cannot be fully transparent/],
    ["Globe(markerRadius: 2px);", /Globe has no points or stations.*markerRadius/],
    ["Globe() as globe; set globe.reveal = 50%;", /Globe has no points or stations.*property:reveal/],
    ["Map(signal: #ff0000);", /Map has no points.*signal/],
    ["Map() as map; set map.reveal = 50%;", /Map has no points.*property:reveal/],
    ['Marker(point: { latitude: 28, longitude: 77, label: "Delhi" }, label: "Capital", font: face);', /Marker label is authored both/],
    ["Tone(frequency: 440hz, duration: 1s, amplitude: 0%);", /Tone amplitude must be positive.*AudioGap/],
    ["Noise(duration: 1s, amplitude: 0%);", /Noise amplitude must be positive.*AudioGap/],
    [`Synth(events: ${synthEvent}, decay: 20ms);`, /Synth decay cannot affect.*sustain is 100%/],
    [`Synth(events: ${synthEvent}, sustain: 0%, release: 20ms);`, /Synth release cannot affect.*sustain is 0%/],
    [`EQ(frequency: 1khz) { ${tone}; }`, /ParametricEQ gain is 0 dB.*inert.*frequency/],
    [`EQ() as eq { ${tone}; } set eq.frequency = 1khz;`, /ParametricEQ gain is 0 dB.*property:frequency/],
    [`Compressor(threshold: -24db, ratio: 1) { ${tone}; }`, /Compressor ratio is 1:1.*inert.*threshold/],
    [`DeEsser(intensity: 0, amount: 0.5) { ${tone}; }`, /DeEsser intensity is zero.*inert.*amount/],
    [`DeEsser(intensity: 0.35, amount: 0) { ${tone}; }`, /DeEsser amount is zero.*inert.*intensity/],
    [`DeEsser(intensity: 0) as deess { ${tone}; } set deess.amount = 0.8;`, /DeEsser intensity is zero.*property:amount/],
    [`DeEsser(amount: 0) as deess { ${tone}; } set deess.intensity = 0.8;`, /DeEsser amount is zero.*property:intensity/],
    [`Delay(time: 10ms, wet: 0%) { ${tone}; }`, /Delay wet is 0%.*inert.*time/],
    [`let key = Tone(frequency: 3khz, duration: 1s); Sidechain(source: key, amount: 0db) { ${tone}; }`, /Sidechain amount is 0 dB.*inert.*source/],
    [`TimeStretch(sourceDuration: 300ms, duration: 300ms, pitch: 0, quality: "draft") { Tone(frequency: 440hz, duration: 300ms); }`, /TimeStretch has identity duration and pitch.*quality/],
  ];
  for (const [body, expected] of cases) expectSourceNoOp(body, expected);
});

test("a sample-zero inactive write replaces an active input, while later reactivation remains executable", () => {
  expectSourceNoOp(
    `EQ(frequency: 1khz, gain: 6db) as eq { ${tone}; } set eq.gain = 0db;`,
    /ParametricEQ gain is 0 dB.*frequency/,
  );
  expectSourceNoOp(
    `DeEsser(intensity: 0.8, amount: 0.5) as deess { ${tone}; } set deess.intensity = 0;`,
    /DeEsser intensity is zero.*amount/,
  );
  expectSourceNoOp(
    `DeEsser(intensity: 0.35, amount: 0.8) as deess { ${tone}; } set deess.amount = 0;`,
    /DeEsser amount is zero.*intensity/,
  );

  const activeLater = [
    `EQ(frequency: 1khz, gain: 0db) as eq { ${tone}; } at 500ms { set eq.gain = 3db; }`,
    `Compressor(threshold: -24db, ratio: 1) as dynamics { ${tone}; } at 500ms { set dynamics.ratio = 3; }`,
    `DeEsser(intensity: 0, amount: 0.5) as deess { ${tone}; } at 500ms { set deess.intensity = 0.8; }`,
    `DeEsser(intensity: 0.35, amount: 0) as deess { ${tone}; } at 500ms { set deess.amount = 0.8; }`,
    `DeEsser(intensity: 0) { ${tone}; }`,
    `DeEsser(amount: 0) { ${tone}; }`,
    `Delay(time: 10ms, wet: 0%) as echo { ${tone}; } at 500ms { set echo.wet = 50%; }`,
    `let key = Tone(frequency: 3khz, duration: 1s); Sidechain(source: key, amount: 0db) as duck { ${tone}; } at 500ms { set duck.amount = -6db; }`,
  ];
  for (const body of activeLater) {
    const ir = compile(body);
    assert.doesNotThrow(() => validateReferenceSession(ir), body);
  }
});

test("inactive controller proof yields to owning audio automation diagnostics", () => {
  const cases = [
    [
      `DeEsser(intensity: 0, amount: 0.5) as deess { ${tone}; } at 0.1ms { set deess.intensity = 0; }`,
      "CUT_AUDIO_AUTOMATION_SAMPLE_GRID",
      /event start does not land on a 48000 Hz sample boundary/,
    ],
    [
      `EQ(frequency: 1khz) as eq { ${tone}; } animate eq.gain from 0db to 0db over 100ms ease spring();`,
      "CUT_AUDIO_AUTOMATION_EASING",
      /only linear and outCubic/,
    ],
  ] as const;
  for (const [body, code, expected] of cases) {
    const ir = compile(body);
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioAutomationError, body);
      assert.equal(error.code, code, body);
      assert.match(error.message, expected, body);
      assert.ok(error.source.line > 0 && error.source.column > 0, body);
      return true;
    });
  }
});

function node(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(result, `missing ${op}`);
  return result;
}

function propertySignal(ir: CutAVIR, target: IRNode, property: string): IRSignal {
  const reference = target.properties[property];
  assert.ok(reference && "signal" in reference, `missing ${target.op}.${property} signal`);
  const signal = ir.signals[reference.signal];
  assert.ok(signal, `missing signal ${reference.signal}`);
  return signal;
}

function quantity(dimension: "gain" | "length" | "ratio" | "scalar", unit: "db" | "px" | "ratio" | "scalar", numerator: number, denominator = 1): IRValue {
  return { kind: "quantity", dimension, unit, magnitude: rational(numerator, denominator) };
}

function hostile(body: string, op: string, mutate: (target: IRNode, ir: CutAVIR) => void) {
  const ir = compile(body);
  mutate(node(ir, op), ir);
  for (const signal of Object.values(ir.signals)) signal.contentHash = cutSignalContentHash(signal);
  finalizeGraphHashes(ir);
  return loadCutAvIr(JSON.stringify(ir));
}

test("loaded audio tracks share runtime defaults with no-op proof and retain owning signal diagnostics", () => {
  const nullBaseline = hostile(
    `DeEsser(intensity: 0.35, amount: 0.5) as deess { ${tone}; } at 50ms { set deess.intensity = 0; }`,
    "cut.audio.deesser",
    (target, ir) => {
      target.inputs.intensity = quantity("scalar", "scalar", 0);
      const signal = propertySignal(ir, target, "intensity");
      assert.equal(signal.kind, "track");
      if (signal.kind === "track") signal.initial = { kind: "null" };
    },
  );
  const processor = node(nullBaseline, "cut.audio.deesser");
  assert.doesNotThrow(() => validateReferenceSession(nullBaseline));
  const automation = compileReferenceDeEsserAutomations(nullBaseline, nullBaseline.compositions[0], processor).intensity;
  assert.ok(automation);
  assert.equal(automation.controlValues[0], 0.35, "null track initial must use the public DeEsser default, not conflicting node input");
  assert.match(automation.valueExpression, /7\/20/, "the executable expression must carry the same canonical default");

  const invalidRange = hostile(
    `DeEsser(intensity: 0, amount: 0.5) as deess { ${tone}; }
     at 100ms { set deess.intensity = 0.8; }
     set deess.amount = 0.8;`,
    "cut.audio.deesser",
    (target, ir) => {
      const intensity = propertySignal(ir, target, "intensity");
      const amount = propertySignal(ir, target, "amount");
      assert.equal(intensity.kind, "track");
      assert.equal(amount.kind, "track");
      if (intensity.kind === "track" && intensity.events[0]?.kind === "set") intensity.events[0].value = quantity("scalar", "scalar", 0);
      if (amount.kind === "track" && amount.events[0]?.kind === "set") amount.events[0].value = quantity("scalar", "scalar", 2);
    },
  );
  assert.throws(() => validateReferenceSession(invalidRange), (error: unknown) => error instanceof ReferenceAudioAutomationError
    && error.code === "CUT_AUDIO_AUTOMATION_VALUE_RANGE"
    && /DeEsser\.amount.*between 0 and 1/.test(error.message));

  const invalidShape = hostile(
    `DeEsser(intensity: 0, amount: 0.5) as deess { ${tone}; } at 100ms { set deess.intensity = 0.8; }`,
    "cut.audio.deesser",
    (target, ir) => {
      const signal = propertySignal(ir, target, "intensity");
      ir.signals[signal.id] = {
        id: signal.id,
        kind: "constant",
        valueType: "Number",
        value: quantity("scalar", "scalar", 0),
        contentHash: signal.contentHash,
        provenance: signal.provenance,
      };
    },
  );
  assert.throws(() => validateReferenceSession(invalidShape), (error: unknown) => error instanceof ReferenceAudioAutomationError
    && error.code === "CUT_AUDIO_AUTOMATION_SIGNAL"
    && /requires a track signal/.test(error.message));

  const invalidType = compile(`DeEsser(intensity: 0, amount: 0.5) as deess { ${tone}; } at 100ms { set deess.intensity = 0.8; }`);
  const invalidTypeProcessor = node(invalidType, "cut.audio.deesser");
  const invalidTypeSignal = propertySignal(invalidType, invalidTypeProcessor, "intensity");
  assert.equal(invalidTypeSignal.kind, "track");
  invalidTypeSignal.valueType = "Ratio";
  if (invalidTypeSignal.kind === "track" && invalidTypeSignal.events[0]?.kind === "set") {
    invalidTypeSignal.events[0].value = quantity("scalar", "scalar", 0);
  }
  assert.throws(() => validateReferenceSession(invalidType), (error: unknown) => error instanceof ReferenceAudioAutomationError
    && error.code === "CUT_AUDIO_AUTOMATION_TYPE"
    && /requires signal valueType Number/.test(error.message));
});

async function lockedHostileMarker() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-noop-marker-"));
  await copyFile(resolve("examples/fixtures/Geist-Regular.ttf"), resolve(root, "face.ttf"));
  const ir = compileUnlocked('Marker(point: { latitude: 28, longitude: 77, label: "Delhi" }, font: face);');
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  node(ir, "cut.geo.marker").inputs.label = { kind: "string", value: "Capital" };
  finalizeGraphHashes(ir);
  return loadCutAvIr(JSON.stringify(ir));
}

test("hostile loaded typed IR cannot bypass the same inert-control contract", async () => {
  const marker = await lockedHostileMarker();
  assert.throws(
    () => validateReferenceSession(marker),
    (error: unknown) => error instanceof ReferenceNoOpContractError && /Marker label is authored both/.test(error.message),
  );

  const cases: ReadonlyArray<readonly [CutAVIR, RegExp]> = [
    [hostile(`Shadow(x: 2px, opacity: 50%) { ${rect}; }`, "cut.visual.shadow", (target) => { target.inputs.opacity = quantity("ratio", "ratio", 0); }), /Shadow opacity.*x/],
    [hostile(`Shadow(color: #123456) { ${rect}; }`, "cut.visual.shadow", (target) => { target.inputs.color = { kind: "color", value: "#12345600" }; }), /Shadow color cannot be fully transparent/],
    [hostile(`Glow(radius: 2px, opacity: 50%) { ${rect}; }`, "cut.visual.glow", (target) => { target.inputs.opacity = quantity("ratio", "ratio", 0); }), /Glow opacity.*radius/],
    [hostile(`Vignette(amount: 40%, softness: 20%) { ${rect}; }`, "cut.visual.vignette", (target) => { target.inputs.amount = quantity("ratio", "ratio", 0); }), /Vignette amount.*softness/],
    [hostile(`Vignette(radius: 50%, amount: 40%) { ${rect}; }`, "cut.visual.vignette", (target) => { target.inputs.radius = quantity("ratio", "ratio", 1); }), /Vignette radius is 100%.*amount/],
    [hostile(`Sharpen(radius: 2px, amount: 50%) { ${rect}; }`, "cut.visual.sharpen", (target) => { target.inputs.amount = quantity("ratio", "ratio", 0); }), /Sharpen amount.*radius/],
    [hostile(`Sharpen(radius: 1px, amount: 50%) { ${rect}; }`, "cut.visual.sharpen", (target) => { target.inputs.radius = quantity("length", "px", 0); }), /Sharpen radius.*amount/],
    [hostile(`Grain(amount: 8%, seed: 7) { ${rect}; }`, "cut.visual.grain", (target) => { target.inputs.amount = quantity("ratio", "ratio", 0); }), /Grain amount.*seed/],
    [hostile(`Duotone(shadows: #102030, amount: 50%) { ${rect}; }`, "cut.visual.duotone", (target) => { target.inputs.amount = quantity("ratio", "ratio", 0); }), /Duotone amount.*shadows/],
    [hostile("Trace(points: [{ x: 0px, y: 0px }, { x: 8px, y: 0px }], stroke: #ffffff, width: 1px, duration: 1s, headRadius: 2px, headColor: #ff0000);", "cut.visual.trace", (target) => { target.inputs.headColor = { kind: "color", value: "#ff000000" }; }), /Trace headColor cannot be fully transparent/],
    [hostile("Globe();", "cut.geo.globe", (target) => { target.inputs.markerRadius = quantity("length", "px", 2); }), /Globe has no points or stations.*markerRadius/],
    [hostile("Map();", "cut.geo.map", (target) => { target.inputs.signal = { kind: "color", value: "#ff0000" }; }), /Map has no points.*signal/],
    [hostile("Tone(frequency: 440hz, duration: 1s, amplitude: 20%);", "cut.audio.tone", (target) => { target.inputs.amplitude = quantity("ratio", "ratio", 0); }), /Tone amplitude must be positive/],
    [hostile("Noise(duration: 1s, amplitude: 8%);", "cut.audio.noise", (target) => { target.inputs.amplitude = quantity("ratio", "ratio", 0); }), /Noise amplitude must be positive/],
    [hostile(`Synth(events: ${synthEvent}, decay: 20ms, sustain: 50%);`, "cut.audio.synth", (target) => { target.inputs.sustain = quantity("ratio", "ratio", 1); }), /Synth decay cannot affect/],
    [hostile(`Synth(events: ${synthEvent}, sustain: 50%, release: 20ms);`, "cut.audio.synth", (target) => { target.inputs.sustain = quantity("ratio", "ratio", 0); }), /Synth release cannot affect/],
    [hostile(`EQ(frequency: 1khz, gain: 3db) { ${tone}; }`, "cut.audio.eq", (target) => { target.inputs.gain = quantity("gain", "db", 0); }), /ParametricEQ gain is 0 dB.*frequency/],
    [hostile(`Compressor(threshold: -24db, ratio: 3) { ${tone}; }`, "cut.audio.compressor", (target) => { target.inputs.ratio = quantity("scalar", "scalar", 1); }), /Compressor ratio is 1:1.*threshold/],
    [hostile(`DeEsser(intensity: 0.35, amount: 0.5) { ${tone}; }`, "cut.audio.deesser", (target) => { target.inputs.intensity = quantity("scalar", "scalar", 0); }), /DeEsser intensity is zero.*amount/],
    [hostile(`DeEsser(intensity: 0.35, amount: 0.5) { ${tone}; }`, "cut.audio.deesser", (target) => { target.inputs.amount = quantity("scalar", "scalar", 0); }), /DeEsser amount is zero.*intensity/],
    [hostile(`Delay(time: 10ms, wet: 25%) { ${tone}; }`, "cut.audio.delay", (target) => { target.inputs.wet = quantity("ratio", "ratio", 0); }), /Delay wet is 0%.*time/],
    [hostile(`let key = Tone(frequency: 3khz, duration: 1s); Sidechain(source: key, amount: -6db) { ${tone}; }`, "cut.audio.sidechain", (target) => { target.inputs.amount = quantity("gain", "db", 0); }), /Sidechain amount is 0 dB.*source/],
    [hostile(`TimeStretch(sourceDuration: 300ms, duration: 300ms, pitch: 3, quality: "draft") { Tone(frequency: 440hz, duration: 300ms); }`, "cut.audio.time_stretch", (target) => { target.inputs.pitch = quantity("scalar", "scalar", 0); }), /TimeStretch has identity duration and pitch.*quality/],
  ];

  for (const [index, [ir, expected]] of cases.entries()) {
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceNoOpContractError, `case ${index}: ${String(error)}`);
      assert.equal(error.code, referenceNoOpDiagnosticCode);
      assert.match(error.message, expected);
      assert.match(error.message, /project\.cut:\d+:\d+/);
      assert.ok(error.source.line > 0 && error.source.column > 0);
      return true;
    });
  }
});
