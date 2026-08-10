import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createFootageRealSmokePlan,
  executeFootageRealSmokeCommand,
  executeFootageRealSmokePlan,
  runFootageRealSmoke,
  snapshotInstalledCutPackage,
} from "./run-footage-real-smoke.mjs";

const root = resolve("/tmp/cut-footage-real-smoke-test");

test("real smoke plan allows network only for the first setup and drives the installed cut binary", () => {
  const plan = createFootageRealSmokePlan({
    cutExecutable: resolve(root, "consumer/node_modules/.bin/cut"),
    ffmpegExecutable: resolve(root, "tools/ffmpeg"),
    ffprobeExecutable: resolve(root, "tools/ffprobe"),
    fixtureRoot: resolve(root, "fixtures"),
    projectRoot: resolve(root, "project"),
    reportsRoot: resolve(root, "reports"),
    footageHome: resolve(root, "footage-home"),
  });

  assert.deepEqual(plan.map((step) => step.name), [
    "dog-video", "dashboard-video", "setup-first", "setup-second", "doctor",
    "index", "search-first", "search-second", "extract", "extract-no-clobber", "extract-ffprobe",
  ]);
  assert.deepEqual(plan[2].args, ["footage", "setup", "--backend", "local", "--json"]);
  assert.equal(plan[2].command, resolve(root, "consumer/node_modules/.bin/cut"));
  assert.equal(plan[2].environment.CUT_FOOTAGE_HOME, resolve(root, "footage-home"));
  assert.equal(plan[2].environment.HF_HUB_OFFLINE, undefined);
  assert.equal(plan[2].environment.npm_config_offline, undefined);
  assert.equal(plan[2].allowNetwork, true);
  assert.equal(plan[2].timeoutMs, 30 * 60_000);

  for (const step of plan.slice(3, 10)) {
    assert.equal(step.environment.CUT_FOOTAGE_HOME, resolve(root, "footage-home"), step.name);
    assert.equal(step.environment.HF_HUB_OFFLINE, "1", step.name);
    assert.equal(step.environment.TRANSFORMERS_OFFLINE, "1", step.name);
    assert.equal(step.environment.npm_config_offline, "true", step.name);
    assert.ok(Number.isSafeInteger(step.timeoutMs) && step.timeoutMs >= 60_000 && step.timeoutMs <= 30 * 60_000, step.name);
  }
  assert.equal(plan[9].expectedExit, "failure");
  assert.deepEqual(plan[9].expectedDiagnostic, {
    format: "cut-cli-diagnostics", command: "footage extract", code: "CUT_FOOTAGE_OUTPUT_EXISTS",
  });
  assert.deepEqual(plan[9].preserveOutputs, [
    resolve(root, "project/selects/dog.mp4"),
    resolve(root, "project/selects/dog.mp4.cut-footage.json"),
  ]);
  assert.equal(plan[5].cwd, resolve(root, "project"));
  assert.deepEqual(plan[5].args, ["footage", "index", "media", "--out", ".cut/footage/index.json", "--json"]);
  assert.deepEqual(plan[6].args, ["footage", "search", ".cut/footage/index.json", "--query", "a dog outdoors", "--out", ".cut/footage/search.json", "--json"]);
  assert.deepEqual(plan[8].args, ["footage", "extract", ".cut/footage/search.json", "--match", "__CUT_FIRST_MATCH_ID__", "--handles", "500ms", "--out", "selects/dog.mp4", "--json"]);
  assert.equal(plan[8].matchIdFrom, resolve(root, "project/.cut/footage/search.json"));
});

test("real smoke plan rejects relative or overlapping private roots", () => {
  const valid = {
    cutExecutable: resolve(root, "cut"), ffmpegExecutable: resolve(root, "ffmpeg"), ffprobeExecutable: resolve(root, "ffprobe"),
    fixtureRoot: resolve(root, "fixtures"), projectRoot: resolve(root, "project"), reportsRoot: resolve(root, "reports"), footageHome: resolve(root, "home"),
  };
  assert.throws(() => createFootageRealSmokePlan({ ...valid, projectRoot: "project" }), /absolute/u);
  assert.throws(() => createFootageRealSmokePlan({ ...valid, footageHome: valid.projectRoot }), /distinct/u);
  assert.throws(() => createFootageRealSmokePlan({ ...valid, reportsRoot: resolve(valid.projectRoot, "reports") }), /distinct/u);
});

test("real smoke executor captures reports and proves the failed second extraction preserved both outputs", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cut-footage-runner-test-"));
  const reports = join(sandbox, "reports"), clip = join(sandbox, "dog.mp4"), manifest = `${clip}.cut-footage.json`;
  await writeFile(clip, "clip-before");
  await writeFile(manifest, "manifest-before");
  const plan = [
    Object.freeze({ name: "success", command: "/bin/true", args: Object.freeze([]), cwd: sandbox, environment: Object.freeze({}), reportPath: join(reports, "success.json") }),
    Object.freeze({
      name: "extract-no-clobber", command: "/bin/false", args: Object.freeze([]), cwd: sandbox, environment: Object.freeze({}), reportPath: join(reports, "failure.json"),
      expectedExit: "failure", expectedDiagnostic: Object.freeze({ format: "cut-cli-diagnostics", command: "footage extract", code: "CUT_FOOTAGE_OUTPUT_EXISTS" }),
      preserveOutputs: Object.freeze([clip, manifest]),
    }),
  ];
  const seen = [];
  await executeFootageRealSmokePlan(plan, {
    async execute(step) {
      seen.push(step.name);
      return step.name === "success"
        ? { exitCode: 0, stdout: "{\"status\":\"pass\"}\n", stderr: "" }
        : { exitCode: 1, stdout: "{\"command\":\"footage extract\",\"diagnostics\":[{\"code\":\"CUT_FOOTAGE_OUTPUT_EXISTS\",\"severity\":\"error\"}],\"format\":\"cut-cli-diagnostics\",\"status\":\"fail\",\"version\":1}\n", stderr: "" };
    },
  });
  assert.deepEqual(seen, ["success", "extract-no-clobber"]);
  assert.equal(await readFile(join(reports, "success.json"), "utf8"), "{\"status\":\"pass\"}\n");
  assert.match(await readFile(join(reports, "failure.json"), "utf8"), /CUT_FOOTAGE_OUTPUT_EXISTS/u);
  assert.equal(await readFile(clip, "utf8"), "clip-before");
  assert.equal(await readFile(manifest, "utf8"), "manifest-before");
});

test("real smoke executor rejects a successful no-clobber probe or a changed protected output", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cut-footage-runner-reject-"));
  const output = join(sandbox, "output.mp4");
  await writeFile(output, "before");
  const failureStep = Object.freeze({
    name: "extract-no-clobber", command: "/bin/false", args: Object.freeze([]), cwd: sandbox, environment: Object.freeze({}),
    expectedExit: "failure", expectedDiagnostic: Object.freeze({ format: "cut-cli-diagnostics", command: "footage extract", code: "CUT_FOOTAGE_OUTPUT_EXISTS" }),
    preserveOutputs: Object.freeze([output]),
  });
  await assert.rejects(executeFootageRealSmokePlan([failureStep], { execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }), /was expected to fail/u);
  await assert.rejects(executeFootageRealSmokePlan([failureStep], { execute: async () => ({ exitCode: 124, stdout: "", stderr: "" }) }), /expected exit 1/u);
  await assert.rejects(executeFootageRealSmokePlan([failureStep], { execute: async () => ({
    exitCode: 1, stdout: "{\"format\":\"cut-cli-diagnostics\",\"version\":1,\"command\":\"footage extract\",\"status\":\"fail\",\"diagnostics\":[{\"code\":\"CUT_FOOTAGE_PUBLISH\",\"severity\":\"error\"}]}\n", stderr: "",
  }) }), /wrong failure diagnostic/u);
  await assert.rejects(executeFootageRealSmokePlan([failureStep], { execute: async () => {
    await writeFile(output, "changed");
    return { exitCode: 1, stdout: "", stderr: "" };
  } }), /changed an existing output/u);
  await writeFile(output, "before");
  await assert.rejects(executeFootageRealSmokePlan([failureStep], { execute: async () => {
    await unlink(output);
    await writeFile(output, "before");
    return { exitCode: 1, stdout: "{\"format\":\"cut-cli-diagnostics\",\"version\":1,\"command\":\"footage extract\",\"status\":\"fail\",\"diagnostics\":[{\"code\":\"CUT_FOOTAGE_OUTPUT_EXISTS\",\"severity\":\"error\"}]}\n", stderr: "" };
  } }), /changed an existing output/u);
});

test("real smoke executor resolves the canonical stable match ID before invoking extraction", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cut-footage-runner-match-"));
  const searchPath = join(sandbox, "search.json"), id = `match-${"a".repeat(64)}`;
  await writeFile(searchPath, `${JSON.stringify({ matches: [{ id }] })}\n`);
  const template = Object.freeze({
    name: "extract", command: "/bin/true", args: Object.freeze(["--match", "__CUT_FIRST_MATCH_ID__", "--handles", "500ms"]),
    cwd: sandbox, environment: Object.freeze({}), matchIdFrom: searchPath,
  });
  await executeFootageRealSmokePlan([template], { execute: async (step) => {
    assert.deepEqual(step.args, ["--match", id, "--handles", "500ms"]);
    return { exitCode: 0, stdout: "", stderr: "" };
  } });
  await writeFile(searchPath, `${JSON.stringify({ matches: [{ id: "match-not-canonical" }] })}\n`);
  await assert.rejects(executeFootageRealSmokePlan([template], { execute: async () => {
    assert.fail("malformed match ID reached the process boundary");
  } }), /canonical first match ID/u);
});

test("real smoke runner starts from empty roots, protects the CUT project, and returns the final assertion", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cut-footage-runner-full-"));
  const fixtures = join(sandbox, "fixtures"), tools = join(sandbox, "tools"), packageRoot = join(sandbox, "cut-lang");
  await Promise.all([mkdir(fixtures), mkdir(tools), mkdir(packageRoot)]);
  await Promise.all([
    writeFile(join(fixtures, "dog-outdoors.jpg"), "dog"),
    writeFile(join(fixtures, "laptop-dashboard.jpg"), "dashboard"),
    writeFile(join(tools, "cut"), "#!/bin/sh\n"),
    writeFile(join(tools, "ffmpeg"), "#!/bin/sh\n"),
    writeFile(join(tools, "ffprobe"), "#!/bin/sh\n"),
    writeFile(join(packageRoot, "package.json"), "{\"name\":\"cut-lang\"}\n"),
  ]);
  await Promise.all([chmod(join(tools, "cut"), 0o755), chmod(join(tools, "ffmpeg"), 0o755), chmod(join(tools, "ffprobe"), 0o755)]);
  const options = {
    cutExecutable: join(tools, "cut"), ffmpegExecutable: join(tools, "ffmpeg"), ffprobeExecutable: join(tools, "ffprobe"), fixtureRoot: fixtures, packageRoot,
    projectRoot: join(sandbox, "project"), reportsRoot: join(sandbox, "reports"), footageHome: join(sandbox, "home"),
  };
  const seen = [];
  const report = await runFootageRealSmoke(options, {
    async execute(step) {
      seen.push(step.name);
      if (step.name === "search-second") {
        await writeFile(join(options.projectRoot, ".cut/footage/search.json"), `${JSON.stringify({ matches: [{ id: `match-${"a".repeat(64)}` }] })}\n`);
      }
      if (step.name === "extract") {
        await writeFile(join(options.projectRoot, "selects/dog.mp4"), "clip");
        await writeFile(join(options.projectRoot, "selects/dog.mp4.cut-footage.json"), "manifest");
      }
      return step.expectedExit === "failure"
        ? { exitCode: 1, stdout: "{\"format\":\"cut-cli-diagnostics\",\"version\":1,\"command\":\"footage extract\",\"status\":\"fail\",\"diagnostics\":[{\"code\":\"CUT_FOOTAGE_OUTPUT_EXISTS\",\"severity\":\"error\"}]}\n", stderr: "" }
        : { exitCode: 0, stdout: "{}\n", stderr: "" };
    },
    async assertSmoke(project, reports, home) {
      assert.equal(project, options.projectRoot);
      assert.equal(reports, options.reportsRoot);
      assert.equal(home, options.footageHome);
      return Object.freeze({ format: "cut-footage-real-smoke-report", version: 1, status: "pass" });
    },
  });
  assert.equal(report.status, "pass");
  assert.equal(seen.length, 11);
  const protectedReport = JSON.parse(await readFile(join(options.reportsRoot, "protected.json"), "utf8"));
  for (const locator of ["main.cut", "cut.lock"]) {
    const bytes = await readFile(join(options.projectRoot, locator));
    assert.equal(protectedReport[locator], createHash("sha256").update(bytes).digest("hex"));
  }
  await assert.rejects(runFootageRealSmoke(options, { execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }), assertSmoke: async () => ({}) }), /fresh empty roots/u);
});

test("real smoke command executor captures a real child exit without a shell", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cut-footage-runner-child-"));
  const result = await executeFootageRealSmokeCommand(Object.freeze({
    name: "child-contract",
    command: process.execPath,
    args: Object.freeze(["-e", "process.stdout.write(process.env.CUT_SMOKE_SENTINEL); process.stderr.write('warn'); process.exit(3)"]),
    cwd: sandbox,
    environment: Object.freeze({ CUT_SMOKE_SENTINEL: "ok" }),
    timeoutMs: 5_000,
  }));
  assert.deepEqual(result, { exitCode: 3, stdout: "ok", stderr: "warn" });
});

test("real smoke command executor clears inherited offline flags only for the network setup", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cut-footage-runner-online-"));
  const names = ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "npm_config_offline"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "1";
    const result = await executeFootageRealSmokeCommand(Object.freeze({
      name: "setup-first", command: process.execPath,
      args: Object.freeze(["-e", `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.filter((name) => process.env[name]).map((name) => [name, process.env[name]]))))`]),
      cwd: sandbox, environment: Object.freeze({}), allowNetwork: true, timeoutMs: 5_000,
    }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "{}");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("installed CUT package snapshot binds every regular file and rejects package bloat", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cut-footage-package-snapshot-"));
  const packageRoot = join(sandbox, "cut-lang");
  await mkdir(join(packageRoot, "dist-cli"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), "{\"name\":\"cut-lang\"}\n");
  await writeFile(join(packageRoot, "dist-cli/cut.js"), "first\n");
  const first = await snapshotInstalledCutPackage(packageRoot);
  assert.deepEqual(await snapshotInstalledCutPackage(packageRoot), first);
  await writeFile(join(packageRoot, "dist-cli/cut.js"), "changed\n");
  const changed = await snapshotInstalledCutPackage(packageRoot);
  assert.notEqual(changed.sha256, first.sha256);
  await writeFile(join(packageRoot, "model.onnx"), "hidden model\n");
  await assert.rejects(snapshotInstalledCutPackage(packageRoot), /forbidden model payload/u);
});

test("real smoke runner rejects setup that rewrites the installed CUT package", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cut-footage-runner-package-drift-"));
  const fixtures = join(sandbox, "fixtures"), tools = join(sandbox, "tools"), packageRoot = join(sandbox, "cut-lang");
  await Promise.all([mkdir(fixtures), mkdir(tools), mkdir(packageRoot)]);
  await Promise.all([
    writeFile(join(fixtures, "dog-outdoors.jpg"), "dog"), writeFile(join(fixtures, "laptop-dashboard.jpg"), "dashboard"),
    writeFile(join(tools, "cut"), "#!/bin/sh\n"), writeFile(join(tools, "ffmpeg"), "#!/bin/sh\n"), writeFile(join(tools, "ffprobe"), "#!/bin/sh\n"),
    writeFile(join(packageRoot, "package.json"), "{\"name\":\"cut-lang\"}\n"),
  ]);
  await Promise.all([chmod(join(tools, "cut"), 0o755), chmod(join(tools, "ffmpeg"), 0o755), chmod(join(tools, "ffprobe"), 0o755)]);
  const options = {
    cutExecutable: join(tools, "cut"), ffmpegExecutable: join(tools, "ffmpeg"), ffprobeExecutable: join(tools, "ffprobe"), fixtureRoot: fixtures, packageRoot,
    projectRoot: join(sandbox, "project"), reportsRoot: join(sandbox, "reports"), footageHome: join(sandbox, "home"),
  };
  await assert.rejects(runFootageRealSmoke(options, {
    async execute(step) {
      if (step.name === "setup-first") await writeFile(join(packageRoot, "package.json"), "{\"name\":\"cut-lang\",\"changed\":true}\n");
      if (step.name === "search-second") {
        await writeFile(join(options.projectRoot, ".cut/footage/search.json"), `${JSON.stringify({ matches: [{ id: `match-${"a".repeat(64)}` }] })}\n`);
      }
      if (step.name === "extract") {
        await writeFile(join(options.projectRoot, "selects/dog.mp4"), "clip");
        await writeFile(join(options.projectRoot, "selects/dog.mp4.cut-footage.json"), "manifest");
      }
      return step.expectedExit === "failure"
        ? { exitCode: 1, stdout: "{\"format\":\"cut-cli-diagnostics\",\"version\":1,\"command\":\"footage extract\",\"status\":\"fail\",\"diagnostics\":[{\"code\":\"CUT_FOOTAGE_OUTPUT_EXISTS\",\"severity\":\"error\"}]}\n", stderr: "" }
        : { exitCode: 0, stdout: "{}\n", stderr: "" };
    },
    assertSmoke: async () => ({ status: "pass" }),
  }), /installed CUT package changed/u);
});
