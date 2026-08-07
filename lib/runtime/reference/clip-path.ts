import { boundedDiagnosticString } from "../../core/stable";
import type { CutAVIR, IRNode, IRValue } from "../../language/ir";
import {
  compareRational,
  multiplyRational,
  rationalToNumber,
  subtractRational,
  zeroRational,
  type Rational,
} from "../../language/rational";
import type { RgbaAlphaMode, RgbaCompositeResult, RgbaSurface } from "./compositing";

export const referenceClipPathFillRules = ["nonzero", "evenodd"] as const;
export type ReferenceClipPathFillRule = typeof referenceClipPathFillRules[number];

/**
 * The reference clipper owns a fixed 4x4 pixel-center coverage grid. The
 * limits bound both authored geometry and the scan-conversion work before any
 * coverage plane is allocated.
 */
export const referenceClipPathLimits = Object.freeze({
  minimumPoints: 3,
  maximumPoints: 512,
  maximumAbsoluteCoordinatePx: 65_536,
  maximumCanvasPixels: 16_777_216,
  samplesPerAxis: 4,
  maximumWorkUnits: 268_435_456,
  maximumNodesPerComposition: 128,
  maximumCoverageBytesPerComposition: 67_108_864,
  maximumWorkUnitsPerComposition: 1_073_741_824,
});

export type ReferenceClipPathPoint = Readonly<{
  x: number;
  y: number;
  exactX: Rational;
  exactY: Rational;
}>;

export type ReferenceClipPathConfig = Readonly<{
  points: readonly ReferenceClipPathPoint[];
  fillRule: ReferenceClipPathFillRule;
  invert: boolean;
}>;

export type PreparedReferenceClipPath = Readonly<{
  config: ReferenceClipPathConfig;
  width: number;
  height: number;
  /** Integer covered sub-samples in the inclusive range 0...16. */
  coverage: Uint8Array;
}>;

export type ReferenceClipPathErrorCode =
  | "CUT_CLIP_PATH_GRAPH"
  | "CUT_CLIP_PATH_INPUT_TYPE"
  | "CUT_CLIP_PATH_FILL_RULE"
  | "CUT_CLIP_PATH_VALUE_RANGE"
  | "CUT_CLIP_PATH_DEGENERATE"
  | "CUT_CLIP_PATH_NOOP"
  | "CUT_CLIP_PATH_RESOURCE_LIMIT";

export class ReferenceClipPathError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceClipPathErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${node.op} at ${module}:${span.start.line}:${span.start.column} ${message}`);
    this.name = "ReferenceClipPathError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

const clipPathInputs = new Set(["points", "fillRule", "invert"]);

function fail(node: IRNode, code: ReferenceClipPathErrorCode, message: string): never {
  throw new ReferenceClipPathError(code, node, message);
}

function exactPixelCoordinate(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(node, "CUT_CLIP_PATH_INPUT_TYPE", `${label} must be a canonical pixel Length.`);
  }
  let coordinate: number;
  try {
    if (BigInt(value.magnitude.denominator) <= 0n) throw new Error("denominator");
    coordinate = rationalToNumber(value.magnitude);
  } catch {
    fail(node, "CUT_CLIP_PATH_INPUT_TYPE", `${label} must contain a canonical exact rational.`);
  }
  if (!Number.isFinite(coordinate!) || Math.abs(coordinate!) > referenceClipPathLimits.maximumAbsoluteCoordinatePx) {
    fail(
      node,
      "CUT_CLIP_PATH_VALUE_RANGE",
      `${label} must be finite and remain within ±${referenceClipPathLimits.maximumAbsoluteCoordinatePx}px.`,
    );
  }
  return { value: coordinate!, exact: value.magnitude };
}

function pointEquals(left: ReferenceClipPathPoint, right: ReferenceClipPathPoint) {
  return compareRational(left.exactX, right.exactX) === 0 && compareRational(left.exactY, right.exactY) === 0;
}

function cross(
  origin: ReferenceClipPathPoint,
  first: ReferenceClipPathPoint,
  second: ReferenceClipPathPoint,
) {
  return subtractRational(
    multiplyRational(subtractRational(first.exactX, origin.exactX), subtractRational(second.exactY, origin.exactY)),
    multiplyRational(subtractRational(first.exactY, origin.exactY), subtractRational(second.exactX, origin.exactX)),
  );
}

function points(node: IRNode, value: IRValue | undefined) {
  if (value?.kind !== "array") fail(node, "CUT_CLIP_PATH_INPUT_TYPE", "input “points” must be a List<Vec2>.");
  if (value.items.length < referenceClipPathLimits.minimumPoints || value.items.length > referenceClipPathLimits.maximumPoints) {
    fail(
      node,
      "CUT_CLIP_PATH_VALUE_RANGE",
      `input “points” must contain ${referenceClipPathLimits.minimumPoints} through ${referenceClipPathLimits.maximumPoints} coordinates.`,
    );
  }
  const result = value.items.map((item, index): ReferenceClipPathPoint => {
    if (item.kind !== "object" || Object.keys(item.entries).length !== 2 || !Object.hasOwn(item.entries, "x") || !Object.hasOwn(item.entries, "y")) {
      fail(node, "CUT_CLIP_PATH_INPUT_TYPE", `input “points[${index}]” must be a closed Vec2 with exactly x and y.`);
    }
    const x = exactPixelCoordinate(node, item.entries.x, `input “points[${index}].x”`);
    const y = exactPixelCoordinate(node, item.entries.y, `input “points[${index}].y”`);
    return Object.freeze({ x: x.value, y: y.value, exactX: x.exact, exactY: y.exact });
  });
  for (let index = 0; index < result.length; index += 1) {
    const next = (index + 1) % result.length;
    if (pointEquals(result[index], result[next])) {
      fail(
        node,
        "CUT_CLIP_PATH_DEGENERATE",
        index === result.length - 1
          ? "the final point must not repeat the first point; ClipPath closes the final edge implicitly."
          : `points[${index}] and points[${next}] are identical and form a zero-length edge.`,
      );
    }
  }
  const origin = result[0], first = result[1];
  if (!result.slice(2).some((candidate) => compareRational(cross(origin, first, candidate), zeroRational) !== 0)) {
    fail(node, "CUT_CLIP_PATH_DEGENERATE", "input “points” is collinear and has no two-dimensional interior.");
  }
  return Object.freeze(result);
}

function fillRule(node: IRNode, value: IRValue | undefined): ReferenceClipPathFillRule {
  if (value === undefined) return "nonzero";
  if (value.kind !== "string") fail(node, "CUT_CLIP_PATH_INPUT_TYPE", "input “fillRule” must be a String literal.");
  if (!referenceClipPathFillRules.includes(value.value as ReferenceClipPathFillRule)) {
    fail(node, "CUT_CLIP_PATH_FILL_RULE", `input “fillRule” must be one of: ${referenceClipPathFillRules.join(", ")}.`);
  }
  return value.value as ReferenceClipPathFillRule;
}

function invert(node: IRNode, value: IRValue | undefined) {
  if (value === undefined) return false;
  if (value.kind !== "boolean") fail(node, "CUT_CLIP_PATH_INPUT_TYPE", "input “invert” must be Boolean.");
  return value.value;
}

/** Close the typed/loaded-IR graph and every accepted ClipPath argument. */
export function referenceClipPathConfig(ir: CutAVIR, node: IRNode): ReferenceClipPathConfig | undefined {
  if (node.op !== "cut.visual.clip_path") return undefined;
  for (const input of Object.keys(node.inputs)) {
    if (!clipPathInputs.has(input)) {
      fail(node, "CUT_CLIP_PATH_INPUT_TYPE", `does not execute input ${boundedDiagnosticString(input)}; refusing a silent no-op.`);
    }
  }
  const properties = Object.keys(node.properties);
  if (properties.length) {
    fail(node, "CUT_CLIP_PATH_INPUT_TYPE", `does not execute property ${boundedDiagnosticString(properties[0])}; refusing a silent no-op.`);
  }
  if (node.domain !== "visual") fail(node, "CUT_CLIP_PATH_GRAPH", `must have visual domain; found ${node.domain}.`);
  if (node.children.length !== 1) fail(node, "CUT_CLIP_PATH_GRAPH", `requires exactly one visual child; found ${node.children.length}.`);
  const child = ir.nodes[node.children[0]];
  if (!child || child.domain !== "visual") fail(node, "CUT_CLIP_PATH_GRAPH", `child ${boundedDiagnosticString(node.children[0] ?? "missing")} must resolve to a visual node.`);
  return Object.freeze({
    points: points(node, node.inputs.points),
    fillRule: fillRule(node, node.inputs.fillRule),
    invert: invert(node, node.inputs.invert),
  });
}

export function referenceClipPathWorkUnits(width: number, height: number, points: number) {
  const samples = referenceClipPathLimits.samplesPerAxis;
  // One coverage-plane initialization, then per sub-row: width+1 difference
  // resets, width coverage-difference reads; `points` edge tests;
  // at most p(p-1)/2 insertion-sort comparisons plus the same number of
  // shifts; and at most three further linear crossing/span passes. This
  // deliberately over-bounds every geometry-dependent loop without relying
  // on an engine-specific Array#sort complexity promise.
  return width * height
    + height * samples * (2 * width + 1 + points * (points - 1) + 4 * points);
}

/** Validate dimensions and the deterministic scan-conversion budget before allocation. */
export function validateReferenceClipPathCanvas(node: IRNode, config: ReferenceClipPathConfig, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail(node, "CUT_CLIP_PATH_RESOURCE_LIMIT", "canvas dimensions must be positive safe integers.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceClipPathLimits.maximumCanvasPixels) {
    fail(node, "CUT_CLIP_PATH_RESOURCE_LIMIT", `canvas exceeds the ${referenceClipPathLimits.maximumCanvasPixels}-pixel ClipPath budget.`);
  }
  const work = referenceClipPathWorkUnits(width, height, config.points.length);
  if (!Number.isSafeInteger(work) || work > referenceClipPathLimits.maximumWorkUnits) {
    fail(node, "CUT_CLIP_PATH_RESOURCE_LIMIT", `scan conversion requires ${Number.isSafeInteger(work) ? work : "non-safe"} work units, exceeding the ${referenceClipPathLimits.maximumWorkUnits}-unit ClipPath budget.`);
  }
}

/** Fail an aggregate hostile graph before any per-node coverage allocation. */
export function validateReferenceClipPathCompositionBudget(
  entries: readonly Readonly<{ node: IRNode; config: ReferenceClipPathConfig }>[],
  width: number,
  height: number,
) {
  return validateReferenceClipPathContextBudget(entries.map((entry) => ({ ...entry, width, height })));
}

/**
 * Aggregate ClipPath work across mixed delivery and bounded-local contexts.
 * Each coverage plane is charged at the dimensions it will actually prepare;
 * callers cannot make a small LocalSpace consume a delivery-sized plane or
 * evade the one shared composition budget by moving clips into local tiles.
 */
export function validateReferenceClipPathContextBudget(
  entries: readonly Readonly<{ node: IRNode; config: ReferenceClipPathConfig; width: number; height: number }>[],
) {
  let coverageBytes = 0, workUnits = 0;
  for (const [index, entry] of entries.entries()) {
    validateReferenceClipPathCanvas(entry.node, entry.config, entry.width, entry.height);
    if (index + 1 > referenceClipPathLimits.maximumNodesPerComposition) {
      fail(entry.node, "CUT_CLIP_PATH_RESOURCE_LIMIT", `composition exceeds the ${referenceClipPathLimits.maximumNodesPerComposition}-ClipPath node limit.`);
    }
    coverageBytes += entry.width * entry.height;
    workUnits += referenceClipPathWorkUnits(entry.width, entry.height, entry.config.points.length);
    if (!Number.isSafeInteger(coverageBytes) || coverageBytes > referenceClipPathLimits.maximumCoverageBytesPerComposition) {
      fail(entry.node, "CUT_CLIP_PATH_RESOURCE_LIMIT", `composition coverage planes exceed the ${referenceClipPathLimits.maximumCoverageBytesPerComposition}-byte ClipPath budget.`);
    }
    if (!Number.isSafeInteger(workUnits) || workUnits > referenceClipPathLimits.maximumWorkUnitsPerComposition) {
      fail(entry.node, "CUT_CLIP_PATH_RESOURCE_LIMIT", `composition scan conversion exceeds the ${referenceClipPathLimits.maximumWorkUnitsPerComposition}-work-unit ClipPath budget.`);
    }
  }
  return Object.freeze({ nodes: entries.length, coverageBytes, workUnits });
}

type Crossing = { x: number; winding: -1 | 1; edge: number };

function filledIntervals(crossings: Crossing[], rule: ReferenceClipPathFillRule) {
  // Stable deterministic insertion ordering gives the work validator a real
  // p(p-1)/2 comparison/shift upper bound. Native Array#sort has no
  // specification-level complexity contract and therefore cannot back a CUT
  // resource guarantee.
  for (let index = 1; index < crossings.length; index += 1) {
    const current = crossings[index];
    let position = index;
    while (position > 0) {
      const previous = crossings[position - 1];
      if (previous.x < current.x || (previous.x === current.x && previous.edge <= current.edge)) break;
      crossings[position] = previous;
      position -= 1;
    }
    crossings[position] = current;
  }
  const intervals: Array<readonly [number, number]> = [];
  let index = 0, inside = false, winding = 0, start = 0;
  while (index < crossings.length) {
    const x = crossings[index].x;
    let count = 0, delta = 0;
    while (index < crossings.length && crossings[index].x === x) {
      count += 1;
      delta += crossings[index].winding;
      index += 1;
    }
    const before = rule === "evenodd" ? inside : winding !== 0;
    if (rule === "evenodd") inside = count % 2 === 0 ? inside : !inside;
    else winding += delta;
    const after = rule === "evenodd" ? inside : winding !== 0;
    if (!before && after) start = x;
    else if (before && !after && x > start) intervals.push([start, x]);
  }
  return intervals;
}

function addSampleInterval(
  coverage: Uint8Array,
  rowOffset: number,
  difference: Int32Array,
  width: number,
  startSample: number,
  endSample: number,
) {
  const samples = referenceClipPathLimits.samplesPerAxis;
  if (endSample <= startSample) return;
  const firstPixel = Math.floor(startSample / samples), lastPixel = Math.floor((endSample - 1) / samples);
  if (firstPixel === lastPixel) {
    coverage[rowOffset + firstPixel] += endSample - startSample;
    return;
  }
  coverage[rowOffset + firstPixel] += samples - startSample % samples;
  coverage[rowOffset + lastPixel] += (endSample - 1) % samples + 1;
  const fullStart = firstPixel + 1, fullEnd = lastPixel;
  if (fullStart < fullEnd) {
    difference[fullStart] += samples;
    difference[fullEnd] -= samples;
  }
}

/**
 * Rasterize the implicit closed polygon on a fixed 4x4 pixel-center grid.
 * Edges use the standard half-open Y rule; filled X spans are left-closed and
 * right-open. This makes shared vertices and boundary samples deterministic.
 */
export function prepareReferenceClipPath(
  node: IRNode,
  config: ReferenceClipPathConfig,
  width: number,
  height: number,
): PreparedReferenceClipPath {
  validateReferenceClipPathCanvas(node, config, width, height);
  const samples = referenceClipPathLimits.samplesPerAxis;
  const coverage = new Uint8Array(width * height), difference = new Int32Array(width + 1);
  const maximumSample = width * samples;
  const denominator = samples * samples, identityCoverage = config.invert ? 0 : denominator;
  let changesOutput = false;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let subY = 0; subY < samples; subY += 1) {
      difference.fill(0);
      const sampleY = y + (subY + 0.5) / samples;
      const crossings: Crossing[] = [];
      for (let edge = 0; edge < config.points.length; edge += 1) {
        const first = config.points[edge], second = config.points[(edge + 1) % config.points.length];
        const minimumY = Math.min(first.y, second.y), maximumY = Math.max(first.y, second.y);
        if (first.y === second.y || sampleY < minimumY || sampleY >= maximumY) continue;
        const t = (sampleY - first.y) / (second.y - first.y);
        crossings.push({ x: first.x + t * (second.x - first.x), winding: second.y > first.y ? 1 : -1, edge });
      }
      for (const [left, right] of filledIntervals(crossings, config.fillRule)) {
        const start = Math.max(0, Math.min(maximumSample, Math.ceil(left * samples - 0.5)));
        const end = Math.max(0, Math.min(maximumSample, Math.ceil(right * samples - 0.5)));
        addSampleInterval(coverage, rowOffset, difference, width, start, end);
      }
      let delta = 0;
      for (let x = 0; x < width; x += 1) {
        delta += difference[x];
        coverage[rowOffset + x] += delta;
        if (subY === samples - 1 && coverage[rowOffset + x] !== identityCoverage) changesOutput = true;
      }
    }
  }
  if (!changesOutput) {
    fail(node, "CUT_CLIP_PATH_NOOP", `polygon plus invert=${config.invert} leaves every canvas pixel at full child coverage; refusing an identity wrapper.`);
  }
  return Object.freeze({ config, width, height, coverage });
}

function validateTarget(target: RgbaSurface, plan: PreparedReferenceClipPath): RgbaAlphaMode {
  if (target.width !== plan.width || target.height !== plan.height) throw new Error("CUT ClipPath target dimensions must match its prepared coverage plane.");
  if (!(target.data instanceof Uint8Array) || target.data.byteLength !== target.width * target.height * 4) throw new Error("CUT ClipPath target must contain exact RGBA bytes.");
  const mode = target.alphaMode ?? "straight";
  if (mode !== "straight" && mode !== "premultiplied") throw new Error("CUT ClipPath target alphaMode must be “straight” or “premultiplied”.");
  return mode;
}

/**
 * Multiply child coverage by the prepared polygon. Premultiplied inputs are
 * safely unassociated; the retained output boundary is always straight alpha,
 * and fully transparent pixels have zero RGB to prevent hidden-color leaks.
 */
export function applyReferenceClipPath(target: RgbaSurface, plan: PreparedReferenceClipPath): RgbaCompositeResult {
  const mode = validateTarget(target, plan), output = new Uint8Array(target.data.byteLength);
  const denominator = referenceClipPathLimits.samplesPerAxis ** 2;
  for (let index = 0, offset = 0; index < plan.coverage.length; index += 1, offset += 4) {
    const selected = plan.config.invert ? denominator - plan.coverage[index] : plan.coverage[index];
    const amount = selected / denominator, targetAlpha = target.data[offset + 3] / 255;
    const outputAlpha = Math.round(targetAlpha * amount * 255);
    output[offset + 3] = outputAlpha;
    if (outputAlpha === 0 || targetAlpha === 0) continue;
    if (mode === "straight") {
      output[offset] = target.data[offset];
      output[offset + 1] = target.data[offset + 1];
      output[offset + 2] = target.data[offset + 2];
    } else {
      output[offset] = Math.round(Math.min(1, target.data[offset] / 255 / targetAlpha) * 255);
      output[offset + 1] = Math.round(Math.min(1, target.data[offset + 1] / 255 / targetAlpha) * 255);
      output[offset + 2] = Math.round(Math.min(1, target.data[offset + 2] / 255 / targetAlpha) * 255);
    }
  }
  return { data: output, width: target.width, height: target.height, alphaMode: "straight" };
}
