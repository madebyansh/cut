import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireCoreTestLock,
  coreTestInvocationIdentity,
  enumerateDistCoreTests,
  runDistCoreTests,
} from "./run-dist-core-tests.mjs";

const roots = new Set();
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixtureRoot(files = {
  "only.test.js": "const test = require('node:test'); test('pass', () => {});\n",
}) {
  const root = await mkdtemp(join(tmpdir(), "cut-dist-core-runner-"));
  roots.add(root);
  const tests = join(root, "dist-cli", "tests");
  await mkdir(tests, { recursive: true });
  for (const [name, source] of Object.entries(files)) await writeFile(join(tests, name), source);
  return root;
}

async function writeFixtureFile(root, locator, bytes = `${locator}\n`) {
  const path = join(root, ...locator.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function runnerOptions(root, extra = {}) {
  return { repositoryRoot: root, evidenceLocators: [], stdio: "ignore", output() {}, ...extra };
}

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  assert.fail(`timed out waiting for ${path}`);
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

test.after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("the canonical package command acquires the runner lock before its build", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.scripts["test:core"], "node scripts/run-dist-core-tests.mjs --build");
});

test("enumeration and invocation evidence bind sorted per-test bytes and exact argv", async () => {
  const root = await fixtureRoot({
    "z.test.js": "const test = require('node:test'); test('z', () => {});\n",
    "ignored.js": "throw new Error('must not execute');\n",
    "a.test.js": "const test = require('node:test'); test('a', () => {});\n",
  });
  const canonicalRoot = await realpath(root);
  const files = await enumerateDistCoreTests(root);
  assert.deepEqual(files, ["dist-cli/tests/a.test.js", "dist-cli/tests/z.test.js"]);
  const identity = await coreTestInvocationIdentity({
    repositoryRoot: canonicalRoot,
    files,
    evidenceLocators: [],
  });
  assert.equal(identity.testFileCount, 2);
  assert.deepEqual(identity.testFiles.map(({ path }) => path), files);
  for (const binding of identity.testFiles) {
    assert.ok(Number.isSafeInteger(binding.size) && binding.size > 0);
    assert.match(binding.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.match(identity.node.requestedPathStringSha256, /^[0-9a-f]{64}$/u);
  assert.match(identity.node.canonicalPathStringSha256, /^[0-9a-f]{64}$/u);
  assert.equal("executablePathSha256" in identity.node, false);
  assert.match(identity.testFileListSha256, /^[0-9a-f]{64}$/u);
  assert.match(identity.childArgumentsSha256, /^[0-9a-f]{64}$/u);
  assert.match(identity.aggregateManifestSha256, /^[0-9a-f]{64}$/u);
});

test("default invocation evidence binds the exact runtime and closure file set", async () => {
  const root = await fixtureRoot();
  const expected = [
    "dist-cli/cli/cut.js",
    "dist-cli/lib/language/builtin-implementation-closure.json",
    "dist-cli/lib/language/builtin-implementation-roots.json",
    "lib/language/builtin-implementation-closure.json",
    "lib/language/builtin-implementation-roots.json",
    "package.json",
    "scripts/audit-dist-cli-orphans.mjs",
    "scripts/run-dist-core-tests.mjs",
  ];
  for (const locator of expected) await writeFixtureFile(root, locator);
  const canonicalRoot = await realpath(root);
  const files = await enumerateDistCoreTests(root);
  const identity = await coreTestInvocationIdentity({ repositoryRoot: canonicalRoot, files });
  assert.deepEqual(identity.boundRuntimeFiles.map(({ path }) => path), expected);
  for (const binding of identity.boundRuntimeFiles) {
    assert.ok(Number.isSafeInteger(binding.size) && binding.size > 0);
    assert.match(binding.sha256, /^[0-9a-f]{64}$/u);
  }
});

test("a second concurrent invocation refuses before the second build or tests spawn", async () => {
  const root = await fixtureRoot({
    "hold.test.js": "const test = require('node:test'); test('hold', async () => { await new Promise((r) => setTimeout(r, 300)); });\n",
  });
  const ownerPath = join(root, ".cut", "locks", "dist-core-tests.lock", "owner.json");
  let firstSpawnCount = 0;
  const first = runDistCoreTests(runnerOptions(root, {
    build: true,
    npmExecutablePath: process.execPath,
    spawnProcess(command, args, options) {
      firstSpawnCount += 1;
      if (firstSpawnCount === 1) {
        const buildChild = new EventEmitter();
        buildChild.kill = () => true;
        setTimeout(() => buildChild.emit("close", 0, null), 300);
        return buildChild;
      }
      return spawn(command, args, options);
    },
  }));
  await waitForFile(ownerPath);
  let secondSpawnCount = 0;
  await assert.rejects(
    runDistCoreTests(runnerOptions(root, {
      build: true,
      npmExecutablePath: process.execPath,
      spawnProcess() { secondSpawnCount += 1; throw new Error("must not spawn"); },
    })),
    (error) => error?.code === "CUT_CORE_TEST_LOCK_HELD",
  );
  assert.equal(secondSpawnCount, 0);
  assert.equal((await first).exitCode, 0);
  assert.equal(firstSpawnCount, 2);
  await assertMissing(join(root, ".cut", "locks", "dist-core-tests.lock"));
});

test("a symlinked lock directory fails closed without deleting the external owner", async () => {
  const root = await fixtureRoot();
  const external = await fixtureRoot();
  const externalLock = join(external, "external-lock");
  await mkdir(externalLock);
  const externalOwner = join(externalLock, "owner.json");
  await writeFile(externalOwner, "external-owner-survives\n");
  await mkdir(join(root, ".cut", "locks"), { recursive: true });
  await symlink(externalLock, join(root, ".cut", "locks", "dist-core-tests.lock"));
  let spawnCount = 0;
  await assert.rejects(
    runDistCoreTests(runnerOptions(root, { spawnProcess() { spawnCount += 1; throw new Error("must not spawn"); } })),
    (error) => error?.code === "CUT_CORE_TEST_LOCK_UNSAFE",
  );
  assert.equal(spawnCount, 0);
  assert.equal(await readFile(externalOwner, "utf8"), "external-owner-survives\n");
});

test("a symlinked owner fails closed without deleting its target", async () => {
  const root = await fixtureRoot();
  const external = await fixtureRoot();
  const target = join(external, "external-owner.json");
  await writeFile(target, "owner-target-survives\n");
  const lockPath = join(root, ".cut", "locks", "dist-core-tests.lock");
  await mkdir(lockPath, { recursive: true });
  await symlink(target, join(lockPath, "owner.json"));
  await assert.rejects(
    runDistCoreTests(runnerOptions(root)),
    (error) => ["CUT_CORE_TEST_FILE", "CUT_CORE_TEST_LOCK_UNSAFE"].includes(error?.code),
  );
  assert.equal(await readFile(target, "utf8"), "owner-target-survives\n");
});

test("a symlinked repository lock parent fails closed without touching its target", async () => {
  const root = await fixtureRoot();
  const external = await fixtureRoot();
  const externalLocks = join(external, "external-locks");
  await mkdir(externalLocks);
  const marker = join(externalLocks, "marker");
  await writeFile(marker, "parent-target-survives\n");
  await mkdir(join(root, ".cut"));
  await symlink(externalLocks, join(root, ".cut", "locks"));
  await assert.rejects(
    runDistCoreTests(runnerOptions(root)),
    (error) => error?.code === "CUT_CORE_TEST_LOCK_UNSAFE",
  );
  assert.equal(await readFile(marker, "utf8"), "parent-target-survives\n");
});

test("an extra lock entry is rejected and preserved", async () => {
  const root = await fixtureRoot();
  const lock = await acquireCoreTestLock({ repositoryRoot: root });
  const extraPath = join(lock.lockPath, "foreign-entry");
  await writeFile(extraPath, "preserve-me\n");
  await assert.rejects(
    runDistCoreTests(runnerOptions(root)),
    (error) => error?.code === "CUT_CORE_TEST_LOCK_MALFORMED",
  );
  assert.equal(await readFile(extraPath, "utf8"), "preserve-me\n");
});

test("owner mutation refuses release and preserves the changed bytes", async () => {
  const root = await fixtureRoot();
  const lock = await acquireCoreTestLock({ repositoryRoot: root });
  const ownerPath = join(lock.lockPath, "owner.json");
  const changed = { ...lock.owner, runId: "11111111-1111-4111-8111-111111111111" };
  const changedBytes = `${JSON.stringify(changed)}\n`;
  await writeFile(ownerPath, changedBytes);
  await assert.rejects(lock.release(), (error) => error?.code === "CUT_CORE_TEST_LOCK_OWNERSHIP_CHANGED");
  assert.equal(await readFile(ownerPath, "utf8"), changedBytes);
});

test("a dead-owner lock is preserved for manual recovery and never auto-reclaimed", async () => {
  const root = await fixtureRoot();
  const stale = await acquireCoreTestLock({ repositoryRoot: root, pid: 9_999_991 });
  const ownerPath = join(stale.lockPath, "owner.json");
  const before = await readFile(ownerPath);
  let spawnCount = 0;
  await assert.rejects(
    runDistCoreTests(runnerOptions(root, {
      lockOptions: { processAlive: () => false },
      spawnProcess() { spawnCount += 1; throw new Error("must not spawn"); },
    })),
    (error) => error?.code === "CUT_CORE_TEST_LOCK_STALE_MANUAL_RECOVERY",
  );
  assert.equal(spawnCount, 0);
  assert.deepEqual(await readFile(ownerPath), before);
});

test("malformed lock bytes and shape are preserved", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".cut", "locks", "dist-core-tests.lock");
  await mkdir(lockPath, { recursive: true });
  const ownerPath = join(lockPath, "owner.json");
  await writeFile(ownerPath, "{not-json\n");
  await assert.rejects(runDistCoreTests(runnerOptions(root)), (error) => error?.code === "CUT_CORE_TEST_LOCK_MALFORMED");
  assert.equal(await readFile(ownerPath, "utf8"), "{not-json\n");
});

test("non-directory lock parents and lock paths fail closed", async () => {
  const cutFileRoot = await fixtureRoot();
  await writeFile(join(cutFileRoot, ".cut"), "not-a-directory\n");
  await assert.rejects(
    runDistCoreTests(runnerOptions(cutFileRoot)),
    (error) => error?.code === "CUT_CORE_TEST_LOCK_UNSAFE",
  );

  const lockFileRoot = await fixtureRoot();
  await mkdir(join(lockFileRoot, ".cut", "locks"), { recursive: true });
  const lockFile = join(lockFileRoot, ".cut", "locks", "dist-core-tests.lock");
  await writeFile(lockFile, "not-a-directory\n");
  await assert.rejects(
    runDistCoreTests(runnerOptions(lockFileRoot)),
    (error) => error?.code === "CUT_CORE_TEST_LOCK_UNSAFE",
  );
  assert.equal(await readFile(lockFile, "utf8"), "not-a-directory\n");
});

test("an empty compiled test list refuses and releases its exact owned lock", async () => {
  const root = await fixtureRoot({});
  await assert.rejects(runDistCoreTests(runnerOptions(root)), (error) => error?.code === "CUT_CORE_TEST_LIST_EMPTY");
  await assertMissing(join(root, ".cut", "locks", "dist-core-tests.lock"));
});

test("child failure is propagated and the exact owned lock is released", async () => {
  const root = await fixtureRoot({
    "fail.test.js": "const test = require('node:test'); const assert = require('node:assert/strict'); test('fail', () => assert.fail('expected'));\n",
  });
  const evidence = [];
  const result = await runDistCoreTests(runnerOptions(root, { output(line) { evidence.push(JSON.parse(line)); } }));
  assert.equal(result.code, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].runIdentity.pid, process.pid);
  assert.match(evidence[0].runIdentity.runId, /^[0-9a-f-]{16,64}$/u);
  await assertMissing(join(root, ".cut", "locks", "dist-core-tests.lock"));
});

test("synchronous child spawn throw propagates and releases only the exact owned lock", async () => {
  const root = await fixtureRoot();
  await assert.rejects(
    runDistCoreTests(runnerOptions(root, {
      spawnProcess() {
        const error = new Error("synchronous spawn failure");
        error.code = "ENOENT";
        throw error;
      },
    })),
    (error) => error?.code === "CUT_CORE_TEST_CHILD_SPAWN" && error?.details?.code === "ENOENT",
  );
  await assertMissing(join(root, ".cut", "locks", "dist-core-tests.lock"));
});

test("emitted child spawn error propagates and releases the exact owned lock", async () => {
  const root = await fixtureRoot();
  const child = new EventEmitter();
  child.kill = () => true;
  await assert.rejects(
    runDistCoreTests(runnerOptions(root, {
      spawnProcess() {
        queueMicrotask(() => {
          const error = new Error("spawn failed");
          error.code = "ENOENT";
          child.emit("error", error);
        });
        return child;
      },
    })),
    (error) => error?.code === "CUT_CORE_TEST_CHILD_SPAWN" && error?.details?.code === "ENOENT",
  );
  await assertMissing(join(root, ".cut", "locks", "dist-core-tests.lock"));
});

test("build failure is propagated without spawning the test corpus", async () => {
  const root = await fixtureRoot();
  let spawnCount = 0;
  const result = await runDistCoreTests(runnerOptions(root, {
    build: true,
    npmExecutablePath: process.execPath,
    spawnProcess() {
      spawnCount += 1;
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 2, null));
      return child;
    },
  }));
  assert.equal(spawnCount, 1);
  assert.equal(result.stage, "build");
  assert.equal(result.exitCode, 2);
  await assertMissing(join(root, ".cut", "locks", "dist-core-tests.lock"));
});

test("SIGINT is forwarded as 130 and cleanup completes before return", async () => {
  const root = await fixtureRoot();
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  let deliveredSignal = null;
  child.kill = (signal) => {
    deliveredSignal = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  let spawned = false;
  const running = runDistCoreTests(runnerOptions(root, {
    signalSource,
    spawnProcess() { spawned = true; return child; },
  }));
  while (!spawned) await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  signalSource.emit("SIGINT");
  const result = await running;
  assert.equal(deliveredSignal, "SIGINT");
  assert.equal(result.requestedSignal, "SIGINT");
  assert.equal(result.exitCode, 130);
  await assertMissing(join(root, ".cut", "locks", "dist-core-tests.lock"));
});

test("input drift after spawn rejects the run and releases the lock", async () => {
  const root = await fixtureRoot();
  const child = new EventEmitter();
  child.kill = () => true;
  await assert.rejects(
    runDistCoreTests(runnerOptions(root, {
      spawnProcess() {
        queueMicrotask(async () => {
          await writeFile(join(root, "dist-cli", "tests", "only.test.js"), "changed after manifest\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    })),
    (error) => error?.code === "CUT_CORE_TEST_INPUT_DRIFT",
  );
  await assertMissing(join(root, ".cut", "locks", "dist-core-tests.lock"));
});
