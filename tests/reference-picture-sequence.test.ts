import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseCutLanguage } from "../lib/language/parser";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { rational } from "../lib/language/rational";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";

const exec = promisify(execFile);

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) { return compileCutModule(moduleFor(source)).ir; }

const threeBeatSource = `cut 0.4;
project "picture sequence";
import { Sequence, PictureTrack, PictureClip, Gap } from "@cut/edit";
asset red: VideoAsset = video("media/red.mkv");
asset blue: VideoAsset = video("media/blue.mkv");
timeline main(duration: 3s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 3s) {
    Sequence(duration: 3s) {
      PictureTrack() {
        PictureClip(source: red, range: 0s ..< 1s, duration: 1s);
        Gap(duration: 1s);
        PictureClip(source: blue, range: 0s ..< 1s, duration: 1s);
      }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;

function nodeByOp(ir: CutAVIR, op: string) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(node, `missing ${op}`);
  return node;
}

test("Sequence and PictureTrack lower explicit source/destination intervals and stable temporal order", () => {
  const ir = compile(threeBeatSource);
  const sequence = nodeByOp(ir, "cut.edit.sequence");
  const track = nodeByOp(ir, "cut.edit.picture_track");
  assert.equal(sequence.domain, "visual");
  assert.deepEqual(sequence.editorial, {
    kind: "sequence",
    tracks: [{ nodeId: track.id, order: 0, destination: { start: rational(0), duration: rational(3) } }],
  });
  assert.equal(track.editorial?.kind, "picture-track");
  if (track.editorial?.kind !== "picture-track") return;
  assert.deepEqual(track.editorial.items.map((item) => ({
    kind: item.kind,
    order: item.order,
    destination: item.destination,
    source: item.source,
  })), [
    { kind: "picture", order: 0, destination: { start: rational(0), duration: rational(1) }, source: { start: rational(0), duration: rational(1) } },
    { kind: "gap", order: 1, destination: { start: rational(1), duration: rational(1) }, source: undefined },
    { kind: "picture", order: 2, destination: { start: rational(2), duration: rational(1) }, source: { start: rational(0), duration: rational(1) } },
  ]);
  assert.deepEqual(track.children, track.editorial.items.map((item) => item.nodeId));
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));

  const reformatted = compile(threeBeatSource.replaceAll(";", ";\n"));
  assert.notEqual(ir.sourceHash, reformatted.sourceHash);
  assert.equal(ir.buildId, reformatted.buildId, "formatting must not change semantic graph identity");
});

test("picture editorial surface rejects ignored arguments, audio items, hidden control flow, and detached items", () => {
  const program = (body: string, imports = "") => `cut 0.4; project "diagnostics"; import { Sequence, PictureTrack, PictureClip, Gap } from "@cut/edit"; ${imports} asset source: VideoAsset = video("media/source.mkv"); timeline main(duration: 2s, fps: 4) { scene only(duration: 2s) { ${body} } } export out = render(main);`;
  const diagnostics = (source: string) => checkCutModule(moduleFor(source)).diagnostics;
  assert.ok(diagnostics(program("Sequence(duration: 2s) { PictureTrack() { Gap(duration: 2s, mystery: 1); } }")).some((item) => item.code === "CUT2059"));
  assert.ok(diagnostics(program("Sequence(duration: 2s) { PictureTrack() { Tone(frequency: 440hz, duration: 2s); } }", 'import { Tone } from "@cut/audio";')).some((item) => item.code === "CUT2071"));
  assert.ok(diagnostics(program("Gap(duration: 2s);")).some((item) => item.code === "CUT2072"));
  assert.ok(diagnostics(program("Sequence(duration: 2s) { PictureTrack() { at 1s { Gap(duration: 1s); } } }")).some((item) => item.code === "CUT2070"));
  assert.ok(diagnostics(program('Sequence(duration: "two") { PictureTrack() { Gap(duration: 2s); } }')).some((item) => item.code === "CUT2029"));

  const badNoise = 'cut 0.4; project "closed noise"; import { Noise } from "@cut/audio"; timeline main(duration: 1s, fps: 4) { scene only(duration: 1s) { Noise(duration: 1s, color: "chartreuse"); } } export out = render(main);';
  assert.ok(diagnostics(badNoise).some((item) => item.code === "CUT2068"));
});

test("picture editorial compiler reports stable source-located interval failures", () => {
  const program = (items: string, duration = "2s") => `cut 0.4; project "bounds"; import { Sequence, PictureTrack, PictureClip, Gap } from "@cut/edit"; asset source: VideoAsset = video("media/source.mkv"); timeline main(duration: ${duration}, fps: 4) { scene only(duration: ${duration}) { Sequence(duration: ${duration}) { PictureTrack() { ${items} } } } } export out = render(main);`;
  const hasCode = (code: string) => (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === code && item.span.start.line === 1);
  assert.throws(() => compile(program("Gap(duration: 1s);")), hasCode("CUT2074"));
  assert.throws(() => compile(program("PictureClip(source: source, range: 0s ..< 1s, duration: 2s);")), hasCode("CUT2075"));
  assert.throws(() => compile(program("PictureClip(source: source, range: 0s .. 2s, duration: 2s);")), hasCode("CUT2075"));
  assert.throws(() => compile(program("PictureClip(source: source, range: 0s ..< 300ms, duration: 300ms); Gap(duration: 700ms);", "1s")), hasCode("CUT2074"));
});

function fakeLockPictureResources(ir: CutAVIR, frameRate = rational(4)) {
  const decodedVideoCadence = {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: "phase-floor",
    phaseNumerator: "0",
    streamIndex: 0,
    firstPts: "0",
    lastPts: "39",
    quantizedEndPts: "40",
    frameCount: "40",
    durationPresentCount: "40",
    durationCoverage: "complete",
    recordsSha256: "0".repeat(64),
    timeBase: rational(1, 4),
    frameRate,
  } as const;
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [{ index: 0, type: "video", frameRate, timeBase: rational(1, 4), start: rational(0), duration: rational(10), width: 64, height: 64 }] },
        selected: { video: {
          streamIndex: 0,
          duration: rational(10),
          durationSource: "decoded-video-cadence",
          timeBase: rational(1, 4),
          frameRate,
          decodedVideoCadence,
        } },
      },
    } as never;
  }
  ir.determinism.semantic = "locked";
  return ir;
}

test("IR and reference validation reject tampered picture order, ranges, and metadata with stable codes", () => {
  const unknown = JSON.parse(JSON.stringify(compile(threeBeatSource))) as CutAVIR;
  const sequence = nodeByOp(unknown, "cut.edit.sequence");
  assert.equal(sequence.editorial?.kind, "sequence");
  if (sequence.editorial?.kind !== "sequence") return;
  (sequence.editorial.tracks[0].destination as unknown as Record<string, unknown>).ignored = true;
  assert.throws(() => validateCutAvIr(unknown), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD" && error.path.endsWith(".ignored"));

  const reordered = fakeLockPictureResources(compile(threeBeatSource));
  const track = nodeByOp(reordered, "cut.edit.picture_track");
  assert.equal(track.editorial?.kind, "picture-track");
  if (track.editorial?.kind !== "picture-track") return;
  track.editorial.items[1].destination.start = rational(5, 4);
  assert.throws(() => validateReferenceSession(reordered), (error) => {
    assert.match(String(error), /CUT_EDIT_TRACK:.*contiguous.*project\.cut:/);
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_EDIT_TRACK");
    assert.deepEqual(diagnostic.source, { module: "project.cut", line: 9, column: 7, nodeId: track.id });
    return true;
  });

  const sourceMetadata = fakeLockPictureResources(compile(threeBeatSource));
  const sourceTrack = nodeByOp(sourceMetadata, "cut.edit.picture_track");
  assert.equal(sourceTrack.editorial?.kind, "picture-track");
  if (sourceTrack.editorial?.kind !== "picture-track" || !sourceTrack.editorial.items[0].source) return;
  sourceTrack.editorial.items[0].source.start = rational(1, 4);
  assert.throws(() => validateReferenceSession(sourceMetadata), /CUT_EDIT_TRACK:.*source metadata.*project\.cut:/);

  const offSourceFrame = fakeLockPictureResources(compile(`cut 0.4; project "source frames"; import { Sequence, PictureTrack, PictureClip } from "@cut/edit"; asset source: VideoAsset = video("media/source.mkv"); timeline main(duration: 1s, fps: 4) { scene only(duration: 1s) { Sequence(duration: 1s) { PictureTrack() { PictureClip(source: source, range: 125ms ..< 1125ms, duration: 1s); } } } } export out = render(main);`));
  assert.throws(() => validateReferenceSession(offSourceFrame), /CUT_EDIT_PICTURE_CLIP: source-range start.*locked source stream's 4\/1 fps.*project\.cut:/);
});

function layerSource(first: "red" | "blue", second: "red" | "blue") {
  return `cut 0.4; project "track order"; import { Sequence, PictureTrack, PictureClip } from "@cut/edit"; asset red: VideoAsset = video("media/red.mkv"); asset blue: VideoAsset = video("media/blue.mkv"); timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) { scene only(duration: 1s) { Sequence(duration: 1s) { PictureTrack() { PictureClip(source: ${first}, range: 0s ..< 1s, duration: 1s); } PictureTrack() { PictureClip(source: ${second}, range: 0s ..< 1s, duration: 1s, opacity: 25%); } } } } export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

test("PictureTrack executes Gap boundaries and Sequence composites tracks bottom-to-top", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-sequence-"));
  const media = resolve(root, "media");
  await mkdir(media);
  const generate = (name: string) => exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${name}:s=64x64:r=4:d=1`, "-c:v", "ffv1", "-pix_fmt", "yuv420p", resolve(media, `${name}.mkv`)]);
  await Promise.all([generate("red"), generate("blue")]);

  const offSourceFrame = compile('cut 0.4; project "locked source frames"; import { Sequence, PictureTrack, PictureClip } from "@cut/edit"; asset source: VideoAsset = video("media/red.mkv"); timeline main(duration: 750ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) { scene only(duration: 750ms) { Sequence(duration: 750ms) { PictureTrack() { PictureClip(source: source, range: 125ms ..< 875ms, duration: 750ms); } } } } export out = render(main, width: 64px, height: 64px, codec: "h264");');
  const offSourceLock = await createCutLock(offSourceFrame, root);
  await applyCutLock(offSourceFrame, offSourceLock, root);
  assert.throws(() => validateReferenceSession(offSourceFrame), /CUT_EDIT_PICTURE_CLIP: source-range start.*locked source stream's 4\/1 fps.*project\.cut:/);

  const lockAndRenderer = async (source: string, cache: string) => {
    const ir = compile(source);
    const lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir);
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, cache));
    await renderer.prepare();
    return { ir, composition, renderer };
  };
  const center = (surface: { data: Buffer; width: number; height: number }) => {
    const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
    return [...surface.data.subarray(offset, offset + 4)];
  };

  const beats = await lockAndRenderer(threeBeatSource, "cache-beats");
  try {
    const scene = beats.ir.scenes[beats.composition.sceneIds[0]];
    const pixels: number[][] = [];
    for (const frame of [0, 3, 4, 7, 8, 11]) pixels.push(center(await beats.renderer.sceneFrame(scene, frame)));
    for (const red of pixels.slice(0, 2)) assert.ok(red[0] > 180 && red[2] < 60, JSON.stringify(red));
    for (const gap of pixels.slice(2, 4)) assert.deepEqual(gap, [5, 11, 16, 255]);
    for (const blue of pixels.slice(4)) assert.ok(blue[2] > 180 && blue[0] < 60, JSON.stringify(blue));
  } finally { beats.renderer.close(); }

  const redThenBlue = await lockAndRenderer(layerSource("red", "blue"), "cache-red-blue");
  const blueThenRed = await lockAndRenderer(layerSource("blue", "red"), "cache-blue-red");
  try {
    const first = center(await redThenBlue.renderer.sceneFrame(redThenBlue.ir.scenes[redThenBlue.composition.sceneIds[0]], 0));
    const second = center(await blueThenRed.renderer.sceneFrame(blueThenRed.ir.scenes[blueThenRed.composition.sceneIds[0]], 0));
    assert.ok(first[0] > first[2] * 2, JSON.stringify(first));
    assert.ok(second[2] > second[0] * 2, JSON.stringify(second));
  } finally { redThenBlue.renderer.close(); blueThenRed.renderer.close(); }
});
