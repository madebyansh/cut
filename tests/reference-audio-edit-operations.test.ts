import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { AudioEditOperationError, executeAudioEditOperationPlan, validateAudioEditOperationPlan } from "../lib/language/audio-edit-operations";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { referenceMasterAudioRootIds, renderReferenceAudio } from "../lib/runtime/reference/audio";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity } from "../lib/runtime/reference/audio-cache";
import { validateReferenceAudioTrackOperationPlan } from "../lib/runtime/reference/audio-edit-operations";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) { return compileCutModule(moduleFor(source)).ir; }

const operationImports = [
  "AudioTrack", "AudioGap", "editAudio", "editSilence", "audioSplit", "audioTrim", "audioRippleInsert",
  "audioRippleDelete", "audioOverwrite", "audioReplace", "audioLift", "audioExtract", "audioSlip", "audioSlide",
].join(", ");

function operationProgram(edit: string, finalDuration = "3s", base = `
      AudioClip(source: a, range: 0s ..< 1s, destination: 0s ..< 1s);
      AudioClip(source: b, range: 0s ..< 1s, destination: 1s ..< 2s);
      AudioGap(destination: 2s ..< 3s);`, sourceDuration = "3s") {
  return `cut 0.4;
project "audio operation";
import { ${operationImports} } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset a: AudioAsset = audio("media/a.wav");
asset b: AudioAsset = audio("media/b.wav");
asset c: AudioAsset = audio("media/c.wav");
timeline main(duration: ${finalDuration}, fps: 24, sampleRate: 48khz) {
  AudioTrack(sourceDuration: ${sourceDuration}, edits: [
    ${edit}
  ]) {${base}
  }
}
export out = render(main);`;
}

type AudioTrackNode = IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> };

function track(ir: CutAVIR): AudioTrackNode {
  const result = Object.values(ir.nodes).find((node) => node.op === "cut.edit.audio_track");
  assert.ok(result?.editorial?.kind === "audio-track");
  return result as AudioTrackNode;
}

function number(value: { numerator: string; denominator: string }) { return Number(value.numerator) / Number(value.denominator); }

function summary(ir: CutAVIR) {
  return track(ir).editorial.items.map((item) => {
    const sourceInput = ir.nodes[item.nodeId]?.inputs.source;
    return {
      kind: item.kind,
      destination: [number(item.destination.start), number(item.destination.duration)],
      source: item.source ? [number(item.source.start), number(item.source.duration)] : undefined,
      resource: item.kind === "audio" && sourceInput?.kind === "resource-ref" ? sourceInput.id : undefined,
    };
  });
}

function fakeLock(ir: CutAVIR, sampleRate = 48_000, duration = rational(10)) {
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [{ index: 0, type: "audio", sampleRate }] },
        selected: { audio: { streamIndex: 0, duration, durationSource: "stream", timeBase: rational(1, sampleRate) } },
      },
    } as never;
  }
  ir.determinism.semantic = "locked";
  return ir;
}

test("public AudioTrack syntax materializes all ten exact structural operations into ordinary audio kernels", () => {
  const cases: Array<{ edit: string; final: string; expected: ReturnType<typeof summary> }> = [
    {
      edit: "audioSplit(at: 500ms)", final: "3s",
      expected: [
        { kind: "audio", destination: [0, .5], source: [0, .5], resource: "a" },
        { kind: "audio", destination: [.5, .5], source: [.5, .5], resource: "a" },
        { kind: "audio", destination: [1, 1], source: [0, 1], resource: "b" },
        { kind: "gap", destination: [2, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioTrim(keep: 250ms ..< 750ms)", final: "3s",
      expected: [
        { kind: "gap", destination: [0, .25], source: undefined, resource: undefined },
        { kind: "audio", destination: [.25, .5], source: [.25, .5], resource: "a" },
        { kind: "gap", destination: [.75, .25], source: undefined, resource: undefined },
        { kind: "audio", destination: [1, 1], source: [0, 1], resource: "b" },
        { kind: "gap", destination: [2, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioRippleInsert(at: 1s, item: editAudio(source: c, range: 0s ..< 500ms))", final: "3500ms",
      expected: [
        { kind: "audio", destination: [0, 1], source: [0, 1], resource: "a" },
        { kind: "audio", destination: [1, .5], source: [0, .5], resource: "c" },
        { kind: "audio", destination: [1.5, 1], source: [0, 1], resource: "b" },
        { kind: "gap", destination: [2.5, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioRippleDelete(range: 500ms ..< 1500ms)", final: "2s",
      expected: [
        { kind: "audio", destination: [0, .5], source: [0, .5], resource: "a" },
        { kind: "audio", destination: [.5, .5], source: [.5, .5], resource: "b" },
        { kind: "gap", destination: [1, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioOverwrite(range: 500ms ..< 1500ms, item: editAudio(source: c, range: 0s ..< 1s))", final: "3s",
      expected: [
        { kind: "audio", destination: [0, .5], source: [0, .5], resource: "a" },
        { kind: "audio", destination: [.5, 1], source: [0, 1], resource: "c" },
        { kind: "audio", destination: [1.5, .5], source: [.5, .5], resource: "b" },
        { kind: "gap", destination: [2, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioReplace(range: 1s ..< 2s, item: editAudio(source: c, range: 0s ..< 500ms))", final: "2500ms",
      expected: [
        { kind: "audio", destination: [0, 1], source: [0, 1], resource: "a" },
        { kind: "audio", destination: [1, .5], source: [0, .5], resource: "c" },
        { kind: "gap", destination: [1.5, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioLift(range: 500ms ..< 1500ms)", final: "3s",
      expected: [
        { kind: "audio", destination: [0, .5], source: [0, .5], resource: "a" },
        { kind: "gap", destination: [.5, 1], source: undefined, resource: undefined },
        { kind: "audio", destination: [1.5, .5], source: [.5, .5], resource: "b" },
        { kind: "gap", destination: [2, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioExtract(range: 500ms ..< 1500ms)", final: "2s",
      expected: [
        { kind: "audio", destination: [0, .5], source: [0, .5], resource: "a" },
        { kind: "audio", destination: [.5, .5], source: [.5, .5], resource: "b" },
        { kind: "gap", destination: [1, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioRippleInsert(at: 1s, item: editSilence(duration: 500ms))", final: "3500ms",
      expected: [
        { kind: "audio", destination: [0, 1], source: [0, 1], resource: "a" },
        { kind: "gap", destination: [1, .5], source: undefined, resource: undefined },
        { kind: "audio", destination: [1.5, 1], source: [0, 1], resource: "b" },
        { kind: "gap", destination: [2.5, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioSlip(range: 0s ..< 1s, by: 500ms)", final: "3s",
      expected: [
        { kind: "audio", destination: [0, 1], source: [.5, 1], resource: "a" },
        { kind: "audio", destination: [1, 1], source: [0, 1], resource: "b" },
        { kind: "gap", destination: [2, 1], source: undefined, resource: undefined },
      ],
    },
    {
      edit: "audioSlide(range: 1s ..< 2s, by: 500ms)", final: "3s",
      expected: [
        { kind: "audio", destination: [0, 1.5], source: [0, 1.5], resource: "a" },
        { kind: "audio", destination: [1.5, 1], source: [0, 1], resource: "b" },
        { kind: "gap", destination: [2.5, .5], source: undefined, resource: undefined },
      ],
    },
  ];

  for (const item of cases) {
    const ir = compile(operationProgram(item.edit, item.final));
    assert.deepEqual(summary(ir), item.expected, item.edit);
    const audioTrack = track(ir);
    assert.equal(audioTrack.inputs.sourceDuration, undefined);
    assert.equal(audioTrack.inputs.edits, undefined);
    assert.equal(audioTrack.editorial.operationPlan?.version, 1);
    assert.deepEqual(audioTrack.children, audioTrack.editorial.items.map((entry) => entry.nodeId));
    assert.ok(audioTrack.editorial.items.every((entry) => ir.nodes[entry.nodeId]?.op === (entry.kind === "audio" ? "cut.audio.clip" : "cut.edit.audio_gap")));
    assert.ok(Object.values(ir.nodes).every((node) => Object.values(node.inputs).every((value) => value.kind !== "call" || !value.op.startsWith("cut.edit.audio_"))));
    assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
    assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(ir))));
  }
});

test("AudioTrack edit diagnostics are stable, located, typed, bounded, and refuse unsupported linked or processed bases", () => {
  const hasCode = (expected: string, line?: number) => (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === expected);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    if (line !== undefined) assert.equal(diagnostic.span.start.line, line);
    return true;
  };
  assert.throws(() => compile(operationProgram("audioSplit(at: 1s)")), hasCode("CUT_AUDIO_EDIT_NOOP", 10));
  assert.throws(() => compile(operationProgram("audioSplit(at: 0.01ms)")), hasCode("CUT_AUDIO_EDIT_TIME", 10));
  assert.throws(() => compile(operationProgram("audioOverwrite(range: 0s ..< 1s, item: editSilence(duration: 500ms))")), hasCode("CUT_AUDIO_EDIT_TIME", 10));
  assert.throws(() => compile(operationProgram("audioSlip(range: 0s ..< 1s, by: 0s)")), hasCode("CUT_AUDIO_EDIT_NOOP", 10));
  assert.throws(() => compile(operationProgram("audioSlide(range: 0s ..< 1s, by: 250ms)")), hasCode("CUT_AUDIO_EDIT_UNSUPPORTED", 10));

  const missingPair = operationProgram("audioSplit(at: 500ms)").replace("sourceDuration: 3s, ", "");
  assert.throws(() => compile(missingPair), hasCode("CUT_AUDIO_EDIT_SHAPE"));
  const linked = operationProgram("audioSplit(at: 500ms)", "3s", `
      AudioClip(source: a, range: 0s ..< 1s, destination: 0s ..< 1s, link: "take");
      AudioClip(source: b, range: 0s ..< 1s, destination: 1s ..< 2s);
      AudioGap(destination: 2s ..< 3s);`);
  assert.throws(() => compile(linked), hasCode("CUT_AUDIO_EDIT_UNSUPPORTED"));
  const faded = operationProgram("audioSplit(at: 500ms)", "3s", `
      AudioClip(source: a, range: 0s ..< 1s, destination: 0s ..< 1s, fadeIn: 10ms);
      AudioClip(source: b, range: 0s ..< 1s, destination: 1s ..< 2s);
      AudioGap(destination: 2s ..< 3s);`);
  const fadedBaseLine = faded.slice(0, faded.indexOf("AudioClip(source: a")).split("\n").length;
  assert.throws(() => compile(faded), hasCode("CUT_AUDIO_EDIT_UNSUPPORTED", fadedBaseLine));

  const wrongItem = operationProgram("audioRippleInsert(at: 1s, item: 1s)");
  assert.ok(checkCutModule(moduleFor(wrongItem)).diagnostics.some((item) => item.code === "CUT2029" && /AudioEditItem/.test(item.message)));
  const unknownArgument = operationProgram("audioSlip(range: 0s ..< 1s, by: 250ms, handles: 1s)");
  assert.ok(checkCutModule(moduleFor(unknownArgument)).diagnostics.some((item) => item.code === "CUT2027" && /handles/.test(item.message)));
  const pictureVocabulary = operationProgram("split(at: 500ms)").replace("AudioTrack, ", "AudioTrack, split, ");
  assert.ok(checkCutModule(moduleFor(pictureVocabulary)).diagnostics.some((item) => item.code === "CUT2029" && /AudioEdit/.test(item.message)));
});

test("closed operation plans replay before runtime work and reject loader, sample-grid, source-bound, child, and materialization tampering", () => {
  const source = operationProgram("audioRippleDelete(range: 500ms ..< 1500ms)", "2s");
  const unknown = JSON.parse(JSON.stringify(compile(source))) as CutAVIR;
  const unknownTrack = track(unknown);
  assert.ok(unknownTrack.editorial.operationPlan);
  (unknownTrack.editorial.operationPlan.operations[0] as unknown as Record<string, unknown>).ignored = true;
  assert.throws(() => validateCutAvIr(unknown), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD" && error.path.endsWith(".ignored"));

  const badBase = fakeLock(compile(source)), badBaseTrack = track(badBase), badBasePlan = badBaseTrack.editorial.operationPlan;
  assert.ok(badBasePlan);
  const baseSourceLine = badBasePlan.baseItems[0].provenance.span.start.line;
  badBasePlan.baseItems[0].destination.start = rational(1, 4);
  assert.throws(() => validateReferenceAudioTrackOperationPlan(badBase, badBase.compositions[0], badBaseTrack), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_AUDIO_EDIT_SHAPE");
    assert.equal(diagnostic.source?.line, baseSourceLine, "base-plan failures must point to the base AudioClip, not the first edit call");
    return true;
  });

  const offGrid = fakeLock(compile(source)), offGridTrack = track(offGrid);
  assert.ok(offGridTrack.editorial.operationPlan?.operations[0]?.kind === "ripple-delete");
  offGridTrack.editorial.operationPlan.operations[0].range.start = rational(1, 44_100);
  assert.throws(() => validateReferenceAudioTrackOperationPlan(offGrid, offGrid.compositions[0], offGridTrack), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_AUDIO_EDIT_TIME");
    assert.equal(diagnostic.source?.line, 10);
    assert.match(diagnostic.message, /destination sample grid/);
    return true;
  });

  const materialized = fakeLock(compile(source)), materializedTrack = track(materialized);
  materializedTrack.editorial.items[0].destination.duration = rational(1, 4);
  assert.throws(() => validateReferenceAudioTrackOperationPlan(materialized, materialized.compositions[0], materializedTrack), /CUT_AUDIO_EDIT_RESULT: materialized item 0 timing metadata/);

  const childInput = fakeLock(compile(source)), childTrack = track(childInput), child = childInput.nodes[childTrack.children[0]];
  child.inputs.destination = { kind: "range", start: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(0) }, end: { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(1, 4) }, exclusive: true };
  assert.throws(() => validateReferenceAudioTrackOperationPlan(childInput, childInput.compositions[0], childTrack), /CUT_AUDIO_EDIT_RESULT: materialized item 0 kernel inputs/);

  const sourceBound = fakeLock(compile(operationProgram("audioSplit(at: 500ms)")), 48_000, rational(3, 4));
  const sourceBoundTrack = track(sourceBound);
  assert.throws(() => validateReferenceAudioTrackOperationPlan(sourceBound, sourceBound.compositions[0], sourceBoundTrack), /CUT_AUDIO_EDIT_TIME: base:0 source range exceeds/);

  const crossGridProgram = operationProgram(
    "audioSplit(at: 0.5ms)",
    "1ms",
    "AudioClip(source: a, range: 0ms ..< 1ms, destination: 0ms ..< 1ms);",
    "1ms",
  );
  const crossGrid = fakeLock(compile(crossGridProgram), 44_100, rational(1));
  const crossGridTrack = track(crossGrid);
  assert.throws(() => validateReferenceAudioTrackOperationPlan(crossGrid, crossGrid.compositions[0], crossGridTrack), /CUT_AUDIO_EDIT_TIME: base:0 source end does not land on the locked 44100 Hz source sample grid/);

  for (const leakedInput of ["sourceDuration", "edits"] as const) {
    const leaked = fakeLock(compile(source)), leakedTrack = track(leaked);
    delete leakedTrack.editorial.operationPlan;
    leakedTrack.inputs[leakedInput] = leakedInput === "sourceDuration"
      ? { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(2) }
      : { kind: "array", items: [] };
    assert.throws(() => validateReferenceAudioTrackOperationPlan(leaked, leaked.compositions[0], leakedTrack), /CUT_AUDIO_EDIT_SHAPE: compile-time edit operands must not leak/);
  }
});

test("formatting and two different valid edit histories share semantic and audio-cache identity only when materialized sound matches", () => {
  const base = "AudioClip(source: a, range: 0s ..< 1s, destination: 0s ..< 1s);";
  const splitSource = operationProgram("audioSplit(at: 500ms)", "1s", base, "1s");
  const rebuiltSource = operationProgram(`
    audioTrim(keep: 500ms ..< 1s),
    audioOverwrite(range: 0s ..< 500ms, item: editAudio(source: a, range: 0s ..< 500ms))`, "1s", base, "1s");
  const formattedSource = splitSource.replace("audioSplit", "// exact edit\n    audioSplit").replaceAll(";", ";\n");
  const split = compile(splitSource), rebuilt = compile(rebuiltSource), formatted = compile(formattedSource);
  assert.notEqual(split.sourceHash, rebuilt.sourceHash);
  assert.notEqual(split.sourceHash, formatted.sourceHash);
  assert.deepEqual(summary(split), summary(rebuilt));
  assert.deepEqual(track(split).children, track(rebuilt).children);
  assert.equal(split.buildId, rebuilt.buildId, "validated edit history is evidence, not an extra executable dependency after identical materialization");
  assert.equal(split.buildId, formatted.buildId);
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(split))));
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(rebuilt))));

  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-audio-edit-cache-test");
  const lockedSplit = fakeLock(structuredClone(split)), lockedRebuilt = fakeLock(structuredClone(rebuilt));
  const splitPlan = createReferenceAudioCachePlan(lockedSplit, lockedSplit.compositions[0], referenceMasterAudioRootIds(lockedSplit, lockedSplit.compositions[0]), toolchain);
  const rebuiltPlan = createReferenceAudioCachePlan(lockedRebuilt, lockedRebuilt.compositions[0], referenceMasterAudioRootIds(lockedRebuilt, lockedRebuilt.compositions[0]), toolchain);
  assert.equal(splitPlan.graph.sha256, rebuiltPlan.graph.sha256);
  assert.equal(splitPlan.key, rebuiltPlan.key);

  const slipped = compile(operationProgram("audioSlip(range: 0s ..< 1s, by: 250ms)", "1s", base, "1s"));
  assert.notDeepEqual(summary(split), summary(slipped));
  assert.notEqual(split.buildId, slipped.buildId);
  const lockedSlipped = fakeLock(slipped), slippedPlan = createReferenceAudioCachePlan(lockedSlipped, lockedSlipped.compositions[0], referenceMasterAudioRootIds(lockedSlipped, lockedSlipped.compositions[0]), toolchain);
  assert.notEqual(splitPlan.key, slippedPlan.key, "a changed materialized source window must invalidate audio work");
});

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2, buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function pcm24Data(buffer: Buffer) {
  let offset = 12, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.deepEqual({ sampleRate, blockAlign, bits }, { sampleRate: 48_000, blockAlign: 6, bits: 24 });
  const sample = (frame: number, channel = 0) => {
    const position = frame * blockAlign + channel * 3;
    let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000;
    return value / 0x800000;
  };
  return { frames: data.length / blockAlign, sample };
}

test("materialized AudioTrack edits decode exact PCM boundaries, source windows, inserted audio, and intentional silence", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-edit-render-"));
  await writeFile(resolve(root, "a.wav"), monoPcm16Wave(48_000, [
    ...Array.from({ length: 24_000 }, () => 4_000),
    ...Array.from({ length: 24_000 }, () => 8_000),
    ...Array.from({ length: 24_000 }, () => 16_000),
  ]));
  await writeFile(resolve(root, "c.wav"), monoPcm16Wave(48_000, Array.from({ length: 24_000 }, () => -12_000)));
  const source = `cut 0.4;
project "decoded audio operations";
import { AudioTrack, AudioGap, audioSplit, audioSlip, audioLift, audioOverwrite, editAudio } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset a: AudioAsset = audio("a.wav");
asset c: AudioAsset = audio("c.wav");
timeline main(duration: 3s, fps: 24, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 3s, edits: [
    audioSplit(at: 500ms),
    audioSlip(range: 500ms ..< 1s, by: 500ms),
    audioLift(range: 1s ..< 1500ms),
    audioOverwrite(range: 1500ms ..< 2s, item: editAudio(source: c, range: 0s ..< 500ms))
  ]) {
    AudioClip(source: a, range: 0s ..< 1s, destination: 0s ..< 1s);
    AudioClip(source: a, range: 0s ..< 1s, destination: 1s ..< 2s);
    AudioGap(destination: 2s ..< 3s);
  }
}
export out = render(main);`;
  const ir = compile(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), output = resolve(root, "edited.wav");
  await renderReferenceAudio(ir, composition, root, output);
  const pcm = pcm24Data(await readFile(output)), gain = Math.SQRT1_2 / 32_768;
  assert.equal(pcm.frames, 144_000);
  const near = (frame: number, value: number) => assert.ok(Math.abs(pcm.sample(frame) - value * gain) < .002, `sample ${frame}: ${pcm.sample(frame)} != ${value * gain}`);
  near(0, 4_000); near(23_999, 4_000);
  near(24_000, 16_000); near(47_999, 16_000);
  near(48_000, 0); near(71_999, 0);
  near(72_000, -12_000); near(95_999, -12_000);
  near(96_000, 0); near(143_999, 0);
});

test("a locked 44.1 kHz source maps exact native sample boundaries into a 48 kHz destination without drift", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-edit-cross-rate-"));
  await writeFile(resolve(root, "source.wav"), monoPcm16Wave(44_100, [
    ...Array.from({ length: 441 }, () => 12_000),
    ...Array.from({ length: 441 }, () => -12_000),
  ]));
  const source = `cut 0.4;
project "cross rate audio operations";
import { AudioTrack, audioSplit } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset source: AudioAsset = audio("source.wav");
timeline main(duration: 20ms, fps: 25, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 20ms, edits: [audioSplit(at: 10ms)]) {
    AudioClip(source: source, range: 0ms ..< 20ms, destination: 0ms ..< 20ms);
  }
}
export out = render(main);`;
  const ir = compile(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), output = resolve(root, "cross-rate.wav");
  await renderReferenceAudio(ir, composition, root, output);
  const pcm = pcm24Data(await readFile(output));
  assert.equal(pcm.frames, 960);
  assert.ok(pcm.sample(100) > .1, `expected positive first source half, got ${pcm.sample(100)}`);
  assert.ok(pcm.sample(800) < -.1, `expected negative second source half, got ${pcm.sample(800)}`);
});

test("audioSlip owns the locked source clock while audioSlide remains destination-clock constrained", () => {
  const source = `cut 0.4;
project "native source slip";
import { AudioTrack, audioSlip } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset source: AudioAsset = audio("source.wav");
timeline main(duration: 10ms, fps: 25, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 10ms, edits: [
    audioSlip(range: 0ms ..< 10ms, by: seconds(1 / 44100))
  ]) {
    AudioClip(source: source, range: 0ms ..< 10ms, destination: 0ms ..< 10ms);
  }
}
export out = render(main);`;
  const native = fakeLock(compile(source), 44_100, rational(1));
  assert.doesNotThrow(() => validateReferenceSession(native), "one exact native source sample must be a valid slip even though it is not a destination sample");
  const wrongClock = fakeLock(compile(source), 48_000, rational(1));
  assert.throws(() => validateReferenceAudioTrackOperationPlan(wrongClock, wrongClock.compositions[0], track(wrongClock)), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_AUDIO_EDIT_TIME");
    assert.equal(diagnostic.source?.line, 8, "the shifted source-window failure belongs to the audioSlip call");
    assert.match(diagnostic.message, /locked 48000 Hz source sample grid/);
    return true;
  });
  assert.throws(() => validateReferenceSession(wrongClock), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_AUDIO_EDIT_TIME");
    assert.equal(diagnostic.source?.line, 8);
    return true;
  });

  const slide = operationProgram("audioSlide(range: 1s ..< 2s, by: seconds(1 / 44100))");
  assert.throws(() => compile(slide), (error) => error instanceof CutCompileError && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT_AUDIO_EDIT_TIME" && /slide delta/.test(diagnostic.message)));
});

test("derived source-window failures point to the structural edit that created them", () => {
  const sourceFor = (edit: string, finalDuration: string) => `cut 0.4;
project "derived edit provenance";
import { AudioTrack, editSilence, audioSplit, audioTrim, audioRippleInsert, audioRippleDelete, audioOverwrite, audioLift, audioExtract } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset source: AudioAsset = audio("source.wav");
timeline main(duration: ${finalDuration}, fps: 25, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 10ms, edits: [
    ${edit}
  ]) {
    AudioClip(source: source, range: 0ms ..< 10ms, destination: 0ms ..< 10ms);
  }
}
export out = render(main);`;
  const cases = [
    ["audioSplit(at: 1ms)", "10ms"],
    ["audioTrim(keep: 1ms ..< 9ms)", "10ms"],
    ["audioRippleInsert(at: 1ms, item: editSilence(duration: 1ms))", "11ms"],
    ["audioRippleDelete(range: 1ms ..< 2ms)", "9ms"],
    ["audioOverwrite(range: 1ms ..< 2ms, item: editSilence(duration: 1ms))", "10ms"],
    ["audioLift(range: 1ms ..< 2ms)", "10ms"],
    ["audioExtract(range: 1ms ..< 2ms)", "9ms"],
  ] as const;

  for (const [edit, finalDuration] of cases) {
    const source = sourceFor(edit, finalDuration), operationLine = source.slice(0, source.indexOf(`    ${edit}`)).split("\n").length;
    const locked = fakeLock(compile(source), 44_100, rational(10, 1_000));
    for (const validate of [
      () => validateReferenceAudioTrackOperationPlan(locked, locked.compositions[0], track(locked)),
      () => validateReferenceSession(locked),
    ]) {
      assert.throws(validate, (error) => {
        const diagnostic = cutDiagnosticsFromError(error)[0];
        assert.equal(diagnostic.code, "CUT_AUDIO_EDIT_TIME", edit);
        assert.equal(diagnostic.source?.line, operationLine, `${edit} must own its derived native-source boundary`);
        assert.match(diagnostic.message, /locked 44100 Hz source sample grid/);
        return true;
      });
    }
  }

  const slideSource = operationProgram("audioSlide(range: 1s ..< 2s, by: 500ms)");
  const slideLine = slideSource.slice(0, slideSource.indexOf("    audioSlide")).split("\n").length;
  const slide = fakeLock(compile(slideSource), 48_000, rational(5, 4));
  assert.throws(() => validateReferenceSession(slide), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_AUDIO_EDIT_TIME");
    assert.equal(diagnostic.source?.line, slideLine, "audioSlide must own the neighboring source extension it created");
    assert.match(diagnostic.message, /source range exceeds/);
    return true;
  });
});

test("locked source bounds are enforced after every edit, not only on the final materialization", () => {
  const source = operationProgram(`audioSlide(range: 1s ..< 2s, by: 500ms),
    audioRippleDelete(range: 1s ..< 1500ms)`, "2500ms");
  const slideLine = source.slice(0, source.indexOf("    audioSlide")).split("\n").length;
  const locked = fakeLock(compile(source), 48_000, rational(1));
  const plan = track(locked).editorial.operationPlan;
  assert.ok(plan);

  const steps: Array<{ index: number; firstSourceDuration?: number }> = [];
  const final = executeAudioEditOperationPlan(plan, undefined, (step) => {
    steps.push({
      index: step.operationIndex,
      firstSourceDuration: step.items[0].kind === "clip" ? number(step.items[0].source.duration) : undefined,
    });
  });
  assert.deepEqual(steps, [
    { index: 0, firstSourceDuration: 1.5 },
    { index: 1, firstSourceDuration: 1 },
  ]);
  assert.equal(number(final.items[0].kind === "clip" ? final.items[0].source.duration : rational(0)), 1, "the later delete hides the transient overrun in the final graph");

  for (const validate of [
    () => validateReferenceAudioTrackOperationPlan(locked, locked.compositions[0], track(locked)),
    () => validateReferenceSession(locked),
  ]) {
    assert.throws(validate, (error) => {
      const diagnostic = cutDiagnosticsFromError(error)[0];
      assert.equal(diagnostic.code, "CUT_AUDIO_EDIT_TIME");
      assert.equal(diagnostic.source?.line, slideLine);
      assert.match(diagnostic.message, /source range exceeds/);
      return true;
    });
  }
});

test("base and intermediate edit items cannot hide off-grid destination clocks", () => {
  const source = operationProgram(
    "audioRippleDelete(range: 0s ..< 1s)",
    "1s",
    `
      AudioClip(source: a, range: 0s ..< 500ms, destination: 0s ..< 500ms);
      AudioClip(source: b, range: 0s ..< 500ms, destination: 500ms ..< 1s);
      AudioGap(destination: 1s ..< 2s);`,
    "2s",
  );
  const baseLine = source.slice(0, source.indexOf("AudioClip(source: a")).split("\n").length;
  const tampered = compile(source), plan = track(tampered).editorial.operationPlan;
  assert.ok(plan && plan.baseItems[0].kind === "clip" && plan.baseItems[1].kind === "clip");
  const first = rational(1, 44_100), remainder = rational(44_099, 44_100);
  plan.baseItems[0].destination.duration = first;
  plan.baseItems[0].source.duration = first;
  plan.baseItems[1].destination.start = first;
  plan.baseItems[1].destination.duration = remainder;
  plan.baseItems[1].source.duration = remainder;

  // The operation plan is inspectable evidence and excluded from build/hash
  // identity only after runtime reconciliation, so strict loading alone cannot
  // prove these destination clocks. Runtime replay must close that boundary.
  const loaded = validateCutAvIr(JSON.parse(JSON.stringify(tampered)));
  const locked = fakeLock(loaded, 44_100, rational(1));
  for (const validate of [
    () => validateReferenceAudioTrackOperationPlan(locked, locked.compositions[0], track(locked)),
    () => validateReferenceSession(locked),
  ]) {
    assert.throws(validate, (error) => {
      const diagnostic = cutDiagnosticsFromError(error)[0];
      assert.equal(diagnostic.code, "CUT_AUDIO_EDIT_TIME");
      assert.equal(diagnostic.source?.line, baseLine);
      assert.match(diagnostic.message, /destination end.*48000 Hz destination sample grid/);
      return true;
    });
  }
});

test("AudioTrack plan replay shares canonical CutAVIR provenance, string, and rational budgets", () => {
  const canonical = compile(operationProgram("audioSplit(at: 500ms)")), canonicalTrack = track(canonical);
  assert.ok(canonicalTrack.editorial.operationPlan);
  const frame = {
    module: "modules/audio\nedit.cut",
    span: structuredClone(canonicalTrack.editorial.operationPlan.operations[0].provenance.span),
    symbol: "audioSplit\nwrapped",
  };
  canonicalTrack.editorial.operationPlan.operations[0].provenance.symbol = "audioSplit\nwrapped";
  canonicalTrack.editorial.operationPlan.operations[0].provenance.expandedFrom = Array.from({ length: 256 }, () => structuredClone(frame));
  const loadedBoundary = validateCutAvIr(JSON.parse(JSON.stringify(canonical)));
  assert.doesNotThrow(() => validateAudioEditOperationPlan(track(loadedBoundary).editorial.operationPlan));
  assert.doesNotThrow(() => validateReferenceAudioTrackOperationPlan(fakeLock(loadedBoundary), loadedBoundary.compositions[0], track(loadedBoundary)));

  const tooDeep = structuredClone(canonical);
  const tooDeepPlan = track(tooDeep).editorial.operationPlan;
  assert.ok(tooDeepPlan);
  tooDeepPlan.operations[0].provenance.expandedFrom = Array.from({ length: 257 }, () => structuredClone(frame));
  assert.throws(() => validateCutAvIr(JSON.parse(JSON.stringify(tooDeep))), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_LIMIT");
  assert.throws(() => validateAudioEditOperationPlan(tooDeepPlan), (error) => error instanceof AudioEditOperationError && error.code === "CUT_AUDIO_EDIT_LIMIT");

  const rationalBoundary = compile(operationProgram("audioSlip(range: 0s ..< 1s, by: 500ms)")), rationalPlan = track(rationalBoundary).editorial.operationPlan;
  assert.ok(rationalPlan && rationalPlan.operations[0].kind === "slip");
  rationalPlan.operations[0].by = { numerator: "1", denominator: `1${"0".repeat(255)}` };
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(rationalBoundary))));
  assert.doesNotThrow(() => validateAudioEditOperationPlan(rationalPlan));

  const tooWide = structuredClone(rationalBoundary), tooWidePlan = track(tooWide).editorial.operationPlan;
  assert.ok(tooWidePlan && tooWidePlan.operations[0].kind === "slip");
  tooWidePlan.operations[0].by = { numerator: "1", denominator: `1${"0".repeat(256)}` };
  assert.throws(() => validateCutAvIr(JSON.parse(JSON.stringify(tooWide))), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_LIMIT");
  assert.throws(() => validateAudioEditOperationPlan(tooWidePlan), (error) => error instanceof AudioEditOperationError && error.code === "CUT_AUDIO_EDIT_LIMIT");
});
