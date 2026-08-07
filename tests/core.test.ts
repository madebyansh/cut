import test from "node:test";
import assert from "node:assert/strict";
import { buildArtifact } from "../lib/core/build";
import { stableJsonStringify, stableStringify } from "../lib/core/stable";
import { diffBuilds } from "../lib/core/diff";
import { validateSemanticPlan } from "../lib/core/planner";
import { createCaptions } from "../lib/core/render";
import type { MediaIndex } from "../lib/types";

const index: MediaIndex = { version: 1, createdAt: "ignored", root: "/tmp", indexHash: "abc", assets: [{ id: "asset", sourceName: "demo.mp4", path: "demo.mp4", sha256: "hash", duration: 8, width: 1280, height: 720, fps: 30, hasAudio: true, scenes: [{ id: "s001", start: 0, end: 2 }, { id: "s002", start: 2, end: 4 }, { id: "s003", start: 4, end: 6 }, { id: "s004", start: 6, end: 8 }] }] };
const source = `project "Test"\nsource "demo.mp4" from "demo.mp4"\nstory "Arc" in 8s:\n hook result before 2s\n beat problem: failure for 2s\n beat proof: success for 2s\n beat resolution: reaction for 2s\n assert source_bounds\nexport landscape 1280x720 in 8s`;

test("stable serialization ignores object key order", () => assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 })));
test("canonical report JSON is stable and follows JSON undefined semantics", () => {
  const encoded = stableJsonStringify({ z: undefined, b: [1, undefined], a: { y: 2, x: undefined } });
  assert.equal(encoded, '{"a":{"y":2},"b":[1,null]}');
  assert.deepEqual(JSON.parse(encoded), { a: { y: 2 }, b: [1, null] });
});
test("identical inputs produce identical build IDs", () => assert.equal(buildArtifact(source, index).buildId, buildArtifact(source, index).buildId));
test("every compiled frame has passing source provenance", () => assert.equal(buildArtifact(source, index).verification.find((item) => item.rule === "source_bounds")?.status, "pass"));
test("source ranges exactly match rendered timeline durations", () => buildArtifact(source, index).clips.forEach((clip) => assert.ok(Math.abs((clip.end - clip.start) - (clip.timelineEnd - clip.timelineStart)) < .001)));
test("semantic diff is empty for identical builds", () => assert.deepEqual(diffBuilds(buildArtifact(source, index), buildArtifact(source, index)), []));
test("semantic planner cannot invent moment IDs", () => assert.throws(() => validateSemanticPlan([{ momentId: "invented", role: "hook", rationale: "x", sourceLine: 4 }], [4], []), /semantically invalid/));
test("captions are derived from source word timestamps", () => {
  const captionIndex: MediaIndex = structuredClone(index);
  captionIndex.assets[0].transcript = [{ id: "t1", start: 0, end: 2, text: "the result is real", words: [{ start: 0, end: .3, word: "the" }, { start: .3, end: .7, word: "result" }, { start: .7, end: 1, word: "is" }, { start: 1, end: 1.4, word: "real" }] }];
  const build = buildArtifact(source.replace("story \"Arc\"", "captions phrase emphasis\nstory \"Arc\""), captionIndex);
  assert.match(createCaptions(build, captionIndex), /the result is real/);
});
test("unused tails of selected moments remain available as coverage", () => {
  const twoScene: MediaIndex = structuredClone(index);
  twoScene.assets[0].scenes = [{ id: "short", start: 0, end: 2 }, { id: "long", start: 2, end: 8 }];
  const twoBeat = `project "Coverage"\nsource "demo.mp4" from "demo.mp4"\nstory "Arc" in 8s:\n hook opening before 4s\n beat resolution: payoff for 4s\nexport landscape 1280x720 in 8s`;
  assert.equal(buildArtifact(twoBeat, twoScene).duration, 8);
});
