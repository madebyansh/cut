import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { renderReferenceAudio, renderReferenceAudioSelection, referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity, renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { ReferenceAudioConfigError } from "../lib/runtime/reference/audio-config";
import { renderReferenceAudioStems } from "./reference-stem-test-helper";
import { ReferencePictureEditorialError, validateReferenceSession } from "../lib/runtime/reference/validate";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";

function parsed(source: string) {
  const result = parseCutLanguage(source);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function source(item: string) {
  return `cut 0.4;
project "processed audio region";
import { AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
import { AudioClip, Compressor, DeEsser, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 25, sampleRate: 48khz) {
  AudioTrack() {
    ${item}
    AudioGap(destination: 1s ..< 2s);
  }
}
export out = render(main);`;
}

function compile(value: string) {
  return compileCutModule(parsed(value)).ir;
}

function fakeLock(ir: CutAVIR) {
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = resource.kind === "audio" ? {
      lockVersion: 2,
      bytes: 1,
      probe: {
        kind: "media",
        identity: {
          format: "cut-media-probe",
          version: 1,
          streams: [{
            index: 0,
            type: "audio",
            codec: "pcm_s16le",
            disposition: [],
            sampleRate: 48_000,
            channels: 1,
            timeBase: rational(1, 48_000),
            duration: rational(10),
          }],
        },
        selected: { audio: { streamIndex: 0, duration: rational(10), durationSource: "stream", timeBase: rational(1, 48_000) } },
      },
    } as never : {
      lockVersion: 2,
      bytes: 1,
      probe: {
        kind: "media",
        identity: {
          format: "cut-media-probe",
          version: 1,
          streams: [{
            index: 0,
            type: "video",
            codec: "rawvideo",
            disposition: [],
            width: 1920,
            height: 1080,
            frameRate: rational(25),
            timeBase: rational(1, 25),
            start: rational(0),
            duration: rational(10),
          }],
        },
        selected: {
          video: {
            streamIndex: 0,
            start: rational(0),
            duration: rational(10),
            durationSource: "decoded-video-cadence",
            timeBase: rational(1, 25),
            decodedVideoCadence: {
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
              recordsSha256: "a".repeat(64),
              timeBase: rational(1, 25),
              frameRate: rational(25),
            },
          },
        },
      },
    } as never;
  }
  ir.determinism.semantic = "locked";
  return ir;
}

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function pcm24Data(buffer: Buffer) {
  let offset = 12, blockAlign = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { blockAlign = buffer.readUInt16LE(body + 12); assert.equal(buffer.readUInt16LE(body + 14), 24); }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.equal(blockAlign, 6);
  return {
    frames: data.length / blockAlign,
    sample(frame: number, channel = 0) {
      const position = frame * blockAlign + channel * 3;
      let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

test("AudioRegion is a real typed AudioTrack item whose region owns destination and leaf owns source", () => {
  const program = parsed(source(`
    AudioRegion(destination: 0s ..< 1s) {
      Gain(amount: -3db) {
        HighPass(frequency: 80hz) {
          DeEsser(intensity: 0.3, amount: 0.4) {
            Compressor(threshold: -18db, ratio: 3) {
              AudioClip(source: voice, range: 4s ..< 5s, fadeIn: 10ms, fadeOut: 20ms);
            }
          }
        }
      }
    }`));
  const checked = checkCutModule(program);
  assert.deepEqual(checked.diagnostics, []);
  const ir = compileCutModule(program).ir;
  const track = Object.values(ir.nodes).find((node) => node.op === "cut.edit.audio_track");
  const region = Object.values(ir.nodes).find((node) => node.op === "cut.edit.audio_region");
  const leaf = Object.values(ir.nodes).find((node) => node.op === "cut.audio.clip");
  assert.ok(track?.editorial?.kind === "audio-track");
  assert.ok(region && leaf);
  if (track.editorial?.kind !== "audio-track" || !region || !leaf) return;
  assert.deepEqual(track.children, [region.id, track.children[1]]);
  assert.equal(track.editorial.items[0]?.nodeId, region.id);
  assert.equal(track.editorial.items[0]?.sourceNodeId, leaf.id);
  assert.deepEqual(region.interval, { start: { numerator: "0", denominator: "1" }, duration: { numerator: "1", denominator: "1" } });
  assert.deepEqual(leaf.interval, region.interval);
  assert.equal(region.inputs.destination?.kind, "range");
  assert.equal(leaf.inputs.destination, undefined);
  assert.equal(leaf.inputs.link, undefined);
});

test("AudioRegion closes nested leaf placement and requires one supported boundary-contained chain", () => {
  const diagnostics = (item: string) => checkCutModule(parsed(source(item))).diagnostics;
  assert.ok(diagnostics(`AudioRegion(destination: 0s ..< 1s) {
    AudioClip(source: voice, range: 4s ..< 5s, destination: 0s ..< 1s);
  }`).some((item) => item.code === "CUT_AUDIO_REGION_SHAPE" && /destination/.test(item.message)));
  assert.ok(diagnostics(`AudioRegion(destination: 0s ..< 1s) {
    AudioClip(source: voice, range: 4s ..< 5s, link: "take");
  }`).some((item) => item.code === "CUT_AUDIO_REGION_SHAPE" && /link/.test(item.message)));
  assert.ok(diagnostics(`AudioRegion(destination: 0s ..< 1s) {
    AudioClip(source: voice, range: 4s ..< 5s);
    AudioClip(source: voice, range: 5s ..< 6s);
  }`).some((item) => item.code === "CUT_AUDIO_REGION_SHAPE"));
  assert.ok(diagnostics(`AudioRegion(destination: 0s ..< 1s) {
    Compressor() {
      AudioClip(source: voice, range: 4s ..< 5s);
      AudioClip(source: voice, range: 5s ..< 6s);
    }
  }`).some((item) => item.code === "CUT_AUDIO_REGION_SHAPE"));
  assert.ok(diagnostics(`AudioRegion(destination: 0s ..< 1s) {
    AudioClip(source: voice, range: 4s ..< 5s, headHandle: 100ms);
  }`).some((item) => item.code === "CUT_AUDIO_REGION_SHAPE" && /handles/.test(item.message)));
  assert.ok(checkCutModule(parsed(source(`AudioRegion(destination: 0s ..< 1s) {
    Gain(amount: -3db) { AudioClip(source: voice, range: 4s ..< 4500ms); }
  }`))).diagnostics.length === 0, "duration mismatch is an exact compiler semantic, not a syntax-only guess");
  assert.throws(
    () => compile(source(`AudioRegion(destination: 0s ..< 1s) {
      Gain(amount: -3db) { AudioClip(source: voice, range: 4s ..< 4500ms); }
    }`)),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === "CUT2075"),
  );
});

test("AudioRegion strict IR and runtime preflight close the region/source relationship", () => {
  const unlocked = compile(source(`AudioRegion(destination: 0s ..< 1s) {
    Gain(amount: -3db) { AudioClip(source: voice, range: 4s ..< 5s); }
  }`));
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(unlocked))));
  const valid = fakeLock(structuredClone(unlocked));
  assert.doesNotThrow(() => validateReferenceSession(valid));

  const track = Object.values(valid.nodes).find((node) => node.editorial?.kind === "audio-track");
  const region = Object.values(valid.nodes).find((node) => node.op === "cut.edit.audio_region");
  const leaf = Object.values(valid.nodes).find((node) => node.op === "cut.audio.clip");
  assert.ok(track?.editorial?.kind === "audio-track" && region && leaf);
  if (track?.editorial?.kind !== "audio-track" || !region || !leaf) return;

  const unknownField = structuredClone(unlocked);
  const unknownTrack = unknownField.nodes[track.id];
  assert.ok(unknownTrack.editorial?.kind === "audio-track");
  if (unknownTrack.editorial?.kind !== "audio-track") return;
  (unknownTrack.editorial.items[0] as unknown as Record<string, unknown>).hiddenProcessorGraph = leaf.id;
  assert.throws(
    () => validateCutAvIr(unknownField),
    (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD" && error.path.endsWith(".hiddenProcessorGraph"),
  );

  const wrongLeaf = structuredClone(valid);
  const wrongTrack = wrongLeaf.nodes[track.id];
  assert.ok(wrongTrack.editorial?.kind === "audio-track");
  if (wrongTrack.editorial?.kind !== "audio-track") return;
  wrongTrack.editorial.items[0].sourceNodeId = region.id;
  finalizeGraphHashes(wrongLeaf);
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(wrongLeaf))));
  assert.throws(
    () => validateReferenceSession(wrongLeaf),
    (error: unknown) => error instanceof ReferencePictureEditorialError && error.code === "CUT_EDIT_AUDIO_REGION" && /sourceNodeId/.test(error.message),
  );

  const forbiddenLeafPlacement = structuredClone(valid);
  forbiddenLeafPlacement.nodes[leaf.id].inputs.destination = region.inputs.destination!;
  assert.throws(
    () => validateReferenceSession(forbiddenLeafPlacement),
    (error: unknown) => error instanceof ReferencePictureEditorialError && error.code === "CUT_EDIT_AUDIO_REGION" && /AudioClip leaf.*destination/.test(error.message),
  );

  const wrongSourceEvidence = structuredClone(valid);
  const wrongSourceTrack = wrongSourceEvidence.nodes[track.id];
  assert.ok(wrongSourceTrack.editorial?.kind === "audio-track");
  if (wrongSourceTrack.editorial?.kind !== "audio-track") return;
  wrongSourceTrack.editorial.items[0].source = { start: rational(9, 2), duration: rational(1) };
  assert.throws(
    () => validateReferenceSession(wrongSourceEvidence),
    (error: unknown) => error instanceof ReferencePictureEditorialError && error.code === "CUT_EDIT_AUDIO_REGION" && /source metadata/.test(error.message),
  );

  const invalidFade = structuredClone(valid);
  invalidFade.nodes[leaf.id].inputs.fadeIn = { kind: "quantity", dimension: "time", magnitude: rational(2), unit: "s" };
  assert.throws(
    () => validateReferenceSession(invalidFade),
    (error: unknown) => error instanceof ReferenceAudioConfigError && error.code === "CUT_AUDIO_VALUE_RANGE" && /fadeIn \+ fadeOut/.test(error.message),
  );

  const wrongInsertInterval = structuredClone(valid);
  const insert = Object.values(wrongInsertInterval.nodes).find((node) => node.op === "cut.audio.gain");
  assert.ok(insert);
  insert.interval.duration = rational(1, 2);
  assert.throws(
    () => validateReferenceSession(wrongInsertInterval),
    (error: unknown) => error instanceof ReferencePictureEditorialError && error.code === "CUT_EDIT_AUDIO_REGION" && /share the exact AudioRegion interval and scene/.test(error.message),
  );

  const branching = structuredClone(valid);
  branching.nodes[region.id].children.push(leaf.id);
  assert.throws(
    () => validateReferenceSession(branching),
    (error: unknown) => error instanceof ReferencePictureEditorialError && error.code === "CUT_EDIT_AUDIO_REGION" && /exactly one direct/.test(error.message),
  );

  const sceneOwned = fakeLock(compile(`cut 0.4;
project "processed scene ownership";
import { AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 25, sampleRate: 48khz) { scene only(duration: 2s) {
  AudioTrack() {
    AudioRegion(destination: 0s ..< 1s) { Gain(amount: -3db) { AudioClip(source: voice, range: 0s ..< 1s); } }
    AudioGap(destination: 1s ..< 2s);
  }
} }
export out = render(main);`));
  const sceneInsert = Object.values(sceneOwned.nodes).find((node) => node.op === "cut.audio.gain");
  assert.ok(sceneInsert?.sceneId);
  delete sceneInsert.sceneId;
  assert.throws(
    () => validateReferenceSession(sceneOwned),
    (error: unknown) => error instanceof ReferencePictureEditorialError && error.code === "CUT_EDIT_AUDIO_REGION" && /share the exact AudioRegion interval and scene/.test(error.message),
  );
});

test("AudioRegion renders two independently processed takes with exact sample boundaries and dynamic automation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48_000, [
      ...Array.from({ length: 480 }, () => 16_384),
      ...Array.from({ length: 480 }, () => -16_384),
    ]));
    const program = `cut 0.4;
project "executed processed takes";
import { AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 30ms, fps: 25, sampleRate: 48khz) {
  AudioTrack() {
    AudioGap(destination: 0ms ..< 5ms);
    AudioRegion(destination: 5ms ..< 15ms) {
      Gain(amount: -18db) as takeOne { AudioClip(source: voice, range: 0ms ..< 10ms); }
      at 5ms { set takeOne.amount = 0db; }
    }
    AudioRegion(destination: 15ms ..< 25ms) {
      Gain(amount: 0db) { AudioClip(source: voice, range: 10ms ..< 20ms); }
    }
    AudioGap(destination: 25ms ..< 30ms);
  }
}
export out = render(main);`;
    const ir = compile(program), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const output = resolve(root, "processed-takes.wav");
    await renderReferenceAudio(ir, ir.compositions[0], root, output);
    const pcm = pcm24Data(await readFile(output));
    assert.equal(pcm.frames, 1_440);
    for (let frame = 0; frame < 240; frame += 1) assert.equal(pcm.sample(frame), 0, `leading AudioGap leaked at ${frame}`);
    for (let frame = 1_200; frame < 1_440; frame += 1) assert.equal(pcm.sample(frame), 0, `trailing AudioGap leaked at ${frame}`);
    const quiet = pcm.sample(288), automated = pcm.sample(576), secondTake = pcm.sample(816);
    assert.ok(quiet > 0.04 && quiet < 0.08, `first take pre-automation gain was not executed: ${quiet}`);
    assert.ok(automated > 0.34 && automated < 0.37, `first take dynamic gain did not switch at its region-local sample: ${automated}`);
    assert.ok(pcm.sample(479) > 0.04 && pcm.sample(479) < 0.08, "region-local set must not affect the sample immediately before its exact event");
    assert.ok(pcm.sample(480) > 0.34 && pcm.sample(480) < 0.37, "region-local set must affect the exact absolute composition sample of its event");
    assert.ok(secondTake < -0.34 && secondTake > -0.37, `second take did not decode its independent source range: ${secondTake}`);
    assert.equal(pcm.sample(239), 0);
    assert.ok(pcm.sample(240) > 0, "first processed take must begin at exact destination sample 240");
    assert.ok(pcm.sample(719) > 0, "first processed take must own the last sample before its half-open boundary");
    assert.ok(pcm.sample(720) < 0, "second processed take must begin at exact destination sample 720");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AudioRegion renders an exact common-grid 44.1 kHz source interval into a 48 kHz destination", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-resample-"));
  try {
    await writeFile(resolve(root, "source-44k1.wav"), monoPcm16Wave(44_100, Array.from({ length: 441 }, () => 8_192)));
    const ir = compile(`cut 0.4;
project "processed common-grid resample";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset source: AudioAsset = audio("source-44k1.wav");
timeline main(duration: 10ms, fps: 100, sampleRate: 48khz) {
  AudioTrack() {
    AudioRegion(destination: 0ms ..< 10ms) { Gain(amount: 0db) { AudioClip(source: source, range: 0ms ..< 10ms); } }
  }
}
export out = render(main);`);
    const lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
    const output = resolve(root, "resampled.wav");
    await renderReferenceAudio(ir, ir.compositions[0], root, output);
    const pcm = pcm24Data(await readFile(output));
    assert.equal(pcm.frames, 480, "10ms must remain exactly 480 destination samples after 44.1→48 kHz conversion");
    const middle = Math.abs(pcm.sample(240)), final = Math.abs(pcm.sample(479));
    assert.ok(middle > 0.17 && middle < 0.18, `the common-grid source selection must decode through the processed region; decoded ${middle}`);
    assert.ok(final > 0.05, `the exact final in-region sample must survive resampling and the outer gate; decoded ${final}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AudioRegion owns an exact outer sample gate that contains stateful filter tails", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-tail-"));
  try {
    const samples = Array.from({ length: 480 }, () => 0);
    samples[479] = 30_000;
    await writeFile(resolve(root, "impulse.wav"), monoPcm16Wave(48_000, samples));
    const common = `cut 0.4;
project "processed boundary sentinel";
import { AudioClip, HighPass } from "@cut/audio";
asset impulse: AudioAsset = audio("impulse.wav");`;
    const direct = compile(`${common}
timeline main(duration: 20ms, fps: 25, sampleRate: 48khz) {
  HighPass(frequency: 1khz) { AudioClip(source: impulse, range: 0ms ..< 10ms); }
}
export out = render(main);`);
    const region = compile(`${common}
import { AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
timeline main(duration: 20ms, fps: 25, sampleRate: 48khz) {
  AudioTrack() {
    AudioRegion(destination: 0ms ..< 10ms) { HighPass(frequency: 1khz) { AudioClip(source: impulse, range: 0ms ..< 10ms); } }
    AudioGap(destination: 10ms ..< 20ms);
  }
}
export out = render(main);`);
    for (const [ir, name] of [[direct, "direct.wav"], [region, "region.wav"]] as const) {
      const lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
      assert.doesNotThrow(() => validateReferenceSession(ir));
      await renderReferenceAudio(ir, ir.compositions[0], root, resolve(root, name));
    }
    const directPcm = pcm24Data(await readFile(resolve(root, "direct.wav")));
    const regionPcm = pcm24Data(await readFile(resolve(root, "region.wav")));
    const directTail = Array.from({ length: 64 }, (_, index) => Math.abs(directPcm.sample(480 + index)));
    assert.ok(Math.max(...directTail) > 0.00001, "sentinel must prove the stateful HighPass would ring beyond the source leaf");
    for (let frame = 480; frame < 960; frame += 1) assert.equal(regionPcm.sample(frame), 0, `processed region leaked a filter tail at sample ${frame}`);
    assert.ok(Math.abs(regionPcm.sample(479)) > 0.01, "outer gate must preserve the last in-region processed sample");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AudioRegion executes inserts innermost-to-outermost and keeps adjacent processor state independent", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-order-"));
  try {
    await writeFile(resolve(root, "steady.wav"), monoPcm16Wave(48_000, Array.from({ length: 3_840 }, () => 8_192)));
    const ordered = (body: string) => `cut 0.4;
project "processed order";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Compressor, Gain } from "@cut/audio";
asset steady: AudioAsset = audio("steady.wav");
timeline main(duration: 80ms, fps: 25, sampleRate: 48khz) { AudioTrack() { AudioRegion(destination: 0ms ..< 80ms) { ${body} } } }
export out = render(main);`;
    const programs = [
      ordered("Gain(amount: 12db) { Compressor(threshold: -18db, ratio: 4, attack: 1ms, release: 20ms) { AudioClip(source: steady, range: 0ms ..< 80ms); } }"),
      ordered("Compressor(threshold: -18db, ratio: 4, attack: 1ms, release: 20ms) { Gain(amount: 12db) { AudioClip(source: steady, range: 0ms ..< 80ms); } }"),
    ];
    const orderPcm = [];
    for (const [index, program] of programs.entries()) {
      const ir = compile(program), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
      const output = resolve(root, `order-${index}.wav`); await renderReferenceAudio(ir, ir.compositions[0], root, output); orderPcm.push(pcm24Data(await readFile(output)));
    }
    const lateA = Math.abs(orderPcm[0].sample(3_000)), lateB = Math.abs(orderPcm[1].sample(3_000));
    assert.ok(lateA > lateB + 0.05, `authored inner Compressor then outer Gain must be louder than inner Gain then outer Compressor: ${lateA} vs ${lateB}`);
    assert.ok(lateA > 0.3 && lateA < 1, `inner Compressor then outer Gain produced an implausible settled sample: ${lateA}`);
    assert.ok(lateB > 0.05 && lateB < 0.5, `inner Gain then outer Compressor produced an implausible settled sample: ${lateB}`);

    const repeated = Array.from({ length: 480 }, (_, index) => index === 0 ? 30_000 : index < 120 ? 4_000 : 0);
    await writeFile(resolve(root, "repeated.wav"), monoPcm16Wave(48_000, [...repeated, ...repeated]));
    const stateProgram = `cut 0.4;
project "independent processed state";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, HighPass } from "@cut/audio";
asset repeated: AudioAsset = audio("repeated.wav");
timeline main(duration: 20ms, fps: 25, sampleRate: 48khz) { AudioTrack() {
  AudioRegion(destination: 0ms ..< 10ms) { HighPass(frequency: 1khz) { AudioClip(source: repeated, range: 0ms ..< 10ms); } }
  AudioRegion(destination: 10ms ..< 20ms) { HighPass(frequency: 1khz) { AudioClip(source: repeated, range: 10ms ..< 20ms); } }
} }
export out = render(main);`;
    const stateIr = compile(stateProgram), stateLock = await createCutLock(stateIr, root); await applyCutLock(stateIr, stateLock, root);
    const stateOutput = resolve(root, "state.wav"); await renderReferenceAudio(stateIr, stateIr.compositions[0], root, stateOutput);
    const state = pcm24Data(await readFile(stateOutput));
    for (let offset = 0; offset < 480; offset += 1) {
      assert.equal(state.sample(offset), state.sample(480 + offset), `adjacent AudioRegions shared processor history at relative sample ${offset}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AudioRegion refuses exact-end automation before a missing source path or output/cache allocation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-end-event-"));
  try {
    const program = `cut 0.4;
project "processed exact end event";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("missing-end-event.wav");
timeline main(duration: 1s, fps: 25, sampleRate: 48khz) { AudioTrack() { AudioRegion(destination: 0s ..< 1s) {
  Gain(amount: -6db) as level { AudioClip(source: voice, range: 0s ..< 1s); }
  at 1s { set level.amount = 0db; }
} } }
export out = render(main);`;
    const ir = fakeLock(compile(program)), output = resolve(root, "must-not-exist.wav"), roots = referenceMasterAudioRootIds(ir, ir.compositions[0]);
    await assert.rejects(renderReferenceAudio(ir, ir.compositions[0], root, output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_AUDIO_AUTOMATION_TIMING"));
    await assert.rejects(lstat(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-end-event-test");
    assert.throws(() => createReferenceAudioCachePlan(ir, ir.compositions[0], roots, identity), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_AUDIO_AUTOMATION_TIMING"));
    await assert.rejects(lstat(resolve(root, ".cut")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AudioRegion participates in manual A/V link pairing, refuses structural slicing, and accepts transition-only crossfades", () => {
  const linkedProgram = (transaction = "") => `cut 0.4;
project "linked processed take";
import { Sequence, PictureTrack, PictureClip, AudioTrack, AudioRegion, ${transaction ? `${transaction}, ` : ""}AudioGap } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 25, sampleRate: 48khz) {
  scene only(duration: 2s) {
    ${transaction === "LinkedTrim" ? 'LinkedTrim(link: "take", keep: 200ms ..< 800ms);' : transaction === "LinkedRippleDelete" ? 'LinkedRippleDelete(link: "take");' : ""}
    Sequence(duration: 2s) { PictureTrack() {
      PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "take");
      PictureClip(source: picture, range: 1s ..< 2s, duration: 1s);
    } }
    AudioTrack() {
      AudioRegion(destination: 0s ..< 1s, link: "take") {
        Gain(amount: -3db) { AudioClip(source: voice, range: 0s ..< 1s); }
      }
      AudioRegion(destination: 1s ..< 2s) {
        Gain(amount: 0db) { AudioClip(source: voice, range: 1s ..< 2s); }
      }
    }
  }
}
export out = render(main);`;
  const linked = fakeLock(compile(linkedProgram()));
  const track = Object.values(linked.nodes).find((node) => node.editorial?.kind === "audio-track");
  assert.ok(track?.editorial?.kind === "audio-track");
  if (track?.editorial?.kind !== "audio-track") return;
  assert.equal(track.editorial.items[0].linkId, "take");
  assert.ok(track.editorial.items[0].sourceNodeId);
  assert.doesNotThrow(() => validateReferenceSession(linked));

  for (const transaction of ["LinkedTrim", "LinkedRippleDelete"] as const) {
    assert.throws(
      () => compile(linkedProgram(transaction)),
      (error: unknown) => error instanceof CutCompileError
        && error.result.diagnostics.some((item) => item.code === (transaction === "LinkedTrim" ? "CUT_LINKED_TRIM_UNSUPPORTED" : "CUT_LINKED_RIPPLE_UNSUPPORTED") && /processed AudioRegion graphs/.test(item.message)),
      transaction,
    );
  }

  const editProgram = (edit: string) => `cut 0.4;
project "processed structural refusal";
import { AudioTrack, AudioRegion, AudioGap, audioSplit, audioCrossfadeAt } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 25, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 2s, edits: [${edit}]) {
    AudioRegion(destination: 0s ..< 1s, tailHandle: 50ms) { Gain(amount: -3db) { AudioClip(source: voice, range: 0s ..< 1s); } }
    AudioRegion(destination: 1s ..< 2s, headHandle: 50ms) { Gain(amount: 0db) { AudioClip(source: voice, range: 1s ..< 2s); } }
  }
}
export out = render(main);`;
  assert.throws(
    () => compile(editProgram("audioSplit(at: 500ms)")),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === "CUT_AUDIO_REGION_CROSSFADE_PLAN" && /transition-only/.test(item.message)),
  );
  const crossfaded = compile(editProgram('audioCrossfadeAt(at: 1s, duration: 100ms, curve: "linear")'));
  const crossfadedTrack = Object.values(crossfaded.nodes).find((node) => node.editorial?.kind === "audio-track");
  assert.equal(crossfadedTrack?.editorial?.kind === "audio-track" && crossfadedTrack.editorial.operationPlan?.version, 2);
});

test("AudioRegion processing, source, and placement are reachable audio-cache dependencies", () => {
  const program = (firstAmount: string, firstRange = "0s ..< 1s") => `cut 0.4;
project "processed take cache";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 25, sampleRate: 48khz) {
  AudioTrack() {
    AudioRegion(destination: 0s ..< 1s) { Gain(amount: ${firstAmount}) { AudioClip(source: voice, range: ${firstRange}); } }
    AudioRegion(destination: 1s ..< 2s) { Gain(amount: 0db) { AudioClip(source: voice, range: 1s ..< 2s); } }
  }
}
export out = render(main);`;
  const placementProgram = (start: "0ms" | "250ms") => `cut 0.4;
project "processed take placement cache";
import { AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 25, sampleRate: 48khz) {
  AudioTrack() {
    ${start === "250ms" ? "AudioGap(destination: 0ms ..< 250ms);" : ""}
    AudioRegion(destination: ${start} ..< ${start === "250ms" ? "750ms" : "500ms"}) { Gain(amount: -6db) { AudioClip(source: voice, range: 0ms ..< 500ms); } }
    AudioGap(destination: ${start === "250ms" ? "750ms" : "500ms"} ..< 1s);
    AudioRegion(destination: 1s ..< 2s) { Gain(amount: 0db) { AudioClip(source: voice, range: 1s ..< 2s); } }
  }
}
export out = render(main);`;
  const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-audio-region-test");
  const plan = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), identity);
  const baseline = plan(fakeLock(compile(program("-6db"))));
  const replay = plan(fakeLock(compile(program("-6db"))));
  const processing = plan(fakeLock(compile(program("-3db"))));
  const sourceRange = plan(fakeLock(compile(program("-6db", "2s ..< 3s"))));
  const placement = plan(fakeLock(compile(placementProgram("250ms"))));
  const placementBaseline = plan(fakeLock(compile(placementProgram("0ms"))));
  const detailProgram = (order: "gain-filter" | "filter-gain", fadeIn = "") => `cut 0.4;
project "processed take detail cache";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 1s, fps: 25, sampleRate: 48khz) { AudioTrack() {
  AudioRegion(destination: 0s ..< 1s) {
    ${order === "gain-filter"
      ? `Gain(amount: -6db) { HighPass(frequency: 80hz) { AudioClip(source: voice, range: 0s ..< 1s${fadeIn}); } }`
      : `HighPass(frequency: 80hz) { Gain(amount: -6db) { AudioClip(source: voice, range: 0s ..< 1s${fadeIn}); } }`}
  }
} }
export out = render(main);`;
  const detailBaseline = plan(fakeLock(compile(detailProgram("gain-filter"))));
  const fade = plan(fakeLock(compile(detailProgram("gain-filter", ", fadeIn: 10ms"))));
  const order = plan(fakeLock(compile(detailProgram("filter-gain"))));
  assert.equal(replay.key, baseline.key);
  assert.equal(replay.graph.sha256, baseline.graph.sha256);
  assert.notEqual(processing.key, baseline.key, "nested per-take processing must invalidate executable audio identity");
  assert.notEqual(processing.graph.nodesSha256, baseline.graph.nodesSha256);
  assert.notEqual(sourceRange.key, baseline.key, "the exact AudioClip source selection must invalidate executable audio identity");
  assert.notEqual(sourceRange.graph.nodesSha256, baseline.graph.nodesSha256);
  assert.notEqual(placement.key, placementBaseline.key, "a valid AudioRegion destination move must invalidate executable audio identity");
  assert.notEqual(placement.graph.nodesSha256, placementBaseline.graph.nodesSha256);
  assert.notEqual(fade.key, detailBaseline.key, "leaf fades must invalidate executable processed-region identity");
  assert.notEqual(fade.graph.nodesSha256, detailBaseline.graph.nodesSha256);
  assert.notEqual(order.key, detailBaseline.key, "processor order must invalidate executable processed-region identity");
  assert.notEqual(order.graph.nodesSha256, detailBaseline.graph.nodesSha256);
});

test("recognized static processor properties execute and cannot be laundered through a warm audio cache", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-static-property-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48_000, Array.from({ length: 960 }, () => 8_192)));
    const base = compile(`cut 0.4;
project "static property cache identity";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  AudioTrack() { AudioRegion(destination: 0ms ..< 20ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 0ms ..< 20ms); } } }
}
export out = render(main);`);
    const lock = await createCutLock(base, root); await applyCutLock(base, lock, root);
    const gain = Object.values(base.nodes).find((node) => node.op === "cut.audio.gain"); assert.ok(gain);
    if (!gain) return;
    const variant = (amount: number) => {
      const ir = structuredClone(base);
      ir.nodes[gain.id].properties.amount = { kind: "quantity", dimension: "gain", magnitude: rational(amount), unit: "db" };
      finalizeGraphHashes(ir);
      assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))), "strict IR must admit the recognized static property whose runtime/cache semantics are under test");
      return ir;
    };
    const louder = variant(-3), quieter = variant(-12), outputs = [resolve(root, "louder.wav"), resolve(root, "quieter.wav")];
    await renderReferenceAudio(louder, louder.compositions[0], root, outputs[0]);
    await renderReferenceAudio(quieter, quieter.compositions[0], root, outputs[1]);
    const louderSample = Math.abs(pcm24Data(await readFile(outputs[0])).sample(480));
    const quieterSample = Math.abs(pcm24Data(await readFile(outputs[1])).sample(480));
    assert.ok(louderSample > quieterSample * 2.5, `static Gain.properties.amount must execute observably: ${louderSample} vs ${quieterSample}`);

    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-static-property-test");
    const plan = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), identity);
    const louderPlan = plan(louder), quieterPlan = plan(quieter);
    assert.notEqual(louderPlan.key, quieterPlan.key, "executed static processor properties must change the audio cache key");
    assert.notEqual(louderPlan.graph.nodesSha256, quieterPlan.graph.nodesSha256);

    const first = await renderReferenceAudioArtifact(louder, louder.compositions[0], root);
    const replay = await renderReferenceAudioArtifact(louder, louder.compositions[0], root);
    const changed = await renderReferenceAudioArtifact(quieter, quieter.compositions[0], root);
    assert.equal(first.cache.status, "miss"); assert.equal(replay.cache.status, "hit");
    assert.equal(changed.cache.status, "miss"); assert.equal(changed.cache.reason, "CUT_AUDIO_CACHE_KEY_CHANGED");
    assert.notEqual(first.path, changed.path);
    assert.notDeepEqual(await readFile(first.path), await readFile(changed.path), "a warm static-property edit reused stale decoded samples");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a named Bus stem renders its processed AudioRegion rather than bypassing or flattening it", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-stem-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48_000, Array.from({ length: 960 }, () => 8_192)));
    const ir = compile(`cut 0.4;
project "processed region stem";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Bus, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  Bus(name: "dialogue") {
    AudioTrack() {
      AudioRegion(destination: 0ms ..< 20ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 0ms ..< 20ms); } }
    }
  }
}
export out = render(main);`);
    const lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
    const rendered = await renderReferenceAudioStems(ir, ir.compositions[0], root, resolve(root, "stems"));
    assert.deepEqual(rendered.manifest.stems.map((stem) => stem.name), ["dialogue"]);
    const stem = pcm24Data(await readFile(resolve(rendered.directory, "dialogue.wav")));
    assert.equal(stem.frames, 960);
    const settled = Math.abs(stem.sample(480));
    assert.ok(settled > 0.085 && settled < 0.092, `stem must contain the authored -6 dB processed take; decoded ${settled}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared reachable-audio authorization closes Bus ancestors and processed Track structural ownership at every entrypoint", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-ancestor-auth-"));
  try {
    const base = fakeLock(compile(`cut 0.4;
project "processed region ancestor authorization";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Bus, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("missing-ancestor.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  Bus(name: "dialogue") { AudioTrack() { AudioRegion(destination: 0ms ..< 20ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 0ms ..< 20ms); } } } }
}
export out = render(main);`));
    const bus = Object.values(base.nodes).find((node) => node.op === "cut.audio.bus"), track = Object.values(base.nodes).find((node) => node.op === "cut.edit.audio_track");
    assert.ok(bus && track); if (!bus || !track) return;
    const cases: Array<{ name: string; code: string; mutate(ir: CutAVIR): void }> = [
      { name: "unknown Bus input", code: "CUT_NODE_NOOP", mutate(ir) { ir.nodes[bus.id].inputs.hidden = { kind: "boolean", value: true }; } },
      { name: "unknown Bus property", code: "CUT_NODE_NOOP", mutate(ir) { ir.nodes[bus.id].properties.hidden = { kind: "boolean", value: true }; } },
      { name: "Bus editorial metadata", code: "CUT_AUDIO_GRAPH", mutate(ir) { ir.nodes[bus.id].editorial = { kind: "audio-track", items: [] }; } },
      { name: "detached root Bus", code: "CUT_AUDIO_GRAPH", mutate(ir) { ir.nodes[bus.id].ownership = "detached"; } },
      { name: "duplicate Track edge in one Bus", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[bus.id].children.push(track.id); } },
      { name: "two structural Bus parents", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) {
        const secondId = `${bus.id}-second-parent`, second = { ...structuredClone(ir.nodes[bus.id]), id: secondId, children: [track.id] };
        ir.nodes[secondId] = second; ir.compositions[0].rootAudioIds.push(secondId); ir.compositions[0].items.push({ kind: "node", id: secondId, domain: "audio" });
      } },
    ];
    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-ancestor-auth-test");
    for (const hostileCase of cases) {
      const ir = structuredClone(base); hostileCase.mutate(ir); finalizeGraphHashes(ir);
      const output = resolve(root, `${hostileCase.name.replaceAll(" ", "-")}.wav`);
      await assert.rejects(renderReferenceAudio(ir, ir.compositions[0], root, output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code), `${hostileCase.name} direct`);
      await assert.rejects(lstat(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
      assert.throws(() => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), identity), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code), `${hostileCase.name} cache plan`);
      await assert.rejects(renderReferenceAudioArtifact(ir, ir.compositions[0], root), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code), `${hostileCase.name} artifact`);
      await assert.rejects(lstat(resolve(root, ".cut")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", `${hostileCase.name} allocated cache state`);
      const stems = resolve(root, `${hostileCase.name.replaceAll(" ", "-")}-stems`);
      await assert.rejects(renderReferenceAudioStems(ir, ir.compositions[0], root, stems), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code), `${hostileCase.name} stems`);
      await assert.rejects(lstat(stems), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", `${hostileCase.name} allocated stem state`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AudioRegion private chains reject incoming node references while ordinary sibling sidechains remain valid", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-private-reference-"));
  try {
    const base = fakeLock(compile(`cut 0.4;
project "processed region private references";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Bus, Gain, Sidechain, Tone } from "@cut/audio";
asset voice: AudioAsset = audio("missing-private-reference.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  Bus(name: "dialogue") {
    Tone(frequency: 2khz, duration: 20ms, amplitude: 5%) as key;
    Sidechain(source: key, amount: -6db) {
      AudioTrack() { AudioRegion(destination: 0ms ..< 20ms) { Gain(amount: -3db) { AudioClip(source: voice, range: 0ms ..< 20ms); } } }
    }
  }
}
export out = render(main);`));
    const sidechain = Object.values(base.nodes).find((node) => node.op === "cut.audio.sidechain");
    const gain = Object.values(base.nodes).find((node) => node.op === "cut.audio.gain");
    assert.ok(sidechain && gain); if (!sidechain || !gain) return;
    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-private-region-reference-test");
    assert.doesNotThrow(
      () => createReferenceAudioCachePlan(base, base.compositions[0], referenceMasterAudioRootIds(base, base.compositions[0]), identity),
      "a normal sibling key reference must remain legal",
    );
    const bypass = resolve(root, "private-chain-bypass.wav");
    await assert.rejects(
      renderReferenceAudioSelection(base, base.compositions[0], root, bypass, [gain.id]),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_AUDIO_GRAPH"
        && "message" in error && typeof error.message === "string" && /preparation boundary/u.test(error.message)),
      "an arbitrary AudioRegion descendant must not masquerade as an internal preparation root",
    );
    await assert.rejects(lstat(bypass), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    const forged = structuredClone(base);
    forged.nodes[sidechain.id].inputs.source = { kind: "node-ref", id: gain.id };
    finalizeGraphHashes(forged);
    const loaded = validateCutAvIr(JSON.parse(JSON.stringify(forged)));
    const output = resolve(root, "private-reference.wav"), stems = resolve(root, "private-reference-stems");
    await assert.rejects(renderReferenceAudio(loaded, loaded.compositions[0], root, output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"));
    await assert.rejects(lstat(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    assert.throws(
      () => createReferenceAudioCachePlan(loaded, loaded.compositions[0], referenceMasterAudioRootIds(loaded, loaded.compositions[0]), identity),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"),
    );
    await assert.rejects(renderReferenceAudioArtifact(loaded, loaded.compositions[0], root), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"));
    await assert.rejects(lstat(resolve(root, ".cut")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    await assert.rejects(renderReferenceAudioStems(loaded, loaded.compositions[0], root, stems), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"));
    await assert.rejects(lstat(stems), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mixed processed tracks reconcile every direct AudioClip link across direct, cache, artifact, and stem boundaries", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-mixed-link-"));
  try {
    const base = fakeLock(compile(`cut 0.4;
project "processed region mixed direct links";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Bus, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("missing-mixed-link.wav");
timeline main(duration: 40ms, fps: 25, sampleRate: 48khz) {
  Bus(name: "dialogue") { AudioTrack() {
    AudioRegion(destination: 0ms ..< 20ms) { Gain(amount: -3db) { AudioClip(source: voice, range: 0ms ..< 20ms); } }
    AudioClip(source: voice, range: 20ms ..< 40ms, destination: 20ms ..< 40ms);
  } }
}
export out = render(main);`));
    const track = Object.values(base.nodes).find((node) => node.op === "cut.edit.audio_track");
    assert.ok(track?.editorial?.kind === "audio-track"); if (track?.editorial?.kind !== "audio-track") return;
    const directItem = track.editorial.items.find((item) => base.nodes[item.nodeId]?.op === "cut.audio.clip");
    assert.ok(directItem); if (!directItem) return;
    const directClipId = directItem.nodeId;
    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-mixed-region-link-test");
    const cases: Array<{ name: string; mutate(ir: CutAVIR): void }> = [
      { name: "item-only", mutate(ir) { const owner = ir.nodes[track.id]; if (owner.editorial?.kind === "audio-track") owner.editorial.items.find((item) => item.nodeId === directClipId)!.linkId = "take-a"; } },
      { name: "child-only", mutate(ir) { ir.nodes[directClipId].inputs.link = { kind: "string", value: "take-a" }; } },
      { name: "disagreement", mutate(ir) {
        ir.nodes[directClipId].inputs.link = { kind: "string", value: "take-b" };
        const owner = ir.nodes[track.id]; if (owner.editorial?.kind === "audio-track") owner.editorial.items.find((item) => item.nodeId === directClipId)!.linkId = "take-a";
      } },
      { name: "matching-out-of-bounds", mutate(ir) {
        const value = "x".repeat(129); ir.nodes[directClipId].inputs.link = { kind: "string", value };
        const owner = ir.nodes[track.id]; if (owner.editorial?.kind === "audio-track") owner.editorial.items.find((item) => item.nodeId === directClipId)!.linkId = value;
      } },
    ];
    for (const hostileCase of cases) {
      const forged = structuredClone(base); hostileCase.mutate(forged); finalizeGraphHashes(forged);
      const serialized = JSON.parse(JSON.stringify(forged));
      const loaded = hostileCase.name === "matching-out-of-bounds"
        ? forged
        : validateCutAvIr(serialized);
      if (hostileCase.name === "matching-out-of-bounds") {
        assert.throws(() => validateCutAvIr(serialized), (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_STRING");
      }
      const slug = hostileCase.name, output = resolve(root, `${slug}.wav`), stems = resolve(root, `${slug}-stems`);
      await assert.rejects(renderReferenceAudio(loaded, loaded.compositions[0], root, output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"), `${slug} direct`);
      await assert.rejects(lstat(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
      assert.throws(
        () => createReferenceAudioCachePlan(loaded, loaded.compositions[0], referenceMasterAudioRootIds(loaded, loaded.compositions[0]), identity),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"),
        `${slug} cache plan`,
      );
      await assert.rejects(renderReferenceAudioArtifact(loaded, loaded.compositions[0], root), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
        && (error.code === "CUT_EDIT_AUDIO_REGION" || error.code === "CUT_LINKED_TRIM_CARDINALITY")), `${slug} artifact`);
      await assert.rejects(lstat(resolve(root, ".cut")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
      await assert.rejects(renderReferenceAudioStems(loaded, loaded.compositions[0], root, stems), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"), `${slug} stems`);
      await assert.rejects(lstat(stems), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared AudioRegion traversal preserves typed source-located JSON diagnostics for nested composition cycles", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-nested-cycle-"));
  try {
    const ir = fakeLock(compile(`cut 0.4;
project "processed audio traversal cycle";
import { NestedSequence } from "@cut/edit";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 8khz) { scene host(duration: 1s) { NestedSequence(source: insert); } }
timeline insert(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 8khz) { scene picture(duration: 1s) { Rect(width: 8px, height: 8px); } }
export out = render(main);`));
    const main = ir.compositions.find((composition) => composition.id === "main")!;
    const nested = Object.values(ir.nodes).find((node) => node.op === "cut.edit.nested_sequence");
    assert.ok(nested); if (!nested) return;
    nested.inputs.source = { kind: "timeline-ref", id: main.id };
    const roots = referenceMasterAudioRootIds(ir, main), output = resolve(root, "cycle.wav");
    const directError = await renderReferenceAudio(ir, main, root, output).then(() => undefined, (error: unknown) => error);
    assert.ok(directError && typeof directError === "object" && "code" in directError && directError.code === "CUT_NESTED_CYCLE");
    await assert.rejects(lstat(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-nested-cycle-diagnostic-test");
    let cacheError: unknown;
    try { createReferenceAudioCachePlan(ir, main, roots, identity); } catch (error) { cacheError = error; }
    assert.ok(cacheError && typeof cacheError === "object" && "code" in cacheError && cacheError.code === "CUT_NESTED_CYCLE");
    for (const error of [directError, cacheError]) {
      const diagnostics = cutDiagnosticsFromError(error);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].code, "CUT_NESTED_CYCLE");
      assert.equal(diagnostics[0].source?.module, "project.cut");
      assert.ok((diagnostics[0].source?.line ?? 0) > 0 && (diagnostics[0].source?.column ?? 0) > 0);
      assert.equal(diagnostics[0].source?.nodeId, nested.id);
      assert.doesNotMatch(diagnostics[0].message, /^CUT_NESTED_CYCLE:/u);
      assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) < 2_048);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit audio root cannot execute or cache under a different supplied composition clock", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-root-owner-"));
  try {
    const ir = compile(`cut 0.4;
project "selected audio root ownership";
import { Tone } from "@cut/audio";
timeline first(duration: 20ms, fps: 50, sampleRate: 48khz) { Tone(frequency: 1khz, duration: 20ms); }
timeline second(duration: 40ms, fps: 25, sampleRate: 44.1khz) { Tone(frequency: 2khz, duration: 40ms); }
export out = render(first);`);
    const first = ir.compositions.find((item) => item.id === "first")!, second = ir.compositions.find((item) => item.id === "second")!;
    const foreignRoots = referenceMasterAudioRootIds(ir, second), output = resolve(root, "foreign.wav");
    assert.ok(foreignRoots.length > 0);
    await assert.rejects(renderReferenceAudioSelection(ir, first, root, output, foreignRoots), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_AUDIO_GRAPH"));
    await assert.rejects(lstat(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-foreign-root-test");
    assert.throws(() => createReferenceAudioCachePlan(ir, first, foreignRoots, identity), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_AUDIO_GRAPH"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("central AudioRegion authorization refuses forged loaded graphs before direct, cache, or stem materialization", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-hostile-"));
  try {
    const program = `cut 0.4;
project "hostile processed graph";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("missing-voice.wav");
timeline main(duration: 2s, fps: 25, sampleRate: 48khz) {
  scene first(duration: 1s) {
    AudioTrack() {
      AudioRegion(destination: 0s ..< 500ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 0s ..< 500ms); } }
      AudioRegion(destination: 500ms ..< 1s) { Gain(amount: 0db) { AudioClip(source: voice, range: 500ms ..< 1s); } }
    }
  }
  scene second(duration: 1s) {}
}
export out = render(main);`;
    const base = fakeLock(compile(program));
    const regions = Object.values(base.nodes).filter((node) => node.op === "cut.edit.audio_region");
    const gains = Object.values(base.nodes).filter((node) => node.op === "cut.audio.gain");
    const leaves = Object.values(base.nodes).filter((node) => node.op === "cut.audio.clip");
    const track = Object.values(base.nodes).find((node) => node.op === "cut.edit.audio_track");
    assert.equal(regions.length, 2); assert.equal(gains.length, 2); assert.equal(leaves.length, 2); assert.ok(track?.editorial?.kind === "audio-track");
    if (track?.editorial?.kind !== "audio-track") return;
    const firstScene = base.compositions[0].sceneIds[0], secondScene = base.compositions[0].sceneIds[1];
    const cases: Array<{ name: string; mutate(ir: CutAVIR): void; code: string; finalize?: boolean }> = [
      { name: "unsupported intentional-tail insert", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { const node = ir.nodes[gains[0].id]; node.op = "cut.audio.reverb"; node.inputs = { wet: { kind: "quantity", dimension: "ratio", magnitude: rational(1, 2), unit: "%" } }; } },
      { name: "cyclic insert graph", code: "CUT_EDIT_AUDIO_REGION", finalize: false, mutate(ir) { ir.nodes[gains[0].id].children = [gains[0].id]; } },
      { name: "insert depth above 32", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) {
        const template = structuredClone(ir.nodes[gains[0].id]), ids = Array.from({ length: 33 }, (_, index) => `${template.id}-depth-${index}`);
        for (let index = 0; index < ids.length; index += 1) {
          ir.nodes[ids[index]] = { ...structuredClone(template), id: ids[index], children: [ids[index + 1] ?? leaves[0].id] };
        }
        ir.nodes[regions[0].id].children = [ids[0]];
        delete ir.nodes[template.id];
      } },
      { name: "insert interval", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[gains[0].id].interval.start = rational(1, 10); } },
      { name: "insert scene", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[gains[0].id].sceneId = secondScene; } },
      { name: "leaf placement", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[leaves[0].id].inputs.link = { kind: "string", value: "forged" }; } },
      { name: "forged sourceNodeId", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.items[0].sourceNodeId = regions[0].id; } },
      { name: "shared descendant", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[regions[1].id].children = [gains[0].id]; const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.items[1].sourceNodeId = leaves[0].id; } },
      { name: "promoted descendant root", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.scenes[ir.nodes[gains[0].id].sceneId!].rootAudioIds.push(gains[0].id); } },
      { name: "unknown insert input", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[gains[0].id].inputs.hidden = { kind: "boolean", value: true }; } },
      { name: "unknown insert property", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[gains[0].id].properties.hidden = { kind: "boolean", value: true }; } },
      { name: "unknown track input", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[track.id].inputs.hidden = { kind: "boolean", value: true }; } },
      { name: "forged track sourceDuration operand", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[track.id].inputs.sourceDuration = { kind: "quantity", dimension: "time", magnitude: rational(1), unit: "s" }; } },
      { name: "forged track edits operand", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[track.id].inputs.edits = { kind: "array", items: [] }; } },
      { name: "missing track item", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.items.pop(); } },
      { name: "extra track item", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.items.push({ ...structuredClone(value.editorial.items[1]), order: 2 }); } },
      { name: "missing track child", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[track.id].children.pop(); } },
      { name: "duplicate track child", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[track.id].children.push(regions[1].id); } },
      { name: "uncovered track interval", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) {
        const region = ir.nodes[regions[1].id], gain = ir.nodes[gains[1].id], leaf = ir.nodes[leaves[1].id], value = ir.nodes[track.id];
        const start = rational(3, 4), duration = rational(1, 4), sourceStart = rational(1, 2), sourceEnd = rational(3, 4);
        const destination = { kind: "range" as const, start: { kind: "quantity" as const, dimension: "time", magnitude: start, unit: "s" }, end: { kind: "quantity" as const, dimension: "time", magnitude: rational(1), unit: "s" }, exclusive: true };
        region.interval = { start, duration }; gain.interval = { start, duration }; leaf.interval = { start, duration }; region.inputs.destination = destination;
        leaf.inputs.range = { kind: "range", start: { kind: "quantity", dimension: "time", magnitude: sourceStart, unit: "s" }, end: { kind: "quantity", dimension: "time", magnitude: sourceEnd, unit: "s" }, exclusive: true };
        if (value.editorial?.kind === "audio-track") { value.editorial.items[1].destination = { start, duration }; value.editorial.items[1].source = { start: sourceStart, duration }; }
      } },
      { name: "detached parent track", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[track.id].ownership = "detached"; } },
      { name: "reference parent track", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[track.id].ownership = "reference"; } },
      { name: "child parent track without structural owner", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[track.id].ownership = "child"; } },
      { name: "duplicate parent track root", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.scenes[firstScene].rootAudioIds.push(track.id); } },
      { name: "wrong-scene parent track root", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) {
        ir.scenes[firstScene].rootAudioIds = ir.scenes[firstScene].rootAudioIds.filter((id) => id !== track.id);
        ir.scenes[firstScene].items = ir.scenes[firstScene].items.filter((item) => item.id !== track.id);
        ir.scenes[secondScene].rootAudioIds.push(track.id); ir.scenes[secondScene].items.push({ id: track.id, domain: "audio" });
      } },
      { name: "item-only promoted insert", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.scenes[firstScene].items.push({ id: gains[0].id, domain: "audio" }); } },
      { name: "processor editorial metadata", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[gains[0].id].editorial = { kind: "audio-track", items: [] }; } },
      { name: "leaf editorial metadata", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[leaves[0].id].editorial = { kind: "audio-track", items: [] }; } },
      { name: "off-grid 44.1 kHz source against 48 kHz destination before missing locator", code: "CUT_AUDIO_SAMPLE_GRID", mutate(ir) {
        const resource = Object.values(ir.resources)[0], probe = resource.metadata?.probe as { identity: { streams: Array<{ type: string; sampleRate?: number }> } };
        const stream = probe.identity.streams.find((candidate) => candidate.type === "audio");
        if (stream) stream.sampleRate = 44_100;
        const start = rational(1, 48_000), end = rational(24_001, 48_000), range = {
          kind: "range" as const,
          start: { kind: "quantity" as const, dimension: "time", magnitude: start, unit: "s" },
          end: { kind: "quantity" as const, dimension: "time", magnitude: end, unit: "s" },
          exclusive: true,
        };
        ir.nodes[leaves[0].id].inputs.range = range;
        const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.items[0].source = { start, duration: rational(1, 2) };
      } },
      { name: "invalid processor config before missing locator", code: "CUT_AUDIO_VALUE_RANGE", mutate(ir) { ir.nodes[gains[0].id].inputs.amount = { kind: "quantity", dimension: "gain", magnitude: rational(100), unit: "db" }; } },
      { name: "invalid leaf fade before missing locator", code: "CUT_AUDIO_VALUE_RANGE", mutate(ir) { ir.nodes[leaves[0].id].inputs.fadeIn = { kind: "quantity", dimension: "time", magnitude: rational(1), unit: "s" }; } },
      { name: "forged processed operation plan", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.operationPlan = {} as never; } },
      { name: "forged processed transition plan", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.transitions = [{} as never]; } },
    ];
    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-hostile-region-test");
    for (const entry of [
      { name: "processor hidden input", rejectedByLoader: true, mutate(ir: CutAVIR) { ir.nodes[gains[0].id].inputs.hidden = { kind: "boolean", value: true }; } },
      { name: "track hidden input", rejectedByLoader: true, mutate(ir: CutAVIR) { ir.nodes[track.id].inputs.hidden = { kind: "boolean", value: true }; } },
      { name: "leaked sourceDuration compile operand", rejectedByLoader: false, mutate(ir: CutAVIR) { ir.nodes[track.id].inputs.sourceDuration = { kind: "quantity", dimension: "time", magnitude: rational(1), unit: "s" }; } },
      { name: "leaked edits compile operand", rejectedByLoader: false, mutate(ir: CutAVIR) { ir.nodes[track.id].inputs.edits = { kind: "array", items: [] }; } },
    ]) {
      const genericLoadedShape = structuredClone(base); entry.mutate(genericLoadedShape); finalizeGraphHashes(genericLoadedShape);
      const load = () => validateCutAvIr(JSON.parse(JSON.stringify(genericLoadedShape)));
      if (entry.rejectedByLoader) {
        assert.throws(
          load,
          (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD",
          `${entry.name} must fail the closed public loader`,
        );
      } else {
        // These names remain public compile-time AudioTrack operands in the
        // kernel registry. The loader type-checks their closed values, while
        // the executable AudioRegion boundary below proves they cannot leak
        // past lowering into a runnable graph.
        assert.doesNotThrow(load, `${entry.name} should reach the backend-specific leakage diagnostic`);
      }
    }
    for (const hostileCase of cases) {
      const ir = structuredClone(base); hostileCase.mutate(ir); if (hostileCase.finalize !== false) finalizeGraphHashes(ir);
      const output = resolve(root, `${hostileCase.name.replaceAll(" ", "-")}.wav`);
      await assert.rejects(
        renderReferenceAudio(ir, ir.compositions[0], root, output),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code),
        hostileCase.name,
      );
      await assert.rejects(lstat(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", `${hostileCase.name} created output before authorization`);
      assert.throws(
        () => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), identity),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code),
        `${hostileCase.name} cache plan`,
      );
    }

    for (const hostileCase of cases.filter((candidate) => candidate.name === "forged track sourceDuration operand" || candidate.name === "forged track edits operand")) {
      const ir = structuredClone(base); hostileCase.mutate(ir); finalizeGraphHashes(ir);
      await assert.rejects(renderReferenceAudioArtifact(ir, ir.compositions[0], root), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"), `${hostileCase.name} artifact`);
      await assert.rejects(lstat(resolve(root, ".cut")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", `${hostileCase.name} allocated cache state`);
      const destination = resolve(root, `${hostileCase.name.replaceAll(" ", "-")}-stems`);
      await assert.rejects(renderReferenceAudioStems(ir, ir.compositions[0], root, destination), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"), `${hostileCase.name} stems`);
      await assert.rejects(lstat(destination), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", `${hostileCase.name} allocated stem state`);
    }

    const artifactHostile = structuredClone(base);
    artifactHostile.nodes[leaves[0].id].inputs.destination = artifactHostile.nodes[regions[0].id].inputs.destination!;
    finalizeGraphHashes(artifactHostile);
    await assert.rejects(renderReferenceAudioArtifact(artifactHostile, artifactHostile.compositions[0], root), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"));
    await assert.rejects(lstat(resolve(root, ".cut")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", "hostile artifact created cache directories before authorization");

    const stemsDirectory = resolve(root, "hostile-stems");
    await assert.rejects(renderReferenceAudioStems(artifactHostile, artifactHostile.compositions[0], root, stemsDirectory), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"));
    await assert.rejects(lstat(stemsDirectory), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", "hostile stems created output directory before authorization");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a warm audio artifact cannot launder a forged AudioRegion graph", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-warm-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48_000, Array.from({ length: 960 }, () => 8_192)));
    const program = `cut 0.4;
project "warm processed artifact";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 25, sampleRate: 48khz) {
  AudioTrack() { AudioRegion(destination: 0ms ..< 20ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 0ms ..< 20ms); } } }
}
export out = render(main);`;
    const valid = compile(program), lock = await createCutLock(valid, root); await applyCutLock(valid, lock, root);
    const cold = await renderReferenceAudioArtifact(valid, valid.compositions[0], root);
    const cacheRoot = resolve(root, ".cut/cache/reference/audio"), before = (await readdir(cacheRoot)).sort(), bytes = await readFile(cold.path);
    const region = Object.values(valid.nodes).find((node) => node.op === "cut.edit.audio_region"), track = Object.values(valid.nodes).find((node) => node.editorial?.kind === "audio-track"), gain = Object.values(valid.nodes).find((node) => node.op === "cut.audio.gain");
    assert.ok(region && track?.editorial?.kind === "audio-track" && gain);
    if (!region || track?.editorial?.kind !== "audio-track" || !gain) return;
    const mutations: Array<{ name: string; mutate(ir: CutAVIR): void }> = [
      { name: "forged sourceNodeId", mutate(ir) { const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.items[0].sourceNodeId = region.id; } },
      { name: "leaked sourceDuration", mutate(ir) { ir.nodes[track.id].inputs.sourceDuration = { kind: "quantity", dimension: "time", magnitude: rational(20, 1_000), unit: "s" }; } },
      { name: "leaked edits", mutate(ir) { ir.nodes[track.id].inputs.edits = { kind: "array", items: [] }; } },
      { name: "missing item", mutate(ir) { const value = ir.nodes[track.id]; if (value.editorial?.kind === "audio-track") value.editorial.items.pop(); } },
      { name: "detached track", mutate(ir) { ir.nodes[track.id].ownership = "detached"; } },
      { name: "processor editorial", mutate(ir) { ir.nodes[gain.id].editorial = { kind: "audio-track", items: [] }; } },
    ];
    for (const mutation of mutations) {
      const hostile = structuredClone(valid); mutation.mutate(hostile); finalizeGraphHashes(hostile);
      await assert.rejects(renderReferenceAudioArtifact(hostile, hostile.compositions[0], root), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_EDIT_AUDIO_REGION"), mutation.name);
      assert.deepEqual((await readdir(cacheRoot)).sort(), before, `${mutation.name} changed the warm cache namespace`);
      assert.deepEqual(await readFile(cold.path), bytes, `${mutation.name} modified the authorized artifact`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested-sequence AudioRegions authorize on their source composition clock before parent render/cache work", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-region-nested-"));
  try {
    const program = `cut 0.4;
project "nested processed authorization";
import { NestedSequence, AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Bus, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("missing-nested.wav");
timeline main(duration: 40ms, fps: 25, width: 64px, height: 64px, sampleRate: 48khz) { scene host(duration: 40ms) { NestedSequence(source: insert); } }
timeline insert(duration: 40ms, fps: 25, width: 64px, height: 64px, sampleRate: 48khz) {
  scene insertScene(duration: 40ms) {
    Bus(name: "dialogue") { AudioTrack() { AudioRegion(destination: 0ms ..< 40ms) { Gain(amount: -6db) { AudioClip(source: voice, range: 0ms ..< 40ms); } } } }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
    const base = fakeLock(compile(program)), leaf = Object.values(base.nodes).find((node) => node.op === "cut.audio.clip"), bus = Object.values(base.nodes).find((node) => node.op === "cut.audio.bus");
    assert.ok(leaf && bus); if (!leaf || !bus) return;
    const identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-nested-region-test");
    const cases: Array<{ name: string; code: string; mutate(ir: CutAVIR): void }> = [
      { name: "nested region leaf placement", code: "CUT_EDIT_AUDIO_REGION", mutate(ir) { ir.nodes[leaf.id].inputs.destination = { kind: "range", start: { kind: "quantity", dimension: "time", magnitude: rational(0), unit: "s" }, end: { kind: "quantity", dimension: "time", magnitude: rational(1, 25), unit: "s" }, exclusive: true }; } },
      { name: "nested Bus unknown input", code: "CUT_NODE_NOOP", mutate(ir) { ir.nodes[bus.id].inputs.hidden = { kind: "boolean", value: true }; } },
    ];
    for (const hostileCase of cases) {
      const hostile = structuredClone(base); hostileCase.mutate(hostile); finalizeGraphHashes(hostile);
      const main = hostile.compositions.find((item) => item.id === "main")!, roots = referenceMasterAudioRootIds(hostile, main), output = resolve(root, `${hostileCase.name.replaceAll(" ", "-")}.wav`);
      await assert.rejects(renderReferenceAudio(hostile, main, root, output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code));
      await assert.rejects(lstat(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
      assert.throws(() => createReferenceAudioCachePlan(hostile, main, roots, identity), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code));
      await assert.rejects(renderReferenceAudioArtifact(hostile, main, root), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === hostileCase.code));
      await assert.rejects(lstat(resolve(root, ".cut")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
