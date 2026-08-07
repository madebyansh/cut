import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRValue } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { compileReferenceAudioAutomation } from "../lib/runtime/reference/audio-automation";
import { ReferenceAudioConfigError, referenceAudioNodeConfig } from "../lib/runtime/reference/audio-config";
import { ReferenceAudioPeakError } from "../lib/runtime/reference/audio-peak";
import { planReferenceAudioRouting } from "../lib/runtime/reference/audio-routing";
import { planReferenceAudioStems, ReferenceStemError } from "../lib/runtime/reference/stems";
import { renderReferenceAudioStems } from "./reference-stem-test-helper";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function source(body: string, duration = "200ms") {
  return `cut 0.4;
project "Aux stem proof";
import { Bus, Gain, Reverb, Return, Send, Tone } from "@cut/audio";
timeline main(duration: ${duration}, fps: 25, width: 64px, height: 64px, sampleRate: 48khz) {
  ${body}
}
export out = render(main, width: 64px, height: 64px);`;
}

function parsed(program: string) {
  const result = parseCutLanguage(program);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(program: string) {
  const cutModule = parsed(program), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics, []);
  const result = compileCutModule(cutModule);
  assert.deepEqual(result.check.diagnostics, []);
  return result.ir;
}

function diagnostics(program: string) {
  return checkCutModule(parsed(program)).diagnostics;
}

function bus(ir: CutAVIR, name: string) {
  const result = Object.values(ir.nodes).find((node) => node.op === "cut.audio.bus" && node.inputs.name?.kind === "string" && node.inputs.name.value === name);
  assert.ok(result, `missing Bus ${name}`);
  return result;
}

function node(ir: CutAVIR, op: string, index = 0) {
  const result = Object.values(ir.nodes).filter((candidate) => candidate.op === op)[index];
  assert.ok(result, `missing ${op}[${index}]`);
  return result;
}

type Pcm24 = { frames: number; sample(frame: number, channel: number): number };

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
  assert.deepEqual({ channels, sampleRate, blockAlign, bits }, { channels: 2, sampleRate: 48_000, blockAlign: 6, bits: 24 });
  return {
    frames: data.length / blockAlign,
    sample(frame: number, channel: number) {
      const position = frame * blockAlign + channel * 3;
      let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

function routedProgram(dialogueAmount = "-18db") {
  return source(`
    Bus(name: "dialogue", role: "dialogue") as dialogue {
      Tone(frequency: 1000hz, duration: 200ms, amplitude: 10%);
    }
    let dialogueRoom = Send(amount: ${dialogueAmount}, source: dialogue);
    Bus(name: "music", role: "music", kind: "program") as music {
      at 50ms { Tone(frequency: 500hz, duration: 100ms, amplitude: 5%); }
    }
    let musicRoom = Send(amount: -24db, source: music);
    Bus(name: "room", role: "ambience", kind: "aux") {
      Reverb(wet: 100%) { Return(sends: [dialogueRoom, musicRoom]); }
    }
  `);
}

test("Bus.kind is a closed public input with a compatible program default and hostile-IR runtime checks", () => {
  const ir = compile(source(`
    Bus(name: "default") { Tone(frequency: 400hz, duration: 200ms); }
    Bus(name: "explicit", kind: "program") { Tone(frequency: 500hz, duration: 200ms); }
    Bus(name: "auxiliary", kind: "aux") { Tone(frequency: 600hz, duration: 200ms); }
  `));
  assert.deepEqual(referenceAudioNodeConfig(ir, ir.compositions[0], bus(ir, "default")), { kind: "bus", busKind: "program", name: "default" });
  assert.deepEqual(referenceAudioNodeConfig(ir, ir.compositions[0], bus(ir, "explicit")), { kind: "bus", busKind: "program", name: "explicit" });
  assert.deepEqual(referenceAudioNodeConfig(ir, ir.compositions[0], bus(ir, "auxiliary")), { kind: "bus", busKind: "aux", name: "auxiliary" });
  const schema = referenceKernelSchema("cut.audio.bus");
  assert.ok(schema?.support === "supported");
  if (schema?.support === "supported") {
    assert.deepEqual(schema.inputs, ["name", "role", "kind"]);
    assert.deepEqual(schema.stringInputs.kind, ["program", "aux"]);
  }

  const enumFailure = diagnostics(source('Bus(name: "mix", kind: "folder") { Tone(frequency: 1khz, duration: 200ms); }')).find((item) => item.code === "CUT2068");
  assert.ok(enumFailure);
  assert.match(enumFailure.message, /program, aux/u);
  assert.ok(enumFailure.span.start.line > 0 && enumFailure.span.start.column > 0);
  const typeFailure = diagnostics(source('Bus(name: "mix", kind: 1) { Tone(frequency: 1khz, duration: 200ms); }')).find((item) => item.code === "CUT2029");
  assert.ok(typeFailure);
  assert.match(typeFailure.message, /expects String, found Number/u);
  const rootTapFailure = diagnostics(source('Bus(name: "mix") as mix { Tone(frequency: 1khz, duration: 200ms); } Send(amount: -12db, source: mix);')).find((item) => item.code === "CUT_AUDIO_SEND_SHAPE");
  assert.ok(rootTapFailure);
  assert.match(rootTapFailure.message, /must be introduced with let/u);
  const detachedChildFailure = diagnostics(source('let invalid = Send(amount: -12db);')).find((item) => item.code === "CUT_AUDIO_SEND_SHAPE");
  assert.ok(detachedChildFailure);
  assert.match(detachedChildFailure.message, /requires source: AudioNode/u);

  for (const bad of [
    { kind: "string", value: "folder" } as IRValue,
    { kind: "boolean", value: true } as IRValue,
  ]) {
    const hostile = compile(source('Bus(name: "mix", kind: "program") { Tone(frequency: 1khz, duration: 200ms); }'));
    const hostileBus = bus(hostile, "mix");
    hostileBus.inputs.kind = bad;
    finalizeGraphHashes(hostile);
    const loaded = loadCutAvIr(JSON.stringify(hostile));
    const expected = bad.kind === "string" ? "CUT_AUDIO_ENUM" : "CUT_AUDIO_INPUT_TYPE";
    for (const work of [
      () => validateReferenceSession(loaded),
      () => planReferenceAudioStems(loaded, loaded.compositions[0]),
    ]) {
      assert.throws(work, (error: unknown) => {
        assert.ok(error instanceof ReferenceAudioConfigError);
        assert.equal(error.code, expected);
        assert.ok("module" in error.source && error.source.module === "project.cut");
        assert.ok("line" in error.source && error.source.line > 0 && error.source.column > 0);
        return true;
      });
    }
  }
});

test("explicit program kind preserves legacy master PCM", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aux-program-compat-"));
  try {
    const legacy = compile(source('Bus(name: "mix") { Tone(frequency: 1khz, duration: 200ms, amplitude: 10%); }'));
    const explicit = compile(source('Bus(name: "mix", kind: "program") { Tone(frequency: 1khz, duration: 200ms, amplitude: 10%); }'));
    const legacyPath = resolve(root, "legacy.wav"), explicitPath = resolve(root, "explicit.wav");
    await renderReferenceAudio(legacy, legacy.compositions[0], root, legacyPath);
    await renderReferenceAudio(explicit, explicit.compositions[0], root, explicitPath);
    assert.deepEqual(await readFile(explicitPath), await readFile(legacyPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("program and aux stems are explicit, additive, decoded, and dependency-sensitive", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aux-stem-decode-"));
  try {
    const quiet = compile(routedProgram()), composition = quiet.compositions[0], plan = planReferenceAudioStems(quiet, composition);
    assert.deepEqual(referenceAudioNodeConfig(quiet, composition, node(quiet, "cut.audio.send", 0)), {
      kind: "send",
      amountDb: -18,
      tap: "post",
      sourceNodeId: bus(quiet, "dialogue").id,
    });
    assert.equal(plan.version, 3);
    assert.deepEqual(plan.routes.map(({ name, kind, auxiliaryInputs }) => ({ name, kind, auxiliaryInputs })), [
      { name: "dialogue", kind: "program", auxiliaryInputs: [] },
      { name: "music", kind: "program", auxiliaryInputs: [] },
      {
        name: "room",
        kind: "aux",
        auxiliaryInputs: [
          { returnNodeId: node(quiet, "cut.audio.return").id, sendNodeId: node(quiet, "cut.audio.send", 0).id, sourceStem: "dialogue" },
          { returnNodeId: node(quiet, "cut.audio.return").id, sendNodeId: node(quiet, "cut.audio.send", 1).id, sourceStem: "music" },
        ],
      },
    ]);
    assert.equal(plan.routes[2].graphHash, bus(quiet, "room").contentHash, "aux graph identity must transitively include Return node references");

    const masterPath = resolve(root, "master.wav");
    await renderReferenceAudio(quiet, composition, root, masterPath);
    const rendered = await renderReferenceAudioStems(quiet, composition, root, resolve(root, "quiet-stems"));
    assert.equal(rendered.manifest.version, 5);
    assert.deepEqual(rendered.manifest.stems.map(({ name, role, kind }) => ({ name, role, kind })), [
      { name: "dialogue", role: "dialogue", kind: "program" },
      { name: "music", role: "music", kind: "program" },
      { name: "room", role: "ambience", kind: "aux" },
    ]);

    const master = pcm24(await readFile(masterPath));
    const stems = await Promise.all(rendered.manifest.stems.map(async (entry) => pcm24(await readFile(resolve(rendered.directory, entry.file)))));
    assert.ok(stems.every((stem) => stem.frames === master.frames));
    let maximumSumError = 0, auxPeak = 0;
    for (let frame = 0; frame < master.frames; frame += 1) for (const channel of [0, 1]) {
      maximumSumError = Math.max(maximumSumError, Math.abs(master.sample(frame, channel) - stems.reduce((sum, stem) => sum + stem.sample(frame, channel), 0)));
      auxPeak = Math.max(auxPeak, Math.abs(stems[2].sample(frame, channel)));
    }
    assert.ok(maximumSumError <= 5 / 0x800000, `decoded master/stem sum error ${maximumSumError}`);
    assert.ok(auxPeak > 0.0001, `shared aux stem must contain rendered Return audio, peak=${auxPeak}`);

    const louder = compile(routedProgram("-6db")), louderPlan = planReferenceAudioStems(louder, louder.compositions[0]);
    const louderMaster = resolve(root, "louder-master.wav");
    await renderReferenceAudio(louder, louder.compositions[0], root, louderMaster);
    const louderStems = await renderReferenceAudioStems(louder, louder.compositions[0], root, resolve(root, "louder-stems"));
    assert.deepEqual(
      await readFile(resolve(rendered.directory, "dialogue.wav")),
      await readFile(resolve(louderStems.directory, "dialogue.wav")),
      "Send.amount must not alter the program stem's unity dry path",
    );
    assert.notDeepEqual(await readFile(resolve(rendered.directory, "room.wav")), await readFile(resolve(louderStems.directory, "room.wav")));
    assert.notDeepEqual(await readFile(masterPath), await readFile(louderMaster));
    assert.notEqual(plan.routes[2].graphHash, louderPlan.routes[2].graphHash, "aux identity must include the referenced Send amount");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached Send amount automation executes in the sample domain without changing its dry program stem", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aux-send-automation-"));
  const program = (automation: string) => source(`
    Bus(name: "dialogue", role: "dialogue") as dialogue {
      Tone(frequency: 1000hz, duration: 200ms, amplitude: 20%);
    }
    let roomSend = Send(amount: -60db, source: dialogue);
    Bus(name: "room", role: "ambience", kind: "aux") { Return(sends: [roomSend]); }
    ${automation}
  `);
  try {
    const animated = compile(program("animate roomSend.amount from -60db to 0db over 160ms;"));
    const animatedSend = node(animated, "cut.audio.send");
    const compiledAutomation = compileReferenceAudioAutomation(animated, animated.compositions[0], animatedSend);
    assert.ok(compiledAutomation);
    assert.equal(compiledAutomation.property, "amount");
    assert.equal(compiledAutomation.eventCount, 1);
    assert.deepEqual(compiledAutomation.controlValues, [-60, -60, 0]);

    const steady = compile(program(""));
    const animatedStems = await renderReferenceAudioStems(animated, animated.compositions[0], root, resolve(root, "animated"));
    const steadyStems = await renderReferenceAudioStems(steady, steady.compositions[0], root, resolve(root, "steady"));
    assert.deepEqual(
      await readFile(resolve(animatedStems.directory, "dialogue.wav")),
      await readFile(resolve(steadyStems.directory, "dialogue.wav")),
      "post-fader send automation must not alter the unity dry program route",
    );
    assert.notDeepEqual(await readFile(resolve(animatedStems.directory, "room.wav")), await readFile(resolve(steadyStems.directory, "room.wav")));

    const dry = pcm24(await readFile(resolve(animatedStems.directory, "dialogue.wav")));
    const wet = pcm24(await readFile(resolve(animatedStems.directory, "room.wav")));
    const rampEndSample = 7_680;
    for (const frame of [12, 2_412, 4_812, 7_692, 9_132]) {
      const amountDb = frame < rampEndSample ? -60 + 60 * frame / rampEndSample : 0;
      const expected = dry.sample(frame, 0) * 10 ** (amountDb / 20);
      const actual = wet.sample(frame, 0);
      assert.ok(Math.abs(actual - expected) <= 8 / 0x800000, `frame ${frame}: expected ${expected}, received ${actual}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-fader program-Bus Send preserves the delivered dry stem and changes only aux identity and PCM", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aux-pre-fader-"));
  const program = (tap: "post" | "pre-fader") => source(`
    Bus(name: "dialogue", role: "dialogue") as dialogue {
      Gain(amount: -18db) { Tone(frequency: 1000hz, duration: 200ms, amplitude: 10%); }
    }
    let roomSend = Send(amount: 0db, source: dialogue${tap === "pre-fader" ? ', tap: "pre-fader"' : ""});
    Bus(name: "room", role: "ambience", kind: "aux") { Return(sends: [roomSend]); }
  `);
  try {
    const post = compile(program("post")), pre = compile(program("pre-fader"));
    const postRendered = await renderReferenceAudioStems(post, post.compositions[0], root, resolve(root, "post"));
    const preRendered = await renderReferenceAudioStems(pre, pre.compositions[0], root, resolve(root, "pre"));
    assert.deepEqual(
      await readFile(resolve(postRendered.directory, "dialogue.wav")),
      await readFile(resolve(preRendered.directory, "dialogue.wav")),
      "tap position must not mutate the dry program stem",
    );
    const postRoom = pcm24(await readFile(resolve(postRendered.directory, "room.wav")));
    const preRoom = pcm24(await readFile(resolve(preRendered.directory, "room.wav")));
    const inverseFader = 1 / 10 ** (-18 / 20);
    for (const frame of [12, 36, 60, 1_212, 4_812, 8_412]) {
      assert.ok(Math.abs(preRoom.sample(frame, 0) - postRoom.sample(frame, 0) * inverseFader) <= 5 / 0x800000, `frame ${frame}`);
    }
    const postPlan = planReferenceAudioStems(post, post.compositions[0]);
    const prePlan = planReferenceAudioStems(pre, pre.compositions[0]);
    assert.notEqual(postPlan.routes.find((route) => route.name === "room")?.graphHash, prePlan.routes.find((route) => route.name === "room")?.graphHash);
    const preSend = node(pre, "cut.audio.send");
    assert.equal(planReferenceAudioRouting(pre, pre.compositions[0]).sends.get(preSend.id)?.preFaderNodeId, node(pre, "cut.audio.gain").id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loaded IR cannot turn a detached Send tap into an untyped or source-less no-op", () => {
  const wrongType = compile(routedProgram()), wrongTypeSend = node(wrongType, "cut.audio.send", 0);
  wrongTypeSend.inputs.source = { kind: "string", value: "dialogue" };
  finalizeGraphHashes(wrongType);
  const loadedWrongType = loadCutAvIr(JSON.stringify(wrongType));
  assert.throws(() => validateReferenceSession(loadedWrongType), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioConfigError);
    assert.equal(error.code, "CUT_AUDIO_INPUT_TYPE");
    assert.equal(error.source.nodeId, wrongTypeSend.id);
    return true;
  });

  const missing = compile(routedProgram()), missingSend = node(missing, "cut.audio.send", 0);
  delete missingSend.inputs.source;
  finalizeGraphHashes(missing);
  const loadedMissing = loadCutAvIr(JSON.stringify(missing));
  assert.throws(() => validateReferenceSession(loadedMissing), (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioConfigError);
    assert.equal(error.code, "CUT_AUDIO_GRAPH");
    assert.equal(error.source.nodeId, missingSend.id);
    return true;
  });
});

test("aux topology fails closed for direct sources, wrong direction, nesting, aux chains, and orphan Sends", () => {
  const stemFailure = (program: string, code: ReferenceStemError["code"], message: RegExp) => {
    const ir = compile(program);
    assert.throws(() => planReferenceAudioStems(ir, ir.compositions[0]), (error: unknown) => {
      assert.ok(error instanceof ReferenceStemError);
      assert.equal(error.code, code);
      assert.match(error.message, message);
      assert.equal(error.source?.module, "project.cut");
      assert.ok((error.source?.line ?? 0) > 0 && (error.source?.column ?? 0) > 0 && error.source?.nodeId);
      const diagnostic = cutDiagnosticsFromError(error)[0];
      assert.equal(diagnostic.code, code);
      assert.deepEqual(diagnostic.source, error.source);
      return true;
    });
  };

  stemFailure(
    source('Bus(name: "room", kind: "aux") { Tone(frequency: 1khz, duration: 200ms); }'),
    "CUT_STEM_AUX_DIRECT_SOURCE",
    /author the source in a program Bus/u,
  );
  stemFailure(
    source(`
      Bus(name: "one") as one { Tone(frequency: 1khz, duration: 200ms); }
      let shared = Send(amount: -12db, source: one);
      Bus(name: "two") { Return(sends: [shared]); }
    `),
    "CUT_STEM_AUX_DIRECTION",
    /only an aux stem may receive/u,
  );
  stemFailure(
    source(`
      Bus(name: "program") {
        Bus(name: "nested", kind: "aux") { Tone(frequency: 1khz, duration: 200ms); }
      }
    `),
    "CUT_STEM_AUX_DIRECTION",
    /must be top-level/u,
  );
  stemFailure(
    source(`
      Bus(name: "program") as programBus { Tone(frequency: 1khz, duration: 200ms); }
      let base = Send(amount: -12db, source: programBus);
      Bus(name: "first", kind: "aux") as firstAux { Return(sends: [base]); }
      let cascade = Send(amount: -6db, source: firstAux);
      Bus(name: "second", kind: "aux") { Return(sends: [cascade]); }
    `),
    "CUT_STEM_AUX_DIRECTION",
    /aux-to-aux routing is unsupported/u,
  );

  const orphanSource = source('Bus(name: "program") as programBus { Tone(frequency: 1khz, duration: 200ms); } let unused = Send(amount: -12db, source: programBus);');
  assert.throws(() => compileCutModule(parsed(orphanSource)), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === "CUT_AUDIO_ROUTING_DANGLING");
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /detached routing nodes would ignore/u);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    return true;
  });
});

test("a clipping aux route publishes no partial replacement stem set", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-aux-stem-atomic-"));
  try {
    const program = (gain: string) => source(`
      Bus(name: "program") as programBus { Tone(frequency: 1khz, duration: 200ms, amplitude: 60%); }
      let parallelSend = Send(amount: 0db, source: programBus);
      Bus(name: "parallel", kind: "aux") { Gain(amount: ${gain}) { Return(sends: [parallelSend]); } }
    `);
    const safe = compile(program("-12db")), destination = resolve(root, "stems");
    await renderReferenceAudioStems(safe, safe.compositions[0], root, destination);
    const before = new Map(await Promise.all((await readdir(destination)).map(async (file) => [file, await readFile(resolve(destination, file))] as const)));

    const clipped = compile(program("12db"));
    await assert.rejects(renderReferenceAudioStems(clipped, clipped.compositions[0], root, destination), (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioPeakError);
      assert.equal(error.code, "CUT_AUDIO_CLIPPING");
      return true;
    });
    assert.deepEqual((await readdir(destination)).sort(), [...before.keys()].sort());
    for (const [file, bytes] of before) assert.deepEqual(await readFile(resolve(destination, file)), bytes, `${file} must survive aux refusal byte-identically`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
