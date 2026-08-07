import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { stableJsonStringify } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock, validateEmbeddedLockedIrContract, type CutLockfile } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import {
  defaultReferenceVerifiedInputSessionLimits,
  createReferenceVerifiedInputNativeProcessLifecycleControllerForTest,
  planReferenceVerifiedInputNativeProcesses,
  prepareReferenceVerifiedInputSession,
  prepareReferenceVerifiedInputSessionForTest,
  prepareReferenceVerifiedInputSessionWithNativeProcessEvidence,
  ReferenceVerifiedInputSessionError,
  referenceVerifiedInputProbeConcurrency,
  type ReferenceVerifiedInputNativeProcessPlanEntry,
} from "../lib/runtime/reference/verified-input-session";
import type { ReferenceNativeProcessLifecycleEvent } from "../lib/project/native-process-authority";

const exec = promisify(execFile);

function sha256(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function sessionError(code: ReferenceVerifiedInputSessionError["code"], reason?: string) {
  return (error: unknown) => error instanceof ReferenceVerifiedInputSessionError
    && error.code === code
    && (reason === undefined || error.detail.reason === reason);
}

function missingPath(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function png(rgb: readonly [number, number, number]) {
  return sharp({ create: { width: 4, height: 4, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } } })
    .png({ compressionLevel: 0, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

async function video(path: string, color: string, size: number, codec: "ffv1" | "h264") {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${size}x${size}:r=4:d=1`,
    "-c:v", codec === "ffv1" ? "ffv1" : "libx264", "-pix_fmt", "yuv420p", path,
  ]);
}

async function videoProxy(input: string, output: string) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input,
    "-map", "0:v:0", "-vf", "scale=32:32:flags=lanczos",
    "-c:v", "libx264", "-crf", "26", "-pix_fmt", "yuv420p", output,
  ]);
}

async function audio(path: string, frequency: number, gain = 1) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=1`,
    "-filter:a", `volume=${gain}`, "-ac", "1", "-c:a", "pcm_s24le", path,
  ]);
}

const fullSource = `cut 0.4;
project "verified input session";
import { Image, Video } from "cut:visual";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("media/picture-master.mkv", proxy: "media/picture-proxy.mkv");
asset voice: AudioAsset = audio("media/voice-master.wav", proxy: "media/voice-proxy.wav");
asset still: ImageAsset = image("media/still.png");
asset face: FontAsset = font("media/face.bin");
asset facts: DataAsset = data("media/facts.json");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Video(source: picture, range: 0s ..< 1s);
    Image(source: still);
    AudioClip(source: voice, range: 0s ..< 1s);
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");
`;

async function fullFixture(root: string) {
  const media = resolve(root, "media"); await mkdir(media);
  const masterPicture = resolve(media, "picture-master.mkv");
  await Promise.all([
    video(masterPicture, "red", 64, "ffv1"),
    audio(resolve(media, "voice-master.wav"), 440),
    audio(resolve(media, "voice-proxy.wav"), 440, .8),
  ]);
  await videoProxy(masterPicture, resolve(media, "picture-proxy.mkv"));
  await Promise.all([
    png([220, 40, 30]).then((bytes) => writeFile(resolve(media, "still.png"), bytes)),
    writeFile(resolve(media, "face.bin"), Buffer.from("bounded font fixture\n")),
    writeFile(resolve(media, "facts.json"), Buffer.from('{"value":42}\n')),
  ]);
  const ir = compile(fullSource), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { ir, lock };
}

function lockedAggregate(lock: CutLockfile) {
  return Object.values(lock.resources).reduce((total, resource) => total + BigInt(resource.bytes) + BigInt(resource.proxy?.bytes ?? 0), 0n);
}

test("verified input native-process evidence binds every product probe lifecycle to locked resource bytes", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-native-evidence-"));
  try {
    const { ir, lock } = await fullFixture(root);
    const expectedPlan = planReferenceVerifiedInputNativeProcesses(ir);
    const lifecycleEvents: unknown[] = [];
    assert.ok(expectedPlan.entryCount > 5, "fixture must execute more than five sequential native helpers");
    const prepared = await prepareReferenceVerifiedInputSessionWithNativeProcessEvidence(ir, root, "proxy", {}, {
      expectedPlan,
      lifecycleEvent: (event) => { lifecycleEvents.push(event); },
    });
    try {
      assert.equal(prepared.nativeProcesses.parentPid, process.pid);
      assert.equal(prepared.nativeProcesses.expectedProcessGroupId, process.pid);
      assert.deepEqual(prepared.nativeProcesses.tools.map((tool) => tool.executable.tool), ["ffmpeg", "ffprobe"]);
      assert.ok(prepared.nativeProcesses.receiptCount >= 8, "metadata, decoded witnesses, and proxy alignments must all execute through bound tools");
      assert.deepEqual(prepared.nativeProcessPlan, expectedPlan);
      assert.equal(prepared.nativeProcessLifecycle.completedCount, expectedPlan.entryCount);
      assert.equal(prepared.nativeProcessLifecycle.eventCount, expectedPlan.entryCount * 5);
      assert.equal(prepared.nativeProcessLifecycle.peakUnresolvedProcesses <= 5, true);
      assert.equal(lifecycleEvents.length, expectedPlan.entryCount * 5);
      for (let index = 0; index < lifecycleEvents.length; index += 1) {
        const event = lifecycleEvents[index] as { sequence: number; previousEventSha256: string | null; eventSha256: string };
        assert.equal(event.sequence, index);
        assert.equal(event.previousEventSha256, index === 0 ? null : (lifecycleEvents[index - 1] as typeof event).eventSha256);
      }
      const pids = new Set<number>();
      for (const tool of prepared.nativeProcesses.tools) {
        assert.equal(tool.parentPid, process.pid);
        assert.equal(tool.expectedProcessGroupId, process.pid);
        for (const receipt of tool.receipts) {
          assert.equal(pids.has(receipt.childPid), false, "one child pid cannot authorize two lifecycle receipts");
          pids.add(receipt.childPid);
          const locked = lock.resources[receipt.context.resourceId];
          assert.ok(locked, `receipt resource ${receipt.context.resourceId} must be locked`);
          const expected = receipt.context.variant === "master" ? locked : locked.proxy;
          assert.ok(expected, `receipt variant ${receipt.context.variant} must exist`);
          assert.equal(receipt.context.resourceSha256, expected.sha256);
          assert.equal(receipt.context.resourceBytes, expected.bytes);
          assert.equal(receipt.exit.code, 0);
          assert.equal(receipt.close.code, 0);
        }
      }
    } finally { await prepared.session.cleanup(); }

    const forgedPlan = structuredClone(expectedPlan);
    (forgedPlan.entries[0].context as { resourceSha256: string }).resourceSha256 = "0".repeat(64);
    await assert.rejects(
      prepareReferenceVerifiedInputSessionWithNativeProcessEvidence(ir, root, "proxy", {}, {
        expectedPlan: forgedPlan,
        lifecycleEvent: () => {},
      }),
      sessionError("CUT_INPUT_SESSION_PROBE", "native-process-plan-mismatch"),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

function syntheticLifecycleEvent(
  entry: ReferenceVerifiedInputNativeProcessPlanEntry,
  phase: ReferenceNativeProcessLifecycleEvent["phase"],
  childPid: number | null,
  overrides: Partial<ReferenceNativeProcessLifecycleEvent> = {},
): ReferenceNativeProcessLifecycleEvent {
  const terminal = phase === "exit" || phase === "close-verified"
    ? { code: 0, signal: null }
    : undefined;
  return {
    format: "cut-reference-native-process-lifecycle-event",
    version: 1,
    phase,
    receiptId: entry.entryId,
    tool: entry.tool,
    context: entry.context,
    executable: {
      tool: entry.tool,
      canonicalPathSha256: "1".repeat(64),
      bytes: 4096,
      sha256: "2".repeat(64),
      stat: { dev: "1", ino: "2", size: "4096", mtimeNs: "3", ctimeNs: "4" },
    },
    argvCount: 3,
    argvSha256: "3".repeat(64),
    parentPid: process.pid,
    expectedProcessGroupId: null,
    childPid,
    ...(terminal === undefined ? {} : { terminal }),
    ...overrides,
  };
}

function completeSyntheticLifecycle(
  controller: ReturnType<typeof createReferenceVerifiedInputNativeProcessLifecycleControllerForTest>,
  entry: ReferenceVerifiedInputNativeProcessPlanEntry,
  childPid: number,
) {
  controller.issue(entry.tool, entry.context);
  controller.observe(syntheticLifecycleEvent(entry, "reserved", null));
  controller.observe(syntheticLifecycleEvent(entry, "launched", childPid));
  controller.observe(syntheticLifecycleEvent(entry, "spawn-confirmed", childPid));
  controller.observe(syntheticLifecycleEvent(entry, "exit", childPid));
  controller.observe(syntheticLifecycleEvent(entry, "close-verified", childPid));
}

test("native helper plan retires sequential lifecycles and rejects concurrency, PID reuse, ancestry drift, and missing receipts", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-native-lifecycle-controller-"));
  try {
    const { ir } = await fullFixture(root);
    const plan = planReferenceVerifiedInputNativeProcesses(ir);
    assert.ok(plan.entryCount > 5);

    const events: unknown[] = [];
    const sequential = createReferenceVerifiedInputNativeProcessLifecycleControllerForTest(plan, (event) => events.push(event));
    plan.entries.forEach((entry, index) => completeSyntheticLifecycle(sequential, entry, 20_000 + index));
    const evidence = sequential.seal(plan.entryCount);
    assert.equal(evidence.completedCount, plan.entryCount);
    assert.equal(evidence.peakUnresolvedProcesses, 1);
    assert.equal(events.length, plan.entryCount * 5);

    // An exited helper no longer consumes live-process admission while its
    // close receipt performs asynchronous executable revalidation. More than
    // five such sequential helpers must remain admissible, while every
    // lifecycle still has to reach close-verified before sealing.
    const delayedClose = createReferenceVerifiedInputNativeProcessLifecycleControllerForTest(plan);
    for (const [index, entry] of plan.entries.slice(0, 6).entries()) {
      delayedClose.issue(entry.tool, entry.context);
      delayedClose.observe(syntheticLifecycleEvent(entry, "reserved", null));
      delayedClose.observe(syntheticLifecycleEvent(entry, "launched", 25_000 + index));
      delayedClose.observe(syntheticLifecycleEvent(entry, "spawn-confirmed", 25_000 + index));
      delayedClose.observe(syntheticLifecycleEvent(entry, "exit", 25_000 + index));
    }
    for (const [index, entry] of plan.entries.slice(0, 6).entries()) {
      delayedClose.observe(syntheticLifecycleEvent(entry, "close-verified", 25_000 + index));
    }
    for (const [index, entry] of plan.entries.slice(6).entries()) {
      completeSyntheticLifecycle(delayedClose, entry, 26_000 + index);
    }
    const delayedCloseEvidence = delayedClose.seal(plan.entryCount);
    assert.equal(delayedCloseEvidence.completedCount, plan.entryCount);
    assert.equal(delayedCloseEvidence.peakUnresolvedProcesses, 1);

    const exitedWithoutClose = createReferenceVerifiedInputNativeProcessLifecycleControllerForTest(plan);
    for (const [index, entry] of plan.entries.entries()) {
      exitedWithoutClose.issue(entry.tool, entry.context);
      exitedWithoutClose.observe(syntheticLifecycleEvent(entry, "reserved", null));
      exitedWithoutClose.observe(syntheticLifecycleEvent(entry, "launched", 27_000 + index));
      exitedWithoutClose.observe(syntheticLifecycleEvent(entry, "spawn-confirmed", 27_000 + index));
      exitedWithoutClose.observe(syntheticLifecycleEvent(entry, "exit", 27_000 + index));
    }
    assert.throws(
      () => exitedWithoutClose.seal(plan.entryCount),
      sessionError("CUT_INPUT_SESSION_PROBE", "native-process-plan-incomplete"),
      "terminal exit retires live admission but cannot substitute for authenticated close evidence",
    );

    const concurrent = createReferenceVerifiedInputNativeProcessLifecycleControllerForTest(plan);
    for (const entry of plan.entries.slice(0, 6)) concurrent.issue(entry.tool, entry.context);
    for (const [index, entry] of plan.entries.slice(0, 5).entries()) {
      concurrent.observe(syntheticLifecycleEvent(entry, "reserved", null));
      concurrent.observe(syntheticLifecycleEvent(entry, "launched", 30_000 + index));
    }
    assert.throws(
      () => concurrent.observe(syntheticLifecycleEvent(plan.entries[5], "reserved", null)),
      sessionError("CUT_INPUT_SESSION_PROBE", "native-process-concurrency"),
    );

    const reused = createReferenceVerifiedInputNativeProcessLifecycleControllerForTest(plan);
    completeSyntheticLifecycle(reused, plan.entries[0], 40_000);
    reused.issue(plan.entries[1].tool, plan.entries[1].context);
    reused.observe(syntheticLifecycleEvent(plan.entries[1], "reserved", null));
    assert.throws(
      () => reused.observe(syntheticLifecycleEvent(plan.entries[1], "launched", 40_000)),
      sessionError("CUT_INPUT_SESSION_PROBE", "native-process-launch"),
    );

    const ancestry = createReferenceVerifiedInputNativeProcessLifecycleControllerForTest(plan);
    ancestry.issue(plan.entries[0].tool, plan.entries[0].context);
    assert.throws(
      () => ancestry.observe(syntheticLifecycleEvent(plan.entries[0], "reserved", null, { parentPid: process.pid + 1 })),
      sessionError("CUT_INPUT_SESSION_PROBE", "native-process-event-authority"),
    );

    const incomplete = createReferenceVerifiedInputNativeProcessLifecycleControllerForTest(plan);
    completeSyntheticLifecycle(incomplete, plan.entries[0], 50_000);
    assert.throws(
      () => incomplete.seal(1),
      sessionError("CUT_INPUT_SESSION_PROBE", "native-process-plan-incomplete"),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verified input session snapshots every media/bytes/image variant, selects master/proxy paths, and outlives same-size source replacement", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-all-"));
  try {
    const { ir, lock } = await fullFixture(root), aggregate = lockedAggregate(lock);
    assert.deepEqual(Object.fromEntries(Object.entries(ir.resources).map(([id, resource]) => [id, resource.kind])), {
      face: "font", facts: "data", picture: "video", still: "image", voice: "audio",
    });

    await assert.rejects(
      prepareReferenceVerifiedInputSession(ir, root, "master", { limits: { maxAggregateBytes: aggregate - 1n } }),
      sessionError("CUT_INPUT_SESSION_RESOURCE_LIMIT", "aggregate-bytes"),
    );
    await assert.rejects(
      prepareReferenceVerifiedInputSession(ir, root, "master", { limits: { maxFileBytes: BigInt(lock.resources.picture.bytes) - 1n } }),
      sessionError("CUT_INPUT_SESSION_RESOURCE_LIMIT", "file-bytes"),
    );

    const master = await prepareReferenceVerifiedInputSession(ir, root, "master", { limits: { maxAggregateBytes: aggregate } });
    assert.equal(master.evidence.variantCount, 7);
    assert.equal(master.evidence.aggregateBytes, aggregate.toString());
    assert.equal(master.evidence.verificationOrder, "snapshot-all-then-probe-all");
    assert.deepEqual(new Set(master.evidence.variants.map((item) => item.probeKind)), new Set(["media", "image", "bytes"]));
    assert.deepEqual(master.evidence.variants.filter((item) => item.selected).map((item) => item.resourceId).sort(), ["face", "facts", "picture", "still", "voice"]);
    assert.equal(master.media.requested, "master");
    assert.equal(master.media.selectedProxyResources, 0);
    assert.ok(!stableGraph(master.ir).includes(".cut-inputs-"), "random session paths cannot enter IR/build identity");

    const sessionRoot = dirname(master.pathFor("still"));
    assert.match(relative(await realpath(root), sessionRoot).split("\\").join("/"), /^\.cut\/cache\/reference\/\.cut-inputs-[a-f0-9]{32}$/u);
    const mode = (await stat(sessionRoot)).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o700);
    const snapshotNames = await readdir(sessionRoot);
    assert.equal(snapshotNames.length, master.evidence.variantCount, "all variants are copied even though only one profile is selected");
    const remainingSnapshots = await Promise.all(snapshotNames.map(async (name) => {
      const path = resolve(sessionRoot, name);
      return { path, sha256: sha256(await readFile(path)), metadata: await lstat(path, { bigint: true }) };
    }));
    const expectedVariants = Object.values(lock.resources).flatMap((resource) => [
      { locator: resource.locator, sha256: resource.sha256 },
      ...(resource.proxy ? [{ locator: resource.proxy.locator, sha256: resource.proxy.sha256 }] : []),
    ]);
    for (const expected of expectedVariants) {
      const index = remainingSnapshots.findIndex((snapshot) => snapshot.sha256 === expected.sha256);
      assert.notEqual(index, -1, `private snapshots must include locked variant ${expected.locator}`);
      const [snapshot] = remainingSnapshots.splice(index, 1), source = await lstat(resolve(root, expected.locator), { bigint: true });
      assert.ok(source.dev !== snapshot.metadata.dev || source.ino !== snapshot.metadata.ino, `${expected.locator} must be copied to an inode-independent snapshot`);
    }
    assert.deepEqual(remainingSnapshots, [], "private snapshots must contain exactly the locked master and proxy bytes");
    for (const resource of Object.values(lock.resources)) {
      assert.equal(sha256(await readFile(master.pathFor(resource.id))), resource.sha256);
    }

    const reversed = structuredClone(ir);
    reversed.resources = Object.fromEntries(Object.entries(reversed.resources).reverse());
    await assert.rejects(
      () => prepareReferenceVerifiedInputSession(reversed, root, "master", { limits: { maxAggregateBytes: aggregate } }),
      (error: unknown) => error instanceof ReferenceVerifiedInputSessionError
        && error.code === "CUT_INPUT_SESSION_LOCK_STATE"
        && Boolean(error.cause && typeof error.cause === "object" && "code" in error.cause && error.cause.code === "CUT_PROXY_LOCK_STATE"),
      "serialized/cloned CutAVIR remains inspection evidence and cannot regain invocation-local execution authority",
    );
    const evidence = stableJsonStringify(master.evidence);
    assert.ok(!evidence.includes(root) && !evidence.includes(".cut-inputs-"), "verified-input evidence must remain path-free");

    const originalStill = await readFile(resolve(root, "media/still.png")), replacement = await png([30, 40, 220]);
    assert.equal(replacement.byteLength, originalStill.byteLength, "replacement fixture must be same-size and independently valid");
    await writeFile(resolve(root, "media/still.png"), replacement);
    assert.equal(sha256(await readFile(master.pathFor("still"))), sha256(originalStill), "prepared snapshots remain bound to the original bytes");
    assert.notEqual(sha256(await readFile(master.pathFor("still"))), sha256(replacement));
    assert.throws(() => master.pathFor("missing"), sessionError("CUT_INPUT_SESSION_CONTRACT", "unknown-resource"));
    await master.cleanup();
    await master.cleanup();
    assert.throws(() => master.pathFor("still"), sessionError("CUT_INPUT_SESSION_CONTRACT", "session-cleaned"));
    await assert.rejects(lstat(sessionRoot), missingPath);

    await writeFile(resolve(root, "media/still.png"), originalStill);
    const proxy = await prepareReferenceVerifiedInputSession(ir, root, "proxy");
    assert.equal(proxy.media.requested, "proxy");
    assert.equal(proxy.media.selectedProxyResources, 2);
    assert.equal(proxy.media.fallbackResources, 0);
    assert.equal(sha256(await readFile(proxy.pathFor("picture"))), lock.resources.picture.proxy!.sha256);
    assert.equal(sha256(await readFile(proxy.pathFor("voice"))), lock.resources.voice.proxy!.sha256);
    assert.equal(sha256(await readFile(proxy.pathFor("still"))), lock.resources.still.sha256);
    assert.deepEqual(proxy.evidence.variants.filter((item) => item.selected).map((item) => `${item.resourceId}:${item.variant}`).sort(), [
      "face:master", "facts:master", "picture:proxy", "still:master", "voice:proxy",
    ]);
    await proxy.cleanup();

    const unselectedProxy = resolve(root, lock.resources.voice.proxy!.locator), originalProxy = await readFile(unselectedProxy);
    const driftedProxy = Buffer.from(originalProxy); driftedProxy[Math.floor(driftedProxy.byteLength / 2)] ^= 1;
    await writeFile(unselectedProxy, driftedProxy);
    await assert.rejects(prepareReferenceVerifiedInputSession(ir, root, "master"), sessionError("CUT_LOCK_INTEGRITY", "sha256"));
    await writeFile(unselectedProxy, originalProxy);
    const leftovers = await readdir(resolve(root, ".cut/cache/reference"));
    assert.deepEqual(leftovers.filter((name) => name.startsWith(".cut-inputs-")), [], "failure cleans every partial snapshot session");
  } finally { await rm(root, { recursive: true, force: true }); }
});

function stableGraph(ir: CutAVIR) { return JSON.stringify(ir); }

const bytesSource = `cut 0.4;
project "verified bytes";
asset facts: DataAsset = data("media/facts.bin");
timeline main(duration: 1s, fps: 4) { scene only(duration: 1s) {} }
export out = render(main);
`;

async function bytesFixture(root: string) {
  await mkdir(resolve(root, "media"));
  await writeFile(resolve(root, "media/facts.bin"), Buffer.from("locked-data\n"));
  const ir = compile(bytesSource), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  return { ir, lock };
}

test("verified input session rejects malformed embedded lock state before creating .cut", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-lock-state-"));
  try {
    const { ir } = await bytesFixture(root);
    await rm(resolve(root, ".cut"), { recursive: true, force: true });
    const hostile = structuredClone(ir), metadata = hostile.resources.facts.metadata as Record<string, unknown>;
    metadata.invented = true;
    finalizeGraphHashes(hostile);

    assert.throws(
      () => validateEmbeddedLockedIrContract(hostile),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_LOCK_STATE"),
      "pure embedded-lock validation must retain its closed metadata diagnostic",
    );

    await assert.rejects(
      prepareReferenceVerifiedInputSession(hostile, root, "master"),
      (error: unknown) => sessionError("CUT_INPUT_SESSION_LOCK_STATE", "canonical-lock-state")(error)
        && Boolean(error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause && error.cause.code === "CUT_PROXY_LOCK_STATE"),
    );
    await assert.rejects(lstat(resolve(root, ".cut")), missingPath);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verified input session enforces exact hard bigint ceilings and maxFileBytes ordering", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-limits-"));
  try {
    const { ir, lock } = await bytesFixture(root);
    await rm(resolve(root, ".cut"), { recursive: true, force: true });
    await assert.rejects(
      prepareReferenceVerifiedInputSession(ir, root, "master", { limits: { maxFileBytes: defaultReferenceVerifiedInputSessionLimits.maxFileBytes + 1n } }),
      sessionError("CUT_INPUT_SESSION_CONTRACT", "max-file-bytes"),
    );
    await assert.rejects(
      prepareReferenceVerifiedInputSession(ir, root, "master", { limits: { maxAggregateBytes: defaultReferenceVerifiedInputSessionLimits.maxAggregateBytes + 1n } }),
      sessionError("CUT_INPUT_SESSION_CONTRACT", "max-aggregate-bytes"),
    );
    await assert.rejects(
      prepareReferenceVerifiedInputSession(ir, root, "master", { limits: { maxFileBytes: 2n, maxAggregateBytes: 1n } }),
      sessionError("CUT_INPUT_SESSION_CONTRACT", "limit-order"),
    );
    await assert.rejects(lstat(resolve(root, ".cut")), missingPath);

    const exactResourceBytes = BigInt(lock.resources.facts.bytes);
    const equal = await prepareReferenceVerifiedInputSession(ir, root, "master", {
      limits: { maxFileBytes: exactResourceBytes, maxAggregateBytes: exactResourceBytes },
    });
    await equal.cleanup();
    const hardCeilings = await prepareReferenceVerifiedInputSession(ir, root, "master", {
      limits: {
        maxFileBytes: defaultReferenceVerifiedInputSessionLimits.maxFileBytes,
        maxAggregateBytes: defaultReferenceVerifiedInputSessionLimits.maxAggregateBytes,
      },
    });
    await hardCeilings.cleanup();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verified input session rejects pre-snapshot corruption and unsafe source/session paths without leaving private input directories", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-safety-"));
  const external = await mkdtemp(resolve(tmpdir(), "cut-verified-input-external-"));
  try {
    const { ir } = await bytesFixture(root), path = resolve(root, "media/facts.bin"), original = await readFile(path);
    const corrupt = Buffer.from(original); corrupt[0] ^= 1; await writeFile(path, corrupt);
    await assert.rejects(prepareReferenceVerifiedInputSession(ir, root, "master"), sessionError("CUT_LOCK_INTEGRITY", "sha256"));
    assert.deepEqual((await readdir(resolve(root, ".cut/cache/reference"))).filter((name) => name.startsWith(".cut-inputs-")), []);

    await writeFile(path, original);
    const outside = resolve(external, "outside.bin"); await writeFile(outside, original); await unlink(path);
    let symlinkCreated = true;
    try { await symlink(outside, path, "file"); }
    catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code))) symlinkCreated = false; else throw error; }
    if (symlinkCreated) {
      await assert.rejects(
        prepareReferenceVerifiedInputSession(ir, root, "master"),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUTP1014"),
      );
      assert.equal(await readFile(outside, "utf8"), original.toString("utf8"));
      assert.deepEqual((await readdir(resolve(root, ".cut/cache/reference"))).filter((name) => name.startsWith(".cut-inputs-")), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});

test("verified input session refuses a symlinked private-cache parent before writing snapshots", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-parent-"));
  const external = await mkdtemp(resolve(tmpdir(), "cut-verified-input-parent-external-"));
  try {
    const { ir } = await bytesFixture(root);
    let symlinkCreated = true;
    try { await symlink(external, resolve(root, ".cut"), "dir"); }
    catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code))) symlinkCreated = false; else throw error; }
    if (symlinkCreated) {
      await assert.rejects(prepareReferenceVerifiedInputSession(ir, root, "master"), sessionError("CUT_INPUT_SESSION_PATH", "parent-structure"));
      assert.deepEqual(await readdir(external), [], "a symlinked cache target must remain untouched");
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});

test("bounded native probing preserves serial identity and stable selected-resource ordering", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-probe-parity-"));
  try {
    const { ir } = await fullFixture(root);
    const serial = await prepareReferenceVerifiedInputSessionForTest(ir, root, "master", {}, { probeConcurrency: 1 });
    const serialEvidence = structuredClone(serial.evidence);
    const serialIr = stableGraph(serial.ir);
    const serialSelected = await Promise.all(Object.keys(ir.resources).sort().map(async (resourceId) => ({
      resourceId,
      sha256: sha256(await readFile(serial.pathFor(resourceId))),
    })));
    await serial.cleanup();

    let active = 0, maximumActive = 0;
    const starts: number[] = [], settled: number[] = [];
    const concurrent = await prepareReferenceVerifiedInputSessionForTest(ir, root, "master", {}, {
      async probeEvent(event) {
        if (event.phase === "start") {
          starts.push(event.ordinal);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          // Keep each task observable long enough for the fixed-width wave to
          // fill without replacing the real native probe.
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 8));
        } else {
          settled.push(event.ordinal);
          active -= 1;
        }
      },
    });
    const concurrentSelected = await Promise.all(Object.keys(ir.resources).sort().map(async (resourceId) => ({
      resourceId,
      sha256: sha256(await readFile(concurrent.pathFor(resourceId))),
    })));

    assert.deepEqual(concurrent.evidence, serialEvidence, "concurrency must not enter path-free result identity");
    assert.equal(stableGraph(concurrent.ir), serialIr);
    assert.deepEqual(concurrentSelected, serialSelected);
    assert.deepEqual(
      concurrent.evidence.variants.map((variant) => `${variant.resourceId}:${variant.variant}`),
      serialEvidence.variants.map((variant) => `${variant.resourceId}:${variant.variant}`),
      "published variants retain canonical resource/variant order",
    );
    assert.ok(maximumActive > 1, "fixture must exercise concurrent probing");
    assert.ok(maximumActive <= referenceVerifiedInputProbeConcurrency);
    assert.equal(active, 0);
    assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual([...settled].sort((left, right) => left - right), starts);
    await concurrent.cleanup();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded native probing chooses failures by stable ordinal and drains the wave before transactional cleanup", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-probe-failure-"));
  try {
    const { ir } = await fullFixture(root);
    let active = 0;
    const starts: number[] = [], settlements: Array<Readonly<{ ordinal: number; status: string | undefined }>> = [];
    await assert.rejects(
      prepareReferenceVerifiedInputSessionForTest(ir, root, "master", {}, {
        probeConcurrency: referenceVerifiedInputProbeConcurrency,
        async probeEvent(event) {
          if (event.phase === "start") {
            starts.push(event.ordinal);
            active += 1;
            if (event.ordinal === 1) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
              throw new Error("injected earlier-ordinal probe failure");
            }
            if (event.ordinal === 2) throw new Error("injected faster later-ordinal probe failure");
          } else {
            settlements.push({ ordinal: event.ordinal, status: event.status });
            active -= 1;
          }
        },
      }),
      (error: unknown) => error instanceof ReferenceVerifiedInputSessionError
        && error.code === "CUT_INPUT_SESSION_PROBE"
        && error.detail.reason === "native-probe"
        && error.detail.resourceId === "facts"
        && error.source?.resourceId === "facts"
        && error.cause instanceof Error
        && error.cause.message === "injected earlier-ordinal probe failure",
      "the first ordinal failure in a completed wave wins even when a later failure settles first",
    );
    assert.deepEqual(starts, [0, 1, 2, 3], "a failed wave must not admit later work");
    assert.equal(active, 0, "every started native-probe task must settle before rejection");
    assert.deepEqual([...settlements].map((event) => event.ordinal).sort((left, right) => left - right), starts);
    assert.deepEqual(
      (await readdir(resolve(root, ".cut/cache/reference"))).filter((name) => name.startsWith(".cut-inputs-")),
      [],
      "mid-wave failure removes the complete private session",
    );
    const settledCount = settlements.length;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    assert.equal(settlements.length, settledCount, "no probe task or subprocess wrapper remains orphaned after rejection");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failing native ffprobe subprocesses drain before the stable source-specific session failure and cleanup", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-native-drain-"));
  try {
    const { ir } = await fullFixture(root);
    const pids = resolve(root, "native-probe-pids.txt");
    const settled = resolve(root, "native-probe-settled.txt");
    const executable = resolve(root, "failing-ffprobe.sh");
    const shellPath = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(executable, [
      "#!/bin/sh",
      `printf '%s\\n' "$$" >> ${shellPath(pids)}`,
      "sleep 0.05",
      `printf '%s\\n' "$$" >> ${shellPath(settled)}`,
      "exit 19",
      "",
    ].join("\n"));
    await chmod(executable, 0o700);
    let active = 0;
    await assert.rejects(
      prepareReferenceVerifiedInputSessionForTest(ir, root, "master", {}, {
        nativeExecutables: { ffprobe: executable },
        probeEvent(event) {
          active += event.phase === "start" ? 1 : -1;
        },
      }),
      (error: unknown) => error instanceof ReferenceVerifiedInputSessionError
        && error.code === "CUT_INPUT_SESSION_PROBE"
        && error.detail.reason === "native-probe"
        && error.detail.resourceId === "picture"
        && error.source?.resourceId === "picture"
        && error.cause instanceof Error
        && error.cause.message.includes("ffprobe exited with 19"),
    );
    assert.equal(active, 0, "every admitted native probe must reach its settled boundary");
    const startedPids = (await readFile(pids, "utf8")).trim().split(/\s+/u).map(Number);
    const settledPids = (await readFile(settled, "utf8")).trim().split(/\s+/u).map(Number);
    assert.ok(startedPids.length >= 2, "both media variants in the failed wave must start real subprocesses");
    assert.deepEqual(settledPids.sort((left, right) => left - right), startedPids.sort((left, right) => left - right));
    for (const pid of startedPids) {
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH"),
        `native probe pid ${pid} must be gone before session rejection`,
      );
    }
    assert.deepEqual(
      (await readdir(resolve(root, ".cut/cache/reference"))).filter((name) => name.startsWith(".cut-inputs-")),
      [],
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-probe stat, read, lstat, and close failures use stable source-specific diagnostics", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-post-probe-errors-"));
  try {
    const { ir } = await bytesFixture(root);
    for (const operation of ["post-probe-stat", "post-probe-read", "post-probe-lstat", "post-probe-close"] as const) {
      let injected = false;
      await assert.rejects(
        prepareReferenceVerifiedInputSessionForTest(ir, root, "master", {}, {
          operationEvent(event) {
            if (!injected && event.operation === operation) {
              injected = true;
              throw new Error(`injected ${operation}`);
            }
          },
        }),
        (error: unknown) => error instanceof ReferenceVerifiedInputSessionError
          && error.code === "CUT_INPUT_SESSION_PATH"
          && error.detail.reason === operation
          && error.detail.resourceId === "facts"
          && error.detail.variant === "master"
          && error.source?.resourceId === "facts"
          && error.cause instanceof Error
          && error.cause.message === `injected ${operation}`,
      );
      assert.equal(injected, true);
      assert.deepEqual(
        (await readdir(resolve(root, ".cut/cache/reference"))).filter((name) => name.startsWith(".cut-inputs-")),
        [],
        `${operation} failure must transactionally remove the private session`,
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("primary verification and cleanup failures remain independently durable after physical cleanup", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-dual-failure-"));
  try {
    const { ir } = await bytesFixture(root);
    await assert.rejects(
      prepareReferenceVerifiedInputSessionForTest(ir, root, "master", {}, {
        operationEvent(event) {
          if (event.operation === "post-probe-read") throw new Error("injected primary read failure");
          if (event.operation === "cleanup-complete") throw new Error("injected cleanup completion failure");
        },
      }),
      (error: unknown) => error instanceof ReferenceVerifiedInputSessionError
        && error.code === "CUT_INPUT_SESSION_PATH"
        && error.detail.reason === "post-probe-read"
        && error.cause instanceof Error
        && error.cause.message === "injected primary read failure"
        && error.cleanupFailure instanceof ReferenceVerifiedInputSessionError
        && error.cleanupFailure.code === "CUT_INPUT_SESSION_PATH"
        && error.cleanupFailure.detail.reason === "cleanup-complete"
        && error.cleanupFailure.cause instanceof Error
        && error.cleanupFailure.cause.message === "injected cleanup completion failure",
    );
    assert.deepEqual(
      (await readdir(resolve(root, ".cut/cache/reference"))).filter((name) => name.startsWith(".cut-inputs-")),
      [],
      "the injected cleanup report happens only after the physical private session is removed",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("hostile aggregate budget refusal happens before session allocation or concurrent probe work", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-verified-input-probe-budget-"));
  try {
    const { ir, lock } = await fullFixture(root), aggregate = lockedAggregate(lock);
    await rm(resolve(root, ".cut"), { recursive: true, force: true });
    let probeEvents = 0;
    await assert.rejects(
      prepareReferenceVerifiedInputSessionForTest(
        ir,
        root,
        "master",
        { limits: { maxAggregateBytes: aggregate - 1n } },
        { probeEvent() { probeEvents += 1; } },
      ),
      sessionError("CUT_INPUT_SESSION_RESOURCE_LIMIT", "aggregate-bytes"),
    );
    assert.equal(probeEvents, 0);
    await assert.rejects(lstat(resolve(root, ".cut")), missingPath);
  } finally { await rm(root, { recursive: true, force: true }); }
});
