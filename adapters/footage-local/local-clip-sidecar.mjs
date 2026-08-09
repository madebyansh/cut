import { Blob } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { link, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const localClipAdapterContract = Object.freeze({
  protocolVersion: 1,
  provider: "huggingface-transformers-js",
  model: "Xenova/clip-vit-base-patch32",
  revision: "d15189d7028b43f1d3e65039190477f6af591c2a",
  dtype: "q8",
  device: "cpu",
  dimensions: 512,
  normalization: "l2",
  maximumRequestLineBytes: 1024 * 1024,
  maximumPlanBytes: 64 * 1024 * 1024,
  maximumArtifactBytes: 512 * 1024 * 1024,
  maximumRecords: 100_000,
  maximumFramesPerChunk: 8,
  maximumFrameReferences: 800_000,
  maximumFrameBytes: 4 * 1024 * 1024,
  maximumReferencedFrameBytes: 8 * 1024 * 1024 * 1024,
  imageBatchSize: 8,
});

export const localClipSelfTestDescriptor = Object.freeze({
  format: "cut-footage-local-self-test",
  version: 1,
  provider: localClipAdapterContract.provider,
  model: localClipAdapterContract.model,
  revision: localClipAdapterContract.revision,
  dtype: localClipAdapterContract.dtype,
  device: localClipAdapterContract.device,
  dimensions: localClipAdapterContract.dimensions,
  normalization: localClipAdapterContract.normalization,
  text: "cut semantic footage self test",
  image: Object.freeze({
    format: "rgb8",
    width: 2,
    height: 2,
    channels: 3,
    pixelsBase64: "/wAAAP8AAAD/////",
  }),
  checks: Object.freeze([
    "text-embedding-finite-nonzero-512",
    "image-embedding-finite-nonzero-512",
    "l2-normalization-finite-unit",
  ]),
});

const shaPattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const magic = Buffer.from("CUTFVEC1", "ascii");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const defaultFilesystem = Object.freeze({ link, lstat, open });

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (typeof value === "bigint") throw new TypeError("value is not JSON-compatible");
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("value is cyclic");
    seen.add(value);
    const result = value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return null;
      return canonicalValue(item, seen);
    });
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new TypeError("value is cyclic");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("value is not a JSON object");
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort(byteCompare)) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      result[key] = canonicalValue(item, seen);
    }
    seen.delete(value);
    return result;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  throw new TypeError("value is not JSON-compatible");
}

export function canonicalJson(value) {
  const canonical = canonicalValue(value, new Set());
  const result = JSON.stringify(canonical);
  if (result === undefined) throw new TypeError("value has no JSON representation");
  return result;
}

export const localClipSelfTestSha256 = createHash("sha256")
  .update(canonicalJson(localClipSelfTestDescriptor), "utf8")
  .digest("hex");

function positiveInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function validId(value) {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 128
    && idPattern.test(value);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(byteCompare);
  const expected = [...keys].sort(byteCompare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasControls(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function canonicalAbsolutePosixPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")
    || Buffer.byteLength(value, "utf8") > 16_384 || hasControls(value)) return false;
  const parts = value.split("/");
  return parts.length > 1 && parts.slice(1).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function vectorNorm(values) {
  let sum = 0;
  for (const value of values) sum += Number(value) * Number(value);
  return Math.sqrt(sum);
}

export function normalizeEmbedding(values, dimensions) {
  positiveInteger(dimensions, 65_536, "embedding dimensions");
  if (!values || typeof values.length !== "number" || values.length !== dimensions) throw new TypeError("embedding shape is invalid");
  let sum = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) throw new TypeError("embedding contains a non-finite value");
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new TypeError("embedding has a zero or invalid norm");
  const output = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const value = Math.fround(Number(values[index]) / norm);
    output[index] = Object.is(value, -0) ? 0 : value;
  }
  const outputNorm = vectorNorm(output);
  if (!Number.isFinite(outputNorm) || Math.abs(outputNorm - 1) > 1e-4) throw new TypeError("embedding normalization failed");
  return output;
}

export function parseIndexPlan(bytes, expectedDimensions) {
  try {
    positiveInteger(expectedDimensions, 65_536, "plan dimensions");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > localClipAdapterContract.maximumPlanBytes) throw new TypeError();
    let text;
    try { text = utf8.decode(bytes); } catch { throw new TypeError(); }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new TypeError(); }
    if (`${canonicalJson(parsed)}\n` !== text
      || !exactKeys(parsed, ["format", "version", "dimensions", "chunks"])
      || parsed.format !== "cut-footage-sidecar-index-plan" || parsed.version !== 1
      || parsed.dimensions !== expectedDimensions || !Array.isArray(parsed.chunks)
      || parsed.chunks.length < 1 || parsed.chunks.length > localClipAdapterContract.maximumRecords) throw new TypeError();

    const chunks = [];
    const evidenceByPath = new Map();
    let previousChunkId;
    let frameReferences = 0;
    let referencedBytes = 0;
    for (const value of parsed.chunks) {
      if (!exactKeys(value, ["id", "frames"]) || !validId(value.id)
        || (previousChunkId !== undefined && byteCompare(previousChunkId, value.id) >= 0)
        || !Array.isArray(value.frames) || value.frames.length < 1
        || value.frames.length > localClipAdapterContract.maximumFramesPerChunk) throw new TypeError();
      const frames = [];
      let previousPath;
      for (const frameValue of value.frames) {
        if (!exactKeys(frameValue, ["path", "bytes", "sha256"])
          || !canonicalAbsolutePosixPath(frameValue.path)
          || !Number.isSafeInteger(frameValue.bytes) || frameValue.bytes < 1
          || frameValue.bytes > localClipAdapterContract.maximumFrameBytes
          || typeof frameValue.sha256 !== "string" || !shaPattern.test(frameValue.sha256)
          || (previousPath !== undefined && byteCompare(previousPath, frameValue.path) >= 0)) throw new TypeError();
        frameReferences += 1;
        referencedBytes += frameValue.bytes;
        if (frameReferences > localClipAdapterContract.maximumFrameReferences
          || referencedBytes > localClipAdapterContract.maximumReferencedFrameBytes) throw new TypeError();
        const evidence = `${frameValue.bytes}:${frameValue.sha256}`;
        const priorEvidence = evidenceByPath.get(frameValue.path);
        if (priorEvidence !== undefined && priorEvidence !== evidence) throw new TypeError();
        evidenceByPath.set(frameValue.path, evidence);
        frames.push(Object.freeze({ path: frameValue.path, bytes: frameValue.bytes, sha256: frameValue.sha256 }));
        previousPath = frameValue.path;
      }
      chunks.push(Object.freeze({ id: value.id, frames: Object.freeze(frames) }));
      previousChunkId = value.id;
    }
    return Object.freeze({
      format: "cut-footage-sidecar-index-plan",
      version: 1,
      dimensions: expectedDimensions,
      chunks: Object.freeze(chunks),
    });
  } catch {
    throw new TypeError("index plan is malformed");
  }
}

function validateCanonicalVector(vector, dimensions) {
  if (!(vector instanceof Float32Array) || vector.length !== dimensions) throw new TypeError("vector shape is invalid");
  for (const value of vector) {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("vector is not canonical");
  }
  if (Math.abs(vectorNorm(vector) - 1) > 1e-4) throw new TypeError("vector is not normalized");
}

function encodeRecord(record, dimensions, previousId) {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).sort().join(",") !== "id,vector") throw new TypeError("record is malformed");
  if (!validId(record.id) || (previousId !== undefined && byteCompare(previousId, record.id) >= 0)) throw new TypeError("record IDs are not canonical");
  if (!(record.vector instanceof Float32Array) || record.vector.length !== dimensions) throw new TypeError("vector shape is invalid");
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const component = record.vector[index];
    if (!Number.isFinite(component)) throw new TypeError("vector is not canonical");
    vector[index] = Object.is(component, -0) ? 0 : component;
  }
  validateCanonicalVector(vector, dimensions);
  const id = Buffer.from(record.id, "utf8");
  const bytes = Buffer.allocUnsafe(2 + id.byteLength + dimensions * 4);
  bytes.writeUInt16LE(id.byteLength, 0);
  id.copy(bytes, 2);
  let offset = 2 + id.byteLength;
  for (const component of vector) {
    bytes.writeFloatLE(component, offset);
    offset += 4;
  }
  return bytes;
}

export function encodeCutFvec1(planSha256, records, dimensions) {
  positiveInteger(dimensions, 65_536, "vector dimensions");
  if (typeof planSha256 !== "string" || !shaPattern.test(planSha256)) throw new TypeError("plan SHA-256 is invalid");
  if (!Array.isArray(records)) throw new TypeError("records are invalid");
  positiveInteger(records.length, localClipAdapterContract.maximumRecords, "record count");
  const header = Buffer.alloc(48);
  magic.copy(header, 0);
  header.writeUInt32LE(dimensions, 8);
  header.writeUInt32LE(records.length, 12);
  Buffer.from(planSha256, "hex").copy(header, 16);
  const chunks = [header];
  let bytes = header.byteLength;
  let previousId;
  for (const record of records) {
    const chunk = encodeRecord(record, dimensions, previousId);
    previousId = record.id;
    bytes += chunk.byteLength;
    if (bytes > localClipAdapterContract.maximumArtifactBytes) throw new TypeError("artifact exceeds its byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

export function parseCutFvec1(bytes, expectedDimensions) {
  positiveInteger(expectedDimensions, 65_536, "expected dimensions");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 48 || bytes.byteLength > localClipAdapterContract.maximumArtifactBytes) throw new TypeError("artifact is malformed");
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!input.subarray(0, 8).equals(magic)) throw new TypeError("artifact magic is invalid");
  const dimensions = input.readUInt32LE(8);
  if (dimensions !== expectedDimensions) throw new TypeError("artifact dimensions are invalid");
  const recordCount = input.readUInt32LE(12);
  positiveInteger(recordCount, localClipAdapterContract.maximumRecords, "artifact record count");
  const planSha256 = input.subarray(16, 48).toString("hex");
  const records = [];
  let offset = 48;
  let previousId;
  for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
    if (offset + 2 > input.byteLength) throw new TypeError("artifact length is invalid");
    const idBytes = input.readUInt16LE(offset);
    offset += 2;
    const vectorBytes = dimensions * 4;
    if (idBytes < 1 || idBytes > 128 || offset + idBytes + vectorBytes > input.byteLength) throw new TypeError("artifact record is malformed");
    let id;
    try { id = utf8.decode(input.subarray(offset, offset + idBytes)); } catch { throw new TypeError("artifact ID is not UTF-8"); }
    offset += idBytes;
    if (!validId(id) || (previousId !== undefined && byteCompare(previousId, id) >= 0)) throw new TypeError("artifact IDs are not canonical");
    const vector = new Float32Array(dimensions);
    for (let component = 0; component < dimensions; component += 1) {
      const value = input.readFloatLE(offset);
      offset += 4;
      if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("artifact vector is not canonical");
      vector[component] = value;
    }
    try { validateCanonicalVector(vector, dimensions); } catch { throw new TypeError("artifact vector is invalid"); }
    records.push(Object.freeze({ id, vector }));
    previousId = id;
  }
  if (offset !== input.byteLength) throw new TypeError("artifact has trailing bytes");
  return Object.freeze({ planSha256, dimensions, records: Object.freeze(records) });
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value
    || Buffer.byteLength(value, "utf8") > 16_384 || hasControls(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireTransformersModule(module) {
  const names = [
    "AutoTokenizer",
    "AutoProcessor",
    "CLIPTextModelWithProjection",
    "CLIPVisionModelWithProjection",
    "RawImage",
    "env",
  ];
  if (!module || typeof module !== "object" || names.some((name) => !Object.hasOwn(module, name))) {
    throw new TypeError("Transformers runtime is malformed");
  }
  for (const name of names.slice(0, 4)) {
    if (typeof module[name]?.from_pretrained !== "function") throw new TypeError("Transformers runtime is malformed");
  }
  if (typeof module.RawImage !== "function" || !module.env || typeof module.env !== "object") throw new TypeError("Transformers runtime is malformed");
  return module;
}

function tensorRows(tensor, count, dimensions, label) {
  if (!tensor || typeof tensor !== "object" || !Array.isArray(tensor.dims)
    || tensor.dims.length !== 2 || tensor.dims[0] !== count || tensor.dims[1] !== dimensions
    || !tensor.data || typeof tensor.data.length !== "number" || tensor.data.length !== count * dimensions) {
    throw new TypeError(`${label} tensor shape is invalid`);
  }
  const rows = [];
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    const row = new Float32Array(dimensions);
    let nonzero = false;
    for (let component = 0; component < dimensions; component += 1) {
      const value = Number(tensor.data[rowIndex * dimensions + component]);
      if (!Number.isFinite(value)) throw new TypeError(`${label} tensor is not finite`);
      const rounded = Math.fround(value);
      row[component] = Object.is(rounded, -0) ? 0 : rounded;
      if (rounded !== 0) nonzero = true;
    }
    if (!nonzero) throw new TypeError(`${label} tensor has a zero row`);
    rows.push(row);
  }
  return Object.freeze(rows);
}

export async function createTransformersRuntime(options) {
  if (!options || typeof options !== "object" || (options.mode !== "setup" && options.mode !== "offline")) throw new TypeError("runtime mode is invalid");
  const installationRoot = absolutePath(options.installationRoot, "installation directory");
  const modelRevisionRoot = absolutePath(options.modelRevisionRoot, "model directory");
  let cacheRoot;
  if (options.mode === "setup") {
    cacheRoot = absolutePath(options.cacheRoot, "cache directory");
    const expectedRoot = join(cacheRoot, ...localClipAdapterContract.model.split("/"), localClipAdapterContract.revision);
    if (modelRevisionRoot !== expectedRoot) throw new TypeError("model directory is invalid");
  }

  let transformersModule = options.transformersModule;
  if (transformersModule === undefined) {
    const moduleEntry = join(installationRoot, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs");
    let metadata;
    try { metadata = await lstat(moduleEntry); } catch { throw new TypeError("Transformers runtime is unavailable"); }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 64 * 1024 * 1024) throw new TypeError("Transformers runtime is unavailable");
    transformersModule = await import(pathToFileURL(moduleEntry).href);
  }
  const {
    AutoTokenizer,
    AutoProcessor,
    CLIPTextModelWithProjection,
    CLIPVisionModelWithProjection,
    RawImage,
    env,
  } = requireTransformersModule(transformersModule);

  env.logLevel = 50;

  let lookup;
  let modelOptions;
  let pretrained;
  if (options.mode === "setup") {
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    env.useFSCache = true;
    env.cacheDir = cacheRoot;
    pretrained = localClipAdapterContract.model;
    lookup = Object.freeze({ revision: localClipAdapterContract.revision, cache_dir: cacheRoot });
    modelOptions = Object.freeze({ ...lookup, device: "cpu", dtype: "q8" });
  } else {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useFSCache = true;
    delete env.cacheDir;
    pretrained = modelRevisionRoot;
    lookup = Object.freeze({ local_files_only: true });
    modelOptions = Object.freeze({ ...lookup, device: "cpu", dtype: "q8" });
  }

  const tokenizer = await AutoTokenizer.from_pretrained(pretrained, lookup);
  const processor = await AutoProcessor.from_pretrained(pretrained, lookup);
  const textModel = await CLIPTextModelWithProjection.from_pretrained(pretrained, modelOptions);
  const visionModel = await CLIPVisionModelWithProjection.from_pretrained(pretrained, modelOptions);
  if (typeof tokenizer !== "function" || typeof processor !== "function" || typeof textModel !== "function" || typeof visionModel !== "function") {
    throw new TypeError("Transformers runtime is malformed");
  }

  let disposed = false;
  return Object.freeze({
    createSelfTestImage() {
      return new RawImage(Buffer.from(localClipSelfTestDescriptor.image.pixelsBase64, "base64"), 2, 2, 3);
    },
    async decodeImage(frameBytes) {
      if (!(frameBytes instanceof Uint8Array)) throw new TypeError("frame bytes are invalid");
      return RawImage.read(new Blob([frameBytes]));
    },
    async embedTexts(texts) {
      if (!Array.isArray(texts) || texts.length < 1) throw new TypeError("text batch is invalid");
      const inputs = tokenizer(texts, { padding: true, truncation: true });
      const output = await textModel(inputs);
      return tensorRows(output?.text_embeds, texts.length, localClipAdapterContract.dimensions, "text");
    },
    async embedImages(images) {
      if (!Array.isArray(images) || images.length < 1 || images.length > localClipAdapterContract.imageBatchSize) throw new TypeError("image batch is invalid");
      const inputs = await processor(images);
      const output = await visionModel(inputs);
      return tensorRows(output?.image_embeds, images.length, localClipAdapterContract.dimensions, "image");
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([
        typeof textModel.dispose === "function" ? Promise.resolve().then(() => textModel.dispose()) : Promise.resolve(),
        typeof visionModel.dispose === "function" ? Promise.resolve().then(() => visionModel.dispose()) : Promise.resolve(),
      ]);
    },
  });
}

export async function runLocalClipSelfTest(runtime) {
  try {
    if (localClipSelfTestSha256 !== "ba7503358ab88be43b6e50d5d8a0f5367e22241208d832248ccb32209372aae7"
      || !runtime || typeof runtime.createSelfTestImage !== "function"
      || typeof runtime.embedTexts !== "function" || typeof runtime.embedImages !== "function") throw new TypeError();
    const textRows = await runtime.embedTexts([localClipSelfTestDescriptor.text]);
    const imageRows = await runtime.embedImages([runtime.createSelfTestImage()]);
    if (!Array.isArray(textRows) || textRows.length !== 1 || !Array.isArray(imageRows) || imageRows.length !== 1) throw new TypeError();
    const text = normalizeEmbedding(textRows[0], localClipAdapterContract.dimensions);
    const image = normalizeEmbedding(imageRows[0], localClipAdapterContract.dimensions);
    let dot = 0;
    for (let index = 0; index < localClipAdapterContract.dimensions; index += 1) dot += Number(text[index]) * Number(image[index]);
    if (!Number.isFinite(dot) || dot < -1.0001 || dot > 1.0001) throw new TypeError();
    return Object.freeze({ text, image, dot });
  } catch {
    throw new TypeError("local footage self-test failed");
  }
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left, right) {
  return sameInode(left, right) && left.size === right.size;
}

function requireNotAborted(signal) {
  if (signal?.aborted) throw new TypeError("operation was cancelled");
}

async function abortable(operation, signal) {
  if (!signal) return operation;
  requireNotAborted(signal);
  return new Promise((resolveOperation, rejectOperation) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(rejectOperation, new TypeError("operation was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolveOperation, value),
      (error) => finish(rejectOperation, error),
    );
  });
}

async function stableEvidenceRead(evidence, maximumBytes, filesystem, signal) {
  if (!exactKeys(evidence, ["path", "bytes", "sha256"]) || !canonicalAbsolutePosixPath(evidence.path)
    || !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 1 || evidence.bytes > maximumBytes
    || typeof evidence.sha256 !== "string" || !shaPattern.test(evidence.sha256)) throw new TypeError("file evidence is invalid");
  requireNotAborted(signal);
  let handle;
  try {
    const pathBefore = await filesystem.lstat(evidence.path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size !== evidence.bytes) throw new TypeError("file evidence changed");
    handle = await filesystem.open(evidence.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size !== evidence.bytes || !sameFile(pathBefore, before)) throw new TypeError("file evidence changed");
    const bytes = await handle.readFile();
    requireNotAborted(signal);
    const after = await handle.stat();
    const pathAfter = await filesystem.lstat(evidence.path);
    if (!sameFile(before, after) || !sameFile(before, pathAfter) || bytes.byteLength !== evidence.bytes
      || createHash("sha256").update(bytes).digest("hex") !== evidence.sha256) throw new TypeError("file evidence changed");
    return Buffer.from(bytes);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function validatePng224Rgb(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33) throw new TypeError("PNG frame is malformed");
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!input.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    || input.readUInt32BE(8) !== 13 || input.subarray(12, 16).toString("ascii") !== "IHDR"
    || input.readUInt32BE(16) !== 224 || input.readUInt32BE(20) !== 224
    || input[24] !== 8 || input[25] !== 2 || input[26] !== 0 || input[27] !== 0 || input[28] !== 0) {
    throw new TypeError("PNG frame is malformed");
  }
}

function validateDecodedImage(image) {
  if (!image || typeof image !== "object" || image.width !== 224 || image.height !== 224 || image.channels !== 3) {
    throw new TypeError("decoded PNG frame is malformed");
  }
}

function cutFvecHeader(planSha256, recordCount, dimensions) {
  const header = Buffer.alloc(48);
  magic.copy(header, 0);
  header.writeUInt32LE(dimensions, 8);
  header.writeUInt32LE(recordCount, 12);
  Buffer.from(planSha256, "hex").copy(header, 16);
  return header;
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1) throw new TypeError("artifact write failed");
    offset += bytesWritten;
  }
}

export async function indexFootageArtifact(options) {
  const filesystem = Object.freeze({ ...defaultFilesystem, ...(options?.filesystem ?? {}) });
  let output;
  try {
    if (!options || typeof options !== "object" || !exactKeys(options.plan, ["path", "bytes", "sha256"])
      || !canonicalAbsolutePosixPath(options.artifactPath) || !options.runtime
      || typeof options.runtime.decodeImage !== "function" || typeof options.runtime.embedImages !== "function") throw new TypeError();
    const planBytes = await stableEvidenceRead(options.plan, localClipAdapterContract.maximumPlanBytes, filesystem, options.signal);
    const plan = parseIndexPlan(planBytes, localClipAdapterContract.dimensions);
    let encodedBytes = 48;
    for (const chunk of plan.chunks) encodedBytes += 2 + Buffer.byteLength(chunk.id, "utf8") + localClipAdapterContract.dimensions * 4;
    if (encodedBytes > localClipAdapterContract.maximumArtifactBytes) throw new TypeError();

    const records = [];
    let previousId;
    for (const chunk of plan.chunks) {
      const images = [];
      for (const frame of chunk.frames) {
        const frameBytes = await stableEvidenceRead(frame, localClipAdapterContract.maximumFrameBytes, filesystem, options.signal);
        validatePng224Rgb(frameBytes);
        const image = await abortable(Promise.resolve().then(() => options.runtime.decodeImage(frameBytes)), options.signal);
        requireNotAborted(options.signal);
        validateDecodedImage(image);
        images.push(image);
      }
      const rawRows = await abortable(Promise.resolve().then(() => options.runtime.embedImages(images)), options.signal);
      requireNotAborted(options.signal);
      if (!Array.isArray(rawRows) || rawRows.length !== images.length) throw new TypeError();
      const average = new Float64Array(localClipAdapterContract.dimensions);
      for (const raw of rawRows) {
        const normalized = normalizeEmbedding(raw, localClipAdapterContract.dimensions);
        for (let component = 0; component < average.length; component += 1) average[component] += Number(normalized[component]);
      }
      for (let component = 0; component < average.length; component += 1) average[component] /= rawRows.length;
      const vector = normalizeEmbedding(average, localClipAdapterContract.dimensions);
      const record = encodeRecord({ id: chunk.id, vector }, localClipAdapterContract.dimensions, previousId);
      records.push(record);
      previousId = chunk.id;
    }

    requireNotAborted(options.signal);
    const privatePath = join(
      dirname(options.artifactPath),
      `.${basename(options.artifactPath)}.cut-footage-sidecar-${process.pid}-${randomUUID()}.tmp`,
    );
    output = await filesystem.open(
      privatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const ownedIdentity = await output.stat();
    if (!ownedIdentity.isFile()) throw new TypeError();
    const digest = createHash("sha256");
    let bytesWritten = 0;
    const writeChunk = async (chunk) => {
      requireNotAborted(options.signal);
      await writeAll(output, chunk);
      digest.update(chunk);
      bytesWritten += chunk.byteLength;
    };
    await writeChunk(cutFvecHeader(options.plan.sha256, plan.chunks.length, localClipAdapterContract.dimensions));
    for (const record of records) await writeChunk(record);
    await output.sync();
    const finalIdentity = await output.stat();
    if (!sameInode(ownedIdentity, finalIdentity) || finalIdentity.size !== encodedBytes || bytesWritten !== encodedBytes) throw new TypeError();
    await output.close();
    output = undefined;
    const privateIdentity = await filesystem.lstat(privatePath);
    if (!sameInode(ownedIdentity, privateIdentity) || privateIdentity.size !== encodedBytes || privateIdentity.isSymbolicLink()) throw new TypeError();
    requireNotAborted(options.signal);
    await filesystem.link(privatePath, options.artifactPath);
    const pathIdentity = await filesystem.lstat(options.artifactPath);
    if (!sameInode(ownedIdentity, pathIdentity) || pathIdentity.size !== encodedBytes || pathIdentity.isSymbolicLink()) throw new TypeError();
    return Object.freeze({
      bytes: encodedBytes,
      sha256: digest.digest("hex"),
      recordCount: plan.chunks.length,
      dimensions: localClipAdapterContract.dimensions,
    });
  } catch {
    await output?.close().catch(() => undefined);
    throw new TypeError("footage index failed");
  }
}

export async function searchFootageArtifact(options) {
  const filesystem = Object.freeze({ ...defaultFilesystem, ...(options?.filesystem ?? {}) });
  try {
    if (!options || typeof options !== "object" || !exactKeys(options.artifact, ["path", "bytes", "sha256"])
      || typeof options.query !== "string" || !options.query.length || Buffer.byteLength(options.query, "utf8") > 4_096
      || hasControls(options.query) || !options.runtime || typeof options.runtime.embedTexts !== "function") throw new TypeError();
    const artifactBytes = await stableEvidenceRead(options.artifact, localClipAdapterContract.maximumArtifactBytes, filesystem, options.signal);
    const artifact = parseCutFvec1(artifactBytes, localClipAdapterContract.dimensions);
    const rawRows = await abortable(Promise.resolve().then(() => options.runtime.embedTexts([options.query])), options.signal);
    requireNotAborted(options.signal);
    if (!Array.isArray(rawRows) || rawRows.length !== 1) throw new TypeError();
    const query = normalizeEmbedding(rawRows[0], localClipAdapterContract.dimensions);
    const candidates = artifact.records.map((record) => {
      let score = 0;
      for (let component = 0; component < query.length; component += 1) score += Number(query[component]) * Number(record.vector[component]);
      if (!Number.isFinite(score) || score < -1.0001 || score > 1.0001) throw new TypeError();
      return Object.freeze({ chunkId: record.id, score: Math.min(1, Math.max(-1, Object.is(score, -0) ? 0 : score)) });
    });
    return Object.freeze(candidates);
  } catch {
    throw new TypeError("footage search failed");
  }
}

const expectedModelRecipe = Object.freeze({
  format: "cut-footage-local-model",
  version: 1,
  provider: localClipAdapterContract.provider,
  model: localClipAdapterContract.model,
  revision: localClipAdapterContract.revision,
  dtype: localClipAdapterContract.dtype,
  device: localClipAdapterContract.device,
  dimensions: localClipAdapterContract.dimensions,
  selfTestSha256: localClipSelfTestSha256,
  files: Object.freeze([
    Object.freeze({ locator: "config.json", role: "config", bytes: 4_524, sha256: "493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495" }),
    Object.freeze({ locator: "onnx/text_model_quantized.onnx", role: "text-model", bytes: 64_504_507, sha256: "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a" }),
    Object.freeze({ locator: "onnx/vision_model_quantized.onnx", role: "vision-model", bytes: 89_117_001, sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299" }),
    Object.freeze({ locator: "preprocessor_config.json", role: "preprocessor", bytes: 520, sha256: "6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f" }),
    Object.freeze({ locator: "tokenizer.json", role: "tokenizer", bytes: 2_224_119, sha256: "f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd" }),
    Object.freeze({ locator: "tokenizer_config.json", role: "tokenizer-config", bytes: 775, sha256: "60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967" }),
  ]),
});

async function stableRegularRead(path, maximumBytes, filesystem) {
  absolutePath(path, "file path");
  let handle;
  try {
    const pathBefore = await filesystem.lstat(path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size < 1 || pathBefore.size > maximumBytes) throw new TypeError();
    handle = await filesystem.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(pathBefore, before)) throw new TypeError();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await filesystem.lstat(path);
    if (!sameFile(before, after) || !sameFile(before, pathAfter) || bytes.byteLength !== before.size) throw new TypeError();
    return Buffer.from(bytes);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validateDirectory(path, filesystem) {
  absolutePath(path, "directory path");
  const metadata = await filesystem.lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("directory is invalid");
  const canonical = await filesystem.realpath(path);
  if (!isAbsolute(canonical)) throw new TypeError("directory is invalid");
  return path;
}

async function quietRuntimeCall(operation) {
  const methods = ["debug", "error", "info", "log", "warn"];
  const originals = new Map(methods.map((name) => [name, console[name]]));
  for (const name of methods) console[name] = () => undefined;
  try { return await operation(); }
  finally { for (const [name, original] of originals) console[name] = original; }
}

async function writeLine(stream, value, maximumBytes = 16 * 1024 * 1024) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > maximumBytes) throw new TypeError("protocol output is too large");
  await new Promise((resolveWrite, rejectWrite) => {
    stream.write(line, (error) => { if (error) rejectWrite(error); else resolveWrite(); });
  });
}

async function writeGenericDiagnostic(stream) {
  try {
    await new Promise((resolveWrite) => stream.write("cut footage sidecar failed\n", () => resolveWrite()));
  } catch {
    // Failure diagnostics are best-effort and never replace the original failure.
  }
}

async function* boundedRequestLines(stream, maximumBytes) {
  let pieces = [];
  let length = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const piece = chunk.subarray(offset, end);
      length += piece.byteLength;
      if (length > maximumBytes) throw new TypeError("protocol request is too large");
      if (piece.byteLength) pieces.push(piece);
      if (newline < 0) break;
      yield Buffer.concat(pieces, length);
      pieces = [];
      length = 0;
      offset = newline + 1;
    }
  }
  if (length !== 0 || pieces.length !== 0) throw new TypeError("protocol request is partial");
}

function parseRequest(line, ordinal, mode) {
  let text;
  try { text = utf8.decode(line); } catch { throw new TypeError("protocol request is malformed"); }
  if (!text.length || text.includes("\r")) throw new TypeError("protocol request is malformed");
  let request;
  try { request = JSON.parse(text); } catch { throw new TypeError("protocol request is malformed"); }
  if (!request || typeof request !== "object" || Array.isArray(request)
    || request.format !== "cut-footage-sidecar-request" || request.version !== 1
    || request.id !== `footage-${ordinal}`
    || (request.operation !== "index" && request.operation !== "searchText" && request.operation !== "close")) {
    throw new TypeError("protocol request is malformed");
  }
  if (request.operation === "index") {
    if (mode !== "offline" || !exactKeys(request, ["format", "version", "id", "operation", "plan", "artifactPath"])) throw new TypeError("protocol request is malformed");
  } else if (request.operation === "searchText") {
    if (mode !== "offline" || !exactKeys(request, ["format", "version", "id", "operation", "artifact", "query"])) throw new TypeError("protocol request is malformed");
  } else if (!exactKeys(request, ["format", "version", "id", "operation"])) {
    throw new TypeError("protocol request is malformed");
  }
  return request;
}

async function disposeRuntime(runtime) {
  if (!runtime || typeof runtime.dispose !== "function") return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => runtime.dispose()).catch(() => undefined),
      new Promise((resolveTimeout) => { timer = setTimeout(resolveTimeout, 2_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function handshake(adapterSha256) {
  return Object.freeze({
    format: "cut-footage-sidecar-handshake",
    version: 1,
    protocolVersion: localClipAdapterContract.protocolVersion,
    provider: localClipAdapterContract.provider,
    model: localClipAdapterContract.model,
    revision: localClipAdapterContract.revision,
    dimensions: localClipAdapterContract.dimensions,
    normalization: localClipAdapterContract.normalization,
    modalities: Object.freeze(["image", "text"]),
    hardware: "cpu",
    adapterSha256,
    selfTestSha256: localClipSelfTestSha256,
  });
}

export async function runLocalClipSidecar(options = {}) {
  const filesystem = Object.freeze({ ...defaultFilesystem, mkdir, realpath, ...(options.filesystem ?? {}) });
  const argv = options.argv ?? process.argv.slice(2);
  const environment = options.environment ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const signal = options.signal;
  let runtime;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await quietRuntimeCall(() => disposeRuntime(runtime));
  };
  try {
    if (!Array.isArray(argv) || argv.length !== 1 || (argv[0] !== "setup" && argv[0] !== "offline")) throw new TypeError();
    const mode = argv[0];
    const installationRoot = absolutePath(options.installationRoot ?? dirname(fileURLToPath(import.meta.url)), "installation directory");
    const adapterPath = absolutePath(options.adapterPath ?? fileURLToPath(import.meta.url), "adapter path");
    if (adapterPath !== join(installationRoot, "local-clip-sidecar.mjs")) throw new TypeError();
    await validateDirectory(installationRoot, filesystem);
    const adapterBytes = await stableRegularRead(adapterPath, 16 * 1024 * 1024, filesystem);
    const modelBytes = await stableRegularRead(join(installationRoot, "model.json"), 1024 * 1024, filesystem);
    let model;
    try { model = JSON.parse(utf8.decode(modelBytes)); } catch { throw new TypeError(); }
    if (`${JSON.stringify(expectedModelRecipe, null, 2)}\n` !== modelBytes.toString("utf8")
      || canonicalJson(model) !== canonicalJson(expectedModelRecipe)
      || model.selfTestSha256 !== localClipSelfTestSha256) throw new TypeError();

    const modelRevisionRoot = absolutePath(environment.CUT_FOOTAGE_MODEL_DIR, "model directory");
    let cacheRoot;
    if (mode === "setup") {
      cacheRoot = absolutePath(environment.CUT_FOOTAGE_CACHE_DIR, "cache directory");
      const expectedRoot = join(cacheRoot, ...localClipAdapterContract.model.split("/"), localClipAdapterContract.revision);
      if (modelRevisionRoot !== expectedRoot) throw new TypeError();
      await filesystem.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      await validateDirectory(cacheRoot, filesystem);
    } else {
      await validateDirectory(modelRevisionRoot, filesystem);
    }
    requireNotAborted(signal);
    const runtimeFactory = options.runtimeFactory ?? createTransformersRuntime;
    if (typeof runtimeFactory !== "function") throw new TypeError();
    runtime = await quietRuntimeCall(() => runtimeFactory({ mode, installationRoot, cacheRoot, modelRevisionRoot }));
    if (mode === "setup") await validateDirectory(modelRevisionRoot, filesystem);
    await quietRuntimeCall(() => runLocalClipSelfTest(runtime));
    requireNotAborted(signal);
    await writeLine(stdout, handshake(createHash("sha256").update(adapterBytes).digest("hex")));

    let ordinal = 0;
    for await (const line of boundedRequestLines(stdin, localClipAdapterContract.maximumRequestLineBytes)) {
      requireNotAborted(signal);
      const request = parseRequest(line, ++ordinal, mode);
      if (request.operation === "index") {
        const artifact = await quietRuntimeCall(() => indexFootageArtifact({
          plan: request.plan,
          artifactPath: request.artifactPath,
          runtime,
          filesystem,
          signal,
        }));
        await writeLine(stdout, Object.freeze({
          format: "cut-footage-sidecar-response", version: 1, id: request.id, operation: "index", artifact,
        }));
      } else if (request.operation === "searchText") {
        const candidates = await quietRuntimeCall(() => searchFootageArtifact({
          artifact: request.artifact,
          query: request.query,
          runtime,
          filesystem,
          signal,
        }));
        await writeLine(stdout, Object.freeze({
          format: "cut-footage-sidecar-response", version: 1, id: request.id, operation: "searchText", candidates,
        }));
      } else {
        await dispose();
        await writeLine(stdout, Object.freeze({
          format: "cut-footage-sidecar-response", version: 1, id: request.id, operation: "close",
        }));
        return;
      }
    }
    throw new TypeError("protocol ended before close");
  } catch {
    await dispose();
    await writeGenericDiagnostic(stderr);
    throw new TypeError("local footage sidecar failed");
  }
}

export function isDirectInvocation(moduleUrl, argumentPath) {
  if (typeof moduleUrl !== "string" || typeof argumentPath !== "string" || !argumentPath.length) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argumentPath)); }
  catch { return false; }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const controller = new AbortController();
  const cancel = () => { controller.abort(); process.stdin.destroy(); };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try { await runLocalClipSidecar({ signal: controller.signal }); }
  catch { process.exitCode = 1; }
  finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
