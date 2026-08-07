import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Ajv from "ajv";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IREditorialInterval, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { validateReferenceLinkedEditTransactions } from "../lib/runtime/reference/linked-edit";
import { ReferenceLinkedRippleDeleteError } from "../lib/runtime/reference/linked-ripple-delete";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { inspectCutIr } from "../lib/runtime/inspect";
import { finalizeGraphHashes } from "../lib/runtime/graph";

const exec = promisify(execFile);

type PictureTrack = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrack = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };
type SegmentIds = { before: string; after: string };
type RippleV2 = {
  id: string;
  version: 2;
  kind: "linked-ripple-delete";
  sceneId: string;
  pictureTrackId: string;
  audioTrackId: string;
  linkId: string;
  range: IREditorialInterval;
  linkSegmentIds: SegmentIds;
};
type SegmentItem = {
  nodeId: string;
  kind: string;
  destination: IREditorialInterval;
  source?: IREditorialInterval;
  linkId?: string;
  linkSegmentId?: string;
};

const v2Source = `cut 0.4;
project "partial J L ripple";
import { LinkedRippleDelete, Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("source.mkv");
asset voice: AudioAsset = audio("source.wav");
timeline main(duration: 5s, fps: 4, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 5s) {
    LinkedRippleDelete(link: "take", range: 2s ..< 3s);
    Sequence(duration: 5s) { PictureTrack() {
      PictureClip(source: picture, range: 0s ..< 1s, duration: 1s);
      PictureClip(source: picture, range: 1s ..< 4s, duration: 3s, link: "take");
      PictureClip(source: picture, range: 4s ..< 5s, duration: 1s);
    } }
    AudioTrack() {
      AudioClip(source: voice, range: 4s ..< 4500ms, destination: 0s ..< 500ms);
      AudioClip(source: voice, range: 0s ..< 4s, destination: 500ms ..< 4500ms, link: "take");
      AudioClip(source: voice, range: 4500ms ..< 5s, destination: 4500ms ..< 5s);
    }
  }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;

const v1Source = `cut 0.4;
project "complete ripple compatibility";
import { LinkedRippleDelete, Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("source.mkv");
asset voice: AudioAsset = audio("source.wav");
timeline main(duration: 4s, fps: 4, sampleRate: 48khz) {
  scene only(duration: 4s) {
    LinkedRippleDelete(link: "take");
    Sequence(duration: 4s) { PictureTrack() {
      PictureClip(source: picture, range: 0s ..< 1s, duration: 1s);
      PictureClip(source: picture, range: 1s ..< 2s, duration: 1s, link: "take");
      PictureClip(source: picture, range: 2s ..< 4s, duration: 2s);
    } }
    AudioTrack() {
      AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s);
      AudioClip(source: voice, range: 1s ..< 2s, destination: 1s ..< 2s, link: "take");
      AudioClip(source: voice, range: 2s ..< 4s, destination: 2s ..< 4s);
    }
  }
}
export out = render(main);`;

const twoTransactionSource = `cut 0.4;
project "two partial ripple groups";
import { LinkedRippleDelete, Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("source.mkv");
asset voice: AudioAsset = audio("source.wav");
timeline main(duration: 5s, fps: 4, sampleRate: 48khz) {
  scene only(duration: 5s) {
    LinkedRippleDelete(link: "take-a", range: 2s ..< 3s);
    LinkedRippleDelete(link: "take-b", range: 1500ms ..< 2500ms);
    Sequence(duration: 5s) { PictureTrack() {
      PictureClip(source: picture, range: 0s ..< 1s, duration: 1s);
      PictureClip(source: picture, range: 1s ..< 4s, duration: 3s, link: "take-a");
      PictureClip(source: picture, range: 4s ..< 5s, duration: 1s);
    } }
    AudioTrack() {
      AudioClip(source: voice, range: 4s ..< 4500ms, destination: 0s ..< 500ms);
      AudioClip(source: voice, range: 0s ..< 4s, destination: 500ms ..< 4500ms, link: "take-a");
      AudioClip(source: voice, range: 4500ms ..< 5s, destination: 4500ms ..< 5s);
    }
    Sequence(duration: 5s) { PictureTrack() {
      PictureClip(source: picture, range: 0s ..< 1s, duration: 1s);
      PictureClip(source: picture, range: 1s ..< 4s, duration: 3s, link: "take-b");
      PictureClip(source: picture, range: 4s ..< 5s, duration: 1s);
    } }
    AudioTrack() {
      AudioClip(source: voice, range: 4s ..< 4500ms, destination: 0s ..< 500ms);
      AudioClip(source: voice, range: 0s ..< 4s, destination: 500ms ..< 4500ms, link: "take-b");
      AudioClip(source: voice, range: 4500ms ..< 5s, destination: 4500ms ..< 5s);
    }
  }
}
export out = render(main);`;

function compile(program = v2Source) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function tracks(ir: CutAVIR) {
  const picture = Object.values(ir.nodes).find((node): node is PictureTrack => node.editorial?.kind === "picture-track");
  const audio = Object.values(ir.nodes).find((node): node is AudioTrack => node.editorial?.kind === "audio-track");
  assert.ok(picture);
  assert.ok(audio);
  return { picture, audio };
}

function transactionV2(ir: CutAVIR) {
  assert.equal(ir.linkedEdits?.length, 1);
  const value = ir.linkedEdits?.[0] as unknown as RippleV2;
  assert.equal(value.kind, "linked-ripple-delete");
  assert.equal(value.version, 2);
  return value;
}

function segmentItems(track: PictureTrack | AudioTrack) {
  return (track.editorial.items as SegmentItem[]).filter((item) => item.linkId === "take");
}

function rippleDeletion(track: PictureTrack | AudioTrack) {
  const operations = track.editorial.operationPlan?.operations as unknown as Array<Record<string, unknown>>;
  assert.equal(operations?.length, 2);
  assert.equal(operations[0].kind, "ripple-insert");
  assert.equal(operations[1].kind, "ripple-delete");
  return operations[1];
}

test("LinkedRippleDelete(range:) lowers J/L-aware partial deletion into correlated v2 typed IR and exact materialization", () => {
  const ir = compile();
  const edit = transactionV2(ir);
  const { picture, audio } = tracks(ir);
  assert.deepEqual(edit.range, { start: rational(2), duration: rational(1) });
  assert.match(edit.linkSegmentIds.before, /^linked_segment_before_[0-9a-f]{16}$/u);
  assert.match(edit.linkSegmentIds.after, /^linked_segment_after_[0-9a-f]{16}$/u);
  assert.notEqual(edit.linkSegmentIds.before, edit.linkSegmentIds.after);
  assert.equal(rippleDeletion(picture).transactionVersion, 2);
  assert.equal(rippleDeletion(audio).transactionVersion, 2);
  assert.deepEqual((rippleDeletion(picture) as { linkSegmentIds: SegmentIds }).linkSegmentIds, edit.linkSegmentIds);
  assert.deepEqual((rippleDeletion(audio) as { linkSegmentIds: SegmentIds }).linkSegmentIds, edit.linkSegmentIds);

  assert.deepEqual(picture.editorial.items.map((item) => [item.kind, item.destination, item.source]), [
    ["picture", { start: rational(0), duration: rational(1) }, { start: rational(0), duration: rational(1) }],
    ["picture", { start: rational(1), duration: rational(1) }, { start: rational(1), duration: rational(1) }],
    ["picture", { start: rational(2), duration: rational(1) }, { start: rational(3), duration: rational(1) }],
    ["picture", { start: rational(3), duration: rational(1) }, { start: rational(4), duration: rational(1) }],
    ["gap", { start: rational(4), duration: rational(1) }, undefined],
  ]);
  assert.deepEqual(audio.editorial.items.map((item) => [item.kind, item.destination, item.source]), [
    ["audio", { start: rational(0), duration: rational(1, 2) }, { start: rational(4), duration: rational(1, 2) }],
    ["audio", { start: rational(1, 2), duration: rational(3, 2) }, { start: rational(0), duration: rational(3, 2) }],
    ["audio", { start: rational(2), duration: rational(3, 2) }, { start: rational(5, 2), duration: rational(3, 2) }],
    ["audio", { start: rational(7, 2), duration: rational(1, 2) }, { start: rational(9, 2), duration: rational(1, 2) }],
    ["gap", { start: rational(4), duration: rational(1) }, undefined],
  ]);

  const pictureSegments = segmentItems(picture), audioSegments = segmentItems(audio);
  assert.equal(pictureSegments.length, 2);
  assert.equal(audioSegments.length, 2);
  assert.deepEqual(pictureSegments.map((item) => item.linkSegmentId), [edit.linkSegmentIds.before, edit.linkSegmentIds.after]);
  assert.deepEqual(audioSegments.map((item) => item.linkSegmentId), [edit.linkSegmentIds.before, edit.linkSegmentIds.after]);
  for (const item of [...pictureSegments, ...audioSegments]) {
    const child = ir.nodes[item.nodeId];
    assert.equal(child.inputs.link?.kind, "string");
    assert.equal(child.inputs.link?.kind === "string" ? child.inputs.link.value : undefined, "take", "authored linkId remains the public relationship group");
  }
  for (const item of [...picture.editorial.items, ...audio.editorial.items] as SegmentItem[]) {
    if (item.linkId !== "take") assert.equal(item.linkSegmentId, undefined, "segment identity is not leaked onto unrelated material");
  }
  assert.doesNotThrow(() => validateCutAvIr(structuredClone(ir)));

  const formatted = compile(v2Source.replace("    LinkedRippleDelete", "    // partial coupled deletion\n    LinkedRippleDelete"));
  assert.equal(transactionV2(formatted).id, edit.id);
  assert.deepEqual(transactionV2(formatted).linkSegmentIds, edit.linkSegmentIds);
  assert.equal(formatted.buildId, ir.buildId, "comments do not perturb transaction, segment, or build identity");
});

test("omitting range preserves the closed complete-pair v1 contract while explicit range is checked on both clocks", () => {
  const v1 = compile(v1Source);
  const edit = v1.linkedEdits?.[0] as unknown as Record<string, unknown>;
  assert.equal(edit.version, 1);
  assert.equal(Object.hasOwn(edit, "linkSegmentIds"), false);
  assert.equal(rippleDeletion(tracks(v1).picture).transactionVersion, 1);
  assert.equal(rippleDeletion(tracks(v1).audio).transactionVersion, 1);
  assert.equal(segmentItems(tracks(v1).picture).length, 0);
  assert.equal(segmentItems(tracks(v1).audio).length, 0);
  assert.doesNotThrow(() => validateCutAvIr(structuredClone(v1)));

  const diagnostic = (program: string, code: string) => assert.throws(
    () => compile(program),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === code),
  );
  diagnostic(v2Source.replace(", range: 2s ..< 3s", ""), "CUT_LINKED_RIPPLE_TIME");
  diagnostic(v2Source.replace("range: 2s ..< 3s", "range: 250ms ..< 1250ms"), "CUT_LINKED_RIPPLE_TIME");
  diagnostic(v2Source.replace("range: 2s ..< 3s", "range: 2001ms ..< 3s"), "CUT_LINKED_RIPPLE_TIME");
  diagnostic(v2Source.replace("range: 2s ..< 3s", "range: 2s ..< 2s"), "CUT_LINKED_RIPPLE_TIME");
  for (const treatment of ["opacity: 50%", "scale: 1.1", "rotation: 5deg", 'fit: "contain"']) {
    diagnostic(v2Source.replace('duration: 3s, link: "take"', `duration: 3s, ${treatment}, link: "take"`), "CUT_LINKED_RIPPLE_UNSUPPORTED");
  }
});

test("the public CutAVIR schema admits canonical v2 and closes transaction, operation, and survivor segment fields", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const ajv = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true });
  const validate = ajv.compile(schema), canonical = compile();
  assert.equal(validate(canonical), true, JSON.stringify(validate.errors));

  const unknown = structuredClone(canonical);
  ((unknown.linkedEdits?.[0] as unknown as RippleV2).linkSegmentIds as unknown as Record<string, unknown>).ignored = true;
  assert.equal(validate(unknown), false);

  const missing = structuredClone(canonical);
  delete (missing.linkedEdits?.[0] as unknown as Partial<RippleV2>).linkSegmentIds;
  assert.equal(validate(missing), false);

  const operationUnknown = structuredClone(canonical), { picture } = tracks(operationUnknown);
  ((rippleDeletion(picture) as { linkSegmentIds: SegmentIds }).linkSegmentIds as unknown as Record<string, unknown>).ignored = true;
  assert.equal(validate(operationUnknown), false);

  for (const kind of ["picture", "audio"] as const) {
    const missingTransaction = structuredClone(canonical), selected = tracks(missingTransaction)[kind];
    delete (rippleDeletion(selected) as { transactionId?: string }).transactionId;
    assert.equal(validate(missingTransaction), false, `${kind} segment correlation requires transactionId`);

    const missingSegments = structuredClone(canonical), versioned = tracks(missingSegments)[kind];
    delete (rippleDeletion(versioned) as { linkSegmentIds?: SegmentIds }).linkSegmentIds;
    assert.equal(validate(missingSegments), false, `${kind} transactionVersion 2 requires segment correlation`);
  }

  const sameRoles = structuredClone(canonical), sameRoleEdit = transactionV2(sameRoles);
  sameRoleEdit.linkSegmentIds.after = sameRoleEdit.linkSegmentIds.before;
  assert.equal(validate(sameRoles), false, "schema-distinct role prefixes prevent identical before/after ids");

  for (const kind of ["picture", "audio"] as const) {
    const orphanItem = structuredClone(canonical), selected = tracks(orphanItem)[kind];
    const survivor = segmentItems(selected)[0];
    delete survivor.linkId;
    assert.equal(validate(orphanItem), false, `${kind} materialized segment requires authored linkId`);

    const orphanPlan = structuredClone(canonical), planTrack = tracks(orphanPlan)[kind];
    const base = planTrack.editorial.operationPlan!.baseItems.find((item) => "inputs" in item && (kind === "picture"
      ? item.kind === "picture" && item.inputs.link?.kind === "string"
      : item.kind === "clip" && item.inputs.linkId === "take"));
    assert.ok(base && "inputs" in base);
    (base as unknown as { linkSegmentId: string }).linkSegmentId = transactionV2(orphanPlan).linkSegmentIds.before;
    if (kind === "picture") delete (base.inputs as Record<string, unknown>).link;
    else delete (base.inputs as Record<string, unknown>).linkId;
    assert.equal(validate(orphanPlan), false, `${kind} plan segment requires authored link metadata`);
  }
});

test("inspect and semantic diff expose v2 transaction and survivor segment identity", () => {
  const original = compile(), edit = transactionV2(original), report = inspectCutIr(original, "project.cut");
  const inspected = report.linkedEdits[0] as unknown as RippleV2;
  assert.deepEqual(inspected.linkSegmentIds, edit.linkSegmentIds);
  const pictureProjection = report.graph.nodes.find((node) => node.op === "cut.edit.picture_track")?.pictureEditorial;
  const audioProjection = report.graph.nodes.find((node) => node.op === "cut.edit.audio_track")?.editorial;
  assert.deepEqual(pictureProjection?.items.filter((item) => item.linkId === "take").map((item) => item.linkSegmentId), [edit.linkSegmentIds.before, edit.linkSegmentIds.after]);
  assert.deepEqual(audioProjection?.items.filter((item) => item.linkId === "take").map((item) => item.linkSegmentId), [edit.linkSegmentIds.before, edit.linkSegmentIds.after]);

  const commentOnly = compile(v2Source.replace("    LinkedRippleDelete", "    // semantic whitespace\n    LinkedRippleDelete"));
  assert.equal(diffCutAVIR(original, commentOnly).summary.total, 0);
  const moved = compile(v2Source.replace("range: 2s ..< 3s", "range: 1500ms ..< 2500ms"));
  const diff = diffCutAVIR(original, moved);
  assert.equal(diff.summary.byEntity["linked-edit"]?.remove, 1);
  assert.equal(diff.summary.byEntity["linked-edit"]?.add, 1);
  assert.notDeepEqual(transactionV2(moved).linkSegmentIds, edit.linkSegmentIds);
});

test("strict CutAVIR closes segment-role correlation and recomputes deterministic v2 segment identities", () => {
  const rejected = (mutate: (ir: CutAVIR, edit: RippleV2, picture: PictureTrack, audio: AudioTrack) => void, path: RegExp) => {
    const ir = structuredClone(compile());
    const edit = transactionV2(ir);
    const { picture, audio } = tracks(ir);
    mutate(ir, edit, picture, audio);
    assert.throws(
      () => validateCutAvIr(ir),
      (error: unknown) => error instanceof CutAvIrValidationError
        && error.code === "CUT_IR_IDENTITY"
        && path.test(error.path),
    );
  };

  rejected((_ir, edit) => {
    edit.linkSegmentIds.after = edit.linkSegmentIds.before;
  }, /linkedEdits\[0\]\.linkSegmentIds/u);

  rejected((_ir, _edit, picture) => {
    (rippleDeletion(picture) as { linkSegmentIds: SegmentIds }).linkSegmentIds.after = "linked_segment_forged";
  }, /operationPlan\.operations\[1\]\.linkSegmentIds/u);

  rejected((_ir, _edit, picture) => {
    (rippleDeletion(picture) as { transactionVersion: number }).transactionVersion = 1;
  }, /operationPlan\.operations\[1\]\.(?:transactionVersion|linkSegmentIds)/u);

  rejected((_ir, _edit, _picture, audio) => {
    delete (rippleDeletion(audio) as { linkSegmentIds?: SegmentIds }).linkSegmentIds;
  }, /operationPlan\.operations\[1\]\.linkSegmentIds/u);

  rejected((_ir, edit, _picture, audio) => {
    segmentItems(audio)[1].linkSegmentId = edit.linkSegmentIds.before;
  }, /linkedEdits\[0\]|editorial\.items/u);

  rejected((_ir, edit, picture, audio) => {
    const forged = { before: "linked_segment_forged_before", after: "linked_segment_forged_after" };
    edit.linkSegmentIds = { ...forged };
    for (const track of [picture, audio]) {
      (rippleDeletion(track) as { linkSegmentIds: SegmentIds }).linkSegmentIds = { ...forged };
      const items = segmentItems(track);
      items[0].linkSegmentId = forged.before;
      items[1].linkSegmentId = forged.after;
    }
  }, /linkedEdits\[0\]\.linkSegmentIds/u);

  rejected((_ir, _edit, picture) => {
    const unrelated = (picture.editorial.items as SegmentItem[]).find((item) => item.linkId !== "take" && item.kind === "picture");
    assert.ok(unrelated);
    unrelated.linkSegmentId = "linked_segment_forged";
  }, /editorial\.items/u);

  rejected((ir, _edit, picture, audio) => {
    delete ir.linkedEdits;
    delete picture.editorial.operationPlan;
    delete audio.editorial.operationPlan;
    finalizeGraphHashes(ir);
  }, /linkSegmentId/u);

  rejected((_ir, edit) => {
    edit.linkId = "different-group";
  }, /linkedEdits\[0\]\.(?:linkId|pictureTrackId)/u);

  rejected((ir, edit, picture, audio) => {
    const attachOtherGroup = (track: PictureTrack | AudioTrack) => {
      const item = (track.editorial.items as SegmentItem[]).find((candidate) => candidate.linkId !== "take" && candidate.kind !== "gap");
      assert.ok(item);
      item.linkId = "other-group";
      item.linkSegmentId = edit.linkSegmentIds.before;
      const node = ir.nodes[item.nodeId];
      node.inputs.link = { kind: "string", value: "other-group" };
      const base = track.editorial.operationPlan!.baseItems.find((candidate) => candidate.destination.start.numerator === "0");
      assert.ok(base);
      const inputs = base.inputs as Record<string, unknown>;
      if (track.editorial.kind === "picture-track") {
        inputs.link = { kind: "string", value: "other-group" };
        (base as unknown as { linkSegmentId: string }).linkSegmentId = edit.linkSegmentIds.before;
      } else {
        inputs.linkId = "other-group";
        (base as unknown as { linkSegmentId: string }).linkSegmentId = edit.linkSegmentIds.before;
      }
    };
    attachOtherGroup(picture);
    attachOtherGroup(audio);
    finalizeGraphHashes(ir);
  }, /linkSegmentId/u);

  rejected((_ir, _edit, picture, audio) => {
    delete segmentItems(picture)[0].linkSegmentId;
    delete segmentItems(audio)[0].linkSegmentId;
  }, /linkedEdits\[0\]|editorial\.items/u);

  rejected((_ir, _edit, picture) => {
    const base = picture.editorial.operationPlan!.baseItems.find((item) => item.kind === "picture" && item.inputs.link?.kind === "string");
    assert.ok(base && base.kind === "picture");
    base.inputs.opacity = { kind: "quantity", dimension: "ratio", magnitude: rational(1, 2), unit: "ratio" };
  }, /linkedEdits\[0\]\.pictureTrackId/u);

  rejected((_ir, _edit, picture) => {
    const base = picture.editorial.operationPlan!.baseItems.find((item) => item.kind === "picture" && item.inputs.link?.kind === "string");
    assert.ok(base && base.kind === "picture");
    base.timeMap = { kind: "constant", direction: "reverse", rate: rational(1) };
    base.inputs.playback = { kind: "string", value: "reverse" };
  }, /linkedEdits\[0\]\.pictureTrackId/u);

  const twoScenes = compile(v2Source
    .replace("timeline main(duration: 5s", "timeline main(duration: 10s")
    .replace("\n  }\n}\nexport out =", "\n  }\n  scene spare(duration: 5s) {}\n}\nexport out ="));
  const wrongScene = transactionV2(twoScenes);
  const spare = twoScenes.compositions[0].sceneIds.find((id) => id !== wrongScene.sceneId);
  assert.ok(spare);
  wrongScene.sceneId = spare;
  assert.throws(
    () => validateCutAvIr(twoScenes),
    (error: unknown) => error instanceof CutAvIrValidationError
      && ["CUT_IR_IDENTITY", "CUT_IR_TYPE"].includes(error.code)
      && /linkedEdits\[0\]\.(?:sceneId|pictureTrackId|audioTrackId)/u.test(error.path),
  );

  const reused = structuredClone(compile(twoTransactionSource));
  const edits = reused.linkedEdits as unknown as RippleV2[];
  assert.equal(edits.length, 2);
  const first = edits[0], second = edits[1], originalSecond = { ...second.linkSegmentIds };
  second.linkSegmentIds = { ...first.linkSegmentIds };
  for (const trackId of [second.pictureTrackId, second.audioTrackId]) {
    const track = reused.nodes[trackId] as PictureTrack | AudioTrack;
    (rippleDeletion(track) as { linkSegmentIds: SegmentIds }).linkSegmentIds = { ...first.linkSegmentIds };
    for (const item of track.editorial.items as SegmentItem[]) {
      if (item.linkSegmentId === originalSecond.before) item.linkSegmentId = first.linkSegmentIds.before;
      if (item.linkSegmentId === originalSecond.after) item.linkSegmentId = first.linkSegmentIds.after;
    }
  }
  finalizeGraphHashes(reused);
  assert.throws(
    () => validateCutAvIr(reused),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_IDENTITY"
      && /linkedEdits\[1\]\.linkSegmentIds|linkSegmentId/u.test(error.path),
  );
});

test("runtime remaps transaction, operation, and survivor correlation failures to stable located diagnostics", () => {
  const expectLocatedCorrelation = (mutate: (ir: CutAVIR, edit: RippleV2, picture: PictureTrack, audio: AudioTrack) => void, expectedTrackId?: (tracks: { picture: PictureTrack; audio: AudioTrack }) => string) => {
    const ir = structuredClone(compile()), edit = transactionV2(ir), selected = tracks(ir);
    mutate(ir, edit, selected.picture, selected.audio);
    finalizeGraphHashes(ir);
    assert.throws(
      () => validateReferenceLinkedEditTransactions(ir, ir.compositions[0]),
      (error: unknown) => error instanceof ReferenceLinkedRippleDeleteError
        && error.code === "CUT_LINKED_RIPPLE_CORRELATION"
        && error.source.module === (ir.linkedEdits?.[0]?.provenance.module ?? "")
        && error.source.line === (ir.linkedEdits?.[0]?.provenance.span.start.line ?? -1)
        && error.source.column === (ir.linkedEdits?.[0]?.provenance.span.start.column ?? -1)
        && error.source.transactionId === edit.id
        && (expectedTrackId === undefined || error.source.trackId === expectedTrackId(selected)),
    );
  };

  expectLocatedCorrelation((_ir, edit) => {
    edit.linkSegmentIds.after = edit.linkSegmentIds.before;
  });
  expectLocatedCorrelation((_ir, _edit, picture) => {
    (rippleDeletion(picture) as { linkSegmentIds: SegmentIds }).linkSegmentIds.after = "linked_segment_after_0000000000000000";
  }, ({ picture }) => picture.id);
  expectLocatedCorrelation((_ir, _edit, picture) => {
    (rippleDeletion(picture) as { transactionVersion: number }).transactionVersion = 1;
  }, ({ picture }) => picture.id);
  expectLocatedCorrelation((_ir, edit, _picture, audio) => {
    segmentItems(audio)[1].linkSegmentId = edit.linkSegmentIds.before;
  }, ({ audio }) => audio.id);

  for (const mutate of [
    (base: Extract<PictureTrack["editorial"]["operationPlan"], object>["baseItems"][number]) => {
      if (base.kind !== "picture") throw new Error("expected picture base");
      base.inputs.opacity = { kind: "quantity", dimension: "ratio", magnitude: rational(1, 2), unit: "ratio" };
    },
    (base: Extract<PictureTrack["editorial"]["operationPlan"], object>["baseItems"][number]) => {
      if (base.kind !== "picture") throw new Error("expected picture base");
      base.timeMap = { kind: "constant", direction: "reverse", rate: rational(1) };
      base.inputs.playback = { kind: "string", value: "reverse" };
    },
  ]) {
    const ir = structuredClone(compile()), edit = transactionV2(ir), selected = tracks(ir), provenance = ir.linkedEdits![0].provenance;
    const base = selected.picture.editorial.operationPlan!.baseItems.find((item) => item.kind === "picture" && item.inputs.link?.kind === "string");
    assert.ok(base);
    mutate(base);
    finalizeGraphHashes(ir);
    assert.throws(
      () => validateReferenceLinkedEditTransactions(ir, ir.compositions[0]),
      (error: unknown) => error instanceof ReferenceLinkedRippleDeleteError
        && error.code === "CUT_LINKED_RIPPLE_PLAN"
        && error.source.module === provenance.module
        && error.source.line === provenance.span.start.line
        && error.source.column === provenance.span.start.column
        && error.source.transactionId === edit.id,
    );
  }
});

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function pcm24Data(buffer: Buffer) {
  let offset = 12, sampleRate = 0, blockAlign = 0, bits = 0;
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") {
      sampleRate = buffer.readUInt32LE(body + 4);
      blockAlign = buffer.readUInt16LE(body + 12);
      bits = buffer.readUInt16LE(body + 14);
    }
    if (id === "data") {
      data = buffer.subarray(body, body + size);
      break;
    }
    offset = body + size + (size % 2);
  }
  assert.deepEqual({ sampleRate, blockAlign, bits }, { sampleRate: 48_000, blockAlign: 6, bits: 24 });
  return {
    frames: data.length / blockAlign,
    sample(frame: number, channel = 0) {
      const position = frame * blockAlign + channel * 3;
      let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

function center(surface: { data: Buffer; width: number; height: number }) {
  const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function nearColor(actual: readonly number[], expected: readonly number[]) {
  expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) <= 3, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`));
}

async function lockedProject() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-ripple-v2-"));
  const colors = [[64, 0, 0], [0, 96, 0], [0, 0, 128], [160, 160, 0], [192, 0, 192]];
  const rawFrames = Buffer.concat(colors.flatMap((color) => Array.from(
    { length: 4 },
    () => Buffer.from(Array.from({ length: 16 * 16 }, () => color).flat()),
  )));
  const rawPath = resolve(root, "source.rgb");
  await writeFile(rawPath, rawFrames);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "16x16", "-framerate", "4", "-i", rawPath,
    "-frames:v", "20", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrp", resolve(root, "source.mkv"),
  ]);
  const halfSecond = 24_000;
  const amplitudes = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000];
  await writeFile(resolve(root, "source.wav"), monoPcm16Wave(48_000, amplitudes.flatMap((amplitude) => Array.from({ length: halfSecond }, () => amplitude))));
  const ir = compile();
  await applyCutLock(ir, await createCutLock(ir, root), root);
  return { root, ir, composition: ir.compositions[0], scene: ir.scenes[ir.compositions[0].sceneIds[0]] };
}

test("locked picture/audio runtimes execute the same partial J/L ripple and audio cache is cold, warm, and range-sensitive", { timeout: 90_000 }, async () => {
  const project = await lockedProject();
  try {
    const { root, ir, composition, scene } = project;
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const edit = transactionV2(ir);
    const authorization = validateReferenceLinkedEditTransactions(ir, composition).byTransactionId.get(edit.id);
    assert.ok(authorization && "range" in authorization);
    assert.deepEqual((authorization as unknown as { linkSegmentIds: SegmentIds }).linkSegmentIds, edit.linkSegmentIds);
    assert.deepEqual((authorization as unknown as { picture: { linkSegmentIds: SegmentIds } }).picture.linkSegmentIds, edit.linkSegmentIds);
    assert.deepEqual((authorization as unknown as { audio: { linkSegmentIds: SegmentIds } }).audio.linkSegmentIds, edit.linkSegmentIds);
    assert.equal(Object.isFrozen((authorization as unknown as { linkSegmentIds: SegmentIds }).linkSegmentIds), true);
    assert.equal(Object.isFrozen((authorization as unknown as { picture: { linkSegmentIds: SegmentIds } }).picture.linkSegmentIds), true);
    assert.equal(Object.isFrozen((authorization as unknown as { audio: { linkSegmentIds: SegmentIds } }).audio.linkSegmentIds), true);

    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "visual-cache"));
    await renderer.prepare();
    try {
      const expected = [
        [64, 0, 0, 255], [64, 0, 0, 255],
        [0, 96, 0, 255], [0, 96, 0, 255],
        [160, 160, 0, 255], [160, 160, 0, 255],
        [192, 0, 192, 255], [192, 0, 192, 255],
        [0, 0, 0, 0], [0, 0, 0, 0],
      ];
      const frames = [0, 3, 4, 7, 8, 11, 12, 15, 16, 19];
      for (const [index, frame] of frames.entries()) nearColor(center(await renderer.sceneFrame(scene, frame, false)), expected[index]);
    } finally {
      renderer.close();
    }

    const output = resolve(root, "v2-ripple.wav");
    await renderReferenceAudio(ir, composition, root, output);
    const decoded = pcm24Data(await readFile(output));
    assert.equal(decoded.frames, 240_000);
    const monoToStereo = Math.SQRT1_2 / 32_768;
    const near = (frame: number, expected: number) => assert.ok(
      Math.abs(decoded.sample(frame) - expected * monoToStereo) < .002,
      `sample ${frame}: ${decoded.sample(frame)} != ${expected * monoToStereo}`,
    );
    for (const [frame, amplitude] of [
      [0, 9_000], [23_999, 9_000],
      [24_000, 1_000], [47_999, 1_000],
      [48_000, 2_000], [71_999, 2_000],
      [72_000, 3_000], [95_999, 3_000],
      [96_000, 6_000], [119_999, 6_000],
      [120_000, 7_000], [143_999, 7_000],
      [144_000, 8_000], [167_999, 8_000],
      [168_000, 10_000], [191_999, 10_000],
      [192_000, 0], [239_999, 0],
    ] as const) near(frame, amplitude);

    const cold = await renderReferenceAudioArtifact(ir, composition, root);
    const warm = await renderReferenceAudioArtifact(ir, composition, root);
    assert.deepEqual({ status: cold.cache.status, reason: cold.cache.reason }, { status: "miss", reason: "CUT_AUDIO_CACHE_COLD" });
    assert.deepEqual({ status: warm.cache.status, reason: warm.cache.reason }, { status: "hit", reason: "CUT_AUDIO_CACHE_HIT" });
    assert.equal(warm.cache.key, cold.cache.key);
    assert.equal(warm.cache.artifact.sha256, cold.cache.artifact.sha256);

    const moved = compile(v2Source.replace("range: 2s ..< 3s", "range: 1500ms ..< 2500ms"));
    await applyCutLock(moved, await createCutLock(moved, root), root);
    const changed = await renderReferenceAudioArtifact(moved, moved.compositions[0], root);
    assert.equal(changed.cache.status, "miss");
    assert.notEqual(changed.cache.key, cold.cache.key);
    assert.notEqual(changed.cache.artifact.sha256, cold.cache.artifact.sha256);
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("orphan v2 survivor metadata is refused before direct picture, audio, or warm-cache publication", { timeout: 90_000 }, async () => {
  const project = await lockedProject();
  try {
    const { root, ir, composition } = project;
    const cold = await renderReferenceAudioArtifact(ir, composition, root);
    const warm = await renderReferenceAudioArtifact(ir, composition, root);
    assert.equal(cold.cache.status, "miss");
    assert.equal(warm.cache.status, "hit");

    const hostile = structuredClone(ir);
    const hostileTracks = tracks(hostile);
    delete hostile.linkedEdits;
    delete hostileTracks.picture.editorial.operationPlan;
    delete hostileTracks.audio.editorial.operationPlan;
    assert.equal(segmentItems(hostileTracks.picture).length, 2);
    assert.equal(segmentItems(hostileTracks.audio).length, 2);
    finalizeGraphHashes(hostile);

    const trackIds = new Set([hostileTracks.picture.id, hostileTracks.audio.id]);
    const refusal = (error: unknown) => error instanceof ReferenceLinkedRippleDeleteError
      && error.code === "CUT_LINKED_RIPPLE_MATERIALIZATION"
      && /survivor ownership/u.test(error.message)
      && error.source.module.length > 0
      && error.source.line > 0
      && error.source.column > 0
      && error.source.trackId !== undefined
      && trackIds.has(error.source.trackId);

    const visualCache = resolve(root, "orphan-survivor-visual-cache");
    assert.throws(
      () => new ReferenceVisualRenderer(hostile, hostile.compositions[0], root, visualCache),
      refusal,
    );
    await assert.rejects(access(visualCache), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    const output = resolve(root, "orphan-survivor-must-not-publish.wav");
    await assert.rejects(
      renderReferenceAudio(hostile, hostile.compositions[0], root, output),
      refusal,
    );
    await assert.rejects(access(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    await assert.rejects(
      renderReferenceAudioArtifact(hostile, hostile.compositions[0], root),
      refusal,
    );
    const afterRefusal = await renderReferenceAudioArtifact(ir, composition, root);
    assert.equal(afterRefusal.cache.status, "hit");
    assert.equal(afterRefusal.cache.key, warm.cache.key);
    assert.equal(afterRefusal.cache.artifact.sha256, warm.cache.artifact.sha256);
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("OTIO reports the v2 atomic ripple and segment correlation as structured loss", () => {
  const ir = compile();
  const edit = transactionV2(ir);
  const exported = exportCutTimelineToOtio(ir);
  const issues = exported.report.unsupportedSemantics.filter((item) => item.code === "CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED");
  assert.equal(issues.length, 1);
  assert.equal(exported.report.status, "lossy-editorial");
  assert.deepEqual(issues[0].subject, {
    kind: "linked-edit",
    id: edit.id,
    op: "cut.edit.linked_ripple_delete",
    property: "atomic-ripple-correlation",
  });
  assert.ok(issues[0].message.includes(edit.id));
  assert.ok(issues[0].message.includes('link "take"'));
  assert.ok(issues[0].message.includes("2/1s + 1/1s"));
  const persisted = ((JSON.parse(JSON.stringify(exported.timeline)).metadata.cut as { interchange_report: typeof exported.report }).interchange_report)
    .unsupportedSemantics.find((item) => item.code === "CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED");
  assert.deepEqual(persisted, issues[0]);
});
