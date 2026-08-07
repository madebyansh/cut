import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { cutProductVersion } from "../lib/version";

const cli = resolve("dist-cli", "cli", "cut.js");

function help(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

test("machine CLI reference is deterministic, closed, and separates formal from legacy commands", () => {
  const first = help("help", "--json"), second = help("--help", "--json");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.format, "cut-cli-reference");
  assert.equal(report.version, 1);
  assert.equal(report.status, "pass");
  assert.equal(report.product.version, cutProductVersion);
  assert.equal(report.summary.commands, report.commands.length);
  assert.ok(report.summary.formal > 10);
  assert.ok(report.summary.package >= 7);
  assert.ok(report.summary.legacy >= 10);
  assert.deepEqual(report.aliases["av-build"], "build");

  const render = report.commands.find((command: { command: string }) => command.command === "render");
  assert.equal(render.category, "formal");
  assert.equal(render.positionals, 1);
  assert.deepEqual(render.options.map((option: { name: string }) => option.name), ["--json", "--lock", "--out", "--output", "--stems"]);
  assert.deepEqual(render.options.filter((option: { required: boolean }) => option.required).map((option: { name: string }) => option.name), ["--lock", "--out"]);
  const legacyRender = report.commands.find((command: { command: string }) => command.command === "legacy render");
  assert.equal(legacyRender.category, "legacy");
  assert.equal(legacyRender.stability, "legacy");

  const documentation = readFileSync(resolve("docs", "CLI.md"), "utf8");
  for (const command of report.commands.filter((entry: { category: string }) => entry.category !== "legacy")) {
    const spellings = command.command === "version" ? ["cut version", "cut --version"] : [`cut ${command.command}`];
    assert.ok(spellings.some((spelling) => documentation.includes(spelling)), `docs/CLI.md omits ${command.command}`);
  }
});

test("machine CLI reference keeps the help option contract closed", () => {
  const result = help("help", "--json", "--unknown");
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.format, "cut-cli-diagnostics");
  assert.equal(report.diagnostics[0].code, "CUTC1001");
  assert.equal(report.command, "help");
});

test("machine CLI reference required options are enforced before filesystem work", () => {
  const result = help("render", "does-not-exist.cut", "--json");
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.format, "cut-cli-diagnostics");
  assert.equal(report.command, "render");
  assert.equal(report.diagnostics[0].code, "CUTC1006");
  assert.match(report.diagnostics[0].message, /--lock and --out/);
});
