import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { generateCutVideoProxy, CutVideoProxyGenerationError } from "../lib/project/proxy";

const exec = promisify(execFile);
const cli = resolve("dist-cli/cli/cut.js");

function runCli(args: readonly string[], cwd: string, expectedCode = 0, timeoutMs = 180_000) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else accept(result!);
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === expectedCode) finish(undefined, result);
      else finish(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`cut ${args.join(" ")} timed out`));
    }, timeoutMs);
  });
}

const source = `cut 0.4;
project "Public video proxy generation";
import { Video } from "cut:visual";

asset picture: VideoAsset = video("media/master.mp4", proxy: "media/proxy.mp4");

timeline main(duration: 2s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    Video(source: picture, range: 0s ..< 2s);
  }
}

export preview = render(main, width: 640px, height: 360px, codec: "h264");
`;

test("public proxy generation creates a correspondence-proved picture proxy selected by preview", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-project-video-proxy-"));
  const outsideRoot = await mkdtemp(resolve(tmpdir(), "cut-project-video-proxy-outside-"));
  try {
    await mkdir(resolve(root, "media"));
    await exec("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=2",
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
      "-pix_fmt", "yuv420p", "-bf", "0", "-video_track_timescale", "24000",
      resolve(root, "media/master.mp4"),
    ], { timeout: 60_000 });
    await writeFile(resolve(root, "main.cut"), source);
    const sourceBefore = await readFile(resolve(root, "main.cut"));
    const masterBefore = await readFile(resolve(root, "media/master.mp4"));

    const generated = JSON.parse((await runCli([
      "proxy", "media/master.mp4",
      "--project", ".",
      "--out", "media/proxy.mp4",
      "--width", "320",
      "--json",
    ], root)).stdout) as {
      format: string;
      status: string;
      source: { decodedFrames: string; width: number; height: number };
      proxy: { locator: string; sha256: string; decodedFrames: string; width: number; height: number; bytes: number };
      correspondence: { decision: string; failedFrames: string };
      toolchain: {
        format: string;
        ffmpeg: { name: string; executableSha256: string };
        ffprobe: { name: string; executableSha256: string };
        integrity: string;
      };
      authoring: { proxyArgument: string };
    };
    assert.deepEqual({
      format: generated.format,
      status: generated.status,
      sourceFrames: generated.source.decodedFrames,
      proxyFrames: generated.proxy.decodedFrames,
      sourceGeometry: [generated.source.width, generated.source.height],
      proxyGeometry: [generated.proxy.width, generated.proxy.height],
      decision: generated.correspondence.decision,
      failedFrames: generated.correspondence.failedFrames,
      argument: generated.authoring.proxyArgument,
    }, {
      format: "cut-video-proxy-generation-report",
      status: "pass",
      sourceFrames: "48",
      proxyFrames: "48",
      sourceGeometry: [640, 360],
      proxyGeometry: [320, 180],
      decision: "equivalent",
      failedFrames: "0",
      argument: 'proxy: "media/proxy.mp4"',
    });
    assert.ok(generated.proxy.bytes > 0);
    assert.equal(generated.toolchain.format, "cut-video-proxy-native-toolchain");
    assert.equal(generated.toolchain.ffmpeg.name, "ffmpeg");
    assert.equal(generated.toolchain.ffprobe.name, "ffprobe");
    assert.match(generated.toolchain.ffmpeg.executableSha256, /^[a-f0-9]{64}$/);
    assert.match(generated.toolchain.ffprobe.executableSha256, /^[a-f0-9]{64}$/);
    assert.match(generated.toolchain.integrity, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(resolve(root, "main.cut")), sourceBefore, "proxy generation must not mutate CUT source");
    assert.deepEqual(await readFile(resolve(root, "media/master.mp4")), masterBefore, "proxy generation must not mutate master media");
    const lock = JSON.parse((await runCli(["lock", "main.cut", "--out", "cut.lock", "--json"], root)).stdout) as {
      status: string;
      summary: { proxies: number };
    };
    assert.equal(lock.status, "pass");
    assert.equal(lock.summary.proxies, 1);
    const preview = JSON.parse((await runCli([
      "preview", "main.cut",
      "--lock", "cut.lock",
      "--output", "preview",
      "--range", "0s:2s",
      "--width", "320",
      "--out", "preview.mp4",
      "--json",
    ], root)).stdout) as {
      status: string;
      manifest: {
        media: {
          requested: string;
          selectedProxyResources: number;
          fallbackResources: number;
          resources: unknown[];
        };
        artifact: { bytes: number };
      };
    };
    assert.equal(preview.status, "pass");
    assert.deepEqual(preview.manifest.media, {
      requested: "proxy",
      selectedProxyResources: 1,
      fallbackResources: 0,
      resources: preview.manifest.media.resources,
    });
    assert.ok(preview.manifest.artifact.bytes > 0);
    assert.ok((await stat(resolve(root, "preview.mp4"))).size > 0);

    const replay = await generateCutVideoProxy({
      projectRoot: root,
      input: "media/master.mp4",
      output: "media/proxy-replay.mp4",
      width: 320,
    });
    assert.equal(replay.proxy.sha256, generated.proxy.sha256, "same input/policy/toolchain must generate byte-identical proxy media");
    assert.deepEqual(
      await readFile(resolve(root, "media/proxy-replay.mp4")),
      await readFile(resolve(root, "media/proxy.mp4")),
    );

    await assert.rejects(
      generateCutVideoProxy({
        projectRoot: root,
        input: "media/master.mp4",
        output: "media/proxy.mp4",
        width: 320,
      }),
      (error) => error instanceof CutVideoProxyGenerationError && error.code === "CUT_PROXY_GENERATE_COLLISION",
    );
    assert.ok((await readFile(resolve(root, "media/proxy.mp4"))).byteLength > 0, "collision refusal must preserve the existing proxy");
    const outsideTarget = resolve(outsideRoot, "do-not-touch.txt");
    await writeFile(outsideTarget, "outside target remains unchanged\n");
    await symlink(outsideTarget, resolve(root, "media/proxy-symlink.mp4"));
    await assert.rejects(
      generateCutVideoProxy({
        projectRoot: root,
        input: "media/master.mp4",
        output: "media/proxy-symlink.mp4",
        width: 320,
      }),
      (error) => error instanceof CutVideoProxyGenerationError && error.code === "CUT_PROXY_GENERATE_COLLISION",
    );
    assert.equal(await readFile(outsideTarget, "utf8"), "outside target remains unchanged\n");
    await assert.rejects(
      generateCutVideoProxy({
        projectRoot: root,
        input: "media/master.mp4",
        output: "media/proxy-output-limit.mp4",
        width: 320,
        maximumOutputBytes: 16_384,
      }),
      (error) => error instanceof CutVideoProxyGenerationError && error.code === "CUT_PROXY_GENERATE_OUTPUT_LIMIT",
    );
    await assert.rejects(stat(resolve(root, "media/proxy-output-limit.mp4")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.deepEqual(
      (await readdir(resolve(root, "media"))).filter((entry) => entry.startsWith(".cut-proxy-")),
      [],
      "successful and refused generation must remove staging directories",
    );
    await assert.rejects(
      generateCutVideoProxy({
        projectRoot: root,
        input: "../outside.mp4",
        output: "media/escaped-input.mp4",
        width: 320,
      }),
      (error) => error instanceof CutVideoProxyGenerationError && error.code === "CUT_PROXY_GENERATE_LOCATOR",
    );
    await assert.rejects(
      generateCutVideoProxy({
        projectRoot: root,
        input: "media/master.mp4",
        output: "../escaped-output.mp4",
        width: 320,
      }),
      (error) => error instanceof CutVideoProxyGenerationError && error.code === "CUT_PROXY_GENERATE_LOCATOR",
    );
    assert.deepEqual(await readFile(resolve(root, "main.cut")), sourceBefore, "refusals must preserve CUT source");
    assert.deepEqual(await readFile(resolve(root, "media/master.mp4")), masterBefore, "refusals must preserve master media");
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }
});

test("proxy CLI rejects missing and invalid options before filesystem work", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-project-video-proxy-usage-"));
  try {
    const cases = [
      ["proxy", "missing.mp4", "--out", "media/proxy.mp4", "--width", "320", "--json"],
      ["proxy", "missing.mp4", "--project", ".", "--width", "320", "--json"],
      ["proxy", "missing.mp4", "--project", ".", "--out", "media/proxy.mp4", "--json"],
    ] as const;
    for (const args of cases) {
      const result = JSON.parse((await runCli(args, root, 1)).stdout) as { diagnostics: Array<{ code: string; message: string }> };
      assert.equal(result.diagnostics[0]?.code, "CUTC1006");
      assert.doesNotMatch(result.diagnostics[0]?.message ?? "", /ENOENT|no such file/i);
    }
    for (const args of [
      ["proxy", "missing.mp4", "--project", ".", "--out", "media/proxy.mp4", "--width", "63", "--json"],
      ["proxy", "missing.mp4", "--project", ".", "--out", "media/proxy.mp4", "--width", "320", "--stream", "not-an-integer", "--json"],
    ]) {
      const result = JSON.parse((await runCli(args, root, 1)).stdout) as { diagnostics: Array<{ code: string; message: string }> };
      assert.equal(result.diagnostics[0]?.code, "CUTC1007");
      assert.doesNotMatch(result.diagnostics[0]?.message ?? "", /ENOENT|no such file/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
