import type { CutAVIR, IRSignal, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";

export type ReferenceEasing =
  | { kind: "linear" }
  | { kind: "in-cubic" }
  | { kind: "out-cubic" }
  | { kind: "in-out-cubic" }
  | { kind: "cubic-bezier"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "spring"; mass: number; stiffness: number; damping: number };

export const referenceEasingDiagnosticCode = "CUT_EASING_INVALID" as const;

/** Stable, source-located preflight error for an easing definition that the
 * reference backend cannot execute exactly. */
export class ReferenceEasingConfigError extends Error {
  readonly code = referenceEasingDiagnosticCode;

  constructor(readonly signalId: string, readonly source: string, detail: string) {
    super(`${referenceEasingDiagnosticCode}: CUT easing at ${source} ${detail}`);
    this.name = "ReferenceEasingConfigError";
  }
}

function scalar(value: IRValue | undefined, label: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value?.kind !== "quantity" || value.dimension !== "scalar") throw new Error(`${label} must be a scalar Number.`);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) throw new Error(`${label} must be finite.`);
  return result;
}

function argument(curve: Extract<IRValue, { kind: "call" }>, index: number, name: string, fallback?: number) {
  return scalar(curve.named[name] ?? curve.positional[index], `${curve.op} ${name}`, fallback);
}

export function parseReferenceEasing(curve: IRValue): ReferenceEasing {
  const name = curve.kind === "symbol" ? curve.name.split("#").at(-1)?.toLowerCase() ?? curve.name.toLowerCase()
    : curve.kind === "call" ? curve.op.toLowerCase() : "linear";
  if (name.includes("inout")) return { kind: "in-out-cubic" };
  if (name.includes("outcubic") || name.includes("out_cubic")) return { kind: "out-cubic" };
  if (name.includes("incubic") || name.includes("in_cubic")) return { kind: "in-cubic" };
  if (curve.kind === "call" && name.includes("cubic_bezier")) {
    const x1 = argument(curve, 0, "x1"), y1 = argument(curve, 1, "y1"), x2 = argument(curve, 2, "x2"), y2 = argument(curve, 3, "y2");
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) throw new Error("cubicBezier x1 and x2 must be between 0 and 1.");
    if (Math.abs(y1) > 10 || Math.abs(y2) > 10) throw new Error("cubicBezier y1 and y2 must be within -10 through 10.");
    return { kind: "cubic-bezier", x1, y1, x2, y2 };
  }
  if (curve.kind === "call" && name.includes("spring")) {
    const mass = argument(curve, 0, "mass", 1), stiffness = argument(curve, 1, "stiffness", 100), damping = argument(curve, 2, "damping", 10);
    if (mass < 0.01 || mass > 100) throw new Error("spring mass must be from 0.01 through 100.");
    if (stiffness < 0.01 || stiffness > 10_000) throw new Error("spring stiffness must be from 0.01 through 10000.");
    if (damping < 0 || damping > 1_000) throw new Error("spring damping must be from 0 through 1000.");
    return { kind: "spring", mass, stiffness, damping };
  }
  if (name.includes("linear")) return { kind: "linear" };
  throw new Error(`Unsupported CUT easing ${name}.`);
}

function cubicCoordinate(t: number, first: number, second: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

function cubicDerivative(t: number, first: number, second: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * first + 6 * inverse * t * (second - first) + 3 * t * t * (1 - second);
}

function cubicBezier(progress: number, easing: Extract<ReferenceEasing, { kind: "cubic-bezier" }>) {
  let parameter = progress;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const error = cubicCoordinate(parameter, easing.x1, easing.x2) - progress;
    const derivative = cubicDerivative(parameter, easing.x1, easing.x2);
    if (Math.abs(error) < 1e-9 || Math.abs(derivative) < 1e-9) break;
    const candidate = parameter - error / derivative;
    if (candidate < 0 || candidate > 1) break;
    parameter = candidate;
  }
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const x = cubicCoordinate(parameter, easing.x1, easing.x2);
    if (Math.abs(x - progress) < 1e-10) break;
    if (x < progress) low = parameter; else high = parameter;
    parameter = (low + high) / 2;
  }
  return cubicCoordinate(parameter, easing.y1, easing.y2);
}

function springResponse(time: number, mass: number, stiffness: number, damping: number) {
  const omega = Math.sqrt(stiffness / mass), ratio = damping / (2 * Math.sqrt(stiffness * mass));
  if (ratio < 1 - 1e-9) {
    const damped = omega * Math.sqrt(1 - ratio * ratio);
    return 1 - Math.exp(-ratio * omega * time) * (Math.cos(damped * time) + ratio * omega / damped * Math.sin(damped * time));
  }
  if (ratio <= 1 + 1e-9) return 1 - Math.exp(-omega * time) * (1 + omega * time);
  const root = Math.sqrt(ratio * ratio - 1), first = -omega * (ratio - root), second = -omega * (ratio + root);
  return 1 + (second * Math.exp(first * time) - first * Math.exp(second * time)) / (first - second);
}

function spring(progress: number, easing: Extract<ReferenceEasing, { kind: "spring" }>) {
  const finish = springResponse(1, easing.mass, easing.stiffness, easing.damping);
  if (!Number.isFinite(finish) || Math.abs(finish) < 1e-9) throw new Error("spring parameters do not produce a stable unit-time response.");
  return springResponse(progress, easing.mass, easing.stiffness, easing.damping) / finish;
}

export function easeReferenceProgress(progress: number, curve: IRValue) {
  const value = Math.max(0, Math.min(1, progress)), easing = parseReferenceEasing(curve);
  if (easing.kind === "linear") return value;
  if (easing.kind === "out-cubic") return 1 - (1 - value) ** 3;
  if (easing.kind === "in-cubic") return value ** 3;
  if (easing.kind === "in-out-cubic") return value < .5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
  if (easing.kind === "cubic-bezier") return cubicBezier(value, easing);
  return spring(value, easing);
}

function signalCurves(signal: IRSignal) {
  if (signal.kind === "track") return signal.events.flatMap((event) => event.kind === "animate" ? [event.curve] : []);
  if (signal.kind === "keyframes") return signal.keyframes.map((keyframe) => keyframe.curve);
  return [];
}

export function validateReferenceEasings(ir: CutAVIR, signalIds?: ReadonlySet<string>) {
  for (const signal of Object.values(ir.signals)) {
    if (signalIds !== undefined && !signalIds.has(signal.id)) continue;
    for (const curve of signalCurves(signal)) {
      try { parseReferenceEasing(curve); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const source = `${signal.provenance.module}:${signal.provenance.span.start.line}:${signal.provenance.span.start.column}`;
        throw new ReferenceEasingConfigError(signal.id, source, message);
      }
    }
  }
}
