import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compileCutModule } from "../lib/language/compiler";
import {
  applyCutLock,
  applyCutLockForVerifiedInputSession,
  createCutLock,
  CutLockError,
  CutProxyMediaError,
  validateCutLock,
} from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import {
  cutVideoProxyAlignmentIntegrity,
  cutVideoProxyExecutionIdentity,
  type CutVideoProxyAlignment,
  type CutVideoProxyAlignmentWithoutIntegrity,
} from "../lib/language/video-proxy-alignment";
import { CutProjectError } from "../lib/project/manifest";
import { probeProjectVideoProxyAlignment } from "../lib/project/probe";
import { inspectCutIr } from "../lib/runtime/inspect";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import {
  prepareReferenceVerifiedInputSession,
  ReferenceVerifiedInputSessionError,
} from "../lib/runtime/reference/verified-input-session";

const exec = promisify(execFile);

function compile(master: string, proxy: string) {
  const source = `cut 0.4;
project "decoded video proxy alignment";
import { Video } from "cut:visual";
asset picture: VideoAsset = video("${master}", proxy: "${proxy}");
timeline main(duration: 1.5s, fps: 12, width: 96px, height: 54px, sampleRate: 48khz) {
  Video(source: picture, range: 0s ..< 1.5s);
}
export out = render(main, width: 96px, height: 54px, codec: "h264");`;
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

async function master(path: string) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=96x54:r=12:d=1.5",
    "-frames:v", "18", "-an", "-c:v", "prores_ks", "-profile:v", "0",
    "-pix_fmt", "yuv422p10le", "-video_track_timescale", "12288", path,
  ]);
}

async function proxyFromMaster(input: string, output: string, corruptFrame = false, size = "64:36") {
  const filter = corruptFrame
    ? `scale=${size}:flags=lanczos,negate=enable='eq(n,6)'`
    : `scale=${size}:flags=lanczos`;
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input,
    "-map", "0:v:0", "-vf", filter, "-an", "-c:v", "libx264", "-crf", "28",
    "-g", "12", "-pix_fmt", "yuv420p", "-video_track_timescale", "12288", output,
  ]);
}

async function unrelatedProxy(output: string) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=64x36:r=12:d=1.5",
    "-frames:v", "18", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-video_track_timescale", "12288", output,
  ]);
}

function alignment(value: Awaited<ReturnType<typeof createCutLock>>) {
  const witness = value.resources.picture.proxy?.videoAlignment;
  assert.ok(witness);
  return witness;
}

test("decoded picture witness accepts a same-source lossy/rescaled proxy and survives lock, inspect, cache projection, and private replay", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-video-proxy-alignment-"));
  try {
    await mkdir(resolve(root, "media"));
    const masterLocator = "media/master.mov", proxyLocator = "media/proxy.mp4";
    await master(resolve(root, masterLocator));
    await proxyFromMaster(resolve(root, masterLocator), resolve(root, proxyLocator));
    const ir = compile(masterLocator, proxyLocator), lock = await createCutLock(ir, root);
    const witness = alignment(lock);
    const masterProbe = lock.resources.picture.probe, proxyProbe = lock.resources.picture.proxy?.probe;
    assert.equal(masterProbe.kind, "media");
    assert.equal(proxyProbe?.kind, "media");
    if (masterProbe.kind !== "media" || proxyProbe?.kind !== "media"
      || !masterProbe.selected.video?.decodedVideoCadence || !proxyProbe.selected.video?.decodedVideoCadence) {
      throw new Error("expected locked decoded video cadence witnesses");
    }
    await assert.rejects(
      probeProjectVideoProxyAlignment(
        root,
        masterLocator,
        masterProbe.identity,
        masterProbe.selected.video.decodedVideoCadence,
        proxyLocator,
        proxyProbe.identity,
        proxyProbe.selected.video.decodedVideoCadence,
        { maxOutputBytes: 1 },
      ),
      (error) => error instanceof CutProjectError
        && error.code === "CUTP2018"
        && /exceeded the 1-byte analysis bound/u.test(error.message),
    );
    assert.deepEqual({
      format: witness.format,
      version: witness.version,
      method: witness.method,
      geometry: [witness.analysis.width, witness.analysis.height, witness.analysis.pixelFormat],
      frames: witness.analysis.frameCount,
      failed: witness.metrics.failedFrames,
      decision: witness.decision,
    }, {
      format: "cut-video-proxy-alignment",
      version: 1,
      method: "cut-frame-rgb-mae-v1",
      geometry: [32, 32, "rgb24"],
      frames: "18",
      failed: "0",
      decision: "equivalent",
    });
    assert.ok(witness.metrics.meanAbsoluteErrorPpm <= witness.policy.maximumMeanAbsoluteErrorPpm);
    assert.ok(witness.metrics.maximumFrameMeanAbsoluteErrorPpm <= witness.policy.maximumFrameMeanAbsoluteErrorPpm);
    const executionIdentity = cutVideoProxyExecutionIdentity(witness);
    assert.equal(Object.hasOwn(executionIdentity, "master"), false);
    assert.equal(Object.hasOwn(executionIdentity, "metrics"), false);
    assert.equal(Object.hasOwn(executionIdentity, "integrity"), false);
    validateCutLock(JSON.parse(JSON.stringify(lock)));
    await applyCutLock(ir, lock, root);
    const inspected = inspectCutIr(ir, "main.cut").resources.find((resource) => resource.id === "picture") as {
      selectedMedia?: { proxy?: { videoProxyAlignment?: CutVideoProxyAlignment } };
      proxy?: { videoProxyAlignment?: CutVideoProxyAlignment };
    };
    assert.deepEqual(inspected.proxy?.videoProxyAlignment ?? inspected.selectedMedia?.proxy?.videoProxyAlignment, witness);
    const selected = selectReferenceMediaProfile(ir, "proxy").ir.resources.picture.metadata as {
      activeMediaVariant?: string;
      videoProxyAlignment?: CutVideoProxyAlignment;
    };
    assert.equal(selected.activeMediaVariant, "proxy");
    assert.deepEqual(selected.videoProxyAlignment, witness);
    const session = await prepareReferenceVerifiedInputSession(ir, root, "proxy");
    assert.equal(session.media.selectedProxyResources, 1);
    await session.cleanup();

    const tampered = structuredClone(lock);
    const stored = alignment(tampered);
    tampered.resources.picture.proxy!.videoAlignment = {
      ...stored,
      proxy: { ...stored.proxy, analysisRgbSha256: "f".repeat(64) },
    };
    assert.throws(
      () => validateCutLock(tampered),
      (error) => error instanceof CutLockError
        && error.code === "CUT_LOCK_IDENTITY"
        && error.path.endsWith(".videoAlignment.integrity"),
    );

    const forged = structuredClone(lock), forgedStored = alignment(forged);
    const { integrity: _integrity, ...forgedBase } = forgedStored;
    void _integrity;
    const forgedChanged: CutVideoProxyAlignmentWithoutIntegrity = {
      ...forgedBase,
      proxy: { ...forgedBase.proxy, analysisRgbSha256: "e".repeat(64) },
    };
    forged.resources.picture.proxy!.videoAlignment = {
      ...forgedChanged,
      integrity: cutVideoProxyAlignmentIntegrity(forgedChanged),
    };
    validateCutLock(forged);
    await assert.rejects(
      applyCutLock(compile(masterLocator, proxyLocator), forged, root),
      (error) => error instanceof CutLockError
        && error.code === "CUT_PROXY_VIDEO_ALIGNMENT"
        && error.path.endsWith(".proxy.videoAlignment"),
    );
    const deferred = compile(masterLocator, proxyLocator);
    await applyCutLockForVerifiedInputSession(deferred, forged, root);
    await assert.rejects(
      prepareReferenceVerifiedInputSession(deferred, root, "proxy"),
      (error) => error instanceof ReferenceVerifiedInputSessionError
        && error.code === "CUT_LOCK_METADATA"
        && error.detail.reason === "proxy-video-alignment-mismatch"
        && (error.source?.line ?? 0) > 0
        && error.source?.resourceId === "picture",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-cadence unrelated imagery and a one-frame corruption fail source-located picture correspondence", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-video-proxy-adversarial-"));
  try {
    await mkdir(resolve(root, "media"));
    const masterLocator = "media/master.mov", proxyLocator = "media/proxy.mp4";
    await master(resolve(root, masterLocator));
    await unrelatedProxy(resolve(root, proxyLocator));
    await assert.rejects(
      createCutLock(compile(masterLocator, proxyLocator), root),
      (error) => error instanceof CutProxyMediaError
        && error.code === "CUT_PROXY_VIDEO_ALIGNMENT"
        && error.source.line > 0
        && /not frame-correspondent/u.test(error.message),
    );

    await proxyFromMaster(resolve(root, masterLocator), resolve(root, proxyLocator), true);
    await assert.rejects(
      createCutLock(compile(masterLocator, proxyLocator), root),
      (error) => error instanceof CutProxyMediaError
        && error.code === "CUT_PROXY_VIDEO_ALIGNMENT"
        && error.source.line > 0
        && /failedFrames=1/u.test(error.message),
    );

    await proxyFromMaster(resolve(root, masterLocator), resolve(root, proxyLocator), false, "64:32");
    await assert.rejects(
      createCutLock(compile(masterLocator, proxyLocator), root),
      (error) => error instanceof CutProxyMediaError
        && error.code === "CUT_PROXY_VIDEO_ALIGNMENT"
        && error.source.line > 0
        && /coded-frame aspect ratios/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
