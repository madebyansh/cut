import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { parseStrictPackageJson } from "../package/json";
import { cutDoctorNodeVersionCheck } from "../system/doctor";
import { CutFootageError, footageFail } from "./diagnostics";
import {
  startCutFootageSidecar,
  type CutFootageSidecarHandshake,
  type CutFootageSidecarSession,
} from "./sidecar";

export const cutFootageLocalDirectoryName = "local-clip-v1";
export const cutFootageNodeCompatibility = ">=20.19.0 <21 || >=24.0.0 <25";

const manifestName = "install-manifest.json";
const recipeFiles = Object.freeze(["NOTICE.md", "local-clip-sidecar.mjs", "model.json", "package-lock.json", "package.json"]);
const shaPattern = /^[a-f0-9]{64}$/u;
const safeToken = /^[A-Za-z0-9][A-Za-z0-9._+@/-]{0,511}$/u;
const maximumRecipeFileBytes = 16 * 1024 * 1024;
const maximumManifestBytes = 4 * 1024 * 1024;
const maximumTreeFiles = 100_000;
const maximumTreeBytes = 2 * 1024 * 1024 * 1024;
const maximumTreeFileBytes = 512 * 1024 * 1024;
const maximumTreeDepth = 64;
const pinnedProvider = "huggingface-transformers-js";
const pinnedModel = "Xenova/clip-vit-base-patch32";
const pinnedRevision = "d15189d7028b43f1d3e65039190477f6af591c2a";
const pinnedSelfTestSha256 = "ba7503358ab88be43b6e50d5d8a0f5367e22241208d832248ccb32209372aae7";
const pinnedModelFiles = Object.freeze([
  Object.freeze({ locator: "config.json", role: "config", bytes: 4_524, sha256: "493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495" }),
  Object.freeze({ locator: "onnx/text_model_quantized.onnx", role: "text-model", bytes: 64_504_507, sha256: "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a" }),
  Object.freeze({ locator: "onnx/vision_model_quantized.onnx", role: "vision-model", bytes: 89_117_001, sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299" }),
  Object.freeze({ locator: "preprocessor_config.json", role: "preprocessor", bytes: 520, sha256: "6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f" }),
  Object.freeze({ locator: "tokenizer.json", role: "tokenizer", bytes: 2_224_119, sha256: "f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd" }),
  Object.freeze({ locator: "tokenizer_config.json", role: "tokenizer-config", bytes: 775, sha256: "60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967" }),
]);
const payloadPattern = /^\.local-clip-v1\.payload-[1-9][0-9]*-[a-f0-9-]{36}$/u;

export type ResolveCutFootageHomeOptions = Readonly<{
  explicitHome?: string;
  homeDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}>;

export type CutFootageTreeIdentity = Readonly<{
  bytes: number;
  fileCount: number;
  sha256: string;
}>;

export type CutFootageLocalModelFile = Readonly<{
  locator: string;
  role: string;
  bytes: number;
  sha256: string;
}>;

export type CutFootageLocalModel = Readonly<{
  format: "cut-footage-local-model";
  version: 1;
  provider: string;
  model: string;
  revision: string;
  dtype: "q8";
  device: "cpu";
  dimensions: number;
  selfTestSha256: string;
  files: readonly CutFootageLocalModelFile[];
}>;

export type CutFootageLocalInstallManifest = Readonly<{
  format: "cut-footage-local-install";
  version: 1;
  backend: "local";
  platform: NodeJS.Platform;
  architecture: string;
  nodeCompatibility: typeof cutFootageNodeCompatibility;
  setupNodeVersion: string;
  model: CutFootageLocalModel;
  adapterSha256: string;
  recipeTree: CutFootageTreeIdentity;
  runtimeTree: CutFootageTreeIdentity;
  modelTree: CutFootageTreeIdentity;
  installationTree: CutFootageTreeIdentity;
  handshake: CutFootageSidecarHandshake;
  identitySha256: string;
}>;

export type CutFootageLocalInstall = Readonly<{
  root: string;
  modelRevisionRoot: string;
  sidecarPath: string;
  manifest: CutFootageLocalInstallManifest;
}>;

export type CutFootageLocalSidecarLaunch = Readonly<{
  mode: "setup" | "offline";
  executable: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  installationRoot: string;
  modelRevisionRoot: string;
  expectedHandshake: CutFootageSidecarHandshake;
}>;

export type CutFootageLocalInstallRuntimeRequest = Readonly<{
  stagingRoot: string;
  npmExecutable: string;
  npmCacheRoot: string;
  environment: Readonly<Record<string, string>>;
}>;

export type CutFootageLocalOperations = Readonly<{
  installRuntime(request: CutFootageLocalInstallRuntimeRequest): Promise<void>;
  startSidecar(launch: CutFootageLocalSidecarLaunch): Promise<CutFootageSidecarSession>;
  /** @internal Deterministic create-only publication race seam. */
  beforePublish?(request: Readonly<{ stagingRoot: string; target: string }>): Promise<void>;
}>;

export type CutFootageLocalSetupOptions = Readonly<{
  backend: string;
  home?: string;
  homeDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  recipeRoot?: string;
  npmExecutable?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  nodeVersion?: string;
  operations?: CutFootageLocalOperations;
}>;

export type CutFootageLocalInspectOptions = Readonly<{
  home?: string;
  homeDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  architecture?: string;
  nodeVersion?: string;
}>;

export type CutFootageLocalStartOptions = CutFootageLocalInspectOptions & Readonly<{
  operations?: CutFootageLocalOperations;
}>;

export type CutFootageLocalSetupReport = Readonly<{
  format: "cut-footage-local-setup-report";
  version: 1;
  status: "installed" | "ready";
  backend: "local";
  identity: ReturnType<typeof cutFootageBackendIdentityFromInstall>;
}>;

type TreeEntry = Readonly<{
  locator: string;
  kind: "directory" | "file" | "symlink";
  bytes: number;
  sha256?: string;
  target?: string;
}>;
type EntrySnapshot = Readonly<{ dev: number | bigint; ino: number | bigint }>;

function systemErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function unsafeHome(): never {
  return footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$footageHome", "must be one canonical absolute non-root directory.");
}

function publishFailure(message: string): never {
  return footageFail("CUT_FOOTAGE_PUBLISH", "$installation", message);
}

function mismatch(message = "the immutable local footage backend does not match its verified identity."): never {
  return footageFail("CUT_FOOTAGE_MODEL_MISMATCH", "$installation", message);
}

function missing(): never {
  return footageFail("CUT_FOOTAGE_BACKEND_MISSING", "$installation", "the local footage backend is not installed.");
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inside(root: string, candidate: string) {
  const local = relative(root, candidate);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const observed = Object.keys(value).sort(compareText), expected = [...keys].sort(compareText);
  return observed.length === expected.length && observed.every((key, index) => key === expected[index]);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) mismatch();
  const result = value as Record<string, unknown>;
  if (!exactKeys(result, keys)) mismatch();
  return result;
}

function text(value: unknown, maximum = 512) {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value)) mismatch();
  return value;
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) mismatch();
  return Number(value);
}

function sha(value: unknown) {
  if (typeof value !== "string" || !shaPattern.test(value)) mismatch();
  return value;
}

function locator(value: unknown) {
  const result = text(value, 16_384);
  if (isAbsolute(result) || result.includes("\\") || result.split("/").some((part) => !part || part === "." || part === "..")) mismatch();
  return result;
}

function safeModelPathPart(value: unknown) {
  const result = text(value);
  if (!safeToken.test(result) || result.startsWith("/") || result.includes("//") || result.split("/").some((part) => !part || part === "." || part === "..")) mismatch();
  return result;
}

function safeModelSegment(value: unknown) {
  const result = safeModelPathPart(value);
  if (result.includes("/")) mismatch();
  return result;
}

function same(left: unknown, right: unknown) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Resolves only CUT-owned footage storage; project and model paths never enter diagnostics. */
export function resolveCutFootageHome(options: ResolveCutFootageHomeOptions = {}): string {
  const explicit = options.explicitHome ?? (options.environment ?? process.env).CUT_FOOTAGE_HOME;
  const base = explicit ?? join(options.homeDirectory ?? homedir(), ".cut", "footage");
  if (typeof base !== "string" || !base.length || Buffer.byteLength(base, "utf8") > 16_384 || !isAbsolute(base)
    || normalize(base) !== base || parse(base).root === base || /[\u0000-\u001f\u007f]/u.test(base)) unsafeHome();
  return base;
}

function platformIdentity(options: CutFootageLocalInspectOptions) {
  const platform = options.platform ?? process.platform, architecture = options.architecture ?? process.arch, nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!((platform === "darwin" && architecture === "arm64") || (platform === "linux" && (architecture === "x64" || architecture === "arm64")))) mismatch("the local footage backend is unsupported on this platform and architecture.");
  if (cutDoctorNodeVersionCheck(nodeVersion).status !== "pass") mismatch("the local footage backend is unsupported on this Node.js version.");
  return Object.freeze({ platform, architecture, nodeVersion });
}

async function readBoundedRegular(path: string, maximumBytes: number) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) mismatch();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.byteLength !== before.size) mismatch();
    return bytes;
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    mismatch();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hashRegular(path: string) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximumTreeFileBytes) mismatch();
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position);
      if (!bytesRead) mismatch();
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) mismatch();
    return Object.freeze({ bytes: before.size, sha256: digest.digest("hex") });
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    mismatch();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function treeEntries(root: string, excluded = new Set<string>()) {
  let rootMetadata;
  try { rootMetadata = await lstat(root); } catch { mismatch(); }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) mismatch();
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(root); } catch { mismatch(); }
  const entries: TreeEntry[] = [];
  let totalBytes = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > maximumTreeDepth) mismatch();
    let names: string[];
    try { names = (await readdir(directory)).sort(compareText); } catch { mismatch(); }
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || /[\u0000-\u001f\u007f]/u.test(name)) mismatch();
      const local = prefix ? `${prefix}/${name}` : name;
      if (excluded.has(local)) continue;
      const physical = join(directory, name);
      let metadata;
      try { metadata = await lstat(physical); } catch { mismatch(); }
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (entries.length >= maximumTreeFiles) mismatch();
        entries.push(Object.freeze({ locator: local, kind: "directory", bytes: 0 }));
        await walk(physical, local, depth + 1);
        continue;
      }
      if (entries.length >= maximumTreeFiles) mismatch();
      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        const identity = await hashRegular(physical);
        totalBytes += identity.bytes;
        if (totalBytes > maximumTreeBytes) mismatch();
        entries.push(Object.freeze({ locator: local, kind: "file", bytes: identity.bytes, sha256: identity.sha256 }));
        continue;
      }
      if (metadata.isSymbolicLink()) {
        let target: string, resolvedTarget: string, physicalTarget: string;
        try {
          target = await readlink(physical);
          if (!target || isAbsolute(target) || Buffer.byteLength(target, "utf8") > 16_384 || /[\u0000-\u001f\u007f]/u.test(target)) mismatch();
          resolvedTarget = resolve(dirname(physical), target);
          if (!inside(root, resolvedTarget)) mismatch();
          physicalTarget = await realpath(resolvedTarget);
          if (!inside(canonicalRoot, physicalTarget) || !(await stat(physicalTarget)).isFile()) mismatch();
        } catch (error) {
          if (error instanceof CutFootageError) throw error;
          mismatch();
        }
        const bytes = Buffer.byteLength(target, "utf8");
        totalBytes += bytes;
        if (totalBytes > maximumTreeBytes) mismatch();
        entries.push(Object.freeze({ locator: local, kind: "symlink", bytes, target }));
        continue;
      }
      mismatch();
    }
  };
  await walk(root, "", 0);
  if (!entries.length) mismatch();
  return Object.freeze(entries);
}

function identityFromEntries(entries: readonly TreeEntry[]): CutFootageTreeIdentity {
  return Object.freeze({
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    fileCount: entries.filter((entry) => entry.kind !== "directory").length,
    sha256: createHash("sha256").update(stableJsonStringify(entries)).digest("hex"),
  });
}

async function treeIdentity(root: string, excluded?: ReadonlySet<string>) {
  return identityFromEntries(await treeEntries(root, new Set(excluded)));
}

async function selectedFileIdentity(root: string, names: readonly string[]) {
  const entries: TreeEntry[] = [];
  for (const name of [...names].sort(compareText)) {
    const identity = await hashRegular(join(root, name));
    entries.push(Object.freeze({ locator: name, kind: "file", bytes: identity.bytes, sha256: identity.sha256 }));
  }
  return identityFromEntries(Object.freeze(entries));
}

function parseModel(input: string | Uint8Array): CutFootageLocalModel {
  let parsed: unknown;
  try { parsed = parseStrictPackageJson(input, { limits: { maxInputBytes: 1024 * 1024, maxDepth: 12, maxNodes: 10_000 } }); }
  catch { mismatch("the local footage model recipe is invalid."); }
  const root = record(parsed, ["format", "version", "provider", "model", "revision", "dtype", "device", "dimensions", "selfTestSha256", "files"]);
  if (root.format !== "cut-footage-local-model" || root.version !== 1 || root.dtype !== "q8" || root.device !== "cpu" || !Array.isArray(root.files) || !root.files.length || root.files.length > 1_024) mismatch("the local footage model recipe is invalid.");
  const seen = new Set<string>();
  const files = root.files.map((value) => {
    const item = record(value, ["locator", "role", "bytes", "sha256"]), local = locator(item.locator);
    if (seen.has(local)) mismatch("the local footage model recipe is invalid.");
    seen.add(local);
    return Object.freeze({ locator: local, role: text(item.role, 128), bytes: positive(item.bytes, maximumTreeFileBytes), sha256: sha(item.sha256) });
  }).sort((left, right) => compareText(left.locator, right.locator));
  return deepFreeze({
    format: "cut-footage-local-model" as const,
    version: 1 as const,
    provider: safeModelPathPart(root.provider),
    model: safeModelPathPart(root.model),
    revision: safeModelSegment(root.revision),
    dtype: "q8" as const,
    device: "cpu" as const,
    dimensions: positive(root.dimensions, 65_536),
    selfTestSha256: sha(root.selfTestSha256),
    files: Object.freeze(files),
  });
}

function requirePinnedModel(model: CutFootageLocalModel) {
  if (model.provider !== pinnedProvider || model.model !== pinnedModel || model.revision !== pinnedRevision
    || model.dtype !== "q8" || model.device !== "cpu" || model.dimensions !== 512
    || model.selfTestSha256 !== pinnedSelfTestSha256 || !same(model.files, pinnedModelFiles)) {
    mismatch("the bundled local footage model recipe is not the pinned CLIP backend.");
  }
}

function modelRevisionPath(installationRoot: string, model: CutFootageLocalModel) {
  return join(installationRoot, "models", ...model.model.split("/"), model.revision);
}

function expectedHandshake(model: CutFootageLocalModel, adapterSha256: string): CutFootageSidecarHandshake {
  return deepFreeze({
    format: "cut-footage-sidecar-handshake" as const,
    version: 1 as const,
    protocolVersion: 1 as const,
    provider: model.provider,
    model: model.model,
    revision: model.revision,
    dimensions: model.dimensions,
    normalization: "l2" as const,
    modalities: Object.freeze(["image", "text"] as const),
    hardware: "cpu" as const,
    adapterSha256,
    selfTestSha256: model.selfTestSha256,
  });
}

function launchFor(root: string, model: CutFootageLocalModel, handshake: CutFootageSidecarHandshake, mode: "setup" | "offline"): CutFootageLocalSidecarLaunch {
  const modelRoot = modelRevisionPath(root, model), sidecarPath = join(root, "local-clip-sidecar.mjs");
  return deepFreeze({
    mode,
    executable: process.execPath,
    arguments: Object.freeze([sidecarPath, mode]),
    environment: mode === "setup"
      ? Object.freeze({ CUT_FOOTAGE_CACHE_DIR: join(root, "models"), CUT_FOOTAGE_MODEL_DIR: modelRoot })
      : Object.freeze({ CUT_FOOTAGE_MODEL_DIR: modelRoot }),
    installationRoot: root,
    modelRevisionRoot: modelRoot,
    expectedHandshake: handshake,
  });
}

const defaultOperations: CutFootageLocalOperations = Object.freeze({
  async installRuntime() {
    publishFailure("the locked local footage runtime installer is unavailable.");
  },
  async startSidecar(launch) {
    return startCutFootageSidecar({
      executable: launch.executable,
      arguments: launch.arguments,
      environment: launch.environment,
      expectedHandshake: launch.expectedHandshake,
    });
  },
});

async function verifySession(operations: CutFootageLocalOperations, launch: CutFootageLocalSidecarLaunch) {
  let session: CutFootageSidecarSession | undefined;
  try {
    session = await operations.startSidecar(launch);
    if (!same(session.handshake, launch.expectedHandshake)) mismatch();
    await session.close();
  } catch (error) {
    await session?.close().catch(() => undefined);
    if (error instanceof CutFootageError && error.code === "CUT_FOOTAGE_MODEL_MISMATCH") throw error;
    mismatch();
  }
}

async function verifyExpectedModelFiles(root: string, model: CutFootageLocalModel) {
  for (const expected of model.files) {
    const identity = await hashRegular(join(root, ...expected.locator.split("/")));
    if (identity.bytes !== expected.bytes || identity.sha256 !== expected.sha256) mismatch();
  }
}

function treeFromManifest(value: unknown) {
  const item = record(value, ["bytes", "fileCount", "sha256"]);
  return Object.freeze({ bytes: positive(item.bytes, maximumTreeBytes), fileCount: positive(item.fileCount, maximumTreeFiles), sha256: sha(item.sha256) });
}

function handshakeFromManifest(value: unknown): CutFootageSidecarHandshake {
  const item = record(value, ["format", "version", "protocolVersion", "provider", "model", "revision", "dimensions", "normalization", "modalities", "hardware", "adapterSha256", "selfTestSha256"]);
  if (item.format !== "cut-footage-sidecar-handshake" || item.version !== 1 || item.protocolVersion !== 1 || item.normalization !== "l2" || item.hardware !== "cpu"
    || !Array.isArray(item.modalities) || item.modalities.length !== 2 || item.modalities[0] !== "image" || item.modalities[1] !== "text") mismatch();
  return deepFreeze({
    format: "cut-footage-sidecar-handshake" as const,
    version: 1 as const,
    protocolVersion: 1 as const,
    provider: text(item.provider),
    model: text(item.model),
    revision: text(item.revision),
    dimensions: positive(item.dimensions, 65_536),
    normalization: "l2" as const,
    modalities: Object.freeze(["image", "text"] as const),
    hardware: "cpu" as const,
    adapterSha256: sha(item.adapterSha256),
    selfTestSha256: sha(item.selfTestSha256),
  });
}

function manifestBody(manifest: Omit<CutFootageLocalInstallManifest, "identitySha256">) {
  return stableJsonStringify(manifest);
}

function parseInstallManifest(input: string | Uint8Array): CutFootageLocalInstallManifest {
  let parsed: unknown;
  try { parsed = parseStrictPackageJson(input, { limits: { maxInputBytes: 1024 * 1024, maxDepth: 16, maxNodes: 100_000 } }); }
  catch { mismatch(); }
  const root = record(parsed, ["format", "version", "backend", "platform", "architecture", "nodeCompatibility", "setupNodeVersion", "model", "adapterSha256", "recipeTree", "runtimeTree", "modelTree", "installationTree", "handshake", "identitySha256"]);
  if (root.format !== "cut-footage-local-install" || root.version !== 1 || root.backend !== "local" || root.nodeCompatibility !== cutFootageNodeCompatibility) mismatch();
  const model = parseModel(Buffer.from(stableJsonStringify(root.model))), adapterSha256 = sha(root.adapterSha256), handshake = handshakeFromManifest(root.handshake);
  const body = deepFreeze({
    format: "cut-footage-local-install" as const,
    version: 1 as const,
    backend: "local" as const,
    platform: text(root.platform, 64) as NodeJS.Platform,
    architecture: text(root.architecture, 64),
    nodeCompatibility: cutFootageNodeCompatibility as typeof cutFootageNodeCompatibility,
    setupNodeVersion: text(root.setupNodeVersion, 128),
    model,
    adapterSha256,
    recipeTree: treeFromManifest(root.recipeTree),
    runtimeTree: treeFromManifest(root.runtimeTree),
    modelTree: treeFromManifest(root.modelTree),
    installationTree: treeFromManifest(root.installationTree),
    handshake,
  });
  const identitySha256 = sha(root.identitySha256);
  if (createHash("sha256").update(manifestBody(body)).digest("hex") !== identitySha256 || !same(handshake, expectedHandshake(model, adapterSha256))) mismatch();
  return deepFreeze({ ...body, identitySha256 });
}

async function loadRecipe(recipeRoot: string, stagingRoot: string, enforcePinned: boolean) {
  if (!isAbsolute(recipeRoot) || normalize(recipeRoot) !== recipeRoot) mismatch("the local footage adapter recipe is invalid.");
  try {
    const metadata = await lstat(recipeRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) mismatch("the local footage adapter recipe is invalid.");
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    mismatch("the local footage adapter recipe is invalid.");
  }
  let names: string[];
  try { names = (await readdir(recipeRoot)).sort(compareText); } catch { mismatch("the local footage adapter recipe is invalid."); }
  if (!same(names, recipeFiles)) mismatch("the local footage adapter recipe is invalid.");
  for (const name of recipeFiles) {
    const bytes = await readBoundedRegular(join(recipeRoot, name), maximumRecipeFileBytes);
    await writeFile(join(stagingRoot, name), bytes, { flag: "wx", mode: 0o600 });
  }
  const packageJson = parseStrictPackageJson(await readFile(join(stagingRoot, "package.json")));
  const packageLock = parseStrictPackageJson(await readFile(join(stagingRoot, "package-lock.json")));
  validateRecipePackages(packageJson, packageLock);
  const model = parseModel(await readFile(join(stagingRoot, "model.json")));
  if (enforcePinned) requirePinnedModel(model);
  return Object.freeze({
    model,
    adapterSha256: (await hashRegular(join(stagingRoot, "local-clip-sidecar.mjs"))).sha256,
  });
}

function validateRecipePackages(packageJson: unknown, packageLock: unknown) {
  const packageRecord = record(packageJson, ["name", "version", "private", "type", "engines", "dependencies"]);
  const engines = record(packageRecord.engines, ["node"]), dependencies = record(packageRecord.dependencies, ["@huggingface/transformers"]);
  if (packageRecord.name !== "@cut-lang/footage-local" || packageRecord.version !== "1.0.0" || packageRecord.private !== true || packageRecord.type !== "module"
    || engines.node !== cutFootageNodeCompatibility || dependencies["@huggingface/transformers"] !== "4.2.0") mismatch("the local footage adapter package recipe is invalid.");

  const lockRecord = record(packageLock, ["name", "version", "lockfileVersion", "requires", "packages"]);
  if (lockRecord.name !== packageRecord.name || lockRecord.version !== packageRecord.version || lockRecord.lockfileVersion !== 3 || lockRecord.requires !== true
    || !lockRecord.packages || typeof lockRecord.packages !== "object" || Array.isArray(lockRecord.packages)) mismatch("the local footage adapter lock is invalid.");
  const packages = lockRecord.packages as Record<string, unknown>;
  if (!Object.keys(packages).length || Object.keys(packages).length > 1_024) mismatch("the local footage adapter lock is invalid.");
  for (const [path, value] of Object.entries(packages)) {
    if (path && (!path.startsWith("node_modules/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))) mismatch("the local footage adapter lock is invalid.");
    if (!value || typeof value !== "object" || Array.isArray(value)) mismatch("the local footage adapter lock is invalid.");
    const item = value as Record<string, unknown>;
    if (item.link === true || (item.resolved !== undefined && (typeof item.resolved !== "string" || !item.resolved.startsWith("https://registry.npmjs.org/")))
      || (item.integrity !== undefined && (typeof item.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(item.integrity)))) mismatch("the local footage adapter lock is invalid.");
  }
  const root = packages[""] as Record<string, unknown>, rootKeys = Object.keys(root);
  if (rootKeys.some((key) => !["name", "version", "engines", "dependencies"].includes(key))
    || (root.name !== undefined && root.name !== packageRecord.name) || (root.version !== undefined && root.version !== packageRecord.version)
    || !same(root.dependencies, dependencies) || (root.engines !== undefined && !same(root.engines, engines))) mismatch("the local footage adapter lock root is invalid.");
  const transformers = packages["node_modules/@huggingface/transformers"] as Record<string, unknown> | undefined;
  const ort = packages["node_modules/onnxruntime-node"] as Record<string, unknown> | undefined;
  const transformerDependencies = transformers?.dependencies && typeof transformers.dependencies === "object" && !Array.isArray(transformers.dependencies)
    ? transformers.dependencies as Record<string, unknown> : {};
  if (transformers?.version !== "4.2.0" || ort?.version !== "1.24.3" || transformerDependencies["onnxruntime-node"] !== "1.24.3") mismatch("the local footage adapter lock is not pinned to its verified runtime.");
}

/** Publishes one verified immutable payload through a single create-only relative symlink. */
async function publishVerifiedInstall(
  stagingRoot: string,
  target: string,
  stagingSnapshot: EntrySnapshot,
  beforePublish?: CutFootageLocalOperations["beforePublish"],
) {
  try { await beforePublish?.({ stagingRoot, target }); } catch { publishFailure("the verified local footage backend could not enter its create-only publication boundary."); }
  const payloadName = basename(stagingRoot);
  if (!payloadPattern.test(payloadName) || dirname(stagingRoot) !== dirname(target)) publishFailure("the verified local footage backend payload is invalid.");
  let targetSnapshot: EntrySnapshot | undefined;
  try {
    const before = await lstat(stagingRoot);
    if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== stagingSnapshot.dev || before.ino !== stagingSnapshot.ino) publishFailure("the verified local footage backend payload changed before publication.");
    await symlink(payloadName, target, "dir");
    const publishedLink = await lstat(target);
    targetSnapshot = Object.freeze({ dev: publishedLink.dev, ino: publishedLink.ino });
    const [declaredTarget, after] = await Promise.all([readlink(target), lstat(stagingRoot)]);
    if (!publishedLink.isSymbolicLink() || declaredTarget !== payloadName || !after.isDirectory() || after.isSymbolicLink()
      || after.dev !== stagingSnapshot.dev || after.ino !== stagingSnapshot.ino) publishFailure("the verified local footage backend publication changed before commit.");
  } catch (error) {
    if (targetSnapshot) try {
      const metadata = await lstat(target), declaredTarget = await readlink(target);
      if (metadata.dev === targetSnapshot.dev && metadata.ino === targetSnapshot.ino && declaredTarget === payloadName) await unlink(target);
    } catch { /* Preserve a destination that changed or is no longer ours. */ }
    if (error instanceof CutFootageError) throw error;
    publishFailure("the verified local footage backend destination already exists.");
  }
}

async function resolvePublishedPayload(home: string, target: string) {
  let before, declaredTarget: string;
  try {
    before = await lstat(target);
    if (!before.isSymbolicLink()) mismatch();
    declaredTarget = await readlink(target);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") missing();
    if (error instanceof CutFootageError) throw error;
    mismatch();
  }
  if (!payloadPattern.test(declaredTarget) || basename(declaredTarget) !== declaredTarget) mismatch();
  const payload = resolve(home, declaredTarget);
  if (dirname(payload) !== home) mismatch();
  try {
    const payloadMetadata = await lstat(payload), canonicalHome = await realpath(home), canonicalPayload = await realpath(payload);
    const after = await lstat(target), afterTarget = await readlink(target);
    if (!payloadMetadata.isDirectory() || payloadMetadata.isSymbolicLink() || !inside(canonicalHome, canonicalPayload)
      || before.dev !== after.dev || before.ino !== after.ino || declaredTarget !== afterTarget) mismatch();
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    mismatch();
  }
  return payload;
}

function setupReport(status: "installed" | "ready", install: CutFootageLocalInstall): CutFootageLocalSetupReport {
  return deepFreeze({ format: "cut-footage-local-setup-report" as const, version: 1 as const, status, backend: "local" as const, identity: cutFootageBackendIdentityFromInstall(install) });
}

export function cutFootageBackendIdentityFromInstall(install: CutFootageLocalInstall) {
  const { model, adapterSha256 } = install.manifest;
  return deepFreeze({
    protocolVersion: 1 as const,
    provider: model.provider,
    model: `${model.model}@${model.revision};${model.dtype};${model.device};adapter=${adapterSha256}`,
    dimensions: model.dimensions,
    normalization: "l2" as const,
  });
}

/** Rehashes the immutable installation without starting inference. */
export async function inspectCutFootageLocalInstall(options: CutFootageLocalInspectOptions = {}): Promise<CutFootageLocalInstall> {
  const home = resolveCutFootageHome({ explicitHome: options.home, homeDirectory: options.homeDirectory, environment: options.environment });
  const target = join(home, cutFootageLocalDirectoryName), current = platformIdentity(options);
  const payload = await resolvePublishedPayload(home, target);
  try {
    const manifest = parseInstallManifest(await readBoundedRegular(join(payload, manifestName), maximumManifestBytes));
    if (manifest.platform !== current.platform || manifest.architecture !== current.architecture) mismatch();
    const modelRoot = modelRevisionPath(payload, manifest.model);
    await verifyExpectedModelFiles(modelRoot, manifest.model);
    const [recipeTree, runtimeTree, modelTree, installationTree] = await Promise.all([
      selectedFileIdentity(payload, recipeFiles),
      treeIdentity(join(payload, "node_modules")),
      treeIdentity(modelRoot),
      treeIdentity(payload, new Set([manifestName])),
    ]);
    if (!same(recipeTree, manifest.recipeTree) || !same(runtimeTree, manifest.runtimeTree) || !same(modelTree, manifest.modelTree) || !same(installationTree, manifest.installationTree)) mismatch();
    return deepFreeze({ root: payload, modelRevisionRoot: modelRoot, sidecarPath: join(payload, "local-clip-sidecar.mjs"), manifest });
  } catch (error) {
    if (error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_MISSING") throw error;
    mismatch();
  }
}

/** Starts a verified ordinary sidecar with remote model access disabled by the adapter. */
export async function startCutFootageLocalSidecar(options: CutFootageLocalStartOptions = {}): Promise<CutFootageSidecarSession> {
  const install = await inspectCutFootageLocalInstall(options), operations = options.operations ?? defaultOperations;
  const launch = launchFor(install.root, install.manifest.model, install.manifest.handshake, "offline");
  let session: CutFootageSidecarSession | undefined;
  try {
    session = await operations.startSidecar(launch);
    if (!same(session.handshake, install.manifest.handshake)) {
      await session.close().catch(() => undefined);
      mismatch();
    }
    return session;
  } catch (error) {
    await session?.close().catch(() => undefined);
    if (error instanceof CutFootageError && error.code === "CUT_FOOTAGE_MODEL_MISMATCH") throw error;
    mismatch();
  }
}

/** Installs one immutable local backend through a sibling stage and exclusive lock. */
export async function setupCutFootageLocalBackend(options: CutFootageLocalSetupOptions): Promise<CutFootageLocalSetupReport> {
  if (!options || typeof options !== "object" || Array.isArray(options) || options.backend !== "local") {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$backend", "only the local footage backend is supported.");
  }
  const home = resolveCutFootageHome({ explicitHome: options.home, homeDirectory: options.homeDirectory, environment: options.environment });
  const system = platformIdentity(options), operations = options.operations ?? defaultOperations;
  const target = join(home, cutFootageLocalDirectoryName);
  try {
    const existing = await inspectCutFootageLocalInstall({ ...options, home });
    const session = await startCutFootageLocalSidecar({ ...options, home, operations });
    await session.close();
    return setupReport("ready", existing);
  } catch (error) {
    if (!(error instanceof CutFootageError) || error.code !== "CUT_FOOTAGE_BACKEND_MISSING") throw error;
  }

  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const homeMetadata = await lstat(home);
    if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink()) publishFailure("the footage home is not a direct directory.");
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    publishFailure("the footage home could not be prepared.");
  }

  const lockPath = join(home, `${cutFootageLocalDirectoryName}.lock`), token = `${process.pid}-${randomUUID()}\n`;
  const stagingRoot = join(home, `.${cutFootageLocalDirectoryName}.payload-${process.pid}-${randomUUID()}`);
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined, lockSnapshot: EntrySnapshot | undefined, stagingSnapshot: EntrySnapshot | undefined;
  let stagingCreated = false, published = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      const metadata = await lockHandle.stat();
      lockSnapshot = Object.freeze({ dev: metadata.dev, ino: metadata.ino });
      await lockHandle.writeFile(token);
      await lockHandle.close(); lockHandle = undefined;
    } catch { publishFailure("another local footage setup already owns the installation lock."); }

    try { await lstat(target); mismatch(); } catch (error) {
      if (error instanceof CutFootageError) throw error;
      if (systemErrorCode(error) !== "ENOENT") mismatch();
    }

    const recipeRoot = options.recipeRoot ?? resolve(__dirname, "../../../adapters/footage-local");
    const fixtureRecipe = options.recipeRoot !== undefined;
    if (fixtureRecipe && options.operations === undefined) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$recipe", "a custom footage recipe is permitted only with injected test operations.");
    await mkdir(stagingRoot, { mode: 0o700 }); stagingCreated = true;
    const stagingMetadata = await lstat(stagingRoot);
    stagingSnapshot = Object.freeze({ dev: stagingMetadata.dev, ino: stagingMetadata.ino });
    const recipe = await loadRecipe(recipeRoot, stagingRoot, !fixtureRecipe);
    const npmExecutable = options.npmExecutable ?? process.execPath;
    if (!isAbsolute(npmExecutable) || normalize(npmExecutable) !== npmExecutable) publishFailure("the npm executable is invalid.");
    await operations.installRuntime({
      stagingRoot,
      npmExecutable,
      npmCacheRoot: join(home, ".npm-cache"),
      environment: Object.freeze({}),
    });
    const modelRoot = modelRevisionPath(stagingRoot, recipe.model), handshake = expectedHandshake(recipe.model, recipe.adapterSha256);
    await verifySession(operations, launchFor(stagingRoot, recipe.model, handshake, "setup"));
    await verifySession(operations, launchFor(stagingRoot, recipe.model, handshake, "offline"));
    await verifyExpectedModelFiles(modelRoot, recipe.model);
    const [recipeTree, runtimeTree, modelTree, installationTree] = await Promise.all([
      selectedFileIdentity(stagingRoot, recipeFiles),
      treeIdentity(join(stagingRoot, "node_modules")),
      treeIdentity(modelRoot),
      treeIdentity(stagingRoot),
    ]);
    const body = deepFreeze({
      format: "cut-footage-local-install" as const,
      version: 1 as const,
      backend: "local" as const,
      platform: system.platform,
      architecture: system.architecture,
      nodeCompatibility: cutFootageNodeCompatibility as typeof cutFootageNodeCompatibility,
      setupNodeVersion: system.nodeVersion,
      model: recipe.model,
      adapterSha256: recipe.adapterSha256,
      recipeTree,
      runtimeTree,
      modelTree,
      installationTree,
      handshake,
    });
    const manifest = deepFreeze({ ...body, identitySha256: createHash("sha256").update(manifestBody(body)).digest("hex") });
    await writeFile(join(stagingRoot, manifestName), `${stableJsonStringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    await publishVerifiedInstall(stagingRoot, target, stagingSnapshot, operations.beforePublish); published = true;
    const install = await inspectCutFootageLocalInstall({ ...options, home });
    return setupReport("installed", install);
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    publishFailure("the local footage backend could not be installed.");
  } finally {
    await lockHandle?.close().catch(() => undefined);
    if (stagingCreated && !published && stagingSnapshot) try {
      const metadata = await lstat(stagingRoot);
      if (metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.dev === stagingSnapshot.dev && metadata.ino === stagingSnapshot.ino) {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    } catch { /* Remove only the exact payload directory created by this invocation. */ }
    if (lockSnapshot) {
      try {
        const metadata = await lstat(lockPath);
        if (metadata.dev === lockSnapshot.dev && metadata.ino === lockSnapshot.ino) await unlink(lockPath);
      } catch { /* Never remove a lock we no longer own. */ }
    }
  }
  return publishFailure("the local footage backend could not be installed.");
}
