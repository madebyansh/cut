import {
  referenceCompressorDbScale,
  referenceCompressorEnvelopeFloor,
  referenceCompressorLimits,
} from "./audio-compressor";

/**
 * Sidechain amount is the reduction produced by a 0 dBFS key. The bounded
 * 20:1 calibration keeps that promise compatible with the static 0.4
 * contract while letting CUT evaluate amount and threshold independently on
 * every destination sample. Attack and release share the same sample-domain
 * control path; only amount/threshold participate in the calibration bound.
 */
export const referenceSidechainLimits = Object.freeze({
  minimumAmountDb: -40,
  maximumAmountDb: 0,
  minimumThresholdDb: referenceCompressorLimits.minimumThresholdDb,
  maximumThresholdDb: referenceCompressorLimits.maximumThresholdDb,
  minimumAttackSeconds: referenceCompressorLimits.minimumAttackSeconds,
  maximumAttackSeconds: referenceCompressorLimits.maximumAttackSeconds,
  minimumReleaseSeconds: referenceCompressorLimits.minimumReleaseSeconds,
  maximumReleaseSeconds: referenceCompressorLimits.maximumReleaseSeconds,
  maximumEquivalentRatio: referenceCompressorLimits.maximumRatio,
  maximumAutomatedNodesPerComposition: 16,
  maximumAutomatedChannelSamplesPerComposition: 268_435_456,
  maximumAutomationEventsPerNode: 128,
  maximumAutomationExpressionCharactersPerNode: 65_536,
});

export type ReferenceSidechainControls = {
  amountDb: number;
  thresholdDb: number;
  attackSeconds: number;
  releaseSeconds: number;
};

export type ReferenceSidechainControlExpressions = {
  amountDb: string;
  thresholdDb: string;
  attackSeconds: string;
  releaseSeconds: string;
};

export type ReferenceSidechainState = {
  envelope: number;
};

export function createReferenceSidechainState(): ReferenceSidechainState {
  return { envelope: 0 };
}

export function referenceSidechainMaximumReductionDb(thresholdDb: number) {
  return -thresholdDb * (1 - 1 / referenceSidechainLimits.maximumEquivalentRatio);
}

export function referenceSidechainControlsAreCalibrated(amountDb: number, thresholdDb: number) {
  return -amountDb <= referenceSidechainMaximumReductionDb(thresholdDb) + Number.EPSILON;
}

/**
 * One stereo-linked sidechain frame. The key owns the peak detector while the
 * program channels receive one shared gain curve. A single envelope survives
 * every control change; controls are values for this exact output sample. The
 * direct reduction law is exactly equivalent to the old bounded
 * static compressor calibration, but does not delegate editorial semantics to
 * a backend processor or rebuild state at automation boundaries.
 */
export function processReferenceSidechainFrame(
  programLeft: number,
  programRight: number,
  keyLeft: number,
  keyRight: number,
  controls: ReferenceSidechainControls,
  sampleRate: number,
  state: ReferenceSidechainState,
): [number, number] {
  const detector = Math.max(Math.abs(keyLeft), Math.abs(keyRight));
  const time = detector > state.envelope ? controls.attackSeconds : controls.releaseSeconds;
  const coefficient = Math.exp(-1 / (time * sampleRate));
  state.envelope = coefficient * state.envelope + (1 - coefficient) * detector;

  let reductionDb = 0;
  if (state.envelope > referenceCompressorEnvelopeFloor) {
    const envelopeDb = referenceCompressorDbScale * Math.log(state.envelope);
    const thresholdSpanDb = -controls.thresholdDb;
    if (envelopeDb > controls.thresholdDb && thresholdSpanDb > referenceCompressorEnvelopeFloor) {
      reductionDb = controls.amountDb * ((envelopeDb - controls.thresholdDb) / thresholdSpanDb);
    }
  }
  const gain = 10 ** (reductionDb / 20);
  return [programLeft * gain, programRight * gain];
}

/**
 * Mirror the scalar recurrence in one FFmpeg aeval expression. The joined
 * input is program L/R followed by key L/R. Each output evaluator owns an
 * identical register bank and the same linked key detector, so both program
 * channels receive one continuously running gain curve. Register 8 is the
 * sole persistent envelope; every other register is overwritten each sample.
 */
export function referenceSidechainExpression(
  outputChannel: 0 | 1,
  controls: ReferenceSidechainControlExpressions,
  sampleRate: number,
) {
  return [
    `st(0,(${controls.amountDb}))`,
    `st(1,(${controls.thresholdDb}))`,
    `st(2,(${controls.attackSeconds}))`,
    `st(3,(${controls.releaseSeconds}))`,
    "st(4,max(abs(val(2)),abs(val(3))))",
    `st(5,if(gt(ld(4),ld(8)),exp(-1/(ld(2)*${sampleRate})),exp(-1/(ld(3)*${sampleRate}))))`,
    "st(6,ld(5)*ld(8)+(1-ld(5))*ld(4))",
    "st(8,ld(6))",
    `st(7,if(gt(ld(6),${referenceCompressorEnvelopeFloor}),${referenceCompressorDbScale}*log(ld(6)),-240))`,
    `st(9,if(gt(ld(7),ld(1)),ld(0)*((ld(7)-ld(1))/max(-(ld(1)),${referenceCompressorEnvelopeFloor})),0))`,
    `val(${outputChannel})*pow(10,ld(9)/20)`,
  ].join(";");
}
