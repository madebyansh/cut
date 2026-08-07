#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identityPath = resolve(root, "lib/runtime/reference/native-source-over-identity.json");

function fail(message) { throw new Error(`CUT_NATIVE_RUNTIME_SYNC: ${message}`); }

function stableBytes(locator, expected, label) {
  const lexical = resolve(root, locator), state = lstatSync(lexical);
  if (state.isSymbolicLink() || !state.isFile() || realpathSync(lexical) !== lexical
    || state.size !== expected.bytes) fail(`${label} is not the declared regular non-link file`);
  let descriptor;
  try {
    descriptor = openSync(lexical, "r");
    const before = fstatSync(descriptor), bytes = readFileSync(descriptor), after = fstatSync(descriptor);
    if (before.dev !== state.dev || before.ino !== state.ino || before.size !== state.size
      || before.mtimeMs !== state.mtimeMs || before.ctimeMs !== state.ctimeMs
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      fail(`${label} bytes do not match the declared implementation authority`);
    }
    return bytes;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function identity() {
  const parsed = JSON.parse(readFileSync(identityPath, "utf8"));
  if (parsed?.format !== "cut-reference-native-source-over-identity" || parsed.version !== 1
    || parsed.platform !== "darwin" || parsed.architecture !== "arm64"
    || typeof parsed.source?.locator !== "string" || typeof parsed.binary?.sourceLocator !== "string"
    || typeof parsed.binary?.runtimeName !== "string") fail("identity has an invalid closed shape");
  return parsed;
}

function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== "--write" && mode !== "--check")) {
    fail("usage: sync-reference-native-runtime.mjs --write|--check");
  }
  const declared = identity();
  stableBytes(declared.source.locator, declared.source, "native source");
  const source = stableBytes(declared.binary.sourceLocator, declared.binary, "native binary");
  const destination = resolve(root, "dist-cli/lib/runtime/reference", declared.binary.runtimeName);
  if (mode === "--check") {
    if (!existsSync(destination)) fail("compiled native runtime artifact is missing");
    const state = lstatSync(destination);
    if (state.isSymbolicLink() || !state.isFile() || state.size !== source.byteLength
      || createHash("sha256").update(readFileSync(destination)).digest("hex") !== declared.binary.sha256) {
      fail("compiled native runtime artifact does not match the source authority");
    }
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
      copyFileSync(resolve(root, declared.binary.sourceLocator), temporary);
      renameSync(temporary, destination);
    } finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
  }
  process.stdout.write(`${mode === "--write" ? "copied" : "verified"} ${declared.binary.runtimeName}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
