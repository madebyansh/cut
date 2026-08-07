import { createHash } from "node:crypto";
import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import {
  planReferenceProjectiveWarp,
  referenceProjectiveWarpLimits,
  ReferenceProjectiveWarpError,
  type ReferenceProjectiveQuad,
  type ReferenceProjectiveRasterBounds,
  type ReferenceProjectiveWarpPlan,
} from "./projective-warp-kernel";

/** Isolated sidecar/sampling contract. This is not a tracker or an occlusion solver. */
export const referencePlanarTrackAlgorithmVersion = "cut-reference-planar-track-v1" as const;
export const referencePlanarTrackPhaseUnits = 65_536;

export const referencePlanarTrackLimits = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxCompositionBytes: 32 * 1024 * 1024,
  maxNodesPerComposition: 128,
  maxDistinctResourcesPerComposition: 128,
  maxSamplesPerComposition: 1_000_000,
  maxOpacitySignalValuesPerComposition: 100_000,
  maxProjectNodes: 1_024,
  maxProjectResources: 512,
  maxProjectBytes: 128 * 1024 * 1024,
  maxExecutionsPerCompositionFrame: 4_096,
  maxDestinationPixelsPerCompositionFrame: 67_108_864,
  maxSamples: 16_384,
  maxJsonDepth: 20,
  maxJsonNodes: 2_000_000,
  maxRationalDigits: 64,
  maxRuntimeRationalDigits: 512,
  maxCanvasDimension: 65_536,
  maxAbsoluteCoordinate: referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate,
});

export type ReferencePlanarTrackInterpolation = "linear" | "hold";
export type ReferencePlanarTrackPolicy = "fail" | "hold" | "hide";
export type ReferencePlanarTrackStatus = "visible" | "occluded" | "out-of-frame";

export type ReferencePlanarTrackPoint = Readonly<{ x: Rational; y: Rational }>;
export type ReferencePlanarTrackQuad = Readonly<{
  topLeft: ReferencePlanarTrackPoint;
  topRight: ReferencePlanarTrackPoint;
  bottomRight: ReferencePlanarTrackPoint;
  bottomLeft: ReferencePlanarTrackPoint;
}>;
export type ReferencePlanarTrackQuadQ16 = readonly [
  topLeft: Readonly<{ x: string; y: string }>,
  topRight: Readonly<{ x: string; y: string }>,
  bottomRight: Readonly<{ x: string; y: string }>,
  bottomLeft: Readonly<{ x: string; y: string }>,
];

export type ReferencePlanarTrackConfig = Readonly<{
  nodeId: string;
  sourceId: string;
  interpolation: ReferencePlanarTrackInterpolation;
  minConfidence: Rational;
  lowConfidence: ReferencePlanarTrackPolicy;
  occluded: ReferencePlanarTrackPolicy;
  outOfFrame: ReferencePlanarTrackPolicy;
  opacity: Rational;
  configIdentity: string;
}>;

export type ReferencePlanarTrackSample = Readonly<{
  at: Rational;
  confidence: Rational;
  status: ReferencePlanarTrackStatus;
  corners: ReferencePlanarTrackQuad;
  quadQ16: ReferencePlanarTrackQuadQ16;
  sidecarSampleIdentity: string;
}>;

export type ReferencePlanarTrackLockedResource = Readonly<{
  id: string;
  kind: "data";
  locator: string;
  state: "locked";
  sha256: string;
  bytes: number;
  metadataIdentity: string;
  identity: string;
}>;

export type PreparedReferencePlanarTrack = Readonly<{
  algorithmVersion: typeof referencePlanarTrackAlgorithmVersion;
  format: "cut-planar-track";
  version: 1;
  coordinateSpace: "composition-pixel-edges";
  nodeId: string;
  sourceId: string;
  width: number;
  height: number;
  duration: Rational;
  configIdentity: string;
  sourceResource: ReferencePlanarTrackLockedResource;
  samples: readonly ReferencePlanarTrackSample[];
  preparationIdentity: string;
}>;

export type ReferencePlanarTrackResolution = Readonly<{
  classification:
    | "exact-visible"
    | "linear-visible"
    | "interpolation-held"
    | "held-before-unusable-right"
    | "policy-held"
    | "policy-hidden";
  status: ReferencePlanarTrackStatus;
  leftSampleIndex: number;
  rightSampleIndex: number;
  selectedSampleIndex?: number;
  blockedRightSampleIndex?: number;
  progress: Rational;
  leftConfidence: Rational;
  rightConfidence: Rational;
  policy?: Readonly<{
    reason: "low-confidence" | "occluded" | "out-of-frame";
    action: ReferencePlanarTrackPolicy;
    observationSampleIndex: number;
  }>;
}>;

type ReferencePlanarTrackResultBase = Readonly<{
  algorithmVersion: typeof referencePlanarTrackAlgorithmVersion;
  nodeId: string;
  exactNodeLocalTime: Rational;
  preparationIdentity: string;
  opacity: Rational;
  resolution: ReferencePlanarTrackResolution;
  sampleIdentity: string;
}>;

export type ReferencePlanarTrackSkip = Readonly<{
  classification: "tracking-policy-hidden" | "owner-opacity";
  reason: "low-confidence" | "occluded" | "out-of-frame" | "opacity-zero";
}>;

export type ReferencePlanarTrackAtResult =
  | (ReferencePlanarTrackResultBase & Readonly<{
    hidden: true;
    skip: ReferencePlanarTrackSkip;
    work: Readonly<{
      projectivePlans: 0;
      destinationPixels: 0;
      destinationRgbaBytes: 0;
    }>;
  }>)
  | (ReferencePlanarTrackResultBase & Readonly<{
    hidden: false;
    quad: ReferencePlanarTrackQuad;
    quadQ16: ReferencePlanarTrackQuadQ16;
    destinationBounds: ReferenceProjectiveRasterBounds;
    projectivePlan: ReferenceProjectiveWarpPlan;
  }>);

export type ReferencePlanarTrackErrorCode =
  | "CUT_PLANAR_TRACK_INPUT_TYPE"
  | "CUT_PLANAR_TRACK_CONFIG"
  | "CUT_PLANAR_TRACK_RESOURCE"
  | "CUT_PLANAR_TRACK_RESOURCE_CONFLICT"
  | "CUT_PLANAR_TRACK_JSON"
  | "CUT_PLANAR_TRACK_SCHEMA"
  | "CUT_PLANAR_TRACK_LIMIT"
  | "CUT_PLANAR_TRACK_TIME"
  | "CUT_PLANAR_TRACK_RANGE"
  | "CUT_PLANAR_TRACK_DIMENSIONS"
  | "CUT_PLANAR_TRACK_GEOMETRY"
  | "CUT_PLANAR_TRACK_SAMPLE"
  | "CUT_PLANAR_TRACK_HOLD_EMPTY";

export class ReferencePlanarTrackError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferencePlanarTrackErrorCode, readonly nodeId: string, node: IRNode, message: string) {
    const span = node.provenance.span;
    super(`${code}: PlanarTrack at ${node.provenance.module}:${span.start.line}:${span.start.column} ${message}`);
    this.name = "ReferencePlanarTrackError";
    this.source = { module: node.provenance.module, line: span.start.line, column: span.start.column, nodeId };
  }
}

type JsonObject = Record<string, unknown>;

function fail(node: IRNode, code: ReferencePlanarTrackErrorCode, message: string): never {
  throw new ReferencePlanarTrackError(code, node.id, node, message);
}

function isObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(node: IRNode, value: unknown, path: string) {
  if (!isObject(value)) fail(node, "CUT_PLANAR_TRACK_SCHEMA", `${path} must be an object.`);
  return value;
}

function closedObject(
  node: IRNode,
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const result = object(node, value, path), allowed = new Set([...required, ...optional]);
  for (const field of required) {
    if (!Object.hasOwn(result, field)) fail(node, "CUT_PLANAR_TRACK_SCHEMA", `${path} is missing required field “${field}”.`);
  }
  for (const field of Object.keys(result)) {
    if (!allowed.has(field)) fail(node, "CUT_PLANAR_TRACK_SCHEMA", `${path}[${boundedJsonKey(field)}] is not part of cut-planar-track v1.`);
  }
  return result;
}

function boundedJsonKey(value: string) {
  const maximumPrefixCodeUnits = 96;
  if (value.length <= maximumPrefixCodeUnits) return JSON.stringify(value);
  const prefix = value.slice(0, maximumPrefixCodeUnits);
  const bytes = Buffer.byteLength(value, "utf8");
  const sha256 = createHash("sha256").update(value).digest("hex");
  return `${JSON.stringify(prefix)}…<${bytes} UTF-8 bytes; sha256=${sha256}>`;
}

function collectResourceReferences(value: IRValue, resources: Set<string>): void {
  if (value.kind === "resource-ref") {
    resources.add(value.id);
    return;
  }
  if (value.kind === "array") {
    for (const item of value.items) collectResourceReferences(item, resources);
    return;
  }
  if (value.kind === "object") {
    for (const item of Object.values(value.entries)) collectResourceReferences(item, resources);
    return;
  }
  if (value.kind === "range") {
    collectResourceReferences(value.start, resources);
    collectResourceReferences(value.end, resources);
    return;
  }
  if (value.kind === "unary") {
    collectResourceReferences(value.value, resources);
    return;
  }
  if (value.kind === "binary") {
    collectResourceReferences(value.left, resources);
    collectResourceReferences(value.right, resources);
    return;
  }
  if (value.kind === "member") {
    collectResourceReferences(value.object, resources);
    return;
  }
  if (value.kind === "index") {
    collectResourceReferences(value.object, resources);
    collectResourceReferences(value.index, resources);
    return;
  }
  if (value.kind === "call") {
    for (const item of value.positional) collectResourceReferences(item, resources);
    for (const item of Object.values(value.named)) collectResourceReferences(item, resources);
  }
}

function firstNonPlanarConsumerByResource(ir: CutAVIR) {
  const result = new Map<string, IRNode>();
  for (const candidate of Object.values(ir.nodes)) {
    if (candidate.op === "cut.visual.planar_track") continue;
    const resources = new Set<string>();
    for (const value of Object.values(candidate.inputs)) collectResourceReferences(value, resources);
    for (const resourceId of resources) {
      if (!result.has(resourceId)) result.set(resourceId, candidate);
    }
  }
  return result;
}

function resourceId(node: IRNode, ir: CutAVIR) {
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") {
    fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", "input “source” must be a DataAsset resource reference.");
  }
  const resolved = ir.resources[source.id];
  if (!resolved || resolved.kind !== "data") {
    fail(node, "CUT_PLANAR_TRACK_RESOURCE", "input “source” must reference a DataAsset.");
  }
  return source.id;
}

function stringChoice<T extends string>(node: IRNode, name: string, allowed: readonly T[], fallback?: T): T {
  const value = node.inputs[name];
  if (value === undefined) {
    if (fallback === undefined) fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", `requires String input “${name}”.`);
    return fallback;
  }
  if (value.kind !== "string" || !allowed.includes(value.value as T)) {
    fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", `input “${name}” must be one of: ${allowed.join(", ")}.`);
  }
  return value.value as T;
}

function ratioInput(node: IRNode, name: string, fallback?: Rational) {
  const value = node.inputs[name];
  if (value === undefined && fallback) return Object.freeze({ ...fallback });
  if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", `input “${name}” must be a canonical Ratio.`);
  }
  const magnitude = value.magnitude;
  if (typeof magnitude?.numerator !== "string" || typeof magnitude.denominator !== "string"
    || magnitude.numerator === "-0"
    || !/^-?(?:0|[1-9][0-9]*)$/u.test(magnitude.numerator)
    || !/^[1-9][0-9]*$/u.test(magnitude.denominator)
    || magnitude.numerator.replace("-", "").length > referencePlanarTrackLimits.maxRationalDigits
    || magnitude.denominator.length > referencePlanarTrackLimits.maxRationalDigits) {
    fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", `input “${name}” must contain a bounded canonical exact Ratio.`);
  }
  const canonical = rational(magnitude.numerator, magnitude.denominator);
  if (canonical.numerator !== magnitude.numerator || canonical.denominator !== magnitude.denominator) {
    fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", `input “${name}” must be reduced to canonical lowest terms.`);
  }
  if (compareRational(magnitude, zeroRational) < 0 || compareRational(magnitude, rational(1)) > 0) {
    fail(node, "CUT_PLANAR_TRACK_RANGE", `input “${name}” must be between 0% and 100%.`);
  }
  return Object.freeze({ ...magnitude });
}

function planarConfigIdentity(value: Omit<ReferencePlanarTrackConfig, "configIdentity">) {
  return hash({
    algorithmVersion: referencePlanarTrackAlgorithmVersion,
    ...value,
  });
}

/** Reduce a typed future `cut.visual.planar_track` node to a closed runtime configuration. */
export function referencePlanarTrackConfig(ir: CutAVIR, node: IRNode): ReferencePlanarTrackConfig | undefined {
  if (node.op !== "cut.visual.planar_track") return undefined;
  if (node.domain !== "visual") fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", `must have visual domain, found ${node.domain}.`);
  const allowedInputs = new Set([
    "source", "minConfidence", "lowConfidence", "occluded", "outOfFrame", "interpolation", "opacity",
  ]);
  for (const name of Object.keys(node.inputs)) {
    if (!allowedInputs.has(name)) fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", `input “${name}” is not part of PlanarTrack v1.`);
  }
  const value = {
    nodeId: node.id,
    sourceId: resourceId(node, ir),
    interpolation: stringChoice(node, "interpolation", ["linear", "hold"] as const, "linear"),
    minConfidence: ratioInput(node, "minConfidence"),
    lowConfidence: stringChoice(node, "lowConfidence", ["fail", "hold", "hide"] as const),
    occluded: stringChoice(node, "occluded", ["fail", "hold", "hide"] as const),
    outOfFrame: stringChoice(node, "outOfFrame", ["fail", "hold", "hide"] as const),
    opacity: ratioInput(node, "opacity", rational(1)),
  };
  return Object.freeze({ ...value, configIdentity: planarConfigIdentity(value) });
}

/** One schema-owned DataAsset cannot be reinterpreted by an unrelated runtime kernel. */
export function validateReferencePlanarTrackResourceOwnership(ir: CutAVIR) {
  const consumers = Object.values(ir.nodes).flatMap((node) => {
    const config = referencePlanarTrackConfig(ir, node);
    return config ? [{ node, config }] : [];
  });
  if (consumers.length > referencePlanarTrackLimits.maxProjectNodes) {
    const excess = consumers.sort((left, right) => left.node.id.localeCompare(right.node.id))[referencePlanarTrackLimits.maxProjectNodes]!;
    fail(excess.node, "CUT_PLANAR_TRACK_LIMIT", `project references more than ${referencePlanarTrackLimits.maxProjectNodes} PlanarTrack nodes.`);
  }
  const projectResources = new Set(consumers.map(({ config }) => config.sourceId));
  if (projectResources.size > referencePlanarTrackLimits.maxProjectResources) {
    const excess = consumers.sort((left, right) => left.config.sourceId.localeCompare(right.config.sourceId))[referencePlanarTrackLimits.maxProjectResources]!;
    fail(excess.node, "CUT_PLANAR_TRACK_LIMIT", `project references more than ${referencePlanarTrackLimits.maxProjectResources} distinct planar-track resources.`);
  }
  let knownProjectBytes = 0;
  for (const sourceId of [...projectResources].sort()) {
    const bytes = ir.resources[sourceId]?.metadata?.bytes;
    if (bytes === undefined) continue;
    const consumer = consumers.find(({ config }) => config.sourceId === sourceId)!;
    if (!Number.isSafeInteger(bytes) || Number(bytes) < 1 || Number(bytes) > referencePlanarTrackLimits.maxBytes) {
      fail(consumer.node, "CUT_PLANAR_TRACK_LIMIT", `planar-track resource ${sourceId} has an invalid or excessive locked byte count.`);
    }
    knownProjectBytes += Number(bytes);
    if (!Number.isSafeInteger(knownProjectBytes) || knownProjectBytes > referencePlanarTrackLimits.maxProjectBytes) {
      fail(consumer.node, "CUT_PLANAR_TRACK_LIMIT", `known project planar-track bytes exceed ${referencePlanarTrackLimits.maxProjectBytes}.`);
    }
  }
  const conflicts = firstNonPlanarConsumerByResource(ir);
  for (const { node, config } of consumers) {
    const conflict = conflicts.get(config.sourceId);
    if (conflict) {
      fail(node, "CUT_PLANAR_TRACK_RESOURCE_CONFLICT", `locked planar-track DataAsset ${config.sourceId} is also consumed by ${conflict.op}; declare separate assets for distinct schemas.`);
    }
  }
  return new Map(consumers.map(({ config }) => [config.nodeId, config]));
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Bounded scanner runs before JSON.parse, preventing duplicate decoded-key semantics. */
class PlanarTrackJsonScanner {
  private offset = 0;
  private nodes = 0;
  private readonly numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;

  constructor(private readonly node: IRNode, private readonly source: string) {}

  scan() {
    this.space();
    this.value(0);
    this.space();
    if (this.offset !== this.source.length) this.syntax("unexpected trailing input");
  }

  private syntax(message: string): never {
    fail(this.node, "CUT_PLANAR_TRACK_JSON", `${message} at text offset ${this.offset}.`);
  }

  private space() {
    while (this.offset < this.source.length && /\s/u.test(this.source[this.offset]!)) this.offset += 1;
  }

  private value(depth: number) {
    this.nodes += 1;
    if (this.nodes > referencePlanarTrackLimits.maxJsonNodes) {
      fail(this.node, "CUT_PLANAR_TRACK_LIMIT", `JSON exceeds ${referencePlanarTrackLimits.maxJsonNodes} values.`);
    }
    if (depth > referencePlanarTrackLimits.maxJsonDepth) {
      fail(this.node, "CUT_PLANAR_TRACK_LIMIT", `JSON exceeds depth ${referencePlanarTrackLimits.maxJsonDepth}.`);
    }
    this.space();
    const character = this.source[this.offset];
    if (character === "{") this.object(depth);
    else if (character === "[") this.array(depth);
    else if (character === "\"") this.string();
    else if (this.source.startsWith("true", this.offset)) this.offset += 4;
    else if (this.source.startsWith("false", this.offset)) this.offset += 5;
    else if (this.source.startsWith("null", this.offset)) this.offset += 4;
    else {
      this.numberPattern.lastIndex = this.offset;
      const match = this.numberPattern.exec(this.source);
      if (!match || match.index !== this.offset) this.syntax("expected a JSON value");
      this.offset = this.numberPattern.lastIndex;
    }
  }

  private string() {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset]!;
      if (character === "\"") {
        this.offset += 1;
        try {
          const result = JSON.parse(this.source.slice(start, this.offset)) as string;
          if (hasUnpairedSurrogate(result)) this.syntax("string contains an unpaired Unicode surrogate");
          return result;
        } catch {
          this.syntax("invalid JSON string");
        }
      }
      if (character === "\\") {
        this.offset += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.syntax("unescaped control character in string");
      this.offset += 1;
    }
    this.syntax("unterminated JSON string");
  }

  private object(depth: number) {
    this.offset += 1;
    this.space();
    const keys = new Set<string>();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return;
    }
    while (true) {
      if (this.source[this.offset] !== "\"") this.syntax("expected an object key");
      const key = this.string();
      if (keys.has(key)) {
        fail(this.node, "CUT_PLANAR_TRACK_JSON", `duplicate decoded object key ${boundedJsonKey(key)} near offset ${this.offset}.`);
      }
      keys.add(key);
      this.space();
      if (this.source[this.offset] !== ":") this.syntax("expected ':' after object key");
      this.offset += 1;
      this.value(depth + 1);
      this.space();
      if (this.source[this.offset] === "}") {
        this.offset += 1;
        return;
      }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or '}'");
      this.offset += 1;
      this.space();
    }
  }

  private array(depth: number) {
    this.offset += 1;
    this.space();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return;
    }
    while (true) {
      this.value(depth + 1);
      this.space();
      if (this.source[this.offset] === "]") {
        this.offset += 1;
        return;
      }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or ']'");
      this.offset += 1;
      this.space();
    }
  }
}

function parseJson(node: IRNode, bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > referencePlanarTrackLimits.maxBytes) {
    fail(node, "CUT_PLANAR_TRACK_LIMIT", `locked sidecar must contain 1 through ${referencePlanarTrackLimits.maxBytes} bytes.`);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(node, "CUT_PLANAR_TRACK_JSON", "locked sidecar is not valid UTF-8.");
  }
  new PlanarTrackJsonScanner(node, source).scan();
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail(node, "CUT_PLANAR_TRACK_JSON", "locked sidecar is not valid JSON.");
  }
}

const integerPattern = /^-?(?:0|[1-9][0-9]*)$/u;
const positiveIntegerPattern = /^(?:[1-9][0-9]*)$/u;

function exactRational(node: IRNode, value: unknown, path: string) {
  const record = closedObject(node, value, path, ["numerator", "denominator"]);
  const numerator = record.numerator, denominator = record.denominator;
  if (typeof numerator !== "string" || typeof denominator !== "string" || numerator === "-0"
    || !integerPattern.test(numerator) || !positiveIntegerPattern.test(denominator)
    || numerator.replace("-", "").length > referencePlanarTrackLimits.maxRationalDigits
    || denominator.length > referencePlanarTrackLimits.maxRationalDigits) {
    fail(node, "CUT_PLANAR_TRACK_SCHEMA", `${path} must contain bounded canonical integer strings and a positive denominator.`);
  }
  const result = rational(numerator, denominator);
  if (result.numerator !== numerator || result.denominator !== denominator) {
    fail(node, "CUT_PLANAR_TRACK_SCHEMA", `${path} must be reduced to canonical lowest terms.`);
  }
  return Object.freeze(result);
}

function boundedRational(node: IRNode, value: Rational, path: string, minimum: Rational, maximum: Rational) {
  if (compareRational(value, minimum) < 0 || compareRational(value, maximum) > 0) {
    fail(node, "CUT_PLANAR_TRACK_RANGE", `${path} is outside its declared finite bound.`);
  }
  return value;
}

function safeDimension(node: IRNode, value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > referencePlanarTrackLimits.maxCanvasDimension) {
    fail(node, "CUT_PLANAR_TRACK_DIMENSIONS", `${path} must be a positive safe integer no greater than ${referencePlanarTrackLimits.maxCanvasDimension}.`);
  }
  return Number(value);
}

function parsePoint(node: IRNode, value: unknown, path: string, coordinateLimit: Rational): ReferencePlanarTrackPoint {
  const point = closedObject(node, value, path, ["x", "y"]);
  const minimum = multiplyRational(coordinateLimit, rational(-1));
  return Object.freeze({
    x: boundedRational(node, exactRational(node, point.x, `${path}.x`), `${path}.x`, minimum, coordinateLimit),
    y: boundedRational(node, exactRational(node, point.y, `${path}.y`), `${path}.y`, minimum, coordinateLimit),
  });
}

function parseQuad(node: IRNode, value: unknown, path: string): ReferencePlanarTrackQuad {
  const corners = closedObject(node, value, path, ["topLeft", "topRight", "bottomRight", "bottomLeft"]);
  const limit = rational(referencePlanarTrackLimits.maxAbsoluteCoordinate);
  return Object.freeze({
    topLeft: parsePoint(node, corners.topLeft, `${path}.topLeft`, limit),
    topRight: parsePoint(node, corners.topRight, `${path}.topRight`, limit),
    bottomRight: parsePoint(node, corners.bottomRight, `${path}.bottomRight`, limit),
    bottomLeft: parsePoint(node, corners.bottomLeft, `${path}.bottomLeft`, limit),
  });
}

function floorDivide(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator, remainder = numerator % denominator;
  return remainder < 0n ? quotient - 1n : quotient;
}

function ceilDivide(numerator: bigint, denominator: bigint) {
  return -floorDivide(-numerator, denominator);
}

/** Exact equivalent of Math.round(rational * 65536), including signed ties toward +infinity. */
function quantizeRationalQ16(value: Rational) {
  const numerator = BigInt(value.numerator) * BigInt(referencePlanarTrackPhaseUnits);
  const denominator = BigInt(value.denominator);
  const floor = floorDivide(numerator, denominator), remainder = numerator - floor * denominator;
  return remainder * 2n >= denominator ? floor + 1n : floor;
}

const cornerNames = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;

function quadQ16(quad: ReferencePlanarTrackQuad): ReferencePlanarTrackQuadQ16 {
  return Object.freeze(cornerNames.map((name) => Object.freeze({
    x: String(quantizeRationalQ16(quad[name].x)),
    y: String(quantizeRationalQ16(quad[name].y)),
  })) as unknown as ReferencePlanarTrackQuadQ16);
}

function clippedDestinationBounds(
  node: IRNode,
  value: ReferencePlanarTrackQuadQ16,
  width: number,
  height: number,
  path: string,
): ReferenceProjectiveRasterBounds {
  const phase = BigInt(referencePlanarTrackPhaseUnits), half = phase / 2n;
  const xs = value.map((point) => BigInt(point.x)), ys = value.map((point) => BigInt(point.y));
  const minimumX = xs.reduce((minimum, item) => item < minimum ? item : minimum);
  const maximumX = xs.reduce((maximum, item) => item > maximum ? item : maximum);
  const minimumY = ys.reduce((minimum, item) => item < minimum ? item : minimum);
  const maximumY = ys.reduce((maximum, item) => item > maximum ? item : maximum);
  const unclippedLeft = ceilDivide(minimumX - half, phase);
  const unclippedRight = floorDivide(maximumX - half, phase) + 1n;
  const unclippedTop = ceilDivide(minimumY - half, phase);
  const unclippedBottom = floorDivide(maximumY - half, phase) + 1n;
  const left = Number(unclippedLeft < 0n ? 0n : unclippedLeft);
  const right = Number(unclippedRight > BigInt(width) ? BigInt(width) : unclippedRight);
  const top = Number(unclippedTop < 0n ? 0n : unclippedTop);
  const bottom = Number(unclippedBottom > BigInt(height) ? BigInt(height) : unclippedBottom);
  if (right <= left || bottom <= top) {
    fail(node, "CUT_PLANAR_TRACK_GEOMETRY", `${path} has no composition pixel-center intersection after exact Q16 clipping.`);
  }
  return Object.freeze({ left, top, right, bottom });
}

function kernelQuad(value: ReferencePlanarTrackQuadQ16): ReferenceProjectiveQuad {
  return Object.freeze(value.map((point) => Object.freeze({
    x: Number(BigInt(point.x)) / referencePlanarTrackPhaseUnits,
    y: Number(BigInt(point.y)) / referencePlanarTrackPhaseUnits,
  })) as unknown as ReferenceProjectiveQuad);
}

function projectivePlan(
  node: IRNode,
  value: ReferencePlanarTrackQuadQ16,
  compositionWidth: number,
  compositionHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  path: string,
) {
  const destinationBounds = clippedDestinationBounds(node, value, compositionWidth, compositionHeight, path);
  try {
    const plan = planReferenceProjectiveWarp({
      sourceWidth,
      sourceHeight,
      destinationQuad: kernelQuad(value),
      destinationBounds,
    });
    return Object.freeze({ destinationBounds, plan });
  } catch (error) {
    if (!(error instanceof ReferenceProjectiveWarpError)) throw error;
    const code = error.code === "CUT_PROJECTIVE_WARP_WORK_LIMIT"
      ? "CUT_PLANAR_TRACK_LIMIT"
      : "CUT_PLANAR_TRACK_GEOMETRY";
    fail(node, code, `${path} is not a usable Q16 planar quad (${error.code}: ${error.message.replace(/^CUT_PROJECTIVE_WARP_[A-Z_]+:\s*/u, "")}).`);
  }
}

function lockedResource(
  ir: CutAVIR,
  node: IRNode,
  config: ReferencePlanarTrackConfig,
  bytes: Uint8Array,
): ReferencePlanarTrackLockedResource {
  const resource = ir.resources[config.sourceId];
  if (!resource || resource.kind !== "data") {
    fail(node, "CUT_PLANAR_TRACK_RESOURCE", `source ${config.sourceId} is not a DataAsset.`);
  }
  if (resource.state !== "locked" || typeof resource.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(resource.sha256)) {
    fail(node, "CUT_PLANAR_TRACK_RESOURCE", `source ${config.sourceId} must have a locked lowercase SHA-256 identity before preparation.`);
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== resource.sha256) {
    fail(node, "CUT_PLANAR_TRACK_RESOURCE", `source ${config.sourceId} bytes changed after lock (expected ${resource.sha256}, observed ${actualSha256}).`);
  }
  const metadataBytes = resource.metadata?.bytes;
  if (metadataBytes !== undefined && (!Number.isSafeInteger(metadataBytes) || metadataBytes !== bytes.byteLength)) {
    fail(node, "CUT_PLANAR_TRACK_RESOURCE", `source ${config.sourceId} byte count changed after lock.`);
  }
  const base = Object.freeze({
    id: resource.id,
    kind: "data" as const,
    locator: resource.locator,
    state: "locked" as const,
    sha256: resource.sha256,
    bytes: bytes.byteLength,
    metadataIdentity: hash(resource.metadata ?? null),
  });
  return Object.freeze({ ...base, identity: hash({ contract: "cut-planar-track-locked-resource", resource: base }) });
}

function sameConfig(left: ReferencePlanarTrackConfig, right: ReferencePlanarTrackConfig) {
  return left.configIdentity === right.configIdentity && left.nodeId === right.nodeId && left.sourceId === right.sourceId;
}

function configIdentityIsValid(config: ReferencePlanarTrackConfig) {
  const value = {
    nodeId: config.nodeId,
    sourceId: config.sourceId,
    interpolation: config.interpolation,
    minConfidence: config.minConfidence,
    lowConfidence: config.lowConfidence,
    occluded: config.occluded,
    outOfFrame: config.outOfFrame,
    opacity: config.opacity,
  };
  return planarConfigIdentity(value) === config.configIdentity;
}

/** Parse, bind, and semantically validate one locked cut-planar-track v1 sidecar. */
export function prepareReferencePlanarTrack(
  ir: CutAVIR,
  node: IRNode,
  config: ReferencePlanarTrackConfig,
  composition: IRComposition,
  bytes: Uint8Array,
): PreparedReferencePlanarTrack {
  const derivedConfig = referencePlanarTrackConfig(ir, node);
  if (!derivedConfig || !sameConfig(config, derivedConfig)) {
    fail(node, "CUT_PLANAR_TRACK_CONFIG", "runtime configuration does not match the exact authored PlanarTrack node.");
  }
  const sourceResource = lockedResource(ir, node, config, bytes);
  const root = closedObject(node, parseJson(node, bytes), "$", ["coordinateSpace", "format", "height", "samples", "version", "width"]);
  if (root.format !== "cut-planar-track" || root.version !== 1 || root.coordinateSpace !== "composition-pixel-edges") {
    fail(node, "CUT_PLANAR_TRACK_SCHEMA", "$ must declare cut-planar-track v1 in composition-pixel-edges.");
  }
  const width = safeDimension(node, root.width, "$.width"), height = safeDimension(node, root.height, "$.height");
  if (width !== composition.width || height !== composition.height) {
    fail(node, "CUT_PLANAR_TRACK_DIMENSIONS", `sidecar canvas ${width}×${height} does not match composition ${composition.width}×${composition.height}.`);
  }
  if (!Array.isArray(root.samples) || root.samples.length < 2 || root.samples.length > referencePlanarTrackLimits.maxSamples) {
    fail(node, "CUT_PLANAR_TRACK_LIMIT", `$.samples must contain 2 through ${referencePlanarTrackLimits.maxSamples} observations.`);
  }
  const samples = root.samples.map((value, index): ReferencePlanarTrackSample => {
    const path = `$.samples[${index}]`;
    const sample = closedObject(node, value, path, ["at", "corners", "confidence", "status"]);
    if (sample.status !== "visible" && sample.status !== "occluded" && sample.status !== "out-of-frame") {
      fail(node, "CUT_PLANAR_TRACK_SCHEMA", `${path}.status must be visible, occluded, or out-of-frame.`);
    }
    const status = sample.status as ReferencePlanarTrackStatus;
    const at = exactRational(node, sample.at, `${path}.at`);
    const confidence = boundedRational(
      node,
      exactRational(node, sample.confidence, `${path}.confidence`),
      `${path}.confidence`,
      zeroRational,
      rational(1),
    );
    const corners = parseQuad(node, sample.corners, `${path}.corners`);
    const quantized = quadQ16(corners);
    if (status === "visible") projectivePlan(node, quantized, width, height, 1, 1, `${path}.corners`);
    const identityValue = { at, confidence, status, corners, quadQ16: quantized };
    return Object.freeze({ ...identityValue, sidecarSampleIdentity: hash({ kind: "cut-planar-track-sidecar-sample", ...identityValue }) });
  });
  for (let index = 1; index < samples.length; index += 1) {
    if (compareRational(samples[index - 1]!.at, samples[index]!.at) >= 0) {
      fail(node, "CUT_PLANAR_TRACK_TIME", `$.samples[${index}].at must be strictly later than the previous exact time.`);
    }
  }
  if (compareRational(samples[0]!.at, zeroRational) !== 0
    || compareRational(samples.at(-1)!.at, node.interval.duration) !== 0) {
    fail(node, "CUT_PLANAR_TRACK_TIME", "samples must cover the complete node-local clock with exact observations at 0s and at the node duration.");
  }
  const identityValue = {
    algorithmVersion: referencePlanarTrackAlgorithmVersion as typeof referencePlanarTrackAlgorithmVersion,
    format: "cut-planar-track" as const,
    version: 1 as const,
    coordinateSpace: "composition-pixel-edges" as const,
    nodeId: node.id,
    sourceId: config.sourceId,
    width,
    height,
    duration: Object.freeze({ ...node.interval.duration }),
    configIdentity: config.configIdentity,
    sourceResource,
    samples: Object.freeze(samples),
  };
  return Object.freeze({
    ...identityValue,
    preparationIdentity: hash({ kind: "cut-planar-track-preparation", ...identityValue }),
  });
}

function compositionPlanarTrackNodes(ir: CutAVIR, composition: IRComposition) {
  const sceneIds = new Set(composition.sceneIds);
  const reachable = new Set<string>(composition.rootVisualIds);
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (!scene) continue;
    for (const id of [...scene.rootVisualIds, ...scene.rootAVIds, ...scene.items.map((item) => item.id)]) reachable.add(id);
  }
  const pending = [...reachable];
  while (pending.length) {
    const node = ir.nodes[pending.pop()!];
    if (!node) continue;
    for (const child of node.children) {
      if (!reachable.has(child)) {
        reachable.add(child);
        pending.push(child);
      }
    }
  }
  return Object.values(ir.nodes)
    .filter((node) => node.op === "cut.visual.planar_track" && (reachable.has(node.id) || (node.sceneId !== undefined && sceneIds.has(node.sceneId))))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Lock-time semantic validation. The caller supplies bytes before the public
 * resource is mutated to `locked`; this function validates through an
 * isolated expected-byte view and never mutates `ir`.
 */
export async function validateReferencePlanarTrackResources(
  ir: CutAVIR,
  composition: IRComposition,
  load: (resourceId: string, node: IRNode) => Promise<Uint8Array>,
) {
  const ownership = validateReferencePlanarTrackResourceOwnership(ir);
  const nodes = compositionPlanarTrackNodes(ir, composition);
  if (nodes.length > referencePlanarTrackLimits.maxNodesPerComposition) {
    fail(nodes[referencePlanarTrackLimits.maxNodesPerComposition]!, "CUT_PLANAR_TRACK_LIMIT", `composition references more than ${referencePlanarTrackLimits.maxNodesPerComposition} PlanarTrack nodes.`);
  }
  const groups = new Map<string, IRNode[]>();
  for (const node of nodes) {
    const config = ownership.get(node.id);
    if (!config) fail(node, "CUT_PLANAR_TRACK_CONFIG", "composition PlanarTrack node has no validated resource owner configuration.");
    const group = groups.get(config.sourceId) ?? [];
    group.push(node);
    groups.set(config.sourceId, group);
  }
  if (groups.size > referencePlanarTrackLimits.maxDistinctResourcesPerComposition) {
    const excessId = [...groups.keys()].sort()[referencePlanarTrackLimits.maxDistinctResourcesPerComposition]!;
    fail(groups.get(excessId)![0]!, "CUT_PLANAR_TRACK_LIMIT", `composition references more than ${referencePlanarTrackLimits.maxDistinctResourcesPerComposition} distinct planar-track resources.`);
  }

  const prepared = new Map<string, PreparedReferencePlanarTrack>();
  let compositionBytes = 0, compositionSamples = 0;
  for (const sourceId of [...groups.keys()].sort()) {
    const consumers = groups.get(sourceId)!.sort((left, right) => left.id.localeCompare(right.id));
    const bytes = await load(sourceId, consumers[0]!);
    if (!(bytes instanceof Uint8Array)) fail(consumers[0]!, "CUT_PLANAR_TRACK_INPUT_TYPE", "planar-track loader must return Uint8Array bytes.");
    compositionBytes += bytes.byteLength;
    if (!Number.isSafeInteger(compositionBytes) || compositionBytes > referencePlanarTrackLimits.maxCompositionBytes) {
      fail(consumers[0]!, "CUT_PLANAR_TRACK_LIMIT", `composition planar-track bytes exceed ${referencePlanarTrackLimits.maxCompositionBytes}.`);
    }
    const resource = ir.resources[sourceId];
    if (!resource || resource.kind !== "data") fail(consumers[0]!, "CUT_PLANAR_TRACK_RESOURCE", `cannot resolve planar-track DataAsset ${sourceId}.`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const verificationIr: CutAVIR = {
      ...ir,
      resources: {
        ...ir.resources,
        [sourceId]: {
          ...resource,
          state: "locked",
          sha256,
          metadata: { ...(resource.metadata ?? {}), bytes: bytes.byteLength },
        },
      },
    };
    for (const node of consumers) {
      const config = ownership.get(node.id)!;
      const value = prepareReferencePlanarTrack(verificationIr, node, config, composition, bytes);
      compositionSamples += value.samples.length;
      if (!Number.isSafeInteger(compositionSamples) || compositionSamples > referencePlanarTrackLimits.maxSamplesPerComposition) {
        fail(node, "CUT_PLANAR_TRACK_LIMIT", `composition planar-track observations exceed ${referencePlanarTrackLimits.maxSamplesPerComposition}.`);
      }
      prepared.set(node.id, value);
    }
  }
  return prepared;
}

function policyIssue(sample: ReferencePlanarTrackSample, config: ReferencePlanarTrackConfig) {
  if (sample.status === "occluded") return { reason: "occluded" as const, action: config.occluded };
  if (sample.status === "out-of-frame") return { reason: "out-of-frame" as const, action: config.outOfFrame };
  return { reason: "low-confidence" as const, action: config.lowConfidence };
}

function usable(sample: ReferencePlanarTrackSample, config: ReferencePlanarTrackConfig) {
  return sample.status === "visible" && compareRational(sample.confidence, config.minConfidence) >= 0;
}

function frozenRational(value: Rational) {
  return Object.freeze({ ...value });
}

function interpolationProgress(localTime: Rational, left: ReferencePlanarTrackSample, right: ReferencePlanarTrackSample) {
  return divideRational(subtractRational(localTime, left.at), subtractRational(right.at, left.at));
}

function rationalDigitCount(value: Rational) {
  return Math.max(value.numerator.replace("-", "").length, value.denominator.length);
}

function boundedDerivedRational(node: IRNode, value: Rational, label: string) {
  if (rationalDigitCount(value) > referencePlanarTrackLimits.maxRuntimeRationalDigits) {
    fail(node, "CUT_PLANAR_TRACK_LIMIT", `${label} exceeds ${referencePlanarTrackLimits.maxRuntimeRationalDigits} exact rational digits.`);
  }
  return Object.freeze(value);
}

function interpolateRational(node: IRNode, left: Rational, right: Rational, progress: Rational, label: string) {
  return boundedDerivedRational(node, addRational(left, multiplyRational(subtractRational(right, left), progress)), label);
}

function interpolateQuad(
  node: IRNode,
  left: ReferencePlanarTrackQuad,
  right: ReferencePlanarTrackQuad,
  progress: Rational,
): ReferencePlanarTrackQuad {
  const point = (name: typeof cornerNames[number]) => Object.freeze({
    x: interpolateRational(node, left[name].x, right[name].x, progress, `${name}.x interpolation`),
    y: interpolateRational(node, left[name].y, right[name].y, progress, `${name}.y interpolation`),
  });
  return Object.freeze({
    topLeft: point("topLeft"),
    topRight: point("topRight"),
    bottomRight: point("bottomRight"),
    bottomLeft: point("bottomLeft"),
  });
}

function validateLocalTime(node: IRNode, localTime: Rational) {
  if (!integerPattern.test(localTime.numerator) || !positiveIntegerPattern.test(localTime.denominator)
    || rationalDigitCount(localTime) > referencePlanarTrackLimits.maxRuntimeRationalDigits) {
    fail(node, "CUT_PLANAR_TRACK_TIME", "evaluated node-local time must be a bounded canonical exact rational.");
  }
  const canonical = rational(localTime.numerator, localTime.denominator);
  if (canonical.numerator !== localTime.numerator || canonical.denominator !== localTime.denominator) {
    fail(node, "CUT_PLANAR_TRACK_TIME", "evaluated node-local time must be reduced to canonical lowest terms.");
  }
  if (compareRational(localTime, zeroRational) < 0 || compareRational(localTime, node.interval.duration) > 0) {
    fail(node, "CUT_PLANAR_TRACK_TIME", `evaluated local time ${localTime.numerator}/${localTime.denominator}s is outside the node clock.`);
  }
}

function evaluatedOpacity(node: IRNode, value: Rational) {
  if (!value || !integerPattern.test(value.numerator) || !positiveIntegerPattern.test(value.denominator)
    || rationalDigitCount(value) > referencePlanarTrackLimits.maxRuntimeRationalDigits) {
    fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", "evaluated opacity must be a bounded canonical exact Ratio.");
  }
  const canonical = rational(value.numerator, value.denominator);
  if (canonical.numerator !== value.numerator || canonical.denominator !== value.denominator) {
    fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", "evaluated opacity must be reduced to canonical lowest terms.");
  }
  if (compareRational(value, zeroRational) < 0 || compareRational(value, rational(1)) > 0) {
    fail(node, "CUT_PLANAR_TRACK_RANGE", "evaluated opacity must be between 0% and 100%.");
  }
  return frozenRational(value);
}

function validateSourceDimensions(node: IRNode, source: Readonly<{ sourceWidth: number; sourceHeight: number }>) {
  if (!source || typeof source !== "object"
    || !Number.isSafeInteger(source.sourceWidth) || !Number.isSafeInteger(source.sourceHeight)
    || source.sourceWidth < 1 || source.sourceHeight < 1) {
    fail(node, "CUT_PLANAR_TRACK_INPUT_TYPE", "LocalSpace sourceWidth/sourceHeight must be positive safe integers.");
  }
  if (source.sourceWidth > referenceProjectiveWarpLimits.maximumSourceAxis
    || source.sourceHeight > referenceProjectiveWarpLimits.maximumSourceAxis
    || source.sourceWidth * source.sourceHeight > referenceProjectiveWarpLimits.maximumSourcePixels) {
    fail(node, "CUT_PLANAR_TRACK_LIMIT", "LocalSpace source dimensions exceed the bounded projective-warp source budget.");
  }
}

type ResolvedTrackObservation = Readonly<{
  hidden: boolean;
  quad?: ReferencePlanarTrackQuad;
  resolution: ReferencePlanarTrackResolution;
  hiddenReason?: "low-confidence" | "occluded" | "out-of-frame";
}>;

function resolutionBase(
  track: PreparedReferencePlanarTrack,
  status: ReferencePlanarTrackStatus,
  leftSampleIndex: number,
  rightSampleIndex: number,
  progress: Rational,
) {
  return {
    status,
    leftSampleIndex,
    rightSampleIndex,
    progress: frozenRational(progress),
    leftConfidence: frozenRational(track.samples[leftSampleIndex]!.confidence),
    rightConfidence: frozenRational(track.samples[rightSampleIndex]!.confidence),
  };
}

function resolveUnusable(
  node: IRNode,
  track: PreparedReferencePlanarTrack,
  config: ReferencePlanarTrackConfig,
  observationIndex: number,
  rightIndex: number,
  progress: Rational,
  localTime: Rational,
): ResolvedTrackObservation {
  const sample = track.samples[observationIndex]!, issue = policyIssue(sample, config);
  const policy = Object.freeze({ ...issue, observationSampleIndex: observationIndex });
  const base = resolutionBase(track, sample.status, observationIndex, rightIndex, progress);
  if (issue.action === "hide") {
    return Object.freeze({
      hidden: true,
      hiddenReason: issue.reason,
      resolution: Object.freeze({ ...base, classification: "policy-hidden" as const, policy }),
    });
  }
  if (issue.action === "fail") {
    fail(node, "CUT_PLANAR_TRACK_SAMPLE", `sample at ${sample.at.numerator}/${sample.at.denominator}s is ${issue.reason} at evaluated time ${localTime.numerator}/${localTime.denominator}s and policy is fail.`);
  }
  for (let previous = observationIndex - 1; previous >= 0; previous -= 1) {
    if (usable(track.samples[previous]!, config)) {
      return Object.freeze({
        hidden: false,
        quad: track.samples[previous]!.corners,
        resolution: Object.freeze({
          ...base,
          classification: "policy-held" as const,
          selectedSampleIndex: previous,
          policy,
        }),
      });
    }
  }
  fail(node, "CUT_PLANAR_TRACK_HOLD_EMPTY", `sample at ${sample.at.numerator}/${sample.at.denominator}s requests hold for ${issue.reason}, but no earlier visible sample meets minConfidence.`);
}

function resolveTrackObservation(
  node: IRNode,
  track: PreparedReferencePlanarTrack,
  config: ReferencePlanarTrackConfig,
  localTime: Rational,
): ResolvedTrackObservation {
  let low = 0, high = track.samples.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), compared = compareRational(track.samples[middle]!.at, localTime);
    if (compared === 0) {
      const sample = track.samples[middle]!;
      if (!usable(sample, config)) return resolveUnusable(node, track, config, middle, middle, zeroRational, localTime);
      return Object.freeze({
        hidden: false,
        quad: sample.corners,
        resolution: Object.freeze({
          ...resolutionBase(track, sample.status, middle, middle, zeroRational),
          classification: "exact-visible" as const,
          selectedSampleIndex: middle,
        }),
      });
    }
    if (compared < 0) low = middle + 1;
    else high = middle - 1;
  }
  const leftIndex = Math.max(0, high), rightIndex = Math.min(track.samples.length - 1, low);
  const left = track.samples[leftIndex]!, right = track.samples[rightIndex]!;
  const progress = interpolationProgress(localTime, left, right);
  if (!usable(left, config)) return resolveUnusable(node, track, config, leftIndex, rightIndex, progress, localTime);
  const base = resolutionBase(track, left.status, leftIndex, rightIndex, progress);
  if (config.interpolation === "linear" && usable(right, config)) {
    return Object.freeze({
      hidden: false,
      quad: interpolateQuad(node, left.corners, right.corners, progress),
      resolution: Object.freeze({ ...base, classification: "linear-visible" as const }),
    });
  }
  const blocked = config.interpolation === "linear" && !usable(right, config);
  return Object.freeze({
    hidden: false,
    quad: left.corners,
    resolution: Object.freeze({
      ...base,
      classification: blocked ? "held-before-unusable-right" as const : "interpolation-held" as const,
      selectedSampleIndex: leftIndex,
      ...(blocked ? { blockedRightSampleIndex: rightIndex } : {}),
    }),
  });
}

function hiddenResult(
  node: IRNode,
  track: PreparedReferencePlanarTrack,
  localTime: Rational,
  resolution: ReferencePlanarTrackResolution,
  opacity: Rational,
  skip: ReferencePlanarTrackSkip,
): ReferencePlanarTrackAtResult {
  const work = Object.freeze({ projectivePlans: 0 as const, destinationPixels: 0 as const, destinationRgbaBytes: 0 as const });
  const identityValue = {
    algorithmVersion: referencePlanarTrackAlgorithmVersion as typeof referencePlanarTrackAlgorithmVersion,
    nodeId: node.id,
    exactNodeLocalTime: frozenRational(localTime),
    preparationIdentity: track.preparationIdentity,
    opacity,
    resolution,
    hidden: true as const,
    skip,
    work,
  };
  return Object.freeze({ ...identityValue, sampleIdentity: hash({ kind: "cut-planar-track-sample", ...identityValue }) });
}

/**
 * Sample one exact node-local clock. Every non-hidden result owns a freshly
 * validated projective plan for the supplied LocalSpace raster dimensions.
 */
export function referencePlanarTrackAt(
  node: IRNode,
  track: PreparedReferencePlanarTrack,
  config: ReferencePlanarTrackConfig,
  localTime: Rational,
  source: Readonly<{ sourceWidth: number; sourceHeight: number; opacity: Rational }>,
): ReferencePlanarTrackAtResult {
  if (node.op !== "cut.visual.planar_track" || node.id !== track.nodeId || !configIdentityIsValid(config)
    || !sameConfig(config, { ...config, configIdentity: track.configIdentity })) {
    fail(node, "CUT_PLANAR_TRACK_CONFIG", "prepared track, authored node, and runtime configuration do not share one identity.");
  }
  validateLocalTime(node, localTime);
  validateSourceDimensions(node, source);
  const opacity = evaluatedOpacity(node, source.opacity);
  const resolved = resolveTrackObservation(node, track, config, localTime);
  if (resolved.hidden) {
    return hiddenResult(node, track, localTime, resolved.resolution, opacity, Object.freeze({
      classification: "tracking-policy-hidden",
      reason: resolved.hiddenReason!,
    }));
  }
  if (compareRational(opacity, zeroRational) === 0) {
    return hiddenResult(node, track, localTime, resolved.resolution, opacity, Object.freeze({
      classification: "owner-opacity",
      reason: "opacity-zero",
    }));
  }
  const quantized = quadQ16(resolved.quad!);
  const planned = projectivePlan(
    node,
    quantized,
    track.width,
    track.height,
    source.sourceWidth,
    source.sourceHeight,
    `sampled quad at ${localTime.numerator}/${localTime.denominator}s`,
  );
  const identityValue = {
    algorithmVersion: referencePlanarTrackAlgorithmVersion as typeof referencePlanarTrackAlgorithmVersion,
    nodeId: node.id,
    exactNodeLocalTime: frozenRational(localTime),
    preparationIdentity: track.preparationIdentity,
    opacity,
    resolution: resolved.resolution,
    hidden: false as const,
    quad: resolved.quad!,
    quadQ16: planned.plan.destination.quadQ16,
    destinationBounds: planned.destinationBounds,
    projectivePlan: planned.plan,
  };
  return Object.freeze({
    ...identityValue,
    sampleIdentity: hash({
      kind: "cut-planar-track-sample",
      ...identityValue,
      projectivePlan: planned.plan.planIdentity,
    }),
  });
}
