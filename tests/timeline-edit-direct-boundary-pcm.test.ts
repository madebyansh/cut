import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import {
  referenceMasterAudioRootIds,
  renderReferenceAudioSelection,
} from "../lib/runtime/reference/audio";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";

const sampleRate = 48_000;
const frameBytes = 2 * 4;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function monoPcm16Wave(samples: readonly number[]) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((value, index) => buffer.writeInt16LE(value, 44 + index * 2));
  return buffer;
}

function fixtureWave() {
  return monoPcm16Wave(Array.from({ length: 80 * 48 }, (_, index) =>
    4_000 + Math.floor(index / 48) * 100));
}

function boundaryProgram(at: "16ms" | "24ms") {
  return `cut 0.4;
project "direct faded external edit boundary ${at}";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editBoundary
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 10ms ..< 30ms,
        destination: 0ms ..< 20ms,
        headHandle: 10ms,
        tailHandle: 10ms,
        fadeIn: 2ms,
        editId: "left"
      );
      AudioClip(
        source: voice,
        range: 30ms ..< 50ms,
        destination: 20ms ..< 40ms,
        headHandle: 10ms,
        tailHandle: 10ms,
        fadeOut: 2ms,
        editId: "right"
      );
    }
    TimelineEdit(id: "boundary-${at}", operations: [
      editBoundary(
        selection: editSelection(
          trackIds: ["dialogue"],
          originIds: ["left", "right"]
        ),
        at: avTime(audio: ${at})
      )
    ]);
  }
}
export out = render(main);`;
}

function explicitControlProgram(at: "16ms" | "24ms") {
  const leftEnd = at === "16ms" ? "26ms" : "34ms";
  const rightStart = at === "16ms" ? "26ms" : "34ms";
  return `cut 0.4;
project "independent direct boundary control ${at}";
import { AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 10ms ..< ${leftEnd},
        destination: 0ms ..< ${at},
        fadeIn: 2ms
      );
      AudioClip(
        source: voice,
        range: ${rightStart} ..< 50ms,
        destination: ${at} ..< 40ms,
        fadeOut: 2ms
      );
    }
  }
}
export out = render(main);`;
}

async function lockAndRender(source: string, root: string) {
  const ir = compile(source);
  await writeFile(resolve(root, "voice.wav"), fixtureWave());
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const artifact = await renderReferenceAudioArtifact(ir, ir.compositions[0]!, root);
  return { ir, artifact, pcm: await readFile(artifact.path) };
}

function audioItems(ir: CutAVIR) {
  const track = Object.values(ir.nodes).find((node) =>
    node.editorial?.kind === "audio-track");
  assert.ok(track?.editorial?.kind === "audio-track");
  return track.editorial.items.filter((item) => item.kind === "audio");
}

function sampleAt(pcm: Buffer, milliseconds: number) {
  const frame = milliseconds * 48;
  return pcm.readFloatLE(frame * frameBytes);
}

test("faded direct exact-1x editBoundary executes external head and tail handles as exact decoded PCM", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-boundary-pcm-"));
  const keys: string[] = [];
  try {
    for (const at of ["16ms", "24ms"] as const) {
      const actualRoot = resolve(root, `actual-${at}`);
      const controlRoot = resolve(root, `control-${at}`);
      await Promise.all([mkdir(actualRoot), mkdir(controlRoot)]);

      const actual = await lockAndRender(boundaryProgram(at), actualRoot);
      const control = await lockAndRender(explicitControlProgram(at), controlRoot);
      const replay = await renderReferenceAudioArtifact(
        actual.ir,
        actual.ir.compositions[0]!,
        actualRoot,
      );

      assert.equal(actual.artifact.cache.status, "miss");
      assert.equal(replay.cache.status, "hit");
      assert.equal(replay.cache.key, actual.artifact.cache.key);
      assert.deepEqual(await readFile(replay.path), actual.pcm);
      assert.deepEqual(
        actual.pcm,
        control.pcm,
        `${at} boundary differs from independently authored exact source ranges`,
      );
      keys.push(actual.artifact.cache.key);

      const items = audioItems(actual.ir);
      assert.equal(items.length, 2);
      assert.deepEqual(items.map((item) => item.source), at === "16ms"
        ? [
            { start: rational(1, 100), duration: rational(2, 125) },
            { start: rational(13, 500), duration: rational(3, 125) },
          ]
        : [
            { start: rational(1, 100), duration: rational(3, 125) },
            { start: rational(17, 500), duration: rational(2, 125) },
          ]);

      const externalWitness = at === "16ms" ? 17 : 22;
      assert.notEqual(
        sampleAt(actual.pcm, externalWitness),
        0,
        `${at} did not execute its declared external handle`,
      );
      assert.ok(
        Math.abs(sampleAt(actual.pcm, 1)) < Math.abs(sampleAt(actual.pcm, 4)),
        `${at} lost its authored outer fade-in`,
      );
      assert.ok(
        Math.abs(sampleAt(actual.pcm, 39)) < Math.abs(sampleAt(actual.pcm, 36)),
        `${at} lost its authored outer fade-out`,
      );
    }
    assert.notEqual(keys[0], keys[1], "distinct boundary clocks collided in the PCM cache");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hostile direct boundary envelope policy fails before cache or caller output publication", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-boundary-hostile-"));
  try {
    const ir = compile(boundaryProgram("16ms"));
    await writeFile(resolve(root, "voice.wav"), fixtureWave());
    const lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const origin = Object.values(ir.nodes).find((node): node is IRNode =>
      node.op === "cut.edit.timeline_audio_origin"
      && node.inputs.evaluationPolicy !== undefined);
    assert.ok(origin);
    origin.inputs.evaluationPolicy = {
      kind: "string",
      value: "full-declared-handle-domain-v1",
    };
    finalizeGraphHashes(ir);

    const output = resolve(root, "caller-owned.f32le");
    const sentinel = Buffer.from("caller-owned-sentinel", "utf8");
    await writeFile(output, sentinel);
    const before = (await readdir(root, { recursive: true })).sort();

    await assert.rejects(
      renderReferenceAudioSelection(
        ir,
        ir.compositions[0]!,
        root,
        output,
        referenceMasterAudioRootIds(ir, ir.compositions[0]!),
        { outputFormat: "raw-stereo-f32le" },
      ),
      /CUT_TIMELINE_EDIT_RESULT|CUT_TIMELINE_EDIT_UNSUPPORTED/u,
    );
    assert.deepEqual(await readFile(output), sentinel, "failed render clobbered caller-owned bytes");
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);

    await assert.rejects(
      renderReferenceAudioArtifact(ir, ir.compositions[0]!, root),
      /CUT_TIMELINE_EDIT_RESULT|CUT_TIMELINE_EDIT_UNSUPPORTED/u,
    );
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
