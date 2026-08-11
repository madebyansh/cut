import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CutWhisperLocalWorkflowError,
  cutWhisperLocalWorkflowTestOnly,
  cutWhisperLocalWorkflowContract,
  doctorCutWhisperLocalSetup,
  parseCutWhisperLocalSetup,
  type CutWhisperLocalSetup,
  type CutWhisperLocalTranscriptionInput,
  type CutWhisperLocalWorkflowErrorCode,
} from "../lib/audio-intelligence/whisper-workflow";
import { stableJsonStringify } from "../lib/core/stable";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function wave(samples = 16_000) {
  const pcm = Buffer.alloc(samples * 2);
  const result = Buffer.alloc(44 + pcm.length);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16_000, 24);
  result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(pcm.length, 40);
  pcm.copy(result, 44);
  return result;
}

function timestamp(ms: number) {
  const hours = Math.floor(ms / 3_600_000), minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1_000) % 60, remainder = ms % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

function token(text: string, from: number, to: number, id = 1) {
  return {
    text,
    timestamps: { from: timestamp(from), to: timestamp(to) },
    offsets: { from, to },
    id,
    p: 0.75,
    t_dtw: -1,
  };
}

function segment(text: string, from: number, to: number, tokens = [token(text, from, to)]) {
  return {
    timestamps: { from: timestamp(from), to: timestamp(to) },
    offsets: { from, to },
    text,
    tokens,
  };
}

function providerDocument(transcription: readonly unknown[], modelPath = "/private/model.bin", language = "en") {
  return {
    systeminfo: "not published",
    model: { type: "fixture", multilingual: false },
    params: { model: modelPath, language, translate: false },
    result: { language },
    transcription,
  };
}

function machoDylib(path: string, command = 0x0c) {
  const name = Buffer.from(`${path}\0`, "ascii"), size = Math.ceil((24 + name.length) / 8) * 8;
  const result = Buffer.alloc(size);
  result.writeUInt32LE(command, 0);
  result.writeUInt32LE(size, 4);
  result.writeUInt32LE(24, 8);
  name.copy(result, 24);
  return result;
}

function machoDylinker(path = "/usr/lib/dyld") {
  const name = Buffer.from(`${path}\0`, "ascii"), size = Math.ceil((12 + name.length) / 8) * 8;
  const result = Buffer.alloc(size);
  result.writeUInt32LE(0x0e, 0);
  result.writeUInt32LE(size, 4);
  result.writeUInt32LE(12, 8);
  name.copy(result, 12);
  return result;
}

function machoFixture(paths: readonly string[] = cutWhisperLocalWorkflowContract.allowedWhisperDylibs, extra: readonly Buffer[] = []) {
  const commands = [...paths.map((path) => machoDylib(path)), ...extra];
  const body = Buffer.concat(commands), header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body]);
}

function fakeFfmpegSource(logPath: string, mode: "valid" | "bad-wave" | "hang" | "many-files" | "delayed" | "wave-symlink" | "descendant" | "self-rewrite" = "valid") {
  return `#!${process.execPath}
const { createHash } = require("node:crypto");
const { chmodSync, symlinkSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--version" || args[0] === "-version")) {
  process.stdout.write("ffmpeg version 7.1.1\\n");
  process.exit(0);
}
const chunks = [];
process.stdin.on("data", chunk => chunks.push(Buffer.from(chunk)));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdinBytes: input.length, stdinSha256: createHash("sha256").update(input).digest("hex") }) + "\\n", { flag: "wx" });
  if (${JSON.stringify(mode)} === "hang") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (${JSON.stringify(mode)} === "descendant") {
    const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    child.unref();
    writeFileSync(${JSON.stringify(logPath)} + ".child", String(child.pid), { flag: "wx" });
    return;
  }
  const samples = 16000;
  const pcm = Buffer.alloc(samples * 2);
  const out = Buffer.alloc(44 + pcm.length);
  out.write("RIFF", 0, "ascii"); out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "ascii"); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii"); out.writeUInt32LE(pcm.length, 40); pcm.copy(out, 44);
  if (${JSON.stringify(mode)} === "bad-wave") out.writeUInt32LE(48000, 24);
  if (${JSON.stringify(mode)} === "many-files") for (let index = 0; index < 96; index += 1) writeFileSync(join(dirname(args.at(-1)), "temporary-" + index), "x", { flag: "wx" });
  const publish = () => {
    if (${JSON.stringify(mode)} === "wave-symlink") {
      const target = join(dirname(args.at(-1)), "foreign-wave");
      writeFileSync(target, out, { flag: "wx" });
      symlinkSync(target, args.at(-1));
    } else writeFileSync(args.at(-1), out, { flag: "wx" });
  };
  if (${JSON.stringify(mode)} === "delayed") setTimeout(publish, 250); else publish();
  if (${JSON.stringify(mode)} === "self-rewrite") {
    chmodSync(process.argv[1], 0o700);
    writeFileSync(process.argv[1], "replaced staged executable\\n");
  }
});
`;
}

function fakeWhisperSource(logPath: string, mode: "valid" | "unknown" | "overlap" | "duplicate" | "invalid-utf8" | "json-symlink" | "orphan-tie" | "chained-tie" | "out-of-range" | "model-mutation" = "valid") {
  const normal = [
    segment("", 0, 100, [token("[_BEG_]", 0, 0, 50363)]),
    segment(" Hello", 100, 250),
    segment(" flare.", 500, 500),
    segment(" Then", 500, 750),
    segment("", 800, 800, [token("[_BEG_]", 800, 800, 50363)]),
  ];
  const overlap = [segment(" one", 100, 400), segment(" two", 300, 500)];
  const orphanTie = [segment(" one", 100, 200), segment(" orphan", 500, 500)];
  const chainedTie = [segment(" one", 100, 200), segment(" first", 500, 500), segment(" second", 500, 500), segment(" next", 500, 700)];
  const outOfRange = [segment(" late", 900, 1_001)];
  return `#!${process.execPath}
const { chmodSync, symlinkSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("whisper.cpp version: 1.9.2\\n");
  process.exit(0);
}
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n", { flag: "wx" });
const at = name => args[args.indexOf(name) + 1];
const result = {
  systeminfo: "private machine information that must not be published",
  model: { type: "fixture", multilingual: false },
  params: { model: at("--model"), language: at("--language"), translate: false },
  result: { language: at("--language") },
  transcription: ${JSON.stringify(mode === "overlap" ? overlap : mode === "orphan-tie" ? orphanTie : mode === "chained-tie" ? chainedTie : mode === "out-of-range" ? outOfRange : normal)},
};
if (${JSON.stringify(mode)} === "unknown") result.unexpected = true;
const output = at("--output-file") + ".json";
if (${JSON.stringify(mode)} === "duplicate") {
  writeFileSync(output, JSON.stringify(result).replace('"result":', '"result":{"language":"en"},"result":'), { flag: "wx" });
} else if (${JSON.stringify(mode)} === "invalid-utf8") {
  writeFileSync(output, Buffer.from([0xff, 0xfe]), { flag: "wx" });
} else if (${JSON.stringify(mode)} === "json-symlink") {
  const target = join(dirname(output), "foreign-json");
  writeFileSync(target, JSON.stringify(result), { flag: "wx" });
  symlinkSync(target, output);
} else writeFileSync(output, JSON.stringify(result), { flag: "wx" });
if (${JSON.stringify(mode)} === "model-mutation") {
  chmodSync(at("--model"), 0o600);
  writeFileSync(at("--model"), "replaced staged model\\n");
}
`;
}

type Fixture = Readonly<{
  root: string;
  ffmpegLog: string;
  whisperLog: string;
  setup: CutWhisperLocalSetup;
  input: CutWhisperLocalTranscriptionInput;
}>;

async function fixture(options: Readonly<{
  ffmpegMode?: "valid" | "bad-wave" | "hang" | "many-files" | "delayed" | "wave-symlink" | "descendant" | "self-rewrite" | "bad-launch";
  whisperMode?: "valid" | "unknown" | "overlap" | "duplicate" | "invalid-utf8" | "json-symlink" | "orphan-tie" | "chained-tie" | "out-of-range" | "model-mutation";
  sourceBytes?: Buffer;
}> = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cut-whisper-workflow-")));
  await mkdir(join(root, "media"));
  const source = join(root, "media/dialogue.fake"), ffmpeg = join(root, "ffmpeg"), whisper = join(root, "whisper-cli"), model = join(root, "model.bin");
  const ffmpegLog = join(root, "ffmpeg-args.json"), whisperLog = join(root, "whisper-args.json");
  const sourceBytes = options.sourceBytes ?? Buffer.from("authenticated source media\n");
  const ffmpegBytes = options.ffmpegMode === "bad-launch"
    ? Buffer.from("#!/definitely/missing/cut-ffmpeg\n", "utf8")
    : Buffer.from(fakeFfmpegSource(ffmpegLog, options.ffmpegMode), "utf8");
  const whisperBytes = Buffer.from(fakeWhisperSource(whisperLog, options.whisperMode), "utf8"), modelBytes = Buffer.from("authenticated model bytes\n");
  await Promise.all([
    writeFile(source, sourceBytes, { flag: "wx" }),
    writeFile(ffmpeg, ffmpegBytes, { flag: "wx" }),
    writeFile(whisper, whisperBytes, { flag: "wx" }),
    writeFile(model, modelBytes, { flag: "wx" }),
  ]);
  await Promise.all([chmod(ffmpeg, 0o700), chmod(whisper, 0o700)]);
  const setup = parseCutWhisperLocalSetup({
    format: cutWhisperLocalWorkflowContract.format,
    version: cutWhisperLocalWorkflowContract.version,
    acquisition: cutWhisperLocalWorkflowContract.acquisition,
    runtime: cutWhisperLocalWorkflowContract.runtime,
    ffmpeg: { path: ffmpeg, bytes: ffmpegBytes.length, sha256: sha256(ffmpegBytes), version: "7.1.1", revision: "ffmpeg-n7.1.1" },
    whisperCli: {
      path: whisper,
      bytes: whisperBytes.length,
      sha256: sha256(whisperBytes),
      version: cutWhisperLocalWorkflowContract.whisperVersion,
      revision: cutWhisperLocalWorkflowContract.whisperSourceRevision,
      sourceArchiveSha256: cutWhisperLocalWorkflowContract.whisperSourceArchiveSha256,
      buildPolicy: cutWhisperLocalWorkflowContract.whisperBuildPolicy,
      linkagePolicy: cutWhisperLocalWorkflowContract.whisperLinkagePolicy,
    },
    model: { path: model, locator: "models/base.en-q5_1.bin", bytes: modelBytes.length, sha256: sha256(modelBytes), name: "base.en-q5_1", revision: "fixture-model-r1", license: "MIT" },
  });
  const input: CutWhisperLocalTranscriptionInput = {
    projectRoot: root,
    setup,
    source: { locator: "media/dialogue.fake", bytes: sourceBytes.length, sha256: sha256(sourceBytes), streamIndex: 0, sampleRate: 48_000, durationSamples: 48_000 },
    settings: { language: "en", temperatureMilli: 0, noFallback: true },
    threads: 4,
    transcriptLocator: "transcripts/dialogue.cut-transcript.json",
    receiptLocator: "transcripts/dialogue.cut-whisper.json",
  };
  return Object.freeze({ root, ffmpegLog, whisperLog, setup, input });
}

const transcribeFixture = (input: CutWhisperLocalTranscriptionInput) => cutWhisperLocalWorkflowTestOnly.transcribeWithFixtureClosure(input);

async function expectFailure(action: () => Promise<unknown>, code: CutWhisperLocalWorkflowErrorCode, message?: RegExp) {
  await assert.rejects(action, (error: unknown) => error instanceof CutWhisperLocalWorkflowError
    && error.code === code && (!message || message.test(error.message)));
}
const missing = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
async function waitForFile(path: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (await lstat(path).then(() => true, () => false)) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`timed out waiting for ${path}`);
}

test("doctor authenticates exact local authorities without pretending inference ran", async () => {
  const value = await fixture();
  try {
    await expectFailure(() => doctorCutWhisperLocalSetup(value.setup), "CUT_WHISPER_WORKFLOW_AUTHORITY", /Mach-O/u);
    const report = await cutWhisperLocalWorkflowTestOnly.doctorWithFixtureClosure(value.setup);
    assert.equal(report.status, "caller-authority-ready");
    assert.equal(report.authorityScope, "caller-declared-provenance-authenticated-bytes-compatible-behavior-v1");
    assert.equal(report.modelInferenceSmoke, "unperformed-until-transcription");
    assert.equal(report.runtime, "offline-local-files-only");
    assert.equal(report.osNetworkSandbox, "not-provided");
    assert.equal(report.whisperCli.sha256, value.setup.whisperCli.sha256);
    assert.equal(report.model.sha256, value.setup.model.sha256);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("normalizes, executes stock CLI CPU-only, repairs one exact tied word, and transactionally publishes", async () => {
  const value = await fixture();
  try {
    const result = await transcribeFixture(value.input);
    const transcript = JSON.parse(await readFile(result.transcriptPath, "utf8")) as { words: Array<{ text: string; start: unknown; end: unknown }> };
    assert.deepEqual(transcript.words.map(({ text, start, end }) => ({ text, start, end })), [
      { text: "Hello", start: { numerator: "1", denominator: "10" }, end: { numerator: "1", denominator: "4" } },
      { text: "flare.", start: { numerator: "1", denominator: "2" }, end: { numerator: "24001", denominator: "48000" } },
      { text: "Then", start: { numerator: "24001", denominator: "48000" }, end: { numerator: "3", denominator: "4" } },
    ]);
    const receiptBytes = await readFile(result.receiptPath), receiptText = receiptBytes.toString("utf8");
    const receipt = JSON.parse(receiptText) as typeof result.receipt;
    assert.equal(receipt.policy.device, "cpu-only-no-gpu-v1");
    assert.equal(receipt.policy.tiedBoundaryRepairCount, 1);
    assert.equal(receipt.policy.adjacentBoundarySnapCount, 0);
    assert.equal(receipt.policy.tiedBoundaries, "zero-duration-word-one-sample-next-tied-start-push-v1");
    assert.equal(receipt.providerJson.wordCount, 3);
    assert.ok(receipt.providerJson.semanticBytes > 0);
    assert.equal(Object.hasOwn(receipt.providerJson, "bytes"), false, "receipt must not bind path-bearing raw provider JSON size");
    assert.equal(receipt.transcriptSha256, result.transcriptSha256);
    const { receiptSha256, ...receiptBody } = receipt;
    assert.equal(receiptSha256, sha256(stableJsonStringify(receiptBody)), "receipt has one canonical self-binding");
    for (const secret of [value.root, "private machine information"]) assert.equal(receiptText.includes(secret), false);
    const ffmpegRun = JSON.parse(await readFile(value.ffmpegLog, "utf8")) as { args: string[]; stdinBytes: number; stdinSha256: string };
    assert.deepEqual(ffmpegRun.args.slice(0, 4), ["-nostdin", "-v", "error", "-xerror"]);
    assert.deepEqual(ffmpegRun.args.slice(4, 12), ["-protocol_whitelist", "pipe", "-protocol_blacklist", "file,http,https,tcp,tls,udp,rtmp,rtsp,srt,ftp,concat,subfile,crypto,data", "-i", "pipe:0", "-map", "0:0"]);
    assert.equal(ffmpegRun.args.includes("pcm_s16le"), true);
    assert.equal(ffmpegRun.stdinBytes, value.input.source.bytes);
    assert.equal(ffmpegRun.stdinSha256, value.input.source.sha256);
    const whisperArgs = JSON.parse(await readFile(value.whisperLog, "utf8")) as string[];
    assert.equal(whisperArgs.includes("--output-json-full"), true);
    assert.equal(whisperArgs.includes("--no-gpu"), true);
    assert.equal(whisperArgs.includes("--no-fallback"), true);
    assert.equal(whisperArgs.includes("--split-on-word"), true);
    assert.deepEqual((await readdir(join(value.root, ".cut/audio-transcription-staging"))).sort(), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("publication is create-only and preserves the first canonical transcript", async () => {
  const value = await fixture();
  try {
    const first = await transcribeFixture(value.input);
    const second = await transcribeFixture(value.input).catch((error) => error);
    assert.ok(second instanceof CutWhisperLocalWorkflowError, "create-only publication must reject a repeat into occupied locators");
    assert.equal(await readFile(first.transcriptPath, "utf8"), `${stableJsonStringify(JSON.parse(await readFile(first.transcriptPath, "utf8")))}\n`);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("authority, output shape, overlap, normalization, and output collision fail closed", async () => {
  for (const [kind, action, code] of [
    ["authority", async (value: Fixture) => transcribeFixture({ ...value.input, setup: { ...value.setup, model: { ...value.setup.model, sha256: "f".repeat(64) } } }), "CUT_WHISPER_WORKFLOW_AUTHORITY"],
    ["unknown", async (value: Fixture) => transcribeFixture(value.input), "CUT_WHISPER_WORKFLOW_OUTPUT"],
    ["overlap", async (value: Fixture) => transcribeFixture(value.input), "CUT_WHISPER_WORKFLOW_OUTPUT"],
    ["bad-wave", async (value: Fixture) => transcribeFixture(value.input), "CUT_WHISPER_WORKFLOW_OUTPUT"],
  ] as const) {
    const value = await fixture({ ...(kind === "unknown" || kind === "overlap" ? { whisperMode: kind } : {}), ...(kind === "bad-wave" ? { ffmpegMode: kind } : {}) });
    try {
      await expectFailure(() => action(value), code);
      await assert.rejects(lstat(resolve(value.root, value.input.transcriptLocator)), missing);
      await assert.rejects(lstat(resolve(value.root, value.input.receiptLocator)), missing);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
  const collision = await fixture();
  try {
    await mkdir(join(collision.root, "transcripts"));
    await writeFile(resolve(collision.root, collision.input.receiptLocator), "foreign\n", { flag: "wx" });
    await expectFailure(() => transcribeFixture(collision.input), "CUT_WHISPER_WORKFLOW_PUBLISH");
    await assert.rejects(lstat(resolve(collision.root, collision.input.transcriptLocator)), missing);
    assert.equal(await readFile(resolve(collision.root, collision.input.receiptLocator), "utf8"), "foreign\n");
  } finally { await rm(collision.root, { recursive: true, force: true }); }
});

test("contract rejects auto language, host-relative paths, unknown setup fields, and pre-aborted work", async () => {
  const value = await fixture();
  try {
    assert.throws(() => parseCutWhisperLocalSetup({ ...value.setup, unexpected: true }), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_CONTRACT");
    assert.throws(() => parseCutWhisperLocalSetup({ ...value.setup, whisperCli: { ...value.setup.whisperCli, path: "whisper-cli" } }), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_CONTRACT");
    await expectFailure(() => transcribeFixture({ ...value.input, settings: { ...value.input.settings, language: "auto" } }), "CUT_WHISPER_WORKFLOW_CONTRACT");
    const controller = new AbortController(); controller.abort();
    await expectFailure(() => transcribeFixture({ ...value.input, signal: controller.signal }), "CUT_WHISPER_WORKFLOW_CANCELLED");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("production Mach-O parser accepts only the exact arm64 system-library closure", () => {
  const valid = machoFixture(cutWhisperLocalWorkflowContract.allowedWhisperDylibs, [machoDylinker()]);
  const parsed = cutWhisperLocalWorkflowTestOnly.parseMachOFixture(valid);
  assert.deepEqual([...parsed.loadedDylibs].sort(), [...cutWhisperLocalWorkflowContract.allowedWhisperDylibs].sort());

  const rpath = Buffer.alloc(16);
  rpath.writeUInt32LE(0x8000001c, 0);
  rpath.writeUInt32LE(16, 4);
  rpath.writeUInt32LE(12, 8);
  const truncatedDylinker = Buffer.alloc(8);
  truncatedDylinker.writeUInt32LE(0x0e, 0);
  truncatedDylinker.writeUInt32LE(8, 4);
  for (const hostile of [
    valid.subarray(0, valid.length - 1),
    machoFixture(),
    machoFixture(cutWhisperLocalWorkflowContract.allowedWhisperDylibs, [machoDylinker(), machoDylinker()]),
    machoFixture(cutWhisperLocalWorkflowContract.allowedWhisperDylibs, [rpath]),
    machoFixture(cutWhisperLocalWorkflowContract.allowedWhisperDylibs, [truncatedDylinker]),
    machoFixture(cutWhisperLocalWorkflowContract.allowedWhisperDylibs, [machoDylinker("/tmp/dyld")]),
    machoFixture([cutWhisperLocalWorkflowContract.allowedWhisperDylibs[0]!, cutWhisperLocalWorkflowContract.allowedWhisperDylibs[1]!, "/tmp/libforeign.dylib"]),
    machoFixture([cutWhisperLocalWorkflowContract.allowedWhisperDylibs[0]!, cutWhisperLocalWorkflowContract.allowedWhisperDylibs[0]!, cutWhisperLocalWorkflowContract.allowedWhisperDylibs[2]!]),
  ]) {
    assert.throws(() => cutWhisperLocalWorkflowTestOnly.parseMachOFixture(hostile), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_AUTHORITY");
  }
  assert.throws(() => cutWhisperLocalWorkflowTestOnly.parseMachOFixture(valid, valid.length - 8), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_AUTHORITY");
  const fat = Buffer.from(valid); fat.writeUInt32BE(0xcafebabe, 0);
  assert.throws(() => cutWhisperLocalWorkflowTestOnly.parseMachOFixture(fat), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_AUTHORITY");
});

test("strict provider JSON rejects invalid UTF-8, BOM, and duplicate decoded keys", () => {
  for (const hostile of [
    Buffer.from([0xff, 0xfe]),
    Buffer.from("\ufeff{}", "utf8"),
    Buffer.from('{"same":1,"same":2}', "utf8"),
    Buffer.from('{"same":1,"\\u0073ame":2}', "utf8"),
  ]) {
    assert.throws(() => cutWhisperLocalWorkflowTestOnly.parseProviderJsonFixture(hostile), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_OUTPUT");
  }
  assert.deepEqual(cutWhisperLocalWorkflowTestOnly.parseProviderJsonFixture(Buffer.from('{"safe":[1,true,null]}', "utf8")), { safe: [1, true, null] });
});

test("authenticated source is streamed through pipe-only FFmpeg input even when bytes are a hostile playlist", async () => {
  const playlist = Buffer.from("#EXTM3U\n#EXTINF:1,foreign\nfile:///etc/passwd\nhttps://example.invalid/audio.wav\n", "utf8");
  const value = await fixture({ sourceBytes: playlist });
  try {
    await transcribeFixture(value.input);
    const run = JSON.parse(await readFile(value.ffmpegLog, "utf8")) as { args: string[]; stdinBytes: number; stdinSha256: string };
    assert.equal(run.stdinBytes, playlist.length);
    assert.equal(run.stdinSha256, sha256(playlist));
    assert.equal(run.args[run.args.indexOf("-i") + 1], "pipe:0");
    assert.equal(run.args[run.args.indexOf("-protocol_whitelist") + 1], "pipe");
    assert.match(run.args[run.args.indexOf("-protocol_blacklist") + 1]!, /file/u);
    assert.equal(run.args.some((argument) => argument.includes(value.input.source.locator) || argument.includes("/etc/passwd") || argument.includes("example.invalid")), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("generated WAVE and provider JSON must be retained regular files with strict contents", async () => {
  for (const options of [
    { ffmpegMode: "wave-symlink" as const },
    { whisperMode: "json-symlink" as const },
    { whisperMode: "duplicate" as const },
    { whisperMode: "invalid-utf8" as const },
  ]) {
    const value = await fixture(options);
    try {
      await expectFailure(() => transcribeFixture(value.input), "CUT_WHISPER_WORKFLOW_OUTPUT");
      await assert.rejects(lstat(resolve(value.root, value.input.transcriptLocator)), missing);
      await assert.rejects(lstat(resolve(value.root, value.input.receiptLocator)), missing);
      assert.deepEqual(await readdir(join(value.root, ".cut/audio-transcription-staging")), []);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("stage cleanup removes all owned entries beyond the old sixty-four-file ceiling", async () => {
  const value = await fixture({ ffmpegMode: "many-files" });
  try {
    await transcribeFixture(value.input);
    assert.deepEqual(await readdir(join(value.root, ".cut/audio-transcription-staging")), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("independent retained snapshots reject source mutation after authenticated stdin transfer", async () => {
  const value = await fixture({ ffmpegMode: "delayed" });
  try {
    const pending = transcribeFixture(value.input);
    await waitForFile(value.ffmpegLog);
    await writeFile(resolve(value.root, value.input.source.locator), Buffer.alloc(value.input.source.bytes, 0x78));
    await expectFailure(() => pending, "CUT_WHISPER_WORKFLOW_AUTHORITY", /changed during execution/u);
    await assert.rejects(lstat(resolve(value.root, value.input.transcriptLocator)), missing);
    assert.deepEqual(await readdir(join(value.root, ".cut/audio-transcription-staging")), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("closed setup and invocation inputs reject proxies, accessors, symbols, and hidden fields without executing them", async () => {
  const value = await fixture();
  try {
    let getterCalls = 0;
    const accessor = { ...value.setup } as Record<string, unknown>;
    Object.defineProperty(accessor, "runtime", { enumerable: true, get() { getterCalls += 1; return cutWhisperLocalWorkflowContract.runtime; } });
    assert.throws(() => parseCutWhisperLocalSetup(accessor), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_CONTRACT");
    assert.equal(getterCalls, 0);

    const hidden = { ...value.setup };
    Object.defineProperty(hidden, "unexpected", { enumerable: false, value: true });
    assert.throws(() => parseCutWhisperLocalSetup(hidden), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_CONTRACT");
    assert.throws(() => parseCutWhisperLocalSetup(Object.assign({ ...value.setup }, { [Symbol("hidden")]: true })), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_CONTRACT");
    assert.throws(() => parseCutWhisperLocalSetup(new Proxy({ ...value.setup }, {})), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_CONTRACT");
    await expectFailure(() => transcribeFixture({ ...value.input, settings: new Proxy({ ...value.input.settings }, {}) }), "CUT_WHISPER_WORKFLOW_CONTRACT");
    await expectFailure(() => transcribeFixture({ ...value.input, signal: new Proxy(new AbortController().signal, {}) }), "CUT_WHISPER_WORKFLOW_CONTRACT");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("timestamp mapping stays on the source sample grid and tied-boundary exceptions remain narrow", () => {
  const source = { locator: "media/dialogue.wav", bytes: 1, sha256: "a".repeat(64), streamIndex: 0, sampleRate: 44_100, durationSamples: 44_100 };
  const settings = { language: "en", temperatureMilli: 0, noFallback: true } as const;
  const modelPath = "/private/model.bin";
  const mapped = cutWhisperLocalWorkflowTestOnly.parseWhisperJsonFixture(
    Buffer.from(JSON.stringify(providerDocument([segment(" edge", 1, 2)], modelPath))),
    source,
    settings,
    modelPath,
  );
  assert.deepEqual(mapped.words, [{ text: "edge", startSample: 44, endSample: 89 }]);
  const adjacentSource = { ...source, sampleRate: 22_050, durationSamples: 22_050 };
  const adjacent = cutWhisperLocalWorkflowTestOnly.parseWhisperJsonFixture(
    Buffer.from(JSON.stringify(providerDocument([segment(" first", 0, 10), segment(" second", 10, 20)], modelPath))),
    adjacentSource,
    settings,
    modelPath,
  );
  assert.deepEqual(adjacent.words, [
    { text: "first", startSample: 0, endSample: 221 },
    { text: "second", startSample: 221, endSample: 441 },
  ]);
  assert.equal(adjacent.adjacentBoundarySnapCount, 1);
  for (const transcription of [
    [segment(" orphan", 500, 500)],
    [segment(" first", 500, 500), segment(" second", 500, 500), segment(" next", 500, 700)],
    [segment(" late", 999, 1_001)],
    [segment(" reversed", 500, 400)],
  ]) {
    assert.throws(() => cutWhisperLocalWorkflowTestOnly.parseWhisperJsonFixture(
      Buffer.from(JSON.stringify(providerDocument(transcription, modelPath))),
      source,
      settings,
      modelPath,
    ), (error: unknown) => error instanceof CutWhisperLocalWorkflowError && error.code === "CUT_WHISPER_WORKFLOW_OUTPUT");
  }
});

test("a successful parent that leaves a descendant is drained and still fails closed", async () => {
  const value = await fixture({ ffmpegMode: "descendant" });
  try {
    await expectFailure(() => transcribeFixture({ ...value.input, timeoutMs: 5_000 }), "CUT_WHISPER_WORKFLOW_PROCESS", /descendant/u);
    const childPid = Number(await readFile(`${value.ffmpegLog}.child`, "utf8"));
    assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true);
    assert.throws(() => process.kill(childPid, 0), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH"));
    await assert.rejects(lstat(resolve(value.root, value.input.transcriptLocator)), missing);
    assert.deepEqual(await readdir(join(value.root, ".cut/audio-transcription-staging")), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

async function expectClosedWorkflowFailure(
  options: Parameters<typeof fixture>[0],
  timeoutMs: number,
  code: CutWhisperLocalWorkflowErrorCode,
) {
  const value = await fixture(options);
  try {
    await expectFailure(() => transcribeFixture({ ...value.input, timeoutMs }), code);
    await assert.rejects(lstat(resolve(value.root, value.input.transcriptLocator)), missing);
    await assert.rejects(lstat(resolve(value.root, value.input.receiptLocator)), missing);
    assert.deepEqual(await readdir(join(value.root, ".cut/audio-transcription-staging")), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
}

test("timeout kills and drains the exact process group without publication or residue", async () => {
  await expectClosedWorkflowFailure({ ffmpegMode: "hang" }, 50, "CUT_WHISPER_WORKFLOW_PROCESS");
});

test("asynchronous spawn failure closes without publication or residue", async () => {
  await expectClosedWorkflowFailure({ ffmpegMode: "bad-launch" }, 5_000, "CUT_WHISPER_WORKFLOW_PROCESS");
});

test("staged executable self-rewrite is detected before publication", async () => {
  await expectClosedWorkflowFailure({ ffmpegMode: "self-rewrite" }, 5_000, "CUT_WHISPER_WORKFLOW_AUTHORITY");
});

test("staged model mutation is detected before publication", async () => {
  await expectClosedWorkflowFailure({ whisperMode: "model-mutation" }, 5_000, "CUT_WHISPER_WORKFLOW_AUTHORITY");
});

test("partial authority-open failure closes every authority that already opened", async () => {
  const closed: string[] = [];
  const retained = (id: string) => ({
    handle: { close: async () => { closed.push(id); } },
    snapshot: {},
  }) as never;
  const failure = new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_AUTHORITY", "fixture open failed");
  await assert.rejects(
    cutWhisperLocalWorkflowTestOnly.settleRetainedAuthoritiesFixture([
      Promise.resolve(retained("ffmpeg")),
      Promise.reject(failure),
      Promise.resolve(retained("whisper")),
    ]),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(closed.sort(), ["ffmpeg", "whisper"]);
});
