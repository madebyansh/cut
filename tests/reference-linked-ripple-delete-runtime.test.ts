import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { CutAvIrValidationError } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import {
  ReferenceAudioEditOperationError,
  validateReferenceAudioTrackOperationPlan,
} from "../lib/runtime/reference/audio-edit-operations";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import { validateReferenceLinkedEditTransactions } from "../lib/runtime/reference/linked-edit";
import {
  ReferenceLinkedRippleDeleteError,
} from "../lib/runtime/reference/linked-ripple-delete";
import {
  ReferencePictureEditOperationError,
  validateReferencePictureTrackOperationPlan,
} from "../lib/runtime/reference/picture-edit-operations";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { finalizeGraphHashes } from "../lib/runtime/graph";

const exec = promisify(execFile);

type PictureTrack = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrack = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };

const source = `cut 0.4;
project "linked ripple runtime proof";
import { LinkedRippleDelete, Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("source.mkv");
asset voice: AudioAsset = audio("source.wav");
timeline main(duration: 4s, fps: 4, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    LinkedRippleDelete(link: "false-start");
    Sequence(duration: 4s) {
      PictureTrack() {
        PictureClip(source: picture, range: 0s ..< 1s, duration: 1s);
        PictureClip(source: picture, range: 1s ..< 2s, duration: 1s, link: "false-start");
        PictureClip(source: picture, range: 2s ..< 4s, duration: 2s);
      }
    }
    AudioTrack() {
      AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s);
      AudioClip(source: voice, range: 1s ..< 2s, destination: 1s ..< 2s, link: "false-start");
      AudioClip(source: voice, range: 2s ..< 4s, destination: 2s ..< 4s);
    }
  }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;

function compile(program = source) {
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
  let offset = 12;
  let sampleRate = 0;
  let blockAlign = 0;
  let bits = 0;
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
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

async function lockedProject(program = source) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-ripple-runtime-"));
  const colors = [
    ...[64, 96, 128, 160].map((red) => [red, 0, 0]),
    ...[64, 96, 128, 160].map((green) => [0, green, 0]),
    ...[64, 96, 128, 160].map((blue) => [0, 0, blue]),
    ...[64, 96, 128, 160].map((yellow) => [yellow, yellow, 0]),
  ];
  const rawFrames = Buffer.concat(colors.map((color) => Buffer.from(Array.from({ length: 16 * 16 }, () => color).flat())));
  const rawPath = resolve(root, "source.rgb");
  await writeFile(rawPath, rawFrames);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "16x16", "-framerate", "4", "-i", rawPath,
    "-frames:v", "16", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrp", resolve(root, "source.mkv"),
  ]);
  const second = 48_000;
  const pcm = [
    ...Array.from({ length: second }, () => 1_000),
    ...Array.from({ length: second }, () => 5_000),
    ...Array.from({ length: second }, () => -10_000),
    ...Array.from({ length: second }, () => 15_000),
  ];
  await writeFile(resolve(root, "source.wav"), monoPcm16Wave(second, pcm));
  const ir = compile(program);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return {
    root,
    ir,
    composition: ir.compositions[0],
    scene: ir.scenes[ir.compositions[0].sceneIds[0]],
  };
}

const mixedSource = source
  .replace("    LinkedRippleDelete(link: \"false-start\");", `    LinkedRippleDelete(link: "false-start");
    LinkedTrim(link: "keep-take", keep: 1s ..< 3s);`)
  .replace(
    "import { LinkedRippleDelete, Sequence, PictureTrack, PictureClip, AudioTrack } from \"@cut/edit\";",
    "import { LinkedRippleDelete, LinkedTrim, Sequence, PictureTrack, PictureClip, AudioTrack } from \"@cut/edit\";",
  )
  .replace("    AudioTrack() {", `    Sequence(duration: 4s) {
      PictureTrack() {
        PictureClip(source: picture, range: 0s ..< 4s, duration: 4s, link: "keep-take");
      }
    }
    AudioTrack() {
      AudioClip(source: voice, range: 0s ..< 4s, destination: 0s ..< 4s, link: "keep-take");
    }
    AudioTrack() {`);

function center(surface: { data: Buffer; width: number; height: number }) {
  const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function nearColor(actual: readonly number[], expected: readonly number[]) {
  expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) <= 3, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`));
}

test("central linked-edit authorization closes both LinkedRippleDelete operation pairs", { timeout: 45_000 }, async () => {
  const project = await lockedProject();
  try {
    const { ir, composition } = project;
    const { picture, audio } = tracks(ir);
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const authorizations = validateReferenceLinkedEditTransactions(ir, composition);
    assert.equal(authorizations.byTransactionId.size, 1);
    const authorization = [...authorizations.byTransactionId.values()][0];
    assert.ok("range" in authorization);
    assert.equal(Object.isFrozen(authorizations), true);
    assert.equal(Object.isFrozen(authorization), true);
    assert.equal((authorizations.byTransactionId as unknown as { set?: unknown }).set, undefined);
    assert.equal((authorizations.pictureByTrackId.get(picture.id) as unknown as { set?: unknown }).set, undefined);
    if ("range" in authorization) {
      assert.equal(Object.isFrozen(authorization.range), true);
      assert.equal(Object.isFrozen(authorization.range.start), true);
      assert.throws(() => {
        (authorization.range.start as { numerator: string }).numerator = "999";
      }, TypeError);
    }
    assert.equal(authorization.picture.insertOperationIndex, 0);
    assert.equal(authorization.picture.deleteOperationIndex, 1);
    assert.equal(authorization.audio.insertOperationIndex, 0);
    assert.equal(authorization.audio.deleteOperationIndex, 1);
    assert.throws(() => validateReferencePictureTrackOperationPlan(ir, composition, picture), /unauthorized LinkedRippleDelete|cannot mutate linked audio independently/);
    assert.throws(() => validateReferenceAudioTrackOperationPlan(ir, composition, audio), /unauthorized LinkedRippleDelete|cannot mutate linked picture independently/);
    assert.doesNotThrow(() => validateReferencePictureTrackOperationPlan(ir, composition, picture, authorizations.pictureByTrackId.get(picture.id)));
    assert.doesNotThrow(() => validateReferenceAudioTrackOperationPlan(ir, composition, audio, authorizations.audioByTrackId.get(audio.id)));
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("central dispatcher merges LinkedTrim and LinkedRippleDelete on separate tracks without weakening either replay", { timeout: 45_000 }, async () => {
  const project = await lockedProject(mixedSource);
  try {
    const authorizations = validateReferenceLinkedEditTransactions(project.ir, project.composition);
    assert.equal(authorizations.byTransactionId.size, 2);
    assert.deepEqual(
      [...authorizations.byTransactionId.values()].map((authorization) => "range" in authorization ? "ripple" : "trim").sort(),
      ["ripple", "trim"],
    );
    assert.equal(authorizations.pictureByTrackId.size, 2);
    assert.equal(authorizations.audioByTrackId.size, 2);
    for (const [trackId, tracksAuthorizations] of authorizations.pictureByTrackId) {
      assert.equal(tracksAuthorizations.size, 1);
      assert.doesNotThrow(() => validateReferencePictureTrackOperationPlan(project.ir, project.composition, project.ir.nodes[trackId], tracksAuthorizations));
    }
    for (const [trackId, tracksAuthorizations] of authorizations.audioByTrackId) {
      assert.equal(tracksAuthorizations.size, 1);
      assert.doesNotThrow(() => validateReferenceAudioTrackOperationPlan(project.ir, project.composition, project.ir.nodes[trackId], tracksAuthorizations));
    }
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("strict-loader failures outside a linked transaction retain their own diagnostic identity", { timeout: 45_000 }, async () => {
  const project = await lockedProject();
  try {
    const hostile = structuredClone(project.ir);
    (hostile.outputs[0] as unknown as Record<string, unknown>).ignored = true;
    assert.throws(
      () => validateReferenceLinkedEditTransactions(hostile, hostile.compositions[0]),
      (error: unknown) => error instanceof CutAvIrValidationError
        && error.code === "CUT_IR_UNKNOWN_FIELD"
        && error.path === "$.outputs[0].ignored",
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("transaction-local off-grid timing keeps the stable LinkedRippleDelete time diagnostic", { timeout: 45_000 }, async () => {
  const project = await lockedProject();
  try {
    const hostile = structuredClone(project.ir);
    const transaction = hostile.linkedEdits?.[0];
    assert.ok(transaction?.kind === "linked-ripple-delete");
    transaction.range.start = { numerator: "1", denominator: "3" };
    assert.throws(
      () => validateReferenceLinkedEditTransactions(hostile, hostile.compositions[0]),
      (error: unknown) => error instanceof ReferenceLinkedRippleDeleteError
        && error.code === "CUT_LINKED_RIPPLE_TIME"
        && error.source.transactionId === transaction.id
        && error.source.module === transaction.provenance.module
        && error.source.line === transaction.provenance.span.start.line
        && error.source.column === transaction.provenance.span.start.column,
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("transaction-local link cardinality and ownership failures keep their stable domain diagnostics", { timeout: 45_000 }, async () => {
  const project = await lockedProject();
  try {
    const cases: Array<{
      code: "CUT_LINKED_RIPPLE_CARDINALITY" | "CUT_LINKED_RIPPLE_SCOPE";
      mutate: (transaction: Extract<NonNullable<CutAVIR["linkedEdits"]>[number], { kind: "linked-ripple-delete" }>) => void;
    }> = [
      { code: "CUT_LINKED_RIPPLE_CARDINALITY", mutate: (transaction) => { transaction.linkId = " bad "; } },
      { code: "CUT_LINKED_RIPPLE_SCOPE", mutate: (transaction) => { transaction.pictureTrackId = "missing_picture_track"; } },
    ];
    for (const entry of cases) {
      const hostile = structuredClone(project.ir);
      const transaction = hostile.linkedEdits?.[0];
      assert.ok(transaction?.kind === "linked-ripple-delete");
      entry.mutate(transaction);
      assert.throws(
        () => validateReferenceLinkedEditTransactions(hostile, hostile.compositions[0]),
        (error: unknown) => error instanceof ReferenceLinkedRippleDeleteError
          && error.code === entry.code
          && error.source.transactionId === transaction.id,
      );
    }
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("picture and audio runtimes execute exact ripple shift plus fixed-duration tail gap", { timeout: 60_000 }, async () => {
  const project = await lockedProject();
  try {
    const { root, ir, composition, scene } = project;
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "visual-cache"));
    await renderer.prepare();
    try {
      const pixels: number[][] = [];
      for (const frame of [0, 3, 4, 7, 8, 11, 12, 15]) pixels.push(center(await renderer.sceneFrame(scene, frame, false)));
      nearColor(pixels[0], [64, 0, 0, 255]);
      nearColor(pixels[1], [160, 0, 0, 255]);
      nearColor(pixels[2], [0, 0, 64, 255]);
      nearColor(pixels[3], [0, 0, 160, 255]);
      nearColor(pixels[4], [64, 64, 0, 255]);
      nearColor(pixels[5], [160, 160, 0, 255]);
      nearColor(pixels[6], [0, 0, 0, 0]);
      nearColor(pixels[7], [0, 0, 0, 0]);
    } finally {
      renderer.close();
    }

    const output = resolve(root, "linked-ripple.wav");
    await renderReferenceAudio(ir, composition, root, output);
    const decoded = pcm24Data(await readFile(output));
    const monoToStereo = Math.SQRT1_2 / 32_768;
    assert.equal(decoded.frames, 192_000);
    const near = (frame: number, expected: number) => assert.ok(
      Math.abs(decoded.sample(frame) - expected * monoToStereo) < .002,
      `sample ${frame}: ${decoded.sample(frame)} != ${expected * monoToStereo}`,
    );
    near(0, 1_000);
    near(47_999, 1_000);
    near(48_000, -10_000);
    near(95_999, -10_000);
    near(96_000, 15_000);
    near(143_999, 15_000);
    near(144_000, 0);
    near(191_999, 0);

    const cold = await renderReferenceAudioArtifact(ir, composition, root);
    const warm = await renderReferenceAudioArtifact(ir, composition, root);
    assert.deepEqual({ status: cold.cache.status, reason: cold.cache.reason }, { status: "miss", reason: "CUT_AUDIO_CACHE_COLD" });
    assert.deepEqual({ status: warm.cache.status, reason: warm.cache.reason }, { status: "hit", reason: "CUT_AUDIO_CACHE_HIT" });
    assert.equal(warm.cache.key, cold.cache.key);
    assert.equal(warm.cache.artifact.sha256, cold.cache.artifact.sha256);

    // Cache identity intentionally projects the executed materialization, not
    // compiler operation history. A forged correlated plan can therefore have
    // the same PCM key as this valid render. Authorization must still run before
    // cache lookup so a warm artifact cannot launder the forged transaction.
    const hostile = structuredClone(ir);
    tracks(hostile).audio.editorial.operationPlan!.operations.pop();
    await assert.rejects(
      renderReferenceAudioArtifact(hostile, hostile.compositions[0], root),
      (error: unknown) => error instanceof ReferenceLinkedRippleDeleteError
        && error.code === "CUT_LINKED_RIPPLE_MATERIALIZATION",
    );

    // Atomic authorization must replay the opposite media side too. This child
    // remains schema-valid and hash-consistent but no longer matches the public
    // PictureTrack operation plan; audio cache identity alone cannot observe it.
    const forgedPicture = structuredClone(ir);
    const picture = tracks(forgedPicture).picture;
    forgedPicture.nodes[picture.children[0]].inputs.opacity = {
      kind: "quantity",
      dimension: "ratio",
      magnitude: { numerator: "1", denominator: "2" },
      unit: "ratio",
    };
    finalizeGraphHashes(forgedPicture);
    await assert.rejects(
      renderReferenceAudioArtifact(forgedPicture, forgedPicture.compositions[0], root),
      (error: unknown) => error instanceof ReferencePictureEditOperationError
        && /kernel inputs do not match operation-plan result/.test(error.message),
    );
    const afterRefusal = await renderReferenceAudioArtifact(ir, composition, root);
    assert.equal(afterRefusal.cache.status, "hit");
    assert.equal(afterRefusal.cache.key, cold.cache.key);
    assert.equal(afterRefusal.cache.artifact.sha256, cold.cache.artifact.sha256);
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("one-sided or forged ripple correlation fails before direct output publication", { timeout: 45_000 }, async () => {
  const project = await lockedProject();
  try {
    const hostile = structuredClone(project.ir);
    const { audio } = tracks(hostile);
    audio.editorial.operationPlan!.operations.pop();
    assert.throws(
      () => new ReferenceVisualRenderer(hostile, hostile.compositions[0], project.root, resolve(project.root, "hostile-visual-cache")),
      (error: unknown) => error instanceof ReferenceLinkedRippleDeleteError
        && error.code === "CUT_LINKED_RIPPLE_MATERIALIZATION",
    );
    const output = resolve(project.root, "must-not-publish.wav");
    await assert.rejects(
      renderReferenceAudio(hostile, hostile.compositions[0], project.root, output),
      (error: unknown) => error instanceof ReferenceLinkedRippleDeleteError
        && error.code === "CUT_LINKED_RIPPLE_MATERIALIZATION",
    );
    await assert.rejects(access(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    const forgedAudio = structuredClone(project.ir);
    const forgedTrack = tracks(forgedAudio).audio;
    forgedAudio.nodes[forgedTrack.children[0]].inputs.tailHandle = {
      kind: "quantity",
      dimension: "time",
      magnitude: { numerator: "0", denominator: "1" },
      unit: "s",
    };
    finalizeGraphHashes(forgedAudio);
    const visualCache = resolve(project.root, "must-not-allocate-visual-cache");
    assert.throws(
      () => new ReferenceVisualRenderer(forgedAudio, forgedAudio.compositions[0], project.root, visualCache),
      (error: unknown) => error instanceof ReferenceAudioEditOperationError
        && /kernel inputs do not match the operation-plan result/.test(error.message),
    );
    await assert.rejects(access(visualCache), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});
