import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stableJsonStringify } from "../lib/core/stable";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRValue } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
} from "../lib/runtime/reference/audio-cache";
import { referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import {
  planReferenceAudioStems,
  ReferenceStemError,
} from "../lib/runtime/reference/stems";
import { prepareReferenceAudioStems, renderReferenceAudioStems, testStemLockSha256 } from "./reference-stem-test-helper";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function program(body: string) {
  return `cut 0.4;
project "stem sidechain controls";
import { Bus, Gain, Return, Send, Sidechain, Tone } from "@cut/audio";
timeline main(duration: 20ms, fps: 50, width: 64px, height: 64px, sampleRate: 48khz) {
  ${body}
}
export out = render(main);`;
}

function controlled(frequency = "3khz") {
  return program(`
    Bus(name: "dialogue", role: "dialogue") as dialogue {
      Tone(frequency: ${frequency}, duration: 20ms, amplitude: 80%);
    }
    Bus(name: "music", role: "music") {
      Sidechain(source: dialogue, amount: -12db, threshold: -30db, attack: 1ms, release: 10ms) {
        Tone(frequency: 440hz, duration: 20ms, amplitude: 10%);
      }
    }
  `);
}

function nodes(ir: CutAVIR, op: string) {
  return Object.values(ir.nodes).filter((node) => node.op === op);
}

function bus(ir: CutAVIR, name: string) {
  const found = nodes(ir, "cut.audio.bus").find((node) => node.inputs.name?.kind === "string" && node.inputs.name.value === name);
  assert.ok(found);
  return found;
}

function expectControlError(ir: CutAVIR, code: ReferenceStemError["code"], message: RegExp) {
  assert.throws(() => planReferenceAudioStems(ir, ir.compositions[0]), (error: unknown) => {
    assert.ok(error instanceof ReferenceStemError, String(error));
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.ok(error.source);
    assert.equal(error.source.module, "project.cut");
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });
}

test("a public cross-program Sidechain becomes a closed stem control dependency and route/cache identity", () => {
  const before = compile(controlled("3khz")), after = compile(controlled("3100hz"));
  const beforePlan = planReferenceAudioStems(before, before.compositions[0]);
  const afterPlan = planReferenceAudioStems(after, after.compositions[0]);
  assert.equal(beforePlan.version, 3);
  const dialogue = beforePlan.routes.find((route) => route.name === "dialogue");
  const music = beforePlan.routes.find((route) => route.name === "music");
  assert.ok(dialogue && music);
  assert.deepEqual(dialogue.sidechainInputs, []);
  assert.equal(music.sidechainInputs.length, 1);
  const sidechain = nodes(before, "cut.audio.sidechain")[0], key = bus(before, "dialogue");
  assert.deepEqual(music.sidechainInputs[0], {
    sidechainNodeId: sidechain.id,
    keyNodeId: key.id,
    sourceStem: "dialogue",
    sidechainGraphHash: sidechain.contentHash,
    keyGraphHash: key.contentHash,
  });
  const afterMusic = afterPlan.routes.find((route) => route.name === "music");
  assert.ok(afterMusic);
  assert.notEqual(music.graphHash, afterMusic.graphHash, "control-key edit must invalidate the controlled route graph");
  assert.notEqual(music.sidechainInputs[0].keyGraphHash, afterMusic.sidechainInputs[0].keyGraphHash);
  assert.notEqual(music.sidechainInputs[0].sidechainGraphHash, afterMusic.sidechainInputs[0].sidechainGraphHash);

  const incremental = createIncrementalRenderPlan(after, "main", createIncrementalRenderPlan(before, "main").manifest);
  assert.equal(incremental.nodes.find((item) => item.id === bus(after, "music").id)?.status, "miss");
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-stem-sidechain-test");
  const cache = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), toolchain).key;
  assert.notEqual(cache(before), cache(after), "control-key edit must not reuse the pre-master audio cache");
});

test("rendered lock-bound v5 stem manifests retain exact Sidechain control identities", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-stem-sidechain-manifest-"));
  try {
    const ir = compile(controlled()), rendered = await renderReferenceAudioStems(ir, ir.compositions[0], root, resolve(root, "stems"));
    assert.equal(rendered.manifest.version, 5);
    assert.deepEqual(rendered.manifest.lock, { sha256: testStemLockSha256 });
    const music = rendered.manifest.stems.find((stem) => stem.name === "music");
    assert.ok(music);
    assert.equal(music.sidechainInputs.length, 1);
    assert.equal(music.sidechainInputs[0].sourceStem, "dialogue");
    assert.match(music.sidechainInputs[0].sidechainGraphHash, /^[a-f0-9]{64}$/u);
    assert.match(music.sidechainInputs[0].keyGraphHash, /^[a-f0-9]{64}$/u);
    assert.equal(await readFile(rendered.manifestPath, "utf8"), `${stableJsonStringify(rendered.manifest)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the published v5 stem schema closes lock and Sidechain dependency shapes", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-reference-stems-v5.schema.json", "utf8")) as {
    $id: string;
    required: string[];
    properties: { version: { const: number }; lock: { additionalProperties: boolean; required: string[] } };
    definitions: { stem: { required: string[]; properties: Record<string, unknown> }; sidechainInput: { additionalProperties: boolean; required: string[] } };
  };
  assert.equal(schema.$id, "urn:cut:schema:reference-stems:5");
  assert.equal(schema.properties.version.const, 5);
  assert.ok(schema.required.includes("lock"));
  assert.equal(schema.properties.lock.additionalProperties, false);
  assert.deepEqual(schema.properties.lock.required, ["sha256"]);
  assert.ok(schema.definitions.stem.required.includes("sidechainInputs"));
  assert.ok(Object.hasOwn(schema.definitions.stem.properties, "sidechainInputs"));
  assert.equal(schema.definitions.sidechainInput.additionalProperties, false);
  assert.deepEqual(schema.definitions.sidechainInput.required, ["sidechainNodeId", "keyNodeId", "sourceStem", "sidechainGraphHash", "keyGraphHash"]);
});

test("stem controls reject unowned, ambiguous, auxiliary, and cyclic dependencies with source diagnostics", () => {
  const unowned = compile(program(`
    let key = Tone(frequency: 3khz, duration: 20ms, amplitude: 80%);
    Bus(name: "music") { Sidechain(source: key, amount: -6db, threshold: -30db) { Tone(frequency: 440hz, duration: 20ms); } }
  `));
  expectControlError(unowned, "CUT_STEM_CONTROL_UNOWNED", /without a top-level stem owner/);

  const ambiguous = compile(program(`
    Bus(name: "one") as one { Tone(frequency: 1khz, duration: 20ms); }
    Bus(name: "two") { Tone(frequency: 2khz, duration: 20ms); }
    Bus(name: "target") { Sidechain(source: one, amount: -6db, threshold: -30db) { Tone(frequency: 440hz, duration: 20ms); } }
  `));
  const sharedKey = bus(ambiguous, "one").children[0], second = bus(ambiguous, "two"), ambiguousSidechain = nodes(ambiguous, "cut.audio.sidechain")[0];
  second.children = [sharedKey]; ambiguousSidechain.inputs.source = { kind: "node-ref", id: sharedKey };
  expectControlError(ambiguous, "CUT_STEM_CONTROL_AMBIGUOUS", /structurally owned by both stems/);

  const ambiguousAncestor = compile(program(`
    Bus(name: "one") as one { Gain(amount: -1db) { Tone(frequency: 1khz, duration: 20ms); } }
    Bus(name: "two") { Tone(frequency: 2khz, duration: 20ms); }
    Bus(name: "target") { Sidechain(source: one, amount: -6db, threshold: -30db) { Tone(frequency: 440hz, duration: 20ms); } }
  `));
  const secondBus = bus(ambiguousAncestor, "two");
  const sharedGain = nodes(ambiguousAncestor, "cut.audio.gain")[0], descendantKey = ambiguousAncestor.nodes[sharedGain.children[0]];
  secondBus.children = [sharedGain.id];
  nodes(ambiguousAncestor, "cut.audio.sidechain")[0].inputs.source = { kind: "node-ref", id: descendantKey.id };
  expectControlError(ambiguousAncestor, "CUT_STEM_CONTROL_AMBIGUOUS", /structurally owned by both stems/);

  const auxiliary = compile(program(`
    Bus(name: "dialogue") as dialogue { Tone(frequency: 3khz, duration: 20ms); }
    let roomSend = Send(amount: -12db, source: dialogue);
    Bus(name: "room", kind: "aux") { Return(sends: [roomSend]); }
    Bus(name: "music") { Sidechain(source: dialogue, amount: -6db, threshold: -30db) { Tone(frequency: 440hz, duration: 20ms); } }
  `));
  nodes(auxiliary, "cut.audio.sidechain")[0].inputs.source = { kind: "node-ref", id: bus(auxiliary, "room").id };
  expectControlError(auxiliary, "CUT_STEM_CONTROL_AUX", /cross-stem controls require two program stems/);

  const cyclic = compile(program(`
    let firstKey = Tone(frequency: 3khz, duration: 20ms);
    let secondKey = Tone(frequency: 4khz, duration: 20ms);
    Bus(name: "first") { Sidechain(source: firstKey, amount: -6db, threshold: -30db) { Tone(frequency: 440hz, duration: 20ms); } }
    Bus(name: "second") { Sidechain(source: secondKey, amount: -6db, threshold: -30db) { Tone(frequency: 880hz, duration: 20ms); } }
  `));
  const cyclicSidechains = nodes(cyclic, "cut.audio.sidechain");
  cyclicSidechains[0].inputs.source = { kind: "node-ref", id: bus(cyclic, "second").id };
  cyclicSidechains[1].inputs.source = { kind: "node-ref", id: bus(cyclic, "first").id };
  expectControlError(cyclic, "CUT_STEM_CONTROL_CYCLE", /cross-stem control cycle/);
});

test("same-route aux Sidechain remains explicit supported processing rather than a cross-stem control", () => {
  const ir = compile(program(`
    Bus(name: "dialogue") as dialogue { Tone(frequency: 1khz, duration: 20ms); }
    let keySend = Send(source: dialogue, amount: -12db);
    let programSend = Send(source: dialogue, amount: -18db);
    Bus(name: "room", kind: "aux") {
      Return(sends: [keySend]) as key;
      Sidechain(source: key, amount: -6db, threshold: -30db) { Return(sends: [programSend]); }
    }
  `));
  const plan = planReferenceAudioStems(ir, ir.compositions[0]);
  const dialogue = plan.routes.find((route) => route.name === "dialogue"), room = plan.routes.find((route) => route.name === "room");
  assert.ok(dialogue && room);
  assert.deepEqual({ kind: dialogue.kind, aux: dialogue.auxiliaryInputs.length, sidechain: dialogue.sidechainInputs.length }, { kind: "program", aux: 0, sidechain: 0 });
  assert.deepEqual({ kind: room.kind, aux: room.auxiliaryInputs.length, sidechain: room.sidechainInputs.length }, { kind: "aux", aux: 2, sidechain: 1 });
  assert.equal(room.sidechainInputs[0].sourceStem, "room");
});

test("direct stem APIs refuse stale graph identities instead of publishing old control hashes", () => {
  const stale = compile(controlled()), dialogueTone = stale.nodes[bus(stale, "dialogue").children[0]];
  dialogueTone.inputs.frequency = {
    kind: "quantity",
    dimension: "frequency",
    magnitude: { numerator: "3100", denominator: "1" },
    unit: "hz",
  };
  expectControlError(stale, "CUT_STEM_GRAPH_INVALID", /stale contentHash/);
});

test("direct stem APIs refuse a substituted composition not represented by the CutAVIR build identity", () => {
  const ir = compile(controlled()), substituted = structuredClone(ir.compositions[0]);
  substituted.sampleRate = 96_000;
  assert.throws(
    () => planReferenceAudioStems(ir, substituted),
    (error: unknown) => error instanceof ReferenceStemError
      && error.code === "CUT_STEM_GRAPH_INVALID"
      && /differs from the canonical composition/.test(error.message)
      && error.source?.nodeId === substituted.id,
  );
});

function rewriteNodeReference(value: IRValue, before: string, after: string): IRValue {
  if (value.kind === "node-ref") return value.id === before ? { ...value, id: after } : value;
  if (value.kind === "array") return { ...value, items: value.items.map((item) => rewriteNodeReference(item, before, after)) };
  if (value.kind === "object") return { ...value, entries: Object.fromEntries(Object.entries(value.entries).map(([key, item]) => [key, rewriteNodeReference(item, before, after)])) };
  if (value.kind === "range") return { ...value, start: rewriteNodeReference(value.start, before, after), end: rewriteNodeReference(value.end, before, after) };
  if (value.kind === "unary") return { ...value, value: rewriteNodeReference(value.value, before, after) };
  if (value.kind === "binary") return { ...value, left: rewriteNodeReference(value.left, before, after), right: rewriteNodeReference(value.right, before, after) };
  if (value.kind === "member") return { ...value, object: rewriteNodeReference(value.object, before, after) };
  if (value.kind === "index") return { ...value, object: rewriteNodeReference(value.object, before, after), index: rewriteNodeReference(value.index, before, after) };
  if (value.kind === "call") return {
    ...value,
    positional: value.positional.map((item) => rewriteNodeReference(item, before, after)),
    named: Object.fromEntries(Object.entries(value.named).map(([key, item]) => [key, rewriteNodeReference(item, before, after)])),
  };
  return value;
}

function renameNode(ir: CutAVIR, before: string, after: string) {
  const renamed = ir.nodes[before]; assert.ok(renamed); delete ir.nodes[before]; renamed.id = after; ir.nodes[after] = renamed;
  for (const node of Object.values(ir.nodes)) {
    node.children = node.children.map((id) => id === before ? after : id);
    node.inputs = Object.fromEntries(Object.entries(node.inputs).map(([key, value]) => [key, rewriteNodeReference(value, before, after)]));
  }
  for (const composition of ir.compositions) {
    composition.rootVisualIds = composition.rootVisualIds.map((id) => id === before ? after : id);
    composition.rootAudioIds = composition.rootAudioIds.map((id) => id === before ? after : id);
    composition.rootAVIds = composition.rootAVIds.map((id) => id === before ? after : id);
    composition.items = composition.items.map((item) => item.kind === "node" && item.id === before ? { ...item, id: after } : item);
  }
  for (const scene of Object.values(ir.scenes)) {
    scene.rootVisualIds = scene.rootVisualIds.map((id) => id === before ? after : id);
    scene.rootAudioIds = scene.rootAudioIds.map((id) => id === before ? after : id);
    scene.rootAVIds = scene.rootAVIds.map((id) => id === before ? after : id);
    scene.items = scene.items.map((item) => item.id === before ? { ...item, id: after } : item);
  }
}

test("v5 Sidechain ordering uses deterministic code-unit order rather than the host locale", () => {
  const ir = compile(program(`
    Bus(name: "dialogue") as dialogue { Tone(frequency: 3khz, duration: 20ms); }
    Bus(name: "music") {
      Sidechain(source: dialogue, amount: -6db, threshold: -30db) { Tone(frequency: 440hz, duration: 20ms); }
      Sidechain(source: dialogue, amount: -6db, threshold: -30db) { Tone(frequency: 880hz, duration: 20ms); }
    }
  `));
  const sidechains = nodes(ir, "cut.audio.sidechain"); assert.equal(sidechains.length, 2);
  renameNode(ir, sidechains[0].id, "ä-sidechain");
  renameNode(ir, sidechains[1].id, "z-sidechain");
  finalizeGraphHashes(ir);
  const music = planReferenceAudioStems(ir, ir.compositions[0]).routes.find((route) => route.name === "music");
  assert.deepEqual(music?.sidechainInputs.map((input) => input.sidechainNodeId), ["z-sidechain", "ä-sidechain"]);
});

test("an oversized v5 stem manifest is refused before output allocation or backend work", { timeout: 60_000 }, async () => {
  const controls = Array.from({ length: 1_024 }, (_, index) => `
    Sidechain(source: dialogue, amount: -6db, threshold: -30db) {
      Tone(frequency: ${440 + index}hz, duration: 20ms, amplitude: 0.01%);
    }`).join("\n");
  const ir = compile(program(`
    Bus(name: "dialogue") as dialogue { Tone(frequency: 3khz, duration: 20ms, amplitude: 1%); }
    Bus(name: "music") { ${controls} }
  `));
  const dialogue = bus(ir, "dialogue");
  renameNode(ir, dialogue.id, `dialogue_${"d".repeat(502)}`);
  nodes(ir, "cut.audio.sidechain").forEach((node, index) => {
    const prefix = `sidechain_${String(index).padStart(4, "0")}_`;
    renameNode(ir, node.id, `${prefix}${"s".repeat(512 - prefix.length)}`);
  });
  finalizeGraphHashes(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-stem-manifest-preflight-")), output = resolve(root, "must-not-exist");
  try {
    await assert.rejects(
      prepareReferenceAudioStems(ir, ir.compositions[0], root, output),
      (error: unknown) => error instanceof ReferenceStemError
        && error.code === "CUT_STEM_LIMIT"
        && /closed manifest limit/.test(error.message),
    );
    await assert.rejects(access(output), "manifest limit must fail before creating the destination directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stem Sidechain dependency expansion is bounded before backend work", () => {
  const controls = Array.from({ length: 1_025 }, (_, index) => `
    Sidechain(source: dialogue, amount: -6db, threshold: -30db) {
      Tone(frequency: ${440 + index}hz, duration: 20ms, amplitude: 0.01%);
    }`).join("\n");
  const ir = compile(program(`
    Bus(name: "dialogue") as dialogue { Tone(frequency: 3khz, duration: 20ms, amplitude: 1%); }
    Bus(name: "music") { ${controls} }
  `));
  expectControlError(ir, "CUT_STEM_CONTROL_LIMIT", /more than 1024 Sidechain control dependencies/);
});

function routeSet(includeMusic: boolean) {
  return compile(program(`
    Bus(name: "dialogue") { Tone(frequency: 1khz, duration: 20ms, amplitude: 5%); }
    ${includeMusic ? 'Bus(name: "music") { Tone(frequency: 2khz, duration: 20ms, amplitude: 5%); }' : ""}
  `));
}

test("strict prior loading preserves exact v3/v4/v5 cleanup compatibility and denies non-closed v5 authority", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-stem-prior-controls-"));
  try {
    const controlledDirectory = resolve(root, "controlled"), firstControlled = compile(controlled());
    await renderReferenceAudioStems(firstControlled, firstControlled.compositions[0], root, controlledDirectory);
    const controlledShrink = routeSet(false);
    await renderReferenceAudioStems(controlledShrink, controlledShrink.compositions[0], root, controlledDirectory);
    await assert.rejects(access(resolve(controlledDirectory, "music.wav")), "canonical v5 lock and Sidechain dependencies should retain stale cleanup authority");

    const v4Directory = resolve(root, "v4"), firstV4 = routeSet(true);
    const v4Rendered = await renderReferenceAudioStems(firstV4, firstV4.compositions[0], root, v4Directory);
    const v4 = structuredClone(v4Rendered.manifest) as unknown as Record<string, unknown>;
    v4.version = 4;
    delete v4.lock;
    await writeFile(v4Rendered.manifestPath, `${stableJsonStringify(v4)}\n`);
    const secondV4 = routeSet(false);
    await renderReferenceAudioStems(secondV4, secondV4.compositions[0], root, v4Directory);
    await assert.rejects(access(resolve(v4Directory, "music.wav")), "canonical historical v4 ownership should remain cleanup-safe");

    const legacyDirectory = resolve(root, "legacy"), firstLegacy = routeSet(true);
    const legacyRendered = await renderReferenceAudioStems(firstLegacy, firstLegacy.compositions[0], root, legacyDirectory);
    const legacy = structuredClone(legacyRendered.manifest) as unknown as Record<string, unknown>;
    legacy.version = 3;
    delete legacy.lock;
    for (const stem of legacy.stems as Array<Record<string, unknown>>) delete stem.sidechainInputs;
    await writeFile(legacyRendered.manifestPath, `${stableJsonStringify(legacy)}\n`);
    const secondLegacy = routeSet(false);
    await renderReferenceAudioStems(secondLegacy, secondLegacy.compositions[0], root, legacyDirectory);
    await assert.rejects(access(resolve(legacyDirectory, "music.wav")), "canonical historical v3 ownership should remain cleanup-safe");

    for (const kind of ["missing-lock", "malformed-lock", "missing-sidechain-inputs", "unknown-field"] as const) {
      const hostileDirectory = resolve(root, kind), firstHostile = routeSet(true);
      const hostileRendered = await renderReferenceAudioStems(firstHostile, firstHostile.compositions[0], root, hostileDirectory);
      const hostile = structuredClone(hostileRendered.manifest) as unknown as Record<string, unknown>;
      const firstStem = (hostile.stems as Array<Record<string, unknown>>)[0];
      if (kind === "missing-lock") delete hostile.lock;
      else if (kind === "malformed-lock") hostile.lock = { sha256: "A".repeat(64) };
      else if (kind === "missing-sidechain-inputs") delete firstStem.sidechainInputs;
      else firstStem.unknownControl = true;
      await writeFile(hostileRendered.manifestPath, `${stableJsonStringify(hostile)}\n`);
      const secondHostile = routeSet(false);
      await renderReferenceAudioStems(secondHostile, secondHostile.compositions[0], root, hostileDirectory);
      await access(resolve(hostileDirectory, "music.wav"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
