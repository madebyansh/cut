import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { hash } from "../core/stable";
import {
  createReferenceDependencyIdentity,
  referenceDependencyIdentity,
  referenceDependencyNames,
  type ReferenceDependencyIdentity,
  type ReferenceDependencyName,
} from "./dependency-identity";

const closureFileName = "builtin-implementation-closure.json";
const closureFormat = "cut-builtin-implementation-closure";
const closureVersion = 1;
const implementationFormat = "cut-builtin-package-implementation";
const implementationVersion = 1;
const maximumClosureBytes = 1024 * 1024;
const maximumPackages = 64;
const maximumFilesPerPackage = 512;
const maximumFileBytes = 8 * 1024 * 1024;
const maximumTotalBytes = 64 * 1024 * 1024;
const maximumStringBytes = 1024;
const moduleIdPattern = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.json)?$/u;
const expectedPackages = [
  "@cut/audio",
  "@cut/data",
  "@cut/diagram",
  "@cut/documentary",
  "@cut/edit",
  "@cut/geo",
  "@cut/motion",
  "cut:core",
  "cut:visual",
] as const;
const utf8 = new TextDecoder("utf-8", { fatal: true });
let baselineClosure: CutBuiltinImplementationClosure | undefined;
const baselineFiles = new Map<string, Readonly<{ id: string; size: number; sha256: string }>>();

export type CutBuiltinPackageSpecifier = typeof expectedPackages[number];

export type CutBuiltinImplementationClosure = Readonly<{
  format: typeof closureFormat;
  version: typeof closureVersion;
  packages: Readonly<Record<CutBuiltinPackageSpecifier, readonly string[]>>;
}>;

export type CutBuiltinImplementationIdentity = Readonly<{
  format: typeof implementationFormat;
  version: typeof implementationVersion;
  package: CutBuiltinPackageSpecifier;
  environment: "source-ts" | "packed-js";
  dependencies: ReferenceDependencyIdentity;
  files: ReadonlyArray<Readonly<{ id: string; size: number; sha256: string }>>;
  integrity: string;
}>;

export type CutBuiltinImplementationIdentityOptions = Readonly<{
  /** Test/pack verifier override; production callers use the module-adjacent lib root. */
  libRoot?: string;
  /** Test/pack verifier override; production callers use the committed module-adjacent manifest. */
  closurePath?: string;
  /** Test/pack verifier override for an unpacked source tree or packed compiled tree. */
  implementationExtension?: ".ts" | ".js";
  dependencies?: ReferenceDependencyIdentity;
  sourceOverrides?: ReadonlyMap<string, string | Buffer>;
}>;

export type CutBuiltinImplementationIdentityErrorCode =
  | "CUT_IMPLEMENTATION_CLOSURE_FILE"
  | "CUT_IMPLEMENTATION_CLOSURE_JSON"
  | "CUT_IMPLEMENTATION_CLOSURE_SHAPE"
  | "CUT_IMPLEMENTATION_CLOSURE_VERSION"
  | "CUT_IMPLEMENTATION_PACKAGE_UNKNOWN"
  | "CUT_IMPLEMENTATION_MODULE_ID"
  | "CUT_IMPLEMENTATION_PATH_ESCAPE"
  | "CUT_IMPLEMENTATION_FILE_MISSING"
  | "CUT_IMPLEMENTATION_FILE_BOUNDS"
  | "CUT_IMPLEMENTATION_FILE_CHANGED"
  | "CUT_IMPLEMENTATION_DEPENDENCY_IDENTITY"
  | "CUT_IMPLEMENTATION_OVERRIDE_UNKNOWN";

export class CutBuiltinImplementationIdentityError extends Error {
  constructor(readonly code: CutBuiltinImplementationIdentityErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CutBuiltinImplementationIdentityError";
  }
}

function fail(code: CutBuiltinImplementationIdentityErrorCode, message: string): never {
  throw new CutBuiltinImplementationIdentityError(code, message);
}

function ownObject(value: unknown, path: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("CUT_IMPLEMENTATION_CLOSURE_SHAPE", `${path} must be a plain JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, path: string, required: readonly string[]) {
  const object = ownObject(value, path), keys = Object.keys(object).sort(), expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("CUT_IMPLEMENTATION_CLOSURE_SHAPE", `${path} must contain exactly: ${expected.join(", ")}.`);
  }
  return object;
}

function boundedString(value: unknown, path: string) {
  if (typeof value !== "string" || !value.length || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumStringBytes) {
    fail("CUT_IMPLEMENTATION_CLOSURE_SHAPE", `${path} must be a non-empty string no larger than ${maximumStringBytes} UTF-8 bytes and contain no NUL.`);
  }
  return value;
}

function canonicalModuleId(value: unknown, path: string) {
  const id = boundedString(value, path);
  if (!moduleIdPattern.test(id)
    || id.includes("\\")
    || isAbsolute(id)
    || id.split("/").some((part) => part === "." || part === "..")
    || [".ts", ".tsx", ".js", ".mjs", ".cjs"].some((extension) => id.endsWith(extension))) {
    fail("CUT_IMPLEMENTATION_MODULE_ID", `${path} is not a canonical lib-root-relative module ID.`);
  }
  return id;
}

function stableRead(path: string, maximumBytes: number, label: string) {
  let beforePath;
  try { beforePath = lstatSync(path); }
  catch { fail("CUT_IMPLEMENTATION_FILE_MISSING", `${label} is missing or unreadable.`); }
  if (beforePath.isSymbolicLink()) fail("CUT_IMPLEMENTATION_PATH_ESCAPE", `${label} cannot be a symbolic link.`);
  if (!beforePath.isFile() || beforePath.size <= 0 || beforePath.size > maximumBytes) {
    fail("CUT_IMPLEMENTATION_FILE_BOUNDS", `${label} must be a non-empty regular file no larger than ${maximumBytes} bytes.`);
  }
  let descriptor: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    try { descriptor = openSync(path, constants.O_RDONLY | noFollow); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") fail("CUT_IMPLEMENTATION_PATH_ESCAPE", `${label} cannot resolve through a symbolic link.`);
      fail("CUT_IMPLEMENTATION_FILE_MISSING", `${label} is unreadable.`);
    }
    const before = fstatSync(descriptor);
    if (!before.isFile()
      || before.dev !== beforePath.dev
      || before.ino !== beforePath.ino
      || before.size !== beforePath.size
      || before.mtimeMs !== beforePath.mtimeMs
      || before.ctimeMs !== beforePath.ctimeMs) {
      fail("CUT_IMPLEMENTATION_FILE_CHANGED", `${label} changed before its stable read began.`);
    }
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor);
    let afterPath;
    try { afterPath = lstatSync(path); }
    catch { fail("CUT_IMPLEMENTATION_FILE_CHANGED", `${label} disappeared while its bytes were read.`); }
    if (bytes.byteLength !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.dev !== afterPath.dev
      || after.ino !== afterPath.ino
      || after.size !== afterPath.size
      || after.mtimeMs !== afterPath.mtimeMs
      || after.ctimeMs !== afterPath.ctimeMs) {
      fail("CUT_IMPLEMENTATION_FILE_CHANGED", `${label} changed while its bytes were read.`);
    }
    return bytes;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function parseClosure(bytes: Buffer): CutBuiltinImplementationClosure {
  let parsed: unknown;
  try { parsed = JSON.parse(utf8.decode(bytes)); }
  catch { fail("CUT_IMPLEMENTATION_CLOSURE_JSON", `${closureFileName} must contain valid UTF-8 JSON.`); }
  const root = exactObject(parsed, "$", ["format", "version", "packages"]);
  if (root.format !== closureFormat || root.version !== closureVersion) {
    fail("CUT_IMPLEMENTATION_CLOSURE_VERSION", `${closureFileName} must use ${closureFormat} v${closureVersion}.`);
  }
  const packages = ownObject(root.packages, "$.packages"), names = Object.keys(packages);
  if (names.length > maximumPackages) fail("CUT_IMPLEMENTATION_CLOSURE_SHAPE", `$.packages exceeds ${maximumPackages} entries.`);
  if (names.length !== expectedPackages.length || names.some((name, index) => name !== expectedPackages[index])) {
    fail("CUT_IMPLEMENTATION_CLOSURE_SHAPE", `$.packages must contain exactly these sorted built-ins: ${expectedPackages.join(", ")}.`);
  }
  const normalized = {} as Record<CutBuiltinPackageSpecifier, readonly string[]>;
  for (const name of expectedPackages) {
    const values = packages[name];
    if (!Array.isArray(values) || !values.length || values.length > maximumFilesPerPackage) {
      fail("CUT_IMPLEMENTATION_CLOSURE_SHAPE", `$.packages[${JSON.stringify(name)}] must contain 1..${maximumFilesPerPackage} module IDs.`);
    }
    const ids = values.map((value, index) => canonicalModuleId(value, `$.packages[${JSON.stringify(name)}][${index}]`));
    if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) {
      fail("CUT_IMPLEMENTATION_CLOSURE_SHAPE", `$.packages[${JSON.stringify(name)}] must be strictly sorted without duplicates.`);
    }
    normalized[name] = Object.freeze(ids);
  }
  return Object.freeze({ format: closureFormat, version: closureVersion, packages: Object.freeze(normalized) });
}

function inside(root: string, path: string) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function canonicalRoot(path: string) {
  let root;
  try { root = realpathSync(path); }
  catch { fail("CUT_IMPLEMENTATION_FILE_MISSING", "implementation lib root is missing or unreadable."); }
  let metadata;
  try { metadata = lstatSync(root); }
  catch { fail("CUT_IMPLEMENTATION_FILE_MISSING", "implementation lib root is missing or unreadable."); }
  if (!metadata.isDirectory()) fail("CUT_IMPLEMENTATION_PATH_ESCAPE", "implementation lib root must resolve to a directory.");
  return root;
}

function implementationPath(libRoot: string, id: string, extension: ".ts" | ".js") {
  const lexical = resolve(libRoot, id.endsWith(".json") ? id : `${id}${extension}`);
  if (!inside(libRoot, lexical)) fail("CUT_IMPLEMENTATION_PATH_ESCAPE", `implementation module ${JSON.stringify(id)} escapes the lib root.`);
  let canonical;
  try { canonical = realpathSync(lexical); }
  catch { fail("CUT_IMPLEMENTATION_FILE_MISSING", `implementation module ${JSON.stringify(id)} is missing for ${extension}.`); }
  if (canonical !== lexical || !inside(libRoot, canonical)) {
    fail("CUT_IMPLEMENTATION_PATH_ESCAPE", `implementation module ${JSON.stringify(id)} resolves through a link or outside the lib root.`);
  }
  return lexical;
}

function validDependencies(value: ReferenceDependencyIdentity) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("CUT_IMPLEMENTATION_DEPENDENCY_IDENTITY", "reference dependency identity must be a plain closed object.");
  }
  const object = value as unknown as Record<string, unknown>, keys = Object.keys(object).sort();
  if (keys.length !== 4 || keys.join(",") !== "format,integrity,packages,version"
    || object.format !== "cut-reference-dependencies"
    || object.version !== 1
    || !Array.isArray(object.packages)
    || typeof object.integrity !== "string") {
    fail("CUT_IMPLEMENTATION_DEPENDENCY_IDENTITY", "reference dependency identity has an invalid closed shape.");
  }
  if (object.packages.length !== referenceDependencyNames.length) {
    fail("CUT_IMPLEMENTATION_DEPENDENCY_IDENTITY", "reference dependency identity has an incomplete package set.");
  }
  const versions = {} as Record<ReferenceDependencyName, string>;
  for (const [index, expectedName] of referenceDependencyNames.entries()) {
    const entry = object.packages[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype) {
      fail("CUT_IMPLEMENTATION_DEPENDENCY_IDENTITY", `reference dependency entry ${index} must be a plain object.`);
    }
    const record = entry as Record<string, unknown>, entryKeys = Object.keys(record).sort();
    if (entryKeys.length !== 2 || entryKeys.join(",") !== "name,version" || record.name !== expectedName || typeof record.version !== "string") {
      fail("CUT_IMPLEMENTATION_DEPENDENCY_IDENTITY", `reference dependency entry ${index} must be the canonical ${expectedName} name/version pair.`);
    }
    versions[expectedName] = record.version;
  }
  let canonical: ReferenceDependencyIdentity;
  try { canonical = createReferenceDependencyIdentity(versions); }
  catch { fail("CUT_IMPLEMENTATION_DEPENDENCY_IDENTITY", "reference dependency versions are not canonical bounded tokens."); }
  if (object.integrity !== canonical.integrity) fail("CUT_IMPLEMENTATION_DEPENDENCY_IDENTITY", "reference dependency identity integrity is invalid.");
  return canonical;
}

/** Strictly read and validate the committed closure manifest without importing any member modules. */
export function readCutBuiltinImplementationClosure(options: Pick<CutBuiltinImplementationIdentityOptions, "libRoot" | "closurePath"> = {}) {
  const useBaseline = options.libRoot === undefined && options.closurePath === undefined;
  if (useBaseline && baselineClosure) return baselineClosure;
  const libRoot = canonicalRoot(options.libRoot ?? resolve(dirname(__dirname)));
  const closurePath = options.closurePath ?? resolve(libRoot, "language", closureFileName);
  const lexicalClosure = resolve(closurePath);
  let canonicalClosure;
  try { canonicalClosure = realpathSync(lexicalClosure); }
  catch { fail("CUT_IMPLEMENTATION_CLOSURE_FILE", `${closureFileName} is missing or unreadable.`); }
  // `/var` and `/private/var` name the same tree on macOS. Containment is
  // therefore decided only after both the configured lib root and target are
  // canonical, while stableRead still refuses a final symlink or changed file.
  if (!inside(libRoot, canonicalClosure)) fail("CUT_IMPLEMENTATION_PATH_ESCAPE", `${closureFileName} must remain inside the implementation lib root.`);
  const parsed = parseClosure(stableRead(canonicalClosure, maximumClosureBytes, closureFileName));
  if (useBaseline) baselineClosure = parsed;
  return parsed;
}

/**
 * Fingerprint one built-in package's complete generated local implementation closure.
 * Files are read and hashed as data only; no closure member is imported or evaluated.
 */
export function createCutBuiltinImplementationIdentity(
  specifier: CutBuiltinPackageSpecifier,
  options: CutBuiltinImplementationIdentityOptions = {},
): CutBuiltinImplementationIdentity {
  const useBaseline = options.libRoot === undefined
    && options.closurePath === undefined
    && options.implementationExtension === undefined
    && options.dependencies === undefined
    && options.sourceOverrides === undefined;
  const libRoot = canonicalRoot(options.libRoot ?? resolve(dirname(__dirname))), closure = readCutBuiltinImplementationClosure(options);
  if (!expectedPackages.includes(specifier)) fail("CUT_IMPLEMENTATION_PACKAGE_UNKNOWN", `unknown built-in package ${JSON.stringify(specifier)}.`);
  const extension = options.implementationExtension ?? (__filename.endsWith(".ts") ? ".ts" : ".js");
  if (extension !== ".ts" && extension !== ".js") fail("CUT_IMPLEMENTATION_FILE_BOUNDS", "implementation extension must be exactly .ts or .js.");
  const ids = closure.packages[specifier], overrides = options.sourceOverrides ?? new Map(), unknownOverrides = [...overrides.keys()].filter((id) => !ids.includes(id));
  if (unknownOverrides.length) fail("CUT_IMPLEMENTATION_OVERRIDE_UNKNOWN", `source override(s) are not members of ${specifier}: ${unknownOverrides.sort().join(", ")}.`);
  const files: Array<{ id: string; size: number; sha256: string }> = [];
  let totalBytes = 0;
  for (const id of ids) {
    let file = useBaseline ? baselineFiles.get(id) : undefined;
    if (!file) {
      const path = implementationPath(libRoot, id, extension), override = overrides.get(id);
      const bytes = override === undefined ? stableRead(path, maximumFileBytes, `implementation module ${JSON.stringify(id)}`)
        : Buffer.isBuffer(override) ? override : Buffer.from(String(override), "utf8");
      if (bytes.byteLength <= 0 || bytes.byteLength > maximumFileBytes) {
        fail("CUT_IMPLEMENTATION_FILE_BOUNDS", `implementation module ${JSON.stringify(id)} must contain 1..${maximumFileBytes} bytes.`);
      }
      file = Object.freeze({ id, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
      if (useBaseline) baselineFiles.set(id, file);
    }
    totalBytes += file.size;
    if (totalBytes > maximumTotalBytes) fail("CUT_IMPLEMENTATION_FILE_BOUNDS", `${specifier} implementation exceeds ${maximumTotalBytes} bytes.`);
    files.push(file);
  }
  const dependencies = validDependencies(options.dependencies ?? referenceDependencyIdentity);
  const content: Omit<CutBuiltinImplementationIdentity, "integrity"> = {
    format: implementationFormat,
    version: implementationVersion,
    package: specifier,
    environment: (extension === ".ts" ? "source-ts" : "packed-js") as "source-ts" | "packed-js",
    dependencies,
    files,
  };
  return Object.freeze({ ...content, files: Object.freeze(files.map((file) => Object.freeze(file))), integrity: hash(content) });
}
