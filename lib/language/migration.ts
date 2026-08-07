import { createHash } from "node:crypto";
import { link, lstat, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { validateCutProjectManifest } from "../project/manifest";
import { cutIrIdentity, cutSignalContentHash, finalizeGraphHashes } from "../runtime/graph";
import { cutProductVersion } from "../version";
import { checkCutModule } from "./checker";
import { CutAvIrValidationError, loadCutAvIr } from "./ir-loader";
import type { CutAVIR } from "./ir";
import { kernelPropertyValueType, referenceKernelSchema } from "./kernel-registry";
import { loadCutLock } from "./lock";
import { parseCutLanguage } from "./parser";
import { diffCutAVIR, type CutAVIRSemanticDiff } from "./semantic-diff";

export const cutMigrationPolicyVersion = 1;

export type CutMigrationArtifactKind =
  | "cut-source"
  | "cut-av-ir"
  | "cut-lock"
  | "cut-project"
  | "legacy-intent-source";

export type CutMigrationCompatibility = "current" | "migratable" | "unsafe" | "unsupported";

export type CutMigrationMatrixRow = Readonly<{
  artifact: CutMigrationArtifactKind;
  version: string;
  language: string | null;
  compatibility: CutMigrationCompatibility;
  transformation: string | null;
  reason: string;
}>;

/**
 * Executable policy data shared by the CLI report, tests, and prose matrix.
 * `unsafe` means CUT knows the format but cannot prove a semantics-preserving
 * automatic rewrite. `unsupported` means no compatibility contract exists.
 */
export const cutMigrationCompatibilityMatrix: readonly CutMigrationMatrixRow[] = Object.freeze([
  Object.freeze({ artifact: "cut-source", version: "0.4", language: "0.4", compatibility: "current", transformation: null, reason: "The current alpha authors CUT language 0.4 source. Source bytes are never rewritten by migrate, and removed built-in kernel inputs are refused by the current checker." }),
  Object.freeze({ artifact: "cut-source", version: "0.3", language: "0.3", compatibility: "unsafe", transformation: null, reason: "The 0.4 alpha changes implementation and lock identities. Update source deliberately, then check and relock it; generated IR and locks are never rewritten as source." }),
  Object.freeze({ artifact: "cut-av-ir", version: "3 canonical", language: "0.4", compatibility: "current", transformation: null, reason: "Strict CutAVIR v3 validation and canonical derived identities pass." }),
  Object.freeze({ artifact: "cut-av-ir", version: "3 archived identity", language: "0.4", compatibility: "migratable", transformation: "cut-av-ir-v3-canonicalize-derived-identity", reason: "Verified inferred signal types are derived uniquely from their attached closed kernel properties before signal/node/build identities change; the public semantic diff must remain empty." }),
  Object.freeze({ artifact: "cut-av-ir", version: "3 archived identity with removed kernel inputs", language: "0.4", compatibility: "unsafe", transformation: null, reason: "Explicit legacy mode keeps evidence structurally readable, but metadata-only kernel inputs such as Narration transcript have no semantics-preserving current migration and never gain execution authority." }),
  Object.freeze({ artifact: "cut-lock", version: "2", language: "0.4", compatibility: "current", transformation: null, reason: "Closed cut.lock v2 contains the probes and implementation identities required by the current runtime." }),
  Object.freeze({ artifact: "cut-lock", version: "1", language: "0.4", compatibility: "unsafe", transformation: null, reason: "Archived v1 lacks selected-stream probes and native backend identity; regenerate from source and exact resources." }),
  Object.freeze({ artifact: "cut-project", version: "1", language: "0.4", compatibility: "current", transformation: null, reason: "The closed project manifest v1 contract is current." }),
  Object.freeze({ artifact: "legacy-intent-source", version: "0.2/pre-formal", language: null, compatibility: "unsafe", transformation: null, reason: "The intent-planning DSL has no deterministic one-to-one mapping to typed CUT source." }),
]);

export type CutMigrationDiagnostic = {
  code: string;
  severity: "error" | "info";
  message: string;
  path?: string;
};

export type CutMigrationReport = {
  format: "cut-migration-report";
  version: 1;
  policyVersion: 1;
  productVersion: string;
  status: "current" | "migration-available" | "migrated";
  artifact: {
    kind: Exclude<CutMigrationArtifactKind, "legacy-intent-source">;
    format: string;
    version: string;
    language: string;
  };
  compatibility: "current" | "migratable";
  transformation: {
    id: "none" | "cut-av-ir-v3-canonicalize-derived-identity";
    semantics: "unchanged";
    changedDerivedFields: string[];
  };
  input: { bytes: number; sha256: string };
  output?: { bytes: number; sha256: string };
  semanticDiff?: CutAVIRSemanticDiff;
  diagnostics: CutMigrationDiagnostic[];
  frozenBoundary: { protectedInput: boolean; mutated: false };
};

export type CutMigrationAnalysis = {
  report: CutMigrationReport;
  /** Present only for a proven migration. Never aliases the caller's bytes. */
  output?: Uint8Array;
};

export class CutMigrationError extends Error {
  readonly source?: { path: string; line?: number; column?: number };

  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
    location?: { line?: number; column?: number },
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutMigrationError";
    this.source = { path, ...location };
  }
}

const maximumMigrationInputBytes = 64 * 1024 * 1024;
const maximumJsonDepth = 128;
const maximumJsonNodes = 2_000_000;
const legacyIntentHeader = /^\s*#\s*Cut\s+v0\.[0-2]\b/im;

function fail(code: string, path: string, message: string, location?: { line?: number; column?: number }): never {
  throw new CutMigrationError(code, path, message, location);
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(input: Uint8Array, path: string) {
  if (!(input instanceof Uint8Array)) fail("CUT_MIGRATE_INPUT_TYPE", path, "migration input must be bytes.");
  if (input.byteLength === 0) fail("CUT_MIGRATE_EMPTY", path, "migration input is empty.");
  if (input.byteLength > maximumMigrationInputBytes) fail("CUT_MIGRATE_INPUT_LIMIT", path, `input exceeds ${maximumMigrationInputBytes} bytes.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    fail("CUT_MIGRATE_UTF8", path, "input is not valid UTF-8.");
  }
}

class MigrationJsonScanner {
  private offset = 0;
  private nodes = 0;

  constructor(private readonly source: string, private readonly diagnosticPath: string) {}

  scan() {
    this.space();
    this.value(0);
    this.space();
    if (this.offset !== this.source.length) this.syntax("unexpected trailing input");
  }

  private syntax(message: string): never {
    fail("CUT_MIGRATE_JSON_PARSE", this.diagnosticPath, `${message} at text offset ${this.offset}.`);
  }

  private space() {
    while (this.offset < this.source.length && /\s/.test(this.source[this.offset])) this.offset += 1;
  }

  private value(depth: number) {
    this.nodes += 1;
    if (this.nodes > maximumJsonNodes) fail("CUT_MIGRATE_JSON_LIMIT", this.diagnosticPath, `JSON exceeds ${maximumJsonNodes} values.`);
    if (depth > maximumJsonDepth) fail("CUT_MIGRATE_JSON_LIMIT", this.diagnosticPath, `JSON exceeds depth ${maximumJsonDepth}.`);
    this.space();
    const character = this.source[this.offset];
    if (character === "{") this.object(depth);
    else if (character === "[") this.array(depth);
    else if (character === '"') this.string();
    else if (this.source.startsWith("true", this.offset)) this.offset += 4;
    else if (this.source.startsWith("false", this.offset)) this.offset += 5;
    else if (this.source.startsWith("null", this.offset)) this.offset += 4;
    else {
      const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.offset));
      if (!number) this.syntax("expected a JSON value");
      this.offset += number[0].length;
    }
  }

  private string() {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        try { return JSON.parse(this.source.slice(start, this.offset)) as string; }
        catch { this.syntax("invalid JSON string"); }
      }
      if (character === "\\") {
        this.offset += 1;
        if (this.offset >= this.source.length) this.syntax("unterminated JSON escape");
        if (this.source[this.offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.offset + 1, this.offset + 5))) this.syntax("invalid Unicode escape");
          this.offset += 5;
        } else {
          if (!/["\\/bfnrt]/.test(this.source[this.offset])) this.syntax("invalid JSON escape");
          this.offset += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.syntax("unescaped control character in string");
      this.offset += 1;
    }
    this.syntax("unterminated JSON string");
  }

  private object(depth: number) {
    this.offset += 1;
    this.space();
    const keys = new Set<string>();
    if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax("expected an object key");
      const key = this.string();
      if (keys.has(key)) fail("CUT_MIGRATE_JSON_DUPLICATE_KEY", this.diagnosticPath, `contains duplicate decoded key ${JSON.stringify(key)}.`);
      keys.add(key);
      this.space();
      if (this.source[this.offset] !== ":") this.syntax("expected ':' after object key");
      this.offset += 1;
      this.value(depth + 1);
      this.space();
      if (this.source[this.offset] === "}") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or '}'");
      this.offset += 1;
      this.space();
    }
  }

  private array(depth: number) {
    this.offset += 1;
    this.space();
    if (this.source[this.offset] === "]") { this.offset += 1; return; }
    while (true) {
      this.value(depth + 1);
      this.space();
      if (this.source[this.offset] === "]") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or ']'");
      this.offset += 1;
      this.space();
    }
  }
}

function strictJson(source: string, path: string): unknown {
  new MigrationJsonScanner(source, path).scan();
  try { return JSON.parse(source) as unknown; }
  catch (error) { fail("CUT_MIGRATE_JSON_PARSE", path, error instanceof Error ? error.message : "invalid JSON."); }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CUT_MIGRATE_JSON_ROOT", path, "JSON migration input must be an object.");
  return value as Record<string, unknown>;
}

function baseReport(
  input: Uint8Array,
  artifact: CutMigrationReport["artifact"],
  protectedInput: boolean,
): CutMigrationReport {
  return {
    format: "cut-migration-report",
    version: 1,
    policyVersion: cutMigrationPolicyVersion,
    productVersion: cutProductVersion,
    status: "current",
    artifact,
    compatibility: "current",
    transformation: { id: "none", semantics: "unchanged", changedDerivedFields: [] },
    input: { bytes: input.byteLength, sha256: sha256(input) },
    diagnostics: [{ code: "CUT_MIGRATE_CURRENT", severity: "info", message: `${artifact.format} ${artifact.version} is already current; source bytes were not changed.` }],
    frozenBoundary: { protectedInput, mutated: false },
  };
}

function analyzeSource(input: Uint8Array, source: string, path: string, protectedInput: boolean): CutMigrationAnalysis {
  if (legacyIntentHeader.test(source) || (/\bstory\s+"/.test(source) && !/\bcut\s+0\.3\s*;/.test(source))) {
    fail("CUT_MIGRATE_LEGACY_INTENT_UNSAFE", path, "the pre-formal intent DSL cannot be deterministically converted to typed CUT source; preserve it and author a new CUT 0.4 program explicitly.");
  }
  const declaredVersion = /\bcut\s+([0-9]+(?:\.[0-9]+)?)\s*;/.exec(source)?.[1];
  if (declaredVersion && declaredVersion !== "0.4") {
    fail("CUT_MIGRATE_LANGUAGE_VERSION", path, `CUT language ${declaredVersion} has no proven automatic migration to current language 0.4; update source deliberately, then check and relock it.`);
  }
  const parsed = parseCutLanguage(source);
  if (!parsed.module) {
    const diagnostic = parsed.diagnostics[0];
    fail("CUT_MIGRATE_SOURCE_INVALID", path, `${diagnostic?.code ?? "CUT1002"}: ${diagnostic?.message ?? "invalid CUT source."}`, diagnostic ? { line: diagnostic.span.start.line, column: diagnostic.span.start.column } : undefined);
  }
  const versions = parsed.module.declarations.filter((declaration) => declaration.kind === "language");
  if (versions.length !== 1 || versions[0].kind !== "language" || versions[0].version !== "0.4") {
    fail("CUT_MIGRATE_LANGUAGE_VERSION", path, "typed CUT source must contain exactly one `cut 0.4;` declaration.");
  }
  const removedNarrationTranscript = checkCutModule(parsed.module).diagnostics.find((diagnostic) =>
    diagnostic.code === "CUT2059"
      && diagnostic.message === "Reference kernel cut.documentary.narration does not execute input “transcript”.",
  );
  if (removedNarrationTranscript) {
    fail(
      "CUT_MIGRATE_NARRATION_TRANSCRIPT_UNSAFE",
      path,
      `${removedNarrationTranscript.code}: ${removedNarrationTranscript.message} Source migration never guesses whether text should render; use Captions for visible timed text or Marker/Region with role: "transcript" and comment metadata for non-rendering notes.`,
      { line: removedNarrationTranscript.span.start.line, column: removedNarrationTranscript.span.start.column },
    );
  }
  return {
    report: baseReport(input, { kind: "cut-source", format: "cut-source", version: "0.4", language: "0.4" }, protectedInput),
  };
}

function canonicalizeArchivedIr(input: Uint8Array, archived: CutAVIR, path: string, protectedInput: boolean): CutMigrationAnalysis {
  const migrated = JSON.parse(stableJsonStringify(archived)) as CutAVIR;
  const legacyTranscript = Object.values(migrated.nodes).find((node) => node.op === "cut.documentary.narration" && Object.hasOwn(node.inputs, "transcript"));
  if (legacyTranscript) {
    fail(
      "CUT_MIGRATE_NARRATION_TRANSCRIPT_UNSAFE",
      path,
      `archived node ${legacyTranscript.id} contains metadata-only Narration transcript input with no semantics-preserving current CutAVIR migration. Keep the archive under explicit legacy mode; use OTIO --allow-lossy only for a separately reported omission, or author Captions/Marker/Region source explicitly.`,
      { line: legacyTranscript.provenance.span.start.line, column: legacyTranscript.provenance.span.start.column },
    );
  }
  const signalTypes = new Map<string, { expected: Set<string>; attachments: string[]; unresolved: string[] }>();
  for (const [nodeId, node] of Object.entries(migrated.nodes)) {
    const schema = referenceKernelSchema(node.op);
    for (const [property, value] of Object.entries(node.properties)) {
      if (!("signal" in value)) continue;
      const attachment = `nodes.${nodeId}.properties.${property}`;
      const entry = signalTypes.get(value.signal) ?? { expected: new Set<string>(), attachments: [], unresolved: [] };
      entry.attachments.push(attachment);
      const expected = schema?.support === "supported" ? kernelPropertyValueType(schema, property) : undefined;
      if (expected) entry.expected.add(expected);
      else entry.unresolved.push(`${node.op}.${property}`);
      signalTypes.set(value.signal, entry);
    }
  }
  const changedSignalTypes: string[] = [];
  for (const [id, signal] of Object.entries(migrated.signals)) {
    const binding = signalTypes.get(id);
    if (!binding || binding.unresolved.length || binding.expected.size !== 1) {
      const detail = !binding ? "has no attached property"
        : binding.unresolved.length ? `has properties without a declared closed-kernel type: ${binding.unresolved.sort().join(", ")}`
          : `is shared by incompatible property types: ${[...binding.expected].sort().join(", ")}`;
      fail("CUT_MIGRATE_SIGNAL_TYPE_AMBIGUOUS", path, `signal ${id} ${detail}; automatic type derivation is unsafe.`);
    }
    const expected = [...binding.expected][0]!;
    if (signal.valueType === "inferred") {
      signal.valueType = expected;
      changedSignalTypes.push(id);
    } else if (signal.valueType !== expected) {
      fail("CUT_MIGRATE_SIGNAL_TYPE_CONFLICT", path, `signal ${id} declares ${JSON.stringify(signal.valueType)} but its attached properties require ${expected}.`);
    }
  }
  const changedSignals: string[] = [];
  for (const [id, signal] of Object.entries(migrated.signals)) {
    const canonical = cutSignalContentHash(signal);
    if (signal.contentHash !== canonical) changedSignals.push(id);
    signal.contentHash = canonical;
  }
  const priorNodeHashes = new Map(Object.entries(migrated.nodes).map(([id, node]) => [id, node.contentHash]));
  const beforeBuildId = migrated.buildId;
  finalizeGraphHashes(migrated);
  const changedNodes = Object.entries(migrated.nodes).filter(([id, node]) => priorNodeHashes.get(id) !== node.contentHash).map(([id]) => id).sort();
  const changedDerivedFields = [
    ...changedSignalTypes.map((id) => `signals.${id}.valueType`),
    ...changedSignals.map((id) => `signals.${id}.contentHash`),
    ...changedNodes.map((id) => `nodes.${id}.contentHash`),
    ...(beforeBuildId === migrated.buildId ? [] : ["buildId"]),
  ].sort();
  if (!changedDerivedFields.length || migrated.buildId !== cutIrIdentity(migrated)) {
    fail("CUT_MIGRATE_PROOF_FAILED", path, "archived identity input did not produce a distinct canonical derived identity.");
  }
  const encoded = new TextEncoder().encode(`${stableJsonStringify(migrated)}\n`);
  const validated = loadCutAvIr(encoded);
  const semanticDiff = diffCutAVIR(archived, validated);
  if (semanticDiff.summary.total !== 0) {
    fail("CUT_MIGRATE_SEMANTIC_CHANGE", path, "refused migration because the public CutAVIR semantic diff is not empty.");
  }
  const report = baseReport(input, { kind: "cut-av-ir", format: "cut-av-ir", version: "3 archived identity", language: "0.4" }, protectedInput);
  report.status = "migration-available";
  report.compatibility = "migratable";
  report.transformation = { id: "cut-av-ir-v3-canonicalize-derived-identity", semantics: "unchanged", changedDerivedFields };
  report.output = { bytes: encoded.byteLength, sha256: sha256(encoded) };
  report.semanticDiff = semanticDiff;
  report.diagnostics = [{ code: "CUT_MIGRATE_AVAILABLE", severity: "info", message: "A verified archived CutAVIR v3 derived-identity encoding can be canonicalized with zero semantic audiovisual changes." }];
  return { report, output: encoded };
}

function analyzeIr(input: Uint8Array, root: Record<string, unknown>, path: string, protectedInput: boolean): CutMigrationAnalysis {
  if (root.version !== 3 || root.language !== "0.4") {
    fail("CUT_MIGRATE_IR_VERSION", path, `CutAVIR ${String(root.version)} / language ${String(root.language)} has no supported automatic migration to CutAVIR v3 / language 0.4.`);
  }
  try {
    loadCutAvIr(input);
    return { report: baseReport(input, { kind: "cut-av-ir", format: "cut-av-ir", version: "3", language: "0.4" }, protectedInput) };
  } catch (strictError) {
    try {
      const archived = loadCutAvIr(input, { identityMode: "legacy-0.3-compatible" });
      return canonicalizeArchivedIr(input, archived, path, protectedInput);
    } catch (legacyError) {
      if (legacyError instanceof CutMigrationError) throw legacyError;
      if (legacyError instanceof CutAvIrValidationError
        && legacyError.code === "CUT_IR_TYPE"
        && legacyError.path.startsWith("$.signals.")
        && !legacyError.path.endsWith(".valueType")) {
        fail("CUT_MIGRATE_SIGNAL_PAYLOAD_TYPE", path, `archived signal payload is incompatible with its uniquely derived property type (${legacyError.message}); migration refuses to relabel it.`);
      }
      // Preserve the strict public loader's precise stable diagnostic. The
      // compatibility loader is deliberately no more permissive except for the
      // single verified archived identity representation.
      throw strictError instanceof Error ? strictError : legacyError;
    }
  }
}

function analyzeLock(input: Uint8Array, root: Record<string, unknown>, path: string, protectedInput: boolean): CutMigrationAnalysis {
  if (root.version === 1 && root.language === "0.4") {
    fail("CUT_MIGRATE_LOCK_V1_UNSAFE", path, "cut.lock v1 cannot be safely rewritten: it omits selected-stream probes and native backend identity. Preserve it as evidence, then regenerate v2 from the exact source and resources with the current `cut lock`." );
  }
  if (root.version !== 2 || root.language !== "0.4") {
    fail("CUT_MIGRATE_LOCK_VERSION", path, `cut.lock ${String(root.version)} / language ${String(root.language)} has no supported automatic migration.`);
  }
  loadCutLock(input);
  return { report: baseReport(input, { kind: "cut-lock", format: "cut-lock", version: "2", language: "0.4" }, protectedInput) };
}

function analyzeProject(input: Uint8Array, root: Record<string, unknown>, path: string, protectedInput: boolean): CutMigrationAnalysis {
  if (root.version !== 1 || root.language !== "0.4") {
    fail("CUT_MIGRATE_PROJECT_VERSION", path, `cut-project ${String(root.version)} / language ${String(root.language)} has no supported automatic migration.`);
  }
  validateCutProjectManifest(root);
  return { report: baseReport(input, { kind: "cut-project", format: "cut-project", version: "1", language: "0.4" }, protectedInput) };
}

export function isFrozenCut03ArtifactPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes("/releases/0.3.0-alpha.1/") || normalized.endsWith("/releases/0.3.0-alpha.1");
}

type FileIdentity = { dev: bigint | number; ino: bigint | number };

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function containedLexically(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function frozenBoundary() {
  // From dist-cli/lib/language/migration.js this resolves to the package root.
  // Packed installs intentionally contain no frozen release, so absence means
  // there is no repository-owned immutable boundary to protect.
  const requested = resolve(__dirname, "../../../releases/0.3.0-alpha.1");
  try {
    const root = await realpath(requested), identity = await stat(root, { bigint: true });
    return { root, identity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function inodeContained(boundary: { root: string; identity: FileIdentity }, candidate: string) {
  let cursor = candidate;
  while (true) {
    const identity = await stat(cursor, { bigint: true });
    if (sameIdentity(boundary.identity, identity)) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

export type CutMigrationPathSafety = {
  input: { absolute: string; real: string; protected: boolean };
  output?: {
    requested: string;
    absolute: string;
    parentReal: string;
    parentIdentity: FileIdentity;
  };
};

/**
 * Resolve the migration read/write boundary before reading bytes. Frozen 0.3
 * containment is proved by canonical path and ancestor inode, so a symlink
 * alias cannot turn an apparent outside write into a release mutation.
 */
export async function inspectCutMigrationPaths(inputPath: string, outputPath?: string): Promise<CutMigrationPathSafety> {
  const inputAbsolute = resolve(inputPath);
  let inputMetadata;
  try { inputMetadata = await lstat(inputAbsolute); }
  catch (error) { fail("CUT_MIGRATE_INPUT_FILE", inputPath, `cannot inspect migration input (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`); }
  let inputReal: string;
  try { inputReal = await realpath(inputAbsolute); }
  catch (error) { fail("CUT_MIGRATE_INPUT_FILE", inputPath, `cannot resolve migration input (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`); }
  const boundary = await frozenBoundary();
  const protectedInput = boundary
    ? containedLexically(boundary.root, inputReal) || await inodeContained(boundary, inputReal)
    : isFrozenCut03ArtifactPath(inputReal);
  if (inputMetadata.isSymbolicLink()) {
    fail("CUT_MIGRATE_INPUT_SYMLINK", inputPath, protectedInput
      ? "refuses a symlink alias into the immutable CUT 0.4 release. Use the canonical frozen path for read-only --check evidence."
      : "migration input must be a regular, non-symlink file.");
  }
  if (!inputMetadata.isFile()) fail("CUT_MIGRATE_INPUT_FILE", inputPath, "migration input must be a regular file.");

  const result: CutMigrationPathSafety = { input: { absolute: inputAbsolute, real: inputReal, protected: protectedInput } };
  if (!outputPath) return result;

  const outputAbsolute = resolve(outputPath);
  if (outputAbsolute === inputAbsolute || outputAbsolute === inputReal) {
    fail("CUT_MIGRATE_IN_PLACE", outputPath, "in-place migration is forbidden; --out must name a distinct new file.");
  }
  try {
    await lstat(outputAbsolute);
    fail("CUT_MIGRATE_OUTPUT_EXISTS", outputPath, "migration output already exists; CUT never overwrites it.");
  } catch (error) {
    if (error instanceof CutMigrationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("CUT_MIGRATE_OUTPUT_FILE", outputPath, `cannot inspect migration output (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`);
  }
  const outputParent = dirname(outputAbsolute);
  let parentReal: string;
  try { parentReal = await realpath(outputParent); }
  catch (error) { fail("CUT_MIGRATE_OUTPUT_PARENT", outputPath, `output parent must already exist and resolve canonically (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`); }
  if (boundary && (containedLexically(boundary.root, parentReal) || await inodeContained(boundary, parentReal))) {
    fail("CUT_MIGRATE_FROZEN_WRITE", outputPath, "refuses to create migration output inside the immutable CUT 0.4 release boundary.");
  }
  const parentIdentity = await stat(parentReal, { bigint: true });
  result.output = { requested: outputAbsolute, absolute: resolve(parentReal, basename(outputAbsolute)), parentReal, parentIdentity };
  return result;
}

async function assertMigrationOutputParent(target: NonNullable<CutMigrationPathSafety["output"]>, phase: string) {
  try {
    const resolvedParent = await realpath(dirname(target.absolute));
    const identity = await stat(resolvedParent, { bigint: true });
    if (resolvedParent !== target.parentReal || !sameIdentity(identity, target.parentIdentity)) {
      fail("CUT_MIGRATE_OUTPUT_RACE", target.requested, `output parent changed ${phase}; no migration bytes were committed.`);
    }
  } catch (error) {
    if (error instanceof CutMigrationError) throw error;
    fail("CUT_MIGRATE_OUTPUT_RACE", target.requested, `output parent could not be revalidated ${phase} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); no migration bytes were committed.`);
  }
}

/**
 * Publish complete bytes without overwriting: a same-directory temporary file
 * is linked into place only after the write completes. `link` is the atomic,
 * no-clobber commit; cleanup touches only the temporary file created here.
 */
export async function writeCutMigrationOutput(target: NonNullable<CutMigrationPathSafety["output"]>, bytes: Uint8Array) {
  await assertMigrationOutputParent(target, "before staging");
  const path = target.absolute, directory = target.parentReal, name = basename(path);
  let temporary: string | undefined;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = resolve(directory, `.${name}.${process.pid}.${attempt}.cut-migrate.tmp`);
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      temporary = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("CUT_MIGRATE_OUTPUT_WRITE", path, `cannot stage migration output (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`);
    }
  }
  if (!temporary) fail("CUT_MIGRATE_OUTPUT_WRITE", path, "cannot reserve a same-directory migration staging file.");
  try {
    await assertMigrationOutputParent(target, "before atomic commit");
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("CUT_MIGRATE_OUTPUT_EXISTS", path, "migration output appeared concurrently; CUT did not overwrite it.");
      fail("CUT_MIGRATE_OUTPUT_WRITE", path, `cannot atomically publish migration output (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`);
    }
  } finally {
    // Do not resolve and unlink a reused path after a directory-swap race.
    // A hostile rename may strand our private staging inode in the moved
    // directory, which is safer than deleting an unrelated replacement path.
    try {
      await assertMigrationOutputParent(target, "before staging cleanup");
      await unlink(temporary).catch(() => undefined);
    } catch (error) {
      if (!(error instanceof CutMigrationError) || error.code !== "CUT_MIGRATE_OUTPUT_RACE") throw error;
    }
  }
}

/** Analyze bounded bytes without mutating caller storage or the filesystem. */
export function analyzeCutMigration(
  input: Uint8Array,
  options: { path?: string; protectedInput?: boolean } = {},
): CutMigrationAnalysis {
  const path = options.path ?? "<artifact>";
  const source = decodeUtf8(input, path);
  const trimmed = source.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const root = record(strictJson(source, path), path);
    if (root.format === "cut-av-ir") return analyzeIr(input, root, path, Boolean(options.protectedInput));
    if (root.format === "cut-lock") return analyzeLock(input, root, path, Boolean(options.protectedInput));
    if (root.format === "cut-project") return analyzeProject(input, root, path, Boolean(options.protectedInput));
    fail("CUT_MIGRATE_FORMAT", path, `JSON format ${JSON.stringify(root.format)} is not a supported CUT migration artifact.`);
  }
  return analyzeSource(input, source, path, Boolean(options.protectedInput));
}

/** Mark a proven plan as written without changing any evidence fields. */
export function completedCutMigrationReport(report: CutMigrationReport): CutMigrationReport {
  if (report.compatibility !== "migratable" || !report.output) fail("CUT_MIGRATE_NOT_NEEDED", "<artifact>", "the artifact is already current and has no migration output.");
  return { ...report, status: "migrated" };
}
