import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import { checkCutModule } from "../lib/language/checker";
import type { CutAVIR, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity, renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { ReferenceAudioConfigError, referenceAudioNodeConfig } from "../lib/runtime/reference/audio-config";
import { referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { planReferenceAudioStems } from "../lib/runtime/reference/stems";
import { renderReferenceAudioStems } from "./reference-stem-test-helper";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function checked(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const compiled = compileCutModule(parsed.module);
  assert.deepEqual(compiled.check.diagnostics, []);
  return compiled.ir;
}

function diagnostics(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return checkCutModule(parsed.module).diagnostics;
}

function program(body: string, title = "Audio role proof") {
  return `cut 0.4;
project "${title}";
import { Bus, Tone } from "@cut/audio";
timeline main(duration: 20ms, fps: 50, width: 16px, height: 16px, sampleRate: 48khz) {
  ${body}
}
export out = render(main, width: 16px, height: 16px);`;
}

function oneRole(role: string) {
  return program(`Bus(name: "mix", role: "${role}") { Tone(frequency: 1000hz, duration: 20ms, amplitude: 5%); }`);
}

function bus(ir: CutAVIR, name: string) {
  const result = Object.values(ir.nodes).find((node) => node.op === "cut.audio.bus" && node.inputs.name?.kind === "string" && node.inputs.name.value === name);
  assert.ok(result);
  return result;
}

const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version 7.1.1\nconfiguration: --cut-audio-role-test");

function audioCachePlan(ir: CutAVIR) {
  const composition = ir.compositions[0];
  return createReferenceAudioCachePlan(ir, composition, referenceMasterAudioRootIds(ir, composition), toolchain);
}

test("Bus role is a closed ordinary typed IR input and top-level stem metadata for all four roles", async () => {
  const ir = checked(program(`
    Bus(name: "voice", role: "dialogue") { Tone(frequency: 400hz, duration: 20ms, amplitude: 2%); }
    Bus(name: "score", role: "music") { Tone(frequency: 500hz, duration: 20ms, amplitude: 2%); }
    Bus(name: "room", role: "ambience") { Tone(frequency: 600hz, duration: 20ms, amplitude: 2%); }
    Bus(name: "hits", role: "sfx") { Tone(frequency: 700hz, duration: 20ms, amplitude: 2%); }
  `));
  const composition = ir.compositions[0], plan = planReferenceAudioStems(ir, composition);
  assert.deepEqual(plan.routes.map(({ name, role, file }) => ({ name, role, file })), [
    { name: "voice", role: "dialogue", file: "voice.wav" },
    { name: "score", role: "music", file: "score.wav" },
    { name: "room", role: "ambience", file: "room.wav" },
    { name: "hits", role: "sfx", file: "hits.wav" },
  ]);
  for (const route of plan.routes) {
    assert.deepEqual(ir.nodes[route.nodeId].inputs.role, { kind: "string", value: route.role });
    assert.equal(referenceAudioNodeConfig(ir, composition, ir.nodes[route.nodeId])?.kind, "bus");
  }

  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-roles-"));
  try {
    const rendered = await renderReferenceAudioStems(ir, composition, root, resolve(root, "stems"));
    assert.deepEqual(rendered.manifest.stems.map(({ name, role, file }) => ({ name, role, file })), [
      { name: "voice", role: "dialogue", file: "voice.wav" },
      { name: "score", role: "music", file: "score.wav" },
      { name: "room", role: "ambience", file: "room.wav" },
      { name: "hits", role: "sfx", file: "hits.wav" },
    ]);
    const written = JSON.parse(await readFile(rendered.manifestPath, "utf8")) as typeof rendered.manifest;
    assert.deepEqual(written, rendered.manifest);
    assert.ok(rendered.manifest.stems.every((stem) => stem.samples === 960 && stem.bytes > 960 * 6));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("role-only edits change semantic/build/stem identity while preserving decoded PCM and the audio artifact cache", { timeout: 30_000 }, async () => {
  const dialogue = checked(oneRole("dialogue")), music = checked(oneRole("music"));
  const dialogueBus = bus(dialogue, "mix"), musicBus = bus(music, "mix");
  assert.notEqual(dialogue.buildId, music.buildId);
  assert.notEqual(dialogueBus.contentHash, musicBus.contentHash);
  const change = diffCutAVIR(dialogue, music).changes.find((item) => item.entity === "node" && item.id === dialogueBus.id);
  assert.ok(change && change.operation === "modify");
  assert.ok(change.fields.some((field) => field.path === "/inputs/role/value" && field.before === "dialogue" && field.after === "music"));
  assert.equal(audioCachePlan(dialogue).key, audioCachePlan(music).key, "transparent role metadata must not invalidate pre-master PCM");

  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-role-cache-"));
  try {
    const first = await renderReferenceAudioArtifact(dialogue, dialogue.compositions[0], root);
    const second = await renderReferenceAudioArtifact(music, music.compositions[0], root);
    assert.equal(first.cache.status, "miss");
    assert.equal(second.cache.status, "hit");
    assert.equal(second.cache.key, first.cache.key);
    assert.deepEqual(await readFile(second.path), await readFile(first.path));

    const dialogueStems = await renderReferenceAudioStems(dialogue, dialogue.compositions[0], root, resolve(root, "dialogue"));
    const musicStems = await renderReferenceAudioStems(music, music.compositions[0], root, resolve(root, "music"));
    assert.equal(dialogueStems.manifest.stems[0].role, "dialogue");
    assert.equal(musicStems.manifest.stems[0].role, "music");
    assert.notEqual(dialogueStems.manifest.buildId, musicStems.manifest.buildId);
    assert.notEqual(dialogueStems.manifest.stems[0].graphHash, musicStems.manifest.stems[0].graphHash);
    assert.equal(dialogueStems.manifest.stems[0].sha256, musicStems.manifest.stems[0].sha256);
    assert.notEqual(await readFile(dialogueStems.manifestPath, "utf8"), await readFile(musicStems.manifestPath, "utf8"));
    assert.deepEqual(await readFile(resolve(dialogueStems.directory, "mix.wav")), await readFile(resolve(musicStems.directory, "mix.wav")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate roles are valid and a nested Bus role stays authored without becoming a delivered stem", () => {
  const ir = checked(program(`
    Bus(name: "host", role: "dialogue") {
      Bus(name: "nested-score", role: "music") { Tone(frequency: 440hz, duration: 20ms); }
    }
    Bus(name: "guest", role: "dialogue") { Tone(frequency: 660hz, duration: 20ms); }
  `));
  const plan = planReferenceAudioStems(ir, ir.compositions[0]);
  assert.deepEqual(plan.routes.map(({ name, role }) => ({ name, role })), [
    { name: "host", role: "dialogue" },
    { name: "guest", role: "dialogue" },
  ]);
  assert.deepEqual(bus(ir, "nested-score").inputs.role, { kind: "string", value: "music" });
});

test("source role enum and type failures are stable and located at the authored value", () => {
  const unknown = diagnostics(oneRole("voice"));
  const enumFailure = unknown.find((item) => item.code === "CUT2068");
  assert.ok(enumFailure);
  assert.equal(enumFailure.span.start.line, 5);
  assert.match(enumFailure.message, /dialogue, music, ambience, sfx/u);

  const wrongType = diagnostics(program("Bus(name: \"mix\", role: 1) { Tone(frequency: 1000hz, duration: 20ms); }"));
  const typeFailure = wrongType.find((item) => item.code === "CUT2029");
  assert.ok(typeFailure);
  assert.equal(typeFailure.span.start.line, 5);
  assert.match(typeFailure.message, /expects String, found Number/u);
});

test("hostile loaded Bus roles fail source-located in runtime and stem preflight", () => {
  const hostile = checked(oneRole("dialogue"));
  const node = bus(hostile, "mix");
  node.inputs.role = { kind: "string", value: "voice" };
  finalizeGraphHashes(hostile);
  const loaded = loadCutAvIr(JSON.stringify(hostile));
  const rejected = (work: () => unknown, code: ReferenceAudioConfigError["code"]) => assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioConfigError);
    assert.equal(error.code, code);
    assert.ok("module" in error.source);
    assert.equal(error.source.module, "project.cut");
    assert.equal("line" in error.source && error.source.line, 5);
    assert.match(error.message, /cut\.audio\.bus at project\.cut:5:/u);
    return true;
  });
  rejected(() => validateReferenceSession(loaded), "CUT_AUDIO_ENUM");
  rejected(() => planReferenceAudioStems(loaded, loaded.compositions[0]), "CUT_AUDIO_ENUM");

  const wrongType = checked(oneRole("dialogue")), wrongBus = bus(wrongType, "mix");
  wrongBus.inputs.role = { kind: "boolean", value: true } satisfies IRValue;
  finalizeGraphHashes(wrongType);
  const loadedWrongType = loadCutAvIr(JSON.stringify(wrongType));
  rejected(() => validateReferenceSession(loadedWrongType), "CUT_AUDIO_INPUT_TYPE");
});

test("hostile loaded Bus role diagnostics are identity-checked and output-bounded", () => {
  const stale = checked(oneRole("dialogue")), staleBus = bus(stale, "mix");
  staleBus.inputs.role = { kind: "string", value: "voice" };
  assert.throws(() => loadCutAvIr(JSON.stringify(stale)), (error) => {
    assert.ok(error instanceof CutAvIrValidationError);
    assert.equal(error.code, "CUT_IR_IDENTITY");
    assert.match(error.path, /\.contentHash$/u);
    return true;
  });

  const hostileRole = `voice-${"🧨".repeat(20_000)}`;
  const hostile = checked(oneRole("dialogue")), hostileBus = bus(hostile, "mix");
  hostileBus.inputs.role = { kind: "string", value: hostileRole };
  finalizeGraphHashes(hostile);
  const loaded = loadCutAvIr(JSON.stringify(hostile));
  for (const work of [
    () => validateReferenceSession(loaded),
    () => planReferenceAudioStems(loaded, loaded.compositions[0]),
  ]) {
    assert.throws(work, (error) => {
      assert.ok(error instanceof ReferenceAudioConfigError);
      assert.equal(error.code, "CUT_AUDIO_ENUM");
      assert.ok(error.message.length < 1_024, "hostile role must not amplify the diagnostic");
      assert.match(error.message, /20006 Unicode code points; 80006 UTF-8 bytes/u);
      assert.match(error.message, new RegExp(`sha256:${createHash("sha256").update(hostileRole).digest("hex").slice(0, 12)}`));
      assert.doesNotMatch(error.message, /\uFFFD/u, "the preview must not split a Unicode scalar");
      assert.deepEqual(error.source, {
        module: "project.cut",
        line: 5,
        column: 3,
        nodeId: hostileBus.id,
      });
      return true;
    });
  }
});
