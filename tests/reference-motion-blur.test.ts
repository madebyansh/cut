import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import {
  ReferenceMotionBlurError,
  referenceMotionBlurCompositionLimits,
  referenceMotionBlurConfig,
} from "../lib/runtime/reference/motion-blur";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function program(body: string, options: { width?: number; height?: number; fps?: number } = {}) {
  const width = options.width ?? 64, height = options.height ?? 24, fps = options.fps ?? 4;
  return `cut 0.4;
project "unrelated temporal exposure proof";
import { Grain, MotionBlur, Rect } from "cut:visual";
timeline main(duration: 1s, fps: ${fps}, width: ${width}px, height: ${height}px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function mediaProgram(body: string) {
  return `cut 0.4;
project "redistributable temporal media proof";
import { MotionBlur, Video } from "cut:visual";
asset footage: VideoAsset = video("media/colors.mkv");
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;
}

function pictureMediaProgram(body: string) {
  return `cut 0.4;
project "redistributable temporal PictureClip proof";
import { MotionBlur } from "cut:visual";
import { Gap, PictureClip, PictureTrack } from "@cut/edit";
asset footage: VideoAsset = video("media/colors.mkv");
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source: string) {
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function compileForLock(source: string) {
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(cutModule).ir;
}

async function temporalMediaFixtureRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-motion-blur-media-")), media = resolve(root, "media");
  await mkdir(media);
  // Four generated solid-color frames are original, redistributable fixture
  // material. FFV1/BGRA keeps their exact bytes through the locked decoder.
  const colors = [
    { r: 224, g: 32, b: 24 },
    { r: 24, g: 208, b: 48 },
    { r: 24, g: 48, b: 224 },
    { r: 232, g: 232, b: 232 },
  ];
  await Promise.all(colors.map((background, index) => sharp({
    create: { width: 16, height: 16, channels: 4, background: { ...background, alpha: 1 } },
  }).png().toFile(resolve(media, `frame-${index}.png`))));
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-framerate", "4", "-start_number", "0",
    "-i", resolve(media, "frame-%d.png"), "-frames:v", "4", "-c:v", "ffv1", "-pix_fmt", "bgra",
    resolve(media, "colors.mkv"),
  ]);
  return root;
}

async function lockedMediaSource(root: string, source: string) {
  const ir = compileForLock(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

async function lockedMediaProgram(root: string, body: string) {
  return lockedMediaSource(root, mediaProgram(body));
}

async function lockedMediaFrame(ir: CutAVIR, root: string, outputFrame: number, cacheName: string) {
  const { composition } = validateReferenceSession(ir, "out"), scene = ir.scenes[composition.sceneIds[0]];
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "motion-blur-media", cacheName));
  try {
    await renderer.prepare();
    return await renderer.sceneFrame(scene, outputFrame, false);
  } finally { renderer.close(); }
}

function motionBlurNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.motion_blur");
  assert.ok(node);
  return node;
}

function digest(data: Uint8Array) { return createHash("sha256").update(data).digest("hex"); }

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

async function frame(source: string, outputFrame: number) {
  const ir = compile(source), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-motion-blur-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    return { ir, surface: await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], outputFrame, false) };
  } finally { renderer.close(); }
}

function expectCompileCode(source: string, code: string, message?: RegExp) {
  const cutModule = parse(source);
  assert.throws(() => compileCutModule(cutModule), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === code);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    if (message) assert.match(diagnostic.message, message);
    return true;
  });
}

function expectRuntimeError(work: () => unknown, code: ReferenceMotionBlurError["code"], nodeId?: string) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceMotionBlurError);
    assert.equal(error.code, code);
    assert.ok(error.source?.module && error.source.line > 0 && error.source.column > 0);
    if (nodeId) assert.equal(error.source.nodeId, nodeId);
    return true;
  });
}

test("MotionBlur is a closed required-argument unary API and lowers to typed IR", () => {
  const symbol = packageSymbol("cut:visual", "MotionBlur");
  assert.deepEqual(symbol?.parameters?.map((parameter) => ({ name: parameter.name, type: parameter.type, optional: parameter.optional })), [
    { name: "shutterAngle", type: "Angle", optional: undefined },
    { name: "samples", type: "Number", optional: undefined },
    { name: "startEdge", type: "String", optional: true },
  ]);
  assert.equal(symbol?.children, "visual");
  const kernel = referenceKernelSchema("cut.visual.motion_blur");
  assert.equal(kernel?.support, "supported");
  if (kernel?.support === "supported") {
    assert.deepEqual(kernel.inputs, ["shutterAngle", "samples", "startEdge"]);
    assert.deepEqual(kernel.stringInputs.startEdge, ["hold", "transparent"]);
    assert.deepEqual(kernel.properties, []);
    assert.deepEqual([kernel.minimumChildren, kernel.maximumChildren], [1, 1]);
  }

  const ir = compile(program("MotionBlur(shutterAngle: 270deg, samples: 6) { Rect(width: 8px, height: 8px, fill: #336699); }"));
  const node = motionBlurNode(ir), config = referenceMotionBlurConfig(node);
  assert.deepEqual(node.inputs, {
    shutterAngle: { kind: "quantity", dimension: "angle", magnitude: rational(270), unit: "deg" },
    samples: { kind: "quantity", dimension: "scalar", magnitude: rational(6), unit: "scalar" },
  });
  assert.deepEqual(node.properties, {});
  assert.equal(node.children.length, 1);
  assert.deepEqual(config, {
    nodeId: node.id,
    shutterAngle: rational(270),
    samples: 6,
    startEdge: "transparent",
    authoredStartEdge: false,
  });

  for (const [body, expected] of [
    ["MotionBlur(shutterAngle: 180, samples: 4) { Rect(width: 8px, height: 8px); }", /shutterAngle.*expects Angle.*Number/],
    ["MotionBlur(shutterAngle: 180deg, samples: 4, flow: true) { Rect(width: 8px, height: 8px); }", /does not execute input “flow”/],
    ["MotionBlur(shutterAngle: 180deg, samples: 4, startEdge: \"wrap\") { Rect(width: 8px, height: 8px); }", /startEdge.*hold.*transparent/],
    ["MotionBlur(shutterAngle: 180deg) { Rect(width: 8px, height: 8px); }", /Missing required argument “samples”/],
    ["MotionBlur(shutterAngle: 180deg, samples: 4) as exposure { Rect(width: 8px, height: 8px); } animate exposure.samples from 2 to 8 over 1s;", /no executable property “samples”/],
  ] as const) {
    const cutModule = parse(program(body)), diagnostics = checkCutModule(cutModule).diagnostics;
    assert.match(diagnostics.map((item) => item.message).join("\n"), expected);
    assert.ok(diagnostics.some((item) => item.span.start.line > 0 && item.span.start.column > 0));
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }

  for (const source of [
    program("MotionBlur(shutterAngle: 180deg, samples: 4);"),
    program("MotionBlur(shutterAngle: 180deg, samples: 4) { Rect(width: 8px, height: 8px); Rect(width: 4px, height: 4px); }"),
  ]) expectCompileCode(source, "CUT2085", /requires exactly one visual child/);
});

test("compile preflight rejects no-op, fractional, range, and aggregate temporal work with stable locations", () => {
  for (const [body, code, expected] of [
    ["MotionBlur(shutterAngle: 0deg, samples: 4) { Rect(width: 8px, height: 8px); }", "CUT_MOTION_BLUR_NOOP", /shutterAngle must be greater than zero/],
    ["MotionBlur(shutterAngle: 180deg, samples: 1) { Rect(width: 8px, height: 8px); }", "CUT_MOTION_BLUR_NOOP", /at least two temporal samples/],
    ["MotionBlur(shutterAngle: 361deg, samples: 4) { Rect(width: 8px, height: 8px); }", "CUT_MOTION_BLUR_CONFIG", /at most 360/],
    ["MotionBlur(shutterAngle: 180deg, samples: 2.5) { Rect(width: 8px, height: 8px); }", "CUT_MOTION_BLUR_CONFIG", /exact integer/],
    ["MotionBlur(shutterAngle: 180deg, samples: 33) { Rect(width: 8px, height: 8px); }", "CUT_MOTION_BLUR_BUDGET", /maxSamples=32/],
    ["MotionBlur(shutterAngle: 180deg, samples: 4, startEdge: \"transparent\") { Rect(width: 8px, height: 8px); }", "CUT_MOTION_BLUR_NOOP", /repeats the omitted default/],
    ["at 125ms { MotionBlur(shutterAngle: 180deg, samples: 2, startEdge: \"hold\") { Rect(width: 8px, height: 8px); } }", "CUT_MOTION_BLUR_NOOP", /never affects an exact shutter sample/],
  ] as const) expectCompileCode(program(body), code, expected);

  const exactDirectBound = compile(program(
    "MotionBlur(shutterAngle: 180deg, samples: 4) { Rect(width: 8px, height: 8px); }",
    { width: 3_840, height: 2_160 },
  ));
  assert.doesNotThrow(() => validateReferenceSession(exactDirectBound), "4K x four samples is the exact direct pixel/sample boundary");
  expectCompileCode(
    program("MotionBlur(shutterAngle: 180deg, samples: 2) { Rect(width: 8px, height: 8px); }", { width: 3_840, height: 2_161 }),
    "CUT_MOTION_BLUR_BUDGET",
    /8298240 pixels.*maxPixels=8294400/,
  );
  expectCompileCode(
    program("MotionBlur(shutterAngle: 180deg, samples: 5) { Rect(width: 8px, height: 8px); }", { width: 3_840, height: 2_160 }),
    "CUT_MOTION_BLUR_BUDGET",
    /41472000 pixel-samples.*maxPixelSamples=33177600/,
  );
  const loadedOverCanvas = structuredClone(exactDirectBound);
  loadedOverCanvas.compositions[0].height = 2_161;
  loadedOverCanvas.outputs[0].parameters.height = { kind: "quantity", dimension: "length", magnitude: rational(2_161), unit: "px" };
  finalizeGraphHashes(loadedOverCanvas);
  const loadedCanvas = loadCutAvIr(JSON.stringify(loadedOverCanvas)), loadedCanvasBlur = motionBlurNode(loadedCanvas);
  expectRuntimeError(() => validateReferenceSession(loadedCanvas), "CUT_MOTION_BLUR_BUDGET", loadedCanvasBlur.id);

  const loadedOverSamples = structuredClone(exactDirectBound), loadedSamplesBlur = motionBlurNode(loadedOverSamples);
  loadedSamplesBlur.inputs.samples = { kind: "quantity", dimension: "scalar", magnitude: rational(5), unit: "scalar" };
  finalizeGraphHashes(loadedOverSamples);
  const loadedSamples = loadCutAvIr(JSON.stringify(loadedOverSamples)), loadedSamplesNode = motionBlurNode(loadedSamples);
  expectRuntimeError(() => validateReferenceSession(loadedSamples), "CUT_MOTION_BLUR_BUDGET", loadedSamplesNode.id);

  const nested4k = program(`MotionBlur(shutterAngle: 180deg, samples: 4) {
    MotionBlur(shutterAngle: 180deg, samples: 4) { Rect(width: 8px, height: 8px); }
  }`, { width: 3_840, height: 2_160 });
  expectCompileCode(nested4k, "CUT_MOTION_BLUR_BUDGET", new RegExp(`exceeds maxAggregatePixelSamples=${referenceMotionBlurCompositionLimits.maxAggregatePixelSamples}`));
});

test("MotionBlur budget traversal cannot pre-empt an unrelated kernel-contract diagnostic", () => {
  const ir = compile(program(`MotionBlur(shutterAngle: 180deg, samples: 4) {
    Rect(width: 8px, height: 8px, fill: #ef233c);
  }
  Rect(width: 6px, height: 6px, fill: #123456);`));
  ir.determinism.semantic = "locked";
  const unrelated = Object.values(ir.nodes).find((node) => node.op === "cut.visual.rect"
    && node.inputs.fill?.kind === "color" && node.inputs.fill.value === "#123456");
  assert.ok(unrelated);
  unrelated.children.push(unrelated.id);
  assert.throws(
    () => validateReferenceSession(ir),
    (error: unknown) => !(error instanceof ReferenceMotionBlurError) && /does not execute child nodes/.test(String(error)),
  );
});

test("animated public CUT renders true exact-time temporal samples, not a sharp or memo-collapsed frame", async () => {
  const animated = program(`MotionBlur(shutterAngle: 360deg, samples: 4) {
    Rect(width: 8px, height: 8px, fill: #ef233c) as mover;
    animate mover.x from -20px to 20px over 1s;
  }`);
  const sharp = program(`Rect(width: 8px, height: 8px, fill: #ef233c) as mover;
    animate mover.x from -20px to 20px over 1s;`);
  // At output t=1/2, the first of four exact 360-degree shutter samples is
  // t=13/32. The same linear track is therefore x=-3.75px. Before exact time
  // entered node-frame memoization all four samples collapsed to this image.
  const collapsedFirstSample = program("Rect(width: 8px, height: 8px, x: -3.75px, fill: #ef233c);");
  const [blurred, sharpFrame, firstSample] = await Promise.all([
    frame(animated, 2), frame(sharp, 2), frame(collapsedFirstSample, 2),
  ]);
  const blurredDigest = digest(blurred.surface.data);
  assert.notEqual(blurredDigest, digest(sharpFrame.surface.data), "temporal integration must differ from the sharp output-time frame");
  assert.notEqual(blurredDigest, digest(firstSample.surface.data), "exact shutter samples must not collapse to the first memoized time");
  const alphas = Array.from({ length: blurred.surface.width * blurred.surface.height }, (_, index) => blurred.surface.data[index * 4 + 3]);
  assert.ok(alphas.some((alpha) => alpha > 0 && alpha < 255), "distinct moving samples create fractional temporal coverage");
});

test("locked discrete media shutter samples are serialized, exact, and repeatable", { timeout: 90_000 }, async () => {
  const root = await temporalMediaFixtureRoot();
  const ordinary = await lockedMediaProgram(root, `MotionBlur(shutterAngle: 360deg, samples: 4) {
    Video(source: footage, fit: "fill");
  }`);
  const repeated: Awaited<ReturnType<typeof lockedMediaFrame>>[] = [];
  for (let run = 0; run < 4; run += 1) repeated.push(await lockedMediaFrame(ordinary, root, 2, `ordinary-${run}`));
  assert.ok(repeated.every((surface) => digest(surface.data) === digest(repeated[0].data)), "fresh decoders must produce identical temporal media bytes");
  for (const surface of repeated) {
    assert.deepEqual(pixel(surface, 8, 8), [24, 156, 167, 255], "the centered shutter must average two green and two blue source-frame samples");
  }

  const tiny = await lockedMediaProgram(root, `MotionBlur(shutterAngle: 0.000001deg, samples: 2) {
    Video(source: footage, fit: "fill");
  }`);
  const tinyFrame = await lockedMediaFrame(tiny, root, 1, "tiny-shutter");
  assert.deepEqual(pixel(tinyFrame, 8, 8), [165, 154, 38, 255], "exact times immediately below and above frame 1 must select source frames 0 and 1");

  const mappedPicture = await lockedMediaSource(root, pictureMediaProgram(`MotionBlur(shutterAngle: 0.000001deg, samples: 2) {
    PictureTrack() {
      PictureClip(source: footage, range: 0s ..< 1s, duration: 500ms, playback: "normal", rate: 2, fit: "fill");
      Gap(duration: 500ms);
    }
  }`));
  const mappedRuns = await Promise.all([0, 1, 2].map((run) => lockedMediaFrame(mappedPicture, root, 1, `mapped-picture-${run}`)));
  assert.ok(mappedRuns.every((surface) => digest(surface.data) === digest(mappedRuns[0].data)), "fresh mapped PictureClip decoders must produce identical temporal bytes");
  assert.deepEqual(pixel(mappedRuns[0], 8, 8), [165, 41, 165, 255], "the exact tiny shutter must straddle destination frames 0/1, which the 2x PictureClip maps to locked source frames 0/2");
});

test("nested MotionBlur refuses forward-only locked media before decoder construction", { timeout: 90_000 }, async () => {
  const nestedSource = mediaProgram(`MotionBlur(shutterAngle: 360deg, samples: 4) {
    MotionBlur(shutterAngle: 270deg, samples: 2) { Video(source: footage, fit: "fill"); }
  }`);
  expectCompileCode(nestedSource, "CUT_MOTION_BLUR_PLAN", /nested MotionBlur cannot sample forward-only media/);
  const nestedPictureSource = pictureMediaProgram(`MotionBlur(shutterAngle: 360deg, samples: 4) {
    MotionBlur(shutterAngle: 270deg, samples: 2) {
      PictureTrack() {
        PictureClip(source: footage, range: 0s ..< 1s, duration: 500ms, playback: "normal", rate: 2, fit: "fill");
        Gap(duration: 500ms);
      }
    }
  }`);
  expectCompileCode(nestedPictureSource, "CUT_MOTION_BLUR_PLAN", /nested MotionBlur cannot sample forward-only media/);

  // Mirror the formerly crashing graph in locked typed IR as well, so a
  // hostile loader cannot bypass the public compiler refusal. All nodes and
  // the FFV1 resource originate from ordinary public CUT source; only the
  // parent edge is changed after locking.
  const root = await temporalMediaFixtureRoot();
  const separated = await lockedMediaProgram(root, `
    MotionBlur(shutterAngle: 360deg, samples: 4) { Video(source: footage, fit: "fill"); }
    MotionBlur(shutterAngle: 270deg, samples: 2) { Video(source: footage, fit: "fill"); }
  `);
  const blurs = Object.values(separated.nodes).filter((node) => node.op === "cut.visual.motion_blur");
  assert.equal(blurs.length, 2);
  const outer = blurs.find((node) => node.inputs.samples?.kind === "quantity" && node.inputs.samples.magnitude.numerator === "4");
  const inner = blurs.find((node) => node.inputs.samples?.kind === "quantity" && node.inputs.samples.magnitude.numerator === "2");
  assert.ok(outer && inner);
  const [displacedChild] = outer.children;
  outer.children = [inner.id];
  inner.ownership = "child";
  delete separated.nodes[displacedChild];
  const scene = separated.scenes[separated.compositions[0].sceneIds[0]];
  scene.items = scene.items.filter((item) => item.id !== inner.id);
  scene.rootVisualIds = scene.rootVisualIds.filter((id) => id !== inner.id);
  separated.compositions[0].rootVisualIds = separated.compositions[0].rootVisualIds.filter((id) => id !== inner.id);
  separated.compositions[0].items = separated.compositions[0].items.filter((item) => item.kind !== "node" || item.id !== inner.id);
  finalizeGraphHashes(separated);
  const loaded = loadCutAvIr(JSON.stringify(separated));
  expectRuntimeError(() => validateReferenceSession(loaded), "CUT_MOTION_BLUR_PLAN", outer.id);
});

test("child-owned runtime diagnostics escape MotionBlur unchanged", async () => {
  const ir = compile(program("MotionBlur(shutterAngle: 180deg, samples: 2) { Rect(width: 8px, height: 8px); }"));
  const { composition } = validateReferenceSession(ir), scene = ir.scenes[composition.sceneIds[0]], blur = motionBlurNode(ir), [childId] = blur.children;
  const root = await mkdtemp(resolve(tmpdir(), "cut-motion-blur-child-diagnostic-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  const child = ir.nodes[childId];
  assert.ok(child);
  const childFailure = Object.assign(new Error("sentinel child renderer failure"), {
    code: "CUT_CHILD_SENTINEL",
    source: {
      module: child.provenance.module,
      line: child.provenance.span.start.line,
      column: child.provenance.span.start.column,
      nodeId: child.id,
    },
  });
  type InternalRenderer = {
    nodeFrame(nodeId: string, time: ReturnType<typeof rational>, frameIndex: number): Promise<unknown>;
  };
  const internal = renderer as unknown as InternalRenderer, original = internal.nodeFrame.bind(renderer);
  internal.nodeFrame = async (nodeId, time, frameIndex) => {
    if (nodeId === child.id) throw childFailure;
    return original(nodeId, time, frameIndex);
  };
  try {
    await assert.rejects(renderer.sceneFrame(scene, 2, false), (error: unknown) => {
      assert.equal(error, childFailure);
      assert.equal((error as typeof childFailure).code, "CUT_CHILD_SENTINEL");
      assert.deepEqual((error as typeof childFailure).source, childFailure.source);
      return true;
    });
  } finally { renderer.close(); }
});

test("output-frame stochastic seed is fixed across shutter samples and boundaries are transparent", async () => {
  const grain = "Grain(amount: 40%, size: 1px, seed: 42, mode: \"temporal\") { Rect(width: 32px, height: 16px, fill: #808080); }";
  const [blurredGrain, sharpGrain] = await Promise.all([
    frame(program(`MotionBlur(shutterAngle: 360deg, samples: 4) { ${grain} }`), 2),
    frame(program(grain), 2),
  ]);
  assert.equal(digest(blurredGrain.surface.data), digest(sharpGrain.surface.data), "sample time drives signals, not temporal Grain's fixed output-frame seed");

  const boundary = await frame(program("MotionBlur(shutterAngle: 360deg, samples: 2) { Rect(width: 8px, height: 8px, fill: #336699); }"), 0);
  assert.deepEqual(pixel(boundary.surface, 32, 12), [51, 102, 153, 128], "one pre-roll sample is transparent rather than clamped to the first child frame");
});

test("authored startEdge hold keeps frame-zero coverage while preserving exact later shutter sampling", async () => {
  const heldSource = program(`MotionBlur(shutterAngle: 360deg, samples: 2, startEdge: "hold") {
    Rect(width: 8px, height: 8px, fill: #336699) as mover;
    animate mover.x from 0px to 16px over 1s;
  }`);
  const transparentSource = heldSource.replace(', startEdge: "hold"', "");
  const [heldStart, transparentStart, heldLater, transparentLater] = await Promise.all([
    frame(heldSource, 0), frame(transparentSource, 0), frame(heldSource, 2), frame(transparentSource, 2),
  ]);
  assert.deepEqual(pixel(heldStart.surface, 32, 12), [51, 102, 153, 255]);
  assert.deepEqual(pixel(transparentStart.surface, 32, 12), [51, 102, 153, 128]);
  assert.equal(
    digest(heldLater.surface.data),
    digest(transparentLater.surface.data),
    "once every shutter sample is inside the child, startEdge must change no later pixels",
  );
});

test("public startEdge hold cannot fill an intentional gap before its direct child", async () => {
  const heldSource = program(`MotionBlur(shutterAngle: 360deg, samples: 2, startEdge: "hold") {
    at 250ms { Rect(width: 8px, height: 8px, fill: #336699); }
  }`);
  const ir = compile(heldSource), blur = motionBlurNode(ir), child = ir.nodes[blur.children[0]];
  assert.ok(child);
  assert.deepEqual(blur.interval.start, rational(0));
  assert.deepEqual(child.interval.start, rational(1, 4));
  const [beforeChild, firstOwned] = await Promise.all([frame(heldSource, 0), frame(heldSource, 1)]);
  assert.deepEqual(pixel(beforeChild.surface, 32, 12), [0, 0, 0, 0], "nominal output before C0 must remain transparent even when its shutter crosses C0");
  assert.deepEqual(pixel(firstOwned.surface, 32, 12), [51, 102, 153, 255], "the exact first child-owned output may hold pre-start shutter samples at C0");
});

test("held-start locked Video covers frame zero through fresh ordered decoders and locked master selection", { timeout: 90_000 }, async () => {
  const root = await temporalMediaFixtureRoot();
  const held = await lockedMediaProgram(root, `MotionBlur(shutterAngle: 360deg, samples: 4, startEdge: "hold") {
    Video(source: footage, fit: "fill");
  }`);
  const selected = held.resources.footage;
  assert.deepEqual({ state: selected.state, locator: selected.locator }, { state: "locked", locator: "media/colors.mkv" });
  assert.match(selected.sha256 ?? "", /^[a-f0-9]{64}$/u);
  const heldRuns: Awaited<ReturnType<typeof lockedMediaFrame>>[] = [];
  for (let run = 0; run < 3; run += 1) heldRuns.push(await lockedMediaFrame(held, root, 0, `held-start-video-${run}`));
  assert.ok(heldRuns.every((surface) => digest(surface.data) === digest(heldRuns[0].data)), "fresh forward-only decoders must repeat the held first-frame bytes");
  assert.ok(heldRuns.every((surface) => pixel(surface, 8, 8).join(",") === "224,32,24,255"), "all four samples must select the locked first decoded frame");

  const omitted = await lockedMediaProgram(root, `MotionBlur(shutterAngle: 360deg, samples: 4) {
    Video(source: footage, fit: "fill");
  }`);
  const omittedStart = await lockedMediaFrame(omitted, root, 0, "omitted-start-video");
  assert.deepEqual(pixel(omittedStart, 8, 8), [224, 32, 24, 128], "the canonical omitted policy must preserve the transparent half-shutter control");
});

test("startEdge is ordinary typed IR with inspect, semantic diff, and localized cache identity", () => {
  const omittedSource = program(`MotionBlur(shutterAngle: 180deg, samples: 4) {
    Rect(width: 8px, height: 8px, fill: #336699);
  }`);
  const heldSource = omittedSource.replace("samples: 4", 'samples: 4, startEdge: "hold"');
  const omitted = compile(omittedSource), held = compile(heldSource), blur = motionBlurNode(held);
  assert.deepEqual(blur.inputs.startEdge, { kind: "string", value: "hold" });

  const inspected = inspectCutIr(held, "held.cut") as ReturnType<typeof inspectCutIr> & {
    graph: { nodes: Array<{ id: string; motionBlur?: {
      kind: string;
      startEdge: { resolved: string; authored: boolean; omittedDefault: string };
      reachability: { affectedStartSamples: number };
      semanticIdentity: string;
      inspectionSample: { heldStartSamples: number; cacheIdentity: string; mapping: Array<{ disposition: string }> };
    } }> };
  };
  const evidence = inspected.graph.nodes.find((node) => node.id === blur.id)?.motionBlur;
  assert.equal(evidence?.kind, "exact-centered-shutter");
  assert.deepEqual(evidence?.startEdge, { resolved: "hold", authored: true, omittedDefault: "transparent" });
  assert.equal(evidence?.reachability.affectedStartSamples, 2);
  assert.equal(evidence?.inspectionSample.heldStartSamples, 2);
  assert.deepEqual(evidence?.inspectionSample.mapping.map((sample) => sample.disposition), ["held-start", "held-start", "inside", "inside"]);
  assert.match(evidence?.semanticIdentity ?? "", /^[a-f0-9]{64}$/u);
  assert.match(evidence?.inspectionSample.cacheIdentity ?? "", /^[a-f0-9]{64}$/u);

  const diff = diffCutAVIR(omitted, held), changed = diff.changes.find((entry) => entry.entity === "node" && entry.id === blur.id);
  assert.equal(changed?.operation, "modify");
  if (changed?.operation === "modify") assert.ok(changed.fields.some((field) => field.path === "/inputs/startEdge"), JSON.stringify(changed.fields));
  const previous = createIncrementalRenderPlan(omitted, "main").manifest, cache = createIncrementalRenderPlan(held, "main", previous);
  const child = held.nodes[blur.children[0]];
  assert.equal(cache.nodes.find((node) => node.id === child.id)?.status, "hit");
  assert.equal(cache.nodes.find((node) => node.id === blur.id)?.status, "miss");
  assert.ok(cache.scenes.every((scene) => scene.status === "miss"));

  const respelled = compile(heldSource
    .replace('samples: 4, startEdge: "hold"', 'samples: 4,\n      // exact first edge\n      startEdge: "hold"'));
  assert.equal(respelled.buildId, held.buildId);
  assert.deepEqual(diffCutAVIR(held, respelled).changes, []);
});

test("MotionBlur cannot cross a composition boundary, while source-owned blur is independently preflighted", () => {
  const crossing = `cut 0.4;
project "cross composition shutter refusal";
import { MotionBlur, Precomp, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 8khz) {
  scene host(duration: 1s) { MotionBlur(shutterAngle: 180deg, samples: 4) { Precomp(source: insert); } }
}
timeline insert(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 8khz) {
  scene source(duration: 1s) { Rect(width: 8px, height: 8px, fill: #ef233c); }
}
export out = render(main);`;
  expectCompileCode(crossing, "CUT_MOTION_BLUR_PLAN", /cannot cross a Precomp\/NestedSequence composition boundary/);

  const sourceOwned = crossing.replace(
    "MotionBlur(shutterAngle: 180deg, samples: 4) { Precomp(source: insert); }",
    "Precomp(source: insert);",
  ).replace(
    "Rect(width: 8px, height: 8px, fill: #ef233c);",
    "MotionBlur(shutterAngle: 180deg, samples: 4) { Rect(width: 8px, height: 8px, fill: #ef233c); }",
  );
  const ir = compile(sourceOwned);
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const blur = motionBlurNode(ir);
  assert.ok(ir.compositions.find((composition) => composition.id === "insert")?.sceneIds.includes(blur.sceneId!));

  const nestedSourceOwned = sourceOwned
    .replace('import { MotionBlur, Precomp, Rect } from "cut:visual";', 'import { MotionBlur, Rect } from "cut:visual";\nimport { NestedSequence } from "@cut/edit";')
    .replace("Precomp(source: insert);", "NestedSequence(source: insert);");
  const nestedIr = compile(nestedSourceOwned);
  assert.doesNotThrow(() => validateReferenceSession(nestedIr));
  const nestedBlur = motionBlurNode(nestedIr);
  assert.ok(nestedIr.compositions.find((composition) => composition.id === "insert")?.sceneIds.includes(nestedBlur.sceneId!));

  // Loaded IR cannot exploit the AV child-domain boundary to bypass the
  // explicit temporal cross-composition refusal.
  const hostileBase = compile(crossing
    .replace('import { MotionBlur, Precomp, Rect } from "cut:visual";', 'import { MotionBlur, Rect } from "cut:visual";\nimport { NestedSequence } from "@cut/edit";')
    .replace(
      "MotionBlur(shutterAngle: 180deg, samples: 4) { Precomp(source: insert); }",
      "MotionBlur(shutterAngle: 180deg, samples: 4) { Rect(width: 8px, height: 8px, fill: #336699); } NestedSequence(source: insert);",
    ));
  const hostileCross = structuredClone(hostileBase), hostileBlur = motionBlurNode(hostileCross);
  const nested = Object.values(hostileCross.nodes).find((node) => node.op === "cut.edit.nested_sequence");
  assert.ok(nested);
  const [displacedChild] = hostileBlur.children;
  hostileBlur.children = [nested.id];
  nested.ownership = "child";
  delete hostileCross.nodes[displacedChild];
  const nestedOwner = nested.sceneId ? hostileCross.scenes[nested.sceneId] : undefined;
  assert.ok(nestedOwner);
  nestedOwner.items = nestedOwner.items.filter((item) => item.id !== nested.id);
  nestedOwner.rootAVIds = nestedOwner.rootAVIds.filter((id) => id !== nested.id);
  for (const composition of hostileCross.compositions) {
    composition.rootAVIds = composition.rootAVIds.filter((id) => id !== nested.id);
    composition.items = composition.items.filter((item) => item.kind !== "node" || item.id !== nested.id);
  }
  finalizeGraphHashes(hostileCross);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(hostileCross)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TYPE"
      && error.path.endsWith(".children[0]"),
    "the strict public loader must reject an AV child grafted into a visual-only MotionBlur",
  );
});

test("loaded IR cannot bypass closure, bounds, or source-located bounded JSON diagnostics", () => {
  const base = compile(program("MotionBlur(shutterAngle: 180deg, samples: 4) { Rect(width: 8px, height: 8px); }"));
  const mutate = (action: (node: IRNode) => void) => {
    const hostile = structuredClone(base), node = motionBlurNode(hostile);
    action(node); finalizeGraphHashes(hostile);
    const encoded = JSON.stringify(hostile);
    return { load: () => loadCutAvIr(encoded), nodeId: node.id };
  };
  const hostileName = `${"🧨\n".repeat(20_000)}secret-control`;
  const unknown = mutate((node) => { (node.inputs as Record<string, IRValue>)[hostileName] = { kind: "boolean", value: true }; });
  let captured: unknown;
  try { unknown.load(); } catch (error) { captured = error; }
  assert.ok(captured instanceof CutAvIrValidationError);
  assert.equal(captured.code, "CUT_IR_UNKNOWN_FIELD");
  const encoded = JSON.stringify(cutDiagnosticsFromError(captured));
  assert.ok(Buffer.byteLength(encoded) < 1_024, `diagnostic amplified to ${Buffer.byteLength(encoded)} bytes`);
  const diagnostic = JSON.parse(encoded)[0];
  assert.equal(diagnostic.code, "CUT_IR_UNKNOWN_FIELD");
  assert.match(encoded, /Unicode code points.*UTF-8 bytes.*sha256/);

  const badSamples = mutate((node) => {
    node.inputs.samples = { kind: "quantity", dimension: "scalar", magnitude: rational(33), unit: "scalar" };
  });
  expectRuntimeError(() => validateReferenceSession(badSamples.load()), "CUT_MOTION_BLUR_BUDGET", badSamples.nodeId);

  const wrongStartEdgeType = mutate((node) => {
    node.inputs.startEdge = { kind: "boolean", value: true };
  });
  assert.throws(
    wrongStartEdgeType.load,
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TYPE"
      && error.path.endsWith(".inputs.startEdge"),
  );

  const redundantStartEdge = mutate((node) => {
    node.inputs.startEdge = { kind: "string", value: "transparent" };
  });
  expectRuntimeError(() => validateReferenceSession(redundantStartEdge.load()), "CUT_MOTION_BLUR_NOOP", redundantStartEdge.nodeId);

  const phantomProperty = mutate((node) => {
    (node.properties as Record<string, IRValue>)["phantom"] = { kind: "boolean", value: true };
  });
  assert.throws(
    phantomProperty.load,
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_UNKNOWN_FIELD"
      && error.path.endsWith(".properties.phantom"),
  );
});

test("static shutter edits change semantic/build identity and invalidate only their wrapper ancestry", () => {
  const source = (angle: number) => program(`MotionBlur(shutterAngle: ${angle}deg, samples: 4) {
    Rect(width: 8px, height: 8px, fill: #336699);
  }`);
  const before = compile(source(180)), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = compile(source(360)), blur = motionBlurNode(after);
  const rect = Object.values(after.nodes).find((node) => node.op === "cut.visual.rect");
  assert.ok(rect);
  const plan = createIncrementalRenderPlan(after, "main", previous);
  assert.equal(plan.nodes.find((node) => node.id === rect.id)?.status, "hit", "unchanged child remains reusable");
  assert.equal(plan.nodes.find((node) => node.id === blur.id)?.status, "miss", "static shutter config owns wrapper identity");
  assert.ok(plan.scenes.every((scene) => scene.status === "miss"));
  assert.notEqual(motionBlurNode(before).contentHash, blur.contentHash);
  assert.notEqual(before.buildId, after.buildId);
});
