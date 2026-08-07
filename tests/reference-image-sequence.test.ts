import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

const source = `cut 0.4;
project "typed image sequence";
import { ImageSequence } from "cut:visual";
asset manifest: DataAsset = data("sequence.json");
asset unusedSidecar: DataAsset = data("unused.vtt");
asset red: ImageAsset = image("red.png");
asset blue: ImageAsset = image("blue.png");
timeline main(duration: 1s, fps: 2, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ImageSequence(
      source: imageSequence(
        manifest: manifest,
        frames: [red, blue],
        width: 16px,
        height: 16px,
        frameRate: 2,
        frameCount: 2
      ),
      fit: "fill"
    );
  }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");
`;

function compile() {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  try {
    return compileCutModule(parsed.module).ir;
  } catch (error) {
    if (error instanceof CutCompileError) {
      assert.fail(JSON.stringify(error.result.diagnostics, null, 2));
    }
    throw error;
  }
}

async function fixture(root: string) {
  await writeFile(resolve(root, "unused.vtt"), "WEBVTT\n\nunrelated\n00:00:00.000 --> 00:00:01.000\nNot JSON.\n");
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 220, g: 25, b: 35, alpha: 1 } } })
    .png().toFile(resolve(root, "red.png"));
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 20, g: 45, b: 225, alpha: 1 } } })
    .png().toFile(resolve(root, "blue.png"));
  const red = await readFile(resolve(root, "red.png"));
  const blue = await readFile(resolve(root, "blue.png"));
  const manifest = {
    format: "cut-image-sequence-manifest",
    version: 1,
    width: 16,
    height: 16,
    frameRate: { numerator: "2", denominator: "1" },
    frameCount: 2,
    frames: [
      { resourceId: "red", locator: "red.png", sha256: sha256(red) },
      { resourceId: "blue", locator: "blue.png", sha256: sha256(blue) },
    ],
  };
  await writeFile(resolve(root, "sequence.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { red, blue, manifest };
}

test("manifest-backed ImageSequence skips unrelated data, executes exact ordered members, and repeats deterministically", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-image-sequence-"));
  try {
    await fixture(root);
    const ir = compile();
    const lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const composition = ir.compositions[0]!;
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "cache"));
    await renderer.prepare();
    try {
      const first = await renderer.sceneFrame(scene, 0, false);
      const second = await renderer.sceneFrame(scene, 1, false);
      const repeat = await renderer.sceneFrame(scene, 0, false);
      assert.equal(sha256(first.data), sha256(repeat.data));
      assert.notEqual(sha256(first.data), sha256(second.data));
      assert.ok(first.data[0]! > first.data[2]!, "first ordered member is not red-dominant");
      assert.ok(second.data[2]! > second.data[0]!, "second ordered member is not blue-dominant");
    } finally {
      renderer.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ImageSequence refuses manifest reordering, hostile IR shape, and post-lock member mutation", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-image-sequence-hostile-"));
  try {
    const { manifest } = await fixture(root);
    const reordered = { ...manifest, frames: [...manifest.frames].reverse() };
    await writeFile(resolve(root, "sequence.json"), `${JSON.stringify(reordered, null, 2)}\n`);
    await assert.rejects(
      createCutLock(compile(), root),
      /CUT_IMAGE_SEQUENCE_IDENTITY/u,
    );

    await writeFile(resolve(root, "sequence.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const ir = compile();
    const lock = await createCutLock(ir, root);
    await writeFile(resolve(root, "red.png"), await readFile(resolve(root, "blue.png")));
    await assert.rejects(applyCutLock(compile(), lock, root), /Locked resource bytes changed/u);

    const hostile = structuredClone(ir);
    const sequence = Object.values(hostile.nodes).find((node) => node.op === "cut.visual.image_sequence")!;
    if (sequence.inputs.source?.kind !== "object") throw new Error("missing image sequence source");
    sequence.inputs.source.entries.untrusted = { kind: "string", value: "glob/*.png" };
    assert.throws(() => loadCutAvIr(JSON.stringify(hostile)), /CUT_IMAGE_SEQUENCE_SOURCE/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
