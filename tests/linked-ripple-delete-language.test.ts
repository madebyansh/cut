import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import {
  compileCutModule,
  CutCompileError,
  LinkedRippleDeleteError,
  stageLinkedRippleDeleteTransactions,
  type LinkedRippleDeleteRequest,
} from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) { return compileCutModule(moduleFor(source)).ir; }

type PictureTrack = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrack = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };

function tracks(ir: CutAVIR) {
  const picture = Object.values(ir.nodes).find((node): node is PictureTrack => node.editorial?.kind === "picture-track");
  const audio = Object.values(ir.nodes).find((node): node is AudioTrack => node.editorial?.kind === "audio-track");
  assert.ok(picture);
  assert.ok(audio);
  return { picture, audio };
}

function linkedProgram(options: { statement?: string; statementAfter?: boolean; start?: string; end?: string; audioStart?: string; audioEnd?: string } = {}) {
  const statement = options.statement ?? 'LinkedRippleDelete(link: "drop");';
  const start = options.start ?? "1s", end = options.end ?? "2s";
  const audioStart = options.audioStart ?? start, audioEnd = options.audioEnd ?? end;
  return `cut 0.4;
project "linked ripple delete";
import { LinkedRippleDelete, Sequence, PictureTrack, PictureClip, Gap, AudioTrack, AudioGap } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 4, sampleRate: 48khz) {
  scene only(duration: 4s) {
    ${options.statementAfter ? "" : statement}
    Sequence(duration: 4s) { PictureTrack() {
      PictureClip(source: picture, range: 0s ..< ${start}, duration: ${start});
      PictureClip(source: picture, range: ${start} ..< ${end}, duration: ${end} - ${start}, link: "drop");
      PictureClip(source: picture, range: ${end} ..< 4s, duration: 4s - ${end});
    } }
    AudioTrack() {
      AudioClip(source: voice, range: 0s ..< ${audioStart}, destination: 0s ..< ${audioStart});
      AudioClip(source: voice, range: ${audioStart} ..< ${audioEnd}, destination: ${audioStart} ..< ${audioEnd}, link: "drop");
      AudioClip(source: voice, range: ${audioEnd} ..< 4s, destination: ${audioEnd} ..< 4s);
    }
    ${options.statementAfter ? statement : ""}
  }
}
export out = render(main);`;
}

function transaction(ir: CutAVIR) {
  assert.equal(ir.linkedEdits?.length, 1);
  const value = ir.linkedEdits![0];
  assert.equal(value.kind, "linked-ripple-delete");
  if (value.kind !== "linked-ripple-delete") throw new Error("expected linked-ripple-delete");
  return value;
}

test("LinkedRippleDelete lowers one public argument into typed four-operation fixed-duration closure", () => {
  const ir = compile(linkedProgram()), edit = transaction(ir), { picture, audio } = tracks(ir);
  assert.deepEqual(edit.range, { start: rational(1), duration: rational(1) });
  assert.equal(edit.pictureTrackId, picture.id);
  assert.equal(edit.audioTrackId, audio.id);
  assert.equal(Object.values(ir.nodes).some((node) => node.op === "cut.edit.linked_ripple_delete"), false, "the transaction is typed editorial IR, not a fake render node");

  for (const track of [picture, audio]) {
    const operations = track.editorial.operationPlan?.operations;
    assert.equal(operations?.length, 2);
    assert.equal(operations?.[0].kind, "ripple-insert");
    assert.equal(operations?.[1].kind, "ripple-delete");
    const insertion = operations?.[0], deletion = operations?.[1];
    if (insertion?.kind !== "ripple-insert" || deletion?.kind !== "ripple-delete") return;
    assert.equal(insertion.transactionId, edit.id);
    assert.equal(deletion.transactionId, edit.id);
    assert.deepEqual(insertion.at, rational(4));
    assert.equal(insertion.item.kind, "gap");
    assert.deepEqual(insertion.item.destination, { start: rational(0), duration: rational(1) });
    assert.deepEqual(deletion.range, { start: rational(1), duration: rational(1) });
  }

  assert.equal(picture.editorial.items.some((item) => item.linkId === "drop"), false);
  assert.equal(audio.editorial.items.some((item) => item.linkId === "drop"), false);
  assert.deepEqual(picture.editorial.items.map((item) => [item.kind, item.destination]), [
    ["picture", { start: rational(0), duration: rational(1) }],
    ["picture", { start: rational(1), duration: rational(2) }],
    ["gap", { start: rational(3), duration: rational(1) }],
  ]);
  assert.deepEqual(audio.editorial.items.map((item) => [item.kind, item.destination]), [
    ["audio", { start: rational(0), duration: rational(1) }],
    ["audio", { start: rational(1), duration: rational(2) }],
    ["gap", { start: rational(3), duration: rational(1) }],
  ]);
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
});

test("insert-first closure makes deleting a complete linked track executable", () => {
  const source = linkedProgram().replace(
    /PictureClip\(source: picture, range: 0s \.\.< 1s, duration: 1s\);[\s\S]*?PictureClip\(source: picture, range: 2s \.\.< 4s, duration: 4s - 2s\);/,
    'PictureClip(source: picture, range: 0s ..< 4s, duration: 4s, link: "drop");',
  ).replace(
    /AudioClip\(source: voice, range: 0s \.\.< 1s, destination: 0s \.\.< 1s\);[\s\S]*?AudioClip\(source: voice, range: 2s \.\.< 4s, destination: 2s \.\.< 4s\);/,
    'AudioClip(source: voice, range: 0s ..< 4s, destination: 0s ..< 4s, link: "drop");',
  );
  const ir = compile(source), edit = transaction(ir), { picture, audio } = tracks(ir);
  assert.deepEqual(edit.range, { start: rational(0), duration: rational(4) });
  assert.deepEqual(picture.editorial.items.map((item) => [item.kind, item.destination]), [["gap", { start: rational(0), duration: rational(4) }]]);
  assert.deepEqual(audio.editorial.items.map((item) => [item.kind, item.destination]), [["gap", { start: rational(0), duration: rational(4) }]]);
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
});

test("LinkedRippleDelete has stable entity identity and a resolved range is semantic data", () => {
  const before = compile(linkedProgram());
  const formatted = compile(linkedProgram().replace("    LinkedRippleDelete", "    // coupled edit\n    LinkedRippleDelete"));
  assert.equal(transaction(before).id, transaction(formatted).id);
  assert.equal(before.buildId, formatted.buildId);
  const declaredAfterTracks = compile(linkedProgram({ statementAfter: true }));
  assert.equal(transaction(before).id, transaction(declaredAfterTracks).id);
  assert.equal(before.buildId, declaredAfterTracks.buildId, "transaction source order relative to its tracks is not semantic");

  const moved = compile(linkedProgram({ start: "500ms", end: "1500ms" }));
  assert.equal(transaction(before).id, transaction(moved).id, "resolved timing is transaction content, not entity identity");
  const change = diffCutAVIR(before, moved).changes.find((item) => item.entity === "linked-edit");
  assert.equal(change?.operation, "modify");
  assert.ok(change?.operation === "modify" && change.fields.some((field) => field.path.startsWith("/range/")));
});

test("the pure multi-request planner remains atomic when a later ripple request is hostile", () => {
  const base = compile(linkedProgram({ statement: "" })), scene = Object.values(base.scenes)[0];
  const valid: LinkedRippleDeleteRequest = {
    kind: "linked-ripple-delete",
    id: "linked_edit_valid",
    compositionId: "main",
    sceneId: scene.id,
    linkId: "drop",
    provenance: scene.provenance,
  };
  const hostile: LinkedRippleDeleteRequest = { ...valid, id: "linked_edit_hostile", linkId: "missing" };
  const before = JSON.stringify(base);
  assert.throws(
    () => stageLinkedRippleDeleteTransactions(base, [valid, hostile]),
    (error: unknown) => error instanceof LinkedRippleDeleteError && error.code === "CUT_LINKED_RIPPLE_RESULT" && error.requestIndex === 1,
  );
  assert.equal(JSON.stringify(base), before);
});

test("scope, arguments, pair timing, cardinality, and existing plans fail with stable diagnostics", () => {
  const diagnostic = (source: string, code: string) => assert.throws(
    () => compile(source),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === code),
  );
  diagnostic(linkedProgram({ statement: "" }).replace("  scene only", '  LinkedRippleDelete(link: "drop");\n  scene only'), "CUT_LINKED_RIPPLE_SCOPE");
  diagnostic(linkedProgram({ statement: 'at 0s { LinkedRippleDelete(link: "drop"); }' }), "CUT_LINKED_RIPPLE_SCOPE");
  diagnostic(linkedProgram({ statement: 'LinkedRippleDelete(link: "missing");' }), "CUT_LINKED_RIPPLE_RESULT");
  diagnostic(linkedProgram({ audioStart: "1250ms", audioEnd: "2250ms" }), "CUT_LINKED_RIPPLE_TIME");
  assert.throws(
    () => compile(linkedProgram({ statement: 'LinkedRippleDelete(link: "drop", range: 1s ..< 2s);' })),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => /range/.test(item.message)),
  );

  const planned = compile(linkedProgram({ statement: "" })), { picture } = tracks(planned), scene = Object.values(planned.scenes)[0];
  picture.editorial.operationPlan = { version: 1, sourceDuration: picture.interval.duration, baseItems: [], operations: [] };
  assert.throws(
    () => stageLinkedRippleDeleteTransactions(planned, [{ kind: "linked-ripple-delete", id: "linked_edit_test", compositionId: "main", sceneId: scene.id, linkId: "drop", provenance: scene.provenance }]),
    (error: unknown) => error instanceof LinkedRippleDeleteError && error.code === "CUT_LINKED_RIPPLE_UNSUPPORTED",
  );
});

test("strict CutAVIR rejects one-sided, forged, reordered, or residual ripple correlation before hashes", () => {
  const mutate = (callback: (ir: CutAVIR, picture: PictureTrack, audio: AudioTrack) => void) => {
    const ir = JSON.parse(JSON.stringify(compile(linkedProgram()))) as CutAVIR, { picture, audio } = tracks(ir);
    callback(ir, picture, audio);
    return ir;
  };
  const rejected = (ir: CutAVIR, pattern: RegExp) => assert.throws(
    () => validateCutAvIr(ir),
    (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_IDENTITY" && pattern.test(error.path),
  );

  rejected(mutate((_ir, _picture, audio) => { audio.editorial.operationPlan!.operations.pop(); }), /linkedEdits\[0\]/);
  rejected(mutate((_ir, picture) => { picture.editorial.operationPlan!.operations.reverse(); }), /operationPlan\.operations\[1\]\.item\.origin/);
  rejected(mutate((_ir, picture) => {
    const operation = picture.editorial.operationPlan!.operations[0];
    assert.equal(operation.kind, "ripple-insert");
    if (operation.kind === "ripple-insert") operation.at = rational(3);
  }), /operations\[0\]\.at/);
  rejected(mutate((ir, picture) => {
    const transaction = ir.linkedEdits![0];
    assert.equal(transaction.kind, "linked-ripple-delete");
    const residual = picture.editorial.operationPlan!.baseItems.find((item) => item.inputs.link?.kind === "string");
    assert.ok(residual && transaction.kind === "linked-ripple-delete");
    picture.editorial.items[0].linkId = transaction.linkId;
  }), /linkedEdits\[0\]/);
  rejected(mutate((_ir, picture) => {
    const linkedBase = picture.editorial.operationPlan!.baseItems.find((item) => item.inputs.link?.kind === "string");
    assert.ok(linkedBase);
    delete linkedBase.inputs.link;
  }), /linkedEdits\[0\]\.pictureTrackId/);
});

test("the public JSON Schema closes ripple transactions and correlation metadata", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const ajv = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true });
  const validate = ajv.compile(schema), canonical = compile(linkedProgram());
  assert.equal(validate(canonical), true, JSON.stringify(validate.errors));

  const unknown = JSON.parse(JSON.stringify(canonical)) as CutAVIR;
  (unknown.linkedEdits![0] as unknown as Record<string, unknown>).ignored = true;
  assert.equal(validate(unknown), false);
  const forged = JSON.parse(JSON.stringify(canonical)) as CutAVIR, { picture } = tracks(forged);
  const operation = picture.editorial.operationPlan!.operations[0] as unknown as Record<string, unknown>;
  operation.ignored = true;
  assert.equal(validate(forged), false);
  const invalidMetadata = JSON.parse(JSON.stringify(canonical)) as CutAVIR, invalidTrack = tracks(invalidMetadata).picture;
  const lift = invalidTrack.editorial.operationPlan!.operations[1] as unknown as Record<string, unknown>;
  lift.kind = "lift";
  assert.equal(validate(invalidMetadata), false, "transactionId is closed on unrelated structural operations");
});
