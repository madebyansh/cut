import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { IRSignal } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  ReferenceAudioReactivePreparationError,
} from "../lib/runtime/reference/audio-reactive-preparation";
import {
  evaluateSignal,
  ReferencePreparedSignalResolver,
  ReferenceProducedSignalStateError,
} from "../lib/runtime/reference/signals";
import { prepareReferenceVerifiedInputSession } from "../lib/runtime/reference/verified-input-session";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function source(master = "media/master.wav", proxy?: string, mappedTo = "2", stream?: number) {
  return `cut 0.4;
project "audio reactive runtime proof";
import { Group, Path, lineTo, vectorPath } from "cut:visual";
import { AmplitudeEnvelope, mapNumber } from "@cut/data";
asset rhythm: AudioAsset = audio("${master}"${proxy ? `, proxy: "${proxy}"` : ""}${stream === undefined ? "" : `, stream: ${stream}`});
timeline main(duration: 2s, fps: 10, width: 64px, height: 64px, sampleRate: 48khz) {
  scene pulse(duration: 2s) {
    let energy: Signal<Ratio> = AmplitudeEnvelope(
      source: rhythm,
      range: 0s ..< 2s,
      at: 0s,
      detector: "rms",
      window: 20ms,
      hop: 10ms,
      attack: 10ms,
      release: 50ms,
      floor: 1%,
      ceiling: 80%
    );
    Group() as pulse {
      Path(geometry: vectorPath(start: { x: 22px, y: 32px }, segments: [lineTo(to: { x: 42px, y: 32px })], closed: false), stroke: #f04f3d, width: 6px);
    }
    set pulse.scale = mapNumber(energy, from: 1, to: ${mappedTo});
  }
}
export proof = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function wav(samples: number[], sampleRate = 48_000) {
  const dataBytes = samples.length * 2, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => bytes.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))), 44 + index * 2));
  return bytes;
}

function pulseSamples(shiftFrames = 0, level = .72) {
  return Array.from({ length: 96_000 }, (_, frame) => {
    const shifted = frame - shiftFrames;
    if (shifted < 24_000 || shifted >= 48_000) return 0;
    return shifted % 20 < 10 ? level : -level;
  });
}

async function fixture(options: { proxy?: boolean; masterSilent?: boolean } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-reactive-preparation-"));
  await mkdir(resolve(root, "media"));
  await writeFile(resolve(root, "media/master.wav"), wav(options.masterSilent ? Array(96_000).fill(0) : pulseSamples()));
  if (options.proxy) await writeFile(resolve(root, "media/proxy.wav"), wav(pulseSamples(0, .6)));
  const ir = compile(source("media/master.wav", options.proxy ? "media/proxy.wav" : undefined));
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { root, ir, lock };
}

function pixelsHash(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

test("public amplitude producer decodes a verified locked selection, changes pixels causally, caches exact PCM, and cannot leak across renderer resolvers", { timeout: 120_000 }, async () => {
  const project = await fixture({ proxy: true });
  const session = await prepareReferenceVerifiedInputSession(project.ir, project.root, "master");
  const composition = session.ir.compositions[0], scene = session.ir.scenes[composition.sceneIds[0]];
  const cacheRoot = resolve(project.root, ".cut-test-cache");
  const first = new ReferenceVisualRenderer(session.ir, composition, project.root, cacheRoot, session.pathFor);
  try {
    await first.prepare();
    const opening = await first.sceneFrame(scene, 0, false), pulse = await first.sceneFrame(scene, 6, false);
    assert.notEqual(pixelsHash(opening.data), pixelsHash(pulse.data), "causal source amplitude must execute as visible Group scale changes");
    const [evidence] = first.referenceAudioReactivePreparationEvidence();
    assert.ok(evidence);
    assert.equal(evidence.cacheStatus, "miss");
    assert.equal(evidence.activeVariant, "master");
    assert.equal(evidence.selectedStreamIndex, 0);
    assert.match(evidence.selectedStreamIdentitySha256, /^[a-f0-9]{64}$/u);
    assert.match(evidence.decoderIntegritySha256, /^[a-f0-9]{64}$/u);
    assert.equal(evidence.decodedFrames, 96_000);
    assert.equal(evidence.decodedBytes, 768_000);
    assert.ok(evidence.sceneLocalEventCount >= 2);
  } finally { await first.closeAndWait(); }

  const unprepared = new ReferenceVisualRenderer(session.ir, composition, project.root, resolve(project.root, ".cut-unprepared"), session.pathFor);
  try {
    await assert.rejects(unprepared.sceneFrame(scene, 0, false), (error: unknown) => error instanceof ReferenceProducedSignalStateError
      && error.code === "CUT_SIGNAL_PRODUCER_UNPREPARED");
  } finally { await unprepared.closeAndWait(); }

  const second = new ReferenceVisualRenderer(session.ir, composition, project.root, cacheRoot, session.pathFor);
  let cacheKey = "", inputPcmSha256 = "";
  try {
    await second.prepare();
    const [evidence] = second.referenceAudioReactivePreparationEvidence();
    assert.equal(evidence.cacheStatus, "hit");
    cacheKey = evidence.cacheKey;
    inputPcmSha256 = evidence.inputPcmSha256;
  } finally { await second.closeAndWait(); }

  const cachePath = resolve(cacheRoot, "audio-reactive", cacheKey, "source.f32le"), tampered = await readFile(cachePath);
  tampered[0] ^= 0x01;
  await writeFile(cachePath, tampered);
  const repaired = new ReferenceVisualRenderer(session.ir, composition, project.root, cacheRoot, session.pathFor);
  try {
    await repaired.prepare();
    const [evidence] = repaired.referenceAudioReactivePreparationEvidence();
    assert.equal(evidence.cacheStatus, "miss", "tampered same-size decoded PCM cache must be re-decoded");
    assert.equal(evidence.inputPcmSha256, inputPcmSha256);
  } finally { await repaired.closeAndWait(); }

  const signal = Object.values(session.ir.signals).find((candidate) => candidate.kind === "track" && candidate.producer)!;
  if (signal.kind !== "track") throw new Error("expected producer-backed track");
  const resolverA = new ReferencePreparedSignalResolver(session.ir), resolverB = new ReferencePreparedSignalResolver(session.ir);
  const prepared: IRSignal = { id: signal.id, kind: "track", valueType: signal.valueType, initial: signal.initial, events: [], contentHash: "isolated", provenance: signal.provenance };
  resolverA.install(signal.id, prepared);
  assert.deepEqual(evaluateSignal(session.ir, signal.id, rational(0), resolverA), signal.initial);
  assert.throws(() => evaluateSignal(session.ir, signal.id, rational(0), resolverB), ReferenceProducedSignalStateError);
  resolverA.close(); resolverB.close();
  await session.cleanup();

  const proxy = await prepareReferenceVerifiedInputSession(project.ir, project.root, "proxy");
  const proxyComposition = proxy.ir.compositions[0];
  const proxyRenderer = new ReferenceVisualRenderer(proxy.ir, proxyComposition, project.root, cacheRoot, proxy.pathFor);
  try {
    await proxyRenderer.prepare();
    const [evidence] = proxyRenderer.referenceAudioReactivePreparationEvidence();
    assert.equal(evidence.activeVariant, "proxy");
    assert.notEqual(evidence.cacheKey, cacheKey, "master/proxy selected bytes must have disjoint analysis cache identity");
    assert.notEqual(evidence.inputPcmSha256, inputPcmSha256);
  } finally { await proxyRenderer.closeAndWait(); await proxy.cleanup(); }
});

test("runtime refuses a silent selected stream even when a different default stream contains modulation", { timeout: 120_000 }, async () => {
  const project = await fixture({ masterSilent: true });
  const pulsePath = resolve(project.root, "media/pulse.wav"), multiPath = resolve(project.root, "media/multi.mkv");
  await writeFile(pulsePath, wav(pulseSamples()));
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", resolve(project.root, "media/master.wav"), "-i", pulsePath,
    "-map", "0:a:0", "-map", "1:a:0", "-c:a", "pcm_s16le",
    "-disposition:a:0", "0", "-disposition:a:1", "default", multiPath,
  ]);
  const ir = compile(source("media/multi.mkv", undefined, "2", 0)), lock = await createCutLock(ir, project.root);
  const probe = lock.resources.rhythm.probe;
  assert.equal(probe.kind, "media");
  if (probe.kind !== "media") return;
  assert.deepEqual(probe.identity.streams.filter((stream) => stream.type === "audio").map((stream) => stream.index), [0, 1]);
  assert.equal(probe.selected.audio?.streamIndex, 0, "CUT lock deliberately selects stream 0, not container default stream 1");
  await applyCutLock(ir, lock, project.root);
  const session = await prepareReferenceVerifiedInputSession(ir, project.root, "master");
  const composition = session.ir.compositions[0], renderer = new ReferenceVisualRenderer(session.ir, composition, project.root, resolve(project.root, ".cut-multi-cache"), session.pathFor);
  try {
    await assert.rejects(renderer.prepare(), (error: unknown) => error instanceof ReferenceAudioReactivePreparationError
      && error.code === "CUT_AUDIO_REACTIVE_PRODUCER_NOOP"
      && /cannot change the mapped visual property/u.test(error.message));
  } finally { await renderer.closeAndWait(); await session.cleanup(); }
});

test("hostile IR cannot bypass target ownership or mapped endpoint bounds", { timeout: 120_000 }, async () => {
  const project = await fixture();
  const session = await prepareReferenceVerifiedInputSession(project.ir, project.root, "master");
  const signal = Object.values(session.ir.signals).find((candidate) => candidate.kind === "track" && candidate.producer)!;
  assert.equal(signal.kind, "track");
  const group = Object.values(session.ir.nodes).find((node) => node.op === "cut.visual.group")!;

  const invalidEndpoint = structuredClone(session.ir), endpointSignal = invalidEndpoint.signals[signal.id];
  assert.equal(endpointSignal.kind, "track");
  if (endpointSignal.kind !== "track" || !endpointSignal.producer) return;
  endpointSignal.producer.mapping.to = { kind: "quantity", dimension: "scalar", magnitude: rational(99), unit: "scalar" };
  const endpointRenderer = new ReferenceVisualRenderer(invalidEndpoint, invalidEndpoint.compositions[0], project.root, resolve(project.root, ".cut-endpoint-cache"), session.pathFor);
  try {
    await assert.rejects(endpointRenderer.prepare(), (error: unknown) => error instanceof ReferenceAudioReactivePreparationError
      && error.code === "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG"
      && /scale mapping endpoints/u.test(error.message));
  } finally { await endpointRenderer.closeAndWait(); }

  const nested = structuredClone(session.ir);
  nested.nodes[group.id].ownership = "child";
  const nestedRenderer = new ReferenceVisualRenderer(nested, nested.compositions[0], project.root, resolve(project.root, ".cut-nested-cache"), session.pathFor);
  try {
    await assert.rejects(nestedRenderer.prepare(), (error: unknown) => error instanceof ReferenceAudioReactivePreparationError
      && error.code === "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE"
      && /direct scene-root visual/u.test(error.message));
  } finally { await nestedRenderer.closeAndWait(); await session.cleanup(); }
});

test("mapping-only revisions reuse verified decoded analysis while changing the prepared visual signal", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-reactive-remap-"));
  await mkdir(resolve(root, "media"));
  await writeFile(resolve(root, "media/master.wav"), wav(pulseSamples()));
  const cacheRoot = resolve(root, ".cut-shared-analysis-cache");

  const run = async (mappedTo: string) => {
    const ir = compile(source("media/master.wav", undefined, mappedTo)), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const session = await prepareReferenceVerifiedInputSession(ir, root, "master");
    const renderer = new ReferenceVisualRenderer(session.ir, session.ir.compositions[0], root, cacheRoot, session.pathFor);
    try {
      await renderer.prepare();
      const evidence = renderer.referenceAudioReactivePreparationEvidence()[0];
      assert.ok(evidence);
      return evidence;
    } finally { await renderer.closeAndWait(); await session.cleanup(); }
  };

  const before = await run("2"), after = await run("1.8");
  assert.equal(before.cacheStatus, "miss");
  assert.equal(after.cacheStatus, "hit");
  assert.equal(after.cacheKey, before.cacheKey, "decode/analysis identity excludes downstream visual mapping");
  assert.equal(after.planIntegrity, before.planIntegrity);
  assert.equal(after.inputPcmSha256, before.inputPcmSha256);
  assert.notEqual(after.producerIdentity, before.producerIdentity);
  assert.notEqual(after.preparedSignalSha256, before.preparedSignalSha256);
});
