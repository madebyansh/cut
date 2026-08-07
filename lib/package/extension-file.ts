import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { packageFail } from "./diagnostics";
import { validateCutPackageFileLocator } from "./manifest";

export type CutExtensionFileHandle = Readonly<{
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<Readonly<{ bytesRead: number }>>;
  close(): Promise<void>;
}>;

export type CutExtensionFileIo = Readonly<{
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<CutExtensionFileHandle>;
  realpath(path: string): Promise<string>;
}>;

export const defaultCutExtensionFileIo: CutExtensionFileIo = Object.freeze({
  lstat,
  open: (path: string, flags: number) => open(path, flags),
  realpath,
});

function systemCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}

export async function directPhysicalExtensionDirectory(
  directory: string,
  io: CutExtensionFileIo = defaultCutExtensionFileIo,
) {
  const lexical = resolve(directory);
  let metadata: Stats;
  try {
    metadata = await io.lstat(lexical);
  } catch (error) {
    packageFail("CUT_EXTENSION_PATH", "$directory", `cannot be inspected (${systemCode(error)}).`);
  }
  if (metadata!.isSymbolicLink() || !metadata!.isDirectory()) {
    packageFail("CUT_EXTENSION_PATH", "$directory", "must be a direct, non-symlink directory.");
  }
  try {
    return await io.realpath(lexical);
  } catch (error) {
    packageFail("CUT_EXTENSION_PATH", "$directory", `cannot be resolved (${systemCode(error)}).`);
  }
}

async function openedStat(
  handle: CutExtensionFileHandle,
  path: string,
  phase: "before-read" | "after-read",
) {
  try {
    return await handle.stat();
  } catch (error) {
    packageFail(
      phase === "before-read" ? "CUT_EXTENSION_FILE" : "CUT_EXTENSION_RACE",
      path,
      `${phase === "before-read" ? "opened file cannot be inspected" : "opened file cannot be re-inspected after reading"} (${systemCode(error)}).`,
    );
  }
}

export async function readContainedExtensionFile(
  root: string,
  locator: string,
  maximumBytes: number,
  path: string,
  io: CutExtensionFileIo = defaultCutExtensionFileIo,
) {
  validateCutPackageFileLocator(locator, path);
  const candidate = resolve(root, ...locator.split("/"));
  const local = relative(root, candidate);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    packageFail("CUT_EXTENSION_PATH", path, "escapes the extension directory.");
  }

  let cursor = root;
  for (const segment of locator.split("/")) {
    cursor = resolve(cursor, segment);
    let metadata: Stats;
    try {
      metadata = await io.lstat(cursor);
    } catch (error) {
      packageFail("CUT_EXTENSION_FILE", path, `cannot be inspected (${systemCode(error)}).`);
    }
    if (metadata!.isSymbolicLink()) {
      packageFail("CUT_EXTENSION_SYMLINK", path, `must not resolve through symbolic link ${JSON.stringify(segment)}.`);
    }
  }

  let handle: CutExtensionFileHandle;
  try {
    handle = await io.open(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    packageFail("CUT_EXTENSION_FILE", path, `cannot be opened (${systemCode(error)}).`);
  }

  let primaryError: unknown;
  try {
    const before = await openedStat(handle!, path, "before-read");
    if (!before.isFile()) packageFail("CUT_EXTENSION_FILE", path, "must be a regular file.");
    if (before.size < 1 || before.size > maximumBytes) {
      packageFail("CUT_EXTENSION_BUDGET", path, `must contain between 1 and ${maximumBytes} bytes.`);
    }

    const bounded = Buffer.allocUnsafe(before.size + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      let result: Readonly<{ bytesRead: number }>;
      try {
        result = await handle!.read(bounded, bytesRead, bounded.byteLength - bytesRead, bytesRead);
      } catch (error) {
        packageFail("CUT_EXTENSION_READ", path, `cannot be read (${systemCode(error)}).`);
      }
      if (!Number.isSafeInteger(result!.bytesRead) || result!.bytesRead < 0 || result!.bytesRead > bounded.byteLength - bytesRead) {
        packageFail("CUT_EXTENSION_READ", path, "returned an invalid byte count.");
      }
      if (result!.bytesRead === 0) break;
      bytesRead += result!.bytesRead;
    }

    const after = await openedStat(handle!, path, "after-read");
    let pathAfter: Stats;
    try {
      pathAfter = await io.lstat(candidate);
    } catch (error) {
      packageFail("CUT_EXTENSION_RACE", path, `path cannot be re-inspected after reading (${systemCode(error)}).`);
    }
    if (!after.isFile() || pathAfter!.isSymbolicLink() || !pathAfter!.isFile()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || after.dev !== pathAfter!.dev || after.ino !== pathAfter!.ino || bytesRead !== before.size) {
      packageFail("CUT_EXTENSION_RACE", path, "changed while it was being read.");
    }
    return new Uint8Array(bounded.subarray(0, bytesRead));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle!.close();
    } catch (error) {
      if (primaryError === undefined) {
        packageFail("CUT_EXTENSION_CLOSE", path, `cannot close the authenticated file handle (${systemCode(error)}).`);
      }
    }
  }
}
