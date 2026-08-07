import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("dist-cli/cli/cut.js");

async function run(args: string[], cwd: string, expectedCode = 0) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === expectedCode) accept(result);
      else reject(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
  });
}

const source = `cut 0.4;
project "CLI artifact boundary";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {}
}
export out = render(main, width: 64px, height: 64px, codec: "h264");
`;

function tinyPcmWav() {
  const sampleRate = 48_000, samples = 480, channels = 1, bytesPerSample = 2;
  const dataBytes = samples * channels * bytesPerSample, result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + dataBytes, 4);
  result.write("WAVE", 8, "ascii");
  result.write("fmt ", 12, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  result.writeUInt16LE(channels * bytesPerSample, 32);
  result.writeUInt16LE(bytesPerSample * 8, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(dataBytes, 40);
  return result;
}

function diagnosticCode(stdout: string) {
  const report = JSON.parse(stdout) as { diagnostics?: Array<{ code?: string }> };
  return report.diagnostics?.[0]?.code;
}

test("lock and build replace leaf links but reject linked ancestors and project escapes", { skip: process.platform === "win32" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-output-lock-")), project = join(workspace, "project"), outside = join(workspace, "outside");
  try {
    await Promise.all([mkdir(project), mkdir(outside)]);
    await writeFile(join(project, "main.cut"), source);

    const sentinel = join(outside, "canonical.txt"), lockPath = join(project, "cut.lock");
    await writeFile(sentinel, "outside lock sentinel");
    await symlink(sentinel, lockPath);
    const locked = JSON.parse((await run(["lock", "main.cut", "--out", "cut.lock", "--json"], project)).stdout) as { status: string };
    assert.equal(locked.status, "pass");
    assert.equal((await lstat(lockPath)).isFile(), true);
    assert.equal((await lstat(lockPath)).isSymbolicLink(), false);
    assert.equal(await readFile(sentinel, "utf8"), "outside lock sentinel");

    const linkedBuildRoot = join(outside, "linked-build-root");
    await mkdir(linkedBuildRoot);
    await symlink(linkedBuildRoot, join(project, ".cut"));
    const linkedAncestor = await run(["build", "main.cut", "--lock", "cut.lock", "--json"], project, 1);
    assert.equal(diagnosticCode(linkedAncestor.stdout), "CUT_PUBLISH_PREFLIGHT");
    assert.deepEqual(await readdir(linkedBuildRoot), []);

    const escaped = join(workspace, "escaped.cutir.json");
    const escapedWrite = await run(["build", "main.cut", "--lock", "cut.lock", "--out", "../escaped.cutir.json", "--json"], project, 1);
    assert.equal(diagnosticCode(escapedWrite.stdout), "CUT_PUBLISH_PREFLIGHT");
    await assert.rejects(lstat(escaped), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("probe explicit output replaces a leaf link and refuses a linked output ancestor", { skip: process.platform === "win32" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-output-probe-")), project = join(workspace, "project"), outside = join(workspace, "outside");
  try {
    await Promise.all([mkdir(join(project, "media"), { recursive: true }), mkdir(outside)]);
    await writeFile(join(project, "media", "tiny.wav"), tinyPcmWav());

    const sentinel = join(outside, "probe-sentinel.json"), output = join(project, "probe.json");
    await writeFile(sentinel, "outside probe sentinel");
    await symlink(sentinel, output);
    await run(["probe", "media/tiny.wav", "--project", ".", "--out", "probe.json"], project);
    assert.equal((await lstat(output)).isFile(), true);
    assert.equal((await lstat(output)).isSymbolicLink(), false);
    assert.equal(await readFile(sentinel, "utf8"), "outside probe sentinel");
    assert.equal((JSON.parse(await readFile(output, "utf8")) as { format: string }).format, "cut-media-probe");

    const linkedReports = join(outside, "linked-reports");
    await mkdir(linkedReports);
    await symlink(linkedReports, join(project, "reports"));
    const rejected = await run(["probe", "media/tiny.wav", "--project", ".", "--out", "reports/probe.json"], project, 1);
    assert.match(rejected.stderr, /CUT_PUBLISH_PREFLIGHT/);
    assert.deepEqual(await readdir(linkedReports), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("OTIO export publishes both explicit artifacts without following leaf or ancestor links", { skip: process.platform === "win32" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-output-otio-")), project = join(workspace, "project"), outside = join(workspace, "outside");
  try {
    await Promise.all([mkdir(project), mkdir(outside)]);
    await writeFile(join(project, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], project);

    const timelineSentinel = join(outside, "timeline-sentinel.json"), reportSentinel = join(outside, "report-sentinel.json");
    const timeline = join(project, "timeline.otio"), report = join(project, "timeline.report.json");
    await writeFile(timelineSentinel, "outside timeline sentinel");
    await writeFile(reportSentinel, "outside report sentinel");
    await symlink(timelineSentinel, timeline);
    await symlink(reportSentinel, report);
    await run(["otio", "export", "main.cut", "--lock", "cut.lock", "--out", "timeline.otio", "--report", "timeline.report.json", "--allow-lossy"], project);
    assert.equal((await lstat(timeline)).isFile(), true);
    assert.equal((await lstat(report)).isFile(), true);
    assert.equal(await readFile(timelineSentinel, "utf8"), "outside timeline sentinel");
    assert.equal(await readFile(reportSentinel, "utf8"), "outside report sentinel");
    assert.equal((JSON.parse(await readFile(timeline, "utf8")) as { OTIO_SCHEMA: string }).OTIO_SCHEMA, "Timeline.1");

    const linkedExports = join(outside, "linked-exports");
    await mkdir(linkedExports);
    await symlink(linkedExports, join(project, "exports"));
    const rejected = await run([
      "otio", "export", "main.cut", "--lock", "cut.lock", "--out", "exports/timeline.otio",
      "--report", "exports/timeline.report.json", "--allow-lossy",
    ], project, 1);
    assert.match(rejected.stderr, /CUT_PUBLISH_PREFLIGHT/);
    assert.deepEqual(await readdir(linkedExports), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
