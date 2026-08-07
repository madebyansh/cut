import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, recomputeBuildId } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { validateCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR, formatCutAVIRSemanticDiff } from "../lib/language/semantic-diff";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";

function compile(source: string): CutAVIR {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function clone<T>(value: T): T { return structuredClone(value); }

function semanticContractFixture(): CutAVIR {
  const ir = compile(`cut 0.4;
project "semantic-contract";
timeline main(duration: 1s, fps: 24) {
  assert true, "delivery is valid";
}
export movie = render(main);`);
  ir.jobs.push({
    id: "job_semantic_contract",
    effect: "analyze",
    op: "example.analysis.measure",
    inputs: { mode: { kind: "string", value: "dialogue" } },
    state: "unresolved",
    provenance: ir.outputs[0].provenance,
  });
  ir.determinism.semantic = "unlocked";
  recomputeBuildId(ir);
  return validateCutAvIr(ir);
}

function runCut(args: string[]) {
  return spawnSync(process.execPath, [resolve("dist-cli/cli/cut.js"), ...args], { encoding: "utf8" });
}

const trimProgram = (outPoint: number) => `cut 0.4;
project "semantic-trim";
import { Video } from "cut:visual";
asset source: VideoAsset = video("media/source.mp4");
timeline main(duration: 5s, fps: 24) {
  scene edit(duration: 5s) {
    Video(source: source, range: 0s..${outPoint}s);
  }
}
export movie = render(main);`;

const pictureEditProgram = (insertAt: string) => `cut 0.4;
project "semantic-picture-edit";
import { Sequence, PictureTrack, PictureClip, Gap, editGap, rippleInsert } from "@cut/edit";
asset red: VideoAsset = video("media/red.mkv");
asset green: VideoAsset = video("media/green.mkv");
timeline main(duration: 3500ms, fps: 4, width: 64px, height: 64px) {
  scene only(duration: 3500ms) {
    Sequence(duration: 3500ms) {
      PictureTrack(sourceDuration: 3s, edits: [
        rippleInsert(at: ${insertAt}, item: editGap(duration: 500ms))
      ]) {
        PictureClip(source: red, range: 0s ..< 1s, duration: 1s);
        PictureClip(source: green, range: 0s ..< 1s, duration: 1s);
        Gap(duration: 1s);
      }
    }
  }
}
export movie = render(main);`;

const audioEditProgram = (splitAt: string) => `cut 0.4;
project "semantic-audio-edit";
import { AudioTrack, audioSplit } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 1s, edits: [audioSplit(at: ${splitAt})]) {
    AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s);
  }
}
export movie = render(main);`;

const audioCrossfadeProgram = (curve: "equal-power" | "linear") => `cut 0.4;
project "semantic-audio-crossfade";
import { AudioTrack, audioCrossfadeAt } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 2s, fps: 24, sampleRate: 48khz) {
  AudioTrack(sourceDuration: 2s, edits: [
    audioCrossfadeAt(at: 1s, duration: 500ms, curve: "${curve}")
  ]) {
    AudioClip(source: voice, range: 0s ..< 1s,
              destination: 0s ..< 1s, tailHandle: 250ms);
    AudioClip(source: voice, range: 250ms ..< 1250ms,
              destination: 1s ..< 2s, headHandle: 250ms);
  }
}
export movie = render(main);`;

type AudioRegionSemanticProgramOptions = {
  destinationStart?: string;
  destinationEnd?: string;
  sourceStart?: string;
  sourceEnd?: string;
  gain?: string;
  processorOrder?: "gain-highpass" | "highpass-gain";
};

const audioRegionSemanticProgram = ({
  destinationStart = "250ms",
  destinationEnd = "1250ms",
  sourceStart = "2s",
  sourceEnd = "3s",
  gain = "-6db",
  processorOrder = "gain-highpass",
}: AudioRegionSemanticProgramOptions = {}) => {
  const leaf = `AudioClip(source: voice, range: ${sourceStart} ..< ${sourceEnd});`;
  const processors = processorOrder === "gain-highpass"
    ? `Gain(amount: ${gain}) { HighPass(frequency: 80hz) { ${leaf} } }`
    : `HighPass(frequency: 80hz) { Gain(amount: ${gain}) { ${leaf} } }`;
  return `cut 0.4;
project "semantic-audio-region";
import { AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 2s, fps: 24, sampleRate: 48khz) {
  AudioTrack() {
    AudioGap(destination: 0s ..< ${destinationStart});
    AudioRegion(destination: ${destinationStart} ..< ${destinationEnd}) {
      ${processors}
    }
    AudioGap(destination: ${destinationEnd} ..< 2s);
  }
}
export movie = render(main);`;
};

test("CutAVIR semantic diff is empty for identical graphs", () => {
  const before = compile(trimProgram(4));
  const after = clone(before);
  after.sourceHash = "different-source-container-hash";
  after.buildId = "different-build-container-hash";
  after.nodes[Object.keys(after.nodes)[0]].provenance.span.start.offset += 10;
  const diff = diffCutAVIR(before, after);
  assert.deepEqual(diff.changes, []);
  assert.deepEqual(diff.summary, {
    add: 0,
    remove: 0,
    modify: 0,
    total: 0,
    byEntity: {
      ir: { add: 0, remove: 0, modify: 0 },
      composition: { add: 0, remove: 0, modify: 0 },
      scene: { add: 0, remove: 0, modify: 0 },
      node: { add: 0, remove: 0, modify: 0 },
      signal: { add: 0, remove: 0, modify: 0 },
      resource: { add: 0, remove: 0, modify: 0 },
      module: { add: 0, remove: 0, modify: 0 },
      job: { add: 0, remove: 0, modify: 0 },
      output: { add: 0, remove: 0, modify: 0 },
      assertion: { add: 0, remove: 0, modify: 0 },
    },
  });
  assert.equal(formatCutAVIRSemanticDiff(diff), "No semantic audiovisual changes.");
});

test("third-party or unresolved signal valueType remains semantic", () => {
  const source = `cut 0.4;
project "third-party signal diff";
import { ParametricEQ, Tone } from "@cut/audio";
timeline main(duration: 100ms, fps: 100, sampleRate: 48khz) {
  ParametricEQ(gain: 3db) as eq { Tone(frequency: 440hz, duration: 100ms); }
  set eq.q = 2;
}
export out = render(main);`;
  const numberIr = compile(source), eq = Object.values(numberIr.nodes).find((node) => node.op === "cut.audio.eq");
  assert.ok(eq);
  eq.op = "third.party.audio";
  const signalId = Object.keys(numberIr.signals)[0], base = numberIr.signals[signalId];
  numberIr.signals[signalId] = {
    id: base.id,
    kind: "constant",
    valueType: "Number",
    value: { kind: "quantity", dimension: "scalar", magnitude: { numerator: "2", denominator: "1" }, unit: "scalar" },
    contentHash: "",
    provenance: base.provenance,
  };
  numberIr.signals[signalId].contentHash = cutSignalContentHash(numberIr.signals[signalId]);
  finalizeGraphHashes(numberIr);

  const gainIr = clone(numberIr), gainSignal = gainIr.signals[signalId];
  assert.equal(gainSignal.kind, "constant");
  if (gainSignal.kind === "constant") {
    gainSignal.valueType = "Gain";
    gainSignal.value = { kind: "quantity", dimension: "gain", magnitude: { numerator: "2", denominator: "1" }, unit: "db" };
  }
  gainSignal.contentHash = cutSignalContentHash(gainSignal);
  finalizeGraphHashes(gainIr);
  assert.doesNotThrow(() => validateCutAvIr(numberIr));
  assert.doesNotThrow(() => validateCutAvIr(gainIr));

  const diff = diffCutAVIR(numberIr, gainIr), change = diff.changes.find((item) => item.entity === "signal" && item.id === signalId);
  assert.equal(change?.operation, "modify");
  if (change?.operation === "modify") assert.ok(change.fields.some((field) => field.path === "/valueType"), JSON.stringify(change.fields));
});

test("comments and formatting change source identity but not semantic diff", () => {
  const compact = trimProgram(4);
  const respelled = compact
    .replace("cut 0.4;", "// format-only module header\ncut 0.4; // same language")
    .replace('project "semantic-trim";', '\nproject   "semantic-trim"; // same project')
    .replace("timeline main", "// timeline comment\ntimeline main")
    .replace("export movie", "\n// delivery comment\nexport movie");
  const before = compile(compact), after = compile(respelled);
  assert.notEqual(after.sourceHash, before.sourceHash);
  assert.equal(after.buildId, before.buildId);
  assert.deepEqual(diffCutAVIR(before, after).changes, []);
});

test("AudioRegion placement, source range, processing, and processor order remain semantic", () => {
  const source = audioRegionSemanticProgram();
  const respelled = source
    .replace("AudioTrack() {", "// editorial track\n  AudioTrack(\n  ) {")
    .replace(
      "AudioRegion(destination: 250ms ..< 1250ms) {",
      `// one processed take
    AudioRegion(
      destination: 250ms ..< 1250ms
    ) {`,
    )
    .replace("Gain(amount: -6db)", "Gain(\n        // same processing\n        amount: -6db\n      )")
    .replace("export movie", "// same delivery\nexport movie");
  const before = compile(source), formatted = compile(respelled);
  assert.notEqual(before.sourceHash, formatted.sourceHash);
  assert.equal(before.buildId, formatted.buildId);
  assert.deepEqual(diffCutAVIR(before, formatted).changes, []);

  const region = Object.values(before.nodes).find((node) => node.op === "cut.edit.audio_region");
  const track = Object.values(before.nodes).find((node) => node.op === "cut.edit.audio_track");
  const leaf = Object.values(before.nodes).find((node) => node.op === "cut.audio.clip");
  const gain = Object.values(before.nodes).find((node) => node.op === "cut.audio.gain");
  const highPass = Object.values(before.nodes).find((node) => node.op === "cut.audio.highpass");
  assert.ok(region && track && leaf && gain && highPass);

  const moved = compile(audioRegionSemanticProgram({ destinationStart: "500ms", destinationEnd: "1500ms" }));
  const movedDiff = diffCutAVIR(before, moved);
  const movedRegion = movedDiff.changes.find((change) => change.entity === "node" && change.id === region.id);
  const movedTrack = movedDiff.changes.find((change) => change.entity === "node" && change.id === track.id);
  assert.equal(movedRegion?.operation, "modify");
  assert.equal(movedTrack?.operation, "modify");
  if (movedRegion?.operation === "modify" && movedTrack?.operation === "modify") {
    assert.ok(movedRegion.fields.some((field) => field.path.startsWith("/inputs/destination/")), JSON.stringify(movedRegion.fields));
    assert.ok(movedRegion.fields.some((field) => field.path.startsWith("/interval/start/")), JSON.stringify(movedRegion.fields));
    assert.ok(movedTrack.fields.some((field) => field.path.startsWith("/editorial/items/1/destination/")), JSON.stringify(movedTrack.fields));
  }

  const reranged = compile(audioRegionSemanticProgram({ sourceStart: "4s", sourceEnd: "5s" }));
  const rerangedDiff = diffCutAVIR(before, reranged);
  const rerangedLeaf = rerangedDiff.changes.find((change) => change.entity === "node" && change.id === leaf.id);
  const rerangedTrack = rerangedDiff.changes.find((change) => change.entity === "node" && change.id === track.id);
  assert.equal(rerangedLeaf?.operation, "modify");
  assert.equal(rerangedTrack?.operation, "modify");
  if (rerangedLeaf?.operation === "modify" && rerangedTrack?.operation === "modify") {
    assert.ok(rerangedLeaf.fields.some((field) => field.path.startsWith("/inputs/range/start/")), JSON.stringify(rerangedLeaf.fields));
    assert.ok(rerangedLeaf.fields.some((field) => field.path.startsWith("/inputs/range/end/")), JSON.stringify(rerangedLeaf.fields));
    assert.ok(rerangedTrack.fields.some((field) => field.path.startsWith("/editorial/items/1/source/")), JSON.stringify(rerangedTrack.fields));
  }

  const processed = compile(audioRegionSemanticProgram({ gain: "-3db" }));
  const processingChange = diffCutAVIR(before, processed).changes.find((change) => change.entity === "node" && change.id === gain.id);
  assert.equal(processingChange?.operation, "modify");
  if (processingChange?.operation === "modify") {
    assert.ok(processingChange.fields.some((field) => field.path === "/inputs/amount/magnitude/numerator"), JSON.stringify(processingChange.fields));
  }

  const reordered = compile(audioRegionSemanticProgram({ processorOrder: "highpass-gain" }));
  const reorderedRegion = Object.values(reordered.nodes).find((node) => node.op === "cut.edit.audio_region");
  const reorderedGain = Object.values(reordered.nodes).find((node) => node.op === "cut.audio.gain");
  const reorderedHighPass = Object.values(reordered.nodes).find((node) => node.op === "cut.audio.highpass");
  assert.ok(reorderedRegion && reorderedGain && reorderedHighPass);
  assert.equal(reorderedRegion.id, region.id, "the region identity remains stable while its processor topology changes");
  assert.notEqual(reorderedGain.id, gain.id);
  assert.notEqual(reorderedHighPass.id, highPass.id);
  const reorderedDiff = diffCutAVIR(before, reordered);
  const topologyChange = reorderedDiff.changes.find((change) => change.entity === "node" && change.id === region.id);
  assert.equal(topologyChange?.operation, "modify");
  if (topologyChange?.operation === "modify") {
    assert.ok(topologyChange.fields.some((field) => field.path === "/children/0"), JSON.stringify(topologyChange.fields));
  }
  for (const processor of [gain, highPass]) {
    assert.ok(reorderedDiff.changes.some((change) => change.entity === "node" && change.id === processor.id && change.operation === "remove"));
  }
  for (const processor of [reorderedGain, reorderedHighPass]) {
    assert.ok(reorderedDiff.changes.some((change) => change.entity === "node" && change.id === processor.id && change.operation === "add"));
  }
});

test("picture edit plan provenance is invisible but executable operation meaning is not", () => {
  const source = pictureEditProgram("1s");
  const respelled = source.replace(
    "rippleInsert(at: 1s, item: editGap(duration: 500ms))",
    `// exact edit intent
        rippleInsert(
          at: 1s,
          item: editGap(duration: 500ms)
        )`,
  );
  const before = compile(source), formatted = compile(respelled);
  assert.notEqual(before.sourceHash, formatted.sourceHash);
  assert.equal(before.buildId, formatted.buildId);
  assert.deepEqual(diffCutAVIR(before, formatted).changes, []);

  const provenanceOnly = clone(before);
  const provenanceTrack = Object.values(provenanceOnly.nodes).find((node) => node.op === "cut.edit.picture_track");
  assert.ok(provenanceTrack?.editorial?.kind === "picture-track" && provenanceTrack.editorial.operationPlan);
  const provenancePlan = provenanceTrack.editorial.operationPlan;
  provenancePlan.baseItems[0].provenance.span.start.line += 100;
  provenancePlan.operations[0].provenance.span.start.column += 50;
  if ("item" in provenancePlan.operations[0]) provenancePlan.operations[0].item.provenance.span.end.offset += 500;
  assert.deepEqual(diffCutAVIR(before, provenanceOnly).changes, []);

  const changed = compile(pictureEditProgram("1500ms"));
  const beforeTrack = Object.values(before.nodes).find((node) => node.op === "cut.edit.picture_track");
  assert.ok(beforeTrack);
  const diff = diffCutAVIR(before, changed);
  const trackChange = diff.changes.find((change) => change.entity === "node" && change.id === beforeTrack.id);
  assert.equal(trackChange?.operation, "modify");
  if (trackChange?.operation !== "modify") return;
  assert.ok(trackChange.fields.some((field) => field.path === "/editorial/operationPlan/operations/0/at/numerator"));
  assert.ok(trackChange.fields.some((field) => field.path === "/editorial/operationPlan/operations/0/at/denominator"));
  assert.ok(trackChange.fields.every((field) => !field.path.includes("provenance")));
});

test("audio edit history is invisible while materialized operation and crossfade meaning remain semantic", () => {
  const source = audioEditProgram("500ms"), respelled = source.replace(
    "audioSplit(at: 500ms)",
    `// exact native edit intent
    audioSplit(
      at: 500ms
    )`,
  );
  const before = compile(source), formatted = compile(respelled);
  assert.notEqual(before.sourceHash, formatted.sourceHash);
  assert.equal(before.buildId, formatted.buildId);
  assert.deepEqual(diffCutAVIR(before, formatted).changes, []);

  const provenanceOnly = clone(before);
  const provenanceTrack = Object.values(provenanceOnly.nodes).find((node) => node.op === "cut.edit.audio_track");
  assert.ok(provenanceTrack?.editorial?.kind === "audio-track" && provenanceTrack.editorial.operationPlan);
  provenanceTrack.editorial.operationPlan.baseItems[0].provenance.span.start.line += 100;
  provenanceTrack.editorial.operationPlan.baseItems[0].provenance.span.end.line += 100;
  provenanceTrack.editorial.operationPlan.operations[0].provenance.span.start.column += 50;
  provenanceTrack.editorial.operationPlan.operations[0].provenance.span.end.column += 50;
  assert.deepEqual(diffCutAVIR(before, provenanceOnly).changes, []);

  const changed = compile(audioEditProgram("250ms")), beforeTrack = Object.values(before.nodes).find((node) => node.op === "cut.edit.audio_track");
  assert.ok(beforeTrack);
  const trackChange = diffCutAVIR(before, changed).changes.find((change) => change.entity === "node" && change.id === beforeTrack.id);
  assert.equal(trackChange?.operation, "modify");
  if (trackChange?.operation !== "modify") return;
  assert.ok(trackChange.fields.some((field) => field.path.startsWith("/editorial/items/")));
  assert.ok(trackChange.fields.every((field) => !field.path.includes("operationPlan")), JSON.stringify(trackChange.fields));
  assert.ok(trackChange.fields.every((field) => !field.path.includes("provenance")));

  const equalPower = compile(audioCrossfadeProgram("equal-power"));
  const linear = compile(audioCrossfadeProgram("linear"));
  const crossfadeTrack = Object.values(equalPower.nodes).find((node) => node.op === "cut.edit.audio_track");
  assert.ok(crossfadeTrack);
  const crossfadeChange = diffCutAVIR(equalPower, linear).changes.find((change) => change.entity === "node" && change.id === crossfadeTrack.id);
  assert.equal(crossfadeChange?.operation, "modify");
  if (crossfadeChange?.operation !== "modify") return;
  assert.ok(crossfadeChange.fields.some((field) => field.path === "/editorial/transitions/0/curve"), JSON.stringify(crossfadeChange.fields));
  assert.ok(crossfadeChange.fields.every((field) => !field.path.includes("operationPlan") && !field.path.includes("provenance")));
});

test("top-level, effect-job, and assertion semantics are complete and localized", () => {
  const before = semanticContractFixture(), after = clone(before);
  after.compiler = "cut-semantic-diff-test/1";
  after.project = "semantic-contract-revised";
  after.determinism = { semantic: "locked", decodedMedia: "verified", bitstream: "verified" };
  after.timebase.defaultFps = { numerator: "25", denominator: "1" };
  after.timebase.audioSampleRate = 44_100;
  after.jobs[0].state = "locked";
  after.jobs[0].artifactHash = "a".repeat(64);
  after.assertions[0].expression = { kind: "boolean", value: false };
  after.assertions[0].message = "delivery needs repair";
  after.assertions[0].status = "fail";
  recomputeBuildId(after);
  validateCutAvIr(after);

  const diff = diffCutAVIR(before, after);
  assert.equal(diff.version, 2);
  assert.deepEqual(diff.changes.map((change) => [change.entity, change.id, change.operation]), [
    ["ir", "$", "modify"],
    ["job", "job_semantic_contract", "modify"],
    ["assertion", before.assertions[0].id, "modify"],
  ]);
  assert.deepEqual(diff.changes.map((change) => change.operation === "modify" ? change.fields.map((field) => field.path) : []), [
    [
      "/compiler",
      "/determinism/bitstream",
      "/determinism/decodedMedia",
      "/determinism/semantic",
      "/project",
      "/timebase/audioSampleRate",
      "/timebase/defaultFps/numerator",
    ],
    ["/artifactHash", "/state"],
    ["/expression/value", "/message", "/status"],
  ]);
  assert.equal(formatCutAVIRSemanticDiff(diff), [
    "CUT semantic diff: 3 changes (0 added, 0 removed, 3 modified).",
    "~ ir $: /compiler, /determinism/bitstream, /determinism/decodedMedia (+4 more)",
    "~ job job_semantic_contract: /artifactHash, /state",
    `~ assertion ${before.assertions[0].id}: /expression/value, /message, /status`,
  ].join("\n"));
});

test("canonical top-level array order is semantic while record insertion order is not", () => {
  const before = semanticContractFixture(), after = clone(before);
  const secondJob = clone(before).jobs[0];
  secondJob.id = "job_semantic_contract_second";
  before.jobs.push(secondJob);
  after.jobs.push(clone(secondJob));
  after.assertions.push({ ...clone(after).assertions[0], id: "assert_semantic_contract_second" });
  before.assertions.push(clone(after.assertions[1]));
  after.jobs.reverse();
  after.assertions.reverse();
  after.nodes = Object.fromEntries(Object.entries(after.nodes).reverse());
  recomputeBuildId(before);
  recomputeBuildId(after);
  validateCutAvIr(before);
  validateCutAvIr(after);

  const diff = diffCutAVIR(before, after);
  assert.deepEqual(diff.changes.map((change) => [change.entity, change.operation]), [["ir", "modify"]]);
  const change = diff.changes[0];
  assert.equal(change.operation, "modify");
  if (change.operation !== "modify") return;
  assert.deepEqual(change.fields.map((field) => field.path), [
    "/entityOrder/assertions/0",
    "/entityOrder/assertions/1",
    "/entityOrder/jobs/0",
    "/entityOrder/jobs/1",
  ]);
});

test("one source trim produces one localized node modification", () => {
  const diff = diffCutAVIR(compile(trimProgram(4)), compile(trimProgram(3)));
  assert.equal(diff.changes.length, 1);
  const change = diff.changes[0];
  assert.equal(change.entity, "node");
  assert.equal(change.operation, "modify");
  if (change.operation !== "modify") return;
  assert.deepEqual(change.fields, [{
    path: "/inputs/range/end/magnitude/numerator",
    before: "4",
    after: "3",
  }]);
  assert.match(formatCutAVIRSemanticDiff(diff), /^CUT semantic diff: 1 change \(0 added, 0 removed, 1 modified\)\./);
  assert.match(formatCutAVIRSemanticDiff(diff), /~ node .*\/inputs\/range\/end\/magnitude\/numerator/);
});

test("resource locks and package implementation changes are explicit", () => {
  const before = compile(trimProgram(4));
  const after = clone(before);
  after.resources.source.state = "locked";
  after.resources.source.sha256 = "a".repeat(64);
  const visual = after.modules.find((module) => module.specifier === "cut:visual");
  assert.ok(visual);
  visual.version = "0.3.1";
  visual.integrity = "b".repeat(64);

  const diff = diffCutAVIR(before, after);
  assert.deepEqual(diff.changes.map((change) => [change.entity, change.id, change.operation]), [
    ["resource", "source", "modify"],
    ["module", "cut:visual", "modify"],
  ]);
  const resource = diff.changes[0];
  const packageChange = diff.changes[1];
  assert.equal(resource.operation, "modify");
  assert.equal(packageChange.operation, "modify");
  if (resource.operation === "modify" && packageChange.operation === "modify") {
    assert.deepEqual(resource.fields.map((field) => field.path), ["/sha256", "/state"]);
    assert.deepEqual(packageChange.fields.map((field) => field.path), ["/integrity", "/version"]);
  }
});

test("semantic changes and field paths have deterministic ordering", () => {
  const before = compile(`cut 0.4;
project "ordering";
import { Text } from "cut:visual";
asset face: FontAsset = font("fixtures/InterVariable.ttf");
timeline main(duration: 2s, fps: 24) {
  scene one(duration: 2s) {
    Text(content: "A", font: face) as title;
    animate title.opacity from 0% to 100% over 1s;
  }
}
export movie = render(main);`);
  const after = clone(before);
  after.compositions[0].width = 1280;
  Object.values(after.scenes)[0].duration.numerator = "1";
  Object.values(after.nodes)[0].inputs.content = { kind: "string", value: "B" };
  const signal = Object.values(after.signals)[0];
  if (signal.kind !== "track" || signal.events[0].kind !== "animate") assert.fail("expected animation track");
  signal.events[0].end.numerator = "2";
  after.modules[0].integrity = "c".repeat(64);
  after.outputs[0].op = "cut.output.preview";

  const shuffledBefore = clone(before);
  const shuffledAfter = clone(after);
  shuffledBefore.compositions.reverse();
  shuffledAfter.compositions.reverse();
  shuffledBefore.modules.reverse();
  shuffledAfter.modules.reverse();
  shuffledBefore.outputs.reverse();
  shuffledAfter.outputs.reverse();
  shuffledBefore.scenes = Object.fromEntries(Object.entries(shuffledBefore.scenes).reverse());
  shuffledAfter.scenes = Object.fromEntries(Object.entries(shuffledAfter.scenes).reverse());
  shuffledBefore.nodes = Object.fromEntries(Object.entries(shuffledBefore.nodes).reverse());
  shuffledAfter.nodes = Object.fromEntries(Object.entries(shuffledAfter.nodes).reverse());
  shuffledBefore.signals = Object.fromEntries(Object.entries(shuffledBefore.signals).reverse());
  shuffledAfter.signals = Object.fromEntries(Object.entries(shuffledAfter.signals).reverse());

  const expected = diffCutAVIR(before, after);
  assert.deepEqual(diffCutAVIR(shuffledBefore, shuffledAfter), expected);
  assert.deepEqual(expected.changes.map((change) => change.entity), ["composition", "scene", "node", "signal", "module", "output"]);
  assert.deepEqual(expected.changes.flatMap((change) => change.operation === "modify" ? change.fields.map((field) => field.path) : []), [
    "/width",
    "/duration/numerator",
    "/inputs/content/value",
    "/interval/duration/numerator",
    "/events/0/end/numerator",
    "/integrity",
    "/op",
  ]);
});

test("av-diff CLI distinguishes identity, semantic changes, and stable JSON", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-av-diff-cli-"));
  const beforePath = resolve(directory, "before.cutir.json");
  const afterPath = resolve(directory, "after.cutir.json");
  const before = compile(trimProgram(4));
  const after = compile(trimProgram(3));
  await Promise.all([
    writeFile(beforePath, JSON.stringify(before)),
    writeFile(afterPath, JSON.stringify(after)),
  ]);

  const identical = runCut(["av-diff", beforePath, beforePath]);
  assert.equal(identical.status, 0, identical.stderr);
  assert.equal(identical.stdout, "No semantic audiovisual changes.\n");
  assert.equal(identical.stderr, "");

  const changed = runCut(["av-diff", beforePath, afterPath]);
  assert.equal(changed.status, 2, changed.stderr);
  assert.match(changed.stdout, /^CUT semantic diff: 1 change/);
  assert.match(changed.stdout, /\/inputs\/range\/end\/magnitude\/numerator/);
  assert.equal(changed.stderr, "");

  const jsonFirst = runCut(["av-diff", beforePath, afterPath, "--json"]);
  const jsonSecond = runCut(["av-diff", beforePath, afterPath, "--json"]);
  assert.equal(jsonFirst.status, 2, jsonFirst.stderr);
  assert.equal(jsonFirst.stdout, jsonSecond.stdout);
  assert.equal(jsonFirst.stderr, "");
  assert.doesNotMatch(jsonFirst.stdout, /\x1b/);
  const report = JSON.parse(jsonFirst.stdout) as ReturnType<typeof diffCutAVIR>;
  assert.equal(report.format, "cut-av-ir-semantic-diff");
  assert.equal(report.version, 2);
  assert.deepEqual(report.changes.map((change) => [change.entity, change.operation]), [["node", "modify"]]);
});

test("av-diff CLI emits stable comprehensive JSON and human output", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-av-diff-complete-"));
  const beforePath = resolve(directory, "before.cutir.json"), afterPath = resolve(directory, "after.cutir.json");
  const before = semanticContractFixture(), after = clone(before);
  after.project = "semantic-contract-cli";
  after.jobs[0].state = "locked";
  after.jobs[0].artifactHash = "b".repeat(64);
  after.assertions[0].expression = { kind: "boolean", value: false };
  after.assertions[0].status = "fail";
  recomputeBuildId(after);
  validateCutAvIr(after);
  await Promise.all([writeFile(beforePath, JSON.stringify(before, null, 2)), writeFile(afterPath, JSON.stringify(after))]);

  const humanFirst = runCut(["diff", beforePath, afterPath]), humanSecond = runCut(["diff", beforePath, afterPath]);
  assert.equal(humanFirst.status, 2, humanFirst.stderr);
  assert.equal(humanFirst.stdout, humanSecond.stdout);
  assert.equal(humanFirst.stdout, [
    "CUT semantic diff: 3 changes (0 added, 0 removed, 3 modified).",
    "~ ir $: /project",
    "~ job job_semantic_contract: /artifactHash, /state",
    `~ assertion ${before.assertions[0].id}: /expression/value, /status`,
    "",
  ].join("\n"));

  const jsonFirst = runCut(["diff", beforePath, afterPath, "--json"]), jsonSecond = runCut(["diff", beforePath, afterPath, "--json"]);
  assert.equal(jsonFirst.status, 2, jsonFirst.stderr);
  assert.equal(jsonFirst.stdout, jsonSecond.stdout);
  const report = JSON.parse(jsonFirst.stdout) as ReturnType<typeof diffCutAVIR>;
  assert.deepEqual({ format: report.format, version: report.version, irVersion: report.irVersion }, {
    format: "cut-av-ir-semantic-diff",
    version: 2,
    irVersion: 3,
  });
  assert.deepEqual(report.changes.map((change) => [change.entity, change.operation]), [
    ["ir", "modify"], ["job", "modify"], ["assertion", "modify"],
  ]);
});

test("av-diff CLI rejects invalid CutAVIR with a failure distinct from changes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-av-diff-invalid-"));
  const validPath = resolve(directory, "valid.cutir.json");
  const partialPath = resolve(directory, "partial.cutir.json");
  const malformedPath = resolve(directory, "malformed.cutir.json");
  const duplicatePath = resolve(directory, "duplicate.cutir.json");
  const valid = JSON.stringify(compile(trimProgram(4)));
  await Promise.all([
    writeFile(validPath, valid),
    writeFile(partialPath, JSON.stringify({ format: "cut-av-ir", version: 3, language: "0.4" })),
    writeFile(malformedPath, "{not json"),
    writeFile(duplicatePath, valid.replace('"format":"cut-av-ir"', '"format":"cut-av-ir","format":"cut-av-ir"')),
  ]);

  const partial = runCut(["av-diff", validPath, partialPath, "--json"]);
  assert.equal(partial.status, 1);
  assert.equal(partial.stderr, "");
  const partialReport = JSON.parse(partial.stdout) as { format: string; status: string; diagnostics: Array<{ code: string; message: string }> };
  assert.equal(partialReport.format, "cut-cli-diagnostics");
  assert.equal(partialReport.status, "fail");
  assert.deepEqual(partialReport.diagnostics.map((item) => item.code), ["CUTC9000"]);
  assert.match(partialReport.diagnostics[0].message, /after CutAVIR: CUT_IR_MISSING_FIELD at \$:.*compiler/);

  const malformed = runCut(["av-diff", malformedPath, validPath]);
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /before CutAVIR: CUT_IR_JSON_PARSE at \$/);

  const duplicate = runCut(["av-diff", duplicatePath, validPath]);
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, "");
  assert.match(duplicate.stderr, /before CutAVIR: CUT_IR_JSON_DUPLICATE_KEY at \$/);
});
