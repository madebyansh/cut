import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { packageFail } from "./diagnostics";
import {
  cutPackageLockFile,
  cutPackageManifestFile,
  cutPackageManifestIntegrity,
  loadCutPackageManifest,
  validateCutPackageFileLocator,
  validateCutPackageManifest,
  validateCutPackageSource,
  type CutPackageCapability,
  type CutPackageDependency,
  type CutPackageExport,
  type CutPackageManifest,
} from "./manifest";
import {
  readResolvedCutPackage,
  resolveCutPackageGraph,
  resolveDirectCutPackageSource,
  type CutPackageLock,
  type CutPackageResolutionLimits,
} from "./resolver";
import { defaultCutSemVerRange, parseCutSemVer } from "./semver";

function sha256(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function encoded(value: unknown) { return `${JSON.stringify(value, null, 2)}\n`; }

async function regularBytes(path: string, label: string) {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata) packageFail("CUT_PACKAGE_FILE", label, "does not exist.");
  if (metadata.isSymbolicLink()) packageFail("CUT_PACKAGE_SYMLINK", label, "must not be a symbolic link.");
  if (!metadata.isFile()) packageFail("CUT_PACKAGE_FILE", label, "must be a regular file.");
  return new Uint8Array(await readFile(path));
}

async function packageFileBytes(projectRoot: string, locator: string) {
  validateCutPackageFileLocator(locator, `$.integrity.files[${JSON.stringify(locator)}]`);
  let cursor = await realpath(projectRoot);
  for (const segment of locator.split("/")) {
    cursor = resolve(cursor, segment);
    const metadata = await lstat(cursor).catch(() => undefined);
    if (!metadata) packageFail("CUT_PACKAGE_FILE", locator, "does not exist.");
    if (metadata.isSymbolicLink()) packageFail("CUT_PACKAGE_SYMLINK", locator, `resolves through symbolic link ${JSON.stringify(segment)}.`);
  }
  return regularBytes(cursor, locator);
}

export async function readCutPackageManifestFile(projectRoot: string) {
  return loadCutPackageManifest(await regularBytes(resolve(projectRoot, cutPackageManifestFile), cutPackageManifestFile));
}

export async function refreshCutPackageManifestIntegrity(projectRoot: string, manifest: CutPackageManifest) {
  const files: Record<string, string> = {};
  for (const locator of Object.keys(manifest.integrity.files).sort()) {
    files[locator] = sha256(await packageFileBytes(projectRoot, locator));
  }
  return validateCutPackageManifest({ ...manifest, integrity: { algorithm: "sha256", files } });
}

async function atomicWrite(path: string, contents: string | Uint8Array) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${createHash("sha256").update(String(Date.now())).update(path).digest("hex").slice(0, 12)}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function commitManifestAndLock(projectRoot: string, manifest: CutPackageManifest, limits?: Partial<CutPackageResolutionLimits>, expectedManifestIntegrity?: string, requireAbsent = false) {
  const manifestPath = resolve(projectRoot, cutPackageManifestFile), lockPath = resolve(projectRoot, cutPackageLockFile);
  const [oldManifest, oldLock] = await Promise.all([
    readFile(manifestPath).catch(() => undefined),
    readFile(lockPath).catch(() => undefined),
  ]);
  if (requireAbsent && oldManifest) packageFail("CUT_PACKAGE_EXISTS", cutPackageManifestFile, "was created concurrently.");
  if (expectedManifestIntegrity) {
    if (!oldManifest || cutPackageManifestIntegrity(loadCutPackageManifest(oldManifest)) !== expectedManifestIntegrity) packageFail("CUT_PACKAGE_CONCURRENT_CHANGE", cutPackageManifestFile, "changed during the package operation; retry against the new manifest.");
  }
  await atomicWrite(manifestPath, encoded(manifest));
  try {
    const graph = await resolveCutPackageGraph(projectRoot, { limits });
    await atomicWrite(lockPath, encoded(graph.lock));
    return graph.lock;
  } catch (error) {
    if (oldManifest) await atomicWrite(manifestPath, oldManifest);
    else await rm(manifestPath, { force: true });
    if (oldLock) await atomicWrite(lockPath, oldLock);
    else await rm(lockPath, { force: true });
    throw error;
  }
}

export type InitCutPackageOptions = {
  name: string;
  version?: string;
  entry?: string;
  capabilities?: CutPackageCapability[];
  exports?: Record<string, CutPackageExport>;
  createEntry?: boolean;
};

export async function initCutPackage(directory: string, options: InitCutPackageOptions) {
  const root = resolve(directory), version = options.version ?? "0.1.0", entry = validateCutPackageFileLocator(options.entry ?? "index.cut", "$.entry");
  parseCutSemVer(version, "$.version");
  await mkdir(root, { recursive: true });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) packageFail("CUT_PACKAGE_PATH", root, "must be a regular directory, not a symbolic link.");
  const manifestPath = resolve(root, cutPackageManifestFile);
  if (await lstat(manifestPath).catch(() => undefined)) packageFail("CUT_PACKAGE_EXISTS", cutPackageManifestFile, "already exists.");
  const entryPath = resolve(root, ...entry.split("/")), entryMetadata = await lstat(entryPath).catch(() => undefined);
  if (!entryMetadata) {
    if (options.createEntry === false) packageFail("CUT_PACKAGE_FILE", entry, "does not exist and createEntry is false.");
    await mkdir(dirname(entryPath), { recursive: true });
    await atomicWrite(entryPath, `cut 0.4;\nproject ${JSON.stringify(options.name)};\n`);
  } else if (entryMetadata.isSymbolicLink() || !entryMetadata.isFile()) packageFail("CUT_PACKAGE_FILE", entry, "must be a regular, non-symlink file.");
  const manifest = validateCutPackageManifest({
    format: "cut-package",
    manifestVersion: 1,
    name: options.name,
    version,
    language: "0.4",
    entry,
    capabilities: options.capabilities ?? [],
    dependencies: {},
    exports: options.exports ?? {},
    integrity: { algorithm: "sha256", files: { [entry]: sha256(await packageFileBytes(root, entry)) } },
  });
  const lock = await commitManifestAndLock(root, manifest, undefined, undefined, true);
  return { root, manifest, lock };
}

async function normalizeSource(projectRoot: string, packageRoot: string) {
  const local = relative(await realpath(projectRoot), await realpath(packageRoot)).split(sep).join("/");
  if (!local) packageFail("CUT_PACKAGE_CYCLE", "$.source", "cannot add the project package as its own dependency.");
  return validateCutPackageSource(`file:${local}`, "$.source");
}

async function updatedRootManifest(projectRoot: string, current: CutPackageManifest, dependencies: Record<string, CutPackageDependency>) {
  return refreshCutPackageManifestIntegrity(projectRoot, validateCutPackageManifest({ ...current, dependencies }));
}

export async function addCutPackageDependency(projectDirectory: string, sourceValue: string, options: { exact?: boolean; limits?: Partial<CutPackageResolutionLimits> } = {}) {
  const projectRoot = resolve(projectDirectory), source = validateCutPackageSource(sourceValue.startsWith("file:") ? sourceValue : `file:${sourceValue}`, "$.source");
  const targetRoot = await resolveDirectCutPackageSource(projectRoot, source), target = await readResolvedCutPackage(targetRoot, source, { limits: options.limits });
  const current = await readCutPackageManifestFile(projectRoot);
  if (target.manifest.name === current.name) packageFail("CUT_PACKAGE_CYCLE", "$.source", "cannot add the project package as its own dependency.");
  const dependency: CutPackageDependency = { source: await normalizeSource(projectRoot, target.root), version: options.exact ? target.manifest.version : defaultCutSemVerRange(target.manifest.version), integrity: target.contentIntegrity };
  const manifest = await updatedRootManifest(projectRoot, current, { ...current.dependencies, [target.manifest.name]: dependency });
  const lock = await commitManifestAndLock(projectRoot, manifest, options.limits, cutPackageManifestIntegrity(current));
  return { dependency: target.manifest.name, manifest, lock };
}

export async function removeCutPackageDependency(projectDirectory: string, name: string, options: { limits?: Partial<CutPackageResolutionLimits> } = {}) {
  const projectRoot = resolve(projectDirectory), current = await readCutPackageManifestFile(projectRoot);
  if (!Object.hasOwn(current.dependencies, name)) packageFail("CUT_PACKAGE_NOT_DIRECT", `$.dependencies[${JSON.stringify(name)}]`, "is not a direct dependency.");
  const dependencies = { ...current.dependencies }; delete dependencies[name];
  const manifest = await updatedRootManifest(projectRoot, current, dependencies), lock = await commitManifestAndLock(projectRoot, manifest, options.limits, cutPackageManifestIntegrity(current));
  return { dependency: name, manifest, lock };
}

export async function updateCutPackageDependencies(projectDirectory: string, names?: string[], options: { exact?: boolean; limits?: Partial<CutPackageResolutionLimits> } = {}) {
  const projectRoot = resolve(projectDirectory), current = await readCutPackageManifestFile(projectRoot), requested = names?.length ? [...new Set(names)].sort() : Object.keys(current.dependencies).sort();
  for (const name of requested) if (!Object.hasOwn(current.dependencies, name)) packageFail("CUT_PACKAGE_NOT_DIRECT", `$.dependencies[${JSON.stringify(name)}]`, "is not a direct dependency.");
  const dependencies = { ...current.dependencies };
  for (const name of requested) {
    const declaration = dependencies[name], targetRoot = await resolveDirectCutPackageSource(projectRoot, declaration.source), target = await readResolvedCutPackage(targetRoot, declaration.source, { limits: options.limits });
    if (target.manifest.name !== name) packageFail("CUT_PACKAGE_NAME_MISMATCH", `$.dependencies[${JSON.stringify(name)}]`, `source is package ${JSON.stringify(target.manifest.name)}.`);
    dependencies[name] = { ...declaration, version: options.exact ? target.manifest.version : defaultCutSemVerRange(target.manifest.version), integrity: target.contentIntegrity };
  }
  const manifest = await updatedRootManifest(projectRoot, current, dependencies), lock = await commitManifestAndLock(projectRoot, manifest, options.limits, cutPackageManifestIntegrity(current));
  return { updated: requested, manifest, lock };
}

export type ListedCutPackage = {
  name: string;
  version: string;
  source: string;
  integrity: string;
  direct: boolean;
  capabilities: CutPackageCapability[];
};

export async function listCutPackageDependencies(projectDirectory: string, options: { limits?: Partial<CutPackageResolutionLimits> } = {}): Promise<{ project: string; lock: CutPackageLock; packages: ListedCutPackage[] }> {
  const graph = await resolveCutPackageGraph(resolve(projectDirectory), { limits: options.limits }), direct = new Set(Object.keys(graph.root.manifest.dependencies));
  return {
    project: graph.root.manifest.name,
    lock: graph.lock,
    packages: graph.lock.packages.map((item) => ({ name: item.name, version: item.version, source: item.source, integrity: item.contentIntegrity, direct: direct.has(item.name), capabilities: item.capabilities })),
  };
}

export async function regenerateCutPackageLock(projectDirectory: string, options: { limits?: Partial<CutPackageResolutionLimits> } = {}) {
  const projectRoot = resolve(projectDirectory), current = await readCutPackageManifestFile(projectRoot);
  const refreshed = await refreshCutPackageManifestIntegrity(projectRoot, current);
  return commitManifestAndLock(projectRoot, refreshed, options.limits, cutPackageManifestIntegrity(current));
}

export function formatCutPackageList(result: Awaited<ReturnType<typeof listCutPackageDependencies>>) {
  if (!result.packages.length) return `${result.project}: no packages`;
  return result.packages.map((item) => `${item.direct ? "direct" : "transitive"}\t${item.name}@${item.version}\t${item.source}\t${item.integrity}`).join("\n");
}

export function cutPackageOperationIdentity(manifest: CutPackageManifest, lock: CutPackageLock) {
  return createHash("sha256").update(stableJsonStringify({ manifest, lock })).digest("hex");
}
