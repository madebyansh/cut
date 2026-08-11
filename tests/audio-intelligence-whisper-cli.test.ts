import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve("dist-cli/cli/cut.js");

function run(root: string, args: readonly string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: 30_000,
  });
}

test("audio doctor rejects duplicate setup keys before executing a provider", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-whisper-cli-"));
  try {
    await writeFile(resolve(root, "setup.json"), '{"format":"cut-whisper-local-setup","format":"forged"}\n');
    const result = run(root, ["audio", "doctor", "--setup", "setup.json", "--json"]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.format, "cut-cli-diagnostics");
    assert.equal(report.command, "audio doctor");
    assert.ok(report.diagnostics.some((item: { code: string }) => item.code === "CUT_PACKAGE_JSON_DUPLICATE_KEY"), result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio setup rejects duplicate recipe keys before authenticating executables", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-whisper-setup-cli-"));
  try {
    await writeFile(resolve(root, "recipe.json"), '{"ffmpeg":{},"ffmpeg":{"path":"/forged"}}\n');
    const result = run(root, ["audio", "setup", "recipe.json", "--out", "whisper.setup.json", "--json"]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "audio setup");
    assert.ok(report.diagnostics.some((item: { code: string }) => item.code === "CUT_PACKAGE_JSON_DUPLICATE_KEY"), result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio transcribe validates closed numeric options before setup or media I/O", () => {
  for (const invalid of [
    ["--threads", "0", "CUTC1007"],
    ["--threads", "65", "CUTC1007"],
    ["--threads", "1.5", "CUTC1007"],
    ["--stream", "01", "CUTC1007"],
    ["--stream", "-1", "CUTC1003"],
  ]) {
    const result = run(process.cwd(), [
      "audio", "transcribe", "missing.wav",
      "--setup", "missing-setup.json",
      "--out", "missing-transcript.json",
      "--receipt", "missing-receipt.json",
      invalid[0]!, invalid[1]!,
      "--json",
    ]);
    assert.equal(result.status, 1, `${invalid.join("=")}: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "audio transcribe");
    assert.equal(report.diagnostics[0]?.code, invalid[2], result.stdout);
  }
});

test("audio CLI command and option sets remain closed", () => {
  const unknownCommand = run(process.cwd(), ["audio", "invent", "--json"]);
  assert.equal(unknownCommand.status, 1);
  assert.equal(JSON.parse(unknownCommand.stdout).diagnostics[0]?.code, "CUTC1007");

  const unknownOption = run(process.cwd(), ["audio", "doctor", "--setup", "missing.json", "--remote", "--json"]);
  assert.equal(unknownOption.status, 1);
  assert.equal(JSON.parse(unknownOption.stdout).diagnostics[0]?.code, "CUTC1001");

  const setupUnknownOption = run(process.cwd(), ["audio", "setup", "recipe.json", "--out", "setup.json", "--download", "--json"]);
  assert.equal(setupUnknownOption.status, 1);
  assert.equal(JSON.parse(setupUnknownOption.stdout).diagnostics[0]?.code, "CUTC1001");
});
