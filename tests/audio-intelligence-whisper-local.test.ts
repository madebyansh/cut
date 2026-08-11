import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CutWhisperCppLocalError,
  cutWhisperCppLocalPolicy,
  isCutWhisperCppLocalPlatformSupported,
  transcribeWithWhisperCppLocal,
  type CutWhisperCppLocalErrorCode,
  type CutWhisperCppLocalInput,
} from "../lib/audio-intelligence/whisper-local";
import { stableJsonStringify } from "../lib/core/stable";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

test("platform admission fails closed where complete process-tree cleanup is unavailable", () => {
  assert.equal(isCutWhisperCppLocalPlatformSupported("darwin"), true);
  assert.equal(isCutWhisperCppLocalPlatformSupported("linux"), true);
  assert.equal(isCutWhisperCppLocalPlatformSupported("win32"), false);
  assert.equal(isCutWhisperCppLocalPlatformSupported("aix"), false);
});

type Fixture = Readonly<{
  root: string;
  executable: string;
  model: string;
  pcm: string;
  argvLog: string;
  marker: string;
  input: CutWhisperCppLocalInput;
}>;

function fakeSource(mode: string, argvLog: string, marker: string) {
  const result = {
    format: "cut-whisper-cpp-sample-transcription",
    version: 1,
    sampleRate: 16000,
    words: [
      { startSample: 1, endSample: 4000, text: "Hello" },
      { startSample: 4000, endSample: 8000, text: "," },
      { startSample: 8000, endSample: 16000, text: "world" },
    ],
  };
  return `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const modelFd = Number(args[args.indexOf("--model-fd") + 1]);
const pcmFd = Number(args[args.indexOf("--pcm-fd") + 1]);
const modelBytes = readFileSync(modelFd);
const pcmBytes = readFileSync(pcmFd);
const digest = value => createHash("sha256").update(value).digest("hex");
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({
  args,
  modelSha256: digest(modelBytes),
  pcmSha256: digest(pcmBytes),
}) + "\\n", { flag: "wx" });
if (mode === "malformed") process.stdout.write("{not-json\\n");
else if (mode === "unknown") process.stdout.write(JSON.stringify({ ...${JSON.stringify(result)}, unexpected: true }));
else if (mode === "overflow") process.stdout.write(JSON.stringify({ ...${JSON.stringify(result)}, words: [{ startSample: 0, endSample: 9007199254740992, text: "bad" }] }));
else if (mode === "nonzero") process.exit(17);
else if (mode === "mutate-private-executable") {
  appendFileSync(process.argv[1], "mutation");
  process.stdout.write(${JSON.stringify(JSON.stringify(result))});
}
else if (mode === "wait-after-read") {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ root: process.pid }) + "\\n", { flag: "wx" });
  setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(result))}), 250);
} else if (mode === "timeout") {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ root: process.pid, grandchild: grandchild.pid }) + "\\n", { flag: "wx" });
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else process.stdout.write(${JSON.stringify(JSON.stringify(result))});
`;
}

async function fixture(mode = "valid", sourceSampleRate = 44_100): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cut-whisper-local-")));
  const executable = resolve(root, "fake-whisper");
  const model = resolve(root, "model.bin");
  const pcm = resolve(root, "normalized.f32le");
  const argvLog = resolve(root, "argv.json");
  const marker = resolve(root, "pids.json");
  const executableBytes = Buffer.from(fakeSource(mode, argvLog, marker), "utf8");
  const modelBytes = Buffer.from("authenticated whisper model bytes\n", "utf8");
  const durationSamples = 16_000;
  const pcmBytes = Buffer.alloc(durationSamples * 4);
  await Promise.all([
    writeFile(executable, executableBytes, { flag: "wx" }),
    writeFile(model, modelBytes, { flag: "wx" }),
    writeFile(pcm, pcmBytes, { flag: "wx" }),
  ]);
  await chmod(executable, 0o700);
  const sourceDurationSamples = sourceSampleRate;
  const input: CutWhisperCppLocalInput = {
    executable: {
      path: executable,
      bytes: executableBytes.byteLength,
      sha256: sha256(executableBytes),
      revision: "fixture-whisper.cpp-v1",
    },
    model: {
      path: model,
      locator: "models/fixture.bin",
      bytes: modelBytes.byteLength,
      sha256: sha256(modelBytes),
      name: "fixture-base-en",
      revision: "fixture-model-v1",
      license: "MIT",
    },
    normalizedPcm: {
      path: pcm,
      bytes: pcmBytes.byteLength,
      sha256: sha256(pcmBytes),
      sampleFormat: "f32le",
      sampleRate: 16_000,
      channels: 1,
      durationSamples,
    },
    source: {
      locator: "media/interview.wav",
      bytes: 4_096,
      sha256: "a".repeat(64),
      streamIndex: 0,
      sampleRate: sourceSampleRate,
      durationSamples: sourceDurationSamples,
      normalizedPcmSha256: sha256(pcmBytes),
    },
    settings: { language: "en-US", temperatureMilli: 0, noFallback: true },
  };
  return Object.freeze({ root, executable, model, pcm, argvLog, marker, input });
}

async function cleanup(value: Fixture) {
  await rm(value.root, { recursive: true, force: true });
}

async function expectFailure(
  action: () => Promise<unknown>,
  code: CutWhisperCppLocalErrorCode,
  message?: RegExp,
) {
  await assert.rejects(action, (error: unknown) => (
    error instanceof CutWhisperCppLocalError
      && error.code === code
      && error.message.startsWith(`${code}:`)
      && (!message || message.test(error.message))
  ));
}

async function processGone(pid: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return true;
    }
    await new Promise((accept) => setTimeout(accept, 25));
  }
  return false;
}

async function privateRoots() {
  return (await readdir(await realpath(tmpdir())))
    .filter((name) => name.startsWith("cut-whisper-adapter-"))
    .sort();
}

test("executes one exact authenticated argv and materializes rational source-sample timestamps", async () => {
  const value = await fixture();
  try {
    const first = await transcribeWithWhisperCppLocal(value.input);
    const observed = JSON.parse(await readFile(value.argvLog, "utf8")) as {
      args: string[];
      modelSha256: string;
      pcmSha256: string;
    };
    assert.deepEqual(observed.args, [
      "--cut-sample-json-v1",
      "--model-fd", "3",
      "--pcm-fd", "4",
      "--sample-rate", "16000",
      "--language", "en-US",
      "--temperature-milli", "0",
      "--no-fallback", "true",
    ]);
    assert.equal(observed.modelSha256, value.input.model.sha256);
    assert.equal(observed.pcmSha256, value.input.normalizedPcm.sha256);
    assert.deepEqual(first.executionReceipt.invocation, [
      `cut-whisper-cpp-adapter-sha256:${value.input.executable.sha256}`,
      ...observed.args,
    ]);
    assert.equal(
      first.executionReceipt.invocationSha256,
      sha256(stableJsonStringify(first.executionReceipt.invocation)),
    );
    const receiptText = first.executionReceiptBytes.toString("utf8");
    for (const privatePath of [value.root, value.executable, value.model, value.pcm]) {
      assert.equal(receiptText.includes(privatePath), false);
    }
    assert.deepEqual(
      first.materialization.transcript.words.map(({ start, end, text, join }) => ({ start, end, text, join })),
      [
        {
          start: { numerator: "1", denominator: "14700" },
          end: { numerator: "1", denominator: "4" },
          text: "Hello",
          join: "none",
        },
        {
          start: { numerator: "1", denominator: "4" },
          end: { numerator: "1", denominator: "2" },
          text: ",",
          join: "none",
        },
        {
          start: { numerator: "1", denominator: "2" },
          end: { numerator: "1", denominator: "1" },
          text: "world",
          join: "space",
        },
      ],
    );
    assert.equal(first.materialization.receipt.backend.provider, cutWhisperCppLocalPolicy.provider);
    assert.equal(first.materialization.receipt.backend.modelFiles[0]!.sha256, value.input.model.sha256);
    assert.equal(first.executionReceipt.executable.sha256, value.input.executable.sha256);
    assert.equal(first.executionReceipt.normalizedPcm.sha256, value.input.normalizedPcm.sha256);
    assert.equal(first.executionReceipt.transcriptSha256, first.materialization.receipt.transcriptSha256);
    const { executionSha256, ...executionBody } = first.executionReceipt;
    assert.equal(
      executionSha256,
      sha256(stableJsonStringify(executionBody)),
    );
    assert.equal(first.transcriptBytes.toString("utf8"), `${stableJsonStringify(first.materialization.transcript)}\n`);
    assert.equal(
      first.transcriptionReceiptBytes.toString("utf8"),
      `${stableJsonStringify(first.materialization.receipt)}\n`,
    );
    assert.equal(first.executionReceiptBytes.toString("utf8"), `${stableJsonStringify(first.executionReceipt)}\n`);
    assert.deepEqual(
      (await readdir(value.root)).sort(),
      ["argv.json", "fake-whisper", "model.bin", "normalized.f32le"],
    );
  } finally {
    await cleanup(value);
  }
});

test("does not publish files and binds settings and output bytes into distinct receipts", async () => {
  const left = await fixture("valid");
  const right = await fixture("valid");
  try {
    const first = await transcribeWithWhisperCppLocal(left.input);
    const changed: CutWhisperCppLocalInput = {
      ...right.input,
      settings: { ...right.input.settings, temperatureMilli: 250, noFallback: false },
    };
    const second = await transcribeWithWhisperCppLocal(changed);
    assert.notEqual(first.executionReceipt.invocationSha256, second.executionReceipt.invocationSha256);
    assert.notEqual(first.materialization.receipt.receiptSha256, second.materialization.receipt.receiptSha256);
    assert.equal(first.materialization.receipt.transcriptSha256, second.materialization.receipt.transcriptSha256);
  } finally {
    await cleanup(left);
    await cleanup(right);
  }
});

test("rejects malformed, unknown-field, overflow, and nonzero provider results", async () => {
  for (const [mode, code] of [
    ["malformed", "CUT_WHISPER_LOCAL_OUTPUT"],
    ["unknown", "CUT_WHISPER_LOCAL_CONTRACT"],
    ["overflow", "CUT_WHISPER_LOCAL_OUTPUT"],
    ["nonzero", "CUT_WHISPER_LOCAL_PROCESS"],
  ] as const) {
    const value = await fixture(mode);
    try { await expectFailure(() => transcribeWithWhisperCppLocal(value.input), code); }
    finally { await cleanup(value); }
  }
});

test("rejects preflight authority mismatch and post-launch model mutation", async () => {
  const mismatch = await fixture();
  const mutation = await fixture("wait-after-read");
  const executableMutation = await fixture("mutate-private-executable");
  const temporaryRoot = await realpath(tmpdir());
  const privateRootsBefore = (await readdir(temporaryRoot))
    .filter((name) => name.startsWith("cut-whisper-adapter-"))
    .sort();
  try {
    await expectFailure(
      () => transcribeWithWhisperCppLocal({
        ...mismatch.input,
        executable: { ...mismatch.input.executable, sha256: "f".repeat(64) },
      }),
      "CUT_WHISPER_LOCAL_AUTHORITY",
      /caller-supplied authority/u,
    );
    const running = transcribeWithWhisperCppLocal(mutation.input);
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      try { await lstat(mutation.marker); break; }
      catch { await new Promise((accept) => setTimeout(accept, 1)); }
    }
    await lstat(mutation.marker);
    await appendFile(mutation.model, "mutation-after-retained-fd-read\n");
    await expectFailure(() => running, "CUT_WHISPER_LOCAL_AUTHORITY", /changed during/u);
    const consumed = JSON.parse(await readFile(mutation.argvLog, "utf8")) as { modelSha256: string };
    assert.equal(consumed.modelSha256, mutation.input.model.sha256);
    await expectFailure(
      () => transcribeWithWhisperCppLocal(executableMutation.input),
      "CUT_WHISPER_LOCAL_AUTHORITY",
      /private whisper\.cpp adapter changed/u,
    );
    assert.equal(sha256(await readFile(executableMutation.executable)), executableMutation.input.executable.sha256);
    assert.deepEqual(
      (await readdir(temporaryRoot)).filter((name) => name.startsWith("cut-whisper-adapter-")).sort(),
      privateRootsBefore,
    );
  } finally {
    await cleanup(mismatch);
    await cleanup(mutation);
    await cleanup(executableMutation);
  }
});

test("timeout kills and drains the complete private process group", { skip: process.platform === "win32" }, async () => {
  const value = await fixture("timeout");
  try {
    await expectFailure(
      () => transcribeWithWhisperCppLocal({ ...value.input, timeoutMs: 1_500 }),
      "CUT_WHISPER_LOCAL_TIMEOUT",
    );
    const pids = JSON.parse(await readFile(value.marker, "utf8")) as { root: number; grandchild: number };
    assert.equal(await processGone(pids.root), true);
    assert.equal(await processGone(pids.grandchild), true);
  } finally {
    await cleanup(value);
  }
});

test("contract rejects wrong PCM geometry, duration mismatch, and pre-aborted execution", async () => {
  const value = await fixture();
  try {
    await expectFailure(
      () => transcribeWithWhisperCppLocal({
        ...value.input,
        normalizedPcm: { ...value.input.normalizedPcm, sampleRate: 48_000 as 16_000 },
      }),
      "CUT_WHISPER_LOCAL_CONTRACT",
      /mono 16 kHz/u,
    );
    await expectFailure(
      () => transcribeWithWhisperCppLocal({
        ...value.input,
        source: { ...value.input.source, durationSamples: value.input.source.durationSamples - 1 },
      }),
      "CUT_WHISPER_LOCAL_CONTRACT",
      /rationally equal/u,
    );
    const controller = new AbortController();
    controller.abort();
    await expectFailure(
      () => transcribeWithWhisperCppLocal({ ...value.input, signal: controller.signal }),
      "CUT_WHISPER_LOCAL_CANCELLED",
    );
  } finally {
    await cleanup(value);
  }
});

test("invalid source and settings fail before the authenticated adapter launches", async () => {
  for (const mutate of [
    (input: CutWhisperCppLocalInput): CutWhisperCppLocalInput => ({
      ...input,
      source: { ...input.source, sha256: "not-a-digest" },
    }),
    (input: CutWhisperCppLocalInput): CutWhisperCppLocalInput => ({
      ...input,
      settings: { ...input.settings, language: "INVALID language" },
    }),
    (input: CutWhisperCppLocalInput): CutWhisperCppLocalInput => ({
      ...input,
      settings: { ...input.settings, temperatureMilli: 1_001 },
    }),
    (input: CutWhisperCppLocalInput): CutWhisperCppLocalInput => ({
      ...input,
      adapterSha256: "b".repeat(64),
    } as unknown as CutWhisperCppLocalInput),
  ]) {
    const value = await fixture();
    try {
      await expectFailure(
        () => transcribeWithWhisperCppLocal(mutate(value.input)),
        "CUT_WHISPER_LOCAL_CONTRACT",
      );
      await assert.rejects(() => lstat(value.argvLog), { code: "ENOENT" });
    } finally {
      await cleanup(value);
    }
  }
});

test("an invalid executable fails through the launch handler without residue or unhandled errors", async () => {
  const value = await fixture();
  const invalidBytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
  await writeFile(value.executable, invalidBytes);
  await chmod(value.executable, 0o700);
  const before = await privateRoots();
  try {
    await expectFailure(
      () => transcribeWithWhisperCppLocal({
        ...value.input,
        executable: {
          ...value.input.executable,
          bytes: invalidBytes.byteLength,
          sha256: sha256(invalidBytes),
        },
      }),
      "CUT_WHISPER_LOCAL_PROCESS",
      /start|launch/u,
    );
    assert.deepEqual(await privateRoots(), before);
  } finally {
    await cleanup(value);
  }
});

test("a source mutation during private-copy preparation fails and removes the owned private root", async () => {
  const value = await fixture();
  const padding = Buffer.concat([
    Buffer.from("\n/*", "utf8"),
    Buffer.alloc(64 * 1024 * 1024, 120),
    Buffer.from("*/\n", "utf8"),
  ]);
  await appendFile(value.executable, padding);
  const executableBytes = await readFile(value.executable);
  const input: CutWhisperCppLocalInput = {
    ...value.input,
    executable: {
      ...value.input.executable,
      bytes: executableBytes.byteLength,
      sha256: sha256(executableBytes),
    },
  };
  const before = await privateRoots();
  try {
    const running = transcribeWithWhisperCppLocal(input);
    let observedPrivateRoot = false;
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const current = await privateRoots();
      if (current.some((name) => !before.includes(name))) {
        observedPrivateRoot = true;
        break;
      }
      await new Promise((accept) => setTimeout(accept, 1));
    }
    assert.equal(observedPrivateRoot, true, "test did not observe private-copy preparation");
    await appendFile(value.executable, "mutated-during-copy\n");
    await expectFailure(() => running, "CUT_WHISPER_LOCAL_AUTHORITY", /changed/u);
    assert.deepEqual(await privateRoots(), before);
  } finally {
    await cleanup(value);
  }
});
