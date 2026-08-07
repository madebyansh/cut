import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { runFfmpeg, runFfprobeCapture } from "../lib/runtime/reference/ffmpeg";
import { renderReferenceIr } from "./reference-render-test-helper";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function decodedVideoFrames(path: string) {
  const probe = await runFfprobeCapture([
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames,has_b_frames,avg_frame_rate,time_base,start_pts,duration_ts",
    "-of", "json", path,
  ]);
  const parsed = JSON.parse(probe.stdout) as { streams?: Array<Record<string, unknown>> };
  assert.equal(parsed.streams?.length, 1, probe.stdout);
  return parsed.streams[0];
}

async function firstRgb(path: string, output: string) {
  await runFfmpeg([
    "-y", "-v", "error", "-i", path, "-frames:v", "1",
    "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", output,
  ]);
  const bytes = await readFile(output);
  assert.equal(bytes.length, 3);
  return [...bytes] as [number, number, number];
}

test("reference concat accepts directive-looking project and source paths without interpreting them", { timeout: 90_000 }, async () => {
  const base = await mkdtemp(resolve(tmpdir(), "cut-concat-boundary-"));
  const projectRoot = resolve(base, "project\nffconcat version 1.0\nfile 'injected.mp4'\nduration 99");
  const sourceName = "source\nfile 'injected.mp4'\noption protocol_whitelist http.mp4";
  try {
    await mkdir(projectRoot);
    const sourcePath = resolve(projectRoot, sourceName);
    await runFfmpeg([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=#ea580c:s=32x32:r=4:d=1",
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      sourcePath,
    ]);
    const source = `cut 0.4;
project "Safe concat aliases";
import { Video } from "cut:visual";
asset clip: VideoAsset = video(${JSON.stringify(sourceName)});
timeline main(duration: 1s, fps: 4, width: 32px, height: 32px, sampleRate: 48khz) {
  scene first(duration: 250ms) { Video(source: clip, range: 0ms ..< 250ms, fit: "cover"); }
  scene second(duration: 750ms) { Video(source: clip, range: 250ms ..< 1s, fit: "cover"); }
}
export out = render(main, width: 32px, height: 32px, codec: "h264");`;
    await writeFile(resolve(projectRoot, "program.cut"), source);
    const ir = compile(source), lock = await createCutLock(ir, projectRoot);
    await applyCutLock(ir, lock, projectRoot);

    const output = resolve(projectRoot, "render.mp4");
    let inspectedPrivateList = false;
    const manifest = await renderReferenceIr(ir, projectRoot, output, "out", {
      async __testPreparationFault(stage) {
        if (stage !== "after-aac") return;
        const cacheRoot = resolve(projectRoot, ".cut", "cache", "reference");
        const workEntries = (await readdir(cacheRoot)).filter((entry) => entry.startsWith(".cut-reference-work-"));
        assert.equal(workEntries.length, 1);
        const work = resolve(cacheRoot, workEntries[0]);
        assert.equal((await stat(work)).mode & 0o777, 0o700);
        const concatList = await readFile(resolve(work, "scenes.txt"), "utf8");
        assert.equal(concatList, "file 'scene-000000.mp4'\nfile 'scene-000001.mp4'\n");
        assert.equal(concatList.includes(projectRoot), false);
        assert.equal(concatList.includes(sourceName), false);
        for (const alias of ["scene-000000.mp4", "scene-000001.mp4"]) {
          const metadata = await stat(resolve(work, alias));
          assert.ok(metadata.isFile());
          assert.ok(metadata.nlink >= 2, `${alias} must be a hard link to a cached scene artifact`);
        }
        inspectedPrivateList = true;
      },
    });
    assert.equal(inspectedPrivateList, true);
    assert.equal(manifest.duration, 1);
    assert.equal(manifest.cache.scenes.length, 2);
    assert.ok((await stat(output)).size > 1_000);
    const probe = await runFfprobeCapture([
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", output,
    ]);
    assert.ok(Math.abs(Number(probe.stdout.trim()) - 1) < 0.001, probe.stdout);
    const picture = await decodedVideoFrames(output);
    assert.equal(picture.nb_read_frames, "4");
    assert.equal(picture.has_b_frames, 0);

    const cacheEntries = await readdir(resolve(projectRoot, ".cut", "cache", "reference"));
    assert.deepEqual(cacheEntries.filter((entry) => entry.startsWith(".cut-reference-work-")), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reference scene-cache hits reject an H.264 artifact whose decoded frame contract contradicts its manifest", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-concat-cache-contract-"));
  try {
    const source = `cut 0.4;
project "Scene cache decoded contract";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 32px, height: 32px, sampleRate: 48khz) {
  scene only(duration: 1s) { Rect(width: 32px, height: 32px, fill: #2563eb); }
}
export out = render(main, width: 32px, height: 32px, codec: "h264");`;
    const ir = compile(source), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const cold = await renderReferenceIr(ir, root, resolve(root, "cold.mp4"), "out");
    assert.equal(cold.cache.scenes[0].status, "miss");

    const compositionCache = JSON.parse(await readFile(resolve(root, ".cut", "cache", "reference", "composition-main.json"), "utf8")) as { scenes: Record<string, string>; sceneToolchainIntegrity: string };
    const sceneKey = Object.values(compositionCache.scenes)[0];
    assert.match(sceneKey, /^[a-f0-9]{64}$/u);
    const sceneDirectory = resolve(root, ".cut", "cache", "reference", "scene", sceneKey);
    const artifact = resolve(sceneDirectory, "video.mp4"), manifestPath = resolve(sceneDirectory, "manifest.json");
    const originalCacheManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(originalCacheManifest.version, 3);
    assert.match(compositionCache.sceneToolchainIntegrity, /^[a-f0-9]{64}$/u);
    assert.equal(originalCacheManifest.toolchainIntegrity, compositionCache.sceneToolchainIntegrity, "the plan and segment manifest must bind the same observed FFmpeg executable+banner identity");

    await writeFile(manifestPath, JSON.stringify({ ...originalCacheManifest, version: 2 }, null, 2));
    const schemaReplay = await renderReferenceIr(ir, root, resolve(root, "schema-replay.mp4"), "out");
    assert.equal(schemaReplay.cache.scenes[0].status, "miss", "pre-toolchain scene-cache v2 must not authorize reuse");
    assert.equal((JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>).version, 3);

    // Preserve the authored one-second duration but replace four 4fps frames
    // with one 1fps frame. The manifest continues to claim four frames and its
    // digest is internally consistent, so only media-contract verification can
    // distinguish this from a valid cache hit.
    await runFfmpeg([
      "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=#dc2626:s=32x32:r=1:d=1",
      "-frames:v", "1", "-an", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", artifact,
    ]);
    const forgedBytes = await readFile(artifact);
    const cacheManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    cacheManifest.sha256 = sha256(forgedBytes);
    await writeFile(manifestPath, JSON.stringify(cacheManifest, null, 2));
    assert.equal((await decodedVideoFrames(artifact)).nb_read_frames, "1");

    const warmPath = resolve(root, "warm.mp4");
    const warm = await renderReferenceIr(ir, root, warmPath, "out");
    assert.equal(warm.cache.scenes[0].status, "miss", "invalid cached picture bytes must be rebuilt, not laundered as a hit");
    assert.equal((await decodedVideoFrames(warmPath)).nb_read_frames, "4");
    const restored = await firstRgb(warmPath, resolve(root, "restored.rgb"));
    assert.ok(restored[2] > restored[0] && restored[2] > restored[1], `rebuilt delivery must restore the authored blue scene, got rgb(${restored.join(",")})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the observed FFmpeg implementation invalidates picture-scene cache identity", () => {
  const ir = compile(`cut 0.4;
project "Scene toolchain identity";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 32px, height: 32px) {
  scene only(duration: 1s) { Rect(width: 32px, height: 32px, fill: #111827); }
}
export out = render(main);`);
  const firstToolchain = "1".repeat(64), secondToolchain = "2".repeat(64);
  const previous = createIncrementalRenderPlan(ir, "main", undefined, undefined, undefined, undefined, firstToolchain).manifest;
  const changed = createIncrementalRenderPlan(ir, "main", previous, undefined, undefined, undefined, secondToolchain);
  assert.equal(previous.sceneToolchainIntegrity, firstToolchain);
  assert.equal(changed.manifest.sceneToolchainIntegrity, secondToolchain);
  assert.ok(changed.scenes.every((scene) => scene.status === "miss"));
});
