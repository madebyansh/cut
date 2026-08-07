import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { validateReferencePictureSession, validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) { return compileCutModule(moduleFor(source)).ir; }

function nodeByOp(ir: CutAVIR, op: string) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(node, `missing ${op}`);
  return node;
}

const audioTrackSource = `cut 0.4;
project "audio track";
import { AudioTrack, AudioGap } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  AudioTrack() {
    AudioGap(destination: 0s ..< 250ms);
    AudioClip(source: voice, range: 0s ..< 500ms, destination: 250ms ..< 750ms, fadeIn: 50ms, fadeOut: 50ms);
    AudioGap(destination: 750ms ..< 1s);
  }
}
export out = render(main);`;

test("AudioTrack lowers exact ordered source/destination metadata with semantic identity", () => {
  const ir = compile(audioTrackSource);
  const track = nodeByOp(ir, "cut.edit.audio_track");
  assert.equal(track.domain, "audio");
  assert.equal(track.editorial?.kind, "audio-track");
  if (track.editorial?.kind !== "audio-track") return;
  assert.deepEqual(track.editorial.items.map((item) => ({
    kind: item.kind,
    order: item.order,
    destination: item.destination,
    source: item.source,
    linkId: item.linkId,
  })), [
    { kind: "gap", order: 0, destination: { start: rational(0), duration: rational(1, 4) }, source: undefined, linkId: undefined },
    { kind: "audio", order: 1, destination: { start: rational(1, 4), duration: rational(1, 2) }, source: { start: rational(0), duration: rational(1, 2) }, linkId: undefined },
    { kind: "gap", order: 2, destination: { start: rational(3, 4), duration: rational(1, 4) }, source: undefined, linkId: undefined },
  ]);
  assert.deepEqual(track.children, track.editorial.items.map((item) => item.nodeId));
  assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));

  const reformatted = compile(audioTrackSource.replaceAll(";", ";\n"));
  assert.notEqual(reformatted.sourceHash, ir.sourceHash);
  assert.equal(reformatted.buildId, ir.buildId, "formatting must not change executable editorial identity");
});

test("AudioTrack source diagnostics close direct children, ranges, gaps, grids, fades, and Text's CUT2077 collision", () => {
  const program = (items: string, duration = "1s", imports = "") => `cut 0.4; project "audio diagnostics"; import { AudioTrack, AudioGap } from "@cut/edit"; import { AudioClip } from "@cut/audio"; ${imports} asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: ${duration}, fps: 24, sampleRate: 48khz) { AudioTrack() { ${items} } } export out = render(main);`;
  const diagnostics = (source: string) => checkCutModule(moduleFor(source)).diagnostics;
  const hasCode = (code: string) => (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === code && item.span.start.line === 1);

  assert.ok(diagnostics(program("AudioClip(source: voice); AudioGap(destination: 0s ..< 1s);")).some((item) => item.code === "CUT2079"));
  assert.ok(diagnostics(program("at 0s { AudioGap(destination: 0s ..< 1s); }")).some((item) => item.code === "CUT2070"));
  assert.ok(diagnostics(program("Tone(frequency: 440hz, duration: 1s);", "1s", 'import { Tone } from "@cut/audio";')).some((item) => item.code === "CUT2071"));
  assert.ok(diagnostics('cut 0.4; project "detached"; import { AudioGap } from "@cut/edit"; timeline main(duration: 1s, fps: 24) { AudioGap(destination: 0s ..< 1s); } export out = render(main);').some((item) => item.code === "CUT2072"));

  const text = moduleFor('cut 0.4; project "text code"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 1s, fps: 24) { Text(content: "x", font: face, tracking: 1px, letterSpacing: 1px); } export out = render(main);');
  assert.ok(checkCutModule(text).diagnostics.some((item) => item.code === "CUT2077" && /aliases/.test(item.message)));

  assert.throws(() => compile(program("AudioClip(source: voice, range: 0s .. 1s, destination: 0s ..< 1s);")), hasCode("CUT2075"));
  assert.throws(() => compile(program("AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s, fadeIn: 600ms, fadeOut: 600ms);")), hasCode("CUT2079"));
  assert.throws(() => compile(program("AudioGap(destination: 0s ..< 1ms); AudioGap(destination: 2ms ..< 1s);")), hasCode("CUT2074"));
  assert.throws(() => compile(program("AudioGap(destination: 0s ..< 0.01ms); AudioGap(destination: 0.01ms ..< 1s);", "1s")), hasCode("CUT2074"));
  assert.throws(() => compile(program("AudioClip(source: voice, range: 0s ..< 750ms, destination: 0s ..< 750ms); AudioClip(source: voice, range: 0s ..< 500ms, destination: 500ms ..< 1s); AudioClip(source: voice, range: 0s ..< 400ms, destination: 400ms ..< 800ms);")), hasCode("CUT2074"));
  assert.throws(() => compile(program("AudioClip(source: voice, range: 0s ..< 750ms, destination: 0s ..< 750ms); AudioGap(destination: 500ms ..< 1s);")), hasCode("CUT2074"));
  assert.throws(() => compile(program('AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s, link: " untrimmed ");')), hasCode("CUT2081"));
  assert.throws(() => compile(program('AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s, link: "orphan");')), hasCode("CUT2081"));
});

function fakeLock(ir: CutAVIR) {
  const decodedVideoCadence = {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: "phase-floor",
    phaseNumerator: "0",
    streamIndex: 0,
    firstPts: "0",
    lastPts: "11",
    quantizedEndPts: "12",
    frameCount: "12",
    durationPresentCount: "12",
    durationCoverage: "complete",
    recordsSha256: "0".repeat(64),
    timeBase: rational(1, 4),
    frameRate: rational(4),
  } as const;
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = resource.kind === "audio" ? {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [{ index: 0, type: "audio", sampleRate: 48_000 }] },
        selected: { audio: { streamIndex: 0, duration: rational(3), durationSource: "stream", timeBase: rational(1, 48_000) } },
      },
    } as never : {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [{ index: 0, type: "video", frameRate: rational(4), timeBase: rational(1, 4), start: rational(0), duration: rational(3), width: 64, height: 64 }] },
        selected: { video: {
          streamIndex: 0,
          duration: rational(3),
          durationSource: "decoded-video-cadence",
          timeBase: rational(1, 4),
          frameRate: rational(4),
          decodedVideoCadence,
        } },
      },
    } as never;
  }
  ir.determinism.semantic = "locked";
  return ir;
}

test("independent linked picture/audio destinations encode J/L timing as validated metadata without coupled trims", () => {
  const source = `cut 0.4;
project "independent linked edit";
import { Sequence, PictureTrack, PictureClip, Gap, AudioTrack, AudioGap } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 3s, fps: 4, sampleRate: 48khz) {
  scene only(duration: 3s) {
    Sequence(duration: 3s) { PictureTrack() {
      Gap(duration: 1s);
      PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "take-a");
      Gap(duration: 1s);
    } }
    AudioTrack() {
      AudioGap(destination: 0s ..< 500ms);
      AudioClip(source: voice, range: 0s ..< 2s, destination: 500ms ..< 2500ms, link: "take-a");
      AudioGap(destination: 2500ms ..< 3s);
    }
  }
}
export out = render(main);`;
  const ir = fakeLock(compile(source));
  const pictureTrack = nodeByOp(ir, "cut.edit.picture_track");
  const audioTrack = nodeByOp(ir, "cut.edit.audio_track");
  assert.equal(pictureTrack.editorial?.kind, "picture-track");
  assert.equal(audioTrack.editorial?.kind, "audio-track");
  if (pictureTrack.editorial?.kind !== "picture-track" || audioTrack.editorial?.kind !== "audio-track") return;
  const picture = pictureTrack.editorial.items.find((item) => item.kind === "picture")!;
  const audio = audioTrack.editorial.items.find((item) => item.kind === "audio")!;
  assert.equal(picture.linkId, "take-a");
  assert.equal(audio.linkId, "take-a");
  assert.deepEqual(picture.destination, { start: rational(1), duration: rational(1) });
  assert.deepEqual(audio.destination, { start: rational(1, 2), duration: rational(2) });
  assert.doesNotThrow(() => validateReferenceSession(ir));
  assert.doesNotThrow(
    () => validateReferencePictureSession(ir),
    "picture-only frame/contact validation must use the locked audio companion for cross-domain link cardinality without executing audio",
  );
});

test("editorial link identifiers are reusable in independent scene scopes", () => {
  const ir = fakeLock(compile(`cut 0.4;
project "scene scoped links";
import { Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 4, sampleRate: 48khz) {
  scene first(duration: 1s) {
    Sequence(duration: 1s) { PictureTrack() { PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "take"); } }
    AudioTrack() { AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s, link: "take"); }
  }
  scene second(duration: 1s) {
    Sequence(duration: 1s) { PictureTrack() { PictureClip(source: picture, range: 1s ..< 2s, duration: 1s, link: "take"); } }
    AudioTrack() { AudioClip(source: voice, range: 1s ..< 2s, destination: 0s ..< 1s, link: "take"); }
  }
}
export out = render(main);`));
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const links = Object.values(ir.nodes).flatMap((node) => node.editorial && (node.editorial.kind === "picture-track" || node.editorial.kind === "audio-track")
    ? node.editorial.items.flatMap((item) => item.linkId ?? [])
    : []);
  assert.deepEqual(links, ["take", "take", "take", "take"]);
});

test("editorial link diagnostics reject duplicate cardinality and cross-scene pairing", () => {
  const hasLinkCode = (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === "CUT2081");
  assert.throws(() => compile(`cut 0.4;
project "duplicate links";
import { Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 4, sampleRate: 48khz) {
  scene only(duration: 2s) {
    Sequence(duration: 2s) { PictureTrack() {
      PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "duplicate");
      PictureClip(source: picture, range: 1s ..< 2s, duration: 1s, link: "duplicate");
    } }
    AudioTrack() { AudioClip(source: voice, range: 0s ..< 2s, destination: 0s ..< 2s, link: "duplicate"); }
  }
}
export out = render(main);`), hasLinkCode);

  assert.throws(() => compile(`cut 0.4;
project "cross scene link";
import { Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 4, sampleRate: 48khz) {
  scene first(duration: 1s) {
    Sequence(duration: 1s) { PictureTrack() { PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "cross"); } }
    AudioTrack() { AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s); }
  }
  scene second(duration: 1s) {
    Sequence(duration: 1s) { PictureTrack() { PictureClip(source: picture, range: 1s ..< 2s, duration: 1s); } }
    AudioTrack() { AudioClip(source: voice, range: 1s ..< 2s, destination: 0s ..< 1s, link: "cross"); }
  }
}
export out = render(main);`), hasLinkCode);
});

test("linked picture and audio tracks execute exact independent overlapping L- and J-cut boundaries", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-track-"));
  const media = resolve(root, "media");
  await mkdir(media);
  const video = (name: string, color: string) => exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `color=c=${color}:s=64x64:r=4:d=1.25`, "-c:v", "ffv1", "-pix_fmt", "yuv420p",
    resolve(media, `${name}.mkv`),
  ]);
  await Promise.all([video("red", "red"), video("green", "lime"), video("blue", "blue")]);
  await Promise.all([
    writeFile(resolve(media, "a.wav"), monoPcm16Wave(48_000, Array.from({ length: 72_000 }, () => 24_000))),
    writeFile(resolve(media, "b.wav"), monoPcm16Wave(48_000, Array.from({ length: 72_000 }, () => -16_000))),
    writeFile(resolve(media, "c.wav"), monoPcm16Wave(48_000, Array.from({ length: 72_000 }, () => 6_000))),
  ]);

  const ir = compile(`cut 0.4;
project "executed linked edits";
import { Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset red: VideoAsset = video("media/red.mkv");
asset green: VideoAsset = video("media/green.mkv");
asset blue: VideoAsset = video("media/blue.mkv");
asset a: AudioAsset = audio("media/a.wav");
asset b: AudioAsset = audio("media/b.wav");
asset c: AudioAsset = audio("media/c.wav");
timeline main(duration: 3s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 3s) {
    Sequence(duration: 3s) { PictureTrack() {
      PictureClip(source: red, range: 0s ..< 1s, duration: 1s, link: "a");
      PictureClip(source: green, range: 0s ..< 1s, duration: 1s, link: "b");
      PictureClip(source: blue, range: 0s ..< 1s, duration: 1s, link: "c");
    } }
    AudioTrack() {
      AudioClip(source: a, range: 0s ..< 1250ms, destination: 0s ..< 1250ms, link: "a");
      AudioClip(source: b, range: 0s ..< 1s, destination: 1s ..< 2s, link: "b");
      AudioClip(source: c, range: 0s ..< 1250ms, destination: 1750ms ..< 3s, link: "c");
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir);

  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "visual-cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]];
    const center = async (frame: number) => {
      const surface = await renderer.sceneFrame(scene, frame);
      const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
      return [...surface.data.subarray(offset, offset + 4)];
    };
    const redBefore = await center(3);
    const greenAtCut = await center(4);
    const greenDuringJ = await center(7);
    const blueAtCut = await center(8);
    assert.ok(redBefore[0] > 180 && redBefore[1] < 70 && redBefore[2] < 70, JSON.stringify(redBefore));
    assert.ok(greenAtCut[1] > 180 && greenAtCut[0] < 70 && greenAtCut[2] < 70, JSON.stringify(greenAtCut));
    assert.ok(greenDuringJ[1] > 180 && greenDuringJ[0] < 70 && greenDuringJ[2] < 70, JSON.stringify(greenDuringJ));
    assert.ok(blueAtCut[2] > 180 && blueAtCut[0] < 70 && blueAtCut[1] < 70, JSON.stringify(blueAtCut));
  } finally {
    renderer.close();
  }

  const output = resolve(root, "linked.wav");
  await renderReferenceAudio(ir, composition, root, output);
  const pcm = pcm24Data(await readFile(output));
  assert.equal(pcm.frames, 144_000);
  const a = 24_000 / 32_768 * Math.SQRT1_2, b = -16_000 / 32_768 * Math.SQRT1_2, c = 6_000 / 32_768 * Math.SQRT1_2;
  const near = (frame: number, expected: number) => assert.ok(Math.abs(pcm.sample(frame) - expected) < .002, `sample ${frame}: ${pcm.sample(frame)} != ${expected}`);
  near(47_999, a);
  near(48_000, a + b); near(59_999, a + b);
  near(60_000, b); near(83_999, b);
  near(84_000, b + c); near(95_999, b + c);
  near(96_000, c); near(143_999, c);
});

test("loaded and hostile IR cannot forge audio-track order, links, gaps, or detached destination edits", () => {
  const canonical = compile(audioTrackSource);
  const emptyLink = JSON.parse(JSON.stringify(canonical)) as CutAVIR;
  const loaderTrack = nodeByOp(emptyLink, "cut.edit.audio_track");
  assert.equal(loaderTrack.editorial?.kind, "audio-track");
  if (loaderTrack.editorial?.kind !== "audio-track") return;
  loaderTrack.editorial.items[1].linkId = " ";
  assert.throws(() => validateCutAvIr(emptyLink), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_STRING" && error.path.endsWith(".linkId"));

  const reordered = fakeLock(JSON.parse(JSON.stringify(compile(audioTrackSource))) as CutAVIR);
  const track = nodeByOp(reordered, "cut.edit.audio_track");
  assert.equal(track.editorial?.kind, "audio-track");
  if (track.editorial?.kind !== "audio-track") return;
  track.editorial.items[1].destination.start = rational(3, 8);
  assert.throws(() => validateReferenceSession(reordered), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_EDIT_AUDIO_TRACK");
    assert.equal(diagnostic.source?.nodeId, track.id);
    assert.match(diagnostic.message, /destination/);
    return true;
  });

  const detached = fakeLock(compile('cut 0.4; project "hostile direct"; import { AudioClip } from "@cut/audio"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { AudioClip(source: voice, range: 0s ..< 1s); } export out = render(main);'));
  const clip = nodeByOp(detached, "cut.audio.clip");
  clip.inputs.destination = clip.inputs.range;
  assert.throws(() => validateReferenceSession(detached), (error) => cutDiagnosticsFromError(error)[0]?.code === "CUT_EDIT_AUDIO_CLIP");

  const offSourceGrid = fakeLock(compile('cut 0.4; project "off source grid"; import { AudioTrack } from "@cut/edit"; import { AudioClip } from "@cut/audio"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 1ms, fps: 24, sampleRate: 48khz) { AudioTrack() { AudioClip(source: voice, range: 0ms ..< 1ms, destination: 0ms ..< 1ms); } } export out = render(main);'));
  const offSourceClip = nodeByOp(offSourceGrid, "cut.audio.clip");
  const offSourceResource = Object.values(offSourceGrid.resources)[0];
  const probe = offSourceResource.metadata?.probe as { identity: { streams: Array<{ sampleRate?: number }> } };
  probe.identity.streams[0].sampleRate = 44_100;
  assert.throws(() => validateReferenceSession(offSourceGrid), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_AUDIO_SAMPLE_GRID");
    assert.equal(diagnostic.source?.nodeId, offSourceClip.id);
    return true;
  });
});

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function pcm24Data(buffer: Buffer) {
  let offset = 12, blockAlign = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { assert.equal(buffer.readUInt16LE(body + 2), 2); assert.equal(buffer.readUInt32LE(body + 4), 48_000); blockAlign = buffer.readUInt16LE(body + 12); assert.equal(buffer.readUInt16LE(body + 14), 24); }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.equal(blockAlign, 6);
  const sample = (frame: number, channel = 0) => {
    const position = frame * blockAlign + channel * 3;
    let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000;
    return value / 0x800000;
  };
  return { frames: data.length / blockAlign, sample };
}

test("AudioTrack renders exact PCM silence, clip boundaries, and sample-domain fades", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-track-"));
  await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48_000, Array.from({ length: 960 }, () => 16_384)));
  const source = `cut 0.4; project "pcm track"; import { AudioTrack, AudioGap } from "@cut/edit"; import { AudioClip } from "@cut/audio"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 20ms, fps: 24, sampleRate: 48khz) { AudioTrack() { AudioGap(destination: 0ms ..< 5ms); AudioClip(source: voice, range: 0ms ..< 10ms, destination: 5ms ..< 15ms, fadeIn: 2ms, fadeOut: 2ms); AudioGap(destination: 15ms ..< 20ms); } } export out = render(main);`;
  const ir = compile(source);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  assert.doesNotThrow(() => validateReferenceSession(ir));
  const output = resolve(root, "track.wav");
  await renderReferenceAudio(ir, ir.compositions[0], root, output);
  const pcm = pcm24Data(await readFile(output));
  assert.equal(pcm.frames, 960);
  for (let frame = 0; frame < 240; frame += 1) assert.equal(pcm.sample(frame), 0, `leading AudioGap leaked at sample ${frame}`);
  for (let frame = 720; frame < 960; frame += 1) assert.equal(pcm.sample(frame), 0, `trailing AudioGap leaked at sample ${frame}`);
  assert.equal(pcm.sample(240), 0, "fade-in begins at exact destination sample 240");
  assert.ok(Math.abs(pcm.sample(335)) > Math.abs(pcm.sample(241)) * 20, "fade-in must rise across exactly 96 samples");
  assert.ok(Math.abs(pcm.sample(624)) > Math.abs(pcm.sample(719)) * 20, "fade-out must fall across exactly 96 samples");
  assert.ok(Math.abs(pcm.sample(480)) > .1, "clip body must contain decoded source energy");
});
