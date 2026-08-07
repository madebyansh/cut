import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { validateReferencePictureTrackOperationPlan } from "../lib/runtime/reference/picture-edit-operations";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) { return compileCutModule(moduleFor(source)).ir; }

type ProgramOptions = {
  edits?: string | null;
  outgoing?: string;
  incoming?: string;
  body?: string;
  audio?: string;
  project?: string;
};

function program({
  edits = 'transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve")',
  outgoing = "range: 0s ..< 1s, duration: 1s, tailHandle: 500ms",
  incoming = "range: 500ms ..< 1500ms, duration: 1s, headHandle: 500ms",
  body,
  audio = "",
  project = "picture track transition",
}: ProgramOptions = {}) {
  const trackOpen = edits === null
    ? "PictureTrack() {"
    : `PictureTrack(sourceDuration: 2s, edits: [\n        ${edits}\n      ]) {`;
  return `cut 0.4;
project "${project}";
import { Sequence, PictureTrack, PictureClip, Gap, editClip, overwrite, split, transitionAt } from "@cut/edit";
import { Tone } from "@cut/audio";
asset outgoing: VideoAsset = video("media/outgoing.mkv");
asset incoming: VideoAsset = video("media/incoming.mkv");
timeline main(duration: 2s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    Sequence(duration: 2s) {
      ${trackOpen}
        ${body ?? `PictureClip(source: outgoing, ${outgoing});
        PictureClip(source: incoming, ${incoming});`}
      }
    }
    ${audio}
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function threeClipProgram(edits: string, availability = { handle: "500ms", start: "500ms", end: "1500ms" }) {
  return `cut 0.4;
project "multiple picture transitions";
import { Sequence, PictureTrack, PictureClip, transitionAt, split } from "@cut/edit";
asset first: VideoAsset = video("media/outgoing.mkv");
asset second: VideoAsset = video("media/incoming.mkv");
timeline main(duration: 3s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 3s) {
    Sequence(duration: 3s) {
      PictureTrack(sourceDuration: 3s, edits: [${edits}]) {
        PictureClip(source: first, range: 0s ..< 1s, duration: 1s, tailHandle: ${availability.handle});
        PictureClip(source: second, range: ${availability.start} ..< ${availability.end}, duration: 1s, headHandle: ${availability.handle}, tailHandle: ${availability.handle});
        PictureClip(source: first, range: ${availability.start} ..< ${availability.end}, duration: 1s, headHandle: ${availability.handle});
      }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function track(ir: CutAVIR) {
  const result = Object.values(ir.nodes).find((node) => node.op === "cut.edit.picture_track");
  assert.ok(result?.editorial?.kind === "picture-track");
  return result as IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "picture-track" }> };
}

function diagnostic(source: string) {
  try { compile(source); }
  catch (error) {
    assert.ok(error instanceof CutCompileError);
    return error.result.diagnostics.find((item) => item.code.startsWith("CUT209")) ?? error.result.diagnostics[0];
  }
  assert.fail("expected CUT compilation to fail");
}

test("transitionAt lowers to one closed typed centered overlap with exact consumed handles and unchanged duration", () => {
  const source = program(), ir = compile(source), pictureTrack = track(ir), transition = pictureTrack.editorial.transitions?.[0];
  assert.ok(transition);
  assert.deepEqual({
    cut: transition.cut,
    duration: transition.duration,
    overlap: transition.overlap,
    outgoingSource: transition.outgoingSource,
    incomingSource: transition.incomingSource,
    style: transition.style,
  }, {
    cut: rational(1),
    duration: rational(1),
    overlap: { start: rational(1, 2), duration: rational(1) },
    outgoingSource: { start: rational(1), duration: rational(1, 2) },
    incomingSource: { start: rational(0), duration: rational(1, 2) },
    style: { kind: "cross-dissolve" },
  });
  assert.deepEqual(pictureTrack.editorial.items.map((item) => item.destination), [
    { start: rational(0), duration: rational(1) },
    { start: rational(1), duration: rational(1) },
  ]);
  assert.equal(pictureTrack.interval.duration.numerator, "2");
  assert.equal(pictureTrack.children[0], transition.outgoingNodeId);
  assert.equal(pictureTrack.children[1], transition.incomingNodeId);
  assert.equal(pictureTrack.editorial.operationPlan?.operations[0].kind, "transition");
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
  const respelled = compile(source.replace("transitionAt", "// same executable transition\n        transitionAt"));
  assert.notEqual(ir.sourceHash, respelled.sourceHash);
  assert.equal(ir.buildId, respelled.buildId);
  assert.deepEqual(diffCutAVIR(ir, respelled).changes, []);

  const styles = [
    ['transitionAt(at: 1s, duration: 1s, kind: "dip", color: #a020f0)', { kind: "dip", color: "#a020f0" }],
    ['transitionAt(at: 1s, duration: 1s, kind: "wipe", direction: "right", softness: 25%)', { kind: "wipe", direction: "right", softness: rational(1, 4) }],
    ['transitionAt(at: 1s, duration: 1s, kind: "push", direction: "up")', { kind: "push", direction: "up" }],
    ['transitionAt(at: 1s, duration: 1s, kind: "slide", direction: "down")', { kind: "slide", direction: "down" }],
  ] as const;
  for (const [edit, expected] of styles) assert.deepEqual(track(compile(program({ edits: edit }))).editorial.transitions?.[0].style, expected);

  const viaOperand = compile(program({
    edits: `overwrite(range: 1s ..< 2s, item: editClip(source: incoming, range: 500ms ..< 1500ms, duration: 1s, headHandle: 500ms)),
        transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve")`,
    body: `PictureClip(source: outgoing, range: 0s ..< 1s, duration: 1s, tailHandle: 750ms);
        PictureClip(source: outgoing, range: 0s ..< 1s, duration: 1s);`,
  }));
  const viaOperandTrack = track(viaOperand);
  assert.equal(viaOperandTrack.editorial.operationPlan?.operations[0].kind, "overwrite");
  assert.equal(viaOperandTrack.editorial.transitions?.[0].incomingNodeId, viaOperandTrack.children[1]);
  assert.equal(viaOperand.nodes[viaOperandTrack.children[1]].inputs.headHandle?.kind, "quantity");

  const entirelyUnused = compile(program({ edits: null }));
  const moreEntirelyUnused = compile(program({ edits: null, outgoing: "range: 0s ..< 1s, duration: 1s, tailHandle: 750ms" }));
  assert.equal(entirelyUnused.buildId, moreEntirelyUnused.buildId, "unused media availability is not executable picture identity");
});

test("multiple non-overlapping transitions resolve after structural edits with unambiguous ownership", () => {
  const source = threeClipProgram(`
        transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve"),
        transitionAt(at: 2s, duration: 1s, kind: "wipe", direction: "left"),
        split(at: 250ms)
  `);
  const ir = compile(source), pictureTrack = track(ir), transitions = pictureTrack.editorial.transitions ?? [];
  assert.equal(transitions.length, 2);
  assert.deepEqual(transitions.map((item) => item.cut), [rational(1), rational(2)]);
  assert.deepEqual(transitions.map((item) => item.overlap), [
    { start: rational(1, 2), duration: rational(1) },
    { start: rational(3, 2), duration: rational(1) },
  ]);
  assert.equal(transitions[0].incomingNodeId, transitions[1].outgoingNodeId, "middle clip owns distinct head and tail handles");
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));

  const reordered = compile(source.replace(
    `transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve"),\n        transitionAt(at: 2s, duration: 1s, kind: "wipe", direction: "left"),\n        split(at: 250ms)`,
    `split(at: 250ms),\n        transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve"),\n        transitionAt(at: 2s, duration: 1s, kind: "wipe", direction: "left")`,
  ));
  const reorderedTrack = track(reordered);
  assert.deepEqual(
    reorderedTrack.editorial.transitions?.map(({ cut, duration, overlap, outgoingSource, incomingSource, style }) => ({ cut, duration, overlap, outgoingSource, incomingSource, style })),
    transitions.map(({ cut, duration, overlap, outgoingSource, incomingSource, style }) => ({ cut, duration, overlap, outgoingSource, incomingSource, style })),
    "transition declarations resolve against the same final structural timeline even when a structural edit appears later in source",
  );

  const overlapping = diagnostic(threeClipProgram(`
        transitionAt(at: 1s, duration: 1500ms, kind: "cross-dissolve"),
        transitionAt(at: 2s, duration: 1500ms, kind: "wipe", direction: "left")
  `, { handle: "750ms", start: "750ms", end: "1750ms" }));
  assert.equal(overlapping.code, "CUT2093");
  assert.match(overlapping.message, /overlap intersects/);

  const duplicate = diagnostic(threeClipProgram(`
        transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve"),
        transitionAt(at: 1s, duration: 1s, kind: "wipe", direction: "left")
  `));
  assert.equal(duplicate.code, "CUT2090");
  assert.match(duplicate.message, /duplicates/);
});

test("transitionAt rejects ambiguous cuts, unavailable handles, invalid frame spans, links, retimes, multiple ownership, and meaningless style controls", () => {
  const cases: Array<[string, string, RegExp]> = [
    [program({ outgoing: "range: 0s ..< 1s, duration: 1s, tailHandle: 250ms" }), "CUT2091", /tailHandle/],
    [program({ incoming: "range: 500ms ..< 1500ms, duration: 1s, headHandle: 250ms" }), "CUT2091", /headHandle/],
    [program({ edits: 'transitionAt(at: 1s, duration: 750ms, kind: "cross-dissolve")' }), "CUT2091", /even number/],
    [program({ edits: 'transitionAt(at: 1s, duration: 250ms, kind: "cross-dissolve")' }), "CUT2091", /at least two/],
    [program({ edits: 'transitionAt(at: 750ms, duration: 500ms, kind: "cross-dissolve")' }), "CUT2093", /inside a clip/],
    [program({ edits: 'transitionAt(at: 0s, duration: 500ms, kind: "cross-dissolve")' }), "CUT2093", /track-edge/],
    [program({ body: `PictureClip(source: outgoing, range: 0s ..< 1s, duration: 1s, tailHandle: 500ms);
        Gap(duration: 1s);` }), "CUT2093", /Gap/],
    [program({ outgoing: 'range: 0s ..< 1s, duration: 1s, tailHandle: 500ms, playback: "reverse"' }), "CUT2093", /forward 1x/],
    [program({ edits: `transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve"),
        transitionAt(at: 1s, duration: 1s, kind: "wipe")` }), "CUT2090", /duplicates/],
    [program({ edits: 'transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve", direction: "left")' }), "CUT2090", /not meaningful/],
    [program({ edits: 'transitionAt(at: 1s, duration: 1s, kind: "push", softness: 10%)' }), "CUT2090", /only for wipe/],
    [program({ outgoing: 'range: 0s ..< 1s, duration: 1s, tailHandle: 500ms, link: "take"' }), "CUT2093", /linked audio|do not yet couple/],
  ];
  for (const [source, code, message] of cases) {
    const result = diagnostic(source);
    assert.equal(result.code, code, JSON.stringify(result));
    assert.match(result.message, message);
    assert.ok(result.span.start.line >= 10 && result.span.start.line <= 13, JSON.stringify(result.span));
  }
});

async function makeFrameVideo(path: string, colors: string[]) {
  const directory = resolve(path, "frames");
  await mkdir(directory, { recursive: true });
  for (const [index, color] of colors.entries()) {
    await sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toFile(resolve(directory, `${index}.png`));
  }
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-framerate", "4", "-i", resolve(directory, "%d.png"), "-c:v", "ffv1", "-pix_fmt", "yuv444p", resolve(path, "source.mkv")]);
}

function center(surface: { data: Buffer; width: number; height: number }) {
  const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

test("PictureTrack transition renders actual head/tail frames, exact endpoints, all styles, and preserves sequence duration", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-track-transition-")), media = resolve(root, "media");
  await mkdir(media);
  const outgoingDirectory = resolve(root, "outgoing"), incomingDirectory = resolve(root, "incoming");
  await mkdir(outgoingDirectory); await mkdir(incomingDirectory);
  await makeFrameVideo(outgoingDirectory, ["#ff0000", "#ff0000", "#ff0000", "#ff0000", "#ffff00", "#ff00ff", "#00ffff", "#ffffff"]);
  await makeFrameVideo(incomingDirectory, ["#00ff00", "#80ff00", "#0000ff", "#0000ff", "#0000ff", "#0000ff", "#0000ff", "#0000ff"]);
  await copyFile(resolve(outgoingDirectory, "source.mkv"), resolve(media, "outgoing.mkv"));
  await copyFile(resolve(incomingDirectory, "source.mkv"), resolve(media, "incoming.mkv"));

  const render = async (edit: string, cache: string) => {
    const ir = compile(program({ edits: edit })), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir), renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, cache));
    await renderer.prepare();
    try {
      const scene = ir.scenes[composition.sceneIds[0]], pixels: number[][] = [], hashes: string[] = [];
      for (let frame = 0; frame < 8; frame += 1) {
        const surface = await renderer.sceneFrame(scene, frame);
        pixels.push(center(surface));
        hashes.push(createHash("sha256").update(surface.data).digest("hex"));
      }
      return { ir, pixels, hashes };
    } finally { renderer.close(); }
  };

  const dissolved = await render('transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve")', "cache-dissolve");
  assert.ok(dissolved.pixels[2][0] > 220 && dissolved.pixels[2][1] < 30 && dissolved.pixels[2][2] < 30, JSON.stringify(dissolved.pixels[2]));
  assert.ok(dissolved.pixels[3][1] > 50, `incoming head frame did not participate before the cut: ${JSON.stringify(dissolved.pixels[3])}`);
  assert.ok(dissolved.pixels[4][0] > 80 && dissolved.pixels[4][1] > 80 && dissolved.pixels[4][2] > 80, `yellow outgoing tail and blue incoming visible frame did not mix at the cut: ${JSON.stringify(dissolved.pixels[4])}`);
  assert.ok(dissolved.pixels[5][0] > 40 && dissolved.pixels[5][2] > 120, `second outgoing tail frame did not participate after the cut: ${JSON.stringify(dissolved.pixels[5])}`);
  assert.ok(dissolved.pixels[6][2] > 220 && dissolved.pixels[6][0] < 30, JSON.stringify(dissolved.pixels[6]));
  assert.equal(track(dissolved.ir).interval.duration.numerator, "2");

  const variants = [
    'transitionAt(at: 1s, duration: 1s, kind: "dip", color: #ffffff)',
    'transitionAt(at: 1s, duration: 1s, kind: "wipe", direction: "right", softness: 25%)',
    'transitionAt(at: 1s, duration: 1s, kind: "push", direction: "left")',
    'transitionAt(at: 1s, duration: 1s, kind: "slide", direction: "up")',
  ];
  const midpointFrames: string[] = [];
  for (const [index, edit] of variants.entries()) midpointFrames.push((await render(edit, `cache-${index}`)).hashes[4]);
  assert.equal(new Set(midpointFrames).size, variants.length, midpointFrames.join("\n"));

  const multiple = compile(threeClipProgram(`
    transitionAt(at: 1s, duration: 1s, kind: "cross-dissolve"),
    transitionAt(at: 2s, duration: 1s, kind: "wipe", direction: "right"),
    split(at: 250ms)
  `));
  const multipleLock = await createCutLock(multiple, root);
  await applyCutLock(multiple, multipleLock, root);
  const { composition: multipleComposition } = validateReferenceSession(multiple);
  const multipleRenderer = new ReferenceVisualRenderer(multiple, multipleComposition, root, resolve(root, "cache-multiple"));
  await multipleRenderer.prepare();
  try {
    const scene = multiple.scenes[multipleComposition.sceneIds[0]], hashes: string[] = [];
    for (let frame = 0; frame < 12; frame += 1) {
      const surface = await multipleRenderer.sceneFrame(scene, frame);
      hashes.push(createHash("sha256").update(surface.data).digest("hex"));
    }
    assert.equal(hashes.length, 12);
    assert.ok(new Set(hashes.slice(2, 6)).size > 1, "first transition must execute over real frames");
    assert.ok(new Set(hashes.slice(6, 10)).size > 1, "second transition must execute over real frames");
  } finally { multipleRenderer.close(); }
});

test("locked handle bounds, strict IR reconciliation, cache locality, semantic diff, and OTIO loss reporting fail closed", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-track-transition-contract-")), media = resolve(root, "media");
  await mkdir(media);
  await Promise.all(["outgoing", "incoming"].map((name) => exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=4:d=2", "-c:v", "ffv1", "-pix_fmt", "yuv444p", resolve(media, `${name}.mkv`)])));

  const ir = compile(program()), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  assert.doesNotThrow(() => validateReferenceSession(ir));

  const overrun = compile(program({ outgoing: "range: 0s ..< 1s, duration: 1s, tailHandle: 1250ms" }));
  await assert.rejects(createCutLock(overrun, root), /available media source range.*beyond|tailHandle.*beyond/);

  const offGrid = compile(program({ outgoing: "range: 0s ..< 1s, duration: 1s, tailHandle: 625ms" }));
  await assert.rejects(createCutLock(offGrid, root), /CUT_MEDIA_SOURCE_GRID.*available source end/);

  const unknown = JSON.parse(JSON.stringify(ir)) as CutAVIR, unknownTrack = track(unknown);
  assert.ok(unknownTrack.editorial.transitions);
  (unknownTrack.editorial.transitions[0].style as unknown as Record<string, unknown>).ignored = true;
  assert.throws(() => validateCutAvIr(unknown), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD" && error.path.endsWith(".ignored"));

  const hostile = structuredClone(ir), hostileTrack = track(hostile);
  assert.ok(hostileTrack.editorial.transitions);
  hostileTrack.editorial.transitions[0].outgoingSource.start = rational(3, 4);
  assert.throws(() => validateReferencePictureTrackOperationPlan(hostile, hostile.compositions[0], hostileTrack), /CUT_EDIT_OPERATION: materialized transition 0/);

  const extra = compile(program({
    outgoing: "range: 0s ..< 1s, duration: 1s, tailHandle: 750ms",
    incoming: "range: 750ms ..< 1750ms, duration: 1s, headHandle: 750ms",
  }));
  // Keep the same visible incoming range: only surplus availability may change.
  const identityBase = compile(program());
  const extraSameRange = compile(program({ outgoing: "range: 0s ..< 1s, duration: 1s, tailHandle: 750ms" }));
  assert.notEqual(identityBase.sourceHash, extraSameRange.sourceHash);
  assert.equal(identityBase.buildId, extraSameRange.buildId, "unused handle availability must not change executable render identity");
  const previous = createIncrementalRenderPlan(identityBase, "main").manifest;
  const extraPlan = createIncrementalRenderPlan(extraSameRange, "main", previous);
  assert.ok(extraPlan.nodes.every((node) => node.status === "hit"), JSON.stringify(extraPlan.nodes));
  assert.ok(extraPlan.scenes.every((scene) => scene.status === "hit"));
  assert.ok(diffCutAVIR(identityBase, extraSameRange).changes.some((change) => change.entity === "node"), "semantic diff must still expose the structural handle-availability change");
  assert.notEqual(extra.buildId, identityBase.buildId, "changing visible source selection remains executable identity");

  const incomingAvailabilityBase = compile(program({
    incoming: "range: 750ms ..< 1750ms, duration: 1s, headHandle: 500ms",
  }));
  const extraIncomingAvailability = compile(program({
    incoming: "range: 750ms ..< 1750ms, duration: 1s, headHandle: 750ms",
  }));
  assert.notEqual(incomingAvailabilityBase.sourceHash, extraIncomingAvailability.sourceHash);
  assert.equal(incomingAvailabilityBase.buildId, extraIncomingAvailability.buildId, "unused incoming head availability must not change executable render identity");
  const extraIncomingPlan = createIncrementalRenderPlan(
    extraIncomingAvailability,
    "main",
    createIncrementalRenderPlan(incomingAvailabilityBase, "main").manifest,
  );
  assert.ok(extraIncomingPlan.nodes.every((node) => node.status === "hit"), JSON.stringify(extraIncomingPlan.nodes));
  assert.ok(extraIncomingPlan.scenes.every((scene) => scene.status === "hit"));
  assert.ok(diffCutAVIR(incomingAvailabilityBase, extraIncomingAvailability).changes.some((change) => change.entity === "node"));

  const wipe = compile(program({ edits: 'transitionAt(at: 1s, duration: 1s, kind: "wipe", direction: "left")' }));
  const wipePlan = createIncrementalRenderPlan(wipe, "main", previous);
  const wipeTrack = track(wipe);
  assert.equal(wipePlan.nodes.find((node) => node.id === wipeTrack.id)?.status, "miss");
  assert.ok(wipeTrack.children.every((id) => wipePlan.nodes.find((node) => node.id === id)?.status === "hit"), JSON.stringify(wipePlan.nodes));
  assert.ok(wipePlan.scenes.every((scene) => scene.status === "miss"));

  const exported = exportCutTimelineToOtio(ir);
  assert.equal(exported.report.status, "lossless-editorial");
  assert.ok(exported.report.editorialProfile);
  const nativeTransition = exported.timeline.tracks.children
    .flatMap((track) => track.children)
    .find((item) => item.OTIO_SCHEMA === "Transition.1");
  assert.ok(nativeTransition && nativeTransition.OTIO_SCHEMA === "Transition.1");
  assert.equal(nativeTransition.transition_type, "SMPTE_Dissolve");
  assert.deepEqual(nativeTransition.in_offset, { OTIO_SCHEMA: "RationalTime.1", value: 1, rate: 2 });
  assert.deepEqual(nativeTransition.out_offset, { OTIO_SCHEMA: "RationalTime.1", value: 1, rate: 2 });
});
