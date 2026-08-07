import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";

type HashedArtifact = { path: string; sha256: string };
type Failure = (path: string, message: string) => never;

export type ReferenceStemEvidenceOptions = {
  reviewRoot: string;
  renderManifestPath: string;
  value: unknown;
  expectedLockSha256: string;
  expectedRuntime: unknown;
  expectedExecutionBuildId: unknown;
  expectedDurationSeconds: unknown;
  expectedSampleRate: unknown;
  diagnosticPath: string;
  parseJson: (input: Uint8Array) => unknown;
  verifyArtifacts: (reviewRoot: string, artifacts: HashedArtifact[]) => Promise<unknown>;
  fail: Failure;
};

function record(value: unknown, path: string, fail: Failure): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object.");
  return value as Record<string, unknown>;
}

function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[], fail: Failure) {
  const item = record(value, path, fail), allowed = new Set([...required, ...optional]);
  for (const field of required) if (!Object.hasOwn(item, field)) fail(path, `is missing required field ${JSON.stringify(field)}.`);
  for (const field of Object.keys(item)) if (!allowed.has(field)) fail(`${path}.${field}`, "is not part of lock-bound stem-manifest v5.");
  return item;
}

function digest(value: unknown, path: string, fail: Failure): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(path, "must be a lowercase SHA-256 digest.");
  return value as string;
}

function nonempty(value: unknown, path: string, fail: Failure, maximum = 4096): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) {
    fail(path, `must be non-empty text no longer than ${maximum} UTF-8 bytes without NUL.`);
  }
  return value as string;
}

function safeInteger(value: unknown, path: string, fail: Failure, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function finite(value: unknown, path: string, fail: Failure): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number.");
  return value as number;
}

function portableLocator(value: unknown, path: string, fail: Failure, allowDot = false): string {
  const result = nonempty(value, path, fail, 1024);
  if (allowDot && result === ".") return result;
  if (isAbsolute(result) || /^[A-Za-z]:/u.test(result) || /[\\%?#]/u.test(result)) fail(path, "must be a plain relative POSIX locator.");
  const segments = result.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || ["__proto__", "prototype", "constructor"].includes(segment))) {
    fail(path, "contains an empty, dot, parent, or unsafe segment.");
  }
  return result;
}

function portableFromRoot(root: string, target: string, path: string, fail: Failure) {
  const locator = relative(root, target);
  if (!locator || locator === ".." || locator.startsWith(`..${sep}`) || isAbsolute(locator)) fail(path, "resolves outside the review evidence root.");
  return locator.split(sep).join("/");
}

function exactArray(value: unknown, path: string, fail: Failure, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, `must be an array containing at most ${maximum} items.`);
  const identities = new Set<string>();
  for (const [index, item] of value.entries()) {
    const identity = stableJsonStringify(item);
    if (identities.has(identity)) fail(`${path}[${index}]`, "duplicates an earlier entry.");
    identities.add(identity);
  }
  return value as unknown[];
}

function nodeId(value: unknown, path: string, fail: Failure): string {
  return nonempty(value, path, fail, 1024);
}

const stemNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function stemName(value: unknown, path: string, fail: Failure): string {
  if (typeof value !== "string" || !stemNamePattern.test(value) || windowsDeviceName.test(value)) fail(path, "must be a portable CUT stem name.");
  return value as string;
}

function validatePeak(value: unknown, path: string, expectedFrames: number, fail: Failure) {
  const item = closed(value, path, [
    "format", "version", "sampleFormat", "channels", "expectedFrames", "observedFrames",
    "expectedBytes", "observedBytes", "thresholdDbfs", "thresholdLinear", "silent",
    "peakLinear", "peakDbfs", "peakFrame", "peakChannel", "peakChannelName", "peakSample",
  ], [], fail);
  if (item.format !== "cut-reference-audio-peak-scan" || item.version !== 1 || item.sampleFormat !== "f32le" || item.channels !== 2) fail(path, "must use the exact stereo f32le peak-scan v1 contract.");
  if (item.expectedFrames !== expectedFrames || item.observedFrames !== expectedFrames || item.expectedBytes !== expectedFrames * 8 || item.observedBytes !== expectedFrames * 8) fail(path, "does not reconcile to the composition sample count.");
  finite(item.thresholdDbfs, `${path}.thresholdDbfs`, fail);
  finite(item.thresholdLinear, `${path}.thresholdLinear`, fail);
  const peakLinear = finite(item.peakLinear, `${path}.peakLinear`, fail);
  if (peakLinear < 0) fail(`${path}.peakLinear`, "must be non-negative.");
  if (typeof item.silent !== "boolean") fail(`${path}.silent`, "must be boolean.");
  const nullableFinite = (candidate: unknown, field: string) => candidate === null ? null : finite(candidate, `${path}.${field}`, fail);
  const peakDbfs = nullableFinite(item.peakDbfs, "peakDbfs");
  const peakSample = nullableFinite(item.peakSample, "peakSample");
  const peakFrame = item.peakFrame === null ? null : safeInteger(item.peakFrame, `${path}.peakFrame`, fail);
  if (!(item.peakChannel === null || item.peakChannel === 0 || item.peakChannel === 1)) fail(`${path}.peakChannel`, "must be null, 0, or 1.");
  if (!(item.peakChannelName === null || item.peakChannelName === "left" || item.peakChannelName === "right")) fail(`${path}.peakChannelName`, "must be null, left, or right.");
  if (item.silent) {
    if (peakDbfs !== null || peakFrame !== null || item.peakChannel !== null || item.peakChannelName !== null || peakSample !== null) fail(path, "a silent scan must use null peak coordinates and values.");
  } else {
    if (peakDbfs === null || peakSample === null || peakFrame === null || peakFrame >= expectedFrames || (item.peakChannel !== 0 && item.peakChannel !== 1) || item.peakChannelName !== (item.peakChannel === 0 ? "left" : "right")) fail(path, "a non-silent scan must identify one in-range stereo peak sample.");
  }
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, length: number, position: number, path: string, fail: Failure) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) fail(path, `has an unexpected end of file at byte ${position + offset}.`);
    offset += bytesRead;
  }
  return buffer;
}

async function verifyPcm24Wave(pathname: string, diagnosticPath: string, expectedSampleRate: number, expectedSamples: number, expectedBytes: number, fail: Failure) {
  const handle = await open(pathname, "r");
  try {
    const file = await handle.stat();
    if (file.size !== expectedBytes) fail(`${diagnosticPath}.bytes`, `declares ${expectedBytes} bytes, but the WAVE file contains ${file.size}.`);
    if (file.size < 44) fail(diagnosticPath, "is too short to be a valid PCM WAVE file.");
    const header = await readExactly(handle, 12, 0, diagnosticPath, fail);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") fail(diagnosticPath, "must be a classic RIFF/WAVE file.");
    let cursor = 12, chunks = 0;
    let format: { code: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number; validBits?: number; channelMask?: number; subformat?: number } | undefined;
    let dataBytes: number | undefined;
    while (cursor + 8 <= file.size && (format === undefined || dataBytes === undefined)) {
      if (++chunks > 128) fail(diagnosticPath, "contains more than 128 WAVE chunks.");
      const chunk = await readExactly(handle, 8, cursor, diagnosticPath, fail), id = chunk.toString("ascii", 0, 4), size = chunk.readUInt32LE(4), body = cursor + 8;
      if (body + size > file.size) fail(diagnosticPath, `has a truncated ${JSON.stringify(id)} chunk.`);
      if (id === "fmt ") {
        if (size < 16) fail(diagnosticPath, "has a short WAVE format chunk.");
        const value = await readExactly(handle, size >= 40 ? 40 : 16, body, diagnosticPath, fail), code = value.readUInt16LE(0);
        format = {
          code,
          channels: value.readUInt16LE(2),
          sampleRate: value.readUInt32LE(4),
          byteRate: value.readUInt32LE(8),
          blockAlign: value.readUInt16LE(12),
          bits: value.readUInt16LE(14),
          ...(code === 0xfffe && value.length >= 40 ? { validBits: value.readUInt16LE(18), channelMask: value.readUInt32LE(20), subformat: value.readUInt32LE(24) } : {}),
        };
      } else if (id === "data") dataBytes = size;
      cursor = body + size + (size % 2);
    }
    if (!format || dataBytes === undefined) fail(diagnosticPath, "is missing a WAVE format or data chunk.");
    const pcm = format.code === 1 || (format.code === 0xfffe && format.validBits === 24 && format.channelMask === 3 && format.subformat === 1);
    if (!pcm || format.channels !== 2 || format.sampleRate !== expectedSampleRate || format.byteRate !== expectedSampleRate * 6 || format.blockAlign !== 6 || format.bits !== 24) fail(diagnosticPath, `must be ${expectedSampleRate} Hz stereo signed-24-bit PCM.`);
    if (dataBytes !== expectedSamples * 6) fail(`${diagnosticPath}.samples`, `does not contain the declared ${expectedSamples} stereo sample frames.`);
  } finally {
    await handle.close();
  }
}

/**
 * Follow one render-manifest v11 stem marker through the canonical v5
 * manifest to every declared WAVE leaf. This validator is intentionally
 * independent of the producer so review cannot inherit producer assumptions.
 */
export async function verifyReferenceStemEvidence(options: ReferenceStemEvidenceOptions) {
  const { reviewRoot, renderManifestPath, expectedLockSha256, diagnosticPath, parseJson, verifyArtifacts, fail } = options;
  const expectedRuntime = nonempty(options.expectedRuntime, "$.artifact.renderManifest.runtime", fail, 1024);
  const expectedExecutionBuildId = digest(options.expectedExecutionBuildId, "$.artifact.renderManifest.executionBuildId", fail);
  const expectedDurationSeconds = finite(options.expectedDurationSeconds, "$.artifact.renderManifest.duration", fail);
  const expectedSampleRate = safeInteger(options.expectedSampleRate, "$.artifact.renderManifest.audio.sampleRate", fail, 1);
  const marker = closed(options.value, diagnosticPath, ["directory", "manifest", "manifestSha256", "count"], [], fail);
  const directory = portableLocator(marker.directory, `${diagnosticPath}.directory`, fail, true);
  const manifestLocator = portableLocator(marker.manifest, `${diagnosticPath}.manifest`, fail);
  const manifestParent = manifestLocator.includes("/") ? manifestLocator.slice(0, manifestLocator.lastIndexOf("/")) : ".";
  if (directory !== manifestParent) fail(`${diagnosticPath}.directory`, `must equal the exact parent ${JSON.stringify(manifestParent)} of ${diagnosticPath}.manifest.`);
  const manifestSha256 = digest(marker.manifestSha256, `${diagnosticPath}.manifestSha256`, fail);
  const count = safeInteger(marker.count, `${diagnosticPath}.count`, fail, 1, 64);
  const manifestPath = resolve(dirname(renderManifestPath), ...manifestLocator.split("/"));
  const portableManifestPath = portableFromRoot(reviewRoot, manifestPath, `${diagnosticPath}.manifest`, fail);
  await verifyArtifacts(reviewRoot, [{ path: portableManifestPath, sha256: manifestSha256 }]);
  const manifestBytes = await readFile(manifestPath), rawManifest = parseJson(manifestBytes);
  if (manifestBytes.toString("utf8") !== `${stableJsonStringify(rawManifest)}\n`) fail(`${diagnosticPath}.manifest`, "must use CUT's canonical stem-manifest serialization.");

  const manifestPathDiagnostic = `${diagnosticPath}.manifest`;
  const manifest = closed(rawManifest, manifestPathDiagnostic, ["format", "version", "runtime", "lock", "buildId", "composition", "relationship", "stems"], [], fail);
  if (manifest.format !== "cut-reference-stems" || manifest.version !== 5) fail(`${manifestPathDiagnostic}.version`, "must be lock-bound stem-manifest v5.");
  if (nonempty(manifest.runtime, `${manifestPathDiagnostic}.runtime`, fail, 1024) !== expectedRuntime) fail(`${manifestPathDiagnostic}.runtime`, "does not match the selected render runtime.");
  if (digest(manifest.buildId, `${manifestPathDiagnostic}.buildId`, fail) !== expectedExecutionBuildId) fail(`${manifestPathDiagnostic}.buildId`, "does not match the selected render executionBuildId.");
  const lock = closed(manifest.lock, `${manifestPathDiagnostic}.lock`, ["sha256"], [], fail);
  if (digest(lock.sha256, `${manifestPathDiagnostic}.lock.sha256`, fail) !== expectedLockSha256) fail(`${manifestPathDiagnostic}.lock.sha256`, "does not bind the selected render lock.");

  const composition = closed(manifest.composition, `${manifestPathDiagnostic}.composition`, ["id", "name", "duration", "sampleRate", "channels", "sampleFormat", "samples"], [], fail);
  nonempty(composition.id, `${manifestPathDiagnostic}.composition.id`, fail, 1024);
  if (typeof composition.name !== "string" || composition.name.includes("\0") || Buffer.byteLength(composition.name, "utf8") > 4096) fail(`${manifestPathDiagnostic}.composition.name`, "must be bounded text without NUL.");
  const duration = closed(composition.duration, `${manifestPathDiagnostic}.composition.duration`, ["numerator", "denominator"], [], fail);
  if (typeof duration.numerator !== "string" || !/^-?[0-9]+$/u.test(duration.numerator) || duration.numerator.length > 128) fail(`${manifestPathDiagnostic}.composition.duration.numerator`, "must be a bounded decimal integer string.");
  if (typeof duration.denominator !== "string" || !/^[1-9][0-9]*$/u.test(duration.denominator) || duration.denominator.length > 128) fail(`${manifestPathDiagnostic}.composition.duration.denominator`, "must be a bounded positive decimal integer string.");
  const durationNumeratorText = duration.numerator as string, durationDenominatorText = duration.denominator as string;
  const sampleRate = safeInteger(composition.sampleRate, `${manifestPathDiagnostic}.composition.sampleRate`, fail, 1);
  if (sampleRate !== expectedSampleRate) fail(`${manifestPathDiagnostic}.composition.sampleRate`, "does not match the selected render audio sample rate.");
  if (composition.channels !== 2 || composition.sampleFormat !== "s24le") fail(`${manifestPathDiagnostic}.composition`, "must declare stereo s24le delivery.");
  const samples = safeInteger(composition.samples, `${manifestPathDiagnostic}.composition.samples`, fail, 0, Math.floor((0xffffffff - 4096) / 6));
  const durationNumerator = BigInt(durationNumeratorText), durationDenominator = BigInt(durationDenominatorText), sampleNumerator = durationNumerator * BigInt(sampleRate);
  if (durationNumerator < 0n || sampleNumerator % durationDenominator !== 0n || sampleNumerator / durationDenominator !== BigInt(samples)) fail(`${manifestPathDiagnostic}.composition.samples`, "must equal exact duration multiplied by sampleRate on an integer sample boundary.");
  const rationalSeconds = Number(durationNumerator) / Number(durationDenominator);
  if (!Number.isFinite(rationalSeconds) || Math.abs(rationalSeconds - expectedDurationSeconds) > 1e-9) fail(`${manifestPathDiagnostic}.composition.duration`, "does not match the selected render duration.");

  const relationship = closed(manifest.relationship, `${manifestPathDiagnostic}.relationship`, ["stage", "mix", "normalization", "peakValidation", "quantization"], [], fail);
  if (relationship.stage !== "pre-master" || relationship.mix !== "decoded-sum-with-s24-rounding" || relationship.normalization !== "none" || relationship.peakValidation !== "exact-f32le-before-quantization" || relationship.quantization !== "nearest-ties-to-even") fail(`${manifestPathDiagnostic}.relationship`, "must use the exact CUT pre-master stem relationship contract.");

  if (!Array.isArray(manifest.stems) || manifest.stems.length !== count) fail(`${diagnosticPath}.count`, "does not match the exact stem-manifest entry count.");
  const rawStems = manifest.stems as unknown[];
  const names = new Set<string>(), files = new Set<string>(), claimedSidechainNodes = new Set<string>(), routes = new Map<string, { name: string; kind: string; auxiliary: string[]; sidechains: string[] }>();
  const waveArtifacts: HashedArtifact[] = [], entries: Array<{ path: string; absolute: string; bytes: number; samples: number; sampleRate: number }> = [];
  for (const [index, rawStem] of rawStems.entries()) {
    const path = `${manifestPathDiagnostic}.stems[${index}]`;
    const stem = closed(rawStem, path, ["name", "kind", "auxiliaryInputs", "sidechainInputs", "nodeId", "graphHash", "file", "sha256", "bytes", "sampleRate", "channels", "sampleFormat", "samples", "peak"], ["role"], fail);
    const name = stemName(stem.name, `${path}.name`, fail), foldedName = name.toLowerCase();
    if (names.has(foldedName)) fail(`${path}.name`, "duplicates an earlier stem name case-insensitively.");
    names.add(foldedName);
    if (stem.kind !== "program" && stem.kind !== "aux") fail(`${path}.kind`, "must be program or aux.");
    const kind = stem.kind as "program" | "aux";
    if (stem.role !== undefined && (typeof stem.role !== "string" || !["dialogue", "music", "ambience", "sfx"].includes(stem.role))) fail(`${path}.role`, "must be dialogue, music, ambience, or sfx.");
    nodeId(stem.nodeId, `${path}.nodeId`, fail);
    digest(stem.graphHash, `${path}.graphHash`, fail);
    const file = portableLocator(stem.file, `${path}.file`, fail);
    if (file.includes("/") || file !== `${name}.wav`) fail(`${path}.file`, `must be the direct WAVE leaf ${JSON.stringify(`${name}.wav`)}.`);
    const foldedFile = file.toLowerCase();
    if (files.has(foldedFile)) fail(`${path}.file`, "duplicates an earlier WAVE leaf case-insensitively.");
    files.add(foldedFile);
    const bytes = safeInteger(stem.bytes, `${path}.bytes`, fail, 1);
    if (stem.sampleRate !== sampleRate || stem.channels !== 2 || stem.sampleFormat !== "s24le" || stem.samples !== samples) fail(path, "must reconcile sample rate, channels, format, and sample count to the composition.");
    validatePeak(stem.peak, `${path}.peak`, samples, fail);

    const auxiliary = exactArray(stem.auxiliaryInputs, `${path}.auxiliaryInputs`, fail, 256).map((rawInput, inputIndex) => {
      const inputPath = `${path}.auxiliaryInputs[${inputIndex}]`, input = closed(rawInput, inputPath, ["returnNodeId", "sendNodeId", "sourceStem"], [], fail);
      nodeId(input.returnNodeId, `${inputPath}.returnNodeId`, fail); nodeId(input.sendNodeId, `${inputPath}.sendNodeId`, fail);
      return stemName(input.sourceStem, `${inputPath}.sourceStem`, fail);
    });
    const rawSidechains = exactArray(stem.sidechainInputs, `${path}.sidechainInputs`, fail, 1024);
    const sidechainRecords = rawSidechains.map((rawInput, inputIndex) => {
      const inputPath = `${path}.sidechainInputs[${inputIndex}]`, input = closed(rawInput, inputPath, ["sidechainNodeId", "keyNodeId", "sourceStem", "sidechainGraphHash", "keyGraphHash"], [], fail);
      const sidechainNodeId = nodeId(input.sidechainNodeId, `${inputPath}.sidechainNodeId`, fail), keyNodeId = nodeId(input.keyNodeId, `${inputPath}.keyNodeId`, fail);
      if (claimedSidechainNodes.has(sidechainNodeId)) fail(`${inputPath}.sidechainNodeId`, "is already claimed by another stem control dependency.");
      claimedSidechainNodes.add(sidechainNodeId);
      const sidechainGraphHash = digest(input.sidechainGraphHash, `${inputPath}.sidechainGraphHash`, fail), keyGraphHash = digest(input.keyGraphHash, `${inputPath}.keyGraphHash`, fail);
      return { sourceStem: stemName(input.sourceStem, `${inputPath}.sourceStem`, fail), sidechainNodeId, keyNodeId, sidechainGraphHash, keyGraphHash };
    });
    const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    const canonicalSidechains = [...sidechainRecords].sort((left, right) => compareText(left.sidechainNodeId, right.sidechainNodeId) || compareText(left.keyNodeId, right.keyNodeId));
    if (stableJsonStringify(sidechainRecords) !== stableJsonStringify(canonicalSidechains)) fail(`${path}.sidechainInputs`, "must use canonical source/node/hash order.");
    const sidechains = sidechainRecords.map((input) => input.sourceStem);
    if ((kind === "program" && auxiliary.length !== 0) || (kind === "aux" && auxiliary.length === 0)) fail(`${path}.auxiliaryInputs`, "must be empty for a program stem and non-empty for an auxiliary return.");
    routes.set(foldedName, { name, kind, auxiliary, sidechains });

    const absolute = resolve(dirname(manifestPath), file), portable = portableFromRoot(reviewRoot, absolute, `${path}.file`, fail);
    waveArtifacts.push({ path: portable, sha256: digest(stem.sha256, `${path}.sha256`, fail) });
    entries.push({ path, absolute, bytes, samples, sampleRate });
  }
  for (const route of routes.values()) {
    for (const sourceName of route.auxiliary) {
      const source = routes.get(sourceName.toLowerCase());
      if (!source || source.name !== sourceName || source.kind !== "program") fail(manifestPathDiagnostic, `auxiliary route ${JSON.stringify(route.name)} references missing or non-program source ${JSON.stringify(sourceName)}.`);
    }
    for (const sourceName of route.sidechains) {
      const source = routes.get(sourceName.toLowerCase());
      if (!source || source.name !== sourceName) fail(manifestPathDiagnostic, `sidechain route ${JSON.stringify(route.name)} references missing source ${JSON.stringify(sourceName)}.`);
      if (source!.name !== route.name && (source!.kind === "aux" || route.kind === "aux")) fail(manifestPathDiagnostic, "cross-stem sidechain control is limited to program stems.");
    }
  }
  const states = new Map<string, "visiting" | "done">();
  const visit = (name: string) => {
    if (states.get(name) === "visiting") fail(manifestPathDiagnostic, `contains a cross-stem sidechain cycle at ${JSON.stringify(routes.get(name)?.name ?? name)}.`);
    if (states.get(name) === "done") return;
    const route = routes.get(name); if (!route) return;
    states.set(name, "visiting");
    for (const sourceName of route.sidechains) if (sourceName.toLowerCase() !== name) visit(sourceName.toLowerCase());
    states.set(name, "done");
  };
  for (const name of routes.keys()) visit(name);
  await verifyArtifacts(reviewRoot, waveArtifacts);
  for (const entry of entries) await verifyPcm24Wave(entry.absolute, entry.path, entry.sampleRate, entry.samples, entry.bytes, fail);
  return { count, manifestPath: portableManifestPath, waveArtifacts };
}
