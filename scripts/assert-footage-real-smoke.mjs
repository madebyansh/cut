#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const adapterSha256 = "d3e57c66bb0eaaca433427f16fd7b48df8d8f9aacfce19f4ea86e8bb9879afbe";
const modelRevision = "d15189d7028b43f1d3e65039190477f6af591c2a";
const backendIdentity = Object.freeze({
  protocolVersion: 1,
  provider: "huggingface-transformers-js",
  model: `Xenova/clip-vit-base-patch32@${modelRevision}+adapter.${adapterSha256}`,
  dimensions: 512,
  normalization: "l2",
});
const graphFiles = Object.freeze([
  Object.freeze({ locator: "onnx/text_model_quantized.onnx", bytes: 64_504_507, sha256: "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a" }),
  Object.freeze({ locator: "onnx/vision_model_quantized.onnx", bytes: 89_117_001, sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299" }),
]);
const shaPattern = /^[a-f0-9]{64}$/u;
const maximumJsonBytes = 4 * 1024 * 1024;
const minimumMarginPpm = 50_000;

function fail(message) {
  throw new Error(`CUT_FOOTAGE_REAL_SMOKE: ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be one JSON object`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) fail("non-finite JSON number");
  return Object.is(value, -0) ? 0 : value;
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function same(left, right) {
  return stableJson(left) === stableJson(right);
}

async function json(path, label, canonicalLf = false) {
  const bytes = await readFile(path);
  if (bytes.byteLength < 1 || bytes.byteLength > maximumJsonBytes) fail(`${label} has an invalid bounded size`);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { return fail(`${label} is not valid JSON`); }
  const parsed = record(value, label);
  if (canonicalLf && !bytes.equals(Buffer.from(`${stableJson(parsed)}\n`, "utf8"))) fail(`${label} is not canonical LF-terminated JSON`);
  return Object.freeze({ bytes, value: parsed });
}

function contained(root, locator, label) {
  if (typeof locator !== "string" || !locator.length || isAbsolute(locator) || locator.includes("\\")
    || locator.split("/").some((part) => !part || part === "." || part === "..")) fail(`${label} is not one canonical project locator`);
  const path = resolve(root, locator), relation = relative(root, path);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail(`${label} escapes the project`);
  return path;
}

async function fileEvidence(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) fail(`${label} must be one non-empty regular file`);
  const bytes = await readFile(path);
  return Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

function verifySigned(value, field, label) {
  if (typeof value[field] !== "string" || !shaPattern.test(value[field])) fail(`${label}.${field} is invalid`);
  const body = { ...value };
  delete body[field];
  if (sha256(stableJson(body)) !== value[field]) fail(`${label}.${field} does not bind canonical JSON`);
}

function rationalNumber(value, label) {
  const item = record(value, label);
  if (typeof item.numerator !== "string" || typeof item.denominator !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(item.numerator) || !/^[1-9][0-9]*$/u.test(item.denominator)) fail(`${label} is not an exact rational`);
  const numerator = BigInt(item.numerator), denominator = BigInt(item.denominator);
  return Number(numerator) / Number(denominator);
}

async function verifySetup(reportsRoot, footageHome) {
  const [first, second, doctor] = await Promise.all([
    json(resolve(reportsRoot, "setup-first.json"), "setup-first.json"),
    json(resolve(reportsRoot, "setup-second.json"), "setup-second.json"),
    json(resolve(reportsRoot, "doctor.json"), "doctor.json"),
  ]);
  for (const [label, report, status] of [["setup-first", first.value, "installed"], ["setup-second", second.value, "ready"]]) {
    if (report.format !== "cut-footage-local-setup-report" || report.version !== 1 || report.status !== status || report.backend !== "local" || !same(report.identity, backendIdentity)) {
      fail(`${label} does not prove the pinned local backend state`);
    }
  }
  if (doctor.value.format !== "cut-footage-local-doctor-report" || doctor.value.version !== 1 || doctor.value.status !== "pass" || doctor.value.backend !== "local"
    || !Array.isArray(doctor.value.checks) || !doctor.value.checks.some((check) => check?.code === "CUTFD1000" && check.status === "pass")) {
    fail("doctor does not prove the verified offline backend");
  }
  const publicPath = resolve(footageHome, "local-clip-v1"), publicMetadata = await lstat(publicPath);
  if (!publicMetadata.isSymbolicLink()) fail("local backend publication is not one relative symlink");
  const target = await readlink(publicPath);
  if (!target || isAbsolute(target) || target.includes("/") || target === "." || target === "..") fail("local backend publication target is invalid");
  const payload = await realpath(publicPath), relation = relative(await realpath(footageHome), payload);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail("local backend payload escapes its home");
  const install = (await json(resolve(payload, "install-manifest.json"), "install-manifest.json")).value;
  const model = record(install.model, "install model");
  if (install.format !== "cut-footage-local-install" || install.version !== 1 || install.backend !== "local" || install.adapterSha256 !== adapterSha256
    || model.provider !== backendIdentity.provider || model.model !== "Xenova/clip-vit-base-patch32" || model.revision !== modelRevision
    || model.dtype !== "q8" || model.device !== "cpu" || model.dimensions !== 512 || !Array.isArray(model.files)) fail("install manifest does not pin the release backend");
  for (const expected of graphFiles) {
    const actual = model.files.find((candidate) => candidate?.locator === expected.locator);
    if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) fail(`install manifest does not pin ${expected.locator}`);
  }
}

async function rejectResidue(root) {
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const item of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 10_000) fail("project residue scan exceeded its entry bound");
      if (/(?:cut-footage-(?:staging|sidecar)|\.tmp$|\.bak$)/u.test(item.name)) fail(`private residue remained at ${item.name}`);
      if (item.isDirectory()) pending.push(resolve(directory, item.name));
    }
  }
}

export async function assertFootageRealSmoke(projectRoot, reportsRoot, footageHome) {
  const project = await realpath(resolve(projectRoot)), reports = await realpath(resolve(reportsRoot)), home = await realpath(resolve(footageHome));
  await verifySetup(reports, home);
  const indexLoaded = await json(resolve(project, ".cut/footage/index.json"), "index.json", true), index = indexLoaded.value;
  verifySigned(index, "indexSha256", "index");
  if (index.format !== "cut-footage-index" || index.version !== 1 || index.root !== "media" || !same(index.backend, backendIdentity)
    || !Array.isArray(index.sources) || index.sources.length !== 2 || !Array.isArray(index.chunks) || index.chunks.length < 2) fail("index does not prove two sources on the pinned backend");
  for (const source of index.sources) {
    const actual = await fileEvidence(contained(project, source.locator, "indexed source"), source.locator);
    if (actual.bytes !== source.bytes || actual.sha256 !== source.sha256) fail(`${source.locator} does not match the index`);
  }
  const vector = await fileEvidence(contained(project, index.vectorArtifact?.locator, "vector artifact"), "vector artifact");
  if (vector.bytes !== index.vectorArtifact.bytes || vector.sha256 !== index.vectorArtifact.sha256) fail("vector artifact does not match the index");

  const [firstSearch, currentSearch] = await Promise.all([
    json(resolve(reports, "search-first.json"), "search-first.json", true),
    json(resolve(project, ".cut/footage/search.json"), "search.json", true),
  ]);
  if (!firstSearch.bytes.equals(currentSearch.bytes)) fail("repeated offline search was not byte-stable");
  const search = currentSearch.value;
  verifySigned(search, "searchSha256", "search");
  if (search.format !== "cut-footage-search" || search.version !== 1 || search.indexLocator !== ".cut/footage/index.json" || search.indexSha256 !== index.indexSha256
    || search.query?.text !== "a dog outdoors" || !Array.isArray(search.matches) || search.matches.length < 2) fail("search does not bind the expected query and index");
  const [first, ...rest] = search.matches, next = Math.max(...rest.map((match) => Number(match.scorePpm)));
  if (first?.sourceSelection?.locator !== "media/dog-outdoors.mp4" || !Number.isSafeInteger(first.scorePpm) || !Number.isSafeInteger(next)) fail("dog footage is not the first semantic match");
  const marginPpm = first.scorePpm - next;
  if (marginPpm < minimumMarginPpm) fail(`semantic rank margin ${marginPpm} is below ${minimumMarginPpm}`);

  const extractLoaded = await json(resolve(project, "selects/dog.mp4.cut-footage.json"), "extract manifest", true), extract = extractLoaded.value;
  verifySigned(extract, "extractSha256", "extract");
  if (extract.format !== "cut-footage-extract" || extract.version !== 1 || extract.label !== "candidate-only-not-cut-lock"
    || extract.searchSha256 !== search.searchSha256 || extract.indexSha256 !== index.indexSha256 || extract.matchId !== first.id
    || !same(extract.sourceSelection, first.sourceSelection) || extract.output?.locator !== "selects/dog.mp4") fail("extract manifest does not bind the first search match");
  const clip = await fileEvidence(resolve(project, "selects/dog.mp4"), "extracted clip");
  if (clip.bytes !== extract.output.bytes || clip.sha256 !== extract.output.sha256) fail("extracted clip does not match its manifest");
  if (!Array.isArray(extract.output.streams) || extract.output.streams.length !== 1 || extract.output.streams[0]?.index !== 0
    || extract.output.streams[0]?.type !== "video" || extract.output.streams[0]?.codec !== "h264") fail("extract manifest does not prove one H.264 video stream");

  const probe = (await json(resolve(reports, "extract-ffprobe.json"), "extract-ffprobe.json")).value;
  if (!Array.isArray(probe.streams) || probe.streams.length !== 1 || probe.streams[0]?.codec_type !== "video" || probe.streams[0]?.codec_name !== "h264") fail("ffprobe does not prove one H.264 video stream");
  const expectedDuration = rationalNumber(extract.finalRange?.end, "finalRange.end") - rationalNumber(extract.finalRange?.start, "finalRange.start");
  const observedDuration = Number(probe.format?.duration);
  if (!Number.isFinite(observedDuration) || Math.abs(observedDuration - expectedDuration) > (1 / 24)) fail("extracted duration does not match the exact final range");

  const protectedFiles = (await json(resolve(reports, "protected.json"), "protected.json")).value;
  for (const locator of ["main.cut", "cut.lock"]) {
    if (!shaPattern.test(protectedFiles[locator]) || (await fileEvidence(resolve(project, locator), locator)).sha256 !== protectedFiles[locator]) fail(`${locator} changed during semantic footage work`);
  }
  await rejectResidue(project);
  return Object.freeze({
    format: "cut-footage-real-smoke-report",
    version: 1,
    status: "pass",
    backend: backendIdentity.model,
    firstMatch: first.sourceSelection.locator,
    marginPpm,
    extractSha256: extract.extractSha256,
  });
}

async function main() {
  const [project, reports, home, extra] = process.argv.slice(2);
  if (!project || !reports || !home || extra) fail("usage: assert-footage-real-smoke.mjs <project-root> <reports-root> <footage-home>");
  process.stdout.write(`${JSON.stringify(await assertFootageRealSmoke(project, reports, home))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
