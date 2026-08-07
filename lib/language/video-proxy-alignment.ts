import { hash } from "../core/stable";

type CutVideoProxyAlignmentAnalysis = Readonly<{
  width: 32;
  height: 32;
  pixelFormat: "rgb24";
  scaling: "fit-pad-black-area";
  frameCount: string;
  bytesPerFrame: 3_072;
  bytesPerVariant: string;
}>;

type CutVideoProxyAlignmentVariant = Readonly<{
  fileSha256: string;
  streamIndex: number;
  sourceWidth: number;
  sourceHeight: number;
  decodedFrameCount: string;
  cadenceRecordsSha256: string;
  analysisRgbSha256: string;
}>;

type CutVideoProxyAlignmentPolicy = Readonly<{
  maximumMeanAbsoluteErrorPpm: 100_000;
  maximumFrameMeanAbsoluteErrorPpm: 180_000;
  maximumFailedFrames: 0;
}>;

type CutVideoProxyAlignmentMetrics = Readonly<{
  meanAbsoluteErrorPpm: number;
  maximumFrameMeanAbsoluteErrorPpm: number;
  evaluatedFrames: string;
  passedFrames: string;
  failedFrames: string;
}>;

/**
 * A bounded decoded-picture witness proving that a selected proxy preserves
 * the master's frame-by-frame visual content closely enough for editorial
 * preview substitution. It is deliberately not a perceptual-quality score.
 */
export type CutVideoProxyAlignment = Readonly<{
  format: "cut-video-proxy-alignment";
  version: 1;
  method: "cut-frame-rgb-mae-v1";
  analysis: CutVideoProxyAlignmentAnalysis;
  master: CutVideoProxyAlignmentVariant;
  proxy: CutVideoProxyAlignmentVariant;
  policy: CutVideoProxyAlignmentPolicy;
  metrics: CutVideoProxyAlignmentMetrics;
  decision: "equivalent";
  integrity: string;
}>;

export type CutVideoProxyAlignmentWithoutIntegrity = Omit<CutVideoProxyAlignment, "integrity">;

export const cutVideoProxyAlignmentContract = Object.freeze({
  format: "cut-video-proxy-alignment" as const,
  version: 1 as const,
  method: "cut-frame-rgb-mae-v1" as const,
  analysisWidth: 32 as const,
  analysisHeight: 32 as const,
  bytesPerFrame: 3_072 as const,
  maximumAnalysisBytesPerVariant: 64 * 1024 * 1024,
  maximumMeanAbsoluteErrorPpm: 100_000 as const,
  maximumFrameMeanAbsoluteErrorPpm: 180_000 as const,
  maximumFailedFrames: 0 as const,
});

export function cutVideoProxyAlignmentIntegrity(value: CutVideoProxyAlignmentWithoutIntegrity) {
  return hash(value);
}

/**
 * Cache identity for a selected proxy after the canonical lock and private
 * verified-input session have authenticated the complete pairwise witness.
 */
export function cutVideoProxyExecutionIdentity(value: CutVideoProxyAlignment) {
  return Object.freeze({
    format: value.format,
    version: value.version,
    method: value.method,
    analysis: value.analysis,
    proxy: value.proxy,
    policy: value.policy,
    decision: value.decision,
  });
}
