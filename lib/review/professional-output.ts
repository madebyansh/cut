import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, statfs } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { hash, stableJsonStringify } from "../core/stable";
import { parseCutLanguage } from "../language/parser";
import { checkCutModule } from "../language/checker";
import { compileCutModule, CutCompileError } from "../language/compiler";
import { loadCutAvIr } from "../language/ir-loader";
import type { CutAVIR, IRComposition, IRValue } from "../language/ir";
import { applyCutLock, loadCutLock, resolveLockedProjectPath } from "../language/lock";
import { loadCutUserModuleGraph } from "../language/user-modules";
import { cutPackageLockFile, cutPackageManifestFile } from "../package/manifest";
import { createCutExternalPackageContext, type CutExternalPackageContext } from "../package/context";
import { loadCutPackageLock, resolveVerifiedCutPackageGraph } from "../package/resolver";
import { probeProjectMedia, type CutMediaProbe } from "../project/probe";
import { rationalToNumber } from "../language/rational";
import { validateReferenceStaticVisualGraphs } from "../runtime/reference/static-visual-validation";
import { renderReferenceIr, type ReferenceRenderManifest } from "../runtime/reference/render";
import { runFfmpeg, runFfmpegCapture } from "../runtime/reference/ffmpeg";
import { scanReferenceStereoF32LeFile, type ReferenceAudioPeakScan } from "../runtime/reference/audio-peak";
import { scanReferenceStereoF32LeTruePeakFile, type ReferenceAudioTruePeakScan } from "../runtime/reference/audio-true-peak";
import { measureReferenceAudioAuthoredBoundary, type ReferenceLoudnessMeasurement } from "../runtime/reference/audio";
import { inspectReferenceDecodedTruePeak } from "../runtime/reference/audio-delivery-inspection";
import { verifyReferenceStemEvidence } from "./reference-stem-evidence";

export const professionalOutputReviewFormat = "cut-professional-output-review" as const;
export const professionalOutputReviewVersion = 1 as const;
export const professionalOutputMinimumScore = 8 as const;

export function professionalHeroDeliveryProfile(width: number, height: number, fps: number) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && Number.isFinite(fps)
    && Math.min(width, height) >= 1_080 && Math.max(width, height) <= 7_680
    && fps >= 24_000 / 1_001 && fps <= 120;
}

export type ProfessionalIterationIdentity = Readonly<{
  sourceSha256: string;
  lockSha256: string;
  irSha256: string;
  buildId: string;
}>;

export function professionalFailedIterationIdentityIsDistinct(failed: ProfessionalIterationIdentity, final: ProfessionalIterationIdentity) {
  const exactArtifactTuple = failed.sourceSha256 === final.sourceSha256 && failed.lockSha256 === final.lockSha256 && failed.irSha256 === final.irSha256;
  // buildId is CUT's semantic execution identity: formatting/comments are
  // intentionally excluded, while lock-applied resource changes are included.
  // A byte-distinct source/lock tuple with the final buildId is therefore not a
  // failed creative execution and cannot justify arbitrary different media.
  const sameLockedExecution = failed.buildId === final.buildId;
  return !exactArtifactTuple && !sameLockedExecution;
}

export const professionalOutputCategoryIds = [
  "narrative",
  "editorial",
  "cinematographyComposition",
  "motion",
  "typography",
  "visualExplanation",
  "sound",
  "originalityCohesion",
  "technicalDelivery",
] as const;

export type ProfessionalOutputCategoryId = typeof professionalOutputCategoryIds[number];

/**
 * Closed v1 human-review rubric. These IDs are deliberately semantic rather
 * than implementation feature names: every reviewer must make an explicit,
 * time-supported judgment for every item. CUT validates the completeness and
 * identity of those judgments; it does not make them on the reviewer's behalf.
 */
export const professionalOutputCriteria = Object.freeze({
  narrative: Object.freeze([
    "narrative.central-question",
    "narrative.escalating-causal-argument",
    "narrative.meaningful-reveal-payoff",
    "narrative.no-feature-list-screenplay",
    "narrative.no-generic-ai-prose",
  ]),
  editorial: Object.freeze([
    "editorial.purposeful-shot-changes",
    "editorial.visual-continuity",
    "editorial.motivated-pacing",
    "editorial.j-l-cuts",
    "editorial.breath-and-emphasis",
    "editorial.no-narrated-deck",
  ]),
  cinematographyComposition: Object.freeze([
    "cinematography.depth",
    "cinematography.hierarchy",
    "cinematography.controlled-focal-attention",
    "cinematography.spatial-continuity",
    "cinematography.intentional-camera-movement",
    "cinematography.frame-polish",
  ]),
  motion: Object.freeze([
    "motion.continuous-meaningful-animation",
    "motion.excellent-easing",
    "motion.idea-carrying-transitions",
    "motion.no-template-or-floating-card-motion",
  ]),
  typography: Object.freeze([
    "typography.publication-hierarchy",
    "typography.shaping",
    "typography.wrapping",
    "typography.tracking",
    "typography.integrated-annotation",
  ]),
  visualExplanation: Object.freeze([
    "visual-explanation.causality",
    "visual-explanation.scale",
    "visual-explanation.time",
    "visual-explanation.place",
    "visual-explanation.integrated-evidence-not-decoration",
  ]),
  sound: Object.freeze([
    "sound.human-quality-narration",
    "sound.cleared-score",
    "sound.designed-sfx-and-ambience",
    "sound.musical-edit-points",
    "sound.transitions",
    "sound.intentional-silence",
    "sound.ducking",
    "sound.stems",
    "sound.professional-loudness-and-true-peak",
  ]),
  originalityCohesion: Object.freeze([
    "originality.authored-visual-system",
    "originality.recurring-motifs",
    "originality.deliberate-variation",
    "originality.no-preset-collage",
    "originality.no-creator-copy",
  ]),
  technicalDelivery: Object.freeze([
    "technical.no-glitches",
    "technical.no-clipped-text",
    "technical.no-dead-frames",
    "technical.no-broken-alpha",
    "technical.no-illegible-labels",
    "technical.no-abrupt-audio",
    "technical.no-cache-lies",
    "technical.deterministic-replay",
    "technical.cleared-material",
    "technical.no-creative-post-fix",
  ]),
} satisfies Record<ProfessionalOutputCategoryId, readonly string[]>);

export type ProfessionalOutputCriterionId = typeof professionalOutputCriteria[ProfessionalOutputCategoryId][number];

type ReviewDecision = "pass" | "revise";
export type HashedArtifact = { path: string; sha256: string };
type TechnicalSubject = {
  sourceSha256: string;
  lockSha256: string;
  irSha256: string;
  outputSha256: string;
  renderManifestSha256: string;
};
type EvidenceGate = {
  status: "pass" | "fail";
  command: string;
  reportFormat: string;
  subject: TechnicalSubject;
  artifact: HashedArtifact;
};

export type ProfessionalOutputReview = {
  format: typeof professionalOutputReviewFormat;
  version: typeof professionalOutputReviewVersion;
  decision: ReviewDecision;
  artifact: {
    kind: "hero-film";
    iterationId: string;
    title: string;
    durationSeconds: number;
    source: HashedArtifact;
    lock: HashedArtifact;
    ir: HashedArtifact;
    output: HashedArtifact;
    renderManifest: HashedArtifact;
  };
  authoringBoundary: {
    publicCutSource: boolean;
    publicPackagesOnly: boolean;
    publicCliOnly: boolean;
    allProjectSpecificCreativeAndTemporalIntentInCut: boolean;
    noAfterEffectsOrPremiere: boolean;
    noBespokeHiddenCompositor: boolean;
    noProjectNameBranch: boolean;
    noManualFrameReplacement: boolean;
    noCreativePostFixAfterRender: boolean;
    ffmpegRole: "codec-and-low-level-media-only";
  };
  playbackReview: {
    implementer: ReviewSession & { relationship: "implementer" };
    independent: ReviewSession & {
      relationship: "independent";
      implementationInvolvement: "none";
      conflictOfInterest: boolean;
    };
  };
  referenceCalibration: {
    treatment: HashedArtifact;
    referenceBoard: HashedArtifact;
    sideBySideReview: HashedArtifact;
    originalityAttestation: "calibration-only-no-copy";
    references: Array<{
      id: string;
      creator: string;
      title: string;
      url: string;
      durationSeconds: number;
      role: "primary-neo" | "adjacent-top-tier";
      shotAnalysis: HashedArtifact;
    }>;
  };
  categories: Record<ProfessionalOutputCategoryId, CategoryReview>;
  hardFailures: Array<{
    code: HardFailureCode;
    category: ProfessionalOutputCategoryId;
    evidence: string;
    startSeconds: number;
    endSeconds: number;
  }>;
  technicalEvidence: {
    sourceCheck: EvidenceGate;
    sourceTest: EvidenceGate;
    renderManifest: EvidenceGate;
    deterministicReplay: EvidenceGate;
    frameScan: EvidenceGate;
    audioDelivery: EvidenceGate;
    rightsProvenance: EvidenceGate;
    canonicalSourceBoundary: EvidenceGate;
  };
  iterationHistory: {
    complete: boolean;
    finalIterationId: string;
    priorFailedIterations: Array<{
      id: string;
      retained: boolean;
      source: HashedArtifact;
      lock: HashedArtifact;
      ir: HashedArtifact;
      output: HashedArtifact;
      renderManifest: HashedArtifact;
      review: HashedArtifact;
      failedCategories: ProfessionalOutputCategoryId[];
      summary: string;
    }>;
  };
};

type ReviewSession = {
  reviewerId: string;
  reviewerName: string;
  relationship: "implementer" | "independent";
  reviewedAt: string;
  fullFilm: boolean;
  fullSpeedPlayback: boolean;
  headphoneListening: boolean;
  referenceComparison: boolean;
  display: string;
  audioDevice: string;
  notes: HashedArtifact;
};

type CategoryReview = {
  implementer: CategoryAssessment;
  independent: CategoryAssessment;
};

type CategoryAssessment = {
  reviewerId: string;
  status: ReviewDecision;
  score: number;
  summary: string;
  evidence: Array<{ startSeconds: number; endSeconds: number; observation: string }>;
  criteria: Array<{
    id: ProfessionalOutputCriterionId;
    status: ReviewDecision;
    evidence: Array<{ startSeconds: number; endSeconds: number; observation: string }>;
  }>;
  comparisons: Array<{
    referenceId: string;
    verdict: "below-tier" | "same-tier" | "above-tier";
    summary: string;
    heroEvidence: Array<{ startSeconds: number; endSeconds: number; observation: string }>;
    referenceEvidence: Array<{ startSeconds: number; endSeconds: number; observation: string }>;
  }>;
};

const hardFailureCodes = [
  "SLIDESHOW_GRAMMAR",
  "GENERIC_NARRATION",
  "WEAK_SOUND",
  "INCOHERENT_PACING",
  "PRIMITIVE_MOTION",
  "ILLEGIBLE_TYPOGRAPHY",
  "TECHNICAL_GLITCH",
  "RIGHTS_OR_PROVENANCE",
  "HIDDEN_POSTPROCESSING",
  "INCOMPLETE_REVIEW",
  "REFERENCE_COPYING",
] as const;
type HardFailureCode = typeof hardFailureCodes[number];

const technicalEvidenceIds = [
  "sourceCheck",
  "sourceTest",
  "renderManifest",
  "deterministicReplay",
  "frameScan",
  "audioDelivery",
  "rightsProvenance",
  "canonicalSourceBoundary",
] as const;

const technicalEvidenceContracts = Object.freeze({
  sourceCheck: Object.freeze({ command: "check", reportFormat: "cut-professional-source-check" }),
  sourceTest: Object.freeze({ command: "test", reportFormat: "cut-professional-source-test" }),
  renderManifest: Object.freeze({ command: "render", reportFormat: "cut-professional-render-binding" }),
  deterministicReplay: Object.freeze({ command: "render-replay", reportFormat: "cut-professional-deterministic-replay" }),
  frameScan: Object.freeze({ command: "frame-scan", reportFormat: "cut-professional-frame-scan" }),
  audioDelivery: Object.freeze({ command: "audio-delivery", reportFormat: "cut-professional-audio-delivery" }),
  rightsProvenance: Object.freeze({ command: "rights-audit", reportFormat: "cut-professional-rights-provenance" }),
  canonicalSourceBoundary: Object.freeze({ command: "canonical-source-audit", reportFormat: "cut-professional-canonical-source-boundary" }),
} satisfies Record<typeof technicalEvidenceIds[number], Readonly<{ command: string; reportFormat: string }>>);

export class CutProfessionalOutputReviewError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutProfessionalOutputReviewError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutProfessionalOutputReviewError(code, path, message);
}

const defaultJsonLimits = Object.freeze({
  maxInputBytes: 2 * 1024 * 1024,
  maxDepth: 40,
  maxNodes: 150_000,
  maxStringBytes: 128 * 1024,
  maxTotalStringBytes: 1024 * 1024,
});

class StrictReviewJsonScanner {
  private offset = 0;
  private nodes = 0;
  private totalStringBytes = 0;

  constructor(private readonly source: string) {}

  scan() {
    this.space();
    this.value(0, "$", false);
    this.space();
    if (this.offset !== this.source.length) this.syntax("unexpected trailing input");
  }

  private syntax(message: string): never {
    fail("CUT_REVIEW_JSON_PARSE", "$", `${message} at text offset ${this.offset}.`);
  }

  private space() {
    while (this.offset < this.source.length && /\s/u.test(this.source[this.offset])) this.offset += 1;
  }

  private value(depth: number, path: string, key: boolean) {
    this.nodes += 1;
    if (this.nodes > defaultJsonLimits.maxNodes) fail("CUT_REVIEW_JSON_LIMIT", path, `exceeds maxNodes (${defaultJsonLimits.maxNodes}).`);
    if (depth > defaultJsonLimits.maxDepth) fail("CUT_REVIEW_JSON_LIMIT", path, `exceeds maxDepth (${defaultJsonLimits.maxDepth}).`);
    this.space();
    const character = this.source[this.offset];
    if (character === "{") return this.object(depth, path);
    if (character === "[") return this.array(depth, path);
    if (character === '"') return this.string(path, key);
    if (this.source.startsWith("true", this.offset)) { this.offset += 4; return; }
    if (this.source.startsWith("false", this.offset)) { this.offset += 5; return; }
    if (this.source.startsWith("null", this.offset)) { this.offset += 4; return; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.offset));
    if (!number) this.syntax("expected a JSON value");
    this.offset += number[0].length;
  }

  private string(path: string, key: boolean): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        let decoded: unknown;
        try { decoded = JSON.parse(this.source.slice(start, this.offset)); }
        catch { this.syntax("invalid JSON string"); }
        if (typeof decoded !== "string") this.syntax("invalid JSON string");
        for (let index = 0; index < decoded.length; index += 1) {
          const code = decoded.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = decoded.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff) fail("CUT_REVIEW_JSON_ENCODING", path, "contains an unpaired UTF-16 surrogate.");
            index += 1;
          } else if (code >= 0xdc00 && code <= 0xdfff) fail("CUT_REVIEW_JSON_ENCODING", path, "contains an unpaired UTF-16 surrogate.");
        }
        const bytes = Buffer.byteLength(decoded, "utf8");
        if (bytes > defaultJsonLimits.maxStringBytes) fail("CUT_REVIEW_JSON_LIMIT", path, `string exceeds ${defaultJsonLimits.maxStringBytes} UTF-8 bytes.`);
        this.totalStringBytes += bytes;
        if (this.totalStringBytes > defaultJsonLimits.maxTotalStringBytes) fail("CUT_REVIEW_JSON_LIMIT", path, `strings exceed ${defaultJsonLimits.maxTotalStringBytes} UTF-8 bytes in total.`);
        if (key && ["__proto__", "prototype", "constructor"].includes(decoded)) fail("CUT_REVIEW_JSON_UNSAFE_KEY", path, `unsafe object key ${JSON.stringify(decoded)} is forbidden.`);
        return decoded;
      }
      if (character === "\\") {
        this.offset += 1;
        if (this.offset >= this.source.length) this.syntax("unterminated escape");
        if (this.source[this.offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.source.slice(this.offset + 1, this.offset + 5))) this.syntax("invalid Unicode escape");
          this.offset += 5;
        } else {
          if (!/["\\/bfnrt]/u.test(this.source[this.offset])) this.syntax("invalid string escape");
          this.offset += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.syntax("unescaped control character in string");
      this.offset += 1;
    }
    this.syntax("unterminated JSON string");
  }

  private object(depth: number, path: string) {
    this.offset += 1;
    this.space();
    const keys = new Set<string>();
    if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax("expected an object key");
      const key = this.string(path, true);
      if (keys.has(key)) fail("CUT_REVIEW_JSON_DUPLICATE_KEY", path, `contains duplicate decoded key ${JSON.stringify(key)}.`);
      keys.add(key);
      this.space();
      if (this.source[this.offset] !== ":") this.syntax("expected ':' after object key");
      this.offset += 1;
      this.value(depth + 1, `${path}[${JSON.stringify(key)}]`, false);
      this.space();
      if (this.source[this.offset] === "}") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or '}'");
      this.offset += 1;
      this.space();
    }
  }

  private array(depth: number, path: string) {
    this.offset += 1;
    this.space();
    if (this.source[this.offset] === "]") { this.offset += 1; return; }
    let index = 0;
    while (true) {
      this.value(depth + 1, `${path}[${index}]`, false);
      index += 1;
      this.space();
      if (this.source[this.offset] === "]") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or ']'");
      this.offset += 1;
      this.space();
    }
  }
}

export function parseStrictReviewJson(input: string | Uint8Array): unknown {
  let source: string;
  if (typeof input === "string") source = input;
  else if (input instanceof Uint8Array) {
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(input); }
    catch { fail("CUT_REVIEW_JSON_ENCODING", "$input", "is not valid UTF-8."); }
  } else fail("CUT_REVIEW_JSON_TYPE", "$input", "must be a string or Uint8Array.");
  if (Buffer.byteLength(source, "utf8") > defaultJsonLimits.maxInputBytes) fail("CUT_REVIEW_JSON_LIMIT", "$input", `exceeds ${defaultJsonLimits.maxInputBytes} UTF-8 bytes.`);
  new StrictReviewJsonScanner(source).scan();
  try { return JSON.parse(source) as unknown; }
  catch { fail("CUT_REVIEW_JSON_PARSE", "$", "is not valid JSON."); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string) {
  if (!isRecord(value)) fail("CUT_REVIEW_TYPE", path, "must be a plain object.");
  return value;
}

function closed(value: unknown, path: string, required: readonly string[]) {
  const result = record(value, path), allowed = new Set(required);
  for (const field of required) if (!Object.hasOwn(result, field)) fail("CUT_REVIEW_MISSING_FIELD", path, `is missing required field ${JSON.stringify(field)}.`);
  for (const field of Object.keys(result)) if (!allowed.has(field)) fail("CUT_REVIEW_UNKNOWN_FIELD", `${path}.${field}`, "is not part of professional-output review v1.");
  return result;
}

function textValue(value: unknown, path: string, maximum = 4096) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) fail("CUT_REVIEW_TYPE", path, `must be a non-empty string no longer than ${maximum} UTF-8 bytes without NUL.`);
  return value;
}

function identifier(value: unknown, path: string) {
  const result = textValue(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) fail("CUT_REVIEW_IDENTIFIER", path, "must be a stable ASCII identifier.");
  return result;
}

function booleanValue(value: unknown, path: string) {
  if (typeof value !== "boolean") fail("CUT_REVIEW_TYPE", path, "must be boolean.");
  return value;
}

function finiteNumber(value: unknown, path: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail("CUT_REVIEW_RANGE", path, `must be a finite number from ${minimum} through ${maximum}.`);
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  const result = finiteNumber(value, path, minimum, maximum);
  if (!Number.isSafeInteger(result)) fail("CUT_REVIEW_TYPE", path, "must be an integer.");
  return result;
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("CUT_REVIEW_ENUM", path, `must be one of ${allowed.join(", ")}.`);
  return value as T;
}

function arrayValue(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail("CUT_REVIEW_RANGE", path, `must contain from ${minimum} through ${maximum} items.`);
  return value;
}

function unique(values: readonly string[], path: string) {
  if (new Set(values).size !== values.length) fail("CUT_REVIEW_DUPLICATE", path, "must not contain duplicate values.");
}

function locator(value: unknown, path: string) {
  const result = textValue(value, path, 1024);
  if (result.startsWith("/") || /^[A-Za-z]:/u.test(result) || result.includes("\\") || result.includes("%") || result.includes("?") || result.includes("#")) fail("CUT_REVIEW_PATH", path, "must be a plain POSIX path relative to the review file.");
  const segments = result.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || ["__proto__", "prototype", "constructor"].includes(segment))) fail("CUT_REVIEW_PATH", path, "cannot contain empty, dot, parent, or unsafe path segments.");
  return result;
}

function sha256(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("CUT_REVIEW_HASH", path, "must be a lowercase SHA-256 digest.");
  return value;
}

function hashedArtifact(value: unknown, path: string): HashedArtifact {
  const item = closed(value, path, ["path", "sha256"]);
  return { path: locator(item.path, `${path}.path`), sha256: sha256(item.sha256, `${path}.sha256`) };
}

function isoDate(value: unknown, path: string) {
  const result = textValue(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) fail("CUT_REVIEW_DATE", path, "must be a valid UTC RFC 3339 timestamp.");
  return result;
}

function reviewSession(value: unknown, path: string, relationship: "implementer" | "independent") {
  const fields = ["audioDevice", "display", "fullFilm", "fullSpeedPlayback", "headphoneListening", "notes", "referenceComparison", "relationship", "reviewedAt", "reviewerId", "reviewerName"];
  const item = closed(value, path, relationship === "independent" ? [...fields, "implementationInvolvement", "conflictOfInterest"] : fields);
  const actualRelationship = enumValue(item.relationship, `${path}.relationship`, [relationship]);
  const result = {
    reviewerId: identifier(item.reviewerId, `${path}.reviewerId`),
    reviewerName: textValue(item.reviewerName, `${path}.reviewerName`, 256),
    relationship: actualRelationship,
    reviewedAt: isoDate(item.reviewedAt, `${path}.reviewedAt`),
    fullFilm: booleanValue(item.fullFilm, `${path}.fullFilm`),
    fullSpeedPlayback: booleanValue(item.fullSpeedPlayback, `${path}.fullSpeedPlayback`),
    headphoneListening: booleanValue(item.headphoneListening, `${path}.headphoneListening`),
    referenceComparison: booleanValue(item.referenceComparison, `${path}.referenceComparison`),
    display: textValue(item.display, `${path}.display`, 512),
    audioDevice: textValue(item.audioDevice, `${path}.audioDevice`, 512),
    notes: hashedArtifact(item.notes, `${path}.notes`),
  };
  if (relationship === "independent") return {
    ...result,
    relationship,
    implementationInvolvement: enumValue(item.implementationInvolvement, `${path}.implementationInvolvement`, ["none"]),
    conflictOfInterest: booleanValue(item.conflictOfInterest, `${path}.conflictOfInterest`),
  };
  return { ...result, relationship };
}

function timedEvidence(value: unknown, path: string, duration: number, minimum = 1, maximum = 24) {
  const evidence = arrayValue(value, path, minimum, maximum).map((entry, index) => {
    const evidencePath = `${path}[${index}]`, observation = closed(entry, evidencePath, ["endSeconds", "observation", "startSeconds"]);
    const startSeconds = finiteNumber(observation.startSeconds, `${evidencePath}.startSeconds`, 0, duration);
    const endSeconds = finiteNumber(observation.endSeconds, `${evidencePath}.endSeconds`, 0, duration);
    if (endSeconds <= startSeconds) fail("CUT_REVIEW_TIME_RANGE", evidencePath, "requires endSeconds greater than startSeconds.");
    return { startSeconds, endSeconds, observation: textValue(observation.observation, `${evidencePath}.observation`, 2000) };
  });
  unique(evidence.map((entry) => `${entry.startSeconds}/${entry.endSeconds}/${entry.observation}`), path);
  return evidence;
}

type ProfessionalReference = ProfessionalOutputReview["referenceCalibration"]["references"][number];

function categoryAssessment(
  value: unknown,
  path: string,
  category: ProfessionalOutputCategoryId,
  duration: number,
  reviewerId: string,
  references: readonly ProfessionalReference[],
): CategoryAssessment {
  const item = closed(value, path, ["comparisons", "criteria", "evidence", "reviewerId", "score", "status", "summary"]);
  const actualReviewerId = identifier(item.reviewerId, `${path}.reviewerId`);
  if (actualReviewerId !== reviewerId) fail("CUT_REVIEW_REVIEWER", `${path}.reviewerId`, `must identify ${JSON.stringify(reviewerId)}.`);
  const evidence = timedEvidence(item.evidence, `${path}.evidence`, duration, 2, 24);
  const expectedCriteria = professionalOutputCriteria[category];
  const criteria = arrayValue(item.criteria, `${path}.criteria`, expectedCriteria.length, expectedCriteria.length).map((entry, index) => {
    const criterionPath = `${path}.criteria[${index}]`, criterion = closed(entry, criterionPath, ["evidence", "id", "status"]);
    return {
      id: enumValue(criterion.id, `${criterionPath}.id`, expectedCriteria) as ProfessionalOutputCriterionId,
      status: enumValue(criterion.status, `${criterionPath}.status`, ["pass", "revise"]),
      evidence: timedEvidence(criterion.evidence, `${criterionPath}.evidence`, duration, 1, 12),
    };
  });
  unique(criteria.map((criterion) => criterion.id), `${path}.criteria[].id`);
  const missingCriteria = expectedCriteria.filter((criterion) => !criteria.some((assessment) => assessment.id === criterion));
  if (missingCriteria.length) fail("CUT_REVIEW_CRITERIA", `${path}.criteria`, `must assess the exact ${category} rubric; missing ${missingCriteria.join(", ")}.`);

  const referenceById = new Map(references.map((reference) => [reference.id, reference]));
  const comparisons = arrayValue(item.comparisons, `${path}.comparisons`, references.length, references.length).map((entry, index) => {
    const comparisonPath = `${path}.comparisons[${index}]`, comparison = closed(entry, comparisonPath, ["heroEvidence", "referenceEvidence", "referenceId", "summary", "verdict"]);
    const referenceId = identifier(comparison.referenceId, `${comparisonPath}.referenceId`), reference = referenceById.get(referenceId);
    if (!reference) fail("CUT_REVIEW_REFERENCE", `${comparisonPath}.referenceId`, `must identify one selected reference; received ${JSON.stringify(referenceId)}.`);
    return {
      referenceId,
      verdict: enumValue(comparison.verdict, `${comparisonPath}.verdict`, ["below-tier", "same-tier", "above-tier"]),
      summary: textValue(comparison.summary, `${comparisonPath}.summary`, 4000),
      heroEvidence: timedEvidence(comparison.heroEvidence, `${comparisonPath}.heroEvidence`, duration, 1, 12),
      referenceEvidence: timedEvidence(comparison.referenceEvidence, `${comparisonPath}.referenceEvidence`, reference.durationSeconds, 1, 12),
    };
  });
  unique(comparisons.map((comparison) => comparison.referenceId), `${path}.comparisons[].referenceId`);
  const missingReferences = references.filter((reference) => !comparisons.some((comparison) => comparison.referenceId === reference.id));
  if (missingReferences.length) fail("CUT_REVIEW_REFERENCE", `${path}.comparisons`, `must compare this category to every selected reference; missing ${missingReferences.map((reference) => reference.id).join(", ")}.`);
  return {
    reviewerId: actualReviewerId,
    status: enumValue(item.status, `${path}.status`, ["pass", "revise"]),
    score: integer(item.score, `${path}.score`, 1, 10),
    summary: textValue(item.summary, `${path}.summary`, 4000),
    evidence,
    criteria,
    comparisons,
  };
}

function categoryReview(value: unknown, path: string, category: ProfessionalOutputCategoryId, duration: number, implementerId: string, independentId: string, references: readonly ProfessionalReference[]): CategoryReview {
  const item = closed(value, path, ["implementer", "independent"]);
  return {
    implementer: categoryAssessment(item.implementer, `${path}.implementer`, category, duration, implementerId, references),
    independent: categoryAssessment(item.independent, `${path}.independent`, category, duration, independentId, references),
  };
}

function technicalSubject(value: unknown, path: string): TechnicalSubject {
  const item = closed(value, path, ["irSha256", "lockSha256", "outputSha256", "renderManifestSha256", "sourceSha256"]);
  return {
    sourceSha256: sha256(item.sourceSha256, `${path}.sourceSha256`),
    lockSha256: sha256(item.lockSha256, `${path}.lockSha256`),
    irSha256: sha256(item.irSha256, `${path}.irSha256`),
    outputSha256: sha256(item.outputSha256, `${path}.outputSha256`),
    renderManifestSha256: sha256(item.renderManifestSha256, `${path}.renderManifestSha256`),
  };
}

function evidenceGate(value: unknown, path: string, id: typeof technicalEvidenceIds[number]): EvidenceGate {
  const item = closed(value, path, ["artifact", "command", "reportFormat", "status", "subject"]), contract = technicalEvidenceContracts[id];
  const artifact = hashedArtifact(item.artifact, `${path}.artifact`);
  if (!artifact.path.endsWith(".json")) fail("CUT_REVIEW_ARTIFACT", `${path}.artifact.path`, "typed technical evidence must be a .json report.");
  return {
    status: enumValue(item.status, `${path}.status`, ["pass", "fail"]),
    command: enumValue(item.command, `${path}.command`, [contract.command]),
    reportFormat: enumValue(item.reportFormat, `${path}.reportFormat`, [contract.reportFormat]),
    subject: technicalSubject(item.subject, `${path}.subject`),
    artifact,
  };
}

function canonicalClone<T>(value: T): T { return JSON.parse(stableJsonStringify(value)) as T; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

export function validateProfessionalOutputReview(value: unknown): ProfessionalOutputReview {
  const rootFields = ["artifact", "authoringBoundary", "categories", "decision", "format", "hardFailures", "iterationHistory", "playbackReview", "referenceCalibration", "technicalEvidence", "version"];
  const root = closed(value, "$", rootFields);
  if (root.format !== professionalOutputReviewFormat || root.version !== professionalOutputReviewVersion) fail("CUT_REVIEW_VERSION", "$", `requires ${professionalOutputReviewFormat} version ${professionalOutputReviewVersion}.`);

  const rawArtifact = closed(root.artifact, "$.artifact", ["durationSeconds", "ir", "iterationId", "kind", "lock", "output", "renderManifest", "source", "title"]);
  const durationSeconds = finiteNumber(rawArtifact.durationSeconds, "$.artifact.durationSeconds", 180, 300);
  const artifact = {
    kind: enumValue(rawArtifact.kind, "$.artifact.kind", ["hero-film"]),
    iterationId: identifier(rawArtifact.iterationId, "$.artifact.iterationId"),
    title: textValue(rawArtifact.title, "$.artifact.title", 512),
    durationSeconds,
    source: hashedArtifact(rawArtifact.source, "$.artifact.source"),
    lock: hashedArtifact(rawArtifact.lock, "$.artifact.lock"),
    ir: hashedArtifact(rawArtifact.ir, "$.artifact.ir"),
    output: hashedArtifact(rawArtifact.output, "$.artifact.output"),
    renderManifest: hashedArtifact(rawArtifact.renderManifest, "$.artifact.renderManifest"),
  };
  if (!artifact.source.path.endsWith(".cut")) fail("CUT_REVIEW_ARTIFACT", "$.artifact.source.path", "hero source must be a .cut file.");
  if (!artifact.lock.path.endsWith(".lock")) fail("CUT_REVIEW_ARTIFACT", "$.artifact.lock.path", "hero lock must be a .lock file.");
  if (!artifact.ir.path.endsWith(".cutir.json")) fail("CUT_REVIEW_ARTIFACT", "$.artifact.ir.path", "hero IR must be a .cutir.json file.");
  if (!artifact.renderManifest.path.endsWith(".manifest.json")) fail("CUT_REVIEW_ARTIFACT", "$.artifact.renderManifest.path", "hero render manifest must be a .manifest.json file.");
  if (!artifact.output.path.endsWith(".mp4")) fail("CUT_REVIEW_ARTIFACT", "$.artifact.output.path", "professional hero output must be CUT's MP4/AAC delivery artifact.");
  unique([artifact.source.path, artifact.lock.path, artifact.ir.path, artifact.output.path, artifact.renderManifest.path], "$.artifact");

  const rawBoundary = closed(root.authoringBoundary, "$.authoringBoundary", ["allProjectSpecificCreativeAndTemporalIntentInCut", "ffmpegRole", "noAfterEffectsOrPremiere", "noBespokeHiddenCompositor", "noCreativePostFixAfterRender", "noManualFrameReplacement", "noProjectNameBranch", "publicCliOnly", "publicCutSource", "publicPackagesOnly"]);
  const authoringBoundary = {
    publicCutSource: booleanValue(rawBoundary.publicCutSource, "$.authoringBoundary.publicCutSource"),
    publicPackagesOnly: booleanValue(rawBoundary.publicPackagesOnly, "$.authoringBoundary.publicPackagesOnly"),
    publicCliOnly: booleanValue(rawBoundary.publicCliOnly, "$.authoringBoundary.publicCliOnly"),
    allProjectSpecificCreativeAndTemporalIntentInCut: booleanValue(rawBoundary.allProjectSpecificCreativeAndTemporalIntentInCut, "$.authoringBoundary.allProjectSpecificCreativeAndTemporalIntentInCut"),
    noAfterEffectsOrPremiere: booleanValue(rawBoundary.noAfterEffectsOrPremiere, "$.authoringBoundary.noAfterEffectsOrPremiere"),
    noBespokeHiddenCompositor: booleanValue(rawBoundary.noBespokeHiddenCompositor, "$.authoringBoundary.noBespokeHiddenCompositor"),
    noProjectNameBranch: booleanValue(rawBoundary.noProjectNameBranch, "$.authoringBoundary.noProjectNameBranch"),
    noManualFrameReplacement: booleanValue(rawBoundary.noManualFrameReplacement, "$.authoringBoundary.noManualFrameReplacement"),
    noCreativePostFixAfterRender: booleanValue(rawBoundary.noCreativePostFixAfterRender, "$.authoringBoundary.noCreativePostFixAfterRender"),
    ffmpegRole: enumValue(rawBoundary.ffmpegRole, "$.authoringBoundary.ffmpegRole", ["codec-and-low-level-media-only"]),
  };

  const rawPlayback = closed(root.playbackReview, "$.playbackReview", ["implementer", "independent"]);
  const implementer = reviewSession(rawPlayback.implementer, "$.playbackReview.implementer", "implementer") as ProfessionalOutputReview["playbackReview"]["implementer"];
  const independent = reviewSession(rawPlayback.independent, "$.playbackReview.independent", "independent") as ProfessionalOutputReview["playbackReview"]["independent"];
  if (implementer.reviewerId === independent.reviewerId || implementer.reviewerName.trim().toLocaleLowerCase("en-US") === independent.reviewerName.trim().toLocaleLowerCase("en-US")) fail("CUT_REVIEW_INDEPENDENCE", "$.playbackReview.independent", "must identify a person distinct from the implementer.");
  if (implementer.notes.path === independent.notes.path || implementer.notes.sha256 === independent.notes.sha256) fail("CUT_REVIEW_INDEPENDENCE", "$.playbackReview.independent.notes", "must preserve notes independently authored from the implementer's notes.");

  const rawCalibration = closed(root.referenceCalibration, "$.referenceCalibration", ["originalityAttestation", "referenceBoard", "references", "sideBySideReview", "treatment"]);
  const references = arrayValue(rawCalibration.references, "$.referenceCalibration.references", 3, 12).map((entry, index) => {
    const path = `$.referenceCalibration.references[${index}]`, reference = closed(entry, path, ["creator", "durationSeconds", "id", "role", "shotAnalysis", "title", "url"]);
    const url = textValue(reference.url, `${path}.url`, 2048);
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { fail("CUT_REVIEW_URL", `${path}.url`, "must be an absolute HTTPS URL."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) fail("CUT_REVIEW_URL", `${path}.url`, "must be an HTTPS URL without embedded credentials or a non-default port.");
    const hostname = parsed.hostname.toLocaleLowerCase("en-US").replace(/\.+$/u, "").replace(/^\[|\]$/gu, "");
    const reservedBases = ["example.com", "example.org", "example.net", "localhost"];
    const reservedSuffixes = [".example", ".invalid", ".test", ".localhost", ".local", ".internal", ".home.arpa"];
    const reserved = reservedBases.some((base) => hostname === base || hostname.endsWith(`.${base}`))
      || reservedSuffixes.some((suffix) => hostname.endsWith(suffix))
      || !hostname.includes(".")
      || isIP(hostname) !== 0;
    if (reserved) fail("CUT_REVIEW_URL", `${path}.url`, "must identify a public DNS hostname, not a placeholder, local/private name, or IP literal.");
    return {
      id: identifier(reference.id, `${path}.id`),
      creator: textValue(reference.creator, `${path}.creator`, 256),
      title: textValue(reference.title, `${path}.title`, 512),
      url,
      durationSeconds: finiteNumber(reference.durationSeconds, `${path}.durationSeconds`, Number.MIN_VALUE, 86_400),
      role: enumValue(reference.role, `${path}.role`, ["primary-neo", "adjacent-top-tier"]),
      shotAnalysis: hashedArtifact(reference.shotAnalysis, `${path}.shotAnalysis`),
    };
  });
  unique(references.map((entry) => entry.id), "$.referenceCalibration.references[].id");
  unique(references.map((entry) => entry.url), "$.referenceCalibration.references[].url");
  unique(references.map((entry) => entry.shotAnalysis.path), "$.referenceCalibration.references[].shotAnalysis.path");
  unique(references.map((entry) => entry.shotAnalysis.sha256), "$.referenceCalibration.references[].shotAnalysis.sha256");
  const primaryNeo = references.filter((entry) => entry.role === "primary-neo");
  if (primaryNeo.length !== 1 || primaryNeo[0]!.creator.trim().toLocaleLowerCase("en-US") !== "neo") fail("CUT_REVIEW_REFERENCE", "$.referenceCalibration.references", "must contain exactly one primary-neo reference whose creator is Neo.");
  const adjacentCreators = references.filter((entry) => entry.role === "adjacent-top-tier").map((entry) => entry.creator.trim().toLocaleLowerCase("en-US"));
  if (adjacentCreators.length < 2 || new Set(adjacentCreators).size !== adjacentCreators.length || adjacentCreators.includes("neo")) fail("CUT_REVIEW_REFERENCE", "$.referenceCalibration.references", "must contain at least two adjacent-top-tier references from distinct non-Neo creators.");
  const referenceCalibration = {
    treatment: hashedArtifact(rawCalibration.treatment, "$.referenceCalibration.treatment"),
    referenceBoard: hashedArtifact(rawCalibration.referenceBoard, "$.referenceCalibration.referenceBoard"),
    sideBySideReview: hashedArtifact(rawCalibration.sideBySideReview, "$.referenceCalibration.sideBySideReview"),
    originalityAttestation: enumValue(rawCalibration.originalityAttestation, "$.referenceCalibration.originalityAttestation", ["calibration-only-no-copy"]),
    references,
  };

  const rawCategories = closed(root.categories, "$.categories", professionalOutputCategoryIds);
  const categories = Object.fromEntries(professionalOutputCategoryIds.map((category) => [category, categoryReview(rawCategories[category], `$.categories.${category}`, category, durationSeconds, implementer.reviewerId, independent.reviewerId, references)])) as Record<ProfessionalOutputCategoryId, CategoryReview>;
  for (const category of professionalOutputCategoryIds) {
    const assessment = categories[category], path = `$.categories.${category}.independent`;
    if (assessment.implementer.summary.trim().toLocaleLowerCase("en-US") === assessment.independent.summary.trim().toLocaleLowerCase("en-US")
      || stableJsonStringify(assessment.implementer.evidence) === stableJsonStringify(assessment.independent.evidence)) {
      fail("CUT_REVIEW_INDEPENDENCE", path, "must contain independently authored category reasoning and timed evidence, not copied implementer text.");
    }
    for (const comparison of assessment.independent.comparisons) {
      const implementerComparison = assessment.implementer.comparisons.find((item) => item.referenceId === comparison.referenceId)!;
      if (comparison.summary.trim().toLocaleLowerCase("en-US") === implementerComparison.summary.trim().toLocaleLowerCase("en-US")
        || stableJsonStringify(comparison.heroEvidence) === stableJsonStringify(implementerComparison.heroEvidence)
        || stableJsonStringify(comparison.referenceEvidence) === stableJsonStringify(implementerComparison.referenceEvidence)) {
        fail("CUT_REVIEW_INDEPENDENCE", `${path}.comparisons`, `must preserve distinct reasoning and timecoded observations for reference ${JSON.stringify(comparison.referenceId)}.`);
      }
    }
    for (const independentCriterion of assessment.independent.criteria) {
      const implementerCriterion = assessment.implementer.criteria.find((item) => item.id === independentCriterion.id)!;
      if (stableJsonStringify(independentCriterion.evidence) === stableJsonStringify(implementerCriterion.evidence)) {
        fail("CUT_REVIEW_INDEPENDENCE", `${path}.criteria`, `must preserve independently authored timed evidence for criterion ${JSON.stringify(independentCriterion.id)}.`);
      }
    }
  }

  const hardFailures = arrayValue(root.hardFailures, "$.hardFailures", 0, 64).map((entry, index) => {
    const path = `$.hardFailures[${index}]`, failure = closed(entry, path, ["category", "code", "endSeconds", "evidence", "startSeconds"]);
    const startSeconds = finiteNumber(failure.startSeconds, `${path}.startSeconds`, 0, durationSeconds);
    const endSeconds = finiteNumber(failure.endSeconds, `${path}.endSeconds`, 0, durationSeconds);
    if (endSeconds <= startSeconds) fail("CUT_REVIEW_TIME_RANGE", path, "requires endSeconds greater than startSeconds.");
    return {
      code: enumValue(failure.code, `${path}.code`, hardFailureCodes),
      category: enumValue(failure.category, `${path}.category`, professionalOutputCategoryIds),
      evidence: textValue(failure.evidence, `${path}.evidence`, 2000),
      startSeconds,
      endSeconds,
    };
  });

  const rawTechnical = closed(root.technicalEvidence, "$.technicalEvidence", technicalEvidenceIds);
  const technicalEvidence = Object.fromEntries(technicalEvidenceIds.map((id) => [id, evidenceGate(rawTechnical[id], `$.technicalEvidence.${id}`, id)])) as ProfessionalOutputReview["technicalEvidence"];
  unique(technicalEvidenceIds.map((id) => technicalEvidence[id].artifact.path), "$.technicalEvidence[].artifact.path");

  const rawHistory = closed(root.iterationHistory, "$.iterationHistory", ["complete", "finalIterationId", "priorFailedIterations"]);
  const priorFailedIterations = arrayValue(rawHistory.priorFailedIterations, "$.iterationHistory.priorFailedIterations", 1, 64).map((entry, index) => {
    const path = `$.iterationHistory.priorFailedIterations[${index}]`, iteration = closed(entry, path, ["failedCategories", "id", "ir", "lock", "output", "renderManifest", "retained", "review", "source", "summary"]);
    const failedCategories = arrayValue(iteration.failedCategories, `${path}.failedCategories`, 1, professionalOutputCategoryIds.length).map((category, categoryIndex) => enumValue(category, `${path}.failedCategories[${categoryIndex}]`, professionalOutputCategoryIds));
    unique(failedCategories, `${path}.failedCategories`);
    return {
      id: identifier(iteration.id, `${path}.id`),
      retained: booleanValue(iteration.retained, `${path}.retained`),
      source: hashedArtifact(iteration.source, `${path}.source`),
      lock: hashedArtifact(iteration.lock, `${path}.lock`),
      ir: hashedArtifact(iteration.ir, `${path}.ir`),
      output: hashedArtifact(iteration.output, `${path}.output`),
      renderManifest: hashedArtifact(iteration.renderManifest, `${path}.renderManifest`),
      review: hashedArtifact(iteration.review, `${path}.review`),
      failedCategories,
      summary: textValue(iteration.summary, `${path}.summary`, 4000),
    };
  });
  for (const [index, iteration] of priorFailedIterations.entries()) {
    const path = `$.iterationHistory.priorFailedIterations[${index}]`;
    if (!iteration.source.path.endsWith(".cut")) fail("CUT_REVIEW_ARTIFACT", `${path}.source.path`, "failed source must be a .cut file.");
    if (!iteration.lock.path.endsWith(".lock")) fail("CUT_REVIEW_ARTIFACT", `${path}.lock.path`, "failed lock must be a .lock file.");
    if (!iteration.ir.path.endsWith(".cutir.json")) fail("CUT_REVIEW_ARTIFACT", `${path}.ir.path`, "failed IR must be a .cutir.json file.");
    if (!iteration.output.path.endsWith(".mp4")) fail("CUT_REVIEW_ARTIFACT", `${path}.output.path`, "failed output must be an .mp4 file.");
    if (!iteration.renderManifest.path.endsWith(".manifest.json")) fail("CUT_REVIEW_ARTIFACT", `${path}.renderManifest.path`, "failed render manifest must be a .manifest.json file.");
    if (!iteration.review.path.endsWith(".review.json")) fail("CUT_REVIEW_ARTIFACT", `${path}.review.path`, "failed review must be a .review.json file.");
    unique([iteration.source.path, iteration.lock.path, iteration.ir.path, iteration.output.path, iteration.renderManifest.path, iteration.review.path], path);
  }
  unique(priorFailedIterations.map((iteration) => iteration.id), "$.iterationHistory.priorFailedIterations[].id");
  const iterationHistory = {
    complete: booleanValue(rawHistory.complete, "$.iterationHistory.complete"),
    finalIterationId: identifier(rawHistory.finalIterationId, "$.iterationHistory.finalIterationId"),
    priorFailedIterations,
  };
  unique([iterationHistory.finalIterationId, ...priorFailedIterations.map((iteration) => iteration.id)], "$.iterationHistory");

  return deepFreeze(canonicalClone({
    format: professionalOutputReviewFormat,
    version: professionalOutputReviewVersion,
    decision: enumValue(root.decision, "$.decision", ["pass", "revise"]),
    artifact,
    authoringBoundary,
    playbackReview: { implementer, independent },
    referenceCalibration,
    categories,
    hardFailures,
    technicalEvidence,
    iterationHistory,
  }));
}

export function loadProfessionalOutputReview(input: string | Uint8Array) {
  return validateProfessionalOutputReview(parseStrictReviewJson(input));
}

type ReviewGate = { id: string; status: "pass" | "fail"; detail: string };
export type ProfessionalOutputReviewReport = {
  format: "cut-professional-output-review-report";
  version: 1;
  command: "review";
  status: ReviewDecision;
  review: string;
  artifact: { kind: "hero-film"; title: string; iterationId: string; durationSeconds: number; outputSha256: string };
  threshold: { categoryMinimum: number; averaging: "forbidden" };
  categories: Array<{
    id: ProfessionalOutputCategoryId;
    scores: { implementer: number; independent: number };
    status: "pass" | "fail";
    reviewerIds: [string, string];
    evidenceItems: { implementer: number; independent: number };
    criteria: { required: number; implementerPassed: number; independentPassed: number };
    comparisons: { required: number; implementerAtTier: number; independentAtTier: number };
  }>;
  gates: ReviewGate[];
  integrity: { files: number; bytes: number };
  summary: { categoriesPassed: number; categoriesTotal: number; gatesPassed: number; gatesTotal: number; hardFailures: number };
  assurance: {
    automatedTasteAssessment: false;
    machineEvidenceStatus: "verified";
    humanAttestationStatus: "accepted-unverified";
    rightsAttestationStatus: "accepted-unverified";
    referenceIdentityStatus: "accepted-unverified";
    frameDefectAttestationStatus: "accepted-unverified";
    freshRenderAuthentication: FreshRenderAuthentication;
    statement: string;
  };
};

function gate(id: string, passed: boolean, detail: string): ReviewGate {
  return { id, status: passed ? "pass" : "fail", detail };
}

function semanticGates(
  review: ProfessionalOutputReview,
  integrity: { files: number; bytes: number },
  render: VerifiedRenderBinding,
  fresh: FreshRenderAuthentication,
): { categories: ProfessionalOutputReviewReport["categories"]; gates: ReviewGate[] } {
  const independentId = review.playbackReview.independent.reviewerId;
  const categories = professionalOutputCategoryIds.map((id) => {
    const category = review.categories[id];
    const assessments = [category.implementer, category.independent];
    const passed = assessments.every((assessment) => assessment.status === "pass" && assessment.score >= professionalOutputMinimumScore)
      && assessments.every((assessment) => assessment.criteria.every((criterion) => criterion.status === "pass"))
      && assessments.every((assessment) => assessment.comparisons.every((comparison) => comparison.verdict === "same-tier" || comparison.verdict === "above-tier"))
      && category.independent.reviewerId === independentId;
    return {
      id,
      scores: { implementer: category.implementer.score, independent: category.independent.score },
      status: passed ? "pass" as const : "fail" as const,
      reviewerIds: [category.implementer.reviewerId, category.independent.reviewerId] as [string, string],
      evidenceItems: { implementer: category.implementer.evidence.length, independent: category.independent.evidence.length },
      criteria: {
        required: professionalOutputCriteria[id].length,
        implementerPassed: category.implementer.criteria.filter((criterion) => criterion.status === "pass").length,
        independentPassed: category.independent.criteria.filter((criterion) => criterion.status === "pass").length,
      },
      comparisons: {
        required: review.referenceCalibration.references.length,
        implementerAtTier: category.implementer.comparisons.filter((comparison) => comparison.verdict !== "below-tier").length,
        independentAtTier: category.independent.comparisons.filter((comparison) => comparison.verdict !== "below-tier").length,
      },
    };
  });
  const sessions = [review.playbackReview.implementer, review.playbackReview.independent];
  const boundaryBooleans = Object.entries(review.authoringBoundary).filter(([name]) => name !== "ffmpegRole").map(([, value]) => value);
  const creatorKeys = review.referenceCalibration.references.map((reference) => reference.creator.trim().toLocaleLowerCase("en-US"));
  const primaryReferences = review.referenceCalibration.references.filter((reference) => reference.role === "primary-neo" && reference.creator.trim().toLocaleLowerCase("en-US") === "neo").length;
  const adjacentReferences = review.referenceCalibration.references.filter((reference) => reference.role === "adjacent-top-tier").length;
  const failedIterations = review.iterationHistory.priorFailedIterations;
  const subject = {
    sourceSha256: review.artifact.source.sha256,
    lockSha256: review.artifact.lock.sha256,
    irSha256: review.artifact.ir.sha256,
    outputSha256: review.artifact.output.sha256,
    renderManifestSha256: review.artifact.renderManifest.sha256,
  };
  const technicalSubjectsMatch = technicalEvidenceIds.every((id) => stableJsonStringify(review.technicalEvidence[id].subject) === stableJsonStringify(subject));
  const technicalPaths = technicalEvidenceIds.map((id) => review.technicalEvidence[id].artifact.path);
  const gates = [
    gate("category-thresholds", categories.every((category) => category.status === "pass"), `implementer and independent reviewer must each score all nine categories at least ${professionalOutputMinimumScore}, pass every criterion, and rate every selected reference same-tier or above; averaging is forbidden`),
    gate("full-speed-playback", sessions.every((session) => session.fullFilm && session.fullSpeedPlayback), "implementer and independent reviewer each attest a complete full-speed viewing"),
    gate("headphone-listening", sessions.every((session) => session.headphoneListening), "implementer and independent reviewer each attest a complete headphone listen"),
    gate("independent-review", review.playbackReview.independent.implementationInvolvement === "none" && !review.playbackReview.independent.conflictOfInterest, "independent reviewer is distinct, uninvolved in implementation, and declares no conflict"),
    gate("hard-failures", review.hardFailures.length === 0, "a passing review cannot retain any slideshow, narration, sound, pacing, motion, typography, technical, rights, hidden-post, incomplete-review, or copying hard failure"),
    gate("technical-evidence", technicalEvidenceIds.every((id) => review.technicalEvidence[id].status === "pass") && technicalSubjectsMatch && new Set(technicalPaths).size === technicalPaths.length, "all eight typed source, test, render, replay, frame, audio, rights, and canonical-boundary records pass, bind the same five hero hashes, and use distinct report artifacts"),
    gate("hero-duration", review.artifact.durationSeconds >= 180 && review.artifact.durationSeconds <= 300, "hero film duration is within the normative 3–5 minute range"),
    gate("professional-delivery-profile", professionalHeroDeliveryProfile(render.width, render.height, render.fps), "hero delivery requires at least a 1080-pixel short axis and an exact authored frame rate from 24000/1001 through 120 fps in landscape, portrait, or square orientation"),
    gate("fresh-render-authentication", fresh.method === "fresh-current-runtime-byte-identity" && fresh.outputSha256 === review.artifact.output.sha256 && fresh.buildId === render.buildId && fresh.executionBuildId === render.executionBuildId, "declared hero bytes equal a cold isolated current-runtime render of the verified invocation-local lock-applied IR"),
    gate("hero-provenance", integrity.files > 0 && review.artifact.kind === "hero-film", "every declared source, lock, IR, output, manifest, note, calibration, technical, and failed-iteration artifact was hash-verified"),
    gate("public-authoring-boundary", boundaryBooleans.every((value) => value === true) && review.authoringBoundary.ffmpegRole === "codec-and-low-level-media-only", "all project-specific creative and temporal intent stays in public CUT source/packages/CLI with no precomposed substitute, hidden renderer, or manual post path"),
    gate("reference-calibration", primaryReferences === 1 && adjacentReferences >= 2 && new Set(creatorKeys).size === creatorKeys.length && sessions.every((session) => session.referenceComparison), "exactly one Neo primary and at least two adjacent references from distinct creators were analyzed and compared per category without copying"),
    gate("failed-iteration-preservation", review.iterationHistory.complete && review.iterationHistory.finalIterationId === review.artifact.iterationId && failedIterations.every((iteration) => iteration.retained) && !failedIterations.some((iteration) => iteration.id === review.artifact.iterationId || iteration.output.sha256 === review.artifact.output.sha256), "at least one distinct failed iteration and its source, lock, output, manifest, review, and failure categories are retained"),
  ];
  return { categories, gates };
}

type EvidenceArtifactRole = { role: string; artifact: HashedArtifact };

function allHashedArtifacts(review: ProfessionalOutputReview) {
  const result: EvidenceArtifactRole[] = [
    { role: "hero.source", artifact: review.artifact.source },
    { role: "hero.lock", artifact: review.artifact.lock },
    { role: "hero.ir", artifact: review.artifact.ir },
    { role: "hero.output", artifact: review.artifact.output },
    { role: "hero.renderManifest", artifact: review.artifact.renderManifest },
    { role: "review.implementer.notes", artifact: review.playbackReview.implementer.notes },
    { role: "review.independent.notes", artifact: review.playbackReview.independent.notes },
    { role: "calibration.treatment", artifact: review.referenceCalibration.treatment },
    { role: "calibration.referenceBoard", artifact: review.referenceCalibration.referenceBoard },
    { role: "calibration.sideBySideReview", artifact: review.referenceCalibration.sideBySideReview },
    ...review.referenceCalibration.references.map((reference) => ({ role: `calibration.reference.${reference.id}.shotAnalysis`, artifact: reference.shotAnalysis })),
    ...technicalEvidenceIds.map((id) => ({ role: `technical.${id}.report`, artifact: review.technicalEvidence[id].artifact })),
    ...review.iterationHistory.priorFailedIterations.flatMap((iteration) => ([
      { role: `failed.${iteration.id}.source`, artifact: iteration.source },
      { role: `failed.${iteration.id}.lock`, artifact: iteration.lock },
      { role: `failed.${iteration.id}.ir`, artifact: iteration.ir },
      { role: `failed.${iteration.id}.output`, artifact: iteration.output },
      { role: `failed.${iteration.id}.renderManifest`, artifact: iteration.renderManifest },
      { role: `failed.${iteration.id}.review`, artifact: iteration.review },
    ])),
  ];
  if (result.length > 512) fail("CUT_REVIEW_LIMIT", "$", "references more than 512 evidence artifacts.");
  const byPath = new Map<string, string>();
  for (const { artifact } of result) {
    const folded = artifact.path.normalize("NFC").toLocaleLowerCase("en-US"), previous = byPath.get(folded);
    if (previous) fail("CUT_REVIEW_EVIDENCE_ALIAS", artifact.path, `aliases evidence path ${JSON.stringify(previous)}; every semantic evidence role requires a distinct file.`);
    byPath.set(folded, artifact.path);
  }
  return [...result].sort((left, right) => left.artifact.path.localeCompare(right.artifact.path));
}

function allowedEvidenceDigestAlias(left: EvidenceArtifactRole, right: EvidenceArtifactRole) {
  const roles = new Set([left.role, right.role]);
  return roles.size === 2 && roles.has("hero.output") && roles.has("technical.deterministicReplay.output");
}

async function verifyArtifactRoleIsolation(reviewRoot: string, artifacts: EvidenceArtifactRole[]) {
  const root = await realpath(reviewRoot), byTarget = new Map<string, EvidenceArtifactRole>(), byInode = new Map<string, EvidenceArtifactRole>(), byDigest = new Map<string, EvidenceArtifactRole>();
  for (const entry of artifacts) {
    const { artifact } = entry;
    const candidate = resolve(root, ...artifact.path.split("/")), target = await realpath(candidate);
    const foldedTarget = target.normalize("NFC").toLocaleLowerCase("en-US"), previousTarget = byTarget.get(foldedTarget);
    if (previousTarget) fail("CUT_REVIEW_EVIDENCE_ALIAS", artifact.path, `role ${JSON.stringify(entry.role)} resolves to the same evidence target as ${JSON.stringify(previousTarget.role)}.`);
    byTarget.set(foldedTarget, entry);
    const metadata = await lstat(target, { bigint: true }), inode = `${metadata.dev}:${metadata.ino}`, previousInode = byInode.get(inode);
    if (previousInode) fail("CUT_REVIEW_EVIDENCE_ALIAS", artifact.path, `role ${JSON.stringify(entry.role)} is a hard-link alias of evidence role ${JSON.stringify(previousInode.role)}.`);
    byInode.set(inode, entry);
    const previousDigest = byDigest.get(artifact.sha256);
    if (previousDigest && !allowedEvidenceDigestAlias(previousDigest, entry)) fail("CUT_REVIEW_EVIDENCE_ALIAS", artifact.path, `role ${JSON.stringify(entry.role)} reuses the exact bytes declared for unrelated evidence role ${JSON.stringify(previousDigest.role)}.`);
    if (!previousDigest) byDigest.set(artifact.sha256, entry);
  }
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  await new Promise<void>((accept, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", accept);
  });
  return hash.digest("hex");
}

function hashArtifactBytes(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export async function verifyReviewArtifacts(reviewRoot: string, artifacts: HashedArtifact[]) {
  const root = await realpath(reviewRoot), rootedPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  let bytes = 0;
  for (const artifact of artifacts) {
    let cursor = root;
    for (const segment of artifact.path.split("/")) {
      cursor = resolve(cursor, segment);
      const metadata = await lstat(cursor).catch(() => undefined);
      if (!metadata) fail("CUT_REVIEW_EVIDENCE_MISSING", artifact.path, "does not exist.");
      if (metadata.isSymbolicLink()) fail("CUT_REVIEW_EVIDENCE_SYMLINK", artifact.path, "cannot traverse or identify a symbolic link.");
    }
    const target = await realpath(cursor);
    if (!(target === root || target.startsWith(rootedPrefix))) fail("CUT_REVIEW_PATH", artifact.path, "resolves outside the review directory.");
    const metadata = await lstat(target);
    if (!metadata.isFile()) fail("CUT_REVIEW_EVIDENCE_FILE", artifact.path, "must identify a regular file.");
    if (metadata.size > 8 * 1024 * 1024 * 1024) fail("CUT_REVIEW_LIMIT", artifact.path, "exceeds the 8 GiB per-artifact verification limit.");
    bytes += metadata.size;
    if (bytes > 32 * 1024 * 1024 * 1024) fail("CUT_REVIEW_LIMIT", "$", "evidence exceeds the 32 GiB aggregate verification limit.");
    const actual = await hashFile(target);
    if (actual !== artifact.sha256) fail("CUT_REVIEW_INTEGRITY", artifact.path, `SHA-256 mismatch; expected ${artifact.sha256}, observed ${actual}.`);
  }
  return { files: artifacts.length, bytes };
}

async function verifyHumanEvidenceFloors(root: string, review: ProfessionalOutputReview) {
  const requirements: Array<{ artifact: HashedArtifact; minimumBytes: number; path: string }> = [
    { artifact: review.playbackReview.implementer.notes, minimumBytes: 512, path: "$.playbackReview.implementer.notes" },
    { artifact: review.playbackReview.independent.notes, minimumBytes: 512, path: "$.playbackReview.independent.notes" },
    { artifact: review.referenceCalibration.treatment, minimumBytes: 512, path: "$.referenceCalibration.treatment" },
    { artifact: review.referenceCalibration.referenceBoard, minimumBytes: 512, path: "$.referenceCalibration.referenceBoard" },
    { artifact: review.referenceCalibration.sideBySideReview, minimumBytes: 1_024, path: "$.referenceCalibration.sideBySideReview" },
    ...review.referenceCalibration.references.map((reference, index) => ({ artifact: reference.shotAnalysis, minimumBytes: 1_024, path: `$.referenceCalibration.references[${index}].shotAnalysis` })),
  ];
  for (const requirement of requirements) {
    const metadata = await lstat(resolve(root, ...requirement.artifact.path.split("/")));
    if (metadata.size < requirement.minimumBytes) fail("CUT_REVIEW_HUMAN_EVIDENCE", requirement.path, `contains only ${metadata.size} bytes; this evidence class requires at least ${requirement.minimumBytes} bytes of retained review material. Byte count does not establish creative truth.`);
  }
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.byteLength(message, "utf8") <= 2_000 ? message : `${message.slice(0, 1_000)}…`;
}

async function readBoundedJsonArtifact(root: string, artifact: HashedArtifact, diagnosticPath: string) {
  const path = resolve(root, ...artifact.path.split("/")), metadata = await lstat(path);
  if (metadata.size > defaultJsonLimits.maxInputBytes) fail("CUT_REVIEW_JSON_LIMIT", diagnosticPath, "evidence JSON exceeds the bounded 2 MiB input limit.");
  const bytes = await readFile(path);
  if (hashArtifactBytes(bytes) !== artifact.sha256) fail("CUT_REVIEW_INTEGRITY", diagnosticPath, "changed after initial evidence verification.");
  return parseStrictReviewJson(bytes);
}

async function readBoundedArtifactBytes(root: string, artifact: HashedArtifact, diagnosticPath: string, maximumBytes: number) {
  const path = resolve(root, ...artifact.path.split("/")), metadata = await lstat(path);
  if (metadata.size > maximumBytes) fail("CUT_REVIEW_LIMIT", diagnosticPath, `exceeds the ${maximumBytes}-byte executable-evidence limit.`);
  const bytes = await readFile(path);
  if (hashArtifactBytes(bytes) !== artifact.sha256) fail("CUT_REVIEW_INTEGRITY", diagnosticPath, "changed after initial evidence verification.");
  return bytes;
}

async function packageContextForReviewSource(programPath: string): Promise<CutExternalPackageContext | undefined> {
  const projectRoot = dirname(programPath), manifestPath = resolve(projectRoot, cutPackageManifestFile);
  const manifestMetadata = await lstat(manifestPath).catch(() => undefined);
  if (!manifestMetadata) return undefined;
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) fail("CUT_REVIEW_SOURCE", cutPackageManifestFile, "package manifest beside hero source must be a regular non-symlink file.");
  const packageLockPath = resolve(projectRoot, cutPackageLockFile), packageLockMetadata = await lstat(packageLockPath).catch(() => undefined);
  if (!packageLockMetadata || packageLockMetadata.isSymbolicLink() || !packageLockMetadata.isFile()) fail("CUT_REVIEW_SOURCE", cutPackageLockFile, "a packaged hero source requires a regular verified package lock.");
  const graph = await resolveVerifiedCutPackageGraph(projectRoot, loadCutPackageLock(await readFile(packageLockPath)));
  const entryPath = resolve(projectRoot, ...graph.root.manifest.entry.split("/"));
  if (entryPath !== programPath) fail("CUT_REVIEW_SOURCE", cutPackageManifestFile, `package entry ${JSON.stringify(graph.root.manifest.entry)} does not identify the declared hero source.`);
  return createCutExternalPackageContext(graph);
}

async function verifyExecutableArtifactBinding(root: string, review: ProfessionalOutputReview) {
  const sourcePath = resolve(root, ...review.artifact.source.path.split("/")), projectRoot = dirname(sourcePath);
  try {
    const sourceBytes = await readBoundedArtifactBytes(root, review.artifact.source, "$.artifact.source", 8 * 1024 * 1024);
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes); }
    catch { fail("CUT_REVIEW_SOURCE", "$.artifact.source", "hero CUT source is not valid UTF-8."); }
    if (hash(source) !== review.artifact.source.sha256) fail("CUT_REVIEW_SOURCE", "$.artifact.source.sha256", "does not equal CUT's canonical raw source hash.");
    const parsed = parseCutLanguage(source), parseErrors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (!parsed.module || parseErrors.length) fail("CUT_REVIEW_SOURCE", "$.artifact.source", `does not parse as CUT source (${parseErrors[0]?.code ?? "no module"}).`);
    const externalPackages = await packageContextForReviewSource(sourcePath);
    const loadedModules = await loadCutUserModuleGraph(sourcePath, parsed.module, { packages: externalPackages?.packages });
    const moduleErrors = loadedModules.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (!loadedModules.graph || moduleErrors.length) fail("CUT_REVIEW_SOURCE", "$.artifact.source", `user-module loading failed (${moduleErrors[0]?.code ?? "no graph"}).`);
    const check = checkCutModule(parsed.module, { packages: externalPackages?.packages, userModules: loadedModules.graph.contracts, moduleKind: "entry" });
    const checkErrors = check.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (checkErrors.length) fail("CUT_REVIEW_SOURCE", "$.artifact.source", `CUT check failed (${checkErrors[0]!.code}).`);
    const compiled = compileCutModule(parsed.module, {}, externalPackages, loadedModules.graph).ir;
    const unlockedBuildId = compiled.buildId;
    const staticErrors = validateReferenceStaticVisualGraphs(compiled).filter((diagnostic) => diagnostic.severity === "error");
    if (staticErrors.length) fail("CUT_REVIEW_SOURCE", "$.artifact.source", `reference-runtime preflight failed (${staticErrors[0]!.code}).`);
    const loadedIr = loadCutAvIr(await readBoundedArtifactBytes(root, review.artifact.ir, "$.artifact.ir", 64 * 1024 * 1024));
    const lock = loadCutLock(await readBoundedArtifactBytes(root, review.artifact.lock, "$.artifact.lock", 64 * 1024 * 1024));
    if (compiled.sourceHash !== review.artifact.source.sha256 || loadedIr.sourceHash !== compiled.sourceHash || lock.sourceHash !== compiled.sourceHash) {
      fail("CUT_REVIEW_EXECUTABLE_BINDING", "$.artifact", "source bytes, compiled CutAVIR, retained CutAVIR and cut.lock do not share one source hash.");
    }
    await applyCutLock(compiled, lock, projectRoot);
    if (loadedIr.determinism.semantic !== "locked" || loadedIr.buildId !== compiled.buildId) fail("CUT_REVIEW_EXECUTABLE_BINDING", "$.artifact.ir", "retained CutAVIR is not the canonical current lock-applied build of the declared public CUT source.");
    if (loadedIr.outputs.length !== 1) fail("CUT_REVIEW_EXECUTABLE_BINDING", "$.artifact.ir.outputs", "professional hero proof currently requires exactly one canonical public render output so the selected timeline is unambiguous.");
    const output = compiled.outputs[0]!, composition = compiled.compositions.find((item) => item.id === output.timelineId);
    if (!composition) fail("CUT_REVIEW_EXECUTABLE_BINDING", "$.artifact.ir.outputs[0].timelineId", "does not identify a retained composition.");
    // Return the invocation-local applyCutLock result, not merely the
    // serialization-equivalent retained IR. The verified-input runtime accepts
    // only this registered object at its fresh execution boundary.
    return { ir: compiled, retainedIr: loadedIr, lock, projectRoot, composition, output, unlockedBuildId };
  } catch (error) {
    if (error instanceof CutProfessionalOutputReviewError) throw error;
    const prefix = error instanceof CutCompileError ? "CUT compilation failed" : "executable artifact verification failed";
    fail("CUT_REVIEW_EXECUTABLE_BINDING", "$.artifact", `${prefix}: ${boundedError(error)}`);
  }
}

function rationalString(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[1-9][0-9]*\/[1-9][0-9]*$/u.test(value)) fail("CUT_REVIEW_RENDER_MANIFEST", path, "must be a positive canonical numerator/denominator string.");
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) fail("CUT_REVIEW_RENDER_MANIFEST", path, "must contain safe integer clock terms.");
  return numerator! / denominator!;
}

function finiteField(item: Record<string, unknown>, name: string, path: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE) {
  return finiteNumber(item[name], `${path}.${name}`, minimum, maximum);
}

function validatePeakEvidence(value: unknown, path: string, expectedFrames: number) {
  const peak = record(value, path);
  if (peak.format !== "cut-reference-audio-peak-scan" || peak.version !== 1 || peak.sampleFormat !== "f32le" || peak.channels !== 2) fail("CUT_REVIEW_AUDIO", path, "must be CUT's stereo f32le peak-scan v1 evidence.");
  if (peak.expectedFrames !== expectedFrames || peak.observedFrames !== expectedFrames || peak.expectedBytes !== expectedFrames * 8 || peak.observedBytes !== expectedFrames * 8) fail("CUT_REVIEW_AUDIO", path, "does not reconcile to the complete 48 kHz hero sample boundary.");
  const threshold = finiteField(peak, "thresholdDbfs", path, -20, 0), observed = finiteField(peak, "peakDbfs", path, -300, 0);
  if (peak.silent !== false) fail("CUT_REVIEW_AUDIO", `${path}.silent`, "a professional hero mix cannot be silent.");
  if (observed > threshold + 1e-9) fail("CUT_REVIEW_AUDIO", `${path}.peakDbfs`, `exceeds its declared ${threshold} dBFS clipping threshold.`);
}

const requiredHeroAudioRoles = Object.freeze({
  narration: "dialogue",
  score: "music",
  ambience: "ambience",
  sfx: "sfx",
} as const);

function collectIrReferences(value: IRValue, nodes: Set<string>, resources: Set<string>) {
  if (value.kind === "node-ref") nodes.add(value.id);
  else if (value.kind === "resource-ref") resources.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => collectIrReferences(item, nodes, resources));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => collectIrReferences(item, nodes, resources));
  else if (value.kind === "range") { collectIrReferences(value.start, nodes, resources); collectIrReferences(value.end, nodes, resources); }
  else if (value.kind === "unary") collectIrReferences(value.value, nodes, resources);
  else if (value.kind === "binary") { collectIrReferences(value.left, nodes, resources); collectIrReferences(value.right, nodes, resources); }
  else if (value.kind === "member") collectIrReferences(value.object, nodes, resources);
  else if (value.kind === "index") { collectIrReferences(value.object, nodes, resources); collectIrReferences(value.index, nodes, resources); }
  else if (value.kind === "call") {
    value.positional.forEach((item) => collectIrReferences(item, nodes, resources));
    Object.values(value.named).forEach((item) => collectIrReferences(item, nodes, resources));
  }
}

export function professionalHeroAudioTopology(ir: CutAVIR, composition: IRComposition) {
  const scenes = composition.sceneIds.map((id) => ir.scenes[id]).filter(Boolean);
  const roots = [...composition.rootAudioIds, ...composition.rootAVIds, ...scenes.flatMap((scene) => [...scene.rootAudioIds, ...scene.rootAVIds])];
  const pending = [...roots], reachable = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    const node = ir.nodes[id];
    if (!node) fail("CUT_REVIEW_AUDIO_TOPOLOGY", "$.artifact.ir", `reachable audio graph references missing node ${JSON.stringify(id)}.`);
    reachable.add(id);
    pending.push(...node.children);
    const nodeReferences = new Set<string>(), resources = new Set<string>();
    Object.values(node.inputs).forEach((value) => collectIrReferences(value, nodeReferences, resources));
    for (const value of Object.values(node.properties)) if (!("signal" in value)) collectIrReferences(value, nodeReferences, resources);
    pending.push(...nodeReferences);
  }
  const procedural = [...reachable].map((id) => ir.nodes[id]!).filter((node) => ["cut.audio.tone", "cut.audio.noise", "cut.audio.synth"].includes(node.op));
  if (procedural.length) fail("CUT_REVIEW_AUDIO_TOPOLOGY", "$.artifact.ir", `hero audio contains reachable procedural placeholder source ${procedural[0]!.op} at ${procedural[0]!.provenance.module}:${procedural[0]!.provenance.span.start.line}; professional proof requires external cleared narration, score, ambience and SFX assets.`);

  const resourcesByBusRole = new Map<string, Set<string>>();
  for (const bus of [...reachable].map((id) => ir.nodes[id]!).filter((node) => node.op === "cut.audio.bus")) {
    const roleValue = bus.inputs.role;
    if (!roleValue || roleValue.kind !== "string") continue;
    const busResources = resourcesByBusRole.get(roleValue.value) ?? new Set<string>(), busPending = [...bus.children], visited = new Set<string>();
    while (busPending.length) {
      const id = busPending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = ir.nodes[id];
      if (!node || !reachable.has(id)) continue;
      busPending.push(...node.children);
      const nodeReferences = new Set<string>();
      Object.values(node.inputs).forEach((value) => collectIrReferences(value, nodeReferences, busResources));
      for (const value of Object.values(node.properties)) if (!("signal" in value)) collectIrReferences(value, nodeReferences, busResources);
      busPending.push(...nodeReferences);
    }
    resourcesByBusRole.set(roleValue.value, busResources);
  }
  for (const role of Object.values(requiredHeroAudioRoles)) {
    if (!resourcesByBusRole.get(role)?.size) fail("CUT_REVIEW_AUDIO_TOPOLOGY", "$.artifact.ir", `hero audio requires a reachable ${JSON.stringify(role)} Bus containing at least one external audio resource.`);
  }
  return { reachable, resourcesByBusRole };
}

async function readExactFileRange(handle: Awaited<ReturnType<typeof open>>, length: number, position: number, path: string) {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(result, offset, length - offset, position + offset);
    if (!read.bytesRead) fail("CUT_REVIEW_AUDIO_TOPOLOGY", path, `is truncated at byte ${position + offset}.`);
    offset += read.bytesRead;
  }
  return result;
}

async function inspectProfessionalPcm24Wave(path: string, diagnosticPath: string, expectedFrames: number, expectedSampleRate: number) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 44) fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, "must be one bounded regular PCM24 WAVE file.");
    const riff = await readExactFileRange(handle, 12, 0, diagnosticPath);
    if (riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE" || riff.readUInt32LE(4) + 8 !== metadata.size) fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, "must be a complete classic RIFF/WAVE byte stream.");
    let cursor = 12, chunks = 0, dataOffset: number | undefined, dataBytes: number | undefined;
    let format: { code: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | undefined;
    while (cursor + 8 <= metadata.size && (format === undefined || dataOffset === undefined)) {
      if (++chunks > 128) fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, "contains more than 128 WAVE chunks.");
      const chunk = await readExactFileRange(handle, 8, cursor, diagnosticPath), id = chunk.toString("ascii", 0, 4), size = chunk.readUInt32LE(4), body = cursor + 8;
      if (body + size > metadata.size) fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, `contains a truncated ${JSON.stringify(id)} chunk.`);
      if (id === "fmt ") {
        if (size < 16) fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, "contains a short WAVE format chunk.");
        const value = await readExactFileRange(handle, 16, body, diagnosticPath);
        format = { code: value.readUInt16LE(0), channels: value.readUInt16LE(2), sampleRate: value.readUInt32LE(4), byteRate: value.readUInt32LE(8), blockAlign: value.readUInt16LE(12), bits: value.readUInt16LE(14) };
      } else if (id === "data") { dataOffset = body; dataBytes = size; }
      cursor = body + size + (size % 2);
    }
    if (!format || dataOffset === undefined || dataBytes === undefined) fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, "is missing its format or data chunk.");
    if (format.code !== 1 || format.channels !== 2 || format.sampleRate !== expectedSampleRate || format.byteRate !== expectedSampleRate * 6 || format.blockAlign !== 6 || format.bits !== 24 || dataBytes !== expectedFrames * 6) {
      fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, `must contain exactly ${expectedFrames} stereo signed-24-bit frames at ${expectedSampleRate} Hz.`);
    }
    const chunkBytes = 65_532, buffer = Buffer.alloc(chunkBytes);
    let position = 0, frames = 0, peakLinear = 0;
    while (position < dataBytes) {
      const requested = Math.min(buffer.length, dataBytes - position), read = await handle.read(buffer, 0, requested, dataOffset + position);
      if (read.bytesRead !== requested || read.bytesRead % 6 !== 0) fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, "contains a truncated PCM24 sample frame.");
      for (let offset = 0; offset < read.bytesRead; offset += 3) peakLinear = Math.max(peakLinear, Math.abs(buffer.readIntLE(offset, 3)) / 8_388_608);
      frames += read.bytesRead / 6;
      position += read.bytesRead;
    }
    if (frames !== expectedFrames) fail("CUT_REVIEW_AUDIO_TOPOLOGY", diagnosticPath, "does not decode to the exact declared sample count.");
    return { frames, peakLinear, peakDbfs: peakLinear === 0 ? null : 20 * Math.log10(peakLinear), silent: peakLinear === 0 };
  } finally { await handle.close(); }
}

export async function verifyProfessionalHeroRoleStems(root: string, renderManifestPath: string, markerValue: unknown) {
  const marker = record(markerValue, "$.artifact.renderManifest.stems"), manifestLocator = textValue(marker.manifest, "$.artifact.renderManifest.stems.manifest", 1024);
  const stemPath = resolve(dirname(renderManifestPath), ...manifestLocator.split("/")), metadata = await lstat(stemPath);
  if (metadata.size > defaultJsonLimits.maxInputBytes) fail("CUT_REVIEW_AUDIO_TOPOLOGY", "$.artifact.renderManifest.stems.manifest", "stem manifest exceeds the bounded JSON review limit.");
  const stemManifest = record(parseStrictReviewJson(await readFile(stemPath)), "$.artifact.renderManifest.stems.manifest"), stems = arrayValue(stemManifest.stems, "$.artifact.renderManifest.stems.manifest.stems", 4, 64).map((value, index) => record(value, `$.artifact.renderManifest.stems.manifest.stems[${index}]`));
  const composition = record(stemManifest.composition, "$.artifact.renderManifest.stems.manifest.composition"), expectedFrames = integer(composition.samples, "$.artifact.renderManifest.stems.manifest.composition.samples", 1, Number.MAX_SAFE_INTEGER), expectedSampleRate = integer(composition.sampleRate, "$.artifact.renderManifest.stems.manifest.composition.sampleRate", 1, 384_000);
  const physicalRoot = await realpath(root), rootedPrefix = physicalRoot.endsWith(sep) ? physicalRoot : `${physicalRoot}${sep}`;
  for (const role of Object.values(requiredHeroAudioRoles)) {
    const matching = stems.filter((stem) => stem.role === role && stem.kind === "program");
    if (matching.length !== 1) fail("CUT_REVIEW_AUDIO_TOPOLOGY", "$.artifact.renderManifest.stems.manifest.stems", `must contain exactly one program stem with role ${JSON.stringify(role)}.`);
    const stem = matching[0]!, peakPath = `$.artifact.renderManifest.stems.manifest.stems.${role}.peak`, peak = record(stem.peak, peakPath);
    if (peak.silent !== false || typeof peak.peakDbfs !== "number" || !Number.isFinite(peak.peakDbfs)) fail("CUT_REVIEW_AUDIO_TOPOLOGY", peakPath, "must declare a non-silent complete role stem.");
    const file = textValue(stem.file, `$.artifact.renderManifest.stems.manifest.stems.${role}.file`, 128);
    if (file.includes("/") || file.includes("\\")) fail("CUT_REVIEW_AUDIO_TOPOLOGY", `$.artifact.renderManifest.stems.manifest.stems.${role}.file`, "must be one direct portable WAVE leaf.");
    const absolute = resolve(dirname(stemPath), file), target = await realpath(absolute);
    if (!(target === physicalRoot || target.startsWith(rootedPrefix)) || (await lstat(absolute)).isSymbolicLink()) fail("CUT_REVIEW_AUDIO_TOPOLOGY", `$.artifact.renderManifest.stems.manifest.stems.${role}.file`, "must remain a direct non-symlink file beneath the review root.");
    const expectedHash = sha256(stem.sha256, `$.artifact.renderManifest.stems.manifest.stems.${role}.sha256`);
    if (await hashFile(target) !== expectedHash) fail("CUT_REVIEW_INTEGRITY", `$.artifact.renderManifest.stems.manifest.stems.${role}.file`, "changed after stem evidence verification.");
    const inspected = await inspectProfessionalPcm24Wave(target, `$.artifact.renderManifest.stems.manifest.stems.${role}.file`, expectedFrames, expectedSampleRate);
    const declaredPeakLinear = finiteField(peak, "peakLinear", peakPath, 0, 2), thresholdLinear = finiteField(peak, "thresholdLinear", peakPath, 0, 1);
    if (inspected.silent || Math.abs(inspected.peakLinear - declaredPeakLinear) > 2 / 8_388_608 || inspected.peakLinear > thresholdLinear + 2 / 8_388_608) {
      fail("CUT_REVIEW_AUDIO_TOPOLOGY", peakPath, `does not match independently decoded PCM24 samples (${inspected.peakDbfs ?? "silent"} dBFS).`);
    }
  }
}

type VerifiedFrameSequence = {
  expectedFrames: number;
  scannedFrames: number;
  frameSequenceSha256: string;
  distinctFrameDigests: number;
  consecutiveFrameChanges: number;
  longestIdenticalRunFrames: number;
};

async function inspectHeroFrameSequence(outputPath: string, expectedFrames: number, fps: number): Promise<VerifiedFrameSequence> {
  let capture: Awaited<ReturnType<typeof runFfmpegCapture>>;
  try {
    capture = await runFfmpegCapture(["-nostdin", "-v", "error", "-i", outputPath, "-map", "0:v:0", "-an", "-sn", "-dn", "-f", "framehash", "-hash", "sha256", "-"], 300_000, { stdoutBytes: 16 * 1024 * 1024, stderrBytes: 128 * 1024, totalBytes: 17 * 1024 * 1024 });
  } catch (error) { fail("CUT_REVIEW_FRAME_SCAN", "$.artifact.output", `complete decoded frame scan failed: ${boundedError(error)}`); }
  const records = capture.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const digests = records.map((line, index) => {
    const digest = line.split(",").at(-1)?.trim();
    if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) fail("CUT_REVIEW_FRAME_SCAN", `$.artifact.output.frames[${index}]`, "framehash output does not contain one canonical SHA-256 digest per decoded frame.");
    return digest;
  });
  if (digests.length !== expectedFrames) fail("CUT_REVIEW_FRAME_SCAN", "$.artifact.output", `decoded ${digests.length} frames, expected exactly ${expectedFrames}.`);
  let changes = 0, longest = digests.length ? 1 : 0, current = longest;
  for (let index = 1; index < digests.length; index += 1) {
    if (digests[index] === digests[index - 1]) { current += 1; longest = Math.max(longest, current); }
    else { changes += 1; current = 1; }
  }
  const distinct = new Set(digests).size, minimumChanges = Math.max(2, Math.ceil(expectedFrames * 0.05)), maximumHoldFrames = Math.max(2, Math.ceil(fps * 10));
  if (distinct < minimumChanges + 1 || changes < minimumChanges || longest > maximumHoldFrames) fail("CUT_REVIEW_FRAME_SCAN", "$.artifact.output", `decoded sequence is technically dead or slideshow-like (${distinct} distinct frames, ${changes} changes, longest identical run ${longest}; requires at least ${minimumChanges + 1} distinct, ${minimumChanges} changes, and no identical run over ${maximumHoldFrames} frames). This gate detects dead video only; humans still judge motion and pacing.`);
  return {
    expectedFrames,
    scannedFrames: digests.length,
    frameSequenceSha256: createHash("sha256").update(`${digests.join("\n")}\n`).digest("hex"),
    distinctFrameDigests: distinct,
    consecutiveFrameChanges: changes,
    longestIdenticalRunFrames: longest,
  };
}

async function verifyCompleteDecodedFrameCount(outputPath: string, expectedFrames: number, diagnosticPath: string) {
  let capture: Awaited<ReturnType<typeof runFfmpegCapture>>;
  try { capture = await runFfmpegCapture(["-nostdin", "-v", "error", "-i", outputPath, "-map", "0:v:0", "-an", "-sn", "-dn", "-f", "framehash", "-hash", "sha256", "-"], 300_000, { stdoutBytes: 16 * 1024 * 1024, stderrBytes: 128 * 1024, totalBytes: 17 * 1024 * 1024 }); }
  catch (error) { fail("CUT_REVIEW_FAILED_ITERATION", diagnosticPath, `complete decoded frame-count verification failed: ${boundedError(error)}`); }
  const records = capture.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (records.length !== expectedFrames || records.some((line) => !/^[a-f0-9]{64}$/u.test(line.split(",").at(-1)?.trim() ?? ""))) fail("CUT_REVIEW_FAILED_ITERATION", diagnosticPath, `must decode to exactly ${expectedFrames} hashable video frames.`);
}

type VerifiedRenderBinding = {
  manifest: Record<string, unknown>;
  probe: CutMediaProbe;
  buildId: string;
  executionBuildId: string;
  width: number;
  height: number;
  fps: number;
  integratedLufs: number;
  truePeakDbtp: number;
  targetLufs: number;
  truePeakCeilingDbtp: number;
  loudnessRangeLu: number;
  audioTopology: ReturnType<typeof professionalHeroAudioTopology>;
  frameSequence: VerifiedFrameSequence;
  dynamicArtifacts: EvidenceArtifactRole[];
};

type FreshRenderAuthentication = {
  method: "fresh-current-runtime-byte-identity";
  outputSha256: string;
  manifestSha256: string;
  buildId: string;
  executionBuildId: string;
  runtime: string;
  decodedMaster: {
    peak: ReferenceAudioPeakScan;
    truePeak: ReferenceAudioTruePeakScan;
    loudness: ReferenceLoudnessMeasurement;
  };
};

export type ProfessionalLockedResourceMirrorEntry = Readonly<{ locator: string; bytes: number; sha256: string }>;

export function professionalLockedResourceMirrorPlan(entries: readonly ProfessionalLockedResourceMirrorEntry[]) {
  const exact = new Map<string, ProfessionalLockedResourceMirrorEntry>(), folded = new Map<string, string>();
  for (const entry of entries) {
    const segments = entry.locator.split("/");
    if (!entry.locator || entry.locator.startsWith("/") || entry.locator.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `locator ${JSON.stringify(entry.locator)} is not one portable project-relative resource path.`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `locator ${JSON.stringify(entry.locator)} has an invalid byte/hash tuple.`);
    if (segments[0]!.toLocaleLowerCase("en-US") === ".cut") fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `locator ${JSON.stringify(entry.locator)} collides with CUT's isolated cache namespace.`);
    const previousExact = exact.get(entry.locator);
    if (previousExact) {
      if (previousExact.bytes !== entry.bytes || previousExact.sha256 !== entry.sha256) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `duplicate locator ${JSON.stringify(entry.locator)} names conflicting locked byte authorities.`);
      continue;
    }
    const foldedLocator = entry.locator.normalize("NFC").toLocaleLowerCase("en-US"), previousFolded = folded.get(foldedLocator);
    if (previousFolded) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `locator ${JSON.stringify(entry.locator)} case/NFC-aliases ${JSON.stringify(previousFolded)}.`);
    folded.set(foldedLocator, entry.locator);
    exact.set(entry.locator, Object.freeze({ ...entry }));
  }
  const result = [...exact.values()].sort((left, right) => left.locator.localeCompare(right.locator));
  for (const { locator } of result) {
    const segments = locator.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = segments.slice(0, length).join("/"), previous = folded.get(ancestor.normalize("NFC").toLocaleLowerCase("en-US"));
      if (previous) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `locator ${JSON.stringify(locator)} has a case/NFC-insensitive file/directory prefix collision with ${JSON.stringify(previous)}.`);
    }
  }
  return Object.freeze(result);
}

async function ensurePrivateMirrorDirectory(root: string, segments: readonly string[]) {
  let cursor = root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    let metadata = await lstat(cursor, { bigint: true }).catch(() => undefined);
    if (!metadata) {
      try { await mkdir(cursor, { mode: 0o700 }); }
      catch (error) {
        metadata = await lstat(cursor, { bigint: true }).catch(() => undefined);
        if (!metadata) throw error;
      }
      metadata = await lstat(cursor, { bigint: true });
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `resource directory segment ${JSON.stringify(segment)} is not a direct private directory.`);
    const physical = await realpath(cursor), physicalMetadata = await lstat(physical, { bigint: true });
    if (!physicalMetadata.isDirectory() || physicalMetadata.isSymbolicLink() || physicalMetadata.dev !== metadata.dev || physicalMetadata.ino !== metadata.ino) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `resource directory segment ${JSON.stringify(segment)} changed identity during mirror creation.`);
  }
  return cursor;
}

type PinnedMirrorDirectory = { path: string; dev: bigint; ino: bigint };

async function mirrorLockedResources(
  executable: Awaited<ReturnType<typeof verifyExecutableArtifactBinding>>,
  isolatedRoot: string,
  sealedDirectories: PinnedMirrorDirectory[],
) {
  const variants = professionalLockedResourceMirrorPlan(Object.values(executable.lock.resources).flatMap((locked) => [locked, ...(locked.proxy ? [locked.proxy] : [])]));
  const aggregate = variants.reduce((sum, entry) => sum + BigInt(entry.bytes), 0n), maximum = 64n * 1024n * 1024n * 1024n;
  if (aggregate > maximum) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `fresh review input mirror exceeds the bounded ${maximum}-byte aggregate.`);
  const filesystem = await statfs(isolatedRoot, { bigint: true }), freeBytes = filesystem.bavail * filesystem.bsize, requiredBytes = aggregate * 2n + 1024n * 1024n * 1024n;
  if (freeBytes < requiredBytes) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `isolated review requires at least ${requiredBytes} free bytes for the sealed mirror, verified-input copy and render staging; only ${freeBytes} are available.`);
  const physicalRoot = await realpath(isolatedRoot), prefix = physicalRoot.endsWith(sep) ? physicalRoot : `${physicalRoot}${sep}`;
  if (typeof fsConstants.O_NOFOLLOW !== "number") fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", "this platform cannot perform no-follow resource mirroring.");
  const resourceDirectories = new Set<string>([physicalRoot]);
  for (const expected of variants) {
    const locator = expected.locator;
    const source = await resolveLockedProjectPath(executable.projectRoot, locator), destination = resolve(physicalRoot, ...locator.split("/"));
    if (!destination.startsWith(prefix)) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `locator ${JSON.stringify(locator)} escapes the isolated render root.`);
    const parentSegments = locator.split("/").slice(0, -1), parent = await ensurePrivateMirrorDirectory(physicalRoot, parentSegments);
    if (parent !== physicalRoot) {
      for (let length = 1; length <= parentSegments.length; length += 1) resourceDirectories.add(resolve(physicalRoot, ...parentSegments.slice(0, length)));
    }
    const sourcePathBefore = await lstat(source.path, { bigint: true });
    if (sourcePathBefore.isSymbolicLink() || !sourcePathBefore.isFile() || sourcePathBefore.size !== BigInt(expected.bytes)) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `source for ${JSON.stringify(locator)} is not its locked direct regular file.`);
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined, destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      sourceHandle = await open(source.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      destinationHandle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      const sourceBefore = await sourceHandle.stat({ bigint: true }), destinationBefore = await destinationHandle.stat({ bigint: true });
      if (!sourceBefore.isFile() || !destinationBefore.isFile() || sourceBefore.dev !== sourcePathBefore.dev || sourceBefore.ino !== sourcePathBefore.ino || sourceBefore.dev === destinationBefore.dev && sourceBefore.ino === destinationBefore.ino) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `cannot establish distinct source/destination inodes for ${JSON.stringify(locator)}.`);
      const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
      let position = 0;
      while (position < expected.bytes) {
        const requested = Math.min(buffer.length, expected.bytes - position), sourceRead = await sourceHandle.read(buffer, 0, requested, position);
        if (sourceRead.bytesRead !== requested) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `locked resource ${JSON.stringify(locator)} changed while being mirrored.`);
        digest.update(buffer.subarray(0, requested));
        let written = 0;
        while (written < requested) {
          const result = await destinationHandle.write(buffer, written, requested - written, position + written);
          if (!result.bytesWritten) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `isolated copy of ${JSON.stringify(locator)} made no write progress.`);
          written += result.bytesWritten;
        }
        position += requested;
      }
      if ((await sourceHandle.read(buffer, 0, 1, expected.bytes)).bytesRead !== 0 || digest.digest("hex") !== expected.sha256) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `locked resource ${JSON.stringify(locator)} does not match its exact byte authority.`);
      await destinationHandle.sync(); await destinationHandle.chmod(0o400);
      const [sourceAfter, sourcePathAfter, destinationAfter, destinationPathAfter] = await Promise.all([sourceHandle.stat({ bigint: true }), lstat(source.path, { bigint: true }), destinationHandle.stat({ bigint: true }), lstat(destination, { bigint: true })]);
      if (sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino || sourceAfter.size !== sourceBefore.size || sourcePathAfter.dev !== sourceBefore.dev || sourcePathAfter.ino !== sourceBefore.ino
        || destinationPathAfter.isSymbolicLink() || !destinationPathAfter.isFile() || destinationAfter.dev !== destinationPathAfter.dev || destinationAfter.ino !== destinationPathAfter.ino || destinationAfter.size !== BigInt(expected.bytes)) {
        fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `resource ${JSON.stringify(locator)} changed identity during isolated mirroring.`);
      }
    } finally { await Promise.allSettled([sourceHandle?.close(), destinationHandle?.close()]); }
  }
  for (const directory of [...resourceDirectories].sort((left, right) => right.split(sep).length - left.split(sep).length)) {
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.lock.resources", `resource ancestor ${JSON.stringify(directory)} changed before sealing.`);
    sealedDirectories.push({ path: directory, dev: metadata.dev, ino: metadata.ino });
    await chmod(directory, 0o500);
  }
}

async function inspectProfessionalMasterAudio(
  input: string,
  scratch: string,
  expectedFrames: number,
  target: { integratedLufs: number; truePeakDbtp: number; loudnessRangeLu: number },
) {
  const raw = resolve(scratch, "declared-master.f32le");
  try {
    const source = { module: "professional-output-review", line: 1, column: 1 };
    // AAC has encoder priming and may decode a bounded tail after the exact
    // authored programme. Validate CUT's owned priming/duration contract first,
    // then scan only the exact authored sample interval rather than mistaking
    // legal codec padding for programme audio.
    await inspectReferenceDecodedTruePeak({ input, workDirectory: scratch, kind: "aac-candidate", expectedFrames, sampleRate: 48_000, source });
    await runFfmpeg(["-nostdin", "-y", "-v", "error", "-i", input, "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", `atrim=start_sample=0:end_sample=${expectedFrames},asetpts=N/SR/TB`, "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", "-f", "f32le", raw], 1_800_000, { stderrBytes: 128_000, totalBytes: 128_000 });
    const peak = await scanReferenceStereoF32LeFile(raw, { expectedFrames, thresholdDbfs: 0, source });
    if (peak.silent) fail("CUT_REVIEW_AUDIO_DECODE", "$.artifact.output.audio", "independent complete decode found a silent delivered master.");
    const truePeak = await scanReferenceStereoF32LeTruePeakFile(raw, { expectedFrames, sampleRate: 48_000, source });
    if (truePeak.silent || truePeak.truePeakDbtp === null || truePeak.truePeakDbtp > target.truePeakDbtp + 0.05) fail("CUT_REVIEW_AUDIO_DECODE", "$.artifact.output.audio", `independent CUT true-peak scan does not satisfy the ${target.truePeakDbtp} dBTP ceiling.`);
    const loudness = await measureReferenceAudioAuthoredBoundary(input, { expectedFrames, sampleRate: 48_000, targetLufs: target.integratedLufs, truePeakDbtp: target.truePeakDbtp, loudnessRangeLu: target.loudnessRangeLu });
    if (loudness.integratedLufs === null || loudness.truePeakDbtp === null || Math.abs(loudness.integratedLufs - target.integratedLufs) > 0.5 || loudness.truePeakDbtp > target.truePeakDbtp + 0.05) fail("CUT_REVIEW_AUDIO_DECODE", "$.artifact.output.audio", "independent authored-boundary loudness measurement misses the delivery target or true-peak ceiling.");
    return { peak, truePeak, loudness };
  } catch (error) {
    if (error instanceof CutProfessionalOutputReviewError) throw error;
    fail("CUT_REVIEW_AUDIO_DECODE", "$.artifact.output.audio", `independent exact 48 kHz stereo decode failed: ${boundedError(error)}`);
  }
}

export async function verifyProfessionalMasterAudioSamples(
  input: string,
  expectedFrames: number,
  target: { integratedLufs: number; truePeakDbtp: number; loudnessRangeLu: number },
) {
  const scratch = await mkdtemp(resolve(tmpdir(), "cut-professional-master-audio-"));
  try { return await inspectProfessionalMasterAudio(input, scratch, expectedFrames, target); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

async function authenticateFreshCurrentRuntimeRender(
  review: ProfessionalOutputReview,
  executable: Awaited<ReturnType<typeof verifyExecutableArtifactBinding>>,
  retained: VerifiedRenderBinding,
): Promise<FreshRenderAuthentication> {
  const scratchLexical = await mkdtemp(resolve(tmpdir(), "cut-professional-render-auth-"));
  let scratchCreatedDev: bigint | undefined, scratchCreatedIno: bigint | undefined, scratchPhysical: string | undefined, scratchLexicalDev: bigint | undefined, scratchLexicalIno: bigint | undefined, scratchPhysicalDev: bigint | undefined, scratchPhysicalIno: bigint | undefined;
  const sealedResourceDirectories: PinnedMirrorDirectory[] = [];
  let primaryFailure: unknown;
  try {
    const scratchCreatedIdentity = await lstat(scratchLexical, { bigint: true });
    scratchCreatedDev = scratchCreatedIdentity.dev; scratchCreatedIno = scratchCreatedIdentity.ino;
    if (!scratchCreatedIdentity.isDirectory() || scratchCreatedIdentity.isSymbolicLink()) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.output", "new isolated render root is not one direct directory.");
    await chmod(scratchLexical, 0o700);
    scratchPhysical = await realpath(scratchLexical);
    const scratchLexicalIdentity = await lstat(scratchLexical, { bigint: true }), scratchPhysicalIdentity = await lstat(scratchPhysical, { bigint: true });
    scratchLexicalDev = scratchLexicalIdentity.dev; scratchLexicalIno = scratchLexicalIdentity.ino; scratchPhysicalDev = scratchPhysicalIdentity.dev; scratchPhysicalIno = scratchPhysicalIdentity.ino;
    if (!scratchLexicalIdentity.isDirectory() || scratchLexicalIdentity.isSymbolicLink() || !scratchPhysicalIdentity.isDirectory() || scratchPhysicalIdentity.isSymbolicLink()
      || scratchLexicalDev !== scratchCreatedDev || scratchLexicalIno !== scratchCreatedIno
      || scratchLexicalDev !== scratchPhysicalDev || scratchLexicalIno !== scratchPhysicalIno) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.output", "isolated render root is not one pinned direct private directory.");
    const isolatedProjectRoot = await ensurePrivateMirrorDirectory(scratchPhysical, ["project"]);
    const isolatedCacheRoot = await ensurePrivateMirrorDirectory(isolatedProjectRoot, [".cut"]);
    if ((await readdir(isolatedCacheRoot)).length !== 0) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.freshRender.cache", "isolated cache namespace was not empty at creation.");
    await mirrorLockedResources(executable, isolatedProjectRoot, sealedResourceDirectories);
    if ((await readdir(isolatedCacheRoot)).length !== 0) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.freshRender.cache", "isolated project was poisoned with cache state before current-runtime execution.");
    const deliveryRoot = await mkdtemp(resolve(scratchPhysical, "delivery-"));
    await chmod(deliveryRoot, 0o700);
    const freshOutput = resolve(deliveryRoot, basename(review.artifact.output.path)), freshStems = resolve(deliveryRoot, "stems");
    let manifest: ReferenceRenderManifest;
    try {
      manifest = await renderReferenceIr(executable.ir, isolatedProjectRoot, freshOutput, executable.output.name, {
        lockSha256: review.artifact.lock.sha256,
        stemsDirectory: freshStems,
        __lockedReferenceBackend: executable.lock.toolchain.referenceBackend,
      });
    } catch (error) {
      fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.output", `fresh current-runtime render failed: ${boundedError(error)}`);
    }
    const outputSha256 = await hashFile(freshOutput), manifestPath = `${freshOutput}.manifest.json`, manifestBytes = await readFile(manifestPath), manifestSha256 = hashArtifactBytes(manifestBytes);
    if (outputSha256 !== manifest.sha256 || outputSha256 !== review.artifact.output.sha256) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.output.sha256", "declared hero bytes are not byte-identical to a fresh isolated render of the verified lock-applied IR.");
    if (manifest.format !== "cut-reference-render" || manifest.version !== 10 || manifest.runtime !== executable.lock.toolchain.referenceRuntime
      || stableJsonStringify(manifest.backend) !== stableJsonStringify(executable.lock.toolchain.referenceBackend)
      || manifest.lock.sha256 !== review.artifact.lock.sha256 || manifest.buildId !== executable.ir.buildId
      || manifest.executionBuildId !== retained.executionBuildId || manifest.output !== basename(review.artifact.output.path)
      || manifest.duration !== review.artifact.durationSeconds || manifest.canvas.width !== retained.width || manifest.canvas.height !== retained.height
      || manifest.canvas.fps !== `${executable.composition.fps.numerator}/${executable.composition.fps.denominator}`) {
      fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.renderManifest", "fresh manifest does not bind the verified lock, current runtime/backend, canonical build, execution build, output, duration and canvas.");
    }
    if (!manifest.stems) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.renderManifest.stems", "fresh authenticated render did not produce required role stems.");
    if (manifest.cache.hits !== 0 || manifest.cache.misses !== executable.composition.sceneIds.length || manifest.cache.scenes.length !== executable.composition.sceneIds.length
      || manifest.cache.scenes.some((scene) => scene.status !== "miss") || manifest.cache.audio.status !== "miss" || manifest.cache.audio.reason !== "CUT_AUDIO_CACHE_COLD") {
      fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.freshRender.cache", "fresh authentication must start from a blank project root with zero picture hits, every scene a miss, and an audio COLD miss.");
    }
    const retainedStems = record(retained.manifest.stems, "$.artifact.renderManifest.stems");
    if (manifest.stems.manifestSha256 !== retainedStems.manifestSha256 || manifest.stems.count !== retainedStems.count) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.renderManifest.stems", "fresh canonical v5 stem manifest identity does not equal the declared retained stem identity.");
    const semanticProjection = (value: Record<string, unknown> | ReferenceRenderManifest) => {
      const stems = record(value.stems, "$.artifact.renderManifest.stems");
      return {
        format: value.format, version: value.version, runtime: value.runtime, backend: value.backend, lock: value.lock,
        buildId: value.buildId, executionBuildId: value.executionBuildId, sha256: value.sha256, duration: value.duration,
        canvas: value.canvas, color: value.color, audio: value.audio, media: value.media,
        stems: { manifestSha256: stems.manifestSha256, count: stems.count },
      };
    };
    if (stableJsonStringify(semanticProjection(manifest)) !== stableJsonStringify(semanticProjection(retained.manifest))) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.renderManifest", "retained render semantics differ from the fresh current-runtime manifest after excluding cache and temporary locators.");
    await verifyReferenceStemEvidence({
      reviewRoot: scratchPhysical,
      renderManifestPath: manifestPath,
      value: manifest.stems,
      expectedLockSha256: review.artifact.lock.sha256,
      expectedRuntime: manifest.runtime,
      expectedExecutionBuildId: manifest.executionBuildId,
      expectedDurationSeconds: manifest.duration,
      expectedSampleRate: manifest.audio.sampleRate,
      diagnosticPath: "$.freshRender.stems",
      parseJson: parseStrictReviewJson,
      verifyArtifacts: verifyReviewArtifacts,
      fail: (sourcePath, message) => fail("CUT_REVIEW_RENDER_AUTHENTICATION", sourcePath, message),
    });
    await verifyProfessionalHeroRoleStems(scratchPhysical, manifestPath, manifest.stems);
    const expectedFrames = review.artifact.durationSeconds * 48_000;
    // Decode the private freshly rendered inode. Its bytes were just required
    // to equal the declared hero digest, avoiding a second open of mutable
    // review evidence after authentication.
    const decodedMaster = await inspectProfessionalMasterAudio(freshOutput, deliveryRoot, expectedFrames, {
      integratedLufs: retained.targetLufs,
      truePeakDbtp: retained.truePeakCeilingDbtp,
      loudnessRangeLu: retained.loudnessRangeLu,
    });
    if (Math.abs(decodedMaster.loudness.integratedLufs! - retained.integratedLufs) > 0.2 || Math.abs(decodedMaster.loudness.truePeakDbtp! - retained.truePeakDbtp) > 0.2) fail("CUT_REVIEW_AUDIO_DECODE", "$.artifact.renderManifest.audio.loudness.output", "retained loudness claims do not reconcile to an independent complete decode of the authenticated delivered master.");
    return { method: "fresh-current-runtime-byte-identity", outputSha256, manifestSha256, buildId: manifest.buildId, executionBuildId: manifest.executionBuildId, runtime: manifest.runtime, decodedMaster };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let cleanupFailure: string | undefined;
    if (!scratchPhysical || scratchLexicalDev === undefined || scratchLexicalIno === undefined || scratchPhysicalDev === undefined || scratchPhysicalIno === undefined) {
      const current = await lstat(scratchLexical, { bigint: true }).catch(() => undefined);
      if (!current || !current.isDirectory() || current.isSymbolicLink() || scratchCreatedDev === undefined || scratchCreatedIno === undefined || current.dev !== scratchCreatedDev || current.ino !== scratchCreatedIno) cleanupFailure = "new isolated render root could not be pinned to its creation inode; CUT refused recursive deletion";
      else {
        try { await rm(scratchLexical, { recursive: true, force: false }); }
        catch (error) { cleanupFailure = `uninitialized isolated render cleanup failed safely: ${boundedError(error)}`; }
      }
    } else {
      const [currentLexical, currentPhysical, currentResolved] = await Promise.all([
        lstat(scratchLexical, { bigint: true }).catch(() => undefined),
        lstat(scratchPhysical, { bigint: true }).catch(() => undefined),
        realpath(scratchLexical).catch(() => ""),
      ]);
      if (!currentLexical || !currentPhysical || !currentLexical.isDirectory() || currentLexical.isSymbolicLink() || !currentPhysical.isDirectory() || currentPhysical.isSymbolicLink()
        || currentResolved !== scratchPhysical || currentLexical.dev !== scratchLexicalDev || currentLexical.ino !== scratchLexicalIno
        || scratchCreatedDev === undefined || scratchCreatedIno === undefined || currentLexical.dev !== scratchCreatedDev || currentLexical.ino !== scratchCreatedIno
        || currentPhysical.dev !== scratchPhysicalDev || currentPhysical.ino !== scratchPhysicalIno) {
        cleanupFailure = "isolated render root changed lexical/physical identity; CUT refused recursive deletion";
      } else {
        const scratchPrefix = scratchPhysical.endsWith(sep) ? scratchPhysical : `${scratchPhysical}${sep}`;
        for (const directory of [...sealedResourceDirectories].reverse()) {
          const metadata = await lstat(directory.path, { bigint: true }).catch(() => undefined), target = await realpath(directory.path).catch(() => "");
          if (!directory.path.startsWith(scratchPrefix) || !metadata || !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev !== directory.dev || metadata.ino !== directory.ino || target !== directory.path) {
            cleanupFailure = `sealed resource ancestor ${JSON.stringify(directory.path)} changed identity; CUT refused recursive deletion`;
            break;
          }
          try { await chmod(directory.path, 0o700); }
          catch (error) { cleanupFailure = `could not safely unseal resource ancestor ${JSON.stringify(directory.path)} for cleanup: ${boundedError(error)}`; break; }
        }
        if (!cleanupFailure) {
          try { await rm(scratchPhysical, { recursive: true, force: false }); }
          catch (error) { cleanupFailure = `isolated render cleanup failed safely: ${boundedError(error)}`; }
        }
      }
    }
    if (cleanupFailure) {
      if (!primaryFailure) fail("CUT_REVIEW_RENDER_AUTHENTICATION", "$.artifact.output", `${cleanupFailure}.`);
      if (primaryFailure instanceof Error) {
        primaryFailure.message = `${primaryFailure.message}; cleanup evidence: ${cleanupFailure}.`;
        Object.defineProperty(primaryFailure, "cleanupFailure", { value: cleanupFailure, enumerable: true, configurable: false });
      } else {
        throw new AggregateError([primaryFailure, new Error(cleanupFailure)], "professional-output authentication and isolated cleanup both failed");
      }
    }
  }
}

async function verifyRenderManifestBinding(
  root: string,
  review: ProfessionalOutputReview,
  executable: Awaited<ReturnType<typeof verifyExecutableArtifactBinding>>,
): Promise<VerifiedRenderBinding> {
  const path = resolve(root, ...review.artifact.renderManifest.path.split("/")), metadata = await lstat(path);
  if (metadata.size > defaultJsonLimits.maxInputBytes) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest", "render manifest exceeds the bounded JSON input limit.");
  const value = await readBoundedJsonArtifact(root, review.artifact.renderManifest, "$.artifact.renderManifest"), manifest = closed(value, "$.artifact.renderManifest", [
    "audio", "backend", "buildId", "cache", "canvas", "color", "duration", "executionBuildId", "format", "lock", "media", "output", "runtime", "sha256", "stems", "version",
  ]);
  if (manifest.format !== "cut-reference-render") fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest", "must be a cut-reference-render manifest.");
  if (manifest.version !== 10) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.version", "must be lock-and-stem-bound render-manifest v10.");
  const runtime = textValue(manifest.runtime, "$.artifact.renderManifest.runtime", 1024), backend = record(manifest.backend, "$.artifact.renderManifest.backend");
  if (runtime !== executable.lock.toolchain.referenceRuntime || stableJsonStringify(backend) !== stableJsonStringify(executable.lock.toolchain.referenceBackend)) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.backend", "does not bind the current lock's exact reference runtime/backend identity.");
  record(manifest.media, "$.artifact.renderManifest.media");
  record(manifest.cache, "$.artifact.renderManifest.cache");
  const manifestLock = closed(manifest.lock, "$.artifact.renderManifest.lock", ["sha256"]);
  if (sha256(manifestLock.sha256, "$.artifact.renderManifest.lock.sha256") !== review.artifact.lock.sha256) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.lock.sha256", "does not bind the declared cut.lock SHA-256.");
  const buildId = sha256(manifest.buildId, "$.artifact.renderManifest.buildId"), executionBuildId = sha256(manifest.executionBuildId, "$.artifact.renderManifest.executionBuildId");
  if (buildId !== executable.ir.buildId) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.buildId", "does not bind the canonical current locked CutAVIR buildId.");
  if (manifest.sha256 !== review.artifact.output.sha256) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.sha256", "does not bind the declared hero output SHA-256.");
  if (manifest.output !== basename(review.artifact.output.path)) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.output", "does not name the declared hero output file.");
  if (typeof manifest.duration !== "number" || Math.abs(manifest.duration - review.artifact.durationSeconds) > 1e-9) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.duration", "does not match the declared hero duration.");
  if (Math.abs(rationalToNumber(executable.composition.duration) - review.artifact.durationSeconds) > 1e-9) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.durationSeconds", "does not match the selected public CUT composition duration.");
  if (executable.composition.sampleRate !== 48_000) fail("CUT_REVIEW_AUDIO", "$.artifact.ir.compositions", "professional-output proof requires a 48 kHz CUT composition.");

  const canvas = closed(manifest.canvas, "$.artifact.renderManifest.canvas", ["fps", "height", "width"]);
  const width = integer(canvas.width, "$.artifact.renderManifest.canvas.width", 16, 16_384), height = integer(canvas.height, "$.artifact.renderManifest.canvas.height", 16, 16_384);
  if (width !== executable.composition.width || height !== executable.composition.height) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.canvas", "does not match the selected public CUT composition canvas.");
  rationalString(canvas.fps, "$.artifact.renderManifest.canvas.fps");
  if (canvas.fps !== `${executable.composition.fps.numerator}/${executable.composition.fps.denominator}`) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.canvas.fps", "does not match the exact public CUT frame rate.");

  const color = closed(manifest.color, "$.artifact.renderManifest.color", ["delivery", "ffprobe", "working"]);
  if (color.working !== "srgb-straight" || !["srgb", "linear-srgb", "rec709-full", "rec709-limited", "legacy-untagged"].includes(color.delivery as string)) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.color", "does not declare CUT's managed straight-alpha working pipeline and supported delivery profile.");
  record(color.ffprobe, "$.artifact.renderManifest.color.ffprobe");

  if (manifest.stems === undefined) fail("CUT_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.stems", "is required for professional hero-film review evidence.");
  const renderAudio = closed(manifest.audio, "$.artifact.renderManifest.audio", ["channels", "delivery", "filters", "limiter", "loudness", "roots", "samplePeak", "sampleRate"]);
  const roots = integer(renderAudio.roots, "$.artifact.renderManifest.audio.roots", 1, 100_000);
  integer(renderAudio.filters, "$.artifact.renderManifest.audio.filters", 0, 100_000);
  if (renderAudio.sampleRate !== 48_000 || renderAudio.channels !== 2) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio", "must declare a non-empty 48 kHz stereo mix.");
  if (roots < 1) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.roots", "must contain at least one authored audio root.");
  record(renderAudio.limiter, "$.artifact.renderManifest.audio.limiter");
  const expectedAudioFrames = review.artifact.durationSeconds * 48_000;
  if (!Number.isSafeInteger(expectedAudioFrames)) fail("CUT_REVIEW_AUDIO", "$.artifact.durationSeconds", "does not land on an exact 48 kHz sample boundary.");
  validatePeakEvidence(renderAudio.samplePeak, "$.artifact.renderManifest.audio.samplePeak", expectedAudioFrames);

  const loudness = closed(renderAudio.loudness, "$.artifact.renderManifest.audio.loudness", ["input", "normalization", "normalized", "output", "reconciliation", "target"]);
  const target = closed(loudness.target, "$.artifact.renderManifest.audio.loudness.target", ["integratedLufs", "loudnessRangeLu", "truePeakDbtp"]);
  const targetLufs = finiteField(target, "integratedLufs", "$.artifact.renderManifest.audio.loudness.target", -24, -5);
  const truePeakCeilingDbtp = finiteField(target, "truePeakDbtp", "$.artifact.renderManifest.audio.loudness.target", -9, -0.1);
  const loudnessRangeLu = finiteField(target, "loudnessRangeLu", "$.artifact.renderManifest.audio.loudness.target", 1, 50);
  record(loudness.input, "$.artifact.renderManifest.audio.loudness.input");
  record(loudness.normalized, "$.artifact.renderManifest.audio.loudness.normalized");
  const outputLoudness = closed(loudness.output, "$.artifact.renderManifest.audio.loudness.output", ["integratedLufs", "loudnessRangeLu", "thresholdLufs", "truePeakDbtp"]);
  const integratedLufs = finiteField(outputLoudness, "integratedLufs", "$.artifact.renderManifest.audio.loudness.output", -70, 0);
  const truePeakDbtp = finiteField(outputLoudness, "truePeakDbtp", "$.artifact.renderManifest.audio.loudness.output", -100, 0);
  finiteField(outputLoudness, "loudnessRangeLu", "$.artifact.renderManifest.audio.loudness.output", 0, 100);
  finiteField(outputLoudness, "thresholdLufs", "$.artifact.renderManifest.audio.loudness.output", -100, 0);
  if (Math.abs(integratedLufs - targetLufs) > 0.5) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.loudness.output.integratedLufs", "is more than 0.5 LU from the authored delivery target.");
  if (truePeakDbtp > truePeakCeilingDbtp + 1e-9) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.loudness.output.truePeakDbtp", "exceeds the authored true-peak ceiling.");
  const reconciliation = record(loudness.reconciliation, "$.artifact.renderManifest.audio.loudness.reconciliation");
  if (reconciliation.withinTargetTolerance !== true || reconciliation.truePeakCompliant !== true) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.loudness.reconciliation", "must confirm target-tolerant loudness and true-peak compliance.");

  const delivery = record(renderAudio.delivery, "$.artifact.renderManifest.audio.delivery");
  if (delivery.format !== "cut-reference-aac-delivery" || delivery.version !== 2 || delivery.source !== "normalized-pcm" || delivery.truePeakCompliant !== true) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.delivery", "must be a compliant normalized-PCM CUT AAC delivery v2 report.");
  if (delivery.status === "loudness-unmeasurable") fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.delivery.status", "professional delivery cannot use an unmeasurable loudness result.");
  const deliveryTarget = record(delivery.target, "$.artifact.renderManifest.audio.delivery.target");
  if (deliveryTarget.integratedLufs !== targetLufs || deliveryTarget.truePeakDbtp !== truePeakCeilingDbtp) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.delivery.target", "does not match the render loudness target.");
  const passes = arrayValue(delivery.passes, "$.artifact.renderManifest.audio.delivery.passes", 1, 16).map((item, index) => record(item, `$.artifact.renderManifest.audio.delivery.passes[${index}]`));
  if (sha256(passes.at(-1)!.encodedSha256, "$.artifact.renderManifest.audio.delivery.passes[-1].encodedSha256") !== review.artifact.output.sha256) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.delivery.passes[-1].encodedSha256", "does not bind the delivered hero bytes.");
  const finalMeasurement = record(delivery.finalFfmpegMeasurement, "$.artifact.renderManifest.audio.delivery.finalFfmpegMeasurement");
  if (finalMeasurement.integratedLufs !== integratedLufs || finalMeasurement.truePeakDbtp !== truePeakDbtp) fail("CUT_REVIEW_AUDIO", "$.artifact.renderManifest.audio.delivery.finalFfmpegMeasurement", "does not reconcile with the render output loudness measurement.");

  const stemEvidence = await verifyReferenceStemEvidence({
    reviewRoot: root,
    renderManifestPath: path,
    value: manifest.stems,
    expectedLockSha256: manifestLock.sha256 as string,
    expectedRuntime: manifest.runtime,
    expectedExecutionBuildId: executionBuildId,
    expectedDurationSeconds: manifest.duration,
    expectedSampleRate: renderAudio.sampleRate,
    diagnosticPath: "$.artifact.renderManifest.stems",
    parseJson: parseStrictReviewJson,
    verifyArtifacts: verifyReviewArtifacts,
    fail: (sourcePath, message) => fail("CUT_REVIEW_RENDER_MANIFEST", sourcePath, message),
  });
  const audioTopology = professionalHeroAudioTopology(executable.ir, executable.composition);
  await verifyProfessionalHeroRoleStems(root, path, manifest.stems);

  let probe: CutMediaProbe;
  try { probe = await probeProjectMedia(root, review.artifact.output.path); }
  catch (error) { fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output", `cannot probe the declared hero MP4: ${boundedError(error)}`); }
  if (probe.file.sha256 !== review.artifact.output.sha256) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output.sha256", "does not match the independently probed hero bytes.");
  const videoStreams = probe.streams.filter((stream) => stream.type === "video"), audioStreams = probe.streams.filter((stream) => stream.type === "audio");
  if (!probe.container.names.includes("mp4") || probe.streams.length !== 2 || videoStreams.length !== 1 || audioStreams.length !== 1) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output", "must be an MP4 container containing exactly one H.264 video stream and one AAC audio stream.");
  const video = videoStreams[0]!, audio = audioStreams[0]!;
  if (video.codec !== "h264" || video.pixelFormat !== "yuv420p" || audio.codec !== "aac") fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output", "must use CUT's H.264 yuv420p picture and AAC delivery profile.");
  if (video.width !== width || video.height !== height) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output.video", "decoded dimensions do not match the CUT composition.");
  if (!video.frameRate || video.frameRate.numerator !== executable.composition.fps.numerator || video.frameRate.denominator !== executable.composition.fps.denominator) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output.video.frameRate", "does not match the exact authored CUT frame rate.");
  if (audio.sampleRate !== 48_000 || audio.channels !== 2) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output.audio", "must contain an actual 48 kHz stereo audio stream.");
  const actualColor = { colorRange: video.colorRange, colorSpace: video.colorSpace, colorTransfer: video.colorTransfer, colorPrimaries: video.colorPrimaries };
  const declaredColor = record(color.ffprobe, "$.artifact.renderManifest.color.ffprobe"), colorFields = ["colorRange", "colorSpace", "colorTransfer", "colorPrimaries"] as const;
  if (Object.keys(declaredColor).some((field) => !colorFields.includes(field as typeof colorFields[number])) || colorFields.some((field) => declaredColor[field] !== actualColor[field])) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.renderManifest.color.ffprobe", "does not exactly match independently probed delivered color tags.");
  const duration = probe.container.duration ?? video.duration;
  if (!duration) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output.duration", "does not expose a trustworthy media duration.");
  const durationTolerance = Math.max(1 / rationalToNumber(executable.composition.fps), 1 / 48_000);
  if (Math.abs(rationalToNumber(duration) - review.artifact.durationSeconds) > durationTolerance + 1e-9) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output.duration", "does not match the CUT composition within one frame.");
  const start = probe.container.start ?? video.start;
  if (start && Math.abs(rationalToNumber(start)) > 1 / 48_000) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output.start", "must begin at the zero program boundary.");
  if (!audio.duration || Math.abs(rationalToNumber(audio.duration) - review.artifact.durationSeconds) > 1 / 48_000 + 1e-9 || (audio.start && Math.abs(rationalToNumber(audio.start)) > 1 / 48_000)) fail("CUT_REVIEW_MEDIA_PROBE", "$.artifact.output.audio", "must expose an exact zero-start, complete authored audio boundary.");
  const expectedVideoFrames = review.artifact.durationSeconds * rationalToNumber(executable.composition.fps);
  if (!Number.isSafeInteger(expectedVideoFrames)) fail("CUT_REVIEW_FRAME_SCAN", "$.artifact.durationSeconds", "does not land on an exact output-frame boundary.");
  const frameSequence = await inspectHeroFrameSequence(resolve(root, ...review.artifact.output.path.split("/")), expectedVideoFrames, rationalToNumber(executable.composition.fps));
  const stemMarker = record(manifest.stems, "$.artifact.renderManifest.stems");
  return {
    manifest,
    probe,
    buildId,
    executionBuildId,
    width,
    height,
    fps: rationalToNumber(executable.composition.fps),
    integratedLufs,
    truePeakDbtp,
    targetLufs,
    truePeakCeilingDbtp,
    loudnessRangeLu,
    audioTopology,
    frameSequence,
    dynamicArtifacts: [
      { role: "hero.stems.manifest", artifact: { path: stemEvidence.manifestPath, sha256: sha256(stemMarker.manifestSha256, "$.artifact.renderManifest.stems.manifestSha256") } },
      ...stemEvidence.waveArtifacts.map((artifact, index) => ({ role: `hero.stems.wave.${index}`, artifact })),
    ],
  };
}

function expectedTechnicalSubject(review: ProfessionalOutputReview): TechnicalSubject {
  return {
    sourceSha256: review.artifact.source.sha256,
    lockSha256: review.artifact.lock.sha256,
    irSha256: review.artifact.ir.sha256,
    outputSha256: review.artifact.output.sha256,
    renderManifestSha256: review.artifact.renderManifest.sha256,
  };
}

function technicalReportEnvelope(
  value: unknown,
  path: string,
  id: typeof technicalEvidenceIds[number],
  gateEvidence: EvidenceGate,
  expected: TechnicalSubject,
  fields: readonly string[],
) {
  const item = closed(value, path, ["command", "format", "status", "subject", "version", ...fields]);
  const contract = technicalEvidenceContracts[id];
  if (item.format !== contract.reportFormat || item.version !== 1 || item.command !== contract.command) fail("CUT_REVIEW_TECHNICAL_REPORT", path, `must be ${contract.reportFormat} v1 for command ${contract.command}.`);
  const status = enumValue(item.status, `${path}.status`, ["pass", "fail"]), subject = technicalSubject(item.subject, `${path}.subject`);
  if (status !== gateEvidence.status) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.status`, "does not match the review evidence-gate status.");
  if (stableJsonStringify(subject) !== stableJsonStringify(expected) || stableJsonStringify(subject) !== stableJsonStringify(gateEvidence.subject)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.subject`, "does not bind the exact five declared hero artifact hashes.");
  return { item, status };
}

function derivedTechnicalStatus(condition: boolean): "pass" | "fail" { return condition ? "pass" : "fail"; }

async function verifyTechnicalEvidenceRecords(
  root: string,
  review: ProfessionalOutputReview,
  executable: Awaited<ReturnType<typeof verifyExecutableArtifactBinding>>,
  render: VerifiedRenderBinding,
) {
  const expected = expectedTechnicalSubject(review), dynamicArtifacts: EvidenceArtifactRole[] = [];
  for (const id of technicalEvidenceIds) {
    const gateEvidence = review.technicalEvidence[id], path = `$.technicalEvidence.${id}.artifact`;
    const value = await readBoundedJsonArtifact(root, gateEvidence.artifact, path);
    if (id === "sourceCheck") {
      const { item, status } = technicalReportEnvelope(value, path, id, gateEvidence, expected, ["result"]);
      const result = closed(item.result, `${path}.result`, ["command", "diagnostics", "format", "program", "status", "version"]);
      if (result.format !== "cut-diagnostics" || result.version !== 1 || result.command !== "check" || result.program !== basename(review.artifact.source.path)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.result`, "must contain the exact public cut check --json report for the hero source.");
      const diagnostics = arrayValue(result.diagnostics, `${path}.result.diagnostics`, 0, 100_000).map((entry, index) => record(entry, `${path}.result.diagnostics[${index}]`));
      const derived = derivedTechnicalStatus(result.status === "pass" && diagnostics.every((diagnostic) => diagnostic.severity !== "error"));
      if (status !== derived || status !== "pass") fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.status`, "must reconcile to a passing public source check.");
      continue;
    }
    if (id === "sourceTest") {
      const { item, status } = technicalReportEnvelope(value, path, id, gateEvidence, expected, ["result"]);
      const result = closed(item.result, `${path}.result`, ["assertions", "buildId", "format", "program", "summary", "version"]);
      if (result.format !== "cut-av-test-report" || result.version !== 1 || result.program !== basename(review.artifact.source.path) || result.buildId !== executable.unlockedBuildId) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.result`, "must contain the current public cut test --json report for the hero source and unlocked build.");
      if (!Array.isArray(result.assertions) || result.assertions.length === 0) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.result.assertions`, "must contain the exact non-empty ordered assertion list compiled from the declared public CUT source.");
      const assertions = arrayValue(result.assertions, `${path}.result.assertions`, 1, 100_000).map((value, index) => {
        const assertionPath = `${path}.result.assertions[${index}]`, item = closed(value, assertionPath, ["id", "message", "source", "status"]), source = closed(item.source, `${assertionPath}.source`, ["column", "line", "module"]);
        return {
          id: textValue(item.id, `${assertionPath}.id`, 1024),
          status: enumValue(item.status, `${assertionPath}.status`, ["pass", "fail", "deferred"]),
          message: item.message === null ? null : textValue(item.message, `${assertionPath}.message`, 4096),
          source: { module: textValue(source.module, `${assertionPath}.source.module`, 4096), line: integer(source.line, `${assertionPath}.source.line`, 1, Number.MAX_SAFE_INTEGER), column: integer(source.column, `${assertionPath}.source.column`, 1, Number.MAX_SAFE_INTEGER) },
        };
      });
      const summary = closed(result.summary, `${path}.result.summary`, ["deferred", "fail", "pass", "total"]);
      const pass = integer(summary.pass, `${path}.result.summary.pass`, 0, 100_000), failed = integer(summary.fail, `${path}.result.summary.fail`, 0, 100_000), deferred = integer(summary.deferred, `${path}.result.summary.deferred`, 0, 100_000), total = integer(summary.total, `${path}.result.summary.total`, 0, 100_000);
      if (pass + failed + deferred !== total || assertions.length !== total) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.result.summary`, "does not reconcile to the authored assertion list.");
      const expectedAssertions = executable.ir.assertions.map((assertion) => ({ id: assertion.id, status: assertion.status, message: assertion.message ?? null, source: { module: assertion.provenance.module, line: assertion.provenance.span.start.line, column: assertion.provenance.span.start.column } }));
      if (!expectedAssertions.length || stableJsonStringify(assertions) !== stableJsonStringify(expectedAssertions)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.result.assertions`, "must exactly match the non-empty ordered assertion list compiled from the declared public CUT source.");
      if (status !== derivedTechnicalStatus(failed === 0 && deferred === 0)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.status`, "does not reconcile to the CUT test summary.");
      continue;
    }
    if (id === "renderManifest") {
      const { item, status } = technicalReportEnvelope(value, path, id, gateEvidence, expected, ["manifest"]);
      const manifest = closed(item.manifest, `${path}.manifest`, ["buildId", "executionBuildId", "format", "path", "sha256", "version"]);
      const valid = manifest.format === "cut-reference-render" && manifest.version === 10
        && manifest.path === review.artifact.renderManifest.path && manifest.sha256 === review.artifact.renderManifest.sha256
        && manifest.buildId === render.buildId && manifest.executionBuildId === render.manifest.executionBuildId;
      if (status !== derivedTechnicalStatus(valid) || status !== "pass") fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.manifest`, "does not bind the verified current render-manifest v10.");
      continue;
    }
    if (id === "deterministicReplay") {
      const { item, status } = technicalReportEnvelope(value, path, id, gateEvidence, expected, ["byteIdentical", "replayOutput", "replayRenderManifest"]);
      const replayOutput = hashedArtifact(item.replayOutput, `${path}.replayOutput`), replayManifestArtifact = hashedArtifact(item.replayRenderManifest, `${path}.replayRenderManifest`);
      if (!replayOutput.path.endsWith(".mp4") || !replayManifestArtifact.path.endsWith(".manifest.json") || replayOutput.path === review.artifact.output.path || replayManifestArtifact.path === review.artifact.renderManifest.path) fail("CUT_REVIEW_TECHNICAL_REPORT", path, "replay evidence must retain distinct typed MP4 and render-manifest artifacts.");
      await verifyReviewArtifacts(root, [replayOutput, replayManifestArtifact]);
      dynamicArtifacts.push(
        { role: "technical.deterministicReplay.output", artifact: replayOutput },
        { role: "technical.deterministicReplay.renderManifest", artifact: replayManifestArtifact },
      );
      const replayManifest = record(await readBoundedJsonArtifact(root, replayManifestArtifact, `${path}.replayRenderManifest`), `${path}.replayRenderManifest`);
      const replayValid = replayManifest.format === "cut-reference-render" && replayManifest.version === 10
        && replayManifest.buildId === render.buildId && record(replayManifest.lock, `${path}.replayRenderManifest.lock`).sha256 === review.artifact.lock.sha256
        && replayManifest.sha256 === replayOutput.sha256 && replayManifest.output === basename(replayOutput.path)
        && replayManifest.duration === review.artifact.durationSeconds && replayOutput.sha256 === review.artifact.output.sha256;
      let replayProbe: CutMediaProbe;
      try { replayProbe = await probeProjectMedia(root, replayOutput.path); }
      catch (error) { fail("CUT_REVIEW_MEDIA_PROBE", `${path}.replayOutput`, `cannot probe deterministic replay: ${boundedError(error)}`); }
      const actualReplay = replayProbe.file.sha256 === review.artifact.output.sha256 && replayProbe.streams.some((stream) => stream.type === "video") && replayProbe.streams.some((stream) => stream.type === "audio");
      const valid = item.byteIdentical === true && replayValid && actualReplay;
      if (status !== derivedTechnicalStatus(valid)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.status`, "does not reconcile to the retained byte-identical replay.");
      continue;
    }
    if (id === "frameScan") {
      const { item, status } = technicalReportEnvelope(value, path, id, gateEvidence, expected, ["brokenAlphaFrames", "clippedTextFrames", "completeFrameCoverage", "consecutiveFrameChanges", "deadFrames", "distinctFrameDigests", "expectedFrames", "frameSequenceSha256", "glitchFrames", "illegibleLabelFrames", "longestIdenticalRunFrames", "scannedFrames"]);
      const fps = rationalToNumber(executable.composition.fps), expectedFrames = review.artifact.durationSeconds * fps;
      if (!Number.isSafeInteger(expectedFrames)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.expectedFrames`, "hero duration does not form an exact safe-integer frame count.");
      const scanned = integer(item.scannedFrames, `${path}.scannedFrames`, 0, Number.MAX_SAFE_INTEGER), declaredExpected = integer(item.expectedFrames, `${path}.expectedFrames`, 1, Number.MAX_SAFE_INTEGER);
      const defects = ["brokenAlphaFrames", "clippedTextFrames", "deadFrames", "glitchFrames", "illegibleLabelFrames"].map((field) => integer(item[field], `${path}.${field}`, 0, Number.MAX_SAFE_INTEGER));
      const distinct = integer(item.distinctFrameDigests, `${path}.distinctFrameDigests`, 1, Number.MAX_SAFE_INTEGER), changes = integer(item.consecutiveFrameChanges, `${path}.consecutiveFrameChanges`, 0, Number.MAX_SAFE_INTEGER), longest = integer(item.longestIdenticalRunFrames, `${path}.longestIdenticalRunFrames`, 1, Number.MAX_SAFE_INTEGER);
      // Sequence identity/count/change statistics are independently decoded.
      // Defect counters remain accepted human/tool attestations until CUT ships
      // a named analyzer for each class; the output report labels that boundary.
      const valid = item.completeFrameCoverage === true && declaredExpected === expectedFrames && scanned === expectedFrames && defects.every((count) => count === 0)
        && item.frameSequenceSha256 === render.frameSequence.frameSequenceSha256 && distinct === render.frameSequence.distinctFrameDigests
        && changes === render.frameSequence.consecutiveFrameChanges && longest === render.frameSequence.longestIdenticalRunFrames;
      if (status !== derivedTechnicalStatus(valid)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.status`, "does not reconcile to the independently decoded sequence and accepted human/tool defect attestations.");
      continue;
    }
    if (id === "audioDelivery") {
      const { item, status } = technicalReportEnvelope(value, path, id, gateEvidence, expected, ["channels", "clippingSamples", "integratedLufs", "sampleRate", "targetLufs", "truePeakCeilingDbtp", "truePeakCompliant", "truePeakDbtp", "withinLoudnessTolerance"]);
      const integrated = finiteField(item, "integratedLufs", path, -70, 0), target = finiteField(item, "targetLufs", path, -24, -5), peak = finiteField(item, "truePeakDbtp", path, -100, 0), ceiling = finiteField(item, "truePeakCeilingDbtp", path, -9, -0.1);
      const valid = item.sampleRate === 48_000 && item.channels === 2 && item.clippingSamples === 0 && item.withinLoudnessTolerance === true && item.truePeakCompliant === true
        && integrated === render.integratedLufs && target === render.targetLufs && peak === render.truePeakDbtp && ceiling === render.truePeakCeilingDbtp;
      if (status !== derivedTechnicalStatus(valid)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.status`, "does not reconcile to the verified 48 kHz render delivery.");
      continue;
    }
    if (id === "rightsProvenance") {
      const { item, status } = technicalReportEnvelope(value, path, id, gateEvidence, expected, ["allCleared", "assets", "narrationConsent"]);
      const resources = new Map(Object.values(executable.ir.resources).map((resource) => [resource.id, resource]));
      const assets = arrayValue(item.assets, `${path}.assets`, 1, 10_000).map((entry, index) => {
        const assetPath = `${path}.assets[${index}]`, asset = closed(entry, assetPath, ["license", "licenseEvidence", "resourceId", "role", "sha256"]);
        const resourceId = identifier(asset.resourceId, `${assetPath}.resourceId`), resource = resources.get(resourceId);
        if (!resource || !resource.sha256 || resource.sha256 !== sha256(asset.sha256, `${assetPath}.sha256`)) fail("CUT_REVIEW_RIGHTS", assetPath, "does not bind one locked external resource in the hero CutAVIR.");
        const role = enumValue(asset.role, `${assetPath}.role`, ["narration", "score", "sfx", "ambience", "visual", "font", "data"]), licenseEvidence = hashedArtifact(asset.licenseEvidence, `${assetPath}.licenseEvidence`);
        enumValue(asset.license, `${assetPath}.license`, ["original", "licensed", "cc0", "public-domain"]);
        const expectedBusRole = requiredHeroAudioRoles[role as keyof typeof requiredHeroAudioRoles];
        if (expectedBusRole && (resource.kind !== "audio" || !render.audioTopology.resourcesByBusRole.get(expectedBusRole)?.has(resourceId))) fail("CUT_REVIEW_RIGHTS", assetPath, `role ${JSON.stringify(role)} is not actually consumed beneath the matching ${JSON.stringify(expectedBusRole)} Bus role in the public CUT graph.`);
        if (!expectedBusRole && !((role === "visual" && ["video", "image"].includes(resource.kind)) || role === "font" && resource.kind === "font" || role === "data" && resource.kind === "data")) fail("CUT_REVIEW_RIGHTS", assetPath, `role ${JSON.stringify(role)} is incompatible with locked resource kind ${JSON.stringify(resource.kind)}.`);
        return { resourceId, role, licenseEvidence };
      });
      unique(assets.map((asset) => asset.resourceId), `${path}.assets[].resourceId`);
      await verifyReviewArtifacts(root, assets.map((asset) => asset.licenseEvidence));
      dynamicArtifacts.push(...assets.map((asset) => ({ role: `technical.rights.license.${asset.resourceId}`, artifact: asset.licenseEvidence })));
      const roles = new Set(assets.map((asset) => asset.role)), exactResources = resources.size === assets.length && [...resources.keys()].every((idValue) => assets.some((asset) => asset.resourceId === idValue));
      const valid = item.allCleared === true && item.narrationConsent === true && exactResources && ["narration", "score", "sfx", "ambience"].every((role) => roles.has(role as typeof assets[number]["role"]));
      if (status !== derivedTechnicalStatus(valid)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.status`, "must clear every locked external resource and include narration, licensed score, SFX, ambience, and narration consent.");
      continue;
    }
    const { item, status } = technicalReportEnvelope(value, path, id, gateEvidence, expected, ["checks"]);
    const checks = closed(item.checks, `${path}.checks`, ["irStrictLoaded", "lockApplied", "noCreativePostFix", "noHiddenRenderer", "publicCliOnly", "renderBound", "sourceParsedAndChecked"]);
    const valid = Object.values(checks).every((check) => check === true);
    if (status !== derivedTechnicalStatus(valid)) fail("CUT_REVIEW_TECHNICAL_REPORT", `${path}.status`, "does not reconcile to the canonical public authoring boundary.");
  }
  return dynamicArtifacts;
}

async function verifyFailedIterationBindings(
  root: string,
  review: ProfessionalOutputReview,
  hero: Awaited<ReturnType<typeof verifyExecutableArtifactBinding>>,
) {
  for (const [index, iteration] of review.iterationHistory.priorFailedIterations.entries()) {
    const path = `$.iterationHistory.priorFailedIterations[${index}]`, sourcePath = resolve(root, ...iteration.source.path.split("/")), projectRoot = dirname(sourcePath);
    try {
      const sourceBytes = await readBoundedArtifactBytes(root, iteration.source, `${path}.source`, 8 * 1024 * 1024);
      let source: string;
      try { source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes); }
      catch { fail("CUT_REVIEW_FAILED_ITERATION", `${path}.source`, "is not valid UTF-8 CUT source."); }
      if (hash(source) !== iteration.source.sha256) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.source.sha256`, "does not equal CUT's canonical raw source hash.");
      const parsed = parseCutLanguage(source), parseErrors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (!parsed.module || parseErrors.length) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.source`, `does not parse as retained CUT source (${parseErrors[0]?.code ?? "no module"}).`);
      const externalPackages = await packageContextForReviewSource(sourcePath);
      const modules = await loadCutUserModuleGraph(sourcePath, parsed.module, { packages: externalPackages?.packages });
      const moduleErrors = modules.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (!modules.graph || moduleErrors.length) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.source`, `cannot load its public module graph (${moduleErrors[0]?.code ?? "no graph"}).`);
      const checked = checkCutModule(parsed.module, { packages: externalPackages?.packages, userModules: modules.graph.contracts, moduleKind: "entry" });
      const checkErrors = checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (checkErrors.length) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.source`, `does not type-check (${checkErrors[0]!.code}).`);
      const compiled = compileCutModule(parsed.module, {}, externalPackages, modules.graph).ir;
      const lock = loadCutLock(await readBoundedArtifactBytes(root, iteration.lock, `${path}.lock`, 64 * 1024 * 1024));
      await applyCutLock(compiled, lock, projectRoot);
      const retainedIr = loadCutAvIr(await readBoundedArtifactBytes(root, iteration.ir, `${path}.ir`, 64 * 1024 * 1024));
      if (lock.sourceHash !== iteration.source.sha256 || retainedIr.sourceHash !== iteration.source.sha256 || retainedIr.determinism.semantic !== "locked" || retainedIr.buildId !== compiled.buildId) fail("CUT_REVIEW_FAILED_ITERATION", path, "source, lock and retained strict CutAVIR do not identify one current executable failed iteration.");

      if (retainedIr.project !== hero.ir.project) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.ir.project`, "must retain an iteration of the same declared CUT production as the hero, not an unrelated fixture.");
      if (!professionalFailedIterationIdentityIsDistinct(
        { sourceSha256: iteration.source.sha256, lockSha256: iteration.lock.sha256, irSha256: iteration.ir.sha256, buildId: retainedIr.buildId },
        { sourceSha256: review.artifact.source.sha256, lockSha256: review.artifact.lock.sha256, irSha256: review.artifact.ir.sha256, buildId: hero.ir.buildId },
      )) fail("CUT_REVIEW_FAILED_ITERATION", path, "must be a genuinely revised source/lock/IR execution, not the final locked build paired with different self-described output bytes.");
      const manifest = closed(await readBoundedJsonArtifact(root, iteration.renderManifest, `${path}.renderManifest`), `${path}.renderManifest`, ["audio", "backend", "buildId", "cache", "canvas", "color", "duration", "executionBuildId", "format", "lock", "media", "output", "runtime", "sha256", "stems", "version"]);
      const manifestLock = closed(manifest.lock, `${path}.renderManifest.lock`, ["sha256"]);
      sha256(manifest.executionBuildId, `${path}.renderManifest.executionBuildId`);
      if (manifest.format !== "cut-reference-render" || manifest.version !== 10 || manifest.runtime !== lock.toolchain.referenceRuntime || stableJsonStringify(manifest.backend) !== stableJsonStringify(lock.toolchain.referenceBackend)
        || manifestLock.sha256 !== iteration.lock.sha256 || manifest.buildId !== retainedIr.buildId || manifest.sha256 !== iteration.output.sha256 || manifest.output !== basename(iteration.output.path)) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.renderManifest`, "does not strictly bind the retained source/lock/IR/output and locked runtime/backend through render-manifest v10.");
      const duration = finiteNumber(manifest.duration, `${path}.renderManifest.duration`, 180, 300);
      if (retainedIr.outputs.length !== 1) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.ir.outputs`, "must retain exactly one canonical render output.");
      const composition = retainedIr.compositions.find((item) => item.id === retainedIr.outputs[0]!.timelineId);
      if (!composition || Math.abs(rationalToNumber(composition.duration) - duration) > 1e-9 || duration !== review.artifact.durationSeconds
        || composition.width !== hero.composition.width || composition.height !== hero.composition.height
        || composition.fps.numerator !== hero.composition.fps.numerator || composition.fps.denominator !== hero.composition.fps.denominator || composition.sampleRate !== 48_000) {
        fail("CUT_REVIEW_FAILED_ITERATION", `${path}.renderManifest.duration`, "must be a hero-scale iteration of the same production with the same duration, canvas, frame rate and 48 kHz clock.");
      }
      const canvas = closed(manifest.canvas, `${path}.renderManifest.canvas`, ["fps", "height", "width"]);
      if (canvas.width !== composition.width || canvas.height !== composition.height || canvas.fps !== `${composition.fps.numerator}/${composition.fps.denominator}`) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.renderManifest.canvas`, "does not match the retained composition exactly.");
      const audioManifest = record(manifest.audio, `${path}.renderManifest.audio`);
      if (audioManifest.sampleRate !== 48_000 || audioManifest.channels !== 2 || !Number.isSafeInteger(audioManifest.roots) || Number(audioManifest.roots) < 1) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.renderManifest.audio`, "must bind an authored 48 kHz stereo failed mix.");
      record(manifest.color, `${path}.renderManifest.color`); record(manifest.media, `${path}.renderManifest.media`); record(manifest.cache, `${path}.renderManifest.cache`); record(manifest.stems, `${path}.renderManifest.stems`);
      let probe: CutMediaProbe;
      try { probe = await probeProjectMedia(root, iteration.output.path); }
      catch (error) { fail("CUT_REVIEW_FAILED_ITERATION", `${path}.output`, `is not a probeable retained MP4: ${boundedError(error)}`); }
      const videos = probe.streams.filter((stream) => stream.type === "video"), audios = probe.streams.filter((stream) => stream.type === "audio"), video = videos[0], audio = audios[0];
      if (probe.file.sha256 !== iteration.output.sha256 || !probe.container.names.includes("mp4") || probe.streams.length !== 2 || videos.length !== 1 || audios.length !== 1 || video?.codec !== "h264" || video.pixelFormat !== "yuv420p" || audio?.codec !== "aac"
        || video.width !== composition.width || video.height !== composition.height || !video.frameRate || video.frameRate.numerator !== composition.fps.numerator || video.frameRate.denominator !== composition.fps.denominator
        || audio.sampleRate !== 48_000 || audio.channels !== 2 || !audio.duration || Math.abs(rationalToNumber(audio.duration) - duration) > 1 / 48_000 + 1e-9
        || audio.start && Math.abs(rationalToNumber(audio.start)) > 1 / 48_000) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.output`, "must be a complete zero-start H.264/yuv420p plus 48 kHz stereo AAC render matching the retained failed composition.");
      const expectedFrames = duration * rationalToNumber(composition.fps);
      if (!Number.isSafeInteger(expectedFrames)) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.output`, "failed iteration duration must land on an exact video frame boundary.");
      await verifyCompleteDecodedFrameCount(resolve(root, ...iteration.output.path.split("/")), expectedFrames, `${path}.output`);
      const audioScratch = await mkdtemp(resolve(tmpdir(), "cut-professional-failed-audio-"));
      try {
        await inspectReferenceDecodedTruePeak({
          input: resolve(root, ...iteration.output.path.split("/")),
          workDirectory: audioScratch,
          kind: "aac-candidate",
          expectedFrames: duration * 48_000,
          sampleRate: 48_000,
          source: { module: iteration.source.path, line: 1, column: 1 },
        });
      } catch (error) {
        if (error instanceof CutProfessionalOutputReviewError) throw error;
        fail("CUT_REVIEW_FAILED_ITERATION", `${path}.output`, `failed iteration does not decode to its exact complete audio sample boundary: ${boundedError(error)}`);
      } finally { await rm(audioScratch, { recursive: true, force: true }); }

      const failedReview = closed(await readBoundedJsonArtifact(root, iteration.review, `${path}.review`), `${path}.review`, ["decision", "evidence", "failedCategories", "format", "fullSpeedPlayback", "headphoneListening", "iterationId", "reviewedAt", "reviewerId", "subject", "summary", "version"]);
      if (failedReview.format !== "cut-professional-output-failed-iteration-review" || failedReview.version !== 1 || failedReview.decision !== "revise" || failedReview.iterationId !== iteration.id) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.review`, "must be a revise decision in failed-iteration-review v1 for this exact iteration ID.");
      const reviewerId = identifier(failedReview.reviewerId, `${path}.review.reviewerId`);
      if (![review.playbackReview.implementer.reviewerId, review.playbackReview.independent.reviewerId].includes(reviewerId) || failedReview.fullSpeedPlayback !== true || failedReview.headphoneListening !== true) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.review`, "must retain a named hero reviewer’s complete full-speed picture and headphone rejection of the failed iteration.");
      isoDate(failedReview.reviewedAt, `${path}.review.reviewedAt`);
      const failedSubject = technicalSubject(failedReview.subject, `${path}.review.subject`), expectedSubject: TechnicalSubject = {
        sourceSha256: iteration.source.sha256,
        lockSha256: iteration.lock.sha256,
        irSha256: iteration.ir.sha256,
        outputSha256: iteration.output.sha256,
        renderManifestSha256: iteration.renderManifest.sha256,
      };
      if (stableJsonStringify(failedSubject) !== stableJsonStringify(expectedSubject)) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.review.subject`, "does not bind the exact retained failed-iteration artifact tuple.");
      const failedCategories = arrayValue(failedReview.failedCategories, `${path}.review.failedCategories`, 1, professionalOutputCategoryIds.length).map((category, categoryIndex) => enumValue(category, `${path}.review.failedCategories[${categoryIndex}]`, professionalOutputCategoryIds));
      unique(failedCategories, `${path}.review.failedCategories`);
      if (stableJsonStringify([...failedCategories].sort()) !== stableJsonStringify([...iteration.failedCategories].sort())) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.review.failedCategories`, "does not match the iteration ledger's failed categories.");
      const evidence = arrayValue(failedReview.evidence, `${path}.review.evidence`, failedCategories.length, 256).map((entry, evidenceIndex) => {
        const evidencePath = `${path}.review.evidence[${evidenceIndex}]`, item = closed(entry, evidencePath, ["category", "endSeconds", "observation", "startSeconds"]), startSeconds = finiteNumber(item.startSeconds, `${evidencePath}.startSeconds`, 0, duration), endSeconds = finiteNumber(item.endSeconds, `${evidencePath}.endSeconds`, 0, duration);
        if (endSeconds <= startSeconds) fail("CUT_REVIEW_FAILED_ITERATION", evidencePath, "requires a positive timed review interval.");
        return { category: enumValue(item.category, `${evidencePath}.category`, professionalOutputCategoryIds), observation: textValue(item.observation, `${evidencePath}.observation`, 2000) };
      });
      if (failedCategories.some((category) => !evidence.some((item) => item.category === category))) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.review.evidence`, "must timecode at least one concrete observation for every failed category.");
      if (textValue(failedReview.summary, `${path}.review.summary`, 4000) !== iteration.summary) fail("CUT_REVIEW_FAILED_ITERATION", `${path}.review.summary`, "does not match the iteration ledger summary.");
    } catch (error) {
      if (error instanceof CutProfessionalOutputReviewError) throw error;
      fail("CUT_REVIEW_FAILED_ITERATION", path, `failed-iteration executable verification failed: ${boundedError(error)}`);
    }
  }
}

export async function reviewProfessionalOutputFile(path: string): Promise<ProfessionalOutputReviewReport> {
  const absolute = resolve(path), metadata = await lstat(absolute).catch(() => undefined);
  if (!metadata) fail("CUT_REVIEW_FILE_MISSING", basename(path), "review file does not exist.");
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail("CUT_REVIEW_FILE", basename(path), "review input must be a regular, non-symlink file.");
  if (metadata.size > defaultJsonLimits.maxInputBytes) fail("CUT_REVIEW_JSON_LIMIT", "$input", `exceeds ${defaultJsonLimits.maxInputBytes} UTF-8 bytes.`);
  const review = loadProfessionalOutputReview(await readFile(absolute));
  const reviewRoot = await realpath(dirname(absolute)), declaredArtifacts = allHashedArtifacts(review);
  let integrity = await verifyReviewArtifacts(reviewRoot, declaredArtifacts.map((entry) => entry.artifact));
  await verifyArtifactRoleIsolation(reviewRoot, declaredArtifacts);
  await verifyHumanEvidenceFloors(reviewRoot, review);
  const executable = await verifyExecutableArtifactBinding(reviewRoot, review);
  const render = await verifyRenderManifestBinding(reviewRoot, review, executable);
  const fresh = await authenticateFreshCurrentRuntimeRender(review, executable, render);
  const technicalArtifacts = await verifyTechnicalEvidenceRecords(reviewRoot, review, executable, render);
  await verifyFailedIterationBindings(reviewRoot, review, executable);
  const completeArtifacts = [...declaredArtifacts, ...render.dynamicArtifacts, ...technicalArtifacts];
  if (completeArtifacts.length > 1_024) fail("CUT_REVIEW_LIMIT", "$", "dynamic and declared evidence exceeds 1,024 artifacts.");
  integrity = await verifyReviewArtifacts(reviewRoot, completeArtifacts.map((entry) => entry.artifact));
  await verifyArtifactRoleIsolation(reviewRoot, completeArtifacts);
  const evaluated = semanticGates(review, integrity, render, fresh), passed = evaluated.categories.every((category) => category.status === "pass") && evaluated.gates.every((item) => item.status === "pass");
  const status: ReviewDecision = passed ? "pass" : "revise";
  if (review.decision !== status) fail("CUT_REVIEW_DECISION", "$.decision", `declares ${review.decision}, but deterministic gate evaluation requires ${status}.`);
  const categoriesPassed = evaluated.categories.filter((category) => category.status === "pass").length;
  const gatesPassed = evaluated.gates.filter((item) => item.status === "pass").length;
  return {
    format: "cut-professional-output-review-report",
    version: 1,
    command: "review",
    status,
    review: basename(absolute),
    artifact: { kind: review.artifact.kind, title: review.artifact.title, iterationId: review.artifact.iterationId, durationSeconds: review.artifact.durationSeconds, outputSha256: review.artifact.output.sha256 },
    threshold: { categoryMinimum: professionalOutputMinimumScore, averaging: "forbidden" },
    categories: evaluated.categories,
    gates: evaluated.gates,
    integrity,
    summary: { categoriesPassed, categoriesTotal: evaluated.categories.length, gatesPassed, gatesTotal: evaluated.gates.length, hardFailures: review.hardFailures.length },
    assurance: {
      automatedTasteAssessment: false,
      machineEvidenceStatus: "verified",
      humanAttestationStatus: "accepted-unverified",
      rightsAttestationStatus: "accepted-unverified",
      referenceIdentityStatus: "accepted-unverified",
      frameDefectAttestationStatus: "accepted-unverified",
      freshRenderAuthentication: fresh,
      statement: "CUT freshly renders and machine-verifies the declared execution evidence, but it does not authenticate reviewer identity, rights ownership, public-reference identity, frame-defect attestations, or creative taste; those remain accepted unverified human/legal claims.",
    },
  };
}
