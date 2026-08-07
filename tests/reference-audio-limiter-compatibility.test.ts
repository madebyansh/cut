import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { hash } from "../lib/core/stable";
import {
  processReferenceAudioLimiter,
} from "../lib/runtime/reference/audio-limiter";
import {
  applyReferenceAudioLimiterUniformFileCorrection,
} from "../lib/runtime/reference/audio-limiter-file";
import { createReferenceAudioLimiterCoreEvidence } from "../lib/runtime/reference/audio-limiter-preparation";
import {
  ReferenceAudioLimiterCompatibilityError,
  assertReferenceAudioLimiterCompatibilityToolchain,
  assertReferenceAudioLimiterStaticCompatibilityReport,
  assertReferenceAudioLimiterStaticCorrectionFactor,
  collectReferenceAudioLimiterCompatibilityToolchain,
  deriveReferenceAudioLimiterStaticCorrection,
  isReferenceAudioLimiterCompatibilityToolchain,
  isReferenceAudioLimiterStaticCompatibilityReport,
  issueReferenceAudioLimiterCoreCutPeakWitness,
  issueReferenceAudioLimiterCorrectedCutPeakWitness,
  measureReferenceAudioLimiterStaticCompatibility,
  referenceAudioLimiterCompatibilitySafetyDb,
} from "../lib/runtime/reference/audio-limiter-compatibility";

const sampleRate = 48_000;
const source = Object.freeze({ module: "compatibility.cut", line: 7, column: 5 });

function encode(samples: Float32Array) {
  const bytes = Buffer.allocUnsafe(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) bytes.writeFloatLE(samples[index], index * 4);
  return bytes;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function options(expectedFrames: number, targetCeilingDbtp = -1) {
  return { expectedFrames, sampleRate, targetCeilingDbtp, source };
}

function compatibilityError(code: ReferenceAudioLimiterCompatibilityError["code"], reason?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioLimiterCompatibilityError);
    assert.equal(error.code, code);
    if (reason) assert.equal(error.reason, reason);
    assert.deepEqual(error.source, source);
    assert.ok(error.message.length < 512);
    assert.doesNotMatch(error.message, /\/private\/|\/Users\//u);
    return true;
  };
}

async function temporaryRoot(prefix: string) {
  return mkdtemp(resolve(tmpdir(), prefix));
}

function deterministicDrivenNoise(frames: number) {
  let state = 5;
  const samples = new Float32Array(frames * 2);
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    samples[index] = (state / 0xffff_ffff * 2 - 1) * 3.582;
  }
  return samples;
}

function limiterFixture(frames: number) {
  return processReferenceAudioLimiter(deterministicDrivenNoise(frames), {
    sampleRate,
    lookaheadSamples: 240,
    ceilingDbtp: () => -1,
    releaseSeconds: () => 0.05,
    source,
  }).output;
}

function limiterResult(frames: number) {
  return processReferenceAudioLimiter(deterministicDrivenNoise(frames), {
    sampleRate,
    lookaheadSamples: 240,
    ceilingDbtp: () => -1,
    releaseSeconds: () => 0.05,
    source,
  });
}

async function issueCoreWitness(
  path: string,
  result: ReturnType<typeof limiterResult>,
) {
  return issueReferenceAudioLimiterCoreCutPeakWitness(path, {
    producer: result,
    coreEvidenceIntegrity: createReferenceAudioLimiterCoreEvidence(result).integrity,
    source,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resignReport(value: Record<string, unknown>) {
  const content = { ...value };
  delete content.integrity;
  value.integrity = hash(content);
  return value;
}

function pathEnvironmentKey() {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

const fakeFfmpegSource = `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { appendFileSync, writeFileSync, writeSync } = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.CUT_COMPAT_FAKE_MODE || "valid";
if (args.includes("-version")) {
  if (process.env.CUT_COMPAT_COUNTER) appendFileSync(process.env.CUT_COMPAT_COUNTER, "v");
  if (mode === "invalid-version") process.stdout.write("not ffmpeg\\n");
  else if (mode === "version-spam") writeSync(1, "ffmpeg version fake\\n" + "x".repeat(140000));
  else process.stdout.write("ffmpeg version cut-compatibility-test\\nconfiguration: deterministic-test\\n");
  process.exit(0);
}
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  if (process.env.CUT_COMPAT_INPUT_HASH) writeFileSync(process.env.CUT_COMPAT_INPUT_HASH, createHash("sha256").update(input).digest("hex"));
  if (process.env.CUT_COMPAT_ARG_LOG) writeFileSync(process.env.CUT_COMPAT_ARG_LOG, JSON.stringify(args));
  if (mode === "replace-source" && process.env.CUT_COMPAT_SOURCE_PATH) writeFileSync(process.env.CUT_COMPAT_SOURCE_PATH, Buffer.alloc(input.length, 0x7f));
  if (mode === "mutate-executable") appendFileSync(process.argv[1], "\\n// changed during measurement\\n");
  if (mode === "output-spam") { process.stderr.write("x".repeat(300000)); return; }
  if (mode === "exit") process.exit(7);
  if (mode === "missing-json") { process.stderr.write("no measurement\\n"); return; }
  const measured = {
    input_i: "-20.00", input_tp: mode === "invalid-tp" ? "NaN" : "-0.50",
    input_lra: "0.00", input_thresh: "-30.00",
    output_i: "-24.00", output_tp: "-4.50", output_lra: "0.00",
    output_thresh: "-34.00", normalization_type: "linear", target_offset: "0.00"
  };
  if (mode === "extra-field") measured.extra = "rejected";
  const json = JSON.stringify(measured);
  process.stderr.write("[Parsed_loudnorm]\\n" + json + "\\n");
  if (mode === "ambiguous-json") process.stderr.write("[Parsed_loudnorm]\\n" + json + "\\n");
});
`;

async function withFakeFfmpeg<T>(root: string, mode: string, action: () => Promise<T>, extra: Record<string, string> = {}) {
  const bin = resolve(root, "bin");
  const executable = resolve(bin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, fakeFfmpegSource, { mode: 0o700 });
  await chmod(executable, 0o700);
  const pathKey = pathEnvironmentKey();
  const previousPath = process.env[pathKey];
  const previousMode = process.env.CUT_COMPAT_FAKE_MODE;
  const previous = Object.fromEntries(Object.keys(extra).map((key) => [key, process.env[key]]));
  process.env[pathKey] = `${bin}${delimiter}${previousPath ?? ""}`;
  process.env.CUT_COMPAT_FAKE_MODE = mode;
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  try {
    return await action();
  } finally {
    if (previousPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = previousPath;
    if (previousMode === undefined) delete process.env.CUT_COMPAT_FAKE_MODE; else process.env.CUT_COMPAT_FAKE_MODE = previousMode;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("retained Nyquist-rich limiter output exposes both meters and a guarded uniform correction", { timeout: 45_000 }, async () => {
  const root = await temporaryRoot("cut-limiter-compat-retained-");
  const path = resolve(root, "retained.f32le");
  const tempEntriesBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("cut-limiter-compatibility-")));
  try {
    const frames = 48_000;
    const bytes = encode(limiterFixture(frames));
    await writeFile(path, bytes, { mode: 0o600 });
    const report = await measureReferenceAudioLimiterStaticCompatibility(path, options(frames));
    assert.equal(report.boundary.sha256, sha256(bytes));
    assert.equal(report.boundary.suffixBytesExcluded, 0);
    assert.ok(report.cut.truePeakDbtp !== null && report.cut.truePeakDbtp < -1.4, JSON.stringify(report.cut));
    assert.ok(report.ffmpeg.truePeakDbtp !== null && report.ffmpeg.truePeakDbtp > report.cut.truePeakDbtp + 0.2, JSON.stringify(report));
    const worst = Math.max(report.cut.truePeakDbtp, report.ffmpeg.truePeakDbtp);
    assert.equal(report.correctionFactor, 10 ** ((-1 - referenceAudioLimiterCompatibilitySafetyDb - worst) / 20));
    assert.ok(report.correctionFactor < 1);
    assert.match(report.toolchain.ffmpeg.executableSha256, /^[a-f0-9]{64}$/u);
    assert.ok(report.toolchain.ffmpeg.executableBytes > 0);
    assert.ok(isReferenceAudioLimiterStaticCompatibilityReport(report));
    assert.deepEqual(assertReferenceAudioLimiterStaticCompatibilityReport(report), report);
    assert.ok(Object.isFrozen(report) && Object.isFrozen(report.boundary) && Object.isFrozen(report.toolchain.ffmpeg));
    assert.doesNotMatch(JSON.stringify(report), /compatibility\.cut|nodeId|retained\.f32le|\/private\/|\/Users\//u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const tempEntriesAfter = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("cut-limiter-compatibility-")));
  assert.deepEqual(tempEntriesAfter, tempEntriesBefore, "compatibility measurement must not retain private temp artifacts");
});

test("exact silence is reported as null by both meters and needs no correction", { timeout: 30_000 }, async () => {
  const root = await temporaryRoot("cut-limiter-compat-silence-");
  try {
    const frames = 2_400;
    const path = resolve(root, "silence.f32le");
    await writeFile(path, Buffer.alloc(frames * 8), { mode: 0o600 });
    const report = await measureReferenceAudioLimiterStaticCompatibility(path, options(frames));
    assert.equal(report.cut.truePeakLinear, 0);
    assert.equal(report.cut.truePeakDbtp, null);
    assert.equal(report.ffmpeg.truePeakDbtp, null);
    assert.equal(report.correctionFactor, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private CUT peak witness preserves exact public report bytes and rejects forged or mismatched boundaries", { timeout: 30_000 }, async () => {
  const root = await temporaryRoot("cut-limiter-compat-witness-");
  try {
    const frames = 512;
    const result = limiterResult(frames);
    const bytes = encode(result.output);
    const path = resolve(root, "core.f32le");
    const wrongPath = resolve(root, "wrong.f32le");
    await writeFile(path, bytes, { mode: 0o600 });
    await writeFile(wrongPath, Buffer.alloc(bytes.byteLength, 0), { mode: 0o600 });
    const witness = await issueCoreWitness(path, result);
    await assert.rejects(
      issueReferenceAudioLimiterCoreCutPeakWitness(path, {
        producer: { ...result },
        coreEvidenceIntegrity: createReferenceAudioLimiterCoreEvidence(result).integrity,
        source,
      }),
      compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", "untrusted-limiter-producer"),
    );
    await assert.rejects(
      issueReferenceAudioLimiterCoreCutPeakWitness(path, {
        producer: result,
        coreEvidenceIntegrity: "0".repeat(64),
        source,
      }),
      compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", "core-evidence-producer-mismatch"),
    );
    await withFakeFfmpeg(root, "valid", async () => {
      const measured = await measureReferenceAudioLimiterStaticCompatibility(path, options(frames));
      const reused = await measureReferenceAudioLimiterStaticCompatibility(path, options(frames), witness);
      assert.deepEqual(reused, measured);
      assert.equal(JSON.stringify(reused), JSON.stringify(measured));
      assert.equal(reused.integrity, measured.integrity);
      assert.equal(sha256(await readFile(path)), sha256(bytes), "measurement must not mutate limiter PCM");

      const forgeries = [
        { ...clone(witness), truePeakLinear: 0 },
        { ...clone(witness), truePeakFrame: frames - 1 },
        { ...clone(witness), compatibilityCorrectionFactor: 0.5 },
        { ...clone(witness), algorithm: "stale-algorithm" },
      ];
      for (const forgery of forgeries) {
        await assert.rejects(
          measureReferenceAudioLimiterStaticCompatibility(path, options(frames), forgery as never),
          compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", "untrusted-cut-peak-witness"),
        );
      }
      await assert.rejects(
        measureReferenceAudioLimiterStaticCompatibility(wrongPath, options(frames), witness),
        compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", "cut-peak-witness-boundary-mismatch"),
      );
      await assert.rejects(
        measureReferenceAudioLimiterStaticCompatibility(path, options(frames - 1), witness),
        compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", "cut-peak-witness-boundary-mismatch"),
      );

      const changed = Buffer.from(bytes);
      changed.writeFloatLE(Math.fround(changed.readFloatLE(0) + 0.125), 0);
      await writeFile(path, changed, { mode: 0o600 });
      await assert.rejects(
        measureReferenceAudioLimiterStaticCompatibility(path, options(frames), witness),
        compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", "cut-peak-witness-boundary-mismatch"),
      );
      await writeFile(path, Buffer.concat([bytes, Buffer.alloc(8)]), { mode: 0o600 });
      await assert.rejects(
        measureReferenceAudioLimiterStaticCompatibility(path, options(frames), witness),
        compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", "cut-peak-witness-boundary-mismatch"),
      );
      await writeFile(path, bytes.subarray(0, bytes.byteLength - 8), { mode: 0o600 });
      await assert.rejects(
        measureReferenceAudioLimiterStaticCompatibility(path, options(frames), witness),
        compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", "invalid-direct-f32"),
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility-corrected bytes require a fresh corrected-stage CUT peak witness", { timeout: 30_000 }, async () => {
  const root = await temporaryRoot("cut-limiter-compat-corrected-witness-");
  try {
    const frames = 384;
    const result = limiterResult(frames);
    const corePath = resolve(root, "core.f32le");
    const correctedPath = resolve(root, "corrected.f32le");
    const coreBytes = encode(result.output);
    await writeFile(corePath, coreBytes, { mode: 0o600 });
    const coreWitness = await issueCoreWitness(corePath, result);
    const factor = 0.8;
    const correction = await applyReferenceAudioLimiterUniformFileCorrection(corePath, correctedPath, {
      expectedFrames: frames,
      factor,
      source,
    });
    const correctedBytes = await readFile(correctedPath);
    const expected = new Float32Array(result.output.length);
    for (let index = 0; index < expected.length; index += 1) {
      expected[index] = Math.fround(result.output[index] * factor);
    }
    assert.equal(sha256(correctedBytes), sha256(encode(expected)), "uniform correction PCM law must remain byte-identical");
    const correctedWitness = await issueReferenceAudioLimiterCorrectedCutPeakWitness(correctedPath, {
      coreWitness,
      correction,
      source,
    });
    await assert.rejects(
      issueReferenceAudioLimiterCorrectedCutPeakWitness(correctedPath, {
        coreWitness,
        correction: { ...correction },
        source,
      }),
      compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", "untrusted-correction-producer"),
    );
    await withFakeFfmpeg(root, "valid", async () => {
      await assert.rejects(
        measureReferenceAudioLimiterStaticCompatibility(correctedPath, options(frames), coreWitness),
        compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", "cut-peak-witness-boundary-mismatch"),
      );
      const measured = await measureReferenceAudioLimiterStaticCompatibility(correctedPath, options(frames));
      const reused = await measureReferenceAudioLimiterStaticCompatibility(
        correctedPath,
        options(frames),
        correctedWitness,
      );
      assert.deepEqual(reused, measured);
      assert.equal(JSON.stringify(reused), JSON.stringify(measured));
      assert.equal(reused.integrity, measured.integrity);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("suffix samples are transparently excluded from both meters and evidence", { timeout: 45_000 }, async () => {
  const root = await temporaryRoot("cut-limiter-compat-suffix-");
  try {
    const frames = 2_400;
    const prefix = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame += 1) {
      prefix[frame * 2] = Math.sin(2 * Math.PI * 997 * frame / sampleRate) * 0.2;
      prefix[frame * 2 + 1] = prefix[frame * 2];
    }
    const prefixBytes = encode(prefix);
    const suffix = Buffer.alloc(frames * 8);
    for (let offset = 0; offset < suffix.length; offset += 4) suffix.writeFloatLE(offset % 16 === 0 ? 16 : -16, offset);
    const exactPath = resolve(root, "exact.f32le");
    const suffixPath = resolve(root, "suffix.f32le");
    await writeFile(exactPath, prefixBytes, { mode: 0o600 });
    await writeFile(suffixPath, Buffer.concat([prefixBytes, suffix]), { mode: 0o600 });
    const exact = await measureReferenceAudioLimiterStaticCompatibility(exactPath, options(frames));
    const withSuffix = await measureReferenceAudioLimiterStaticCompatibility(suffixPath, options(frames));
    assert.equal(withSuffix.boundary.sha256, exact.boundary.sha256);
    assert.equal(withSuffix.boundary.suffixBytesExcluded, suffix.byteLength);
    assert.deepEqual(withSuffix.cut, exact.cut);
    assert.deepEqual(withSuffix.ffmpeg, exact.ffmpeg);
    assert.equal(withSuffix.correctionFactor, exact.correctionFactor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the no-follow snapshot rejects path substitution and binds post-snapshot source mutation to the original bytes", { timeout: 30_000 }, async () => {
  const root = await temporaryRoot("cut-limiter-compat-path-");
  try {
    const frames = 64;
    const original = encode(new Float32Array(Array.from({ length: frames * 2 }, (_, index) => index % 2 ? -0.2 : 0.2)));
    const path = resolve(root, "source.f32le");
    const link = resolve(root, "source-link.f32le");
    await writeFile(path, original, { mode: 0o600 });
    await symlink(path, link);
    await assert.rejects(
      measureReferenceAudioLimiterStaticCompatibility(link, options(frames)),
      compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", "invalid-direct-f32"),
    );

    const inputHash = resolve(root, "input.sha256");
    const argLog = resolve(root, "args.json");
    const report = await withFakeFfmpeg(root, "replace-source", () => (
      measureReferenceAudioLimiterStaticCompatibility(path, options(frames))
    ), {
      CUT_COMPAT_SOURCE_PATH: path,
      CUT_COMPAT_INPUT_HASH: inputHash,
      CUT_COMPAT_ARG_LOG: argLog,
    });
    assert.equal(report.boundary.sha256, sha256(original));
    assert.equal((await readFile(inputHash, "utf8")).trim(), sha256(original));
    const args = JSON.parse(await readFile(argLog, "utf8")) as string[];
    assert.ok(args.includes("pipe:0"));
    assert.equal(args.includes(path), false, "the mutable source path must never reach FFmpeg");
    assert.notEqual(sha256(await readFile(path)), sha256(original), "the adversarial wrapper did mutate the caller path after snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closed options, paths and source records fail without invoking hostile accessors", async () => {
  const root = await temporaryRoot("cut-limiter-compat-options-");
  try {
    const path = resolve(root, "one-frame.f32le");
    await writeFile(path, Buffer.alloc(8), { mode: 0o600 });
    let invoked = false;
    const accessor = Object.defineProperty({}, "expectedFrames", { enumerable: true, get() { invoked = true; return 1; } });
    await assert.rejects(
      measureReferenceAudioLimiterStaticCompatibility(path, accessor as never),
      (error: unknown) => error instanceof ReferenceAudioLimiterCompatibilityError && error.code === "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
    );
    assert.equal(invoked, false);
    const proxy = new Proxy(options(1), {
      get() { invoked = true; throw new Error("proxy getter must not execute"); },
    });
    await assert.rejects(
      measureReferenceAudioLimiterStaticCompatibility(path, proxy),
      (error: unknown) => error instanceof ReferenceAudioLimiterCompatibilityError && error.reason === "invalid-measure-options",
    );
    assert.equal(invoked, false);
    for (const [authoredPath, authoredOptions] of [
      [path, { ...options(1), extra: true }],
      [path, { ...options(1), expectedFrames: 0 }],
      [path, { ...options(1), sampleRate: 44_100 }],
      [path, { ...options(1), targetCeilingDbtp: 1 }],
      [path, { ...options(1), source: { module: "bad\nsource", line: 1, column: 1 } }],
      ["", options(1)],
      ["bad\0path", options(1)],
    ] as const) {
      await assert.rejects(
        measureReferenceAudioLimiterStaticCompatibility(authoredPath, authoredOptions as never),
        (error: unknown) => error instanceof ReferenceAudioLimiterCompatibilityError && error.code === "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      );
    }
    const short = resolve(root, "short.f32le");
    const partial = resolve(root, "partial.f32le");
    await writeFile(short, Buffer.alloc(0));
    await writeFile(partial, Buffer.alloc(9));
    for (const invalid of [root, short, partial]) {
      await assert.rejects(
        measureReferenceAudioLimiterStaticCompatibility(invalid, options(1)),
        (error: unknown) => error instanceof ReferenceAudioLimiterCompatibilityError && error.code === "CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pure correction policy applies safety at the ceiling and rejects hostile values", () => {
  const atCeiling = deriveReferenceAudioLimiterStaticCorrection({
    cutTruePeakDbtp: -1,
    ffmpegTruePeakDbtp: -2,
    targetCeilingDbtp: -1,
    source,
  });
  assert.equal(atCeiling, 10 ** (-referenceAudioLimiterCompatibilitySafetyDb / 20));
  assert.equal(deriveReferenceAudioLimiterStaticCorrection({ cutTruePeakDbtp: null, ffmpegTruePeakDbtp: null, targetCeilingDbtp: -1, source }), 1);
  assert.equal(deriveReferenceAudioLimiterStaticCorrection({ cutTruePeakDbtp: -3, ffmpegTruePeakDbtp: -0.5, targetCeilingDbtp: -1, source }), 10 ** ((-1.01 + 0.5) / 20));
  for (const value of [0, -1, 1.000_001, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
    assert.throws(() => assertReferenceAudioLimiterStaticCorrectionFactor(value, source), compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_CORRECTION", "invalid-correction-factor"));
  }
  assert.throws(
    () => assertReferenceAudioLimiterStaticCorrectionFactor(1, { module: "bad\nsource", line: 1, column: 1 }),
    (error: unknown) => error instanceof ReferenceAudioLimiterCompatibilityError && error.reason === "invalid-correction-source",
  );
  let invoked = false;
  const hostile = Object.defineProperty({}, "cutTruePeakDbtp", { enumerable: true, get() { invoked = true; return -1; } });
  assert.throws(
    () => deriveReferenceAudioLimiterStaticCorrection(hostile as never),
    (error: unknown) => error instanceof ReferenceAudioLimiterCompatibilityError && error.reason === "invalid-correction-options",
  );
  assert.equal(invoked, false);
});

test("toolchain collection is fresh, binary-bound and rejects hostile process identities", { timeout: 30_000 }, async () => {
  const root = await temporaryRoot("cut-limiter-compat-toolchain-");
  try {
    const counter = resolve(root, "counter.txt");
    await withFakeFfmpeg(root, "valid", async () => {
      const first = await collectReferenceAudioLimiterCompatibilityToolchain();
      const second = await collectReferenceAudioLimiterCompatibilityToolchain();
      assert.deepEqual(first, second);
      assert.equal(await readFile(counter, "utf8"), "vv", "collector must execute a fresh identity probe for every cache invocation");
      assert.ok(isReferenceAudioLimiterCompatibilityToolchain(first));
      const normalized = assertReferenceAudioLimiterCompatibilityToolchain(first, source);
      assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.ffmpeg));
      assert.match(normalized.ffmpeg.executableSha256, /^[a-f0-9]{64}$/u);
    }, { CUT_COMPAT_COUNTER: counter });

    for (const mode of ["invalid-version", "version-spam"] as const) {
      await withFakeFfmpeg(root, mode, async () => {
        await assert.rejects(
          collectReferenceAudioLimiterCompatibilityToolchain(),
          (error: unknown) => error instanceof ReferenceAudioLimiterCompatibilityError && error.code === "CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN",
          mode,
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded FFmpeg output, parser ambiguity and executable mutation fail stably", { timeout: 30_000 }, async () => {
  for (const mode of ["missing-json", "invalid-tp", "extra-field", "ambiguous-json", "output-spam", "exit", "mutate-executable"] as const) {
    const root = await temporaryRoot(`cut-limiter-compat-${mode}-`);
    try {
      const path = resolve(root, "input.f32le");
      await writeFile(path, Buffer.alloc(8), { mode: 0o600 });
      await withFakeFfmpeg(root, mode, async () => {
        await assert.rejects(
          measureReferenceAudioLimiterStaticCompatibility(path, options(1)),
          (error: unknown) => {
            assert.ok(error instanceof ReferenceAudioLimiterCompatibilityError);
            assert.ok([
              "CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT",
              "CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN",
            ].includes(error.code));
            assert.ok(error.message.length < 512);
            assert.doesNotMatch(error.message, new RegExp(root.replaceAll("/", "\\/"), "u"));
            return true;
          },
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("deep report and toolchain validators reject re-signed semantic forgeries and hostile shapes", { timeout: 30_000 }, async () => {
  const root = await temporaryRoot("cut-limiter-compat-validator-");
  try {
    const path = resolve(root, "input.f32le");
    await writeFile(path, Buffer.alloc(8), { mode: 0o600 });
    const report = await withFakeFfmpeg(root, "valid", () => measureReferenceAudioLimiterStaticCompatibility(path, options(1)));
    const normalized = assertReferenceAudioLimiterStaticCompatibilityReport(clone(report), source);
    assert.deepEqual(normalized, report);
    assert.ok(Object.isFrozen(normalized.boundary) && Object.isFrozen(normalized.cut) && Object.isFrozen(normalized.ffmpeg));

    const forgeries: unknown[] = [];
    const extra = clone(report) as unknown as Record<string, unknown>;
    extra.source = "private.cut";
    forgeries.push(resignReport(extra));
    const factor = clone(report) as unknown as Record<string, unknown>;
    factor.correctionFactor = 1;
    forgeries.push(resignReport(factor));
    const suffix = clone(report) as unknown as Record<string, unknown>;
    (suffix.boundary as Record<string, unknown>).suffixBytesExcluded = Number.MAX_SAFE_INTEGER - 7;
    forgeries.push(resignReport(suffix));
    const cutPeak = clone(report) as unknown as Record<string, unknown>;
    (cutPeak.cut as Record<string, unknown>).truePeakDbtp = -99;
    forgeries.push(resignReport(cutPeak));
    const toolHash = clone(report) as unknown as Record<string, unknown>;
    (((toolHash.toolchain as Record<string, unknown>).ffmpeg as Record<string, unknown>).executableSha256) = "0".repeat(64);
    forgeries.push(resignReport(toolHash));
    for (const forgery of forgeries) {
      assert.equal(isReferenceAudioLimiterStaticCompatibilityReport(forgery), false);
      assert.throws(
        () => assertReferenceAudioLimiterStaticCompatibilityReport(forgery, source),
        (error: unknown) => error instanceof ReferenceAudioLimiterCompatibilityError && error.reason === "invalid-report",
      );
    }

    const toolchain = clone(report.toolchain) as unknown as Record<string, unknown>;
    toolchain.extra = true;
    assert.equal(isReferenceAudioLimiterCompatibilityToolchain(toolchain), false);
    assert.throws(() => assertReferenceAudioLimiterCompatibilityToolchain(toolchain, source), ReferenceAudioLimiterCompatibilityError);
    let invoked = false;
    const accessor = Object.defineProperty({}, "format", { enumerable: true, get() { invoked = true; return "cut-reference-audio-limiter-static-compatibility"; } });
    assert.equal(isReferenceAudioLimiterStaticCompatibilityReport(accessor), false);
    const proxy = new Proxy(clone(report), { get() { invoked = true; throw new Error("proxy getter must not execute"); } });
    assert.equal(isReferenceAudioLimiterStaticCompatibilityReport(proxy), false);
    assert.equal(invoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
