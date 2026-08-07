import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Ajv from "ajv";
import { stableJsonStringify } from "../lib/core/stable";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode, IRValue } from "../lib/language/ir";
import { validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import {
  stageTimelineEditIrMaterializationV1,
} from "../lib/language/timeline-edit-ir-materializer";
import { parseCutLanguage } from "../lib/language/parser";
import {
  executeTimelineEditPlan,
  TimelineEditError,
} from "../lib/language/timeline-edit-operations";
import {
  ReferenceTimelineEditMaterializationError,
  validateReferenceTimelineEditMaterializations,
} from "../lib/runtime/reference/timeline-edit";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { validateReferenceLinkedEditTransactions } from "../lib/runtime/reference/linked-edit";
import { ReferenceLinkedTrimError } from "../lib/runtime/reference/linked-trim";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

type EditorialTrackNode = IRNode & {
  editorial: Extract<IREditorial, { kind: "picture-track" | "audio-track" }>;
};

const exec = promisify(execFile);

const statement = `    TimelineEdit(id: "linked-placement", operations: [
      editInsert(
        picture: editSelection(trackIds: ["v1"]),
        audio: editSelection(trackIds: ["a1"]),
        at: avTime(picture: 2s, audio: 2s),
        operand: editOperand(
          linkId: "inserted-pair",
          parts: [
            editOperandPart(
              domain: "picture",
              sourceOriginId: "source-picture",
              originId: "inserted-picture",
              duration: 2s,
              metadata: editorialMetadata(entries: [
                editorialMetadataEntry(key: "org.example.operation", value: "insert")
              ])
            ),
            editOperandPart(
              domain: "audio",
              sourceOriginId: "source-audio",
              originId: "inserted-audio",
              duration: 2s,
              metadata: editorialMetadata(entries: [
                editorialMetadataEntry(key: "org.example.operation", value: "insert")
              ])
            )
          ]
        )
      ),
      editOverwrite(
        picture: editSelection(trackIds: ["v1"]),
        audio: editSelection(trackIds: ["a1"]),
        at: avTime(picture: 6s, audio: 6s),
        operand: editOperand(
          linkId: "overwritten-pair",
          parts: [
            editOperandPart(
              domain: "picture",
              sourceOriginId: "source-picture",
              originId: "overwritten-picture",
              duration: 2s,
              metadata: editorialMetadata(entries: [
                editorialMetadataEntry(key: "org.example.operation", value: "overwrite")
              ])
            ),
            editOperandPart(
              domain: "audio",
              sourceOriginId: "source-audio",
              originId: "overwritten-audio",
              duration: 2s,
              metadata: editorialMetadata(entries: [
                editorialMetadataEntry(key: "org.example.operation", value: "overwrite")
              ])
            )
          ]
        )
      )
    ]);`;

function publicSource(timelineEdit = statement) {
  return `cut 0.4;
project "linked insert overwrite conformance";
import {
  Sequence, PictureTrack, PictureClip, Gap, AudioTrack, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, editInsert, editOverwrite,
  editorialMetadataEntry, editorialMetadata
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 8s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 8s) {
    Sequence(duration: 8s) {
      PictureTrack(
        trackId: "v1",
        role: "primary",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.lane", value: "picture")
        ])
      ) {
        PictureClip(
          source: picture,
          range: 1s ..< 3s,
          duration: 2s,
          headHandle: 1s,
          tailHandle: 1s,
          link: "source-pair",
          editId: "source-picture",
          role: "primary",
          metadata: editorialMetadata(entries: [
            editorialMetadataEntry(key: "org.example.take", value: "source")
          ])
        );
        PictureClip(
          source: picture,
          range: 3s ..< 7s,
          duration: 4s,
          headHandle: 1s,
          tailHandle: 1s,
          link: "body-pair",
          editId: "body-picture",
          role: "b-roll",
          metadata: editorialMetadata(entries: [
            editorialMetadataEntry(key: "org.example.take", value: "body")
          ])
        );
        Gap(duration: 2s);
      }
    }
    AudioTrack(
      trackId: "a1",
      role: "dialogue",
      metadata: editorialMetadata(entries: [
        editorialMetadataEntry(key: "org.example.lane", value: "dialogue")
      ])
    ) {
      AudioClip(
        source: voice,
        range: 1s ..< 3s,
        destination: 0s ..< 2s,
        headHandle: 1s,
        tailHandle: 1s,
        link: "source-pair",
        editId: "source-audio",
        role: "dialogue",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.take", value: "source")
        ])
      );
      AudioClip(
        source: voice,
        range: 3s ..< 7s,
        destination: 2s ..< 6s,
        headHandle: 1s,
        tailHandle: 1s,
        link: "body-pair",
        editId: "body-audio",
        role: "dialogue",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.take", value: "body")
        ])
      );
      AudioGap(destination: 6s ..< 8s);
    }
${timelineEdit}
  }
}
export out = render(main);`;
}

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  try {
    return compileCutModule(parsed.module).ir;
  } catch (error) {
    if (error instanceof CutCompileError) {
      assert.fail(JSON.stringify(error.result.diagnostics));
    }
    throw error;
  }
}

function tracks(ir: CutAVIR) {
  const result = Object.values(ir.nodes)
    .filter((node): node is EditorialTrackNode =>
      node.editorial?.kind === "picture-track" || node.editorial?.kind === "audio-track");
  const picture = result.find((node) => node.editorial.kind === "picture-track");
  const audio = result.find((node) => node.editorial.kind === "audio-track");
  assert.ok(picture);
  assert.ok(audio);
  return { picture, audio };
}

function seconds(value: Readonly<{ numerator: string; denominator: string }>) {
  return Number(value.numerator) / Number(value.denominator);
}

function assertTerminalTrack(track: EditorialTrackNode, domain: "picture" | "audio") {
  assert.equal(track.editorial.trackId, domain === "picture" ? "v1" : "a1");
  assert.equal(track.editorial.role, domain === "picture" ? "primary" : "dialogue");
  assert.deepEqual(track.editorial.metadata, {
    "org.example.lane": domain === "picture" ? "picture" : "dialogue",
  });
  assert.deepEqual(
    track.editorial.items.map((item) => [
      item.editId,
      seconds(item.destination.start),
      seconds(item.destination.duration),
      item.linkId,
      item.role,
      item.metadata,
    ]),
    domain === "picture"
      ? [
          ["source-picture", 0, 2, "source-pair", "primary", { "org.example.take": "source" }],
          ["inserted-picture", 2, 2, "inserted-pair", "primary", {
            "org.example.operation": "insert",
            "org.example.take": "source",
          }],
          ["body-picture", 4, 2, "body-pair", "b-roll", { "org.example.take": "body" }],
          ["overwritten-picture", 6, 2, "overwritten-pair", "primary", {
            "org.example.operation": "overwrite",
            "org.example.take": "source",
          }],
        ]
      : [
          ["source-audio", 0, 2, "source-pair", "dialogue", { "org.example.take": "source" }],
          ["inserted-audio", 2, 2, "inserted-pair", "dialogue", {
            "org.example.operation": "insert",
            "org.example.take": "source",
          }],
          ["body-audio", 4, 2, "body-pair", "dialogue", { "org.example.take": "body" }],
          ["overwritten-audio", 6, 2, "overwritten-pair", "dialogue", {
            "org.example.operation": "overwrite",
            "org.example.take": "source",
          }],
        ],
  );
  assert.deepEqual(
    track.editorial.items.map((item) => item.source && [
      seconds(item.source.start),
      seconds(item.source.duration),
    ]),
    [[1, 2], [1, 2], [3, 2], [1, 2]],
  );
}

const runtimeStatement = statement
  .replace("at: avTime(picture: 6s, audio: 6s)", "at: avTime(picture: 5s, audio: 5s)");

function runtimeSource() {
  return publicSource(runtimeStatement)
    .replace(
      "fps: 24, width: 320px, height: 180px",
      "fps: 4, width: 16px, height: 16px",
    )
    .replace(
      "render(main);",
      'render(main, width: 16px, height: 16px, codec: "h264");',
    );
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
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
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
  assert.deepEqual(
    { sampleRate, blockAlign, bits },
    { sampleRate: 48_000, blockAlign: 6, bits: 24 },
  );
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

const runtimeColors = [
  [32, 0, 0],
  [0, 64, 0],
  [0, 0, 96],
  [128, 128, 0],
  [160, 0, 160],
  [0, 192, 192],
  [224, 112, 0],
  [240, 240, 240],
] as const;

async function lockedRuntimeProject() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-timeline-insert-overwrite-runtime-"));
  const rawFrames = Buffer.concat(
    runtimeColors.flatMap((color) =>
      Array.from(
        { length: 4 },
        () => Buffer.from(Array.from({ length: 16 * 16 }, () => color).flat()),
      )),
  );
  const rawPath = resolve(root, "picture.rgb");
  await writeFile(rawPath, rawFrames);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "16x16",
    "-framerate", "4", "-i", rawPath,
    "-frames:v", "32", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrp",
    resolve(root, "picture.mkv"),
  ]);
  await writeFile(
    resolve(root, "voice.wav"),
    monoPcm16Wave(
      48_000,
      runtimeColors.flatMap((_color, index) =>
        Array.from({ length: 48_000 }, () => (index + 1) * 1_000)),
    ),
  );
  const ir = compile(runtimeSource());
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const composition = ir.compositions[0]!;
  const scene = ir.scenes[composition.sceneIds[0]!]!;
  return { root, ir, composition, scene };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertUniformSurface(
  surface: Readonly<{ data: Buffer; width: number; height: number }>,
  expected: readonly [number, number, number] | undefined,
) {
  assert.deepEqual({ width: surface.width, height: surface.height }, { width: 16, height: 16 });
  const expectedPixel = expected === undefined ? [0, 0, 0, 0] : [...expected, 255];
  for (let offset = 0; offset < surface.data.length; offset += 4) {
    const actual = [...surface.data.subarray(offset, offset + 4)];
    expectedPixel.forEach((value, channel) => {
      assert.ok(
        Math.abs(actual[channel]! - value) <= (channel === 3 ? 0 : 3),
        `pixel ${offset / 4} channel ${channel}: ${JSON.stringify(actual)} != ${JSON.stringify(expectedPixel)}`,
      );
    });
  }
}

async function renderWitnessFrames(
  project: Awaited<ReturnType<typeof lockedRuntimeProject>>,
  cacheName: string,
) {
  const renderer = new ReferenceVisualRenderer(
    project.ir,
    project.composition,
    project.root,
    resolve(project.root, cacheName),
  );
  await renderer.prepare();
  try {
    const result = new Map<number, Buffer>();
    for (const frame of [7, 8, 12, 19, 20, 24, 28]) {
      result.set(frame, Buffer.from((await renderer.sceneFrame(project.scene, frame, false)).data));
    }
    return result;
  } finally {
    renderer.close();
  }
}

test("public coupled insert and overwrite materialize exact linked direct A/V and replay at runtime", async () => {
  const ir = compile(publicSource());
  assert.doesNotThrow(() => validateCutAvIr(ir));
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validateSchema = new Ajv({
    schemaId: "auto",
    meta: false,
    validateSchema: false,
    allErrors: true,
    jsonPointers: true,
  }).compile(schema);
  assert.equal(validateSchema(ir), true, JSON.stringify(validateSchema.errors));
  assert.equal(ir.timelineEdits?.length, 1);
  const plan = ir.timelineEdits![0]!;
  assert.deepEqual(plan.operations.map((operation) => operation.kind), ["insert", "overwrite"]);
  const execution = executeTimelineEditPlan(plan);
  assert.deepEqual(
    execution.tracks.map((track) => [track.trackId, track.items.length]),
    [["v1", 4], ["a1", 4]],
  );
  const { picture, audio } = tracks(ir);
  assertTerminalTrack(picture, "picture");
  assertTerminalTrack(audio, "audio");
  for (const track of [picture, audio]) {
    for (const item of track.editorial.items) {
      const childLink = ir.nodes[item.nodeId]?.inputs.link;
      assert.equal(
        childLink?.kind === "string" ? childLink.value : undefined,
        item.linkId,
        `${track.editorial.trackId}/${item.editId} child must carry its exact terminal link`,
      );
    }
  }
  const receipt = validateReferenceTimelineEditMaterializations(ir);
  assert.equal(receipt.plans.length, 1);
  assert.equal(receipt.plans[0]!.planId, "linked-placement");
  assert.equal(receipt.plans[0]!.materializationId, execution.materializationId);
  assert.deepEqual(
    receipt.plans[0]!.trackBindings.map((binding) => [
      binding.trackId,
      binding.domain,
      binding.items,
      binding.transitions,
    ]),
    [["v1", "picture", 4, 0], ["a1", "audio", 4, 0]],
  );
  assert.equal(
    validateReferenceTimelineEditMaterializations(structuredClone(ir)).validationId,
    receipt.validationId,
  );
});

test("locked linked insert and overwrite execute exact picture and PCM witnesses before, inside, and after both regions", { timeout: 90_000 }, async () => {
  const project = await lockedRuntimeProject();
  try {
    const firstFrames = await renderWitnessFrames(project, "visual-cache-first");
    const secondFrames = await renderWitnessFrames(project, "visual-cache-second");
    const witnesses = [
      // Before insert, inside insert, and immediately after insert.
      { frame: 7, sourceSecond: 2 },
      { frame: 8, sourceSecond: 1 },
      { frame: 12, sourceSecond: 2 },
      // Before overwrite, inside overwrite, and immediately after overwrite.
      { frame: 19, sourceSecond: 3 },
      { frame: 20, sourceSecond: 1 },
      { frame: 24, sourceSecond: 2 },
      { frame: 28, sourceSecond: 6 },
    ] as const;
    for (const witness of witnesses) {
      const first = firstFrames.get(witness.frame);
      const second = secondFrames.get(witness.frame);
      assert.ok(first);
      assert.ok(second);
      assert.deepEqual(second, first, `frame ${witness.frame} changed on deterministic repeat`);
      assert.equal(sha256(second), sha256(first));
      assertUniformSurface(
        { data: first, width: 16, height: 16 },
        witness.sourceSecond === undefined ? undefined : runtimeColors[witness.sourceSecond],
      );
    }

    const firstPcmPath = resolve(project.root, "linked-placement-first.wav");
    const secondPcmPath = resolve(project.root, "linked-placement-second.wav");
    await renderReferenceAudio(project.ir, project.composition, project.root, firstPcmPath);
    await renderReferenceAudio(project.ir, project.composition, project.root, secondPcmPath);
    const [firstPcmBytes, secondPcmBytes] = await Promise.all([
      readFile(firstPcmPath),
      readFile(secondPcmPath),
    ]);
    assert.deepEqual(secondPcmBytes, firstPcmBytes);
    assert.equal(sha256(secondPcmBytes), sha256(firstPcmBytes));
    const pcm = pcm24Data(firstPcmBytes);
    assert.equal(pcm.frames, 8 * 48_000);
    const monoToStereo = Math.SQRT1_2 / 32_768;
    for (const witness of witnesses) {
      const sampleFrame = witness.frame * 12_000;
      const expected = witness.sourceSecond === undefined
        ? 0
        : (witness.sourceSecond + 1) * 1_000;
      for (const channel of [0, 1]) {
        assert.ok(
          Math.abs(pcm.sample(sampleFrame, channel) - expected * monoToStereo) < 0.002,
          `timeline frame ${witness.frame}/PCM ${sampleFrame} channel ${channel} did not share source second ${String(witness.sourceSecond)}`,
        );
      }
    }
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("hostile linked placement mutation fails before picture cache or PCM publication", { timeout: 60_000 }, async () => {
  const project = await lockedRuntimeProject();
  try {
    const hostile = structuredClone(project.ir);
    const operation = hostile.timelineEdits?.[0]?.operations[0];
    assert.ok(operation?.kind === "insert");
    if (operation?.kind !== "insert") return;
    (operation.operand.parts[0]!.metadata as Record<string, string>)["org.example.operation"] = "forged";
    const cachePath = resolve(project.root, "hostile-visual-cache");
    assert.throws(
      () => new ReferenceVisualRenderer(
        hostile,
        hostile.compositions[0]!,
        project.root,
        cachePath,
      ),
      (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
        && error.code === "CUT_TIMELINE_EDIT_RESULT"
        && /metadata/u.test(error.path),
    );
    await assert.rejects(
      access(cachePath),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    const pcmPath = resolve(project.root, "must-not-publish.wav");
    await assert.rejects(
      renderReferenceAudio(hostile, hostile.compositions[0]!, project.root, pcmPath),
      (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
        && error.code === "CUT_TIMELINE_EDIT_RESULT"
        && /metadata/u.test(error.path),
    );
    await assert.rejects(
      access(pcmPath),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("TimelineEdit link-shape authority excludes only replayed tracks and cannot hide one-sided, duplicate, or orphan links", () => {
  const ir = compile(runtimeSource());
  assert.doesNotThrow(() => validateReferenceLinkedEditTransactions(ir, ir.compositions[0]!));

  const oneSided = structuredClone(ir);
  const oneSidedAudio = tracks(oneSided).audio;
  const insertedAudio = oneSidedAudio.editorial.items.find((item) =>
    item.linkId === "inserted-pair");
  assert.ok(insertedAudio);
  insertedAudio.linkId = "forged-one-sided-pair";
  assert.throws(
    () => validateReferenceLinkedEditTransactions(oneSided, oneSided.compositions[0]!),
    (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
      && error.code === "CUT_TIMELINE_EDIT_LINK"
      && /linkId/u.test(error.path),
  );

  const forgedChildLink = structuredClone(ir);
  const forgedLinkPicture = tracks(forgedChildLink).picture;
  const forgedLinkChildId = forgedLinkPicture.editorial.items.find((item) =>
    item.linkId === "inserted-pair")?.nodeId;
  assert.ok(forgedLinkChildId);
  forgedChildLink.nodes[forgedLinkChildId]!.inputs.link = {
    kind: "string",
    value: "forged-child-pair",
  };
  assert.throws(
    () => validateReferenceLinkedEditTransactions(
      forgedChildLink,
      forgedChildLink.compositions[0]!,
    ),
    (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
      && error.code === "CUT_TIMELINE_EDIT_LINK"
      && /nodeId\.inputs\.link/u.test(error.path),
  );

  const aliasedChild = structuredClone(ir);
  const aliasedPicture = tracks(aliasedChild).picture;
  const aliasedChildId = aliasedPicture.editorial.items.find((item) =>
    item.linkId === "inserted-pair")?.nodeId;
  const sequence = Object.values(aliasedChild.nodes).find((node) =>
    node.op === "cut.edit.sequence");
  assert.ok(aliasedChildId);
  assert.ok(sequence);
  sequence.children.push(aliasedChildId);
  assert.throws(
    () => validateReferenceLinkedEditTransactions(
      aliasedChild,
      aliasedChild.compositions[0]!,
    ),
    (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
      && error.code === "CUT_TIMELINE_EDIT_REFERENCE"
      && /exactly one live parent/u.test(error.message),
  );

  const duplicate = structuredClone(ir);
  const duplicatePicture = structuredClone(tracks(duplicate).picture);
  duplicatePicture.id = "forged_duplicate_timeline_track";
  duplicate.nodes[duplicatePicture.id] = duplicatePicture;
  assert.throws(
    () => validateReferenceLinkedEditTransactions(duplicate, duplicate.compositions[0]!),
    (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
      && error.code === "CUT_TIMELINE_EDIT_REFERENCE"
      && /expected exactly one live authored track and found 2/u.test(error.message),
  );

  const orphan = structuredClone(ir);
  const orphanPicture = tracks(orphan).picture;
  const linkedChildId = orphanPicture.editorial.items.find((item) =>
    item.linkId === "inserted-pair")?.nodeId;
  assert.ok(linkedChildId);
  const orphanChild = structuredClone(orphan.nodes[linkedChildId]!);
  orphanChild.id = "forged_unowned_link_child";
  orphan.nodes[orphanChild.id] = orphanChild;
  assert.throws(
    () => validateReferenceLinkedEditTransactions(orphan, orphan.compositions[0]!),
    (error: unknown) => error instanceof ReferenceLinkedTrimError
      && error.code === "CUT_LINKED_TRIM_CARDINALITY"
      && /not owned by exactly one matching track item/u.test(error.message),
  );
});

test("runtime refuses a forged insert operand and cannot bless stale published materialization", () => {
  const ir = compile(publicSource());
  const operation = ir.timelineEdits![0]!.operations[0]!;
  assert.equal(operation.kind, "insert");
  if (operation.kind !== "insert") return;
  (operation.operand.parts[0]!.metadata as Record<string, string>)["org.example.operation"] = "forged";
  assert.throws(
    () => validateReferenceTimelineEditMaterializations(ir),
    (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
      && error.code === "CUT_TIMELINE_EDIT_RESULT"
      && /metadata/u.test(error.path),
  );
});

test("two-track materialization failure is transactional and leaves the input graph byte-exact", () => {
  const published = compile(publicSource());
  const plan = structuredClone(published.timelineEdits![0]!);
  const base = compile(publicSource(""));
  const { picture, audio } = tracks(base);
  const sourceAudioItem = audio.editorial.items.find((item) => item.editId === "source-audio");
  assert.ok(sourceAudioItem);
  const sourceAudio = base.nodes[sourceAudioItem.nodeId]!;
  sourceAudio.inputs.fadeIn = {
    kind: "quantity",
    dimension: "time",
    magnitude: { numerator: "1", denominator: "10" },
    unit: "s",
  } satisfies IRValue;
  const before = stableJsonStringify(base);
  const stage = {
    plan,
    execution: executeTimelineEditPlan(plan),
    trackBindings: [
      {
        trackNodeId: picture.id,
        trackId: "v1",
        kind: "picture-track" as const,
      },
      {
        trackNodeId: audio.id,
        trackId: "a1",
        kind: "audio-track" as const,
      },
    ],
    stageIdentity: "hostile-transaction-fixture",
  };
  assert.throws(
    () => stageTimelineEditIrMaterializationV1(base, base.compositions[0]!, stage),
    (error: unknown) => error instanceof TimelineEditError
      && error.code === "CUT_TIMELINE_EDIT_UNSUPPORTED"
      && /origin-clock presentation bridge/u.test(error.message),
  );
  assert.equal(stableJsonStringify(base), before);
  assert.equal(base.timelineEdits, undefined);
});
