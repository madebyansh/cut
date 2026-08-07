import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRComposition } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { referenceMasterAudioRootIds, renderReferenceAudio } from "../lib/runtime/reference/audio";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
  renderReferenceAudioArtifact,
} from "../lib/runtime/reference/audio-cache";
import { defaultReferenceMasteringTarget, deriveReferenceMasteringTarget } from "../lib/runtime/reference/mastering";

const sampleRate = 48_000;
const blockAlign = 6;

function source(instance: string, picture = "#ef233c", processor = true) {
  const audio = processor
    ? "Compressor(threshold: -36db, ratio: 12, attack: 80ms, release: 200ms, makeup: 0db) { Tone(frequency: 100hz, duration: 400ms, amplitude: 80%); }"
    : "Tone(frequency: 100hz, duration: 400ms, amplitude: 80%);";
  return `cut 0.4;
project "ranged nested audio proof";
import { NestedSequence } from "@cut/edit";
import { Compressor, Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: 600ms, fps: 20, width: 32px, height: 24px, sampleRate: 48khz) {
  scene host(duration: 600ms) {
    Rect(width: 32px, height: 24px, fill: #050b10);
    at 100ms { ${instance} }
  }
}
timeline insert(duration: 400ms, fps: 20, width: 32px, height: 24px, sampleRate: 48khz) {
  ${audio}
  scene first(duration: 200ms) { Rect(width: 32px, height: 24px, fill: ${picture}); }
  scene second(duration: 200ms) { Rect(width: 32px, height: 24px, fill: #2667ff); }
}
export out = render(main, width: 32px, height: 24px, codec: "h264");`;
}

function restarted(processor = true) {
  const audio = processor
    ? "Compressor(threshold: -36db, ratio: 12, attack: 80ms, release: 200ms, makeup: 0db) { Tone(frequency: 100hz, duration: 200ms, amplitude: 80%); }"
    : "Tone(frequency: 100hz, duration: 200ms, amplitude: 80%);";
  return `cut 0.4;
project "processor restart counterexample";
import { Compressor, Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: 200ms, fps: 20, width: 32px, height: 24px, sampleRate: 48khz) {
  ${audio}
  scene only(duration: 200ms) { Rect(width: 32px, height: 24px, fill: #ffffff); }
}
export out = render(main, width: 32px, height: 24px, codec: "h264");`;
}

function silentSource() {
  return `cut 0.4;
project "ranged nested silence proof";
import { NestedSequence } from "@cut/edit";
import { Rect } from "cut:visual";
timeline main(duration: 600ms, fps: 20, width: 32px, height: 24px, sampleRate: 48khz) {
  scene host(duration: 600ms) {
    Rect(width: 32px, height: 24px, fill: #050b10);
    at 100ms { NestedSequence(source: insert, range: 100ms ..< 300ms); }
  }
}
timeline insert(duration: 400ms, fps: 20, width: 32px, height: 24px, sampleRate: 48khz) {
  scene first(duration: 200ms) { Rect(width: 32px, height: 24px, fill: #ef233c); }
  scene second(duration: 200ms) { Rect(width: 32px, height: 24px, fill: #2667ff); }
}
export out = render(main, width: 32px, height: 24px, codec: "h264");`;
}

function compile(text: string) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(checkCutModule(parsed.module).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function composition(ir: CutAVIR, id: "main" | "insert") {
  const result = ir.compositions.find((candidate) => candidate.id === id);
  assert.ok(result);
  return result;
}

function pcm24(buffer: Buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12, channels = 0, rate = 0, align = 0, bits = 0;
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2);
      rate = buffer.readUInt32LE(body + 4);
      align = buffer.readUInt16LE(body + 12);
      bits = buffer.readUInt16LE(body + 14);
    }
    if (id === "data") {
      data = buffer.subarray(body, body + size);
      break;
    }
    offset = body + size + (size % 2);
  }
  assert.deepEqual({ channels, rate, align, bits }, { channels: 2, rate: sampleRate, align: blockAlign, bits: 24 });
  const sample = (frame: number, channel: 0 | 1) => {
    const position = frame * blockAlign + channel * 3;
    let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000;
    return value;
  };
  return { data, frames: data.length / blockAlign, sample };
}

async function render(ir: CutAVIR, timeline: IRComposition, directory: string, name: string) {
  const output = resolve(directory, name);
  await renderReferenceAudio(ir, timeline, directory, output);
  return pcm24(await readFile(output));
}

function bytes(pcm: ReturnType<typeof pcm24>, start: number, end: number) {
  return pcm.data.subarray(start * blockAlign, end * blockAlign);
}

const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version ranged-nested-audio-test");

function cachePlan(ir: CutAVIR) {
  const main = composition(ir, "main");
  return createReferenceAudioCachePlan(ir, main, referenceMasterAudioRootIds(ir, main), toolchain);
}

test("ranged NestedSequence is the exact PCM slice of the causally evaluated source pre-master root mix", { timeout: 60_000 }, async () => {
  const ir = compile(source("NestedSequence(source: insert, range: 100ms ..< 300ms);"));
  const rawIr = compile(source("NestedSequence(source: insert, range: 100ms ..< 300ms);", "#ef233c", false));
  const restartIr = compile(restarted());
  const rawRestartIr = compile(restarted(false));
  const directory = await mkdtemp(resolve(tmpdir(), "cut-ranged-nested-audio-"));
  try {
    const sourceMix = await render(ir, composition(ir, "insert"), directory, "source.wav");
    const parentMix = await render(ir, composition(ir, "main"), directory, "parent.wav");
    const restartedMix = await render(restartIr, composition(restartIr, "main"), directory, "restarted.wav");
    const rawSourceMix = await render(rawIr, composition(rawIr, "insert"), directory, "raw-source.wav");
    const rawRestartedMix = await render(rawRestartIr, composition(rawRestartIr, "main"), directory, "raw-restarted.wav");
    const sourceStart = 4_800, sourceEnd = 14_400, destinationStart = 4_800, destinationEnd = 14_400;

    assert.equal(sourceMix.frames, 19_200);
    assert.equal(parentMix.frames, 28_800);
    assert.deepEqual(bytes(parentMix, destinationStart, destinationEnd), bytes(sourceMix, sourceStart, sourceEnd));
    assert.ok(bytes(parentMix, 0, destinationStart).every((value) => value === 0));
    assert.ok(bytes(parentMix, destinationEnd, parentMix.frames).every((value) => value === 0));

    assert.deepEqual(bytes(rawSourceMix, sourceStart, sourceEnd), bytes(rawRestartedMix, 0, rawRestartedMix.frames), "the 100 Hz excitation itself restarts at the same phase");
    assert.notDeepEqual(bytes(sourceMix, sourceStart, sourceEnd), bytes(restartedMix, 0, restartedMix.frames), "a ranged NestedSequence must not restart compressor state at its source boundary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("equal-duration shifted source ranges produce distinct PCM and an actual localized audio-cache miss", { timeout: 60_000 }, async () => {
  const first = compile(source("NestedSequence(source: insert, range: 0ms ..< 200ms);"));
  const shifted = compile(source("NestedSequence(source: insert, range: 200ms ..< 400ms);"));
  const pictureOnly = compile(source("NestedSequence(source: insert, range: 0ms ..< 200ms);", "#24a148"));
  assert.notEqual(cachePlan(first).key, cachePlan(shifted).key, "canonical source range must participate in audio execution identity");
  assert.equal(cachePlan(first).key, cachePlan(pictureOnly).key, "source picture-only edits remain outside the nested pre-master identity");

  const directory = await mkdtemp(resolve(tmpdir(), "cut-ranged-nested-cache-"));
  try {
    const firstArtifact = await renderReferenceAudioArtifact(first, composition(first, "main"), directory);
    const shiftedArtifact = await renderReferenceAudioArtifact(shifted, composition(shifted, "main"), directory);
    assert.equal(firstArtifact.cache.status, "miss");
    assert.equal(shiftedArtifact.cache.status, "miss");
    assert.equal(shiftedArtifact.cache.reason, "CUT_AUDIO_CACHE_KEY_CHANGED");
    assert.notEqual(firstArtifact.cache.key, shiftedArtifact.cache.key);
    const firstRaw = await readFile(firstArtifact.path);
    const shiftedRaw = await readFile(shiftedArtifact.path);
    assert.equal(firstRaw.length, 28_800 * 8);
    assert.equal(shiftedRaw.length, 28_800 * 8);
    assert.notDeepEqual(firstRaw, shiftedRaw);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("omitted range remains bit-compatible and cache-compatible with an explicit complete source range", { timeout: 60_000 }, async () => {
  const implicit = compile(source("NestedSequence(source: insert);"));
  const explicit = compile(source("NestedSequence(source: insert, range: 0ms ..< 400ms);"));
  assert.equal(cachePlan(implicit).key, cachePlan(explicit).key);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-full-nested-audio-"));
  try {
    const implicitMix = await render(implicit, composition(implicit, "main"), directory, "implicit.wav");
    const explicitMix = await render(explicit, composition(explicit, "main"), directory, "explicit.wav");
    assert.equal(implicitMix.frames, 28_800);
    assert.deepEqual(implicitMix.data, explicitMix.data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a nested source Meter remains source-local and does not recursively master the parent", () => {
  const ir = compile(`cut 0.4;
project "nested pre-master policy";
import { NestedSequence } from "@cut/edit";
import { Meter, Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene host(duration: 1s) { NestedSequence(source: insert); }
}
timeline insert(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  Meter(target: -20lufs, truePeak: -3dbtp, range: 5) { Tone(frequency: 440hz, duration: 1s, amplitude: 5%); }
  scene picture(duration: 1s) { Rect(width: 8px, height: 8px, fill: #ef233c); }
}
export out = render(main);`);
  assert.deepEqual(deriveReferenceMasteringTarget(ir, composition(ir, "insert")), {
    integratedLufs: -20,
    truePeakDbtp: -3,
    samplePeakDbfs: 0,
    loudnessRangeLu: 5,
  });
  assert.deepEqual(deriveReferenceMasteringTarget(ir, composition(ir, "main")), defaultReferenceMasteringTarget);
});

test("an audio-empty ranged source produces exact parent-length silence at and around selected boundaries", { timeout: 60_000 }, async () => {
  const ir = compile(silentSource());
  const directory = await mkdtemp(resolve(tmpdir(), "cut-ranged-nested-silence-"));
  try {
    const rendered = await render(ir, composition(ir, "main"), directory, "silence.wav");
    assert.equal(rendered.frames, 28_800);
    for (const frame of [0, 4_799, 4_800, 4_801, 14_398, 14_399, 14_400, 28_799]) {
      assert.equal(rendered.sample(frame, 0), 0, `left sample ${frame}`);
      assert.equal(rendered.sample(frame, 1), 0, `right sample ${frame}`);
    }
    assert.ok(rendered.data.every((value) => value === 0));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
