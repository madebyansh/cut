import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { rational } from "../lib/language/rational";
import { createCutProject, type CutByteProbe, type CutMediaProbe } from "../lib/project";
import { stableJsonStringify } from "../lib/core/stable";
import { parseCutFootageIndex, type CutFootageIndex } from "../lib/footage/contracts";
import {
  defaultFootageChunkPolicy,
  normalizeFootageSourceProbe,
  planFootageChunks,
  planFootageSources,
  reusableFootageChunkIds,
  type FootageBackendIdentity,
  type FootagePublicSource,
} from "../lib/footage/planner";

const backend: FootageBackendIdentity = Object.freeze({ protocolVersion: 1, provider: "local", model: "clip", dimensions: 512, normalization: "l2" });
const bytes: CutByteProbe = { format: "cut-byte-probe", version: 1, file: { locator: "media/a.mp4", basename: "a.mp4", bytes: 2, sha256: "a".repeat(64) } };
const probe = (overrides: Partial<CutMediaProbe> = {}): CutMediaProbe => ({
  format: "cut-media-probe", version: 1,
  implementation: { name: "ffprobe", version: "test" }, file: { ...bytes.file },
  container: { names: ["mov"], duration: rational(20) }, chapters: [],
  streams: [
    { index: 2, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), disposition: [] },
    { index: 1, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), disposition: ["default"] },
  ],
  ...overrides,
});

function signedIndex(source: FootagePublicSource, chunks: ReturnType<typeof planFootageChunks>, policy = defaultFootageChunkPolicy): CutFootageIndex {
  const body = {
    format: "cut-footage-index" as const, version: 1 as const, root: "media", sources: [source], chunkPolicy: policy, chunks, backend,
    vectorArtifact: { locator: ".cut/vectors.bin", bytes: 1, sha256: "b".repeat(64) }, creation: { cutVersion: "test", backendProtocolVersion: 1 as const },
  };
  const indexBody = { ...body, chunks: chunks.map(({ samplePoints: _samplePoints, ...chunk }) => chunk) };
  return parseCutFootageIndex(JSON.stringify({ ...indexBody, indexSha256: createHash("sha256").update(stableJsonStringify(indexBody)).digest("hex") }));
}

test("source normalization picks default video before lowest index and requires duration frame rate and time base", () => {
  const normalized = normalizeFootageSourceProbe(bytes, probe());
  assert.equal(normalized.selectedStreamIndex, 1);
  assert.equal(normalizeFootageSourceProbe(bytes, probe({ streams: [
    { index: 2, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), disposition: [] },
    { index: 1, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), disposition: [] },
  ] })).selectedStreamIndex, 1);
  assert.deepEqual(normalized.source, {
    locator: "media/a.mp4", bytes: 2, sha256: "a".repeat(64), duration: rational(20), probeSha256: normalized.source.probeSha256,
    streams: [
      { index: 1, type: "video", timeBase: rational(1, 25), frameRate: rational(25) },
      { index: 2, type: "video", timeBase: rational(1, 25), frameRate: rational(25) },
    ],
  });
  assert.throws(() => normalizeFootageSourceProbe(bytes, probe({ container: { names: ["mov"] } })), /duration/u);
  assert.throws(() => normalizeFootageSourceProbe(bytes, probe({ streams: [{ index: 0, type: "video", codec: "h264", timeBase: rational(1, 25), disposition: [] }] })), /frameRate/u);
  assert.throws(() => normalizeFootageSourceProbe(bytes, probe({ streams: [{ index: 0, type: "video", codec: "h264", frameRate: rational(25), disposition: [] }] })), /timeBase/u);
});

test("chunk planner uses exact eight-second chunks, two-second overlap, and one deterministic frame-grid point per second slot", () => {
  const normalized = normalizeFootageSourceProbe(bytes, probe());
  const chunks = planFootageChunks(normalized, defaultFootageChunkPolicy);
  assert.deepEqual(chunks.map((chunk) => chunk.range), [
    { semantics: "half-open", start: rational(0), end: rational(8) },
    { semantics: "half-open", start: rational(6), end: rational(14) },
    { semantics: "half-open", start: rational(12), end: rational(20) },
  ]);
  assert.deepEqual(chunks[0]?.samplePoints, [rational(12, 25), rational(37, 25), rational(62, 25), rational(87, 25), rational(112, 25), rational(137, 25), rational(162, 25), rational(187, 25)]);
  assert.ok(chunks.every((chunk) => chunk.samplePoints.every((point) => BigInt(point.numerator) * BigInt(chunk.range.start.denominator) >= BigInt(chunk.range.start.numerator) * BigInt(point.denominator)
    && BigInt(point.numerator) * BigInt(chunk.range.end.denominator) < BigInt(chunk.range.end.numerator) * BigInt(point.denominator))));
});

test("planner probes a real fixture through bound ffprobe authority and returns public locators only", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-plan-")), "project");
  await createCutProject(root, "Footage planner");
  await copyFile(resolve("examples/media/demo.mp4"), join(root, "media/demo.mp4"));
  const planned = await planFootageSources({ projectRoot: root, locators: ["media/demo.mp4"], backend });
  assert.equal(planned.sources.length, 1);
  assert.equal(planned.sources[0]?.source.locator, "media/demo.mp4");
  assert.ok(planned.sources[0]?.source.duration);
  assert.ok(planned.chunks.length > 0);
  assert.ok(planned.chunks.every((chunk) => !chunk.sourceLocator.includes(root)));
});

test("planner rejects a non-media locator before probing", async () => {
  await assert.rejects(
    planFootageSources({ projectRoot: "/not-used", locators: ["media/notes.txt"], backend }),
    /MP4 or MOV/u,
  );
});

test("reuse returns chunk ids only for a complete identity match", () => {
  const source = normalizeFootageSourceProbe(bytes, probe());
  const chunks = planFootageChunks(source, defaultFootageChunkPolicy);
  const previous = signedIndex(source.source, chunks);
  assert.deepEqual(reusableFootageChunkIds(source, chunks, previous, backend, defaultFootageChunkPolicy), chunks.map((chunk) => chunk.id));
  assert.deepEqual(reusableFootageChunkIds({ ...source, source: { ...source.source, sha256: "c".repeat(64) } }, chunks, previous, backend, defaultFootageChunkPolicy), []);
  assert.deepEqual(reusableFootageChunkIds({ ...source, source: { ...source.source, probeSha256: "d".repeat(64) } }, chunks, previous, backend, defaultFootageChunkPolicy), []);
  assert.deepEqual(reusableFootageChunkIds(source, chunks, previous, { ...backend, model: "other" }, defaultFootageChunkPolicy), []);
  assert.deepEqual(reusableFootageChunkIds(source, chunks, previous, backend, { duration: rational(8), overlap: rational(1) }), []);
  assert.deepEqual(reusableFootageChunkIds(source, chunks.slice(0, 2), previous, backend, defaultFootageChunkPolicy), []);
});
