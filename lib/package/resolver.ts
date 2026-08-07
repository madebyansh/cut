import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";
import type { CutModule, Declaration } from "../language/ast";
import { parseCutLanguage } from "../language/parser";
import { packageFail } from "./diagnostics";
import { parseStrictPackageJson } from "./json";
import {
  cutPackageContentIntegrity,
  cutPackageLockFile,
  cutPackageManifestFile,
  cutPackageManifestIntegrity,
  loadCutPackageManifest,
  validateCutPackageFileLocator,
  validateCutPackageSource,
  type CutPackageCapability,
  type CutPackageManifest,
} from "./manifest";
import { cutSemVerSatisfies, parseCutSemVer, parseCutSemVerRange } from "./semver";

export type CutPackageResolutionLimits = {
  maxPackages: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export const defaultCutPackageResolutionLimits: Readonly<CutPackageResolutionLimits> = Object.freeze({
  maxPackages: 128,
  maxDepth: 32,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
});

export type ResolvedCutPackage = {
  root: string;
  source: string;
  manifest: CutPackageManifest;
  manifestIntegrity: string;
  contentIntegrity: string;
  entryBytes: Uint8Array;
  module: CutModule;
};

export type CutPackageLockDependency = { name: string; version: string; integrity: string };
export type CutPackageLockEntry = {
  name: string;
  version: string;
  source: string;
  manifestIntegrity: string;
  contentIntegrity: string;
  entry: string;
  entryIntegrity: string;
  capabilities: CutPackageCapability[];
  dependencies: CutPackageLockDependency[];
};

export type CutPackageLock = {
  format: "cut-package-lock";
  version: 1;
  language: "0.4";
  project: {
    name: string;
    version: string;
    manifestIntegrity: string;
    contentIntegrity: string;
  };
  packages: CutPackageLockEntry[];
  integrity: string;
};

export type ResolvedCutPackageGraph = {
  root: ResolvedCutPackage;
  packages: Map<string, ResolvedCutPackage>;
  lock: CutPackageLock;
};

const integrityPattern = /^sha256-[a-f0-9]{64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const packageNamePattern = /^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const packageCapabilities = new Set<CutPackageCapability>(["analysis", "audio", "av", "data", "external", "generation", "media-read", "visual"]);
const builtins = new Set(["cut:core", "cut:visual", "@cut/audio", "@cut/edit", "@cut/motion", "@cut/geo", "@cut/data", "@cut/diagram", "@cut/documentary"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(value: unknown, path: string, required: readonly string[]) {
  if (!isRecord(value)) packageFail("CUT_PACKAGE_LOCK_TYPE", path, "must be a plain object.");
  const allowed = new Set(required);
  for (const field of required) if (!Object.hasOwn(value, field)) packageFail("CUT_PACKAGE_LOCK_MISSING_FIELD", path, `is missing ${JSON.stringify(field)}.`);
  for (const field of Object.keys(value)) if (!allowed.has(field)) packageFail("CUT_PACKAGE_LOCK_UNKNOWN_FIELD", `${path}.${field}`, "is not part of cut.package.lock v1.");
  return value;
}

function boundedText(value: unknown, path: string, maximum = 2048) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) packageFail("CUT_PACKAGE_LOCK_TYPE", path, `must be a non-empty string no longer than ${maximum} UTF-8 bytes.`);
  return value;
}

function integrity(value: unknown, path: string) {
  const result = boundedText(value, path, 71);
  if (!integrityPattern.test(result)) packageFail("CUT_PACKAGE_LOCK_INTEGRITY", path, "must be sha256- followed by a lowercase SHA-256 digest.");
  return result;
}

function lockedPackageName(value: unknown, path: string) {
  const result = boundedText(value, path, 214);
  if (!packageNamePattern.test(result) || result.startsWith("@cut/") || result.startsWith("cut:")) packageFail("CUT_PACKAGE_LOCK_NAME", path, `invalid or reserved package name ${JSON.stringify(result)}.`);
  return result;
}

function lockedSemVer(value: string, path: string) {
  try { parseCutSemVer(value, path); }
  catch { packageFail("CUT_PACKAGE_LOCK_SEMVER", path, "must be a canonical semantic version."); }
}

function lockedSemVerRange(value: string, path: string) {
  try { parseCutSemVerRange(value, path); }
  catch { packageFail("CUT_PACKAGE_LOCK_SEMVER", path, "must be an exact, caret, or tilde canonical semantic-version range."); }
}

function lockedSource(value: unknown, path: string) {
  try { return validateCutPackageSource(value, path); }
  catch { packageFail("CUT_PACKAGE_LOCK_PATH", path, "must be a canonical relative file: package locator."); }
}

function resolveLimits(overrides: Partial<CutPackageResolutionLimits>) {
  if (!isRecord(overrides)) packageFail("CUT_PACKAGE_TYPE", "$.options.limits", "must be a plain object.");
  const allowed = new Set(Object.keys(defaultCutPackageResolutionLimits));
  for (const [name, value] of Object.entries(overrides)) {
    if (!allowed.has(name)) packageFail("CUT_PACKAGE_UNKNOWN_FIELD", `$.options.limits.${name}`, "is not a supported resolution limit.");
    const ceiling = defaultCutPackageResolutionLimits[name as keyof CutPackageResolutionLimits];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > ceiling) packageFail("CUT_PACKAGE_LIMIT", `$.options.limits.${name}`, `must be between 1 and the hard ceiling ${ceiling}.`);
  }
  return { ...defaultCutPackageResolutionLimits, ...overrides };
}

async function readBoundedRegularFile(path: string, maximum: number, diagnosticPath: string) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") packageFail("CUT_PACKAGE_SYMLINK", diagnosticPath, "must not be a symbolic link.");
    packageFail("CUT_PACKAGE_FILE", diagnosticPath, `cannot be opened as a package file (${code ?? "unknown error"}).`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) packageFail("CUT_PACKAGE_FILE", diagnosticPath, "must be a regular file.");
    if (before.size <= 0 || before.size > maximum) packageFail("CUT_PACKAGE_LIMIT", diagnosticPath, `must contain between 1 and ${maximum} bytes.`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.byteLength !== before.size || before.mtimeMs !== after.mtimeMs) packageFail("CUT_PACKAGE_RACE", diagnosticPath, "changed while it was being read.");
    return new Uint8Array(bytes);
  } finally { await handle.close(); }
}

async function resolveDirectoryWithoutSymlinks(base: string, source: string, path: string) {
  const locator = source.slice("file:".length), basePhysical = await realpath(base);
  let cursor = basePhysical;
  for (const segment of locator.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") { cursor = dirname(cursor); continue; }
    cursor = resolve(cursor, segment);
    let metadata;
    try { metadata = await lstat(cursor); }
    catch { packageFail("CUT_PACKAGE_PATH", path, `does not resolve to an existing package directory (${source}).`); }
    if (metadata.isSymbolicLink()) packageFail("CUT_PACKAGE_SYMLINK", path, `resolves through symbolic link ${JSON.stringify(segment)}.`);
  }
  const metadata = await lstat(cursor);
  if (!metadata.isDirectory()) packageFail("CUT_PACKAGE_PATH", path, `${source} does not resolve to a directory.`);
  return realpath(cursor);
}

async function resolvePackageFile(packageRoot: string, locator: string, path: string) {
  validateCutPackageFileLocator(locator, path);
  const physicalRoot = await realpath(packageRoot), candidate = resolve(physicalRoot, ...locator.split("/"));
  const local = relative(physicalRoot, candidate);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) packageFail("CUT_PACKAGE_PATH", path, "escapes the package root.");
  let cursor = physicalRoot;
  for (const segment of locator.split("/")) {
    cursor = resolve(cursor, segment);
    let metadata;
    try { metadata = await lstat(cursor); }
    catch { packageFail("CUT_PACKAGE_FILE", path, `declared file ${JSON.stringify(locator)} does not exist.`); }
    if (metadata.isSymbolicLink()) packageFail("CUT_PACKAGE_SYMLINK", path, `declared file ${JSON.stringify(locator)} resolves through a symbolic link.`);
  }
  return cursor;
}

function sourceText(bytes: Uint8Array, path: string) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { packageFail("CUT_PACKAGE_SOURCE_ENCODING", path, "must be valid UTF-8 CUT source."); }
}

function packageSourceContract(manifest: CutPackageManifest, source: string, path: string, application = false) {
  const parsed = parseCutLanguage(source);
  if (!parsed.module || parsed.diagnostics.some((item) => item.severity === "error")) {
    const first = parsed.diagnostics.find((item) => item.severity === "error");
    packageFail("CUT_PACKAGE_SOURCE_PARSE", path, first ? `${first.code} at ${first.span.start.line}:${first.span.start.column}: ${first.message}` : "entry is not a valid CUT module.");
  }
  const cutModule = parsed.module;
  const forbidden = application ? undefined : cutModule.declarations.find((item) => !["language", "project", "import", "component"].includes(item.kind));
  if (forbidden) packageFail("CUT_PACKAGE_SOURCE_DECLARATION", path, `package entry may contain language, project, imports, and components only in manifest v1; found ${forbidden.kind}.`);
  const components = new Map(cutModule.declarations.filter((item): item is Extract<Declaration, { kind: "component" }> => item.kind === "component").map((item) => [item.name, item]));
  for (const [exportName, exported] of Object.entries(manifest.exports)) {
    const declaration = components.get(exported.declaration);
    if (!declaration) packageFail("CUT_PACKAGE_EXPORT_MISSING", `$.exports[${JSON.stringify(exportName)}].declaration`, `does not name a component in ${manifest.entry}.`);
    const returnName = declaration.returnType?.name ?? "AVNode";
    const required: CutPackageCapability = returnName === "Visual" ? "visual" : returnName === "AudioNode" ? "audio" : "av";
    if (!manifest.capabilities.includes(required)) packageFail("CUT_PACKAGE_CAPABILITY", `$.exports[${JSON.stringify(exportName)}]`, `component ${exported.declaration} returns ${returnName} and requires declared ${required} capability.`);
  }
  for (const declaration of cutModule.declarations) {
    if (declaration.kind !== "import") continue;
    if (!builtins.has(declaration.module) && !Object.hasOwn(manifest.dependencies, declaration.module)) packageFail("CUT_PACKAGE_UNDECLARED_DEPENDENCY", path, `imports ${JSON.stringify(declaration.module)} without declaring it in dependencies.`);
  }
  return cutModule;
}

export async function readResolvedCutPackage(packageRoot: string, source = "file:.", options: { limits?: Partial<CutPackageResolutionLimits>; budget?: { totalBytes: number }; application?: boolean } = {}): Promise<ResolvedCutPackage> {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "limits" && key !== "budget" && key !== "application")) packageFail("CUT_PACKAGE_UNKNOWN_FIELD", "$.options", "contains an unsupported option.");
  const limits = resolveLimits(options.limits ?? {}), lexicalRoot = resolve(packageRoot), lexicalMetadata = await lstat(lexicalRoot).catch(() => undefined);
  if (!lexicalMetadata) packageFail("CUT_PACKAGE_PATH", source, "package root does not exist.");
  if (lexicalMetadata.isSymbolicLink()) packageFail("CUT_PACKAGE_SYMLINK", source, "package root must not be a symbolic link.");
  if (!lexicalMetadata.isDirectory()) packageFail("CUT_PACKAGE_PATH", source, "package root must be a directory.");
  const root = await realpath(lexicalRoot);
  const manifestPath = resolve(root, cutPackageManifestFile), manifestMetadata = await lstat(manifestPath).catch(() => undefined);
  if (!manifestMetadata) packageFail("CUT_PACKAGE_MANIFEST_MISSING", source, `does not contain ${cutPackageManifestFile}.`);
  if (manifestMetadata.isSymbolicLink()) packageFail("CUT_PACKAGE_SYMLINK", cutPackageManifestFile, "package manifest must not be a symbolic link.");
  const manifestBytes = await readBoundedRegularFile(manifestPath, 1024 * 1024, cutPackageManifestFile), manifest = loadCutPackageManifest(manifestBytes);
  let total = manifestBytes.byteLength;
  const fileBytes = new Map<string, Uint8Array>();
  for (const [locator, expected] of Object.entries(manifest.integrity.files).sort(([left], [right]) => left.localeCompare(right))) {
    const path = await resolvePackageFile(root, locator, `$.integrity.files[${JSON.stringify(locator)}]`);
    const bytes = await readBoundedRegularFile(path, limits.maxFileBytes, locator);
    total += bytes.byteLength;
    if (total > limits.maxTotalBytes) packageFail("CUT_PACKAGE_LIMIT", locator, `package files exceed ${limits.maxTotalBytes} bytes.`);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) packageFail("CUT_PACKAGE_TAMPERED", locator, `declared ${expected}, read ${actual}.`);
    fileBytes.set(locator, bytes);
  }
  if (options.budget) {
    options.budget.totalBytes += total;
    if (options.budget.totalBytes > limits.maxTotalBytes) packageFail("CUT_PACKAGE_LIMIT", source, `resolved graph files exceed ${limits.maxTotalBytes} bytes.`);
  }
  const entryBytes = fileBytes.get(manifest.entry)!;
  const cutModule = packageSourceContract(manifest, sourceText(entryBytes, manifest.entry), manifest.entry, options.application);
  return { root, source, manifest, manifestIntegrity: cutPackageManifestIntegrity(manifest), contentIntegrity: cutPackageContentIntegrity(manifest), entryBytes, module: cutModule };
}

function relativeFileSource(projectRoot: string, packageRoot: string) {
  const local = relative(projectRoot, packageRoot).split(sep).join("/");
  if (!local) packageFail("CUT_PACKAGE_CYCLE", "$project", "project package cannot resolve itself as a dependency.");
  return `file:${local}`;
}

function lockBody(lock: Omit<CutPackageLock, "integrity">) { return stableJsonStringify(lock); }
function lockIntegrity(lock: Omit<CutPackageLock, "integrity">) { return `sha256-${createHash("sha256").update(lockBody(lock)).digest("hex")}`; }

export async function resolveCutPackageGraph(projectRoot: string, options: { limits?: Partial<CutPackageResolutionLimits> } = {}): Promise<ResolvedCutPackageGraph> {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "limits")) packageFail("CUT_PACKAGE_UNKNOWN_FIELD", "$.options", "contains an unsupported option.");
  const limits = resolveLimits(options.limits ?? {}), physicalProjectRoot = await realpath(resolve(projectRoot)), budget = { totalBytes: 0 };
  const root = await readResolvedCutPackage(physicalProjectRoot, "file:.", { limits, budget, application: true }), packages = new Map<string, ResolvedCutPackage>(), packagesByRoot = new Map<string, ResolvedCutPackage>();
  const visiting: string[] = [];

  const visit = async (owner: ResolvedCutPackage, dependencyName: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) packageFail("CUT_PACKAGE_LIMIT", `dependency ${dependencyName}`, `dependency depth exceeds ${limits.maxDepth}.`);
    const declaration = owner.manifest.dependencies[dependencyName], diagnosticPath = `${owner.manifest.name}.dependencies[${JSON.stringify(dependencyName)}]`;
    const targetRoot = await resolveDirectoryWithoutSymlinks(owner.root, declaration.source, `${diagnosticPath}.source`);
    if (visiting.includes(targetRoot)) {
      const cycleStart = visiting.indexOf(targetRoot), names = [...visiting.slice(cycleStart).map((item) => [...packages.values(), root].find((candidate) => candidate.root === item)?.manifest.name ?? item), dependencyName];
      packageFail("CUT_PACKAGE_CYCLE", diagnosticPath, `dependency cycle: ${names.join(" -> ")}.`);
    }
    const existingRoot = packagesByRoot.get(targetRoot);
    if (existingRoot) {
      if (existingRoot.manifest.name !== dependencyName) packageFail("CUT_PACKAGE_NAME_MISMATCH", diagnosticPath, `declares ${JSON.stringify(dependencyName)} but source is package ${JSON.stringify(existingRoot.manifest.name)}.`);
      if (!cutSemVerSatisfies(existingRoot.manifest.version, declaration.version, `${diagnosticPath}.version`)) packageFail("CUT_PACKAGE_VERSION_CONFLICT", diagnosticPath, `${existingRoot.manifest.version} does not satisfy ${declaration.version}.`);
      if (existingRoot.contentIntegrity !== declaration.integrity) packageFail("CUT_PACKAGE_INTEGRITY_CONFLICT", diagnosticPath, `pins ${declaration.integrity}, but source resolves to ${existingRoot.contentIntegrity}.`);
      return;
    }
    const resolved = await readResolvedCutPackage(targetRoot, relativeFileSource(physicalProjectRoot, targetRoot), { limits, budget });
    if (resolved.manifest.name !== dependencyName) packageFail("CUT_PACKAGE_NAME_MISMATCH", diagnosticPath, `declares ${JSON.stringify(dependencyName)} but source is package ${JSON.stringify(resolved.manifest.name)}.`);
    if (!cutSemVerSatisfies(resolved.manifest.version, declaration.version, `${diagnosticPath}.version`)) packageFail("CUT_PACKAGE_VERSION_CONFLICT", diagnosticPath, `${resolved.manifest.version} does not satisfy ${declaration.version}.`);
    if (resolved.contentIntegrity !== declaration.integrity) packageFail("CUT_PACKAGE_INTEGRITY_CONFLICT", diagnosticPath, `pins ${declaration.integrity}, but source resolves to ${resolved.contentIntegrity}.`);

    const existing = packages.get(dependencyName);
    if (existing) {
      if (existing.contentIntegrity !== resolved.contentIntegrity || existing.manifest.version !== resolved.manifest.version || existing.root !== resolved.root) packageFail("CUT_PACKAGE_CONFLICT", diagnosticPath, `${dependencyName} resolves to incompatible local package instances (${existing.manifest.version} ${existing.contentIntegrity} versus ${resolved.manifest.version} ${resolved.contentIntegrity}).`);
      return;
    }
    packages.set(dependencyName, resolved); packagesByRoot.set(resolved.root, resolved);
    if (packages.size > limits.maxPackages) packageFail("CUT_PACKAGE_LIMIT", diagnosticPath, `resolved graph contains more than ${limits.maxPackages} packages.`);
    visiting.push(resolved.root);
    for (const childName of Object.keys(resolved.manifest.dependencies).sort()) await visit(resolved, childName, depth + 1);
    visiting.pop();
  };

  visiting.push(root.root);
  for (const dependencyName of Object.keys(root.manifest.dependencies).sort()) await visit(root, dependencyName, 1);
  visiting.pop();

  const body: Omit<CutPackageLock, "integrity"> = {
    format: "cut-package-lock",
    version: 1,
    language: "0.4",
    project: { name: root.manifest.name, version: root.manifest.version, manifestIntegrity: root.manifestIntegrity, contentIntegrity: root.contentIntegrity },
    packages: [...packages.values()].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)).map((item) => ({
      name: item.manifest.name,
      version: item.manifest.version,
      source: relativeFileSource(physicalProjectRoot, item.root),
      manifestIntegrity: item.manifestIntegrity,
      contentIntegrity: item.contentIntegrity,
      entry: item.manifest.entry,
      entryIntegrity: item.manifest.integrity.files[item.manifest.entry],
      capabilities: [...item.manifest.capabilities].sort(),
      dependencies: Object.entries(item.manifest.dependencies).sort(([left], [right]) => left.localeCompare(right)).map(([name, dependency]) => ({ name, version: dependency.version, integrity: dependency.integrity })),
    })),
  };
  return { root, packages, lock: validateCutPackageLock({ ...body, integrity: lockIntegrity(body) }) };
}

export function validateCutPackageLock(value: unknown): CutPackageLock {
  const root = closed(value, "$", ["format", "integrity", "language", "packages", "project", "version"]);
  if (root.format !== "cut-package-lock" || root.version !== 1 || root.language !== "0.4") packageFail("CUT_PACKAGE_LOCK_VERSION", "$", "requires cut-package-lock v1 for CUT 0.4.");
  const project = closed(root.project, "$.project", ["contentIntegrity", "manifestIntegrity", "name", "version"]);
  const projectName = lockedPackageName(project.name, "$.project.name"), projectVersion = boundedText(project.version, "$.project.version", 128);
  lockedSemVer(projectVersion, "$.project.version");
  const projectManifestIntegrity = integrity(project.manifestIntegrity, "$.project.manifestIntegrity"), projectContentIntegrity = integrity(project.contentIntegrity, "$.project.contentIntegrity");
  if (!Array.isArray(root.packages) || root.packages.length > defaultCutPackageResolutionLimits.maxPackages) packageFail("CUT_PACKAGE_LOCK_LIMIT", "$.packages", `must contain at most ${defaultCutPackageResolutionLimits.maxPackages} packages.`);
  const names = new Set<string>(), sources = new Set<string>(); let previous: string | undefined;
  const packages: CutPackageLockEntry[] = root.packages.map((item, index) => {
    const path = `$.packages[${index}]`, package_ = closed(item, path, ["capabilities", "contentIntegrity", "dependencies", "entry", "entryIntegrity", "manifestIntegrity", "name", "source", "version"]);
    const name = lockedPackageName(package_.name, `${path}.name`);
    if (name === projectName) packageFail("CUT_PACKAGE_LOCK_NAME", `${path}.name`, "cannot equal the project package name.");
    if (names.has(name) || (previous !== undefined && previous.localeCompare(name) >= 0)) packageFail("CUT_PACKAGE_LOCK_ORDER", `${path}.name`, "package names must be unique and strictly sorted.");
    names.add(name); previous = name;
    const source = lockedSource(package_.source, `${path}.source`);
    if (sources.has(source)) packageFail("CUT_PACKAGE_LOCK_PATH", `${path}.source`, "must resolve one package name per locked local source.");
    sources.add(source);
    const entry = validateCutPackageFileLocator(package_.entry, `${path}.entry`), entryIntegrity = boundedText(package_.entryIntegrity, `${path}.entryIntegrity`, 64);
    if (!hashPattern.test(entryIntegrity)) packageFail("CUT_PACKAGE_LOCK_INTEGRITY", `${path}.entryIntegrity`, "must be a lowercase SHA-256 digest.");
    if (!Array.isArray(package_.capabilities) || package_.capabilities.some((capability) => typeof capability !== "string")) packageFail("CUT_PACKAGE_LOCK_TYPE", `${path}.capabilities`, "must be a capability string array.");
    const lockedCapabilities = package_.capabilities as CutPackageCapability[];
    lockedCapabilities.forEach((capability, capabilityIndex) => {
      if (!packageCapabilities.has(capability)) packageFail("CUT_PACKAGE_LOCK_CAPABILITY", `${path}.capabilities[${capabilityIndex}]`, `unknown capability ${JSON.stringify(capability)}.`);
    });
    if (new Set(lockedCapabilities).size !== lockedCapabilities.length || [...lockedCapabilities].sort().join("\0") !== lockedCapabilities.join("\0")) packageFail("CUT_PACKAGE_LOCK_ORDER", `${path}.capabilities`, "must be unique and sorted.");
    if (!Array.isArray(package_.dependencies) || package_.dependencies.length > defaultCutPackageManifestDependencyCeiling()) packageFail("CUT_PACKAGE_LOCK_LIMIT", `${path}.dependencies`, "contains too many dependencies.");
    let previousDependency: string | undefined;
    const dependencies: CutPackageLockDependency[] = package_.dependencies.map((dependency, dependencyIndex) => {
      const dependencyPath = `${path}.dependencies[${dependencyIndex}]`, object = closed(dependency, dependencyPath, ["integrity", "name", "version"]), dependencyName = lockedPackageName(object.name, `${dependencyPath}.name`);
      if (previousDependency !== undefined && previousDependency.localeCompare(dependencyName) >= 0) packageFail("CUT_PACKAGE_LOCK_ORDER", `${dependencyPath}.name`, "dependencies must be unique and strictly sorted.");
      previousDependency = dependencyName;
      const dependencyVersion = boundedText(object.version, `${dependencyPath}.version`, 129);
      lockedSemVerRange(dependencyVersion, `${dependencyPath}.version`);
      return { name: dependencyName, version: dependencyVersion, integrity: integrity(object.integrity, `${dependencyPath}.integrity`) };
    });
    const version = boundedText(package_.version, `${path}.version`, 128); lockedSemVer(version, `${path}.version`);
    return { name, version, source, manifestIntegrity: integrity(package_.manifestIntegrity, `${path}.manifestIntegrity`), contentIntegrity: integrity(package_.contentIntegrity, `${path}.contentIntegrity`), entry, entryIntegrity, capabilities: lockedCapabilities, dependencies };
  });
  const packageByName = new Map(packages.map((item) => [item.name, item]));
  for (const package_ of packages) {
    for (const dependency of package_.dependencies) {
      const target = packageByName.get(dependency.name), path = `$.packages[${JSON.stringify(package_.name)}].dependencies[${JSON.stringify(dependency.name)}]`;
      if (!target) packageFail("CUT_PACKAGE_LOCK_REFERENCE", path, "references a package absent from the lock.");
      if (!cutSemVerSatisfies(target.version, dependency.version)) packageFail("CUT_PACKAGE_LOCK_CONFLICT", `${path}.version`, `${target.version} does not satisfy ${dependency.version}.`);
      if (target.contentIntegrity !== dependency.integrity) packageFail("CUT_PACKAGE_LOCK_CONFLICT", `${path}.integrity`, "does not match the target package content identity.");
    }
  }
  const state = new Map<string, "visiting" | "done">(), stack: string[] = [];
  const visit = (name: string) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      const start = stack.indexOf(name);
      packageFail("CUT_PACKAGE_LOCK_CYCLE", `$.packages[${JSON.stringify(name)}]`, `locked dependency cycle: ${[...stack.slice(start), name].join(" -> ")}.`);
    }
    state.set(name, "visiting"); stack.push(name);
    packageByName.get(name)!.dependencies.forEach((dependency) => visit(dependency.name));
    stack.pop(); state.set(name, "done");
  };
  [...packageByName.keys()].sort().forEach(visit);
  const body: Omit<CutPackageLock, "integrity"> = { format: "cut-package-lock", version: 1, language: "0.4", project: { name: projectName, version: projectVersion, manifestIntegrity: projectManifestIntegrity, contentIntegrity: projectContentIntegrity }, packages };
  const declaredIntegrity = integrity(root.integrity, "$.integrity"), expected = lockIntegrity(body);
  if (declaredIntegrity !== expected) packageFail("CUT_PACKAGE_LOCK_TAMPERED", "$.integrity", `declares ${declaredIntegrity}, canonical lock is ${expected}.`);
  return JSON.parse(stableJsonStringify({ ...body, integrity: declaredIntegrity })) as CutPackageLock;
}

function defaultCutPackageManifestDependencyCeiling() { return 128; }

export function loadCutPackageLock(input: string | Uint8Array) { return validateCutPackageLock(parseStrictPackageJson(input)); }

export async function resolveVerifiedCutPackageGraph(projectRoot: string, lock: CutPackageLock, options: { limits?: Partial<CutPackageResolutionLimits> } = {}) {
  const declared = validateCutPackageLock(lock), graph = await resolveCutPackageGraph(projectRoot, options);
  if (stableJsonStringify(declared) !== stableJsonStringify(graph.lock)) packageFail("CUT_PACKAGE_LOCK_STALE", cutPackageLockFile, "does not match the current manifests, dependency graph, or package bytes; run `cut package update`.");
  return graph;
}

export async function verifyCutPackageLock(projectRoot: string, lock: CutPackageLock, options: { limits?: Partial<CutPackageResolutionLimits> } = {}) {
  return (await resolveVerifiedCutPackageGraph(projectRoot, lock, options)).lock;
}

export async function resolveDirectCutPackageSource(ownerRoot: string, source: string) {
  return resolveDirectoryWithoutSymlinks(ownerRoot, source, "$.source");
}
