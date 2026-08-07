import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { renderReferenceAudio, referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity } from "../lib/runtime/reference/audio-cache";
import { ReferenceLinkedSplitContractError, referenceLinkedSplitContract } from "../lib/runtime/reference/linked-split-config";
import { renderReferenceIr } from "./reference-render-test-helper";
import { referenceDirectNodeParents } from "../lib/runtime/reference/transition-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const exec = promisify(execFile);

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function splitSource(
  name: "JCut" | "LCut",
  options: { overlap?: string; incomingAt?: string; outgoingDuration?: string; incomingDuration?: string; body?: string } = {},
) {
  const overlap = options.overlap ?? "500ms";
  const incomingAt = options.incomingAt ?? "500ms";
  const outgoingDuration = options.outgoingDuration ?? "1s";
  const incomingDuration = options.incomingDuration ?? "1s";
  const body = options.body ?? `
      at 0s { Clip(source: outgoing, range: 0s ..< ${outgoingDuration}, duration: ${outgoingDuration}); }
      at ${incomingAt} { Clip(source: incoming, range: 0s ..< ${incomingDuration}, duration: ${incomingDuration}); }`;
  return `cut 0.4;
project "linked ${name}";
import { Clip, ${name} } from "@cut/edit";
asset outgoing: VideoAsset = video("media/outgoing.mkv");
asset incoming: VideoAsset = video("media/incoming.mkv");
timeline main(duration: 1500ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1500ms) {
    ${name}(overlap: ${overlap}) {${body}
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function splitNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.edit.jcut" || candidate.op === "cut.edit.lcut");
  assert.ok(node);
  return node;
}

function decodedVideoCadence() {
  return {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: "phase-floor",
    phaseNumerator: "0",
    streamIndex: 0,
    firstPts: "0",
    lastPts: "3",
    quantizedEndPts: "4",
    frameCount: "4",
    durationPresentCount: "4",
    durationCoverage: "complete",
    recordsSha256: "0".repeat(64),
    timeBase: rational(1, 4),
    frameRate: rational(4),
  } as const;
}

function decodedAudioSamples() {
  return {
    format: "cut-decoded-audio-samples",
    version: 2,
    method: "ffprobe-show-frames-audio-v2",
    quantization: "phase-floor-start-or-exact-end",
    trimSemantics: "decoder-output-sequence-plus-terminal-duration",
    phaseNumerator: "0",
    streamIndex: 1,
    firstPts: "0",
    lastPts: "47999",
    frameCount: "2",
    decoderOutputSampleCount: "48000",
    decoderPcmSha256: "0".repeat(64),
    decodedSampleCount: "48000",
    terminalTrimSamples: "0",
    durationPresentCount: "2",
    durationCoverage: "complete",
    recordsSha256: "0".repeat(64),
    timeBase: rational(1, 48_000),
    sampleRate: 48_000,
    leadingDiscontinuityFrameCount: "0",
    leadingDiscontinuitySampleCount: "0",
  } as const;
}

function fakeLocked(ir: CutAVIR) {
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [
          { index: 0, type: "video", frameRate: rational(4), timeBase: rational(1, 4), start: rational(0), duration: rational(1), width: 64, height: 64 },
          { index: 1, type: "audio", sampleRate: 48_000, channels: 1, timeBase: rational(1, 48_000), duration: rational(1) },
        ] },
        selected: {
          video: {
            streamIndex: 0,
            duration: rational(1),
            durationSource: "decoded-video-cadence",
            timeBase: rational(1, 4),
            frameRate: rational(4),
            decodedVideoCadence: decodedVideoCadence(),
          },
          audio: {
            streamIndex: 1,
            duration: rational(1),
            durationSource: "decoded-audio-samples",
            timeBase: rational(1, 48_000),
            decodedAudioSamples: decodedAudioSamples(),
          },
        },
      },
    } as never;
  }
  ir.determinism.semantic = "locked";
  return ir;
}

test("JCut and LCut pass public syntax through typed IR and strict loading", () => {
  for (const [name, expected] of [["JCut", "jcut"], ["LCut", "lcut"]] as const) {
    const compiled = compile(splitSource(name));
    const ir = loadCutAvIr(JSON.stringify(compiled));
    const node = splitNode(ir);
    const contract = referenceLinkedSplitContract(ir, ir.compositions[0], node, referenceDirectNodeParents(ir));
    assert.equal(node.domain, "av");
    assert.equal(node.op, `cut.edit.${expected}`);
    assert.deepEqual(node.interval, { start: rational(0), duration: rational(3, 2) });
    assert.deepEqual(node.inputs.overlap, { kind: "quantity", dimension: "time", magnitude: rational(1, 2), unit: "s" });
    assert.deepEqual(node.children.map((id) => ir.nodes[id].op), ["cut.edit.clip", "cut.edit.clip"]);
    assert.deepEqual(node.children.map((id) => ir.nodes[id].ownership), ["child", "child"]);
    assert.deepEqual(contract, {
      kind: expected,
      outgoingNodeId: node.children[0],
      incomingNodeId: node.children[1],
      overlapStart: rational(1, 2),
      overlapDuration: rational(1, 2),
      overlapEnd: rational(1),
      pictureCut: expected === "jcut" ? rational(1) : rational(1, 2),
      audioCut: expected === "jcut" ? rational(1, 2) : rational(1),
      parentStart: rational(0),
      parentDuration: rational(3, 2),
    });
    assert.ok(ir.modules.some((module) => module.specifier === "@cut/edit" && /^[a-f0-9]{64}$/u.test(module.integrity)));
  }
});

test("linked split source diagnostics are stable, located, closed, and reject fake overlap", () => {
  const diagnostic = (source: string, code: string, message: RegExp) => assert.throws(() => compile(source), (error) => {
    assert.ok(error instanceof CutCompileError);
    const item = error.result.diagnostics.find((candidate) => candidate.code === code);
    assert.ok(item, error.result.diagnostics.map((candidate) => `${candidate.code}: ${candidate.message}`).join("\n"));
    assert.match(item.message, message);
    assert.ok(item.span.start.line > 0 && item.span.start.column > 0);
    return true;
  });
  diagnostic(splitSource("JCut", { overlap: "0s" }), "CUT2094", /overlap must be positive/);
  diagnostic(splitSource("LCut", { overlap: "250ms" }), "CUT2094", /must exactly equal/);
  diagnostic(splitSource("JCut", { outgoingDuration: "500ms" }), "CUT2094", /positive overlap/);
  diagnostic(splitSource("LCut", { body: 'Clip(source: outgoing, range: 0s ..< 1s, duration: 1s);' }), "CUT2094", /exactly two/);
  diagnostic(splitSource("JCut").replace("overlap: 500ms", "overlap: 500ms, mystery: 1"), "CUT2059", /does not execute input/);
  diagnostic(splitSource("LCut").replace("overlap: 500ms", 'overlap: "500ms"'), "CUT2029", /expects Time/);
});

test("loaded linked split graphs revalidate ownership, exact grids, union, and overlap with source locations", () => {
  const base = () => fakeLocked(compile(splitSource("JCut")));
  assert.doesNotThrow(() => validateReferenceSession(base()));

  const expectContract = (ir: CutAVIR, message: RegExp) => assert.throws(
    () => referenceLinkedSplitContract(ir, ir.compositions[0], splitNode(ir), referenceDirectNodeParents(ir)),
    (error) => error instanceof ReferenceLinkedSplitContractError
      && error.code === "CUT_LINKED_SPLIT_CONTRACT"
      && error.source.module === "project.cut"
      && error.source.line > 0
      && message.test(error.message),
  );

  const ownership = base(); ownership.nodes[splitNode(ownership).children[0]].ownership = "root";
  expectContract(ownership, /ownership/);

  const union = base(); splitNode(union).interval.duration = rational(5, 4);
  expectContract(union, /ordered union/);

  const mismatch = base(); splitNode(mismatch).inputs.overlap = { kind: "quantity", dimension: "time", magnitude: rational(1, 4), unit: "s" };
  expectContract(mismatch, /exactly equal/);
  assert.throws(() => validateReferenceSession(mismatch), (error) => error instanceof ReferenceLinkedSplitContractError && error.source.module === "project.cut");

  const offGrid = base(), offGridNode = splitNode(offGrid), incoming = offGrid.nodes[offGridNode.children[1]];
  incoming.interval.start = rational(1, 3); incoming.interval.duration = rational(7, 6);
  offGridNode.inputs.overlap = { kind: "quantity", dimension: "time", magnitude: rational(2, 3), unit: "s" };
  expectContract(offGrid, /frame grid/);
});

function monoPcm16Wave(sampleRate: number, samples: readonly number[]) {
  const dataBytes = samples.length * 2, buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

function pcm24(buffer: Buffer) {
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4);
      blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14);
    }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + size % 2;
  }
  assert.deepEqual({ channels, sampleRate, blockAlign, bits }, { channels: 2, sampleRate: 48_000, blockAlign: 6, bits: 24 });
  return {
    frames: data.length / blockAlign,
    data,
    sample(frame: number) {
      const position = frame * blockAlign;
      let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
      if (value & 0x800000) value -= 0x1000000;
      return value / 0x800000;
    },
  };
}

async function generatedTake(root: string, name: string, color: string, constantSample: number) {
  const wave = resolve(root, `${name}.wav`), output = resolve(root, "media", `${name}.mkv`);
  await writeFile(wave, monoPcm16Wave(48_000, Array.from({ length: 48_000 }, () => constantSample)));
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=64x64:r=4:d=1`, "-i", wave,
    "-t", "1", "-c:v", "ffv1", "-pix_fmt", "yuv444p", "-c:a", "pcm_s24le", output,
  ]);
}

test("JCut and LCut execute crossed hard picture/audio boundaries at exact decoded frames and samples", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-split-e2e-"));
  await mkdir(resolve(root, "media"));
  await Promise.all([
    generatedTake(root, "outgoing", "red", 20_000),
    generatedTake(root, "incoming", "blue", -10_000),
  ]);

  const results = new Map<"JCut" | "LCut", { ir: CutAVIR; pcm: ReturnType<typeof pcm24>; pixels: number[][] }>();
  for (const name of ["JCut", "LCut"] as const) {
    const ir = compile(splitSource(name)), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const { composition } = validateReferenceSession(ir);

    const wave = resolve(root, `${name}.wav`);
    await renderReferenceAudio(ir, composition, root, wave);
    const decodedAudio = pcm24(await readFile(wave));
    assert.equal(decodedAudio.frames, 72_000);

    const output = resolve(root, `${name}.mp4`), raw = resolve(root, `${name}.rgb`);
    await renderReferenceIr(ir, root, output, "out");
    await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
    const frames = await readFile(raw), frameBytes = 64 * 64 * 3;
    assert.equal(frames.length, frameBytes * 6);
    const pixels = Array.from({ length: 6 }, (_, frame) => {
      const position = frame * frameBytes + (32 * 64 + 32) * 3;
      return [...frames.subarray(position, position + 3)];
    });
    results.set(name, { ir, pcm: decodedAudio, pixels });
  }

  const isRed = (pixel: number[]) => pixel[0] > 180 && pixel[2] < 60;
  const isBlue = (pixel: number[]) => pixel[2] > 180 && pixel[0] < 60;
  const j = results.get("JCut")!, l = results.get("LCut")!;
  assert.deepEqual(j.pixels.map((pixel) => isRed(pixel) ? "outgoing" : isBlue(pixel) ? "incoming" : "other"), ["outgoing", "outgoing", "outgoing", "outgoing", "incoming", "incoming"]);
  assert.deepEqual(l.pixels.map((pixel) => isRed(pixel) ? "outgoing" : isBlue(pixel) ? "incoming" : "other"), ["outgoing", "outgoing", "incoming", "incoming", "incoming", "incoming"]);

  const outgoing = j.pcm.sample(12_000), incoming = j.pcm.sample(60_000);
  assert.ok(outgoing > .4 && incoming < -.2, `${outgoing}, ${incoming}`);
  const near = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) < .000002, `${label}: ${actual} != ${expected}`);
  near(j.pcm.sample(23_999), outgoing, "J start-1 outgoing");
  near(j.pcm.sample(24_000), incoming, "J overlap start incoming-audio cut");
  near(j.pcm.sample(47_999), incoming, "J overlap end-1 incoming audio");
  near(j.pcm.sample(48_000), incoming, "J picture-cut sample remains incoming audio");
  near(l.pcm.sample(23_999), outgoing, "L picture-cut start-1 outgoing");
  near(l.pcm.sample(24_000), outgoing, "L overlap start retains outgoing audio");
  near(l.pcm.sample(47_999), outgoing, "L overlap end-1 outgoing audio");
  near(l.pcm.sample(48_000), incoming, "L overlap end incoming-audio cut");
  assert.notDeepEqual(j.pcm.data, l.pcm.data, "J/L must retain distinct audio-cut placement during the picture/audio split interval");

  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version linked-split-test\nconfiguration: deterministic");
  const audioPlan = (ir: CutAVIR) => createReferenceAudioCachePlan(ir, ir.compositions[0], referenceMasterAudioRootIds(ir, ir.compositions[0]), toolchain);
  assert.notEqual(audioPlan(j.ir).key, audioPlan(l.ir).key, "moving the hard audio boundary from overlap start to end must invalidate pre-master PCM");
  assert.notEqual(j.ir.buildId, l.ir.buildId, "JCut and LCut remain distinct audiovisual semantics");
  assert.ok(diffCutAVIR(j.ir, l.ir).changes.some((change) => change.entity === "node"));

  const previous = createIncrementalRenderPlan(j.ir, "main").manifest;
  const next = createIncrementalRenderPlan(l.ir, "main", previous);
  assert.ok(splitNode(l.ir).children.every((id) => next.nodes.find((item) => item.id === id)?.status === "hit"));
  assert.equal(next.nodes.find((item) => item.id === splitNode(l.ir).id)?.status, "miss");
  assert.ok(next.scenes.every((scene) => scene.status === "miss"));
});

test("OTIO exports exact linked picture/audio boundaries through the closed editorial profile", () => {
  const ir = compile(splitSource("JCut"));
  const exported = exportCutTimelineToOtio(ir);
  assert.equal(exported.report.status, "lossy-editorial");
  assert.ok(exported.report.editorialProfile);
  assert.ok(exported.report.unsupportedSemantics.every((issue) => issue.code === "CUT_OTIO_RESOURCE_UNLOCKED"));
  const profile = (exported.timeline.metadata.cut as {
    editorial_profile: { linkedCuts: Array<{ kind: string; picture: { at: unknown }; audio: { at: unknown } }> };
  }).editorial_profile;
  assert.equal(profile.linkedCuts.length, 1);
  assert.equal(profile.linkedCuts[0].kind, "j-cut");
  assert.notDeepEqual(profile.linkedCuts[0].picture.at, profile.linkedCuts[0].audio.at);
  assert.equal(exported.report.exported.videoTracks, 1);
  assert.equal(exported.report.exported.audioTracks, 1);
  assert.equal(exported.report.exported.clipInstances, 4);
});
