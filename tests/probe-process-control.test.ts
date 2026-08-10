import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCutProject, CutProjectError, probeProjectDecodedVideoCadence, probeProjectMedia } from "../lib/project";
import {
  bindReferenceNativeMediaTool,
  createReferenceNativeProcessCollector,
  type ReferenceNativeProcessContext,
} from "../lib/project/native-process-authority";

type HangingMode = "metadata-timeout" | "metadata-output" | "cadence-parse";

async function fixture(mode: HangingMode) {
  const root = join(await mkdtemp(join(tmpdir(), `cut-probe-control-${mode}-`)), "project");
  await createCutProject(root, `Probe process control ${mode}`);
  const source = join(root, "media/source.mp4");
  await copyFile(resolve("examples/media/demo.mp4"), source);
  const marker = join(root, `.cut/${mode}-pids.json`), wrapper = join(root, `.cut/${mode}-ffprobe`);
  await writeFile(wrapper, `#!/bin/sh
if [ "$1" = "--cut-probe-control-ready" ]; then exit 0; fi
/bin/sh -c 'trap "" TERM INT; while :; do sleep 1; done' &
grandchild=$!
printf '{"wrapper":%s,"grandchild":%s}\\n' "$$" "$grandchild" > ${JSON.stringify(marker)}
trap '' TERM INT
${mode === "metadata-output" ? `printf '${"x".repeat(4096)}'` : mode === "cadence-parse" ? "printf 'not-a-frame-record\\n'" : ":"}
while :; do sleep 1; done
`, { flag: "wx" });
  await chmod(wrapper, 0o755);
  await new Promise<void>((accept, reject) => {
    execFile(wrapper, ["--cut-probe-control-ready"], (error) => error ? reject(error) : accept());
  });
  return Object.freeze({ root, marker, wrapper, sourceBytes: (await stat(source)).size });
}

async function controlledExecution(
  wrapper: string,
  resourceBytes: number,
  operation: ReferenceNativeProcessContext["operation"],
  streamIndex?: number,
  options: Readonly<{ signal?: AbortSignal; terminateProcessTree?: boolean }> = {},
) {
  const authority = await bindReferenceNativeMediaTool("ffprobe", wrapper);
  const collector = createReferenceNativeProcessCollector(authority);
  return Object.freeze({
    collector,
    execution: Object.freeze({
      authority,
      collector,
      ...options,
      context: Object.freeze({
        ordinal: 0,
        operation,
        resourceId: "media/source.mp4",
        resourceSha256: "a".repeat(64),
        resourceBytes,
        variant: "master" as const,
        ...(streamIndex === undefined ? {} : { streamIndex }),
      }),
    }),
  });
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function ownsProcessGroup(pid: number) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForMarker(path: string) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try { return JSON.parse(await readFile(path, "utf8")) as { wrapper: number; grandchild: number }; }
    catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((accept) => setTimeout(accept, 10));
    }
  }
}

async function waitForDead(pid: number) {
  const deadline = Date.now() + 5_000;
  while (pidAlive(pid) && Date.now() <= deadline) await new Promise((accept) => setTimeout(accept, 20));
  return !pidAlive(pid);
}

async function boundedFailure(operation: Promise<unknown>, marker: string) {
  const observed = operation.then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  const pids = await Promise.race([
    waitForMarker(marker),
    observed.then((outcome) => {
      if (outcome.kind === "rejected") throw outcome.error;
      throw new Error("probe resolved before its hanging wrapper wrote a marker");
    }),
  ]);
  const started = Date.now();
  const outcome = await Promise.race([
    observed,
    new Promise<{ kind: "timeout" }>((accept) => setTimeout(() => accept({ kind: "timeout" }), 3_000)),
  ]);
  if (outcome.kind === "timeout") {
    for (const pid of [pids.wrapper, pids.grandchild]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  assert.equal(outcome.kind, "rejected", "probe failure left a pipe-owning process tree alive");
  if (outcome.kind !== "rejected") throw new Error("unreachable probe outcome");
  assert.ok(Date.now() - started < 3_000);
  const [wrapperDead, grandchildDead] = await Promise.all([waitForDead(pids.wrapper), waitForDead(pids.grandchild)]);
  if (!wrapperDead || !grandchildDead) {
    for (const pid of [pids.wrapper, pids.grandchild]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  assert.equal(wrapperDead, true, "ffprobe wrapper survived termination");
  assert.equal(grandchildDead, true, "pipe-owning ffprobe grandchild survived termination");
  return outcome.error;
}

test("no-signal metadata timeout and output overflow terminate the opted-in ffprobe process group", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  for (const mode of ["metadata-timeout", "metadata-output"] as const) {
    const item = await fixture(mode);
    const bound = await controlledExecution(item.wrapper, item.sourceBytes, "media-metadata", undefined, { terminateProcessTree: true });
    const error = await boundedFailure(probeProjectMedia(
      item.root,
      "media/source.mp4",
      { timeoutMs: 500, ...(mode === "metadata-output" ? { maxOutputBytes: 64 } : {}) },
      {},
      bound.execution,
    ), item.marker);
    assert.ok(error instanceof CutProjectError);
    assert.equal(error.code, mode === "metadata-output" ? "CUTP2002" : "CUTP2001");
    await assert.rejects(bound.collector.seal());
  }
});

test("no-signal decoded-cadence parse failure terminates the opted-in ffprobe process group", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const item = await fixture("cadence-parse");
  const media = await probeProjectMedia(item.root, "media/source.mp4");
  const stream = media.streams.find((candidate) => candidate.type === "video");
  assert.ok(stream);
  const bound = await controlledExecution(item.wrapper, item.sourceBytes, "decoded-video-cadence", stream.index, { terminateProcessTree: true });
  const error = await boundedFailure(probeProjectDecodedVideoCadence(
    item.root,
    "media/source.mp4",
    media,
    stream.index,
    { timeoutMs: 500 },
    {},
    bound.execution,
  ), item.marker);
  assert.ok(error instanceof CutProjectError);
  assert.equal(error.code, "CUTP2014");
  await assert.rejects(bound.collector.seal());
});

test("an AbortSignal alone leaves ordinary probe execution in the caller process group", { timeout: 10_000, skip: process.platform === "win32" }, async () => {
  const item = await fixture("metadata-timeout");
  const controller = new AbortController();
  const bound = await controlledExecution(item.wrapper, item.sourceBytes, "media-metadata", undefined, { signal: controller.signal });
  const operation = probeProjectMedia(
    item.root,
    "media/source.mp4",
    { timeoutMs: 5_000 },
    {},
    bound.execution,
  );
  const observed = operation.then(() => undefined, () => undefined);
  const pids = await waitForMarker(item.marker);
  let ownsGroup: boolean;
  try { ownsGroup = ownsProcessGroup(pids.wrapper); }
  finally {
    controller.abort();
    for (const pid of [pids.wrapper, pids.grandchild]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await observed;
  }
  assert.equal(ownsGroup, false, "an ordinary controlled probe was globally detached without an explicit tree-control opt-in");
  await assert.rejects(bound.collector.seal());
});
