import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";

export const cutKokoroMlxLocalPolicy = Object.freeze({
  format: "cut-kokoro-mlx-local-policy",
  version: 2,
  provider: "cut-kokoro-mlx-local-v2",
  adapterRequestFormat: "cut-kokoro-mlx-local-adapter-request",
  adapterResultFormat: "cut-kokoro-mlx-local-adapter-result",
  adapterProtocolVersion: 2,
  supportedPlatform: "darwin",
  supportedArchitecture: "arm64",
  maximumPythonBytes: 256 * 1024 * 1024,
  maximumAdapterBytes: 4 * 1024 * 1024,
  maximumRuntimeComponents: 128,
  maximumRuntimeRootsPerComponent: 256,
  maximumRuntimePackages: 256,
  maximumRuntimeFiles: 32_768,
  maximumRuntimeBytes: 512 * 1024 * 1024,
  maximumModelConfigBytes: 16 * 1024 * 1024,
  maximumModelWeightsBytes: 4 * 1024 * 1024 * 1024,
  maximumVoiceBytes: 1024 * 1024 * 1024,
  maximumEspeakLibraryBytes: 256 * 1024 * 1024,
  maximumEspeakDataFiles: 8_192,
  maximumEspeakDataBytes: 1024 * 1024 * 1024,
  maximumTextBytes: 64 * 1024,
  maximumWavBytes: 512 * 1024 * 1024,
  maximumResultBytes: 64 * 1024,
  maximumStdoutBytes: 16 * 1024,
  maximumStderrBytes: 64 * 1024,
  defaultTimeoutMs: 10 * 60_000,
  maximumTimeoutMs: 30 * 60_000,
  terminationGraceMs: 500,
  gplPhonemizerNotice:
    "eSpeak NG is GPL-3.0-or-later; redistribution of its runtime or data must satisfy that license. Generated audio is not thereby licensed under GPL.",
  inferenceDeterminismBoundary:
    "The generated WAV bytes and their SHA-256 are the deterministic CUT asset boundary. Seeded Kokoro MLX inference is not claimed to reproduce identical PCM across executions.",
  authorityScope:
    "CUT authenticates the caller-selected CPython executable, adapter, separately declared Python/native runtime components, model, voice, and phonemizer bytes. CPython standard-library and operating-system framework bytes remain outside this authority.",
  licenseEvidenceBoundary:
    "License identifiers are caller declarations recorded for provenance; CUT does not verify licensing rights or compatibility.",
  networkIsolationBoundary:
    "CUT requests offline provider modes and the adapter refuses ordinary Python socket connections as defense in depth. This is not an operating-system network sandbox.",
} as const);

export type CutKokoroMlxAuthenticatedFile = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type CutKokoroMlxAuthenticatedTreeFile = CutKokoroMlxAuthenticatedFile & Readonly<{
  relativePath: string;
}>;

export type CutKokoroMlxPythonAuthority = CutKokoroMlxAuthenticatedFile & Readonly<{
  implementation: "CPython";
  pythonVersion: string;
  platform: "darwin";
  machine: "arm64";
}>;

export type CutKokoroMlxAdapterAuthority = CutKokoroMlxAuthenticatedFile & Readonly<{
  revision: string;
}>;

export type CutKokoroMlxRuntimePackageAuthority = Readonly<{
  name: string;
  packageVersion: string;
  license: string;
}>;

export type CutKokoroMlxRuntimeComponentAuthority = Readonly<{
  id: string;
  packages: readonly CutKokoroMlxRuntimePackageAuthority[];
  files: readonly CutKokoroMlxAuthenticatedTreeFile[];
  treeSha256: string;
}>;

export type CutKokoroMlxRuntimeAuthority = Readonly<{
  components: readonly CutKokoroMlxRuntimeComponentAuthority[];
  componentSetSha256: string;
}>;

export type CutKokoroMlxModelAuthority = Readonly<{
  name: string;
  revision: string;
  license: string;
  config: CutKokoroMlxAuthenticatedFile;
  weights: CutKokoroMlxAuthenticatedFile;
}>;

export type CutKokoroMlxVoiceAuthority = Readonly<{
  name: string;
  license: string;
  weights: CutKokoroMlxAuthenticatedFile;
}>;

export type CutKokoroMlxEspeakAuthority = Readonly<{
  name: "eSpeak NG";
  version: string;
  license: "GPL-3.0-or-later";
  notice: typeof cutKokoroMlxLocalPolicy.gplPhonemizerNotice;
  library: CutKokoroMlxAuthenticatedFile;
  dataFiles: readonly CutKokoroMlxAuthenticatedTreeFile[];
  dataTreeSha256: string;
}>;

export type CutKokoroMlxLocalAuthorities = Readonly<{
  python: CutKokoroMlxPythonAuthority;
  adapter: CutKokoroMlxAdapterAuthority;
  runtime: CutKokoroMlxRuntimeAuthority;
  model: CutKokoroMlxModelAuthority;
  voice: CutKokoroMlxVoiceAuthority;
  phonemizer: CutKokoroMlxEspeakAuthority;
}>;

export type CutKokoroMlxLocalInput = CutKokoroMlxLocalAuthorities & Readonly<{
  synthesis: Readonly<{
    text: string;
    language: string;
    speedMicros: number;
    seed: number;
    sampleRate: 24_000 | 48_000;
  }>;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type CutKokoroMlxLocalReceiptBody = Readonly<{
  format: "cut-kokoro-mlx-local-execution";
  version: 2;
  policy: typeof cutKokoroMlxLocalPolicy.format;
  provider: typeof cutKokoroMlxLocalPolicy.provider;
  syntheticSpeech: true;
  evidenceScope: Readonly<{
    authority: typeof cutKokoroMlxLocalPolicy.authorityScope;
    licenses: typeof cutKokoroMlxLocalPolicy.licenseEvidenceBoundary;
    networkIsolation: typeof cutKokoroMlxLocalPolicy.networkIsolationBoundary;
  }>;
  synthesis: Readonly<{
    text: string;
    textBytes: number;
    textSha256: string;
    voice: string;
    language: string;
    speedMicros: number;
    seed: number;
    sampleRate: 24_000 | 48_000;
  }>;
  runtime: Readonly<{
    python: Readonly<{
      bytes: number;
      sha256: string;
      implementation: "CPython";
      pythonVersion: string;
      platform: "darwin";
      machine: "arm64";
    }>;
    adapter: Readonly<{ bytes: number; sha256: string; revision: string }>;
    components: readonly Readonly<{
      id: string;
      packages: readonly Readonly<{
        name: string;
        packageVersion: string;
        declaredLicense: string;
      }>[];
      fileCount: number;
      bytes: number;
      treeSha256: string;
    }>[];
    componentSetSha256: string;
  }>;
  model: Readonly<{
    name: string;
    revision: string;
    declaredLicense: string;
    config: Readonly<{ bytes: number; sha256: string }>;
    weights: Readonly<{ bytes: number; sha256: string }>;
  }>;
  voice: Readonly<{ name: string; declaredLicense: string; bytes: number; sha256: string }>;
  phonemizer: Readonly<{
    name: "eSpeak NG";
    version: string;
    declaredLicense: "GPL-3.0-or-later";
    notice: typeof cutKokoroMlxLocalPolicy.gplPhonemizerNotice;
    library: Readonly<{ bytes: number; sha256: string }>;
    dataFileCount: number;
    dataBytes: number;
    dataTreeSha256: string;
  }>;
  invocation: readonly string[];
  invocationSha256: string;
  stderr: Readonly<{ bytes: number; sha256: string }>;
  output: Readonly<{
    bytes: number;
    sha256: string;
    channels: 1;
    sampleRate: 24_000 | 48_000;
    bitsPerSample: 16;
    durationSamples: number;
    dataBytes: number;
  }>;
  determinism: Readonly<{
    seedApplied: true;
    reproducibleInferenceClaim: false;
    boundary: typeof cutKokoroMlxLocalPolicy.inferenceDeterminismBoundary;
  }>;
}>;

export type CutKokoroMlxLocalReceipt = CutKokoroMlxLocalReceiptBody & Readonly<{
  executionSha256: string;
}>;

/** The caller owns any external no-clobber publication transaction. */
export type CutKokoroMlxLocalResult = Readonly<{
  wavBytes: Buffer;
  receipt: CutKokoroMlxLocalReceipt;
  receiptBytes: Buffer;
}>;

export type CutKokoroMlxLocalErrorCode =
  | "CUT_KOKORO_MLX_CONTRACT"
  | "CUT_KOKORO_MLX_AUTHORITY"
  | "CUT_KOKORO_MLX_PLATFORM"
  | "CUT_KOKORO_MLX_PROCESS"
  | "CUT_KOKORO_MLX_TIMEOUT"
  | "CUT_KOKORO_MLX_CANCELLED"
  | "CUT_KOKORO_MLX_OUTPUT"
  | "CUT_KOKORO_MLX_CLEANUP";

export class CutKokoroMlxLocalError extends Error {
  constructor(readonly code: CutKokoroMlxLocalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CutKokoroMlxLocalError";
  }
}

type StableFileSnapshot = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type OwnedRoot = Readonly<{ path: string; dev: bigint; ino: bigint }>;
type ProcessResult = Readonly<{ stdout: Buffer; stderr: Buffer }>;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const safeTextPattern = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,255}$/u;
const canonicalPackageNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,254}[a-z0-9])?$/u;
const safeVoicePattern = /^[a-z][a-z0-9_]{1,63}$/u;

function fail(code: CutKokoroMlxLocalErrorCode, message: string): never {
  throw new CutKokoroMlxLocalError(code, message);
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown) {
  return Buffer.from(`${stableJsonStringify(value)}\n`, "utf8");
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be one plain object.`);
  }
  return value as Record<string, unknown>;
}

function closedRecord(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const result = plainRecord(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) fail("CUT_KOKORO_MLX_CONTRACT", `${path}.${key} is not part of the closed contract.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail("CUT_KOKORO_MLX_CONTRACT", `${path}.${key} is required.`);
  }
  return result;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be one safe integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function text(value: unknown, path: string, maximumBytes = 4_096) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value
    || Buffer.byteLength(value, "utf8") > maximumBytes || !safeTextPattern.test(value)) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be bounded, trimmed, NFC, control-free text.`);
  }
  return value;
}

function token(value: unknown, path: string) {
  const result = text(value, path, 256);
  if (!safeTokenPattern.test(result)) fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be one safe token.`);
  return result;
}

function packageName(value: unknown, path: string) {
  const result = text(value, path, 256);
  if (!canonicalPackageNamePattern.test(result) || result.replace(/[._]+/gu, "-") !== result) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be one normalized lowercase Python distribution name.`);
  }
  return result;
}

function absolutePath(value: unknown, path: string) {
  const result = text(value, path, 16_384);
  if (!isAbsolute(result) || resolve(result) !== result || result.includes("\\")
    || result.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be one canonical absolute POSIX path.`);
  }
  return result;
}

function relativePath(value: unknown, path: string) {
  const result = text(value, path, 4_096);
  if (result.startsWith("/") || result.includes("\\")
    || result.split("/").some((part) => !part || part === "." || part === "..")
    || result.includes("/__pycache__/") || result.endsWith(".pyc")) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be one canonical source-only relative POSIX path.`);
  }
  return result;
}

function parseFile(
  value: unknown,
  path: string,
  maximumBytes: number,
  requireContent = true,
  additionalFields: readonly string[] = [],
) {
  const item = closedRecord(value, path, ["path", "bytes", "sha256"], additionalFields);
  return Object.freeze({
    path: absolutePath(item.path, `${path}.path`),
    bytes: integer(item.bytes, `${path}.bytes`, requireContent ? 1 : 0, maximumBytes),
    sha256: digest(item.sha256, `${path}.sha256`),
  });
}

function treeDigest(files: readonly Readonly<{ relativePath: string; bytes: number; sha256: string }>[]) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.relativePath}\0${file.bytes}\0${file.sha256}\n`, "utf8");
  return hash.digest("hex");
}

function compareUtf8(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function componentSetDigest(
  components: readonly Readonly<{
    id: string;
    packages: readonly Readonly<{ name: string; packageVersion: string; license: string }>[];
    treeSha256: string;
  }>[],
) {
  const hash = createHash("sha256");
  for (const component of components) {
    hash.update(`${component.id}\0${component.treeSha256}\n`, "utf8");
    for (const value of component.packages) {
      hash.update(`${value.name}\0${value.packageVersion}\0${value.license}\n`, "utf8");
    }
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

function parseTreeFiles(
  value: unknown,
  path: string,
  maximumFiles: number,
  maximumBytes: number,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumFiles) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must contain from 1 through ${maximumFiles} files.`);
  }
  const files = value.map((entry, index) => {
    const item = closedRecord(entry, `${path}[${index}]`, ["path", "relativePath", "bytes", "sha256"]);
    return Object.freeze({
      path: absolutePath(item.path, `${path}[${index}].path`),
      relativePath: relativePath(item.relativePath, `${path}[${index}].relativePath`),
      bytes: integer(item.bytes, `${path}[${index}].bytes`, 0, maximumBytes),
      sha256: digest(item.sha256, `${path}[${index}].sha256`),
    });
  });
  const sorted = [...files].sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  if (files.some((file, index) => file.relativePath !== sorted[index]!.relativePath)
    || new Set(files.map((file) => file.relativePath)).size !== files.length) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} must be uniquely sorted by relativePath.`);
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(total) || total > maximumBytes) {
    fail("CUT_KOKORO_MLX_CONTRACT", `${path} exceeds its aggregate byte limit.`);
  }
  return Object.freeze(files);
}

function parseInput(value: CutKokoroMlxLocalInput) {
  const root = closedRecord(value, "$", ["python", "adapter", "runtime", "model", "voice", "phonemizer", "synthesis"], ["timeoutMs", "signal"]);
  const python = closedRecord(root.python, "$.python", ["path", "bytes", "sha256", "implementation", "pythonVersion", "platform", "machine"]);
  const parsedPython = Object.freeze({
    ...parseFile(python, "$.python", cutKokoroMlxLocalPolicy.maximumPythonBytes, true, ["implementation", "pythonVersion", "platform", "machine"]),
    implementation: python.implementation === "CPython" ? "CPython" as const : fail("CUT_KOKORO_MLX_CONTRACT", "$.python.implementation must be CPython."),
    pythonVersion: token(python.pythonVersion, "$.python.pythonVersion"),
    platform: python.platform === "darwin" ? "darwin" as const : fail("CUT_KOKORO_MLX_CONTRACT", "$.python.platform must be darwin."),
    machine: python.machine === "arm64" ? "arm64" as const : fail("CUT_KOKORO_MLX_CONTRACT", "$.python.machine must be arm64."),
  });
  const adapter = closedRecord(root.adapter, "$.adapter", ["path", "bytes", "sha256", "revision"]);
  const parsedAdapter = Object.freeze({
    ...parseFile(adapter, "$.adapter", cutKokoroMlxLocalPolicy.maximumAdapterBytes, true, ["revision"]),
    revision: token(adapter.revision, "$.adapter.revision"),
  });
  const runtime = closedRecord(root.runtime, "$.runtime", ["components", "componentSetSha256"]);
  if (!Array.isArray(runtime.components) || runtime.components.length < 1
    || runtime.components.length > cutKokoroMlxLocalPolicy.maximumRuntimeComponents) {
    fail("CUT_KOKORO_MLX_CONTRACT", `$.runtime.components must contain from 1 through ${cutKokoroMlxLocalPolicy.maximumRuntimeComponents} components.`);
  }
  let packageCount = 0;
  const runtimeComponents = Object.freeze(runtime.components.map((entry, componentIndex) => {
    const path = `$.runtime.components[${componentIndex}]`;
    const component = closedRecord(entry, path, ["id", "packages", "files", "treeSha256"]);
    if (!Array.isArray(component.packages) || component.packages.length < 1) {
      fail("CUT_KOKORO_MLX_CONTRACT", `${path}.packages must be one non-empty array.`);
    }
    packageCount += component.packages.length;
    if (packageCount > cutKokoroMlxLocalPolicy.maximumRuntimePackages) {
      fail("CUT_KOKORO_MLX_CONTRACT", "$.runtime.components exceed the aggregate package limit.");
    }
    const packages = Object.freeze(component.packages.map((entryValue, packageIndex) => {
      const packagePath = `${path}.packages[${packageIndex}]`;
      const value = closedRecord(entryValue, packagePath, ["name", "packageVersion", "license"]);
      return Object.freeze({
        name: packageName(value.name, `${packagePath}.name`),
        packageVersion: token(value.packageVersion, `${packagePath}.packageVersion`),
        license: text(value.license, `${packagePath}.license`),
      });
    }));
    const sortedPackages = [...packages].sort((left, right) => compareUtf8(left.name, right.name));
    if (packages.some((value, index) => value.name !== sortedPackages[index]!.name)
      || new Set(packages.map((value) => value.name)).size !== packages.length) {
      fail("CUT_KOKORO_MLX_CONTRACT", `${path}.packages must be uniquely sorted by normalized name.`);
    }
    const files = parseTreeFiles(
      component.files,
      `${path}.files`,
      cutKokoroMlxLocalPolicy.maximumRuntimeFiles,
      cutKokoroMlxLocalPolicy.maximumRuntimeBytes,
    );
    const parsed = Object.freeze({
      id: packageName(component.id, `${path}.id`),
      packages,
      files,
      treeSha256: digest(component.treeSha256, `${path}.treeSha256`),
    });
    if (treeDigest(files) !== parsed.treeSha256) {
      fail("CUT_KOKORO_MLX_CONTRACT", `${path}.treeSha256 does not bind its exact file manifest.`);
    }
    return parsed;
  }));
  const sortedComponents = [...runtimeComponents].sort((left, right) => compareUtf8(left.id, right.id));
  const allFiles = runtimeComponents.flatMap((component) => component.files);
  const allPackages = runtimeComponents.flatMap((component) => component.packages);
  const runtimeBytes = allFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (runtimeComponents.some((value, index) => value.id !== sortedComponents[index]!.id)
    || new Set(runtimeComponents.map((value) => value.id)).size !== runtimeComponents.length) {
    fail("CUT_KOKORO_MLX_CONTRACT", "$.runtime.components must be uniquely sorted by id.");
  }
  if (allFiles.length > cutKokoroMlxLocalPolicy.maximumRuntimeFiles
    || !Number.isSafeInteger(runtimeBytes) || runtimeBytes > cutKokoroMlxLocalPolicy.maximumRuntimeBytes
    || new Set(allFiles.map((file) => file.relativePath)).size !== allFiles.length) {
    fail("CUT_KOKORO_MLX_CONTRACT", "$.runtime.components exceed or overlap the aggregate runtime-file authority.");
  }
  if (new Set(allPackages.map((value) => value.name)).size !== allPackages.length
    || !["kokoro-mlx", "misaki", "mlx", "mlx-metal", "numpy", "safetensors"]
      .every((name) => allPackages.some((value) => value.name === name))) {
    fail("CUT_KOKORO_MLX_CONTRACT", "$.runtime.components must declare each required Python/native package exactly once.");
  }
  const parsedRuntime = Object.freeze({
    components: runtimeComponents,
    componentSetSha256: digest(runtime.componentSetSha256, "$.runtime.componentSetSha256"),
  });
  if (componentSetDigest(runtimeComponents) !== parsedRuntime.componentSetSha256) {
    fail("CUT_KOKORO_MLX_CONTRACT", "$.runtime.componentSetSha256 does not bind the exact component contract.");
  }
  const model = closedRecord(root.model, "$.model", ["name", "revision", "license", "config", "weights"]);
  const parsedModel = Object.freeze({
    name: text(model.name, "$.model.name"),
    revision: token(model.revision, "$.model.revision"),
    license: text(model.license, "$.model.license"),
    config: parseFile(model.config, "$.model.config", cutKokoroMlxLocalPolicy.maximumModelConfigBytes),
    weights: parseFile(model.weights, "$.model.weights", cutKokoroMlxLocalPolicy.maximumModelWeightsBytes),
  });
  const voice = closedRecord(root.voice, "$.voice", ["name", "license", "weights"]);
  const voiceName = text(voice.name, "$.voice.name", 64);
  if (!safeVoicePattern.test(voiceName)) fail("CUT_KOKORO_MLX_CONTRACT", "$.voice.name is not one safe Kokoro voice identifier.");
  const parsedVoice = Object.freeze({
    name: voiceName,
    license: text(voice.license, "$.voice.license"),
    weights: parseFile(voice.weights, "$.voice.weights", cutKokoroMlxLocalPolicy.maximumVoiceBytes),
  });
  const phonemizer = closedRecord(root.phonemizer, "$.phonemizer", ["name", "version", "license", "notice", "library", "dataFiles", "dataTreeSha256"]);
  const dataFiles = parseTreeFiles(
    phonemizer.dataFiles,
    "$.phonemizer.dataFiles",
    cutKokoroMlxLocalPolicy.maximumEspeakDataFiles,
    cutKokoroMlxLocalPolicy.maximumEspeakDataBytes,
  );
  const parsedPhonemizer = Object.freeze({
    name: phonemizer.name === "eSpeak NG" ? "eSpeak NG" as const : fail("CUT_KOKORO_MLX_CONTRACT", "$.phonemizer.name must be eSpeak NG."),
    version: token(phonemizer.version, "$.phonemizer.version"),
    license: phonemizer.license === "GPL-3.0-or-later" ? "GPL-3.0-or-later" as const : fail("CUT_KOKORO_MLX_CONTRACT", "$.phonemizer.license must be GPL-3.0-or-later."),
    notice: phonemizer.notice === cutKokoroMlxLocalPolicy.gplPhonemizerNotice
      ? cutKokoroMlxLocalPolicy.gplPhonemizerNotice
      : fail("CUT_KOKORO_MLX_CONTRACT", "$.phonemizer.notice must preserve CUT's exact GPL runtime notice."),
    library: parseFile(phonemizer.library, "$.phonemizer.library", cutKokoroMlxLocalPolicy.maximumEspeakLibraryBytes),
    dataFiles,
    dataTreeSha256: digest(phonemizer.dataTreeSha256, "$.phonemizer.dataTreeSha256"),
  });
  if (treeDigest(dataFiles) !== parsedPhonemizer.dataTreeSha256) {
    fail("CUT_KOKORO_MLX_CONTRACT", "$.phonemizer.dataTreeSha256 does not bind the exact data manifest.");
  }
  const synthesis = closedRecord(root.synthesis, "$.synthesis", ["text", "language", "speedMicros", "seed", "sampleRate"]);
  const sampleRate = synthesis.sampleRate === 24_000 || synthesis.sampleRate === 48_000
    ? synthesis.sampleRate
    : fail("CUT_KOKORO_MLX_CONTRACT", "$.synthesis.sampleRate must be 24000 or 48000.");
  const signal = root.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    fail("CUT_KOKORO_MLX_CONTRACT", "$.signal must be one AbortSignal when present.");
  }
  return Object.freeze({
    python: parsedPython,
    adapter: parsedAdapter,
    runtime: parsedRuntime,
    model: parsedModel,
    voice: parsedVoice,
    phonemizer: parsedPhonemizer,
    synthesis: Object.freeze({
      text: text(synthesis.text, "$.synthesis.text", cutKokoroMlxLocalPolicy.maximumTextBytes),
      language: token(synthesis.language, "$.synthesis.language"),
      speedMicros: integer(synthesis.speedMicros, "$.synthesis.speedMicros", 750_000, 1_250_000),
      seed: integer(synthesis.seed, "$.synthesis.seed", 0, 0xffff_ffff),
      sampleRate,
    }),
    timeoutMs: root.timeoutMs === undefined
      ? cutKokoroMlxLocalPolicy.defaultTimeoutMs
      : integer(root.timeoutMs, "$.timeoutMs", 1, cutKokoroMlxLocalPolicy.maximumTimeoutMs),
    signal: signal as AbortSignal | undefined,
  });
}

export function isCutKokoroMlxLocalPlatformSupported(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
) {
  return platform === cutKokoroMlxLocalPolicy.supportedPlatform
    && architecture === cutKokoroMlxLocalPolicy.supportedArchitecture;
}

async function hashHandle(handle: FileHandle, size: bigint) {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  while (position < size) {
    const length = Number(size - position > BigInt(buffer.length) ? BigInt(buffer.length) : size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
    if (bytesRead !== length) fail("CUT_KOKORO_MLX_AUTHORITY", "authenticated file changed during hashing.");
    hash.update(buffer.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }
  return hash.digest("hex");
}

async function snapshotRegularFile(path: string, maximumBytes: number, label: string): Promise<StableFileSnapshot> {
  let handle: FileHandle | undefined;
  try {
    const physical = await realpath(path);
    if (physical !== path) fail("CUT_KOKORO_MLX_AUTHORITY", `${label} must use its canonical physical path.`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maximumBytes)) {
      fail("CUT_KOKORO_MLX_AUTHORITY", `${label} is not one bounded regular file.`);
    }
    const observedSha256 = await hashHandle(handle, before.size);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail("CUT_KOKORO_MLX_AUTHORITY", `${label} changed during authentication.`);
    }
    return Object.freeze({
      path,
      bytes: Number(before.size),
      sha256: observedSha256,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
  } catch (error) {
    if (error instanceof CutKokoroMlxLocalError) throw error;
    return fail("CUT_KOKORO_MLX_AUTHORITY", `${label} could not be authenticated.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function snapshotCollectorFile(path: string, maximumBytes: number, label: string) {
  try {
    return await snapshotRegularFile(await realpath(path), maximumBytes, label);
  } catch (error) {
    if (error instanceof CutKokoroMlxLocalError) throw error;
    return fail("CUT_KOKORO_MLX_AUTHORITY", `${label} could not be authenticated.`);
  }
}

function assertExpected(snapshot: StableFileSnapshot, authority: CutKokoroMlxAuthenticatedFile, label: string) {
  if (snapshot.bytes !== authority.bytes || snapshot.sha256 !== authority.sha256) {
    fail("CUT_KOKORO_MLX_AUTHORITY", `${label} differs from its caller-supplied authority.`);
  }
}

async function assertSnapshotUnchanged(snapshot: StableFileSnapshot, maximumBytes: number, label: string) {
  const current = await snapshotRegularFile(snapshot.path, maximumBytes, label);
  if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.size !== snapshot.size
    || current.mtimeNs !== snapshot.mtimeNs || current.ctimeNs !== snapshot.ctimeNs
    || current.sha256 !== snapshot.sha256) {
    fail("CUT_KOKORO_MLX_AUTHORITY", `${label} changed during local Kokoro execution.`);
  }
}

async function createOwnedRoot(): Promise<OwnedRoot> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cut-kokoro-mlx-")));
  await chmod(path, 0o700);
  const state = await lstat(path, { bigint: true });
  if (!state.isDirectory() || (state.mode & 0o077n) !== 0n) {
    fail("CUT_KOKORO_MLX_AUTHORITY", "private Kokoro execution root is not owner-private.");
  }
  return Object.freeze({ path, dev: state.dev, ino: state.ino });
}

async function removeOwnedRoot(root: OwnedRoot) {
  let state;
  try { state = await lstat(root.path, { bigint: true }); }
  catch { fail("CUT_KOKORO_MLX_CLEANUP", "private Kokoro execution root disappeared before cleanup."); }
  if (!state.isDirectory() || state.isSymbolicLink() || state.dev !== root.dev || state.ino !== root.ino) {
    fail("CUT_KOKORO_MLX_CLEANUP", "private Kokoro execution root identity changed before cleanup.");
  }
  await rm(root.path, { recursive: true, force: false });
}

async function makePrivateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function copyAuthenticatedFile(
  authority: CutKokoroMlxAuthenticatedFile,
  targetPath: string,
  maximumBytes: number,
  label: string,
): Promise<StableFileSnapshot> {
  const snapshot = await snapshotRegularFile(authority.path, maximumBytes, label);
  assertExpected(snapshot, authority, label);
  await makePrivateDirectory(dirname(targetPath));
  let source: FileHandle | undefined;
  let target: FileHandle | undefined;
  try {
    source = await open(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceState = await source.stat({ bigint: true });
    if (sourceState.dev !== snapshot.dev || sourceState.ino !== snapshot.ino || sourceState.size !== snapshot.size
      || sourceState.mtimeNs !== snapshot.mtimeNs || sourceState.ctimeNs !== snapshot.ctimeNs) {
      fail("CUT_KOKORO_MLX_AUTHORITY", `${label} changed before private staging.`);
    }
    target = await open(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0n;
    while (position < snapshot.size) {
      const length = Number(snapshot.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : snapshot.size - position);
      const read = await source.read(buffer, 0, length, Number(position));
      if (read.bytesRead !== length) fail("CUT_KOKORO_MLX_AUTHORITY", `${label} changed during private staging.`);
      const written = await target.write(buffer, 0, length, Number(position));
      if (written.bytesWritten !== length) fail("CUT_KOKORO_MLX_AUTHORITY", `${label} could not be privately staged.`);
      position += BigInt(length);
    }
    await target.sync();
  } finally {
    await Promise.all([source?.close().catch(() => undefined), target?.close().catch(() => undefined)]);
  }
  const staged = await snapshotRegularFile(targetPath, maximumBytes, `staged ${label}`);
  if (staged.bytes !== snapshot.bytes || staged.sha256 !== snapshot.sha256) {
    fail("CUT_KOKORO_MLX_AUTHORITY", `staged ${label} differs from authenticated source bytes.`);
  }
  return snapshot;
}

async function copyTree(
  files: readonly CutKokoroMlxAuthenticatedTreeFile[],
  root: string,
  maximumBytes: number,
  label: string,
) {
  const snapshots: StableFileSnapshot[] = [];
  for (const file of files) {
    snapshots.push(await copyAuthenticatedFile(file, resolve(root, file.relativePath), maximumBytes, `${label} file`));
  }
  return snapshots;
}

async function writePrivateFile(path: string, bytes: Buffer) {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    const { bytesWritten } = await handle.write(bytes, 0, bytes.byteLength, 0);
    if (bytesWritten !== bytes.byteLength) fail("CUT_KOKORO_MLX_AUTHORITY", "private request could not be written completely.");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function processGroupExists(pid: number) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await processGroupExists(pid))) return true;
    await new Promise((accept) => setTimeout(accept, 25));
  } while (Date.now() < deadline);
  return !(await processGroupExists(pid));
}

function providerFailureDiagnostic(
  stderr: readonly Buffer[],
  stderrBytes: number,
  privateRoot: string,
  code: number | null,
  terminalSignal: NodeJS.Signals | null,
) {
  const bytes = Buffer.concat(stderr, stderrBytes);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { content = "<non-UTF-8 stderr>"; }
  const sanitized = content.replaceAll(privateRoot, "<private-root>")
    .replace(/[^\t\n\r\x20-\x7e]/gu, "?");
  const bounded = Buffer.from(sanitized, "utf8").subarray(0, 4_096).toString("utf8");
  return `exitCode=${code ?? "null"}; signal=${terminalSignal ?? "null"}; stderrBytes=${stderrBytes}; stderrSha256=${sha256(bytes)}; stderr=${JSON.stringify(bounded)}`;
}

async function runProvider(
  executable: string,
  args: readonly string[],
  privateRoot: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProcessResult> {
  if (signal?.aborted) fail("CUT_KOKORO_MLX_CANCELLED", "Kokoro MLX execution was cancelled before launch.");
  return new Promise<ProcessResult>((accept, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        detached: true,
        windowsHide: true,
        cwd: privateRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: Object.freeze({
          HOME: join(privateRoot, "home"),
          TMPDIR: join(privateRoot, "tmp"),
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_DATASETS_OFFLINE: "1",
          TOKENIZERS_PARALLELISM: "false",
        }),
      });
    } catch {
      reject(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_PROCESS", "Python could not start."));
      return;
    }
    let childErrorObserved = false;
    let handleChildError = () => { childErrorObserved = true; };
    // Register before consulting child.pid: spawn failures such as ENOENT and
    // EACCES are delivered asynchronously and must never become uncaught events.
    child.once("error", () => handleChildError());
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) < 1) {
      // ChildProcess.kill() is unsafe before Node has assigned a PID: on some
      // platforms it can target the caller's process group. The registered
      // error listener consumes the failed-spawn event; no child identity
      // exists that CUT can safely signal.
      reject(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_PROCESS", "Python launch did not yield one process identity."));
      return;
    }
    let failure: CutKokoroMlxLocalError | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    const signalTree = (value: NodeJS.Signals) => {
      try { process.kill(-pid!, value); return; } catch { /* direct child fallback */ }
      try { child.kill(value); } catch { /* already closed */ }
    };
    const drainProcessGroup = async () => {
      if (!(await processGroupExists(pid!))) return true;
      signalTree("SIGTERM");
      if (await waitForProcessGroupExit(pid!, cutKokoroMlxLocalPolicy.terminationGraceMs)) return true;
      signalTree("SIGKILL");
      return waitForProcessGroupExit(pid!, cutKokoroMlxLocalPolicy.terminationGraceMs);
    };
    const terminate = (error: CutKokoroMlxLocalError) => {
      if (failure) return;
      failure = error;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), cutKokoroMlxLocalPolicy.terminationGraceMs);
    };
    const abort = () => terminate(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_CANCELLED", "Kokoro MLX execution was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => terminate(new CutKokoroMlxLocalError(
      "CUT_KOKORO_MLX_TIMEOUT",
      `Kokoro MLX execution exceeded ${timeoutMs}ms.`,
    )), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      const copy = Buffer.from(chunk);
      stdoutBytes += copy.byteLength;
      if (stdoutBytes > cutKokoroMlxLocalPolicy.maximumStdoutBytes) {
        terminate(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX stdout exceeded its byte limit."));
      } else stdout.push(copy);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (failure) return;
      const copy = Buffer.from(chunk);
      stderrBytes += copy.byteLength;
      if (stderrBytes > cutKokoroMlxLocalPolicy.maximumStderrBytes) {
        terminate(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX stderr exceeded its byte limit."));
      } else stderr.push(copy);
    });
    handleChildError = () => terminate(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_PROCESS", "Python failed after launch."));
    if (childErrorObserved) handleChildError();
    child.once("close", async (code, terminalSignal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) {
        if (!(await drainProcessGroup())) {
          reject(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_CLEANUP", "Kokoro MLX process group survived forced cleanup."));
        } else reject(failure);
        return;
      }
      const leftDescendant = await processGroupExists(pid!);
      if (leftDescendant && !(await drainProcessGroup())) {
        reject(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_CLEANUP", "Kokoro MLX left a descendant process that survived forced cleanup."));
        return;
      }
      if (code !== 0 || terminalSignal !== null) {
        reject(new CutKokoroMlxLocalError(
          "CUT_KOKORO_MLX_PROCESS",
          `Kokoro MLX exited unsuccessfully: ${providerFailureDiagnostic(stderr, stderrBytes, privateRoot, code, terminalSignal)}.`,
        ));
        return;
      }
      if (leftDescendant) {
        reject(new CutKokoroMlxLocalError("CUT_KOKORO_MLX_CLEANUP", "Kokoro MLX left a descendant process; CUT terminated and drained the process group."));
        return;
      }
      accept(Object.freeze({ stdout: Buffer.concat(stdout, stdoutBytes), stderr: Buffer.concat(stderr, stderrBytes) }));
    });
  });
}

async function readOwnedFile(path: string, maximumBytes: number, label: string) {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const state = await handle.stat({ bigint: true });
    if (!state.isFile() || state.size < 1n || state.size > BigInt(maximumBytes)) {
      fail("CUT_KOKORO_MLX_OUTPUT", `${label} is not one bounded regular file.`);
    }
    const bytes = Buffer.alloc(Number(state.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead !== bytes.byteLength) fail("CUT_KOKORO_MLX_OUTPUT", `${label} changed while CUT read it.`);
    const after = await handle.stat({ bigint: true });
    if (after.dev !== state.dev || after.ino !== state.ino || after.size !== state.size
      || after.mtimeNs !== state.mtimeNs || after.ctimeNs !== state.ctimeNs) {
      fail("CUT_KOKORO_MLX_OUTPUT", `${label} changed while CUT read it.`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof CutKokoroMlxLocalError) throw error;
    fail("CUT_KOKORO_MLX_OUTPUT", `${label} could not be authenticated.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseWav(bytes: Buffer, expectedSampleRate: 24_000 | 48_000) {
  if (bytes.byteLength < 44 || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) !== bytes.byteLength - 8) {
    fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX output is not one closed RIFF/WAVE artifact.");
  }
  let offset = 12;
  let format: Readonly<{ channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number }> | undefined;
  let data: Buffer | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size;
    if (end > bytes.byteLength) fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX WAV chunk exceeds the artifact boundary.");
    if (id === "fmt ") {
      if (format || size < 16 || bytes.readUInt16LE(start) !== 1) {
        fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX WAV must contain one PCM format chunk.");
      }
      format = Object.freeze({
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      });
    } else if (id === "data") {
      if (data) fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX WAV contains duplicate data chunks.");
      data = bytes.subarray(start, end);
    }
    offset = end + (size & 1);
  }
  if (offset !== bytes.byteLength || !format || !data || data.byteLength < 2
    || format.channels !== 1 || format.sampleRate !== expectedSampleRate || format.bitsPerSample !== 16
    || format.blockAlign !== 2 || format.byteRate !== expectedSampleRate * 2 || data.byteLength % 2 !== 0) {
    fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX WAV does not match CUT's mono PCM16 output contract.");
  }
  let nonzero = false;
  for (let index = 0; index < data.byteLength; index += 2) {
    if (data.readInt16LE(index) !== 0) { nonzero = true; break; }
  }
  if (!nonzero) fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX WAV contains no audible PCM sample.");
  return Object.freeze({
    channels: 1 as const,
    sampleRate: expectedSampleRate,
    bitsPerSample: 16 as const,
    durationSamples: data.byteLength / 2,
    dataBytes: data.byteLength,
  });
}

function outputRecord(value: unknown, path: string) {
  return closedRecord(value, path, ["format", "version", "runtime", "model", "voice", "phonemizer", "synthesis", "output"]);
}

function assertAdapterResult(value: unknown, input: ReturnType<typeof parseInput>, wavBytes: Buffer, wav: ReturnType<typeof parseWav>) {
  const result = outputRecord(value, "$adapterResult");
  if (result.format !== cutKokoroMlxLocalPolicy.adapterResultFormat || result.version !== 2) {
    fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX returned an unsupported adapter result.");
  }
  const runtime = closedRecord(result.runtime, "$adapterResult.runtime", ["implementation", "pythonVersion", "platform", "machine", "componentSetSha256"]);
  const model = closedRecord(result.model, "$adapterResult.model", ["configSha256", "weightsSha256"]);
  const voice = closedRecord(result.voice, "$adapterResult.voice", ["name", "weightsSha256"]);
  const phonemizer = closedRecord(result.phonemizer, "$adapterResult.phonemizer", ["librarySha256", "dataTreeSha256"]);
  const synthesis = closedRecord(result.synthesis, "$adapterResult.synthesis", ["textSha256", "language", "speedMicros", "seed", "sampleRate"]);
  const output = closedRecord(result.output, "$adapterResult.output", ["bytes", "sha256", "durationSamples"]);
  const expected = [
    [runtime.implementation, input.python.implementation], [runtime.pythonVersion, input.python.pythonVersion],
    [runtime.platform, input.python.platform], [runtime.machine, input.python.machine],
    [runtime.componentSetSha256, input.runtime.componentSetSha256], [model.configSha256, input.model.config.sha256],
    [model.weightsSha256, input.model.weights.sha256], [voice.name, input.voice.name],
    [voice.weightsSha256, input.voice.weights.sha256], [phonemizer.librarySha256, input.phonemizer.library.sha256],
    [phonemizer.dataTreeSha256, input.phonemizer.dataTreeSha256],
    [synthesis.textSha256, sha256(input.synthesis.text)], [synthesis.language, input.synthesis.language],
    [synthesis.speedMicros, input.synthesis.speedMicros], [synthesis.seed, input.synthesis.seed],
    [synthesis.sampleRate, input.synthesis.sampleRate], [output.bytes, wavBytes.byteLength],
    [output.sha256, sha256(wavBytes)], [output.durationSamples, wav.durationSamples],
  ] as const;
  if (expected.some(([observed, wanted]) => observed !== wanted)) {
    fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX result does not bind the authenticated execution or WAV bytes.");
  }
}

function adapterRequest(input: ReturnType<typeof parseInput>) {
  const treeFile = (file: CutKokoroMlxAuthenticatedTreeFile) => Object.freeze({
    relativePath: file.relativePath,
    bytes: file.bytes,
    sha256: file.sha256,
  });
  const file = (value: CutKokoroMlxAuthenticatedFile) => Object.freeze({ bytes: value.bytes, sha256: value.sha256 });
  return Object.freeze({
    format: cutKokoroMlxLocalPolicy.adapterRequestFormat,
    version: 2,
    runtime: Object.freeze({
      componentSetSha256: input.runtime.componentSetSha256,
      components: Object.freeze(input.runtime.components.map((component) => Object.freeze({
        id: component.id,
        packages: Object.freeze(component.packages.map((value) => Object.freeze({
          name: value.name,
          packageVersion: value.packageVersion,
          license: value.license,
        }))),
        treeSha256: component.treeSha256,
        files: Object.freeze(component.files.map(treeFile)),
      }))),
    }),
    model: Object.freeze({ config: file(input.model.config), weights: file(input.model.weights) }),
    voice: Object.freeze({ name: input.voice.name, weights: file(input.voice.weights) }),
    phonemizer: Object.freeze({
      library: file(input.phonemizer.library),
      dataTreeSha256: input.phonemizer.dataTreeSha256,
      dataFiles: Object.freeze(input.phonemizer.dataFiles.map(treeFile)),
    }),
    synthesis: input.synthesis,
  });
}

/**
 * Execute a caller-selected Kokoro MLX environment. CUT authenticates and
 * privately stages the selected model, voice, adapter, runtime components, and
 * eSpeak bytes. Offline environment flags and the adapter's socket refusal are
 * defense in depth, not an OS-level network sandbox. No external file is
 * published; the returned WAV plus receipt are ready for a caller-owned
 * create-only transaction.
 */
export async function narrateWithKokoroMlxLocal(inputValue: CutKokoroMlxLocalInput): Promise<CutKokoroMlxLocalResult> {
  const input = parseInput(inputValue);
  if (!isCutKokoroMlxLocalPlatformSupported()) {
    fail("CUT_KOKORO_MLX_PLATFORM", "Kokoro MLX local execution requires darwin-arm64.");
  }
  if (input.signal?.aborted) fail("CUT_KOKORO_MLX_CANCELLED", "Kokoro MLX execution was cancelled before staging.");

  const root = await createOwnedRoot();
  const snapshots: Array<Readonly<{ value: StableFileSnapshot; maximum: number; label: string }>> = [];
  let processResult: ProcessResult | undefined;
  let primaryError: unknown;
  let result: CutKokoroMlxLocalResult | undefined;
  try {
    const runtimeRoot = join(root.path, "runtime");
    const modelRoot = join(root.path, "model");
    const espeakDataRoot = join(root.path, "espeak-data");
    const adapterPath = join(root.path, "adapter.py");
    const espeakLibraryPath = join(root.path, "libespeak-ng.dylib");
    const requestPath = join(root.path, "request.json");
    const outputPath = join(root.path, "output.wav");
    const resultPath = join(root.path, "result.json");
    await Promise.all([
      makePrivateDirectory(runtimeRoot), makePrivateDirectory(join(modelRoot, "voices")),
      makePrivateDirectory(espeakDataRoot), makePrivateDirectory(join(root.path, "home")),
      makePrivateDirectory(join(root.path, "tmp")),
    ]);

    const pythonSnapshot = await snapshotRegularFile(input.python.path, cutKokoroMlxLocalPolicy.maximumPythonBytes, "Python executable");
    assertExpected(pythonSnapshot, input.python, "Python executable");
    snapshots.push({ value: pythonSnapshot, maximum: cutKokoroMlxLocalPolicy.maximumPythonBytes, label: "Python executable" });
    const adapterSnapshot = await copyAuthenticatedFile(input.adapter, adapterPath, cutKokoroMlxLocalPolicy.maximumAdapterBytes, "Kokoro adapter");
    snapshots.push({ value: adapterSnapshot, maximum: cutKokoroMlxLocalPolicy.maximumAdapterBytes, label: "Kokoro adapter" });
    for (const component of input.runtime.components) {
      for (const snapshot of await copyTree(component.files, runtimeRoot, cutKokoroMlxLocalPolicy.maximumRuntimeBytes, `runtime component ${component.id}`)) {
        snapshots.push({ value: snapshot, maximum: cutKokoroMlxLocalPolicy.maximumRuntimeBytes, label: `runtime component ${component.id} file` });
      }
    }
    const configSnapshot = await copyAuthenticatedFile(input.model.config, join(modelRoot, "config.json"), cutKokoroMlxLocalPolicy.maximumModelConfigBytes, "Kokoro model config");
    const weightsSnapshot = await copyAuthenticatedFile(input.model.weights, join(modelRoot, "kokoro-v1_0.safetensors"), cutKokoroMlxLocalPolicy.maximumModelWeightsBytes, "Kokoro model weights");
    const voiceSnapshot = await copyAuthenticatedFile(input.voice.weights, join(modelRoot, "voices", `${input.voice.name}.safetensors`), cutKokoroMlxLocalPolicy.maximumVoiceBytes, "Kokoro voice weights");
    const librarySnapshot = await copyAuthenticatedFile(input.phonemizer.library, espeakLibraryPath, cutKokoroMlxLocalPolicy.maximumEspeakLibraryBytes, "eSpeak runtime");
    snapshots.push(
      { value: configSnapshot, maximum: cutKokoroMlxLocalPolicy.maximumModelConfigBytes, label: "Kokoro model config" },
      { value: weightsSnapshot, maximum: cutKokoroMlxLocalPolicy.maximumModelWeightsBytes, label: "Kokoro model weights" },
      { value: voiceSnapshot, maximum: cutKokoroMlxLocalPolicy.maximumVoiceBytes, label: "Kokoro voice weights" },
      { value: librarySnapshot, maximum: cutKokoroMlxLocalPolicy.maximumEspeakLibraryBytes, label: "eSpeak runtime" },
    );
    for (const snapshot of await copyTree(input.phonemizer.dataFiles, espeakDataRoot, cutKokoroMlxLocalPolicy.maximumEspeakDataBytes, "eSpeak data")) {
      snapshots.push({ value: snapshot, maximum: cutKokoroMlxLocalPolicy.maximumEspeakDataBytes, label: "eSpeak data file" });
    }
    await writePrivateFile(requestPath, canonicalBytes(adapterRequest(input)));

    const invocation = Object.freeze([
      `python-sha256:${input.python.sha256}`,
      "-I", "-B", "-s",
      `adapter-sha256:${input.adapter.sha256}`,
      `runtime-component-set-sha256:${input.runtime.componentSetSha256}`,
      `model-config-sha256:${input.model.config.sha256}`,
      `model-weights-sha256:${input.model.weights.sha256}`,
      `voice-sha256:${input.voice.weights.sha256}`,
      `espeak-library-sha256:${input.phonemizer.library.sha256}`,
      `espeak-data-tree-sha256:${input.phonemizer.dataTreeSha256}`,
    ]);
    const privateArguments = [
      "-I", "-B", "-s", adapterPath,
      "--request", requestPath,
      "--runtime-root", runtimeRoot,
      "--model-root", modelRoot,
      "--espeak-library", espeakLibraryPath,
      "--espeak-data", espeakDataRoot,
      "--output", outputPath,
      "--result", resultPath,
    ];
    try {
      processResult = await runProvider(input.python.path, privateArguments, root.path, input.timeoutMs, input.signal);
    } catch (error) { primaryError = error; }

    let authorityError: unknown;
    try {
      for (const snapshot of snapshots) await assertSnapshotUnchanged(snapshot.value, snapshot.maximum, snapshot.label);
    } catch (error) { authorityError = error; }
    if (authorityError) throw authorityError;
    if (primaryError) throw primaryError;
    if (processResult!.stdout.byteLength !== 0) {
      fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX adapter wrote unexpected stdout bytes.");
    }

    const [wavBytes, resultBytes] = await Promise.all([
      readOwnedFile(outputPath, cutKokoroMlxLocalPolicy.maximumWavBytes, "Kokoro MLX WAV"),
      readOwnedFile(resultPath, cutKokoroMlxLocalPolicy.maximumResultBytes, "Kokoro MLX result"),
    ]);
    const wav = parseWav(wavBytes, input.synthesis.sampleRate);
    let adapterResult: unknown;
    try { adapterResult = JSON.parse(resultBytes.toString("utf8")); }
    catch { fail("CUT_KOKORO_MLX_OUTPUT", "Kokoro MLX result is malformed JSON."); }
    assertAdapterResult(adapterResult, input, wavBytes, wav);
    const dataBytes = input.phonemizer.dataFiles.reduce((sum, file) => sum + file.bytes, 0);
    const receiptBody: CutKokoroMlxLocalReceiptBody = Object.freeze({
      format: "cut-kokoro-mlx-local-execution",
      version: 2,
      policy: cutKokoroMlxLocalPolicy.format,
      provider: cutKokoroMlxLocalPolicy.provider,
      syntheticSpeech: true,
      evidenceScope: Object.freeze({
        authority: cutKokoroMlxLocalPolicy.authorityScope,
        licenses: cutKokoroMlxLocalPolicy.licenseEvidenceBoundary,
        networkIsolation: cutKokoroMlxLocalPolicy.networkIsolationBoundary,
      }),
      synthesis: Object.freeze({
        text: input.synthesis.text,
        textBytes: Buffer.byteLength(input.synthesis.text, "utf8"),
        textSha256: sha256(input.synthesis.text),
        voice: input.voice.name,
        language: input.synthesis.language,
        speedMicros: input.synthesis.speedMicros,
        seed: input.synthesis.seed,
        sampleRate: input.synthesis.sampleRate,
      }),
      runtime: Object.freeze({
        python: Object.freeze({
          bytes: input.python.bytes,
          sha256: input.python.sha256,
          implementation: input.python.implementation,
          pythonVersion: input.python.pythonVersion,
          platform: input.python.platform,
          machine: input.python.machine,
        }),
        adapter: Object.freeze({ bytes: input.adapter.bytes, sha256: input.adapter.sha256, revision: input.adapter.revision }),
        components: Object.freeze(input.runtime.components.map((component) => Object.freeze({
          id: component.id,
          packages: Object.freeze(component.packages.map((value) => Object.freeze({
            name: value.name,
            packageVersion: value.packageVersion,
            declaredLicense: value.license,
          }))),
          fileCount: component.files.length,
          bytes: component.files.reduce((sum, file) => sum + file.bytes, 0),
          treeSha256: component.treeSha256,
        }))),
        componentSetSha256: input.runtime.componentSetSha256,
      }),
      model: Object.freeze({
        name: input.model.name,
        revision: input.model.revision,
        declaredLicense: input.model.license,
        config: Object.freeze({ bytes: input.model.config.bytes, sha256: input.model.config.sha256 }),
        weights: Object.freeze({ bytes: input.model.weights.bytes, sha256: input.model.weights.sha256 }),
      }),
      voice: Object.freeze({
        name: input.voice.name,
        declaredLicense: input.voice.license,
        bytes: input.voice.weights.bytes,
        sha256: input.voice.weights.sha256,
      }),
      phonemizer: Object.freeze({
        name: input.phonemizer.name,
        version: input.phonemizer.version,
        declaredLicense: input.phonemizer.license,
        notice: input.phonemizer.notice,
        library: Object.freeze({ bytes: input.phonemizer.library.bytes, sha256: input.phonemizer.library.sha256 }),
        dataFileCount: input.phonemizer.dataFiles.length,
        dataBytes,
        dataTreeSha256: input.phonemizer.dataTreeSha256,
      }),
      invocation,
      invocationSha256: sha256(stableJsonStringify(invocation)),
      stderr: Object.freeze({ bytes: processResult!.stderr.byteLength, sha256: sha256(processResult!.stderr) }),
      output: Object.freeze({ bytes: wavBytes.byteLength, sha256: sha256(wavBytes), ...wav }),
      determinism: Object.freeze({
        seedApplied: true,
        reproducibleInferenceClaim: false,
        boundary: cutKokoroMlxLocalPolicy.inferenceDeterminismBoundary,
      }),
    });
    const receipt: CutKokoroMlxLocalReceipt = Object.freeze({
      ...receiptBody,
      executionSha256: sha256(stableJsonStringify(receiptBody)),
    });
    result = Object.freeze({ wavBytes: Buffer.from(wavBytes), receipt, receiptBytes: canonicalBytes(receipt) });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try { await removeOwnedRoot(root); } catch (error) { cleanupError = error; }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  return result!;
}

async function collectTreeFilesUnchecked(
  rootValue: string,
  roots: readonly string[],
  maximumFiles: number,
  maximumBytes: number,
  label: string,
) {
  const root = await realpath(absolutePath(rootValue, "$collector.root"));
  const state = await lstat(root, { bigint: true });
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o022n) !== 0n) {
    fail("CUT_KOKORO_MLX_AUTHORITY", "collector root must be one physical, non-writable directory.");
  }
  const paths: string[] = [];
  const relativePaths = new Set<string>();
  const visit = async (path: string) => {
    const local = relative(root, path);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      fail("CUT_KOKORO_MLX_AUTHORITY", "collector path escaped its root.");
    }
    const observed = await lstat(path, { bigint: true });
    if (observed.isSymbolicLink()) fail("CUT_KOKORO_MLX_AUTHORITY", "collector tree contains a symbolic link.");
    if (observed.isDirectory()) {
      if (path.endsWith(`${sep}__pycache__`)) return;
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (observed.isFile()) {
      if (!path.endsWith(".pyc")) {
        const relativeFile = relative(root, path).split(sep).join("/");
        if (relativePaths.has(relativeFile)) {
          fail("CUT_KOKORO_MLX_AUTHORITY", "collector roots overlap or repeat one runtime file.");
        }
        if (paths.length >= maximumFiles) {
          fail("CUT_KOKORO_MLX_AUTHORITY", `${label} exceeds its file-count limit.`);
        }
        relativePaths.add(relativeFile);
        paths.push(path);
      }
    } else fail("CUT_KOKORO_MLX_AUTHORITY", "collector tree contains an unsupported filesystem entry.");
  };
  for (const entry of roots) {
    const relativeEntry = relativePath(entry, "$collector.roots[]");
    await visit(resolve(root, relativeEntry));
  }
  if (paths.length < 1) fail("CUT_KOKORO_MLX_AUTHORITY", `${label} contains no source file.`);
  const files = await Promise.all(paths.map(async (path) => {
    const snapshot = await snapshotRegularFile(path, maximumBytes, `${label} file`);
    return Object.freeze({ path, relativePath: relative(root, path).split(sep).join("/"), bytes: snapshot.bytes, sha256: snapshot.sha256 });
  }));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
    fail("CUT_KOKORO_MLX_AUTHORITY", `${label} exceeds its byte limit.`);
  }
  return Object.freeze(files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath)));
}

async function collectTreeFiles(
  rootValue: string,
  roots: readonly string[],
  maximumFiles: number,
  maximumBytes: number,
  label: string,
) {
  try {
    return await collectTreeFilesUnchecked(rootValue, roots, maximumFiles, maximumBytes, label);
  } catch (error) {
    if (error instanceof CutKokoroMlxLocalError) throw error;
    return fail("CUT_KOKORO_MLX_AUTHORITY", `${label} could not be authenticated.`);
  }
}

async function collectorTreeRootEntries(rootValue: string, label: string) {
  try {
    return (await readdir(await realpath(rootValue))).sort();
  } catch (error) {
    if (error instanceof CutKokoroMlxLocalError) throw error;
    return fail("CUT_KOKORO_MLX_AUTHORITY", `${label} could not be authenticated.`);
  }
}

export type CutKokoroMlxLocalAuthorityPaths = Readonly<{
  python: Readonly<{ path: string; pythonVersion: string }>;
  adapter: Readonly<{ path: string; revision: string }>;
  runtime: Readonly<{
    sitePackagesRoot: string;
    components: readonly Readonly<{
      id: string;
      roots: readonly string[];
      packages: readonly Readonly<{
        name: string;
        packageVersion: string;
        license: string;
      }>[];
    }>[];
  }>;
  model: Readonly<{
    name: string;
    revision: string;
    license: string;
    configPath: string;
    weightsPath: string;
  }>;
  voice: Readonly<{ name: string; license: string; weightsPath: string }>;
  phonemizer: Readonly<{
    version: string;
    libraryPath: string;
    dataRoot: string;
  }>;
}>;

/**
 * Real-smoke entry seam: authenticate one already-installed, user-supplied
 * offline environment. This performs no download, install, or inference.
 */
export async function collectKokoroMlxLocalAuthorities(
  paths: CutKokoroMlxLocalAuthorityPaths,
): Promise<CutKokoroMlxLocalAuthorities> {
  if (!Array.isArray(paths.runtime.components) || paths.runtime.components.length < 1
    || paths.runtime.components.length > cutKokoroMlxLocalPolicy.maximumRuntimeComponents) {
    fail("CUT_KOKORO_MLX_AUTHORITY", "collector runtime exceeds its component-count limit.");
  }
  const declaredComponents = paths.runtime.components as CutKokoroMlxLocalAuthorityPaths["runtime"]["components"];
  if (declaredComponents.some((component) => !Array.isArray(component.roots)
    || component.roots.length < 1
    || component.roots.length > cutKokoroMlxLocalPolicy.maximumRuntimeRootsPerComponent)) {
    fail("CUT_KOKORO_MLX_AUTHORITY", "collector runtime exceeds its per-component root-count limit.");
  }
  const declaredPackageCount = declaredComponents.reduce((sum, component) => sum + component.packages.length, 0);
  if (declaredPackageCount < 1 || declaredPackageCount > cutKokoroMlxLocalPolicy.maximumRuntimePackages) {
    fail("CUT_KOKORO_MLX_AUTHORITY", "collector runtime exceeds its package-count limit.");
  }
  const phonemizerDataRoots = await collectorTreeRootEntries(paths.phonemizer.dataRoot, "eSpeak data");
  const [python, adapter, config, weights, voiceWeights, library, runtimeComponents, dataFiles] = await Promise.all([
    snapshotCollectorFile(paths.python.path, cutKokoroMlxLocalPolicy.maximumPythonBytes, "Python executable"),
    snapshotCollectorFile(paths.adapter.path, cutKokoroMlxLocalPolicy.maximumAdapterBytes, "Kokoro adapter"),
    snapshotCollectorFile(paths.model.configPath, cutKokoroMlxLocalPolicy.maximumModelConfigBytes, "Kokoro model config"),
    snapshotCollectorFile(paths.model.weightsPath, cutKokoroMlxLocalPolicy.maximumModelWeightsBytes, "Kokoro model weights"),
    snapshotCollectorFile(paths.voice.weightsPath, cutKokoroMlxLocalPolicy.maximumVoiceBytes, "Kokoro voice weights"),
    snapshotCollectorFile(paths.phonemizer.libraryPath, cutKokoroMlxLocalPolicy.maximumEspeakLibraryBytes, "eSpeak runtime"),
    Promise.all(declaredComponents.map(async (component, componentIndex) => {
      const id = packageName(component.id, `$collector.runtime.components[${componentIndex}].id`);
      const packages = Object.freeze(component.packages.map((value, packageIndex) => Object.freeze({
        name: packageName(value.name, `$collector.runtime.components[${componentIndex}].packages[${packageIndex}].name`),
        packageVersion: token(value.packageVersion, `$collector.runtime.components[${componentIndex}].packages[${packageIndex}].packageVersion`),
        license: text(value.license, `$collector.runtime.components[${componentIndex}].packages[${packageIndex}].license`),
      })).sort((left, right) => compareUtf8(left.name, right.name)));
      const files = await collectTreeFiles(
        paths.runtime.sitePackagesRoot,
        [...component.roots].sort(),
        cutKokoroMlxLocalPolicy.maximumRuntimeFiles,
        cutKokoroMlxLocalPolicy.maximumRuntimeBytes,
        `runtime component ${id}`,
      );
      return Object.freeze({ id, packages, files, treeSha256: treeDigest(files) });
    })),
    collectTreeFiles(
      paths.phonemizer.dataRoot,
      phonemizerDataRoots,
      cutKokoroMlxLocalPolicy.maximumEspeakDataFiles,
      cutKokoroMlxLocalPolicy.maximumEspeakDataBytes,
      "eSpeak data",
    ),
  ]);
  const file = (value: StableFileSnapshot) => Object.freeze({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
  const components = Object.freeze([...runtimeComponents].sort((left, right) => compareUtf8(left.id, right.id)));
  const allRuntimeFiles = components.flatMap((component) => component.files);
  const allPackages = components.flatMap((component) => component.packages);
  const runtimeBytes = allRuntimeFiles.reduce((sum, value) => sum + value.bytes, 0);
  if (new Set(components.map((component) => component.id)).size !== components.length
    || new Set(allRuntimeFiles.map((value) => value.relativePath)).size !== allRuntimeFiles.length
    || allRuntimeFiles.length > cutKokoroMlxLocalPolicy.maximumRuntimeFiles
    || !Number.isSafeInteger(runtimeBytes) || runtimeBytes > cutKokoroMlxLocalPolicy.maximumRuntimeBytes) {
    fail("CUT_KOKORO_MLX_AUTHORITY", "collector runtime components overlap or exceed their aggregate file authority.");
  }
  if (new Set(allPackages.map((value) => value.name)).size !== allPackages.length
    || !["kokoro-mlx", "misaki", "mlx", "mlx-metal", "numpy", "safetensors"]
      .every((name) => allPackages.some((value) => value.name === name))) {
    fail("CUT_KOKORO_MLX_AUTHORITY", "collector runtime packages overlap or omit a required Kokoro MLX package.");
  }
  return Object.freeze({
    python: Object.freeze({
      ...file(python),
      implementation: "CPython",
      pythonVersion: token(paths.python.pythonVersion, "$collector.pythonVersion"),
      platform: "darwin",
      machine: "arm64",
    }),
    adapter: Object.freeze({ ...file(adapter), revision: token(paths.adapter.revision, "$collector.adapter.revision") }),
    runtime: Object.freeze({ components, componentSetSha256: componentSetDigest(components) }),
    model: Object.freeze({
      name: text(paths.model.name, "$collector.model.name"),
      revision: token(paths.model.revision, "$collector.model.revision"),
      license: text(paths.model.license, "$collector.model.license"),
      config: file(config),
      weights: file(weights),
    }),
    voice: Object.freeze({
      name: text(paths.voice.name, "$collector.voice.name", 64),
      license: text(paths.voice.license, "$collector.voice.license"),
      weights: file(voiceWeights),
    }),
    phonemizer: Object.freeze({
      name: "eSpeak NG",
      version: token(paths.phonemizer.version, "$collector.phonemizer.version"),
      license: "GPL-3.0-or-later",
      notice: cutKokoroMlxLocalPolicy.gplPhonemizerNotice,
      library: file(library),
      dataFiles,
      dataTreeSha256: treeDigest(dataFiles),
    }),
  });
}
