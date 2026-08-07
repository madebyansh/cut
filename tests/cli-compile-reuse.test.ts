import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  compileCutModule,
  CutCompileLimitError,
} from "../lib/language/compiler";
import { loadCutLock, applyCutLock, type CutLockfile } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { analyzeCutLanguageProgramSource } from "../lib/language/program-analysis";

const cli = resolve("dist-cli/cli/cut.js");

const validSource = `cut 0.4;
project "Compile reuse";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #315c8c);
  }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");
`;

async function run(args: string[], cwd: string, expectedCode = 0) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cut ${args.join(" ")} timed out`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === expectedCode) accept(result);
      else reject(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
  });
}

test("language analysis compiles exactly once and retains that exact canonical result", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-compile-reuse-unit-"));
  try {
    const path = resolve(root, "main.cut");
    await writeFile(path, validSource);
    let compileInvocations = 0, staticValidationInvocations = 0;
    let compiledByObservedInvocation: ReturnType<typeof compileCutModule> | undefined;
    const analysis = await analyzeCutLanguageProgramSource(path, validSource, undefined, {
      compile: (module, limits, packages, userModules, inputs) => {
        compileInvocations += 1;
        compiledByObservedInvocation = compileCutModule(module, limits, packages, userModules, inputs);
        return compiledByObservedInvocation;
      },
      validateStaticVisualGraphs: (ir) => {
        staticValidationInvocations += 1;
        assert.strictEqual(ir, compiledByObservedInvocation?.ir, "static validation must inspect the retained compiler result");
        return [];
      },
    });
    assert.equal(compileInvocations, 1);
    assert.equal(staticValidationInvocations, 1);
    assert.strictEqual(analysis.compiled, compiledByObservedInvocation, "analysis must return, not reconstruct, the compiler result");
    assert.deepEqual(analysis.diagnostics, []);

    const parsed = parseCutLanguage(validSource);
    assert.ok(parsed.module);
    const independentlyCompiled = compileCutModule(parsed.module);
    assert.deepEqual(analysis.compiled?.ir, independentlyCompiled.ir, "compile reuse must not change canonical IR or identity");
    assert.deepEqual(analysis.compiled?.check.diagnostics, independentlyCompiled.check.diagnostics);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid source preserves source-located diagnostics without reaching lowering", async () => {
  const invalid = `cut 0.4;
project "Invalid compile reuse";
timeline main(duration: 1s, fps: 24) { scene only(duration: 1s) { Missing(); } }
export out = render(main);
`;
  let compileInvocations = 0;
  const analysis = await analyzeCutLanguageProgramSource("invalid.cut", invalid, undefined, {
    compile: (...arguments_) => {
      compileInvocations += 1;
      return compileCutModule(...arguments_);
    },
  });
  assert.equal(compileInvocations, 0);
  assert.equal(analysis.compiled, undefined);
  assert.deepEqual(
    analysis.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      line: diagnostic.span.start.line,
      column: diagnostic.span.start.column,
    })),
    [
      { code: "CUT2010", line: 3, column: 67 },
      { code: "CUT2024", line: 3, column: 67 },
      { code: "CUT2032", line: 3, column: 67 },
    ],
  );
});

test("hostile compiler limits remain fail-closed and are not converted into diagnostics", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-compile-reuse-limit-"));
  try {
    const path = resolve(root, "main.cut");
    await writeFile(path, validSource);
    const limitFailure = new CutCompileLimitError("maxNodes");
    let compileInvocations = 0;
    await assert.rejects(
      analyzeCutLanguageProgramSource(path, validSource, undefined, {
        compile: () => {
          compileInvocations += 1;
          throw limitFailure;
        },
      }),
      (error: unknown) => error === limitFailure,
    );
    assert.equal(compileInvocations, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI commands consume retained compilation while preserving IR, diagnostics, lock, and verified-input gates", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-compile-reuse-integration-"));
  try {
    const programPath = resolve(root, "main.cut");
    await writeFile(programPath, validSource);

    const cliSource = await readFile(resolve("cli/cut.ts"), "utf8");
    assert.equal(
      (cliSource.match(/\bcompileCutModule\s*\(/gu) ?? []).length,
      0,
      "CLI command dispatch must not perform a second compiler invocation",
    );
    assert.match(cliSource, /const \{ ir \} = program\.compiled;/u);
    assert.match(cliSource, /const program = await languageProgram\(subject\), \{ ir \} = program\.compiled/u);

    const analysis = await analyzeCutLanguageProgramSource(programPath, validSource);
    assert.ok(analysis.compiled);
    const lockReport = JSON.parse((await run([
      "lock", "main.cut", "--out", "cut.lock", "--json",
    ], root)).stdout) as { status: string; sourceHash: string };
    assert.equal(lockReport.status, "pass");
    const lockBytes = await readFile(resolve(root, "cut.lock"));
    const lock = loadCutLock(lockBytes);
    assert.equal(lockReport.sourceHash, analysis.compiled.ir.sourceHash);
    await applyCutLock(analysis.compiled.ir, lock, root);

    const buildReport = JSON.parse((await run([
      "build", "main.cut", "--lock", "cut.lock", "--out", "graph.cutir.json", "--json",
    ], root)).stdout) as { status: string; buildId: string };
    assert.equal(buildReport.status, "pass");
    assert.equal(buildReport.buildId, analysis.compiled.ir.buildId);
    assert.deepEqual(JSON.parse(await readFile(resolve(root, "graph.cutir.json"), "utf8")), analysis.compiled.ir);

    const invalidSource = `cut 0.4;
project "Invalid compile reuse";
timeline main(duration: 1s, fps: 24) { scene only(duration: 1s) { Missing(); } }
export out = render(main);
`;
    await writeFile(resolve(root, "invalid.cut"), invalidSource);
    const invalidAnalysis = await analyzeCutLanguageProgramSource("invalid.cut", invalidSource);
    const invalidReport = JSON.parse((await run([
      "check", "invalid.cut", "--json",
    ], root, 1)).stdout) as {
      status: string;
      diagnostics: Array<{ code: string; source: { path: string; line: number; column: number } }>;
    };
    assert.equal(invalidReport.status, "fail");
    assert.deepEqual(
      invalidReport.diagnostics.map(({ code, source }) => ({ code, source })),
      invalidAnalysis.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        source: {
          path: diagnostic.module ?? invalidAnalysis.diagnosticPath,
          line: diagnostic.span.start.line,
          column: diagnostic.span.start.column,
        },
      })),
    );

    const mismatched = { ...(JSON.parse(lockBytes.toString("utf8")) as CutLockfile), sourceHash: "0".repeat(64) };
    await writeFile(resolve(root, "mismatched.lock"), JSON.stringify(mismatched));
    for (const command of [
      ["build", "main.cut", "--lock", "mismatched.lock", "--out", "must-not-build.cutir.json", "--json"],
      ["frame", "main.cut", "--lock", "mismatched.lock", "--frame", "0", "--out", "must-not-render.png", "--json"],
    ]) {
      const rejected = JSON.parse((await run(command, root, 1)).stdout) as {
        status: string;
        diagnostics: Array<{ code: string }>;
      };
      assert.equal(rejected.status, "fail");
      assert.equal(rejected.diagnostics[0]?.code, "CUT_LOCK_SOURCE_MISMATCH");
    }
    await assert.rejects(readFile(resolve(root, "must-not-build.cutir.json")), /ENOENT/u);
    await assert.rejects(readFile(resolve(root, "must-not-render.png")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
