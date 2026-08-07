import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import { compileCutModule, CutCompileError, LinkedTrimError, stageLinkedTrimTransactions, type LinkedTrimRequest } from "../lib/language/compiler";
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

function linkedProgram(statement = 'LinkedTrim(link: "take-a", keep: 1s ..< 3s);') {
  return `cut 0.4;
project "linked trim";
import { LinkedTrim, Sequence, PictureTrack, PictureClip, Gap, AudioTrack, AudioGap } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 4, sampleRate: 48khz) {
  scene only(duration: 4s) {
    ${statement}
    Sequence(duration: 4s) { PictureTrack() {
      Gap(duration: 500ms);
      PictureClip(source: picture, range: 0s ..< 3s, duration: 3s, link: "take-a");
      Gap(duration: 500ms);
    } }
    AudioTrack() {
      AudioGap(destination: 0s ..< 500ms);
      AudioClip(source: voice, range: 0s ..< 3s, destination: 500ms ..< 3500ms, link: "take-a");
      AudioGap(destination: 3500ms ..< 4s);
    }
  }
}
export out = render(main);`;
}

test("LinkedTrim lowers through typed correlated plans, preserves links, and round-trips strict CutAVIR", () => {
  const ir = compile(linkedProgram());
  assert.equal(ir.linkedEdits?.length, 1);
  const transaction = ir.linkedEdits![0];
  const { picture, audio } = tracks(ir);
  assert.equal(transaction.kind, "linked-trim");
  assert.equal(transaction.pictureTrackId, picture.id);
  assert.equal(transaction.audioTrackId, audio.id);
  assert.deepEqual(transaction.keep, { start: rational(1), duration: rational(2) });
  assert.equal(Object.values(ir.nodes).some((node) => node.op === "cut.edit.linked_trim"), false, "LinkedTrim is typed editorial IR, not a fake render node");

  const pictureOperation = picture.editorial.operationPlan?.operations[0];
  const audioOperation = audio.editorial.operationPlan?.operations[0];
  assert.equal(pictureOperation?.kind, "trim");
  assert.equal(audioOperation?.kind, "trim");
  if (pictureOperation?.kind !== "trim" || audioOperation?.kind !== "trim") return;
  assert.equal(pictureOperation.transactionId, transaction.id);
  assert.equal(audioOperation.transactionId, transaction.id);

  const pictureLinked = picture.editorial.items.filter((item) => item.linkId === "take-a");
  const audioLinked = audio.editorial.items.filter((item) => item.linkId === "take-a");
  assert.equal(pictureLinked.length, 1);
  assert.equal(audioLinked.length, 1);
  assert.deepEqual(pictureLinked[0].destination, transaction.keep);
  assert.deepEqual(audioLinked[0].destination, transaction.keep);
  assert.deepEqual(pictureLinked[0].source, { start: rational(1, 2), duration: rational(2) });
  assert.deepEqual(audioLinked[0].source, { start: rational(1, 2), duration: rational(2) });
  assert.equal(ir.nodes[pictureLinked[0].nodeId].inputs.link?.kind, "string");
  assert.equal(ir.nodes[audioLinked[0].nodeId].inputs.link?.kind, "string");
  assert.ok(picture.editorial.items.filter((item) => item.kind === "gap").every((item) => item.linkId === undefined));
  assert.ok(audio.editorial.items.filter((item) => item.kind === "gap").every((item) => item.linkId === undefined));
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
});

test("LinkedTrim identity survives formatting and keep changes are first-class field modifications", () => {
  const before = compile(linkedProgram());
  const formatted = compile(linkedProgram().replace("    LinkedTrim", "    // transaction\n    LinkedTrim"));
  assert.equal(before.linkedEdits![0].id, formatted.linkedEdits![0].id);
  assert.equal(before.buildId, formatted.buildId);

  const after = compile(linkedProgram('LinkedTrim(link: "take-a", keep: 1250ms ..< 3s);'));
  assert.equal(before.linkedEdits![0].id, after.linkedEdits![0].id, "keep is transaction content, not entity identity");
  const diff = diffCutAVIR(before, after);
  const change = diff.changes.find((item) => item.entity === "linked-edit");
  assert.equal(change?.operation, "modify");
  assert.ok(change?.operation === "modify" && change.fields.some((field) => field.path.startsWith("/keep/")));
});

test("the pure LinkedTrim stage is atomic on a later hostile request", () => {
  const base = compile(linkedProgram(""));
  const scene = Object.values(base.scenes)[0];
  const provenance = scene.provenance;
  const valid: LinkedTrimRequest = {
    id: "linked_edit_valid",
    compositionId: "main",
    sceneId: scene.id,
    linkId: "take-a",
    keep: { start: rational(1), duration: rational(2) },
    provenance,
  };
  const hostile: LinkedTrimRequest = { ...valid, id: "linked_edit_hostile", linkId: "missing" };
  const before = JSON.stringify(base);
  assert.throws(
    () => stageLinkedTrimTransactions(base, [valid, hostile]),
    (error: unknown) => error instanceof LinkedTrimError && error.code === "CUT_LINKED_TRIM_RESULT" && error.requestIndex === 1,
  );
  assert.equal(JSON.stringify(base), before, "pure staging must not expose the first transaction after the second fails");
});

test("multiple links on the same picture/audio tracks survive sequential correlated trims", () => {
  const source = `cut 0.4;
project "multi linked trim";
import { LinkedTrim, Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 4, sampleRate: 48khz) {
  scene only(duration: 4s) {
    LinkedTrim(link: "a", keep: 500ms ..< 1500ms);
    LinkedTrim(link: "b", keep: 2500ms ..< 3500ms);
    Sequence(duration: 4s) { PictureTrack() {
      PictureClip(source: picture, range: 0s ..< 2s, duration: 2s, link: "a");
      PictureClip(source: picture, range: 2s ..< 4s, duration: 2s, link: "b");
    } }
    AudioTrack() {
      AudioClip(source: voice, range: 0s ..< 2s, destination: 0s ..< 2s, link: "a");
      AudioClip(source: voice, range: 2s ..< 4s, destination: 2s ..< 4s, link: "b");
    }
  }
}
export out = render(main);`;
  const ir = compile(source), { picture, audio } = tracks(ir);
  assert.equal(ir.linkedEdits?.length, 2);
  for (const link of ["a", "b"]) {
    assert.equal(picture.editorial.items.filter((item) => item.linkId === link).length, 1);
    assert.equal(audio.editorial.items.filter((item) => item.linkId === link).length, 1);
  }
  assert.equal(picture.editorial.operationPlan?.operations.length, 2);
  assert.equal(audio.editorial.operationPlan?.operations.length, 2);
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
});

test("LinkedTrim rejects scope, link, timing, cardinality, and unsupported-plan hazards with stable source diagnostics", () => {
  const diagnostic = (source: string, code: string) => assert.throws(
    () => compile(source),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === code),
  );
  diagnostic(linkedProgram("").replace("  scene only", '  LinkedTrim(link: "take-a", keep: 1s ..< 3s);\n  scene only'), "CUT_LINKED_TRIM_SCOPE");
  diagnostic(linkedProgram('at 0s { LinkedTrim(link: "take-a", keep: 1s ..< 3s); }'), "CUT_LINKED_TRIM_SCOPE");
  diagnostic(linkedProgram('if true { LinkedTrim(link: "take-a", keep: 1s ..< 3s); }'), "CUT_LINKED_TRIM_SCOPE");
  diagnostic(linkedProgram('for item in [1] { LinkedTrim(link: "take-a", keep: 1s ..< 3s); }'), "CUT_LINKED_TRIM_SCOPE");
  diagnostic(linkedProgram('let transaction = LinkedTrim(link: "take-a", keep: 1s ..< 3s);'), "CUT_LINKED_TRIM_SCOPE");
  diagnostic(linkedProgram("").replace("PictureTrack() {", 'PictureTrack() { LinkedTrim(link: "take-a", keep: 1s ..< 3s);'), "CUT_LINKED_TRIM_SCOPE");
  diagnostic('cut 0.4; project "component scope"; import { LinkedTrim } from "@cut/edit"; component Bad() -> Visual { LinkedTrim(link: "take-a", keep: 1s ..< 2s); }', "CUT_LINKED_TRIM_SCOPE");
  diagnostic(linkedProgram('LinkedTrim(link: " take-a", keep: 1s ..< 3s);'), "CUT_LINKED_TRIM_RESULT");
  diagnostic(linkedProgram(`LinkedTrim(link: "${"x".repeat(129)}", keep: 1s ..< 3s);`), "CUT_LINKED_TRIM_RESULT");
  diagnostic(linkedProgram('LinkedTrim(link: "take\u007fa", keep: 1s ..< 3s);'), "CUT_LINKED_TRIM_RESULT");
  diagnostic(linkedProgram('LinkedTrim(link: "take-a", keep: 100ms ..< 3s);'), "CUT_LINKED_TRIM_TIME");
  diagnostic(linkedProgram('LinkedTrim(link: "take-a", keep: 500ms ..< 3500ms);'), "CUT_LINKED_TRIM_TIME");
  diagnostic(linkedProgram('LinkedTrim(link: "missing", keep: 1s ..< 3s);'), "CUT_LINKED_TRIM_RESULT");
  assert.throws(
    () => compile(linkedProgram('LinkedTrim(link: "take-a", keep: 1s ..< 3s, gap: 1s);')),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => /gap/.test(item.message)),
  );

  const planned = compile(linkedProgram(""));
  const { picture } = tracks(planned);
  picture.editorial.operationPlan = {
    version: 1,
    sourceDuration: picture.interval.duration,
    baseItems: [],
    operations: [],
  };
  const scene = Object.values(planned.scenes)[0];
  assert.throws(
    () => stageLinkedTrimTransactions(planned, [{ id: "linked_edit_test", compositionId: "main", sceneId: scene.id, linkId: "take-a", keep: { start: rational(1), duration: rational(2) }, provenance: scene.provenance }]),
    (error: unknown) => error instanceof LinkedTrimError && error.code === "CUT_LINKED_TRIM_UNSUPPORTED",
  );
});

test("strict CutAVIR rejects unknown or one-sided transaction correlation before hash validation", () => {
  const ir = JSON.parse(JSON.stringify(compile(linkedProgram()))) as CutAVIR;
  const { picture, audio } = tracks(ir);
  const pictureTrim = picture.editorial.operationPlan!.operations[0];
  const audioTrim = audio.editorial.operationPlan!.operations[0];
  assert.equal(pictureTrim.kind, "trim");
  assert.equal(audioTrim.kind, "trim");
  if (pictureTrim.kind !== "trim" || audioTrim.kind !== "trim") return;
  audioTrim.transactionId = "linked_edit_unknown";
  assert.throws(
    () => validateCutAvIr(ir),
    (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_REFERENCE" && error.path.endsWith(".transactionId"),
  );

  const duplicate = JSON.parse(JSON.stringify(compile(linkedProgram()))) as CutAVIR;
  const duplicatePicture = tracks(duplicate).picture;
  const linked = duplicatePicture.editorial.items.find((item) => item.linkId === "take-a")!;
  duplicatePicture.editorial.items.push({ ...linked, order: duplicatePicture.editorial.items.length });
  assert.throws(
    () => validateCutAvIr(duplicate),
    (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_IDENTITY" && error.path.endsWith(".pictureTrackId"),
  );
});

test("the public JSON Schema closes LinkedTrim transactions and correlated trim ids", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const ajv = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true });
  const validate = ajv.compile(schema);
  const canonical = compile(linkedProgram());
  assert.equal(validate(canonical), true, JSON.stringify(validate.errors));

  const unknown = JSON.parse(JSON.stringify(canonical)) as CutAVIR;
  (unknown.linkedEdits![0] as unknown as Record<string, unknown>).ignored = true;
  assert.equal(validate(unknown), false, "linked edit records must reject unknown properties");
  const empty = JSON.parse(JSON.stringify(canonical)) as CutAVIR;
  empty.linkedEdits = [];
  assert.equal(validate(empty), false, "empty linkedEdits must be omitted");
});
