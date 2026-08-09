import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
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

async function workflowFixture() {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-extract-workflow-")), "project");
  await createCutProject(root, "Footage extraction workflow");
  await copyFile(resolve("examples/media/demo.mp4"), join(root, "media/source.mp4"));
  const backend = Object.freeze({
    protocolVersion: 1 as const, provider: "fixture", model: "clip@r1+adapter.abc", dimensions: 4, normalization: "l2" as const,
  });
  const plan = await planFootageSources({ projectRoot: root, locators: ["media/source.mp4"], backend });
  const source = plan.sources[0]!.source;
  const chunk = Object.freeze({ id: "chunk-main", sourceLocator: source.locator, sourceSha256: source.sha256, streamIndex: 0, range: selectedRange });
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
