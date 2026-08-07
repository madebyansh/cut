import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { addRational, rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import {
  createIncrementalRenderPlan,
  finalizeGraphHashes,
} from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { ReferencePrecompError } from "../lib/runtime/reference/precomp-config";
import {
  ReferenceTimelineEditMaterializationError,
  validateReferenceTimelineEditMaterializations,
} from "../lib/runtime/reference/timeline-edit";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

type PictureTrack = IRNode & {
  editorial: Extract<IREditorial, { kind: "picture-track" }>;
};

const operations = {
  split: `editSplit(
    selection: editSelection(trackIds: ["nested-picture"]),
    at: avTime(picture: 500ms)
  )`,
  trim: `editTrim(
    selection: editSelection(trackIds: ["nested-picture"]),
    keep: 500ms ..< 1500ms
  )`,
  lift: `editLift(
    selection: editSelection(trackIds: ["nested-picture"]),
    range: 500ms ..< 1s
  )`,
  extract: `editExtract(
    selection: editSelection(trackIds: ["nested-picture"]),
    range: 500ms ..< 1s
  )`,
  ripple: `editRippleDelete(
    selection: editSelection(trackIds: ["nested-picture"]),
    range: 500ms ..< 1s
  )`,
} as const;

function source(operation: keyof typeof operations, sourceRange = "0s ..< 2s") {
  return `cut 0.4;
project "canonical nested picture edit";
import { Precomp, Rect } from "cut:visual";
import {
  Sequence, PictureTrack, TimelineEdit, editSelection, avTime,
  editSplit, editTrim, editRippleDelete, editLift, editExtract
} from "@cut/edit";
timeline main(duration: 2s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene host(duration: 2s) {
    Sequence(duration: 2s) {
      PictureTrack(trackId: "nested-picture", role: "graphics") {
        Precomp(source: insert, range: ${sourceRange});
      }
    }
    TimelineEdit(id: "nested-${operation}", operations: [
      ${operations[operation]}
    ]);
  }
}
timeline insert(duration: 3s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene red(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #ef233c); }
  scene green(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #24a148); }
  scene blue(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #2667ff); }
  scene amber(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #ffb000); }
  scene purple(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #7c3aed); }
  scene cyan(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #06b6d4); }
}
timeline unrelated(duration: 2s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 2s) { Rect(width: 24px, height: 16px, fill: #111827); }
}
export out = render(main);`;
}

function placementSource(
  withEdit: boolean,
  metadataValue = "source",
  firstColor = "#ef233c",
  presentation = "",
) {
  return `cut 0.4;
project "canonical nested picture placement";
import { Precomp, Rect } from "cut:visual";
import {
  Sequence, PictureTrack, Gap, TimelineEdit, editSelection, avTime,
  editOperandPart, editOperand, editInsert, editOverwrite,
  editorialMetadataEntry, editorialMetadata
} from "@cut/edit";
timeline main(duration: 4s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene host(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(trackId: "nested-picture", role: "graphics") {
        Precomp(
          source: insert,
          range: 500ms ..< 1500ms,
${presentation ? `          ${presentation},\n` : ""}
          editId: "nested-source",
          role: "graphics",
          metadata: editorialMetadata(entries: [
            editorialMetadataEntry(key: "org.cutlang.test.source", value: "${metadataValue}")
          ])
        );
        Precomp(
          source: insert,
          range: 1s ..< 3s,
          editId: "nested-body",
          role: "b-roll"
        );
        Gap(duration: 1s);
      }
    }
    ${withEdit ? `TimelineEdit(id: "nested-placement", operations: [
      editInsert(
        picture: editSelection(trackIds: ["nested-picture"]),
        at: avTime(picture: 1s),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "picture",
            sourceOriginId: "nested-source",
            originId: "inserted-nested",
            duration: 1s,
            metadata: editorialMetadata(entries: [
              editorialMetadataEntry(key: "org.cutlang.test.placement", value: "insert"),
              editorialMetadataEntry(key: "org.cutlang.test.source", value: "insert")
            ])
          )
        ])
      ),
      editOverwrite(
        picture: editSelection(trackIds: ["nested-picture"]),
        at: avTime(picture: 3s),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "picture",
            sourceOriginId: "nested-source",
            originId: "overwritten-nested",
            duration: 1s,
            metadata: editorialMetadata(entries: [
              editorialMetadataEntry(key: "org.cutlang.test.placement", value: "overwrite"),
              editorialMetadataEntry(key: "org.cutlang.test.source", value: "overwrite")
            ])
          )
        ])
      )
    ]);` : ""}
  }
}
timeline insert(duration: 3s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene red(duration: 500ms) { Rect(width: 24px, height: 16px, fill: ${firstColor}); }
  scene green(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #24a148); }
  scene blue(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #2667ff); }
  scene amber(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #ffb000); }
  scene purple(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #7c3aed); }
  scene cyan(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #06b6d4); }
}
export out = render(main);`;
}

function mixedNestedAndDirectSource() {
  return `cut 0.4;
project "mixed nested and direct picture edit";
import { Precomp, Rect } from "cut:visual";
import {
  Sequence, PictureTrack, PictureClip, TimelineEdit, editSelection, avTime,
  editSplit, editOperandPart, editOperand, editOverwrite
} from "@cut/edit";
asset picture: VideoAsset = video("picture.mkv");
timeline main(duration: 4s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene host(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(trackId: "nested-track") {
        Precomp(
          source: insert,
          range: 0s ..< 4s,
          editId: "nested-source"
        );
      }
      PictureTrack(trackId: "direct-track") {
        PictureClip(
          source: picture,
          range: 0s ..< 2s,
          duration: 2s,
          editId: "direct-source"
        );
        PictureClip(
          source: picture,
          range: 2s ..< 4s,
          duration: 2s,
          editId: "direct-body"
        );
      }
    }
    TimelineEdit(id: "mixed-edit", operations: [
      editSplit(
        selection: editSelection(
          trackIds: ["nested-track"],
          originIds: ["nested-source"]
        ),
        at: avTime(picture: 2s)
      ),
      editOverwrite(
        picture: editSelection(trackIds: ["direct-track"]),
        at: avTime(picture: 2s),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "picture",
            sourceOriginId: "direct-source",
            originId: "direct-overwrite",
            duration: 2s
          )
        ])
      )
    ]);
  }
}
timeline insert(duration: 4s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Rect(width: 24px, height: 16px, fill: #24a148);
  }
}
export out = render(main);`;
}

function compile(operation: keyof typeof operations, sourceRange?: string) {
  const parsed = parseCutLanguage(source(operation, sourceRange));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    checkCutModule(parsed.module).diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  return compileCutModule(parsed.module).ir;
}

function compilePlacement(
  withEdit = true,
  metadataValue = "source",
  firstColor = "#ef233c",
  presentation = "",
) {
  const parsed = parseCutLanguage(placementSource(
    withEdit,
    metadataValue,
    firstColor,
    presentation,
  ));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    checkCutModule(parsed.module).diagnostics.filter((diagnostic) =>
      diagnostic.severity === "error"),
    [],
  );
  return compileCutModule(parsed.module).ir;
}

function compileMixed(sourceText = mixedNestedAndDirectSource()) {
  const parsed = parseCutLanguage(sourceText);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    checkCutModule(parsed.module).diagnostics.filter((diagnostic) =>
      diagnostic.severity === "error"),
    [],
  );
  return compileCutModule(parsed.module).ir;
}

function compileTransformedStructural() {
  const transformed = source("split").replace(
    "Precomp(source: insert, range: 0s ..< 2s);",
    "Precomp(source: insert, range: 0s ..< 2s, x: 1px, opacity: 75%);",
  );
  const parsed = parseCutLanguage(transformed);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    checkCutModule(parsed.module).diagnostics.filter((diagnostic) =>
      diagnostic.severity === "error"),
    [],
  );
  return compileCutModule(parsed.module).ir;
}

const staticPrecompPresentation =
  "x: 1px, y: -1px, scale: 0.75, rotation: 7deg, opacity: 75%";

function pictureTrack(ir: CutAVIR) {
  const track = Object.values(ir.nodes).find((node): node is PictureTrack =>
    node.editorial?.kind === "picture-track"
    && node.editorial.trackId === "nested-picture");
  assert.ok(track);
  return track;
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pixel(surface: { data: Uint8Array; width: number }, x = 12, y = 8) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

async function frames(ir: CutAVIR, selected = [0, 2, 4, 6]) {
  const { composition } = validateReferenceSession(ir);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-timeline-nested-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, directory, resolve(directory, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[composition.sceneIds[0]!]!;
    const result = [];
    for (const frame of selected) result.push(await renderer.sceneFrame(scene, frame));
    return result;
  } finally {
    renderer.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function sceneKey(ir: CutAVIR) {
  const plan = createIncrementalRenderPlan(ir, "main");
  assert.equal(plan.scenes.length, 1);
  return plan.scenes[0]!.key;
}

test("public TimelineEdit segments one authenticated Precomp range without flattening its source graph", async () => {
  const ir = compile("lift");
  const plan = ir.timelineEdits?.[0];
  assert.ok(plan);
  const base = plan.tracks[0]!.items[0]!;
  assert.equal(base.domain, "picture");
  assert.deepEqual(base.sourceView, {
    kind: "nested",
    nodeId: base.sourceView.kind === "nested" ? base.sourceView.nodeId : "",
    compositionId: "insert",
    source: { start: rational(0), duration: rational(2) },
    handles: { head: rational(0), tail: rational(0) },
    authorityId: base.sourceView.authorityId,
    rate: rational(1),
    sharedClock: true,
    placementPolicy: "static-same-track-copy",
  });

  const track = pictureTrack(ir);
  assert.deepEqual(track.editorial.items.map((item) => [
    item.kind,
    item.destination,
    item.source,
    ir.nodes[item.nodeId]?.op,
  ]), [
    ["picture", { start: rational(0), duration: rational(1, 2) }, { start: rational(0), duration: rational(1, 2) }, "cut.visual.precomp"],
    ["gap", { start: rational(1, 2), duration: rational(1, 2) }, undefined, "cut.edit.gap"],
    ["picture", { start: rational(1), duration: rational(1) }, { start: rational(1), duration: rational(1) }, "cut.visual.precomp"],
  ]);
  const sourceRects = Object.values(ir.nodes).filter((node) =>
    node.op === "cut.visual.rect"
    && node.sceneId
    && ir.compositions.find((composition) => composition.id === "insert")!.sceneIds.includes(node.sceneId));
  assert.equal(sourceRects.length, 6, "nested source graph must remain separately owned");
  assert.ok(track.children.every((nodeId) => !sourceRects.some((node) => node.id === nodeId)));

  const rendered = await frames(ir);
  assert.deepEqual(rendered.map((surface) => pixel(surface)), [
    [239, 35, 60, 255],
    [5, 11, 16, 255],
    [38, 103, 255, 255],
    [255, 176, 0, 255],
  ]);
  const repeat = await frames(compile("lift"));
  assert.deepEqual(repeat.map((surface) => digest(surface.data)), rendered.map((surface) => digest(surface.data)));
});

test("split, trim, lift, extract, and ripple share the exact nested 1:1 source law", async () => {
  const expected: Readonly<Record<keyof typeof operations, readonly number[][]>> = {
    split: [[239, 35, 60, 255], [36, 161, 72, 255], [38, 103, 255, 255], [255, 176, 0, 255]],
    trim: [[5, 11, 16, 255], [36, 161, 72, 255], [38, 103, 255, 255], [5, 11, 16, 255]],
    lift: [[239, 35, 60, 255], [5, 11, 16, 255], [38, 103, 255, 255], [255, 176, 0, 255]],
    extract: [[239, 35, 60, 255], [38, 103, 255, 255], [255, 176, 0, 255], [5, 11, 16, 255]],
    ripple: [[239, 35, 60, 255], [38, 103, 255, 255], [255, 176, 0, 255], [5, 11, 16, 255]],
  };
  for (const operation of Object.keys(expected) as Array<keyof typeof operations>) {
    const ir = compile(operation);
    assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(ir)), operation);
    assert.equal(validateReferenceTimelineEditMaterializations(ir).plans.length, 1, operation);
    assert.deepEqual((await frames(ir)).map((surface) => pixel(surface)), expected[operation], operation);
  }
});

test("static transformed nested presentation is sliceable and gains explicit same-track copy authority", async () => {
  const first = compileTransformedStructural();
  const repeat = compileTransformedStructural();
  const nestedViews = first.timelineEdits![0]!.tracks[0]!.items
    .filter((item) => item.sourceView.kind === "nested")
    .map((item) => item.sourceView);
  assert.ok(nestedViews.length >= 1);
  assert.ok(nestedViews.every((view) =>
    view.kind === "nested" && view.placementPolicy === "static-same-track-copy"));
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(first)));
  assert.doesNotThrow(() => validateReferenceSession(first));
  const firstFrames = await frames(first);
  assert.deepEqual(
    firstFrames.map((surface) => digest(surface.data)),
    (await frames(repeat)).map((surface) => digest(surface.data)),
  );

  const legacyOmission = structuredClone(first);
  const omittedView = legacyOmission.timelineEdits![0]!.tracks[0]!.items[0]!
    .sourceView;
  assert.equal(omittedView.kind, "nested");
  if (omittedView.kind === "nested") {
    delete (omittedView as { placementPolicy?: string }).placementPolicy;
  }
  finalizeGraphHashes(legacyOmission);
  assert.doesNotThrow(
    () => loadCutAvIr(JSON.stringify(legacyOmission)),
    "pre-policy nested IR remains structurally loadable; omission never grants placement",
  );
  assert.doesNotThrow(() => validateReferenceSession(legacyOmission));
  assert.deepEqual(
    (await frames(legacyOmission)).map((surface) => digest(surface.data)),
    firstFrames.map((surface) => digest(surface.data)),
    "legacy placementPolicy omission executes as structural-only with exact RGBA parity",
  );

});

test("one nested base does not constrain an unrelated direct-picture overwrite in the same atomic plan", () => {
  const ir = compileMixed();
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(ir)));
  const inspection = inspectCutIr(ir, "mixed-edit.cut").timelineEdits?.find((item) =>
    item.id === "mixed-edit");
  assert.ok(inspection);
  const nestedTrack = inspection.execution.tracks.find((track) =>
    track.trackId === "nested-track");
  const directTrack = inspection.execution.tracks.find((track) =>
    track.trackId === "direct-track");
  assert.ok(nestedTrack && directTrack);
  assert.deepEqual(
    nestedTrack.items.map((item) => [
      item.originId,
      item.destination,
      item.sourceView.kind,
    ]),
    [
      ["nested-source", { start: rational(0), duration: rational(2) }, "nested"],
      ["nested-source", { start: rational(2), duration: rational(2) }, "nested"],
    ],
  );
  assert.deepEqual(
    directTrack.items.map((item) => [
      item.originId,
      item.destination,
      item.sourceView.kind,
    ]),
    [
      ["direct-source", { start: rational(0), duration: rational(2) }, "picture"],
      ["direct-overwrite", { start: rational(2), duration: rational(2) }, "picture"],
    ],
  );

  const crossTrack = mixedNestedAndDirectSource()
    .replace('sourceOriginId: "direct-source"', 'sourceOriginId: "nested-source"')
    .replace(
      'at: avTime(picture: 2s),\n        operand:',
      'at: avTime(picture: 0s),\n        operand:',
    )
    .replace('duration: 2s\n          )', 'duration: 4s\n          )');
  assert.throws(
    () => compileMixed(crossTrack),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "CUT_TIMELINE_EDIT_UNSUPPORTED"
        && /owning PictureTrack/u.test(diagnostic.message)),
  );

  const durationMismatch = mixedNestedAndDirectSource()
    .replace('duration: 2s\n          )', 'duration: 1s\n          )');
  assert.throws(
    () => compileMixed(durationMismatch),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "CUT_TIMELINE_EDIT_TIME"
        && /authored destination duration/u.test(diagnostic.message)),
  );

  const ambiguous = structuredClone(ir);
  const plan = ambiguous.timelineEdits?.[0];
  assert.ok(plan);
  const directSource = plan.tracks
    .find((track) => track.trackId === "direct-track")
    ?.items.find((item) => item.originId === "direct-source");
  assert.ok(directSource);
  (directSource as { originId: string }).originId = "nested-source";
  const overwrite = plan.operations.find((operation) =>
    operation.kind === "overwrite");
  assert.equal(overwrite?.kind, "overwrite");
  if (overwrite?.kind === "overwrite") {
    (overwrite.operand.parts[0] as { sourceOriginId: string }).sourceOriginId =
      "nested-source";
  }
  assert.throws(
    () => loadCutAvIr(JSON.stringify(ambiguous)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_TIMELINE_EDIT_REFERENCE",
  );
});

test("same-track insert and overwrite copy one static Precomp authority without flattening nested picture", async () => {
  const edited = compilePlacement();
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(edited)));
  const control = compileCutModule(
    parseCutLanguage(placementSource(false)
      .replace(
        `Precomp(
          source: insert,
          range: 1s ..< 3s,
          editId: "nested-body",
          role: "b-roll"
        );
        Gap(duration: 1s);`,
        `Precomp(source: insert, range: 500ms ..< 1500ms, editId: "inserted-nested", role: "graphics");
        Precomp(source: insert, range: 1s ..< 2s, editId: "nested-body", role: "b-roll");
        Precomp(source: insert, range: 500ms ..< 1500ms, editId: "overwritten-nested", role: "graphics");`,
      )).module!,
  ).ir;
  assert.doesNotThrow(() => validateReferenceSession(edited));
  assert.equal(validateReferenceTimelineEditMaterializations(edited).plans.length, 1);
  const track = pictureTrack(edited);
  assert.deepEqual(
    track.editorial.items.map((item) => [
      item.editId,
      item.destination,
      item.source,
      item.role,
      item.metadata,
      edited.nodes[item.nodeId]?.op,
    ]),
    [
      ["nested-source", { start: rational(0), duration: rational(1) }, { start: rational(1, 2), duration: rational(1) }, "graphics", { "org.cutlang.test.source": "source" }, "cut.visual.precomp"],
      ["inserted-nested", { start: rational(1), duration: rational(1) }, { start: rational(1, 2), duration: rational(1) }, "graphics", { "org.cutlang.test.placement": "insert", "org.cutlang.test.source": "insert" }, "cut.visual.precomp"],
      ["nested-body", { start: rational(2), duration: rational(1) }, { start: rational(1), duration: rational(1) }, "b-roll", undefined, "cut.visual.precomp"],
      ["overwritten-nested", { start: rational(3), duration: rational(1) }, { start: rational(1, 2), duration: rational(1) }, "graphics", { "org.cutlang.test.placement": "overwrite", "org.cutlang.test.source": "overwrite" }, "cut.visual.precomp"],
    ],
  );
  const inspection = inspectCutIr(edited, "nested-placement.cut")
    .timelineEdits?.find((item) => item.id === "nested-placement");
  assert.ok(inspection);
  const nested = inspection.execution.tracks[0]!.items.filter((item) =>
    item.sourceView.kind === "nested");
  assert.deepEqual(
    nested.map((item) => item.sourceView.kind === "nested"
      ? [
          item.originId,
          item.parentSegmentId,
          item.sourceView.compositionId,
          item.sourceView.source,
          item.sourceView.authorityId,
          item.sourceView.placementPolicy,
        ]
      : undefined),
    [
      ["nested-source", undefined, "insert", { start: rational(1, 2), duration: rational(1) }, nested[0]!.sourceView.authorityId, "static-same-track-copy"],
      ["inserted-nested", inspection.tracks[0]!.items[0]!.segmentId, "insert", { start: rational(1, 2), duration: rational(1) }, nested[0]!.sourceView.authorityId, "static-same-track-copy"],
      ["nested-body", inspection.tracks[0]!.items[1]!.segmentId, "insert", { start: rational(1), duration: rational(1) }, nested[2]!.sourceView.authorityId, "static-same-track-copy"],
      ["overwritten-nested", inspection.tracks[0]!.items[0]!.segmentId, "insert", { start: rational(1, 2), duration: rational(1) }, nested[0]!.sourceView.authorityId, "static-same-track-copy"],
    ],
  );
  const selected = Array.from({ length: 16 }, (_, index) => index);
  const [editedFrames, controlFrames, repeatedFrames] = await Promise.all([
    frames(edited, selected),
    frames(control, selected),
    frames(compilePlacement(), selected),
  ]);
  assert.deepEqual(
    editedFrames.map((surface) => digest(surface.data)),
    controlFrames.map((surface) => digest(surface.data)),
  );
  assert.deepEqual(
    repeatedFrames.map((surface) => digest(surface.data)),
    editedFrames.map((surface) => digest(surface.data)),
  );
  assert.equal(
    diffCutAVIR(compilePlacement(false), edited).changes.find((change) =>
      change.entity === "timeline-edit" && change.id === "nested-placement")?.operation,
    "add",
  );
  assert.equal(
    diffCutAVIR(edited, compilePlacement(true, "changed")).changes.find((change) =>
      change.entity === "timeline-edit" && change.id === "nested-placement")?.operation,
    "modify",
  );
  assert.equal(sceneKey(compilePlacement()), sceneKey(edited));
  assert.notEqual(sceneKey(compilePlacement(true, "changed")), sceneKey(edited));
  assert.notEqual(sceneKey(compilePlacement(true, "source", "#ff00ff")), sceneKey(edited));
});

test("same-track insert and overwrite preserve the complete static Precomp presentation without flattening", async () => {
  const edited = compilePlacement(
    true,
    "source",
    "#ef233c",
    staticPrecompPresentation,
  );
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(edited)));
  assert.doesNotThrow(() => validateReferenceSession(edited));
  assert.equal(validateReferenceTimelineEditMaterializations(edited).plans.length, 1);

  const control = compileCutModule(
    parseCutLanguage(placementSource(
      false,
      "source",
      "#ef233c",
      staticPrecompPresentation,
    ).replace(
      `Precomp(
          source: insert,
          range: 1s ..< 3s,
          editId: "nested-body",
          role: "b-roll"
        );
        Gap(duration: 1s);`,
      `Precomp(source: insert, range: 500ms ..< 1500ms, ${staticPrecompPresentation}, editId: "inserted-nested", role: "graphics");
        Precomp(source: insert, range: 1s ..< 2s, editId: "nested-body", role: "b-roll");
        Precomp(source: insert, range: 500ms ..< 1500ms, ${staticPrecompPresentation}, editId: "overwritten-nested", role: "graphics");`,
    )).module!,
  ).ir;

  const track = pictureTrack(edited);
  const presented = track.editorial.items
    .filter((item) => [
      "nested-source",
      "inserted-nested",
      "overwritten-nested",
    ].includes(item.editId ?? ""))
    .map((item) => edited.nodes[item.nodeId]!);
  assert.equal(
    presented.length,
    3,
    JSON.stringify(track.editorial.items.map((item) => ({
      editId: item.editId,
      nodeId: item.nodeId,
      inputs: Object.keys(edited.nodes[item.nodeId]?.inputs ?? {}).sort(),
    }))),
  );
  assert.deepEqual(
    presented.map((node) => Object.keys(node.inputs).sort()),
    Array.from({ length: 3 }, () => [
      "opacity",
      "range",
      "rotation",
      "scale",
      "source",
      "x",
      "y",
    ]),
  );
  for (const clone of presented.slice(1)) {
    for (const name of ["source", "range", "x", "y", "scale", "rotation", "opacity"]) {
      assert.deepEqual(
        clone.inputs[name],
        presented[0]!.inputs[name],
        `${name} must be cloned exactly`,
      );
    }
  }

  const execution = inspectCutIr(edited, "presented-nested-placement.cut")
    .timelineEdits?.find((item) => item.id === "nested-placement")?.execution;
  assert.ok(execution);
  const nestedViews = execution.tracks[0]!.items
    .filter((item) => [
      "nested-source",
      "inserted-nested",
      "overwritten-nested",
    ].includes(item.originId))
    .map((item) => item.sourceView);
  assert.equal(nestedViews.length, 3);
  assert.ok(nestedViews.every((view) =>
    view.kind === "nested"
    && view.placementPolicy === "static-same-track-copy"
    && view.authorityId === nestedViews[0]!.authorityId));

  const selected = Array.from({ length: 16 }, (_, index) => index);
  const [editedFrames, controlFrames, repeatFrames] = await Promise.all([
    frames(edited, selected),
    frames(control, selected),
    frames(compilePlacement(
      true,
      "source",
      "#ef233c",
      staticPrecompPresentation,
    ), selected),
  ]);
  const editedDigests = editedFrames.map((surface) => digest(surface.data));
  assert.deepEqual(editedDigests, controlFrames.map((surface) => digest(surface.data)));
  assert.deepEqual(editedDigests, repeatFrames.map((surface) => digest(surface.data)));

  const baseAuthority = nestedViews[0]!.authorityId;
  const baseKey = sceneKey(edited);
  const baseWitnesses = editedDigests.filter((_, index) => [0, 4, 12].includes(index));
  for (const [label, presentation] of [
    ["x", staticPrecompPresentation.replace("x: 1px", "x: 2px")],
    ["y", staticPrecompPresentation.replace("y: -1px", "y: -2px")],
    ["scale", staticPrecompPresentation.replace("scale: 0.75", "scale: 0.8")],
    ["rotation", staticPrecompPresentation.replace("rotation: 7deg", "rotation: 11deg")],
    ["opacity", staticPrecompPresentation.replace("opacity: 75%", "opacity: 60%")],
  ] as const) {
    const changed = compilePlacement(true, "source", "#ef233c", presentation);
    const changedView = changed.timelineEdits![0]!.tracks[0]!.items
      .find((item) => item.originId === "nested-source")!.sourceView;
    assert.equal(changedView.kind, "nested", label);
    assert.notEqual(changedView.authorityId, baseAuthority, label);
    assert.notEqual(sceneKey(changed), baseKey, label);
    assert.notDeepEqual(
      (await frames(changed, [0, 4, 12])).map((surface) => digest(surface.data)),
      baseWitnesses,
      `${label} must remain pixel-semantic`,
    );
  }
});

test("nested placement authority and static-owner limits fail before picture work", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-nested-hostile-"));
  try {
    const valid = compilePlacement();
    const planMutation = structuredClone(valid);
    const operation = planMutation.timelineEdits?.[0]?.operations[0];
    assert.equal(operation?.kind, "insert");
    if (operation?.kind === "insert") {
      (operation.operand.parts[0] as { sourceOriginId: string }).sourceOriginId =
        "missing-source";
    }
    const authorityCache = resolve(root, "authority-cache");
    assert.throws(
      () => new ReferenceVisualRenderer(
        planMutation,
        planMutation.compositions[0]!,
        root,
        authorityCache,
      ),
      (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
        && error.code === "CUT_TIMELINE_EDIT_REFERENCE",
    );
    await assert.rejects(
      access(authorityCache),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    const downgradedPolicy = structuredClone(valid);
    const sourceView = downgradedPolicy.timelineEdits![0]!.tracks[0]!.items
      .find((item) => item.originId === "nested-source")!.sourceView;
    assert.equal(sourceView.kind, "nested");
    if (sourceView.kind === "nested") {
      (sourceView as { placementPolicy: string }).placementPolicy =
        "structural-only";
    }
    const policyCache = resolve(root, "policy-cache");
    assert.throws(
      () => new ReferenceVisualRenderer(
        downgradedPolicy,
        downgradedPolicy.compositions[0]!,
        root,
        policyCache,
      ),
      (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
        && error.code === "CUT_TIMELINE_EDIT_UNSUPPORTED",
    );
    await assert.rejects(
      access(policyCache),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    const omittedPolicy = structuredClone(valid);
    const omittedSourceView = omittedPolicy.timelineEdits![0]!.tracks[0]!.items
      .find((item) => item.originId === "nested-source")!.sourceView;
    assert.equal(omittedSourceView.kind, "nested");
    if (omittedSourceView.kind === "nested") {
      delete (omittedSourceView as { placementPolicy?: string }).placementPolicy;
    }
    const omittedPolicyCache = resolve(root, "omitted-policy-cache");
    assert.throws(
      () => new ReferenceVisualRenderer(
        omittedPolicy,
        omittedPolicy.compositions[0]!,
        root,
        omittedPolicyCache,
      ),
      (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
        && error.code === "CUT_TIMELINE_EDIT_UNSUPPORTED",
    );
    await assert.rejects(
      access(omittedPolicyCache),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    const unknownPolicy = structuredClone(valid);
    const unknownPolicyView = unknownPolicy.timelineEdits![0]!.tracks[0]!.items
      .find((item) => item.originId === "nested-source")!.sourceView;
    assert.equal(unknownPolicyView.kind, "nested");
    if (unknownPolicyView.kind === "nested") {
      (unknownPolicyView as { placementPolicy: string }).placementPolicy =
        "copy-anywhere";
    }
    assert.throws(
      () => loadCutAvIr(JSON.stringify(unknownPolicy)),
      (error: unknown) => error instanceof CutAvIrValidationError
        && error.code === "CUT_IR_ENUM"
        && error.path.endsWith(".sourceView.placementPolicy"),
    );

    for (const [label, mutate] of [
      ["live transform", (node: IRNode) => {
        node.inputs.x = {
          kind: "quantity",
          dimension: "length",
          unit: "px",
          magnitude: rational(1),
        };
      }],
      ["live opacity", (node: IRNode) => {
        node.inputs.opacity = {
          kind: "quantity",
          dimension: "ratio",
          unit: "ratio",
          magnitude: rational(1, 2),
        };
      }],
      ["live static-shape effect class", (node: IRNode) => {
        (node as { effects: string[] }).effects = [];
      }],
      ["dynamic presentation property", (node: IRNode) => {
        node.properties.x = {
          kind: "quantity",
          dimension: "length",
          unit: "px",
          magnitude: rational(2),
        };
      }],
      ["unknown executable input", (node: IRNode) => {
        node.inputs.forgedPresentation = { kind: "string", value: "forged" };
      }],
    ] as const) {
      const mutation = structuredClone(valid);
      const sourceItem = pictureTrack(mutation).editorial.items.find((item) =>
        item.editId === "nested-source");
      assert.ok(sourceItem, label);
      mutate(mutation.nodes[sourceItem.nodeId]!);
      const liveCache = resolve(root, label.replaceAll(" ", "-"));
      assert.throws(
        () => new ReferenceVisualRenderer(
          mutation,
          mutation.compositions[0]!,
          root,
          liveCache,
        ),
        (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
          && error.code === "CUT_TIMELINE_EDIT_RESULT",
        label,
      );
      await assert.rejects(
        access(liveCache),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        label,
      );
    }

    const rangeMutation = structuredClone(valid);
    const insertedItem = pictureTrack(rangeMutation).editorial.items.find((item) =>
      item.editId === "inserted-nested");
    assert.ok(insertedItem);
    const insertedNode = rangeMutation.nodes[insertedItem.nodeId]!;
    insertedNode.inputs.range = {
      kind: "range",
      start: { kind: "quantity", dimension: "time", magnitude: rational(0), unit: "s" },
      end: { kind: "quantity", dimension: "time", magnitude: rational(1), unit: "s" },
      exclusive: true,
    };
    const rangeCache = resolve(root, "range-cache");
    assert.throws(
      () => new ReferenceVisualRenderer(
        rangeMutation,
        rangeMutation.compositions[0]!,
        root,
        rangeCache,
      ),
      (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
        && error.code === "CUT_TIMELINE_EDIT_RESULT",
    );
    await assert.rejects(
      access(rangeCache),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    const ancestryMutation = structuredClone(valid);
    (ancestryMutation.timelineEdits![0]!.tracks[0]!.items[0] as {
      parentSegmentId?: string;
    }).parentSegmentId = "forged-parent";
    assert.throws(
      () => loadCutAvIr(JSON.stringify(ancestryMutation)),
      (error: unknown) => error instanceof CutAvIrValidationError
        && error.code === "CUT_TIMELINE_EDIT_SHAPE"
        && /parentSegmentId/u.test(error.path),
    );

    const unknownField = structuredClone(valid);
    const nestedView = unknownField.timelineEdits![0]!.tracks[0]!.items[0]!.sourceView;
    assert.equal(nestedView.kind, "nested");
    (nestedView as unknown as Record<string, unknown>).forged = true;
    assert.throws(
      () => loadCutAvIr(JSON.stringify(unknownField)),
      (error: unknown) => error instanceof CutAvIrValidationError
        && error.code === "CUT_IR_UNKNOWN_FIELD",
    );

    const dynamicPlacementSource = placementSource(true).replace(
      `        );
        Precomp(
          source: insert,
          range: 1s ..< 3s,`,
      `        ) as animatedNested;
        at 500ms { set animatedNested.x = 2px; }
        Precomp(
          source: insert,
          range: 1s ..< 3s,`,
    );
    assert.match(dynamicPlacementSource, /animatedNested/u);
    const dynamicPlacement = parseCutLanguage(dynamicPlacementSource);
    assert.ok(dynamicPlacement.module);
    let dynamicFailure: unknown;
    let dynamicIr: CutAVIR | undefined;
    try {
      dynamicIr = compileCutModule(dynamicPlacement.module!).ir;
    } catch (error) {
      dynamicFailure = error;
    }
    assert.ok(
      dynamicFailure instanceof CutCompileError
        && dynamicFailure.result.diagnostics.some((diagnostic) =>
          diagnostic.code === "CUT2070"
          && /PictureTrack accepts direct editorial node items only/u.test(diagnostic.message)),
      `dynamic Precomp presentation must fail source-located before materialization: ${JSON.stringify(
        dynamicFailure instanceof CutCompileError
          ? dynamicFailure.result.diagnostics
          : Object.values(dynamicIr?.nodes ?? {})
              .filter((node) => node.op === "cut.visual.precomp")
              .map((node) => ({ id: node.id, inputs: node.inputs, properties: node.properties })),
      )}`,
    );

    const unknownInput = parseCutLanguage(placementSource(true).replace(
      "          source: insert,",
      '          source: insert, forgedPresentation: "forged",',
    ));
    assert.ok(unknownInput.module);
    const unknownInputDiagnostics = checkCutModule(unknownInput.module).diagnostics;
    assert.ok(
      unknownInputDiagnostics.some((diagnostic) =>
        diagnostic.code === "CUT2059"
        && /forgedPresentation/u.test(diagnostic.message)),
      `unknown Precomp input must fail source-located before materialization: ${JSON.stringify(
        unknownInputDiagnostics,
      )}`,
    );

    const linkedOperand = parseCutLanguage(placementSource(true).replace(
      "operand: editOperand(parts: [",
      'operand: editOperand(linkId: "nested-link", parts: [',
    ));
    assert.ok(linkedOperand.module);
    assert.throws(
      () => compileCutModule(linkedOperand.module!),
      (error: unknown) => error instanceof CutCompileError
        && error.result.diagnostics.some((diagnostic) =>
          diagnostic.code === "CUT_TIMELINE_EDIT_UNSUPPORTED"
          && /unlinked static Precomp/u.test(diagnostic.message)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict loading and central validation reject forged nested ancestry/ranges before rendering", () => {
  const ir = compile("extract");
  const missingComposition = structuredClone(ir);
  const missingView = missingComposition.timelineEdits![0]!.tracks[0]!.items.find((item) =>
    item.sourceView.kind === "nested")!.sourceView;
  assert.equal(missingView.kind, "nested");
  if (missingView.kind === "nested") {
    (missingView as { compositionId: string }).compositionId = "missing-composition";
  }
  assert.throws(
    () => loadCutAvIr(JSON.stringify(missingComposition)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_REFERENCE"
      && /compositionId/u.test(error.path),
  );

  const cycle = structuredClone(ir);
  const cycleTrack = pictureTrack(cycle);
  const cycleChild = cycle.nodes[cycleTrack.editorial.items.find((item) => item.kind === "picture")!.nodeId]!;
  cycleChild.inputs.source = { kind: "timeline-ref", id: "main" };
  assert.throws(
    () => validateReferenceSession(cycle),
    (error: unknown) => error instanceof ReferencePrecompError
      && error.code === "CUT_PRECOMP_CYCLE",
  );

  const shifted = structuredClone(ir);
  const shiftedTrack = pictureTrack(shifted);
  const shiftedItem = shiftedTrack.editorial.items.find((item) => item.kind === "picture")!;
  const shiftedChild = shifted.nodes[shiftedItem.nodeId]!;
  shiftedChild.inputs.range = {
    kind: "range",
    start: { kind: "quantity", dimension: "time", magnitude: rational(1, 2), unit: "s" },
    end: {
      kind: "quantity",
      dimension: "time",
      magnitude: addRational(rational(1, 2), shiftedItem.source!.duration),
      unit: "s",
    },
    exclusive: true,
  };
  assert.throws(
    () => validateReferenceSession(shifted),
    (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
      && error.code === "CUT_TIMELINE_EDIT_RESULT"
      && /selected range/u.test(error.message),
  );
});

test("inspect, semantic diff, and localized picture cache bind nested composition and local intervals", () => {
  const before = compile("split");
  const repeat = compile("split");
  assert.equal(sceneKey(repeat), sceneKey(before));
  assert.deepEqual(diffCutAVIR(before, repeat).changes, []);
  const inspection = inspectCutIr(before, "nested-precomp.cut").timelineEdits?.[0];
  assert.equal(inspection?.tracks[0]?.items[0]?.sourceView.kind, "nested");
  assert.equal(
    inspection?.tracks[0]?.items[0]?.sourceView.kind === "nested"
      ? inspection.tracks[0].items[0].sourceView.compositionId
      : undefined,
    "insert",
  );

  const changedRange = compile("split", "500ms ..< 2500ms");
  const changedRangeDiff = diffCutAVIR(before, changedRange).changes.find((change) =>
    change.entity === "timeline-edit" && change.id === "nested-split");
  assert.equal(changedRangeDiff?.operation, "modify");
  assert.notEqual(sceneKey(changedRange), sceneKey(before));

  const changedSource = compile("split").timelineEdits![0]!;
  const hostile = structuredClone(before);
  const view = hostile.timelineEdits![0]!.tracks[0]!.items[0]!.sourceView;
  assert.equal(view.kind, "nested");
  if (view.kind === "nested") {
    (view as { compositionId: string }).compositionId = "unrelated";
  }
  const diff = diffCutAVIR(before, hostile).changes.find((change) =>
    change.entity === "timeline-edit" && change.id === changedSource.id);
  assert.equal(diff?.operation, "modify");
  assert.notEqual(sceneKey(hostile), sceneKey(before));

  const placement = compilePlacement();
  const changedPolicy = structuredClone(placement);
  const placementView = changedPolicy.timelineEdits![0]!.tracks[0]!.items
    .find((item) => item.originId === "nested-source")!.sourceView;
  assert.equal(placementView.kind, "nested");
  if (placementView.kind === "nested") {
    (placementView as { placementPolicy: string }).placementPolicy =
      "structural-only";
  }
  assert.equal(
    diffCutAVIR(placement, changedPolicy).changes.find((change) =>
      change.entity === "timeline-edit"
      && change.id === "nested-placement")?.operation,
    "modify",
  );
  assert.notEqual(
    sceneKey(changedPolicy),
    sceneKey(placement),
    "placement policy is a first-class localized picture-cache identity input",
  );
});

test("the nested placementPolicy schema remains closed and matches strict loading", () => {
  const schema = JSON.parse(readFileSync(
    resolve(process.cwd(), "schemas/cut-av-ir-v3.schema.json"),
    "utf8",
  )) as {
    $defs: {
      timelineEditSourceView: {
        oneOf: Array<{
          properties?: {
            kind?: { const?: string };
            placementPolicy?: { enum?: string[] };
          };
        }>;
      };
    };
  };
  const nested = schema.$defs.timelineEditSourceView.oneOf.find((candidate) =>
    candidate.properties?.kind?.const === "nested");
  assert.deepEqual(
    nested?.properties?.placementPolicy?.enum,
    ["structural-only", "static-same-track-copy"],
  );
});
