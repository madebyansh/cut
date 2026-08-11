import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import {
  cutAudioAnalysisFormat,
  cutAudioAnalysisSemanticStatus,
  cutAudioAnalysisSha256,
  cutAudioAnalysisVersion,
  cutAudioAnalysisRoles,
  cutAudioAnalysisMoods,
  parseCutAudioAnalysis,
  type CutAudioAnalysis,
  type CutAudioAnalysisBackend,
  type CutAudioAnalysisLabel,
  type CutAudioAnalysisMood,
  type CutAudioAnalysisPolicy,
  type CutAudioAnalysisRole,
  type CutAudioAnalysisSource,
} from "./contracts";
import { analyzeCutAudioPcm } from "./dsp";

export type CutAudioSemanticLabelEstimate = Readonly<{
  label: CutAudioAnalysisLabel;
  scorePpm: number;
}>;

export type CutAudioSemanticWindowEstimate = Readonly<{
  startSample: number;
  endSample: number;
  labels: readonly CutAudioSemanticLabelEstimate[];
}>;

export type MaterializeCutAudioAnalysisInput = Readonly<{
  source: Omit<CutAudioAnalysisSource, "normalizedPcmSha256">;
  backend: CutAudioAnalysisBackend;
  policy: CutAudioAnalysisPolicy;
  normalizedMonoPcm: Float32Array;
  semanticWindows: readonly CutAudioSemanticWindowEstimate[];
  silenceThresholdDbfsMilli?: number;
}>;

function f32leBytes(samples: Float32Array) {
  const bytes = Buffer.allocUnsafe(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) bytes.writeFloatLE(samples[index], index * 4);
  return bytes;
}

export function cutNormalizedPcmSha256(samples: Float32Array) {
  return createHash("sha256").update(f32leBytes(samples)).digest("hex");
}

function semanticOrder(left: CutAudioSemanticLabelEstimate, right: CutAudioSemanticLabelEstimate) {
  return right.scorePpm - left.scorePpm || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
}

function dominant(labels: readonly CutAudioSemanticLabelEstimate[]) {
  const role = labels.find((item) => (cutAudioAnalysisRoles as readonly string[]).includes(item.label));
  if (!role) throw new Error("CUT_AUDIO_ANALYSIS_MATERIALIZE: every window needs at least one role estimate.");
  const mood = labels.find((item) => (cutAudioAnalysisMoods as readonly string[]).includes(item.label));
  return Object.freeze({
    role: role.label as CutAudioAnalysisRole,
    ...(mood ? { mood: mood.label as CutAudioAnalysisMood } : {}),
    confidencePpm: role.scorePpm,
  });
}

function sectionsFromWindows(
  windows: readonly Readonly<{
    range: Readonly<{ startSample: number; endSample: number }>;
    labels: readonly CutAudioSemanticLabelEstimate[];
  }>[],
) {
  const result: Array<{
    range: { startSample: number; endSample: number };
    role: CutAudioAnalysisRole;
    mood?: CutAudioAnalysisMood;
    confidencePpm: number;
  }> = [];
  for (const window of windows) {
    const current = dominant(window.labels), previous = result.at(-1);
    if (previous && previous.range.endSample === window.range.startSample
      && previous.role === current.role && previous.mood === current.mood) {
      previous.range.endSample = window.range.endSample;
      previous.confidencePpm = Math.min(previous.confidencePpm, current.confidencePpm);
    } else {
      result.push({
        range: { ...window.range },
        role: current.role,
        ...(current.mood ? { mood: current.mood } : {}),
        confidencePpm: current.confidencePpm,
      });
    }
  }
  return result;
}

/**
 * Combines exact PCM observations with model estimates. Model labels remain
 * suggestions; the returned report is reparsed under the closed public v1
 * contract before it leaves this function.
 */
export function materializeCutAudioAnalysis(input: MaterializeCutAudioAnalysisInput): CutAudioAnalysis {
  if (!(input.normalizedMonoPcm instanceof Float32Array)) {
    throw new Error("CUT_AUDIO_ANALYSIS_MATERIALIZE: normalizedMonoPcm must be one Float32Array.");
  }
  if (input.source.channels !== 1) {
    throw new Error("CUT_AUDIO_ANALYSIS_MATERIALIZE: normalized analysis PCM must declare one channel.");
  }
  if (input.source.durationSamples !== input.normalizedMonoPcm.length) {
    throw new Error("CUT_AUDIO_ANALYSIS_MATERIALIZE: source durationSamples must equal normalized PCM length.");
  }
  if (input.source.sampleRate < 1 || input.policy.hopSamples !== input.policy.windowSamples) {
    throw new Error("CUT_AUDIO_ANALYSIS_MATERIALIZE: v1 materialization requires contiguous nonoverlapping windows.");
  }
  const observed = analyzeCutAudioPcm(input.normalizedMonoPcm, {
    sampleRate: input.source.sampleRate,
    windowSamples: input.policy.windowSamples,
    hopSamples: input.policy.hopSamples,
    tempoMinBpm: input.policy.tempoMinBpm,
    tempoMaxBpm: input.policy.tempoMaxBpm,
    ...(input.silenceThresholdDbfsMilli === undefined ? {} : { silenceThresholdDbfsMilli: input.silenceThresholdDbfsMilli }),
  });
  if (!Array.isArray(input.semanticWindows) || input.semanticWindows.length !== observed.windows.length) {
    throw new Error("CUT_AUDIO_ANALYSIS_MATERIALIZE: semantic window count must equal observed window count.");
  }
  const windows = observed.windows.map((window, index) => {
    const semantic = input.semanticWindows[index];
    if (!semantic || semantic.startSample !== window.startSample || semantic.endSample !== window.endSample) {
      throw new Error(`CUT_AUDIO_ANALYSIS_MATERIALIZE: semantic window ${index} does not match observed PCM bounds.`);
    }
    const labels = [...semantic.labels].sort(semanticOrder);
    return Object.freeze({
      range: Object.freeze({ startSample: window.startSample, endSample: window.endSample }),
      rmsDbfsMilli: window.rmsDbfsMilli,
      peakDbfsMilli: window.peakDbfsMilli,
      onsetStrengthPpm: window.onsetStrengthPpm,
      labels: Object.freeze(labels.map((label) => Object.freeze({ ...label }))),
    });
  });
  const tempoCandidates = [...observed.tempoCandidates]
    .map((candidate) => ({ bpmMilli: candidate.bpmMilli, scorePpm: Math.max(1, candidate.confidencePpm) }))
    .sort((left, right) => right.scorePpm - left.scorePpm || left.bpmMilli - right.bpmMilli);
  const beats = observed.beatSamples.flatMap((sample) => {
    const window = observed.windows[Math.floor(sample / observed.hopSamples)];
    return window && window.onsetStrengthPpm > 0
      ? [{ sample, scorePpm: window.onsetStrengthPpm }]
      : [];
  });
  const source = Object.freeze({ ...input.source, normalizedPcmSha256: cutNormalizedPcmSha256(input.normalizedMonoPcm) });
  const body = Object.freeze({
    format: cutAudioAnalysisFormat,
    version: cutAudioAnalysisVersion,
    semanticStatus: cutAudioAnalysisSemanticStatus,
    source,
    backend: input.backend,
    policy: input.policy,
    windows: Object.freeze(windows),
    global: Object.freeze({ tempoCandidates: Object.freeze(tempoCandidates), beats: Object.freeze(beats) }),
    sections: Object.freeze(sectionsFromWindows(windows).map((section) => Object.freeze({
      ...section,
      range: Object.freeze(section.range),
    }))),
  });
  return parseCutAudioAnalysis(stableJsonStringify({ ...body, analysisSha256: cutAudioAnalysisSha256(body) }));
}
