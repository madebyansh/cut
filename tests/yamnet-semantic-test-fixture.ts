import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stableJsonStringify } from "../lib/core/stable";
import { materializeCutYamnetSemanticAnalysis } from "../lib/audio-intelligence/yamnet-materialize";
import { cutYamnetLocalPolicy, type CutYamnetLocalAnalysis } from "../lib/audio-intelligence/yamnet-local";
import { cutYamnetAudioSetLabelMapSha256 } from "../lib/audio-intelligence/yamnet-taxonomy";
import { normalizeCutWaveForYamnet } from "../lib/audio-intelligence/wave-normalize";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function stableTop(scores: readonly number[], labels: readonly string[], topK: number) {
  return Object.freeze(scores.map((score, classIndex) => Object.freeze({ classIndex, label: labels[classIndex]!, score }))
    .sort((left, right) => right.score - left.score || left.classIndex - right.classIndex)
    .slice(0, topK));
}

export function createYamnetSemanticTestArtifact(
  sourceBytes: Buffer,
  locator: string,
  classScores: Readonly<Record<number, number>> = Object.freeze({ 132: 0.9 }),
) {
  const classMapBytes = readFileSync(resolve("adapters/audio-yamnet-local/yamnet_label_list.txt"));
  const labels = classMapBytes.toString("utf8").slice(0, -1).split("\n");
  const normalization = normalizeCutWaveForYamnet(sourceBytes, {
    bytes: sourceBytes.byteLength,
    sha256: hash(sourceBytes),
  });
  const pcm = normalization.pcmBytes, samples = pcm.byteLength / 4;
  const patchCount = samples <= cutYamnetLocalPolicy.patchSamples
    ? 1
    : 1 + Math.ceil((samples - cutYamnetLocalPolicy.patchSamples) / cutYamnetLocalPolicy.patchHopSamples);
  const rawScores = Buffer.alloc(patchCount * cutYamnetLocalPolicy.classCount * 4);
  for (let patchIndex = 0; patchIndex < patchCount; patchIndex += 1) {
    const patchOffset = patchIndex * cutYamnetLocalPolicy.classCount * 4;
    for (const [classIndexText, score] of Object.entries(classScores)) {
      const classIndex = Number(classIndexText);
      rawScores.writeFloatLE(score, patchOffset + classIndex * 4);
    }
  }
  const patchScores = Array.from({ length: patchCount }, (_, patchIndex) => Array.from(
    { length: cutYamnetLocalPolicy.classCount },
    (_, classIndex) => rawScores.readFloatLE((patchIndex * cutYamnetLocalPolicy.classCount + classIndex) * 4),
  ));
  const topK = 8;
  const aggregateScores = Array.from({ length: cutYamnetLocalPolicy.classCount }, (_, classIndex) => (
    patchScores.reduce((sum, scores) => sum + scores[classIndex]!, 0) / patchCount
  ));
  const providerBody = {
    format: "cut-yamnet-local-analysis" as const,
    version: 1 as const,
    provider: cutYamnetLocalPolicy.provider,
    input: {
      sampleFormat: "f32le" as const,
      sampleRate: 16_000 as const,
      channels: 1 as const,
      samples,
      bytes: pcm.byteLength,
      sha256: hash(pcm),
    },
    framing: {
      patchSamples: cutYamnetLocalPolicy.patchSamples,
      patchHopSamples: cutYamnetLocalPolicy.patchHopSamples,
      rightPadFinalPatch: true as const,
      patchCount,
    },
    rawScores: {
      classCount: cutYamnetLocalPolicy.classCount,
      sampleFormat: "f32le" as const,
      bytes: rawScores.byteLength,
      sha256: hash(rawScores),
    },
    stderr: { bytes: 0, sha256: hash(Buffer.alloc(0)) },
    topK,
    aggregateTopClasses: stableTop(aggregateScores, labels, topK),
    patches: Array.from({ length: patchCount }, (_, patchIndex) => ({
      patchIndex,
      startSample: patchIndex * cutYamnetLocalPolicy.patchHopSamples,
      validSamples: Math.min(
        cutYamnetLocalPolicy.patchSamples,
        samples - patchIndex * cutYamnetLocalPolicy.patchHopSamples,
      ),
      topClasses: stableTop(patchScores[patchIndex]!, labels, topK),
    })),
    authorities: {
      pythonSha256: hash("fixture-python"),
      adapterSha256: hash("fixture-adapter"),
      environmentTreeSha256: hash("fixture-environment"),
      liteRtTreeSha256: hash("fixture-litert"),
      modelSha256: hash("fixture-model"),
      classMapSha256: cutYamnetAudioSetLabelMapSha256,
    },
    declarations: {
      callerDeclared: true as const,
      liteRtLicense: "Apache-2.0",
      model: { name: "YAMNet fixture", revision: "fixture", license: "Apache-2.0", provenance: "test-only declared provenance" },
      classMap: { name: "AudioSet class map", revision: "fixture", license: "CC-BY-4.0", provenance: "test-only declared provenance" },
    },
    evidenceScope: {
      authority: cutYamnetLocalPolicy.authorityScope,
      licenses: cutYamnetLocalPolicy.licenseBoundary,
      locality: cutYamnetLocalPolicy.localityBoundary,
      inference: cutYamnetLocalPolicy.inferenceBoundary,
    },
  } satisfies Omit<CutYamnetLocalAnalysis, "analysisSha256">;
  const providerAnalysis: CutYamnetLocalAnalysis = Object.freeze({
    ...providerBody,
    analysisSha256: hash(stableJsonStringify(providerBody)),
  });
  const analysis = materializeCutYamnetSemanticAnalysis({
    source: Object.freeze({ locator, bytes: sourceBytes.byteLength, sha256: hash(sourceBytes) }),
    sourceBytes,
    normalization: normalization.evidence,
    pcm,
    providerAnalysis,
    rawScoreBytes: rawScores,
    classMapBytes,
  });
  const bytes = Buffer.from(`${stableJsonStringify(analysis)}\n`, "utf8");
  return Object.freeze({ analysis, bytes, fileSha256: hash(bytes) });
}
