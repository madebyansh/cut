import assert from "node:assert/strict";
import Ajv from "ajv";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { validateCutAvIr } from "../lib/language/ir-loader";
import {
  applyCutLock,
  createCutLock,
  CutMediaStreamSelectionError,
} from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { inspectCutIr } from "../lib/runtime/inspect";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source: string) {
  const parsedModule = parse(source), checked = checkCutModule(parsedModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(parsedModule).ir;
}

function videoProgram(asset: string) {
  return `cut 0.4;
project "public absolute stream selection";
import { Video } from "cut:visual";
${asset}
timeline main(duration: 500ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene proof(duration: 500ms) { Video(source: take); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

async function multiAv(path: string, desiredFirst: boolean, matchingPictureStreams = false) {
  const inputs = [
    "color=c=0xdc2f2f:s=64x64:r=4:d=0.5",
    "sine=frequency=440:sample_rate=48000:duration=0.5",
    `color=c=${matchingPictureStreams ? "0xdc2f2f" : "0x2457d6"}:s=64x64:r=4:d=0.5`,
    "anullsrc=r=48000:cl=mono:d=0.5",
  ];
  const desired = ["0:v:0", "1:a:0"], decoy = ["2:v:0", "3:a:0"];
  const maps = desiredFirst ? [...desired, ...decoy] : [...decoy, ...desired];
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    ...inputs.flatMap((input) => ["-f", "lavfi", "-i", input]),
    ...maps.flatMap((map) => ["-map", map]),
    "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le", path,
  ]);
}

async function fixture(matchingPictureStreams = false) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-media-stream-selection-"));
  await mkdir(resolve(root, "media"));
  await multiAv(resolve(root, "media", "master.mkv"), true, matchingPictureStreams);
  await multiAv(resolve(root, "media", "proxy.mkv"), false, matchingPictureStreams);
  return root;
}

function center(frame: { data: Buffer; width: number; height: number }) {
  const offset = ((Math.floor(frame.height / 2) * frame.width) + Math.floor(frame.width / 2)) * 4;
  return [...frame.data.subarray(offset, offset + 4)];
}

function maximumPcm24Sample(bytes: Buffer) {
  let offset = 12, blockAlign = 0; let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") blockAlign = bytes.readUInt16LE(body + 12);
    if (id === "data") { data = bytes.subarray(body, body + size); break; }
    offset = body + size + size % 2;
  }
  assert.equal(blockAlign, 6);
  let peak = 0;
  for (let position = 0; position + 2 < data.length; position += 3) {
    let value = data[position]! | data[position + 1]! << 8 | data[position + 2]! << 16;
    if (value & 0x800000) value -= 0x1000000;
    peak = Math.max(peak, Math.abs(value / 0x800000));
  }
  return peak;
}

test("asset stream-selector API is typed, canonical IR and rejects malformed/proxy-orphan selectors", () => {
  const source = videoProgram('asset take: VideoAsset = video("media/master.mkv", proxy: "media/proxy.mkv", videoStream: 0, audioStream: 1, proxyVideoStream: 2, proxyAudioStream: 3);');
  const ir = compile(source);
  assert.deepEqual(ir.resources.take.streamSelection, { video: 0, audio: 1 });
  assert.deepEqual(ir.resources.take.proxy, { locator: "media/proxy.mkv", streamSelection: { video: 2, audio: 3 } });

  const changed = compile(source.replace("videoStream: 0", "videoStream: 2"));
  const difference = diffCutAVIR(ir, changed);
  const resource = difference.changes.find((change) => change.entity === "resource" && change.id === "take");
  assert.ok(resource?.operation === "modify" && resource.fields.some((field) => field.path === "/streamSelection/video"), "semantic diff must expose the authored selector change");

  for (const [declaration, code] of [
    ['asset take: VideoAsset = video("media/master.mkv", videoStream: 1.5);', "CUT_MEDIA_STREAM_SELECTOR"],
    ['asset take: VideoAsset = video("media/master.mkv", videoStream: -1);', "CUT_MEDIA_STREAM_SELECTOR"],
    ['asset take: VideoAsset = video("media/master.mkv", videoStream: 9007199254740992);', "CUT_MEDIA_STREAM_SELECTOR"],
    ['asset take: VideoAsset = video("media/master.mkv", proxyVideoStream: 0);', "CUT_MEDIA_STREAM_PROXY"],
  ] as const) {
    const parsedModule = parse(videoProgram(declaration));
    assert.ok(checkCutModule(parsedModule).diagnostics.some((diagnostic) => diagnostic.code === code), `${declaration} must fail as ${code}`);
  }

  const audio = compile(`cut 0.4; project "audio selector"; asset voice: AudioAsset = audio("media/master.mkv", proxy: "media/proxy.mkv", stream: 1, proxyStream: 3); timeline main(duration: 500ms, fps: 4, sampleRate: 48khz) {} export out = render(main);`);
  assert.deepEqual(audio.resources.voice.streamSelection, { audio: 1 });
  assert.deepEqual(audio.resources.voice.proxy?.streamSelection, { audio: 3 });

  const resolved = compile(`cut 0.4; project "resolved selector"; const CHOICE: Number = 3; asset voice: AudioAsset = audio("media/master.mkv", stream: CHOICE); timeline main(duration: 500ms, fps: 4, sampleRate: 48khz) {} export out = render(main);`);
  assert.deepEqual(resolved.resources.voice.streamSelection, { audio: 3 });
  const invalidResolved = parse(`cut 0.4; project "invalid resolved selector"; const CHOICE: Number = 3 / 2; asset voice: AudioAsset = audio("media/master.mkv", stream: CHOICE); timeline main(duration: 500ms, fps: 4, sampleRate: 48khz) {} export out = render(main);`);
  assert.throws(
    () => compileCutModule(invalidResolved),
    (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT_MEDIA_STREAM_SELECTOR"),
  );
});

test("omitted ambiguous and explicit missing selectors fail closed with stable source-located diagnostics", { timeout: 120_000 }, async () => {
  const root = await fixture();
  const ambiguous = compile(videoProgram('asset take: VideoAsset = video("media/master.mkv");'));
  await assert.rejects(
    createCutLock(ambiguous, root),
    (error: unknown) => error instanceof CutMediaStreamSelectionError
      && error.code === "CUT_MEDIA_STREAM_AMBIGUOUS"
      && error.variant === "master"
      && error.mediaType === "video"
      && error.source.resourceId === "take"
      && /project\.cut:4:/u.test(error.message),
  );

  const missing = compile(videoProgram('asset take: VideoAsset = video("media/master.mkv", videoStream: 1);'));
  await assert.rejects(
    createCutLock(missing, root),
    (error: unknown) => error instanceof CutMediaStreamSelectionError
      && error.code === "CUT_MEDIA_STREAM_NOT_FOUND"
      && error.mediaType === "video"
      && /available absolute video indexes are 0, 2/u.test(error.message),
  );

  const ambiguousAudio = compile(`cut 0.4; project "ambiguous audio"; asset voice: AudioAsset = audio("media/master.mkv"); timeline main(duration: 500ms, fps: 4, sampleRate: 48khz) {} export out = render(main);`);
  await assert.rejects(
    createCutLock(ambiguousAudio, root),
    (error: unknown) => error instanceof CutMediaStreamSelectionError
      && error.code === "CUT_MEDIA_STREAM_AMBIGUOUS"
      && error.variant === "master"
      && error.mediaType === "audio",
  );

  const ambiguousProxy = compile(videoProgram('asset take: VideoAsset = video("media/master.mkv", proxy: "media/proxy.mkv", videoStream: 0);'));
  await assert.rejects(
    createCutLock(ambiguousProxy, root),
    (error: unknown) => error instanceof CutMediaStreamSelectionError
      && error.code === "CUT_MEDIA_STREAM_AMBIGUOUS"
      && error.variant === "proxy"
      && error.mediaType === "video",
  );
});

test("strict IR loader and public JSON Schema close the stream-selection shape", async () => {
  const canonical = compile(videoProgram('asset take: VideoAsset = video("media/master.mkv", proxy: "media/proxy.mkv", videoStream: 0, proxyVideoStream: 2);'));
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  assert.equal(validate(canonical), true, JSON.stringify(validate.errors));

  const hostile: CutAVIR[] = [];
  const mutate = (change: (value: CutAVIR) => void) => { const value = structuredClone(canonical); change(value); hostile.push(value); };
  mutate((value) => { value.resources.take.streamSelection = { video: -1 }; });
  mutate((value) => { value.resources.take.streamSelection = { video: 1.5 }; });
  mutate((value) => { value.resources.take.streamSelection = {}; });
  mutate((value) => { (value.resources.take.streamSelection as Record<string, unknown>).subtitle = 4; });
  mutate((value) => { value.resources.take.proxy!.streamSelection = {}; });
  mutate((value) => { (value.resources.take.proxy!.streamSelection as Record<string, unknown>).data = 1; });
  const audio = compile(`cut 0.4; project "hostile audio"; asset voice: AudioAsset = audio("media/master.mkv", stream: 1); timeline main(duration: 500ms, fps: 4, sampleRate: 48khz) {} export out = render(main);`);
  const hostileAudio = structuredClone(audio); hostileAudio.resources.voice.streamSelection = { video: 0, audio: 1 }; hostile.push(hostileAudio);

  for (const value of hostile) {
    assert.throws(() => validateCutAvIr(value), /CUT_IR_(?:TYPE|UNKNOWN_FIELD)/u);
    assert.equal(validate(value), false, "JSON Schema must reject the same hostile stream-selection structure");
  }
});

test("master/proxy indexes are independent, explicit incidental audio is locked, inspected and executed", { timeout: 180_000 }, async () => {
  const root = await fixture();
  const source = videoProgram('asset take: VideoAsset = video("media/master.mkv", proxy: "media/proxy.mkv", videoStream: 0, audioStream: 1, proxyVideoStream: 2, proxyAudioStream: 3);');
  const ir = compile(source), lock = await createCutLock(ir, root);
  const master = lock.resources.take.probe;
  const proxy = lock.resources.take.proxy?.probe;
  assert.equal(master.kind, "media");
  assert.equal(proxy?.kind, "media");
  if (master.kind !== "media" || proxy?.kind !== "media") throw new Error("expected media probes");
  assert.deepEqual({ video: master.selected.video?.streamIndex, audio: master.selected.audio?.streamIndex }, { video: 0, audio: 1 });
  assert.deepEqual({ video: proxy.selected.video?.streamIndex, audio: proxy.selected.audio?.streamIndex }, { video: 2, audio: 3 });
  assert.ok(master.selected.audio?.decodedAudioSamples, "an explicit VideoAsset audioStream must lock sound even for a picture-only Video consumer");

  await applyCutLock(ir, lock, root);
  const inspected = inspectCutIr(ir, "project.cut").resources.find((resource) => resource.id === "take") as {
    authoredStreamSelection?: unknown;
    proxy?: { authoredStreamSelection?: unknown };
    selectedMedia?: { master?: { video?: { streamIndex?: number }; audio?: { streamIndex?: number } }; proxy?: { video?: { streamIndex?: number }; audio?: { streamIndex?: number } } };
  };
  assert.deepEqual(inspected.authoredStreamSelection, { video: 0, audio: 1 });
  assert.deepEqual(inspected.proxy?.authoredStreamSelection, { video: 2, audio: 3 });
  assert.equal(inspected.selectedMedia?.master?.video?.streamIndex, 0);
  assert.equal(inspected.selectedMedia?.proxy?.audio?.streamIndex, 3);

  const selected = selectReferenceMediaProfile(ir, "proxy").ir;
  assert.deepEqual(selected.resources.take.streamSelection, { video: 2, audio: 3 }, "proxy execution identity must retain only the selected variant's authored indexes");
  const { composition } = validateReferenceSession(selected, "out"), scene = selected.scenes[composition.sceneIds[0]];
  const renderer = new ReferenceVisualRenderer(selected, composition, root, resolve(root, ".cut", "stream-selection-cache"));
  try {
    await renderer.prepare();
    const pixel = center(await renderer.sceneFrame(scene, 0));
    assert.ok(pixel[0] > pixel[2] + 80, `proxy execution must decode authored absolute video stream 2 (red), not default stream 0 (blue): ${pixel}`);
  } finally {
    await renderer.closeAndWait();
  }
});

test("AudioAsset public stream selector drives the actual decoder, not FFmpeg's first audio stream", { timeout: 120_000 }, async () => {
  const root = await fixture();
  const source = `cut 0.4;
project "public audio stream execution";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("media/master.mkv", stream: 1);
timeline main(duration: 500ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene proof(duration: 500ms) { AudioClip(source: voice, range: 0s ..< 500ms); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const ir = compile(source), lock = await createCutLock(ir, root);
  assert.equal(lock.resources.voice.probe.kind, "media");
  if (lock.resources.voice.probe.kind !== "media") throw new Error("expected media probe");
  assert.equal(lock.resources.voice.probe.selected.audio?.streamIndex, 1);
  await applyCutLock(ir, lock, root);
  const output = resolve(root, "selected-audio.wav");
  await renderReferenceAudio(ir, ir.compositions[0], root, output);
  assert.ok(maximumPcm24Sample(await readFile(output)) > 0.05, "selected absolute audio stream 1 must produce the sine; stream 3 is silence");
});

test("profile cache identity localizes selector edits to the affected master/proxy variant", { timeout: 180_000 }, async () => {
  const root = await fixture(true);
  const authored = (masterIndex: 0 | 2) => videoProgram(`asset take: VideoAsset = video("media/master.mkv", proxy: "media/proxy.mkv", videoStream: ${masterIndex}, proxyVideoStream: 2);`);
  const locked = async (masterIndex: 0 | 2) => {
    const ir = compile(authored(masterIndex)), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    return ir;
  };
  const before = await locked(0), after = await locked(2);
  const hash = (ir: CutAVIR) => Object.values(ir.nodes).find((node) => node.op === "cut.visual.video")?.contentHash;
  const beforeMaster = selectReferenceMediaProfile(before, "master").ir;
  const afterMaster = selectReferenceMediaProfile(after, "master").ir;
  const beforeProxy = selectReferenceMediaProfile(before, "proxy").ir;
  const afterProxy = selectReferenceMediaProfile(after, "proxy").ir;
  assert.notEqual(hash(beforeMaster), hash(afterMaster), "changing the selected master picture stream must invalidate master picture identity");
  assert.equal(hash(beforeProxy), hash(afterProxy), "an unchanged proxy file/selector must retain proxy picture identity across a master-only selector edit");
  assert.notEqual(beforeMaster.buildId, afterMaster.buildId);
  assert.equal(beforeProxy.buildId, afterProxy.buildId, "selected proxy build/cache identity must exclude the unselected master selector");
});
