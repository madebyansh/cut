import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  rationalToNumber,
  type Rational,
  zeroRational,
} from "../../language/rational";

export const referenceSynthWaveforms = ["sine", "triangle", "saw", "square"] as const;
export type ReferenceSynthWaveform = typeof referenceSynthWaveforms[number];

export const referenceSynthLimits = Object.freeze({
  eventsPerNode: 512,
  polyphony: 32,
  synthNodes: 64,
  voiceSamplesPerNode: 50_000_000,
  renderedSamplesPerNode: 64_000_000,
  totalVoiceSamples: 100_000_000,
  totalRenderedSamples: 100_000_000,
});

export type ReferenceSynthEvent = {
  sourceIndex: number;
  startSample: number;
  gateSamples: number;
  releaseSamples: number;
  endSample: number;
  frequency: number;
  velocity: number;
};

export type ReferenceSynthPlan = {
  nodeId: string;
  sampleRate: number;
  waveform: ReferenceSynthWaveform;
  attackSamples: number;
  decaySamples: number;
  sustain: number;
  releaseSamples: number;
  polyphony: number;
  placementSamples: number;
  renderedSamples: number;
  voiceSamples: number;
  events: ReferenceSynthEvent[];
};

export type ReferenceSynthSource = { path: string; placementSamples: number; renderedSamples: number };
export type ReferenceSynthPreparation = { sources: Map<string, ReferenceSynthSource>; cleanup: () => Promise<void> };

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(node: IRNode, message: string): never {
  throw new Error(`Synth at ${location(node)} ${message}`);
}

function exactSamples(node: IRNode, value: Rational, sampleRate: number, label: string) {
  const samples = multiplyRational(value, rational(sampleRate));
  if (samples.denominator !== "1") fail(node, `${label} does not land on the ${sampleRate} Hz sample boundary.`);
  const count = Number(samples.numerator);
  if (!Number.isSafeInteger(count)) fail(node, `${label} has an unsafe sample position.`);
  return count;
}

function quantity(node: IRNode, value: IRValue | undefined, dimension: string, label: string, fallback?: Rational) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value?.kind !== "quantity" || value.dimension !== dimension) fail(node, `${label} must be an exact ${dimension === "time" ? "Time" : dimension === "ratio" ? "Ratio" : dimension === "frequency" ? "Frequency" : "Number"} quantity.`);
  return value.magnitude;
}

function scalar(node: IRNode, value: IRValue | undefined, label: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  const magnitude = quantity(node, value, "scalar", label);
  const result = rationalToNumber(magnitude);
  if (!Number.isFinite(result)) fail(node, `${label} must be finite.`);
  return result;
}

function string(node: IRNode, value: IRValue | undefined, label: string, fallback: string) {
  if (value === undefined) return fallback;
  if (value.kind !== "string") fail(node, `${label} must be a String.`);
  return value.value;
}

function eventObject(node: IRNode, value: IRValue, index: number) {
  if (value.kind !== "object") fail(node, `events[${index}] must be a closed NoteEvent object.`);
  const keys = Object.keys(value.entries), allowed = new Set(["start", "duration", "pitch", "hz", "velocity"]);
  const unexpected = keys.filter((key) => !allowed.has(key));
  if (unexpected.length) fail(node, `events[${index}] has unsupported field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}.`);
  for (const required of ["start", "duration", "velocity"]) if (!Object.hasOwn(value.entries, required)) fail(node, `events[${index}] is missing required field “${required}”.`);
  const hasPitch = Object.hasOwn(value.entries, "pitch"), hasHz = Object.hasOwn(value.entries, "hz");
  if (hasPitch === hasHz) fail(node, `events[${index}] must contain exactly one of “pitch” or “hz”.`);
  if (keys.length !== 4) fail(node, `events[${index}] must be a closed NoteEvent with exactly four fields.`);
  return value.entries;
}

function eventFrequency(node: IRNode, entries: Record<string, IRValue>, index: number, sampleRate: number) {
  let frequency: number;
  if (entries.pitch !== undefined) {
    const pitch = scalar(node, entries.pitch, `events[${index}].pitch`);
    if (pitch < 0 || pitch > 127) fail(node, `events[${index}].pitch must be a MIDI note number between 0 and 127; fractional values are allowed.`);
    frequency = 440 * (2 ** ((pitch - 69) / 12));
  } else {
    const hz = quantity(node, entries.hz, "frequency", `events[${index}].hz`);
    frequency = rationalToNumber(hz);
  }
  if (!Number.isFinite(frequency) || frequency <= 0 || frequency >= sampleRate / 2) fail(node, `events[${index}] frequency must be greater than zero and below the ${sampleRate / 2} Hz Nyquist limit.`);
  return frequency;
}

function peakPolyphony(events: readonly ReferenceSynthEvent[]) {
  const boundaries = events.flatMap((event) => [
    { sample: event.startSample, delta: 1 },
    { sample: event.endSample, delta: -1 },
  ]).sort((left, right) => left.sample - right.sample || left.delta - right.delta);
  let current = 0, peak = 0;
  for (const boundary of boundaries) { current += boundary.delta; peak = Math.max(peak, current); }
  return peak;
}

/**
 * Reduce one authored Synth node to an exact, bounded sample-domain plan.
 * This is validation as well as compilation: loaded IR receives the same
 * closed-record, timing, Nyquist, polyphony, and resource checks as source IR.
 */
export function compileReferenceSynthPlan(ir: CutAVIR, composition: IRComposition, node: IRNode): ReferenceSynthPlan {
  if (node.op !== "cut.audio.synth") fail(node, `cannot be planned from kernel ${node.op}.`);
  if (node.domain !== "audio") fail(node, `must have audio domain, found ${node.domain}.`);
  const allowedInputs = new Set(["events", "waveform", "attack", "decay", "sustain", "release", "polyphony"]);
  const unexpectedInputs = Object.keys(node.inputs).filter((name) => !allowedInputs.has(name));
  if (unexpectedInputs.length) fail(node, `has unsupported input${unexpectedInputs.length === 1 ? "" : "s"}: ${unexpectedInputs.join(", ")}.`);
  if (node.children.length) fail(node, "is a source and cannot contain child nodes.");
  if (Object.keys(node.properties).length) fail(node, "has no settable or animatable properties.");
  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  if (node.sceneId && (!scene || !composition.sceneIds.includes(node.sceneId))) fail(node, "belongs to a missing or different composition scene.");
  const ownerDuration = scene?.duration ?? composition.duration;
  if (compareRational(node.interval.start, zeroRational) < 0 || compareRational(node.interval.duration, zeroRational) <= 0 || compareRational(addRational(node.interval.start, node.interval.duration), ownerDuration) > 0) {
    fail(node, "destination interval must be positive and remain inside its owning scene or timeline.");
  }
  exactSamples(node, node.interval.start, composition.sampleRate, "destination placement");
  exactSamples(node, node.interval.duration, composition.sampleRate, "destination duration");

  const eventsValue = node.inputs.events;
  if (eventsValue?.kind !== "array") fail(node, "events must be a List<NoteEvent>.");
  if (eventsValue.items.length < 1) fail(node, "events must contain at least one NoteEvent.");
  if (eventsValue.items.length > referenceSynthLimits.eventsPerNode) fail(node, `events exceeds the ${referenceSynthLimits.eventsPerNode}-event per-node limit.`);

  const requestedWaveform = string(node, node.inputs.waveform, "waveform", "sine");
  if (!referenceSynthWaveforms.includes(requestedWaveform as ReferenceSynthWaveform)) fail(node, `waveform must be one of: ${referenceSynthWaveforms.join(", ")}.`);
  const waveform = requestedWaveform as ReferenceSynthWaveform;
  const attack = quantity(node, node.inputs.attack, "time", "attack", zeroRational);
  const decay = quantity(node, node.inputs.decay, "time", "decay", zeroRational);
  const release = quantity(node, node.inputs.release, "time", "release", zeroRational);
  const sustainRational = quantity(node, node.inputs.sustain, "ratio", "sustain", rational(1));
  for (const [label, value] of [["attack", attack], ["decay", decay], ["release", release]] as const) if (compareRational(value, zeroRational) < 0) fail(node, `${label} cannot be negative.`);
  if (compareRational(sustainRational, zeroRational) < 0 || compareRational(sustainRational, rational(1)) > 0) fail(node, "sustain must stay between 0% and 100%.");
  const attackSamples = exactSamples(node, attack, composition.sampleRate, "attack");
  const decaySamples = exactSamples(node, decay, composition.sampleRate, "decay");
  const releaseSamples = exactSamples(node, release, composition.sampleRate, "release");
  const sustain = rationalToNumber(sustainRational);
  const polyphony = scalar(node, node.inputs.polyphony, "polyphony", 8);
  if (!Number.isSafeInteger(polyphony) || polyphony < 1 || polyphony > referenceSynthLimits.polyphony) fail(node, `polyphony must be an integer from 1 through ${referenceSynthLimits.polyphony}.`);

  const baseTime = addRational(scene?.start ?? zeroRational, node.interval.start);
  const baseSample = exactSamples(node, baseTime, composition.sampleRate, "absolute placement");
  let voiceSamples = 0;
  const absoluteEvents = eventsValue.items.map((value, index): ReferenceSynthEvent => {
    const entries = eventObject(node, value, index);
    const start = quantity(node, entries.start, "time", `events[${index}].start`);
    const duration = quantity(node, entries.duration, "time", `events[${index}].duration`);
    const velocityRational = quantity(node, entries.velocity, "ratio", `events[${index}].velocity`);
    if (compareRational(start, zeroRational) < 0) fail(node, `events[${index}].start cannot be negative.`);
    if (compareRational(duration, zeroRational) <= 0) fail(node, `events[${index}].duration must be positive.`);
    if (compareRational(velocityRational, zeroRational) <= 0 || compareRational(velocityRational, rational(1)) > 0) fail(node, `events[${index}].velocity must be greater than 0% and at most 100%.`);
    if (compareRational(addRational(attack, decay), duration) > 0) fail(node, `attack + decay cannot exceed events[${index}].duration.`);
    const noteEnd = addRational(addRational(start, duration), release);
    if (compareRational(noteEnd, node.interval.duration) > 0) fail(node, `events[${index}] including release exceeds the Synth destination interval.`);
    const relativeStart = exactSamples(node, start, composition.sampleRate, `events[${index}].start`);
    const gateSamples = exactSamples(node, duration, composition.sampleRate, `events[${index}].duration`);
    const totalSamples = gateSamples + releaseSamples;
    if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0) fail(node, `events[${index}] has an unsafe rendered duration.`);
    voiceSamples += totalSamples;
    if (!Number.isSafeInteger(voiceSamples) || voiceSamples > referenceSynthLimits.voiceSamplesPerNode) fail(node, `voice work exceeds the ${referenceSynthLimits.voiceSamplesPerNode}-sample per-node limit.`);
    return {
      sourceIndex: index,
      startSample: baseSample + relativeStart,
      gateSamples,
      releaseSamples,
      endSample: baseSample + relativeStart + totalSamples,
      frequency: eventFrequency(node, entries, index, composition.sampleRate),
      velocity: rationalToNumber(velocityRational),
    };
  }).sort((left, right) => left.startSample - right.startSample || left.sourceIndex - right.sourceIndex);

  const peak = peakPolyphony(absoluteEvents);
  if (peak > polyphony) fail(node, `score reaches ${peak} simultaneous voices including release tails, above polyphony: ${polyphony}; voice stealing is forbidden.`);
  const firstSample = absoluteEvents[0].startSample, endSample = Math.max(...absoluteEvents.map((event) => event.endSample));
  const renderedSamples = endSample - firstSample;
  if (!Number.isSafeInteger(renderedSamples) || renderedSamples < 1 || renderedSamples > referenceSynthLimits.renderedSamplesPerNode) fail(node, `score span exceeds the ${referenceSynthLimits.renderedSamplesPerNode}-sample per-node render limit.`);
  const events = absoluteEvents.map((event) => ({ ...event, startSample: event.startSample - firstSample, endSample: event.endSample - firstSample }));
  return { nodeId: node.id, sampleRate: composition.sampleRate, waveform, attackSamples, decaySamples, sustain, releaseSamples, polyphony, placementSamples: firstSample, renderedSamples, voiceSamples, events };
}

export function validateReferenceSynthPlans(ir: CutAVIR, composition: IRComposition, synthNodeIds: readonly string[]) {
  const ids = [...new Set(synthNodeIds)].sort();
  if (ids.length > referenceSynthLimits.synthNodes) throw new Error(`CUT Synth graph exceeds the ${referenceSynthLimits.synthNodes}-node limit.`);
  const plans = ids.map((id) => {
    const node = ir.nodes[id];
    if (!node || node.op !== "cut.audio.synth") throw new Error(`CUT Synth graph references invalid Synth node ${id}.`);
    return compileReferenceSynthPlan(ir, composition, node);
  });
  const voiceSamples = plans.reduce((sum, plan) => sum + plan.voiceSamples, 0);
  const renderedSamples = plans.reduce((sum, plan) => sum + plan.renderedSamples, 0);
  if (!Number.isSafeInteger(voiceSamples) || voiceSamples > referenceSynthLimits.totalVoiceSamples) throw new Error(`CUT Synth graph exceeds the ${referenceSynthLimits.totalVoiceSamples}-voice-sample total limit.`);
  if (!Number.isSafeInteger(renderedSamples) || renderedSamples > referenceSynthLimits.totalRenderedSamples) throw new Error(`CUT Synth graph exceeds the ${referenceSynthLimits.totalRenderedSamples}-rendered-sample temporary-storage limit.`);
  return plans;
}

function valueNodeReferences(value: IRValue, result: Set<string>) {
  if (value.kind === "node-ref") result.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => valueNodeReferences(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => valueNodeReferences(item, result));
  else if (value.kind === "range") { valueNodeReferences(value.start, result); valueNodeReferences(value.end, result); }
  else if (value.kind === "unary") valueNodeReferences(value.value, result);
  else if (value.kind === "binary") { valueNodeReferences(value.left, result); valueNodeReferences(value.right, result); }
  else if (value.kind === "member") valueNodeReferences(value.object, result);
  else if (value.kind === "index") { valueNodeReferences(value.object, result); valueNodeReferences(value.index, result); }
  else if (value.kind === "call") { value.positional.forEach((item) => valueNodeReferences(item, result)); Object.values(value.named).forEach((item) => valueNodeReferences(item, result)); }
}

export function reachableReferenceSynthNodeIds(ir: CutAVIR, rootIds: readonly string[]) {
  const pending = [...rootIds], visited = new Set<string>(), synths = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) throw new Error(`Audio graph references missing node ${id}.`);
    if (node.op === "cut.audio.synth") synths.add(id);
    // Prepared processors recursively render their own child graphs. The
    // parent invocation must not allocate duplicate Synth sources below that
    // exact-f32 boundary.
    if (node.op === "cut.audio.limiter" || node.op === "cut.audio.time_stretch" || node.op === "cut.audio.tempo_delay") continue;
    pending.push(...node.children);
    const references = new Set<string>();
    Object.values(node.inputs).forEach((value) => valueNodeReferences(value, references));
    pending.push(...references);
  }
  return [...synths].sort();
}

export function referenceSynthEnvelopeAtSample(plan: ReferenceSynthPlan, noteSample: number) {
  if (!Number.isSafeInteger(noteSample) || noteSample < 0) return 0;
  if (plan.attackSamples > 0 && noteSample < plan.attackSamples) return noteSample / plan.attackSamples;
  if (plan.decaySamples > 0 && noteSample < plan.attackSamples + plan.decaySamples) {
    return 1 - (1 - plan.sustain) * ((noteSample - plan.attackSamples) / plan.decaySamples);
  }
  return plan.sustain;
}

function eventEnvelope(plan: ReferenceSynthPlan, event: ReferenceSynthEvent, noteSample: number) {
  if (noteSample < event.gateSamples) return referenceSynthEnvelopeAtSample(plan, noteSample);
  if (event.releaseSamples <= 0 || noteSample >= event.gateSamples + event.releaseSamples) return 0;
  return plan.sustain * (1 - ((noteSample - event.gateSamples) / event.releaseSamples));
}

function polyBlep(phase: number, step: number) {
  if (phase < step) { const t = phase / step; return t + t - t * t - 1; }
  if (phase > 1 - step) { const t = (phase - 1) / step; return t * t + t + t + 1; }
  return 0;
}

function oscillator(waveform: ReferenceSynthWaveform, phase: number, step: number) {
  if (waveform === "sine") return Math.sin(2 * Math.PI * phase);
  if (waveform === "triangle") return 1 - 4 * Math.abs(phase - .5);
  if (waveform === "saw") return 2 * phase - 1 - polyBlep(phase, step);
  const shifted = (phase + .5) % 1;
  return (phase < .5 ? 1 : -1) + polyBlep(phase, step) - polyBlep(shifted, step);
}

async function writeAll(file: FileHandle, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten <= 0) throw new Error("CUT Synth could not complete a temporary wave write.");
    offset += bytesWritten;
  }
}

function floatWaveHeader(sampleRate: number, frames: number) {
  const channels = 2, bytesPerSample = 4, blockAlign = channels * bytesPerSample, dataBytes = frames * blockAlign;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > 0xfffffff0) throw new Error("CUT Synth temporary wave exceeds the classic RIFF/WAVE size limit.");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * blockAlign, 28); header.writeUInt16LE(blockAlign, 32); header.writeUInt16LE(32, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Render the validated score to deterministic stereo IEEE-float PCM. */
export async function renderReferenceSynthWave(plan: ReferenceSynthPlan, output: string) {
  await mkdir(dirname(output), { recursive: true });
  const file = await open(output, "wx");
  try {
    await writeAll(file, floatWaveHeader(plan.sampleRate, plan.renderedSamples));
    const blockFrames = 4_096;
    let nextEvent = 0;
    let active: Array<{ event: ReferenceSynthEvent; phase: number; step: number }> = [];
    for (let blockStart = 0; blockStart < plan.renderedSamples; blockStart += blockFrames) {
      const frames = Math.min(blockFrames, plan.renderedSamples - blockStart), buffer = Buffer.allocUnsafe(frames * 8);
      for (let offset = 0; offset < frames; offset += 1) {
        const frame = blockStart + offset;
        active = active.filter((voice) => frame < voice.event.endSample);
        while (nextEvent < plan.events.length && plan.events[nextEvent].startSample === frame) {
          const event = plan.events[nextEvent++]; active.push({ event, phase: 0, step: event.frequency / plan.sampleRate });
        }
        let sample = 0;
        for (const voice of active) {
          const noteSample = frame - voice.event.startSample;
          sample += oscillator(plan.waveform, voice.phase, voice.step) * eventEnvelope(plan, voice.event, noteSample) * voice.event.velocity;
          voice.phase += voice.step;
          if (voice.phase >= 1) voice.phase -= Math.floor(voice.phase);
        }
        buffer.writeFloatLE(sample, offset * 8); buffer.writeFloatLE(sample, offset * 8 + 4);
      }
      await writeAll(file, buffer);
    }
  } finally { await file.close(); }
}

export async function prepareReferenceSynthSources(ir: CutAVIR, composition: IRComposition, rootIds: readonly string[]): Promise<ReferenceSynthPreparation> {
  const synthIds = reachableReferenceSynthNodeIds(ir, rootIds);
  if (!synthIds.length) return { sources: new Map(), cleanup: async () => undefined };
  const plans = validateReferenceSynthPlans(ir, composition, synthIds);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-synth-")), sources = new Map<string, ReferenceSynthSource>();
  try {
    for (const [index, plan] of plans.entries()) {
      const path = resolve(directory, `synth-${String(index).padStart(3, "0")}.wav`);
      await renderReferenceSynthWave(plan, path);
      sources.set(plan.nodeId, { path, placementSamples: plan.placementSamples, renderedSamples: plan.renderedSamples });
    }
    return { sources, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
