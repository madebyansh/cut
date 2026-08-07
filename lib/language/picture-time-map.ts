import type { IRPictureTimeMap, IRValue } from "./ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";

/** Language-level limits. Backend decode-buffer limits are separate. */
export const cutPictureTimeMapLimits = Object.freeze({
  minimumRate: rational(1, 64),
  maximumRate: rational(64),
  minimumRampPoints: 2,
  maximumRampPoints: 32,
});

export class PictureTimeMapInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PictureTimeMapInputError";
  }
}

export type AuthoredPictureTimeMap = IRPictureTimeMap;
export type PictureFrameSelection = "floor" | "nearest" | "frame-blend";

function inputFailure(message: string): never { throw new PictureTimeMapInputError(message); }

function boundedRational(value: Rational, label: string) {
  if (value.numerator.length > 257 || value.denominator.length > 256) inputFailure(`${label} exceeds the 256-digit exact-rational limit.`);
  return value;
}

export function canonicalPictureTimeMapRational(value: unknown, label: string, fail: (message: string) => never) {
  if (!value || typeof value !== "object") fail(`${label} must carry a canonical exact rational.`);
  const candidate = value as { numerator?: unknown; denominator?: unknown };
  if (
    typeof candidate.numerator !== "string"
    || typeof candidate.denominator !== "string"
    || !/^-?(?:0|[1-9]\d*)$/.test(candidate.numerator)
    || !/^[1-9]\d*$/.test(candidate.denominator)
    || candidate.numerator.length > 256
    || candidate.denominator.length > 256
  ) fail(`${label} must carry a canonical exact rational.`);
  try {
    const exact = rational(candidate.numerator, candidate.denominator);
    if (exact.numerator !== candidate.numerator || exact.denominator !== candidate.denominator) throw new Error("non-canonical");
    return exact;
  } catch {
    fail(`${label} must carry a canonical exact rational.`);
  }
}

function exactQuantity(value: IRValue | undefined, dimension: "time" | "scalar", label: string, fail: (message: string) => never) {
  const unit = dimension === "time" ? "s" : "scalar";
  if (value?.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) fail(`${label} must be an exact ${dimension === "time" ? "Time" : "Number"} value.`);
  return canonicalPictureTimeMapRational(value.magnitude, label, fail);
}

function exactSpeedRampPoints(value: IRValue | undefined, destinationDuration: Rational, fail: (message: string) => never) {
  if (value?.kind !== "array") fail("PictureClip speedRamp must be a finite List<PictureSpeedPoint>.");
  if (value.items.length < cutPictureTimeMapLimits.minimumRampPoints || value.items.length > cutPictureTimeMapLimits.maximumRampPoints) {
    fail(`PictureClip speedRamp must contain ${cutPictureTimeMapLimits.minimumRampPoints} through ${cutPictureTimeMapLimits.maximumRampPoints} points.`);
  }
  const points: Array<{ at: Rational; rate: Rational }> = [];
  value.items.forEach((item, index) => {
    if (item.kind !== "object") fail(`PictureClip speedRamp point ${index + 1} must be authored with speedPoint(at:, rate:).`);
    const keys = Object.keys(item.entries);
    if (keys.length !== 2 || !keys.includes("at") || !keys.includes("rate")) fail(`PictureClip speedRamp point ${index + 1} must contain exactly at and rate.`);
    const at = exactQuantity(item.entries.at, "time", `PictureClip speedRamp point ${index + 1} at`, fail);
    const rate = exactQuantity(item.entries.rate, "scalar", `PictureClip speedRamp point ${index + 1} rate`, fail);
    if (compareRational(rate, cutPictureTimeMapLimits.minimumRate) < 0 || compareRational(rate, cutPictureTimeMapLimits.maximumRate) > 0) {
      fail(`PictureClip speedRamp point ${index + 1} rate must be between 1/64 and 64 inclusive; received ${rate.numerator}/${rate.denominator}.`);
    }
    if (points.length && compareRational(at, points.at(-1)!.at) <= 0) fail("PictureClip speedRamp point times must be strictly increasing.");
    points.push({ at, rate });
  });
  if (compareRational(points[0].at, zeroRational) !== 0) fail("PictureClip speedRamp must begin with a point at 0s.");
  if (compareRational(points.at(-1)!.at, destinationDuration) !== 0) {
    fail(`PictureClip speedRamp must end exactly at destination duration ${destinationDuration.numerator}/${destinationDuration.denominator}s.`);
  }
  return points;
}

function frameSelection(inputs: Record<string, IRValue>, fail: (message: string) => never): PictureFrameSelection {
  const authored = inputs.frameSelection;
  if (authored === undefined) return "floor";
  if (authored.kind !== "string") fail("PictureClip frameSelection must be a String.");
  if (authored.value === "floor" || authored.value === "nearest" || authored.value === "frame-blend") return authored.value;
  if (authored.value === "optical-flow") {
    fail(`PictureClip frameSelection: "${authored.value}" is reserved but is not executable in the reference runtime; CUT will not substitute discrete-frame sampling.`);
  }
  fail('PictureClip frameSelection must be one of: "floor", "nearest", "frame-blend", or "optical-flow".');
}

function speedRampSegmentOffset(start: { at: Rational; rate: Rational }, end: { at: Rational; rate: Rational }, time: Rational) {
  const segmentDuration = subtractRational(end.at, start.at), local = subtractRational(time, start.at);
  const rateDelta = subtractRational(end.rate, start.rate);
  const linear = multiplyRational(local, start.rate);
  const quadratic = divideRational(multiplyRational(rateDelta, multiplyRational(local, local)), multiplyRational(rational(2), segmentDuration));
  return boundedRational(addRational(linear, quadratic), "PictureClip integrated speedRamp source offset");
}

export function pictureSpeedRampSourceOffset(map: Extract<IRPictureTimeMap, { kind: "speed-ramp" }>, destinationTime: Rational) {
  const last = map.points.at(-1)!;
  if (compareRational(destinationTime, zeroRational) < 0 || compareRational(destinationTime, last.at) > 0) {
    inputFailure("PictureClip speedRamp destination time lies outside its authored interval.");
  }
  let offset = zeroRational;
  for (let index = 0; index < map.points.length - 1; index += 1) {
    const start = map.points[index], end = map.points[index + 1];
    if (compareRational(destinationTime, end.at) <= 0) return addRational(offset, speedRampSegmentOffset(start, end, destinationTime));
    offset = addRational(offset, speedRampSegmentOffset(start, end, end.at));
  }
  return offset;
}

function speedRampRateAt(map: Extract<IRPictureTimeMap, { kind: "speed-ramp" }>, destinationTime: Rational) {
  for (let index = 0; index < map.points.length - 1; index += 1) {
    const start = map.points[index], end = map.points[index + 1];
    if (compareRational(destinationTime, end.at) <= 0) {
      const progress = divideRational(subtractRational(destinationTime, start.at), subtractRational(end.at, start.at));
      return addRational(start.rate, multiplyRational(subtractRational(end.rate, start.rate), progress));
    }
  }
  return map.points.at(-1)!.rate;
}

export function slicePictureSpeedRamp(map: Extract<IRPictureTimeMap, { kind: "speed-ramp" }>, start: Rational, duration: Rational): IRPictureTimeMap {
  const end = addRational(start, duration), mapEnd = map.points.at(-1)!.at;
  if (compareRational(start, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0 || compareRational(end, mapEnd) > 0) {
    inputFailure("PictureClip speedRamp slice must be a positive interval inside the existing destination map.");
  }
  const points = [
    { at: zeroRational, rate: speedRampRateAt(map, start) },
    ...map.points
      .filter((point) => compareRational(point.at, start) > 0 && compareRational(point.at, end) < 0)
      .map((point) => ({ at: subtractRational(point.at, start), rate: point.rate })),
    { at: duration, rate: speedRampRateAt(map, end) },
  ];
  if (points.every((point) => compareRational(point.rate, points[0].rate) === 0)) {
    return {
      kind: "constant",
      direction: "forward",
      rate: points[0].rate,
      ...(map.frameSelection !== "floor" ? { frameSelection: map.frameSelection } : {}),
    };
  }
  return { kind: "speed-ramp", interpolation: "linear-rate", frameSelection: map.frameSelection, points };
}

function speedRampValue(points: readonly { at: Rational; rate: Rational }[]): IRValue {
  return {
    kind: "array",
    items: points.map((point) => ({
      kind: "object",
      entries: {
        at: { kind: "quantity", dimension: "time", magnitude: point.at, unit: "s" },
        rate: { kind: "quantity", dimension: "scalar", magnitude: point.rate, unit: "scalar" },
      },
    })),
  };
}

export function pictureSpeedRampInput(map: Extract<IRPictureTimeMap, { kind: "speed-ramp" }>) {
  return speedRampValue(map.points);
}

export function pictureTimeMapSourceRange(inputs: Record<string, IRValue>, fail: (message: string) => never) {
  const value = inputs.range;
  if (value?.kind !== "range" || !value.exclusive) fail("PictureClip range must be an exact half-open Range<Time>; use start ..< end.");
  const start = exactQuantity(value.start, "time", "PictureClip source-range start", fail);
  const end = exactQuantity(value.end, "time", "PictureClip source-range end", fail);
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) fail("PictureClip source range must be positive and cannot begin before zero.");
  return { start, end, duration: subtractRational(end, start) };
}

function playback(inputs: Record<string, IRValue>, fail: (message: string) => never) {
  const authored = inputs.playback;
  if (authored === undefined) return "normal" as const;
  if (authored.kind !== "string" || !( ["normal", "reverse", "freeze"] as const).includes(authored.value as "normal" | "reverse" | "freeze")) {
    fail('PictureClip playback must be one of: "normal", "reverse", "freeze".');
  }
  return authored.value as "normal" | "reverse" | "freeze";
}

/** Resolve public inputs into a backend-independent typed editorial map. */
export function authoredPictureTimeMap(inputs: Record<string, IRValue>, destinationDuration: Rational): AuthoredPictureTimeMap {
  const source = pictureTimeMapSourceRange(inputs, inputFailure);
  const selectedFrameSelection = frameSelection(inputs, inputFailure);
  if (inputs.speedRamp !== undefined) {
    if (inputs.playback !== undefined || inputs.rate !== undefined || inputs.freezeAt !== undefined) {
      inputFailure("PictureClip speedRamp cannot be combined with playback, rate, or freezeAt.");
    }
    if (inputs.link !== undefined) inputFailure("PictureClip speedRamp cannot carry link because CUT does not yet retime coupled audio.");
    const points = exactSpeedRampPoints(inputs.speedRamp, destinationDuration, inputFailure);
    const ramp: Extract<IRPictureTimeMap, { kind: "speed-ramp" }> = {
      kind: "speed-ramp",
      interpolation: "linear-rate",
      frameSelection: selectedFrameSelection,
      points,
    };
    const requiredSourceDuration = pictureSpeedRampSourceOffset(ramp, destinationDuration);
    if (compareRational(source.duration, requiredSourceDuration) !== 0) {
      inputFailure(`PictureClip source duration must equal the exact integrated speedRamp duration (${requiredSourceDuration.numerator}/${requiredSourceDuration.denominator}s required, ${source.duration.numerator}/${source.duration.denominator}s authored).`);
    }
    if (points.every((point) => compareRational(point.rate, points[0].rate) === 0)) {
      return {
        kind: "constant",
        direction: "forward",
        rate: points[0].rate,
        ...(selectedFrameSelection !== "floor" ? { frameSelection: selectedFrameSelection } : {}),
      };
    }
    return ramp;
  }
  const selectedPlayback = playback(inputs, inputFailure);
  if (selectedPlayback === "freeze") {
    if (inputs.rate !== undefined) inputFailure('PictureClip playback: "freeze" cannot accept rate because rate would be a no-op.');
    if (inputs.freezeAt === undefined) inputFailure('PictureClip playback: "freeze" requires freezeAt: Time.');
    const at = exactQuantity(inputs.freezeAt, "time", "PictureClip freezeAt", inputFailure);
    if (compareRational(at, source.start) < 0 || compareRational(at, source.end) >= 0) inputFailure("PictureClip freezeAt must select a frame inside its half-open source range.");
    if (selectedFrameSelection === "nearest") inputFailure('PictureClip playback: "freeze" accepts only frameSelection: "floor" or "frame-blend"; freezeAt already names one exact locked source frame.');
    return {
      kind: "freeze",
      at,
      ...(selectedFrameSelection === "frame-blend" ? { frameSelection: "frame-blend" as const } : {}),
    };
  }
  if (inputs.freezeAt !== undefined) inputFailure(`PictureClip playback: "${selectedPlayback}" cannot accept freezeAt because freezeAt would be a no-op.`);
  const rate = inputs.rate === undefined ? rational(1) : exactQuantity(inputs.rate, "scalar", "PictureClip rate", inputFailure);
  if (compareRational(rate, cutPictureTimeMapLimits.minimumRate) < 0 || compareRational(rate, cutPictureTimeMapLimits.maximumRate) > 0) {
    inputFailure(`PictureClip rate must be between 1/64 and 64 inclusive; received ${rate.numerator}/${rate.denominator}.`);
  }
  const requiredSourceDuration = boundedRational(multiplyRational(destinationDuration, rate), "PictureClip destination duration × rate");
  if (compareRational(source.duration, requiredSourceDuration) !== 0) {
    inputFailure(`PictureClip source duration must equal destination duration × rate exactly (${requiredSourceDuration.numerator}/${requiredSourceDuration.denominator}s required, ${source.duration.numerator}/${source.duration.denominator}s authored).`);
  }
  return {
    kind: "constant",
    direction: selectedPlayback === "reverse" ? "reverse" : "forward",
    rate,
    ...(selectedFrameSelection !== "floor" ? { frameSelection: selectedFrameSelection } : {}),
  };
}

/** Canonicalize equivalent source spellings before executable identity. */
export function canonicalPictureTimeMapInputs(inputs: Record<string, IRValue>, map: AuthoredPictureTimeMap) {
  const withCanonicalFrameSelection = (value: Record<string, IRValue>) => {
    if (map.frameSelection === "nearest" || map.frameSelection === "frame-blend") {
      return { ...value, frameSelection: { kind: "string", value: map.frameSelection } as const };
    }
    const normalized = { ...value };
    delete normalized.frameSelection;
    return normalized;
  };
  if (isDefaultPictureTimeMap(map)) {
    const normalized: Record<string, IRValue> = withCanonicalFrameSelection(inputs);
    delete normalized.playback;
    delete normalized.rate;
    delete normalized.freezeAt;
    delete normalized.speedRamp;
    return normalized;
  }
  if (map.kind === "freeze") {
    const normalized: Record<string, IRValue> = withCanonicalFrameSelection({ ...inputs, playback: { kind: "string", value: "freeze" } });
    delete normalized.rate;
    delete normalized.speedRamp;
    return normalized;
  }
  if (map.kind === "speed-ramp") {
    const normalized: Record<string, IRValue> = withCanonicalFrameSelection({ ...inputs, speedRamp: speedRampValue(map.points) });
    delete normalized.playback;
    delete normalized.rate;
    delete normalized.freezeAt;
    return normalized;
  }
  const normalized: Record<string, IRValue> = withCanonicalFrameSelection({
    ...inputs,
    playback: { kind: "string", value: map.direction === "reverse" ? "reverse" : "normal" },
    rate: { kind: "quantity", dimension: "scalar", magnitude: map.rate, unit: "scalar" },
  });
  delete normalized.freezeAt;
  delete normalized.speedRamp;
  return normalized;
}

export function isDefaultPictureTimeMap(map: AuthoredPictureTimeMap) {
  return map.kind === "constant"
    && map.direction === "forward"
    && map.frameSelection === undefined
    && compareRational(map.rate, rational(1)) === 0;
}
