import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  cutAudioProxyAlignmentContractV1,
  cutAudioProxyEnvelopeWindowCount,
  cutAudioProxyExecutionIdentity,
  cutAudioProxyAlignmentIntegrity,
  type CutAudioProxyAlignment,
  type CutAudioProxyAlignmentV1,
  type CutAudioProxyAlignmentV2,
  type CutAudioProxyAlignmentWithoutIntegrity,
} from "../lib/language/audio-proxy-alignment";
import { compileCutModule } from "../lib/language/compiler";
import {
  applyCutLock,
  applyCutLockForVerifiedInputSession,
  createCutLock,
  CutLockError,
  CutProxyMediaError,
  validateCutLock,
  type CutLockfile,
} from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { CutProjectError } from "../lib/project/manifest";
import { probeProjectAudioProxyAlignment, probeProjectDecodedAudioSamples, probeProjectMedia } from "../lib/project/probe";
import { inspectCutIr } from "../lib/runtime/inspect";
import { prepareReferenceVerifiedInputSession, ReferenceVerifiedInputSessionError } from "../lib/runtime/reference/verified-input-session";

const exec = promisify(execFile);
const sampleRate = 48_000, frames = 48_000, channels = 2;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function source(master: string, proxy: string, duration = "1s") {
  return `cut 0.4;
project "decoded audio proxy alignment";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("${master}", proxy: "${proxy}");
timeline main(duration: ${duration}, fps: 24, sampleRate: 48khz) { AudioClip(source: voice, range: 0s ..< ${duration}); }
export out = render(main);`;
}

function richSignal(frame: number, channel: number) {
  const time = frame / sampleRate;
  const chirp = channel === 0
    ? Math.sin(2 * Math.PI * (180 * time + 170 * time * time))
    : Math.sin(2 * Math.PI * (310 * time + 95 * time * time));
  const detail = Math.sin(2 * Math.PI * (channel === 0 ? 733 : 1_117) * time + channel * .7);
  const pulse = Math.sin(2 * Math.PI * 2.3 * time) > .25 ? 1 : .72;
  return Math.round((chirp * .42 + detail * .13) * pulse * 32_767);
}

function wav(frameCount: number, channelCount: number, sample: (frame: number, channel: number) => number) {
  const dataBytes = frameCount * channelCount * 2, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channelCount, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * channelCount * 2, 28); bytes.writeUInt16LE(channelCount * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      bytes.writeInt16LE(Math.max(-32_768, Math.min(32_767, sample(frame, channel))), 44 + (frame * channelCount + channel) * 2);
    }
  }
  return bytes;
}

async function encode(input: string, codec: "pcm" | "flac" | "aac" | "opus", output: string) {
  const codecArgs = codec === "pcm" ? ["-c:a", "pcm_s16le"]
    : codec === "flac" ? ["-c:a", "flac"]
      : codec === "aac" ? ["-c:a", "aac", "-b:a", "192k"]
        : ["-c:a", "libopus", "-b:a", "160k"];
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-map", "0:a:0", "-ar", String(sampleRate), "-ac", String(channels), ...codecArgs, output]);
}

function alignment(lock: CutLockfile) {
  const value = lock.resources.voice.proxy?.audioAlignment;
  assert.ok(value);
  return value;
}

function currentAlignment(lock: CutLockfile) {
  const value = alignment(lock);
  assert.equal(value.version, 2);
  return value as CutAudioProxyAlignmentV2;
}

async function nativeWitness(root: string, locator: string) {
  const identity = await probeProjectMedia(root, locator), stream = identity.streams.find((candidate) => candidate.type === "audio");
  assert.ok(stream);
  const witness = await probeProjectDecodedAudioSamples(root, locator, identity, stream.index);
  return { identity, witness };
}

function forgeInternallyConsistentAlignment(lock: CutLockfile) {
  const forged = structuredClone(lock), stored = alignment(forged);
  const { integrity: _integrity, ...base } = stored;
  void _integrity;
  const changed: CutAudioProxyAlignmentWithoutIntegrity = {
    ...base,
    proxy: { ...base.proxy, analysisPcmSha256: "f".repeat(64) },
  };
  forged.resources.voice.proxy!.audioAlignment = { ...changed, integrity: cutAudioProxyAlignmentIntegrity(changed) };
  return forged;
}

test("audio proxy alignment v2 envelope geometry and selected-proxy cache projection are closed", () => {
  assert.deepEqual(
    [1n, 319n, 320n, 321n, 479n, 480n, 481n, 16_000n].map((frames) => cutAudioProxyEnvelopeWindowCount(frames)),
    [1n, 1n, 1n, 2n, 2n, 2n, 3n, 99n],
  );
  assert.throws(() => cutAudioProxyEnvelopeWindowCount(0n), /frameCount must be positive/u);
});

test("audio proxy alignment accepts same-source PCM, FLAC, AAC, and Opus while binding lock, inspect, and private-session evidence", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-proxy-codecs-"));
  try {
    await mkdir(resolve(root, "media"));
    const input = resolve(root, "media/source.wav"), master = "media/master.flac";
    await writeFile(input, wav(frames, channels, richSignal));
    await encode(input, "flac", resolve(root, master));
    const proxies = [
      ["pcm", "media/proxy-pcm.mov"],
      ["flac", "media/proxy-flac.flac"],
      ["aac", "media/proxy-aac.m4a"],
      ["opus", "media/proxy-opus.mkv"],
    ] as const;
    for (const [codec, locator] of proxies) await encode(input, codec, resolve(root, locator));

    for (const [codec, locator] of proxies) {
      const program = source(master, locator), ir = compile(program), lock = await createCutLock(ir, root), evidence = currentAlignment(lock);
      validateCutLock(JSON.parse(JSON.stringify(lock)) as CutLockfile);
      assert.equal(evidence.method, "cut-multiscale-s16-alignment-v2", codec);
      assert.equal(evidence.decision, "equivalent", codec);
      assert.deepEqual({ rate: evidence.analysis.sampleRate, frames: evidence.analysis.frameCount, channels: evidence.analysis.channels, bytes: evidence.analysis.bytesPerVariant, envelopeWindow: evidence.analysis.envelopeWindowFrames, envelopeHop: evidence.analysis.envelopeHopFrames }, { rate: 16_000, frames: "16000", channels: 2, bytes: "64000", envelopeWindow: 320, envelopeHop: 160 }, codec);
      assert.deepEqual({ total: evidence.metrics.totalChannelWindows, evaluated: evidence.metrics.evaluatedChannelWindows, passed: evidence.metrics.passedChannelWindows, failed: evidence.metrics.failedChannelWindows }, { total: "20", evaluated: "20", passed: "20", failed: "0" }, codec);
      assert.ok(evidence.metrics.minimumGlobalCorrelationPpm >= evidence.policy.minimumGlobalCorrelationPpm, codec);
      assert.ok(evidence.metrics.minimumWindowCorrelationPpm >= evidence.policy.minimumWindowCorrelationPpm, codec);
      assert.ok(evidence.metrics.maximumGainNormalizedResidualPowerPpm <= evidence.policy.maximumGainNormalizedResidualPowerPpm, codec);
      assert.ok(evidence.metrics.minimumEnvelopeEnergyRatioPpm >= evidence.policy.minimumEnvelopeEnergyRatioPpm, codec);
      assert.ok(evidence.metrics.maximumEnvelopeEnergyRatioPpm <= evidence.policy.maximumEnvelopeEnergyRatioPpm, codec);
      assert.equal(evidence.metrics.failedEnvelopeChannelWindows, "0", codec);
      assert.equal(evidence.master.decodedSampleCount, "48000", codec);
      assert.equal(evidence.proxy.decodedSampleCount, "48000", codec);
      const executionIdentity = cutAudioProxyExecutionIdentity(evidence);
      assert.deepEqual(Object.keys(executionIdentity).sort(), ["analysis", "decision", "format", "method", "policy", "proxy", "version"], codec);
      assert.equal(Object.hasOwn(executionIdentity, "master"), false, codec);
      assert.equal(Object.hasOwn(executionIdentity, "metrics"), false, codec);
      assert.equal(Object.hasOwn(executionIdentity, "integrity"), false, codec);
      await applyCutLock(ir, lock, root);
      const inspected = inspectCutIr(ir, "program.cut").resources.find((resource) => resource.id === "voice") as { selectedMedia?: { proxy?: { audioProxyAlignment?: CutAudioProxyAlignment } }; proxy?: { audioProxyAlignment?: CutAudioProxyAlignment } };
      assert.deepEqual(inspected.proxy?.audioProxyAlignment ?? inspected.selectedMedia?.proxy?.audioProxyAlignment, evidence, codec);
      if (codec === "aac") {
        const session = await prepareReferenceVerifiedInputSession(ir, root, "proxy");
        assert.equal(session.media.selectedProxyResources, 1);
        await session.cleanup();
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio proxy alignment intentionally accepts equal all-silent timelines", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-proxy-silence-"));
  try {
    await mkdir(resolve(root, "media"));
    const input = resolve(root, "media/silence.wav");
    await writeFile(input, wav(frames, channels, () => 0));
    await encode(input, "flac", resolve(root, "media/master.flac"));
    await encode(input, "opus", resolve(root, "media/proxy.mkv"));
    const evidence = currentAlignment(await createCutLock(compile(source("media/master.flac", "media/proxy.mkv")), root));
    assert.deepEqual({
      global: evidence.metrics.channelGlobalCorrelationPpm,
      minimumGlobal: evidence.metrics.minimumGlobalCorrelationPpm,
      minimumWindow: evidence.metrics.minimumWindowCorrelationPpm,
      total: evidence.metrics.totalChannelWindows,
      silent: evidence.metrics.silentChannelWindows,
      evaluated: evidence.metrics.evaluatedChannelWindows,
      passed: evidence.metrics.passedChannelWindows,
      failed: evidence.metrics.failedChannelWindows,
      residual: evidence.metrics.channelMaximumGainNormalizedResidualPowerPpm,
      envelopeMin: evidence.metrics.channelMinimumEnvelopeEnergyRatioPpm,
      envelopeMax: evidence.metrics.channelMaximumEnvelopeEnergyRatioPpm,
      envelopeTotal: evidence.metrics.totalEnvelopeChannelWindows,
      envelopeSilent: evidence.metrics.silentEnvelopeChannelWindows,
      envelopeEvaluated: evidence.metrics.evaluatedEnvelopeChannelWindows,
      envelopeFailed: evidence.metrics.failedEnvelopeChannelWindows,
    }, {
      global: [1_000_000, 1_000_000], minimumGlobal: 1_000_000, minimumWindow: 1_000_000,
      total: "20", silent: "20", evaluated: "0", passed: "0", failed: "0", residual: [0, 0],
      envelopeMin: [1_000_000, 1_000_000], envelopeMax: [1_000_000, 1_000_000],
      envelopeTotal: "198", envelopeSilent: "198", envelopeEvaluated: "0", envelopeFailed: "0",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio proxy alignment v2 validates a source shorter than one envelope window", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-proxy-short-"));
  try {
    await mkdir(resolve(root, "media"));
    const shortFrames = 240, bytes = wav(shortFrames, channels, richSignal);
    await writeFile(resolve(root, "media/master.wav"), bytes);
    await writeFile(resolve(root, "media/proxy.wav"), bytes);
    const lock = await createCutLock(compile(source("media/master.wav", "media/proxy.wav", "5ms")), root);
    const evidence = currentAlignment(lock);
    validateCutLock(JSON.parse(JSON.stringify(lock)) as CutLockfile);
    assert.deepEqual({
      frames: evidence.analysis.frameCount,
      ordinary: evidence.metrics.totalChannelWindows,
      envelope: evidence.metrics.totalEnvelopeChannelWindows,
      envelopeEvaluated: evidence.metrics.evaluatedEnvelopeChannelWindows,
      envelopeFailed: evidence.metrics.failedEnvelopeChannelWindows,
    }, {
      frames: "80",
      ordinary: "2",
      envelope: "2",
      envelopeEvaluated: "2",
      envelopeFailed: "0",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio proxy alignment v2 rejects a masked independent component and a five-millisecond dropout", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-proxy-v2-adversarial-"));
  try {
    await mkdir(resolve(root, "media"));
    const dominant = (frame: number) => 20_000 * Math.sin(2 * Math.PI * 440 * frame / sampleRate);
    const secondary = (frame: number) => 5_000 * Math.sin(2 * Math.PI * 880 * frame / sampleRate);
    const attacks: Array<[string, (frame: number, channel: number) => number, (frame: number, channel: number) => number]> = [
      ["masked-component", (frame) => Math.round(dominant(frame) + secondary(frame)), (frame) => Math.round(dominant(frame))],
      ["five-ms-drop", richSignal, (frame, channel) => frame >= 12_000 && frame < 12_240 ? 0 : richSignal(frame, channel)],
    ];
    for (const [name, masterSample, proxySample] of attacks) {
      const master = `media/${name}-master.wav`, proxy = `media/${name}-proxy.wav`;
      await writeFile(resolve(root, master), wav(frames, channels, masterSample));
      await writeFile(resolve(root, proxy), wav(frames, channels, proxySample));
      await assert.rejects(
        createCutLock(compile(source(master, proxy)), root),
        (error: unknown) => error instanceof CutProxyMediaError
          && error.code === "CUT_PROXY_AUDIO_ALIGNMENT"
          && /not timeline-equivalent/u.test(error.message)
          && error.source.line > 0,
        name,
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("historical audio proxy alignment v1 remains structurally readable under its closed policy", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-proxy-v1-reader-"));
  try {
    await mkdir(resolve(root, "media"));
    const bytes = wav(frames, channels, richSignal);
    await writeFile(resolve(root, "media/master.wav"), bytes); await writeFile(resolve(root, "media/proxy.wav"), bytes);
    const program = source("media/master.wav", "media/proxy.wav");
    const lock = await createCutLock(compile(program), root), current = currentAlignment(lock);
    const historicalBase: Omit<CutAudioProxyAlignmentV1, "integrity"> = {
      format: cutAudioProxyAlignmentContractV1.format,
      version: cutAudioProxyAlignmentContractV1.version,
      method: cutAudioProxyAlignmentContractV1.method,
      analysis: {
        sampleRate: current.analysis.sampleRate, sampleFormat: current.analysis.sampleFormat, windowFrames: current.analysis.windowFrames,
        channels: current.analysis.channels, frameCount: current.analysis.frameCount, bytesPerVariant: current.analysis.bytesPerVariant,
        frequencyCoverage: current.analysis.frequencyCoverage,
      },
      master: current.master,
      proxy: current.proxy,
      policy: {
        silenceRmsS16: cutAudioProxyAlignmentContractV1.silenceRmsS16,
        activeRmsS16: cutAudioProxyAlignmentContractV1.activeRmsS16,
        maximumEnergyPowerRatio: cutAudioProxyAlignmentContractV1.maximumEnergyPowerRatio,
        minimumGlobalCorrelationPpm: cutAudioProxyAlignmentContractV1.minimumGlobalCorrelationPpm,
        minimumWindowCorrelationPpm: cutAudioProxyAlignmentContractV1.minimumWindowCorrelationPpm,
        maximumFailedChannelWindows: cutAudioProxyAlignmentContractV1.maximumFailedChannelWindows,
      },
      metrics: {
        channelGlobalCorrelationPpm: current.metrics.channelGlobalCorrelationPpm,
        minimumGlobalCorrelationPpm: current.metrics.minimumGlobalCorrelationPpm,
        minimumWindowCorrelationPpm: current.metrics.minimumWindowCorrelationPpm,
        totalChannelWindows: current.metrics.totalChannelWindows,
        silentChannelWindows: current.metrics.silentChannelWindows,
        evaluatedChannelWindows: current.metrics.evaluatedChannelWindows,
        passedChannelWindows: current.metrics.passedChannelWindows,
        failedChannelWindows: current.metrics.failedChannelWindows,
        silenceMismatchChannelWindows: current.metrics.silenceMismatchChannelWindows,
        energyMismatchChannelWindows: current.metrics.energyMismatchChannelWindows,
      },
      decision: "equivalent",
    };
    const historical: CutAudioProxyAlignmentV1 = { ...historicalBase, integrity: cutAudioProxyAlignmentIntegrity(historicalBase) };
    const v1Lock = structuredClone(lock); v1Lock.resources.voice.proxy!.audioAlignment = historical;
    assert.doesNotThrow(() => validateCutLock(v1Lock));
    await assert.rejects(
      applyCutLock(compile(program), v1Lock, root),
      (error: unknown) => error instanceof CutLockError
        && error.code === "CUT_PROXY_AUDIO_ALIGNMENT"
        && error.path.endsWith(".proxy.audioAlignment")
        && /evidence changed/u.test(error.message),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio proxy alignment rejects shifts, middle drops, reordered sections, different content, and channel swaps with fixed geometry", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-proxy-adversarial-"));
  try {
    await mkdir(resolve(root, "media"));
    const masterLocator = "media/master.wav";
    await writeFile(resolve(root, masterLocator), wav(frames, channels, richSignal));
    const quarter = frames / 4, shift = sampleRate / 10;
    const attacks: Array<[string, (frame: number, channel: number) => number]> = [
      ["shift", (frame, channel) => frame < shift ? 0 : richSignal(frame - shift, channel)],
      ["middle-drop", (frame, channel) => frame >= quarter && frame < quarter * 3 ? 0 : richSignal(frame, channel)],
      ["reordered", (frame, channel) => {
        const block = Math.floor(frame / quarter), within = frame % quarter, order = [0, 2, 1, 3];
        return richSignal(order[block] * quarter + within, channel);
      }],
      ["different", (frame, channel) => Math.round(Math.sin(2 * Math.PI * (channel === 0 ? 911 : 1_733) * frame / sampleRate) * 14_000)],
      ["channel-swap", (frame, channel) => richSignal(frame, 1 - channel)],
    ];
    const master = await nativeWitness(root, masterLocator);
    for (const [name, sample] of attacks) {
      const locator = `media/${name}.wav`;
      await writeFile(resolve(root, locator), wav(frames, channels, sample));
      const proxy = await nativeWitness(root, locator);
      await assert.rejects(
        probeProjectAudioProxyAlignment(root, masterLocator, master.identity, master.witness, locator, proxy.identity, proxy.witness),
        (error: unknown) => error instanceof CutProjectError && error.code === "CUTP2018" && /not timeline-equivalent/u.test(error.message),
        name,
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio proxy alignment is bounded and forged evidence fails native and private-session rechecks", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-proxy-authority-"));
  try {
    await mkdir(resolve(root, "media"));
    const masterLocator = "media/master.wav", proxyLocator = "media/proxy.wav", bytes = wav(frames, channels, richSignal);
    await writeFile(resolve(root, masterLocator), bytes); await writeFile(resolve(root, proxyLocator), bytes);
    const master = await nativeWitness(root, masterLocator), proxy = await nativeWitness(root, proxyLocator);
    await assert.rejects(
      probeProjectAudioProxyAlignment(root, masterLocator, master.identity, master.witness, proxyLocator, proxy.identity, proxy.witness, { maxOutputBytes: 1 }),
      (error: unknown) => error instanceof CutProjectError && error.code === "CUTP2018" && /exceeded the 1-byte analysis bound/u.test(error.message),
    );

    const program = source(masterLocator, proxyLocator), lock = await createCutLock(compile(program), root);
    const integrityTamper = structuredClone(lock);
    const stored = alignment(integrityTamper);
    integrityTamper.resources.voice.proxy!.audioAlignment = { ...stored, proxy: { ...stored.proxy, analysisPcmSha256: "e".repeat(64) } };
    assert.throws(() => validateCutLock(integrityTamper), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_IDENTITY" && error.path.endsWith(".audioAlignment.integrity"));

    const metricIntegrityTamper = structuredClone(lock), metricStored = currentAlignment(metricIntegrityTamper);
    metricIntegrityTamper.resources.voice.proxy!.audioAlignment = {
      ...metricStored,
      metrics: {
        ...metricStored.metrics,
        channelMaximumGainNormalizedResidualPowerPpm: [1, ...metricStored.metrics.channelMaximumGainNormalizedResidualPowerPpm.slice(1)],
        maximumGainNormalizedResidualPowerPpm: 1,
      },
    };
    assert.throws(
      () => validateCutLock(metricIntegrityTamper),
      (error) => error instanceof CutLockError && error.code === "CUT_LOCK_IDENTITY" && error.path.endsWith(".audioAlignment.integrity"),
    );

    const forgedMetric = structuredClone(lock), forgedMetricStored = currentAlignment(forgedMetric);
    const { integrity: _metricIntegrity, ...forgedMetricBase } = forgedMetricStored;
    void _metricIntegrity;
    const forgedMetricChanged = {
      ...forgedMetricBase,
      metrics: {
        ...forgedMetricBase.metrics,
        channelMaximumGainNormalizedResidualPowerPpm: [1, ...forgedMetricBase.metrics.channelMaximumGainNormalizedResidualPowerPpm.slice(1)],
        maximumGainNormalizedResidualPowerPpm: 1,
      },
    };
    forgedMetric.resources.voice.proxy!.audioAlignment = {
      ...forgedMetricChanged,
      integrity: cutAudioProxyAlignmentIntegrity(forgedMetricChanged),
    };
    validateCutLock(forgedMetric);
    await assert.rejects(
      applyCutLock(compile(program), forgedMetric, root),
      (error: unknown) => error instanceof CutLockError
        && error.code === "CUT_PROXY_AUDIO_ALIGNMENT"
        && error.path.endsWith(".proxy.audioAlignment"),
    );

    const forged = forgeInternallyConsistentAlignment(lock);
    validateCutLock(forged);
    await assert.rejects(
      applyCutLock(compile(program), forged, root),
      (error: unknown) => error instanceof CutLockError
        && error.code === "CUT_PROXY_AUDIO_ALIGNMENT"
        && error.path.endsWith(".proxy.audioAlignment"),
    );

    const deferred = compile(program);
    await applyCutLockForVerifiedInputSession(deferred, forged, root);
    await assert.rejects(
      prepareReferenceVerifiedInputSession(deferred, root, "proxy"),
      (error: unknown) => error instanceof ReferenceVerifiedInputSessionError
        && error.code === "CUT_LOCK_METADATA"
        && error.detail.reason === "proxy-audio-alignment-mismatch",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
