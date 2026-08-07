import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { IRNode, IRValue } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { builtinPackages } from "../lib/language/packages";
import { rational } from "../lib/language/rational";
import { assertResolvedCutIr } from "../lib/language/resolution";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { planReferenceAudioStems } from "../lib/runtime/reference/stems";
import { compileReferenceSynthPlan, renderReferenceSynthWave } from "../lib/runtime/reference/synth";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) { return compileCutModule(parse(source)).ir; }

function program(arguments_: string, duration = "1s", wrapper = "") {
  const node = `Synth(${arguments_});`;
  return `cut 0.4; project "Synth conformance"; import { Synth${wrapper ? ", Bus, Gain" : ""} } from "@cut/audio"; timeline main(duration: ${duration}, fps: 24, sampleRate: 48khz) { scene score(duration: ${duration}) { ${wrapper ? `Bus(name: "music") { Gain(amount: -6db) { ${node} } }` : node} } } export out = render(main);`;
}

function noteProgram(event: string, imports = "Synth, note") {
  return `cut 0.4; project "note lowering"; import { ${imports} } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { scene score(duration: 1s) { Synth(events: [${event}]); } } export out = render(main);`;
}

const twoPitchKinds = `events: [
  { start: 0ms, duration: 200ms, hz: 1000hz, velocity: 50% },
  { start: 250ms, duration: 200ms, pitch: 69, velocity: 25% }
], waveform: "sine", attack: 0ms, decay: 0ms, sustain: 100%, release: 0ms, polyphony: 1`;

function synthNode(ir: ReturnType<typeof compile>) {
  const node = Object.values(ir.nodes).find((item) => item.op === "cut.audio.synth");
  assert.ok(node); return node;
}

function pcm24Data(buffer: Buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF"); assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.equal(channels, 2); assert.equal(sampleRate, 48_000); assert.equal(blockAlign, 6); assert.equal(bits, 24); assert.ok(data.length > 0);
  const sample = (frame: number, channel = 0) => {
    const position = frame * blockAlign + channel * 3; let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000; return value / 0x800000;
  };
  return { frames: data.length / blockAlign, sample };
}

test("Synth NoteEvent is a closed typed pitch-or-Hz union", () => {
  const valid = parse(program(twoPitchKinds));
  assert.deepEqual(checkCutModule(valid).diagnostics.filter((item) => item.severity === "error"), []);
  const lowered = compileCutModule(valid).ir, node = synthNode(lowered);
  assert.equal(node.inputs.events.kind, "array");
  assert.deepEqual(node.inputs.events.items.map((item) => item.kind === "object" ? Object.keys(item.entries).sort() : []), [
    ["duration", "hz", "start", "velocity"],
    ["duration", "pitch", "start", "velocity"],
  ]);

  const invalid = [
    `{ start: 0ms, duration: 100ms, pitch: 69 }`,
    `{ start: 0ms, duration: 100ms, pitch: 69, hz: 440hz, velocity: 50% }`,
    `{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50%, channel: 1 }`,
    `{ start: 0ms, duration: 100ms, pitch: "A4", velocity: 50% }`,
  ];
  for (const event of invalid) {
    const checked = checkCutModule(parse(program(`events: [${event}]`)));
    assert.ok(checked.diagnostics.some((item) => item.code === "CUT2029"), event);
  }

  const mixed = checkCutModule(parse(program(`events: [
    { start: 0ms, duration: 100ms, pitch: 69, velocity: 50% },
    { start: 100ms, duration: 100ms, pitch: 72, hz: 440hz, velocity: 50% }
  ]`)));
  assert.ok(mixed.diagnostics.some((item) => item.code === "CUT2011"), "a later event cannot bypass NoteEvent's closed pitch-or-Hz union through array inference");
});

test("note is a package-declared compile-time record constructor with exact object equivalence", () => {
  const descriptor = builtinPackages.get("@cut/audio")?.symbols.note;
  assert.deepEqual({ kind: descriptor?.kind, returns: descriptor?.returns, lowering: descriptor?.lowering, native: descriptor?.native, domain: descriptor?.domain }, {
    kind: "function", returns: "NoteEvent", lowering: "record", native: undefined, domain: undefined,
  });
  assert.deepEqual(descriptor?.parameters?.map(({ name, type, optional }) => ({ name, type, optional })), [
    { name: "start", type: "Time", optional: undefined },
    { name: "duration", type: "Time", optional: undefined },
    { name: "pitch", type: "Number", optional: undefined },
    { name: "velocity", type: "Ratio", optional: undefined },
  ]);

  const literal = compile(noteProgram("{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50% }", "Synth"));
  const constructor = compile(noteProgram("note(0ms, 100ms, 69, 50%)"));
  const aliasedNamed = compile(noteProgram("n(velocity: 50%, pitch: 69, start: 0ms, duration: 100ms)", "Synth, note as n"));
  const events = (ir: typeof literal) => synthNode(ir).inputs.events;
  assert.deepEqual(events(constructor), events(literal));
  assert.deepEqual(events(aliasedNamed), events(literal));
  assert.equal(synthNode(constructor).contentHash, synthNode(literal).contentHash);
  assert.equal(synthNode(aliasedNamed).contentHash, synthNode(literal).contentHash);
  assert.equal(constructor.buildId, literal.buildId);
  assert.equal(aliasedNamed.buildId, literal.buildId);
  assert.notEqual(constructor.sourceHash, literal.sourceHash);

  const valueCalls = (value: IRValue): string[] => value.kind === "call" ? [value.op, ...value.positional.flatMap(valueCalls), ...Object.values(value.named).flatMap(valueCalls)]
    : value.kind === "array" ? value.items.flatMap(valueCalls)
      : value.kind === "object" ? Object.values(value.entries).flatMap(valueCalls)
        : value.kind === "range" ? [...valueCalls(value.start), ...valueCalls(value.end)]
          : value.kind === "unary" ? valueCalls(value.value)
            : value.kind === "binary" ? [...valueCalls(value.left), ...valueCalls(value.right)]
              : value.kind === "member" ? valueCalls(value.object)
                : value.kind === "index" ? [...valueCalls(value.object), ...valueCalls(value.index)] : [];
  assert.deepEqual(Object.values(constructor.nodes).map((node) => node.op), ["cut.audio.synth"]);
  assert.deepEqual(constructor.jobs, []);
  assert.deepEqual(Object.values(constructor.nodes).flatMap((node) => Object.values(node.inputs).flatMap(valueCalls)), []);

  const leaked = structuredClone(constructor), leakedEvents = synthNode(leaked).inputs.events;
  assert.equal(leakedEvents.kind, "array");
  if (leakedEvents.kind === "array") leakedEvents.items[0] = { kind: "call", op: "note", positional: [], named: {}, effect: "pure" };
  assert.throws(() => assertResolvedCutIr(leaked), /call “note” was not reduced/);
});

test("note composes through constants and the existing Hz object variant", () => {
  const source = `cut 0.4;
project "mixed note forms";
import { Synth, note } from "@cut/audio";
const pulse: NoteEvent = note(0ms, 100ms, 69, 50%);
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  scene score(duration: 1s) {
    Synth(events: [pulse, { start: 200ms, duration: 100ms, hz: 440hz, velocity: 25% }]);
  }
}
export out = render(main);`;
  const checked = checkCutModule(parse(source));
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(checked.module).ir, events = synthNode(ir).inputs.events;
  assert.equal(events.kind, "array");
  if (events.kind === "array") assert.deepEqual(events.items.map((item) => item.kind === "object" ? Object.keys(item.entries) : []), [
    ["start", "duration", "pitch", "velocity"], ["start", "duration", "hz", "velocity"],
  ]);
  assert.doesNotThrow(() => validateReferenceSession(ir));
});

test("note argument and context errors fail in the ordinary checker", () => {
  const invalid: Array<{ call: string; code: string }> = [
    { call: "note(0ms, 100ms, 69)", code: "CUT2028" },
    { call: "note(0ms, 100ms, 69, 50%, 1)", code: "CUT2025" },
    { call: "note(0ms, 100ms, 69, 50%, pitch: 70)", code: "CUT2026" },
    { call: "note(start: 0ms, duration: 100ms, hz: 440hz, velocity: 50%)", code: "CUT2027" },
    { call: "note(1px, 100ms, 69, 50%)", code: "CUT2029" },
    { call: "note(0ms, 1px, 69, 50%)", code: "CUT2029" },
    { call: "note(0ms, 100ms, 440hz, 50%)", code: "CUT2029" },
    { call: "note(0ms, 100ms, 69, 1)", code: "CUT2029" },
  ];
  for (const { call, code } of invalid) {
    const cutModule = parse(noteProgram(call)), diagnostics = checkCutModule(cutModule).diagnostics;
    assert.ok(diagnostics.some((item) => item.code === code), `${call} should produce ${code}: ${diagnostics.map((item) => item.code).join(", ")}`);
    assert.throws(() => compileCutModule(cutModule));
  }

  const nodeSource = `cut 0.4; project "note is a value"; import { note } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { scene score(duration: 1s) { note(0ms, 100ms, 69, 50%); } } export out = render(main);`;
  assert.ok(checkCutModule(parse(nodeSource)).diagnostics.some((item) => item.code === "CUT2032"));
  const frameSource = `cut 0.4; project "frame context"; import { note } from "@cut/audio"; const pulse: NoteEvent = note(1f, 100ms, 69, 50%);`;
  assert.ok(checkCutModule(parse(frameSource)).diagnostics.some((item) => item.code === "CUT2054"));
});

test("note retains Synth runtime bounds instead of adding hidden constructor semantics", () => {
  for (const [event, expected] of [
    ["note(0ms, 100ms, 128, 50%)", /MIDI note number between 0 and 127/],
    ["note(0ms, 100ms, 69, 0%)", /velocity must be greater than 0%/],
    ["note(0ms, -100ms, 69, 50%)", /duration must be positive/],
  ] as const) {
    const ir = compile(noteProgram(event));
    assert.throws(() => validateReferenceSession(ir), expected);
  }
});

test("Synth score meaning participates in canonical node and graph content hashes", () => {
  const first = compile(program(`events: [{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50% }]`));
  const replay = compile(program(`events: [{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50% }]`));
  const changed = compile(program(`events: [{ start: 0ms, duration: 100ms, pitch: 70, velocity: 50% }]`));
  assert.equal(synthNode(first).contentHash, synthNode(replay).contentHash);
  assert.equal(first.buildId, replay.buildId);
  assert.notEqual(synthNode(first).contentHash, synthNode(changed).contentHash);
  assert.notEqual(first.buildId, changed.buildId);
});

test("Synth renders pitch and Hz events at exact sample boundaries through the audio graph", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-synth-pcm-"));
  try {
    const ir = compile(program(twoPitchKinds, "1s", "routed")), output = resolve(root, "score.wav"), routedGain = 10 ** (-6 / 20);
    validateReferenceSession(ir);
    await renderReferenceAudio(ir, ir.compositions[0], root, output);
    const pcm = pcm24Data(await readFile(output)), tolerance = 3 / 0x800000;
    assert.equal(pcm.frames, 48_000);
    assert.ok(Math.abs(pcm.sample(1) - routedGain * .5 * Math.sin(2 * Math.PI * 1000 / 48_000)) <= tolerance);
    assert.equal(pcm.sample(9_600), 0, "first gate ends at exactly 200 ms");
    assert.equal(pcm.sample(11_999), 0, "inter-note silence remains exact");
    assert.equal(pcm.sample(12_000), 0, "second sine begins at phase zero");
    assert.ok(Math.abs(pcm.sample(12_001) - routedGain * .25 * Math.sin(2 * Math.PI * 440 / 48_000)) <= tolerance);
    for (const frame of [1, 9_599, 12_001, 21_599]) assert.equal(pcm.sample(frame, 0), pcm.sample(frame, 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Synth combines node placement and event timing on the exact output sample", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-synth-placement-"));
  try {
    const source = `cut 0.4; project "Synth placement"; import { Synth } from "@cut/audio";
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { scene score(duration: 1s) {
  at 100ms { Synth(events: [{ start: 50ms, duration: 25ms, hz: 1000hz, velocity: 50% }]); }
} } export out = render(main);`;
    const ir = compile(source), output = resolve(root, "placed.wav");
    validateReferenceSession(ir); await renderReferenceAudio(ir, ir.compositions[0], root, output);
    const pcm = pcm24Data(await readFile(output)), tolerance = 3 / 0x800000;
    assert.equal(pcm.sample(7_199), 0);
    assert.equal(pcm.sample(7_200), 0, "the sine starts at phase zero on the exact 150 ms boundary");
    assert.ok(Math.abs(pcm.sample(7_201) - .5 * Math.sin(2 * Math.PI * 1000 / 48_000)) <= tolerance);
    assert.equal(pcm.sample(8_400), 0, "the 25 ms gate ends exactly at 175 ms");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("neutral omitted ADSR defaults remain exact at 44.1 kHz", () => {
  const source = `cut 0.4; project "Synth defaults"; import { Synth } from "@cut/audio"; timeline main(duration: 1s, fps: 24, sampleRate: 44.1khz) { scene score(duration: 1s) { Synth(events: [{ start: 0ms, duration: 100ms, pitch: 69.5, velocity: 50% }]); } } export out = render(main);`;
  const ir = compile(source); assert.doesNotThrow(() => validateReferenceSession(ir));
  const plan = compileReferenceSynthPlan(ir, ir.compositions[0], synthNode(ir));
  assert.equal(plan.attackSamples, 0); assert.equal(plan.decaySamples, 0); assert.equal(plan.sustain, 1); assert.equal(plan.releaseSamples, 0);
  assert.ok(Math.abs(plan.events[0].frequency - 440 * 2 ** (.5 / 12)) < 1e-12);
});

test("Synth ADSR stages and release use authored sample boundaries", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-synth-adsr-"));
  try {
    const args = `events: [{ start: 0ms, duration: 8ms, hz: 1000hz, velocity: 100% }], waveform: "sine", attack: 2ms, decay: 2ms, sustain: 50%, release: 2ms, polyphony: 1`;
    const ir = compile(program(args, "20ms")), output = resolve(root, "adsr.wav");
    validateReferenceSession(ir); await renderReferenceAudio(ir, ir.compositions[0], root, output);
    const pcm = pcm24Data(await readFile(output)), tolerance = 3 / 0x800000;
    for (const [sample, expected] of [[60, .625], [108, .9375], [204, .5], [396, .4375]] as const) {
      assert.ok(Math.abs(pcm.sample(sample) - expected) <= tolerance, `sample ${sample}: ${pcm.sample(sample)} != ${expected}`);
    }
    assert.equal(pcm.sample(480), 0, "release ends at exactly 10 ms");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all Synth waveforms produce repeatable, distinct deterministic PCM", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-synth-waveforms-"));
  try {
    const hashes = new Set<string>();
    for (const waveform of ["sine", "triangle", "saw", "square"] as const) {
      const args = `events: [{ start: 0ms, duration: 50ms, hz: 500hz, velocity: 25% }], waveform: "${waveform}", attack: 1ms, decay: 1ms, sustain: 75%, release: 2ms, polyphony: 1`;
      const ir = compile(program(args, "100ms")), plan = compileReferenceSynthPlan(ir, ir.compositions[0], synthNode(ir));
      const first = resolve(root, `${waveform}-1.wav`), second = resolve(root, `${waveform}-2.wav`);
      await renderReferenceSynthWave(plan, first); await renderReferenceSynthWave(plan, second);
      const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      const firstHash = digest(await readFile(first)); assert.equal(firstHash, digest(await readFile(second))); hashes.add(firstHash);
    }
    assert.equal(hashes.size, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Synth preflight refuses malformed loaded IR, inexact timing, unsafe scores, and voice stealing", () => {
  const rejects = (arguments_: string, expected: RegExp, duration = "1s") => {
    const ir = compile(program(arguments_, duration)); assert.throws(() => validateReferenceSession(ir), expected);
  };
  rejects(`events: []`, /at least one NoteEvent/);
  rejects(`events: [{ start: 1s / 48001, duration: 100ms, pitch: 69, velocity: 50% }]`, /does not land on the 48000 Hz sample boundary/);
  rejects(`events: [{ start: 0ms, duration: 100ms, hz: 24000hz, velocity: 50% }]`, /Nyquist limit/);
  rejects(`events: [{ start: 0ms, duration: 8ms, pitch: 69, velocity: 50% }], attack: 6ms, decay: 3ms, sustain: 50%`, /attack \+ decay cannot exceed/);
  rejects(`events: [{ start: 900ms, duration: 100ms, pitch: 69, velocity: 50% }], release: 1ms`, /including release exceeds/);
  rejects(`events: [{ start: 0ms, duration: 200ms, pitch: 69, velocity: 50% }, { start: 100ms, duration: 200ms, pitch: 72, velocity: 50% }], polyphony: 1`, /2 simultaneous voices.*voice stealing is forbidden/);
  const invalidWaveform = compile(program(`events: [{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50% }], waveform: "sine"`));
  synthNode(invalidWaveform).inputs.waveform = { kind: "string", value: "pulse" };
  assert.throws(() => validateReferenceSession(invalidWaveform), /input “waveform” must be one of: sine, triangle, saw, square/);
  rejects(`events: [{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50% }], polyphony: 33`, /integer from 1 through 32/);

  const malformed = compile(program(`events: [{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50% }]`));
  const event = synthNode(malformed).inputs.events;
  assert.equal(event.kind, "array"); assert.equal(event.items[0].kind, "object");
  if (event.items[0].kind === "object") event.items[0].entries.hz = { kind: "quantity", dimension: "frequency", magnitude: rational(440), unit: "hz" };
  assert.throws(() => validateReferenceSession(malformed), /exactly one of “pitch” or “hz”/);

  const overBudget = compile(program(`events: [{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50% }]`)), node = synthNode(overBudget);
  const events = node.inputs.events; assert.equal(events.kind, "array"); events.items = Array.from({ length: 513 }, () => events.items[0]);
  assert.throws(() => validateReferenceSession(overBudget), /512-event per-node limit/);
});

test("Synth is an ordinary routed source for named stem planning", () => {
  const ir = compile(program(`events: [{ start: 0ms, duration: 100ms, pitch: 69, velocity: 50% }]`, "1s", "routed"));
  const plan = planReferenceAudioStems(ir, ir.compositions[0]);
  assert.deepEqual(plan.routes.map((route) => route.name), ["music"]);
  const music = ir.nodes[plan.routes[0].nodeId] as IRNode;
  assert.equal(music.op, "cut.audio.bus");
});
