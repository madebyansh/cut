import { packageFail } from "./diagnostics";

export type CutSemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  build: string[];
  raw: string;
};

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseCutSemVer(value: string, path = "$version"): CutSemVer {
  if (typeof value !== "string" || value.length > 128) packageFail("CUT_PACKAGE_SEMVER", path, "must be a bounded SemVer 2.0.0 string.");
  const match = semverPattern.exec(value);
  if (!match) packageFail("CUT_PACKAGE_SEMVER", path, `must be an exact SemVer 2.0.0 version; received ${JSON.stringify(value)}.`);
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some((item) => !Number.isSafeInteger(item))) packageFail("CUT_PACKAGE_SEMVER", path, "contains a numeric component outside JavaScript's safe integer range.");
  const prerelease = match[4] ? match[4].split(".").map((item) => /^\d+$/.test(item) ? Number(item) : item) : [];
  if (prerelease.some((item) => typeof item === "number" && !Number.isSafeInteger(item))) packageFail("CUT_PACKAGE_SEMVER", path, "contains a numeric prerelease identifier outside JavaScript's safe integer range.");
  return {
    major: numbers[0], minor: numbers[1], patch: numbers[2],
    prerelease,
    build: match[5] ? match[5].split(".") : [],
    raw: value,
  };
}

export function compareCutSemVer(left: CutSemVer, right: CutSemVer) {
  for (const key of ["major", "minor", "patch"] as const) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index], b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "string") return -1;
    if (typeof a === "string" && typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export type CutSemVerRange = { operator: "exact" | "caret" | "tilde"; version: CutSemVer; raw: string };

export function parseCutSemVerRange(value: string, path = "$range"): CutSemVerRange {
  if (typeof value !== "string" || value.length > 129) packageFail("CUT_PACKAGE_SEMVER_RANGE", path, "must be a bounded exact, caret, or tilde SemVer range.");
  const operator = value.startsWith("^") ? "caret" : value.startsWith("~") ? "tilde" : "exact";
  const version = parseCutSemVer(operator === "exact" ? value : value.slice(1), path);
  return { operator, version, raw: value };
}

export function cutSemVerSatisfies(versionValue: string, rangeValue: string, path = "$range") {
  const version = parseCutSemVer(versionValue, "$version"), range = parseCutSemVerRange(rangeValue, path);
  if (range.operator === "exact") return compareCutSemVer(version, range.version) === 0;
  if (compareCutSemVer(version, range.version) < 0) return false;
  if (range.version.prerelease.length && version.major === range.version.major && version.minor === range.version.minor && version.patch === range.version.patch) return true;
  if (version.prerelease.length) return false;
  if (range.operator === "tilde") return version.major === range.version.major && version.minor === range.version.minor;
  if (range.version.major > 0) return version.major === range.version.major;
  if (range.version.minor > 0) return version.major === 0 && version.minor === range.version.minor;
  return version.major === 0 && version.minor === 0 && version.patch === range.version.patch;
}

export function defaultCutSemVerRange(versionValue: string) {
  const version = parseCutSemVer(versionValue);
  return version.prerelease.length ? version.raw : `^${version.raw}`;
}
