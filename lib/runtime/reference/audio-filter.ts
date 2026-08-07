export type ReferenceStateVariableFilterKind = "highpass" | "lowpass";

/**
 * The reference backend deliberately owns one closed time-varying filter
 * algorithm instead of delegating semantic updates to backend commands. The
 * upper cutoff margin keeps tan(pi*f/fs) finite and well conditioned, while
 * the Q range bounds resonance and internal state growth.
 */
export const referenceStateVariableFilterLimits = Object.freeze({
  minimumCutoffHz: 1,
  maximumCutoffSampleRateRatio: 0.45,
  minimumQ: 0.1,
  maximumQ: 20,
  maximumAutomatedNodesPerComposition: 32,
  maximumAutomatedChannelSamplesPerComposition: 536_870_912,
  maximumAutomationEventsPerNode: 128,
  maximumAutomationExpressionCharactersPerNode: 32_768,
});

export function referenceStateVariableFilterMaximumCutoff(sampleRate: number) {
  return sampleRate * referenceStateVariableFilterLimits.maximumCutoffSampleRateRatio;
}

export type ReferenceStateVariableFilterState = {
  integrator1: number;
  integrator2: number;
};

export function createReferenceStateVariableFilterState(): ReferenceStateVariableFilterState {
  return { integrator1: 0, integrator2: 0 };
}

/**
 * One trapezoidal-integrator state-variable-filter sample. Coefficients are
 * recalculated from the exact CUT cutoff value for every output sample, but
 * both integrator states survive coefficient changes. This is the normative
 * scalar algorithm mirrored by the FFmpeg aeval expression below.
 */
export function processReferenceStateVariableFilterSample(
  kind: ReferenceStateVariableFilterKind,
  input: number,
  cutoffHz: number,
  q: number,
  sampleRate: number,
  state: ReferenceStateVariableFilterState,
) {
  const g = Math.tan(Math.PI * cutoffHz / sampleRate);
  const damping = 1 / q;
  const a1 = 1 / (1 + g * (g + damping));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = input - state.integrator2;
  const v1 = a1 * state.integrator1 + a2 * v3;
  const v2 = state.integrator2 + a2 * state.integrator1 + a3 * v3;
  state.integrator1 = 2 * v1 - state.integrator1;
  state.integrator2 = 2 * v2 - state.integrator2;
  return kind === "lowpass" ? v2 : input - damping * v1 - v2;
}

/**
 * Build the exact libav expression form of the scalar algorithm. Each mono
 * channel receives its own evaluator/register bank, so no channel state can
 * leak into the other. Registers 8 and 9 are the only persistent integrator
 * states; registers 0 through 7 are overwritten for every sample.
 */
export function referenceStateVariableFilterExpression(
  kind: ReferenceStateVariableFilterKind,
  cutoffExpression: string,
  qExpression: string,
  sampleRate: number,
) {
  const output = kind === "lowpass" ? "ld(7)" : "(val(0)-ld(1)*ld(6)-ld(7))";
  return [
    `st(0,tan(PI*(${cutoffExpression})/${sampleRate}))`,
    `st(1,1/(${qExpression}))`,
    "st(2,1/(1+ld(0)*(ld(0)+ld(1))))",
    "st(3,ld(0)*ld(2))",
    "st(4,ld(0)*ld(3))",
    "st(5,val(0)-ld(9))",
    "st(6,ld(2)*ld(8)+ld(3)*ld(5))",
    "st(7,ld(9)+ld(3)*ld(8)+ld(4)*ld(5))",
    "st(8,2*ld(6)-ld(8))",
    "st(9,2*ld(7)-ld(9))",
    output,
  ].join(";");
}
