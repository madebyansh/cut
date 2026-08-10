import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import {
  bindReferenceNativeMediaTool,
  createReferenceNativeProcessCollector,
  ReferenceNativeProcessAuthorityError,
  spawnBoundReferenceNativeProcess,
  type ReferenceNativeProcessContext,
} from "../lib/project/native-process-authority";

const resourceSha256 = "a".repeat(64);

function executableMutationFailure(error: unknown) {
  return error instanceof ReferenceNativeProcessAuthorityError
    && error.code === "CUT_NATIVE_PROCESS_AUTHORITY"
    && error.tool === "ffprobe"
    && (error.reason === "EXECUTABLE_FILE" || error.reason === "EXECUTABLE_CHANGED");
}

function context(ordinal: number): ReferenceNativeProcessContext {
  return Object.freeze({
    ordinal,
    operation: "media-metadata",
    resourceId: "fixture-video",
    resourceSha256,
    resourceBytes: 17,
    variant: "master",
  });
}

async function executable(root: string, name: string, body = "exit 0") {
  const path = resolve(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}

async function waitForClose(child: ReturnType<typeof spawnBoundReferenceNativeProcess> extends Promise<infer Value> ? Value : never) {
  await once(child, "close");
}

test("bound native process authority seals exact clean lifecycle evidence", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-clean-"));
  try {
    const path = await executable(root, "ffprobe-fixture.sh");
    const authority = await bindReferenceNativeMediaTool("ffprobe", path);
    const lifecycle: unknown[] = [];
    const collector = createReferenceNativeProcessCollector(authority, {
      parentPid: process.pid,
      expectedProcessGroupId: process.pid,
      lifecycleEvent: (event) => lifecycle.push(event),
    });
    const child = await spawnBoundReferenceNativeProcess(collector, context(0), ["-v", "error"], { shell: false, stdio: "ignore" });
    await waitForClose(child);
    const evidence = await collector.seal();
    assert.equal(evidence.receiptCount, 1);
    assert.equal(evidence.parentPid, process.pid);
    assert.equal(evidence.expectedProcessGroupId, process.pid);
    assert.equal(evidence.executable.sha256, authority.evidence.sha256);
    assert.deepEqual(evidence.receipts[0].context, context(0));
    assert.equal(evidence.receipts[0].exit.code, 0);
    assert.equal(evidence.receipts[0].close.code, 0);
    assert.equal(evidence.receipts[0].spawned, true);
    assert.deepEqual(
      lifecycle.map((event) => (event as { phase: string }).phase),
      ["reserved", "launched", "spawn-confirmed", "exit", "close-verified"],
    );
    assert.equal(lifecycle.every((event) => Object.isFrozen(event)), true);
    assert.ok(Object.isFrozen(evidence) && Object.isFrozen(evidence.receipts));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bound native process lifecycle observer failure kills launch and remains fail-closed at seal", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-observer-failure-"));
  try {
    const authority = await bindReferenceNativeMediaTool(
      "ffprobe",
      await executable(root, "ffprobe-fixture.sh", "sleep 10\nexit 0"),
    );
    const collector = createReferenceNativeProcessCollector(authority, {
      lifecycleEvent(event) {
        if (event.phase === "launched") throw new Error("injected lifecycle sink failure");
      },
    });
    await assert.rejects(
      spawnBoundReferenceNativeProcess(collector, context(0), [], { shell: false, stdio: "ignore" }),
      /injected lifecycle sink failure/u,
    );
    await assert.rejects(collector.seal(), /injected lifecycle sink failure/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bound native process authority rejects duplicate ordinals and remains sealable", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-ordinal-"));
  try {
    const authority = await bindReferenceNativeMediaTool("ffprobe", await executable(root, "ffprobe-fixture.sh"));
    const collector = createReferenceNativeProcessCollector(authority);
    const child = await spawnBoundReferenceNativeProcess(collector, context(7), [], { shell: false, stdio: "ignore" });
    await assert.rejects(spawnBoundReferenceNativeProcess(collector, context(7), [], { shell: false, stdio: "ignore" }), /context ordinal was duplicated/u);
    await waitForClose(child);
    assert.equal((await collector.seal()).receiptCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bound native process authority fails closed on nonzero exit", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-exit-"));
  try {
    const authority = await bindReferenceNativeMediaTool("ffprobe", await executable(root, "ffprobe-fixture.sh", "exit 19"));
    const collector = createReferenceNativeProcessCollector(authority);
    const child = await spawnBoundReferenceNativeProcess(collector, context(0), [], { shell: false, stdio: "ignore" });
    await waitForClose(child);
    await assert.rejects(collector.seal(), /did not close successfully/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bound native process authority detects executable mutation before sealing", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-mutate-"));
  try {
    const path = await executable(root, "ffprobe-fixture.sh");
    const authority = await bindReferenceNativeMediaTool("ffprobe", path);
    const collector = createReferenceNativeProcessCollector(authority);
    const child = await spawnBoundReferenceNativeProcess(collector, context(0), [], { shell: false, stdio: "ignore" });
    await waitForClose(child);
    await writeFile(path, "#!/bin/sh\nexit 3\n");
    await chmod(path, 0o700);
    await assert.rejects(collector.seal(), executableMutationFailure);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bound native process authority detects mutation during an active child and isolates concurrent receipts", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-concurrent-"));
  try {
    const path = await executable(root, "ffprobe-fixture.sh", "sleep 0.05\nexit 0");
    const authority = await bindReferenceNativeMediaTool("ffprobe", path);
    const collector = createReferenceNativeProcessCollector(authority);
    const children = await Promise.all([
      spawnBoundReferenceNativeProcess(collector, context(0), [], { shell: false, stdio: "ignore" }),
      spawnBoundReferenceNativeProcess(collector, context(1), [], { shell: false, stdio: "ignore" }),
    ]);
    assert.notEqual(children[0].pid, children[1].pid);
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o700);
    await assert.rejects(collector.seal(), executableMutationFailure);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bound native process authority rejects malformed resource authority and forged collectors", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-hostile-"));
  try {
    const authority = await bindReferenceNativeMediaTool("ffprobe", await executable(root, "ffprobe-fixture.sh"));
    const collector = createReferenceNativeProcessCollector(authority);
    await assert.rejects(
      spawnBoundReferenceNativeProcess(collector, { ...context(0), resourceSha256: "bad" }, [], { shell: false, stdio: "ignore" }),
      /context is malformed/u,
    );
    await assert.rejects(
      spawnBoundReferenceNativeProcess({ ...collector } as typeof collector, context(1), [], { shell: false, stdio: "ignore" }),
      /collector was not issued/u,
    );
    assert.equal((await collector.seal()).receiptCount, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PATH resolution skips only absent candidates and fails closed on the first unsafe candidate", { skip: process.platform === "win32", concurrency: false }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-path-"));
  const previousPath = process.env.PATH;
  try {
    const missing = resolve(root, "missing");
    const notDirectory = resolve(root, "not-directory");
    const unsafe = resolve(root, "unsafe");
    const valid = resolve(root, "valid");
    await Promise.all([mkdir(unsafe), mkdir(valid)]);
    await writeFile(notDirectory, "not a directory\n");
    await executable(valid, "ffprobe");
    process.env.PATH = [notDirectory, missing, valid].join(delimiter);
    const authority = await bindReferenceNativeMediaTool("ffprobe");
    assert.equal(authority.tool, "ffprobe");

    const unsafePath = await executable(unsafe, "ffprobe");
    await chmod(unsafePath, 0o600);
    process.env.PATH = [unsafe, valid].join(delimiter);
    await assert.rejects(
      bindReferenceNativeMediaTool("ffprobe"),
      (error: unknown) => error instanceof ReferenceNativeProcessAuthorityError
        && error.code === "CUT_NATIVE_PROCESS_AUTHORITY"
        && error.tool === "ffprobe"
        && error.reason === "EXECUTABLE_FILE",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("bound native process authority rejects argv0 and unsupported spawn options before launch", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-options-"));
  try {
    const authority = await bindReferenceNativeMediaTool("ffprobe", await executable(root, "ffprobe-fixture.sh"));
    const collector = createReferenceNativeProcessCollector(authority);
    await assert.rejects(
      spawnBoundReferenceNativeProcess(collector, context(0), [], { shell: false, stdio: "ignore", argv0: "forged" }),
      /cannot override argv0/u,
    );
    await assert.rejects(
      spawnBoundReferenceNativeProcess(collector, context(1), [], { shell: false, stdio: "ignore", cwd: root }),
      /option cwd is unsupported/u,
    );
    await assert.rejects(
      spawnBoundReferenceNativeProcess(collector, context(2), [], { stdio: "ignore" }),
      /explicit shell:false/u,
    );
    assert.equal((await collector.seal()).receiptCount, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bound native process context enforces operation-specific stream-index presence", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-process-stream-index-"));
  try {
    const authority = await bindReferenceNativeMediaTool("ffprobe", await executable(root, "ffprobe-fixture.sh"));
    const collector = createReferenceNativeProcessCollector(authority);
    await assert.rejects(
      spawnBoundReferenceNativeProcess(collector, { ...context(0), streamIndex: 0 }, [], { shell: false, stdio: "ignore" }),
      /media-metadata native process context must omit streamIndex/u,
    );
    for (const [ordinal, operation] of [
      "decoded-video-cadence",
      "decoded-audio-pcm",
      "decoded-audio-samples",
      "audio-proxy-alignment",
      "video-proxy-alignment",
      "footage-frame-sample",
      "footage-range-extract",
    ].entries()) {
      await assert.rejects(
        spawnBoundReferenceNativeProcess(collector, { ...context(ordinal + 1), operation } as ReferenceNativeProcessContext, [], { shell: false, stdio: "ignore" }),
        new RegExp(`${operation} native process context requires one non-negative streamIndex`, "u"),
      );
    }
    const child = await spawnBoundReferenceNativeProcess(
      collector,
      { ...context(9), operation: "footage-frame-sample", streamIndex: 0 },
      [],
      { shell: false, stdio: "ignore" },
    );
    await waitForClose(child);
    const extractChild = await spawnBoundReferenceNativeProcess(
      collector,
      { ...context(10), operation: "footage-range-extract", streamIndex: 1 },
      [],
      { shell: false, stdio: "ignore" },
    );
    await waitForClose(extractChild);
    const evidence = await collector.seal();
    assert.equal(evidence.receipts[0].context.operation, "footage-frame-sample");
    assert.equal(evidence.receipts[0].context.streamIndex, 0);
    assert.equal(evidence.receipts[1].context.operation, "footage-range-extract");
    assert.equal(evidence.receipts[1].context.streamIndex, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
