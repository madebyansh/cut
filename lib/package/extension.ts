import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { cutProductVersion } from "../version";
import { packageFail } from "./diagnostics";
import { directPhysicalExtensionDirectory, readContainedExtensionFile } from "./extension-file";
import { cutExtensionTerminationConfirmationMs, runCutExtensionWorker } from "./extension-worker";
import { parseStrictPackageJson, type CutPackageJsonLimits } from "./json";
import { validateCutPackageFileLocator } from "./manifest";
import { parseCutSemVer } from "./semver";

export const cutExtensionManifestFile = "cut.extension.json";
export const cutExtensionAbi = "cut-extension-wasm-byte-v1";
export const cutExtensionIsolationProfile = "cut-worker-wasm-zero-host-v1";

export type CutExtensionHostCapability =
  | "filesystem:read-assets"
  | "filesystem:write-output"
  | "gpu:compute"
  | "native:host"
  | "network:https"
  | "secret:read";

export type CutExtensionKind = "analysis" | "audio-processor" | "byte-processor" | "generator" | "shader";
export type CutExtensionImplementationFormat = "native" | "wasm";
export type CutExtensionDeterminismTier = "nondeterministic" | "same-runtime-byte" | "seeded";

export type CutExtensionManifest = Readonly<{
  format: "cut-extension";
  manifestVersion: 1;
  abi: typeof cutExtensionAbi;
  name: string;
  version: string;
  kind: CutExtensionKind;
  implementation: Readonly<{
    format: CutExtensionImplementationFormat;
    entry: string;
    sha256: string;
  }>;
  capabilities: readonly CutExtensionHostCapability[];
  determinism: Readonly<{
    tier: CutExtensionDeterminismTier;
  }>;
  budgets: Readonly<{
    timeoutMs: number;
    memoryPages: number;
    maximumModuleBytes: number;
    maximumInputBytes: number;
    maximumOutputBytes: number;
    maximumConcurrency: number;
  }>;
}>;

export type CutExtensionVerificationReport = Readonly<{
  format: "cut-extension-verification";
  version: 1;
  status: "pass";
  extension: Readonly<{
    name: string;
    version: string;
    kind: CutExtensionKind;
    abi: typeof cutExtensionAbi;
    manifestIntegrity: string;
    implementationIntegrity: string;
  }>;
  determinism: Readonly<{
    declared: "same-runtime-byte";
    executionReconciliationRuns: 2;
    performedDuringVerification: false;
  }>;
  isolation: CutExtensionIsolationEvidence;
  budgets: CutExtensionManifest["budgets"];
}>;

export type CutExtensionExecutionReport = Readonly<{
  format: "cut-extension-execution";
  version: 1;
  status: "pass";
  extension: CutExtensionVerificationReport["extension"];
  input: Readonly<{ bytes: number; sha256: string }>;
  output: Readonly<{ bytes: number; sha256: string }>;
  determinism: Readonly<{
    declared: "same-runtime-byte";
    reconciliationRuns: 2;
    byteIdentical: true;
  }>;
  isolation: CutExtensionIsolationEvidence;
  budgets: CutExtensionManifest["budgets"];
}>;

export type CutExtensionExecutionResult = Readonly<{
  bytes: Uint8Array;
  report: CutExtensionExecutionReport;
}>;

type CutExtensionIsolationEvidence = Readonly<{
  profile: typeof cutExtensionIsolationProfile;
  executionBoundary: "dedicated-worker-thread";
  implementation: "wasm";
  admittedImports: readonly ["cut.memory"];
  grantedCapabilities: readonly [];
  ambientAccess: Readonly<{
    filesystem: false;
    network: false;
    gpu: false;
    native: false;
    secrets: false;
    clock: false;
    randomness: false;
  }>;
  timeout: "terminate-worker";
  memory: "host-owned-fixed-maximum";
  concurrencyScope: "current-node-process";
  runtime: Readonly<{
    cut: string;
    node: string;
    nodeAbi: string;
    v8: string;
    platform: NodeJS.Platform;
    architecture: string;
    workerSha256: string;
    parentOrchestrationSha256: string;
    isolationIdentitySha256: string;
    workerResourceLimits: Readonly<{
      maxOldGenerationSizeMb: number;
      maxYoungGenerationSizeMb: number;
      stackSizeMb: number;
    }>;
    hardCeilings: CutExtensionManifest["budgets"];
    terminationConfirmationMs: number;
    parentModules: readonly Readonly<{
      locator: string;
      sha256: string;
    }>[];
  }>;
}>;

type VerifiedExtensionBytes = Readonly<{
  manifest: CutExtensionManifest;
  manifestIntegrity: string;
  implementationIntegrity: string;
  implementationBytes: Uint8Array;
}>;

type WorkerSuccess = Readonly<{
  format: "cut-extension-worker-result";
  version: 1;
  status: "pass";
  output: ArrayBuffer;
}>;

type WorkerFailure = Readonly<{
  format: "cut-extension-worker-result";
  version: 1;
  status: "fail";
  code: string;
  message: string;
}>;

const digestPattern = /^[a-f0-9]{64}$/u;
const packageNamePattern = /^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const unsafeNames = new Set(["__proto__", "constructor", "prototype"]);
const hostCapabilities = Object.freeze([
  "filesystem:read-assets",
  "filesystem:write-output",
  "gpu:compute",
  "native:host",
  "network:https",
  "secret:read",
] as const satisfies readonly CutExtensionHostCapability[]);
const hostCapabilitySet = new Set<string>(hostCapabilities);
const kinds = new Set<CutExtensionKind>(["analysis", "audio-processor", "byte-processor", "generator", "shader"]);
const implementationFormats = new Set<CutExtensionImplementationFormat>(["native", "wasm"]);
const determinismTiers = new Set<CutExtensionDeterminismTier>(["nondeterministic", "same-runtime-byte", "seeded"]);
const hardBudgets = Object.freeze({
  timeoutMs: 5_000,
  memoryPages: 256,
  maximumModuleBytes: 8 * 1024 * 1024,
  maximumInputBytes: 16 * 1024 * 1024,
  maximumOutputBytes: 16 * 1024 * 1024,
  maximumConcurrency: 4,
});
const extensionWorkerResourceLimits = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 8,
  stackSizeMb: 2,
});
const maximumManifestBytes = 256 * 1024;
const wasmPageBytes = 65_536;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) packageFail("CUT_EXTENSION_TYPE", path, "must be a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) packageFail("CUT_EXTENSION_TYPE", path, "must be a plain object.");
  return value as Record<string, unknown>;
}

function closed(value: unknown, path: string, fields: readonly string[]) {
  const result = record(value, path), allowed = new Set(fields);
  for (const field of fields) if (!Object.hasOwn(result, field)) packageFail("CUT_EXTENSION_MISSING_FIELD", path, `is missing required field ${JSON.stringify(field)}.`);
  for (const field of Object.keys(result)) if (!allowed.has(field)) packageFail("CUT_EXTENSION_UNKNOWN_FIELD", `${path}.${field}`, `is not part of ${cutExtensionManifestFile} v1.`);
  return result;
}

function text(value: unknown, path: string, maximum: number) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) {
    packageFail("CUT_EXTENSION_TYPE", path, `must be a non-empty string no longer than ${maximum} UTF-8 bytes without NUL.`);
  }
  return value;
}

function boundedInteger(value: unknown, path: string, hardMaximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > hardMaximum) {
    packageFail("CUT_EXTENSION_BUDGET", path, `must be an integer from 1 through the hard ceiling ${hardMaximum}.`);
  }
  return Number(value);
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

export function validateCutExtensionManifest(value: unknown): CutExtensionManifest {
  const manifest = closed(value, "$", ["abi", "budgets", "capabilities", "determinism", "format", "implementation", "kind", "manifestVersion", "name", "version"]);
  if (manifest.format !== "cut-extension" || manifest.manifestVersion !== 1) {
    packageFail("CUT_EXTENSION_VERSION", "$", "requires cut-extension manifest v1.");
  }
  if (manifest.abi !== cutExtensionAbi) {
    packageFail("CUT_EXTENSION_ABI", "$.abi", `requires exact ABI ${JSON.stringify(cutExtensionAbi)}.`);
  }
  const name = text(manifest.name, "$.name", 214);
  if (!packageNamePattern.test(name) || unsafeNames.has(name) || name.startsWith("@cut/") || name.startsWith("cut:")) {
    packageFail("CUT_EXTENSION_NAME", "$.name", `invalid or reserved extension name ${JSON.stringify(name)}.`);
  }
  const version = text(manifest.version, "$.version", 128);
  parseCutSemVer(version, "$.version");
  if (typeof manifest.kind !== "string" || !kinds.has(manifest.kind as CutExtensionKind)) {
    packageFail("CUT_EXTENSION_KIND", "$.kind", `must be one of ${[...kinds].sort().map((item) => JSON.stringify(item)).join(", ")}.`);
  }

  const implementation = closed(manifest.implementation, "$.implementation", ["entry", "format", "sha256"]);
  if (typeof implementation.format !== "string" || !implementationFormats.has(implementation.format as CutExtensionImplementationFormat)) {
    packageFail("CUT_EXTENSION_IMPLEMENTATION", "$.implementation.format", "must be exactly \"wasm\" or \"native\".");
  }
  const entry = validateCutPackageFileLocator(implementation.entry, "$.implementation.entry");
  const implementationSha256 = text(implementation.sha256, "$.implementation.sha256", 64);
  if (!digestPattern.test(implementationSha256)) packageFail("CUT_EXTENSION_INTEGRITY", "$.implementation.sha256", "must be a lowercase 64-character SHA-256 digest.");

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > hostCapabilities.length) {
    packageFail("CUT_EXTENSION_CAPABILITY", "$.capabilities", `must be an array with at most ${hostCapabilities.length} capabilities.`);
  }
  const capabilities: CutExtensionHostCapability[] = [], seenCapabilities = new Set<string>();
  manifest.capabilities.forEach((capability, index) => {
    if (typeof capability !== "string" || !hostCapabilitySet.has(capability)) {
      packageFail("CUT_EXTENSION_CAPABILITY", `$.capabilities[${index}]`, `unknown host capability ${JSON.stringify(capability)}.`);
    }
    if (seenCapabilities.has(capability)) packageFail("CUT_EXTENSION_CAPABILITY", `$.capabilities[${index}]`, `duplicate host capability ${JSON.stringify(capability)}.`);
    seenCapabilities.add(capability);
    capabilities.push(capability as CutExtensionHostCapability);
  });
  capabilities.sort();

  const determinism = closed(manifest.determinism, "$.determinism", ["tier"]);
  if (typeof determinism.tier !== "string" || !determinismTiers.has(determinism.tier as CutExtensionDeterminismTier)) {
    packageFail("CUT_EXTENSION_DETERMINISM", "$.determinism.tier", `must be one of ${[...determinismTiers].sort().map((item) => JSON.stringify(item)).join(", ")}.`);
  }

  const rawBudgets = closed(manifest.budgets, "$.budgets", ["maximumConcurrency", "maximumInputBytes", "maximumModuleBytes", "maximumOutputBytes", "memoryPages", "timeoutMs"]);
  const budgets = {
    timeoutMs: boundedInteger(rawBudgets.timeoutMs, "$.budgets.timeoutMs", hardBudgets.timeoutMs),
    memoryPages: boundedInteger(rawBudgets.memoryPages, "$.budgets.memoryPages", hardBudgets.memoryPages),
    maximumModuleBytes: boundedInteger(rawBudgets.maximumModuleBytes, "$.budgets.maximumModuleBytes", hardBudgets.maximumModuleBytes),
    maximumInputBytes: boundedInteger(rawBudgets.maximumInputBytes, "$.budgets.maximumInputBytes", hardBudgets.maximumInputBytes),
    maximumOutputBytes: boundedInteger(rawBudgets.maximumOutputBytes, "$.budgets.maximumOutputBytes", hardBudgets.maximumOutputBytes),
    maximumConcurrency: boundedInteger(rawBudgets.maximumConcurrency, "$.budgets.maximumConcurrency", hardBudgets.maximumConcurrency),
  };
  if (budgets.maximumInputBytes + budgets.maximumOutputBytes + 15 > budgets.memoryPages * wasmPageBytes) {
    packageFail("CUT_EXTENSION_BUDGET", "$.budgets", "memoryPages cannot contain the declared maximum input plus aligned maximum output.");
  }

  return deepFreeze(canonicalClone({
    format: "cut-extension",
    manifestVersion: 1,
    abi: cutExtensionAbi,
    name,
    version,
    kind: manifest.kind as CutExtensionKind,
    implementation: {
      format: implementation.format as CutExtensionImplementationFormat,
      entry,
      sha256: implementationSha256,
    },
    capabilities,
    determinism: { tier: determinism.tier as CutExtensionDeterminismTier },
    budgets,
  }));
}

export function loadCutExtensionManifest(input: string | Uint8Array, options: { jsonLimits?: Partial<CutPackageJsonLimits> } = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => key !== "jsonLimits")) {
    packageFail("CUT_EXTENSION_UNKNOWN_FIELD", "$.options", "contains an unsupported option.");
  }
  return validateCutExtensionManifest(parseStrictPackageJson(input, { limits: options.jsonLimits }));
}

export function cutExtensionManifestIntegrity(manifest: CutExtensionManifest) {
  return `sha256-${createHash("sha256").update(stableJsonStringify(manifest)).digest("hex")}`;
}

function systemCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}

async function readManifest(directory: string) {
  const root = await directPhysicalExtensionDirectory(directory);
  const packageMarker = resolve(root, "cut.package.json"), marker = await lstat(packageMarker).catch((error) => {
    if (systemCode(error) === "ENOENT") return undefined;
    packageFail("CUT_EXTENSION_PATH", "cut.package.json", `cannot be inspected (${systemCode(error)}).`);
  });
  if (marker) packageFail("CUT_EXTENSION_FORMAT_CONFLICT", "$directory", "an executable extension directory cannot also be a cut.package.json source package.");
  const bytes = await readContainedExtensionFile(root, cutExtensionManifestFile, maximumManifestBytes, cutExtensionManifestFile);
  return { root, manifest: loadCutExtensionManifest(bytes) };
}

function assertReleaseAdmissible(manifest: CutExtensionManifest) {
  if (manifest.capabilities.length) {
    packageFail(
      "CUT_EXTENSION_CAPABILITY_DENIED",
      "$.capabilities",
      `ABI ${JSON.stringify(cutExtensionAbi)} grants no ambient host capabilities; declared ${JSON.stringify(manifest.capabilities[0])} access is unavailable in release execution.`,
    );
  }
  if (manifest.implementation.format !== "wasm") {
    packageFail("CUT_EXTENSION_IMPLEMENTATION_DENIED", "$.implementation.format", "native extensions have no in-process or unsandboxed fallback; this reference release executes only the zero-host-import WASM ABI.");
  }
  if (manifest.kind !== "byte-processor") {
    packageFail("CUT_EXTENSION_KIND_DENIED", "$.kind", "the v1 byte-transform ABI does not claim shader, audio, generator, or analysis domain semantics.");
  }
  if (manifest.determinism.tier !== "same-runtime-byte") {
    packageFail("CUT_EXTENSION_DETERMINISM_DENIED", "$.determinism.tier", "reference release execution requires same-runtime byte determinism with two fresh-instance reconciliation runs.");
  }
}

async function verifiedExtensionBytes(directory: string): Promise<VerifiedExtensionBytes> {
  const { root, manifest } = await readManifest(directory);
  assertReleaseAdmissible(manifest);
  const implementationBytes = await readContainedExtensionFile(root, manifest.implementation.entry, manifest.budgets.maximumModuleBytes, "$.implementation.entry");
  const observed = createHash("sha256").update(implementationBytes).digest("hex");
  if (observed !== manifest.implementation.sha256) packageFail("CUT_EXTENSION_INTEGRITY", "$.implementation.sha256", "does not match the exact implementation bytes.");
  return Object.freeze({
    manifest,
    manifestIntegrity: cutExtensionManifestIntegrity(manifest),
    implementationIntegrity: `sha256-${observed}`,
    implementationBytes,
  });
}

function extensionIdentity(bundle: VerifiedExtensionBytes): CutExtensionVerificationReport["extension"] {
  return Object.freeze({
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    kind: bundle.manifest.kind,
    abi: cutExtensionAbi,
    manifestIntegrity: bundle.manifestIntegrity,
    implementationIntegrity: bundle.implementationIntegrity,
  });
}

const extensionWorkerSource = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const response = (value, transfer = []) => {
  parentPort.postMessage(value, transfer);
  parentPort.close();
};
const fail = (code, message) => response({
  format: "cut-extension-worker-result",
  version: 1,
  status: "fail",
  code,
  message,
});
const equal = (left, right) => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
};
const aligned = (value) => (value + 15) & ~15;
const exactAbiTypes = (bytes) => {
  let offset = 8;
  const readByte = (limit) => {
    if (offset >= limit) throw new Error("truncated WebAssembly section");
    return bytes[offset++];
  };
  const readU32 = (limit) => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = readByte(limit);
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
    }
    throw new Error("invalid WebAssembly u32");
  };
  const readName = (limit) => {
    const length = readU32(limit);
    if (offset + length > limit) throw new Error("truncated WebAssembly name");
    const value = Buffer.from(bytes.subarray(offset, offset + length)).toString("utf8");
    offset += length;
    return value;
  };
  const types = [], functionTypes = [], exports = new Map();
  while (offset < bytes.byteLength) {
    const id = readByte(bytes.byteLength), size = readU32(bytes.byteLength), end = offset + size;
    if (end > bytes.byteLength) throw new Error("truncated WebAssembly section");
    if (id === 1) {
      const count = readU32(end);
      for (let index = 0; index < count; index += 1) {
        if (readByte(end) !== 0x60) throw new Error("unsupported WebAssembly type");
        const parameterCount = readU32(end), parameters = [];
        for (let parameter = 0; parameter < parameterCount; parameter += 1) parameters.push(readByte(end));
        const resultCount = readU32(end), results = [];
        for (let result = 0; result < resultCount; result += 1) results.push(readByte(end));
        types.push({ parameters, results });
      }
    } else if (id === 3) {
      const count = readU32(end);
      for (let index = 0; index < count; index += 1) functionTypes.push(readU32(end));
    } else if (id === 7) {
      const count = readU32(end);
      for (let index = 0; index < count; index += 1) {
        const name = readName(end), kind = readByte(end), itemIndex = readU32(end);
        if (kind === 0) exports.set(name, itemIndex);
      }
    }
    offset = end;
  }
  const matches = (name, parameters, results) => {
    const functionIndex = exports.get(name);
    const type = Number.isInteger(functionIndex) ? types[functionTypes[functionIndex]] : undefined;
    return type
      && type.parameters.length === parameters.length
      && type.results.length === results.length
      && type.parameters.every((value, index) => value === parameters[index])
      && type.results.every((value, index) => value === results[index]);
  };
  return matches("cut_abi_version", [], [0x7f])
    && matches("cut_process", [0x7f, 0x7f, 0x7f, 0x7f], [0x7f]);
};
const instantiate = async (module) => {
  const memory = new WebAssembly.Memory({
    initial: workerData.memoryPages,
    maximum: workerData.memoryPages,
  });
  let instance;
  try { instance = await WebAssembly.instantiate(module, { cut: { memory } }); }
  catch { throw Object.assign(new Error("module cannot instantiate against the fixed CUT memory"), { code: "CUT_EXTENSION_WASM_INSTANTIATE" }); }
  const abi = instance.exports.cut_abi_version;
  const process = instance.exports.cut_process;
  if (typeof abi !== "function" || typeof process !== "function") {
    throw Object.assign(new Error("module must export cut_abi_version and cut_process functions"), { code: "CUT_EXTENSION_EXPORT" });
  }
  let version;
  try { version = abi(); }
  catch { throw Object.assign(new Error("cut_abi_version failed"), { code: "CUT_EXTENSION_ABI_EXECUTION" }); }
  if (version !== 1) throw Object.assign(new Error("cut_abi_version must return 1"), { code: "CUT_EXTENSION_ABI_EXECUTION" });
  return { memory, process };
};
(async () => {
  let module;
  try { module = await WebAssembly.compile(new Uint8Array(workerData.moduleBytes)); }
  catch { return fail("CUT_EXTENSION_WASM_COMPILE", "implementation is not a valid bounded WebAssembly module"); }
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 1 || imports[0].module !== "cut" || imports[0].name !== "memory" || imports[0].kind !== "memory") {
    return fail("CUT_EXTENSION_IMPORT_DENIED", "the only admitted import is the CUT-owned cut.memory");
  }
  const exports = WebAssembly.Module.exports(module);
  if (exports.length !== 2
    || !exports.some((item) => item.name === "cut_abi_version" && item.kind === "function")
    || !exports.some((item) => item.name === "cut_process" && item.kind === "function")) {
    return fail("CUT_EXTENSION_EXPORT", "the closed ABI exports exactly cut_abi_version and cut_process functions");
  }
  try {
    if (!exactAbiTypes(new Uint8Array(workerData.moduleBytes))) {
      return fail("CUT_EXTENSION_ABI_SIGNATURE", "exported functions do not match the exact v1 i32 signatures");
    }
  } catch {
    return fail("CUT_EXTENSION_ABI_SIGNATURE", "cannot authenticate the exact v1 function signatures");
  }
  try {
    if (workerData.mode === "verify") {
      await instantiate(module);
      return response({ format: "cut-extension-worker-result", version: 1, status: "pass", output: new ArrayBuffer(0) });
    }
    const input = new Uint8Array(workerData.inputBytes);
    const execute = async () => {
      const { memory, process } = await instantiate(module);
      const outputOffset = aligned(input.byteLength);
      const surface = new Uint8Array(memory.buffer);
      if (outputOffset + workerData.maximumOutputBytes > surface.byteLength) {
        throw Object.assign(new Error("fixed memory cannot contain input and output"), { code: "CUT_EXTENSION_MEMORY_LIMIT" });
      }
      surface.set(input, 0);
      let length;
      try { length = process(0, input.byteLength, outputOffset, workerData.maximumOutputBytes); }
      catch { throw Object.assign(new Error("cut_process trapped"), { code: "CUT_EXTENSION_EXECUTION" }); }
      if (!Number.isSafeInteger(length) || length < 0 || length > workerData.maximumOutputBytes) {
        throw Object.assign(new Error("cut_process returned an invalid output length"), { code: "CUT_EXTENSION_OUTPUT_LIMIT" });
      }
      return surface.slice(outputOffset, outputOffset + length);
    };
    const first = await execute(), second = await execute();
    if (!equal(first, second)) return fail("CUT_EXTENSION_NONDETERMINISTIC", "fresh-instance reconciliation produced different output bytes");
    const output = first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength);
    return response({ format: "cut-extension-worker-result", version: 1, status: "pass", output }, [output]);
  } catch (error) {
    return fail(typeof error.code === "string" ? error.code : "CUT_EXTENSION_EXECUTION", typeof error.message === "string" ? error.message : "extension execution failed");
  }
})().catch(() => fail("CUT_EXTENSION_EXECUTION", "extension worker failed closed"));
`;

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function shippedParentModuleIdentity() {
  const entries = [
    ["extension.js", __filename],
    ["extension-file.js", require.resolve("./extension-file")],
    ["extension-worker.js", require.resolve("./extension-worker")],
    ["diagnostics.js", require.resolve("./diagnostics")],
    ["json.js", require.resolve("./json")],
    ["manifest.js", require.resolve("./manifest")],
    ["semver.js", require.resolve("./semver")],
    ["../core/stable.js", require.resolve("../core/stable")],
    ["../version.js", require.resolve("../version")],
  ] as const;
  return Object.freeze(entries.map(([locator, physical]) => {
    try {
      return Object.freeze({ locator, sha256: createHash("sha256").update(readFileSync(physical)).digest("hex") });
    } catch (error) {
      packageFail("CUT_EXTENSION_IDENTITY", "$runtime", `cannot authenticate shipped parent module ${JSON.stringify(locator)} (${systemCode(error)}).`);
    }
  }));
}

function parentOrchestrationIdentity() {
  const workerSha256 = sha256Text(extensionWorkerSource);
  const parentModules = shippedParentModuleIdentity();
  const parentOrchestrationSha256 = sha256Text(stableJsonStringify({
    hardCeilings: hardBudgets,
    parentModules,
    policies: {
      concurrency: "manifest-identity-current-process-quarantine-on-unconfirmed-termination",
      inputCopy: "hard-ceiling-before-copy-then-manifest-ceiling",
      termination: "timeout-or-protocol-failure-terminate-and-confirm",
      terminationConfirmationMs: cutExtensionTerminationConfirmationMs,
      timeout: "manifest-timeout-bounded-by-hard-ceiling",
    },
    profile: cutExtensionIsolationProfile,
    resourceLimits: extensionWorkerResourceLimits,
    workerSha256,
  }));
  const isolationIdentitySha256 = sha256Text(stableJsonStringify({
    cut: cutProductVersion,
    hardCeilings: hardBudgets,
    parentModules,
    parentOrchestrationSha256,
    profile: cutExtensionIsolationProfile,
    resourceLimits: extensionWorkerResourceLimits,
    terminationConfirmationMs: cutExtensionTerminationConfirmationMs,
    runtime: {
      architecture: process.arch,
      node: process.versions.node,
      nodeAbi: process.versions.modules,
      platform: process.platform,
      v8: process.versions.v8,
    },
    workerSha256,
  }));
  return Object.freeze({ isolationIdentitySha256, parentModules, parentOrchestrationSha256, workerSha256 });
}

function currentIsolationEvidence(): CutExtensionIsolationEvidence {
  const identity = parentOrchestrationIdentity();
  return Object.freeze({
    profile: cutExtensionIsolationProfile,
    executionBoundary: "dedicated-worker-thread",
    implementation: "wasm",
    admittedImports: Object.freeze(["cut.memory"] as const),
    grantedCapabilities: Object.freeze([] as const),
    ambientAccess: Object.freeze({
      filesystem: false,
      network: false,
      gpu: false,
      native: false,
      secrets: false,
      clock: false,
      randomness: false,
    }),
    timeout: "terminate-worker",
    memory: "host-owned-fixed-maximum",
    concurrencyScope: "current-node-process",
    runtime: Object.freeze({
      cut: cutProductVersion,
      node: process.versions.node,
      nodeAbi: process.versions.modules,
      v8: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      workerSha256: identity.workerSha256,
      parentOrchestrationSha256: identity.parentOrchestrationSha256,
      isolationIdentitySha256: identity.isolationIdentitySha256,
      workerResourceLimits: extensionWorkerResourceLimits,
      hardCeilings: hardBudgets,
      terminationConfirmationMs: cutExtensionTerminationConfirmationMs,
      parentModules: identity.parentModules,
    }),
  });
}

function workerMessage(value: unknown): WorkerSuccess | WorkerFailure {
  const message = record(value, "$worker");
  if (message.format !== "cut-extension-worker-result" || message.version !== 1 || (message.status !== "pass" && message.status !== "fail")) {
    packageFail("CUT_EXTENSION_WORKER_PROTOCOL", "$worker", "returned a malformed isolation response.");
  }
  if (message.status === "fail") {
    if (typeof message.code !== "string" || !/^CUT_EXTENSION_[A-Z0-9_]+$/u.test(message.code) || typeof message.message !== "string" || message.message.length > 512) {
      packageFail("CUT_EXTENSION_WORKER_PROTOCOL", "$worker", "returned a malformed failure response.");
    }
    return { format: "cut-extension-worker-result", version: 1, status: "fail", code: message.code, message: message.message };
  }
  if (!(message.output instanceof ArrayBuffer)) packageFail("CUT_EXTENSION_WORKER_PROTOCOL", "$worker.output", "must be an ArrayBuffer.");
  return { format: "cut-extension-worker-result", version: 1, status: "pass", output: message.output };
}

async function isolatedWorker(bundle: VerifiedExtensionBytes, mode: "execute" | "verify", input: Uint8Array) {
  try {
    const moduleBytes = Uint8Array.from(bundle.implementationBytes), inputBytes = Uint8Array.from(input);
    return await runCutExtensionWorker({
      identity: bundle.manifestIntegrity,
      maximumConcurrency: bundle.manifest.budgets.maximumConcurrency,
      timeoutMs: bundle.manifest.budgets.timeoutMs,
      terminationConfirmationMs: cutExtensionTerminationConfirmationMs,
      source: extensionWorkerSource,
      options: {
        eval: true,
        workerData: {
          mode,
          moduleBytes: moduleBytes.buffer,
          inputBytes: inputBytes.buffer,
          memoryPages: bundle.manifest.budgets.memoryPages,
          maximumOutputBytes: bundle.manifest.budgets.maximumOutputBytes,
        },
        resourceLimits: extensionWorkerResourceLimits,
        stdin: false,
        stdout: true,
        stderr: true,
      },
      decode: (message: unknown) => {
        const received = workerMessage(message);
        if (received.status === "fail") {
          return { status: "fail", code: received.code, message: received.message };
        }
        return { status: "pass", value: new Uint8Array(received.output) };
      },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("CUT_EXTENSION_")) {
      packageFail(error.code, "path" in error && typeof error.path === "string" ? error.path : "$worker", error.message.replace(/^CUT_EXTENSION_[A-Z0-9_]+:\s*/u, ""));
    }
    packageFail("CUT_EXTENSION_WORKER", "$worker", "could not establish the dedicated isolation worker.");
  }
}

export async function verifyCutExtension(directory: string): Promise<CutExtensionVerificationReport> {
  const bundle = await verifiedExtensionBytes(directory);
  await isolatedWorker(bundle, "verify", new Uint8Array());
  return Object.freeze({
    format: "cut-extension-verification",
    version: 1,
    status: "pass",
    extension: extensionIdentity(bundle),
    determinism: Object.freeze({ declared: "same-runtime-byte", executionReconciliationRuns: 2, performedDuringVerification: false }),
    isolation: currentIsolationEvidence(),
    budgets: bundle.manifest.budgets,
  });
}

export async function executeCutExtension(directory: string, input: Uint8Array): Promise<CutExtensionExecutionResult> {
  if (!(input instanceof Uint8Array)) packageFail("CUT_EXTENSION_INPUT", "$input", "must be a Uint8Array.");
  if (input.byteLength > hardBudgets.maximumInputBytes) {
    packageFail("CUT_EXTENSION_INPUT_LIMIT", "$input", `contains ${input.byteLength} bytes; hard ceiling is ${hardBudgets.maximumInputBytes}.`);
  }
  const immutableInput = Uint8Array.from(input);
  const bundle = await verifiedExtensionBytes(directory);
  if (immutableInput.byteLength > bundle.manifest.budgets.maximumInputBytes) {
    packageFail("CUT_EXTENSION_INPUT_LIMIT", "$input", `contains ${immutableInput.byteLength} bytes; declared limit is ${bundle.manifest.budgets.maximumInputBytes}.`);
  }
  const output = await isolatedWorker(bundle, "execute", immutableInput);
  const report: CutExtensionExecutionReport = Object.freeze({
    format: "cut-extension-execution",
    version: 1,
    status: "pass",
    extension: extensionIdentity(bundle),
    input: Object.freeze({ bytes: immutableInput.byteLength, sha256: createHash("sha256").update(immutableInput).digest("hex") }),
    output: Object.freeze({ bytes: output.byteLength, sha256: createHash("sha256").update(output).digest("hex") }),
    determinism: Object.freeze({ declared: "same-runtime-byte", reconciliationRuns: 2, byteIdentical: true }),
    isolation: currentIsolationEvidence(),
    budgets: bundle.manifest.budgets,
  });
  return Object.freeze({ bytes: Uint8Array.from(output), report });
}
