import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { compareRational } from "../language/rational";
import { resolveProjectFile, validateProjectLocator } from "../project/manifest";
import { writeProjectArtifacts } from "../project/write-boundary";
import {
  cutFootageLimits,
  loadCutFootageIndexFile,
  parseCutFootageSearch,
  validateCutFootageSearchAgainstIndex,
  type CutFootageIndex,
  type CutFootageSearch,
} from "./contracts";
import { footageFail } from "./diagnostics";
import { loadCutFootageVectorArtifact } from "./indexer";
import { planFootageSources } from "./planner";
import {
  cutFootageBackendIdentityFromInstall,
  inspectCutFootageLocalInstall,
  startCutFootageLocalSidecar,
  type CutFootageLocalInstall,
} from "./setup";
import type { CutFootageSidecarCandidate, CutFootageSidecarSession } from "./sidecar";

export const cutFootageSearchDefaults = Object.freeze({ thresholdPpm: 0, limit: 20 });
const maximumRawQueryBytes = 16 * 1024;

function protocol(path: string, reason: string): never {
  return footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", path, reason);
}

function foldedLocator(value: string) {
  return value.normalize("NFC").toLowerCase().normalize("NFC");
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

function searchBounds(options: Readonly<{ thresholdPpm: number; limit: number }>) {
  if (!options || typeof options !== "object" || !Number.isSafeInteger(options.thresholdPpm)
    || options.thresholdPpm < -1_000_000 || options.thresholdPpm > 1_000_000
    || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > cutFootageLimits.maximumMatches) {
    protocol("$.query", "must contain a valid thresholdPpm and result limit.");
  }
  return Object.freeze({ thresholdPpm: options.thresholdPpm, limit: options.limit });
}

/** Validates the complete candidate set, quantizes once, ranks, and greedily suppresses overlaps. */
export function rankCutFootageCandidates(
  index: CutFootageIndex,
  candidates: readonly CutFootageSidecarCandidate[],
  options: Readonly<{ thresholdPpm: number; limit: number }>,
): CutFootageSearch["matches"] {
  if (!index || typeof index !== "object" || !Array.isArray(index.chunks) || !Array.isArray(candidates)) protocol("$.candidates", "must bind one footage index and candidate array.");
  const bounded = searchBounds(options);
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

  const admitted = scored.filter((candidate) => candidate.scorePpm >= bounded.thresholdPpm).sort(rankingOrder);
  const kept: typeof admitted = [];
  for (const candidate of admitted) {
    if (kept.some((previous) => positiveOverlap(previous.chunk, candidate.chunk))) continue;
    kept.push(candidate);
    if (kept.length === bounded.limit) break;
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

export type SearchProjectFootageOptions = Readonly<{
  projectRoot: string;
  indexLocator: string;
  outputLocator: string;
  query: string;
  thresholdPpm?: number;
  limit?: number;
  backendInstall?: CutFootageLocalInstall;
  signal?: AbortSignal;
  /** @internal Deterministic workflow seams; production callers omit this. */
  __testHooks?: Readonly<{
    startSidecar?: (install: CutFootageLocalInstall) => Promise<CutFootageSidecarSession>;
    afterInference?: () => void | Promise<void>;
  }>;
}>;

export type SearchProjectFootageResult = Readonly<{
  report: CutFootageSearch;
  outputPath: string;
  bytes: Uint8Array;
}>;

function abortIfRequested(signal: AbortSignal | undefined) {
  if (signal?.aborted) protocol("$signal", "the footage search operation was cancelled.");
}

function backendFromHandshake(handshake: CutFootageLocalInstall["manifest"]["handshake"]): CutFootageIndex["backend"] {
  return Object.freeze({
    protocolVersion: 1,
    provider: handshake.provider,
    model: `${handshake.model}@${handshake.revision}+adapter.${handshake.adapterSha256}`,
    dimensions: handshake.dimensions,
    normalization: "l2",
  });
}

async function revalidateSearchIndex(projectRoot: string, index: CutFootageIndex) {
  await loadCutFootageVectorArtifact(projectRoot, index);
  const plan = await planFootageSources({
    projectRoot,
    locators: index.sources.map((source) => source.locator),
    backend: index.backend,
    priorIndex: index,
    chunkPolicy: index.chunkPolicy,
  });
  const publicChunks = plan.chunks.map((chunk) => Object.freeze({
    id: chunk.id,
    sourceLocator: chunk.sourceLocator,
    sourceSha256: chunk.sourceSha256,
    streamIndex: chunk.streamIndex,
    range: chunk.range,
  }));
  if (plan.reusableChunkIds.length !== index.chunks.length
    || stableJsonStringify(plan.sources.map((source) => source.source)) !== stableJsonStringify(index.sources)
    || stableJsonStringify(publicChunks) !== stableJsonStringify(index.chunks)) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$index", "the indexed source and chunk set is no longer reusable.");
  }
}

/** Revalidates an index, queries the verified offline sidecar, and atomically publishes one search report. */
export async function searchProjectFootage(options: SearchProjectFootageOptions): Promise<SearchProjectFootageResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) protocol("$", "must be one footage search request.");
  abortIfRequested(options.signal);
  const query = normalizeCutFootageQuery(options.query);
  const bounds = searchBounds({
    thresholdPpm: options.thresholdPpm ?? cutFootageSearchDefaults.thresholdPpm,
    limit: options.limit ?? cutFootageSearchDefaults.limit,
  });
  const projectRoot = await realpath(resolve(options.projectRoot));
  const indexLocator = validateProjectLocator(options.indexLocator, "footage index locator");
  const outputLocator = validateProjectLocator(options.outputLocator, "footage search output locator");
  const indexPath = await resolveProjectFile(projectRoot, indexLocator);
  const index = await loadCutFootageIndexFile(indexPath);
  const foldedOutput = foldedLocator(outputLocator);
  if ([indexLocator, index.vectorArtifact.locator, ...index.sources.map((source) => source.locator)]
    .some((locator) => foldedLocator(locator) === foldedOutput)) {
    protocol("$.outputLocator", "must not collide with the index, vector artifact, or one indexed source.");
  }
  const outputPath = resolve(projectRoot, outputLocator);
  const install = options.backendInstall ?? await inspectCutFootageLocalInstall();
  const installIdentity = cutFootageBackendIdentityFromInstall(install);
  if (stableJsonStringify(installIdentity) !== stableJsonStringify(index.backend)) {
    footageFail("CUT_FOOTAGE_MODEL_MISMATCH", "$backend", "the installed local footage backend does not match the index identity.");
  }
  await revalidateSearchIndex(projectRoot, index);
  abortIfRequested(options.signal);

  let session: CutFootageSidecarSession | undefined;
  let candidates: readonly CutFootageSidecarCandidate[] | undefined;
  let operationError: unknown, closeError: unknown;
  try {
    session = options.__testHooks?.startSidecar
      ? await options.__testHooks.startSidecar(install)
      : await startCutFootageLocalSidecar({ home: dirname(install.root), signal: options.signal });
    if (stableJsonStringify(session.handshake) !== stableJsonStringify(install.manifest.handshake)
      || stableJsonStringify(backendFromHandshake(session.handshake)) !== stableJsonStringify(index.backend)) {
      footageFail("CUT_FOOTAGE_MODEL_MISMATCH", "$backend", "the running local footage backend does not match the index identity.");
    }
    candidates = await session.searchText({
      artifact: { path: await resolveProjectFile(projectRoot, index.vectorArtifact.locator), bytes: index.vectorArtifact.bytes, sha256: index.vectorArtifact.sha256 },
      query,
    });
  } catch (error) { operationError = error; }
  finally {
    if (session) {
      try { await session.close(); }
      catch (error) { closeError = error; }
    }
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  if (!candidates) protocol("$.candidates", "the local footage backend returned no candidate set.");

  await options.__testHooks?.afterInference?.();
  abortIfRequested(options.signal);
  await revalidateSearchIndex(projectRoot, index);
  const built = buildCutFootageSearchReport(index, query, candidates, bounds);
  try {
    await writeProjectArtifacts([projectRoot], [Object.freeze({ destination: outputPath, contents: built.bytes, role: "footage-search" })]);
  } catch { footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "the footage search report could not be published."); }
  return Object.freeze({ report: built.report, outputPath, bytes: built.bytes });
}
