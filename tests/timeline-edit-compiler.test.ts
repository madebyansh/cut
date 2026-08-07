import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { compareRational, rational } from "../lib/language/rational";
import { executeTimelineEditPlan } from "../lib/language/timeline-edit-operations";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return parsed.module;
}

function compile(source: string) {
  return compileCutModule(parse(source)).ir;
}

function track<T extends "picture-track" | "audio-track">(
  ir: CutAVIR,
  kind: T,
): IRNode & { editorial: Extract<IREditorial, { kind: T }> } {
  const result = Object.values(ir.nodes).find((node) => node.editorial?.kind === kind);
  assert.ok(result);
  return result as IRNode & { editorial: Extract<IREditorial, { kind: T }> };
}

const imports = `import {
  Sequence, PictureTrack, PictureClip, AudioTrack, TimelineEdit,
  editSelection, avTime, editBoundary, editTransition,
  editorialMetadataEntry, editorialMetadata
} from "@cut/edit";
import { AudioClip } from "@cut/audio";`;

function linkedProgram(allowUnlinked = false) {
  const selectedTracks = allowUnlinked ? '["v1"]' : '["v1", "a1"]';
  const allow = allowUnlinked ? ", allowUnlinked: true" : "";
  return `cut 0.4;
project "canonical linked timeline edit compiler";
${imports}
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(
        trackId: "v1",
        role: "primary",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.lane", value: "hero")
        ])
      ) {
        PictureClip(source: picture, range: 1s ..< 3s, duration: 2s, headHandle: 1s, tailHandle: 1s, link: "left", editId: "picture-left", role: "primary", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "left")]));
        PictureClip(source: picture, range: 3s ..< 5s, duration: 2s, headHandle: 1s, tailHandle: 1s, link: "right", editId: "picture-right", role: "b-roll", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "right")]));
      }
    }
    AudioTrack(trackId: "a1", role: "dialogue", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.lane", value: "dialogue")])) {
      AudioClip(source: voice, range: 1s ..< 3s, destination: 0s ..< 2s, headHandle: 1s, tailHandle: 1s, link: "left", editId: "audio-left", role: "dialogue", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "left")]));
      AudioClip(source: voice, range: 3s ..< 5s, destination: 2s ..< 4s, headHandle: 1s, tailHandle: 1s, link: "right", editId: "audio-right", role: "dialogue", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "right")]));
    }
    TimelineEdit(id: "linked-jl", operations: [
      editBoundary(
        selection: editSelection(trackIds: ${selectedTracks}${allow}),
        at: avTime(picture: 2250ms, audio: 1750ms)
      )${allowUnlinked ? "" : `,
      editTransition(
        left: editSelection(trackIds: ["v1", "a1"], originIds: ["picture-left", "audio-left"]),
        right: editSelection(trackIds: ["v1", "a1"], originIds: ["picture-right", "audio-right"]),
        at: avTime(picture: 2250ms, audio: 1750ms),
        duration: avTime(picture: 500ms, audio: 500ms),
        pictureKind: "cross-dissolve",
        audioCurve: "equal-power"
      )`}
    ]);
  }
}
export out = render(main);`;
}

test("compiler atomically materializes one linked J/L boundary and exact A/V transitions", () => {
  const ir = compile(linkedProgram());
  assert.equal(ir.timelineEdits?.length, 1);
  const plan = ir.timelineEdits![0]!;
  const execution = executeTimelineEditPlan(plan);
  assert.equal(execution.tracks.length, 2);
  assert.equal(execution.transitions.length, 2);
  assert.equal(execution.transitions.find((entry) => entry.domain === "picture")?.cut.numerator, "9");
  assert.equal(execution.transitions.find((entry) => entry.domain === "picture")?.cut.denominator, "4");
  assert.equal(execution.transitions.find((entry) => entry.domain === "audio")?.cut.numerator, "7");
  assert.equal(execution.transitions.find((entry) => entry.domain === "audio")?.cut.denominator, "4");

  const picture = track(ir, "picture-track");
  const audio = track(ir, "audio-track");
  assert.equal(picture.editorial.trackId, "v1");
  assert.equal(audio.editorial.trackId, "a1");
  assert.equal(picture.editorial.role, "primary");
  assert.deepEqual(picture.editorial.metadata, { "org.example.lane": "hero" });
  assert.equal(audio.editorial.role, "dialogue");
  assert.deepEqual(audio.editorial.metadata, { "org.example.lane": "dialogue" });
  assert.deepEqual(
    picture.editorial.items.map((item) => [item.role, item.metadata]),
    [["primary", { "org.example.take": "left" }], ["b-roll", { "org.example.take": "right" }]],
  );
  assert.deepEqual(
    audio.editorial.items.map((item) => [item.role, item.metadata]),
    [["dialogue", { "org.example.take": "left" }], ["dialogue", { "org.example.take": "right" }]],
  );
  assert.deepEqual(plan.tracks.map((entry) => [entry.role, entry.metadata]), [
    ["primary", { "org.example.lane": "hero" }],
    ["dialogue", { "org.example.lane": "dialogue" }],
  ]);
  assert.equal(picture.editorial.items.length, 2);
  assert.equal(audio.editorial.items.length, 2);
  assert.equal(picture.editorial.transitions?.length, 1);
  assert.equal(audio.editorial.transitions?.length, 1);
  assert.equal(compareRational(picture.editorial.items[0]!.destination.duration, rational(9, 4)), 0);
  assert.equal(compareRational(audio.editorial.items[0]!.destination.duration, rational(7, 4)), 0);
  assert.deepEqual(
    new Set([...picture.children, ...audio.children]).size,
    picture.children.length + audio.children.length,
  );
  assert.ok([...picture.children, ...audio.children].every((id) => ir.nodes[id]?.ownership === "child"));
  assert.ok(
    [picture, audio, ...picture.children.map((id) => ir.nodes[id]!), ...audio.children.map((id) => ir.nodes[id]!)]
      .every((node) => node.inputs.role === undefined && node.inputs.metadata === undefined),
    "editorial authoring metadata must not leak into runtime kernel inputs",
  );
});

test("linked ownership fails closed unless source explicitly requests an unlinked side edit", () => {
  const partial = linkedProgram(true).replace(", allowUnlinked: true", "");
  assert.throws(
    () => compile(partial),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT_TIMELINE_EDIT_LINK"),
  );

  const unlinked = compile(linkedProgram(true));
  assert.equal(unlinked.timelineEdits?.length, 1);
  assert.deepEqual(unlinked.timelineEdits![0]!.tracks.map((entry) => entry.trackId), ["v1", "a1"]);
  const operation = unlinked.timelineEdits![0]!.operations[0];
  assert.equal(operation?.kind === "boundary-adjust" && operation.selection.allowUnlinked, true);
  assert.equal(track(unlinked, "audio-track").children.length, 2);
});

test("one live track is claimed by at most one atomic TimelineEdit plan", () => {
  const duplicate = linkedProgram(true).replace(
    "  }\n}\nexport out = render(main);",
    `    TimelineEdit(id: "second-plan", operations: [
      editBoundary(
        selection: editSelection(trackIds: ["v1"], allowUnlinked: true),
        at: avTime(picture: 2s)
      )
    ]);
  }
}
export out = render(main);`,
  );
  assert.throws(
    () => compile(duplicate),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "CUT_TIMELINE_EDIT_REFERENCE"
        && /already claimed/u.test(diagnostic.message)),
  );
});

test("namespaced metadata is bounded, unique, track-owned, and fails before publication", () => {
  const badNamespace = linkedProgram().replace(
    'editorialMetadataEntry(key: "org.example.lane", value: "hero")',
    'editorialMetadataEntry(key: "cut.private", value: "hero")',
  );
  assert.throws(
    () => compile(badNamespace),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT_TIMELINE_EDIT_METADATA"),
  );

  const duplicate = linkedProgram().replace(
    'editorialMetadataEntry(key: "org.example.lane", value: "hero")',
    'editorialMetadataEntry(key: "org.example.lane", value: "hero"), editorialMetadataEntry(key: "org.example.lane", value: "duplicate")',
  );
  assert.throws(
    () => compile(duplicate),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT_TIMELINE_EDIT_METADATA"),
  );

});
