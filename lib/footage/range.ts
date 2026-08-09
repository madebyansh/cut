import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../language/rational";
import { footageFail } from "./diagnostics";

export type CutFootageRange = Readonly<{ semantics: "half-open"; start: Rational; end: Rational }>;
export type CutFootageHandles = Readonly<{ head: Rational; tail: Rational }>;

function nonNegative(value: Rational, path: string) {
  if (compareRational(value, zeroRational) < 0) footageFail("CUT_FOOTAGE_RANGE", path, "must be non-negative.");
  return value;
}

function positive(value: Rational, path: string) {
  if (compareRational(value, zeroRational) <= 0) footageFail("CUT_FOOTAGE_RANGE", path, "must be positive.");
  return value;
}

function validRange(value: CutFootageRange, path: string) {
  if (!value || value.semantics !== "half-open") footageFail("CUT_FOOTAGE_RANGE", path, "must be one half-open source range.");
  nonNegative(value.start, `${path}.start`);
  if (compareRational(value.end, value.start) <= 0) footageFail("CUT_FOOTAGE_RANGE", path, "must have an end strictly after its start.");
  return value;
}

function quotientFloor(value: Rational, grid: Rational) {
  const numerator = BigInt(value.numerator) * BigInt(grid.denominator);
  const denominator = BigInt(value.denominator) * BigInt(grid.numerator);
  let quotient = numerator / denominator;
  if (numerator < 0n && numerator % denominator !== 0n) quotient -= 1n;
  return quotient;
}

export function floorFootageTimeToGrid(value: Rational, grid: Rational): Rational {
  positive(grid, "$grid");
  return multiplyRational(rational(quotientFloor(value, grid)), grid);
}

export function ceilFootageTimeToGrid(value: Rational, grid: Rational): Rational {
  const floor = floorFootageTimeToGrid(value, grid);
  return compareRational(floor, value) === 0 ? floor : addRational(floor, grid);
}

export function planFootageChunkRanges(options: Readonly<{
  duration: Rational;
  chunkDuration: Rational;
  overlap: Rational;
  grid: Rational;
}>): readonly CutFootageRange[] {
  if (!options || typeof options !== "object" || Array.isArray(options)) footageFail("CUT_FOOTAGE_RANGE", "$", "must be one chunk-planning object.");
  const duration = positive(options.duration, "$.duration"), chunkDuration = positive(options.chunkDuration, "$.chunkDuration");
  const overlap = nonNegative(options.overlap, "$.overlap"), grid = positive(options.grid, "$.grid");
  if (compareRational(overlap, chunkDuration) >= 0) footageFail("CUT_FOOTAGE_RANGE", "$.overlap", "must be shorter than chunkDuration.");
  const hop = subtractRational(chunkDuration, overlap), ranges: CutFootageRange[] = [];
  let requestedStart = zeroRational;
  while (compareRational(requestedStart, duration) < 0) {
    const start = floorFootageTimeToGrid(requestedStart, grid);
    const requestedEnd = addRational(requestedStart, chunkDuration);
    const end = compareRational(requestedEnd, duration) >= 0 ? duration : ceilFootageTimeToGrid(requestedEnd, grid);
    if (compareRational(end, start) <= 0) footageFail("CUT_FOOTAGE_RANGE", "$.grid", "cannot produce one non-empty chunk range.");
    const last = ranges.at(-1);
    if (!last || compareRational(last.start, start) !== 0 || compareRational(last.end, end) !== 0) {
      ranges.push(Object.freeze({ semantics: "half-open", start, end }));
    }
    if (compareRational(end, duration) === 0) break;
    requestedStart = addRational(requestedStart, hop);
  }
  return Object.freeze(ranges);
}

export function clampFootageHandles(options: Readonly<{
  range: CutFootageRange;
  duration: Rational;
  requested: CutFootageHandles;
  grid: Rational;
}>): Readonly<{ requested: CutFootageHandles; effective: CutFootageHandles; range: CutFootageRange }> {
  if (!options || typeof options !== "object" || Array.isArray(options)) footageFail("CUT_FOOTAGE_RANGE", "$", "must be one handle-clamping object.");
  const range = validRange(options.range, "$.range"), duration = positive(options.duration, "$.duration"), grid = positive(options.grid, "$.grid");
  const searchableEnd = floorFootageTimeToGrid(duration, grid);
  if (compareRational(searchableEnd, zeroRational) <= 0
    || divideRational(range.start, grid).denominator !== "1"
    || divideRational(range.end, grid).denominator !== "1"
    || compareRational(range.end, searchableEnd) > 0) {
    footageFail("CUT_FOOTAGE_RANGE", "$.range", "must be grid-aligned inside the source's searchable frame extent.");
  }
  const requested = Object.freeze({ head: nonNegative(options.requested.head, "$.requested.head"), tail: nonNegative(options.requested.tail, "$.requested.tail") });
  const rawStart = subtractRational(range.start, requested.head), rawEnd = addRational(range.end, requested.tail);
  const start = compareRational(rawStart, zeroRational) <= 0 ? zeroRational : ceilFootageTimeToGrid(rawStart, grid);
  const end = compareRational(rawEnd, searchableEnd) >= 0 ? searchableEnd : floorFootageTimeToGrid(rawEnd, grid);
  if (compareRational(start, range.start) > 0 || compareRational(end, range.end) < 0 || compareRational(end, start) <= 0) {
    footageFail("CUT_FOOTAGE_RANGE", "$.range", "cannot retain the selected range while snapping requested handles inward to its frame grid.");
  }
  const finalRange = Object.freeze({ semantics: "half-open" as const, start, end });
  return Object.freeze({
    requested,
    effective: Object.freeze({ head: subtractRational(range.start, start), tail: subtractRational(end, range.end) }),
    range: finalRange,
  });
}

export const floorToFootageGrid = floorFootageTimeToGrid;
export const ceilToFootageGrid = ceilFootageTimeToGrid;
