import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CutAudioIntelligenceSidecarError,
  cutAudioIntelligenceModelsSha256,
  startCutAudioIntelligenceSidecar,
  type CutAudioIntelligenceModelAuthority,
  type CutAudioIntelligenceSidecarHandshake,
  type CutAudioIntelligenceSidecarLimitOverrides,
} from "../lib/audio-intelligence";

const sha = (digit: string) => digit.repeat(64);
const textSha = (value: string) => createHash("sha256").update(value).digest("hex");
const models = Object.freeze([
  Object.freeze({ role: "analysis", model: "fixture-analysis", revision: "v1", authoritySha256: sha("1") }),
  Object.freeze({ role: "asr", model: "fixture-asr", revision: "v1", authoritySha256: sha("2") }),
  Object.freeze({ role: "tts", model: "fixture-tts", revision: "v1", authoritySha256: sha("3") }),
] satisfies readonly CutAudioIntelligenceModelAuthority[]);
const handshake: CutAudioIntelligenceSidecarHandshake = Object.freeze({
  format: "cut-audio-intelligence-sidecar-handshake",
  version: 1,
  protocolVersion: 1,
  provider: "fixture-local",
  revision: "adapter-v1",
  capabilities: Object.freeze(["analyze", "transcribe", "narrate"] as const),
  adapterSha256: sha("4"),
  selfTestSha256: sha("5"),
  models,
  modelsSha256: cutAudioIntelligenceModelsSha256(models),
});

function fixtureSource(wireHandshake: unknown) {
  return `
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
const mode = process.argv[2] || "valid";
const marker = process.argv[3] || "";
const handshake = ${JSON.stringify(wireHandshake)};
process.stdout.write(JSON.stringify(handshake) + "\\n");
if (mode === "tree") {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  writeFileSync(marker, JSON.stringify({ root: process.pid, grandchild: grandchild.pid }) + "\\n", { flag: "wx" });
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
const send = (value, exitCode) => process.stdout.write(JSON.stringify(value) + "\\n", () => {
  if (exitCode !== undefined) process.exit(exitCode);
});
const identity = (path) => {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
};
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "timeout" || mode === "tree") return;
  if (mode === "malformed-json") { process.stdout.write("{not-json\\n"); return; }
  if (mode === "oversize") { process.stdout.write("x".repeat(2048) + "\\n"); return; }
  if (request.operation === "close") {
    if (mode === "close-no-ack") { process.exit(0); return; }
    const response = { format: "cut-audio-intelligence-sidecar-response", version: 1, id: request.id, operation: "close" };
    send(response, mode === "close-exit17" ? 17 : 0);
    return;
  }
  const id = mode === "out-of-order" ? request.id + "-wrong" : request.id;
  let response;
  if (request.operation === "narrate") {
    if (mode !== "no-artifact") {
      writeFileSync(request.outputWavPath, Buffer.from("RIFF-cut-fixture\\n"));
      writeFileSync(request.outputMetadataPath, Buffer.from('{"voice":"fixture"}\\n'));
    }
    response = { format: "cut-audio-intelligence-sidecar-response", version: 1, id, operation: request.operation, artifacts: {
      wav: mode === "no-artifact" ? { path: request.outputWavPath, bytes: 1, sha256: ${JSON.stringify(sha("c"))} } : identity(request.outputWavPath),
      metadata: mode === "no-artifact" ? { path: request.outputMetadataPath, bytes: 1, sha256: ${JSON.stringify(sha("d"))} } : identity(request.outputMetadataPath),
    } };
  } else {
    if (mode !== "no-artifact") writeFileSync(request.outputPath,
      mode === "mutate-published" ? Buffer.alloc(16 * 1024 * 1024, 97)
        : mode === "large-output" ? Buffer.alloc(128 * 1024 * 1024, 98)
          : Buffer.from(request.operation + "-fixture\\n"));
    const observed = mode === "no-artifact" ? { path: request.outputPath, bytes: 1, sha256: ${JSON.stringify(sha("a"))} } : identity(request.outputPath);
    if (mode === "output-tamper") appendFileSync(request.outputPath, "tampered\\n");
    if (mode === "mutate-input") appendFileSync(request.inputPath, "mutated\\n");
    if (mode === "mutate-request") appendFileSync(request.requestPath, "mutated\\n");
    if (mode === "replace-input") { const bytes = readFileSync(request.inputPath); unlinkSync(request.inputPath); writeFileSync(request.inputPath, bytes); }
    if (mode === "replace-final-parent") {
      const control = JSON.parse(readFileSync(request.requestPath, "utf8"));
      renameSync(control.parentPath, control.movedParentPath);
      symlinkSync(control.outsidePath, control.parentPath, "dir");
    }
    if (mode === "replace-stage-root") {
      const stageRoot = request.outputPath.slice(0, request.outputPath.lastIndexOf("/"));
      renameSync(stageRoot, stageRoot + ".moved");
      mkdirSync(stageRoot, { mode: 0o700 });
      writeFileSync(stageRoot + "/foreign.txt", "foreign bytes\\n");
    }
    if (mode === "unexpected-stage-entry") {
      const stageRoot = request.outputPath.slice(0, request.outputPath.lastIndexOf("/"));
      writeFileSync(stageRoot + "/unexpected.tmp", "unexpected bytes\\n");
    }
    if (mode === "unexpected-stage-directory") {
      const stageRoot = request.outputPath.slice(0, request.outputPath.lastIndexOf("/"));
      mkdirSync(stageRoot + "/unexpected", { mode: 0o700 });
      writeFileSync(stageRoot + "/unexpected/nested.tmp", "nested bytes\\n");
    }
    if (mode === "unexpected-stage-symlink") {
      const stageRoot = request.outputPath.slice(0, request.outputPath.lastIndexOf("/"));
      const control = JSON.parse(readFileSync(request.requestPath, "utf8"));
      symlinkSync(control.outsidePath, stageRoot + "/unexpected-link", "dir");
    }
    response = { format: "cut-audio-intelligence-sidecar-response", version: 1, id, operation: request.operation,
      artifact: mode === "bad-artifact" ? { ...observed, path: request.outputPath + ".wrong", bytes: 0 } : observed };
  }
  if (mode === "duplicate") { send(response); send(response); }
  else if (mode === "delayed-valid") setTimeout(() => send(response), 200);
  else if (mode === "mutate-input-after-response") { send(response); appendFileSync(request.inputPath, "post-response mutation\\n"); }
  else if (mode === "mutate-published") {
    send(response);
    const timer = setInterval(() => {
      try {
        if (statSync(request.outputPath).nlink > 1) {
          appendFileSync(request.outputPath, "post-publication mutation\\n");
          clearInterval(timer);
        }
      } catch { clearInterval(timer); }
    }, 0);
  }
  else if (mode === "large-output") send(response);
  else send(response);
});
`;
}

type FixtureStart = Readonly<{
  mode?: string;
  wireHandshake?: unknown;
  expectedHandshake?: CutAudioIntelligenceSidecarHandshake;
  limits?: CutAudioIntelligenceSidecarLimitOverrides;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string>>;
  marker?: string;
}>;

async function startFixture(options: FixtureStart = {}) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "cut-audio-sidecar-")));
  const script = join(root, "sidecar.mjs"), marker = options.marker ?? join(root, "pids.json");
  const outputRoot = join(root, "output"), inputPath = join(root, "input.wav"), requestPath = join(root, "request.json");
  await mkdir(outputRoot, { mode: 0o700 });
  await writeFile(inputPath, "fixture audio bytes\n");
  await writeFile(requestPath, '{"operation":"fixture"}\n');
  await writeFile(script, fixtureSource(options.wireHandshake ?? handshake));
  try {
    const session = await startCutAudioIntelligenceSidecar({
      executable: process.execPath,
      arguments: Object.freeze([script, options.mode ?? "valid", marker]),
      outputRoot,
      expectedHandshake: options.expectedHandshake ?? handshake,
      limits: options.limits,
      signal: options.signal,
      environment: options.environment,
    });
    return { root, marker, outputRoot, inputPath, requestPath, session };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function cleanup(started: Awaited<ReturnType<typeof startFixture>>) {
  await started.session.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

function isProtocol(error: unknown) {
  return error instanceof CutAudioIntelligenceSidecarError && error.code === "CUT_AUDIO_INTELLIGENCE_SIDECAR";
}

async function assertProtocol(operation: () => Promise<unknown>) {
  await assert.rejects(operation, isProtocol);
}

async function assertNoOwnedStage(outputRoot: string) {
  assert.deepEqual((await readdir(outputRoot)).filter((entry) => entry.startsWith(".cut-audio-sidecar-stage-")), []);
}

async function waitForStageArtifacts(outputRoot: string, count: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const stage = (await readdir(outputRoot)).find((entry) => entry.startsWith(".cut-audio-sidecar-stage-"));
    if (stage) {
      const artifacts = await readdir(join(outputRoot, stage));
      if (artifacts.length === count) return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.fail("sidecar fixture did not create its expected staged artifacts");
}

test("audio-intelligence sidecar executes path-only analyze, transcribe, and two-artifact narration operations", async () => {
  const started = await startFixture();
  try {
    const analysisPath = join(started.outputRoot, "analysis.json");
    const analyzed = await started.session.analyze({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath: analysisPath });
    assert.deepEqual(analyzed, { path: analysisPath, bytes: 16, sha256: textSha("analyze-fixture\n") });
    const transcript = await started.session.transcribe({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath: join(started.outputRoot, "transcript.json") });
    assert.equal(transcript.bytes, 19);
    const narration = await started.session.narrate({
      requestPath: started.requestPath,
      outputWavPath: join(started.outputRoot, "narration.wav"),
      outputMetadataPath: join(started.outputRoot, "narration.json"),
    });
    assert.equal(narration.wav.bytes, 17);
    assert.equal(narration.metadata.bytes, 20);
    assert.deepEqual((await readdir(started.outputRoot)).sort(), ["analysis.json", "narration.json", "narration.wav", "transcript.json"]);
    const pid = started.session.pid;
    await started.session.close();
    assert.equal(started.session.pid, undefined);
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally { await cleanup(started); }
});

test("handshake authenticates exact capability subset and sorted model authorities", async () => {
  const mutatedModels = models.map((model, index) => index ? model : Object.freeze({ ...model, model: "mutated-analysis" }));
  const mutated = Object.freeze({ ...handshake, models: Object.freeze(mutatedModels), modelsSha256: cutAudioIntelligenceModelsSha256(mutatedModels) });
  await assertProtocol(() => startFixture({ wireHandshake: mutated }));
  await assertProtocol(() => startFixture({ wireHandshake: { ...handshake, modelsSha256: sha("f") } }));
  await assertProtocol(() => startFixture({ wireHandshake: { ...handshake, capabilities: ["analyze", "download"] } }));

  const asrModels = Object.freeze([models[1]!]);
  const asrHandshake: CutAudioIntelligenceSidecarHandshake = Object.freeze({
    ...handshake,
    capabilities: Object.freeze(["transcribe"] as const),
    models: asrModels,
    modelsSha256: cutAudioIntelligenceModelsSha256(asrModels),
  });
  const started = await startFixture({ wireHandshake: asrHandshake, expectedHandshake: asrHandshake });
  try {
    await assertProtocol(async () => started.session.analyze({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath: join(started.outputRoot, "analysis.json") }));
    assert.equal((await started.session.transcribe({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath: join(started.outputRoot, "transcript.json") })).bytes, 19);
  } finally { await cleanup(started); }
});

test("unsolicited ordering and duplicate responses fail the session closed", async () => {
  for (const mode of ["out-of-order", "malformed-json"]) {
    const started = await startFixture({ mode });
    const pid = started.session.pid;
    try {
      await assertProtocol(() => started.session.analyze({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath: join(started.outputRoot, "out.json") }));
      assert.equal(started.session.pid, undefined);
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    } finally { await cleanup(started); }
  }
  const duplicate = await startFixture({ mode: "duplicate" });
  const duplicatePid = duplicate.session.pid;
  try {
    await duplicate.session.analyze({ inputPath: duplicate.inputPath, requestPath: duplicate.requestPath, outputPath: join(duplicate.outputRoot, "out.json") }).catch((error) => {
      assert.ok(isProtocol(error));
    });
    const deadline = Date.now() + 1_000;
    while (duplicate.session.pid !== undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(duplicate.session.pid, undefined);
    assert.throws(() => process.kill(duplicatePid!, 0), { code: "ESRCH" });
    await assertProtocol(() => duplicate.session.close());
  } finally { await cleanup(duplicate); }
});

test("artifact path, byte, hash, and response-size identities fail closed", async () => {
  const malformed = await startFixture({ mode: "bad-artifact" });
  const malformedOutput = join(malformed.outputRoot, "out.json");
  try {
    await assertProtocol(() => malformed.session.analyze({ inputPath: malformed.inputPath, requestPath: malformed.requestPath, outputPath: malformedOutput }));
    await assert.rejects(() => lstat(malformedOutput), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    await assertNoOwnedStage(malformed.outputRoot);
  } finally { await cleanup(malformed); }

  const oversized = await startFixture({ mode: "oversize", limits: { maximumResponseLineBytes: 1024 } });
  try {
    await assertProtocol(() => oversized.session.analyze({ inputPath: oversized.inputPath, requestPath: oversized.requestPath, outputPath: join(oversized.outputRoot, "out.json") }));
  } finally { await cleanup(oversized); }
});

test("parent rehashes staged outputs and refuses missing, mutated, or child-only artifact claims", async () => {
  for (const mode of ["no-artifact", "output-tamper", "mutate-published"]) {
    const started = await startFixture({ mode });
    const outputPath = join(started.outputRoot, "out.json"), pid = started.session.pid;
    try {
      await assertProtocol(() => started.session.analyze({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath }));
      assert.equal(started.session.pid, undefined);
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      await assert.rejects(() => lstat(outputPath), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
      await assertNoOwnedStage(started.outputRoot);
    } finally { await cleanup(started); }
  }
});

test("source and request mutation, inode replacement, symlinks, and staging escapes fail closed", async () => {
  for (const mode of ["mutate-input", "mutate-request", "replace-input", "mutate-input-after-response"]) {
    const started = await startFixture({ mode });
    const outputPath = join(started.outputRoot, "out.json");
    try {
      await assertProtocol(() => started.session.analyze({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath }));
      await assert.rejects(() => lstat(outputPath), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
      await assertNoOwnedStage(started.outputRoot);
    } finally { await cleanup(started); }
  }

  const symlinked = await startFixture();
  try {
    await rm(symlinked.inputPath);
    await symlink(symlinked.requestPath, symlinked.inputPath);
    await assertProtocol(() => symlinked.session.analyze({
      inputPath: symlinked.inputPath,
      requestPath: symlinked.requestPath,
      outputPath: join(symlinked.outputRoot, "symlink.json"),
    }));
  } finally { await cleanup(symlinked); }

  const bounded = await startFixture();
  const preexisting = join(bounded.outputRoot, "existing.json");
  try {
    await writeFile(preexisting, "do not clobber\n");
    await assertProtocol(() => bounded.session.analyze({ inputPath: bounded.inputPath, requestPath: bounded.requestPath, outputPath: preexisting }));
    assert.equal(await readFile(preexisting, "utf8"), "do not clobber\n");
    await assertNoOwnedStage(bounded.outputRoot);
    await assertProtocol(() => bounded.session.analyze({ inputPath: bounded.inputPath, requestPath: bounded.requestPath, outputPath: join(bounded.root, "outside.json") }));
  } finally { await cleanup(bounded); }
});

test("publication races roll back only owned outputs and output-root replacement fails before execution", async () => {
  const raced = await startFixture({ mode: "delayed-valid" });
  const wav = join(raced.outputRoot, "narration.wav"), metadata = join(raced.outputRoot, "narration.json");
  try {
    const operation = raced.session.narrate({ requestPath: raced.requestPath, outputWavPath: wav, outputMetadataPath: metadata });
    await waitForStageArtifacts(raced.outputRoot, 2);
    await writeFile(metadata, "concurrent owner bytes\n");
    await assertProtocol(() => operation);
    await assert.rejects(() => lstat(wav), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    assert.equal(await readFile(metadata, "utf8"), "concurrent owner bytes\n");
    await assertNoOwnedStage(raced.outputRoot);
  } finally { await cleanup(raced); }

  const replaced = await startFixture();
  try {
    await rm(replaced.outputRoot, { recursive: true });
    await mkdir(replaced.outputRoot, { mode: 0o700 });
    await assertProtocol(() => replaced.session.analyze({
      inputPath: replaced.inputPath,
      requestPath: replaced.requestPath,
      outputPath: join(replaced.outputRoot, "out.json"),
    }));
    await assertNoOwnedStage(replaced.outputRoot);
  } finally { await cleanup(replaced); }
});

test("nested final-parent and owned-stage replacement fail closed without outside publication or foreign deletion", async () => {
  const parentSwap = await startFixture({ mode: "replace-final-parent" });
  const nested = join(parentSwap.outputRoot, "nested"), moved = join(parentSwap.outputRoot, "nested-moved"), outside = join(parentSwap.root, "outside");
  try {
    await mkdir(nested, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(parentSwap.requestPath, JSON.stringify({ parentPath: nested, movedParentPath: moved, outsidePath: outside }));
    await assertProtocol(() => parentSwap.session.analyze({
      inputPath: parentSwap.inputPath,
      requestPath: parentSwap.requestPath,
      outputPath: join(nested, "escaped.json"),
    }));
    await assert.rejects(() => lstat(join(outside, "escaped.json")), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    await assertNoOwnedStage(parentSwap.outputRoot);
  } finally { await cleanup(parentSwap); }

  const stageSwap = await startFixture({ mode: "replace-stage-root" });
  const finalPath = join(stageSwap.outputRoot, "out.json");
  try {
    await assertProtocol(() => stageSwap.session.analyze({ inputPath: stageSwap.inputPath, requestPath: stageSwap.requestPath, outputPath: finalPath }));
    await assert.rejects(() => lstat(finalPath), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    const stages = (await readdir(stageSwap.outputRoot)).filter((entry) => entry.startsWith(".cut-audio-sidecar-stage-"));
    assert.equal(stages.length, 1);
    assert.equal(stages[0]!.endsWith(".moved"), false);
    assert.equal(await readFile(join(stageSwap.outputRoot, stages[0]!, "foreign.txt"), "utf8"), "foreign bytes\n");
  } finally { await cleanup(stageSwap); }

  const unexpected = await startFixture({ mode: "unexpected-stage-entry" });
  const unexpectedFinal = join(unexpected.outputRoot, "out.json");
  try {
    await assertProtocol(() => unexpected.session.analyze({
      inputPath: unexpected.inputPath,
      requestPath: unexpected.requestPath,
      outputPath: unexpectedFinal,
    }));
    await assert.rejects(() => lstat(unexpectedFinal), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    await assertNoOwnedStage(unexpected.outputRoot);
  } finally { await cleanup(unexpected); }

  const unexpectedDirectory = await startFixture({ mode: "unexpected-stage-directory" });
  try {
    await assertProtocol(() => unexpectedDirectory.session.analyze({
      inputPath: unexpectedDirectory.inputPath,
      requestPath: unexpectedDirectory.requestPath,
      outputPath: join(unexpectedDirectory.outputRoot, "out.json"),
    }));
    await assertNoOwnedStage(unexpectedDirectory.outputRoot);
  } finally { await cleanup(unexpectedDirectory); }

  const unexpectedSymlink = await startFixture({ mode: "unexpected-stage-symlink" });
  const symlinkOutside = join(unexpectedSymlink.root, "symlink-outside"), sentinel = join(symlinkOutside, "sentinel.txt");
  try {
    await mkdir(symlinkOutside, { mode: 0o700 });
    await writeFile(sentinel, "must survive\n");
    await writeFile(unexpectedSymlink.requestPath, JSON.stringify({ outsidePath: symlinkOutside }));
    await assertProtocol(() => unexpectedSymlink.session.analyze({
      inputPath: unexpectedSymlink.inputPath,
      requestPath: unexpectedSymlink.requestPath,
      outputPath: join(unexpectedSymlink.outputRoot, "out.json"),
    }));
    assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
    await assertNoOwnedStage(unexpectedSymlink.outputRoot);
  } finally { await cleanup(unexpectedSymlink); }
});

test("cancellation during parent-side publication rolls back final and stage artifacts", { timeout: 15_000 }, async () => {
  const controller = new AbortController(), started = await startFixture({ mode: "large-output", signal: controller.signal });
  const outputPath = join(started.outputRoot, "large.json");
  try {
    const operation = started.session.analyze({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await lstat(outputPath).then(() => true, () => false)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    assert.equal(await lstat(outputPath).then(() => true, () => false), true, "publication fixture never reached its final hard-link phase");
    controller.abort();
    await assertProtocol(() => operation);
    await assert.rejects(() => lstat(outputPath), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    await assertNoOwnedStage(started.outputRoot);
  } finally { await cleanup(started); }
});

test("timeout and cancellation terminate and drain the complete private process group", { timeout: 10_000, skip: process.platform === "win32" }, async () => {
  const timeout = await startFixture({ mode: "timeout", limits: { operationMs: 60, terminateGraceMs: 50 } });
  const timeoutPid = timeout.session.pid;
  try {
    await assertProtocol(() => timeout.session.analyze({ inputPath: timeout.inputPath, requestPath: timeout.requestPath, outputPath: join(timeout.outputRoot, "out.json") }));
    assert.equal(timeout.session.pid, undefined);
    assert.throws(() => process.kill(timeoutPid!, 0), { code: "ESRCH" });
  } finally { await cleanup(timeout); }

  const controller = new AbortController(), started = await startFixture({ mode: "tree", signal: controller.signal, limits: { operationMs: 5_000, terminateGraceMs: 50 } });
  let pids: { root: number; grandchild: number } | undefined;
  const deadline = Date.now() + 2_000;
  while (!pids && Date.now() < deadline) {
    pids = await readFile(started.marker, "utf8").then((value) => JSON.parse(value), () => undefined);
    if (!pids) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pids);
  const operation = started.session.analyze({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath: join(started.outputRoot, "out.json") });
  controller.abort();
  try {
    await assertProtocol(() => operation);
    assert.equal(started.session.pid, undefined);
    assert.throws(() => process.kill(pids!.root, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(pids!.grandchild, 0), { code: "ESRCH" });
  } finally {
    for (const pid of [pids!.root, pids!.grandchild]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await cleanup(started);
  }
});

test("arguments, environment, request paths, and concurrent operations are bounded before protocol use", async () => {
  await assertProtocol(() => startCutAudioIntelligenceSidecar({
    executable: process.execPath, arguments: [], outputRoot: resolve(tmpdir()), expectedHandshake: handshake, environment: { SECRET_TOKEN: "secret" },
  }));
  await assertProtocol(() => startCutAudioIntelligenceSidecar({
    executable: "node", arguments: [], outputRoot: resolve(tmpdir()), expectedHandshake: handshake,
  }));
  await assertProtocol(() => startCutAudioIntelligenceSidecar({
    executable: process.execPath, arguments: ["x".repeat(32)], outputRoot: resolve(tmpdir()), expectedHandshake: handshake, limits: { maximumArgumentBytes: 16 },
  }));

  const controller = new AbortController(), started = await startFixture({ mode: "timeout", signal: controller.signal, limits: { operationMs: 5_000 } });
  try {
    await assertProtocol(async () => started.session.analyze({ inputPath: "relative.wav", requestPath: started.requestPath, outputPath: join(started.outputRoot, "relative.json") }));
    const first = started.session.analyze({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath: join(started.outputRoot, "out.json") });
    await assertProtocol(() => started.session.transcribe({ inputPath: started.inputPath, requestPath: started.requestPath, outputPath: join(started.outputRoot, "transcript.json") }));
    controller.abort();
    await assertProtocol(() => first);
  } finally { await cleanup(started); }
});

test("close requires an explicit acknowledgement and zero exit status", async () => {
  for (const mode of ["close-no-ack", "close-exit17"]) {
    const started = await startFixture({ mode, limits: { closeMs: 200 } });
    const pid = started.session.pid;
    try {
      await assertProtocol(() => started.session.close());
      assert.equal(started.session.pid, undefined);
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    } finally { await cleanup(started); }
  }
});
