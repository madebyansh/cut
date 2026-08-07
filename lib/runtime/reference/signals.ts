import type { CutAVIR, IRNode, IRSignal, IRValue } from "../../language/ir";
import { compareRational, divideRational, rationalToNumber, subtractRational, type Rational } from "../../language/rational";
import { easeReferenceProgress } from "./easing";

type ProducerBackedTrack = Extract<IRSignal, { kind: "track" }> & { producer?: unknown };

export class ReferenceProducedSignalStateError extends Error {
  readonly code = "CUT_SIGNAL_PRODUCER_UNPREPARED" as const;
  readonly source: Readonly<{ module: string; line: number; column: number; signalId: string }>;

  constructor(signal: IRSignal) {
    const { module, span } = signal.provenance;
    super(`CUT_SIGNAL_PRODUCER_UNPREPARED: produced signal ${signal.id} at ${module}:${span.start.line}:${span.start.column} was sampled before deterministic runtime preparation.`);
    this.name = "ReferenceProducedSignalStateError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, signalId: signal.id });
  }
}

function producer(signal: IRSignal) {
  return (signal as ProducerBackedTrack).producer;
}

/**
 * One renderer-invocation-owned produced-signal namespace. Canonical CutAVIR
 * remains immutable, and neither close/reopen nor concurrent preview/final
 * renderers can observe another invocation's prepared events.
 */
export class ReferencePreparedSignalResolver {
  private readonly prepared = new Map<string, IRSignal>();
  private closed = false;

  constructor(private readonly ir: CutAVIR) {}

  install(signalId: string, prepared: IRSignal) {
    if (this.closed) throw new Error("CUT_SIGNAL_PREPARATION_CONTRACT: resolver is closed.");
    const authored = this.ir.signals[signalId];
    if (!authored || producer(authored) === undefined || prepared.id !== signalId || prepared.kind !== "track") {
      throw new Error(`CUT_SIGNAL_PREPARATION_CONTRACT: cannot install invalid prepared signal ${signalId}.`);
    }
    if (producer(prepared) !== undefined) {
      throw new Error(`CUT_SIGNAL_PREPARATION_CONTRACT: prepared signal ${signalId} must not retain an executable producer descriptor.`);
    }
    const existing = this.prepared.get(signalId);
    if (existing && existing.contentHash !== prepared.contentHash) {
      throw new Error(`CUT_SIGNAL_PREPARATION_CONTRACT: produced signal ${signalId} was prepared with conflicting runtime content.`);
    }
    this.prepared.set(signalId, Object.freeze(prepared));
  }

  resolve(ir: CutAVIR, signal: IRSignal) {
    if (this.closed || ir !== this.ir) return undefined;
    return this.prepared.get(signal.id);
  }

  close() {
    this.closed = true;
    this.prepared.clear();
  }
}

function executableSignal(ir: CutAVIR, signalId: string, resolver?: ReferencePreparedSignalResolver) {
  const signal = ir.signals[signalId];
  if (!signal) throw new Error(`Unknown CUT signal ${signalId}.`);
  if (producer(signal) === undefined) return signal;
  const prepared = resolver?.resolve(ir, signal);
  if (!prepared) throw new ReferenceProducedSignalStateError(signal);
  return prepared;
}

function mixColor(left: string, right: string, progress: number) {
  const parse = (value: string) => value.slice(1).match(/../g)?.map((part) => Number.parseInt(part, 16)) ?? [0, 0, 0];
  const a = parse(left), b = parse(right); return `#${a.slice(0, Math.min(a.length, b.length)).map((value, index) => Math.round(value + (b[index] - value) * progress).toString(16).padStart(2, "0")).join("")}`;
}

function lastIndexAtOrBefore(length: number, at: (index: number) => Rational, time: Rational) {
  let low = 0, high = length - 1, selected = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (compareRational(at(middle), time) <= 0) {
      selected = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return selected;
}

export function interpolateValue(left: IRValue, right: IRValue, progress: number): IRValue {
  if (left.kind === "quantity" && right.kind === "quantity" && left.dimension === right.dimension && left.unit === right.unit) {
    const start = rationalToNumber(left.magnitude), end = rationalToNumber(right.magnitude);
    const value = start + (end - start) * progress; const precision = 1_000_000;
    return { ...left, magnitude: { numerator: String(Math.round(value * precision)), denominator: String(precision) } };
  }
  if (left.kind === "color" && right.kind === "color") return { kind: "color", value: mixColor(left.value, right.value, progress) };
  return progress < 1 ? left : right;
}

export function evaluateSignal(ir: CutAVIR, signalId: string, time: Rational, resolver?: ReferencePreparedSignalResolver): IRValue {
  const signal = executableSignal(ir, signalId, resolver);
  if (signal.kind === "constant") return signal.value;
  if (signal.kind === "step") {
    const selected = lastIndexAtOrBefore(signal.points.length, (index) => signal.points[index]!.time, time);
    return signal.points[selected < 0 ? 0 : selected]?.value ?? { kind: "null" } as IRValue;
  }
  if (signal.kind === "track") {
    if (!signal.events.length) return signal.initial;
    const selectedIndex = lastIndexAtOrBefore(signal.events.length, (index) => {
      const event = signal.events[index]!;
      return event.kind === "set" ? event.time : event.start;
    }, time);
    if (selectedIndex < 0) return signal.initial;
    const selected = signal.events[selectedIndex]!;
    if (selected.kind === "set") return selected.value;
    if (compareRational(time, selected.start) <= 0) return selected.from;
    if (compareRational(time, selected.end) >= 0) return selected.to;
    const span = subtractRational(selected.end, selected.start), position = subtractRational(time, selected.start);
    const progress = Math.max(0, Math.min(1, rationalToNumber(divideRational(position, span))));
    return interpolateValue(selected.from, selected.to, easeReferenceProgress(progress, selected.curve));
  }
  if (!signal.keyframes.length) return { kind: "null" };
  if (compareRational(time, signal.keyframes[0].time) <= 0) return signal.keyframes[0].value;
  const leftIndex = lastIndexAtOrBefore(signal.keyframes.length, (index) => signal.keyframes[index]!.time, time);
  if (leftIndex >= signal.keyframes.length - 1) return signal.keyframes.at(-1)!.value;
  const left = signal.keyframes[leftIndex]!, right = signal.keyframes[leftIndex + 1]!;
  if (compareRational(time, left.time) === 0) return left.value;
  const span = subtractRational(right.time, left.time); const position = subtractRational(time, left.time);
  const progress = Math.max(0, Math.min(1, rationalToNumber(divideRational(position, span))));
  return interpolateValue(left.value, right.value, easeReferenceProgress(progress, right.curve));
}

export function propertyAt(ir: CutAVIR, node: IRNode, property: string, time: Rational, resolver?: ReferencePreparedSignalResolver) {
  const value = node.properties[property]; return value && "signal" in value ? evaluateSignal(ir, value.signal, time, resolver) : value;
}
