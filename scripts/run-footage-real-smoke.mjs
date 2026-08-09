#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertFootageRealSmoke } from "./assert-footage-real-smoke.mjs";

const offlineEnvironment = Object.freeze({
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  npm_config_offline: "true",
});

function absolute(value, label) {
  if (typeof value !== "string" || !value || !isAbsolute(value)) throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${label} must be absolute`);
  return resolve(value);
}

function contains(parent, child) {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function distinctPrivateRoots(values) {
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (contains(values[left], values[right]) || contains(values[right], values[left])) {
        throw new Error("CUT_FOOTAGE_REAL_SMOKE: project, reports, and footage home must be distinct non-overlapping roots");
      }
    }
  }
}

function step(name, command, args, cwd, environment, reportPath, extra = {}) {
  return Object.freeze({ name, command, args: Object.freeze(args), cwd, environment: Object.freeze(environment), ...(reportPath ? { reportPath } : {}), ...extra });
}

export function createFootageRealSmokePlan(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("CUT_FOOTAGE_REAL_SMOKE: options must be one object");
  const cut = absolute(options.cutExecutable, "cut executable");
  const ffmpeg = absolute(options.ffmpegExecutable, "ffmpeg executable");
  const ffprobe = absolute(options.ffprobeExecutable, "ffprobe executable");
  const fixtures = absolute(options.fixtureRoot, "fixture root");
  const project = absolute(options.projectRoot, "project root");
  const reports = absolute(options.reportsRoot, "reports root");
  const home = absolute(options.footageHome, "footage home");
  distinctPrivateRoots([project, reports, home]);

  const online = Object.freeze({ CUT_FOOTAGE_HOME: home });
  const offline = Object.freeze({ CUT_FOOTAGE_HOME: home, ...offlineEnvironment });
  const videoArgs = (input, output) => [
    "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "24", "-i", resolve(fixtures, input),
    "-t", "2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", resolve(project, output),
  ];
  const cutStep = (name, args, report, timeoutMs, extra = {}) => step(name, cut, args, project, offline, resolve(reports, report), { timeoutMs, ...extra });

  return Object.freeze([
    step("dog-video", ffmpeg, videoArgs("dog-outdoors.jpg", "media/dog-outdoors.mp4"), project, Object.freeze({}), undefined, { timeoutMs: 2 * 60_000 }),
    step("dashboard-video", ffmpeg, videoArgs("laptop-dashboard.jpg", "media/laptop-dashboard.mp4"), project, Object.freeze({}), undefined, { timeoutMs: 2 * 60_000 }),
    step("setup-first", cut, ["footage", "setup", "--backend", "local", "--json"], project, online, resolve(reports, "setup-first.json"), { timeoutMs: 30 * 60_000, allowNetwork: true }),
    cutStep("setup-second", ["footage", "setup", "--backend", "local", "--json"], "setup-second.json", 5 * 60_000),
    cutStep("doctor", ["footage", "doctor", "--json"], "doctor.json", 5 * 60_000),
    cutStep("index", ["footage", "index", "media", "--out", ".cut/footage/index.json", "--json"], "index.json", 30 * 60_000),
    cutStep("search-first", ["footage", "search", ".cut/footage/index.json", "--query", "a dog outdoors", "--out", ".cut/footage/search.json", "--json"], "search-first.json", 10 * 60_000),
    cutStep("search-second", ["footage", "search", ".cut/footage/index.json", "--query", "a dog outdoors", "--out", ".cut/footage/search.json", "--json"], "search-second.json", 10 * 60_000),
    cutStep("extract", ["footage", "extract", ".cut/footage/search.json", "--match", "1", "--out", "selects/dog.mp4", "--json"], "extract.json", 10 * 60_000),
    cutStep("extract-no-clobber", ["footage", "extract", ".cut/footage/search.json", "--match", "1", "--out", "selects/dog.mp4", "--json"], "extract-no-clobber.json", 2 * 60_000, {
      expectedExit: "failure",
      expectedDiagnostic: Object.freeze({ format: "cut-cli-diagnostics", command: "footage extract", code: "CUT_FOOTAGE_OUTPUT_EXISTS" }),
      preserveOutputs: Object.freeze([
        resolve(project, "selects/dog.mp4"),
        resolve(project, "selects/dog.mp4.cut-footage.json"),
      ]),
    }),
    step("extract-ffprobe", ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", resolve(project, "selects/dog.mp4")], project, offline, resolve(reports, "extract-ffprobe.json"), { timeoutMs: 2 * 60_000 }),
  ]);
}

export function executeFootageRealSmokeCommand(item) {
  const childEnvironment = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    HF_HUB_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    ...item.environment,
  };
  if (item.allowNetwork === true) {
    delete childEnvironment.HF_HUB_OFFLINE;
    delete childEnvironment.TRANSFORMERS_OFFLINE;
    delete childEnvironment.npm_config_offline;
  }
  return new Promise((resolveResult) => {
    execFile(item.command, item.args, {
      cwd: item.cwd,
      env: childEnvironment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: item.timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : error.killed ? 124 : 70;
      resolveResult(Object.freeze({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" }));
    });
  });
}

function executionResult(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(value.exitCode)
    || typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${name} returned an invalid process result`);
  }
  return value;
}

function hasExpectedDiagnostic(result, expected) {
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { return false; }
  return result.stderr === "" && result.stdout.endsWith("\n") && report?.format === expected.format && report?.version === 1
    && report?.command === expected.command && report?.status === "fail" && Array.isArray(report?.diagnostics)
    && report.diagnostics.length === 1 && report.diagnostics[0]?.code === expected.code && report.diagnostics[0]?.severity === "error";
}

export async function executeFootageRealSmokePlan(plan, operations) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 64) throw new Error("CUT_FOOTAGE_REAL_SMOKE: execution plan is invalid");
  if (!operations || typeof operations.execute !== "function") throw new Error("CUT_FOOTAGE_REAL_SMOKE: process executor is required");
  for (const item of plan) {
    const protectedBytes = new Map();
    for (const path of item.preserveOutputs ?? []) protectedBytes.set(path, await readFile(path));
    const result = executionResult(await operations.execute(item), item.name);
    if (item.reportPath) {
      await mkdir(dirname(item.reportPath), { recursive: true });
      await writeFile(item.reportPath, result.stdout, { encoding: "utf8", flag: "wx" });
    }
    for (const [path, before] of protectedBytes) {
      const after = await readFile(path);
      if (!before.equals(after)) throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${item.name} changed an existing output`);
    }
    if (item.expectedExit === "failure") {
      if (result.exitCode === 0) throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${item.name} was expected to fail`);
      if (result.exitCode !== 1) throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${item.name} expected exit 1 but received ${result.exitCode}`);
      if (item.expectedDiagnostic && !hasExpectedDiagnostic(result, item.expectedDiagnostic)) {
        throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${item.name} returned the wrong failure diagnostic`);
      }
    } else if (result.exitCode !== 0) {
      throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${item.name} failed with exit ${result.exitCode}`);
    }
  }
}

async function requireRegularInput(path, label, executable = false) {
  let target;
  try { target = await realpath(path); }
  catch { throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${label} is missing`); }
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${label} must be one non-empty regular file`);
  if (executable) {
    try { await access(path, constants.X_OK); }
    catch { throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${label} is not executable`); }
  }
}

async function requireAbsent(path) {
  try {
    await lstat(path);
    throw new Error("CUT_FOOTAGE_REAL_SMOKE: project, reports, and footage home must be fresh empty roots");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export async function runFootageRealSmoke(options, operations) {
  const plan = createFootageRealSmokePlan(options);
  const execute = operations?.execute ?? executeFootageRealSmokeCommand;
  const assertSmoke = operations?.assertSmoke ?? assertFootageRealSmoke;
  if (typeof execute !== "function" || typeof assertSmoke !== "function") throw new Error("CUT_FOOTAGE_REAL_SMOKE: runner operations are invalid");
  const project = resolve(options.projectRoot), reports = resolve(options.reportsRoot), home = resolve(options.footageHome);
  await Promise.all([
    requireRegularInput(options.cutExecutable, "cut executable", true),
    requireRegularInput(options.ffmpegExecutable, "ffmpeg executable", true),
    requireRegularInput(options.ffprobeExecutable, "ffprobe executable", true),
    requireRegularInput(resolve(options.fixtureRoot, "dog-outdoors.jpg"), "dog fixture"),
    requireRegularInput(resolve(options.fixtureRoot, "laptop-dashboard.jpg"), "dashboard fixture"),
    requireAbsent(project), requireAbsent(reports), requireAbsent(home),
  ]);
  await mkdir(project);
  await mkdir(reports);
  await mkdir(home);
  await Promise.all([
    mkdir(resolve(project, "media")),
    mkdir(resolve(project, ".cut/footage"), { recursive: true }),
    mkdir(resolve(project, "selects")),
  ]);
  const protectedFiles = Object.freeze({
    "main.cut": Buffer.from("cut 0.4;\n", "utf8"),
    "cut.lock": Buffer.from("cut-footage-real-smoke-lock\n", "utf8"),
  });
  await Promise.all(Object.entries(protectedFiles).map(([locator, bytes]) => writeFile(resolve(project, locator), bytes, { flag: "wx" })));
  await writeFile(resolve(reports, "protected.json"), `${JSON.stringify(Object.fromEntries(Object.entries(protectedFiles).map(([locator, bytes]) => [locator, digest(bytes)])))}\n`, { flag: "wx" });
  await executeFootageRealSmokePlan(plan, { execute });
  return assertSmoke(project, reports, home);
}

async function main() {
  const [cutExecutable, ffmpegExecutable, ffprobeExecutable, fixtureRoot, projectRoot, reportsRoot, footageHome, extra] = process.argv.slice(2);
  if (!cutExecutable || !ffmpegExecutable || !ffprobeExecutable || !fixtureRoot || !projectRoot || !reportsRoot || !footageHome || extra) {
    throw new Error("CUT_FOOTAGE_REAL_SMOKE: usage: run-footage-real-smoke.mjs <cut> <ffmpeg> <ffprobe> <fixture-root> <project-root> <reports-root> <footage-home>");
  }
  process.stdout.write(`${JSON.stringify(await runFootageRealSmoke({ cutExecutable, ffmpegExecutable, ffprobeExecutable, fixtureRoot, projectRoot, reportsRoot, footageHome }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
