import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { compileReferenceAudioAutomation, ReferenceAudioAutomationError } from "../lib/runtime/reference/audio-automation";
import { referenceAudioNodeConfig } from "../lib/runtime/reference/audio-config";
import {
  planReferenceAudioRouting,
  ReferenceAudioRoutingError,
  referenceAudioRoutingLimits,
} from "../lib/runtime/reference/audio-routing";
import { planReferenceAudioStems, ReferenceStemError } from "../lib/runtime/reference/stems";
import { renderReferenceAudioStems } from "./reference-stem-test-helper";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function program(body: string, duration = "100ms") {
  return `cut 0.4;
project "explicit routing";
import { Bus, Gain, Noise, Return, Send, Submix, Tone } from "@cut/audio";
import { linear, outCubic, spring } from "@cut/motion";
timeline main(duration: ${duration}, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) { ${body} }
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

function sourceRoutingError(source: string, code: string, message: RegExp) {
  assert.throws(() => compile(source), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, source);
    const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === code);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.match(diagnostic.message, message);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    return true;
  });
}

function compileRoutingError(body: string, code: string, message: RegExp) {
  sourceRoutingError(program(body), code, message);
}

type Pcm24 = { frames: number; data: Buffer<ArrayBufferLike>; sample(frame: number, channel: number): number };

function pcm24(buffer: Buffer): Pcm24 {
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
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
  return { ir, pcm: pcm24(await readFile(output)), output };
}

test("Send, Return, and Submix lower to explicit typed routing dependencies", () => {
  const ir = compile(program(`
    Submix(name: "effects") {
      Send(amount: -6db) as roomSend { Noise(duration: 1ms, color: "white", seed: 11, amplitude: 5%); }
      Gain(amount: -3db) { Return(sends: [roomSend]); }
    }
  `));
  const send = node(ir, "cut.audio.send"), returned = node(ir, "cut.audio.return"), submix = node(ir, "cut.audio.submix");
  assert.equal(returned.inputs.sends?.kind, "array");
  if (returned.inputs.sends?.kind === "array") assert.deepEqual(returned.inputs.sends.items, [{ kind: "node-ref", id: send.id }]);
  assert.deepEqual(referenceAudioNodeConfig(ir, ir.compositions[0], send), { kind: "send", amountDb: -6, tap: "post" });
  assert.deepEqual(referenceAudioNodeConfig(ir, ir.compositions[0], returned), { kind: "return", sendNodeIds: [send.id] });
  assert.deepEqual(referenceAudioNodeConfig(ir, ir.compositions[0], submix), { kind: "submix", name: "effects" });
  const plan = planReferenceAudioRouting(ir, ir.compositions[0]);
  assert.deepEqual(plan.sends.get(send.id), { amountDb: -6, returnNodeId: returned.id });
  assert.deepEqual(plan.returns.get(returned.id), [send.id]);
  assert.equal(plan.submixes.get(submix.id), "effects");
  const schema = referenceKernelSchema("cut.audio.send");
  assert.equal(schema?.support, "supported");
  if (schema?.support === "supported") {
    assert.deepEqual(schema.inputs, ["amount", "source", "tap"]);
    assert.deepEqual(schema.stringInputs.tap, ["post", "pre-fader"]);
    assert.deepEqual(schema.properties, ["amount"]);
  }
  assert.doesNotThrow(() => validateReferenceSession(ir));
});

test("routed returns preserve exact placement and apply each bounded post-child send once", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-routing-"));
  const first = 'Noise(duration: 1ms, color: "white", seed: 17, amplitude: 5%);';
  const second = 'at 20ms { Noise(duration: 1ms, color: "white", seed: 29, amplitude: 5%); }';
  const dry = await render(program(`${first} ${second}`), root, "dry.wav");
  const routed = await render(program(`
    Submix(name: "effects") {
      Send(amount: -6db) as firstSend { ${first} }
      Send(amount: -12db) as secondSend { ${second} }
      Gain(amount: -3db) { Return(sends: [firstSend, secondSend]); }
    }
  `), root, "routed.wav");
  assert.equal(routed.pcm.frames, 4_800);
  const gain = (db: number) => 10 ** (db / 20), factors = [1 + gain(-6) * gain(-3), 1 + gain(-12) * gain(-3)];
  const tolerance = 6 / 0x800000;
  for (let frame = 0; frame < routed.pcm.frames; frame += 1) {
    const active = frame < 48 ? 0 : frame >= 960 && frame < 1_008 ? 1 : -1;
    for (const channel of [0, 1]) {
      const expected = active < 0 ? 0 : dry.pcm.sample(frame, channel) * factors[active];
      assert.ok(Math.abs(routed.pcm.sample(frame, channel) - expected) <= tolerance, `frame ${frame}, channel ${channel}`);
    }
  }
});

test("detached pre-fader Send taps exactly before one explicit Gain without changing the dry path", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-pre-fader-send-"));
  const body = (tap?: "post" | "pre-fader") => `
    Gain(amount: -18db) as fader { Tone(frequency: 1000hz, duration: 100ms, amplitude: 10%); }
    ${tap ? `let room = Send(amount: 0db, source: fader${tap === "pre-fader" ? ', tap: "pre-fader"' : ""}); Submix(name: "room") { Return(sends: [room]); }` : ""}
  `;
  const dry = await render(program(body()), root, "dry.wav");
  const post = await render(program(body("post")), root, "post.wav");
  const pre = await render(program(body("pre-fader")), root, "pre.wav");
  const linearFader = 10 ** (-18 / 20);
  for (const frame of [12, 36, 60, 84, 108, 1_212, 3_612]) {
    const drySample = dry.pcm.sample(frame, 0);
    assert.ok(Math.abs(post.pcm.sample(frame, 0) - drySample * 2) <= 3 / 0x800000, `post frame ${frame}`);
    const expectedPre = drySample + drySample / linearFader;
    assert.ok(Math.abs(pre.pcm.sample(frame, 0) - expectedPre) <= 5 / 0x800000, `pre frame ${frame}`);
  }
  const preSend = node(pre.ir, "cut.audio.send");
  assert.deepEqual(referenceAudioNodeConfig(pre.ir, pre.ir.compositions[0], preSend), {
    kind: "send",
    amountDb: 0,
    tap: "pre-fader",
    sourceNodeId: node(pre.ir, "cut.audio.gain").id,
  });
  const faderId = node(pre.ir, "cut.audio.gain").id;
  assert.deepEqual(planReferenceAudioRouting(pre.ir, pre.ir.compositions[0]).sends.get(preSend.id), {
    amountDb: 0,
    returnNodeId: node(pre.ir, "cut.audio.return").id,
    sourceNodeId: faderId,
    tap: "pre-fader",
    preFaderNodeId: faderId,
  });
});

test("pre-fader Send fails closed without one explicit Gain source", () => {
  compileRoutingError(
    'Send(amount: -12db, tap: "pre-fader") as room { Tone(frequency: 440hz, duration: 50ms); } Return(sends: [room]);',
    "CUT_AUDIO_GRAPH",
    /requires a detached source/u,
  );
  sourceRoutingError(
    program('Bus(name: "dialogue") as dialogue { Tone(frequency: 440hz, duration: 50ms); } let room = Send(amount: -12db, source: dialogue, tap: "pre-fader"); Bus(name: "room", kind: "aux") { Return(sends: [room]); }'),
    "CUT_AUDIO_ROUTING_GRAPH",
    /requires source .* to be one explicit Gain/u,
  );
  const hostile = compile(program('Gain(amount: -6db) as fader { Tone(frequency: 440hz, duration: 50ms); } let room = Send(amount: -12db, source: fader, tap: "pre-fader"); Submix(name: "room") { Return(sends: [room]); }'));
  const hostileSend = node(hostile, "cut.audio.send");
  hostileSend.inputs.tap = { kind: "string", value: "sideways" };
  assert.throws(() => validateReferenceSession(hostile), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /CUT_AUDIO_ENUM: .*requires tap to be one of: post, pre-fader/u);
    return true;
  });
});

test("Send.amount set/linear/outCubic automation executes on the destination sample clock without changing the dry path", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-send-automation-"));
  const noise = 'Noise(duration: 100ms, color: "white", seed: 73, amplitude: 5%);';
  const dry = await render(program(noise), root, "dry.wav"), end = 3_840;
  for (const curve of ["linear", "outCubic"] as const) {
    const routed = await render(program(`Submix(name: "effects") {
      Send(amount: -60db) as auxiliary { ${noise} }
      Return(sends: [auxiliary]);
      animate auxiliary.amount from -60db to 0db over 80ms ease ${curve};
    }`), root, `${curve}.wav`);
    const send = node(routed.ir, "cut.audio.send"), automation = compileReferenceAudioAutomation(routed.ir, routed.ir.compositions[0], send);
    assert.equal(automation?.property, "amount");
    assert.equal(automation?.eventCount, 1);
    const tolerance = 8 / 0x800000;
    for (const frame of [0, 1, 479, 960, 2_400, end - 1, end, 4_799]) {
      const progress = Math.min(1, frame / end), eased = curve === "linear" ? progress : 1 - (1 - progress) ** 3;
      const amountDb = -60 + 60 * eased, factor = 1 + 10 ** (amountDb / 20);
      for (const channel of [0, 1]) {
        const expected = dry.pcm.sample(frame, channel) * factor;
        assert.ok(Math.abs(routed.pcm.sample(frame, channel) - expected) <= tolerance, `${curve} frame ${frame}:${channel}`);
      }
    }
  }

  const old = await render(program(`Submix(name: "effects") { Send(amount: -12db) as auxiliary { ${noise} } Return(sends: [auxiliary]); }`), root, "old.wav");
  const stepped = await render(program(`Submix(name: "effects") {
    Send(amount: -12db) as auxiliary { ${noise} }
    Return(sends: [auxiliary]);
    at 50ms { set auxiliary.amount = 0db; }
  }`), root, "stepped.wav"), event = 2_400, tolerance = 8 / 0x800000;
  for (let frame = 0; frame < event; frame += 1) for (const channel of [0, 1]) {
    assert.ok(Math.abs(stepped.pcm.sample(frame, channel) - old.pcm.sample(frame, channel)) <= tolerance, `pre-event ${frame}:${channel}`);
  }
  for (const channel of [0, 1]) {
    assert.ok(Math.abs(stepped.pcm.sample(event, channel) - dry.pcm.sample(event, channel) * 2) <= tolerance, `event sample ${channel}`);
  }
});

test("Send.amount automation fails closed on type, range, easing, grid, and hostile signal values", () => {
  const source = (mutation: string) => program(`Submix(name: "effects") {
    Send(amount: -12db) as auxiliary { Tone(frequency: 440hz, duration: 100ms); }
    Return(sends: [auxiliary]);
    ${mutation}
  }`);
  const wrongType = checkCutModule(parse(source("set auxiliary.amount = 50%;"))).diagnostics;
  assert.ok(wrongType.some((item) => item.code === "CUT2035" && /Cannot set Gain to Ratio/.test(item.message)), JSON.stringify(wrongType));
  const fails = (ir: CutAVIR, code: ReferenceAudioAutomationError["code"]) => assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioAutomationError);
    assert.equal(error.code, code);
    assert.equal(error.source.module, "project.cut");
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });
  fails(compile(source("set auxiliary.amount = 13db;")), "CUT_AUDIO_AUTOMATION_VALUE_RANGE");
  fails(compile(source("animate auxiliary.amount from -12db to 0db over 50ms ease spring();")), "CUT_AUDIO_AUTOMATION_EASING");
  fails(compile(source("at 0.1ms { set auxiliary.amount = 0db; }")), "CUT_AUDIO_AUTOMATION_SAMPLE_GRID");
  const hostile = compile(source("set auxiliary.amount = -6db;")), send = node(hostile, "cut.audio.send"), reference = send.properties.amount;
  assert.ok("signal" in reference);
  if ("signal" in reference) {
    const signal = hostile.signals[reference.signal];
    assert.equal(signal.kind, "track");
    if (signal.kind === "track" && signal.events[0]?.kind === "set") signal.events[0].value = { kind: "quantity", dimension: "gain", magnitude: { numerator: "60", denominator: "1" }, unit: "db" };
  }
  fails(hostile, "CUT_AUDIO_AUTOMATION_VALUE_RANGE");
});

test("routing fails closed for dangling, duplicate, mistyped, unnamed, and dynamic layouts", () => {
  sourceRoutingError(`cut 0.4;
project "detached routing";
import { Send, Tone } from "@cut/audio";
component DetachedSend() -> AudioNode {
  Send(amount: -6db) { Tone(frequency: 440hz, duration: 10ms); }
}
timeline main(duration: 100ms, fps: 20, sampleRate: 48khz) { let orphan = DetachedSend(); }
export out = render(main);`, "CUT_AUDIO_ROUTING_DANGLING", /not structurally reachable.*ignore their authored controls/);
  compileRoutingError('Return(sends: []);', "CUT_AUDIO_ROUTING_DANGLING", /at least one explicitly referenced Send/);
  compileRoutingError('Send(amount: -6db) { Tone(frequency: 440hz, duration: 50ms); }', "CUT_AUDIO_ROUTING_DANGLING", /not claimed by an explicit reachable Return/);
  compileRoutingError('Submix(name: "mix") { Tone(frequency: 440hz, duration: 50ms) as tone; Return(sends: [tone]); }', "CUT_AUDIO_ROUTING_GRAPH", /is not a Send node/);
  compileRoutingError('Submix(name: "mix") { Send(amount: -6db) as send { Tone(frequency: 440hz, duration: 50ms); } Return(sends: [send, send]); }', "CUT_AUDIO_ROUTING_DUPLICATE", /more than once/);
  compileRoutingError('Submix(name: "mix") { Send(amount: -6db) as send { Tone(frequency: 440hz, duration: 50ms); } Return(sends: [send]); Return(sends: [send]); }', "CUT_AUDIO_ROUTING_DUPLICATE", /already claimed/);
  compileRoutingError('Submix(name: "bad name!") { Tone(frequency: 440hz, duration: 50ms); }', "CUT_AUDIO_ROUTING_NAME", /portable ASCII/);
  compileRoutingError('Submix(name: "Mix") { Tone(frequency: 440hz, duration: 50ms); } Submix(name: "mix") { Tone(frequency: 660hz, duration: 50ms); }', "CUT_AUDIO_ROUTING_DUPLICATE", /duplicates/);
  compileRoutingError('Submix(name: "mix") { Send(amount: 13db) as send { Tone(frequency: 440hz, duration: 50ms); } Return(sends: [send]); }', "CUT_AUDIO_VALUE_RANGE", /amount between -120 and 12/);

  const animatedSource = program('Submix(name: "mix") { Send(amount: -6db) as send { Tone(frequency: 440hz, duration: 50ms); } Return(sends: [send]); animate send.amount from -6db to 0db over 50ms; }');
  assert.deepEqual(checkCutModule(parse(animatedSource)).diagnostics, []);
  assert.doesNotThrow(() => validateReferenceSession(compile(animatedSource)));

  assert.throws(() => compile(program("Send(amount: -6db);")), (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT2085" && /requires at least one audio child/.test(diagnostic.message)));
  assert.throws(() => compile(program('Submix(name: "empty");')), (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT2085" && /requires at least one audio child/.test(diagnostic.message)));
});

test("Submix name diagnostics bound hostile strings and preserve readable duplicates", () => {
  const unsafe = compile(program('Submix(name: "safe") { Tone(frequency: 440hz, duration: 50ms); }'));
  const unsafeSubmix = node(unsafe, "cut.audio.submix"), hostile = hostileDiagnosticString();
  unsafeSubmix.inputs.name = { kind: "string", value: hostile.value };
  assert.throws(() => planReferenceAudioRouting(unsafe, unsafe.compositions[0]), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioRoutingError);
    assert.equal(error.code, "CUT_AUDIO_ROUTING_NAME");
    assert.deepEqual(error.source, {
      module: "project.cut",
      line: unsafeSubmix.provenance.span.start.line,
      column: unsafeSubmix.provenance.span.start.column,
      nodeId: unsafeSubmix.id,
    });
    assertBoundedHostileDiagnostic(error.message, hostile.preview, hostile.value);
    return true;
  });

  const duplicate = compile(program('Submix(name: "Mix") { Tone(frequency: 440hz, duration: 50ms); } Submix(name: "other") { Tone(frequency: 660hz, duration: 50ms); }'));
  const submixes = Object.values(duplicate.nodes).filter((candidate) => candidate.op === "cut.audio.submix");
  assert.equal(submixes.length, 2);
  const duplicateOwner = submixes.find((candidate) => candidate.inputs.name?.kind === "string" && candidate.inputs.name.value === "other");
  assert.ok(duplicateOwner);
  duplicateOwner.inputs.name = { kind: "string", value: "mix" };
  assert.throws(() => planReferenceAudioRouting(duplicate, duplicate.compositions[0]), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioRoutingError);
    assert.equal(error.code, "CUT_AUDIO_ROUTING_DUPLICATE");
    assert.match(error.message, /Submix name "(?:Mix|mix)" duplicates the submix at project\.cut:\d+:\d+/u);
    assert.doesNotMatch(error.message, /Unicode code points/u);
    const offendingName = error.message.includes('Submix name "Mix"') ? "Mix" : "mix";
    const offending = submixes.find((candidate) => candidate.inputs.name?.kind === "string" && candidate.inputs.name.value === offendingName);
    assert.ok(offending);
    assert.deepEqual(error.source, {
      module: "project.cut",
      line: offending.provenance.span.start.line,
      column: offending.provenance.span.start.column,
      nodeId: offending.id,
    });
    return true;
  });
});

test("hostile routing IR cannot create empty returns, duplicate dry ownership, or feedback cycles", () => {
  const fresh = () => compile(program('Submix(name: "mix") { Send(amount: -6db) as send { Tone(frequency: 440hz, duration: 50ms); } Return(sends: [send]); }'));
  const expects = (ir: CutAVIR, code: ReferenceAudioRoutingError["code"], message: RegExp) => assert.throws(() => planReferenceAudioRouting(ir, ir.compositions[0]), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioRoutingError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });

  const empty = fresh(), emptyReturn = node(empty, "cut.audio.return");
  emptyReturn.inputs.sends = { kind: "array", items: [] };
  expects(empty, "CUT_AUDIO_ROUTING_DANGLING", /at least one/);

  const duplicate = fresh(), duplicateSubmix = node(duplicate, "cut.audio.submix"), duplicateSend = node(duplicate, "cut.audio.send");
  duplicateSubmix.children.splice(1, 0, duplicateSend.id);
  expects(duplicate, "CUT_AUDIO_ROUTING_DUPLICATE", /exactly one structural dry-path owner/);

  const cyclic = fresh(), cyclicSubmix = node(cyclic, "cut.audio.submix"), cyclicSend = node(cyclic, "cut.audio.send"), cyclicReturn = node(cyclic, "cut.audio.return");
  cyclicSubmix.children = [cyclicSend.id];
  cyclicSend.children = [cyclicReturn.id];
  expects(cyclic, "CUT_AUDIO_ROUTING_CYCLE", /unsupported feedback semantics/);

  const limited = fresh(), limitedReturn = node(limited, "cut.audio.return");
  limitedReturn.inputs.sends = { kind: "array", items: Array.from({ length: referenceAudioRoutingLimits.maximumSendsPerReturn + 1 }, () => ({ kind: "node-ref", id: node(limited, "cut.audio.send").id })) };
  expects(limited, "CUT_AUDIO_ROUTING_LIMIT", /maximum is 32/);
});

function cacheFixture(amount: number) {
  const parsed = parseCutLanguage(`cut 0.4; project "routing cache";
import { Rect } from "cut:visual"; import { Return, Send, Submix, Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { Rect(width: 64px, height: 64px, fill: #102030); Submix(name: "mix") { Send(amount: ${amount}db) as send { Tone(frequency: 440hz, duration: 1s); } Return(sends: [send]); } }
} export out = render(main);`);
  assert.ok(parsed.module); assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

test("send edits invalidate Send, Return, and Submix audio identity but not picture scenes", () => {
  const before = cacheFixture(-6), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = cacheFixture(-12), plan = createIncrementalRenderPlan(after, "main", previous);
  for (const op of ["cut.audio.send", "cut.audio.return", "cut.audio.submix"]) {
    const changed = node(after, op);
    assert.equal(plan.nodes.find((candidate) => candidate.id === changed.id)?.status, "miss", op);
  }
  assert.ok(plan.scenes.every((scene) => scene.status === "hit"));
});

test("a named Bus containing routed submix audio remains a deterministic stem", { timeout: 30_000 }, async () => {
  const source = program('Bus(name: "routed") { Submix(name: "effects") { Send(amount: -6db) as send { Noise(duration: 10ms, color: "white", seed: 41, amplitude: 5%); } Return(sends: [send]); } }');
  const root = await mkdtemp(resolve(tmpdir(), "cut-routing-stem-")), ir = compile(source), composition = ir.compositions[0];
  validateReferenceSession(ir);
  const master = resolve(root, "master.wav");
  await renderReferenceAudio(ir, composition, root, master);
  const stems = await renderReferenceAudioStems(ir, composition, root, resolve(root, "stems"));
  assert.deepEqual(stems.manifest.stems.map((stem) => stem.file), ["routed.wav"]);
  const stem = pcm24(await readFile(resolve(root, "stems", "routed.wav"))), direct = pcm24(await readFile(master));
  assert.equal(stem.frames, direct.frames);
  let maximumQuantizationDelta = 0;
  for (let frame = 0; frame < stem.frames; frame += 1) for (const channel of [0, 1]) {
    maximumQuantizationDelta = Math.max(maximumQuantizationDelta, Math.abs(stem.sample(frame, channel) - direct.sample(frame, channel)));
  }
  assert.ok(maximumQuantizationDelta <= 2 / 0x800000, `canonical nearest-even stem quantization differs by ${maximumQuantizationDelta}`);
});

test("stem planning refuses cross-program-Bus sends unless the receiving Bus is explicitly aux", () => {
  const ir = compile(program(`
    Bus(name: "dialogue") {
      Send(amount: -12db) as dialogueSend { Tone(frequency: 440hz, duration: 50ms); }
      Return(sends: [dialogueSend]);
    }
    Bus(name: "effects") {
      Send(amount: -18db) as effectsSend { Tone(frequency: 880hz, duration: 50ms); }
      Return(sends: [effectsSend]);
    }
  `));
  const buses = Object.values(ir.nodes).filter((candidate) => candidate.op === "cut.audio.bus");
  assert.equal(buses.length, 2);
  const routeNodes = (bus: (typeof buses)[number]) => {
    const children = bus.children.map((id) => ir.nodes[id]);
    const send = children.find((candidate) => candidate.op === "cut.audio.send");
    const returned = children.find((candidate) => candidate.op === "cut.audio.return");
    assert.ok(send && returned);
    return { send, returned };
  };
  const first = routeNodes(buses[0]), second = routeNodes(buses[1]);
  first.returned.inputs.sends = { kind: "array", items: [{ kind: "node-ref", id: second.send.id }] };
  second.returned.inputs.sends = { kind: "array", items: [{ kind: "node-ref", id: first.send.id }] };
  assert.throws(() => planReferenceAudioStems(ir, ir.compositions[0]), (error: unknown) => {
    assert.ok(error instanceof ReferenceStemError);
    assert.equal(error.code, "CUT_STEM_AUX_DIRECTION");
    assert.match(error.message, /only an aux stem may receive a cross-stem Send/);
    return true;
  });
});
