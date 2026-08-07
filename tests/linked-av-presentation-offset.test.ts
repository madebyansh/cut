import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import {
  applyCutLock,
  applyCutLockForVerifiedInputSession,
  createCutLock,
  CutProxyMediaError,
  type CutLockfile,
  type LockedResourceProbe,
} from "../lib/language/lock";
import { CutMediaPresentationPlanError } from "../lib/language/media-presentation";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { inspectCutIr } from "../lib/runtime/inspect";
import { renderReferenceAudio, referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
} from "../lib/runtime/reference/audio-cache";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import { renderReferenceIr } from "../lib/runtime/reference/render";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

async function generateAv(
  path: string,
  options: {
    videoStart: number;
    audioStart: number;
    videoDuration?: number;
    audioDuration?: number;
    color?: string;
    frequency?: number;
    constant?: number;
    audioSampleRate?: number;
  },
) {
  const videoDuration = options.videoDuration ?? 1, audioDuration = options.audioDuration ?? 1, audioSampleRate = options.audioSampleRate ?? 48_000;
  const audioSource = options.constant === undefined
    ? `sine=frequency=${options.frequency ?? 440}:sample_rate=${audioSampleRate}:duration=${audioDuration}`
    : `aevalsrc=${options.constant}:s=${audioSampleRate}:d=${audioDuration}`;
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-copyts",
    "-itsoffset", String(options.videoStart), "-f", "lavfi", "-i", `color=c=${options.color ?? "blue"}:s=64x64:r=4:d=${videoDuration}`,
    "-itsoffset", String(options.audioStart), "-f", "lavfi", "-i", audioSource,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le", path,
  ]);
}

type LinkedSourceOptions = {
  master: string;
  proxy?: string;
  duration?: string;
  rangeStart?: string;
  rangeEnd?: string;
  sampleRate?: string;
  clipOptions?: string;
  project?: string;
};

function linkedSource(options: LinkedSourceOptions) {
  const duration = options.duration ?? "1s", rangeStart = options.rangeStart ?? "0s", rangeEnd = options.rangeEnd ?? duration;
  return `cut 0.4;
project "${options.project ?? "linked presentation execution"}";
import { Clip } from "@cut/edit";
asset take: VideoAsset = video("media/${options.master}"${options.proxy ? `, proxy: "media/${options.proxy}"` : ""});
timeline main(duration: ${duration}, fps: 4, width: 64px, height: 64px, sampleRate: ${options.sampleRate ?? "48khz"}) {
  scene only(duration: ${duration}) {
    Clip(source: take, range: ${rangeStart} ..< ${rangeEnd}, duration: ${duration}${options.clipOptions ? `, ${options.clipOptions}` : ""});
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function transitionSource() {
  return `cut 0.4;
project "offset children through a public transition";
import { Clip, Transition } from "@cut/edit";
asset outgoing: VideoAsset = video("media/outgoing.mkv");
asset incoming: VideoAsset = video("media/incoming.mkv");
timeline main(duration: 1500ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1500ms) {
    Transition(kind: "cross-dissolve", duration: 500ms) {
      at 0s { Clip(source: outgoing, range: 0s ..< 1s, duration: 1s); }
      at 500ms { Clip(source: incoming, range: 0s ..< 1s, duration: 1s); }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function audioSource(name: string) {
  return `cut 0.4;
project "standalone audio presentation";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("media/${name}");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  AudioClip(source: voice, range: 0s ..< 1s);
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function mediaProbe(lock: CutLockfile, id: string) {
  const probe = lock.resources[id].probe;
  assert.equal(probe.kind, "media");
  return probe as Extract<LockedResourceProbe, { kind: "media" }>;
}

function pcm24Data(bytes: Buffer) {
  let cursor = 12, blockAlign = 0, dataOffset = -1, dataBytes = 0;
  while (cursor + 8 <= bytes.length) {
    const id = bytes.toString("ascii", cursor, cursor + 4), size = bytes.readUInt32LE(cursor + 4), body = cursor + 8;
    if (id === "fmt ") blockAlign = bytes.readUInt16LE(body + 12);
    if (id === "data") { dataOffset = body; dataBytes = size; break; }
    cursor = body + size + size % 2;
  }
  assert.equal(blockAlign, 6); assert.ok(dataOffset >= 0); assert.equal(dataBytes % blockAlign, 0);
  return {
    frames: dataBytes / blockAlign,
    sample(frame: number, channel = 0) {
      assert.ok(frame >= 0 && frame < dataBytes / blockAlign);
      const offset = dataOffset + frame * blockAlign + channel * 3;
      let value = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

type LinkedPresentationInspection = {
  variant: "master" | "proxy";
  delta: { numerator: string; denominator: string };
  media: unknown | null;
  samples: {
    leadingSilenceDestinationSamples: string;
    mediaDestinationSamples: string;
    trailingSilenceDestinationSamples: string;
    decoderSourceStartSamples: string | null;
    decoderSourceEndSamples: string | null;
  };
};

function inspectedPlans(ir: CutAVIR, source: string) {
  const report = inspectCutIr(ir, source) as { graph: { nodes: Array<{
    op: string;
    linkedAvPresentation?: LinkedPresentationInspection;
    linkedAvAudioExecution?: { decoderInput: unknown | null };
  }> } };
  return report.graph.nodes.filter((node) => node.op === "cut.edit.clip").map((node) => {
    assert.ok(node.linkedAvPresentation);
    return node.linkedAvPresentation;
  });
}

function inspectedAudioExecutions(ir: CutAVIR, source: string) {
  const report = inspectCutIr(ir, source) as { graph: { nodes: Array<{
    op: string;
    linkedAvAudioExecution?: { decoderInput: unknown | null };
  }> } };
  return report.graph.nodes.filter((node) => node.op === "cut.edit.clip").map((node) => {
    assert.ok(node.linkedAvAudioExecution);
    return node.linkedAvAudioExecution;
  });
}

function near(value: number, expected: number, tolerance = .002) {
  assert.ok(Math.abs(value - expected) <= tolerance, `${value} is not within ${tolerance} of ${expected}`);
}

test("positive linked A/V offset keeps the full picture interval and inserts exact leading silence", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-positive-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "positive.mkv"), { videoStart: 0, audioStart: .25, videoDuration: 1.25, audioDuration: 1, constant: .25 });
  const source = linkedSource({ master: "positive.mkv", duration: "1250ms", rangeEnd: "1250ms" });
  const ir = compile(source), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), [plan] = inspectedPlans(ir, source);
  assert.deepEqual(plan.delta, { numerator: "1", denominator: "4" });
  assert.deepEqual(plan.samples, {
    sourceSampleRate: 48_000,
    destinationSampleRate: 48_000,
    deltaSourceSamples: "12000",
    deltaDestinationSamples: "12000",
    pictureDurationDestinationSamples: "60000",
    leadingSilenceDestinationSamples: "12000",
    mediaDestinationSamples: "48000",
    trailingSilenceDestinationSamples: "0",
    decoderSourceStartSamples: "0",
    decoderSourceEndSamples: "48000",
  });

  const output = resolve(root, "positive.wav"); await renderReferenceAudio(ir, composition, root, output);
  const pcm = pcm24Data(await readFile(output)); assert.equal(pcm.frames, 60_000);
  assert.equal(pcm.sample(0), 0); assert.equal(pcm.sample(11_999), 0);
  near(pcm.sample(12_000), .25 / Math.SQRT2); near(pcm.sample(59_999), .25 / Math.SQRT2);

  const privateIr = compile(source); await applyCutLockForVerifiedInputSession(privateIr, lock, root);
  assert.deepEqual(inspectedPlans(privateIr, source), [plan], "private verified-input application derives the same public plan");
  const replay = compile(source); await applyCutLock(replay, lock, root);
  assert.deepEqual(diffCutAVIR(ir, replay).changes, []);

  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version CUT linked-offset test\nconfiguration: fixture");
  const cache = createReferenceAudioCachePlan(ir, composition, referenceMasterAudioRootIds(ir, composition), toolchain);
  assert.match(cache.graph.sha256, /^[a-f0-9]{64}$/u);
});

test("negative linked A/V offset trims decoder-local audio and inserts exact trailing silence", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-negative-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "negative.mkv"), { videoStart: .25, audioStart: 0, constant: .25 });
  const source = linkedSource({ master: "negative.mkv" }), ir = compile(source), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), [plan] = inspectedPlans(ir, source);
  assert.deepEqual(plan.delta, { numerator: "-1", denominator: "4" });
  assert.deepEqual(plan.samples, {
    sourceSampleRate: 48_000,
    destinationSampleRate: 48_000,
    deltaSourceSamples: "-12000",
    deltaDestinationSamples: "-12000",
    pictureDurationDestinationSamples: "48000",
    leadingSilenceDestinationSamples: "0",
    mediaDestinationSamples: "36000",
    trailingSilenceDestinationSamples: "12000",
    decoderSourceStartSamples: "12000",
    decoderSourceEndSamples: "48000",
  });
  const output = resolve(root, "negative.wav"); await renderReferenceAudio(ir, composition, root, output);
  const pcm = pcm24Data(await readFile(output)); assert.equal(pcm.frames, 48_000);
  near(pcm.sample(0), .25 / Math.SQRT2); near(pcm.sample(35_999), .25 / Math.SQRT2);
  assert.equal(pcm.sample(36_000), 0); assert.equal(pcm.sample(47_999), 0);
});

test("mixed-rate offset intersection closes exactly after 44.1kHz to 48kHz resampling", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-mixed-rate-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "mixed.mkv"), { videoStart: 0, audioStart: .1, audioSampleRate: 44_100, constant: .25 });
  const source = linkedSource({ master: "mixed.mkv" }), ir = compile(source), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), [plan] = inspectedPlans(ir, source);
  assert.deepEqual(plan.samples, {
    sourceSampleRate: 44_100,
    destinationSampleRate: 48_000,
    deltaSourceSamples: "4410",
    deltaDestinationSamples: "4800",
    pictureDurationDestinationSamples: "48000",
    leadingSilenceDestinationSamples: "4800",
    mediaDestinationSamples: "43200",
    trailingSilenceDestinationSamples: "0",
    decoderSourceStartSamples: "0",
    decoderSourceEndSamples: "39690",
  });
  const output = resolve(root, "mixed.wav"); await renderReferenceAudio(ir, composition, root, output);
  const pcm = pcm24Data(await readFile(output)); assert.equal(pcm.frames, 48_000);
  assert.equal(pcm.sample(4_799), 0);
  near(pcm.sample(4_800), .25 / Math.SQRT2, .004);
  near(pcm.sample(47_999), .25 / Math.SQRT2, .004);
});

test("trimmed partial overlap and no-overlap execute as exact media plus silence", { timeout: 240_000 }, async () => {
  const partialRoot = await mkdtemp(resolve(tmpdir(), "cut-linked-av-partial-")), partialMedia = resolve(partialRoot, "media"); await mkdir(partialMedia);
  await generateAv(resolve(partialMedia, "partial.mkv"), { videoStart: 0, audioStart: .75, videoDuration: 1.25, audioDuration: .5, constant: .25 });
  const partialSource = linkedSource({ master: "partial.mkv", duration: "750ms", rangeStart: "500ms", rangeEnd: "1250ms" });
  const partialIr = compile(partialSource), partialLock = await createCutLock(partialIr, partialRoot); await applyCutLock(partialIr, partialLock, partialRoot);
  const { composition: partialComposition } = validateReferenceSession(partialIr), [partialPlan] = inspectedPlans(partialIr, partialSource);
  assert.deepEqual(partialPlan.samples, {
    sourceSampleRate: 48_000,
    destinationSampleRate: 48_000,
    deltaSourceSamples: "36000",
    deltaDestinationSamples: "36000",
    pictureDurationDestinationSamples: "36000",
    leadingSilenceDestinationSamples: "12000",
    mediaDestinationSamples: "24000",
    trailingSilenceDestinationSamples: "0",
    decoderSourceStartSamples: "0",
    decoderSourceEndSamples: "24000",
  });
  const partialOutput = resolve(partialRoot, "partial.wav"); await renderReferenceAudio(partialIr, partialComposition, partialRoot, partialOutput);
  const partialPcm = pcm24Data(await readFile(partialOutput)); assert.equal(partialPcm.frames, 36_000);
  assert.equal(partialPcm.sample(11_999), 0); near(partialPcm.sample(12_000), .25 / Math.SQRT2); near(partialPcm.sample(35_999), .25 / Math.SQRT2);

  const silentRoot = await mkdtemp(resolve(tmpdir(), "cut-linked-av-silent-")), silentMedia = resolve(silentRoot, "media"); await mkdir(silentMedia);
  await generateAv(resolve(silentMedia, "future.mkv"), { videoStart: 0, audioStart: 2, constant: .25 });
  const silentSource = linkedSource({ master: "future.mkv" }), silentIr = compile(silentSource), silentLock = await createCutLock(silentIr, silentRoot);
  await applyCutLock(silentIr, silentLock, silentRoot);
  const { composition: silentComposition } = validateReferenceSession(silentIr), [silentPlan] = inspectedPlans(silentIr, silentSource);
  assert.equal(silentPlan.media, null);
  assert.equal(inspectedAudioExecutions(silentIr, silentSource)[0].decoderInput, null, "the execution plan opens no decoder for all-silence coverage");
  assert.deepEqual(silentPlan.samples, {
    sourceSampleRate: 48_000,
    destinationSampleRate: 48_000,
    deltaSourceSamples: "96000",
    deltaDestinationSamples: "96000",
    pictureDurationDestinationSamples: "48000",
    leadingSilenceDestinationSamples: "48000",
    mediaDestinationSamples: "0",
    trailingSilenceDestinationSamples: "0",
    decoderSourceStartSamples: null,
    decoderSourceEndSamples: null,
  });
  const silentOutput = resolve(silentRoot, "silent.wav"); await renderReferenceAudio(silentIr, silentComposition, silentRoot, silentOutput);
  const silentPcm = pcm24Data(await readFile(silentOutput)); assert.equal(silentPcm.frames, 48_000);
  for (const frame of [0, 1, 12_000, 47_999]) assert.equal(silentPcm.sample(frame), 0);
});

test("authored Clip fades remain on the full destination clock rather than restarting at source-audio coverage", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-fade-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "fade.mkv"), { videoStart: 0, audioStart: .25, videoDuration: 1.25, audioDuration: 1, constant: .4 });
  const source = linkedSource({ master: "fade.mkv", duration: "1250ms", rangeEnd: "1250ms", clipOptions: "fadeIn: 500ms" });
  const ir = compile(source), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), output = resolve(root, "fade.wav"); await renderReferenceAudio(ir, composition, root, output);
  const pcm = pcm24Data(await readFile(output));
  assert.equal(pcm.sample(11_999), 0);
  const plateau = pcm.sample(30_000);
  assert.ok(plateau > .25 && plateau < .3, String(plateau));
  near(pcm.sample(12_000), plateau / 2, .004);
  near(pcm.sample(24_000), plateau, .004);
});

test("master and proxy may rebase absolute anchors when their relative linked A/V delta is identical", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-proxy-rebase-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "master.mkv"), { videoStart: 0, audioStart: .25, videoDuration: 1.25, audioDuration: 1, color: "green", constant: .25 });
  await generateAv(resolve(media, "proxy.mkv"), { videoStart: 2, audioStart: 2.25, videoDuration: 1.25, audioDuration: 1, color: "green", constant: .25 });
  const source = linkedSource({ master: "master.mkv", proxy: "proxy.mkv", duration: "1250ms", rangeEnd: "1250ms" });
  const canonical = compile(source), lock = await createCutLock(canonical, root); await applyCutLock(canonical, lock, root);
  const masterProbe = mediaProbe(lock, "take"), proxyProbe = lock.resources.take.proxy?.probe;
  assert.equal(proxyProbe?.kind, "media");
  const masterVideo = masterProbe.identity.streams.find((stream) => stream.type === "video" && stream.index === masterProbe.selected.video?.streamIndex);
  const proxyVideo = proxyProbe.identity.streams.find((stream) => stream.type === "video" && stream.index === proxyProbe.selected.video?.streamIndex);
  assert.deepEqual(masterVideo?.start, { numerator: "0", denominator: "1" });
  assert.deepEqual(proxyVideo?.start, { numerator: "2", denominator: "1" });

  const master = selectReferenceMediaProfile(canonical, "master").ir, proxy = selectReferenceMediaProfile(canonical, "proxy").ir;
  const [masterPlan] = inspectedPlans(master, source), [proxyPlan] = inspectedPlans(proxy, source);
  assert.equal(masterPlan.variant, "master"); assert.equal(proxyPlan.variant, "proxy");
  assert.deepEqual(masterPlan.delta, { numerator: "1", denominator: "4" });
  assert.deepEqual(proxyPlan.delta, masterPlan.delta);
  assert.deepEqual(proxyPlan.samples, masterPlan.samples);
  const profileDiff = diffCutAVIR(master, proxy), resourceChange = profileDiff.changes.find((change) => change.entity === "resource" && change.id === "take");
  assert.equal(resourceChange?.operation, "modify");
  assert.ok(resourceChange?.fields?.some((field) => field.path.includes("activeMediaVariant")), "semantic diff exposes the selected presentation authority");

  const masterComposition = validateReferenceSession(master).composition, proxyComposition = validateReferenceSession(proxy).composition;
  const masterOutput = resolve(root, "master.wav"), proxyOutput = resolve(root, "proxy.wav");
  await renderReferenceAudio(master, masterComposition, root, masterOutput);
  await renderReferenceAudio(proxy, proxyComposition, root, proxyOutput);
  assert.deepEqual(await readFile(proxyOutput), await readFile(masterOutput), "preview and final preserve the same exact local sync and PCM");

  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version CUT linked-offset test\nconfiguration: fixture");
  const masterCache = createReferenceAudioCachePlan(master, masterComposition, referenceMasterAudioRootIds(master, masterComposition), toolchain);
  const proxyCache = createReferenceAudioCachePlan(proxy, proxyComposition, referenceMasterAudioRootIds(proxy, proxyComposition), toolchain);
  assert.notEqual(masterCache.key, proxyCache.key, "master/proxy decoder authority remains cache-distinct even when presentation plans match");
});

test("proxy relative-delta drift is refused even when absolute starts are otherwise valid", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-proxy-drift-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "master.mkv"), { videoStart: 0, audioStart: .25, videoDuration: 1.25, audioDuration: 1, constant: .25 });
  await generateAv(resolve(media, "proxy.mkv"), { videoStart: 2, audioStart: 2, videoDuration: 1.25, audioDuration: 1, constant: .25 });
  const ir = compile(linkedSource({ master: "master.mkv", proxy: "proxy.mkv", duration: "1250ms", rangeEnd: "1250ms" }));
  await assert.rejects(
    createCutLock(ir, root),
    (error) => error instanceof CutProxyMediaError
      && error.code === "CUT_PROXY_TIMING"
      && error.source.resourceId === "take"
      && /audio presentation delta relative to picture must exactly match/u.test(error.message),
  );
  assert.equal(ir.resources.take.state, "unlocked");
});

test("offset Clips compose through the public overlap Transition with complete sample-grid output", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-transition-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "outgoing.mkv"), { videoStart: 0, audioStart: .25, constant: .25, color: "red" });
  await generateAv(resolve(media, "incoming.mkv"), { videoStart: .25, audioStart: 0, constant: -.25, color: "blue" });
  const source = transitionSource(), ir = compile(source), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), plans = inspectedPlans(ir, source);
  assert.deepEqual(plans.map((plan) => plan.delta), [
    { numerator: "1", denominator: "4" },
    { numerator: "-1", denominator: "4" },
  ]);
  const output = resolve(root, "transition.wav"); await renderReferenceAudio(ir, composition, root, output);
  const pcm = pcm24Data(await readFile(output)); assert.equal(pcm.frames, 72_000);
  assert.equal(pcm.sample(11_999), 0);
  const outgoingPlateau = pcm.sample(18_000);
  assert.ok(outgoingPlateau > .15 && outgoingPlateau < .2, String(outgoingPlateau));
  near(pcm.sample(12_000), outgoingPlateau);
  assert.ok(Math.abs(pcm.sample(36_000)) < .01, "the authored crossfade midpoint combines the two offset child streams");
  assert.equal(pcm.sample(60_000), 0); assert.equal(pcm.sample(71_999), 0);
});

test("standalone AudioAsset still rebases nonzero absolute PTS to decoded sample zero", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-standalone-audio-offset-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "voice.mkv"), { videoStart: 0, audioStart: 2, videoDuration: 3, audioDuration: 1, frequency: 880 });
  const ir = compile(audioSource("voice.mkv")), lock = await createCutLock(ir, root), probe = mediaProbe(lock, "voice");
  assert.equal(probe.selected.audio?.decodedAudioSamples?.firstPts, "2000");
  assert.equal(probe.selected.video, undefined);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), output = resolve(root, "voice.wav"); await renderReferenceAudio(ir, composition, root, output);
  assert.ok(Math.abs(pcm24Data(await readFile(output)).sample(100)) > .01);
});

test("hostile off-grid offsets and picture-overruns fail source-located before render or cache artifacts", { timeout: 240_000 }, async () => {
  const gridRoot = await mkdtemp(resolve(tmpdir(), "cut-linked-av-grid-")), gridMedia = resolve(gridRoot, "media"); await mkdir(gridMedia);
  await generateAv(resolve(gridMedia, "grid.mkv"), { videoStart: 0, audioStart: .001, videoDuration: 1.25, audioDuration: 1, constant: .25 });
  const gridIr = compile(linkedSource({ master: "grid.mkv", duration: "1250ms", rangeEnd: "1250ms", sampleRate: "44.1khz" }));
  await assert.rejects(
    createCutLock(gridIr, gridRoot),
    (error) => error instanceof CutMediaPresentationPlanError
      && error.code === "CUT_MEDIA_PRESENTATION_OFFSET_GRID"
      && error.source.resourceId === "take"
      && error.source.line === 7
      && /44100 Hz sample grid/u.test(error.message),
  );
  assert.equal(gridIr.resources.take.state, "unlocked");
  await assert.rejects(access(resolve(gridRoot, ".cut")));

  const overrunRoot = await mkdtemp(resolve(tmpdir(), "cut-linked-av-picture-bound-")), overrunMedia = resolve(overrunRoot, "media"); await mkdir(overrunMedia);
  await generateAv(resolve(overrunMedia, "overrun.mkv"), { videoStart: 0, audioStart: 0, videoDuration: 1, audioDuration: 1.5, constant: .25 });
  const overrunIr = compile(linkedSource({ master: "overrun.mkv", duration: "1250ms", rangeEnd: "1250ms" }));
  await assert.rejects(
    createCutLock(overrunIr, overrunRoot),
    (error) => error instanceof Error
      && /beyond the selected picture bound 1\/1s/u.test(error.message)
      && !/picture\/source-audio/u.test(error.message),
  );

  const hostileRoot = await mkdtemp(resolve(tmpdir(), "cut-linked-av-hostile-ir-")), hostileMedia = resolve(hostileRoot, "media"); await mkdir(hostileMedia);
  await generateAv(resolve(hostileMedia, "aligned.mkv"), { videoStart: 0, audioStart: 0, videoDuration: 1, audioDuration: 1, constant: .25 });
  const hostileSource = linkedSource({ master: "aligned.mkv", sampleRate: "44.1khz" }), canonical = compile(hostileSource), lock = await createCutLock(canonical, hostileRoot);
  const hostileLock = structuredClone(lock), hostileLockProbe = mediaProbe(hostileLock, "take");
  assert.ok(hostileLockProbe.selected.audio?.decodedAudioSamples);
  hostileLockProbe.selected.audio.decodedAudioSamples.firstPts = "1";
  const lockApplication = compile(hostileSource);
  await assert.rejects(
    applyCutLockForVerifiedInputSession(lockApplication, hostileLock, hostileRoot),
    (error) => error instanceof CutMediaPresentationPlanError && error.code === "CUT_MEDIA_PRESENTATION_OFFSET_GRID",
  );
  assert.equal(lockApplication.resources.take.state, "unlocked", "failed hostile-lock application cannot mutate resource state");

  await applyCutLock(canonical, lock, hostileRoot);
  const hostile = structuredClone(canonical), embedded = hostile.resources.take.metadata!.probe as Extract<LockedResourceProbe, { kind: "media" }>;
  assert.ok(embedded.selected.audio?.decodedAudioSamples);
  embedded.selected.audio.decodedAudioSamples.firstPts = "1";
  const output = resolve(hostileRoot, "must-not-exist.mp4");
  await assert.rejects(
    renderReferenceIr(hostile, hostileRoot, output, undefined, { lockSha256: "0".repeat(64) }),
    (error) => error instanceof CutMediaPresentationPlanError && error.code === "CUT_MEDIA_PRESENTATION_OFFSET_GRID",
  );
  await assert.rejects(access(output));
  await assert.rejects(access(resolve(hostileRoot, ".cut")), "presentation preflight must precede cache allocation");
});

test("matching nonzero linked anchors retain the first semantic picture and sample", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-av-aligned-")), media = resolve(root, "media"); await mkdir(media);
  await generateAv(resolve(media, "aligned.mkv"), { videoStart: 2, audioStart: 2, color: "blue", frequency: 660 });
  const source = linkedSource({ master: "aligned.mkv" }), ir = compile(source), lock = await createCutLock(ir, root), probe = mediaProbe(lock, "take");
  const selectedVideo = probe.selected.video!, selectedAudio = probe.selected.audio!;
  const videoStream = probe.identity.streams.find((stream) => stream.type === "video" && stream.index === selectedVideo.streamIndex)!;
  assert.deepEqual(videoStream.start, { numerator: "2", denominator: "1" });
  assert.equal(selectedAudio.decodedAudioSamples?.firstPts, "2000");
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), scene = ir.scenes[composition.sceneIds[0]];
  const visual = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "visual-cache"));
  try {
    await visual.prepare();
    const surface = await visual.sceneFrame(scene, 0), center = (32 * surface.width + 32) * 4;
    assert.ok(surface.data[center + 2] > surface.data[center]); assert.equal(surface.data[center + 3], 255);
  } finally { visual.close(); }
  const audioPath = resolve(root, "aligned.wav"); await renderReferenceAudio(ir, composition, root, audioPath);
  assert.ok(Math.abs(pcm24Data(await readFile(audioPath)).sample(100)) > .01);
});
