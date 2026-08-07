import { createHash } from "node:crypto";
import type { CutAVIR, IRComposition } from "../lib/language/ir";
import { stableJsonStringify } from "../lib/core/stable";
import {
  prepareReferenceAudioStems as prepareLockedReferenceAudioStems,
  renderReferenceAudioStems as renderLockedReferenceAudioStems,
  type ReferenceAudioStemRenderOptions,
} from "../lib/runtime/reference/stems";

export const testStemLockSha256 = "1f4c8b3f5f17cb1770bf40ccf39a71940c8579c3e14c6c66ea54766e4ab91d10";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Silent stereo signed-24-bit PCM frames in a canonical WAVE. */
export function testPcm24Wave(samples = 1, sampleRate = 1) {
  const dataBytes = samples * 6, result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0, "ascii"); result.writeUInt32LE(36 + dataBytes, 4); result.write("WAVE", 8, "ascii");
  result.write("fmt ", 12, "ascii"); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20);
  result.writeUInt16LE(2, 22); result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 6, 28);
  result.writeUInt16LE(6, 32); result.writeUInt16LE(24, 34); result.write("data", 36, "ascii"); result.writeUInt32LE(dataBytes, 40);
  return result;
}

/** Complete canonical v5 review fixture; no production code consumes it. */
export function testReferenceStemManifest(lockBytes: string | Uint8Array, waveBytes = testPcm24Wave(), name = "dialogue", durationSeconds = 1, sampleRate = 1) {
  const samples = durationSeconds * sampleRate;
  return `${stableJsonStringify({
    format: "cut-reference-stems",
    version: 5,
    runtime: "cut-reference/test",
    lock: { sha256: sha256(lockBytes) },
    buildId: sha256("test stem build"),
    composition: {
      id: "composition:test",
      name: "Review fixture",
      duration: { numerator: String(durationSeconds), denominator: "1" },
      sampleRate,
      channels: 2,
      sampleFormat: "s24le",
      samples,
    },
    relationship: {
      stage: "pre-master",
      mix: "decoded-sum-with-s24-rounding",
      normalization: "none",
      peakValidation: "exact-f32le-before-quantization",
      quantization: "nearest-ties-to-even",
    },
    stems: [{
      name,
      role: "dialogue",
      kind: "program",
      auxiliaryInputs: [],
      sidechainInputs: [],
      nodeId: "audio:test",
      graphHash: sha256("test stem graph"),
      file: `${name}.wav`,
      sha256: sha256(waveBytes),
      bytes: waveBytes.byteLength,
      sampleRate,
      channels: 2,
      sampleFormat: "s24le",
      samples,
      peak: {
        format: "cut-reference-audio-peak-scan",
        version: 1,
        sampleFormat: "f32le",
        channels: 2,
        expectedFrames: samples,
        observedFrames: samples,
        expectedBytes: samples * 8,
        observedBytes: samples * 8,
        thresholdDbfs: -1,
        thresholdLinear: 0.8912509381337456,
        silent: true,
        peakLinear: 0,
        peakDbfs: null,
        peakFrame: null,
        peakChannel: null,
        peakChannelName: null,
        peakSample: null,
      },
    }],
  })}\n`;
}

type TestReferenceAudioStemRenderOptions = Omit<ReferenceAudioStemRenderOptions, "lockSha256"> & { lockSha256?: string };

/** Test-only convenience. Production callers must supply the verified digest. */
export function renderReferenceAudioStems(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  outputDirectory: string,
  options: TestReferenceAudioStemRenderOptions = {},
) {
  return renderLockedReferenceAudioStems(ir, composition, projectRoot, outputDirectory, {
    ...options,
    lockSha256: options.lockSha256 ?? testStemLockSha256,
  });
}

/** Test-only convenience. Production callers must supply the verified digest. */
export function prepareReferenceAudioStems(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  outputDirectory: string,
  options: TestReferenceAudioStemRenderOptions = {},
) {
  return prepareLockedReferenceAudioStems(ir, composition, projectRoot, outputDirectory, {
    ...options,
    lockSha256: options.lockSha256 ?? testStemLockSha256,
  });
}
