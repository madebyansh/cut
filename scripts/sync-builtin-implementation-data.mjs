#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const builtinImplementationDataFiles = Object.freeze([
  "builtin-implementation-closure.json",
  "builtin-implementation-roots.json",
]);

const maximumFileBytes = 1024 * 1024;

export class BuiltinImplementationDataError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "BuiltinImplementationDataError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BuiltinImplementationDataError(code, message);
}

function inside(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

function stableRead(path, label) {
  let pathState;
  try { pathState = lstatSync(path); }
  catch { fail("CUT_IMPLEMENTATION_DATA_MISSING", `${label} is missing.`); }
  if (pathState.isSymbolicLink() || !pathState.isFile() || pathState.size <= 0 || pathState.size > maximumFileBytes) {
    fail("CUT_IMPLEMENTATION_DATA_FILE", `${label} must be a non-empty regular non-link file no larger than ${maximumFileBytes} bytes.`);
  }
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const before = fstatSync(descriptor);
    if (before.dev !== pathState.dev || before.ino !== pathState.ino || before.size !== pathState.size || before.mtimeMs !== pathState.mtimeMs || before.ctimeMs !== pathState.ctimeMs) {
      fail("CUT_IMPLEMENTATION_DATA_CHANGED", `${label} changed before it was read.`);
    }
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor);
    if (bytes.byteLength !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("CUT_IMPLEMENTATION_DATA_CHANGED", `${label} changed while it was read.`);
    }
    return bytes;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function paths(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const sourceRoot = resolve(options.sourceRoot ?? resolve(workspaceRoot, "lib/language"));
  const destinationRoot = resolve(options.destinationRoot ?? resolve(workspaceRoot, "dist-cli/lib/language"));
  if (!inside(workspaceRoot, sourceRoot) || !inside(workspaceRoot, destinationRoot)) {
    fail("CUT_IMPLEMENTATION_DATA_PATH", "implementation data source and destination must remain inside the workspace.");
  }
  return { sourceRoot, destinationRoot };
}

export function syncBuiltinImplementationData(options = {}) {
  const { sourceRoot, destinationRoot } = paths(options), mode = options.mode ?? "check";
  if (mode !== "check" && mode !== "write") fail("CUT_IMPLEMENTATION_DATA_USAGE", "sync mode must be check or write.");
  if (mode === "write") mkdirSync(destinationRoot, { recursive: true });
  for (const name of builtinImplementationDataFiles) {
    const source = stableRead(resolve(sourceRoot, name), `source ${name}`), destination = resolve(destinationRoot, name);
    if (mode === "check") {
      const packed = stableRead(destination, `built ${name}`);
      if (!packed.equals(source)) fail("CUT_IMPLEMENTATION_DATA_STALE", `built ${name} does not match its committed source.`);
      continue;
    }
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, source, { flag: "wx", mode: 0o644 });
      renameSync(temporary, destination);
    } finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
  }
  return { files: [...builtinImplementationDataFiles], mode };
}

function commandLine(argv) {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0])) {
    fail("CUT_IMPLEMENTATION_DATA_USAGE", "usage: sync-builtin-implementation-data.mjs --check|--write");
  }
  const result = syncBuiltinImplementationData({ mode: argv[0].slice(2) });
  process.stdout.write(`${result.mode === "write" ? "copied" : "verified"} ${result.files.length} built-in implementation data files\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { commandLine(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
