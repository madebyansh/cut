import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { CutFootageError } from "../lib/footage/diagnostics";
import { startCutFootageSidecar, type CutFootageSidecarHandshake } from "../lib/footage/sidecar";

const fixture = resolve("tests/fixtures/footage-deterministic-sidecar.mjs");
const digest = (digit: string) => digit.repeat(64);
const handshake: CutFootageSidecarHandshake = Object.freeze({
  format: "cut-footage-sidecar-handshake", version: 1, protocolVersion: 1,
  provider: "fixture", model: "deterministic-clip", revision: "r1", dimensions: 4,
  normalization: "l2", modalities: Object.freeze(["image", "text"] as const), hardware: "cpu",
  adapterSha256: digest("a"), selfTestSha256: digest("b"),
});

function start(mode = "valid", overrides: NonNullable<Parameters<typeof startCutFootageSidecar>[0]["limits"]> & { signal?: AbortSignal } = {}) {
  const { signal, ...limits } = overrides;
  return startCutFootageSidecar({
    executable: process.execPath, arguments: Object.freeze([fixture, mode]), expectedHandshake: handshake,
    limits: { handshakeMs: 500, indexMs: 500, searchMs: 500, closeMs: 500, terminateGraceMs: 100, ...limits }, signal,
  });
}

function protocol(action: () => Promise<unknown>) {
  return assert.rejects(action, (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL");
}

test("sidecar requires the exact immutable expected handshake", async () => {
  await protocol(() => start("bad-handshake"));
  const session = await start();
  assert.deepEqual(session.handshake, handshake);
  assert.equal(Object.isFrozen(session.handshake), true);
  await session.close();
});

test("sidecar serializes exact request IDs and validates index and search evidence", async () => {
  const session = await start();
  const indexed = await session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" });
  assert.deepEqual(indexed, { bytes: 12, sha256: digest("c"), recordCount: 3, dimensions: 4 });
  const searched = await session.searchText({ artifact: { path: "/tmp/cut-vectors.bin", bytes: 12, sha256: digest("c") }, query: "harbour at night" });
  assert.deepEqual(searched, [{ chunkId: "chunk-1", score: 0.75 }]);
  await Promise.all([session.close(), session.close()]);
  assert.equal(session.pid, undefined);
});

test("sidecar fails closed for partial, unsolicited, unknown, malformed, and duplicate output", async () => {
  const failAtStartOrIndex = async (mode: string) => {
    const session = await start(mode);
    await session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" });
  };
  await protocol(() => failAtStartOrIndex("partial-handshake"));
  await protocol(() => failAtStartOrIndex("unsolicited"));
  await protocol(() => failAtStartOrIndex("malformed"));
  for (const mode of ["partial", "unknown"]) {
    const session = await start(mode);
    await protocol(() => session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" }));
    await session.close().catch(() => undefined);
  }
  const duplicate = await start("duplicate");
  await protocol(() => duplicate.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" }));
});

test("sidecar rejects unbounded, duplicate, and out-of-range semantic search candidates", async () => {
  for (const [mode, limits] of [["bad-search", {}], ["duplicate-search", {}], ["many-search", { maximumCandidates: 1 }]] as const) {
    const session = await start(mode, limits);
    await protocol(() => session.searchText({ artifact: { path: "/tmp/cut-vectors.bin", bytes: 12, sha256: digest("c") }, query: "harbour at night" }));
    await session.close().catch(() => undefined);
  }
});

test("sidecar bounds stderr and stdout without exposing child output", async () => {
  for (const [mode, limits] of [["stderr-overflow", { maximumStderrBytes: 64 }], ["stdout-overflow", { maximumStdoutBytes: 64 }]] as const) {
    await protocol(async () => {
      const session = await start(mode, limits);
      await session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" });
    });
  }
});

test("sidecar times out, handles crash and abort, and leaves no child process", async () => {
  for (const mode of ["timeout", "crash"]) {
    const session = await start(mode, { indexMs: 80 });
    const pid = session.pid;
    await protocol(() => session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" }));
    assert.equal(session.pid, undefined);
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  }
  const controller = new AbortController();
  const session = await start("signal", { indexMs: 500, signal: controller.signal });
  const pid = session.pid;
  controller.abort();
  await protocol(() => session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" }));
  assert.equal(session.pid, undefined);
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
});

test("sidecar rejects unknown environment keys before spawning", async () => {
  await protocol(() => startCutFootageSidecar({
    executable: process.execPath, arguments: Object.freeze([fixture, "valid"]), expectedHandshake: handshake,
    environment: { SECRET_TOKEN: "must-not-pass" }, limits: { handshakeMs: 100 },
  }));
});
