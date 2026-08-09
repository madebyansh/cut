import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutFootageError } from "../lib/footage/diagnostics";
import { collectCutFootageLocalDoctorReport } from "../lib/footage/doctor";
import {
  cutFootageBackendIdentityFromInstall,
  inspectCutFootageLocalInstall,
  resolveCutFootageHome,
  setupCutFootageLocalBackend,
  startCutFootageLocalSidecar,
  type CutFootageLocalOperations,
  type CutFootageLocalSidecarLaunch,
} from "../lib/footage/setup";
import type { CutFootageSidecarHandshake, CutFootageSidecarSession } from "../lib/footage/sidecar";

function footageError(code: CutFootageError["code"]) {
  return (error: unknown) => error instanceof CutFootageError && error.code === code;
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fakeModelFiles = Object.freeze([
  { locator: "config.json", role: "config", bytes: Buffer.from("fixture-config\n") },
  { locator: "tokenizer.json", role: "tokenizer", bytes: Buffer.from("fixture-tokenizer\n") },
  { locator: "preprocessor_config.json", role: "preprocessor", bytes: Buffer.from("fixture-processor\n") },
  { locator: "onnx/text_model_quantized.onnx", role: "text", bytes: Buffer.from("fixture-text-graph\n") },
  { locator: "onnx/vision_model_quantized.onnx", role: "vision", bytes: Buffer.from("fixture-vision-graph\n") },
] as const);

async function fakeRecipe() {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-recipe-"));
  const sidecar = "process.stdout.write('fixture sidecar\\n');\n";
  const model = {
    format: "cut-footage-local-model", version: 1,
    provider: "fixture-transformers", model: "fixture/clip", revision: "r1",
    dtype: "q8", device: "cpu", dimensions: 4,
    selfTestSha256: "b".repeat(64),
    files: fakeModelFiles.map((file) => ({ locator: file.locator, role: file.role, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) })),
  };
  const packageJson = {
    name: "@cut-lang/footage-local", version: "1.0.0", private: true, type: "module",
    engines: { node: ">=20.19.0 <21 || >=24.0.0 <25" },
    dependencies: { "@huggingface/transformers": "4.2.0" },
  };
  const packageLock = {
    name: "@cut-lang/footage-local", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "@cut-lang/footage-local", version: "1.0.0", dependencies: { "@huggingface/transformers": "4.2.0" } },
      "node_modules/@huggingface/transformers": { version: "4.2.0", dependencies: { "onnxruntime-node": "1.24.3" } },
      "node_modules/onnxruntime-node": { version: "1.24.3" },
    },
  };
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(join(root, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`),
    writeFile(join(root, "local-clip-sidecar.mjs"), sidecar),
    writeFile(join(root, "model.json"), `${JSON.stringify(model, null, 2)}\n`),
    writeFile(join(root, "NOTICE.md"), "fixture-only notice\n"),
  ]);
  return { root, model, adapterSha256: sha256(sidecar) };
}

function fakeSession(handshake: CutFootageSidecarHandshake, onClose?: () => void): CutFootageSidecarSession {
  return Object.freeze({
    handshake, pid: undefined,
    async index() { throw new Error("not used by setup"); },
    async searchText() { throw new Error("not used by setup"); },
    async close() { onClose?.(); },
  });
}

function fakeOperations(model: Awaited<ReturnType<typeof fakeRecipe>>["model"], launches: CutFootageLocalSidecarLaunch[] = []): CutFootageLocalOperations {
  return Object.freeze({
    async installRuntime({ stagingRoot }) {
      await mkdir(join(stagingRoot, "node_modules/@huggingface/transformers"), { recursive: true });
      await mkdir(join(stagingRoot, "node_modules/onnxruntime-node"), { recursive: true });
      await mkdir(join(stagingRoot, "node_modules/semver/bin"), { recursive: true });
      await mkdir(join(stagingRoot, "node_modules/.bin"), { recursive: true });
      await Promise.all([
        writeFile(join(stagingRoot, "node_modules/@huggingface/transformers/package.json"), '{"name":"@huggingface/transformers","version":"4.2.0"}\n'),
        writeFile(join(stagingRoot, "node_modules/onnxruntime-node/package.json"), '{"name":"onnxruntime-node","version":"1.24.3"}\n'),
        writeFile(join(stagingRoot, "node_modules/semver/bin/semver.js"), "fixture semver\n"),
      ]);
      await symlink("../semver/bin/semver.js", join(stagingRoot, "node_modules/.bin/semver"));
    },
    async startSidecar(launch) {
      launches.push(launch);
      if (launch.mode === "setup") {
        for (const file of fakeModelFiles) {
          const target = join(launch.modelRevisionRoot, ...file.locator.split("/"));
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, file.bytes);
        }
      }
      return fakeSession(launch.expectedHandshake);
    },
  });
}

async function installedFixture() {
  const home = join(await mkdtemp(join(tmpdir(), "cut-footage-install-")), "footage");
  const recipe = await fakeRecipe();
  const launches: CutFootageLocalSidecarLaunch[] = [];
  const operations = fakeOperations(recipe.model, launches);
  const report = await setupCutFootageLocalBackend({
    backend: "local", home, recipeRoot: recipe.root, npmExecutable: process.execPath,
    platform: "linux", architecture: "x64", nodeVersion: "24.15.0", operations,
  });
  return { home, recipe, launches, operations, report, installationRoot: join(home, "local-clip-v1") };
}

test("footage setup rejects unsupported backends and unsafe explicit homes before touching disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-setup-red-"));
  await assert.rejects(
    setupCutFootageLocalBackend({ backend: "hosted", home: join(root, "unused") }),
    footageError("CUT_FOOTAGE_BACKEND_PROTOCOL"),
  );
  for (const home of ["relative/footage", "/", "/tmp/unsafe\nfootage"]) {
    assert.throws(() => resolveCutFootageHome({ explicitHome: home }), footageError("CUT_FOOTAGE_BACKEND_PROTOCOL"));
  }
});

test("footage setup home defaults below the user home and accepts one canonical absolute override", async () => {
  const userHome = await mkdtemp(join(tmpdir(), "cut-footage-user-home-"));
  assert.equal(resolveCutFootageHome({ homeDirectory: userHome }), join(userHome, ".cut", "footage"));
  const explicitHome = join(userHome, "isolated-footage");
  assert.equal(resolveCutFootageHome({ explicitHome }), explicitHome);
  const environmentHome = join(userHome, "environment-footage");
  assert.equal(resolveCutFootageHome({ environment: { CUT_FOOTAGE_HOME: environmentHome } }), environmentHome);
  assert.equal(resolveCutFootageHome({ explicitHome, environment: { CUT_FOOTAGE_HOME: environmentHome } }), explicitHome);
});

test("footage doctor returns one stable missing-backend report without leaking its home", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "cut-footage-doctor-red-")), "private-secret-home");
  const report = await collectCutFootageLocalDoctorReport({ home });
  assert.deepEqual(report, {
    format: "cut-footage-local-doctor-report",
    version: 1,
    status: "fail",
    backend: "local",
    checks: [{
      code: "CUTFD1001",
      name: "Local footage backend",
      status: "fail",
      detail: "The local footage backend is not installed.",
      remedy: "Run cut footage setup --backend local, then rerun footage doctor.",
    }],
  });
  assert.equal(JSON.stringify(report).includes(home), false);
});

test("footage setup stages, verifies online and offline, atomically publishes, and is idempotent", async () => {
  const fixture = await installedFixture();
  assert.equal(fixture.report.status, "installed");
  assert.equal(JSON.stringify(fixture.report).includes(fixture.home), false);
  assert.deepEqual(fixture.launches.map((launch) => launch.mode), ["setup", "offline"]);
  assert.equal(fixture.launches[0]?.environment.CUT_FOOTAGE_MODEL_DIR, fixture.launches[0]?.modelRevisionRoot);
  assert.equal(fixture.launches[0]?.modelRevisionRoot.includes(".local-clip-v1.staging-"), true);
  assert.equal(fixture.launches[0]?.modelRevisionRoot.endsWith("/models/fixture/clip/r1"), true);
  assert.equal(fixture.launches[1]?.environment.CUT_FOOTAGE_MODEL_DIR, fixture.launches[1]?.modelRevisionRoot);
  const names = await readdir(fixture.home);
  assert.equal(names.includes("local-clip-v1"), true);
  assert.equal(names.some((name) => name.includes("staging") || name.endsWith(".lock")), false);
  assert.ok(JSON.parse(await readFile(join(fixture.installationRoot, "install-manifest.json"), "utf8")));

  let installedAgain = false;
  const reused = await setupCutFootageLocalBackend({
    backend: "local", home: fixture.home, recipeRoot: fixture.recipe.root, npmExecutable: process.execPath,
    platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
    operations: {
      async installRuntime() { installedAgain = true; throw new Error("must not reinstall"); },
      async startSidecar(launch) { assert.equal(launch.mode, "offline"); return fakeSession(launch.expectedHandshake); },
    },
  });
  assert.equal(reused.status, "ready");
  assert.equal(installedAgain, false);
});

test("setup failure removes only its lock and staging directory and does not leak child diagnostics", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "cut-footage-failed-")), "secret-home");
  const recipe = await fakeRecipe();
  await assert.rejects(
    setupCutFootageLocalBackend({
      backend: "local", home, recipeRoot: recipe.root, npmExecutable: process.execPath,
      platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
      operations: {
        async installRuntime() { throw new Error(`super-secret ${home}`); },
        async startSidecar() { throw new Error("unreachable"); },
      },
    }),
    (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_PUBLISH"
      && !error.message.includes("super-secret") && !error.message.includes(home),
  );
  assert.deepEqual(await readdir(home), []);
});

test("setup lock contention and an invalid immutable install fail without deleting either", async () => {
  const base = await mkdtemp(join(tmpdir(), "cut-footage-contention-"));
  const recipe = await fakeRecipe();
  const home = join(base, "footage");
  await mkdir(home);
  await writeFile(join(home, "local-clip-v1.lock"), "held\n");
  await assert.rejects(setupCutFootageLocalBackend({
    backend: "local", home, recipeRoot: recipe.root, npmExecutable: process.execPath,
    platform: "linux", architecture: "x64", nodeVersion: "24.15.0", operations: fakeOperations(recipe.model),
  }), footageError("CUT_FOOTAGE_PUBLISH"));
  assert.equal(await readFile(join(home, "local-clip-v1.lock"), "utf8"), "held\n");

  await rm(join(home, "local-clip-v1.lock"));
  await mkdir(join(home, "local-clip-v1"));
  await writeFile(join(home, "local-clip-v1/preserve-me"), "do not delete\n");
  await assert.rejects(setupCutFootageLocalBackend({
    backend: "local", home, recipeRoot: recipe.root, npmExecutable: process.execPath,
    platform: "linux", architecture: "x64", nodeVersion: "24.15.0", operations: fakeOperations(recipe.model),
  }), footageError("CUT_FOOTAGE_MODEL_MISMATCH"));
  assert.equal(await readFile(join(home, "local-clip-v1/preserve-me"), "utf8"), "do not delete\n");
});

test("setup never replaces a destination created at the publication boundary", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "cut-footage-publish-race-")), "footage");
  const recipe = await fakeRecipe();
  const operations = fakeOperations(recipe.model);
  await assert.rejects(setupCutFootageLocalBackend({
    backend: "local", home, recipeRoot: recipe.root, npmExecutable: process.execPath,
    platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
    operations: {
      ...operations,
      async beforePublish({ target }) {
        await mkdir(target);
        await writeFile(join(target, "preserve-me"), "external entry\n");
      },
    },
  }), footageError("CUT_FOOTAGE_PUBLISH"));
  assert.equal(await readFile(join(home, "local-clip-v1/preserve-me"), "utf8"), "external entry\n");
  assert.equal((await readdir(home)).some((name) => name.includes("staging") || name.endsWith(".lock")), false);
});

test("setup refuses package scripts and cleans its owned stage and lock", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "cut-footage-hostile-recipe-")), "footage");
  const recipe = await fakeRecipe();
  const packagePath = join(recipe.root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts = { preinstall: "steal-secrets" };
  await writeFile(packagePath, `${JSON.stringify(packageJson)}\n`);
  await assert.rejects(setupCutFootageLocalBackend({
    backend: "local", home, recipeRoot: recipe.root, npmExecutable: process.execPath,
    platform: "linux", architecture: "x64", nodeVersion: "24.15.0", operations: fakeOperations(recipe.model),
  }), footageError("CUT_FOOTAGE_MODEL_MISMATCH"));
  assert.deepEqual(await readdir(home), []);
});

test("doctor rehashes the complete runtime, model, and adapter trees before launching inference", async () => {
  for (const locator of [
    "node_modules/@huggingface/transformers/package.json",
    "models/fixture/clip/r1/onnx/text_model_quantized.onnx",
    "local-clip-sidecar.mjs",
  ]) {
    const fixture = await installedFixture();
    await writeFile(join(fixture.installationRoot, ...locator.split("/")), "drift\n");
    let started = false;
    await assert.rejects(inspectCutFootageLocalInstall({
      home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
    }), footageError("CUT_FOOTAGE_MODEL_MISMATCH"));
    const report = await collectCutFootageLocalDoctorReport({
      home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
      operations: {
        ...fixture.operations,
        async startSidecar(launch) { started = true; return fakeSession(launch.expectedHandshake); },
      },
    });
    assert.equal(report.status, "fail");
    assert.equal(started, false);
    assert.equal(JSON.stringify(report).includes(fixture.home), false);
  }
});

test("doctor rejects platform or handshake drift and starts ordinary sidecars offline", async () => {
  const fixture = await installedFixture();
  await inspectCutFootageLocalInstall({
    home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "20.19.0",
  });
  await assert.rejects(inspectCutFootageLocalInstall({
    home: fixture.home, platform: "linux", architecture: "arm64", nodeVersion: "24.15.0",
  }), footageError("CUT_FOOTAGE_MODEL_MISMATCH"));
  await assert.rejects(inspectCutFootageLocalInstall({
    home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "22.0.0",
  }), footageError("CUT_FOOTAGE_MODEL_MISMATCH"));

  await assert.rejects(startCutFootageLocalSidecar({
    home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
    operations: {
      ...fixture.operations,
      async startSidecar(launch) {
        return fakeSession({ ...launch.expectedHandshake, selfTestSha256: "c".repeat(64) });
      },
    },
  }), footageError("CUT_FOOTAGE_MODEL_MISMATCH"));

  let normalLaunch: CutFootageLocalSidecarLaunch | undefined;
  const session = await startCutFootageLocalSidecar({
    home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
    operations: {
      ...fixture.operations,
      async startSidecar(launch) { normalLaunch = launch; return fakeSession(launch.expectedHandshake); },
    },
  });
  assert.equal(normalLaunch?.mode, "offline");
  assert.equal(normalLaunch?.environment.CUT_FOOTAGE_MODEL_DIR, normalLaunch?.modelRevisionRoot);
  assert.equal(normalLaunch?.arguments.at(-1), "offline");
  await session.close();
});

test("doctor accepts the locked in-tree npm bin symlink and refuses a replacement that escapes", async () => {
  const fixture = await installedFixture();
  const link = join(fixture.installationRoot, "node_modules/.bin/semver");
  await rm(link);
  await writeFile(join(fixture.home, "escape"), "outside runtime\n");
  await symlink("../../../escape", link);
  await assert.rejects(inspectCutFootageLocalInstall({
    home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
  }), footageError("CUT_FOOTAGE_MODEL_MISMATCH"));
});

test("doctor binds empty directories as part of the complete immutable runtime tree", async () => {
  const fixture = await installedFixture();
  await mkdir(join(fixture.installationRoot, "node_modules/unexpected-empty-directory"));
  await assert.rejects(inspectCutFootageLocalInstall({
    home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
  }), footageError("CUT_FOOTAGE_MODEL_MISMATCH"));
});

test("canonical public backend identity binds model revision, dtype, device, and adapter bytes", async () => {
  const fixture = await installedFixture();
  const install = await inspectCutFootageLocalInstall({
    home: fixture.home, platform: "linux", architecture: "x64", nodeVersion: "24.15.0",
  });
  assert.deepEqual(cutFootageBackendIdentityFromInstall(install), {
    protocolVersion: 1,
    provider: "fixture-transformers",
    model: `fixture/clip@r1;q8;cpu;adapter=${fixture.recipe.adapterSha256}`,
    dimensions: 4,
    normalization: "l2",
  });
});
