import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCutProject, CutProjectError } from "../lib/project";
import { discoverProjectFootage } from "../lib/footage/discovery";

async function project() {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-discovery-")), "project");
  await createCutProject(root, "Footage discovery");
  return root;
}

test("footage discovery recursively returns byte-sorted canonical MP4 and MOV locators only", async () => {
  const root = await project();
  await mkdir(join(root, "media/nested"));
  await Promise.all([
    writeFile(join(root, "media/z.MP4"), "z"),
    writeFile(join(root, "media/a.mov"), "a"),
    writeFile(join(root, "media/nested/B.Mov"), "b"),
    writeFile(join(root, "media/nested/ignored.txt"), "ignored"),
  ]);
  assert.deepEqual(await discoverProjectFootage(root, "media"), ["media/a.mov", "media/nested/B.Mov", "media/z.MP4"]);
});

test("footage discovery rejects a symlink anywhere in the requested tree", { skip: process.platform === "win32" }, async () => {
  const root = await project();
  await writeFile(join(root, "media/real.mp4"), "video");
  await symlink(join(root, "media/real.mp4"), join(root, "media/link.mov"));
  await assert.rejects(
    discoverProjectFootage(root, "media"),
    (error) => error instanceof CutProjectError || (error instanceof Error && error.message.includes("symlink")),
  );
});

test("footage discovery refuses project escapes and bounded file count depth and byte budgets", async () => {
  const root = await project();
  await mkdir(join(root, "media/deep"));
  await Promise.all([
    writeFile(join(root, "media/one.mp4"), "12"),
    writeFile(join(root, "media/two.mov"), "34"),
    writeFile(join(root, "media/deep/three.mp4"), "56"),
  ]);
  await assert.rejects(discoverProjectFootage(root, "../outside"), (error) => error instanceof CutProjectError && error.code === "CUTP1004");
  await assert.rejects(discoverProjectFootage(root, "media", { maximumFiles: 1 }), /maximumFiles/u);
  await assert.rejects(discoverProjectFootage(root, "media", { maximumDepth: 0 }), /maximumDepth/u);
  await assert.rejects(discoverProjectFootage(root, "media", { maximumFileBytes: 1 }), /maximumFileBytes/u);
});
