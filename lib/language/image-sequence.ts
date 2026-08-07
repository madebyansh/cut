import { hash } from "../core/stable";
import { parseStrictPackageJson } from "../package/json";
import { validateProjectLocator } from "../project/manifest";
import type { CutImageProbe } from "../project/probe";
import type { CutAVIR, IRNode, IRResource, IRValue } from "./ir";
import {
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  type Rational,
  zeroRational,
} from "./rational";

export const cutImageSequenceLimits = Object.freeze({
  maximumManifestBytes: 1024 * 1024,
  maximumFrames: 4_096,
  maximumDimension: 32_768,
  maximumFramePixels: 100_000_000,
  maximumFrameRate: 240,
  maximumDurationSeconds: 24 * 60 * 60,
});

export type CutImageSequenceManifestFrameV1 = Readonly<{
  resourceId: string;
  locator: string;
  sha256: string;
}>;

export type CutImageSequenceManifestV1 = Readonly<{
  format: "cut-image-sequence-manifest";
  version: 1;
  width: number;
  height: number;
  frameRate: Rational;
  frameCount: number;
  frames: readonly CutImageSequenceManifestFrameV1[];
}>;

export type CutImageSequenceSourceV1 = Readonly<{
  format: "cut-image-sequence-source";
  version: 1;
  manifestResourceId: string;
  frameResourceIds: readonly string[];
  width: number;
  height: number;
  frameRate: Rational;
  frameCount: number;
  duration: Rational;
  sourceIdentity: string;
}>;

export type CutImageSequenceLockedResource = Readonly<{
  id: string;
  kind: IRResource["kind"];
  locator: string;
  sha256: string;
  bytes: number;
  probe: unknown;
}>;

export type CutImageSequenceErrorCode =
  | "CUT_IMAGE_SEQUENCE_SOURCE"
  | "CUT_IMAGE_SEQUENCE_MANIFEST"
  | "CUT_IMAGE_SEQUENCE_LIMIT"
  | "CUT_IMAGE_SEQUENCE_RESOURCE"
  | "CUT_IMAGE_SEQUENCE_IDENTITY"
  | "CUT_IMAGE_SEQUENCE_TIME_GRID";

export class CutImageSequenceError extends Error {
  readonly source?: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(
    readonly code: CutImageSequenceErrorCode,
    readonly path: string,
    message: string,
    node?: IRNode,
    options: ErrorOptions = {},
  ) {
    super(`${code} at ${path}: ${message}`, options);
    this.name = "CutImageSequenceError";
    if (node) {
      this.source = Object.freeze({
        module: node.provenance.module,
        line: node.provenance.span.start.line,
        column: node.provenance.span.start.column,
        nodeId: node.id,
      });
    }
  }
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const safeIdPattern = /^[A-Za-z_][A-Za-z0-9_.:-]*$/u;

function record(value: unknown, path: string, code: CutImageSequenceErrorCode, node?: IRNode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CutImageSequenceError(code, path, "must be one plain object.", node);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CutImageSequenceError(code, path, "must be one plain object.", node);
  }
  return value as Record<string, unknown>;
}

function closed(
  value: unknown,
  path: string,
  required: readonly string[],
  code: CutImageSequenceErrorCode,
  node?: IRNode,
) {
  const object = record(value, path, code, node);
  const expected = [...required].sort();
  const actual = Object.keys(object).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new CutImageSequenceError(code, path, `must contain exactly ${required.join(", ")}.`, node);
  }
  return object;
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number, node?: IRNode) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      path,
      `must be a safe integer from ${minimum} through ${maximum}.`,
      node,
    );
  }
  return Number(value);
}

function canonicalRational(value: unknown, path: string, node?: IRNode) {
  const object = closed(value, path, ["numerator", "denominator"], "CUT_IMAGE_SEQUENCE_MANIFEST", node);
  if (typeof object.numerator !== "string" || typeof object.denominator !== "string"
    || !/^-?(?:0|[1-9]\d*)$/u.test(object.numerator)
    || !/^[1-9]\d*$/u.test(object.denominator)
    || object.numerator.length > 256 || object.denominator.length > 256) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", path, "must be one canonical exact rational.", node);
  }
  let exact: Rational;
  try { exact = rational(object.numerator, object.denominator); }
  catch (error) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", path, "must be one canonical exact rational.", node, { cause: error });
  }
  if (exact.numerator !== object.numerator || exact.denominator !== object.denominator) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", path, "must be reduced and canonical.", node);
  }
  return exact;
}

function scalarInteger(value: IRValue | undefined, path: string, minimum: number, maximum: number, node: IRNode) {
  if (value?.kind !== "quantity" || value.dimension !== "scalar" || value.unit !== "scalar"
    || value.magnitude.denominator !== "1") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_SOURCE", path, "must be one exact whole scalar.", node);
  }
  const integer = BigInt(value.magnitude.numerator);
  if (integer < BigInt(minimum) || integer > BigInt(maximum)) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_LIMIT", path, `must be from ${minimum} through ${maximum}.`, node);
  }
  return Number(integer);
}

function pixelLength(value: IRValue | undefined, path: string, node: IRNode) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px"
    || value.magnitude.denominator !== "1") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_SOURCE", path, "must be one exact whole-pixel Length.", node);
  }
  const integer = BigInt(value.magnitude.numerator);
  if (integer < 1n || integer > BigInt(cutImageSequenceLimits.maximumDimension)) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      path,
      `must be from 1px through ${cutImageSequenceLimits.maximumDimension}px.`,
      node,
    );
  }
  return Number(integer);
}

function scalarRational(value: IRValue | undefined, path: string, node: IRNode) {
  if (value?.kind !== "quantity" || value.dimension !== "scalar" || value.unit !== "scalar") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_SOURCE", path, "must be one exact scalar cadence.", node);
  }
  const frameRate = rational(value.magnitude.numerator, value.magnitude.denominator);
  if (compareRational(frameRate, zeroRational) <= 0
    || compareRational(frameRate, rational(cutImageSequenceLimits.maximumFrameRate)) > 0) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      path,
      `must be positive and no greater than ${cutImageSequenceLimits.maximumFrameRate}fps.`,
      node,
    );
  }
  return frameRate;
}

function stringEntry(entries: Record<string, IRValue>, name: string, expected: string, path: string, node: IRNode) {
  const value = entries[name];
  if (value?.kind !== "string" || value.value !== expected) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_SOURCE", `${path}.${name}`, `must equal ${JSON.stringify(expected)}.`, node);
  }
}

/** Decode the compiler-authenticated, closed ImageSequenceAsset IR value. */
export function cutImageSequenceSourceFromIr(ir: CutAVIR, node: IRNode, value = node.inputs.source): CutImageSequenceSourceV1 {
  const path = `$.nodes.${node.id}.inputs.source`;
  if (value?.kind !== "object") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_SOURCE", path, "must be one compiler-authenticated ImageSequenceAsset object.", node);
  }
  const names = ["format", "version", "manifest", "frames", "width", "height", "frameRate", "frameCount"];
  const keys = Object.keys(value.entries).sort();
  if (keys.length !== names.length || [...names].sort().some((name, index) => name !== keys[index])) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_SOURCE", path, `must contain exactly ${names.join(", ")}.`, node);
  }
  stringEntry(value.entries, "format", "cut-image-sequence-source", path, node);
  const version = scalarInteger(value.entries.version, `${path}.version`, 1, 1, node);
  if (version !== 1) throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_SOURCE", `${path}.version`, "must equal 1.", node);
  const manifest = value.entries.manifest;
  if (manifest?.kind !== "resource-ref") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_SOURCE", `${path}.manifest`, "must reference one declared DataAsset manifest.", node);
  }
  const manifestResource = ir.resources[manifest.id];
  if (!manifestResource || manifestResource.kind !== "data") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_RESOURCE", `${path}.manifest`, "must reference one declared DataAsset manifest.", node);
  }
  const frames = value.entries.frames;
  if (frames?.kind !== "array" || frames.items.length < 1 || frames.items.length > cutImageSequenceLimits.maximumFrames) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      `${path}.frames`,
      `must contain 1 through ${cutImageSequenceLimits.maximumFrames} explicit ImageAsset references.`,
      node,
    );
  }
  const frameResourceIds = frames.items.map((frame, index) => {
    if (frame.kind !== "resource-ref" || ir.resources[frame.id]?.kind !== "image") {
      throw new CutImageSequenceError(
        "CUT_IMAGE_SEQUENCE_RESOURCE",
        `${path}.frames[${index}]`,
        "must reference one declared ImageAsset.",
        node,
      );
    }
    return frame.id;
  });
  if (new Set(frameResourceIds).size !== frameResourceIds.length) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_IDENTITY",
      `${path}.frames`,
      "cannot contain duplicate ImageAsset resource IDs; hold/repeat behavior must be authored temporally, not by aliasing sequence membership.",
      node,
    );
  }
  const width = pixelLength(value.entries.width, `${path}.width`, node);
  const height = pixelLength(value.entries.height, `${path}.height`, node);
  if (width * height > cutImageSequenceLimits.maximumFramePixels) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      path,
      `declared frame pixels exceed ${cutImageSequenceLimits.maximumFramePixels}.`,
      node,
    );
  }
  const frameRate = scalarRational(value.entries.frameRate, `${path}.frameRate`, node);
  const frameCount = scalarInteger(value.entries.frameCount, `${path}.frameCount`, 1, cutImageSequenceLimits.maximumFrames, node);
  if (frameCount !== frameResourceIds.length) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_IDENTITY",
      `${path}.frameCount`,
      `declares ${frameCount}, but frames contains ${frameResourceIds.length} members.`,
      node,
    );
  }
  const duration = divideRational(rational(frameCount), frameRate);
  if (compareRational(duration, rational(cutImageSequenceLimits.maximumDurationSeconds)) > 0) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      path,
      `sequence duration exceeds ${cutImageSequenceLimits.maximumDurationSeconds} seconds.`,
      node,
    );
  }
  const sourceIdentity = hash({
    format: "cut-image-sequence-source",
    version: 1,
    manifestResourceId: manifest.id,
    frameResourceIds,
    width,
    height,
    frameRate,
    frameCount,
  });
  return Object.freeze({
    format: "cut-image-sequence-source",
    version: 1,
    manifestResourceId: manifest.id,
    frameResourceIds: Object.freeze(frameResourceIds),
    width,
    height,
    frameRate,
    frameCount,
    duration,
    sourceIdentity,
  });
}

export function cutImageSequenceSources(ir: CutAVIR) {
  return Object.values(ir.nodes)
    .filter((node) => node.op === "cut.visual.image_sequence")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => Object.freeze({ node, source: cutImageSequenceSourceFromIr(ir, node) }));
}

/** Strict, duplicate-key-refusing manifest parser. */
export function parseCutImageSequenceManifest(bytes: Uint8Array): CutImageSequenceManifestV1 {
  if (bytes.byteLength < 1 || bytes.byteLength > cutImageSequenceLimits.maximumManifestBytes) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      "$",
      `manifest must contain 1 through ${cutImageSequenceLimits.maximumManifestBytes} bytes; found ${bytes.byteLength}.`,
    );
  }
  let decoded: unknown;
  try {
    decoded = parseStrictPackageJson(bytes, {
      limits: {
        maxInputBytes: cutImageSequenceLimits.maximumManifestBytes,
        maxDepth: 8,
        maxNodes: cutImageSequenceLimits.maximumFrames * 8 + 32,
        maxStringBytes: 4_096,
        maxTotalStringBytes: 512 * 1024,
      },
    });
  } catch (error) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_MANIFEST",
      "$",
      `is not bounded strict JSON (${error instanceof Error ? error.message : String(error)}).`,
      undefined,
      { cause: error },
    );
  }
  const root = closed(decoded, "$", ["format", "version", "width", "height", "frameRate", "frameCount", "frames"], "CUT_IMAGE_SEQUENCE_MANIFEST");
  if (root.format !== "cut-image-sequence-manifest") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", "$.format", "must equal cut-image-sequence-manifest.");
  }
  if (root.version !== 1) throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", "$.version", "must equal 1.");
  const width = safeInteger(root.width, "$.width", 1, cutImageSequenceLimits.maximumDimension);
  const height = safeInteger(root.height, "$.height", 1, cutImageSequenceLimits.maximumDimension);
  if (width * height > cutImageSequenceLimits.maximumFramePixels) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_LIMIT", "$", `frame pixels exceed ${cutImageSequenceLimits.maximumFramePixels}.`);
  }
  const frameRate = canonicalRational(root.frameRate, "$.frameRate");
  if (compareRational(frameRate, zeroRational) <= 0
    || compareRational(frameRate, rational(cutImageSequenceLimits.maximumFrameRate)) > 0) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      "$.frameRate",
      `must be positive and no greater than ${cutImageSequenceLimits.maximumFrameRate}fps.`,
    );
  }
  const frameCount = safeInteger(root.frameCount, "$.frameCount", 1, cutImageSequenceLimits.maximumFrames);
  if (!Array.isArray(root.frames) || root.frames.length !== frameCount) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_IDENTITY",
      "$.frames",
      `must contain exactly frameCount (${frameCount}) members.`,
    );
  }
  const seenResourceIds = new Set<string>();
  const seenLocators = new Set<string>();
  const frames = root.frames.map((candidate, index) => {
    const path = `$.frames[${index}]`;
    const frame = closed(candidate, path, ["resourceId", "locator", "sha256"], "CUT_IMAGE_SEQUENCE_MANIFEST");
    if (typeof frame.resourceId !== "string" || !safeIdPattern.test(frame.resourceId) || frame.resourceId.length > 512) {
      throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", `${path}.resourceId`, "must be one bounded canonical CUT resource ID.");
    }
    if (seenResourceIds.has(frame.resourceId)) {
      throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_IDENTITY", `${path}.resourceId`, `duplicates ${JSON.stringify(frame.resourceId)}.`);
    }
    if (typeof frame.locator !== "string") {
      throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", `${path}.locator`, "must be one project-local locator.");
    }
    let locator: string;
    try { locator = validateProjectLocator(frame.locator, `${path}.locator`); }
    catch (error) {
      throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", `${path}.locator`, error instanceof Error ? error.message : String(error), undefined, { cause: error });
    }
    if (seenLocators.has(locator)) {
      throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_IDENTITY", `${path}.locator`, `duplicates ${JSON.stringify(locator)}.`);
    }
    if (typeof frame.sha256 !== "string" || !sha256Pattern.test(frame.sha256)) {
      throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_MANIFEST", `${path}.sha256`, "must be one lowercase SHA-256 digest.");
    }
    seenResourceIds.add(frame.resourceId);
    seenLocators.add(locator);
    return Object.freeze({ resourceId: frame.resourceId, locator, sha256: frame.sha256 });
  });
  const duration = divideRational(rational(frameCount), frameRate);
  if (compareRational(duration, rational(cutImageSequenceLimits.maximumDurationSeconds)) > 0) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_LIMIT", "$", `sequence duration exceeds ${cutImageSequenceLimits.maximumDurationSeconds} seconds.`);
  }
  return Object.freeze({
    format: "cut-image-sequence-manifest",
    version: 1,
    width,
    height,
    frameRate,
    frameCount,
    frames: Object.freeze(frames),
  });
}

function imageProbe(resource: CutImageSequenceLockedResource, path: string, node: IRNode): CutImageProbe {
  const probe = resource.probe as { kind?: unknown; identity?: unknown };
  if (probe?.kind !== "image" || !probe.identity || typeof probe.identity !== "object") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_RESOURCE", path, "must carry one locked image probe.", node);
  }
  return probe.identity as CutImageProbe;
}

/**
 * Bind parsed manifest bytes to the exact ordered IR resources and their
 * independently locked image probes. This runs before any sequence pixel is
 * allocated and is repeated by lock application/runtime preparation.
 */
export function validateCutImageSequenceManifestBinding(
  ir: CutAVIR,
  node: IRNode,
  source: CutImageSequenceSourceV1,
  manifest: CutImageSequenceManifestV1,
  resources: Readonly<Record<string, CutImageSequenceLockedResource>>,
) {
  const path = `$.nodes.${node.id}.inputs.source`;
  if (manifest.width !== source.width || manifest.height !== source.height
    || compareRational(manifest.frameRate, source.frameRate) !== 0
    || manifest.frameCount !== source.frameCount) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_IDENTITY",
      path,
      "manifest dimensions, exact cadence, or frame count does not match the compiler-authenticated ImageSequenceAsset declaration.",
      node,
    );
  }
  const manifestResource = resources[source.manifestResourceId];
  if (!manifestResource || manifestResource.kind !== "data") {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_RESOURCE", `${path}.manifest`, "has no locked DataAsset resource.", node);
  }
  source.frameResourceIds.forEach((resourceId, index) => {
    const memberPath = `${path}.frames[${index}]`;
    const member = resources[resourceId], declared = ir.resources[resourceId], expected = manifest.frames[index];
    if (!member || member.kind !== "image" || !declared || declared.kind !== "image") {
      throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_RESOURCE", memberPath, `has no locked ImageAsset resource ${JSON.stringify(resourceId)}.`, node);
    }
    if (!expected || expected.resourceId !== resourceId || expected.locator !== declared.locator
      || expected.locator !== member.locator || expected.sha256 !== member.sha256) {
      throw new CutImageSequenceError(
        "CUT_IMAGE_SEQUENCE_IDENTITY",
        memberPath,
        "manifest member resource ID, locator, SHA-256, or source order does not match the exact locked ImageAsset.",
        node,
      );
    }
    const probe = imageProbe(member, memberPath, node);
    if (probe.image.width !== source.width || probe.image.height !== source.height) {
      throw new CutImageSequenceError(
        "CUT_IMAGE_SEQUENCE_RESOURCE",
        memberPath,
        `decodes as ${probe.image.width}x${probe.image.height}, expected ${source.width}x${source.height}.`,
        node,
      );
    }
  });
  return Object.freeze({
    sourceIdentity: source.sourceIdentity,
    manifestIdentity: hash(manifest),
    lockedIdentity: hash({
      source: source.sourceIdentity,
      manifest: manifestResource.sha256,
      members: source.frameResourceIds.map((id) => ({ id, sha256: resources[id]!.sha256 })),
    }),
  });
}

/** Select the exact manifest member for one source time using floor sampling. */
export function cutImageSequenceFrameAt(source: CutImageSequenceSourceV1, sourceTime: Rational) {
  if (compareRational(sourceTime, zeroRational) < 0 || compareRational(sourceTime, source.duration) >= 0) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_TIME_GRID", "$.sourceTime", "is outside the half-open sequence duration.");
  }
  const position = multiplyRational(sourceTime, source.frameRate);
  const numerator = BigInt(position.numerator), denominator = BigInt(position.denominator);
  const frame = Number(numerator / denominator);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= source.frameCount) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_TIME_GRID", "$.sourceTime", "does not select one bounded manifest member.");
  }
  return Object.freeze({ frame, resourceId: source.frameResourceIds[frame]! });
}
