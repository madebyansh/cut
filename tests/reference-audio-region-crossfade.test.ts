import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { executeAudioEditOperationPlan } from "../lib/language/audio-edit-operations";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { inspectCutIr } from "../lib/runtime/inspect";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { referenceMasterAudioRootIds, renderReferenceAudio } from "../lib/runtime/reference/audio";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity, renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { validateReferenceAudioTrackOperationPlan } from "../lib/runtime/reference/audio-edit-operations";
import { referenceAudioTrackTransitionPlans } from "../lib/runtime/reference/audio-track-transition";
import { renderReferenceAudioStems } from "./reference-stem-test-helper";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

type AudioTrack = IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> };
function audioTrack(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.edit.audio_track");
  assert.ok(node?.editorial?.kind === "audio-track");
  return node as AudioTrack;
}

function regionProgram(options: { three?: boolean; curve?: "linear" | "equal-power"; handles?: string; firstLeaf?: string } = {}) {
  const three = options.three ?? false, handles = options.handles ?? "500ms", curve = options.curve ?? "linear";
  const operations = three
    ? `audioCrossfadeAt(at: 1s, duration: 1s, curve: "${curve}"), audioCrossfadeAt(at: 2s, duration: 1s, curve: "${curve}")`
    : `audioCrossfadeAt(at: 1s, duration: 1s, curve: "${curve}")`;
  return `cut 0.4;
project "processed AudioRegion crossfade";
import { AudioTrack, AudioRegion, audioCrossfadeAt } from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: ${three ? "3s" : "2s"}, fps: 25, sampleRate: 48khz) {
  AudioTrack(sourceDuration: ${three ? "3s" : "2s"}, edits: [${operations}]) {
    AudioRegion(destination: 0s ..< 1s, tailHandle: ${handles}) {
      Gain(amount: -3db) { HighPass(frequency: 80hz) { ${options.firstLeaf ?? "AudioClip(source: voice, range: 500ms ..< 1500ms);"} } }
    }
    AudioRegion(destination: 1s ..< 2s, headHandle: ${handles}${three ? `, tailHandle: ${handles}` : ""}) {
      Gain(amount: -6db) { HighPass(frequency: 120hz) { AudioClip(source: voice, range: 1500ms ..< 2500ms); } }
    }
    ${three ? `AudioRegion(destination: 2s ..< 3s, headHandle: ${handles}) {
      Gain(amount: -9db) { HighPass(frequency: 160hz) { AudioClip(source: voice, range: 2500ms ..< 3500ms); } }
    }` : ""}
  }
}
export out = render(main);`;
}

function fakeLock(ir: CutAVIR, sampleRate = 48_000, duration = rational(10)) {
  const decodedVideoCadence = {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: "phase-floor",
    phaseNumerator: "0",
    streamIndex: 0,
    firstPts: "0",
    lastPts: "249",
    quantizedEndPts: "250",
    frameCount: "250",
    durationPresentCount: "250",
    durationCoverage: "complete",
    recordsSha256: "0".repeat(64),
    timeBase: rational(1, 25),
    frameRate: rational(25),
  } as const;
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "a".repeat(64);
    resource.metadata = resource.kind === "audio" ? {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [{ index: 0, type: "audio", sampleRate }] },
        selected: { audio: { streamIndex: 0, duration, durationSource: "stream", timeBase: rational(1, sampleRate) } },
      },
    } as never : {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [{
          index: 0,
          type: "video",
          start: rational(0),
          frameRate: rational(25),
          timeBase: rational(1, 25),
          width: 1920,
          height: 1080,
        }] },
        selected: { video: {
          streamIndex: 0,
          start: rational(0),
          duration,
          durationSource: "decoded-video-cadence",
          timeBase: rational(1, 25),
          frameRate: rational(25),
          decodedVideoCadence,
        } },
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
    return error.result.diagnostics.find((item) => item.code.startsWith("CUT_AUDIO_REGION_CROSSFADE")) ?? error.result.diagnostics[0];
  }
  assert.fail("expected compilation failure");
}

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2, buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function pcm24(buffer: Buffer) {
  let offset = 12, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + size % 2;
  }
  return {
    frames: data.length / 6,
    sample(frame: number, channel = 0) {
      const position = frame * 6 + channel * 3;
      let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

test("processed crossfades lower to closed v2 region plans and render a touching middle region once with two envelopes", () => {
  const ir = compile(regionProgram({ three: true })), track = audioTrack(ir), plan = track.editorial.operationPlan;
  assert.equal(plan?.version, 2);
  if (plan?.version !== 2) return;
  assert.equal(plan.baseItems.length, 3);
  assert.deepEqual(plan.baseItems.map((item) => ({
    regionId: item.regionId,
    sourceNodeId: item.sourceNodeId,
    processors: item.processorNodeIds.map((id) => ir.nodes[id].op),
    head: item.inputs.headHandle ?? rational(0),
    tail: item.inputs.tailHandle ?? rational(0),
  })), [
    { regionId: track.children[0], sourceNodeId: track.editorial.items[0].sourceNodeId, processors: ["cut.audio.gain", "cut.audio.highpass"], head: rational(0), tail: rational(1, 2) },
    { regionId: track.children[1], sourceNodeId: track.editorial.items[1].sourceNodeId, processors: ["cut.audio.gain", "cut.audio.highpass"], head: rational(1, 2), tail: rational(1, 2) },
    { regionId: track.children[2], sourceNodeId: track.editorial.items[2].sourceNodeId, processors: ["cut.audio.gain", "cut.audio.highpass"], head: rational(1, 2), tail: rational(0) },
  ]);
  assert.deepEqual(track.children.map((id) => ir.nodes[id].op), ["cut.edit.audio_region", "cut.edit.audio_region", "cut.edit.audio_region"]);
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
  const locked = fakeLock(structuredClone(ir));
  assert.doesNotThrow(() => validateReferenceSession(locked));
  const execution = executeAudioEditOperationPlan(plan);
  const renderPlans = referenceAudioTrackTransitionPlans(locked, locked.compositions[0], audioTrack(locked), execution.transitions);
  assert.equal(renderPlans.length, 3, "one render plan must exist per authored region, not per transition side");
  assert.deepEqual(renderPlans.map((item) => item.kind), ["region", "region", "region"]);
  assert.deepEqual(renderPlans[1].envelopes.map((item) => item.side), ["incoming", "outgoing"]);
  assert.equal(renderPlans[1].destination.duration.numerator, "2", "middle processor instance spans the union of both consumed handles");
});

test("processed crossfade compile diagnostics distinguish topology, handle, automation, and plan failures", () => {
  const mixed = regionProgram().replace(
    `AudioRegion(destination: 1s ..< 2s, headHandle: 500ms) {\n      Gain(amount: -6db) { HighPass(frequency: 120hz) { AudioClip(source: voice, range: 1500ms ..< 2500ms); } }\n    }`,
    "AudioClip(source: voice, range: 1500ms ..< 2500ms, destination: 1s ..< 2s, headHandle: 500ms);",
  );
  assert.equal(diagnostic(mixed).code, "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY");
  assert.equal(diagnostic(regionProgram({ handles: "100ms" })).code, "CUT_AUDIO_REGION_CROSSFADE_HANDLE");
  assert.equal(diagnostic(regionProgram({ firstLeaf: "AudioClip(source: voice, range: 500ms ..< 1500ms, fadeOut: 1ms);" })).code, "CUT_AUDIO_REGION_CROSSFADE_PLAN");
  const structural = regionProgram().replace("audioCrossfadeAt(at: 1s, duration: 1s, curve: \"linear\")", "audioSplit(at: 500ms)")
    .replace("AudioRegion, audioCrossfadeAt", "AudioRegion, audioCrossfadeAt, audioSplit");
  assert.equal(diagnostic(structural).code, "CUT_AUDIO_REGION_CROSSFADE_PLAN");
  const automated = regionProgram().replace(
    `AudioRegion(destination: 0s ..< 1s, tailHandle: 500ms) {
      Gain(amount: -3db) { HighPass(frequency: 80hz) { AudioClip(source: voice, range: 500ms ..< 1500ms); } }
    }`,
    `AudioRegion(destination: 0s ..< 1s, tailHandle: 500ms) {
      Gain(amount: -3db) as level { HighPass(frequency: 80hz) { AudioClip(source: voice, range: 500ms ..< 1500ms); } }
      at 500ms { set level.amount = -2db; }
    }`,
  );
  assert.equal(diagnostic(automated).code, "CUT_AUDIO_REGION_CROSSFADE_AUTOMATION");
});

test("loader, runtime, and warm-cache entry reauthorize encoded v2 ranges and identities", () => {
  const unlocked = compile(regionProgram()), hostileLoader = structuredClone(unlocked), loaderTrack = audioTrack(hostileLoader);
  assert.ok(loaderTrack.editorial.operationPlan?.version === 2);
  if (loaderTrack.editorial.operationPlan?.version !== 2) return;
  loaderTrack.editorial.operationPlan.baseItems[0].sourceNodeId = loaderTrack.children[0];
  assert.throws(() => validateCutAvIr(JSON.parse(JSON.stringify(hostileLoader))), (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_IDENTITY");

  const hostileRuntime = fakeLock(structuredClone(unlocked)), runtimeTrack = audioTrack(hostileRuntime);
  runtimeTrack.editorial.transitions![0].incomingSource.start = rational(1, 4);
  assert.throws(() => validateReferenceAudioTrackOperationPlan(hostileRuntime, hostileRuntime.compositions[0], runtimeTrack), /CUT_AUDIO_REGION_CROSSFADE_PLAN/);
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --processed-region-crossfade");
  assert.throws(
    () => createReferenceAudioCachePlan(hostileRuntime, hostileRuntime.compositions[0], referenceMasterAudioRootIds(hostileRuntime, hostileRuntime.compositions[0]), toolchain),
    /CUT_AUDIO_REGION_CROSSFADE_PLAN/,
  );
});

test("a real warm artifact cannot launder a forged plan-only processed transition identity", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-crossfade-warm-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48_000, Array.from({ length: 1_200 }, () => 8_000)));
    const source = `cut 0.4;
project "warm processed crossfade";
import { AudioTrack, AudioRegion, audioCrossfadeAt } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 20ms, edits: [audioCrossfadeAt(at: 10ms, duration: 4ms)]) {
    AudioRegion(destination: 0ms ..< 10ms, tailHandle: 2ms) { Gain(amount: -3db) { AudioClip(source: voice, range: 2ms ..< 12ms); } }
    AudioRegion(destination: 10ms ..< 20ms, headHandle: 2ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 12ms ..< 22ms); } }
  }
}
export out = render(main);`;
    const valid = compile(source), lock = await createCutLock(valid, root);
    await applyCutLock(valid, lock, root);
    const cold = await renderReferenceAudioArtifact(valid, valid.compositions[0], root);
    assert.equal(cold.cache.status, "miss");
    const cacheRoot = resolve(root, ".cut/cache/reference/audio");
    const before = (await readdir(cacheRoot, { recursive: true })).sort(), artifact = await readFile(cold.path);
    const hostile = structuredClone(valid), track = audioTrack(hostile);
    assert.ok(track.editorial.operationPlan?.version === 2);
    if (track.editorial.operationPlan?.version !== 2) return;
    // This changes only replay authorization evidence; the live source graph,
    // transition projection, and therefore projected PCM/cache key are intact.
    track.editorial.operationPlan.baseItems[0].sourceNodeId = track.children[0];
    await assert.rejects(
      renderReferenceAudioArtifact(hostile, hostile.compositions[0], root),
      /CUT_AUDIO_REGION_CROSSFADE_PLAN/,
    );
    assert.deepEqual((await readdir(cacheRoot, { recursive: true })).sort(), before, "hostile warm-hit attempt changed cache/staging state");
    assert.deepEqual(await readFile(cold.path), artifact, "hostile warm-hit attempt modified the authorized artifact");
    assert.ok(!(await readdir(cacheRoot, { recursive: true })).some((entry) => entry.startsWith(".cut-audio-")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cache, inspect, and OTIO expose processed participants while surplus handles stay non-executable", () => {
  const exact = fakeLock(compile(regionProgram())), surplus = fakeLock(compile(regionProgram({ handles: "750ms" })));
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --processed-region-crossfade-identity");
  const cache = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), toolchain);
  assert.equal(cache(exact).key, cache(surplus).key, "unused declared handle surplus must not perturb executed PCM identity");
  assert.ok(diffCutAVIR(exact, surplus).changes.some((change) => change.entity === "node"), "semantic diff must retain declared availability even when only the consumed half affects PCM");
  const equalPower = fakeLock(compile(regionProgram({ curve: "equal-power" })));
  assert.notEqual(cache(exact).key, cache(equalPower).key);

  const inspected = inspectCutIr(exact, "") as unknown as { graph: { nodes: Array<{ editorial?: { processedCrossfadePlan?: { participants: Array<{ processorNodeIds: string[]; sourceNodeId: string; headHandle: unknown; tailHandle: unknown }>; transitions: unknown[] } } }> } };
  const summary = inspected.graph.nodes.find((node) => node.editorial?.processedCrossfadePlan)?.editorial?.processedCrossfadePlan;
  assert.equal(summary?.participants.length, 2);
  assert.equal(summary?.participants[0].processorNodeIds.length, 2);
  assert.ok(summary?.participants[0].sourceNodeId);
  assert.equal(summary?.transitions.length, 1);

  const otio = exportCutTimelineToOtio(exact);
  assert.ok(otio.report.unsupportedSemantics.some((issue) => issue.code === "CUT_OTIO_AUDIO_CROSSFADE_UNSUPPORTED" && /processor-state semantics|processor chain/.test(issue.message)));
  assert.ok(otio.report.unsupportedSemantics.some((issue) => issue.code === "CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED" && /head\/tail handles/.test(issue.message)));
});

test("standalone and unused AudioRegion handles remain validated availability metadata without invalidating PCM cache locality", () => {
  const standalone = (handle: string) => `cut 0.4;
project "standalone region availability";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 1s, fps: 25, sampleRate: 48khz) {
  AudioTrack() { AudioRegion(destination: 0s ..< 1s, headHandle: ${handle}, tailHandle: ${handle}) {
    Gain(amount: -3db) { AudioClip(source: voice, range: 500ms ..< 1500ms); }
  } }
}
export out = render(main);`;
  const exact = fakeLock(compile(standalone("100ms")), 48_000, rational(2));
  const surplus = fakeLock(compile(standalone("250ms")), 48_000, rational(2));
  assert.doesNotThrow(() => validateReferenceSession(exact));
  assert.doesNotThrow(() => validateReferenceSession(surplus));
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --region-availability");
  const cache = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), toolchain);
  assert.equal(cache(exact).key, cache(surplus).key, "validated but unconsumed availability must not invalidate identical PCM");
  assert.ok(diffCutAVIR(exact, surplus).changes.some((change) => change.entity === "node"), "semantic diff must still report declared availability changes");
  const inspected = inspectCutIr(surplus, "") as unknown as { graph: { nodes: Array<{ audioRegionHandleAvailability?: unknown }> } };
  assert.ok(inspected.graph.nodes.some((node) => node.audioRegionHandleAvailability));

  const outOfBounds = fakeLock(compile(standalone("400ms")), 48_000, rational(17, 10));
  assert.throws(() => validateReferenceSession(outOfBounds), /declared AudioRegion head\/tail handle availability exceeds/);
  const offNativeGrid = fakeLock(compile(standalone("seconds(1 \/ 48000)")), 44_100, rational(2));
  assert.throws(() => validateReferenceSession(offNativeGrid), /locked 44100 Hz source sample grid/);
});

test("distinct passive picture links survive a processed audio crossfade without creating a picture transition", () => {
  const source = `cut 0.4;
project "passive linked processed crossfade";
import { Sequence, PictureTrack, PictureClip, AudioTrack, AudioRegion, audioCrossfadeAt } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 25, sampleRate: 48khz) { scene only(duration: 2s) {
  Sequence(duration: 2s) { PictureTrack() {
    PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "outgoing");
    PictureClip(source: picture, range: 1s ..< 2s, duration: 1s, link: "incoming");
  } }
  AudioTrack(sourceDuration: 2s, edits: [audioCrossfadeAt(at: 1s, duration: 200ms)]) {
    AudioRegion(destination: 0s ..< 1s, link: "outgoing", tailHandle: 100ms) { Gain(amount: -3db) { AudioClip(source: voice, range: 100ms ..< 1100ms); } }
    AudioRegion(destination: 1s ..< 2s, link: "incoming", headHandle: 100ms) { Gain(amount: -3db) { AudioClip(source: voice, range: 1100ms ..< 2100ms); } }
  }
} }
export out = render(main);`;
  const ir = compile(source), pictureTrack = Object.values(ir.nodes).find((node) => node.editorial?.kind === "picture-track"), track = audioTrack(ir);
  assert.ok(pictureTrack?.editorial?.kind === "picture-track");
  assert.equal(pictureTrack?.editorial?.kind === "picture-track" && pictureTrack.editorial.transitions, undefined);
  assert.deepEqual(track.editorial.items.map((item) => item.linkId), ["outgoing", "incoming"]);
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(ir))));

  const prior = createIncrementalRenderPlan(ir, "main").manifest;
  const changedAudio = structuredClone(ir), changedTrack = audioTrack(changedAudio);
  assert.ok(changedTrack.editorial.operationPlan?.version === 2);
  if (changedTrack.editorial.operationPlan?.version !== 2) return;
  changedTrack.editorial.operationPlan.operations[0].curve = "linear";
  changedTrack.editorial.transitions![0].curve = "linear";
  const incremental = createIncrementalRenderPlan(changedAudio, "main", prior);
  assert.equal(incremental.nodes.find((node) => node.id === changedTrack.id)?.status, "miss", "the audio transition edit must invalidate its audio-track cache entry");
  assert.ok(incremental.scenes.every((scene) => scene.status === "hit"), "processed audio transition edits must not invalidate picture-scene cache entries");
});

test("a touching middle region keeps one warm processor state across both envelopes and gates it after the expanded interval", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-middle-state-"));
  try {
    await writeFile(resolve(root, "silence.wav"), monoPcm16Wave(48_000, Array.from({ length: 1_920 }, () => 0)));
    await writeFile(resolve(root, "steady.wav"), monoPcm16Wave(48_000, Array.from({ length: 1_920 }, () => 12_000)));
    const source = `cut 0.4;
project "touching processed middle state";
import { AudioTrack, AudioRegion, audioCrossfadeAt } from "@cut/edit";
import { AudioClip, HighPass } from "@cut/audio";
asset silence: AudioAsset = audio("silence.wav");
asset steady: AudioAsset = audio("steady.wav");
timeline main(duration: 60ms, fps: 50, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 60ms, edits: [
    audioCrossfadeAt(at: 20ms, duration: 20ms, curve: "linear"),
    audioCrossfadeAt(at: 40ms, duration: 20ms, curve: "linear")
  ]) {
    AudioRegion(destination: 0ms ..< 20ms, tailHandle: 10ms) {
      AudioClip(source: silence, range: 10ms ..< 30ms);
    }
    AudioRegion(destination: 20ms ..< 40ms, headHandle: 10ms, tailHandle: 10ms) {
      HighPass(frequency: 1000hz) { AudioClip(source: steady, range: 10ms ..< 30ms); }
    }
    AudioRegion(destination: 40ms ..< 60ms, headHandle: 10ms) {
      AudioClip(source: silence, range: 10ms ..< 30ms);
    }
  }
}
export out = render(main);`;
    const ir = compile(source), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const output = resolve(root, "middle-state.wav");
    await renderReferenceAudio(ir, ir.compositions[0], root, output);
    const pcm = pcm24(await readFile(output));
    const entering = Math.abs(pcm.sample(486));
    const secondEnvelopeStart = Math.abs(pcm.sample(1_440));
    assert.ok(entering > 0.0001, `the expanded head must warm the stateful processor before the visible region: ${entering}`);
    assert.ok(secondEnvelopeStart < 0.0001, `the touching outgoing envelope restarted middle-region processor state: ${secondEnvelopeStart}`);
    assert.equal(pcm.sample(2_400), 0, "middle-region processor output leaked past its expanded half-open gate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mixed 44.1 kHz handles are processed before a linear envelope on the 48 kHz composition clock", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-region-crossfade-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(44_100, [
      ...Array.from({ length: 1_323 }, () => 16_384),
      ...Array.from({ length: 1_323 }, () => -16_384),
    ]));
    const source = `cut 0.4;
project "processed 44.1 crossfade";
import { AudioTrack, AudioRegion, audioCrossfadeAt } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 25, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 40ms, edits: [audioCrossfadeAt(at: 20ms, duration: 20ms, curve: "linear")]) {
    AudioRegion(destination: 0ms ..< 20ms, tailHandle: 10ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 0ms ..< 20ms); } }
    AudioRegion(destination: 20ms ..< 40ms, headHandle: 10ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 30ms ..< 50ms); } }
  }
}
export out = render(main);`;
    const ir = compile(source), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir), output = resolve(root, "processed.wav");
    await renderReferenceAudio(ir, composition, root, output);
    const pcm = pcm24(await readFile(output));
    assert.equal(pcm.frames, 1_920);
    assert.ok(pcm.sample(100) > .15 && pcm.sample(100) < .20, `static -6 dB processor did not execute before transition: ${pcm.sample(100)}`);
    assert.ok(Math.abs(pcm.sample(960)) < .03, `linear midpoint should mix opposing processed handles near zero: ${pcm.sample(960)}`);
    assert.ok(pcm.sample(1_800) < -.15 && pcm.sample(1_800) > -.20, `incoming processed region did not own post-overlap samples: ${pcm.sample(1_800)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Bus stem matches the single processed-crossfade master without bypassing or double-rendering processors", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-crossfade-stem-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48_000, [
      ...Array.from({ length: 1_440 }, () => 12_000),
      ...Array.from({ length: 1_440 }, () => -12_000),
    ]));
    const source = `cut 0.4;
project "processed transition stem";
import { AudioTrack, AudioRegion, audioCrossfadeAt } from "@cut/edit";
import { AudioClip, Bus, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 25, sampleRate: 48khz) {
  Bus(name: "dialogue") { AudioTrack(sourceDuration: 40ms, edits: [audioCrossfadeAt(at: 20ms, duration: 20ms, curve: "linear")]) {
    AudioRegion(destination: 0ms ..< 20ms, tailHandle: 10ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 0ms ..< 20ms); } }
    AudioRegion(destination: 20ms ..< 40ms, headHandle: 10ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 30ms ..< 50ms); } }
  } }
}
export out = render(main);`;
    const ir = compile(source), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const masterPath = resolve(root, "master.wav");
    await renderReferenceAudio(ir, ir.compositions[0], root, masterPath);
    const stems = await renderReferenceAudioStems(ir, ir.compositions[0], root, resolve(root, "stems"));
    assert.deepEqual(stems.manifest.stems.map((stem) => stem.name), ["dialogue"]);
    const master = pcm24(await readFile(masterPath)), samples = pcm24(await readFile(resolve(stems.directory, "dialogue.wav")));
    assert.equal(samples.frames, master.frames);
    for (let frame = 0; frame < samples.frames; frame += 1) for (let channel = 0; channel < 2; channel += 1) {
      assert.ok(
        Math.abs(samples.sample(frame, channel) - master.sample(frame, channel)) <= 1 / 0x800000,
        `stem/master processed PCM differs by more than one final s24 quantization LSB at ${frame}:${channel}`,
      );
    }
    assert.ok(samples.sample(100) > .10 && samples.sample(100) < .15, `stem bypassed or doubled -6 dB processing: ${samples.sample(100)}`);
    assert.ok(Math.abs(samples.sample(960)) < .03, `stem lost the processed transition envelope: ${samples.sample(960)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batched post-await authorization builds and renders a 128-region processed transition graph", { timeout: 60_000 }, async () => {
  const count = 128, samplesPerRegion = 4, totalSamples = count * samplesPerRegion;
  const operations = Array.from({ length: count - 1 }, (_, index) => `audioCrossfadeAt(at: seconds(${(index + 1) * samplesPerRegion} / 48000), duration: seconds(2 / 48000))`).join(",\n    ");
  const regions = Array.from({ length: count }, (_, index) => {
    const destinationStart = index * samplesPerRegion, destinationEnd = destinationStart + samplesPerRegion;
    const sourceStart = destinationStart + 1, sourceEnd = sourceStart + samplesPerRegion;
    return `AudioRegion(destination: seconds(${destinationStart} / 48000) ..< seconds(${destinationEnd} / 48000)${index > 0 ? ", headHandle: seconds(1 / 48000)" : ""}${index + 1 < count ? ", tailHandle: seconds(1 / 48000)" : ""}) {
      AudioClip(source: voice, range: seconds(${sourceStart} / 48000) ..< seconds(${sourceEnd} / 48000));
    }`;
  }).join("\n    ");
  const source = `cut 0.4;
project "many processed regions";
import { AudioTrack, AudioRegion, audioCrossfadeAt } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: seconds(${totalSamples} / 48000), fps: 25, sampleRate: 48khz) {
  AudioTrack(sourceDuration: seconds(${totalSamples} / 48000), edits: [${operations}]) { ${regions} }
}
export out = render(main);`;
  const root = await mkdtemp(resolve(tmpdir(), "cut-many-region-crossfade-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48_000, Array.from({ length: totalSamples + 2 }, () => 4_000)));
    const ir = compile(source), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const output = resolve(root, "many.wav"), build = await renderReferenceAudio(ir, ir.compositions[0], root, output);
    assert.equal(audioTrack(ir).editorial.operationPlan?.version, 2);
    assert.ok(build.filters > count, "actual graph construction must instantiate the region gates and source paths");
    assert.equal(pcm24(await readFile(output)).frames, totalSamples);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
