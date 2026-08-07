import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import {
  RawVideoReader,
  ReferenceMediaProcessError,
  runFfmpeg,
  runFfmpegCapture,
  runFfprobeCapture,
} from "../lib/runtime/reference/ffmpeg";

function pathEnvironmentKey() {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

async function installNodeTool(root: string, name: "ffmpeg" | "ffprobe") {
  const source = await realpath(process.execPath);
  const destination = resolve(root, `${name}${process.platform === "win32" ? ".exe" : ""}`);
  let copied = false;
  try {
    await link(source, destination);
  } catch {
    try { await symlink(source, destination, "file"); }
    catch { await copyFile(source, destination); copied = true; }
  }
  // A hard link or symlink already carries the Node executable's mode. chmod on
  // a hard link would mutate that original inode and is intentionally refused.
  if (copied && process.platform !== "win32") await chmod(destination, 0o755);
}

async function assertProcessExited(pidPath: string) {
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
}

async function waitForPidFile(pidPath: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(pidPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((accept) => setTimeout(accept, 10));
    }
  }
  throw new Error("Timed out waiting for the decoder helper to publish its PID.");
}

async function writeHelper(root: string) {
  const helper = resolve(root, "media-process-helper.mjs");
  await writeFile(helper, [
    'import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";',
    "const [mode, pidPath, heldPath, countText] = process.argv.slice(2);",
    "writeFileSync(pidPath, String(process.pid));",
    'const handle = openSync(heldPath, "w");',
    'writeSync(handle, "started");',
    'if (mode === "exact") {',
    '  process.stdout.write("é".repeat(32));',
    '  process.stderr.write("s".repeat(32));',
    "  closeSync(handle);",
    '} else if (mode === "bytes") {',
    '  process.stdout.write(Buffer.alloc(Number(countText), "p"));',
    "  closeSync(handle);",
    '} else if (mode === "exit") {',
    '  process.stderr.write("secret /" + "Users/example/private-project/input.mov\\n");',
    "  closeSync(handle);",
    "  process.exitCode = 7;",
    '} else if (mode === "overflow") {',
    '  process.stdout.write(Buffer.alloc(Number(countText), "x"));',
    '  setInterval(() => writeSync(handle, "x"), 5);',
    '} else if (mode === "timeout") {',
    '  setInterval(() => writeSync(handle, "x"), 5);',
    "}",
  ].join("\n"));
  return helper;
}

function mediaError(code: ReferenceMediaProcessError["code"], kind: ReferenceMediaProcessError["detail"]["kind"]) {
  return (error: unknown) => error instanceof ReferenceMediaProcessError
    && error.code === code
    && error.detail.kind === kind;
}

test("reference FFmpeg helpers enforce byte and lifecycle boundaries before returning", { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-process-"));
  const pathKey = pathEnvironmentKey();
  const previousPath = process.env[pathKey];
  try {
    await Promise.all([installNodeTool(root, "ffmpeg"), installNodeTool(root, "ffprobe")]);
    const helper = await writeHelper(root);
    process.env[pathKey] = `${root}${delimiter}${previousPath ?? ""}`;

    await context.test("exact multibyte limits preserve complete drained stdout and stderr", async () => {
      const pid = resolve(root, "exact.pid"), held = resolve(root, "exact-held.bin");
      const result = await runFfmpegCapture(
        [helper, "exact", pid, held],
        2_000,
        { stdoutBytes: 64, stderrBytes: 32, totalBytes: 96 },
      );
      assert.equal(result.stdout, "é".repeat(32));
      assert.equal(Buffer.byteLength(result.stdout), 64);
      assert.equal(result.stderr, "s".repeat(32));
      assert.equal(Buffer.byteLength(result.stderr), 32);
      await assertProcessExited(pid);
    });

    await context.test("ffprobe exposes an exact 64 KiB stdout boundary without tail truncation", async () => {
      const exactPid = resolve(root, "probe-exact.pid"), exactHeld = resolve(root, "probe-exact-held.bin");
      const exact = await runFfprobeCapture(
        [helper, "bytes", exactPid, exactHeld, String(64 * 1_024)],
        2_000,
        { stdoutBytes: 64 * 1_024, stderrBytes: 1_024, totalBytes: 65 * 1_024 },
      );
      assert.equal(Buffer.byteLength(exact.stdout), 64 * 1_024);
      await assertProcessExited(exactPid);

      const excessPid = resolve(root, "probe-excess.pid"), excessHeld = resolve(root, "probe-excess-held.bin");
      let captured: unknown;
      try {
        await runFfprobeCapture(
          [helper, "bytes", excessPid, excessHeld, String(64 * 1_024 + 1)],
          2_000,
          { stdoutBytes: 64 * 1_024, stderrBytes: 1_024, totalBytes: 65 * 1_024 },
        );
      } catch (error) { captured = error; }
      assert.ok(captured instanceof ReferenceMediaProcessError);
      assert.equal(captured.code, "CUT_MEDIA_PROCESS_OUTPUT_LIMIT");
      assert.equal(captured.detail.stream, "stdout");
      assert.equal(captured.detail.limitBytes, 64 * 1_024);
      assert.ok((captured.detail.observedBytes ?? 0) > 64 * 1_024);
      await assertProcessExited(excessPid);
    });

    await context.test("timeout waits for the killed process to close", async () => {
      const pid = resolve(root, "timeout.pid"), held = resolve(root, "timeout-held.bin");
      await assert.rejects(
        runFfmpeg([helper, "timeout", pid, held], 500, { stderrBytes: 1_024, totalBytes: 1_024 }),
        mediaError("CUT_MEDIA_PROCESS_TIMEOUT", "timeout"),
      );
      await assertProcessExited(pid);
      await rm(held, { force: true });
    });

    await context.test("raw video reader shutdown is awaitable, idempotent, and closes the decoder", async () => {
      const pid = resolve(root, "raw-reader.pid"), held = resolve(root, "raw-reader-held.bin");
      const reader = new RawVideoReader([helper, "timeout", pid, held], 4);
      await waitForPidFile(pid);
      const first = reader.closeAndWait();
      const second = reader.closeAndWait();
      assert.equal(first, second);
      await first;
      await assertProcessExited(pid);
      await rm(held, { force: true });
    });

    await context.test("output overflow kills and closes an otherwise persistent process", async () => {
      const pid = resolve(root, "overflow.pid"), held = resolve(root, "overflow-held.bin");
      await assert.rejects(
        runFfmpegCapture(
          [helper, "overflow", pid, held, "4096"],
          2_000,
          { stdoutBytes: 64, stderrBytes: 64, totalBytes: 128 },
        ),
        mediaError("CUT_MEDIA_PROCESS_OUTPUT_LIMIT", "output"),
      );
      await assertProcessExited(pid);
      await rm(held, { force: true });
    });

    await context.test("nonzero errors retain typed evidence without leaking stderr paths", async () => {
      const pid = resolve(root, "exit.pid"), held = resolve(root, "exit-held.bin");
      let captured: unknown;
      try { await runFfmpegCapture([helper, "exit", pid, held], 2_000); }
      catch (error) { captured = error; }
      assert.ok(captured instanceof ReferenceMediaProcessError);
      assert.equal(captured.code, "CUT_MEDIA_PROCESS_EXIT");
      assert.equal(captured.detail.exitCode, 7);
      assert.ok((captured.detail.stderrBytes ?? 0) > 0);
      assert.doesNotMatch(JSON.stringify({ message: captured.message, detail: captured.detail }), /Users|private-project|input\.mov/u);
      await assertProcessExited(pid);
    });

    await context.test("invalid limits and timeouts fail before process spawn with stable contracts", async () => {
      const hostile = Object.defineProperty({}, "stdoutBytes", {
        enumerable: true,
        get() { throw new Error("secret /" + "Users/example"); },
      });
      await assert.rejects(
        runFfprobeCapture([], 0),
        mediaError("CUT_MEDIA_PROCESS_CONTRACT", "contract"),
      );
      await assert.rejects(
        runFfprobeCapture([], 1_000, hostile),
        (error: unknown) => mediaError("CUT_MEDIA_PROCESS_CONTRACT", "contract")(error)
          && !JSON.stringify(error).includes("Users"),
      );
    });

    const emptyPath = resolve(root, "empty-path");
    await mkdir(emptyPath);
    process.env[pathKey] = emptyPath;
    await context.test("spawn failure waits for close and returns only a sanitized system code", async () => {
      let captured: unknown;
      try { await runFfmpeg(["-version"], 2_000); }
      catch (error) { captured = error; }
      assert.ok(captured instanceof ReferenceMediaProcessError);
      assert.equal(captured.code, "CUT_MEDIA_PROCESS_START");
      assert.equal(captured.detail.systemCode, "ENOENT");
      assert.doesNotMatch(captured.message, /cut-reference-process|Users/u);
    });
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
