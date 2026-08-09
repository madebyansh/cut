import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { stableJsonStringify } from "../lib/core/stable";
import { parseCutFootageIndex } from "../lib/footage/contracts";
import { CutFootageError } from "../lib/footage/diagnostics";
import { extractProjectFootage, parseCutFootageHandle } from "../lib/footage/extract";
import { buildCutFootageSearchReport } from "../lib/footage/search";
import { defaultFootageChunkPolicy, planFootageSources } from "../lib/footage/planner";
import { rational } from "../lib/language/rational";
import { createCutProject } from "../lib/project";

function footageCode(code: CutFootageError["code"]) {
  return (error: unknown) => error instanceof CutFootageError && error.code === code;
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

test("footage handles parse canonical exact decimal and rational s/ms text", () => {
  assert.deepEqual(parseCutFootageHandle("0s"), rational(0));
  assert.deepEqual(parseCutFootageHandle("1s"), rational(1));
  assert.deepEqual(parseCutFootageHandle("1250ms"), rational(5, 4));
  assert.deepEqual(parseCutFootageHandle("1.25s"), rational(5, 4));
  assert.deepEqual(parseCutFootageHandle("1001/24000s"), rational(1001, 24000));
  assert.deepEqual(parseCutFootageHandle("1/2ms"), rational(1, 2000));
});

test("footage handles reject negative, noncanonical, control-bearing, and oversized values", () => {
  for (const value of [
    undefined, 1, "", " 1s", "1s ", "-1s", "+1s", "01s", "1.0s", "2/4s", "1/0s",
    "1e3s", "1m", "1\ns", "86400.1s", "86401s", `${"9".repeat(129)}s`,
  ]) {
    assert.throws(() => parseCutFootageHandle(value), footageCode("CUT_FOOTAGE_RANGE"), String(value));
  }
});

const digest = (digit: string) => digit.repeat(64);
const selectedRange = Object.freeze({ semantics: "half-open" as const, start: rational(1), end: rational(2) });
const exec = promisify(execFile);

async function reportFixture(withMatch: boolean) {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-extract-selection-")), "project");
  await createCutProject(root, "Footage extraction selection");
  const source = Object.freeze({
    locator: "media/missing.mp4", bytes: 10, sha256: digest("a"), duration: rational(8), probeSha256: digest("b"),
    streams: Object.freeze([{ index: 0, type: "video" as const, timeBase: rational(1, 30), frameRate: rational(30) }]),
  });
  const chunks = withMatch ? Object.freeze([Object.freeze({
    id: "chunk-main", sourceLocator: source.locator, sourceSha256: source.sha256, streamIndex: 0, range: selectedRange,
  })]) : Object.freeze([]);
  const body = Object.freeze({
    format: "cut-footage-index" as const, version: 1 as const, root: "media", sources: Object.freeze([source]),
    chunkPolicy: Object.freeze({ duration: rational(8), overlap: rational(2) }), chunks,
    backend: Object.freeze({ protocolVersion: 1 as const, provider: "fixture", model: "clip@r1+adapter.abc", dimensions: 4, normalization: "l2" as const }),
    vectorArtifact: Object.freeze({ locator: ".cut/footage/index.vectors", bytes: 16, sha256: digest("c") }),
    creation: Object.freeze({ cutVersion: "0.4.0-test", backendProtocolVersion: 1 as const }),
  });
  const index = parseCutFootageIndex(`${stableJsonStringify({ ...body, indexSha256: createHash("sha256").update(stableJsonStringify(body)).digest("hex") })}\n`);
  const candidates = index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.9 }));
  const search = buildCutFootageSearchReport(index, ".cut/footage/index.json", "dog", candidates, { thresholdPpm: 0, limit: 10 });
  await mkdir(join(root, ".cut/footage"), { recursive: true });
  await Promise.all([
    writeFile(join(root, ".cut/footage/index.json"), `${stableJsonStringify(index)}\n`),
    writeFile(join(root, ".cut/footage/search.json"), search.bytes),
  ]);
  return { root, index, report: search.report };
}

test("footage match selection enforces one exclusive one-based rank or stable id", async () => {
  const fixture = await reportFixture(true);
  const base = { projectRoot: fixture.root, searchLocator: ".cut/footage/search.json", outputLocator: "selects/clip.mp4" };
  for (const selector of [
    {} as never,
    { rank: 0 },
    { rank: 2 },
    { id: "missing" },
    { rank: 1, id: fixture.report.matches[0]!.id } as never,
  ]) {
    await assert.rejects(extractProjectFootage({ ...base, selector }), footageCode("CUT_FOOTAGE_MATCH"));
  }
});

test("a rank against an empty search report is an honest no-match failure", async () => {
  const fixture = await reportFixture(false);
  await assert.rejects(extractProjectFootage({
    projectRoot: fixture.root, searchLocator: ".cut/footage/search.json", outputLocator: "selects/clip.mp4", selector: { rank: 1 },
  }), footageCode("CUT_FOOTAGE_NO_MATCH"));
});

async function workflowFixture(options: Readonly<{
  range?: typeof selectedRange;
  writeSource?: (path: string) => Promise<void>;
}> = {}) {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-extract-workflow-")), "project");
  await createCutProject(root, "Footage extraction workflow");
  const sourcePath = join(root, "media/source.mp4");
  if (options.writeSource) await options.writeSource(sourcePath);
  else await copyFile(resolve("examples/media/demo.mp4"), sourcePath);
  const backend = Object.freeze({
    protocolVersion: 1 as const, provider: "fixture", model: "clip@r1+adapter.abc", dimensions: 4, normalization: "l2" as const,
  });
  const plan = await planFootageSources({ projectRoot: root, locators: ["media/source.mp4"], backend });
  const source = plan.sources[0]!.source;
  const chunk = Object.freeze({ id: "chunk-main", sourceLocator: source.locator, sourceSha256: source.sha256, streamIndex: 0, range: options.range ?? selectedRange });
  const body = Object.freeze({
    format: "cut-footage-index" as const, version: 1 as const, root: "media", sources: Object.freeze([source]),
    chunkPolicy: defaultFootageChunkPolicy, chunks: Object.freeze([chunk]), backend,
    vectorArtifact: Object.freeze({ locator: ".cut/footage/index.vectors", bytes: 16, sha256: digest("c") }),
    creation: Object.freeze({ cutVersion: "0.4.0-test", backendProtocolVersion: 1 as const }),
  });
  const index = parseCutFootageIndex(`${stableJsonStringify({ ...body, indexSha256: createHash("sha256").update(stableJsonStringify(body)).digest("hex") })}\n`);
  const search = buildCutFootageSearchReport(index, ".cut/footage/index.json", "dog", [{ chunkId: chunk.id, score: 0.9 }], { thresholdPpm: 0, limit: 10 });
  await mkdir(join(root, ".cut/footage"), { recursive: true });
  await Promise.all([
    writeFile(join(root, ".cut/footage/index.json"), `${stableJsonStringify(index)}\n`),
    writeFile(join(root, ".cut/footage/search.json"), search.bytes),
  ]);
  return { root, sourcePath: join(root, source.locator), index, search: search.report };
}

async function rewriteSearchRange(fixture: Awaited<ReturnType<typeof workflowFixture>>, range: typeof selectedRange) {
  const selected = fixture.search.matches[0]!;
  const body = Object.freeze({
    format: fixture.search.format, version: fixture.search.version, indexLocator: fixture.search.indexLocator,
    indexSha256: fixture.search.indexSha256, query: fixture.search.query,
    matches: Object.freeze([Object.freeze({ ...selected, sourceSelection: Object.freeze({ ...selected.sourceSelection, range }) })]),
  });
  const searchSha256 = createHash("sha256").update(stableJsonStringify(body)).digest("hex");
  await writeFile(join(fixture.root, ".cut/footage/search.json"), `${stableJsonStringify({ ...body, searchSha256 })}\n`);
}

test("exact extraction reads the held source, trims by frame index, and publishes one canonical candidate pair", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture();
  let encodedArguments: readonly string[] | undefined;
  const options = {
    projectRoot: fixture.root,
    searchLocator: ".cut/footage/search.json",
    outputLocator: "selects/clip.mp4",
    selector: { rank: 1 } as const,
    requestedHandles: Object.freeze({ head: rational(1, 2), tail: rational(1, 2) }),
    __testHooks: { afterEncode(detail: Readonly<{ arguments: readonly string[] }>) { encodedArguments = detail.arguments; } },
  };
  const result = await extractProjectFootage(options);
  assert.equal(result.outputPath, join(await realpath(fixture.root), "selects/clip.mp4"));
  assert.equal(result.manifestPath, `${result.outputPath}.cut-footage.json`);
  assert.equal(result.manifest.label, "candidate-only-not-cut-lock");
  assert.equal(result.manifest.searchSha256, fixture.search.searchSha256);
  assert.equal(result.manifest.indexSha256, fixture.index.indexSha256);
  assert.equal(result.manifest.matchId, fixture.search.matches[0]!.id);
  assert.deepEqual(result.manifest.requestedHandles, { head: rational(1, 2), tail: rational(1, 2) });
  assert.deepEqual(result.manifest.effectiveHandles, { head: rational(1, 2), tail: rational(1, 2) });
  assert.deepEqual(result.manifest.finalRange, { semantics: "half-open", start: rational(1, 2), end: rational(5, 2) });
  assert.deepEqual(result.manifest.output.streams, [{ index: 0, type: "video", codec: "h264" }]);
  assert.equal(result.manifest.output.locator, "selects/clip.mp4");
  const outputBytes = await readFile(result.outputPath), manifestBytes = await readFile(result.manifestPath);
  assert.equal(createHash("sha256").update(outputBytes).digest("hex"), result.manifest.output.sha256);
  assert.equal(outputBytes.byteLength, result.manifest.output.bytes);
  assert.deepEqual(manifestBytes, Buffer.from(`${stableJsonStringify(result.manifest)}\n`));
  assert.match(result.manifest.toolchain.ffmpeg.version, /^ffmpeg version /u);
  assert.match(result.manifest.toolchain.ffprobe.version, /^\d/u);

  assert.ok(encodedArguments);
  assert.ok(encodedArguments.includes("[0:0]trim=start_frame=15:end_frame=75,setpts=PTS-STARTPTS[v]"));
  assert.ok(encodedArguments.includes("[v]") && encodedArguments.includes("-an") && encodedArguments.includes("-sn") && encodedArguments.includes("-dn"));
  assert.ok(encodedArguments.includes("-fs") && encodedArguments.includes(String(8 * 1024 * 1024 * 1024)));
  assert.equal(encodedArguments.some((argument) => argument === "-ss" || argument === "-t" || argument === "copy"), false);
  assert.equal((await readdir(join(fixture.root, "selects"))).some((name) => name.includes("staging")), false);

  const originalHashes = [
    createHash("sha256").update(outputBytes).digest("hex"),
    createHash("sha256").update(manifestBytes).digest("hex"),
  ];
  await assert.rejects(extractProjectFootage(options), footageCode("CUT_FOOTAGE_OUTPUT_EXISTS"));
  assert.deepEqual(await Promise.all([result.outputPath, result.manifestPath].map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex"))), originalHashes);
});

test("stable-id extraction defaults to exact zero handles", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture(), outputLocator = "selects/by-id.mov";
  const result = await extractProjectFootage({
    projectRoot: fixture.root, searchLocator: ".cut/footage/search.json", outputLocator,
    selector: { id: fixture.search.matches[0]!.id },
  });
  assert.deepEqual(result.manifest.requestedHandles, { head: rational(0), tail: rational(0) });
  assert.deepEqual(result.manifest.effectiveHandles, { head: rational(0), tail: rational(0) });
  assert.deepEqual(result.manifest.finalRange, selectedRange);
  assert.equal(result.manifest.matchId, fixture.search.matches[0]!.id);
});

test("source, report, and staged-output drift leave no published extraction or private staging", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  for (const drift of ["source", "report", "output"] as const) {
    const fixture = await workflowFixture(), outputLocator = `selects/${drift}.mp4`;
    await assert.rejects(extractProjectFootage({
      projectRoot: fixture.root, searchLocator: ".cut/footage/search.json", outputLocator, selector: { rank: 1 },
      __testHooks: drift === "source" ? {
        async afterEncode() { await appendFile(fixture.sourcePath, Buffer.from([0])); },
      } : drift === "report" ? {
        async afterVerification() { await writeFile(join(fixture.root, ".cut/footage/search.json"), "{}\n"); },
      } : {
        async afterEncode(detail) { await writeFile(detail.path, "corrupt output"); },
      },
    }), (error: unknown) => error instanceof CutFootageError && (drift === "output" ? error.code === "CUT_FOOTAGE_UNSUPPORTED_MEDIA" : error.code === "CUT_FOOTAGE_INDEX_STALE"));
    await assert.rejects(lstat(join(fixture.root, outputLocator)), isMissing);
    await assert.rejects(lstat(join(fixture.root, `${outputLocator}.cut-footage.json`)), isMissing);
    const selects = await readdir(join(fixture.root, "selects"));
    assert.equal(selects.some((name) => name.includes("staging")), false);
  }
});

test("create-only destination races and publication faults preserve foreign bytes and roll back owned links", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const raced = await workflowFixture(), racedOutput = "selects/raced.mp4";
  await assert.rejects(extractProjectFootage({
    projectRoot: raced.root, searchLocator: ".cut/footage/search.json", outputLocator: racedOutput, selector: { rank: 1 },
    publicationHooks: { async fault(point) {
      if (point.phase === "promotion" && point.timing === "before" && point.role === "footage-output") {
        await writeFile(point.destination, "foreign raced bytes", { flag: "wx" });
      }
    } },
  }), footageCode("CUT_FOOTAGE_OUTPUT_EXISTS"));
  assert.equal(await readFile(join(raced.root, racedOutput), "utf8"), "foreign raced bytes");
  await assert.rejects(lstat(join(raced.root, `${racedOutput}.cut-footage.json`)), isMissing);

  const faulted = await workflowFixture(), faultedOutput = "selects/faulted.mp4";
  await assert.rejects(extractProjectFootage({
    projectRoot: faulted.root, searchLocator: ".cut/footage/search.json", outputLocator: faultedOutput, selector: { rank: 1 },
    publicationHooks: { fault(point) {
      if (point.phase === "promotion" && point.timing === "after" && point.role === "footage-manifest") throw new Error("injected post-link failure");
    } },
  }), footageCode("CUT_FOOTAGE_PUBLISH"));
  await assert.rejects(lstat(join(faulted.root, faultedOutput)), isMissing);
  await assert.rejects(lstat(join(faulted.root, `${faultedOutput}.cut-footage.json`)), isMissing);
});

test("existing clip, manifest, leaf symlink, and parent symlink fail before any overwrite", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  for (const existing of ["clip", "manifest", "symlink"] as const) {
    const fixture = await workflowFixture(), outputLocator = `selects/${existing}.mp4`;
    await mkdir(join(fixture.root, "selects"), { recursive: true });
    const output = join(fixture.root, outputLocator), manifest = `${output}.cut-footage.json`;
    if (existing === "clip") await writeFile(output, "existing clip");
    else if (existing === "manifest") await writeFile(manifest, "existing manifest");
    else {
      const target = join(fixture.root, ".cut/symlink-target"); await writeFile(target, "target"); await symlink(target, output);
    }
    await assert.rejects(extractProjectFootage({
      projectRoot: fixture.root, searchLocator: ".cut/footage/search.json", outputLocator, selector: { rank: 1 },
    }), footageCode("CUT_FOOTAGE_OUTPUT_EXISTS"));
    if (existing === "clip") assert.equal(await readFile(output, "utf8"), "existing clip");
    if (existing === "manifest") assert.equal(await readFile(manifest, "utf8"), "existing manifest");
  }

  const fixture = await workflowFixture(), outside = await mkdtemp(join(tmpdir(), "cut-footage-extract-outside-"));
  await symlink(outside, join(fixture.root, "selects"));
  await assert.rejects(extractProjectFootage({
    projectRoot: fixture.root, searchLocator: ".cut/footage/search.json", outputLocator: "selects/escape.mp4", selector: { rank: 1 },
  }), footageCode("CUT_FOOTAGE_PUBLISH"));
  await assert.rejects(lstat(join(outside, "escape.mp4")), isMissing);

  const sourceLinked = await workflowFixture(), realSource = `${sourceLinked.sourcePath}.real`;
  await rename(sourceLinked.sourcePath, realSource);
  await symlink(realSource, sourceLinked.sourcePath);
  await assert.rejects(extractProjectFootage({
    projectRoot: sourceLinked.root, searchLocator: ".cut/footage/search.json", outputLocator: "selects/source-link.mp4", selector: { rank: 1 },
  }), footageCode("CUT_FOOTAGE_INDEX_STALE"));
  await assert.rejects(lstat(join(sourceLinked.root, "selects/source-link.mp4")), isMissing);
});

test("off-grid and out-of-source selections fail before FFmpeg is bound or launched", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  for (const range of [
    Object.freeze({ semantics: "half-open" as const, start: rational(59, 60), end: rational(2) }),
    Object.freeze({ semantics: "half-open" as const, start: rational(1), end: rational(9) }),
  ]) {
    const fixture = await workflowFixture();
    await rewriteSearchRange(fixture, range);
    await assert.rejects(extractProjectFootage({
      projectRoot: fixture.root, searchLocator: ".cut/footage/search.json", outputLocator: "selects/rejected.mp4", selector: { rank: 1 },
      __testHooks: { ffmpegExecutable: join(fixture.root, "definitely-missing-ffmpeg") },
    }), footageCode("CUT_FOOTAGE_RANGE"));
    await assert.rejects(lstat(join(fixture.root, "selects/rejected.mp4")), isMissing);
  }
});

test("source or report drift during either create-only link rolls back the complete owned pair", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  for (const drift of ["source", "report"] as const) {
    const fixture = await workflowFixture(), outputLocator = `selects/publish-${drift}.mp4`;
    await assert.rejects(extractProjectFootage({
      projectRoot: fixture.root, searchLocator: ".cut/footage/search.json", outputLocator, selector: { rank: 1 },
      publicationHooks: { async fault(point) {
        if (point.phase !== "promotion" || point.timing !== "after" || point.role !== "footage-manifest") return;
        if (drift === "source") await appendFile(fixture.sourcePath, Buffer.from([0]));
        else await writeFile(join(fixture.root, ".cut/footage/search.json"), "{}\n");
      } },
    }), footageCode("CUT_FOOTAGE_INDEX_STALE"));
    await assert.rejects(lstat(join(fixture.root, outputLocator)), isMissing);
    await assert.rejects(lstat(join(fixture.root, `${outputLocator}.cut-footage.json`)), isMissing);
  }
});

test("VFR source cadence is rejected before frame-index trimming can encode the wrong semantic second", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture({
    range: Object.freeze({ semantics: "half-open", start: rational(1), end: rational(2) }),
    async writeSource(path) {
      await exec("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30",
        "-vf", "setpts='if(lt(N,15),N,N+15)'", "-frames:v", "90", "-fps_mode", "vfr",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path,
      ]);
    },
  });
  let encoded = false;
  await assert.rejects(extractProjectFootage({
    projectRoot: fixture.root,
    searchLocator: ".cut/footage/search.json",
    outputLocator: "selects/vfr.mp4",
    selector: { rank: 1 },
    __testHooks: { afterEncode() { encoded = true; } },
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_UNSUPPORTED_MEDIA"
    && error.path === "$.sourceSelection.streamIndex"
    && !error.message.includes(fixture.root));
  assert.equal(encoded, false, "the unsafe frame-index trim must never launch for VFR input");
  await assert.rejects(lstat(join(fixture.root, "selects/vfr.mp4")), isMissing);
});

test("cancellation after every extraction hook and promotion rolls back without publishing", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  for (const phase of ["after-encode", "after-verification", "after-output-link", "after-manifest-link"] as const) {
    const fixture = await workflowFixture(), outputLocator = `selects/cancel-${phase}.mp4`;
    const controller = new AbortController();
    const testHooks: Record<string, unknown> = {};
    let publicationHooks: { fault(point: Readonly<{ phase: string; timing: string; role?: string }>): void } | undefined;
    if (phase === "after-encode") testHooks.afterEncode = () => controller.abort();
    if (phase === "after-verification") testHooks.afterVerification = () => controller.abort();
    if (phase.endsWith("-link")) publicationHooks = { fault(point) {
      const role = phase === "after-output-link" ? "footage-output" : "footage-manifest";
      if (point.phase === "promotion" && point.timing === "after" && point.role === role) controller.abort();
    } };
    await assert.rejects(extractProjectFootage({
      projectRoot: fixture.root,
      searchLocator: ".cut/footage/search.json",
      outputLocator,
      selector: { rank: 1 },
      signal: controller.signal,
      ...(publicationHooks === undefined ? {} : { publicationHooks }),
      __testHooks: testHooks as never,
    }), (error: unknown) => error instanceof CutFootageError
      && error.code === "CUT_FOOTAGE_PUBLISH"
      && error.path === "$signal"
      && !error.message.includes(fixture.root));
    await assert.rejects(lstat(join(fixture.root, outputLocator)), isMissing);
    await assert.rejects(lstat(join(fixture.root, `${outputLocator}.cut-footage.json`)), isMissing);
  }
});

test("cancellation during the native encoder terminates work with the stable signal diagnostic", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture(), controller = new AbortController();
  const fakeFfmpeg = join(fixture.root, ".cut/hanging-ffmpeg.mjs"), marker = join(fixture.root, ".cut/hanging-ffmpeg.started");
  await writeFile(fakeFfmpeg, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "-version") { process.stdout.write("ffmpeg version cut-test\\n"); process.exit(0); }
writeFileSync(process.env.CUT_TEST_FFMPEG_MARKER, "started\\n", { flag: "wx" });
process.on("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);
`, { flag: "wx" });
  await chmod(fakeFfmpeg, 0o755);
  const previousMarker = process.env.CUT_TEST_FFMPEG_MARKER;
  process.env.CUT_TEST_FFMPEG_MARKER = marker;
  try {
    const extraction = extractProjectFootage({
      projectRoot: fixture.root,
      searchLocator: ".cut/footage/search.json",
      outputLocator: "selects/cancel-native.mp4",
      selector: { rank: 1 },
      signal: controller.signal,
      __testHooks: { ffmpegExecutable: fakeFfmpeg },
    });
    const deadline = Date.now() + 5_000;
    while (true) {
      if (await lstat(marker).then(() => true, () => false)) break;
      if (Date.now() > deadline) throw new Error("hanging ffmpeg did not launch");
      await new Promise((accept) => setTimeout(accept, 10));
    }
    controller.abort();
    await assert.rejects(extraction, (error: unknown) => error instanceof CutFootageError
      && error.code === "CUT_FOOTAGE_PUBLISH"
      && error.path === "$signal"
      && !error.message.includes(fixture.root));
  } finally {
    if (previousMarker === undefined) delete process.env.CUT_TEST_FFMPEG_MARKER;
    else process.env.CUT_TEST_FFMPEG_MARKER = previousMarker;
  }
  await assert.rejects(lstat(join(fixture.root, "selects/cancel-native.mp4")), isMissing);
});

test("staging cleanup preserves a replacement directory and hides private filesystem errors", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture();
  let replacementLeaf = "", movedStage = "";
  await assert.rejects(extractProjectFootage({
    projectRoot: fixture.root,
    searchLocator: ".cut/footage/search.json",
    outputLocator: "selects/stage-race.mp4",
    selector: { rank: 1 },
    __testHooks: { async afterVerification(detail) {
      const stage = dirname(detail.path);
      movedStage = `${stage}.owned`;
      await rename(stage, movedStage);
      await mkdir(stage, { mode: 0o700 });
      replacementLeaf = join(stage, "foreign-sentinel");
      await writeFile(replacementLeaf, "preserve foreign stage\n", { flag: "wx" });
      throw new Error(`private cleanup trigger at ${stage}`);
    } },
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_PUBLISH"
    && !error.message.includes(fixture.root)
    && !error.message.includes("private cleanup trigger"));
  assert.equal(await readFile(replacementLeaf, "utf8"), "preserve foreign stage\n");
  await rm(movedStage, { recursive: true, force: true });
});

test("leaf-only staging cleanup preserves a foreign swap after directory identity validation", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture();
  let replacementLeaf = "", movedStage = "", swapped = false;
  await assert.rejects(extractProjectFootage({
    projectRoot: fixture.root,
    searchLocator: ".cut/footage/search.json",
    outputLocator: "selects/stage-post-check-race.mp4",
    selector: { rank: 1 },
    __testHooks: {
      afterVerification() { throw new Error("trigger owned stage cleanup"); },
      async beforeStageCleanup(detail: Readonly<{ path: string }>) {
        movedStage = `${detail.path}.owned`;
        await rename(detail.path, movedStage);
        await mkdir(detail.path, { mode: 0o700 });
        replacementLeaf = join(detail.path, "foreign-sentinel");
        await writeFile(replacementLeaf, "preserve post-check swap\n", { flag: "wx" });
        swapped = true;
      },
    } as never,
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_PUBLISH"
    && !error.message.includes(fixture.root));
  assert.equal(swapped, true, "the deterministic cleanup race hook must run after the first identity check");
  assert.equal(await readFile(replacementLeaf, "utf8"), "preserve post-check swap\n");
  await rm(movedStage, { recursive: true, force: true });
});

test("missing search reports and raw local I/O failures stay inside stable footage diagnostics", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-extract-missing-report-")), "project");
  await createCutProject(root, "Missing extraction report");
  await assert.rejects(extractProjectFootage({
    projectRoot: root,
    searchLocator: ".cut/footage/private-missing-search.json",
    outputLocator: "selects/missing.mp4",
    selector: { rank: 1 },
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_INDEX_STALE"
    && error.path === "$.searchSha256"
    && !error.message.includes(root)
    && !error.message.includes("private-missing-search"));
});

test("empty and invalid report loader failures expose only logical footage paths", async () => {
  for (const [name, bytes] of [["empty", ""], ["malformed", "{\n"], ["invalid", "{}\n"]] as const) {
    const root = join(await mkdtemp(join(tmpdir(), `cut-footage-extract-${name}-report-`)), "project");
    await createCutProject(root, `${name} extraction report`);
    const locator = `.cut/footage/private-${name}-search.json`;
    await mkdir(join(root, ".cut/footage"), { recursive: true });
    await writeFile(join(root, locator), bytes);
    await assert.rejects(extractProjectFootage({
      projectRoot: root,
      searchLocator: locator,
      outputLocator: "selects/invalid.mp4",
      selector: { rank: 1 },
    }), (error: unknown) => error instanceof CutFootageError
      && /^\$(?:$|\.|\[)/u.test(error.path)
      && !error.message.includes(root)
      && !error.message.includes(locator));
  }
});

test("indexed source probes retain the 100 GiB admission bound while encoded outputs remain capped at 8 GiB", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture();
  let observedSourceBytes = 0;
  let encodedArguments: readonly string[] = [];
  await extractProjectFootage({
    projectRoot: fixture.root,
    searchLocator: ".cut/footage/search.json",
    outputLocator: "selects/budgets.mp4",
    selector: { rank: 1 },
    __testHooks: {
      beforeSourceProbe(detail: Readonly<{ maxFileBytes: number }>) { observedSourceBytes = detail.maxFileBytes; },
      afterEncode(detail: Readonly<{ arguments: readonly string[] }>) { encodedArguments = detail.arguments; },
    } as never,
  });
  assert.equal(observedSourceBytes, 100 * 1024 * 1024 * 1024);
  const fsIndex = encodedArguments.indexOf("-fs");
  assert.notEqual(fsIndex, -1);
  assert.equal(encodedArguments[fsIndex + 1], String(8 * 1024 * 1024 * 1024));
});

test("cancellation during a slow multi-chunk source byte probe stops hashing at one read and stays path-free", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture({ async writeSource(path) {
    await copyFile(resolve("examples/media/demo.mp4"), path);
    await truncate(path, 8 * 1024 * 1024);
  } });
  const controller = new AbortController(), probeHandle = await open(fixture.sourcePath, "r");
  const prototype = Object.getPrototypeOf(probeHandle) as object;
  const originalRead = Reflect.get(prototype, "read") as unknown;
  await probeHandle.close();
  assert.equal(typeof originalRead, "function");
  const controlledHandles = new WeakSet<object>();
  let interceptedReads = 0, armed = false, controlledHandleSelected = false;
  try {
    await assert.rejects(extractProjectFootage({
      projectRoot: fixture.root,
      searchLocator: ".cut/footage/search.json",
      outputLocator: "selects/cancel-byte-hash.mp4",
      selector: { rank: 1 },
      signal: controller.signal,
      __testHooks: { beforeSourceProbe() {
        armed = true;
        Reflect.set(prototype, "read", async function(this: unknown, ...args: unknown[]) {
          if (!controlledHandleSelected && typeof this === "object" && this !== null) {
            controlledHandles.add(this);
            controlledHandleSelected = true;
          }
          if (typeof this === "object" && this !== null && controlledHandles.has(this)) {
            interceptedReads += 1;
            if (interceptedReads === 1) {
              await new Promise((accept) => setTimeout(accept, 25));
              controller.abort();
            }
          }
          return Reflect.apply(originalRead as (...values: unknown[]) => unknown, this, args);
        });
      } },
    }), (error: unknown) => error instanceof CutFootageError
      && error.code === "CUT_FOOTAGE_PUBLISH" && error.path === "$signal"
      && !error.message.includes(fixture.root) && !error.message.includes(fixture.sourcePath));
  } finally {
    Reflect.set(prototype, "read", originalRead);
  }
  assert.equal(armed, true);
  assert.equal(interceptedReads, 1, "the cancelled byte probe continued reading source chunks");
  await assert.rejects(lstat(join(fixture.root, "selects/cancel-byte-hash.mp4")), { code: "ENOENT" });
});

test("cancellation during the initial held-source digest stops at one read and leaves no output", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture({ async writeSource(path) {
    await copyFile(resolve("examples/media/demo.mp4"), path);
    await truncate(path, 8 * 1024 * 1024);
  } });
  const sourceMetadata = await lstat(fixture.sourcePath, { bigint: true });
  const controller = new AbortController(), probeHandle = await open(fixture.sourcePath, "r");
  const prototype = Object.getPrototypeOf(probeHandle) as object;
  const originalRead = Reflect.get(prototype, "read") as unknown;
  await probeHandle.close();
  assert.equal(typeof originalRead, "function");
  let interceptedReads = 0;
  try {
    Reflect.set(prototype, "read", async function(this: unknown, ...args: unknown[]) {
      let isSourceHandle = false;
      if (typeof this === "object" && this !== null) {
        const statMethod = Reflect.get(this, "stat") as unknown;
        if (typeof statMethod === "function") {
          const metadata = await Reflect.apply(statMethod as (...values: unknown[]) => unknown, this, [{ bigint: true }]) as typeof sourceMetadata;
          isSourceHandle = metadata.dev === sourceMetadata.dev && metadata.ino === sourceMetadata.ino;
        }
      }
      if (isSourceHandle) {
        interceptedReads += 1;
        if (interceptedReads === 1) {
          await new Promise((accept) => setTimeout(accept, 25));
          controller.abort();
        }
      }
      return Reflect.apply(originalRead as (...values: unknown[]) => unknown, this, args);
    });
    await assert.rejects(extractProjectFootage({
      projectRoot: fixture.root,
      searchLocator: ".cut/footage/search.json",
      outputLocator: "selects/cancel-held-hash.mp4",
      selector: { rank: 1 },
      signal: controller.signal,
    }), (error: unknown) => error instanceof CutFootageError
      && error.code === "CUT_FOOTAGE_PUBLISH" && error.path === "$signal"
      && !error.message.includes(fixture.root) && !error.message.includes(fixture.sourcePath));
  } finally {
    Reflect.set(prototype, "read", originalRead);
  }
  assert.equal(interceptedReads, 1, "the cancelled held-source digest continued reading chunks");
  await assert.rejects(lstat(join(fixture.root, "selects/cancel-held-hash.mp4")), { code: "ENOENT" });
});

test("destination parent replacement is rejected before staging, at each promotion, and after publication without touching foreign sentinels", { timeout: 180_000, skip: process.platform === "win32" }, async () => {
  for (const phase of ["before-stage", "before-output", "before-manifest", "after-publication"] as const) {
    const fixture = await workflowFixture(), outputLocator = `selects/parent-${phase}.mp4`;
    let movedParent = "", sentinel = "", replaced = false;
    const replaceParent = async () => {
      if (replaced) return;
      replaced = true;
      const parent = join(fixture.root, "selects");
      movedParent = `${parent}.owned-${phase}`;
      await rename(parent, movedParent);
      await mkdir(parent, { mode: 0o700 });
      sentinel = join(parent, "foreign-sentinel");
      await writeFile(sentinel, `preserve ${phase}\n`, { flag: "wx" });
    };
    const testHooks: Record<string, unknown> = {};
    if (phase === "before-stage") testHooks.beforeStage = replaceParent;
    if (phase === "after-publication") testHooks.afterPublication = replaceParent;
    const publicationHooks = phase === "before-output" || phase === "before-manifest" ? { async fault(point: Readonly<{ phase: string; timing: string; role?: string }>) {
      const role = phase === "before-output" ? "footage-output" : "footage-manifest";
      if (point.phase === "promotion" && point.timing === "before" && point.role === role) await replaceParent();
    } } : undefined;
    await assert.rejects(extractProjectFootage({
      projectRoot: fixture.root,
      searchLocator: ".cut/footage/search.json",
      outputLocator,
      selector: { rank: 1 },
      ...(publicationHooks === undefined ? {} : { publicationHooks }),
      __testHooks: testHooks as never,
    }), (error: unknown) => error instanceof CutFootageError
      && error.code === "CUT_FOOTAGE_PUBLISH"
      && !error.message.includes(fixture.root));
    assert.equal(await readFile(sentinel, "utf8"), `preserve ${phase}\n`);
    await rm(movedParent, { recursive: true, force: true });
  }
});

test("a foreign destination leaf swapped after publication is preserved and the owned companion is rolled back", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture(), outputLocator = "selects/leaf-after-publication.mp4";
  const outputPath = join(fixture.root, outputLocator), movedOutput = `${outputPath}.owned`;
  await assert.rejects(extractProjectFootage({
    projectRoot: fixture.root,
    searchLocator: ".cut/footage/search.json",
    outputLocator,
    selector: { rank: 1 },
    __testHooks: { async afterPublication() {
      await rename(outputPath, movedOutput);
      await writeFile(outputPath, "foreign destination sentinel\n", { flag: "wx" });
    } } as never,
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_PUBLISH"
    && !error.message.includes(fixture.root));
  assert.equal(await readFile(outputPath, "utf8"), "foreign destination sentinel\n");
  await assert.rejects(lstat(`${outputPath}.cut-footage.json`), isMissing);
  await rm(movedOutput, { force: true });
});

test("held extraction hashing does not accumulate FileHandle close listeners", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await workflowFixture();
  const warnings: Error[] = [];
  const capture = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning" && warning.message.includes("FileHandle")) warnings.push(warning);
  };
  process.on("warning", capture);
  try {
    await extractProjectFootage({
      projectRoot: fixture.root,
      searchLocator: ".cut/footage/search.json",
      outputLocator: "selects/no-listener-leak.mp4",
      selector: { rank: 1 },
    });
    await new Promise<void>((accept) => setImmediate(accept));
  } finally {
    process.off("warning", capture);
  }
  assert.deepEqual(warnings, []);
});
