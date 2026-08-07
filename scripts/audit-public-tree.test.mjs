import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

test("public-tree audit ignores tracked files deleted from the working tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cut-public-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(new URL("./audit-public-tree.mjs", import.meta.url), join(root, "audit-public-tree.mjs"));
  await writeFile(join(root, "tracked.txt"), "tracked\n");
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync("git", ["add", "tracked.txt"], { cwd: root, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  await unlink(join(root, "tracked.txt"));
  await writeFile(join(root, "replacement.txt"), "replacement\n");

  const audit = spawnSync(process.execPath, ["audit-public-tree.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(audit.status, 0, audit.stderr);
  const report = JSON.parse(audit.stdout);
  assert.equal(report.status, "pass");
  assert.equal(report.candidate.files, 2);
});
