import { boundedDiagnosticString, hash, stableJsonStringify } from "../core/stable";
import { cutCompositionContentHash, cutIrIdentity, cutNodeContentHash, cutSignalContentHash } from "../runtime/graph";
import type {
  CutAVIR,
  IREditorial,
  IREditorialInterval,
  IRNode,
  IRPictureTimeMap,
  IRSignal,
  IRTranscriptBindingV1,
  IRTranscriptMediaAuthorityV1,
  IRValue,
} from "./ir";
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
import { editorialAnnotationGrids, editorialAnnotationLimits, editorialAnnotationRoles, normalizeEditorialAnnotationMetadata } from "./editorial-annotations";
import { kernelAcceptsInput, kernelAcceptsProperty, kernelPropertyValueType, referenceKernelSchema, type KernelPropertyValueType } from "./kernel-registry";
import { cutVisualPropertyBaselineIssue } from "./visual-property-baselines";
import { linkedRippleSegmentIds } from "./linked-ripple-identity";
import { isNeutralLinkedRipplePictureInputs } from "./linked-ripple-neutral";
import { referenceComplexTextBackendContract } from "./dependency-identity";
import { AudioEditOperationError, executeAudioEditOperationPlan, type AudioEditOperationPlanV2 } from "./audio-edit-operations";
import {
  executePictureTrackOperationPlan,
  PictureEditOperationError,
  pictureEditMaterializedNodeId,
} from "./picture-edit-operations";
import {
  CutResponsiveStackError,
  decodeCutResponsiveSlotMediaContext,
  type CutResponsiveStackErrorCode,
} from "./responsive-layout";
import { ReferenceResponsiveStackError, validateReferenceResponsiveStackGraph } from "../runtime/reference/responsive-layout";
import { referenceAudioCompositionRootIds } from "../runtime/reference/audio-resource";
import {
  ReferenceTempoDelayConfigError,
  validateReferenceTempoDelayPlans,
} from "../runtime/reference/audio-tempo-delay-config";
import { prepareReferenceTraceNode } from "../runtime/reference/trace";
import {
  CutDiagramContractError,
  validateCutDiagramLanguageIR,
  type CutDiagramDiagnosticCode,
} from "./diagram-contract";
import {
  CutMediaCamera2DContractError,
  validateCutMediaCamera2DLanguageIR,
  type CutMediaCamera2DDiagnosticCode,
} from "./media-camera2d-contract";
import {
  ReferencePlanarTrackMatteError,
  referencePlanarTrackMatteConfig,
} from "../runtime/reference/planar-track-matte";
import { ReferenceCamera3DError, validateReferenceCamera3DGraph } from "../runtime/reference/camera3d";
import {
  createReferenceComponentFragmentLocalSpaceAdmissionIndex,
  referenceComponentFragmentLocalSpaceAdmissionIssue,
} from "../runtime/reference/component-fragment-local-space";
import { cutAnchoredPathLimits, cutAnchoredSpatialOps } from "./anchored-path-contract";
import {
  CutTranscriptMediaAuthorityError,
  CutTranscriptPictureSnapError,
  cutTranscriptExecutableLimits,
  cutTranscriptHasUnsafeUnicodeScalar,
  cutTranscriptMediaAuthorityContract,
  cutTranscriptMediaAuthorityIdentity,
  cutTranscriptMediaVideoSourceRange,
  cutTranscriptPictureCoverRange,
  cutTranscriptPictureIdentity,
  cutTranscriptPictureOriginIdentity,
  cutTranscriptPictureSegmentIdentity,
  cutTranscriptPictureVideoSourceRange,
} from "./transcript-contract";
import {
  CutTranscriptTimelineCaptionError,
  cutTranscriptCaptionIdentity,
} from "./transcript-timeline-edit";
import {
  executeTimelineEditPlan,
  timelineEditLimits,
  TimelineEditError,
  type TimelineEditErrorCode,
  type TimelineEditPlanV1,
} from "./timeline-edit-operations";
import {
  cutTimelineAudioEvaluationPolicies,
  cutTimelineAudioFadeAnchorPolicies,
  cutTimelineAudioOriginKinds,
  cutTimelineAudioOriginOp,
  cutTimelineAudioStatePolicies,
  cutTimelineAudioViewOp,
  cutTimelineProcessedExternalHandleProcessorOps,
  type CutTimelineAudioOriginKind,
} from "./timeline-edit-audio-origin-contract";
import {
  CutTypedDataAssetAuthorityError,
  assertCutTypedDataAssetConsumerCompatibility,
  validateCutTypedDataAssetAuthority,
} from "./typed-data-asset";
import {
  CutImageSequenceError,
  cutImageSequenceSources,
  type CutImageSequenceErrorCode,
} from "./image-sequence";

export type CutAvIrValidationLimits = {
  maxInputBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxStringBytes: number;
  maxTotalStringBytes: number;
  maxModules: number;
  maxResources: number;
  maxCompositions: number;
  maxScenes: number;
  maxNodes: number;
  maxSignals: number;
  maxJobs: number;
  maxOutputs: number;
  maxAssertions: number;
  maxAnnotations: number;
  maxLinkedEdits: number;
  maxTimelineEdits: number;
  maxTranscriptBindings: number;
  maxTranscriptWordsPerBinding: number;
  maxSemanticMatchSubjects: number;
  maxSemanticMatchTransitions: number;
  maxCollectionItems: number;
  maxRecordEntries: number;
  maxValueDepth: number;
  maxValueNodes: number;
  maxMetadataDepth: number;
  maxMetadataNodes: number;
  maxGraphDepth: number;
  maxGraphEdges: number;
  maxProvenanceFrames: number;
  /** Maximum decimal digits in either part of an exact rational (sign excluded). */
  maxRationalDigits: number;
};

export const defaultCutAvIrValidationLimits: Readonly<CutAvIrValidationLimits> = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxJsonDepth: 128,
  maxJsonNodes: 2_000_000,
  maxStringBytes: 1024 * 1024,
  maxTotalStringBytes: 16 * 1024 * 1024,
  maxModules: 256,
  maxResources: 10_000,
  maxCompositions: 1_000,
  maxScenes: 10_000,
  maxNodes: 100_000,
  maxSignals: 100_000,
  maxJobs: 100_000,
  maxOutputs: 10_000,
  maxAssertions: 1_024,
  maxAnnotations: editorialAnnotationLimits.maximumAnnotations,
  maxLinkedEdits: 256,
  maxTimelineEdits: 256,
  maxTranscriptBindings: 1_024,
  maxTranscriptWordsPerBinding: cutTranscriptExecutableLimits.maximumSelectedWords,
  maxSemanticMatchSubjects: 256_000,
  maxSemanticMatchTransitions: 128_000,
  maxCollectionItems: 100_000,
  maxRecordEntries: 100_000,
  maxValueDepth: 64,
  maxValueNodes: 1_000_000,
  maxMetadataDepth: 64,
  maxMetadataNodes: 1_000_000,
  maxGraphDepth: 1_024,
  maxGraphEdges: 1_000_000,
  maxProvenanceFrames: 256,
  maxRationalDigits: 256,
});

export type CutAvIrValidationErrorCode = CutResponsiveStackErrorCode
  | CutDiagramDiagnosticCode
  | CutMediaCamera2DDiagnosticCode
  | ReferencePlanarTrackMatteError["code"]
  | ReferenceTempoDelayConfigError["code"]
  | ReferenceCamera3DError["code"]
  | TimelineEditErrorCode
  | CutImageSequenceErrorCode
  | "CUT_AUDIO_REACTIVE_TYPE"
  | "CUT_AUDIO_REACTIVE_RANGE"
  | "CUT_AUDIO_REACTIVE_NOOP"
  | "CUT_AUDIO_REACTIVE_RESOURCE"
  | "CUT_AUDIO_REACTIVE_IDENTITY"
  | "CUT_AUDIO_REACTIVE_SCOPE"
  | "CUT_AUDIO_REACTIVE_TIME"
  | "CUT_AUDIO_REACTIVE_CONFLICT"
  | "CUT_AUDIO_REACTIVE_BASELINE"
  | "CUT_AUDIO_REACTIVE_TARGET"
  | "CUT_TYPED_DATA_ASSET_AUTHORITY"
  | "CUT_PLANAR_TRACK_GRAPH"
  | "CUT_MATCH_SCOPE"
  | "CUT_MATCH_ID"
  | "CUT_MATCH_SUBJECT"
  | "CUT_MATCH_CAMERA"
  | "CUT_MATCH_CUT"
  | "CUT_MATCH_BASIS"
  | "CUT_MATCH_TRANSFORM"
  | "CUT_MATCH_EASING"
  | "CUT_MATCH_VELOCITY"
  | "CUT_MATCH_CONFLICT"
  | "CUT_MATCH_LIMIT"
  | "CUT_MATCH_NOOP"
  | "CUT_MATCH_CONTRACT"
  | "CUT_TRANSCRIPT_PICTURE_PROXY"
  | "CUT_ANCHORED_PATH_MORPH"
  | "CUT_CALLOUT_TYPE"
  | "CUT_CALLOUT_GRAPH"
  | "CUT_CALLOUT_ANCHOR"
  | "CUT_CALLOUT_VIEWPORT"
  | "CUT_CALLOUT_LAYOUT"
  | "CUT_CALLOUT_STYLE"
  | "CUT_CALLOUT_LIMIT"
  | "CUT_CALLOUT_NOOP"
  | "CUT_VISUAL_BASELINE"
  | "CUT_IR_JSON_TOO_LARGE"
  | "CUT_IR_JSON_ENCODING"
  | "CUT_IR_JSON_PARSE"
  | "CUT_IR_JSON_DUPLICATE_KEY"
  | "CUT_IR_TYPE"
  | "CUT_IR_MISSING_FIELD"
  | "CUT_IR_UNKNOWN_FIELD"
  | "CUT_IR_ENUM"
  | "CUT_IR_LIMIT"
  | "CUT_IR_STRING"
  | "CUT_IR_RATIONAL"
  | "CUT_IR_HASH"
  | "CUT_IR_IDENTITY"
  | "CUT_IR_REFERENCE"
  | "CUT_IR_CYCLE"
  | "CUT_IR_TIMING"
  | "CUT_IR_DETERMINISM";

export class CutAvIrValidationError extends Error {
  constructor(
    readonly code: CutAvIrValidationErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAvIrValidationError";
  }
}

export type CutAvIrIdentityMode = "canonical-json" | "legacy-0.3-compatible";

export type CutAvIrValidationOptions = {
  limits?: Partial<CutAvIrValidationLimits>;
  /**
   * canonical-json verifies the v3 spec identity over the serialized IR.
   * legacy-0.3-compatible additionally accepts the archived 0.3 compiler's
   * verified undefined-sceneId identity bug; it never skips identity checks.
   */
  identityMode?: CutAvIrIdentityMode;
};

type RecordValue = Record<string, unknown>;
type Reference = { kind: "node" | "resource" | "timeline"; id: string; path: string };
type SignalReference = { id: string; path: string };
type ValidationContext = {
  limits: CutAvIrValidationLimits;
  totalStringBytes: number;
  valueNodes: number;
  metadataNodes: number;
  graphEdges: number;
  references: Reference[];
  signalReferences: SignalReference[];
  nodeReferenceEdges: Map<string, Set<string>>;
};

const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
const hashPattern = /^[a-f0-9]{64}$/;
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/;
const positiveIntegerPattern = /^(?:[1-9][0-9]*)$/;
const effects = new Set(["pure", "read", "analyze", "generate", "external"]);
const domains = new Set(["visual", "audio", "av", "data", "output"]);

function fail(code: CutAvIrValidationErrorCode, path: string, message: string): never {
  throw new CutAvIrValidationError(code, path, message);
}

function resolveLimits(overrides: Partial<CutAvIrValidationLimits> | undefined) {
  if (overrides && (!isRecord(overrides) || Object.keys(overrides).some((key) => !(key in defaultCutAvIrValidationLimits)))) {
    fail("CUT_IR_UNKNOWN_FIELD", "$.options.limits", "contains an unknown validation limit.");
  }
  const limits = { ...defaultCutAvIrValidationLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const minimum = name === "maxJsonDepth" || name === "maxValueDepth" || name === "maxMetadataDepth" || name === "maxGraphDepth" || name === "maxRationalDigits" ? 1 : 0;
    if (!Number.isSafeInteger(value) || value < minimum) {
      fail("CUT_IR_LIMIT", `$.options.limits.${name}`, `must be a safe integer greater than or equal to ${minimum}.`);
    }
  }
  return limits;
}

function resolveOptions(options: CutAvIrValidationOptions) {
  if (!isRecord(options)) fail("CUT_IR_TYPE", "$.options", "must be a plain object.");
  const allowed = new Set(["limits", "identityMode"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail("CUT_IR_UNKNOWN_FIELD", `$.options.${key}`, "is not a supported loader option.");
  const identityMode = options.identityMode ?? "canonical-json";
  if (identityMode !== "canonical-json" && identityMode !== "legacy-0.3-compatible") {
    fail("CUT_IR_ENUM", "$.options.identityMode", "must be canonical-json or legacy-0.3-compatible.");
  }
  return { limits: resolveLimits(options.limits), identityMode };
}

function isRecord(value: unknown): value is RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) fail("CUT_IR_TYPE", path, "must be a plain JSON object.");
  return value;
}

function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const object = record(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const field of required) if (!Object.hasOwn(object, field)) fail("CUT_IR_MISSING_FIELD", path, `is missing required field “${field}”.`);
  for (const field of Object.keys(object)) if (!allowed.has(field)) fail("CUT_IR_UNKNOWN_FIELD", `${path}.${field}`, "is not part of the CutAVIR v3 contract.");
  return object;
}

function childPath(path: string, key: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** A diagnostic-only path segment that cannot amplify a hostile record key. */
function diagnosticChildPath(path: string, key: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${boundedDiagnosticString(key)}]`;
}

function countString(context: ValidationContext, value: string, path: string) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > context.limits.maxStringBytes) fail("CUT_IR_LIMIT", path, `exceeds maxStringBytes (${context.limits.maxStringBytes}).`);
  context.totalStringBytes += bytes;
  if (context.totalStringBytes > context.limits.maxTotalStringBytes) fail("CUT_IR_LIMIT", path, `document strings exceed maxTotalStringBytes (${context.limits.maxTotalStringBytes}).`);
}

function stringValue(value: unknown, path: string, context: ValidationContext, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail("CUT_IR_TYPE", path, `must be ${allowEmpty ? "a" : "a non-empty"} string.`);
  countString(context, value, path);
  if (value.includes("\0")) fail("CUT_IR_STRING", path, "cannot contain NUL bytes.");
  return value;
}

function idValue(value: unknown, path: string, context: ValidationContext) {
  const id = stringValue(value, path, context);
  if (Buffer.byteLength(id, "utf8") > 512 || /[\u0000-\u001f\u007f]/.test(id) || dangerousKeys.has(id)) {
    fail("CUT_IR_STRING", path, "must be a safe identifier of at most 512 UTF-8 bytes.");
  }
  return id;
}

function enumValue(value: unknown, path: string, allowed: Set<string>) {
  if (typeof value !== "string" || !allowed.has(value)) fail("CUT_IR_ENUM", path, `must be one of ${[...allowed].join(", ")}.`);
  return value;
}

function booleanValue(value: unknown, path: string) {
  if (typeof value !== "boolean") fail("CUT_IR_TYPE", path, "must be a boolean.");
  return value;
}

function safeInteger(value: unknown, path: string, minimum?: number) {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && Number(value) < minimum)) {
    fail("CUT_IR_TYPE", path, `must be a safe integer${minimum === undefined ? "" : ` greater than or equal to ${minimum}`}.`);
  }
  return Number(value);
}

function arrayValue(value: unknown, path: string, context: ValidationContext, maximum = context.limits.maxCollectionItems) {
  if (!Array.isArray(value)) fail("CUT_IR_TYPE", path, "must be an array.");
  if (value.length > maximum) fail("CUT_IR_LIMIT", path, `contains ${value.length} items; limit is ${maximum}.`);
  return value;
}

function mapValue(value: unknown, path: string, context: ValidationContext, maximum = context.limits.maxRecordEntries) {
  const object = record(value, path);
  const keys = Object.keys(object);
  if (keys.length > maximum) fail("CUT_IR_LIMIT", path, `contains ${keys.length} entries; limit is ${maximum}.`);
  for (const key of keys) {
    countString(context, key, childPath(path, key));
    if (dangerousKeys.has(key)) fail("CUT_IR_STRING", childPath(path, key), "uses a prototype-sensitive record key.");
  }
  return object;
}

function hashValue(value: unknown, path: string, context: ValidationContext) {
  const digest = stringValue(value, path, context);
  if (!hashPattern.test(digest)) fail("CUT_IR_HASH", path, "must be a lowercase SHA-256 hex digest.");
  return digest;
}

function complexTextBackendIdentityValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["bidiJs", "format", "harfbuzz", "harfbuzzjs", "integrity", "policies", "version"]);
  if (object.format !== "cut-reference-complex-text-backend" || object.version !== 1) {
    fail("CUT_IR_ENUM", path, "must be cut-reference-complex-text-backend v1.");
  }
  const expected = referenceComplexTextBackendContract;
  const harfbuzzjs = closed(object.harfbuzzjs, `${path}.harfbuzzjs`, [
    "entrySha256",
    "glueSha256",
    "manifestSha256",
    "packageVersion",
    "wasmSha256",
  ]);
  if (harfbuzzjs.packageVersion !== expected.harfbuzzjsPackageVersion) {
    fail("CUT_IR_IDENTITY", `${path}.harfbuzzjs.packageVersion`, "does not match the pinned complex-text feature package.");
  }
  const canonicalHarfbuzzJs = {
    packageVersion: expected.harfbuzzjsPackageVersion,
    manifestSha256: hashValue(harfbuzzjs.manifestSha256, `${path}.harfbuzzjs.manifestSha256`, context),
    entrySha256: hashValue(harfbuzzjs.entrySha256, `${path}.harfbuzzjs.entrySha256`, context),
    glueSha256: hashValue(harfbuzzjs.glueSha256, `${path}.harfbuzzjs.glueSha256`, context),
    wasmSha256: hashValue(harfbuzzjs.wasmSha256, `${path}.harfbuzzjs.wasmSha256`, context),
  };
  const harfbuzz = closed(object.harfbuzz, `${path}.harfbuzz`, ["clusterLevel", "runtimeVersion"]);
  if (harfbuzz.runtimeVersion !== expected.harfbuzzRuntimeVersion || harfbuzz.clusterLevel !== expected.clusterLevel) {
    fail("CUT_IR_IDENTITY", `${path}.harfbuzz`, "does not match the pinned HarfBuzz runtime and cluster policy.");
  }
  const canonicalHarfbuzz = {
    runtimeVersion: expected.harfbuzzRuntimeVersion,
    clusterLevel: expected.clusterLevel,
  };
  const bidiJs = closed(object.bidiJs, `${path}.bidiJs`, [
    "implementationSha256",
    "manifestSha256",
    "packageVersion",
    "unicodeVersion",
  ]);
  if (bidiJs.packageVersion !== expected.bidiJsPackageVersion || bidiJs.unicodeVersion !== expected.bidiUnicodeVersion) {
    fail("CUT_IR_IDENTITY", `${path}.bidiJs`, "does not match the pinned bidi-js package and Unicode table version.");
  }
  const canonicalBidiJs = {
    packageVersion: expected.bidiJsPackageVersion,
    unicodeVersion: expected.bidiUnicodeVersion,
    manifestSha256: hashValue(bidiJs.manifestSha256, `${path}.bidiJs.manifestSha256`, context),
    implementationSha256: hashValue(bidiJs.implementationSha256, `${path}.bidiJs.implementationSha256`, context),
  };
  const policies = closed(object.policies, `${path}.policies`, [
    "fallback",
    "hostFontFallback",
    "normalization",
    "selector",
    "wrap",
  ]);
  const expectedPolicies = {
    fallback: expected.fallbackPolicy,
    wrap: expected.wrapPolicy,
    selector: expected.selectorPolicy,
    normalization: expected.normalizationPolicy,
    hostFontFallback: expected.hostFontFallback,
  } as const;
  for (const [name, required] of Object.entries(expectedPolicies)) {
    if (policies[name] !== required) {
      fail("CUT_IR_IDENTITY", `${path}.policies.${name}`, "does not match the pinned complex-text execution policy.");
    }
  }
  const bytes = expected.backendBytes;
  const bytePairs = [
    ["harfbuzzjs.manifestSha256", canonicalHarfbuzzJs.manifestSha256, bytes.harfbuzzManifestSha256],
    ["harfbuzzjs.entrySha256", canonicalHarfbuzzJs.entrySha256, bytes.harfbuzzEntrySha256],
    ["harfbuzzjs.glueSha256", canonicalHarfbuzzJs.glueSha256, bytes.harfbuzzGlueSha256],
    ["harfbuzzjs.wasmSha256", canonicalHarfbuzzJs.wasmSha256, bytes.harfbuzzWasmSha256],
    ["bidiJs.manifestSha256", canonicalBidiJs.manifestSha256, bytes.bidiManifestSha256],
    ["bidiJs.implementationSha256", canonicalBidiJs.implementationSha256, bytes.bidiImplementationSha256],
  ] as const;
  for (const [name, actual, pinned] of bytePairs) {
    if (actual !== pinned) fail("CUT_IR_IDENTITY", `${path}.${name}`, "does not match the pinned complex-text backend byte identity.");
  }
  const content = {
    format: "cut-reference-complex-text-backend" as const,
    version: 1 as const,
    harfbuzzjs: canonicalHarfbuzzJs,
    harfbuzz: canonicalHarfbuzz,
    bidiJs: canonicalBidiJs,
    policies: expectedPolicies,
  };
  const integrity = hashValue(object.integrity, `${path}.integrity`, context);
  if (integrity !== hash(content)) {
    fail("CUT_IR_IDENTITY", `${path}.integrity`, "does not match the canonical complex-text feature authority.");
  }
}

function rationalValue(value: unknown, path: string, context: ValidationContext): Rational {
  const object = closed(value, path, ["numerator", "denominator"]);
  const numeratorText = stringValue(object.numerator, `${path}.numerator`, context);
  const denominatorText = stringValue(object.denominator, `${path}.denominator`, context);
  if (!integerPattern.test(numeratorText) || numeratorText === "-0" || !positiveIntegerPattern.test(denominatorText)) {
    fail("CUT_IR_RATIONAL", path, "must use canonical signed numerator and positive denominator integer strings.");
  }
  const numeratorDigits = numeratorText.startsWith("-") ? numeratorText.length - 1 : numeratorText.length;
  if (numeratorDigits > context.limits.maxRationalDigits || denominatorText.length > context.limits.maxRationalDigits) {
    fail("CUT_IR_LIMIT", path, `rational parts exceed maxRationalDigits (${context.limits.maxRationalDigits}).`);
  }
  const numerator = BigInt(numeratorText);
  const denominator = BigInt(denominatorText);
  const canonical = rational(numerator, denominator);
  if (canonical.numerator !== numeratorText || canonical.denominator !== denominatorText) {
    fail("CUT_IR_RATIONAL", path, "must be reduced to canonical lowest terms.");
  }
  return value as Rational;
}

function consumeEdge(context: ValidationContext, path: string, amount = 1) {
  context.graphEdges += amount;
  if (context.graphEdges > context.limits.maxGraphEdges) fail("CUT_IR_LIMIT", path, `graph exceeds maxGraphEdges (${context.limits.maxGraphEdges}).`);
}

function uniqueIds(values: unknown, path: string, context: ValidationContext) {
  const entries = arrayValue(values, path, context);
  const seen = new Set<string>();
  return entries.map((value, index) => {
    const id = idValue(value, `${path}[${index}]`, context);
    if (seen.has(id)) fail("CUT_IR_IDENTITY", `${path}[${index}]`, `duplicates “${id}”.`);
    seen.add(id);
    consumeEdge(context, `${path}[${index}]`);
    return id;
  });
}

function sourcePosition(value: unknown, path: string) {
  const object = closed(value, path, ["offset", "line", "column"]);
  return {
    offset: safeInteger(object.offset, `${path}.offset`, 0),
    line: safeInteger(object.line, `${path}.line`, 1),
    column: safeInteger(object.column, `${path}.column`, 1),
  };
}

function sourceSpan(value: unknown, path: string) {
  const object = closed(value, path, ["start", "end"]);
  const start = sourcePosition(object.start, `${path}.start`);
  const end = sourcePosition(object.end, `${path}.end`);
  if (end.offset < start.offset || end.line < start.line || (end.line === start.line && end.column < start.column)) {
    fail("CUT_IR_IDENTITY", path, "has an end position before its start position.");
  }
  return { start, end };
}

function provenance(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["module", "span"], ["symbol", "expandedFrom"]);
  stringValue(object.module, `${path}.module`, context);
  sourceSpan(object.span, `${path}.span`);
  if (Object.hasOwn(object, "symbol")) stringValue(object.symbol, `${path}.symbol`, context);
  if (Object.hasOwn(object, "expandedFrom")) {
    const frames = arrayValue(object.expandedFrom, `${path}.expandedFrom`, context, context.limits.maxProvenanceFrames);
    frames.forEach((frame, index) => {
      const framePath = `${path}.expandedFrom[${index}]`;
      const expanded = closed(frame, framePath, ["module", "span", "symbol"]);
      stringValue(expanded.module, `${framePath}.module`, context);
      sourceSpan(expanded.span, `${framePath}.span`);
      stringValue(expanded.symbol, `${framePath}.symbol`, context);
    });
  }
}

function metadataValue(value: unknown, path: string, context: ValidationContext, depth = 0): void {
  context.metadataNodes += 1;
  if (context.metadataNodes > context.limits.maxMetadataNodes) fail("CUT_IR_LIMIT", path, `metadata exceeds maxMetadataNodes (${context.limits.maxMetadataNodes}).`);
  if (depth > context.limits.maxMetadataDepth) fail("CUT_IR_LIMIT", path, `metadata exceeds maxMetadataDepth (${context.limits.maxMetadataDepth}).`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { stringValue(value, path, context, true); return; }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CUT_IR_TYPE", path, "must be a finite JSON number.");
    return;
  }
  if (Array.isArray(value)) {
    arrayValue(value, path, context).forEach((item, index) => metadataValue(item, `${path}[${index}]`, context, depth + 1));
    return;
  }
  const object = mapValue(value, path, context);
  for (const [key, item] of Object.entries(object)) metadataValue(item, childPath(path, key), context, depth + 1);
}

function effectValue(value: unknown, path: string) {
  return enumValue(value, path, effects);
}

function domainValue(value: unknown, path: string) {
  return enumValue(value, path, domains);
}

const canonicalQuantityUnits: Readonly<Record<string, string>> = Object.freeze({
  scalar: "scalar",
  time: "s",
  beat: "beat",
  length: "px",
  ratio: "ratio",
  angle: "deg",
  gain: "db",
  frequency: "hz",
  loudness: "lufs",
  "true-peak": "dbtp",
  "sample-peak": "dbfs",
});

function irValue(value: unknown, path: string, context: ValidationContext, depth = 0, ownerNodeId?: string): void {
  context.valueNodes += 1;
  if (context.valueNodes > context.limits.maxValueNodes) fail("CUT_IR_LIMIT", path, `IR values exceed maxValueNodes (${context.limits.maxValueNodes}).`);
  if (depth > context.limits.maxValueDepth) fail("CUT_IR_LIMIT", path, `IR value exceeds maxValueDepth (${context.limits.maxValueDepth}).`);
  const base = record(value, path);
  const kind = stringValue(base.kind, `${path}.kind`, context);
  const nested = (item: unknown, nestedPath: string) => irValue(item, nestedPath, context, depth + 1, ownerNodeId);
  if (kind === "null") { closed(value, path, ["kind"]); return; }
  if (kind === "boolean") { const object = closed(value, path, ["kind", "value"]); booleanValue(object.value, `${path}.value`); return; }
  if (kind === "string") { const object = closed(value, path, ["kind", "value"]); stringValue(object.value, `${path}.value`, context, true); return; }
  if (kind === "color") {
    const object = closed(value, path, ["kind", "value"]); const color = stringValue(object.value, `${path}.value`, context);
    if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(color)) fail("CUT_IR_STRING", `${path}.value`, "must be a six- or eight-digit hexadecimal color.");
    return;
  }
  if (kind === "quantity") {
    const object = closed(value, path, ["kind", "dimension", "magnitude", "unit"]);
    const dimension = stringValue(object.dimension, `${path}.dimension`, context);
    rationalValue(object.magnitude, `${path}.magnitude`, context);
    const unit = stringValue(object.unit, `${path}.unit`, context, true);
    const canonicalUnit = canonicalQuantityUnits[dimension];
    if (canonicalUnit === undefined) {
      fail("CUT_IR_TYPE", `${path}.dimension`, `must be one of the closed canonical quantity dimensions: ${Object.keys(canonicalQuantityUnits).join(", ")}.`);
    }
    if (unit !== canonicalUnit) {
      fail("CUT_IR_TYPE", `${path}.unit`, `canonical ${dimension} quantities must use ${JSON.stringify(canonicalUnit)}; received ${JSON.stringify(unit)}.`);
    }
    return;
  }
  if (kind === "array") {
    const object = closed(value, path, ["kind", "items"]); arrayValue(object.items, `${path}.items`, context).forEach((item, index) => nested(item, `${path}.items[${index}]`)); return;
  }
  if (kind === "object") {
    const object = closed(value, path, ["kind", "entries"]); const entries = mapValue(object.entries, `${path}.entries`, context);
    Object.entries(entries).forEach(([key, item]) => nested(item, childPath(`${path}.entries`, key))); return;
  }
  if (kind === "range") {
    const object = closed(value, path, ["kind", "start", "end", "exclusive"]); nested(object.start, `${path}.start`); nested(object.end, `${path}.end`); booleanValue(object.exclusive, `${path}.exclusive`); return;
  }
  if (kind === "node-ref" || kind === "resource-ref" || kind === "timeline-ref") {
    const object = closed(value, path, ["kind", "id"]); const id = idValue(object.id, `${path}.id`, context);
    const referenceKind = kind === "node-ref" ? "node" : kind === "resource-ref" ? "resource" : "timeline";
    context.references.push({ kind: referenceKind, id, path: `${path}.id` }); consumeEdge(context, `${path}.id`);
    if (referenceKind === "node" && ownerNodeId) {
      const outgoing = context.nodeReferenceEdges.get(ownerNodeId) ?? new Set<string>(); outgoing.add(id); context.nodeReferenceEdges.set(ownerNodeId, outgoing);
    }
    return;
  }
  if (kind === "symbol") { const object = closed(value, path, ["kind", "name"]); stringValue(object.name, `${path}.name`, context); return; }
  if (kind === "unary") { const object = closed(value, path, ["kind", "operator", "value"]); stringValue(object.operator, `${path}.operator`, context); nested(object.value, `${path}.value`); return; }
  if (kind === "binary") {
    const object = closed(value, path, ["kind", "operator", "left", "right"]); stringValue(object.operator, `${path}.operator`, context); nested(object.left, `${path}.left`); nested(object.right, `${path}.right`); return;
  }
  if (kind === "member") { const object = closed(value, path, ["kind", "object", "property"]); nested(object.object, `${path}.object`); stringValue(object.property, `${path}.property`, context); return; }
  if (kind === "index") { const object = closed(value, path, ["kind", "object", "index"]); nested(object.object, `${path}.object`); nested(object.index, `${path}.index`); return; }
  if (kind === "call") {
    const object = closed(value, path, ["kind", "op", "positional", "named", "effect"]); stringValue(object.op, `${path}.op`, context); effectValue(object.effect, `${path}.effect`);
    arrayValue(object.positional, `${path}.positional`, context).forEach((item, index) => nested(item, `${path}.positional[${index}]`));
    const named = mapValue(object.named, `${path}.named`, context); Object.entries(named).forEach(([key, item]) => nested(item, childPath(`${path}.named`, key))); return;
  }
  fail("CUT_IR_ENUM", `${path}.kind`, `unknown IRValue kind “${kind}”.`);
}

function moduleValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["specifier", "version", "integrity"]);
  stringValue(object.specifier, `${path}.specifier`, context); stringValue(object.version, `${path}.version`, context); hashValue(object.integrity, `${path}.integrity`, context);
}

function sourceModuleValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["specifier", "sha256", "bytes"]);
  const specifier = stringValue(object.specifier, `${path}.specifier`, context);
  if (!/^\.\/(?:[^./][^/]*\/)*[^./][^/]*\.cut$/.test(specifier) || specifier.split("/").some((segment) => segment === "..")) {
    fail("CUT_IR_STRING", `${path}.specifier`, "must be a canonical project-relative ./path.cut module specifier.");
  }
  hashValue(object.sha256, `${path}.sha256`, context);
  safeInteger(object.bytes, `${path}.bytes`, 0);
}

function resourceValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "name", "kind", "locator", "state", "provenance"], ["byteAuthority", "proxy", "sha256", "metadata", "streamSelection"]);
  idValue(object.id, `${path}.id`, context); stringValue(object.name, `${path}.name`, context); const kind = enumValue(object.kind, `${path}.kind`, new Set(["video", "audio", "image", "font", "data"]));
  stringValue(object.locator, `${path}.locator`, context); const state = enumValue(object.state, `${path}.state`, new Set(["unlocked", "locked"])); provenance(object.provenance, `${path}.provenance`, context);
  if (Object.hasOwn(object, "byteAuthority")) {
    if (kind !== "data") fail("CUT_TYPED_DATA_ASSET_AUTHORITY", `${path}.byteAuthority`, "is valid only on the compatible outer data resource kind.");
    try { validateCutTypedDataAssetAuthority(object.byteAuthority, `${path}.byteAuthority`); }
    catch (error) {
      if (error instanceof CutTypedDataAssetAuthorityError) fail(error.code, error.path, error.message.replace(/^CUT_TYPED_DATA_ASSET_AUTHORITY at [^:]+:\s*/u, ""));
      throw error;
    }
  }
  const mediaStreamSelection = (selectionValue: unknown, selectionPath: string) => {
    const selection = closed(selectionValue, selectionPath, [], ["video", "audio"]);
    if (!Object.keys(selection).length) fail("CUT_IR_TYPE", selectionPath, "must select at least one media stream.");
    if (Object.hasOwn(selection, "video")) safeInteger(selection.video, `${selectionPath}.video`, 0);
    if (Object.hasOwn(selection, "audio")) safeInteger(selection.audio, `${selectionPath}.audio`, 0);
    return selection;
  };
  if (Object.hasOwn(object, "streamSelection")) {
    if (kind !== "video" && kind !== "audio") fail("CUT_IR_TYPE", `${path}.streamSelection`, "is valid only for video/audio resources.");
    const selection = mediaStreamSelection(object.streamSelection, `${path}.streamSelection`);
    if (kind === "audio" && Object.hasOwn(selection, "video")) fail("CUT_IR_TYPE", `${path}.streamSelection.video`, "is not valid for an AudioAsset.");
  }
  if (Object.hasOwn(object, "proxy")) {
    if (kind !== "video" && kind !== "audio") fail("CUT_IR_TYPE", `${path}.proxy`, "is valid only for video/audio resources.");
    const proxy = closed(object.proxy, `${path}.proxy`, ["locator"], ["streamSelection"]);
    stringValue(proxy.locator, `${path}.proxy.locator`, context);
    if (proxy.locator === object.locator) fail("CUT_IR_DETERMINISM", `${path}.proxy.locator`, "must differ from the master locator.");
    if (Object.hasOwn(proxy, "streamSelection")) {
      const selection = mediaStreamSelection(proxy.streamSelection, `${path}.proxy.streamSelection`);
      if (kind === "audio" && Object.hasOwn(selection, "video")) fail("CUT_IR_TYPE", `${path}.proxy.streamSelection.video`, "is not valid for an AudioAsset proxy.");
    }
  }
  const hasHash = Object.hasOwn(object, "sha256");
  if (hasHash) hashValue(object.sha256, `${path}.sha256`, context);
  if (state === "locked" && !hasHash) fail("CUT_IR_DETERMINISM", path, "locked resource is missing sha256.");
  if (state === "unlocked" && hasHash) fail("CUT_IR_DETERMINISM", path, "unlocked resource cannot claim a sha256 lock.");
  if (Object.hasOwn(object, "metadata")) metadataValue(object.metadata, `${path}.metadata`, context);
}

function editorialIntervalValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["start", "duration"]);
  const start = rationalValue(object.start, `${path}.start`, context);
  const duration = rationalValue(object.duration, `${path}.duration`, context);
  if (compareRational(start, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) {
    fail("CUT_IR_TIMING", path, "editorial interval start must be non-negative and duration must be positive.");
  }
}

function editorialLinkValue(value: unknown, path: string, context: ValidationContext) {
  const link = stringValue(value, path, context);
  if (!link || link !== link.trim() || link.length > 128 || /[\u0000-\u001f\u007f]/.test(link)) {
    fail("CUT_IR_STRING", path, "must be a non-empty trimmed editorial link of at most 128 characters without control characters.");
  }
}

const timelineEditStableIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

function timelineEditStableIdValue(value: unknown, path: string, context: ValidationContext) {
  const id = stringValue(value, path, context);
  if (!timelineEditStableIdPattern.test(id)) {
    fail("CUT_IR_STRING", path, "must begin with an ASCII letter and contain at most 128 letters, digits, dot, underscore, or hyphen.");
  }
  return id;
}

function editorialRoleValue(value: unknown, path: string, context: ValidationContext) {
  const role = stringValue(value, path, context);
  if (role !== role.trim() || !role.length || role.length > 128 || /[\u0000-\u001f\u007f]/u.test(role)) {
    fail("CUT_IR_STRING", path, "must be one trimmed non-empty editorial role of at most 128 characters without control characters.");
  }
  return role;
}

function editorialStringMetadataValue(value: unknown, path: string, context: ValidationContext) {
  const metadata = mapValue(value, path, context, timelineEditLimits.maximumMetadataEntries);
  let bytes = 0;
  for (const [key, raw] of Object.entries(metadata)) {
    if (!/^(?![Cc][Uu][Tt]\.)(?:[A-Za-z][A-Za-z0-9_-]*\.)+[A-Za-z][A-Za-z0-9_-]*$/u.test(key)
      || key.length > 128) {
      fail("CUT_IR_STRING", `${path}.${key}`, "must be one bounded non-CUT dotted metadata namespace.");
    }
    const text = stringValue(raw, childPath(path, key), context, true);
    if (text.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(text)) {
      fail("CUT_IR_STRING", childPath(path, key), "must be a printable bounded string of at most 1024 characters.");
    }
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(text, "utf8");
  }
  if (bytes > timelineEditLimits.maximumTextBytes) {
    fail("CUT_IR_LIMIT", path, `exceeds the ${timelineEditLimits.maximumTextBytes}-byte timeline-edit metadata budget.`);
  }
}

function linkedSegmentIdsValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["before", "after"]);
  const before = idValue(object.before, `${path}.before`, context);
  const after = idValue(object.after, `${path}.after`, context);
  if (before === after) fail("CUT_IR_IDENTITY", path, "before and after linked segment ids must be distinct.");
  return { before, after };
}

function pictureTimeMapValue(value: unknown, path: string, context: ValidationContext) {
  const base = record(value, path);
  const kind = enumValue(base.kind, `${path}.kind`, new Set(["constant", "freeze", "speed-ramp"]));
  if (kind === "constant") {
    const object = closed(value, path, ["kind", "direction", "rate"], ["frameSelection"]);
    enumValue(object.direction, `${path}.direction`, new Set(["forward", "reverse"]));
    const rate = rationalValue(object.rate, `${path}.rate`, context);
    if (compareRational(rate, zeroRational) <= 0) fail("CUT_IR_TIMING", `${path}.rate`, "constant picture rate must be positive.");
    if (Object.hasOwn(object, "frameSelection")) {
      enumValue(object.frameSelection, `${path}.frameSelection`, new Set(["nearest", "frame-blend"]));
    }
    return;
  }
  if (kind === "speed-ramp") {
    const object = closed(value, path, ["kind", "interpolation", "frameSelection", "points"]);
    enumValue(object.interpolation, `${path}.interpolation`, new Set(["linear-rate"]));
    enumValue(object.frameSelection, `${path}.frameSelection`, new Set(["floor", "nearest", "frame-blend"]));
    const points = arrayValue(object.points, `${path}.points`, context);
    if (points.length < 2 || points.length > 32) fail("CUT_IR_LIMIT", `${path}.points`, "speed-ramp must contain 2 through 32 points.");
    let previous: Rational | undefined;
    points.forEach((value, index) => {
      const pointPath = `${path}.points[${index}]`, point = closed(value, pointPath, ["at", "rate"]);
      const at = rationalValue(point.at, `${pointPath}.at`, context), rate = rationalValue(point.rate, `${pointPath}.rate`, context);
      if (compareRational(rate, rational(1, 64)) < 0 || compareRational(rate, rational(64)) > 0) fail("CUT_IR_TIMING", `${pointPath}.rate`, "speed-ramp rate must be between 1/64 and 64 inclusive.");
      if (previous !== undefined && compareRational(at, previous) <= 0) fail("CUT_IR_TIMING", `${pointPath}.at`, "speed-ramp point times must be strictly increasing.");
      previous = at;
    });
    if (compareRational(rationalValue(record(points[0], `${path}.points[0]`).at, `${path}.points[0].at`, context), zeroRational) !== 0) fail("CUT_IR_TIMING", `${path}.points[0].at`, "speed-ramp must begin at zero.");
    return;
  }
  const object = closed(value, path, ["kind", "at"], ["frameSelection"]);
  if (Object.hasOwn(object, "frameSelection")) {
    enumValue(object.frameSelection, `${path}.frameSelection`, new Set(["frame-blend"]));
  }
  const at = rationalValue(object.at, `${path}.at`, context);
  if (compareRational(at, zeroRational) < 0) fail("CUT_IR_TIMING", `${path}.at`, "freeze picture time cannot be negative.");
}

function editorialPictureEditItemValue(value: unknown, path: string, context: ValidationContext, ownerId: string) {
  const base = record(value, path), kind = enumValue(base.kind, `${path}.kind`, new Set(["picture", "gap"]));
  const item = closed(value, path, ["origin", "kind", "destination", "inputs", "provenance", ...(kind === "picture" ? ["source"] : [])], kind === "picture" ? ["timeMap", "linkSegmentId"] : []);
  stringValue(item.origin, `${path}.origin`, context); editorialIntervalValue(item.destination, `${path}.destination`, context); provenance(item.provenance, `${path}.provenance`, context);
  const inputs = mapValue(item.inputs, `${path}.inputs`, context);
  Object.entries(inputs).forEach(([key, input]) => irValue(input, childPath(`${path}.inputs`, key), context, 0, ownerId));
  if (kind === "picture") {
    editorialIntervalValue(item.source, `${path}.source`, context);
    if (Object.hasOwn(item, "timeMap")) pictureTimeMapValue(item.timeMap, `${path}.timeMap`, context);
    if (Object.hasOwn(item, "linkSegmentId")) {
      idValue(item.linkSegmentId, `${path}.linkSegmentId`, context);
      const link = record(item.inputs, `${path}.inputs`).link;
      if (!isRecord(link) || link.kind !== "string") fail("CUT_IR_IDENTITY", `${path}.linkSegmentId`, "requires authored PictureClip link input metadata.");
    }
  }
}

function editorialPictureTransitionStyleValue(value: unknown, path: string, context: ValidationContext) {
  const base = record(value, path);
  const kind = enumValue(base.kind, `${path}.kind`, new Set(["cross-dissolve", "dip", "wipe", "push", "slide"]));
  if (kind === "cross-dissolve") { closed(value, path, ["kind"]); return; }
  if (kind === "dip") {
    const object = closed(value, path, ["kind", "color"]);
    const color = stringValue(object.color, `${path}.color`, context);
    if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(color)) fail("CUT_IR_STRING", `${path}.color`, "must be a six- or eight-digit hexadecimal color.");
    return;
  }
  if (kind === "wipe") {
    const object = closed(value, path, ["kind", "direction", "softness"]);
    enumValue(object.direction, `${path}.direction`, new Set(["left", "right", "up", "down"]));
    const softness = rationalValue(object.softness, `${path}.softness`, context);
    if (compareRational(softness, zeroRational) < 0 || compareRational(softness, rational(1)) > 0) fail("CUT_IR_TIMING", `${path}.softness`, "must be in [0, 1].");
    return;
  }
  const object = closed(value, path, ["kind", "direction"]);
  enumValue(object.direction, `${path}.direction`, new Set(["left", "right", "up", "down"]));
}

function editorialOperationValue(value: unknown, path: string, context: ValidationContext, ownerId: string) {
  const base = record(value, path), kind = enumValue(base.kind, `${path}.kind`, new Set(["split", "trim", "ripple-insert", "ripple-delete", "overwrite", "replace", "lift", "extract", "slip", "slide", "transition"]));
  const fields = kind === "split" ? ["at"] : kind === "transition" ? ["at", "duration", "style"] : kind === "trim" ? ["keep"] : kind === "ripple-insert" ? ["at", "item"] : kind === "overwrite" || kind === "replace" ? ["range", "item"] : kind === "slip" || kind === "slide" ? ["range", "by"] : ["range"];
  const operation = closed(value, path, ["kind", ...fields, "provenance"], kind === "trim" || kind === "ripple-insert" ? ["transactionId"] : kind === "ripple-delete" ? ["transactionId", "transactionVersion", "linkSegmentIds"] : []);
  provenance(operation.provenance, `${path}.provenance`, context);
  if (Object.hasOwn(operation, "transactionId")) idValue(operation.transactionId, `${path}.transactionId`, context);
  const transactionVersion = Object.hasOwn(operation, "transactionVersion")
    ? safeInteger(operation.transactionVersion, `${path}.transactionVersion`, 1)
    : undefined;
  if (transactionVersion !== undefined && transactionVersion !== 1 && transactionVersion !== 2) fail("CUT_IR_ENUM", `${path}.transactionVersion`, "must be exactly 1 or 2.");
  if (Object.hasOwn(operation, "linkSegmentIds")) {
    if (!Object.hasOwn(operation, "transactionId")) fail("CUT_IR_IDENTITY", `${path}.linkSegmentIds`, "requires one correlated transactionId.");
    linkedSegmentIdsValue(operation.linkSegmentIds, `${path}.linkSegmentIds`, context);
  }
  if (kind === "ripple-delete") {
    const hasTransaction = Object.hasOwn(operation, "transactionId"), hasSegments = Object.hasOwn(operation, "linkSegmentIds");
    if (!hasTransaction && transactionVersion !== undefined) fail("CUT_IR_IDENTITY", `${path}.transactionVersion`, "requires one correlated transactionId.");
    if (hasTransaction && transactionVersion === undefined) fail("CUT_IR_IDENTITY", `${path}.transactionVersion`, "is required with a correlated transactionId.");
    if (transactionVersion === 1 && hasSegments) fail("CUT_IR_IDENTITY", `${path}.linkSegmentIds`, "is not allowed for transactionVersion 1.");
    if (transactionVersion === 2 && !hasSegments) fail("CUT_IR_IDENTITY", `${path}.linkSegmentIds`, "is required for transactionVersion 2.");
  }
  if (Object.hasOwn(operation, "at")) {
    const at = rationalValue(operation.at, `${path}.at`, context);
    if (compareRational(at, zeroRational) < 0) fail("CUT_IR_TIMING", `${path}.at`, "edit point cannot be negative.");
  }
  if (Object.hasOwn(operation, "keep")) editorialIntervalValue(operation.keep, `${path}.keep`, context);
  if (Object.hasOwn(operation, "range")) editorialIntervalValue(operation.range, `${path}.range`, context);
  if (Object.hasOwn(operation, "by")) rationalValue(operation.by, `${path}.by`, context);
  if (Object.hasOwn(operation, "item")) editorialPictureEditItemValue(operation.item, `${path}.item`, context, ownerId);
  if (kind === "transition") {
    const duration = rationalValue(operation.duration, `${path}.duration`, context);
    if (compareRational(duration, zeroRational) <= 0) fail("CUT_IR_TIMING", `${path}.duration`, "transition duration must be positive.");
    editorialPictureTransitionStyleValue(operation.style, `${path}.style`, context);
  }
}

function editorialOperationPlanValue(value: unknown, path: string, context: ValidationContext, ownerId: string) {
  const object = closed(value, path, ["version", "sourceDuration", "baseItems", "operations"]);
  if (safeInteger(object.version, `${path}.version`, 1) !== 1) fail("CUT_IR_ENUM", `${path}.version`, "must be operation-plan version 1.");
  const sourceDuration = rationalValue(object.sourceDuration, `${path}.sourceDuration`, context);
  if (compareRational(sourceDuration, zeroRational) <= 0) fail("CUT_IR_TIMING", `${path}.sourceDuration`, "must be positive.");
  const baseItems = arrayValue(object.baseItems, `${path}.baseItems`, context);
  if (!baseItems.length) fail("CUT_IR_TYPE", `${path}.baseItems`, "must contain at least one source picture item or gap.");
  baseItems.forEach((item, index) => {
    editorialPictureEditItemValue(item, `${path}.baseItems[${index}]`, context, ownerId);
    if (record(item, `${path}.baseItems[${index}]`).origin !== `base:${index}`) fail("CUT_IR_IDENTITY", `${path}.baseItems[${index}].origin`, `must equal canonical source identity “base:${index}”.`);
  });
  const operations = arrayValue(object.operations, `${path}.operations`, context);
  if (!operations.length || operations.length > 256) fail("CUT_IR_LIMIT", `${path}.operations`, "must contain 1 through 256 operations.");
  operations.forEach((operation, index) => {
    editorialOperationValue(operation, `${path}.operations[${index}]`, context, ownerId);
    const candidate = record(operation, `${path}.operations[${index}]`);
    if (Object.hasOwn(candidate, "item") && record(candidate.item, `${path}.operations[${index}].item`).origin !== `operation:${index}`) fail("CUT_IR_IDENTITY", `${path}.operations[${index}].item.origin`, `must equal canonical operand identity “operation:${index}”.`);
  });
}

function editorialAudioEditItemValue(value: unknown, path: string, context: ValidationContext) {
  const base = record(value, path), kind = enumValue(base.kind, `${path}.kind`, new Set(["clip", "gap"]));
  const item = closed(value, path, ["origin", "kind", "destination", "inputs", "provenance", ...(kind === "clip" ? ["source"] : [])], kind === "clip" ? ["linkSegmentId"] : []);
  stringValue(item.origin, `${path}.origin`, context);
  editorialIntervalValue(item.destination, `${path}.destination`, context);
  provenance(item.provenance, `${path}.provenance`, context);
  if (kind === "gap") {
    closed(item.inputs, `${path}.inputs`, []);
    return;
  }
  editorialIntervalValue(item.source, `${path}.source`, context);
  const inputs = closed(item.inputs, `${path}.inputs`, ["resourceId"], ["linkId", "headHandle", "tailHandle"]);
  const resourceId = idValue(inputs.resourceId, `${path}.inputs.resourceId`, context);
  context.references.push({ kind: "resource", id: resourceId, path: `${path}.inputs.resourceId` });
  consumeEdge(context, `${path}.inputs.resourceId`);
  if (Object.hasOwn(inputs, "linkId")) editorialLinkValue(inputs.linkId, `${path}.inputs.linkId`, context);
  if (Object.hasOwn(item, "linkSegmentId")) {
    idValue(item.linkSegmentId, `${path}.linkSegmentId`, context);
    if (!Object.hasOwn(inputs, "linkId")) fail("CUT_IR_IDENTITY", `${path}.linkSegmentId`, "requires authored AudioClip linkId metadata.");
  }
  for (const name of ["headHandle", "tailHandle"] as const) {
    if (!Object.hasOwn(inputs, name)) continue;
    const handle = rationalValue(inputs[name], `${path}.inputs.${name}`, context);
    if (compareRational(handle, zeroRational) < 0) fail("CUT_IR_TIMING", `${path}.inputs.${name}`, "audio handle availability cannot be negative.");
  }
}

function editorialAudioRegionItemValue(value: unknown, path: string, context: ValidationContext) {
  const item = closed(value, path, ["origin", "kind", "regionId", "sourceNodeId", "processorNodeIds", "destination", "source", "inputs", "provenance"]);
  if (item.kind !== "region") fail("CUT_IR_ENUM", `${path}.kind`, "version-2 audio plan items must be processed regions.");
  stringValue(item.origin, `${path}.origin`, context);
  const regionId = idValue(item.regionId, `${path}.regionId`, context);
  const sourceNodeId = idValue(item.sourceNodeId, `${path}.sourceNodeId`, context);
  context.references.push({ kind: "node", id: regionId, path: `${path}.regionId` });
  context.references.push({ kind: "node", id: sourceNodeId, path: `${path}.sourceNodeId` });
  consumeEdge(context, `${path}.regionId`); consumeEdge(context, `${path}.sourceNodeId`);
  const processorNodeIds = uniqueIds(item.processorNodeIds, `${path}.processorNodeIds`, context);
  if (processorNodeIds.length > 32) fail("CUT_IR_LIMIT", `${path}.processorNodeIds`, "processed AudioRegion chain exceeds the 32-node insert bound.");
  processorNodeIds.forEach((id, index) => context.references.push({ kind: "node", id, path: `${path}.processorNodeIds[${index}]` }));
  editorialIntervalValue(item.destination, `${path}.destination`, context);
  editorialIntervalValue(item.source, `${path}.source`, context);
  const inputs = closed(item.inputs, `${path}.inputs`, ["resourceId"], ["linkId", "headHandle", "tailHandle"]);
  const resourceId = idValue(inputs.resourceId, `${path}.inputs.resourceId`, context);
  context.references.push({ kind: "resource", id: resourceId, path: `${path}.inputs.resourceId` });
  consumeEdge(context, `${path}.inputs.resourceId`);
  if (Object.hasOwn(inputs, "linkId")) editorialLinkValue(inputs.linkId, `${path}.inputs.linkId`, context);
  for (const name of ["headHandle", "tailHandle"] as const) {
    if (!Object.hasOwn(inputs, name)) continue;
    const handle = rationalValue(inputs[name], `${path}.inputs.${name}`, context);
    if (compareRational(handle, zeroRational) < 0) fail("CUT_IR_TIMING", `${path}.inputs.${name}`, "processed AudioRegion handle availability cannot be negative.");
  }
  provenance(item.provenance, `${path}.provenance`, context);
}

function editorialAudioOperationValue(value: unknown, path: string, context: ValidationContext) {
  const base = record(value, path), kind = enumValue(base.kind, `${path}.kind`, new Set(["split", "trim", "ripple-insert", "ripple-delete", "overwrite", "replace", "lift", "extract", "slip", "slide", "crossfade"]));
  const fields = kind === "split" ? ["at"] : kind === "crossfade" ? ["at", "duration", "curve"] : kind === "trim" ? ["keep"] : kind === "ripple-insert" ? ["at", "item"] : kind === "overwrite" || kind === "replace" ? ["range", "item"] : kind === "slip" || kind === "slide" ? ["range", "by"] : ["range"];
  const operation = closed(value, path, ["kind", ...fields, "provenance"], kind === "trim" || kind === "ripple-insert" ? ["transactionId"] : kind === "ripple-delete" ? ["transactionId", "transactionVersion", "linkSegmentIds"] : []);
  provenance(operation.provenance, `${path}.provenance`, context);
  if (Object.hasOwn(operation, "transactionId")) idValue(operation.transactionId, `${path}.transactionId`, context);
  const transactionVersion = Object.hasOwn(operation, "transactionVersion")
    ? safeInteger(operation.transactionVersion, `${path}.transactionVersion`, 1)
    : undefined;
  if (transactionVersion !== undefined && transactionVersion !== 1 && transactionVersion !== 2) fail("CUT_IR_ENUM", `${path}.transactionVersion`, "must be exactly 1 or 2.");
  if (Object.hasOwn(operation, "linkSegmentIds")) {
    if (!Object.hasOwn(operation, "transactionId")) fail("CUT_IR_IDENTITY", `${path}.linkSegmentIds`, "requires one correlated transactionId.");
    linkedSegmentIdsValue(operation.linkSegmentIds, `${path}.linkSegmentIds`, context);
  }
  if (kind === "ripple-delete") {
    const hasTransaction = Object.hasOwn(operation, "transactionId"), hasSegments = Object.hasOwn(operation, "linkSegmentIds");
    if (!hasTransaction && transactionVersion !== undefined) fail("CUT_IR_IDENTITY", `${path}.transactionVersion`, "requires one correlated transactionId.");
    if (hasTransaction && transactionVersion === undefined) fail("CUT_IR_IDENTITY", `${path}.transactionVersion`, "is required with a correlated transactionId.");
    if (transactionVersion === 1 && hasSegments) fail("CUT_IR_IDENTITY", `${path}.linkSegmentIds`, "is not allowed for transactionVersion 1.");
    if (transactionVersion === 2 && !hasSegments) fail("CUT_IR_IDENTITY", `${path}.linkSegmentIds`, "is required for transactionVersion 2.");
  }
  if (Object.hasOwn(operation, "at")) {
    const at = rationalValue(operation.at, `${path}.at`, context);
    if (compareRational(at, zeroRational) < 0) fail("CUT_IR_TIMING", `${path}.at`, "audio edit point cannot be negative.");
  }
  if (Object.hasOwn(operation, "keep")) editorialIntervalValue(operation.keep, `${path}.keep`, context);
  if (Object.hasOwn(operation, "range")) editorialIntervalValue(operation.range, `${path}.range`, context);
  if (Object.hasOwn(operation, "by")) rationalValue(operation.by, `${path}.by`, context);
  if (Object.hasOwn(operation, "item")) editorialAudioEditItemValue(operation.item, `${path}.item`, context);
  if (kind === "crossfade") {
    const duration = rationalValue(operation.duration, `${path}.duration`, context);
    if (compareRational(duration, zeroRational) <= 0) fail("CUT_IR_TIMING", `${path}.duration`, "audio crossfade duration must be positive.");
    enumValue(operation.curve, `${path}.curve`, new Set(["equal-power", "linear"]));
  }
}

function editorialAudioOperationPlanValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["version", "sourceDuration", "baseItems", "operations"]);
  const version = safeInteger(object.version, `${path}.version`, 1);
  if (version !== 1 && version !== 2) fail("CUT_IR_ENUM", `${path}.version`, "must be audio operation-plan version 1 or 2.");
  const sourceDuration = rationalValue(object.sourceDuration, `${path}.sourceDuration`, context);
  if (compareRational(sourceDuration, zeroRational) <= 0) fail("CUT_IR_TIMING", `${path}.sourceDuration`, "must be positive.");
  const baseItems = arrayValue(object.baseItems, `${path}.baseItems`, context);
  if (!baseItems.length || baseItems.length > 10_000) fail("CUT_IR_LIMIT", `${path}.baseItems`, version === 2 ? "must contain 1 through 10,000 processed AudioRegion items." : "must contain 1 through 10,000 source audio items or explicit gaps.");
  baseItems.forEach((item, index) => {
    if (version === 2) editorialAudioRegionItemValue(item, `${path}.baseItems[${index}]`, context);
    else editorialAudioEditItemValue(item, `${path}.baseItems[${index}]`, context);
    if (record(item, `${path}.baseItems[${index}]`).origin !== `base:${index}`) fail("CUT_IR_IDENTITY", `${path}.baseItems[${index}].origin`, `must equal canonical source identity “base:${index}”.`);
  });
  const operations = arrayValue(object.operations, `${path}.operations`, context);
  if (!operations.length || operations.length > 256) fail("CUT_IR_LIMIT", `${path}.operations`, "must contain 1 through 256 audio edit operations.");
  operations.forEach((operation, index) => {
    if (version === 2 && record(operation, `${path}.operations[${index}]`).kind !== "crossfade") {
      fail("CUT_IR_ENUM", `${path}.operations[${index}].kind`, "version-2 processed AudioRegion plans are crossfade-only.");
    }
    editorialAudioOperationValue(operation, `${path}.operations[${index}]`, context);
    const candidate = record(operation, `${path}.operations[${index}]`);
    if (Object.hasOwn(candidate, "item") && record(candidate.item, `${path}.operations[${index}].item`).origin !== `operation:${index}`) fail("CUT_IR_IDENTITY", `${path}.operations[${index}].item.origin`, `must equal canonical operand identity “operation:${index}”.`);
  });
}

function editorialValue(value: unknown, path: string, context: ValidationContext, ownerId: string) {
  const base = record(value, path);
  const kind = stringValue(base.kind, `${path}.kind`, context);
  if (kind === "sequence") {
    const object = closed(value, path, ["kind", "tracks"]);
    const tracks = arrayValue(object.tracks, `${path}.tracks`, context);
    if (!tracks.length) fail("CUT_IR_TYPE", `${path}.tracks`, "must contain at least one picture track.");
    tracks.forEach((value, index) => {
      const trackPath = `${path}.tracks[${index}]`;
      const track = closed(value, trackPath, ["nodeId", "order", "destination"]);
      idValue(track.nodeId, `${trackPath}.nodeId`, context);
      if (safeInteger(track.order, `${trackPath}.order`, 0) !== index) fail("CUT_IR_IDENTITY", `${trackPath}.order`, `must equal its source-order index ${index}.`);
      editorialIntervalValue(track.destination, `${trackPath}.destination`, context);
    });
    return;
  }
  if (kind === "picture-track") {
    const object = closed(value, path, ["kind", "items"], ["operationPlan", "transitions", "trackId", "role", "metadata"]);
    if (Object.hasOwn(object, "trackId")) timelineEditStableIdValue(object.trackId, `${path}.trackId`, context);
    if (Object.hasOwn(object, "role")) editorialRoleValue(object.role, `${path}.role`, context);
    if (Object.hasOwn(object, "metadata")) editorialStringMetadataValue(object.metadata, `${path}.metadata`, context);
    const items = arrayValue(object.items, `${path}.items`, context);
    if (!items.length) fail("CUT_IR_TYPE", `${path}.items`, "must contain at least one picture item or explicit gap.");
    items.forEach((value, index) => {
      const itemPath = `${path}.items[${index}]`;
      const itemBase = record(value, itemPath);
      const itemKind = enumValue(itemBase.kind, `${itemPath}.kind`, new Set(["picture", "gap"]));
      const item = closed(
        value,
        itemPath,
        ["nodeId", "order", "kind", "destination", ...(itemKind === "picture" ? ["source"] : [])],
        itemKind === "picture"
          ? ["linkId", "timeMap", "linkSegmentId", "editId", "role", "metadata"]
          : ["editId", "role", "metadata"],
      );
      idValue(item.nodeId, `${itemPath}.nodeId`, context);
      if (Object.hasOwn(item, "editId")) timelineEditStableIdValue(item.editId, `${itemPath}.editId`, context);
      if (Object.hasOwn(item, "role")) editorialRoleValue(item.role, `${itemPath}.role`, context);
      if (Object.hasOwn(item, "metadata")) editorialStringMetadataValue(item.metadata, `${itemPath}.metadata`, context);
      if (safeInteger(item.order, `${itemPath}.order`, 0) !== index) fail("CUT_IR_IDENTITY", `${itemPath}.order`, `must equal its temporal source-order index ${index}.`);
      editorialIntervalValue(item.destination, `${itemPath}.destination`, context);
      if (itemKind === "picture") {
        editorialIntervalValue(item.source, `${itemPath}.source`, context);
        if (Object.hasOwn(item, "timeMap")) pictureTimeMapValue(item.timeMap, `${itemPath}.timeMap`, context);
        if (Object.hasOwn(item, "linkId")) editorialLinkValue(item.linkId, `${itemPath}.linkId`, context);
        if (Object.hasOwn(item, "linkSegmentId")) {
          idValue(item.linkSegmentId, `${itemPath}.linkSegmentId`, context);
          if (!Object.hasOwn(item, "linkId")) fail("CUT_IR_IDENTITY", `${itemPath}.linkSegmentId`, "requires authored picture linkId metadata.");
        }
      }
    });
    if (Object.hasOwn(object, "operationPlan")) editorialOperationPlanValue(object.operationPlan, `${path}.operationPlan`, context, ownerId);
    if (Object.hasOwn(object, "transitions")) {
      const transitions = arrayValue(object.transitions, `${path}.transitions`, context);
      if (!transitions.length) fail("CUT_IR_TYPE", `${path}.transitions`, "must be omitted rather than encoded as an empty list.");
      transitions.forEach((value, index) => {
        const transitionPath = `${path}.transitions[${index}]`;
        const transition = closed(value, transitionPath, ["cut", "duration", "overlap", "outgoingNodeId", "incomingNodeId", "outgoingSource", "incomingSource", "style", "provenance"]);
        const cut = rationalValue(transition.cut, `${transitionPath}.cut`, context);
        const duration = rationalValue(transition.duration, `${transitionPath}.duration`, context);
        if (compareRational(cut, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) fail("CUT_IR_TIMING", transitionPath, "transition cut must be non-negative and duration positive.");
        editorialIntervalValue(transition.overlap, `${transitionPath}.overlap`, context);
        idValue(transition.outgoingNodeId, `${transitionPath}.outgoingNodeId`, context);
        idValue(transition.incomingNodeId, `${transitionPath}.incomingNodeId`, context);
        editorialIntervalValue(transition.outgoingSource, `${transitionPath}.outgoingSource`, context);
        editorialIntervalValue(transition.incomingSource, `${transitionPath}.incomingSource`, context);
        editorialPictureTransitionStyleValue(transition.style, `${transitionPath}.style`, context);
        provenance(transition.provenance, `${transitionPath}.provenance`, context);
      });
    }
    return;
  }
  if (kind === "audio-track") {
    const object = closed(value, path, ["kind", "items"], ["operationPlan", "transitions", "trackId", "role", "metadata"]);
    if (Object.hasOwn(object, "trackId")) timelineEditStableIdValue(object.trackId, `${path}.trackId`, context);
    if (Object.hasOwn(object, "role")) editorialRoleValue(object.role, `${path}.role`, context);
    if (Object.hasOwn(object, "metadata")) editorialStringMetadataValue(object.metadata, `${path}.metadata`, context);
    const items = arrayValue(object.items, `${path}.items`, context);
    if (!items.length) fail("CUT_IR_TYPE", `${path}.items`, "must contain at least one audio item or explicit audio gap.");
    items.forEach((value, index) => {
      const itemPath = `${path}.items[${index}]`;
      const itemBase = record(value, itemPath);
      const itemKind = enumValue(itemBase.kind, `${itemPath}.kind`, new Set(["audio", "gap"]));
      const item = closed(
        value,
        itemPath,
        ["nodeId", "order", "kind", "destination", ...(itemKind === "audio" ? ["source"] : [])],
        itemKind === "audio"
          ? ["linkId", "sourceNodeId", "linkSegmentId", "editId", "role", "metadata"]
          : ["editId", "role", "metadata"],
      );
      idValue(item.nodeId, `${itemPath}.nodeId`, context);
      if (Object.hasOwn(item, "editId")) timelineEditStableIdValue(item.editId, `${itemPath}.editId`, context);
      if (Object.hasOwn(item, "role")) editorialRoleValue(item.role, `${itemPath}.role`, context);
      if (Object.hasOwn(item, "metadata")) editorialStringMetadataValue(item.metadata, `${itemPath}.metadata`, context);
      if (Object.hasOwn(item, "sourceNodeId")) idValue(item.sourceNodeId, `${itemPath}.sourceNodeId`, context);
      if (safeInteger(item.order, `${itemPath}.order`, 0) !== index) fail("CUT_IR_IDENTITY", `${itemPath}.order`, `must equal its temporal source-order index ${index}.`);
      editorialIntervalValue(item.destination, `${itemPath}.destination`, context);
      if (itemKind === "audio") {
        editorialIntervalValue(item.source, `${itemPath}.source`, context);
        if (Object.hasOwn(item, "linkId")) editorialLinkValue(item.linkId, `${itemPath}.linkId`, context);
        if (Object.hasOwn(item, "linkSegmentId")) {
          idValue(item.linkSegmentId, `${itemPath}.linkSegmentId`, context);
          if (!Object.hasOwn(item, "linkId")) fail("CUT_IR_IDENTITY", `${itemPath}.linkSegmentId`, "requires authored audio linkId metadata.");
        }
      }
    });
    if (Object.hasOwn(object, "operationPlan")) editorialAudioOperationPlanValue(object.operationPlan, `${path}.operationPlan`, context);
    if (Object.hasOwn(object, "transitions")) {
      if (!Object.hasOwn(object, "operationPlan") && !Object.hasOwn(object, "trackId")) {
        fail("CUT_IR_TYPE", `${path}.transitions`, "audio crossfades require either their closed legacy operationPlan or one stable trackId owned by a canonical TimelineEdit replay.");
      }
      const transitions = arrayValue(object.transitions, `${path}.transitions`, context);
      if (!transitions.length || transitions.length > 256) fail("CUT_IR_LIMIT", `${path}.transitions`, "must contain 1 through 256 audio crossfades or be omitted.");
      transitions.forEach((value, index) => {
        const transitionPath = `${path}.transitions[${index}]`;
        const transition = closed(value, transitionPath, ["cut", "duration", "overlap", "outgoingNodeId", "incomingNodeId", "outgoingSource", "incomingSource", "curve", "provenance"]);
        const cut = rationalValue(transition.cut, `${transitionPath}.cut`, context), duration = rationalValue(transition.duration, `${transitionPath}.duration`, context);
        if (compareRational(cut, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) fail("CUT_IR_TIMING", transitionPath, "audio crossfade cut must be non-negative and duration positive.");
        editorialIntervalValue(transition.overlap, `${transitionPath}.overlap`, context);
        idValue(transition.outgoingNodeId, `${transitionPath}.outgoingNodeId`, context);
        idValue(transition.incomingNodeId, `${transitionPath}.incomingNodeId`, context);
        editorialIntervalValue(transition.outgoingSource, `${transitionPath}.outgoingSource`, context);
        editorialIntervalValue(transition.incomingSource, `${transitionPath}.incomingSource`, context);
        enumValue(transition.curve, `${transitionPath}.curve`, new Set(["equal-power", "linear"]));
        provenance(transition.provenance, `${transitionPath}.provenance`, context);
      });
    }
    return;
  }
  fail("CUT_IR_ENUM", `${path}.kind`, "must be sequence, picture-track, or audio-track.");
}

function nodeValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "op", "domain", "ownership", "interval", "inputs", "children", "properties", "effects", "contentHash", "provenance"], ["sceneId", "editorial"]);
  const id = idValue(object.id, `${path}.id`, context); stringValue(object.op, `${path}.op`, context); domainValue(object.domain, `${path}.domain`);
  enumValue(object.ownership, `${path}.ownership`, new Set(["root", "child", "reference", "detached"]));
  if (Object.hasOwn(object, "sceneId")) idValue(object.sceneId, `${path}.sceneId`, context);
  const interval = closed(object.interval, `${path}.interval`, ["start", "duration"]); const start = rationalValue(interval.start, `${path}.interval.start`, context); const duration = rationalValue(interval.duration, `${path}.interval.duration`, context);
  if (compareRational(start, zeroRational) < 0 || compareRational(duration, zeroRational) < 0) fail("CUT_IR_TIMING", `${path}.interval`, "start and duration must be non-negative.");
  const inputs = mapValue(object.inputs, `${path}.inputs`, context); Object.entries(inputs).forEach(([key, item]) => irValue(item, childPath(`${path}.inputs`, key), context, 0, id));
  uniqueIds(object.children, `${path}.children`, context);
  if (Object.hasOwn(object, "editorial")) editorialValue(object.editorial, `${path}.editorial`, context, id);
  const properties = mapValue(object.properties, `${path}.properties`, context);
  for (const [key, item] of Object.entries(properties)) {
    const propertyPath = childPath(`${path}.properties`, key);
    if (isRecord(item) && Object.hasOwn(item, "signal") && !Object.hasOwn(item, "kind")) {
      const signal = closed(item, propertyPath, ["signal"]); const signalId = idValue(signal.signal, `${propertyPath}.signal`, context);
      context.signalReferences.push({ id: signalId, path: `${propertyPath}.signal` }); consumeEdge(context, `${propertyPath}.signal`);
    } else irValue(item, propertyPath, context, 0, id);
  }
  const nodeEffects = arrayValue(object.effects, `${path}.effects`, context); if (!nodeEffects.length) fail("CUT_IR_TYPE", `${path}.effects`, "must contain at least one declared effect capability.");
  nodeEffects.forEach((effect, index) => effectValue(effect, `${path}.effects[${index}]`));
  if (new Set(nodeEffects).size !== nodeEffects.length) fail("CUT_IR_IDENTITY", `${path}.effects`, "contains duplicate effect capabilities.");
  hashValue(object.contentHash, `${path}.contentHash`, context); provenance(object.provenance, `${path}.provenance`, context);
}

function validateSignalTimes(signal: IRSignal, path: string) {
  let previous: Rational | undefined;
  const next = (time: Rational, timePath: string) => {
    if (compareRational(time, zeroRational) < 0) fail("CUT_IR_TIMING", timePath, "must be non-negative.");
    if (previous && compareRational(time, previous) < 0) fail("CUT_IR_TIMING", timePath, "must be in nondecreasing temporal order.");
    previous = time;
  };
  if (signal.kind === "step") signal.points.forEach((point, index) => next(point.time, `${path}.points[${index}].time`));
  else if (signal.kind === "keyframes") signal.keyframes.forEach((point, index) => next(point.time, `${path}.keyframes[${index}].time`));
  else if (signal.kind === "track") signal.events.forEach((event, index) => {
    const start = event.kind === "set" ? event.time : event.start; next(start, `${path}.events[${index}].${event.kind === "set" ? "time" : "start"}`);
    if (event.kind === "animate" && compareRational(event.end, event.start) <= 0) fail("CUT_IR_TIMING", `${path}.events[${index}].end`, "must be later than animate.start.");
  });
}

function audioAmplitudeProducerValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, [
    "format", "version", "source", "scope", "range", "at", "detector",
    "window", "hop", "attack", "release", "floor", "ceiling", "mapping",
  ]);
  if (stringValue(object.format, `${path}.format`, context) !== "cut-audio-amplitude-producer") {
    fail("CUT_AUDIO_REACTIVE_IDENTITY", `${path}.format`, "must be cut-audio-amplitude-producer.");
  }
  if (safeInteger(object.version, `${path}.version`, 1) !== 1) fail("CUT_AUDIO_REACTIVE_IDENTITY", `${path}.version`, "must be version 1.");
  const source = closed(object.source, `${path}.source`, ["kind", "id"]);
  if (stringValue(source.kind, `${path}.source.kind`, context) !== "resource-ref") {
    fail("CUT_AUDIO_REACTIVE_RESOURCE", `${path}.source.kind`, "must be resource-ref.");
  }
  const sourceId = idValue(source.id, `${path}.source.id`, context);
  consumeEdge(context, `${path}.source.id`);
  const scope = closed(object.scope, `${path}.scope`, ["compositionId", "sceneId"]);
  const compositionId = idValue(scope.compositionId, `${path}.scope.compositionId`, context);
  const sceneId = idValue(scope.sceneId, `${path}.scope.sceneId`, context);
  const range = closed(object.range, `${path}.range`, ["start", "end"]);
  const rangeStart = rationalValue(range.start, `${path}.range.start`, context);
  const rangeEnd = rationalValue(range.end, `${path}.range.end`, context);
  const at = rationalValue(object.at, `${path}.at`, context);
  const window = rationalValue(object.window, `${path}.window`, context);
  const hop = rationalValue(object.hop, `${path}.hop`, context);
  const attack = rationalValue(object.attack, `${path}.attack`, context);
  const release = rationalValue(object.release, `${path}.release`, context);
  const floor = rationalValue(object.floor, `${path}.floor`, context);
  const ceiling = rationalValue(object.ceiling, `${path}.ceiling`, context);
  if (compareRational(rangeStart, zeroRational) < 0 || compareRational(rangeEnd, rangeStart) <= 0) {
    fail("CUT_AUDIO_REACTIVE_RANGE", `${path}.range`, "must be a non-empty half-open source interval with non-negative start.");
  }
  if (compareRational(at, zeroRational) < 0) fail("CUT_AUDIO_REACTIVE_TIME", `${path}.at`, "must be a non-negative scene-local time.");
  const selectedDuration = subtractRational(rangeEnd, rangeStart);
  if (compareRational(window, zeroRational) <= 0 || compareRational(window, rational(10)) > 0 || compareRational(window, selectedDuration) >= 0) {
    fail("CUT_AUDIO_REACTIVE_RANGE", `${path}.window`, "must be positive, no longer than 10s, and strictly shorter than range.");
  }
  if (compareRational(hop, zeroRational) <= 0 || compareRational(hop, window) > 0) fail("CUT_AUDIO_REACTIVE_RANGE", `${path}.hop`, "must be positive and no longer than window.");
  if (compareRational(attack, zeroRational) <= 0 || compareRational(attack, rational(10)) > 0) fail("CUT_AUDIO_REACTIVE_RANGE", `${path}.attack`, "must be positive and no longer than 10s.");
  if (compareRational(release, zeroRational) <= 0 || compareRational(release, rational(30)) > 0) fail("CUT_AUDIO_REACTIVE_RANGE", `${path}.release`, "must be positive and no longer than 30s.");
  if (compareRational(floor, zeroRational) < 0 || compareRational(ceiling, rational(1)) > 0 || compareRational(ceiling, floor) <= 0) {
    fail("CUT_AUDIO_REACTIVE_NOOP", `${path}.ceiling`, "requires 0 <= floor < ceiling <= 1.");
  }
  const detector = stringValue(object.detector, `${path}.detector`, context);
  if (detector !== "peak" && detector !== "rms") fail("CUT_AUDIO_REACTIVE_TYPE", `${path}.detector`, "must be peak or rms.");
  const mapping = closed(object.mapping, `${path}.mapping`, ["kind", "from", "to"]);
  if (stringValue(mapping.kind, `${path}.mapping.kind`, context) !== "linear") fail("CUT_AUDIO_REACTIVE_TYPE", `${path}.mapping.kind`, "must be linear.");
  irValue(mapping.from, `${path}.mapping.from`, context);
  irValue(mapping.to, `${path}.mapping.to`, context);
  if (stableJsonStringify(mapping.from) === stableJsonStringify(mapping.to)) {
    fail("CUT_AUDIO_REACTIVE_NOOP", `${path}.mapping.to`, "must differ from mapping.from.");
  }
  return {
    sourceId,
    compositionId,
    sceneId,
    rangeStart,
    rangeEnd,
    at,
    window,
    hop,
    attack,
    release,
    from: mapping.from as IRValue,
    to: mapping.to as IRValue,
  };
}

function signalValue(value: unknown, path: string, context: ValidationContext) {
  const base = record(value, path); const kind = stringValue(base.kind, `${path}.kind`, context);
  const common = ["id", "kind", "valueType", "contentHash", "provenance"];
  if (Object.hasOwn(base, "producer") && kind !== "track") {
    fail("CUT_AUDIO_REACTIVE_CONFLICT", `${path}.producer`, "a producer is valid only on a track and cannot be combined with constant, step, or keyframe semantics.");
  }
  const valueItem = (item: unknown, itemPath: string) => irValue(item, itemPath, context);
  if (kind === "constant") {
    const object = closed(value, path, [...common, "value"]); valueItem(object.value, `${path}.value`);
  } else if (kind === "step") {
    const object = closed(value, path, [...common, "points"]); const points = arrayValue(object.points, `${path}.points`, context);
    if (!points.length) fail("CUT_IR_TYPE", `${path}.points`, "must contain at least one typed value point.");
    points.forEach((point, index) => {
      const pointPath = `${path}.points[${index}]`; const entry = closed(point, pointPath, ["time", "value"]); rationalValue(entry.time, `${pointPath}.time`, context); valueItem(entry.value, `${pointPath}.value`);
    });
  } else if (kind === "keyframes") {
    const object = closed(value, path, [...common, "keyframes"]); const keyframes = arrayValue(object.keyframes, `${path}.keyframes`, context);
    if (!keyframes.length) fail("CUT_IR_TYPE", `${path}.keyframes`, "must contain at least one typed keyframe.");
    keyframes.forEach((point, index) => {
      const pointPath = `${path}.keyframes[${index}]`; const entry = closed(point, pointPath, ["time", "value", "curve"]); rationalValue(entry.time, `${pointPath}.time`, context); valueItem(entry.value, `${pointPath}.value`); valueItem(entry.curve, `${pointPath}.curve`);
    });
  } else if (kind === "track") {
    const object = closed(value, path, [...common, "initial", "events"], ["producer"]); valueItem(object.initial, `${path}.initial`);
    const events = arrayValue(object.events, `${path}.events`, context);
    if (!events.length && !Object.hasOwn(object, "producer")) {
      fail("CUT_IR_TYPE", `${path}.events`, "a non-producer track must contain at least one typed event.");
    }
    events.forEach((event, index) => {
      const eventPath = `${path}.events[${index}]`; const raw = record(event, eventPath); const eventKind = stringValue(raw.kind, `${eventPath}.kind`, context);
      if (eventKind === "set") { const entry = closed(event, eventPath, ["kind", "time", "value"]); rationalValue(entry.time, `${eventPath}.time`, context); valueItem(entry.value, `${eventPath}.value`); }
      else if (eventKind === "animate") { const entry = closed(event, eventPath, ["kind", "start", "end", "from", "to", "curve"]); rationalValue(entry.start, `${eventPath}.start`, context); rationalValue(entry.end, `${eventPath}.end`, context); valueItem(entry.from, `${eventPath}.from`); valueItem(entry.to, `${eventPath}.to`); valueItem(entry.curve, `${eventPath}.curve`); }
      else fail("CUT_IR_ENUM", `${eventPath}.kind`, "must be set or animate.");
    });
    if (Object.hasOwn(object, "producer")) {
      const producer = audioAmplitudeProducerValue(object.producer, `${path}.producer`, context);
      if (events.length) fail("CUT_AUDIO_REACTIVE_CONFLICT", `${path}.events`, "a producer track cannot also contain authored set or animate events.");
      if (stableJsonStringify(object.initial) !== stableJsonStringify(producer.from)) {
        fail("CUT_AUDIO_REACTIVE_BASELINE", `${path}.initial`, "must exactly equal producer.mapping.from.");
      }
    }
  } else fail("CUT_IR_ENUM", `${path}.kind`, "must be constant, step, keyframes, or track.");
  idValue(base.id, `${path}.id`, context); stringValue(base.valueType, `${path}.valueType`, context); hashValue(base.contentHash, `${path}.contentHash`, context); provenance(base.provenance, `${path}.provenance`, context);
  validateSignalTimes(value as IRSignal, path);
}

const signalQuantityContract: Readonly<Record<KernelPropertyValueType, { dimension: string; unit: string }>> = Object.freeze({
  Angle: Object.freeze({ dimension: "angle", unit: "deg" }),
  Frequency: Object.freeze({ dimension: "frequency", unit: "hz" }),
  Gain: Object.freeze({ dimension: "gain", unit: "db" }),
  Length: Object.freeze({ dimension: "length", unit: "px" }),
  Number: Object.freeze({ dimension: "scalar", unit: "scalar" }),
  Ratio: Object.freeze({ dimension: "ratio", unit: "ratio" }),
  Time: Object.freeze({ dimension: "time", unit: "s" }),
  TruePeak: Object.freeze({ dimension: "true-peak", unit: "dbtp" }),
});

function isKernelPropertyValueType(value: string): value is KernelPropertyValueType {
  return Object.hasOwn(signalQuantityContract, value);
}

function typedSignalPayloadValue(
  value: IRValue,
  valueType: KernelPropertyValueType,
  path: string,
  allowNull: boolean,
  code: "CUT_IR_TYPE" | "CUT_AUDIO_REACTIVE_TYPE" = "CUT_IR_TYPE",
) {
  if (value.kind === "null") {
    if (allowNull) return;
    fail(code, path, `${valueType} signal payload cannot be null.`);
  }
  const expected = signalQuantityContract[valueType];
  if (value.kind !== "quantity" || value.dimension !== expected.dimension || value.unit !== expected.unit) {
    const received = value.kind === "quantity" ? `${value.dimension} quantity in ${JSON.stringify(value.unit)}` : `${value.kind} value`;
    fail(code, path, `${valueType} signal payload must be a canonical ${expected.dimension} quantity in ${JSON.stringify(expected.unit)}; received ${received}.`);
  }
}

function validateTypedSignalPayload(
  signal: IRSignal,
  valueType: KernelPropertyValueType,
  path: string,
  allowNullTrackInitial: boolean,
) {
  if (signal.kind === "constant") typedSignalPayloadValue(signal.value, valueType, `${path}.value`, false);
  else if (signal.kind === "step") signal.points.forEach((point, index) => typedSignalPayloadValue(point.value, valueType, `${path}.points[${index}].value`, false));
  else if (signal.kind === "keyframes") signal.keyframes.forEach((point, index) => typedSignalPayloadValue(point.value, valueType, `${path}.keyframes[${index}].value`, false));
  else {
    if (signal.producer) {
      typedSignalPayloadValue(signal.initial, valueType, `${path}.initial`, false, "CUT_AUDIO_REACTIVE_TYPE");
      typedSignalPayloadValue(signal.producer.mapping.from, valueType, `${path}.producer.mapping.from`, false, "CUT_AUDIO_REACTIVE_TYPE");
      typedSignalPayloadValue(signal.producer.mapping.to, valueType, `${path}.producer.mapping.to`, false, "CUT_AUDIO_REACTIVE_TYPE");
    } else {
      typedSignalPayloadValue(signal.initial, valueType, `${path}.initial`, allowNullTrackInitial);
    }
    signal.events.forEach((event, index) => {
      const eventPath = `${path}.events[${index}]`;
      if (event.kind === "set") typedSignalPayloadValue(event.value, valueType, `${eventPath}.value`, false);
      else {
        typedSignalPayloadValue(event.from, valueType, `${eventPath}.from`, false);
        typedSignalPayloadValue(event.to, valueType, `${eventPath}.to`, false);
      }
    });
  }
}

function sceneValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "name", "start", "duration", "rootVisualIds", "rootAudioIds", "rootAVIds", "items", "provenance"]);
  idValue(object.id, `${path}.id`, context); stringValue(object.name, `${path}.name`, context); const start = rationalValue(object.start, `${path}.start`, context); const duration = rationalValue(object.duration, `${path}.duration`, context);
  if (compareRational(start, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) fail("CUT_IR_TIMING", path, "scene start must be non-negative and duration must be positive.");
  uniqueIds(object.rootVisualIds, `${path}.rootVisualIds`, context); uniqueIds(object.rootAudioIds, `${path}.rootAudioIds`, context); uniqueIds(object.rootAVIds, `${path}.rootAVIds`, context);
  arrayValue(object.items, `${path}.items`, context).forEach((item, index) => { const itemPath = `${path}.items[${index}]`; const entry = closed(item, itemPath, ["id", "domain"]); idValue(entry.id, `${itemPath}.id`, context); domainValue(entry.domain, `${itemPath}.domain`); consumeEdge(context, itemPath); });
  provenance(object.provenance, `${path}.provenance`, context);
}

function compositionValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "name", "width", "height", "fps", "sampleRate", "duration", "sceneIds", "rootVisualIds", "rootAudioIds", "rootAVIds", "items", "provenance"]);
  idValue(object.id, `${path}.id`, context); stringValue(object.name, `${path}.name`, context); safeInteger(object.width, `${path}.width`, 1); safeInteger(object.height, `${path}.height`, 1); const fps = rationalValue(object.fps, `${path}.fps`, context); safeInteger(object.sampleRate, `${path}.sampleRate`, 1); const duration = rationalValue(object.duration, `${path}.duration`, context);
  if (compareRational(fps, zeroRational) <= 0 || compareRational(duration, zeroRational) <= 0) fail("CUT_IR_TIMING", path, "composition fps and duration must be positive.");
  uniqueIds(object.sceneIds, `${path}.sceneIds`, context); uniqueIds(object.rootVisualIds, `${path}.rootVisualIds`, context); uniqueIds(object.rootAudioIds, `${path}.rootAudioIds`, context); uniqueIds(object.rootAVIds, `${path}.rootAVIds`, context);
  arrayValue(object.items, `${path}.items`, context).forEach((item, index) => {
    const itemPath = `${path}.items[${index}]`; const entry = record(item, itemPath); const kind = stringValue(entry.kind, `${itemPath}.kind`, context);
    if (kind === "scene") { const scene = closed(item, itemPath, ["kind", "id"]); idValue(scene.id, `${itemPath}.id`, context); }
    else if (kind === "node") { const node = closed(item, itemPath, ["kind", "id", "domain"]); idValue(node.id, `${itemPath}.id`, context); domainValue(node.domain, `${itemPath}.domain`); }
    else fail("CUT_IR_ENUM", `${itemPath}.kind`, "must be scene or node.");
    consumeEdge(context, itemPath);
  });
  provenance(object.provenance, `${path}.provenance`, context);
}

function jobValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "effect", "op", "inputs", "state", "provenance"], ["artifactHash"]);
  idValue(object.id, `${path}.id`, context); enumValue(object.effect, `${path}.effect`, new Set(["analyze", "generate", "external"])); stringValue(object.op, `${path}.op`, context);
  const inputs = mapValue(object.inputs, `${path}.inputs`, context); Object.entries(inputs).forEach(([key, item]) => irValue(item, childPath(`${path}.inputs`, key), context));
  const state = enumValue(object.state, `${path}.state`, new Set(["unresolved", "locked"])); const hasArtifact = Object.hasOwn(object, "artifactHash"); if (hasArtifact) hashValue(object.artifactHash, `${path}.artifactHash`, context);
  if (state === "locked" && !hasArtifact) fail("CUT_IR_DETERMINISM", path, "locked effect job is missing artifactHash.");
  if (state === "unresolved" && hasArtifact) fail("CUT_IR_DETERMINISM", path, "unresolved effect job cannot claim artifactHash.");
  provenance(object.provenance, `${path}.provenance`, context);
}

function outputValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "name", "op", "timelineId", "parameters", "provenance"]);
  idValue(object.id, `${path}.id`, context); stringValue(object.name, `${path}.name`, context); stringValue(object.op, `${path}.op`, context); const timelineId = idValue(object.timelineId, `${path}.timelineId`, context); context.references.push({ kind: "timeline", id: timelineId, path: `${path}.timelineId` }); consumeEdge(context, `${path}.timelineId`);
  const parameters = mapValue(object.parameters, `${path}.parameters`, context); Object.entries(parameters).forEach(([key, item]) => irValue(item, childPath(`${path}.parameters`, key), context)); provenance(object.provenance, `${path}.provenance`, context);
}

function assertionValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "expression", "status", "provenance"], ["message"]);
  idValue(object.id, `${path}.id`, context); irValue(object.expression, `${path}.expression`, context); enumValue(object.status, `${path}.status`, new Set(["pass", "fail", "deferred"])); if (Object.hasOwn(object, "message")) stringValue(object.message, `${path}.message`, context); provenance(object.provenance, `${path}.provenance`, context);
}

function annotationMetadataValue(value: RecordValue, path: string, context: ValidationContext) {
  const id = stringValue(value.id, `${path}.id`, context);
  const name = stringValue(value.name, `${path}.name`, context);
  const color = stringValue(value.color, `${path}.color`, context);
  const role = enumValue(value.role, `${path}.role`, new Set(editorialAnnotationRoles));
  const comment = stringValue(value.comment, `${path}.comment`, context, true);
  const grid = enumValue(value.grid, `${path}.grid`, new Set(editorialAnnotationGrids));
  try {
    const normalized = normalizeEditorialAnnotationMetadata({ id, name, color, role, comment, grid });
    if (normalized.color !== color) fail("CUT_IR_IDENTITY", `${path}.color`, "must be canonical lowercase CUT color text.");
  } catch (error) {
    fail("CUT_IR_STRING", path, error instanceof Error ? error.message : "has invalid annotation metadata.");
  }
}

function annotationValue(value: unknown, path: string, context: ValidationContext, expectedKind: "marker" | "region") {
  const common = ["kind", "id", "compositionId", "name", "color", "role", "comment", "grid", "provenance"];
  const object = expectedKind === "marker"
    ? closed(value, path, [...common, "at"], ["sceneId"])
    : closed(value, path, [...common, "range"], ["sceneId"]);
  if (object.kind !== expectedKind) fail("CUT_IR_ENUM", `${path}.kind`, `must be ${expectedKind}.`);
  annotationMetadataValue(object, path, context);
  const compositionId = idValue(object.compositionId, `${path}.compositionId`, context);
  context.references.push({ kind: "timeline", id: compositionId, path: `${path}.compositionId` }); consumeEdge(context, `${path}.compositionId`);
  if (Object.hasOwn(object, "sceneId")) idValue(object.sceneId, `${path}.sceneId`, context);
  if (expectedKind === "marker") {
    const at = rationalValue(object.at, `${path}.at`, context);
    if (compareRational(at, zeroRational) < 0) fail("CUT_IR_TIMING", `${path}.at`, "must be non-negative.");
  } else {
    const range = closed(object.range, `${path}.range`, ["start", "duration"]);
    const start = rationalValue(range.start, `${path}.range.start`, context), duration = rationalValue(range.duration, `${path}.range.duration`, context);
    if (compareRational(start, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) fail("CUT_IR_TIMING", `${path}.range`, "start must be non-negative and duration must be positive.");
  }
  provenance(object.provenance, `${path}.provenance`, context);
}

function annotationsValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["markers", "regions"]);
  const markers = arrayValue(object.markers, `${path}.markers`, context, context.limits.maxAnnotations);
  const regions = arrayValue(object.regions, `${path}.regions`, context, context.limits.maxAnnotations);
  if (markers.length + regions.length === 0) fail("CUT_IR_IDENTITY", path, "empty annotations must be omitted to preserve canonical pre-extension identity.");
  if (markers.length + regions.length > context.limits.maxAnnotations) fail("CUT_IR_LIMIT", path, `contains more than maxAnnotations (${context.limits.maxAnnotations}).`);
  markers.forEach((marker, index) => annotationValue(marker, `${path}.markers[${index}]`, context, "marker"));
  regions.forEach((region, index) => annotationValue(region, `${path}.regions[${index}]`, context, "region"));
  const seen = new Set<string>();
  [...markers, ...regions].forEach((annotation, index) => {
    const id = (annotation as { id: string }).id;
    if (seen.has(id)) fail("CUT_IR_IDENTITY", path, `annotation id “${id}” is duplicated at combined index ${index}.`);
    seen.add(id);
  });
}

function linkedEditValue(value: unknown, path: string, context: ValidationContext) {
  const base = record(value, path);
  const kind = enumValue(base.kind, `${path}.kind`, new Set(["linked-trim", "linked-ripple-delete"]));
  const version = safeInteger(base.version, `${path}.version`, 1);
  const intervalField = kind === "linked-trim" ? "keep" : "range";
  if (kind === "linked-trim" && version !== 1) fail("CUT_IR_ENUM", `${path}.version`, "LinkedTrim must be linked-edit version 1.");
  if (kind === "linked-ripple-delete" && version !== 1 && version !== 2) fail("CUT_IR_ENUM", `${path}.version`, "LinkedRippleDelete must be version 1 or 2.");
  const object = closed(value, path, ["id", "version", "kind", "compositionId", "sceneId", "linkId", intervalField, ...(kind === "linked-ripple-delete" && version === 2 ? ["linkSegmentIds"] : []), "pictureTrackId", "audioTrackId", "provenance"]);
  idValue(object.id, `${path}.id`, context);
  const compositionId = idValue(object.compositionId, `${path}.compositionId`, context);
  context.references.push({ kind: "timeline", id: compositionId, path: `${path}.compositionId` }); consumeEdge(context, `${path}.compositionId`);
  idValue(object.sceneId, `${path}.sceneId`, context);
  editorialLinkValue(object.linkId, `${path}.linkId`, context);
  editorialIntervalValue(object[intervalField], `${path}.${intervalField}`, context);
  if (kind === "linked-ripple-delete" && version === 2) linkedSegmentIdsValue(object.linkSegmentIds, `${path}.linkSegmentIds`, context);
  idValue(object.pictureTrackId, `${path}.pictureTrackId`, context);
  idValue(object.audioTrackId, `${path}.audioTrackId`, context);
  provenance(object.provenance, `${path}.provenance`, context);
}

function linkedEditsValue(value: unknown, path: string, context: ValidationContext) {
  const edits = arrayValue(value, path, context, context.limits.maxLinkedEdits);
  if (!edits.length) fail("CUT_IR_IDENTITY", path, "empty linkedEdits must be omitted to preserve canonical pre-extension identity.");
  edits.forEach((edit, index) => linkedEditValue(edit, `${path}[${index}]`, context));
  validateUniqueEntityIds(edits as Array<{ id: string }>, path);
}

function timelineEditIdListValue(value: unknown, path: string, context: ValidationContext) {
  const ids = arrayValue(value, path, context, timelineEditLimits.maximumSelectionIds);
  if (!ids.length) fail("CUT_TIMELINE_EDIT_SELECTION", path, "must contain at least one stable selector.");
  const seen = new Set<string>();
  ids.forEach((entry, index) => {
    const id = timelineEditStableIdValue(entry, `${path}[${index}]`, context);
    if (seen.has(id)) fail("CUT_TIMELINE_EDIT_SELECTION", `${path}[${index}]`, "duplicates an earlier selector.");
    seen.add(id);
  });
}

function timelineEditAVTimeValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, [], ["picture", "audio"]);
  if (!Object.hasOwn(object, "picture") && !Object.hasOwn(object, "audio")) {
    fail("CUT_TIMELINE_EDIT_TIME", path, "must contain picture and/or audio time.");
  }
  if (Object.hasOwn(object, "picture")) rationalValue(object.picture, `${path}.picture`, context);
  if (Object.hasOwn(object, "audio")) rationalValue(object.audio, `${path}.audio`, context);
}

function timelineEditAVIntervalValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, [], ["picture", "audio"]);
  if (!Object.hasOwn(object, "picture") && !Object.hasOwn(object, "audio")) {
    fail("CUT_TIMELINE_EDIT_TIME", path, "must contain picture and/or audio interval.");
  }
  if (Object.hasOwn(object, "picture")) editorialIntervalValue(object.picture, `${path}.picture`, context);
  if (Object.hasOwn(object, "audio")) editorialIntervalValue(object.audio, `${path}.audio`, context);
}

function timelineEditSelectionValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["trackIds"], ["originIds", "linkIds", "range", "relation", "allowUnlinked"]);
  timelineEditIdListValue(object.trackIds, `${path}.trackIds`, context);
  if (Object.hasOwn(object, "originIds")) timelineEditIdListValue(object.originIds, `${path}.originIds`, context);
  if (Object.hasOwn(object, "linkIds")) timelineEditIdListValue(object.linkIds, `${path}.linkIds`, context);
  if (Object.hasOwn(object, "range")) timelineEditAVIntervalValue(object.range, `${path}.range`, context);
  if (Object.hasOwn(object, "relation")) {
    enumValue(object.relation, `${path}.relation`, new Set(["overlaps", "contained", "touches"]));
  }
  if (Object.hasOwn(object, "allowUnlinked") && typeof object.allowUnlinked !== "boolean") {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.allowUnlinked`, "must be Bool.");
  }
}

function timelineEditHandlesValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["head", "tail"]);
  const head = rationalValue(object.head, `${path}.head`, context);
  const tail = rationalValue(object.tail, `${path}.tail`, context);
  if (compareRational(head, zeroRational) < 0 || compareRational(tail, zeroRational) < 0) {
    fail("CUT_TIMELINE_EDIT_HANDLE", path, "head and tail handles must be non-negative.");
  }
}

function timelineEditAudioPresentationClockValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(
    value,
    path,
    ["originDuration", "sliceOffset", "fadePolicy"],
    ["authorityOriginId"],
  );
  const originDuration = rationalValue(object.originDuration, `${path}.originDuration`, context);
  const sliceOffset = rationalValue(object.sliceOffset, `${path}.sliceOffset`, context);
  if (compareRational(originDuration, zeroRational) <= 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `${path}.originDuration`, "must be positive.");
  }
  if (compareRational(sliceOffset, zeroRational) < 0 || compareRational(sliceOffset, originDuration) >= 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `${path}.sliceOffset`, "must be non-negative and strictly before originDuration.");
  }
  if (object.fadePolicy !== "origin-relative") {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.fadePolicy`, "must be origin-relative.");
  }
  if (Object.hasOwn(object, "authorityOriginId")) {
    timelineEditStableIdValue(
      object.authorityOriginId,
      `${path}.authorityOriginId`,
      context,
    );
  }
  return { originDuration, sliceOffset };
}

function timelineEditSourceViewValue(value: unknown, path: string, context: ValidationContext) {
  const base = record(value, path);
  const kind = enumValue(base.kind, `${path}.kind`, new Set(["gap", "picture", "audio", "processed-audio", "nested"]));
  if (kind === "gap") {
    const object = closed(value, path, ["kind", "authorityId"]);
    timelineEditStableIdValue(object.authorityId, `${path}.authorityId`, context);
    return;
  }
  const common = ["kind", "source", "handles", "authorityId"];
  const variant = kind === "picture"
    ? ["nodeId", "timeMap"]
    : kind === "audio"
      ? ["nodeId", "rate", "fadeIn", "fadeOut", "presentationClock"]
      : kind === "processed-audio"
        ? ["regionId", "sourceNodeId", "processorNodeIds", "graphAuthorityId", "rate", "fadeIn", "fadeOut", "presentationClock", "statePolicy"]
        : ["nodeId", "compositionId", "rate", "sharedClock"];
  const object = closed(
    value,
    path,
    [...common, ...variant],
    kind === "nested" ? ["placementPolicy"] : [],
  );
  editorialIntervalValue(object.source, `${path}.source`, context);
  timelineEditHandlesValue(object.handles, `${path}.handles`, context);
  timelineEditStableIdValue(object.authorityId, `${path}.authorityId`, context);
  if (kind === "picture") {
    // Direct clip materialization replaces the authored node. nodeId retains
    // bounded lineage/debug identity, while authorityId is recomputed from the
    // live materialized node plus locked resource bytes at runtime.
    idValue(object.nodeId, `${path}.nodeId`, context);
    pictureTimeMapValue(object.timeMap, `${path}.timeMap`, context);
    return;
  }
  if (kind === "audio") {
    // Like picture lineage above, direct AudioClip nodeId is historical. The
    // origin-relative clock and edit-invariant authority remain executable.
    idValue(object.nodeId, `${path}.nodeId`, context);
  } else if (kind === "processed-audio") {
    const regionId = idValue(object.regionId, `${path}.regionId`, context);
    const sourceNodeId = idValue(object.sourceNodeId, `${path}.sourceNodeId`, context);
    context.references.push({ kind: "node", id: regionId, path: `${path}.regionId` }, { kind: "node", id: sourceNodeId, path: `${path}.sourceNodeId` });
    consumeEdge(context, `${path}.regionId`); consumeEdge(context, `${path}.sourceNodeId`);
    const processors = arrayValue(object.processorNodeIds, `${path}.processorNodeIds`, context, 64);
    if (!processors.length) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.processorNodeIds`, "must contain a non-empty processor chain.");
    const seen = new Set<string>();
    processors.forEach((entry, index) => {
      const id = idValue(entry, `${path}.processorNodeIds[${index}]`, context);
      if (seen.has(id)) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.processorNodeIds[${index}]`, "duplicates an earlier processor node.");
      seen.add(id);
      context.references.push({ kind: "node", id, path: `${path}.processorNodeIds[${index}]` }); consumeEdge(context, `${path}.processorNodeIds[${index}]`);
    });
    timelineEditStableIdValue(object.graphAuthorityId, `${path}.graphAuthorityId`, context);
    if (object.statePolicy !== "single-authorized-evaluation") {
      fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `${path}.statePolicy`, "must be single-authorized-evaluation.");
    }
  } else {
    const nodeId = idValue(object.nodeId, `${path}.nodeId`, context);
    const compositionId = idValue(object.compositionId, `${path}.compositionId`, context);
    // Structural materialization replaces the authored Precomp node. nodeId
    // remains bounded lineage identity, while compositionId is a live
    // authenticated timeline reference revalidated against the materialized
    // child before rendering.
    void nodeId;
    context.references.push({ kind: "timeline", id: compositionId, path: `${path}.compositionId` });
    consumeEdge(context, `${path}.compositionId`);
    if (object.sharedClock !== true) fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `${path}.sharedClock`, "must be true.");
    if (object.placementPolicy !== undefined) {
      enumValue(
        object.placementPolicy,
        `${path}.placementPolicy`,
        new Set(["structural-only", "static-same-track-copy"]),
      );
    }
  }
  const rate = rationalValue(object.rate, `${path}.rate`, context);
  if (compareRational(rate, zeroRational) <= 0) fail("CUT_TIMELINE_EDIT_TIME", `${path}.rate`, "must be positive.");
  if (kind === "nested") return;
  const fadeIn = rationalValue(object.fadeIn, `${path}.fadeIn`, context);
  const fadeOut = rationalValue(object.fadeOut, `${path}.fadeOut`, context);
  timelineEditAudioPresentationClockValue(object.presentationClock, `${path}.presentationClock`, context);
  if (compareRational(fadeIn, zeroRational) < 0 || compareRational(fadeOut, zeroRational) < 0) {
    fail("CUT_TIMELINE_EDIT_TIME", path, "fadeIn and fadeOut must be non-negative.");
  }
}

function timelineEditItemValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["originId", "segmentId", "trackId", "domain", "destination", "sourceView", "metadata", "provenance"], ["parentSegmentId", "linkId", "role"]);
  timelineEditStableIdValue(object.originId, `${path}.originId`, context);
  timelineEditStableIdValue(object.segmentId, `${path}.segmentId`, context);
  if (Object.hasOwn(object, "parentSegmentId")) timelineEditStableIdValue(object.parentSegmentId, `${path}.parentSegmentId`, context);
  timelineEditStableIdValue(object.trackId, `${path}.trackId`, context);
  const domain = enumValue(object.domain, `${path}.domain`, new Set(["picture", "audio", "audiovisual"]));
  if (Object.hasOwn(object, "linkId")) timelineEditStableIdValue(object.linkId, `${path}.linkId`, context);
  if (Object.hasOwn(object, "role")) editorialRoleValue(object.role, `${path}.role`, context);
  editorialIntervalValue(object.destination, `${path}.destination`, context);
  timelineEditSourceViewValue(object.sourceView, `${path}.sourceView`, context);
  const sourceKind = stringValue(record(object.sourceView, `${path}.sourceView`).kind, `${path}.sourceView.kind`, context);
  const compatible = sourceKind === "gap"
    || (domain === "picture" && (sourceKind === "picture" || sourceKind === "nested"))
    || (domain === "audio" && (sourceKind === "audio" || sourceKind === "processed-audio"))
    || (domain === "audiovisual" && sourceKind === "nested");
  if (!compatible) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.sourceView.kind`, `${sourceKind} is not a valid ${domain} source view.`);
  }
  if (sourceKind === "audio" || sourceKind === "processed-audio") {
    const sourceView = object.sourceView as Extract<TimelineEditPlanV1["tracks"][number]["items"][number]["sourceView"], { kind: "audio" | "processed-audio" }>;
    const destination = object.destination as IREditorialInterval;
    if (compareRational(addRational(sourceView.presentationClock.sliceOffset, destination.duration), sourceView.presentationClock.originDuration) > 0) {
      fail("CUT_TIMELINE_EDIT_TIME", `${path}.sourceView.presentationClock`, "sliceOffset plus destination duration exceeds the authored originDuration.");
    }
  }
  editorialStringMetadataValue(object.metadata, `${path}.metadata`, context);
  provenance(object.provenance, `${path}.provenance`, context);
}

function timelineEditTrackValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["trackId", "domain", "order", "duration", "metadata", "items"], ["role"]);
  timelineEditStableIdValue(object.trackId, `${path}.trackId`, context);
  enumValue(object.domain, `${path}.domain`, new Set(["picture", "audio", "audiovisual"]));
  safeInteger(object.order, `${path}.order`, 0);
  const duration = rationalValue(object.duration, `${path}.duration`, context);
  if (compareRational(duration, zeroRational) <= 0) fail("CUT_TIMELINE_EDIT_TIME", `${path}.duration`, "must be positive.");
  if (Object.hasOwn(object, "role")) editorialRoleValue(object.role, `${path}.role`, context);
  editorialStringMetadataValue(object.metadata, `${path}.metadata`, context);
  const items = arrayValue(object.items, `${path}.items`, context, timelineEditLimits.maximumItems);
  if (!items.length) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.items`, "must contain explicit complete track coverage.");
  items.forEach((item, index) => timelineEditItemValue(item, `${path}.items[${index}]`, context));
}

function timelineEditPictureStyleValue(value: unknown, path: string, context: ValidationContext) {
  editorialPictureTransitionStyleValue(value, path, context);
}

function timelineEditAudioStyleValue(value: unknown, path: string) {
  const object = closed(value, path, ["curve"]);
  enumValue(object.curve, `${path}.curve`, new Set(["equal-power", "linear"]));
}

function timelineEditOperandPartValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["domain", "sourceOriginId", "originId", "destinationDuration", "metadata"]);
  enumValue(object.domain, `${path}.domain`, new Set(["picture", "audio", "audiovisual"]));
  timelineEditStableIdValue(object.sourceOriginId, `${path}.sourceOriginId`, context);
  timelineEditStableIdValue(object.originId, `${path}.originId`, context);
  const duration = rationalValue(object.destinationDuration, `${path}.destinationDuration`, context);
  if (compareRational(duration, zeroRational) <= 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `${path}.destinationDuration`, "must be positive.");
  }
  editorialStringMetadataValue(object.metadata, `${path}.metadata`, context);
}

function timelineEditOperandValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["parts"], ["linkId"]);
  const parts = arrayValue(object.parts, `${path}.parts`, context, 3);
  if (!parts.length) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.parts`, "must contain at least one operand part.");
  parts.forEach((part, index) => timelineEditOperandPartValue(part, `${path}.parts[${index}]`, context));
  const domains = parts.map((part, index) =>
    enumValue(record(part, `${path}.parts[${index}]`).domain, `${path}.parts[${index}].domain`, new Set(["picture", "audio", "audiovisual"])));
  if (new Set(domains).size !== domains.length) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.parts`, "must contain at most one part per domain.");
  }
  if (Object.hasOwn(object, "linkId")) timelineEditStableIdValue(object.linkId, `${path}.linkId`, context);
  if (parts.length > 1 && !Object.hasOwn(object, "linkId")) {
    fail("CUT_TIMELINE_EDIT_LINK", `${path}.linkId`, "is required for a coupled multi-domain operand.");
  }
}

function timelineEditTargetsValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, [], ["picture", "audio", "audiovisual"]);
  const domains = ["picture", "audio", "audiovisual"] as const;
  const present = domains.filter((domain) => Object.hasOwn(object, domain));
  if (!present.length) fail("CUT_TIMELINE_EDIT_SELECTION", path, "must contain at least one per-domain target.");
  present.forEach((domain) => timelineEditSelectionValue(object[domain], `${path}.${domain}`, context));
}

function timelineEditOperationValue(value: unknown, path: string, context: ValidationContext) {
  const base = record(value, path);
  const kind = enumValue(base.kind, `${path}.kind`, new Set(["split", "trim", "ripple-delete", "lift", "extract", "slip", "slide", "boundary-adjust", "insert", "overwrite", "transition"]));
  if (kind === "insert" || kind === "overwrite") {
    const object = closed(value, path, ["id", "kind", "targets", "at", "operand", "provenance"]);
    timelineEditStableIdValue(object.id, `${path}.id`, context);
    timelineEditTargetsValue(object.targets, `${path}.targets`, context);
    timelineEditAVTimeValue(object.at, `${path}.at`, context);
    timelineEditOperandValue(object.operand, `${path}.operand`, context);
    provenance(object.provenance, `${path}.provenance`, context);
    return;
  }
  if (kind === "transition") {
    const object = closed(value, path, ["id", "kind", "left", "right", "at", "duration", "provenance"], ["picture", "audio"]);
    timelineEditStableIdValue(object.id, `${path}.id`, context);
    timelineEditSelectionValue(object.left, `${path}.left`, context);
    timelineEditSelectionValue(object.right, `${path}.right`, context);
    timelineEditAVTimeValue(object.at, `${path}.at`, context);
    timelineEditAVTimeValue(object.duration, `${path}.duration`, context);
    if (Object.hasOwn(object, "picture")) timelineEditPictureStyleValue(object.picture, `${path}.picture`, context);
    if (Object.hasOwn(object, "audio")) timelineEditAudioStyleValue(object.audio, `${path}.audio`);
    if (!Object.hasOwn(object, "picture") && !Object.hasOwn(object, "audio")) {
      fail("CUT_TIMELINE_EDIT_TRANSITION", path, "must declare picture and/or audio transition style.");
    }
    provenance(object.provenance, `${path}.provenance`, context);
    return;
  }
  const field = kind === "split" || kind === "boundary-adjust" ? "at"
    : kind === "trim" ? "keep"
      : kind === "slip" || kind === "slide" ? "range"
        : "range";
  const object = closed(value, path, ["id", "kind", "selection", field, ...(kind === "slip" || kind === "slide" ? ["by"] : []), "provenance"]);
  timelineEditStableIdValue(object.id, `${path}.id`, context);
  timelineEditSelectionValue(object.selection, `${path}.selection`, context);
  if (kind === "split" || kind === "boundary-adjust") timelineEditAVTimeValue(object.at, `${path}.at`, context);
  else if (kind === "trim") timelineEditAVIntervalValue(object.keep, `${path}.keep`, context);
  else timelineEditAVIntervalValue(object.range, `${path}.range`, context);
  if (kind === "slip" || kind === "slide") timelineEditAVTimeValue(object.by, `${path}.by`, context);
  provenance(object.provenance, `${path}.provenance`, context);
}

function timelineEditPlanValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["version", "id", "compositionId", "sceneId", "initialDuration", "finalDuration", "tracks", "operations", "provenance"]);
  if (object.version !== 1) fail("CUT_IR_ENUM", `${path}.version`, "must be TimelineEdit plan version 1.");
  timelineEditStableIdValue(object.id, `${path}.id`, context);
  const compositionId = idValue(object.compositionId, `${path}.compositionId`, context);
  context.references.push({ kind: "timeline", id: compositionId, path: `${path}.compositionId` }); consumeEdge(context, `${path}.compositionId`);
  idValue(object.sceneId, `${path}.sceneId`, context);
  rationalValue(object.initialDuration, `${path}.initialDuration`, context);
  rationalValue(object.finalDuration, `${path}.finalDuration`, context);
  const tracks = arrayValue(object.tracks, `${path}.tracks`, context, timelineEditLimits.maximumTracks);
  if (!tracks.length) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.tracks`, "must contain at least one track.");
  tracks.forEach((track, index) => timelineEditTrackValue(track, `${path}.tracks[${index}]`, context));
  const operations = arrayValue(object.operations, `${path}.operations`, context, timelineEditLimits.maximumOperations);
  if (!operations.length) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.operations`, "must contain at least one operation.");
  operations.forEach((operation, index) => timelineEditOperationValue(operation, `${path}.operations[${index}]`, context));
  provenance(object.provenance, `${path}.provenance`, context);
  try {
    executeTimelineEditPlan(value as TimelineEditPlanV1);
  } catch (error) {
    if (error instanceof TimelineEditError) {
      const nestedPath = error.path.startsWith("$.") ? error.path.slice(2) : error.path === "$" ? "" : error.path;
      const finalPath = nestedPath ? `${path}.${nestedPath}` : path;
      fail(error.code, finalPath, error.message.replace(/^[A-Z0-9_]+:\s*/u, ""));
    }
    throw error;
  }
}

function timelineEditsValue(value: unknown, path: string, context: ValidationContext) {
  const edits = arrayValue(value, path, context, context.limits.maxTimelineEdits);
  if (!edits.length) fail("CUT_IR_IDENTITY", path, "empty timelineEdits must be omitted to preserve canonical pre-extension identity.");
  edits.forEach((edit, index) => timelineEditPlanValue(edit, `${path}[${index}]`, context));
  validateUniqueEntityIds(edits as Array<{ id: string }>, path);
}

function validateTimelineEditTransitionOwnership(ir: CutAVIR) {
  const claimedOrigins = new Set<string>();
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const editorial = node.editorial;
    const materializedViews = node.children.filter((childId) =>
      ir.nodes[childId]?.op === cutTimelineAudioViewOp);
    if ((editorial?.kind !== "picture-track" && editorial?.kind !== "audio-track")
      || editorial.operationPlan !== undefined
      || (editorial.transitions === undefined && !materializedViews.length)) continue;
    const path = `${childPath("$.nodes", nodeId)}.editorial`;
    if (!editorial.trackId || !node.sceneId) {
      fail("CUT_IR_IDENTITY", path, "TimelineEdit-materialized track must carry stable trackId and same-scene canonical ownership.");
    }
    const domain = editorial.kind === "picture-track" ? "picture" : "audio";
    const owners = (ir.timelineEdits ?? []).filter((plan) =>
      plan.sceneId === node.sceneId
      && plan.tracks.some((track) => track.trackId === editorial.trackId && track.domain === domain));
    if (owners.length !== 1) {
      fail(
        "CUT_IR_IDENTITY",
        path,
        `TimelineEdit-materialized track ${JSON.stringify(editorial.trackId)} must be owned by exactly one canonical TimelineEdit plan; found ${owners.length}.`,
      );
    }
    if (editorial.kind === "audio-track") {
      const execution = executeTimelineEditPlan(owners[0]!);
      const executionTrack = execution.tracks.find((track) =>
        track.trackId === editorial.trackId && track.domain === "audio");
      const executionTransitions = execution.transitions.filter((transition) =>
        transition.trackId === editorial.trackId && transition.domain === "audio");
      if (!executionTrack
        || (editorial.transitions ?? []).length !== executionTransitions.length) {
        fail(
          "CUT_IR_IDENTITY",
          `${path}.transitions`,
          "audio transition authority must contain every and only transition from canonical TimelineEdit replay.",
        );
      }
      for (const [transitionIndex, transition] of (editorial.transitions ?? []).entries()) {
        const expected = executionTransitions[transitionIndex]!;
        const outgoingIndex = executionTrack.items.findIndex((item) =>
          item.segmentId === expected.outgoingSegmentId);
        const incomingIndex = executionTrack.items.findIndex((item) =>
          item.segmentId === expected.incomingSegmentId);
        if (outgoingIndex < 0 || incomingIndex < 0) {
          fail(
            "CUT_IR_REFERENCE",
            `${path}.transitions[${transitionIndex}]`,
            "lost the exact outgoing or incoming TimelineEdit segment.",
          );
        }
        const projected = {
          cut: addRational(node.interval.start, expected.cut),
          duration: expected.duration,
          overlap: {
            start: addRational(node.interval.start, expected.overlap.start),
            duration: expected.overlap.duration,
          },
          outgoingNodeId: node.children[outgoingIndex],
          incomingNodeId: node.children[incomingIndex],
          outgoingSource: expected.outgoingSource,
          incomingSource: expected.incomingSource,
          curve: expected.audio?.curve,
        };
        const encoded = { ...transition } as Record<string, unknown>;
        delete encoded.provenance;
        if (stableJsonStringify(encoded) !== stableJsonStringify(projected)) {
          fail(
            "CUT_IR_IDENTITY",
            `${path}.transitions[${transitionIndex}]`,
            "does not equal the exact post-TimelineEdit audio transition projection.",
          );
        }
      }
      for (const [transitionIndex, transition] of (editorial.transitions ?? []).entries()) {
        for (const [side, viewId, consumed] of [
          ["outgoing", transition.outgoingNodeId, transition.outgoingSource],
          ["incoming", transition.incomingNodeId, transition.incomingSource],
        ] as const) {
          const view = ir.nodes[viewId];
          if (view?.op !== cutTimelineAudioViewOp) continue;
          const viewPath = childPath("$.nodes", view.id);
          const originRef = view.inputs.origin;
          const origin = originRef?.kind === "node-ref"
            ? ir.nodes[originRef.id]
            : undefined;
          if (!origin || origin.op !== cutTimelineAudioOriginOp) {
            fail(
              "CUT_IR_REFERENCE",
              `${viewPath}.inputs.origin`,
              "transition view must reference one authenticated timeline audio origin.",
            );
          }
          const originPath = childPath("$.nodes", origin.id);
          const envelope = timelineAudioEvaluationEnvelope(origin, originPath);
          const authorized = envelope?.source
            ?? timelineAudioLeafRange(ir, origin, originPath);
          const authorizedEnd = addRational(authorized.start, authorized.duration);
          const consumedEnd = addRational(consumed.start, consumed.duration);
          if (compareRational(consumed.start, authorized.start) < 0
            || compareRational(consumedEnd, authorizedEnd) > 0) {
            fail(
              "CUT_IR_TIMING",
              `${path}.transitions[${transitionIndex}].${side}Source`,
              `${side} transition media exceeds its authenticated origin evaluation interval.`,
            );
          }
        }
      }
    }
    for (const viewId of materializedViews) {
      const origin = ir.nodes[viewId]?.inputs.origin;
      if (origin?.kind !== "node-ref") {
        fail("CUT_IR_IDENTITY", `${childPath("$.nodes", viewId)}.inputs.origin`, "materialized audio view lost its canonical origin claim.");
      }
      claimedOrigins.add(origin.id);
    }
  }
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    if (node.op === cutTimelineAudioOriginOp && !claimedOrigins.has(nodeId)) {
      fail(
        "CUT_IR_IDENTITY",
        childPath("$.nodes", nodeId),
        "timeline audio origin must be referenced by a view on exactly one canonical TimelineEdit-owned track.",
      );
    }
  }
}

const transcriptWordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const maximumTranscriptStreamIndex = 65_535;
const maximumTranscriptAudioSampleRate = 768_000;
const maximumTranscriptWordTextBytes = 4_096;
const maximumTranscriptSpeakerBytes = 256;

function transcriptBoundedString(
  value: unknown,
  path: string,
  context: ValidationContext,
  maximumBytes: number,
) {
  const text = stringValue(value, path, context);
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    fail("CUT_IR_LIMIT", path, `exceeds the transcript UTF-8 limit (${maximumBytes} bytes).`);
  }
  return text;
}

function transcriptWordIdValue(value: unknown, path: string, context: ValidationContext) {
  const id = transcriptBoundedString(value, path, context, 128);
  if (!transcriptWordIdPattern.test(id)) {
    fail("CUT_IR_STRING", path, "must be a stable transcript word ID using only letters, digits, dot, underscore, colon, or hyphen.");
  }
  return id;
}

function transcriptWordValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "start", "end", "text", "join"], ["speaker"]);
  const id = transcriptWordIdValue(object.id, `${path}.id`, context);
  const start = rationalValue(object.start, `${path}.start`, context);
  const end = rationalValue(object.end, `${path}.end`, context);
  const text = transcriptBoundedString(object.text, `${path}.text`, context, maximumTranscriptWordTextBytes);
  if (cutTranscriptHasUnsafeUnicodeScalar(text) || /\s/u.test(text)) {
    fail("CUT_IR_STRING", `${path}.text`, "must be one non-empty safe Unicode transcript word without whitespace.");
  }
  const join = enumValue(object.join, `${path}.join`, new Set(["none", "space"])) as "none" | "space";
  let speaker: string | undefined;
  if (Object.hasOwn(object, "speaker")) {
    speaker = transcriptBoundedString(object.speaker, `${path}.speaker`, context, maximumTranscriptSpeakerBytes);
    if (speaker !== speaker.trim() || cutTranscriptHasUnsafeUnicodeScalar(speaker)) {
      fail("CUT_IR_STRING", `${path}.speaker`, "must be a non-empty safe Unicode label without surrounding whitespace.");
    }
  }
  return { id, start, end, text, join, ...(speaker === undefined ? {} : { speaker }) };
}

function transcriptMediaValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(
    value,
    path,
    ["sha256", "audioStreamIndex", "audioSampleRate", "duration"],
    [
      "videoStreamIndex",
      "videoFrameRate",
      "videoDuration",
      "audioVideoPresentationDelta",
    ],
  );
  const sha256 = hashValue(object.sha256, `${path}.sha256`, context);
  const audioStreamIndex = safeInteger(object.audioStreamIndex, `${path}.audioStreamIndex`, 0);
  if (audioStreamIndex > maximumTranscriptStreamIndex) {
    fail("CUT_IR_LIMIT", `${path}.audioStreamIndex`, `cannot exceed ${maximumTranscriptStreamIndex}.`);
  }
  const audioSampleRate = safeInteger(object.audioSampleRate, `${path}.audioSampleRate`, 1);
  if (audioSampleRate > maximumTranscriptAudioSampleRate) {
    fail("CUT_IR_LIMIT", `${path}.audioSampleRate`, `cannot exceed ${maximumTranscriptAudioSampleRate}.`);
  }
  const duration = rationalValue(object.duration, `${path}.duration`, context);
  if (compareRational(duration, zeroRational) <= 0) fail("CUT_IR_TIMING", `${path}.duration`, "must be positive.");
  const hasVideoStream = Object.hasOwn(object, "videoStreamIndex");
  const hasVideoRate = Object.hasOwn(object, "videoFrameRate");
  const hasVideoDuration = Object.hasOwn(object, "videoDuration");
  const hasPresentationDelta = Object.hasOwn(
    object,
    "audioVideoPresentationDelta",
  );
  if (hasVideoStream !== hasVideoRate) {
    fail("CUT_IR_MISSING_FIELD", `${path}.${hasVideoStream ? "videoFrameRate" : "videoStreamIndex"}`, "is required with the other video provenance field.");
  }
  if (hasVideoDuration && !hasVideoStream) {
    fail("CUT_IR_MISSING_FIELD", `${path}.videoStreamIndex`, "is required when videoDuration is present.");
  }
  if (hasPresentationDelta && !hasVideoStream) {
    fail("CUT_IR_MISSING_FIELD", `${path}.videoStreamIndex`, "is required when audioVideoPresentationDelta is present.");
  }
  if (hasPresentationDelta && !hasVideoDuration) {
    fail("CUT_IR_MISSING_FIELD", `${path}.videoDuration`, "is required when audioVideoPresentationDelta is present.");
  }
  if (!hasVideoStream) return { sha256, audioStreamIndex, audioSampleRate, duration };
  const videoStreamIndex = safeInteger(object.videoStreamIndex, `${path}.videoStreamIndex`, 0);
  if (videoStreamIndex > maximumTranscriptStreamIndex) {
    fail("CUT_IR_LIMIT", `${path}.videoStreamIndex`, `cannot exceed ${maximumTranscriptStreamIndex}.`);
  }
  if (videoStreamIndex === audioStreamIndex) {
    fail("CUT_IR_IDENTITY", `${path}.videoStreamIndex`, "cannot identify the declared audio stream.");
  }
  const videoFrameRate = rationalValue(object.videoFrameRate, `${path}.videoFrameRate`, context);
  if (compareRational(videoFrameRate, zeroRational) <= 0) fail("CUT_IR_TIMING", `${path}.videoFrameRate`, "must be positive.");
  const videoDuration = hasVideoDuration
    ? rationalValue(object.videoDuration, `${path}.videoDuration`, context)
    : undefined;
  if (videoDuration !== undefined
    && compareRational(videoDuration, zeroRational) <= 0) {
    fail("CUT_IR_TIMING", `${path}.videoDuration`, "must be positive.");
  }
  const audioVideoPresentationDelta = hasPresentationDelta
    ? rationalValue(
      object.audioVideoPresentationDelta,
      `${path}.audioVideoPresentationDelta`,
      context,
    )
    : undefined;
  if (audioVideoPresentationDelta !== undefined
    && compareRational(audioVideoPresentationDelta, zeroRational) === 0) {
    fail(
      "CUT_IR_IDENTITY",
      `${path}.audioVideoPresentationDelta`,
      "must be omitted when the selected audio and video presentation anchors are equal.",
    );
  }
  return {
    sha256,
    audioStreamIndex,
    audioSampleRate,
    duration,
    videoStreamIndex,
    videoFrameRate,
    ...(videoDuration === undefined ? {} : { videoDuration }),
    ...(audioVideoPresentationDelta === undefined
      ? {}
      : { audioVideoPresentationDelta }),
  };
}

function transcriptMediaAuthorityValue(
  value: unknown,
  path: string,
  context: ValidationContext,
) {
  const object = closed(value, path, [
    "id", "identity", "version", "kind", "compositionId", "sceneId",
    "transcriptResourceId", "audioResourceId", "audioStreamIndex",
    "videoResourceId", "videoStreamIndex", "videoFrameRate", "videoDuration",
    "audioAt", "videoAt", "videoRate", "provenance",
  ]);
  idValue(object.id, `${path}.id`, context);
  hashValue(object.identity, `${path}.identity`, context);
  if (safeInteger(object.version, `${path}.version`, 1) !== 1) {
    fail("CUT_IR_ENUM", `${path}.version`, "must be transcript-media-authority version 1.");
  }
  if (object.kind !== "transcript-media-authority") {
    fail("CUT_IR_ENUM", `${path}.kind`, "must be transcript-media-authority.");
  }
  for (const name of [
    "compositionId", "sceneId", "transcriptResourceId", "audioResourceId",
    "videoResourceId",
  ] as const) {
    idValue(object[name], `${path}.${name}`, context);
    consumeEdge(context, `${path}.${name}`);
  }
  const audioStreamIndex = safeInteger(
    object.audioStreamIndex,
    `${path}.audioStreamIndex`,
    0,
  );
  const videoStreamIndex = safeInteger(
    object.videoStreamIndex,
    `${path}.videoStreamIndex`,
    0,
  );
  if (audioStreamIndex > cutTranscriptMediaAuthorityContract.maximumStreamIndex) {
    fail(
      "CUT_IR_LIMIT",
      `${path}.audioStreamIndex`,
      `cannot exceed ${cutTranscriptMediaAuthorityContract.maximumStreamIndex}.`,
    );
  }
  if (videoStreamIndex > cutTranscriptMediaAuthorityContract.maximumStreamIndex) {
    fail(
      "CUT_IR_LIMIT",
      `${path}.videoStreamIndex`,
      `cannot exceed ${cutTranscriptMediaAuthorityContract.maximumStreamIndex}.`,
    );
  }
  const videoFrameRate = rationalValue(
    object.videoFrameRate,
    `${path}.videoFrameRate`,
    context,
  );
  const videoDuration = rationalValue(
    object.videoDuration,
    `${path}.videoDuration`,
    context,
  );
  const audioAt = rationalValue(object.audioAt, `${path}.audioAt`, context);
  const videoAt = rationalValue(object.videoAt, `${path}.videoAt`, context);
  const videoRate = rationalValue(object.videoRate, `${path}.videoRate`, context);
  if (compareRational(videoFrameRate, zeroRational) <= 0) {
    fail("CUT_IR_TIMING", `${path}.videoFrameRate`, "must be positive.");
  }
  if (compareRational(videoDuration, zeroRational) <= 0) {
    fail("CUT_IR_TIMING", `${path}.videoDuration`, "must be positive.");
  }
  if (compareRational(audioAt, zeroRational) < 0) {
    fail("CUT_IR_TIMING", `${path}.audioAt`, "must be non-negative.");
  }
  if (compareRational(videoAt, zeroRational) < 0) {
    fail("CUT_IR_TIMING", `${path}.videoAt`, "must be non-negative.");
  }
  if (compareRational(videoRate, cutTranscriptMediaAuthorityContract.minimumVideoRate) < 0
    || compareRational(videoRate, cutTranscriptMediaAuthorityContract.maximumVideoRate) > 0) {
    fail("CUT_IR_TIMING", `${path}.videoRate`, "must be from 1/64 through 64.");
  }
  if (multiplyRational(videoAt, videoFrameRate).denominator !== "1") {
    fail(
      "CUT_IR_TIMING",
      `${path}.videoAt`,
      "must land exactly on the declared video frame grid.",
    );
  }
  if (compareRational(videoAt, videoDuration) >= 0) {
    fail("CUT_IR_TIMING", `${path}.videoAt`, "must be strictly earlier than videoDuration.");
  }
  provenance(object.provenance, `${path}.provenance`, context);
}

function transcriptMediaAuthoritiesValue(
  value: unknown,
  path: string,
  context: ValidationContext,
) {
  const authorities = arrayValue(
    value,
    path,
    context,
    Math.min(context.limits.maxTranscriptBindings, 1_024),
  );
  if (!authorities.length) {
    fail(
      "CUT_IR_IDENTITY",
      path,
      "empty transcriptMediaAuthorities must be omitted to preserve canonical legacy identity.",
    );
  }
  authorities.forEach((authority, index) =>
    transcriptMediaAuthorityValue(authority, `${path}[${index}]`, context));
  validateUniqueEntityIds(authorities as Array<{ id: string }>, path);
}

function transcriptBindingValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(
    value,
    path,
    [
      "id", "version", "kind", "compositionId", "sceneId", "transcriptResourceId",
      "audioResourceId", "from", "through", "selectedWordCount", "selectedIdsSha256",
      "text", "words", "sourceRange", "destinationRange", "media", "provenance",
    ],
    ["linkId", "mediaAuthorityId"],
  );
  idValue(object.id, `${path}.id`, context);
  if (safeInteger(object.version, `${path}.version`, 1) !== 1) {
    fail("CUT_IR_ENUM", `${path}.version`, "must be transcript-binding version 1.");
  }
  if (object.kind !== "transcript-edit") fail("CUT_IR_ENUM", `${path}.kind`, "must be transcript-edit.");
  idValue(object.compositionId, `${path}.compositionId`, context); consumeEdge(context, `${path}.compositionId`);
  idValue(object.sceneId, `${path}.sceneId`, context); consumeEdge(context, `${path}.sceneId`);
  idValue(object.transcriptResourceId, `${path}.transcriptResourceId`, context); consumeEdge(context, `${path}.transcriptResourceId`);
  idValue(object.audioResourceId, `${path}.audioResourceId`, context); consumeEdge(context, `${path}.audioResourceId`);
  transcriptWordIdValue(object.from, `${path}.from`, context);
  transcriptWordIdValue(object.through, `${path}.through`, context);
  const selectedWordCount = safeInteger(object.selectedWordCount, `${path}.selectedWordCount`, 1);
  const maximumWords = Math.min(
    context.limits.maxTranscriptWordsPerBinding,
    cutTranscriptExecutableLimits.maximumSelectedWords,
  );
  if (selectedWordCount > maximumWords) {
    fail("CUT_IR_LIMIT", `${path}.selectedWordCount`, `cannot exceed the active transcript word limit (${maximumWords}).`);
  }
  hashValue(object.selectedIdsSha256, `${path}.selectedIdsSha256`, context);
  transcriptBoundedString(
    object.text,
    `${path}.text`,
    context,
    cutTranscriptExecutableLimits.maximumSelectedTextBytes,
  );
  const words = arrayValue(object.words, `${path}.words`, context, maximumWords);
  if (!words.length) fail("CUT_IR_IDENTITY", `${path}.words`, "must contain at least one selected word.");
  words.forEach((word, index) => transcriptWordValue(word, `${path}.words[${index}]`, context));
  editorialIntervalValue(object.sourceRange, `${path}.sourceRange`, context);
  editorialIntervalValue(object.destinationRange, `${path}.destinationRange`, context);
  if (Object.hasOwn(object, "linkId")) editorialLinkValue(object.linkId, `${path}.linkId`, context);
  if (Object.hasOwn(object, "mediaAuthorityId")) {
    idValue(object.mediaAuthorityId, `${path}.mediaAuthorityId`, context);
    consumeEdge(context, `${path}.mediaAuthorityId`);
  }
  transcriptMediaValue(object.media, `${path}.media`, context);
  provenance(object.provenance, `${path}.provenance`, context);
}

function transcriptBindingsValue(value: unknown, path: string, context: ValidationContext) {
  const bindings = arrayValue(value, path, context, Math.min(context.limits.maxTranscriptBindings, 1_024));
  if (!bindings.length) fail("CUT_IR_IDENTITY", path, "empty transcriptBindings must be omitted to preserve canonical pre-extension identity.");
  bindings.forEach((binding, index) => transcriptBindingValue(binding, `${path}[${index}]`, context));
  validateUniqueEntityIds(bindings as Array<{ id: string }>, path);
}

function transcriptOnSampleGrid(value: Rational, sampleRate: number) {
  return (BigInt(value.numerator) * BigInt(sampleRate)) % BigInt(value.denominator) === 0n;
}

function validateTranscriptMediaAuthorityContracts(ir: CutAVIR) {
  if (!ir.transcriptMediaAuthorities) return;
  const compositionById = new Map(
    ir.compositions.map((composition) => [composition.id, composition]),
  );
  for (const [index, authority] of ir.transcriptMediaAuthorities.entries()) {
    const path = `$.transcriptMediaAuthorities[${index}]`;
    const composition = compositionById.get(authority.compositionId);
    if (!composition) {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.compositionId`,
        `references missing composition “${authority.compositionId}”.`,
      );
    }
    const scene = ir.scenes[authority.sceneId];
    if (!scene) {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.sceneId`,
        `references missing scene “${authority.sceneId}”.`,
      );
    }
    if (!composition.sceneIds.includes(scene.id)) {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.sceneId`,
        `scene “${scene.id}” does not belong to composition “${composition.id}”.`,
      );
    }
    const transcript = ir.resources[authority.transcriptResourceId];
    if (!transcript || transcript.kind !== "data") {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.transcriptResourceId`,
        "must reference one declared DataAsset resource.",
      );
    }
    const audio = ir.resources[authority.audioResourceId];
    if (!audio || audio.kind !== "audio") {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.audioResourceId`,
        "must reference one declared AudioAsset resource.",
      );
    }
    const video = ir.resources[authority.videoResourceId];
    if (!video || video.kind !== "video") {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.videoResourceId`,
        "must reference one declared VideoAsset resource.",
      );
    }
    if (audio.streamSelection?.audio !== authority.audioStreamIndex) {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.audioStreamIndex`,
        "must equal the AudioAsset explicit audio stream selection.",
      );
    }
    if (video.streamSelection?.video !== authority.videoStreamIndex) {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.videoStreamIndex`,
        "must equal the VideoAsset explicit video stream selection.",
      );
    }
    let expectedIdentity: string;
    try {
      expectedIdentity = cutTranscriptMediaAuthorityIdentity(authority);
    } catch (error) {
      if (!(error instanceof CutTranscriptMediaAuthorityError)) throw error;
      fail("CUT_IR_TIMING", path, error.message);
    }
    if (authority.identity !== expectedIdentity) {
      fail(
        "CUT_IR_HASH",
        `${path}.identity`,
        `does not match transcript media authority semantics (${expectedIdentity}).`,
      );
    }
  }
}

function validateTranscriptBindingContracts(ir: CutAVIR) {
  if (!ir.transcriptBindings) return;
  const compositionById = new Map(ir.compositions.map((composition) => [composition.id, composition]));
  const authorityById = new Map(
    (ir.transcriptMediaAuthorities ?? []).map((authority) => [authority.id, authority]),
  );
  for (const [index, binding] of ir.transcriptBindings.entries()) {
    const path = `$.transcriptBindings[${index}]`;
    const composition = compositionById.get(binding.compositionId);
    if (!composition) fail("CUT_IR_REFERENCE", `${path}.compositionId`, `references missing composition “${binding.compositionId}”.`);
    const scene = ir.scenes[binding.sceneId];
    if (!scene) fail("CUT_IR_REFERENCE", `${path}.sceneId`, `references missing scene “${binding.sceneId}”.`);
    if (!composition.sceneIds.includes(scene.id)) {
      fail("CUT_IR_REFERENCE", `${path}.sceneId`, `scene “${scene.id}” does not belong to composition “${composition.id}”.`);
    }
    const transcriptResource = ir.resources[binding.transcriptResourceId];
    if (!transcriptResource || transcriptResource.kind !== "data") {
      fail("CUT_IR_REFERENCE", `${path}.transcriptResourceId`, "must reference one declared DataAsset resource.");
    }
    const audioResource = ir.resources[binding.audioResourceId];
    if (!audioResource || audioResource.kind !== "audio") {
      fail("CUT_IR_REFERENCE", `${path}.audioResourceId`, "must reference one declared AudioAsset resource.");
    }
    if (binding.transcriptResourceId === binding.audioResourceId) {
      fail("CUT_IR_REFERENCE", `${path}.audioResourceId`, "cannot also be the transcript DataAsset resource.");
    }
    if (audioResource.sha256 !== undefined && audioResource.sha256 !== binding.media.sha256) {
      fail("CUT_IR_HASH", `${path}.media.sha256`, "does not match the locked AudioAsset resource digest.");
    }
    if (audioResource.streamSelection?.audio !== undefined
      && audioResource.streamSelection.audio !== binding.media.audioStreamIndex) {
      fail("CUT_IR_REFERENCE", `${path}.media.audioStreamIndex`, "does not match the AudioAsset authored stream selection.");
    }
    if (binding.selectedWordCount !== binding.words.length) {
      fail("CUT_IR_IDENTITY", `${path}.selectedWordCount`, "must equal the selected words array length.");
    }
    if (binding.words[0]!.id !== binding.from) {
      fail("CUT_IR_IDENTITY", `${path}.from`, "must equal the first selected word ID.");
    }
    if (binding.words.at(-1)!.id !== binding.through) {
      fail("CUT_IR_IDENTITY", `${path}.through`, "must equal the last selected word ID.");
    }
    const seenWordIds = new Set<string>();
    let previous: IRTranscriptBindingV1["words"][number] | undefined;
    for (const [wordIndex, word] of binding.words.entries()) {
      const wordPath = `${path}.words[${wordIndex}]`;
      if (seenWordIds.has(word.id)) fail("CUT_IR_IDENTITY", `${wordPath}.id`, `duplicates selected word ID “${word.id}”.`);
      seenWordIds.add(word.id);
      if (compareRational(word.start, zeroRational) < 0) fail("CUT_IR_TIMING", `${wordPath}.start`, "must be non-negative.");
      if (compareRational(word.end, word.start) <= 0) fail("CUT_IR_TIMING", `${wordPath}.end`, "must be strictly later than start.");
      if (compareRational(word.end, binding.media.duration) > 0) fail("CUT_IR_TIMING", `${wordPath}.end`, "exceeds the declared media duration.");
      if (previous && compareRational(word.start, previous.start) < 0) {
        fail("CUT_IR_TIMING", `${wordPath}.start`, "is out of chronological order.");
      }
      if (previous && compareRational(word.start, previous.end) < 0) {
        fail("CUT_IR_TIMING", `${wordPath}.start`, "overlaps the previous selected word.");
      }
      if (!transcriptOnSampleGrid(word.start, binding.media.audioSampleRate)) {
        fail("CUT_IR_TIMING", `${wordPath}.start`, `must land exactly on the declared ${binding.media.audioSampleRate} Hz media sample grid.`);
      }
      if (!transcriptOnSampleGrid(word.end, binding.media.audioSampleRate)) {
        fail("CUT_IR_TIMING", `${wordPath}.end`, `must land exactly on the declared ${binding.media.audioSampleRate} Hz media sample grid.`);
      }
      previous = word;
    }
    const selectedIds = binding.words.map((word) => word.id);
    const expectedSelectedIdsHash = hash(JSON.stringify(selectedIds));
    if (binding.selectedIdsSha256 !== expectedSelectedIdsHash) {
      fail("CUT_IR_HASH", `${path}.selectedIdsSha256`, `does not match the ordered selected word IDs (${expectedSelectedIdsHash}).`);
    }
    const reconstructedText = binding.words.map((word, wordIndex) =>
      `${wordIndex > 0 && word.join === "space" ? " " : ""}${word.text}`).join("");
    if (binding.text !== reconstructedText) {
      fail("CUT_IR_IDENTITY", `${path}.text`, "does not match deterministic selected-word join semantics.");
    }
    const first = binding.words[0]!, last = binding.words.at(-1)!;
    if (compareRational(binding.sourceRange.start, first.start) !== 0
      || compareRational(addRational(binding.sourceRange.start, binding.sourceRange.duration), last.end) !== 0) {
      fail("CUT_IR_IDENTITY", `${path}.sourceRange`, "must exactly span the first selected word start through the last selected word end.");
    }
    if (compareRational(binding.sourceRange.duration, binding.destinationRange.duration) !== 0) {
      fail("CUT_IR_TIMING", `${path}.destinationRange.duration`, "must equal the selected source duration.");
    }
    if (!transcriptOnSampleGrid(binding.sourceRange.start, binding.media.audioSampleRate)
      || !transcriptOnSampleGrid(addRational(binding.sourceRange.start, binding.sourceRange.duration), binding.media.audioSampleRate)) {
      fail("CUT_IR_TIMING", `${path}.sourceRange`, "must land exactly on the declared media audio-sample grid.");
    }
    const destinationEnd = addRational(binding.destinationRange.start, binding.destinationRange.duration);
    if (compareRational(destinationEnd, scene.duration) > 0) {
      fail("CUT_IR_TIMING", `${path}.destinationRange`, "exceeds the owning scene-local duration.");
    }
    if (!transcriptOnSampleGrid(binding.destinationRange.start, composition.sampleRate)
      || !transcriptOnSampleGrid(destinationEnd, composition.sampleRate)) {
      fail("CUT_IR_TIMING", `${path}.destinationRange`, `must land exactly on the owning composition ${composition.sampleRate} Hz audio-sample grid.`);
    }
    if (binding.mediaAuthorityId !== undefined) {
      const authority = authorityById.get(binding.mediaAuthorityId);
      if (!authority) {
        fail(
          "CUT_IR_REFERENCE",
          `${path}.mediaAuthorityId`,
          `references missing transcript media authority “${binding.mediaAuthorityId}”.`,
        );
      }
      if (authority.compositionId !== binding.compositionId
        || authority.sceneId !== binding.sceneId
        || authority.transcriptResourceId !== binding.transcriptResourceId
        || authority.audioResourceId !== binding.audioResourceId
        || authority.audioStreamIndex !== binding.media.audioStreamIndex) {
        fail(
          "CUT_IR_IDENTITY",
          `${path}.mediaAuthorityId`,
          "authority ownership, transcript, audio resource, or selected audio stream does not match this transcript binding.",
        );
      }
      if (!transcriptOnSampleGrid(authority.audioAt, binding.media.audioSampleRate)) {
        fail(
          "CUT_IR_TIMING",
          `${path}.mediaAuthorityId`,
          `authority audioAt must land exactly on the declared ${binding.media.audioSampleRate} Hz media sample grid.`,
        );
      }
    }
  }
}

const transcriptAudioAuthoringOp = "cut.edit.transcript_audio";
const transcriptPictureAuthoringOp = "cut.edit.transcript_picture";
const transcriptAudioConsumerOp = "cut.audio.clip";
const transcriptPictureConsumerOp = "cut.edit.picture_clip";
const transcriptCaptionConsumerOp = "cut.visual.transcript_captions";

/**
 * Public TranscriptAudio and TranscriptCaptions authoring operands are
 * compiler-only. Reject them before the generic kernel pass so a forged
 * artifact cannot reinterpret source syntax as an executable IR contract.
 */
function validatePersistedTranscriptConsumerSurface(ir: CutAVIR) {
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const path = childPath("$.nodes", nodeId);
    if (node.op === transcriptAudioAuthoringOp || node.op === transcriptPictureAuthoringOp) {
      const consumer = node.op === transcriptAudioAuthoringOp
        ? transcriptAudioConsumerOp
        : transcriptPictureConsumerOp;
      fail(
        "CUT_IR_ENUM",
        `${path}.op`,
        `${node.op} is a compiler-only authoring operation and must lower to ${consumer} before CutAVIR is persisted.`,
      );
    }
    if (node.inputs.transcriptBindingId !== undefined
      && node.op !== transcriptAudioConsumerOp
      && node.op !== transcriptPictureConsumerOp
      && node.op !== transcriptCaptionConsumerOp) {
      fail(
        "CUT_IR_UNKNOWN_FIELD",
        `${path}.inputs.transcriptBindingId`,
        `transcriptBindingId is valid only on ${transcriptAudioConsumerOp}, ${transcriptPictureConsumerOp}, or ${transcriptCaptionConsumerOp}.`,
      );
    }
    if (node.inputs.transcriptPictureIdentity !== undefined
      && node.op !== transcriptPictureConsumerOp) {
      fail(
        "CUT_IR_UNKNOWN_FIELD",
        `${path}.inputs.transcriptPictureIdentity`,
        `transcriptPictureIdentity is valid only on ${transcriptPictureConsumerOp}.`,
      );
    }
    for (const input of [
      "transcriptMediaAuthorityId",
      "transcriptPictureOriginIdentity",
      "transcriptPictureSegmentIdentity",
    ] as const) {
      if (node.inputs[input] !== undefined && node.op !== transcriptPictureConsumerOp) {
        fail(
          "CUT_IR_UNKNOWN_FIELD",
          `${path}.inputs.${input}`,
          `${input} is valid only on ${transcriptPictureConsumerOp}.`,
        );
      }
    }
    if (node.op === transcriptCaptionConsumerOp && node.inputs.edit !== undefined) {
      fail(
        "CUT_IR_UNKNOWN_FIELD",
        `${path}.inputs.edit`,
        "the public TranscriptEdit authoring value must be lowered away before transcript captions enter CutAVIR.",
      );
    }
  }
}

function transcriptConsumerString(value: IRValue | undefined, path: string, label: string) {
  if (!value) fail("CUT_IR_MISSING_FIELD", path, `is required for ${label}.`);
  if (value.kind !== "string") fail("CUT_IR_TYPE", path, `must be one canonical String for ${label}.`);
  return value.value;
}

function transcriptConsumerTime(value: IRValue | undefined, path: string, label: string) {
  if (!value) fail("CUT_IR_MISSING_FIELD", path, `is required for ${label}.`);
  if (value.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    fail("CUT_IR_TYPE", path, `must be one canonical Time quantity in seconds for ${label}.`);
  }
  return value.magnitude;
}

function transcriptConsumerIntegerScalar(
  value: IRValue | undefined,
  path: string,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (!value) fail("CUT_IR_MISSING_FIELD", path, `is required for ${label}.`);
  if (value.kind !== "quantity"
    || value.dimension !== "scalar"
    || value.unit !== "scalar"
    || value.magnitude.denominator !== "1") {
    fail("CUT_IR_TYPE", path, `must be one exact whole scalar Number for ${label}.`);
  }
  if (compareRational(value.magnitude, rational(minimum)) < 0
    || compareRational(value.magnitude, rational(maximum)) > 0) {
    fail("CUT_IR_LIMIT", path, `${label} must be from ${minimum} through ${maximum}.`);
  }
  return Number(value.magnitude.numerator);
}

function transcriptConsumerRange(value: IRValue | undefined, path: string, label: string): IREditorialInterval {
  if (!value) fail("CUT_IR_MISSING_FIELD", path, `is required for ${label}.`);
  if (value.kind !== "range" || value.exclusive !== true) {
    fail("CUT_IR_TYPE", path, `must be one exact half-open Range<Time> for ${label}.`);
  }
  const start = transcriptConsumerTime(value.start, `${path}.start`, `${label} start`);
  const end = transcriptConsumerTime(value.end, `${path}.end`, `${label} end`);
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    fail("CUT_IR_TIMING", path, `${label} must have a non-negative start and a strictly later end.`);
  }
  return { start, duration: subtractRational(end, start) };
}

function transcriptSameInterval(left: IREditorialInterval, right: IREditorialInterval) {
  return compareRational(left.start, right.start) === 0
    && compareRational(left.duration, right.duration) === 0;
}

function validateTranscriptConsumerContracts(ir: CutAVIR) {
  const bindings = new Map((ir.transcriptBindings ?? []).map((binding) => [binding.id, binding]));
  const sceneComposition = new Map<string, string>();
  for (const composition of ir.compositions) {
    for (const sceneId of composition.sceneIds) sceneComposition.set(sceneId, composition.id);
  }
  const resolveBinding = (node: IRNode, path: string) => {
    const bindingInputPath = `${path}.inputs.transcriptBindingId`;
    const bindingId = transcriptConsumerString(
      node.inputs.transcriptBindingId,
      bindingInputPath,
      `${node.op} transcript binding`,
    );
    const binding = bindings.get(bindingId);
    if (!binding) {
      fail("CUT_IR_REFERENCE", `${bindingInputPath}.value`, `references missing transcript binding “${bindingId}”.`);
    }
    if (!node.sceneId || node.sceneId !== binding.sceneId) {
      fail("CUT_IR_IDENTITY", `${path}.sceneId`, `must equal transcript binding ${binding.id} scene “${binding.sceneId}”.`);
    }
    if (sceneComposition.get(node.sceneId) !== binding.compositionId) {
      fail("CUT_IR_IDENTITY", `${path}.sceneId`, `must belong to transcript binding ${binding.id} composition “${binding.compositionId}”.`);
    }
    return binding;
  };
  const rejectUnsupportedInputs = (node: IRNode, path: string, allowed: ReadonlySet<string>) => {
    for (const input of Object.keys(node.inputs)) if (!allowed.has(input)) {
      fail("CUT_IR_UNKNOWN_FIELD", diagnosticChildPath(`${path}.inputs`, input), `is not part of the closed transcript-bound ${node.op} input contract.`);
    }
  };
  const exactResource = (
    value: IRValue | undefined,
    path: string,
    expectedId: string,
    expectedKind: "audio" | "font" | "video",
  ) => {
    if (!value) fail("CUT_IR_MISSING_FIELD", path, `must reference transcript ${expectedKind} resource “${expectedId}”.`);
    if (value.kind !== "resource-ref") fail("CUT_IR_TYPE", path, `must be a direct ${expectedKind} resource reference.`);
    if (value.id !== expectedId) fail("CUT_IR_REFERENCE", `${path}.id`, `must reference transcript ${expectedKind} resource “${expectedId}”.`);
    if (ir.resources[value.id]?.kind !== expectedKind) {
      const type = expectedKind === "audio" ? "AudioAsset" : expectedKind === "video" ? "VideoAsset" : "FontAsset";
      fail("CUT_IR_REFERENCE", `${path}.id`, `must reference one declared ${type} resource.`);
    }
  };
  const exactLink = (
    value: IRValue | undefined,
    path: string,
    expected: string | undefined,
  ) => {
    if (expected === undefined) {
      if (value !== undefined) fail("CUT_IR_IDENTITY", path, "must be absent because the transcript binding has no linkId.");
      return;
    }
    const actual = transcriptConsumerString(value, path, "transcript editorial link");
    if (actual !== expected) fail("CUT_IR_IDENTITY", `${path}.value`, `must equal transcript binding linkId “${expected}”.`);
  };

  const audioAllowed = new Set([
    "source", "range", "destination", "fadeIn", "fadeOut", "headHandle", "tailHandle",
    "link", "transcriptBindingId",
  ]);
  const captionAllowed = new Set([
    "font", "maxWords", "size", "color", "background", "position", "align",
    "safeX", "safeY", "maxWidth", "padding", "radius", "lineHeight",
    "transcriptBindingId", "transcriptCaptionIdentity",
  ]);
  const pictureAllowed = new Set([
    "source", "range", "duration", "headHandle", "tailHandle", "playback", "rate",
    "fit", "opacity", "scale", "rotation",
    "inputColor", "inputColorInterpretation", "link",
    "transcriptBindingId", "transcriptPictureIdentity",
    "transcriptMediaAuthorityId", "transcriptPictureOriginIdentity",
    "transcriptPictureSegmentIdentity",
  ]);
  const authorities = new Map(
    (ir.transcriptMediaAuthorities ?? []).map((authority) => [authority.id, authority]),
  );
  const defaultPictureTimeMap = (): IRPictureTimeMap => ({
    kind: "constant",
    direction: "forward",
    rate: rational(1),
  });
  const authorityTimeMap = (
    inputs: Readonly<Record<string, IRValue>>,
    itemTimeMap: IRPictureTimeMap | undefined,
    path: string,
  ) => {
    const map = itemTimeMap ?? defaultPictureTimeMap();
    if (map.kind !== "constant" || map.direction !== "forward") {
      fail(
        "CUT_IR_TIMING",
        path,
        "authority-backed TranscriptPicture admits only one exact forward constant time map.",
      );
    }
    const rateInput = inputs.rate;
    if (rateInput === undefined) {
      if (compareRational(map.rate, rational(1)) !== 0) {
        fail("CUT_IR_TIMING", path, "an authored non-unit time map requires an exact rate input.");
      }
    } else {
      if (rateInput.kind !== "quantity"
        || rateInput.dimension !== "scalar"
        || rateInput.unit !== "scalar") {
        fail("CUT_IR_TYPE", `${path}.rate`, "must be one exact scalar rate.");
      }
      if (compareRational(rateInput.magnitude, map.rate) !== 0) {
        fail("CUT_IR_IDENTITY", `${path}.rate`, "must equal the owning PictureTrack item time map.");
      }
    }
    if (compareRational(map.rate, rational(1, 64)) < 0
      || compareRational(map.rate, rational(64)) > 0) {
      fail("CUT_IR_TIMING", path, "authority-backed picture rate must be from 1/64 through 64.");
    }
    return map;
  };
  const authorityPictureRange = (
    binding: IRTranscriptBindingV1,
    authority: IRTranscriptMediaAuthorityV1,
    path: string,
  ) => {
    try {
      const cover = cutTranscriptPictureCoverRange(
        cutTranscriptMediaVideoSourceRange(binding.sourceRange, authority),
        authority.videoFrameRate,
        authority.videoDuration,
      );
      // The cover helper also returns diagnostic frame facts. Lineage identity
      // deliberately binds only the canonical source interval, exactly as the
      // compiler does, so non-semantic helper fields cannot perturb identity.
      return { start: cover.start, duration: cover.duration };
    } catch (error) {
      if (!(error instanceof CutTranscriptMediaAuthorityError)
        && !(error instanceof CutTranscriptPictureSnapError)) throw error;
      fail("CUT_IR_TIMING", path, error.message);
    }
  };
  const authorityForBinding = (
    binding: IRTranscriptBindingV1,
    path: string,
  ) => {
    if (binding.mediaAuthorityId === undefined) {
      fail("CUT_IR_REFERENCE", path, "requires one transcript media authority.");
    }
    const authority = authorities.get(binding.mediaAuthorityId);
    if (!authority) {
      fail(
        "CUT_IR_REFERENCE",
        path,
        `references missing transcript media authority “${binding.mediaAuthorityId}”.`,
      );
    }
    return authority;
  };
  const exactAuthorityPictureResource = (
    inputs: Readonly<Record<string, IRValue>>,
    authority: IRTranscriptMediaAuthorityV1,
    path: string,
  ) => {
    const source = inputs.source;
    if (source?.kind !== "resource-ref") {
      fail("CUT_IR_TYPE", `${path}.source`, "must be one direct VideoAsset resource reference.");
    }
    if (source.id !== authority.videoResourceId) {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.source.id`,
        `must reference authority video resource “${authority.videoResourceId}”.`,
      );
    }
    exactResource(source, `${path}.source`, authority.videoResourceId, "video");
    const videoResource = ir.resources[source.id]!;
    if (videoResource.streamSelection?.video !== authority.videoStreamIndex) {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.source.id`,
        `must explicitly select authenticated video stream ${authority.videoStreamIndex}.`,
      );
    }
    if (videoResource.proxy !== undefined && videoResource.state === "locked") {
      const metadata = isRecord(videoResource.metadata) ? videoResource.metadata : undefined;
      const lockedProxy = metadata && isRecord(metadata.proxy) ? metadata.proxy : undefined;
      const alignment = lockedProxy && isRecord(lockedProxy.videoAlignment)
        ? lockedProxy.videoAlignment
        : undefined;
      if (alignment?.format !== "cut-video-proxy-alignment"
        || alignment.version !== 1
        || alignment.method !== "cut-frame-rgb-mae-v1"
        || alignment.decision !== "equivalent") {
        fail(
          "CUT_TRANSCRIPT_PICTURE_PROXY",
          `${childPath("$.resources", videoResource.id)}.metadata.proxy.videoAlignment`,
          "Locked TranscriptPicture proxy requires authenticated decoded-frame correspondence.",
        );
      }
    }
    return source.id;
  };
  const authorityInputIdentity = (
    inputs: Readonly<Record<string, IRValue>>,
    name: "transcriptMediaAuthorityId" | "transcriptPictureOriginIdentity"
      | "transcriptPictureSegmentIdentity",
    path: string,
  ) => transcriptConsumerString(
    inputs[name],
    `${path}.${name}`,
    `authority-backed TranscriptPicture ${name}`,
  );
  const validateAuthorityOrigin = (
    inputs: Readonly<Record<string, IRValue>>,
    binding: IRTranscriptBindingV1,
    authority: IRTranscriptMediaAuthorityV1,
    sourceRange: IREditorialInterval,
    destinationRange: IREditorialInterval,
    timeMap: IRPictureTimeMap,
    path: string,
  ) => {
    const authorityId = authorityInputIdentity(
      inputs,
      "transcriptMediaAuthorityId",
      path,
    );
    if (authorityId !== authority.id) {
      fail(
        "CUT_IR_REFERENCE",
        `${path}.transcriptMediaAuthorityId.value`,
        `must reference transcript media authority “${authority.id}”.`,
      );
    }
    const origin = authorityInputIdentity(
      inputs,
      "transcriptPictureOriginIdentity",
      path,
    );
    const expected = cutTranscriptPictureOriginIdentity({
      transcriptBindingId: binding.id,
      transcriptMediaAuthorityId: authority.id,
      transcriptMediaAuthorityIdentity: authority.identity,
      audioResourceId: binding.audioResourceId,
      pictureResourceId: authority.videoResourceId,
      mappedSourceRange: sourceRange,
      destinationRange,
      timeMap,
      ...(binding.linkId === undefined ? {} : { linkId: binding.linkId }),
    });
    if (origin !== expected) {
      fail(
        "CUT_IR_HASH",
        `${path}.transcriptPictureOriginIdentity.value`,
        `does not match authenticated transcript picture origin semantics (${expected}).`,
      );
    }
    return origin;
  };
  const validateAuthoritySegment = (
    inputs: Readonly<Record<string, IRValue>>,
    origin: string,
    sourceRange: IREditorialInterval,
    destinationRange: IREditorialInterval,
    timeMap: IRPictureTimeMap,
    path: string,
  ) => {
    const segment = authorityInputIdentity(
      inputs,
      "transcriptPictureSegmentIdentity",
      path,
    );
    const expected = cutTranscriptPictureSegmentIdentity({
      transcriptPictureOriginIdentity: origin,
      sourceRange,
      destinationRange,
      timeMap,
    });
    if (segment !== expected) {
      fail(
        "CUT_IR_HASH",
        `${path}.transcriptPictureSegmentIdentity.value`,
        `does not match authenticated transcript picture segment semantics (${expected}).`,
      );
    }
  };
  const authorityValidatedNodes = new Set<string>();
  const timelineEditSegment = (
    track: IRNode,
    item: Extract<IREditorial, { kind: "picture-track" | "audio-track" }>["items"][number],
    domain: "picture" | "audio",
    path: string,
  ) => {
    const editorial = track.editorial;
    if (!editorial
      || (editorial.kind !== "picture-track" && editorial.kind !== "audio-track")
      || !editorial.trackId
      || !track.sceneId) return undefined;
    const plans = (ir.timelineEdits ?? []).filter((plan) =>
      plan.sceneId === track.sceneId
      && plan.tracks.some((candidate) =>
        candidate.trackId === editorial.trackId && candidate.domain === domain));
    if (!plans.length) return undefined;
    if (plans.length !== 1) {
      fail(
        "CUT_IR_REFERENCE",
        path,
        `transcript-owned track ${JSON.stringify(editorial.trackId)} must belong to exactly one canonical TimelineEdit plan.`,
      );
    }
    const plan = plans[0]!;
    if (plan.operations.some((operation) =>
      operation.kind !== "split"
      && operation.kind !== "trim"
      && operation.kind !== "ripple-delete")) {
      fail(
        "CUT_IR_IDENTITY",
        `$.timelineEdits.${plan.id}.operations`,
        "transcript-selected picture/audio currently admit canonical linked split, trim, and ripple-delete operations.",
      );
    }
    const baseTrack = plan.tracks.find((candidate) =>
      candidate.trackId === editorial.trackId && candidate.domain === domain);
    const executed = executeTimelineEditPlan(plan).tracks.find((candidate) =>
      candidate.trackId === editorial.trackId && candidate.domain === domain);
    const index = editorial.items.findIndex((candidate) => candidate.nodeId === item.nodeId);
    const result = index < 0 ? undefined : executed?.items[index];
    if (!baseTrack || !executed || !result
      || item.editId !== result.originId
      || !transcriptSameInterval(item.destination, result.destination)
      || item.linkId !== result.linkId) {
      fail(
        "CUT_IR_IDENTITY",
        path,
        "transcript segment does not match the exact canonical TimelineEdit replay result.",
      );
    }
    const base = baseTrack.items.find((candidate) =>
      candidate.originId === result.originId);
    if (!base) {
      fail(
        "CUT_IR_REFERENCE",
        path,
        "transcript segment lost its canonical TimelineEdit origin item.",
      );
    }
    return { plan, base, result };
  };
  const exactTimelineEditHandles = (
    inputs: Readonly<Record<string, IRValue>>,
    expected: Readonly<{ head: Rational; tail: Rational }>,
    path: string,
  ) => {
    for (const [name, amount] of [
      ["headHandle", expected.head],
      ["tailHandle", expected.tail],
    ] as const) {
      const input = inputs[name];
      if (compareRational(amount, zeroRational) === 0) {
        if (input !== undefined) {
          fail(
            "CUT_IR_UNKNOWN_FIELD",
            `${path}.${name}`,
            "must be omitted when the canonical TimelineEdit result has no corresponding source handle.",
          );
        }
        continue;
      }
      const actual = transcriptConsumerTime(
        input,
        `${path}.${name}`,
        `canonical TimelineEdit ${name}`,
      );
      if (compareRational(actual, amount) !== 0) {
        fail(
          "CUT_IR_IDENTITY",
          `${path}.${name}`,
          "must exactly equal the source handle produced by canonical TimelineEdit replay.",
        );
      }
    }
  };

  for (const [trackId, track] of Object.entries(ir.nodes)) {
    if (track.editorial?.kind !== "picture-track") continue;
    const editorial = track.editorial;
    const plan = editorial.operationPlan;
    if (!plan) continue;
    const trackPath = childPath("$.nodes", trackId);
    const authorityBase = plan.baseItems.filter(
      (item) => item.kind === "picture"
        && item.inputs.transcriptMediaAuthorityId !== undefined,
    );
    if (!authorityBase.length) continue;
    if (editorial.transitions !== undefined
      || plan.operations.some((operation) =>
        operation.kind !== "split" && operation.kind !== "trim")) {
      fail(
        "CUT_IR_IDENTITY",
        `${trackPath}.editorial.operationPlan`,
        "authority-backed TranscriptPicture admits only split/trim materialization without transitions.",
      );
    }
    for (const base of authorityBase) {
      const baseIndex = plan.baseItems.indexOf(base);
      const basePath = `${trackPath}.editorial.operationPlan.baseItems[${baseIndex}]`;
      const bindingId = transcriptConsumerString(
        base.inputs.transcriptBindingId,
        `${basePath}.inputs.transcriptBindingId`,
        "authority-backed transcript binding",
      );
      const binding = bindings.get(bindingId);
      if (!binding) {
        fail(
          "CUT_IR_REFERENCE",
          `${basePath}.inputs.transcriptBindingId.value`,
          `references missing transcript binding “${bindingId}”.`,
        );
      }
      const authority = authorityForBinding(
        binding,
        `${basePath}.inputs.transcriptMediaAuthorityId`,
      );
      exactAuthorityPictureResource(base.inputs, authority, `${basePath}.inputs`);
      const fullSource = authorityPictureRange(
        binding,
        authority,
        `${basePath}.inputs.transcriptBindingId`,
      );
      if (!base.source || !transcriptSameInterval(base.source, fullSource)) {
        fail(
          "CUT_IR_IDENTITY",
          `${basePath}.source`,
          "must equal the authenticated authority-mapped source-frame cover.",
        );
      }
      const inputSource = transcriptConsumerRange(
        base.inputs.range,
        `${basePath}.inputs.range`,
        "authority-backed base source range",
      );
      if (!transcriptSameInterval(inputSource, base.source)) {
        fail("CUT_IR_IDENTITY", `${basePath}.inputs.range`, "must equal the base item source.");
      }
      const timeMap = authorityTimeMap(
        base.inputs,
        base.timeMap,
        `${basePath}.inputs`,
      );
      const absoluteDestination = {
        start: addRational(track.interval.start, base.destination.start),
        duration: base.destination.duration,
      };
      const origin = validateAuthorityOrigin(
        base.inputs,
        binding,
        authority,
        fullSource,
        absoluteDestination,
        timeMap,
        `${basePath}.inputs`,
      );
      validateAuthoritySegment(
        base.inputs,
        origin,
        fullSource,
        absoluteDestination,
        timeMap,
        `${basePath}.inputs`,
      );
    }
    let execution;
    try {
      execution = executePictureTrackOperationPlan(plan);
    } catch (error) {
      if (!(error instanceof PictureEditOperationError)) throw error;
      fail(
        error.kind === "time" ? "CUT_IR_TIMING" : "CUT_IR_IDENTITY",
        `${trackPath}.editorial.operationPlan`,
        error.message,
      );
    }
    if (execution.transitions.length) {
      fail(
        "CUT_IR_IDENTITY",
        `${trackPath}.editorial.transitions`,
        "authority-backed TranscriptPicture cannot materialize transitions.",
      );
    }
    const editorialItems = editorial.items;
    if (execution.items.length !== editorialItems.length) {
      fail(
        "CUT_IR_IDENTITY",
        `${trackPath}.editorial.items`,
        "does not match deterministic picture operation materialization.",
      );
    }
    execution.items.forEach((expected, index) => {
      const item = editorialItems[index];
      const itemPath = `${trackPath}.editorial.items[${index}]`;
      const expectedNodeId = pictureEditMaterializedNodeId(track.id, index, expected);
      if (!item || item.nodeId !== expectedNodeId) {
        fail(
          "CUT_IR_IDENTITY",
          `${itemPath}.nodeId`,
          `must equal deterministic materialized node identity “${expectedNodeId}”.`,
        );
      }
      const node = ir.nodes[item.nodeId];
      if (!node) return;
      const authorityId = expected.inputs.transcriptMediaAuthorityId;
      if (authorityId === undefined) return;
      const bindingId = transcriptConsumerString(
        expected.inputs.transcriptBindingId,
        `${itemPath}.inputs.transcriptBindingId`,
        "authority-backed transcript binding",
      );
      const binding = bindings.get(bindingId);
      if (!binding) {
        fail(
          "CUT_IR_REFERENCE",
          `${itemPath}.inputs.transcriptBindingId.value`,
          `references missing transcript binding “${bindingId}”.`,
        );
      }
      const authority = authorityForBinding(
        binding,
        `${itemPath}.inputs.transcriptMediaAuthorityId`,
      );
      exactAuthorityPictureResource(node.inputs, authority, `${childPath("$.nodes", node.id)}.inputs`);
      const nodePath = childPath("$.nodes", node.id);
      rejectUnsupportedInputs(node, nodePath, pictureAllowed);
      if (!expected.source) {
        fail("CUT_IR_IDENTITY", `${itemPath}.source`, "authority-backed materialization lost its source.");
      }
      const nodeSource = transcriptConsumerRange(
        node.inputs.range,
        `${nodePath}.inputs.range`,
        "authority-backed segment source range",
      );
      const relativeDestination = {
        start: subtractRational(node.interval.start, track.interval.start),
        duration: node.interval.duration,
      };
      const timeMap = authorityTimeMap(
        node.inputs,
        item.timeMap,
        `${nodePath}.inputs`,
      );
      const origin = authorityInputIdentity(
        node.inputs,
        "transcriptPictureOriginIdentity",
        `${nodePath}.inputs`,
      );
      const expectedOrigin = authorityInputIdentity(
        expected.inputs,
        "transcriptPictureOriginIdentity",
        itemPath,
      );
      if (origin !== expectedOrigin) {
        fail(
          "CUT_IR_HASH",
          `${nodePath}.inputs.transcriptPictureOriginIdentity.value`,
          `must preserve authenticated origin identity “${expectedOrigin}” through split/trim materialization.`,
        );
      }
      validateAuthoritySegment(
        node.inputs,
        origin,
        nodeSource,
        relativeDestination,
        timeMap,
        `${nodePath}.inputs`,
      );
      if (stableJsonStringify(node.inputs) !== stableJsonStringify(expected.inputs)
        || !transcriptSameInterval(nodeSource, expected.source)
        || !transcriptSameInterval(relativeDestination, expected.destination)
        || stableJsonStringify(item.source) !== stableJsonStringify(expected.source)
        || stableJsonStringify(item.timeMap) !== stableJsonStringify(expected.timeMap)) {
        fail(
          "CUT_IR_IDENTITY",
          nodePath,
          "does not match deterministic authority-backed split/trim materialization.",
        );
      }
      if (node.ownership !== "child"
        || node.sceneId !== binding.sceneId
        || !track.children.includes(node.id)
        || Object.keys(node.properties).length
        || node.editorial !== undefined) {
        fail(
          "CUT_IR_IDENTITY",
          nodePath,
          "must remain one immutable child of its same-scene PictureTrack owner.",
        );
      }
      authorityValidatedNodes.add(node.id);
    });
  }

  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const path = childPath("$.nodes", nodeId);
    if (node.op === transcriptAudioConsumerOp && node.inputs.transcriptBindingId !== undefined) {
      const binding = resolveBinding(node, path);
      rejectUnsupportedInputs(node, path, audioAllowed);
      exactResource(node.inputs.source, `${path}.inputs.source`, binding.audioResourceId, "audio");
      const sourceRange = transcriptConsumerRange(node.inputs.range, `${path}.inputs.range`, "transcript source range");
      const destinationRange = transcriptConsumerRange(node.inputs.destination, `${path}.inputs.destination`, "transcript destination range");
      exactLink(node.inputs.link, `${path}.inputs.link`, binding.linkId);
      const fades = (["fadeIn", "fadeOut"] as const).map((name) => {
        const value = node.inputs[name];
        if (value === undefined) return zeroRational;
        const amount = transcriptConsumerTime(value, `${path}.inputs.${name}`, `transcript ${name}`);
        if (compareRational(amount, zeroRational) < 0) {
          fail("CUT_IR_TIMING", `${path}.inputs.${name}`, `transcript ${name} cannot be negative.`);
        }
        return amount;
      });
      if (compareRational(addRational(fades[0], fades[1]), binding.sourceRange.duration) > 0) {
        fail("CUT_IR_TIMING", `${path}.inputs`, "transcript fadeIn plus fadeOut cannot exceed the selected source duration.");
      }
      if (node.editorial !== undefined) {
        fail("CUT_IR_UNKNOWN_FIELD", `${path}.editorial`, "a transcript-bound AudioClip cannot own nested editorial semantics.");
      }
      const trackOwners: Array<{
        track: IRNode;
        item: Extract<IREditorial, { kind: "audio-track" }>["items"][number];
        itemPath: string;
      }> = [];
      for (const [trackId, track] of Object.entries(ir.nodes)) {
        if (track.editorial?.kind !== "audio-track") continue;
        track.editorial.items.forEach((item, index) => {
          if (item.nodeId === node.id) trackOwners.push({
            track,
            item,
            itemPath: `${childPath("$.nodes", trackId)}.editorial.items[${index}]`,
          });
        });
      }
      if (trackOwners.length !== 1) {
        fail("CUT_IR_IDENTITY", path, "a transcript-bound AudioClip must be exactly one direct AudioTrack editorial item.");
      }
      const owner = trackOwners[0]!;
      if (node.ownership !== "child"
        || owner.track.sceneId !== binding.sceneId
        || !owner.track.children.includes(node.id)) {
        fail("CUT_IR_IDENTITY", path, "a transcript-bound AudioClip must be one child of its same-scene AudioTrack owner.");
      }
      const timelineSegment = timelineEditSegment(
        owner.track,
        owner.item,
        "audio",
        owner.itemPath,
      );
      if (owner.item.kind !== "audio" || owner.item.sourceNodeId !== undefined || owner.item.linkSegmentId !== undefined) {
        fail(
          "CUT_IR_IDENTITY",
          owner.itemPath,
          "must remain a direct transcript audio item or an exact canonical TimelineEdit split result.",
        );
      }
      if (owner.item.linkId !== binding.linkId) {
        fail("CUT_IR_IDENTITY", `${owner.itemPath}.linkId`, "must exactly equal the transcript binding optional linkId.");
      }
      if (timelineSegment) {
        if (timelineSegment.base.sourceView.kind !== "audio"
          || timelineSegment.result.sourceView.kind !== "audio"
          || !transcriptSameInterval(timelineSegment.base.sourceView.source, binding.sourceRange)
          || !transcriptSameInterval(timelineSegment.base.destination, binding.destinationRange)
          || !transcriptSameInterval(timelineSegment.result.sourceView.source, sourceRange)
          || !transcriptSameInterval(timelineSegment.result.destination, destinationRange)
          || !transcriptSameInterval(owner.item.source!, sourceRange)
          || !transcriptSameInterval(owner.item.destination, destinationRange)
          || !transcriptSameInterval(node.interval, destinationRange)) {
          fail(
            "CUT_IR_IDENTITY",
            owner.itemPath,
            "must be one exact canonical TimelineEdit slice of the authenticated transcript audio origin.",
          );
        }
        exactTimelineEditHandles(
          node.inputs,
          timelineSegment.result.sourceView.handles,
          `${path}.inputs`,
        );
      } else {
        exactTimelineEditHandles(
          node.inputs,
          { head: zeroRational, tail: zeroRational },
          `${path}.inputs`,
        );
        if (!transcriptSameInterval(sourceRange, binding.sourceRange)) {
          fail("CUT_IR_IDENTITY", `${path}.inputs.range`, "must exactly equal the transcript binding sourceRange.");
        }
        if (!transcriptSameInterval(destinationRange, binding.destinationRange)) {
          fail("CUT_IR_IDENTITY", `${path}.inputs.destination`, "must exactly equal the transcript binding destinationRange.");
        }
        if (!transcriptSameInterval(node.interval, binding.destinationRange)) {
          fail("CUT_IR_IDENTITY", `${path}.interval`, "must exactly equal the transcript binding destinationRange.");
        }
        if (!owner.item.source || !transcriptSameInterval(owner.item.source, binding.sourceRange)) {
          fail("CUT_IR_IDENTITY", `${owner.itemPath}.source`, "must exactly equal the transcript binding sourceRange.");
        }
        if (!transcriptSameInterval(owner.item.destination, binding.destinationRange)) {
          fail("CUT_IR_IDENTITY", `${owner.itemPath}.destination`, "must exactly equal the transcript binding destinationRange.");
        }
      }
    }

    if (node.op === transcriptPictureConsumerOp
      && (node.inputs.transcriptBindingId !== undefined
        || node.inputs.transcriptPictureIdentity !== undefined
        || node.inputs.transcriptMediaAuthorityId !== undefined
        || node.inputs.transcriptPictureOriginIdentity !== undefined
        || node.inputs.transcriptPictureSegmentIdentity !== undefined)) {
      const binding = resolveBinding(node, path);
      rejectUnsupportedInputs(node, path, pictureAllowed);
      if (binding.mediaAuthorityId !== undefined) {
        if (node.inputs.transcriptPictureIdentity !== undefined) {
          fail(
            "CUT_IR_UNKNOWN_FIELD",
            `${path}.inputs.transcriptPictureIdentity`,
            "legacy transcriptPictureIdentity cannot accompany authority-backed picture lineage.",
          );
        }
        if (authorityValidatedNodes.has(node.id)) continue;
        const authority = authorityForBinding(
          binding,
          `${path}.inputs.transcriptMediaAuthorityId`,
        );
        exactAuthorityPictureResource(node.inputs, authority, `${path}.inputs`);
        const sourceRange = transcriptConsumerRange(
          node.inputs.range,
          `${path}.inputs.range`,
          "authority-backed transcript picture source range",
        );
        const fullSource = authorityPictureRange(
          binding,
          authority,
          `${path}.inputs.transcriptBindingId`,
        );
        const duration = transcriptConsumerTime(
          node.inputs.duration,
          `${path}.inputs.duration`,
          "authority-backed transcript picture duration",
        );
        const trackOwners: Array<{
          track: IRNode;
          item: Extract<IREditorial, { kind: "picture-track" }>["items"][number];
          itemPath: string;
        }> = [];
        for (const [trackId, track] of Object.entries(ir.nodes)) {
          if (track.editorial?.kind !== "picture-track") continue;
          track.editorial.items.forEach((item, index) => {
            if (item.nodeId === node.id) trackOwners.push({
              track,
              item,
              itemPath: `${childPath("$.nodes", trackId)}.editorial.items[${index}]`,
            });
          });
        }
        if (trackOwners.length !== 1) {
          fail(
            "CUT_IR_IDENTITY",
            path,
            "an authority-backed TranscriptPicture must have exactly one PictureTrack owner.",
          );
        }
        const owner = trackOwners[0]!;
        if (owner.track.editorial?.kind !== "picture-track"
          || owner.track.editorial.operationPlan !== undefined
          || owner.track.editorial.transitions !== undefined) {
          fail(
            "CUT_IR_IDENTITY",
            `${childPath("$.nodes", owner.track.id)}.editorial`,
            "direct authority-backed TranscriptPicture cannot claim an unvalidated operation plan or transition.",
          );
        }
        const timelineSegment = timelineEditSegment(
          owner.track,
          owner.item,
          "picture",
          owner.itemPath,
        );
        const timeMap = authorityTimeMap(
          node.inputs,
          owner.item.timeMap,
          `${path}.inputs`,
        );
        if (compareRational(
          multiplyRational(duration, timeMap.rate),
          sourceRange.duration,
        ) !== 0) {
          fail(
            "CUT_IR_TIMING",
            `${path}.inputs.duration`,
            "source duration must exactly equal destination duration multiplied by rate.",
          );
        }
        const directDestination = {
          start: binding.destinationRange.start,
          duration,
        };
        const basePicture = timelineSegment?.base.sourceView.kind === "picture"
          ? timelineSegment.base.sourceView
          : undefined;
        const resultPicture = timelineSegment?.result.sourceView.kind === "picture"
          ? timelineSegment.result.sourceView
          : undefined;
        if (timelineSegment
          && (!basePicture
            || !resultPicture
            || !transcriptSameInterval(basePicture.source, fullSource)
            || !transcriptSameInterval(resultPicture.source, sourceRange)
            || !transcriptSameInterval(timelineSegment.result.destination, node.interval)
            || !transcriptSameInterval(owner.item.source!, sourceRange)
            || !transcriptSameInterval(owner.item.destination, node.interval)
            || stableJsonStringify(resultPicture.timeMap)
              !== stableJsonStringify(timeMap))) {
          fail(
            "CUT_IR_IDENTITY",
            owner.itemPath,
            "must be one exact canonical TimelineEdit slice of the authenticated transcript picture origin.",
          );
        }
        if (!timelineSegment && !transcriptSameInterval(sourceRange, fullSource)) {
          fail(
            "CUT_IR_IDENTITY",
            `${path}.inputs.range`,
            "must equal the smallest source-frame interval covering the authority-mapped transcript range.",
          );
        }
        const originDestination = timelineSegment
          ? timelineSegment.base.destination
          : directDestination;
        const originSource = basePicture?.source ?? fullSource;
        const originTimeMap = basePicture?.timeMap ?? timeMap;
        const origin = validateAuthorityOrigin(
          node.inputs,
          binding,
          authority,
          originSource,
          originDestination,
          originTimeMap,
          `${path}.inputs`,
        );
        validateAuthoritySegment(
          node.inputs,
          origin,
          sourceRange,
          node.interval,
          timeMap,
          `${path}.inputs`,
        );
        if (!timelineSegment
          && !transcriptSameInterval(node.interval, directDestination)) {
          fail(
            "CUT_IR_IDENTITY",
            `${path}.interval`,
            "must begin at the TranscriptEdit destination start with its exact authored duration.",
          );
        }
        const composition = ir.compositions.find(
          (candidate) => candidate.id === binding.compositionId,
        )!;
        const scene = ir.scenes[binding.sceneId]!;
        const absoluteStart = addRational(scene.start, node.interval.start);
        const absoluteEnd = addRational(absoluteStart, node.interval.duration);
        if (multiplyRational(absoluteStart, composition.fps).denominator !== "1"
          || multiplyRational(absoluteEnd, composition.fps).denominator !== "1") {
          fail(
            "CUT_IR_TIMING",
            `${path}.interval`,
            "destination boundaries must land exactly on the owning composition frame grid.",
          );
        }
        exactLink(node.inputs.link, `${path}.inputs.link`, binding.linkId);
        if (node.ownership !== "child"
          || owner.track.sceneId !== binding.sceneId
          || !owner.track.children.includes(node.id)
          || owner.item.kind !== "picture"
          || !owner.item.source
          || !transcriptSameInterval(owner.item.source, sourceRange)
          || !transcriptSameInterval(owner.item.destination, node.interval)
          || owner.item.linkId !== binding.linkId
          || owner.item.linkSegmentId !== undefined) {
          fail(
            "CUT_IR_IDENTITY",
            owner.itemPath,
            "must remain one direct, exact authority-backed PictureTrack item.",
          );
        }
        if (Object.keys(node.properties).length) {
          fail(
            "CUT_IR_UNKNOWN_FIELD",
            `${path}.properties`,
            "authority-backed TranscriptPicture does not admit post-lowering property automation.",
          );
        }
        if (node.editorial !== undefined) {
          fail(
            "CUT_IR_UNKNOWN_FIELD",
            `${path}.editorial`,
            "an authority-backed PictureClip cannot own nested editorial semantics.",
          );
        }
        continue;
      }
      if (node.inputs.transcriptMediaAuthorityId !== undefined
        || node.inputs.transcriptPictureOriginIdentity !== undefined
        || node.inputs.transcriptPictureSegmentIdentity !== undefined) {
        fail(
          "CUT_IR_REFERENCE",
          `${path}.inputs.transcriptMediaAuthorityId`,
          "legacy TranscriptPicture cannot claim authority-backed lineage.",
        );
      }
      const composition = ir.compositions.find(
        (candidate) => candidate.id === binding.compositionId,
      );
      if (!composition) {
        fail("CUT_IR_REFERENCE", `${path}.sceneId`, `cannot resolve transcript composition “${binding.compositionId}”.`);
      }
      const videoStreamIndex = binding.media.videoStreamIndex;
      const videoFrameRate = binding.media.videoFrameRate;
      const videoDuration = binding.media.videoDuration;
      if (videoStreamIndex === undefined
        || videoFrameRate === undefined
        || videoDuration === undefined) {
        fail("CUT_IR_MISSING_FIELD", `${path}.inputs.transcriptBindingId`, "TranscriptPicture requires authenticated videoStreamIndex, videoFrameRate, and videoDuration provenance.");
      }
      if (compareRational(videoFrameRate, composition.fps) !== 0) {
        fail("CUT_IR_TIMING", `${path}.inputs.transcriptBindingId`, `transcript video rate must exactly equal composition ${composition.fps.numerator}/${composition.fps.denominator} fps.`);
      }
      const source = node.inputs.source;
      if (source?.kind !== "resource-ref") {
        fail("CUT_IR_TYPE", `${path}.inputs.source`, "must be one direct VideoAsset resource reference.");
      }
      exactResource(source, `${path}.inputs.source`, source.id, "video");
      const videoResource = ir.resources[source.id]!;
      const audioResource = ir.resources[binding.audioResourceId]!;
      if (videoResource.proxy !== undefined && videoResource.state === "locked") {
        const metadata = isRecord(videoResource.metadata) ? videoResource.metadata : undefined;
        const lockedProxy = metadata && isRecord(metadata.proxy) ? metadata.proxy : undefined;
        const alignment = lockedProxy && isRecord(lockedProxy.videoAlignment) ? lockedProxy.videoAlignment : undefined;
        if (alignment?.format !== "cut-video-proxy-alignment"
          || alignment.version !== 1
          || alignment.method !== "cut-frame-rgb-mae-v1"
          || alignment.decision !== "equivalent") {
          fail(
            "CUT_TRANSCRIPT_PICTURE_PROXY",
            `${childPath("$.resources", videoResource.id)}.metadata.proxy.videoAlignment`,
            "Locked TranscriptPicture proxy requires authenticated decoded-frame correspondence.",
          );
        }
      }
      if (videoResource.locator !== audioResource.locator) {
        fail("CUT_IR_IDENTITY", `${path}.inputs.source.id`, "must use the exact same media locator as the transcript AudioAsset.");
      }
      if (videoResource.streamSelection?.video !== videoStreamIndex) {
        fail("CUT_IR_REFERENCE", `${path}.inputs.source.id`, `must explicitly select authenticated video stream ${videoStreamIndex}.`);
      }
      if ((videoResource.sha256 === undefined) !== (audioResource.sha256 === undefined)
        || (videoResource.sha256 !== undefined
          && (videoResource.sha256 !== audioResource.sha256
            || videoResource.sha256 !== binding.media.sha256))) {
        fail("CUT_IR_HASH", `${path}.inputs.source.id`, "locked TranscriptPicture and TranscriptEdit resources must authenticate the same media bytes.");
      }
      let pictureRange;
      try {
        const videoSourceRange = cutTranscriptPictureVideoSourceRange(
          binding.sourceRange,
          binding.media.audioVideoPresentationDelta ?? zeroRational,
          videoDuration,
        );
        pictureRange = cutTranscriptPictureCoverRange(
          videoSourceRange,
          videoFrameRate,
          videoDuration,
        );
      } catch (error) {
        if (!(error instanceof CutTranscriptPictureSnapError)) throw error;
        fail("CUT_IR_TIMING", `${path}.inputs.transcriptBindingId`, error.message);
      }
      const sourceRange = transcriptConsumerRange(
        node.inputs.range,
        `${path}.inputs.range`,
        "transcript picture source range",
      );
      if (!transcriptSameInterval(sourceRange, pictureRange)) {
        fail("CUT_IR_IDENTITY", `${path}.inputs.range`, "must equal the smallest source-frame interval covering the transcript sourceRange.");
      }
      const duration = transcriptConsumerTime(
        node.inputs.duration,
        `${path}.inputs.duration`,
        "transcript picture duration",
      );
      if (compareRational(duration, pictureRange.duration) !== 0) {
        fail("CUT_IR_IDENTITY", `${path}.inputs.duration`, "must equal the covering source-frame duration.");
      }
      const expectedInterval = {
        start: binding.destinationRange.start,
        duration: pictureRange.duration,
      };
      if (!transcriptSameInterval(node.interval, expectedInterval)) {
        fail("CUT_IR_IDENTITY", `${path}.interval`, "must begin at the TranscriptEdit destination start and retain the covering source-frame duration.");
      }
      const absoluteDestinationStart = addRational(
        ir.scenes[binding.sceneId]!.start,
        binding.destinationRange.start,
      );
      if (multiplyRational(absoluteDestinationStart, composition.fps).denominator !== "1") {
        fail("CUT_IR_TIMING", `${path}.interval.start`, "must land on the owning composition picture-frame grid.");
      }
      exactLink(node.inputs.link, `${path}.inputs.link`, binding.linkId);
      const expectedIdentity = cutTranscriptPictureIdentity({
        transcriptBindingId: binding.id,
        audioResourceId: binding.audioResourceId,
        pictureResourceId: source.id,
        mediaSha256: binding.media.sha256,
        videoStreamIndex,
        videoFrameRate,
        videoDuration,
        ...(binding.media.audioVideoPresentationDelta === undefined
          ? {}
          : {
            audioVideoPresentationDelta:
              binding.media.audioVideoPresentationDelta,
          }),
        sourceRange: binding.sourceRange,
        destinationStart: binding.destinationRange.start,
        pictureRange,
        ...(binding.linkId === undefined ? {} : { linkId: binding.linkId }),
      });
      const actualIdentity = transcriptConsumerString(
        node.inputs.transcriptPictureIdentity,
        `${path}.inputs.transcriptPictureIdentity`,
        "transcript picture identity",
      );
      if (actualIdentity !== expectedIdentity) {
        fail("CUT_IR_HASH", `${path}.inputs.transcriptPictureIdentity.value`, `does not match transcript picture semantics (${expectedIdentity}).`);
      }
      if (Object.keys(node.properties).length) {
        fail("CUT_IR_UNKNOWN_FIELD", `${path}.properties`, "TranscriptPicture v1 does not admit post-lowering property automation.");
      }
      if (node.editorial !== undefined) {
        fail("CUT_IR_UNKNOWN_FIELD", `${path}.editorial`, "a transcript-bound PictureClip cannot own nested editorial semantics.");
      }
      const trackOwners: Array<{
        track: IRNode;
        item: Extract<IREditorial, { kind: "picture-track" }>["items"][number];
        itemPath: string;
      }> = [];
      for (const [trackId, track] of Object.entries(ir.nodes)) {
        if (track.editorial?.kind !== "picture-track") continue;
        track.editorial.items.forEach((item, index) => {
          if (item.nodeId === node.id) trackOwners.push({
            track,
            item,
            itemPath: `${childPath("$.nodes", trackId)}.editorial.items[${index}]`,
          });
        });
      }
      if (trackOwners.length !== 1) {
        fail("CUT_IR_IDENTITY", path, "a transcript-bound PictureClip must be exactly one direct PictureTrack editorial item.");
      }
      const owner = trackOwners[0]!;
      if (node.ownership !== "child"
        || owner.track.sceneId !== binding.sceneId
        || !owner.track.children.includes(node.id)) {
        fail("CUT_IR_IDENTITY", path, "a transcript-bound PictureClip must be one child of its same-scene PictureTrack owner.");
      }
      if (owner.track.editorial?.kind !== "picture-track"
        || owner.track.editorial.operationPlan !== undefined
        || owner.track.editorial.transitions !== undefined) {
        fail("CUT_IR_IDENTITY", `${childPath("$.nodes", owner.track.id)}.editorial`, "TranscriptPicture requires one direct PictureTrack without structural edit materialization or transitions.");
      }
      if (owner.item.kind !== "picture"
        || owner.item.timeMap !== undefined
        || owner.item.linkSegmentId !== undefined) {
        fail("CUT_IR_IDENTITY", owner.itemPath, "must remain one direct, forward-1x, unsegmented transcript picture item.");
      }
      if (!owner.item.source
        || !transcriptSameInterval(owner.item.source, pictureRange)) {
        fail("CUT_IR_IDENTITY", `${owner.itemPath}.source`, "must exactly equal the covering transcript picture range.");
      }
      if (!transcriptSameInterval(owner.item.destination, expectedInterval)) {
        fail("CUT_IR_IDENTITY", `${owner.itemPath}.destination`, "must exactly equal the transcript picture destination interval.");
      }
      if (owner.item.linkId !== binding.linkId) {
        fail("CUT_IR_IDENTITY", `${owner.itemPath}.linkId`, "must exactly equal the transcript binding optional linkId.");
      }
    }

    if (node.op === transcriptCaptionConsumerOp) {
      const binding = resolveBinding(node, path);
      rejectUnsupportedInputs(node, path, captionAllowed);
      if (node.inputs.font === undefined) {
        fail("CUT_IR_MISSING_FIELD", `${path}.inputs.font`, "is required for transcript captions.");
      }
      if (node.inputs.font.kind !== "resource-ref") {
        fail("CUT_IR_TYPE", `${path}.inputs.font`, "must be a direct FontAsset resource reference.");
      }
      exactResource(node.inputs.font, `${path}.inputs.font`, node.inputs.font.id, "font");
      if (node.inputs.maxWords !== undefined) {
        transcriptConsumerIntegerScalar(
          node.inputs.maxWords,
          `${path}.inputs.maxWords`,
          "transcript caption maxWords",
          cutTranscriptExecutableLimits.minimumCaptionMaxWords,
          cutTranscriptExecutableLimits.maximumCaptionMaxWords,
        );
      }
      const identityPath = `${path}.inputs.transcriptCaptionIdentity`;
      const actualIdentity = transcriptConsumerString(
        node.inputs.transcriptCaptionIdentity,
        identityPath,
        "transcript caption identity",
      );
      let expectedIdentity: string;
      try {
        expectedIdentity = cutTranscriptCaptionIdentity(ir, binding);
      } catch (error) {
        if (!(error instanceof CutTranscriptTimelineCaptionError)) throw error;
        fail("CUT_IR_IDENTITY", identityPath, error.message);
      }
      if (actualIdentity !== expectedIdentity) {
        fail("CUT_IR_HASH", `${identityPath}.value`, `does not match transcript caption content (${expectedIdentity}).`);
      }
      const nodeEnd = addRational(node.interval.start, node.interval.duration);
      const bindingEnd = addRational(binding.destinationRange.start, binding.destinationRange.duration);
      if (compareRational(node.interval.start, binding.destinationRange.start) > 0
        || compareRational(nodeEnd, bindingEnd) < 0) {
        fail("CUT_IR_TIMING", `${path}.interval`, "must contain the complete transcript binding destinationRange.");
      }
      if (node.editorial !== undefined) {
        fail("CUT_IR_UNKNOWN_FIELD", `${path}.editorial`, "transcript captions cannot own editorial track semantics.");
      }
    }
  }
}

const semanticMatchIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function semanticMatchAuthoredIdValue(value: unknown, path: string, context: ValidationContext) {
  const id = stringValue(value, path, context);
  if (!semanticMatchIdPattern.test(id)) fail("CUT_MATCH_ID", path, "must begin with a letter and contain only 1-128 letters, digits, dot, underscore, or hyphen characters.");
  return id;
}

function semanticMatchBasisValue(value: unknown, path: string, context: ValidationContext) {
  const basis = closed(value, path, ["width", "height", "origin"]);
  const width = safeInteger(basis.width, `${path}.width`, 1), height = safeInteger(basis.height, `${path}.height`, 1);
  if (width > 16_384 || height > 16_384) fail("CUT_MATCH_BASIS", path, "width and height must be whole pixels from 1 through 16384.");
  const origin = closed(basis.origin, `${path}.origin`, ["x", "y"]);
  const x = rationalValue(origin.x, `${path}.origin.x`, context), y = rationalValue(origin.y, `${path}.origin.y`, context);
  if (compareRational(x, zeroRational) < 0 || compareRational(x, rational(width)) > 0 || compareRational(y, zeroRational) < 0 || compareRational(y, rational(height)) > 0) {
    fail("CUT_MATCH_BASIS", `${path}.origin`, "must lie inside the declared closed LocalSpace width and height ranges.");
  }
}

function semanticMatchSubjectValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "version", "kind", "compositionId", "sceneId", "authoredId", "cameraNodeId", "localSpaceNodeId", "basis", "provenance"]);
  idValue(object.id, `${path}.id`, context);
  if (safeInteger(object.version, `${path}.version`, 1) !== 1) fail("CUT_IR_ENUM", `${path}.version`, "must be semantic-match subject version 1.");
  if (object.kind !== "semantic-match-subject") fail("CUT_IR_ENUM", `${path}.kind`, "must be semantic-match-subject.");
  idValue(object.compositionId, `${path}.compositionId`, context);
  idValue(object.sceneId, `${path}.sceneId`, context);
  semanticMatchAuthoredIdValue(object.authoredId, `${path}.authoredId`, context);
  idValue(object.cameraNodeId, `${path}.cameraNodeId`, context);
  idValue(object.localSpaceNodeId, `${path}.localSpaceNodeId`, context);
  semanticMatchBasisValue(object.basis, `${path}.basis`, context);
  provenance(object.provenance, `${path}.provenance`, context);
}

function semanticMatchSideValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["sceneId", "subjectId", "cameraNodeId", "localSpaceNodeId"]);
  idValue(object.sceneId, `${path}.sceneId`, context);
  idValue(object.subjectId, `${path}.subjectId`, context);
  idValue(object.cameraNodeId, `${path}.cameraNodeId`, context);
  idValue(object.localSpaceNodeId, `${path}.localSpaceNodeId`, context);
}

function semanticMatchTransitionValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["id", "version", "kind", "compositionId", "authoredId", "cut", "duration", "outgoingWindow", "incomingWindow", "outgoing", "incoming", "target", "easing", "provenance"], ["velocity"]);
  idValue(object.id, `${path}.id`, context);
  if (safeInteger(object.version, `${path}.version`, 1) !== 1) fail("CUT_IR_ENUM", `${path}.version`, "must be semantic-match transition version 1.");
  if (object.kind !== "semantic-match-transition") fail("CUT_IR_ENUM", `${path}.kind`, "must be semantic-match-transition.");
  idValue(object.compositionId, `${path}.compositionId`, context);
  semanticMatchAuthoredIdValue(object.authoredId, `${path}.authoredId`, context);
  const cut = rationalValue(object.cut, `${path}.cut`, context), duration = rationalValue(object.duration, `${path}.duration`, context);
  if (compareRational(cut, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) fail("CUT_MATCH_CUT", path, "cut must be non-negative and duration must be positive.");
  editorialIntervalValue(object.outgoingWindow, `${path}.outgoingWindow`, context);
  editorialIntervalValue(object.incomingWindow, `${path}.incomingWindow`, context);
  semanticMatchSideValue(object.outgoing, `${path}.outgoing`, context);
  semanticMatchSideValue(object.incoming, `${path}.incoming`, context);
  const target = closed(object.target, `${path}.target`, ["x", "y", "scale", "rotation"], ["color"]);
  rationalValue(target.x, `${path}.target.x`, context);
  rationalValue(target.y, `${path}.target.y`, context);
  const scale = rationalValue(target.scale, `${path}.target.scale`, context);
  rationalValue(target.rotation, `${path}.target.rotation`, context);
  if (compareRational(scale, zeroRational) <= 0 || compareRational(scale, rational(64)) > 0) fail("CUT_MATCH_TRANSFORM", `${path}.target.scale`, "must be greater than zero and no larger than 64.");
  if (target.color !== undefined) {
    const color = stringValue(target.color, `${path}.target.color`, context);
    if (!/^#[0-9a-f]{6}$/.test(color)) fail("CUT_MATCH_TRANSFORM", `${path}.target.color`, "must be one canonical lowercase opaque six-digit color.");
  }
  const easing = enumValue(object.easing, `${path}.easing`, new Set(["linear", "inCubic", "outCubic", "inOutCubic"]));
  if (object.velocity !== undefined) {
    enumValue(object.velocity, `${path}.velocity`, new Set(["settle", "carry"]));
    if (easing !== "inOutCubic") fail("CUT_MATCH_EASING", `${path}.easing`, "settle and carry velocity modes require inOutCubic easing in semantic-match v1.");
  }
  provenance(object.provenance, `${path}.provenance`, context);
}

function semanticMatchesValue(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["version", "subjects", "transitions"]);
  if (safeInteger(object.version, `${path}.version`, 1) !== 1) fail("CUT_IR_ENUM", `${path}.version`, "must be semantic-match section version 1.");
  const subjects = arrayValue(object.subjects, `${path}.subjects`, context, context.limits.maxSemanticMatchSubjects);
  const transitions = arrayValue(object.transitions, `${path}.transitions`, context, context.limits.maxSemanticMatchTransitions);
  if (!subjects.length || !transitions.length) fail("CUT_IR_IDENTITY", path, "semanticMatches requires at least one subject and transition; an unused or empty section must be omitted.");
  subjects.forEach((subject, index) => semanticMatchSubjectValue(subject, `${path}.subjects[${index}]`, context));
  transitions.forEach((transition, index) => semanticMatchTransitionValue(transition, `${path}.transitions[${index}]`, context));
  validateUniqueEntityIds(subjects as Array<{ id: string }>, `${path}.subjects`);
  validateUniqueEntityIds(transitions as Array<{ id: string }>, `${path}.transitions`);
}

function semanticMatchCompilerId(prefix: "semantic_match_subject" | "semantic_match_transition", value: unknown) {
  return `${prefix}_${hash(value).slice(0, 16)}`;
}

function semanticMatchBasisFromLocalSpace(node: IRNode, path: string) {
  const length = (field: "width" | "height") => {
    const value = node.inputs[field];
    if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px" || value.magnitude.denominator !== "1") fail("CUT_MATCH_BASIS", `${path}.inputs.${field}`, "must be a canonical whole-pixel LocalSpace length.");
    const number = Number(value.magnitude.numerator);
    if (!Number.isSafeInteger(number) || number < 1 || number > 16_384) fail("CUT_MATCH_BASIS", `${path}.inputs.${field}`, "must be from 1 through 16384px.");
    return number;
  };
  const origin = node.inputs.origin;
  if (origin?.kind !== "object" || Object.keys(origin.entries).length !== 2) fail("CUT_MATCH_BASIS", `${path}.inputs.origin`, "must contain exactly x and y.");
  const coordinate = (axis: "x" | "y") => {
    const value = origin.entries[axis];
    if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") fail("CUT_MATCH_BASIS", `${path}.inputs.origin.${axis}`, "must be a canonical pixel Length.");
    return value.magnitude;
  };
  return { width: length("width"), height: length("height"), origin: { x: coordinate("x"), y: coordinate("y") } };
}

function validateSemanticMatchContracts(ir: CutAVIR) {
  const matches = ir.semanticMatches;
  if (!matches) return;
  const compositions = new Map(ir.compositions.map((composition) => [composition.id, composition]));
  const sceneOwners = new Map<string, string>();
  for (const composition of ir.compositions) for (const sceneId of composition.sceneIds) sceneOwners.set(sceneId, composition.id);
  const subjectById = new Map(matches.subjects.map((subject) => [subject.id, subject]));
  const subjectScopes = new Set<string>();
  const subjectsPerComposition = new Map<string, number>();
  for (const [index, subject] of matches.subjects.entries()) {
    const path = `$.semanticMatches.subjects[${index}]`, composition = compositions.get(subject.compositionId), scene = ir.scenes[subject.sceneId];
    if (!composition) fail("CUT_MATCH_SCOPE", `${path}.compositionId`, `references missing composition “${subject.compositionId}”.`);
    if (!scene || sceneOwners.get(subject.sceneId) !== composition.id) fail("CUT_MATCH_SCOPE", `${path}.sceneId`, "must reference a scene owned by the declared composition.");
    const scope = `${subject.compositionId}\0${subject.authoredId}`;
    if (subjectScopes.has(scope)) fail("CUT_MATCH_ID", `${path}.authoredId`, "duplicates another MatchSubject authored id in this composition.");
    subjectScopes.add(scope);
    const subjectCount = (subjectsPerComposition.get(subject.compositionId) ?? 0) + 1;
    subjectsPerComposition.set(subject.compositionId, subjectCount);
    if (subjectCount > 256) fail("CUT_MATCH_LIMIT", path, "a composition may contain at most 256 semantic-match subjects.");
    const expectedId = semanticMatchCompilerId("semantic_match_subject", { compositionId: subject.compositionId, sceneId: subject.sceneId, authoredId: subject.authoredId });
    if (subject.id !== expectedId) fail("CUT_MATCH_CONTRACT", `${path}.id`, `must equal compiler-owned identity “${expectedId}”.`);
    const camera = ir.nodes[subject.cameraNodeId], localSpace = ir.nodes[subject.localSpaceNodeId];
    if (!camera || camera.op !== "cut.visual.camera2d" || camera.domain !== "visual") fail("CUT_MATCH_CAMERA", `${path}.cameraNodeId`, "must reference one visual Camera2D.");
    if (camera.sceneId !== scene.id || camera.ownership !== "root" || !scene.items.some((item) => item.id === camera.id)) fail("CUT_MATCH_CAMERA", `${path}.cameraNodeId`, "must reference a direct root of the declared scene.");
    if (compareRational(camera.interval.start, zeroRational) !== 0 || compareRational(camera.interval.duration, scene.duration) !== 0) fail("CUT_MATCH_SUBJECT", `${path}.cameraNodeId`, "Camera2D must span the complete scene exactly.");
    if (camera.children.length !== 1 || camera.children[0] !== subject.localSpaceNodeId) fail("CUT_MATCH_CAMERA", `${path}.localSpaceNodeId`, "must be the Camera2D's sole direct child.");
    if (!localSpace || localSpace.op !== "cut.visual.local_space" || localSpace.ownership !== "child" || localSpace.sceneId !== scene.id) fail("CUT_MATCH_CAMERA", `${path}.localSpaceNodeId`, "must reference the Camera2D's direct LocalSpace child.");
    if (compareRational(localSpace.interval.start, zeroRational) !== 0 || compareRational(localSpace.interval.duration, scene.duration) !== 0) fail("CUT_MATCH_SUBJECT", `${path}.localSpaceNodeId`, "LocalSpace must span the complete scene exactly.");
    const basis = semanticMatchBasisFromLocalSpace(localSpace, childPath("$.nodes", localSpace.id));
    if (basis.width !== subject.basis.width || basis.height !== subject.basis.height
      || compareRational(basis.origin.x, subject.basis.origin.x) !== 0 || compareRational(basis.origin.y, subject.basis.origin.y) !== 0) {
      fail("CUT_MATCH_BASIS", `${path}.basis`, "must exactly copy the declared LocalSpace width, height, and origin.");
    }
  }
  const transitionScopes = new Set<string>(), usedSubjects = new Set<string>();
  const activeWindows = new Map<string, IREditorialInterval[]>();
  const transitionsPerComposition = new Map<string, number>();
  for (const [index, transition] of matches.transitions.entries()) {
    const path = `$.semanticMatches.transitions[${index}]`, composition = compositions.get(transition.compositionId);
    if (!composition) fail("CUT_MATCH_SCOPE", `${path}.compositionId`, `references missing composition “${transition.compositionId}”.`);
    const scope = `${transition.compositionId}\0${transition.authoredId}`;
    if (transitionScopes.has(scope)) fail("CUT_MATCH_ID", `${path}.authoredId`, "duplicates another MatchTransition authored id in this composition.");
    transitionScopes.add(scope);
    const transitionCount = (transitionsPerComposition.get(transition.compositionId) ?? 0) + 1;
    transitionsPerComposition.set(transition.compositionId, transitionCount);
    if (transitionCount > 128) fail("CUT_MATCH_LIMIT", path, "a composition may contain at most 128 semantic-match transitions.");
    const expectedId = semanticMatchCompilerId("semantic_match_transition", { compositionId: transition.compositionId, authoredId: transition.authoredId });
    if (transition.id !== expectedId) fail("CUT_MATCH_CONTRACT", `${path}.id`, `must equal compiler-owned identity “${expectedId}”.`);
    const outgoing = subjectById.get(transition.outgoing.subjectId), incoming = subjectById.get(transition.incoming.subjectId);
    if (!outgoing || !incoming || outgoing === incoming) fail("CUT_MATCH_SUBJECT", path, "must reference two distinct declared semantic-match subjects.");
    if (outgoing.compositionId !== composition.id || incoming.compositionId !== composition.id) fail("CUT_MATCH_SCOPE", path, "both subjects must belong to the transition composition.");
    const sideMatches = (side: typeof transition.outgoing, subject: typeof outgoing) => side.sceneId === subject.sceneId && side.cameraNodeId === subject.cameraNodeId && side.localSpaceNodeId === subject.localSpaceNodeId;
    if (!sideMatches(transition.outgoing, outgoing)) fail("CUT_MATCH_CONTRACT", `${path}.outgoing`, "must exactly copy the referenced outgoing subject node and scene identities.");
    if (!sideMatches(transition.incoming, incoming)) fail("CUT_MATCH_CONTRACT", `${path}.incoming`, "must exactly copy the referenced incoming subject node and scene identities.");
    const outgoingScene = ir.scenes[outgoing.sceneId]!, incomingScene = ir.scenes[incoming.sceneId]!;
    const outgoingIndex = composition.sceneIds.indexOf(outgoingScene.id), incomingIndex = composition.sceneIds.indexOf(incomingScene.id);
    if (outgoingIndex < 0 || incomingIndex !== outgoingIndex + 1
      || compareRational(addRational(outgoingScene.start, outgoingScene.duration), transition.cut) !== 0
      || compareRational(incomingScene.start, transition.cut) !== 0) {
      fail("CUT_MATCH_CUT", path, "subjects must belong to source-adjacent scenes meeting at the exact declared cut.");
    }
    const frames = multiplyRational(transition.duration, composition.fps), cutFrame = multiplyRational(transition.cut, composition.fps);
    if (cutFrame.denominator !== "1") fail("CUT_MATCH_CUT", `${path}.cut`, "must land exactly on the composition frame grid.");
    if (frames.denominator !== "1" || BigInt(frames.numerator) < 4n || BigInt(frames.numerator) > 600n || BigInt(frames.numerator) % 2n !== 0n) fail("CUT_MATCH_CUT", `${path}.duration`, "must be an even count of 4 through 600 composition frames.");
    const canonicalHalf = rational(BigInt(transition.duration.numerator), BigInt(transition.duration.denominator) * 2n);
    const expectedOutgoing = { start: subtractRational(transition.cut, canonicalHalf), duration: canonicalHalf };
    const expectedIncoming = { start: transition.cut, duration: canonicalHalf };
    const sameInterval = (left: IREditorialInterval, right: IREditorialInterval) => compareRational(left.start, right.start) === 0 && compareRational(left.duration, right.duration) === 0;
    if (!sameInterval(transition.outgoingWindow, expectedOutgoing) || !sameInterval(transition.incomingWindow, expectedIncoming)) fail("CUT_MATCH_CONTRACT", path, "centered half-open windows must be exactly derived from cut and duration.");
    if (compareRational(expectedOutgoing.start, outgoingScene.start) < 0 || compareRational(addRational(expectedIncoming.start, expectedIncoming.duration), addRational(incomingScene.start, incomingScene.duration)) > 0) fail("CUT_MATCH_CUT", path, "both centered half-windows must fit inside their owning scenes.");
    const transitionEnd = addRational(expectedIncoming.start, expectedIncoming.duration);
    for (const sceneId of composition.sceneIds) {
      if (sceneId === outgoingScene.id || sceneId === incomingScene.id) continue;
      const scene = ir.scenes[sceneId]!;
      if (compareRational(scene.start, transitionEnd) < 0 && compareRational(addRational(scene.start, scene.duration), expectedOutgoing.start) > 0) fail("CUT_MATCH_CUT", path, "active windows overlap a third scene.");
    }
    if (outgoing.basis.width !== incoming.basis.width || outgoing.basis.height !== incoming.basis.height
      || compareRational(outgoing.basis.origin.x, incoming.basis.origin.x) !== 0 || compareRational(outgoing.basis.origin.y, incoming.basis.origin.y) !== 0) fail("CUT_MATCH_BASIS", path, "outgoing and incoming retained bases must match exactly.");
    const cameraHasSignal = (subject: typeof outgoing, fields: readonly string[]) => fields.some((field) => {
      const value = ir.nodes[subject.cameraNodeId]?.properties[field];
      return value !== undefined && "signal" in value;
    });
    if (transition.velocity === "carry" && (cameraHasSignal(outgoing, ["x", "y"]) || cameraHasSignal(incoming, ["x", "y"]))) fail("CUT_MATCH_VELOCITY", `${path}.velocity`, "carry requires static Camera2D x/y throughout both active half-windows.");
    const staticPose = (subject: typeof outgoing) => {
      const camera = ir.nodes[subject.cameraNodeId]!;
      if (cameraHasSignal(subject, ["x", "y", "scale", "rotation"])) return undefined;
      const exact = (field: "x" | "y" | "scale" | "rotation", dimension: string, fallback: Rational) => {
        const value = camera.inputs[field];
        return value?.kind === "quantity" && value.dimension === dimension ? value.magnitude : fallback;
      };
      return { x: exact("x", "length", zeroRational), y: exact("y", "length", zeroRational), scale: exact("scale", "scalar", rational(1)), rotation: exact("rotation", "angle", zeroRational) };
    };
    const outgoingPose = staticPose(outgoing), incomingPose = staticPose(incoming);
    const samePose = (pose: NonNullable<typeof outgoingPose>) => compareRational(pose.x, transition.target.x) === 0
      && compareRational(pose.y, transition.target.y) === 0
      && compareRational(pose.scale, transition.target.scale) === 0
      && compareRational(pose.rotation, transition.target.rotation) === 0;
    if (transition.target.color === undefined && outgoingPose && incomingPose && samePose(outgoingPose) && samePose(incomingPose)) fail("CUT_MATCH_NOOP", path, "target equals both static native Camera2D poses and has no color convergence.");
    for (const [subject, window] of [[outgoing, expectedOutgoing], [incoming, expectedIncoming]] as const) {
      usedSubjects.add(subject.id);
      const windows = activeWindows.get(subject.id) ?? [], end = addRational(window.start, window.duration);
      if (windows.some((candidate) => compareRational(candidate.start, end) < 0 && compareRational(addRational(candidate.start, candidate.duration), window.start) > 0)) fail("CUT_MATCH_CONFLICT", path, `subject “${subject.authoredId}” is reused in overlapping active windows.`);
      windows.push(window); activeWindows.set(subject.id, windows);
    }
  }
  for (const [index, subject] of matches.subjects.entries()) if (!usedSubjects.has(subject.id)) fail("CUT_MATCH_SUBJECT", `$.semanticMatches.subjects[${index}]`, "is unused; MatchSubject declarations cannot be inert in v1.");
}

function validateMapEntities(value: unknown, path: string, context: ValidationContext, maximum: number, validate: (item: unknown, path: string) => void) {
  const entities = mapValue(value, path, context, maximum);
  for (const [key, item] of Object.entries(entities)) {
    const itemPath = childPath(path, key); idValue(key, itemPath, context); validate(item, itemPath);
    if (!isRecord(item) || item.id !== key) fail("CUT_IR_IDENTITY", `${itemPath}.id`, `must match record key “${key}”.`);
  }
  return entities;
}

function validateUniqueEntityIds(values: readonly { id: string }[], path: string) {
  const seen = new Set<string>();
  values.forEach((item, index) => { if (seen.has(item.id)) fail("CUT_IR_IDENTITY", `${path}[${index}].id`, `duplicates “${item.id}”.`); seen.add(item.id); });
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedDomainRoots(items: Array<{ id: string; domain: string }>, domain: "visual" | "audio" | "av") {
  return items.filter((item) => domain === "visual" ? item.domain === "visual" : domain === "audio" ? item.domain === "audio" : item.domain !== "visual" && item.domain !== "audio").map((item) => item.id);
}

function assertRootLists(owner: { rootVisualIds: string[]; rootAudioIds: string[]; rootAVIds: string[] }, items: Array<{ id: string; domain: string }>, path: string) {
  const expected = {
    rootVisualIds: expectedDomainRoots(items, "visual"),
    rootAudioIds: expectedDomainRoots(items, "audio"),
    rootAVIds: expectedDomainRoots(items, "av"),
  };
  for (const field of ["rootVisualIds", "rootAudioIds", "rootAVIds"] as const) {
    if (!arraysEqual(owner[field], expected[field])) fail("CUT_IR_IDENTITY", `${path}.${field}`, "does not match the ordered root items for its domains.");
  }
}

const geoAnnotationRequiredInputs = Object.freeze([
  "anchor",
  "placements",
  "offset",
  "safeArea",
  "leader",
] as const);

const geoAnnotationPlacements = new Set(["right", "above", "below", "left"]);
const geoAnnotationLeaders = new Set(["none", "straight", "elbow"]);

function geoAnnotationQuantity(
  value: IRValue | undefined,
  path: string,
  dimensions: readonly string[],
  minimum: Rational,
  maximum: Rational,
  whole = false,
) {
  if (value?.kind !== "quantity" || !dimensions.includes(value.dimension)) {
    fail("CUT_IR_TYPE", path, `must be a canonical ${dimensions.join(" or ")} quantity.`);
  }
  if (compareRational(value.magnitude, minimum) < 0 || compareRational(value.magnitude, maximum) > 0) {
    fail("CUT_IR_TYPE", path, `must be in the closed range ${minimum.numerator}/${minimum.denominator} through ${maximum.numerator}/${maximum.denominator}.`);
  }
  if (whole && value.magnitude.denominator !== "1") {
    fail("CUT_IR_TYPE", path, "must be a whole quantity.");
  }
  return value.magnitude;
}

/**
 * Close the public GeoAnnotation value contract at the hostile JSON boundary.
 * The runtime repeats these checks before planning, but the loader must never
 * bless a forged executable node whose public fields could be ignored.
 */
function validateGeoAnnotationStaticContract(node: IRNode, path: string) {
  for (const input of geoAnnotationRequiredInputs) {
    if (!Object.hasOwn(node.inputs, input)) {
      fail("CUT_IR_MISSING_FIELD", `${path}.inputs.${input}`, `is required by the closed cut.geo.annotation contract.`);
    }
  }

  const anchorPath = `${path}.inputs.anchor`, anchor = node.inputs.anchor;
  if (anchor?.kind !== "object") fail("CUT_IR_TYPE", anchorPath, "must be a GeoPoint object containing exactly latitude and longitude.");
  const anchorKeys = Object.keys(anchor.entries);
  if (anchorKeys.length !== 2 || !anchorKeys.includes("latitude") || !anchorKeys.includes("longitude")) {
    fail("CUT_IR_TYPE", anchorPath, "must contain exactly latitude and longitude; label and every other field are unsupported.");
  }
  geoAnnotationQuantity(anchor.entries.latitude, `${anchorPath}.entries.latitude`, ["scalar", "angle"], rational(-90), rational(90));
  geoAnnotationQuantity(anchor.entries.longitude, `${anchorPath}.entries.longitude`, ["scalar", "angle"], rational(-180), rational(180));

  const hasWidth = node.inputs.width !== undefined, hasHeight = node.inputs.height !== undefined;
  if (hasWidth !== hasHeight) {
    fail("CUT_IR_MISSING_FIELD", `${path}.inputs`, "GeoAnnotation width and height must either both be present for the legacy ordinary-child form or both be absent for a direct LocalSpace child.");
  }
  if (hasWidth) {
    geoAnnotationQuantity(node.inputs.width, `${path}.inputs.width`, ["length"], rational(1), rational(65_536), true);
    geoAnnotationQuantity(node.inputs.height, `${path}.inputs.height`, ["length"], rational(1), rational(65_536), true);
  }
  geoAnnotationQuantity(node.inputs.offset, `${path}.inputs.offset`, ["length"], rational(1), rational(65_536));
  const safeArea = geoAnnotationQuantity(node.inputs.safeArea, `${path}.inputs.safeArea`, ["length"], zeroRational, rational(65_536));
  if (compareRational(safeArea, zeroRational) === 0) fail("CUT_IR_TYPE", `${path}.inputs.safeArea`, "must be strictly positive.");

  const placementsPath = `${path}.inputs.placements`, placements = node.inputs.placements;
  if (placements?.kind !== "array") fail("CUT_IR_TYPE", placementsPath, "must be an array of placement strings.");
  if (placements.items.length < 1 || placements.items.length > 4) {
    fail("CUT_IR_LIMIT", placementsPath, "must contain one through four placement directions.");
  }
  const seenPlacements = new Set<string>();
  placements.items.forEach((placement, index) => {
    const placementPath = `${placementsPath}.items[${index}]`;
    if (placement.kind !== "string") fail("CUT_IR_TYPE", placementPath, "must be a static placement string.");
    if (!geoAnnotationPlacements.has(placement.value)) fail("CUT_IR_ENUM", `${placementPath}.value`, "must be right, above, below, or left.");
    if (seenPlacements.has(placement.value)) fail("CUT_IR_IDENTITY", `${placementPath}.value`, `duplicates unreachable fallback ${JSON.stringify(placement.value)}.`);
    seenPlacements.add(placement.value);
  });

  if (node.inputs.priority !== undefined) {
    const priority = geoAnnotationQuantity(node.inputs.priority, `${path}.inputs.priority`, ["scalar"], rational(-1_000_000), rational(1_000_000), true);
    if (compareRational(priority, zeroRational) === 0) fail("CUT_IR_IDENTITY", `${path}.inputs.priority`, "authored priority zero repeats omitted structural ordering.");
  }

  const leaderPath = `${path}.inputs.leader`, leader = node.inputs.leader;
  if (leader?.kind !== "string") fail("CUT_IR_TYPE", leaderPath, "must be a static leader string.");
  if (!geoAnnotationLeaders.has(leader.value)) fail("CUT_IR_ENUM", `${leaderPath}.value`, "must be none, straight, or elbow.");
  const hasLeaderColor = node.inputs.leaderColor !== undefined, hasLeaderWidth = node.inputs.leaderWidth !== undefined;
  if (leader.value === "none") {
    if (hasLeaderColor || hasLeaderWidth) fail("CUT_IR_IDENTITY", `${path}.inputs`, "leader none forbids inert leaderColor and leaderWidth inputs.");
  } else if (!hasLeaderColor || !hasLeaderWidth) {
    fail("CUT_IR_MISSING_FIELD", `${path}.inputs`, `leader ${leader.value} requires both leaderColor and leaderWidth.`);
  }
  if (hasLeaderColor) {
    const colorPath = `${path}.inputs.leaderColor`, color = node.inputs.leaderColor;
    if (color?.kind !== "color") fail("CUT_IR_TYPE", colorPath, "must be a canonical CUT color.");
    if (color.value.length === 9 && color.value.slice(-2).toLowerCase() === "00") {
      fail("CUT_IR_IDENTITY", colorPath, "cannot be fully transparent because the leader would be inert.");
    }
  }
  if (hasLeaderWidth) {
    const leaderWidth = geoAnnotationQuantity(node.inputs.leaderWidth, `${path}.inputs.leaderWidth`, ["length"], zeroRational, rational(65_536));
    if (compareRational(leaderWidth, zeroRational) === 0) fail("CUT_IR_TYPE", `${path}.inputs.leaderWidth`, "must be strictly positive.");
  }

  const validateOpacity = (value: IRValue | undefined, opacityPath: string) => {
    geoAnnotationQuantity(value, opacityPath, ["ratio"], zeroRational, rational(1));
  };
  let opacityInput: Rational | undefined;
  if (node.inputs.opacity !== undefined) {
    opacityInput = geoAnnotationQuantity(node.inputs.opacity, `${path}.inputs.opacity`, ["ratio"], zeroRational, rational(1));
  }
  const property = node.properties.opacity;
  if (property !== undefined && !("signal" in property)) validateOpacity(property, `${path}.properties.opacity`);
  if (opacityInput !== undefined && property === undefined
    && (compareRational(opacityInput, zeroRational) === 0 || compareRational(opacityInput, rational(1)) === 0)) {
    fail("CUT_IR_IDENTITY", `${path}.inputs.opacity`, "without an opacity property, 0% is permanently hidden and explicit 100% repeats the default; omit or animate it.");
  }
}

/**
 * RouteSubject intentionally accepts only unlabeled inline coordinates. The
 * public GeoPoint type remains label-capable for Marker, but hostile current
 * IR cannot smuggle label metadata or an oversized route through that broader
 * nominal type before the retained-camera planner runs.
 */
function validateRouteSubjectStaticContract(node: IRNode, path: string) {
  const pointsPath = `${path}.inputs.points`, points = node.inputs.points;
  if (points?.kind !== "array") {
    fail("CUT_IR_TYPE", pointsPath, "RouteSubject points must be an inline array of unlabeled GeoPoint objects.");
  }
  if (points.items.length < 2 || points.items.length > 4_096) {
    fail("CUT_IR_LIMIT", pointsPath, `RouteSubject points must contain 2 through 4096 entries; found ${points.items.length}.`);
  }
  points.items.forEach((point, index) => {
    const pointPath = `${pointsPath}.items[${index}]`;
    if (point.kind !== "object") {
      fail("CUT_IR_TYPE", pointPath, "must be one unlabeled GeoPoint object.");
    }
    const keys = Object.keys(point.entries);
    if (keys.length !== 2 || !keys.includes("latitude") || !keys.includes("longitude")) {
      const extra = keys.find((key) => key !== "latitude" && key !== "longitude");
      fail(
        extra === undefined ? "CUT_IR_TYPE" : "CUT_IR_UNKNOWN_FIELD",
        extra === undefined ? pointPath : diagnosticChildPath(`${pointPath}.entries`, extra),
        "RouteSubject coordinates must contain exactly latitude and longitude; label and every other field are unsupported.",
      );
    }
    geoAnnotationQuantity(point.entries.latitude, `${pointPath}.entries.latitude`, ["scalar"], rational(-90), rational(90));
    geoAnnotationQuantity(point.entries.longitude, `${pointPath}.entries.longitude`, ["scalar"], rational(-180), rational(180));
  });
}

const calloutRequiredInputs = Object.freeze([
  "anchor",
  "placements",
  "offset",
  "safeArea",
  "leader",
] as const);
const calloutPlacements = new Set(["right", "above", "below", "left"]);
const calloutLeaders = new Set(["none", "straight", "elbow"]);

function calloutQuantity(
  value: IRValue | undefined,
  path: string,
  dimension: "length" | "ratio" | "scalar",
  minimum: Rational,
  maximum: Rational,
  whole = false,
) {
  const unit = dimension === "length" ? "px" : dimension;
  if (value?.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail("CUT_CALLOUT_TYPE", path, `must be one canonical ${dimension} quantity in ${unit}.`);
  }
  if (compareRational(value.magnitude, minimum) < 0) {
    fail("CUT_CALLOUT_TYPE", path, `must be at least ${minimum.numerator}/${minimum.denominator}.`);
  }
  if (compareRational(value.magnitude, maximum) > 0) {
    fail("CUT_CALLOUT_LIMIT", path, `cannot exceed ${maximum.numerator}/${maximum.denominator}.`);
  }
  if (whole && value.magnitude.denominator !== "1") {
    fail("CUT_CALLOUT_TYPE", path, "must be an exact whole quantity.");
  }
  return value.magnitude;
}

function calloutSignalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [signal.value];
  if (signal.kind === "step") return signal.points.map((point) => point.value);
  if (signal.kind === "keyframes") return signal.keyframes.map((keyframe) => keyframe.value);
  return [
    signal.initial,
    ...signal.events.flatMap((event) => event.kind === "set" ? [event.value] : [event.from, event.to]),
  ];
}

/**
 * Close Callout's public persisted values before graph admission. This
 * deliberately repeats the runtime's value boundary: loaded executable IR
 * cannot rely on a renderer to reinterpret malformed or inert arguments.
 */
function validateCalloutStaticContract(ir: CutAVIR, node: IRNode, path: string) {
  for (const input of calloutRequiredInputs) {
    if (!Object.hasOwn(node.inputs, input)) {
      fail("CUT_CALLOUT_TYPE", `${path}.inputs.${input}`, `is required by the closed cut.visual.callout contract.`);
    }
  }

  calloutSpatialPoint(node.inputs.anchor, `${path}.inputs.anchor`);

  const placementsPath = `${path}.inputs.placements`, placements = node.inputs.placements;
  if (placements?.kind !== "array") fail("CUT_CALLOUT_TYPE", placementsPath, "must be a List<String>.");
  if (placements.items.length < 1 || placements.items.length > 4) {
    fail("CUT_CALLOUT_LIMIT", placementsPath, "must contain one through four placement directions.");
  }
  const seen = new Set<string>();
  placements.items.forEach((placement, index) => {
    const placementPath = `${placementsPath}.items[${index}]`;
    if (placement.kind !== "string" || !calloutPlacements.has(placement.value)) {
      fail("CUT_CALLOUT_TYPE", placementPath, "must be right, above, below, or left.");
    }
    if (seen.has(placement.value)) {
      fail("CUT_CALLOUT_NOOP", `${placementPath}.value`, `duplicates unreachable fallback ${JSON.stringify(placement.value)}.`);
    }
    seen.add(placement.value);
  });

  const offset = calloutQuantity(node.inputs.offset, `${path}.inputs.offset`, "length", zeroRational, rational(65_536));
  if (compareRational(offset, zeroRational) === 0) {
    fail("CUT_CALLOUT_TYPE", `${path}.inputs.offset`, "must be strictly positive.");
  }
  calloutQuantity(node.inputs.safeArea, `${path}.inputs.safeArea`, "length", zeroRational, rational(65_536));

  if (node.inputs.priority !== undefined) {
    const priority = calloutQuantity(
      node.inputs.priority,
      `${path}.inputs.priority`,
      "scalar",
      rational(-1_000_000),
      rational(1_000_000),
      true,
    );
    if (compareRational(priority, zeroRational) === 0) {
      fail("CUT_CALLOUT_NOOP", `${path}.inputs.priority`, "authored priority zero repeats omitted source ordering.");
    }
  }

  const leaderPath = `${path}.inputs.leader`, leader = node.inputs.leader;
  if (leader?.kind !== "string" || !calloutLeaders.has(leader.value)) {
    fail("CUT_CALLOUT_STYLE", leaderPath, "must be none, straight, or elbow.");
  }
  const hasLeaderColor = node.inputs.leaderColor !== undefined;
  const hasLeaderWidth = node.inputs.leaderWidth !== undefined;
  if (leader.value === "none") {
    if (hasLeaderColor || hasLeaderWidth) {
      fail("CUT_CALLOUT_NOOP", `${path}.inputs`, "leader none forbids inert leaderColor and leaderWidth inputs.");
    }
  } else if (!hasLeaderColor || !hasLeaderWidth) {
    fail("CUT_CALLOUT_STYLE", `${path}.inputs`, `leader ${leader.value} requires both leaderColor and leaderWidth.`);
  }
  if (hasLeaderColor) {
    const colorPath = `${path}.inputs.leaderColor`, color = node.inputs.leaderColor;
    if (color?.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color.value)) {
      fail("CUT_CALLOUT_STYLE", colorPath, "must be a canonical six- or eight-digit CUT color.");
    }
    if (color.value.length === 9 && color.value.slice(-2).toLowerCase() === "00") {
      fail("CUT_CALLOUT_NOOP", colorPath, "cannot be fully transparent because the leader would be inert.");
    }
  }
  if (hasLeaderWidth) {
    const width = calloutQuantity(node.inputs.leaderWidth, `${path}.inputs.leaderWidth`, "length", zeroRational, rational(65_536));
    if (compareRational(width, zeroRational) === 0) {
      fail("CUT_CALLOUT_TYPE", `${path}.inputs.leaderWidth`, "must be strictly positive.");
    }
  }

  let opacityInput: Rational | undefined;
  if (node.inputs.opacity !== undefined) {
    opacityInput = calloutQuantity(node.inputs.opacity, `${path}.inputs.opacity`, "ratio", zeroRational, rational(1));
  }
  const opacityBaseline = opacityInput ?? rational(1);
  const property = node.properties.opacity;
  if (property !== undefined) {
    const values = "signal" in property
      ? (() => {
        const signal = ir.signals[property.signal];
        if (!signal) fail("CUT_CALLOUT_TYPE", `${path}.properties.opacity.signal`, `references missing signal ${JSON.stringify(property.signal)}.`);
        if (signal.valueType !== "Ratio") {
          fail("CUT_CALLOUT_TYPE", `${childPath("$.signals", signal.id)}.valueType`, "Callout opacity signals must declare Ratio.");
        }
        return calloutSignalValues(signal);
      })()
      : [property];
    const effectiveValues = values.map((value, index) =>
      value.kind === "null"
        ? opacityBaseline
        : calloutQuantity(
          value,
          `${path}.properties.opacity.values[${index}]`,
          "ratio",
          zeroRational,
          rational(1),
        ));
    if (effectiveValues.length > 0
      && effectiveValues.every((value) => compareRational(value, zeroRational) === 0)) {
      fail(
        "CUT_CALLOUT_NOOP",
        `${path}.properties.opacity`,
        "is demonstrably 0% in every effective authored state and hides the Callout for its complete interval.",
      );
    }
    if (effectiveValues.length > 0
      && effectiveValues.every((value) => compareRational(value, rational(1)) === 0)) {
      fail(
        "CUT_CALLOUT_NOOP",
        `${path}.properties.opacity`,
        "is demonstrably 100% in every effective authored state and repeats the runtime default.",
      );
    }
  }
  if (opacityInput !== undefined && property === undefined
    && (compareRational(opacityInput, zeroRational) === 0 || compareRational(opacityInput, rational(1)) === 0)) {
    fail("CUT_CALLOUT_NOOP", `${path}.inputs.opacity`, "without an opacity property, 0% is permanently hidden and explicit 100% repeats the default; omit or animate it.");
  }
}

function sameExactInterval(left: IRNode["interval"], right: IRNode["interval"]) {
  return compareRational(left.start, right.start) === 0 && compareRational(left.duration, right.duration) === 0;
}

/**
 * Re-derive the only nested MediaCamera2D owner admitted for public
 * visualAnchor values. The compiler-owned responsive context is evidence, not
 * authority: every camera -> slot -> stack edge, interval, scope, and source
 * order is checked again against the loaded graph.
 */
function validateResponsiveSlotCameraAnchorOwner(
  ir: CutAVIR,
  owner: IRNode,
  consumer: IRNode,
  referencePath: string,
  directParents: ReadonlyMap<string, readonly IRNode[]>,
  code: "CUT_IR_IDENTITY" | "CUT_CALLOUT_ANCHOR",
) {
  const ownerParents = directParents.get(owner.id) ?? [];
  if (ownerParents.length === 0) return false;
  const slot = ownerParents.length === 1 && ownerParents[0]?.op === "cut.visual.responsive_slot"
    ? ownerParents[0]
    : undefined;
  const slotParents = slot ? directParents.get(slot.id) ?? [] : [];
  const stack = slotParents.length === 1 && slotParents[0]?.op === "cut.visual.responsive_stack"
    ? slotParents[0]
    : undefined;
  if (!slot || !stack) {
    fail(
      code,
      referencePath,
      "nested MediaCamera2D visualAnchor owner must be the sole direct child of one ResponsiveSlot under one ResponsiveStack.",
    );
  }
  const scene = owner.sceneId ? ir.scenes[owner.sceneId] : undefined;
  const slotIndex = stack.children.indexOf(slot.id);
  if (!scene
    || owner.domain !== "visual"
    || owner.ownership !== "child"
    || owner.sceneId !== consumer.sceneId
    || slot.domain !== "visual"
    || slot.ownership !== "child"
    || slot.sceneId !== owner.sceneId
    || slot.children.length !== 1
    || slot.children[0] !== owner.id
    || stack.domain !== "visual"
    || stack.sceneId !== owner.sceneId
    || slotIndex < 0
    || stack.children.filter((id) => id === slot.id).length !== 1) {
    fail(
      code,
      referencePath,
      "MediaCamera2D visualAnchor owner has a foreign, duplicated, or incomplete camera -> ResponsiveSlot -> ResponsiveStack chain.",
    );
  }
  if (!sameExactInterval(owner.interval, slot.interval)
    || !sameExactInterval(owner.interval, stack.interval)
    || compareRational(owner.interval.start, zeroRational) !== 0
    || compareRational(owner.interval.duration, scene.duration) !== 0) {
    fail(
      code,
      referencePath,
      "slot-bound MediaCamera2D visualAnchor owner, slot, and stack must share the complete scene interval exactly.",
    );
  }
  const contextPath = `${childPath("$.nodes", owner.id)}.inputs.responsiveSlotContext`;
  const context = owner.inputs.responsiveSlotContext;
  const plan = stack.inputs.plan;
  if (!context || !plan) {
    fail(
      code,
      context ? `${childPath("$.nodes", stack.id)}.inputs.plan` : contextPath,
      "slot-bound MediaCamera2D visualAnchor requires its compiler-owned responsive context and owning stack plan.",
    );
  }
  try {
    decodeCutResponsiveSlotMediaContext(
      context,
      plan,
      { stackNodeId: stack.id, slotNodeId: slot.id, index: slotIndex },
      contextPath,
    );
  } catch (error) {
    if (!(error instanceof CutResponsiveStackError)) throw error;
    const prefix = `${error.code}: `;
    fail(
      code,
      error.path,
      error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
    );
  }

  const stackParents = directParents.get(stack.id) ?? [];
  if (stackParents.length > 1) {
    fail(code, referencePath, "ResponsiveStack anchor scope has multiple structural owners.");
  }
  let boundary = consumer;
  if (stackParents.length === 1) {
    const scope = stackParents[0]!;
    const visited = new Set<string>();
    while (boundary.id !== scope.id) {
      if (visited.has(boundary.id)) fail(code, referencePath, "visualAnchor consumer scope contains a structural cycle.");
      visited.add(boundary.id);
      const parents = directParents.get(boundary.id) ?? [];
      if (parents.length !== 1) {
        fail(
          code,
          referencePath,
          "slot-camera alias cannot cross its immediate enclosing component or node scope.",
        );
      }
      if (parents[0]!.id === scope.id) break;
      boundary = parents[0]!;
    }
    if (boundary.id === scope.id || boundary.id === stack.id
      || scope.children.filter((id) => id === stack.id).length !== 1
      || scope.children.filter((id) => id === boundary.id).length !== 1
      || scope.children.indexOf(stack.id) >= scope.children.indexOf(boundary.id)) {
      fail(
        code,
        referencePath,
        "slot-bound MediaCamera2D owner must precede its visualAnchor consumer in the same immediate enclosing statement scope.",
      );
    }
  } else {
    const visited = new Set<string>();
    while ((directParents.get(boundary.id) ?? []).length) {
      if (visited.has(boundary.id)) fail(code, referencePath, "visualAnchor consumer scope contains a structural cycle.");
      visited.add(boundary.id);
      const parents = directParents.get(boundary.id) ?? [];
      if (parents.length !== 1) fail(code, referencePath, "visualAnchor consumer has ambiguous structural ownership.");
      boundary = parents[0]!;
    }
    const stackItems = scene.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.id === stack.id && item.domain === "visual");
    const boundaryItems = scene.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.id === boundary.id && item.domain === "visual");
    if (stack.ownership !== "root"
      || boundary.ownership !== "root"
      || scene.rootVisualIds.filter((id) => id === stack.id).length !== 1
      || scene.rootVisualIds.filter((id) => id === boundary.id).length !== 1
      || stackItems.length !== 1
      || boundaryItems.length !== 1
      || stackItems[0]!.index >= boundaryItems[0]!.index) {
      fail(
        code,
        referencePath,
        "slot-bound MediaCamera2D owner must be reached through an earlier ResponsiveStack root in the same scene order.",
      );
    }
  }
  if (owner.provenance.module !== consumer.provenance.module
    || owner.provenance.span.start.offset >= consumer.provenance.span.start.offset) {
    fail(
      code,
      referencePath,
      "slot-bound MediaCamera2D owner must be bound earlier than its visualAnchor consumer in the same source module.",
    );
  }
  return true;
}

const localSpaceLimits = Object.freeze({
  maximumAxisPx: 16_384,
  maximumSurfacePixels: 16_777_216,
  maximumSurfaceRgbaBytes: 67_108_864,
  maximumDirectChildren: 256,
  maximumNestedLocalSpaces: 16,
  maximumLocalSpacesPerExecutionDomain: 4_096,
  maximumLiveLocalSurfacePixelsPerFrame: 67_108_864,
  maximumRetainedMediaBranchesPerLocalSpace: 16,
  maximumRetainedMediaBranchesPerExecutionDomain: 64,
  maximumPreparedTracePointsPerExecutionDomain: 65_536,
  maximumLocalCompositingOperationsPerLocalSpace: 512,
  maximumLocalCompositingOperationsPerExecutionDomain: 4_096,
  maximumRetainedMediaLocalCompositorTreeNodes: 4_096,
});

function localSpaceExactPixelLength(value: IRValue | undefined, path: string) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail("CUT_IR_TYPE", path, "must be an exact pixel Length.");
  }
  return value.magnitude;
}

/** Close the public LocalSpace value contract before executable IR is trusted. */
function validateLocalSpaceStaticContract(node: IRNode, path: string) {
  for (const input of ["width", "height", "origin"] as const) {
    if (!Object.hasOwn(node.inputs, input)) {
      fail("CUT_IR_MISSING_FIELD", `${path}.inputs.${input}`, "is required by the closed cut.visual.local_space contract.");
    }
  }
  for (const input of Object.keys(node.inputs)) {
    if (input !== "width" && input !== "height" && input !== "origin") {
      fail("CUT_IR_UNKNOWN_FIELD", diagnosticChildPath(`${path}.inputs`, input), "is not part of the closed cut.visual.local_space contract.");
    }
  }
  if (Object.keys(node.properties).length > 0) {
    const property = Object.keys(node.properties)[0]!;
    fail("CUT_IR_UNKNOWN_FIELD", diagnosticChildPath(`${path}.properties`, property), "LocalSpace has no transform or effect properties; transform its owner or descendants.");
  }

  const dimensions = new Map<string, Rational>();
  for (const name of ["width", "height"] as const) {
    const magnitude = localSpaceExactPixelLength(node.inputs[name], `${path}.inputs.${name}`);
    if (magnitude.denominator !== "1"
      || compareRational(magnitude, rational(1)) < 0
      || compareRational(magnitude, rational(localSpaceLimits.maximumAxisPx)) > 0) {
      fail("CUT_IR_LIMIT", `${path}.inputs.${name}`, `must be a positive whole-pixel Length no larger than ${localSpaceLimits.maximumAxisPx}px.`);
    }
    dimensions.set(name, magnitude);
  }
  const pixels = multiplyRational(dimensions.get("width")!, dimensions.get("height")!);
  if (compareRational(pixels, rational(localSpaceLimits.maximumSurfacePixels)) > 0
    || compareRational(multiplyRational(pixels, rational(4)), rational(localSpaceLimits.maximumSurfaceRgbaBytes)) > 0) {
    fail("CUT_IR_LIMIT", `${path}.inputs`, "declared tile exceeds the bounded pixel or straight-RGBA byte envelope.");
  }

  const originPath = `${path}.inputs.origin`, origin = node.inputs.origin;
  if (origin?.kind !== "object") fail("CUT_IR_TYPE", originPath, "must be a Vec2 object containing exactly x and y pixel Length fields.");
  const originKeys = Object.keys(origin.entries);
  if (originKeys.length !== 2 || !originKeys.includes("x") || !originKeys.includes("y")) {
    fail("CUT_IR_TYPE", originPath, "must contain exactly x and y; additional fields are unsupported.");
  }
  for (const [axis, dimension] of [["x", "width"], ["y", "height"]] as const) {
    const magnitude = localSpaceExactPixelLength(origin.entries[axis], `${originPath}.entries.${axis}`);
    if (compareRational(magnitude, zeroRational) < 0 || compareRational(magnitude, dimensions.get(dimension)!) > 0) {
      fail("CUT_IR_LIMIT", `${originPath}.entries.${axis}`, `must lie in the closed 0px through ${dimension} range.`);
    }
  }
}

const localSpaceSupportedOwners = new Set([
  "cut.kernel.fragment",
  "cut.visual.group",
  "cut.visual.motion_path",
  "cut.visual.camera2d",
  "cut.visual.local_space",
  "cut.geo.annotation",
  "cut.visual.callout",
  "cut.visual.track_2d",
  "cut.visual.planar_track",
  "cut.visual.depth_layer",
  "cut.visual.plane3d",
]);
const localSpaceSupportedDescendants = new Set([
  "cut.kernel.fragment",
  "cut.visual.group",
  "cut.visual.motion_path",
  "cut.visual.local_space",
  "cut.visual.rect",
  "cut.visual.circle",
  "cut.visual.path",
  "cut.visual.trace",
  "cut.visual.text",
  "cut.visual.flow_text",
  "cut.visual.image",
  "cut.visual.video",
  "cut.visual.color_grade",
  "cut.visual.composite",
  "cut.visual.mask",
  "cut.visual.clip_path",
  "cut.visual.blur",
  "cut.visual.vignette",
  "cut.visual.sharpen",
  "cut.visual.grain",
  "cut.visual.duotone",
]);
const localSpaceCompositingOps = new Set([
  "cut.visual.composite",
  "cut.visual.mask",
  "cut.visual.clip_path",
  "cut.visual.blur",
  "cut.visual.vignette",
  "cut.visual.sharpen",
  "cut.visual.grain",
  "cut.visual.duotone",
  "cut.visual.color_grade",
]);

/** Structural mirror of the runtime's frozen V1 materialization-island
 * classifier. It deliberately does not validate purity or resources: the
 * strict loader below must still diagnose those rather than hiding them
 * behind candidate discovery. */
function localSpaceLegacyRetainedMediaIslandRoot(ir: CutAVIR, rootId: string) {
  let candidate = ir.nodes[rootId], groupDepth = 0, colorGrades = 0;
  const visited = new Set<string>();
  while (candidate) {
    if (visited.has(candidate.id)) return false;
    visited.add(candidate.id);
    if (candidate.op === "cut.visual.image" || candidate.op === "cut.visual.video") {
      return candidate.children.length === 0;
    }
    if ((candidate.op !== "cut.visual.group" && candidate.op !== "cut.visual.color_grade")
      || candidate.children.length !== 1) return false;
    if (candidate.op === "cut.visual.group" && ++groupDepth > 8) return false;
    if (candidate.op === "cut.visual.color_grade" && ++colorGrades > 1) return false;
    candidate = ir.nodes[candidate.children[0]!];
  }
  return false;
}

function localSpaceLegacyRetainedMediaUnaryCandidateRoot(ir: CutAVIR, rootId: string) {
  let candidate = ir.nodes[rootId];
  const visited = new Set<string>();
  while (candidate) {
    if (visited.has(candidate.id)) return false;
    visited.add(candidate.id);
    if (candidate.op === "cut.visual.image" || candidate.op === "cut.visual.video") return candidate.children.length === 0;
    if ((candidate.op !== "cut.visual.group" && candidate.op !== "cut.visual.color_grade")
      || candidate.children.length !== 1) return false;
    candidate = ir.nodes[candidate.children[0]!];
  }
  return false;
}

function intervalContains(parent: IRNode, child: IRNode) {
  return compareRational(child.interval.start, parent.interval.start) >= 0
    && compareRational(addRational(child.interval.start, child.interval.duration), addRational(parent.interval.start, parent.interval.duration)) <= 0;
}

/**
 * Close the checkpoint-1 local-coordinate graph. An unsupported descendant is
 * rejected here instead of silently materializing against the delivery canvas.
 */
function validateLocalSpaceGraphContracts(ir: CutAVIR, directParents: ReadonlyMap<string, readonly IRNode[]>) {
  const componentFragmentAdmissionIndex = createReferenceComponentFragmentLocalSpaceAdmissionIndex(ir);
  for (const owner of Object.values(ir.nodes).filter((node) => node.op === "cut.visual.planar_track")) {
    const path = childPath("$.nodes", owner.id);
    const child = owner.children.length === 1 ? ir.nodes[owner.children[0]!] : undefined;
    if (!child || child.op !== "cut.visual.local_space") {
      fail("CUT_PLANAR_TRACK_GRAPH", `${path}.children`, "PlanarTrack must own exactly one direct cut.visual.local_space child; delivery-canvas and affine fallback are forbidden.");
    }
    try {
      referencePlanarTrackMatteConfig(ir, owner);
    } catch (error) {
      if (!(error instanceof ReferencePlanarTrackMatteError)) throw error;
      fail(
        error.code,
        `${childPath("$.nodes", error.node.id)}.${error.pathSuffix}`,
        error.message,
      );
    }
  }
  const spaces = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.local_space");
  const rootMembership = new Map<string, number>();
  const rootExecutionDomain = new Map<string, string>();
  const markRoot = (id: string, executionDomain: string) => {
    rootMembership.set(id, (rootMembership.get(id) ?? 0) + 1);
    rootExecutionDomain.set(id, executionDomain);
  };
  for (const composition of ir.compositions) {
    for (const item of composition.items) if (item.kind === "node") markRoot(item.id, `composition-root:${composition.id}`);
  }
  for (const scene of Object.values(ir.scenes)) for (const item of scene.items) markRoot(item.id, `scene:${scene.id}`);
  const executionDomainFor = (node: IRNode) => {
    let current: IRNode | undefined = node;
    const seen = new Set<string>();
    while (current) {
      if (current.sceneId) return `scene:${current.sceneId}`;
      const rootDomain = rootExecutionDomain.get(current.id);
      if (rootDomain) return rootDomain;
      if (seen.has(current.id)) fail("CUT_IR_CYCLE", childPath("$.nodes", current.id), "LocalSpace execution-domain ancestor chain cycles.");
      seen.add(current.id);
      const structuralParents: readonly IRNode[] = directParents.get(current.id) ?? [];
      if (structuralParents.length > 1) fail("CUT_IR_IDENTITY", `${childPath("$.nodes", current.id)}.ownership`, "cannot derive one renderer execution domain through ambiguous structural parents.");
      current = structuralParents[0];
    }
    fail("CUT_IR_IDENTITY", `${childPath("$.nodes", node.id)}.ownership`, "cannot derive an exact scene or composition-root renderer execution domain.");
  };
  const livePixelsByExecutionDomain = new Map<string, number>();
  const localSpacesByExecutionDomain = new Map<string, number>();
  for (const node of spaces) {
    const width = localSpaceExactPixelLength(node.inputs.width, `${childPath("$.nodes", node.id)}.inputs.width`);
    const height = localSpaceExactPixelLength(node.inputs.height, `${childPath("$.nodes", node.id)}.inputs.height`);
    const executionDomain = executionDomainFor(node);
    const localSpaces = (localSpacesByExecutionDomain.get(executionDomain) ?? 0) + 1;
    localSpacesByExecutionDomain.set(executionDomain, localSpaces);
    if (localSpaces > localSpaceLimits.maximumLocalSpacesPerExecutionDomain) {
      fail("CUT_IR_LIMIT", childPath("$.nodes", node.id), `${executionDomain} LocalSpace count ${localSpaces} exceeds ${localSpaceLimits.maximumLocalSpacesPerExecutionDomain}; this is the closed per-frame evidence bound.`);
    }
    const livePixels = (livePixelsByExecutionDomain.get(executionDomain) ?? 0) + Number(width.numerator) * Number(height.numerator);
    livePixelsByExecutionDomain.set(executionDomain, livePixels);
    if (!Number.isSafeInteger(livePixels) || livePixels > localSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame) {
      fail("CUT_IR_LIMIT", childPath("$.nodes", node.id), `${executionDomain} aggregate declared LocalSpace tiles exceed ${localSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame} simultaneously live pixels.`);
    }
  }

  const retainedBranchesByExecutionDomain = new Map<string, number>();
  const preparedTracePointsByExecutionDomain = new Map<string, number>();
  const localCompositingOperationsByExecutionDomain = new Map<string, number>();
  for (const node of spaces) {
    const path = childPath("$.nodes", node.id), parents = directParents.get(node.id) ?? [];
    const executionDomain = executionDomainFor(node);
    if (parents.length > 1) fail("CUT_IR_IDENTITY", `${path}.ownership`, "LocalSpace must have at most one structural parent.");
    const directParent = parents[0];
    const roots = rootMembership.get(node.id) ?? 0;
    if (!directParent && node.ownership !== "root") {
      fail("CUT_IR_IDENTITY", `${path}.ownership`, "a parentless LocalSpace must be a scene/composition root; detached and reference-only coordinate contexts are forbidden.");
    }
    if (!directParent && roots !== 1) {
      fail("CUT_IR_IDENTITY", `${path}.ownership`, `a parentless root LocalSpace must appear in exactly one scene/composition item owner; found ${roots}.`);
    }
    if (directParent && node.ownership !== "child") {
      fail("CUT_IR_IDENTITY", `${path}.ownership`, "a structurally owned LocalSpace must have child ownership.");
    }
    if (directParent && roots !== 0) {
      fail("CUT_IR_IDENTITY", `${path}.ownership`, `a structurally owned LocalSpace cannot also appear as a scene/composition root; found ${roots} root memberships.`);
    }
    if (directParent && !intervalContains(directParent, node)) {
      fail("CUT_IR_TIMING", `${path}.interval`, `escapes direct owner ${directParent.id} interval.`);
    }
    if (directParent && !localSpaceSupportedOwners.has(directParent.op)) {
      fail("CUT_IR_UNKNOWN_FIELD", `${path}.ownership`, `owner ${directParent.op} has no local positioned-surface vertical slice; delivery-canvas fallback is forbidden.`);
    }
    if (directParent?.op === "cut.kernel.fragment") {
      const admission = referenceComponentFragmentLocalSpaceAdmissionIssue(componentFragmentAdmissionIndex, directParent, node);
      if (admission) {
        // Sibling rejection remains located at the LocalSpace in the public
        // runtime diagnostic, but strict JSON must point at the fragment's
        // malformed children array rather than an unrelated local child list.
        const target = admission.field === "children"
          ? directParent
          : admission.subject === "owner" ? directParent : node;
        const base = childPath("$.nodes", target.id);
        const issuePath = admission.key === undefined
          ? `${base}.${admission.field}`
          : diagnosticChildPath(`${base}.${admission.field}`, admission.key);
        fail(admission.loaderCode, issuePath, admission.detail);
      }
    }
    if (directParent?.op === "cut.visual.group" && directParent.children.length !== 1) {
      fail("CUT_IR_UNKNOWN_FIELD", `${childPath("$.nodes", directParent.id)}.children`, "a Group owning LocalSpace must be an exact unary placement chain in checkpoint 1.");
    }
    if (directParent?.op === "cut.visual.motion_path" && directParent.children.length !== 1) {
      fail("CUT_IR_UNKNOWN_FIELD", `${childPath("$.nodes", directParent.id)}.children`, "a MotionPath owning LocalSpace must be an exact unary placement chain; additional children would escape retained-tile execution.");
    }
    if (directParent?.op === "cut.visual.camera2d" && directParent.children.length !== 1) {
      fail("CUT_IR_IDENTITY", `${childPath("$.nodes", directParent.id)}.children`, "a Camera2D using retained local composition must own exactly one direct LocalSpace and no delivery-canvas siblings.");
    }
    if (directParent?.op === "cut.geo.annotation" && directParent.children.length !== 1) {
      fail("CUT_IR_IDENTITY", `${childPath("$.nodes", directParent.id)}.children`, "a GeoAnnotation owning LocalSpace must own that exact tile directly and exclusively.");
    }
    if (directParent?.op === "cut.visual.callout" && directParent.children.length !== 1) {
      fail("CUT_CALLOUT_GRAPH", `${childPath("$.nodes", directParent.id)}.children`, "a Callout owning LocalSpace must own that exact tile directly and exclusively.");
    }
    if (directParent?.op === "cut.visual.callout"
      && !sameExactInterval(directParent.interval, node.interval)) {
      fail("CUT_CALLOUT_GRAPH", `${path}.interval`, "a Callout LocalSpace must share its owner's exact start and duration.");
    }
    if (directParent?.op === "cut.visual.track_2d" && directParent.children.length !== 1) {
      fail("CUT_IR_IDENTITY", `${childPath("$.nodes", directParent.id)}.children`, "a Track2D owning LocalSpace must own that exact tile directly and exclusively.");
    }
    if (directParent?.op === "cut.visual.planar_track" && directParent.children.length !== 1) {
      fail("CUT_PLANAR_TRACK_GRAPH", `${childPath("$.nodes", directParent.id)}.children`, "PlanarTrack must own that exact LocalSpace tile directly and exclusively.");
    }
    if (directParent?.op === "cut.visual.planar_track"
      && (compareRational(directParent.interval.start, node.interval.start) !== 0
        || compareRational(directParent.interval.duration, node.interval.duration) !== 0)) {
      fail("CUT_IR_TIMING", `${path}.interval`, "a PlanarTrack LocalSpace must share its owner's exact start and duration; shortened or offset projective tiles are forbidden.");
    }
    if (directParent?.op === "cut.visual.depth_layer" && directParent.children.length !== 1) {
      fail("CUT_IR_IDENTITY", `${childPath("$.nodes", directParent.id)}.children`, "a DepthLayer using a local coordinate basis must own exactly one direct LocalSpace and no delivery-canvas siblings.");
    }
    if (directParent?.op === "cut.visual.plane3d" && directParent.children.length !== 1) {
      fail("CUT_CAMERA3D_GRAPH", `${childPath("$.nodes", directParent.id)}.children`, "a Plane3D must own exactly one direct LocalSpace retained tile and no delivery-canvas siblings.");
    }
    if (directParent?.op === "cut.visual.plane3d"
      && (compareRational(directParent.interval.start, node.interval.start) !== 0
        || compareRational(directParent.interval.duration, node.interval.duration) !== 0)) {
      fail("CUT_IR_TIMING", `${path}.interval`, "a Plane3D LocalSpace must share its owner's exact start and duration.");
    }

    let depth = 1, ancestor = directParent;
    const seenAncestors = new Set<string>();
    while (ancestor) {
      if (seenAncestors.has(ancestor.id)) fail("CUT_IR_CYCLE", childPath("$.nodes", ancestor.id), "LocalSpace ancestor chain cycles.");
      seenAncestors.add(ancestor.id);
      if (!localSpaceSupportedOwners.has(ancestor.op)) {
        fail("CUT_IR_UNKNOWN_FIELD", `${path}.ownership`, `ancestor ${ancestor.op} has no local positioned-surface vertical slice.`);
      }
      if (ancestor.op === "cut.visual.local_space") depth += 1;
      if (ancestor.op === "cut.geo.annotation"
        || ancestor.op === "cut.visual.callout"
        || ancestor.op === "cut.visual.camera2d"
        || ancestor.op === "cut.visual.track_2d"
        || ancestor.op === "cut.visual.planar_track"
        || ancestor.op === "cut.visual.depth_layer"
        || ancestor.op === "cut.visual.plane3d") break;
      const candidates = directParents.get(ancestor.id) ?? [];
      if (candidates.length > 1) fail("CUT_IR_IDENTITY", `${childPath("$.nodes", ancestor.id)}.ownership`, "has ambiguous structural parents.");
      if ((ancestor.op === "cut.visual.group" || ancestor.op === "cut.visual.motion_path")
        && candidates[0] && candidates[0].op !== "cut.visual.local_space") {
        fail(
          "CUT_IR_UNKNOWN_FIELD",
          `${childPath("$.nodes", ancestor.id)}.ownership`,
          `owner chain ${candidates[0].op} -> ${ancestor.op} -> LocalSpace would materialize and pre-clip a delivery-sized intermediate; checkpoint 1 permits only a direct root owner or an owner directly inside another LocalSpace.`,
        );
      }
      ancestor = candidates[0];
    }
    if (depth > localSpaceLimits.maximumNestedLocalSpaces) {
      fail("CUT_IR_LIMIT", path, `LocalSpace nesting depth ${depth} exceeds ${localSpaceLimits.maximumNestedLocalSpaces}.`);
    }

    // Discover locked media without crossing nested LocalSpace ownership.
    // Every media leaf must belong to one maximal historical V1 island; V2
    // wrappers may surround and combine those islands but may not create a
    // second decoder or delivery-canvas fallback path.
    const mediaDescendants = new Set<string>();
    const discoverMedia = (nodeId: string, visiting = new Set<string>()): boolean => {
      const candidate = ir.nodes[nodeId];
      // Nested LocalSpace owns an independent retained tile and is therefore
      // a materialization boundary for its parent's direct-branch classifier.
      if (!candidate || visiting.has(nodeId) || candidate.op === "cut.visual.local_space") return false;
      if (candidate.op === "cut.visual.image" || candidate.op === "cut.visual.video") return true;
      visiting.add(nodeId);
      const result = candidate.children.some((childId) => discoverMedia(childId, visiting));
      visiting.delete(nodeId);
      return result;
    };
    const mediaRoots = node.children.flatMap((rootId, sourceOrder) => discoverMedia(rootId) ? [{ rootId, sourceOrder }] : []);
    let retainedMaterializations = 0, retainedMediaTreeNodes = 0;
    const admitLegacyIsland = (rootId: string, diagnosticPath: string) => {
      retainedMaterializations += 1;
      if (retainedMaterializations > localSpaceLimits.maximumRetainedMediaBranchesPerLocalSpace) {
        fail("CUT_IR_LIMIT", diagnosticPath, `retained-media materialization count exceeds ${localSpaceLimits.maximumRetainedMediaBranchesPerLocalSpace} per LocalSpace.`);
      }
      let current = ir.nodes[rootId], groupDepth = 0, colorGrades = 0;
      const chain = new Set<string>();
      while (current) {
        if (chain.has(current.id)) fail("CUT_IR_CYCLE", childPath("$.nodes", current.id), "retained-media unary branch cycles.");
        chain.add(current.id); mediaDescendants.add(current.id);
        if (current.domain !== "visual" || current.editorial !== undefined
          || current.effects.length !== 1 || current.effects[0] !== "pure") {
          fail("CUT_IR_UNKNOWN_FIELD", childPath("$.nodes", current.id), "retained-media branches require ordinary pure visual nodes without editorial payload or hidden effect capabilities.");
        }
        if (current.op === "cut.visual.image" || current.op === "cut.visual.video") {
          if (current.children.length !== 0) fail("CUT_IR_TYPE", `${childPath("$.nodes", current.id)}.children`, "retained-media leaf must be childless.");
          break;
        }
        if (current.op !== "cut.visual.group" && current.op !== "cut.visual.color_grade") {
          fail("CUT_IR_UNKNOWN_FIELD", `${childPath("$.nodes", current.id)}.op`, `${current.op} is outside the closed unary Group/optional ColorGrade retained-media grammar.`);
        }
        if (current.children.length !== 1) fail("CUT_IR_TYPE", `${childPath("$.nodes", current.id)}.children`, "retained-media wrapper must own exactly one child.");
        if (current.op === "cut.visual.group" && ++groupDepth > 8) fail("CUT_IR_LIMIT", childPath("$.nodes", current.id), "retained-media Group depth exceeds 8.");
        if (current.op === "cut.visual.color_grade" && ++colorGrades > 1) fail("CUT_IR_LIMIT", childPath("$.nodes", current.id), "retained-media branch permits at most one ColorGrade.");
        current = ir.nodes[current.children[0]!];
      }
      if (!current) fail("CUT_IR_REFERENCE", diagnosticPath, "retained-media branch references a missing child.");
    };
    const visitRetainedMediaV2 = (nodeId: string, diagnosticPath: string, visiting = new Set<string>()): number => {
      const candidate = ir.nodes[nodeId], candidatePath = childPath("$.nodes", nodeId);
      if (!candidate) fail("CUT_IR_REFERENCE", diagnosticPath, `retained-media V2 tree references missing child ${JSON.stringify(nodeId)}.`);
      if (visiting.has(candidate.id)) fail("CUT_IR_CYCLE", candidatePath, "retained-media V2 compositor tree cycles.");
      retainedMediaTreeNodes += 1;
      if (retainedMediaTreeNodes > localSpaceLimits.maximumRetainedMediaLocalCompositorTreeNodes) {
        fail("CUT_IR_LIMIT", candidatePath, `retained-media V2 compositor tree node count exceeds ${localSpaceLimits.maximumRetainedMediaLocalCompositorTreeNodes}.`);
      }
      if (localSpaceLegacyRetainedMediaIslandRoot(ir, candidate.id)) {
        admitLegacyIsland(candidate.id, diagnosticPath);
        return 0;
      }
      if (candidate.domain !== "visual" || candidate.editorial !== undefined
        || candidate.effects.length !== 1 || candidate.effects[0] !== "pure") {
        fail("CUT_IR_UNKNOWN_FIELD", candidatePath, "retained-media V2 compositor trees require ordinary pure visual nodes without editorial payload or hidden effect capabilities.");
      }
      if (candidate.op === "cut.visual.shadow" || candidate.op === "cut.visual.glow") {
        fail("CUT_IR_UNKNOWN_FIELD", `${candidatePath}.op`, `${candidate.op} remains refused because no LocalSpace halo expansion/clipping policy is public.`);
      }
      if (!localSpaceSupportedDescendants.has(candidate.op)) {
        fail("CUT_IR_UNKNOWN_FIELD", `${candidatePath}.op`, `${candidate.op} is outside the closed retained-media local compositor V2 grammar; delivery-canvas fallback is forbidden.`);
      }
      if (candidate.op === "cut.visual.image" || candidate.op === "cut.visual.video") {
        fail("CUT_IR_TYPE", `${candidatePath}.children`, "retained-media leaf must be one childless maximal materialization island.");
      }
      if (candidate.op === "cut.visual.local_space") return 0;
      visiting.add(candidate.id);
      const nestedOperations = candidate.children.reduce(
        (sum, childId, index) => sum + visitRetainedMediaV2(childId, `${candidatePath}.children[${index}]`, visiting),
        0,
      );
      visiting.delete(candidate.id);
      return nestedOperations + (localSpaceCompositingOps.has(candidate.op) ? 1 : 0);
    };
    for (const { rootId, sourceOrder } of mediaRoots) {
      const diagnosticPath = `${path}.children[${sourceOrder}]`;
      if (localSpaceLegacyRetainedMediaUnaryCandidateRoot(ir, rootId)) {
        admitLegacyIsland(rootId, diagnosticPath);
        continue;
      }
      const operations = visitRetainedMediaV2(rootId, diagnosticPath);
      if (operations < 1) {
        fail("CUT_IR_UNKNOWN_FIELD", diagnosticPath, "a media-bearing V2 direct child requires at least one admitted Composite/Mask/ClipPath/finishing wrapper; Group-only multi-media topology remains unsupported.");
      }
    }
    const domainBranches = (retainedBranchesByExecutionDomain.get(executionDomain) ?? 0) + retainedMaterializations;
    retainedBranchesByExecutionDomain.set(executionDomain, domainBranches);
    if (domainBranches > localSpaceLimits.maximumRetainedMediaBranchesPerExecutionDomain) {
      fail("CUT_IR_LIMIT", `${path}.children`, `${executionDomain} retained-media materialization count exceeds ${localSpaceLimits.maximumRetainedMediaBranchesPerExecutionDomain}.`);
    }

    const visiting = new Set<string>();
    let preparedTracePoints = 0, localCompositingOperations = 0;
    const visit = (childId: string) => {
      const child = ir.nodes[childId], childNodePath = childPath("$.nodes", childId);
      if (!child) fail("CUT_IR_REFERENCE", childNodePath, `references missing LocalSpace descendant ${JSON.stringify(childId)}.`);
      if (visiting.has(child.id)) fail("CUT_IR_CYCLE", childNodePath, "LocalSpace descendant graph cycles.");
      if (child.domain !== "visual") fail("CUT_IR_TYPE", `${childNodePath}.domain`, "LocalSpace descendants must have visual domain.");
      if (!intervalContains(node, child)) fail("CUT_IR_TIMING", `${childNodePath}.interval`, "escapes the containing LocalSpace interval.");
      const owners = directParents.get(child.id) ?? [];
      if (owners.length !== 1) fail("CUT_IR_IDENTITY", `${childNodePath}.ownership`, "must belong to exactly one structural coordinate context.");
      if (child.op === "cut.visual.shadow" || child.op === "cut.visual.glow") {
        fail("CUT_IR_UNKNOWN_FIELD", `${childNodePath}.op`, `${child.op} is refused inside LocalSpace V1 because its halo can extend outside the declared tile and no public halo-bounds policy exists.`);
      }
      if (!localSpaceSupportedDescendants.has(child.op)) {
        fail("CUT_IR_UNKNOWN_FIELD", `${childNodePath}.op`, `${child.op} has no checkpoint-1 local-coordinate raster semantics; delivery-canvas fallback is forbidden.`);
      }
      if (child.op === "cut.visual.motion_path"
        && child.inputs.geometry?.kind === "call"
        && child.inputs.geometry.op === cutAnchoredSpatialOps.anchoredPath) {
        fail(
          "CUT_IR_UNKNOWN_FIELD",
          `${childNodePath}.inputs.geometry`,
          "AnchoredPathGeometry resolves composition-coordinate owners and has no ordinary LocalSpace coordinate basis; use VectorPathGeometry or move the MotionPath outside LocalSpace.",
        );
      }
      if ((child.op === "cut.visual.image" || child.op === "cut.visual.video")
        && !mediaDescendants.has(child.id)) {
        fail("CUT_IR_UNKNOWN_FIELD", `${childNodePath}.op`, `${child.op} is executable in LocalSpace only inside its exact retained-media branch.`);
      }
      if (localSpaceCompositingOps.has(child.op) && !mediaDescendants.has(child.id)) {
        localCompositingOperations += 1;
        if (localCompositingOperations > localSpaceLimits.maximumLocalCompositingOperationsPerLocalSpace) {
          fail("CUT_IR_LIMIT", childNodePath, `LocalSpace compositing operation count ${localCompositingOperations} exceeds ${localSpaceLimits.maximumLocalCompositingOperationsPerLocalSpace}.`);
        }
      }
      if (child.op === "cut.visual.trace") {
        let trace;
        try { trace = prepareReferenceTraceNode(child); }
        catch (error) {
          fail("CUT_IR_TYPE", `${childNodePath}.inputs`, `LocalSpace Trace geometry cannot be prepared: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!trace) fail("CUT_IR_TYPE", `${childNodePath}.inputs`, "LocalSpace Trace did not produce its public prepared geometry.");
        preparedTracePoints += trace.trace.points.length;
        if (!Number.isSafeInteger(preparedTracePoints)) fail("CUT_IR_LIMIT", childNodePath, "prepared LocalSpace Trace point accounting exceeds the safe integer range.");
      }
      if (child.op === "cut.visual.local_space") return;
      visiting.add(child.id);
      child.children.forEach(visit);
      visiting.delete(child.id);
    };
    node.children.forEach(visit);
    const aggregateLocalCompositingOperations = (localCompositingOperationsByExecutionDomain.get(executionDomain) ?? 0) + localCompositingOperations;
    localCompositingOperationsByExecutionDomain.set(executionDomain, aggregateLocalCompositingOperations);
    if (!Number.isSafeInteger(aggregateLocalCompositingOperations)
      || aggregateLocalCompositingOperations > localSpaceLimits.maximumLocalCompositingOperationsPerExecutionDomain) {
      fail("CUT_IR_LIMIT", path, `${executionDomain} LocalSpace compositing operation count ${aggregateLocalCompositingOperations} exceeds ${localSpaceLimits.maximumLocalCompositingOperationsPerExecutionDomain}.`);
    }
    const aggregateTracePoints = (preparedTracePointsByExecutionDomain.get(executionDomain) ?? 0) + preparedTracePoints;
    preparedTracePointsByExecutionDomain.set(executionDomain, aggregateTracePoints);
    if (!Number.isSafeInteger(aggregateTracePoints)
      || aggregateTracePoints > localSpaceLimits.maximumPreparedTracePointsPerExecutionDomain) {
      fail(
        "CUT_IR_LIMIT",
        path,
        `${executionDomain} prepared LocalSpace Trace geometry costs ${aggregateTracePoints} points per frame; the execution-domain limit is ${localSpaceLimits.maximumPreparedTracePointsPerExecutionDomain}.`,
      );
    }
  }
}

function validateGeoAnnotationGraphContracts(
  ir: CutAVIR,
  directParents: ReadonlyMap<string, readonly IRNode[]>,
  sceneOwners: ReadonlyMap<string, string>,
  compositions: ReadonlyMap<string, CutAVIR["compositions"][number]>,
) {
  const compositionRoots = new Map<string, CutAVIR["compositions"][number]>();
  for (const composition of ir.compositions) {
    for (const item of composition.items) if (item.kind === "node") compositionRoots.set(item.id, composition);
  }
  const compositionFor = (node: IRNode) => {
    if (node.sceneId) {
      const compositionId = sceneOwners.get(node.sceneId);
      return compositionId ? compositions.get(compositionId) : undefined;
    }
    const visited = new Set<string>(), pending = [node.id], matches = new Set<CutAVIR["compositions"][number]>();
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const rootComposition = compositionRoots.get(current);
      if (rootComposition) matches.add(rootComposition);
      for (const parent of directParents.get(current) ?? []) pending.push(parent.id);
    }
    return matches.size === 1 ? [...matches][0] : undefined;
  };

  const annotationsPerComposition = new Map<string, number>();
  const annotationsPerCamera = new Map<string, number>();
  for (const [nodeId, annotation] of Object.entries(ir.nodes)) {
    if (annotation.op !== "cut.geo.annotation") continue;
    const path = childPath("$.nodes", nodeId), parents = directParents.get(nodeId) ?? [];
    if (parents.length !== 1 || (parents[0].op !== "cut.visual.depth_layer" && parents[0].op !== "cut.geo.map_camera")) {
      fail("CUT_IR_IDENTITY", `${path}.ownership`, "must be exactly one direct child of one cut.visual.depth_layer or one cut.geo.map_camera.");
    }
    const owner = parents[0];
    let cameraId: string;
    if (owner.op === "cut.visual.depth_layer") {
      const layerPath = childPath("$.nodes", owner.id), layerParents = directParents.get(owner.id) ?? [];
      if (layerParents.length !== 1 || layerParents[0].op !== "cut.visual.parallax_camera") {
        fail("CUT_IR_IDENTITY", `${layerPath}.ownership`, "a DepthLayer containing GeoAnnotation must be a direct child of exactly one cut.visual.parallax_camera.");
      }
      cameraId = layerParents[0].id;
    } else cameraId = owner.id;
    const child = ir.nodes[annotation.children[0]];
    if (!child || child.domain !== "visual") fail("CUT_IR_TYPE", `${path}.children[0]`, "must reference one existing visual child.");
    const childParents = directParents.get(child.id) ?? [];
    if (childParents.length !== 1 || childParents[0]?.id !== annotation.id) {
      fail("CUT_IR_IDENTITY", `${childPath("$.nodes", child.id)}.ownership`, "GeoAnnotation child must be owned directly and exclusively by that annotation.");
    }
    if (!sameExactInterval(annotation.interval, child.interval)) {
      fail("CUT_IR_TIMING", `${path}.children[0]`, "child interval must exactly equal its GeoAnnotation interval.");
    }

    const composition = compositionFor(annotation);
    if (!composition) fail("CUT_IR_IDENTITY", path, "must resolve to exactly one owning composition.");
    const localForm = child.op === "cut.visual.local_space";
    const authoredWidth = annotation.inputs.width !== undefined, authoredHeight = annotation.inputs.height !== undefined;
    if (localForm && (authoredWidth || authoredHeight)) {
      fail("CUT_IR_IDENTITY", `${path}.inputs`, "GeoAnnotation with a direct LocalSpace child derives its viewport and forbids width and height.");
    }
    if (!localForm && (!authoredWidth || !authoredHeight)) {
      fail("CUT_IR_MISSING_FIELD", `${path}.inputs`, "legacy GeoAnnotation with an ordinary visual child requires both width and height; only a direct LocalSpace child may omit them.");
    }
    if (owner.op === "cut.geo.map_camera" && !localForm) {
      fail("CUT_IR_IDENTITY", `${path}.children[0]`, "MapCamera-owned GeoAnnotation requires the direct LocalSpace retained-tile form; the legacy delivery-canvas crop path is forbidden.");
    }
    const width = localForm
      ? localSpaceExactPixelLength(child.inputs.width, `${childPath("$.nodes", child.id)}.inputs.width`)
      : geoAnnotationQuantity(annotation.inputs.width, `${path}.inputs.width`, ["length"], rational(1), rational(composition.width), true);
    const height = localForm
      ? localSpaceExactPixelLength(child.inputs.height, `${childPath("$.nodes", child.id)}.inputs.height`)
      : geoAnnotationQuantity(annotation.inputs.height, `${path}.inputs.height`, ["length"], rational(1), rational(composition.height), true);
    if (compareRational(width, rational(composition.width)) > 0 || compareRational(height, rational(composition.height)) > 0) {
      fail("CUT_IR_LIMIT", `${path}.children[0]`, "derived LocalSpace viewport cannot exceed its owning composition delivery dimensions.");
    }
    const safeArea = geoAnnotationQuantity(
      annotation.inputs.safeArea,
      `${path}.inputs.safeArea`,
      ["length"],
      zeroRational,
      rational(Math.min(composition.width, composition.height)),
    );
    const twiceSafe = multiplyRational(safeArea, rational(2));
    if (compareRational(twiceSafe, rational(composition.width)) >= 0 || compareRational(twiceSafe, rational(composition.height)) >= 0) {
      fail("CUT_IR_LIMIT", `${path}.inputs.safeArea`, "leaves no positive half-open safe delivery rectangle.");
    }
    if (compareRational(addRational(width, twiceSafe), rational(composition.width)) > 0
      || compareRational(addRational(height, twiceSafe), rational(composition.height)) > 0) {
      fail("CUT_IR_LIMIT", `${path}.inputs`, "declared viewport can never fit inside the uniform safe delivery rectangle.");
    }
    if (annotation.inputs.leaderWidth !== undefined) {
      geoAnnotationQuantity(
        annotation.inputs.leaderWidth,
        `${path}.inputs.leaderWidth`,
        ["length"],
        zeroRational,
        rational(Math.min(composition.width, composition.height)),
      );
    }

    const compositionCount = (annotationsPerComposition.get(composition.id) ?? 0) + 1;
    annotationsPerComposition.set(composition.id, compositionCount);
    if (compositionCount > 128) fail("CUT_IR_LIMIT", path, `composition ${JSON.stringify(composition.id)} exceeds the 128 GeoAnnotation limit.`);
    const cameraCount = (annotationsPerCamera.get(cameraId) ?? 0) + 1;
    annotationsPerCamera.set(cameraId, cameraCount);
    if (cameraCount > 64) fail("CUT_IR_LIMIT", path, `camera ${JSON.stringify(cameraId)} exceeds the 64 GeoAnnotation limit.`);
  }
}

const mapCameraRetainedMapInputs = new Set(["detail", "background", "land", "border", "borderWidth", "graticule", "graticuleWidth"]);

/** Close the hostile-IR ownership/context boundary for the public retained
 * camera before the runtime opens atlas bytes or allocates a delivery raster. */
function validateMapCameraGraphContracts(ir: CutAVIR, directParents: ReadonlyMap<string, readonly IRNode[]>) {
  const allowedChildren = new Set(["cut.geo.map", "cut.geo.route", "cut.geo.route_subject", "cut.geo.marker", "cut.geo.wavefront", "cut.geo.annotation"]);
  const cameras = Object.values(ir.nodes).filter((node) => node.op === "cut.geo.map_camera");
  for (const camera of cameras) {
    const path = childPath("$.nodes", camera.id), parents = directParents.get(camera.id) ?? [];
    if (camera.domain !== "visual" || camera.ownership !== "root" || parents.length !== 0) {
      fail("CUT_IR_IDENTITY", `${path}.ownership`, "MapCamera must be one untransformed scene-root visual.");
    }
    if (camera.children.length < 1 || camera.children.length > 64 || new Set(camera.children).size !== camera.children.length) {
      fail("CUT_IR_LIMIT", `${path}.children`, "MapCamera requires 1 through 64 unique direct retained geographic children.");
    }
    let maps = 0, authoredGeoPoints = 0;
    for (const [index, childId] of camera.children.entries()) {
      const child = ir.nodes[childId], childNodePath = childPath("$.nodes", childId);
      if (!child || !allowedChildren.has(child.op)) {
        fail("CUT_IR_UNKNOWN_FIELD", `${path}.children[${index}]`, "MapCamera accepts only Map, Route, RouteSubject, Marker, Wavefront, or LocalSpace-backed GeoAnnotation; Connections remains outside the public retained data contract.");
      }
      const owners = directParents.get(child.id) ?? [];
      if (child.domain !== "visual" || child.ownership !== "child" || owners.length !== 1 || owners[0].id !== camera.id) {
        fail("CUT_IR_IDENTITY", `${childNodePath}.ownership`, "retained geographic child must be owned directly and exclusively by its MapCamera.");
      }
      if (!intervalContains(camera, child)) fail("CUT_IR_TIMING", `${childNodePath}.interval`, "escapes its owning MapCamera interval.");
      if (child.op !== "cut.geo.annotation" && child.children.length !== 0) fail("CUT_IR_IDENTITY", `${childNodePath}.children`, "retained geographic leaves cannot own generic visual children.");
      if (child.op === "cut.geo.map") {
        maps += 1;
        const detail = child.inputs.detail;
        if (detail?.kind !== "string" || !["110m", "50m", "10m"].includes(detail.value)) {
          fail("CUT_IR_ENUM", `${childNodePath}.inputs.detail`, "Map inside MapCamera requires 110m, 50m, or 10m.");
        }
        for (const name of ["points", "signal", "reveal", "scale", "rotation", "font"]) if (child.inputs[name] !== undefined) {
          fail("CUT_IR_UNKNOWN_FIELD", `${childNodePath}.inputs.${name}`, "is not executed by the retained MapCamera Map path.");
        }
      }
      if (child.op === "cut.geo.route" || child.op === "cut.geo.route_subject") {
        const points = child.inputs.points;
        if (points?.kind === "array") authoredGeoPoints += points.items.length;
      } else if (child.op === "cut.geo.marker" || child.op === "cut.geo.wavefront" || child.op === "cut.geo.annotation") {
        authoredGeoPoints += 1;
      }
      if (!Number.isSafeInteger(authoredGeoPoints) || authoredGeoPoints > 65_536) {
        fail("CUT_IR_LIMIT", `${path}.children`, `MapCamera authored geographic points exceed the 65536-point camera limit.`);
      }
      const forbidden = child.op === "cut.geo.route" ? ["scale", "rotation"]
        : child.op === "cut.geo.marker" ? ["projection", "globeRotation", "globeTilt", "globeX", "globeY", "globeRadius", "label", "font", "scale", "rotation"]
          : child.op === "cut.geo.wavefront" ? ["projection", "x", "y", "globeRotation", "globeTilt", "globeX", "globeY", "globeRadius", "scale", "rotation"]
            : [];
      for (const name of forbidden) if (child.inputs[name] !== undefined) {
        fail("CUT_IR_UNKNOWN_FIELD", `${childNodePath}.inputs.${name}`, "is not executed by this MapCamera-owned retained child.");
      }
    }
    if (maps > 1) fail("CUT_IR_LIMIT", `${path}.children`, "MapCamera accepts at most one retained Map atlas layer.");
  }

  for (const node of Object.values(ir.nodes)) if (node.op === "cut.geo.map") {
    const retained = Object.keys(node.inputs).find((name) => mapCameraRetainedMapInputs.has(name));
    if (retained !== undefined && (directParents.get(node.id) ?? [])[0]?.op !== "cut.geo.map_camera") {
      fail("CUT_IR_UNKNOWN_FIELD", `${childPath("$.nodes", node.id)}.inputs.${retained}`, "retained Map field is valid only on a direct MapCamera child; standalone Map cannot ignore it.");
    }
  }
  for (const node of Object.values(ir.nodes)) if (node.op === "cut.geo.route_subject") {
    const owners = directParents.get(node.id) ?? [];
    if (owners.length !== 1 || owners[0]?.op !== "cut.geo.map_camera") {
      fail(
        "CUT_IR_IDENTITY",
        `${childPath("$.nodes", node.id)}.ownership`,
        "RouteSubject must be owned directly and exclusively by one MapCamera; it has no standalone projection semantics.",
      );
    }
  }
}

function anchoredCall(value: unknown, path: string, expectedOp: string, fields: readonly string[]) {
  const call = closed(value, path, ["kind", "op", "positional", "named", "effect"]);
  if (call.kind !== "call") fail("CUT_IR_TYPE", `${path}.kind`, "anchored spatial values must be persisted as versioned IR calls.");
  if (call.op !== expectedOp) fail("CUT_IR_ENUM", `${path}.op`, `must be exactly ${JSON.stringify(expectedOp)}.`);
  if (call.effect !== "pure") fail("CUT_IR_TYPE", `${path}.effect`, "anchored spatial calls must have the pure effect.");
  if (!Array.isArray(call.positional) || call.positional.length !== 0) {
    fail("CUT_IR_TYPE", `${path}.positional`, "must be empty; public positional and named spellings canonicalize into named fields.");
  }
  return closed(call.named, `${path}.named`, fields);
}

function anchoredVec2(value: unknown, path: string) {
  const point = closed(value, path, ["kind", "entries"]);
  if (point.kind !== "object") fail("CUT_IR_TYPE", `${path}.kind`, "must be an exact { x: Length, y: Length } IR object.");
  const entries = closed(point.entries, `${path}.entries`, ["x", "y"]);
  const maximum = rational(cutAnchoredPathLimits.maximumAbsoluteCoordinatePx);
  const minimum = rational(-cutAnchoredPathLimits.maximumAbsoluteCoordinatePx);
  const result = {} as { x: Rational; y: Rational };
  for (const axis of ["x", "y"] as const) {
    const quantityPath = `${path}.entries.${axis}`;
    const quantity = closed(entries[axis], quantityPath, ["kind", "dimension", "magnitude", "unit"]);
    if (quantity.kind !== "quantity" || quantity.dimension !== "length" || quantity.unit !== "px") {
      fail("CUT_IR_TYPE", quantityPath, "must be one canonical pixel Length quantity.");
    }
    const magnitude = quantity.magnitude as Rational;
    if (compareRational(magnitude, minimum) < 0 || compareRational(magnitude, maximum) > 0) {
      fail("CUT_IR_LIMIT", `${quantityPath}.magnitude`, `absolute anchored coordinates and offsets cannot exceed ${cutAnchoredPathLimits.maximumAbsoluteCoordinatePx}px.`);
    }
    result[axis] = magnitude;
  }
  return result;
}

type AnchoredPathValidationState = {
  points: number;
  owners: Array<{ id: string; path: string; localPath: string; local: { x: Rational; y: Rational } }>;
  uniqueOwners: Set<string>;
};

type AnchoredSpatialPointResult = {
  base: "static" | "anchor";
  offset: { x: Rational; y: Rational };
};

function anchoredSpatialPoint(value: unknown, path: string, state: AnchoredPathValidationState, depth = 0): AnchoredSpatialPointResult {
  if (depth === 0) {
    state.points += 1;
    if (state.points > cutAnchoredPathLimits.maximumSpatialPoints) {
      fail("CUT_IR_LIMIT", path, `anchored geometry exceeds ${cutAnchoredPathLimits.maximumSpatialPoints} spatial values.`);
    }
  }
  if (depth > cutAnchoredPathLimits.maximumOffsetDepth) {
    fail("CUT_IR_LIMIT", path, `compositionOffset nesting exceeds ${cutAnchoredPathLimits.maximumOffsetDepth}.`);
  }
  const candidate = record(value, path);
  if (candidate.kind === "object") {
    anchoredVec2(value, path);
    return { base: "static", offset: { x: zeroRational, y: zeroRational } };
  }
  const op = candidate.kind === "call" ? candidate.op : undefined;
  if (op === cutAnchoredSpatialOps.visualAnchor) {
    const fields = anchoredCall(value, path, cutAnchoredSpatialOps.visualAnchor, ["owner", "local"]);
    const owner = closed(fields.owner, `${path}.named.owner`, ["kind", "id"]);
    if (owner.kind !== "node-ref" || typeof owner.id !== "string") {
      fail("CUT_IR_TYPE", `${path}.named.owner`, "visualAnchor owner must be one direct node-ref.");
    }
    const local = anchoredVec2(fields.local, `${path}.named.local`);
    state.owners.push({
      id: owner.id,
      path: `${path}.named.owner.id`,
      localPath: `${path}.named.local`,
      local,
    });
    state.uniqueOwners.add(owner.id);
    if (state.uniqueOwners.size > cutAnchoredPathLimits.maximumUniqueOwners) {
      fail("CUT_IR_LIMIT", `${path}.named.owner.id`, `anchored geometry exceeds ${cutAnchoredPathLimits.maximumUniqueOwners} unique visual owners.`);
    }
    return { base: "anchor", offset: { x: zeroRational, y: zeroRational } };
  }
  if (op === cutAnchoredSpatialOps.compositionOffset) {
    const fields = anchoredCall(value, path, cutAnchoredSpatialOps.compositionOffset, ["point", "by"]);
    const point = anchoredSpatialPoint(fields.point, `${path}.named.point`, state, depth + 1);
    const by = anchoredVec2(fields.by, `${path}.named.by`);
    const offset = { x: addRational(point.offset.x, by.x), y: addRational(point.offset.y, by.y) };
    if (compareRational(offset.x, zeroRational) === 0 && compareRational(offset.y, zeroRational) === 0) {
      fail("CUT_IR_IDENTITY", `${path}.named.by`, "compositionOffset chain has zero net displacement; use its base point directly.");
    }
    return { base: point.base, offset };
  }
  fail("CUT_IR_TYPE", path, `must be ${cutAnchoredSpatialOps.visualAnchor} or ${cutAnchoredSpatialOps.compositionOffset}; generic object lookalikes are not spatial points.`);
}

function calloutSpatialPoint(value: unknown, path: string) {
  const state: AnchoredPathValidationState = { points: 0, owners: [], uniqueOwners: new Set() };
  try {
    anchoredSpatialPoint(value, path, state);
  } catch (error) {
    if (!(error instanceof CutAvIrValidationError)) throw error;
    const code = error.code === "CUT_IR_LIMIT" ? "CUT_CALLOUT_LIMIT"
      : error.code === "CUT_IR_IDENTITY" ? "CUT_CALLOUT_NOOP"
        : error.code === "CUT_IR_CYCLE" ? "CUT_CALLOUT_GRAPH"
          : "CUT_CALLOUT_TYPE";
    const prefix = `${error.code} at ${error.path}: `;
    fail(code, error.path, error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message);
  }
  return state;
}

type ResponsiveAnnotatedFragmentBoundary = {
  fragment: IRNode;
  stack: IRNode;
  camera: IRNode;
  consumerIds: ReadonlySet<string>;
};

/**
 * Authenticate the only non-unary component fragment admitted around a
 * ResponsiveStack. No persisted flag grants authority: the loader reconstructs
 * the exact definition/invocation provenance, complete-scene identity wrapper,
 * ordered stack/consumer grammar, slot camera, and every anchor edge.
 */
function validateResponsiveAnnotatedFragmentContracts(
  ir: CutAVIR,
  directParents: ReadonlyMap<string, readonly IRNode[]>,
) {
  const result = new Map<string, ResponsiveAnnotatedFragmentBoundary>();
  const candidates = Object.values(ir.nodes).filter((node) =>
    node.op === "cut.kernel.fragment"
    && node.children.length > 1
    && node.children.some((childId) => ir.nodes[childId]?.op === "cut.visual.responsive_stack"));
  const rootMembership = (nodeId: string) => {
    let count = 0;
    for (const composition of ir.compositions) {
      count += composition.items.filter((item) => item.kind === "node" && item.id === nodeId).length;
    }
    for (const scene of Object.values(ir.scenes)) {
      count += scene.items.filter((item) => item.id === nodeId).length;
    }
    return count;
  };
  const sameSpan = (left: IRNode["provenance"]["span"], right: IRNode["provenance"]["span"]) =>
    stableJsonStringify(left) === stableJsonStringify(right);
  const containsSpan = (outer: IRNode["provenance"]["span"], inner: IRNode["provenance"]["span"]) =>
    outer.start.offset <= inner.start.offset && outer.end.offset >= inner.end.offset;
  const collectAnchorOwners = (
    value: IRValue,
    path: string,
  ): Array<{ id: string; path: string }> => {
    if (value.kind === "call") {
      if (value.op === cutAnchoredSpatialOps.visualAnchor) {
        const owner = value.named.owner;
        if (owner?.kind !== "node-ref") {
          fail("CUT_RESPONSIVE_STACK_GRAPH", `${path}.named.owner`, "responsive annotated fragment visualAnchor owner must be one node-ref.");
        }
        return [{ id: owner.id, path: `${path}.named.owner.id` }];
      }
      return [
        ...value.positional.flatMap((item, index) => collectAnchorOwners(item, `${path}.positional[${index}]`)),
        ...Object.entries(value.named).flatMap(([name, item]) =>
          collectAnchorOwners(item, `${path}.named.${name}`)),
      ];
    }
    if (value.kind === "array") {
      return value.items.flatMap((item, index) => collectAnchorOwners(item, `${path}.items[${index}]`));
    }
    if (value.kind === "object") {
      return Object.entries(value.entries).flatMap(([name, item]) =>
        collectAnchorOwners(item, `${path}.entries.${name}`));
    }
    if (value.kind === "range") {
      return [
        ...collectAnchorOwners(value.start, `${path}.start`),
        ...collectAnchorOwners(value.end, `${path}.end`),
      ];
    }
    if (value.kind === "unary") return collectAnchorOwners(value.value, `${path}.value`);
    if (value.kind === "binary") {
      return [
        ...collectAnchorOwners(value.left, `${path}.left`),
        ...collectAnchorOwners(value.right, `${path}.right`),
      ];
    }
    if (value.kind === "member") return collectAnchorOwners(value.object, `${path}.object`);
    if (value.kind === "index") {
      return [
        ...collectAnchorOwners(value.object, `${path}.object`),
        ...collectAnchorOwners(value.index, `${path}.index`),
      ];
    }
    return [];
  };

  for (const fragment of candidates) {
    const path = childPath("$.nodes", fragment.id);
    const scene = fragment.sceneId ? ir.scenes[fragment.sceneId] : undefined;
    const sceneItems = scene?.items.filter((item) => item.id === fragment.id && item.domain === "visual").length ?? 0;
    const sceneRoots = scene?.rootVisualIds.filter((id) => id === fragment.id).length ?? 0;
    if (!scene
      || fragment.domain !== "visual"
      || fragment.ownership !== "root"
      || (directParents.get(fragment.id) ?? []).length !== 0
      || rootMembership(fragment.id) !== 1
      || sceneItems !== 1
      || sceneRoots !== 1) {
      fail(
        "CUT_RESPONSIVE_STACK_GRAPH",
        `${path}.ownership`,
        "responsive annotated component must be one untransformed identity visual fragment reached exactly once as a complete-interval scene root.",
      );
    }
    if (compareRational(fragment.interval.start, zeroRational) !== 0
      || compareRational(fragment.interval.duration, scene.duration) !== 0) {
      fail("CUT_RESPONSIVE_STACK_GRAPH", `${path}.interval`, "responsive annotated component must span its complete scene exactly.");
    }
    if (Object.keys(fragment.inputs).length !== 0) {
      fail("CUT_RESPONSIVE_STACK_GRAPH", `${path}.inputs`, "responsive annotated identity fragment cannot carry inputs.");
    }
    if (Object.keys(fragment.properties).length !== 0) {
      fail("CUT_RESPONSIVE_STACK_GRAPH", `${path}.properties`, "responsive annotated identity fragment cannot carry transforms or automation.");
    }
    if (fragment.effects.length !== 1 || fragment.effects[0] !== "pure") {
      fail("CUT_RESPONSIVE_STACK_GRAPH", `${path}.effects`, "responsive annotated identity fragment must retain only its pure component effect.");
    }
    if (fragment.editorial !== undefined) {
      fail("CUT_RESPONSIVE_STACK_GRAPH", `${path}.editorial`, "responsive annotated identity fragment cannot carry editorial semantics.");
    }
    const frames = fragment.provenance.expandedFrom;
    const definition = frames?.[0], invocation = frames?.[1];
    const fragmentSymbol = fragment.provenance.symbol;
    const definitionSuffix = ":definition";
    if (!frames
      || frames.length !== 2
      || !fragmentSymbol
      || !definition?.symbol.endsWith(definitionSuffix)
      || definition.symbol.length <= definitionSuffix.length
      || (definition.module === fragment.provenance.module
        && definition.symbol !== `${fragmentSymbol}:definition`)
      || invocation?.symbol !== `${fragmentSymbol}:invocation`
      || invocation.module !== fragment.provenance.module
      || !sameSpan(invocation.span, fragment.provenance.span)) {
      fail(
        "CUT_RESPONSIVE_STACK_GRAPH",
        `${path}.provenance.expandedFrom`,
        "responsive annotated component provenance must contain exactly its definition frame followed by its direct invocation frame.",
      );
    }

    const children = fragment.children.map((childId, index) => {
      const child = ir.nodes[childId];
      if (!child) fail("CUT_RESPONSIVE_STACK_GRAPH", `${path}.children[${index}]`, `references missing child ${JSON.stringify(childId)}.`);
      const parents = directParents.get(child.id) ?? [];
      if (child.domain !== "visual"
        || child.ownership !== "child"
        || child.sceneId !== fragment.sceneId
        || parents.length !== 1
        || parents[0]!.id !== fragment.id
        || fragment.children.filter((id) => id === child.id).length !== 1
        || !sameExactInterval(child.interval, fragment.interval)
        || child.provenance.module !== definition.module
        || stableJsonStringify(child.provenance.expandedFrom) !== stableJsonStringify(frames)
        || !containsSpan(definition.span, child.provenance.span)) {
        fail(
          "CUT_RESPONSIVE_STACK_GRAPH",
          `${path}.children[${index}]`,
          "responsive annotated fragment direct children must be unique exact-interval definition-owned nodes with the fragment's exact expansion provenance.",
        );
      }
      return child;
    });
    const stack = children[0];
    const consumers = children.slice(1);
    const paths = consumers.filter((child) => child.op === "cut.visual.path");
    const layers = consumers.filter((child) => child.op === "cut.visual.callout_layer");
    if (stack?.op !== "cut.visual.responsive_stack"
      || consumers.length < 1
      || paths.length > 1
      || layers.length > 1
      || paths.length + layers.length !== consumers.length) {
      fail(
        "CUT_RESPONSIVE_STACK_GRAPH",
        `${path}.children`,
        "responsive annotated fragment children must be one first ResponsiveStack followed by at most one anchored Path and at most one CalloutLayer.",
      );
    }

    const cameras: IRNode[] = [];
    for (const [slotIndex, slotId] of stack.children.entries()) {
      const slot = ir.nodes[slotId], slotPath = `${childPath("$.nodes", stack.id)}.children[${slotIndex}]`;
      const slotParents = slot ? directParents.get(slot.id) ?? [] : [];
      if (!slot
        || slot.op !== "cut.visual.responsive_slot"
        || slot.domain !== "visual"
        || slot.ownership !== "child"
        || slot.sceneId !== fragment.sceneId
        || slotParents.length !== 1
        || slotParents[0]!.id !== stack.id
        || stack.children.filter((id) => id === slot.id).length !== 1
        || slot.children.length !== 1
        || !sameExactInterval(slot.interval, fragment.interval)
        || slot.provenance.module !== definition.module
        || stableJsonStringify(slot.provenance.expandedFrom) !== stableJsonStringify(frames)
        || !containsSpan(definition.span, slot.provenance.span)) {
        fail("CUT_RESPONSIVE_STACK_GRAPH", slotPath, "responsive annotated fragment has a malformed or transplanted ResponsiveSlot.");
      }
      const child = ir.nodes[slot.children[0]!], childParents = child ? directParents.get(child.id) ?? [] : [];
      if (!child
        || child.ownership !== "child"
        || child.sceneId !== fragment.sceneId
        || childParents.length !== 1
        || childParents[0]!.id !== slot.id
        || !sameExactInterval(child.interval, fragment.interval)
        || child.provenance.module !== definition.module
        || stableJsonStringify(child.provenance.expandedFrom) !== stableJsonStringify(frames)
        || !containsSpan(definition.span, child.provenance.span)) {
        fail("CUT_RESPONSIVE_STACK_GRAPH", `${slotPath}.children[0]`, "responsive annotated fragment has a malformed or transplanted slot visual.");
      }
      if (child.op === "cut.visual.media_camera2d") cameras.push(child);
    }
    if (cameras.length !== 1) {
      fail("CUT_RESPONSIVE_STACK_GRAPH", `${childPath("$.nodes", stack.id)}.children`, "responsive annotated fragment must contain exactly one ResponsiveSlot MediaCamera2D.");
    }
    const camera = cameras[0]!;

    for (const consumer of consumers) {
      const consumerPath = childPath("$.nodes", consumer.id);
      const references = consumer.op === "cut.visual.path"
        ? Object.entries(consumer.inputs).flatMap(([name, value]) =>
            collectAnchorOwners(value, `${consumerPath}.inputs.${name}`)
              .map((reference) => ({ ...reference, consumer })))
        : consumer.children.flatMap((calloutId, index) => {
            const callout = ir.nodes[calloutId];
            const calloutPath = childPath("$.nodes", calloutId);
            const calloutParents = callout ? directParents.get(callout.id) ?? [] : [];
            if (!callout || callout.op !== "cut.visual.callout") {
              fail("CUT_RESPONSIVE_STACK_GRAPH", `${consumerPath}.children[${index}]`, "annotated CalloutLayer must retain direct Callout children.");
            }
            if (callout.domain !== "visual"
              || callout.ownership !== "child"
              || callout.sceneId !== fragment.sceneId
              || calloutParents.length !== 1
              || calloutParents[0]!.id !== consumer.id
              || consumer.children.filter((id) => id === callout.id).length !== 1
              || rootMembership(callout.id) !== 0
              || !sameExactInterval(callout.interval, fragment.interval)
              || callout.provenance.module !== definition.module
              || stableJsonStringify(callout.provenance.expandedFrom) !== stableJsonStringify(frames)
              || !containsSpan(definition.span, callout.provenance.span)) {
              fail(
                "CUT_RESPONSIVE_STACK_GRAPH",
                `${consumerPath}.children[${index}]`,
                "annotated Callout must be a unique exact-interval definition-owned child with the fragment's exact expansion provenance.",
              );
            }
            if (callout.children.length !== 1) {
              fail("CUT_RESPONSIVE_STACK_GRAPH", `${calloutPath}.children`, "annotated Callout must own exactly one LocalSpace.");
            }
            const localSpace = ir.nodes[callout.children[0]!];
            const localParents = localSpace ? directParents.get(localSpace.id) ?? [] : [];
            if (!localSpace
              || localSpace.op !== "cut.visual.local_space"
              || localSpace.domain !== "visual"
              || localSpace.ownership !== "child"
              || localSpace.sceneId !== fragment.sceneId
              || localParents.length !== 1
              || localParents[0]!.id !== callout.id
              || callout.children.filter((id) => id === localSpace.id).length !== 1
              || rootMembership(localSpace.id) !== 0
              || !sameExactInterval(localSpace.interval, fragment.interval)
              || localSpace.provenance.module !== definition.module
              || stableJsonStringify(localSpace.provenance.expandedFrom) !== stableJsonStringify(frames)
              || !containsSpan(definition.span, localSpace.provenance.span)) {
              fail(
                "CUT_RESPONSIVE_STACK_GRAPH",
                `${calloutPath}.children[0]`,
                "annotated Callout LocalSpace must be a unique exact-interval definition-owned child with the fragment's exact expansion provenance.",
              );
            }
            const state = calloutSpatialPoint(callout.inputs.anchor, `${calloutPath}.inputs.anchor`);
            return state.owners.map((owner) => ({ id: owner.id, path: owner.path, consumer: callout }));
          });
      if (references.length === 0 || references.some((reference) => reference.id !== camera.id)) {
        fail(
          "CUT_RESPONSIVE_STACK_GRAPH",
          consumerPath,
          "every responsive annotated Path/CalloutLayer consumer must anchor only to the fragment's one slot MediaCamera2D.",
        );
      }
      for (const reference of references) {
        validateResponsiveSlotCameraAnchorOwner(
          ir,
          camera,
          reference.consumer,
          reference.path,
          directParents,
          consumer.op === "cut.visual.path" ? "CUT_IR_IDENTITY" : "CUT_CALLOUT_ANCHOR",
        );
      }
    }
    result.set(fragment.id, {
      fragment,
      stack,
      camera,
      consumerIds: new Set(consumers.map((consumer) => consumer.id)),
    });
  }
  return result;
}

function validateAnchoredPathGeometry(
  ir: CutAVIR,
  node: IRNode,
  path: string,
  value: IRValue,
  directParents: ReadonlyMap<string, readonly IRNode[]>,
) {
  const fields = anchoredCall(value, path, cutAnchoredSpatialOps.anchoredPath, ["start", "segments", "closed"]);
  const state: AnchoredPathValidationState = { points: 0, owners: [], uniqueOwners: new Set() };
  anchoredSpatialPoint(fields.start, `${path}.named.start`, state);
  const startIdentity = stableJsonStringify(fields.start);
  let currentIdentity = startIdentity;
  const segmentsValue = closed(fields.segments, `${path}.named.segments`, ["kind", "items"]);
  if (segmentsValue.kind !== "array" || !Array.isArray(segmentsValue.items)) {
    fail("CUT_IR_TYPE", `${path}.named.segments`, "must be one canonical anchored segment array.");
  }
  if (segmentsValue.items.length < 1 || segmentsValue.items.length > cutAnchoredPathLimits.maximumSegments) {
    fail("CUT_IR_LIMIT", `${path}.named.segments.items`, `must contain 1 through ${cutAnchoredPathLimits.maximumSegments} anchored segments.`);
  }
  segmentsValue.items.forEach((segment, index) => {
    const segmentPath = `${path}.named.segments.items[${index}]`, candidate = record(segment, segmentPath);
    if (candidate.kind !== "call") fail("CUT_IR_TYPE", `${segmentPath}.kind`, "anchored segments must be versioned IR calls.");
    if (candidate.op === cutAnchoredSpatialOps.anchoredLineTo) {
      const line = anchoredCall(segment, segmentPath, cutAnchoredSpatialOps.anchoredLineTo, ["to"]);
      anchoredSpatialPoint(line.to, `${segmentPath}.named.to`, state);
      const toIdentity = stableJsonStringify(line.to);
      if (toIdentity === currentIdentity) fail("CUT_IR_IDENTITY", `${segmentPath}.named.to`, "anchored line has a determinable zero-length endpoint.");
      currentIdentity = toIdentity;
      return;
    }
    if (candidate.op === cutAnchoredSpatialOps.anchoredCubicTo) {
      const cubic = anchoredCall(segment, segmentPath, cutAnchoredSpatialOps.anchoredCubicTo, ["control1", "control2", "to"]);
      anchoredSpatialPoint(cubic.control1, `${segmentPath}.named.control1`, state);
      anchoredSpatialPoint(cubic.control2, `${segmentPath}.named.control2`, state);
      anchoredSpatialPoint(cubic.to, `${segmentPath}.named.to`, state);
      const control1Identity = stableJsonStringify(cubic.control1);
      const control2Identity = stableJsonStringify(cubic.control2);
      const toIdentity = stableJsonStringify(cubic.to);
      if (control1Identity === currentIdentity && control2Identity === currentIdentity && toIdentity === currentIdentity) {
        fail("CUT_IR_IDENTITY", segmentPath, "anchored cubic has determinable zero length because both controls and its endpoint equal the current point.");
      }
      currentIdentity = toIdentity;
      return;
    }
    fail("CUT_IR_ENUM", `${segmentPath}.op`, `must be ${cutAnchoredSpatialOps.anchoredLineTo} or ${cutAnchoredSpatialOps.anchoredCubicTo}.`);
  });
  const closedValue = closed(fields.closed, `${path}.named.closed`, ["kind", "value"]);
  if (closedValue.kind !== "boolean" || typeof closedValue.value !== "boolean") {
    fail("CUT_IR_TYPE", `${path}.named.closed`, "must be one canonical IR boolean.");
  }
  if (closedValue.value && currentIdentity === startIdentity) {
    fail("CUT_IR_IDENTITY", `${path}.named.closed`, "closed anchored geometry must omit a terminal endpoint equal to its start; closure already supplies that edge.");
  }
  if (state.owners.length === 0) {
    fail("CUT_IR_TYPE", path, "AnchoredPathGeometry must contain at least one visualAnchor; use vectorPath for entirely static composition points.");
  }
  for (const reference of state.owners) {
    const owner = ir.nodes[reference.id];
    if (!owner) fail("CUT_IR_REFERENCE", reference.path, `references missing visual owner node “${reference.id}”.`);
    if (owner.id === node.id) fail("CUT_IR_CYCLE", reference.path, "an anchored geometry consumer cannot name itself as a visual owner.");
    if (owner.domain !== "visual") fail("CUT_IR_TYPE", reference.path, `visualAnchor owner ${owner.id} must have visual domain; found ${owner.domain}.`);
    if (owner.sceneId !== node.sceneId) fail("CUT_IR_IDENTITY", reference.path, "visualAnchor owner and anchored geometry consumer must belong to the same scene/composition scope.");
    if (owner.op === "cut.visual.media_camera2d") {
      const responsiveSlotOwner = validateResponsiveSlotCameraAnchorOwner(
        ir,
        owner,
        node,
        reference.path,
        directParents,
        "CUT_IR_IDENTITY",
      );
      if (!responsiveSlotOwner) {
        const scene = owner.sceneId ? ir.scenes[owner.sceneId] : undefined;
        const sceneItemCount = scene?.items.filter((item) => item.id === owner.id && item.domain === "visual").length ?? 0;
        const sceneRootCount = scene?.rootVisualIds.filter((id) => id === owner.id).length ?? 0;
        if (!scene || owner.ownership !== "root" || sceneItemCount !== 1 || sceneRootCount !== 1) {
          fail("CUT_IR_IDENTITY", reference.path, "MediaCamera2D visualAnchor owner must be one directly reachable visual root or one exact ResponsiveSlot camera in the consumer's lexical scope.");
        }
      }
      const maximum = rational(cutAnchoredPathLimits.maximumMediaSourceCoordinatePx);
      for (const axis of ["x", "y"] as const) {
        if (compareRational(reference.local[axis], zeroRational) < 0
          || compareRational(reference.local[axis], maximum) > 0) {
          fail(
            "CUT_IR_LIMIT",
            `${reference.localPath}.entries.${axis}.magnitude`,
            `MediaCamera2D visualAnchor source ${axis} must be an exact finite pixel coordinate from 0px through ${cutAnchoredPathLimits.maximumMediaSourceCoordinatePx}px; the locked runtime enforces the exact post-crop extent.`,
          );
        }
      }
      continue;
    }
    const localSpace = owner.op === "cut.visual.local_space"
      ? owner
      : owner.children.length === 1 && ir.nodes[owner.children[0]]?.op === "cut.visual.local_space"
      ? ir.nodes[owner.children[0]]
        : undefined;
    if (!localSpace) {
      fail("CUT_IR_TYPE", reference.path, "visualAnchor owner must be an exact retained placement with one directly owned LocalSpace view.");
    }
    const localPath = childPath("$.nodes", localSpace.id), width = localSpaceExactPixelLength(localSpace.inputs.width, `${localPath}.inputs.width`);
    const height = localSpaceExactPixelLength(localSpace.inputs.height, `${localPath}.inputs.height`), origin = localSpace.inputs.origin;
    if (origin?.kind !== "object") fail("CUT_IR_TYPE", `${localPath}.inputs.origin`, "must be an exact LocalSpace origin.");
    const originX = localSpaceExactPixelLength(origin.entries.x, `${localPath}.inputs.origin.entries.x`);
    const originY = localSpaceExactPixelLength(origin.entries.y, `${localPath}.inputs.origin.entries.y`);
    const minX = subtractRational(zeroRational, originX), minY = subtractRational(zeroRational, originY);
    const maxX = subtractRational(width, originX), maxY = subtractRational(height, originY);
    if (compareRational(reference.local.x, minX) < 0 || compareRational(reference.local.x, maxX) > 0
      || compareRational(reference.local.y, minY) < 0 || compareRational(reference.local.y, maxY) > 0) {
      fail("CUT_IR_LIMIT", reference.path, "visualAnchor local point must lie inside its owner's closed authored LocalSpace view.");
    }
  }
}

function validateCalloutGraphContracts(
  ir: CutAVIR,
  directParents: ReadonlyMap<string, readonly IRNode[]>,
  responsiveAnnotatedFragments: ReadonlyMap<string, ResponsiveAnnotatedFragmentBoundary>,
) {
  const layers = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.callout_layer");
  const callouts = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.callout");
  const compositionForScene = new Map<string, CutAVIR["compositions"][number]>();
  for (const composition of ir.compositions) {
    for (const sceneId of composition.sceneIds) compositionForScene.set(sceneId, composition);
  }
  const rootMembership = (nodeId: string) => {
    let count = 0;
    for (const composition of ir.compositions) {
      count += composition.items.filter((item) => item.kind === "node" && item.id === nodeId).length;
    }
    for (const scene of Object.values(ir.scenes)) {
      count += scene.items.filter((item) => item.id === nodeId).length;
    }
    return count;
  };
  const structurallyReaches = (from: string, target: string) => {
    const pending = [from], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const candidate = ir.nodes[id];
      if (candidate) pending.push(...candidate.children);
    }
    return false;
  };

  const calloutsByComposition = new Map<string, number>();
  for (const layer of layers) {
    const path = childPath("$.nodes", layer.id);
    if (layer.domain !== "visual"
      || Object.keys(layer.inputs).length !== 0
      || Object.keys(layer.properties).length !== 0) {
      fail("CUT_CALLOUT_GRAPH", path, "CalloutLayer must be a parameterless visual coordination root with no properties.");
    }
    const parents = directParents.get(layer.id) ?? [];
    const annotatedBoundary = parents.length === 1
      ? responsiveAnnotatedFragments.get(parents[0]!.id)
      : undefined;
    const annotatedChild = annotatedBoundary?.consumerIds.has(layer.id) === true;
    if (!layer.sceneId
      || (annotatedChild
        ? layer.ownership !== "child" || rootMembership(layer.id) !== 0
        : layer.ownership !== "root" || parents.length !== 0 || rootMembership(layer.id) !== 1)) {
      fail("CUT_CALLOUT_GRAPH", `${path}.ownership`, "CalloutLayer must be one direct scene root or the authenticated direct overlay child of one responsive annotated identity fragment.");
    }
    const scene = ir.scenes[layer.sceneId];
    const rootId = annotatedChild ? annotatedBoundary!.fragment.id : layer.id;
    const sceneItems = scene?.items.filter((item) => item.id === rootId && item.domain === "visual").length ?? 0;
    const visualRoots = scene?.rootVisualIds.filter((id) => id === rootId).length ?? 0;
    if (!scene || sceneItems !== 1 || visualRoots !== 1
      || (annotatedChild && (parents[0]!.sceneId !== layer.sceneId || !sameExactInterval(parents[0]!.interval, layer.interval)))) {
      fail("CUT_CALLOUT_GRAPH", `${path}.sceneId`, "CalloutLayer must be reachable exactly once through its declared scene visual root.");
    }
    if (compareRational(layer.interval.start, zeroRational) !== 0
      || compareRational(layer.interval.duration, scene.duration) !== 0) {
      fail("CUT_CALLOUT_GRAPH", `${path}.interval`, "CalloutLayer must span its complete scene exactly.");
    }
    if (layer.children.length < 1 || layer.children.length > 64) {
      fail("CUT_CALLOUT_LIMIT", `${path}.children`, `CalloutLayer must own 1 through 64 direct Callouts; found ${layer.children.length}.`);
    }
    const composition = compositionForScene.get(layer.sceneId);
    if (!composition) fail("CUT_CALLOUT_GRAPH", `${path}.sceneId`, "CalloutLayer scene has no owning composition.");
    const count = (calloutsByComposition.get(composition.id) ?? 0) + layer.children.length;
    calloutsByComposition.set(composition.id, count);
    if (count > 128) {
      fail("CUT_CALLOUT_LIMIT", `${path}.children`, `composition ${JSON.stringify(composition.id)} exceeds 128 Callouts.`);
    }
    layer.children.forEach((childId, index) => {
      const child = ir.nodes[childId];
      if (!child || child.op !== "cut.visual.callout") {
        fail("CUT_CALLOUT_GRAPH", `${path}.children[${index}]`, "CalloutLayer direct children must all be Callout nodes.");
      }
    });
  }

  for (const node of callouts) {
    const path = childPath("$.nodes", node.id), parents = directParents.get(node.id) ?? [];
    if (node.domain !== "visual"
      || node.ownership !== "child"
      || parents.length !== 1
      || parents[0]!.op !== "cut.visual.callout_layer"
      || !parents[0]!.children.includes(node.id)
      || rootMembership(node.id) !== 0
      || node.sceneId !== parents[0]!.sceneId) {
      fail("CUT_CALLOUT_GRAPH", `${path}.ownership`, "Callout must be owned directly and exclusively by one authenticated CalloutLayer.");
    }
    const layer = parents[0]!;
    if (!sameExactInterval(layer.interval, node.interval)) {
      fail("CUT_CALLOUT_GRAPH", `${path}.interval`, "Callout must share its CalloutLayer's exact start and duration.");
    }
    if (node.children.length !== 1) {
      fail("CUT_CALLOUT_GRAPH", `${path}.children`, `Callout requires exactly one direct LocalSpace child; found ${node.children.length}.`);
    }
    const localSpace = ir.nodes[node.children[0]!];
    const localParents = localSpace ? directParents.get(localSpace.id) ?? [] : [];
    if (!localSpace
      || localSpace.op !== "cut.visual.local_space"
      || localSpace.domain !== "visual"
      || localSpace.ownership !== "child"
      || localParents.length !== 1
      || localParents[0]!.id !== node.id
      || !sameExactInterval(node.interval, localSpace.interval)) {
      fail("CUT_CALLOUT_VIEWPORT", `${path}.children[0]`, "Callout requires one exact-interval direct LocalSpace tile owned exclusively by that Callout.");
    }

    const state = calloutSpatialPoint(node.inputs.anchor, `${path}.inputs.anchor`);
    for (const reference of state.owners) {
      const owner = ir.nodes[reference.id];
      if (!owner) fail("CUT_CALLOUT_ANCHOR", reference.path, `references missing visual owner ${JSON.stringify(reference.id)}.`);
      if (owner.id === node.id || owner.op === "cut.visual.callout" || owner.op === "cut.visual.callout_layer") {
        fail("CUT_CALLOUT_ANCHOR", reference.path, "Callout anchors cannot depend on themselves or another callout coordination node.");
      }
      if (structurallyReaches(owner.id, node.id) || structurallyReaches(node.id, owner.id)) {
        fail("CUT_CALLOUT_ANCHOR", reference.path, "anchor owner and Callout cannot have a structural ancestor/descendant dependency.");
      }
      if (owner.domain !== "visual") {
        fail("CUT_CALLOUT_ANCHOR", reference.path, `owner ${JSON.stringify(owner.id)} must have visual domain; found ${owner.domain}.`);
      }
      if (owner.sceneId !== node.sceneId) {
        fail("CUT_CALLOUT_ANCHOR", reference.path, "owner and Callout must belong to the same scene.");
      }
      const responsiveSlotOwner = owner.op === "cut.visual.media_camera2d"
        ? validateResponsiveSlotCameraAnchorOwner(
            ir,
            owner,
            node,
            reference.path,
            directParents,
            "CUT_CALLOUT_ANCHOR",
          )
        : false;
      const ownerScene = owner.sceneId ? ir.scenes[owner.sceneId] : undefined;
      const ownerSceneItems = ownerScene?.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.id === owner.id && item.domain === "visual") ?? [];
      const ownerVisualRoots = ownerScene?.rootVisualIds.filter((id) => id === owner.id).length ?? 0;
      const layerSceneIndex = ownerScene?.items.findIndex((item) => item.id === layer.id) ?? -1;
      const ownerParents = directParents.get(owner.id) ?? [];
      if (!responsiveSlotOwner && (!ownerScene
        || owner.ownership !== "root"
        || ownerParents.length !== 0
        || rootMembership(owner.id) !== 1
        || ownerSceneItems.length !== 1
        || ownerVisualRoots !== 1
        || layerSceneIndex < 0
        || ownerSceneItems[0]!.index >= layerSceneIndex)) {
        fail("CUT_CALLOUT_ANCHOR", reference.path, "visualAnchor owner must be one earlier direct visual root or one exact ResponsiveSlot camera in the CalloutLayer's lexical scope.");
      }
      if (!intervalContains(owner, node)) {
        fail("CUT_CALLOUT_ANCHOR", reference.path, "Callout interval must be contained by its anchor owner's interval.");
      }
      if (owner.provenance.module !== node.provenance.module
        || owner.provenance.span.start.offset >= node.provenance.span.start.offset) {
        fail("CUT_CALLOUT_ANCHOR", reference.path, "owner must be bound earlier than its Callout consumer in the same source module.");
      }
      if (owner.op === "cut.visual.media_camera2d") {
        const maximum = rational(cutAnchoredPathLimits.maximumMediaSourceCoordinatePx);
        for (const axis of ["x", "y"] as const) {
          if (compareRational(reference.local[axis], zeroRational) < 0
            || compareRational(reference.local[axis], maximum) > 0) {
            fail(
              "CUT_CALLOUT_ANCHOR",
              `${reference.localPath}.entries.${axis}.magnitude`,
              `MediaCamera2D source ${axis} must be from 0px through ${cutAnchoredPathLimits.maximumMediaSourceCoordinatePx}px; runtime validates the exact locked post-crop extent.`,
            );
          }
        }
        continue;
      }
      const retained = owner.op === "cut.visual.local_space"
        ? owner
        : owner.children.length === 1 && ir.nodes[owner.children[0]!]?.op === "cut.visual.local_space"
          ? ir.nodes[owner.children[0]!]
          : undefined;
      if (!retained) {
        fail("CUT_CALLOUT_ANCHOR", reference.path, "owner must expose exactly one directly owned retained LocalSpace coordinate view.");
      }
      const localPath = childPath("$.nodes", retained.id);
      const width = localSpaceExactPixelLength(retained.inputs.width, `${localPath}.inputs.width`);
      const height = localSpaceExactPixelLength(retained.inputs.height, `${localPath}.inputs.height`);
      const origin = retained.inputs.origin;
      if (origin?.kind !== "object") fail("CUT_CALLOUT_ANCHOR", `${localPath}.inputs.origin`, "must be an exact LocalSpace origin.");
      const originX = localSpaceExactPixelLength(origin.entries.x, `${localPath}.inputs.origin.entries.x`);
      const originY = localSpaceExactPixelLength(origin.entries.y, `${localPath}.inputs.origin.entries.y`);
      const minX = subtractRational(zeroRational, originX), minY = subtractRational(zeroRational, originY);
      const maxX = subtractRational(width, originX), maxY = subtractRational(height, originY);
      if (compareRational(reference.local.x, minX) < 0 || compareRational(reference.local.x, maxX) > 0
        || compareRational(reference.local.y, minY) < 0 || compareRational(reference.local.y, maxY) > 0) {
        fail("CUT_CALLOUT_ANCHOR", reference.path, "owner-local point must lie inside its retained LocalSpace's closed authored view.");
      }
    }
  }
}

const flowTextShapingLanguagePattern = /^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,3}$/u;
const flowTextShapingForbiddenBidiControl = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const flowTextShapingForbiddenControl = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

function flowTextShapingRecord(
  value: IRValue | undefined,
  path: string,
  required: readonly string[],
  optional: readonly string[],
) {
  if (value?.kind !== "object") fail("CUT_IR_TYPE", path, "must be a typed record.");
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value.entries).find((key) => !allowed.has(key));
  if (unknown) {
    fail(
      "CUT_IR_UNKNOWN_FIELD",
      diagnosticChildPath(`${path}.entries`, unknown),
      "is not part of the closed FlowText record contract.",
    );
  }
  const missing = required.find((key) => !Object.hasOwn(value.entries, key));
  if (missing) {
    fail("CUT_IR_MISSING_FIELD", diagnosticChildPath(`${path}.entries`, missing), "is required by the closed FlowText record contract.");
  }
  return value.entries;
}

function flowTextShapingString(value: IRValue | undefined, path: string) {
  if (value?.kind !== "string") fail("CUT_IR_TYPE", path, "must be a String.");
  return value.value;
}

function validateFlowTextShapingContent(value: IRValue | undefined, path: string) {
  const content = flowTextShapingString(value, path);
  if (!content || !/[^\p{Z}\p{C}]/u.test(content)) {
    fail("CUT_IR_TYPE", path, "must contain visible text.");
  }
  if (flowTextShapingForbiddenControl.test(content)
    || flowTextShapingForbiddenBidiControl.test(content)
    || content.includes("\r")
    || content.includes("\t")) {
    fail(
      "CUT_IR_TYPE",
      path,
      "contains a control, bidi override/isolate, tab, or carriage return; shaped FlowText accepts visible Unicode, ASCII space, and LF only.",
    );
  }
  if ([...content].some((character) => /\p{Z}/u.test(character) && character !== " ")) {
    fail("CUT_IR_TYPE", path, "contains non-ASCII spacing; deterministic wrapping admits U+0020 as its only soft-wrap separator.");
  }
  for (let index = 0; index < content.length; index += 1) {
    const unit = content.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("CUT_IR_TYPE", path, `contains an unpaired high surrogate at UTF-16 index ${index}.`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("CUT_IR_TYPE", path, `contains an unpaired low surrogate at UTF-16 index ${index}.`);
    }
  }
}

/**
 * Close the additive complex-shaping records at the persisted-IR boundary.
 *
 * The runtime still owns glyph/font coverage and layout preparation. This
 * loader mirror prevents a fully rehashed hostile artifact from smuggling an
 * ignored shaping field, host/foreign fallback, bidi control, or selector
 * combination into that preparation boundary.
 */
function validateFlowTextShapingStaticContract(ir: CutAVIR, node: IRNode, path: string) {
  const shapingValue = node.inputs.shaping;
  const complex = shapingValue !== undefined;
  let primaryFontId: string | undefined;
  if (complex) {
    const font = node.inputs.font;
    if (font?.kind !== "resource-ref" || ir.resources[font.id]?.kind !== "font") {
      fail("CUT_IR_REFERENCE", `${path}.inputs.font`, "shaped FlowText must reference one explicit locked FontAsset.");
    }
    primaryFontId = font.id;
    const shapingPath = `${path}.inputs.shaping`;
    const shaping = flowTextShapingRecord(
      shapingValue,
      shapingPath,
      ["paragraphDirection", "language", "fallbackFonts"],
      [],
    );
    const direction = flowTextShapingString(
      shaping.paragraphDirection,
      `${shapingPath}.entries.paragraphDirection`,
    );
    if (direction !== "ltr" && direction !== "rtl") {
      fail("CUT_IR_ENUM", `${shapingPath}.entries.paragraphDirection.value`, "must be exactly ltr or rtl.");
    }
    const language = flowTextShapingString(shaping.language, `${shapingPath}.entries.language`);
    if (!flowTextShapingLanguagePattern.test(language)) {
      fail(
        "CUT_IR_TYPE",
        `${shapingPath}.entries.language.value`,
        "must be a canonical lowercase bounded BCP-47 subset such as en, ar, or hi-deva.",
      );
    }
    const fallbackPath = `${shapingPath}.entries.fallbackFonts`;
    const fallbacks = shaping.fallbackFonts;
    if (fallbacks?.kind !== "array") fail("CUT_IR_TYPE", fallbackPath, "must be a typed List<FontAsset>.");
    if (fallbacks.items.length < 1 || fallbacks.items.length > 7) {
      fail("CUT_IR_LIMIT", fallbackPath, "must contain one through seven explicit locked fallback fonts.");
    }
    const ids: string[] = [], byteIdentities = new Set<string>();
    const primary = ir.resources[primaryFontId];
    if (primary?.sha256) byteIdentities.add(primary.sha256);
    fallbacks.items.forEach((fallback, index) => {
      const fallbackItemPath = `${fallbackPath}.items[${index}]`;
      if (fallback.kind !== "resource-ref") {
        fail("CUT_IR_TYPE", fallbackItemPath, "must be one FontAsset resource reference.");
      }
      const resource = ir.resources[fallback.id];
      if (!resource) {
        fail("CUT_IR_REFERENCE", `${fallbackItemPath}.id`, `references missing fallback FontAsset “${fallback.id}”.`);
      }
      if (resource.kind !== "font") {
        fail("CUT_IR_TYPE", `${fallbackItemPath}.id`, `must reference a FontAsset; “${fallback.id}” is ${resource.kind}.`);
      }
      if (fallback.id === primaryFontId || ids.includes(fallback.id)) {
        fail("CUT_IR_IDENTITY", `${fallbackItemPath}.id`, "duplicates a face already present in the ordered primary/fallback chain.");
      }
      if (resource.sha256 && byteIdentities.has(resource.sha256)) {
        fail("CUT_IR_IDENTITY", `${fallbackItemPath}.id`, "resolves to locked bytes already present in the ordered primary/fallback chain.");
      }
      ids.push(fallback.id);
      if (resource.sha256) byteIdentities.add(resource.sha256);
    });

    const spansPath = `${path}.inputs.spans`, spans = node.inputs.spans;
    if (spans?.kind !== "array") fail("CUT_IR_TYPE", spansPath, "must be a typed List<TextSpan>.");
    spans.items.forEach((spanValue, index) => {
      const spanPath = `${spansPath}.items[${index}]`;
      const span = flowTextShapingRecord(
        spanValue,
        spanPath,
        ["id", "content"],
        ["font", "size", "color", "tracking", "baselineShift"],
      );
      validateFlowTextShapingContent(span.content, `${spanPath}.entries.content`);
      if (span.font !== undefined) {
        fail(
          "CUT_IR_TYPE",
          `${spanPath}.entries.font`,
          "is forbidden under textShaping; the explicit primary/fallback chain owns face selection.",
        );
      }
    });
  }

  const motions = node.inputs.motions;
  if (motions === undefined) return;
  const motionsPath = `${path}.inputs.motions`;
  if (motions.kind !== "array") fail("CUT_IR_TYPE", motionsPath, "must be a typed List<TextUnitMotion>.");
  motions.items.forEach((motionValue, index) => {
    const motionPath = `${motionsPath}.items[${index}]`;
    const motion = flowTextShapingRecord(
      motionValue,
      motionPath,
      ["span", "by", "duration"],
      ["order", "start", "count", "at", "each", "from", "to", "easing", "before"],
    );
    const by = flowTextShapingString(motion.by, `${motionPath}.entries.by`);
    if (by !== "line" && by !== "word" && by !== "glyph" && by !== "cluster") {
      fail("CUT_IR_ENUM", `${motionPath}.entries.by.value`, "must be line, word, glyph, or cluster.");
    }
    if (!complex && by === "cluster") {
      fail("CUT_IR_TYPE", `${motionPath}.entries.by.value`, "cluster selection requires one executing textShaping profile.");
    }
    if (complex && by === "glyph") {
      fail("CUT_IR_TYPE", `${motionPath}.entries.by.value`, "glyph selection is forbidden under textShaping because it can split one shaped cluster.");
    }
    if (motion.order !== undefined) {
      const order = flowTextShapingString(motion.order, `${motionPath}.entries.order`);
      if (order !== "logical" && order !== "visual") {
        fail("CUT_IR_ENUM", `${motionPath}.entries.order.value`, "must be exactly logical or visual.");
      }
      if (!complex || by !== "cluster") {
        fail("CUT_IR_TYPE", `${motionPath}.entries.order`, "may be authored only for a cluster selector under textShaping.");
      }
      if (order === "logical") {
        fail("CUT_IR_IDENTITY", `${motionPath}.entries.order`, "redundantly repeats the omitted logical shaped-cluster order.");
      }
    }
  });
}

function timelineAudioStringInput(
  node: IRNode,
  name: string,
  path: string,
) {
  const value = node.inputs[name];
  if (value?.kind !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value.value)) {
    fail(
      value === undefined ? "CUT_IR_MISSING_FIELD" : "CUT_IR_TYPE",
      `${path}.inputs.${name}`,
      "must be one bounded stable compiler-owned String identity.",
    );
  }
  return value.value;
}

function timelineAudioAuthorityInput(
  node: IRNode,
  name: string,
  path: string,
) {
  const value = node.inputs[name];
  if (value?.kind !== "string"
    || !/^(?:[a-f0-9]{64}|[A-Za-z][A-Za-z0-9._-]{0,127})$/u
      .test(value.value)) {
    fail(
      value === undefined ? "CUT_IR_MISSING_FIELD" : "CUT_IR_TYPE",
      `${path}.inputs.${name}`,
      "must be one bounded stable compiler-owned authority identity or lowercase SHA-256.",
    );
  }
  return value.value;
}

function timelineAudioTimeInput(
  node: IRNode,
  name: string,
  path: string,
  positive: boolean,
  signed = false,
) {
  const value = node.inputs[name];
  if (value?.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    fail(
      value === undefined ? "CUT_IR_MISSING_FIELD" : "CUT_IR_TYPE",
      `${path}.inputs.${name}`,
      "must be one exact Time quantity in seconds.",
    );
  }
  if (!signed && compareRational(value.magnitude, zeroRational) < (positive ? 1 : 0)) {
    fail(
      "CUT_IR_TIMING",
      `${path}.inputs.${name}`,
      positive ? "must be positive." : "must be non-negative.",
    );
  }
  return value.magnitude;
}

function timelineAudioRateInput(node: IRNode, path: string) {
  const value = node.inputs.rate;
  if (value?.kind !== "quantity"
    || value.dimension !== "scalar"
    || value.unit !== "scalar") {
    fail(
      value === undefined ? "CUT_IR_MISSING_FIELD" : "CUT_IR_TYPE",
      `${path}.inputs.rate`,
      "must be one exact positive scalar rate.",
    );
  }
  if (compareRational(value.magnitude, zeroRational) <= 0) {
    fail("CUT_IR_TIMING", `${path}.inputs.rate`, "must be positive.");
  }
  return value.magnitude;
}

function timelineAudioSourceInput(
  node: IRNode,
  path: string,
  inputName: "source" | "evaluationSource" = "source",
) {
  const source = node.inputs[inputName];
  if (source?.kind !== "range" || source.exclusive !== true) {
    fail(
      source === undefined ? "CUT_IR_MISSING_FIELD" : "CUT_IR_TYPE",
      `${path}.inputs.${inputName}`,
      "must be one exact half-open Time range.",
    );
  }
  const endpoint = (value: IRValue, name: "start" | "end") => {
    if (value.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
      fail("CUT_IR_TYPE", `${path}.inputs.${inputName}.${name}`, "must be an exact Time quantity in seconds.");
    }
    return value.magnitude;
  };
  const start = endpoint(source.start, "start"), end = endpoint(source.end, "end");
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    fail("CUT_IR_TIMING", `${path}.inputs.${inputName}`, "must have a non-negative start and a later exclusive end.");
  }
  return { start, duration: subtractRational(end, start) };
}

function timelineAudioNodeRefInput(node: IRNode, name: string, path: string) {
  const value = node.inputs[name];
  if (value?.kind !== "node-ref") {
    fail(
      value === undefined ? "CUT_IR_MISSING_FIELD" : "CUT_IR_TYPE",
      `${path}.inputs.${name}`,
      "must be one compiler-owned node reference.",
    );
  }
  return value.id;
}

function timelineAudioOriginKind(node: IRNode, path: string) {
  const kind = timelineAudioStringInput(node, "originKind", path);
  if (!(cutTimelineAudioOriginKinds as readonly string[]).includes(kind)) {
    fail("CUT_IR_ENUM", `${path}.inputs.originKind.value`, "must be direct-audio or processed-audio.");
  }
  return kind as CutTimelineAudioOriginKind;
}

function timelineAudioStatePolicy(node: IRNode, path: string) {
  const policy = timelineAudioStringInput(node, "statePolicy", path);
  if (!(cutTimelineAudioStatePolicies as readonly string[]).includes(policy)) {
    fail("CUT_IR_ENUM", `${path}.inputs.statePolicy.value`, "must be single-authorized-evaluation.");
  }
  return policy;
}

function timelineAudioEvaluationEnvelope(node: IRNode, path: string) {
  const present = ["evaluationSource", "presentationZero", "fadeAnchorPolicy", "evaluationPolicy"]
    .filter((name) => node.inputs[name] !== undefined);
  if (!present.length) return undefined;
  if (present.length !== 4) {
    fail(
      "CUT_IR_MISSING_FIELD",
      `${path}.inputs`,
      "evaluationSource, presentationZero, fadeAnchorPolicy and evaluationPolicy form one all-or-nothing audio evaluation envelope.",
    );
  }
  const source = timelineAudioSourceInput(node, path, "evaluationSource");
  const presentationZero = timelineAudioTimeInput(
    node,
    "presentationZero",
    path,
    false,
  );
  const fadeAnchorPolicy = timelineAudioStringInput(
    node,
    "fadeAnchorPolicy",
    path,
  );
  if (!(cutTimelineAudioFadeAnchorPolicies as readonly string[])
    .includes(fadeAnchorPolicy)) {
    fail(
      "CUT_IR_ENUM",
      `${path}.inputs.fadeAnchorPolicy.value`,
      "must be origin-relative-at-presentation-zero.",
    );
  }
  const evaluationPolicy = timelineAudioStringInput(
    node,
    "evaluationPolicy",
    path,
  );
  if (!(cutTimelineAudioEvaluationPolicies as readonly string[])
    .includes(evaluationPolicy)) {
    fail(
      "CUT_IR_ENUM",
      `${path}.inputs.evaluationPolicy.value`,
      "must be selected-source-union-v1 or full-declared-handle-domain-v1.",
    );
  }
  return { source, presentationZero, fadeAnchorPolicy, evaluationPolicy };
}

const timelineProcessedExternalProcessorOps = new Set<string>(
  cutTimelineProcessedExternalHandleProcessorOps,
);

function validateTimelineProcessedExternalStaticChain(
  ir: CutAVIR,
  origin: IRNode,
  path: string,
) {
  const region = ir.nodes[origin.children[0]!];
  if (!region || region.op !== "cut.edit.audio_region"
    || Object.keys(region.properties).length
    || region.children.length !== 1) {
    fail("CUT_IR_IDENTITY", `${path}.children[0]`, "processed external handles require one static unary AudioRegion.");
  }
  let current = ir.nodes[region.children[0]!];
  let count = 0;
  let timeStretch: IRNode | undefined;
  const seen = new Set<string>([region.id]);
  while (current && current.op !== "cut.audio.clip") {
    if (seen.has(current.id)
      || !timelineProcessedExternalProcessorOps.has(current.op)
      || current.children.length !== 1
      || Object.keys(current.properties).length
      || count >= 32) {
      fail(
        "CUT_TIMELINE_EDIT_UNSUPPORTED",
        `${path}.children[0]`,
        "processed external handles admit only a bounded static unary Gain, Pan, ParametricEQ, HighPass, LowPass, Compressor, DeEsser, and one constrained TimeStretch chain.",
      );
    }
    if (current.op === "cut.audio.time_stretch") {
      if (timeStretch || ir.nodes[current.children[0]!]?.op !== "cut.audio.clip") {
        fail(
          "CUT_TIMELINE_EDIT_UNSUPPORTED",
          `${path}.children[0]`,
          "retimed external handles require exactly one innermost TimeStretch directly above AudioClip.",
        );
      }
      timeStretch = current;
    }
    seen.add(current.id);
    current = ir.nodes[current.children[0]!];
    count += 1;
  }
  if (!current || current.op !== "cut.audio.clip"
    || current.children.length !== 0
    || Object.keys(current.properties).length
    || count < 1) {
    fail("CUT_IR_IDENTITY", `${path}.children[0]`, "processed external handles require one static AudioClip leaf and at least one processor.");
  }
  const rate = timelineAudioRateInput(origin, path);
  if (compareRational(rate, rational(1)) !== 0 && !timeStretch) {
    fail(
      "CUT_TIMELINE_EDIT_UNSUPPORTED",
      `${path}.children[0]`,
      "retimed processed external handles require one authenticated constant TimeStretch.",
    );
  }
  if (timeStretch) {
    const sourceDuration = timelineAudioTimeInput(timeStretch, "sourceDuration", childPath("$.nodes", timeStretch.id), true);
    const duration = timelineAudioTimeInput(timeStretch, "duration", childPath("$.nodes", timeStretch.id), true);
    const source = timelineAudioLeafRange(ir, origin, path);
    const originDuration = timelineAudioTimeInput(origin, "originDuration", path, true);
    if (compareRational(sourceDuration, source.duration) !== 0
      || compareRational(duration, originDuration) !== 0
      || compareRational(divideRational(sourceDuration, duration), rate) !== 0) {
      fail(
        "CUT_IR_TIMING",
        `${childPath("$.nodes", timeStretch.id)}.inputs`,
        "TimeStretch sourceDuration, duration, and timeline origin rate must agree exactly.",
      );
    }
  }
}

function timelineAudioGraphAuthority(
  node: IRNode,
  kind: CutTimelineAudioOriginKind,
  path: string,
) {
  if (kind === "processed-audio") {
    return timelineAudioStringInput(node, "graphAuthorityId", path);
  }
  if (node.inputs.graphAuthorityId !== undefined) {
    fail(
      "CUT_IR_UNKNOWN_FIELD",
      `${path}.inputs.graphAuthorityId`,
      "is valid only for a processed-audio origin.",
    );
  }
  return undefined;
}

function timelineAudioLeafRange(ir: CutAVIR, origin: IRNode, path: string) {
  let current = ir.nodes[origin.children[0]!], depth = 0;
  const visited = new Set<string>();
  while (current && current.op !== "cut.audio.clip") {
    if (visited.has(current.id) || current.domain !== "audio"
      || current.children.length !== 1 || depth >= 64) {
      fail(
        "CUT_IR_IDENTITY",
        `${path}.children`,
        "must own one bounded acyclic unary audio graph ending in an AudioClip.",
      );
    }
    visited.add(current.id);
    current = ir.nodes[current.children[0]!];
    depth += 1;
  }
  if (!current || current.op !== "cut.audio.clip" || current.children.length !== 0) {
    fail("CUT_IR_REFERENCE", `${path}.children`, "lost its exact terminal AudioClip source.");
  }
  const range = current.inputs.range;
  if (range?.kind !== "range" || range.exclusive !== true
    || range.start.kind !== "quantity" || range.start.dimension !== "time" || range.start.unit !== "s"
    || range.end.kind !== "quantity" || range.end.dimension !== "time" || range.end.unit !== "s") {
    fail(
      "CUT_IR_TYPE",
      `${childPath("$.nodes", current.id)}.inputs.range`,
      "origin AudioClip must preserve one exact half-open Time range.",
    );
  }
  return {
    start: range.start.magnitude,
    duration: subtractRational(range.end.magnitude, range.start.magnitude),
  };
}

/**
 * Close the compiler-internal origin/view graph at load time. The runtime is
 * intentionally not trusted to infer which original graph, source slice, or
 * destination item one generated view meant.
 */
function validateTimelineAudioOriginStaticContract(
  ir: CutAVIR,
  node: IRNode,
  path: string,
  directParents: ReadonlyMap<string, readonly IRNode[]>,
) {
  const kind = timelineAudioOriginKind(node, path);
  timelineAudioAuthorityInput(node, "originAuthorityId", path);
  timelineAudioStringInput(node, "sourceAuthorityId", path);
  timelineAudioGraphAuthority(node, kind, path);
  const duration = timelineAudioTimeInput(node, "originDuration", path, true);
  const rate = timelineAudioRateInput(node, path);
  timelineAudioStatePolicy(node, path);
  const envelope = timelineAudioEvaluationEnvelope(node, path);
  if (envelope && kind === "direct-audio"
    && compareRational(rate, rational(1)) !== 0) {
    fail(
      "CUT_TIMELINE_EDIT_UNSUPPORTED",
      `${path}.inputs.evaluationSource`,
      "direct-audio external evaluation is executable only at exact 1x.",
    );
  }
  if (node.domain !== "audio" || node.ownership !== "reference" || !node.sceneId
    || node.editorial !== undefined || Object.keys(node.properties).length
    || node.children.length !== 1) {
    fail(
      "CUT_IR_IDENTITY",
      path,
      "must be one same-scene reference-owned immutable audio origin.",
    );
  }
  const child = ir.nodes[node.children[0]!], expectedOp = kind === "direct-audio"
    ? "cut.audio.clip"
    : "cut.edit.audio_region";
  if (!child || child.op !== expectedOp || child.domain !== "audio"
    || child.ownership !== "child" || child.sceneId !== node.sceneId
    || (directParents.get(child.id) ?? []).length !== 1
    || (directParents.get(child.id) ?? [])[0]?.id !== node.id) {
    fail(
      "CUT_IR_IDENTITY",
      `${path}.children[0]`,
      `must exclusively own the exact original ${expectedOp} graph.`,
    );
  }
  if (compareRational(child.interval.duration, duration) !== 0) {
    fail("CUT_IR_TIMING", `${path}.inputs.originDuration`, "must equal the original child graph duration.");
  }
  const source = timelineAudioLeafRange(ir, node, path);
  if (compareRational(source.duration, multiplyRational(duration, rate)) !== 0) {
    fail(
      "CUT_IR_TIMING",
      `${path}.inputs.rate`,
      "origin AudioClip source duration must exactly equal originDuration multiplied by rate.",
    );
  }
  if (envelope) {
    const sourceRoot = ir.nodes[node.children[0]!]!;
    const handle = (name: "headHandle" | "tailHandle") => sourceRoot.inputs[name] === undefined
      ? zeroRational
      : timelineAudioTimeInput(sourceRoot, name, childPath("$.nodes", sourceRoot.id), false);
    const availableStart = subtractRational(source.start, handle("headHandle"));
    const availableEnd = addRational(
      addRational(source.start, source.duration),
      handle("tailHandle"),
    );
    const envelopeEnd = addRational(envelope.source.start, envelope.source.duration);
    const expectedPolicy = kind === "processed-audio"
      ? "full-declared-handle-domain-v1"
      : "selected-source-union-v1";
    if (envelope.evaluationPolicy !== expectedPolicy) {
      fail(
        "CUT_IR_IDENTITY",
        `${path}.inputs.evaluationPolicy.value`,
        `must be ${expectedPolicy} for ${kind}.`,
      );
    }
    if (compareRational(envelope.source.start, availableStart) < 0
      || compareRational(envelopeEnd, availableEnd) > 0
      || compareRational(envelope.source.start, source.start) > 0
      || compareRational(envelopeEnd, addRational(source.start, source.duration)) < 0
      || compareRational(
        multiplyRational(envelope.presentationZero, rate),
        subtractRational(source.start, envelope.source.start),
      ) !== 0) {
      fail(
        "CUT_IR_TIMING",
        `${path}.inputs.evaluationSource`,
        "must contain the complete authored source, stay inside declared handles, and bind presentationZero through the exact source rate.",
      );
    }
    if (kind === "processed-audio") {
      if (compareRational(envelope.source.start, availableStart) !== 0
        || compareRational(envelopeEnd, availableEnd) !== 0) {
        fail(
          "CUT_IR_TIMING",
          `${path}.inputs.evaluationSource`,
          "processed external evaluation must equal the complete declared head/source/tail domain.",
        );
      }
      validateTimelineProcessedExternalStaticChain(ir, node, path);
    }
  }
  if (compareRational(node.interval.start, child.interval.start) !== 0
    || compareRational(node.interval.duration, duration) !== 0) {
    fail(
      "CUT_IR_TIMING",
      `${path}.interval`,
      "must preserve the authored placement; evaluationSource owns a private zero-based buffer, while views own destinations.",
    );
  }
}

function validateTimelineAudioViewStaticContract(
  ir: CutAVIR,
  node: IRNode,
  path: string,
  directParents: ReadonlyMap<string, readonly IRNode[]>,
) {
  const originId = timelineAudioNodeRefInput(node, "origin", path);
  const origin = ir.nodes[originId];
  if (!origin || origin.op !== cutTimelineAudioOriginOp) {
    fail("CUT_IR_REFERENCE", `${path}.inputs.origin.id`, "must reference one timeline audio origin owner.");
  }
  const kind = timelineAudioOriginKind(node, path);
  const originAuthorityId = timelineAudioAuthorityInput(
    node,
    "originAuthorityId",
    path,
  );
  const sourceAuthorityId = timelineAudioStringInput(node, "sourceAuthorityId", path);
  const graphAuthorityId = timelineAudioGraphAuthority(node, kind, path);
  const originDuration = timelineAudioTimeInput(node, "originDuration", path, true);
  const rate = timelineAudioRateInput(node, path);
  const sliceOffset = timelineAudioTimeInput(node, "sliceOffset", path, false, true);
  const headHandle = timelineAudioTimeInput(node, "headHandle", path, false);
  const tailHandle = timelineAudioTimeInput(node, "tailHandle", path, false);
  const source = timelineAudioSourceInput(node, path);
  const statePolicy = timelineAudioStatePolicy(node, path);
  const envelope = timelineAudioEvaluationEnvelope(node, path);
  if (node.inputs.link !== undefined) timelineAudioStringInput(node, "link", path);
  if (node.domain !== "audio" || node.ownership !== "child" || !node.sceneId
    || node.editorial !== undefined || Object.keys(node.properties).length
    || node.children.length !== 0 || origin.sceneId !== node.sceneId) {
    fail(
      "CUT_IR_IDENTITY",
      path,
      "must be one same-scene immutable child view with no structural children.",
    );
  }
  const originKind = timelineAudioOriginKind(origin, childPath("$.nodes", origin.id));
  const originGraphAuthority = timelineAudioGraphAuthority(
    origin,
    originKind,
    childPath("$.nodes", origin.id),
  );
  const originEnvelope = timelineAudioEvaluationEnvelope(
    origin,
    childPath("$.nodes", origin.id),
  );
  const mirrored = originKind === kind
    && timelineAudioAuthorityInput(
      origin,
      "originAuthorityId",
      childPath("$.nodes", origin.id),
    ) === originAuthorityId
    && timelineAudioStringInput(origin, "sourceAuthorityId", childPath("$.nodes", origin.id)) === sourceAuthorityId
    && originGraphAuthority === graphAuthorityId
    && compareRational(
      timelineAudioTimeInput(origin, "originDuration", childPath("$.nodes", origin.id), true),
      originDuration,
    ) === 0
    && compareRational(
      timelineAudioRateInput(origin, childPath("$.nodes", origin.id)),
      rate,
    ) === 0
    && timelineAudioStatePolicy(origin, childPath("$.nodes", origin.id)) === statePolicy
    && (originEnvelope === undefined || envelope === undefined
      ? originEnvelope === envelope
      : stableJsonStringify(originEnvelope) === stableJsonStringify(envelope));
  if (!mirrored) {
    fail("CUT_IR_IDENTITY", `${path}.inputs.origin`, "view identity and state inputs do not exactly mirror its immutable origin owner.");
  }
  const sourceDuration = multiplyRational(node.interval.duration, rate);
  const lowerPresentationBound = envelope
    ? subtractRational(zeroRational, envelope.presentationZero)
    : zeroRational;
  const upperPresentationBound = envelope
    ? subtractRational(
        divideRational(envelope.source.duration, rate),
        envelope.presentationZero,
      )
    : originDuration;
  if (compareRational(sourceDuration, source.duration) !== 0
    || compareRational(sliceOffset, lowerPresentationBound) < 0
    || compareRational(
      addRational(sliceOffset, node.interval.duration),
      upperPresentationBound,
    ) > 0) {
    fail(
      "CUT_IR_TIMING",
      path,
      "view source duration must equal destination duration multiplied by rate and its origin-relative slice must stay inside the authenticated evaluation envelope.",
    );
  }
  const originSource = timelineAudioLeafRange(ir, origin, childPath("$.nodes", origin.id));
  const selectedBounds = envelope?.source ?? originSource;
  if (compareRational(
    source.start,
    addRational(originSource.start, multiplyRational(sliceOffset, rate)),
  ) !== 0
    || compareRational(source.start, selectedBounds.start) < 0
    || compareRational(
      addRational(source.start, source.duration),
      addRational(selectedBounds.start, selectedBounds.duration),
    ) > 0) {
    fail("CUT_IR_IDENTITY", `${path}.inputs.source`, "must be the exact origin AudioClip source range advanced by sliceOffset multiplied by rate.");
  }
  const handleOwner = ir.nodes[origin.children[0]!]!;
  const authoredHandle = (name: "headHandle" | "tailHandle") => handleOwner.inputs[name] === undefined
    ? zeroRational
    : timelineAudioTimeInput(handleOwner, name, childPath("$.nodes", handleOwner.id), false);
  const availableStart = subtractRational(originSource.start, authoredHandle("headHandle"));
  const availableEnd = addRational(
    addRational(originSource.start, originSource.duration),
    authoredHandle("tailHandle"),
  );
  if (compareRational(subtractRational(source.start, headHandle), availableStart) < 0
    || compareRational(
      addRational(addRational(source.start, source.duration), tailHandle),
      availableEnd,
    ) > 0) {
    fail(
      "CUT_IR_TIMING",
      `${path}.inputs.headHandle`,
      "view head/tail handles must stay inside the original available AudioClip source range.",
    );
  }
  const parents = directParents.get(node.id) ?? [];
  const track = parents.length === 1 && parents[0]?.op === "cut.edit.audio_track"
    ? parents[0]
    : undefined;
  if (!track || track.sceneId !== node.sceneId || track.editorial?.kind !== "audio-track") {
    fail("CUT_IR_IDENTITY", `${path}.ownership`, "must be the exclusive direct child of one same-scene AudioTrack.");
  }
  const matching = track.editorial.items.filter((item) => item.nodeId === node.id);
  if (matching.length !== 1 || matching[0]!.kind !== "audio"
    || !matching[0]!.source
    || compareRational(matching[0]!.destination.start, node.interval.start) !== 0
    || compareRational(matching[0]!.destination.duration, node.interval.duration) !== 0
    || compareRational(matching[0]!.source.start, source.start) !== 0
    || compareRational(matching[0]!.source.duration, source.duration) !== 0) {
    fail("CUT_IR_IDENTITY", `${path}.interval`, "must exactly match one AudioTrack editorial destination/source item.");
  }
  const link = node.inputs.link?.kind === "string" ? node.inputs.link.value : undefined;
  if (matching[0]!.linkId !== link) {
    fail("CUT_IR_IDENTITY", `${path}.inputs.link`, "must exactly mirror the AudioTrack editorial linkId.");
  }
}

/**
 * Current CutAVIR is an executable contract, so a registered kernel cannot
 * carry inputs, properties, or children that the reference backend would
 * ignore. The exact archived 0.3 compiler identity remains structurally
 * readable only under the caller's explicit legacy identity mode for
 * migration/evidence; execution still passes through the same closed runtime
 * registry and cannot use that compatibility exception.
 */
function validateCurrentKernelContracts(ir: CutAVIR, identityMode: CutAvIrIdentityMode) {
  if (identityMode === "legacy-0.3-compatible" && ir.compiler === "cut-ts/0.3.0") return;
  const directParents = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) for (const childId of parent.children) {
    const parents = directParents.get(childId) ?? [];
    parents.push(parent);
    directParents.set(childId, parents);
  }
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const schema = referenceKernelSchema(node.op);
    if (schema?.support !== "supported") continue;
    const path = childPath("$.nodes", nodeId);
    const isCalloutKernel = node.op === "cut.visual.callout_layer" || node.op === "cut.visual.callout";
    if (isCalloutKernel && (node.effects.length !== 1 || node.effects[0] !== "pure")) {
      fail("CUT_CALLOUT_GRAPH", `${path}.effects`, "CalloutLayer and Callout require exactly the pure effect capability.");
    }
    if (isCalloutKernel && node.editorial !== undefined) {
      fail("CUT_CALLOUT_GRAPH", `${path}.editorial`, "CalloutLayer and Callout cannot carry editorial track semantics.");
    }
    if (schema.domain !== "any" && node.domain !== schema.domain) {
      fail(isCalloutKernel ? "CUT_CALLOUT_GRAPH" : "CUT_IR_TYPE", `${path}.domain`, `must be ${schema.domain} for the closed reference kernel ${node.op}.`);
    }
    for (const input of Object.keys(node.inputs)) {
      if (!kernelAcceptsInput(schema, input)) {
        fail(isCalloutKernel ? "CUT_CALLOUT_TYPE" : "CUT_IR_UNKNOWN_FIELD", diagnosticChildPath(`${path}.inputs`, input), `is not part of the closed reference kernel ${node.op} input contract.`);
      }
    }
    if (node.op === "cut.geo.annotation") validateGeoAnnotationStaticContract(node, path);
    if (node.op === "cut.geo.route_subject") validateRouteSubjectStaticContract(node, path);
    if (node.op === "cut.visual.callout") validateCalloutStaticContract(ir, node, path);
    if (node.op === "cut.visual.local_space") validateLocalSpaceStaticContract(node, path);
    if (node.op === "cut.visual.flow_text") validateFlowTextShapingStaticContract(ir, node, path);
    if (node.op === cutTimelineAudioOriginOp) {
      validateTimelineAudioOriginStaticContract(ir, node, path, directParents);
    }
    if (node.op === cutTimelineAudioViewOp) {
      validateTimelineAudioViewStaticContract(ir, node, path, directParents);
    }
    if (node.op === "cut.visual.motion_blur" && node.inputs.startEdge !== undefined) {
      const startEdge = node.inputs.startEdge;
      if (startEdge.kind !== "string") {
        fail("CUT_IR_TYPE", `${path}.inputs.startEdge`, "must be the static String hold or transparent for cut.visual.motion_blur.");
      }
      if (startEdge.value !== "hold" && startEdge.value !== "transparent") {
        fail("CUT_IR_ENUM", `${path}.inputs.startEdge.value`, "must be hold or transparent for cut.visual.motion_blur.");
      }
    }
    if (node.op === "cut.visual.path") {
      const legacy = node.inputs.points !== undefined, retained = node.inputs.geometry !== undefined;
      if (legacy && retained) fail("CUT_IR_TYPE", `${path}.inputs.geometry`, "cannot combine retained geometry with legacy points.");
      if (!legacy && !retained) fail("CUT_IR_TYPE", `${path}.inputs`, "must contain legacy points or retained geometry.");
      if (legacy) {
        const retainedOnly = ["morphTo", "morph", "trimStart", "trimEnd", "dash", "dashOffset", "fill", "fillRule", "lineCap", "lineJoin", "x", "y"];
        const input = retainedOnly.find((name) => node.inputs[name] !== undefined);
        if (input) fail("CUT_IR_UNKNOWN_FIELD", diagnosticChildPath(`${path}.inputs`, input), `is retained-Path-only and cannot alter the frozen legacy points contract.`);
        const property = retainedOnly.find((name) => !["x", "y"].includes(name) && node.properties[name] !== undefined);
        if (property) fail("CUT_IR_UNKNOWN_FIELD", diagnosticChildPath(`${path}.properties`, property), `is retained-Path-only and cannot alter the frozen legacy points contract.`);
      }
    }
    if ((node.op === "cut.visual.path" || node.op === "cut.visual.motion_path") && node.inputs.geometry !== undefined) {
      const geometry = node.inputs.geometry, geometryPath = `${path}.inputs.geometry`;
      if (geometry.kind === "call") {
        if (geometry.op !== cutAnchoredSpatialOps.anchoredPath) {
          fail("CUT_IR_ENUM", `${geometryPath}.op`, `PathGeometry call must be exactly ${cutAnchoredSpatialOps.anchoredPath}.`);
        }
        validateAnchoredPathGeometry(ir, node, geometryPath, geometry, directParents);
        if (node.op === "cut.visual.path" && node.inputs.morphTo !== undefined) {
          fail("CUT_ANCHORED_PATH_MORPH", `${path}.inputs.morphTo`, "anchored PathGeometry v1 cannot execute morphTo/morph; use VectorPathGeometry or remove the morph controls.");
        }
      } else if (geometry.kind === "object") {
        // Preserve the frozen VectorPathGeometry loader/runtime boundary. Its
        // exact record is decoded by the existing vector/motion-path runtime;
        // only the new versioned call form is admitted and closed here.
      } else {
        fail("CUT_IR_TYPE", geometryPath, "PathGeometry must be the legacy VectorPathGeometry object or a versioned anchored-path call.");
      }
    }
    const baselineIssue = cutVisualPropertyBaselineIssue(ir, node);
    if (baselineIssue) {
      const issuePath = baselineIssue.kind === "missing-input"
        ? diagnosticChildPath(`${path}.properties`, baselineIssue.property)
        : `${childPath("$.signals", baselineIssue.signalId)}.initial`;
      fail(baselineIssue.code, issuePath, baselineIssue.message);
    }
    for (const property of Object.keys(node.properties)) {
      if (!kernelAcceptsProperty(schema, property)) {
        fail(isCalloutKernel ? "CUT_CALLOUT_TYPE" : "CUT_IR_UNKNOWN_FIELD", diagnosticChildPath(`${path}.properties`, property), `is not part of the closed reference kernel ${node.op} property contract.`);
      }
    }
    const maximumChildren = schema.children === "none" ? 0 : schema.maximumChildren;
    if (node.children.length < schema.minimumChildren || (maximumChildren !== undefined && node.children.length > maximumChildren)) {
      const maximum = maximumChildren === undefined ? "unbounded" : String(maximumChildren);
      fail(
        node.op === "cut.visual.callout_layer" ? "CUT_CALLOUT_LIMIT"
          : node.op === "cut.visual.callout" ? "CUT_CALLOUT_GRAPH"
            : "CUT_IR_TYPE",
        `${path}.children`,
        `must contain ${schema.minimumChildren} through ${maximum} child nodes for the closed reference kernel ${node.op}.`,
      );
    }
    if (schema.children !== "none" && schema.children !== "any") {
      node.children.forEach((childId, index) => {
        const child = ir.nodes[childId];
        if (child && child.domain !== schema.children) {
          fail(isCalloutKernel ? "CUT_CALLOUT_GRAPH" : "CUT_IR_TYPE", `${path}.children[${index}]`, `must reference a ${schema.children} child for the closed reference kernel ${node.op}; ${child.op} has domain ${child.domain}.`);
        }
      });
    }
  }
}

function validateReferencesAndGraph(ir: CutAVIR, context: ValidationContext, identityMode: CutAvIrIdentityMode) {
  const compositions = new Map(ir.compositions.map((item) => [item.id, item]));
  for (const reference of context.references) {
    const exists = reference.kind === "node" ? Object.hasOwn(ir.nodes, reference.id) : reference.kind === "resource" ? Object.hasOwn(ir.resources, reference.id) : compositions.has(reference.id);
    if (!exists) fail("CUT_IR_REFERENCE", reference.path, `references missing ${reference.kind} “${reference.id}”.`);
  }
  for (const reference of context.signalReferences) if (!Object.hasOwn(ir.signals, reference.id)) fail("CUT_IR_REFERENCE", reference.path, `references missing signal “${reference.id}”.`);
  validateCurrentKernelContracts(ir, identityMode);
  try {
    assertCutTypedDataAssetConsumerCompatibility(ir);
  } catch (error) {
    if (error instanceof CutTypedDataAssetAuthorityError) {
      fail(error.code, error.path, error.message.replace(/^CUT_TYPED_DATA_ASSET_AUTHORITY at [^:]+:\s*/u, ""));
    }
    throw error;
  }

  const sceneOwners = new Map<string, string>();
  const rootMembership = new Map<string, number>();
  const markRoot = (id: string, path: string) => {
    if (!Object.hasOwn(ir.nodes, id)) fail("CUT_IR_REFERENCE", path, `references missing node “${id}”.`);
    const count = (rootMembership.get(id) ?? 0) + 1; rootMembership.set(id, count); if (count > 1) fail("CUT_IR_IDENTITY", path, `root node “${id}” belongs to multiple owners.`);
  };
  ir.compositions.forEach((composition, compositionIndex) => {
    const path = `$.compositions[${compositionIndex}]`;
    const sceneItems = composition.items.filter((item): item is { kind: "scene"; id: string } => item.kind === "scene");
    if (!arraysEqual(composition.sceneIds, sceneItems.map((item) => item.id))) fail("CUT_IR_IDENTITY", `${path}.sceneIds`, "does not match ordered scene items.");
    const nodeItems = composition.items.filter((item): item is { kind: "node"; id: string; domain: IRNode["domain"] } => item.kind === "node");
    assertRootLists(composition, nodeItems, path);
    nodeItems.forEach((item, index) => {
      const node = ir.nodes[item.id]; const itemPath = `${path}.items[${composition.items.indexOf(item)}]`;
      markRoot(item.id, `${itemPath}.id`); if (node.domain !== item.domain) fail("CUT_IR_IDENTITY", `${itemPath}.domain`, `does not match node ${item.id}.domain.`); if (node.sceneId) fail("CUT_IR_IDENTITY", `${itemPath}.id`, "timeline root unexpectedly belongs to a scene.");
      if (compareRational(addRational(node.interval.start, node.interval.duration), composition.duration) > 0) fail("CUT_IR_TIMING", `${itemPath}.id`, "node interval exceeds its composition.");
      void index;
    });
    composition.sceneIds.forEach((sceneId, index) => {
      const scenePath = `${path}.sceneIds[${index}]`; const scene = ir.scenes[sceneId]; if (!scene) fail("CUT_IR_REFERENCE", scenePath, `references missing scene “${sceneId}”.`);
      if (sceneOwners.has(sceneId)) fail("CUT_IR_IDENTITY", scenePath, `scene “${sceneId}” belongs to multiple compositions.`); sceneOwners.set(sceneId, composition.id);
      if (compareRational(addRational(scene.start, scene.duration), composition.duration) > 0) fail("CUT_IR_TIMING", scenePath, `scene “${sceneId}” exceeds composition duration.`);
    });
  });
  const annotationIds = new Set<string>();
  const validateAnnotationBoundary = (value: Rational, grid: "frame" | "sample", composition: CutAVIR["compositions"][number], path: string) => {
    if (compareRational(value, zeroRational) < 0 || compareRational(value, composition.duration) > 0) fail("CUT_IR_TIMING", path, `lies outside composition “${composition.id}”.`);
    const rate = grid === "frame" ? composition.fps : rational(composition.sampleRate);
    if (multiplyRational(value, rate).denominator !== "1") fail("CUT_IR_TIMING", path, `does not land on the authored ${grid} grid.`);
  };
  const validateAnnotationOwner = (annotation: NonNullable<CutAVIR["annotations"]>["markers"][number] | NonNullable<CutAVIR["annotations"]>["regions"][number], path: string, start: Rational, end: Rational) => {
    if (annotationIds.has(annotation.id)) fail("CUT_IR_IDENTITY", `${path}.id`, `duplicates annotation id “${annotation.id}”.`);
    annotationIds.add(annotation.id);
    const composition = compositions.get(annotation.compositionId);
    if (!composition) fail("CUT_IR_REFERENCE", `${path}.compositionId`, `references missing composition “${annotation.compositionId}”.`);
    validateAnnotationBoundary(start, annotation.grid, composition, annotation.kind === "marker" ? `${path}.at` : `${path}.range.start`);
    validateAnnotationBoundary(end, annotation.grid, composition, annotation.kind === "marker" ? `${path}.at` : `${path}.range`);
    if (!annotation.sceneId) return;
    const scene = ir.scenes[annotation.sceneId];
    if (!scene) fail("CUT_IR_REFERENCE", `${path}.sceneId`, `references missing scene “${annotation.sceneId}”.`);
    if (sceneOwners.get(annotation.sceneId) !== composition.id) fail("CUT_IR_IDENTITY", `${path}.sceneId`, `scene “${annotation.sceneId}” does not belong to composition “${composition.id}”.`);
    const sceneEnd = addRational(scene.start, scene.duration);
    if (compareRational(start, scene.start) < 0 || compareRational(end, sceneEnd) > 0) fail("CUT_IR_TIMING", path, `lies outside owning scene “${annotation.sceneId}”.`);
  };
  ir.annotations?.markers.forEach((marker, index) => validateAnnotationOwner(marker, `$.annotations.markers[${index}]`, marker.at, marker.at));
  ir.annotations?.regions.forEach((region, index) => validateAnnotationOwner(region, `$.annotations.regions[${index}]`, region.range.start, addRational(region.range.start, region.range.duration)));

  type LinkedOperationOwner = {
    trackId: string;
    trackKind: "picture-track" | "audio-track";
    operationIndex: number;
    operationKind: "trim" | "ripple-insert" | "ripple-delete";
    sourceDuration: Rational;
    path: string;
    keep?: { start: Rational; duration: Rational };
    range?: { start: Rational; duration: Rational };
    transactionVersion?: 1 | 2;
    linkSegmentIds?: { before: string; after: string };
    at?: Rational;
    item?: { kind: string; destination: { start: Rational; duration: Rational }; inputs: unknown };
  };
  const linkedEditIds = new Set((ir.linkedEdits ?? []).map((edit) => edit.id));
  const linkedOperationOwners = new Map<string, LinkedOperationOwner[]>();
  for (const [trackId, track] of Object.entries(ir.nodes)) {
    if (!track.editorial || (track.editorial.kind !== "picture-track" && track.editorial.kind !== "audio-track") || !track.editorial.operationPlan) continue;
    const trackKind = track.editorial.kind, sourceDuration = track.editorial.operationPlan.sourceDuration;
    track.editorial.operationPlan.operations.forEach((operation, operationIndex) => {
      if (!("transactionId" in operation) || !operation.transactionId) return;
      const operationPath = `${childPath("$.nodes", trackId)}.editorial.operationPlan.operations[${operationIndex}]`;
      if (!linkedEditIds.has(operation.transactionId)) fail("CUT_IR_REFERENCE", `${operationPath}.transactionId`, `references missing linked-edit transaction “${operation.transactionId}”.`);
      if (operation.kind !== "trim" && operation.kind !== "ripple-insert" && operation.kind !== "ripple-delete") {
        fail("CUT_IR_IDENTITY", `${operationPath}.transactionId`, "correlated transaction metadata is not allowed on this operation kind.");
      }
      const owners = linkedOperationOwners.get(operation.transactionId) ?? [];
      owners.push({
        trackId,
        trackKind,
        operationIndex,
        operationKind: operation.kind,
        sourceDuration,
        path: operationPath,
        ...(operation.kind === "trim" ? { keep: operation.keep } : {}),
        ...(operation.kind === "ripple-delete" ? { range: operation.range, ...(operation.transactionVersion ? { transactionVersion: operation.transactionVersion } : {}), ...(operation.linkSegmentIds ? { linkSegmentIds: operation.linkSegmentIds } : {}) } : {}),
        ...(operation.kind === "ripple-insert" ? { at: operation.at, item: operation.item } : {}),
      });
      linkedOperationOwners.set(operation.transactionId, owners);
    });
  }
  const sameInterval = (left: { start: Rational; duration: Rational }, right: { start: Rational; duration: Rational }) => compareRational(left.start, right.start) === 0 && compareRational(left.duration, right.duration) === 0;
  const linkedScopes = new Set<string>();
  (ir.linkedEdits ?? []).forEach((edit, index) => {
    const path = `$.linkedEdits[${index}]`;
    const composition = compositions.get(edit.compositionId);
    if (!composition) fail("CUT_IR_REFERENCE", `${path}.compositionId`, `references missing composition “${edit.compositionId}”.`);
    const scene = ir.scenes[edit.sceneId];
    if (!scene) fail("CUT_IR_REFERENCE", `${path}.sceneId`, `references missing scene “${edit.sceneId}”.`);
    if (sceneOwners.get(edit.sceneId) !== edit.compositionId) fail("CUT_IR_IDENTITY", `${path}.sceneId`, `does not belong to composition “${edit.compositionId}”.`);
    const scope = `${edit.compositionId}\0${edit.sceneId}\0${edit.linkId}`;
    if (linkedScopes.has(scope)) fail("CUT_IR_IDENTITY", `${path}.linkId`, "duplicates a linked-edit scope in the same scene.");
    linkedScopes.add(scope);
    const intervalName = edit.kind === "linked-trim" ? "keep" : "range", interval = edit.kind === "linked-trim" ? edit.keep : edit.range;
    const intervalEnd = addRational(interval.start, interval.duration);
    if (compareRational(intervalEnd, scene.duration) > 0) fail("CUT_IR_TIMING", `${path}.${intervalName}`, "exceeds its owning scene-local duration.");
    const absoluteStart = addRational(scene.start, interval.start), absoluteEnd = addRational(scene.start, intervalEnd);
    if (multiplyRational(absoluteStart, composition.fps).denominator !== "1" || multiplyRational(absoluteEnd, composition.fps).denominator !== "1") {
      fail("CUT_IR_TIMING", `${path}.${intervalName}`, "endpoints do not land on the owning picture-frame grid.");
    }
    if (multiplyRational(absoluteStart, rational(composition.sampleRate)).denominator !== "1" || multiplyRational(absoluteEnd, rational(composition.sampleRate)).denominator !== "1") {
      fail("CUT_IR_TIMING", `${path}.${intervalName}`, "endpoints do not land on the owning audio-sample grid.");
    }
    const pictureTrack = ir.nodes[edit.pictureTrackId], audioTrack = ir.nodes[edit.audioTrackId];
    if (!pictureTrack) fail("CUT_IR_REFERENCE", `${path}.pictureTrackId`, `references missing node “${edit.pictureTrackId}”.`);
    if (!audioTrack) fail("CUT_IR_REFERENCE", `${path}.audioTrackId`, `references missing node “${edit.audioTrackId}”.`);
    if (pictureTrack.sceneId !== edit.sceneId || pictureTrack.editorial?.kind !== "picture-track") fail("CUT_IR_TYPE", `${path}.pictureTrackId`, "must reference a picture track in the transaction scene.");
    if (audioTrack.sceneId !== edit.sceneId || audioTrack.editorial?.kind !== "audio-track") fail("CUT_IR_TYPE", `${path}.audioTrackId`, "must reference an audio track in the transaction scene.");
    const owners = linkedOperationOwners.get(edit.id) ?? [];

    const pictureMembers: Array<{ trackId: string; path: string; item: Extract<NonNullable<IRNode["editorial"]>, { kind: "picture-track" }>["items"][number] }> = [];
    const audioMembers: Array<{ trackId: string; path: string; item: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }>["items"][number] }> = [];
    for (const [trackId, candidate] of Object.entries(ir.nodes)) {
      if (candidate.sceneId !== edit.sceneId || !candidate.editorial) continue;
      if (candidate.editorial.kind === "picture-track") {
        candidate.editorial.items.forEach((item, itemIndex) => {
          if (item.linkId === edit.linkId) pictureMembers.push({ trackId, path: `${childPath("$.nodes", trackId)}.editorial.items[${itemIndex}]`, item });
        });
      } else if (candidate.editorial.kind === "audio-track") {
        candidate.editorial.items.forEach((item, itemIndex) => {
          if (item.linkId === edit.linkId) audioMembers.push({ trackId, path: `${childPath("$.nodes", trackId)}.editorial.items[${itemIndex}]`, item });
        });
      }
    }

    if (edit.kind === "linked-trim") {
      if (owners.length !== 2
        || owners.filter((owner) => owner.operationKind === "trim" && owner.trackKind === "picture-track" && owner.trackId === edit.pictureTrackId).length !== 1
        || owners.filter((owner) => owner.operationKind === "trim" && owner.trackKind === "audio-track" && owner.trackId === edit.audioTrackId).length !== 1) {
        fail("CUT_IR_IDENTITY", path, "must be backed by exactly one correlated trim operation on its declared picture track and one on its declared audio track.");
      }
      for (const owner of owners) {
        const track = ir.nodes[owner.trackId];
        const expected = { start: subtractRational(edit.keep.start, track.interval.start), duration: edit.keep.duration };
        if (!owner.keep || compareRational(expected.start, zeroRational) < 0 || !sameInterval(owner.keep, expected)) {
          fail("CUT_IR_IDENTITY", `${owner.path}.keep`, "does not equal the transaction keep interval translated into the owning track clock.");
        }
      }
      const sameKeep = (destination: { start: Rational; duration: Rational }) => sameInterval(destination, edit.keep);
      if (pictureMembers.length !== 1 || pictureMembers[0].trackId !== edit.pictureTrackId || pictureMembers[0].item.kind !== "picture" || !sameKeep(pictureMembers[0].item.destination)) {
        fail("CUT_IR_IDENTITY", `${path}.pictureTrackId`, "the transaction scene must retain exactly one linked picture item, on the declared track at keep.");
      }
      if (audioMembers.length !== 1 || audioMembers[0].trackId !== edit.audioTrackId || audioMembers[0].item.kind !== "audio" || !sameKeep(audioMembers[0].item.destination)) {
        fail("CUT_IR_IDENTITY", `${path}.audioTrackId`, "the transaction scene must retain exactly one linked audio item, on the declared track at keep.");
      }
      const pictureNode = ir.nodes[pictureMembers[0].item.nodeId], audioNode = ir.nodes[audioMembers[0].item.nodeId];
      if (pictureNode?.inputs.link?.kind !== "string" || pictureNode.inputs.link.value !== edit.linkId) fail("CUT_IR_IDENTITY", `${path}.pictureTrackId`, "materialized picture child must preserve the authored link input.");
      if (audioNode?.inputs.link?.kind !== "string" || audioNode.inputs.link.value !== edit.linkId) fail("CUT_IR_IDENTITY", `${path}.audioTrackId`, "materialized audio child must preserve the authored link input.");
      return;
    }

    const pictureOwners = owners.filter((owner) => owner.trackKind === "picture-track" && owner.trackId === edit.pictureTrackId);
    const audioOwners = owners.filter((owner) => owner.trackKind === "audio-track" && owner.trackId === edit.audioTrackId);
    if (owners.length !== 4 || pictureOwners.length !== 2 || audioOwners.length !== 2) {
      fail("CUT_IR_IDENTITY", path, "must be backed by exactly one correlated tail insertion and one correlated ripple deletion on each declared track.");
    }
    const validateRippleOwners = (track: IRNode, trackOwners: LinkedOperationOwner[], trackKind: "picture-track" | "audio-track") => {
      const operationPlan = track.editorial?.kind === trackKind ? track.editorial.operationPlan : undefined;
      if (!operationPlan || operationPlan.operations.length !== 2) fail("CUT_IR_IDENTITY", path, `${trackKind} must contain exactly the two correlated LinkedRippleDelete operations.`);
      const insertion = trackOwners.find((owner) => owner.operationKind === "ripple-insert"), deletion = trackOwners.find((owner) => owner.operationKind === "ripple-delete");
      if (!insertion || !deletion || insertion.operationIndex !== 0 || deletion.operationIndex !== 1) {
        fail("CUT_IR_IDENTITY", path, `${trackKind} must tail-insert first and ripple-delete second with no intervening operation.`);
      }
      if (compareRational(operationPlan.sourceDuration, track.interval.duration) !== 0 || compareRational(insertion.at!, operationPlan.sourceDuration) !== 0) {
        fail("CUT_IR_IDENTITY", `${insertion.path}.at`, "must insert closure at the exact original track end.");
      }
      const expectedRange = { start: subtractRational(edit.range.start, track.interval.start), duration: edit.range.duration };
      if (compareRational(expectedRange.start, zeroRational) < 0 || !deletion.range || !sameInterval(deletion.range, expectedRange)) {
        fail("CUT_IR_IDENTITY", `${deletion.path}.range`, "must equal the transaction range translated into the owning track clock.");
      }
      if (edit.version === 1 && deletion.linkSegmentIds !== undefined) {
        fail("CUT_IR_IDENTITY", `${deletion.path}.linkSegmentIds`, "complete-pair LinkedRippleDelete v1 cannot declare survivor segment identities.");
      }
      if (deletion.transactionVersion !== edit.version) {
        fail("CUT_IR_IDENTITY", `${deletion.path}.transactionVersion`, `must equal owning LinkedRippleDelete transaction version ${edit.version}.`);
      }
      if (edit.version === 2 && (deletion.linkSegmentIds?.before !== edit.linkSegmentIds.before || deletion.linkSegmentIds.after !== edit.linkSegmentIds.after)) {
        fail("CUT_IR_IDENTITY", `${deletion.path}.linkSegmentIds`, "must exactly match the v2 transaction before/after segment identities.");
      }
      if (!insertion.item || insertion.item.kind !== "gap" || compareRational(insertion.item.destination.start, zeroRational) !== 0
        || compareRational(insertion.item.destination.duration, edit.range.duration) !== 0) {
        fail("CUT_IR_IDENTITY", `${insertion.path}.item`, "must be one zero-based explicit gap whose duration equals the deleted range.");
      }
      if (trackKind === "picture-track") {
        const inputs = closed(insertion.item.inputs, `${insertion.path}.item.inputs`, ["duration"]);
        const duration = record(inputs.duration, `${insertion.path}.item.inputs.duration`);
        if (duration.kind !== "quantity" || duration.dimension !== "time" || duration.unit !== "s"
          || compareRational(rationalValue(duration.magnitude, `${insertion.path}.item.inputs.duration.magnitude`, context), edit.range.duration) !== 0) {
          fail("CUT_IR_IDENTITY", `${insertion.path}.item.inputs.duration`, "must encode the exact deleted duration as canonical Time in seconds.");
        }
      } else closed(insertion.item.inputs, `${insertion.path}.item.inputs`, []);
    };
    validateRippleOwners(pictureTrack, pictureOwners, "picture-track");
    validateRippleOwners(audioTrack, audioOwners, "audio-track");
    const pictureBaseMembers = pictureTrack.editorial.operationPlan!.baseItems.filter((item) => item.kind === "picture" && item.inputs.link?.kind === "string" && item.inputs.link.value === edit.linkId);
    const audioBaseMembers = audioTrack.editorial.operationPlan!.baseItems.filter((item) => item.kind === "clip" && item.inputs.linkId === edit.linkId);
    if (pictureBaseMembers.length !== 1) fail("CUT_IR_IDENTITY", `${path}.pictureTrackId`, "the declared picture plan base must contain exactly one linked member.");
    if (audioBaseMembers.length !== 1) fail("CUT_IR_IDENTITY", `${path}.audioTrackId`, "the declared audio plan base must contain exactly one linked member.");
    type LinkedRippleBase = { destination: IREditorialInterval; source: IREditorialInterval; linkSegmentId?: string };
    type LinkedRipplePictureBase = LinkedRippleBase & {
      inputs: Record<string, IRValue>;
      timeMap?: { kind: "constant"; direction: "forward" | "reverse"; rate: Rational } | { kind: "freeze"; at: Rational } | { kind: "speed-ramp"; points: Array<{ at: Rational; rate: Rational }> };
    };
    type LinkedRippleAudioBase = LinkedRippleBase & { inputs: { headHandle?: Rational; tailHandle?: Rational } };
    type LinkedRippleMember = { trackId: string; path: string; item: { nodeId: string; destination: IREditorialInterval; source?: IREditorialInterval; linkSegmentId?: string } };
    const pictureBase = pictureBaseMembers[0] as LinkedRipplePictureBase, audioBase = audioBaseMembers[0] as LinkedRippleAudioBase;
    const expectedPictureBase = { start: subtractRational(edit.range.start, pictureTrack.interval.start), duration: edit.range.duration };
    const expectedAudioBase = { start: subtractRational(edit.range.start, audioTrack.interval.start), duration: edit.range.duration };
    if (edit.version === 1) {
      if (!sameInterval(pictureBase.destination, expectedPictureBase)) fail("CUT_IR_IDENTITY", `${path}.pictureTrackId`, "the declared picture plan base must contain one complete linked member at the transaction range.");
      if (!sameInterval(audioBase.destination, expectedAudioBase)) fail("CUT_IR_IDENTITY", `${path}.audioTrackId`, "the declared audio plan base must contain one complete linked member at the transaction range.");
      if (pictureMembers.length || audioMembers.length) fail("CUT_IR_IDENTITY", path, "a LinkedRippleDelete v1 transaction must leave no materialized picture/audio member carrying the deleted link.");
      const linkedNodes = Object.values(ir.nodes).filter((node) => node.sceneId === edit.sceneId && node.inputs.link?.kind === "string" && node.inputs.link.value === edit.linkId);
      if (linkedNodes.length) fail("CUT_IR_IDENTITY", path, "a LinkedRippleDelete v1 transaction must remove every materialized child node carrying the deleted link.");
      return;
    }

    const derivedSegments = linkedRippleSegmentIds(edit.id);
    if (edit.linkSegmentIds.before !== derivedSegments.before || edit.linkSegmentIds.after !== derivedSegments.after) {
      fail("CUT_IR_IDENTITY", `${path}.linkSegmentIds`, "must equal the compiler-owned deterministic identities derived from the v2 transaction id.");
    }
    const strictlyContains = (container: { start: Rational; duration: Rational }, selected: { start: Rational; duration: Rational }) => {
      const containerEnd = addRational(container.start, container.duration), selectedEnd = addRational(selected.start, selected.duration);
      return compareRational(selected.start, container.start) > 0 && compareRational(selectedEnd, containerEnd) < 0;
    };
    if (!strictlyContains(pictureBase.destination, expectedPictureBase) || pictureBase.linkSegmentId !== undefined) {
      fail("CUT_IR_IDENTITY", `${path}.pictureTrackId`, "v2 range must be strictly inside one unsegmented picture plan-base member.");
    }
    if (!strictlyContains(audioBase.destination, expectedAudioBase) || audioBase.linkSegmentId !== undefined) {
      fail("CUT_IR_IDENTITY", `${path}.audioTrackId`, "v2 range must be strictly inside one unsegmented audio plan-base member.");
    }
    const pictureForwardOne = pictureBase.timeMap === undefined
      || (pictureBase.timeMap.kind === "constant"
        && pictureBase.timeMap.direction === "forward"
        && compareRational(pictureBase.timeMap.rate, rational(1)) === 0);
    if (!pictureForwardOne
      || compareRational(pictureBase.source.duration, pictureBase.destination.duration) !== 0
      || !isNeutralLinkedRipplePictureInputs(pictureBase.inputs)) {
      fail("CUT_IR_IDENTITY", `${path}.pictureTrackId`, "v2 picture plan base must be one neutral direct forward-1x PictureClip without transform, opacity, animation, handles, or retime treatment.");
    }
    if (compareRational(audioBase.source.duration, audioBase.destination.duration) !== 0
      || (audioBase.inputs.headHandle !== undefined && compareRational(audioBase.inputs.headHandle, zeroRational) !== 0)
      || (audioBase.inputs.tailHandle !== undefined && compareRational(audioBase.inputs.tailHandle, zeroRational) !== 0)) {
      fail("CUT_IR_IDENTITY", `${path}.audioTrackId`, "v2 audio plan base must be one neutral direct forward-1x AudioClip without handles or retime treatment.");
    }
    const validateSurvivors = (
      track: IRNode,
      base: LinkedRippleBase,
      members: LinkedRippleMember[],
      trackKind: "picture" | "audio",
    ) => {
      if (members.length !== 2 || members.some((member) => member.trackId !== track.id)) {
        fail("CUT_IR_IDENTITY", path, `v2 must materialize exactly two ${trackKind} survivors on its declared track.`);
      }
      const before = members.find((member) => member.item.linkSegmentId === edit.linkSegmentIds.before);
      const after = members.find((member) => member.item.linkSegmentId === edit.linkSegmentIds.after);
      if (!before || !after || before === after) {
        fail("CUT_IR_IDENTITY", `${members[1]?.path ?? members[0]?.path ?? path}.linkSegmentId`, `v2 ${trackKind} survivors must correlate one before and one after segment identity.`);
      }
      const absoluteBaseStart = addRational(track.interval.start, base.destination.start);
      const originalRangeEnd = addRational(edit.range.start, edit.range.duration);
      const beforeDuration = subtractRational(edit.range.start, absoluteBaseStart);
      const absoluteBaseEnd = addRational(absoluteBaseStart, base.destination.duration);
      const afterDuration = subtractRational(absoluteBaseEnd, originalRangeEnd);
      const beforeSource = { start: base.source!.start, duration: beforeDuration };
      const afterSource = { start: addRational(base.source!.start, subtractRational(originalRangeEnd, absoluteBaseStart)), duration: afterDuration };
      const beforeExpected = { start: absoluteBaseStart, duration: beforeDuration };
      const afterExpected = { start: edit.range.start, duration: afterDuration };
      if (!sameInterval(before.item.destination, beforeExpected) || !before.item.source || !sameInterval(before.item.source, beforeSource)) {
        fail("CUT_IR_IDENTITY", before.path, `v2 ${trackKind} before survivor timing/source does not match the authorized split.`);
      }
      if (!sameInterval(after.item.destination, afterExpected) || !after.item.source || !sameInterval(after.item.source, afterSource)) {
        fail("CUT_IR_IDENTITY", after.path, `v2 ${trackKind} after survivor timing/source does not match the authorized split and ripple.`);
      }
      for (const member of [before, after]) {
        const node = ir.nodes[member.item.nodeId];
        if (node?.inputs.link?.kind !== "string" || node.inputs.link.value !== edit.linkId) {
          fail("CUT_IR_IDENTITY", `${childPath("$.nodes", member.item.nodeId)}.inputs.link`, `v2 ${trackKind} survivor child must preserve the authored group link input.`);
        }
        if (trackKind === "picture" && node
          && (!isNeutralLinkedRipplePictureInputs(node.inputs) || Object.keys(node.properties).length !== 0)) {
          fail("CUT_IR_IDENTITY", childPath("$.nodes", member.item.nodeId), "v2 picture survivor children must remain neutral direct PictureClips without transform, opacity, or animation treatment.");
        }
      }
    };
    validateSurvivors(pictureTrack, pictureBase, pictureMembers, "picture");
    validateSurvivors(audioTrack, audioBase, audioMembers, "audio");
  });

  type SegmentOwner = {
    edit: Extract<NonNullable<CutAVIR["linkedEdits"]>[number], { kind: "linked-ripple-delete"; version: 2 }>;
    editIndex: number;
    role: "before" | "after";
  };
  const segmentOwners = new Map<string, SegmentOwner>();
  for (const [editIndex, edit] of (ir.linkedEdits ?? []).entries()) {
    if (edit.kind !== "linked-ripple-delete" || edit.version !== 2) continue;
    for (const role of ["before", "after"] as const) {
      const segmentId = edit.linkSegmentIds[role], existing = segmentOwners.get(segmentId);
      if (existing) {
        fail("CUT_IR_IDENTITY", `$.linkedEdits[${editIndex}].linkSegmentIds.${role}`, `reuses compiler-owned segment id from linkedEdits[${existing.editIndex}].`);
      }
      segmentOwners.set(segmentId, { edit, editIndex, role });
    }
  }
  const segmentOccurrences = new Map<string, Array<{ trackId: string; trackKind: "picture-track" | "audio-track"; path: string }>>();
  for (const [trackId, track] of Object.entries(ir.nodes)) {
    if (!track.editorial || (track.editorial.kind !== "picture-track" && track.editorial.kind !== "audio-track")) continue;
    const trackPath = childPath("$.nodes", trackId), trackKind = track.editorial.kind;
    const plan = track.editorial.operationPlan;
    if (plan) {
      for (const [itemIndex, item] of plan.baseItems.entries()) {
        if ("linkSegmentId" in item && item.linkSegmentId !== undefined) {
          fail("CUT_IR_IDENTITY", `${trackPath}.editorial.operationPlan.baseItems[${itemIndex}].linkSegmentId`, "compiler-owned survivor segment identity cannot appear on a pre-transaction plan-base item.");
        }
      }
      for (const [operationIndex, operation] of plan.operations.entries()) {
        if ("item" in operation && "linkSegmentId" in operation.item && operation.item.linkSegmentId !== undefined) {
          fail("CUT_IR_IDENTITY", `${trackPath}.editorial.operationPlan.operations[${operationIndex}].item.linkSegmentId`, "compiler-owned survivor segment identity cannot be injected through an operation item.");
        }
      }
    }
    for (const [itemIndex, item] of track.editorial.items.entries()) {
      if (!("linkSegmentId" in item) || item.linkSegmentId === undefined) continue;
      const itemPath = `${trackPath}.editorial.items[${itemIndex}]`, owner = segmentOwners.get(item.linkSegmentId);
      if (!owner) fail("CUT_IR_IDENTITY", `${itemPath}.linkSegmentId`, "is orphaned: no v2 LinkedRippleDelete transaction owns this compiler-reserved segment id.");
      const expectedTrackId = trackKind === "picture-track" ? owner.edit.pictureTrackId : owner.edit.audioTrackId;
      if (track.sceneId !== owner.edit.sceneId || item.linkId !== owner.edit.linkId || trackId !== expectedTrackId) {
        fail("CUT_IR_IDENTITY", `${itemPath}.linkSegmentId`, `does not belong to its owning transaction's scene, link group, and declared ${trackKind}.`);
      }
      const occurrences = segmentOccurrences.get(item.linkSegmentId) ?? [];
      occurrences.push({ trackId, trackKind, path: itemPath });
      segmentOccurrences.set(item.linkSegmentId, occurrences);
    }
  }
  for (const [segmentId, owner] of segmentOwners) {
    const occurrences = segmentOccurrences.get(segmentId) ?? [];
    if (occurrences.length !== 2
      || occurrences.filter((entry) => entry.trackKind === "picture-track" && entry.trackId === owner.edit.pictureTrackId).length !== 1
      || occurrences.filter((entry) => entry.trackKind === "audio-track" && entry.trackId === owner.edit.audioTrackId).length !== 1) {
      fail("CUT_IR_IDENTITY", `$.linkedEdits[${owner.editIndex}].linkSegmentIds.${owner.role}`, "must own exactly one picture and one audio survivor on the declared tracks, with no reuse in another group.");
    }
  }
  for (const sceneId of Object.keys(ir.scenes)) if (!sceneOwners.has(sceneId)) fail("CUT_IR_IDENTITY", childPath("$.scenes", sceneId), "is not owned by any composition.");

  for (const [sceneId, scene] of Object.entries(ir.scenes)) {
    const path = childPath("$.scenes", sceneId); assertRootLists(scene, scene.items, path);
    scene.items.forEach((item, index) => {
      const itemPath = `${path}.items[${index}]`; const node = ir.nodes[item.id]; if (!node) fail("CUT_IR_REFERENCE", `${itemPath}.id`, `references missing node “${item.id}”.`);
      markRoot(item.id, `${itemPath}.id`); if (node.domain !== item.domain) fail("CUT_IR_IDENTITY", `${itemPath}.domain`, `does not match node ${item.id}.domain.`); if (node.sceneId !== scene.id) fail("CUT_IR_IDENTITY", `${itemPath}.id`, `node ${item.id} does not belong to scene ${scene.id}.`);
    });
  }

  const childIncoming = new Map<string, number>();
  const directParents = new Map<string, IRNode[]>();
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    if (node.sceneId && !Object.hasOwn(ir.scenes, node.sceneId)) fail("CUT_IR_REFERENCE", `${childPath("$.nodes", nodeId)}.sceneId`, `references missing scene “${node.sceneId}”.`);
    if (node.sceneId) {
      const scene = ir.scenes[node.sceneId];
      if (compareRational(addRational(node.interval.start, node.interval.duration), scene.duration) > 0) {
        fail("CUT_IR_TIMING", `${childPath("$.nodes", nodeId)}.interval`, `node interval exceeds its owning scene “${node.sceneId}”.`);
      }
    }
    node.children.forEach((childId, index) => {
      const child = ir.nodes[childId]; const path = `${childPath("$.nodes", nodeId)}.children[${index}]`; if (!child) fail("CUT_IR_REFERENCE", path, `references missing node “${childId}”.`);
      childIncoming.set(childId, (childIncoming.get(childId) ?? 0) + 1);
      const parents = directParents.get(childId) ?? []; parents.push(node); directParents.set(childId, parents);
      if (child.sceneId !== node.sceneId) fail("CUT_IR_IDENTITY", path, "parent and child nodes belong to different scene clocks.");
    });
  }
  const responsiveAnnotatedFragments = validateResponsiveAnnotatedFragmentContracts(ir, directParents);
  validateCalloutGraphContracts(ir, directParents, responsiveAnnotatedFragments);
  const referenceIncoming = new Map<string, number>();
  for (const targets of context.nodeReferenceEdges.values()) for (const id of targets) referenceIncoming.set(id, (referenceIncoming.get(id) ?? 0) + 1);
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const path = childPath("$.nodes", nodeId), roots = rootMembership.get(nodeId) ?? 0, parents = childIncoming.get(nodeId) ?? 0, references = referenceIncoming.get(nodeId) ?? 0;
    if (node.ownership === "root" && (roots !== 1 || parents !== 0)) fail("CUT_IR_IDENTITY", `${path}.ownership`, "root node must appear in exactly one owner and cannot be a child.");
    if (node.ownership === "child" && (parents < 1 || roots !== 0)) fail("CUT_IR_IDENTITY", `${path}.ownership`, "child node must have a parent and cannot be a root.");
    if (node.ownership === "reference" && (references < 1 || parents !== 0 || roots !== 0)) fail("CUT_IR_IDENTITY", `${path}.ownership`, "reference node must be reached by node-ref only.");
    if (node.ownership === "detached" && (parents !== 0 || roots !== 0 || references !== 0)) fail("CUT_IR_IDENTITY", `${path}.ownership`, "detached node cannot participate in the graph.");
  }

  const adjacency = new Map<string, string[]>();
  for (const [nodeId, node] of Object.entries(ir.nodes)) adjacency.set(nodeId, [...node.children, ...(context.nodeReferenceEdges.get(nodeId) ?? [])]);
  const visiting = new Set<string>(), finished = new Set<string>(), stack: string[] = [];
  const visit = (id: string) => {
    if (finished.has(id)) return;
    if (visiting.has(id)) { const start = stack.indexOf(id); fail("CUT_IR_CYCLE", childPath("$.nodes", id), `graph cycle: ${[...stack.slice(start), id].join(" -> ")}.`); }
    if (stack.length >= context.limits.maxGraphDepth) fail("CUT_IR_LIMIT", childPath("$.nodes", id), `graph exceeds maxGraphDepth (${context.limits.maxGraphDepth}).`);
    visiting.add(id); stack.push(id); for (const next of adjacency.get(id) ?? []) visit(next); stack.pop(); visiting.delete(id); finished.add(id);
  };
  Object.keys(ir.nodes).forEach(visit);
  validateLocalSpaceGraphContracts(ir, directParents);
  for (const composition of ir.compositions) {
    const selected = new Set(Object.values(ir.nodes).filter((node) => node.sceneId
      ? composition.sceneIds.includes(node.sceneId)
      : composition.items.some((item) => item.kind === "node" && item.id === node.id)).map((node) => node.id));
    try { validateReferenceCamera3DGraph(ir, composition, selected); }
    catch (error) {
      if (!(error instanceof ReferenceCamera3DError)) throw error;
      fail(error.code, childPath("$.nodes", error.node.id), error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), ""));
    }
  }
  validateMapCameraGraphContracts(ir, directParents);
  validateGeoAnnotationGraphContracts(ir, directParents, sceneOwners, compositions);
  try {
    validateCutDiagramLanguageIR(ir);
  } catch (error) {
    if (!(error instanceof CutDiagramContractError)) throw error;
    const prefix = `${error.code}: `;
    fail(
      error.code,
      error.path,
      error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
    );
  }
  try {
    // MediaCamera2D owns its compiler-derived ResponsiveSlot context contract.
    // Validate it before the aggregate responsive runtime graph so a missing,
    // transplanted, or re-signed camera context fails at its exact typed input
    // rather than being reported later as a generic descendant error.
    validateCutMediaCamera2DLanguageIR(ir);
  } catch (error) {
    if (!(error instanceof CutMediaCamera2DContractError)) throw error;
    const prefix = `${error.code}: `;
    fail(
      error.code,
      error.path,
      error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
    );
  }
  for (const composition of ir.compositions) {
    const selected = new Set(Object.values(ir.nodes).filter((node) => node.sceneId
      ? composition.sceneIds.includes(node.sceneId)
      : composition.items.some((item) => item.kind === "node" && item.id === node.id)).map((node) => node.id));
    for (const fragmentId of responsiveAnnotatedFragments.keys()) selected.delete(fragmentId);
    try { validateReferenceResponsiveStackGraph(ir, composition, selected); }
    catch (error) {
      if (!(error instanceof ReferenceResponsiveStackError)) throw error;
      const prefix = `${error.code}: `;
      fail(
        error.code,
        childPath("$.nodes", error.source.nodeId),
        error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
      );
    }
    try {
      validateReferenceTempoDelayPlans(ir, composition, referenceAudioCompositionRootIds(ir, composition));
    } catch (error) {
      if (!(error instanceof ReferenceTempoDelayConfigError)) throw error;
      const prefix = `${error.code}: `;
      fail(
        error.code,
        childPath("$.nodes", error.source.nodeId),
        error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
      );
    }
  }

  const signalIncoming = new Map<string, number>(); for (const reference of context.signalReferences) signalIncoming.set(reference.id, (signalIncoming.get(reference.id) ?? 0) + 1);
  for (const [signalId, signal] of Object.entries(ir.signals)) if (!signalIncoming.has(signalId)) {
    const path = childPath("$.signals", signalId);
    if (signal.kind === "track" && signal.producer) fail("CUT_AUDIO_REACTIVE_TARGET", path, "producer signal is not attached to any executable Group property.");
    fail("CUT_IR_IDENTITY", path, "is not attached to any node property.");
  }
  const signalAttachments = new Map<string, Array<{ nodeId: string; node: IRNode; property: string; expected?: KernelPropertyValueType }>>();
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const schema = referenceKernelSchema(node.op);
    for (const [property, value] of Object.entries(node.properties)) {
      if (!("signal" in value)) continue;
      const expected = schema?.support === "supported" ? kernelPropertyValueType(schema, property) : undefined;
      const attachments = signalAttachments.get(value.signal) ?? [];
      attachments.push({ nodeId, node, property, ...(expected ? { expected } : {}) });
      signalAttachments.set(value.signal, attachments);
    }
  }
  const audioReactiveCounts = new Map<string, number>();
  for (const [signalId, signal] of Object.entries(ir.signals)) {
    const signalPath = childPath("$.signals", signalId);
    const attachments = signalAttachments.get(signalId) ?? [];
    if (signal.kind === "track" && signal.producer && attachments.length > 256) fail("CUT_AUDIO_REACTIVE_RESOURCE", signalPath, "producer signal exceeds 256 property attachments.");
    const derivedTypes = new Set(attachments.flatMap((attachment) => attachment.expected ? [attachment.expected] : []));
    const hasUnresolvedAttachment = attachments.some((attachment) => attachment.expected === undefined);
    for (const { nodeId, node, property, expected } of attachments) {
      if (!expected || signal.valueType === expected) continue;
      // Archived 0.3 graphs predate typed property tracks. Legacy mode derives
      // the payload type below, but only from one unambiguous closed property.
      if (identityMode === "legacy-0.3-compatible" && signal.valueType === "inferred") continue;
      fail(
        signal.kind === "track" && signal.producer ? "CUT_AUDIO_REACTIVE_TYPE" : "CUT_IR_TYPE",
        `${signalPath}.valueType`,
        `must be ${expected} for ${node.op}.${property} attached at ${childPath("$.nodes", nodeId)}.properties.${property}; received ${JSON.stringify(signal.valueType)}.`,
      );
    }
    let payloadType: KernelPropertyValueType;
    if (signal.valueType === "inferred") {
      if (identityMode !== "legacy-0.3-compatible") {
        fail("CUT_IR_TYPE", `${signalPath}.valueType`, "inferred is valid only for a legacy signal attached unambiguously to one closed kernel property type.");
      }
      // Ambiguous archived attachments are intentionally left to the migration
      // policy, which refuses them with CUT_MIGRATE_SIGNAL_TYPE_AMBIGUOUS. A
      // unique archived attachment is type-checkable now and must not be
      // relabeled around a malformed payload.
      if (hasUnresolvedAttachment || derivedTypes.size !== 1) continue;
      payloadType = [...derivedTypes][0]!;
    } else if (isKernelPropertyValueType(signal.valueType)) payloadType = signal.valueType;
    else fail(signal.kind === "track" && signal.producer ? "CUT_AUDIO_REACTIVE_TYPE" : "CUT_IR_TYPE", `${signalPath}.valueType`, `must be one of: ${Object.keys(signalQuantityContract).join(", ")}.`);

    const nullBaselineIsDerived = signal.kind === "track"
      && attachments.length > 0
      && !hasUnresolvedAttachment
      && derivedTypes.size === 1
      && derivedTypes.has(payloadType);
    validateTypedSignalPayload(signal, payloadType, signalPath, nullBaselineIsDerived);
    if (signal.kind === "track" && signal.producer) {
      const producer = signal.producer, producerPath = `${signalPath}.producer`;
      const composition = compositions.get(producer.scope.compositionId);
      if (!composition) fail("CUT_AUDIO_REACTIVE_SCOPE", `${producerPath}.scope.compositionId`, `references missing composition ${JSON.stringify(producer.scope.compositionId)}.`);
      const scene = ir.scenes[producer.scope.sceneId];
      if (!scene) fail("CUT_AUDIO_REACTIVE_SCOPE", `${producerPath}.scope.sceneId`, `references missing scene ${JSON.stringify(producer.scope.sceneId)}.`);
      if (sceneOwners.get(scene.id) !== composition.id) fail("CUT_AUDIO_REACTIVE_SCOPE", `${producerPath}.scope`, "sceneId must belong to compositionId.");
      const resource = ir.resources[producer.source.id];
      if (!resource || resource.kind !== "audio") fail("CUT_AUDIO_REACTIVE_RESOURCE", `${producerPath}.source.id`, "must reference one AudioAsset resource.");
      if (composition.sampleRate < 8_000 || composition.sampleRate > 192_000) {
        fail("CUT_AUDIO_REACTIVE_TIME", `${producerPath}.scope.compositionId`, "composition sampleRate must be from 8000 through 192000 Hz for amplitude analysis.");
      }
      const selectedDuration = subtractRational(producer.range.end, producer.range.start);
      if (compareRational(addRational(producer.at, selectedDuration), scene.duration) > 0) {
        fail("CUT_AUDIO_REACTIVE_TIME", `${producerPath}.at`, "scene-local at plus selected source duration exceeds the producer scene.");
      }
      const gridValues = [
        ["range.start", producer.range.start], ["range.end", producer.range.end],
        ["at", addRational(scene.start, producer.at)], ["window", producer.window],
        ["hop", producer.hop], ["attack", producer.attack], ["release", producer.release],
      ] as const;
      const frameValue = (label: string, value: Rational) => {
        const frames = multiplyRational(value, rational(composition.sampleRate));
        if (frames.denominator !== "1") fail("CUT_AUDIO_REACTIVE_TIME", `${producerPath}.${label}`, `must land exactly on the ${composition.sampleRate} Hz composition sample grid.`);
        const integer = BigInt(frames.numerator);
        if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) fail("CUT_AUDIO_REACTIVE_RANGE", `${producerPath}.${label}`, "has an unsafe sample-frame index.");
        return integer;
      };
      for (const [label, value] of gridValues) frameValue(label, value);
      const rangeStartFrames = frameValue("range.start", producer.range.start);
      const rangeEndFrames = frameValue("range.end", producer.range.end);
      const rangeFrames = rangeEndFrames - rangeStartFrames;
      const windowFrames = frameValue("window", producer.window);
      const hopFrames = frameValue("hop", producer.hop);
      if (rangeFrames > 28_800_000n) fail("CUT_AUDIO_REACTIVE_RESOURCE", `${producerPath}.range`, "exceeds maxInputFrames=28800000.");
      const windowCount = (rangeFrames - 1n - windowFrames) / hopFrames + 1n;
      if (windowCount < 1n) fail("CUT_AUDIO_REACTIVE_NOOP", `${producerPath}.range`, "must contain at least one full causal window ending before its exclusive end.");
      if (windowCount > 131_072n) fail("CUT_AUDIO_REACTIVE_RESOURCE", producerPath, "exceeds maximumOutputWindows=131072.");
      if (windowCount * windowFrames * 2n > 268_435_456n) fail("CUT_AUDIO_REACTIVE_RESOURCE", producerPath, "exceeds maximumDetectorChannelSamples=268435456.");
      const count = (audioReactiveCounts.get(composition.id) ?? 0) + 1;
      audioReactiveCounts.set(composition.id, count);
      if (count > 32) fail("CUT_AUDIO_REACTIVE_RESOURCE", producerPath, `composition ${JSON.stringify(composition.id)} exceeds 32 audio-reactive producer tracks.`);
      for (const { nodeId, node, property, expected } of attachments) {
        if (node.op !== "cut.visual.group" || node.domain !== "visual" || node.sceneId !== scene.id
          || node.ownership !== "root" || !scene.items.some((item) => item.id === node.id && item.domain === "visual")
          || !["x", "y", "scale", "rotation", "opacity"].includes(property)) {
          fail("CUT_AUDIO_REACTIVE_TARGET", `${childPath("$.nodes", nodeId)}.properties.${property}`, "producer tracks may initially attach only to Group x, y, scale, rotation, or opacity in their declared scene.");
        }
        if (expected !== payloadType) fail("CUT_AUDIO_REACTIVE_TYPE", `${signalPath}.valueType`, `does not match Group.${property}.`);
        const baseline = node.inputs[property];
        if (baseline && stableJsonStringify(baseline) !== stableJsonStringify(producer.mapping.from)) {
          fail("CUT_AUDIO_REACTIVE_BASELINE", `${childPath("$.nodes", nodeId)}.inputs.${property}`, "must equal producer.mapping.from or be omitted.");
        }
      }
      const from = producer.mapping.from, to = producer.mapping.to;
      if (from.kind !== "quantity" || to.kind !== "quantity") fail("CUT_AUDIO_REACTIVE_TYPE", `${producerPath}.mapping`, "endpoints must be canonical typed quantities.");
      const endpoints = [from.magnitude, to.magnitude];
      const outside = (minimum: Rational, maximum: Rational) => endpoints.some((value) => compareRational(value, minimum) < 0 || compareRational(value, maximum) > 0);
      if ((attachments[0]?.property === "x" || attachments[0]?.property === "y") && outside(rational(-65_536), rational(65_536))) fail("CUT_AUDIO_REACTIVE_BASELINE", `${producerPath}.mapping`, "x/y endpoints must remain from -65536px through 65536px.");
      if (attachments[0]?.property === "rotation" && outside(rational(-360_000), rational(360_000))) fail("CUT_AUDIO_REACTIVE_BASELINE", `${producerPath}.mapping`, "rotation endpoints must remain from -360000deg through 360000deg.");
      if (attachments[0]?.property === "opacity" && outside(zeroRational, rational(1))) fail("CUT_AUDIO_REACTIVE_BASELINE", `${producerPath}.mapping`, "opacity endpoints must remain from 0 through 1.");
      if (attachments[0]?.property === "scale") {
        const maximum = Math.max(0.001, Math.min(8, 16_384 / composition.width, 16_384 / composition.height, Math.sqrt(67_108_864 / (composition.width * composition.height))));
        if (endpoints.some((value) => {
          const numerator = Number(value.numerator), denominator = Number(value.denominator), number = numerator / denominator;
          return !Number.isFinite(number) || number < 0.001 || number > maximum;
        })) fail("CUT_AUDIO_REACTIVE_BASELINE", `${producerPath}.mapping`, `scale endpoints must remain from 0.001 through ${maximum} for this composition.`);
      }
    }
  }
}

function audioRegionInputInterval(value: IRValue | undefined) {
  if (value?.kind !== "range" || !value.exclusive
    || value.start.kind !== "quantity" || value.start.dimension !== "time" || value.start.unit !== "s"
    || value.end.kind !== "quantity" || value.end.dimension !== "time" || value.end.unit !== "s") return undefined;
  return { start: value.start.magnitude, duration: subtractRational(value.end.magnitude, value.start.magnitude) };
}

function audioRegionInputTime(value: IRValue | undefined) {
  return value?.kind === "quantity" && value.dimension === "time" && value.unit === "s" ? value.magnitude : undefined;
}

function sameAudioRegionInterval(left: IREditorialInterval | undefined, right: IREditorialInterval | undefined) {
  return Boolean(left && right && compareRational(left.start, right.start) === 0 && compareRational(left.duration, right.duration) === 0);
}

/** Close the track-integrated TimeStretch projection without trusting runtime-only ancestry. */
function validateAudioRegionRetimeCoherence(ir: CutAVIR) {
  for (const [regionId, region] of Object.entries(ir.nodes)) {
    if (region.op !== "cut.edit.audio_region") continue;
    const path = childPath("$.nodes", regionId), chain: IRNode[] = [];
    let current = region.children.length === 1 ? ir.nodes[region.children[0]] : undefined;
    const visited = new Set<string>();
    while (current && !visited.has(current.id) && chain.length <= 33) {
      visited.add(current.id); chain.push(current);
      if (current.op === "cut.audio.clip") break;
      current = current.children.length === 1 ? ir.nodes[current.children[0]] : undefined;
    }
    const stretches = chain.filter((node) => node.op === "cut.audio.time_stretch");
    if (!stretches.length) continue;
    if (stretches.length !== 1 || !current || current.op !== "cut.audio.clip" || current.children.length !== 0) {
      fail("CUT_IR_IDENTITY", `${path}.children`, "AudioRegion retime must contain exactly one TimeStretch in one finite unary chain ending in AudioClip.");
    }
    const stretch = stretches[0], leaf = current;
    for (const node of chain) {
      if (!sameAudioRegionInterval(node.interval, region.interval) || node.sceneId !== region.sceneId) {
        fail("CUT_IR_IDENTITY", childPath("$.nodes", node.id), "AudioRegion retime descendants must share the outer destination interval and scene.");
      }
      if (Object.keys(node.properties).length) {
        fail("CUT_IR_IDENTITY", `${childPath("$.nodes", node.id)}.properties`, "AudioRegion retime chains must be static.");
      }
    }
    const parents = Object.values(ir.nodes).filter((node) => node.children.includes(region.id));
    const origin = parents.length === 1 && parents[0].op === cutTimelineAudioOriginOp
      ? parents[0]
      : undefined;
    const ordinaryTrack = parents.length === 1 && parents[0].op === "cut.edit.audio_track"
      ? parents[0]
      : undefined;
    const timelineViews = origin
      ? Object.values(ir.nodes).filter((node) =>
          node.op === cutTimelineAudioViewOp
          && node.inputs.origin?.kind === "node-ref"
          && node.inputs.origin.id === origin.id)
      : [];
    const timelineTracks = origin
      ? [...new Set(timelineViews.flatMap((view) =>
          Object.values(ir.nodes)
            .filter((node) =>
              node.op === "cut.edit.audio_track"
              && node.children.includes(view.id))
            .map((node) => node.id)))]
          .map((id) => ir.nodes[id]!)
      : [];
    const track = ordinaryTrack ?? (timelineTracks.length === 1 ? timelineTracks[0] : undefined);
    if (!track || track.editorial?.kind !== "audio-track" || Object.keys(track.inputs).length
      || track.editorial.operationPlan !== undefined
      || (origin === undefined && track.editorial.transitions !== undefined)
      || ir.linkedEdits?.some((transaction) => transaction.audioTrackId === track.id)
      || (origin !== undefined && (!timelineViews.length
        || origin.ownership !== "reference"
        || origin.children.length !== 1
        || origin.children[0] !== region.id
        || timelineViews.some((view) => !track.children.includes(view.id))))) {
      fail(
        "CUT_IR_IDENTITY",
        path,
        "AudioRegion retime requires either one ordinary AudioTrack parent or one authenticated TimelineEdit origin/view track and cannot participate in crossfades or linked transactions.",
      );
    }
    if (origin === undefined
      && (region.inputs.headHandle !== undefined || region.inputs.tailHandle !== undefined)) {
      fail("CUT_IR_IDENTITY", `${path}.inputs`, "ordinary AudioRegion retime cannot declare headHandle/tailHandle; source-clock handles require one authenticated TimelineEdit origin/view.");
    }
    const items = origin
      ? track.editorial.items.filter((item) =>
          timelineViews.some((view) => view.id === item.nodeId))
      : track.editorial.items.filter((item) => item.nodeId === region.id);
    const sourceRange = audioRegionInputInterval(leaf.inputs.range);
    const sourceDuration = audioRegionInputTime(stretch.inputs.sourceDuration);
    const destinationDuration = audioRegionInputTime(stretch.inputs.duration);
    const itemBindings = origin
      ? items.length === timelineViews.length
        && items.every((item) => {
          const view = timelineViews.find((candidate) => candidate.id === item.nodeId);
          return item.sourceNodeId === leaf.id
            && view !== undefined
            && sameAudioRegionInterval(
              item.source,
              timelineAudioSourceInput(
                view,
                childPath("$.nodes", view.id),
              ),
            );
        })
      : items.length === 1
        && items[0]!.sourceNodeId === leaf.id
        && sameAudioRegionInterval(items[0]!.source, sourceRange);
    if (!itemBindings || !sourceRange || !sourceDuration || !destinationDuration
      || compareRational(sourceDuration, sourceRange.duration) !== 0
      || compareRational(destinationDuration, region.interval.duration) !== 0) {
      fail("CUT_IR_IDENTITY", childPath("$.nodes", stretch.id), "TimeStretch sourceDuration/duration must exactly reconcile the track item, AudioClip range, and AudioRegion destination.");
    }
  }
}

/** Recompute every v2 range/id projection instead of trusting encoded overlaps. */
function validateAudioRegionCrossfadePlanCoherence(ir: CutAVIR) {
  for (const [trackId, track] of Object.entries(ir.nodes)) {
    if (track.op !== "cut.edit.audio_track" || track.editorial?.kind !== "audio-track" || track.editorial.operationPlan?.version !== 2) continue;
    const path = `${childPath("$.nodes", trackId)}.editorial`;
    const plan = track.editorial.operationPlan as AudioEditOperationPlanV2;
    if (ir.linkedEdits?.some((transaction) => transaction.audioTrackId === track.id)) {
      fail("CUT_IR_IDENTITY", `${path}.operationPlan`, "version-2 processed AudioRegion crossfades cannot participate in linked-edit transactions.");
    }
    if (plan.baseItems.length !== track.children.length || plan.baseItems.length !== track.editorial.items.length) {
      fail("CUT_IR_IDENTITY", `${path}.operationPlan.baseItems`, "must preserve exactly one plan item per authored AudioRegion child.");
    }
    for (const [index, base] of plan.baseItems.entries()) {
      const basePath = `${path}.operationPlan.baseItems[${index}]`, item = track.editorial.items[index], region = ir.nodes[base.regionId];
      if (!item || item.kind !== "audio" || !item.source || !item.sourceNodeId || item.order !== index
        || item.nodeId !== base.regionId || track.children[index] !== base.regionId
        || !region || region.op !== "cut.edit.audio_region" || region.children.length !== 1) {
        fail("CUT_IR_IDENTITY", basePath, "does not identify its exact authored AudioRegion track item and child.");
      }
      const relativeDestination = { start: subtractRational(item.destination.start, track.interval.start), duration: item.destination.duration };
      if (!sameAudioRegionInterval(base.destination, relativeDestination)
        || !sameAudioRegionInterval(base.destination, audioRegionInputInterval(region.inputs.destination))
        || !sameAudioRegionInterval(base.source, item.source)
        || stableJsonStringify(base.provenance) !== stableJsonStringify(region.provenance)) {
        fail("CUT_IR_IDENTITY", basePath, "destination/source/provenance does not match the authored region and track metadata.");
      }
      const expectedChain = [...base.processorNodeIds, base.sourceNodeId];
      if (region.children[0] !== expectedChain[0]) fail("CUT_IR_IDENTITY", `${basePath}.processorNodeIds`, "does not begin at the AudioRegion processor/source root.");
      let parent = region;
      for (const [chainIndex, nodeId] of expectedChain.entries()) {
        const node = ir.nodes[nodeId], final = chainIndex === expectedChain.length - 1;
        if (!node || parent.children.length !== 1 || parent.children[0] !== nodeId
          || (final ? node.op !== "cut.audio.clip" || node.children.length !== 0 : node.op === "cut.audio.clip" || node.children.length !== 1)) {
          fail("CUT_IR_IDENTITY", final ? `${basePath}.sourceNodeId` : `${basePath}.processorNodeIds[${chainIndex}]`, "does not match the live ordered single-child processor/source chain.");
        }
        if (Object.keys(node.properties).length) fail("CUT_IR_IDENTITY", childPath("$.nodes", nodeId), "version-2 processed transition chains must be static and cannot carry property automation.");
        parent = node;
      }
      const leaf = ir.nodes[base.sourceNodeId], source = leaf?.inputs.source;
      if (!leaf || source?.kind !== "resource-ref" || source.id !== base.inputs.resourceId
        || !sameAudioRegionInterval(base.source, audioRegionInputInterval(leaf.inputs.range))) {
        fail("CUT_IR_IDENTITY", `${basePath}.sourceNodeId`, "does not match the live AudioClip resource and half-open source range.");
      }
      for (const name of ["fadeIn", "fadeOut"] as const) {
        const fade = leaf.inputs[name];
        if (fade !== undefined && compareRational(audioRegionInputTime(fade) ?? rational(-1), zeroRational) !== 0) {
          fail("CUT_IR_IDENTITY", `${childPath("$.nodes", leaf.id)}.inputs.${name}`, "processed transition source-leaf fades must be exact zero.");
        }
      }
      const link = region.inputs.link?.kind === "string" ? region.inputs.link.value : undefined;
      const head = audioRegionInputTime(region.inputs.headHandle) ?? zeroRational;
      const tail = audioRegionInputTime(region.inputs.tailHandle) ?? zeroRational;
      if (base.inputs.linkId !== link
        || compareRational(base.inputs.headHandle ?? zeroRational, head) !== 0
        || compareRational(base.inputs.tailHandle ?? zeroRational, tail) !== 0) {
        fail("CUT_IR_IDENTITY", `${basePath}.inputs`, "does not match the live AudioRegion link and declared handles.");
      }
    }
    let execution: ReturnType<typeof executeAudioEditOperationPlan>;
    try { execution = executeAudioEditOperationPlan(plan); }
    catch (error) {
      const detail = error instanceof AudioEditOperationError ? error.message : "version-2 audio plan replay failed.";
      fail("CUT_IR_IDENTITY", `${path}.operationPlan`, detail);
    }
    if (compareRational(execution.duration, track.interval.duration) !== 0 || compareRational(plan.sourceDuration, track.interval.duration) !== 0) {
      fail("CUT_IR_IDENTITY", `${path}.operationPlan.sourceDuration`, "transition-only replay duration must equal its owning AudioTrack interval.");
    }
    const encoded = track.editorial.transitions ?? [];
    if (encoded.length !== execution.transitions.length || !encoded.length) fail("CUT_IR_IDENTITY", `${path}.transitions`, "must contain exactly the transitions recomputed from the version-2 plan.");
    execution.transitions.forEach((transition, index) => {
      const expected = {
        cut: addRational(track.interval.start, transition.cut),
        duration: transition.duration,
        overlap: { start: addRational(track.interval.start, transition.overlap.start), duration: transition.overlap.duration },
        outgoingNodeId: track.children[transition.outgoingIndex],
        incomingNodeId: track.children[transition.incomingIndex],
        outgoingSource: transition.outgoingSource,
        incomingSource: transition.incomingSource,
        curve: transition.curve,
      };
      const actual = { ...encoded[index] } as Record<string, unknown>;
      const actualProvenance = actual.provenance; delete actual.provenance;
      if (stableJsonStringify(actual) !== stableJsonStringify(expected)
        || stableJsonStringify(actualProvenance) !== stableJsonStringify(transition.provenance)) {
        fail("CUT_IR_IDENTITY", `${path}.transitions[${index}]`, "does not equal the exact post-plan transition projection.");
      }
    });
  }
}

function legacy03BuildId(ir: CutAVIR) {
  // CUT 0.4 computed the full build identity before JSON.stringify omitted
  // undefined sceneId properties on timeline-root nodes. Reconstruct only that
  // proven representation so archived releases remain checkable, not exempt.
  const nodes = Object.fromEntries(Object.entries(ir.nodes).map(([id, node]) => [
    id,
    Object.hasOwn(node, "sceneId") ? node : { ...node, sceneId: undefined },
  ]));
  return hash({ ...ir, nodes, buildId: "" });
}

function validateHashes(ir: CutAVIR, identityMode: CutAvIrIdentityMode, maxGraphDepth: number) {
  const legacySignals: string[] = [];
  for (const [signalId, signal] of Object.entries(ir.signals)) {
    const expected = cutSignalContentHash(signal);
    if (signal.contentHash === expected) continue;
    const legacyExpected = hash({ ...signal, contentHash: undefined });
    if (signal.contentHash === legacyExpected) { legacySignals.push(signalId); continue; }
    fail("CUT_IR_IDENTITY", `${childPath("$.signals", signalId)}.contentHash`, `does not match signal content (${expected}).`);
  }
  const visiting = new Set<string>(), finished = new Map<string, string>();
  const compositionVisiting = new Set<string>(), compositionFinished = new Map<string, string>();
  const compositionHash = (id: string): string => {
    const cached = compositionFinished.get(id); if (cached) return cached;
    if (compositionVisiting.has(id)) fail("CUT_IR_CYCLE", "$.compositions", `cannot hash cyclic composition graph at “${id}”.`);
    if (compositionVisiting.size >= maxGraphDepth) fail("CUT_IR_LIMIT", "$.compositions", `composition graph exceeds maxGraphDepth (${maxGraphDepth}).`);
    const composition = ir.compositions.find((candidate) => candidate.id === id);
    if (!composition) fail("CUT_IR_REFERENCE", "$.compositions", `references missing composition “${id}”.`);
    compositionVisiting.add(id);
    const expected = cutCompositionContentHash(ir, composition, nodeHash);
    compositionVisiting.delete(id); compositionFinished.set(id, expected); return expected;
  };
  const nodeHash = (id: string): string => {
    const cached = finished.get(id); if (cached) return cached;
    if (visiting.has(id)) fail("CUT_IR_CYCLE", childPath("$.nodes", id), "cannot hash a cyclic node graph.");
    if (visiting.size >= maxGraphDepth) fail("CUT_IR_LIMIT", childPath("$.nodes", id), `graph exceeds maxGraphDepth (${maxGraphDepth}).`);
    const node = ir.nodes[id]; visiting.add(id);
    const expected = cutNodeContentHash(ir, node, nodeHash, compositionHash); visiting.delete(id); finished.set(id, expected);
    if (node.contentHash !== expected) fail("CUT_IR_IDENTITY", `${childPath("$.nodes", id)}.contentHash`, `does not match node content (${expected}).`);
    return expected;
  };
  Object.keys(ir.nodes).forEach(nodeHash);

  const canonicalBuildId = cutIrIdentity(ir);
  if (!legacySignals.length && ir.buildId === canonicalBuildId) return;
  const legacyBuildId = legacy03BuildId(ir);
  if (identityMode === "legacy-0.3-compatible" && ir.buildId === legacyBuildId) return;
  if (legacySignals.length && ir.buildId === canonicalBuildId) {
    const signalId = legacySignals[0]; const expected = cutSignalContentHash(ir.signals[signalId]);
    fail("CUT_IR_IDENTITY", `${childPath("$.signals", signalId)}.contentHash`, `uses the archived CUT 0.4 source-provenance identity; canonical signal identity is ${expected}.`);
  }
  const legacyDetail = ir.buildId === legacyBuildId
    ? " The stored value matches the verified CUT 0.4 undefined-sceneId identity bug; archived input may opt into legacy-0.3-compatible mode."
    : "";
  fail("CUT_IR_IDENTITY", "$.buildId", `does not match canonical serialized IR identity (${canonicalBuildId}).${legacyDetail}`);
}

class JsonBoundaryScanner {
  private offset = 0;
  private nodes = 0;
  constructor(private readonly source: string, private readonly limits: CutAvIrValidationLimits) {}

  scan() {
    this.skipWhitespace(); this.value(0); this.skipWhitespace(); if (this.offset !== this.source.length) this.syntax("unexpected trailing input");
  }

  private syntax(message: string): never { fail("CUT_IR_JSON_PARSE", "$", `${message} at text offset ${this.offset}.`); }
  private skipWhitespace() { while (/\s/.test(this.source[this.offset] ?? "") && this.offset < this.source.length) this.offset += 1; }
  private value(depth: number) {
    this.nodes += 1; if (this.nodes > this.limits.maxJsonNodes) fail("CUT_IR_LIMIT", "$", `JSON exceeds maxJsonNodes (${this.limits.maxJsonNodes}).`);
    if (depth > this.limits.maxJsonDepth) fail("CUT_IR_LIMIT", "$", `JSON exceeds maxJsonDepth (${this.limits.maxJsonDepth}).`);
    this.skipWhitespace(); const character = this.source[this.offset];
    if (character === "{") this.object(depth); else if (character === "[") this.array(depth); else if (character === '"') this.string();
    else if (this.source.startsWith("true", this.offset)) this.offset += 4; else if (this.source.startsWith("false", this.offset)) this.offset += 5; else if (this.source.startsWith("null", this.offset)) this.offset += 4;
    else { const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.offset)); if (!match) this.syntax("expected a JSON value"); this.offset += match[0].length; }
  }
  private string() {
    const start = this.offset; this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') { this.offset += 1; const raw = this.source.slice(start, this.offset); try { return JSON.parse(raw) as string; } catch { this.syntax("invalid JSON string"); } }
      if (character === "\\") { this.offset += 2; continue; }
      if (character.charCodeAt(0) < 0x20) this.syntax("unescaped control character in string"); this.offset += 1;
    }
    this.syntax("unterminated JSON string");
  }
  private object(depth: number) {
    this.offset += 1; this.skipWhitespace(); const keys = new Set<string>(); if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax("expected an object key"); const key = this.string();
      if (keys.has(key)) fail("CUT_IR_JSON_DUPLICATE_KEY", "$", `duplicate decoded object key ${JSON.stringify(key)} near text offset ${this.offset}.`); keys.add(key);
      this.skipWhitespace(); if (this.source[this.offset] !== ":") this.syntax("expected ':' after object key"); this.offset += 1; this.value(depth + 1); this.skipWhitespace();
      if (this.source[this.offset] === "}") { this.offset += 1; return; } if (this.source[this.offset] !== ",") this.syntax("expected ',' or '}'"); this.offset += 1; this.skipWhitespace();
    }
  }
  private array(depth: number) {
    this.offset += 1; this.skipWhitespace(); if (this.source[this.offset] === "]") { this.offset += 1; return; }
    while (true) { this.value(depth + 1); this.skipWhitespace(); if (this.source[this.offset] === "]") { this.offset += 1; return; } if (this.source[this.offset] !== ",") this.syntax("expected ',' or ']'"); this.offset += 1; this.skipWhitespace(); }
  }
}

/**
 * Validate an already-parsed, untrusted JSON value as canonical CutAVIR v3.
 * This proves the public IR contract and identities, not backend operation,
 * codec, package implementation, or device renderability.
 */
export function validateCutAvIr(value: unknown, options: CutAvIrValidationOptions = {}): CutAVIR {
  const { limits, identityMode } = resolveOptions(options);
  const context: ValidationContext = { limits, totalStringBytes: 0, valueNodes: 0, metadataNodes: 0, graphEdges: 0, references: [], signalReferences: [], nodeReferenceEdges: new Map() };
  const root = closed(value, "$", ["format", "version", "language", "compiler", "project", "sourceHash", "buildId", "determinism", "timebase", "modules", "resources", "compositions", "scenes", "nodes", "signals", "jobs", "outputs", "assertions"], ["features", "sourceModules", "annotations", "linkedEdits", "timelineEdits", "semanticMatches", "transcriptBindings", "transcriptMediaAuthorities"]);
  if (root.format !== "cut-av-ir") fail("CUT_IR_ENUM", "$.format", "must be cut-av-ir.");
  if (root.version !== 3) fail("CUT_IR_ENUM", "$.version", "must be 3.");
  if (root.language !== "0.4") fail("CUT_IR_ENUM", "$.language", "must be 0.4.");
  stringValue(root.compiler, "$.compiler", context); stringValue(root.project, "$.project", context); hashValue(root.sourceHash, "$.sourceHash", context); hashValue(root.buildId, "$.buildId", context);
  const determinism = closed(root.determinism, "$.determinism", ["semantic", "decodedMedia", "bitstream"]); enumValue(determinism.semantic, "$.determinism.semantic", new Set(["locked", "unlocked"])); enumValue(determinism.decodedMedia, "$.determinism.decodedMedia", new Set(["verified", "unverified"])); enumValue(determinism.bitstream, "$.determinism.bitstream", new Set(["verified", "unverified"]));
  const timebase = closed(root.timebase, "$.timebase", ["defaultFps", "audioSampleRate"]); const defaultFps = rationalValue(timebase.defaultFps, "$.timebase.defaultFps", context); if (compareRational(defaultFps, zeroRational) <= 0) fail("CUT_IR_TIMING", "$.timebase.defaultFps", "must be positive."); safeInteger(timebase.audioSampleRate, "$.timebase.audioSampleRate", 1);
  const modules = arrayValue(root.modules, "$.modules", context, limits.maxModules); modules.forEach((item, index) => moduleValue(item, `$.modules[${index}]`, context));
  const moduleSpecifiers = new Set<string>(); modules.forEach((item, index) => { const specifier = (item as { specifier: string }).specifier; if (moduleSpecifiers.has(specifier)) fail("CUT_IR_IDENTITY", `$.modules[${index}].specifier`, `duplicates “${specifier}”.`); moduleSpecifiers.add(specifier); });
  if (root.sourceModules !== undefined) {
    const sourceModules = arrayValue(root.sourceModules, "$.sourceModules", context, limits.maxModules);
    let previous: string | undefined;
    sourceModules.forEach((item, index) => {
      sourceModuleValue(item, `$.sourceModules[${index}]`, context);
      const specifier = (item as { specifier: string }).specifier;
      if (previous !== undefined && previous.localeCompare(specifier) >= 0) fail("CUT_IR_IDENTITY", `$.sourceModules[${index}].specifier`, "must be unique and strictly sorted.");
      previous = specifier;
    });
  }
  if (root.features !== undefined) {
    const features = closed(root.features, "$.features", ["complexTextShaping"]);
    complexTextBackendIdentityValue(features.complexTextShaping, "$.features.complexTextShaping", context);
  }
  validateMapEntities(root.resources, "$.resources", context, limits.maxResources, (item, path) => resourceValue(item, path, context));
  const compositions = arrayValue(root.compositions, "$.compositions", context, limits.maxCompositions); compositions.forEach((item, index) => compositionValue(item, `$.compositions[${index}]`, context)); validateUniqueEntityIds(compositions as Array<{ id: string }>, "$.compositions");
  validateMapEntities(root.scenes, "$.scenes", context, limits.maxScenes, (item, path) => sceneValue(item, path, context));
  validateMapEntities(root.nodes, "$.nodes", context, limits.maxNodes, (item, path) => nodeValue(item, path, context));
  validateMapEntities(root.signals, "$.signals", context, limits.maxSignals, (item, path) => signalValue(item, path, context));
  const jobs = arrayValue(root.jobs, "$.jobs", context, limits.maxJobs); jobs.forEach((item, index) => jobValue(item, `$.jobs[${index}]`, context)); validateUniqueEntityIds(jobs as Array<{ id: string }>, "$.jobs");
  const outputs = arrayValue(root.outputs, "$.outputs", context, limits.maxOutputs); outputs.forEach((item, index) => outputValue(item, `$.outputs[${index}]`, context)); validateUniqueEntityIds(outputs as Array<{ id: string }>, "$.outputs");
  const assertions = arrayValue(root.assertions, "$.assertions", context, limits.maxAssertions); assertions.forEach((item, index) => assertionValue(item, `$.assertions[${index}]`, context)); validateUniqueEntityIds(assertions as Array<{ id: string }>, "$.assertions");
  if (root.annotations !== undefined) annotationsValue(root.annotations, "$.annotations", context);
  if (root.linkedEdits !== undefined) linkedEditsValue(root.linkedEdits, "$.linkedEdits", context);
  if (root.timelineEdits !== undefined) timelineEditsValue(root.timelineEdits, "$.timelineEdits", context);
  if (root.semanticMatches !== undefined) semanticMatchesValue(root.semanticMatches, "$.semanticMatches", context);
  if (root.transcriptMediaAuthorities !== undefined) transcriptMediaAuthoritiesValue(root.transcriptMediaAuthorities, "$.transcriptMediaAuthorities", context);
  if (root.transcriptBindings !== undefined) transcriptBindingsValue(root.transcriptBindings, "$.transcriptBindings", context);
  const ir = value as CutAVIR;
  const shapedFlowText = Object.values(ir.nodes).some((node) =>
    node.op === "cut.visual.flow_text"
    && node.inputs.shaping?.kind === "object"
  );
  if (shapedFlowText !== Boolean(ir.features)) {
    fail(
      "CUT_IR_IDENTITY",
      "$.features",
      shapedFlowText
        ? "must contain complexTextShaping when the graph contains shaped FlowText."
        : "must be omitted when the graph contains no shaped FlowText.",
    );
  }
  validatePersistedTranscriptConsumerSurface(ir);
  validateTimelineEditTransitionOwnership(ir);
  validateReferencesAndGraph(ir, context, identityMode);
  validateSemanticMatchContracts(ir);
  validateTranscriptMediaAuthorityContracts(ir);
  validateTranscriptBindingContracts(ir);
  validateTranscriptConsumerContracts(ir);
  try {
    cutImageSequenceSources(ir);
  } catch (error) {
    if (!(error instanceof CutImageSequenceError)) throw error;
    const prefix = `${error.code} at ${error.path}: `;
    fail(error.code, error.path, error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message);
  }
  validateAudioRegionRetimeCoherence(ir);
  validateAudioRegionCrossfadePlanCoherence(ir);
  const allLocked = Object.values(ir.resources).every((resource) => resource.state === "locked" && Boolean(resource.sha256)) && ir.jobs.every((job) => job.state === "locked" && Boolean(job.artifactHash));
  if (ir.determinism.semantic === "locked" && !allLocked) fail("CUT_IR_DETERMINISM", "$.determinism.semantic", "claims locked semantics while a resource or effect job is unresolved.");
  validateHashes(ir, identityMode, limits.maxGraphDepth);
  return ir;
}

/** Parse UTF-8 JSON bytes/text, reject duplicate keys, then validate CutAVIR. */
export function loadCutAvIr(input: string | Uint8Array, options: CutAvIrValidationOptions = {}): CutAVIR {
  const { limits, identityMode } = resolveOptions(options);
  let source: string;
  if (typeof input === "string") source = input;
  else if (input instanceof Uint8Array) {
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(input); }
    catch { fail("CUT_IR_JSON_ENCODING", "$", "input is not valid UTF-8."); }
  } else fail("CUT_IR_TYPE", "$", "loader input must be a JSON string or Uint8Array.");
  const bytes = Buffer.byteLength(source, "utf8"); if (bytes > limits.maxInputBytes) fail("CUT_IR_JSON_TOO_LARGE", "$", `input is ${bytes} bytes; limit is ${limits.maxInputBytes}.`);
  new JsonBoundaryScanner(source, limits).scan();
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch (error) { fail("CUT_IR_JSON_PARSE", "$", error instanceof Error ? error.message : "invalid JSON."); }
  return validateCutAvIr(value, { limits, identityMode });
}
