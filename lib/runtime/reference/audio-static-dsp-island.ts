import { constants as fsConstants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { multiplyRational, rational } from "../../language/rational";
import { referenceAudioNodeConfig } from "./audio-config";

export const referenceStaticDspIslandLimits = Object.freeze({
  maximumBranches: 8,
  maximumProcessorsPerBranch: 16,
  chunkFrames: 65_536,
  maximumChunkBytes: 8 * 65_536,
});

type GainProcessor = Readonly<{
  kind: "gain";
  coefficient: number;
}>;

type StateVariableFilterProcessor = Readonly<{
  kind: "state-variable-filter";
  response: "highpass" | "lowpass";
  damping: number;
  a1: number;
  a2: number;
  a3: number;
}>;

type DeEsserProcessor = Readonly<{
  kind: "deesser";
  crossoverCoefficient: number;
  attackCoefficient: number;
  releaseCoefficient: number;
  thresholdDb: number;
  depthDb: number;
}>;

type CompressorProcessor = Readonly<{
  kind: "compressor";
  attackCoefficient: number;
  releaseCoefficient: number;
  thresholdDb: number;
  ratioFactor: number;
  makeupDb: number;
}>;

export type ReferenceStaticDspIslandProcessor =
  | GainProcessor
  | StateVariableFilterProcessor
  | DeEsserProcessor
  | CompressorProcessor;

export type ReferenceStaticDspIslandBranch = Readonly<{
  rootId: string;
  boundaryRootIds: readonly string[];
  /** Processor order is the executable inner-to-outer order. */
  processors: readonly ReferenceStaticDspIslandProcessor[];
}>;

export type ReferenceStaticDspIslandPlan = Readonly<{
  format: "cut-reference-static-dsp-island-plan";
  version: 1;
  sampleRate: number;
  frames: number;
  branches: readonly ReferenceStaticDspIslandBranch[];
}>;

type FilterState = { integrator1Left: number; integrator2Left: number; integrator1Right: number; integrator2Right: number };
type DeEsserState = { lowLeft: number; lowRight: number; envelope: number };
type CompressorState = { envelope: number };
type ProcessorState = undefined | FilterState | DeEsserState | CompressorState;

export type ReferenceStaticDspIslandState = {
  branches: ProcessorState[][];
  framesProcessed: number;
};

type ReferenceStaticSidechainBranch = Readonly<{
  nodeId: string;
  programRootIds: readonly string[];
  amountDb: number;
  thresholdDb: number;
  attackCoefficient: number;
  releaseCoefficient: number;
}>;

type ReferenceStaticSidechainMixItem =
  | Readonly<{ kind: "key" }>
  | Readonly<{ kind: "sidechain"; branchIndex: number }>;

export type ReferenceStaticSidechainIslandPlan = Readonly<{
  format: "cut-reference-static-sidechain-island-plan";
  version: 1;
  sampleRate: number;
  frames: number;
  keyRootIds: readonly string[];
  branches: readonly ReferenceStaticSidechainBranch[];
  mixOrder: readonly ReferenceStaticSidechainMixItem[];
}>;

export type ReferenceStaticSidechainIslandState = {
  envelopes: number[];
  framesProcessed: number;
};

export type RenderReferenceStaticDspBoundary = (
  rootIds: readonly string[],
  output: string,
) => Promise<void>;

export class ReferenceStaticDspIslandError extends Error {
  constructor(readonly code: "CUT_AUDIO_STATIC_DSP_SOURCE" | "CUT_AUDIO_STATIC_DSP_WORK_LIMIT", message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceStaticDspIslandError";
  }
}

function dbLinear(db: number) {
  return 10 ** (db / 20);
}

function hasStaticProperties(node: IRNode) {
  return Reflect.ownKeys(node.properties).length === 0;
}

function processorPlan(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceStaticDspIslandProcessor | undefined {
  // Reference audio processors consume their already placed child stream for
  // the complete composition clock. Their interval records structural child
  // coverage; it is not a separate effect gate in audioNode. The island keeps
  // that same full-stream execution and refuses only actual automation.
  if (!hasStaticProperties(node)) return undefined;
  const config = referenceAudioNodeConfig(ir, composition, node);
  if (node.op === "cut.audio.gain" && config?.kind === "gain") {
    // FFmpeg volume's default precision is float. Preserve both its float
    // coefficient and its input/output float barriers exactly.
    return Object.freeze({ kind: "gain", coefficient: Math.fround(dbLinear(config.amountDb)) });
  }
  if ((node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass")
    && config
    && (config.kind === "highpass" || config.kind === "lowpass")
    && config.kind === (node.op === "cut.audio.highpass" ? "highpass" : "lowpass")) {
    const g = Math.tan(Math.PI * config.frequency / composition.sampleRate);
    const damping = 1 / config.q;
    const a1 = 1 / (1 + g * (g + damping));
    const a2 = g * a1;
    const a3 = g * a2;
    return Object.freeze({
      kind: "state-variable-filter",
      response: config.kind,
      damping,
      a1,
      a2,
      a3,
    });
  }
  if (node.op === "cut.audio.deesser" && config?.kind === "deesser") {
    return Object.freeze({
      kind: "deesser",
      crossoverCoefficient: config.plan.crossoverCoefficient,
      attackCoefficient: config.plan.attackCoefficient,
      releaseCoefficient: config.plan.releaseCoefficient,
      thresholdDb: config.plan.leastSensitiveThresholdDb
        + config.intensity * (config.plan.mostSensitiveThresholdDb - config.plan.leastSensitiveThresholdDb),
      depthDb: config.plan.maximumReductionDb * config.intensity * config.amount,
    });
  }
  if (node.op === "cut.audio.compressor" && config?.kind === "compressor") {
    return Object.freeze({
      kind: "compressor",
      attackCoefficient: Math.exp(-1 / (config.attackSeconds * composition.sampleRate)),
      releaseCoefficient: Math.exp(-1 / (config.releaseSeconds * composition.sampleRate)),
      thresholdDb: config.thresholdDb,
      ratioFactor: 1 - 1 / config.ratio,
      makeupDb: config.makeupDb,
    });
  }
  return undefined;
}

function branchPlan(
  ir: CutAVIR,
  composition: IRComposition,
  rootId: string,
): ReferenceStaticDspIslandBranch | undefined {
  const root = ir.nodes[rootId];
  // The outer Gain supplies a closed float-precision boundary before amix.
  // Without it, libav may negotiate a double branch and the island would need
  // a different, explicitly versioned mix law.
  if (!root || root.op !== "cut.audio.gain") return undefined;
  const outerToInner: ReferenceStaticDspIslandProcessor[] = [];
  let node = root;
  let hasExpensiveProcessor = false;
  let boundaryRootIds: readonly string[] | undefined;
  for (let depth = 0; depth < referenceStaticDspIslandLimits.maximumProcessorsPerBranch; depth += 1) {
    const processor = processorPlan(ir, composition, node);
    if (!processor || node.children.length < 1) return undefined;
    outerToInner.push(processor);
    if (processor.kind !== "gain") hasExpensiveProcessor = true;
    if (node.children.length === 1) {
      const child = ir.nodes[node.children[0]];
      if (child && processorPlan(ir, composition, child)) {
        node = child;
        continue;
      }
    }
    boundaryRootIds = Object.freeze([...node.children]);
    break;
  }
  if (!boundaryRootIds?.length || !hasExpensiveProcessor) return undefined;
  return Object.freeze({
    rootId,
    boundaryRootIds,
    processors: Object.freeze(outerToInner.reverse()),
  });
}

/**
 * Plan only a closed static processor island whose float precision barriers
 * are fully known. Any automation, unsupported node, or ambiguous format
 * negotiation returns undefined and retains FFmpeg exactly.
 */
export function planReferenceStaticDspIsland(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
): ReferenceStaticDspIslandPlan | undefined {
  if (rootIds.length < 1 || rootIds.length > referenceStaticDspIslandLimits.maximumBranches) return undefined;
  const exactFrames = multiplyRational(composition.duration, rational(composition.sampleRate));
  if (exactFrames.denominator !== "1") return undefined;
  const frames = Number(exactFrames.numerator);
  if (!Number.isSafeInteger(frames) || frames < 1) return undefined;
  const branches = rootIds.map((id) => branchPlan(ir, composition, id));
  if (branches.some((branch) => branch === undefined)) return undefined;
  return Object.freeze({
    format: "cut-reference-static-dsp-island-plan",
    version: 1,
    sampleRate: composition.sampleRate,
    frames,
    branches: Object.freeze(branches as ReferenceStaticDspIslandBranch[]),
  });
}

/** Closed static Sidechain buses mixed with their one common dry/key bus. */
export function planReferenceStaticSidechainIsland(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
): ReferenceStaticSidechainIslandPlan | undefined {
  if (rootIds.length !== 1) return undefined;
  const root = ir.nodes[rootIds[0]];
  if (!root || root.op !== "cut.audio.submix" || !hasStaticProperties(root)
    || root.children.length < 2 || root.children.length > referenceStaticDspIslandLimits.maximumBranches + 1) return undefined;
  const exactFrames = multiplyRational(composition.duration, rational(composition.sampleRate));
  if (exactFrames.denominator !== "1") return undefined;
  const frames = Number(exactFrames.numerator);
  if (!Number.isSafeInteger(frames) || frames < 1) return undefined;

  const sidechainBuses: Array<{ busId: string; node: IRNode }> = [];
  for (const busId of root.children) {
    const bus = ir.nodes[busId];
    if (!bus || bus.op !== "cut.audio.bus" || !hasStaticProperties(bus) || bus.children.length < 1) return undefined;
    if (bus.children.length === 1 && ir.nodes[bus.children[0]]?.op === "cut.audio.sidechain") {
      sidechainBuses.push({ busId, node: ir.nodes[bus.children[0]] });
    }
  }
  if (!sidechainBuses.length || sidechainBuses.length > referenceStaticDspIslandLimits.maximumBranches) return undefined;
  const sourceIds = new Set<string>();
  const branches: ReferenceStaticSidechainBranch[] = [];
  for (const { node } of sidechainBuses) {
    if (!hasStaticProperties(node) || node.children.length < 1) return undefined;
    const config = referenceAudioNodeConfig(ir, composition, node);
    if (config?.kind !== "sidechain") return undefined;
    sourceIds.add(config.sourceNodeId);
    branches.push(Object.freeze({
      nodeId: node.id,
      programRootIds: Object.freeze([...node.children]),
      amountDb: config.amountDb,
      thresholdDb: config.thresholdDb,
      attackCoefficient: Math.exp(-1 / (config.attackSeconds * composition.sampleRate)),
      releaseCoefficient: Math.exp(-1 / (config.releaseSeconds * composition.sampleRate)),
    }));
  }
  if (sourceIds.size !== 1) return undefined;
  const keyBusId = [...sourceIds][0];
  const keyBus = ir.nodes[keyBusId];
  if (!keyBus || keyBus.op !== "cut.audio.bus" || !root.children.includes(keyBusId)
    || !hasStaticProperties(keyBus) || keyBus.children.length < 1) return undefined;
  const branchByBus = new Map(sidechainBuses.map(({ busId, node }) => [busId, branches.findIndex((branch) => branch.nodeId === node.id)]));
  const mixOrder: ReferenceStaticSidechainMixItem[] = [];
  for (const busId of root.children) {
    if (busId === keyBusId) mixOrder.push(Object.freeze({ kind: "key" }));
    else {
      const branchIndex = branchByBus.get(busId);
      if (branchIndex === undefined || branchIndex < 0) return undefined;
      mixOrder.push(Object.freeze({ kind: "sidechain", branchIndex }));
    }
  }
  if (mixOrder.filter((item) => item.kind === "key").length !== 1
    || mixOrder.length !== branches.length + 1) return undefined;
  return Object.freeze({
    format: "cut-reference-static-sidechain-island-plan",
    version: 1,
    sampleRate: composition.sampleRate,
    frames,
    keyRootIds: Object.freeze([keyBusId]),
    branches: Object.freeze(branches),
    mixOrder: Object.freeze(mixOrder),
  });
}

function stateFor(processor: ReferenceStaticDspIslandProcessor): ProcessorState {
  if (processor.kind === "state-variable-filter") {
    return { integrator1Left: 0, integrator2Left: 0, integrator1Right: 0, integrator2Right: 0 };
  }
  if (processor.kind === "deesser") return { lowLeft: 0, lowRight: 0, envelope: 0 };
  if (processor.kind === "compressor") return { envelope: 0 };
  return undefined;
}

export function createReferenceStaticDspIslandState(plan: ReferenceStaticDspIslandPlan): ReferenceStaticDspIslandState {
  return {
    branches: plan.branches.map((branch) => branch.processors.map(stateFor)),
    framesProcessed: 0,
  };
}

function finiteSample(value: number, frame: number) {
  if (!Number.isFinite(value)) {
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", `private boundary contains a non-finite sample at frame ${frame}.`);
  }
  return value;
}

/**
 * Pure interleaved-f32 kernel. Inputs are never mutated or aliased; persistent
 * state is explicit so arbitrary chunk splits retain one exact causal stream.
 */
export function processReferenceStaticDspIslandBuffer(
  plan: ReferenceStaticDspIslandPlan,
  state: ReferenceStaticDspIslandState,
  inputs: readonly Float32Array[],
): Float32Array {
  if (inputs.length !== plan.branches.length || inputs.length !== state.branches.length) {
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private boundary count no longer matches its closed plan.");
  }
  const samples = inputs[0]?.length ?? 0;
  if (!samples || samples % 2 !== 0 || samples > referenceStaticDspIslandLimits.chunkFrames * 2
    || inputs.some((input) => !(input instanceof Float32Array) || input.length !== samples)) {
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_WORK_LIMIT", "one island batch must contain equal non-empty interleaved stereo f32 inputs within the chunk ceiling.");
  }
  const frames = samples / 2;
  if (!Number.isSafeInteger(state.framesProcessed) || state.framesProcessed < 0
    || state.framesProcessed + frames > plan.frames) {
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_WORK_LIMIT", "island batch exceeds its exact composition frame boundary.");
  }
  const output = new Float32Array(samples);
  const dbScale = 20 / Math.log(10);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = frame * 2;
    let mixedLeft = 0;
    let mixedRight = 0;
    for (let branchIndex = 0; branchIndex < plan.branches.length; branchIndex += 1) {
      let left = finiteSample(inputs[branchIndex][sample], state.framesProcessed + frame);
      let right = finiteSample(inputs[branchIndex][sample + 1], state.framesProcessed + frame);
      const branch = plan.branches[branchIndex];
      const branchStates = state.branches[branchIndex];
      for (let processorIndex = 0; processorIndex < branch.processors.length; processorIndex += 1) {
        const processor = branch.processors[processorIndex];
        const processorState = branchStates[processorIndex];
        if (processor.kind === "state-variable-filter") {
          const filter = processorState as FilterState;
          const v3Left = left - filter.integrator2Left;
          const v1Left = processor.a1 * filter.integrator1Left + processor.a2 * v3Left;
          const v2Left = filter.integrator2Left + processor.a2 * filter.integrator1Left + processor.a3 * v3Left;
          filter.integrator1Left = 2 * v1Left - filter.integrator1Left;
          filter.integrator2Left = 2 * v2Left - filter.integrator2Left;
          left = processor.response === "lowpass" ? v2Left : left - processor.damping * v1Left - v2Left;
          const v3Right = right - filter.integrator2Right;
          const v1Right = processor.a1 * filter.integrator1Right + processor.a2 * v3Right;
          const v2Right = filter.integrator2Right + processor.a2 * filter.integrator1Right + processor.a3 * v3Right;
          filter.integrator1Right = 2 * v1Right - filter.integrator1Right;
          filter.integrator2Right = 2 * v2Right - filter.integrator2Right;
          right = processor.response === "lowpass" ? v2Right : right - processor.damping * v1Right - v2Right;
        } else if (processor.kind === "deesser") {
          const deesser = processorState as DeEsserState;
          const lowLeft = (1 - processor.crossoverCoefficient) * left + processor.crossoverCoefficient * deesser.lowLeft;
          const lowRight = (1 - processor.crossoverCoefficient) * right + processor.crossoverCoefficient * deesser.lowRight;
          const highLeft = left - lowLeft;
          const highRight = right - lowRight;
          const detector = Math.max(Math.abs(highLeft), Math.abs(highRight));
          const coefficient = detector > deesser.envelope ? processor.attackCoefficient : processor.releaseCoefficient;
          deesser.envelope = coefficient * deesser.envelope + (1 - coefficient) * detector;
          deesser.lowLeft = lowLeft;
          deesser.lowRight = lowRight;
          const envelopeDb = deesser.envelope > 1e-30 ? dbScale * Math.log(deesser.envelope) : -600;
          const activity = Math.max(0, Math.min(1, (envelopeDb - processor.thresholdDb) / -processor.thresholdDb));
          const gain = 10 ** ((-processor.depthDb * activity) / 20);
          if (processor.depthDb !== 0 && gain !== 1) {
            left = lowLeft + highLeft * gain;
            right = lowRight + highRight * gain;
          }
        } else if (processor.kind === "compressor") {
          const compressor = processorState as CompressorState;
          const detector = Math.max(Math.abs(left), Math.abs(right));
          const coefficient = detector > compressor.envelope ? processor.attackCoefficient : processor.releaseCoefficient;
          compressor.envelope = coefficient * compressor.envelope + (1 - coefficient) * detector;
          let reductionDb = 0;
          if (compressor.envelope > 1e-12) {
            const levelDb = dbScale * Math.log(compressor.envelope);
            if (levelDb > processor.thresholdDb) reductionDb = -(levelDb - processor.thresholdDb) * processor.ratioFactor;
          }
          const gain = 10 ** ((reductionDb + processor.makeupDb) / 20);
          left *= gain;
          right *= gain;
        } else {
          left = Math.fround(Math.fround(left) * processor.coefficient);
          right = Math.fround(Math.fround(right) * processor.coefficient);
        }
      }
      // Every admitted branch ends at a Gain/float boundary. libav's fltp
      // amix accumulates in source order with one float rounding per add.
      mixedLeft = Math.fround(mixedLeft + left);
      mixedRight = Math.fround(mixedRight + right);
    }
    output[sample] = mixedLeft;
    output[sample + 1] = mixedRight;
  }
  state.framesProcessed += frames;
  return output;
}

export function createReferenceStaticSidechainIslandState(
  plan: ReferenceStaticSidechainIslandPlan,
): ReferenceStaticSidechainIslandState {
  return { envelopes: plan.branches.map(() => 0), framesProcessed: 0 };
}

/** Pure exact kernel for one common f32 key and N static f32 programs. */
export function processReferenceStaticSidechainIslandBuffer(
  plan: ReferenceStaticSidechainIslandPlan,
  state: ReferenceStaticSidechainIslandState,
  key: Float32Array,
  programs: readonly Float32Array[],
): Float32Array {
  if (!(key instanceof Float32Array) || programs.length !== plan.branches.length
    || programs.length !== state.envelopes.length) {
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "sidechain boundary count no longer matches its closed plan.");
  }
  const samples = key.length;
  if (!samples || samples % 2 !== 0 || samples > referenceStaticDspIslandLimits.chunkFrames * 2
    || programs.some((program) => !(program instanceof Float32Array) || program.length !== samples)) {
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_WORK_LIMIT", "one sidechain batch must contain equal non-empty interleaved stereo f32 inputs within the chunk ceiling.");
  }
  const frames = samples / 2;
  if (!Number.isSafeInteger(state.framesProcessed) || state.framesProcessed < 0
    || state.framesProcessed + frames > plan.frames) {
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_WORK_LIMIT", "sidechain batch exceeds its exact composition frame boundary.");
  }
  const output = new Float32Array(samples);
  const processedLeft = new Float32Array(plan.branches.length);
  const processedRight = new Float32Array(plan.branches.length);
  const dbScale = 20 / Math.log(10);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = frame * 2;
    const absoluteFrame = state.framesProcessed + frame;
    const keyLeft = finiteSample(key[sample], absoluteFrame);
    const keyRight = finiteSample(key[sample + 1], absoluteFrame);
    const detector = Math.max(Math.abs(keyLeft), Math.abs(keyRight));
    for (let branchIndex = 0; branchIndex < plan.branches.length; branchIndex += 1) {
      const branch = plan.branches[branchIndex];
      const coefficient = detector > state.envelopes[branchIndex]
        ? branch.attackCoefficient
        : branch.releaseCoefficient;
      const envelope = coefficient * state.envelopes[branchIndex] + (1 - coefficient) * detector;
      state.envelopes[branchIndex] = envelope;
      let reductionDb = 0;
      if (envelope > 1e-12) {
        const envelopeDb = dbScale * Math.log(envelope);
        if (envelopeDb > branch.thresholdDb) {
          reductionDb = branch.amountDb * ((envelopeDb - branch.thresholdDb) / Math.max(-branch.thresholdDb, 1e-12));
        }
      }
      const gain = 10 ** (reductionDb / 20);
      const program = programs[branchIndex];
      // aeval is converted to the fltp format selected by the owning amix.
      processedLeft[branchIndex] = Math.fround(finiteSample(program[sample], absoluteFrame) * gain);
      processedRight[branchIndex] = Math.fround(finiteSample(program[sample + 1], absoluteFrame) * gain);
    }
    let mixedLeft = 0;
    let mixedRight = 0;
    for (const item of plan.mixOrder) {
      const left = item.kind === "key" ? keyLeft : processedLeft[item.branchIndex];
      const right = item.kind === "key" ? keyRight : processedRight[item.branchIndex];
      mixedLeft = Math.fround(mixedLeft + left);
      mixedRight = Math.fround(mixedRight + right);
    }
    output[sample] = mixedLeft;
    output[sample + 1] = mixedRight;
  }
  state.framesProcessed += frames;
  return output;
}

function ioCode(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "UNKNOWN";
}

function sameSnapshot(
  before: BigIntStats,
  after: BigIntStats,
) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

/**
 * Attempt one exact static island. False means the unchanged FFmpeg path owns
 * the graph. True means output was published only after exact bounded input,
 * work, mutation and byte-count checks completed.
 */
async function renderReferenceProcessedDspIsland(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  output: string,
  renderBoundary: RenderReferenceStaticDspBoundary,
): Promise<boolean> {
  const plan = planReferenceStaticDspIsland(ir, composition, rootIds);
  if (!plan) return false;
  const directory = await mkdtemp(resolve(tmpdir(), "cut-audio-static-dsp-"));
  await chmod(directory, 0o700);
  const boundaryPaths = plan.branches.map((_, index) => resolve(directory, `branch-${String(index).padStart(3, "0")}.f32le`));
  let outputCreated = false;
  try {
    for (const [index, branch] of plan.branches.entries()) {
      await renderBoundary(branch.boundaryRootIds, boundaryPaths[index]);
    }
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "platform cannot bind private island inputs to no-follow handles.");
    }
    const expectedBytes = plan.frames * 8;
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    const snapshots: BigIntStats[] = [];
    let outputHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      for (const path of boundaryPaths) {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== expectedBytes) {
          throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", `private boundary must be one direct ${expectedBytes}-byte stereo f32le file.`);
        }
        const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const snapshot = await handle.stat({ bigint: true });
        if (!snapshot.isFile() || snapshot.size !== BigInt(expectedBytes)) {
          await handle.close().catch(() => undefined);
          throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", `private boundary must contain exactly ${expectedBytes} bytes.`);
        }
        handles.push(handle);
        snapshots.push(snapshot);
      }
      outputHandle = await open(output, "wx", 0o600);
      outputCreated = true;
      const state = createReferenceStaticDspIslandState(plan);
      for (let start = 0; start < plan.frames; start += referenceStaticDspIslandLimits.chunkFrames) {
        const frames = Math.min(referenceStaticDspIslandLimits.chunkFrames, plan.frames - start);
        const buffers = await Promise.all(handles.map(async (handle) => {
          const bytes = Buffer.allocUnsafe(frames * 8);
          const read = await handle.read(bytes, 0, bytes.length, start * 8);
          if (read.bytesRead !== bytes.length) {
            throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private boundary ended before its exact frame count.");
          }
          return bytes;
        }));
        const inputs = buffers.map((bytes) => {
          if (bytes.byteOffset % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          const copy = new Float32Array(bytes.byteLength / 4);
          for (let index = 0; index < copy.length; index += 1) copy[index] = bytes.readFloatLE(index * 4);
          return copy;
        });
        const processed = processReferenceStaticDspIslandBuffer(plan, state, inputs);
        const bytes = Buffer.from(processed.buffer, processed.byteOffset, processed.byteLength);
        const write = await outputHandle.write(bytes, 0, bytes.length, start * 8);
        if (write.bytesWritten !== bytes.length) {
          throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private island output could not be written completely.");
        }
      }
      if (state.framesProcessed !== plan.frames) {
        throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_WORK_LIMIT", "private island did not execute its exact frame count.");
      }
      for (const [index, handle] of handles.entries()) {
        const after = await handle.stat({ bigint: true });
        if (!sameSnapshot(snapshots[index], after)) {
          throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private boundary changed while CUT evaluated its static DSP island.");
        }
      }
    } finally {
      await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
      await outputHandle?.close().catch(() => undefined);
    }
    const outputMetadata = await lstat(output);
    if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink() || outputMetadata.size !== plan.frames * 8) {
      throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private island output did not preserve its exact stereo frame boundary.");
    }
    return true;
  } catch (error) {
    if (outputCreated) await rm(output, { force: true }).catch(() => undefined);
    if (error instanceof ReferenceStaticDspIslandError) throw error;
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", `private island execution failed (${ioCode(error)}).`, { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function renderReferenceStaticSidechainIsland(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  output: string,
  renderBoundary: RenderReferenceStaticDspBoundary,
): Promise<boolean> {
  const plan = planReferenceStaticSidechainIsland(ir, composition, rootIds);
  if (!plan) return false;
  const directory = await mkdtemp(resolve(tmpdir(), "cut-audio-static-sidechain-"));
  await chmod(directory, 0o700);
  const boundaryPaths = [
    resolve(directory, "key.f32le"),
    ...plan.branches.map((_, index) => resolve(directory, `program-${String(index).padStart(3, "0")}.f32le`)),
  ];
  let outputCreated = false;
  try {
    await renderBoundary(plan.keyRootIds, boundaryPaths[0]);
    for (const [index, branch] of plan.branches.entries()) {
      await renderBoundary(branch.programRootIds, boundaryPaths[index + 1]);
    }
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "platform cannot bind private sidechain inputs to no-follow handles.");
    }
    const expectedBytes = plan.frames * 8;
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    const snapshots: BigIntStats[] = [];
    let outputHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      for (const path of boundaryPaths) {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== expectedBytes) {
          throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", `private sidechain boundary must be one direct ${expectedBytes}-byte stereo f32le file.`);
        }
        const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const snapshot = await handle.stat({ bigint: true });
        if (!snapshot.isFile() || snapshot.size !== BigInt(expectedBytes)) {
          await handle.close().catch(() => undefined);
          throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", `private sidechain boundary must contain exactly ${expectedBytes} bytes.`);
        }
        handles.push(handle);
        snapshots.push(snapshot);
      }
      outputHandle = await open(output, "wx", 0o600);
      outputCreated = true;
      const state = createReferenceStaticSidechainIslandState(plan);
      for (let start = 0; start < plan.frames; start += referenceStaticDspIslandLimits.chunkFrames) {
        const frames = Math.min(referenceStaticDspIslandLimits.chunkFrames, plan.frames - start);
        const buffers = await Promise.all(handles.map(async (handle) => {
          const bytes = Buffer.allocUnsafe(frames * 8);
          const read = await handle.read(bytes, 0, bytes.length, start * 8);
          if (read.bytesRead !== bytes.length) {
            throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private sidechain boundary ended before its exact frame count.");
          }
          return bytes;
        }));
        const inputs = buffers.map((bytes) => {
          if (bytes.byteOffset % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          const copy = new Float32Array(bytes.byteLength / 4);
          for (let index = 0; index < copy.length; index += 1) copy[index] = bytes.readFloatLE(index * 4);
          return copy;
        });
        const processed = processReferenceStaticSidechainIslandBuffer(plan, state, inputs[0], inputs.slice(1));
        const bytes = Buffer.from(processed.buffer, processed.byteOffset, processed.byteLength);
        const write = await outputHandle.write(bytes, 0, bytes.length, start * 8);
        if (write.bytesWritten !== bytes.length) {
          throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private sidechain output could not be written completely.");
        }
      }
      if (state.framesProcessed !== plan.frames) {
        throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_WORK_LIMIT", "private sidechain island did not execute its exact frame count.");
      }
      for (const [index, handle] of handles.entries()) {
        const after = await handle.stat({ bigint: true });
        if (!sameSnapshot(snapshots[index], after)) {
          throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private sidechain boundary changed while CUT evaluated its static island.");
        }
      }
    } finally {
      await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
      await outputHandle?.close().catch(() => undefined);
    }
    const outputMetadata = await lstat(output);
    if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink() || outputMetadata.size !== plan.frames * 8) {
      throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", "private sidechain output did not preserve its exact stereo frame boundary.");
    }
    return true;
  } catch (error) {
    if (outputCreated) await rm(output, { force: true }).catch(() => undefined);
    if (error instanceof ReferenceStaticDspIslandError) throw error;
    throw new ReferenceStaticDspIslandError("CUT_AUDIO_STATIC_DSP_SOURCE", `private sidechain execution failed (${ioCode(error)}).`, { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Attempt either closed exact static island. Unsupported topologies retain the
 * unchanged FFmpeg path; execution failures never fall through silently.
 */
export async function renderReferenceStaticDspIsland(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  output: string,
  renderBoundary: RenderReferenceStaticDspBoundary,
): Promise<boolean> {
  if (await renderReferenceProcessedDspIsland(ir, composition, rootIds, output, renderBoundary)) return true;
  return renderReferenceStaticSidechainIsland(ir, composition, rootIds, output, renderBoundary);
}
