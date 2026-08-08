import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveLockedProjectPath, type LockedResourceProbe } from "../../language/lock";
import type { ReferenceVerifiedInputSession } from "./verified-input-session";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { addRational, compareRational, divideRational, multiplyRational, rational, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { assertCutGraphExecutionBudget, nodeReferences } from "../graph";
import { compileReferenceAudioAutomation, compileReferenceCompressorAutomations, compileReferenceDeEsserAutomations, compileReferenceParametricEqAutomations, compileReferenceSidechainAutomations, compileReferenceStateVariableFilterAutomations, escapeFfmpegAudioExpression, validateReferenceAudioAutomationBudget } from "./audio-automation";
import { referenceCompressorExpression } from "./audio-compressor";
import { referenceDeEsserExpression } from "./audio-deesser";
import { referenceSidechainExpression } from "./audio-sidechain";
import { referenceAudioNodeConfig, type ReferenceMediaAudioConfig } from "./audio-config";
import { referenceAudioCompositionRootIds, validateReferenceAudioBackendPlan, validateReferenceAudioCompositionResources, withReferenceAudioFilterScript } from "./audio-resource";
import { referenceStateVariableFilterExpression } from "./audio-filter";
import { referenceParametricEqExpression } from "./audio-parametric-eq";
import { planReferenceAudioRouting, type ReferenceAudioRoutingPlan } from "./audio-routing";
import { prepareReferenceTimeStretchSources, validateReferenceTimeStretchPlans, type ReferenceTimelineTimeStretchChildEvaluation, type ReferenceTimeStretchPreparation, type ReferenceTimeStretchSource } from "./audio-time-stretch";
import { runFfmpeg, runFfmpegCapture } from "./ffmpeg";
import { prepareReferenceSynthSources, validateReferenceSynthPlans, type ReferenceSynthSource } from "./synth";
import { referenceTransitionContract } from "./transition-config";
import { referenceLinkedSplitContract } from "./linked-split-config";
import { executeAudioEditOperationPlan } from "../../language/audio-edit-operations";
import { validateReachableReferenceAudioRegionCrossfadePlans, validateReferenceAudioTrackOperationPlan } from "./audio-edit-operations";
import {
  referenceTimelineEditAudioTrackTransitions,
  validateReferenceTimelineEditMaterializations,
} from "./timeline-edit";
import {
  quantizeReferenceStereoF32LeFileToPcm24Wave,
  referenceAudioPeakLimits,
  type ReferenceAudioPeakScan,
} from "./audio-peak";
import {
  referenceAudioCrossfadeEnvelopeExpression,
  referenceAudioTrackTransitionPlans,
  type ReferenceAudioTrackItemRenderPlan,
} from "./audio-track-transition";
import { referenceNestedAudioPreparationKey, validateReferencePrecompGraph } from "./precomp-config";
import { validateReferenceLinkedEditTransactions, type ReferenceLinkedEditAuthorizations } from "./linked-edit";
import {
  createReferenceAudioLimiterBuildEvidence,
  prepareReferenceAudioLimiterSources,
  validateReferenceAudioLimiterPlans,
  type ReferenceAudioLimiterExecutionEvidence,
  type ReferenceAudioLimiterPreparation,
  type ReferenceAudioLimiterPreparedSource,
} from "./audio-limiter-preparation";
import { assertReachableReferenceAudioRegionPlansCurrent, authorizeReachableReferenceAudioRegions, type ReferenceAudioRegionPlan } from "./audio-region";
import {
  createReferenceAudioTempoDelayBuildEvidence,
  prepareReferenceAudioTempoDelaySources,
  type ReferenceAudioTempoDelayExecutionEvidence,
  type ReferenceAudioTempoDelayPreparation,
  type ReferenceAudioTempoDelayPreparedSource,
} from "./audio-tempo-delay-preparation";
import { validateReferenceTempoDelayPlans } from "./audio-tempo-delay-config";
import { referenceLinkedClipAudioExecutionPlan } from "./linked-av-presentation";
import { renderReferenceStaticDspIsland } from "./audio-static-dsp-island";

function dbLinear(db: number) { return 10 ** (db / 20); }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }

/**
 * A media resource is semantically locked to one absolute FFmpeg stream index.
 * Never use a generic `:a` selector here: it does not bind FFmpeg to CUT's
 * lock-selected stream when a container carries multiple audio tracks.
 */
function lockedAudioStream(ir: CutAVIR, resourceId: string) {
  const probe = ir.resources[resourceId]?.metadata?.probe as LockedResourceProbe | undefined;
  const selection = probe?.kind === "media" ? probe.selected.audio : undefined;
  const streamIndex = selection?.streamIndex;
  if (typeof streamIndex !== "number" || !Number.isSafeInteger(streamIndex) || streamIndex < 0) {
    throw new Error(`Locked audio resource ${resourceId} has no validated selected audio stream.`);
  }
  const stream = probe?.kind === "media"
    ? probe.identity.streams.find((candidate) => candidate.type === "audio" && candidate.index === streamIndex)
    : undefined;
  if (!stream?.sampleRate || !Number.isSafeInteger(stream.sampleRate) || stream.sampleRate < 1) {
    throw new Error(`Locked audio resource ${resourceId} selected stream ${streamIndex} has no exact sample rate.`);
  }
  return { streamIndex, sampleRate: stream.sampleRate };
}

type ReferenceNestedAudioSource = Readonly<{
  selectedSamples: number;
  format: "raw-stereo-f32le";
  channels: 2;
  sampleRate: number;
  path?: string;
}>;

type AudioBuild = {
  args: string[];
  filters: string[];
  nextInput: number;
  nextLabel: number;
  paths: Map<string, string>;
  synthSources: Map<string, ReferenceSynthSource>;
  timeStretchSources: Map<string, ReferenceTimeStretchSource>;
  limiterSources: Map<string, ReferenceAudioLimiterPreparedSource>;
  tempoDelaySources: Map<string, ReferenceAudioTempoDelayPreparedSource>;
  nestedSources: Map<string, ReferenceNestedAudioSource>;
  sampleRate: number;
  totalSamples: number;
  routing: ReferenceAudioRoutingPlan;
  linkedEditAudioByTrackId: ReferenceLinkedEditAuthorizations["audioByTrackId"];
  audioRegionPlans: ReadonlyMap<string, ReferenceAudioRegionPlan>;
  audioRegionTransitionByRegionId: Map<string, Extract<ReferenceAudioTrackItemRenderPlan, { kind: "region" }>>;
  audioRegionTransitionBySourceId: Map<string, Extract<ReferenceAudioTrackItemRenderPlan, { kind: "region" }>>;
  timelineAudioViewTransitionByViewId: Map<string, Extract<ReferenceAudioTrackItemRenderPlan, { kind: "timeline-view" }>>;
  timelineAudioOriginOutputs: Map<string, ReadonlyMap<string, string>>;
  timelineTimeStretchChildEvaluations: ReadonlyMap<string, ReferenceTimelineTimeStretchChildEvaluation>;
};

type ReferenceAudioBuildAccumulator = {
  limiterExecutions: ReferenceAudioLimiterExecutionEvidence[];
  tempoDelayExecutions: ReferenceAudioTempoDelayExecutionEvidence[];
};

function label(build: AudioBuild, prefix = "a") { return `${prefix}_${String(build.nextLabel++).padStart(4, "0")}`; }

function preparedRawStereoF32Input(build: AudioBuild, source: { path: string; format: "raw-stereo-f32le"; channels: 2; sampleRate: number }) {
  if (source.format !== "raw-stereo-f32le" || source.channels !== 2 || !Number.isSafeInteger(source.sampleRate) || source.sampleRate < 1) {
    throw new Error("CUT_AUDIO_SELECTION_FORMAT: prepared audio source is not exact raw stereo f32le.");
  }
  const input = build.nextInput++;
  build.args.push("-f", "f32le", "-ar", String(source.sampleRate), "-ac", "2", "-i", source.path);
  return input;
}

function exactSamples(value: Rational, sampleRate: number, context: string) {
  const samples = multiplyRational(value, rational(sampleRate));
  if (samples.denominator !== "1") throw new Error(`${context} does not land on a ${sampleRate} Hz sample boundary.`);
  const count = Number(samples.numerator);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${context} has an invalid sample position.`);
  return count;
}

function exactTimeInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  if (value?.kind !== "quantity" || value.dimension !== "time") {
    throw new Error(`${node.op}.${name} must be one exact Time quantity.`);
  }
  return value.magnitude;
}

type TimelineAudioEvaluationEnvelope = Readonly<{
  source: Readonly<{ start: Rational; duration: Rational }>;
  presentationZero: Rational;
  fadeAnchorPolicy: "origin-relative-at-presentation-zero";
  evaluationPolicy: "selected-source-union-v1" | "full-declared-handle-domain-v1";
}>;

function timelineAudioEvaluationEnvelope(
  node: IRNode,
): TimelineAudioEvaluationEnvelope | undefined {
  const source = node.inputs.evaluationSource;
  const presentationZero = node.inputs.presentationZero;
  const fadeAnchorPolicy = node.inputs.fadeAnchorPolicy;
  const evaluationPolicy = node.inputs.evaluationPolicy;
  const present = Number(source !== undefined)
    + Number(presentationZero !== undefined)
    + Number(fadeAnchorPolicy !== undefined)
    + Number(evaluationPolicy !== undefined);
  if (!present) return undefined;
  if (present !== 4
    || source?.kind !== "range"
    || !source.exclusive
    || source.start.kind !== "quantity"
    || source.start.dimension !== "time"
    || source.start.unit !== "s"
    || source.end.kind !== "quantity"
    || source.end.dimension !== "time"
    || source.end.unit !== "s"
    || presentationZero?.kind !== "quantity"
    || presentationZero.dimension !== "time"
    || presentationZero.unit !== "s"
    || fadeAnchorPolicy?.kind !== "string"
    || fadeAnchorPolicy.value !== "origin-relative-at-presentation-zero"
    || evaluationPolicy?.kind !== "string"
    || (evaluationPolicy.value !== "selected-source-union-v1"
      && evaluationPolicy.value !== "full-declared-handle-domain-v1")) {
    throw new Error(
      `CUT_TIMELINE_EDIT_RESULT: ${node.id} lost its authenticated audio evaluation envelope.`,
    );
  }
  const duration = subtractRational(source.end.magnitude, source.start.magnitude);
  if (compareRational(source.start.magnitude, zeroRational) < 0
    || compareRational(duration, zeroRational) <= 0
    || compareRational(presentationZero.magnitude, zeroRational) < 0) {
    throw new Error(
      `CUT_TIMELINE_EDIT_TIME: ${node.id} has an invalid audio evaluation envelope.`,
    );
  }
  return {
    source: { start: source.start.magnitude, duration },
    presentationZero: presentationZero.magnitude,
    fadeAnchorPolicy: fadeAnchorPolicy.value,
    evaluationPolicy: evaluationPolicy.value,
  };
}

function exactNodeRefInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  if (value?.kind !== "node-ref") {
    throw new Error(`${node.op}.${name} must be one exact node reference.`);
  }
  return value.id;
}

function timelineAudioOriginSourceStart(
  build: AudioBuild,
  ir: CutAVIR,
  origin: IRNode,
) {
  if (origin.op !== "cut.edit.timeline_audio_origin"
    || origin.children.length !== 1) {
    throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${origin.id} lost its exact audio origin child.`);
  }
  const sourceRoot = ir.nodes[origin.children[0]!];
  if (!sourceRoot) {
    throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${origin.id} references a missing audio origin child.`);
  }
  const evaluation = timelineAudioEvaluationEnvelope(origin);
  if (evaluation) return evaluation.source.start;
  if (sourceRoot.op === "cut.edit.audio_region") {
    const plan = build.audioRegionPlans.get(sourceRoot.id);
    if (!plan) {
      throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${origin.id} lost its authenticated processed-audio source range.`);
    }
    return plan.sourceRange.start;
  }
  if (sourceRoot.op !== "cut.audio.clip") {
    throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${origin.id} has an unsupported direct audio origin child.`);
  }
  const range = sourceRoot.inputs.range;
  if (range?.kind !== "range" || !range.exclusive
    || range.start.kind !== "quantity" || range.start.dimension !== "time"
    || range.end.kind !== "quantity" || range.end.dimension !== "time") {
    throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${origin.id} lost its authenticated direct-audio source range.`);
  }
  return range.start.magnitude;
}

function exactLength(build: AudioBuild) {
  return `apad=whole_len=${build.totalSamples},atrim=start_sample=0:end_sample=${build.totalSamples},asetpts=N/SR/TB`;
}

function mix(build: AudioBuild, labels: string[]) {
  if (!labels.length) {
    const output = label(build); build.filters.push(`anullsrc=r=${build.sampleRate}:cl=stereo,atrim=end_sample=${build.totalSamples},asetpts=N/SR/TB[${output}]`); return output;
  }
  if (labels.length === 1) return labels[0];
  const output = label(build); build.filters.push(`${labels.map((item) => `[${item}]`).join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[${output}]`); return output;
}

function exactLinkedClipFades(build: AudioBuild, node: IRNode, mediaDuration: Rational) {
  const durationSamples = exactSamples(mediaDuration, build.sampleRate, `${node.op} duration`);
  const fadeSamples = (name: "fadeIn" | "fadeOut") => {
    const input = node.inputs[name];
    if (input === undefined) return 0;
    if (input.kind !== "quantity" || input.dimension !== "time") throw new Error(`${node.op} ${name} must be an exact Time quantity.`);
    return exactSamples(input.magnitude, build.sampleRate, `${node.op} ${name}`);
  };
  const fadeIn = fadeSamples("fadeIn"), fadeOut = fadeSamples("fadeOut");
  if (fadeIn + fadeOut > durationSamples) throw new Error(`${node.op} fadeIn + fadeOut cannot exceed its destination duration.`);
  return {
    durationSamples,
    filters: `${fadeIn > 0 ? `,afade=t=in:start_sample=0:nb_samples=${fadeIn}` : ""}${fadeOut > 0 ? `,afade=t=out:start_sample=${durationSamples - fadeOut}:nb_samples=${fadeOut}` : ""}`,
  };
}

function sceneStart(ir: CutAVIR, node: IRNode): Rational { return node.sceneId ? ir.scenes[node.sceneId]?.start ?? rational(0) : rational(0); }

function audioSendContribution(build: AudioBuild, ir: CutAVIR, composition: IRComposition, sendId: string, stack: Set<string>) {
  if (stack.has(sendId)) throw new Error(`Audio routing cycle at ${sendId}.`);
  const send = ir.nodes[sendId], route = build.routing.sends.get(sendId);
  if (!send || send.op !== "cut.audio.send" || !route) throw new Error(`Invalid planned CUT Send ${sendId}.`);
  const config = referenceAudioNodeConfig(ir, composition, send);
  if (config?.kind !== "send") throw new Error(`Internal CUT Send config mismatch for ${sendId}.`);
  const next = new Set(stack); next.add(sendId);
  const sourceIds = config.sourceNodeId === undefined
    ? send.children
    : config.tap === "pre-fader"
      ? route.preFaderNodeId === undefined
        ? []
        : ir.nodes[route.preFaderNodeId]?.children ?? []
      : [config.sourceNodeId];
  if (config.tap === "pre-fader" && (route.preFaderNodeId === undefined || ir.nodes[route.preFaderNodeId]?.op !== "cut.audio.gain" || sourceIds.length < 1)) {
    throw new Error(`Invalid planned CUT pre-fader Send ${sendId}.`);
  }
  const input = mix(build, sourceIds.map((child) => audioNode(build, ir, composition, child, new Set(next))));
  const automation = compileReferenceAudioAutomation(ir, composition, send);
  if (!automation && config.amountDb === 0) return input;
  const result = label(build, "send");
  if (!automation) build.filters.push(`[${input}]volume=${dbLinear(config.amountDb)}[${result}]`);
  else {
    // One post-child contribution remains live for the complete composition;
    // the exact output-sample gain coefficient changes without cloning,
    // restarting, or altering the dry structural path.
    const coefficient = `pow(10,(${automation.valueExpression})/20)`;
    const expressions = [0, 1]
      .map((channel) => `val(${channel})*${coefficient}`)
      .map(escapeFfmpegAudioExpression)
      .join("|");
    build.filters.push(`[${input}]aeval=exprs='${expressions}':c=stereo[${result}]`);
  }
  return result;
}

function audioTrackPlannedClip(
  build: AudioBuild,
  ir: CutAVIR,
  composition: IRComposition,
  track: IRNode,
  plan: Extract<ReferenceAudioTrackItemRenderPlan, { kind: "clip" }>,
) {
  const path = build.paths.get(plan.resourceId);
  if (!path) throw new Error(`Missing locked audio path for ${plan.resourceId}.`);
  const input = build.nextInput++;
  build.args.push("-i", path);
  const sourceStartSamples = exactSamples(plan.source.start, plan.sourceSampleRate, `${track.op} extended source start`);
  const sourceEndSamples = exactSamples(addRational(plan.source.start, plan.source.duration), plan.sourceSampleRate, `${track.op} extended source end`);
  if (sourceEndSamples <= sourceStartSamples) throw new Error(`${track.op} extended source interval is not positive.`);
  const placement = addRational(sceneStart(ir, track), plan.destination.start);
  const placementSamples = exactSamples(placement, composition.sampleRate, `${track.op} extended destination start`);
  const resample = sourceEndSamples - sourceStartSamples < 32
    ? `aresample=${composition.sampleRate}:filter_size=2`
    : `aresample=${composition.sampleRate}`;
  const envelope = plan.envelopes.length
    ? `,aeval=exprs='${[0, 1].map((channel) => `val(${channel})*(${plan.envelopes.map(referenceAudioCrossfadeEnvelopeExpression).join("*")})`).map(escapeFfmpegAudioExpression).join("|")}':c=stereo`
    : "";
  const result = label(build, "audio_track_clip");
  build.filters.push(`[${input}:${plan.streamIndex}]atrim=start_sample=${sourceStartSamples}:end_sample=${sourceEndSamples},asetpts=N/SR/TB,${resample},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=${plan.destinationSamples},asetpts=N/SR/TB${envelope},adelay=delays=${placementSamples}S:all=1,${exactLength(build)}[${result}]`);
  return result;
}

function timelineAudioOriginOutput(
  build: AudioBuild,
  ir: CutAVIR,
  composition: IRComposition,
  view: IRNode,
  stack: Set<string>,
) {
  const originId = exactNodeRefInput(view, "origin");
  let outputs = build.timelineAudioOriginOutputs.get(originId);
  if (!outputs) {
    const origin = ir.nodes[originId];
    if (!origin
      || origin.op !== "cut.edit.timeline_audio_origin"
      || origin.ownership !== "reference"
      || origin.children.length !== 1) {
      throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${view.id} lost its authenticated audio origin.`);
    }
    const views = Object.values(ir.nodes)
      .filter((candidate) =>
        candidate.op === "cut.edit.timeline_audio_view"
        && candidate.inputs.origin?.kind === "node-ref"
        && candidate.inputs.origin.id === originId)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!views.length || views.some((candidate) => candidate.sceneId !== origin.sceneId)) {
      throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${originId} has no bounded same-scene audio views.`);
    }
    const originOutput = audioNode(build, ir, composition, origin.id, new Set(stack));
    if (views.length === 1) {
      outputs = new Map([[views[0]!.id, originOutput]]);
    } else {
      const labels = views.map(() => label(build, "timeline_audio_origin"));
      build.filters.push(
        `[${originOutput}]asplit=outputs=${views.length}${labels.map((item) => `[${item}]`).join("")}`,
      );
      outputs = new Map(views.map((candidate, index) => [candidate.id, labels[index]!]));
    }
    build.timelineAudioOriginOutputs.set(originId, outputs);
  }
  const output = outputs.get(view.id);
  if (!output) {
    throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${view.id} is not one authenticated consumer of ${originId}.`);
  }
  return { originId, output };
}

function timelineAudioEvaluationLeaf(
  build: AudioBuild,
  origin: IRNode,
  config: ReferenceMediaAudioConfig,
  envelope: TimelineAudioEvaluationEnvelope,
  originDuration: Rational,
) {
  const path = build.paths.get(config.resourceId);
  if (!path) throw new Error(`Missing locked audio path for ${config.resourceId}.`);
  const input = build.nextInput++;
  build.args.push("-i", path);
  const sourceStartSamples = exactSamples(
    envelope.source.start,
    config.sourceSampleRate,
    `${origin.op} evaluation source start`,
  );
  const sourceEndSamples = exactSamples(
    addRational(envelope.source.start, envelope.source.duration),
    config.sourceSampleRate,
    `${origin.op} evaluation source end`,
  );
  const evaluationSamples = exactSamples(
    envelope.source.duration,
    build.sampleRate,
    `${origin.op} evaluation duration`,
  );
  const presentationZeroSamples = exactSamples(
    envelope.presentationZero,
    build.sampleRate,
    `${origin.op} presentation zero`,
  );
  const originDurationSamples = exactSamples(
    originDuration,
    build.sampleRate,
    `${origin.op} origin duration`,
  );
  const fadeOutStart = presentationZeroSamples
    + originDurationSamples
    - config.fadeOutSamples;
  if (sourceEndSamples <= sourceStartSamples
    || presentationZeroSamples + originDurationSamples > evaluationSamples
    || fadeOutStart < 0) {
    throw new Error(
      `CUT_TIMELINE_EDIT_TIME: ${origin.id} evaluation envelope no longer contains its authored fade clock.`,
    );
  }
  const resample = sourceEndSamples - sourceStartSamples < 32
    ? `aresample=${build.sampleRate}:filter_size=2`
    : `aresample=${build.sampleRate}`;
  const fades = `${config.fadeInSamples > 0
    ? `,afade=t=in:start_sample=${presentationZeroSamples}:nb_samples=${config.fadeInSamples}`
    : ""}${config.fadeOutSamples > 0
    ? `,afade=t=out:start_sample=${fadeOutStart}:nb_samples=${config.fadeOutSamples}`
    : ""}`;
  const output = label(build, "timeline_audio_origin_leaf");
  build.filters.push(
    `[${input}:${config.streamIndex}]atrim=start_sample=${sourceStartSamples}:end_sample=${sourceEndSamples},asetpts=N/SR/TB,${resample},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=${evaluationSamples},asetpts=N/SR/TB${fades}[${output}]`,
  );
  return output;
}

function timelineTimeStretchChildEvaluationLeaf(
  build: AudioBuild,
  node: IRNode,
  config: ReferenceMediaAudioConfig,
  evaluation: ReferenceTimelineTimeStretchChildEvaluation,
) {
  if (evaluation.version !== 1 || evaluation.childNodeId !== node.id) {
    throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} lost its authenticated TimeStretch child evaluation.`);
  }
  const path = build.paths.get(config.resourceId);
  if (!path) throw new Error(`Missing locked audio path for ${config.resourceId}.`);
  const sourceStartSamples = exactSamples(
    evaluation.source.start,
    config.sourceSampleRate,
    `${node.op} expanded evaluation source start`,
  );
  const sourceEndSamples = exactSamples(
    addRational(evaluation.source.start, evaluation.source.duration),
    config.sourceSampleRate,
    `${node.op} expanded evaluation source end`,
  );
  const evaluationSamples = exactSamples(
    evaluation.source.duration,
    build.sampleRate,
    `${node.op} expanded evaluation duration`,
  );
  const presentationSourceZeroSamples = exactSamples(
    evaluation.presentationSourceZero,
    build.sampleRate,
    `${node.op} expanded presentation source zero`,
  );
  const originSourceDurationSamples = exactSamples(
    evaluation.originSourceDuration,
    build.sampleRate,
    `${node.op} authored source duration`,
  );
  const fadeOutStart = presentationSourceZeroSamples
    + originSourceDurationSamples
    - config.fadeOutSamples;
  if (sourceEndSamples <= sourceStartSamples
    || presentationSourceZeroSamples + originSourceDurationSamples > evaluationSamples
    || fadeOutStart < 0) {
    throw new Error(
      `CUT_TIMELINE_EDIT_TIME: ${node.id} expanded TimeStretch evaluation no longer contains its authored fade clock.`,
    );
  }
  const input = build.nextInput++;
  build.args.push("-i", path);
  const selectedAudio = `${input}:${config.streamIndex}`;
  const resample = sourceEndSamples - sourceStartSamples < 32
    ? `aresample=${build.sampleRate}:filter_size=2`
    : `aresample=${build.sampleRate}`;
  const fades = `${config.fadeInSamples > 0
    ? `,afade=t=in:start_sample=${presentationSourceZeroSamples}:nb_samples=${config.fadeInSamples}`
    : ""}${config.fadeOutSamples > 0
    ? `,afade=t=out:start_sample=${fadeOutStart}:nb_samples=${config.fadeOutSamples}`
    : ""}`;
  const output = label(build, "timeline_time_stretch_child");
  build.filters.push(
    `[${selectedAudio}]atrim=start_sample=${sourceStartSamples}:end_sample=${sourceEndSamples},asetpts=N/SR/TB,${resample},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=${evaluationSamples},asetpts=N/SR/TB${fades}[${output}]`,
  );
  return output;
}

function timelineStaticProcessedInsert(
  build: AudioBuild,
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  input: string,
) {
  if (Object.keys(node.properties).length) {
    throw new Error(`CUT_TIMELINE_EDIT_UNSUPPORTED: ${node.id} processed external evaluation cannot carry automation.`);
  }
  const config = referenceAudioNodeConfig(ir, composition, node);
  let result: string;
  if (node.op === "cut.audio.gain") {
    if (config?.kind !== "gain") throw new Error("Internal CUT Gain config mismatch.");
    result = label(build);
    build.filters.push(`[${input}]volume=${dbLinear(config.amountDb)}[${result}]`);
  } else if (node.op === "cut.audio.pan") {
    if (config?.kind !== "pan") throw new Error("Internal CUT Pan config mismatch.");
    const position = config.position;
    const left = position <= 0 ? 1 : Math.cos(position * Math.PI / 2);
    const right = position >= 0 ? 1 : Math.cos(position * Math.PI / 2);
    result = label(build);
    build.filters.push(`[${input}]pan=stereo|c0=${left}*c0|c1=${right}*c1[${result}]`);
  } else if (node.op === "cut.audio.eq") {
    if (config?.kind !== "eq") throw new Error("Internal CUT ParametricEQ config mismatch.");
    const expression = escapeFfmpegAudioExpression(referenceParametricEqExpression(
      String(config.frequency),
      String(config.gainDb),
      String(config.q),
      composition.sampleRate,
    ));
    const left = label(build, "eq_left"), right = label(build, "eq_right");
    const filteredLeft = label(build, "eq_left_out"), filteredRight = label(build, "eq_right_out");
    result = label(build, "eq");
    build.filters.push(`[${input}]channelsplit=channel_layout=stereo[${left}][${right}]`);
    build.filters.push(`[${left}]aeval=exprs='${expression}',aformat=channel_layouts=mono[${filteredLeft}]`);
    build.filters.push(`[${right}]aeval=exprs='${expression}',aformat=channel_layouts=mono[${filteredRight}]`);
    build.filters.push(`[${filteredLeft}][${filteredRight}]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[${result}]`);
  } else if (node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") {
    if (!config || (config.kind !== "highpass" && config.kind !== "lowpass")
      || config.kind !== (node.op === "cut.audio.highpass" ? "highpass" : "lowpass")) {
      throw new Error(`Internal CUT ${node.op} config mismatch.`);
    }
    const expression = escapeFfmpegAudioExpression(referenceStateVariableFilterExpression(
      config.kind,
      String(config.frequency),
      String(config.q),
      composition.sampleRate,
    ));
    const left = label(build, "filter_left"), right = label(build, "filter_right");
    const filteredLeft = label(build, "filter_left_out"), filteredRight = label(build, "filter_right_out");
    result = label(build, "filter");
    build.filters.push(`[${input}]channelsplit=channel_layout=stereo[${left}][${right}]`);
    build.filters.push(`[${left}]aeval=exprs='${expression}',aformat=channel_layouts=mono[${filteredLeft}]`);
    build.filters.push(`[${right}]aeval=exprs='${expression}',aformat=channel_layouts=mono[${filteredRight}]`);
    build.filters.push(`[${filteredLeft}][${filteredRight}]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[${result}]`);
  } else if (node.op === "cut.audio.compressor") {
    if (config?.kind !== "compressor") throw new Error("Internal CUT Compressor config mismatch.");
    const expressions = ([0, 1] as const)
      .map((channel) => escapeFfmpegAudioExpression(referenceCompressorExpression(channel, {
        thresholdDb: String(config.thresholdDb),
        ratio: String(config.ratio),
        attackSeconds: String(config.attackSeconds),
        releaseSeconds: String(config.releaseSeconds),
        makeupDb: String(config.makeupDb),
      }, composition.sampleRate)))
      .join("|");
    result = label(build);
    build.filters.push(`[${input}]aeval=exprs='${expressions}':c=stereo[${result}]`);
  } else if (node.op === "cut.audio.deesser") {
    if (config?.kind !== "deesser") throw new Error("Internal CUT DeEsser config mismatch.");
    const expressions = ([0, 1] as const)
      .map((channel) => escapeFfmpegAudioExpression(referenceDeEsserExpression(channel, {
        intensity: String(config.intensity),
        amount: String(config.amount),
      }, config.plan)))
      .join("|");
    result = label(build);
    build.filters.push(`[${input}]aeval=exprs='${expressions}':c=stereo[${result}]`);
  } else {
    throw new Error(
      `CUT_TIMELINE_EDIT_UNSUPPORTED: ${node.id} is not one static processed external-handle insert.`,
    );
  }
  return result;
}

function timelineProcessedAudioOriginEvaluation(
  build: AudioBuild,
  ir: CutAVIR,
  composition: IRComposition,
  origin: IRNode,
  region: IRNode,
  envelope: TimelineAudioEvaluationEnvelope,
) {
  if (envelope.evaluationPolicy !== "full-declared-handle-domain-v1") {
    throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${origin.id} lost its full declared-handle evaluation policy.`);
  }
  const plan = build.audioRegionPlans.get(region.id);
  if (!plan || !plan.processorNodeIds.length || !ir.nodes[plan.sourceNodeId]) {
    throw new Error(`CUT_TIMELINE_EDIT_UNSUPPORTED: ${origin.id} has no static processed evaluation plan.`);
  }
  let output: string;
  let processorNodeIds: readonly string[] = plan.processorNodeIds;
  if (plan.timeStretchNodeId) {
    if (plan.processorNodeIds.at(-1) !== plan.timeStretchNodeId
      || ir.nodes[plan.timeStretchNodeId]?.children[0] !== plan.sourceNodeId) {
      throw new Error(
        `CUT_TIMELINE_EDIT_UNSUPPORTED: ${origin.id} retimed external evaluation requires one innermost TimeStretch directly above its AudioClip.`,
      );
    }
    const rate = origin.inputs.rate;
    if (rate?.kind !== "quantity" || rate.dimension !== "scalar"
      || compareRational(rate.magnitude, zeroRational) <= 0) {
      throw new Error(`CUT_TIMELINE_EDIT_TIME: ${origin.id} lost its exact retimed source clock.`);
    }
    const source = build.timeStretchSources.get(plan.timeStretchNodeId);
    const expectedSamples = exactSamples(
      divideRational(envelope.source.duration, rate.magnitude),
      build.sampleRate,
      `${origin.op} expanded retimed evaluation duration`,
    );
    if (!source || source.timelineOriginNodeId !== origin.id
      || source.placementSamples !== 0
      || source.renderedSamples !== expectedSamples) {
      throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${origin.id} lost its prepared expanded TimeStretch source.`);
    }
    const input = preparedRawStereoF32Input(build, source);
    output = label(build, "timeline_time_stretch_origin");
    build.filters.push(
      `[${input}:a:0]atrim=start_sample=0:end_sample=${source.renderedSamples},asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo[${output}]`,
    );
    processorNodeIds = plan.processorNodeIds.slice(0, -1);
  } else {
    output = timelineAudioEvaluationLeaf(
      build,
      origin,
      plan.source,
      envelope,
      exactTimeInput(origin, "originDuration"),
    );
  }
  for (const processorId of [...processorNodeIds].reverse()) {
    const processor = ir.nodes[processorId];
    if (!processor) throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${origin.id} lost processor ${processorId}.`);
    output = timelineStaticProcessedInsert(build, ir, composition, processor, output);
  }
  return output;
}

function audioNode(build: AudioBuild, ir: CutAVIR, composition: IRComposition, nodeId: string, stack: Set<string>): string {
  if (stack.has(nodeId)) throw new Error(`Audio graph cycle at ${nodeId}.`); const node = ir.nodes[nodeId]; if (!node) throw new Error(`Missing audio node ${nodeId}.`); stack.add(nodeId);
  const config = referenceAudioNodeConfig(ir, composition, node);
  let result: string;
  if (node.op === "cut.audio.clip" || node.op === "cut.documentary.narration") {
    if (config?.kind !== "media-source") throw new Error(`Internal CUT audio config mismatch for ${node.op}.`);
    const timelineTimeStretchEvaluation = build.timelineTimeStretchChildEvaluations.get(node.id);
    if (timelineTimeStretchEvaluation) {
      if (node.op !== "cut.audio.clip") {
        throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} expanded TimeStretch evaluation requires one AudioClip leaf.`);
      }
      result = timelineTimeStretchChildEvaluationLeaf(
        build,
        node,
        config,
        timelineTimeStretchEvaluation,
      );
      stack.delete(nodeId);
      return result;
    }
    const path = build.paths.get(config.resourceId); if (!path) throw new Error(`Missing locked audio path for ${config.resourceId}.`);
    const input = build.nextInput++; build.args.push("-i", path); const selectedAudio = `${input}:${config.streamIndex}`;
    const regionTransition = node.op === "cut.audio.clip" ? build.audioRegionTransitionBySourceId.get(node.id) : undefined;
    if (regionTransition) {
      if (regionTransition.resourceId !== config.resourceId || regionTransition.streamIndex !== config.streamIndex
        || regionTransition.sourceSampleRate !== config.sourceSampleRate) {
        throw new Error(`CUT_AUDIO_REGION_CROSSFADE_PLAN: ${node.id} extended source selection changed after transition preflight.`);
      }
      const sourceStartSamples = exactSamples(regionTransition.source.start, regionTransition.sourceSampleRate, `${node.op} processed-transition source start`);
      const sourceEndSamples = exactSamples(addRational(regionTransition.source.start, regionTransition.source.duration), regionTransition.sourceSampleRate, `${node.op} processed-transition source end`);
      const placement = addRational(sceneStart(ir, node), regionTransition.destination.start);
      const placementSamples = exactSamples(placement, composition.sampleRate, `${node.op} processed-transition placement`);
      const resample = sourceEndSamples - sourceStartSamples < 32
        ? `aresample=${composition.sampleRate}:filter_size=2`
        : `aresample=${composition.sampleRate}`;
      result = label(build, "audio_region_source");
      // The leaf contributes one extended native trim with no authored fades.
      // Placement occurs before the static chain so every processor observes
      // one continuous composition-clock stream across both touching cuts.
      build.filters.push(`[${selectedAudio}]atrim=start_sample=${sourceStartSamples}:end_sample=${sourceEndSamples},asetpts=N/SR/TB,${resample},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=${regionTransition.destinationSamples},asetpts=N/SR/TB,adelay=delays=${placementSamples}S:all=1,${exactLength(build)}[${result}]`);
      stack.delete(nodeId); return result;
    }
    const placement = addRational(sceneStart(ir, node), node.interval.start), samples = exactSamples(placement, composition.sampleRate, `${node.op} placement`); result = label(build);
    const fades = `${config.fadeInSamples > 0 ? `,afade=t=in:start_sample=0:nb_samples=${config.fadeInSamples}` : ""}${config.fadeOutSamples > 0 ? `,afade=t=out:start_sample=${config.durationSamples - config.fadeOutSamples}:nb_samples=${config.fadeOutSamples}` : ""}`;
    // The default polyphase kernel can emit no samples when a trim is shorter
    // than its filter priming window. CUT selects an explicit two-tap kernel
    // for sub-32-source-sample edits so even a one-sample professional trim
    // has deterministic decoded output; ordinary ranges retain the higher
    // quality polyphase path.
    const resample = config.resampleKernel === "short-range-2-tap"
      ? `aresample=${composition.sampleRate}:filter_size=2`
      : `aresample=${composition.sampleRate}`;
    build.filters.push(`[${selectedAudio}]atrim=start_sample=${config.sourceStartSamples}:end_sample=${config.sourceEndSamples},asetpts=N/SR/TB,${resample},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=${config.durationSamples},asetpts=N/SR/TB${fades},adelay=delays=${samples}S:all=1,${exactLength(build)}[${result}]`);
  } else if (node.op === "cut.edit.clip") {
    const source = node.inputs.source; if (source?.kind !== "resource-ref") throw new Error(`${node.op} needs a resource-ref source.`);
    const locked = lockedAudioStream(ir, source.id), execution = referenceLinkedClipAudioExecutionPlan(ir, composition, node), presentation = execution.presentation;
    const placement = addRational(sceneStart(ir, node), node.interval.start), samples = exactSamples(placement, composition.sampleRate, `${node.op} placement`); result = label(build);
    const linked = exactLinkedClipFades(build, node, presentation.pictureSource.duration);
    const planSamples = (value: string | null, label_: string) => {
      if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`${node.op} ${label_} is not one canonical non-negative sample count.`);
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${node.op} ${label_} is outside the executable sample bound.`);
      return count;
    };
    const plannedDurationSamples = planSamples(presentation.samples.pictureDurationDestinationSamples, "planned duration");
    if (linked.durationSamples !== plannedDurationSamples) throw new Error(`${node.op} presentation plan duration changed after audio preflight.`);
    if (!execution.decoderInput) {
      // A picture interval wholly outside source-audio coverage is exact
      // silence. Do not instantiate an audio decoder merely to discard it.
      build.filters.push(`anullsrc=r=${composition.sampleRate}:cl=stereo,atrim=start_sample=0:end_sample=${linked.durationSamples},asetpts=N/SR/TB${linked.filters},adelay=delays=${samples}S:all=1,${exactLength(build)}[${result}]`);
    } else {
      const path = build.paths.get(source.id); if (!path) throw new Error(`Missing locked audio path for ${source.id}.`);
      const input = build.nextInput++; build.args.push("-i", path); const selectedAudio = `${input}:${locked.streamIndex}`;
      const sourceStartSamples = planSamples(execution.decoderInput.sourceStartSamples, "decoder source start");
      const sourceEndSamples = planSamples(execution.decoderInput.sourceEndSamples, "decoder source end");
      const mediaDestinationSamples = planSamples(execution.decoderInput.destinationSamples, "media destination duration");
      const leadingSilenceSamples = planSamples(execution.decoderInput.destinationStartSamples, "leading silence duration");
      if (sourceEndSamples <= sourceStartSamples || mediaDestinationSamples < 1) throw new Error(`${node.op} has a non-positive intersected source range.`);
      if (locked.sampleRate !== presentation.samples.sourceSampleRate) throw new Error(`${node.op} selected audio sample rate changed after presentation preflight.`);
      const resample = sourceEndSamples - sourceStartSamples < 32
        ? `aresample=${composition.sampleRate}:filter_size=2`
        : `aresample=${composition.sampleRate}`;
      build.filters.push(`[${selectedAudio}]atrim=start_sample=${sourceStartSamples}:end_sample=${sourceEndSamples},asetpts=N/SR/TB,${resample},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=${mediaDestinationSamples},asetpts=N/SR/TB,adelay=delays=${leadingSilenceSamples}S:all=1,apad=whole_len=${linked.durationSamples},atrim=start_sample=0:end_sample=${linked.durationSamples},asetpts=N/SR/TB${linked.filters},adelay=delays=${samples}S:all=1,${exactLength(build)}[${result}]`);
    }
  } else if (node.op === "cut.edit.nested_sequence") {
    const source = build.nestedSources.get(node.id);
    if (!source) throw new Error(`CUT_NESTED_REFERENCE: NestedSequence ${node.id} has no prepared source mix.`);
    const placement = addRational(sceneStart(ir, node), node.interval.start);
    const placementSamples = exactSamples(placement, composition.sampleRate, `${node.op} placement`);
    result = label(build, "nested_sequence");
    if (!source.path) {
      build.filters.push(`anullsrc=r=${composition.sampleRate}:cl=stereo,atrim=start_sample=0:end_sample=${source.selectedSamples},asetpts=N/SR/TB,adelay=delays=${placementSamples}S:all=1,${exactLength(build)}[${result}]`);
    } else {
      const input = preparedRawStereoF32Input(build, { ...source, path: source.path });
      // The prepared raw file already contains only the selected float interval. CUT
      // instantiated the complete source graph, evaluated its causal state
      // from t=0 through the selected end, and trimmed only at the final output
      // boundary, preserving history and over-range samples without retaining
      // prefix/suffix media or prematurely quantizing to integer PCM.
      build.filters.push(`[${input}:a:0]atrim=start_sample=0:end_sample=${source.selectedSamples},asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=${source.selectedSamples},asetpts=N/SR/TB,adelay=delays=${placementSamples}S:all=1,${exactLength(build)}[${result}]`);
    }
  } else if (node.op === "cut.edit.timeline_audio_origin") {
    if (node.ownership !== "reference" || node.children.length !== 1) {
      throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} is not one closed audio origin.`);
    }
    const evaluationEnvelope = timelineAudioEvaluationEnvelope(node);
    if (!evaluationEnvelope) {
      result = audioNode(build, ir, composition, node.children[0]!, new Set(stack));
    } else {
      const child = ir.nodes[node.children[0]!]!;
      const kind = node.inputs.originKind;
      const rate = node.inputs.rate;
      if (kind?.kind !== "string"
        || (kind.value !== "direct-audio" && kind.value !== "processed-audio")
        || rate?.kind !== "quantity" || rate.dimension !== "scalar"
        || compareRational(rate.magnitude, zeroRational) <= 0
        || (kind?.kind === "string" && kind.value === "direct-audio"
          && compareRational(rate.magnitude, rational(1)) !== 0)) {
        throw new Error(
          `CUT_TIMELINE_EDIT_UNSUPPORTED: ${node.id} evaluation envelopes require one exact-1x direct origin or one authenticated static processed origin.`,
        );
      }
      if (kind.value === "processed-audio") {
        if (child.op !== "cut.edit.audio_region") {
          throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} lost its processed AudioRegion authority.`);
        }
        result = timelineProcessedAudioOriginEvaluation(
          build,
          ir,
          composition,
          node,
          child,
          evaluationEnvelope,
        );
      } else {
        if (child.op !== "cut.audio.clip"
          || evaluationEnvelope.evaluationPolicy !== "selected-source-union-v1") {
          throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} lost its direct audio evaluation authority.`);
        }
        const config = referenceAudioNodeConfig(ir, composition, child);
        if (config?.kind !== "media-source") {
          throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} lost its direct audio media authority.`);
        }
        result = timelineAudioEvaluationLeaf(
          build,
          node,
          config,
          evaluationEnvelope,
          exactTimeInput(node, "originDuration"),
        );
      }
    }
  } else if (node.op === "cut.edit.timeline_audio_view") {
    if (node.children.length !== 0 || node.ownership !== "child") {
      throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} is not one closed audio view.`);
    }
    const { originId, output } = timelineAudioOriginOutput(build, ir, composition, node, stack);
    const origin = ir.nodes[originId]!;
    const sliceOffset = exactTimeInput(node, "sliceOffset");
    const originDuration = exactTimeInput(node, "originDuration");
    const rateInput = node.inputs.rate;
    if (rateInput?.kind !== "quantity" || rateInput.dimension !== "scalar"
      || compareRational(rateInput.magnitude, zeroRational) <= 0) {
      throw new Error(`CUT_TIMELINE_EDIT_TIME: ${node.id} lost its exact positive source-clock rate.`);
    }
    const rate = rateInput.magnitude;
    const evaluationEnvelope = timelineAudioEvaluationEnvelope(origin);
    const mirroredEnvelope = timelineAudioEvaluationEnvelope(node);
    if (JSON.stringify(evaluationEnvelope) !== JSON.stringify(mirroredEnvelope)) {
      throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} changed its audio evaluation envelope after validation.`);
    }
    const sliceEnd = addRational(sliceOffset, node.interval.duration);
    const lowerPresentationBound = evaluationEnvelope
      ? subtractRational(zeroRational, evaluationEnvelope.presentationZero)
      : zeroRational;
    const upperPresentationBound = evaluationEnvelope
      ? subtractRational(
          divideRational(evaluationEnvelope.source.duration, rate),
          evaluationEnvelope.presentationZero,
        )
      : originDuration;
    if (compareRational(sliceOffset, lowerPresentationBound) < 0
      || compareRational(originDuration, zeroRational) <= 0
      || compareRational(sliceEnd, upperPresentationBound) > 0) {
      throw new Error(`CUT_TIMELINE_EDIT_TIME: ${node.id} slice exceeds its authenticated audio origin.`);
    }
    const transition = build.timelineAudioViewTransitionByViewId.get(node.id);
    if (transition && (transition.originNodeId !== origin.id
      || compareRational(transition.rate, rate) !== 0)) {
      throw new Error(`CUT_AUDIO_REGION_CROSSFADE_PLAN: ${node.id} transition authorization changed after preflight.`);
    }
    const originPlacement = addRational(sceneStart(ir, origin), origin.interval.start);
    const viewSource = node.inputs.source;
    if (viewSource?.kind !== "range" || !viewSource.exclusive
      || viewSource.start.kind !== "quantity" || viewSource.start.dimension !== "time" || viewSource.start.unit !== "s"
      || viewSource.end.kind !== "quantity" || viewSource.end.dimension !== "time" || viewSource.end.unit !== "s") {
      throw new Error(`CUT_TIMELINE_EDIT_RESULT: ${node.id} lost its exact source-clock view.`);
    }
    const originSourceStart = timelineAudioOriginSourceStart(
      build,
      ir,
      origin,
    );
    const selectedSource = transition?.source ?? {
      start: viewSource.start.magnitude,
      duration: subtractRational(viewSource.end.magnitude, viewSource.start.magnitude),
    };
    const selectedBounds = evaluationEnvelope?.source ?? {
      start: originSourceStart,
      duration: multiplyRational(originDuration, rate),
    };
    if (compareRational(selectedSource.start, selectedBounds.start) < 0
      || compareRational(
        addRational(selectedSource.start, selectedSource.duration),
        addRational(selectedBounds.start, selectedBounds.duration),
      ) > 0) {
      throw new Error(`CUT_TIMELINE_EDIT_TIME: ${node.id} selected source exceeds its authenticated audio evaluation envelope.`);
    }
    const selectedPresentationOffset = divideRational(
      subtractRational(selectedSource.start, selectedBounds.start),
      rate,
    );
    if (!transition && evaluationEnvelope && compareRational(
      selectedPresentationOffset,
      addRational(sliceOffset, evaluationEnvelope.presentationZero),
    ) !== 0) {
      throw new Error(
        `CUT_TIMELINE_EDIT_RESULT: ${node.id} evaluation-relative slice no longer equals sliceOffset + presentationZero.`,
      );
    }
    const selectedPresentationDuration = divideRational(selectedSource.duration, rate);
    const absoluteSliceStart = evaluationEnvelope
      ? selectedPresentationOffset
      : addRational(originPlacement, selectedPresentationOffset);
    const sourceStartSamples = exactSamples(absoluteSliceStart, build.sampleRate, `${node.op} source slice start`);
    const destinationSamples = exactSamples(selectedPresentationDuration, build.sampleRate, `${node.op} destination duration`);
    if (transition && destinationSamples !== transition.destinationSamples) {
      throw new Error(`CUT_AUDIO_REGION_CROSSFADE_PLAN: ${node.id} transition source/destination sample counts diverged.`);
    }
    const sourceEndSamples = sourceStartSamples + destinationSamples;
    const destinationPlacement = addRational(
      sceneStart(ir, node),
      transition?.destination.start ?? node.interval.start,
    );
    const destinationStartSamples = exactSamples(destinationPlacement, build.sampleRate, `${node.op} destination placement`);
    const envelope = transition?.envelopes.length
      ? `,aeval=exprs='${[0, 1].map((channel) => `val(${channel})*(${transition.envelopes.map(referenceAudioCrossfadeEnvelopeExpression).join("*")})`).map(escapeFfmpegAudioExpression).join("|")}':c=stereo`
      : "";
    result = label(build, "timeline_audio_view");
    build.filters.push(
      `[${output}]atrim=start_sample=${sourceStartSamples}:end_sample=${sourceEndSamples},asetpts=N/SR/TB${envelope},adelay=delays=${destinationStartSamples}S:all=1,${exactLength(build)}[${result}]`,
    );
  } else if (node.op === "cut.edit.audio_gap") {
    const placement = addRational(sceneStart(ir, node), node.interval.start);
    const startSamples = exactSamples(placement, composition.sampleRate, `${node.op} placement`);
    const durationSamples = exactSamples(node.interval.duration, composition.sampleRate, `${node.op} duration`);
    result = label(build);
    build.filters.push(`anullsrc=r=${composition.sampleRate}:cl=stereo,atrim=start_sample=0:end_sample=${durationSamples},asetpts=N/SR/TB,adelay=delays=${startSamples}S:all=1,${exactLength(build)}[${result}]`);
  } else if (node.op === "cut.edit.audio_track") {
    if (!node.editorial || node.editorial.kind !== "audio-track" || node.editorial.items.length !== node.children.length) {
      throw new Error(`cut.edit.audio_track at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column} requires executable ordered audio-track metadata.`);
    }
    const children = node.editorial.items.map((item, index) => {
      if (item.order !== index || node.children[index] !== item.nodeId) throw new Error(`cut.edit.audio_track item ${index} does not preserve authored source order.`);
      return item;
    });
    validateReferenceAudioTrackOperationPlan(ir, composition, node, build.linkedEditAudioByTrackId.get(node.id));
    const expected = node.editorial.operationPlan
      ? executeAudioEditOperationPlan(node.editorial.operationPlan).transitions
      : referenceTimelineEditAudioTrackTransitions(ir, node) ?? [];
    const transitionPlans = referenceAudioTrackTransitionPlans(
      ir,
      composition,
      node as IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> },
      expected,
    );
    if (transitionPlans.some((plan) => plan.kind === "region")) {
      if (transitionPlans.some((plan) => plan.kind !== "region")) throw new Error("CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY: processed transition plan mixed region and direct clip render operands.");
      for (const plan of transitionPlans) {
        if (plan.kind !== "region") continue;
        build.audioRegionTransitionByRegionId.set(plan.nodeId, plan);
        build.audioRegionTransitionBySourceId.set(plan.sourceNodeId, plan);
      }
      result = mix(build, transitionPlans.map((plan) => audioNode(build, ir, composition, plan.nodeId, new Set(stack))));
    } else if (transitionPlans.some((plan) => plan.kind === "timeline-view")) {
      if (transitionPlans.some((plan) => plan.kind !== "timeline-view")) {
        throw new Error("CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY: retimed TimelineEdit transition mixed incompatible render operands.");
      }
      for (const plan of transitionPlans) {
        if (plan.kind === "timeline-view") {
          build.timelineAudioViewTransitionByViewId.set(plan.nodeId, plan);
        }
      }
      result = mix(build, transitionPlans.map((plan) => audioNode(build, ir, composition, plan.nodeId, new Set(stack))));
    } else if (transitionPlans.length) {
      result = mix(build, transitionPlans.map((plan) => {
        if (plan.kind !== "clip") throw new Error("Internal CUT audio transition plan kind mismatch.");
        return audioTrackPlannedClip(build, ir, composition, node, plan);
      }));
    } else result = mix(build, children.map((item) => audioNode(build, ir, composition, item.nodeId, new Set(stack))));
  } else if (node.op === "cut.edit.audio_region") {
    const plan = build.audioRegionPlans.get(node.id);
    if (!plan) throw new Error(`CUT_EDIT_AUDIO_REGION: ${node.id} has no authorized closed AudioRegion plan.`);
    const transition = build.audioRegionTransitionByRegionId.get(node.id);
    if (transition && transition.authorizationHash !== plan.authorizationHash) {
      throw new Error(`CUT_AUDIO_REGION_CROSSFADE_PLAN: ${node.id} authorization changed after transition preflight.`);
    }
    const input = audioNode(build, ir, composition, plan.processorRootId, new Set(stack));
    result = label(build, "audio_region");
    // Inserts such as the state-variable HPF/LPF and parametric EQ retain
    // causal state and can ring after their source leaf ends. AudioRegion is a
    // destination item, so CUT evaluates the processor chain normally, then
    // owns an exact outer half-open sample gate. No pre-roll or filter tail may
    // leak into adjacent track items.
    if (!transition) {
      build.filters.push(`[${input}]atrim=start_sample=${plan.destinationStartSamples}:end_sample=${plan.destinationEndSamples},asetpts=N/SR/TB,adelay=delays=${plan.destinationStartSamples}S:all=1,${exactLength(build)}[${result}]`);
    } else {
      const absoluteStart = addRational(sceneStart(ir, node), transition.destination.start);
      const startSamples = exactSamples(absoluteStart, composition.sampleRate, `${node.op} expanded transition gate start`);
      const endSamples = startSamples + transition.destinationSamples;
      const envelope = transition.envelopes.length
        ? `,aeval=exprs='${[0, 1].map((channel) => `val(${channel})*(${transition.envelopes.map(referenceAudioCrossfadeEnvelopeExpression).join("*")})`).map(escapeFfmpegAudioExpression).join("|")}':c=stereo`
        : "";
      // Gate the evaluated static chain to the union of its visible interval
      // and consumed handles, then apply every incoming/outgoing envelope on
      // that single processor instance before the AudioTrack mix.
      build.filters.push(`[${input}]atrim=start_sample=${startSamples}:end_sample=${endSamples},asetpts=N/SR/TB${envelope},adelay=delays=${startSamples}S:all=1,${exactLength(build)}[${result}]`);
    }
  } else if (node.op === "cut.edit.transition") {
    const transition = referenceTransitionContract(ir, composition, node);
    const outgoing = audioNode(build, ir, composition, transition.outgoingNodeId, new Set(stack));
    const incoming = audioNode(build, ir, composition, transition.incomingNodeId, new Set(stack));
    const absoluteStart = addRational(sceneStart(ir, node), transition.overlapStart);
    const startSamples = exactSamples(absoluteStart, composition.sampleRate, `${node.op} overlap start`);
    const durationSamples = exactSamples(transition.overlapDuration, composition.sampleRate, `${node.op} overlap duration`);
    const fadedOutgoing = label(build, "transition_out"), fadedIncoming = label(build, "transition_in");
    build.filters.push(`[${outgoing}]afade=t=out:curve=tri:start_sample=${startSamples}:nb_samples=${durationSamples}[${fadedOutgoing}]`);
    build.filters.push(`[${incoming}]afade=t=in:curve=tri:start_sample=${startSamples}:nb_samples=${durationSamples}[${fadedIncoming}]`);
    result = mix(build, [fadedOutgoing, fadedIncoming]);
  } else if (node.op === "cut.edit.jcut" || node.op === "cut.edit.lcut") {
    const split = referenceLinkedSplitContract(ir, composition, node);
    const cutSamples = exactSamples(addRational(sceneStart(ir, node), split.audioCut), composition.sampleRate, `${node.op} audio cut`);
    const outgoing = audioNode(build, ir, composition, split.outgoingNodeId, new Set(stack));
    const incoming = audioNode(build, ir, composition, split.incomingNodeId, new Set(stack));
    const gate = (input: string, side: "before" | "after") => {
      const selected = side === "before" ? `lt(n,${cutSamples})` : `gte(n,${cutSamples})`;
      const expressions = [0, 1]
        .map((channel) => escapeFfmpegAudioExpression(`if(${selected},val(${channel}),0)`))
        .join("|");
      const output = label(build, `linked_split_${side}`);
      build.filters.push(`[${input}]aeval=exprs='${expressions}':c=stereo[${output}]`);
      return output;
    };
    // J/L is a split edit, not an implicit crossfade or doubled overlap. The
    // exact half-open audio cut selects one continuously running linked source
    // on each side while picture independently switches at split.pictureCut.
    result = mix(build, [gate(outgoing, "before"), gate(incoming, "after")]);
  } else if (node.op === "cut.audio.synth") {
    const source = build.synthSources.get(node.id); if (!source) throw new Error(`Missing prepared Synth source for ${node.id}.`);
    const input = build.nextInput++; build.args.push("-i", source.path); result = label(build);
    build.filters.push(`[${input}:a]atrim=start_sample=0:end_sample=${source.renderedSamples},asetpts=N/SR/TB,aresample=${composition.sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=${source.placementSamples}S:all=1,${exactLength(build)}[${result}]`);
  } else if (node.op === "cut.audio.time_stretch") {
    if (config?.kind !== "time-stretch") throw new Error("Internal CUT TimeStretch config mismatch.");
    const source = build.timeStretchSources.get(node.id); if (!source) throw new Error(`Missing prepared TimeStretch source for ${node.id}.`);
    const input = preparedRawStereoF32Input(build, source); result = label(build);
    build.filters.push(`[${input}:a]atrim=start_sample=0:end_sample=${source.renderedSamples},asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=${source.placementSamples}S:all=1,${exactLength(build)}[${result}]`);
  } else if (node.op === "cut.audio.tempo_delay") {
    if (config?.kind !== "tempo-delay") throw new Error("Internal CUT TempoDelay config mismatch.");
    const source = build.tempoDelaySources.get(node.id);
    if (!source) throw new Error(`CUT_AUDIO_TEMPO_DELAY_GRAPH: TempoDelay ${node.id} has no prepared CUT-owned DSP source.`);
    const input = preparedRawStereoF32Input(build, source); result = label(build, "tempo_delay");
    build.filters.push(`[${input}:a]atrim=start_sample=0:end_sample=${source.renderedSamples},asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo,${exactLength(build)}[${result}]`);
  } else if (node.op === "cut.audio.limiter") {
    if (config?.kind !== "limiter") throw new Error("Internal CUT Limiter config mismatch.");
    const source = build.limiterSources.get(node.id);
    if (!source) throw new Error(`CUT_AUDIO_LIMITER_GRAPH: Limiter ${node.id} has no prepared CUT-owned DSP source.`);
    const input = preparedRawStereoF32Input(build, source); result = label(build, "limiter");
    build.filters.push(`[${input}:a]atrim=start_sample=0:end_sample=${source.renderedSamples},asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo,${exactLength(build)}[${result}]`);
  } else if (node.op === "cut.audio.tone" || node.op === "cut.audio.noise") {
    if (!config || (config.kind !== "tone" && config.kind !== "noise")) throw new Error(`Internal CUT audio config mismatch for ${node.op}.`);
    const duration = config.durationSamples / composition.sampleRate, placement = addRational(sceneStart(ir, node), node.interval.start), samples = exactSamples(placement, composition.sampleRate, `${node.op} placement`); result = label(build);
    const fades = `${config.fadeInSamples > 0 ? `,afade=t=in:start_sample=0:nb_samples=${config.fadeInSamples}` : ""}${config.fadeOutSamples > 0 ? `,afade=t=out:start_sample=${config.durationSamples - config.fadeOutSamples}:nb_samples=${config.fadeOutSamples}` : ""}`;
    if (node.op === "cut.audio.tone") {
      if (config.kind !== "tone" || config.frequency === undefined) throw new Error("Internal CUT Tone config mismatch.");
      // FFmpeg's sine source is fixed at 1/8 full scale. CUT amplitude is an
      // absolute linear peak ratio, so compensate once at the source boundary.
      build.filters.push(`sine=frequency=${config.frequency}:sample_rate=${composition.sampleRate}:duration=${duration},atrim=end_sample=${config.durationSamples},volume=${config.amplitude * 8},aformat=sample_fmts=fltp:channel_layouts=stereo${fades},adelay=delays=${samples}S:all=1,${exactLength(build)}[${result}]`);
    } else {
      if (config.kind !== "noise" || config.color === undefined || config.seed === undefined) throw new Error("Internal CUT Noise config mismatch.");
      build.filters.push(`anoisesrc=sample_rate=${composition.sampleRate}:amplitude=${config.amplitude}:duration=${duration}:color=${config.color}:seed=${config.seed},atrim=end_sample=${config.durationSamples},aformat=sample_fmts=fltp:channel_layouts=stereo${fades},adelay=delays=${samples}S:all=1,${exactLength(build)}[${result}]`);
    }
  } else if (node.op === "cut.audio.return") {
    const sendIds = build.routing.returns.get(node.id);
    if (!sendIds?.length || config?.kind !== "return") throw new Error(`Internal CUT Return routing mismatch for ${node.id}.`);
    result = mix(build, sendIds.map((sendId) => audioSendContribution(build, ir, composition, sendId, new Set(stack))));
  } else {
    const children = node.children.map((child) => audioNode(build, ir, composition, child, new Set(stack))); const input = mix(build, children);
    if (node.op === "cut.kernel.fragment" || node.op === "cut.audio.bus" || node.op === "cut.audio.submix" || node.op === "cut.audio.send" || node.op === "cut.audio.meter") result = input;
    else if (node.op === "cut.audio.gain") {
      if (config?.kind !== "gain") throw new Error("Internal CUT Gain config mismatch.");
      const automation = compileReferenceAudioAutomation(ir, composition, node); result = label(build);
      if (!automation) build.filters.push(`[${input}]volume=${dbLinear(config.amountDb)}[${result}]`);
      else {
        const linear = `pow(10,(${automation.valueExpression})/20)`;
        const expressions = [`val(0)*(${linear})`, `val(1)*(${linear})`].map(escapeFfmpegAudioExpression).join("|");
        build.filters.push(`[${input}]aeval=exprs='${expressions}':c=stereo[${result}]`);
      }
    }
    else if (node.op === "cut.audio.pan") {
      if (config?.kind !== "pan") throw new Error("Internal CUT Pan config mismatch.");
      const automation = compileReferenceAudioAutomation(ir, composition, node); result = label(build);
      if (!automation) {
        const position = config.position, left = position <= 0 ? 1 : Math.cos(position * Math.PI / 2), right = position >= 0 ? 1 : Math.cos(position * Math.PI / 2);
        build.filters.push(`[${input}]pan=stereo|c0=${left}*c0|c1=${right}*c1[${result}]`);
      } else {
        const position = `(${automation.valueExpression})`;
        const left = `if(lte(${position},0),1,cos(${position}*PI/2))`, right = `if(gte(${position},0),1,cos(${position}*PI/2))`;
        const expressions = [`val(0)*(${left})`, `val(1)*(${right})`].map(escapeFfmpegAudioExpression).join("|");
        build.filters.push(`[${input}]aeval=exprs='${expressions}':c=stereo[${result}]`);
      }
    }
    else if (node.op === "cut.audio.channel_matrix") {
      if (config?.kind !== "channel-matrix") throw new Error("Internal CUT ChannelMatrix config mismatch.");
      result = label(build, "channel_matrix");
      const left = `${config.leftToLeft}*c0+${config.rightToLeft}*c1`;
      const right = `${config.leftToRight}*c0+${config.rightToRight}*c1`;
      build.filters.push(`[${input}]pan=stereo|c0=${left}|c1=${right}[${result}]`);
    }
    else if (node.op === "cut.audio.eq") {
      if (config?.kind !== "eq") throw new Error("Internal CUT ParametricEQ config mismatch.");
      const automation = compileReferenceParametricEqAutomations(ir, composition, node);
      const frequency = automation.frequency?.valueExpression ?? String(config.frequency);
      const gain = automation.gain?.valueExpression ?? String(config.gainDb);
      const q = automation.q?.valueExpression ?? String(config.q);
      const expression = escapeFfmpegAudioExpression(referenceParametricEqExpression(frequency, gain, q, composition.sampleRate));
      const left = label(build, "eq_left"), right = label(build, "eq_right");
      const filteredLeft = label(build, "eq_left_out"), filteredRight = label(build, "eq_right_out");
      result = label(build, "eq");
      build.filters.push(`[${input}]channelsplit=channel_layout=stereo[${left}][${right}]`);
      build.filters.push(`[${left}]aeval=exprs='${expression}',aformat=channel_layouts=mono[${filteredLeft}]`);
      build.filters.push(`[${right}]aeval=exprs='${expression}',aformat=channel_layouts=mono[${filteredRight}]`);
      build.filters.push(`[${filteredLeft}][${filteredRight}]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[${result}]`);
    }
    else if (node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") {
      if (!config || (config.kind !== "highpass" && config.kind !== "lowpass") || config.kind !== (node.op === "cut.audio.highpass" ? "highpass" : "lowpass")) throw new Error(`Internal CUT ${node.op} config mismatch.`);
      const automation = compileReferenceStateVariableFilterAutomations(ir, composition, node);
      const cutoff = automation.frequency?.valueExpression ?? String(config.frequency);
      const q = automation.q?.valueExpression ?? String(config.q);
      const expression = escapeFfmpegAudioExpression(referenceStateVariableFilterExpression(config.kind, cutoff, q, composition.sampleRate));
      const left = label(build, "filter_left"), right = label(build, "filter_right");
      const filteredLeft = label(build, "filter_left_out"), filteredRight = label(build, "filter_right_out");
      result = label(build, "filter");
      build.filters.push(`[${input}]channelsplit=channel_layout=stereo[${left}][${right}]`);
      build.filters.push(`[${left}]aeval=exprs='${expression}',aformat=channel_layouts=mono[${filteredLeft}]`);
      build.filters.push(`[${right}]aeval=exprs='${expression}',aformat=channel_layouts=mono[${filteredRight}]`);
      build.filters.push(`[${filteredLeft}][${filteredRight}]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[${result}]`);
    }
    else if (node.op === "cut.audio.compressor") {
      if (config?.kind !== "compressor") throw new Error("Internal CUT Compressor config mismatch.");
      const automation = compileReferenceCompressorAutomations(ir, composition, node);
      const controls = {
        thresholdDb: automation.threshold?.valueExpression ?? String(config.thresholdDb),
        ratio: automation.ratio?.valueExpression ?? String(config.ratio),
        attackSeconds: automation.attack?.valueExpression ?? String(config.attackSeconds),
        releaseSeconds: automation.release?.valueExpression ?? String(config.releaseSeconds),
        makeupDb: automation.makeup?.valueExpression ?? String(config.makeupDb),
      };
      const expressions = ([0, 1] as const)
        .map((channel) => escapeFfmpegAudioExpression(referenceCompressorExpression(channel, controls, composition.sampleRate)))
        .join("|");
      result = label(build);
      build.filters.push(`[${input}]aeval=exprs='${expressions}':c=stereo[${result}]`);
    }
    else if (node.op === "cut.audio.deesser") {
      if (config?.kind !== "deesser") throw new Error("Internal CUT DeEsser config mismatch.");
      const automation = compileReferenceDeEsserAutomations(ir, composition, node);
      const controls = {
        intensity: automation.intensity?.valueExpression ?? String(config.intensity),
        amount: automation.amount?.valueExpression ?? String(config.amount),
      };
      const expressions = ([0, 1] as const)
        .map((channel) => escapeFfmpegAudioExpression(referenceDeEsserExpression(channel, controls, config.plan)))
        .join("|");
      result = label(build);
      build.filters.push(`[${input}]aeval=exprs='${expressions}':c=stereo[${result}]`);
    }
    else if (node.op === "cut.audio.reverb") {
      if (config?.kind !== "reverb") throw new Error("Internal CUT Reverb config mismatch.");
      const automation = compileReferenceAudioAutomation(ir, composition, node);
      if (automation) {
        // Keep exactly one effect state alive for the full node interval. CUT
        // automates only the complementary output coefficients, so a wet
        // change never restarts the reverb or duplicates event endpoints.
        const dry = label(build, "dry"), effectInput = label(build, "wet_in"), cancelInput = label(build, "wet_cancel_in"), effect = label(build, "wet_effect"), cancel = label(build, "wet_cancel"), wetOnly = label(build, "wet_only");
        const dryGain = label(build, "dry_gain"), effectGain = label(build, "wet_gain"); result = label(build);
        build.filters.push(`[${input}]asplit=3[${dry}][${effectInput}][${cancelInput}]`);
        build.filters.push(`[${effectInput}]aecho=0.8:0.7:40|80:0.5|0.3[${effect}]`);
        build.filters.push(`[${cancelInput}]volume=-0.56[${cancel}]`);
        build.filters.push(`[${effect}][${cancel}]amix=inputs=2:normalize=0:dropout_transition=0[${wetOnly}]`);
        const wet = `(${automation.valueExpression})`, dryCoefficient = `(1-${wet})`;
        const dryExpressions = [`val(0)*${dryCoefficient}`, `val(1)*${dryCoefficient}`].map(escapeFfmpegAudioExpression).join("|");
        const wetExpressions = [`val(0)*${wet}`, `val(1)*${wet}`].map(escapeFfmpegAudioExpression).join("|");
        build.filters.push(`[${dry}]aeval=exprs='${dryExpressions}':c=stereo[${dryGain}]`);
        build.filters.push(`[${wetOnly}]aeval=exprs='${wetExpressions}':c=stereo[${effectGain}]`);
        build.filters.push(`[${dryGain}][${effectGain}]amix=inputs=2:normalize=0:dropout_transition=0[${result}]`);
      }
      else if (config.wet === 0) result = input;
      else {
        // aecho includes an in_gain*out_gain (0.56) direct component. Cancel
        // that component before the authored dry/wet crossfade so 100% is a
        // literal effect-only endpoint rather than a second attenuated dry mix.
        const effectInput = label(build, "wet_in"), cancelInput = label(build, "wet_cancel_in"), effect = label(build, "wet_effect"), cancel = label(build, "wet_cancel"), wetOnly = label(build, "wet_only"), dry = config.wet === 1 ? undefined : label(build, "dry");
        build.filters.push(dry === undefined ? `[${input}]asplit=2[${effectInput}][${cancelInput}]` : `[${input}]asplit=3[${dry}][${effectInput}][${cancelInput}]`);
        build.filters.push(`[${effectInput}]aecho=0.8:0.7:40|80:0.5|0.3[${effect}]`);
        build.filters.push(`[${cancelInput}]volume=-0.56[${cancel}]`);
        build.filters.push(`[${effect}][${cancel}]amix=inputs=2:normalize=0:dropout_transition=0[${wetOnly}]`);
        if (config.wet === 1) result = wetOnly;
        else {
          const dryGain = label(build, "dry_gain"), effectGain = label(build, "wet_gain"); result = label(build);
          build.filters.push(`[${dry!}]volume=${1 - config.wet}[${dryGain}]`);
          build.filters.push(`[${wetOnly}]volume=${config.wet}[${effectGain}]`);
          build.filters.push(`[${dryGain}][${effectGain}]amix=inputs=2:normalize=0:dropout_transition=0[${result}]`);
        }
      }
    }
    else if (node.op === "cut.audio.delay") {
      if (config?.kind !== "delay") throw new Error("Internal CUT Delay config mismatch.");
      const automation = compileReferenceAudioAutomation(ir, composition, node);
      if (!automation && config.wet === 0) result = input;
      else if (automation) {
        // Keep one fixed feed-forward tap topology alive for the complete
        // node. Only the complementary dry/tap coefficients vary at the
        // destination sample index, so automation never restarts a delay,
        // loses a tail, or turns a curve into a sequence of static filters.
        const branches = Array.from({ length: config.repeats + 1 }, () => label(build, "delay_in"));
        build.filters.push(`[${input}]asplit=${branches.length}${branches.map((branch) => `[${branch}]`).join("")}`);
        const wet = `(${automation.valueExpression})`, mixed: string[] = [];
        const dry = label(build, "delay_dry");
        const dryExpressions = [0, 1]
          .map((channel) => `val(${channel})*(1-${wet})`)
          .map(escapeFfmpegAudioExpression)
          .join("|");
        build.filters.push(`[${branches[0]}]aeval=exprs='${dryExpressions}':c=stereo[${dry}]`);
        mixed.push(dry);
        for (const [tap, plan] of config.taps.entries()) {
          const delayed = label(build, `delay_tap_${tap + 1}`), gained = label(build, `delay_gain_${tap + 1}`);
          const coefficient = `(${wet}*${plan.normalizedWeight})`;
          const expressions = [0, 1]
            .map((channel) => `val(${channel})*${coefficient}`)
            .map(escapeFfmpegAudioExpression)
            .join("|");
          build.filters.push(`[${branches[tap + 1]}]adelay=delays=${plan.offsetSamples}S:all=1,${exactLength(build)}[${delayed}]`);
          build.filters.push(`[${delayed}]aeval=exprs='${expressions}':c=stereo[${gained}]`);
          mixed.push(gained);
        }
        result = label(build);
        build.filters.push(`${mixed.map((branch) => `[${branch}]`).join("")}amix=inputs=${mixed.length}:normalize=0:dropout_transition=0,${exactLength(build)}[${result}]`);
      }
      else {
        // Delay is deliberately a finite feed-forward tap plan, not recursive
        // feedback hidden inside a backend filter. Every branch, coefficient,
        // and sample offset comes from the validated typed config above.
        const branchCount = config.repeats + (config.wet < 1 ? 1 : 0);
        const branches = Array.from({ length: branchCount }, () => label(build, "delay_in"));
        if (branchCount === 1) branches[0] = input;
        else build.filters.push(`[${input}]asplit=${branchCount}${branches.map((branch) => `[${branch}]`).join("")}`);
        const mixed: string[] = [];
        let branchIndex = 0;
        if (config.wet < 1) {
          const dry = label(build, "delay_dry");
          build.filters.push(`[${branches[branchIndex++]}]volume=${1 - config.wet}[${dry}]`);
          mixed.push(dry);
        }
        for (const [tap, plan] of config.taps.entries()) {
          const delayed = label(build, `delay_tap_${tap + 1}`);
          const gain = config.wet * plan.normalizedWeight;
          build.filters.push(`[${branches[branchIndex++]}]adelay=delays=${plan.offsetSamples}S:all=1,${exactLength(build)},volume=${gain}[${delayed}]`);
          mixed.push(delayed);
        }
        if (mixed.length === 1) result = mixed[0];
        else {
          result = label(build);
          build.filters.push(`${mixed.map((branch) => `[${branch}]`).join("")}amix=inputs=${mixed.length}:normalize=0:dropout_transition=0,${exactLength(build)}[${result}]`);
        }
      }
    }
    else if (node.op === "cut.audio.sidechain") {
      if (config?.kind !== "sidechain") throw new Error("Internal CUT Sidechain config mismatch.");
      const key = audioNode(build, ir, composition, config.sourceNodeId, new Set(stack));
      const controls = compileReferenceSidechainAutomations(ir, composition, node);
      const programStereo = label(build, "sidechain_program_stereo"), keyStereo = label(build, "sidechain_key_stereo");
      const joined = label(build, "sidechain_join"); result = label(build, "sidechain");
      // Stateful filters and decoded sources can leave FFmpeg's negotiated
      // channel-layout metadata unknown even though CUT's executable boundary
      // is closed stereo. Reassert that public contract on both branches
      // before the quad detector join; otherwise a valid filtered AudioClip
      // key fails host negotiation while a procedural Tone happens to pass.
      build.filters.push(`[${input}]aformat=sample_fmts=fltp:channel_layouts=stereo[${programStereo}]`);
      build.filters.push(`[${key}]aformat=sample_fmts=fltp:channel_layouts=stereo[${keyStereo}]`);
      build.filters.push(`[${programStereo}][${keyStereo}]join=inputs=2:channel_layout=quad:map=0.0-FL|0.1-FR|1.0-BL|1.1-BR[${joined}]`);
      const expressions = [0, 1]
        .map((channel) => referenceSidechainExpression(channel as 0 | 1, {
          amountDb: controls.amount?.valueExpression ?? String(config.amountDb),
          thresholdDb: controls.threshold?.valueExpression ?? String(config.thresholdDb),
          attackSeconds: controls.attack?.valueExpression ?? String(config.attackSeconds),
          releaseSeconds: controls.release?.valueExpression ?? String(config.releaseSeconds),
        }, composition.sampleRate))
        .map(escapeFfmpegAudioExpression)
        .join("|");
      build.filters.push(`[${joined}]aeval=exprs='${expressions}':c=stereo[${result}]`);
    } else throw new Error(`Unsupported audio kernel ${node.op}.`);
  }
  stack.delete(nodeId); return result;
}

export function referenceMasterAudioRootIds(ir: CutAVIR, composition: IRComposition) {
  return referenceAudioCompositionRootIds(ir, composition);
}

export const referenceAudioSelectionOutputFormats = ["pcm24-wave", "raw-stereo-f32le"] as const;
export type ReferenceAudioSelectionOutputFormat = typeof referenceAudioSelectionOutputFormats[number];

export type ReferenceAudioSelectionErrorCode =
  | "CUT_AUDIO_SELECTION_FORMAT"
  | "CUT_AUDIO_SELECTION_STRUCTURE";

type ReferenceAudioSelectionOwner = Pick<IRNode | IRComposition, "id" | "provenance">;

export class ReferenceAudioSelectionError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceAudioSelectionErrorCode, owner: ReferenceAudioSelectionOwner, message: string) {
    const { module, span } = owner.provenance;
    super(`${code}: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceAudioSelectionError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: owner.id };
  }
}

export type ReferenceAudioSelectionOptions = {
  /** Explicit output serialization. Ordinary callers retain canonical PCM24 WAVE. */
  outputFormat?: ReferenceAudioSelectionOutputFormat;
  /** Remove muxer metadata and request FFmpeg's bit-exact PCM/WAVE path. */
  bitExactWave?: boolean;
  /** Internal exact half-open output sample range used by CUT-owned processors. */
  sampleRange?: { start: number; end: number };
  /** @internal One invocation-scoped verified snapshot resolver. */
  __verifiedResourcePath?: ReferenceVerifiedInputSession["pathFor"];
  /** @internal One authenticated expanded source selection for TimelineEdit TimeStretch preparation. */
  __timelineTimeStretchChildEvaluation?: ReferenceTimelineTimeStretchChildEvaluation;
  /** @internal Exact A/B controller; production always attempts admitted static DSP islands. */
  __disableStaticDspIsland?: boolean;
};

function selectionFail(owner: ReferenceAudioSelectionOwner, code: ReferenceAudioSelectionErrorCode, message: string): never {
  throw new ReferenceAudioSelectionError(code, owner, message);
}

function referenceAudioSelectionOutputFormat(owner: ReferenceAudioSelectionOwner, options: ReferenceAudioSelectionOptions) {
  const format = options.outputFormat ?? "pcm24-wave";
  if (!referenceAudioSelectionOutputFormats.includes(format)) {
    selectionFail(owner, "CUT_AUDIO_SELECTION_FORMAT", `outputFormat must be one of: ${referenceAudioSelectionOutputFormats.join(", ")}.`);
  }
  if (format === "raw-stereo-f32le" && options.bitExactWave !== undefined) {
    selectionFail(owner, "CUT_AUDIO_SELECTION_FORMAT", "bitExactWave applies only to pcm24-wave output and cannot be accepted for raw-stereo-f32le.");
  }
  if (format === "pcm24-wave" && options.bitExactWave !== undefined && options.bitExactWave !== true) {
    selectionFail(owner, "CUT_AUDIO_SELECTION_FORMAT", "bitExactWave, when supplied for pcm24-wave output, must be true; CUT always publishes the canonical metadata-free PCM24 WAVE encoding.");
  }
  return format;
}

function selectedAudioReachable(ir: CutAVIR, roots: readonly string[]) {
  const pending = [...roots], reachable = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    const node = ir.nodes[id];
    if (!node) throw new Error(`CUT audio selection references missing node ${id}.`);
    reachable.add(id);
    if (node.op === "cut.audio.limiter" || node.op === "cut.audio.time_stretch" || node.op === "cut.audio.tempo_delay") continue;
    pending.push(...nodeReferences(node));
  }
  return reachable;
}

async function prepareReferenceNestedAudioSources(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  rootIds: readonly string[],
  accumulator: ReferenceAudioBuildAccumulator,
  verifiedResourcePath?: ReferenceVerifiedInputSession["pathFor"],
) {
  // Validate the complete composition DAG before the first recursive render;
  // otherwise a hostile Timeline cycle could recurse through temporary raw
  // stereo f32le
  // preparation rather than fail with a bounded source-located diagnostic.
  const precompGraph = validateReferencePrecompGraph(ir, composition);
  const reachable = selectedAudioReachable(ir, rootIds);
  const retainedRawF32Bytes = precompGraph.audioPreparation.retainedRawF32Bytes;
  if (retainedRawF32Bytes % 8n !== 0n) throw new Error("CUT_NESTED_BUDGET: nested raw stereo f32le preparation accounting is not frame-aligned.");
  const sources = new Map<string, ReferenceNestedAudioSource>();
  const renderedBySelection = new Map<string, string | undefined>();
  let directory: string | undefined;
  try {
    for (const nodeId of reachable) {
      const node = ir.nodes[nodeId];
      if (node?.op !== "cut.edit.nested_sequence") continue;
      const config = precompGraph.configs.get(node.id);
      if (!config || config.kind !== "av") throw new Error(`CUT_NESTED_REFERENCE: NestedSequence ${nodeId} has no closed runtime configuration.`);
      const source = ir.compositions.find((candidate) => candidate.id === config.sourceCompositionId);
      if (!source) throw new Error(`CUT_NESTED_REFERENCE: NestedSequence ${nodeId} source ${config.sourceCompositionId} is missing.`);
      const sourceSamples = exactSamples(source.duration, source.sampleRate, `NestedSequence source “${source.name}” duration`);
      const sourceStartSamples = exactSamples(config.sourceRange.start, source.sampleRate, `NestedSequence source “${source.name}” range start`);
      const sourceEndSamples = exactSamples(config.sourceRange.end, source.sampleRate, `NestedSequence source “${source.name}” range end`);
      const selectedSamples = exactSamples(config.duration, source.sampleRate, `NestedSequence source “${source.name}” selected duration`);
      if (sourceStartSamples < 0 || sourceEndSamples > sourceSamples || sourceEndSamples - sourceStartSamples !== selectedSamples) {
        throw new Error(`CUT_NESTED_TIMING: NestedSequence ${nodeId} has an inconsistent exact source sample range.`);
      }
      const selectionKey = referenceNestedAudioPreparationKey(config);
      let path = renderedBySelection.get(selectionKey);
      if (!renderedBySelection.has(selectionKey)) {
        const sourceRoots = referenceAudioCompositionRootIds(ir, source);
        if (sourceRoots.length) {
          directory ??= await mkdtemp(resolve(tmpdir(), "cut-nested-audio-"));
          path = resolve(directory, `${String(renderedBySelection.size).padStart(4, "0")}.f32le`);
          // CUT instantiates the complete source graph and evaluates causal
          // state from sample zero through the selected end. The final graph
          // boundary applies the selection, so the retained raw float stream
          // contains exactly selectedSamples without clipping processor state.
          await renderReferenceAudioSelectionWithAccumulator(ir, source, projectRoot, path, sourceRoots, accumulator, {
            outputFormat: "raw-stereo-f32le",
            sampleRange: { start: sourceStartSamples, end: sourceEndSamples },
            __verifiedResourcePath: verifiedResourcePath,
          });
        }
        renderedBySelection.set(selectionKey, path);
      }
      sources.set(nodeId, Object.freeze({
        selectedSamples,
        format: "raw-stereo-f32le",
        channels: 2,
        sampleRate: source.sampleRate,
        ...(path ? { path } : {}),
      }));
    }
    return {
      sources,
      cleanup: async () => { if (directory) await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Render an explicit set of existing audio graph roots without cloning or
 * rewriting IR nodes. Stem delivery uses this boundary to isolate one authored
 * top-level Bus while the ordinary master path supplies every rendered root.
 */
async function renderReferenceAudioSelectionInternal(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  output: string,
  rootIds: readonly string[],
  accumulator: ReferenceAudioBuildAccumulator,
  options: ReferenceAudioSelectionOptions = {},
  prepareTimeStretch = true,
  prepareLimiter = true,
  allowExtendedCompositionRange = false,
) {
  const timelineChildEvaluation = options.__timelineTimeStretchChildEvaluation;
  if (timelineChildEvaluation
    && (rootIds.length !== 1
      || rootIds[0] !== timelineChildEvaluation.childNodeId
      || prepareTimeStretch
      || !allowExtendedCompositionRange)) {
    const owner = ir.nodes[rootIds[0] ?? ""] ?? composition;
    selectionFail(
      owner,
      "CUT_AUDIO_SELECTION_STRUCTURE",
      "internal TimelineEdit TimeStretch child evaluation must own exactly its authenticated AudioClip root in one non-recursive extended-range preparation.",
    );
  }
  validateReachableReferenceAudioRegionCrossfadePlans(ir, composition, rootIds);
  const audioRegionPlans = authorizeReachableReferenceAudioRegions(ir, composition, rootIds, { validateSelectedRoots: false });
  // Direct selection, nested composition and TimeStretch paths do not
  // necessarily pass through validateReferenceSession. Authorize both sides
  // atomically before resolving media or allocating any output artifact.
  const linkedEditAuthorizations = validateReferenceLinkedEditTransactions(ir, composition);
  const paths = new Map<string, string>();
  for (const resource of Object.values(ir.resources)) {
    paths.set(resource.id, options.__verifiedResourcePath
      ? options.__verifiedResourcePath(resource.id)
      : (await resolveLockedProjectPath(projectRoot, resource.locator)).path);
  }
  const authoredTotalSamples = exactSamples(composition.duration, composition.sampleRate, `Timeline “${composition.name}” duration`);
  const requestedEnd = options.sampleRange?.end ?? authoredTotalSamples;
  const totalSamples = allowExtendedCompositionRange ? Math.max(authoredTotalSamples, requestedEnd) : authoredTotalSamples;
  let preparedSynth: Awaited<ReturnType<typeof prepareReferenceSynthSources>> = { sources: new Map(), cleanup: async () => undefined };
  let preparedStretch: ReferenceTimeStretchPreparation = { sources: new Map(), cleanup: async () => undefined };
  let preparedLimiter: ReferenceAudioLimiterPreparation = { sources: new Map(), cleanup: async () => undefined };
  let preparedTempoDelay: ReferenceAudioTempoDelayPreparation = { sources: new Map(), cleanup: async () => undefined };
  let preparedNested: Awaited<ReturnType<typeof prepareReferenceNestedAudioSources>> = { sources: new Map(), cleanup: async () => undefined };
  try {
    const backendOwner = rootIds.map((id) => ir.nodes[id]).find((node): node is IRNode => Boolean(node));
    const owner = backendOwner ?? composition;
    const outputFormat = referenceAudioSelectionOutputFormat(owner, options);
    preparedNested = await prepareReferenceNestedAudioSources(ir, composition, projectRoot, rootIds, accumulator, options.__verifiedResourcePath);
    if (prepareLimiter) preparedLimiter = await prepareReferenceAudioLimiterSources(
      ir,
      composition,
      rootIds,
      async (childIds, childOutput) => {
        const optimized = options.__disableStaticDspIsland
          ? false
          : await renderReferenceStaticDspIsland(
              ir,
              composition,
              childIds,
              childOutput,
              async (boundaryIds, boundaryOutput) => {
                await renderReferenceAudioSelectionInternal(ir, composition, projectRoot, boundaryOutput, boundaryIds, accumulator, {
                  outputFormat: "raw-stereo-f32le",
                  __verifiedResourcePath: options.__verifiedResourcePath,
                  __disableStaticDspIsland: options.__disableStaticDspIsland,
                }, true, true);
              },
            );
        if (!optimized) {
          await renderReferenceAudioSelectionInternal(ir, composition, projectRoot, childOutput, childIds, accumulator, {
            outputFormat: "raw-stereo-f32le",
            __verifiedResourcePath: options.__verifiedResourcePath,
            __disableStaticDspIsland: options.__disableStaticDspIsland,
          }, true, true);
        }
      },
    );
    for (const source of preparedLimiter.sources.values()) accumulator.limiterExecutions.push(source.evidence);
    if (prepareTimeStretch) preparedStretch = await prepareReferenceTimeStretchSources(
      ir,
      composition,
      rootIds,
      async (childId, childOutput, start, end, allowExtendedRange, timelineEvaluation) => {
        await renderReferenceAudioSelectionInternal(ir, composition, projectRoot, childOutput, [childId], accumulator, {
          outputFormat: "raw-stereo-f32le",
          sampleRange: { start, end },
          __verifiedResourcePath: options.__verifiedResourcePath,
          ...(timelineEvaluation
            ? { __timelineTimeStretchChildEvaluation: timelineEvaluation }
            : {}),
        }, false, true, allowExtendedRange);
      },
    );
    preparedTempoDelay = await prepareReferenceAudioTempoDelaySources(
      ir,
      composition,
      rootIds,
      async (childIds, childOutput) => {
        await renderReferenceAudioSelectionInternal(ir, composition, projectRoot, childOutput, childIds, accumulator, { outputFormat: "raw-stereo-f32le", __verifiedResourcePath: options.__verifiedResourcePath }, true, true);
      },
    );
    for (const source of preparedTempoDelay.sources.values()) accumulator.tempoDelayExecutions.push(source.evidence);
    preparedSynth = await prepareReferenceSynthSources(ir, composition, rootIds);
    const currentAudioRegionPlans = assertReachableReferenceAudioRegionPlansCurrent(
      ir,
      composition,
      rootIds,
      audioRegionPlans,
      { validateSelectedRoots: false },
    );
    const timelineTimeStretchChildEvaluations = options.__timelineTimeStretchChildEvaluation
      ? new Map([[options.__timelineTimeStretchChildEvaluation.childNodeId, options.__timelineTimeStretchChildEvaluation]])
      : new Map<string, ReferenceTimelineTimeStretchChildEvaluation>();
    const build: AudioBuild = { args: ["-y", "-v", "error"], filters: [], nextInput: 0, nextLabel: 0, paths, synthSources: preparedSynth.sources, timeStretchSources: preparedStretch.sources, limiterSources: preparedLimiter.sources, tempoDelaySources: preparedTempoDelay.sources, nestedSources: preparedNested.sources, sampleRate: composition.sampleRate, totalSamples, routing: planReferenceAudioRouting(ir, composition), linkedEditAudioByTrackId: linkedEditAuthorizations.audioByTrackId, audioRegionPlans: currentAudioRegionPlans, audioRegionTransitionByRegionId: new Map(), audioRegionTransitionBySourceId: new Map(), timelineAudioViewTransitionByViewId: new Map(), timelineAudioOriginOutputs: new Map(), timelineTimeStretchChildEvaluations }; const roots: string[] = [];
    for (const rootId of rootIds) roots.push(audioNode(build, ir, composition, rootId, new Set()));
    const range = options.sampleRange ?? { start: 0, end: totalSamples };
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > totalSamples
      || (!allowExtendedCompositionRange && range.end > authoredTotalSamples)) {
      selectionFail(owner, "CUT_AUDIO_SELECTION_STRUCTURE", "sampleRange is outside the exact composition sample interval.");
    }
    const mixed = mix(build, roots), outputLabel = label(build, "master");
    // CUT's executable selection boundary is canonical stereo float32 for
    // every serialization. This makes direct PCM24 delivery and an internal
    // raw-f32 handoff observe the same processor result before either encoder,
    // avoiding a hidden double-vs-float fork in nested execution semantics.
    build.filters.push(`[${mixed}]atrim=start_sample=${range.start}:end_sample=${range.end},asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo[${outputLabel}]`);
    // Every public PCM24 artifact must pass through CUT's one canonical
    // nearest-ties-to-even quantizer. FFmpeg therefore always serializes this
    // execution boundary as exact raw stereo f32le; direct auditions and stem
    // exports cannot drift by one PCM24 LSB through different encoders.
    const pcm24Staging = outputFormat === "pcm24-wave"
      ? await mkdtemp(resolve(tmpdir(), "cut-audio-selection-pcm24-"))
      : undefined;
    const floatOutput = pcm24Staging ? resolve(pcm24Staging, "selection.f32le") : output;
    try {
      const suffix = ["-map", `[${outputLabel}]`, "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", "-ar", String(composition.sampleRate), "-ac", "2", "-c:a", "pcm_f32le", "-f", "f32le", floatOutput];
      // Validate graph cost before allocating a script path. The graph is never
      // passed as one exec argument: doing so makes accepted CUT depend on the
      // host ARG_MAX / MAX_ARG_STRLEN boundary and leaks raw E2BIG errors.
      validateReferenceAudioBackendPlan(backendOwner, composition, build.filters, [...build.args, "-filter_complex_script", "graph.ffgraph", ...suffix]);
      await withReferenceAudioFilterScript(build.filters, async (graphPath) => {
        const args = [...build.args, "-filter_complex_script", graphPath, ...suffix];
        validateReferenceAudioBackendPlan(backendOwner, composition, build.filters, args);
        await runFfmpeg(args);
      });
      const expectedFrames = range.end - range.start;
      const expectedBytes = expectedFrames * 8;
      const observedBytes = (await stat(floatOutput)).size;
      if (!Number.isSafeInteger(expectedBytes) || observedBytes !== expectedBytes) {
        selectionFail(owner, "CUT_AUDIO_SELECTION_STRUCTURE", `raw stereo f32le output must contain exactly ${expectedBytes} bytes for ${expectedFrames} frames; observed ${observedBytes}.`);
      }
      if (outputFormat === "pcm24-wave") {
        const provenance = owner.provenance;
        await quantizeReferenceStereoF32LeFileToPcm24Wave(floatOutput, output, {
          expectedFrames,
          sampleRate: composition.sampleRate,
          thresholdDbfs: 0,
          source: {
            module: provenance.module,
            line: provenance.span.start.line,
            column: provenance.span.start.column,
            nodeId: owner.id,
          },
        });
      }
    } finally {
      if (pcm24Staging) await rm(pcm24Staging, { recursive: true, force: true });
    }
    return { roots: roots.length, filters: build.filters.length };
  } finally {
    await preparedNested.cleanup();
    await preparedSynth.cleanup();
    await preparedTempoDelay.cleanup();
    await preparedStretch.cleanup();
    await preparedLimiter.cleanup();
  }
}

async function renderReferenceAudioSelectionWithAccumulator(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  output: string,
  rootIds: readonly string[],
  accumulator: ReferenceAudioBuildAccumulator,
  options: ReferenceAudioSelectionOptions = {},
) {
  // Direct callers do not necessarily pass through validateReferenceSession.
  // Replay and correlate every canonical TimelineEdit before the selected
  // graph can resolve media or allocate any temp/output path. The cache path
  // performs the same check independently; direct PCM, stem, nested, limiter,
  // and TimeStretch selections must not form a weaker execution boundary.
  validateReferenceTimelineEditMaterializations(ir);
  // Close processed-region ownership before the generic graph budget so a
  // hostile cycle cannot bypass the AudioRegion contract or change diagnostic
  // precedence. All checks run before resolving/preparing sources or
  // allocating temp/output paths.
  validateReachableReferenceAudioRegionCrossfadePlans(ir, composition, rootIds);
  authorizeReachableReferenceAudioRegions(ir, composition, rootIds);
  const graph = assertCutGraphExecutionBudget(ir, rootIds);
  const reachable = new Set<string>(), pending = [...rootIds];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = ir.nodes[id];
    if (node) pending.push(...nodeReferences(node));
  }
  validateReferenceAudioAutomationBudget(ir, composition, reachable);
  validateReferenceTimeStretchPlans(ir, composition, [...reachable].filter((id) => ir.nodes[id]?.op === "cut.audio.time_stretch"));
  validateReferenceSynthPlans(ir, composition, [...reachable].filter((id) => ir.nodes[id]?.op === "cut.audio.synth"));
  validateReferenceAudioLimiterPlans(ir, composition, rootIds);
  validateReferenceTempoDelayPlans(ir, composition, rootIds);
  validateReferenceAudioCompositionResources(ir, composition, rootIds, graph.expansionVisits);
  return renderReferenceAudioSelectionInternal(ir, composition, projectRoot, output, rootIds, accumulator, options, true, true);
}

export async function renderReferenceAudioSelection(
  ir: CutAVIR,
  composition: IRComposition,
  projectRoot: string,
  output: string,
  rootIds: readonly string[],
  options: ReferenceAudioSelectionOptions = {},
) {
  const accumulator: ReferenceAudioBuildAccumulator = { limiterExecutions: [], tempoDelayExecutions: [] };
  const build = await renderReferenceAudioSelectionWithAccumulator(ir, composition, projectRoot, output, rootIds, accumulator, options);
  return Object.freeze({
    ...build,
    limiter: createReferenceAudioLimiterBuildEvidence(accumulator.limiterExecutions),
    tempoDelay: createReferenceAudioTempoDelayBuildEvidence(accumulator.tempoDelayExecutions),
  });
}

export async function renderReferenceAudio(ir: CutAVIR, composition: IRComposition, projectRoot: string, output: string) {
  return renderReferenceAudioSelection(ir, composition, projectRoot, output, referenceMasterAudioRootIds(ir, composition));
}

function loudnormStats(stderr: string) {
  const matches = [...stderr.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)]; if (!matches.length) throw new Error("FFmpeg loudnorm did not return measurement JSON.");
  return JSON.parse(matches.at(-1)![0]) as Record<string, string>;
}

export type ReferenceLoudnessMeasurement = {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  loudnessRangeLu: number | null;
  thresholdLufs: number | null;
};

export type ReferenceAudioLoudnessBoundaryErrorCode =
  | "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE"
  | "CUT_AUDIO_LOUDNESS_BOUNDARY_RESOURCE_LIMIT"
  | "CUT_AUDIO_LOUDNESS_BOUNDARY_MEASUREMENT";

export type ReferenceAudioLoudnessBoundaryErrorDetail = Readonly<{
  kind: "structure" | "resource" | "measurement";
  reason: string;
  expectedFrames?: number;
  sampleRate?: number;
}>;

export class ReferenceAudioLoudnessBoundaryError extends Error {
  readonly detail: ReferenceAudioLoudnessBoundaryErrorDetail;

  constructor(
    readonly code: ReferenceAudioLoudnessBoundaryErrorCode,
    message: string,
    detail: ReferenceAudioLoudnessBoundaryErrorDetail,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceAudioLoudnessBoundaryError";
    this.detail = Object.freeze({ ...detail });
  }
}

export type ReferenceAuthoredLoudnessBoundaryOptions = Readonly<{
  expectedFrames: number;
  sampleRate: number;
  targetLufs?: number;
  truePeakDbtp?: number;
  loudnessRangeLu?: number;
}>;

export const referenceAudioLoudnessBoundaryLimits = Object.freeze({
  maximumFrames: referenceAudioPeakLimits.maximumFrames,
  minimumSampleRate: referenceAudioPeakLimits.minimumPcm24SampleRate,
  maximumSampleRate: referenceAudioPeakLimits.maximumPcm24SampleRate,
  minimumTargetLufs: -70,
  maximumTargetLufs: -5,
  minimumTruePeakDbtp: -9,
  maximumTruePeakDbtp: 0,
  minimumLoudnessRangeLu: 1,
  maximumLoudnessRangeLu: 50,
  maximumInputPathBytes: 16_384,
});

export type ReferenceLoudnessReport = {
  target: { integratedLufs: number; truePeakDbtp: number; loudnessRangeLu: number };
  input: ReferenceLoudnessMeasurement;
  normalized: ReferenceLoudnessMeasurement;
  output?: ReferenceLoudnessMeasurement;
  normalization: "two-pass" | "skipped-silence" | "skipped-unmeasurable";
  reconciliation: {
    status: "not-needed" | "applied" | "limited" | "skipped-unmeasurable";
    limitingConstraint: "none" | "true-peak" | "gain-bound" | "unmeasurable";
    measuredAfterTwoPass: ReferenceLoudnessMeasurement;
    residualBeforeLu: number | null;
    requestedGainDb: number | null;
    appliedGainDb: number;
    peakHeadroomDb: number | null;
    residualAfterLu: number | null;
    toleranceLu: number;
    withinTargetTolerance: boolean | null;
    truePeakCompliant: boolean | null;
  };
};

const reconciliationToleranceLu = 0.2;
const maximumReconciliationGainDb = 24;
const reconciliationEpsilonDb = 0.001;

function finiteNumber(value: string | undefined) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }

function inputMeasurement(stats: Record<string, string>): ReferenceLoudnessMeasurement {
  return { integratedLufs: finiteNumber(stats.input_i), truePeakDbtp: finiteNumber(stats.input_tp), loudnessRangeLu: finiteNumber(stats.input_lra), thresholdLufs: finiteNumber(stats.input_thresh) };
}

type ReferenceAuthoredLoudnessBoundaryContract = Readonly<{
  expectedFrames: number;
  sampleRate: number;
  targetLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
}>;

function loudnessBoundaryFail(
  code: ReferenceAudioLoudnessBoundaryErrorCode,
  message: string,
  detail: ReferenceAudioLoudnessBoundaryErrorDetail,
  cause?: unknown,
): never {
  throw new ReferenceAudioLoudnessBoundaryError(
    code,
    message,
    detail,
    cause === undefined ? undefined : { cause },
  );
}

function loudnessBoundaryProcessCode(error: unknown) {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "PROCESS_FAILURE";
  } catch {
    return "PROCESS_FAILURE";
  }
}

function authoredLoudnessBoundaryContract(
  input: string,
  authoredOptions: ReferenceAuthoredLoudnessBoundaryOptions,
): ReferenceAuthoredLoudnessBoundaryContract {
  if (typeof input !== "string"
    || input.length === 0
    || input.includes("\0")
    || Buffer.byteLength(input, "utf8") > referenceAudioLoudnessBoundaryLimits.maximumInputPathBytes) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE",
      "authored-boundary loudness input must be one bounded non-empty local path.",
      { kind: "structure", reason: "invalid-input-path" },
    );
  }
  if (!authoredOptions || typeof authoredOptions !== "object") {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE",
      "authored-boundary loudness options must be an object.",
      { kind: "structure", reason: "invalid-options" },
    );
  }
  const expectedFrames = authoredOptions.expectedFrames;
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE",
      "expectedFrames must be a positive safe integer.",
      { kind: "structure", reason: "invalid-expected-frames" },
    );
  }
  if (expectedFrames > referenceAudioLoudnessBoundaryLimits.maximumFrames) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_RESOURCE_LIMIT",
      `expectedFrames exceeds the bounded ${referenceAudioLoudnessBoundaryLimits.maximumFrames}-frame loudness domain.`,
      { kind: "resource", reason: "frame-budget", expectedFrames },
    );
  }
  const sampleRate = authoredOptions.sampleRate;
  if (!Number.isSafeInteger(sampleRate)
    || sampleRate < referenceAudioLoudnessBoundaryLimits.minimumSampleRate
    || sampleRate > referenceAudioLoudnessBoundaryLimits.maximumSampleRate) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE",
      `sampleRate must be an integer from ${referenceAudioLoudnessBoundaryLimits.minimumSampleRate} through ${referenceAudioLoudnessBoundaryLimits.maximumSampleRate} Hz.`,
      { kind: "structure", reason: "invalid-sample-rate", expectedFrames },
    );
  }
  const targetLufs = authoredOptions.targetLufs ?? -14;
  if (typeof targetLufs !== "number" || !Number.isFinite(targetLufs)
    || targetLufs < referenceAudioLoudnessBoundaryLimits.minimumTargetLufs
    || targetLufs > referenceAudioLoudnessBoundaryLimits.maximumTargetLufs) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE",
      "targetLufs is outside FFmpeg loudnorm's bounded -70 through -5 LUFS domain.",
      { kind: "structure", reason: "invalid-target-lufs", expectedFrames, sampleRate },
    );
  }
  const truePeakDbtp = authoredOptions.truePeakDbtp ?? -1;
  if (typeof truePeakDbtp !== "number" || !Number.isFinite(truePeakDbtp)
    || truePeakDbtp < referenceAudioLoudnessBoundaryLimits.minimumTruePeakDbtp
    || truePeakDbtp > referenceAudioLoudnessBoundaryLimits.maximumTruePeakDbtp) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE",
      "truePeakDbtp is outside FFmpeg loudnorm's bounded -9 through 0 dBTP domain.",
      { kind: "structure", reason: "invalid-true-peak", expectedFrames, sampleRate },
    );
  }
  const loudnessRangeLu = authoredOptions.loudnessRangeLu ?? 9;
  if (typeof loudnessRangeLu !== "number" || !Number.isFinite(loudnessRangeLu)
    || loudnessRangeLu < referenceAudioLoudnessBoundaryLimits.minimumLoudnessRangeLu
    || loudnessRangeLu > referenceAudioLoudnessBoundaryLimits.maximumLoudnessRangeLu) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE",
      "loudnessRangeLu is outside FFmpeg loudnorm's bounded 1 through 50 LU domain.",
      { kind: "structure", reason: "invalid-loudness-range", expectedFrames, sampleRate },
    );
  }
  return { expectedFrames, sampleRate, targetLufs, truePeakDbtp, loudnessRangeLu };
}

const loudnormFinitePattern = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

function authoredBoundaryMeasurement(
  stats: Record<string, string>,
  contract: ReferenceAuthoredLoudnessBoundaryContract,
): ReferenceLoudnessMeasurement {
  const field = (name: "input_i" | "input_tp" | "input_lra" | "input_thresh") => {
    const value = stats[name];
    if (value === "-inf") return null;
    if (typeof value !== "string" || value.length > 64 || !loudnormFinitePattern.test(value)) {
      loudnessBoundaryFail(
        "CUT_AUDIO_LOUDNESS_BOUNDARY_MEASUREMENT",
        "FFmpeg loudnorm returned an invalid bounded measurement field.",
        { kind: "measurement", reason: `invalid-${name.replaceAll("_", "-")}`, expectedFrames: contract.expectedFrames, sampleRate: contract.sampleRate },
      );
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      loudnessBoundaryFail(
        "CUT_AUDIO_LOUDNESS_BOUNDARY_MEASUREMENT",
        "FFmpeg loudnorm returned a non-finite measurement outside the exact-silence sentinel.",
        { kind: "measurement", reason: `nonfinite-${name.replaceAll("_", "-")}`, expectedFrames: contract.expectedFrames, sampleRate: contract.sampleRate },
      );
    }
    return parsed;
  };
  return {
    integratedLufs: field("input_i"),
    truePeakDbtp: field("input_tp"),
    loudnessRangeLu: field("input_lra"),
    thresholdLufs: field("input_thresh"),
  };
}

export type ReferenceAudioNormalizationOptions = Readonly<{
  inputFormat?: "wave" | "raw-stereo-f32le";
  /** Fresh exact scan of the same pre-master bytes. Required for raw input. */
  inputPeak?: ReferenceAudioPeakScan;
}>;

function normalizationInputArgs(input: string, sampleRate: number, options: ReferenceAudioNormalizationOptions) {
  if (options.inputFormat !== "raw-stereo-f32le") return ["-i", input];
  if (!options.inputPeak
    || options.inputPeak.sampleFormat !== "f32le"
    || options.inputPeak.channels !== 2
    || options.inputPeak.observedFrames !== options.inputPeak.expectedFrames
    || options.inputPeak.observedBytes !== options.inputPeak.expectedBytes) {
    throw new Error("Reference raw-f32 normalization requires a fresh exact stereo peak scan for the same pre-master boundary.");
  }
  return ["-f", "f32le", "-ar", String(sampleRate), "-ac", "2", "-i", input];
}

async function measureLoudnorm(
  input: string,
  targetLufs: number,
  truePeak: number,
  loudnessRange: number,
  sampleRate = 48_000,
  options: ReferenceAudioNormalizationOptions = {},
) {
  const filter = `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${loudnessRange}:print_format=json`;
  return loudnormStats((await runFfmpegCapture(["-v", "info", ...normalizationInputArgs(input, sampleRate, options), "-map", "0:a:0", "-af", filter, "-f", "null", "-"])).stderr);
}

export async function measureReferenceAudio(input: string, targetLufs = -14, truePeak = -1, loudnessRange = 9) {
  return inputMeasurement(await measureLoudnorm(input, targetLufs, truePeak, loudnessRange));
}

/**
 * Measure one already-framing-validated audio stream over CUT's exact authored
 * sample boundary. This deliberately leaves `measureReferenceAudio` unchanged:
 * whole-file inspection remains useful outside delivery, while delivery must
 * exclude codec priming/padding before loudnorm sees a sample.
 *
 * `sampleRate` validates the caller's authored contract; the caller remains
 * responsible for proving that the decoded input stream has that rate before
 * invoking this function.
 */
export async function measureReferenceAudioAuthoredBoundary(
  input: string,
  options: ReferenceAuthoredLoudnessBoundaryOptions,
): Promise<ReferenceLoudnessMeasurement> {
  const contract = authoredLoudnessBoundaryContract(input, options);
  const filter = [
    `atrim=start_sample=0:end_sample=${contract.expectedFrames}`,
    "asetpts=N/SR/TB",
    `loudnorm=I=${contract.targetLufs}:TP=${contract.truePeakDbtp}:LRA=${contract.loudnessRangeLu}:print_format=json`,
  ].join(",");
  let stderr: string;
  try {
    ({ stderr } = await runFfmpegCapture([
      "-v", "info",
      "-i", input,
      "-map", "0:a:0",
      "-af", filter,
      "-f", "null",
      "-",
    ]));
  } catch (error) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_MEASUREMENT",
      `FFmpeg could not measure the exact authored loudness boundary (${loudnessBoundaryProcessCode(error)}).`,
      { kind: "measurement", reason: "process-failure", expectedFrames: contract.expectedFrames, sampleRate: contract.sampleRate },
      error,
    );
  }
  let stats: Record<string, string>;
  try {
    stats = loudnormStats(stderr);
  } catch (error) {
    loudnessBoundaryFail(
      "CUT_AUDIO_LOUDNESS_BOUNDARY_MEASUREMENT",
      "FFmpeg loudnorm did not return one bounded authored-boundary measurement.",
      { kind: "measurement", reason: "malformed-loudnorm-output", expectedFrames: contract.expectedFrames, sampleRate: contract.sampleRate },
      error,
    );
  }
  return authoredBoundaryMeasurement(stats, contract);
}

export async function normalizeReferenceAudio(
  input: string,
  output: string,
  targetLufs = -14,
  truePeak = -1,
  loudnessRange = 9,
  sampleRate = 48_000,
  options: ReferenceAudioNormalizationOptions = {},
) {
  const inputArgs = normalizationInputArgs(input, sampleRate, options);
  const measured = await measureLoudnorm(input, targetLufs, truePeak, loudnessRange, sampleRate, options);
  const target = { integratedLufs: targetLufs, truePeakDbtp: truePeak, loudnessRangeLu: loudnessRange };
  const finiteMeasurement = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"].every((key) => Number.isFinite(Number(measured[key])));
  if (!finiteMeasurement) {
    await runFfmpeg(["-y", "-v", "error", ...inputArgs, "-af", "anull", "-ar", String(sampleRate), "-ac", "2", "-c:a", "pcm_s24le", output]);
    const normalized = await measureReferenceAudio(output, targetLufs, truePeak, loudnessRange);
    const exactSilence = options.inputPeak?.silent === true;
    return {
      target,
      input: inputMeasurement(measured),
      normalized,
      normalization: exactSilence ? "skipped-silence" : "skipped-unmeasurable",
      reconciliation: {
        status: "skipped-unmeasurable",
        limitingConstraint: "unmeasurable",
        measuredAfterTwoPass: normalized,
        residualBeforeLu: null,
        requestedGainDb: null,
        appliedGainDb: 0,
        peakHeadroomDb: null,
        residualAfterLu: null,
        toleranceLu: reconciliationToleranceLu,
        withinTargetTolerance: null,
        truePeakCompliant: normalized.truePeakDbtp === null ? null : normalized.truePeakDbtp <= truePeak,
      },
    } satisfies ReferenceLoudnessReport;
  }
  const second = `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${loudnessRange}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary`;
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "cut-audio-reconcile-"));
  const twoPassOutput = resolve(temporaryDirectory, "two-pass.wav");
  try {
    await runFfmpeg(["-y", "-v", "error", ...inputArgs, "-af", second, "-ar", String(sampleRate), "-ac", "2", "-c:a", "pcm_s24le", twoPassOutput]);
    const measuredAfterTwoPass = await measureReferenceAudio(twoPassOutput, targetLufs, truePeak, loudnessRange);
    const integrated = measuredAfterTwoPass.integratedLufs, peak = measuredAfterTwoPass.truePeakDbtp;
    if (integrated === null || peak === null) {
      await copyFile(twoPassOutput, output);
      return {
        target,
        input: inputMeasurement(measured),
        normalized: measuredAfterTwoPass,
        normalization: "two-pass",
        reconciliation: {
          status: "skipped-unmeasurable",
          limitingConstraint: "unmeasurable",
          measuredAfterTwoPass,
          residualBeforeLu: null,
          requestedGainDb: null,
          appliedGainDb: 0,
          peakHeadroomDb: peak === null ? null : truePeak - peak,
          residualAfterLu: null,
          toleranceLu: reconciliationToleranceLu,
          withinTargetTolerance: null,
          truePeakCompliant: peak === null ? null : peak <= truePeak,
        },
      } satisfies ReferenceLoudnessReport;
    }

    const requestedGainDb = targetLufs - integrated;
    const peakHeadroomDb = truePeak - peak;
    if (peakHeadroomDb < -maximumReconciliationGainDb) {
      throw new Error(`Reference audio exceeds the authored ${truePeak} dBTP ceiling by ${(-peakHeadroomDb).toFixed(2)} dB, beyond the bounded ${maximumReconciliationGainDb} dB reconciliation stage.`);
    }
    const gainBounded = clamp(requestedGainDb, -maximumReconciliationGainDb, maximumReconciliationGainDb);
    const appliedGainDb = Number(Math.min(gainBounded, peakHeadroomDb).toFixed(6));
    const limitedByPeak = peakHeadroomDb < gainBounded - reconciliationEpsilonDb;
    const limitedByGain = Math.abs(gainBounded - requestedGainDb) > reconciliationEpsilonDb;
    if (Math.abs(appliedGainDb) <= reconciliationEpsilonDb) await copyFile(twoPassOutput, output);
    else await runFfmpeg(["-y", "-v", "error", "-i", twoPassOutput, "-af", `volume=${dbLinear(appliedGainDb)}`, "-ar", String(sampleRate), "-ac", "2", "-c:a", "pcm_s24le", output]);

    const normalized = await measureReferenceAudio(output, targetLufs, truePeak, loudnessRange);
    const residualAfterLu = normalized.integratedLufs === null ? null : targetLufs - normalized.integratedLufs;
    const truePeakCompliant = normalized.truePeakDbtp === null ? null : normalized.truePeakDbtp <= truePeak;
    if (truePeakCompliant === false) throw new Error(`Reference audio reconciliation measured ${normalized.truePeakDbtp} dBTP after applying ${appliedGainDb} dB, above the authored ${truePeak} dBTP ceiling.`);
    const limitingConstraint = limitedByPeak ? "true-peak" : limitedByGain ? "gain-bound" : "none";
    if (limitingConstraint === "none" && residualAfterLu !== null && Math.abs(residualAfterLu) > reconciliationToleranceLu) {
      throw new Error(`Reference audio reconciliation remained ${Math.abs(residualAfterLu).toFixed(2)} LU from the authored ${targetLufs} LUFS target despite available peak headroom.`);
    }
    return {
      target,
      input: inputMeasurement(measured),
      normalized,
      normalization: "two-pass",
      reconciliation: {
        status: limitingConstraint === "none" ? Math.abs(appliedGainDb) <= reconciliationEpsilonDb ? "not-needed" : "applied" : "limited",
        limitingConstraint,
        measuredAfterTwoPass,
        residualBeforeLu: requestedGainDb,
        requestedGainDb,
        appliedGainDb,
        peakHeadroomDb,
        residualAfterLu,
        toleranceLu: reconciliationToleranceLu,
        withinTargetTolerance: residualAfterLu === null ? null : Math.abs(residualAfterLu) <= reconciliationToleranceLu,
        truePeakCompliant,
      },
    } satisfies ReferenceLoudnessReport;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
