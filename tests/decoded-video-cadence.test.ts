import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { applyCutLock, applyCutLockForVerifiedInputSession, createCutLock, CutLockError, CutMediaDurationError, CutProxyMediaError, validateCutLock, type CutLockfile, type LockedResourceProbe } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { compareRational, rational } from "../lib/language/rational";
import { decodedVideoCadenceDuration } from "../lib/language/video-cadence";
import { CutProjectError } from "../lib/project/manifest";
import { probeProjectDecodedVideoCadence, probeProjectMedia } from "../lib/project/probe";
import { inspectCutIr } from "../lib/runtime/inspect";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { prepareReferenceVerifiedInputSession } from "../lib/runtime/reference/verified-input-session";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function pictureSource(locator: string, fpsNumerator: number, fpsDenominator: number, startFrame = 0, proxy?: string, frameCount = 1) {
  const at = (frame: number) => `seconds(${frame * fpsDenominator} / ${fpsNumerator})`;
  return `cut 0.4;
project "decoded cadence proof";
import { Video } from "cut:visual";
asset source: VideoAsset = video(${JSON.stringify(locator)}${proxy ? `, proxy: ${JSON.stringify(proxy)}` : ""});
timeline main(duration: ${at(frameCount)}, fps: ${fpsNumerator} / ${fpsDenominator}, width: 64px, height: 64px, sampleRate: ${fpsNumerator}hz) {
  scene only(duration: ${at(frameCount)}) { Video(source: source, range: ${at(startFrame)} ..< ${at(startFrame + frameCount)}, fit: "cover"); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function untrimmedProxySource(master: string, proxy: string, fpsNumerator: number, fpsDenominator: number) {
  const duration = `seconds(${8 * fpsDenominator} / ${fpsNumerator})`;
  return `cut 0.4;
project "proxy cadence proof";
import { Video } from "cut:visual";
asset source: VideoAsset = video(${JSON.stringify(master)}, proxy: ${JSON.stringify(proxy)});
timeline main(duration: ${duration}, fps: ${fpsNumerator} / ${fpsDenominator}, width: 64px, height: 64px) {
  scene only(duration: ${duration}) { Video(source: source); }
}
export out = render(main);`;
}

async function cfr(path: string, rate: string, codec: "ffv1" | "h264") {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=64x64:rate=${rate}`,
    "-frames:v", "8", "-c:v", codec === "ffv1" ? "ffv1" : "libx264", "-pix_fmt", "yuv420p",
    // 1/16000 is deliberately non-integral for 30000/1001: it proves coarse
    // quantized PTS while preserving the exact nominal H264 rate in metadata.
    ...(codec === "h264" ? ["-video_track_timescale", "16000"] : []), path,
  ]);
}

async function h264AbsoluteVideoWithOffset(path: string) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30000/1001",
    "-filter_complex", "[1:v]setpts=PTS+0.04/TB[v]",
    "-map", "0:a:0", "-map", "[v]", "-frames:v", "8",
    "-c:a", "aac", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "16000",
    "-output_ts_offset", "2", path,
  ]);
}

async function vfr(path: string) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25",
    "-vf", "setpts='if(gte(N,2),N+1,N)'", "-frames:v", "8", "-fps_mode", "vfr",
    "-c:v", "ffv1", "-pix_fmt", "yuv420p", path,
  ]);
}

async function start43Matroska(path: string) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25",
    "-vf", "settb=1/1000,setpts=PTS+43", "-frames:v", "5",
    "-c:v", "ffv1", "-pix_fmt", "yuv420p", path,
  ]);
}

function rawFrames(path: string, absoluteStreamIndex: number, count: number) {
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-i", path, "-map", `0:${absoluteStreamIndex}`,
    "-vf", "format=rgba,scale=64:64:force_original_aspect_ratio=increase:flags=bicubic,crop=64:64",
    "-an", "-frames:v", String(count), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const bytes = Buffer.from(result.stdout), frameBytes = 64 * 64 * 4;
  assert.equal(bytes.byteLength, count * frameBytes);
  return Array.from({ length: count }, (_, index) => bytes.subarray(index * frameBytes, (index + 1) * frameBytes));
}

function mediaProbe(lock: CutLockfile) {
  const probe = lock.resources.source.probe;
  assert.equal(probe.kind, "media");
  return probe as Extract<LockedResourceProbe, { kind: "media" }>;
}

test("decoded cadence v2 proves common CFR rates on coarse Matroska/MP4 clocks and hashes canonical records", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cadence-corpus-"));
  try {
    await mkdir(resolve(root, "media"));
    const fixtures = [
      ["24.mkv", "24", "ffv1"],
      ["25.mkv", "25", "ffv1"],
      ["30.mkv", "30", "ffv1"],
      ["23976.mkv", "24000/1001", "ffv1"],
      ["2997.mp4", "30000/1001", "h264"],
    ] as const;
    await Promise.all(fixtures.map(([name, rate, codec]) => cfr(resolve(root, "media", name), rate, codec)));
    for (const [name, rate] of fixtures) {
      const locator = `media/${name}`, probe = await probeProjectMedia(root, locator);
      const stream = probe.streams.find((candidate) => candidate.type === "video")!;
      const witness = await probeProjectDecodedVideoCadence(root, locator, probe, stream.index);
      const [numerator, denominator = "1"] = rate.split("/");
      assert.equal(witness.frameCount, "8", name);
      assert.equal(witness.streamIndex, stream.index, name);
      assert.deepEqual(decodedVideoCadenceDuration(witness, stream), rational(8n * BigInt(denominator), BigInt(numerator)), name);
      assert.match(witness.recordsSha256, /^[a-f0-9]{64}$/u);
      assert.ok(["complete", "partial", "none"].includes(witness.durationCoverage));
    }

    const digest = createHash("sha256")
      .update("cut-decoded-cfr-grid-v2\nstream=1\ntime_base=1/1000\nframe_rate=24000/1001\n")
      .update("0\t43\t41\n1\t85\t41\n2\t126\t41\n3\t168\t41\n")
      .digest("hex");
    assert.equal(digest, "9590eeab975ad331e08d569a452c5e77458fe25fe5212641c6ace8d5aa6de395");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one-frame CUT trims use the selected absolute stream, exact start_pts, frame indices, and a bounded decoder", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cadence-render-"));
  try {
    await mkdir(resolve(root, "media"));
    await cfr(resolve(root, "media", "fractional.mkv"), "24000/1001", "ffv1");
    await h264AbsoluteVideoWithOffset(resolve(root, "media", "offset.mp4"));
    const cases = [
      { locator: "media/fractional.mkv", numerator: 24_000, denominator: 1_001 },
      { locator: "media/offset.mp4", numerator: 30_000, denominator: 1_001 },
    ];
    for (const fixture of cases) {
      const ir = compile(pictureSource(fixture.locator, fixture.numerator, fixture.denominator, 0, undefined, 8));
      const lock = await createCutLock(ir, root), probe = mediaProbe(lock), selected = probe.selected.video!;
      const stream = probe.identity.streams.find((candidate) => candidate.index === selected.streamIndex)!;
      assert.equal(selected.durationSource, "decoded-video-cadence");
      assert.ok(selected.decodedVideoCadence);
      assert.ok(stream.start && compareRational(stream.start, rational(0)) >= 0);
      if (fixture.locator.endsWith("offset.mp4")) {
        assert.equal(selected.streamIndex, 1, "audio is absolute stream 0 and selected H264 picture is absolute stream 1");
        assert.ok(compareRational(stream.start!, probe.identity.container.start ?? rational(0)) > 0, "selected picture starts after its nonzero container start");
      }
      await applyCutLock(ir, lock, root);
      const { composition } = validateReferenceSession(ir), scene = ir.scenes[composition.sceneIds[0]];
      const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", `render-${fixture.numerator}`));
      try {
        await renderer.prepare();
        const decoded = rawFrames(resolve(root, fixture.locator), selected.streamIndex, 8);
        const decodedHashes = decoded.map((frame) => createHash("sha256").update(frame).digest("hex"));
        assert.equal(new Set(decodedHashes).size, 8, "fixture source frames must be visually unique across the quantizer cycle");
        const renderedHashes: string[] = [];
        for (let frame = 0; frame < 8; frame += 1) renderedHashes.push(createHash("sha256").update((await renderer.sceneFrame(scene, frame, false)).data).digest("hex"));
        assert.deepEqual(renderedHashes, decodedHashes, "CUT frame-index execution must preserve every selected picture in order");
        const evidence = renderer.referenceVideoDecoderEvidence();
        assert.deepEqual(evidence.map(({ mode, frameLimit, sourceStartFrame, sourceEndFrame, semanticSeek }) => ({ mode, frameLimit, sourceStartFrame, sourceEndFrame, semanticSeek })), [{
          mode: "decoded-cfr-frame-index", frameLimit: 8, sourceStartFrame: 0, sourceEndFrame: 8, semanticSeek: false,
        }]);
        const inspected = inspectCutIr(ir, "program.cut").resources.find((resource) => resource.id === "source") as { selectedMedia?: { master?: { video?: { durationSource?: string; start?: unknown; decodedVideoCadence?: { frameCount?: string } } } } };
        assert.equal(inspected.selectedMedia?.master?.video?.durationSource, "decoded-video-cadence");
        assert.equal(inspected.selectedMedia?.master?.video?.decodedVideoCadence?.frameCount, "8");
        assert.ok(inspected.selectedMedia?.master?.video?.start);
      } finally { await renderer.closeAndWait(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous Matroska duration tags, VFR schedules, forged witnesses, budgets, sessions, and proxies fail closed", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cadence-hostile-"));
  try {
    await mkdir(resolve(root, "media"));
    await start43Matroska(resolve(root, "media", "start43.mkv"));
    await vfr(resolve(root, "media", "vfr.mkv"));
    await cfr(resolve(root, "media", "proxy-master.mkv"), "25", "ffv1");
    await vfr(resolve(root, "media", "proxy-vfr.mkv"));

    const probe = await probeProjectMedia(root, "media/start43.mkv"), stream = probe.streams.find((candidate) => candidate.type === "video")!;
    assert.deepEqual(stream.start, rational(43, 1000));
    assert.equal(stream.duration, undefined, "Matroska DURATION tag cannot authorize an executable selected stream");
    assert.ok(probe.container.duration, "container duration exists but remains non-authoritative");
    const witness = await probeProjectDecodedVideoCadence(root, "media/start43.mkv", probe, stream.index);
    assert.equal(witness.firstPts, "43");
    assert.equal(witness.lastPts, "203");
    assert.equal(witness.frameCount, "5");
    assert.deepEqual(decodedVideoCadenceDuration(witness, stream), rational(1, 5), "five 25fps pictures last 200ms even when tag text names the last PTS");
    await assert.rejects(probeProjectDecodedVideoCadence(root, "media/start43.mkv", probe, stream.index, { maxOutputBytes: 1 }), (error: unknown) => error instanceof CutProjectError && error.code === "CUTP2002");

    const ir = compile(pictureSource("media/start43.mkv", 25, 1));
    const lock = await createCutLock(ir, root);
    assert.equal(mediaProbe(lock).selected.video?.durationSource, "decoded-video-cadence");
    await applyCutLock(ir, lock, root);
    const session = await prepareReferenceVerifiedInputSession(ir, root, "master");
    try {
      const sessionProbe = session.ir.resources.source.metadata?.probe as Extract<LockedResourceProbe, { kind: "media" }>;
      assert.equal(sessionProbe.selected.video?.decodedVideoCadence?.recordsSha256, mediaProbe(lock).selected.video?.decodedVideoCadence?.recordsSha256);
    } finally { await session.cleanup(); }

    const forged = structuredClone(lock);
    if (forged.resources.source.probe.kind !== "media") throw new Error("expected media probe");
    forged.resources.source.probe.selected.video!.decodedVideoCadence!.frameCount = "6";
    assert.throws(() => validateCutLock(forged), (error: unknown) => error instanceof CutLockError && error.code === "CUT_LOCK_METADATA");

    const forgedDigest = structuredClone(lock);
    if (forgedDigest.resources.source.probe.kind !== "media") throw new Error("expected media probe");
    forgedDigest.resources.source.probe.selected.video!.decodedVideoCadence!.recordsSha256 = "f".repeat(64);
    const deferred = compile(pictureSource("media/start43.mkv", 25, 1));
    await applyCutLockForVerifiedInputSession(deferred, forgedDigest, root);
    await assert.rejects(prepareReferenceVerifiedInputSession(deferred, root, "master"), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_LOCK_METADATA"), "private-session native rescan must reject an internally valid but forged records digest");

    const vfrProbe = await probeProjectMedia(root, "media/vfr.mkv"), vfrStream = vfrProbe.streams.find((candidate) => candidate.type === "video")!;
    await assert.rejects(probeProjectDecodedVideoCadence(root, "media/vfr.mkv", vfrProbe, vfrStream.index), (error: unknown) => error instanceof CutProjectError && error.code === "CUTP2014");
    await assert.rejects(createCutLock(compile(pictureSource("media/vfr.mkv", 25, 1)), root), (error: unknown) => error instanceof CutMediaDurationError && /cadence proof failed|no safe decoded-video-cadence/u.test(error.message));

    const proxyIr = compile(untrimmedProxySource("media/proxy-master.mkv", "media/proxy-vfr.mkv", 25, 1));
    await assert.rejects(createCutLock(proxyIr, root), (error: unknown) => (error instanceof CutMediaDurationError && /cadence proof failed|no safe decoded-video-cadence/u.test(error.message)) || error instanceof CutProxyMediaError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
