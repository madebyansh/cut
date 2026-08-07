import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock, CutLockError } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { probeProjectImage, probeProjectMedia } from "../lib/project/probe";
import type { StagedFileTransactionFaultPoint } from "../lib/project/write-boundary";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import { renderReferencePreviewArtifact } from "../lib/runtime/reference/authoring-review";
import { renderReferenceIr } from "./reference-render-test-helper";
import { collectReferenceBackendIdentity, type CutReferenceBackendIdentity } from "../lib/runtime/reference/runtime-identity";

const exec = promisify(execFile);

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics]
    .filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

const source = `cut 0.4;
project "verified input integrated render";
import { Image, Video } from "cut:visual";
import { AudioClip } from "@cut/audio";

asset still: ImageAsset = image("media/still.svg");
asset motion: VideoAsset = video("media/motion-master.y4m", proxy: "media/motion-proxy.y4m");
asset voice: AudioAsset = audio("media/voice-master.wav", proxy: "media/voice-proxy.wav");

timeline main(duration: 2s, fps: 4, width: 32px, height: 32px, sampleRate: 48khz) {
  scene still_scene(duration: 1s) {
    Image(source: still);
    AudioClip(source: voice, range: 0s ..< 1s);
  }
  scene video_scene(duration: 1s) {
    Video(source: motion, range: 0s ..< 1s);
  }
}

export out = render(main, width: 32px, height: 32px, codec: "h264");
`;

function svg(fill: string) {
  assert.match(fill, /^#[a-f0-9]{6}$/u);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" fill="${fill}"/></svg>\n`, "utf8");
}

function y4m(width: number, height: number, fps: number, frames: number, yuv: readonly [number, number, number]) {
  assert.equal(width % 2, 0); assert.equal(height % 2, 0);
  const chunks: Buffer[] = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`, "ascii")];
  const luma = Buffer.alloc(width * height, yuv[0]);
  const chromaU = Buffer.alloc(width * height / 4, yuv[1]);
  const chromaV = Buffer.alloc(width * height / 4, yuv[2]);
  for (let frame = 0; frame < frames; frame += 1) chunks.push(Buffer.from("FRAME\n", "ascii"), luma, chromaU, chromaV);
  return Buffer.concat(chunks);
}

function wav(frequency: number, seconds = 1, sampleRate = 48_000, amplitude = 8_000) {
  const samples = seconds * sampleRate, dataBytes = samples * 2, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataBytes, 40);
  for (let sample = 0; sample < samples; sample += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * sample / sampleRate) * amplitude), 44 + sample * 2);
  }
  return bytes;
}

type FixtureBytes = Readonly<{
  still: Buffer;
  motionMaster: Buffer;
  motionProxy: Buffer;
  voiceMaster: Buffer;
  voiceProxy: Buffer;
}>;

const originals: FixtureBytes = {
  still: svg("#e61414"),
  motionMaster: y4m(32, 32, 4, 4, [145, 54, 34]),
  motionProxy: y4m(32, 32, 4, 4, [145, 54, 34]),
  voiceMaster: wav(220),
  voiceProxy: wav(220, 1, 48_000, 6_000),
};

const replacements: FixtureBytes = {
  still: svg("#1414e6"),
  motionMaster: y4m(32, 32, 4, 4, [81, 90, 240]),
  motionProxy: y4m(32, 32, 4, 4, [41, 240, 110]),
  voiceMaster: wav(880),
  voiceProxy: wav(990),
};

const fixturePaths = {
  still: "media/still.svg",
  motionMaster: "media/motion-master.y4m",
  motionProxy: "media/motion-proxy.y4m",
  voiceMaster: "media/voice-master.wav",
  voiceProxy: "media/voice-proxy.wav",
} as const;

async function writeFixture(root: string, fixture: FixtureBytes) {
  await mkdir(resolve(root, "media"), { recursive: true });
  await Promise.all(Object.entries(fixturePaths).map(([key, path]) => writeFile(resolve(root, path), fixture[key as keyof FixtureBytes])));
}

async function lockedIr(root: string) {
  await writeFixture(root, originals);
  const ir = compile(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function inputSessionEntries(root: string) {
  const cache = resolve(root, ".cut", "cache", "reference");
  return (await readdir(cache).catch(() => [] as string[])).filter((entry) => entry.startsWith(".cut-inputs-"));
}

async function treeEntries(directory: string, root = directory): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name);
    result.push(relative(root, path).split("\\").join("/"));
    if (entry.isDirectory()) result.push(...await treeEntries(path, root));
  }
  return result;
}

async function jsonPayloads(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await jsonPayloads(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(await readFile(path, "utf8"));
  }
  return result;
}

async function decodedPixel(path: string, at: string, root: string, name: string) {
  const raw = resolve(root, `${name}.rgb`);
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", path, "-ss", at, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", raw]);
  return [...(await readFile(raw)).subarray(0, 3)];
}

async function zeroCrossings(path: string, root: string) {
  const raw = resolve(root, "delivery-audio.f32");
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", raw]);
  const bytes = await readFile(raw); let previous = 0, crossings = 0;
  for (let sample = 4_000; sample < 40_000; sample += 1) {
    const value = bytes.readFloatLE(sample * 4);
    if (Math.abs(value) < 0.001) continue;
    if (previous && Math.sign(value) !== Math.sign(previous)) crossings += 1;
    previous = value;
  }
  return crossings;
}

function assertSameSizeReplacements() {
  for (const key of Object.keys(originals) as Array<keyof FixtureBytes>) {
    assert.equal(replacements[key].byteLength, originals[key].byteLength, `${key} replacement must preserve byte length`);
    assert.notDeepEqual(replacements[key], originals[key], `${key} replacement must have different bytes`);
  }
}

async function assertReplacementInputsAreValid(root: string) {
  const image = await probeProjectImage(root, fixturePaths.still);
  assert.deepEqual({ width: image.image.width, height: image.image.height }, { width: 32, height: 32 });
  for (const locator of [fixturePaths.motionMaster, fixturePaths.motionProxy, fixturePaths.voiceMaster, fixturePaths.voiceProxy]) {
    const media = await probeProjectMedia(root, locator);
    assert.ok(media.streams.some((stream) => stream.duration && (stream.type === "video" || stream.type === "audio")), `${locator} replacement must remain independently decodable`);
  }
}

test("full proxy render consumes verified image, video, and audio snapshots after valid same-size source replacement", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-render-"));
  try {
    assertSameSizeReplacements();
    const ir = await lockedIr(root), canonicalBuildId = ir.buildId, canonicalGraph = JSON.stringify(ir);
    const expectedExecutionBuildId = selectReferenceMediaProfile(ir, "proxy").ir.buildId;
    const output = resolve(root, "delivery.mp4"); let publicationObserved = false;

    const manifest = await renderReferenceIr(ir, root, output, undefined, {
      mediaProfile: "proxy",
      async __testAfterInputSnapshot() {
        assert.equal((await inputSessionEntries(root)).length, 1, "hook must run while one verified-input session is live");
        await writeFixture(root, replacements);
      },
      __testPublicationHooks: { async fault(point: StagedFileTransactionFaultPoint) {
        if (point.phase === "promotion" && point.timing === "before" && point.role === "render-output") {
          publicationObserved = true;
          assert.deepEqual(await inputSessionEntries(root), [], "snapshots must be deleted before public artifact promotion");
        }
      } },
    });

    await assertReplacementInputsAreValid(root);
    assert.equal(publicationObserved, true);
    assert.equal(ir.buildId, canonicalBuildId); assert.equal(JSON.stringify(ir), canonicalGraph, "render must not retarget or mutate canonical IR");
    assert.equal(manifest.buildId, canonicalBuildId); assert.equal(manifest.executionBuildId, expectedExecutionBuildId);
    assert.equal(manifest.media.requested, "proxy"); assert.equal(manifest.media.selectedProxyResources, 2);

    const [stillPixel, motionPixel, crossings] = await Promise.all([
      decodedPixel(output, "0.25", root, "still"),
      decodedPixel(output, "1.25", root, "motion"),
      zeroCrossings(output, root),
    ]);
    assert.ok(stillPixel[0] > stillPixel[2] + 100 && stillPixel[0] > stillPixel[1] + 100, `render decoded replacement blue still instead of snapshotted red still: ${stillPixel}`);
    assert.ok(motionPixel[1] > motionPixel[0] + 100 && motionPixel[1] > motionPixel[2] + 100, `render decoded replacement blue video instead of snapshotted green proxy video: ${motionPixel}`);
    assert.ok(crossings > 300 && crossings < 550, `render decoded replacement 990Hz audio instead of snapshotted 220Hz proxy audio: ${crossings} crossings`);

    const publicManifest = await readFile(`${output}.manifest.json`, "utf8");
    assert.equal(publicManifest.includes(".cut-inputs-"), false); assert.equal(JSON.stringify(manifest).includes(".cut-inputs-"), false);
    assert.equal(canonicalGraph.includes(".cut-inputs-"), false); assert.equal(canonicalBuildId.includes(".cut-inputs-"), false); assert.equal(expectedExecutionBuildId.includes(".cut-inputs-"), false);
    const cacheRoot = resolve(root, ".cut", "cache", "reference");
    assert.equal((await treeEntries(cacheRoot)).some((entry) => entry.includes(".cut-inputs-")), false, "successful render must remove every input-session path");
    assert.equal((await jsonPayloads(cacheRoot)).some((payload) => payload.includes(".cut-inputs-")), false, "cache manifests must not retain input-session paths");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded proxy preview consumes the same verified snapshots after valid same-size source replacement", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-range-preview-"));
  try {
    assertSameSizeReplacements();
    const ir = await lockedIr(root), canonicalBuildId = ir.buildId, canonicalGraph = JSON.stringify(ir);
    const expectedExecutionBuildId = selectReferenceMediaProfile(ir, "proxy").ir.buildId;
    const output = resolve(root, "range.mp4"); let publicationObserved = false;
    const manifest = await renderReferencePreviewArtifact(ir, root, output, {
      range: "0s:2s",
      async __testAfterInputSnapshot() {
        assert.equal((await inputSessionEntries(root)).length, 1);
        await writeFixture(root, replacements);
      },
      __testPublicationHooks: { async fault(point: StagedFileTransactionFaultPoint) {
        if (point.phase === "promotion" && point.timing === "before" && point.role === "range-preview") {
          publicationObserved = true;
          assert.deepEqual(await inputSessionEntries(root), [], "bounded preview must clean snapshots before publication");
        }
      } },
    });
    await assertReplacementInputsAreValid(root);
    assert.equal(publicationObserved, true);
    assert.equal(ir.buildId, canonicalBuildId); assert.equal(JSON.stringify(ir), canonicalGraph);
    assert.equal(manifest.buildId, canonicalBuildId); assert.equal(manifest.executionBuildId, expectedExecutionBuildId);
    assert.equal(manifest.media.requested, "proxy"); assert.equal(manifest.media.selectedProxyResources, 2); assert.equal(manifest.media.fallbackResources, 0);
    assert.deepEqual({ first: manifest.range.firstFrame, end: manifest.range.endFrameExclusive, frames: manifest.range.frames, startSample: manifest.range.startSample, endSample: manifest.range.endSampleExclusive, samples: manifest.range.samples }, { first: 0, end: 8, frames: 8, startSample: 0, endSample: 96_000, samples: 96_000 });
    const [stillPixel, motionPixel, crossings] = await Promise.all([
      decodedPixel(output, "0.25", root, "range-still"),
      decodedPixel(output, "1.25", root, "range-motion"),
      zeroCrossings(output, root),
    ]);
    assert.ok(stillPixel[0] > stillPixel[2] + 100 && stillPixel[0] > stillPixel[1] + 100, `bounded preview used replaced still instead of snapshot: ${stillPixel}`);
    assert.ok(motionPixel[1] > motionPixel[0] + 100 && motionPixel[1] > motionPixel[2] + 100, `bounded preview used replaced proxy video instead of snapshot: ${motionPixel}`);
    assert.ok(crossings > 300 && crossings < 750, `bounded preview used replaced proxy audio instead of snapshot: ${crossings} crossings`);
    assert.equal(JSON.stringify(manifest).includes(".cut-inputs-"), false);
    assert.deepEqual(await inputSessionEntries(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-snapshot render failure removes the verified-input session and publishes nothing", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-render-failure-"));
  try {
    assertSameSizeReplacements();
    const ir: CutAVIR = await lockedIr(root), canonicalBuildId = ir.buildId, canonicalGraph = JSON.stringify(ir);
    const output = resolve(root, "must-not-exist.mp4");
    await assert.rejects(renderReferenceIr(ir, root, output, undefined, {
      mediaProfile: "proxy",
      async __testAfterInputSnapshot() {
        assert.equal((await inputSessionEntries(root)).length, 1, "fault hook must observe the live verified-input session");
        await writeFixture(root, replacements);
        throw new Error("injected post-snapshot render failure");
      },
    }), /injected post-snapshot render failure/u);

    await assertReplacementInputsAreValid(root);
    assert.equal(ir.buildId, canonicalBuildId); assert.equal(JSON.stringify(ir), canonicalGraph);
    await assert.rejects(lstat(output), isMissing); await assert.rejects(lstat(`${output}.manifest.json`), isMissing);
    assert.deepEqual(await inputSessionEntries(root), []);
    const cacheRoot = resolve(root, ".cut", "cache", "reference");
    assert.equal((await treeEntries(cacheRoot)).some((entry) => entry.includes(".cut-inputs-")), false, "failed render must remove every input-session path");
    assert.equal((await jsonPayloads(cacheRoot)).some((payload) => payload.includes(".cut-inputs-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render binds verified inputs before comparing the complete locked backend identity", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-backend-order-"));
  try {
    const ir = await lockedIr(root), actual = await collectReferenceBackendIdentity();
    // Preserve the real integrity digest while changing another canonical
    // field. An integrity-only comparison would incorrectly accept this.
    const mismatched = {
      ...actual,
      native: { ...actual.native, architecture: `${actual.native.architecture}-other` },
    } as CutReferenceBackendIdentity;
    const output = resolve(root, "must-not-publish.mp4"); let snapshotObserved = false;

    await assert.rejects(renderReferenceIr(ir, root, output, undefined, {
      mediaProfile: "proxy",
      __lockedReferenceBackend: mismatched,
      async __testAfterInputSnapshot() {
        snapshotObserved = true;
        assert.equal((await inputSessionEntries(root)).length, 1, "backend verification must run only after the verified-input session is live");
      },
    }), (error: unknown) => error instanceof CutLockError
      && error.code === "CUT_LOCK_IDENTITY"
      && error.path === "$.toolchain.referenceBackend"
      && /canonical backend fields differ despite the shared integrity value/u.test(error.message)
      && !error.message.includes(`${actual.integrity} != ${actual.integrity}`));

    assert.equal(snapshotObserved, true, "the snapshot hook must run before the naturally collected foreign-backend mismatch");
    await assert.rejects(lstat(output), isMissing);
    await assert.rejects(lstat(`${output}.manifest.json`), isMissing);
    assert.deepEqual(await inputSessionEntries(root), [], "backend mismatch must still clean the verified-input session");
    assert.deepEqual((await readdir(resolve(root, ".cut", "cache", "reference"))).filter((name) => name.endsWith(".mp4")), [], "backend mismatch must prevent picture execution and cache publication");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
