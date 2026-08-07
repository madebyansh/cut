/**
 * Closed bounds for CUT's single-band peaking equalizer. They match the 0.4
 * alpha constructor contract while bounding every coefficient and the amount
 * of sample-domain work admitted by one composition.
 */
export const referenceParametricEqLimits = Object.freeze({
  minimumFrequencyHz: 1,
  maximumFrequencySampleRateRatio: 0.5,
  minimumGainDb: -192,
  maximumGainDb: 60,
  minimumQ: 0.001,
  maximumQ: 1_000,
  maximumAutomatedNodesPerComposition: 32,
  maximumAutomatedChannelSamplesPerComposition: 536_870_912,
  maximumAutomationEventsPerNode: 128,
  maximumAutomationExpressionCharactersPerNode: 32_768,
});

/**
 * A time-varying bell is a different numerical contract from one fixed bell.
 * CUT keeps the broad static alpha surface above, but admits coefficient
 * modulation only inside this deliberately well-conditioned professional
 * envelope. Every control (including a non-animated constructor control on a
 * node whose other control is animated) must stay inside it.
 */
export const referenceParametricEqAutomationLimits = Object.freeze({
  minimumFrequencyHz: 20,
  maximumFrequencySampleRateRatio: 0.45,
  minimumGainDb: -24,
  maximumGainDb: 24,
  minimumQ: 0.1,
  maximumQ: 20,
});

export type ReferenceParametricEqState = {
  integrator1: number;
  integrator2: number;
};

export function createReferenceParametricEqState(): ReferenceParametricEqState {
  return { integrator1: 0, integrator2: 0 };
}

/**
 * One normative trapezoidal-integrator state-variable bell sample. Unlike a
 * Direct Form I biquad, this topology never feeds retained output delays
 * through an abruptly replaced denominator polynomial. The two integrator
 * states remain alive across every coefficient change.
 *
 *   A = 10^(gainDb/40)
 *   g = tan(pi*frequency/sampleRate)
 *   k = 1/(Q*A)
 *   a1 = 1/(1 + g*(g+k)); a2 = g*a1; a3 = g*a2
 *   bell = input + k*(A^2-1)*band
 */
export function processReferenceParametricEqSample(
  input: number,
  frequencyHz: number,
  gainDb: number,
  q: number,
  sampleRate: number,
  state: ReferenceParametricEqState,
) {
  const amplitude = 10 ** (gainDb / 40);
  const g = Math.tan(Math.PI * frequencyHz / sampleRate);
  const k = 1 / (q * amplitude);
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = input - state.integrator2;
  const band = a1 * state.integrator1 + a2 * v3;
  const low = state.integrator2 + a2 * state.integrator1 + a3 * v3;
  state.integrator1 = 2 * band - state.integrator1;
  state.integrator2 = 2 * low - state.integrator2;
  return input + k * (amplitude * amplitude - 1) * band;
}

/**
 * Exact libav aeval spelling of the scalar recurrence above. Each call is
 * installed on one mono channel, so registers 8-9 are persistent channel-local
 * integrator state. Registers 0-7 are overwritten on every sample.
 */
export function referenceParametricEqExpression(
  frequencyExpression: string,
  gainDbExpression: string,
  qExpression: string,
  sampleRate: number,
) {
  return [
    `st(0,pow(10,(${gainDbExpression})/40))`,
    `st(1,tan(PI*(${frequencyExpression})/${sampleRate}))`,
    `st(2,1/((${qExpression})*ld(0)))`,
    "st(3,1/(1+ld(1)*(ld(1)+ld(2))))",
    "st(4,ld(1)*ld(3))",
    "st(5,ld(1)*ld(4))",
    "st(6,val(0)-ld(9))",
    "st(7,ld(3)*ld(8)+ld(4)*ld(6))",
    "st(6,ld(9)+ld(4)*ld(8)+ld(5)*ld(6))",
    "st(8,2*ld(7)-ld(8))",
    "st(9,2*ld(6)-ld(9))",
    "val(0)+ld(2)*(ld(0)*ld(0)-1)*ld(7)",
  ].join(";");
}
