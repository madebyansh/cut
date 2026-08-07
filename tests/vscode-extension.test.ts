import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatCutSource } from "../lib/language/formatter";

const requireForTest = createRequire(__filename);
const bridge = requireForTest(resolve("editors/vscode/lib/cut-cli.js")) as {
  runCutCheck(executable: string, source: string, options: { cwd: string; prefixArgs: string[] }): Promise<{
    format: string;
    status: "pass" | "fail";
    diagnostics: Array<{ code: string; span: { start: { line: number; column: number }; end: { line: number; column: number } }; source?: { path?: string; module?: string; line?: number; column?: number; current?: boolean } }>;
  }>;
  runCutFormat(executable: string, source: string, options: { cwd: string; prefixArgs: string[] }): Promise<string>;
  runProcess(executable: string, args: string[], options?: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal }): Promise<unknown>;
  parseDiagnosticReport(source: string): unknown;
};

const editor = resolve("editors/vscode");
const cli = resolve("dist-cli/cli/cut.js");

function run(executable: string, args: string[], cwd: string, env = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => accept({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

test("VS Code bridge delegates formatting and diagnostics to the real built CUT CLI", async () => {
  const ugly = 'cut 0.4;project "Editor Proof";import{Rect}from"cut:visual";timeline main(duration:1s,fps:24){scene one(duration:1s){Rect(width:1920px,height:1080px,fill:#071019);}}export release=render(main);';
  const options = { cwd: process.cwd(), prefixArgs: [cli] };
  const formatted = await bridge.runCutFormat(process.execPath, ugly, options);
  assert.match(formatted, /timeline main\(duration: 1s, fps: 24\) \{/);
  assert.match(formatted, /export release = render\(main\);/);

  const passing = await bridge.runCutCheck(process.execPath, formatted, options);
  assert.deepEqual({ format: passing.format, status: passing.status, diagnostics: passing.diagnostics }, {
    format: "cut-diagnostics",
    status: "pass",
    diagnostics: [],
  });

  const invalid = "cut 0.4; project 42;";
  const failing = await bridge.runCutCheck(process.execPath, invalid, options);
  assert.equal(failing.status, "fail");
  assert.equal(failing.diagnostics[0]?.code, "CUT1002");
  assert.deepEqual(failing.diagnostics[0]?.span.start, { offset: 17, line: 1, column: 18 });
  assert.ok(failing.diagnostics[0]!.span.end.column > failing.diagnostics[0]!.span.start.column);
  assert.equal(failing.diagnostics[0]?.source?.current, true);

  const loweringInvalid = `cut 0.4;
project "Editor transition diagnostic";
import { Clip, Transition } from "@cut/edit";
asset outgoing: VideoAsset = video("outgoing.mkv");
asset incoming: VideoAsset = video("incoming.mkv");
timeline main(duration: 1500ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1500ms) {
    Transition(kind: "cross-dissolve", duration: 250ms) {
      at 0s { Clip(source: outgoing, range: 0s ..< 1s, duration: 1s); }
      at 500ms { Clip(source: incoming, range: 0s ..< 1s, duration: 1s); }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const loweringFailure = await bridge.runCutCheck(process.execPath, loweringInvalid, options);
  assert.equal(loweringFailure.status, "fail");
  const loweringDiagnostic = loweringFailure.diagnostics.find((item) => item.code === "CUT2084");
  assert.ok(loweringDiagnostic);
  assert.deepEqual(loweringDiagnostic.span.start, { offset: 324, line: 8, column: 5 });

  const external = bridge.parseDiagnosticReport(JSON.stringify({
    format: "cut-diagnostics",
    version: 1,
    command: "check",
    program: "main.cut",
    status: "fail",
    diagnostics: [{
      severity: "error",
      code: "CUT2029",
      message: "package component is ill-typed",
      span: { start: { offset: 10, line: 2, column: 3 }, end: { offset: 14, line: 2, column: 7 } },
      source: { path: "@proof/cards/index.cut", line: 2, column: 3 },
    }],
  })) as { diagnostics: Array<{ source?: { path: string; line: number; column: number } }> };
  assert.deepEqual(external.diagnostics[0]?.source, { path: "@proof/cards/index.cut", line: 2, column: 3 });

  const snippets = JSON.parse(await readFile(resolve(editor, "snippets/cut.code-snippets"), "utf8")) as Record<string, { body: string[] }>;
  const starter = snippets["CUT project"]!.body.join("\n")
    .replace(/\$\{\d+\|([^|}]*)\|\}/g, (_match, choices: string) => choices.split(",")[0]!)
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$0/g, "");
  const starterCheck = await bridge.runCutCheck(process.execPath, starter, options);
  assert.deepEqual(starterCheck.diagnostics, [], "the default generic project snippet must pass the public checker");
});

test("VS Code sends unsaved bytes through stdin while retaining the real package entry identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-vscode-package-"));
  const project = join(workspace, "package-proof");
  try {
    await cp(resolve("examples/package-proof"), project, { recursive: true });
    await cp(resolve("examples/packages"), join(workspace, "packages"), { recursive: true });
    const sourcePath = join(project, "main.cut");
    const source = await readFile(sourcePath, "utf8");
    const options = { cwd: project, prefixArgs: [cli], sourcePath };

    const checked = await bridge.runCutCheck(process.execPath, `${source}\n// unsaved editor buffer\n`, options);
    assert.equal(checked.status, "pass");
    assert.deepEqual(checked.diagnostics, []);

    const formatted = await bridge.runCutFormat(process.execPath, source.replace("project ", "project    "), options);
    assert.equal(formatted, formatCutSource(source));

    await rm(join(project, "cut.package.lock"));
    const missingLock = await bridge.runCutCheck(process.execPath, source, options);
    assert.equal(missingLock.format, "cut-cli-diagnostics");
    assert.equal(missingLock.status, "fail");
    assert.equal(missingLock.diagnostics[0]?.code, "CUT_PACKAGE_LOCK_MISSING");
    assert.deepEqual(missingLock.diagnostics[0]?.span.start, { offset: 0, line: 1, column: 1 });
    assert.deepEqual(missingLock.diagnostics[0]?.source, { path: "cut.package.lock", current: false });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("VS Code package metadata, grammar, snippets, and security invariants validate offline", async () => {
  const result = await run(process.execPath, [resolve(editor, "scripts/validate-extension.mjs")], editor);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /manifest, grammar, snippets, CLI bridge, and package whitelist validated/);

  const manifest = JSON.parse(await readFile(resolve(editor, "package.json"), "utf8")) as {
    version: string;
    capabilities: { untrustedWorkspaces: { supported: boolean }; virtualWorkspaces: boolean };
    contributes: { languages: Array<{ extensions: string[] }>; commands: Array<{ command: string }> };
  };
  assert.match(manifest.version, /^0\./);
  assert.deepEqual(manifest.contributes.languages[0]?.extensions, [".cut"]);
  assert.ok(manifest.contributes.commands.some((item) => item.command === "cut.checkDocument"));
  assert.deepEqual(manifest.capabilities, { untrustedWorkspaces: { supported: false, description: "CUT support invokes the locally installed cut executable to format and check source." }, virtualWorkspaces: false });
});

test("VS Code CLI bridge fails closed on cancellation, timeout, output overflow, and malformed reports", async () => {
  const controller = new AbortController();
  const cancelled = bridge.runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === "AbortError" && "code" in error && error.code === "CUT_EDITOR_ABORTED");

  await assert.rejects(
    bridge.runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 1_000 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CUT_EDITOR_CLI_TIMEOUT",
  );
  await assert.rejects(
    bridge.runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxOutputBytes: 1_024 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CUT_EDITOR_CLI_OUTPUT",
  );
  assert.throws(
    () => bridge.parseDiagnosticReport('{"format":"cut-diagnostics","version":1,"command":"check","status":"pass","diagnostics":[{"severity":"error"}]}'),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CUT_EDITOR_DIAGNOSTIC_JSON",
  );
  const runtime = bridge.parseDiagnosticReport(JSON.stringify({
    format: "cut-cli-diagnostics",
    version: 1,
    command: "check",
    status: "fail",
    diagnostics: [{ severity: "error", code: "CUT_PACKAGE_LOCK_MISSING", message: "lock missing", source: { path: "cut.package.lock" } }],
  })) as { diagnostics: Array<{ code: string; span: { start: { offset: number; line: number; column: number } }; source?: { path?: string } }> };
  assert.deepEqual(runtime.diagnostics[0], {
    severity: "error",
    code: "CUT_PACKAGE_LOCK_MISSING",
    message: "lock missing",
    hint: undefined,
    span: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } },
    source: { path: "cut.package.lock" },
  });
});

test("VS Code npm dry-run pack contains only the intentional extension payload", async () => {
  const cache = await mkdtemp(join(tmpdir(), "cut-vscode-npm-cache-"));
  try {
    const result = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], editor, { ...process.env, npm_config_cache: cache });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    assert.equal(report.length, 1);
    const paths = report[0]!.files.map((item) => item.path).sort();
    for (const required of ["CHANGELOG.md", "LICENSE", "README.md", "extension.js", "language-configuration.json", "lib/cut-cli.js", "package.json", "snippets/cut.code-snippets", "syntaxes/cut.tmLanguage.json"]) {
      assert.ok(paths.includes(required), `packed extension is missing ${required}: ${JSON.stringify(paths)}`);
    }
    assert.ok(paths.every((path) => !path.startsWith("scripts/") && !path.includes("node_modules") && !path.endsWith(".vsix")));
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
