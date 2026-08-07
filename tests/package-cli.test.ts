import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readCutPackageManifestFile, refreshCutPackageManifestIntegrity } from "../lib/package/project";

const cli = resolve("dist-cli/cli/cut.js");

async function run(args: string[], cwd: string, expectedCode = 0) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(Buffer.from(value)));
    child.stderr.on("data", (value: Buffer) => stderr.push(Buffer.from(value)));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === expectedCode) accept(result);
      else reject(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
  });
}

test("package CLI init/add/list/update/remove is a real local/file workflow with stable JSON", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-package-cli-")), project = join(workspace, "project"), dependency = join(workspace, "dependency");
  try {
    const initialized = JSON.parse((await run(["package", "init", project, "--name", "package-cli-project", "--json"], workspace)).stdout) as { format: string; command: string; status: string; project: string };
    assert.deepEqual({ format: initialized.format, command: initialized.command, status: initialized.status, project: initialized.project }, { format: "cut-package-command-report", command: "package init", status: "pass", project: "package-cli-project" });
    await run(["package", "init", dependency, "--name", "@proof/package-cli-dependency", "--version", "1.2.3", "--json"], workspace);
    const added = JSON.parse((await run(["package", "add", "../dependency", "--project", project, "--json"], workspace)).stdout) as { command: string; dependency: string; packages: number };
    assert.deepEqual({ command: added.command, dependency: added.dependency, packages: added.packages }, { command: "package add", dependency: "@proof/package-cli-dependency", packages: 1 });
    const listed = JSON.parse((await run(["package", "list", "--project", project, "--json"], workspace)).stdout) as { format: string; packages: Array<{ name: string; version: string; direct: boolean; source: string; integrity: string; capabilities: string[] }> };
    assert.equal(listed.format, "cut-package-list");
    assert.deepEqual(listed.packages, [{ name: "@proof/package-cli-dependency", version: "1.2.3", source: "file:../dependency", integrity: listed.packages[0].integrity, direct: true, capabilities: [] }]);
    const verified = JSON.parse((await run(["package", "verify", "--project", project, "--json"], workspace)).stdout) as { command: string; lockIntegrity: string };
    assert.equal(verified.command, "package verify");
    assert.match(verified.lockIntegrity, /^sha256-[a-f0-9]{64}$/);

    const dependencySource = join(dependency, "index.cut"), exactSource = await readFile(dependencySource, "utf8");
    await writeFile(dependencySource, `${exactSource}\n// tampered after lock\n`);
    const tamperedDependency = JSON.parse((await run(["package", "verify", "--project", project, "--json"], workspace, 1)).stdout) as { diagnostics: Array<{ code: string }> };
    assert.equal(tamperedDependency.diagnostics[0]?.code, "CUT_PACKAGE_TAMPERED");
    await writeFile(dependencySource, exactSource);

    const updated = JSON.parse((await run(["package", "update", "--project", project, "--name", "@proof/package-cli-dependency", "--exact", "--json"], workspace)).stdout) as { command: string; updated: string[] };
    assert.deepEqual({ command: updated.command, updated: updated.updated }, { command: "package update", updated: ["@proof/package-cli-dependency"] });
    const removed = JSON.parse((await run(["package", "remove", "@proof/package-cli-dependency", "--project", project, "--json"], workspace)).stdout) as { command: string; packages: number };
    assert.deepEqual({ command: removed.command, packages: removed.packages }, { command: "package remove", packages: 0 });
    const empty = JSON.parse((await run(["package", "list", "--project", project, "--json"], workspace)).stdout) as { packages: unknown[] };
    assert.deepEqual(empty.packages, []);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("package lock refreshes root integrity and package verify is strict and read-only", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-package-lock-cli-")), project = join(workspace, "project");
  try {
    await run(["package", "init", project, "--name", "package-lock-proof"], workspace);
    const sourcePath = join(project, "index.cut"), source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, `${source}\n// a deliberate source edit\n`);

    const stale = JSON.parse((await run(["package", "verify", "--project", project, "--json"], workspace, 1)).stdout) as { format: string; command: string; diagnostics: Array<{ code: string }> };
    assert.equal(stale.format, "cut-cli-diagnostics");
    assert.equal(stale.command, "package verify");
    assert.equal(stale.diagnostics[0]?.code, "CUT_PACKAGE_TAMPERED");

    const locked = JSON.parse((await run(["package", "lock", "--project", project, "--json"], workspace)).stdout) as { format: string; command: string; status: string; project: string; lockIntegrity: string };
    assert.deepEqual({ format: locked.format, command: locked.command, status: locked.status, project: locked.project }, { format: "cut-package-command-report", command: "package lock", status: "pass", project: "package-lock-proof" });
    assert.match(locked.lockIntegrity, /^sha256-[a-f0-9]{64}$/);

    const manifestPath = join(project, "cut.package.json"), lockPath = join(project, "cut.package.lock");
    const beforeVerify = await Promise.all([readFile(manifestPath, "utf8"), readFile(lockPath, "utf8")]);
    const verified = JSON.parse((await run(["package", "verify", "--project", project, "--json"], workspace)).stdout) as { command: string; status: string; lockIntegrity: string };
    assert.deepEqual({ command: verified.command, status: verified.status, lockIntegrity: verified.lockIntegrity }, { command: "package verify", status: "pass", lockIntegrity: locked.lockIntegrity });
    assert.deepEqual(await Promise.all([readFile(manifestPath, "utf8"), readFile(lockPath, "utf8")]), beforeVerify, "verify must not rewrite trusted files");

    const tampered = JSON.parse(beforeVerify[1]) as { integrity: string };
    tampered.integrity = `${tampered.integrity.slice(0, -1)}${tampered.integrity.endsWith("0") ? "1" : "0"}`;
    await writeFile(lockPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const rejected = JSON.parse((await run(["package", "verify", "--project", project, "--json"], workspace, 1)).stdout) as { diagnostics: Array<{ code: string }> };
    assert.equal(rejected.diagnostics[0]?.code, "CUT_PACKAGE_LOCK_TAMPERED");

    await unlink(lockPath);
    const missing = JSON.parse((await run(["package", "verify", "--project", project, "--json"], workspace, 1)).stdout) as { diagnostics: Array<{ code: string; source?: { path?: string } }> };
    assert.equal(missing.diagnostics[0]?.code, "CUT_PACKAGE_LOCK_MISSING");
    assert.equal(missing.diagnostics[0]?.source?.path, "cut.package.lock");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("packaged check requires the existing lock, rejects tampering, and locates dependency type errors", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-package-cli-proof-")), project = join(workspace, "package-proof"), packages = join(workspace, "packages"), dependency = join(packages, "impact-cards");
  try {
    await cp(resolve("examples/package-proof"), project, { recursive: true });
    await cp(resolve("examples/packages/impact-cards"), dependency, { recursive: true });
    await rm(join(project, ".cut"), { recursive: true, force: true });
    await unlink(join(project, "cut.package.lock"));

    const missing = JSON.parse((await run(["check", "main.cut", "--json"], project, 1)).stdout) as { format: string; diagnostics: Array<{ code: string; source?: { path?: string } }> };
    assert.equal(missing.format, "cut-cli-diagnostics");
    assert.equal(missing.diagnostics[0]?.code, "CUT_PACKAGE_LOCK_MISSING");
    assert.equal(missing.diagnostics[0]?.source?.path, "cut.package.lock");

    await run(["package", "update", "--project", project], workspace);
    const passing = JSON.parse((await run(["check", "main.cut", "--json"], project)).stdout) as { format: string; status: string };
    assert.deepEqual({ format: passing.format, status: passing.status }, { format: "cut-diagnostics", status: "pass" });

    const lockPath = join(project, "cut.package.lock"), tampered = JSON.parse(await readFile(lockPath, "utf8")) as { integrity: string };
    tampered.integrity = `${tampered.integrity.slice(0, -1)}${tampered.integrity.endsWith("0") ? "1" : "0"}`;
    await writeFile(lockPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const rejected = JSON.parse((await run(["check", "main.cut", "--json"], project, 1)).stdout) as { diagnostics: Array<{ code: string }> };
    assert.equal(rejected.diagnostics[0]?.code, "CUT_PACKAGE_LOCK_TAMPERED");

    const sourcePath = join(dependency, "index.cut"), source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, source.replace("Rect(width: width", 'Rect(width: "not-a-length"'));
    const refreshed = await refreshCutPackageManifestIntegrity(dependency, await readCutPackageManifestFile(dependency));
    await writeFile(join(dependency, "cut.package.json"), `${JSON.stringify(refreshed, null, 2)}\n`);
    await run(["package", "update", "--project", project], workspace);

    const typeFailure = JSON.parse((await run(["check", "main.cut", "--json"], project, 1)).stdout) as { format: string; diagnostics: Array<{ code: string; source?: { path?: string; line?: number; column?: number } }> };
    assert.equal(typeFailure.format, "cut-diagnostics");
    const diagnostic = typeFailure.diagnostics.find((item) => item.code === "CUT2029");
    assert.equal(diagnostic?.source?.path, "@cut-proof/impact-cards/index.cut");
    assert.ok((diagnostic?.source?.line ?? 0) > 0 && (diagnostic?.source?.column ?? 0) > 0);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
