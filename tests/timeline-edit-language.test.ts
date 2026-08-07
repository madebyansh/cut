import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { parseCutLanguage } from "../lib/language/parser";
import { builtinPackages, type PackageSymbol } from "../lib/language/packages";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  return parsed.module;
}

function diagnostics(source: string) {
  return checkCutModule(parse(source)).diagnostics.filter((item) => item.severity === "error");
}

function expectDiagnostic(source: string, code: string, message?: RegExp) {
  const found = diagnostics(source).find((item) => item.code === code && (!message || message.test(item.message)));
  assert.ok(found, JSON.stringify(diagnostics(source)));
  assert.ok(found.span.start.line >= 1 && found.span.start.column >= 1);
  return found;
}

const imports = `import {
  Sequence, PictureTrack, PictureClip, AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editTrim, editRippleDelete, editLift,
  editExtract, editSlip, editSlide, editBoundary, editTransition,
  editOperandPart, editOperand, editInsert, editOverwrite,
  editorialMetadataEntry, editorialMetadata
} from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";`;

const operationList = `[
  editSplit(
    selection: editSelection(
      trackIds: ["v1", "a1"],
      originIds: ["picture-a", "audio-a"],
      linkIds: ["take-a"],
      range: 0s ..< 2s,
      relation: "overlaps"
    ),
    at: avTime(picture: 1s, audio: 1s)
  ),
  editTrim(selection: editSelection(trackIds: ["v1"], originIds: ["picture-a"]), keep: 0s ..< 1500ms),
  editRippleDelete(selection: editSelection(trackIds: ["v1", "a1"]), range: 2s ..< 2500ms),
  editLift(selection: editSelection(trackIds: ["v1"]), range: 2500ms ..< 3s),
  editExtract(selection: editSelection(trackIds: ["a1"]), range: 3s ..< 3250ms),
  editSlip(selection: editSelection(trackIds: ["v1"], originIds: ["picture-a"]), range: 0s ..< 1s, by: avTime(picture: 250ms)),
  editSlide(selection: editSelection(trackIds: ["a1"], originIds: ["audio-a"]), range: 0s ..< 1s, by: avTime(audio: 125ms)),
  editBoundary(selection: editSelection(trackIds: ["v1", "a1"], linkIds: ["take-a"]), at: avTime(picture: 2s, audio: 1750ms)),
  editInsert(
    picture: editSelection(trackIds: ["v1"], allowUnlinked: true),
    at: avTime(picture: 2s),
    operand: editOperand(parts: [
      editOperandPart(
        domain: "picture",
        sourceOriginId: "picture-a",
        originId: "picture-insert",
        duration: 4s,
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.purpose", value: "conformance")
        ])
      )
    ])
  ),
  editOverwrite(
    audio: editSelection(trackIds: ["a1"], allowUnlinked: true),
    at: avTime(audio: 0s),
    operand: editOperand(parts: [
      editOperandPart(domain: "audio", sourceOriginId: "audio-a", originId: "audio-overwrite", duration: 4s)
    ])
  ),
  editTransition(
    left: editSelection(trackIds: ["v1", "a1"], linkIds: ["take-a"]),
    right: editSelection(trackIds: ["v1", "a1"], linkIds: ["take-b"]),
    at: avTime(picture: 2s, audio: 1750ms),
    duration: avTime(picture: 500ms, audio: 750ms),
    pictureKind: "cross-dissolve",
    pictureDirection: "left",
    pictureSoftness: 25%,
    pictureColor: #102030,
    audioCurve: "equal-power"
  )
]`;

function program(statement = `TimelineEdit(id: "main-edit", duration: 3500ms, operations: ${operationList});`) {
  return `cut 0.4;
project "canonical timeline edit language";
${imports}
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(trackId: "v1") {
        PictureClip(source: picture, range: 0s ..< 4s, duration: 4s, link: "take-a", editId: "picture-a");
      }
    }
    AudioTrack(trackId: "a1") {
      AudioRegion(destination: 0s ..< 4s, link: "take-a", editId: "audio-a") {
        Gain(amount: -2db) {
          AudioClip(source: voice, range: 0s ..< 4s);
        }
      }
    }
    ${statement}
  }
}
export out = render(main);`;
}

test("the package exposes append-only stable identities and one closed canonical edit surface", () => {
  const edit = builtinPackages.get("@cut/edit");
  const audio = builtinPackages.get("@cut/audio");
  assert.ok(edit);
  assert.ok(audio);

  assert.deepEqual(edit.symbols.PictureTrack?.parameters?.map((item) => item.name).slice(-5), ["sourceDuration", "edits", "trackId", "role", "metadata"]);
  assert.deepEqual(edit.symbols.AudioTrack?.parameters?.map((item) => item.name).slice(-5), ["sourceDuration", "edits", "trackId", "role", "metadata"]);
  assert.deepEqual(edit.symbols.PictureClip?.parameters?.map((item) => item.name).slice(-3), ["editId", "role", "metadata"]);
  assert.deepEqual(edit.symbols.AudioRegion?.parameters?.map((item) => item.name).slice(-3), ["editId", "role", "metadata"]);
  assert.deepEqual(audio.symbols.AudioClip?.parameters?.map((item) => item.name).slice(-3), ["editId", "role", "metadata"]);

  const expectedRecords = [
    "editSelection", "avTime", "editOperandPart", "editOperand",
    "editorialMetadataEntry", "editorialMetadata",
  ];
  for (const name of expectedRecords) {
    const recordSymbol: PackageSymbol | undefined = edit.symbols[name];
    assert.ok(recordSymbol, name);
    assert.equal(recordSymbol.kind, "function", name);
    assert.equal(recordSymbol.lowering, "record", name);
    assert.equal(recordSymbol.native, undefined, name);
    assert.equal(recordSymbol.openNamed, undefined, name);
  }
  const expectedOperations = [
    "editSplit", "editTrim", "editRippleDelete", "editLift", "editExtract",
    "editSlip", "editSlide", "editBoundary", "editInsert", "editOverwrite", "editTransition",
  ];
  for (const name of expectedOperations) {
    const operationSymbol: PackageSymbol | undefined = edit.symbols[name];
    assert.ok(operationSymbol, name);
    assert.equal(operationSymbol.kind, "function", name);
    assert.equal(operationSymbol.lowering, "timeline-edit-operation", name);
    assert.equal(operationSymbol.native, undefined, name);
    assert.equal(operationSymbol.openNamed, undefined, name);
  }

  const timeline = edit.symbols.TimelineEdit;
  assert.ok(timeline);
  assert.equal(timeline.kind, "function");
  assert.equal(timeline.native, "cut.edit.timeline_edit");
  assert.equal(timeline.returns, "EditorialTransaction");
  assert.deepEqual(timeline.parameters?.map((item) => [item.name, item.type, Boolean(item.optional)]), [
    ["id", "String", false],
    ["duration", "Time", true],
    ["operations", "List<TimelineEditOperation>", false],
  ]);
});

test("all canonical operation records and append-only identifiers type-check in one direct scene transaction", () => {
  assert.deepEqual(diagnostics(program()), []);
});

test("TimelineEdit is confined to a bodyless unbound direct scene statement", () => {
  expectDiagnostic(
    program("").replace("  scene only(duration: 4s) {", `  TimelineEdit(id: "timeline-root", operations: ${operationList});\n  scene only(duration: 4s) {`),
    "CUT_TIMELINE_EDIT_SCOPE",
    /direct scene/,
  );
  expectDiagnostic(program(`at 0s { TimelineEdit(id: "at", operations: ${operationList}); }`), "CUT_TIMELINE_EDIT_SCOPE");
  expectDiagnostic(program(`if true { TimelineEdit(id: "conditional", operations: ${operationList}); }`), "CUT_TIMELINE_EDIT_SCOPE");
  expectDiagnostic(program(`let detached = TimelineEdit(id: "value", operations: ${operationList});`), "CUT_TIMELINE_EDIT_SCOPE");
  expectDiagnostic(program(`TimelineEdit(id: "bound", operations: ${operationList}) as transaction;`), "CUT_TIMELINE_EDIT_SCOPE", /cannot use/);
  expectDiagnostic(program(`TimelineEdit(id: "body", operations: ${operationList}) { PictureTrack(trackId: "bad") { PictureClip(source: picture, range: 0s ..< 1s, duration: 1s); } }`), "CUT_TIMELINE_EDIT_SCOPE", /child block/);
  expectDiagnostic(
    program("Bad();").replace(
      imports,
      `${imports}\ncomponent Bad() -> Visual { TimelineEdit(id: "component", operations: ${operationList}); PictureTrack(trackId: "inside") { PictureClip(source: picture, range: 0s ..< 4s, duration: 4s); } }`,
    ),
    "CUT_TIMELINE_EDIT_SCOPE",
  );
});

test("closed constructors reject missing, unknown, mistyped, and invalid-enum inputs", () => {
  expectDiagnostic(program('TimelineEdit(id: "missing");'), "CUT2028", /operations/);
  expectDiagnostic(program('TimelineEdit(id: "unknown", operations: [], surprise: true);'), "CUT2027", /surprise/);
  expectDiagnostic(program('TimelineEdit(id: "typed", operations: [editSplit(selection: editSelection(trackIds: ["v1", 2]), at: avTime(picture: 1s))]);'), "CUT2011", /Array items/);
  expectDiagnostic(program('TimelineEdit(id: "relation", operations: [editLift(selection: editSelection(trackIds: ["v1"], relation: "near"), range: 0s ..< 1s)]);'), "CUT2068", /relation/);
  expectDiagnostic(program('TimelineEdit(id: "picture-kind", operations: [editTransition(left: editSelection(trackIds: ["v1"]), right: editSelection(trackIds: ["v1"]), at: avTime(picture: 1s), duration: avTime(picture: 500ms), pictureKind: "morph")]);'), "CUT2068", /pictureKind/);
  expectDiagnostic(program('TimelineEdit(id: "audio-curve", operations: [editTransition(left: editSelection(trackIds: ["a1"]), right: editSelection(trackIds: ["a1"]), at: avTime(audio: 1s), duration: avTime(audio: 500ms), audioCurve: "log")]);'), "CUT2068", /audioCurve/);
  expectDiagnostic(program('TimelineEdit(id: "closed", operations: [editSplit(selection: editSelection(trackIds: ["v1"]), at: avTime(picture: 1s), extra: 1s)]);'), "CUT2027", /extra/);
});

test("AudioClip editId remains track-owned while AudioRegion owns the processed edit identity", () => {
  const tracked = `cut 0.4;
project "track-owned audio edit identity";
import { AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 1s) {
    AudioTrack(trackId: "a1") {
      AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s, editId: "take-audio");
    }
  }
}
export out = render(main);`;
  assert.deepEqual(diagnostics(tracked), []);

  const ordinary = `cut 0.4;
project "ordinary audio edit identity";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 1s) {
    AudioClip(source: voice, editId: "detached");
  }
}
export out = render(main);`;
  expectDiagnostic(ordinary, "CUT2072", /editId/);

  const nested = program('TimelineEdit(id: "valid", operations: [editLift(selection: editSelection(trackIds: ["a1"]), range: 0s ..< 1s)]);')
    .replace("AudioClip(source: voice, range: 0s ..< 4s);", 'AudioClip(source: voice, range: 0s ..< 4s, editId: "wrong-owner");');
  expectDiagnostic(nested, "CUT_AUDIO_REGION_SHAPE", /editId/);

  const nestedMetadata = program('TimelineEdit(id: "valid", operations: [editLift(selection: editSelection(trackIds: ["a1"]), range: 0s ..< 1s)]);')
    .replace(
      "AudioClip(source: voice, range: 0s ..< 4s);",
      'AudioClip(source: voice, range: 0s ..< 4s, role: "dialogue", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "nested")]));',
    );
  expectDiagnostic(nestedMetadata, "CUT_AUDIO_REGION_SHAPE", /role\/metadata/);
});
