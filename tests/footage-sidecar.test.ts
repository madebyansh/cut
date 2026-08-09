import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { CutFootageError } from "../lib/footage/diagnostics";
import { cutFootageSidecarLimits, startCutFootageSidecar, type CutFootageSidecarHandshake } from "../lib/footage/sidecar";

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
function startWith(options: Parameters<typeof startCutFootageSidecar>[0]) { return startCutFootageSidecar(options); }

function protocol(action: () => Promise<unknown>) {
  return assert.rejects(action, (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL");
}
function promptProtocol(action: () => Promise<unknown>) {
  return protocol(() => Promise.race([
    action(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("sidecar did not fail promptly")), 100)),
  ]));
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

test("sidecar permits only downward limit overrides", async () => {
  for (const [key, value] of Object.entries(cutFootageSidecarLimits)) {
    if (key === "handshakeMs") continue;
    await protocol(() => startCutFootageSidecar({
      executable: process.execPath, arguments: Object.freeze([fixture, "valid"]), expectedHandshake: handshake,
      limits: { [key]: value + 1 },
    }));
  }
  const coldSetup = await startCutFootageSidecar({
    executable: process.execPath, arguments: Object.freeze([fixture, "valid"]), expectedHandshake: handshake,
    limits: { handshakeMs: 30 * 60_000, closeMs: 500 },
  });
  await coldSetup.close();
  await protocol(() => startCutFootageSidecar({
    executable: process.execPath, arguments: Object.freeze([fixture, "valid"]), expectedHandshake: handshake,
    limits: { handshakeMs: 30 * 60_000 + 1 },
  }));
  await protocol(() => startWith({
    executable: process.execPath, arguments: Object.freeze([fixture, "valid"]), expectedHandshake: handshake,
    limits: { unexpected: 1 } as NonNullable<Parameters<typeof startCutFootageSidecar>[0]["limits"]>,
  }));
});

test("sidecar uses only its named explicit environment", async () => {
  const expected = Object.freeze({ ...handshake, provider: "fixture-isolated" });
  const session = await startWith({
    executable: process.execPath, arguments: Object.freeze([fixture, "environment"]), expectedHandshake: expected,
    environment: {
      CUT_FOOTAGE_CACHE_DIR: "fixture-cache",
      CUT_FOOTAGE_MODEL_DIR: "fixture-model",
      HTTP_PROXY: "http://proxy.invalid:8080",
      HTTPS_PROXY: "http://secure-proxy.invalid:8080",
      ALL_PROXY: "socks5://all-proxy.invalid:1080",
      NO_PROXY: "localhost,127.0.0.1",
    },
    limits: { handshakeMs: 500, closeMs: 500 },
  });
  await session.close();
});

test("sidecar refuses request overflow before writing to the child", async () => {
  const session = await start("valid", { maximumRequestBytes: 1 });
  const pid = session.pid;
  await protocol(() => session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" }));
  assert.equal(session.pid, undefined);
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
});

test("sidecar refuses an index response whose dimensions drift from its handshake", async () => {
  const session = await start("wrong-index-dimensions");
  await protocol(() => session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" }));
  await session.close().catch(() => undefined);
});

test("sidecar fails queued close when a child exits before close is sent and acknowledged", async () => {
  const controller = new AbortController();
  const session = await start("exit-before-close", { indexMs: 500, signal: controller.signal });
  const pid = session.pid;
  const indexed = session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" });
  const closed = session.close();
  try {
    await promptProtocol(() => indexed);
    await protocol(() => closed);
  } finally { controller.abort(); }
  assert.equal(session.pid, undefined);
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
});

test("sidecar close requires both acknowledgement and a clean child exit", async () => {
  const hangingController = new AbortController();
  const hanging = await start("close-hang", { closeMs: 80, signal: hangingController.signal });
  const hangingPid = hanging.pid;
  try { await promptProtocol(() => hanging.close()); } finally { hangingController.abort(); }
  assert.equal(hanging.pid, undefined);
  assert.throws(() => process.kill(hangingPid!, 0), { code: "ESRCH" });

  const badExit = await start("close-exit17", { closeMs: 500 });
  const badExitPid = badExit.pid;
  await protocol(() => badExit.close());
  assert.equal(badExit.pid, undefined);
  assert.throws(() => process.kill(badExitPid!, 0), { code: "ESRCH" });
});

test("sidecar seals new non-close work immediately while preserving work already in flight", async () => {
  const ordered = await start();
  const indexed = ordered.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" });
  const closed = ordered.close();
  assert.deepEqual(await indexed, { bytes: 12, sha256: digest("c"), recordCount: 3, dimensions: 4 });
  await closed;

  const controller = new AbortController();
  const sealed = await start("close-hang", { closeMs: 500, signal: controller.signal });
  const sealing = sealed.close();
  const later = await Promise.allSettled([
    sealed.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" }),
    sealed.searchText({ artifact: { path: "/tmp/cut-vectors.bin", bytes: 12, sha256: digest("c") }, query: "harbour at night" }),
  ]);
  controller.abort();
  await protocol(() => sealing);
  for (const result of later) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof CutFootageError && result.reason.code === "CUT_FOOTAGE_BACKEND_PROTOCOL");
  }
  assert.equal(sealed.pid, undefined);
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

test("sidecar startup and public diagnostics never expose child secrets or paths", async () => {
  await assert.rejects(async () => {
    const session = await start("stderr-secret", { maximumStderrBytes: 64 });
    await session.index({ plan: { path: "/tmp/cut-plan.json", bytes: 8, sha256: digest("d") }, artifactPath: "/tmp/cut-vectors.bin" });
  }, (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL"
    && !error.message.includes("secret-value") && !error.message.includes("/tmp/sidecar-secret") && !error.message.includes("CUT_FOOTAGE_SECRET"));
  await protocol(() => startWith({
    executable: "/tmp/cut-footage-missing-executable", arguments: Object.freeze([]), expectedHandshake: handshake,
    limits: { handshakeMs: 100 },
  }));
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
