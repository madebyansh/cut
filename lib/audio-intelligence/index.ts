import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { stableJsonStringify } from "../core/stable";
import { parseCutAssetCatalog } from "../project/asset-catalog";
import {
  loadCutAudioAuditionProjectFile,
  parseCutAudioAuditionBindings,
  parseCutAudioAuditionSemanticAnalysis,
  type CutAudioAuditionSemanticEvidence,
} from "./audition";
import { materializeCutYamnetSemanticAnalysis } from "./yamnet-materialize";
import { decodeCutWaveIntegerPcmNativeRate, normalizeCutWaveForYamnet } from "./wave-normalize";
import {
  arrangeCutAudio,
  cutAudioArrangementLimits,
  parseCutAudioArrangementInput,
  type CutAudioArrangement,
} from "./arrange";
import {
  buildCutAudioSemanticIndex,
  cutAudioSearchLimits,
  type CutAudioSearchAuthenticatedCandidate,
  type CutAudioSearchBindings,
  type CutAudioSearchFileIdentity,
  type CutAudioSemanticIndex,
} from "./search";
import {
  collectKokoroMlxLocalAuthorities,
  cutKokoroMlxLocalPolicy,
  type CutKokoroMlxLocalAuthorities,
  type CutKokoroMlxLocalAuthorityPaths,
} from "./kokoro-mlx-local";

export * from "./contracts";
export * from "./sidecar";
export * from "./dsp";
export * from "./materialize";
export * from "./transcription";
export * from "./brief";
export * from "./prompt-policy";
export * from "./whisper-local";
export * from "./whisper-workflow";
export * from "./whisper-setup";
export * from "./dialogue-prosody";
export * from "./yamnet-taxonomy";
export * from "./wave-normalize";
export * from "./yamnet-local";
export * from "./yamnet-materialize";
export * from "./search";
export * from "./kokoro-mlx-local";
export * from "./arrange";

export const cutKokoroMlxLocalRecipePolicy = Object.freeze({
  format: "cut-kokoro-mlx-local-recipe",
  version: 1,
  maximumBytes: 256 * 1024,
  maximumRuntimeRootsPerComponent: cutKokoroMlxLocalPolicy.maximumRuntimeRootsPerComponent,
  bundledAdapterRevision: "cut-kokoro-mlx-adapter-v2",
} as const);

export type CutKokoroMlxLocalRecipe = Readonly<{
  format: typeof cutKokoroMlxLocalRecipePolicy.format;
  version: typeof cutKokoroMlxLocalRecipePolicy.version;
  python: CutKokoroMlxLocalAuthorityPaths["python"];
  runtime: CutKokoroMlxLocalAuthorityPaths["runtime"];
  model: CutKokoroMlxLocalAuthorityPaths["model"];
  voice: CutKokoroMlxLocalAuthorityPaths["voice"];
  phonemizer: CutKokoroMlxLocalAuthorityPaths["phonemizer"];
}>;

export class CutKokoroMlxLocalRecipeError extends Error {
  readonly code = "CUT_KOKORO_MLX_RECIPE";

  constructor(readonly path: string, message: string) {
    super(`CUT_KOKORO_MLX_RECIPE at ${path}: ${message}`);
    this.name = "CutKokoroMlxLocalRecipeError";
  }
}

function recipeFailure(path: string, message: string): never {
  throw new CutKokoroMlxLocalRecipeError(path, message);
}

function recipeRecord(value: unknown, path: string, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    recipeFailure(path, "must be one plain object.");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(), expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    recipeFailure(path, `must contain exactly ${expected.join(", ")}.`);
  }
  return record;
}

function recipeText(value: unknown, path: string, maximumBytes = 4_096) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value
    || Buffer.byteLength(value, "utf8") > maximumBytes || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    recipeFailure(path, "must be bounded, trimmed, NFC, control-free text.");
  }
  return value;
}

function recipeAbsolutePath(value: unknown, path: string) {
  const text = recipeText(value, path, 16_384);
  if (!isAbsolute(text) || resolve(text) !== text || text.includes("\\")
    || text.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) {
    recipeFailure(path, "must be one canonical absolute POSIX path.");
  }
  return text;
}

function recipeRelativePath(value: unknown, path: string) {
  const text = recipeText(value, path);
  if (text.startsWith("/") || text.includes("\\")
    || text.split("/").some((part) => !part || part === "." || part === "..")) {
    recipeFailure(path, "must be one canonical relative POSIX path.");
  }
  return text;
}

function recipeArray(value: unknown, path: string, maximum: number) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    recipeFailure(path, `must contain from 1 through ${maximum} entries.`);
  }
  return value;
}

/** Parse the machine-local recipe. The bundled adapter is intentionally not caller-selectable. */
export function parseCutKokoroMlxLocalRecipe(value: unknown): CutKokoroMlxLocalRecipe {
  const root = recipeRecord(value, "$", ["format", "version", "python", "runtime", "model", "voice", "phonemizer"]);
  if (root.format !== cutKokoroMlxLocalRecipePolicy.format || root.version !== cutKokoroMlxLocalRecipePolicy.version) {
    recipeFailure("$", `must identify ${cutKokoroMlxLocalRecipePolicy.format} version ${cutKokoroMlxLocalRecipePolicy.version}.`);
  }
  const python = recipeRecord(root.python, "$.python", ["path", "pythonVersion"]);
  const runtime = recipeRecord(root.runtime, "$.runtime", ["sitePackagesRoot", "components"]);
  const components = Object.freeze(recipeArray(runtime.components, "$.runtime.components", 128).map((entry, componentIndex) => {
    const path = `$.runtime.components[${componentIndex}]`, component = recipeRecord(entry, path, ["id", "roots", "packages"]);
    const roots = Object.freeze(recipeArray(
      component.roots,
      `${path}.roots`,
      cutKokoroMlxLocalRecipePolicy.maximumRuntimeRootsPerComponent,
    )
      .map((item, index) => recipeRelativePath(item, `${path}.roots[${index}]`)));
    const packages = Object.freeze(recipeArray(component.packages, `${path}.packages`, 256).map((entryValue, packageIndex) => {
      const packagePath = `${path}.packages[${packageIndex}]`;
      const item = recipeRecord(entryValue, packagePath, ["name", "packageVersion", "license"]);
      return Object.freeze({
        name: recipeText(item.name, `${packagePath}.name`, 256),
        packageVersion: recipeText(item.packageVersion, `${packagePath}.packageVersion`, 256),
        license: recipeText(item.license, `${packagePath}.license`),
      });
    }));
    return Object.freeze({ id: recipeText(component.id, `${path}.id`, 256), roots, packages });
  }));
  const model = recipeRecord(root.model, "$.model", ["name", "revision", "license", "configPath", "weightsPath"]);
  const voice = recipeRecord(root.voice, "$.voice", ["name", "license", "weightsPath"]);
  const phonemizer = recipeRecord(root.phonemizer, "$.phonemizer", ["version", "libraryPath", "dataRoot"]);
  return Object.freeze({
    format: cutKokoroMlxLocalRecipePolicy.format,
    version: cutKokoroMlxLocalRecipePolicy.version,
    python: Object.freeze({
      path: recipeAbsolutePath(python.path, "$.python.path"),
      pythonVersion: recipeText(python.pythonVersion, "$.python.pythonVersion", 256),
    }),
    runtime: Object.freeze({
      sitePackagesRoot: recipeAbsolutePath(runtime.sitePackagesRoot, "$.runtime.sitePackagesRoot"),
      components,
    }),
    model: Object.freeze({
      name: recipeText(model.name, "$.model.name"),
      revision: recipeText(model.revision, "$.model.revision", 256),
      license: recipeText(model.license, "$.model.license"),
      configPath: recipeAbsolutePath(model.configPath, "$.model.configPath"),
      weightsPath: recipeAbsolutePath(model.weightsPath, "$.model.weightsPath"),
    }),
    voice: Object.freeze({
      name: recipeText(voice.name, "$.voice.name", 64),
      license: recipeText(voice.license, "$.voice.license"),
      weightsPath: recipeAbsolutePath(voice.weightsPath, "$.voice.weightsPath"),
    }),
    phonemizer: Object.freeze({
      version: recipeText(phonemizer.version, "$.phonemizer.version", 256),
      libraryPath: recipeAbsolutePath(phonemizer.libraryPath, "$.phonemizer.libraryPath"),
      dataRoot: recipeAbsolutePath(phonemizer.dataRoot, "$.phonemizer.dataRoot"),
    }),
  });
}

/** Authenticate one recipe plus CUT's installed adapter; this never downloads or installs anything. */
export async function collectBundledKokoroMlxLocalAuthorities(
  value: unknown,
): Promise<CutKokoroMlxLocalAuthorities> {
  const recipe = parseCutKokoroMlxLocalRecipe(value);
  return collectKokoroMlxLocalAuthorities(Object.freeze({
    python: recipe.python,
    adapter: Object.freeze({
      path: resolve(__dirname, "../../../adapters/audio-kokoro-mlx-local/sidecar.py"),
      revision: cutKokoroMlxLocalRecipePolicy.bundledAdapterRevision,
    }),
    runtime: recipe.runtime,
    model: recipe.model,
    voice: recipe.voice,
    phonemizer: recipe.phonemizer,
  }));
}

export const cutAudioArrangementWorkflowLimits = Object.freeze({
  maximumAssets: 64,
  maximumAssetBytes: 64 * 1024 * 1024,
  maximumAggregateAssetBytes: 512 * 1024 * 1024,
  maximumAggregateChannelSampleReads: 100_000_000,
  maximumManifestBytes: 8 * 1024 * 1024,
} as const);

export class CutAudioArrangementWorkflowError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAudioArrangementWorkflowError";
  }
}

function arrangementWorkflowFailure(code: string, path: string, message: string): never {
  throw new CutAudioArrangementWorkflowError(code, path, message);
}

function throwIfArrangementCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    arrangementWorkflowFailure("CUT_AUDIO_ARRANGEMENT_CANCELLED", "$", "Audio arrangement was cancelled; no source or manifest may be published.");
  }
}

export type CutAudioArrangementFileIdentity = Readonly<{ locator: string; bytes: number; sha256: string }>;

export type CutAuthenticatedProjectAudioArrangement = Readonly<{
  input: CutAudioArrangementFileIdentity;
  assets: readonly CutAudioArrangementFileIdentity[];
  arrangement: CutAudioArrangement;
  work: Readonly<{ encodedAssetBytes: number; channelSampleReads: number }>;
  verifyInputsUnchanged: () => Promise<void>;
}>;

/** @internal Deterministic fault seams for focused filesystem/cancellation tests. */
export type CutAudioArrangementWorkflowTestHooks = Readonly<{
  afterInitialAsset?: (index: number, identity: CutAudioArrangementFileIdentity) => void | Promise<void>;
}>;

/**
 * Close the pure arranger's outer file authority without publishing anything.
 * Assets are opened, decoded, and released sequentially under aggregate work ceilings.
 */
export async function prepareAuthenticatedProjectAudioArrangement(options: Readonly<{
  projectRoot: string;
  inputLocator: string;
  signal?: AbortSignal;
  testHooks?: CutAudioArrangementWorkflowTestHooks;
}>): Promise<CutAuthenticatedProjectAudioArrangement> {
  throwIfArrangementCancelled(options.signal);
  const inputFile = await loadCutAudioAuditionProjectFile(
    options.projectRoot,
    options.inputLocator,
    cutAudioArrangementLimits.maximumInputBytes,
  );
  throwIfArrangementCancelled(options.signal);
  const parsed = parseCutAudioArrangementInput(inputFile.contents);
  if (parsed.assets.length > cutAudioArrangementWorkflowLimits.maximumAssets) {
    arrangementWorkflowFailure(
      "CUT_AUDIO_ARRANGEMENT_LIMIT",
      "$.assets",
      `public arrangement accepts at most ${cutAudioArrangementWorkflowLimits.maximumAssets} bound assets.`,
    );
  }
  const arrangement = arrangeCutAudio(inputFile.contents);
  const identities: CutAudioArrangementFileIdentity[] = [];
  let encodedAssetBytes = 0, channelSampleReads = 0;
  for (const [index, asset] of arrangement.manifest.assets.entries()) {
    throwIfArrangementCancelled(options.signal);
    const file = await loadCutAudioAuditionProjectFile(
      options.projectRoot,
      asset.locator,
      cutAudioArrangementWorkflowLimits.maximumAssetBytes,
    );
    if (file.sha256 !== asset.lockedResourceSha256) {
      arrangementWorkflowFailure(
        "CUT_AUDIO_ARRANGEMENT_ASSET_AUTHORITY",
        `$.assets[${index}].lockedResourceSha256`,
        `does not match project asset ${JSON.stringify(asset.locator)}.`,
      );
    }
    encodedAssetBytes += file.bytes;
    if (!Number.isSafeInteger(encodedAssetBytes)
      || encodedAssetBytes > cutAudioArrangementWorkflowLimits.maximumAggregateAssetBytes) {
      arrangementWorkflowFailure(
        "CUT_AUDIO_ARRANGEMENT_LIMIT",
        "$.assets",
        `encoded asset bytes exceed ${cutAudioArrangementWorkflowLimits.maximumAggregateAssetBytes}.`,
      );
    }
    const remainingReads = cutAudioArrangementWorkflowLimits.maximumAggregateChannelSampleReads - channelSampleReads;
    if (remainingReads < 1) {
      arrangementWorkflowFailure(
        "CUT_AUDIO_ARRANGEMENT_LIMIT",
        "$.assets",
        `channel-sample reads exceed ${cutAudioArrangementWorkflowLimits.maximumAggregateChannelSampleReads}.`,
      );
    }
    let decoded: ReturnType<typeof decodeCutWaveIntegerPcmNativeRate>;
    try {
      decoded = decodeCutWaveIntegerPcmNativeRate(
        file.contents,
        Object.freeze({ bytes: file.bytes, sha256: file.sha256 }),
        Object.freeze({
          maximumWaveBytes: cutAudioArrangementWorkflowLimits.maximumAssetBytes,
          maximumFrames: cutAudioArrangementWorkflowLimits.maximumAggregateChannelSampleReads,
          maximumChannelSampleReads: remainingReads,
        }),
      );
    } catch (error) {
      arrangementWorkflowFailure(
        "CUT_AUDIO_ARRANGEMENT_ASSET_WAVE",
        `$.assets[${index}].locator`,
        `${JSON.stringify(asset.locator)} is not one accepted bounded integer-PCM WAVE (${error instanceof Error ? error.message : "decode failed"}).`,
      );
    }
    channelSampleReads += decoded.work.channelSampleReads;
    if (decoded.wave.sampleRate !== asset.sampleRate) {
      arrangementWorkflowFailure(
        "CUT_AUDIO_ARRANGEMENT_ASSET_CLOCK",
        `$.assets[${index}].sampleRate`,
        `does not match project asset ${JSON.stringify(asset.locator)}.`,
      );
    }
    if (asset.sourceRange.endSample > decoded.wave.durationSamples) {
      arrangementWorkflowFailure(
        "CUT_AUDIO_ARRANGEMENT_ASSET_RANGE",
        `$.assets[${index}].sourceRange`,
        `exceeds the authenticated duration of project asset ${JSON.stringify(asset.locator)}.`,
      );
    }
    const identity = Object.freeze({ locator: file.locator, bytes: file.bytes, sha256: file.sha256 });
    identities.push(identity);
    await options.testHooks?.afterInitialAsset?.(index, identity);
    throwIfArrangementCancelled(options.signal);
  }
  throwIfArrangementCancelled(options.signal);
  const input = Object.freeze({ locator: inputFile.locator, bytes: inputFile.bytes, sha256: inputFile.sha256 });
  const verifyInputsUnchanged = async () => {
    throwIfArrangementCancelled(options.signal);
    const inputConfirmation = await loadCutAudioAuditionProjectFile(
      options.projectRoot,
      input.locator,
      cutAudioArrangementLimits.maximumInputBytes,
    );
    if (inputConfirmation.bytes !== input.bytes || inputConfirmation.sha256 !== input.sha256) {
      arrangementWorkflowFailure("CUT_AUDIO_ARRANGEMENT_INPUT_CHANGED", options.inputLocator, "arrangement input changed during authoring.");
    }
    for (const identity of identities) {
      throwIfArrangementCancelled(options.signal);
      const confirmation = await loadCutAudioAuditionProjectFile(
        options.projectRoot,
        identity.locator,
        cutAudioArrangementWorkflowLimits.maximumAssetBytes,
      );
      if (confirmation.bytes !== identity.bytes || confirmation.sha256 !== identity.sha256) {
        arrangementWorkflowFailure(
          "CUT_AUDIO_ARRANGEMENT_ASSET_CHANGED",
          identity.locator,
          `project asset ${JSON.stringify(identity.locator)} changed during authoring.`,
        );
      }
    }
    throwIfArrangementCancelled(options.signal);
  };
  return Object.freeze({
    input,
    assets: Object.freeze(identities),
    arrangement,
    work: Object.freeze({ encodedAssetBytes, channelSampleReads }),
    verifyInputsUnchanged,
  });
}

export class CutAudioProjectSemanticIndexError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAudioProjectSemanticIndexError";
  }
}

export const cutAudioSemanticIndexFileLimits = Object.freeze({
  maximumBytes: 1024 * 1024,
  maximumJsonDepth: 24,
  maximumJsonNodes: 100_000,
  maximumJsonStringBytes: 4_096,
  maximumJsonTotalStringBytes: 512 * 1024,
});

let audioSemanticIndexSchemaValidator: ValidateFunction | undefined;

function semanticIndexSchemaValidator() {
  if (audioSemanticIndexSchemaValidator) return audioSemanticIndexSchemaValidator;
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/cut-audio-semantic-index-v1.schema.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    projectIndexFailure("CUT_AUDIO_SEARCH_SCHEMA", "$", error instanceof Error ? error.message : "could not load the shipped semantic-index schema.");
  }
  const ajv = new Ajv({ allErrors: true, jsonPointers: true, strictKeywords: true });
  ajv.addKeyword("x-cut-semanticConstraints", { validate: () => true });
  audioSemanticIndexSchemaValidator = ajv.compile(schema);
  return audioSemanticIndexSchemaValidator;
}

function compareIndexText(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function freezeIndexValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeIndexValue(child);
  }
  return value;
}

/** Validate one serialized index against the shipped closed schema and coverage laws. */
export function parseCutAudioSemanticIndexSnapshot(value: unknown): CutAudioSemanticIndex {
  const validate = semanticIndexSchemaValidator();
  if (!validate(value)) {
    const detail = (validate.errors ?? []).slice(0, 3)
      .map((error) => `${error.dataPath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    projectIndexFailure("CUT_AUDIO_SEARCH_SCHEMA", "$", detail || "does not match the shipped closed semantic-index schema.");
  }
  const index = value as CutAudioSemanticIndex;
  if (index.coverage.indexedEntries !== index.entries.length
    || index.coverage.catalogAudioEntries !== index.entries.length + index.coverage.omittedAudioEntryIds.length
    || index.coverage.catalogEntries < index.coverage.catalogAudioEntries) {
    projectIndexFailure("CUT_AUDIO_SEARCH_COVERAGE", "$.coverage", "does not equal the indexed, omitted-audio, and total catalog counts.");
  }
  const indexedIds = new Set(index.entries.map((entry) => entry.id));
  let prior = "";
  for (const [offset, id] of index.coverage.omittedAudioEntryIds.entries()) {
    if ((offset > 0 && compareIndexText(prior, id) >= 0) || indexedIds.has(id)) {
      projectIndexFailure("CUT_AUDIO_SEARCH_COVERAGE", `$.coverage.omittedAudioEntryIds[${offset}]`, "must be bytewise sorted, unique, and disjoint from indexed ids.");
    }
    prior = id;
  }
  let canonicalEntries;
  try {
    canonicalEntries = parseCutAssetCatalog(stableJsonStringify({
      format: "cut-asset-catalog",
      version: 1,
      name: "CUT semantic index validation",
      entries: index.entries.map((entry) => entry.catalogEntry),
    })).entries;
  } catch (error) {
    projectIndexFailure("CUT_AUDIO_SEARCH_CATALOG", "$.entries", error instanceof Error ? error.message : "embedded catalog entries are invalid.");
  }
  if (stableJsonStringify(canonicalEntries) !== stableJsonStringify(index.entries.map((entry) => entry.catalogEntry))) {
    projectIndexFailure("CUT_AUDIO_SEARCH_CATALOG", "$.entries", "embedded catalog entries are not the canonical catalog projection.");
  }
  return freezeIndexValue(index);
}

type RetainedInputIdentity = Readonly<CutAudioSearchFileIdentity & { maximumBytes: number }>;

function projectIndexFailure(code: string, path: string, message: string): never {
  throw new CutAudioProjectSemanticIndexError(code, path, message);
}

function throwIfProjectIndexCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    projectIndexFailure("CUT_AUDIO_SEARCH_CANCELLED", "$", "Audio semantic indexing was cancelled; no index may be published.");
  }
}

function retainInput(
  identities: RetainedInputIdentity[],
  file: Readonly<{ locator: string; bytes: number; sha256: string }>,
  maximumBytes: number,
) {
  identities.push(Object.freeze({ locator: file.locator, bytes: file.bytes, sha256: file.sha256, maximumBytes }));
}

function semanticEvidence(
  file: Readonly<{ locator: string; bytes: number; sha256: string }>,
  analysis: ReturnType<typeof parseCutAudioAuditionSemanticAnalysis>,
): CutAudioAuditionSemanticEvidence {
  return Object.freeze({
    contract: "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1",
    file: Object.freeze({ locator: file.locator, bytes: file.bytes, sha256: file.sha256 }),
    analysisSha256: analysis.analysisSha256,
    source: analysis.source,
    normalization: Object.freeze({
      evidenceSha256: analysis.normalization.evidenceSha256,
      policySha256: analysis.normalization.policy.policySha256,
      outputSha256: analysis.normalization.output.sha256,
      outputSamples: analysis.normalization.output.samples,
    }),
    provider: Object.freeze({
      id: analysis.provider.provider,
      analysisSha256: analysis.provider.analysisSha256,
      rawScoreSha256: analysis.provider.rawScores.sha256,
      authorities: analysis.provider.authorities,
      aggregateTopClasses: analysis.provider.aggregateTopClasses,
    }),
    taxonomy: Object.freeze({
      policySha256: analysis.taxonomy.policySha256,
      suggestionsSha256: analysis.taxonomy.suggestionsSha256,
      interpretation: analysis.taxonomy.interpretation,
      musicMoodScope: analysis.taxonomy.musicMoodScope,
      roleSuggestions: analysis.taxonomy.aggregate.roleSuggestions,
      musicMoodSuggestions: analysis.taxonomy.aggregate.musicMoodSuggestions,
    }),
    limitations: analysis.limitations,
  });
}

export type CutAuthenticatedProjectAudioSemanticIndex = Readonly<{
  index: CutAudioSemanticIndex;
  verifyInputsUnchanged: () => Promise<void>;
}>;

/**
 * Compose the existing project-local loader and finalized semantic verifier
 * into one source-backed search index. LiteRT is never invoked here.
 */
export async function buildAuthenticatedProjectAudioSemanticIndex(options: Readonly<{
  projectRoot: string;
  catalogLocator: string;
  bindingsLocator: string;
  signal?: AbortSignal;
}>): Promise<CutAuthenticatedProjectAudioSemanticIndex> {
  throwIfProjectIndexCancelled(options.signal);
  const [catalogFile, bindingsFile] = await Promise.all([
    loadCutAudioAuditionProjectFile(options.projectRoot, options.catalogLocator, cutAudioSearchLimits.maximumCatalogBytes),
    loadCutAudioAuditionProjectFile(options.projectRoot, options.bindingsLocator, cutAudioSearchLimits.maximumBindingsBytes),
  ]);
  throwIfProjectIndexCancelled(options.signal);
  const catalog = parseCutAssetCatalog(catalogFile.contents), parsedBindings = parseCutAudioAuditionBindings(bindingsFile.contents);
  if (parsedBindings.version !== 2) {
    projectIndexFailure("CUT_AUDIO_SEARCH_BINDINGS", options.bindingsLocator, "audio indexing requires semantic audition bindings v2.");
  }
  const bindingEntries: CutAudioSearchBindings["entries"][number][] = parsedBindings.entries.map((binding) => {
    if (!binding.semanticAnalysis) {
      projectIndexFailure("CUT_AUDIO_SEARCH_BINDINGS", options.bindingsLocator, `binding ${JSON.stringify(binding.id)} lacks semantic-analysis authority.`);
    }
    return Object.freeze({ ...binding, semanticAnalysis: binding.semanticAnalysis });
  });
  const bindings: CutAudioSearchBindings = Object.freeze({
    format: parsedBindings.format,
    version: 2,
    entries: Object.freeze(bindingEntries),
    bindingsSha256: parsedBindings.bindingsSha256,
  });
  const retainedInputs: RetainedInputIdentity[] = [];
  retainInput(retainedInputs, catalogFile, cutAudioSearchLimits.maximumCatalogBytes);
  retainInput(retainedInputs, bindingsFile, cutAudioSearchLimits.maximumBindingsBytes);
  const catalogById = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const candidates: CutAudioSearchAuthenticatedCandidate[] = [];
  for (const binding of bindingEntries) {
    throwIfProjectIndexCancelled(options.signal);
    const entry = catalogById.get(binding.id);
    if (!entry || entry.kind !== "audio" || !entry.audio) {
      projectIndexFailure("CUT_AUDIO_SEARCH_CATALOG", binding.id, "must identify one catalog audio entry with declared audio metadata.");
    }
    const [sourceFile, rightsFile, analysisFile] = await Promise.all([
      loadCutAudioAuditionProjectFile(options.projectRoot, binding.audioLocator, cutAudioSearchLimits.maximumSourceBytes),
      loadCutAudioAuditionProjectFile(options.projectRoot, binding.rightsEvidenceLocator, cutAudioSearchLimits.maximumRightsEvidenceBytes),
      loadCutAudioAuditionProjectFile(options.projectRoot, binding.semanticAnalysis.locator, cutAudioSearchLimits.maximumSemanticAnalysisBytes),
    ]);
    throwIfProjectIndexCancelled(options.signal);
    retainInput(retainedInputs, sourceFile, cutAudioSearchLimits.maximumSourceBytes);
    retainInput(retainedInputs, rightsFile, cutAudioSearchLimits.maximumRightsEvidenceBytes);
    retainInput(retainedInputs, analysisFile, cutAudioSearchLimits.maximumSemanticAnalysisBytes);
    if (analysisFile.bytes !== binding.semanticAnalysis.bytes || analysisFile.sha256 !== binding.semanticAnalysis.fileSha256) {
      projectIndexFailure("CUT_AUDIO_SEARCH_SEMANTIC", binding.semanticAnalysis.locator, "does not match the binding's exact semantic file identity.");
    }
    const analysis = parseCutAudioAuditionSemanticAnalysis(analysisFile.contents);
    if (analysis.analysisSha256 !== binding.semanticAnalysis.analysisSha256) {
      projectIndexFailure("CUT_AUDIO_SEARCH_SEMANTIC", binding.semanticAnalysis.locator, "does not match the binding's canonical semantic identity.");
    }
    let replayed: typeof analysis;
    try {
      const normalization = normalizeCutWaveForYamnet(sourceFile.contents, {
        bytes: sourceFile.bytes,
        sha256: sourceFile.sha256,
      });
      replayed = materializeCutYamnetSemanticAnalysis({
        source: analysis.source,
        sourceBytes: sourceFile.contents,
        normalization: normalization.evidence,
        pcm: normalization.pcmBytes,
        providerAnalysis: analysis.provider,
        rawScoreBytes: Buffer.from(analysis.derivationInputs.rawScores.data, "base64"),
        classMapBytes: Buffer.from(analysis.derivationInputs.classMap.data, "base64"),
      });
    } catch (error) {
      projectIndexFailure("CUT_AUDIO_SEARCH_SEMANTIC", binding.semanticAnalysis.locator, error instanceof Error ? error.message : "source-backed semantic replay failed.");
    }
    if (stableJsonStringify(replayed) !== stableJsonStringify(analysis)) {
      projectIndexFailure("CUT_AUDIO_SEARCH_SEMANTIC", binding.semanticAnalysis.locator, "does not equal the semantic artifact replayed from authenticated source and embedded derivation bytes.");
    }
    const wave = analysis.normalization.wave;
    if (wave.frames !== entry.audio.durationSamples || wave.sampleRate !== entry.audio.sampleRate || wave.channels !== entry.audio.channels) {
      projectIndexFailure("CUT_AUDIO_SEARCH_SOURCE", binding.audioLocator, "does not match the catalog's declared sample extent, rate, and channels.");
    }
    candidates.push(Object.freeze({
      id: binding.id,
      rightsEvidence: Object.freeze({ locator: rightsFile.locator, bytes: rightsFile.bytes, sha256: rightsFile.sha256 }),
      semantic: semanticEvidence(analysisFile, analysis),
    }));
  }
  throwIfProjectIndexCancelled(options.signal);
  const index = buildCutAudioSemanticIndex({
    catalog: Object.freeze({ locator: catalogFile.locator, bytes: catalogFile.bytes, sha256: catalogFile.sha256, value: catalog }),
    bindings: Object.freeze({ locator: bindingsFile.locator, bytes: bindingsFile.bytes, sha256: bindingsFile.sha256, value: bindings }),
    candidates: Object.freeze(candidates),
  });
  const exactInputs = Object.freeze(retainedInputs);
  const verifyInputsUnchanged = async () => {
    throwIfProjectIndexCancelled(options.signal);
    for (const expected of exactInputs) {
      const observed = await loadCutAudioAuditionProjectFile(options.projectRoot, expected.locator, expected.maximumBytes);
      if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) {
        projectIndexFailure("CUT_AUDIO_SEARCH_INPUT_CHANGED", expected.locator, "changed after authentication; no index may be published.");
      }
      throwIfProjectIndexCancelled(options.signal);
    }
  };
  return Object.freeze({ index, verifyInputsUnchanged });
}
