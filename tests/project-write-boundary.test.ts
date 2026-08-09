import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  atomicWriteFile,
  ensureProjectWriteDirectory,
  publishCreateOnlyStagedFileTransaction,
  publishCreateOnlyStagedFileTransactionForTest,
  publishStagedFileTransaction,
  publishStagedFileTransactionForTest,
  snapshotStagedFileDestination,
  StagedFileTransactionError,
  writeProjectArtifacts,
  type StagedFilePublication,
  type StagedFileTransactionFaultPoint,
} from "../lib/project/write-boundary";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function hasTransactionCode(code: StagedFileTransactionError["code"]) {
  return (error: unknown) => error instanceof StagedFileTransactionError && error.code === code && error.message.startsWith(`${code}:`);
}

type TransactionFixture = Awaited<ReturnType<typeof transactionFixture>>;

async function transactionFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-transaction-"));
  const regularDirectory = resolve(root, "a-delivery");
  const symlinkDirectory = resolve(root, "b-stems");
  const absentDirectory = resolve(root, "c-cache");
  const targetDirectory = resolve(root, "outside-target");
  await Promise.all([regularDirectory, symlinkDirectory, absentDirectory, targetDirectory].map((directory) => mkdir(directory)));
  const regularDestination = resolve(regularDirectory, "movie.mp4");
  const symlinkDestination = resolve(symlinkDirectory, "dialogue.wav");
  const absentDestination = resolve(absentDirectory, "composition.json");
  const symlinkTarget = resolve(targetDirectory, "voice.wav");
  const regularStage = resolve(regularDirectory, ".movie.stage");
  const symlinkStage = resolve(symlinkDirectory, ".dialogue.stage");
  const absentStage = resolve(absentDirectory, ".composition.stage");
  await writeFile(regularDestination, "old movie");
  await writeFile(symlinkTarget, "outside voice");
  await symlink(symlinkTarget, symlinkDestination);
  await writeFile(regularStage, "new movie");
  await writeFile(symlinkStage, "new dialogue");
  await writeFile(absentStage, "new composition");
  const publications: StagedFilePublication[] = [
    { staged: absentStage, destination: absentDestination },
    { staged: symlinkStage, destination: symlinkDestination },
    { staged: regularStage, destination: regularDestination },
  ];
  return {
    root,
    directories: [regularDirectory, symlinkDirectory, absentDirectory],
    publications,
    regularDestination,
    symlinkDestination,
    absentDestination,
    symlinkTarget,
    regularStage,
    symlinkStage,
    absentStage,
  };
}

async function assertTransactionRestored(fixture: TransactionFixture) {
  assert.equal(await readFile(fixture.regularDestination, "utf8"), "old movie");
  assert.equal((await lstat(fixture.symlinkDestination)).isSymbolicLink(), true);
  assert.equal(await readlink(fixture.symlinkDestination), fixture.symlinkTarget);
  assert.equal(await readFile(fixture.symlinkTarget, "utf8"), "outside voice");
  await assert.rejects(lstat(fixture.absentDestination), isMissing);
  assert.equal(await readFile(fixture.regularStage, "utf8"), "new movie");
  assert.equal(await readFile(fixture.symlinkStage, "utf8"), "new dialogue");
  assert.equal(await readFile(fixture.absentStage, "utf8"), "new composition");
  for (const directory of fixture.directories) {
    assert.equal((await readdir(directory)).some((entry) => entry.startsWith(".") && entry.endsWith(".bak")), false);
  }
}

test("project write directories reject pre-existing symlink escapes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-root-"));
  const outside = await mkdtemp(resolve(tmpdir(), "cut-write-outside-"));
  await symlink(outside, resolve(root, ".cut"));
  await assert.rejects(() => ensureProjectWriteDirectory(root, ".cut/cache/reference"), /symlink/);
  await assert.rejects(() => lstat(resolve(outside, "cache")), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
});

test("atomic cache publication replaces a symlink without touching its target", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-atomic-"));
  const outside = await mkdtemp(resolve(tmpdir(), "cut-write-target-"));
  const directory = await ensureProjectWriteDirectory(root, ".cut/cache/reference");
  const target = resolve(outside, "canonical.cut"), destination = resolve(directory, "composition-main.json");
  await writeFile(target, "canonical source");
  await symlink(target, destination);
  await atomicWriteFile(destination, "cache manifest");
  assert.equal(await readFile(target, "utf8"), "canonical source");
  assert.equal(await readFile(destination, "utf8"), "cache manifest");
  assert.equal((await lstat(destination)).isFile(), true);
});

test("create-only staged publication links in canonical order, removes stages, and never overwrites", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-create-only-"));
  const clipStage = resolve(root, ".clip.stage"), manifestStage = resolve(root, ".manifest.stage");
  const clip = resolve(root, "clip.mp4"), manifest = resolve(root, "clip.mp4.cut-footage.json");
  await writeFile(clipStage, "clip bytes"); await writeFile(manifestStage, "manifest bytes");
  const points: StagedFileTransactionFaultPoint[] = [];
  await publishCreateOnlyStagedFileTransactionForTest([
    { staged: manifestStage, destination: manifest, order: 200, role: "footage-manifest" },
    { staged: clipStage, destination: clip, order: 100, role: "footage-output" },
  ], { fault(point) { points.push(point); } });
  assert.equal(await readFile(clip, "utf8"), "clip bytes");
  assert.equal(await readFile(manifest, "utf8"), "manifest bytes");
  await assert.rejects(lstat(clipStage), isMissing); await assert.rejects(lstat(manifestStage), isMissing);
  assert.deepEqual(points.map((point) => `${point.phase}:${point.timing}:${point.role}`), [
    "promotion:before:footage-output", "promotion:after:footage-output",
    "promotion:before:footage-manifest", "promotion:after:footage-manifest",
  ]);

  const retryClip = resolve(root, ".retry-clip.stage"), retryManifest = resolve(root, ".retry-manifest.stage");
  await writeFile(retryClip, "replacement"); await writeFile(retryManifest, "replacement manifest");
  await assert.rejects(publishCreateOnlyStagedFileTransaction([
    { staged: retryClip, destination: clip }, { staged: retryManifest, destination: manifest },
  ]), hasTransactionCode("CUT_PUBLISH_EXISTS"));
  assert.equal(await readFile(clip, "utf8"), "clip bytes");
  assert.equal(await readFile(manifest, "utf8"), "manifest bytes");
  assert.equal(await readFile(retryClip, "utf8"), "replacement");
});

test("create-only destination races and injected link faults roll back only transaction-owned inodes", async () => {
  for (const faultRole of ["footage-output", "footage-manifest"] as const) {
    const root = await mkdtemp(resolve(tmpdir(), "cut-write-create-race-"));
    const clipStage = resolve(root, ".clip.stage"), manifestStage = resolve(root, ".manifest.stage");
    const clip = resolve(root, "clip.mp4"), manifest = resolve(root, "clip.mp4.cut-footage.json");
    await writeFile(clipStage, "clip bytes"); await writeFile(manifestStage, "manifest bytes");
    const raced = faultRole === "footage-output" ? clip : manifest;
    await assert.rejects(publishCreateOnlyStagedFileTransactionForTest([
      { staged: clipStage, destination: clip, order: 100, role: "footage-output" },
      { staged: manifestStage, destination: manifest, order: 200, role: "footage-manifest" },
    ], { async fault(point) {
      if (point.phase === "promotion" && point.timing === "before" && point.role === faultRole) await writeFile(raced, "raced bytes", { flag: "wx" });
    } }), hasTransactionCode("CUT_PUBLISH_EXISTS"));
    assert.equal(await readFile(raced, "utf8"), "raced bytes");
    const other = raced === clip ? manifest : clip;
    await assert.rejects(lstat(other), isMissing);
    assert.equal(await readFile(clipStage, "utf8"), "clip bytes");
    assert.equal(await readFile(manifestStage, "utf8"), "manifest bytes");
  }

  const root = await mkdtemp(resolve(tmpdir(), "cut-write-create-fault-"));
  const firstStage = resolve(root, ".first.stage"), secondStage = resolve(root, ".second.stage");
  const first = resolve(root, "first.mp4"), second = resolve(root, "second.json");
  await writeFile(firstStage, "first"); await writeFile(secondStage, "second");
  await assert.rejects(publishCreateOnlyStagedFileTransactionForTest([
    { staged: firstStage, destination: first, order: 100 }, { staged: secondStage, destination: second, order: 200 },
  ], { fault(point) { if (point.phase === "promotion" && point.timing === "after" && point.index === 1) throw new Error("fault after second link"); } }), hasTransactionCode("CUT_PUBLISH_COMMIT"));
  await assert.rejects(lstat(first), isMissing); await assert.rejects(lstat(second), isMissing);
  assert.equal(await readFile(firstStage, "utf8"), "first"); assert.equal(await readFile(secondStage, "utf8"), "second");
});

test("create-only rollback detects inode substitution and preserves the unrelated replacement", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-create-substitution-"));
  const stage = resolve(root, ".clip.stage"), destination = resolve(root, "clip.mp4");
  await writeFile(stage, "owned");
  await assert.rejects(publishCreateOnlyStagedFileTransactionForTest([
    { staged: stage, destination, role: "footage-output" },
  ], { async fault(point) {
    if (point.phase === "promotion" && point.timing === "after") {
      await rm(destination); await writeFile(destination, "unrelated replacement");
      throw new Error("force rollback after substitution");
    }
  } }), hasTransactionCode("CUT_PUBLISH_ROLLBACK"));
  assert.equal(await readFile(destination, "utf8"), "unrelated replacement");
  assert.equal(await readFile(stage, "utf8"), "owned");
});

test("staged-file transaction publishes in canonical order and replaces a leaf symlink without touching its target", async () => {
  const fixture = await transactionFixture();
  try {
    const points: StagedFileTransactionFaultPoint[] = [];
    await publishStagedFileTransactionForTest(fixture.publications, { fault: async (point) => {
      points.push(point);
      if (point.phase === "backup" && point.timing === "after") {
        const entries = await readdir(dirname(point.destination));
        assert.ok(entries.some((entry) => entry.startsWith(`.${basename(point.destination)}.cut-`) && entry.endsWith(".bak")), "backup must be a hidden destination sibling");
      }
    } });
    assert.equal(await readFile(fixture.regularDestination, "utf8"), "new movie");
    assert.equal(await readFile(fixture.symlinkDestination, "utf8"), "new dialogue");
    assert.equal((await lstat(fixture.symlinkDestination)).isFile(), true);
    assert.equal(await readFile(fixture.absentDestination, "utf8"), "new composition");
    assert.equal(await readFile(fixture.symlinkTarget, "utf8"), "outside voice");
    await Promise.all([fixture.regularStage, fixture.symlinkStage, fixture.absentStage].map((path) => assert.rejects(lstat(path), isMissing)));
    assert.deepEqual(points.map((point) => `${point.phase}:${point.timing}:${point.index}:${basename(point.destination)}`), [
      "backup:before:0:movie.mp4",
      "backup:after:0:movie.mp4",
      "backup:before:1:dialogue.wav",
      "backup:after:1:dialogue.wav",
      "promotion:before:0:movie.mp4",
      "promotion:after:0:movie.mp4",
      "promotion:before:1:dialogue.wav",
      "promotion:after:1:dialogue.wav",
      "promotion:before:2:composition.json",
      "promotion:after:2:composition.json",
    ]);
    for (const directory of fixture.directories) {
      assert.equal((await readdir(directory)).some((entry) => entry.endsWith(".bak")), false);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("explicit publication order includes rollback-safe removals without promoting a removal", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-ordered-removal-"));
  try {
    const output = resolve(root, "movie.mp4"), manifest = resolve(root, "movie.mp4.manifest.json"), stale = resolve(root, "old-music.wav");
    const outputStage = resolve(root, ".movie.stage"), manifestStage = resolve(root, ".manifest.stage");
    await writeFile(output, "old movie"); await writeFile(stale, "old music");
    await writeFile(outputStage, "new movie"); await writeFile(manifestStage, "new manifest");
    const points: StagedFileTransactionFaultPoint[] = [];
    await publishStagedFileTransactionForTest([
      { staged: manifestStage, destination: manifest, order: 1_000, role: "render-manifest" },
      { action: "remove", destination: stale, order: 200, role: "stale-stem:old-music.wav" },
      { staged: outputStage, destination: output, order: 500, role: "render-output" },
    ], { fault(point) { points.push(point); } });
    assert.equal(await readFile(output, "utf8"), "new movie");
    assert.equal(await readFile(manifest, "utf8"), "new manifest");
    await assert.rejects(lstat(stale), isMissing);
    assert.deepEqual(points.filter((point) => point.phase === "promotion" && point.timing === "before").map(({ role, order, action }) => ({ role, order, action })), [
      { role: "render-output", order: 500, action: "replace" },
      { role: "render-manifest", order: 1_000, action: "replace" },
    ]);
    assert.ok(points.some((point) => point.phase === "backup" && point.role === "stale-stem:old-music.wav" && point.action === "remove"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a later promotion fault restores an earlier transactional removal", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-removal-rollback-"));
  try {
    const output = resolve(root, "movie.mp4"), manifest = resolve(root, "movie.mp4.manifest.json"), stale = resolve(root, "old-music.wav");
    const outputStage = resolve(root, ".movie.stage"), manifestStage = resolve(root, ".manifest.stage");
    await writeFile(output, "old movie"); await writeFile(stale, "old music");
    await writeFile(outputStage, "new movie"); await writeFile(manifestStage, "new manifest");
    await assert.rejects(publishStagedFileTransactionForTest([
      { action: "remove", destination: stale, order: 200, role: "stale-stem:old-music.wav" },
      { staged: outputStage, destination: output, order: 500, role: "render-output" },
      { staged: manifestStage, destination: manifest, order: 1_000, role: "render-manifest" },
    ], { fault(point) { if (point.phase === "promotion" && point.timing === "before" && point.role === "render-manifest") throw new Error("injected final marker failure"); } }), hasTransactionCode("CUT_PUBLISH_COMMIT"));
    assert.equal(await readFile(output, "utf8"), "old movie");
    assert.equal(await readFile(stale, "utf8"), "old music");
    await assert.rejects(lstat(manifest), isMissing);
    assert.equal(await readFile(outputStage, "utf8"), "new movie");
    assert.equal(await readFile(manifestStage, "utf8"), "new manifest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every backup and promotion fault restores all prior destinations and removes every promoted file", async () => {
  const injectedPoints = [
    ...([0, 1] as const).flatMap((index) => (["before", "after"] as const).map((timing) => ({ phase: "backup" as const, timing, index }))),
    ...([0, 1, 2] as const).flatMap((index) => (["before", "after"] as const).map((timing) => ({ phase: "promotion" as const, timing, index }))),
  ];
  for (const injected of injectedPoints) {
    const fixture = await transactionFixture();
    try {
      await assert.rejects(
        publishStagedFileTransactionForTest(fixture.publications, {
          fault(point) {
            if (point.phase === injected.phase && point.timing === injected.timing && point.index === injected.index) {
              const failure = new Error(`injected ${point.phase} ${point.timing} ${point.index}`) as Error & { code: string };
              failure.code = "EIO";
              throw failure;
            }
          },
        }),
        hasTransactionCode("CUT_PUBLISH_COMMIT"),
        `${injected.phase}:${injected.timing}:${injected.index}`,
      );
      await assertTransactionRestored(fixture);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("transaction preflight rejects duplicate and case-fold-colliding destinations without moving a staged file", async () => {
  for (const names of [["movie.mp4", "movie.mp4"], ["Movie.mp4", "movie.mp4"], ["caf\u00e9.wav", "cafe\u0301.wav"]] as const) {
    const root = await mkdtemp(resolve(tmpdir(), "cut-write-collision-"));
    try {
      const firstStage = resolve(root, "first.stage"), secondStage = resolve(root, "second.stage");
      await writeFile(firstStage, "first"); await writeFile(secondStage, "second");
      await assert.rejects(
        publishStagedFileTransaction([
          { staged: firstStage, destination: resolve(root, names[0]) },
          { staged: secondStage, destination: resolve(root, names[1]) },
        ]),
        hasTransactionCode("CUT_PUBLISH_PREFLIGHT"),
      );
      assert.equal(await readFile(firstStage, "utf8"), "first");
      assert.equal(await readFile(secondStage, "utf8"), "second");
      await assert.rejects(lstat(resolve(root, names[0])), isMissing);
      if (names[0] !== names[1]) await assert.rejects(lstat(resolve(root, names[1])), isMissing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("transaction preflight requires unique regular stages, direct directory parents, regular-or-symlink leaves, and one device", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-preflight-"));
  const outside = await mkdtemp(resolve(tmpdir(), "cut-write-preflight-outside-"));
  try {
    await assert.rejects(publishStagedFileTransaction([]), hasTransactionCode("CUT_PUBLISH_PREFLIGHT"));
    const stage = resolve(root, "stage.tmp"), otherStage = resolve(root, "other.tmp"), stageDirectory = resolve(root, "stage-directory");
    await writeFile(stage, "stage"); await writeFile(otherStage, "other"); await mkdir(stageDirectory);
    await assert.rejects(
      publishStagedFileTransaction([{ staged: stageDirectory, destination: resolve(root, "directory-stage.mp4") }]),
      hasTransactionCode("CUT_PUBLISH_PREFLIGHT"),
    );

    const stageTarget = resolve(root, "stage-target.tmp"), stageLink = resolve(root, "stage-link.tmp");
    await writeFile(stageTarget, "target"); await symlink(stageTarget, stageLink);
    await assert.rejects(
      publishStagedFileTransaction([{ staged: stageLink, destination: resolve(root, "symlink-stage.mp4") }]),
      hasTransactionCode("CUT_PUBLISH_PREFLIGHT"),
    );

    const destinationDirectory = resolve(root, "destination-directory"); await mkdir(destinationDirectory);
    await assert.rejects(
      publishStagedFileTransaction([{ staged: stage, destination: destinationDirectory }]),
      hasTransactionCode("CUT_PUBLISH_PREFLIGHT"),
    );
    if (process.platform !== "win32") {
      await assert.rejects(
        publishStagedFileTransaction([{ staged: stage, destination: "/dev/null" }]),
        (error: unknown) => error instanceof StagedFileTransactionError
          && error.code === "CUT_PUBLISH_PREFLIGHT"
          && /directories and devices are refused/.test(error.message),
      );
    }

    const regularParent = resolve(root, "regular-parent"); await writeFile(regularParent, "not a directory");
    await assert.rejects(
      publishStagedFileTransaction([{ staged: stage, destination: resolve(regularParent, "child.mp4") }]),
      hasTransactionCode("CUT_PUBLISH_PREFLIGHT"),
    );

    const linkedParent = resolve(root, "linked-parent"); await symlink(outside, linkedParent);
    await assert.rejects(
      publishStagedFileTransaction([{ staged: stage, destination: resolve(linkedParent, "escaped.mp4") }]),
      hasTransactionCode("CUT_PUBLISH_PREFLIGHT"),
    );
    await assert.rejects(lstat(resolve(outside, "escaped.mp4")), isMissing);

    await assert.rejects(
      publishStagedFileTransaction([
        { staged: stage, destination: resolve(root, "one.mp4") },
        { staged: stage, destination: resolve(root, "two.mp4") },
      ]),
      hasTransactionCode("CUT_PUBLISH_PREFLIGHT"),
    );

    await assert.rejects(
      publishStagedFileTransactionForTest([{ staged: otherStage, destination: resolve(root, "different-device.mp4") }], {
        device(_path, role, observed) {
          if (role !== "staged") return observed;
          return typeof observed === "bigint" ? observed + 1n : observed + 1;
        },
      }),
      hasTransactionCode("CUT_PUBLISH_PREFLIGHT"),
    );
    assert.equal(await readFile(stage, "utf8"), "stage");
    assert.equal(await readFile(otherStage, "utf8"), "other");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rollback failure is distinct and rollback continues best-effort for the other destinations", async () => {
  const fixture = await transactionFixture();
  try {
    await assert.rejects(
      publishStagedFileTransactionForTest(fixture.publications, {
        fault(point) {
          if (point.phase === "promotion" && point.timing === "after" && point.index === 0) throw new Error("force commit rollback");
          if (point.phase === "rollback-backup" && point.timing === "before" && point.index === 0) {
            const failure = new Error("force incomplete rollback") as Error & { code: string };
            failure.code = "EACCES";
            throw failure;
          }
        },
      }),
      hasTransactionCode("CUT_PUBLISH_ROLLBACK"),
    );
    assert.equal((await lstat(fixture.symlinkDestination)).isSymbolicLink(), true, "later backups must still be restored");
    assert.equal(await readFile(fixture.symlinkTarget, "utf8"), "outside voice");
    await assert.rejects(lstat(fixture.absentDestination), isMissing);
    await assert.rejects(lstat(fixture.regularDestination), isMissing, "the injected failed restore remains explicit rather than being reported as a successful rollback");
    assert.ok((await readdir(resolve(fixture.root, "a-delivery"))).some((entry) => entry.endsWith(".bak")), "failed restore keeps its hidden backup available for inspection");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement rollback never moves or overwrites a foreign inode that raced into either rollback leg", async () => {
  const promotedRoot = await mkdtemp(resolve(tmpdir(), "cut-write-rollback-promoted-race-"));
  try {
    const destination = resolve(promotedRoot, "movie.mp4"), stage = resolve(promotedRoot, ".movie.stage");
    await writeFile(destination, "old movie"); await writeFile(stage, "new movie");
    await assert.rejects(publishStagedFileTransactionForTest([{ staged: stage, destination }], {
      async fault(point) {
        if (point.phase === "promotion" && point.timing === "after") {
          await rm(destination); await writeFile(destination, "foreign movie");
          throw new Error("force rollback after destination substitution");
        }
      },
    }), hasTransactionCode("CUT_PUBLISH_ROLLBACK"));
    assert.equal(await readFile(destination, "utf8"), "foreign movie");
    assert.ok((await readdir(promotedRoot)).some((entry) => entry.endsWith(".bak")), "uncertain old backup must remain recoverable");
  } finally { await rm(promotedRoot, { recursive: true, force: true }); }

  const backupRoot = await mkdtemp(resolve(tmpdir(), "cut-write-rollback-backup-race-"));
  try {
    const destination = resolve(backupRoot, "movie.mp4"), stage = resolve(backupRoot, ".movie.stage");
    await writeFile(destination, "old movie"); await writeFile(stage, "new movie");
    await assert.rejects(publishStagedFileTransactionForTest([{ staged: stage, destination }], {
      async fault(point) {
        if (point.phase === "promotion" && point.timing === "before") throw new Error("force rollback");
        if (point.phase === "rollback-backup" && point.timing === "before") await writeFile(destination, "foreign movie", { flag: "wx" });
      },
    }), hasTransactionCode("CUT_PUBLISH_ROLLBACK"));
    assert.equal(await readFile(destination, "utf8"), "foreign movie");
    assert.ok((await readdir(backupRoot)).some((entry) => entry.endsWith(".bak")), "the verified old inode must not overwrite the foreign destination");
  } finally { await rm(backupRoot, { recursive: true, force: true }); }
});

test("replacement publication accepts optional absent or prior destination CAS snapshots", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-destination-cas-"));
  try {
    const absentDestination = resolve(root, "absent.mp4"), absentStage = resolve(root, ".absent.stage");
    const expectedAbsent = await snapshotStagedFileDestination(absentDestination);
    await writeFile(absentStage, "candidate"); await writeFile(absentDestination, "raced");
    await assert.rejects(publishStagedFileTransaction([{
      staged: absentStage, destination: absentDestination, expectedDestinationSnapshot: expectedAbsent,
    }]), hasTransactionCode("CUT_PUBLISH_PREFLIGHT"));
    assert.equal(await readFile(absentDestination, "utf8"), "raced");
    assert.equal(await readFile(absentStage, "utf8"), "candidate");

    const priorDestination = resolve(root, "prior.mp4"), priorStage = resolve(root, ".prior.stage");
    await writeFile(priorDestination, "prior"); await writeFile(priorStage, "replacement");
    const expectedPrior = await snapshotStagedFileDestination(priorDestination);
    await rm(priorDestination); await writeFile(priorDestination, "foreign");
    await assert.rejects(publishStagedFileTransaction([{
      staged: priorStage, destination: priorDestination, expectedDestinationSnapshot: expectedPrior,
    }]), hasTransactionCode("CUT_PUBLISH_PREFLIGHT"));
    assert.equal(await readFile(priorDestination, "utf8"), "foreign");
    assert.equal(await readFile(priorStage, "utf8"), "replacement");

    const sameInode = await snapshotStagedFileDestination(priorDestination), inodeBefore = (await lstat(priorDestination)).ino;
    await writeFile(priorDestination, "foreign edited through the admitted inode");
    assert.equal((await lstat(priorDestination)).ino, inodeBefore);
    await assert.rejects(publishStagedFileTransaction([{
      staged: priorStage, destination: priorDestination, expectedDestinationSnapshot: sameInode,
    }]), hasTransactionCode("CUT_PUBLISH_PREFLIGHT"));
    assert.equal(await readFile(priorDestination, "utf8"), "foreign edited through the admitted inode");
    assert.equal(await readFile(priorStage, "utf8"), "replacement");

    const current = await snapshotStagedFileDestination(priorDestination);
    await publishStagedFileTransaction([{
      staged: priorStage, destination: priorDestination, expectedDestinationSnapshot: current,
    }]);
    assert.equal(await readFile(priorDestination, "utf8"), "replacement");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production publication verification runs inside the rollback window", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-authority-verifier-"));
  try {
    const destination = resolve(root, "search.json"), stage = resolve(root, ".search.stage");
    await writeFile(destination, "admitted report"); await writeFile(stage, "new report");
    const admitted = await snapshotStagedFileDestination(destination), failure = new Error("authority changed");
    const phases: string[] = [];
    await assert.rejects(publishStagedFileTransaction([{
      staged: stage, destination, expectedDestinationSnapshot: admitted,
    }], (phase) => {
      phases.push(phase);
      if (phase === "before-finalize") throw failure;
    }), (error: unknown) => error === failure);
    assert.deepEqual(phases, ["before-promotion", "before-finalize"]);
    assert.equal(await readFile(destination, "utf8"), "admitted report");
    assert.equal(await readFile(stage, "utf8"), "new report");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project artifact writes propagate the caller's destination CAS snapshot", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-artifact-cas-"));
  try {
    const destination = resolve(root, "search.json"), admitted = await snapshotStagedFileDestination(destination);
    await writeFile(destination, "foreign report");
    await assert.rejects(writeProjectArtifacts([root], [{
      destination, contents: "CUT report", expectedDestinationSnapshot: admitted,
    }]), hasTransactionCode("CUT_PUBLISH_PREFLIGHT"));
    assert.equal(await readFile(destination, "utf8"), "foreign report");
    assert.equal((await readdir(root)).some((entry) => entry.includes(".cut-") && entry.endsWith(".tmp")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project write directory creation refuses an existing regular-file segment", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-write-file-"));
  await mkdir(resolve(root, ".cut"));
  await writeFile(resolve(root, ".cut", "cache"), "not a directory");
  await assert.rejects(() => ensureProjectWriteDirectory(root, ".cut/cache/reference"), /non-directory/);
});

test("reference visual preparation refuses a symlinked cache root", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-visual-cache-root-"));
  const outside = await mkdtemp(resolve(tmpdir(), "cut-visual-cache-outside-"));
  await symlink(outside, resolve(root, "cache"));
  const parsed = parseCutLanguage(`cut 0.4;
project "cache boundary";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px) {
  scene only(duration: 1s) { Rect(width: 32px, height: 32px, fill: #ffffff); }
}
export out = render(main);`);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const ir = compileCutModule(parsed.module).ir; ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await assert.rejects(() => renderer.prepare(), /symlink/);
  renderer.close();
  await assert.rejects(() => lstat(resolve(outside, "sentinel")), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
});
