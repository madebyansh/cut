export const referenceCompressorLimits = Object.freeze({
  minimumThresholdDb: -60,
  maximumThresholdDb: 0,
  minimumRatio: 1,
  maximumRatio: 20,
  minimumAttackSeconds: 0.000_01,
  maximumAttackSeconds: 2,
  minimumReleaseSeconds: 0.000_01,
  maximumReleaseSeconds: 9,
  minimumMakeupDb: -24,
  maximumMakeupDb: 24,
  maximumAutomatedNodesPerComposition: 16,
  maximumAutomatedChannelSamplesPerComposition: 268_435_456,
  maximumAutomationEventsPerNode: 128,
  maximumAutomationExpressionCharactersPerNode: 65_536,
});

export type ReferenceCompressorControls = {
  thresholdDb: number;
  ratio: number;
  attackSeconds: number;
  releaseSeconds: number;
  makeupDb: number;
};

export type ReferenceCompressorControlExpressions = {
  thresholdDb: string;
  ratio: string;
  attackSeconds: string;
  releaseSeconds: string;
  makeupDb: string;
};

export type ReferenceCompressorState = {
  envelope: number;
};

export function createReferenceCompressorState(): ReferenceCompressorState {
  return { envelope: 0 };
}

// CUT fixes this conversion constant as part of the scalar/runtime contract
// instead of relying on a backend-specific log10 spelling.
export const referenceCompressorDbScale = 20 / Math.log(10);
export const referenceCompressorEnvelopeFloor = 1e-12;

/**
 * One stereo-linked peak-compressor frame. The detector sees both channels,
 * while one envelope state survives every coefficient/control update. Attack
 * is selected while the detector is above the previous envelope; release is
 * selected otherwise. Controls are evaluated before this function for the
 * exact output sample being processed.
 */
export function processReferenceCompressorFrame(
  left: number,
  right: number,
  controls: ReferenceCompressorControls,
  sampleRate: number,
  state: ReferenceCompressorState,
): [number, number] {
  const detector = Math.max(Math.abs(left), Math.abs(right));
  const time = detector > state.envelope ? controls.attackSeconds : controls.releaseSeconds;
  const coefficient = Math.exp(-1 / (time * sampleRate));
  state.envelope = coefficient * state.envelope + (1 - coefficient) * detector;
  let reductionDb = 0;
  if (state.envelope > referenceCompressorEnvelopeFloor) {
    const envelopeDb = referenceCompressorDbScale * Math.log(state.envelope);
    if (envelopeDb > controls.thresholdDb) {
      reductionDb = -(envelopeDb - controls.thresholdDb) * (1 - 1 / controls.ratio);
    }
  }
  const gain = 10 ** ((reductionDb + controls.makeupDb) / 20);
  return [left * gain, right * gain];
}

/**
 * Mirror the scalar recurrence in one FFmpeg aeval expression. Each output
 * expression owns an identical register bank and evaluates the same linked
 * stereo detector, so both channels receive one gain curve without sharing
 * mutable registers between evaluator instances. Register 7 is the sole
 * persistent envelope; all other registers are overwritten every sample.
 */
export function referenceCompressorExpression(
  outputChannel: 0 | 1,
  controls: ReferenceCompressorControlExpressions,
  sampleRate: number,
) {
  return [
    `st(0,(${controls.thresholdDb}))`,
    `st(1,(${controls.ratio}))`,
    `st(2,(${controls.attackSeconds}))`,
    `st(3,(${controls.releaseSeconds}))`,
    `st(4,(${controls.makeupDb}))`,
    "st(5,max(abs(val(0)),abs(val(1))))",
    `st(6,if(gt(ld(5),ld(7)),exp(-1/(ld(2)*${sampleRate})),exp(-1/(ld(3)*${sampleRate}))))`,
    "st(8,ld(6)*ld(7)+(1-ld(6))*ld(5))",
    "st(7,ld(8))",
    `st(9,if(gt(ld(8),${referenceCompressorEnvelopeFloor}),if(gt(${referenceCompressorDbScale}*log(ld(8)),ld(0)),-((${referenceCompressorDbScale}*log(ld(8))-ld(0))*(1-1/ld(1))),0),0)+ld(4))`,
    `val(${outputChannel})*pow(10,ld(9)/20)`,
  ].join(";");
}
