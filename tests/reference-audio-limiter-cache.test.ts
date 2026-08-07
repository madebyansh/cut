import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import {
  isReferenceAudioLimiterBuildEvidence,
  isReferenceAudioLimiterExecutionEvidence,
  type ReferenceAudioLimiterBuildEvidence,
} from "../lib/runtime/reference/audio-limiter-preparation";

function source(body: string, picture = "", duration = "1s") {
  return `cut 0.4;
project "limiter cache evidence";
import { Gain, Limiter, Noise, TimeStretch, Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: ${duration}, fps: 25, width: 64px, height: 64px, sampleRate: 48khz) {
  ${picture}
  ${body}
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function compile(authored: string) {
  const parsed = parseCutLanguage(authored);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function nodes(ir: CutAVIR, op: string) {
  return Object.values(ir.nodes).filter((node) => node.op === op);
}

function child(ir: CutAVIR, node: IRNode) {
  assert.equal(node.children.length, 1);
  const result = ir.nodes[node.children[0]];
  assert.ok(result);
  return result;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertClosedEvidence(evidence: ReferenceAudioLimiterBuildEvidence, forbiddenStrings: readonly string[] = []) {
  assert.ok(isReferenceAudioLimiterBuildEvidence(evidence));
  for (const execution of evidence.executions) assert.ok(isReferenceAudioLimiterExecutionEvidence(execution));
  const forbiddenKeys = new Set(["id", "nodeId", "module", "line", "column", "path", "provenance", "source"]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!record(value)) return;
    for (const [key, item] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `persisted Limiter evidence leaked ${key}`);
      visit(item);
    }
  };
  visit(evidence);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /project\.cut|\/private\/|\/Users\//u);
  for (const forbidden of forbiddenStrings) assert.equal(serialized.includes(forbidden), false, `persisted evidence leaked ${forbidden}`);
  assert.equal(isReferenceAudioLimiterBuildEvidence({ ...clone(evidence), unknown: true }), false, "the public build-evidence validator must be closed");
  if (evidence.executions[0]) {
    assert.equal(isReferenceAudioLimiterExecutionEvidence({ ...clone(evidence.executions[0]), unknown: true }), false, "the public execution-evidence validator must be closed");
  }
}

async function decodedF32(path: string, expectedFrames: number) {
  const bytes = await readFile(path);
  assert.equal(bytes.byteLength, expectedFrames * 8, "cache artifact must be exact stereo f32le");
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    assert.ok(Number.isFinite(bytes.readFloatLE(offset)), `non-finite decoded f32 sample at byte ${offset}`);
  }
  return bytes;
}

const correctedStaticBody = `Limiter(ceiling: -1dbtp, release: 50ms, lookahead: 5ms) {
  Gain(amount: 12db) {
    Noise(duration: 1s, color: "white", amplitude: 100%, seed: 5);
  }
}`;

test("public static Limiter evidence records two-authority correction and survives a picture-only cache hit", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-cache-static-"));
  try {
    const initialIr = compile(source(correctedStaticBody));
    const pictureIr = compile(source(correctedStaticBody, "Rect(width: 8px, height: 8px, fill: #ff006e);"));
    const initialLimiterIds = nodes(initialIr, "cut.audio.limiter").map((node) => node.id);
    const pictureLimiterIds = nodes(pictureIr, "cut.audio.limiter").map((node) => node.id);
    assert.equal(initialLimiterIds.length, 1);
    assert.equal(pictureLimiterIds.length, 1);
    assert.notDeepEqual(pictureLimiterIds, initialLimiterIds, "the picture insertion must genuinely renumber the authored Limiter node");

    const cold = await renderReferenceAudioArtifact(initialIr, initialIr.compositions[0], root);
    assert.deepEqual({ status: cold.cache.status, reason: cold.cache.reason }, { status: "miss", reason: "CUT_AUDIO_CACHE_COLD" });
    assert.equal(cold.cache.limiter.preparedExecutions, 1);
    assert.equal(cold.cache.limiter.executions.length, 1);
    const execution = cold.cache.limiter.executions[0];
    assert.equal(execution.authoredCeilingMode, "static");
    assert.equal(execution.core.ceiling.mode, "static");
    assert.equal(execution.compatibility.status, "verified-static");
    if (execution.compatibility.status !== "verified-static") throw new Error("expected verified static compatibility evidence");
    assert.ok(execution.compatibility.correctionFactor > 0 && execution.compatibility.correctionFactor < 1, JSON.stringify(execution.compatibility));
    assert.equal(execution.compatibility.passes.length, 2, "the retained public noise source must execute one bounded correction and recheck");
    const [initial, corrected] = execution.compatibility.passes;
    assert.equal(initial.correctionFactor, execution.compatibility.correctionFactor);
    assert.equal(corrected.correctionFactor, 1);
    assert.notEqual(initial.boundary.sha256, corrected.boundary.sha256);
    assert.ok(initial.ffmpeg.truePeakDbtp !== null && initial.cut.truePeakDbtp !== null);
    assert.ok(initial.ffmpeg.truePeakDbtp > initial.cut.truePeakDbtp + 0.2, JSON.stringify(initial));
    assert.ok(corrected.ffmpeg.truePeakDbtp !== null && corrected.ffmpeg.truePeakDbtp <= -1.01);
    assert.ok(corrected.cut.truePeakDbtp !== null && corrected.cut.truePeakDbtp <= -1.01);
    assert.equal(initial.toolchain.integrity, cold.cache.identity.graph.limiter?.toolchain.integrity);
    assert.equal(corrected.toolchain.integrity, cold.cache.identity.graph.limiter?.toolchain.integrity);
    assert.equal(execution.minimumFinalGain, execution.core.gain.minimumFinal * execution.compatibility.correctionFactor);
    assertClosedEvidence(cold.cache.limiter, initialLimiterIds);
    const coldPcm = await decodedF32(cold.path, 48_000);

    const warm = await renderReferenceAudioArtifact(pictureIr, pictureIr.compositions[0], root);
    assert.deepEqual({ status: warm.cache.status, reason: warm.cache.reason }, { status: "hit", reason: "CUT_AUDIO_CACHE_HIT" });
    assert.equal(warm.cache.key, cold.cache.key);
    assert.equal(warm.cache.artifact.sha256, cold.cache.artifact.sha256);
    assert.deepEqual(warm.cache.limiter, cold.cache.limiter, "a warm hit must expose the exact persisted execution evidence");
    assert.deepEqual(await decodedF32(warm.path, 48_000), coldPcm);
    assert.deepEqual(warm.cache.identity.graph.roots.map(({ id }) => id), referenceMasterAudioRootIds(pictureIr, pictureIr.compositions[0]));
    assertClosedEvidence(warm.cache.limiter, [...initialLimiterIds, ...pictureLimiterIds, root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic Limiter ceilings persist an explicit not-applicable compatibility policy", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-cache-dynamic-"));
  try {
    const ir = compile(source(`Limiter(ceiling: -1dbtp, release: 40ms, lookahead: 3ms) as master {
      Gain(amount: 6db) { Noise(duration: 1s, color: "pink", amplitude: 60%, seed: 41); }
    }
    at 500ms { set master.ceiling = -8dbtp; }`));
    const rendered = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
    assert.equal(rendered.cache.status, "miss");
    assert.equal(rendered.cache.limiter.preparedExecutions, 1);
    const execution = rendered.cache.limiter.executions[0];
    assert.equal(execution.authoredCeilingMode, "dynamic");
    assert.equal(execution.core.ceiling.mode, "dynamic");
    assert.deepEqual(Object.keys(execution.compatibility).sort(), ["policy", "status"]);
    assert.equal(execution.compatibility.status, "not-applicable-dynamic-ceiling");
    assert.equal(execution.minimumFinalGain, execution.core.gain.minimumFinal);
    assert.equal(JSON.stringify(rendered.cache.limiter).includes("passes"), false, "dynamic ceilings must not masquerade a global static-meter report as automation proof");
    assertClosedEvidence(rendered.cache.limiter, nodes(ir, "cut.audio.limiter").map((node) => node.id));
    await decodedF32(rendered.path, 48_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested Limiters and both TimeStretch boundary orders accumulate every execution exactly once", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-cache-recursion-"));
  try {
    const ir = compile(source(`Limiter(ceiling: -2dbtp, release: 40ms, lookahead: 5ms) {
      Limiter(ceiling: -7dbtp, release: 25ms, lookahead: 3ms) {
        Noise(duration: 200ms, color: "pink", amplitude: 2%, seed: 11);
      }
    }
    at 250ms {
      Limiter(ceiling: -4dbtp) {
        TimeStretch(sourceDuration: 200ms, duration: 300ms, pitch: 1, quality: "draft") {
          Noise(duration: 200ms, color: "white", amplitude: 2%, seed: 12);
        }
      }
    }
    at 600ms {
      TimeStretch(sourceDuration: 200ms, duration: 300ms, pitch: -1, quality: "draft") {
        Limiter(ceiling: -5dbtp) {
          Noise(duration: 200ms, color: "brown", amplitude: 2%, seed: 13);
        }
      }
    }`));
    const limiters = nodes(ir, "cut.audio.limiter");
    const stretches = nodes(ir, "cut.audio.time_stretch");
    assert.equal(limiters.length, 4);
    assert.equal(stretches.length, 2);
    assert.ok(limiters.some((node) => child(ir, node).op === "cut.audio.limiter"), "missing nested Limiter -> Limiter graph");
    assert.ok(limiters.some((node) => child(ir, node).op === "cut.audio.time_stretch"), "missing Limiter -> TimeStretch graph");
    assert.ok(stretches.some((node) => child(ir, node).op === "cut.audio.limiter"), "missing TimeStretch -> Limiter graph");

    const rendered = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
    assert.equal(rendered.cache.status, "miss");
    assert.equal(rendered.cache.identity.graph.limiter?.nodes, limiters.length);
    assert.equal(rendered.cache.limiter.preparedExecutions, limiters.length);
    assert.equal(rendered.cache.limiter.executions.length, limiters.length);
    assert.equal(new Set(rendered.cache.limiter.executions.map((execution) => execution.integrity)).size, limiters.length);
    assert.ok(rendered.cache.limiter.executions.every((execution) => execution.authoredCeilingMode === "static"));
    assertClosedEvidence(rendered.cache.limiter, limiters.map((node) => node.id));
    await decodedF32(rendered.path, 48_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing, malformed, and unknown persisted Limiter evidence force a bounded cache rebuild", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-cache-hostile-"));
  try {
    const ir = compile(source(`Limiter(ceiling: -1dbtp, release: 40ms, lookahead: 3ms) {
      Tone(frequency: 997hz, duration: 120ms, amplitude: 20%);
    }`, "", "120ms"));
    const baseline = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
    assert.equal(baseline.cache.status, "miss");
    assertClosedEvidence(baseline.cache.limiter);
    const baselinePcm = await decodedF32(baseline.path, 5_760);
    const manifestPath = resolve(root, ".cut/cache/reference/audio", baseline.cache.key, "manifest.json");

    const corruptions: Array<{ name: string; mutate: (manifest: Record<string, unknown>) => void }> = [
      {
        name: "missing",
        mutate(manifest) { delete manifest.limiter; },
      },
      {
        name: "malformed",
        mutate(manifest) {
          assert.ok(record(manifest.limiter));
          manifest.limiter.executions = "not-an-execution-array";
        },
      },
      {
        name: "unknown",
        mutate(manifest) {
          assert.ok(record(manifest.limiter));
          const executions = manifest.limiter.executions;
          assert.ok(Array.isArray(executions) && record(executions[0]));
          executions[0].fixtureName = "must-not-be-accepted";
        },
      },
    ];

    for (const corruption of corruptions) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      assert.ok(record(manifest));
      corruption.mutate(manifest);
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      const rebuilt = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
      assert.deepEqual(
        { status: rebuilt.cache.status, reason: rebuilt.cache.reason },
        { status: "miss", reason: "CUT_AUDIO_CACHE_MANIFEST_INVALID" },
        `${corruption.name} Limiter evidence must not authorize a cache hit`,
      );
      assert.equal(rebuilt.cache.key, baseline.cache.key);
      assert.deepEqual(rebuilt.cache.limiter, baseline.cache.limiter);
      assert.deepEqual(await decodedF32(rebuilt.path, 5_760), baselinePcm);
      assertClosedEvidence(rebuilt.cache.limiter);

      const replay = await renderReferenceAudioArtifact(ir, ir.compositions[0], root);
      assert.equal(replay.cache.status, "hit", `${corruption.name} rebuild must publish one valid replacement manifest`);
      assert.deepEqual(replay.cache.limiter, baseline.cache.limiter);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
