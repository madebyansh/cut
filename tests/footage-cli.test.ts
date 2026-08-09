import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("dist-cli", "cli", "cut.js");

function runFootage(
  cwd: string,
  home: string,
  ...args: string[]
) {
  return spawnSync(process.execPath, [cli, "footage", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CUT_FOOTAGE_HOME: home,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

function jsonOutput(result: ReturnType<typeof runFootage>) {
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.endsWith("\n"));
  return JSON.parse(result.stdout);
}

test("footage setup and doctor expose stable machine reports without leaking the footage home", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-cli-doctor-"));
  const firstHome = join(root, "private-home-one");
  const secondHome = join(root, "private-home-two");

  const unsupported = runFootage(root, firstHome, "setup", "--backend", "hosted", "--json");
  assert.equal(unsupported.status, 1);
  const setupFailure = jsonOutput(unsupported);
  assert.equal(setupFailure.format, "cut-cli-diagnostics");
  assert.equal(setupFailure.command, "footage setup");
  assert.equal(setupFailure.diagnostics[0].code, "CUT_FOOTAGE_BACKEND_PROTOCOL");
  assert.equal(unsupported.stdout.includes(firstHome), false);

  const first = runFootage(root, firstHome, "doctor", "--json");
  const second = runFootage(root, secondHome, "doctor", "--json");
  assert.equal(first.status, 1);
  assert.equal(second.status, 1);
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(jsonOutput(first), {
    backend: "local",
    checks: [{
      code: "CUTFD1001",
      detail: "The local footage backend is not installed.",
      name: "Local footage backend",
      remedy: "Run cut footage setup --backend local, then rerun footage doctor.",
      status: "fail",
    }],
    format: "cut-footage-local-doctor-report",
    status: "fail",
    version: 1,
  });
});

test("footage option contracts fail before filesystem, media, or backend work", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-cli-options-"));
  const home = join(root, "missing-backend");
  const cases = [
    { args: ["setup", "--json"], command: "footage setup", code: "CUTC1006" },
    { args: ["doctor", "--unknown", "--json"], command: "footage doctor", code: "CUTC1001" },
    { args: ["index", "media", "--json"], command: "footage index", code: "CUTC1006" },
    { args: ["search", ".cut/footage/index.json", "--out", ".cut/footage/search.json", "--json"], command: "footage search", code: "CUTC1006" },
    { args: ["extract", ".cut/footage/search.json", "--out", "selects/dog.mp4", "--json"], command: "footage extract", code: "CUTC1006" },
  ];
  for (const entry of cases) {
    const result = runFootage(root, home, ...entry.args);
    assert.equal(result.status, 1);
    const report = jsonOutput(result);
    assert.equal(report.command, entry.command);
    assert.equal(report.diagnostics[0].code, entry.code);
  }
});

test("footage index reports a missing verified backend before touching source media", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-cli-index-"));
  const home = join(root, "private-missing-backend");
  const result = runFootage(root, home, "index", "media", "--out", ".cut/footage/index.json", "--json");
  assert.equal(result.status, 1);
  const report = jsonOutput(result);
  assert.equal(report.format, "cut-cli-diagnostics");
  assert.equal(report.command, "footage index");
  assert.equal(report.diagnostics[0].code, "CUT_FOOTAGE_BACKEND_MISSING");
  assert.equal(result.stdout.includes(home), false);
});

test("footage search reports a missing verified backend before reading the index", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-cli-search-"));
  const home = join(root, "private-missing-backend");
  const result = runFootage(
    root,
    home,
    "search",
    ".cut/footage/index.json",
    "--query",
    "a dog outdoors",
    "--out",
    ".cut/footage/search.json",
    "--json",
  );
  assert.equal(result.status, 1);
  const report = jsonOutput(result);
  assert.equal(report.command, "footage search");
  assert.equal(report.diagnostics[0].code, "CUT_FOOTAGE_BACKEND_MISSING");
  assert.equal(result.stdout.includes(home), false);
});

test("footage extract rejects noncanonical selectors and handles before reading the search report", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-cli-extract-"));
  for (const entry of [
    { match: "0", code: "CUTC1007" },
    { match: "01", code: "CUTC1007" },
    { match: "not-a-match", code: "CUTC1007" },
    { match: "1", handles: "1.0s", code: "CUT_FOOTAGE_RANGE" },
  ]) {
    const result = runFootage(
      root,
      join(root, "unused-home"),
      "extract",
      ".cut/footage/search.json",
      "--match",
      entry.match,
      ...(entry.handles === undefined ? [] : ["--handles", entry.handles]),
      "--out",
      "selects/dog.mp4",
      "--json",
    );
    assert.equal(result.status, 1);
    const report = jsonOutput(result);
    assert.equal(report.command, "footage extract");
    assert.equal(report.diagnostics[0].code, entry.code);
  }
});
