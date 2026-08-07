import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRSignal } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan, cutSignalContentHash, type IncrementalRenderPlan } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";

const source = `cut 0.4;
project "audio-reactive cache locality";
import { Group, Rect } from "cut:visual";
import { AudioClip, Bus, Gain } from "@cut/audio";
import { AmplitudeEnvelope, mapNumber } from "@cut/data";
asset score: AudioAsset = audio("assets/score.wav");
timeline main(duration: 2s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene proof(duration: 2s) {
    let energy: Signal<Ratio> = AmplitudeEnvelope(source: score, range: 0s ..< 2s, at: 0s, detector: "rms", window: 20ms, hop: 10ms, attack: 20ms, release: 100ms, floor: 1%, ceiling: 90%);
    Rect(width: 640px, height: 360px, x: 320px, y: 180px, fill: #101820) as background;
    Group(scale: 1) as pulse { Rect(width: 80px, height: 80px, fill: #ff4d67); }
    set pulse.scale = mapNumber(energy, from: 1, to: 1.2);
    Bus(name: "mix", role: "music") { Gain(amount: -6db) { AudioClip(source: score, range: 0s ..< 2s); } }
  }
}
export out = render(main);`;

function compileLocked(): CutAVIR {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  const resource = ir.resources.score;
  resource.state = "locked";
  resource.sha256 = "1".repeat(64);
  resource.metadata = {
    lockVersion: 2,
    bytes: 192_044,
    probe: {
      kind: "media",
      identity: {
        format: "cut-media-probe",
        version: 1,
        implementation: { name: "ffprobe", version: "7.1" },
        file: { locator: resource.locator, basename: "score.wav", bytes: 192_044, sha256: resource.sha256 },
        container: { names: ["wav"], duration: rational(2) },
        streams: [{
          index: 0,
          type: "audio",
          codec: "pcm_s16le",
          timeBase: rational(1, 48_000),
          duration: rational(2),
          sampleRate: 48_000,
          channels: 2,
          channelLayout: "stereo",
          disposition: ["default"],
        }],
        chapters: [],
      },
      selected: { audio: { streamIndex: 0, duration: rational(2), durationSource: "stream", timeBase: rational(1, 48_000) } },
    },
  };
  return ir;
}

function producer(ir: CutAVIR) {
  const signal = Object.values(ir.signals).find((candidate): candidate is Extract<IRSignal, { kind: "track" }> & { producer: NonNullable<Extract<IRSignal, { kind: "track" }>["producer"]> } => candidate.kind === "track" && candidate.producer !== undefined);
  assert.ok(signal);
  return signal;
}

function op(ir: CutAVIR, native: string) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === native);
  assert.ok(node, native);
  return node;
}

function status(plan: IncrementalRenderPlan, node: IRNode) {
  return plan.nodes.find((entry) => entry.id === node.id)?.status;
}

function after(change: (ir: CutAVIR) => void) {
  const before = compileLocked(), previous = createIncrementalRenderPlan(before, "main").manifest;
  const changed = structuredClone(before);
  change(changed);
  return { changed, plan: createIncrementalRenderPlan(changed, "main", previous) };
}

test("producer source relocks and mapping edits invalidate picture, while mix and unrelated visual edits stay localized", () => {
  const relocked = after((ir) => {
    ir.resources.score.sha256 = "2".repeat(64);
    const metadata = ir.resources.score.metadata as { probe: { identity: { file: { sha256: string } } } };
    metadata.probe.identity.file.sha256 = ir.resources.score.sha256;
  });
  assert.equal(status(relocked.plan, op(relocked.changed, "cut.visual.group")), "miss", "the producer consumer must bind selected locked source bytes");
  assert.ok(relocked.plan.scenes.every((scene) => scene.status === "miss"));

  const remapped = after((ir) => {
    const signal = producer(ir);
    signal.producer.mapping.to = { kind: "quantity", dimension: "scalar", magnitude: rational(13, 10), unit: "scalar" };
    signal.contentHash = cutSignalContentHash(signal);
  });
  assert.equal(status(remapped.plan, op(remapped.changed, "cut.visual.group")), "miss");
  assert.equal(status(remapped.plan, op(remapped.changed, "cut.audio.clip")), "hit");
  assert.equal(status(remapped.plan, op(remapped.changed, "cut.audio.gain")), "hit");

  const remixed = after((ir) => {
    const gain = op(ir, "cut.audio.gain"), amount = gain.inputs.amount;
    assert.equal(amount?.kind, "quantity");
    gain.inputs.amount = { kind: "quantity", dimension: "gain", magnitude: rational(-8), unit: "db" };
  });
  assert.equal(status(remixed.plan, op(remixed.changed, "cut.visual.group")), "hit", "mix-only work must not invalidate audio-driven picture analysis or composition");
  assert.ok(remixed.plan.scenes.every((scene) => scene.status === "hit"));
  assert.equal(status(remixed.plan, op(remixed.changed, "cut.audio.gain")), "miss");

  const restyled = after((ir) => {
    const background = Object.values(ir.nodes).find((node) => node.op === "cut.visual.rect" && node.id !== op(ir, "cut.visual.group").children[0]);
    assert.ok(background);
    background.inputs.fill = { kind: "color", value: "#223344" };
  });
  assert.equal(status(restyled.plan, op(restyled.changed, "cut.visual.group")), "hit", "an unrelated visual root must not invalidate the producer consumer node");
  assert.ok(restyled.plan.scenes.every((scene) => scene.status === "miss"), "the composed scene still changes because the background changed");
});

test("inspect exposes the complete authored producer contract rather than a hidden renderer hint", () => {
  const ir = compileLocked(), signal = producer(ir), report = inspectCutIr(ir, "audio-reactive-cache.cut");
  const inspected = report.graph.signals.find((candidate) => candidate.id === signal.id);
  assert.ok(inspected?.producer);
  assert.deepEqual(inspected.producer, {
    ...signal.producer,
    clock: "composition-sample-analysis-to-scene-local-track",
    preparation: "verified-locked-audio-required",
    authoredIdentity: signal.contentHash,
  });
});
