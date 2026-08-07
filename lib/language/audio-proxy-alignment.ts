import { hash } from "../core/stable";

type CutAudioProxyAlignmentAnalysisV1 = Readonly<{
  sampleRate: 16_000;
  sampleFormat: "s16le-interleaved";
  windowFrames: 1_600;
  channels: number;
  frameCount: string;
  bytesPerVariant: string;
  frequencyCoverage: "dc-through-8khz";
}>;

type CutAudioProxyAlignmentVariant = Readonly<{
  fileSha256: string;
  streamIndex: number;
  sourceSampleRate: number;
  decodedSampleCount: string;
  analysisPcmSha256: string;
}>;

type CutAudioProxyAlignmentPolicyV1 = Readonly<{
  silenceRmsS16: 128;
  activeRmsS16: 256;
  maximumEnergyPowerRatio: 4;
  minimumGlobalCorrelationPpm: 970_000;
  minimumWindowCorrelationPpm: 900_000;
  maximumFailedChannelWindows: 0;
}>;

type CutAudioProxyAlignmentMetricsV1 = Readonly<{
  channelGlobalCorrelationPpm: readonly number[];
  minimumGlobalCorrelationPpm: number;
  minimumWindowCorrelationPpm: number;
  totalChannelWindows: string;
  silentChannelWindows: string;
  evaluatedChannelWindows: string;
  passedChannelWindows: string;
  failedChannelWindows: string;
  silenceMismatchChannelWindows: string;
  energyMismatchChannelWindows: string;
}>;

/** Historical 0.4-alpha proxy witness. Current lock creation emits v2. */
export type CutAudioProxyAlignmentV1 = Readonly<{
  format: "cut-audio-proxy-alignment";
  version: 1;
  method: "cut-windowed-s16-correlation-v1";
  analysis: CutAudioProxyAlignmentAnalysisV1;
  master: CutAudioProxyAlignmentVariant;
  proxy: CutAudioProxyAlignmentVariant;
  policy: CutAudioProxyAlignmentPolicyV1;
  metrics: CutAudioProxyAlignmentMetricsV1;
  decision: "equivalent";
  integrity: string;
}>;

type CutAudioProxyAlignmentAnalysisV2 = CutAudioProxyAlignmentAnalysisV1 & Readonly<{
  envelopeWindowFrames: 320;
  envelopeHopFrames: 160;
}>;

type CutAudioProxyAlignmentPolicyV2 = CutAudioProxyAlignmentPolicyV1 & Readonly<{
  maximumGainNormalizedResidualPowerPpm: 20_000;
  minimumEnvelopeEnergyRatioPpm: 850_000;
  maximumEnvelopeEnergyRatioPpm: 1_250_000;
  maximumFailedEnvelopeChannelWindows: 0;
}>;

type CutAudioProxyAlignmentMetricsV2 = CutAudioProxyAlignmentMetricsV1 & Readonly<{
  channelMaximumGainNormalizedResidualPowerPpm: readonly number[];
  maximumGainNormalizedResidualPowerPpm: number;
  channelMinimumEnvelopeEnergyRatioPpm: readonly number[];
  channelMaximumEnvelopeEnergyRatioPpm: readonly number[];
  minimumEnvelopeEnergyRatioPpm: number;
  maximumEnvelopeEnergyRatioPpm: number;
  totalEnvelopeChannelWindows: string;
  silentEnvelopeChannelWindows: string;
  evaluatedEnvelopeChannelWindows: string;
  passedEnvelopeChannelWindows: string;
  failedEnvelopeChannelWindows: string;
}>;

/**
 * Current pairwise proof that an editorial audio proxy preserves the master's
 * decoded sample timeline closely enough for preview/final substitution.
 *
 * The two PCM hashes are observations, not an equality requirement: ordinary
 * lossy proxies necessarily decode to different bytes. V2 closes two concrete
 * v1 false-equivalence classes: a masked independent component inside a 100 ms
 * window and a short dropout hidden by that window's aggregate correlation.
 */
export type CutAudioProxyAlignmentV2 = Readonly<{
  format: "cut-audio-proxy-alignment";
  version: 2;
  method: "cut-multiscale-s16-alignment-v2";
  analysis: CutAudioProxyAlignmentAnalysisV2;
  master: CutAudioProxyAlignmentVariant;
  proxy: CutAudioProxyAlignmentVariant;
  policy: CutAudioProxyAlignmentPolicyV2;
  metrics: CutAudioProxyAlignmentMetricsV2;
  decision: "equivalent";
  integrity: string;
}>;

export type CutAudioProxyAlignment = CutAudioProxyAlignmentV1 | CutAudioProxyAlignmentV2;
export type CutAudioProxyAlignmentWithoutIntegrity =
  | Omit<CutAudioProxyAlignmentV1, "integrity">
  | Omit<CutAudioProxyAlignmentV2, "integrity">;

export const cutAudioProxyAlignmentContractV1 = Object.freeze({
  format: "cut-audio-proxy-alignment" as const,
  version: 1 as const,
  method: "cut-windowed-s16-correlation-v1" as const,
  analysisSampleRate: 16_000 as const,
  analysisWindowFrames: 1_600 as const,
  maximumAnalysisBytesPerVariant: 64 * 1024 * 1024,
  silenceRmsS16: 128 as const,
  activeRmsS16: 256 as const,
  maximumEnergyPowerRatio: 4 as const,
  minimumGlobalCorrelationPpm: 970_000 as const,
  minimumWindowCorrelationPpm: 900_000 as const,
  maximumFailedChannelWindows: 0 as const,
});

export const cutAudioProxyAlignmentContractV2 = Object.freeze({
  ...cutAudioProxyAlignmentContractV1,
  version: 2 as const,
  method: "cut-multiscale-s16-alignment-v2" as const,
  envelopeWindowFrames: 320 as const,
  envelopeHopFrames: 160 as const,
  maximumGainNormalizedResidualPowerPpm: 20_000 as const,
  minimumEnvelopeEnergyRatioPpm: 850_000 as const,
  maximumEnvelopeEnergyRatioPpm: 1_250_000 as const,
  maximumFailedEnvelopeChannelWindows: 0 as const,
});

/** Current creation contract. Historical readers must dispatch on version. */
export const cutAudioProxyAlignmentContract = cutAudioProxyAlignmentContractV2;

/** Number of complete, at-most-10 ms-hop v2 envelope windows for one channel. */
export function cutAudioProxyEnvelopeWindowCount(frameCount: bigint) {
  if (frameCount < 1n) throw new Error("audio-proxy envelope frameCount must be positive");
  const window = BigInt(cutAudioProxyAlignmentContractV2.envelopeWindowFrames);
  const hop = BigInt(cutAudioProxyAlignmentContractV2.envelopeHopFrames);
  if (frameCount <= window) return 1n;
  const regular = (frameCount - window) / hop + 1n;
  const lastRegularStart = (regular - 1n) * hop;
  return regular + (lastRegularStart === frameCount - window ? 0n : 1n);
}

export function cutAudioProxyAlignmentIntegrity(value: CutAudioProxyAlignmentWithoutIntegrity) {
  return hash(value);
}

/**
 * Cache identity for an already-validated selected proxy. Pairwise master
 * evidence remains in the canonical lock and is rechecked before execution;
 * only facts that can change the selected proxy decode enter its cache key.
 */
export function cutAudioProxyExecutionIdentity(value: CutAudioProxyAlignment) {
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
