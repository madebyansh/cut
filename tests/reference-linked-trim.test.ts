import test from "node:test";
import assert from "node:assert/strict";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  ReferenceLinkedTrimError,
  referenceLinkedTrimLimits,
  referenceLinkedTrimSceneLinkKey,
  validateReferenceLinkedTrimTransactions,
  type ReferenceLinkedTrimErrorCode,
} from "../lib/runtime/reference/linked-trim";

type PictureTrack = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrack = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };

const singleSource = `cut 0.4;
project "reference linked trim";
import { LinkedTrim, Sequence, PictureTrack, PictureClip, Gap, AudioTrack, AudioGap } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 4, sampleRate: 48khz) {
  scene only(duration: 4s) {
    LinkedTrim(link: "take-a", keep: 1s ..< 3s);
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

const multiSource = `cut 0.4;
project "reference multi linked trim";
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

function compile(source = singleSource) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function loaded(source = singleSource) {
  return loadCutAvIr(JSON.stringify(compile(source)));
}

function tracks(ir: CutAVIR) {
  const picture = Object.values(ir.nodes).find((node): node is PictureTrack => node.editorial?.kind === "picture-track");
  const audio = Object.values(ir.nodes).find((node): node is AudioTrack => node.editorial?.kind === "audio-track");
  assert.ok(picture);
  assert.ok(audio);
  return { picture, audio };
}

function validate(ir: CutAVIR) {
  const composition = ir.compositions.find((candidate) => candidate.id === "main");
  assert.ok(composition);
  return validateReferenceLinkedTrimTransactions(ir, composition);
}

function expectLinkedTrimError(
  mutate: (ir: CutAVIR, picture: PictureTrack, audio: AudioTrack) => void,
  code: ReferenceLinkedTrimErrorCode,
  message?: RegExp,
) {
  const ir = loaded(), { picture, audio } = tracks(ir);
  mutate(ir, picture, audio);
  assert.throws(
    () => validate(ir),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceLinkedTrimError);
      assert.equal(error.code, code);
      assert.match(error.source.module, /\.cut$/);
      assert.ok(Number.isSafeInteger(error.source.line) && error.source.line > 0);
      assert.ok(Number.isSafeInteger(error.source.column) && error.source.column > 0);
      if (message) assert.match(error.message, message);
      return true;
    },
  );
}

test("the central validator authorizes compiled and strict-loaded LinkedTrim graphs with immutable integration maps", () => {
  for (const ir of [compile(), loaded()]) {
    const transaction = ir.linkedEdits![0], { picture, audio } = tracks(ir);
    const before = JSON.stringify(ir);
    const authorizations = validate(ir);
    assert.equal(JSON.stringify(ir), before, "authorization must not mutate CutAVIR");
    const authorization = authorizations.byTransactionId.get(transaction.id);
    assert.ok(authorization);
    assert.equal(authorizations.compositionId, "main");
    assert.equal(authorizations.byTransactionId.size, 1);
    assert.equal(
      authorizations.bySceneLink.get(referenceLinkedTrimSceneLinkKey("main", transaction.sceneId, "take-a")),
      authorization,
    );
    assert.equal(authorizations.pictureByTrackId.get(picture.id)?.get(transaction.id), authorization.picture);
    assert.equal(authorizations.audioByTrackId.get(audio.id)?.get(transaction.id), authorization.audio);
    assert.equal(authorization.picture.linkId, "take-a");
    assert.equal(authorization.audio.linkId, "take-a");
    assert.deepEqual(authorization.keep, { start: rational(1), duration: rational(2) });
    assert.deepEqual(authorization.picture.translatedKeep, { start: rational(1), duration: rational(2) });
    assert.deepEqual(authorization.audio.translatedKeep, { start: rational(1), duration: rational(2) });
    assert.equal(authorization.picture.operationIndex, 0);
    assert.equal(authorization.audio.operationIndex, 0);
    assert.equal(authorization.picture.materializedNodeId, picture.editorial.items[authorization.picture.materializedItemIndex].nodeId);
    assert.equal(authorization.audio.materializedNodeId, audio.editorial.items[authorization.audio.materializedItemIndex].nodeId);

    const transactionMap = authorizations.byTransactionId as unknown as {
      set: (key: string, value: typeof authorization) => unknown;
    };
    const pictureMap = authorizations.pictureByTrackId.get(picture.id)! as unknown as { clear: () => unknown };
    assert.throws(() => transactionMap.set("forged", authorization), TypeError);
    assert.throws(() => pictureMap.clear(), TypeError);
    assert.equal(authorizations.byTransactionId.size, 1);
    assert.equal(authorizations.byTransactionId.get(transaction.id), authorization);
    assert.ok(Object.isFrozen(authorizations));
    assert.ok(Object.isFrozen(authorization));
    assert.ok(Object.isFrozen(authorization.keep));
    assert.ok(Object.isFrozen(authorization.keep.start));
    let callbackMap: ReadonlyMap<string, typeof authorization> | undefined;
    authorizations.byTransactionId.forEach((_value, _key, map) => { callbackMap = map; });
    assert.equal(callbackMap, authorizations.byTransactionId);
  }
});

test("multiple links sharing the same declared tracks receive distinct exact authorizations", () => {
  const ir = loaded(multiSource), { picture, audio } = tracks(ir), authorizations = validate(ir);
  assert.equal(authorizations.byTransactionId.size, 2);
  assert.equal(authorizations.pictureByTrackId.get(picture.id)?.size, 2);
  assert.equal(authorizations.audioByTrackId.get(audio.id)?.size, 2);
  const transactions = ir.linkedEdits!;
  for (const [index, transaction] of transactions.entries()) {
    const authorization = authorizations.byTransactionId.get(transaction.id);
    assert.ok(authorization);
    assert.equal(authorization.linkId, index === 0 ? "a" : "b");
    assert.equal(authorization.picture.operationIndex, index);
    assert.equal(authorization.audio.operationIndex, index);
  }
  const nodeIds = transactions.flatMap((transaction) => {
    const authorization = authorizations.byTransactionId.get(transaction.id)!;
    return [authorization.picture.materializedNodeId, authorization.audio.materializedNodeId];
  });
  assert.equal(new Set(nodeIds).size, 4);
});

test("missing or forged correlated operations fail before either side can be authorized", () => {
  expectLinkedTrimError((_ir, _picture, audio) => {
    audio.editorial.operationPlan!.operations = [];
  }, "CUT_LINKED_TRIM_CORRELATION", /extra or missing correlated mutation/);

  expectLinkedTrimError((_ir, _picture, audio) => {
    const operation = audio.editorial.operationPlan!.operations[0];
    assert.equal(operation.kind, "trim");
    if (operation.kind === "trim") operation.keep.start = rational(0);
  }, "CUT_LINKED_TRIM_CORRELATION", /not translated/);

  expectLinkedTrimError((_ir, picture) => {
    const operation = picture.editorial.operationPlan!.operations[0];
    if (operation.kind !== "trim") throw new Error("expected compiler-correlated picture trim");
    picture.editorial.operationPlan!.operations.push({ ...operation, transactionId: undefined });
  }, "CUT_LINKED_TRIM_CORRELATION", /extra or missing correlated mutation/);

  expectLinkedTrimError((_ir, picture) => {
    const operation = picture.editorial.operationPlan!.operations[0];
    assert.equal(operation.kind, "trim");
    if (operation.kind === "trim") operation.transactionId = "linked_edit_unknown";
  }, "CUT_LINKED_TRIM_CORRELATION", /unknown or non-trim correlated mutation/);

  expectLinkedTrimError((ir, picture) => {
    const operation = picture.editorial.operationPlan!.operations[0];
    if (operation.kind !== "trim") throw new Error("expected compiler-correlated picture trim");
    const forged = JSON.parse(JSON.stringify(picture)) as PictureTrack;
    forged.id = `${picture.id}_forged`;
    forged.children = [];
    forged.editorial.items = [];
    forged.editorial.operationPlan = {
      version: 1,
      sourceDuration: picture.interval.duration,
      baseItems: [],
      operations: [{ ...operation }],
    };
    ir.nodes[forged.id] = forged;
  }, "CUT_LINKED_TRIM_CORRELATION", /extra or missing correlated mutation/);

  expectLinkedTrimError((ir, _picture, audio) => {
    ir.linkedEdits![0].pictureTrackId = audio.id;
  }, "CUT_LINKED_TRIM_SCOPE", /pictureTrackId/);
});

test("source, materialized-item, and raw-node link cardinality are exact", () => {
  expectLinkedTrimError((_ir, picture) => {
    picture.editorial.operationPlan!.baseItems[0].inputs.link = { kind: "string", value: "take-a" };
  }, "CUT_LINKED_TRIM_CARDINALITY", /picture gap.*cannot carry link metadata/);

  expectLinkedTrimError((_ir, picture) => {
    picture.editorial.items[0].linkId = "take-a";
  }, "CUT_LINKED_TRIM_CARDINALITY", /picture-track gap.*cannot carry link metadata/);

  expectLinkedTrimError((ir, _picture, audio) => {
    const gap = audio.editorial.items.find((item) => item.kind === "gap")!;
    ir.nodes[gap.nodeId].inputs.link = { kind: "string", value: "take-a" };
  }, "CUT_LINKED_TRIM_CARDINALITY", /materialized gap.*cannot carry link metadata/);

  expectLinkedTrimError((ir, picture) => {
    const linked = picture.editorial.items.find((item) => item.linkId === "take-a")!;
    const original = ir.nodes[linked.nodeId];
    const duplicateId = `${original.id}_orphan`;
    ir.nodes[duplicateId] = {
      ...original,
      id: duplicateId,
      inputs: { ...original.inputs, link: { kind: "string", value: "undeclared" } },
    };
  }, "CUT_LINKED_TRIM_CARDINALITY", /not owned by exactly one matching track item/);

  expectLinkedTrimError((ir, picture) => {
    const linked = picture.editorial.items.find((item) => item.linkId === "take-a")!;
    const original = ir.nodes[linked.nodeId];
    const duplicateId = `${original.id}_forged`;
    ir.nodes[duplicateId] = { ...original, id: duplicateId };
  }, "CUT_LINKED_TRIM_CARDINALITY", /not owned by exactly one matching track item/);
});

test("pure replay rejects forged children, item semantics, source ranges, and track duration", () => {
  expectLinkedTrimError((ir, picture) => {
    const linked = picture.editorial.items.find((item) => item.linkId === "take-a")!;
    delete ir.nodes[linked.nodeId].inputs.link;
  }, "CUT_LINKED_TRIM_CARDINALITY", /exactly one materialized picture node/);

  expectLinkedTrimError((_ir, _picture, audio) => {
    const linked = audio.editorial.items.find((item) => item.linkId === "take-a")!;
    linked.source!.start = rational(0);
  }, "CUT_LINKED_TRIM_MATERIALIZATION", /identity, order, timing, source, link, or ownership/);

  expectLinkedTrimError((_ir, picture) => {
    const gap = picture.editorial.items.find((item) => item.kind === "gap")!;
    gap.destination.duration = rational(3, 4);
  }, "CUT_LINKED_TRIM_MATERIALIZATION", /identity, order, timing, source, link, or ownership/);

  expectLinkedTrimError((_ir, picture) => {
    picture.children.pop();
  }, "CUT_LINKED_TRIM_MATERIALIZATION", /item count does not match replay/);

  expectLinkedTrimError((_ir, picture) => {
    picture.interval.duration = rational(3);
  }, "CUT_LINKED_TRIM_PLAN", /plan duration does not equal its track duration/);
});

test("time grids and bounded transaction/correlation work are enforced", () => {
  expectLinkedTrimError((ir) => {
    const transaction = ir.linkedEdits![0];
    assert.equal(transaction.kind, "linked-trim");
    if (transaction.kind !== "linked-trim") return;
    transaction.keep.start = rational(1, 10);
  }, "CUT_LINKED_TRIM_TIME", /picture frame grid/);

  expectLinkedTrimError((ir) => {
    const transaction = ir.linkedEdits![0];
    ir.linkedEdits = Array.from({ length: referenceLinkedTrimLimits.maxTransactions + 1 }, (_unused, index) => ({
      ...transaction,
      id: `${transaction.id}_${index}`,
    }));
  }, "CUT_LINKED_TRIM_LIMIT", /maxTransactions=256/);

  expectLinkedTrimError((_ir, picture) => {
    const operation = picture.editorial.operationPlan!.operations[0];
    if (operation.kind !== "trim") throw new Error("expected compiler-correlated picture trim");
    picture.editorial.operationPlan!.operations = Array.from(
      { length: referenceLinkedTrimLimits.maxCorrelatedOperations + 1 },
      () => ({ ...operation }),
    );
  }, "CUT_LINKED_TRIM_LIMIT", /maxCorrelatedOperations=512/);
});
