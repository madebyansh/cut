#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const maximumReportBytes = 4 * 1024 * 1024;
const reportFormats = Object.freeze({
  "doctor.json": "cut-doctor-report",
  "fmt.json": "cut-format-report",
  "check.json": "cut-diagnostics",
  "lint.json": "cut-lint-report",
  "lock.json": "cut-lock-report",
  "build.json": "cut-build-report",
  "inspect.json": "cut-inspect-report",
  "test.json": "cut-av-test-report",
  "frame.json": "cut-frame-report",
  "preview.json": "cut-preview-report",
  "render.json": "cut-render-report",
});

function fail(message) {
  throw new Error(`CUT_LINUX_PACKAGE_SMOKE: ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be one JSON object`);
  return value;
}

async function json(path, label) {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > maximumReportBytes) fail(`${label} has an invalid bounded size`);
  try { return record(JSON.parse(bytes.toString("utf8")), label); }
  catch (error) { fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function contained(root, locator, label) {
  if (typeof locator !== "string" || !locator || isAbsolute(locator)) fail(`${label} must be project-relative`);
  const path = resolve(root, locator), relation = relative(root, path);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail(`${label} escapes the project`);
  return path;
}

async function nonemptyFile(root, locator) {
  const path = contained(root, locator, locator), state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile() || state.size <= 0) fail(`${locator} must be one non-empty regular file`);
  return path;
}

function dimensions(report, label, width, height) {
  const manifest = record(report.manifest, `${label}.manifest`), canvas = record(manifest.canvas, `${label}.manifest.canvas`);
  if (canvas.width !== width || canvas.height !== height) fail(`${label} must report ${width}x${height}`);
}

function probe(report, label, width, height, minimumDuration, maximumDuration) {
  if (!Array.isArray(report.streams)) fail(`${label}.streams must be an array`);
  const video = report.streams.find((stream) => stream?.codec_type === "video");
  const audio = report.streams.find((stream) => stream?.codec_type === "audio");
  if (video?.codec_name !== "h264" || video.width !== width || video.height !== height || video.pix_fmt !== "yuv420p") {
    fail(`${label} must contain ${width}x${height} H.264/yuv420p video`);
  }
  if (audio?.codec_name !== "aac" || String(audio.sample_rate) !== "48000" || audio.channels !== 2) {
    fail(`${label} must contain 48 kHz stereo AAC audio`);
  }
  const format = record(report.format, `${label}.format`), duration = Number(format.duration);
  if (typeof format.format_name !== "string" || !format.format_name.split(",").some((name) => name === "mp4" || name === "mov")) {
    fail(`${label} must be an MP4-family container`);
  }
  if (!Number.isFinite(duration) || duration < minimumDuration || duration > maximumDuration) {
    fail(`${label} duration ${String(format.duration)} is outside ${minimumDuration}..${maximumDuration} seconds`);
  }
}

export async function assertLinuxPackageSmoke(projectRoot, reportsRoot) {
  const project = resolve(projectRoot), reports = resolve(reportsRoot), loaded = {};
  for (const [name, format] of Object.entries(reportFormats)) {
    const report = await json(resolve(reports, name), name);
    if (report.format !== format) fail(`${name} must be one ${format}`);
    if (name === "fmt.json") {
      if (report.status !== "unchanged") fail("fmt.json must prove the generated starter was already formatted");
    } else if (name === "test.json") {
      const summary = record(report.summary, "test.json.summary");
      if (summary.fail !== 0 || summary.deferred !== 0 || summary.pass !== summary.total) fail("test.json must prove every authored assertion passed");
    } else if (report.status !== "pass") fail(`${name} must report pass`);
    loaded[name] = report;
  }

  const doctor = loaded["doctor.json"], platform = record(doctor.platform, "doctor.platform");
  if (platform.os !== "linux" || !["x64", "arm64"].includes(platform.architecture)) {
    fail("doctor must identify one admitted Linux architecture");
  }
  if (!Array.isArray(doctor.checks)) fail("doctor.checks must be an array");
  const accelerator = doctor.checks.find((check) => check?.code === "CUTD1210");
  if (accelerator?.status !== "pass" || typeof accelerator.detail !== "string" || !accelerator.detail.startsWith("JavaScript fallback")) {
    fail("doctor must prove the Linux JavaScript compositor fallback");
  }

  dimensions(loaded["frame.json"], "frame.json", 960, 540);
  if (loaded["frame.json"].manifest.frame?.index !== 0) fail("frame.json must report frame zero");
  dimensions(loaded["preview.json"], "preview.json", 320, 180);
  dimensions(loaded["render.json"], "render.json", 960, 540);

  const previewProbe = await json(resolve(reports, "preview-ffprobe.json"), "preview-ffprobe.json");
  const renderProbe = await json(resolve(reports, "render-ffprobe.json"), "render-ffprobe.json");
  probe(previewProbe, "preview-ffprobe.json", 320, 180, 0.20, 0.50);
  probe(renderProbe, "render-ffprobe.json", 960, 540, 2.90, 3.20);

  for (const locator of ["cut.lock", ".cut/graph.cutir.json", "review/frame-0.png", "review/range-preview.mp4", "output/preview-render.mp4"]) {
    await nonemptyFile(project, locator);
  }
  const png = await readFile(contained(project, "review/frame-0.png", "frame PNG"));
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail("frame artifact is not a PNG");

  return Object.freeze({
    status: "pass",
    platform: `linux/${platform.architecture}`,
    frame: "960x540",
    preview: "320x180",
    render: "960x540",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [project, reports, extra] = process.argv.slice(2);
  if (!project || !reports || extra) fail("usage: assert-linux-package-smoke.mjs <project-root> <reports-root>");
  process.stdout.write(`${JSON.stringify(await assertLinuxPackageSmoke(project, reports))}\n`);
}
