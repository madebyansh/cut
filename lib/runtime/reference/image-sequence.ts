import { hash } from "../../core/stable";
import {
  CutImageSequenceError,
  cutImageSequenceFrameAt,
  cutImageSequenceSourceFromIr,
  parseCutImageSequenceManifest,
  validateCutImageSequenceManifestBinding,
  type CutImageSequenceLockedResource,
  type CutImageSequenceSourceV1,
} from "../../language/image-sequence";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import { referenceNormalizedCrop, type ReferenceNormalizedCrop } from "./shape-config";

export const referenceImageSequenceContract = Object.freeze({
  format: "cut-reference-image-sequence",
  version: 1,
  frameSelection: "floor-source-time" as const,
  membership: "explicit-ordered-locked-resources" as const,
  manifest: "strict-json-v1" as const,
  directVisualOnly: true,
  cacheIdentity: "prepared-config-plus-selected-member-bytes" as const,
});

export type ReferenceImageSequenceConfig = Readonly<{
  nodeId: string;
  source: CutImageSequenceSourceV1;
  sourceStart: Rational;
  sourceEnd: Rational;
  sourceDuration: Rational;
  fit: "cover" | "contain" | "fill";
  crop?: ReferenceNormalizedCrop;
  loop: boolean;
  endBehavior: "error" | "hold";
  configIdentity: string;
}>;

export type PreparedReferenceImageSequence = ReferenceImageSequenceConfig & Readonly<{
  manifestIdentity: string;
  lockedIdentity: string;
  preparedIdentity: string;
  memberSha256: Readonly<Record<string, string>>;
}>;

export type ReferenceImageSequenceSelection = Readonly<{
  frame: number;
  resourceId: string;
  sourceTime: Rational;
  memberSha256: string;
  cacheIdentity: string;
}>;

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(
  node: IRNode,
  code: "CUT_IMAGE_SEQUENCE_SOURCE" | "CUT_IMAGE_SEQUENCE_TIME_GRID",
  path: string,
  message: string,
): never {
  throw new CutImageSequenceError(code, path, `ImageSequence at ${location(node)} ${message}`, node);
}

function exactTime(node: IRNode, value: IRValue, path: string) {
  if (value.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    fail(node, "CUT_IMAGE_SEQUENCE_SOURCE", path, "must be one exact Time quantity in seconds.");
  }
  return rational(value.magnitude.numerator, value.magnitude.denominator);
}

function stringInput<T extends string>(node: IRNode, name: string, values: readonly T[], fallback: T): T {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "string" || !values.includes(value.value as T)) {
    fail(node, "CUT_IMAGE_SEQUENCE_SOURCE", `$.nodes.${node.id}.inputs.${name}`, `must be one of ${values.join(", ")}.`);
  }
  return value.value as T;
}

function booleanInput(node: IRNode, name: string, fallback: boolean) {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "boolean") {
    fail(node, "CUT_IMAGE_SEQUENCE_SOURCE", `$.nodes.${node.id}.inputs.${name}`, "must be Boolean.");
  }
  return value.value;
}

function sourceRange(node: IRNode, source: CutImageSequenceSourceV1) {
  const path = `$.nodes.${node.id}.inputs.range`;
  const value = node.inputs.range;
  if (value === undefined) return Object.freeze({ start: zeroRational, end: source.duration, explicit: false });
  if (value.kind !== "range" || !value.exclusive) {
    fail(node, "CUT_IMAGE_SEQUENCE_SOURCE", path, "must use one half-open Range<Time> (start ..< end).");
  }
  const start = exactTime(node, value.start, `${path}.start`);
  const end = exactTime(node, value.end, `${path}.end`);
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0
    || compareRational(end, source.duration) > 0) {
    fail(node, "CUT_IMAGE_SEQUENCE_SOURCE", path, "must be non-empty, non-negative, and within the exact sequence duration.");
  }
  for (const [name, time] of [["start", start], ["end", end]] as const) {
    if (multiplyRational(time, source.frameRate).denominator !== "1") {
      fail(
        node,
        "CUT_IMAGE_SEQUENCE_TIME_GRID",
        `${path}.${name}`,
        `does not land on the ${source.frameRate.numerator}/${source.frameRate.denominator} fps source frame grid.`,
      );
    }
  }
  return Object.freeze({ start, end, explicit: true });
}

/** Validate the direct ImageSequence node before any manifest bytes or pixels are touched. */
export function referenceImageSequenceConfig(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceImageSequenceConfig | undefined {
  if (node.op !== "cut.visual.image_sequence") return undefined;
  if (node.children.length !== 0) {
    fail(node, "CUT_IMAGE_SEQUENCE_SOURCE", `$.nodes.${node.id}.children`, "must be one childless direct visual leaf.");
  }
  const source = cutImageSequenceSourceFromIr(ir, node);
  const range = sourceRange(node, source);
  const fit = stringInput(node, "fit", ["cover", "contain", "fill"] as const, "cover");
  const crop = referenceNormalizedCrop(node, node.inputs.crop);
  const loop = booleanInput(node, "loop", false);
  const endBehavior = stringInput(node, "endBehavior", ["error", "hold"] as const, "error");
  if (loop && range.explicit) {
    fail(node, "CUT_IMAGE_SEQUENCE_SOURCE", `$.nodes.${node.id}.inputs`, "cannot combine loop: true with an explicit range in v1.");
  }
  if (loop && node.inputs.endBehavior !== undefined) {
    fail(node, "CUT_IMAGE_SEQUENCE_SOURCE", `$.nodes.${node.id}.inputs`, "cannot combine loop: true with endBehavior.");
  }
  for (const [name, value, positive] of [
    ["destination start", node.interval.start, false],
    ["destination duration", node.interval.duration, true],
  ] as const) {
    if ((positive ? compareRational(value, zeroRational) <= 0 : compareRational(value, zeroRational) < 0)
      || multiplyRational(value, composition.fps).denominator !== "1") {
      fail(
        node,
        "CUT_IMAGE_SEQUENCE_TIME_GRID",
        `$.nodes.${node.id}.interval`,
        `${name} must be ${positive ? "positive" : "non-negative"} and land on the destination frame grid.`,
      );
    }
  }
  const sourceDuration = subtractRational(range.end, range.start);
  if (!loop && endBehavior === "error" && compareRational(sourceDuration, node.interval.duration) < 0) {
    fail(
      node,
      "CUT_IMAGE_SEQUENCE_SOURCE",
      `$.nodes.${node.id}.interval.duration`,
      `needs ${node.interval.duration.numerator}/${node.interval.duration.denominator}s, but the selected source range provides ${sourceDuration.numerator}/${sourceDuration.denominator}s; use endBehavior: “hold”.`,
    );
  }
  const configIdentity = hash({
    contract: referenceImageSequenceContract,
    composition: {
      id: composition.id,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
    },
    nodeId: node.id,
    interval: node.interval,
    source: source.sourceIdentity,
    range: { start: range.start, end: range.end },
    fit,
    crop,
    loop,
    endBehavior,
  });
  return Object.freeze({
    nodeId: node.id,
    source,
    sourceStart: range.start,
    sourceEnd: range.end,
    sourceDuration,
    fit,
    ...(crop ? { crop } : {}),
    loop,
    endBehavior,
    configIdentity,
  });
}

function lockedResource(ir: CutAVIR, node: IRNode, resourceId: string): CutImageSequenceLockedResource {
  const resource = ir.resources[resourceId];
  const metadata = resource?.metadata;
  if (!resource || resource.state !== "locked" || !resource.sha256
    || metadata?.lockVersion !== 2
    || !Number.isSafeInteger(metadata.bytes)
    || Number(metadata.bytes) < 1
    || !metadata.probe) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_RESOURCE",
      `$.resources.${resourceId}`,
      "must carry validated cut.lock v2 bytes, SHA-256, and probe metadata before sequence preparation.",
      node,
    );
  }
  return Object.freeze({
    id: resource.id,
    kind: resource.kind,
    locator: resource.locator,
    sha256: resource.sha256,
    bytes: Number(metadata.bytes),
    probe: metadata.probe,
  });
}

/** Parse and bind the strict manifest to the exact embedded lock identity. */
export function prepareReferenceImageSequence(
  ir: CutAVIR,
  node: IRNode,
  config: ReferenceImageSequenceConfig,
  manifestBytes: Uint8Array,
): PreparedReferenceImageSequence {
  if (config.nodeId !== node.id || config.source.sourceIdentity !== cutImageSequenceSourceFromIr(ir, node).sourceIdentity) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_IDENTITY",
      `$.nodes.${node.id}.inputs.source`,
      "configuration changed after validated construction.",
      node,
    );
  }
  const ids = [config.source.manifestResourceId, ...config.source.frameResourceIds];
  const resources = Object.fromEntries(ids.map((resourceId) => [resourceId, lockedResource(ir, node, resourceId)]));
  const manifest = parseCutImageSequenceManifest(manifestBytes);
  const binding = validateCutImageSequenceManifestBinding(ir, node, config.source, manifest, resources);
  const memberSha256 = Object.freeze(Object.fromEntries(
    config.source.frameResourceIds.map((resourceId) => [resourceId, resources[resourceId]!.sha256]),
  ));
  const preparedIdentity = hash({
    contract: referenceImageSequenceContract,
    config: config.configIdentity,
    source: binding.sourceIdentity,
    manifest: binding.manifestIdentity,
    locked: binding.lockedIdentity,
  });
  return Object.freeze({
    ...config,
    manifestIdentity: binding.manifestIdentity,
    lockedIdentity: binding.lockedIdentity,
    preparedIdentity,
    memberSha256,
  });
}

function positiveModulo(value: Rational, modulus: Rational) {
  const scaledNumerator = BigInt(value.numerator) * BigInt(modulus.denominator);
  const scaledDenominator = BigInt(value.denominator) * BigInt(modulus.numerator);
  if (scaledNumerator < 0n || scaledDenominator <= 0n) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_TIME_GRID", "$.localTime", "cannot modulo a negative time or non-positive duration.");
  }
  const cycles = scaledNumerator / scaledDenominator;
  return subtractRational(value, multiplyRational(rational(cycles), modulus));
}

/** Select one exact ordered member for a destination-local time. */
export function referenceImageSequenceSelectionAt(
  config: PreparedReferenceImageSequence,
  localTime: Rational,
): ReferenceImageSequenceSelection {
  if (compareRational(localTime, zeroRational) < 0) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_TIME_GRID", "$.localTime", "cannot be negative.");
  }
  let relative: Rational;
  if (config.loop) relative = positiveModulo(localTime, config.sourceDuration);
  else if (compareRational(localTime, config.sourceDuration) < 0) relative = localTime;
  else if (config.endBehavior === "hold") {
    relative = subtractRational(config.sourceDuration, rational(config.source.frameRate.denominator, config.source.frameRate.numerator));
  } else {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_TIME_GRID",
      "$.localTime",
      "is beyond the selected source range without endBehavior: hold.",
    );
  }
  const sourceTime = addRational(config.sourceStart, relative);
  const selected = cutImageSequenceFrameAt(config.source, sourceTime);
  const memberSha256 = config.memberSha256[selected.resourceId];
  if (!memberSha256) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_IDENTITY",
      `$.frames[${selected.frame}]`,
      "lost its prepared locked member SHA-256.",
    );
  }
  return Object.freeze({
    ...selected,
    sourceTime,
    memberSha256,
    cacheIdentity: hash({
      contract: referenceImageSequenceContract.cacheIdentity,
      prepared: config.preparedIdentity,
      frame: selected.frame,
      resourceId: selected.resourceId,
      memberSha256,
    }),
  });
}
