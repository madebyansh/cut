import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { boundedDiagnosticString } from "../core/stable";
import { validateProjectLocator } from "./manifest";

export type StagedFilePublication = Readonly<{
  /** Omitted for backwards compatibility; a staged regular file replaces the destination. */
  action?: "replace";
  staged: string;
  destination: string;
  /** Lower values publish first; equal values retain canonical destination ordering. */
  order?: number;
  /** Stable caller-owned evidence exposed only to deterministic test hooks. */
  role?: string;
  expectedDestinationSnapshot?: StagedFileDestinationSnapshot;
}> | Readonly<{
  /** Remove an existing destination through the same backup/rollback boundary. */
  action: "remove";
  destination: string;
  order?: number;
  role?: string;
  expectedDestinationSnapshot?: StagedFileDestinationSnapshot;
}>;

export type StagedFileDestinationSnapshot = Readonly<
  | { state: "absent" }
  | { state: "present"; kind: "file" | "symlink"; dev: number | bigint; ino: number | bigint }
>;

export type CreateOnlyStagedFilePublication = Readonly<{
  staged: string;
  destination: string;
  order?: number;
  role?: string;
}>;

export type ProjectArtifactWrite = Readonly<{
  destination: string;
  contents: string | Uint8Array;
  /** Lower values publish first; equal values retain canonical destination ordering. */
  order?: number;
  /** Stable caller-owned evidence exposed only to deterministic test hooks. */
  role?: string;
}>;

export type StagedFileTransactionErrorCode =
  | "CUT_PUBLISH_EXISTS"
  | "CUT_PUBLISH_PREFLIGHT"
  | "CUT_PUBLISH_COMMIT"
  | "CUT_PUBLISH_ROLLBACK";

export class StagedFileTransactionError extends Error {
  constructor(
    readonly code: StagedFileTransactionErrorCode,
    message: string,
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "StagedFileTransactionError";
  }
}

/** @internal Test-only fault point; production callers use publishStagedFileTransaction. */
export type StagedFileTransactionFaultPoint = Readonly<{
  phase: "backup" | "promotion" | "rollback-new" | "rollback-backup";
  timing: "before" | "after";
  index: number;
  action: "replace" | "remove";
  staged?: string;
  destination: string;
  order: number;
  role?: string;
}>;

/** @internal Test-only controls for deterministic fault/device simulation. */
export type StagedFileTransactionTestHooks = Readonly<{
  fault?: (point: StagedFileTransactionFaultPoint) => void | Promise<void>;
  device?: (path: string, role: "staged" | "destination-parent", observed: number | bigint) => number | bigint;
}>;

type EntrySnapshot = Readonly<{
  kind: "file" | "symlink" | "directory";
  dev: number | bigint;
  ino: number | bigint;
}>;

type PreparedPublication = Readonly<{
  action: "replace" | "remove";
  staged?: string;
  destination: string;
  parent: string;
  backup: string;
  order: number;
  role?: string;
  stagedSnapshot?: EntrySnapshot;
  parentSnapshot: EntrySnapshot;
  destinationSnapshot?: EntrySnapshot;
  destinationSymlinkTarget?: string;
}>;

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function inside(root: string, candidate: string) {
  const local = relative(root, candidate);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function foldedPath(path: string) {
  return path.normalize("NFC").toLowerCase().normalize("NFC");
}

function snapshot(metadata: Awaited<ReturnType<typeof lstat>>, kind: EntrySnapshot["kind"]): EntrySnapshot {
  return { kind, dev: metadata.dev, ino: metadata.ino };
}

function sameSnapshot(metadata: Awaited<ReturnType<typeof lstat>>, expected: EntrySnapshot) {
  const kind = metadata.isSymbolicLink() ? "symlink" : metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : undefined;
  return kind === expected.kind && metadata.dev === expected.dev && metadata.ino === expected.ino;
}

async function optionalEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Capture a destination leaf for an optional caller-owned compare-and-swap precondition. */
export async function snapshotStagedFileDestination(path: string): Promise<StagedFileDestinationSnapshot> {
  const destination = resolve(path), metadata = await optionalEntry(destination);
  if (!metadata) return Object.freeze({ state: "absent" as const });
  const kind = metadata.isSymbolicLink() ? "symlink" as const : metadata.isFile() ? "file" as const : undefined;
  if (!kind) preflightFailure(`destination ${boundedDiagnosticString(destination)} cannot be snapshotted because it is not a regular file or leaf symlink.`, destination);
  return Object.freeze({ state: "present" as const, kind, dev: metadata.dev, ino: metadata.ino });
}

function normalizeExpectedDestinationSnapshot(value: unknown, path: string): StagedFileDestinationSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) {
    preflightFailure(`expected destination snapshot for ${boundedDiagnosticString(path)} is malformed.`, path);
  }
  const record = value as Record<string, unknown>, keys = Object.keys(record).sort();
  if (record.state === "absent" && keys.length === 1 && keys[0] === "state") return Object.freeze({ state: "absent" });
  if (record.state !== "present" || (record.kind !== "file" && record.kind !== "symlink")
    || keys.join(",") !== "dev,ino,kind,state"
    || !(typeof record.dev === "number" || typeof record.dev === "bigint")
    || !(typeof record.ino === "number" || typeof record.ino === "bigint")) {
    preflightFailure(`expected destination snapshot for ${boundedDiagnosticString(path)} is malformed.`, path);
  }
  return Object.freeze({ state: "present", kind: record.kind, dev: record.dev, ino: record.ino });
}

function matchesExpectedDestination(metadata: Awaited<ReturnType<typeof lstat>> | undefined, expected: StagedFileDestinationSnapshot) {
  if (expected.state === "absent") return metadata === undefined;
  return metadata !== undefined && sameSnapshot(metadata, expected);
}

function preflightFailure(message: string, path?: string, cause?: unknown): never {
  throw new StagedFileTransactionError(
    "CUT_PUBLISH_PREFLIGHT",
    message,
    path,
    cause === undefined ? undefined : { cause },
  );
}

function observedDevice(
  hooks: StagedFileTransactionTestHooks,
  path: string,
  role: "staged" | "destination-parent",
  observed: number | bigint,
) {
  return hooks.device?.(path, role, observed) ?? observed;
}

async function prepareStagedFileTransaction(
  publications: readonly StagedFilePublication[],
  hooks: StagedFileTransactionTestHooks,
) {
  if (!publications.length) preflightFailure("a staged-file transaction needs at least one publication.");
  const transactionId = `${process.pid}-${randomUUID()}`;
  const candidates = publications.map((publication) => {
    const order = publication.order ?? 0;
    if (!Number.isSafeInteger(order)) preflightFailure(`publication order for ${boundedDiagnosticString(publication.destination)} must be a safe integer.`, publication.destination);
    if (publication.role !== undefined && publication.role.length === 0) preflightFailure(`publication role for ${boundedDiagnosticString(publication.destination)} must not be empty.`, publication.destination);
    const common = {
      destination: resolve(publication.destination),
      order,
      ...(publication.role === undefined ? {} : { role: publication.role }),
      ...(publication.expectedDestinationSnapshot === undefined ? {} : {
        expectedDestinationSnapshot: normalizeExpectedDestinationSnapshot(publication.expectedDestinationSnapshot, publication.destination),
      }),
    };
    return publication.action === "remove"
      ? { action: "remove" as const, ...common }
      : { action: "replace" as const, staged: resolve(publication.staged), ...common };
  }).sort((left, right) => left.order - right.order || compareText(foldedPath(left.destination), foldedPath(right.destination)) || compareText(left.destination, right.destination));
  const prepared: PreparedPublication[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const requestedParent = dirname(candidate.destination);
    let parentMetadata: Awaited<ReturnType<typeof lstat>>;
    try {
      parentMetadata = await lstat(requestedParent);
    } catch (error) {
      preflightFailure(`cannot inspect destination parent ${boundedDiagnosticString(requestedParent)} (${errorCode(error) ?? "UNKNOWN"}).`, requestedParent, error);
    }
    if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
      preflightFailure(`destination parent ${boundedDiagnosticString(requestedParent)} must be a direct, non-symlink directory.`, requestedParent);
    }
    let parent: string;
    try {
      parent = await realpath(requestedParent);
    } catch (error) {
      preflightFailure(`cannot resolve destination parent ${boundedDiagnosticString(requestedParent)} (${errorCode(error) ?? "UNKNOWN"}).`, requestedParent, error);
    }
    const destination = resolve(parent, basename(candidate.destination));

    let stagedMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
    let staged: string | undefined;
    if (candidate.action === "replace") {
      try {
        stagedMetadata = await lstat(candidate.staged);
      } catch (error) {
        preflightFailure(`cannot inspect staged file ${boundedDiagnosticString(candidate.staged)} (${errorCode(error) ?? "UNKNOWN"}).`, candidate.staged, error);
      }
      if (stagedMetadata.isSymbolicLink() || !stagedMetadata.isFile()) {
        preflightFailure(`staged path ${boundedDiagnosticString(candidate.staged)} must be a regular file, not a symlink, directory, or device.`, candidate.staged);
      }
      try {
        staged = await realpath(candidate.staged);
      } catch (error) {
        preflightFailure(`cannot resolve staged file ${boundedDiagnosticString(candidate.staged)} (${errorCode(error) ?? "UNKNOWN"}).`, candidate.staged, error);
      }
    }
    let destinationMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      destinationMetadata = await optionalEntry(destination);
    } catch (error) {
      preflightFailure(`cannot inspect destination ${boundedDiagnosticString(destination)} (${errorCode(error) ?? "UNKNOWN"}).`, destination, error);
    }
    if (destinationMetadata && !destinationMetadata.isFile() && !destinationMetadata.isSymbolicLink()) {
      preflightFailure(`destination ${boundedDiagnosticString(destination)} must be absent, a regular file, or a leaf symlink; directories and devices are refused.`, destination);
    }
    let destinationSymlinkTarget: string | undefined;
    if (destinationMetadata?.isSymbolicLink()) {
      try { destinationSymlinkTarget = await readlink(destination); }
      catch (error) { preflightFailure(`cannot inspect destination symlink ${boundedDiagnosticString(destination)} (${errorCode(error) ?? "UNKNOWN"}).`, destination, error); }
    }
    if (candidate.expectedDestinationSnapshot && !matchesExpectedDestination(destinationMetadata, candidate.expectedDestinationSnapshot)) {
      preflightFailure(`destination ${boundedDiagnosticString(destination)} does not match the caller's expected snapshot.`, destination);
    }
    if (staged && stagedMetadata && observedDevice(hooks, staged, "staged", stagedMetadata.dev) !== observedDevice(hooks, parent, "destination-parent", parentMetadata.dev)) {
      preflightFailure(`staged file ${boundedDiagnosticString(staged)} is not on the destination filesystem for ${boundedDiagnosticString(destination)}.`, staged);
    }
    if (stagedMetadata && destinationMetadata && stagedMetadata.dev === destinationMetadata.dev && stagedMetadata.ino === destinationMetadata.ino) {
      preflightFailure(`staged file and destination are the same filesystem entry at ${boundedDiagnosticString(destination)}.`, destination);
    }
    const backup = resolve(parent, `.${basename(destination)}.cut-${transactionId}-${String(index).padStart(4, "0")}.bak`);
    let backupMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      backupMetadata = await optionalEntry(backup);
    } catch (error) {
      preflightFailure(`cannot inspect hidden backup path ${boundedDiagnosticString(backup)} (${errorCode(error) ?? "UNKNOWN"}).`, backup, error);
    }
    if (backupMetadata) preflightFailure(`hidden backup path already exists at ${boundedDiagnosticString(backup)}.`, backup);

    prepared.push({
      action: candidate.action,
      ...(staged === undefined ? {} : { staged }),
      destination,
      parent,
      backup,
      order: candidate.order,
      ...(candidate.role === undefined ? {} : { role: candidate.role }),
      ...(stagedMetadata === undefined ? {} : { stagedSnapshot: snapshot(stagedMetadata, "file") }),
      parentSnapshot: snapshot(parentMetadata, "directory"),
      ...(destinationMetadata ? { destinationSnapshot: snapshot(destinationMetadata, destinationMetadata.isSymbolicLink() ? "symlink" : "file") } : {}),
      ...(destinationSymlinkTarget === undefined ? {} : { destinationSymlinkTarget }),
    });
  }

  const destinations = new Map<string, string>();
  const stages = new Map<string, string>();
  for (const entry of prepared) {
    const destinationIdentity = foldedPath(entry.destination), previousDestination = destinations.get(destinationIdentity);
    if (previousDestination) {
      preflightFailure(`destinations ${boundedDiagnosticString(previousDestination)} and ${boundedDiagnosticString(entry.destination)} collide after canonical case folding.`, entry.destination);
    }
    destinations.set(destinationIdentity, entry.destination);
    if (entry.staged) {
      const stagedIdentity = foldedPath(entry.staged), previousStage = stages.get(stagedIdentity);
      if (previousStage) preflightFailure(`staged files ${boundedDiagnosticString(previousStage)} and ${boundedDiagnosticString(entry.staged)} are not unique.`, entry.staged);
      stages.set(stagedIdentity, entry.staged);
    }
  }
  for (const entry of prepared) {
    if (!entry.staged) continue;
    const collision = destinations.get(foldedPath(entry.staged));
    if (collision) preflightFailure(`staged file ${boundedDiagnosticString(entry.staged)} collides with destination ${boundedDiagnosticString(collision)}.`, entry.staged);
  }

  // Revalidate every snapshot before the first rename. This closes ordinary
  // preparation races; callers must still serialize concurrent transactions.
  for (const entry of prepared) {
    const [parentMetadata, stagedMetadata, destinationMetadata] = await Promise.all([
      lstat(entry.parent),
      entry.staged ? lstat(entry.staged) : Promise.resolve(undefined),
      optionalEntry(entry.destination),
    ]).catch((error) => preflightFailure(`publication inputs changed during preflight (${errorCode(error) ?? "UNKNOWN"}).`, entry.destination, error));
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || parentMetadata.dev !== entry.parentSnapshot.dev || parentMetadata.ino !== entry.parentSnapshot.ino) {
      preflightFailure(`destination parent changed during preflight at ${boundedDiagnosticString(entry.parent)}.`, entry.parent);
    }
    if (entry.staged && entry.stagedSnapshot && (!stagedMetadata || !sameSnapshot(stagedMetadata, entry.stagedSnapshot))) preflightFailure(`staged file changed during preflight at ${boundedDiagnosticString(entry.staged)}.`, entry.staged);
    if (entry.destinationSnapshot) {
      if (!destinationMetadata || !sameSnapshot(destinationMetadata, entry.destinationSnapshot)) preflightFailure(`destination changed during preflight at ${boundedDiagnosticString(entry.destination)}.`, entry.destination);
    } else if (destinationMetadata) preflightFailure(`destination appeared during preflight at ${boundedDiagnosticString(entry.destination)}.`, entry.destination);
  }
  return prepared;
}

async function invokeFault(
  hooks: StagedFileTransactionTestHooks,
  phase: StagedFileTransactionFaultPoint["phase"],
  timing: StagedFileTransactionFaultPoint["timing"],
  index: number,
  entry: PreparedPublication,
) {
  await hooks.fault?.({
    phase,
    timing,
    index,
    action: entry.action,
    ...(entry.staged === undefined ? {} : { staged: entry.staged }),
    destination: entry.destination,
    order: entry.order,
    ...(entry.role === undefined ? {} : { role: entry.role }),
  });
}

async function rollbackStagedFileTransaction(
  promoted: readonly PreparedPublication[],
  backedUp: readonly PreparedPublication[],
  ordered: readonly PreparedPublication[],
  hooks: StagedFileTransactionTestHooks,
) {
  const failures: Array<{ error: unknown; path: string }> = [];
  const indexes = new Map(ordered.map((entry, index) => [entry.destination, index]));
  for (const entry of [...promoted].reverse()) {
    const index = indexes.get(entry.destination)!;
    try {
      await invokeFault(hooks, "rollback-new", "before", index, entry);
      if (!entry.staged || !entry.stagedSnapshot) throw new Error(`promoted publication has no staged path (${entry.destination})`);
      const destinationMetadata = await lstat(entry.destination);
      if (!sameSnapshot(destinationMetadata, entry.stagedSnapshot)) throw new Error(`promoted destination inode changed before rollback (${entry.destination})`);
      if (await optionalEntry(entry.staged)) throw new Error(`staged path appeared before promoted rollback (${entry.staged})`);
      await link(entry.destination, entry.staged);
      const restoredStage = await lstat(entry.staged);
      if (!sameSnapshot(restoredStage, entry.stagedSnapshot)) throw new Error(`promoted rollback did not preserve the staged inode (${entry.staged})`);
      await unlink(entry.destination);
      await invokeFault(hooks, "rollback-new", "after", index, entry);
    } catch (error) {
      failures.push({ error, path: entry.destination });
    }
  }
  for (const entry of [...backedUp].reverse()) {
    const index = indexes.get(entry.destination)!;
    try {
      await invokeFault(hooks, "rollback-backup", "before", index, entry);
      if (!entry.destinationSnapshot) throw new Error(`backed-up publication has no prior destination snapshot (${entry.destination})`);
      const backupMetadata = await lstat(entry.backup);
      if (!sameSnapshot(backupMetadata, entry.destinationSnapshot)) throw new Error(`backup inode changed before rollback (${entry.backup})`);
      if (await optionalEntry(entry.destination)) throw new Error(`destination appeared before backup rollback (${entry.destination})`);
      if (entry.destinationSnapshot.kind === "symlink") {
        const target = await readlink(entry.backup);
        if (entry.destinationSymlinkTarget === undefined || target !== entry.destinationSymlinkTarget) throw new Error(`backup symlink target changed before rollback (${entry.backup})`);
        await symlink(target, entry.destination);
      } else {
        await link(entry.backup, entry.destination);
      }
      const restoredDestination = await lstat(entry.destination);
      if (entry.destinationSnapshot.kind === "symlink"
        ? !restoredDestination.isSymbolicLink() || await readlink(entry.destination) !== entry.destinationSymlinkTarget
        : !sameSnapshot(restoredDestination, entry.destinationSnapshot)) {
        throw new Error(`backup rollback did not preserve the prior entry (${entry.destination})`);
      }
      await unlink(entry.backup);
      await invokeFault(hooks, "rollback-backup", "after", index, entry);
    } catch (error) {
      failures.push({ error, path: entry.destination });
    }
  }
  return failures;
}

async function executeStagedFileTransaction(
  publications: readonly StagedFilePublication[],
  hooks: StagedFileTransactionTestHooks,
) {
  let prepared: PreparedPublication[];
  try {
    prepared = await prepareStagedFileTransaction(publications, hooks);
  } catch (error) {
    if (error instanceof StagedFileTransactionError) throw error;
    throw new StagedFileTransactionError("CUT_PUBLISH_PREFLIGHT", `staged-file preflight failed (${errorCode(error) ?? "UNKNOWN"}).`, undefined, { cause: error });
  }

  const backedUp: PreparedPublication[] = [];
  const promoted: PreparedPublication[] = [];
  let active = prepared[0];
  try {
    for (const [index, entry] of prepared.entries()) {
      active = entry;
      if (!entry.destinationSnapshot) continue;
      await invokeFault(hooks, "backup", "before", index, entry);
      const current = await lstat(entry.destination);
      if (!sameSnapshot(current, entry.destinationSnapshot)) throw new Error(`destination changed before backup (${entry.destination})`);
      await rename(entry.destination, entry.backup);
      backedUp.push(entry);
      await invokeFault(hooks, "backup", "after", index, entry);
    }
    for (const [index, entry] of prepared.entries()) {
      if (entry.action === "remove") continue;
      active = entry;
      await invokeFault(hooks, "promotion", "before", index, entry);
      if (!entry.staged || !entry.stagedSnapshot) throw new Error(`replacement publication has no staged file (${entry.destination})`);
      const currentStage = await lstat(entry.staged);
      if (!sameSnapshot(currentStage, entry.stagedSnapshot)) throw new Error(`staged file changed before promotion (${entry.staged})`);
      if (await optionalEntry(entry.destination)) throw new Error(`destination appeared before promotion (${entry.destination})`);
      await rename(entry.staged, entry.destination);
      promoted.push(entry);
      await invokeFault(hooks, "promotion", "after", index, entry);
    }
  } catch (commitError) {
    const rollbackFailures = await rollbackStagedFileTransaction(promoted, backedUp, prepared, hooks);
    if (rollbackFailures.length) {
      const first = rollbackFailures[0];
      throw new StagedFileTransactionError(
        "CUT_PUBLISH_ROLLBACK",
        `publication failed and rollback could not fully restore ${boundedDiagnosticString(first.path)} (${errorCode(first.error) ?? "UNKNOWN"}).`,
        first.path,
        { cause: commitError },
      );
    }
    throw new StagedFileTransactionError(
      "CUT_PUBLISH_COMMIT",
      `publication failed at ${boundedDiagnosticString(active.destination)}; every prior destination was restored (${errorCode(commitError) ?? "UNKNOWN"}).`,
      active.destination,
      { cause: commitError },
    );
  }

  // The publication is committed once every promotion succeeds. Backup
  // cleanup is deliberately outside the rollback window: multiple directory
  // entries (especially across filesystems) have no global atomic commit.
  for (const entry of backedUp) {
    try {
      if (!entry.destinationSnapshot || !sameSnapshot(await lstat(entry.backup), entry.destinationSnapshot)) continue;
      await rm(entry.backup, { force: true });
    }
    catch { /* A stale hidden backup is safer than reporting a committed set as failed. */ }
  }
}

/**
 * Publish validated staged replacements/removals as one deterministic rollback group.
 *
 * This restores the prior set after caught in-process backup/promotion errors.
 * It does not claim atomic visibility across files or crash/power-loss safety.
 */
export async function publishStagedFileTransaction(publications: readonly StagedFilePublication[]) {
  await executeStagedFileTransaction(publications, {});
}

/** @internal Unit-test entry point for deterministic filesystem fault injection. */
export async function publishStagedFileTransactionForTest(
  publications: readonly StagedFilePublication[],
  hooks: StagedFileTransactionTestHooks,
) {
  await executeStagedFileTransaction(publications, hooks);
}

type PreparedCreateOnlyPublication = Readonly<{
  staged: string;
  destination: string;
  parent: string;
  order: number;
  role?: string;
  stagedSnapshot: EntrySnapshot;
  parentSnapshot: EntrySnapshot;
}>;

function existsFailure(destination: string): never {
  throw new StagedFileTransactionError(
    "CUT_PUBLISH_EXISTS",
    `create-only destination already exists at ${boundedDiagnosticString(destination)}.`,
    destination,
  );
}

async function prepareCreateOnlyStagedFileTransaction(
  publications: readonly CreateOnlyStagedFilePublication[],
  hooks: StagedFileTransactionTestHooks,
) {
  if (!publications.length) preflightFailure("a create-only staged-file transaction needs at least one publication.");
  const candidates = publications.map((publication) => {
    const order = publication.order ?? 0;
    if (!Number.isSafeInteger(order)) preflightFailure(`publication order for ${boundedDiagnosticString(publication.destination)} must be a safe integer.`, publication.destination);
    if (publication.role !== undefined && publication.role.length === 0) preflightFailure(`publication role for ${boundedDiagnosticString(publication.destination)} must not be empty.`, publication.destination);
    return {
      staged: resolve(publication.staged), destination: resolve(publication.destination), order,
      ...(publication.role === undefined ? {} : { role: publication.role }),
    };
  }).sort((left, right) => left.order - right.order || compareText(foldedPath(left.destination), foldedPath(right.destination)) || compareText(left.destination, right.destination));
  const prepared: PreparedCreateOnlyPublication[] = [];
  for (const candidate of candidates) {
    const requestedParent = dirname(candidate.destination);
    let parentMetadata: Awaited<ReturnType<typeof lstat>>, stagedMetadata: Awaited<ReturnType<typeof lstat>>;
    try { [parentMetadata, stagedMetadata] = await Promise.all([lstat(requestedParent), lstat(candidate.staged)]); }
    catch (error) { preflightFailure(`cannot inspect create-only publication inputs (${errorCode(error) ?? "UNKNOWN"}).`, candidate.destination, error); }
    if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
      preflightFailure(`destination parent ${boundedDiagnosticString(requestedParent)} must be a direct, non-symlink directory.`, requestedParent);
    }
    if (stagedMetadata.isSymbolicLink() || !stagedMetadata.isFile()) {
      preflightFailure(`staged path ${boundedDiagnosticString(candidate.staged)} must be one regular file.`, candidate.staged);
    }
    let parent: string, staged: string;
    try { [parent, staged] = await Promise.all([realpath(requestedParent), realpath(candidate.staged)]); }
    catch (error) { preflightFailure(`cannot resolve create-only publication inputs (${errorCode(error) ?? "UNKNOWN"}).`, candidate.destination, error); }
    const destination = resolve(parent, basename(candidate.destination));
    if (observedDevice(hooks, staged, "staged", stagedMetadata.dev) !== observedDevice(hooks, parent, "destination-parent", parentMetadata.dev)) {
      preflightFailure(`staged file ${boundedDiagnosticString(staged)} is not on the destination filesystem.`, destination);
    }
    if (await optionalEntry(destination)) existsFailure(destination);
    if (foldedPath(staged) === foldedPath(destination)) preflightFailure(`staged file and destination collide at ${boundedDiagnosticString(destination)}.`, destination);
    prepared.push({
      staged, destination, parent, order: candidate.order,
      ...(candidate.role === undefined ? {} : { role: candidate.role }),
      stagedSnapshot: snapshot(stagedMetadata, "file"), parentSnapshot: snapshot(parentMetadata, "directory"),
    });
  }
  const destinations = new Map<string, string>(), stages = new Map<string, string>();
  for (const entry of prepared) {
    const destinationIdentity = foldedPath(entry.destination), previousDestination = destinations.get(destinationIdentity);
    if (previousDestination) preflightFailure(`destinations ${boundedDiagnosticString(previousDestination)} and ${boundedDiagnosticString(entry.destination)} collide after canonical case folding.`, entry.destination);
    destinations.set(destinationIdentity, entry.destination);
    const stageIdentity = foldedPath(entry.staged), previousStage = stages.get(stageIdentity);
    if (previousStage) preflightFailure(`staged files ${boundedDiagnosticString(previousStage)} and ${boundedDiagnosticString(entry.staged)} are not unique.`, entry.staged);
    stages.set(stageIdentity, entry.staged);
  }
  for (const entry of prepared) {
    const collision = destinations.get(foldedPath(entry.staged));
    if (collision) preflightFailure(`staged file ${boundedDiagnosticString(entry.staged)} collides with destination ${boundedDiagnosticString(collision)}.`, entry.staged);
  }
  for (const entry of prepared) {
    const [parentMetadata, stagedMetadata, destinationMetadata] = await Promise.all([
      lstat(entry.parent), lstat(entry.staged), optionalEntry(entry.destination),
    ]).catch((error) => preflightFailure(`create-only publication inputs changed during preflight (${errorCode(error) ?? "UNKNOWN"}).`, entry.destination, error));
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || !sameSnapshot(parentMetadata, entry.parentSnapshot)
      || !sameSnapshot(stagedMetadata, entry.stagedSnapshot)) {
      preflightFailure(`create-only publication inputs changed during preflight.`, entry.destination);
    }
    if (destinationMetadata) existsFailure(entry.destination);
  }
  return prepared;
}

async function invokeCreateOnlyFault(
  hooks: StagedFileTransactionTestHooks,
  phase: "promotion" | "rollback-new",
  timing: "before" | "after",
  index: number,
  entry: PreparedCreateOnlyPublication,
) {
  await hooks.fault?.({
    phase, timing, index, action: "replace", staged: entry.staged, destination: entry.destination,
    order: entry.order, ...(entry.role === undefined ? {} : { role: entry.role }),
  });
}

async function rollbackCreateOnlyPublications(
  linked: readonly PreparedCreateOnlyPublication[],
  ordered: readonly PreparedCreateOnlyPublication[],
  hooks: StagedFileTransactionTestHooks,
) {
  const failures: Array<{ error: unknown; path: string }> = [], indexes = new Map(ordered.map((entry, index) => [entry.destination, index]));
  for (const entry of [...linked].reverse()) {
    const index = indexes.get(entry.destination)!;
    try {
      await invokeCreateOnlyFault(hooks, "rollback-new", "before", index, entry);
      const destination = await lstat(entry.destination);
      if (!sameSnapshot(destination, entry.stagedSnapshot)) throw new Error("create-only destination inode changed before rollback");
      await unlink(entry.destination);
      await invokeCreateOnlyFault(hooks, "rollback-new", "after", index, entry);
    } catch (error) { failures.push({ error, path: entry.destination }); }
  }
  return failures;
}

async function executeCreateOnlyStagedFileTransaction(
  publications: readonly CreateOnlyStagedFilePublication[],
  hooks: StagedFileTransactionTestHooks,
) {
  const prepared = await prepareCreateOnlyStagedFileTransaction(publications, hooks);
  const linked: PreparedCreateOnlyPublication[] = [];
  let active = prepared[0], failure: unknown, destinationRace = false;
  try {
    for (const [index, entry] of prepared.entries()) {
      active = entry;
      const [parentMetadata, stagedMetadata] = await Promise.all([lstat(entry.parent), lstat(entry.staged)]);
      if (!sameSnapshot(parentMetadata, entry.parentSnapshot) || !sameSnapshot(stagedMetadata, entry.stagedSnapshot)) {
        throw new Error("create-only publication inputs changed before commit");
      }
      await invokeCreateOnlyFault(hooks, "promotion", "before", index, entry);
      try { await link(entry.staged, entry.destination); }
      catch (error) { if (errorCode(error) === "EEXIST") destinationRace = true; throw error; }
      linked.push(entry);
      const destinationMetadata = await lstat(entry.destination);
      if (!sameSnapshot(destinationMetadata, entry.stagedSnapshot)) throw new Error("create-only link did not preserve the staged inode");
      await invokeCreateOnlyFault(hooks, "promotion", "after", index, entry);
    }
    for (const entry of prepared) {
      const stagedMetadata = await lstat(entry.staged);
      if (!sameSnapshot(stagedMetadata, entry.stagedSnapshot)) throw new Error("create-only stage changed before cleanup");
      await unlink(entry.staged);
    }
    return;
  } catch (error) { failure = error; }
  const rollbackFailures = await rollbackCreateOnlyPublications(linked, prepared, hooks);
  if (rollbackFailures.length) {
    throw new StagedFileTransactionError(
      "CUT_PUBLISH_ROLLBACK",
      `create-only rollback could not remove ${rollbackFailures.length} linked destination(s); first failure at ${boundedDiagnosticString(rollbackFailures[0]!.path)} (${errorCode(rollbackFailures[0]!.error) ?? "UNKNOWN"}).`,
      rollbackFailures[0]!.path,
      { cause: rollbackFailures[0]!.error },
    );
  }
  if (destinationRace) existsFailure(active!.destination);
  throw new StagedFileTransactionError(
    "CUT_PUBLISH_COMMIT",
    `create-only publication failed and every new destination was removed (${errorCode(failure) ?? "UNKNOWN"}).`,
    active?.destination,
    { cause: failure },
  );
}

/** Atomically no-clobber each leaf and roll back earlier hard links on failure. */
export async function publishCreateOnlyStagedFileTransaction(publications: readonly CreateOnlyStagedFilePublication[]) {
  await executeCreateOnlyStagedFileTransaction(publications, {});
}

/** @internal Unit-test entry point for create-only race and rollback faults. */
export async function publishCreateOnlyStagedFileTransactionForTest(
  publications: readonly CreateOnlyStagedFilePublication[],
  hooks: StagedFileTransactionTestHooks,
) {
  await executeCreateOnlyStagedFileTransaction(publications, hooks);
}

/**
 * Create or open a project-owned directory without following a pre-existing
 * symlink at any locator segment. The returned path is physical and contained
 * beneath the physical project root.
 */
export async function ensureProjectWriteDirectory(projectRoot: string, locator: string) {
  const safe = validateProjectLocator(locator, "write directory");
  const root = await realpath(resolve(projectRoot));
  let current = root;
  for (const segment of safe.split("/")) {
    const candidate = resolve(current, segment);
    if (!inside(root, candidate)) throw new Error(`CUT write directory escapes the project root: ${safe}`);
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try { await mkdir(candidate, { mode: 0o700 }); }
      catch (mkdirError) { if (errorCode(mkdirError) !== "EEXIST") throw mkdirError; }
      metadata = await lstat(candidate);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`CUT write directory contains a non-directory or symlink: ${safe}`);
    const physical = await realpath(candidate);
    if (!inside(root, physical)) throw new Error(`CUT write directory resolves outside the project root: ${safe}`);
    current = physical;
  }
  return current;
}

/**
 * Publish one or more CLI artifacts beneath an explicitly trusted project/CWD
 * boundary. Missing directories are created one segment at a time without
 * following symlinks, leaf symlinks are replaced as directory entries, and
 * every payload is staged exclusively beside its destination before commit.
 */
export async function writeProjectArtifacts(
  ownershipRoots: readonly string[],
  artifacts: readonly ProjectArtifactWrite[],
) {
  if (!ownershipRoots.length) preflightFailure("an artifact write needs at least one ownership root.");
  if (!artifacts.length) preflightFailure("an artifact write needs at least one destination.");

  const roots: Array<{ lexical: string; physical: string }> = [];
  for (const requestedRoot of ownershipRoots) {
    const lexical = resolve(requestedRoot);
    try {
      const physical = await realpath(lexical), metadata = await lstat(physical);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        preflightFailure(`artifact ownership root ${boundedDiagnosticString(lexical)} must resolve to a directory.`, lexical);
      }
      if (!roots.some((root) => root.lexical === lexical)) roots.push({ lexical, physical });
    } catch (error) {
      if (error instanceof StagedFileTransactionError) throw error;
      preflightFailure(`cannot resolve artifact ownership root ${boundedDiagnosticString(lexical)} (${errorCode(error) ?? "UNKNOWN"}).`, lexical, error);
    }
  }
  roots.sort((left, right) => right.lexical.length - left.lexical.length || compareText(left.lexical, right.lexical));

  const stages: string[] = [];
  const publications: StagedFilePublication[] = [];
  try {
    for (const artifact of artifacts) {
      const requestedDestination = resolve(artifact.destination);
      if (dirname(requestedDestination) === requestedDestination) {
        preflightFailure(`artifact destination ${boundedDiagnosticString(requestedDestination)} must name a file.`, requestedDestination);
      }
      const root = roots.find((candidate) => inside(candidate.lexical, requestedDestination));
      if (!root) {
        preflightFailure(`artifact destination ${boundedDiagnosticString(requestedDestination)} escapes the project/CWD ownership boundary.`, requestedDestination);
      }

      const lexicalParent = dirname(requestedDestination), localParent = relative(root.lexical, lexicalParent);
      let physicalParent: string;
      try {
        physicalParent = localParent
          ? await ensureProjectWriteDirectory(root.physical, localParent.split(sep).join("/"))
          : root.physical;
      } catch (error) {
        if (error instanceof StagedFileTransactionError) throw error;
        preflightFailure(`cannot prepare artifact directory for ${boundedDiagnosticString(requestedDestination)} without following a symlink (${errorCode(error) ?? "UNKNOWN"}).`, requestedDestination, error);
      }

      const destination = resolve(physicalParent, basename(requestedDestination));
      const staged = resolve(physicalParent, `.${basename(destination)}.cut-${process.pid}-${randomUUID()}.tmp`);
      let mode = 0o666;
      try {
        const existing = await lstat(destination);
        if (existing.isFile()) mode = existing.mode & 0o777;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          preflightFailure(`cannot inspect artifact destination ${boundedDiagnosticString(requestedDestination)} (${errorCode(error) ?? "UNKNOWN"}).`, requestedDestination, error);
        }
      }
      stages.push(staged);
      try {
        await writeFile(staged, artifact.contents, { flag: "wx", mode });
      } catch (error) {
        preflightFailure(`cannot stage artifact for ${boundedDiagnosticString(requestedDestination)} (${errorCode(error) ?? "UNKNOWN"}).`, requestedDestination, error);
      }
      publications.push({
        staged,
        destination,
        ...(artifact.order === undefined ? {} : { order: artifact.order }),
        ...(artifact.role === undefined ? {} : { role: artifact.role }),
      });
    }
    await publishStagedFileTransaction(publications);
  } finally {
    await Promise.all(stages.map((stage) => rm(stage, { force: true })));
  }
}

/** Write a sibling temporary file exclusively and publish it by rename. */
export async function atomicWriteFile(destination: string, contents: string | Uint8Array) {
  const parent = dirname(destination);
  const temporary = resolve(parent, `.${basename(destination)}.cut-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await publishStagedFile(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Publish a staged regular file without ever opening a destination symlink. */
export async function publishStagedFile(staged: string, destination: string) {
  try {
    await rename(staged, destination);
  } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(errorCode(error) ?? "")) throw error;
    // Windows cannot atomically replace an existing file. Removing a sibling
    // destination removes a symlink itself rather than following its target.
    await rm(destination, { force: true });
    await rename(staged, destination);
  }
}
