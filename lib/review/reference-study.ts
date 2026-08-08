import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { isReferencePictureMediaToolchainIdentity } from "../runtime/reference/picture-media-toolchain";
import {
  CutProfessionalOutputReviewError,
  type HashedArtifact,
  parseStrictReviewJson,
  verifyReviewArtifacts,
} from "./professional-output";
import { verifyReferenceStemEvidence } from "./reference-stem-evidence";

export const referenceStudyReviewFormat = "cut-reference-study-review" as const;
export const referenceStudyReviewVersion = 1 as const;

type Decision = "pass" | "revise";
type EvidenceStatus = "pass" | "fail" | "not-applicable";
type TimedEvidence = { startSeconds: number; endSeconds: number; observation: string };
type EvidenceGate = { status: EvidenceStatus; artifact: HashedArtifact };

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

const hardFailureCodes = [
  "SLIDESHOW_GRAMMAR",
  "WEAK_SPATIAL_CONTINUITY",
  "UNMOTIVATED_MOTION",
  "PRIMITIVE_MOTION",
  "ILLEGIBLE_TYPOGRAPHY",
  "WEAK_SOUND",
  "TECHNICAL_GLITCH",
  "MISSING_PATTERN_PROOF",
  "RIGHTS_OR_PROVENANCE",
  "HIDDEN_POSTPROCESSING",
  "INCOMPLETE_REVIEW",
  "REFERENCE_COPYING",
] as const;

type HardFailureCode = typeof hardFailureCodes[number];

export type ReferenceStudyReview = {
  format: typeof referenceStudyReviewFormat;
  version: typeof referenceStudyReviewVersion;
  decision: Decision;
  artifact: {
    kind: "reference-study";
    studyId: string;
    iterationId: string;
    title: string;
    durationSeconds: number;
    audioPresent: boolean;
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
  pattern: {
    grammar: string;
    requirements: Array<{
      id: string;
      description: string;
      status: Decision;
      evidence: TimedEvidence[];
    }>;
  };
  playbackReview: {
    reviewerId: string;
    reviewerName: string;
    reviewerType: "human";
    reviewedAt: string;
    fullStudy: boolean;
    fullSpeedPlayback: boolean;
    audioReview: "headphones-complete" | "not-applicable-silent" | "missing";
    display: string;
    audioDevice: string;
    notes: HashedArtifact;
  };
  hardFailures: Array<{
    code: HardFailureCode;
    evidence: string;
    startSeconds: number;
    endSeconds: number;
  }>;
  technicalEvidence: Record<typeof technicalEvidenceIds[number], EvidenceGate>;
  iterationHistory: {
    complete: boolean;
    priorFailedIterations: Array<{
      id: string;
      retained: boolean;
      source: HashedArtifact;
      lock: HashedArtifact;
      output: HashedArtifact;
      renderManifest: HashedArtifact;
      review: HashedArtifact;
      summary: string;
    }>;
  };
};

function fail(code: string, path: string, message: string): never {
  throw new CutProfessionalOutputReviewError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CUT_STUDY_REVIEW_TYPE", path, "must be a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("CUT_STUDY_REVIEW_TYPE", path, "must be a plain object.");
  return value as Record<string, unknown>;
}

function closed(value: unknown, path: string, fields: readonly string[]) {
  const item = record(value, path), allowed = new Set(fields);
  for (const field of fields) if (!Object.hasOwn(item, field)) fail("CUT_STUDY_REVIEW_MISSING_FIELD", path, `is missing required field ${JSON.stringify(field)}.`);
  for (const field of Object.keys(item)) if (!allowed.has(field)) fail("CUT_STUDY_REVIEW_UNKNOWN_FIELD", `${path}.${field}`, "is not part of reference-study review v1.");
  return item;
}

function text(value: unknown, path: string, maximum = 4096) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) fail("CUT_STUDY_REVIEW_TYPE", path, `must be non-empty text no longer than ${maximum} UTF-8 bytes without NUL.`);
  return value;
}

function id(value: unknown, path: string) {
  const result = text(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) fail("CUT_STUDY_REVIEW_IDENTIFIER", path, "must be a stable ASCII identifier.");
  return result;
}

function bool(value: unknown, path: string) {
  if (typeof value !== "boolean") fail("CUT_STUDY_REVIEW_TYPE", path, "must be boolean.");
  return value;
}

function number(value: unknown, path: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail("CUT_STUDY_REVIEW_RANGE", path, `must be a finite number from ${minimum} through ${maximum}.`);
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail("CUT_STUDY_REVIEW_ENUM", path, `must be one of ${values.join(", ")}.`);
  return value as T;
}

function array(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail("CUT_STUDY_REVIEW_RANGE", path, `must contain from ${minimum} through ${maximum} items.`);
  return value;
}

function relativePath(value: unknown, path: string) {
  const result = text(value, path, 1024);
  if (result.startsWith("/") || /^[A-Za-z]:/u.test(result) || /[\\%?#]/u.test(result)) fail("CUT_STUDY_REVIEW_PATH", path, "must be a plain POSIX path relative to the review file.");
  const segments = result.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || ["__proto__", "prototype", "constructor"].includes(segment))) fail("CUT_STUDY_REVIEW_PATH", path, "contains an empty, dot, parent, or unsafe segment.");
  return result;
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("CUT_STUDY_REVIEW_HASH", path, "must be a lowercase SHA-256 digest.");
  return value;
}

function artifact(value: unknown, path: string): HashedArtifact {
  const item = closed(value, path, ["path", "sha256"]);
  return { path: relativePath(item.path, `${path}.path`), sha256: digest(item.sha256, `${path}.sha256`) };
}

function utc(value: unknown, path: string) {
  const result = text(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) fail("CUT_STUDY_REVIEW_DATE", path, "must be a valid UTC RFC 3339 timestamp.");
  return result;
}

function timedEvidence(value: unknown, path: string, duration: number): TimedEvidence {
  const item = closed(value, path, ["startSeconds", "endSeconds", "observation"]);
  const startSeconds = number(item.startSeconds, `${path}.startSeconds`, 0, duration);
  const endSeconds = number(item.endSeconds, `${path}.endSeconds`, 0, duration);
  if (endSeconds <= startSeconds) fail("CUT_STUDY_REVIEW_TIME_RANGE", path, "requires endSeconds greater than startSeconds.");
  return { startSeconds, endSeconds, observation: text(item.observation, `${path}.observation`, 2000) };
}

function expectSuffix(item: HashedArtifact, suffix: RegExp, path: string) {
  if (!suffix.test(item.path)) fail("CUT_STUDY_REVIEW_PATH", path, `has the wrong artifact suffix: ${item.path}.`);
  return item;
}

function canonical<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

export function validateReferenceStudyReview(value: unknown): ReferenceStudyReview {
  const root = closed(value, "$", ["format", "version", "decision", "artifact", "authoringBoundary", "pattern", "playbackReview", "hardFailures", "technicalEvidence", "iterationHistory"]);
  if (root.format !== referenceStudyReviewFormat || root.version !== referenceStudyReviewVersion) fail("CUT_STUDY_REVIEW_VERSION", "$", `requires ${referenceStudyReviewFormat} version ${referenceStudyReviewVersion}.`);

  const rawArtifact = closed(root.artifact, "$.artifact", ["kind", "studyId", "iterationId", "title", "durationSeconds", "audioPresent", "source", "lock", "ir", "output", "renderManifest"]);
  const durationSeconds = number(rawArtifact.durationSeconds, "$.artifact.durationSeconds", 1, 120);
  const studyArtifact = {
    kind: oneOf(rawArtifact.kind, "$.artifact.kind", ["reference-study"]),
    studyId: id(rawArtifact.studyId, "$.artifact.studyId"),
    iterationId: id(rawArtifact.iterationId, "$.artifact.iterationId"),
    title: text(rawArtifact.title, "$.artifact.title", 512),
    durationSeconds,
    audioPresent: bool(rawArtifact.audioPresent, "$.artifact.audioPresent"),
    source: expectSuffix(artifact(rawArtifact.source, "$.artifact.source"), /\.cut$/u, "$.artifact.source.path"),
    lock: expectSuffix(artifact(rawArtifact.lock, "$.artifact.lock"), /\.lock$/u, "$.artifact.lock.path"),
    ir: expectSuffix(artifact(rawArtifact.ir, "$.artifact.ir"), /\.cutir\.json$/u, "$.artifact.ir.path"),
    output: expectSuffix(artifact(rawArtifact.output, "$.artifact.output"), /\.(?:mp4|mov|mkv|webm)$/u, "$.artifact.output.path"),
    renderManifest: expectSuffix(artifact(rawArtifact.renderManifest, "$.artifact.renderManifest"), /\.manifest\.json$/u, "$.artifact.renderManifest.path"),
  };

  const boundaryFields = ["publicCutSource", "publicPackagesOnly", "publicCliOnly", "allProjectSpecificCreativeAndTemporalIntentInCut", "noAfterEffectsOrPremiere", "noBespokeHiddenCompositor", "noProjectNameBranch", "noManualFrameReplacement", "noCreativePostFixAfterRender", "ffmpegRole"] as const;
  const rawBoundary = closed(root.authoringBoundary, "$.authoringBoundary", boundaryFields);
  const authoringBoundary = {
    publicCutSource: bool(rawBoundary.publicCutSource, "$.authoringBoundary.publicCutSource"),
    publicPackagesOnly: bool(rawBoundary.publicPackagesOnly, "$.authoringBoundary.publicPackagesOnly"),
    publicCliOnly: bool(rawBoundary.publicCliOnly, "$.authoringBoundary.publicCliOnly"),
    allProjectSpecificCreativeAndTemporalIntentInCut: bool(rawBoundary.allProjectSpecificCreativeAndTemporalIntentInCut, "$.authoringBoundary.allProjectSpecificCreativeAndTemporalIntentInCut"),
    noAfterEffectsOrPremiere: bool(rawBoundary.noAfterEffectsOrPremiere, "$.authoringBoundary.noAfterEffectsOrPremiere"),
    noBespokeHiddenCompositor: bool(rawBoundary.noBespokeHiddenCompositor, "$.authoringBoundary.noBespokeHiddenCompositor"),
    noProjectNameBranch: bool(rawBoundary.noProjectNameBranch, "$.authoringBoundary.noProjectNameBranch"),
    noManualFrameReplacement: bool(rawBoundary.noManualFrameReplacement, "$.authoringBoundary.noManualFrameReplacement"),
    noCreativePostFixAfterRender: bool(rawBoundary.noCreativePostFixAfterRender, "$.authoringBoundary.noCreativePostFixAfterRender"),
    ffmpegRole: oneOf(rawBoundary.ffmpegRole, "$.authoringBoundary.ffmpegRole", ["codec-and-low-level-media-only"]),
  };

  const rawPattern = closed(root.pattern, "$.pattern", ["grammar", "requirements"]);
  const requirements = array(rawPattern.requirements, "$.pattern.requirements", 2, 24).map((entry, index) => {
    const path = `$.pattern.requirements[${index}]`, item = closed(entry, path, ["id", "description", "status", "evidence"]);
    const evidence = array(item.evidence, `${path}.evidence`, 2, 24).map((observation, evidenceIndex) => timedEvidence(observation, `${path}.evidence[${evidenceIndex}]`, durationSeconds));
    return { id: id(item.id, `${path}.id`), description: text(item.description, `${path}.description`, 2000), status: oneOf(item.status, `${path}.status`, ["pass", "revise"]), evidence };
  });
  if (new Set(requirements.map((item) => item.id)).size !== requirements.length) fail("CUT_STUDY_REVIEW_DUPLICATE", "$.pattern.requirements[].id", "must not contain duplicate requirement identifiers.");

  const rawPlayback = closed(root.playbackReview, "$.playbackReview", ["reviewerId", "reviewerName", "reviewerType", "reviewedAt", "fullStudy", "fullSpeedPlayback", "audioReview", "display", "audioDevice", "notes"]);
  const playbackReview = {
    reviewerId: id(rawPlayback.reviewerId, "$.playbackReview.reviewerId"),
    reviewerName: text(rawPlayback.reviewerName, "$.playbackReview.reviewerName", 256),
    reviewerType: oneOf(rawPlayback.reviewerType, "$.playbackReview.reviewerType", ["human"]),
    reviewedAt: utc(rawPlayback.reviewedAt, "$.playbackReview.reviewedAt"),
    fullStudy: bool(rawPlayback.fullStudy, "$.playbackReview.fullStudy"),
    fullSpeedPlayback: bool(rawPlayback.fullSpeedPlayback, "$.playbackReview.fullSpeedPlayback"),
    audioReview: oneOf(rawPlayback.audioReview, "$.playbackReview.audioReview", ["headphones-complete", "not-applicable-silent", "missing"]),
    display: text(rawPlayback.display, "$.playbackReview.display", 512),
    audioDevice: text(rawPlayback.audioDevice, "$.playbackReview.audioDevice", 512),
    notes: artifact(rawPlayback.notes, "$.playbackReview.notes"),
  };

  const hardFailures = array(root.hardFailures, "$.hardFailures", 0, 64).map((entry, index) => {
    const path = `$.hardFailures[${index}]`, item = closed(entry, path, ["code", "evidence", "startSeconds", "endSeconds"]);
    const range = timedEvidence({ startSeconds: item.startSeconds, endSeconds: item.endSeconds, observation: item.evidence }, path, durationSeconds);
    return { code: oneOf(item.code, `${path}.code`, hardFailureCodes), evidence: range.observation, startSeconds: range.startSeconds, endSeconds: range.endSeconds };
  });

  const rawTechnical = closed(root.technicalEvidence, "$.technicalEvidence", technicalEvidenceIds);
  const technicalEvidence = Object.fromEntries(technicalEvidenceIds.map((key) => {
    const path = `$.technicalEvidence.${key}`, item = closed(rawTechnical[key], path, ["status", "artifact"]);
    return [key, { status: oneOf(item.status, `${path}.status`, ["pass", "fail", "not-applicable"]), artifact: artifact(item.artifact, `${path}.artifact`) }];
  })) as ReferenceStudyReview["technicalEvidence"];
  if (technicalEvidence.renderManifest.artifact.path !== studyArtifact.renderManifest.path
    || technicalEvidence.renderManifest.artifact.sha256 !== studyArtifact.renderManifest.sha256) {
    fail("CUT_STUDY_REVIEW_EVIDENCE_BINDING", "$.technicalEvidence.renderManifest.artifact", "must identify the exact selected render manifest.");
  }

  const rawHistory = closed(root.iterationHistory, "$.iterationHistory", ["complete", "priorFailedIterations"]);
  const priorFailedIterations = array(rawHistory.priorFailedIterations, "$.iterationHistory.priorFailedIterations", 0, 64).map((entry, index) => {
    const path = `$.iterationHistory.priorFailedIterations[${index}]`, item = closed(entry, path, ["id", "retained", "source", "lock", "output", "renderManifest", "review", "summary"]);
    return {
      id: id(item.id, `${path}.id`), retained: bool(item.retained, `${path}.retained`),
      source: artifact(item.source, `${path}.source`), lock: artifact(item.lock, `${path}.lock`), output: artifact(item.output, `${path}.output`),
      renderManifest: artifact(item.renderManifest, `${path}.renderManifest`), review: artifact(item.review, `${path}.review`), summary: text(item.summary, `${path}.summary`, 4000),
    };
  });
  if (new Set(priorFailedIterations.map((item) => item.id)).size !== priorFailedIterations.length) fail("CUT_STUDY_REVIEW_DUPLICATE", "$.iterationHistory.priorFailedIterations[].id", "must not contain duplicate iteration identifiers.");
  if (priorFailedIterations.some((item) => item.id === studyArtifact.iterationId)) fail("CUT_STUDY_REVIEW_ITERATION", "$.iterationHistory", "the selected iteration cannot also be a failed iteration.");

  return deepFreeze(canonical({
    format: referenceStudyReviewFormat,
    version: referenceStudyReviewVersion,
    decision: oneOf(root.decision, "$.decision", ["pass", "revise"]),
    artifact: studyArtifact,
    authoringBoundary,
    pattern: { grammar: text(rawPattern.grammar, "$.pattern.grammar", 2000), requirements },
    playbackReview,
    hardFailures,
    technicalEvidence,
    iterationHistory: { complete: bool(rawHistory.complete, "$.iterationHistory.complete"), priorFailedIterations },
  }));
}

export function loadReferenceStudyReview(input: string | Uint8Array) {
  return validateReferenceStudyReview(parseStrictReviewJson(input));
}

type ReviewGate = { id: string; status: "pass" | "fail"; detail: string };
export type ReferenceStudyReviewReport = {
  format: "cut-reference-study-review-report";
  version: 1;
  command: "review-study";
  status: Decision;
  review: string;
  artifact: { studyId: string; iterationId: string; title: string; durationSeconds: number; audioPresent: boolean; outputSha256: string };
  requirements: Array<{ id: string; status: "pass" | "fail"; evidenceItems: number }>;
  gates: ReviewGate[];
  integrity: { files: number; bytes: number };
  summary: { requirementsPassed: number; requirementsTotal: number; gatesPassed: number; gatesTotal: number; hardFailures: number };
  assurance: { automatedTasteAssessment: false; statement: string };
};

function gate(id: string, passed: boolean, detail: string): ReviewGate {
  return { id, status: passed ? "pass" : "fail", detail };
}

function allArtifacts(review: ReferenceStudyReview) {
  const artifacts = [
    review.artifact.source, review.artifact.lock, review.artifact.ir, review.artifact.output, review.artifact.renderManifest,
    review.playbackReview.notes,
    ...technicalEvidenceIds.map((key) => review.technicalEvidence[key].artifact),
    ...review.iterationHistory.priorFailedIterations.flatMap((item) => [item.source, item.lock, item.output, item.renderManifest, item.review]),
  ];
  const unique = new Map<string, HashedArtifact>();
  for (const item of artifacts) {
    const previous = unique.get(item.path);
    if (previous && previous.sha256 !== item.sha256) fail("CUT_STUDY_REVIEW_INTEGRITY", item.path, "is declared with conflicting SHA-256 digests.");
    unique.set(item.path, item);
  }
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyManifest(root: string, review: ReferenceStudyReview) {
  const manifestPath = resolve(root, ...review.artifact.renderManifest.path.split("/"));
  const bytes = await readFile(manifestPath), value = parseStrictReviewJson(bytes), manifest = record(value, "$.artifact.renderManifest");
  if (manifest.format !== "cut-reference-render") fail("CUT_STUDY_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest", "must be a cut-reference-render manifest.");
  if (manifest.version !== 11) fail("CUT_STUDY_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.version", "must be lock, stem and picture-toolchain-bound render-manifest v11.");
  if (!isReferencePictureMediaToolchainIdentity(manifest.pictureToolchain)) fail("CUT_STUDY_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.pictureToolchain", "must bind one exact FFmpeg and FFprobe picture toolchain identity.");
  const manifestLock = closed(manifest.lock, "$.artifact.renderManifest.lock", ["sha256"]);
  if (digest(manifestLock.sha256, "$.artifact.renderManifest.lock.sha256") !== review.artifact.lock.sha256) fail("CUT_STUDY_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.lock.sha256", "does not bind the selected cut.lock SHA-256.");
  if (manifest.sha256 !== review.artifact.output.sha256) fail("CUT_STUDY_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.sha256", "does not bind the selected output SHA-256.");
  if (manifest.output !== basename(review.artifact.output.path)) fail("CUT_STUDY_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.output", "does not name the selected output file.");
  if (typeof manifest.duration !== "number" || Math.abs(manifest.duration - review.artifact.durationSeconds) > 1e-9) fail("CUT_STUDY_REVIEW_RENDER_MANIFEST", "$.artifact.renderManifest.duration", "does not match the selected study duration.");
  if (manifest.stems !== undefined) {
    const renderAudio = record(manifest.audio, "$.artifact.renderManifest.audio");
    await verifyReferenceStemEvidence({
      reviewRoot: root,
      renderManifestPath: manifestPath,
      value: manifest.stems,
      expectedLockSha256: manifestLock.sha256 as string,
      expectedRuntime: manifest.runtime,
      expectedExecutionBuildId: manifest.executionBuildId,
      expectedDurationSeconds: manifest.duration,
      expectedSampleRate: renderAudio.sampleRate,
      diagnosticPath: "$.artifact.renderManifest.stems",
      parseJson: parseStrictReviewJson,
      verifyArtifacts: verifyReviewArtifacts,
      fail: (sourcePath, message) => fail("CUT_STUDY_REVIEW_RENDER_MANIFEST", sourcePath, message),
    });
  }
}

export async function reviewReferenceStudyFile(path: string): Promise<ReferenceStudyReviewReport> {
  const absolute = resolve(path), metadata = await lstat(absolute).catch(() => undefined);
  if (!metadata) fail("CUT_STUDY_REVIEW_FILE_MISSING", basename(path), "review file does not exist.");
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail("CUT_STUDY_REVIEW_FILE", basename(path), "review input must be a regular, non-symlink file.");
  if (metadata.size > 2 * 1024 * 1024) fail("CUT_STUDY_REVIEW_JSON_LIMIT", "$input", "exceeds 2097152 UTF-8 bytes.");
  const review = loadReferenceStudyReview(await readFile(absolute)), root = await realpath(dirname(absolute));
  const integrity = await verifyReviewArtifacts(root, allArtifacts(review));
  await verifyManifest(root, review);

  const requirements = review.pattern.requirements.map((item) => ({ id: item.id, status: item.status === "pass" ? "pass" as const : "fail" as const, evidenceItems: item.evidence.length }));
  const boundary = Object.entries(review.authoringBoundary).filter(([key]) => key !== "ffmpegRole").map(([, value]) => value);
  const technical = technicalEvidenceIds.filter((key) => key !== "audioDelivery").every((key) => review.technicalEvidence[key].status === "pass");
  const audioGate = review.artifact.audioPresent
    ? review.playbackReview.audioReview === "headphones-complete" && review.technicalEvidence.audioDelivery.status === "pass"
    : review.playbackReview.audioReview === "not-applicable-silent" && review.technicalEvidence.audioDelivery.status === "not-applicable";
  const gates = [
    gate("pattern-requirements", requirements.every((item) => item.status === "pass"), "every preregistered pattern requirement has at least two timecoded human observations and passes conjunctively"),
    gate("full-speed-playback", review.playbackReview.reviewerType === "human" && review.playbackReview.fullStudy && review.playbackReview.fullSpeedPlayback, "a named human attests a complete full-speed viewing"),
    gate("headphone-listening", audioGate, "audio studies require a complete headphone listen and passing audio-delivery evidence; silent studies must declare both not applicable"),
    gate("hard-failures", review.hardFailures.length === 0, "no slideshow, spatial, motion, type, sound, technical, pattern, rights, hidden-post, incomplete-review, or copying hard failure remains"),
    gate("technical-evidence", technical, "source check/test, render manifest, replay, frame scan, rights and canonical-boundary evidence all pass"),
    gate("public-authoring-boundary", boundary.every((value) => value === true) && review.authoringBoundary.ffmpegRole === "codec-and-low-level-media-only", "all project-specific creative and temporal intent stays in public CUT source/packages/CLI"),
    gate("failed-iteration-preservation", review.iterationHistory.complete && review.iterationHistory.priorFailedIterations.every((item) => item.retained), "the iteration ledger is complete and every declared failed iteration is retained"),
    gate("artifact-integrity", integrity.files > 0, "every declared source, lock, IR, output, manifest, note and evidence artifact is hash-verified"),
  ];
  const status: Decision = requirements.every((item) => item.status === "pass") && gates.every((item) => item.status === "pass") ? "pass" : "revise";
  if (review.decision !== status) fail("CUT_STUDY_REVIEW_DECISION", "$.decision", `declares ${review.decision}, but deterministic gate evaluation requires ${status}.`);
  return {
    format: "cut-reference-study-review-report",
    version: 1,
    command: "review-study",
    status,
    review: basename(absolute),
    artifact: { studyId: review.artifact.studyId, iterationId: review.artifact.iterationId, title: review.artifact.title, durationSeconds: review.artifact.durationSeconds, audioPresent: review.artifact.audioPresent, outputSha256: review.artifact.output.sha256 },
    requirements,
    gates,
    integrity,
    summary: { requirementsPassed: requirements.filter((item) => item.status === "pass").length, requirementsTotal: requirements.length, gatesPassed: gates.filter((item) => item.status === "pass").length, gatesTotal: gates.length, hardFailures: review.hardFailures.length },
    assurance: { automatedTasteAssessment: false, statement: "CUT validates evidence integrity and preregistered gates; the named human remains responsible for watching, listening, and creative judgment." },
  };
}
