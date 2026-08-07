import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditDistCliOrphans } from "./audit-dist-cli-orphans.mjs";

test("the current compiled CLI has no source or sidecar orphans", () => {
  const result = auditDistCliOrphans();
  assert.deepEqual(result.missingSources, []);
  assert.deepEqual(result.detachedSidecars, []);
  assert.equal(result.status, "PASS");
  assert.ok(result.compiledJavaScriptFiles > 0);
});

test("the orphan audit fails closed for a deleted source and detached sidecar", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cut-dist-cli-orphan-test-"),
  );
  try {
    await mkdir(path.join(root, "lib"), { recursive: true });
    await mkdir(path.join(root, "dist-cli", "lib"), { recursive: true });
    await writeFile(path.join(root, "lib", "current.ts"), "");
    await writeFile(path.join(root, "dist-cli", "lib", "current.js"), "");
    await writeFile(path.join(root, "dist-cli", "lib", "orphan.js"), "");
    await writeFile(
      path.join(root, "dist-cli", "lib", "detached.js.map"),
      "",
    );

    const result = auditDistCliOrphans(root);
    assert.equal(result.status, "FAIL");
    assert.deepEqual(
      result.missingSources.map((entry) => entry.compiled),
      ["dist-cli/lib/orphan.js"],
    );
    assert.deepEqual(
      result.detachedSidecars.map((entry) => entry.sidecar),
      ["dist-cli/lib/detached.js.map"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
