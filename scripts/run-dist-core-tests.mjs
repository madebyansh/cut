#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runnerPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(runnerPath), "..");
const ownerFileName = "owner.json";
const lockFormat = "cut-dist-core-test-lock";
const lockVersion = 2;
const invocationFormat = "cut-dist-core-test-invocation";
const invocationVersion = 2;
const signalExitCodes = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
const runtimeEvidenceLocators = Object.freeze([
  "package.json",
  "scripts/run-dist-core-tests.mjs",
  "scripts/audit-dist-cli-orphans.mjs",
  "dist-cli/cli/cut.js",
  "lib/language/builtin-implementation-closure.json",
  "dist-cli/lib/language/builtin-implementation-closure.json",
  "lib/language/builtin-implementation-roots.json",
  "dist-cli/lib/language/builtin-implementation-roots.json",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function runnerError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function stateIdentity(state) {
  return Object.freeze({ dev: String(state.dev), ino: String(state.ino) });
}

function sameState(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertContained(root, path, label) {
  const value = relative(root, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw runnerError("CUT_CORE_TEST_PATH", `${label} is outside the canonical repository`);
  }
}

function assertNormalizedLocator(locator, label) {
  if (typeof locator !== "string"
    || locator.length === 0
    || locator.includes("\\")
    || isAbsolute(locator)
    || locator.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw runnerError("CUT_CORE_TEST_PATH", `${label} is not one normalized repository-relative locator`);
  }
}

async function exactRealDirectory(path, label, expected = undefined) {
  let state;
  try {
    state = await lstat(path, { bigint: true });
  } catch (error) {
    throw runnerError("CUT_CORE_TEST_LOCK_UNSAFE", `${label} cannot be inspected without following links`, {
      code: error?.code ?? null,
    });
  }
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw runnerError("CUT_CORE_TEST_LOCK_UNSAFE", `${label} must be one real directory`);
  }
  const identity = stateIdentity(state);
  if (expected !== undefined && !sameState(identity, expected)) {
    throw runnerError("CUT_CORE_TEST_LOCK_OWNERSHIP_CHANGED", `${label} identity changed`);
  }
  return identity;
}

async function ensureLockParent(canonicalRoot) {
  const rootState = await exactRealDirectory(canonicalRoot, "canonical repository root");
  const cutPath = join(canonicalRoot, ".cut");
  const lockParent = join(cutPath, "locks");
  for (const [path, label] of [[cutPath, "repository .cut directory"], [lockParent, "repository lock parent"]]) {
    try {
      await mkdir(path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const canonical = await realpath(path).catch(() => null);
    if (canonical !== path) {
      throw runnerError("CUT_CORE_TEST_LOCK_UNSAFE", `${label} must not contain or be a symbolic link`);
    }
    await exactRealDirectory(path, label);
  }
  await exactRealDirectory(canonicalRoot, "canonical repository root", rootState);
  assertContained(canonicalRoot, lockParent, "repository lock parent");
  return Object.freeze({ lockParent, parentState: await exactRealDirectory(lockParent, "repository lock parent") });
}

async function stableOpenRead(path, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const beforePath = await lstat(path, { bigint: true }).catch((error) => {
    throw runnerError("CUT_CORE_TEST_FILE", `${label} cannot be inspected`, { code: error?.code ?? null });
  });
  if (beforePath.isSymbolicLink() || !beforePath.isFile() || beforePath.size < 0n
    || beforePath.size > BigInt(maximumBytes) || beforePath.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw runnerError("CUT_CORE_TEST_FILE", `${label} must be one bounded regular non-link file`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || !sameState(stateIdentity(before), stateIdentity(beforePath))
      || before.size !== beforePath.size
      || before.mtimeNs !== beforePath.mtimeNs
      || before.ctimeNs !== beforePath.ctimeNs) {
      throw runnerError("CUT_CORE_TEST_FILE_CHANGED", `${label} changed before read`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.byteLength) !== before.size
      || !sameState(stateIdentity(before), stateIdentity(after))
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      throw runnerError("CUT_CORE_TEST_FILE_CHANGED", `${label} changed during read`);
    }
    return Object.freeze({ bytes, state: stateIdentity(before) });
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw runnerError("CUT_CORE_TEST_FILE", `${label} must not be a symbolic link`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function repositoryFileBinding(repositoryRoot, locator, label = locator) {
  assertNormalizedLocator(locator, label);
  const path = resolve(repositoryRoot, locator);
  assertContained(repositoryRoot, path, label);
  const canonical = await realpath(path).catch(() => null);
  if (canonical !== path) {
    throw runnerError("CUT_CORE_TEST_FILE", `${label} must remain inside the repository without symbolic links`);
  }
  const read = await stableOpenRead(path, label);
  const canonicalAfter = await realpath(path).catch(() => null);
  if (canonicalAfter !== path) throw runnerError("CUT_CORE_TEST_FILE_CHANGED", `${label} path changed during read`);
  return Object.freeze({ path: locator, size: read.bytes.byteLength, sha256: sha256(read.bytes) });
}

async function externalExecutableIdentity(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw runnerError("CUT_CORE_TEST_BUILD_AUTHORITY", `${label} must be one absolute executable path`);
  }
  const canonicalPath = await realpath(path).catch(() => null);
  if (canonicalPath === null) throw runnerError("CUT_CORE_TEST_BUILD_AUTHORITY", `${label} cannot be resolved`);
  const state = await lstat(canonicalPath, { bigint: true });
  if (state.isSymbolicLink() || !state.isFile()) {
    throw runnerError("CUT_CORE_TEST_BUILD_AUTHORITY", `${label} must resolve to one regular non-link file`);
  }
  return Object.freeze({
    requestedPathStringSha256: sha256(path),
    canonicalPathStringSha256: sha256(canonicalPath),
  });
}

function ownerRecord({ pid, repositoryRoot, runId, startedAtUtc }) {
  return Object.freeze({
    format: lockFormat,
    version: lockVersion,
    pid,
    runId,
    startedAtUtc,
    repositoryRootSha256: sha256(repositoryRoot),
  });
}

function validateOwner(value, repositoryRoot) {
  if (!exactKeys(value, [
    "format", "version", "pid", "runId", "startedAtUtc", "repositoryRootSha256",
  ])
    || value.format !== lockFormat
    || value.version !== lockVersion
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.runId !== "string"
    || !/^[0-9a-f-]{16,64}$/u.test(value.runId)
    || typeof value.startedAtUtc !== "string"
    || !Number.isFinite(Date.parse(value.startedAtUtc))
    || value.repositoryRootSha256 !== sha256(repositoryRoot)) {
    throw runnerError("CUT_CORE_TEST_LOCK_MALFORMED", "core test lock owner is malformed");
  }
  return value;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function readExactOwner(lockPath, repositoryRoot, expectedLockState = undefined) {
  const lockState = await exactRealDirectory(lockPath, "core test lock", expectedLockState);
  const entries = (await readdir(lockPath)).sort();
  if (entries.length !== 1 || entries[0] !== ownerFileName) {
    throw runnerError("CUT_CORE_TEST_LOCK_MALFORMED", "core test lock does not have its exact closed shape");
  }
  const ownerPath = join(lockPath, ownerFileName);
  const read = await stableOpenRead(ownerPath, "core test lock owner", 4_096);
  let parsed;
  try {
    parsed = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    throw runnerError("CUT_CORE_TEST_LOCK_MALFORMED", "core test lock owner is not valid JSON");
  }
  return Object.freeze({ owner: validateOwner(parsed, repositoryRoot), lockState, ownerState: read.state });
}

async function releaseOwnedLock({ lockPath, repositoryRoot, parentState, lockState, ownerState, expectedOwner }) {
  const lockParent = dirname(lockPath);
  await exactRealDirectory(lockParent, "repository lock parent", parentState);
  const observed = await readExactOwner(lockPath, repositoryRoot, lockState);
  if (!sameState(observed.ownerState, ownerState)
    || JSON.stringify(observed.owner) !== JSON.stringify(expectedOwner)) {
    throw runnerError("CUT_CORE_TEST_LOCK_OWNERSHIP_CHANGED", "core test lock ownership changed before release");
  }
  await exactRealDirectory(lockParent, "repository lock parent", parentState);
  await exactRealDirectory(lockPath, "core test lock", lockState);
  const finalOwner = await stableOpenRead(join(lockPath, ownerFileName), "core test lock owner", 4_096);
  if (!sameState(finalOwner.state, ownerState)
    || finalOwner.bytes.toString("utf8") !== `${JSON.stringify(expectedOwner)}\n`) {
    throw runnerError("CUT_CORE_TEST_LOCK_OWNERSHIP_CHANGED", "core test lock owner changed before release");
  }
  const entries = (await readdir(lockPath)).sort();
  if (entries.length !== 1 || entries[0] !== ownerFileName) {
    throw runnerError("CUT_CORE_TEST_LOCK_MALFORMED", "core test lock changed before release");
  }
  await unlink(join(lockPath, ownerFileName));
  await rmdir(lockPath);
}

export async function acquireCoreTestLock({
  repositoryRoot,
  pid = process.pid,
  runId = randomUUID(),
  startedAtUtc = new Date().toISOString(),
  processAlive = isProcessAlive,
} = {}) {
  const canonicalRoot = await realpath(repositoryRoot ?? defaultRepositoryRoot);
  const { lockParent, parentState } = await ensureLockParent(canonicalRoot);
  const lockPath = join(lockParent, "dist-core-tests.lock");
  const expectedOwner = ownerRecord({ pid, repositoryRoot: canonicalRoot, runId, startedAtUtc });

  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const observed = await readExactOwner(lockPath, canonicalRoot);
    if (processAlive(observed.owner.pid)) {
      throw runnerError("CUT_CORE_TEST_LOCK_HELD", "another core test runner owns the repository lock", {
        pid: observed.owner.pid,
        runId: observed.owner.runId,
      });
    }
    throw runnerError("CUT_CORE_TEST_LOCK_STALE_MANUAL_RECOVERY", "dead-owner core test lock requires manual recovery", {
      pid: observed.owner.pid,
      runId: observed.owner.runId,
    });
  }

  const lockState = await exactRealDirectory(lockPath, "new core test lock");
  await exactRealDirectory(lockParent, "repository lock parent", parentState);
  const ownerPath = join(lockPath, ownerFileName);
  let handle;
  try {
    handle = await open(
      ownerPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(expectedOwner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  const created = await readExactOwner(lockPath, canonicalRoot, lockState);
  if (JSON.stringify(created.owner) !== JSON.stringify(expectedOwner)) {
    throw runnerError("CUT_CORE_TEST_LOCK_OWNERSHIP_CHANGED", "new core test lock owner changed during acquisition");
  }

  let released = false;
  return Object.freeze({
    lockPath,
    owner: expectedOwner,
    async release() {
      if (released) return;
      await releaseOwnedLock({
        lockPath,
        repositoryRoot: canonicalRoot,
        parentState,
        lockState,
        ownerState: created.ownerState,
        expectedOwner,
      });
      released = true;
    },
  });
}

export async function enumerateDistCoreTests(repositoryRoot = defaultRepositoryRoot) {
  const canonicalRoot = await realpath(repositoryRoot);
  const testsRoot = join(canonicalRoot, "dist-cli", "tests");
  const canonicalTestsRoot = await realpath(testsRoot).catch(() => null);
  if (canonicalTestsRoot !== testsRoot) {
    throw runnerError("CUT_CORE_TEST_PATH", "compiled tests root must be a real repository directory");
  }
  await exactRealDirectory(testsRoot, "compiled tests root");
  const names = (await readdir(testsRoot)).filter((name) => name.endsWith(".test.js")).sort();
  if (names.length === 0) throw runnerError("CUT_CORE_TEST_LIST_EMPTY", "compiled core test list is empty");
  return Object.freeze(names.map((name) => `dist-cli/tests/${name}`));
}

async function fileBindings(repositoryRoot, locators, label) {
  const bindings = [];
  for (const locator of locators) bindings.push(await repositoryFileBinding(repositoryRoot, locator, `${label} ${locator}`));
  return Object.freeze(bindings);
}

export async function coreTestInvocationIdentity({
  repositoryRoot,
  files,
  runIdentity = null,
  evidenceLocators = runtimeEvidenceLocators,
}) {
  const childArguments = Object.freeze(["--test", ...files]);
  const testFiles = await fileBindings(repositoryRoot, files, "compiled test");
  const boundRuntimeFiles = await fileBindings(repositoryRoot, [...evidenceLocators].sort(), "runtime evidence");
  const node = await externalExecutableIdentity(process.execPath, "Node executable");
  const aggregate = Object.freeze({ childArguments, testFiles, boundRuntimeFiles, node });
  return Object.freeze({
    format: invocationFormat,
    version: invocationVersion,
    runIdentity,
    repositoryRootSha256: sha256(repositoryRoot),
    node: Object.freeze({ version: process.version, ...node }),
    testFileCount: testFiles.length,
    testFiles,
    testFileListSha256: sha256(JSON.stringify(testFiles.map(({ path }) => path))),
    childArgumentsSha256: sha256(JSON.stringify(childArguments)),
    boundRuntimeFiles,
    aggregateManifestSha256: sha256(JSON.stringify(aggregate)),
  });
}

async function superviseChild(child, signalSource) {
  let requestedSignal = null;
  let signalForwardError = null;
  const handlers = new Map();
  for (const signal of Object.keys(signalExitCodes)) {
    const handler = () => {
      if (requestedSignal === null) requestedSignal = signal;
      try {
        if (!child.kill(signal)) signalForwardError = `child refused ${signal}`;
      } catch (error) {
        signalForwardError = `${error?.name ?? "Error"}:${error?.code ?? "UNKNOWN"}`;
      }
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }
  try {
    return await new Promise((resolveResult) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolveResult(Object.freeze({ ...result, requestedSignal, signalForwardError }));
      };
      child.once("error", (error) => settle({
        code: null,
        signal: null,
        spawnError: Object.freeze({ name: error?.name ?? "Error", code: error?.code ?? null }),
      }));
      child.once("close", (code, signal) => settle({ code, signal, spawnError: null }));
    });
  } finally {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler);
  }
}

async function spawnAndSupervise({ command, arguments: args, cwd, environment, spawnProcess, signalSource, stdio }) {
  let child;
  try {
    child = spawnProcess(command, args, { cwd, env: environment, stdio });
  } catch (error) {
    throw runnerError("CUT_CORE_TEST_CHILD_SPAWN", "core test child could not be spawned", {
      name: error?.name ?? "Error",
      code: error?.code ?? null,
    });
  }
  const result = await superviseChild(child, signalSource);
  if (result.spawnError !== null) {
    throw runnerError("CUT_CORE_TEST_CHILD_SPAWN", "core test child could not be spawned", result.spawnError);
  }
  return result;
}

function childExitCode(result) {
  return result.requestedSignal !== null
    ? signalExitCodes[result.requestedSignal]
    : result.signal !== null
      ? (signalExitCodes[result.signal] ?? 1)
      : (result.code ?? 1);
}

async function buildInvocationIdentity(npmExecPath, runIdentity) {
  const npm = await externalExecutableIdentity(npmExecPath, "npm executable");
  const canonicalNpmExecPath = await realpath(npmExecPath);
  const childArguments = [canonicalNpmExecPath, "run", "cli:build"];
  const node = await externalExecutableIdentity(process.execPath, "Node executable");
  return Object.freeze({
    command: process.execPath,
    arguments: Object.freeze(childArguments),
    evidence: Object.freeze({
      format: "cut-dist-core-build-invocation",
      version: 2,
      runIdentity,
      node: Object.freeze({ version: process.version, ...node }),
      npm,
      childArgumentsSha256: sha256(JSON.stringify(childArguments)),
    }),
  });
}

export async function runDistCoreTests({
  repositoryRoot = defaultRepositoryRoot,
  build = false,
  npmExecutablePath = process.env.npm_execpath,
  evidenceLocators = runtimeEvidenceLocators,
  spawnProcess = spawn,
  signalSource = process,
  stdio = "inherit",
  output = (line) => process.stdout.write(`${line}\n`),
  lockOptions = {},
} = {}) {
  const canonicalRoot = await realpath(repositoryRoot);
  const lock = await acquireCoreTestLock({ repositoryRoot: canonicalRoot, ...lockOptions });
  let result;
  let stage = "test";
  try {
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    if (build) {
      stage = "build";
      const buildInvocation = await buildInvocationIdentity(npmExecutablePath, lock.owner);
      output(JSON.stringify(buildInvocation.evidence));
      result = await spawnAndSupervise({
        command: buildInvocation.command,
        arguments: buildInvocation.arguments,
        cwd: canonicalRoot,
        environment: childEnvironment,
        spawnProcess,
        signalSource,
        stdio,
      });
    }
    if (!build || childExitCode(result) === 0) {
      stage = "test";
      const files = await enumerateDistCoreTests(canonicalRoot);
      const identity = await coreTestInvocationIdentity({
        repositoryRoot: canonicalRoot,
        files,
        runIdentity: lock.owner,
        evidenceLocators,
      });
      output(JSON.stringify(identity));
      result = await spawnAndSupervise({
        command: process.execPath,
        arguments: ["--test", ...files],
        cwd: canonicalRoot,
        environment: childEnvironment,
        spawnProcess,
        signalSource,
        stdio,
      });
      const after = await coreTestInvocationIdentity({
        repositoryRoot: canonicalRoot,
        files,
        runIdentity: lock.owner,
        evidenceLocators,
      });
      if (JSON.stringify(after) !== JSON.stringify(identity)) {
        throw runnerError("CUT_CORE_TEST_INPUT_DRIFT", "bound core test inputs changed during execution");
      }
    }
  } finally {
    await lock.release();
  }
  return Object.freeze({ ...result, stage, exitCode: childExitCode(result) });
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--build")) {
      throw runnerError("CUT_CORE_TEST_ARGUMENTS", "usage: run-dist-core-tests.mjs [--build]");
    }
    const result = await runDistCoreTests({ build: args[0] === "--build" });
    if (result.signalForwardError !== null) {
      process.stderr.write(`core test signal forwarding failed: ${result.signalForwardError}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error?.code ?? "CUT_CORE_TEST_RUNNER"}: ${error?.message ?? "core test runner failed"}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
