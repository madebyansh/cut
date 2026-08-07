import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { Declaration, LanguageDiagnostic, SourceSpan } from "../language/ast";
import { checkCutModule, type CutCheckOptions } from "../language/checker";
import { parseCutLanguage } from "../language/parser";
import { compareRational, zeroRational } from "../language/rational";
import {
  cutTypedDataAssetAuthorityForConstructor,
  type CutTypedDataAssetAuthorityV1,
} from "../language/typed-data-asset";
import {
  CutTypedDataAssetPayloadError,
  cutTypedDataAssetMaximumBytes,
  validateCutTypedDataAssetPayload,
} from "../language/typed-data-asset-bytes";
import { CutProjectError, resolveProjectFile, validateProjectLocator } from "./manifest";
import {
  probeProjectBytes,
  probeProjectDecodedAudioSamples,
  probeProjectDecodedVideoCadence,
  probeProjectImage,
  probeProjectMedia,
  type CutByteProbe,
  type CutImageProbe,
  type CutMediaProbe,
} from "./probe";

export const CUT_RELINK_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const CUT_RELINK_MAX_LOCATOR_BYTES = 4096;

type AssetKind = "video" | "audio" | "image" | "font" | "data";
type AssetType = "VideoAsset" | "AudioAsset" | "ImageAsset" | "FontAsset" | "DataAsset" | "CaptionAsset" | "TranscriptAsset" | "LUTAsset";
type AssetConstructorName = AssetKind | "caption" | "transcript" | "lut";

type SourceIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type RelinkProbe =
  | { kind: "media"; identity: CutMediaProbe; selectedStreamIndex: number }
  | { kind: "image"; identity: CutImageProbe }
  | { kind: "bytes"; identity: CutByteProbe; coverage: "bytes-only" };

export type CutRelinkReport = {
  format: "cut-relink-report";
  version: 1;
  status: "dry-run" | "written" | "unchanged";
  program: string;
  asset: {
    name: string;
    kind: AssetKind;
    type: AssetType;
    source: { line: number; column: number };
  };
  locator: { from: string; to: string };
  replacement: { startOffset: number; endOffset: number; offsetUnit: "utf16-code-unit" };
  source: { sha256Before: string; sha256After: string; changed: boolean };
  probe: RelinkProbe;
};

export type RelinkCutSourceOptions = {
  programPath: string;
  assetName: string;
  locator: string;
  write?: boolean;
  maxSourceBytes?: number;
  /** Already-resolved source package contracts for whole-program validation. */
  packages?: CutCheckOptions["packages"];
};

type ErrorOptions = {
  path?: string;
  span?: SourceSpan;
  hint?: string;
  diagnostics?: LanguageDiagnostic[];
};

/** Stable, source-aware failures for the public relink operation. */
export class CutRelinkError extends Error {
  readonly path?: string;
  readonly span?: SourceSpan;
  readonly source?: { path?: string; module?: string; line?: number; column?: number };
  readonly hint?: string;
  readonly diagnostics?: LanguageDiagnostic[];

  constructor(readonly code: string, message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = "CutRelinkError";
    this.path = options.path;
    this.span = options.span;
    this.hint = options.hint;
    this.diagnostics = options.diagnostics;
    if (options.path || options.span) {
      this.source = {
        ...(options.path ? { path: options.path, module: options.path } : {}),
        ...(options.span ? { line: options.span.start.line, column: options.span.start.column } : {}),
      };
    }
  }
}

type SourceSnapshot = {
  absolute: string;
  displayPath: string;
  bytes: Buffer;
  text: string;
  identity: SourceIdentity;
  mode: number;
};

type RelinkPlan = {
  report: CutRelinkReport;
  snapshot: SourceSnapshot;
  rewritten: string;
};

const constructorSpecs: Readonly<Record<AssetConstructorName, Readonly<{ kind: AssetKind; type: AssetType }>>> = Object.freeze({
  video: Object.freeze({ kind: "video", type: "VideoAsset" }),
  audio: Object.freeze({ kind: "audio", type: "AudioAsset" }),
  image: Object.freeze({ kind: "image", type: "ImageAsset" }),
  font: Object.freeze({ kind: "font", type: "FontAsset" }),
  data: Object.freeze({ kind: "data", type: "DataAsset" }),
  caption: Object.freeze({ kind: "data", type: "CaptionAsset" }),
  transcript: Object.freeze({ kind: "data", type: "TranscriptAsset" }),
  lut: Object.freeze({ kind: "data", type: "LUTAsset" }),
});

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function filesystemDetail(error: unknown) {
  const code = errorCode(error);
  return code ? `filesystem error ${code}` : "filesystem operation failed";
}

function identity(metadata: BigIntStats): SourceIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sourceError(code: string, message: string, snapshot: Pick<SourceSnapshot, "displayPath">, span?: SourceSpan, hint?: string) {
  return new CutRelinkError(code, message, { path: snapshot.displayPath, span, hint });
}

async function readSource(programPath: string, maxSourceBytes: number): Promise<SourceSnapshot> {
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0 || maxSourceBytes > CUT_RELINK_MAX_SOURCE_BYTES) {
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_LIMIT_INVALID",
      `maxSourceBytes must be a positive safe integer no greater than ${CUT_RELINK_MAX_SOURCE_BYTES}.`,
    );
  }
  const requested = resolve(programPath), displayPath = basename(requested);
  let absolute: string;
  try {
    absolute = resolve(await realpath(dirname(requested)), displayPath);
  } catch (error) {
    throw new CutRelinkError(
      errorCode(error) === "ENOENT" ? "CUT_RELINK_SOURCE_MISSING" : "CUT_RELINK_SOURCE_UNREADABLE",
      `Cannot resolve the CUT source directory for ${displayPath}: ${filesystemDetail(error)}.`,
      { path: displayPath },
    );
  }
  let before: BigIntStats;
  try {
    before = await lstat(absolute, { bigint: true });
  } catch (error) {
    throw new CutRelinkError(
      errorCode(error) === "ENOENT" ? "CUT_RELINK_SOURCE_MISSING" : "CUT_RELINK_SOURCE_UNREADABLE",
      `Cannot inspect CUT source ${displayPath}: ${filesystemDetail(error)}.`,
      { path: displayPath },
    );
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_NOT_REGULAR",
      "Relink accepts only a regular, non-symlink CUT source file.",
      { path: displayPath },
    );
  }
  if (before.size > BigInt(maxSourceBytes)) {
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_TOO_LARGE",
      `CUT source exceeds the ${maxSourceBytes}-byte relink budget.`,
      { path: displayPath },
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_UNREADABLE",
      `Cannot read CUT source ${displayPath}: ${filesystemDetail(error)}.`,
      { path: displayPath },
    );
  }
  let after: BigIntStats;
  try {
    after = await lstat(absolute, { bigint: true });
  } catch {
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_CHANGED",
      "CUT source changed, disappeared, or was replaced while relink was reading it; no edit was made.",
      { path: displayPath },
    );
  }
  if (!sameIdentity(identity(before), identity(after)) || BigInt(bytes.byteLength) !== before.size) {
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_CHANGED",
      "CUT source changed or was replaced while relink was reading it; no edit was made.",
      { path: displayPath },
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_UTF8",
      "CUT source is not valid UTF-8; no edit was made.",
      { path: displayPath },
    );
  }
  return { absolute, displayPath, bytes, text, identity: identity(before), mode: Number(before.mode & 0o777n) };
}

function validateAssetName(assetName: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(assetName) || Buffer.byteLength(assetName, "utf8") > 256) {
    throw new CutRelinkError(
      "CUT_RELINK_ASSET_NAME_INVALID",
      "--asset must be one bounded CUT identifier.",
    );
  }
}

function parseAndLocate(snapshot: SourceSnapshot, assetName: string, packages?: CutCheckOptions["packages"]) {
  const parsed = parseCutLanguage(snapshot.text);
  if (!parsed.module) {
    throw new CutRelinkError("CUT_RELINK_SOURCE_INVALID", "CUT source does not parse.", {
      path: snapshot.displayPath,
      diagnostics: parsed.diagnostics,
    });
  }
  const named = parsed.module.declarations.filter((declaration) => "name" in declaration && declaration.name === assetName);
  const assets = named.filter((declaration): declaration is Extract<Declaration, { kind: "asset" }> => declaration.kind === "asset");
  if (assets.length > 1) {
    throw sourceError(
      "CUT_RELINK_ASSET_AMBIGUOUS",
      `Asset ${JSON.stringify(assetName)} is declared more than once; relink refuses an ambiguous edit.`,
      snapshot,
      assets[1].span,
      "Remove the duplicate declaration before relinking.",
    );
  }
  if (!assets.length && named.length) {
    throw sourceError(
      "CUT_RELINK_NOT_ASSET",
      `${JSON.stringify(assetName)} is a ${named[0].kind} declaration, not an asset declaration.`,
      snapshot,
      named[0].span,
    );
  }
  if (!assets.length) {
    throw new CutRelinkError(
      "CUT_RELINK_ASSET_MISSING",
      `CUT source has no asset declaration named ${JSON.stringify(assetName)}.`,
      { path: snapshot.displayPath },
    );
  }

  const checked = checkCutModule(parsed.module, { packages });
  if (checked.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new CutRelinkError("CUT_RELINK_SOURCE_INVALID", "CUT source does not type-check.", {
      path: snapshot.displayPath,
      diagnostics: checked.diagnostics,
    });
  }

  const declaration = assets[0], initializer = declaration.value;
  if (initializer.kind !== "call" || initializer.callee.kind !== "identifier" || !(initializer.callee.name in constructorSpecs)) {
    throw sourceError(
      "CUT_RELINK_NOT_FILE_ASSET",
      `Asset ${JSON.stringify(assetName)} is not initialized by a supported file-backed asset constructor.`,
      snapshot,
      declaration.value.span,
      "Relink supports video, audio, image, font, data, caption, transcript, and lut asset constructors.",
    );
  }
  const constructor = initializer.callee.name as AssetConstructorName;
  const spec = constructorSpecs[constructor];
  const pathArguments = [
    ...initializer.positional.slice(0, 1),
    ...initializer.named.filter((argument) => argument.name === "path").map((argument) => argument.value),
  ];
  if (pathArguments.length !== 1 || pathArguments[0].kind !== "string") {
    throw sourceError(
      "CUT_RELINK_LITERAL_REQUIRED",
      `Asset ${JSON.stringify(assetName)} must use one inline string literal for relink to preserve every other source byte.`,
      snapshot,
      declaration.value.span,
      `Use ${constructor}("project-relative/path") directly in this asset declaration.`,
    );
  }
  const authoredFormat = initializer.named.find((argument) => argument.name === "format")?.value
    ?? initializer.positional[1];
  const byteAuthority = cutTypedDataAssetAuthorityForConstructor(
    `cut.asset.${constructor}`,
    authoredFormat?.kind === "string" ? authoredFormat.value : undefined,
  );
  return { constructor, ...spec, byteAuthority, locatorLiteral: pathArguments[0] };
}

async function rejectSymlinkSegments(projectRoot: string, locator: string, snapshot: SourceSnapshot, span: SourceSpan) {
  const physicalRoot = await realpath(projectRoot);
  let candidate = physicalRoot;
  for (const segment of locator.split("/")) {
    candidate = resolve(candidate, segment);
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        throw sourceError(
          "CUT_RELINK_TARGET_MISSING",
          `Replacement resource does not exist: ${locator}`,
          snapshot,
          span,
        );
      }
      throw sourceError(
        "CUT_RELINK_TARGET_UNREADABLE",
        `Cannot inspect replacement resource ${locator}: ${filesystemDetail(error)}.`,
        snapshot,
        span,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw sourceError(
        "CUT_RELINK_TARGET_SYMLINK",
        `Replacement resource traverses a symbolic link: ${locator}`,
        snapshot,
        span,
        "Relink requires a direct regular file inside the project root.",
      );
    }
  }
}

function positive(value: { numerator: string; denominator: string } | undefined) {
  return Boolean(value && compareRational(value, zeroRational) > 0);
}

async function probeReplacement(
  projectRoot: string,
  locator: string,
  kind: AssetKind,
  type: AssetType,
  byteAuthority: CutTypedDataAssetAuthorityV1 | undefined,
  snapshot: SourceSnapshot,
  span: SourceSpan,
): Promise<RelinkProbe> {
  await rejectSymlinkSegments(projectRoot, locator, snapshot, span);
  try {
    // Resolve once before invoking the bounded probes so path-escape failures
    // cannot be misreported as codec/type failures.
    await resolveProjectFile(projectRoot, locator);
    if (kind === "video" || kind === "audio") {
      const identity = await probeProjectMedia(projectRoot, locator);
      const selected = identity.streams.find((stream) => stream.type === kind);
      const valid = selected
        && positive(selected.timeBase)
        && (kind === "video" ? Boolean(selected.width && selected.height) : Boolean(selected.sampleRate && selected.channels));
      if (!valid) {
        throw sourceError(
          "CUT_RELINK_KIND_MISMATCH",
          `Replacement ${locator} is not a lockable ${type} resource.`,
          snapshot,
          span,
          kind === "video" ? "A video stream needs exact dimensions, time base, and duration." : "An audio stream needs exact sample rate, channels, time base, and duration.",
        );
      }
      // Relink promises constructor-compatible media, not merely a plausible
      // ffprobe row. A Matroska stream may omit stream-level duration while
      // still being safely lockable through CUT's decoded cadence/sample
      // witness. Exercise the same bounded witness path used by cut.lock so a
      // dry run neither rejects valid media nor accepts a resource that the
      // rewritten project cannot subsequently lock.
      if (kind === "video") {
        await probeProjectDecodedVideoCadence(projectRoot, locator, identity, selected.index);
      } else {
        await probeProjectDecodedAudioSamples(projectRoot, locator, identity, selected.index);
      }
      await rejectSymlinkSegments(projectRoot, locator, snapshot, span);
      return { kind: "media", identity, selectedStreamIndex: selected.index };
    }
    if (kind === "image") {
      const identity = await probeProjectImage(projectRoot, locator);
      await rejectSymlinkSegments(projectRoot, locator, snapshot, span);
      return { kind: "image", identity };
    }
    const identity = await probeProjectBytes(projectRoot, locator, byteAuthority
      ? { maxFileBytes: cutTypedDataAssetMaximumBytes[byteAuthority.kind] }
      : undefined);
    if (byteAuthority) {
      const resolved = await resolveProjectFile(projectRoot, locator);
      const bytes = await readFile(resolved);
      if (bytes.byteLength !== identity.file.bytes || sha256(bytes) !== identity.file.sha256) {
        throw sourceError(
          "CUT_RELINK_TARGET_CHANGED",
          `Replacement ${locator} changed between its bounded probe and typed payload validation.`,
          snapshot,
          span,
        );
      }
      validateCutTypedDataAssetPayload(byteAuthority, bytes, "$.replacement.byteAuthority", {
        id: "relink_candidate",
        module: snapshot.displayPath,
        line: span.start.line,
        column: span.start.column,
      });
    }
    await rejectSymlinkSegments(projectRoot, locator, snapshot, span);
    return { kind: "bytes", identity, coverage: "bytes-only" };
  } catch (error) {
    if (error instanceof CutRelinkError) throw error;
    if (error instanceof CutTypedDataAssetPayloadError) {
      throw sourceError(
        "CUT_RELINK_TARGET_INVALID",
        `Replacement ${locator} cannot satisfy ${type}: ${error.message}`,
        snapshot,
        span,
        `Typed payload diagnostic: ${error.code}.`,
      );
    }
    const projectCode = error instanceof CutProjectError ? error.code : errorCode(error);
    const detail = error instanceof CutProjectError ? error.message : filesystemDetail(error);
    throw sourceError(
      kind === "image" ? "CUT_RELINK_KIND_MISMATCH" : "CUT_RELINK_TARGET_INVALID",
      `Replacement ${locator} cannot satisfy ${type}: ${detail}`,
      snapshot,
      span,
      projectCode ? `Underlying project diagnostic: ${projectCode}.` : undefined,
    );
  }
}

function validateLocator(locator: string, snapshot: SourceSnapshot, span: SourceSpan) {
  if (Buffer.byteLength(locator, "utf8") > CUT_RELINK_MAX_LOCATOR_BYTES) {
    throw sourceError(
      "CUT_RELINK_LOCATOR_TOO_LARGE",
      `Replacement locator exceeds ${CUT_RELINK_MAX_LOCATOR_BYTES} UTF-8 bytes.`,
      snapshot,
      span,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(locator)) {
    throw sourceError(
      "CUT_RELINK_LOCATOR_UNSAFE",
      "Replacement locator cannot contain control characters.",
      snapshot,
      span,
    );
  }
  try {
    return validateProjectLocator(locator, "replacement locator");
  } catch (error) {
    throw sourceError(
      "CUT_RELINK_LOCATOR_UNSAFE",
      error instanceof Error ? error.message : String(error),
      snapshot,
      span,
      "Use a non-empty project-relative POSIX path without dot, parent, empty, or backslash segments.",
    );
  }
}

function assertRewrittenSource(snapshot: SourceSnapshot, rewritten: string, packages?: CutCheckOptions["packages"]) {
  const parsed = parseCutLanguage(rewritten);
  if (!parsed.module) {
    throw new CutRelinkError("CUT_RELINK_INTERNAL_INVALID", "Relink produced source that does not parse; no edit was made.", {
      path: snapshot.displayPath,
      diagnostics: parsed.diagnostics,
    });
  }
  const checked = checkCutModule(parsed.module, { packages });
  if (checked.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new CutRelinkError("CUT_RELINK_INTERNAL_INVALID", "Relink produced source that does not type-check; no edit was made.", {
      path: snapshot.displayPath,
      diagnostics: checked.diagnostics,
    });
  }
}

async function planCutRelink(options: RelinkCutSourceOptions): Promise<RelinkPlan> {
  validateAssetName(options.assetName);
  const snapshot = await readSource(options.programPath, options.maxSourceBytes ?? CUT_RELINK_MAX_SOURCE_BYTES);
  const located = parseAndLocate(snapshot, options.assetName, options.packages);
  const locator = validateLocator(options.locator, snapshot, located.locatorLiteral.span);
  const projectRoot = dirname(snapshot.absolute);
  const probe = await probeReplacement(
    projectRoot,
    locator,
    located.kind,
    located.type,
    located.byteAuthority,
    snapshot,
    located.locatorLiteral.span,
  );
  const encoded = JSON.stringify(locator);
  const { start, end } = located.locatorLiteral.span;
  const rewritten = `${snapshot.text.slice(0, start.offset)}${encoded}${snapshot.text.slice(end.offset)}`;
  assertRewrittenSource(snapshot, rewritten, options.packages);
  const changed = snapshot.text !== rewritten;
  return {
    snapshot,
    rewritten,
    report: {
      format: "cut-relink-report",
      version: 1,
      status: changed ? "dry-run" : "unchanged",
      program: snapshot.displayPath,
      asset: {
        name: options.assetName,
        kind: located.kind,
        type: located.type,
        source: { line: located.locatorLiteral.span.start.line, column: located.locatorLiteral.span.start.column },
      },
      locator: { from: located.locatorLiteral.value, to: locator },
      replacement: { startOffset: start.offset, endOffset: end.offset, offsetUnit: "utf16-code-unit" },
      source: { sha256Before: sha256(snapshot.bytes), sha256After: sha256(rewritten), changed },
      probe,
    },
  };
}

async function assertSourceUnchanged(snapshot: SourceSnapshot) {
  let current;
  try {
    current = await readSource(snapshot.absolute, CUT_RELINK_MAX_SOURCE_BYTES);
  } catch (error) {
    if (error instanceof CutRelinkError && error.code === "CUT_RELINK_SOURCE_CHANGED") throw error;
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_CHANGED",
      "CUT source changed, disappeared, or became unsafe before relink could commit; no edit was made.",
      { path: snapshot.displayPath },
    );
  }
  if (!sameIdentity(snapshot.identity, current.identity) || !snapshot.bytes.equals(current.bytes)) {
    throw new CutRelinkError(
      "CUT_RELINK_SOURCE_CHANGED",
      "CUT source changed or was replaced before relink could commit; no edit was made.",
      { path: snapshot.displayPath },
    );
  }
}

async function commitPlan(plan: RelinkPlan) {
  if (!plan.report.source.changed) return plan.report;
  const temporary = resolve(
    dirname(plan.snapshot.absolute),
    `.${basename(plan.snapshot.absolute)}.${process.pid}.${randomBytes(8).toString("hex")}.cut-relink.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", plan.snapshot.mode);
    await handle.writeFile(plan.rewritten, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSourceUnchanged(plan.snapshot);
    await rename(temporary, plan.snapshot.absolute);
    renamed = true;
    directoryHandle = await open(dirname(plan.snapshot.absolute), "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
  } catch (error) {
    if (error instanceof CutRelinkError) throw error;
    throw new CutRelinkError(
      renamed ? "CUT_RELINK_DIRECTORY_SYNC_FAILED" : "CUT_RELINK_WRITE_FAILED",
      renamed
        ? `Relink replaced the source, but could not confirm parent-directory durability: ${filesystemDetail(error)}.`
        : `Cannot commit the atomic relink edit: ${filesystemDetail(error)}.`,
      { path: plan.snapshot.displayPath },
    );
  } finally {
    await handle?.close();
    await directoryHandle?.close();
    await rm(temporary, { force: true });
  }
  return { ...plan.report, status: "written" as const };
}

/**
 * Validate and plan one deterministic asset relink. Dry-run is the default;
 * write mode atomically replaces only the authored locator string literal.
 */
export async function relinkCutSource(options: RelinkCutSourceOptions): Promise<CutRelinkReport> {
  const plan = await planCutRelink(options);
  return options.write ? commitPlan(plan) : plan.report;
}
