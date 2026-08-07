import { createHash } from "node:crypto";
import { posix } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { packageFail } from "./diagnostics";
import { parseStrictPackageJson, type CutPackageJsonLimits } from "./json";
import { parseCutSemVer, parseCutSemVerRange } from "./semver";

export const cutPackageManifestFile = "cut.package.json";
export const cutPackageLockFile = "cut.package.lock";

export type CutPackageCapability = "visual" | "audio" | "av" | "data" | "media-read" | "analysis" | "generation" | "external";

export type CutPackageDependency = {
  source: string;
  version: string;
  integrity: string;
};

export type CutPackageExport = {
  kind: "component";
  declaration: string;
  documentation: string;
};

export type CutPackageManifest = {
  format: "cut-package";
  manifestVersion: 1;
  name: string;
  version: string;
  language: "0.4";
  entry: string;
  capabilities: CutPackageCapability[];
  dependencies: Record<string, CutPackageDependency>;
  exports: Record<string, CutPackageExport>;
  integrity: {
    algorithm: "sha256";
    files: Record<string, string>;
  };
};

export type CutPackageManifestLimits = {
  maxDependencies: number;
  maxExports: number;
  maxFiles: number;
  maxDocumentationBytes: number;
};

export const defaultCutPackageManifestLimits: Readonly<CutPackageManifestLimits> = Object.freeze({
  maxDependencies: 128,
  maxExports: 256,
  maxFiles: 256,
  maxDocumentationBytes: 16 * 1024,
});

const hashPattern = /^[a-f0-9]{64}$/;
const integrityPattern = /^sha256-[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const packageNamePattern = /^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const capabilities = new Set<CutPackageCapability>(["analysis", "audio", "av", "data", "external", "generation", "media-read", "visual"]);
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string) {
  if (!isRecord(value)) packageFail("CUT_PACKAGE_TYPE", path, "must be a plain object.");
  return value;
}

function closed(value: unknown, path: string, required: readonly string[]) {
  const result = record(value, path), allowed = new Set(required);
  for (const field of required) if (!Object.hasOwn(result, field)) packageFail("CUT_PACKAGE_MISSING_FIELD", path, `is missing required field ${JSON.stringify(field)}.`);
  for (const field of Object.keys(result)) if (!allowed.has(field)) packageFail("CUT_PACKAGE_UNKNOWN_FIELD", `${path}.${field}`, "is not part of cut.package.json v1.");
  return result;
}

function text(value: unknown, path: string, maximum: number, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) packageFail("CUT_PACKAGE_TYPE", path, `must be ${allowEmpty ? "a" : "a non-empty"} string no longer than ${maximum} UTF-8 bytes without NUL.`);
  return value;
}

function packageName(value: unknown, path: string) {
  const result = text(value, path, 214);
  if (!packageNamePattern.test(result) || unsafeKeys.has(result) || result.startsWith("cut:") || result.startsWith("@cut/")) packageFail("CUT_PACKAGE_NAME", path, `invalid or reserved package name ${JSON.stringify(result)}.`);
  return result;
}

export function validateCutPackageFileLocator(value: unknown, path: string) {
  const locator = text(value, path, 1024);
  if (locator.startsWith("/") || /^[A-Za-z]:/.test(locator) || locator.includes("\\") || locator.includes("%") || locator.includes("?") || locator.includes("#")) packageFail("CUT_PACKAGE_PATH", path, "must be a plain POSIX project-relative path.");
  const segments = locator.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || unsafeKeys.has(segment))) packageFail("CUT_PACKAGE_PATH", path, "cannot contain empty, dot, parent, or unsafe path segments.");
  return locator;
}

export function validateCutPackageSource(value: unknown, path: string) {
  const source = text(value, path, 2048);
  if (!source.startsWith("file:")) packageFail("CUT_PACKAGE_SOURCE", path, "only explicit local file: package sources are supported in CUT 0.4 alpha.");
  const locator = source.slice("file:".length);
  if (!locator || locator.startsWith("/") || /^[A-Za-z]:/.test(locator) || locator.includes("\\") || locator.includes("%") || locator.includes("?") || locator.includes("#")) packageFail("CUT_PACKAGE_PATH", path, "file: source must contain a plain relative POSIX path.");
  const segments = locator.split("/");
  if (segments.some((segment) => !segment || segment === "." || unsafeKeys.has(segment)) || segments.every((segment) => segment === "..") || posix.normalize(locator) !== locator) packageFail("CUT_PACKAGE_PATH", path, "file: source must be a canonical relative POSIX path to a package directory.");
  return `file:${segments.join("/")}`;
}

function resolveLimits(overrides: Partial<CutPackageManifestLimits>) {
  if (!isRecord(overrides)) packageFail("CUT_PACKAGE_TYPE", "$.options.limits", "must be a plain object.");
  const allowed = new Set(Object.keys(defaultCutPackageManifestLimits));
  for (const [name, value] of Object.entries(overrides)) {
    if (!allowed.has(name)) packageFail("CUT_PACKAGE_UNKNOWN_FIELD", `$.options.limits.${name}`, "is not a supported manifest limit.");
    const ceiling = defaultCutPackageManifestLimits[name as keyof CutPackageManifestLimits];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > ceiling) packageFail("CUT_PACKAGE_LIMIT", `$.options.limits.${name}`, `must be between 1 and the hard ceiling ${ceiling}.`);
  }
  return { ...defaultCutPackageManifestLimits, ...overrides };
}

function canonicalClone<T>(value: T): T { return JSON.parse(stableJsonStringify(value)) as T; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

export function validateCutPackageManifest(value: unknown, options: { limits?: Partial<CutPackageManifestLimits> } = {}): CutPackageManifest {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "limits")) packageFail("CUT_PACKAGE_UNKNOWN_FIELD", "$.options", "contains an unsupported option.");
  const limits = resolveLimits(options.limits ?? {});
  const manifest = closed(value, "$", ["capabilities", "dependencies", "entry", "exports", "format", "integrity", "language", "manifestVersion", "name", "version"]);
  if (manifest.format !== "cut-package" || manifest.manifestVersion !== 1 || manifest.language !== "0.4") packageFail("CUT_PACKAGE_VERSION", "$", "requires cut-package manifest v1 for CUT language 0.4.");
  const name = packageName(manifest.name, "$.name"), version = text(manifest.version, "$.version", 128);
  parseCutSemVer(version, "$.version");
  const entry = validateCutPackageFileLocator(manifest.entry, "$.entry");

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > capabilities.size) packageFail("CUT_PACKAGE_CAPABILITY", "$.capabilities", `must be an array with at most ${capabilities.size} capabilities.`);
  const declaredCapabilities: CutPackageCapability[] = [], seenCapabilities = new Set<string>();
  manifest.capabilities.forEach((item, index) => {
    if (typeof item !== "string" || !capabilities.has(item as CutPackageCapability)) packageFail("CUT_PACKAGE_CAPABILITY", `$.capabilities[${index}]`, `unknown package capability ${JSON.stringify(item)}.`);
    if (seenCapabilities.has(item)) packageFail("CUT_PACKAGE_CAPABILITY", `$.capabilities[${index}]`, `duplicate package capability ${JSON.stringify(item)}.`);
    seenCapabilities.add(item); declaredCapabilities.push(item as CutPackageCapability);
  });
  declaredCapabilities.sort();

  const rawDependencies = record(manifest.dependencies, "$.dependencies"), dependencyNames = Object.keys(rawDependencies);
  if (dependencyNames.length > limits.maxDependencies) packageFail("CUT_PACKAGE_LIMIT", "$.dependencies", `contains more than ${limits.maxDependencies} dependencies.`);
  const dependencies: Record<string, CutPackageDependency> = {};
  for (const dependencyName of dependencyNames) {
    packageName(dependencyName, `$.dependencies[${JSON.stringify(dependencyName)}]`);
    if (dependencyName === name) packageFail("CUT_PACKAGE_CYCLE", `$.dependencies[${JSON.stringify(dependencyName)}]`, "a package cannot directly depend on itself.");
    const dependency = closed(rawDependencies[dependencyName], `$.dependencies[${JSON.stringify(dependencyName)}]`, ["integrity", "source", "version"]);
    const range = text(dependency.version, `$.dependencies[${JSON.stringify(dependencyName)}].version`, 129);
    parseCutSemVerRange(range, `$.dependencies[${JSON.stringify(dependencyName)}].version`);
    const expectedIntegrity = text(dependency.integrity, `$.dependencies[${JSON.stringify(dependencyName)}].integrity`, 71);
    if (!integrityPattern.test(expectedIntegrity)) packageFail("CUT_PACKAGE_INTEGRITY", `$.dependencies[${JSON.stringify(dependencyName)}].integrity`, "must be sha256- followed by a lowercase 64-character digest.");
    dependencies[dependencyName] = { source: validateCutPackageSource(dependency.source, `$.dependencies[${JSON.stringify(dependencyName)}].source`), version: range, integrity: expectedIntegrity };
  }

  const rawExports = record(manifest.exports, "$.exports"), exportNames = Object.keys(rawExports);
  if (exportNames.length > limits.maxExports) packageFail("CUT_PACKAGE_LIMIT", "$.exports", `contains more than ${limits.maxExports} exports.`);
  const exports: Record<string, CutPackageExport> = {};
  for (const exportName of exportNames) {
    if (!identifierPattern.test(exportName) || unsafeKeys.has(exportName)) packageFail("CUT_PACKAGE_EXPORT", `$.exports[${JSON.stringify(exportName)}]`, "export name must be a safe CUT identifier.");
    const exported = closed(rawExports[exportName], `$.exports[${JSON.stringify(exportName)}]`, ["declaration", "documentation", "kind"]);
    if (exported.kind !== "component") packageFail("CUT_PACKAGE_EXPORT", `$.exports[${JSON.stringify(exportName)}].kind`, "only public CUT component exports are supported in package manifest v1.");
    const declaration = text(exported.declaration, `$.exports[${JSON.stringify(exportName)}].declaration`, 256);
    if (!identifierPattern.test(declaration) || unsafeKeys.has(declaration)) packageFail("CUT_PACKAGE_EXPORT", `$.exports[${JSON.stringify(exportName)}].declaration`, "must name a safe CUT component declaration.");
    const documentation = text(exported.documentation, `$.exports[${JSON.stringify(exportName)}].documentation`, limits.maxDocumentationBytes, true);
    exports[exportName] = { kind: "component", declaration, documentation };
  }

  const rawIntegrity = closed(manifest.integrity, "$.integrity", ["algorithm", "files"]);
  if (rawIntegrity.algorithm !== "sha256") packageFail("CUT_PACKAGE_INTEGRITY", "$.integrity.algorithm", "must be sha256.");
  const rawFiles = record(rawIntegrity.files, "$.integrity.files"), fileLocators = Object.keys(rawFiles);
  if (!fileLocators.length || fileLocators.length > limits.maxFiles) packageFail("CUT_PACKAGE_LIMIT", "$.integrity.files", `must contain between 1 and ${limits.maxFiles} files.`);
  const files: Record<string, string> = {};
  for (const rawLocator of fileLocators) {
    const locator = validateCutPackageFileLocator(rawLocator, `$.integrity.files[${JSON.stringify(rawLocator)}]`);
    const digest = text(rawFiles[rawLocator], `$.integrity.files[${JSON.stringify(rawLocator)}]`, 64);
    if (!hashPattern.test(digest)) packageFail("CUT_PACKAGE_INTEGRITY", `$.integrity.files[${JSON.stringify(rawLocator)}]`, "must be a lowercase SHA-256 digest.");
    files[locator] = digest;
  }
  if (!Object.hasOwn(files, entry)) packageFail("CUT_PACKAGE_INTEGRITY", "$.integrity.files", `must declare the entry file ${JSON.stringify(entry)}.`);

  return deepFreeze(canonicalClone({ format: "cut-package", manifestVersion: 1, name, version, language: "0.4", entry, capabilities: declaredCapabilities, dependencies, exports, integrity: { algorithm: "sha256", files } }));
}

export function loadCutPackageManifest(input: string | Uint8Array, options: { jsonLimits?: Partial<CutPackageJsonLimits>; limits?: Partial<CutPackageManifestLimits> } = {}) {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "jsonLimits" && key !== "limits")) packageFail("CUT_PACKAGE_UNKNOWN_FIELD", "$.options", "contains an unsupported option.");
  return validateCutPackageManifest(parseStrictPackageJson(input, { limits: options.jsonLimits }), { limits: options.limits });
}

export function cutPackageManifestIntegrity(manifest: CutPackageManifest) {
  return `sha256-${createHash("sha256").update(stableJsonStringify(manifest)).digest("hex")}`;
}

export function cutPackageContentIntegrity(manifest: CutPackageManifest) {
  const { integrity, ...semanticManifest } = manifest;
  return `sha256-${createHash("sha256").update(stableJsonStringify({ manifest: semanticManifest, files: integrity.files })).digest("hex")}`;
}
