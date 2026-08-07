import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  BuiltinImplementationDataError,
  builtinImplementationDataFiles,
  syncBuiltinImplementationData,
} from "./sync-builtin-implementation-data.mjs";

function failure(code) {
  return (error) => error instanceof BuiltinImplementationDataError && error.code === code;
}

test("runtime implementation data copy is exact and check mode detects missing or stale output", async () => {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), "cut-implementation-data-"));
  const sourceRoot = resolve(workspaceRoot, "lib/language"), destinationRoot = resolve(workspaceRoot, "dist-cli/lib/language");
  await mkdir(sourceRoot, { recursive: true });
  for (const [index, name] of builtinImplementationDataFiles.entries()) await writeFile(resolve(sourceRoot, name), `{"fixture":${index}}\n`);
  try {
    assert.throws(() => syncBuiltinImplementationData({ workspaceRoot, sourceRoot, destinationRoot, mode: "check" }), failure("CUT_IMPLEMENTATION_DATA_MISSING"));
    assert.deepEqual(syncBuiltinImplementationData({ workspaceRoot, sourceRoot, destinationRoot, mode: "write" }), { files: [...builtinImplementationDataFiles], mode: "write" });
    assert.doesNotThrow(() => syncBuiltinImplementationData({ workspaceRoot, sourceRoot, destinationRoot, mode: "check" }));
    for (const name of builtinImplementationDataFiles) assert.deepEqual(await readFile(resolve(destinationRoot, name)), await readFile(resolve(sourceRoot, name)));
    await writeFile(resolve(destinationRoot, builtinImplementationDataFiles[0]), "stale\n");
    assert.throws(() => syncBuiltinImplementationData({ workspaceRoot, sourceRoot, destinationRoot, mode: "check" }), failure("CUT_IMPLEMENTATION_DATA_STALE"));
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});
