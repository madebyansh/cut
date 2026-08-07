import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { runFfmpeg, runFfprobeCapture } from "../lib/runtime/reference/ffmpeg";
import { renderReferencePreviewArtifact } from "../lib/runtime/reference/authoring-review";
import { isReferencePictureMediaToolchainIdentity } from "../lib/runtime/reference/picture-media-toolchain";
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

async function resolvedPathExecutable(name: string) {
  const environmentPath = process.env.PATH;
  assert.ok(environmentPath, "test host must provide PATH");
  for (const directory of environmentPath.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    try {
      const candidate = await realpath(resolve(directory, name));
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* try the next PATH entry */ }
  }
  throw new Error(`test host PATH did not resolve ${name}`);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function writeFfprobeIdentityWrapper(path: string, executable: string, identity: string) {
  await writeFile(path, `#!/bin/sh\n# ${identity}\nexec ${shellQuote(executable)} "$@"\n`);
  await chmod(path, 0o700);
}

type PictureToolchainEvidence = Readonly<{
  integrity: string;
  ffmpeg: Readonly<{ executableSha256: string }>;
  ffprobe: Readonly<{ executableSha256: string }>;
}>;

function publicPictureToolchain(value: unknown) {
  assert.ok(value && typeof value === "object" && "pictureToolchain" in value, "public manifest must bind the exact picture toolchain");
  const toolchain = (value as { pictureToolchain?: PictureToolchainEvidence }).pictureToolchain;
  assert.ok(toolchain);
  assert.match(toolchain.integrity, /^[a-f0-9]{64}$/u);
  assert.match(toolchain.ffmpeg.executableSha256, /^[a-f0-9]{64}$/u);
  assert.match(toolchain.ffprobe.executableSha256, /^[a-f0-9]{64}$/u);
  return toolchain;
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
    assert.equal(originalCacheManifest.version, 4);
    assert.match(compositionCache.sceneToolchainIntegrity, /^[a-f0-9]{64}$/u);
    assert.equal(originalCacheManifest.toolchainIntegrity, compositionCache.sceneToolchainIntegrity, "the plan and segment manifest must bind the same exact FFmpeg+FFprobe picture identity");

    await writeFile(manifestPath, JSON.stringify({ ...originalCacheManifest, version: 3 }, null, 2));
    const schemaReplay = await renderReferenceIr(ir, root, resolve(root, "schema-replay.mp4"), "out");
    assert.equal(schemaReplay.cache.scenes[0].status, "miss", "pre-combined-toolchain scene-cache v3 must not authorize reuse");
    assert.equal((JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>).version, 4);

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

test("exact FFprobe drift invalidates the scene cache and is bound by the public render manifest", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-scene-ffprobe-identity-"));
  const originalPath = process.env.PATH;
  try {
    assert.ok(originalPath);
    const ffprobe = await resolvedPathExecutable("ffprobe");
    const bin = resolve(root, "bin"), wrapper = resolve(bin, "ffprobe");
    await mkdir(bin);
    await writeFfprobeIdentityWrapper(wrapper, ffprobe, "cut-scene-ffprobe-a");
    process.env.PATH = `${bin}${delimiter}${originalPath}`;

    const source = `cut 0.4;
project "Scene FFprobe identity";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 32px, height: 32px, sampleRate: 48khz) {
  scene only(duration: 1s) { Rect(width: 32px, height: 32px, fill: #2563eb); }
}
export out = render(main, width: 32px, height: 32px, codec: "h264");`;
    const ir = compile(source), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const first = await renderReferenceIr(ir, root, resolve(root, "first.mp4"), "out");
    assert.equal(first.cache.scenes[0]?.status, "miss");
    const firstCache = JSON.parse(await readFile(resolve(root, ".cut/cache/reference/composition-main.json"), "utf8")) as {
      sceneToolchainIntegrity: string;
      scenes: Record<string, string>;
    };

    await writeFfprobeIdentityWrapper(wrapper, ffprobe, "cut-scene-ffprobe-b");
    const second = await renderReferenceIr(ir, root, resolve(root, "second.mp4"), "out");
    const secondCache = JSON.parse(await readFile(resolve(root, ".cut/cache/reference/composition-main.json"), "utf8")) as typeof firstCache;
    assert.equal(second.cache.scenes[0]?.status, "miss", "a different exact FFprobe executable must not reuse a scene artifact accepted by another probe");
    assert.notEqual(secondCache.sceneToolchainIntegrity, firstCache.sceneToolchainIntegrity);
    assert.notEqual(Object.values(secondCache.scenes)[0], Object.values(firstCache.scenes)[0]);

    const firstToolchain = publicPictureToolchain(first), secondToolchain = publicPictureToolchain(second);
    assert.equal((first as unknown as { version: number }).version, 11);
    assert.equal((second as unknown as { version: number }).version, 11);
    assert.equal(firstToolchain.integrity, firstCache.sceneToolchainIntegrity);
    assert.equal(secondToolchain.integrity, secondCache.sceneToolchainIntegrity);
    assert.equal(secondToolchain.ffmpeg.executableSha256, firstToolchain.ffmpeg.executableSha256);
    assert.notEqual(secondToolchain.ffprobe.executableSha256, firstToolchain.ffprobe.executableSha256);
    assert.equal(isReferencePictureMediaToolchainIdentity(firstToolchain), true);
    assert.equal(isReferencePictureMediaToolchainIdentity({
      ...firstToolchain,
      ffprobe: { ...firstToolchain.ffprobe, executableSha256: "0".repeat(64) },
    }), false, "public validation must reject FFprobe identity tampering without a matching combined integrity");
    const firstSceneManifest = JSON.parse(await readFile(resolve(
      root,
      ".cut/cache/reference/scene",
      Object.values(firstCache.scenes)[0]!,
      "manifest.json",
    ), "utf8")) as { pictureToolchain: unknown };
    assert.deepEqual(firstSceneManifest.pictureToolchain, firstToolchain, "the private scene manifest must retain both exact executable identities");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("exact FFprobe drift invalidates the preview-picture cache and is bound by the public preview manifest", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-preview-ffprobe-identity-"));
  const originalPath = process.env.PATH;
  try {
    assert.ok(originalPath);
    const ffprobe = await resolvedPathExecutable("ffprobe");
    const bin = resolve(root, "bin"), wrapper = resolve(bin, "ffprobe");
    await mkdir(bin);
    await writeFfprobeIdentityWrapper(wrapper, ffprobe, "cut-preview-ffprobe-a");
    process.env.PATH = `${bin}${delimiter}${originalPath}`;

    const source = `cut 0.4;
project "Preview FFprobe identity";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) { Rect(width: 64px, height: 36px, fill: #16a34a); }
}
export out = render(main, width: 64px, height: 36px, codec: "h264");`;
    const ir = compile(source), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const first = await renderReferencePreviewArtifact(ir, root, resolve(root, "first-preview.mp4"), { range: "0s:1s", width: 64 });
    assert.equal(first.execution.cache.status, "miss");

    await writeFfprobeIdentityWrapper(wrapper, ffprobe, "cut-preview-ffprobe-b");
    const second = await renderReferencePreviewArtifact(ir, root, resolve(root, "second-preview.mp4"), { range: "0s:1s", width: 64 });
    assert.equal(second.execution.cache.status, "miss", "a different exact FFprobe executable must not reuse a preview artifact accepted by another probe");
    assert.notEqual(second.execution.cache.key, first.execution.cache.key);
    assert.notEqual(second.execution.cache.identity.toolchainIntegrity, first.execution.cache.identity.toolchainIntegrity);

    const firstToolchain = publicPictureToolchain(first), secondToolchain = publicPictureToolchain(second);
    assert.equal((first as unknown as { version: number }).version, 4);
    assert.equal((second as unknown as { version: number }).version, 4);
    assert.equal(firstToolchain.integrity, first.execution.cache.identity.toolchainIntegrity);
    assert.equal(secondToolchain.integrity, second.execution.cache.identity.toolchainIntegrity);
    assert.equal(secondToolchain.ffmpeg.executableSha256, firstToolchain.ffmpeg.executableSha256);
    assert.notEqual(secondToolchain.ffprobe.executableSha256, firstToolchain.ffprobe.executableSha256);
    assert.deepEqual(first.execution.cache.identity.pictureToolchain, firstToolchain, "the private preview manifest must retain both exact executable identities");
    assert.deepEqual(second.execution.cache.identity.pictureToolchain, secondToolchain);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
