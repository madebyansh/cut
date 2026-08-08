import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLinuxPackageSmoke } from "./assert-linux-package-smoke.mjs";

const pass = (format) => ({ format, status: "pass" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cut-linux-smoke-assert-"));
  const project = join(root, "film"), reports = join(root, "reports");
  await Promise.all([
    mkdir(join(project, ".cut"), { recursive: true }),
    mkdir(join(project, "review"), { recursive: true }),
    mkdir(join(project, "output"), { recursive: true }),
    mkdir(reports, { recursive: true }),
  ]);
  const reportValues = {
    "doctor.json": {
      ...pass("cut-doctor-report"),
      platform: { os: "linux", architecture: "x64", node: "20.20.2" },
      checks: [{ code: "CUTD1210", name: "CUT compositor accelerator", status: "pass", detail: "JavaScript fallback · native accelerator unavailable for linux/x64" }],
    },
    "fmt.json": { format: "cut-format-report", status: "unchanged" },
    "check.json": pass("cut-diagnostics"),
    "lint.json": pass("cut-lint-report"),
    "lock.json": pass("cut-lock-report"),
    "build.json": pass("cut-build-report"),
    "inspect.json": pass("cut-inspect-report"),
    "test.json": { format: "cut-av-test-report", summary: { pass: 1, fail: 0, deferred: 0, total: 1 } },
    "frame.json": { ...pass("cut-frame-report"), manifest: { canvas: { width: 960, height: 540 }, frame: { index: 0 } } },
    "preview.json": { ...pass("cut-preview-report"), manifest: { canvas: { width: 320, height: 180 } } },
    "render.json": { ...pass("cut-render-report"), manifest: { canvas: { width: 960, height: 540 } } },
    "preview-ffprobe.json": probe(320, 180, "0.272000"),
    "render-ffprobe.json": probe(960, 540, "3.008000"),
  };
  await Promise.all(Object.entries(reportValues).map(([name, value]) => writeFile(join(reports, name), JSON.stringify(value))));
  await Promise.all([
    writeFile(join(project, "cut.lock"), "lock"),
    writeFile(join(project, ".cut/graph.cutir.json"), "{}"),
    writeFile(join(project, "review/frame-0.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])),
    writeFile(join(project, "review/range-preview.mp4"), "mp4"),
    writeFile(join(project, "output/preview-render.mp4"), "mp4"),
  ]);
  return { project, reports, reportValues };
}

function probe(width, height, duration) {
  return {
    streams: [
      { codec_type: "video", codec_name: "h264", width, height, pix_fmt: "yuv420p" },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
    ],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration },
  };
}

test("linux package smoke assertion accepts structural evidence without golden hashes", async () => {
  const { project, reports } = await fixture();
  assert.deepEqual(await assertLinuxPackageSmoke(project, reports), {
    status: "pass",
    platform: "linux/x64",
    frame: "960x540",
    preview: "320x180",
    render: "960x540",
  });
});

test("linux package smoke assertion fails closed on backend, stream, duration, and artifact drift", async () => {
  for (const mutate of [
    (values) => { values["doctor.json"].checks[0].detail = "native · forbidden"; },
    (values) => { values["preview-ffprobe.json"].streams.pop(); },
    (values) => { values["render-ffprobe.json"].format.duration = "2.5"; },
  ]) {
    const { project, reports, reportValues } = await fixture();
    mutate(reportValues);
    await Promise.all(Object.entries(reportValues).map(([name, value]) => writeFile(join(reports, name), JSON.stringify(value))));
    await assert.rejects(assertLinuxPackageSmoke(project, reports));
  }
  const { project, reports } = await fixture();
  await writeFile(join(project, "review/range-preview.mp4"), "");
  await assert.rejects(assertLinuxPackageSmoke(project, reports));
});
