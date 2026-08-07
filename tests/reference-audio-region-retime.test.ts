import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { referenceAudioNodeConfig } from "../lib/runtime/reference/audio-config";
import { ReferenceAudioRegionError } from "../lib/runtime/reference/audio-region";
import { renderReferenceAudioStems } from "./reference-stem-test-helper";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function node(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(result, `missing ${op}`);
  return result;
}

function track(ir: CutAVIR) {
  const result = node(ir, "cut.edit.audio_track");
  assert.ok(result.editorial?.kind === "audio-track");
  return result as IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> };
}

function regionProgram(sourceDuration = "400ms", destinationDuration = "200ms", pitch = 0, chain?: (leaf: string) => string) {
  const leaf = `AudioClip(source: voice, range: 0ms ..< ${sourceDuration});`;
  const stretch = `TimeStretch(sourceDuration: ${sourceDuration}, duration: ${destinationDuration}, pitch: ${pitch}, quality: "draft") { ${leaf} }`;
  return `cut 0.4;
project "track integrated retime";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: ${destinationDuration}, fps: 25, sampleRate: 48khz) {
  AudioTrack() { AudioRegion(destination: 0ms ..< ${destinationDuration}) { ${chain ? chain(stretch) : stretch} } }
}
export out = render(main);`;
}

function fakeLock(ir: CutAVIR, sampleRate = 48_000, duration = rational(2)) {
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "a".repeat(64);
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

function compileDiagnostic(source: string) {
  try { compile(source); }
  catch (error) {
    assert.ok(error instanceof CutCompileError);
    return error.result.diagnostics[0];
  }
  assert.fail("expected compilation failure");
}

function monoSineWave(sampleRate: number, durationSeconds: number, frequency = 440, amplitude = 12_000) {
  const samples = Math.round(sampleRate * durationSeconds), dataBytes = samples * 2, buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude), 44 + index * 2);
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

function dominantFrequency(pcm: ReturnType<typeof pcm24>, start: number, end: number, minimum = 200, maximum = 1_200) {
  let bestFrequency = minimum, bestPower = -Infinity;
  for (let frequency = minimum; frequency <= maximum; frequency += 1) {
    const omega = 2 * Math.PI * frequency / 48_000, coefficient = 2 * Math.cos(omega);
    let previous = 0, previousTwo = 0;
    for (let frame = start; frame < end; frame += 1) {
      const current = pcm.sample(frame) + coefficient * previous - previousTwo;
      previousTwo = previous; previous = current;
    }
    const power = previousTwo ** 2 + previous ** 2 - coefficient * previous * previousTwo;
    if (power > bestPower) { bestPower = power; bestFrequency = frequency; }
  }
  return bestFrequency;
}

test("AudioRegion owns one typed TimeStretch whose exact source duration may differ from destination", () => {
  const ir = compile(regionProgram()), audioTrack = track(ir), region = node(ir, "cut.edit.audio_region"), stretch = node(ir, "cut.audio.time_stretch");
  assert.equal(audioTrack.editorial.items[0].source?.duration.numerator, "2");
  assert.equal(audioTrack.editorial.items[0].source?.duration.denominator, "5");
  assert.equal(audioTrack.editorial.items[0].destination.duration.numerator, "1");
  assert.equal(audioTrack.editorial.items[0].destination.duration.denominator, "5");
  assert.equal(region.children[0], stretch.id);
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
  const locked = fakeLock(structuredClone(ir), 44_100);
  assert.doesNotThrow(() => validateReferenceSession(locked));
  const config = referenceAudioNodeConfig(locked, locked.compositions[0], locked.nodes[stretch.id]);
  assert.equal(config?.kind, "time-stretch");
  if (config?.kind === "time-stretch") {
    assert.equal(config.audioRegionId, region.id);
    assert.equal(config.sourceSamples, 19_200);
    assert.equal(config.destinationSamples, 9_600);
  }
});

test("AudioRegion retime fails source-located for mismatches, handles, automation, nested retime, and AudioTrack edits", () => {
  const mismatch = regionProgram().replace("sourceDuration: 400ms, duration", "sourceDuration: 300ms, duration");
  assert.equal(compileDiagnostic(mismatch).code, "CUT_AUDIO_REGION_RETIME_PLAN");
  const handled = regionProgram().replace("destination: 0ms ..< 200ms", "destination: 0ms ..< 200ms, tailHandle: 10ms");
  assert.equal(compileDiagnostic(handled).code, "CUT_AUDIO_REGION_RETIME_TOPOLOGY");
  const automated = regionProgram("400ms", "200ms", 0, (stretch) => `Gain(amount: -6db) as level { ${stretch} } at 100ms { set level.amount = -3db; }`);
  assert.equal(compileDiagnostic(automated).code, "CUT_AUDIO_REGION_RETIME_AUTOMATION");
  const nested = regionProgram("400ms", "200ms", 0, (stretch) => `TimeStretch(sourceDuration: 200ms, duration: 200ms, pitch: 1, quality: "draft") { ${stretch} }`);
  assert.equal(compileDiagnostic(nested).code, "CUT_AUDIO_REGION_RETIME_TOPOLOGY");
  const edited = regionProgram().replace(
    "import { AudioTrack, AudioRegion }",
    "import { AudioTrack, AudioRegion, audioSplit }",
  ).replace("AudioTrack()", "AudioTrack(sourceDuration: 200ms, edits: [audioSplit(at: 100ms)])");
  assert.equal(compileDiagnostic(edited).code, "CUT_AUDIO_REGION_RETIME_PLAN");
});

test("strict loader and runtime recompute AudioRegion retime identity, source bounds, and forbidden topology", () => {
  const encoded = compile(regionProgram()), hostile = structuredClone(encoded), stretch = node(hostile, "cut.audio.time_stretch");
  stretch.inputs.duration = { kind: "quantity", dimension: "time", magnitude: rational(1, 10), unit: "s" };
  assert.throws(() => validateCutAvIr(JSON.parse(JSON.stringify(hostile))), (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_IDENTITY");

  const runtime = fakeLock(structuredClone(encoded)), runtimeTrack = track(runtime);
  runtimeTrack.editorial.items[0].sourceNodeId = node(runtime, "cut.audio.time_stretch").id;
  assert.throws(() => validateReferenceSession(runtime), /CUT_EDIT_AUDIO_REGION: audio-track sourceNodeId must identify the exact AudioClip descendant/);

  const handled = fakeLock(structuredClone(encoded));
  node(handled, "cut.edit.audio_region").inputs.headHandle = { kind: "quantity", dimension: "time", magnitude: rational(1, 100), unit: "s" };
  assert.throws(() => validateReferenceSession(handled), (error: unknown) => error instanceof ReferenceAudioRegionError && error.code === "CUT_AUDIO_REGION_RETIME_TOPOLOGY");

  const outOfBounds = fakeLock(structuredClone(encoded), 48_000, rational(3, 10));
  assert.throws(() => validateReferenceSession(outOfBounds), /source range ends after the locked/);
});

test("real mixed-rate AudioRegion speed-up, slow-down, and pitch execute CUT-owned DSP with exact destination samples", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-region-retime-pcm-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoSineWave(44_100, 0.5, 440, 3_000));
    const render = async (source: string, name: string) => {
      const ir = compile(source), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
      const output = resolve(root, name); await renderReferenceAudio(ir, ir.compositions[0], root, output);
      return pcm24(await readFile(output));
    };
    const faster = await render(regionProgram("400ms", "200ms"), "faster.wav");
    const slower = await render(regionProgram("200ms", "400ms"), "slower.wav");
    const pitched = await render(regionProgram("300ms", "300ms", 12), "pitched.wav");
    assert.equal(faster.frames, 9_600, "speed-up must not be truncated when its source extends beyond the authored composition duration");
    assert.equal(slower.frames, 19_200);
    assert.equal(pitched.frames, 14_400);
    assert.ok(Math.abs(dominantFrequency(faster, 2_400, 7_200) - 440) <= 5);
    assert.ok(Math.abs(dominantFrequency(slower, 4_800, 14_400) - 440) <= 5);
    assert.ok(Math.abs(dominantFrequency(pitched, 2_400, 12_000) - 880) <= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processor order around region TimeStretch is executable, distinct, and tail-gated", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-region-retime-order-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoSineWave(48_000, 0.4, 440, 500));
    const render = async (chain: (stretch: string) => string, name: string) => {
      const ir = compile(regionProgram("300ms", "200ms", 5, chain)), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
      const output = resolve(root, name); await renderReferenceAudio(ir, ir.compositions[0], root, output);
      return { ir, bytes: await readFile(output) };
    };
    const outside = await render((stretch) => `HighPass(frequency: 1000hz) { ${stretch} }`, "outside.wav");
    const inside = await render((stretch) => stretch.replace("{ AudioClip", "{ HighPass(frequency: 1000hz) { AudioClip").replace("; }", "; } }"), "inside.wav");
    assert.notDeepEqual(outside.bytes, inside.bytes, "moving a stateful processor across the retime boundary must change executed PCM");
    assert.ok(diffCutAVIR(outside.ir, inside.ir).changes.some((change) => change.entity === "node"));
    assert.equal(pcm24(outside.bytes).frames, 9_600);
    assert.equal(pcm24(inside.bytes).frames, 9_600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("region retime survives stems, reauthorizes a warm artifact, and exposes inspect/diff/OTIO/picture locality", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-region-retime-boundaries-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoSineWave(48_000, 0.5, 440, 2_000));
    const source = `cut 0.4;
project "region retime boundaries";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Bus, Gain, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 200ms, fps: 25, sampleRate: 48khz) {
  Bus(name: "dialogue") { AudioTrack() {
    AudioRegion(destination: 0ms ..< 200ms) {
      Gain(amount: -24db) {
        TimeStretch(sourceDuration: 300ms, duration: 200ms, pitch: 3, quality: "draft") {
          AudioClip(source: voice, range: 0ms ..< 300ms);
        }
      }
    }
  } }
}
export out = render(main);`;
    const ir = compile(source), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
    const cold = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
    assert.equal(cold.cache.status, "miss");
    const warm = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
    assert.equal(warm.cache.status, "hit");
    const cacheEntries = (await readdir(resolve(root, ".cut/cache/reference/audio"), { recursive: true })).sort();
    const hostile = structuredClone(ir); track(hostile).editorial.items[0].sourceNodeId = node(hostile, "cut.audio.time_stretch").id;
    await assert.rejects(renderReferenceAudioArtifact(hostile, hostile.compositions[0], root), /CUT_EDIT_AUDIO_REGION/);
    assert.deepEqual((await readdir(resolve(root, ".cut/cache/reference/audio"), { recursive: true })).sort(), cacheEntries);

    const stems = await renderReferenceAudioStems(ir, ir.compositions[0], root, resolve(root, "stems"));
    assert.deepEqual(stems.manifest.stems.map((stem) => stem.name), ["dialogue"]);
    assert.equal(pcm24(await readFile(resolve(stems.directory, "dialogue.wav"))).frames, 9_600);

    const inspected = inspectCutIr(ir, "") as unknown as { graph: { nodes: Array<{ audioRegionRetime?: { nodeId: string } }> } };
    assert.equal(inspected.graph.nodes.find((entry) => entry.audioRegionRetime)?.audioRegionRetime?.nodeId, node(ir, "cut.audio.time_stretch").id);
    assert.ok(exportCutTimelineToOtio(ir).report.unsupportedSemantics.some((issue) => issue.code === "CUT_OTIO_AUDIO_REGION_RETIME_UNSUPPORTED"));

    const pictureSource = `cut 0.4;
project "region retime picture locality";
import { Sequence, PictureTrack, PictureClip, AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, TimeStretch } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 200ms, fps: 25, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 200ms) {
    Sequence(duration: 200ms) { PictureTrack() {
      PictureClip(source: picture, range: 0ms ..< 200ms, duration: 200ms);
    } }
    AudioTrack() { AudioRegion(destination: 0ms ..< 200ms) {
      TimeStretch(sourceDuration: 300ms, duration: 200ms, pitch: 3, quality: "draft") {
        AudioClip(source: voice, range: 0ms ..< 300ms);
      }
    } }
  }
}
export out = render(main);`;
    const pictureIr = compile(pictureSource);
    const before = createIncrementalRenderPlan(pictureIr, "main").manifest, changed = structuredClone(pictureIr), changedStretch = node(changed, "cut.audio.time_stretch");
    changedStretch.inputs.pitch = { kind: "quantity", dimension: "scalar", magnitude: rational(4), unit: "scalar" };
    const incremental = createIncrementalRenderPlan(changed, "main", before);
    assert.equal(incremental.nodes.find((entry) => entry.id === changedStretch.id)?.status, "miss");
    assert.ok(incremental.scenes.every((scene) => scene.status === "hit"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
