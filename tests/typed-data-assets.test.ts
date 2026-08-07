import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import {
  applyCutLock,
  createCutLock,
  CutLockError,
  defaultCutTypedDataAssetFileIo,
  validateLockedTypedDataAssetBytesForTests,
  type CutTypedDataAssetFileIo,
} from "../lib/language/lock";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { loadCutTranscriptCompileInputs } from "../lib/language/transcript-compile-inputs";
import {
  createCutTypedDataAssetAuthority,
  type CutTypedDataAssetAuthorityV1,
} from "../lib/language/typed-data-asset";
import { CutTypedDataAssetPayloadError } from "../lib/language/typed-data-asset-bytes";
import { CutRelinkError, relinkCutSource } from "../lib/project/relink";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const fontFixture = resolve("examples/fixtures/Geist-Regular.ttf");

const vtt = `WEBVTT

one
00:00:00.000 --> 00:00:01.000
Exact caption
`;

const cube = `LUT_1D_SIZE 2
0 0 0
1 1 1
`;

const transcript = JSON.stringify({
  format: "cut-transcript",
  version: 1,
  media: {
    sha256: "a".repeat(64),
    audioStreamIndex: 0,
    audioSampleRate: 48_000,
    duration: { numerator: "1", denominator: "1" },
  },
  words: [],
});

function monoPcm16Wav(sampleRate = 48_000) {
  const frames = sampleRate;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 0.1 * 32_767);
    bytes.writeInt16LE(sample, 44 + frame * 2);
  }
  return bytes;
}

function transcriptForAudio(audioSha256: string) {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: audioSha256,
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: { numerator: "1", denominator: "1" },
    },
    words: [
      { id: "one", start: { numerator: "0", denominator: "1" }, end: { numerator: "1", denominator: "4" }, text: "Typed", join: "none" },
      { id: "two", start: { numerator: "1", denominator: "4" }, end: { numerator: "1", denominator: "2" }, text: "transcript", join: "space" },
    ],
  });
}

const transcriptExecutionSource = `cut 0.4;
project "typed transcript execution";
import { AudioGap, AudioTrack, TranscriptAudio, transcriptEdit } from "@cut/edit";
asset words: TranscriptAsset = transcript("assets/transcript.json");
asset voice: AudioAsset = audio("assets/voice.wav", stream: 0);
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "one",
      through: "two",
      at: 250ms
    );
    AudioTrack() {
      AudioGap(destination: 0s..<250ms);
      TranscriptAudio(edit: quote);
      AudioGap(destination: 750ms..<1s);
    }
  }
}
export out = render(main);`;

function source(constructors = true) {
  return `cut 0.4;
project "typed byte authority";
import { Captions, LUT, Rect } from "cut:visual";
asset captions: ${constructors ? "CaptionAsset = caption(\"assets/captions.bytes\", format: \"webvtt\")" : "DataAsset = data(\"assets/captions.vtt\")"};
asset words: ${constructors ? "TranscriptAsset = transcript(\"assets/transcript.json\")" : "DataAsset = data(\"assets/transcript.json\")"};
asset look: ${constructors ? "LUTAsset = lut(\"assets/look.bytes\")" : "DataAsset = data(\"assets/look.cube\")"};
asset face: FontAsset = font("assets/face.ttf");
timeline main(duration: 1s, fps: 4, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    LUT(source: look) { Rect(width: 320px, height: 180px, fill: #336699); }
    Captions(source: captions, font: face, format: "webvtt", size: 22px, safeX: 5%, safeY: 5%, maxWidth: 90%, padding: 8px);
  }
}
export out = render(main);`;
}

function parse(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return parsed.module;
}

function compile(program = source()) {
  const module = parse(program);
  const checked = checkCutModule(module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(module).ir;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-typed-data-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "assets"));
  await Promise.all([
    writeFile(resolve(root, "assets/captions.vtt"), vtt),
    writeFile(resolve(root, "assets/captions.bytes"), vtt),
    writeFile(resolve(root, "assets/transcript.json"), transcript),
    writeFile(resolve(root, "assets/look.cube"), cube),
    writeFile(resolve(root, "assets/look.bytes"), cube),
    copyFile(fontFixture, resolve(root, "assets/face.ttf")),
  ]);
  return root;
}

async function renderFrame(root: string, program: string, cacheName: string) {
  const ir = compile(program);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, `.cut/cache/${cacheName}`));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]!];
    assert.ok(scene);
    return Buffer.from((await renderer.sceneFrame(scene, 0, false)).data);
  } finally {
    renderer.close();
  }
}

test("typed data constructors and dedicated consumers expose one closed public nominal contract", () => {
  assert.deepEqual(packageSymbol("cut:core", "caption")?.parameters?.map((item) => item.name), ["path", "format"]);
  assert.equal(packageSymbol("cut:core", "caption")?.returns, "CaptionAsset");
  assert.equal(packageSymbol("cut:core", "transcript")?.returns, "TranscriptAsset");
  assert.equal(packageSymbol("cut:core", "lut")?.returns, "LUTAsset");
  assert.equal(packageSymbol("cut:visual", "Captions")?.parameters?.[0]?.type, "CaptionAsset");
  assert.equal(packageSymbol("cut:visual", "LUT")?.parameters?.[0]?.type, "LUTAsset");

  const ir = compile();
  assert.equal(ir.resources.captions.kind, "data");
  assert.deepEqual(ir.resources.captions.byteAuthority, createCutTypedDataAssetAuthority("caption", "webvtt"));
  assert.deepEqual(ir.resources.words.byteAuthority, createCutTypedDataAssetAuthority("transcript"));
  assert.deepEqual(ir.resources.look.byteAuthority, createCutTypedDataAssetAuthority("lut"));

  const wrong = source().replace("LUT(source: look)", "LUT(source: words)");
  const messages = checkCutModule(parse(wrong)).diagnostics.map((item) => item.message).join("\n");
  assert.match(messages, /expects LUTAsset, found TranscriptAsset/u);
  assert.throws(() => compileCutModule(parse(wrong)), CutCompileError);
});

test("legacy data omission stays exact while dedicated consumers retain source compatibility", () => {
  const ir = compile(source(false));
  for (const resource of [ir.resources.captions, ir.resources.words, ir.resources.look]) {
    assert.equal(resource.kind, "data");
    assert.equal(Object.hasOwn(resource, "byteAuthority"), false);
  }
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
});

test("typed caption and LUT execution is exact RGBA parity with legacy consumer-owned data", { timeout: 120_000 }, async (t) => {
  const root = await fixture(t);
  const typed = await renderFrame(root, source(true), "typed");
  const legacy = await renderFrame(root, source(false), "legacy");
  assert.deepEqual(typed, legacy);
  assert.equal(createHash("sha256").update(typed).digest("hex"), createHash("sha256").update(legacy).digest("hex"));
});

test("TranscriptAsset drives the existing transcriptEdit compile, lock, inspect, and PCM runtime path", { timeout: 120_000 }, async (t) => {
  const root = await fixture(t);
  const audio = monoPcm16Wav();
  await writeFile(resolve(root, "assets/voice.wav"), audio);
  await writeFile(resolve(root, "assets/transcript.json"), transcriptForAudio(createHash("sha256").update(audio).digest("hex")));
  const entry = resolve(root, "main.cut");
  await writeFile(entry, transcriptExecutionSource);
  const module = parse(transcriptExecutionSource);
  const check = checkCutModule(module);
  assert.deepEqual(check.diagnostics.filter((item) => item.severity === "error"), []);
  const loaded = await loadCutTranscriptCompileInputs(entry, module, check);
  assert.deepEqual(loaded.diagnostics, []);
  assert.ok(loaded.inputs.transcriptSidecars?.has("words"));
  const ir = compileCutModule(module, {}, undefined, undefined, loaded.inputs).ir;
  assert.equal(ir.transcriptBindings?.length, 1);
  assert.equal(ir.resources.words.byteAuthority?.kind, "transcript");
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const inspected = inspectCutIr(ir, transcriptExecutionSource);
  const inspectedWords = inspected.resources.find((resource) => resource.id === "words");
  assert.deepEqual(inspectedWords?.byteAuthority, ir.resources.words.byteAuthority);
  const rendered = await renderReferenceAudioArtifact(ir, ir.compositions[0]!, root);
  const pcm = await readFile(rendered.path);
  assert.equal(pcm.byteLength, 48_000 * 2 * 4);
  assert.ok(pcm.some((byte) => byte !== 0), "selected transcript PCM must be audibly non-silent");
});

test("hostile IR authority and consumer tampering fail before execution", () => {
  const identity = structuredClone(compile());
  (identity.resources.captions.byteAuthority as { identity: string }).identity = "0".repeat(64);
  finalizeGraphHashes(identity);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(identity)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_TYPED_DATA_ASSET_AUTHORITY"
      && error.path.endsWith(".byteAuthority.identity"),
  );

  const consumer = structuredClone(compile());
  const lut = Object.values(consumer.nodes).find((node) => node.op === "cut.visual.lut");
  assert.ok(lut);
  lut.inputs.source = { kind: "resource-ref", id: "captions" };
  finalizeGraphHashes(consumer);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(consumer)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_TYPED_DATA_ASSET_AUTHORITY"
      && /cannot consume caption byte authority/u.test(error.message),
  );
});

test("lock creation, application, and strict unused-payload parsing bind typed byte authority", { timeout: 120_000 }, async (t) => {
  const root = await fixture(t);
  const ir = compile();
  const lock = await createCutLock(ir, root);
  assert.deepEqual(lock.resources.captions.byteAuthority, ir.resources.captions.byteAuthority);
  assert.deepEqual(lock.resources.words.byteAuthority, ir.resources.words.byteAuthority);
  assert.deepEqual(lock.resources.look.byteAuthority, ir.resources.look.byteAuthority);
  await applyCutLock(compile(), lock, root);

  const missing = structuredClone(lock);
  delete missing.resources.look.byteAuthority;
  await assert.rejects(
    applyCutLock(compile(), missing, root),
    (error: unknown) => error instanceof CutLockError
      && error.code === "CUT_LOCK_IDENTITY"
      && error.path.endsWith(".byteAuthority"),
  );

  for (const [locator, malformed, policy, restored] of [
    ["captions.bytes", "not webvtt", "strict-caption-sidecar-v1", vtt],
    ["transcript.json", "{}", "strict-cut-transcript-sidecar-v1", transcript],
    ["look.bytes", "not a cube", "strict-cube-encoded-srgb-v1", cube],
  ] as const) {
    await writeFile(resolve(root, `assets/${locator}`), malformed);
    await assert.rejects(
      createCutLock(compile(), root),
      (error: unknown) => error instanceof CutTypedDataAssetPayloadError
        && error.message.includes(policy),
    );
    await writeFile(resolve(root, `assets/${locator}`), restored);
  }
});

test("typed byte lock validation maps close failure without masking the primary read diagnostic", async (t) => {
  const root = await fixture(t);
  const ir = compile();
  const lock = await createCutLock(ir, root);
  let closeFailures = 0;
  const closeFailureIo: CutTypedDataAssetFileIo = {
    ...defaultCutTypedDataAssetFileIo,
    open: async (path, flags) => {
      const handle = await defaultCutTypedDataAssetFileIo.open(path, flags);
      return {
        ...handle,
        close: async () => {
          await handle.close();
          closeFailures += 1;
          throw Object.assign(new Error("injected typed-data close failure"), { code: "EIO" });
        },
      };
    },
  };
  await assert.rejects(
    validateLockedTypedDataAssetBytesForTests(ir, root, lock.resources, closeFailureIo),
    (error: unknown) => error instanceof CutTypedDataAssetPayloadError
      && error.code === "CUT_TYPED_DATA_ASSET_BYTES"
      && /cannot securely close/u.test(error.message)
      && /injected typed-data close failure/u.test(error.message),
  );
  assert.equal(closeFailures, 1);

  let primaryCloseFailures = 0;
  const readAndCloseFailureIo: CutTypedDataAssetFileIo = {
    ...defaultCutTypedDataAssetFileIo,
    open: async (path, flags) => {
      const handle = await defaultCutTypedDataAssetFileIo.open(path, flags);
      return {
        ...handle,
        read: async () => { throw Object.assign(new Error("injected typed-data read failure"), { code: "EIO" }); },
        close: async () => {
          await handle.close();
          primaryCloseFailures += 1;
          throw Object.assign(new Error("secondary typed-data close failure"), { code: "EIO" });
        },
      };
    },
  };
  await assert.rejects(
    validateLockedTypedDataAssetBytesForTests(ir, root, lock.resources, readAndCloseFailureIo),
    (error: unknown) => error instanceof CutTypedDataAssetPayloadError
      && /cannot securely read/u.test(error.message)
      && /injected typed-data read failure/u.test(error.message)
      && !/secondary typed-data close failure/u.test(error.message),
  );
  assert.equal(primaryCloseFailures, 1);
});

test("relink validates typed replacement bytes and reports the specialized public type", async (t) => {
  const root = await fixture(t);
  const programPath = resolve(root, "main.cut");
  await writeFile(programPath, `cut 0.4;\nproject "typed relink";\nasset look: LUTAsset = lut("assets/look.cube");\n`);
  await writeFile(resolve(root, "assets/new.cube"), cube.replace("1 1 1", "1 .5 .25"));
  await writeFile(resolve(root, "assets/bad.cube"), "not a cube");

  const result = await relinkCutSource({ programPath, assetName: "look", locator: "assets/new.cube" });
  assert.equal(result.asset.kind, "data");
  assert.equal(result.asset.type, "LUTAsset");
  assert.equal(result.probe.kind, "bytes");
  await assert.rejects(
    relinkCutSource({ programPath, assetName: "look", locator: "assets/bad.cube" }),
    (error: unknown) => error instanceof CutRelinkError
      && error.code === "CUT_RELINK_TARGET_INVALID"
      && /strict-cube-encoded-srgb-v1/u.test(error.message),
  );
});

test("typed authority variants are exact identity inputs", () => {
  const webvtt = createCutTypedDataAssetAuthority("caption", "webvtt");
  const srt = createCutTypedDataAssetAuthority("caption", "srt");
  assert.notEqual(webvtt.identity, srt.identity);
  assert.deepEqual(Object.keys(webvtt).sort(), ["format", "identity", "kind", "policy", "version"]);
  assert.equal((webvtt satisfies CutTypedDataAssetAuthorityV1).policy, "strict-caption-sidecar-v1");
  const resourceOnly = (format: "webvtt" | "srt") => compileCutModule(parse(`cut 0.4;
project "authority identity";
asset cues: CaptionAsset = caption("assets/shared.sidecar", format: "${format}");`)).ir;
  assert.notEqual(resourceOnly("webvtt").buildId, resourceOnly("srt").buildId);
});
