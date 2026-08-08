import assert from "node:assert/strict";
// Top-level cut.lock v3 compatibility and authority coverage.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { hash } from "../lib/core/stable";
import { compileCutModule } from "../lib/language/compiler";
import {
  applyCutLock,
  applyCutLockForVerifiedInputSession,
  createCutLock,
  CutLockError,
  loadCutLock,
  validateCutLock,
  verifyLockedIrResources,
  type CutLockfile,
  type LockedResourceProbe,
} from "../lib/language/lock";
import { analyzeCutMigration, cutMigrationCompatibilityMatrix, CutMigrationError } from "../lib/language/migration";
import { parseCutLanguage } from "../lib/language/parser";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { collectReferenceBackendIdentity, createReferenceBackendIdentity } from "../lib/runtime/reference/runtime-identity";
import { prepareReferenceVerifiedInputSession } from "../lib/runtime/reference/verified-input-session";
import { cutPackageAbi, cutReferenceRuntimeIdentity } from "../lib/version";

const exec = promisify(execFile);

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

async function generatedAv(root: string, name = "source.mkv", duration = 2) {
  const media = resolve(root, "media"); await mkdir(media, { recursive: true });
  const output = resolve(media, name);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=0x225588:s=64x64:r=4:d=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${duration}`,
    "-shortest", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le", output,
  ]);
  return output;
}

async function generatedUnevenAv(root: string) {
  const media = resolve(root, "media"); await mkdir(media, { recursive: true });
  const output = resolve(media, "uneven.mkv");
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0xd5524b:s=64x64:r=4:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le", output,
  ]);
  return output;
}

async function generatedMultiVideo(root: string) {
  const media = resolve(root, "media"); await mkdir(media, { recursive: true });
  const output = resolve(media, "streams.mkv");
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0xd84a44:s=64x64:r=4:d=1",
    "-f", "lavfi", "-i", "color=c=0x366dd9:s=128x128:r=4:d=1",
    "-map", "0:v:0", "-map", "1:v:0", "-c:v", "ffv1", "-pix_fmt", "yuv420p",
    "-disposition:v:0", "0", "-disposition:v:1", "default", output,
  ]);
  return output;
}

async function generatedMultiAudio(root: string) {
  const media = resolve(root, "media"); await mkdir(media, { recursive: true });
  const output = resolve(media, "audio-streams.mkv");
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1",
    "-map", "0:a:0", "-map", "1:a:0", "-c:a", "pcm_s24le",
    "-disposition:a:0", "0", "-disposition:a:1", "default", output,
  ]);
  return output;
}

function monoPcm16Wav(frequency: number, durationSeconds = 2, sampleRate = 48_000) {
  const frames = durationSeconds * sampleRate, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * frame / sampleRate) * 16_000), 44 + frame * 2);
  }
  return bytes;
}

function producerOnlySource(range = "0s ..< 2s") {
  return `cut 0.4;
project "producer-only lock traversal";
import { Group, Rect } from "cut:visual";
import { AmplitudeEnvelope, mapNumber } from "@cut/data";
asset rhythm: AudioAsset = audio("media/rhythm.wav");
timeline main(duration: 2s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene pulse(duration: 2s) {
    let energy: Signal<Ratio> = AmplitudeEnvelope(
      source: rhythm,
      range: ${range},
      at: 0s,
      detector: "rms",
      window: 20ms,
      hop: 10ms,
      attack: 10ms,
      release: 50ms,
      floor: 1%,
      ceiling: 80%
    );
    Group(scale: 1) as pulse { Rect(width: 80px, height: 40px, fill: #55d6be); }
    set pulse.scale = mapNumber(energy, from: 1, to: 1.4);
  }
}
export out = render(main);`;
}

function pcm24Sample(bytes: Buffer, frame: number, channel = 0) {
  let offset = 12, blockAlign = 0; let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") blockAlign = bytes.readUInt16LE(body + 12);
    if (id === "data") { data = bytes.subarray(body, body + size); break; }
    offset = body + size + size % 2;
  }
  assert.equal(blockAlign, 6);
  const position = frame * blockAlign + channel * 3; let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
  if (value & 0x800000) value -= 0x1000000;
  return value / 0x800000;
}

function clipSource(body: string) {
  return `cut 0.4;
project "lock v3 bounds";
import { Clip } from "@cut/edit";
asset media: VideoAsset = video("media/source.mkv");
timeline main(duration: 2500ms, fps: 4, sampleRate: 48khz) {
  scene only(duration: 2500ms) { ${body} }
}
export out = render(main);`;
}

function mediaProbe(lock: CutLockfile, id = "media") {
  const probe = lock.resources[id].probe;
  assert.equal(probe.kind, "media");
  return probe as Extract<LockedResourceProbe, { kind: "media" }>;
}

test("cut.lock v3 pins bounded selected streams and rejects actual source-range overruns before semantic lock", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-bounds-")); await generatedAv(root);
  const pass = compile(clipSource("Clip(source: media, range: 1s ..< 2s, duration: 500ms);"));
  const lock = await createCutLock(pass, root), probe = mediaProbe(lock);
  assert.equal(lock.version, 3);
  assert.deepEqual(lock.toolchain, { compiler: pass.compiler, ir: 3, packageAbi: cutPackageAbi, referenceRuntime: cutReferenceRuntimeIdentity, referenceBackend: await collectReferenceBackendIdentity() });
  assert.equal(lock.toolchain.referenceBackend.runtime, cutReferenceRuntimeIdentity);
  assert.match(lock.toolchain.referenceBackend.dependencies.integrity, /^[a-f0-9]{64}$/);
  assert.match(lock.toolchain.referenceBackend.integrity, /^[a-f0-9]{64}$/);
  assert.equal(lock.determinism.semantic, "locked");
  assert.equal(lock.determinism.decodedMedia, "unverified");
  assert.equal(lock.determinism.bitstream, "unverified");
  assert.ok(probe.identity.streams.some((stream) => stream.type === "video" && stream.timeBase));
  assert.ok(probe.identity.streams.some((stream) => stream.type === "audio" && stream.timeBase));
  assert.ok(probe.identity.container.duration);
  assert.ok(probe.selected.video && probe.selected.audio);
  await applyCutLock(pass, lock, root);
  assert.equal(pass.determinism.semantic, "locked");
  assert.equal(pass.resources.media.metadata?.lockVersion, 2);
  await verifyLockedIrResources(pass, root);

  const overrun = compile(clipSource("Clip(source: media, range: 1500ms ..< 2250ms, duration: 500ms);"));
  await assert.rejects(
    createCutLock(overrun, root),
    /beyond the selected picture bound/,
  );
  assert.equal(overrun.resources.media.state, "unlocked", "failed lock creation must not partially lock resources");
  assert.equal(overrun.determinism.semantic, "unlocked", "failed lock creation must not claim semantic determinism");

  const implicit = compile(clipSource("Clip(source: media, duration: 2250ms);"));
  await assert.rejects(createCutLock(implicit, root), /provides only 2\/1s/);
});

test("producer-only audio is locked, privately snapshotted, and relocking its bytes changes executable graph identity", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-producer-only-"));
  await mkdir(resolve(root, "media"));
  const assetPath = resolve(root, "media/rhythm.wav"), source = producerOnlySource();
  await writeFile(assetPath, monoPcm16Wav(440));

  const firstIr = compile(source);
  assert.ok(Object.values(firstIr.nodes).every((node) => node.inputs.source?.kind !== "resource-ref"), "fixture must not hide an ordinary node media consumer");
  assert.ok(firstIr.compositions.every((composition) => composition.rootAudioIds.length === 0), "fixture audio must be consumed only by the signal producer");
  const firstLock = await createCutLock(firstIr, root);
  assert.deepEqual(Object.keys(firstLock.resources), ["rhythm"]);
  assert.equal(firstLock.resources.rhythm.kind, "audio");
  const firstProbe = mediaProbe(firstLock, "rhythm");
  assert.ok(firstProbe.selected.audio, "producer-only AudioAsset must still pin one exact selected stream");
  await applyCutLock(firstIr, firstLock, root);
  assert.equal(firstIr.resources.rhythm.state, "locked");
  assert.equal(firstIr.resources.rhythm.sha256, firstLock.resources.rhythm.sha256);
  const firstBuildId = firstIr.buildId;
  const firstGroupHash = Object.values(firstIr.nodes).find((node) => node.op === "cut.visual.group")!.contentHash;

  const session = await prepareReferenceVerifiedInputSession(firstIr, root, "master");
  try {
    const snapshotPath = session.pathFor("rhythm");
    assert.notEqual(snapshotPath, assetPath, "verified execution must hand the producer a private snapshot, not the authored path");
    assert.deepEqual(await readFile(snapshotPath), await readFile(assetPath));
    const evidence = session.evidence.variants.find((item) => item.resourceId === "rhythm" && item.variant === "master");
    assert.ok(evidence?.selected);
    assert.equal(evidence.sha256, firstLock.resources.rhythm.sha256);
  } finally {
    await session.cleanup();
  }

  await writeFile(assetPath, monoPcm16Wav(880));
  await assert.rejects(applyCutLock(compile(source), firstLock, root), (error: unknown) => error instanceof CutLockError
    && error.code === "CUT_LOCK_INTEGRITY"
    && error.path === "$.resources.rhythm", "old producer lock must reject changed source bytes");
  const secondIr = compile(source), secondLock = await createCutLock(secondIr, root);
  await applyCutLock(secondIr, secondLock, root);
  const secondGroupHash = Object.values(secondIr.nodes).find((node) => node.op === "cut.visual.group")!.contentHash;
  assert.equal(secondLock.sourceHash, firstLock.sourceHash, "the CUT source is deliberately unchanged across the relock");
  assert.notEqual(secondLock.resources.rhythm.sha256, firstLock.resources.rhythm.sha256);
  assert.notEqual(secondGroupHash, firstGroupHash, "the producer's locked source identity must invalidate its visual consumer");
  assert.notEqual(secondIr.buildId, firstBuildId, "relocked producer bytes must invalidate the executable build identity");
});

test("cut.lock validates amplitude-producer source bounds before lock and during embedded revalidation", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-producer-bounds-"));
  await mkdir(resolve(root, "media"));
  await writeFile(resolve(root, "media/rhythm.wav"), monoPcm16Wav(440, 1));

  const overrun = compile(producerOnlySource());
  await assert.rejects(createCutLock(overrun, root), (error: unknown) => error instanceof CutLockError
    && error.code === "CUT_AUDIO_REACTIVE_RESOURCE"
    && /\.producer\.range$/u.test(error.path)
    && /beyond the selected audio stream bound 1\/1s/u.test(error.message));
  assert.equal(overrun.resources.rhythm.state, "unlocked");
  assert.equal(overrun.determinism.semantic, "unlocked");

  const valid = compile(producerOnlySource("0s ..< 1s"));
  await applyCutLock(valid, await createCutLock(valid, root), root);
  const signal = Object.values(valid.signals).find((candidate) => candidate.kind === "track" && candidate.producer);
  assert.equal(signal?.kind, "track");
  if (signal?.kind !== "track" || !signal.producer) throw new Error("expected producer-backed track");
  signal.producer.range.end = { numerator: "2", denominator: "1" };
  await assert.rejects(verifyLockedIrResources(valid, root), (error: unknown) => error instanceof CutLockError
    && error.code === "CUT_AUDIO_REACTIVE_RESOURCE"
    && /\.producer\.range$/u.test(error.path), "render-time lock verification must recheck producer media bounds");
});

test("render-time embedded lock state is closed and bounded before resource I/O", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-embedded-")); await generatedAv(root);
  const source = clipSource("Clip(source: media, range: 0s ..< 1s, duration: 1s);");
  const canonical = compile(source); await applyCutLock(canonical, await createCutLock(canonical, root), root);
  const rejectsState = async (mutate: (candidate: typeof canonical) => void) => {
    const candidate = structuredClone(canonical); mutate(candidate);
    await assert.rejects(verifyLockedIrResources(candidate, root), (error: unknown) => error instanceof CutLockError && error.code === "CUT_LOCK_STATE");
  };

  await rejectsState((candidate) => { candidate.resources.media.sha256 = "not-a-digest"; });
  await rejectsState((candidate) => { candidate.resources.media.metadata!.bytes = Number.NaN; });
  await rejectsState((candidate) => { (candidate.resources.media.metadata as unknown as Record<string, unknown>).surprise = true; });
  await rejectsState((candidate) => {
    const probe = candidate.resources.media.metadata!.probe as Extract<LockedResourceProbe, { kind: "media" }>;
    (probe as unknown as Record<string, unknown>).surprise = true;
  });
  await rejectsState((candidate) => {
    const probe = candidate.resources.media.metadata!.probe as Extract<LockedResourceProbe, { kind: "media" }>;
    probe.identity.file.sha256 = "0".repeat(64);
  });
  await rejectsState((candidate) => {
    const resource = candidate.resources.media as typeof candidate.resources.media & { proxy?: { locator: string } };
    resource.proxy = { locator: resource.locator };
    resource.metadata!.proxy = {
      locator: resource.locator,
      sha256: resource.sha256!,
      bytes: resource.metadata!.bytes,
      probe: structuredClone(resource.metadata!.probe) as LockedResourceProbe,
    };
  });
  await rejectsState((candidate) => {
    const probe = candidate.resources.media.metadata!.probe as Extract<LockedResourceProbe, { kind: "media" }>;
    probe.identity.streams = Array.from({ length: 1_025 }, (_, index) => ({ ...structuredClone(probe.identity.streams[0]), index }));
  });
});

test("locked byte drift is size-first and diagnostic order is resource-id stable", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-byte-order-")); await mkdir(resolve(root, "media"));
  await writeFile(resolve(root, "media/alpha.bin"), "a");
  await writeFile(resolve(root, "media/zeta.bin"), "z");
  const source = `cut 0.4;
project "byte order";
import { Rect } from "cut:visual";
asset zeta: DataAsset = data("media/zeta.bin");
asset alpha: DataAsset = data("media/alpha.bin");
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px) {
  scene only(duration: 1s) { Rect(width: 16px, height: 16px, x: 8px, y: 8px); }
}
export out = render(main);`;
  const lock = await createCutLock(compile(source), root);
  await truncate(resolve(root, "media/alpha.bin"), 64 * 1024 * 1024);
  await writeFile(resolve(root, "media/zeta.bin"), "changed");
  const candidate = compile(source);
  candidate.resources = Object.fromEntries(Object.entries(candidate.resources).reverse());
  await assert.rejects(applyCutLock(candidate, lock, root), (error: unknown) => error instanceof CutLockError
    && error.code === "CUT_LOCK_INTEGRITY"
    && error.path === "$.resources.alpha");
});

test("cut.lock v3 applies selected-stream source bounds to every executable media kernel before lock and render", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-all-bounds-")); await generatedAv(root);
  const header = `cut 0.4;
project "all source bounds";
asset videoSource: VideoAsset = video("media/source.mkv");
asset audioSource: AudioAsset = audio("media/source.mkv");`;
  const timeline = (imports: string, body: string, duration = "1s") => `${header}
${imports}
timeline main(duration: ${duration}, fps: 4, sampleRate: 48khz) { scene only(duration: ${duration}) { ${body} } }
export out = render(main);`;
  const invalidPrograms = [
    timeline('import { Video } from "cut:visual";', "Video(source: videoSource, range: 1500ms ..< 2250ms);"),
    timeline('import { AudioClip } from "@cut/audio";', "AudioClip(source: audioSource, range: 1500ms ..< 2250ms);"),
    timeline('import { Narration } from "@cut/documentary";', "Narration(source: audioSource, range: 1500ms ..< 2250ms);"),
    timeline('import { Waveform } from "@cut/data";', "Waveform(source: audioSource, range: 1500ms ..< 2250ms);"),
    timeline('import { Spectrogram } from "@cut/data";', "Spectrogram(source: audioSource, range: 1500ms ..< 2250ms);"),
  ];
  for (const source of invalidPrograms) {
    const ir = compile(source);
    await assert.rejects(createCutLock(ir, root), /beyond the selected source bound/);
    assert.equal(ir.determinism.semantic, "unlocked", "a source-bound failure cannot declare semantic determinism");
  }

  const implicitVideo = compile(timeline('import { Video } from "cut:visual";', "Video(source: videoSource);", "2500ms"));
  await assert.rejects(createCutLock(implicitVideo, root), /Video at .*selected video stream provides only 2\/1s/);

  const trimLoop = compile(timeline('import { Video } from "cut:visual";', "Video(source: videoSource, range: 0s ..< 1s, loop: true);"));
  await assert.rejects(createCutLock(trimLoop, root), /exact trimmed-range looping/);

  const fullLoop = compile(timeline('import { Video } from "cut:visual";', "Video(source: videoSource, loop: true);", "2500ms"));
  await applyCutLock(fullLoop, await createCutLock(fullLoop, root), root);
  const videoNode = Object.values(fullLoop.nodes).find((node) => node.op === "cut.visual.video")!;
  delete videoNode.inputs.loop;
  videoNode.inputs.range = {
    kind: "range",
    exclusive: true,
    start: { kind: "quantity", dimension: "time", magnitude: { numerator: "0", denominator: "1" }, unit: "s" },
    end: { kind: "quantity", dimension: "time", magnitude: { numerator: "9", denominator: "4" }, unit: "s" },
  };
  await assert.rejects(verifyLockedIrResources(fullLoop, root), /beyond the selected source bound/, "render-time revalidation cannot be bypassed by mutating locked IR");
});

test("cut.lock v3 derives a safe exact stream bound when Matroska omits stream.duration", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-stream-duration-")); await generatedUnevenAv(root);
  const source = `cut 0.4;
project "stream duration";
import { Video } from "cut:visual";
asset source: VideoAsset = video("media/uneven.mkv");
timeline main(duration: 1s, fps: 4, sampleRate: 48khz) { scene only(duration: 1s) { Video(source: source, range: 0s ..< 2s); } }
export out = render(main);`;
  const withinBound = compile(source.replace("0s ..< 2s", "0s ..< 1s"));
  const lock = await createCutLock(withinBound, root), probe = mediaProbe(lock, "source");
  assert.deepEqual(probe.selected.video?.duration, { numerator: "1", denominator: "1" }, "the DURATION tag must bind the actual selected picture stream, not the 2s container");
  assert.equal(probe.selected.audio, undefined, "a picture-only Video consumer must not select incidental container audio");
  await assert.rejects(createCutLock(compile(source), root), /beyond the selected source bound 1\/1s/);
});

test("reference visual decoding explicitly maps the cut.lock-selected video stream", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-stream-map-")); await generatedMultiVideo(root);
  const source = `cut 0.4;
project "stream map";
import { Video } from "cut:visual";
asset source: VideoAsset = video("media/streams.mkv", videoStream: 0);
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) { scene only(duration: 1s) { Video(source: source); } }
export out = render(main);`;
  const ir = compile(source), lock = await createCutLock(ir, root), probe = mediaProbe(lock, "source");
  assert.equal(probe.selected.video?.streamIndex, 0, "lock selection follows the authored absolute picture-stream index, not ffmpeg's default video selection");
  await applyCutLock(ir, lock, root);
  const composition = ir.compositions[0], scene = ir.scenes[composition.sceneIds[0]], renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "visual-map"));
  try {
    await renderer.prepare();
    const frame = await renderer.sceneFrame(scene, 0), offset = (32 * frame.width + 32) * 4;
    assert.ok(frame.data[offset] > frame.data[offset + 2] + 80, "the decoded frame must come from selected red stream 0, not default blue stream 1");
  } finally {
    renderer.close();
  }
});

test("reference audio decoding follows the explicit lock-selected stream index", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-audio-map-")); await generatedMultiAudio(root);
  const source = `cut 0.4;
project "audio stream map";
import { AudioClip } from "@cut/audio";
import { Waveform } from "@cut/data";
asset source: AudioAsset = audio("media/audio-streams.mkv", stream: 0);
timeline main(duration: 1s, fps: 24, width: 320px, height: 120px, sampleRate: 48khz) { scene only(duration: 1s) { AudioClip(source: source); Waveform(source: source); } }
export out = render(main);`;
  const ir = compile(source), lock = await createCutLock(ir, root), probe = mediaProbe(lock, "source");
  const audioStreams = probe.identity.streams.filter((stream) => stream.type === "audio");
  assert.deepEqual(audioStreams.map((stream) => stream.index), [0, 1]);
  assert.equal(probe.selected.audio?.streamIndex, 0, "the authored public stream selector selects absolute stream 0");
  await applyCutLock(ir, lock, root);

  // V2 validates that a selection names a real same-kind stream. The current
  // lock creator chooses the first one, but the decoder must still obey the
  // stored absolute stream index rather than FFmpeg's implicit `:a` choice.
  // Make the embedded selection point at the valid second stream to exercise
  // that runtime boundary directly; both fixture streams intentionally share
  // the same duration/time base metadata.
  const embedded = clone(ir.resources.source.metadata?.probe) as Extract<LockedResourceProbe, { kind: "media" }>;
  assert.equal(embedded.kind, "media");
  embedded.selected.audio = { ...embedded.selected.audio!, streamIndex: 1 };
  ir.resources.source.metadata = { ...ir.resources.source.metadata!, probe: embedded };
  const output = resolve(root, "selected.wav");
  await renderReferenceAudio(ir, ir.compositions[0], root, output);
  // At frame 600, the selected 220 Hz sine is at a negative peak. Stream 0 is
  // silence, so this proves the renderer did not use the first/default audio
  // selector implicitly.
  assert.ok(pcm24Sample(await readFile(output), 600) < -.05, "renderer must decode selected 220 Hz stream 1");

  const composition = ir.compositions[0], scene = ir.scenes[composition.sceneIds[0]];
  const waveform = async (streamIndex: number) => {
    const selected = clone(embedded); selected.selected.audio = { ...selected.selected.audio!, streamIndex };
    ir.resources.source.metadata = { ...ir.resources.source.metadata!, probe: selected };
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", `audio-analysis-${streamIndex}`));
    try { await renderer.prepare(); return (await renderer.sceneFrame(scene, 0)).data; }
    finally { renderer.close(); }
  };
  const silentWaveform = await waveform(0), toneWaveform = await waveform(1);
  assert.notEqual(
    createHash("sha256").update(silentWaveform).digest("hex"),
    createHash("sha256").update(toneWaveform).digest("hex"),
    "waveform analysis must decode the same explicit selected audio stream rather than FFmpeg's implicit selector",
  );
});

test("lock application rejects tampered probe metadata and stale runtime/native identities even when bytes are unchanged", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-stale-")); await generatedAv(root);
  const source = clipSource("Clip(source: media, range: 0s ..< 1s, duration: 1s);");
  const base = await createCutLock(compile(source), root);

  const tampered = clone(base), tamperedProbe = mediaProbe(tampered);
  tamperedProbe.identity.streams[0].codec = `${tamperedProbe.identity.streams[0].codec}-tampered`;
  await assert.rejects(applyCutLock(compile(source), tampered, root), /metadata or native probe identity changed/);

  const staleRuntime = clone(base); staleRuntime.toolchain.referenceRuntime = "cut-reference/stale";
  const staleRuntimeBackend = staleRuntime.toolchain.referenceBackend as unknown as { runtime: string; integrity: string; [key: string]: unknown };
  staleRuntimeBackend.runtime = staleRuntime.toolchain.referenceRuntime;
  staleRuntimeBackend.integrity = hash(Object.fromEntries(Object.entries(staleRuntimeBackend).filter(([key]) => key !== "integrity")));
  await assert.rejects(applyCutLock(compile(source), staleRuntime, root), /pins cut-reference\/stale/);

  const staleBackend = clone(base);
  staleBackend.toolchain.referenceBackend = createReferenceBackendIdentity(base.toolchain.referenceBackend.dependencies, {
    ...base.toolchain.referenceBackend.native,
    libvips: `${base.toolchain.referenceBackend.native.libvips}-stale`,
  }, base.toolchain.referenceBackend.compositor);
  await assert.rejects(applyCutLock(compile(source), staleBackend, root), /reference backend identity does not match this installation/);

  const staleCompositor = clone(base), selected = base.toolchain.referenceBackend.compositor;
  staleCompositor.toolchain.referenceBackend = createReferenceBackendIdentity(
    base.toolchain.referenceBackend.dependencies,
    base.toolchain.referenceBackend.native,
    selected.mode === "native"
      ? { ...selected, binarySha256: selected.binarySha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) }
      : {
        mode: "native",
        platform: selected.platform,
        architecture: selected.architecture,
        algorithm: selected.algorithm,
        binarySha256: "0".repeat(64),
      },
  );
  await assert.rejects(applyCutLock(compile(source), staleCompositor, root), /reference backend identity does not match this installation/);

  const staleCompiler = clone(base); staleCompiler.toolchain.compiler = "cut-ts/stale";
  await assert.rejects(applyCutLock(compile(source), staleCompiler, root), /pins cut-ts\/stale/);

  const staleAbi = clone(base); staleAbi.toolchain.packageAbi += 1;
  await assert.rejects(applyCutLock(compile(source), staleAbi, root), /pins package ABI/);

  const stalePackage = clone(base); stalePackage.packages[0].integrity = "0".repeat(64);
  await assert.rejects(applyCutLock(compile(source), stalePackage, root), /package signatures do not match/);

  const staleNative = clone(base), staleProbe = mediaProbe(staleNative);
  staleProbe.identity.implementation.version = `${staleProbe.identity.implementation.version}-stale`;
  await assert.rejects(applyCutLock(compile(source), staleNative, root), /metadata or native probe identity changed/);

  const changed = resolve(root, "media/source.mkv"), original = await readFile(changed);
  await writeFile(changed, Buffer.concat([original, Buffer.from([0])]));
  await assert.rejects(applyCutLock(compile(source), base, root), /Locked resource bytes changed/);
});

test("image, audio-only, and bytes-only resources carry their precise cut.lock v3 metadata boundaries", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-image-")); await mkdir(resolve(root, "media"));
  await sharp({ create: { width: 7, height: 5, channels: 4, background: { r: 30, g: 90, b: 150, alpha: 0.5 } } }).png().toFile(resolve(root, "media/not-an-image-extension.bin"));
  await writeFile(resolve(root, "media/data.json"), "{\"answer\":42}\n");
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", "pcm_s24le", resolve(root, "media/voice.wav")]);
  const source = `cut 0.4;
project "image identity";
import { Image } from "cut:visual";
import { AudioClip } from "@cut/audio";
asset picture: ImageAsset = image("media/not-an-image-extension.bin");
asset facts: DataAsset = data("media/data.json");
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { scene only(duration: 1s) { Image(source: picture); AudioClip(source: voice, range: 0s ..< 1s); } }
export out = render(main);`;
  const lock = await createCutLock(compile(source), root), image = lock.resources.picture.probe, data = lock.resources.facts.probe, voice = lock.resources.voice.probe;
  assert.equal(image.kind, "image");
  if (image.kind === "image") {
    assert.deepEqual({ width: image.identity.image.width, height: image.identity.image.height, format: image.identity.image.format }, { width: 7, height: 5, format: "png" });
    assert.ok(image.identity.image.space.length > 0); assert.equal(image.identity.image.channels, 4); assert.equal(image.identity.image.hasAlpha, true);
    assert.equal(image.identity.implementation.name, "sharp"); assert.ok(image.identity.implementation.version); assert.ok(image.identity.implementation.libvips);
  }
  assert.equal(data.kind, "bytes");
  if (data.kind === "bytes") assert.deepEqual(data.coverage, { level: "bytes-only", excludes: ["data schema", "semantic interpretation", "external references"] });
  assert.equal(voice.kind, "media");
  if (voice.kind === "media") {
    assert.ok(voice.selected.audio); assert.equal(voice.selected.video, undefined);
    const selected = voice.identity.streams.find((stream) => stream.index === voice.selected.audio?.streamIndex);
    assert.equal(selected?.type, "audio"); assert.equal(selected?.sampleRate, 48_000); assert.ok(selected?.channels);
  }
});

test("v3 validation is closed, budgeted, canonical, and refuses historical v1/v2 locks with regenerate guidance", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-validate-")); await generatedAv(root);
  const source = clipSource("Clip(source: media, range: 0s ..< 1s, duration: 1s);");
  const first = await createCutLock(compile(source), root), second = await createCutLock(compile(source), root);
  assert.equal(JSON.stringify(first, null, 2), JSON.stringify(second, null, 2), "equivalent inputs must serialize identically");
  assert.ok(Object.isFrozen(loadCutLock(JSON.stringify(first))), "loaded locks are immutable snapshots");

  for (const version of [1, 2] as const) {
    const legacy = { ...clone(first), version };
    assert.throws(
      () => validateCutLock(legacy),
      (error) => error instanceof CutLockError
        && error.code === "CUT_LOCK_VERSION"
        && error.path === "$.version"
        && /regenerate.*current `cut lock`.*automatic migration is unsafe/iu.test(error.message),
    );
    assert.throws(
      () => analyzeCutMigration(Buffer.from(JSON.stringify(legacy)), { path: `legacy-v${version}.lock` }),
      (error) => error instanceof CutMigrationError
        && error.code === `CUT_MIGRATE_LOCK_V${version}_UNSAFE`
        && /regenerate v3.*current `cut lock`/iu.test(error.message),
    );
  }
  assert.deepEqual(
    cutMigrationCompatibilityMatrix
      .filter((row) => row.artifact === "cut-lock")
      .map(({ version, compatibility }) => ({ version, compatibility })),
    [
      { version: "3", compatibility: "current" },
      { version: "2", compatibility: "unsafe" },
      { version: "1", compatibility: "unsafe" },
    ],
  );
  const unknown = { ...clone(first), surprise: true };
  assert.throws(() => validateCutLock(unknown), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_UNKNOWN_FIELD" && error.path === "$.surprise");
  const nested = clone(first); (nested.resources.media.probe as unknown as Record<string, unknown>).surprise = true;
  assert.throws(() => validateCutLock(nested), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_UNKNOWN_FIELD");
  const backendTamper = clone(first); (backendTamper.toolchain.referenceBackend.native as { libvips: string }).libvips = `${backendTamper.toolchain.referenceBackend.native.libvips}-tampered`;
  assert.throws(() => validateCutLock(backendTamper), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_IDENTITY" && /backend identity/.test(error.message));
  const compositorTamper = clone(first); (compositorTamper.toolchain.referenceBackend.compositor as { algorithm: string }).algorithm += "-tampered";
  assert.throws(() => validateCutLock(compositorTamper), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_IDENTITY" && /backend identity/.test(error.message));
  const legacyBackend = clone(first) as unknown as { toolchain: { referenceBackend: Record<string, unknown> } };
  legacyBackend.toolchain.referenceBackend.version = 1;
  delete legacyBackend.toolchain.referenceBackend.compositor;
  assert.throws(() => validateCutLock(legacyBackend), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_VERSION" && /cut-reference-backend v2/.test(error.message));
  const foreignBackend = clone(first);
  foreignBackend.toolchain.referenceBackend = createReferenceBackendIdentity(
    first.toolchain.referenceBackend.dependencies,
    { ...first.toolchain.referenceBackend.native, architecture: `${first.toolchain.referenceBackend.native.architecture}-other` },
    { ...first.toolchain.referenceBackend.compositor, architecture: `${first.toolchain.referenceBackend.compositor.architecture}-other` },
  );
  const deferred = compile(source);
  const binding = await applyCutLockForVerifiedInputSession(deferred, foreignBackend, root);
  assert.equal(deferred.determinism.semantic, "locked", "deferred application must leave backend collection to the post-snapshot execution boundary");
  assert.deepEqual(binding.referenceBackend, foreignBackend.toolchain.referenceBackend, "the internal bridge must return the validated identity that execution is required to compare");
  await assert.rejects(applyCutLock(compile(source), foreignBackend, root), (error: unknown) => error instanceof CutLockError
    && error.code === "CUT_LOCK_IDENTITY"
    && error.path === "$.toolchain.referenceBackend", "ordinary/full lock application must retain its immediate complete-backend check");
  assert.throws(() => validateCutLock(first, { limits: { maxStreamsPerResource: 1 } }), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_LIMIT");
  assert.throws(() => validateCutLock(first, { limits: { maxInputBytes: Number.MAX_SAFE_INTEGER } }), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_LIMIT");
  const encoded = JSON.stringify(first).replace('"format":"cut-lock"', '"format":"cut-lock","\\u0066ormat":"cut-lock"');
  assert.throws(() => loadCutLock(encoded), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_JSON_DUPLICATE_KEY");
  assert.throws(() => loadCutLock(JSON.stringify(first), { limits: { maxInputBytes: 10 } }), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_INPUT_TOO_LARGE");
  assert.throws(() => loadCutLock(new Uint8Array([0xff, 0xff, 0xff]), { limits: { maxInputBytes: 2 } }), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_INPUT_TOO_LARGE", "raw byte budget must win before UTF-8 decoding");
  assert.throws(() => loadCutLock(new Uint8Array([0x7b, 0xff, 0x7d])), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_JSON_ENCODING");
  assert.throws(() => loadCutLock("\ud800"), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_JSON_ENCODING");
  assert.throws(() => loadCutLock('{"\\ud800":null}'), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_JSON_ENCODING");
  assert.throws(() => loadCutLock("[[0]]", { limits: { maxJsonDepth: 1 } }), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_LIMIT");
  assert.throws(() => loadCutLock("[0,0]", { limits: { maxJsonNodes: 2 } }), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_LIMIT");

  assert.ok(first.packages.length > 1, "fixture has multiple package identities to canonicalize");
  const unsortedPackages = clone(first); unsortedPackages.packages.reverse();
  assert.throws(() => validateCutLock(unsortedPackages), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_IDENTITY" && /sorted/.test(error.message));
  const unsortedProbe = clone(first), probe = mediaProbe(unsortedProbe);
  probe.identity.container.names.reverse();
  assert.throws(() => validateCutLock(unsortedProbe), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_IDENTITY" && /sorted/.test(error.message));
  const containerFallback = clone(first), selected = mediaProbe(containerFallback).selected.video!;
  (selected as unknown as { durationSource: string }).durationSource = "container";
  selected.duration = clone(mediaProbe(containerFallback).identity.container.duration!);
  assert.throws(() => validateCutLock(containerFallback), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_METADATA" && /container-wide duration/.test(error.message));
});

test("v3 lock creation refuses traversal and physical symlink escape before probing", { timeout: 60_000 }, async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-root-")), outside = await mkdtemp(resolve(tmpdir(), "cut-lock-v2-outside-")); await generatedAv(outside, "outside.mkv", 1);
  const traversal = compile(clipSource("Clip(source: media, duration: 1s);").replace("media/source.mkv", "../outside.mkv"));
  await assert.rejects(createCutLock(traversal, root), /project-relative POSIX path|parent segments/);

  if (process.platform === "win32") { context.skip("symlink creation is not portable in this test environment"); return; }
  await mkdir(resolve(root, "media"), { recursive: true });
  await symlink(resolve(outside, "media/outside.mkv"), resolve(root, "media/source.mkv"));
  const escaped = compile(clipSource("Clip(source: media, duration: 1s);"));
  await assert.rejects(createCutLock(escaped, root), /escapes the project root/);
});
