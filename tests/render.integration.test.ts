import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createMediaIndex, mediaIndexHash } from "../lib/core/indexer";
import { buildArtifact } from "../lib/core/build";
import { renderArtifact } from "../lib/core/render";

test("FFmpeg render burns source-timed captions and emits a sidecar", { timeout: 30_000 }, async () => {
  const index = await createMediaIndex(resolve("examples/media"));
  index.assets[0].transcript = [0, 2, 4, 6].map((start, index) => ({
    id: `t${index + 1}`, start, end: start + 2, text: ["show the result", "then the failure", "prove the breakthrough", "hold the reaction"][index],
    words: ["show", "the", ["result", "failure", "breakthrough", "reaction"][index]].map((word, wordIndex) => ({ start: start + wordIndex * .35, end: start + wordIndex * .35 + .3, word })),
  }));
  index.indexHash = mediaIndexHash(index);
  const source = `project "Caption proof"\nsource "demo.mp4" from "demo.mp4"\nstory "Arc" in 8s:\n hook result before 2s\n beat problem: failure for 2s\n beat proof: breakthrough for 2s\n beat resolution: reaction for 2s\n captions phrase emphasis\n assert source_bounds\nexport landscape 1280x720 in 8s`;
  const build = buildArtifact(source, index);
  const directory = await mkdtemp(join(tmpdir(), "cut-caption-test-"));
  const output = join(directory, "captioned.mp4");
  await renderArtifact(build, index, output);
  assert.ok((await stat(output)).size > 10_000);
  assert.ok((await stat(join(directory, "captioned.srt"))).size > 40);
});
