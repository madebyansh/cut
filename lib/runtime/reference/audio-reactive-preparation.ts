import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { endianness } from "node:os";
import { resolve } from "node:path";
import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import type { LockedResourceProbe } from "../../language/lock";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import { atomicWriteFile, publishStagedFile } from "../../project/write-boundary";
import {
  analyzeReferenceAudioReactiveStereo,
  compileReferenceAudioReactiveAnalysisPlan,
  referenceAudioReactiveAnalysisCacheKey,
  referenceAudioReactiveAnalysisLimits,
  ReferenceAudioReactiveAnalysisError,
  type ReferenceAudioReactiveAnalysisPlan,
  type ReferenceAudioReactiveAnalysisResult,
  type ReferenceAudioReactiveDetector,
} from "./audio-reactive-analysis";
import { bindReferenceFfmpegExecutableToolchain } from "./audio-limiter-compatibility";
import { runBoundReferenceFfmpeg } from "./ffmpeg";
import { ReferencePreparedSignalResolver } from "./signals";

const producerFormat = "cut-audio-amplitude-producer" as const;
const producerVersion = 1 as const;
const decodeContract = "selected-stream-swr-exact-rational-stereo-f32le-v1" as const;
const cacheFormat = "cut-reference-audio-reactive-decode-cache" as const;
const cacheVersion = 1 as const;

export const referenceAudioReactivePreparationLimits = Object.freeze({
  maximumProducersPerComposition: 32,
  maximumUniqueAnalysesPerComposition: 16,
  maximumConsumerAttachmentsPerComposition: 256,
  maximumAggregateDecodedFrames: 57_600_000,
  maximumAggregateOutputWindows: 262_144,
  maximumAggregateDecodedBytes: 512 * 1024 * 1024,
  maximumAggregateDetectorChannelSamples: 536_870_912,
});

export type ReferenceAudioAmplitudeProducer = Readonly<{
  format: typeof producerFormat;
  version: typeof producerVersion;
  source: Readonly<{ kind: "resource-ref"; id: string }>;
  scope: Readonly<{ compositionId: string; sceneId: string }>;
  range: Readonly<{ start: Rational; end: Rational }>;
  /** Scene-local placement time. */
  at: Rational;
  detector: ReferenceAudioReactiveDetector;
  window: Rational;
  hop: Rational;
  attack: Rational;
  release: Rational;
  floor: Rational;
  ceiling: Rational;
  mapping: Readonly<{ kind: "linear"; from: IRValue; to: IRValue }>;
}>;

type ProducerTrack = Extract<IRSignal, { kind: "track" }> & { producer?: ReferenceAudioAmplitudeProducer };

export type ReferenceAudioReactivePreparationErrorCode =
  | "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG"
  | "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE"
  | "CUT_AUDIO_REACTIVE_PRODUCER_RESOURCE"
  | "CUT_AUDIO_REACTIVE_PRODUCER_GRID"
  | "CUT_AUDIO_REACTIVE_PRODUCER_LIMIT"
  | "CUT_AUDIO_REACTIVE_PRODUCER_DECODE"
  | "CUT_AUDIO_REACTIVE_PRODUCER_IDENTITY"
  | "CUT_AUDIO_REACTIVE_PRODUCER_NOOP";

export class ReferenceAudioReactivePreparationError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; signalId: string }>;

  constructor(
    readonly code: ReferenceAudioReactivePreparationErrorCode,
    readonly signal: IRSignal,
    message: string,
    options: ErrorOptions = {},
  ) {
    const { module, span } = signal.provenance;
    super(`${code}: produced signal ${signal.id} at ${module}:${span.start.line}:${span.start.column} ${message}`, options);
    this.name = "ReferenceAudioReactivePreparationError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, signalId: signal.id });
  }
}

export type ReferenceAudioReactivePreparationEvidence = Readonly<{
  format: "cut-reference-audio-reactive-preparation-evidence";
  version: 1;
  compositionId: string;
  sceneId: string;
  signalId: string;
  consumerNodeIds: readonly string[];
  producerIdentity: string;
  planIntegrity: string;
  cacheKey: string;
  cacheStatus: "hit" | "miss" | "memory";
  activeVariant: "master" | "proxy";
  lockedResourceSha256: string;
  selectedStreamIndex: number;
  selectedStreamIdentitySha256: string;
  decoderIntegritySha256: string;
  inputPcmSha256: string;
  analysisContentIntegrity: string;
  analysisSignalSha256: string;
  preparedSignalSha256: string;
  decodedFrames: number;
  decodedBytes: number;
  windowCount: number;
  sceneLocalEventCount: number;
}>;

type ValidatedProducer = Readonly<{
  signal: ProducerTrack;
  producer: ReferenceAudioAmplitudeProducer;
  scene: CutAVIR["scenes"][string];
  consumers: readonly Readonly<{ node: IRNode; property: string }>[];
  plan: ReferenceAudioReactiveAnalysisPlan;
  producerIdentity: string;
}>;

type DecodeCacheManifest = Readonly<{
  format: typeof cacheFormat;
  version: typeof cacheVersion;
  key: string;
  planIntegrity: string;
  decoderIntegritySha256: string;
  bytes: number;
  sha256: string;
}>;

function fail(signal: IRSignal, code: ReferenceAudioReactivePreparationErrorCode, message: string, cause?: unknown): never {
  throw new ReferenceAudioReactivePreparationError(code, signal, message, cause === undefined ? {} : { cause });
}

function failFromAnalysis(signal: IRSignal, error: unknown): never {
  if (!(error instanceof ReferenceAudioReactiveAnalysisError)) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_IDENTITY", error instanceof Error ? error.message : String(error), error);
  }
  const code: ReferenceAudioReactivePreparationErrorCode = error.code === "CUT_AUDIO_REACTIVE_RESOURCE"
    ? "CUT_AUDIO_REACTIVE_PRODUCER_LIMIT"
    : error.code === "CUT_AUDIO_REACTIVE_NOOP"
      ? "CUT_AUDIO_REACTIVE_PRODUCER_NOOP"
      : error.code === "CUT_AUDIO_REACTIVE_RANGE"
        ? "CUT_AUDIO_REACTIVE_PRODUCER_GRID"
        : error.code === "CUT_AUDIO_REACTIVE_PCM"
          ? "CUT_AUDIO_REACTIVE_PRODUCER_DECODE"
          : error.code === "CUT_AUDIO_REACTIVE_IDENTITY"
            ? "CUT_AUDIO_REACTIVE_PRODUCER_IDENTITY"
            : "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG";
  fail(signal, code, error.message, error);
}

function plainRecord(signal: IRSignal, value: unknown, keys: readonly string[], label: string) {
  let prototype: object | null;
  let ownKeys: PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label} must be one plain data object.`);
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof ReferenceAudioReactivePreparationError) throw error;
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label} could not be inspected as plain data.`, error);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label} must have a plain or null prototype.`);
  if (ownKeys.some((key) => typeof key !== "string")) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label} cannot contain symbol properties.`);
  const actual = (ownKeys as string[]).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label} must contain exactly ${expected.join(", ")}; unknown or missing properties are refused.`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label}.${key} must be an enumerable data property.`);
    result[key] = descriptor.value;
  }
  return result;
}

function exactRational(signal: IRSignal, value: unknown, label: string) {
  const record = plainRecord(signal, value, ["numerator", "denominator"], label);
  if (typeof record.numerator !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(record.numerator)
    || typeof record.denominator !== "string" || !/^[1-9][0-9]*$/u.test(record.denominator)
    || record.numerator.length > 256 || record.denominator.length > 256) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label} must be one bounded canonical exact rational.`);
  }
  let result: Rational;
  try { result = rational(record.numerator, record.denominator); }
  catch (error) { fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label} is not one valid exact rational.`, error); }
  if (result.numerator !== record.numerator || result.denominator !== record.denominator) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${label} must be reduced to canonical form.`);
  }
  return Object.freeze({ ...result });
}

function exactSamples(signal: IRSignal, value: Rational, sampleRate: number, label: string, allowZero: boolean) {
  const samples = multiplyRational(value, rational(sampleRate));
  if (samples.denominator !== "1") fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_GRID", `${label} must land exactly on the ${sampleRate} Hz composition sample grid.`);
  const result = Number(samples.numerator);
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_GRID", `${label} has an invalid exact sample position.`);
  return result;
}

function valueType(value: IRValue) {
  if (value.kind !== "quantity") return undefined;
  return ({ scalar: "Number", length: "Length", ratio: "Ratio", angle: "Angle" } as Readonly<Record<string, string>>)[value.dimension];
}

function validateMapping(signal: ProducerTrack, value: unknown) {
  const mapping = plainRecord(signal, value, ["kind", "from", "to"], "producer.mapping");
  if (mapping.kind !== "linear") fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "producer.mapping.kind must be linear.");
  const from = mapping.from as IRValue, to = mapping.to as IRValue;
  if (!from || typeof from !== "object" || !to || typeof to !== "object"
    || from.kind !== "quantity" || to.kind !== "quantity"
    || from.dimension !== to.dimension || from.unit !== to.unit) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "producer.mapping endpoints must be matching canonical visual quantities.");
  }
  const expectedType = valueType(from);
  if (!expectedType || signal.valueType !== expectedType) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `producer.mapping endpoint type must match track valueType ${signal.valueType}.`);
  }
  if (hash(from) === hash(to)) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_NOOP", "producer.mapping endpoints must differ; a static mapping is not automation.");
  if (hash(signal.initial) !== hash(from)) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_IDENTITY", "producer-backed track initial must exactly equal mapping.from.");
  return Object.freeze({ kind: "linear" as const, from, to });
}

function validateProducerShape(signal: ProducerTrack) {
  if (signal.events.length !== 0) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "producer-backed track must have no authored events.");
  const authored = plainRecord(signal, signal.producer, [
    "format", "version", "source", "scope", "range", "at", "detector", "window", "hop", "attack", "release", "floor", "ceiling", "mapping",
  ], "signal.producer");
  if (authored.format !== producerFormat || authored.version !== producerVersion) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `signal.producer must use ${producerFormat} version ${producerVersion}.`);
  }
  const source = plainRecord(signal, authored.source, ["kind", "id"], "producer.source");
  if (source.kind !== "resource-ref" || typeof source.id !== "string" || !source.id || source.id.length > 1_024) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "producer.source must be one bounded resource-ref.");
  }
  const scope = plainRecord(signal, authored.scope, ["compositionId", "sceneId"], "producer.scope");
  if (typeof scope.compositionId !== "string" || !scope.compositionId || typeof scope.sceneId !== "string" || !scope.sceneId) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "producer.scope must identify one composition and scene.");
  }
  const range = plainRecord(signal, authored.range, ["start", "end"], "producer.range");
  const detector = authored.detector;
  if (detector !== "peak" && detector !== "rms") fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "producer.detector must be peak or rms.");
  return Object.freeze({
    format: producerFormat,
    version: producerVersion,
    source: Object.freeze({ kind: "resource-ref" as const, id: source.id }),
    scope: Object.freeze({ compositionId: scope.compositionId, sceneId: scope.sceneId }),
    range: Object.freeze({ start: exactRational(signal, range.start, "producer.range.start"), end: exactRational(signal, range.end, "producer.range.end") }),
    at: exactRational(signal, authored.at, "producer.at"),
    detector,
    window: exactRational(signal, authored.window, "producer.window"),
    hop: exactRational(signal, authored.hop, "producer.hop"),
    attack: exactRational(signal, authored.attack, "producer.attack"),
    release: exactRational(signal, authored.release, "producer.release"),
    floor: exactRational(signal, authored.floor, "producer.floor"),
    ceiling: exactRational(signal, authored.ceiling, "producer.ceiling"),
    mapping: validateMapping(signal, authored.mapping),
  }) satisfies ReferenceAudioAmplitudeProducer;
}

function selectedAudioIdentity(ir: CutAVIR, signal: IRSignal, sourceId: string) {
  const resource = ir.resources[sourceId];
  if (!resource || resource.kind !== "audio" || resource.state !== "locked" || typeof resource.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(resource.sha256)) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_RESOURCE", `producer.source ${JSON.stringify(sourceId)} must be one byte-locked AudioAsset.`);
  }
  const metadata = resource.metadata;
  const activeVariant = metadata?.activeMediaVariant;
  const probe = metadata?.probe as LockedResourceProbe | undefined;
  if ((activeVariant !== "master" && activeVariant !== "proxy") || probe?.kind !== "media") {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_RESOURCE", "producer source must come from a selected verified master/proxy execution profile with cut.lock v2 media metadata.");
  }
  const selection = probe.selected.audio;
  const streamIndex = selection?.streamIndex;
  const stream = typeof streamIndex === "number"
    ? probe.identity.streams.find((candidate) => candidate.type === "audio" && candidate.index === streamIndex)
    : undefined;
  if (!selection || !stream || typeof streamIndex !== "number" || !Number.isSafeInteger(streamIndex) || streamIndex < 0
    || !stream.sampleRate || !Number.isSafeInteger(stream.sampleRate)
    || stream.sampleRate < referenceAudioReactiveAnalysisLimits.minimumSampleRate
    || stream.sampleRate > referenceAudioReactiveAnalysisLimits.maximumSampleRate) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_RESOURCE", "producer source has no valid explicitly selected audio stream and sample-rate identity.");
  }
  return Object.freeze({
    activeVariant,
    lockedResourceSha256: resource.sha256,
    selectedStreamIndex: streamIndex,
    selectedStreamSampleRate: stream.sampleRate,
    selectedStreamIdentitySha256: hash({ selection, stream }),
    selectedDuration: selection.duration,
  });
}

function consumersByProducedSignal(ir: CutAVIR, reachableNodeIds: ReadonlySet<string>) {
  const result = new Map<string, Array<{ node: IRNode; property: string }>>();
  for (const nodeId of [...reachableNodeIds].sort()) {
    const node = ir.nodes[nodeId];
    if (!node) continue;
    for (const [property, value] of Object.entries(node.properties)) {
      if (!("signal" in value)) continue;
      const signal = ir.signals[value.signal] as ProducerTrack | undefined;
      if (!signal?.producer) continue;
      const consumers = result.get(signal.id) ?? [];
      consumers.push({ node, property });
      result.set(signal.id, consumers);
    }
  }
  return result;
}

function mapRatio(signal: ProducerTrack, mapping: ReferenceAudioAmplitudeProducer["mapping"], ratioValue: IRValue) {
  if (ratioValue.kind !== "quantity" || ratioValue.dimension !== "ratio" || ratioValue.unit !== "ratio") {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_IDENTITY", "analysis emitted a non-Ratio value.");
  }
  const from = mapping.from, to = mapping.to;
  if (from.kind !== "quantity" || to.kind !== "quantity") {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "linear mapping endpoints are not executable quantities.");
  }
  const delta = subtractRational(to.magnitude, from.magnitude);
  return Object.freeze({
    kind: "quantity" as const,
    dimension: from.dimension,
    magnitude: Object.freeze({ ...addRational(from.magnitude, multiplyRational(delta, ratioValue.magnitude)) }),
    unit: from.unit,
  });
}

function heldAnalysisValue(result: ReferenceAudioReactiveAnalysisResult, at: Rational) {
  let value: IRValue = result.signal.initial;
  for (const event of result.signal.events) {
    if (compareRational(event.time, at) > 0) break;
    value = event.value;
  }
  return value;
}

function preparedSceneTrack(config: ValidatedProducer, analysis: ReferenceAudioReactiveAnalysisResult) {
  const { signal, producer, scene } = config;
  const sceneStart = scene.start, sceneEnd = addRational(scene.start, scene.duration);
  let held = mapRatio(signal, producer.mapping, heldAnalysisValue(analysis, sceneStart));
  const initial = held;
  const events: Array<{ kind: "set"; time: Rational; value: IRValue }> = [];
  for (const event of analysis.signal.events) {
    if (compareRational(event.time, sceneStart) <= 0) continue;
    if (compareRational(event.time, sceneEnd) >= 0) break;
    const mapped = mapRatio(signal, producer.mapping, event.value);
    if (hash(mapped) === hash(held)) continue;
    events.push(Object.freeze({ kind: "set", time: Object.freeze({ ...subtractRational(event.time, sceneStart) }), value: mapped }));
    held = mapped;
  }
  if (!events.length && hash(initial) === hash(signal.initial)) {
    fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_NOOP", "decoded analysis cannot change the mapped visual property anywhere inside its scoped scene.");
  }
  const contentHash = hash({ authoredSignal: signal.contentHash, analysis: analysis.contentIntegrity, initial, events });
  return Object.freeze({
    id: signal.id,
    kind: "track" as const,
    valueType: signal.valueType,
    initial,
    events,
    contentHash,
    provenance: signal.provenance,
  });
}

function frameObservable(signal: ProducerTrack, config: ValidatedProducer, track: Extract<IRSignal, { kind: "track" }>, composition: IRComposition) {
  const exactFrames = multiplyRational(config.scene.duration, composition.fps);
  if (exactFrames.denominator !== "1") fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_GRID", "scoped scene duration must land on the exact output-frame grid.");
  const frameCount = Number(exactFrames.numerator);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_GRID", "scoped scene has no bounded output-frame interval.");
  const values = new Set<string>();
  let eventIndex = 0, value = track.initial;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = rational(BigInt(frame) * BigInt(composition.fps.denominator), composition.fps.numerator);
    while (eventIndex < track.events.length) {
      const event = track.events[eventIndex]!;
      if (event.kind !== "set") fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_IDENTITY", "prepared audio-reactive track contains a non-set event.");
      if (compareRational(event.time, time) > 0) break;
      value = event.value;
      eventIndex += 1;
    }
    const active = config.consumers.some(({ node }) => compareRational(time, node.interval.start) >= 0
      && compareRational(time, addRational(node.interval.start, node.interval.duration)) < 0);
    if (active) values.add(hash(value));
    if (values.size >= 2) return 2;
  }
  fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_NOOP", "mapped analysis has fewer than two distinct values on actual output-frame times while a consumer Group is active.");
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cacheManifest(value: unknown): DecodeCacheManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["bytes", "decoderIntegritySha256", "format", "key", "planIntegrity", "sha256", "version"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || record.format !== cacheFormat || record.version !== cacheVersion
    || typeof record.key !== "string" || typeof record.planIntegrity !== "string"
    || typeof record.decoderIntegritySha256 !== "string"
    || typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 1
    || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) return undefined;
  return record as DecodeCacheManifest;
}

async function cachedDecodedBytes(directory: string, plan: ReferenceAudioReactiveAnalysisPlan) {
  const rawPath = resolve(directory, "source.f32le"), manifestPath = resolve(directory, "manifest.json");
  const expectedBytes = (plan.range.endFrame - plan.range.startFrame) * 8;
  try {
    const [rawMetadata, manifestMetadata] = await Promise.all([lstat(rawPath), lstat(manifestPath)]);
    if (rawMetadata.isSymbolicLink() || !rawMetadata.isFile() || rawMetadata.size !== expectedBytes
      || manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile() || manifestMetadata.size > 16_384) return undefined;
    const manifest = cacheManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    if (!manifest || manifest.key !== referenceAudioReactiveAnalysisCacheKey(plan)
      || manifest.planIntegrity !== plan.integrity || manifest.decoderIntegritySha256 !== plan.source.decoderIntegritySha256
      || manifest.bytes !== expectedBytes) return undefined;
    const bytes = await readFile(rawPath);
    if (bytes.length !== expectedBytes || sha256(bytes) !== manifest.sha256) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

async function decodeSelectedRange(
  signal: IRSignal,
  plan: ReferenceAudioReactiveAnalysisPlan,
  sourcePath: string,
  directory: string,
  toolchain: Awaited<ReturnType<typeof bindReferenceFfmpegExecutableToolchain>>,
) {
  const cached = await cachedDecodedBytes(directory, plan);
  if (cached) return { bytes: cached, status: "hit" as const };
  const expectedFrames = plan.range.endFrame - plan.range.startFrame, expectedBytes = expectedFrames * 8;
  const staging = await mkdtemp(resolve(directory, ".cut-audio-reactive-"));
  const staged = resolve(staging, "source.f32le");
  try {
    const filter = `[0:${plan.source.selectedStreamIndex}]aresample=${plan.pcm.sampleRate}:resampler=swr:filter_size=32:phase_shift=10:linear_interp=0:exact_rational=1,atrim=start_sample=${plan.range.startFrame}:end_sample=${plan.range.endFrame},asetpts=N/SR/TB,aformat=sample_fmts=flt:channel_layouts=stereo[cut_audio_reactive]`;
    try {
      await runBoundReferenceFfmpeg(toolchain.executablePath, [
        "-nostdin", "-v", "error", "-i", sourcePath,
        "-filter_complex", filter,
        "-map", "[cut_audio_reactive]", "-map_metadata", "-1",
        "-fflags", "+bitexact", "-flags:a", "+bitexact",
        "-c:a", "pcm_f32le", "-f", "f32le", staged,
      ], 600_000, { stderrBytes: 128_000, totalBytes: 128_000 });
      await toolchain.verify();
    } catch (error) {
      fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_DECODE", "selected-stream FFmpeg decode failed before produced-signal installation.", error);
    }
    const metadata = await lstat(staged).catch((error) => fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_DECODE", "decoder did not create one regular raw PCM artifact.", error));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== expectedBytes) {
      fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_DECODE", `decoder produced ${metadata.size} bytes; exact selected range requires ${expectedBytes} bytes (${expectedFrames} stereo frames).`);
    }
    const bytes = await readFile(staged), digest = sha256(bytes), rawPath = resolve(directory, "source.f32le");
    await publishStagedFile(staged, rawPath);
    const manifest: DecodeCacheManifest = Object.freeze({
      format: cacheFormat,
      version: cacheVersion,
      key: referenceAudioReactiveAnalysisCacheKey(plan),
      planIntegrity: plan.integrity,
      decoderIntegritySha256: plan.source.decoderIntegritySha256,
      bytes: expectedBytes,
      sha256: digest,
    });
    await atomicWriteFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { bytes, status: "miss" as const };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function float32(bytes: Buffer, signal: IRSignal) {
  if (endianness() !== "LE") fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_DECODE", "reference raw f32le analysis currently requires a little-endian host.");
  if (bytes.length % 8 !== 0) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_DECODE", "decoded PCM is not complete interleaved stereo f32le.");
  const copy = new Float32Array(bytes.length / 4);
  Buffer.from(copy.buffer).set(bytes);
  return copy;
}

/**
 * Validate and prepare every reachable producer-backed visual property signal
 * for one composition. No audio graph or post-mix node is consulted: the
 * producer reads only the exact locked AudioAsset stream named in public IR.
 */
export async function prepareReferenceAudioReactiveSignals(options: Readonly<{
  ir: CutAVIR;
  composition: IRComposition;
  reachableNodeIds: ReadonlySet<string>;
  verifiedResourcePath?: (resourceId: string) => string;
  cacheDirectoryForKey: (key: string) => Promise<string>;
  resolver: ReferencePreparedSignalResolver;
}>): Promise<readonly ReferenceAudioReactivePreparationEvidence[]> {
  const { ir, composition, reachableNodeIds } = options;
  const consumerMap = consumersByProducedSignal(ir, reachableNodeIds);
  if (!consumerMap.size) return Object.freeze([]);
  if (consumerMap.size > referenceAudioReactivePreparationLimits.maximumProducersPerComposition) {
    const first = ir.signals[[...consumerMap.keys()].sort()[0]!]!;
    fail(first, "CUT_AUDIO_REACTIVE_PRODUCER_LIMIT", `composition exceeds ${referenceAudioReactivePreparationLimits.maximumProducersPerComposition} reachable audio-reactive producers.`);
  }
  if (!options.verifiedResourcePath) {
    const first = ir.signals[[...consumerMap.keys()].sort()[0]!]!;
    fail(first, "CUT_AUDIO_REACTIVE_PRODUCER_RESOURCE", "runtime preparation requires the same invocation-scoped verified input snapshot used by rendering.");
  }

  const toolchain = await bindReferenceFfmpegExecutableToolchain();
  const decoderIntegritySha256 = hash({
    format: "cut-reference-audio-reactive-decoder",
    version: 1,
    contract: decodeContract,
    toolchainIntegrity: toolchain.toolchain.integrity,
    executableSha256: toolchain.toolchain.ffmpeg.executableSha256,
  });
  const configs: ValidatedProducer[] = [];
  for (const signalId of [...consumerMap.keys()].sort()) {
    const signal = ir.signals[signalId] as ProducerTrack | undefined;
    if (!signal || signal.kind !== "track" || !signal.producer) throw new Error(`CUT audio-reactive consumer map lost producer signal ${signalId}.`);
    const producer = validateProducerShape(signal), consumers = Object.freeze([...(consumerMap.get(signalId) ?? [])].sort((left, right) => left.node.id.localeCompare(right.node.id) || left.property.localeCompare(right.property)));
    if (producer.scope.compositionId !== composition.id) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE", `scope.compositionId must equal active composition ${composition.id}.`);
    const scene = ir.scenes[producer.scope.sceneId];
    if (!scene || !composition.sceneIds.includes(scene.id)) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE", "scope.sceneId must identify one scene owned by the active composition.");
    for (const { node: consumer, property } of consumers) {
      if (consumer.op !== "cut.visual.group" || !["x", "y", "scale", "rotation", "opacity"].includes(property)) {
        fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE", `runtime producer consumers must be Group x/y/scale/rotation/opacity properties; ${consumer.id} uses ${consumer.op}.${property}.`);
      }
      if (consumer.ownership !== "root" || !scene.items.some((item) => item.id === consumer.id && item.domain === "visual")) {
        fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE", `consumer ${consumer.id} must be a direct scene-root visual, matching the public direct-set contract.`);
      }
      const endpointNumbers = [producer.mapping.from, producer.mapping.to].map((endpoint) => endpoint.kind === "quantity" ? rationalToNumber(endpoint.magnitude) : Number.NaN);
      const outside = (minimum: number, maximum: number) => endpointNumbers.some((value) => !Number.isFinite(value) || value < minimum || value > maximum);
      if ((property === "x" || property === "y") && outside(-65_536, 65_536)) {
        fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `${property} mapping endpoints must remain from -65536px through 65536px.`);
      }
      if (property === "rotation" && outside(-360_000, 360_000)) {
        fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "rotation mapping endpoints must remain from -360000deg through 360000deg.");
      }
      if (property === "opacity" && outside(0, 1)) {
        fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", "opacity mapping endpoints must remain from 0 through 1.");
      }
      if (property === "scale") {
        const maximumDimensionScale = Math.min(8, 16_384 / composition.width, 16_384 / composition.height);
        const maximumPixelScale = Math.sqrt(67_108_864 / (composition.width * composition.height));
        const maximumScale = Math.max(0.001, Math.min(maximumDimensionScale, maximumPixelScale));
        if (outside(0.001, maximumScale)) {
          fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_CONFIG", `scale mapping endpoints must remain from 0.001 through ${maximumScale} for this composition.`);
        }
      }
    }
    const wrongScene = consumers.find(({ node }) => node.sceneId !== scene.id);
    if (wrongScene) fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE", `consumer ${wrongScene.node.id} is not owned by scoped scene ${scene.id}.`);
    if (compareRational(producer.at, zeroRational) < 0 || compareRational(producer.at, scene.duration) >= 0) {
      fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE", "producer.at must be a scene-local time inside the scoped scene.");
    }
    const source = selectedAudioIdentity(ir, signal, producer.source.id);
    if (compareRational(producer.range.start, zeroRational) < 0
      || compareRational(producer.range.end, producer.range.start) <= 0
      || compareRational(producer.range.end, source.selectedDuration) > 0) {
      fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_RESOURCE", "producer.range must be a non-empty half-open interval inside the locked selected audio stream.");
    }
    const selectionDuration = subtractRational(producer.range.end, producer.range.start);
    if (compareRational(addRational(producer.at, selectionDuration), scene.duration) > 0) {
      fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_SCOPE", "producer.at plus selected source duration must stay inside the scoped scene.");
    }
    const rangeStart = exactSamples(signal, producer.range.start, composition.sampleRate, "producer.range.start", true);
    const rangeEnd = exactSamples(signal, producer.range.end, composition.sampleRate, "producer.range.end", false);
    const compositionStartFrame = exactSamples(signal, addRational(scene.start, producer.at), composition.sampleRate, "scene.start + producer.at", true);
    const windowFrames = exactSamples(signal, producer.window, composition.sampleRate, "producer.window", false);
    const hopFrames = exactSamples(signal, producer.hop, composition.sampleRate, "producer.hop", false);
    const attackFrames = exactSamples(signal, producer.attack, composition.sampleRate, "producer.attack", false);
    const releaseFrames = exactSamples(signal, producer.release, composition.sampleRate, "producer.release", false);
    if (compareRational(addRational(producer.at, producer.window), scene.duration) >= 0) {
      fail(signal, "CUT_AUDIO_REACTIVE_PRODUCER_NOOP", "the first full causal window must end before the scoped scene ends.");
    }
    let plan: ReferenceAudioReactiveAnalysisPlan;
    try {
      plan = compileReferenceAudioReactiveAnalysisPlan({
        source: Object.freeze({
          activeVariant: source.activeVariant,
          lockedResourceSha256: source.lockedResourceSha256,
          selectedStreamIndex: source.selectedStreamIndex,
          selectedStreamSampleRate: source.selectedStreamSampleRate,
          selectedStreamIdentitySha256: source.selectedStreamIdentitySha256,
          decoderIntegritySha256,
        }),
        sampleRate: composition.sampleRate,
        range: Object.freeze({ startFrame: rangeStart, endFrame: rangeEnd }),
        compositionStartFrame,
        windowFrames,
        hopFrames,
        detector: producer.detector,
        channelMode: "stereo-linked",
        normalization: Object.freeze({ kind: producer.detector === "peak" ? "peak-linear" : "rms-linear", floor: producer.floor, ceiling: producer.ceiling }),
        smoothing: Object.freeze({ kind: "attack-release-one-pole", attackFrames, releaseFrames }),
      });
    } catch (error) {
      failFromAnalysis(signal, error);
    }
    configs.push(Object.freeze({ signal, producer, scene, consumers, plan, producerIdentity: hash(producer) }));
  }

  const uniquePlans = new Map(configs.map((config) => [config.plan.integrity, config.plan]));
  const consumerAttachments = configs.reduce((total, config) => total + config.consumers.length, 0);
  const decodedFrames = [...uniquePlans.values()].reduce((total, plan) => total + plan.range.endFrame - plan.range.startFrame, 0);
  const decodedBytes = decodedFrames * 8;
  const outputWindows = [...uniquePlans.values()].reduce((total, plan) => total + plan.windowCount, 0);
  const detectorChannelSamples = [...uniquePlans.values()].reduce((total, plan) => total + plan.detectorWorkChannelSamples, 0);
  const limitSignal = configs[0]!.signal;
  if (uniquePlans.size > referenceAudioReactivePreparationLimits.maximumUniqueAnalysesPerComposition
    || consumerAttachments > referenceAudioReactivePreparationLimits.maximumConsumerAttachmentsPerComposition
    || !Number.isSafeInteger(decodedFrames) || decodedFrames > referenceAudioReactivePreparationLimits.maximumAggregateDecodedFrames
    || !Number.isSafeInteger(decodedBytes) || decodedBytes > referenceAudioReactivePreparationLimits.maximumAggregateDecodedBytes
    || !Number.isSafeInteger(outputWindows) || outputWindows > referenceAudioReactivePreparationLimits.maximumAggregateOutputWindows
    || !Number.isSafeInteger(detectorChannelSamples) || detectorChannelSamples > referenceAudioReactivePreparationLimits.maximumAggregateDetectorChannelSamples) {
    fail(limitSignal, "CUT_AUDIO_REACTIVE_PRODUCER_LIMIT", "composition audio-reactive preparation exceeds its aggregate signal, attachment, unique-analysis, decoded-frame/byte, output-window, or detector-work budget.");
  }

  const preparedByPlan = new Map<string, { analysis: ReferenceAudioReactiveAnalysisResult; status: "hit" | "miss" }>();
  const evidence: ReferenceAudioReactivePreparationEvidence[] = [];
  for (const config of configs) {
    let prepared = preparedByPlan.get(config.plan.integrity), cacheStatus: "hit" | "miss" | "memory";
    if (prepared) cacheStatus = "memory";
    else {
      const key = referenceAudioReactiveAnalysisCacheKey(config.plan), directory = await options.cacheDirectoryForKey(key);
      const sourcePath = options.verifiedResourcePath(config.producer.source.id);
      const decoded = await decodeSelectedRange(config.signal, config.plan, sourcePath, directory, toolchain);
      let analysis: ReferenceAudioReactiveAnalysisResult;
      try { analysis = analyzeReferenceAudioReactiveStereo(float32(decoded.bytes, config.signal), config.plan); }
      catch (error) { failFromAnalysis(config.signal, error); }
      prepared = { analysis, status: decoded.status };
      preparedByPlan.set(config.plan.integrity, prepared);
      cacheStatus = decoded.status;
    }
    const sceneTrack = preparedSceneTrack(config, prepared.analysis);
    frameObservable(config.signal, config, sceneTrack, composition);
    options.resolver.install(config.signal.id, sceneTrack);
    evidence.push(Object.freeze({
      format: "cut-reference-audio-reactive-preparation-evidence" as const,
      version: 1 as const,
      compositionId: composition.id,
      sceneId: config.scene.id,
      signalId: config.signal.id,
      consumerNodeIds: Object.freeze([...new Set(config.consumers.map(({ node }) => node.id))]),
      producerIdentity: config.producerIdentity,
      planIntegrity: config.plan.integrity,
      cacheKey: prepared.analysis.cacheKey,
      cacheStatus,
      activeVariant: config.plan.source.activeVariant,
      lockedResourceSha256: config.plan.source.lockedResourceSha256,
      selectedStreamIndex: config.plan.source.selectedStreamIndex,
      selectedStreamIdentitySha256: config.plan.source.selectedStreamIdentitySha256,
      decoderIntegritySha256: config.plan.source.decoderIntegritySha256,
      inputPcmSha256: prepared.analysis.inputPcmSha256,
      analysisContentIntegrity: prepared.analysis.contentIntegrity,
      analysisSignalSha256: prepared.analysis.signalSha256,
      preparedSignalSha256: sceneTrack.contentHash,
      decodedFrames: config.plan.range.endFrame - config.plan.range.startFrame,
      decodedBytes: (config.plan.range.endFrame - config.plan.range.startFrame) * 8,
      windowCount: config.plan.windowCount,
      sceneLocalEventCount: sceneTrack.events.length,
    }));
  }
  return Object.freeze(evidence);
}
