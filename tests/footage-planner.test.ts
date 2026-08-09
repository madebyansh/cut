import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { rational } from "../lib/language/rational";
import { createCutProject, type CutByteProbe, type CutMediaProbe } from "../lib/project";
import { stableJsonStringify } from "../lib/core/stable";
import { cutFootageLimits, parseCutFootageIndex, type CutFootageIndex } from "../lib/footage/contracts";
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
    { index: 2, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), duration: rational(20), disposition: [] },
    { index: 1, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), duration: rational(20), disposition: ["default"] },
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

async function plannerFixture(count: number) {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-plan-wave-")), "project");
  await createCutProject(root, "Footage planner waves");
  const locators = Array.from({ length: count }, (_unused, index) => `media/${String(index).padStart(2, "0")}.mp4`);
  await Promise.all(locators.map((locator) => copyFile(resolve("examples/media/demo.mp4"), join(root, locator))));
  return { root, locators };
}

function processIsAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitForProcessMarker(path: string) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try { return JSON.parse(await readFile(path, "utf8")) as { wrapper: number; grandchild: number }; }
    catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

async function waitForProcessMarkers(path: string, count: number) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const records = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { wrapper: number; grandchild: number });
      if (records.length >= count) return records.slice(0, count);
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error(`planner process marker did not reach ${count} records`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 5_000;
  while (processIsAlive(pid) && Date.now() <= deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  return !processIsAlive(pid);
}

test("source normalization picks default video before lowest index and requires duration frame rate and time base", () => {
  const normalized = normalizeFootageSourceProbe(bytes, probe());
  assert.equal(normalized.selectedStreamIndex, 1);
  assert.equal(normalizeFootageSourceProbe(bytes, probe({ streams: [
    { index: 2, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), duration: rational(20), disposition: [] },
    { index: 1, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), duration: rational(20), disposition: [] },
  ] })).selectedStreamIndex, 1);
  assert.deepEqual(normalized.source, {
    locator: "media/a.mp4", bytes: 2, sha256: "a".repeat(64), duration: rational(20), probeSha256: normalized.source.probeSha256,
    streams: [
      { index: 1, type: "video", timeBase: rational(1, 25), frameRate: rational(25) },
      { index: 2, type: "video", timeBase: rational(1, 25), frameRate: rational(25) },
    ],
  });
  assert.throws(() => normalizeFootageSourceProbe(bytes, probe({ streams: [{ index: 0, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), disposition: [] }] })), /duration/u);
  assert.throws(() => normalizeFootageSourceProbe(bytes, probe({ streams: [{ index: 0, type: "video", codec: "h264", timeBase: rational(1, 25), duration: rational(20), disposition: [] }] })), /frameRate/u);
  assert.throws(() => normalizeFootageSourceProbe(bytes, probe({ streams: [{ index: 0, type: "video", codec: "h264", frameRate: rational(25), duration: rational(20), disposition: [] }] })), /timeBase/u);
});

test("planner preserves selected-stream duration but floors its executable non-grid tail before signing a v1 index", () => {
  const source = normalizeFootageSourceProbe(bytes, probe({
    container: { names: ["mov"], duration: rational(21) },
    streams: [
      { index: 2, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), duration: rational(20, 1), disposition: [] },
      { index: 1, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), duration: rational(201, 10), disposition: ["default"] },
    ],
  }));
  const chunks = planFootageChunks(source);
  assert.deepEqual(source.source.duration, rational(201, 10));
  assert.deepEqual(source.searchableDuration, rational(502, 25));
  assert.deepEqual(chunks.at(-1)?.range.end, rational(502, 25));
  assert.equal(signedIndex(source.source, chunks).chunks.at(-1)?.range.end.numerator, "502");
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

test("planner rejects source counts above the public index bound before probing", async () => {
  const locators = Array.from(
    { length: cutFootageLimits.maximumSources + 1 },
    (_unused, index) => `media/${String(index).padStart(5, "0")}.mp4`,
  );
  await assert.rejects(
    planFootageSources({ projectRoot: "/not-used", locators, backend }),
    /bounded source count/u,
  );
});

test("planner uses deterministic four-wide probe waves, preserves serial identity, and closes every native lifecycle", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const fixture = await plannerFixture(6);
  try {
    const serial = await planFootageSources({
      projectRoot: fixture.root,
      locators: [...fixture.locators].reverse(),
      backend,
      __testHooks: { probeConcurrency: 1 },
    });
    let active = 0, maximumActive = 0;
    const starts: number[] = [], settled: number[] = [], openReceipts = new Set<string>(), closedReceipts = new Set<string>();
    const concurrent = await planFootageSources({
      projectRoot: fixture.root,
      locators: [...fixture.locators].reverse(),
      backend,
      __testHooks: {
        async probeEvent(event) {
          if (event.phase === "start") {
            starts.push(event.ordinal);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
          } else {
            settled.push(event.ordinal);
            active -= 1;
          }
        },
        lifecycleEvent(event) {
          if (event.phase === "spawn-confirmed") openReceipts.add(event.receiptId);
          if (event.phase === "close-verified") {
            openReceipts.delete(event.receiptId);
            closedReceipts.add(event.receiptId);
          }
        },
      },
    });
    assert.deepEqual(concurrent, serial, "probe scheduling must not enter the canonical plan");
    assert.deepEqual(starts, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual([...settled].sort((left, right) => left - right), starts);
    assert.equal(maximumActive, 4, "the first delayed wave must fill the fixed four-probe ceiling");
    assert.equal(active, 0);
    assert.equal(openReceipts.size, 0, "the shared native collector must close every admitted process before return");
    assert.equal(closedReceipts.size, fixture.locators.length);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("planner drains a failed four-wide wave and reports its first ordinal failure", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const fixture = await plannerFixture(6);
  try {
    const earlier = new Error("earlier ordinal planner failure"), later = new Error("faster later planner failure");
    let active = 0;
    const starts: number[] = [], settlements: number[] = [], closedReceipts = new Set<string>();
    await assert.rejects(planFootageSources({
      projectRoot: fixture.root,
      locators: fixture.locators,
      backend,
      __testHooks: {
        async probeEvent(event) {
          if (event.phase === "start") {
            starts.push(event.ordinal);
            active += 1;
            if (event.ordinal === 1) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
              throw earlier;
            }
            if (event.ordinal === 2) throw later;
          } else {
            settlements.push(event.ordinal);
            active -= 1;
          }
        },
        lifecycleEvent(event) {
          if (event.phase === "close-verified") closedReceipts.add(event.receiptId);
        },
      },
    }), (error: unknown) => error === earlier);
    assert.deepEqual(starts, [0, 1, 2, 3], "a failed wave must not admit later sources");
    assert.deepEqual([...settlements].sort((left, right) => left - right), starts);
    assert.equal(active, 0, "every admitted task must settle before the first ordinal failure escapes");
    assert.equal(closedReceipts.size, 2, "the successful members still close through the shared native lifecycle");
    const settledCount = settlements.length;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    assert.equal(settlements.length, settledCount, "no failed-wave task remains orphaned after rejection");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("planner terminates a failed no-signal FFprobe wrapper and its pipe-owning grandchild", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const fixture = await plannerFixture(1);
  const marker = join(fixture.root, ".cut/planner-ffprobe-pids.json"), wrapper = join(fixture.root, ".cut/planner-ffprobe");
  await writeFile(wrapper, `#!/bin/sh
/bin/sh -c 'trap "" TERM INT; while :; do sleep 1; done' &
grandchild=$!
printf '{"wrapper":%s,"grandchild":%s}\n' "$$" "$grandchild" > ${JSON.stringify(marker)}
trap '' TERM INT
dd if=/dev/zero bs=1048576 count=3 2>/dev/null
while :; do sleep 1; done
`, { flag: "wx" });
  await chmod(wrapper, 0o755);
  try {
    const operation = planFootageSources({
      projectRoot: fixture.root,
      locators: fixture.locators,
      backend,
      __testHooks: { ffprobeExecutable: wrapper },
    });
    const observed = operation.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const pids = await waitForProcessMarker(marker);
    const outcome = await Promise.race([
      observed,
      new Promise<{ kind: "timeout" }>((resolveTimeout) => setTimeout(() => resolveTimeout({ kind: "timeout" }), 3_000)),
    ]);
    if (outcome.kind === "timeout") {
      for (const pid of [pids.wrapper, pids.grandchild]) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await observed;
    }
    const wrapperExited = await waitForProcessExit(pids.wrapper), grandchildExited = await waitForProcessExit(pids.grandchild);
    for (const pid of [pids.wrapper, pids.grandchild]) {
      if (processIsAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    assert.equal(outcome.kind, "rejected", "a failed planner probe left its inherited output pipe open");
    assert.equal(wrapperExited, true);
    assert.equal(grandchildExited, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("planner cancellation drains one four-wide FFprobe wave, kills every process tree, and admits no later source", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  const fixture = await plannerFixture(6);
  const marker = join(fixture.root, ".cut/planner-cancel-pids.jsonl"), wrapper = join(fixture.root, ".cut/planner-cancel-ffprobe");
  await writeFile(wrapper, `#!/bin/sh
/bin/sh -c 'trap "" TERM INT; while :; do sleep 1; done' &
grandchild=$!
printf '{"wrapper":%s,"grandchild":%s}\n' "$$" "$grandchild" >> ${JSON.stringify(marker)}
trap '' TERM INT
while :; do sleep 1; done
`, { flag: "wx" });
  await chmod(wrapper, 0o755);
  const controller = new AbortController();
  let active = 0;
  const starts: number[] = [], settled: number[] = [];
  try {
    const operation = planFootageSources({
      projectRoot: fixture.root,
      locators: fixture.locators,
      backend,
      signal: controller.signal,
      __testHooks: {
        ffprobeExecutable: wrapper,
        probeEvent(event) {
          if (event.phase === "start") { starts.push(event.ordinal); active += 1; }
          else { settled.push(event.ordinal); active -= 1; }
        },
      },
    });
    const observed = operation.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const records = await waitForProcessMarkers(marker, 4);
    controller.abort();
    const outcome = await Promise.race([
      observed,
      new Promise<{ kind: "timeout" }>((resolveTimeout) => setTimeout(() => resolveTimeout({ kind: "timeout" }), 3_000)),
    ]);
    if (outcome.kind === "timeout") {
      for (const record of records) {
        try { process.kill(-record.wrapper, "SIGKILL"); } catch { /* already gone */ }
      }
      await observed;
    }
    const exited = await Promise.all(records.flatMap((record) => [record.wrapper, record.grandchild]).map(waitForProcessExit));
    for (const record of records) {
      for (const pid of [record.wrapper, record.grandchild]) {
        if (processIsAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    }
    assert.ok(outcome.kind === "rejected"
      && outcome.error instanceof Error
      && "code" in outcome.error
      && outcome.error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL"
      && "path" in outcome.error
      && outcome.error.path === "$signal");
    assert.deepEqual(starts, [0, 1, 2, 3]);
    assert.deepEqual([...settled].sort((left, right) => left - right), starts);
    assert.equal(active, 0);
    assert.ok(exited.every(Boolean));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
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
  const codecDrift = normalizeFootageSourceProbe(bytes, probe({ streams: [
    { index: 2, type: "video", codec: "h264", timeBase: rational(1, 25), frameRate: rational(25), duration: rational(20), disposition: [] },
    { index: 1, type: "video", codec: "hevc", timeBase: rational(1, 25), frameRate: rational(25), duration: rational(20), disposition: ["default"] },
  ] }));
  assert.notEqual(codecDrift.source.probeSha256, source.source.probeSha256);
  assert.deepEqual(reusableFootageChunkIds(codecDrift, planFootageChunks(codecDrift), previous, backend, defaultFootageChunkPolicy), []);
});
