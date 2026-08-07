import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { createCutBuiltinImplementationIdentity } from "../lib/language/builtin-implementation-identity";
import type { IRComposition } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { renderReferencePreviewArtifact } from "../lib/runtime/reference/authoring-review";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import {
  assertReferenceMediaProfileExecutionState,
  registerReferenceMediaProfileExecution,
} from "../lib/runtime/reference/media-profile-state";
import {
  ReferencePreviewPictureCacheError,
  referencePreviewPictureParallelPlanForTest,
} from "../lib/runtime/reference/preview-picture-cache";
import { runFfmpeg } from "../lib/runtime/reference/ffmpeg";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const source = `cut 0.4;
project "Ordered parallel preview";
import { Rect } from "cut:visual";
import { Tone } from "@cut/audio";

timeline main(duration: 3s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  Tone(frequency: 440hz, duration: 3s, amplitude: 8%);
  scene red(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #ef233c);
  }
  scene green(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #22c55e);
  }
  scene blue(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #2667ff);
  }
}

export preview = render(main, width: 64px, height: 36px, codec: "h264");
`;

function compile(program = source) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [
    ...parsed.diagnostics,
    ...checkCutModule(parsed.module).diagnostics,
  ].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function wav(frameCount = 48_000, sampleRate = 48_000) {
  const dataBytes = frameCount * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frameCount; frame += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * frame / sampleRate) * 4_000), 44 + frame * 2);
  }
  return bytes;
}

async function locked(root: string, program = source) {
  const ir = compile(program);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

async function decodedPicture(root: string, locator: string) {
  const picture = resolve(root, ...locator.split("/"));
  const decoded = resolve(root, "decoded.rgba");
  await runFfmpeg([
    "-y", "-v", "error", "-i", picture, "-an",
    "-pix_fmt", "rgba", "-f", "rawvideo", decoded,
  ]);
  return readFile(decoded);
}

function assertExactEncoderOrder(actual: readonly number[], frameCount: number, label: string) {
  assert.deepEqual(actual, Array.from({ length: frameCount }, (_, frame) => frame), label);
}

test("ordered preview frame measurement is byte-identical at 1 and 2 renderers across scene boundaries", { timeout: 240_000 }, async () => {
  const roots = await Promise.all([1, 2].map((count) =>
    mkdtemp(resolve(tmpdir(), `cut-preview-parallel-${count}-`))));
  try {
    const rendered = await Promise.all(roots.map(async (root, index) => {
      const rendererCount = [1, 2][index]!;
      const ir = await locked(root);
      const written: number[] = [];
      const completed: number[] = [];
      let releaseFirstChunk: (() => void) | undefined;
      const laterChunkCompleted = rendererCount > 1
        ? new Promise<void>((resolveLaterChunk) => {
            releaseFirstChunk = resolveLaterChunk;
          })
        : Promise.resolve();
      const usedRenderers = new Set<number>();
      const closed: Array<{ rendererIndex: number; status: string }> = [];
      const plans: Array<{
        mode: string;
        reason: string;
        rendererCount: number;
        performanceClaim: string;
        framesPerRendererChunk: number;
        maximumBufferedFrames: number;
        frameRgbaBytes: number;
        maximumBufferedRgbaBytes: number;
        maximumStaticGradeHandoffRgbaBytes: number;
        maximumStaticGradeEventsPerFrame: number;
        perRendererRgbaLowerBoundBytes: number;
        aggregateRgbaLowerBoundBytes: number;
        admissionScope: string;
        nativePeakRss: string;
        preparationScope: string;
        measurementOnly: boolean;
      }> = [];
      const phases: string[] = [];
      const output = resolve(root, "review", "preview.mp4");
      const manifest = await renderReferencePreviewArtifact(ir, root, output, {
        range: "0s:3s",
        width: 64,
        __testPictureHooks: {
          requestedRenderers: rendererCount,
          plan(plan: {
            mode: string;
            reason: string;
            rendererCount: number;
            performanceClaim: string;
            framesPerRendererChunk: number;
            maximumBufferedFrames: number;
            frameRgbaBytes: number;
            maximumBufferedRgbaBytes: number;
            maximumStaticGradeHandoffRgbaBytes: number;
            maximumStaticGradeEventsPerFrame: number;
            perRendererRgbaLowerBoundBytes: number;
            aggregateRgbaLowerBoundBytes: number;
            admissionScope: string;
            nativePeakRss: string;
            preparationScope: string;
            measurementOnly: boolean;
          }) {
            plans.push(plan);
          },
          phase(event: { phase: string }) { phases.push(event.phase); },
          async beforeFrame(event: { rendererIndex: number; globalFrame: number }) {
            usedRenderers.add(event.rendererIndex);
            // Force later chunks to complete before the first chunk. Encoder
            // order must remain global-frame order, independent of readiness.
            if (event.globalFrame === 0 && rendererCount > 1) {
              await laterChunkCompleted;
            }
          },
          afterFrame(event: { globalFrame: number }) {
            completed.push(event.globalFrame);
            if (event.globalFrame === 3) releaseFirstChunk?.();
          },
          frameWritten(event: { globalFrame: number }) { written.push(event.globalFrame); },
          rendererClosed(event: { rendererIndex: number; status: string }) { closed.push(event); },
        },
      });
      assertExactEncoderOrder(written, 36, "encoder publication must remain in exact global-frame order");
      assert.equal(closed.length, rendererCount);
      assert.ok(closed.every((entry) => entry.status === "fulfilled"));
      assert.deepEqual(plans, [{
        mode: rendererCount === 1 ? "serial" : "ordered-parallel",
        reason: "measurement-override",
        performanceClaim: "REQUIRES_EXACT_RANGE_MEASUREMENT",
        admissionScope: "rgba-only-lower-bound-not-total-process-memory",
        nativePeakRss: "UNMEASURED",
        preparationScope: "root-eager+nested-lazy-on-first-active-frame",
        measurementOnly: true,
        rendererCount,
        framesPerRendererChunk: 2,
        maximumBufferedFrames: rendererCount * 2,
        frameRgbaBytes: 9_216,
        maximumBufferedRgbaBytes: rendererCount * 18_432,
        maximumStaticGradeHandoffRgbaBytes: 0,
        maximumStaticGradeEventsPerFrame: 0,
        perRendererRgbaLowerBoundBytes: 100_690_944,
        aggregateRgbaLowerBoundBytes: 268_435_456 + rendererCount * 100_709_376,
      }]);
      assert.deepEqual(phases, ["prepare-start", "prepare-end", "picture-start", "picture-end"]);
      assert.equal(usedRenderers.size, rendererCount, "every admitted renderer must execute at least one frame");
      if (rendererCount > 1) {
        assert.deepEqual(
          [...completed].sort((left, right) => left - right),
          Array.from({ length: 36 }, (_, frame) => frame),
          "every global frame must complete exactly once before readiness order is inspected",
        );
        assert.deepEqual(
          completed.slice(0, 4),
          [2, 3, 0, 1],
          "the explicit barrier must make the second chunk ready before the first chunk",
        );
        assert.throws(
          () => assertExactEncoderOrder(
            completed,
            36,
            "readiness order must not satisfy the encoder-order contract",
          ),
          /readiness order must not satisfy the encoder-order contract/u,
          "the hostile readiness-ordered counterfactual must fail the encoder-order law",
        );
      }
      if (process.env.CUT_PREVIEW_PARALLEL_DIAGNOSTIC === "1") {
        console.log(JSON.stringify({
          format: "cut-preview-parallel-order-diagnostic",
          version: 1,
          rendererCount,
          completed,
          written,
          usedRenderers: [...usedRenderers].sort((left, right) => left - right),
          closed,
        }));
      }
      assert.deepEqual(
        written.map((globalFrame) => ({
          globalFrame,
          scene: globalFrame < 12 ? "red" : globalFrame < 24 ? "green" : "blue",
          sceneFrame: globalFrame % 12,
        })),
        Array.from({ length: 36 }, (_, globalFrame) => ({
          globalFrame,
          scene: globalFrame < 12 ? "red" : globalFrame < 24 ? "green" : "blue",
          sceneFrame: globalFrame % 12,
        })),
      );
      return {
        cacheKey: manifest.execution.cache.key,
        pictureSha256: manifest.execution.cache.artifact.sha256,
        deliverySha256: manifest.artifact.sha256,
        decoded: await decodedPicture(root, manifest.execution.cache.artifact.locator),
      };
    }));
    for (const candidate of rendered.slice(1)) {
      assert.equal(candidate.cacheKey, rendered[0]!.cacheKey, "parallelism must not enter semantic picture-cache identity");
      assert.equal(candidate.pictureSha256, rendered[0]!.pictureSha256, "ordered frame parallelism must preserve encoded picture bytes");
      assert.equal(candidate.deliverySha256, rendered[0]!.deliverySha256, "parallelism must preserve complete preview bytes");
      assert.deepEqual(candidate.decoded, rendered[0]!.decoded, "parallelism must preserve every decoded RGBA frame");
    }
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("two-renderer measurement failure aborts publication, waits all work, closes every renderer, and cleans staging", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-preview-parallel-failure-"));
  try {
    const ir = await locked(root);
    const closed: Array<{ rendererIndex: number; status: string }> = [];
    const output = resolve(root, "review", "must-not-exist.mp4");
    await assert.rejects(
      renderReferencePreviewArtifact(ir, root, output, {
        range: "0s:3s",
        width: 64,
        __testPictureHooks: {
          requestedRenderers: 2,
          beforeFrame(event: { globalFrame: number }) {
            // Scene one has already been written to the encoder when the
            // second scene's wave fails.
            if (event.globalFrame === 17) throw new Error("injected ordered-frame failure");
          },
          rendererClosed(event: { rendererIndex: number; status: string }) { closed.push(event); },
        },
      }),
      /injected ordered-frame failure/u,
    );
    assert.equal(closed.length, 2);
    assert.ok(closed.every((entry) => entry.status === "fulfilled"));
    await assert.rejects(readFile(output), (error: unknown) =>
      Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    await assert.rejects(readFile(`${output}.manifest.json`), (error: unknown) =>
      Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    const pictureCache = resolve(root, ".cut/cache/reference/preview-picture");
    const cacheLeaves = await readdir(pictureCache);
    assert.deepEqual(
      cacheLeaves.filter((entry) => entry.startsWith(".cut-preview-picture-build-")),
      [],
      "failed picture waves must not retain staging directories",
    );
    for (const directory of ["entries", "blobs"]) {
      assert.deepEqual(await readdir(resolve(pictureCache, directory)), [], `failed render must not publish ${directory}`);
    }
    const reviewDirectory = resolve(root, "review");
    await mkdir(reviewDirectory, { recursive: true });
    assert.deepEqual(
      (await readdir(reviewDirectory)).filter((entry) => entry.startsWith(".cut-range-preview-")),
      [],
      "outer range publication staging must also be transactional",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production admission stays serial until native RSS is measured and stateful picture contexts remain serial", () => {
  const ir = compile();
  const composition = ir.compositions[0]!;
  const production = referencePreviewPictureParallelPlanForTest({
    ir,
    composition,
    endFrameExclusive: 12,
    width: 64,
    height: 36,
  });
  assert.deepEqual({
    mode: production.mode,
    reason: production.reason,
    rendererCount: production.rendererCount,
    admissionScope: production.admissionScope,
    nativePeakRss: production.nativePeakRss,
    preparationScope: production.preparationScope,
    measurementOnly: production.measurementOnly,
  }, {
    mode: "serial",
    reason: "production-serial-native-rss-unmeasured",
    rendererCount: 1,
    admissionScope: "rgba-only-lower-bound-not-total-process-memory",
    nativePeakRss: "UNMEASURED",
    preparationScope: "root-eager+nested-lazy-on-first-active-frame",
    measurementOnly: false,
  });
  assert.equal(referencePreviewPictureParallelPlanForTest({
    ir,
    composition,
    endFrameExclusive: 12,
    width: 64,
    height: 36,
    requestedRenderers: 2,
  }).rendererCount, 2);
  const workerDiagnostic = referencePreviewPictureParallelPlanForTest({
    ir,
    composition,
    endFrameExclusive: 12,
    width: 64,
    height: 36,
    requestedWorkerThreads: 3,
  });
  assert.deepEqual(workerDiagnostic, {
    mode: "ordered-parallel",
    reason: "worker-thread-measurement-override",
    performanceClaim: "REQUIRES_EXACT_RANGE_MEASUREMENT",
    admissionScope: "closed-rgba+node-process-rss-watchdog",
    nativePeakRss: "NODE_PROCESS_RSS_WATCHDOG_4_GIB_PROCESS_TREE_UNMEASURED",
    preparationScope: "canonical-parent-plan+worker-closure-and-resource-revalidation",
    measurementOnly: true,
    rendererCount: 3,
    framesPerRendererChunk: 2,
    maximumBufferedFrames: 6,
    frameRgbaBytes: 9_216,
    maximumBufferedRgbaBytes: 55_296,
    maximumStaticGradeHandoffRgbaBytes: 0,
    maximumStaticGradeEventsPerFrame: 0,
    perRendererRgbaLowerBoundBytes: 100_690_944,
    aggregateRgbaLowerBoundBytes: 3 * (192 * 1024 * 1024 + 100_690_944 + 18_432),
  });
  assert.deepEqual(referencePreviewPictureParallelPlanForTest({
    ir,
    composition,
    endFrameExclusive: 12,
    width: 64,
    height: 36,
    requestedWorkerThreads: 1,
  }), {
    mode: "serial",
    reason: "worker-thread-measurement-override",
    performanceClaim: "REQUIRES_EXACT_RANGE_MEASUREMENT",
    admissionScope: "closed-rgba+node-process-rss-watchdog",
    nativePeakRss: "NODE_PROCESS_RSS_WATCHDOG_4_GIB_PROCESS_TREE_UNMEASURED",
    preparationScope: "canonical-parent-plan+worker-closure-and-resource-revalidation",
    measurementOnly: true,
    rendererCount: 1,
    framesPerRendererChunk: 2,
    maximumBufferedFrames: 2,
    frameRgbaBytes: 9_216,
    maximumBufferedRgbaBytes: 18_432,
    maximumStaticGradeHandoffRgbaBytes: 0,
    maximumStaticGradeEventsPerFrame: 0,
    perRendererRgbaLowerBoundBytes: 100_690_944,
    aggregateRgbaLowerBoundBytes: 192 * 1024 * 1024 + 100_690_944 + 18_432,
  });
  const native4k = { ...composition, width: 3_840, height: 2_160 } satisfies IRComposition;
  const bounded = referencePreviewPictureParallelPlanForTest({
    ir,
    composition: native4k,
    endFrameExclusive: 12,
    width: 3_840,
    height: 2_160,
  });
  assert.equal(bounded.rendererCount, 1);
  assert.equal(bounded.nativePeakRss, "UNMEASURED");
  assert.ok(
    bounded.aggregateRgbaLowerBoundBytes > 536_870_912,
    "the lower bound must remain visibly distinct from a production process-memory ceiling",
  );
  assert.throws(
    () => referencePreviewPictureParallelPlanForTest({
      ir,
      composition: native4k,
      endFrameExclusive: 12,
      width: 3_840,
      height: 2_160,
      requestedRenderers: 2,
    }),
    (error: unknown) => error instanceof ReferencePreviewPictureCacheError
      && error.code === "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT"
      && /RGBA-only measurement admission/u.test(error.message),
  );

  const nestedVideoSource = `cut 0.4;
project "Selected-range nested video admission";
import { Precomp, Rect, Video } from "cut:visual";
asset footage: VideoAsset = video("media/footage.mp4");
timeline main(duration: 3s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene staticOpening(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #17324d);
  }
  scene activeMedia(duration: 1s) {
    Precomp(source: mediaBeat);
  }
  scene staticEnding(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #f59e0b);
  }
}
timeline mediaBeat(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene media(duration: 1s) {
    Video(source: footage, range: 0s ..< 1s);
  }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");
`;
  const videoIr = compile(nestedVideoSource);
  const inactiveVideo = referencePreviewPictureParallelPlanForTest({
    ir: videoIr,
    composition: videoIr.compositions.find((candidate) => candidate.name === "main")!,
    firstFrame: 0,
    endFrameExclusive: 12,
    width: 64,
    height: 36,
    requestedRenderers: 2,
  });
  assert.equal(inactiveVideo.rendererCount, 2, "video in a non-overlapping nested instance must not serialize a bounded two-renderer measurement");
  const serial = referencePreviewPictureParallelPlanForTest({
    ir: videoIr,
    composition: videoIr.compositions.find((candidate) => candidate.name === "main")!,
    firstFrame: 12,
    endFrameExclusive: 24,
    width: 64,
    height: 36,
  });
  assert.deepEqual(
    {
      mode: serial.mode,
      reason: serial.reason,
      rendererCount: serial.rendererCount,
      performanceClaim: serial.performanceClaim,
    },
    {
      mode: "serial",
      reason: "stateful-picture-context",
      rendererCount: 1,
      performanceClaim: "INSUFFICIENT_FOR_CCH05",
    },
  );
  assert.throws(
    () => referencePreviewPictureParallelPlanForTest({
      ir: videoIr,
      composition: videoIr.compositions.find((candidate) => candidate.name === "main")!,
      firstFrame: 12,
      endFrameExclusive: 24,
      width: 64,
      height: 36,
      requestedRenderers: 2,
    }),
    (error: unknown) => error instanceof ReferencePreviewPictureCacheError
      && error.code === "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT"
      && /deliberately serial/u.test(error.message),
  );
  assert.throws(
    () => referencePreviewPictureParallelPlanForTest({
      ir: videoIr,
      composition: videoIr.compositions.find((candidate) => candidate.name === "main")!,
      firstFrame: 12,
      endFrameExclusive: 24,
      width: 64,
      height: 36,
      requestedWorkerThreads: 3,
    }),
    (error: unknown) => error instanceof ReferencePreviewPictureCacheError
      && error.code === "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT"
      && /worker threads cannot bypass decoder state/u.test(error.message),
  );

  const statefulPublicSources = [
    {
      label: "Clip",
      source: `cut 0.4;
project "Linked clip worker fallback";
import { Clip } from "@cut/edit";
asset media: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) { Clip(source: media, range: 0s ..< 1s, duration: 1s); }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");`,
    },
    {
      label: "PictureClip",
      source: `cut 0.4;
project "Picture clip worker fallback";
import { Sequence, PictureTrack, PictureClip } from "@cut/edit";
asset media: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(trackId: "picture") {
        PictureClip(source: media, range: 0s ..< 1s, duration: 1s, editId: "picture-source");
      }
    }
  }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");`,
    },
  ] as const;
  for (const fixture of statefulPublicSources) {
    const candidate = compile(fixture.source);
    const candidateComposition = candidate.compositions.find((composition) => composition.name === "main")!;
    assert.ok(Object.values(candidate.nodes).some((node) => node.op === `cut.edit.${fixture.label === "Clip" ? "clip" : "picture_clip"}`));
    assert.equal(referencePreviewPictureParallelPlanForTest({
      ir: candidate,
      composition: candidateComposition,
      endFrameExclusive: 12,
      width: 64,
      height: 36,
    }).reason, "stateful-picture-context");
    assert.throws(
      () => referencePreviewPictureParallelPlanForTest({
        ir: candidate,
        composition: candidateComposition,
        endFrameExclusive: 12,
        width: 64,
        height: 36,
        requestedWorkerThreads: 3,
      }),
      (error: unknown) => error instanceof ReferencePreviewPictureCacheError
        && error.code === "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT"
        && /worker threads cannot bypass decoder state/u.test(error.message),
      fixture.label,
    );
  }
});

async function assertNoWorkerPublication(root: string, output: string) {
  await assert.rejects(readFile(output), (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  await assert.rejects(readFile(`${output}.manifest.json`), (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  const pictureCache = resolve(root, ".cut/cache/reference/preview-picture");
  for (const directory of ["entries", "blobs"]) {
    assert.deepEqual(await readdir(resolve(pictureCache, directory)), [], `failed worker render must not publish ${directory}`);
  }
  assert.deepEqual(
    (await readdir(pictureCache)).filter((entry) => entry.startsWith(".cut-preview-picture-build-")),
    [],
    "failed worker render must not retain picture staging",
  );
}

test("three persistent picture workers preserve serial pixels, order, picture bytes, and delivery bytes", { timeout: 240_000 }, async () => {
  const roots = await Promise.all(["serial", "worker"].map((label) =>
    mkdtemp(resolve(tmpdir(), `cut-preview-${label}-`))));
  try {
    const results = await Promise.all(roots.map(async (root, index) => {
      const ir = await locked(root);
      const output = resolve(root, "review", "preview.mp4");
      const written: number[] = [];
      const closed: Array<{ rendererIndex: number; status: string }> = [];
      const manifest = await renderReferencePreviewArtifact(ir, root, output, {
        range: "0s:1s",
        width: 64,
        __testPictureHooks: index === 0 ? undefined : {
          requestedWorkerThreads: 3,
          frameWritten(event: { globalFrame: number }) { written.push(event.globalFrame); },
          rendererClosed(event: { rendererIndex: number; status: string }) { closed.push(event); },
        },
      });
      if (index === 1) {
        assert.deepEqual(written, Array.from({ length: 12 }, (_, frame) => frame));
        assert.deepEqual(closed.toSorted((left, right) => left.rendererIndex - right.rendererIndex), [
          { rendererIndex: 0, status: "fulfilled" },
          { rendererIndex: 1, status: "fulfilled" },
          { rendererIndex: 2, status: "fulfilled" },
        ]);
      }
      return {
        key: manifest.execution.cache.key,
        picture: manifest.execution.cache.artifact.sha256,
        delivery: manifest.artifact.sha256,
        decoded: await decodedPicture(root, manifest.execution.cache.artifact.locator),
      };
    }));
    assert.equal(results[1]!.key, results[0]!.key);
    assert.equal(results[1]!.picture, results[0]!.picture);
    assert.equal(results[1]!.delivery, results[0]!.delivery);
    assert.deepEqual(results[1]!.decoded, results[0]!.decoded);
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("worker cache evidence observes direct and nested static Image grades with exact shared-tree handoff accounting", { timeout: 240_000 }, async () => {
  const rgba = Buffer.alloc(8 * 6 * 4);
  for (let pixel = 0; pixel < 8 * 6; pixel += 1) {
    rgba.set([(pixel * 37) & 255, (pixel * 73) & 255, (pixel * 131) & 255, 255], pixel * 4);
  }
  const imageBytes = await sharp(rgba, { raw: { width: 8, height: 6, channels: 4 } }).png().toBuffer();
  const body = `MediaCamera2D(focusX: 25%) {
      ColorGrade(exposure: 0.5, saturation: 0.75) { Image(source: still, fit: "fill"); }
    }`;
  const programmes = [
    {
      label: "direct",
      camerasPerFrame: 1,
      expectedHit: 9,
      expectedHandoffBytes: 36 * 8 * 6,
      expectedMaximumHandoffBytes: 4 * 8 * 6,
      source: `cut 0.4;
project "Direct worker cache evidence";
import { ColorGrade, Image, MediaCamera2D } from "cut:visual";
asset still: ImageAsset = image("still.png");
timeline main(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");`,
    },
    {
      label: "nested",
      camerasPerFrame: 2,
      expectedHit: 21,
      expectedHandoffBytes: 84 * 8 * 6,
      expectedMaximumHandoffBytes: 8 * 8 * 6,
      source: `cut 0.4;
project "Nested worker cache evidence";
import { ColorGrade, Image, MediaCamera2D, Precomp } from "cut:visual";
asset still: ImageAsset = image("still.png");
timeline main(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) { Precomp(source: mediaBeat); Precomp(source: mediaBeat); }
}
timeline mediaBeat(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene media(duration: 1s) { ${body} }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");`,
    },
  ] as const;
  for (const fixture of programmes) {
    const root = await mkdtemp(resolve(tmpdir(), `cut-preview-worker-cache-${fixture.label}-`));
    try {
      await writeFile(resolve(root, "still.png"), imageBytes);
      const ir = await locked(root, fixture.source);
      const frames: Array<{
        globalFrame: number;
        counts: {
          hit: number;
          miss: number;
          bypassCapacity: number;
          bypassDynamic: number;
          residentCopies: number;
          residentCopyRgbaBytes: number;
          handoffCopies: number;
          handoffRgbaBytes: number;
          leaseHandoffs: number;
          leaseRgbaBytes: number;
        };
      }> = [];
      const plans: Array<{
        maximumStaticGradeHandoffRgbaBytes: number;
        maximumStaticGradeEventsPerFrame: number;
      }> = [];
      await renderReferencePreviewArtifact(ir, root, resolve(root, "review", "preview.mp4"), {
        range: "0s:1s",
        width: 64,
        __testPictureHooks: {
          requestedWorkerThreads: 3,
          staticMediaGradeCacheFrame(event: typeof frames[number] & { rendererIndex: number; sceneFrame: number }) {
            frames.push(event);
          },
          plan(plan: {
            maximumStaticGradeHandoffRgbaBytes: number;
            maximumStaticGradeEventsPerFrame: number;
          }) { plans.push(plan); },
        },
      });
      assert.equal(frames.length, 12, `${fixture.label}: one cache receipt per frame`);
      assert.deepEqual(
        frames.map(({ globalFrame }) => globalFrame).toSorted((left, right) => left - right),
        Array.from({ length: 12 }, (_, frame) => frame),
        `${fixture.label}: every frame must report exactly once regardless of chunk readiness order`,
      );
      assert.ok(frames.every(({ counts }) =>
        counts.hit + counts.miss + counts.bypassCapacity + counts.bypassDynamic === fixture.camerasPerFrame),
      `${fixture.label}: every visible camera must be observable even through repeated Precomp ownership`);
      const aggregate = frames.reduce((sum, { counts }) => {
        for (const key of Object.keys(sum) as Array<keyof typeof sum>) sum[key] += counts[key];
        return sum;
      }, {
        hit: 0,
        miss: 0,
        bypassCapacity: 0,
        bypassDynamic: 0,
        residentCopies: 0,
        residentCopyRgbaBytes: 0,
        handoffCopies: 0,
        handoffRgbaBytes: 0,
        leaseHandoffs: 0,
        leaseRgbaBytes: 0,
      });
      assert.deepEqual(aggregate, {
        hit: fixture.expectedHit,
        miss: 3,
        bypassCapacity: 0,
        bypassDynamic: 0,
        residentCopies: 3,
        residentCopyRgbaBytes: 12 * 8 * 6,
        handoffCopies: 0,
        handoffRgbaBytes: 0,
        leaseHandoffs: fixture.expectedHit,
        leaseRgbaBytes: fixture.expectedHandoffBytes,
      }, `${fixture.label}: three renderer-owned residents and exact isolated leased hits`);
      assert.equal(plans.length, 1);
      assert.equal(plans[0]!.maximumStaticGradeHandoffRgbaBytes, fixture.expectedMaximumHandoffBytes,
        `${fixture.label}: graph-derived admission must include the exact eligible crop handoff`);
      assert.equal(plans[0]!.maximumStaticGradeEventsPerFrame, fixture.camerasPerFrame,
        `${fixture.label}: graph-derived admission must include every active direct or repeated camera`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("worker static-grade handoff admission takes the maximum across sequential selected scenes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-preview-worker-cache-range-"));
  try {
    const rgba = Buffer.alloc(8 * 6 * 4, 127);
    await writeFile(
      resolve(root, "still.png"),
      await sharp(rgba, { raw: { width: 8, height: 6, channels: 4 } }).png().toBuffer(),
    );
    const ir = await locked(root, `cut 0.4;
project "Selected-range worker cache admission";
import { ColorGrade, Image, MediaCamera2D, Precomp } from "cut:visual";
asset still: ImageAsset = image("still.png");
timeline main(duration: 2s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene first(duration: 1s) { Precomp(source: firstBeat); }
  scene second(duration: 1s) { Precomp(source: secondBeat); }
}
timeline firstBeat(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%) { ColorGrade(exposure: 0.5) { Image(source: still, fit: "fill"); } }
  }
}
timeline secondBeat(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 75%) { ColorGrade(saturation: 0.75) { Image(source: still, fit: "fill"); } }
  }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");`);
    const composition = ir.compositions.find((candidate) => candidate.id === "main");
    assert.ok(composition);
    const plan = (firstFrame: number, endFrameExclusive: number) =>
      referencePreviewPictureParallelPlanForTest({
        ir,
        composition,
        firstFrame,
        endFrameExclusive,
        width: 64,
        height: 36,
        requestedWorkerThreads: 3,
      });
    assert.equal(plan(0, 12).maximumStaticGradeHandoffRgbaBytes, 8 * 6 * 4);
    assert.equal(plan(12, 24).maximumStaticGradeHandoffRgbaBytes, 8 * 6 * 4);
    assert.equal(
      plan(0, 24).maximumStaticGradeHandoffRgbaBytes,
      8 * 6 * 4,
      "sequential scene-local handoffs must not be charged as simultaneous worker memory",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker static-grade event admission counts repeated Precomp executions beyond the per-composition camera count", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-preview-worker-cache-repeated-precomp-"));
  try {
    const rgba = Buffer.alloc(8 * 6 * 4, 127);
    await writeFile(
      resolve(root, "still.png"),
      await sharp(rgba, { raw: { width: 8, height: 6, channels: 4 } }).png().toBuffer(),
    );
    const repeated = Array.from({ length: 33 }, () => "Precomp(source: mediaBeat);").join("\n");
    const ir = await locked(root, `cut 0.4;
project "Repeated Precomp worker cache admission";
import { ColorGrade, Image, MediaCamera2D, Precomp } from "cut:visual";
asset still: ImageAsset = image("still.png");
timeline main(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${repeated} }
}
timeline mediaBeat(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(focusX: 25%) { ColorGrade(exposure: 0.5) { Image(source: still, fit: "fill"); } }
  }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");`);
    const composition = ir.compositions.find((candidate) => candidate.id === "main");
    assert.ok(composition);
    const plan = referencePreviewPictureParallelPlanForTest({
      ir,
      composition,
      endFrameExclusive: 12,
      width: 64,
      height: 36,
      requestedWorkerThreads: 3,
    });
    assert.equal(plan.maximumStaticGradeEventsPerFrame, 33);
    assert.equal(plan.maximumStaticGradeHandoffRgbaBytes, 33 * 8 * 6 * 4);
    const frameEvents: Array<{
      globalFrame: number;
      counts: { hit: number; miss: number; bypassCapacity: number; bypassDynamic: number };
    }> = [];
    await renderReferencePreviewArtifact(ir, root, resolve(root, "review", "repeated-precomp.mp4"), {
      range: "0s:1s",
      width: 64,
      __testPictureHooks: {
        requestedWorkerThreads: 3,
        staticMediaGradeCacheFrame(event: typeof frameEvents[number]) { frameEvents.push(event); },
      },
    });
    assert.equal(frameEvents.length, 12);
    assert.ok(frameEvents.every(({ counts }) =>
      counts.hit + counts.miss + counts.bypassCapacity + counts.bypassDynamic === 33),
    "each worker frame must execute and account all 33 repeated camera instances without the retired 32-event cap");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("picture workers reconstruct exact invocation-local media-profile authority without trusting cloned markers", { timeout: 240_000 }, async () => {
  const program = `cut 0.4;
project "Worker media profile authority";
import { Rect } from "cut:visual";
import { AudioClip } from "@cut/audio";

asset voice: AudioAsset = audio("voice.wav");
asset voiceTwo: AudioAsset = audio("voice-two.wav");

timeline main(duration: 1s, fps: 12, width: 64px, height: 36px, sampleRate: 48khz) {
  AudioClip(source: voice, range: 0s ..< 1s);
  AudioClip(source: voiceTwo, range: 0s ..< 1s);
  scene only(duration: 1s) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #2667ff);
  }
}

export preview = render(main, width: 64px, height: 36px, codec: "h264");
`;
  const roots = await Promise.all(["serial", "worker", "hostile"].map((label) =>
    mkdtemp(resolve(tmpdir(), `cut-preview-profile-${label}-`))));
  try {
    const rendered = await Promise.all(roots.slice(0, 2).map(async (root, index) => {
      await writeFile(resolve(root, "voice.wav"), wav());
      await writeFile(resolve(root, "voice-two.wav"), wav());
      const ir = await locked(root, program);
      const manifest = await renderReferencePreviewArtifact(ir, root, resolve(root, "review", "preview.mp4"), {
        range: "0s:1s",
        width: 64,
        __testPictureHooks: index === 0 ? undefined : { requestedWorkerThreads: 3 },
      });
      return {
        cacheKey: manifest.execution.cache.key,
        picture: manifest.execution.cache.artifact.sha256,
        delivery: manifest.artifact.sha256,
        decoded: await decodedPicture(root, manifest.execution.cache.artifact.locator),
      };
    }));
    assert.equal(rendered[1]!.cacheKey, rendered[0]!.cacheKey);
    assert.equal(rendered[1]!.picture, rendered[0]!.picture);
    assert.equal(rendered[1]!.delivery, rendered[0]!.delivery);
    assert.deepEqual(rendered[1]!.decoded, rendered[0]!.decoded);

    const hostileRoot = roots[2]!;
    await writeFile(resolve(hostileRoot, "voice.wav"), wav());
    await writeFile(resolve(hostileRoot, "voice-two.wav"), wav());
    const hostileIr = await locked(hostileRoot, program);
    const selected = selectReferenceMediaProfile(hostileIr, "proxy");
    assert.equal(
      assertReferenceMediaProfileExecutionState(selected.ir),
      undefined,
      "media-profile validation must not expose its private mutable authority map",
    );
    assert.throws(
      () => registerReferenceMediaProfileExecution(selected.ir),
      /already registered/u,
      "duplicate registration must not overwrite invocation authority",
    );
    const mutations = [
      "resource-sha",
      "media-profile-authority",
      "media-profile-authority-extra-field",
      "media-profile-authority-omit-field",
      "media-profile-authority-semantic-hash",
      "media-profile-authority-missing-resource",
      "media-profile-authority-duplicate-resource",
      "media-profile-authority-reordered-resources",
      "media-profile-authority-resource-digest",
      "media-profile-authority-resource-selected",
      "media-profile-authority-resource-authored-proxy",
    ] as const;
    for (const mutation of mutations) {
      const hostileOutput = resolve(hostileRoot, "review", `${mutation}-must-not-exist.mp4`);
      const beforeFrames: number[] = [];
      const dispatchedChunks: number[] = [];
      await assert.rejects(
        renderReferencePreviewArtifact(hostileIr, hostileRoot, hostileOutput, {
          range: "0s:1s",
          width: 64,
          __testPictureHooks: {
            requestedWorkerThreads: 3,
            workerBootstrapMutation: mutation,
            beforeFrame(event: { globalFrame: number }) { beforeFrames.push(event.globalFrame); },
            workerChunkDispatched(event: { requestId: number }) { dispatchedChunks.push(event.requestId); },
          },
        }),
        /CUT_PROXY_PROFILE_STATE|CUT_PREVIEW_PICTURE_WORKER_RESOURCE|media-profile authority|worker failed closed/u,
        mutation,
      );
      assert.deepEqual(beforeFrames, [], `${mutation} must fail before any frame begins`);
      assert.deepEqual(dispatchedChunks, [], `${mutation} must fail before any worker chunk dispatch`);
      await assertNoWorkerPublication(hostileRoot, hostileOutput);
    }
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("worker lifecycle receipts fail closed when ready or closed is duplicate, early, or late", { timeout: 240_000 }, async () => {
  const cases = ["ready-duplicate", "ready-late", "closed-early", "closed-duplicate"] as const;
  for (const phase of cases) {
    const root = await mkdtemp(resolve(tmpdir(), `cut-preview-worker-${phase}-`));
    try {
      const ir = await locked(root);
      const output = resolve(root, "review", "must-not-exist.mp4");
      await assert.rejects(
        renderReferencePreviewArtifact(ir, root, output, {
          range: "0s:1s",
          width: 64,
          __testPictureHooks: {
            requestedWorkerThreads: 3,
            workerFault: { workerIndex: 1, phase },
          },
        }),
        /duplicate|late|early|out-of-order|failed closed/u,
        phase,
      );
      await assertNoWorkerPublication(root, output);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("worker bootstrap, chunk, and close faults fail closed without publication or unbounded waits", { timeout: 240_000 }, async () => {
  const cases = [
    { label: "bootstrap-module", workerBootstrapMutation: "module-sha" as const },
    { label: "bootstrap-ir", workerBootstrapMutation: "ir" as const },
    { label: "bootstrap-module-integrity", workerBootstrapMutation: "module-integrity" as const },
    { label: "bootstrap-media-profile-authority", workerBootstrapMutation: "media-profile-authority" as const },
    { label: "prepare-error", workerFault: { workerIndex: 1, phase: "prepare-error" as const } },
    { label: "prepare-exit", workerFault: { workerIndex: 1, phase: "prepare-exit" as const } },
    { label: "chunk-error", workerFault: { workerIndex: 1, phase: "chunk-error" as const } },
    { label: "chunk-hang", workerFault: { workerIndex: 1, phase: "chunk-hang" as const } },
    { label: "chunk-duplicate", workerFault: { workerIndex: 1, phase: "chunk-duplicate" as const } },
    { label: "chunk-reorder", workerFault: { workerIndex: 1, phase: "chunk-reorder" as const } },
    { label: "chunk-extra", workerFault: { workerIndex: 1, phase: "chunk-extra" as const } },
    { label: "chunk-wrong-size", workerFault: { workerIndex: 1, phase: "chunk-wrong-size" as const } },
    { label: "chunk-wrong-request", workerFault: { workerIndex: 1, phase: "chunk-wrong-request" as const } },
    { label: "chunk-wrong-subject", workerFault: { workerIndex: 1, phase: "chunk-wrong-subject" as const } },
    { label: "chunk-cache-negative", workerFault: { workerIndex: 1, phase: "chunk-cache-negative" as const } },
    { label: "chunk-cache-noninteger", workerFault: { workerIndex: 1, phase: "chunk-cache-noninteger" as const } },
    { label: "chunk-cache-extra", workerFault: { workerIndex: 1, phase: "chunk-cache-extra" as const } },
    { label: "chunk-cache-excessive", workerFault: { workerIndex: 1, phase: "chunk-cache-excessive" as const } },
    { label: "chunk-composite-mode", workerFault: { workerIndex: 1, phase: "chunk-composite-mode" as const } },
    { label: "chunk-composite-noninteger", workerFault: { workerIndex: 1, phase: "chunk-composite-noninteger" as const } },
    { label: "chunk-composite-extra", workerFault: { workerIndex: 1, phase: "chunk-composite-extra" as const } },
    { label: "chunk-composite-relation", workerFault: { workerIndex: 1, phase: "chunk-composite-relation" as const } },
    { label: "close-error", workerFault: { workerIndex: 1, phase: "close-error" as const } },
    { label: "close-hang", workerFault: { workerIndex: 1, phase: "close-hang" as const } },
    { label: "close-no-receipt", workerFault: { workerIndex: 1, phase: "close-no-receipt" as const } },
    { label: "close-nonzero", workerFault: { workerIndex: 1, phase: "close-nonzero" as const } },
  ] as const;
  for (const candidate of cases) {
    const root = await mkdtemp(resolve(tmpdir(), `cut-preview-worker-${candidate.label}-`));
    try {
      const ir = await locked(root);
      const output = resolve(root, "review", "must-not-exist.mp4");
      const terminated: Array<{ workerIndex: number; reason: string }> = [];
      await assert.rejects(
        renderReferencePreviewArtifact(ir, root, output, {
          range: "0s:1s",
          width: 64,
          __testPictureHooks: {
            requestedWorkerThreads: 3,
            ...("workerBootstrapMutation" in candidate
              ? { workerBootstrapMutation: candidate.workerBootstrapMutation }
              : { workerFault: candidate.workerFault }),
            workerTimeouts: { prepareMs: 1_000, chunkMs: 100, closeMs: 100 },
            workerTerminated(event: { workerIndex: number; reason: string }) { terminated.push(event); },
          },
        }),
        candidate.label === "bootstrap-module-integrity"
          ? /cloned IR cut:visual module is not bound to the current visual package manifest/u
          : /CUT_PREVIEW_PICTURE|worker|Worker|injected/u,
        candidate.label,
      );
      await assertNoWorkerPublication(root, output);
      if (candidate.label.endsWith("hang") || candidate.label === "close-no-receipt") {
        assert.ok(terminated.length > 0, `${candidate.label} must require bounded forced termination`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("private worker failure observers cannot replace the primary failure or bypass bounded cleanup", { timeout: 120_000 }, async () => {
  for (const observer of ["throw", "reject"] as const) {
    const root = await mkdtemp(resolve(tmpdir(), `cut-preview-worker-observer-${observer}-`));
    try {
      const ir = await locked(root);
      const output = resolve(root, "review", "must-not-exist.mp4");
      const terminated: number[] = [];
      await assert.rejects(
        renderReferencePreviewArtifact(ir, root, output, {
          range: "0s:1s",
          width: 64,
          __testPictureHooks: {
            requestedWorkerThreads: 3,
            workerFault: { workerIndex: 1, phase: "chunk-error" },
            workerFailureObserved() {
              if (observer === "throw") throw new Error("hostile synchronous observer failure");
              return Promise.reject(new Error("hostile asynchronous observer failure"));
            },
            workerTerminated(event: { workerIndex: number }) { terminated.push(event.workerIndex); },
          },
        }),
        /injected preview worker chunk failure/u,
      );
      assert.deepEqual(terminated.toSorted((left, right) => left - right), [0, 1, 2]);
      await assertNoWorkerPublication(root, output);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("worker revalidates locked resource bytes and the static worker remains in the visual closure without process-global Sharp mutation", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-preview-worker-resource-authority-"));
  const resourceSource = source
    .replace('import { Rect } from "cut:visual";', 'import { Image, Rect } from "cut:visual";')
    .replace(
      'import { Tone } from "@cut/audio";',
      'import { Tone } from "@cut/audio";\nasset voice: AudioAsset = audio("voice.wav");\nasset unused: ImageAsset = image("unused.png");',
    )
    .replace(
      'scene red(duration: 1s) {',
      'scene red(duration: 1s) {\n    Image(source: unused, fit: "fill");',
    );
  try {
    const originalBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const selectedMediaBytes = wav();
    const originalPath = resolve(root, "unused.png");
    const selectedMediaPath = resolve(root, "voice.wav");
    await writeFile(originalPath, originalBytes);
    await writeFile(selectedMediaPath, selectedMediaBytes);
    const ir = await locked(root, resourceSource);
    const output = resolve(root, "review", "must-not-exist.mp4");
    await assert.rejects(
      renderReferencePreviewArtifact(ir, root, output, {
        range: "0s:1s",
        width: 64,
        __testPictureHooks: {
          requestedWorkerThreads: 3,
          workerBootstrapMutation: "resource-sha",
          workerTimeouts: { prepareMs: 1_000, chunkMs: 100, closeMs: 100 },
        },
      }),
      /CUT_PREVIEW_PICTURE_WORKER_RESOURCE|worker failed closed/u,
    );
    await assertNoWorkerPublication(root, output);

    let mutatedPath: string | undefined;
    const observedWorkerFailures: string[] = [];
    const postReadyOutput = resolve(root, "review", "post-ready-mutation-must-not-exist.mp4");
    try {
      await assert.rejects(
        renderReferencePreviewArtifact(ir, root, postReadyOutput, {
          range: "0s:1s",
          width: 64,
          __testPictureHooks: {
            requestedWorkerThreads: 3,
            workersReady: async (event: { resources: readonly { id: string; path: string }[] }) => {
              const resource = event.resources.find((candidate) => candidate.id === "voice");
              assert.ok(resource);
              mutatedPath = resource.path;
              const drifted = Buffer.from(selectedMediaBytes);
              drifted[Math.floor(drifted.byteLength / 2)] ^= 1;
              await chmod(resource.path, 0o600);
              await writeFile(resource.path, drifted);
            },
            workerFailureObserved(event: { message: string }) { observedWorkerFailures.push(event.message); },
          },
        }),
        /CUT_PREVIEW_PICTURE_WORKER_RESOURCE|worker failed closed|CUT_INPUT_SESSION_PATH/u,
      );
      assert.ok(
        observedWorkerFailures.some((message) => /CUT_PREVIEW_PICTURE_WORKER_RESOURCE/u.test(message)),
        "the worker must detect the post-ready snapshot mutation before pixel publication",
      );
      await assertNoWorkerPublication(root, postReadyOutput);
    } finally {
      if (mutatedPath) {
        await chmod(mutatedPath, 0o600).catch(() => undefined);
        await writeFile(mutatedPath, selectedMediaBytes).catch(() => undefined);
        await chmod(mutatedPath, 0o400).catch(() => undefined);
      }
      await writeFile(originalPath, originalBytes);
      await writeFile(selectedMediaPath, selectedMediaBytes);
      assert.deepEqual(await readFile(originalPath), originalBytes, "post-ready mutation fixture must be restored exactly");
      assert.deepEqual(
        await readFile(selectedMediaPath),
        selectedMediaBytes,
        "selected post-ready media fixture must be restored exactly",
      );
      const referenceCache = resolve(root, ".cut/cache/reference");
      for (const entry of await readdir(referenceCache)) {
        if (entry.startsWith(".cut-inputs-")) await rm(resolve(referenceCache, entry), { recursive: true, force: true });
      }
      assert.deepEqual(
        (await readdir(referenceCache)).filter((entry) => entry.startsWith(".cut-inputs-")),
        [],
        "hostile snapshot residue must be removed by the focused fixture after fail-closed forensic retention",
      );
    }

    const workerSource = await readFile(resolve(process.cwd(), "lib/runtime/reference/preview-picture-worker.ts"), "utf8");
    assert.doesNotMatch(workerSource, /sharp\.cache\s*\(/u);
    assert.match(workerSource, /sharp\.concurrency\(\)/u);
    assert.doesNotMatch(workerSource, /sharp\.concurrency\([^)]/u);
    const roots = JSON.parse(await readFile(resolve(process.cwd(), "lib/language/builtin-implementation-roots.json"), "utf8")) as {
      packages: Record<string, readonly string[]>;
    };
    assert.ok(roots.packages["cut:visual"]?.includes("runtime/reference/preview-picture-worker"));
    const closure = JSON.parse(await readFile(resolve(process.cwd(), "lib/language/builtin-implementation-closure.json"), "utf8")) as {
      packages: Record<string, readonly string[]>;
    };
    assert.ok(closure.packages["cut:visual"]?.includes("runtime/reference/preview-picture-worker"));
    const currentIdentity = createCutBuiltinImplementationIdentity("cut:visual");
    assert.ok(currentIdentity.files.some((file) => file.id === "runtime/reference/preview-picture-worker"));
    const counterfactual = createCutBuiltinImplementationIdentity("cut:visual", {
      sourceOverrides: new Map([["runtime/reference/preview-picture-worker", `${workerSource}\n// hostile closure mutation\n`]]),
    });
    assert.notEqual(counterfactual.integrity, currentIdentity.integrity);
    const packageManifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as { files?: readonly string[] };
    assert.ok(packageManifest.files?.includes("dist-cli/lib/runtime"));
    assert.ok((await readFile(resolve(process.cwd(), "dist-cli/lib/runtime/reference/preview-picture-worker.js"))).byteLength > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lazy selected-range nested preparation materializes only the active instance and preserves eager pixels", async () => {
  const nestedSource = `cut 0.4;
project "Lazy selected range nested preparation";
import { Precomp, Rect } from "cut:visual";
timeline main(duration: 2s, fps: 4, width: 32px, height: 18px, sampleRate: 8khz) {
  scene staticOpening(duration: 1s) {
    Rect(width: 32px, height: 18px, x: 16px, y: 9px, fill: #17324d);
  }
  scene nestedEnding(duration: 1s) {
    Precomp(source: insert);
  }
}
timeline insert(duration: 1s, fps: 4, width: 32px, height: 18px, sampleRate: 8khz) {
  scene amber(duration: 1s) {
    Rect(width: 32px, height: 18px, x: 16px, y: 9px, fill: #f59e0b);
  }
}
export preview = render(main, width: 32px, height: 18px, codec: "h264");
`;
  const ir = compile(nestedSource);
  const composition = ir.compositions.find((candidate) => candidate.name === "main")!;
  const precompNodeId = Object.values(ir.nodes).find(
    (node) => node.op === "cut.visual.precomp",
  )!.id;
  const root = await mkdtemp(resolve(tmpdir(), "cut-preview-lazy-nested-"));
  const eager = new ReferenceVisualRenderer(
    ir,
    composition,
    root,
    resolve(root, "eager-cache"),
  );
  const lazy = new ReferenceVisualRenderer(
    ir,
    composition,
    root,
    resolve(root, "lazy-cache"),
    undefined,
    undefined,
    1,
    { lazyNestedCompositionPreparation: true },
  );
  try {
    await Promise.all([eager.prepare(), lazy.prepare()]);
    assert.deepEqual(eager.referenceNestedCompositionPreparationEvidence(), {
      format: "cut-reference-nested-composition-preparation",
      version: 1,
      policy: "eager",
      configuredNodeIds: [precompNodeId],
      preparedNodeIds: [precompNodeId],
      pendingNodeIds: [],
    });
    assert.deepEqual(lazy.referenceNestedCompositionPreparationEvidence(), {
      format: "cut-reference-nested-composition-preparation",
      version: 1,
      policy: "lazy-active",
      configuredNodeIds: [precompNodeId],
      preparedNodeIds: [],
      pendingNodeIds: [],
    });
    const opening = ir.scenes[composition.sceneIds[0]]!;
    const ending = ir.scenes[composition.sceneIds[1]]!;
    const [eagerOpening, lazyOpening] = await Promise.all([
      eager.sceneFrame(opening, 0),
      lazy.sceneFrame(opening, 0),
    ]);
    assert.deepEqual(lazyOpening.data, eagerOpening.data);
    assert.deepEqual(
      lazy.referenceNestedCompositionPreparationEvidence().preparedNodeIds,
      [],
      "an inactive nested scene must not be recursively prepared",
    );
    const [eagerEnding, lazyEnding] = await Promise.all([
      eager.sceneFrame(ending, 0),
      lazy.sceneFrame(ending, 0),
    ]);
    assert.deepEqual(lazyEnding.data, eagerEnding.data);
    assert.deepEqual(
      lazy.referenceNestedCompositionPreparationEvidence().preparedNodeIds,
      [precompNodeId],
      "the exact active nested instance must materialize on first pixel execution",
    );
  } finally {
    await Promise.all([eager.closeAndWait(), lazy.closeAndWait()]);
    assert.deepEqual(lazy.referenceNestedCompositionPreparationEvidence().preparedNodeIds, []);
    assert.deepEqual(lazy.referenceNestedCompositionPreparationEvidence().pendingNodeIds, []);
    await rm(root, { recursive: true, force: true });
  }
});

test("lazy nested preparation failure is source-faithful, retryable, and leaves no pending renderer", async () => {
  const invalidNestedSource = `cut 0.4;
project "Lazy nested preparation failure cleanup";
import { Precomp, Rect, Text } from "cut:visual";
asset face: FontAsset = font("face.bin");
timeline main(duration: 2s, fps: 4, width: 32px, height: 18px, sampleRate: 8khz) {
  scene staticOpening(duration: 1s) {
    Rect(width: 32px, height: 18px, x: 16px, y: 9px, fill: #17324d);
  }
  scene nestedEnding(duration: 1s) {
    Precomp(source: insert);
  }
}
timeline insert(duration: 1s, fps: 4, width: 32px, height: 18px, sampleRate: 8khz) {
  scene invalidFont(duration: 1s) {
    Text(content: "A", font: face, x: 16px, y: 9px, size: 12px, color: #ffffff);
  }
}
export preview = render(main, width: 32px, height: 18px, codec: "h264");
`;
  const root = await mkdtemp(resolve(tmpdir(), "cut-preview-lazy-nested-failure-"));
  try {
    await writeFile(resolve(root, "face.bin"), Buffer.from("not-an-opentype-font\n"));
    const ir = await locked(root, invalidNestedSource);
    const composition = ir.compositions.find((candidate) => candidate.name === "main")!;
    const renderer = new ReferenceVisualRenderer(
      ir,
      composition,
      root,
      resolve(root, "lazy-cache"),
      undefined,
      undefined,
      1,
      { lazyNestedCompositionPreparation: true },
    );
    try {
      await renderer.prepare();
      await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]]!, 0);
      const ending = ir.scenes[composition.sceneIds[1]]!;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          renderer.sceneFrame(ending, 0),
          /font|Font|OpenType/u,
        );
        const state = renderer.referenceNestedCompositionPreparationEvidence();
        assert.deepEqual(state.preparedNodeIds, []);
        assert.deepEqual(state.pendingNodeIds, []);
      }
    } finally {
      await renderer.closeAndWait();
      assert.deepEqual(
        renderer.referenceNestedCompositionPreparationEvidence().pendingNodeIds,
        [],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
