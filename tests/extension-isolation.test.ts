import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test, { after } from "node:test";
import Ajv from "ajv";
import { stableJsonStringify } from "../lib/core/stable";
import { CutPackageError } from "../lib/package/diagnostics";
import {
  defaultCutExtensionFileIo,
  readContainedExtensionFile,
  type CutExtensionFileIo,
} from "../lib/package/extension-file";
import {
  cutExtensionWorkerIdentityState,
  runCutExtensionWorker,
  type CutExtensionWorkerController,
  type CutExtensionWorkerLike,
} from "../lib/package/extension-worker";
import {
  cutExtensionAbi,
  executeCutExtension,
  loadCutExtensionManifest,
  validateCutExtensionManifest,
  verifyCutExtension,
  type CutExtensionHostCapability,
  type CutExtensionManifest,
} from "../lib/package/extension";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fixtureRoots = new Set<string>();

after(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { force: true, recursive: true })));
});

function u32(value: number) {
  const result: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    result.push(byte);
  } while (value);
  return result;
}

function vector(...items: number[][]) {
  return [...u32(items.length), ...items.flat()];
}

function ascii(value: string) {
  const bytes = [...Buffer.from(value, "utf8")];
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, contents: number[]) {
  return [id, ...u32(contents.length), ...contents];
}

function wasmFixture(options: {
  abi?: number;
  process?: "constant" | "loop" | "overflow";
  extraHostImport?: boolean;
  wrongProcessSignature?: boolean;
} = {}) {
  const extraHostImport = options.extraHostImport ?? false;
  const types = vector(
    [0x60, 0x00, 0x01, 0x7f],
    options.wrongProcessSignature
      ? [0x60, 0x00, 0x01, 0x7f]
      : [0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f],
  );
  const imports: number[][] = [
    [...ascii("cut"), ...ascii("memory"), 0x02, 0x01, ...u32(1), ...u32(256)],
  ];
  if (extraHostImport) imports.push([...ascii("env"), ...ascii("readFile"), 0x00, ...u32(0)]);
  const importedFunctions = extraHostImport ? 1 : 0;
  const functions = vector([...u32(0)], [...u32(1)]);
  const exports = vector(
    [...ascii("cut_abi_version"), 0x00, ...u32(importedFunctions)],
    [...ascii("cut_process"), 0x00, ...u32(importedFunctions + 1)],
  );
  const abiInstructions = [0x41, ...(options.abi === 2 ? [0x02] : [0x01]), 0x0b];
  const processInstructions = options.wrongProcessSignature
    ? [0x41, 0x00, 0x0b]
    : options.process === "loop"
    ? [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x41, 0x00, 0x0b]
    : options.process === "overflow"
      ? [0x20, 0x03, 0x41, 0x01, 0x6a, 0x0b]
      : [0x20, 0x02, 0x41, 0x2a, 0x3a, 0x00, 0x00, 0x41, 0x01, 0x0b];
  const body = (instructions: number[]) => [...u32(instructions.length + 1), 0x00, ...instructions];
  const code = vector(body(abiInstructions), body(processInstructions));
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...section(2, vector(...imports)),
    ...section(3, functions),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

function manifestFor(
  implementation: Uint8Array,
  overrides: {
    capabilities?: CutExtensionHostCapability[];
    determinism?: "nondeterministic" | "same-runtime-byte" | "seeded";
    implementationFormat?: "native" | "wasm";
    kind?: "analysis" | "audio-processor" | "byte-processor" | "generator" | "shader";
    entry?: string;
    timeoutMs?: number;
    maximumConcurrency?: number;
    maximumInputBytes?: number;
    maximumOutputBytes?: number;
    name?: string;
  } = {},
): CutExtensionManifest {
  return validateCutExtensionManifest({
    format: "cut-extension",
    manifestVersion: 1,
    abi: cutExtensionAbi,
    name: overrides.name ?? "@fixture/isolated",
    version: "1.2.3",
    kind: overrides.kind ?? "byte-processor",
    implementation: {
      format: overrides.implementationFormat ?? "wasm",
      entry: overrides.entry ?? "processor.wasm",
      sha256: sha256(implementation),
    },
    capabilities: overrides.capabilities ?? [],
    determinism: { tier: overrides.determinism ?? "same-runtime-byte" },
    budgets: {
      timeoutMs: overrides.timeoutMs ?? 500,
      memoryPages: 2,
      maximumModuleBytes: 64 * 1024,
      maximumInputBytes: overrides.maximumInputBytes ?? 1024,
      maximumOutputBytes: overrides.maximumOutputBytes ?? 1024,
      maximumConcurrency: overrides.maximumConcurrency ?? 1,
    },
  });
}

async function extensionFixture(
  implementation = wasmFixture(),
  overrides: Parameters<typeof manifestFor>[1] = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-extension-isolation-"));
  fixtureRoots.add(root);
  const manifest = manifestFor(implementation, overrides);
  if (manifest.implementation.entry === "processor.wasm") await writeFile(resolve(root, "processor.wasm"), implementation);
  await writeFile(resolve(root, "cut.extension.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest, implementation };
}

function cutCode(error: unknown) {
  return error instanceof CutPackageError ? error.code : undefined;
}

function anyCutCode(error: unknown) {
  if (error instanceof CutPackageError) return error.code;
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function workerDiagnostic(error: unknown, code: string, path: string, message: string) {
  return error instanceof Error
    && "code" in error && error.code === code
    && "path" in error && error.path === path
    && error.message === message;
}

async function localCompiledRequireClosure(entry: string) {
  const pending = [entry], observed = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (observed.has(current)) continue;
    observed.add(current);
    const source = await readFile(current, "utf8");
    for (const match of source.matchAll(/require\("(\.{1,2}\/[^"]+)"\)/gu)) {
      const locator = match[1].endsWith(".js") ? match[1] : `${match[1]}.js`;
      pending.push(resolve(dirname(current), locator));
    }
  }
  return [...observed].sort();
}

test("closed extension manifest and shipped schema expose the explicit host-capability vocabulary", async () => {
  const implementation = wasmFixture(), manifest = manifestFor(implementation);
  assert.equal(loadCutExtensionManifest(`${JSON.stringify(manifest)}\n`).abi, "cut-extension-wasm-byte-v1");
  assert.throws(
    () => validateCutExtensionManifest({ ...manifest, extra: true }),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_UNKNOWN_FIELD",
  );
  assert.throws(
    () => validateCutExtensionManifest({ ...manifest, capabilities: ["network"] }),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_CAPABILITY",
  );
  assert.throws(
    () => validateCutExtensionManifest({ ...manifest, capabilities: ["network:https", "network:https"] }),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_CAPABILITY",
  );
  assert.throws(
    () => validateCutExtensionManifest({ ...manifest, abi: "cut-extension-abi-v2" }),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_ABI",
  );
  const schema = JSON.parse(await readFile(resolve("schemas/cut-extension-v1.schema.json"), "utf8")) as {
    $id: string;
    properties: { capabilities: { items: { enum: string[] } } };
  };
  assert.equal(schema.$id, "urn:cut:schema:extension-manifest:1");
  assert.deepEqual(schema.properties.capabilities.items.enum, [
    "filesystem:read-assets",
    "filesystem:write-output",
    "gpu:compute",
    "native:host",
    "network:https",
    "secret:read",
  ]);
});

test("shipped extension schema and runtime rules share a closed parity corpus", async () => {
  const implementation = wasmFixture();
  const canonical = JSON.parse(JSON.stringify(manifestFor(implementation))) as Record<string, unknown>;
  const packageSchema = JSON.parse(await readFile(resolve("schemas/cut-package-v1.schema.json"), "utf8")) as Record<string, unknown>;
  const extensionSchema = JSON.parse(await readFile(resolve("schemas/cut-extension-v1.schema.json"), "utf8")) as Record<string, unknown>;
  const ajv = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true });
  ajv.addSchema(packageSchema);
  const schemaAccepts = ajv.compile(extensionSchema);
  const runtimeAccepts = (value: unknown) => {
    try {
      validateCutExtensionManifest(value);
      return true;
    } catch {
      return false;
    }
  };
  const copy = () => JSON.parse(JSON.stringify(canonical)) as Record<string, any>;
  const corpus: Array<Readonly<{ id: string; value: unknown; accepted: boolean }>> = [
    { id: "canonical", value: copy(), accepted: true },
    { id: "unknown-field", value: { ...copy(), unknown: true }, accepted: false },
    { id: "reserved-name", value: { ...copy(), name: "__proto__" }, accepted: false },
    { id: "reserved-cut-scope", value: { ...copy(), name: "@cut/unsafe" }, accepted: false },
    { id: "unsafe-dot-entry", value: { ...copy(), implementation: { ...copy().implementation, entry: "./processor.wasm" } }, accepted: false },
    { id: "unsafe-parent-entry", value: { ...copy(), implementation: { ...copy().implementation, entry: "../processor.wasm" } }, accepted: false },
    { id: "unsafe-key-entry", value: { ...copy(), implementation: { ...copy().implementation, entry: "__proto__/processor.wasm" } }, accepted: false },
    { id: "windows-drive-entry", value: { ...copy(), implementation: { ...copy().implementation, entry: "C:/processor.wasm" } }, accepted: false },
    { id: "backslash-entry", value: { ...copy(), implementation: { ...copy().implementation, entry: "dir\\processor.wasm" } }, accepted: false },
    { id: "duplicate-capability", value: { ...copy(), capabilities: ["network:https", "network:https"] }, accepted: false },
    { id: "unknown-kind", value: { ...copy(), kind: "renderer" }, accepted: false },
    { id: "unknown-determinism", value: { ...copy(), determinism: { tier: "machine-exact" } }, accepted: false },
    { id: "hard-timeout", value: { ...copy(), budgets: { ...copy().budgets, timeoutMs: 5001 } }, accepted: false },
  ];
  for (const fixture of corpus) {
    assert.equal(Boolean(schemaAccepts(fixture.value)), fixture.accepted, `${fixture.id}: schema`);
    assert.equal(runtimeAccepts(fixture.value), fixture.accepted, `${fixture.id}: runtime`);
  }

  const semanticProfile = (extensionSchema["x-cut-semanticValidation"] as {
    validator: string;
    rules: Array<{ id: string; expression: string; diagnostic: string; path: string }>;
  });
  assert.equal(semanticProfile.validator, "validateCutExtensionManifest");
  assert.deepEqual(semanticProfile.rules, [{
    id: "CUT_EXTENSION_MEMORY_FIT",
    expression: "maximumInputBytes + maximumOutputBytes + 15 <= memoryPages * 65536",
    diagnostic: "CUT_EXTENSION_BUDGET",
    path: "$.budgets",
  }]);
  const memoryMismatch = {
    ...copy(),
    budgets: { ...copy().budgets, memoryPages: 1, maximumInputBytes: 40_000, maximumOutputBytes: 40_000 },
  };
  assert.equal(Boolean(schemaAccepts(memoryMismatch)), true, "JSON Schema owns structure and explicitly delegates the cross-field equation");
  assert.equal(runtimeAccepts(memoryMismatch), false, "the declared semantic validator enforces the cross-field equation");
});

test("authenticated extension file I/O maps injected stat, read, race, and close failures to stable diagnostics", async () => {
  const fixture = await extensionFixture();
  const root = await defaultCutExtensionFileIo.realpath(fixture.root);
  const injected = (phase: "before-stat" | "read" | "after-stat" | "post-lstat" | "close"): CutExtensionFileIo => {
    let locatorLstatCalls = 0;
    return {
      ...defaultCutExtensionFileIo,
      lstat: async (path) => {
        if (path.endsWith("processor.wasm")) {
          locatorLstatCalls += 1;
          if (phase === "post-lstat" && locatorLstatCalls === 2) {
            throw Object.assign(new Error("injected post-read lstat failure"), { code: "ESTALE" });
          }
        }
        return defaultCutExtensionFileIo.lstat(path);
      },
      open: async (path, flags) => {
        const handle = await defaultCutExtensionFileIo.open(path, flags);
        let statCalls = 0;
        return {
          stat: async () => {
            statCalls += 1;
            if (phase === "before-stat" && statCalls === 1) {
              throw Object.assign(new Error("injected initial stat failure"), { code: "EIO" });
            }
            if (phase === "after-stat" && statCalls === 2) {
              throw Object.assign(new Error("injected post-read stat failure"), { code: "ESTALE" });
            }
            return handle.stat();
          },
          read: async (buffer, offset, length, position) => {
            if (phase === "read") throw Object.assign(new Error("injected read failure"), { code: "EIO" });
            return handle.read(buffer, offset, length, position);
          },
          close: async () => {
            await handle.close();
            if (phase === "close") throw Object.assign(new Error("injected close failure"), { code: "EIO" });
          },
        };
      },
    };
  };
  for (const [phase, expected] of [
    ["before-stat", "CUT_EXTENSION_FILE"],
    ["read", "CUT_EXTENSION_READ"],
    ["after-stat", "CUT_EXTENSION_RACE"],
    ["post-lstat", "CUT_EXTENSION_RACE"],
    ["close", "CUT_EXTENSION_CLOSE"],
  ] as const) {
    await assert.rejects(
      readContainedExtensionFile(root, "processor.wasm", 64 * 1024, "$.implementation.entry", injected(phase)),
      (error: unknown) => cutCode(error) === expected,
      phase,
    );
  }
});

test("zero-host WASM executes twice in fresh fixed memory with exact bytes and no caller mutation", async () => {
  const fixture = await extensionFixture(), input = new Uint8Array([9, 8, 7]), before = Uint8Array.from(input);
  const verified = await verifyCutExtension(fixture.root);
  assert.equal(verified.isolation.profile, "cut-worker-wasm-zero-host-v1");
  assert.equal(verified.isolation.executionBoundary, "dedicated-worker-thread");
  assert.equal(verified.isolation.concurrencyScope, "current-node-process");
  assert.deepEqual(verified.isolation.admittedImports, ["cut.memory"]);
  assert.deepEqual(verified.isolation.grantedCapabilities, []);
  assert.match(verified.isolation.runtime.workerSha256, /^[a-f0-9]{64}$/u);
  assert.match(verified.isolation.runtime.parentOrchestrationSha256, /^[a-f0-9]{64}$/u);
  assert.match(verified.isolation.runtime.isolationIdentitySha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(verified.isolation.runtime.parentOrchestrationSha256, verified.isolation.runtime.workerSha256);
  assert.deepEqual(verified.isolation.runtime.workerResourceLimits, {
    maxOldGenerationSizeMb: 64,
    maxYoungGenerationSizeMb: 8,
    stackSizeMb: 2,
  });
  assert.deepEqual(verified.isolation.runtime.hardCeilings, {
    timeoutMs: 5000,
    memoryPages: 256,
    maximumModuleBytes: 8 * 1024 * 1024,
    maximumInputBytes: 16 * 1024 * 1024,
    maximumOutputBytes: 16 * 1024 * 1024,
    maximumConcurrency: 4,
  });
  assert.equal(verified.isolation.runtime.terminationConfirmationMs, 250);
  assert.deepEqual(verified.isolation.runtime.parentModules.map((item) => item.locator), [
    "extension.js",
    "extension-file.js",
    "extension-worker.js",
    "diagnostics.js",
    "json.js",
    "manifest.js",
    "semver.js",
    "../core/stable.js",
    "../version.js",
  ]);
  const compiledPackageRoot = resolve(__dirname, "../lib/package");
  for (const item of verified.isolation.runtime.parentModules) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      item.sha256,
      sha256(await readFile(resolve(compiledPackageRoot, item.locator))),
      `reported parent closure must authenticate shipped bytes for ${item.locator}`,
    );
  }
  assert.deepEqual(
    await localCompiledRequireClosure(resolve(compiledPackageRoot, "extension.js")),
    verified.isolation.runtime.parentModules.map((item) => resolve(compiledPackageRoot, item.locator)).sort(),
    "reported parent modules must equal the complete shipped local require closure",
  );
  assert.equal(
    verified.isolation.runtime.parentOrchestrationSha256,
    sha256(stableJsonStringify({
      hardCeilings: verified.isolation.runtime.hardCeilings,
      parentModules: verified.isolation.runtime.parentModules,
      policies: {
        concurrency: "manifest-identity-current-process-quarantine-on-unconfirmed-termination",
        inputCopy: "hard-ceiling-before-copy-then-manifest-ceiling",
        termination: "timeout-or-protocol-failure-terminate-and-confirm",
        terminationConfirmationMs: verified.isolation.runtime.terminationConfirmationMs,
        timeout: "manifest-timeout-bounded-by-hard-ceiling",
      },
      profile: verified.isolation.profile,
      resourceLimits: verified.isolation.runtime.workerResourceLimits,
      workerSha256: verified.isolation.runtime.workerSha256,
    })),
    "parent orchestration digest must bind the authenticated module closure and every declared hard policy",
  );
  assert.equal(verified.isolation.runtime.node, process.versions.node);
  assert.equal(verified.isolation.runtime.v8, process.versions.v8);
  assert.equal(verified.determinism.executionReconciliationRuns, 2);
  assert.equal(verified.determinism.performedDuringVerification, false);
  assert.doesNotMatch(stableJsonStringify(verified), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));

  const first = await executeCutExtension(fixture.root, input), second = await executeCutExtension(fixture.root, input);
  assert.deepEqual(first.bytes, new Uint8Array([42]));
  assert.deepEqual(second.bytes, first.bytes);
  assert.deepEqual(input, before);
  assert.equal(first.report.determinism.byteIdentical, true);
  assert.equal(first.report.determinism.reconciliationRuns, 2);
  assert.equal(first.report.output.sha256, sha256(new Uint8Array([42])));
  assert.equal(first.report.extension.implementationIntegrity, `sha256-${sha256(fixture.implementation)}`);
  assert.equal(stableJsonStringify(first.report), stableJsonStringify(second.report));
  assert.equal(first.report.isolation.runtime.isolationIdentitySha256, verified.isolation.runtime.isolationIdentitySha256);

  const mutable = new Uint8Array([1, 2, 3]), expectedInputHash = sha256(mutable);
  const pending = executeCutExtension(fixture.root, mutable);
  mutable.fill(255);
  assert.equal((await pending).report.input.sha256, expectedInputHash, "execution binds call-time input bytes");
});

test("every declared host capability and native format fail before implementation-file I/O", async () => {
  const implementation = wasmFixture();
  for (const capability of [
    "filesystem:read-assets",
    "filesystem:write-output",
    "gpu:compute",
    "native:host",
    "network:https",
    "secret:read",
  ] as const) {
    const fixture = await extensionFixture(implementation, { capabilities: [capability], entry: "missing.wasm" });
    await assert.rejects(
      verifyCutExtension(fixture.root),
      (error: unknown) => cutCode(error) === "CUT_EXTENSION_CAPABILITY_DENIED",
      capability,
    );
  }
  const native = await extensionFixture(implementation, { implementationFormat: "native", entry: "missing.node" });
  await assert.rejects(
    verifyCutExtension(native.root),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_IMPLEMENTATION_DENIED",
  );
  const audio = await extensionFixture(implementation, { kind: "audio-processor", entry: "missing.wasm" });
  await assert.rejects(
    verifyCutExtension(audio.root),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_KIND_DENIED",
  );
});

test("undeclared host imports, wrong ABI handshakes, non-exact tiers, and digest tampering fail closed", async () => {
  const hostImport = await extensionFixture(wasmFixture({ extraHostImport: true }));
  await assert.rejects(
    executeCutExtension(hostImport.root, new Uint8Array()),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_IMPORT_DENIED",
  );
  const wrongAbi = await extensionFixture(wasmFixture({ abi: 2 }));
  await assert.rejects(
    verifyCutExtension(wrongAbi.root),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_ABI_EXECUTION",
  );
  const wrongSignature = await extensionFixture(wasmFixture({ wrongProcessSignature: true }));
  await assert.rejects(
    verifyCutExtension(wrongSignature.root),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_ABI_SIGNATURE",
  );
  const seeded = await extensionFixture(wasmFixture(), { determinism: "seeded", entry: "missing.wasm" });
  await assert.rejects(
    verifyCutExtension(seeded.root),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_DETERMINISM_DENIED",
  );
  const tampered = await extensionFixture();
  await writeFile(resolve(tampered.root, "processor.wasm"), wasmFixture({ abi: 2 }));
  await assert.rejects(
    verifyCutExtension(tampered.root),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_INTEGRITY",
  );
});

test("entry containment and no-follow resolution reject traversal and symlink implementations", async (context) => {
  assert.throws(
    () => manifestFor(wasmFixture(), { entry: "../escape.wasm" }),
    (error: unknown) => cutCode(error) === "CUT_PACKAGE_PATH",
  );
  const root = await mkdtemp(resolve(tmpdir(), "cut-extension-symlink-")), target = resolve(root, "target.wasm");
  fixtureRoots.add(root);
  const implementation = wasmFixture();
  await writeFile(target, implementation);
  try { await symlink(target, resolve(root, "processor.wasm")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("symlinks are unavailable");
      return;
    }
    throw error;
  }
  await writeFile(resolve(root, "cut.extension.json"), `${JSON.stringify(manifestFor(implementation), null, 2)}\n`);
  await assert.rejects(
    verifyCutExtension(root),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_SYMLINK",
  );

  const mixed = await extensionFixture();
  await writeFile(resolve(mixed.root, "cut.package.json"), "{}\n");
  await assert.rejects(
    verifyCutExtension(mixed.root),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_FORMAT_CONFLICT",
  );
});

test("input, output, memory, and manifest hard ceilings refuse work before publication", async () => {
  const implementation = wasmFixture();
  assert.throws(
    () => validateCutExtensionManifest({
      ...manifestFor(implementation),
      budgets: {
        ...manifestFor(implementation).budgets,
        memoryPages: 1,
        maximumInputBytes: 40_000,
        maximumOutputBytes: 40_000,
      },
    }),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_BUDGET",
  );
  const inputLimited = await extensionFixture(implementation, { maximumInputBytes: 2 });
  await assert.rejects(
    executeCutExtension(inputLimited.root, new Uint8Array([1, 2, 3])),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_INPUT_LIMIT",
  );
  const outputLimited = await extensionFixture(wasmFixture({ process: "overflow" }), { maximumOutputBytes: 4 });
  await assert.rejects(
    executeCutExtension(outputLimited.root, new Uint8Array()),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_OUTPUT_LIMIT",
  );
});

test("timeout termination releases the concurrency quota and never poisons a retry", async () => {
  const fixture = await extensionFixture(wasmFixture({ process: "loop" }), { timeoutMs: 500, maximumConcurrency: 1 });
  const first = executeCutExtension(fixture.root, new Uint8Array());
  const second = executeCutExtension(fixture.root, new Uint8Array());
  const results = await Promise.allSettled([first, second]);
  const codes = results.map((result) => result.status === "rejected" ? cutCode(result.reason) : "pass").sort();
  assert.deepEqual(codes, ["CUT_EXTENSION_CONCURRENCY_LIMIT", "CUT_EXTENSION_TIMEOUT"]);
  await assert.rejects(
    executeCutExtension(fixture.root, new Uint8Array()),
    (error: unknown) => cutCode(error) === "CUT_EXTENSION_TIMEOUT",
    "a timed-out worker must release, not poison, the exact extension identity",
  );
});

test("rejected and pending termination confirmations quarantine exact identities without leaking active quota", async () => {
  const terminationMessage = "CUT could not confirm extension worker termination; this extension identity is quarantined in the current process.";
  const quarantineMessage = "CUT cannot execute an extension identity whose worker termination was not confirmed in the current process.";
  const idleWorker = () => new EventEmitter() as EventEmitter & CutExtensionWorkerLike;
  const request = (identity: string, timeoutMs = 5) => ({
    identity,
    maximumConcurrency: 3,
    timeoutMs,
    terminationConfirmationMs: 15,
    source: "\"use strict\";",
    options: { eval: true },
    decode: () => ({ status: "pass" as const, value: "ok" }),
  });
  let invalidControllerCreates = 0;
  await assert.rejects(
    runCutExtensionWorker(
      { ...request("sha256-invalid-deadline"), terminationConfirmationMs: 251 },
      {
        create: () => {
          invalidControllerCreates += 1;
          return idleWorker();
        },
        terminate: async () => 0,
      },
    ),
    (error: unknown) => workerDiagnostic(
      error,
      "CUT_EXTENSION_WORKER_CONFIGURATION",
      "$worker.terminationConfirmationMs",
      "termination confirmation must be an integer from 1 through the hard ceiling 250ms.",
    ),
  );
  assert.equal(invalidControllerCreates, 0, "an invalid deadline must fail before worker or quota admission");
  assert.deepEqual(cutExtensionWorkerIdentityState("sha256-invalid-deadline"), { active: 0, quarantined: false });

  const rejectedController: CutExtensionWorkerController = {
    create: idleWorker,
    terminate: async () => Promise.reject(Object.assign(new Error("injected termination rejection"), { code: "EIO" })),
  };
  await assert.rejects(
    runCutExtensionWorker(request("sha256-rejected"), rejectedController),
    (error: unknown) => workerDiagnostic(error, "CUT_EXTENSION_WORKER_TERMINATION", "$worker", terminationMessage),
  );
  assert.deepEqual(cutExtensionWorkerIdentityState("sha256-rejected"), { active: 0, quarantined: true });
  await assert.rejects(
    runCutExtensionWorker(request("sha256-rejected"), rejectedController),
    (error: unknown) => workerDiagnostic(error, "CUT_EXTENSION_WORKER_QUARANTINED", "$worker", quarantineMessage),
    "quarantine must refuse the exact identity even when maximumConcurrency is greater than one",
  );

  const pendingController: CutExtensionWorkerController = {
    create: idleWorker,
    terminate: () => new Promise<number>(() => {}),
  };
  await assert.rejects(
    Promise.race([
      runCutExtensionWorker(request("sha256-pending"), pendingController),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(Object.assign(new Error("pending terminate was not bounded"), { code: "TEST_TERMINATION_DEADLINE" })),
        250,
      )),
    ]),
    (error: unknown) => workerDiagnostic(error, "CUT_EXTENSION_WORKER_TERMINATION", "$worker", terminationMessage),
    "a never-settling controller termination promise must hit the bounded confirmation deadline",
  );
  assert.deepEqual(cutExtensionWorkerIdentityState("sha256-pending"), { active: 0, quarantined: true });
  await assert.rejects(
    runCutExtensionWorker(request("sha256-pending"), pendingController),
    (error: unknown) => workerDiagnostic(error, "CUT_EXTENSION_WORKER_QUARANTINED", "$worker", quarantineMessage),
  );

  const successfulController: CutExtensionWorkerController = {
    create: () => {
      const worker = idleWorker();
      queueMicrotask(() => {
        worker.emit("message", { status: "ok" });
        worker.emit("exit", 0);
      });
      return worker;
    },
    terminate: async () => 0,
  };
  assert.equal(await runCutExtensionWorker(request("sha256-unrelated"), successfulController), "ok");
  assert.deepEqual(cutExtensionWorkerIdentityState("sha256-unrelated"), { active: 0, quarantined: false });
});

test("unconfirmed termination quarantines new admissions while an already admitted sibling releases normally", async () => {
  const identity = "sha256-overlap";
  const workers: Array<EventEmitter & CutExtensionWorkerLike> = [];
  const controller: CutExtensionWorkerController = {
    create: () => {
      const worker = new EventEmitter() as EventEmitter & CutExtensionWorkerLike;
      workers.push(worker);
      return worker;
    },
    terminate: (worker) => worker === workers[0] ? new Promise<number>(() => {}) : Promise.resolve(0),
  };
  const request = (timeoutMs: number) => ({
    identity,
    maximumConcurrency: 3,
    timeoutMs,
    terminationConfirmationMs: 15,
    source: "\"use strict\";",
    options: { eval: true },
    decode: () => ({ status: "pass" as const, value: "sibling-ok" }),
  });
  const unconfirmed = runCutExtensionWorker(request(5), controller);
  const admittedSibling = runCutExtensionWorker(request(500), controller);
  assert.deepEqual(cutExtensionWorkerIdentityState(identity), { active: 2, quarantined: false });
  await assert.rejects(
    unconfirmed,
    (error: unknown) => workerDiagnostic(
      error,
      "CUT_EXTENSION_WORKER_TERMINATION",
      "$worker",
      "CUT could not confirm extension worker termination; this extension identity is quarantined in the current process.",
    ),
  );
  assert.deepEqual(cutExtensionWorkerIdentityState(identity), { active: 1, quarantined: true });
  await assert.rejects(
    runCutExtensionWorker(request(500), controller),
    (error: unknown) => anyCutCode(error) === "CUT_EXTENSION_WORKER_QUARANTINED",
    "quarantine must block new work even though declared concurrency has spare capacity",
  );
  workers[1].emit("message", { status: "ok" });
  workers[1].emit("exit", 0);
  assert.equal(await admittedSibling, "sibling-ok");
  assert.deepEqual(cutExtensionWorkerIdentityState(identity), { active: 0, quarantined: true });
});
