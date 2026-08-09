import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import { parseCutFootageIndex } from "../lib/footage/contracts";
import { buildCutFootageSearchReport } from "../lib/footage/search";
import { defaultFootageChunkPolicy, planFootageSources } from "../lib/footage/planner";
import { rational } from "../lib/language/rational";
import { createCutProject } from "../lib/project";

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

async function cliExtractionFixture() {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-cli-signal-")), "project");
  await createCutProject(root, "CLI extraction signal");
  await copyFile(resolve("examples/media/demo.mp4"), join(root, "media/source.mp4"));
  const backend = Object.freeze({
    protocolVersion: 1 as const,
    provider: "fixture",
    model: "clip@r1+adapter.abc",
    dimensions: 4,
    normalization: "l2" as const,
  });
  const plan = await planFootageSources({ projectRoot: root, locators: ["media/source.mp4"], backend });
  const source = plan.sources[0]!.source;
  const chunk = Object.freeze({
    id: "chunk-main",
    sourceLocator: source.locator,
    sourceSha256: source.sha256,
    streamIndex: 0,
    range: Object.freeze({ semantics: "half-open" as const, start: rational(1), end: rational(2) }),
  });
  const body = Object.freeze({
    format: "cut-footage-index" as const,
    version: 1 as const,
    root: "media",
    sources: Object.freeze([source]),
    chunkPolicy: defaultFootageChunkPolicy,
    chunks: Object.freeze([chunk]),
    backend,
    vectorArtifact: Object.freeze({ locator: ".cut/footage/index.vectors", bytes: 16, sha256: "c".repeat(64) }),
    creation: Object.freeze({ cutVersion: "0.4.0-test", backendProtocolVersion: 1 as const }),
  });
  const index = parseCutFootageIndex(`${stableJsonStringify({
    ...body,
    indexSha256: createHash("sha256").update(stableJsonStringify(body)).digest("hex"),
  })}\n`);
  const search = buildCutFootageSearchReport(index, ".cut/footage/index.json", "dog", [{ chunkId: chunk.id, score: 0.9 }], { thresholdPpm: 0, limit: 10 });
  await mkdir(join(root, ".cut/footage"), { recursive: true });
  await Promise.all([
    writeFile(join(root, ".cut/footage/index.json"), `${stableJsonStringify(index)}\n`),
    writeFile(join(root, ".cut/footage/search.json"), search.bytes),
  ]);
  return root;
}

test("footage extract maps SIGINT and SIGTERM to cancellation and leaves no candidate pair", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const root = await cliExtractionFixture(), output = `selects/cancel-${signal.toLowerCase()}.mp4`;
    const child = spawn(process.execPath, [
      cli,
      "footage",
      "extract",
      ".cut/footage/search.json",
      "--match",
      "1",
      "--out",
      output,
      "--json",
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        CUT_FOOTAGE_HOME: join(root, "unused-home"),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(value));
    child.stderr.on("data", (value: Buffer) => stderr.push(value));
    const deadline = Date.now() + 10_000;
    while (true) {
      if (await lstat(join(root, "selects")).then(() => true, () => false)) break;
      if (Date.now() > deadline) throw new Error(`footage extract did not reach its destination boundary before ${signal}`);
      await new Promise((accept) => setTimeout(accept, 5));
    }
    assert.equal(child.kill(signal), true);
    const terminal = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((accept) => {
      child.once("close", (code, terminalSignal) => accept({ code, signal: terminalSignal }));
    });
    assert.deepEqual(terminal, { code: 1, signal: null });
    assert.equal(Buffer.concat(stderr).toString("utf8"), "");
    const report = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    assert.equal(report.command, "footage extract");
    assert.equal(report.diagnostics[0].code, "CUT_FOOTAGE_PUBLISH");
    assert.match(report.diagnostics[0].message, /cancelled/u);
    await assert.rejects(lstat(join(root, output)), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    await assert.rejects(lstat(join(root, `${output}.cut-footage.json`)), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    const entries = await readdir(join(root, "selects"));
    assert.equal(entries.some((entry) => entry.includes("cut-footage-staging")), false);
  }
});
