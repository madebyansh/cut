import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import {
  ReferenceLocalSpaceError,
  referenceLocalSpaceRasterOrigin,
  type ReferenceLocalSpaceConfig,
} from "./local-space";
import {
  canonicalReferenceLocalSpaceRotationDegrees,
  planReferenceLocalSpaceTileTransformWork,
  referenceLocalSpaceTransformRendererHandoff,
  referenceLocalSpaceTransformSchedulingEnforcement,
  type ReferenceLocalSpaceUniformTileTransformWork,
} from "./local-space-transform-work";
import {
  referenceAffine2D,
  referenceRect,
  transformReferenceRect,
  type ReferenceAffine2D,
  type ReferenceRect,
} from "./retained-visual";
import type { ReferencePreparedSignalResolver } from "./signals";
import { referenceVisualTransformAt } from "./visual-config";

export const referenceTrack2DLimits = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxCompositionBytes: 32 * 1024 * 1024,
  maxNodesPerComposition: 128,
  maxSamples: 100_000,
  maxJsonDepth: 16,
  maxJsonNodes: 1_000_000,
  maxRationalDigits: 64,
  maxCanvasDimension: 65_536,
  maxAbsoluteCoordinate: 65_536,
  minScale: rational(1, 1_000),
  maxScale: rational(1_000),
  maxAbsoluteRotationDegrees: rational(1_000_000),
});

export type ReferenceTrack2DInterpolation = "linear" | "hold";
export type ReferenceTrack2DPolicy = "fail" | "hold" | "hide";
export type ReferenceTrack2DStatus = "visible" | "occluded" | "out-of-frame";

export type ReferenceTrack2DConfig = {
  nodeId: string;
  sourceId: string;
  interpolation: ReferenceTrack2DInterpolation;
  minConfidence: Rational;
  lowConfidence: ReferenceTrack2DPolicy;
  occluded: ReferenceTrack2DPolicy;
  outOfFrame: ReferenceTrack2DPolicy;
  bindScale: boolean;
  bindRotation: boolean;
};

export type ReferenceTrack2DSample = {
  at: Rational;
  x: Rational;
  y: Rational;
  scale?: Rational;
  rotation?: Rational;
  confidence: Rational;
  status: ReferenceTrack2DStatus;
};

export type PreparedReferenceTrack2D = {
  format: "cut-track-2d";
  version: 1;
  coordinateSpace: "composition-pixels";
  width: number;
  height: number;
  samples: readonly ReferenceTrack2DSample[];
};

export type ReferenceTrack2DTransform = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  hidden: boolean;
};

/** Retained-source plan for the exact public `Track2D { LocalSpace { ... } }`
 * boundary. The reference compositor consumes it directly and emits separate
 * same-invocation frame evidence. */
export type ReferenceTrack2DLocalSpacePlan = Readonly<{
  nodeId: string;
  localSpaceNodeId: string;
  exactTime: Rational;
  exactNodeLocalTime: Rational;
  hidden: boolean;
  sourceSpace: Readonly<{
    width: number;
    height: number;
    authoredView: ReferenceLocalSpaceConfig["view"];
    rasterRegistration: Readonly<{ x: number; y: number }>;
    semanticIdentity: string;
  }>;
  observedCompositionPoint?: Readonly<{ x: number; y: number }>;
  destinationRegistration?: Readonly<{ x: number; y: number }>;
  localToComposition?: ReferenceAffine2D;
  /** Exact authored geometry for semantic inspection. Pixel placement does
   * not consume this rect because LocalSpace has one Q16 raster boundary. */
  authoredProjectedSourceBounds?: ReferenceRect;
  /** Q16 raster geometry consumed by placement, cache, and future clipping. */
  rasterProjectedSourceBounds?: ReferenceRect;
  scale?: number;
  rotation?: number;
  opacity?: number;
  skip?: ReferenceTrack2DLocalSpaceSkip;
  work: ReferenceLocalSpaceUniformTileTransformWork | ReferenceTrack2DNoRasterLocalSpaceWork;
  rendererHandoff: typeof referenceLocalSpaceTransformRendererHandoff;
  cacheIdentity: string;
}>;

export type ReferenceTrack2DLocalSpaceSkip =
  | Readonly<{
    classification: "tracking-policy-hidden";
    reason: "track-sample-hidden";
    executionEvidence: Readonly<{
      skipKind: "owner-policy";
      skipReason: "tracking-policy-hidden";
      counter: "ownerPolicySkips";
    }>;
  }>
  | Readonly<{
    classification: "owner-opacity";
    reason: "opacity-zero";
    executionEvidence: Readonly<{
      skipKind: "owner-opacity";
      skipReason: "opacity-zero";
      counter: "ownerOpacitySkips";
    }>;
  }>;

export type ReferenceTrack2DNoRasterLocalSpaceWork = Readonly<{
  kind: "tracking-policy-hidden-no-raster" | "owner-opacity-no-raster";
  rendererHandoff: typeof referenceLocalSpaceTransformRendererHandoff;
  scheduling: Readonly<{
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition";
    enforcement: typeof referenceLocalSpaceTransformSchedulingEnforcement;
  }>;
  declaredSourcePixels: number;
  allocatedBytes: 0;
  compositionLiveOutputSurfaces: 0;
  compositionLiveOutputBytes: 0;
  expectedExecutionCounters: Readonly<{
    tileRequests: 0;
    placementRequests: 0;
    ownerOpacitySkips: 0 | 1;
    ownerPolicySkips: 0 | 1;
  }>;
}>;

export type ReferenceTrack2DErrorCode =
  | "CUT_TRACK2D_INPUT_TYPE"
  | "CUT_TRACK2D_RESOURCE"
  | "CUT_TRACK2D_RESOURCE_CONFLICT"
  | "CUT_TRACK2D_JSON"
  | "CUT_TRACK2D_SCHEMA"
  | "CUT_TRACK2D_LIMIT"
  | "CUT_TRACK2D_TIME"
  | "CUT_TRACK2D_RANGE"
  | "CUT_TRACK2D_DIMENSIONS"
  | "CUT_TRACK2D_BINDING"
  | "CUT_TRACK2D_SAMPLE"
  | "CUT_TRACK2D_HOLD_EMPTY";

export class ReferenceTrack2DError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceTrack2DErrorCode, readonly nodeId: string, node: IRNode, message: string) {
    const span = node.provenance.span;
    super(`${code}: Track2D at ${node.provenance.module}:${span.start.line}:${span.start.column} ${message}`);
    this.name = "ReferenceTrack2DError";
    this.source = { module: node.provenance.module, line: span.start.line, column: span.start.column, nodeId };
  }
}

type JsonObject = Record<string, unknown>;

function fail(node: IRNode, code: ReferenceTrack2DErrorCode, message: string): never {
  throw new ReferenceTrack2DError(code, node.id, node, message);
}

function isObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(node: IRNode, value: unknown, path: string) {
  if (!isObject(value)) fail(node, "CUT_TRACK2D_SCHEMA", `${path} must be an object.`);
  return value;
}

function closedObject(node: IRNode, value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const result = object(node, value, path), allowed = new Set([...required, ...optional]);
  for (const field of required) if (!Object.hasOwn(result, field)) fail(node, "CUT_TRACK2D_SCHEMA", `${path} is missing required field “${field}”.`);
  for (const field of Object.keys(result)) if (!allowed.has(field)) fail(node, "CUT_TRACK2D_SCHEMA", `${path}.${field} is not part of cut-track-2d v1.`);
  return result;
}

function referencesResource(value: IRValue, resourceId: string): boolean {
  if (value.kind === "resource-ref") return value.id === resourceId;
  if (value.kind === "array") return value.items.some((item) => referencesResource(item, resourceId));
  if (value.kind === "object") return Object.values(value.entries).some((item) => referencesResource(item, resourceId));
  if (value.kind === "range") return referencesResource(value.start, resourceId) || referencesResource(value.end, resourceId);
  if (value.kind === "unary") return referencesResource(value.value, resourceId);
  if (value.kind === "binary") return referencesResource(value.left, resourceId) || referencesResource(value.right, resourceId);
  if (value.kind === "member") return referencesResource(value.object, resourceId);
  if (value.kind === "index") return referencesResource(value.object, resourceId) || referencesResource(value.index, resourceId);
  if (value.kind === "call") return value.positional.some((item) => referencesResource(item, resourceId)) || Object.values(value.named).some((item) => referencesResource(item, resourceId));
  return false;
}

/** Locked execution identity deliberately excludes human-facing names and
 * source provenance. Formatting/comments may move an asset declaration, but
 * cannot change the bytes, schema metadata, or locator consumed by Track2D. */
function lockedTrack2DResourceIdentity(ir: CutAVIR, resourceId: string) {
  const resolved = ir.resources[resourceId];
  if (!resolved) return undefined;
  return Object.freeze({
    id: resolved.id,
    kind: resolved.kind,
    locator: resolved.locator,
    state: resolved.state,
    sha256: resolved.sha256,
    metadata: resolved.metadata,
  });
}

function noRasterTrack2DLocalSpaceWork(
  localSpace: ReferenceLocalSpaceConfig,
  kind: ReferenceTrack2DNoRasterLocalSpaceWork["kind"],
): ReferenceTrack2DNoRasterLocalSpaceWork {
  return Object.freeze({
    kind,
    rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
    scheduling: Object.freeze({
      requiredDiscipline: "serialize-tile-transform-allocation-per-composition" as const,
      enforcement: referenceLocalSpaceTransformSchedulingEnforcement,
    }),
    declaredSourcePixels: localSpace.width * localSpace.height,
    allocatedBytes: 0 as const,
    compositionLiveOutputSurfaces: 0 as const,
    compositionLiveOutputBytes: 0 as const,
    expectedExecutionCounters: Object.freeze({
      tileRequests: 0 as const,
      placementRequests: 0 as const,
      ownerOpacitySkips: (kind === "owner-opacity-no-raster" ? 1 : 0) as 0 | 1,
      ownerPolicySkips: (kind === "tracking-policy-hidden-no-raster" ? 1 : 0) as 0 | 1,
    }),
  });
}

function resource(node: IRNode, ir: CutAVIR) {
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") fail(node, "CUT_TRACK2D_INPUT_TYPE", "input “source” must be a DataAsset resource reference.");
  const resolved = ir.resources[source.id];
  if (!resolved || resolved.kind !== "data") fail(node, "CUT_TRACK2D_RESOURCE", "input “source” must reference a locked DataAsset.");
  return source.id;
}

function stringChoice<T extends string>(node: IRNode, name: string, allowed: readonly T[], fallback?: T): T {
  const value = node.inputs[name];
  if (value === undefined) {
    if (fallback === undefined) fail(node, "CUT_TRACK2D_INPUT_TYPE", `requires String input “${name}”.`);
    return fallback;
  }
  if (value.kind !== "string" || !allowed.includes(value.value as T)) fail(node, "CUT_TRACK2D_INPUT_TYPE", `input “${name}” must be one of: ${allowed.join(", ")}.`);
  return value.value as T;
}

function booleanInput(node: IRNode, name: string, fallback: boolean) {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "boolean") fail(node, "CUT_TRACK2D_INPUT_TYPE", `input “${name}” must be Boolean.`);
  return value.value;
}

function ratioInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_TRACK2D_INPUT_TYPE", `input “${name}” must be a canonical Ratio.`);
  }
  if (compareRational(value.magnitude, zeroRational) < 0 || compareRational(value.magnitude, rational(1)) > 0) {
    fail(node, "CUT_TRACK2D_RANGE", `input “${name}” must be between 0% and 100%.`);
  }
  return value.magnitude;
}

/** Reduce a typed Track2D node to its closed resource/binding configuration. */
export function referenceTrack2DConfig(ir: CutAVIR, node: IRNode): ReferenceTrack2DConfig | undefined {
  if (node.op !== "cut.visual.track_2d") return undefined;
  if (node.domain !== "visual") fail(node, "CUT_TRACK2D_INPUT_TYPE", `must have visual domain, found ${node.domain}.`);
  return {
    nodeId: node.id,
    sourceId: resource(node, ir),
    interpolation: stringChoice(node, "interpolation", ["linear", "hold"] as const, "linear"),
    minConfidence: ratioInput(node, "minConfidence"),
    lowConfidence: stringChoice(node, "lowConfidence", ["fail", "hold", "hide"] as const),
    occluded: stringChoice(node, "occluded", ["fail", "hold", "hide"] as const),
    outOfFrame: stringChoice(node, "outOfFrame", ["fail", "hold", "hide"] as const),
    bindScale: booleanInput(node, "bindScale", false),
    bindRotation: booleanInput(node, "bindRotation", false),
  };
}

/** A tracking sidecar owns its bytes' schema; another kernel may not reinterpret them as generic JSON. */
export function validateReferenceTrack2DResourceOwnership(ir: CutAVIR) {
  const consumers = Object.values(ir.nodes).flatMap((node) => {
    const config = referenceTrack2DConfig(ir, node);
    return config ? [{ node, config }] : [];
  });
  for (const { node, config } of consumers) {
    const conflict = Object.values(ir.nodes).find((candidate) => candidate.op !== "cut.visual.track_2d"
      && Object.values(candidate.inputs).some((value) => referencesResource(value, config.sourceId)));
    if (conflict) fail(node, "CUT_TRACK2D_RESOURCE_CONFLICT", `locked tracking DataAsset ${config.sourceId} is also consumed by ${conflict.op}; declare separate assets for distinct schemas.`);
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

/** Bounded scanner used before JSON.parse so duplicate decoded keys never acquire last-key-wins semantics. */
class TrackJsonScanner {
  private offset = 0;
  private nodes = 0;
  constructor(private readonly node: IRNode, private readonly source: string) {}
  scan() { this.space(); this.value(0); this.space(); if (this.offset !== this.source.length) this.syntax("unexpected trailing input"); }
  private syntax(message: string): never { fail(this.node, "CUT_TRACK2D_JSON", `${message} at byte-text offset ${this.offset}.`); }
  private space() { while (this.offset < this.source.length && /\s/u.test(this.source[this.offset])) this.offset += 1; }
  private value(depth: number) {
    this.nodes += 1;
    if (this.nodes > referenceTrack2DLimits.maxJsonNodes) fail(this.node, "CUT_TRACK2D_LIMIT", `JSON exceeds ${referenceTrack2DLimits.maxJsonNodes} values.`);
    if (depth > referenceTrack2DLimits.maxJsonDepth) fail(this.node, "CUT_TRACK2D_LIMIT", `JSON exceeds depth ${referenceTrack2DLimits.maxJsonDepth}.`);
    this.space(); const character = this.source[this.offset];
    if (character === "{") this.object(depth);
    else if (character === "[") this.array(depth);
    else if (character === '"') this.string();
    else if (this.source.startsWith("true", this.offset)) this.offset += 4;
    else if (this.source.startsWith("false", this.offset)) this.offset += 5;
    else if (this.source.startsWith("null", this.offset)) this.offset += 4;
    else {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.offset));
      if (!match) this.syntax("expected a JSON value");
      this.offset += match[0].length;
    }
  }
  private string() {
    const start = this.offset; this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        try {
          const result = JSON.parse(this.source.slice(start, this.offset)) as string;
          if (hasUnpairedSurrogate(result)) this.syntax("string contains an unpaired Unicode surrogate");
          return result;
        } catch { this.syntax("invalid JSON string"); }
      }
      if (character === "\\") { this.offset += 2; continue; }
      if (character.charCodeAt(0) < 0x20) this.syntax("unescaped control character in string");
      this.offset += 1;
    }
    this.syntax("unterminated JSON string");
  }
  private object(depth: number) {
    this.offset += 1; this.space(); const keys = new Set<string>();
    if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax("expected an object key");
      const key = this.string();
      if (keys.has(key)) fail(this.node, "CUT_TRACK2D_JSON", `duplicate decoded object key ${JSON.stringify(key)} near offset ${this.offset}.`);
      keys.add(key); this.space();
      if (this.source[this.offset] !== ":") this.syntax("expected ':' after object key");
      this.offset += 1; this.value(depth + 1); this.space();
      if (this.source[this.offset] === "}") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or '}'");
      this.offset += 1; this.space();
    }
  }
  private array(depth: number) {
    this.offset += 1; this.space();
    if (this.source[this.offset] === "]") { this.offset += 1; return; }
    while (true) {
      this.value(depth + 1); this.space();
      if (this.source[this.offset] === "]") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or ']'");
      this.offset += 1; this.space();
    }
  }
}

function parseJson(node: IRNode, bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > referenceTrack2DLimits.maxBytes) fail(node, "CUT_TRACK2D_LIMIT", `locked sidecar must contain 1 through ${referenceTrack2DLimits.maxBytes} bytes.`);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail(node, "CUT_TRACK2D_JSON", "locked sidecar is not valid UTF-8."); }
  new TrackJsonScanner(node, source).scan();
  try { return JSON.parse(source) as unknown; }
  catch { fail(node, "CUT_TRACK2D_JSON", "locked sidecar is not valid JSON."); }
}

const integerPattern = /^-?(?:0|[1-9][0-9]*)$/u;
const positiveIntegerPattern = /^(?:0*[1-9][0-9]*)$/u;

function exactRational(node: IRNode, value: unknown, path: string) {
  const record = closedObject(node, value, path, ["numerator", "denominator"]);
  const numerator = record.numerator, denominator = record.denominator;
  if (typeof numerator !== "string" || typeof denominator !== "string" || numerator === "-0"
    || !integerPattern.test(numerator) || !positiveIntegerPattern.test(denominator)
    || numerator.replace("-", "").length > referenceTrack2DLimits.maxRationalDigits
    || denominator.length > referenceTrack2DLimits.maxRationalDigits) {
    fail(node, "CUT_TRACK2D_SCHEMA", `${path} must contain bounded canonical integer strings and a positive denominator.`);
  }
  const result = rational(numerator, denominator);
  if (result.numerator !== numerator || result.denominator !== denominator) fail(node, "CUT_TRACK2D_SCHEMA", `${path} must be reduced to canonical lowest terms.`);
  return result;
}

function safeDimension(node: IRNode, value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > referenceTrack2DLimits.maxCanvasDimension) {
    fail(node, "CUT_TRACK2D_DIMENSIONS", `${path} must be a positive safe integer no greater than ${referenceTrack2DLimits.maxCanvasDimension}.`);
  }
  return Number(value);
}

function boundedRational(node: IRNode, value: Rational, path: string, minimum: Rational, maximum: Rational) {
  if (compareRational(value, minimum) < 0 || compareRational(value, maximum) > 0) fail(node, "CUT_TRACK2D_RANGE", `${path} is outside its declared finite bound.`);
  return value;
}

function optionalExactRational(node: IRNode, record: JsonObject, name: string, path: string) {
  return Object.hasOwn(record, name) ? exactRational(node, record[name], `${path}.${name}`) : undefined;
}

/** Parse and semantically validate one locked cut-track-2d v1 sidecar. */
export function prepareReferenceTrack2D(
  node: IRNode,
  config: ReferenceTrack2DConfig,
  composition: IRComposition,
  bytes: Uint8Array,
): PreparedReferenceTrack2D {
  const root = closedObject(node, parseJson(node, bytes), "$", ["coordinateSpace", "format", "height", "samples", "version", "width"]);
  if (root.format !== "cut-track-2d" || root.version !== 1 || root.coordinateSpace !== "composition-pixels") {
    fail(node, "CUT_TRACK2D_SCHEMA", "$ must declare cut-track-2d v1 in composition-pixels.");
  }
  const width = safeDimension(node, root.width, "$.width"), height = safeDimension(node, root.height, "$.height");
  if (width !== composition.width || height !== composition.height) {
    fail(node, "CUT_TRACK2D_DIMENSIONS", `sidecar canvas ${width}×${height} does not match composition ${composition.width}×${composition.height}.`);
  }
  if (!Array.isArray(root.samples) || root.samples.length < 2 || root.samples.length > referenceTrack2DLimits.maxSamples) {
    fail(node, "CUT_TRACK2D_LIMIT", `$.samples must contain 2 through ${referenceTrack2DLimits.maxSamples} observations.`);
  }
  const coordinateLimit = rational(referenceTrack2DLimits.maxAbsoluteCoordinate);
  const samples = root.samples.map((value, index): ReferenceTrack2DSample => {
    const path = `$.samples[${index}]`;
    const sample = closedObject(node, value, path, ["at", "confidence", "status", "x", "y"], ["rotation", "scale"]);
    const status = sample.status;
    if (status !== "visible" && status !== "occluded" && status !== "out-of-frame") fail(node, "CUT_TRACK2D_SCHEMA", `${path}.status must be visible, occluded, or out-of-frame.`);
    const at = exactRational(node, sample.at, `${path}.at`);
    const x = boundedRational(node, exactRational(node, sample.x, `${path}.x`), `${path}.x`, multiplyRational(coordinateLimit, rational(-1)), coordinateLimit);
    const y = boundedRational(node, exactRational(node, sample.y, `${path}.y`), `${path}.y`, multiplyRational(coordinateLimit, rational(-1)), coordinateLimit);
    const confidence = boundedRational(node, exactRational(node, sample.confidence, `${path}.confidence`), `${path}.confidence`, zeroRational, rational(1));
    const scale = optionalExactRational(node, sample, "scale", path);
    const rotation = optionalExactRational(node, sample, "rotation", path);
    if (scale !== undefined) boundedRational(node, scale, `${path}.scale`, referenceTrack2DLimits.minScale, referenceTrack2DLimits.maxScale);
    if (rotation !== undefined) boundedRational(node, rotation, `${path}.rotation`, multiplyRational(referenceTrack2DLimits.maxAbsoluteRotationDegrees, rational(-1)), referenceTrack2DLimits.maxAbsoluteRotationDegrees);
    if (status === "visible" && (compareRational(x, zeroRational) < 0 || compareRational(x, rational(width - 1)) > 0 || compareRational(y, zeroRational) < 0 || compareRational(y, rational(height - 1)) > 0)) {
      fail(node, "CUT_TRACK2D_RANGE", `${path} is visible but its position is outside the declared composition; use status “out-of-frame”.`);
    }
    if (config.bindScale && status === "visible" && scale === undefined) fail(node, "CUT_TRACK2D_BINDING", `${path}.scale is required because bindScale is true.`);
    if (config.bindRotation && status === "visible" && rotation === undefined) fail(node, "CUT_TRACK2D_BINDING", `${path}.rotation is required because bindRotation is true.`);
    return { at, x, y, ...(scale === undefined ? {} : { scale }), ...(rotation === undefined ? {} : { rotation }), confidence, status };
  });
  for (let index = 1; index < samples.length; index += 1) {
    if (compareRational(samples[index - 1].at, samples[index].at) >= 0) fail(node, "CUT_TRACK2D_TIME", `$.samples[${index}].at must be strictly later than the previous exact time.`);
  }
  if (compareRational(samples[0].at, zeroRational) !== 0 || compareRational(samples.at(-1)!.at, node.interval.duration) !== 0) {
    fail(node, "CUT_TRACK2D_TIME", "samples must cover the complete node-local half-open clock with exact observations at 0s and at the node duration.");
  }
  return { format: "cut-track-2d", version: 1, coordinateSpace: "composition-pixels", width, height, samples };
}

function usable(sample: ReferenceTrack2DSample, config: ReferenceTrack2DConfig) {
  return sample.status === "visible" && compareRational(sample.confidence, config.minConfidence) >= 0;
}

function reason(sample: ReferenceTrack2DSample, config: ReferenceTrack2DConfig) {
  if (sample.status === "occluded") return { name: "occluded", policy: config.occluded } as const;
  if (sample.status === "out-of-frame") return { name: "out-of-frame", policy: config.outOfFrame } as const;
  return { name: "below the confidence threshold", policy: config.lowConfidence } as const;
}

function sampleTransform(sample: ReferenceTrack2DSample, config: ReferenceTrack2DConfig) {
  return {
    x: sample.x,
    y: sample.y,
    scale: config.bindScale ? sample.scale! : rational(1),
    rotation: config.bindRotation ? sample.rotation! : zeroRational,
  };
}

function resolveObservation(node: IRNode, track: PreparedReferenceTrack2D, config: ReferenceTrack2DConfig, index: number, time: Rational) {
  const sample = track.samples[index];
  if (usable(sample, config)) return { kind: "visible" as const, value: sampleTransform(sample, config) };
  const issue = reason(sample, config);
  if (issue.policy === "hide") return { kind: "hidden" as const };
  if (issue.policy === "fail") fail(node, "CUT_TRACK2D_SAMPLE", `sample at ${sample.at.numerator}/${sample.at.denominator}s is ${issue.name} at evaluated time ${time.numerator}/${time.denominator}s and policy is fail.`);
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (usable(track.samples[previous], config)) return { kind: "held" as const, value: sampleTransform(track.samples[previous], config) };
  }
  fail(node, "CUT_TRACK2D_HOLD_EMPTY", `sample at ${sample.at.numerator}/${sample.at.denominator}s requests hold for ${issue.name}, but no earlier visible sample meets minConfidence.`);
}

function interpolate(left: Rational, right: Rational, progress: Rational) {
  return addRational(left, multiplyRational(subtractRational(right, left), progress));
}

/** Sample the sidecar at an exact node-local source clock and return the retained transform binding. */
export function referenceTrack2DAt(
  node: IRNode,
  track: PreparedReferenceTrack2D,
  config: ReferenceTrack2DConfig,
  localTime: Rational,
): ReferenceTrack2DTransform {
  if (compareRational(localTime, zeroRational) < 0 || compareRational(localTime, node.interval.duration) > 0) {
    fail(node, "CUT_TRACK2D_TIME", `evaluated local time ${localTime.numerator}/${localTime.denominator}s is outside the node clock.`);
  }
  let low = 0, high = track.samples.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), compared = compareRational(track.samples[middle].at, localTime);
    if (compared === 0) {
      const resolved = resolveObservation(node, track, config, middle, localTime);
      if (resolved.kind === "hidden") return { x: 0, y: 0, scale: 1, rotation: 0, hidden: true };
      return {
        x: rationalToNumber(subtractRational(resolved.value.x, rational(track.width, 2))),
        y: rationalToNumber(subtractRational(resolved.value.y, rational(track.height, 2))),
        scale: rationalToNumber(resolved.value.scale),
        rotation: rationalToNumber(resolved.value.rotation),
        hidden: false,
      };
    }
    if (compared < 0) low = middle + 1; else high = middle - 1;
  }
  const leftIndex = Math.max(0, high), rightIndex = Math.min(track.samples.length - 1, low);
  const left = resolveObservation(node, track, config, leftIndex, localTime);
  if (left.kind === "hidden") return { x: 0, y: 0, scale: 1, rotation: 0, hidden: true };
  let value = left.value;
  if (config.interpolation === "linear" && left.kind === "visible" && rightIndex !== leftIndex && usable(track.samples[rightIndex], config)) {
    const right = sampleTransform(track.samples[rightIndex], config);
    const progress = divideRational(subtractRational(localTime, track.samples[leftIndex].at), subtractRational(track.samples[rightIndex].at, track.samples[leftIndex].at));
    value = {
      x: interpolate(value.x, right.x, progress),
      y: interpolate(value.y, right.y, progress),
      scale: interpolate(value.scale, right.scale, progress),
      rotation: interpolate(value.rotation, right.rotation, progress),
    };
  }
  return {
    x: rationalToNumber(subtractRational(value.x, rational(track.width, 2))),
    y: rationalToNumber(subtractRational(value.y, rational(track.height, 2))),
    scale: rationalToNumber(value.scale),
    rotation: rationalToNumber(value.rotation),
    hidden: false,
  };
}

/**
 * Derive the complete retained-source placement for a validated direct
 * LocalSpace child without opening, rasterizing, or compositing that child.
 *
 * Neutral authored controls map local authored point `(0,0)` to the exact
 * sampled tracking observation. The LocalSpace origin is only the raster
 * registration point; it never introduces a delivery-half translation.
 */
export function referenceTrack2DLocalSpacePlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  track: PreparedReferenceTrack2D,
  config: ReferenceTrack2DConfig,
  localSpace: ReferenceLocalSpaceConfig,
  time: Rational,
  resolver?: ReferencePreparedSignalResolver,
): ReferenceTrack2DLocalSpacePlan {
  if (node.op !== "cut.visual.track_2d"
    || config.nodeId !== node.id
    || localSpace.owner !== "track-2d"
    || localSpace.ownerNodeId !== node.id
    || node.children.length !== 1
    || node.children[0] !== localSpace.nodeId) {
    throw new ReferenceLocalSpaceError(
      "CUT_LOCAL_SPACE_GRAPH",
      ir.nodes[localSpace.nodeId] ?? node,
      "Track2D retained-source planning requires exactly one directly owned validated LocalSpace child.",
    );
  }
  const localTime = subtractRational(time, node.interval.start);
  const tracked = referenceTrack2DAt(node, track, config, localTime);
  const rasterRegistration = referenceLocalSpaceRasterOrigin(localSpace);
  const sourceSpace = Object.freeze({
    width: localSpace.width,
    height: localSpace.height,
    authoredView: localSpace.view,
    rasterRegistration,
    semanticIdentity: localSpace.semanticIdentity,
  });
  if (tracked.hidden) {
    const skip = Object.freeze({
      classification: "tracking-policy-hidden" as const,
      reason: "track-sample-hidden" as const,
      executionEvidence: Object.freeze({
        skipKind: "owner-policy" as const,
        skipReason: "tracking-policy-hidden" as const,
        counter: "ownerPolicySkips" as const,
      }),
    });
    const work = noRasterTrack2DLocalSpaceWork(localSpace, "tracking-policy-hidden-no-raster");
    const cacheIdentity = hash({
      kind: "track-2d-local-space-plan",
      localSpaceSemanticIdentity: localSpace.semanticIdentity,
      sourceResource: lockedTrack2DResourceIdentity(ir, config.sourceId),
      exactTime: `${time.numerator}/${time.denominator}`,
      exactNodeLocalTime: `${localTime.numerator}/${localTime.denominator}`,
      hidden: true,
      skip,
      work,
      rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
    });
    return Object.freeze({
      nodeId: node.id,
      localSpaceNodeId: localSpace.nodeId,
      exactTime: Object.freeze({ ...time }),
      exactNodeLocalTime: Object.freeze({ ...localTime }),
      hidden: true,
      sourceSpace,
      skip,
      work,
      rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
      cacheIdentity,
    });
  }

  // Track2D's closed public transform surface is x/y, uniform scale,
  // rotation, and opacity. It intentionally has no anchor or skew arguments,
  // so local zero is the sole registration basis.
  const authored = referenceVisualTransformAt(
    ir,
    composition,
    node,
    time,
    { staticPosition: true, staticRotation: true },
    resolver,
  );
  const observedCompositionPoint = Object.freeze({
    x: composition.width / 2 + tracked.x,
    y: composition.height / 2 + tracked.y,
  });
  const destinationRegistration = Object.freeze({
    x: observedCompositionPoint.x + authored.x,
    y: observedCompositionPoint.y + authored.y,
  });
  const scale = authored.scale * tracked.scale;
  if (authored.opacity === 0) {
    const rotation = canonicalReferenceLocalSpaceRotationDegrees(authored.rotation + tracked.rotation);
    const skip = Object.freeze({
      classification: "owner-opacity" as const,
      reason: "opacity-zero" as const,
      executionEvidence: Object.freeze({
        skipKind: "owner-opacity" as const,
        skipReason: "opacity-zero" as const,
        counter: "ownerOpacitySkips" as const,
      }),
    });
    const work = noRasterTrack2DLocalSpaceWork(localSpace, "owner-opacity-no-raster");
    const cacheIdentity = hash({
      kind: "track-2d-local-space-plan",
      localSpaceSemanticIdentity: localSpace.semanticIdentity,
      sourceResource: lockedTrack2DResourceIdentity(ir, config.sourceId),
      exactTime: `${time.numerator}/${time.denominator}`,
      exactNodeLocalTime: `${localTime.numerator}/${localTime.denominator}`,
      hidden: false,
      skip,
      work,
      rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
    });
    return Object.freeze({
      nodeId: node.id,
      localSpaceNodeId: localSpace.nodeId,
      exactTime: Object.freeze({ ...time }),
      exactNodeLocalTime: Object.freeze({ ...localTime }),
      hidden: false,
      sourceSpace,
      observedCompositionPoint,
      destinationRegistration,
      scale,
      rotation,
      opacity: 0,
      skip,
      work,
      rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
      cacheIdentity,
    });
  }
  const work = planReferenceLocalSpaceTileTransformWork(node, {
    source: Object.freeze({ width: localSpace.width, height: localSpace.height }),
    destination: Object.freeze({ width: composition.width, height: composition.height }),
    scale,
    rotation: authored.rotation + tracked.rotation,
    opacity: authored.opacity,
  });
  // The shared allocation contract is also the canonical renderer handoff:
  // exact full turns must not retain distinct trig or cache identities.
  const rotation = work.rotation.canonicalDegrees;
  const effectiveRasterScale = work.sharpCover.scale;
  const radians = rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const localToComposition = referenceAffine2D({
    a: cosine * effectiveRasterScale,
    b: sine * effectiveRasterScale,
    c: -sine * effectiveRasterScale,
    d: cosine * effectiveRasterScale,
    tx: destinationRegistration.x,
    ty: destinationRegistration.y,
  });
  const authoredProjectedSourceBounds = transformReferenceRect(referenceRect(
    rationalToNumber(localSpace.view.minX),
    rationalToNumber(localSpace.view.minY),
    rationalToNumber(localSpace.view.maxX),
    rationalToNumber(localSpace.view.maxY),
  ), localToComposition);
  const rasterProjectedSourceBounds = transformReferenceRect(referenceRect(
    -rasterRegistration.x,
    -rasterRegistration.y,
    localSpace.width - rasterRegistration.x,
    localSpace.height - rasterRegistration.y,
  ), localToComposition);
  const cacheIdentity = hash({
    kind: "track-2d-local-space-plan",
    localSpaceSemanticIdentity: localSpace.semanticIdentity,
    sourceResource: lockedTrack2DResourceIdentity(ir, config.sourceId),
    exactTime: `${time.numerator}/${time.denominator}`,
    exactNodeLocalTime: `${localTime.numerator}/${localTime.denominator}`,
    observedCompositionPoint,
    destinationRegistration,
    localToComposition,
    effectiveRasterScale,
    rasterProjectedSourceBounds,
    opacity: authored.opacity,
    work,
    rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
  });
  return Object.freeze({
    nodeId: node.id,
    localSpaceNodeId: localSpace.nodeId,
    exactTime: Object.freeze({ ...time }),
    exactNodeLocalTime: Object.freeze({ ...localTime }),
    hidden: false,
    sourceSpace,
    observedCompositionPoint,
    destinationRegistration,
    localToComposition,
    authoredProjectedSourceBounds,
    rasterProjectedSourceBounds,
    scale,
    rotation,
    opacity: authored.opacity,
    work,
    rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
    cacheIdentity,
  });
}
