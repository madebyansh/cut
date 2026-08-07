import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { inspectCutIr } from "../lib/runtime/inspect";

const audioTrackFixture = `cut 0.4;
project "inspect audio editorial items";
import { Sequence, PictureTrack, PictureClip, AudioTrack, AudioRegion } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset picture: VideoAsset = video("media/picture.mov");
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 2s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 2s) {
    Sequence(duration: 2s) {
      PictureTrack() {
        PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "take-processed");
        PictureClip(source: picture, range: 1s ..< 2s, duration: 1s, link: "take-direct");
      }
    }
    AudioTrack() {
      AudioRegion(destination: 0s ..< 1s, link: "take-processed") {
        Gain(amount: -3db) {
          AudioClip(source: voice, range: 4s ..< 5s);
        }
      }
      AudioClip(
        source: voice,
        range: 5s ..< 6s,
        destination: 1s ..< 2s,
        link: "take-direct"
      );
    }
  }
}
export movie = render(main);`;

function inspectAudioTrackFixture(): ReturnType<typeof inspectCutIr> {
  const parsed = parseCutLanguage(audioTrackFixture);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  const report = inspectCutIr(compileCutModule(parsed.module).ir, "audio-editorial.cut");
  return JSON.parse(JSON.stringify(report)) as ReturnType<typeof inspectCutIr>;
}

test("inspect JSON traces a processed AudioRegion item to its exact media leaf and link", () => {
  const report = inspectAudioTrackFixture();
  assert.deepEqual({ format: report.format, version: report.version, status: report.status }, {
    format: "cut-inspect-report",
    version: 1,
    status: "pass",
  });
  const track = report.graph.nodes.find((node) => node.op === "cut.edit.audio_track");
  const region = report.graph.nodes.find((node) => node.op === "cut.edit.audio_region");
  assert.ok(track?.editorial && region);
  assert.equal(track.editorial.kind, "audio-track");
  const item = track.editorial.items.find((candidate) => candidate.nodeId === region.id);
  assert.ok(item?.sourceNodeId);
  assert.equal(item.kind, "audio");
  assert.equal(item.order, 0);
  assert.equal(item.linkId, "take-processed");
  assert.deepEqual(item.destination, {
    start: { numerator: "0", denominator: "1" },
    duration: { numerator: "1", denominator: "1" },
  });
  assert.deepEqual(item.source, {
    start: { numerator: "4", denominator: "1" },
    duration: { numerator: "1", denominator: "1" },
  });
  const leaf = report.graph.nodes.find((node) => node.id === item.sourceNodeId);
  assert.equal(leaf?.op, "cut.audio.clip");
  assert.notEqual(region.children[0], item.sourceNodeId, "sourceNodeId bypasses the processor chain without pretending the region directly owns the leaf");
});

test("inspect JSON identifies a direct AudioClip without inventing a processed-region sourceNodeId", () => {
  const report = inspectAudioTrackFixture();
  const track = report.graph.nodes.find((node) => node.op === "cut.edit.audio_track");
  assert.ok(track?.editorial);
  const direct = track.editorial.items.find((item) => item.linkId === "take-direct");
  assert.ok(direct);
  assert.equal(direct.kind, "audio");
  assert.equal(direct.order, 1);
  assert.equal(Object.hasOwn(direct, "sourceNodeId"), false);
  assert.deepEqual(direct.destination, {
    start: { numerator: "1", denominator: "1" },
    duration: { numerator: "1", denominator: "1" },
  });
  assert.deepEqual(direct.source, {
    start: { numerator: "5", denominator: "1" },
    duration: { numerator: "1", denominator: "1" },
  });
  assert.equal(report.graph.nodes.find((node) => node.id === direct.nodeId)?.op, "cut.audio.clip");
  assert.ok(report.graph.nodes.filter((node) => node.op !== "cut.edit.audio_track").every((node) => !Object.hasOwn(node, "editorial")));
});

test("installed cut inspect --json publishes the AudioTrack editorial projection", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "cut-inspect-audio-track-"));
  try {
    const program = resolve(workspace, "audio-editorial.cut");
    await writeFile(program, audioTrackFixture);
    const result = spawnSync(process.execPath, [resolve("dist-cli/cli/cut.js"), "inspect", program, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout) as ReturnType<typeof inspectCutIr>;
    const track = report.graph.nodes.find((node) => node.op === "cut.edit.audio_track");
    assert.ok(track?.editorial);
    assert.deepEqual(track.editorial.items.map((item) => item.linkId), ["take-processed", "take-direct"]);
    assert.ok(track.editorial.items[0].sourceNodeId);
    assert.equal(Object.hasOwn(track.editorial.items[1], "sourceNodeId"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
