import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
  collectReferenceAudioToolchainIdentity,
  readReferenceAudioSelectionFromCache,
  renderReferenceAudioArtifact,
} from "../lib/runtime/reference/audio-cache";
import { referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import { ReferenceAudioPeakError } from "../lib/runtime/reference/audio-peak";
import { runFfmpegCapture } from "../lib/runtime/reference/ffmpeg";
import { renderReferenceIr } from "./reference-render-test-helper";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function program(fill: string, target: number, sampleRate = 48, extraPicture = "") {
  return `cut 0.4;
project "audio cache locality";
import { Rect } from "cut:visual";
import { Gain, Tone } from "@cut/audio";
import { linear } from "@cut/motion";
timeline main(duration: 120ms, fps: 25, width: 64px, height: 64px, sampleRate: ${sampleRate}khz) {
  scene only(duration: 120ms) {
    Rect(width: 64px, height: 64px, fill: ${fill});
    ${extraPicture}
    Gain(amount: -18db) as voice { Tone(frequency: 440hz, duration: 120ms, amplitude: 20%); }
    animate voice.amount from -18db to ${target}db over 120ms ease linear;
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function silentProgram(fill: string) {
  return `cut 0.4;
project "intentional silence cache";
import { Rect } from "cut:visual";
timeline main(duration: 80ms, fps: 25, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 80ms) { Rect(width: 64px, height: 64px, fill: ${fill}); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function plan(ir: CutAVIR, identity = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-cache-test")) {
  const composition = ir.compositions[0];
  return createReferenceAudioCachePlan(ir, composition, referenceMasterAudioRootIds(ir, composition), identity);
}

type RawF32 = { frames: number; data: Buffer<ArrayBufferLike>; sample(frame: number, channel?: number): number };

function rawF32(buffer: Buffer): RawF32 {
  assert.equal(buffer.length % 8, 0, "raw stereo f32le must contain complete eight-byte frames");
  return {
    frames: buffer.length / 8,
    data: buffer,
    sample(frame: number, channel = 0) {
      assert.ok(channel === 0 || channel === 1);
      return buffer.readFloatLE(frame * 8 + channel * 4);
    },
  };
}

function errorCode(code: string) {
  return (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === code);
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

test("audio cache keys project exact reachable sound semantics without picture controls", () => {
  const first = plan(compile(program("#102030", -6))), picture = plan(compile(program("#fefefe", -6)));
  const insertedPicture = plan(compile(program("#102030", -6, 48, "Rect(width: 8px, height: 8px, fill: #ff00ff);")));
  const automated = plan(compile(program("#fefefe", -3))), highRate = plan(compile(program("#fefefe", -6, 96)));
  assert.equal(first.key, picture.key, "a picture-only fill edit must not change the executable audio artifact key");
  assert.equal(first.graph.sha256, picture.graph.sha256);
  assert.equal(first.key, insertedPicture.key, "an unrelated picture insertion may renumber IR nodes but must not change audio identity");
  assert.notEqual(picture.key, automated.key, "dynamic gain signal content must invalidate audio");
  assert.notEqual(picture.graph.signalsSha256, automated.graph.signalsSha256);
  assert.notEqual(picture.key, highRate.key, "sample rate is an exact audio execution dependency");
  assert.equal(first.graph.resources, 0);
  assert.equal(first.graph.signals, 1);
  assert.equal(first.graph.roots.length, 1);
  assert.equal(first.graph.version, 3);
  assert.equal(first.graph.composition.sampleFormat, "f32le");

  const otherToolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.2\nconfiguration: --cut-cache-test");
  const toolchainPlan = plan(compile(program("#102030", -6)), otherToolchain);
  assert.notEqual(first.toolchain.integrity, otherToolchain.integrity);
  assert.notEqual(first.key, toolchainPlan.key, "FFmpeg/Node/runtime identity participates in the artifact key");
});

test("parallel FFmpeg identity capture waits for stdout to drain before resolving", async () => {
  const captures = await Promise.all(Array.from({ length: 16 }, () => runFfmpegCapture(["-version"], 30_000)));
  const identities = captures.map(({ stdout }) => createReferenceAudioToolchainIdentity(stdout));
  assert.equal(new Set(identities.map((identity) => identity.ffmpeg.identitySha256)).size, 1);
  assert.ok(identities.every((identity) => identity.ffmpeg.version.startsWith("ffmpeg version ")));
});

test("an intentional-silence timeline caches exact-length all-zero stereo f32le", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-silence-"));
  const firstIr = compile(silentProgram("#102030")), first = await renderReferenceAudioArtifact(firstIr, firstIr.compositions[0], root);
  assert.equal(first.cache.status, "miss");
  assert.equal(first.build.roots, 0);
  assert.equal(first.cache.identity.graph.roots.length, 0);
  assert.equal(first.cache.identity.graph.reachableNodes, 0);
  assert.equal(first.cache.identity.graph.packages, 1, "cut:core fingerprints silent render/cache execution");
  const decoded = rawF32(await readFile(first.path));
  assert.equal(decoded.frames, 3_840);
  assert.ok(decoded.data.every((byte) => byte === 0), "intentional silence artifact must contain only zero-valued PCM samples");
  assert.equal(first.cache.peak.silent, true);
  assert.equal(first.cache.peak.observedBytes, 3_840 * 8);
  assert.ok(Object.isFrozen(first.cache.peak));

  const secondIr = compile(silentProgram("#fefefe")), second = await renderReferenceAudioArtifact(secondIr, secondIr.compositions[0], root);
  assert.equal(second.cache.status, "hit");
  assert.equal(second.cache.key, first.cache.key);
  assert.equal(second.cache.artifact.sha256, first.cache.artifact.sha256);
});

test("real f32 artifacts hit across picture edits and miss on automation edits", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-locality-"));
  const coldIr = compile(program("#102030", -6)), cold = await renderReferenceAudioArtifact(coldIr, coldIr.compositions[0], root);
  assert.deepEqual({ status: cold.cache.status, reason: cold.cache.reason }, { status: "miss", reason: "CUT_AUDIO_CACHE_COLD" });
  assert.equal(cold.cache.artifact.samples, 5_760);
  assert.equal(cold.cache.identity.graph.signals, 1);
  const coldPcm = rawF32(await readFile(cold.path));
  assert.equal(coldPcm.frames, 5_760);
  assert.ok(Math.abs(coldPcm.sample(2_000)) > 0.005);

  const pictureIr = compile(program("#fefefe", -6)), picture = await renderReferenceAudioArtifact(pictureIr, pictureIr.compositions[0], root);
  assert.equal(picture.cache.status, "hit");
  assert.equal(picture.cache.reason, "CUT_AUDIO_CACHE_HIT");
  assert.equal(picture.cache.key, cold.cache.key);
  assert.deepEqual(rawF32(await readFile(picture.path)).data, coldPcm.data);

  const automationIr = compile(program("#fefefe", -3)), automation = await renderReferenceAudioArtifact(automationIr, automationIr.compositions[0], root);
  assert.equal(automation.cache.status, "miss");
  assert.equal(automation.cache.reason, "CUT_AUDIO_CACHE_KEY_CHANGED");
  assert.equal(automation.cache.previousKey, picture.cache.key);
  assert.notEqual(automation.cache.key, picture.cache.key);
  assert.notDeepEqual(rawF32(await readFile(automation.path)).data, coldPcm.data);

  const replayIr = compile(program("#000000", -3)), replay = await renderReferenceAudioArtifact(replayIr, replayIr.compositions[0], root);
  assert.equal(replay.cache.status, "hit");
  assert.equal(replay.cache.key, automation.cache.key);
  assert.equal(replay.cache.artifact.sha256, automation.cache.artifact.sha256);
});

test("selected review audio reuses only an exact verified full-program hit and publishes exact slice evidence", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-selection-hit-"));
  const ir = compile(program("#102030", -6));
  const composition = ir.compositions[0];
  const coldOutput = resolve(root, "cold-selection.f32le");
  const cold = await readReferenceAudioSelectionFromCache(ir, composition, root, {
    sampleRange: { start: 1_000, end: 2_000 },
    output: coldOutput,
  });
  assert.deepEqual(
    { status: cold.status, mode: cold.evidence.mode, reason: cold.evidence.status === "miss" ? cold.evidence.reason : undefined },
    { status: "miss", mode: "selected-execution", reason: "CUT_AUDIO_CACHE_COLD" },
  );
  await assert.rejects(readFile(coldOutput), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));

  const full = await renderReferenceAudioArtifact(ir, composition, root);
  const fullBytes = await readFile(full.path);
  const fullManifestPath = resolve(dirname(full.path), "manifest.json");
  const fullManifestBytes = await readFile(fullManifestPath);
  await assert.rejects(
    readReferenceAudioSelectionFromCache(ir, composition, root, {
      sampleRange: { start: 1_000, end: 2_000 },
      output: resolve(root, ".cut/cache/reference/audio/forbidden-selection.f32le"),
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_AUDIO_CACHE_SELECTION"),
  );
  const output = resolve(root, "selection.f32le");
  const selected = await readReferenceAudioSelectionFromCache(ir, composition, root, {
    sampleRange: { start: 1_000, end: 2_000 },
    output,
  });
  assert.equal(selected.status, "hit");
  if (selected.status !== "hit") return;
  const expected = fullBytes.subarray(1_000 * 8, 2_000 * 8);
  assert.deepEqual(await readFile(output), expected);
  assert.deepEqual(
    {
      format: selected.evidence.format,
      version: selected.evidence.version,
      mode: selected.evidence.mode,
      cacheStatus: selected.evidence.cache.status,
      cacheSha256: selected.evidence.cache.artifact.sha256,
      startSample: selected.evidence.slice.startSample,
      endSampleExclusive: selected.evidence.slice.endSampleExclusive,
      bytes: selected.evidence.slice.bytes,
      sha256: selected.evidence.slice.sha256,
      verification: selected.evidence.slice.verification,
    },
    {
      format: "cut-reference-audio-cache-selection",
      version: 1,
      mode: "full-program-cache-slice",
      cacheStatus: "hit",
      cacheSha256: full.cache.artifact.sha256,
      startSample: 1_000,
      endSampleExclusive: 2_000,
      bytes: 8_000,
      sha256: createHash("sha256").update(expected).digest("hex"),
      verification: "no-follow+path-handle-identity+full-sha256+exact-f32le+slice-sha256",
    },
  );
  assert.equal(selected.evidence.key, full.cache.key);
  assert.equal(selected.evidence.cache.peak.observedFrames, full.cache.artifact.samples);
  assert.deepEqual(await readFile(full.path), fullBytes, "a successful slice must not mutate full-program PCM");
  assert.deepEqual(await readFile(fullManifestPath), fullManifestBytes, "a successful slice must not rewrite cache authority");
});

test("selected review audio refuses corrupt full-program bytes, removes its partial slice, and never repairs the cache", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-selection-corrupt-"));
  const ir = compile(program("#102030", -6));
  const composition = ir.compositions[0];
  const full = await renderReferenceAudioArtifact(ir, composition, root);
  const corrupt = Buffer.from(await readFile(full.path));
  corrupt[Math.floor(corrupt.byteLength / 2)] ^= 1;
  await writeFile(full.path, corrupt);
  const output = resolve(root, "selection.f32le");
  const selected = await readReferenceAudioSelectionFromCache(ir, composition, root, {
    sampleRange: { start: 1_000, end: 2_000 },
    output,
  });
  assert.equal(selected.status, "miss");
  assert.equal(selected.evidence.mode, "selected-execution");
  if (selected.evidence.status === "miss") assert.equal(selected.evidence.reason, "CUT_AUDIO_CACHE_ARTIFACT_CORRUPT");
  await assert.rejects(readFile(output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  assert.deepEqual(await readFile(full.path), corrupt, "a review-cache probe must not rebuild or mutate corrupt full-program bytes");
});

test("selected review audio treats an execution-key change as a read-only miss", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-selection-invalidation-"));
  const firstIr = compile(program("#102030", -6));
  const first = await renderReferenceAudioArtifact(firstIr, firstIr.compositions[0], root);
  const editedIr = compile(program("#fefefe", -3));
  const output = resolve(root, "selection.f32le");
  const selected = await readReferenceAudioSelectionFromCache(editedIr, editedIr.compositions[0], root, {
    sampleRange: { start: 1_000, end: 2_000 },
    output,
  });
  assert.equal(selected.status, "miss");
  if (selected.evidence.status === "miss") {
    assert.equal(selected.evidence.reason, "CUT_AUDIO_CACHE_KEY_CHANGED");
    assert.equal(selected.evidence.previousKey, first.cache.key);
    assert.notEqual(selected.evidence.key, first.cache.key);
    await assert.rejects(
      readFile(resolve(root, ".cut/cache/reference/audio", selected.evidence.key, "mix.f32le")),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"),
    );
  }
  await assert.rejects(readFile(output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
});

test("selected review audio rejects linked and replaced cache ancestors without reading or repairing redirected bytes", { timeout: 60_000 }, async () => {
  const linkedRoot = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-selection-linked-"));
  const linkedIr = compile(program("#102030", -6));
  const linkedFull = await renderReferenceAudioArtifact(linkedIr, linkedIr.compositions[0], linkedRoot);
  const audioRoot = resolve(linkedRoot, ".cut/cache/reference/audio");
  const realAudioRoot = resolve(linkedRoot, ".cut/cache/reference/audio-real");
  const immutable = await readFile(linkedFull.path);
  await rename(audioRoot, realAudioRoot);
  await symlink("audio-real", audioRoot, "dir");
  const linked = await readReferenceAudioSelectionFromCache(linkedIr, linkedIr.compositions[0], linkedRoot, {
    sampleRange: { start: 1_001, end: 2_003 },
    output: resolve(linkedRoot, "linked-selection.f32le"),
  });
  assert.equal(linked.status, "miss");
  if (linked.evidence.status === "miss") assert.equal(linked.evidence.reason, "CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  assert.deepEqual(await readFile(resolve(realAudioRoot, linkedFull.cache.key, "mix.f32le")), immutable);
  await assert.rejects(readFile(resolve(linkedRoot, "linked-selection.f32le")), errorCode("ENOENT"));

  const replacedRoot = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-selection-replaced-"));
  const replacedIr = compile(program("#102030", -6));
  const replacedFull = await renderReferenceAudioArtifact(replacedIr, replacedIr.compositions[0], replacedRoot);
  const keyRoot = dirname(replacedFull.path);
  const movedKeyRoot = `${keyRoot}-moved`;
  const replacedImmutable = await readFile(replacedFull.path);
  const replaced = await readReferenceAudioSelectionFromCache(replacedIr, replacedIr.compositions[0], replacedRoot, {
    sampleRange: { start: 1_001, end: 2_003 },
    output: resolve(replacedRoot, "replaced-selection.f32le"),
    __testHooks: {
      async afterCacheBoundaryBound() {
        await rename(keyRoot, movedKeyRoot);
        await mkdir(keyRoot);
      },
    },
  });
  assert.equal(replaced.status, "miss");
  if (replaced.evidence.status === "miss") assert.equal(replaced.evidence.reason, "CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  assert.deepEqual(await readFile(resolve(movedKeyRoot, "mix.f32le")), replacedImmutable);
  await assert.rejects(readFile(resolve(replacedRoot, "replaced-selection.f32le")), errorCode("ENOENT"));
});

test("selected review audio refuses linked or replaced output parents and no-clobber collisions", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-selection-output-"));
  const ir = compile(program("#102030", -6));
  await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
  const realOutput = resolve(root, "real-output");
  const linkedOutput = resolve(root, "linked-output");
  await mkdir(realOutput);
  await symlink("real-output", linkedOutput, "dir");
  await assert.rejects(
    readReferenceAudioSelectionFromCache(ir, ir.compositions[0], root, {
      sampleRange: { start: 1_001, end: 2_003 },
      output: resolve(linkedOutput, "selection.f32le"),
    }),
    errorCode("CUT_AUDIO_CACHE_SELECTION"),
  );
  await assert.rejects(readFile(resolve(realOutput, "selection.f32le")), errorCode("ENOENT"));

  const outputParent = resolve(root, "replace-output");
  const movedOutputParent = resolve(root, "replace-output-old");
  await mkdir(outputParent);
  await assert.rejects(
    readReferenceAudioSelectionFromCache(ir, ir.compositions[0], root, {
      sampleRange: { start: 1_001, end: 2_003 },
      output: resolve(outputParent, "selection.f32le"),
      __testHooks: {
        async afterOutputBoundaryBound() {
          await rename(outputParent, movedOutputParent);
          await mkdir(outputParent);
        },
      },
    }),
    errorCode("CUT_AUDIO_CACHE_SELECTION"),
  );
  await assert.rejects(readFile(resolve(outputParent, "selection.f32le")), errorCode("ENOENT"));
  await assert.rejects(readFile(resolve(movedOutputParent, "selection.f32le")), errorCode("ENOENT"));

  const collision = resolve(root, "collision.f32le");
  const sentinel = Buffer.from("do-not-overwrite");
  await writeFile(collision, sentinel);
  await assert.rejects(
    readReferenceAudioSelectionFromCache(ir, ir.compositions[0], root, {
      sampleRange: { start: 1_001, end: 2_003 },
      output: collision,
    }),
    errorCode("CUT_AUDIO_CACHE_SELECTION"),
  );
  assert.deepEqual(await readFile(collision), sentinel);
});

test("selected review audio reports injected cache I/O failure as a stable contract miss and cleans output", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-selection-io-"));
  const ir = compile(program("#102030", -6));
  const full = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
  const before = await readFile(full.path);
  const output = resolve(root, "selection.f32le");
  const selected = await readReferenceAudioSelectionFromCache(ir, ir.compositions[0], root, {
    sampleRange: { start: 1_001, end: 2_003 },
    output,
    __testHooks: {
      beforeArtifactPresence() {
        throw Object.assign(new Error("injected"), { code: "EIO" });
      },
    },
  });
  assert.equal(selected.status, "miss");
  if (selected.evidence.status === "miss") assert.equal(selected.evidence.reason, "CUT_AUDIO_CACHE_ARTIFACT_CONTRACT");
  await assert.rejects(readFile(output), errorCode("ENOENT"));
  assert.deepEqual(await readFile(full.path), before);
});

test("sample-peak targets do not change the key and every hit receives a fresh bounded scan", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-peak-hit-"));
  const firstIr = compile(program("#102030", -6));
  const first = await renderReferenceAudioArtifact(firstIr, firstIr.compositions[0], root, { samplePeakDbfs: 0 });
  const secondIr = compile(program("#fefefe", -6));
  const second = await renderReferenceAudioArtifact(secondIr, secondIr.compositions[0], root, { samplePeakDbfs: -12 });
  assert.equal(first.cache.status, "miss");
  assert.equal(second.cache.status, "hit");
  assert.equal(second.cache.key, first.cache.key, "a post-cache sample ceiling must not invalidate identical PCM");
  assert.notEqual(second.cache.peak, first.cache.peak, "each invocation must return its own immutable scan evidence");
  assert.equal(first.cache.peak.thresholdDbfs, 0);
  assert.equal(second.cache.peak.thresholdDbfs, -12);
  assert.equal(second.cache.peak.peakSample, first.cache.peak.peakSample);
  assert.ok(Object.isFrozen(first.cache.peak));
  assert.ok(Object.isFrozen(second.cache.peak));

  const diagnosticSource = { module: "peak-policy.cut", line: 7, column: 11, nodeId: "meter-limit" };
  await assert.rejects(
    () => renderReferenceAudioArtifact(secondIr, secondIr.compositions[0], root, { samplePeakDbfs: -30, source: diagnosticSource }),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioPeakError);
      assert.equal(error.code, "CUT_AUDIO_CLIPPING");
      assert.deepEqual(error.source, diagnosticSource);
      return true;
    },
  );
  assert.deepEqual(await readFile(second.path), await readFile(first.path), "a failed stricter hit scan must not mutate cached PCM");
});

test("a clipping miss publishes no artifact, manifest, index, or staging residue", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-clipping-miss-")), ir = compile(program("#102030", -6));
  const composition = ir.compositions[0], toolchain = await collectReferenceAudioToolchainIdentity();
  const currentPlan = createReferenceAudioCachePlan(ir, composition, referenceMasterAudioRootIds(ir, composition), toolchain);
  await assert.rejects(
    () => renderReferenceAudioArtifact(ir, composition, root, { samplePeakDbfs: -30 }),
    (error: unknown) => error instanceof ReferenceAudioPeakError && error.code === "CUT_AUDIO_CLIPPING",
  );
  const audioRoot = resolve(root, ".cut/cache/reference/audio"), target = resolve(audioRoot, currentPlan.key);
  assert.deepEqual(await readdir(target), [], "scan failure must occur before either cache file is published");
  assert.deepEqual(await readdir(audioRoot), [currentPlan.key], "scan failure must not publish the advisory composition index");
});

test("version-1 PCM24 cache files cannot authorize version-2 f32 reuse", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-v1-stale-")), ir = compile(program("#102030", -6));
  const composition = ir.compositions[0], toolchain = await collectReferenceAudioToolchainIdentity();
  const currentPlan = createReferenceAudioCachePlan(ir, composition, referenceMasterAudioRootIds(ir, composition), toolchain);
  const target = resolve(root, ".cut/cache/reference/audio", currentPlan.key);
  await mkdir(target, { recursive: true });
  await writeFile(resolve(target, "mix.wav"), Buffer.alloc(44));
  await writeFile(resolve(target, "manifest.json"), JSON.stringify({ format: "cut-reference-audio-cache", version: 1, key: currentPlan.key }));
  const rendered = await renderReferenceAudioArtifact(ir, composition, root);
  assert.equal(rendered.cache.status, "miss");
  assert.equal(rendered.cache.reason, "CUT_AUDIO_CACHE_COLD");
  assert.equal(rendered.cache.version, 3);
  assert.equal(rendered.cache.identity.graph.version, 3);
  assert.equal(rendered.cache.artifact.sampleFormat, "f32le");
  assert.equal(rendered.cache.artifact.locator, `.cut/cache/reference/audio/${currentPlan.key}/mix.f32le`);
  assert.equal(rawF32(await readFile(rendered.path)).frames, 5_760);
});

test("locked source-byte edits invalidate and replace decoded PCM", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-source-")), sourcePath = resolve(root, "voice.wav");
  const source = `cut 0.4;
project "audio source cache";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 100ms, fps: 20, width: 64px, height: 64px, sampleRate: 48khz) {
  AudioClip(source: voice, range: 0ms ..< 100ms);
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  await writeFile(sourcePath, monoPcm16Wave(48_000, Array.from({ length: 4_800 }, () => 12_000)));
  const positiveIr = compile(source), positiveLock = await createCutLock(positiveIr, root); await applyCutLock(positiveIr, positiveLock, root);
  const positive = await renderReferenceAudioArtifact(positiveIr, positiveIr.compositions[0], root), positivePcm = rawF32(await readFile(positive.path));
  assert.ok(positivePcm.sample(1_000) > 0.2);
  assert.equal(positive.cache.identity.graph.resources, 1);

  await writeFile(sourcePath, monoPcm16Wave(48_000, Array.from({ length: 4_800 }, () => -12_000)));
  const negativeIr = compile(source), negativeLock = await createCutLock(negativeIr, root); await applyCutLock(negativeIr, negativeLock, root);
  const negative = await renderReferenceAudioArtifact(negativeIr, negativeIr.compositions[0], root), negativePcm = rawF32(await readFile(negative.path));
  assert.equal(negative.cache.status, "miss");
  assert.equal(negative.cache.reason, "CUT_AUDIO_CACHE_KEY_CHANGED");
  assert.notEqual(negative.cache.key, positive.cache.key);
  assert.notEqual(negative.cache.identity.graph.resourcesSha256, positive.cache.identity.graph.resourcesSha256);
  assert.ok(negativePcm.sample(1_000) < -0.2);
});

test("corrupt cached bytes are detected, refused, and deterministically rebuilt", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-corrupt-")), ir = compile(program("#102030", -6));
  const first = await renderReferenceAudioArtifact(ir, ir.compositions[0], root), original = await readFile(first.path);
  await writeFile(first.path, Buffer.from("not exact float data"));
  const repairedIr = compile(program("#eeeeee", -6)), repaired = await renderReferenceAudioArtifact(repairedIr, repairedIr.compositions[0], root);
  assert.equal(repaired.cache.status, "miss");
  assert.equal(repaired.cache.reason, "CUT_AUDIO_CACHE_ARTIFACT_CORRUPT");
  assert.equal(repaired.cache.key, first.cache.key);
  assert.equal(repaired.cache.artifact.sha256, first.cache.artifact.sha256);
  assert.deepEqual(await readFile(repaired.path), original);
  assert.equal(rawF32(await readFile(repaired.path)).frames, 5_760);
});

test("render manifests expose stable verified audio cache evidence", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-cache-manifest-"));
  const firstIr = compile(program("#102030", -6)), firstPath = resolve(root, "first.mp4"), first = await renderReferenceIr(firstIr, root, firstPath);
  assert.equal(first.cache.audio.format, "cut-reference-audio-cache-evidence");
  assert.equal(first.cache.audio.status, "miss");
  assert.equal(first.cache.audio.stage, "pre-master-f32le");
  assert.match(first.cache.audio.key, /^[a-f0-9]{64}$/u);
  assert.match(first.cache.audio.artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.cache.audio.artifact.verification, "sha256+exact-f32le+sample-peak");
  assert.equal(first.cache.audio.artifact.sampleFormat, "f32le");
  assert.equal(first.cache.audio.artifact.bytes, first.cache.audio.artifact.samples * 8);
  assert.ok(Object.isFrozen(first.cache.audio.peak));

  const secondIr = compile(program("#ffffff", -6)), secondPath = resolve(root, "second.mp4"), second = await renderReferenceIr(secondIr, root, secondPath);
  assert.equal(second.cache.audio.status, "hit");
  assert.equal(second.cache.audio.key, first.cache.audio.key);
  assert.equal(second.cache.scenes[0].status, "miss", "the picture edit remains a real scene-cache miss");
  const written = JSON.parse(await readFile(`${secondPath}.manifest.json`, "utf8")) as typeof second;
  assert.deepEqual(written.cache.audio, second.cache.audio);
});
