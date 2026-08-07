import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  ReferencePictureTimeMapFrameEvidenceError,
  referencePictureTimeMapConfig,
  referencePictureTimeMapConfigIdentity,
  referencePictureTimeMapFrameEvidenceLimits,
  validateReferencePictureTimeMapFrameEvidence,
  type ReferencePictureTimeMapConfig,
} from "../lib/runtime/reference/picture-time-map";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function directProgram(project = "typed time frame evidence") {
  return `cut 0.4;
project "${project}";
import { Sequence, PictureTrack, PictureClip } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(trackId: "picture") {
        PictureClip(source: source, range: 0s ..< 1s, duration: 1s);
      }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function nestedProgram() {
  return `cut 0.4;
project "nested typed time frame evidence";
import { Precomp } from "cut:visual";
import { Sequence, PictureTrack, PictureClip } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene host(duration: 1s) { Precomp(source: insert); }
}
timeline insert(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene media(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(trackId: "picture") {
        PictureClip(source: source, range: 0s ..< 1s, duration: 1s);
      }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

async function makeFourFrameSource(root: string) {
  const frames = resolve(root, "frames");
  const media = resolve(root, "media");
  await mkdir(frames);
  await mkdir(media);
  const colors = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 },
  ];
  await Promise.all(colors.map((background, index) =>
    sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background,
      },
    }).png().toFile(resolve(frames, `${index}.png`))));
  await exec("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    "4",
    "-i",
    resolve(frames, "%d.png"),
    "-c:v",
    "ffv1",
    "-pix_fmt",
    "yuv444p",
    resolve(media, "source.mkv"),
  ]);
}

async function lockedRenderer(root: string, source: string, cache: string) {
  const ir = compile(source);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(
    ir,
    composition,
    root,
    resolve(root, cache),
  );
  await renderer.prepare();
  return { ir, composition, renderer };
}

function pictureNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) =>
    candidate.op === "cut.edit.picture_clip");
  assert.ok(node);
  return node;
}

test("typed-time frame evidence binds the exact locked clock, decoder sample, output bytes, and repeated execution", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-time-evidence-"));
  await makeFourFrameSource(root);
  const first = await lockedRenderer(root, directProgram(), "cache-first");
  const scene = first.ir.scenes[first.composition.sceneIds[0]];
  try {
    const surface = await first.renderer.sceneFrame(scene, 1, false);
    const evidence = first.renderer.referencePictureTimeMapExecutionEvidence();
    assert.equal(evidence.length, 1);
    const node = pictureNode(first.ir);
    const config = referencePictureTimeMapConfig(
      first.ir,
      first.composition,
      node,
    );
    assert.ok(config);
    assert.equal(evidence[0].compositionId, "main");
    assert.equal(evidence[0].nodeId, node.id);
    assert.equal(evidence[0].outputFrame, "1");
    assert.deepEqual(evidence[0].executionPath, []);
    assert.equal(
      evidence[0].configIdentity,
      referencePictureTimeMapConfigIdentity(config),
    );
    assert.deepEqual(evidence[0].sample.firstLockedSourceTime, rational(1, 4));
    assert.deepEqual(evidence[0].sample.secondLockedSourceTime, rational(1, 4));
    assert.equal(
      evidence[0].decodedOutput.rgbaSha256,
      createHash("sha256").update(surface.data).digest("hex"),
    );
    validateReferencePictureTimeMapFrameEvidence(evidence[0], {
      compositionId: first.composition.id,
      nodeId: node.id,
      outputFrame: "1",
      config,
      request: { kind: "destination-frame", destinationFrame: 1 },
      width: surface.width,
      height: surface.height,
      rgbaSha256: evidence[0].decodedOutput.rgbaSha256,
    });

    const repeat = await lockedRenderer(root, directProgram(), "cache-repeat");
    try {
      const repeatedSurface = await repeat.renderer.sceneFrame(
        repeat.ir.scenes[repeat.composition.sceneIds[0]],
        1,
        false,
      );
      assert.equal(
        createHash("sha256").update(repeatedSurface.data).digest("hex"),
        evidence[0].decodedOutput.rgbaSha256,
      );
      assert.deepEqual(
        repeat.renderer.referencePictureTimeMapExecutionEvidence(),
        evidence,
      );
    } finally {
      await repeat.renderer.closeAndWait();
    }
  } finally {
    await first.renderer.closeAndWait();
  }
  assert.deepEqual(first.renderer.referencePictureTimeMapExecutionEvidence(), []);
});

test("typed-time evidence rejects tampering and a post-prepare config mutation before decoder work without replacing the last completed receipt", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-time-hostile-"));
  await makeFourFrameSource(root);
  const prepared = await lockedRenderer(root, directProgram("hostile typed time frame evidence"), "cache");
  const scene = prepared.ir.scenes[prepared.composition.sceneIds[0]];
  try {
    const surface = await prepared.renderer.sceneFrame(scene, 1, false);
    const completed = prepared.renderer.referencePictureTimeMapExecutionEvidence();
    assert.equal(completed.length, 1);
    const node = pictureNode(prepared.ir);
    const config = referencePictureTimeMapConfig(
      prepared.ir,
      prepared.composition,
      node,
    );
    assert.ok(config);
    const input = {
      compositionId: prepared.composition.id,
      nodeId: node.id,
      outputFrame: "1",
      config,
      request: { kind: "destination-frame" as const, destinationFrame: 1 },
      width: surface.width,
      height: surface.height,
      rgbaSha256: completed[0].decodedOutput.rgbaSha256,
    };
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value.executionIdentity = "f".repeat(64);
      },
      (value) => {
        const sample = value.sample as Record<string, unknown>;
        sample.firstDecoderFrame = 3;
      },
      (value) => {
        const output = value.decodedOutput as Record<string, unknown>;
        output.rgbaSha256 = "e".repeat(64);
      },
      (value) => {
        value.private = true;
      },
    ];
    for (const mutate of mutations) {
      const hostile = structuredClone(completed[0]) as unknown as Record<string, unknown>;
      mutate(hostile);
      assert.throws(
        () => validateReferencePictureTimeMapFrameEvidence(
          hostile as unknown as typeof completed[0],
          input,
        ),
        ReferencePictureTimeMapFrameEvidenceError,
      );
    }

    const internals = prepared.renderer as unknown as {
      pictureTimeMapConfigs: Map<string, ReferencePictureTimeMapConfig>;
    };
    const stored = internals.pictureTimeMapConfigs.get(node.id);
    assert.ok(stored);
    internals.pictureTimeMapConfigs.set(node.id, Object.freeze({
      ...stored,
      selectedStart: rational(1, 4),
    }));
    await assert.rejects(
      prepared.renderer.sceneFrame(scene, 2, false),
      /time-map configuration changed after validated preparation/u,
    );
    assert.deepEqual(
      prepared.renderer.referencePictureTimeMapExecutionEvidence(),
      completed,
      "a failed frame must not publish a partial replacement receipt",
    );
  } finally {
    await prepared.renderer.closeAndWait();
  }
});

test("nested typed-time receipts preserve the exact Precomp instance path and the renderer enforces its receipt ceiling", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-time-nested-"));
  await makeFourFrameSource(root);
  const prepared = await lockedRenderer(root, nestedProgram(), "cache");
  const scene = prepared.ir.scenes[prepared.composition.sceneIds[0]];
  try {
    await prepared.renderer.sceneFrame(scene, 1, false);
    const evidence = prepared.renderer.referencePictureTimeMapExecutionEvidence();
    assert.equal(evidence.length, 1);
    const precomp = Object.values(prepared.ir.nodes).find((node) =>
      node.op === "cut.visual.precomp");
    assert.ok(precomp);
    assert.deepEqual(evidence[0].executionPath, [{
      compositionId: "main",
      instanceNodeId: precomp.id,
      sourceCompositionId: "insert",
    }]);
    assert.equal(evidence[0].compositionId, "insert");
    assert.equal(evidence[0].outputFrame, "1");

    const diagnostics = prepared.renderer as unknown as {
      beginPictureTimeMapFrameEvidence(): void;
      reservePictureTimeMapFrameEvidence(count?: number): void;
    };
    diagnostics.beginPictureTimeMapFrameEvidence();
    assert.equal(
      referencePictureTimeMapFrameEvidenceLimits.maximumReceiptsPerRendererFrame,
      4_096,
    );
    assert.throws(
      () => diagnostics.reservePictureTimeMapFrameEvidence(4_097),
      /exceed the 4096-receipt renderer-frame limit/u,
    );
  } finally {
    await prepared.renderer.closeAndWait();
  }
});

test("graphs without PictureClip omit typed-time receipts exactly", { timeout: 30_000 }, async () => {
  const source = `cut 0.4;
project "typed time omission";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { Rect(width: 64px, height: 64px, fill: #123456); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-time-omit-"));
  const ir = compile(source);
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(
    ir,
    composition,
    root,
    resolve(root, "cache"),
  );
  await renderer.prepare();
  try {
    await renderer.sceneFrame(
      ir.scenes[composition.sceneIds[0]],
      0,
      false,
    );
    assert.deepEqual(renderer.referencePictureTimeMapExecutionEvidence(), []);
  } finally {
    await renderer.closeAndWait();
  }
});
