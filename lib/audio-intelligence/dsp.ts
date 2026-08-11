export const cutAudioDspLimits = Object.freeze({
  maximumSamples: 60 * 60 * 384_000,
  maximumWindows: 4_096,
  maximumTempoCandidates: 3,
  maximumTempoCorrelationEvaluations: 4_000_000,
  maximumTempoPhaseEvaluations: 4_000_000,
  minimumSampleRate: 8_000,
  maximumSampleRate: 384_000,
  decibelFloorMilli: -120_000,
});

export type CutAudioDspPolicy = Readonly<{
  sampleRate: number;
  windowSamples: number;
  hopSamples: number;
  silenceThresholdDbfsMilli?: number;
  tempoMinBpm?: number;
  tempoMaxBpm?: number;
}>;

export type CutAudioDspWindow = Readonly<{
  startSample: number;
  endSample: number;
  rmsDbfsMilli: number;
  peakDbfsMilli: number;
  meanAbsolutePpm: number;
  onsetStrengthPpm: number;
}>;

export type CutAudioTempoCandidate = Readonly<{
  bpmMilli: number;
  confidencePpm: number;
  lagWindows: number;
}>;

export type CutAudioSampleSpan = Readonly<{
  startSample: number;
  endSample: number;
}>;

export type CutAudioDspAnalysis = Readonly<{
  sampleRate: number;
  durationSamples: number;
  windowSamples: number;
  hopSamples: number;
  windows: readonly CutAudioDspWindow[];
  silenceSpans: readonly CutAudioSampleSpan[];
  tempoCandidates: readonly CutAudioTempoCandidate[];
  beatSamples: readonly number[];
}>;

export class CutAudioDspError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CutAudioDspError";
  }
}

function fail(code: string, message: string): never {
  throw new CutAudioDspError(code, message);
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("CUT_AUDIO_DSP_POLICY", `${name} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function boundedNumber(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail("CUT_AUDIO_DSP_POLICY", `${name} must be finite and between ${minimum} and ${maximum}.`);
  }
  return value;
}

function dbfsMilli(amplitude: number) {
  if (amplitude <= 0) return cutAudioDspLimits.decibelFloorMilli;
  return Math.max(cutAudioDspLimits.decibelFloorMilli, Math.round(20_000 * Math.log10(amplitude)));
}

function ppm(value: number) {
  return Math.max(0, Math.min(1_000_000, Math.round(value * 1_000_000)));
}

function silenceSpans(windows: readonly CutAudioDspWindow[], threshold: number, durationSamples: number) {
  const result: CutAudioSampleSpan[] = [];
  let start: number | undefined, end = 0;
  for (const window of windows) {
    if (window.rmsDbfsMilli <= threshold) {
      start ??= window.startSample;
      end = window.endSample;
    } else if (start !== undefined) {
      result.push(Object.freeze({ startSample: start, endSample: Math.min(end, durationSamples) }));
      start = undefined;
    }
  }
  if (start !== undefined) result.push(Object.freeze({ startSample: start, endSample: Math.min(end, durationSamples) }));
  return Object.freeze(result);
}

type TempoWork = Readonly<{ lag: number; score: number; bpmMilli: number }>;

function arithmeticSeriesCount(first: number, last: number, count: number, label: string) {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !Number.isSafeInteger(count)
    || first < 0 || last < 0 || count < 0) {
    fail("CUT_AUDIO_DSP_WORK", `${label} cannot be represented as one safe non-negative integer series.`);
  }
  const result = count * (first + last) / 2;
  if (!Number.isSafeInteger(result)) fail("CUT_AUDIO_DSP_WORK", `${label} exceeds safe integer accounting.`);
  return result;
}

function tempoAnalysis(
  onset: readonly number[],
  sampleRate: number,
  hopSamples: number,
  tempoMinBpm: number,
  tempoMaxBpm: number,
  durationSamples: number,
) {
  if (onset.length < 4 || onset.every((value) => value === 0)) {
    return Object.freeze({ candidates: Object.freeze([] as CutAudioTempoCandidate[]), beats: Object.freeze([] as number[]) });
  }
  const minimumLag = Math.max(1, Math.ceil((60 * sampleRate) / (tempoMaxBpm * hopSamples)));
  const maximumLag = Math.min(onset.length - 2, Math.floor((60 * sampleRate) / (tempoMinBpm * hopSamples)));
  if (maximumLag < minimumLag) {
    return Object.freeze({ candidates: Object.freeze([] as CutAudioTempoCandidate[]), beats: Object.freeze([] as number[]) });
  }
  const lagCount = maximumLag - minimumLag + 1;
  const correlationEvaluations = arithmeticSeriesCount(
    onset.length - minimumLag,
    onset.length - maximumLag,
    lagCount,
    "tempo correlation work",
  );
  if (correlationEvaluations > cutAudioDspLimits.maximumTempoCorrelationEvaluations) {
    fail(
      "CUT_AUDIO_DSP_WORK",
      `tempo correlation requires ${correlationEvaluations} evaluations, exceeding ${cutAudioDspLimits.maximumTempoCorrelationEvaluations}.`,
    );
  }
  const scores: TempoWork[] = [];
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let cross = 0, left = 0, right = 0;
    for (let index = lag; index < onset.length; index += 1) {
      const a = onset[index], b = onset[index - lag];
      cross += a * b;
      left += a * a;
      right += b * b;
    }
    const score = left > 0 && right > 0 ? cross / Math.sqrt(left * right) : 0;
    if (score > 0) {
      scores.push(Object.freeze({ lag, score, bpmMilli: Math.round((60_000 * sampleRate) / (lag * hopSamples)) }));
    }
  }
  scores.sort((left, right) => right.score - left.score || left.lag - right.lag);
  const selected: TempoWork[] = [];
  for (const candidate of scores) {
    if (selected.some((item) => Math.abs(item.bpmMilli - candidate.bpmMilli) < 2_000)) continue;
    selected.push(candidate);
    if (selected.length === cutAudioDspLimits.maximumTempoCandidates) break;
  }
  const candidates = Object.freeze(selected.map((candidate) => Object.freeze({
    bpmMilli: candidate.bpmMilli,
    confidencePpm: ppm(candidate.score),
    lagWindows: candidate.lag,
  })));
  if (!selected.length) return Object.freeze({ candidates, beats: Object.freeze([] as number[]) });

  const best = selected[0];
  const phaseEvaluations = onset.length;
  if (phaseEvaluations > cutAudioDspLimits.maximumTempoPhaseEvaluations) {
    fail(
      "CUT_AUDIO_DSP_WORK",
      `tempo phase search requires ${phaseEvaluations} evaluations, exceeding ${cutAudioDspLimits.maximumTempoPhaseEvaluations}.`,
    );
  }
  let bestPhase = 0, bestPhaseScore = -1;
  for (let phase = 0; phase < best.lag; phase += 1) {
    let score = 0;
    for (let index = phase; index < onset.length; index += best.lag) score += onset[index];
    if (score > bestPhaseScore) { bestPhaseScore = score; bestPhase = phase; }
  }
  const beats: number[] = [];
  for (let index = bestPhase; index < onset.length; index += best.lag) {
    const sample = index * hopSamples;
    if (sample < durationSamples) beats.push(sample);
  }
  return Object.freeze({ candidates, beats: Object.freeze(beats) });
}

/**
 * Deterministic mono-PCM analysis used before semantic inference. The function
 * never mutates or aliases its input and emits only integer evidence.
 */
export function analyzeCutAudioPcm(samples: Float32Array, policy: CutAudioDspPolicy): CutAudioDspAnalysis {
  if (!(samples instanceof Float32Array)) fail("CUT_AUDIO_DSP_INPUT", "samples must be one Float32Array.");
  if (samples.length < 1 || samples.length > cutAudioDspLimits.maximumSamples) {
    fail("CUT_AUDIO_DSP_LIMIT", `samples must contain 1..${cutAudioDspLimits.maximumSamples} mono samples.`);
  }
  const sampleRate = positiveInteger(policy.sampleRate, "sampleRate", cutAudioDspLimits.maximumSampleRate);
  if (sampleRate < cutAudioDspLimits.minimumSampleRate) fail("CUT_AUDIO_DSP_POLICY", `sampleRate must be at least ${cutAudioDspLimits.minimumSampleRate}.`);
  const windowSamples = positiveInteger(policy.windowSamples, "windowSamples", samples.length);
  const hopSamples = positiveInteger(policy.hopSamples, "hopSamples", windowSamples);
  const silenceThreshold = Math.round(boundedNumber(policy.silenceThresholdDbfsMilli ?? -50_000, "silenceThresholdDbfsMilli", cutAudioDspLimits.decibelFloorMilli, 0));
  const tempoMinBpm = boundedNumber(policy.tempoMinBpm ?? 50, "tempoMinBpm", 20, 300);
  const tempoMaxBpm = boundedNumber(policy.tempoMaxBpm ?? 200, "tempoMaxBpm", 20, 400);
  if (tempoMaxBpm <= tempoMinBpm) fail("CUT_AUDIO_DSP_POLICY", "tempoMaxBpm must be greater than tempoMinBpm.");
  const windowCount = Math.ceil(samples.length / hopSamples);
  if (windowCount > cutAudioDspLimits.maximumWindows) {
    fail("CUT_AUDIO_DSP_LIMIT", `analysis would exceed ${cutAudioDspLimits.maximumWindows} windows.`);
  }
  const drafts: Array<Omit<CutAudioDspWindow, "onsetStrengthPpm"> & { rms: number }> = [];
  const onsetRaw: number[] = [];
  let previousRms = 0, maximumOnset = 0;
  for (let startSample = 0; startSample < samples.length; startSample += hopSamples) {
    const endSample = Math.min(samples.length, startSample + windowSamples);
    let square = 0, peak = 0, absolute = 0;
    for (let index = startSample; index < endSample; index += 1) {
      const value = samples[index];
      if (!Number.isFinite(value) || value < -1 || value > 1) {
        fail("CUT_AUDIO_DSP_SAMPLE", `sample ${index} must be finite and between -1 and 1.`);
      }
      const magnitude = Math.abs(value);
      square += value * value;
      absolute += magnitude;
      peak = Math.max(peak, magnitude);
    }
    const count = endSample - startSample;
    const rms = Math.sqrt(square / count), onset = Math.max(0, rms - previousRms);
    maximumOnset = Math.max(maximumOnset, onset);
    onsetRaw.push(onset);
    drafts.push({
      startSample,
      endSample,
      rmsDbfsMilli: dbfsMilli(rms),
      peakDbfsMilli: dbfsMilli(peak),
      meanAbsolutePpm: ppm(absolute / count),
      rms,
    });
    previousRms = rms;
  }
  const windows = Object.freeze(drafts.map((draft, index) => Object.freeze({
    startSample: draft.startSample,
    endSample: draft.endSample,
    rmsDbfsMilli: draft.rmsDbfsMilli,
    peakDbfsMilli: draft.peakDbfsMilli,
    meanAbsolutePpm: draft.meanAbsolutePpm,
    onsetStrengthPpm: maximumOnset > 0 ? ppm(onsetRaw[index] / maximumOnset) : 0,
  })));
  const onset = windows.map((window) => window.onsetStrengthPpm / 1_000_000);
  const tempo = tempoAnalysis(onset, sampleRate, hopSamples, tempoMinBpm, tempoMaxBpm, samples.length);
  return Object.freeze({
    sampleRate,
    durationSamples: samples.length,
    windowSamples,
    hopSamples,
    windows,
    silenceSpans: silenceSpans(windows, silenceThreshold, samples.length),
    tempoCandidates: tempo.candidates,
    beatSamples: tempo.beats,
  });
}
