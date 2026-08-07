const planFormat = "cut-reference-deesser-plan" as const;
const planVersion = 1 as const;

export const referenceDeEsserCoreLimits = Object.freeze({
  minimumSampleRate: 8_000,
  maximumSampleRate: 192_000,
  minimumCrossoverHz: 1_000,
  maximumCrossoverSampleRateRatio: 0.45,
  minimumAttackSeconds: 0.000_01,
  maximumAttackSeconds: 0.05,
  minimumReleaseSeconds: 0.001,
  maximumReleaseSeconds: 1,
  minimumThresholdDb: -72,
  maximumThresholdDb: -0.1,
  maximumReductionDb: 30,
  maximumAbsoluteInputSample: 64,
  maximumNodesPerComposition: 16,
  maximumChannelSamplesPerComposition: 268_435_456,
  maximumBatchFrames: 1_048_576,
});

export const referenceDeEsserCoreNonClaims = Object.freeze([
  "dialogue-or-phoneme classification",
  "lookahead or linear-phase crossover",
  "multiband dynamics or key equalization",
  "true-peak or loudness mastering",
  "portable floating-point byte identity",
  "production dialogue listening approval",
] as const);

export type ReferenceDeEsserConfig = Readonly<{
  sampleRate: number;
  crossoverHz: number;
  attackSeconds: number;
  releaseSeconds: number;
  leastSensitiveThresholdDb: number;
  mostSensitiveThresholdDb: number;
  maximumReductionDb: number;
}>;

export type ReferenceDeEsserControls = Readonly<{
  /** 0..1; jointly lowers threshold and increases available reduction. */
  intensity: number;
  /** 0..1; scales the reduction available at the current intensity. */
  amount: number;
}>;

export type ReferenceDeEsserControlExpressions = Readonly<{
  /** One bounded scalar expression evaluated for the exact output sample. */
  intensity: string;
  /** One bounded scalar expression evaluated for the exact output sample. */
  amount: string;
}>;

export type ReferenceDeEsserPlan = Readonly<ReferenceDeEsserConfig & {
  format: typeof planFormat;
  version: typeof planVersion;
  crossoverCoefficient: number;
  attackCoefficient: number;
  releaseCoefficient: number;
}>;

export type ReferenceDeEsserState = {
  lowLeft: number;
  lowRight: number;
  envelope: number;
  framesProcessed: number;
};

export type ReferenceDeEsserFrame = Readonly<{
  left: number;
  right: number;
  detector: number;
  envelope: number;
  thresholdDb: number;
  reductionDb: number;
  highBandGain: number;
}>;

export type ReferenceDeEsserWorkPlan = Readonly<{
  frames: number;
  nodes: number;
  channelSamples: number;
}>;

export type ReferenceDeEsserCoreErrorCode =
  | "CUT_AUDIO_DEESSER_CONFIG"
  | "CUT_AUDIO_DEESSER_CONTROL"
  | "CUT_AUDIO_DEESSER_STATE"
  | "CUT_AUDIO_DEESSER_PCM"
  | "CUT_AUDIO_DEESSER_WORK_LIMIT";

export class ReferenceDeEsserCoreError extends Error {
  constructor(
    readonly code: ReferenceDeEsserCoreErrorCode,
    message: string,
    readonly frame?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceDeEsserCoreError";
  }
}

function fail(code: ReferenceDeEsserCoreErrorCode, message: string, frame?: number): never {
  throw new ReferenceDeEsserCoreError(code, message, frame);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function closedDataObject(
  value: unknown,
  expected: readonly string[],
  code: ReferenceDeEsserCoreErrorCode,
  label: string,
  writable = false,
) {
  if (!isRecord(value)) fail(code, `${label} must be one plain data object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must have a plain or null prototype.`);
  const ownKeys = Reflect.ownKeys(value), wanted = [...expected].sort();
  if (ownKeys.some((key) => typeof key !== "string")) fail(code, `${label} cannot contain symbol properties.`);
  const keys = (ownKeys as string[]).sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} must contain exactly ${wanted.join(", ")}; unknown or missing properties are refused.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value), result = Object.create(null) as Record<string, unknown>;
  for (const key of wanted) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(code, `${label} properties must be enumerable data.`);
    if (writable && !descriptor.writable) fail(code, `${label} properties must be writable data.`);
    result[key] = descriptor.value;
  }
  return result;
}

function finiteNumber(value: unknown, code: ReferenceDeEsserCoreErrorCode, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code, `${label} must be one finite number.`);
  return value;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, code: ReferenceDeEsserCoreErrorCode, label: string) {
  const number = finiteNumber(value, code, label);
  if (number < minimum || number > maximum) fail(code, `${label} must stay between ${minimum} and ${maximum}.`);
  return number;
}

export function defaultReferenceDeEsserConfig(sampleRate: number): ReferenceDeEsserConfig {
  const validRate = finiteNumber(sampleRate, "CUT_AUDIO_DEESSER_CONFIG", "sampleRate");
  return Object.freeze({
    sampleRate: validRate,
    crossoverHz: Math.min(5_500, validRate * 0.4),
    attackSeconds: 0.000_5,
    releaseSeconds: 0.05,
    leastSensitiveThresholdDb: -6,
    mostSensitiveThresholdDb: -48,
    maximumReductionDb: 18,
  });
}

/**
 * Close and prepare the static processor topology. This is intentionally
 * separate from per-sample intensity/amount so a later signal integration can
 * retain one crossover and detector state across every property event.
 */
export function compileReferenceDeEsserPlan(config: ReferenceDeEsserConfig): ReferenceDeEsserPlan {
  const values = closedDataObject(config, [
    "sampleRate",
    "crossoverHz",
    "attackSeconds",
    "releaseSeconds",
    "leastSensitiveThresholdDb",
    "mostSensitiveThresholdDb",
    "maximumReductionDb",
  ], "CUT_AUDIO_DEESSER_CONFIG", "configuration");
  const sampleRate = boundedNumber(values.sampleRate, referenceDeEsserCoreLimits.minimumSampleRate, referenceDeEsserCoreLimits.maximumSampleRate, "CUT_AUDIO_DEESSER_CONFIG", "sampleRate");
  if (!Number.isInteger(sampleRate)) fail("CUT_AUDIO_DEESSER_CONFIG", "sampleRate must be an integer number of samples per second.");
  const crossoverHz = boundedNumber(values.crossoverHz, referenceDeEsserCoreLimits.minimumCrossoverHz, sampleRate * referenceDeEsserCoreLimits.maximumCrossoverSampleRateRatio, "CUT_AUDIO_DEESSER_CONFIG", "crossoverHz");
  const attackSeconds = boundedNumber(values.attackSeconds, referenceDeEsserCoreLimits.minimumAttackSeconds, referenceDeEsserCoreLimits.maximumAttackSeconds, "CUT_AUDIO_DEESSER_CONFIG", "attackSeconds");
  const releaseSeconds = boundedNumber(values.releaseSeconds, referenceDeEsserCoreLimits.minimumReleaseSeconds, referenceDeEsserCoreLimits.maximumReleaseSeconds, "CUT_AUDIO_DEESSER_CONFIG", "releaseSeconds");
  const leastSensitiveThresholdDb = boundedNumber(values.leastSensitiveThresholdDb, referenceDeEsserCoreLimits.minimumThresholdDb, referenceDeEsserCoreLimits.maximumThresholdDb, "CUT_AUDIO_DEESSER_CONFIG", "leastSensitiveThresholdDb");
  const mostSensitiveThresholdDb = boundedNumber(values.mostSensitiveThresholdDb, referenceDeEsserCoreLimits.minimumThresholdDb, referenceDeEsserCoreLimits.maximumThresholdDb, "CUT_AUDIO_DEESSER_CONFIG", "mostSensitiveThresholdDb");
  if (mostSensitiveThresholdDb >= leastSensitiveThresholdDb) fail("CUT_AUDIO_DEESSER_CONFIG", "mostSensitiveThresholdDb must be lower than leastSensitiveThresholdDb.");
  const maximumReductionDb = boundedNumber(values.maximumReductionDb, Number.EPSILON, referenceDeEsserCoreLimits.maximumReductionDb, "CUT_AUDIO_DEESSER_CONFIG", "maximumReductionDb");
  return Object.freeze({
    format: planFormat,
    version: planVersion,
    sampleRate,
    crossoverHz,
    attackSeconds,
    releaseSeconds,
    leastSensitiveThresholdDb,
    mostSensitiveThresholdDb,
    maximumReductionDb,
    crossoverCoefficient: Math.exp(-2 * Math.PI * crossoverHz / sampleRate),
    attackCoefficient: Math.exp(-1 / (attackSeconds * sampleRate)),
    releaseCoefficient: Math.exp(-1 / (releaseSeconds * sampleRate)),
  });
}

export function createReferenceDeEsserState(): ReferenceDeEsserState {
  return { lowLeft: 0, lowRight: 0, envelope: 0, framesProcessed: 0 };
}

function validatePlan(plan: ReferenceDeEsserPlan) {
  const values = closedDataObject(plan, [
    "format",
    "version",
    "sampleRate",
    "crossoverHz",
    "attackSeconds",
    "releaseSeconds",
    "leastSensitiveThresholdDb",
    "mostSensitiveThresholdDb",
    "maximumReductionDb",
    "crossoverCoefficient",
    "attackCoefficient",
    "releaseCoefficient",
  ], "CUT_AUDIO_DEESSER_CONFIG", "prepared plan");
  if (values.format !== planFormat || values.version !== planVersion) fail("CUT_AUDIO_DEESSER_CONFIG", "prepared plan has an unsupported format or version.");
  const expected = compileReferenceDeEsserPlan({
    sampleRate: values.sampleRate as number,
    crossoverHz: values.crossoverHz as number,
    attackSeconds: values.attackSeconds as number,
    releaseSeconds: values.releaseSeconds as number,
    leastSensitiveThresholdDb: values.leastSensitiveThresholdDb as number,
    mostSensitiveThresholdDb: values.mostSensitiveThresholdDb as number,
    maximumReductionDb: values.maximumReductionDb as number,
  });
  for (const name of ["crossoverCoefficient", "attackCoefficient", "releaseCoefficient"] as const) {
    const value = finiteNumber(values[name], "CUT_AUDIO_DEESSER_CONFIG", name);
    if (value !== expected[name]) fail("CUT_AUDIO_DEESSER_CONFIG", `${name} does not match the canonical static configuration.`);
  }
  return expected;
}

function validateControls(controls: ReferenceDeEsserControls) {
  const values = closedDataObject(controls, ["intensity", "amount"], "CUT_AUDIO_DEESSER_CONTROL", "controls");
  return {
    intensity: boundedNumber(values.intensity, 0, 1, "CUT_AUDIO_DEESSER_CONTROL", "intensity"),
    amount: boundedNumber(values.amount, 0, 1, "CUT_AUDIO_DEESSER_CONTROL", "amount"),
  };
}

function validateState(state: ReferenceDeEsserState) {
  const values = closedDataObject(state, ["lowLeft", "lowRight", "envelope", "framesProcessed"], "CUT_AUDIO_DEESSER_STATE", "state", true);
  for (const name of ["lowLeft", "lowRight", "envelope"] as const) {
    const value = finiteNumber(values[name], "CUT_AUDIO_DEESSER_STATE", name);
    if (Math.abs(value) > referenceDeEsserCoreLimits.maximumAbsoluteInputSample) fail("CUT_AUDIO_DEESSER_STATE", `${name} is outside the bounded internal PCM range.`);
  }
  const envelope = values.envelope as number, framesProcessed = values.framesProcessed;
  if (envelope < 0) fail("CUT_AUDIO_DEESSER_STATE", "envelope is outside the bounded detector range.");
  if (!Number.isSafeInteger(framesProcessed) || (framesProcessed as number) < 0 || (framesProcessed as number) >= Number.MAX_SAFE_INTEGER) fail("CUT_AUDIO_DEESSER_STATE", "framesProcessed must be one incrementable non-negative safe integer.");
}

function inputSample(value: unknown, channel: "left" | "right", frame?: number) {
  const number = finiteNumber(value, "CUT_AUDIO_DEESSER_PCM", `${channel} input sample`);
  if (Math.abs(number) > referenceDeEsserCoreLimits.maximumAbsoluteInputSample) fail("CUT_AUDIO_DEESSER_PCM", `${channel} input sample exceeds the bounded internal PCM range.`, frame);
  return number;
}

function flushDenormal(value: number) {
  return Math.abs(value) < 1e-30 ? 0 : value;
}

/**
 * Process one stereo frame. A causal one-pole low band and its exact
 * complementary residual form the split. The maximum residual magnitude is a
 * stereo-linked peak detector. Only the residual is attenuated; the same gain
 * applies to both channels. The crossover and envelope advance even at exact
 * bypass, so later automation observes warm continuous state.
 */
export function processReferenceDeEsserFrame(
  leftInput: number,
  rightInput: number,
  controlsInput: ReferenceDeEsserControls,
  plan: ReferenceDeEsserPlan,
  state: ReferenceDeEsserState,
): ReferenceDeEsserFrame {
  const canonicalPlan = validatePlan(plan);
  validateState(state);
  const controls = validateControls(controlsInput);
  return processValidatedReferenceDeEsserFrame(leftInput, rightInput, controls, canonicalPlan, state);
}

function processValidatedReferenceDeEsserFrame(
  leftInput: number,
  rightInput: number,
  controls: ReferenceDeEsserControls,
  canonicalPlan: ReferenceDeEsserPlan,
  state: ReferenceDeEsserState,
): ReferenceDeEsserFrame {
  const left = inputSample(leftInput, "left", state.framesProcessed), right = inputSample(rightInput, "right", state.framesProcessed);
  const oneMinusCrossover = 1 - canonicalPlan.crossoverCoefficient;
  const lowLeft = oneMinusCrossover * left + canonicalPlan.crossoverCoefficient * state.lowLeft;
  const lowRight = oneMinusCrossover * right + canonicalPlan.crossoverCoefficient * state.lowRight;
  const highLeft = left - lowLeft, highRight = right - lowRight;
  const detector = Math.max(Math.abs(highLeft), Math.abs(highRight));
  const envelopeCoefficient = detector > state.envelope ? canonicalPlan.attackCoefficient : canonicalPlan.releaseCoefficient;
  const envelope = flushDenormal(envelopeCoefficient * state.envelope + (1 - envelopeCoefficient) * detector);

  state.lowLeft = flushDenormal(lowLeft);
  state.lowRight = flushDenormal(lowRight);
  state.envelope = envelope;
  state.framesProcessed += 1;

  const thresholdDb = canonicalPlan.leastSensitiveThresholdDb
    + controls.intensity * (canonicalPlan.mostSensitiveThresholdDb - canonicalPlan.leastSensitiveThresholdDb);
  const depthDb = canonicalPlan.maximumReductionDb * controls.intensity * controls.amount;
  const envelopeDb = envelope > 1e-30 ? 20 * Math.log10(envelope) : -600;
  const activity = Math.max(0, Math.min(1, (envelopeDb - thresholdDb) / -thresholdDb));
  const reductionDb = -depthDb * activity;
  const highBandGain = 10 ** (reductionDb / 20);
  // Returning the original values exactly is part of the zero-control
  // contract, but state above still advances for automation continuity.
  const bypass = controls.intensity === 0 || controls.amount === 0 || reductionDb === 0;
  const outputLeft = bypass ? left : lowLeft + highLeft * highBandGain;
  const outputRight = bypass ? right : lowRight + highRight * highBandGain;
  if (!Number.isFinite(outputLeft) || !Number.isFinite(outputRight)) fail("CUT_AUDIO_DEESSER_PCM", "processor produced a non-finite output sample.", state.framesProcessed - 1);
  return Object.freeze({
    left: outputLeft,
    right: outputRight,
    detector,
    envelope,
    thresholdDb,
    reductionDb,
    highBandGain,
  });
}

/**
 * Mirror the scalar recurrence in one FFmpeg `aeval` expression. Each output
 * evaluator owns an identical register bank, reads both input channels and
 * therefore derives the same stereo-linked detector gain. Registers 0, 1 and
 * 5 are the persistent low-left, low-right and detector-envelope state; every
 * other register is overwritten on every sample. Controls alter only the
 * reduction law, so no event rebuilds or resets the static topology.
 */
export function referenceDeEsserExpression(
  outputChannel: 0 | 1,
  controls: ReferenceDeEsserControlExpressions,
  plan: ReferenceDeEsserPlan,
) {
  const canonical = validatePlan(plan);
  const lowRegister = outputChannel;
  const highRegister = outputChannel + 2;
  const dbScale = 20 / Math.log(10);
  const envelopeDb = `if(gt(ld(5),1e-30),${dbScale}*log(ld(5)),-600)`;
  const activity = `max(0,min(1,((${envelopeDb})-ld(8))/(-ld(8))))`;
  return [
    `st(0,(1-${canonical.crossoverCoefficient})*val(0)+${canonical.crossoverCoefficient}*ld(0))`,
    `st(1,(1-${canonical.crossoverCoefficient})*val(1)+${canonical.crossoverCoefficient}*ld(1))`,
    "st(2,val(0)-ld(0))",
    "st(3,val(1)-ld(1))",
    "st(4,max(abs(ld(2)),abs(ld(3))))",
    `st(5,if(gt(ld(4),ld(5)),${canonical.attackCoefficient}*ld(5)+(1-${canonical.attackCoefficient})*ld(4),${canonical.releaseCoefficient}*ld(5)+(1-${canonical.releaseCoefficient})*ld(4)))`,
    `st(6,(${controls.intensity}))`,
    `st(7,(${controls.amount}))`,
    `st(8,${canonical.leastSensitiveThresholdDb}+ld(6)*(${canonical.mostSensitiveThresholdDb}-${canonical.leastSensitiveThresholdDb}))`,
    `st(9,pow(10,(-${canonical.maximumReductionDb}*ld(6)*ld(7)*(${activity}))/20))`,
    `if(eq(ld(6),0)+eq(ld(7),0)+eq(ld(9),1),val(${outputChannel}),ld(${lowRegister})+ld(${highRegister})*ld(9))`,
  ].join(";");
}

export function planReferenceDeEsserWork(frames: number, nodes: number): ReferenceDeEsserWorkPlan {
  if (!Number.isSafeInteger(frames) || frames < 1) fail("CUT_AUDIO_DEESSER_WORK_LIMIT", "frames must be one positive safe integer.");
  if (!Number.isSafeInteger(nodes) || nodes < 1 || nodes > referenceDeEsserCoreLimits.maximumNodesPerComposition) {
    fail("CUT_AUDIO_DEESSER_WORK_LIMIT", `nodes must stay between 1 and ${referenceDeEsserCoreLimits.maximumNodesPerComposition}.`);
  }
  const channelSamples = frames * 2 * nodes;
  if (!Number.isSafeInteger(channelSamples) || channelSamples > referenceDeEsserCoreLimits.maximumChannelSamplesPerComposition) {
    fail("CUT_AUDIO_DEESSER_WORK_LIMIT", `DeEsser work requires ${Number.isSafeInteger(channelSamples) ? channelSamples : "an unsafe number of"} channel-samples; maximum is ${referenceDeEsserCoreLimits.maximumChannelSamplesPerComposition}.`);
  }
  return Object.freeze({ frames, nodes, channelSamples });
}

export function planReferenceDeEsserBatch(frames: number) {
  const work = planReferenceDeEsserWork(frames, 1);
  if (frames > referenceDeEsserCoreLimits.maximumBatchFrames) fail("CUT_AUDIO_DEESSER_WORK_LIMIT", `in-memory DeEsser batch has ${frames} frames; maximum is ${referenceDeEsserCoreLimits.maximumBatchFrames}.`);
  return work;
}

function denseControlArray(value: unknown, frames: number) {
  if (!Array.isArray(value)) fail("CUT_AUDIO_DEESSER_CONTROL", "time-varying controls must be one dense data array.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) fail("CUT_AUDIO_DEESSER_CONTROL", "time-varying controls must have the ordinary array or null prototype.");
  if (value.length !== frames) fail("CUT_AUDIO_DEESSER_CONTROL", `time-varying controls must contain exactly ${frames} frame values.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= frames))) {
    fail("CUT_AUDIO_DEESSER_CONTROL", "time-varying controls cannot contain symbol or non-index properties.");
  }
  if (ownKeys.length !== frames + 1) fail("CUT_AUDIO_DEESSER_CONTROL", "time-varying controls must be dense without missing frame values.");
  const descriptors = Object.getOwnPropertyDescriptors(value), result: ReferenceDeEsserControls[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const descriptor = descriptors[String(frame)];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail("CUT_AUDIO_DEESSER_CONTROL", "time-varying control entries must be enumerable data.", frame);
    result.push(Object.freeze(validateControls(descriptor.value as ReferenceDeEsserControls)));
  }
  return result;
}

/** Bounded in-memory conformance helper. Production integration may stream. */
export function processReferenceDeEsserPcm(
  interleavedStereo: Float64Array,
  controls: ReferenceDeEsserControls | readonly ReferenceDeEsserControls[],
  plan: ReferenceDeEsserPlan,
  state: ReferenceDeEsserState = createReferenceDeEsserState(),
) {
  if (!(interleavedStereo instanceof Float64Array) || interleavedStereo.length < 2 || interleavedStereo.length % 2 !== 0) {
    fail("CUT_AUDIO_DEESSER_PCM", "PCM must be one non-empty interleaved stereo Float64Array.");
  }
  const frames = interleavedStereo.length / 2;
  planReferenceDeEsserBatch(frames);
  const dynamicControls = Array.isArray(controls) ? denseControlArray(controls, frames) : undefined;
  const staticControls = dynamicControls ? undefined : Object.freeze(validateControls(controls as ReferenceDeEsserControls));
  const canonicalPlan = validatePlan(plan);
  validateState(state);
  if (state.framesProcessed > Number.MAX_SAFE_INTEGER - frames) fail("CUT_AUDIO_DEESSER_STATE", "batch would overflow framesProcessed.");
  const output = new Float64Array(interleavedStereo.length);
  for (let frame = 0; frame < frames; frame += 1) {
    const current = dynamicControls?.[frame] ?? staticControls!;
    const processed = processValidatedReferenceDeEsserFrame(interleavedStereo[frame * 2], interleavedStereo[frame * 2 + 1], current, canonicalPlan, state);
    output[frame * 2] = processed.left;
    output[frame * 2 + 1] = processed.right;
  }
  return Object.freeze({ output, state });
}
