import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import { stableJsonStringify } from "../core/stable";
import {
  cutWhisperLocalWorkflowContract,
  CutWhisperLocalWorkflowError,
  doctorCutWhisperLocalSetup,
  parseCutWhisperLocalSetup,
  type CutWhisperLocalDoctorReport,
  type CutWhisperLocalSetup,
} from "./whisper-workflow";

export type CutWhisperLocalSetupCollectorInput = Readonly<{
  ffmpeg: Readonly<{ path: string; version: string; revision: string }>;
  whisperCli: Readonly<{
    path: string;
    revision: string;
    sourceArchiveSha256: string;
    buildPolicy: string;
  }>;
  model: Readonly<{
    path: string;
    locator: string;
    name: string;
    revision: string;
    license: string;
  }>;
}>;

export type CutWhisperLocalSetupCollection = Readonly<{
  setup: CutWhisperLocalSetup;
  doctor: CutWhisperLocalDoctorReport;
  canonicalSetupBytes: Buffer;
}>;

type Snapshot = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type Retained = Readonly<{ handle: FileHandle; snapshot: Snapshot }>;
type Doctor = (setup: CutWhisperLocalSetup) => Promise<CutWhisperLocalDoctorReport>;

const shaPattern = /^[a-f0-9]{64}$/u;
const safeTextPattern = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;

function fail(code: "CUT_WHISPER_WORKFLOW_CONTRACT" | "CUT_WHISPER_WORKFLOW_AUTHORITY", detail: string): never {
  throw new CutWhisperLocalWorkflowError(code, detail);
}

function closed(value: unknown, path: string, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one non-proxy plain data object.`);
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one inspectable plain data object.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one plain data object.`);
  }
  const expected = new Set(fields);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must not contain symbol fields.`);
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path}.${key} must be one enumerable data field.`);
    }
    if (!expected.has(key)) fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path}.${key} is not part of the closed collector contract.`);
    result[key] = descriptor.value;
  }
  for (const field of fields) {
    if (!Object.hasOwn(result, field)) fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path}.${field} is required.`);
  }
  return Object.freeze(result);
}

function text(value: unknown, path: string, maximumBytes = 4_096) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value
    || !safeTextPattern.test(value) || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be bounded, trimmed, NFC, control-free text.`);
  }
  return value;
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function absolutePath(value: unknown, path: string) {
  const candidate = text(value, path, 16_384);
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate || candidate.includes("\\")
    || candidate.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one canonical absolute POSIX path.`);
  }
  return candidate;
}

function parseCollectorInput(value: unknown) {
  const input = closed(value, "$collector", ["ffmpeg", "whisperCli", "model"]);
  const ffmpeg = closed(input.ffmpeg, "$collector.ffmpeg", ["path", "version", "revision"]);
  const whisperCli = closed(input.whisperCli, "$collector.whisperCli", ["path", "revision", "sourceArchiveSha256", "buildPolicy"]);
  const model = closed(input.model, "$collector.model", ["path", "locator", "name", "revision", "license"]);
  return Object.freeze({
    ffmpeg: Object.freeze({
      path: absolutePath(ffmpeg.path, "$collector.ffmpeg.path"),
      version: text(ffmpeg.version, "$collector.ffmpeg.version"),
      revision: text(ffmpeg.revision, "$collector.ffmpeg.revision"),
    }),
    whisperCli: Object.freeze({
      path: absolutePath(whisperCli.path, "$collector.whisperCli.path"),
      revision: text(whisperCli.revision, "$collector.whisperCli.revision"),
      sourceArchiveSha256: digest(whisperCli.sourceArchiveSha256, "$collector.whisperCli.sourceArchiveSha256"),
      buildPolicy: text(whisperCli.buildPolicy, "$collector.whisperCli.buildPolicy"),
    }),
    model: Object.freeze({
      path: absolutePath(model.path, "$collector.model.path"),
      locator: text(model.locator, "$collector.model.locator", 16_384),
      name: text(model.name, "$collector.model.name"),
      revision: text(model.revision, "$collector.model.revision"),
      license: text(model.license, "$collector.model.license", 1_024),
    }),
  });
}

async function authenticate(path: string, maximumBytes: number, label: string): Promise<Retained> {
  let handle: FileHandle | undefined;
  try {
    if (await realpath(path) !== path) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} path is not canonical and symlink-free.`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} is not one bounded regular file.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0n;
    while (position < before.size) {
      const length = Number(before.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - position);
      const read = await handle.read(buffer, 0, length, Number(position));
      if (read.bytesRead !== length) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} changed while hashing.`);
      hash.update(buffer.subarray(0, length));
      position += BigInt(length);
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} changed while hashing.`);
    }
    const snapshot = Object.freeze({
      path,
      bytes: Number(before.size),
      sha256: hash.digest("hex"),
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
    const retained = Object.freeze({ handle, snapshot });
    handle = undefined;
    return retained;
  } catch (error) {
    if (error instanceof CutWhisperLocalWorkflowError) throw error;
    return fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} could not be authenticated.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function authenticateAll(input: ReturnType<typeof parseCollectorInput>) {
  const settled = await Promise.allSettled([
    authenticate(input.ffmpeg.path, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "FFmpeg"),
    authenticate(input.whisperCli.path, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "whisper.cpp CLI"),
    authenticate(input.model.path, cutWhisperLocalWorkflowContract.maximumModelBytes, "whisper model"),
  ]);
  const retained = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") {
    await Promise.all(retained.map(({ handle }) => handle.close().catch(() => undefined)));
    throw rejected.reason;
  }
  return retained as [Retained, Retained, Retained];
}

async function assertUnchanged(retained: Retained, maximumBytes: number, label: string) {
  const held = await retained.handle.stat({ bigint: true }).catch(() => undefined);
  if (!held?.isFile() || held.dev !== retained.snapshot.dev || held.ino !== retained.snapshot.ino
    || held.size !== retained.snapshot.size || held.mtimeNs !== retained.snapshot.mtimeNs || held.ctimeNs !== retained.snapshot.ctimeNs) {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} changed during setup collection.`);
  }
  const current = await authenticate(retained.snapshot.path, maximumBytes, label);
  try {
    if (current.snapshot.dev !== retained.snapshot.dev || current.snapshot.ino !== retained.snapshot.ino
      || current.snapshot.bytes !== retained.snapshot.bytes || current.snapshot.sha256 !== retained.snapshot.sha256) {
      fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} changed during setup collection.`);
    }
  } finally {
    await current.handle.close().catch(() => undefined);
  }
}

async function collectWithDoctor(value: unknown, doctor: Doctor): Promise<CutWhisperLocalSetupCollection> {
  const input = parseCollectorInput(value);
  const authorities = await authenticateAll(input);
  try {
    const setup = parseCutWhisperLocalSetup({
      format: cutWhisperLocalWorkflowContract.format,
      version: cutWhisperLocalWorkflowContract.version,
      acquisition: cutWhisperLocalWorkflowContract.acquisition,
      runtime: cutWhisperLocalWorkflowContract.runtime,
      ffmpeg: {
        path: authorities[0].snapshot.path,
        bytes: authorities[0].snapshot.bytes,
        sha256: authorities[0].snapshot.sha256,
        version: input.ffmpeg.version,
        revision: input.ffmpeg.revision,
      },
      whisperCli: {
        path: authorities[1].snapshot.path,
        bytes: authorities[1].snapshot.bytes,
        sha256: authorities[1].snapshot.sha256,
        version: cutWhisperLocalWorkflowContract.whisperVersion,
        revision: input.whisperCli.revision,
        sourceArchiveSha256: input.whisperCli.sourceArchiveSha256,
        buildPolicy: input.whisperCli.buildPolicy,
        linkagePolicy: cutWhisperLocalWorkflowContract.whisperLinkagePolicy,
      },
      model: {
        path: authorities[2].snapshot.path,
        locator: input.model.locator,
        bytes: authorities[2].snapshot.bytes,
        sha256: authorities[2].snapshot.sha256,
        name: input.model.name,
        revision: input.model.revision,
        license: input.model.license,
      },
    });
    const report = await doctor(setup);
    await Promise.all([
      assertUnchanged(authorities[0], cutWhisperLocalWorkflowContract.maximumExecutableBytes, "FFmpeg"),
      assertUnchanged(authorities[1], cutWhisperLocalWorkflowContract.maximumExecutableBytes, "whisper.cpp CLI"),
      assertUnchanged(authorities[2], cutWhisperLocalWorkflowContract.maximumModelBytes, "whisper model"),
    ]);
    return Object.freeze({
      setup,
      doctor: report,
      canonicalSetupBytes: Buffer.from(`${stableJsonStringify(setup)}\n`, "utf8"),
    });
  } finally {
    await Promise.all(authorities.map(({ handle }) => handle.close().catch(() => undefined)));
  }
}

/**
 * Authenticates caller-selected local files and proves their exact executable
 * version/linkage through the existing doctor. It performs no download,
 * installation, inference, or filesystem publication.
 */
export async function collectCutWhisperLocalSetup(value: unknown): Promise<CutWhisperLocalSetupCollection> {
  return collectWithDoctor(value, doctorCutWhisperLocalSetup);
}

/** @internal Focused tests only; production collection always uses the public doctor above. */
export const cutWhisperLocalSetupTestOnly = Object.freeze({
  collectWithDoctor: (value: unknown, doctor: Doctor) => collectWithDoctor(value, doctor),
});
