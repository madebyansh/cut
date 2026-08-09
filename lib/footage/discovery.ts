import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveProjectFile, validateProjectLocator } from "../project/manifest";
import { footageFail } from "./diagnostics";

export type FootageDiscoveryLimits = Readonly<{
  maximumFiles: number;
  maximumDepth: number;
  maximumFileBytes: number;
}>;

export const defaultFootageDiscoveryLimits: FootageDiscoveryLimits = Object.freeze({
  maximumFiles: 10_000,
  maximumDepth: 32,
  maximumFileBytes: 100 * 1024 * 1024 * 1024,
});

function bytewise(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function limits(value: Partial<FootageDiscoveryLimits>): FootageDiscoveryLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["maximumFiles", "maximumDepth", "maximumFileBytes"].includes(key))) {
    footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$options", "must contain only bounded discovery limits.");
  }
  const result = { ...defaultFootageDiscoveryLimits, ...value };
  for (const [key, maximum] of [["maximumFiles", 10_000], ["maximumDepth", 256], ["maximumFileBytes", 100 * 1024 * 1024 * 1024]] as const) {
    const candidate = result[key];
    if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > maximum || (key !== "maximumDepth" && candidate < 1)) {
      footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", `$options.${key}`, `must be one bounded ${key}.`);
    }
  }
  return Object.freeze(result);
}

function mediaName(name: string) { return /\.(?:mp4|mov)$/iu.test(name); }

/** Discovers regular local footage below one validated, project-relative directory locator. */
export async function discoverProjectFootage(
  projectRoot: string,
  rootLocator: string,
  requestedLimits: Partial<FootageDiscoveryLimits> = {},
): Promise<readonly string[]> {
  const safeRoot = validateProjectLocator(rootLocator, "footage root locator");
  const bounded = limits(requestedLimits);
  const canonicalProjectRoot = await realpath(projectRoot);
  const requestedRoot = resolve(canonicalProjectRoot, safeRoot);
  // This is the project boundary authority. lstat below separately rejects
  // a same-project symlink rather than quietly accepting its real path.
  const canonicalRoot = await resolveProjectFile(projectRoot, safeRoot);
  const rootStat = await lstat(requestedRoot);
  if (rootStat.isSymbolicLink()) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", safeRoot, "symlinks are not accepted during footage discovery.");
  if (!rootStat.isDirectory()) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", safeRoot, "footage root must be one regular directory.");

  const found: string[] = [];
  const visit = async (directory: string, locator: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewise(left.name, right.name));
    for (const entry of entries) {
      const childLocator = `${locator}/${entry.name}`;
      const childPath = resolve(directory, entry.name);
      const child = await lstat(childPath);
      if (entry.isSymbolicLink() || child.isSymbolicLink()) {
        footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", childLocator, "symlinks are not accepted during footage discovery.");
      }
      if (child.isDirectory()) {
        if (depth >= bounded.maximumDepth) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", childLocator, "maximumDepth would be exceeded.");
        await visit(childPath, childLocator, depth + 1);
        continue;
      }
      if (!child.isFile() || !mediaName(entry.name)) continue;
      if (child.size > bounded.maximumFileBytes) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", childLocator, "maximumFileBytes would be exceeded.");
      if (found.length >= bounded.maximumFiles) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", childLocator, "maximumFiles would be exceeded.");
      found.push(childLocator);
    }
  };
  await visit(canonicalRoot, safeRoot, 0);
  found.sort(bytewise);
  return Object.freeze(found);
}
