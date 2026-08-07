import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { compileCutModule } from "../lib/language/compiler";
import { checkCutModule } from "../lib/language/checker";
import { parseCutLanguage } from "../lib/language/parser";
import {
  createCutProject,
  CutProjectError,
  loadCutProject,
  probeProjectMedia,
  validateCutProjectManifest,
} from "../lib/project";

test("project manifest is closed, typed, and traversal-safe", () => {
  const base = {
    format: "cut-project",
    version: 1,
    name: "Proof",
    language: "0.4",
    entry: "main.cut",
    directories: { media: "media", cache: ".cut", output: "output" },
    defaults: { width: 1920, height: 1080, fps: "30000/1001", sampleRate: 48000 },
  };
  assert.equal(validateCutProjectManifest(base).defaults.fps, "30000/1001");
  assert.throws(() => validateCutProjectManifest({ ...base, hiddenModelPlan: {} }), (error) => error instanceof CutProjectError && error.code === "CUTP1003");
  assert.throws(() => validateCutProjectManifest({ ...base, entry: "../outside.cut" }), (error) => error instanceof CutProjectError && error.code === "CUTP1004");
});

test("cut project initialization is deterministic, atomic, and refuses every existing target", async () => {
  const firstParent = await mkdtemp(join(tmpdir(), "cut-project-first-"));
  const secondParent = await mkdtemp(join(tmpdir(), "cut-project-second-"));
  const first = join(firstParent, "starter");
  const second = join(secondParent, "starter");
  await createCutProject(first, "Starter Proof");
  await createCutProject(second, "Starter Proof");
  const [firstManifest, secondManifest, firstSource, secondSource, firstReadme, secondReadme] = await Promise.all([
    readFile(join(first, "cut.project.json"), "utf8"),
    readFile(join(second, "cut.project.json"), "utf8"),
    readFile(join(first, "main.cut"), "utf8"),
    readFile(join(second, "main.cut"), "utf8"),
    readFile(join(first, "README.md"), "utf8"),
    readFile(join(second, "README.md"), "utf8"),
  ]);
  assert.equal(firstManifest, secondManifest);
  assert.equal(firstSource, secondSource);
  assert.equal(firstReadme, secondReadme);
  assert.match(firstReadme, /npx --no-install cut check main\.cut/);
  assert.match(firstReadme, /npm install --ignore-scripts \/path\/to\/cut-lang-<version>\.tgz/);
  const loaded = await loadCutProject(first);
  assert.equal(loaded.manifest.name, "Starter Proof");
  assert.equal(loaded.entryPath, await realpath(join(first, "main.cut")));
  const parsed = parseCutLanguage(firstSource);
  assert.ok(parsed.module, parsed.diagnostics.map((item) => item.message).join("\n"));
  const diagnostics = checkCutModule(parsed.module!).diagnostics.filter((item) => item.severity === "error");
  assert.equal(diagnostics.length, 0, diagnostics.map((item) => item.message).join("\n"));
  const compiled = compileCutModule(parsed.module!);
  assert.equal(compiled.ir.resources && Object.keys(compiled.ir.resources).length, 0);
  assert.equal(compiled.ir.assertions?.length, 1);
  assert.equal(compiled.ir.assertions?.[0]?.status, "pass");

  const existing = join(firstParent, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "keep.txt"), "must survive\n");
  await assert.rejects(createCutProject(existing, "Overwrite"), (error) => error instanceof CutProjectError && error.code === "CUTP1012");
  assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "must survive\n");
  const existingEmpty = join(firstParent, "existing-empty");
  await mkdir(existingEmpty);
  await assert.rejects(createCutProject(existingEmpty, "Overwrite Empty"), (error) => error instanceof CutProjectError && error.code === "CUTP1012");
  assert.deepEqual(await readdir(existingEmpty), []);

  const raceParent = await mkdtemp(join(tmpdir(), "cut-project-race-"));
  const raceTarget = join(raceParent, "one-winner");
  const contenders = await Promise.allSettled(
    Array.from({ length: 6 }, () => createCutProject(raceTarget, "One Winner")),
  );
  assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(contenders.filter((result) => result.status === "rejected").every(
    (result) => result.reason instanceof CutProjectError && result.reason.code === "CUTP1012",
  ));
  assert.equal((await loadCutProject(raceTarget)).manifest.name, "One Winner");
  assert.deepEqual((await readdir(raceParent)).filter((name) => name.includes(".cut-init-")), []);
  assert.deepEqual((await readdir(firstParent)).filter((name) => name.includes(".cut-init-")), []);
  assert.deepEqual((await readdir(secondParent)).filter((name) => name.includes(".cut-init-")), []);
});

test("manifest entry resolution refuses a symlink escape", { skip: process.platform === "win32" ? "symlink creation is not portable on Windows" : false }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "cut-project-entry-"));
  const root = join(parent, "project");
  const outside = join(parent, "outside.cut");
  await createCutProject(root, "Entry Proof");
  await writeFile(outside, "cut 0.4;\nproject \"outside\";\n");
  await unlink(join(root, "main.cut"));
  await symlink(outside, join(root, "main.cut"));
  const canonicalOutside = await realpath(outside);
  await assert.rejects(
    loadCutProject(root),
    (error) => error instanceof CutProjectError && error.code === "CUTP1014" && error.path === canonicalOutside,
  );
});

test("missing media is a structured project-resource error", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cut-probe-missing-"));
  const root = join(parent, "project");
  await createCutProject(root, "Missing Proof");
  const canonicalRoot = await realpath(root);
  await assert.rejects(
    probeProjectMedia(root, "media/missing.mp4"),
    (error) => error instanceof CutProjectError
      && error.code === "CUTP1015"
      && error.path === join(canonicalRoot, "media/missing.mp4"),
  );
});

test("formal media probe locks one stable snapshot and the exact bounded ffprobe identity", { timeout: 30_000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "cut-probe-"));
  const root = join(parent, "project");
  const media = join(root, "media/demo.mp4");
  await createCutProject(root, "Probe Proof");
  await copyFile(resolve("examples/media/demo.mp4"), media);
  const first = await probeProjectMedia(root, "media/demo.mp4");
  const second = await probeProjectMedia(root, "media/demo.mp4");
  const expectedDigest = createHash("sha256").update(await readFile(media)).digest("hex");
  assert.equal(first.format, "cut-media-probe");
  assert.match(first.file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.file.sha256, expectedDigest);
  assert.ok(first.file.bytes > 100_000);
  assert.deepEqual(first.file, second.file);
  assert.deepEqual(first.implementation, second.implementation);
  assert.equal(first.implementation.name, "ffprobe");
  assert.ok(first.implementation.version.length > 0 && first.implementation.version.length <= 128);
  assert.match(first.implementation.configurationSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(first.streams.some((stream) => stream.type === "video" && stream.width && stream.height));
  assert.ok(first.streams.every((stream) => !stream.timeBase || BigInt(stream.timeBase.denominator) > 0n));
  await assert.rejects(probeProjectMedia(root, "../examples/media/demo.mp4"), (error) => error instanceof CutProjectError && error.code === "CUTP1004");
  await assert.rejects(probeProjectMedia(root, "media/demo.mp4", { maxFileBytes: 1 }), (error) => error instanceof CutProjectError && error.code === "CUTP2006");
  await assert.rejects(probeProjectMedia(root, "media/demo.mp4", { timeoutMs: Number.POSITIVE_INFINITY }), (error) => error instanceof CutProjectError && error.code === "CUTP2007");
});

test("media probe refuses an in-place mutation instead of returning mixed metadata", { timeout: 30_000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "cut-probe-mutate-"));
  const root = join(parent, "project");
  const media = join(root, "media/demo.mp4");
  await createCutProject(root, "Mutation Proof");
  await copyFile(resolve("examples/media/demo.mp4"), media);
  await truncate(media, 128 * 1024 * 1024);

  const writer = await open(media, "r+");
  try {
    const refusal = assert.rejects(
      probeProjectMedia(root, "media/demo.mp4"),
      (error) => error instanceof CutProjectError && error.code === "CUTP2009",
    );
    const mutation = (async () => {
      await delay(5);
      for (let index = 0; index < 40; index += 1) {
        await writer.write(Buffer.from([index % 2]), 0, 1, 64 * 1024 * 1024);
        await delay(1);
      }
      await writer.sync();
    })();
    await Promise.all([refusal, mutation]);
  } finally {
    await writer.close();
  }
});

test("media probe refuses pathname replacement after snapshot acquisition", { timeout: 30_000, skip: process.platform === "win32" ? "open-file replacement is not portable on Windows" : false }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "cut-probe-replace-"));
  const root = join(parent, "project");
  const media = join(root, "media/demo.mp4");
  const replacement = join(root, "media/replacement.mp4");
  await createCutProject(root, "Replacement Proof");
  await Promise.all([
    copyFile(resolve("examples/media/demo.mp4"), media),
    copyFile(resolve("examples/media/demo.mp4"), replacement),
  ]);
  await Promise.all([
    truncate(media, 128 * 1024 * 1024),
    truncate(replacement, 128 * 1024 * 1024),
  ]);

  const refusal = assert.rejects(
    probeProjectMedia(root, "media/demo.mp4"),
    (error) => error instanceof CutProjectError && error.code === "CUTP2009",
  );
  await delay(10);
  await rename(replacement, media);
  await refusal;
});
