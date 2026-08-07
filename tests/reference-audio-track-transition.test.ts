import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Ajv from "ajv";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { rational } from "../lib/language/rational";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { referenceMasterAudioRootIds, renderReferenceAudio } from "../lib/runtime/reference/audio";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity } from "../lib/runtime/reference/audio-cache";
import { validateReferenceAudioTrackOperationPlan } from "../lib/runtime/reference/audio-edit-operations";
import { ReferenceAudioTrackTransitionError, referenceAudioCrossfadeGain } from "../lib/runtime/reference/audio-track-transition";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) { return compileCutModule(moduleFor(source)).ir; }

type AudioTrackNode = IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> };
function track(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.edit.audio_track");
  assert.ok(node?.editorial?.kind === "audio-track");
  return node as AudioTrackNode;
}

function program(options: {
  edits?: string;
  body?: string;
  duration?: string;
  sourceDuration?: string;
  project?: string;
} = {}) {
  const edits = options.edits ?? 'audioCrossfadeAt(at: 1s, duration: 500ms)';
  const body = options.body ?? `
      AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 250ms);
      AudioClip(source: incoming, range: 250ms ..< 1250ms, destination: 1s ..< 2s, headHandle: 250ms);`;
  return `cut 0.4;
project "${options.project ?? "audio track transition"}";
import { AudioTrack, AudioGap, audioCrossfadeAt, audioSplit } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset outgoing: AudioAsset = audio("outgoing.wav");
asset incoming: AudioAsset = audio("incoming.wav");
timeline main(duration: ${options.duration ?? "2s"}, fps: 24, sampleRate: 48khz) {
  AudioTrack(sourceDuration: ${options.sourceDuration ?? options.duration ?? "2s"}, edits: [
    ${edits}
  ]) {${body}
  }
}
export out = render(main);`;
}

function fakeLock(ir: CutAVIR, rates: Record<string, number> = { outgoing: 48_000, incoming: 48_000 }, duration = rational(3)) {
  for (const resource of Object.values(ir.resources)) {
    const sampleRate = rates[resource.name] ?? 48_000;
    resource.state = "locked";
    resource.sha256 = resource.name.padEnd(64, "0").slice(0, 64);
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

function diagnostic(source: string) {
  try { compile(source); }
  catch (error) {
    assert.ok(error instanceof CutCompileError);
    return error.result.diagnostics.find((item) => item.code.startsWith("CUT_AUDIO_EDIT")) ?? error.result.diagnostics[0];
  }
  assert.fail("expected compilation failure");
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

test("audioCrossfadeAt parses, type-checks, resolves after structural edits, and lowers to closed typed IR", () => {
  const ir = compile(program({ edits: `audioCrossfadeAt(at: 1s, duration: 500ms, curve: "linear"),
    audioSplit(at: 250ms)` }));
  const audioTrack = track(ir), transition = audioTrack.editorial.transitions?.[0];
  assert.ok(transition);
  assert.equal(audioTrack.editorial.items.length, 3, "the structural split must execute before transition resolution");
  assert.deepEqual({
    cut: transition.cut,
    duration: transition.duration,
    overlap: transition.overlap,
    outgoingSource: transition.outgoingSource,
    incomingSource: transition.incomingSource,
    curve: transition.curve,
  }, {
    cut: rational(1),
    duration: rational(1, 2),
    overlap: { start: rational(3, 4), duration: rational(1, 2) },
    outgoingSource: { start: rational(1), duration: rational(1, 4) },
    incomingSource: { start: rational(0), duration: rational(1, 4) },
    curve: "linear",
  });
  assert.equal(transition.outgoingNodeId, audioTrack.children[1]);
  assert.equal(transition.incomingNodeId, audioTrack.children[2]);
  assert.equal(audioTrack.editorial.operationPlan?.operations[0].kind, "crossfade");
  assert.equal(audioTrack.inputs.edits, undefined);
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(ir), { outgoing: 44_100, incoming: 48_000 })));

  const checked = checkCutModule(moduleFor(program()));
  assert.equal(checked.diagnostics.filter((item) => item.severity === "error").length, 0);
  const unknown = checkCutModule(moduleFor(program({ edits: "audioCrossfadeAt(at: 1s, duration: 500ms, softness: 10%)" })));
  assert.ok(unknown.diagnostics.some((item) => item.code === "CUT2027" && /softness/.test(item.message)));
  const wrongCurve = checkCutModule(moduleFor(program({ edits: 'audioCrossfadeAt(at: 1s, duration: 500ms, curve: "log")' })));
  assert.ok(wrongCurve.diagnostics.some((item) => /equal-power|linear/.test(item.message)));
  const standaloneHandle = checkCutModule(moduleFor(`cut 0.4;
project "standalone handle refusal";
import { AudioClip } from "@cut/audio";
asset outgoing: AudioAsset = audio("outgoing.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  AudioClip(source: outgoing, range: 0s ..< 1s, tailHandle: 250ms);
}
export out = render(main);`));
  assert.ok(standaloneHandle.diagnostics.some((item) => item.code === "CUT2072" && /tailHandle/.test(item.message)));
});

test("audioCrossfadeAt rejects bad topology, unavailable handles, links, fades, grids, duplicate and intersecting windows", () => {
  const cases: Array<[string, RegExp]> = [
    [program({ body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 100ms);
      AudioClip(source: incoming, range: 250ms ..< 1250ms, destination: 1s ..< 2s, headHandle: 250ms);` }), /tailHandle/],
    [program({ body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 250ms);
      AudioGap(destination: 1s ..< 2s);` }), /adjacent AudioClips|silence/],
    [program({ edits: "audioCrossfadeAt(at: 750ms, duration: 500ms)" }), /inside a clip/],
    [program({ edits: "audioCrossfadeAt(at: 0s, duration: 500ms)" }), /track-edge/],
    [program({ edits: "audioCrossfadeAt(at: 1s, duration: seconds(3 / 48000))" }), /even integer/],
    [program({ body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 250ms, link: "take");
      AudioClip(source: incoming, range: 250ms ..< 1250ms, destination: 1s ..< 2s, headHandle: 250ms);` }), /linked picture/],
    [program({ duration: "3s", sourceDuration: "3s", body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 250ms);
      AudioClip(source: incoming, range: 250ms ..< 1250ms, destination: 1s ..< 2s, headHandle: 250ms);
      AudioClip(source: outgoing, range: 0s ..< 1s, destination: 2s ..< 3s, link: "unrelated");` }), /linked picture/],
    [program({ body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 250ms, fadeOut: 10ms);
      AudioClip(source: incoming, range: 250ms ..< 1250ms, destination: 1s ..< 2s, headHandle: 250ms);` }), /fadeOut|manual fades/],
    [program({ edits: `audioCrossfadeAt(at: 1s, duration: 500ms),
      audioCrossfadeAt(at: 1s, duration: 500ms)` }), /duplicates/],
  ];
  for (const [source, message] of cases) {
    const result = diagnostic(source);
    assert.match(result.code, /^CUT_AUDIO_EDIT_(?:TIME|NOOP|UNSUPPORTED)$/);
    assert.match(result.message, message, result.message);
  }

  const three = program({
    duration: "3s",
    edits: `audioCrossfadeAt(at: 1s, duration: 1500ms),
      audioCrossfadeAt(at: 2s, duration: 1500ms)`,
    body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 750ms);
      AudioClip(source: incoming, range: 750ms ..< 1750ms, destination: 1s ..< 2s, headHandle: 750ms, tailHandle: 750ms);
      AudioClip(source: outgoing, range: 750ms ..< 1750ms, destination: 2s ..< 3s, headHandle: 750ms);`,
  });
  assert.match(diagnostic(three).message, /intersects/);

  const nativeGrid = fakeLock(compile(program()), { outgoing: 44_100, incoming: 48_000 });
  assert.doesNotThrow(() => validateReferenceSession(nativeGrid));
  const offNative = fakeLock(compile(program({ edits: "audioCrossfadeAt(at: 1s, duration: seconds(2 / 48000))", body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: seconds(1 / 48000));
      AudioClip(source: incoming, range: seconds(1 / 48000) ..< seconds(48001 / 48000), destination: 1s ..< 2s, headHandle: seconds(1 / 48000));` })), { outgoing: 44_100, incoming: 48_000 });
  assert.throws(() => validateReferenceSession(offNative), /CUT_AUDIO_EDIT_TIME|CUT_MEDIA_SOURCE_GRID/);

  const unusedOutOfBounds = compile(`cut 0.4;
project "locked handle bounds";
import { AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset outgoing: AudioAsset = audio("outgoing.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  AudioTrack() {
    AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 250ms);
  }
}
export out = render(main);`);
  assert.throws(() => validateReferenceSession(fakeLock(unusedOutOfBounds, { outgoing: 48_000 }, rational(9, 8))), /CUT_EDIT_AUDIO_CLIP: tailHandle extends beyond/);
});

test("three clips permit touching half-open crossfades while preserving duration and rejecting forged metadata", () => {
  const source = program({
    duration: "3s",
    edits: `audioCrossfadeAt(at: 1s, duration: 1s),
      audioCrossfadeAt(at: 2s, duration: 1s)`,
    body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 500ms);
      AudioClip(source: incoming, range: 500ms ..< 1500ms, destination: 1s ..< 2s, headHandle: 500ms, tailHandle: 500ms);
      AudioClip(source: outgoing, range: 500ms ..< 1500ms, destination: 2s ..< 3s, headHandle: 500ms);`,
  });
  const ir = compile(source), audioTrack = track(ir);
  assert.equal(audioTrack.interval.duration.numerator, "3");
  assert.deepEqual(audioTrack.editorial.transitions?.map((item) => item.overlap), [
    { start: rational(1, 2), duration: rational(1) },
    { start: rational(3, 2), duration: rational(1) },
  ]);
  assert.equal(audioTrack.editorial.transitions?.[0].incomingNodeId, audioTrack.editorial.transitions?.[1].outgoingNodeId);
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(ir))));

  const nonChronological = compile(program({
    duration: "3s",
    edits: `audioCrossfadeAt(at: 2s, duration: 1s),
      audioCrossfadeAt(at: 1s, duration: 1s)`,
    body: `AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 500ms);
      AudioClip(source: incoming, range: 500ms ..< 1500ms, destination: 1s ..< 2s, headHandle: 500ms, tailHandle: 500ms);
      AudioClip(source: outgoing, range: 500ms ..< 1500ms, destination: 2s ..< 3s, headHandle: 500ms);`,
  }));
  assert.deepEqual(track(nonChronological).editorial.transitions?.map((item) => item.cut), [rational(2), rational(1)]);
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(nonChronological)));

  const unknown = JSON.parse(JSON.stringify(ir)) as CutAVIR;
  (track(unknown).editorial.transitions![0] as unknown as Record<string, unknown>).ignored = true;
  assert.throws(() => validateCutAvIr(unknown), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD");
  const forged = fakeLock(structuredClone(ir));
  track(forged).editorial.transitions![0].outgoingSource.start = rational(3, 4);
  assert.throws(() => validateReferenceAudioTrackOperationPlan(forged, forged.compositions[0], track(forged)), /CUT_AUDIO_EDIT_RESULT/);
  const missingPlan = JSON.parse(JSON.stringify(ir)) as CutAVIR;
  delete track(missingPlan).editorial.operationPlan;
  assert.throws(() => validateCutAvIr(missingPlan), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_TYPE");
});

test("audio transition runtime diagnostics bound hostile curve and unknown-field strings", () => {
  const fresh = () => fakeLock(compile(program())), hostile = hostileDiagnosticString();
  const rejected = (
    ir: CutAVIR,
    code: ReferenceAudioTrackTransitionError["code"],
    inspect: (error: ReferenceAudioTrackTransitionError) => void,
  ) => {
    const audioTrack = track(ir), provenance = audioTrack.editorial.transitions![0].provenance;
    assert.throws(() => validateReferenceAudioTrackOperationPlan(ir, ir.compositions[0], audioTrack), (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioTrackTransitionError);
      assert.equal(error.code, code);
      assert.deepEqual(error.source, {
        module: provenance.module,
        line: provenance.span.start.line,
        column: provenance.span.start.column,
        nodeId: audioTrack.id,
      });
      inspect(error);
      return true;
    });
  };

  const unknown = fresh(), unknownTransition = track(unknown).editorial.transitions![0] as unknown as Record<string, unknown>;
  unknownTransition[hostile.value] = true;
  rejected(unknown, "CUT_AUDIO_EDIT_SHAPE", (error) => assertBoundedHostileDiagnostic(error.message, hostile.preview, hostile.value));

  const curve = fresh();
  track(curve).editorial.transitions![0].curve = hostile.value as never;
  rejected(curve, "CUT_AUDIO_EDIT_UNSUPPORTED", (error) => assertBoundedHostileDiagnostic(error.message, hostile.preview, hostile.value));

  const objectCurve = fresh();
  track(objectCurve).editorial.transitions![0].curve = { nested: hostile.value } as never;
  rejected(objectCurve, "CUT_AUDIO_EDIT_UNSUPPORTED", (error) => {
    assert.match(error.message, /unsupported curve an object/u);
    assert.ok(Buffer.byteLength(error.message, "utf8") < 1_024);
    assert.doesNotMatch(error.message, /Unicode code points/u);
  });
});

test("CUT-owned linear and equal-power envelopes use exact p=k/N sample semantics", () => {
  for (const sampleCount of [2, 8, 24_000]) {
    for (const k of [0, Math.floor(sampleCount / 2), sampleCount - 1]) {
      const linearOut = referenceAudioCrossfadeGain("linear", "outgoing", k, sampleCount);
      const linearIn = referenceAudioCrossfadeGain("linear", "incoming", k, sampleCount);
      assert.ok(Math.abs(linearOut + linearIn - 1) < 1e-15, `correlated linear sum at ${k}/${sampleCount}`);
      const powerOut = referenceAudioCrossfadeGain("equal-power", "outgoing", k, sampleCount);
      const powerIn = referenceAudioCrossfadeGain("equal-power", "incoming", k, sampleCount);
      assert.ok(Math.abs(powerOut ** 2 + powerIn ** 2 - 1) < 1e-12, `equal power at ${k}/${sampleCount}`);
    }
    assert.equal(referenceAudioCrossfadeGain("linear", "incoming", 0, sampleCount), 0);
    assert.equal(referenceAudioCrossfadeGain("linear", "outgoing", 0, sampleCount), 1);
  }
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
  let offset = 12, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  return (frame: number) => {
    const position = frame * 6;
    let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000;
    return value / 0x800000;
  };
}

test("mixed 44.1/48 kHz sentinel media proves real head/tail samples are decoded and linearly enveloped", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-track-crossfade-"));
  await writeFile(resolve(root, "outgoing.wav"), monoPcm16Wave(44_100, [
    ...Array.from({ length: 44_100 }, () => 4_000),
    ...Array.from({ length: 11_025 }, () => 12_000),
  ]));
  await writeFile(resolve(root, "incoming.wav"), monoPcm16Wave(48_000, [
    ...Array.from({ length: 12_000 }, () => -12_000),
    ...Array.from({ length: 48_000 }, () => -4_000),
  ]));
  const ir = compile(program({ edits: 'audioCrossfadeAt(at: 1s, duration: 500ms, curve: "linear")' }));
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), output = resolve(root, "crossfade.wav");
  await renderReferenceAudio(ir, composition, root, output);
  const sample = pcm24Data(await readFile(output)), gain = Math.SQRT1_2 / 32_768;
  const near = (frame: number, expected: number, tolerance = .002) => assert.ok(Math.abs(sample(frame) - expected * gain) < tolerance, `sample ${frame}: ${sample(frame)} != ${expected * gain}`);
  near(0, 4_000);
  near(36_000, 4_000);
  near(42_000, 0);
  near(47_999, -4_000, .01);
  near(48_000, 4_000, .01);
  near(54_000, 0);
  near(59_999, -4_000, .003);
  near(60_000, -4_000);

  const hostile = structuredClone(ir), hostileTrack = track(hostile);
  hostileTrack.editorial.transitions![0].incomingSource.start = rational(1, 48_000);
  await assert.rejects(renderReferenceAudio(hostile, composition, root, resolve(root, "must-not-render.wav")), /CUT_AUDIO_EDIT_RESULT/);
});

test("transition identity, cache, semantic diff, schema, surplus handles, and OTIO loss are explicit", async () => {
  const base = compile(program({ edits: "audioCrossfadeAt(at: 1s, duration: 250ms)", body: `
      AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 125ms);
      AudioClip(source: incoming, range: 500ms ..< 1500ms, destination: 1s ..< 2s, headHandle: 125ms);` }));
  const surplus = compile(program({ edits: "audioCrossfadeAt(at: 1s, duration: 250ms)", body: `
      AudioClip(source: outgoing, range: 0s ..< 1s, destination: 0s ..< 1s, tailHandle: 500ms);
      AudioClip(source: incoming, range: 500ms ..< 1500ms, destination: 1s ..< 2s, headHandle: 500ms);` }));
  assert.notEqual(base.sourceHash, surplus.sourceHash);
  assert.equal(base.buildId, surplus.buildId, "unused declared availability must not invalidate executable audio identity");
  assert.deepEqual(diffCutAVIR(base, surplus).changes, [], "semantic diff projects only consumed audio handles");

  const linear = compile(program({ edits: 'audioCrossfadeAt(at: 1s, duration: 500ms, curve: "linear")' }));
  assert.notEqual(base.buildId, linear.buildId);
  assert.ok(diffCutAVIR(base, linear).changes.some((change) => change.entity === "node"));
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-audio-crossfade-test");
  const lockedBase = fakeLock(structuredClone(base)), lockedSurplus = fakeLock(structuredClone(surplus)), lockedLinear = fakeLock(structuredClone(linear));
  const cache = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), toolchain);
  assert.equal(cache(lockedBase).key, cache(lockedSurplus).key);
  assert.notEqual(cache(lockedBase).key, cache(lockedLinear).key);

  const exported = exportCutTimelineToOtio(base);
  assert.equal(exported.report.status, "lossy-editorial");
  assert.ok(exported.report.unsupportedSemantics.some((issue) => issue.code === "CUT_OTIO_AUDIO_CROSSFADE_UNSUPPORTED" && /source handles/.test(issue.message)));

  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  assert.equal(validate(JSON.parse(JSON.stringify(base))), true, JSON.stringify(validate.errors));
  const badCurve = JSON.parse(JSON.stringify(base)) as CutAVIR;
  track(badCurve).editorial.transitions![0].curve = "log" as never;
  assert.equal(validate(badCurve), false);
  assert.throws(() => validateCutAvIr(badCurve), CutAvIrValidationError);
});
