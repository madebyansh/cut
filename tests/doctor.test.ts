import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { collectCutDoctorReport, cutDoctorMediaInputPlatformCheck, cutDoctorNodeVersionCheck, runBoundedDoctorTool } from "../lib/system/doctor";
import { cutProductVersion, cutVersionLine } from "../lib/version";

const encoderInventory = " V..... libx264 H.264 / AVC\n A..... aac AAC\n";

function passingToolResult(stdout: string) {
  return { status: "pass" as const, stdout, detail: stdout.split(/\r?\n/, 1)[0] ?? "" };
}

function exactReferenceProbe(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    streams: [
      { codec_name: "h264", codec_type: "video", pix_fmt: "yuv420p", width: 16, height: 16, avg_frame_rate: "8/1", nb_read_frames: "2", duration: "0.250000", ...overrides },
      { codec_name: "aac", codec_type: "audio", sample_rate: "48000", channels: 2, duration: "0.250000" },
    ],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "0.250000" },
  });
}

async function assertProcessExited(pidPath: string) {
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
}

async function writePersistentHelper(root: string) {
  const helper = resolve(root, "persistent-child.mjs");
  await writeFile(helper, [
    'import { openSync, writeFileSync, writeSync } from "node:fs";',
    "const [, , pidPath, heldPath, mode] = process.argv;",
    "writeFileSync(pidPath, String(process.pid));",
    'const handle = openSync(heldPath, "w");',
    'writeSync(handle, "started");',
    'if (mode === "output") process.stdout.write("x".repeat(4096));',
    'setInterval(() => writeSync(handle, "x"), 5);',
  ].join("\n"));
  return helper;
}

test("version line reports product, language, IR, package ABI, and runtime identities", () => {
  assert.match(cutVersionLine(), new RegExp(`^cut ${cutProductVersion.replaceAll(".", "\\.")}`));
  assert.match(cutVersionLine(), /language 0\.4/);
  assert.match(cutVersionLine(), /CutAVIR 3/);
  assert.match(cutVersionLine(), /package ABI 1/);
  assert.match(cutVersionLine(), /cut-reference\/0\.4\.0-alpha\.1/);
});

test("CLI product identity matches the installable package version", async () => {
  const packageMetadata = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
  assert.equal(cutProductVersion, packageMetadata.version);
});

test("doctor exposes the explicit Windows media-input exclusion", () => {
  assert.deepEqual(cutDoctorMediaInputPlatformCheck("win32"), {
    code: "CUTD1003",
    name: "Media input platform",
    status: "fail",
    detail: "Windows media lock/probe/render is unsupported because this runtime cannot pass an already-open input descriptor to ffprobe safely.",
    remedy: "Use the current macOS or Linux runtime; Windows support remains a pre-1.0 release gate.",
  });
  assert.equal(cutDoctorMediaInputPlatformCheck("darwin").status, "pass");
  assert.equal(cutDoctorMediaInputPlatformCheck("linux").status, "pass");
});

test("doctor admits only the scoped Node 20.x runtime", () => {
  assert.deepEqual(cutDoctorNodeVersionCheck("20.20.2"), {
    code: "CUTD1000",
    name: "Node.js",
    status: "pass",
    detail: "Node.js 20.20.2",
  });
  for (const version of ["19.9.0", "21.0.0", "25.5.0", "20", "v20.20.2", "20.x"]) {
    const result = cutDoctorNodeVersionCheck(version);
    assert.equal(result.code, "CUTD1001");
    assert.equal(result.status, "fail");
    assert.match(result.remedy ?? "", /Node\.js 20\.x/u);
  }
});

test("doctor returns stable coded checks without machine-local paths", { timeout: 45_000 }, async () => {
  const report = await collectCutDoctorReport();
  assert.equal(report.format, "cut-doctor-report");
  assert.equal(report.version, 1);
  assert.equal(report.cut.product, cutProductVersion);
  assert.ok(report.checks.length >= 7);
  assert.ok(report.checks.every((check) => /^CUTD\d{4}$/.test(check.code)));
  assert.ok(report.checks.some((check) => check.name === "FFmpeg"));
  assert.deepEqual(report.checks.find((check) => check.name === "Temporary workspace"), {
    code: "CUTD1010",
    name: "Temporary workspace",
    status: "pass",
    detail: "private temporary bytes were created, verified, and removed",
  });
  assert.equal(report.checks.find((check) => check.name === "Reference media pipeline")?.code, "CUTD1130");
  assert.equal(report.checks.find((check) => check.name === "CUT-owned limiter")?.code, "CUTD1140");
  assert.ok(report.checks.some((check) => check.name === "Reference compositor"));
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/|[A-Z]:\\\\Users\\\\/);
  assert.equal(report.status, report.checks.some((check) => check.status === "fail") ? "fail" : "pass");
});

test("bounded doctor tool confirms timeout termination before returning", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-doctor-timeout-lifecycle-"));
  try {
    const helper = await writePersistentHelper(root);
    const pid = resolve(root, "child.pid");
    const held = resolve(root, "held.bin");
    const result = await runBoundedDoctorTool(process.execPath, [helper, pid, held, "timeout"], 500, 1024);
    assert.deepEqual(result, {
      status: "fail",
      stdout: "",
      detail: "native tool exceeded the 500ms diagnostic timeout",
    });
    await assertProcessExited(pid);
    await rm(root, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded doctor tool confirms output-budget termination before returning", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-doctor-output-lifecycle-"));
  try {
    const helper = await writePersistentHelper(root);
    const pid = resolve(root, "child.pid");
    const held = resolve(root, "held.bin");
    const result = await runBoundedDoctorTool(process.execPath, [helper, pid, held, "output"], 2_000, 64);
    assert.deepEqual(result, {
      status: "fail",
      stdout: "",
      detail: "native tool exceeded the 64-byte diagnostic output budget",
    });
    await assertProcessExited(pid);
    await rm(root, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor normalizes a missing loudnorm capability and removes every private temp byte", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-doctor-normalization-"));
  const privateFragment = resolve(root, "must-not-leak");
  try {
    const report = await collectCutDoctorReport({
      temporaryRoot: root,
      runTool: async (command, args) => {
        if (command === "ffmpeg" && args.includes("-filter_complex")) {
          return { status: "fail" as const, stdout: `No such filter: 'loudnorm'\n${privateFragment}\n`, detail: `ffmpeg exited with 1 at ${privateFragment}` };
        }
        if (command === "ffmpeg" && args.includes("-encoders")) return passingToolResult(encoderInventory);
        if (command === "ffmpeg") return passingToolResult("ffmpeg version doctor-test\n");
        if (command === "ffprobe") return passingToolResult("ffprobe version doctor-test\n");
        throw new Error("unexpected tool");
      },
    });
    assert.equal(report.status, "fail");
    assert.deepEqual(report.checks.find((check) => check.name === "Reference media pipeline"), {
      code: "CUTD1131",
      name: "Reference media pipeline",
      status: "fail",
      detail: "FFmpeg does not provide the loudnorm mastering filter.",
      remedy: "Install an FFmpeg build with the loudnorm audio filter enabled.",
    });
    assert.equal(report.checks.find((check) => check.name === "Temporary workspace")?.status, "pass");
    assert.ok(!JSON.stringify(report).includes(root));
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor normalizes bounded media timeout and output failures", { timeout: 15_000 }, async (context) => {
  const cases = [
    {
      name: "timeout",
      detail: "native tool exceeded the 15ms diagnostic timeout",
      expectedDetail: "The bounded FFmpeg capability probe timed out.",
      expectedRemedy: "Check the FFmpeg installation and available CPU/temp-space resources, then rerun cut doctor.",
    },
    {
      name: "output budget",
      detail: "native tool exceeded the 64-byte diagnostic output budget",
      expectedDetail: "FFmpeg exceeded CUT's bounded diagnostic output limit.",
      expectedRemedy: "Repair the FFmpeg installation so the tiny reference probe completes without unbounded diagnostics.",
    },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      const root = await mkdtemp(resolve(tmpdir(), "cut-doctor-bounded-failure-"));
      try {
        const report = await collectCutDoctorReport({
          temporaryRoot: root,
          runTool: async (command, args) => {
            if (command === "ffmpeg" && args.includes("-filter_complex")) {
              return { status: "fail" as const, stdout: `${root}/must-not-leak`, detail: item.detail };
            }
            if (command === "ffmpeg" && args.includes("-encoders")) return passingToolResult(encoderInventory);
            if (command === "ffmpeg") return passingToolResult("ffmpeg version doctor-test\n");
            return passingToolResult("ffprobe version doctor-test\n");
          },
        });
        assert.deepEqual(report.checks.find((check) => check.name === "Reference media pipeline"), {
          code: "CUTD1131",
          name: "Reference media pipeline",
          status: "fail",
          detail: item.expectedDetail,
          remedy: item.expectedRemedy,
        });
        assert.ok(!JSON.stringify(report).includes(root));
        assert.deepEqual(await readdir(root), []);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("doctor normalizes malformed ffprobe output without retaining its bounded artifact", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-doctor-ffprobe-normalization-"));
  const privateFragment = resolve(root, "must-not-leak");
  try {
    const report = await collectCutDoctorReport({
      temporaryRoot: root,
      runTool: async (command, args) => {
        if (command === "ffmpeg" && args.includes("-filter_complex")) {
          await writeFile(args.at(-1)!, "bounded fake artifact");
          return passingToolResult("");
        }
        if (command === "ffmpeg" && args.includes("-encoders")) return passingToolResult(encoderInventory);
        if (command === "ffmpeg") return passingToolResult(`ffmpeg version ${privateFragment}\n`);
        if (command === "ffprobe" && args.includes("-version")) return passingToolResult(`ffprobe version ${privateFragment}\n`);
        if (command === "ffprobe") return passingToolResult(`not-json ${privateFragment}`);
        throw new Error("unexpected tool");
      },
    });
    assert.equal(report.status, "fail");
    assert.deepEqual(report.checks.find((check) => check.name === "Reference media pipeline"), {
      code: "CUTD1131",
      name: "Reference media pipeline",
      status: "fail",
      detail: "FFprobe returned invalid JSON for CUT's bounded reference artifact.",
      remedy: "Repair or reinstall ffprobe, then rerun cut doctor.",
    });
    assert.equal(report.checks.find((check) => check.code === "CUTD1100")?.detail, "FFmpeg is available");
    assert.equal(report.checks.find((check) => check.code === "CUTD1110")?.detail, "FFprobe is available");
    assert.ok(!JSON.stringify(report).includes(root));
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor rejects valid JSON describing a truncated or wrong-sized artifact", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-doctor-wrong-metadata-"));
  try {
    const report = await collectCutDoctorReport({
      temporaryRoot: root,
      runTool: async (command, args) => {
        if (command === "ffmpeg" && args.includes("-filter_complex")) {
          await writeFile(args.at(-1)!, "bounded fake artifact");
          return passingToolResult("");
        }
        if (command === "ffmpeg" && args.includes("-encoders")) return passingToolResult(encoderInventory);
        if (command === "ffmpeg") return passingToolResult("ffmpeg version doctor-test\n");
        if (command === "ffprobe" && args.includes("-version")) return passingToolResult("ffprobe version doctor-test\n");
        return passingToolResult(exactReferenceProbe({ width: 32, nb_read_frames: "1", duration: "0.125000" }));
      },
    });
    assert.deepEqual(report.checks.find((check) => check.name === "Reference media pipeline"), {
      code: "CUTD1131",
      name: "Reference media pipeline",
      status: "fail",
      detail: "FFmpeg/ffprobe did not preserve CUT's bounded H.264/AAC delivery contract.",
      remedy: "Install compatible FFmpeg and ffprobe binaries with libx264, AAC, MP4, yuv420p, and the required mastering filters.",
    });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports private workspace cleanup failure without leaking its path", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-doctor-cleanup-failure-"));
  try {
    const report = await collectCutDoctorReport({
      temporaryRoot: root,
      runTool: async (command, args) => {
        if (command === "ffmpeg" && args.includes("-filter_complex")) {
          const output = args.at(-1)!;
          await writeFile(output, "bounded fake artifact");
          await chmod(dirname(output), 0o500);
          return passingToolResult("");
        }
        if (command === "ffmpeg" && args.includes("-encoders")) return passingToolResult(encoderInventory);
        if (command === "ffmpeg") return passingToolResult("ffmpeg version doctor-test\n");
        if (command === "ffprobe" && args.includes("-version")) return passingToolResult("ffprobe version doctor-test\n");
        return passingToolResult(exactReferenceProbe());
      },
    });
    assert.deepEqual(report.checks.find((check) => check.name === "Temporary workspace"), {
      code: "CUTD1011",
      name: "Temporary workspace",
      status: "fail",
      detail: "CUT could not remove its private temporary probe bytes.",
      remedy: "Check temporary-directory permissions, remove the failed cut-doctor workspace, and rerun cut doctor.",
    });
    assert.equal(report.checks.find((check) => check.name === "Reference media pipeline")?.code, "CUTD1130");
    assert.ok(!JSON.stringify(report).includes(root));
  } finally {
    for (const entry of await readdir(root).catch(() => [])) await chmod(resolve(root, entry), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports an unwritable temp root without echoing the machine path", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-doctor-temp-failure-"));
  const missingRoot = resolve(root, "does-not-exist");
  try {
    const report = await collectCutDoctorReport({
      temporaryRoot: missingRoot,
      runTool: async (command, args) => {
        if (command === "ffmpeg" && args.includes("-encoders")) return passingToolResult(encoderInventory);
        if (command === "ffmpeg") return passingToolResult("ffmpeg version doctor-test\n");
        return passingToolResult("ffprobe version doctor-test\n");
      },
    });
    assert.deepEqual(report.checks.find((check) => check.name === "Temporary workspace"), {
      code: "CUTD1011",
      name: "Temporary workspace",
      status: "fail",
      detail: "The operating-system temporary directory is not writable.",
      remedy: "Make the operating-system temporary directory writable with available free space.",
    });
    assert.equal(report.checks.find((check) => check.name === "Reference media pipeline")?.status, "fail");
    assert.ok(!JSON.stringify(report).includes(root));
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
