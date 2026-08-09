import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import { compareRational } from "../language/rational";
import {
  cutFootageLimits,
  parseCutFootageSearch,
  validateCutFootageSearchAgainstIndex,
  type CutFootageIndex,
  type CutFootageSearch,
} from "./contracts";
import { footageFail } from "./diagnostics";
import type { CutFootageSidecarCandidate } from "./sidecar";

export const cutFootageSearchDefaults = Object.freeze({ thresholdPpm: 0, limit: 20 });
const maximumRawQueryBytes = 16 * 1024;

function protocol(path: string, reason: string): never {
  return footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", path, reason);
}

/** Canonical v1 query admission: bounded raw UTF-8 followed by exact NFKC and trim. */
export function normalizeCutFootageQuery(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumRawQueryBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    protocol("$.query.text", "must be one bounded control-free string.");
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized.length || Buffer.byteLength(normalized, "utf8") > cutFootageLimits.maximumTextBytes || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    protocol("$.query.text", "must normalize to one bounded non-empty control-free string.");
  }
  return normalized;
}

/** Converts one finite cosine score to stable parts-per-million. */
export function quantizeCutFootageScorePpm(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) protocol("$.candidates.score", "must be one finite cosine score.");
  const quantized = Math.round(Math.max(-1, Math.min(1, value)) * 1_000_000);
  return Object.is(quantized, -0) ? 0 : quantized;
}

function matchId(index: CutFootageIndex, chunk: CutFootageIndex["chunks"][number]) {
  const identity = stableJsonStringify({
    domain: "cut-footage-match-v1",
    indexSha256: index.indexSha256,
    sourceLocator: chunk.sourceLocator,
    sourceSha256: chunk.sourceSha256,
    streamIndex: chunk.streamIndex,
    range: chunk.range,
    chunkIds: [chunk.id],
  });
  return `match-${createHash("sha256").update(identity).digest("hex")}`;
}

function positiveOverlap(
  left: CutFootageIndex["chunks"][number],
  right: CutFootageIndex["chunks"][number],
) {
  return left.sourceLocator === right.sourceLocator && left.sourceSha256 === right.sourceSha256 && left.streamIndex === right.streamIndex
    && compareRational(left.range.start, right.range.end) < 0 && compareRational(right.range.start, left.range.end) < 0;
}

function rankingOrder(
  left: Readonly<{ chunk: CutFootageIndex["chunks"][number]; scorePpm: number }>,
  right: Readonly<{ chunk: CutFootageIndex["chunks"][number]; scorePpm: number }>,
) {
  return right.scorePpm - left.scorePpm
    || left.chunk.sourceLocator.localeCompare(right.chunk.sourceLocator)
    || compareRational(left.chunk.range.start, right.chunk.range.start)
    || compareRational(left.chunk.range.end, right.chunk.range.end)
    || left.chunk.id.localeCompare(right.chunk.id);
}

/** Validates the complete candidate set, quantizes once, ranks, and greedily suppresses overlaps. */
export function rankCutFootageCandidates(
  index: CutFootageIndex,
  candidates: readonly CutFootageSidecarCandidate[],
  options: Readonly<{ thresholdPpm: number; limit: number }>,
): CutFootageSearch["matches"] {
  if (!index || typeof index !== "object" || !Array.isArray(index.chunks) || !Array.isArray(candidates)) protocol("$.candidates", "must bind one footage index and candidate array.");
  if (!options || typeof options !== "object" || !Number.isSafeInteger(options.thresholdPpm)
    || options.thresholdPpm < -1_000_000 || options.thresholdPpm > 1_000_000
    || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > cutFootageLimits.maximumMatches) {
    protocol("$.query", "must contain a valid thresholdPpm and result limit.");
  }
  const chunks = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
  const seen = new Set<string>();
  const scored = candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || typeof candidate.chunkId !== "string" || seen.has(candidate.chunkId)) protocol("$.candidates", "must contain one result for every unique indexed chunk.");
    const chunk = chunks.get(candidate.chunkId);
    if (!chunk) protocol("$.candidates", "contains an unknown chunk ID.");
    seen.add(candidate.chunkId);
    return Object.freeze({ chunk, scorePpm: quantizeCutFootageScorePpm(candidate.score) });
  });
  if (seen.size !== chunks.size || [...chunks.keys()].some((id) => !seen.has(id))) protocol("$.candidates", "must contain the complete indexed chunk set.");

  const admitted = scored.filter((candidate) => candidate.scorePpm >= options.thresholdPpm).sort(rankingOrder);
  const kept: typeof admitted = [];
  for (const candidate of admitted) {
    if (kept.some((previous) => positiveOverlap(previous.chunk, candidate.chunk))) continue;
    kept.push(candidate);
    if (kept.length === options.limit) break;
  }
  const matches = kept.map(({ chunk, scorePpm }) => Object.freeze({
    id: matchId(index, chunk),
    scorePpm,
    chunkIds: Object.freeze([chunk.id]),
    sourceSelection: Object.freeze({
      locator: chunk.sourceLocator,
      sha256: chunk.sourceSha256,
      streamIndex: chunk.streamIndex,
      range: chunk.range,
    }),
  }));
  matches.sort((left, right) => right.scorePpm - left.scorePpm
    || left.sourceSelection.locator.localeCompare(right.sourceSelection.locator)
    || compareRational(left.sourceSelection.range.start, right.sourceSelection.range.start)
    || compareRational(left.sourceSelection.range.end, right.sourceSelection.range.end)
    || left.id.localeCompare(right.id));
  return Object.freeze(matches);
}

/** Constructs, validates, and serializes one canonical LF-terminated search report. */
export function buildCutFootageSearchReport(
  index: CutFootageIndex,
  query: unknown,
  candidates: readonly CutFootageSidecarCandidate[],
  options: Readonly<{ thresholdPpm: number; limit: number }>,
) {
  const body = Object.freeze({
    format: "cut-footage-search" as const,
    version: 1 as const,
    indexSha256: index.indexSha256,
    query: Object.freeze({ text: normalizeCutFootageQuery(query), thresholdPpm: options.thresholdPpm }),
    matches: rankCutFootageCandidates(index, candidates, options),
  });
  const searchSha256 = createHash("sha256").update(stableJsonStringify(body)).digest("hex");
  const bytes = Buffer.from(`${stableJsonStringify({ ...body, searchSha256 })}\n`, "utf8");
  const report = validateCutFootageSearchAgainstIndex(index, parseCutFootageSearch(bytes));
  return Object.freeze({ report, bytes });
}
