import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseCutLanguage } from "../lib/language/parser";
import { compileCutModule } from "../lib/language/compiler";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { renderReferenceIr } from "./reference-render-test-helper";

const exec = promisify(execFile);

test("reference Video can explicitly hold its final decoded frame", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-hold-"));
  await mkdir(resolve(root, "media"));
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#f97316:s=64x64:r=10:d=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", resolve(root, "media", "short.mp4")]);
  const source = 'cut 0.4; project "hold"; import { Video } from "cut:visual"; asset clip: VideoAsset = video("media/short.mp4"); timeline main(duration: 1s, fps: 10, width: 64px, height: 64px, sampleRate: 48khz) { scene one(duration: 1s) { Video(source: clip, range: 0s ..< 200ms, fit: "cover", endBehavior: "hold"); } } export out = render(main, width: 64px, height: 64px, codec: "h264");';
  await writeFile(resolve(root, "program.cut"), source);
  const parsed = parseCutLanguage(source); assert.ok(parsed.module); assert.deepEqual(parsed.diagnostics, []);
  const ir = compileCutModule(parsed.module).ir, lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  const output = resolve(root, "held.mp4"); const manifest = await renderReferenceIr(ir, root, output, "out");
  assert.equal(manifest.duration, 1); assert.ok((await stat(output)).size > 1_000);
});
