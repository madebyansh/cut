import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { hash, stableJsonStringify } from "../core/stable";
import {
  probeProjectAudioProxyAlignment,
  probeProjectBytes,
  probeProjectDecodedAudioSamples,
  probeProjectDecodedVideoCadence,
  probeProjectImage,
  probeProjectMedia,
  probeProjectVideoProxyAlignment,
  type CutByteProbe,
  type CutImageProbe,
  type CutMediaProbe,
} from "../project/probe";
import { CutProjectError, resolveProjectFile, validateProjectLocator } from "../project/manifest";
import { finalizeGraphHashes } from "../runtime/graph";
import { collectReferenceBackendIdentity, type CutReferenceBackendIdentity } from "../runtime/reference/runtime-identity";
import { ReferenceLutError, referenceCubeLutLimits, validateReferenceLutResourceOwnership, validateReferenceLutResources } from "../runtime/reference/lut-config";
import {
  ReferencePlanarTrackError,
  referencePlanarTrackLimits,
  validateReferencePlanarTrackResourceOwnership,
  validateReferencePlanarTrackResources,
  type ReferencePlanarTrackConfig,
} from "../runtime/reference/planar-tracking";
import { cutPackageAbi, cutReferenceRuntimeIdentity } from "../version";
import {
  collectInstalledComplexTextBackendIdentity,
  referenceComplexTextBackendContract,
  referenceDependencyNames,
  type ReferenceComplexTextBackendIdentity,
} from "./dependency-identity";
import type { CutAVIR, IRResource } from "./ir";
import { assertLockedMediaSourceBounds, type LockedSelectedMedia } from "./media-bounds";
import { compareRational, divideRational, multiplyRational, rational, subtractRational, type Rational, zeroRational } from "./rational";
import { assertResolvedCutIr } from "./resolution";
import { registerAppliedCutLockIr } from "./locked-ir-state";
import { refreshLockedCutDomainAssertionStatuses } from "./domain-assertions";
import { referenceVideoColorInterpretationWarnings } from "../runtime/reference/color-management";
import { decodedVideoCadenceDuration, decodedVideoCadenceQuantizations, type CutDecodedVideoCadence } from "./video-cadence";
import { directNodeConsumedMediaKinds, type CutConsumedMediaKind } from "./media-consumption";
import { decodedAudioSamplesDuration, type CutDecodedAudioSamples } from "./audio-sample-witness";
import {
  cutAudioProxyAlignmentContractV1,
  cutAudioProxyAlignmentContractV2,
  cutAudioProxyAlignmentIntegrity,
  cutAudioProxyEnvelopeWindowCount,
  type CutAudioProxyAlignment,
  type CutAudioProxyAlignmentV1,
  type CutAudioProxyAlignmentV2,
} from "./audio-proxy-alignment";
import {
  cutVideoProxyAlignmentContract,
  cutVideoProxyAlignmentIntegrity,
  type CutVideoProxyAlignment,
} from "./video-proxy-alignment";
import {
  CutTranscriptLockError,
  cutTranscriptSidecarMaxBytes,
  verifyCutTranscriptBindingsForLock,
} from "./transcript-lock";
import {
  CutTypedDataAssetAuthorityError,
  assertCutTypedDataAssetConsumerCompatibility,
  validateCutTypedDataAssetAuthority,
  type CutTypedDataAssetAuthorityV1,
} from "./typed-data-asset";
import {
  CutTypedDataAssetPayloadError,
  cutTypedDataAssetMaximumBytes,
  validateCutTypedDataAssetPayload,
} from "./typed-data-asset-bytes";
import {
  CutImageSequenceError,
  cutImageSequenceLimits,
  cutImageSequenceSources,
  parseCutImageSequenceManifest,
  validateCutImageSequenceManifestBinding,
  type CutImageSequenceLockedResource,
} from "./image-sequence";

type LockedMediaSelectionBase = {
  streamIndex: number;
  duration: Rational;
  timeBase: Rational;
};

export type LockedVideoMediaSelection = LockedMediaSelectionBase & {
  durationSource: "stream" | "decoded-video-cadence";
  /** Chosen decoded/nominal picture clock; present only for video. */
  frameRate?: Rational;
  decodedVideoCadence?: CutDecodedVideoCadence;
};

export type LockedAudioMediaSelection = LockedMediaSelectionBase & {
  durationSource: "stream" | "decoded-audio-samples";
  decodedAudioSamples?: CutDecodedAudioSamples;
};

export type LockedMediaSelection = LockedVideoMediaSelection | LockedAudioMediaSelection;

export type LockedResourceProbe =
  | {
      kind: "media";
      identity: CutMediaProbe;
      selected: { video?: LockedVideoMediaSelection; audio?: LockedAudioMediaSelection };
    }
  | { kind: "image"; identity: CutImageProbe }
  | {
      kind: "bytes";
      identity: CutByteProbe;
      coverage: { level: "bytes-only"; excludes: string[] };
    };

export type LockedResource = {
  id: string;
  kind: IRResource["kind"];
  locator: string;
  sha256: string;
  bytes: number;
  probe: LockedResourceProbe;
  /** Compiler-owned semantic authority; omitted exactly for legacy data(). */
  byteAuthority?: CutTypedDataAssetAuthorityV1;
  /** Optional editorially-equivalent preview media, independently probed and content locked. */
  proxy?: LockedResourceVariant;
};

export type LockedResourceVariant = {
  locator: string;
  sha256: string;
  bytes: number;
  probe: LockedResourceProbe;
  audioAlignment?: CutAudioProxyAlignment;
  videoAlignment?: CutVideoProxyAlignment;
};

export type CutLockfile = {
  format: "cut-lock";
  version: 3;
  language: "0.4";
  toolchain: {
    compiler: string;
    ir: 3;
    packageAbi: number;
    referenceRuntime: string;
    referenceBackend: CutReferenceBackendIdentity;
  };
  sourceHash: string;
  sourceModules?: Array<{ specifier: string; sha256: string; bytes: number }>;
  features?: {
    complexTextShaping: ReferenceComplexTextBackendIdentity;
  };
  packages: Array<{ specifier: string; version: string; integrity: string }>;
  resources: Record<string, LockedResource>;
  jobs: Record<string, { artifactHash: string }>;
  determinism: {
    semantic: "locked";
    decodedMedia: "unverified";
    bitstream: "unverified";
  };
};

export type CutLockValidationLimits = {
  maxInputBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxResources: number;
  maxPackages: number;
  maxJobs: number;
  maxStreamsPerResource: number;
  maxChaptersPerResource: number;
  maxStringBytes: number;
  maxTotalStringBytes: number;
  maxRationalDigits: number;
};

export const defaultCutLockValidationLimits: Readonly<CutLockValidationLimits> = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 1_000_000,
  maxResources: 10_000,
  maxPackages: 256,
  maxJobs: 100_000,
  maxStreamsPerResource: 1_024,
  maxChaptersPerResource: 10_000,
  maxStringBytes: 1024 * 1024,
  maxTotalStringBytes: 16 * 1024 * 1024,
  maxRationalDigits: 256,
});

export class CutLockError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutLockError";
  }
}

export type CutProxyMediaErrorCode = "CUT_PROXY_KIND" | "CUT_PROXY_NOOP" | "CUT_PROXY_TIMING" | "CUT_PROXY_FRAME_MAPPING" | "CUT_PROXY_SAMPLE_MAPPING" | "CUT_PROXY_SCAN_MAPPING" | "CUT_PROXY_COLOR_MAPPING" | "CUT_PROXY_AUDIO_ALIGNMENT" | "CUT_PROXY_VIDEO_ALIGNMENT";

export class CutProxyMediaError extends Error {
  readonly source: { module: string; line: number; column: number; resourceId: string };

  constructor(readonly code: CutProxyMediaErrorCode, resource: IRResource, message: string) {
    const span = resource.provenance.span;
    super(`${code}: ${message} at ${resource.provenance.module}:${span.start.line}:${span.start.column}.`);
    this.name = "CutProxyMediaError";
    this.source = { module: resource.provenance.module, line: span.start.line, column: span.start.column, resourceId: resource.id };
  }
}

export class CutMediaDurationError extends Error {
  readonly code = "CUT_MEDIA_DURATION_BOUND" as const;
  readonly path: string;
  readonly source?: { module: string; line: number; column: number; resourceId: string };

  constructor(locator: string, type: "video" | "audio", streamIndex: number, detail: string, resource?: IRResource) {
    const span = resource?.provenance.span;
    super(`CUT_MEDIA_DURATION_BOUND: Cannot lock ${locator}: selected ${type} stream ${streamIndex} ${detail}${resource && span ? ` at ${resource.provenance.module}:${span.start.line}:${span.start.column}.` : ""}`);
    this.name = "CutMediaDurationError";
    this.path = locator;
    if (resource && span) this.source = { module: resource.provenance.module, line: span.start.line, column: span.start.column, resourceId: resource.id };
  }
}

export type CutMediaStreamSelectionErrorCode = "CUT_MEDIA_STREAM_AMBIGUOUS" | "CUT_MEDIA_STREAM_NOT_FOUND";

/** Public source-located refusal for media containers whose consumed stream
 * cannot be selected deterministically from authored CUT semantics. */
export class CutMediaStreamSelectionError extends Error {
  readonly source: { module: string; line: number; column: number; resourceId: string };

  constructor(
    readonly code: CutMediaStreamSelectionErrorCode,
    resource: IRResource,
    readonly variant: "master" | "proxy",
    readonly mediaType: "video" | "audio",
    message: string,
  ) {
    const span = resource.provenance.span;
    super(`${code}: ${message} at ${resource.provenance.module}:${span.start.line}:${span.start.column}.`);
    this.name = "CutMediaStreamSelectionError";
    this.source = { module: resource.provenance.module, line: span.start.line, column: span.start.column, resourceId: resource.id };
  }
}

type ValidationContext = { limits: CutLockValidationLimits; totalStringBytes: number };
type JsonRecord = Record<string, unknown>;
const hashes = /^[a-f0-9]{64}$/;
const integerText = /^-?(?:0|[1-9]\d*)$/;
const positiveIntegerText = /^[1-9]\d*$/;
const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
const mediaTypes = new Set(["video", "audio", "subtitle", "data", "attachment", "unknown"]);

function fail(code: string, path: string, message: string): never { throw new CutLockError(code, path, message); }
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
function strictUtf8Text(value: string, path: string) {
  if (hasUnpairedSurrogate(value)) fail("CUT_LOCK_JSON_ENCODING", path, "text contains an unpaired UTF-16 surrogate and is not valid UTF-8 text.");
  return value;
}
function isRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function record(value: unknown, path: string) { if (!isRecord(value)) fail("CUT_LOCK_TYPE", path, "must be a plain object."); return value; }
function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const object = record(value, path), allowed = new Set([...required, ...optional]);
  for (const field of required) if (!Object.hasOwn(object, field)) fail("CUT_LOCK_MISSING_FIELD", path, `is missing required field “${field}”.`);
  for (const field of Object.keys(object)) if (!allowed.has(field)) fail("CUT_LOCK_UNKNOWN_FIELD", `${path}.${field}`, "is not part of cut.lock v3.");
  return object;
}
function child(path: string, key: string) { return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`; }
function text(value: unknown, path: string, context: ValidationContext, maximum = context.limits.maxStringBytes, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) fail("CUT_LOCK_TYPE", path, "must be a bounded string without NUL bytes.");
  strictUtf8Text(value, path);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximum) fail("CUT_LOCK_LIMIT", path, `exceeds ${maximum} UTF-8 bytes.`);
  context.totalStringBytes += bytes;
  if (context.totalStringBytes > context.limits.maxTotalStringBytes) fail("CUT_LOCK_LIMIT", path, `lock strings exceed ${context.limits.maxTotalStringBytes} UTF-8 bytes.`);
  return value;
}
function identifier(value: unknown, path: string, context: ValidationContext) {
  const result = text(value, path, context, 512);
  if (dangerousKeys.has(result) || /[\u0000-\u001f\u007f]/.test(result)) fail("CUT_LOCK_TYPE", path, "must be a safe identifier.");
  return result;
}
function digest(value: unknown, path: string, context: ValidationContext) {
  const result = text(value, path, context, 64);
  if (!hashes.test(result)) fail("CUT_LOCK_HASH", path, "must be a lowercase SHA-256 digest.");
  return result;
}
function safeInteger(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail("CUT_LOCK_TYPE", path, `must be a safe integer from ${minimum} to ${maximum}.`);
  return Number(value);
}
function booleanValue(value: unknown, path: string) { if (typeof value !== "boolean") fail("CUT_LOCK_TYPE", path, "must be a boolean."); return value; }
function rationalValue(value: unknown, path: string, context: ValidationContext, positive = false): Rational {
  const object = closed(value, path, ["numerator", "denominator"]);
  const numerator = text(object.numerator, `${path}.numerator`, context, context.limits.maxRationalDigits + 1);
  const denominator = text(object.denominator, `${path}.denominator`, context, context.limits.maxRationalDigits);
  if (!integerText.test(numerator) || numerator === "-0" || !positiveIntegerText.test(denominator)) fail("CUT_LOCK_RATIONAL", path, "must contain canonical integer strings and a positive denominator.");
  const numeratorDigits = numerator.startsWith("-") ? numerator.length - 1 : numerator.length;
  if (numeratorDigits > context.limits.maxRationalDigits || denominator.length > context.limits.maxRationalDigits) fail("CUT_LOCK_LIMIT", path, `rational exceeds ${context.limits.maxRationalDigits} digits.`);
  const canonical = rational(numerator, denominator);
  if (canonical.numerator !== numerator || canonical.denominator !== denominator) fail("CUT_LOCK_RATIONAL", path, "must be reduced to canonical lowest terms.");
  if (positive && compareRational(canonical, zeroRational) <= 0) fail("CUT_LOCK_RATIONAL", path, "must be positive.");
  return canonical;
}
function optionalRational(object: JsonRecord, name: string, path: string, context: ValidationContext, positive = false) {
  return Object.hasOwn(object, name) ? rationalValue(object[name], `${path}.${name}`, context, positive) : undefined;
}
function stringArray(value: unknown, path: string, context: ValidationContext, maximum: number, itemBytes: number) {
  if (!Array.isArray(value) || value.length > maximum) fail("CUT_LOCK_LIMIT", path, `must be an array with at most ${maximum} entries.`);
  return value.map((item, index) => text(item, `${path}[${index}]`, context, itemBytes));
}
function strictlySortedStrings(value: unknown, path: string, context: ValidationContext, maximum: number, itemBytes: number, minimum = 0) {
  const values = stringArray(value, path, context, maximum, itemBytes);
  if (values.length < minimum) fail("CUT_LOCK_METADATA", path, `must contain at least ${minimum} canonical ${minimum === 1 ? "entry" : "entries"}.`);
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1].localeCompare(values[index]) >= 0) fail("CUT_LOCK_IDENTITY", `${path}[${index}]`, "must be unique and strictly sorted.");
  }
  return values;
}
function exactEnum(value: unknown, path: string, allowed: readonly string[]) {
  if (typeof value !== "string" || !allowed.includes(value)) fail("CUT_LOCK_ENUM", path, `must be one of ${allowed.join(", ")}.`);
  return value;
}

const runtimeIdentityToken = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
function runtimeToken(value: unknown, path: string, context: ValidationContext) {
  const result = text(value, path, context, 128);
  if (!runtimeIdentityToken.test(result)) fail("CUT_LOCK_IDENTITY", path, "must be a bounded runtime identity token.");
  return result;
}

function validateReferenceDependencies(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["format", "integrity", "packages", "version"]);
  if (object.format !== "cut-reference-dependencies" || object.version !== 1) fail("CUT_LOCK_VERSION", path, "requires cut-reference-dependencies v1.");
  if (!Array.isArray(object.packages) || object.packages.length !== referenceDependencyNames.length) {
    fail("CUT_LOCK_IDENTITY", `${path}.packages`, `must contain exactly ${referenceDependencyNames.length} reference dependencies.`);
  }
  const packages = object.packages.map((value, index) => {
    const packagePath = `${path}.packages[${index}]`, package_ = closed(value, packagePath, ["name", "version"]);
    const expectedName = referenceDependencyNames[index];
    if (package_.name !== expectedName) fail("CUT_LOCK_IDENTITY", `${packagePath}.name`, `must be ${expectedName} in canonical order.`);
    return { name: expectedName, version: runtimeToken(package_.version, `${packagePath}.version`, context) };
  });
  const integrity = digest(object.integrity, `${path}.integrity`, context);
  const content = { format: "cut-reference-dependencies" as const, version: 1 as const, packages };
  if (integrity !== hash(content)) fail("CUT_LOCK_IDENTITY", `${path}.integrity`, "does not match the canonical installed dependency identity.");
  return { ...content, integrity };
}

function validateReferenceBackend(value: unknown, path: string, context: ValidationContext): CutReferenceBackendIdentity {
  const versioned = record(value, path);
  if (versioned.format !== "cut-reference-backend" || versioned.version !== 2) fail("CUT_LOCK_VERSION", path, "requires cut-reference-backend v2.");
  const object = closed(versioned, path, ["compositor", "dependencies", "format", "integrity", "native", "runtime", "version"]);
  const dependencies = validateReferenceDependencies(object.dependencies, `${path}.dependencies`, context);
  const native = closed(object.native, `${path}.native`, ["architecture", "libvips", "nodeAbi", "platform", "sharp"]);
  const canonicalNative = {
    platform: runtimeToken(native.platform, `${path}.native.platform`, context) as NodeJS.Platform,
    architecture: runtimeToken(native.architecture, `${path}.native.architecture`, context),
    nodeAbi: runtimeToken(native.nodeAbi, `${path}.native.nodeAbi`, context),
    sharp: runtimeToken(native.sharp, `${path}.native.sharp`, context),
    libvips: runtimeToken(native.libvips, `${path}.native.libvips`, context),
  };
  const installedSharp = dependencies.packages.find((entry) => entry.name === "sharp")?.version;
  if (canonicalNative.sharp !== installedSharp) fail("CUT_LOCK_IDENTITY", `${path}.native.sharp`, "must match the installed Sharp package version.");
  const compositorValue = record(object.compositor, `${path}.compositor`), mode = exactEnum(compositorValue.mode, `${path}.compositor.mode`, ["native", "javascript"]);
  const compositor = mode === "native"
    ? (() => {
      const nativeCompositor = closed(compositorValue, `${path}.compositor`, ["algorithm", "architecture", "binarySha256", "mode", "platform"]);
      return {
        mode: "native" as const,
        platform: runtimeToken(nativeCompositor.platform, `${path}.compositor.platform`, context) as NodeJS.Platform,
        architecture: runtimeToken(nativeCompositor.architecture, `${path}.compositor.architecture`, context),
        algorithm: runtimeToken(nativeCompositor.algorithm, `${path}.compositor.algorithm`, context),
        binarySha256: digest(nativeCompositor.binarySha256, `${path}.compositor.binarySha256`, context),
      };
    })()
    : (() => {
      const javascriptCompositor = closed(compositorValue, `${path}.compositor`, ["algorithm", "architecture", "implementation", "mode", "platform"]);
      return {
        mode: "javascript" as const,
        platform: runtimeToken(javascriptCompositor.platform, `${path}.compositor.platform`, context) as NodeJS.Platform,
        architecture: runtimeToken(javascriptCompositor.architecture, `${path}.compositor.architecture`, context),
        algorithm: runtimeToken(javascriptCompositor.algorithm, `${path}.compositor.algorithm`, context),
        implementation: runtimeToken(javascriptCompositor.implementation, `${path}.compositor.implementation`, context),
      };
    })();
  if (compositor.platform !== canonicalNative.platform || compositor.architecture !== canonicalNative.architecture) {
    fail("CUT_LOCK_IDENTITY", `${path}.compositor`, "host must match the reference backend native runtime host.");
  }
  const runtime = text(object.runtime, `${path}.runtime`, context, 256), integrity = digest(object.integrity, `${path}.integrity`, context);
  const content = { format: "cut-reference-backend" as const, version: 2 as const, runtime, dependencies, native: canonicalNative, compositor };
  if (integrity !== hash(content)) fail("CUT_LOCK_IDENTITY", `${path}.integrity`, "does not match the canonical reference backend identity.");
  return { ...content, integrity };
}

function validateComplexTextBackendIdentity(
  value: unknown,
  path: string,
  context: ValidationContext,
): ReferenceComplexTextBackendIdentity {
  const object = closed(value, path, ["bidiJs", "format", "harfbuzz", "harfbuzzjs", "integrity", "policies", "version"]);
  if (object.format !== "cut-reference-complex-text-backend" || object.version !== 1) {
    fail("CUT_LOCK_VERSION", path, "requires cut-reference-complex-text-backend v1.");
  }
  const harfbuzzjs = closed(object.harfbuzzjs, `${path}.harfbuzzjs`, [
    "entrySha256",
    "glueSha256",
    "manifestSha256",
    "packageVersion",
    "wasmSha256",
  ]);
  if (harfbuzzjs.packageVersion !== "1.4.0") {
    fail("CUT_LOCK_IDENTITY", `${path}.harfbuzzjs.packageVersion`, "must be the pinned harfbuzzjs 1.4.0 package.");
  }
  const canonicalHarfbuzzJs = {
    packageVersion: "1.4.0" as const,
    manifestSha256: digest(harfbuzzjs.manifestSha256, `${path}.harfbuzzjs.manifestSha256`, context),
    entrySha256: digest(harfbuzzjs.entrySha256, `${path}.harfbuzzjs.entrySha256`, context),
    glueSha256: digest(harfbuzzjs.glueSha256, `${path}.harfbuzzjs.glueSha256`, context),
    wasmSha256: digest(harfbuzzjs.wasmSha256, `${path}.harfbuzzjs.wasmSha256`, context),
  };
  const harfbuzz = closed(object.harfbuzz, `${path}.harfbuzz`, ["clusterLevel", "runtimeVersion"]);
  if (harfbuzz.runtimeVersion !== "14.2.1" || harfbuzz.clusterLevel !== "MONOTONE_GRAPHEMES") {
    fail("CUT_LOCK_IDENTITY", `${path}.harfbuzz`, "must bind HarfBuzz 14.2.1 with MONOTONE_GRAPHEMES clusters.");
  }
  const canonicalHarfbuzz = {
    runtimeVersion: "14.2.1" as const,
    clusterLevel: "MONOTONE_GRAPHEMES" as const,
  };
  const bidiJs = closed(object.bidiJs, `${path}.bidiJs`, [
    "implementationSha256",
    "manifestSha256",
    "packageVersion",
    "unicodeVersion",
  ]);
  if (bidiJs.packageVersion !== "1.0.3" || bidiJs.unicodeVersion !== "13.0.0") {
    fail("CUT_LOCK_IDENTITY", `${path}.bidiJs`, "must bind bidi-js 1.0.3 and its Unicode 13.0.0 tables.");
  }
  const canonicalBidiJs = {
    packageVersion: "1.0.3" as const,
    unicodeVersion: "13.0.0" as const,
    manifestSha256: digest(bidiJs.manifestSha256, `${path}.bidiJs.manifestSha256`, context),
    implementationSha256: digest(bidiJs.implementationSha256, `${path}.bidiJs.implementationSha256`, context),
  };
  const policies = closed(object.policies, `${path}.policies`, [
    "fallback",
    "hostFontFallback",
    "normalization",
    "selector",
    "wrap",
  ]);
  const expectedPolicies = {
    fallback: referenceComplexTextBackendContract.fallbackPolicy,
    wrap: referenceComplexTextBackendContract.wrapPolicy,
    selector: referenceComplexTextBackendContract.selectorPolicy,
    normalization: referenceComplexTextBackendContract.normalizationPolicy,
    hostFontFallback: referenceComplexTextBackendContract.hostFontFallback,
  } as const;
  for (const [name, expected] of Object.entries(expectedPolicies)) {
    if (policies[name] !== expected) {
      fail("CUT_LOCK_IDENTITY", `${path}.policies.${name}`, "does not match the pinned complex-text execution policy.");
    }
  }
  const expectedBytes = referenceComplexTextBackendContract.backendBytes;
  const bytePairs = [
    ["harfbuzzjs.manifestSha256", canonicalHarfbuzzJs.manifestSha256, expectedBytes.harfbuzzManifestSha256],
    ["harfbuzzjs.entrySha256", canonicalHarfbuzzJs.entrySha256, expectedBytes.harfbuzzEntrySha256],
    ["harfbuzzjs.glueSha256", canonicalHarfbuzzJs.glueSha256, expectedBytes.harfbuzzGlueSha256],
    ["harfbuzzjs.wasmSha256", canonicalHarfbuzzJs.wasmSha256, expectedBytes.harfbuzzWasmSha256],
    ["bidiJs.manifestSha256", canonicalBidiJs.manifestSha256, expectedBytes.bidiManifestSha256],
    ["bidiJs.implementationSha256", canonicalBidiJs.implementationSha256, expectedBytes.bidiImplementationSha256],
  ] as const;
  for (const [name, actual, pinned] of bytePairs) {
    if (actual !== pinned) fail("CUT_LOCK_IDENTITY", `${path}.${name}`, "does not match the pinned complex-text backend byte identity.");
  }
  const integrity = digest(object.integrity, `${path}.integrity`, context);
  const content = {
    format: "cut-reference-complex-text-backend" as const,
    version: 1 as const,
    harfbuzzjs: canonicalHarfbuzzJs,
    harfbuzz: canonicalHarfbuzz,
    bidiJs: canonicalBidiJs,
    policies: expectedPolicies,
  };
  const expectedIntegrity = hash(content);
  if (integrity !== expectedIntegrity) {
    fail("CUT_LOCK_IDENTITY", `${path}.integrity`, "does not match the canonical complex-text feature authority.");
  }
  return { ...content, integrity };
}

function validateFileIdentity(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["basename", "bytes", "locator", "sha256"]);
  const locator = text(object.locator, `${path}.locator`, context, 4096), fileBasename = text(object.basename, `${path}.basename`, context, 1024);
  try { validateProjectLocator(locator, "resource locator"); } catch (error) { fail("CUT_LOCK_LOCATOR", `${path}.locator`, error instanceof Error ? error.message : String(error)); }
  if (posix.basename(locator) !== fileBasename) fail("CUT_LOCK_IDENTITY", `${path}.basename`, "must match the POSIX locator basename.");
  return { locator, basename: fileBasename, bytes: safeInteger(object.bytes, `${path}.bytes`), sha256: digest(object.sha256, `${path}.sha256`, context) };
}

function validateImplementation(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["name", "version"], ["compiler", "configurationSha256"]);
  if (object.name !== "ffprobe") fail("CUT_LOCK_ENUM", `${path}.name`, "must be ffprobe.");
  text(object.version, `${path}.version`, context, 128);
  if (Object.hasOwn(object, "compiler")) text(object.compiler, `${path}.compiler`, context, 256);
  if (Object.hasOwn(object, "configurationSha256")) digest(object.configurationSha256, `${path}.configurationSha256`, context);
}

function validateMediaIdentity(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["chapters", "container", "file", "format", "implementation", "streams", "version"]);
  if (object.format !== "cut-media-probe" || object.version !== 1) fail("CUT_LOCK_VERSION", path, "requires cut-media-probe v1.");
  validateImplementation(object.implementation, `${path}.implementation`, context);
  const file = validateFileIdentity(object.file, `${path}.file`, context);
  const container = closed(object.container, `${path}.container`, ["names"], ["bitRate", "duration", "start"]);
  strictlySortedStrings(container.names, `${path}.container.names`, context, 64, 128, 1);
  const containerDuration = optionalRational(container, "duration", `${path}.container`, context, true);
  optionalRational(container, "start", `${path}.container`, context);
  if (Object.hasOwn(container, "bitRate")) safeInteger(container.bitRate, `${path}.container.bitRate`);

  if (!Array.isArray(object.streams) || object.streams.length > context.limits.maxStreamsPerResource) fail("CUT_LOCK_LIMIT", `${path}.streams`, `must contain at most ${context.limits.maxStreamsPerResource} streams.`);
  const streams = new Map<number, { type: string; timeBase?: Rational; start?: Rational; duration?: Rational; frameRate?: Rational; averageFrameRate?: Rational; width?: number; height?: number; sampleRate?: number; channels?: number }>();
  let previousIndex = -1;
  object.streams.forEach((streamValue, index) => {
    const streamPath = `${path}.streams[${index}]`;
    const stream = closed(streamValue, streamPath, ["codec", "disposition", "index", "type"], ["averageFrameRate", "channelLayout", "channels", "colorPrimaries", "colorRange", "colorSpace", "colorTransfer", "duration", "fieldOrder", "frameRate", "height", "language", "pixelFormat", "profile", "sampleRate", "start", "timeBase", "width"]);
    const streamIndex = safeInteger(stream.index, `${streamPath}.index`);
    if (streamIndex <= previousIndex) fail("CUT_LOCK_IDENTITY", `${streamPath}.index`, "stream indexes must be unique and strictly increasing.");
    previousIndex = streamIndex;
    const type = exactEnum(stream.type, `${streamPath}.type`, [...mediaTypes]);
    // field_order is a decoded-picture execution fact, unlike retained raw
    // probe evidence such as bitmap-subtitle dimensions. Keep the broader
    // ffprobe record lossless, but do not accept fieldOrder where CUT can
    // neither execute nor compare it.
    if (type !== "video" && Object.hasOwn(stream, "fieldOrder")) {
      fail("CUT_LOCK_METADATA", `${streamPath}.fieldOrder`, "fieldOrder is valid only on a video stream.");
    }
    text(stream.codec, `${streamPath}.codec`, context, 128);
    for (const field of ["channelLayout", "colorPrimaries", "colorRange", "colorSpace", "colorTransfer", "fieldOrder", "language", "pixelFormat", "profile"] as const) if (Object.hasOwn(stream, field)) text(stream[field], `${streamPath}.${field}`, context, field === "language" ? 64 : 128);
    const timeBase = optionalRational(stream, "timeBase", streamPath, context, true), start = optionalRational(stream, "start", streamPath, context), duration = optionalRational(stream, "duration", streamPath, context, true);
    const frameRate = optionalRational(stream, "frameRate", streamPath, context, true);
    const averageFrameRate = optionalRational(stream, "averageFrameRate", streamPath, context, true);
    const numeric = Object.fromEntries((["channels", "height", "sampleRate", "width"] as const).flatMap((field) => Object.hasOwn(stream, field) ? [[field, safeInteger(stream[field], `${streamPath}.${field}`, 1, 1_048_576)]] : [])) as { channels?: number; height?: number; sampleRate?: number; width?: number };
    strictlySortedStrings(stream.disposition, `${streamPath}.disposition`, context, 64, 128);
    streams.set(streamIndex, { type, timeBase, start, duration, frameRate, averageFrameRate, ...numeric });
  });

  if (!Array.isArray(object.chapters) || object.chapters.length > context.limits.maxChaptersPerResource) fail("CUT_LOCK_LIMIT", `${path}.chapters`, `must contain at most ${context.limits.maxChaptersPerResource} chapters.`);
  let previousChapterId = -1;
  object.chapters.forEach((chapterValue, index) => {
    const chapterPath = `${path}.chapters[${index}]`, chapter = closed(chapterValue, chapterPath, ["end", "id", "start"], ["title"]);
    const id = safeInteger(chapter.id, `${chapterPath}.id`);
    if (id <= previousChapterId) fail("CUT_LOCK_IDENTITY", `${chapterPath}.id`, "must be unique and strictly increasing.");
    previousChapterId = id;
    const start = rationalValue(chapter.start, `${chapterPath}.start`, context), end = rationalValue(chapter.end, `${chapterPath}.end`, context);
    if (compareRational(end, start) < 0) fail("CUT_LOCK_METADATA", chapterPath, "chapter end must not precede start.");
    if (Object.hasOwn(chapter, "title")) text(chapter.title, `${chapterPath}.title`, context, 512);
  });
  return { file, containerDuration, streams };
}

function validateDecodedVideoCadence(value: unknown, path: string, context: ValidationContext): CutDecodedVideoCadence {
  const object = closed(value, path, ["durationCoverage", "durationPresentCount", "firstPts", "format", "frameCount", "frameRate", "lastPts", "method", "phaseNumerator", "quantization", "quantizedEndPts", "recordsSha256", "streamIndex", "timeBase", "version"]);
  if (object.format !== "cut-decoded-video-cadence" || object.version !== 2 || object.method !== "ffprobe-show-frames-cfr-v2") {
    fail("CUT_LOCK_VERSION", path, "requires cut-decoded-video-cadence v2 from ffprobe-show-frames-cfr-v2.");
  }
  const integerString = (name: "firstPts" | "lastPts", positive = false) => {
    const result = text(object[name], `${path}.${name}`, context, context.limits.maxRationalDigits + 1);
    if (!(positive ? positiveIntegerText : integerText).test(result) || result === "-0") fail("CUT_LOCK_RATIONAL", `${path}.${name}`, "must be one canonical exact integer string.");
    return result;
  };
  const positiveString = (name: "frameCount") => {
    const result = text(object[name], `${path}.${name}`, context, context.limits.maxRationalDigits);
    if (!positiveIntegerText.test(result)) fail("CUT_LOCK_RATIONAL", `${path}.${name}`, "must be one canonical positive integer string.");
    return result;
  };
  return {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: exactEnum(object.quantization, `${path}.quantization`, [...decodedVideoCadenceQuantizations]) as CutDecodedVideoCadence["quantization"],
    phaseNumerator: (() => {
      const result = text(object.phaseNumerator, `${path}.phaseNumerator`, context, context.limits.maxRationalDigits);
      if (!/^(?:0|[1-9]\d*)$/u.test(result)) fail("CUT_LOCK_RATIONAL", `${path}.phaseNumerator`, "must be one canonical non-negative integer string.");
      return result;
    })(),
    streamIndex: safeInteger(object.streamIndex, `${path}.streamIndex`),
    firstPts: integerString("firstPts"),
    lastPts: integerString("lastPts"),
    quantizedEndPts: (() => {
      const result = text(object.quantizedEndPts, `${path}.quantizedEndPts`, context, context.limits.maxRationalDigits + 1);
      if (!integerText.test(result) || result === "-0") fail("CUT_LOCK_RATIONAL", `${path}.quantizedEndPts`, "must be one canonical exact integer string.");
      return result;
    })(),
    frameCount: positiveString("frameCount"),
    durationPresentCount: (() => {
      const result = text(object.durationPresentCount, `${path}.durationPresentCount`, context, context.limits.maxRationalDigits);
      if (!/^(?:0|[1-9]\d*)$/u.test(result)) fail("CUT_LOCK_RATIONAL", `${path}.durationPresentCount`, "must be one canonical non-negative integer string.");
      return result;
    })(),
    durationCoverage: exactEnum(object.durationCoverage, `${path}.durationCoverage`, ["complete", "partial", "none"]) as CutDecodedVideoCadence["durationCoverage"],
    recordsSha256: digest(object.recordsSha256, `${path}.recordsSha256`, context),
    timeBase: rationalValue(object.timeBase, `${path}.timeBase`, context, true),
    frameRate: rationalValue(object.frameRate, `${path}.frameRate`, context, true),
  };
}

function validateDecodedAudioSamples(value: unknown, path: string, context: ValidationContext): CutDecodedAudioSamples {
  const candidate = record(value, path), current = candidate.version === 2;
  const object = closed(value, path, [
    "decodedSampleCount", "decoderOutputSampleCount", "decoderPcmSha256", "durationCoverage", "durationPresentCount", "firstPts", "format", "frameCount",
    "lastPts", "method", "phaseNumerator", "quantization", "recordsSha256", "sampleRate", "streamIndex",
    "terminalTrimSamples", "timeBase", "trimSemantics", "version",
    ...(current ? ["leadingDiscontinuityFrameCount", "leadingDiscontinuitySampleCount"] : []),
  ]);
  const historical = object.format === "cut-decoded-audio-samples" && object.version === 1 && object.method === "ffprobe-show-frames-audio-v1"
    && object.quantization === "phase-floor" && object.trimSemantics === "decoder-output-plus-terminal-duration";
  const supportedCurrent = object.format === "cut-decoded-audio-samples" && object.version === 2 && object.method === "ffprobe-show-frames-audio-v2"
    && object.quantization === "phase-floor-start-or-exact-end" && object.trimSemantics === "decoder-output-sequence-plus-terminal-duration";
  if (!historical && !supportedCurrent) fail("CUT_LOCK_VERSION", path, "requires a supported cut-decoded-audio-samples witness.");
  const integerString = (name: "firstPts" | "lastPts", positive = false) => {
    const result = text(object[name], `${path}.${name}`, context, context.limits.maxRationalDigits + 1);
    if (!(positive ? positiveIntegerText : integerText).test(result) || result === "-0") fail("CUT_LOCK_RATIONAL", `${path}.${name}`, "must be one canonical exact integer string.");
    return result;
  };
  const nonNegativeString = (name: "durationPresentCount" | "phaseNumerator" | "terminalTrimSamples" | "leadingDiscontinuityFrameCount" | "leadingDiscontinuitySampleCount") => {
    const result = text(object[name], `${path}.${name}`, context, context.limits.maxRationalDigits);
    if (!/^(?:0|[1-9]\d*)$/u.test(result)) fail("CUT_LOCK_RATIONAL", `${path}.${name}`, "must be one canonical non-negative integer string.");
    return result;
  };
  const positiveString = (name: "decodedSampleCount" | "decoderOutputSampleCount" | "frameCount") => {
    const result = text(object[name], `${path}.${name}`, context, context.limits.maxRationalDigits);
    if (!positiveIntegerText.test(result)) fail("CUT_LOCK_RATIONAL", `${path}.${name}`, "must be one canonical positive integer string.");
    return result;
  };
  const common = {
    phaseNumerator: nonNegativeString("phaseNumerator"),
    streamIndex: safeInteger(object.streamIndex, `${path}.streamIndex`),
    firstPts: integerString("firstPts"),
    lastPts: integerString("lastPts"),
    frameCount: positiveString("frameCount"),
    decoderOutputSampleCount: positiveString("decoderOutputSampleCount"),
    decoderPcmSha256: digest(object.decoderPcmSha256, `${path}.decoderPcmSha256`, context),
    decodedSampleCount: positiveString("decodedSampleCount"),
    terminalTrimSamples: nonNegativeString("terminalTrimSamples"),
    durationPresentCount: nonNegativeString("durationPresentCount"),
    durationCoverage: exactEnum(object.durationCoverage, `${path}.durationCoverage`, ["complete", "partial", "none"]) as CutDecodedAudioSamples["durationCoverage"],
    recordsSha256: digest(object.recordsSha256, `${path}.recordsSha256`, context),
    timeBase: rationalValue(object.timeBase, `${path}.timeBase`, context, true),
    sampleRate: safeInteger(object.sampleRate, `${path}.sampleRate`, 1, 1_048_576),
  };
  if (current) {
    return {
      format: "cut-decoded-audio-samples",
      version: 2,
      method: "ffprobe-show-frames-audio-v2",
      quantization: "phase-floor-start-or-exact-end",
      trimSemantics: "decoder-output-sequence-plus-terminal-duration",
      ...common,
      leadingDiscontinuityFrameCount: nonNegativeString("leadingDiscontinuityFrameCount"),
      leadingDiscontinuitySampleCount: nonNegativeString("leadingDiscontinuitySampleCount"),
    };
  }
  return {
    format: "cut-decoded-audio-samples",
    version: 1,
    method: "ffprobe-show-frames-audio-v1",
    quantization: "phase-floor",
    trimSemantics: "decoder-output-plus-terminal-duration",
    ...common,
  };
}

function validateAudioProxyAlignment(
  value: unknown,
  path: string,
  context: ValidationContext,
  masterFile: { sha256: string },
  proxyFile: { sha256: string },
  masterProbe: LockedResourceProbe,
  proxyProbe: LockedResourceProbe,
): CutAudioProxyAlignment {
  const object = closed(value, path, ["analysis", "decision", "format", "integrity", "master", "method", "metrics", "policy", "proxy", "version"]);
  const isV1 = object.format === cutAudioProxyAlignmentContractV1.format
    && object.version === cutAudioProxyAlignmentContractV1.version
    && object.method === cutAudioProxyAlignmentContractV1.method;
  const isV2 = object.format === cutAudioProxyAlignmentContractV2.format
    && object.version === cutAudioProxyAlignmentContractV2.version
    && object.method === cutAudioProxyAlignmentContractV2.method;
  if (!isV1 && !isV2) {
    fail(
      "CUT_LOCK_VERSION",
      path,
      `requires ${cutAudioProxyAlignmentContractV1.format} v1/${cutAudioProxyAlignmentContractV1.method} or v2/${cutAudioProxyAlignmentContractV2.method}.`,
    );
  }
  const contract = isV2 ? cutAudioProxyAlignmentContractV2 : cutAudioProxyAlignmentContractV1;
  if (object.decision !== "equivalent") fail("CUT_LOCK_ENUM", `${path}.decision`, "must be equivalent.");
  const positiveString = (input: unknown, inputPath: string) => {
    const result = text(input, inputPath, context, context.limits.maxRationalDigits);
    if (!positiveIntegerText.test(result)) fail("CUT_LOCK_RATIONAL", inputPath, "must be one canonical positive integer string.");
    return result;
  };
  const nonNegativeString = (input: unknown, inputPath: string) => {
    const result = text(input, inputPath, context, context.limits.maxRationalDigits);
    if (!/^(?:0|[1-9]\d*)$/u.test(result)) fail("CUT_LOCK_RATIONAL", inputPath, "must be one canonical non-negative integer string.");
    return result;
  };
  const analysisObject = closed(
    object.analysis,
    `${path}.analysis`,
    isV2
      ? ["bytesPerVariant", "channels", "envelopeHopFrames", "envelopeWindowFrames", "frameCount", "frequencyCoverage", "sampleFormat", "sampleRate", "windowFrames"]
      : ["bytesPerVariant", "channels", "frameCount", "frequencyCoverage", "sampleFormat", "sampleRate", "windowFrames"],
  );
  if (analysisObject.sampleRate !== contract.analysisSampleRate || analysisObject.windowFrames !== contract.analysisWindowFrames
    || analysisObject.sampleFormat !== "s16le-interleaved" || analysisObject.frequencyCoverage !== "dc-through-8khz") {
    fail("CUT_LOCK_METADATA", `${path}.analysis`, "does not match the fixed CUT audio-proxy analysis contract.");
  }
  if (isV2 && (analysisObject.envelopeWindowFrames !== cutAudioProxyAlignmentContractV2.envelopeWindowFrames
    || analysisObject.envelopeHopFrames !== cutAudioProxyAlignmentContractV2.envelopeHopFrames)) {
    fail("CUT_LOCK_METADATA", `${path}.analysis`, "does not match the fixed CUT v2 envelope-analysis geometry.");
  }
  const commonAnalysis = {
    sampleRate: contract.analysisSampleRate,
    sampleFormat: "s16le-interleaved" as const,
    windowFrames: contract.analysisWindowFrames,
    channels: safeInteger(analysisObject.channels, `${path}.analysis.channels`, 1, 64),
    frameCount: positiveString(analysisObject.frameCount, `${path}.analysis.frameCount`),
    bytesPerVariant: positiveString(analysisObject.bytesPerVariant, `${path}.analysis.bytesPerVariant`),
    frequencyCoverage: "dc-through-8khz" as const,
  };
  const analysis = isV2 ? {
    ...commonAnalysis,
    envelopeWindowFrames: cutAudioProxyAlignmentContractV2.envelopeWindowFrames,
    envelopeHopFrames: cutAudioProxyAlignmentContractV2.envelopeHopFrames,
  } : commonAnalysis;
  const variant = (input: unknown, variantPath: string) => {
    const variantObject = closed(input, variantPath, ["analysisPcmSha256", "decodedSampleCount", "fileSha256", "sourceSampleRate", "streamIndex"]);
    return {
      fileSha256: digest(variantObject.fileSha256, `${variantPath}.fileSha256`, context),
      streamIndex: safeInteger(variantObject.streamIndex, `${variantPath}.streamIndex`),
      sourceSampleRate: safeInteger(variantObject.sourceSampleRate, `${variantPath}.sourceSampleRate`, 1, 1_048_576),
      decodedSampleCount: positiveString(variantObject.decodedSampleCount, `${variantPath}.decodedSampleCount`),
      analysisPcmSha256: digest(variantObject.analysisPcmSha256, `${variantPath}.analysisPcmSha256`, context),
    };
  };
  const master = variant(object.master, `${path}.master`), proxy = variant(object.proxy, `${path}.proxy`);
  const policyObject = closed(
    object.policy,
    `${path}.policy`,
    isV2
      ? [
          "activeRmsS16", "maximumEnergyPowerRatio", "maximumFailedChannelWindows", "maximumFailedEnvelopeChannelWindows",
          "maximumGainNormalizedResidualPowerPpm", "maximumEnvelopeEnergyRatioPpm", "minimumEnvelopeEnergyRatioPpm",
          "minimumGlobalCorrelationPpm", "minimumWindowCorrelationPpm", "silenceRmsS16",
        ]
      : ["activeRmsS16", "maximumEnergyPowerRatio", "maximumFailedChannelWindows", "minimumGlobalCorrelationPpm", "minimumWindowCorrelationPpm", "silenceRmsS16"],
  );
  const commonPolicy = {
    silenceRmsS16: safeInteger(policyObject.silenceRmsS16, `${path}.policy.silenceRmsS16`, contract.silenceRmsS16, contract.silenceRmsS16) as 128,
    activeRmsS16: safeInteger(policyObject.activeRmsS16, `${path}.policy.activeRmsS16`, contract.activeRmsS16, contract.activeRmsS16) as 256,
    maximumEnergyPowerRatio: safeInteger(policyObject.maximumEnergyPowerRatio, `${path}.policy.maximumEnergyPowerRatio`, contract.maximumEnergyPowerRatio, contract.maximumEnergyPowerRatio) as 4,
    minimumGlobalCorrelationPpm: safeInteger(policyObject.minimumGlobalCorrelationPpm, `${path}.policy.minimumGlobalCorrelationPpm`, contract.minimumGlobalCorrelationPpm, contract.minimumGlobalCorrelationPpm) as 970_000,
    minimumWindowCorrelationPpm: safeInteger(policyObject.minimumWindowCorrelationPpm, `${path}.policy.minimumWindowCorrelationPpm`, contract.minimumWindowCorrelationPpm, contract.minimumWindowCorrelationPpm) as 900_000,
    maximumFailedChannelWindows: safeInteger(policyObject.maximumFailedChannelWindows, `${path}.policy.maximumFailedChannelWindows`, contract.maximumFailedChannelWindows, contract.maximumFailedChannelWindows) as 0,
  };
  const policy = isV2 ? {
    ...commonPolicy,
    maximumGainNormalizedResidualPowerPpm: safeInteger(
      policyObject.maximumGainNormalizedResidualPowerPpm,
      `${path}.policy.maximumGainNormalizedResidualPowerPpm`,
      cutAudioProxyAlignmentContractV2.maximumGainNormalizedResidualPowerPpm,
      cutAudioProxyAlignmentContractV2.maximumGainNormalizedResidualPowerPpm,
    ) as 20_000,
    minimumEnvelopeEnergyRatioPpm: safeInteger(
      policyObject.minimumEnvelopeEnergyRatioPpm,
      `${path}.policy.minimumEnvelopeEnergyRatioPpm`,
      cutAudioProxyAlignmentContractV2.minimumEnvelopeEnergyRatioPpm,
      cutAudioProxyAlignmentContractV2.minimumEnvelopeEnergyRatioPpm,
    ) as 850_000,
    maximumEnvelopeEnergyRatioPpm: safeInteger(
      policyObject.maximumEnvelopeEnergyRatioPpm,
      `${path}.policy.maximumEnvelopeEnergyRatioPpm`,
      cutAudioProxyAlignmentContractV2.maximumEnvelopeEnergyRatioPpm,
      cutAudioProxyAlignmentContractV2.maximumEnvelopeEnergyRatioPpm,
    ) as 1_250_000,
    maximumFailedEnvelopeChannelWindows: safeInteger(
      policyObject.maximumFailedEnvelopeChannelWindows,
      `${path}.policy.maximumFailedEnvelopeChannelWindows`,
      cutAudioProxyAlignmentContractV2.maximumFailedEnvelopeChannelWindows,
      cutAudioProxyAlignmentContractV2.maximumFailedEnvelopeChannelWindows,
    ) as 0,
  } : commonPolicy;
  const commonMetricFields = [
    "channelGlobalCorrelationPpm", "energyMismatchChannelWindows", "evaluatedChannelWindows", "failedChannelWindows", "minimumGlobalCorrelationPpm",
    "minimumWindowCorrelationPpm", "passedChannelWindows", "silenceMismatchChannelWindows", "silentChannelWindows", "totalChannelWindows",
  ];
  const metricsObject = closed(object.metrics, `${path}.metrics`, isV2 ? [
    ...commonMetricFields,
    "channelMaximumGainNormalizedResidualPowerPpm", "channelMaximumEnvelopeEnergyRatioPpm", "channelMinimumEnvelopeEnergyRatioPpm",
    "evaluatedEnvelopeChannelWindows", "failedEnvelopeChannelWindows", "maximumEnvelopeEnergyRatioPpm",
    "maximumGainNormalizedResidualPowerPpm", "minimumEnvelopeEnergyRatioPpm", "passedEnvelopeChannelWindows",
    "silentEnvelopeChannelWindows", "totalEnvelopeChannelWindows",
  ] : commonMetricFields);
  if (!Array.isArray(metricsObject.channelGlobalCorrelationPpm) || metricsObject.channelGlobalCorrelationPpm.length !== analysis.channels) {
    fail("CUT_LOCK_METADATA", `${path}.metrics.channelGlobalCorrelationPpm`, "must contain exactly one entry per selected channel.");
  }
  const channelGlobalCorrelationPpm = metricsObject.channelGlobalCorrelationPpm.map((entry, index) => safeInteger(entry, `${path}.metrics.channelGlobalCorrelationPpm[${index}]`, 0, 1_000_000));
  const commonMetrics = {
    channelGlobalCorrelationPpm,
    minimumGlobalCorrelationPpm: safeInteger(metricsObject.minimumGlobalCorrelationPpm, `${path}.metrics.minimumGlobalCorrelationPpm`, 0, 1_000_000),
    minimumWindowCorrelationPpm: safeInteger(metricsObject.minimumWindowCorrelationPpm, `${path}.metrics.minimumWindowCorrelationPpm`, 0, 1_000_000),
    totalChannelWindows: nonNegativeString(metricsObject.totalChannelWindows, `${path}.metrics.totalChannelWindows`),
    silentChannelWindows: nonNegativeString(metricsObject.silentChannelWindows, `${path}.metrics.silentChannelWindows`),
    evaluatedChannelWindows: nonNegativeString(metricsObject.evaluatedChannelWindows, `${path}.metrics.evaluatedChannelWindows`),
    passedChannelWindows: nonNegativeString(metricsObject.passedChannelWindows, `${path}.metrics.passedChannelWindows`),
    failedChannelWindows: nonNegativeString(metricsObject.failedChannelWindows, `${path}.metrics.failedChannelWindows`),
    silenceMismatchChannelWindows: nonNegativeString(metricsObject.silenceMismatchChannelWindows, `${path}.metrics.silenceMismatchChannelWindows`),
    energyMismatchChannelWindows: nonNegativeString(metricsObject.energyMismatchChannelWindows, `${path}.metrics.energyMismatchChannelWindows`),
  };
  type ParsedV2Metrics = typeof commonMetrics & {
    channelMaximumGainNormalizedResidualPowerPpm: number[];
    maximumGainNormalizedResidualPowerPpm: number;
    channelMinimumEnvelopeEnergyRatioPpm: number[];
    channelMaximumEnvelopeEnergyRatioPpm: number[];
    minimumEnvelopeEnergyRatioPpm: number;
    maximumEnvelopeEnergyRatioPpm: number;
    totalEnvelopeChannelWindows: string;
    silentEnvelopeChannelWindows: string;
    evaluatedEnvelopeChannelWindows: string;
    passedEnvelopeChannelWindows: string;
    failedEnvelopeChannelWindows: string;
  };
  let metrics: typeof commonMetrics | ParsedV2Metrics = commonMetrics;
  if (isV2) {
    const channelMetric = (name: "channelMaximumGainNormalizedResidualPowerPpm" | "channelMinimumEnvelopeEnergyRatioPpm" | "channelMaximumEnvelopeEnergyRatioPpm", maximum = Number.MAX_SAFE_INTEGER) => {
      const input = metricsObject[name];
      if (!Array.isArray(input) || input.length !== analysis.channels) {
        fail("CUT_LOCK_METADATA", `${path}.metrics.${name}`, "must contain exactly one entry per selected channel.");
      }
      return input.map((entry, index) => safeInteger(entry, `${path}.metrics.${name}[${index}]`, 0, maximum));
    };
    const residualByChannel = channelMetric("channelMaximumGainNormalizedResidualPowerPpm", 1_000_000);
    const envelopeMinimumByChannel = channelMetric("channelMinimumEnvelopeEnergyRatioPpm");
    const envelopeMaximumByChannel = channelMetric("channelMaximumEnvelopeEnergyRatioPpm");
    metrics = {
      ...commonMetrics,
      channelMaximumGainNormalizedResidualPowerPpm: residualByChannel,
      maximumGainNormalizedResidualPowerPpm: safeInteger(metricsObject.maximumGainNormalizedResidualPowerPpm, `${path}.metrics.maximumGainNormalizedResidualPowerPpm`, 0, 1_000_000),
      channelMinimumEnvelopeEnergyRatioPpm: envelopeMinimumByChannel,
      channelMaximumEnvelopeEnergyRatioPpm: envelopeMaximumByChannel,
      minimumEnvelopeEnergyRatioPpm: safeInteger(metricsObject.minimumEnvelopeEnergyRatioPpm, `${path}.metrics.minimumEnvelopeEnergyRatioPpm`),
      maximumEnvelopeEnergyRatioPpm: safeInteger(metricsObject.maximumEnvelopeEnergyRatioPpm, `${path}.metrics.maximumEnvelopeEnergyRatioPpm`),
      totalEnvelopeChannelWindows: nonNegativeString(metricsObject.totalEnvelopeChannelWindows, `${path}.metrics.totalEnvelopeChannelWindows`),
      silentEnvelopeChannelWindows: nonNegativeString(metricsObject.silentEnvelopeChannelWindows, `${path}.metrics.silentEnvelopeChannelWindows`),
      evaluatedEnvelopeChannelWindows: nonNegativeString(metricsObject.evaluatedEnvelopeChannelWindows, `${path}.metrics.evaluatedEnvelopeChannelWindows`),
      passedEnvelopeChannelWindows: nonNegativeString(metricsObject.passedEnvelopeChannelWindows, `${path}.metrics.passedEnvelopeChannelWindows`),
      failedEnvelopeChannelWindows: nonNegativeString(metricsObject.failedEnvelopeChannelWindows, `${path}.metrics.failedEnvelopeChannelWindows`),
    };
  }
  const frameCount = BigInt(analysis.frameCount), bytes = BigInt(analysis.bytesPerVariant);
  if (bytes !== frameCount * BigInt(analysis.channels * 2) || bytes > BigInt(contract.maximumAnalysisBytesPerVariant)) {
    fail("CUT_LOCK_LIMIT", `${path}.analysis.bytesPerVariant`, "does not match the bounded interleaved PCM geometry.");
  }
  const expectedChannelWindows = ((frameCount + BigInt(analysis.windowFrames) - 1n) / BigInt(analysis.windowFrames)) * BigInt(analysis.channels);
  if (BigInt(metrics.totalChannelWindows) !== expectedChannelWindows
    || BigInt(metrics.silentChannelWindows) + BigInt(metrics.evaluatedChannelWindows) !== expectedChannelWindows
    || BigInt(metrics.passedChannelWindows) + BigInt(metrics.failedChannelWindows) !== BigInt(metrics.evaluatedChannelWindows)) {
    fail("CUT_LOCK_METADATA", `${path}.metrics`, "channel-window counts do not close over the declared PCM geometry.");
  }
  if (metrics.minimumGlobalCorrelationPpm !== Math.min(...channelGlobalCorrelationPpm)
    || metrics.minimumGlobalCorrelationPpm < policy.minimumGlobalCorrelationPpm
    || metrics.minimumWindowCorrelationPpm < policy.minimumWindowCorrelationPpm
    || BigInt(metrics.failedChannelWindows) > BigInt(policy.maximumFailedChannelWindows)
    || metrics.silenceMismatchChannelWindows !== "0" || metrics.energyMismatchChannelWindows !== "0") {
    fail("CUT_PROXY_AUDIO_ALIGNMENT", `${path}.metrics`, "does not satisfy the fixed equivalent-proxy decision policy.");
  }
  if (isV2) {
    const currentMetrics = metrics as ParsedV2Metrics;
    const currentPolicy = policy as typeof policy & {
      maximumGainNormalizedResidualPowerPpm: number;
      minimumEnvelopeEnergyRatioPpm: number;
      maximumEnvelopeEnergyRatioPpm: number;
      maximumFailedEnvelopeChannelWindows: number;
    };
    const expectedEnvelopeChannelWindows = cutAudioProxyEnvelopeWindowCount(frameCount) * BigInt(analysis.channels);
    if (BigInt(currentMetrics.totalEnvelopeChannelWindows) !== expectedEnvelopeChannelWindows
      || BigInt(currentMetrics.silentEnvelopeChannelWindows) + BigInt(currentMetrics.evaluatedEnvelopeChannelWindows) !== expectedEnvelopeChannelWindows
      || BigInt(currentMetrics.passedEnvelopeChannelWindows) + BigInt(currentMetrics.failedEnvelopeChannelWindows) !== BigInt(currentMetrics.evaluatedEnvelopeChannelWindows)) {
      fail("CUT_LOCK_METADATA", `${path}.metrics`, "envelope channel-window counts do not close over the declared PCM geometry.");
    }
    if (currentMetrics.maximumGainNormalizedResidualPowerPpm !== Math.max(...currentMetrics.channelMaximumGainNormalizedResidualPowerPpm)
      || currentMetrics.minimumEnvelopeEnergyRatioPpm !== Math.min(...currentMetrics.channelMinimumEnvelopeEnergyRatioPpm)
      || currentMetrics.maximumEnvelopeEnergyRatioPpm !== Math.max(...currentMetrics.channelMaximumEnvelopeEnergyRatioPpm)) {
      fail("CUT_LOCK_METADATA", `${path}.metrics`, "aggregate v2 residual/envelope metrics must equal their per-channel extrema.");
    }
    if (currentMetrics.channelMinimumEnvelopeEnergyRatioPpm.some((entry, index) => entry > currentMetrics.channelMaximumEnvelopeEnergyRatioPpm[index])
      || currentMetrics.maximumGainNormalizedResidualPowerPpm > currentPolicy.maximumGainNormalizedResidualPowerPpm
      || currentMetrics.minimumEnvelopeEnergyRatioPpm < currentPolicy.minimumEnvelopeEnergyRatioPpm
      || currentMetrics.maximumEnvelopeEnergyRatioPpm > currentPolicy.maximumEnvelopeEnergyRatioPpm
      || BigInt(currentMetrics.failedEnvelopeChannelWindows) > BigInt(currentPolicy.maximumFailedEnvelopeChannelWindows)) {
      fail("CUT_PROXY_AUDIO_ALIGNMENT", `${path}.metrics`, "does not satisfy the fixed v2 residual/envelope equivalent-proxy policy.");
    }
  }
  if (master.fileSha256 !== masterFile.sha256 || proxy.fileSha256 !== proxyFile.sha256) {
    fail("CUT_LOCK_IDENTITY", path, "audio alignment file hashes must match the enclosing master/proxy variants.");
  }
  const selected = (probe: LockedResourceProbe, side: typeof master, sidePath: string) => {
    if (probe.kind !== "media" || !probe.selected.audio?.decodedAudioSamples) fail("CUT_PROXY_AUDIO_ALIGNMENT", sidePath, "requires one decoded-audio-samples selected stream.");
    const selection = probe.selected.audio, decodedSamples = selection.decodedAudioSamples;
    if (!decodedSamples) fail("CUT_PROXY_AUDIO_ALIGNMENT", sidePath, "requires one decoded-audio-samples selected stream.");
    const stream = probe.identity.streams.find((candidate) => candidate.type === "audio" && candidate.index === selection.streamIndex);
    if (!stream?.sampleRate || !stream.channels) fail("CUT_PROXY_AUDIO_ALIGNMENT", sidePath, "selected audio stream metadata is incomplete.");
    if (side.streamIndex !== selection.streamIndex || side.sourceSampleRate !== stream.sampleRate
      || side.decodedSampleCount !== decodedSamples.decodedSampleCount || analysis.channels !== stream.channels) {
      fail("CUT_LOCK_IDENTITY", sidePath, "does not match its enclosing selected decoded audio stream.");
    }
  };
  selected(masterProbe, master, `${path}.master`); selected(proxyProbe, proxy, `${path}.proxy`);
  const integrity = digest(object.integrity, `${path}.integrity`, context);
  if (isV2) {
    const base = {
      format: cutAudioProxyAlignmentContractV2.format,
      version: cutAudioProxyAlignmentContractV2.version,
      method: cutAudioProxyAlignmentContractV2.method,
      analysis,
      master,
      proxy,
      policy,
      metrics,
      decision: "equivalent" as const,
    } as Omit<CutAudioProxyAlignmentV2, "integrity">;
    if (integrity !== cutAudioProxyAlignmentIntegrity(base)) fail("CUT_LOCK_IDENTITY", `${path}.integrity`, "does not match the canonical audio-proxy alignment evidence.");
    return { ...base, integrity };
  }
  const base = {
    format: cutAudioProxyAlignmentContractV1.format,
    version: cutAudioProxyAlignmentContractV1.version,
    method: cutAudioProxyAlignmentContractV1.method,
    analysis,
    master,
    proxy,
    policy,
    metrics,
    decision: "equivalent" as const,
  } as Omit<CutAudioProxyAlignmentV1, "integrity">;
  if (integrity !== cutAudioProxyAlignmentIntegrity(base)) fail("CUT_LOCK_IDENTITY", `${path}.integrity`, "does not match the canonical audio-proxy alignment evidence.");
  return { ...base, integrity };
}

function validateVideoProxyAlignment(
  value: unknown,
  path: string,
  context: ValidationContext,
  masterFile: { sha256: string },
  proxyFile: { sha256: string },
  masterProbe: LockedResourceProbe,
  proxyProbe: LockedResourceProbe,
): CutVideoProxyAlignment {
  const contract = cutVideoProxyAlignmentContract;
  const object = closed(value, path, ["analysis", "decision", "format", "integrity", "master", "method", "metrics", "policy", "proxy", "version"]);
  if (object.format !== contract.format || object.version !== contract.version || object.method !== contract.method) {
    fail("CUT_LOCK_VERSION", path, `requires ${contract.format} v${contract.version}/${contract.method}.`);
  }
  if (object.decision !== "equivalent") fail("CUT_LOCK_ENUM", `${path}.decision`, "must be equivalent.");
  const positiveString = (input: unknown, inputPath: string) => {
    const result = text(input, inputPath, context, context.limits.maxRationalDigits);
    if (!positiveIntegerText.test(result)) fail("CUT_LOCK_RATIONAL", inputPath, "must be one canonical positive integer string.");
    return result;
  };
  const nonNegativeString = (input: unknown, inputPath: string) => {
    const result = text(input, inputPath, context, context.limits.maxRationalDigits);
    if (!/^(?:0|[1-9]\d*)$/u.test(result)) fail("CUT_LOCK_RATIONAL", inputPath, "must be one canonical non-negative integer string.");
    return result;
  };
  const analysisObject = closed(object.analysis, `${path}.analysis`, ["bytesPerFrame", "bytesPerVariant", "frameCount", "height", "pixelFormat", "scaling", "width"]);
  if (analysisObject.width !== contract.analysisWidth || analysisObject.height !== contract.analysisHeight
    || analysisObject.bytesPerFrame !== contract.bytesPerFrame || analysisObject.pixelFormat !== "rgb24"
    || analysisObject.scaling !== "fit-pad-black-area") {
    fail("CUT_LOCK_METADATA", `${path}.analysis`, "does not match the fixed CUT video-proxy analysis contract.");
  }
  const analysis = {
    width: contract.analysisWidth,
    height: contract.analysisHeight,
    pixelFormat: "rgb24" as const,
    scaling: "fit-pad-black-area" as const,
    frameCount: positiveString(analysisObject.frameCount, `${path}.analysis.frameCount`),
    bytesPerFrame: contract.bytesPerFrame,
    bytesPerVariant: positiveString(analysisObject.bytesPerVariant, `${path}.analysis.bytesPerVariant`),
  };
  const variant = (input: unknown, variantPath: string) => {
    const variantObject = closed(input, variantPath, ["analysisRgbSha256", "cadenceRecordsSha256", "decodedFrameCount", "fileSha256", "sourceHeight", "sourceWidth", "streamIndex"]);
    return {
      fileSha256: digest(variantObject.fileSha256, `${variantPath}.fileSha256`, context),
      streamIndex: safeInteger(variantObject.streamIndex, `${variantPath}.streamIndex`),
      sourceWidth: safeInteger(variantObject.sourceWidth, `${variantPath}.sourceWidth`, 1, 65_535),
      sourceHeight: safeInteger(variantObject.sourceHeight, `${variantPath}.sourceHeight`, 1, 65_535),
      decodedFrameCount: positiveString(variantObject.decodedFrameCount, `${variantPath}.decodedFrameCount`),
      cadenceRecordsSha256: digest(variantObject.cadenceRecordsSha256, `${variantPath}.cadenceRecordsSha256`, context),
      analysisRgbSha256: digest(variantObject.analysisRgbSha256, `${variantPath}.analysisRgbSha256`, context),
    };
  };
  const master = variant(object.master, `${path}.master`), proxy = variant(object.proxy, `${path}.proxy`);
  const policyObject = closed(object.policy, `${path}.policy`, ["maximumFailedFrames", "maximumFrameMeanAbsoluteErrorPpm", "maximumMeanAbsoluteErrorPpm"]);
  const policy = {
    maximumMeanAbsoluteErrorPpm: safeInteger(
      policyObject.maximumMeanAbsoluteErrorPpm,
      `${path}.policy.maximumMeanAbsoluteErrorPpm`,
      contract.maximumMeanAbsoluteErrorPpm,
      contract.maximumMeanAbsoluteErrorPpm,
    ) as 100_000,
    maximumFrameMeanAbsoluteErrorPpm: safeInteger(
      policyObject.maximumFrameMeanAbsoluteErrorPpm,
      `${path}.policy.maximumFrameMeanAbsoluteErrorPpm`,
      contract.maximumFrameMeanAbsoluteErrorPpm,
      contract.maximumFrameMeanAbsoluteErrorPpm,
    ) as 180_000,
    maximumFailedFrames: safeInteger(
      policyObject.maximumFailedFrames,
      `${path}.policy.maximumFailedFrames`,
      contract.maximumFailedFrames,
      contract.maximumFailedFrames,
    ) as 0,
  };
  const metricsObject = closed(object.metrics, `${path}.metrics`, ["evaluatedFrames", "failedFrames", "maximumFrameMeanAbsoluteErrorPpm", "meanAbsoluteErrorPpm", "passedFrames"]);
  const metrics = {
    meanAbsoluteErrorPpm: safeInteger(metricsObject.meanAbsoluteErrorPpm, `${path}.metrics.meanAbsoluteErrorPpm`, 0, 1_000_000),
    maximumFrameMeanAbsoluteErrorPpm: safeInteger(metricsObject.maximumFrameMeanAbsoluteErrorPpm, `${path}.metrics.maximumFrameMeanAbsoluteErrorPpm`, 0, 1_000_000),
    evaluatedFrames: positiveString(metricsObject.evaluatedFrames, `${path}.metrics.evaluatedFrames`),
    passedFrames: nonNegativeString(metricsObject.passedFrames, `${path}.metrics.passedFrames`),
    failedFrames: nonNegativeString(metricsObject.failedFrames, `${path}.metrics.failedFrames`),
  };
  const frameCount = BigInt(analysis.frameCount), bytes = BigInt(analysis.bytesPerVariant);
  if (bytes !== frameCount * BigInt(contract.bytesPerFrame) || bytes > BigInt(contract.maximumAnalysisBytesPerVariant)) {
    fail("CUT_LOCK_LIMIT", `${path}.analysis.bytesPerVariant`, "does not match the bounded rgb24 frame geometry.");
  }
  if (BigInt(metrics.evaluatedFrames) !== frameCount
    || BigInt(metrics.passedFrames) + BigInt(metrics.failedFrames) !== frameCount) {
    fail("CUT_LOCK_METADATA", `${path}.metrics`, "frame counts do not close over the declared RGB geometry.");
  }
  if (metrics.meanAbsoluteErrorPpm > policy.maximumMeanAbsoluteErrorPpm
    || metrics.maximumFrameMeanAbsoluteErrorPpm > policy.maximumFrameMeanAbsoluteErrorPpm
    || BigInt(metrics.failedFrames) > BigInt(policy.maximumFailedFrames)) {
    fail("CUT_PROXY_VIDEO_ALIGNMENT", `${path}.metrics`, "does not satisfy the fixed equivalent-proxy picture policy.");
  }
  if (master.fileSha256 !== masterFile.sha256 || proxy.fileSha256 !== proxyFile.sha256) {
    fail("CUT_LOCK_IDENTITY", path, "video alignment file hashes must match the enclosing master/proxy variants.");
  }
  const selected = (probe: LockedResourceProbe, side: typeof master, sidePath: string) => {
    if (probe.kind !== "media" || !probe.selected.video?.decodedVideoCadence) {
      fail("CUT_PROXY_VIDEO_ALIGNMENT", sidePath, "requires one decoded-video-cadence selected stream.");
    }
    const selection = probe.selected.video, cadence = selection.decodedVideoCadence;
    if (!cadence) fail("CUT_PROXY_VIDEO_ALIGNMENT", sidePath, "requires one decoded-video-cadence selected stream.");
    const stream = probe.identity.streams.find((candidate) => candidate.type === "video" && candidate.index === selection.streamIndex);
    if (!stream?.width || !stream.height) fail("CUT_PROXY_VIDEO_ALIGNMENT", sidePath, "selected video stream metadata is incomplete.");
    if (side.streamIndex !== selection.streamIndex || side.sourceWidth !== stream.width || side.sourceHeight !== stream.height
      || side.decodedFrameCount !== cadence.frameCount || side.cadenceRecordsSha256 !== cadence.recordsSha256
      || analysis.frameCount !== cadence.frameCount) {
      fail("CUT_LOCK_IDENTITY", sidePath, "does not match its enclosing selected decoded video stream.");
    }
  };
  selected(masterProbe, master, `${path}.master`);
  selected(proxyProbe, proxy, `${path}.proxy`);
  if (BigInt(master.sourceWidth) * BigInt(proxy.sourceHeight) !== BigInt(proxy.sourceWidth) * BigInt(master.sourceHeight)) {
    fail("CUT_PROXY_VIDEO_ALIGNMENT", path, "master and proxy coded-frame aspect ratios must match exactly.");
  }
  const integrity = digest(object.integrity, `${path}.integrity`, context);
  const base: Omit<CutVideoProxyAlignment, "integrity"> = {
    format: contract.format,
    version: contract.version,
    method: contract.method,
    analysis,
    master,
    proxy,
    policy,
    metrics,
    decision: "equivalent",
  };
  if (integrity !== cutVideoProxyAlignmentIntegrity(base)) {
    fail("CUT_LOCK_IDENTITY", `${path}.integrity`, "does not match the canonical video-proxy alignment evidence.");
  }
  return { ...base, integrity };
}

function validateSelection(value: unknown, path: string, context: ValidationContext, expectedType: "video" | "audio", identity: ReturnType<typeof validateMediaIdentity>) {
  const object = closed(value, path, ["duration", "durationSource", "streamIndex", "timeBase"], ["decodedAudioSamples", "decodedVideoCadence", "frameRate"]);
  const streamIndex = safeInteger(object.streamIndex, `${path}.streamIndex`), stream = identity.streams.get(streamIndex);
  if (!stream || stream.type !== expectedType) fail("CUT_LOCK_METADATA", `${path}.streamIndex`, `must select an existing ${expectedType} stream.`);
  if (expectedType === "video" && (!stream.width || !stream.height)) fail("CUT_LOCK_METADATA", `${path}.streamIndex`, "selected video stream must carry exact dimensions.");
  if (expectedType === "audio" && (!stream.sampleRate || !stream.channels)) fail("CUT_LOCK_METADATA", `${path}.streamIndex`, "selected audio stream must carry exact sample-rate/channel metadata.");
  const timeBase = rationalValue(object.timeBase, `${path}.timeBase`, context, true);
  if (!stream.timeBase || compareRational(timeBase, stream.timeBase) !== 0) fail("CUT_LOCK_METADATA", `${path}.timeBase`, "must match the selected stream time base.");
  if (expectedType === "video") {
    if (!stream.start || compareRational(stream.start, zeroRational) < 0) fail("CUT_LOCK_METADATA", `${path}.streamIndex`, "selected video stream must carry an exact non-negative start.");
    if (!integralTicks(stream.start, timeBase)) fail("CUT_LOCK_METADATA", `${path}.streamIndex`, "selected video stream start must land on its exact codec time base.");
    if ((!stream.frameRate || compareRational(stream.frameRate, zeroRational) <= 0) && (!stream.averageFrameRate || compareRational(stream.averageFrameRate, zeroRational) <= 0)) fail("CUT_LOCK_METADATA", `${path}.streamIndex`, "selected video stream must carry a positive exact frame-rate candidate.");
  }
  if (expectedType === "audio" && Object.hasOwn(object, "frameRate")) fail("CUT_LOCK_METADATA", `${path}.frameRate`, "is valid only for selected video.");
  const selectedFrameRate = expectedType === "video"
    ? (Object.hasOwn(object, "frameRate") ? rationalValue(object.frameRate, `${path}.frameRate`, context, true) : stream.frameRate)
    : undefined;
  if (expectedType === "video" && (!selectedFrameRate || ![stream.frameRate, stream.averageFrameRate].some((candidate) => candidate && compareRational(candidate, selectedFrameRate) === 0))) {
    fail("CUT_LOCK_METADATA", `${path}.frameRate`, "must match one retained selected-stream frame-rate candidate.");
  }
  const duration = rationalValue(object.duration, `${path}.duration`, context, true);
  const durationSource = exactEnum(object.durationSource, `${path}.durationSource`, ["stream", "decoded-audio-samples", "decoded-video-cadence", "container"]);
  if (durationSource === "container") fail("CUT_LOCK_METADATA", `${path}.duration`, "a container-wide duration cannot safely bound an executable stream.");
  if (durationSource === "stream") {
    if (!stream.duration || compareRational(duration, stream.duration) !== 0) fail("CUT_LOCK_METADATA", `${path}.duration`, "must match the selected stream duration exactly.");
    if (Object.hasOwn(object, "decodedVideoCadence")) fail("CUT_LOCK_METADATA", `${path}.decodedVideoCadence`, "requires decoded-video-cadence duration authority.");
    if (Object.hasOwn(object, "decodedAudioSamples")) fail("CUT_LOCK_METADATA", `${path}.decodedAudioSamples`, "requires decoded-audio-samples duration authority.");
    return { streamIndex, duration, durationSource, timeBase, ...(selectedFrameRate ? { frameRate: selectedFrameRate } : {}) };
  }
  if (durationSource === "decoded-audio-samples") {
    if (expectedType !== "audio") fail("CUT_LOCK_METADATA", `${path}.durationSource`, "decoded-audio-samples authority is valid only for an audio stream.");
    if (!Object.hasOwn(object, "decodedAudioSamples")) fail("CUT_LOCK_MISSING_FIELD", `${path}.decodedAudioSamples`, "is required for decoded-audio-samples duration authority.");
    if (Object.hasOwn(object, "decodedVideoCadence")) fail("CUT_LOCK_METADATA", `${path}.decodedVideoCadence`, "is valid only for decoded-video-cadence authority.");
    const samples = validateDecodedAudioSamples(object.decodedAudioSamples, `${path}.decodedAudioSamples`, context);
    let derived: Rational;
    try { derived = decodedAudioSamplesDuration(samples, { index: streamIndex, timeBase: stream.timeBase, sampleRate: stream.sampleRate, duration: stream.duration }); }
    catch (error) { fail("CUT_LOCK_METADATA", `${path}.decodedAudioSamples`, error instanceof Error ? error.message : String(error)); }
    if (compareRational(duration, derived) !== 0) fail("CUT_LOCK_METADATA", `${path}.duration`, "must equal the exact duration derived from the decoded-audio-samples witness.");
    return { streamIndex, duration, durationSource, timeBase, decodedAudioSamples: samples };
  }
  if (expectedType !== "video") fail("CUT_LOCK_METADATA", `${path}.durationSource`, "decoded-video-cadence authority is valid only for a video stream.");
  if (Object.hasOwn(object, "decodedAudioSamples")) fail("CUT_LOCK_METADATA", `${path}.decodedAudioSamples`, "is valid only for decoded-audio-samples authority.");
  if (!Object.hasOwn(object, "decodedVideoCadence")) fail("CUT_LOCK_MISSING_FIELD", `${path}.decodedVideoCadence`, "is required for decoded-video-cadence duration authority.");
  const cadence = validateDecodedVideoCadence(object.decodedVideoCadence, `${path}.decodedVideoCadence`, context);
  let derived: Rational;
  try { derived = decodedVideoCadenceDuration(cadence, { index: streamIndex, start: stream.start, timeBase: stream.timeBase, frameRate: stream.frameRate, averageFrameRate: stream.averageFrameRate }); }
  catch (error) { fail("CUT_LOCK_METADATA", `${path}.decodedVideoCadence`, error instanceof Error ? error.message : String(error)); }
  if (compareRational(duration, derived) !== 0) fail("CUT_LOCK_METADATA", `${path}.duration`, "must equal the exact duration derived from the decoded-video-cadence witness.");
  // When cadence is authoritative, raw duration remains observation only.
  // MOV/MP4 duration_ts may span first-to-last PTS and omit the terminal frame
  // period; it cannot veto the stronger full decoded N/fps proof.
  if (!selectedFrameRate || compareRational(selectedFrameRate, cadence.frameRate) !== 0) fail("CUT_LOCK_METADATA", `${path}.frameRate`, "must match the decoded cadence witness frame rate.");
  return { streamIndex, duration, durationSource, timeBase, frameRate: selectedFrameRate, decodedVideoCadence: cadence };
}

function validateImageIdentity(value: unknown, path: string, context: ValidationContext) {
  const object = closed(value, path, ["file", "format", "image", "implementation", "version"]);
  if (object.format !== "cut-image-probe" || object.version !== 1) fail("CUT_LOCK_VERSION", path, "requires cut-image-probe v1.");
  const implementation = closed(object.implementation, `${path}.implementation`, ["libvips", "name", "version"]);
  if (implementation.name !== "sharp") fail("CUT_LOCK_ENUM", `${path}.implementation.name`, "must be sharp.");
  text(implementation.version, `${path}.implementation.version`, context, 64); text(implementation.libvips, `${path}.implementation.libvips`, context, 64);
  const file = validateFileIdentity(object.file, `${path}.file`, context);
  const image = closed(object.image, `${path}.image`, ["channels", "format", "hasAlpha", "height", "space", "width"], ["density", "depth", "orientation"]);
  const width = safeInteger(image.width, `${path}.image.width`, 1, 65_535), height = safeInteger(image.height, `${path}.image.height`, 1, 65_535);
  if (width * height > 268_435_456) fail("CUT_LOCK_LIMIT", `${path}.image`, "decoded dimensions exceed the hard 268435456-pixel metadata limit.");
  safeInteger(image.channels, `${path}.image.channels`, 1, 16);
  text(image.format, `${path}.image.format`, context, 64); text(image.space, `${path}.image.space`, context, 64); booleanValue(image.hasAlpha, `${path}.image.hasAlpha`);
  if (Object.hasOwn(image, "depth")) text(image.depth, `${path}.image.depth`, context, 64);
  if (Object.hasOwn(image, "density")) safeInteger(image.density, `${path}.image.density`, 1, 1_000_000);
  if (Object.hasOwn(image, "orientation")) safeInteger(image.orientation, `${path}.image.orientation`, 1, 8);
  return file;
}

const byteCoverage: Record<"font" | "data", string[]> = {
  font: ["font-table validation", "text shaping", "font fallback", "glyph rasterization"],
  data: ["data schema", "semantic interpretation", "external references"],
};

function validateLockedVariant(value: unknown, path: string, context: ValidationContext, kind: IRResource["kind"]) {
  const object = closed(value, path, ["bytes", "locator", "probe", "sha256"], ["audioAlignment", "videoAlignment"]);
  const locator = text(object.locator, `${path}.locator`, context, 4096); try { validateProjectLocator(locator, "resource locator"); } catch (error) { fail("CUT_LOCK_LOCATOR", `${path}.locator`, error instanceof Error ? error.message : String(error)); }
  const bytes = safeInteger(object.bytes, `${path}.bytes`), sha256 = digest(object.sha256, `${path}.sha256`, context);
  const probe = record(object.probe, `${path}.probe`), probeKind = exactEnum(probe.kind, `${path}.probe.kind`, ["media", "image", "bytes"]);
  let file: ReturnType<typeof validateFileIdentity>;
  if (probeKind === "media") {
    if (kind !== "video" && kind !== "audio") fail("CUT_LOCK_METADATA", `${path}.probe.kind`, "media probes are valid only for video/audio resources.");
    const media = closed(probe, `${path}.probe`, ["identity", "kind", "selected"]), identity = validateMediaIdentity(media.identity, `${path}.probe.identity`, context);
    const selected = closed(media.selected, `${path}.probe.selected`, [], ["audio", "video"]);
    if (kind === "video" && !Object.hasOwn(selected, "video")) fail("CUT_LOCK_METADATA", `${path}.probe.selected.video`, "is required for a video resource.");
    if (kind === "audio" && !Object.hasOwn(selected, "audio")) fail("CUT_LOCK_METADATA", `${path}.probe.selected.audio`, "is required for an audio resource.");
    if (Object.hasOwn(selected, "video")) validateSelection(selected.video, `${path}.probe.selected.video`, context, "video", identity);
    if (Object.hasOwn(selected, "audio")) validateSelection(selected.audio, `${path}.probe.selected.audio`, context, "audio", identity);
    file = identity.file;
  } else if (probeKind === "image") {
    if (kind !== "image") fail("CUT_LOCK_METADATA", `${path}.probe.kind`, "image probes are valid only for image resources.");
    const image = closed(probe, `${path}.probe`, ["identity", "kind"]); file = validateImageIdentity(image.identity, `${path}.probe.identity`, context);
  } else {
    if (kind !== "font" && kind !== "data") fail("CUT_LOCK_METADATA", `${path}.probe.kind`, "bytes-only probes are valid only for font/data resources.");
    const bytesProbe = closed(probe, `${path}.probe`, ["coverage", "identity", "kind"]), identity = closed(bytesProbe.identity, `${path}.probe.identity`, ["file", "format", "version"]);
    if (identity.format !== "cut-byte-probe" || identity.version !== 1) fail("CUT_LOCK_VERSION", `${path}.probe.identity`, "requires cut-byte-probe v1.");
    file = validateFileIdentity(identity.file, `${path}.probe.identity.file`, context);
    const coverage = closed(bytesProbe.coverage, `${path}.probe.coverage`, ["excludes", "level"]);
    if (coverage.level !== "bytes-only") fail("CUT_LOCK_ENUM", `${path}.probe.coverage.level`, "must be bytes-only.");
    const excludes = stringArray(coverage.excludes, `${path}.probe.coverage.excludes`, context, 16, 256);
    if (stableJsonStringify(excludes) !== stableJsonStringify(byteCoverage[kind])) fail("CUT_LOCK_METADATA", `${path}.probe.coverage.excludes`, `must state the exact current ${kind} lock boundary.`);
  }
  if (file.locator !== locator || file.bytes !== bytes || file.sha256 !== sha256) fail("CUT_LOCK_IDENTITY", path, "resource identity must exactly match its probe file identity.");
}

function validateLockedResource(value: unknown, path: string, context: ValidationContext, key: string) {
  const object = closed(value, path, ["bytes", "id", "kind", "locator", "probe", "sha256"], ["byteAuthority", "proxy"]);
  const id = identifier(object.id, `${path}.id`, context); if (id !== key) fail("CUT_LOCK_IDENTITY", `${path}.id`, `must match resource key “${key}”.`);
  const kind = exactEnum(object.kind, `${path}.kind`, ["video", "audio", "image", "font", "data"]) as IRResource["kind"];
  if (Object.hasOwn(object, "byteAuthority")) {
    if (kind !== "data") fail("CUT_LOCK_METADATA", `${path}.byteAuthority`, "is valid only for outer data resources.");
    try { validateCutTypedDataAssetAuthority(object.byteAuthority, `${path}.byteAuthority`); }
    catch (error) {
      if (error instanceof CutTypedDataAssetAuthorityError) fail(error.code, error.path, error.message);
      throw error;
    }
  }
  validateLockedVariant({ bytes: object.bytes, locator: object.locator, probe: object.probe, sha256: object.sha256 }, path, context, kind);
  if (Object.hasOwn(object, "proxy")) {
    if (kind !== "video" && kind !== "audio") fail("CUT_LOCK_METADATA", `${path}.proxy`, "proxy variants are valid only for video/audio resources.");
    validateLockedVariant(object.proxy, `${path}.proxy`, context, kind);
    const proxy = record(object.proxy, `${path}.proxy`);
    if (proxy.locator === object.locator) fail("CUT_PROXY_NOOP", `${path}.proxy.locator`, "must differ from the master locator.");
    const issue = proxyEquivalenceIssue(kind, object.probe as LockedResourceProbe, proxy.probe as LockedResourceProbe);
    if (issue) fail(issue.code, `${path}.proxy.probe`, issue.message);
    const masterProbe = object.probe as LockedResourceProbe, proxyProbe = proxy.probe as LockedResourceProbe;
    const carriesAudio = masterProbe.kind === "media" && proxyProbe.kind === "media"
      && Boolean(masterProbe.selected.audio) && Boolean(proxyProbe.selected.audio);
    if (carriesAudio) {
      if (!Object.hasOwn(proxy, "audioAlignment")) fail("CUT_LOCK_MISSING_FIELD", `${path}.proxy.audioAlignment`, "is required when an executable audio stream has a proxy.");
      validateAudioProxyAlignment(
        proxy.audioAlignment,
        `${path}.proxy.audioAlignment`,
        context,
        { sha256: object.sha256 as string },
        { sha256: proxy.sha256 as string },
        masterProbe,
        proxyProbe,
      );
    } else if (Object.hasOwn(proxy, "audioAlignment")) {
      fail("CUT_PROXY_AUDIO_ALIGNMENT", `${path}.proxy.audioAlignment`, "is valid only when both variants select executable audio.");
    }
    const carriesVideo = masterProbe.kind === "media" && proxyProbe.kind === "media"
      && Boolean(masterProbe.selected.video) && Boolean(proxyProbe.selected.video);
    if (carriesVideo) {
      if (!Object.hasOwn(proxy, "videoAlignment")) fail("CUT_LOCK_MISSING_FIELD", `${path}.proxy.videoAlignment`, "is required when an executable video stream has a proxy.");
      validateVideoProxyAlignment(
        proxy.videoAlignment,
        `${path}.proxy.videoAlignment`,
        context,
        { sha256: object.sha256 as string },
        { sha256: proxy.sha256 as string },
        masterProbe,
        proxyProbe,
      );
    } else if (Object.hasOwn(proxy, "videoAlignment")) {
      fail("CUT_PROXY_VIDEO_ALIGNMENT", `${path}.proxy.videoAlignment`, "is valid only when both variants select executable video.");
    }
  }
}

function limits(overrides: Partial<CutLockValidationLimits>) {
  if (!isRecord(overrides)) fail("CUT_LOCK_TYPE", "$.options.limits", "must be a plain object.");
  const allowed = new Set(Object.keys(defaultCutLockValidationLimits));
  for (const key of Object.keys(overrides)) if (!allowed.has(key)) fail("CUT_LOCK_UNKNOWN_FIELD", `$.options.limits.${key}`, "is not a supported lock validation limit.");
  for (const [key, value] of Object.entries(overrides)) {
    const ceiling = defaultCutLockValidationLimits[key as keyof CutLockValidationLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) fail("CUT_LOCK_LIMIT", `$.options.limits.${key}`, `must be a positive safe integer no greater than the hard ${key} ceiling (${ceiling}).`);
  }
  const result = { ...defaultCutLockValidationLimits, ...overrides };
  return result;
}

function canonicalClone<T>(value: T): T { return JSON.parse(stableJsonStringify(value)) as T; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const childValue of Object.values(value as Record<string, unknown>)) deepFreeze(childValue);
  }
  return value;
}

class LockJsonScanner {
  private offset = 0;
  private nodes = 0;
  constructor(private readonly source: string, private readonly validationLimits: CutLockValidationLimits) {}
  scan() { this.space(); this.value(0); this.space(); if (this.offset !== this.source.length) this.syntax("unexpected trailing input"); }
  private syntax(message: string): never { fail("CUT_LOCK_JSON_PARSE", "$", `${message} at text offset ${this.offset}.`); }
  private space() { while (this.offset < this.source.length && /\s/.test(this.source[this.offset])) this.offset += 1; }
  private value(depth: number) {
    this.nodes += 1;
    if (this.nodes > this.validationLimits.maxJsonNodes) fail("CUT_LOCK_LIMIT", "$", `JSON exceeds maxJsonNodes (${this.validationLimits.maxJsonNodes}).`);
    if (depth > this.validationLimits.maxJsonDepth) fail("CUT_LOCK_LIMIT", "$", `JSON exceeds maxJsonDepth (${this.validationLimits.maxJsonDepth}).`);
    this.space(); const character = this.source[this.offset];
    if (character === "{") this.object(depth); else if (character === "[") this.array(depth); else if (character === '"') this.string();
    else if (this.source.startsWith("true", this.offset)) this.offset += 4; else if (this.source.startsWith("false", this.offset)) this.offset += 5; else if (this.source.startsWith("null", this.offset)) this.offset += 4;
    else { const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.offset)); if (!match) this.syntax("expected a JSON value"); this.offset += match[0].length; }
  }
  private string() {
    const start = this.offset; this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        try { return strictUtf8Text(JSON.parse(this.source.slice(start, this.offset)) as string, "$"); }
        catch (error) {
          if (error instanceof CutLockError) throw error;
          this.syntax("invalid JSON string");
        }
      }
      if (character === "\\") { this.offset += 2; continue; }
      if (character.charCodeAt(0) < 0x20) this.syntax("unescaped control character in string"); this.offset += 1;
    }
    this.syntax("unterminated JSON string");
  }
  private object(depth: number) {
    this.offset += 1; this.space(); const keys = new Set<string>(); if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax("expected an object key"); const key = this.string();
      if (keys.has(key)) fail("CUT_LOCK_JSON_DUPLICATE_KEY", "$", `duplicate decoded object key ${JSON.stringify(key)} near text offset ${this.offset}.`); keys.add(key);
      this.space(); if (this.source[this.offset] !== ":") this.syntax("expected ':' after object key"); this.offset += 1; this.value(depth + 1); this.space();
      if (this.source[this.offset] === "}") { this.offset += 1; return; } if (this.source[this.offset] !== ",") this.syntax("expected ',' or '}'"); this.offset += 1; this.space();
    }
  }
  private array(depth: number) {
    this.offset += 1; this.space(); if (this.source[this.offset] === "]") { this.offset += 1; return; }
    while (true) { this.value(depth + 1); this.space(); if (this.source[this.offset] === "]") { this.offset += 1; return; } if (this.source[this.offset] !== ",") this.syntax("expected ',' or ']'"); this.offset += 1; this.space(); }
  }
}

/** Parse bounded UTF-8 JSON, reject decoded duplicate keys, and validate v3. */
export function loadCutLock(input: string | Uint8Array, options: { limits?: Partial<CutLockValidationLimits> } = {}) {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "limits")) fail("CUT_LOCK_UNKNOWN_FIELD", "$.options", "contains an unsupported option.");
  const resolvedLimits = limits(options.limits ?? {});
  let source: string;
  if (typeof input === "string") {
    strictUtf8Text(input, "$");
    if (Buffer.byteLength(input, "utf8") > resolvedLimits.maxInputBytes) fail("CUT_LOCK_INPUT_TOO_LARGE", "$", `input exceeds ${resolvedLimits.maxInputBytes} bytes.`);
    source = input;
  }
  else if (input instanceof Uint8Array) {
    if (input.byteLength > resolvedLimits.maxInputBytes) fail("CUT_LOCK_INPUT_TOO_LARGE", "$", `input is ${input.byteLength} bytes; limit is ${resolvedLimits.maxInputBytes}.`);
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(input); }
    catch { fail("CUT_LOCK_JSON_ENCODING", "$", "input is not valid UTF-8."); }
  } else fail("CUT_LOCK_TYPE", "$", "loader input must be a JSON string or Uint8Array.");
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > resolvedLimits.maxInputBytes) fail("CUT_LOCK_INPUT_TOO_LARGE", "$", `input is ${bytes} bytes; limit is ${resolvedLimits.maxInputBytes}.`);
  new LockJsonScanner(source, resolvedLimits).scan();
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch (error) { fail("CUT_LOCK_JSON_PARSE", "$", error instanceof Error ? error.message : "invalid JSON."); }
  return validateCutLock(value, { limits: resolvedLimits });
}

export function validateCutLock(value: unknown, options: { limits?: Partial<CutLockValidationLimits> } = {}): CutLockfile {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "limits")) fail("CUT_LOCK_UNKNOWN_FIELD", "$.options", "contains an unsupported option.");
  const context: ValidationContext = { limits: limits(options.limits ?? {}), totalStringBytes: 0 };
  const preliminary = record(value, "$");
  if (preliminary.format === "cut-lock" && preliminary.version === 1) {
    fail("CUT_LOCK_VERSION", "$.version", "cut.lock v1 is an archived byte lock and cannot be applied as v3. Regenerate it with the current `cut lock`; automatic migration is unsafe because v1 contains no media probe or native implementation identity.");
  }
  if (preliminary.format === "cut-lock" && preliminary.version === 2) {
    fail("CUT_LOCK_VERSION", "$.version", "cut.lock v2 cannot be applied as v3. Regenerate it with the current `cut lock`; automatic migration is unsafe because v2 did not require the selected compositor identity.");
  }
  const lock = closed(preliminary, "$", ["determinism", "format", "jobs", "language", "packages", "resources", "sourceHash", "toolchain", "version"], ["features", "sourceModules"]);
  if (lock.format !== "cut-lock" || lock.version !== 3 || lock.language !== "0.4") fail("CUT_LOCK_VERSION", "$", "requires cut.lock v3 for CUT language 0.4; regenerate with the current `cut lock`.");
  digest(lock.sourceHash, "$.sourceHash", context);
  if (lock.sourceModules !== undefined) {
    if (!Array.isArray(lock.sourceModules) || lock.sourceModules.length > context.limits.maxPackages) fail("CUT_LOCK_LIMIT", "$.sourceModules", `must contain at most ${context.limits.maxPackages} source modules.`);
    let previous: string | undefined;
    lock.sourceModules.forEach((value, index) => {
      const path = `$.sourceModules[${index}]`, source = closed(value, path, ["bytes", "sha256", "specifier"]);
      const specifier = text(source.specifier, `${path}.specifier`, context, 512);
      if (!/^\.\/(?:[^./][^/]*\/)*[^./][^/]*\.cut$/.test(specifier) || specifier.split("/").some((segment) => segment === "..")) fail("CUT_LOCK_TYPE", `${path}.specifier`, "must be a canonical project-relative ./path.cut module specifier.");
      if (previous !== undefined && previous.localeCompare(specifier) >= 0) fail("CUT_LOCK_IDENTITY", `${path}.specifier`, "must be unique and strictly sorted.");
      previous = specifier;
      digest(source.sha256, `${path}.sha256`, context); safeInteger(source.bytes, `${path}.bytes`, 0);
    });
  }
  if (lock.features !== undefined) {
    const features = closed(lock.features, "$.features", ["complexTextShaping"]);
    validateComplexTextBackendIdentity(features.complexTextShaping, "$.features.complexTextShaping", context);
  }
  const toolchain = closed(lock.toolchain, "$.toolchain", ["compiler", "ir", "packageAbi", "referenceBackend", "referenceRuntime"]);
  text(toolchain.compiler, "$.toolchain.compiler", context, 256); if (toolchain.ir !== 3) fail("CUT_LOCK_VERSION", "$.toolchain.ir", "must be CutAVIR 3."); safeInteger(toolchain.packageAbi, "$.toolchain.packageAbi", 1); const referenceRuntime = text(toolchain.referenceRuntime, "$.toolchain.referenceRuntime", context, 256); const referenceBackend = validateReferenceBackend(toolchain.referenceBackend, "$.toolchain.referenceBackend", context);
  if (referenceBackend.runtime !== referenceRuntime) fail("CUT_LOCK_IDENTITY", "$.toolchain.referenceBackend.runtime", "must match toolchain.referenceRuntime.");
  const determinism = closed(lock.determinism, "$.determinism", ["bitstream", "decodedMedia", "semantic"]);
  if (determinism.semantic !== "locked" || determinism.decodedMedia !== "unverified" || determinism.bitstream !== "unverified") fail("CUT_LOCK_DETERMINISM", "$.determinism", "v3 locks semantic inputs only; decoded-media and bitstream determinism must remain unverified.");

  if (!Array.isArray(lock.packages) || lock.packages.length > context.limits.maxPackages) fail("CUT_LOCK_LIMIT", "$.packages", `must contain at most ${context.limits.maxPackages} packages.`);
  const packageSpecifiers = new Set<string>();
  let previousPackageSpecifier: string | undefined;
  lock.packages.forEach((value, index) => {
    const path = `$.packages[${index}]`, package_ = closed(value, path, ["integrity", "specifier", "version"]), specifier = text(package_.specifier, `${path}.specifier`, context, 512);
    if (packageSpecifiers.has(specifier)) fail("CUT_LOCK_IDENTITY", `${path}.specifier`, "must be unique."); packageSpecifiers.add(specifier);
    if (previousPackageSpecifier !== undefined && previousPackageSpecifier.localeCompare(specifier) >= 0) fail("CUT_LOCK_IDENTITY", `${path}.specifier`, "must be strictly sorted by specifier.");
    previousPackageSpecifier = specifier;
    text(package_.version, `${path}.version`, context, 128); digest(package_.integrity, `${path}.integrity`, context);
  });

  const resources = record(lock.resources, "$.resources"), resourceKeys = Object.keys(resources);
  if (resourceKeys.length > context.limits.maxResources) fail("CUT_LOCK_LIMIT", "$.resources", `contains more than ${context.limits.maxResources} resources.`);
  for (const key of resourceKeys) {
    identifier(key, child("$.resources", key), context);
    validateLockedResource(resources[key], child("$.resources", key), context, key);
  }
  const jobs = record(lock.jobs, "$.jobs"), jobKeys = Object.keys(jobs);
  if (jobKeys.length > context.limits.maxJobs) fail("CUT_LOCK_LIMIT", "$.jobs", `contains more than ${context.limits.maxJobs} jobs.`);
  for (const key of jobKeys) {
    identifier(key, child("$.jobs", key), context);
    const job = closed(jobs[key], child("$.jobs", key), ["artifactHash"]); digest(job.artifactHash, `${child("$.jobs", key)}.artifactHash`, context);
  }
  return deepFreeze(canonicalClone(lock as unknown as CutLockfile));
}

export async function resolveLockedProjectPath(projectRoot: string, locator: string) {
  if (!locator || locator.includes("\0")) throw new Error("CUT resource locators must be non-empty and cannot contain NUL bytes.");
  const safe = validateProjectLocator(locator, "resource locator");
  const physicalCandidate = await resolveProjectFile(projectRoot, safe);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try { metadata = await lstat(physicalCandidate); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") throw new CutProjectError("CUTP1015", `Project resource does not exist: ${safe}`, physicalCandidate);
    throw new CutProjectError("CUTP1016", `Cannot inspect project resource ${safe}.`, physicalCandidate);
  }
  if (!metadata.isFile()) throw new CutProjectError("CUTP1018", `Project resource must resolve to a regular file: ${safe}`, physicalCandidate);
  return { path: physicalCandidate, bytes: metadata.size };
}

async function selectedStream(probe: CutMediaProbe, type: "video", projectRoot: string, required: boolean, requireVideoCadence: boolean | undefined, resource: IRResource, variant: "master" | "proxy", authoredIndex?: number): Promise<LockedVideoMediaSelection | undefined>;
async function selectedStream(probe: CutMediaProbe, type: "audio", projectRoot: string, required: boolean, requireVideoCadence: boolean | undefined, resource: IRResource, variant: "master" | "proxy", authoredIndex?: number): Promise<LockedAudioMediaSelection | undefined>;
async function selectedStream(probe: CutMediaProbe, type: "video" | "audio", projectRoot: string, required: boolean, requireVideoCadence: boolean | undefined, resource: IRResource, variant: "master" | "proxy", authoredIndex?: number): Promise<LockedMediaSelection | undefined> {
  if (!required) return undefined;
  const candidates = probe.streams.filter((candidate) => candidate.type === type);
  let stream: (typeof candidates)[number] | undefined;
  if (authoredIndex !== undefined) {
    stream = candidates.find((candidate) => candidate.index === authoredIndex);
    if (!stream) {
      throw new CutMediaStreamSelectionError(
        "CUT_MEDIA_STREAM_NOT_FOUND",
        resource,
        variant,
        type,
        `${variant} ${type} selector ${authoredIndex} does not name an existing ${type} stream in ${probe.file.locator}; available absolute ${type} indexes are ${candidates.length ? candidates.map((candidate) => candidate.index).join(", ") : "none"}`,
      );
    }
  } else if (candidates.length === 1) stream = candidates[0];
  else if (candidates.length === 0) {
    throw new CutMediaStreamSelectionError(
      "CUT_MEDIA_STREAM_NOT_FOUND",
      resource,
      variant,
      type,
      `${variant} ${type} consumption requires one ${type} stream, but ${probe.file.locator} contains none`,
    );
  } else {
    throw new CutMediaStreamSelectionError(
      "CUT_MEDIA_STREAM_AMBIGUOUS",
      resource,
      variant,
      type,
      `${variant} ${type} consumption is ambiguous in ${probe.file.locator}; choose one absolute ffprobe/ffmpeg index from ${candidates.map((candidate) => candidate.index).join(", ")}`,
    );
  }
  if (!stream.timeBase || compareRational(stream.timeBase, zeroRational) <= 0) throw new Error(`Cannot lock ${probe.file.locator}: selected ${type} stream ${stream.index} has no positive exact time base.`);
  if (type === "video" && (!stream.width || !stream.height)) throw new Error(`Cannot lock ${probe.file.locator}: selected video stream ${stream.index} has no exact dimensions.`);
  if (type === "video" && (!stream.start || compareRational(stream.start, zeroRational) < 0)) throw new CutMediaDurationError(probe.file.locator, type, stream.index, "has no exact non-negative stream start for stream-relative decoding.", resource);
  if (type === "video" && !integralTicks(stream.start!, stream.timeBase)) throw new CutMediaDurationError(probe.file.locator, type, stream.index, "has a stream start that does not land on its exact codec time base for PTS-relative decoding.", resource);
  if (type === "video" && [stream.frameRate, stream.averageFrameRate].every((candidate) => !candidate || compareRational(candidate, zeroRational) <= 0)) throw new Error(`Cannot lock ${probe.file.locator}: selected video stream ${stream.index} has no positive exact frame-rate candidate.`);
  if (type === "audio" && (!stream.sampleRate || !stream.channels)) throw new Error(`Cannot lock ${probe.file.locator}: selected audio stream ${stream.index} has no exact sample-rate/channel metadata.`);
  const streamDuration = stream.duration && compareRational(stream.duration, zeroRational) > 0 ? stream.duration : undefined;
  if (type === "audio") {
    try {
      const samples = await probeProjectDecodedAudioSamples(projectRoot, probe.file.locator, probe, stream.index);
      const duration = decodedAudioSamplesDuration(samples, stream);
      return { streamIndex: stream.index, duration, durationSource: "decoded-audio-samples", timeBase: stream.timeBase, decodedAudioSamples: samples };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CutMediaDurationError(probe.file.locator, type, stream.index, `has no safe decoded-audio-samples witness (${reason}).`, resource);
    }
  }
  if (streamDuration && !(type === "video" && requireVideoCadence)) return { streamIndex: stream.index, duration: streamDuration, durationSource: "stream", timeBase: stream.timeBase, ...(type === "video" ? { frameRate: stream.frameRate ?? stream.averageFrameRate } : {}) };
  if (type === "video" && required) {
    try {
      const cadence = await probeProjectDecodedVideoCadence(projectRoot, probe.file.locator, probe, stream.index);
      const duration = decodedVideoCadenceDuration(cadence, stream);
      return { streamIndex: stream.index, duration, durationSource: "decoded-video-cadence", timeBase: stream.timeBase, frameRate: cadence.frameRate, decodedVideoCadence: cadence };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CutMediaDurationError(
        probe.file.locator,
        type,
        stream.index,
        streamDuration && requireVideoCadence
          ? `requires a safe decoded-video-cadence witness for frame-index/proxy execution, but cadence proof failed (${reason}).`
          : `has no positive exact stream duration and no safe decoded-video-cadence witness (${reason}).`,
        resource,
      );
    }
  }
  if (required) throw new CutMediaDurationError(probe.file.locator, type, stream.index, "has no positive exact stream duration; container duration is not a safe substitute.", resource);
  return undefined;
}

type RequiredMediaKinds = ReadonlySet<CutConsumedMediaKind>;

function requiredMediaKinds(ir: CutAVIR, resource: IRResource): RequiredMediaKinds {
  const required = new Set<"video" | "audio">();
  if (resource.kind === "video") required.add("video");
  if (resource.kind === "audio") required.add("audio");
  if (resource.streamSelection?.video !== undefined || resource.proxy?.streamSelection?.video !== undefined) required.add("video");
  if (resource.streamSelection?.audio !== undefined || resource.proxy?.streamSelection?.audio !== undefined) required.add("audio");
  for (const node of Object.values(ir.nodes)) {
    const source = node.inputs.source;
    if (source?.kind === "resource-ref" && source.id === resource.id) for (const kind of directNodeConsumedMediaKinds(node, resource.kind)) required.add(kind);
    if (node.editorial?.kind === "picture-track" && node.editorial.operationPlan) {
      const items = [
        ...node.editorial.operationPlan.baseItems,
        ...node.editorial.operationPlan.operations.flatMap((operation) => "item" in operation ? [operation.item] : []),
      ];
      if (items.some((item) => item.kind === "picture" && item.inputs.source?.kind === "resource-ref" && item.inputs.source.id === resource.id)) required.add("video");
    }
    if (node.editorial?.kind === "audio-track" && node.editorial.operationPlan) {
      const items = [
        ...node.editorial.operationPlan.baseItems,
        ...node.editorial.operationPlan.operations.flatMap((operation) => "item" in operation ? [operation.item] : []),
      ];
      if (items.some((item) => item.kind === "clip" && item.inputs.resourceId === resource.id)) required.add("audio");
    }
  }
  for (const signal of Object.values(ir.signals)) if (signal.kind === "track" && signal.producer?.source.id === resource.id) required.add("audio");
  return required;
}

function requiresVideoCadence(ir: CutAVIR, resource: IRResource) {
  for (const node of Object.values(ir.nodes)) {
    const consumes = node.inputs.source?.kind === "resource-ref" && node.inputs.source.id === resource.id;
    if (consumes && (node.op === "cut.edit.picture_clip" || node.op === "cut.edit.clip")) return true;
    if (consumes && node.op === "cut.visual.video" && (node.inputs.range !== undefined || node.inputs.loop?.kind === "boolean" && node.inputs.loop.value)) return true;
    if (node.editorial?.kind !== "picture-track" || !node.editorial.operationPlan) continue;
    const items = [
      ...node.editorial.operationPlan.baseItems,
      ...node.editorial.operationPlan.operations.flatMap((operation) => "item" in operation ? [operation.item] : []),
    ];
    if (items.some((item) => item.kind === "picture" && item.inputs.source?.kind === "resource-ref" && item.inputs.source.id === resource.id)) return true;
  }
  return false;
}

function requiresLockedVideoCadence(ir: CutAVIR, resource: IRResource, required: RequiredMediaKinds) {
  // A proxy is an alternate executable picture source, not merely a cheaper
  // codec. Average rate/start/duration cannot prove that two VFR or dropped-
  // frame schedules select the same picture at a CUT time, so both variants
  // must carry a decoded CFR frame-count witness whenever picture is consumed.
  return requiresVideoCadence(ir, resource) || Boolean(authoredProxyLocator(resource) && required.has("video"));
}

async function probeForResource(resource: IRResource, projectRoot: string, required: RequiredMediaKinds, maxByteResourceBytes?: number, locator = resource.locator, requireVideoCadence = false, variant: "master" | "proxy" = "master"): Promise<LockedResourceProbe> {
  if (resource.kind === "video" || resource.kind === "audio") {
    const identity = await probeProjectMedia(projectRoot, locator);
    const authored = variant === "master" ? resource.streamSelection : resource.proxy?.streamSelection;
    const video = await selectedStream(identity, "video", projectRoot, required.has("video"), requireVideoCadence, resource, variant, authored?.video), audio = await selectedStream(identity, "audio", projectRoot, required.has("audio"), false, resource, variant, authored?.audio);
    return { kind: "media", identity, selected: { ...(video ? { video } : {}), ...(audio ? { audio } : {}) } };
  }
  if (resource.kind === "image") return { kind: "image", identity: await probeProjectImage(projectRoot, locator) };
  const identity = await probeProjectBytes(projectRoot, locator, maxByteResourceBytes === undefined ? {} : { maxFileBytes: maxByteResourceBytes });
  return { kind: "bytes", identity, coverage: { level: "bytes-only", excludes: byteCoverage[resource.kind] } };
}

function probeFile(probe: LockedResourceProbe) { return probe.identity.file; }
function canonicalEqual(left: unknown, right: unknown) {
  if (left === undefined || right === undefined) return left === right;
  return stableJsonStringify(left) === stableJsonStringify(right);
}

/**
 * Historical decoded-audio v1 is structurally readable, but the current
 * native scanner emits a differently salted v2 record digest. Without a
 * frozen v1 scanner or persisted v1 conformance fixture CUT cannot prove that
 * a current observation is the same v1 authority. Callers must fail with a
 * relock diagnostic rather than normalizing or relabeling either witness.
 */
export function lockedResourceProbeNeedsDecodedAudioV2Relock(
  expected: LockedResourceProbe,
  observed: LockedResourceProbe,
) {
  return expected.kind === "media"
    && observed.kind === "media"
    && expected.selected.audio?.decodedAudioSamples?.version === 1
    && observed.selected.audio?.decodedAudioSamples?.version === 2;
}

function assertNativeProbeMatchesLock(expected: LockedResourceProbe, observed: LockedResourceProbe, path: string, locator: string) {
  if (canonicalEqual(expected, observed)) return;
  if (lockedResourceProbeNeedsDecodedAudioV2Relock(expected, observed)) {
    fail(
      "CUT_LOCK_VERSION",
      path,
      `Locked resource ${locator} carries a structurally readable decoded-audio v1 witness, but current native replay emits v2 and cannot reproduce the historical v1 record digest; regenerate cut.lock with the current scanner.`,
    );
  }
  fail("CUT_LOCK_METADATA", path, `Locked resource metadata or native probe identity changed: ${locator}`);
}

/**
 * Compare the complete canonical reference-backend identity pinned by cut.lock.
 *
 * This intentionally does not compare only `integrity`: callers that defer
 * resource verification bind their inputs first, then use this pure check on
 * the freshly collected backend before starting any media execution.
 */
export function assertCutLockReferenceBackendIdentity(
  expected: CutReferenceBackendIdentity,
  actual: CutReferenceBackendIdentity,
) {
  if (stableJsonStringify(expected) !== stableJsonStringify(actual)) {
    const detail = expected.integrity === actual.integrity
      ? `canonical backend fields differ despite the shared integrity value ${expected.integrity}`
      : `${expected.integrity} != ${actual.integrity}`;
    fail(
      "CUT_LOCK_IDENTITY",
      "$.toolchain.referenceBackend",
      `cut.lock reference backend identity does not match this installation (${detail}).`,
    );
  }
}

function authoredProxyLocator(resource: IRResource) {
  return resource.proxy?.locator;
}

function lockedVariant(
  locator: string,
  probe: LockedResourceProbe,
  alignments: Readonly<{ audio?: CutAudioProxyAlignment; video?: CutVideoProxyAlignment }> = {},
): LockedResourceVariant {
  const file = probeFile(probe);
  return {
    locator,
    sha256: file.sha256,
    bytes: file.bytes,
    probe,
    ...(alignments.audio ? { audioAlignment: alignments.audio } : {}),
    ...(alignments.video ? { videoAlignment: alignments.video } : {}),
  };
}

function selectedProbeStream(probe: Extract<LockedResourceProbe, { kind: "media" }>, type: "video" | "audio") {
  const selection = probe.selected[type];
  return selection ? probe.identity.streams.find((stream) => stream.index === selection.streamIndex && stream.type === type) : undefined;
}

function exactRationalEqual(left: Rational | undefined, right: Rational | undefined) {
  return left !== undefined && right !== undefined && compareRational(left, right) === 0;
}

/**
 * A proxy may change codec, dimensions, pixel format, color encoding,
 * bitrate, and the shared absolute container origin. It may not change which
 * selected picture/sound streams CUT can consume, their relative A/V delta,
 * or any decoded duration, frame, sample, scan, or channel mapping.
 */
function integralTicks(value: Rational, timeBase: Rational) {
  return divideRational(value, timeBase).denominator === "1";
}

function proxyEquivalenceIssue(kind: IRResource["kind"], master: LockedResourceProbe, proxy: LockedResourceProbe, requireManagedColor = false): { code: CutProxyMediaErrorCode; message: string } | undefined {
  if (master.kind !== "media" || proxy.kind !== "media") {
    return { code: "CUT_PROXY_KIND", message: "master and proxy must both be media probes" };
  }
  const consumedTypes: Array<"video" | "audio"> = kind === "audio" ? ["audio"] : ["video", "audio"];
  for (const type of consumedTypes) {
    const masterSelection = master.selected[type], proxySelection = proxy.selected[type];
    if (Boolean(masterSelection) !== Boolean(proxySelection)) {
      return { code: "CUT_PROXY_KIND", message: `proxy must preserve selected ${type} stream availability` };
    }
    if (!masterSelection || !proxySelection) continue;
    const masterStream = selectedProbeStream(master, type), proxyStream = selectedProbeStream(proxy, type);
    if (!masterStream || !proxyStream) return { code: "CUT_PROXY_KIND", message: `proxy cannot resolve the selected ${type} stream` };
    const masterStart = masterStream.start ?? zeroRational, proxyStart = proxyStream.start ?? zeroRational;
    if (!exactRationalEqual(masterSelection.duration, proxySelection.duration)) {
      return { code: "CUT_PROXY_TIMING", message: `proxy selected ${type} decoded duration must exactly match the master` };
    }
    if (type === "video") {
      if (masterSelection.durationSource !== "decoded-video-cadence" || proxySelection.durationSource !== "decoded-video-cadence"
        || !masterSelection.decodedVideoCadence || !proxySelection.decodedVideoCadence) {
        return { code: "CUT_PROXY_FRAME_MAPPING", message: "master and proxy selected video require decoded cadence witnesses" };
      }
      if (!masterSelection.frameRate || !proxySelection.frameRate || !exactRationalEqual(masterSelection.frameRate, proxySelection.frameRate)
        || !exactRationalEqual(masterSelection.frameRate, masterSelection.decodedVideoCadence.frameRate)
        || !exactRationalEqual(proxySelection.frameRate, proxySelection.decodedVideoCadence.frameRate)) {
        return { code: "CUT_PROXY_FRAME_MAPPING", message: "proxy selected video cadence frame rate must exactly match the master" };
      }
      if (masterSelection.decodedVideoCadence.frameCount !== proxySelection.decodedVideoCadence.frameCount) {
        return { code: "CUT_PROXY_FRAME_MAPPING", message: "proxy selected video decoded frame count must exactly match the master" };
      }
      if ((masterStream.fieldOrder ?? "") !== (proxyStream.fieldOrder ?? "")) {
        return { code: "CUT_PROXY_SCAN_MAPPING", message: "proxy selected video field order must exactly match the master" };
      }
      if (![masterSelection, proxySelection].every((selection, index) => {
        const start = index === 0 ? masterStart : proxyStart;
        return integralTicks(start, selection.timeBase);
      })) return { code: "CUT_PROXY_FRAME_MAPPING", message: "master and proxy codec time bases must exactly represent their selected video starts" };
      if (requireManagedColor) {
        const colorFields = ["colorRange", "colorSpace", "colorTransfer", "colorPrimaries"] as const;
        const mismatch = colorFields.find((field) => (masterStream[field] ?? "") !== (proxyStream[field] ?? ""));
        if (mismatch) return { code: "CUT_PROXY_COLOR_MAPPING", message: `proxy selected video ${mismatch} must match the master when an explicit video-consumer inputColor uses managed decoding` };
      }
    } else if (masterStream.sampleRate !== proxyStream.sampleRate
      || masterStream.channels !== proxyStream.channels
      || (masterStream.channelLayout ?? "") !== (proxyStream.channelLayout ?? "")) {
      return { code: "CUT_PROXY_SAMPLE_MAPPING", message: "proxy selected audio sample rate, channel count, and channel layout must exactly match the master" };
    } else {
      if (masterSelection.durationSource !== "decoded-audio-samples" || proxySelection.durationSource !== "decoded-audio-samples"
        || !masterSelection.decodedAudioSamples || !proxySelection.decodedAudioSamples) {
        return { code: "CUT_PROXY_SAMPLE_MAPPING", message: "master and proxy selected audio require decoded sample witnesses" };
      }
      if (masterSelection.decodedAudioSamples.decodedSampleCount !== proxySelection.decodedAudioSamples.decodedSampleCount) {
        return { code: "CUT_PROXY_SAMPLE_MAPPING", message: "proxy selected audio decoded sample count must exactly match the master" };
      }
    }
  }
  if (kind === "video" && master.selected.video && proxy.selected.video && master.selected.audio && proxy.selected.audio) {
    const relativeDelta = (probe: Extract<LockedResourceProbe, { kind: "media" }>) => {
      const video = selectedProbeStream(probe, "video"), witness = probe.selected.audio?.decodedAudioSamples;
      if (!video?.start || !witness) return undefined;
      return subtractRational(multiplyRational(rational(witness.firstPts), witness.timeBase), video.start);
    };
    const masterDelta = relativeDelta(master), proxyDelta = relativeDelta(proxy);
    if (!masterDelta || !proxyDelta || compareRational(masterDelta, proxyDelta) !== 0) {
      return { code: "CUT_PROXY_TIMING", message: "proxy selected audio presentation delta relative to picture must exactly match the master" };
    }
  }
  return undefined;
}

function assertProxyEquivalent(resource: IRResource, master: LockedResourceProbe, proxy: LockedResourceProbe, requireManagedColor = false) {
  const issue = proxyEquivalenceIssue(resource.kind, master, proxy, requireManagedColor);
  if (issue) throw new CutProxyMediaError(issue.code, resource, issue.message);
}

async function audioProxyAlignment(
  resource: IRResource,
  projectRoot: string,
  masterLocator: string,
  master: LockedResourceProbe,
  proxyLocator: string,
  proxy: LockedResourceProbe,
) {
  if (master.kind !== "media" || proxy.kind !== "media" || !master.selected.audio || !proxy.selected.audio) return undefined;
  const masterWitness = master.selected.audio.decodedAudioSamples, proxyWitness = proxy.selected.audio.decodedAudioSamples;
  if (!masterWitness || !proxyWitness) throw new CutProxyMediaError("CUT_PROXY_AUDIO_ALIGNMENT", resource, "both executable audio variants require decoded sample witnesses before content alignment");
  try {
    return await probeProjectAudioProxyAlignment(
      projectRoot,
      masterLocator,
      master.identity,
      masterWitness,
      proxyLocator,
      proxy.identity,
      proxyWitness,
    );
  } catch (error) {
    if (error instanceof CutProxyMediaError) throw error;
    throw new CutProxyMediaError("CUT_PROXY_AUDIO_ALIGNMENT", resource, error instanceof Error ? error.message : String(error));
  }
}

async function videoProxyAlignment(
  resource: IRResource,
  projectRoot: string,
  masterLocator: string,
  master: LockedResourceProbe,
  proxyLocator: string,
  proxy: LockedResourceProbe,
) {
  if (master.kind !== "media" || proxy.kind !== "media" || !master.selected.video || !proxy.selected.video) return undefined;
  const masterWitness = master.selected.video.decodedVideoCadence, proxyWitness = proxy.selected.video.decodedVideoCadence;
  if (!masterWitness || !proxyWitness) throw new CutProxyMediaError("CUT_PROXY_VIDEO_ALIGNMENT", resource, "both executable video variants require decoded cadence witnesses before content alignment");
  try {
    return await probeProjectVideoProxyAlignment(
      projectRoot,
      masterLocator,
      master.identity,
      masterWitness,
      proxyLocator,
      proxy.identity,
      proxyWitness,
    );
  } catch (error) {
    if (error instanceof CutProxyMediaError) throw error;
    throw new CutProxyMediaError("CUT_PROXY_VIDEO_ALIGNMENT", resource, error instanceof Error ? error.message : String(error));
  }
}

function resourceUsesManagedInputColor(ir: CutAVIR, resourceId: string) {
  return Object.values(ir.nodes).some((node) => {
    if (["cut.visual.video", "cut.edit.clip", "cut.edit.picture_clip"].includes(node.op)
      && node.inputs.source?.kind === "resource-ref"
      && node.inputs.source.id === resourceId
      && Object.hasOwn(node.inputs, "inputColor")) return true;
    if (node.editorial?.kind !== "picture-track" || !node.editorial.operationPlan) return false;
    const items = [
      ...node.editorial.operationPlan.baseItems,
      ...node.editorial.operationPlan.operations.flatMap((operation) => "item" in operation ? [operation.item] : []),
    ];
    return items.some((item) => item.kind === "picture"
      && item.inputs.source?.kind === "resource-ref"
      && item.inputs.source.id === resourceId
      && Object.hasOwn(item.inputs, "inputColor"));
  });
}

function referenceLutConsumers(ir: CutAVIR) {
  return new Map([...validateReferenceLutResourceOwnership(ir)].map(([sourceId, consumer]) => [sourceId, consumer.config]));
}

type ReferencePlanarTrackConsumers = Readonly<{
  byNode: ReadonlyMap<string, ReferencePlanarTrackConfig>;
  byResource: ReadonlyMap<string, ReferencePlanarTrackConfig>;
}>;

function referencePlanarTrackConsumers(ir: CutAVIR): ReferencePlanarTrackConsumers {
  const byNode = validateReferencePlanarTrackResourceOwnership(ir);
  const byResource = new Map<string, ReferencePlanarTrackConfig>();
  for (const config of [...byNode.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId))) {
    if (!byResource.has(config.sourceId)) byResource.set(config.sourceId, config);
  }
  return Object.freeze({ byNode, byResource });
}

function transcriptResourceIds(ir: CutAVIR) {
  return new Set((ir.transcriptBindings ?? []).map((binding) => binding.transcriptResourceId));
}

function imageSequenceManifestResourceIds(ir: CutAVIR) {
  return new Set(cutImageSequenceSources(ir).map(({ source }) => source.manifestResourceId));
}

function specializedByteResourceLimit(
  resource: IRResource,
  lutConsumers: ReturnType<typeof referenceLutConsumers>,
  planarTrackConsumers: ReferencePlanarTrackConsumers,
  transcriptResources: ReadonlySet<string>,
  imageSequenceManifests: ReadonlySet<string> = new Set(),
) {
  const resourceId = resource.id;
  const limits = [
    ...(resource.byteAuthority ? [cutTypedDataAssetMaximumBytes[resource.byteAuthority.kind]] : []),
    ...(lutConsumers.has(resourceId) ? [referenceCubeLutLimits.maxBytes] : []),
    ...(planarTrackConsumers.byResource.has(resourceId) ? [referencePlanarTrackLimits.maxBytes] : []),
    ...(transcriptResources.has(resourceId) ? [cutTranscriptSidecarMaxBytes] : []),
    ...(imageSequenceManifests.has(resourceId) ? [cutImageSequenceLimits.maximumManifestBytes] : []),
  ];
  return limits.length ? Math.min(...limits) : undefined;
}

async function preflightImageSequenceManifestSizes(
  ir: CutAVIR,
  projectRoot: string,
  resourceIds: ReadonlySet<string>,
) {
  for (const resourceId of [...resourceIds].sort()) {
    const sourceEntry = cutImageSequenceSources(ir).find(({ source }) => source.manifestResourceId === resourceId);
    const resource = ir.resources[resourceId];
    if (!sourceEntry || !resource || resource.kind !== "data") {
      throw new CutImageSequenceError(
        "CUT_IMAGE_SEQUENCE_RESOURCE",
        `$.resources.${resourceId}`,
        "must reference one declared DataAsset manifest before lock probing begins.",
        sourceEntry?.node,
      );
    }
    let resolved: Awaited<ReturnType<typeof resolveLockedProjectPath>>;
    try {
      resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
    } catch (error) {
      throw new CutImageSequenceError(
        "CUT_IMAGE_SEQUENCE_RESOURCE",
        `$.resources.${resourceId}`,
        `cannot resolve the manifest DataAsset before lock probing (${error instanceof CutProjectError ? error.code : "filesystem"}).`,
        sourceEntry.node,
        { cause: error },
      );
    }
    if (resolved.bytes < 1 || resolved.bytes > cutImageSequenceLimits.maximumManifestBytes) {
      throw new CutImageSequenceError(
        "CUT_IMAGE_SEQUENCE_LIMIT",
        `$.resources.${resourceId}`,
        `manifest DataAsset must contain 1 through ${cutImageSequenceLimits.maximumManifestBytes} bytes; found ${resolved.bytes}.`,
        sourceEntry.node,
      );
    }
  }
}

async function preflightTranscriptResourceSizes(
  ir: CutAVIR,
  projectRoot: string,
  resourceIds: ReadonlySet<string>,
) {
  for (const resourceId of [...resourceIds].sort()) {
    const bindingIndex = ir.transcriptBindings!.findIndex((binding) => binding.transcriptResourceId === resourceId);
    const binding = ir.transcriptBindings![bindingIndex]!;
    const path = `$.transcriptBindings[${bindingIndex}].transcriptResourceId`;
    const resource = ir.resources[resourceId];
    if (!resource || resource.kind !== "data") {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_RESOURCE",
        path,
        binding,
        "must reference one declared DataAsset before lock probing begins.",
      );
    }
    let resolved: Awaited<ReturnType<typeof resolveLockedProjectPath>>;
    try {
      resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
    } catch (error) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_RESOURCE",
        path,
        binding,
        `cannot resolve the transcript DataAsset before lock probing (${error instanceof CutProjectError ? error.code : "filesystem"}).`,
      );
    }
    if (resolved.bytes < 1 || resolved.bytes > cutTranscriptSidecarMaxBytes) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_SIDECAR",
        path,
        binding,
        `transcript DataAsset must contain 1 through ${cutTranscriptSidecarMaxBytes} bytes; found ${resolved.bytes}.`,
      );
    }
  }
}

async function preflightLutResourceSizes(ir: CutAVIR, projectRoot: string, consumers: ReturnType<typeof referenceLutConsumers>) {
  for (const [resourceId, config] of consumers) {
    const node = ir.nodes[config.nodeId], resource = ir.resources[resourceId];
    if (!node || !resource) continue;
    const resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
    if (resolved.bytes < 1 || resolved.bytes > referenceCubeLutLimits.maxBytes) {
      throw new ReferenceLutError("CUT_LUT_LIMIT", node, `project .cube bytes must be between 1 and ${referenceCubeLutLimits.maxBytes}; found ${resolved.bytes}.`);
    }
  }
}

/** Bound every project-wide planar sidecar before byte loading or native
 * backend discovery. Composition-level resource/sample budgets are enforced
 * again by the semantic parser below. */
async function preflightPlanarTrackResourceSizes(
  ir: CutAVIR,
  projectRoot: string,
  consumers: ReferencePlanarTrackConsumers,
) {
  let projectBytes = 0;
  for (const [resourceId, config] of [...consumers.byResource].sort(([left], [right]) => left.localeCompare(right))) {
    const node = ir.nodes[config.nodeId], resource = ir.resources[resourceId];
    if (!node || !resource || resource.kind !== "data") {
      if (node) throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_RESOURCE", node.id, node, `cannot resolve planar-track DataAsset ${resourceId}.`);
      throw new Error(`Internal CUT PlanarTrack resource ${resourceId} has no source-located consumer.`);
    }
    const resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
    if (!Number.isSafeInteger(resolved.bytes) || resolved.bytes < 1 || resolved.bytes > referencePlanarTrackLimits.maxBytes) {
      throw new ReferencePlanarTrackError(
        "CUT_PLANAR_TRACK_LIMIT",
        node.id,
        node,
        `project sidecar bytes must be between 1 and ${referencePlanarTrackLimits.maxBytes}; found ${resolved.bytes}.`,
      );
    }
    projectBytes += resolved.bytes;
    if (!Number.isSafeInteger(projectBytes) || projectBytes > referencePlanarTrackLimits.maxProjectBytes) {
      throw new ReferencePlanarTrackError(
        "CUT_PLANAR_TRACK_LIMIT",
        node.id,
        node,
        `project planar-track bytes exceed ${referencePlanarTrackLimits.maxProjectBytes}.`,
      );
    }
  }
}

type LockedByteExpectation = Readonly<{
  bytes: number;
  sha256: string;
  proxy?: LockedResourceVariant;
}>;

const maximumLockedVariantCount = defaultCutLockValidationLimits.maxResources * 2;
const maximumLockedAggregateBytes = 256n * 1024n * 1024n * 1024n;

function validateLockedByteExpectationBudget(expected: ReadonlyMap<string, LockedByteExpectation>) {
  let variants = 0, bytes = 0n;
  for (const [id, locked] of [...expected].sort(([left], [right]) => left.localeCompare(right))) {
    const entries: Array<readonly ["master" | "proxy", { bytes: number }]> = [["master", locked], ...(locked.proxy ? [["proxy", locked.proxy] as const] : [])];
    for (const [label, variant] of entries) {
      if (!Number.isSafeInteger(variant.bytes) || variant.bytes < 0) fail("CUT_LOCK_STATE", `${child("$.resources", id)}.${label}.bytes`, "locked byte count must be one non-negative safe integer.");
      variants += 1; bytes += BigInt(variant.bytes);
      if (variants > maximumLockedVariantCount) fail("CUT_LOCK_LIMIT", "$.resources", `locked media exceeds the ${maximumLockedVariantCount}-variant verification limit.`);
      if (bytes > maximumLockedAggregateBytes) fail("CUT_LOCK_LIMIT", "$.resources", `locked media exceeds the ${maximumLockedAggregateBytes}-byte aggregate verification limit.`);
    }
  }
}

/**
 * Establish exact locked byte identity without invoking an image decoder,
 * ffprobe, or another native media backend. Both lock application and later
 * render-time reverification use this pass so corrupted changed bytes always
 * receive the same CUT_LOCK_INTEGRITY diagnostic before codec-specific work.
 */
async function verifyLockedResourceSizes(
  ir: CutAVIR,
  projectRoot: string,
  expected: ReadonlyMap<string, LockedByteExpectation>,
) {
  validateLockedByteExpectationBudget(expected);
  for (const resource of Object.values(ir.resources).sort((left, right) => left.id.localeCompare(right.id))) {
    const locked = expected.get(resource.id);
    if (!locked) fail("CUT_LOCK_STATE", child("$.resources", resource.id), `Resource “${resource.id}” has no locked byte identity.`);
    const resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
    if (resolved.bytes !== locked.bytes) fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked resource bytes changed: ${resource.locator}`);
    if (locked.proxy) {
      const resolvedProxy = await resolveLockedProjectPath(projectRoot, locked.proxy.locator);
      if (resolvedProxy.bytes !== locked.proxy.bytes) fail("CUT_LOCK_INTEGRITY", `${child("$.resources", resource.id)}.proxy`, `Locked proxy resource bytes changed: ${locked.proxy.locator}`);
    }
  }
}

function lockProbeDrift(error: unknown) {
  return error && typeof error === "object" && "code" in error
    && (error.code === "CUTP2006" || error.code === "CUTP2009");
}

async function verifyLockedResourceHashes(
  ir: CutAVIR,
  projectRoot: string,
  expected: ReadonlyMap<string, LockedByteExpectation>,
) {
  for (const resource of Object.values(ir.resources).sort((left, right) => left.id.localeCompare(right.id))) {
    const locked = expected.get(resource.id)!;
    let bytes: CutByteProbe;
    try { bytes = await probeProjectBytes(projectRoot, resource.locator, { maxFileBytes: Math.max(1, locked.bytes) }); }
    catch (error) {
      if (lockProbeDrift(error)) fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked resource bytes changed: ${resource.locator}`);
      throw error;
    }
    if (bytes.file.bytes !== locked.bytes || bytes.file.sha256 !== locked.sha256) fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked resource bytes changed: ${resource.locator}`);
    if (locked.proxy) {
      let proxyBytes: CutByteProbe;
      try { proxyBytes = await probeProjectBytes(projectRoot, locked.proxy.locator, { maxFileBytes: Math.max(1, locked.proxy.bytes) }); }
      catch (error) {
        if (lockProbeDrift(error)) fail("CUT_LOCK_INTEGRITY", `${child("$.resources", resource.id)}.proxy`, `Locked proxy resource bytes changed: ${locked.proxy.locator}`);
        throw error;
      }
      if (proxyBytes.file.bytes !== locked.proxy.bytes || proxyBytes.file.sha256 !== locked.proxy.sha256) fail("CUT_LOCK_INTEGRITY", `${child("$.resources", resource.id)}.proxy`, `Locked proxy resource bytes changed: ${locked.proxy.locator}`);
    }
  }
}

function sameLockedTypedDataFileIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export type CutTypedDataAssetFileHandle = Readonly<{
  stat: () => Promise<BigIntStats>;
  read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<Readonly<{ bytesRead: number }>>;
  close: () => Promise<void>;
}>;

export type CutTypedDataAssetFileIo = Readonly<{
  lstat: (path: string) => Promise<BigIntStats>;
  open: (path: string, flags: number) => Promise<CutTypedDataAssetFileHandle>;
}>;

export const defaultCutTypedDataAssetFileIo: CutTypedDataAssetFileIo = Object.freeze({
  lstat: (path: string) => lstat(path, { bigint: true }),
  open: async (path: string, flags: number) => {
    const handle = await open(path, flags);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
});

async function validateLockedTypedDataAssetBytes(
  ir: CutAVIR,
  projectRoot: string,
  expected: Readonly<Record<string, Pick<LockedResource, "bytes" | "sha256">>>,
  io: CutTypedDataAssetFileIo = defaultCutTypedDataAssetFileIo,
) {
  assertCutTypedDataAssetConsumerCompatibility(ir);
  for (const resource of Object.values(ir.resources).sort((left, right) => left.id.localeCompare(right.id))) {
    if (!resource.byteAuthority) continue;
    const path = `${child("$.resources", resource.id)}.byteAuthority`;
    const locked = expected[resource.id];
    if (!locked) fail("CUT_LOCK_STATE", child("$.resources", resource.id), "typed byte resource has no locked identity.");
    const authority = validateCutTypedDataAssetAuthority(resource.byteAuthority, path);
    const maximum = cutTypedDataAssetMaximumBytes[authority.kind];
    if (locked.bytes < 1 || locked.bytes > maximum) {
      throw new CutTypedDataAssetPayloadError(path, `${authority.kind} payload must contain 1 through ${maximum} bytes; found ${locked.bytes}.`);
    }
    const resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
    if (resolved.bytes !== locked.bytes) fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked typed byte resource size changed: ${resource.locator}`);
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new CutTypedDataAssetPayloadError(path, "cannot be read safely because this platform has no no-follow file-descriptor support.");
    }
    let handle: CutTypedDataAssetFileHandle | undefined;
    let failure: unknown;
    try {
      const pathBefore = await io.lstat(resolved.path);
      if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size !== BigInt(locked.bytes)) {
        fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked typed byte resource identity changed: ${resource.locator}`);
      }
      handle = await io.open(resolved.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || !sameLockedTypedDataFileIdentity(pathBefore, before)) {
        fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked typed byte resource identity changed: ${resource.locator}`);
      }
      const bytes = Buffer.alloc(locked.bytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (!result.bytesRead) fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked typed byte resource ended during its bounded read: ${resource.locator}`);
        offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, locked.bytes)).bytesRead !== 0) {
        fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked typed byte resource grew during its bounded read: ${resource.locator}`);
      }
      const after = await handle.stat();
      const pathAfter = await io.lstat(resolved.path);
      if (!after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile()
        || !sameLockedTypedDataFileIdentity(before, after)
        || !sameLockedTypedDataFileIdentity(after, pathAfter)) {
        fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked typed byte resource identity changed during its bounded read: ${resource.locator}`);
      }
      const observed = createHash("sha256").update(bytes).digest("hex");
      if (observed !== locked.sha256) fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked typed byte resource bytes changed: ${resource.locator}`);
      validateCutTypedDataAssetPayload(authority, bytes, path, {
        id: resource.id,
        module: resource.provenance.module,
        line: resource.provenance.span.start.line,
        column: resource.provenance.span.start.column,
      });
    } catch (error) {
      failure = error instanceof CutLockError || error instanceof CutTypedDataAssetPayloadError
        ? error
        : new CutTypedDataAssetPayloadError(path, `cannot securely read ${resource.locator}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (handle) {
      try { await handle.close(); }
      catch (error) {
        if (failure === undefined) {
          failure = new CutTypedDataAssetPayloadError(
            path,
            `cannot securely close ${resource.locator}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
    }
    if (failure !== undefined) throw failure;
  }
}

/** @internal Deterministic file-failure seam for the focused lock regression. */
export function validateLockedTypedDataAssetBytesForTests(
  ir: CutAVIR,
  projectRoot: string,
  expected: Readonly<Record<string, Pick<LockedResource, "bytes" | "sha256">>>,
  io: CutTypedDataAssetFileIo,
) {
  return validateLockedTypedDataAssetBytes(ir, projectRoot, expected, io);
}

async function readLockedImageSequenceManifestBytes(
  projectRoot: string,
  resource: IRResource,
  locked: CutImageSequenceLockedResource,
  node: CutAVIR["nodes"][string],
) {
  const path = `$.resources.${resource.id}`;
  if (resource.kind !== "data" || locked.kind !== "data" || locked.locator !== resource.locator) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_RESOURCE",
      path,
      "manifest authority must bind the exact declared and locked DataAsset locator.",
      node,
    );
  }
  if (!Number.isSafeInteger(locked.bytes) || locked.bytes < 1
    || locked.bytes > cutImageSequenceLimits.maximumManifestBytes) {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_LIMIT",
      path,
      `manifest must contain 1 through ${cutImageSequenceLimits.maximumManifestBytes} bytes; found ${locked.bytes}.`,
      node,
    );
  }
  const resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
  if (resolved.bytes !== locked.bytes) {
    fail("CUT_LOCK_INTEGRITY", path, `Locked image-sequence manifest size changed: ${resource.locator}`);
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_RESOURCE",
      path,
      "cannot be read safely because this platform has no no-follow file-descriptor support.",
      node,
    );
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let data: Buffer | undefined;
  let failure: unknown;
  try {
    const pathBefore = await lstat(resolved.path, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size !== BigInt(locked.bytes)) {
      fail("CUT_LOCK_INTEGRITY", path, `Locked image-sequence manifest identity changed: ${resource.locator}`);
    }
    handle = await open(resolved.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameLockedTypedDataFileIdentity(pathBefore, before)) {
      fail("CUT_LOCK_INTEGRITY", path, `Locked image-sequence manifest identity changed: ${resource.locator}`);
    }
    data = Buffer.alloc(locked.bytes);
    let offset = 0;
    while (offset < data.byteLength) {
      const result = await handle.read(data, offset, data.byteLength - offset, offset);
      if (!result.bytesRead) {
        fail("CUT_LOCK_INTEGRITY", path, `Locked image-sequence manifest ended during its bounded read: ${resource.locator}`);
      }
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, locked.bytes)).bytesRead !== 0) {
      fail("CUT_LOCK_INTEGRITY", path, `Locked image-sequence manifest grew during its bounded read: ${resource.locator}`);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(resolved.path, { bigint: true });
    if (!after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || !sameLockedTypedDataFileIdentity(before, after)
      || !sameLockedTypedDataFileIdentity(after, pathAfter)) {
      fail("CUT_LOCK_INTEGRITY", path, `Locked image-sequence manifest identity changed during its bounded read: ${resource.locator}`);
    }
    if (createHash("sha256").update(data).digest("hex") !== locked.sha256) {
      fail("CUT_LOCK_INTEGRITY", path, `Locked image-sequence manifest bytes changed: ${resource.locator}`);
    }
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    if (!failure) {
      failure = new CutImageSequenceError(
        "CUT_IMAGE_SEQUENCE_RESOURCE",
        path,
        `cannot close the securely opened manifest ${resource.locator}: ${error instanceof Error ? error.message : String(error)}.`,
        node,
        { cause: error },
      );
    }
  }
  if (failure) {
    if (failure instanceof CutLockError || failure instanceof CutImageSequenceError) throw failure;
    throw new CutImageSequenceError(
      "CUT_IMAGE_SEQUENCE_RESOURCE",
      path,
      `cannot securely read manifest ${resource.locator}: ${failure instanceof Error ? failure.message : String(failure)}.`,
      node,
      { cause: failure },
    );
  }
  if (!data) {
    throw new CutImageSequenceError("CUT_IMAGE_SEQUENCE_RESOURCE", path, "secure manifest read produced no bytes.", node);
  }
  return data;
}

async function validateLockedImageSequenceBytes(
  ir: CutAVIR,
  projectRoot: string,
  resources: Readonly<Record<string, CutImageSequenceLockedResource>>,
) {
  const manifests = new Map<string, ReturnType<typeof parseCutImageSequenceManifest>>();
  for (const { node, source } of cutImageSequenceSources(ir)) {
    const declared = ir.resources[source.manifestResourceId];
    const locked = resources[source.manifestResourceId];
    if (!declared || !locked) {
      throw new CutImageSequenceError(
        "CUT_IMAGE_SEQUENCE_RESOURCE",
        `$.nodes.${node.id}.inputs.source.manifest`,
        `has no locked manifest resource ${JSON.stringify(source.manifestResourceId)}.`,
        node,
      );
    }
    let manifest = manifests.get(source.manifestResourceId);
    if (!manifest) {
      manifest = parseCutImageSequenceManifest(
        await readLockedImageSequenceManifestBytes(projectRoot, declared, locked, node),
      );
      manifests.set(source.manifestResourceId, manifest);
    }
    validateCutImageSequenceManifestBinding(ir, node, source, manifest, resources);
  }
}

async function validateLockedLutBytes(
  ir: CutAVIR,
  projectRoot: string,
  expected: Readonly<Record<string, { locator: string; bytes: number; sha256: string }>>,
) {
  await validateReferenceLutResources(ir, async (resourceId, node) => {
    const resource = ir.resources[resourceId], locked = expected[resourceId];
    if (!resource || !locked) throw new ReferenceLutError("CUT_LUT_RESOURCE", node, `cannot resolve locked LUT resource ${resourceId}.`);
    if (locked.locator !== resource.locator) throw new ReferenceLutError("CUT_LUT_RESOURCE", node, `locked LUT locator does not match ${resource.locator}.`);
    if (locked.bytes < 1 || locked.bytes > referenceCubeLutLimits.maxBytes) throw new ReferenceLutError("CUT_LUT_LIMIT", node, `locked .cube bytes must be between 1 and ${referenceCubeLutLimits.maxBytes}.`);
    const resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
    if (resolved.bytes !== locked.bytes) fail("CUT_LOCK_INTEGRITY", child("$.resources", resourceId), `Locked LUT byte count changed: ${resource.locator}`);
    const bytes = await readFile(resolved.path);
    if (bytes.byteLength !== locked.bytes || createHash("sha256").update(bytes).digest("hex") !== locked.sha256) {
      fail("CUT_LOCK_INTEGRITY", child("$.resources", resourceId), `Locked LUT bytes changed: ${resource.locator}`);
    }
    return bytes;
  });
}

type ExpectedPlanarTrackResource = Readonly<{
  locator: string;
  bytes: number;
  sha256: string;
}>;

/** Parse every PlanarTrack sidecar through the same closed semantic contract
 * used by the renderer. When `expected` is supplied this additionally binds
 * the parse to the exact cut.lock byte identity, so lock creation, application
 * and later resource reverification cannot disagree about admissible data. */
async function validateLockedPlanarTrackBytes(
  ir: CutAVIR,
  projectRoot: string,
  consumers: ReferencePlanarTrackConsumers,
  expected?: Readonly<Record<string, ExpectedPlanarTrackResource>>,
) {
  const byteCache = new Map<string, Uint8Array>();
  let projectBytes = 0;
  // Populate in a deterministic resource order before any composition parse.
  // The local helper below only reads this closed cache.
  for (const [resourceId, config] of [...consumers.byResource].sort(([left], [right]) => left.localeCompare(right))) {
    const node = ir.nodes[config.nodeId], resource = ir.resources[resourceId], locked = expected?.[resourceId];
    if (!node || !resource || resource.kind !== "data") {
      if (node) throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_RESOURCE", node.id, node, `cannot resolve planar-track DataAsset ${resourceId}.`);
      throw new Error(`Internal CUT PlanarTrack resource ${resourceId} has no source-located consumer.`);
    }
    if (expected && !locked) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_RESOURCE", node.id, node, `cannot resolve locked planar-track resource ${resourceId}.`);
    }
    if (locked && locked.locator !== resource.locator) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_RESOURCE", node.id, node, `locked planar-track locator does not match ${resource.locator}.`);
    }
    const resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
    if (resolved.bytes < 1 || resolved.bytes > referencePlanarTrackLimits.maxBytes) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", node.id, node, `sidecar bytes must be between 1 and ${referencePlanarTrackLimits.maxBytes}; found ${resolved.bytes}.`);
    }
    if (locked && resolved.bytes !== locked.bytes) {
      fail("CUT_LOCK_INTEGRITY", child("$.resources", resourceId), `Locked PlanarTrack byte count changed: ${resource.locator}`);
    }
    const bytes = await readFile(resolved.path);
    if (bytes.byteLength !== resolved.bytes) {
      fail("CUT_LOCK_INTEGRITY", child("$.resources", resourceId), `PlanarTrack resource changed while it was being validated: ${resource.locator}`);
    }
    const observedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (locked && observedSha256 !== locked.sha256) {
      fail("CUT_LOCK_INTEGRITY", child("$.resources", resourceId), `Locked PlanarTrack bytes changed: ${resource.locator}`);
    }
    projectBytes += bytes.byteLength;
    if (!Number.isSafeInteger(projectBytes) || projectBytes > referencePlanarTrackLimits.maxProjectBytes) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", node.id, node, `project planar-track bytes exceed ${referencePlanarTrackLimits.maxProjectBytes}.`);
    }
    byteCache.set(resourceId, bytes);
  }

  const parsedNodeIds = new Set<string>();
  for (const composition of [...ir.compositions].sort((left, right) => left.id.localeCompare(right.id))) {
    const prepared = await validateReferencePlanarTrackResources(ir, composition, async (resourceId, node) => {
      const bytes = byteCache.get(resourceId);
      if (!bytes) throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_RESOURCE", node.id, node, `cannot load planar-track DataAsset ${resourceId}.`);
      return bytes;
    });
    for (const nodeId of prepared.keys()) parsedNodeIds.add(nodeId);
  }
  for (const [nodeId] of [...consumers.byNode].sort(([left], [right]) => left.localeCompare(right))) {
    if (parsedNodeIds.has(nodeId)) continue;
    const node = ir.nodes[nodeId];
    if (!node) throw new Error(`Internal CUT PlanarTrack node ${nodeId} disappeared during lock validation.`);
    throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_CONFIG", node.id, node, "is not reachable from exactly one validated composition.");
  }
}

export type CutTranscriptResourceFileIo = Readonly<Pick<CutTypedDataAssetFileIo, "open">>;

export const defaultCutTranscriptResourceFileIo: CutTranscriptResourceFileIo = Object.freeze({
  open: defaultCutTypedDataAssetFileIo.open,
});

async function readLockedTranscriptResource(
  projectRoot: string,
  resource: IRResource,
  locked: LockedResource,
  binding: NonNullable<CutAVIR["transcriptBindings"]>[number],
  bindingPath: string,
  io: CutTranscriptResourceFileIo = defaultCutTranscriptResourceFileIo,
) {
  const path = `${bindingPath}.transcriptResourceId`;
  if (locked.bytes < 1 || locked.bytes > cutTranscriptSidecarMaxBytes) {
    throw new CutTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_SIDECAR",
      path,
      binding,
      `locked transcript byte count must be 1 through ${cutTranscriptSidecarMaxBytes}; found ${locked.bytes}.`,
    );
  }
  let resolved: Awaited<ReturnType<typeof resolveLockedProjectPath>>;
  try {
    resolved = await resolveLockedProjectPath(projectRoot, resource.locator);
  } catch (error) {
    throw new CutTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_INTEGRITY",
      path,
      binding,
      `cannot resolve the locked transcript DataAsset (${error instanceof CutProjectError ? error.code : "filesystem"}).`,
    );
  }
  if (resolved.bytes !== locked.bytes) {
    throw new CutTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_INTEGRITY",
      path,
      binding,
      "transcript DataAsset size changed before its bounded read.",
    );
  }
  let handle: CutTypedDataAssetFileHandle | undefined;
  let bytes: Buffer | undefined;
  let failure: unknown;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await io.open(resolved.path, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.size !== BigInt(locked.bytes)) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_INTEGRITY",
        path,
        binding,
        "transcript DataAsset identity or size changed before its bounded read.",
      );
    }
    bytes = Buffer.alloc(locked.bytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new CutTranscriptLockError(
          "CUT_TRANSCRIPT_LOCK_INTEGRITY",
          path,
          binding,
          "transcript DataAsset ended during its bounded read.",
        );
      }
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, locked.bytes)).bytesRead !== 0) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_INTEGRITY",
        path,
        binding,
        "transcript DataAsset grew during its bounded read.",
      );
    }
    const after = await handle.stat();
    const unchanged = before.dev === after.dev
      && before.ino === after.ino
      && before.size === after.size
      && before.mtimeNs === after.mtimeNs
      && before.ctimeNs === after.ctimeNs;
    if (!after.isFile() || !unchanged) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_INTEGRITY",
        path,
        binding,
        "transcript DataAsset identity changed during its bounded read.",
      );
    }
  } catch (error) {
    failure = error instanceof CutTranscriptLockError
      ? error
      : new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_INTEGRITY",
        path,
        binding,
        `cannot open or read the transcript DataAsset safely (${error instanceof Error ? error.message : String(error)}).`,
      );
  }
  if (handle) {
    try { await handle.close(); }
    catch (error) {
      if (failure === undefined) {
        failure = new CutTranscriptLockError(
          "CUT_TRANSCRIPT_LOCK_INTEGRITY",
          path,
          binding,
          `cannot securely close the transcript DataAsset (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (!bytes) {
    throw new CutTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_INTEGRITY",
      path,
      binding,
      "transcript DataAsset bounded read did not produce bytes.",
    );
  }
  return bytes;
}

/** @internal Deterministic file-cleanup seam for the focused transcript lock regression. */
export function readLockedTranscriptResourceForTests(
  projectRoot: string,
  resource: IRResource,
  locked: LockedResource,
  binding: NonNullable<CutAVIR["transcriptBindings"]>[number],
  bindingPath: string,
  io: CutTranscriptResourceFileIo,
) {
  return readLockedTranscriptResource(projectRoot, resource, locked, binding, bindingPath, io);
}

export function cutIrUsesComplexTextShaping(ir: CutAVIR) {
  return Object.values(ir.nodes).some((node) =>
    node.op === "cut.visual.flow_text"
    && node.inputs.shaping?.kind === "object"
  );
}

function complexTextFeatureAuthorities(ir: CutAVIR): CutLockfile["features"] | undefined {
  const required = cutIrUsesComplexTextShaping(ir);
  if (!required) {
    if (ir.features !== undefined) {
      fail("CUT_LOCK_IDENTITY", "$.features", "IR feature authorities must be omitted when the graph contains no shaped FlowText.");
    }
    return undefined;
  }
  if (!ir.features) {
    fail("CUT_LOCK_IDENTITY", "$.features.complexTextShaping", "IR feature authority is required by shaped FlowText.");
  }
  const current = collectInstalledComplexTextBackendIdentity();
  if (!canonicalEqual(ir.features.complexTextShaping, current)) {
    fail("CUT_LOCK_IDENTITY", "$.features.complexTextShaping", "IR complex-text feature authority does not match the installed backend.");
  }
  return ir.features;
}

function assertComplexTextFeatureAuthority(ir: CutAVIR, features: CutLockfile["features"] | undefined) {
  const expected = complexTextFeatureAuthorities(ir);
  if (!canonicalEqual(features, expected)) {
    fail(
      "CUT_LOCK_IDENTITY",
      "$.features",
      "cut.lock feature authorities do not match the compiled IR and installed feature backend.",
    );
  }
}

export async function createCutLock(ir: CutAVIR, projectRoot: string): Promise<CutLockfile> {
  assertResolvedCutIr(ir);
  assertCutTypedDataAssetConsumerCompatibility(ir);
  // Pure declaration preflight must fail before backend discovery, probing,
  // hashing, or any subprocess can observe a malformed authored tuple.
  referenceVideoColorInterpretationWarnings(ir);
  if (ir.jobs.length) throw new Error(`Cannot freeze: ${ir.jobs.length} analysis/generation job(s) are unresolved.`);
  const features = complexTextFeatureAuthorities(ir);
  const lutConsumers = referenceLutConsumers(ir);
  const planarTrackConsumers = referencePlanarTrackConsumers(ir);
  const transcriptResources = transcriptResourceIds(ir);
  const imageSequenceManifests = imageSequenceManifestResourceIds(ir);
  await preflightTranscriptResourceSizes(ir, projectRoot, transcriptResources);
  await preflightImageSequenceManifestSizes(ir, projectRoot, imageSequenceManifests);
  await preflightLutResourceSizes(ir, projectRoot, lutConsumers);
  await preflightPlanarTrackResourceSizes(ir, projectRoot, planarTrackConsumers);
  await validateLockedPlanarTrackBytes(ir, projectRoot, planarTrackConsumers);
  const referenceBackend = await collectReferenceBackendIdentity();
  const resources: Record<string, LockedResource> = {};
  const selected = new Map<string, LockedSelectedMedia>();
  const selectedProxy = new Map<string, LockedSelectedMedia>();
  for (const resource of Object.values(ir.resources).sort((left, right) => left.id.localeCompare(right.id))) {
    const required = requiredMediaKinds(ir, resource), requireCadence = requiresLockedVideoCadence(ir, resource, required);
    const probe = await probeForResource(resource, projectRoot, required, specializedByteResourceLimit(resource, lutConsumers, planarTrackConsumers, transcriptResources, imageSequenceManifests), resource.locator, requireCadence), file = probeFile(probe);
    const proxyLocator = authoredProxyLocator(resource);
    if (proxyLocator === resource.locator) throw new CutProxyMediaError("CUT_PROXY_NOOP", resource, "proxy locator must differ from the master locator");
    let proxy: LockedResourceVariant | undefined;
    if (proxyLocator) {
      if (resource.kind !== "video" && resource.kind !== "audio") throw new CutProxyMediaError("CUT_PROXY_KIND", resource, "only VideoAsset and AudioAsset can declare a proxy");
      const proxyProbe = await probeForResource(resource, projectRoot, required, undefined, proxyLocator, requireCadence, "proxy");
      assertProxyEquivalent(resource, probe, proxyProbe, resourceUsesManagedInputColor(ir, resource.id));
      const [audioAlignment, videoAlignment] = await Promise.all([
        audioProxyAlignment(resource, projectRoot, resource.locator, probe, proxyLocator, proxyProbe),
        videoProxyAlignment(resource, projectRoot, resource.locator, probe, proxyLocator, proxyProbe),
      ]);
      proxy = lockedVariant(proxyLocator, proxyProbe, { audio: audioAlignment, video: videoAlignment });
      const proxyMedia = selectedMedia(proxyProbe, "proxy"); if (proxyMedia) selectedProxy.set(resource.id, proxyMedia);
    }
    resources[resource.id] = {
      id: resource.id,
      kind: resource.kind,
      locator: resource.locator,
      sha256: file.sha256,
      bytes: file.bytes,
      probe,
      ...(resource.byteAuthority ? { byteAuthority: resource.byteAuthority } : {}),
      ...(proxy ? { proxy } : {}),
    };
    const media = selectedMedia(probe); if (media) selected.set(resource.id, media);
  }
  await validateLockedTypedDataAssetBytes(ir, projectRoot, resources);
  await validateLockedImageSequenceBytes(ir, projectRoot, resources);
  await verifyCutTranscriptBindingsForLock(
    ir,
    resources,
    (resource, locked, binding, path) => readLockedTranscriptResource(projectRoot, resource, locked, binding, path),
  );
  await validateLockedLutBytes(ir, projectRoot, resources);
  await validateLockedPlanarTrackBytes(ir, projectRoot, planarTrackConsumers, resources);
  // A lock that declares semantic determinism must already agree with every
  // authored media consumer. Validate ranges, frame/sample grids, and explicit
  // inputColor against the just-probed selected streams before publishing it;
  // do not defer a known contradiction to apply/render.
  assertLockedExecutableMediaSourceBounds(ir, selected);
  if (selectedProxy.size) assertLockedExecutableMediaSourceBounds(ir, new Map([...selected].map(([id, media]) => [id, selectedProxy.get(id) ?? media])));
  await verifySourceModuleBytes(ir.sourceModules, projectRoot);
  return validateCutLock(canonicalClone({
    format: "cut-lock",
    version: 3,
    language: "0.4",
    toolchain: { compiler: ir.compiler, ir: 3, packageAbi: cutPackageAbi, referenceRuntime: cutReferenceRuntimeIdentity, referenceBackend },
    sourceHash: ir.sourceHash,
    ...(ir.sourceModules?.length ? { sourceModules: ir.sourceModules } : {}),
    ...(features ? { features } : {}),
    packages: [...ir.modules].sort((left, right) => left.specifier.localeCompare(right.specifier)),
    resources,
    jobs: {},
    determinism: { semantic: "locked", decodedMedia: "unverified", bitstream: "unverified" },
  }));
}

async function verifySourceModuleBytes(sourceModules: CutAVIR["sourceModules"], projectRoot: string) {
  for (const source of sourceModules ?? []) {
    const resolved = await resolveLockedProjectPath(projectRoot, source.specifier.slice(2));
    if (resolved.bytes !== source.bytes) fail("CUT_LOCK_SOURCE_MISMATCH", `$.sourceModules[${JSON.stringify(source.specifier)}].bytes`, "user-module byte count changed during locking.");
    const bytes = await readFile(resolved.path), sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== source.sha256) fail("CUT_LOCK_SOURCE_MISMATCH", `$.sourceModules[${JSON.stringify(source.specifier)}].sha256`, "user-module bytes changed during locking.");
  }
}

function samePackages(left: CutLockfile["packages"], right: CutLockfile["packages"]) {
  const sorted = (value: CutLockfile["packages"]) => [...value].sort((a, b) => a.specifier.localeCompare(b.specifier));
  return canonicalEqual(sorted(left), sorted(right));
}

function selectedMedia(probe: LockedResourceProbe, variant: "master" | "proxy" = "master"): LockedSelectedMedia | undefined {
  if (probe.kind !== "media") return undefined;
  const selectedVideo = probe.selected.video;
  const videoStream = selectedVideo
    ? probe.identity.streams.find((stream) => stream.index === selectedVideo.streamIndex && stream.type === "video")
    : undefined;
  const selectedAudio = probe.selected.audio;
  const audioStream = selectedAudio
    ? probe.identity.streams.find((stream) => stream.index === selectedAudio.streamIndex && stream.type === "audio")
    : undefined;
  if (selectedVideo && (!videoStream || !Number.isSafeInteger(videoStream.width) || !Number.isSafeInteger(videoStream.height)
    || Number(videoStream.width) < 1 || Number(videoStream.height) < 1)) {
    fail("CUT_LOCK_METADATA", "$.resources", `selected ${variant} video stream ${selectedVideo.streamIndex} has no positive locked native dimensions.`);
  }
  return {
    ...(selectedVideo ? { video: {
      ...selectedVideo,
      ...(videoStream?.start ? { start: videoStream.start } : {}),
      frameRate: selectedVideo.frameRate ?? videoStream?.frameRate as Rational,
      width: Number(videoStream?.width),
      height: Number(videoStream?.height),
      color: {
        pixelFormat: videoStream?.pixelFormat,
        fieldOrder: videoStream?.fieldOrder,
        colorRange: videoStream?.colorRange,
        colorSpace: videoStream?.colorSpace,
        colorTransfer: videoStream?.colorTransfer,
        colorPrimaries: videoStream?.colorPrimaries,
      },
      variant,
    } } : {}),
    ...(selectedAudio ? { audio: {
      streamIndex: selectedAudio.streamIndex,
      duration: selectedAudio.duration,
      durationSource: selectedAudio.durationSource === "decoded-audio-samples" ? "decoded-audio-samples" as const : "stream" as const,
      ...(selectedAudio.decodedAudioSamples ? { decodedAudioSamples: selectedAudio.decodedAudioSamples } : {}),
      timeBase: selectedAudio.timeBase,
      sampleRate: audioStream?.sampleRate as number,
    } } : {}),
  };
}

/**
 * Producer-backed signals consume locked media without introducing an IR node,
 * so the ordinary media-kernel walk cannot discover their source ranges. Keep
 * this validation at the lock boundary: semantic determinism must never be
 * declared for an amplitude producer whose selected source cannot execute.
 */
function assertLockedAudioAmplitudeProducerSourceBounds(
  ir: CutAVIR,
  selected: ReadonlyMap<string, LockedSelectedMedia>,
) {
  for (const [signalId, signal] of Object.entries(ir.signals).sort(([left], [right]) => left.localeCompare(right))) {
    if (signal.kind !== "track" || !signal.producer) continue;
    const producer = signal.producer;
    const path = `${child("$.signals", signalId)}.producer`;
    const resource = ir.resources[producer.source.id];
    if (!resource || resource.kind !== "audio") {
      fail("CUT_AUDIO_REACTIVE_RESOURCE", `${path}.source.id`, "must reference one locked AudioAsset resource.");
    }
    const audio = selected.get(producer.source.id)?.audio;
    if (!audio) {
      fail("CUT_AUDIO_REACTIVE_RESOURCE", `${path}.source.id`, `AudioAsset ${JSON.stringify(producer.source.id)} has no selected audio stream in cut.lock.`);
    }
    if (compareRational(producer.range.start, zeroRational) < 0
      || compareRational(producer.range.end, producer.range.start) <= 0) {
      fail("CUT_AUDIO_REACTIVE_RANGE", `${path}.range`, "must be one non-empty half-open source interval at or after zero.");
    }
    if (compareRational(producer.range.end, audio.duration) > 0) {
      fail(
        "CUT_AUDIO_REACTIVE_RESOURCE",
        `${path}.range`,
        `ends at ${producer.range.end.numerator}/${producer.range.end.denominator}s, beyond the selected audio stream bound ${audio.duration.numerator}/${audio.duration.denominator}s.`,
      );
    }
  }
}

function assertLockedExecutableMediaSourceBounds(ir: CutAVIR, selected: ReadonlyMap<string, LockedSelectedMedia>) {
  assertLockedMediaSourceBounds(ir, selected);
  assertLockedAudioAmplitudeProducerSourceBounds(ir, selected);
}

type LockResourceVerification = "full" | "verified-input-session";

async function applyCutLockInternal(ir: CutAVIR, input: CutLockfile, projectRoot: string, resourceVerification: LockResourceVerification) {
  const lock = validateCutLock(input);
  if (lock.sourceHash !== ir.sourceHash) fail("CUT_LOCK_SOURCE_MISMATCH", "$.sourceHash", "cut.lock was created for different CUT source.");
  if (!canonicalEqual(lock.sourceModules ?? [], ir.sourceModules ?? [])) fail("CUT_LOCK_SOURCE_MISMATCH", "$.sourceModules", "cut.lock was created for different user-module bytes.");
  await verifySourceModuleBytes(ir.sourceModules, projectRoot);
  if (lock.toolchain.compiler !== ir.compiler) fail("CUT_LOCK_IDENTITY", "$.toolchain.compiler", `cut.lock pins ${lock.toolchain.compiler}, but this build uses ${ir.compiler}.`);
  if (lock.toolchain.ir !== ir.version) fail("CUT_LOCK_IDENTITY", "$.toolchain.ir", `cut.lock pins CutAVIR ${lock.toolchain.ir}, but this build uses ${ir.version}.`);
  if (lock.toolchain.packageAbi !== cutPackageAbi) fail("CUT_LOCK_IDENTITY", "$.toolchain.packageAbi", `cut.lock pins package ABI ${lock.toolchain.packageAbi}, but this build uses ABI ${cutPackageAbi}.`);
  if (lock.toolchain.referenceRuntime !== cutReferenceRuntimeIdentity) fail("CUT_LOCK_IDENTITY", "$.toolchain.referenceRuntime", `cut.lock pins ${lock.toolchain.referenceRuntime}, but this build uses ${cutReferenceRuntimeIdentity}.`);
  if (!samePackages(lock.packages, ir.modules)) fail("CUT_LOCK_IDENTITY", "$.packages", "cut.lock package signatures do not match this build.");
  assertResolvedCutIr(ir);
  assertCutTypedDataAssetConsumerCompatibility(ir);
  assertComplexTextFeatureAuthority(ir, lock.features);
  const lutConsumers = referenceLutConsumers(ir);
  const planarTrackConsumers = referencePlanarTrackConsumers(ir);
  const transcriptResources = transcriptResourceIds(ir);
  const imageSequenceManifests = imageSequenceManifestResourceIds(ir);
  const resourceIds = Object.keys(ir.resources).sort();
  if (!canonicalEqual(resourceIds, Object.keys(lock.resources).sort())) fail("CUT_LOCK_IDENTITY", "$.resources", "cut.lock resource set does not match this build.");
  const jobIds = ir.jobs.map((job) => job.id).sort();
  if (!canonicalEqual(jobIds, Object.keys(lock.jobs).sort())) fail("CUT_LOCK_IDENTITY", "$.jobs", "cut.lock effect-job set does not match this build.");
  const metadata = new Map<string, { bytes: number; probe: LockedResourceProbe; proxy?: LockedResourceVariant }>(), selected = new Map<string, LockedSelectedMedia>(), selectedProxy = new Map<string, LockedSelectedMedia>();
  for (const id of resourceIds) {
    const resource = ir.resources[id], locked = lock.resources[id];
    if (locked.kind !== resource.kind || locked.locator !== resource.locator) fail("CUT_LOCK_METADATA", child("$.resources", id), `cut.lock metadata mismatch for resource “${id}”.`);
    if (!canonicalEqual(locked.byteAuthority, resource.byteAuthority)) {
      fail("CUT_LOCK_IDENTITY", `${child("$.resources", id)}.byteAuthority`, `cut.lock typed byte authority mismatch for resource “${id}”.`);
    }
    const proxyLocator = authoredProxyLocator(resource);
    if ((locked.proxy?.locator ?? undefined) !== proxyLocator) fail("CUT_LOCK_METADATA", `${child("$.resources", id)}.proxy`, `cut.lock proxy metadata mismatch for resource “${id}”.`);
    metadata.set(id, { bytes: locked.bytes, probe: locked.probe, ...(locked.proxy ? { proxy: locked.proxy } : {}) });
  }
  const lockedByteExpectations = new Map(resourceIds.map((id) => {
    const locked = lock.resources[id];
    return [id, { bytes: locked.bytes, sha256: locked.sha256, ...(locked.proxy ? { proxy: locked.proxy } : {}) }];
  }));
  if (resourceVerification === "full") {
    await preflightTranscriptResourceSizes(ir, projectRoot, transcriptResources);
    await preflightImageSequenceManifestSizes(ir, projectRoot, imageSequenceManifests);
    await verifyLockedResourceSizes(ir, projectRoot, lockedByteExpectations);
    await preflightLutResourceSizes(ir, projectRoot, lutConsumers);
    await preflightPlanarTrackResourceSizes(ir, projectRoot, planarTrackConsumers);
    await verifyLockedResourceHashes(ir, projectRoot, lockedByteExpectations);
    await validateLockedTypedDataAssetBytes(ir, projectRoot, lock.resources);
    await validateLockedImageSequenceBytes(ir, projectRoot, lock.resources);
    await validateLockedPlanarTrackBytes(ir, projectRoot, planarTrackConsumers, lock.resources);
  }
  if (resourceVerification === "full") {
    const referenceBackend = await collectReferenceBackendIdentity();
    assertCutLockReferenceBackendIdentity(lock.toolchain.referenceBackend, referenceBackend);
  }

  for (const id of resourceIds) {
    const resource = ir.resources[id], locked = lock.resources[id];
    if (resourceVerification === "full") {
      const required = requiredMediaKinds(ir, resource), requireCadence = requiresLockedVideoCadence(ir, resource, required);
      const current = await probeForResource(resource, projectRoot, required, specializedByteResourceLimit(resource, lutConsumers, planarTrackConsumers, transcriptResources, imageSequenceManifests), resource.locator, requireCadence), file = probeFile(current);
      if (file.bytes !== locked.bytes || file.sha256 !== locked.sha256) fail("CUT_LOCK_INTEGRITY", child("$.resources", id), `Locked resource bytes changed: ${resource.locator}`);
      assertNativeProbeMatchesLock(locked.probe, current, `${child("$.resources", id)}.probe`, resource.locator);
      if (locked.proxy) {
        const currentProxy = await probeForResource(resource, projectRoot, required, undefined, locked.proxy.locator, requireCadence, "proxy"), proxyFile = probeFile(currentProxy);
        if (proxyFile.bytes !== locked.proxy.bytes || proxyFile.sha256 !== locked.proxy.sha256) fail("CUT_LOCK_INTEGRITY", `${child("$.resources", id)}.proxy`, `Locked proxy resource bytes changed: ${locked.proxy.locator}`);
        assertNativeProbeMatchesLock(locked.proxy.probe, currentProxy, `${child("$.resources", id)}.proxy.probe`, locked.proxy.locator);
        assertProxyEquivalent(resource, current, currentProxy, resourceUsesManagedInputColor(ir, resource.id));
        const currentAlignment = await audioProxyAlignment(resource, projectRoot, resource.locator, current, locked.proxy.locator, currentProxy);
        if ((currentAlignment === undefined) !== (locked.proxy.audioAlignment === undefined)
          || (currentAlignment !== undefined && !canonicalEqual(currentAlignment, locked.proxy.audioAlignment))) {
          fail("CUT_PROXY_AUDIO_ALIGNMENT", `${child("$.resources", id)}.proxy.audioAlignment`, `Locked audio-proxy alignment evidence changed: ${locked.proxy.locator}`);
        }
        const currentVideoAlignment = await videoProxyAlignment(resource, projectRoot, resource.locator, current, locked.proxy.locator, currentProxy);
        if ((currentVideoAlignment === undefined) !== (locked.proxy.videoAlignment === undefined)
          || (currentVideoAlignment !== undefined && !canonicalEqual(currentVideoAlignment, locked.proxy.videoAlignment))) {
          fail("CUT_PROXY_VIDEO_ALIGNMENT", `${child("$.resources", id)}.proxy.videoAlignment`, `Locked video-proxy alignment evidence changed: ${locked.proxy.locator}`);
        }
      }
    } else if (locked.proxy) {
      assertProxyEquivalent(resource, locked.probe, locked.proxy.probe, resourceUsesManagedInputColor(ir, resource.id));
    }
    const media = selectedMedia(locked.probe); if (media) selected.set(id, media);
    if (locked.proxy) { const proxyMedia = selectedMedia(locked.proxy.probe, "proxy"); if (proxyMedia) selectedProxy.set(id, proxyMedia); }
  }
  if (resourceVerification === "full") await validateLockedLutBytes(ir, projectRoot, lock.resources);
  if (resourceVerification === "full") {
    await verifyCutTranscriptBindingsForLock(
      ir,
      lock.resources,
      (resource, locked, binding, path) => readLockedTranscriptResource(projectRoot, resource, locked, binding, path),
    );
  }
  assertLockedExecutableMediaSourceBounds(ir, selected);
  if (selectedProxy.size) assertLockedExecutableMediaSourceBounds(ir, new Map([...selected].map(([id, media]) => [id, selectedProxy.get(id) ?? media])));

  const embedLockState = (target: CutAVIR) => {
    for (const id of resourceIds) {
      const resource = target.resources[id], locked = lock.resources[id], verified = metadata.get(id)!;
      resource.state = "locked";
      resource.sha256 = locked.sha256;
      resource.metadata = { lockVersion: 2, bytes: verified.bytes, probe: verified.probe, ...(verified.proxy ? { proxy: verified.proxy } : {}) };
    }
    for (const job of target.jobs) {
      const locked = lock.jobs[job.id]; if (!locked) fail("CUT_LOCK_JOB_UNRESOLVED", child("$.jobs", job.id), `Unresolved locked effect job: ${job.id}`);
      job.state = "locked"; job.artifactHash = locked.artifactHash;
    }
    target.determinism.semantic = "locked";
    target.determinism.decodedMedia = "unverified";
    target.determinism.bitstream = "unverified";
  };
  // Lock-dependent assertions can expose hostile generic IR call shapes that
  // were unavailable before selected-stream metadata existed. Resolve them on
  // a private candidate first so a failure cannot partially lock the caller's
  // resources or mutate its stored assertion states.
  const assertionCandidate: CutAVIR = {
    ...ir,
    determinism: { ...ir.determinism },
    resources: Object.fromEntries(Object.entries(ir.resources).map(([id, resource]) => [id, { ...resource }])),
    jobs: ir.jobs.map((job) => ({ ...job })),
    assertions: ir.assertions.map((assertion) => ({ ...assertion })),
  };
  embedLockState(assertionCandidate);
  refreshLockedCutDomainAssertionStatuses(assertionCandidate);
  embedLockState(ir);
  ir.assertions.forEach((assertion, index) => { assertion.status = assertionCandidate.assertions[index]!.status; });
  finalizeGraphHashes(ir);
  registerAppliedCutLockIr(ir);
  return ir;
}

/** Apply and verify the complete public lock contract, including the backend. */
export function applyCutLock(ir: CutAVIR, input: CutLockfile, projectRoot: string) {
  return applyCutLockInternal(ir, input, projectRoot, "full");
}

/**
 * @internal CLI bridge for media commands that bind all resource bytes before
 * backend collection. Returning the expected identity makes the required
 * post-snapshot comparison an explicit value that the caller must thread.
 */
export async function applyCutLockForVerifiedInputSession(ir: CutAVIR, input: CutLockfile, projectRoot: string) {
  const lock = validateCutLock(input);
  const applied = await applyCutLockInternal(ir, lock, projectRoot, "verified-input-session");
  return Object.freeze({ ir: applied, referenceBackend: lock.toolchain.referenceBackend });
}

function validateEmbeddedLockedResources(ir: CutAVIR) {
  const entries = Object.entries(ir.resources).sort(([left], [right]) => left.localeCompare(right));
  const resources = entries.map(([, resource]) => resource);
  if (resources.length > defaultCutLockValidationLimits.maxResources) {
    fail("CUT_LOCK_STATE", "$.resources", `embedded lock state exceeds the ${defaultCutLockValidationLimits.maxResources}-resource limit.`);
  }
  const context: ValidationContext = { limits: defaultCutLockValidationLimits, totalStringBytes: 0 };
  const expected = new Map<string, { probe: LockedResourceProbe; bytes: number; proxy?: LockedResourceVariant }>();
  for (const [resourceKey, resource] of entries) {
    if (resource.id !== resourceKey) fail("CUT_LOCK_STATE", child("$.resources", resourceKey), `embedded resource key does not match its canonical id ${JSON.stringify(resource.id)}.`);
    const path = child("$.resources", resource.id), metadata = resource.metadata;
    if (resource.state !== "locked" || !resource.sha256 || !isRecord(metadata) || metadata.lockVersion !== 2) {
      fail("CUT_LOCK_STATE", path, `Resource “${resource.id}” has no validated cut.lock v3 metadata.`);
    }
    const allowed = new Set(["lockVersion", "bytes", "probe", "proxy"]);
    const unknown = Object.keys(metadata).find((key) => !allowed.has(key));
    if (unknown) fail("CUT_LOCK_STATE", `${path}.metadata.${unknown}`, `Resource “${resource.id}” embedded lock metadata contains an unsupported field.`);
    const reconstructed = {
      id: resource.id,
      kind: resource.kind,
      locator: resource.locator,
      sha256: resource.sha256,
      bytes: metadata.bytes,
      probe: metadata.probe,
      ...(resource.byteAuthority ? { byteAuthority: resource.byteAuthority } : {}),
      ...(metadata.proxy !== undefined ? { proxy: metadata.proxy } : {}),
    };
    try { validateLockedResource(reconstructed, path, context, resource.id); }
    catch (error) {
      if (error instanceof CutLockError) fail("CUT_LOCK_STATE", path, `Resource “${resource.id}” embedded lock metadata is invalid (${error.code} at ${error.path}).`);
      throw error;
    }
    const proxy = metadata.proxy as LockedResourceVariant | undefined;
    const proxyLocator = authoredProxyLocator(resource);
    if ((proxy?.locator ?? undefined) !== proxyLocator) fail("CUT_LOCK_STATE", `${path}.metadata.proxy`, `Resource “${resource.id}” embedded proxy does not match its authored proxy locator.`);
    expected.set(resource.id, deepFreeze(canonicalClone({
      probe: metadata.probe as LockedResourceProbe,
      bytes: metadata.bytes as number,
      ...(proxy ? { proxy } : {}),
    })));
  }
  return expected;
}

function validateEmbeddedLockedSemantics(
  ir: CutAVIR,
  expected: ReadonlyMap<string, { probe: LockedResourceProbe; bytes: number; proxy?: LockedResourceVariant }>,
) {
  // This is intentionally pure: it checks the complete stored media/proxy,
  // consumer-range, managed-color and LUT-ownership contracts before any
  // caller-controlled pathname or native decoder is touched.
  assertCutTypedDataAssetConsumerCompatibility(ir);
  referenceLutConsumers(ir);
  referencePlanarTrackConsumers(ir);
  cutImageSequenceSources(ir);
  const selected = new Map<string, LockedSelectedMedia>(), selectedProxy = new Map<string, LockedSelectedMedia>();
  for (const resource of Object.values(ir.resources).sort((left, right) => left.id.localeCompare(right.id))) {
    const locked = expected.get(resource.id)!;
    const master = selectedMedia(locked.probe); if (master) selected.set(resource.id, master);
    if (locked.proxy) {
      assertProxyEquivalent(resource, locked.probe, locked.proxy.probe, resourceUsesManagedInputColor(ir, resource.id));
      const proxy = selectedMedia(locked.proxy.probe, "proxy"); if (proxy) selectedProxy.set(resource.id, proxy);
    }
  }
  assertLockedExecutableMediaSourceBounds(ir, selected);
  if (selectedProxy.size) assertLockedExecutableMediaSourceBounds(ir, new Map([...selected].map(([id, media]) => [id, selectedProxy.get(id) ?? media])));
}

/** Validate canonical embedded cut.lock state without filesystem or native-backend work. */
export function validateEmbeddedLockedIrContract(ir: CutAVIR) {
  const expected = validateEmbeddedLockedResources(ir);
  validateEmbeddedLockedSemantics(ir, expected);
}

export async function verifyLockedIrResources(ir: CutAVIR, projectRoot: string) {
  const lutConsumers = referenceLutConsumers(ir);
  const planarTrackConsumers = referencePlanarTrackConsumers(ir);
  const transcriptResources = transcriptResourceIds(ir);
  const imageSequenceManifests = imageSequenceManifestResourceIds(ir);
  const expected = validateEmbeddedLockedResources(ir);
  validateEmbeddedLockedSemantics(ir, expected);
  const lockedByteExpectations = new Map([...expected].map(([id, locked]) => [id, {
    bytes: locked.bytes,
    sha256: ir.resources[id].sha256!,
    ...(locked.proxy ? { proxy: locked.proxy } : {}),
  }]));
  await preflightTranscriptResourceSizes(ir, projectRoot, transcriptResources);
  await preflightImageSequenceManifestSizes(ir, projectRoot, imageSequenceManifests);
  await verifyLockedResourceSizes(ir, projectRoot, lockedByteExpectations);
  await preflightLutResourceSizes(ir, projectRoot, lutConsumers);
  await preflightPlanarTrackResourceSizes(ir, projectRoot, planarTrackConsumers);
  await verifyLockedResourceHashes(ir, projectRoot, lockedByteExpectations);
  const expectedTypedData = Object.fromEntries(Object.values(ir.resources).map((resource) => [resource.id, {
    bytes: expected.get(resource.id)!.bytes,
    sha256: resource.sha256!,
  }]));
  await validateLockedTypedDataAssetBytes(ir, projectRoot, expectedTypedData);
  const expectedImageSequences = Object.fromEntries(Object.values(ir.resources).map((resource) => [resource.id, {
    id: resource.id,
    kind: resource.kind,
    locator: resource.locator,
    bytes: expected.get(resource.id)!.bytes,
    sha256: resource.sha256!,
    probe: expected.get(resource.id)!.probe,
  }]));
  await validateLockedImageSequenceBytes(ir, projectRoot, expectedImageSequences);
  const expectedPlanarTracks = Object.fromEntries(Object.values(ir.resources).map((resource) => [resource.id, {
    locator: resource.locator,
    bytes: expected.get(resource.id)!.bytes,
    sha256: resource.sha256!,
  }]));
  await validateLockedPlanarTrackBytes(ir, projectRoot, planarTrackConsumers, expectedPlanarTracks);

  const selected = new Map<string, LockedSelectedMedia>(), selectedProxy = new Map<string, LockedSelectedMedia>();
  const expectedLuts: Record<string, { locator: string; bytes: number; sha256: string }> = {};
  for (const resource of Object.values(ir.resources).sort((left, right) => left.id.localeCompare(right.id))) {
    const locked = expected.get(resource.id)!, expectedProbe = locked.probe;
    const required = requiredMediaKinds(ir, resource), requireCadence = requiresLockedVideoCadence(ir, resource, required);
    const current = await probeForResource(resource, projectRoot, required, specializedByteResourceLimit(resource, lutConsumers, planarTrackConsumers, transcriptResources, imageSequenceManifests), resource.locator, requireCadence), file = probeFile(current);
    const expectedBytes = locked.bytes;
    // Recheck identity after native probing as a TOCTOU guard. The byte-only
    // pass above is what guarantees decoder-independent drift diagnostics.
    if (file.bytes !== expectedBytes) fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked resource size changed: ${resource.locator}`);
    if (file.sha256 !== resource.sha256) fail("CUT_LOCK_INTEGRITY", child("$.resources", resource.id), `Locked resource bytes changed: ${resource.locator}`);
    assertNativeProbeMatchesLock(expectedProbe, current, `${child("$.resources", resource.id)}.probe`, resource.locator);
    const media = selectedMedia(expectedProbe); if (media) selected.set(resource.id, media);
    const proxy = locked.proxy;
    if (proxy) {
      const currentProxy = await probeForResource(resource, projectRoot, required, undefined, proxy.locator, requireCadence, "proxy"), proxyFile = probeFile(currentProxy);
      if (proxyFile.bytes !== proxy.bytes) fail("CUT_LOCK_INTEGRITY", `${child("$.resources", resource.id)}.proxy`, `Locked proxy resource size changed: ${proxy.locator}`);
      if (proxyFile.sha256 !== proxy.sha256) fail("CUT_LOCK_INTEGRITY", `${child("$.resources", resource.id)}.proxy`, `Locked proxy resource bytes changed: ${proxy.locator}`);
      assertNativeProbeMatchesLock(proxy.probe, currentProxy, `${child("$.resources", resource.id)}.proxy.probe`, proxy.locator);
      assertProxyEquivalent(resource, expectedProbe, proxy.probe, resourceUsesManagedInputColor(ir, resource.id));
      const currentAudioAlignment = await audioProxyAlignment(resource, projectRoot, resource.locator, current, proxy.locator, currentProxy);
      if ((currentAudioAlignment === undefined) !== (proxy.audioAlignment === undefined)
        || (currentAudioAlignment !== undefined && !canonicalEqual(currentAudioAlignment, proxy.audioAlignment))) {
        fail("CUT_PROXY_AUDIO_ALIGNMENT", `${child("$.resources", resource.id)}.proxy.audioAlignment`, `Locked audio-proxy alignment evidence changed: ${proxy.locator}`);
      }
      const currentVideoAlignment = await videoProxyAlignment(resource, projectRoot, resource.locator, current, proxy.locator, currentProxy);
      if ((currentVideoAlignment === undefined) !== (proxy.videoAlignment === undefined)
        || (currentVideoAlignment !== undefined && !canonicalEqual(currentVideoAlignment, proxy.videoAlignment))) {
        fail("CUT_PROXY_VIDEO_ALIGNMENT", `${child("$.resources", resource.id)}.proxy.videoAlignment`, `Locked video-proxy alignment evidence changed: ${proxy.locator}`);
      }
      const proxyMedia = selectedMedia(proxy.probe, "proxy"); if (proxyMedia) selectedProxy.set(resource.id, proxyMedia);
    }
    expectedLuts[resource.id] = { locator: resource.locator, bytes: expectedBytes, sha256: resource.sha256 };
  }
  const transcriptLockedResources = Object.fromEntries(Object.values(ir.resources).map((resource) => {
    const locked = expected.get(resource.id)!;
    return [resource.id, {
      id: resource.id,
      kind: resource.kind,
      locator: resource.locator,
      sha256: resource.sha256!,
      bytes: locked.bytes,
      probe: locked.probe,
      ...(resource.byteAuthority ? { byteAuthority: resource.byteAuthority } : {}),
      ...(locked.proxy ? { proxy: locked.proxy } : {}),
    } satisfies LockedResource];
  }));
  await verifyCutTranscriptBindingsForLock(
    ir,
    transcriptLockedResources,
    (resource, locked, binding, path) => readLockedTranscriptResource(projectRoot, resource, locked, binding, path),
  );
  await validateLockedLutBytes(ir, projectRoot, expectedLuts);
  assertLockedExecutableMediaSourceBounds(ir, selected);
  if (selectedProxy.size) assertLockedExecutableMediaSourceBounds(ir, new Map([...selected].map(([id, media]) => [id, selectedProxy.get(id) ?? media])));
}
