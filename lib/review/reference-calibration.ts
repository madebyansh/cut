export const referenceCalibrationFormat = "cut-reference-calibration" as const;
export const referenceCalibrationVersion = 1 as const;
export const referenceCalibrationSemanticReportFormat = "cut-reference-calibration-semantic-report" as const;

export type ReferenceCalibrationSemanticErrorCode =
  | "CUT_REFERENCE_CALIBRATION_TYPE"
  | "CUT_REFERENCE_CALIBRATION_VERSION"
  | "CUT_REFERENCE_CALIBRATION_STATUS"
  | "CUT_REFERENCE_CALIBRATION_IDENTIFIER"
  | "CUT_REFERENCE_CALIBRATION_DUPLICATE"
  | "CUT_REFERENCE_CALIBRATION_REFERENCE"
  | "CUT_REFERENCE_CALIBRATION_RANGE"
  | "CUT_REFERENCE_CALIBRATION_COVERAGE"
  | "CUT_REFERENCE_CALIBRATION_BOUNDARY"
  | "CUT_REFERENCE_CALIBRATION_AUDIO";

export class CutReferenceCalibrationSemanticError extends Error {
  constructor(readonly code: ReferenceCalibrationSemanticErrorCode, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutReferenceCalibrationSemanticError";
  }
}

type CalibrationStatus = "partial" | "complete";
type RecordKind = "beat-proxy" | "shot";

type CorpusEntry = Readonly<{
  id: string;
  durationMs: number;
}>;

type Observation = Readonly<{
  id: string;
  referenceId: string;
  recordKind: RecordKind;
  shotClaim: boolean;
  startMs: number;
  endMs: number;
  durationMs: number;
}>;

const audioKinds = ["narration", "music", "ambience", "sfx", "silence"] as const;
type AudioKind = typeof audioKinds[number];

export type ReferenceCalibrationSemanticCoverage = Readonly<{
  referenceId: string;
  durationMs: number;
  recordKind: RecordKind;
  observations: number;
  coveredStartMs: 0;
  coveredEndMs: number;
  firstMinuteCovered: boolean;
  fullFilmCovered: boolean;
}>;

export type ReferenceCalibrationSemanticReport = Readonly<{
  format: typeof referenceCalibrationSemanticReportFormat;
  version: 1;
  status: CalibrationStatus;
  recordKind: RecordKind;
  completeShotLogDeclared: boolean;
  fullFilmShotCoverageDeclared: boolean;
  frameAccurateShotBoundariesDeclared: boolean;
  timecodedAudioEventCoverageDeclared: boolean;
  fullFilmShotCoverageDerived: boolean;
  firstMinuteBeatCoverageDeclared: boolean;
  firstMinuteCoverageDerived: boolean;
  coverage: readonly ReferenceCalibrationSemanticCoverage[];
}>;

function fail(code: ReferenceCalibrationSemanticErrorCode, path: string, message: string): never {
  throw new CutReferenceCalibrationSemanticError(code, path, message);
}

function record(value: unknown, path: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CUT_REFERENCE_CALIBRATION_TYPE", path, "must be a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("CUT_REFERENCE_CALIBRATION_TYPE", path, "must be a plain object.");
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail("CUT_REFERENCE_CALIBRATION_TYPE", path, `must contain from ${minimum} through ${maximum} items.`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("CUT_REFERENCE_CALIBRATION_RANGE", path, `must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function bool(value: unknown, path: string) {
  if (typeof value !== "boolean") fail("CUT_REFERENCE_CALIBRATION_TYPE", path, "must be boolean.");
  return value;
}

function finiteNumber(value: unknown, path: string, minimumExclusive = Number.NEGATIVE_INFINITY) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= minimumExclusive) {
    fail("CUT_REFERENCE_CALIBRATION_RANGE", path, `must be a finite number greater than ${minimumExclusive}.`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    fail("CUT_REFERENCE_CALIBRATION_TYPE", path, `must be one of ${choices.join(", ")}.`);
  }
  return value as T;
}

function identifier(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    fail("CUT_REFERENCE_CALIBRATION_IDENTIFIER", path, "must be a lowercase kebab-case identifier.");
  }
  return value;
}

function frameBoundaryAgreesWithinOneMillisecond(ms: number, frame: number, rateNumerator: number, rateDenominator: number) {
  const left = BigInt(ms) * BigInt(rateNumerator);
  const right = BigInt(frame) * 1_000n * BigInt(rateDenominator);
  const delta = left >= right ? left - right : right - left;
  return delta <= BigInt(rateNumerator);
}

function parseCorpus(value: unknown) {
  const seen = new Set<string>();
  return array(value, "$.corpus", 1, 16).map((raw, index): CorpusEntry => {
    const path = `$.corpus[${index}]`, item = record(raw, path);
    const id = identifier(item.id, `${path}.id`);
    if (seen.has(id)) fail("CUT_REFERENCE_CALIBRATION_DUPLICATE", `${path}.id`, `duplicates corpus id ${JSON.stringify(id)}.`);
    seen.add(id);
    return Object.freeze({ id, durationMs: integer(item.durationMs, `${path}.durationMs`, 1_000, 86_400_000) });
  });
}

function validateCompleteShotWitness(item: Record<string, unknown>, path: string, startMs: number, endMs: number) {
  const boundary = record(item.boundary, `${path}.boundary`);
  if (boundary.status !== "observed" || bool(boundary.frameAccurate, `${path}.boundary.frameAccurate`) !== true) {
    fail("CUT_REFERENCE_CALIBRATION_BOUNDARY", `${path}.boundary`, "complete calibration requires an observed frame-accurate boundary witness.");
  }
  oneOf(boundary.method, `${path}.boundary.method`, ["manual-frame-step", "decoded-frame-index"]);
  oneOf(boundary.inEdge, `${path}.boundary.inEdge`, ["program-start", "hard-cut", "transition-start", "source-continuation"]);
  oneOf(boundary.outEdge, `${path}.boundary.outEdge`, ["program-end", "hard-cut", "transition-end", "source-continuation"]);
  const startFrame = integer(boundary.startFrame, `${path}.boundary.startFrame`, 0, 2_147_483_647);
  const endFrame = integer(boundary.endFrame, `${path}.boundary.endFrame`, 1, 2_147_483_647);
  const rateNumerator = integer(boundary.rateNumerator, `${path}.boundary.rateNumerator`, 1, 1_000_000);
  const rateDenominator = integer(boundary.rateDenominator, `${path}.boundary.rateDenominator`, 1, 1_000_000);
  if (endFrame <= startFrame) {
    fail("CUT_REFERENCE_CALIBRATION_BOUNDARY", `${path}.boundary`, `requires endFrame > startFrame; received ${startFrame}..<${endFrame}.`);
  }
  if (!frameBoundaryAgreesWithinOneMillisecond(startMs, startFrame, rateNumerator, rateDenominator)
    || !frameBoundaryAgreesWithinOneMillisecond(endMs, endFrame, rateNumerator, rateDenominator)) {
    fail(
      "CUT_REFERENCE_CALIBRATION_BOUNDARY",
      `${path}.boundary`,
      `frame indices at ${rateNumerator}/${rateDenominator} fps must agree with the millisecond range within 1ms; received ${startFrame}..<${endFrame} for ${startMs}..<${endMs}ms.`,
    );
  }

  const audio = record(item.audio, `${path}.audio`);
  const evidence = record(item.audioEvidence, `${path}.audioEvidence`);
  const inventory = record(evidence.inventory, `${path}.audioEvidence.inventory`);
  const presence = new Map<AudioKind, "present" | "absent">();
  for (const kind of audioKinds) {
    presence.set(kind, oneOf(inventory[kind], `${path}.audioEvidence.inventory.${kind}`, ["present", "absent"]));
  }
  const witnessedKinds = new Set<AudioKind>();
  for (const [index, rawEvent] of array(evidence.events, `${path}.audioEvidence.events`, 1, 256).entries()) {
    const eventPath = `${path}.audioEvidence.events[${index}]`, event = record(rawEvent, eventPath);
    const kind = oneOf(event.kind, `${eventPath}.kind`, audioKinds);
    const eventStartMs = integer(event.startMs, `${eventPath}.startMs`, 0, 86_400_000);
    const eventEndMs = integer(event.endMs, `${eventPath}.endMs`, 1, 86_400_000);
    const editRelation = oneOf(event.editRelation, `${eventPath}.editRelation`, ["prelap", "postlap", "under", "at-cut", "bridge", "independent", "intentional-silence"]);
    if (eventEndMs <= eventStartMs || eventStartMs >= endMs || eventEndMs <= startMs) {
      fail("CUT_REFERENCE_CALIBRATION_AUDIO", eventPath, `must be a non-empty event intersecting shot range ${startMs}..<${endMs}ms; received ${eventStartMs}..<${eventEndMs}ms.`);
    }
    if (editRelation === "prelap" && !(eventStartMs < startMs && eventEndMs > startMs)) {
      fail("CUT_REFERENCE_CALIBRATION_AUDIO", `${eventPath}.editRelation`, `prelap must cross shot in-edge ${startMs}ms.`);
    }
    if (editRelation === "postlap" && !(eventStartMs < endMs && eventEndMs > endMs)) {
      fail("CUT_REFERENCE_CALIBRATION_AUDIO", `${eventPath}.editRelation`, `postlap must cross shot out-edge ${endMs}ms.`);
    }
    if (editRelation === "at-cut" && !(eventStartMs <= startMs && eventEndMs > startMs) && !(eventStartMs < endMs && eventEndMs >= endMs)) {
      fail("CUT_REFERENCE_CALIBRATION_AUDIO", `${eventPath}.editRelation`, "at-cut must intersect the shot in-edge or out-edge.");
    }
    if ((kind === "silence") !== (editRelation === "intentional-silence")) {
      fail("CUT_REFERENCE_CALIBRATION_AUDIO", `${eventPath}.editRelation`, "silence events and intentional-silence relation must be used together.");
    }
    if (presence.get(kind) !== "present") {
      fail("CUT_REFERENCE_CALIBRATION_AUDIO", `${path}.audioEvidence.inventory.${kind}`, `declares ${presence.get(kind)} but ${eventPath} records a ${kind} event.`);
    }
    witnessedKinds.add(kind);
  }
  for (const [kind, state] of presence) {
    if (state === "present" && !witnessedKinds.has(kind)) {
      fail("CUT_REFERENCE_CALIBRATION_AUDIO", `${path}.audioEvidence.inventory.${kind}`, "declares present without a timecoded event.");
    }
  }
  if (presence.get("narration") === "present") {
    integer(audio.narrationWords, `${path}.audio.narrationWords`, 1, 100_000);
    finiteNumber(audio.narrationCadenceWpm, `${path}.audio.narrationCadenceWpm`, 0);
  } else if (audio.narrationWords !== 0 || audio.narrationCadenceWpm !== null) {
    fail("CUT_REFERENCE_CALIBRATION_AUDIO", `${path}.audio`, "absent narration requires narrationWords 0 and narrationCadenceWpm null.");
  }
}

function parseObservations(value: unknown, corpus: readonly CorpusEntry[], requireCompleteWitnesses: boolean) {
  const references = new Set(corpus.map((entry) => entry.id)), seen = new Set<string>();
  return array(value, "$.observations", 1, 4_096).map((raw, index): Observation => {
    const path = `$.observations[${index}]`, item = record(raw, path);
    const id = identifier(item.id, `${path}.id`), referenceId = identifier(item.referenceId, `${path}.referenceId`);
    if (seen.has(id)) fail("CUT_REFERENCE_CALIBRATION_DUPLICATE", `${path}.id`, `duplicates observation id ${JSON.stringify(id)}.`);
    seen.add(id);
    if (!references.has(referenceId)) fail("CUT_REFERENCE_CALIBRATION_REFERENCE", `${path}.referenceId`, `does not name a corpus entry: ${referenceId}.`);
    const startMs = integer(item.startMs, `${path}.startMs`, 0, 86_400_000);
    const endMs = integer(item.endMs, `${path}.endMs`, 1, 86_400_000);
    const durationMs = integer(item.durationMs, `${path}.durationMs`, 1, 86_400_000);
    if (endMs <= startMs || endMs - startMs !== durationMs) {
      fail("CUT_REFERENCE_CALIBRATION_RANGE", path, `requires endMs > startMs and durationMs === endMs - startMs; received ${startMs}..<${endMs} with duration ${durationMs}.`);
    }
    if (requireCompleteWitnesses) validateCompleteShotWitness(item, path, startMs, endMs);
    return Object.freeze({
      id,
      referenceId,
      recordKind: oneOf(item.recordKind, `${path}.recordKind`, ["beat-proxy", "shot"]),
      shotClaim: bool(item.shotClaim, `${path}.shotClaim`),
      startMs,
      endMs,
      durationMs,
    });
  });
}

function coverageFor(reference: CorpusEntry, rows: readonly Observation[], expectedKind: RecordKind) {
  if (rows.length === 0) fail("CUT_REFERENCE_CALIBRATION_COVERAGE", `$.observations[referenceId=${reference.id}]`, "must contain at least one observation.");
  const sorted = [...rows].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id));
  let expectedStart = 0;
  for (const row of sorted) {
    if (row.recordKind !== expectedKind || row.shotClaim !== (expectedKind === "shot")) {
      fail("CUT_REFERENCE_CALIBRATION_STATUS", `$.observations[id=${row.id}]`, `${expectedKind} coverage requires recordKind ${expectedKind} and shotClaim ${expectedKind === "shot"}.`);
    }
    if (row.endMs > reference.durationMs) {
      fail("CUT_REFERENCE_CALIBRATION_RANGE", `$.observations[id=${row.id}]`, `ends at ${row.endMs}ms beyond ${reference.id}'s exact ${reference.durationMs}ms duration.`);
    }
    if (row.startMs !== expectedStart) {
      const relation = row.startMs < expectedStart ? "overlaps" : "leaves a gap after";
      fail("CUT_REFERENCE_CALIBRATION_COVERAGE", `$.observations[id=${row.id}].startMs`, `${relation} ${expectedStart}ms for ${reference.id}; received ${row.startMs}ms.`);
    }
    expectedStart = row.endMs;
  }
  const firstMinuteTarget = Math.min(reference.durationMs, 60_000);
  return Object.freeze({
    referenceId: reference.id,
    durationMs: reference.durationMs,
    recordKind: expectedKind,
    observations: sorted.length,
    coveredStartMs: 0 as const,
    coveredEndMs: expectedStart,
    firstMinuteCovered: expectedStart >= firstMinuteTarget,
    fullFilmCovered: expectedStart === reference.durationMs,
  });
}

/**
 * Derive calibration time coverage from the actual corpus durations and
 * observation ranges. JSON Schema closes shape and attestations; this validator
 * closes cross-row continuity so a boolean cannot counterfeit a complete log.
 */
export function validateReferenceCalibrationSemantics(value: unknown): ReferenceCalibrationSemanticReport {
  const root = record(value, "$");
  if (root.format !== referenceCalibrationFormat || root.version !== referenceCalibrationVersion) {
    fail("CUT_REFERENCE_CALIBRATION_VERSION", "$", `requires ${referenceCalibrationFormat} version ${referenceCalibrationVersion}.`);
  }
  const status = oneOf(root.status, "$.status", ["partial", "complete"]), coverageDeclaration = record(root.analysisCoverage, "$.analysisCoverage");
  const recordKind = oneOf(coverageDeclaration.recordKind, "$.analysisCoverage.recordKind", ["beat-proxy", "shot"]);
  const completeShotLogDeclared = bool(coverageDeclaration.completeShotLog, "$.analysisCoverage.completeShotLog");
  const fullFilmShotCoverageDeclared = bool(coverageDeclaration.fullFilmShotCoverage, "$.analysisCoverage.fullFilmShotCoverage");
  const frameAccurateShotBoundariesDeclared = bool(coverageDeclaration.frameAccurateShotBoundaries, "$.analysisCoverage.frameAccurateShotBoundaries");
  const timecodedAudioEventCoverageDeclared = bool(coverageDeclaration.timecodedAudioEventCoverage, "$.analysisCoverage.timecodedAudioEventCoverage");
  const firstMinuteBeatCoverageDeclared = bool(coverageDeclaration.firstMinuteBeatCoverage, "$.analysisCoverage.firstMinuteBeatCoverage");
  const expectedKind: RecordKind = status === "complete" ? "shot" : "beat-proxy";
  if (recordKind !== expectedKind
    || completeShotLogDeclared !== (status === "complete")
    || (status === "complete" && !fullFilmShotCoverageDeclared)
    || (status === "partial" && fullFilmShotCoverageDeclared)
    || frameAccurateShotBoundariesDeclared !== (status === "complete")
    || timecodedAudioEventCoverageDeclared !== (status === "complete")
    || !firstMinuteBeatCoverageDeclared) {
    fail("CUT_REFERENCE_CALIBRATION_STATUS", "$.analysisCoverage", `${status} requires recordKind ${expectedKind}, completeShotLog/fullFilmShotCoverage/frameAccurateShotBoundaries/timecodedAudioEventCoverage ${status === "complete"}, and firstMinuteBeatCoverage true.`);
  }

  const corpus = parseCorpus(root.corpus), observations = parseObservations(root.observations, corpus, status === "complete");
  const coverage = Object.freeze(corpus.map((reference) => coverageFor(reference, observations.filter((row) => row.referenceId === reference.id), expectedKind)));
  const firstMinuteCoverageDerived = coverage.every((entry) => entry.firstMinuteCovered);
  const fullFilmShotCoverageDerived = recordKind === "shot" && coverage.every((entry) => entry.fullFilmCovered);
  if (!firstMinuteCoverageDerived) {
    const missing = coverage.filter((entry) => !entry.firstMinuteCovered).map((entry) => entry.referenceId).join(", ");
    fail("CUT_REFERENCE_CALIBRATION_COVERAGE", "$.observations", `does not provide contiguous first-minute coverage for: ${missing}.`);
  }
  if (fullFilmShotCoverageDeclared !== fullFilmShotCoverageDerived) {
    const incomplete = coverage.filter((entry) => !entry.fullFilmCovered).map((entry) => `${entry.referenceId}=${entry.coveredEndMs}/${entry.durationMs}ms`).join(", ");
    fail("CUT_REFERENCE_CALIBRATION_COVERAGE", "$.analysisCoverage.fullFilmShotCoverage", `declares ${fullFilmShotCoverageDeclared} but exact contiguous ranges derive ${fullFilmShotCoverageDerived}${incomplete ? ` (${incomplete})` : ""}.`);
  }

  return Object.freeze({
    format: referenceCalibrationSemanticReportFormat,
    version: 1 as const,
    status,
    recordKind,
    completeShotLogDeclared,
    fullFilmShotCoverageDeclared,
    frameAccurateShotBoundariesDeclared,
    timecodedAudioEventCoverageDeclared,
    fullFilmShotCoverageDerived,
    firstMinuteBeatCoverageDeclared,
    firstMinuteCoverageDerived,
    coverage,
  });
}
