import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const sampleRate = 48_000;
const framesPerMillisecond = 48;
const stereoF32FrameBytes = 2 * 4;

type ProcessedOrigin = Readonly<{
  id: "left" | "middle" | "right";
  sourceStartMs: number;
  sourceEndMs: number;
  frequencyHz: number;
  gainDb: number;
}>;

const origins = Object.freeze({
  left: Object.freeze({
    id: "left",
    sourceStartMs: 10,
    sourceEndMs: 30,
    frequencyHz: 700,
    gainDb: -2,
  }),
  middle: Object.freeze({
    id: "middle",
    sourceStartMs: 30,
    sourceEndMs: 50,
    frequencyHz: 1_100,
    gainDb: -4,
  }),
  right: Object.freeze({
    id: "right",
    sourceStartMs: 50,
    sourceEndMs: 70,
    frequencyHz: 1_600,
    gainDb: -6,
  }),
} satisfies Record<"left" | "middle" | "right", ProcessedOrigin>);

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
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function fixtureSamples() {
  return Array.from({ length: 120 * framesPerMillisecond }, (_, index) => {
    const first = Math.sin(index / 7) * 8_000;
    const second = Math.cos(index / 19) * 3_000;
    const step = (Math.floor(index / framesPerMillisecond) % 9) * 170;
    return Math.max(-30_000, Math.min(30_000, Math.round(first + second + step)));
  });
}

async function renderLockedSource(source: string, root: string) {
  await mkdir(root, { recursive: true });
  const ir = compile(source);
  await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(fixtureSamples()));
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const artifact = await renderReferenceAudioArtifact(ir, ir.compositions[0]!, root);
  return { ir, pcm: await readFile(artifact.path) };
}

function processor(origin: ProcessedOrigin, sourceRange: string) {
  return `Gain(amount: ${origin.gainDb}db) {
          HighPass(frequency: ${origin.frequencyHz}hz) {
            AudioClip(source: voice, range: ${sourceRange});
          }
        }`;
}

function handledRegion(origin: ProcessedOrigin, destination: string) {
  return `AudioRegion(
        destination: ${destination},
        headHandle: 10ms,
        tailHandle: 10ms,
        editId: "${origin.id}",
        role: "dialogue"
      ) {
        ${processor(origin, `${origin.sourceStartMs}ms ..< ${origin.sourceEndMs}ms`)}
      }`;
}

function fullDomainControlProgram(origin: ProcessedOrigin) {
  const start = origin.sourceStartMs - 10;
  const end = origin.sourceEndMs + 10;
  return `cut 0.4;
project "processed external ${origin.id} full-domain control";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 40ms,
        editId: "${origin.id}-control",
        role: "dialogue"
      ) {
        ${processor(origin, `${start}ms ..< ${end}ms`)}
      }
    }
  }
}
export out = render(main);`;
}

function authoredDomainControlProgram(origin: ProcessedOrigin) {
  return `cut 0.4;
project "processed external ${origin.id} authored-domain control";
import { AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 20ms,
        editId: "${origin.id}-authored-control",
        role: "dialogue"
      ) {
        ${processor(origin, `${origin.sourceStartMs}ms ..< ${origin.sourceEndMs}ms`)}
      }
    }
  }
}
export out = render(main);`;
}

function slideProgram(direction: "left" | "right") {
  const by = direction === "right" ? "4ms" : "-4ms";
  return `cut 0.4;
project "processed exact-1x external slide ${direction}";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSlide
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 60ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 60ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      ${handledRegion(origins.left, "0ms ..< 20ms")}
      ${handledRegion(origins.middle, "20ms ..< 40ms")}
      ${handledRegion(origins.right, "40ms ..< 60ms")}
    }
    TimelineEdit(id: "processed-slide-${direction}", operations: [
      editSlide(
        selection: editSelection(
          trackIds: ["dialogue"],
          originIds: ["middle"],
          allowUnlinked: true
        ),
        range: 20ms ..< 40ms,
        by: avTime(audio: ${by})
      )
    ]);
  }
}
export out = render(main);`;
}

function boundaryProgram(direction: "left" | "right") {
  const at = direction === "right" ? "24ms" : "16ms";
  return `cut 0.4;
project "processed exact-1x external boundary ${direction}";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editBoundary
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 40ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 40ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      ${handledRegion(origins.left, "0ms ..< 20ms")}
      ${handledRegion(origins.right, "20ms ..< 40ms")}
    }
    TimelineEdit(id: "processed-boundary-${direction}", operations: [
      editBoundary(
        selection: editSelection(
          trackIds: ["dialogue"],
          originIds: ["left", "right"],
          allowUnlinked: true
        ),
        at: avTime(audio: ${at})
      )
    ]);
  }
}
export out = render(main);`;
}

function sliceMilliseconds(pcm: Buffer, start: number, end: number) {
  assert.ok(Number.isInteger(start) && Number.isInteger(end) && end > start);
  const startByte = start * framesPerMillisecond * stereoF32FrameBytes;
  const endByte = end * framesPerMillisecond * stereoF32FrameBytes;
  assert.ok(endByte <= pcm.length);
  return pcm.subarray(startByte, endByte);
}

function externalProcessedOrigins(ir: CutAVIR) {
  return Object.values(ir.nodes).filter((node): node is IRNode =>
    node.op === "cut.edit.timeline_audio_origin"
    && node.inputs.originKind?.kind === "string"
    && node.inputs.originKind.value === "processed-audio"
    && node.inputs.evaluationSource !== undefined);
}

function assertOneFullDomainExternalOrigin(ir: CutAVIR) {
  const external = externalProcessedOrigins(ir);
  assert.equal(external.length, 1);
  assert.deepEqual(external[0]!.inputs.evaluationPolicy, {
    kind: "string",
    value: "full-declared-handle-domain-v1",
  });
}

async function renderControls(root: string, selected: readonly ProcessedOrigin[]) {
  const full = new Map<ProcessedOrigin["id"], Buffer>();
  const authored = new Map<ProcessedOrigin["id"], Buffer>();
  for (const origin of selected) {
    const fullRendered = await renderLockedSource(
      fullDomainControlProgram(origin),
      resolve(root, `control-full-${origin.id}`),
    );
    const authoredRendered = await renderLockedSource(
      authoredDomainControlProgram(origin),
      resolve(root, `control-authored-${origin.id}`),
    );
    full.set(origin.id, fullRendered.pcm);
    authored.set(origin.id, authoredRendered.pcm);
  }
  return { full, authored };
}

test("processed exact-1x editSlide executes external handles in both directions from one full-domain static-chain origin", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-external-slide-"));
  try {
    const controls = await renderControls(root, [origins.left, origins.middle, origins.right]);
    for (const direction of ["right", "left"] as const) {
      const actual = await renderLockedSource(
        slideProgram(direction),
        resolve(root, `${direction}-actual`),
      );
      const repeat = await renderLockedSource(
        slideProgram(direction),
        resolve(root, `${direction}-repeat`),
      );
      assertOneFullDomainExternalOrigin(actual.ir);
      assert.deepEqual(actual.pcm, repeat.pcm, `${direction} slide is not deterministic`);

      const expected = direction === "right"
        ? Buffer.concat([
            sliceMilliseconds(controls.full.get("left")!, 10, 34),
            controls.authored.get("middle")!,
            sliceMilliseconds(controls.authored.get("right")!, 4, 20),
          ])
        : Buffer.concat([
            sliceMilliseconds(controls.authored.get("left")!, 0, 16),
            controls.authored.get("middle")!,
            sliceMilliseconds(controls.full.get("right")!, 6, 30),
          ]);
      assert.deepEqual(
        actual.pcm,
        expected,
        `${direction} slide differs from separately evaluated full-domain static-chain controls`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed exact-1x editBoundary executes external handles in both directions from one full-domain static-chain origin", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-external-boundary-"));
  try {
    const controls = await renderControls(root, [origins.left, origins.right]);
    for (const direction of ["right", "left"] as const) {
      const actual = await renderLockedSource(
        boundaryProgram(direction),
        resolve(root, `${direction}-actual`),
      );
      const repeat = await renderLockedSource(
        boundaryProgram(direction),
        resolve(root, `${direction}-repeat`),
      );
      assertOneFullDomainExternalOrigin(actual.ir);
      assert.deepEqual(actual.pcm, repeat.pcm, `${direction} boundary is not deterministic`);

      const expected = direction === "right"
        ? Buffer.concat([
            sliceMilliseconds(controls.full.get("left")!, 10, 34),
            sliceMilliseconds(controls.authored.get("right")!, 4, 20),
          ])
        : Buffer.concat([
            sliceMilliseconds(controls.authored.get("left")!, 0, 16),
            sliceMilliseconds(controls.full.get("right")!, 6, 30),
          ]);
      assert.deepEqual(
        actual.pcm,
        expected,
        `${direction} boundary differs from separately evaluated full-domain static-chain controls`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
