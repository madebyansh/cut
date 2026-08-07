import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRTranscriptBindingV1 } from "../lib/language/ir";
import {
  applyCutLock,
  applyCutLockForVerifiedInputSession,
  createCutLock,
  CutLockError,
  type CutTranscriptResourceFileIo,
  defaultCutTranscriptResourceFileIo,
  readLockedTranscriptResourceForTests,
} from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  CutTranscriptLockError,
  cutTranscriptSidecarMaxBytes,
  verifyCutTranscriptBindingsForLock,
} from "../lib/language/transcript-lock";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { prepareReferenceVerifiedInputSession } from "../lib/runtime/reference/verified-input-session";

const q = (numerator: number | bigint | string, denominator: number | bigint | string = 1) =>
  rational(numerator, denominator);

function monoPcm16Wav(durationSeconds = 1, sampleRate = 48_000) {
  const frames = durationSeconds * sampleRate;
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
  return bytes;
}

const source = `cut 0.4;
project "Transcript lock proof";
asset transcriptData: DataAsset = data("assets/interview.transcript.json");
asset voice: AudioAsset = audio("assets/interview.wav");
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene answer(duration: 1s) {}
}
export out = render(main);`;

type Sidecar = {
  format: "cut-transcript";
  version: 1;
  media: IRTranscriptBindingV1["media"];
  words: IRTranscriptBindingV1["words"];
};

function selectedIdsSha256(words: IRTranscriptBindingV1["words"]) {
  return createHash("sha256").update(JSON.stringify(words.map((word) => word.id))).digest("hex");
}

function compileFixture(sidecar: Sidecar): { ir: CutAVIR; binding: IRTranscriptBindingV1 } {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const compiled = compileCutModule(parsed.module);
  assert.equal(
    compiled.check.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    0,
    JSON.stringify(compiled.check.diagnostics),
  );
  const ir = compiled.ir;
  const composition = ir.compositions[0];
  const scene = Object.values(ir.scenes)[0];
  const transcriptResource = Object.values(ir.resources).find((resource) => resource.kind === "data");
  const audioResource = Object.values(ir.resources).find((resource) => resource.kind === "audio");
  assert.ok(composition && scene && transcriptResource && audioResource);
  const first = sidecar.words[0]!;
  const last = sidecar.words.at(-1)!;
  const binding: IRTranscriptBindingV1 = {
    id: "transcript_binding_answer",
    version: 1,
    kind: "transcript-edit",
    compositionId: composition.id,
    sceneId: scene.id,
    transcriptResourceId: transcriptResource.id,
    audioResourceId: audioResource.id,
    from: first.id,
    through: last.id,
    selectedWordCount: sidecar.words.length,
    selectedIdsSha256: selectedIdsSha256(sidecar.words),
    text: "Hello, world",
    words: structuredClone(sidecar.words),
    sourceRange: {
      start: first.start,
      duration: q(
        BigInt(last.end.numerator) * BigInt(first.start.denominator)
          - BigInt(first.start.numerator) * BigInt(last.end.denominator),
        BigInt(last.end.denominator) * BigInt(first.start.denominator),
      ),
    },
    destinationRange: {
      start: q(0),
      duration: q(
        BigInt(last.end.numerator) * BigInt(first.start.denominator)
          - BigInt(first.start.numerator) * BigInt(last.end.denominator),
        BigInt(last.end.denominator) * BigInt(first.start.denominator),
      ),
    },
    linkId: "answer-a",
    media: structuredClone(sidecar.media),
    provenance: structuredClone(scene.provenance),
  };
  ir.transcriptBindings = [binding];
  finalizeGraphHashes(ir);
  return { ir, binding };
}

function canonicalSidecar(audioSha256: string): Sidecar {
  return {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: audioSha256,
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: q(1),
    },
    words: [
      { id: "w1", start: q(0), end: q(1, 48_000), text: "Hello", join: "none" },
      { id: "w2", start: q(1, 48_000), end: q(2, 48_000), text: ",", join: "none" },
      { id: "w3", start: q(2, 48_000), end: q(3, 48_000), text: "world", join: "space", speaker: "Alex" },
    ],
  };
}

async function projectFixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-transcript-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = resolve(root, "assets");
  await mkdir(assets, { recursive: true });
  const audioBytes = monoPcm16Wav();
  const audioSha256 = createHash("sha256").update(audioBytes).digest("hex");
  const sidecar = canonicalSidecar(audioSha256);
  await writeFile(resolve(assets, "interview.wav"), audioBytes);
  await writeFile(resolve(assets, "interview.transcript.json"), JSON.stringify(sidecar));
  return { root, sidecar };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectTranscriptLockError(code: CutTranscriptLockError["code"], path: RegExp) {
  return (error: unknown) => error instanceof CutTranscriptLockError
    && error.code === code
    && path.test(error.path)
    && error.source.bindingId === "transcript_binding_answer";
}

test("create and apply lock reproduce the selected transcript from exact DataAsset and AudioAsset evidence", { timeout: 120_000 }, async (t) => {
  const { root, sidecar } = await projectFixture(t);
  const created = compileFixture(sidecar);
  const lock = await createCutLock(created.ir, root);
  assert.equal(lock.resources[created.binding.transcriptResourceId]?.kind, "data");
  assert.equal(lock.resources[created.binding.audioResourceId]?.kind, "audio");
  assert.equal(lock.resources[created.binding.audioResourceId]?.sha256, sidecar.media.sha256);

  const fresh = compileFixture(sidecar);
  await applyCutLock(fresh.ir, lock, root);
  assert.equal(fresh.ir.determinism.semantic, "locked");
  assert.equal(fresh.ir.resources[fresh.binding.transcriptResourceId]?.state, "locked");
  assert.equal(fresh.ir.resources[fresh.binding.audioResourceId]?.sha256, sidecar.media.sha256);
});

test("locked transcript cleanup maps close failure without masking the primary read diagnostic", async (t) => {
  const { root, sidecar } = await projectFixture(t);
  const compiled = compileFixture(sidecar);
  const lock = await createCutLock(compiled.ir, root);
  const resource = compiled.ir.resources[compiled.binding.transcriptResourceId];
  const locked = lock.resources[compiled.binding.transcriptResourceId];
  assert.ok(resource && locked);
  const bindingPath = "$.transcriptBindings[0]";

  let closeFailures = 0;
  const closeFailureIo: CutTranscriptResourceFileIo = {
    open: async (path, flags) => {
      const handle = await defaultCutTranscriptResourceFileIo.open(path, flags);
      return {
        ...handle,
        close: async () => {
          await handle.close();
          closeFailures += 1;
          throw Object.assign(new Error("injected transcript close failure"), { code: "EIO" });
        },
      };
    },
  };
  await assert.rejects(
    readLockedTranscriptResourceForTests(
      root,
      resource,
      locked,
      compiled.binding,
      bindingPath,
      closeFailureIo,
    ),
    (error: unknown) => error instanceof CutTranscriptLockError
      && error.code === "CUT_TRANSCRIPT_LOCK_INTEGRITY"
      && error.path === `${bindingPath}.transcriptResourceId`
      && error.source.bindingId === compiled.binding.id
      && /cannot securely close/u.test(error.message)
      && /injected transcript close failure/u.test(error.message),
  );
  assert.equal(closeFailures, 1);

  let primaryCloseFailures = 0;
  const readAndCloseFailureIo: CutTranscriptResourceFileIo = {
    open: async (path, flags) => {
      const handle = await defaultCutTranscriptResourceFileIo.open(path, flags);
      return {
        ...handle,
        read: async () => { throw Object.assign(new Error("injected transcript read failure"), { code: "EIO" }); },
        close: async () => {
          await handle.close();
          primaryCloseFailures += 1;
          throw Object.assign(new Error("secondary transcript close failure"), { code: "EIO" });
        },
      };
    },
  };
  await assert.rejects(
    readLockedTranscriptResourceForTests(
      root,
      resource,
      locked,
      compiled.binding,
      bindingPath,
      readAndCloseFailureIo,
    ),
    (error: unknown) => error instanceof CutTranscriptLockError
      && error.code === "CUT_TRANSCRIPT_LOCK_INTEGRITY"
      && error.path === `${bindingPath}.transcriptResourceId`
      && error.source.bindingId === compiled.binding.id
      && /cannot open or read/u.test(error.message)
      && /injected transcript read failure/u.test(error.message)
      && !/secondary transcript close failure/u.test(error.message),
  );
  assert.equal(primaryCloseFailures, 1);
});

test("create and apply refuse a re-signed ledger whose selection cannot be reproduced", { timeout: 120_000 }, async (t) => {
  const { root, sidecar } = await projectFixture(t);
  const staleAtCreate = compileFixture(sidecar);
  staleAtCreate.binding.text = "Hello world";
  finalizeGraphHashes(staleAtCreate.ir);
  await assert.rejects(
    createCutLock(staleAtCreate.ir, root),
    expectTranscriptLockError("CUT_TRANSCRIPT_LOCK_SELECTION", /^\$\.transcriptBindings\[0\]$/u),
  );

  const lock = await createCutLock(compileFixture(sidecar).ir, root);
  const staleAtApply = compileFixture(sidecar);
  staleAtApply.binding.words[2]!.text = "planet";
  staleAtApply.binding.text = "Hello, planet";
  finalizeGraphHashes(staleAtApply.ir);
  await assert.rejects(
    applyCutLock(staleAtApply.ir, lock, root),
    expectTranscriptLockError("CUT_TRANSCRIPT_LOCK_SELECTION", /^\$\.transcriptBindings\[0\]$/u),
  );
});

test("sidecar parser and locked audio proof reject semantic, selector, sample-rate, duration, and byte tampering", { timeout: 120_000 }, async (t) => {
  const { root, sidecar } = await projectFixture(t);
  const canonical = compileFixture(sidecar);
  const lock = await createCutLock(canonical.ir, root);
  const transcriptId = canonical.binding.transcriptResourceId;
  const transcriptPath = resolve(root, "assets/interview.transcript.json");
  const reader = async () => readFile(transcriptPath);

  const malformed = clone(lock);
  const malformedBytes = Buffer.from("{");
  malformed.resources[transcriptId]!.bytes = malformedBytes.byteLength;
  malformed.resources[transcriptId]!.sha256 = createHash("sha256").update(malformedBytes).digest("hex");
  await writeFile(transcriptPath, malformedBytes);
  await assert.rejects(
    verifyCutTranscriptBindingsForLock(canonical.ir, malformed.resources, reader),
    expectTranscriptLockError("CUT_TRANSCRIPT_LOCK_SIDECAR", /\.transcriptResourceId$/u),
  );

  const mediaCases: Array<{ name: string; mutate(value: Sidecar): void; path: RegExp }> = [
    {
      name: "digest",
      mutate(value) { value.media.sha256 = "f".repeat(64); },
      path: /\.media\.sha256$/u,
    },
    {
      name: "selected stream",
      mutate(value) { value.media.audioStreamIndex = 1; },
      path: /\.media\.audioStreamIndex$/u,
    },
    {
      name: "sample rate",
      mutate(value) {
        value.media.audioSampleRate = 44_100;
        value.words = value.words.map((word, index) => ({
          ...word,
          start: q(index, 44_100),
          end: q(index + 1, 44_100),
        }));
      },
      path: /\.media\.audioSampleRate$/u,
    },
    {
      name: "duration",
      mutate(value) { value.media.duration = q(2); },
      path: /\.media\.duration$/u,
    },
  ];
  for (const item of mediaCases) {
    const changedSidecar = clone(sidecar);
    item.mutate(changedSidecar);
    const changed = compileFixture(changedSidecar);
    const bytes = Buffer.from(JSON.stringify(changedSidecar));
    const evidence = clone(lock);
    evidence.resources[transcriptId]!.bytes = bytes.byteLength;
    evidence.resources[transcriptId]!.sha256 = createHash("sha256").update(bytes).digest("hex");
    await assert.rejects(
      verifyCutTranscriptBindingsForLock(changed.ir, evidence.resources, async () => bytes),
      (error: unknown) => {
        assert.ok(expectTranscriptLockError("CUT_TRANSCRIPT_LOCK_MEDIA", item.path)(error), item.name);
        return true;
      },
    );
  }

  const restoredBytes = Buffer.from(JSON.stringify(sidecar));
  await writeFile(transcriptPath, restoredBytes);
  const changedBytes = Buffer.from(restoredBytes);
  const hello = changedBytes.indexOf(Buffer.from("Hello"));
  assert.notEqual(hello, -1);
  changedBytes.set(Buffer.from("Jello"), hello);
  await writeFile(transcriptPath, changedBytes);
  await assert.rejects(
    applyCutLock(compileFixture(sidecar).ir, lock, root),
    (error: unknown) => error instanceof CutLockError
      && error.code === "CUT_LOCK_INTEGRITY"
      && /\.resources\./u.test(error.path),
    "full apply must reject changed DataAsset bytes before trusting sidecar semantics",
  );
});

test("optional transcript video provenance is independently authenticated against the locked co-located media probe", { timeout: 120_000 }, async (t) => {
  const { root, sidecar } = await projectFixture(t);
  const canonical = compileFixture(sidecar);
  const lock = await createCutLock(canonical.ir, root);
  const withVideo = clone(sidecar);
  withVideo.media.videoStreamIndex = 1;
  withVideo.media.videoFrameRate = q(24);
  const selected = compileFixture(withVideo);
  const bytes = Buffer.from(JSON.stringify(withVideo));
  const transcriptId = selected.binding.transcriptResourceId;
  const audioId = selected.binding.audioResourceId;

  await writeFile(resolve(root, "assets/interview.transcript.json"), bytes);
  await assert.rejects(
    createCutLock(selected.ir, root),
    expectTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      /^\$\.transcriptBindings\[0\]\.media\.videoStreamIndex$/u,
    ),
    "a sidecar cannot invent video provenance for an audio-only locked file",
  );

  const evidence = clone(lock.resources);
  evidence[transcriptId]!.bytes = bytes.byteLength;
  evidence[transcriptId]!.sha256 = createHash("sha256").update(bytes).digest("hex");
  const audio = evidence[audioId];
  assert.ok(audio && audio.probe.kind === "media");
  audio.probe.identity.streams.push({
    index: 1,
    type: "video",
    codec: "rawvideo",
    frameRate: q(24),
    disposition: [],
  });
  await assert.doesNotReject(
    verifyCutTranscriptBindingsForLock(
      selected.ir,
      evidence,
      async () => bytes,
    ),
    "matching stream identity and exact nominal rate authenticate optional video provenance",
  );

  const wrongRate = clone(evidence);
  const wrongRateAudio = wrongRate[audioId];
  assert.ok(wrongRateAudio && wrongRateAudio.probe.kind === "media");
  const videoStream = wrongRateAudio.probe.identity.streams.find((stream) =>
    stream.type === "video" && stream.index === 1);
  assert.ok(videoStream);
  videoStream.frameRate = q(25);
  await assert.rejects(
    verifyCutTranscriptBindingsForLock(
      selected.ir,
      wrongRate,
      async () => bytes,
    ),
    expectTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      /^\$\.transcriptBindings\[0\]\.media\.videoFrameRate$/u,
    ),
  );
});

test("create lock reports a source-located transcript diagnostic when the sidecar cannot resolve", { timeout: 120_000 }, async (t) => {
  const { root, sidecar } = await projectFixture(t);
  const transcriptPath = resolve(root, "assets/interview.transcript.json");
  await rm(transcriptPath);
  await assert.rejects(
    createCutLock(compileFixture(sidecar).ir, root),
    expectTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_RESOURCE",
      /^\$\.transcriptBindings\[0\]\.transcriptResourceId$/u,
    ),
  );

  await writeFile(transcriptPath, Buffer.alloc(cutTranscriptSidecarMaxBytes + 1));
  await assert.rejects(
    createCutLock(compileFixture(sidecar).ir, root),
    expectTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_SIDECAR",
      /^\$\.transcriptBindings\[0\]\.transcriptResourceId$/u,
    ),
  );
});

test("create lock converts a transcript symlink escape into a source-located resource refusal", { timeout: 120_000 }, async (t) => {
  const { root, sidecar } = await projectFixture(t);
  const outside = await mkdtemp(resolve(tmpdir(), "cut-transcript-lock-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const transcriptPath = resolve(root, "assets/interview.transcript.json");
  const outsidePath = resolve(outside, "interview.transcript.json");
  await writeFile(outsidePath, JSON.stringify(sidecar));
  await rm(transcriptPath);
  await symlink(outsidePath, transcriptPath);
  await assert.rejects(
    createCutLock(compileFixture(sidecar).ir, root),
    expectTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_RESOURCE",
      /^\$\.transcriptBindings\[0\]\.transcriptResourceId$/u,
    ),
  );
});

test("verified input sessions re-authenticate transcript semantics from the sealed private master snapshot", { timeout: 120_000 }, async (t) => {
  const { root, sidecar } = await projectFixture(t);
  const lock = await createCutLock(compileFixture(sidecar).ir, root);
  const hostile = compileFixture(sidecar);
  hostile.binding.words[2]!.text = "planet";
  hostile.binding.text = "Hello, planet";
  finalizeGraphHashes(hostile.ir);

  const applied = await applyCutLockForVerifiedInputSession(hostile.ir, lock, root);
  await assert.rejects(
    prepareReferenceVerifiedInputSession(applied.ir, root, "master"),
    expectTranscriptLockError("CUT_TRANSCRIPT_LOCK_SELECTION", /^\$\.transcriptBindings\[0\]$/u),
  );
});
