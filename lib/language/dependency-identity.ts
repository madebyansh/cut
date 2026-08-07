import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { hash } from "../core/stable";

export const referenceDependencyNames = [
  "d3-geo",
  "opentype.js",
  "sharp",
  "topojson-client",
  "world-atlas",
] as const;
export const referenceComplexTextDependencyNames = [
  "bidi-js",
  "harfbuzzjs",
] as const;
const requireFromHere = createRequire(__filename);

export type ReferenceDependencyName = typeof referenceDependencyNames[number];
export type ReferenceComplexTextDependencyName = typeof referenceComplexTextDependencyNames[number];
type ReferenceTrackedDependencyName = ReferenceDependencyName | ReferenceComplexTextDependencyName;
export type ReferenceDependencyIdentity = Readonly<{
  format: "cut-reference-dependencies";
  version: 1;
  packages: ReadonlyArray<Readonly<{ name: ReferenceDependencyName; version: string }>>;
  integrity: string;
}>;

const packageJsonByteLimit = 1024 * 1024;
const dependencyImplementationByteLimit = 8 * 1024 * 1024;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;

export type ReferenceComplexTextDependencyByteIdentity = Readonly<{
  format: "cut-reference-complex-text-dependency-bytes";
  version: 1;
  harfbuzzjs: Readonly<{
    manifestSha256: string;
    entrySha256: string;
    glueSha256: string;
    wasmSha256: string;
  }>;
  bidiJs: Readonly<{
    manifestSha256: string;
    implementationSha256: string;
  }>;
  integrity: string;
}>;

export type ReferenceComplexTextBackendIdentity = Readonly<{
  format: "cut-reference-complex-text-backend";
  version: 1;
  harfbuzzjs: Readonly<{
    packageVersion: "1.4.0";
    manifestSha256: string;
    entrySha256: string;
    glueSha256: string;
    wasmSha256: string;
  }>;
  harfbuzz: Readonly<{
    runtimeVersion: "14.2.1";
    clusterLevel: "MONOTONE_GRAPHEMES";
  }>;
  bidiJs: Readonly<{
    packageVersion: "1.0.3";
    unicodeVersion: "13.0.0";
    manifestSha256: string;
    implementationSha256: string;
  }>;
  policies: Readonly<{
    fallback: "first-whole-token-capable-locked-face-v1";
    wrap: "explicit-lf-or-ascii-space-whole-token-v1";
    selector: "harfbuzz-cluster-atomic-logical-or-visual-v1";
    normalization: "none";
    hostFontFallback: false;
  }>;
  integrity: string;
}>;

export const referenceComplexTextBackendContract = Object.freeze({
  format: "cut-reference-complex-text-backend-contract",
  version: 1,
  harfbuzzjsPackageVersion: "1.4.0",
  harfbuzzRuntimeVersion: "14.2.1",
  bidiJsPackageVersion: "1.0.3",
  bidiUnicodeVersion: "13.0.0",
  clusterLevel: "MONOTONE_GRAPHEMES",
  fallbackPolicy: "first-whole-token-capable-locked-face-v1",
  wrapPolicy: "explicit-lf-or-ascii-space-whole-token-v1",
  selectorPolicy: "harfbuzz-cluster-atomic-logical-or-visual-v1",
  normalizationPolicy: "none",
  hostFontFallback: false,
  backendBytes: Object.freeze({
    harfbuzzManifestSha256:
      "33cb095c48f71baba2639303ea929a504cd30b2f239e71e6766a350a966480ed",
    harfbuzzEntrySha256:
      "5d757236e5de85575525428d37e2cb81fb349b5bea82bbbe5a9bf2e13d32dbc2",
    harfbuzzGlueSha256:
      "d64d3aecca9424ee0d0ad2f98354f795e93b0dc512f14f6819e45b96ac521524",
    harfbuzzWasmSha256:
      "64c8f422b7d31120ab010da3bba7cc248bf721dcd8be331a5b17971b7897f4b9",
    bidiManifestSha256:
      "c2579f7705ab96dcc6192ab5a317d87760d2be7c67d72976d85edb4181bec5de",
    bidiImplementationSha256:
      "5b58433ed951be70376bee55cb9a98cdce788e00cd2fa5f881cbcb1dcad03102",
  }),
} as const);

function boundedVersion(value: unknown, name: string) {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new Error(`CUT cannot identify installed dependency ${name}: package version is missing or invalid.`);
  }
  return value;
}

function freezeIdentity(packages: Array<{ name: ReferenceDependencyName; version: string }>): ReferenceDependencyIdentity {
  const canonicalPackages = packages.map((entry) => Object.freeze({ ...entry }));
  const content = { format: "cut-reference-dependencies" as const, version: 1 as const, packages: canonicalPackages };
  return Object.freeze({ ...content, packages: Object.freeze(canonicalPackages), integrity: hash(content) });
}

/** Build the canonical dependency identity from an exact, closed version map. */
export function createReferenceDependencyIdentity(versions: Readonly<Record<ReferenceDependencyName, string>>) {
  const keys = Object.keys(versions).sort();
  const expected = [...referenceDependencyNames].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`CUT reference dependency identity must contain exactly: ${expected.join(", ")}.`);
  }
  return freezeIdentity(expected.map((name) => ({ name, version: boundedVersion(versions[name], name) })));
}

function readPackageVersion(path: string, expectedName: ReferenceDependencyName) {
  const descriptor = openSync(path, "r");
  let bytes: Buffer;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > packageJsonByteLimit) {
      throw new Error(`CUT cannot identify installed dependency ${expectedName}: package.json is not a bounded regular file.`);
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (bytes.byteLength !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`CUT cannot identify installed dependency ${expectedName}: package.json changed while it was read.`);
    }
  } finally { closeSync(descriptor); }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`CUT cannot identify installed dependency ${expectedName}: package.json is invalid JSON.`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`CUT cannot identify installed dependency ${expectedName}: package.json must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (record.name !== expectedName) throw new Error(`CUT resolved ${expectedName} to a package named ${String(record.name)}.`);
  return boundedVersion(record.version, expectedName);
}

function packageJsonFor(requireFromHere: NodeRequire, name: ReferenceTrackedDependencyName) {
  try { return requireFromHere.resolve(`${name}/package.json`); }
  catch {
    let directory: string;
    try { directory = dirname(requireFromHere.resolve(name)); }
    catch { throw new Error(`CUT reference dependency ${name} is not installed.`); }
    const root = parse(directory).root;
    for (let depth = 0; depth < 16 && directory !== root; depth += 1) {
      const candidate = resolve(directory, "package.json");
      if (existsSync(candidate)) {
        try {
          const metadata = statSync(candidate);
          if (!metadata.isFile() || metadata.size <= 0 || metadata.size > packageJsonByteLimit) throw new Error("unbounded package metadata");
          const value = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown };
          if (value?.name === name) return candidate;
        } catch { /* The bounded reader below reports the selected package; keep walking. */ }
      }
      directory = dirname(directory);
    }
    throw new Error(`CUT cannot locate package.json for installed dependency ${name}.`);
  }
}

function inside(root: string, path: string) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function stableDependencyFile(path: string, root: string, label: string) {
  const lexical = resolve(path);
  let canonical: string;
  try { canonical = realpathSync(lexical); }
  catch { throw new Error(`CUT cannot identify ${label}: file is missing or unreadable.`); }
  if (!inside(root, canonical) || canonical !== lexical) {
    throw new Error(`CUT cannot identify ${label}: file must be a regular non-symlinked member of its installed package.`);
  }
  const descriptor = openSync(canonical, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > dependencyImplementationByteLimit) {
      throw new Error(`CUT cannot identify ${label}: file must be a bounded regular file.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (bytes.byteLength !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`CUT cannot identify ${label}: file changed while its bytes were read.`);
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally { closeSync(descriptor); }
}

function trackedPackageJson(name: ReferenceTrackedDependencyName) {
  return packageJsonFor(requireFromHere, name);
}

/**
 * Bind the exact executable JavaScript/WASM bytes behind the complex-text
 * backend. Keeping the one bounded module resolver in this dependency authority
 * prevents runtime modules from constructing untracked loaders of their own.
 */
export function collectInstalledComplexTextDependencyByteIdentity(): ReferenceComplexTextDependencyByteIdentity {
  const harfbuzzManifestPath = realpathSync(trackedPackageJson("harfbuzzjs"));
  const bidiManifestPath = realpathSync(trackedPackageJson("bidi-js"));
  const harfbuzzRoot = dirname(harfbuzzManifestPath);
  const bidiRoot = dirname(bidiManifestPath);
  const content = {
    format: "cut-reference-complex-text-dependency-bytes" as const,
    version: 1 as const,
    harfbuzzjs: Object.freeze({
      manifestSha256: stableDependencyFile(harfbuzzManifestPath, harfbuzzRoot, "harfbuzzjs package manifest"),
      entrySha256: stableDependencyFile(resolve(harfbuzzRoot, "dist", "index.mjs"), harfbuzzRoot, "harfbuzzjs module entry"),
      glueSha256: stableDependencyFile(resolve(harfbuzzRoot, "dist", "harfbuzz.js"), harfbuzzRoot, "harfbuzzjs Emscripten glue"),
      wasmSha256: stableDependencyFile(resolve(harfbuzzRoot, "dist", "harfbuzz.wasm"), harfbuzzRoot, "harfbuzzjs WASM"),
    }),
    bidiJs: Object.freeze({
      manifestSha256: stableDependencyFile(bidiManifestPath, bidiRoot, "bidi-js package manifest"),
      implementationSha256: stableDependencyFile(resolve(bidiRoot, "dist", "bidi.js"), bidiRoot, "bidi-js implementation"),
    }),
  };
  return Object.freeze({ ...content, integrity: hash(content) });
}

/**
 * Create the feature-scoped complex-text authority. This is intentionally
 * separate from the five-package reference compositor identity so programs
 * that omit shaped FlowText retain their historical backend tuple.
 */
export function collectInstalledComplexTextBackendIdentity(): ReferenceComplexTextBackendIdentity {
  const bytes = collectInstalledComplexTextDependencyByteIdentity();
  const expected = referenceComplexTextBackendContract.backendBytes;
  const actual = {
    harfbuzzManifestSha256: bytes.harfbuzzjs.manifestSha256,
    harfbuzzEntrySha256: bytes.harfbuzzjs.entrySha256,
    harfbuzzGlueSha256: bytes.harfbuzzjs.glueSha256,
    harfbuzzWasmSha256: bytes.harfbuzzjs.wasmSha256,
    bidiManifestSha256: bytes.bidiJs.manifestSha256,
    bidiImplementationSha256: bytes.bidiJs.implementationSha256,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (actual[key] !== expected[key]) {
      throw new Error(`CUT cannot identify the complex-text backend: ${key} ${actual[key]} differs from pinned ${expected[key]}.`);
    }
  }
  const content = {
    format: "cut-reference-complex-text-backend" as const,
    version: 1 as const,
    harfbuzzjs: Object.freeze({
      packageVersion: "1.4.0" as const,
      manifestSha256: actual.harfbuzzManifestSha256,
      entrySha256: actual.harfbuzzEntrySha256,
      glueSha256: actual.harfbuzzGlueSha256,
      wasmSha256: actual.harfbuzzWasmSha256,
    }),
    harfbuzz: Object.freeze({
      runtimeVersion: "14.2.1" as const,
      clusterLevel: "MONOTONE_GRAPHEMES" as const,
    }),
    bidiJs: Object.freeze({
      packageVersion: "1.0.3" as const,
      unicodeVersion: "13.0.0" as const,
      manifestSha256: actual.bidiManifestSha256,
      implementationSha256: actual.bidiImplementationSha256,
    }),
    policies: Object.freeze({
      fallback: referenceComplexTextBackendContract.fallbackPolicy,
      wrap: referenceComplexTextBackendContract.wrapPolicy,
      selector: referenceComplexTextBackendContract.selectorPolicy,
      normalization: referenceComplexTextBackendContract.normalizationPolicy,
      hostFontFallback: referenceComplexTextBackendContract.hostFontFallback,
    }),
  };
  return Object.freeze({ ...content, integrity: hash(content) });
}

/**
 * Resolve the versions that this installation will execute. This module never
 * imports Sharp or any other native backend, so compiler-only callers remain
 * free of native module initialization.
 */
export function collectInstalledReferenceDependencyIdentity() {
  return createReferenceDependencyIdentity(Object.fromEntries(referenceDependencyNames.map((name) => [
    name,
    readPackageVersion(packageJsonFor(requireFromHere, name), name),
  ])) as Record<ReferenceDependencyName, string>);
}

export const referenceDependencyIdentity = collectInstalledReferenceDependencyIdentity();
