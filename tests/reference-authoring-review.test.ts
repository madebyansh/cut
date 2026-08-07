import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock, CutLockError } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import {
  parseReferenceContactFrames,
  parseReferencePreviewRange,
  parseReferenceReviewTime,
  parseReferenceSampleRange,
  inspectReferencePcm24WaveBytesForTest,
  rasterReferenceContactLabelForTest,
  ReferenceAuthoringReviewError,
  renderReferenceAudioAuditionArtifact,
  renderReferenceContactSheetArtifact,
  renderReferenceFrameArtifact,
  renderReferencePreviewArtifact,
} from "../lib/runtime/reference/authoring-review";
import type { ReferenceLoudnessReport } from "../lib/runtime/reference/audio";
import type { ReferenceAacDeliveryReport } from "../lib/runtime/reference/delivery";
import { runFfmpeg, runFfprobeCapture } from "../lib/runtime/reference/ffmpeg";
import { collectReferenceBackendIdentity, type CutReferenceBackendIdentity } from "../lib/runtime/reference/runtime-identity";
import { renderReferenceIr } from "./reference-render-test-helper";

const source = `cut 0.4;
project "Authoring review";
import { Rect } from "cut:visual";
import { Bus, Tone } from "@cut/audio";

timeline main(duration: 2s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  Bus(name: "dialogue", role: "dialogue") {
    Tone(frequency: 440hz, duration: 2s, amplitude: 20%);
  }
  scene red(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #ef233c);
  }
  scene blue(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #2667ff);
  }
}

export out = render(main, width: 64px, height: 36px, codec: "h264");
`;

function compile(program = source) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

async function locked(root: string, program = source) {
  const ir = compile(program), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { ir, lock };
}

function reviewError(code: ReferenceAuthoringReviewError["code"]) {
  return (error: unknown) => error instanceof ReferenceAuthoringReviewError && error.code === code;
}

function pcm24Payload(bytes: Buffer) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const id = bytes.toString("ascii", cursor, cursor + 4), size = bytes.readUInt32LE(cursor + 4), body = cursor + 8;
    if (id === "data") return bytes.subarray(body, body + size);
    cursor = body + size + (size % 2);
  }
  throw new Error("missing data chunk");
}

function pcm24Frames(bytes: Buffer) { return pcm24Payload(bytes).byteLength / 6; }

function extensiblePcm24Wave() {
  const bytes = Buffer.alloc(74);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(40, 16);
  bytes.writeUInt16LE(0xfffe, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48_000, 24); bytes.writeUInt32LE(48_000 * 6, 28); bytes.writeUInt16LE(6, 32); bytes.writeUInt16LE(24, 34);
  bytes.writeUInt16LE(22, 36); bytes.writeUInt16LE(24, 38); bytes.writeUInt32LE(3, 40); Buffer.from("0100000000001000800000aa00389b71", "hex").copy(bytes, 44);
  bytes.write("data", 60, "ascii"); bytes.writeUInt32LE(6, 64);
  return bytes;
}

test("exact review selectors reject rounding, ambiguity, ordering, and hostile shapes", () => {
  assert.deepEqual(parseReferenceReviewTime("1001/24000s"), { numerator: "1001", denominator: "24000" });
  assert.deepEqual(parseReferenceReviewTime("1.25s"), { numerator: "5", denominator: "4" });
  assert.deepEqual(parseReferenceSampleRange("48000:96000"), { start: 48_000, end: 96_000 });
  assert.deepEqual(parseReferenceContactFrames("0,4,7"), [0, 4, 7]);
  assert.deepEqual(parseReferencePreviewRange("500ms:3/2s"), { start: { numerator: "1", denominator: "2" }, end: { numerator: "3", denominator: "2" } });
  assert.throws(() => parseReferenceSampleRange("96000:48000"), reviewError("CUT_REVIEW_TOOL_SAMPLE_RANGE"));
  assert.throws(() => parseReferenceContactFrames("4,0"), reviewError("CUT_REVIEW_TOOL_FRAME_ORDER"));
  assert.throws(() => parseReferenceContactFrames("0,0"), reviewError("CUT_REVIEW_TOOL_FRAME_ORDER"));
  assert.throws(() => parseReferenceReviewTime("1e3s"), reviewError("CUT_REVIEW_TOOL_TIME"));
  assert.throws(() => parseReferencePreviewRange("1s:1s"), reviewError("CUT_REVIEW_TOOL_TIME"));

  const hostileLabel = "F9007199254740991", raster = rasterReferenceContactLabelForTest(136, 40, hostileLabel, { left: 0, top: 0, right: 64, bottom: 20 });
  assert.equal(raster.label, hostileLabel, "the manifest label remains the full exact identity even when visible pixels clip");
  for (let pixel = 0; pixel < 136 * 40; pixel += 1) {
    if (raster.data[pixel * 4 + 3] === 0) continue;
    assert.ok(pixel % 136 < 64 && Math.floor(pixel / 136) < 20, `label pixel escaped its cell at ${pixel % 136},${Math.floor(pixel / 136)}`);
  }

  const extensible = extensiblePcm24Wave();
  assert.doesNotThrow(() => inspectReferencePcm24WaveBytesForTest(extensible, 48_000, 1));
  const hostileGuid = Buffer.from(extensible); hostileGuid[59] ^= 0xff;
  assert.throws(() => inspectReferencePcm24WaveBytesForTest(hostileGuid, 48_000, 1), reviewError("CUT_REVIEW_TOOL_WAVE"));
});

test("authoring review rejects a complete backend mismatch after input binding and before artifact publication", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-review-backend-"));
  try {
    const { ir } = await locked(root), actual = await collectReferenceBackendIdentity();
    const mismatched = {
      ...actual,
      native: { ...actual.native, architecture: `${actual.native.architecture}-other` },
    } as CutReferenceBackendIdentity;
    const output = resolve(root, "review", "must-not-exist.png");

    await assert.rejects(renderReferenceFrameArtifact(ir, root, output, {
      frame: 0,
      __lockedReferenceBackend: mismatched,
    }), (error: unknown) => error instanceof CutLockError
      && error.code === "CUT_LOCK_IDENTITY"
      && error.path === "$.toolchain.referenceBackend");
    await assert.rejects(readFile(output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    await assert.rejects(readFile(`${output}.manifest.json`), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("frame and contact artifacts use exact sequential compositor frames and deterministic PNG manifests", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-review-frame-"));
  try {
    const { ir } = await locked(root), output = resolve(root, "review/frame.png");
    const first = await renderReferenceFrameArtifact(ir, root, output, { frame: "4", mediaProfile: "master" });
    assert.equal(first.format, "cut-reference-frame");
    assert.deepEqual(first.frame, { index: 4, timestamp: { numerator: "1", denominator: "1" }, sceneId: ir.compositions[0].sceneIds[1], scene: "blue", sceneFrame: 0 });
    assert.deepEqual(first.media, { requested: "master", selectedProxyResources: 0, fallbackResources: 0, resources: [] });
    const decoded = await sharp(await readFile(output)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual({ width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels }, { width: 64, height: 36, channels: 4 });
    const center = (18 * 64 + 32) * 4;
    assert.ok(decoded.data[center + 2] > 220 && decoded.data[center] < 80, `expected blue second scene, observed ${[...decoded.data.subarray(center, center + 4)]}`);
    const onTime = await renderReferenceFrameArtifact(ir, root, resolve(root, "review/frame-at.png"), { at: "1s", mediaProfile: "master" });
    assert.equal(onTime.artifact.rgbaSha256, first.artifact.rgbaSha256);
    assert.equal(onTime.artifact.sha256, first.artifact.sha256, "identical exact frame and backend must produce identical PNG bytes");
    assert.equal(JSON.parse(await readFile(`${output}.manifest.json`, "utf8")).artifact.sha256, first.artifact.sha256);

    const contact = await renderReferenceContactSheetArtifact(ir, root, resolve(root, "review/contact.png"), {
      frames: "0,3,4,7",
      columns: "2",
      thumbnailWidth: "64",
      mediaProfile: "proxy",
    });
    assert.equal(contact.media.requested, "proxy");
    assert.deepEqual(contact.frames.map((item) => [item.index, item.scene, item.sceneFrame, item.label]), [
      [0, "red", 0, "F0"], [3, "red", 3, "F3"], [4, "blue", 0, "F4"], [7, "blue", 3, "F7"],
    ]);
    assert.equal(new Set(contact.frames.slice(0, 2).map((item) => item.rgbaSha256)).size, 1);
    assert.equal(new Set(contact.frames.slice(2).map((item) => item.rgbaSha256)).size, 1);
    assert.notEqual(contact.frames[0].rgbaSha256, contact.frames[2].rgbaSha256);
    assert.deepEqual(await sharp(resolve(root, "review/contact.png")).metadata().then(({ width, height }) => ({ width, height })), { width: 136, height: 120 });

    await assert.rejects(renderReferenceFrameArtifact(ir, root, resolve(root, "review/off-grid.png"), { at: "1/3s" }), reviewError("CUT_REVIEW_TOOL_TIME_GRID"));
    await assert.rejects(renderReferenceFrameArtifact(ir, root, resolve(root, "review/outside.png"), { frame: 8 }), reviewError("CUT_REVIEW_TOOL_FRAME_RANGE"));
    await assert.rejects(renderReferenceFrameArtifact(ir, root, resolve(root, "review/ambiguous.png"), { frame: 0, at: "0s" }), reviewError("CUT_REVIEW_TOOL_CONTRACT"));
    await assert.rejects(renderReferenceFrameArtifact(ir, root, resolve(root, "review/unknown.png"), { frame: 0, ignored: true }), reviewError("CUT_REVIEW_TOOL_CONTRACT"));
    await assert.rejects(renderReferenceContactSheetArtifact(ir, root, resolve(root, "review/order.png"), { frames: "4,0" }), reviewError("CUT_REVIEW_TOOL_FRAME_ORDER"));
    await assert.rejects(renderReferenceContactSheetArtifact(ir, root, resolve(root, "review/columns.png"), { frames: "0", columns: 9 }), reviewError("CUT_REVIEW_TOOL_RESOURCE_LIMIT"));

    const escaped = resolve(root, "../escaped-review.png");
    await assert.rejects(renderReferenceFrameArtifact(ir, root, escaped, { frame: 0 }), reviewError("CUT_REVIEW_TOOL_OUTPUT"));
    await assert.rejects(readFile(escaped), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio audition executes an exact half-open master or authored-stem range before WAVE serialization", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-review-audio-"));
  try {
    const { ir } = await locked(root), masterPath = resolve(root, "review/master.wav");
    const master = await renderReferenceAudioAuditionArtifact(ir, root, masterPath, { samples: "4800:9600", mediaProfile: "master" });
    assert.equal(master.format, "cut-reference-audio-audition");
    assert.deepEqual(master.range, {
      semantics: "half-open", startSample: 4_800, endSample: 9_600,
      start: { numerator: "1", denominator: "10" }, end: { numerator: "1", denominator: "5" }, duration: { numerator: "1", denominator: "10" },
    });
    assert.equal(master.selection.kind, "master");
    assert.equal(master.artifact.samples, 4_800);
    assert.equal(pcm24Frames(await readFile(masterPath)), 4_800);
    const fullPath = resolve(root, "review/full-prefix.wav"), shiftedPath = resolve(root, "review/shifted.wav");
    await renderReferenceAudioAuditionArtifact(ir, root, fullPath, { samples: "0:9601" });
    const shifted = await renderReferenceAudioAuditionArtifact(ir, root, shiftedPath, { samples: "4801:9601" });
    const fullPcm = pcm24Payload(await readFile(fullPath)), shiftedPcm = pcm24Payload(await readFile(shiftedPath));
    assert.equal(shifted.artifact.samples, 4_800);
    assert.deepEqual(shiftedPcm.subarray(0, 32 * 6), fullPcm.subarray(4_801 * 6, (4_801 + 32) * 6), "audition start must select the authored graph at exact sample 4801");
    assert.notDeepEqual(shiftedPcm.subarray(0, 32 * 6), fullPcm.subarray(0, 32 * 6), "sample start cannot be ignored while preserving only output length");
    const stem = await renderReferenceAudioAuditionArtifact(ir, root, resolve(root, "review/dialogue.wav"), { samples: "4800:9600", stem: "dialogue", mediaProfile: "proxy" });
    assert.equal(stem.selection.kind, "stem");
    if (stem.selection.kind === "stem") assert.deepEqual({ name: stem.selection.name, role: stem.selection.role, stage: stem.selection.stage }, { name: "dialogue", role: "dialogue", stage: "pre-master-bus-stem" });
    assert.equal(stem.media.requested, "proxy");
    assert.equal(stem.artifact.samples, 4_800);
    await assert.rejects(renderReferenceAudioAuditionArtifact(ir, root, resolve(root, "review/bad.wav"), { samples: "0:96001" }), reviewError("CUT_REVIEW_TOOL_SAMPLE_RANGE"));
    await assert.rejects(renderReferenceAudioAuditionArtifact(ir, root, resolve(root, "review/missing.wav"), { samples: "0:10", stem: "music" }), reviewError("CUT_REVIEW_TOOL_STEM"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review extraction verifies locked resource bytes and canonical graph identity before publication", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-review-lock-"));
  const program = `cut 0.4;
project "Review lock";
import { Image } from "cut:visual";
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 4, width: 32px, height: 32px) {
  scene only(duration: 1s) { Image(source: still); }
}
export out = render(main, width: 32px, height: 32px, codec: "h264");
`;
  try {
    await mkdir(resolve(root, "media"));
    await sharp({ create: { width: 32, height: 32, channels: 4, background: "#35a853" } }).png().toFile(resolve(root, "media/still.png"));
    const { ir } = await locked(root, program);
    const stale = structuredClone(ir) as CutAVIR;
    stale.project = "mutated without rebuilding";
    await assert.rejects(renderReferenceFrameArtifact(stale, root, resolve(root, "stale.png"), { frame: 0 }), reviewError("CUT_REVIEW_TOOL_IR_IDENTITY"));
    const drifted = Buffer.from(await readFile(resolve(root, "media/still.png")));
    drifted[Math.floor(drifted.byteLength / 2)] ^= 1;
    await writeFile(resolve(root, "media/still.png"), drifted);
    await assert.rejects(renderReferenceFrameArtifact(ir, root, resolve(root, "bad-selector.png"), { at: "not-a-time" }), reviewError("CUT_REVIEW_TOOL_TIME"));
    await assert.rejects(renderReferenceFrameArtifact(ir, root, resolve(root, "bad-profile.png"), { frame: 0, mediaProfile: "thumbnail" }), reviewError("CUT_REVIEW_TOOL_CONTRACT"));
    await assert.rejects(renderReferenceFrameArtifact(ir, root, resolve(root, "drift.png"), { frame: 0 }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_LOCK_INTEGRITY"));
    await assert.rejects(readFile(resolve(root, "drift.png")), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded preview executes exact picture/audio clocks, deterministic downscale, replay, and transactional publication", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-review-preview-"));
  const previewSource = `cut 0.4;
project "Bounded preview";
import { Rect } from "cut:visual";
import { Tone } from "@cut/audio";
timeline main(duration: 2s, fps: 4, width: 128px, height: 72px, sampleRate: 48khz) {
  Tone(frequency: 440hz, duration: 2s, amplitude: 10%);
  scene red(duration: 1s) { Rect(width: 128px, height: 72px, x: 64px, y: 36px, fill: #ef233c); }
  scene blue(duration: 1s) { Rect(width: 128px, height: 72px, x: 64px, y: 36px, fill: #2667ff); }
}
export preview = render(main, width: 128px, height: 72px, codec: "h264");
`;
  try {
    const { ir } = await locked(root, previewSource), output = resolve(root, "review/range.mp4");
    const first = await renderReferencePreviewArtifact(ir, root, output, { range: "500ms:1500ms", width: "64", mediaProfile: "proxy" });
    assert.equal(first.format, "cut-reference-range-preview");
    assert.deepEqual(first.range, {
      semantics: "half-open",
      start: { numerator: "1", denominator: "2" }, end: { numerator: "3", denominator: "2" }, duration: { numerator: "1", denominator: "1" },
      firstFrame: 2, endFrameExclusive: 6, frames: 4,
      startSample: 24_000, endSampleExclusive: 72_000, samples: 48_000,
    });
    assert.deepEqual(first.canvas, { sourceWidth: 128, sourceHeight: 72, width: 64, height: 36, resize: "lanczos3-v1", aspect: "preserved-exactly" });
    assert.deepEqual(
      {
        picture: first.execution.picture,
        audio: first.execution.audio,
        audioState: first.execution.audioState,
        profile: first.execution.inputProfile,
      },
      {
        picture: "selected-frames-only",
        audio: "selected-samples-serialized",
        audioState: "causal-history-executed-from-zero",
        profile: "proxy",
      },
    );
    assert.equal("roots" in first.execution, false, "top-level counters cannot imply graph execution on a cache-authorized slice");
    assert.equal("filters" in first.execution, false, "top-level counters cannot imply graph execution on a cache-authorized slice");
    assert.deepEqual(
      {
        version: first.version,
        status: first.execution.cache.status,
        reason: first.execution.cache.reason,
        verification: first.execution.cache.artifact.verification,
        publication: first.execution.cache.publication,
      },
      {
        version: 4,
        status: "miss",
        reason: "CUT_PREVIEW_PICTURE_CACHE_COLD",
        verification: "sha256+bytes+h264-decoded-contract",
        publication: "atomic-no-clobber",
      },
    );
    assert.equal(first.execution.audioSource.mode, "selected-execution");
    if (first.execution.audioSource.mode === "selected-execution") {
      assert.equal(first.execution.audioSource.selection.status, "miss");
      assert.equal(first.execution.audioSource.selection.reason, "CUT_AUDIO_CACHE_COLD");
      assert.equal(first.execution.audioSource.graphExecution, "causal-history-from-zero-through-selected-end");
      assert.ok(first.execution.audioSource.execution.filters >= 1);
      assert.deepEqual(
        {
          startSample: first.execution.audioSource.artifact.startSample,
          endSampleExclusive: first.execution.audioSource.artifact.endSampleExclusive,
          samples: first.execution.audioSource.artifact.samples,
          bytes: first.execution.audioSource.artifact.bytes,
        },
        { startSample: 24_000, endSampleExclusive: 72_000, samples: 48_000, bytes: 384_000 },
      );
      assert.match(first.execution.audioSource.artifact.sha256, /^[a-f0-9]{64}$/u);
    }
    const probe = JSON.parse((await runFfprobeCapture([
      "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,nb_read_frames:format=duration", "-of", "json", output,
    ])).stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number; nb_read_frames?: string }>; format: { duration: string } };
    const video = probe.streams.find((stream) => stream.codec_type === "video"), audio = probe.streams.find((stream) => stream.codec_type === "audio");
    assert.deepEqual({ width: video?.width, height: video?.height, frames: video?.nb_read_frames }, { width: 64, height: 36, frames: "4" });
    assert.ok(audio, "preview must contain the exact selected authored audio graph");
    assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.03, `expected one-second delivery, observed ${probe.format.duration}`);
    const decodedFrames = resolve(root, "review/range.rgb");
    await runFfmpeg(["-y", "-v", "error", "-i", output, "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", decodedFrames]);
    const rgb = await readFile(decodedFrames), frameBytes = 64 * 36 * 3;
    assert.equal(rgb.byteLength, 4 * frameBytes, "decoded range must contain exactly the selected four frames");
    const firstPixel = [...rgb.subarray(0, 3)], lastPixel = [...rgb.subarray(3 * frameBytes, 3 * frameBytes + 3)];
    assert.ok(firstPixel[0] > firstPixel[2] + 100, `first selected frame 2 must still be the red scene: ${firstPixel}`);
    assert.ok(lastPixel[2] > lastPixel[0] + 100, `last selected frame 5 must be the blue scene: ${lastPixel}`);
    const cachedPicture = resolve(root, ...first.execution.cache.artifact.locator.split("/"));
    const originalPictureBytes = await readFile(cachedPicture);
    await writeFile(cachedPicture, Buffer.from("corrupt preview picture cache"));
    const rebuilt = await renderReferencePreviewArtifact(ir, root, resolve(root, "review/rebuilt.mp4"), { range: "500ms:1500ms", width: "64" });
    assert.deepEqual(
      { status: rebuilt.execution.cache.status, reason: rebuilt.execution.cache.reason, key: rebuilt.execution.cache.key },
      { status: "rebuilt", reason: "CUT_PREVIEW_PICTURE_CACHE_CORRUPT", key: first.execution.cache.key },
    );
    assert.deepEqual(await readFile(cachedPicture), originalPictureBytes, "corrupt immutable picture bytes must be rebuilt deterministically");
    assert.equal(rebuilt.artifact.sha256, first.artifact.sha256);

    const replay = await renderReferencePreviewArtifact(ir, root, resolve(root, "review/replay.mp4"), { range: "500ms:1500ms", width: "64" });
    assert.equal(replay.artifact.sha256, first.artifact.sha256, "same canonical range/backend must replay to identical MP4 bytes");
    assert.deepEqual(
      { status: replay.execution.cache.status, reason: replay.execution.cache.reason, key: replay.execution.cache.key },
      { status: "hit", reason: "CUT_PREVIEW_PICTURE_CACHE_HIT", key: first.execution.cache.key },
    );

    const audioEdited = await locked(root, previewSource.replace("440hz", "660hz"));
    const audioOnly = await renderReferencePreviewArtifact(audioEdited.ir, root, resolve(root, "review/audio-only.mp4"), { range: "500ms:1500ms", width: "64" });
    assert.equal(audioOnly.execution.cache.status, "hit", "an audio-only edit must preserve selected picture-range bytes");
    assert.equal(audioOnly.execution.cache.key, first.execution.cache.key);

    const pictureEdited = await locked(root, previewSource.replace("#ef233c", "#f97316"));
    const visualChange = await renderReferencePreviewArtifact(pictureEdited.ir, root, resolve(root, "review/visual-change.mp4"), { range: "500ms:1500ms", width: "64" });
    assert.equal(visualChange.execution.cache.status, "miss", "a selected picture edit must invalidate its range artifact");
    assert.notEqual(visualChange.execution.cache.key, first.execution.cache.key);

    const otherRange = await renderReferencePreviewArtifact(ir, root, resolve(root, "review/other-range.mp4"), { range: "0s:1s", width: "64" });
    assert.equal(otherRange.execution.cache.status, "miss");
    assert.notEqual(otherRange.execution.cache.key, first.execution.cache.key, "exact half-open range is part of picture-cache identity");

    await assert.rejects(renderReferencePreviewArtifact(ir, root, resolve(root, "review/off-grid.mp4"), { range: "1/3s:1s", width: 64 }), reviewError("CUT_REVIEW_TOOL_TIME_GRID"));
    await assert.rejects(renderReferencePreviewArtifact(ir, root, resolve(root, "review/outside.mp4"), { range: "1s:3s", width: 64 }), reviewError("CUT_REVIEW_TOOL_FRAME_RANGE"));
    await assert.rejects(renderReferencePreviewArtifact(ir, root, resolve(root, "review/upscale.mp4"), { range: "0s:1s", width: 256 }), reviewError("CUT_REVIEW_TOOL_RESOURCE_LIMIT"));
    await assert.rejects(renderReferencePreviewArtifact(ir, root, resolve(root, "review/shape.mp4"), { range: "0s:1s", width: 64, ignored: true }), reviewError("CUT_REVIEW_TOOL_CONTRACT"));
    const escaped = resolve(root, "../escaped-preview.mp4");
    await assert.rejects(renderReferencePreviewArtifact(ir, root, escaped, { range: "0s:1s", width: 64 }), reviewError("CUT_REVIEW_TOOL_OUTPUT"));

    const oldOutput = await readFile(output), oldManifest = await readFile(`${output}.manifest.json`);
    await assert.rejects(renderReferencePreviewArtifact(ir, root, output, {
      range: "0s:1s", width: 64,
      __testPublicationHooks: { fault(point: { phase: string; timing: string; role?: string }) {
        if (point.phase === "promotion" && point.timing === "before" && point.role === "range-preview-manifest") throw new Error("injected preview manifest failure");
      } },
    }));
    assert.deepEqual(await readFile(output), oldOutput);
    assert.deepEqual(await readFile(`${output}.manifest.json`), oldManifest);
    const cacheEntries = await readdir(resolve(root, ".cut/cache/reference/preview-picture"));
    assert.deepEqual(cacheEntries.filter((entry) => entry.startsWith(".cut-preview-picture-build-")), [], "preview-picture staging directories must be cleaned after success and publication failure");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unrelated moving preview uses atomic no-clobber range publication without mutating canonical source", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-review-moving-preview-cache-"));
  const movingSource = `cut 0.4;
project "Moving preview cache";
import { Group, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Group() as mover {
      Rect(width: 16px, height: 12px, x: 32px, y: 18px, fill: #22c55e);
    }
    animate mover.x from -12px to 12px over 1s;
  }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");
`;
  try {
    const sourcePath = resolve(root, "main.cut");
    await writeFile(sourcePath, movingSource);
    const canonicalSource = await readFile(sourcePath);
    const { ir } = await locked(root, movingSource);
    const [left, right] = await Promise.all([
      renderReferencePreviewArtifact(ir, root, resolve(root, "left.mp4"), { range: "0s:1s", width: 64 }),
      renderReferencePreviewArtifact(ir, root, resolve(root, "right.mp4"), { range: "0s:1s", width: 64 }),
    ]);
    assert.equal(left.execution.cache.key, right.execution.cache.key);
    assert.equal(left.execution.cache.artifact.sha256, right.execution.cache.artifact.sha256);
    assert.equal(left.artifact.sha256, right.artifact.sha256, "concurrent immutable-cache publication must preserve deterministic delivery");
    assert.ok(
      [left.execution.cache.publication, right.execution.cache.publication].includes("atomic-no-clobber"),
      "at least one concurrent builder must win the immutable no-clobber publication",
    );
    assert.deepEqual(await readFile(sourcePath), canonicalSource, "preview rendering and cache publication must not rewrite canonical CUT source");

    const replay = await renderReferencePreviewArtifact(ir, root, resolve(root, "replay.mp4"), { range: "0s:1s", width: 64 });
    assert.equal(replay.execution.cache.status, "hit");
    assert.equal(replay.execution.cache.key, left.execution.cache.key);

    const decoded = resolve(root, "moving.rgb");
    await runFfmpeg(["-y", "-v", "error", "-i", resolve(root, "replay.mp4"), "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", decoded]);
    const rgb = await readFile(decoded), frameBytes = 64 * 36 * 3;
    assert.equal(rgb.byteLength, frameBytes * 4);
    assert.notDeepEqual(
      rgb.subarray(0, frameBytes),
      rgb.subarray(frameBytes * 3, frameBytes * 4),
      "the unrelated fixture must exercise changing picture pixels rather than a static cache token",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("full-range proxy-fallback preview and final render normalize identical raw-f32 master samples", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-review-preview-final-audio-"));
  const program = `cut 0.4;
project "Preview final audio parity";
import { Rect } from "cut:visual";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  AudioClip(source: voice, range: 0s ..< 1s);
  scene only(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #17324d);
  }
}
export out = render(main, width: 64px, height: 36px, codec: "h264");
`;
  try {
    await mkdir(resolve(root, "media"));
    // Preserve sub-PCM24 detail in the authored source. The old preview path
    // quantized this mix to PCM24 before normalization while final render fed
    // the same graph to loudnorm as raw stereo f32le.
    await runFfmpeg([
      "-y", "-v", "error",
      "-f", "lavfi",
      "-i", "aevalsrc=0.17320508075688773*sin(2*PI*437*t)+0.00000007*sin(2*PI*7919*t):s=48000:d=1",
      "-ac", "2",
      "-c:a", "pcm_f32le",
      resolve(root, "media/voice.wav"),
    ]);
    const { ir } = await locked(root, program);
    const final = await renderReferenceIr(ir, root, resolve(root, "final.mp4"), "out");
    const preview = await renderReferencePreviewArtifact(ir, root, resolve(root, "preview.mp4"), {
      range: "0s:1s",
      width: 64,
      mediaProfile: "proxy",
    });
    const previewNormalization = preview.audio.normalization as ReferenceLoudnessReport;
    const previewDelivery = preview.audio.delivery as ReferenceAacDeliveryReport;

    assert.deepEqual(
      { requested: preview.media.requested, selectedProxyResources: preview.media.selectedProxyResources, fallbackResources: preview.media.fallbackResources },
      { requested: "proxy", selectedProxyResources: 0, fallbackResources: 1 },
      "the preview must prove proxy selection fell back to the same master audio resource used by final render",
    );
    assert.deepEqual(
      { requested: final.media.requested, selectedProxyResources: final.media.selectedProxyResources, fallbackResources: final.media.fallbackResources },
      { requested: "master", selectedProxyResources: 0, fallbackResources: 0 },
    );
    assert.equal(preview.range.startSample, 0);
    assert.equal(preview.range.endSampleExclusive, 48_000);
    assert.equal(preview.execution.audioSource.mode, "full-program-cache-slice");
    if (preview.execution.audioSource.mode === "full-program-cache-slice") {
      assert.equal(preview.execution.audioState, "full-program-cache-authority-no-graph-execution");
      assert.equal(preview.execution.audioSource.graphExecution, "not-executed-this-invocation");
      assert.ok(preview.execution.audioSource.authorizedCachedBuild.filters >= 1);
      assert.equal("roots" in preview.execution, false);
      assert.equal("filters" in preview.execution, false);
      assert.equal(preview.execution.audioSource.selection.status, "hit");
      assert.equal(preview.execution.audioSource.selection.cache.key, final.cache.audio.key);
      assert.equal(preview.execution.audioSource.selection.cache.artifact.sha256, final.cache.audio.artifact.sha256);
      assert.equal(preview.execution.audioSource.selection.slice.sha256, final.cache.audio.artifact.sha256);
      assert.deepEqual(
        {
          startSample: preview.execution.audioSource.selection.slice.startSample,
          endSampleExclusive: preview.execution.audioSource.selection.slice.endSampleExclusive,
          bytes: preview.execution.audioSource.selection.slice.bytes,
        },
        { startSample: 0, endSampleExclusive: 48_000, bytes: 384_000 },
      );
    }
    assert.equal(previewDelivery.normalizedPcm.framing.expectedFrames, 48_000);
    assert.equal(final.audio.delivery.normalizedPcm.framing.expectedFrames, 48_000);
    assert.deepEqual(
      previewNormalization.input,
      final.audio.loudness.input,
      "preview and final loudnorm must measure the same pre-normalization raw-f32 programme",
    );
    assert.equal(
      previewDelivery.normalizedPcm.authoredPcmSha256,
      final.audio.delivery.normalizedPcm.authoredPcmSha256,
      "preview and final must hand AAC delivery byte-identical normalized PCM when media selection and range are identical",
    );
    // Container/video assembly and lossy AAC remain independently evidenced;
    // normalized PCM parity deliberately does not claim byte-identical MP4s.
    assert.match(preview.artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.match(final.sha256, /^[a-f0-9]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded visual-only preview delivers intentional exact silence", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-review-silent-preview-"));
  const visualOnly = `cut 0.4;
project "Silent preview";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  scene card(duration: 1s) { Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #071019); }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");
`;
  try {
    const { ir } = await locked(root, visualOnly), output = resolve(root, "silent.mp4");
    const manifest = await renderReferencePreviewArtifact(ir, root, output, { range: "250ms:750ms" });
    assert.equal(manifest.execution.audioSource.mode, "selected-execution");
    assert.deepEqual(
      {
        roots: manifest.execution.audioSource.mode === "selected-execution" ? manifest.execution.audioSource.execution.roots : undefined,
        frames: manifest.range.frames,
        samples: manifest.range.samples,
      },
      { roots: 0, frames: 2, samples: 24_000 },
    );
    const raw = resolve(root, "silent.f32le");
    const { spawn } = await import("node:child_process");
    await new Promise<void>((accept, reject) => {
      const child = spawn("ffmpeg", ["-y", "-v", "error", "-i", output, "-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", raw], { shell: false, stdio: "ignore" });
      child.on("error", reject); child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`ffmpeg silence decode exited ${code}`)));
    });
    const bytes = await readFile(raw);
    assert.ok(bytes.byteLength / 4 >= 24_000, "AAC decode may expose trailing codec padding beyond CUT's authored boundary");
    for (let offset = 0; offset < bytes.byteLength; offset += 4) assert.equal(bytes.readFloatLE(offset), 0, `visual-only preview audio sample ${offset / 4} must be exact silence`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
