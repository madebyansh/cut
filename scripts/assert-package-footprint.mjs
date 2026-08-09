#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const cutPackageFootprintLimits = Object.freeze({
  maximumPackedBytes: 4_031_017,
  maximumUnpackedBytes: 21_451_006,
  maximumEntries: 983,
  maximumAdapterBytes: 512 * 1024,
});

export const cutFootageAdapterFiles = Object.freeze([
  "adapters/footage-local/NOTICE.md",
  "adapters/footage-local/local-clip-sidecar.mjs",
  "adapters/footage-local/model.json",
  "adapters/footage-local/package-lock.json",
  "adapters/footage-local/package.json",
]);

const productionDependencies = Object.freeze({
  ajv: "6.15.0",
  "bidi-js": "1.0.3",
  "d3-geo": "3.1.1",
  harfbuzzjs: "1.4.0",
  "opentype.js": "1.3.4",
  sharp: "0.35.3",
  "topojson-client": "3.1.0",
  "world-atlas": "2.0.2",
});
const productionOptionalDependencies = Object.freeze({ "@img/sharp-wasm32": "0.35.3" });
const forbiddenLifecycleScripts = Object.freeze(["preinstall", "install", "postinstall", "prepare"]);
const forbiddenDependencyPattern = /(?:^|\/)(?:@huggingface\/transformers|onnxruntime-node)(?:$|\/)/u;
const forbiddenPayloadPattern = /(?:^|\/)(?:node_modules|site-packages|venv|\.venv|models|model-cache|huggingface)(?:\/|$)|\.(?:onnx|pt|pth|safetensors|whl)$/u;

function fail(message) {
  throw new Error(`CUT_PACKAGE_FOOTPRINT: ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be one JSON object`);
  return value;
}

function exactStringMap(value, expected, label) {
  const actual = record(value ?? {}, label);
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) fail(`${label} changed outside the audited package closure`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be one positive safe integer`);
  return value;
}

function packRecord(value) {
  const entries = Array.isArray(value) ? value : undefined;
  if (!entries || entries.length !== 1) fail("npm pack JSON must contain exactly one package result");
  return record(entries[0], "npm pack result");
}

export function assertPackageFootprint(packJson, packageJson, shrinkwrapJson) {
  const pack = packRecord(packJson), manifest = record(packageJson, "package.json"), shrinkwrap = record(shrinkwrapJson, "npm-shrinkwrap.json");
  if (manifest.name !== "cut-lang" || typeof manifest.version !== "string" || !/^0\.4\.0-alpha\.[1-9][0-9]*$/u.test(manifest.version)) {
    fail("package identity is invalid");
  }
  if (pack.name !== manifest.name || pack.version !== manifest.version) fail("npm pack identity does not match package.json");
  const size = positiveInteger(pack.size, "packed size"), unpackedSize = positiveInteger(pack.unpackedSize, "unpacked size"), entryCount = positiveInteger(pack.entryCount, "entry count");
  if (size > cutPackageFootprintLimits.maximumPackedBytes) fail(`packed size ${size} exceeds ${cutPackageFootprintLimits.maximumPackedBytes}`);
  if (unpackedSize > cutPackageFootprintLimits.maximumUnpackedBytes) fail(`unpacked size ${unpackedSize} exceeds ${cutPackageFootprintLimits.maximumUnpackedBytes}`);
  if (entryCount > cutPackageFootprintLimits.maximumEntries) fail(`entry count ${entryCount} exceeds ${cutPackageFootprintLimits.maximumEntries}`);

  exactStringMap(manifest.dependencies, productionDependencies, "package.json dependencies");
  exactStringMap(manifest.optionalDependencies, productionOptionalDependencies, "package.json optionalDependencies");
  const scripts = record(manifest.scripts ?? {}, "package.json scripts");
  for (const name of forbiddenLifecycleScripts) if (Object.hasOwn(scripts, name)) fail(`package.json must not define ${name}`);

  const packages = record(shrinkwrap.packages, "npm-shrinkwrap.json packages"), root = record(packages[""], "npm-shrinkwrap.json root");
  if (root.name !== manifest.name || root.version !== manifest.version) fail("shrinkwrap root identity does not match package.json");
  exactStringMap(root.dependencies, productionDependencies, "shrinkwrap root dependencies");
  exactStringMap(root.optionalDependencies, productionOptionalDependencies, "shrinkwrap root optionalDependencies");
  for (const locator of Object.keys(packages)) if (forbiddenDependencyPattern.test(locator)) fail(`forbidden ML dependency entered the root shrinkwrap at ${locator}`);

  if (!Array.isArray(pack.files) || pack.files.length !== entryCount) fail("npm pack file inventory does not match entryCount");
  const paths = new Set(), adapterEntries = [];
  let adapterBytes = 0;
  for (const raw of pack.files) {
    const entry = record(raw, "npm pack file"), path = entry.path;
    if (typeof path !== "string" || !path.length || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) fail("npm pack contains a non-canonical path");
    if (paths.has(path)) fail(`npm pack contains duplicate path ${path}`);
    paths.add(path);
    if (forbiddenPayloadPattern.test(path)) fail(`forbidden model/runtime payload entered the tarball at ${path}`);
    if (path.startsWith("adapters/footage-local/")) {
      adapterEntries.push(path);
      adapterBytes += positiveInteger(entry.size, `${path} size`);
    }
  }
  const sortedAdapterEntries = adapterEntries.sort();
  if (JSON.stringify(sortedAdapterEntries) !== JSON.stringify([...cutFootageAdapterFiles].sort())) fail("tarball must contain exactly the five audited local-adapter recipe files");
  if (adapterBytes > cutPackageFootprintLimits.maximumAdapterBytes) fail("bundled adapter recipe exceeds its byte limit");
  for (const required of ["package.json", "dist-cli/cli/cut.js"]) if (!paths.has(required)) fail(`tarball is missing ${required}`);
  if (![...paths].some((path) => path.startsWith("dist-cli/lib/footage/") && path.endsWith(".js"))) fail("tarball is missing compiled footage code");

  return Object.freeze({
    format: "cut-package-footprint-report",
    version: 1,
    status: "pass",
    package: `${manifest.name}@${manifest.version}`,
    size,
    unpackedSize,
    entryCount,
    adapterFiles: Object.freeze([...cutFootageAdapterFiles]),
  });
}

async function main() {
  const [packPath, extra] = process.argv.slice(2);
  if (!packPath || extra) fail("usage: assert-package-footprint.mjs <npm-pack.json>");
  const [pack, manifest, shrinkwrap] = await Promise.all([
    readFile(resolve(packPath), "utf8").then(JSON.parse),
    readFile(resolve("package.json"), "utf8").then(JSON.parse),
    readFile(resolve("npm-shrinkwrap.json"), "utf8").then(JSON.parse),
  ]);
  process.stdout.write(`${JSON.stringify(assertPackageFootprint(pack, manifest, shrinkwrap))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
