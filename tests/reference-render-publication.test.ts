import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { stableJsonStringify } from "../lib/core/stable";
import { StagedFileTransactionError, type StagedFileTransactionFaultPoint } from "../lib/project/write-boundary";
import { ReferenceRenderContractError, renderReferenceIr as renderReferenceIrWithoutTestLock, type ReferenceRenderOptions } from "../lib/runtime/reference/render";
import { renderReferenceIr, testRenderLockSha256 } from "./reference-render-test-helper";
import { ReferenceVerifiedInputSessionError } from "../lib/runtime/reference/verified-input-session";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function program(includeMusic: boolean) {
  return `cut 0.4;
project "Reference publication transaction";
import { Bus, Tone } from "@cut/audio";
timeline main(duration: 250ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  Bus(name: "dialogue") { Tone(frequency: 1khz, duration: 250ms, amplitude: 5%); }
  ${includeMusic ? 'Bus(name: "music") { Tone(frequency: 500hz, duration: 250ms, amplitude: 2%); }' : ""}
  scene canvas(duration: 250ms) {}
}
export out = render(main, width: 64px, height: 64px);`;
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function assertNoPublicationResidue(root: string, stems: string, compositionId: string) {
  const cache = resolve(root, ".cut", "cache", "reference");
  const checks = [
    { directory: root, prefixes: [".cut-render-publication-", ".cut-aac-delivery-"], suffixes: [".bak"] },
    { directory: stems, prefixes: [".cut-stems-"], suffixes: [".bak"] },
    { directory: cache, prefixes: [".cut-composition-publication-"], suffixes: [".bak"] },
  ];
  for (const check of checks) {
    const entries = await readdir(check.directory).catch(() => [] as string[]);
    assert.deepEqual(entries.filter((entry) => check.prefixes.some((prefix) => entry.startsWith(prefix)) || check.suffixes.some((suffix) => entry.endsWith(suffix))), [], `${check.directory} leaked publication staging or backups`);
  }
  assert.equal((await readdir(cache)).some((entry) => entry.startsWith(`.composition-${compositionId}.json.cut-`) && entry.endsWith(".bak")), false);
}

type SeededPublicationSet = Awaited<ReturnType<typeof seedPublicationSet>>;

async function seedPublicationSet(root: string, compositionId: string, outputExists: boolean) {
  const output = resolve(root, "release.mp4"), renderManifest = `${output}.manifest.json`, stems = resolve(root, "stems");
  const cache = resolve(root, ".cut", "cache", "reference"), compositionManifest = resolve(cache, `composition-${compositionId}.json`);
  await mkdir(stems, { recursive: true }); await mkdir(cache, { recursive: true });
  const expected = new Map<string, Buffer | undefined>([
    [output, outputExists ? Buffer.from("old output") : undefined],
    [renderManifest, outputExists ? undefined : Buffer.from("old render manifest")],
    [resolve(stems, "dialogue.wav"), Buffer.from("old dialogue")],
    [resolve(stems, "music.wav"), undefined],
    [resolve(stems, "cut-stems.json"), Buffer.from("old stem manifest")],
    [resolve(stems, "producer-notes.wav"), Buffer.from("untracked sentinel")],
    [compositionManifest, Buffer.from("old composition manifest")],
  ]);
  for (const [path, contents] of expected) if (contents) await writeFile(path, contents);
  return { output, renderManifest, stems, compositionManifest, expected };
}

async function assertPublicationSetRestored(seed: SeededPublicationSet) {
  for (const [path, expected] of seed.expected) {
    if (expected) assert.deepEqual(await readFile(path), expected, `${path} must be restored byte-for-byte`);
    else await assert.rejects(lstat(path), isMissing, `${path} must remain absent`);
  }
}

test("full render refuses missing, malformed, and unknown lock options before touching the project", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-render-lock-contract-"));
  try {
    const ir = compile(program(false)), output = resolve(root, "release.mp4");
    await assert.rejects(
      renderReferenceIrWithoutTestLock(ir, root, output),
      (error) => error instanceof ReferenceRenderContractError && error.code === "CUT_RENDER_OPTION_CONTRACT",
    );
    await assert.rejects(
      renderReferenceIrWithoutTestLock(ir, root, output, undefined, { lockSha256: "A".repeat(64) }),
      (error) => error instanceof ReferenceRenderContractError && error.code === "CUT_RENDER_LOCK_SHA256",
    );
    await assert.rejects(
      renderReferenceIrWithoutTestLock(ir, root, output, undefined, { lockSha256: testRenderLockSha256, hiddenRenderer: true } as unknown as ReferenceRenderOptions),
      (error) => error instanceof ReferenceRenderContractError && error.code === "CUT_RENDER_OPTION_CONTRACT" && /hiddenRenderer/u.test(error.message),
    );
    assert.deepEqual(await readdir(root), [], "render option refusal must happen before cache, staging, or media work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render publication commits final paths, removes only manifest-owned stale stems, and promotes the render manifest last", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-render-publication-success-"));
  try {
    const output = resolve(root, "release.mp4"), stems = resolve(root, "stems");
    const first = compile(program(true));
    await renderReferenceIr(first, root, output, undefined, { stemsDirectory: stems });
    await writeFile(resolve(stems, "producer-notes.wav"), "untracked sentinel");

    const points: StagedFileTransactionFaultPoint[] = [];
    const second = compile(program(false));
    const manifest = await renderReferenceIr(second, root, output, undefined, {
      stemsDirectory: stems,
      __testPublicationHooks: { fault(point) { points.push(point); } },
    });
    assert.equal(manifest.output, "release.mp4");
    assert.deepEqual(manifest.lock, { sha256: testRenderLockSha256 });
    assert.equal(manifest.version, 10);
    assert.ok(manifest.stems);
    assert.deepEqual(
      { directory: manifest.stems.directory, manifest: manifest.stems.manifest, count: manifest.stems.count },
      { directory: "stems", manifest: "stems/cut-stems.json", count: 1 },
    );
    assert.equal(createHash("sha256").update(await readFile(output)).digest("hex"), manifest.sha256);
    await assert.rejects(lstat(resolve(stems, "music.wav")), isMissing);
    assert.equal(await readFile(resolve(stems, "producer-notes.wav"), "utf8"), "untracked sentinel");

    const writtenRender = await readFile(`${output}.manifest.json`, "utf8"), writtenStems = await readFile(resolve(stems, "cut-stems.json"), "utf8");
    assert.equal(createHash("sha256").update(writtenStems).digest("hex"), manifest.stems.manifestSha256);
    const parsedStems = JSON.parse(writtenStems) as { version: number; lock: { sha256: string }; stems: unknown[] };
    assert.equal(parsedStems.version, 5);
    assert.deepEqual(parsedStems.lock, manifest.lock);
    assert.equal(parsedStems.stems.length, manifest.stems.count);
    assert.deepEqual(JSON.parse(writtenRender), JSON.parse(JSON.stringify(manifest)));
    assert.equal(writtenRender.includes(root), false, "adjacent render manifest must not retain its machine-local project root");
    for (const privatePrefix of [".cut-aac-delivery-", ".cut-render-publication-", ".cut-composition-publication-", ".cut-stems-"]) {
      assert.equal(writtenRender.includes(privatePrefix), false);
      assert.equal(writtenStems.includes(privatePrefix), false);
    }

    const promotions = points.filter((point) => point.phase === "promotion" && point.timing === "before");
    const outputPromotion = promotions.find((point) => point.role === "render-output");
    assert.ok(outputPromotion?.staged);
    assert.equal(dirname(dirname(outputPromotion.staged)), dirname(outputPromotion.destination), "AAC proof must remain in a private same-filesystem child directory before publication");
    assert.match(dirname(outputPromotion.staged), /\.cut-aac-delivery-/u);
    assert.equal(promotions.at(-1)?.role, "render-manifest");
    const markerOrder = promotions.at(-1)?.order;
    assert.equal(markerOrder, 1_000);
    assert.ok(promotions.slice(0, -1).every((point) => point.order < markerOrder!));
    const observedPublications = points.filter((point) => point.timing === "before" && (point.phase === "backup" || point.phase === "promotion"));
    assert.ok(observedPublications.some((point) => point.action === "remove" && point.role === "stale-stem:music.wav" && point.order < markerOrder!));
    assert.ok(observedPublications.filter((point) => point.role !== "render-manifest").every((point) => point.order < markerOrder!));
    await assertNoPublicationResidue(root, stems, second.compositions[0].id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changing only the verified lock bytes updates manifest identity without invalidating semantic render caches", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-render-lock-locality-"));
  try {
    const ir = compile(program(false)), stemsDirectory = resolve(root, "stems");
    const first = await renderReferenceIr(ir, root, resolve(root, "first.mp4"), undefined, { stemsDirectory });
    const firstStemManifest = JSON.parse(await readFile(resolve(stemsDirectory, "cut-stems.json"), "utf8")) as { stems: Array<{ sha256: string }> };
    const secondLockSha256 = createHash("sha256").update("different verified lock bytes").digest("hex");
    const second = await renderReferenceIr(ir, root, resolve(root, "second.mp4"), undefined, { lockSha256: secondLockSha256, stemsDirectory });
    assert.equal(first.sha256, second.sha256, "lock serialization alone must not alter deterministic media bytes");
    assert.deepEqual(first.lock, { sha256: testRenderLockSha256 });
    assert.deepEqual(second.lock, { sha256: secondLockSha256 });
    assert.ok(first.stems && second.stems);
    assert.notEqual(first.stems.manifestSha256, second.stems.manifestSha256, "lock-bound stem evidence must change");
    const currentStemManifest = JSON.parse(await readFile(resolve(stemsDirectory, "cut-stems.json"), "utf8")) as { lock: { sha256: string }; stems: Array<{ sha256: string }> };
    assert.deepEqual(currentStemManifest.lock, second.lock);
    assert.deepEqual(currentStemManifest.stems.map((stem) => stem.sha256), firstStemManifest.stems.map((stem) => stem.sha256), "lock evidence must remain outside deterministic stem PCM identity");
    assert.equal(second.cache.misses, 0);
    assert.equal(second.cache.hits, ir.compositions[0].sceneIds.length);
    assert.equal(second.cache.audio.status, "hit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deterministic final-marker promotion fault restores one exact mixed old/absent delivery set", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-render-publication-rollback-"));
  try {
    const ir = compile(program(true)), seed = await seedPublicationSet(root, ir.compositions[0].id, true);
    await assert.rejects(renderReferenceIr(ir, root, seed.output, undefined, {
      stemsDirectory: seed.stems,
      __testPublicationHooks: { fault(point) {
        if (point.phase === "promotion" && point.timing === "before" && point.role === "render-manifest") {
          const error = new Error("injected final commit-marker failure") as Error & { code: string }; error.code = "EIO"; throw error;
        }
      } },
    }), (error) => error instanceof StagedFileTransactionError && error.code === "CUT_PUBLISH_COMMIT");
    await assertPublicationSetRestored(seed);
    await assertNoPublicationResidue(root, seed.stems, ir.compositions[0].id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("final-marker failure restores a valid historical v4 two-route set after authorized stale-stem removal", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-render-stale-removal-rollback-"));
  try {
    const output = resolve(root, "release.mp4"), stems = resolve(root, "stems");
    const first = compile(program(true));
    await renderReferenceIr(first, root, output, undefined, { stemsDirectory: stems });
    const currentStemManifestPath = resolve(stems, "cut-stems.json");
    const historicalV4 = JSON.parse(await readFile(currentStemManifestPath, "utf8")) as Record<string, unknown>;
    historicalV4.version = 4;
    delete historicalV4.lock;
    await writeFile(currentStemManifestPath, `${stableJsonStringify(historicalV4)}\n`);
    const compositionManifest = resolve(root, ".cut", "cache", "reference", `composition-${first.compositions[0].id}.json`);
    const priorPaths = [
      output,
      `${output}.manifest.json`,
      resolve(stems, "dialogue.wav"),
      resolve(stems, "music.wav"),
      resolve(stems, "cut-stems.json"),
      compositionManifest,
    ];
    const prior = new Map(await Promise.all(priorPaths.map(async (path) => [path, await readFile(path)] as const)));
    const priorManifest = JSON.parse((prior.get(resolve(stems, "cut-stems.json"))!).toString("utf8")) as { format: string; version: number; stems: Array<{ file: string }> };
    assert.equal(priorManifest.format, "cut-reference-stems"); assert.equal(priorManifest.version, 4);
    assert.deepEqual(priorManifest.stems.map((stem) => stem.file), ["dialogue.wav", "music.wav"]);
    await writeFile(resolve(stems, "producer-notes.wav"), "untracked sentinel");

    const points: StagedFileTransactionFaultPoint[] = [];
    const second = compile(program(false));
    await assert.rejects(renderReferenceIr(second, root, output, undefined, {
      stemsDirectory: stems,
      __testPublicationHooks: { fault(point) {
        points.push(point);
        if (point.phase === "promotion" && point.timing === "before" && point.role === "render-manifest") throw new Error("injected valid-stale final-marker failure");
      } },
    }), (error) => error instanceof StagedFileTransactionError && error.code === "CUT_PUBLISH_COMMIT");
    assert.ok(points.some((point) => point.phase === "backup" && point.timing === "before" && point.action === "remove" && point.role === "stale-stem:music.wav"), "valid prior v4 ownership must authorize the stale removal inside the failed transaction");
    for (const [path, contents] of prior) assert.deepEqual(await readFile(path), contents, `${path} must be restored byte-identically`);
    assert.equal(await readFile(resolve(stems, "producer-notes.wav"), "utf8"), "untracked sentinel");
    await assertNoPublicationResidue(root, stems, second.compositions[0].id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-AAC and post-stem preparation failures publish nothing and clean private staging", { timeout: 120_000 }, async () => {
  for (const [index, stage] of (["after-aac", "after-stems"] as const).entries()) {
    const root = await mkdtemp(resolve(tmpdir(), `cut-render-preparation-${stage}-`));
    try {
      const ir = compile(program(true)), seed = await seedPublicationSet(root, ir.compositions[0].id, index === 1);
      const publicationPoints: StagedFileTransactionFaultPoint[] = [];
      await assert.rejects(renderReferenceIr(ir, root, seed.output, undefined, {
        stemsDirectory: seed.stems,
        __testPreparationFault(observed) { if (observed === stage) throw new Error(`injected ${stage} failure`); },
        __testPublicationHooks: { fault(point) { publicationPoints.push(point); } },
      }), new RegExp(`injected ${stage} failure`));
      assert.deepEqual(publicationPoints, [], `${stage} must fail before the transaction begins`);
      await assertPublicationSetRestored(seed);
      await assertNoPublicationResidue(root, seed.stems, ir.compositions[0].id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("verified-input cleanup failure preserves prior render output and manifest before publication", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-render-input-cleanup-"));
  let sessionRoot: string | undefined;
  let injected: string | undefined;
  try {
    const ir = compile(program(false)), output = resolve(root, "release.mp4"), manifest = `${output}.manifest.json`;
    const priorOutput = Buffer.from("prior rendered output\n"), priorManifest = Buffer.from("prior render manifest\n");
    await writeFile(output, priorOutput); await writeFile(manifest, priorManifest);
    const publicationPoints: StagedFileTransactionFaultPoint[] = [];

    await assert.rejects(renderReferenceIr(ir, root, output, undefined, {
      async __testBeforeInputCleanup() {
        const cache = resolve(root, ".cut", "cache", "reference");
        const sessions = (await readdir(cache, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && entry.name.startsWith(".cut-inputs-"));
        assert.equal(sessions.length, 1, "one render invocation must own one verified-input session");
        sessionRoot = resolve(cache, sessions[0].name);
        injected = resolve(sessionRoot, "unexpected-residue");
        await writeFile(injected, "injected cleanup obstruction\n", { flag: "wx" });
      },
      __testPublicationHooks: { fault(point) { publicationPoints.push(point); } },
    }), (error: unknown) => error instanceof ReferenceVerifiedInputSessionError
      && error.code === "CUT_INPUT_SESSION_PATH"
      && error.detail.reason === "cleanup-directory-delete");

    assert.deepEqual(publicationPoints, [], "verified-input cleanup must fail before publication begins");
    assert.deepEqual(await readFile(output), priorOutput);
    assert.deepEqual(await readFile(manifest), priorManifest);
    assert.ok(sessionRoot && injected, "the injected private residue must remain available for explicit test cleanup");
    assert.equal(await readFile(injected, "utf8"), "injected cleanup obstruction\n");
    await rm(injected, { force: true });
    await rm(sessionRoot, { recursive: true, force: true });
    assert.equal((await readdir(resolve(root, ".cut", "cache", "reference"))).some((entry) => entry.startsWith(".cut-inputs-")), false);
    await assertNoPublicationResidue(root, resolve(root, "stems"), ir.compositions[0].id);
  } finally {
    if (injected) await rm(injected, { force: true }).catch(() => undefined);
    if (sessionRoot) await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
