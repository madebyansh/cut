import { hash } from "../../core/stable";
import type { IRNode } from "../../language/ir";
import { compareRational, rational, type Rational, zeroRational } from "../../language/rational";
import {
  planReferenceProjectiveWarp,
  referenceProjectiveWarpLimits,
  ReferenceProjectiveWarpError,
  type ReferenceProjectiveQuad,
  type ReferenceProjectiveWarpResult,
} from "./projective-warp-kernel";
import type { ReferenceProjectiveWarpCanvasResult } from "./projective-warp-canvas";
import { referenceLocalSpaceLimits } from "./local-space";
import {
  referencePlanarTrackAlgorithmVersion,
  referencePlanarTrackLimits,
  type PreparedReferencePlanarTrack,
  type ReferencePlanarTrackAtResult,
} from "./planar-tracking";
import {
  referencePlanarTrackMatteAlgorithmVersion,
} from "./planar-track-matte";
import { referenceProjectiveWarpAlgorithmVersion } from "./projective-warp-kernel";
import { referenceProjectiveWarpCanvasAlgorithmVersion } from "./projective-warp-canvas";

type PlanarEvidenceBase = Readonly<{
  format: "cut-reference-planar-track-frame-evidence";
  version: 1;
  evidenceKind: "completed-frame-execution";
  algorithmVersion: typeof referencePlanarTrackAlgorithmVersion;
  projectiveWarpAlgorithmVersion: typeof referenceProjectiveWarpAlgorithmVersion;
  canvasCopyAlgorithmVersion: typeof referenceProjectiveWarpCanvasAlgorithmVersion;
  backendIdentity: string;
  compositionId: string;
  nodeId: string;
  localSpaceNodeId: string;
  exactTime: Rational;
  outputFrame: string;
  source: Readonly<{
    resourceId: string;
    sha256: string;
    bytes: number;
    resourceIdentity: string;
    preparationIdentity: string;
  }>;
  sample: Readonly<{
    sampleIdentity: string;
    exactNodeLocalTime: Rational;
    opacity: Rational;
    resolution: ReferencePlanarTrackAtResult["resolution"];
  }>;
}>;

export type ReferencePlanarTrackMatteFrameEvidence = Readonly<{
  algorithmVersion: typeof referencePlanarTrackMatteAlgorithmVersion;
  maskNodeId: string;
  targetNodeId: string;
  matteNodeId: string;
  mode: "alpha";
  coordinateSpace: "direct-planar-local-pixels";
  evaluationStage: "before-projective-warp";
  authoring: "manual";
  configIdentity: string;
  localCompositingPlanIdentity: string;
  operationSemanticIdentity: string;
}>;

export type ReferencePlanarTrackFrameEvidence =
  | (PlanarEvidenceBase & Readonly<{
    status: "skipped";
    skip: Extract<ReferencePlanarTrackAtResult, { hidden: true }>["skip"];
    work: Extract<ReferencePlanarTrackAtResult, { hidden: true }>["work"];
    executionIdentity: string;
  }>)
  | (PlanarEvidenceBase & Readonly<{
    status: "rendered";
    quadQ16: Extract<ReferencePlanarTrackAtResult, { hidden: false }>["quadQ16"];
    destinationBounds: Extract<ReferencePlanarTrackAtResult, { hidden: false }>["destinationBounds"];
    tile: Readonly<{
      tileIdentity: string;
      width: number;
      height: number;
      rgbaSha256: string;
      preProjectiveMatte?: ReferencePlanarTrackMatteFrameEvidence;
    }>;
    projective: Readonly<{
      planIdentity: string;
      planned: Extract<ReferencePlanarTrackAtResult, { hidden: false }>["projectivePlan"]["work"];
      observed: ReferenceProjectiveWarpResult["observedWork"];
      tightSurface: Readonly<{
        originX: number;
        originY: number;
        width: number;
        height: number;
        rgbaSha256: string;
      }>;
    }>;
    canvasCopy: ReferenceProjectiveWarpCanvasResult["copy"];
    output: Readonly<{ width: number; height: number; rgbaSha256: string }>;
    work: Readonly<{ projectivePlans: 1; destinationPixels: number; destinationRgbaBytes: number }>;
    executionIdentity: string;
  }>);

/**
 * Non-serialized authority captured by the live locked renderer before a
 * frame receipt can cross the publication boundary.  A receipt's own
 * unkeyed executionIdentity proves canonical serialization only; it is not an
 * authenticity boundary because an editor of persisted JSON can recompute
 * it.  Publication callers must therefore retain this independently owned
 * execution and supply it when validating the receipt.
 */
export type ReferencePlanarTrackFrameEvidenceTrustedContext = Readonly<{
  authority: "locked-ir-and-live-frame-execution";
  expected: ReferencePlanarTrackFrameEvidence;
}>;

export type ReferencePlanarTrackFrameEvidenceExecution = Readonly<{
  receipt: ReferencePlanarTrackFrameEvidence;
  trustedContext: ReferencePlanarTrackFrameEvidenceTrustedContext;
}>;

export class ReferencePlanarTrackFrameEvidenceError extends Error {
  readonly code = "CUT_PLANAR_TRACK_EVIDENCE" as const;

  constructor(readonly path: string, message: string) {
    super(`CUT_PLANAR_TRACK_EVIDENCE: ${path} ${message}`);
    this.name = "ReferencePlanarTrackFrameEvidenceError";
  }
}

function evidenceRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, "must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, "must be a plain data object.");
  }
  return value as Record<string, unknown>;
}

function semanticRational(
  value: unknown,
  path: string,
  bounds: Readonly<{ minimum?: Rational; maximum?: Rational }> = {},
): Rational {
  const record = evidenceRecord(value, path);
  const numerator = record.numerator, denominator = record.denominator;
  if (typeof numerator !== "string" || typeof denominator !== "string"
    || numerator === "-0"
    || !/^-?(?:0|[1-9][0-9]*)$/u.test(numerator)
    || !/^[1-9][0-9]*$/u.test(denominator)
    || numerator.replace("-", "").length > referencePlanarTrackLimits.maxRuntimeRationalDigits
    || denominator.length > referencePlanarTrackLimits.maxRuntimeRationalDigits) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, "must be one bounded canonical exact rational.");
  }
  const canonical = rational(numerator, denominator);
  if (canonical.numerator !== numerator || canonical.denominator !== denominator) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, "must be reduced to canonical lowest terms.");
  }
  if ((bounds.minimum && compareRational(canonical, bounds.minimum) < 0)
    || (bounds.maximum && compareRational(canonical, bounds.maximum) > 0)) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, "is outside its declared exact range.");
  }
  return canonical;
}

function evidenceInteger(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, `must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function evidenceFrame(value: unknown, path: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, "must be a canonical non-negative integer string.");
  }
  const exact = BigInt(value);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, "exceeds the safe frame-index boundary.");
  }
  return value;
}

function evidenceHash(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ReferencePlanarTrackFrameEvidenceError(path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function q16Quad(value: unknown): ReferenceProjectiveQuad {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.quadQ16", "must contain exactly four Q16 points.");
  }
  const maximum = BigInt(referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate) * 65_536n;
  const result = value.map((item, index) => {
    const point = evidenceRecord(item, `$.quadQ16[${index}]`);
    const coordinate = (axis: "x" | "y") => {
      const text = point[axis];
      if (typeof text !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(text) || text === "-0" || text.length > 32) {
        throw new ReferencePlanarTrackFrameEvidenceError(`$.quadQ16[${index}].${axis}`, "must be a bounded canonical Q16 integer string.");
      }
      const exact = BigInt(text);
      if (exact < -maximum || exact > maximum) {
        throw new ReferencePlanarTrackFrameEvidenceError(`$.quadQ16[${index}].${axis}`, "exceeds the projective coordinate envelope.");
      }
      return Number(exact) / 65_536;
    };
    return Object.freeze({ x: coordinate("x"), y: coordinate("y") });
  });
  return Object.freeze(result) as ReferenceProjectiveQuad;
}

export type ReferencePlanarTrackFrameEvidenceExpectation = Readonly<{
  trustedContext: ReferencePlanarTrackFrameEvidenceTrustedContext;
  outputWidth: number;
  outputHeight: number;
  minimumExactTime: Rational;
  maximumExactTime: Rational;
  outputFrame: string;
}>;

function firstTrustedMismatch(actual: unknown, expected: unknown, path = "$"): string | undefined {
  if (Object.is(actual, expected)) return undefined;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return path;
    for (let index = 0; index < actual.length; index += 1) {
      const mismatch = firstTrustedMismatch(actual[index], expected[index], `${path}[${index}]`);
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const actualRecord = actual as Record<string, unknown>, expectedRecord = expected as Record<string, unknown>;
    const actualKeys = Object.keys(actualRecord).sort(), expectedKeys = Object.keys(expectedRecord).sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return path;
    for (const key of actualKeys) {
      const mismatch = firstTrustedMismatch(actualRecord[key], expectedRecord[key], `${path}.${key}`);
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  return path;
}

function trustedExpectation(value: ReferencePlanarTrackFrameEvidenceExpectation | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.trustedContext", "is required from the locked live-frame caller; receipt self-identity is not an authenticity boundary.");
  }
  const context = value.trustedContext;
  if (!context || typeof context !== "object" || Array.isArray(context)
    || context.authority !== "locked-ir-and-live-frame-execution"
    || !context.expected || typeof context.expected !== "object" || Array.isArray(context.expected)) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.trustedContext", "must contain one independently retained locked live-frame execution.");
  }
  for (const [name, number] of [["outputWidth", value.outputWidth], ["outputHeight", value.outputHeight]] as const) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 4_096) {
      throw new ReferencePlanarTrackFrameEvidenceError(`$.trustedContext.${name}`, "must be a caller-supplied bounded composition dimension.");
    }
  }
  if (typeof value.outputFrame !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.outputFrame)) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.trustedContext.outputFrame", "must be the caller-supplied canonical completed frame index.");
  }
  // Canonical/range validation below handles receipt values. Validate the
  // independently supplied scene clock here so missing or malformed authority
  // cannot silently weaken those checks.
  semanticRational(value.minimumExactTime, "$.trustedContext.minimumExactTime", { minimum: zeroRational });
  semanticRational(value.maximumExactTime, "$.trustedContext.maximumExactTime", { minimum: zeroRational });
  if (compareRational(value.minimumExactTime, value.maximumExactTime) > 0) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.trustedContext.maximumExactTime", "must not precede minimumExactTime.");
  }
  return value;
}

/**
 * Semantic complement to the closed frame-v2 JSON schema. It recomputes the
 * projective plan and receipt identity and closes correlations JSON Schema
 * cannot express.
 */
export function validateReferencePlanarTrackFrameEvidenceSemantics(
  value: unknown,
  expectation?: ReferencePlanarTrackFrameEvidenceExpectation,
): ReferencePlanarTrackFrameEvidence {
  const expected = trustedExpectation(expectation);
  const receipt = evidenceRecord(value, "$");
  const sample = evidenceRecord(receipt.sample, "$.sample");
  const exactTime = semanticRational(receipt.exactTime, "$.exactTime", { minimum: zeroRational });
  const exactNodeLocalTime = semanticRational(sample.exactNodeLocalTime, "$.sample.exactNodeLocalTime", { minimum: zeroRational });
  const opacity = semanticRational(sample.opacity, "$.sample.opacity", { minimum: zeroRational, maximum: rational(1) });
  const resolution = evidenceRecord(sample.resolution, "$.sample.resolution");
  semanticRational(resolution.progress, "$.sample.resolution.progress", { minimum: zeroRational, maximum: rational(1) });
  semanticRational(resolution.leftConfidence, "$.sample.resolution.leftConfidence", { minimum: zeroRational, maximum: rational(1) });
  semanticRational(resolution.rightConfidence, "$.sample.resolution.rightConfidence", { minimum: zeroRational, maximum: rational(1) });
  for (const name of ["leftSampleIndex", "rightSampleIndex", "selectedSampleIndex", "blockedRightSampleIndex"] as const) {
    if (resolution[name] !== undefined) evidenceInteger(resolution[name], `$.sample.resolution.${name}`, 0, referencePlanarTrackLimits.maxSamples - 1);
  }
  if (resolution.policy !== undefined) {
    const policy = evidenceRecord(resolution.policy, "$.sample.resolution.policy");
    evidenceInteger(policy.observationSampleIndex, "$.sample.resolution.policy.observationSampleIndex", 0, referencePlanarTrackLimits.maxSamples - 1);
  }
  const outputFrame = evidenceFrame(receipt.outputFrame, "$.outputFrame");
  const source = evidenceRecord(receipt.source, "$.source");
  evidenceInteger(source.bytes, "$.source.bytes", 1, referencePlanarTrackLimits.maxBytes);
  if (compareRational(exactTime, expected.minimumExactTime) < 0
    || compareRational(exactTime, expected.maximumExactTime) > 0) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.exactTime", "is outside the completed scene clock.");
  }
  if (outputFrame !== expected.outputFrame) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.outputFrame", "does not match the completed frame index.");
  }
  if (compareRational(exactNodeLocalTime, exactTime) > 0) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.sample.exactNodeLocalTime", "cannot be later than composition-absolute exactTime.");
  }
  if (receipt.status === "rendered") {
    if (compareRational(opacity, zeroRational) === 0) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.sample.opacity", "must be greater than zero for rendered evidence.");
    }
    const tile = evidenceRecord(receipt.tile, "$.tile"), output = evidenceRecord(receipt.output, "$.output");
    const tileWidth = evidenceInteger(tile.width, "$.tile.width", 1, referenceLocalSpaceLimits.maximumAxisPx);
    const tileHeight = evidenceInteger(tile.height, "$.tile.height", 1, referenceLocalSpaceLimits.maximumAxisPx);
    if (tileWidth * tileHeight > referenceLocalSpaceLimits.maximumSurfacePixels) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.tile", `exceeds ${referenceLocalSpaceLimits.maximumSurfacePixels} public LocalSpace pixels.`);
    }
    if (tile.preProjectiveMatte !== undefined) {
      const matte = evidenceRecord(tile.preProjectiveMatte, "$.tile.preProjectiveMatte");
      if (matte.algorithmVersion !== referencePlanarTrackMatteAlgorithmVersion) {
        throw new ReferencePlanarTrackFrameEvidenceError("$.tile.preProjectiveMatte.algorithmVersion", "does not identify the public PlanarTrack matte algorithm.");
      }
      if (matte.mode !== "alpha") {
        throw new ReferencePlanarTrackFrameEvidenceError("$.tile.preProjectiveMatte.mode", "must be the bounded alpha matte.");
      }
      if (matte.coordinateSpace !== "direct-planar-local-pixels") {
        throw new ReferencePlanarTrackFrameEvidenceError("$.tile.preProjectiveMatte.coordinateSpace", "must bind the direct PlanarTrack LocalSpace.");
      }
      if (matte.evaluationStage !== "before-projective-warp") {
        throw new ReferencePlanarTrackFrameEvidenceError("$.tile.preProjectiveMatte.evaluationStage", "must precede the projective warp.");
      }
      if (matte.authoring !== "manual") {
        throw new ReferencePlanarTrackFrameEvidenceError("$.tile.preProjectiveMatte.authoring", "cannot claim an automatic solver in matte v1.");
      }
      for (const name of ["configIdentity", "localCompositingPlanIdentity", "operationSemanticIdentity"] as const) {
        evidenceHash(matte[name], `$.tile.preProjectiveMatte.${name}`);
      }
    }
    const outputWidth = evidenceInteger(output.width, "$.output.width", 1, 4_096);
    const outputHeight = evidenceInteger(output.height, "$.output.height", 1, 4_096);
    if (outputWidth * outputHeight > referenceProjectiveWarpLimits.maximumDestinationPixels) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.output", "exceeds the public composition canvas pixel limit.");
    }
    if (outputWidth !== expected.outputWidth) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.output.width", "does not match the completed frame canvas.");
    }
    if (outputHeight !== expected.outputHeight) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.output.height", "does not match the completed frame canvas.");
    }

    const bounds = evidenceRecord(receipt.destinationBounds, "$.destinationBounds");
    const left = evidenceInteger(bounds.left, "$.destinationBounds.left", 0, outputWidth);
    const top = evidenceInteger(bounds.top, "$.destinationBounds.top", 0, outputHeight);
    const right = evidenceInteger(bounds.right, "$.destinationBounds.right", 0, outputWidth);
    const bottom = evidenceInteger(bounds.bottom, "$.destinationBounds.bottom", 0, outputHeight);
    if (right <= left || bottom <= top) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.destinationBounds", "must be one non-empty pixel-center-tight rectangle.");
    }
    const destinationPixels = (right - left) * (bottom - top);
    let replay;
    try {
      replay = planReferenceProjectiveWarp({
        sourceWidth: tileWidth,
        sourceHeight: tileHeight,
        destinationQuad: q16Quad(receipt.quadQ16),
        destinationBounds: { left, top, right, bottom },
      });
    } catch (error) {
      if (!(error instanceof ReferenceProjectiveWarpError)) throw error;
      throw new ReferencePlanarTrackFrameEvidenceError("$.projective", `cannot replay its projective plan (${error.code}).`);
    }
    const projective = evidenceRecord(receipt.projective, "$.projective");
    if (projective.planIdentity !== replay.planIdentity) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.projective.planIdentity", "does not match the replayed Q16 projective plan.");
    }
    if (hash(projective.planned) !== hash(replay.work)) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.projective.planned", "does not match the replayed projective work plan.");
    }
    const tight = evidenceRecord(projective.tightSurface, "$.projective.tightSurface");
    if (tight.originX !== left || tight.originY !== top || tight.width !== right - left || tight.height !== bottom - top) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.projective.tightSurface", "must exactly materialize destinationBounds.");
    }
    const work = evidenceRecord(receipt.work, "$.work");
    if (work.projectivePlans !== 1 || work.destinationPixels !== destinationPixels || work.destinationRgbaBytes !== destinationPixels * 4) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.work", "does not match the replayed tight destination surface.");
    }
    const observed = evidenceRecord(projective.observed, "$.projective.observed");
    const tested = evidenceInteger(observed.destinationPixelsTested, "$.projective.observed.destinationPixelsTested", 0, destinationPixels);
    const inside = evidenceInteger(observed.insideQuadPixels, "$.projective.observed.insideQuadPixels", 0, destinationPixels);
    const integers = evidenceInteger(observed.integerSamplesCopied, "$.projective.observed.integerSamplesCopied", 0, inside);
    const bilinear = evidenceInteger(observed.bilinearSamplesEvaluated, "$.projective.observed.bilinearSamplesEvaluated", 0, inside);
    const taps = evidenceInteger(observed.sourceTapsRead, "$.projective.observed.sourceTapsRead", 0, integers + bilinear * 4);
    if (tested !== destinationPixels || integers + bilinear > inside || taps < integers) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.projective.observed", "contains counters inconsistent with deterministic projective execution.");
    }
    const copy = evidenceRecord(receipt.canvasCopy, "$.canvasCopy");
    for (const [name, expectedValue] of [
      ["sourceOriginX", left], ["sourceOriginY", top], ["clippedLeft", left], ["clippedTop", top],
      ["clippedRight", right], ["clippedBottom", bottom], ["coveredPixels", destinationPixels],
    ] as const) {
      if (copy[name] !== expectedValue) throw new ReferencePlanarTrackFrameEvidenceError(`$.canvasCopy.${name}`, "does not match destinationBounds.");
    }
    const copied = evidenceInteger(copy.copiedPixels, "$.canvasCopy.copiedPixels", 0, destinationPixels);
    const copiedBytes = evidenceInteger(copy.copiedRgbaBytes, "$.canvasCopy.copiedRgbaBytes", 0, destinationPixels * 4);
    const scaled = evidenceInteger(copy.opacityScaledPixels, "$.canvasCopy.opacityScaledPixels", 0, copied);
    if (copiedBytes !== copied * 4 || copied > inside) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.canvasCopy", "contains copied-pixel work inconsistent with the warped surface.");
    }
    const partiallyOpaque = compareRational(opacity, rational(1)) < 0;
    if ((partiallyOpaque && scaled !== copied) || (!partiallyOpaque && scaled !== 0)) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.canvasCopy.opacityScaledPixels", "does not match the exact owner opacity.");
    }
  } else if (receipt.status === "skipped") {
    const skip = evidenceRecord(receipt.skip, "$.skip");
    if (skip.classification === "owner-opacity" && compareRational(opacity, zeroRational) !== 0) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.sample.opacity", "must be exact zero for an owner-opacity skip.");
    }
    if (skip.classification !== "owner-opacity" && skip.classification !== "tracking-policy-hidden") {
      throw new ReferencePlanarTrackFrameEvidenceError("$.skip.classification", "is not a supported PlanarTrack skip classification.");
    }
    const work = evidenceRecord(receipt.work, "$.work");
    if (work.projectivePlans !== 0 || work.destinationPixels !== 0 || work.destinationRgbaBytes !== 0) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.work", "must be exact zero work for skipped evidence.");
    }
  } else {
    throw new ReferencePlanarTrackFrameEvidenceError("$.status", "must be rendered or skipped.");
  }
  const identity = receipt.executionIdentity;
  if (typeof identity !== "string" || !/^[a-f0-9]{64}$/u.test(identity)) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.executionIdentity", "must be one lowercase SHA-256 digest.");
  }
  const payload = { ...receipt };
  delete payload.executionIdentity;
  if (hash(payload) !== identity) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.executionIdentity", "does not match the canonical semantic receipt payload.");
  }
  const { executionIdentity: trustedReceiptIdentity, ...trustedReceiptPayload } = receipt;
  const { executionIdentity: trustedExpectedIdentity, ...trustedExpectedPayload } = expected.trustedContext.expected;
  const trustedMismatch = firstTrustedMismatch(trustedReceiptPayload, trustedExpectedPayload);
  if (trustedMismatch) {
    throw new ReferencePlanarTrackFrameEvidenceError(trustedMismatch, "does not match the caller-supplied locked live-frame execution.");
  }
  if (trustedReceiptIdentity !== trustedExpectedIdentity) {
    throw new ReferencePlanarTrackFrameEvidenceError("$.executionIdentity", "does not match the caller-supplied locked live-frame execution.");
  }
  return value as ReferencePlanarTrackFrameEvidence;
}

function trustedExecution(receipt: ReferencePlanarTrackFrameEvidence): ReferencePlanarTrackFrameEvidenceExecution {
  return Object.freeze({
    receipt,
    trustedContext: Object.freeze({
      authority: "locked-ir-and-live-frame-execution" as const,
      expected: receipt,
    }),
  });
}

type CommonPlanarEvidenceInput = Readonly<{
  compositionId: string;
  owner: IRNode;
  localSpaceNode: IRNode;
  exactTime: Rational;
  outputFrame: string;
  backendIdentity: string;
  prepared: PreparedReferencePlanarTrack;
}>;

function base(input: CommonPlanarEvidenceInput, sample: ReferencePlanarTrackAtResult): PlanarEvidenceBase {
  if (input.owner.id !== sample.nodeId || input.owner.id !== input.prepared.nodeId) {
    throw new Error("CUT_PLANAR_TRACK_EVIDENCE: owner, sample, and prepared identities do not match.");
  }
  return Object.freeze({
    format: "cut-reference-planar-track-frame-evidence" as const,
    version: 1 as const,
    evidenceKind: "completed-frame-execution" as const,
    algorithmVersion: referencePlanarTrackAlgorithmVersion,
    projectiveWarpAlgorithmVersion: referenceProjectiveWarpAlgorithmVersion,
    canvasCopyAlgorithmVersion: referenceProjectiveWarpCanvasAlgorithmVersion,
    backendIdentity: input.backendIdentity,
    compositionId: input.compositionId,
    nodeId: input.owner.id,
    localSpaceNodeId: input.localSpaceNode.id,
    exactTime: Object.freeze({ ...input.exactTime }),
    outputFrame: input.outputFrame,
    source: Object.freeze({
      resourceId: input.prepared.sourceResource.id,
      sha256: input.prepared.sourceResource.sha256,
      bytes: input.prepared.sourceResource.bytes,
      resourceIdentity: input.prepared.sourceResource.identity,
      preparationIdentity: input.prepared.preparationIdentity,
    }),
    sample: Object.freeze({
      sampleIdentity: sample.sampleIdentity,
      exactNodeLocalTime: Object.freeze({ ...sample.exactNodeLocalTime }),
      opacity: Object.freeze({ ...sample.opacity }),
      resolution: sample.resolution,
    }),
  });
}

export function referencePlanarTrackSkippedFrameEvidence(
  input: CommonPlanarEvidenceInput & Readonly<{ sample: Extract<ReferencePlanarTrackAtResult, { hidden: true }> }>,
): ReferencePlanarTrackFrameEvidence {
  const receipt = Object.freeze({
    ...base(input, input.sample),
    status: "skipped" as const,
    skip: input.sample.skip,
    work: input.sample.work,
  });
  return Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
}

export function referencePlanarTrackSkippedFrameExecution(
  input: Parameters<typeof referencePlanarTrackSkippedFrameEvidence>[0],
): ReferencePlanarTrackFrameEvidenceExecution {
  return trustedExecution(referencePlanarTrackSkippedFrameEvidence(input));
}

export function referencePlanarTrackRenderedFrameEvidence(
  input: CommonPlanarEvidenceInput & Readonly<{
    sample: Extract<ReferencePlanarTrackAtResult, { hidden: false }>;
    tileIdentity: string;
    tileRgbaSha256: string;
    preProjectiveMatte?: ReferencePlanarTrackMatteFrameEvidence;
    warp: ReferenceProjectiveWarpResult;
    tightSurfaceRgbaSha256: string;
    canvas: ReferenceProjectiveWarpCanvasResult;
    outputRgbaSha256: string;
  }>,
): ReferencePlanarTrackFrameEvidence {
  const receipt = Object.freeze({
    ...base(input, input.sample),
    status: "rendered" as const,
    quadQ16: input.sample.quadQ16,
    destinationBounds: input.sample.destinationBounds,
    tile: Object.freeze({
      tileIdentity: input.tileIdentity,
      width: input.sample.projectivePlan.source.width,
      height: input.sample.projectivePlan.source.height,
      rgbaSha256: input.tileRgbaSha256,
      ...(input.preProjectiveMatte ? { preProjectiveMatte: input.preProjectiveMatte } : {}),
    }),
    projective: Object.freeze({
      planIdentity: input.sample.projectivePlan.planIdentity,
      planned: input.sample.projectivePlan.work,
      observed: input.warp.observedWork,
      tightSurface: Object.freeze({
        originX: input.warp.surface.originX,
        originY: input.warp.surface.originY,
        width: input.warp.surface.width,
        height: input.warp.surface.height,
        rgbaSha256: input.tightSurfaceRgbaSha256,
      }),
    }),
    canvasCopy: input.canvas.copy,
    output: Object.freeze({
      width: input.canvas.surface.width,
      height: input.canvas.surface.height,
      rgbaSha256: input.outputRgbaSha256,
    }),
    work: Object.freeze({
      projectivePlans: 1 as const,
      destinationPixels: input.sample.projectivePlan.destination.pixels,
      destinationRgbaBytes: input.sample.projectivePlan.destination.rgbaBytes,
    }),
  });
  return Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
}

export function referencePlanarTrackRenderedFrameExecution(
  input: Parameters<typeof referencePlanarTrackRenderedFrameEvidence>[0],
): ReferencePlanarTrackFrameEvidenceExecution {
  return trustedExecution(referencePlanarTrackRenderedFrameEvidence(input));
}
