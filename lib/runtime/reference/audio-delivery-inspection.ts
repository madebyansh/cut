import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReferenceAudioPeakSource } from "./audio-peak";
import {
  assertReferenceAudioTruePeakScanContract,
  measureReferenceStereoF32LeTruePeak,
  referenceAudioTruePeakLimits,
  type ReferenceAudioTruePeakScan,
} from "./audio-true-peak";
import { ReferenceMediaProcessError, runFfmpeg, runFfprobeCapture } from "./ffmpeg";

export type ReferenceAudioDeliveryErrorCode =
  | "CUT_AUDIO_DELIVERY_STRUCTURE"
  | "CUT_AUDIO_DELIVERY_PROBE"
  | "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE"
  | "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT"
  | "CUT_AUDIO_DELIVERY_TRUE_PEAK"
  | "CUT_AUDIO_DELIVERY_ENCODE"
  | "CUT_AUDIO_DELIVERY_MEASUREMENT"
  | "CUT_AUDIO_DELIVERY_PUBLICATION";

export type ReferenceAudioDeliveryErrorDetail = Readonly<{
  kind: "structure" | "probe" | "decode" | "resource" | "true-peak" | "encode" | "measurement" | "publication";
  reason: string;
  expectedFrames?: number;
  observedFrames?: number;
  expectedSampleRate?: number;
  observedSampleRate?: number;
  observedChannels?: number;
  codec?: string;
  streamDurationFrames?: number;
  leadingPrimingFrames?: number;
  trailingPaddingFrames?: number;
  peakDbtp?: number | null;
  thresholdDbtp?: number;
}>;

export class ReferenceAudioDeliveryError extends Error {
  readonly source: ReferenceAudioPeakSource;
  readonly detail: ReferenceAudioDeliveryErrorDetail;

  constructor(
    readonly code: ReferenceAudioDeliveryErrorCode,
    source: ReferenceAudioPeakSource,
    message: string,
    detail: ReferenceAudioDeliveryErrorDetail,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceAudioDeliveryError";
    this.source = Object.freeze({ ...source });
    this.detail = Object.freeze({ ...detail });
  }
}

export type ReferenceDecodedAudioFraming = Readonly<{
  source: "normalized-pcm" | "aac-candidate";
  codec: string;
  sampleRate: number;
  channels: 2;
  expectedFrames: number;
  decodedFrames: number;
  streamDurationFrames: number;
  leadingPrimingFrames: number;
  trailingPaddingFrames: number;
  firstPacketPts: number | null;
  firstPacketDurationFrames: number | null;
  framingDerivation: "exact-pcm" | "ffmpeg-aac-skip-samples-and-stream-duration";
}>;

export type ReferenceDecodedTruePeakEvidence = Readonly<{
  framing: ReferenceDecodedAudioFraming;
  truePeak: ReferenceAudioTruePeakScan;
  /** SHA-256 of the exact authored decoded stereo f32le bytes scanned above. */
  authoredPcmSha256: string;
}>;

export type InspectReferenceDecodedTruePeakOptions = Readonly<{
  input: string;
  workDirectory: string;
  kind: "normalized-pcm" | "aac-candidate";
  expectedFrames: number;
  sampleRate: number;
  source: ReferenceAudioPeakSource;
}>;

type UnknownRecord = Record<string, unknown>;

const channels = 2;
const bytesPerFrame = 8;
const aacFrameSamples = 1_024;
const maximumProbeBytes = 64 * 1_024;
const probeCaptureLimits = Object.freeze({
  stdoutBytes: maximumProbeBytes,
  stderrBytes: 32 * 1_024,
  totalBytes: maximumProbeBytes + 32 * 1_024,
});

function fail(
  code: ReferenceAudioDeliveryErrorCode,
  options: Pick<InspectReferenceDecodedTruePeakOptions, "source">,
  message: string,
  detail: ReferenceAudioDeliveryErrorDetail,
  cause?: unknown,
): never {
  throw new ReferenceAudioDeliveryError(
    code,
    options.source,
    message,
    detail,
    cause === undefined ? undefined : { cause },
  );
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? value as UnknownRecord : undefined;
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function safeText(value: unknown, maximum = 64): string | undefined {
  return typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9_.+:/-]+$/u.test(value)
    ? value
    : undefined;
}

function processErrorCode(error: unknown) {
  const value = record(error)?.code;
  return typeof value === "string" && /^[A-Z0-9_]+$/u.test(value) && value.length <= 32 ? value : "PROCESS_FAILURE";
}

function probeProcessFailure(
  error: unknown,
  options: InspectReferenceDecodedTruePeakOptions,
  reason: string,
  message: string,
  codec?: string,
): never {
  const resource = error instanceof ReferenceMediaProcessError
    && (error.code === "CUT_MEDIA_PROCESS_OUTPUT_LIMIT" || error.code === "CUT_MEDIA_PROCESS_TIMEOUT");
  fail(
    resource ? "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT" : "CUT_AUDIO_DELIVERY_PROBE",
    options,
    `${message} (${processErrorCode(error)}).`,
    {
      kind: resource ? "resource" : "probe",
      reason: resource ? `${reason}-${error.detail.reason}` : reason,
      expectedFrames: options.expectedFrames,
      ...(codec === undefined ? {} : { codec }),
    },
    error,
  );
}

function parseJson(stdout: string, options: InspectReferenceDecodedTruePeakOptions, reason: string) {
  if (Buffer.byteLength(stdout) > maximumProbeBytes) {
    fail(
      "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT",
      options,
      "audio probe output exceeded CUT's bounded metadata budget.",
      { kind: "resource", reason: `${reason}-output-budget`, expectedFrames: options.expectedFrames },
    );
  }
  try {
    return JSON.parse(stdout) as UnknownRecord;
  } catch (error) {
    fail(
      "CUT_AUDIO_DELIVERY_PROBE",
      options,
      "audio probe returned malformed JSON.",
      { kind: "probe", reason: `${reason}-malformed-json`, expectedFrames: options.expectedFrames },
      error,
    );
  }
}

function exactDurationFrames(
  durationTs: unknown,
  timeBase: unknown,
  sampleRate: number,
  options: InspectReferenceDecodedTruePeakOptions,
) {
  const ticks = safeInteger(durationTs);
  if (ticks === undefined || ticks < 0 || typeof timeBase !== "string") {
    fail(
      "CUT_AUDIO_DELIVERY_PROBE",
      options,
      "audio stream has no exact non-negative duration clock.",
      { kind: "probe", reason: "invalid-duration-clock", expectedFrames: options.expectedFrames },
    );
  }
  const match = /^(\d+)\/(\d+)$/u.exec(timeBase);
  if (!match) {
    fail(
      "CUT_AUDIO_DELIVERY_PROBE",
      options,
      "audio stream time_base is not a positive rational.",
      { kind: "probe", reason: "invalid-time-base", expectedFrames: options.expectedFrames },
    );
  }
  const numerator = BigInt(ticks) * BigInt(match[1]) * BigInt(sampleRate);
  const denominator = BigInt(match[2]);
  if (denominator === 0n || numerator % denominator !== 0n) {
    fail(
      "CUT_AUDIO_DELIVERY_PROBE",
      options,
      "audio stream duration does not land on the authored sample grid.",
      { kind: "probe", reason: "fractional-duration-frame", expectedFrames: options.expectedFrames },
    );
  }
  const frames = numerator / denominator;
  if (frames > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(
      "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT",
      options,
      "audio stream duration exceeds CUT's safe-integer sample boundary.",
      { kind: "resource", reason: "duration-frame-budget", expectedFrames: options.expectedFrames },
    );
  }
  return Number(frames);
}

function firstPacketEvidence(parsed: UnknownRecord) {
  const packets = Array.isArray(parsed.packets) ? parsed.packets : [];
  const packet = record(packets[0]);
  if (!packet) return { pts: null, duration: null, skip: 0, discard: 0 };
  const sideData = Array.isArray(packet.side_data_list) ? packet.side_data_list : [];
  const skip = sideData.map(record).find((item) => item?.side_data_type === "Skip Samples");
  return {
    pts: safeInteger(packet.pts) ?? null,
    duration: safeInteger(packet.duration) ?? null,
    skip: safeInteger(skip?.skip_samples) ?? 0,
    discard: safeInteger(skip?.discard_padding) ?? 0,
  };
}

async function probeAudio(options: InspectReferenceDecodedTruePeakOptions) {
  let streamsResult: Awaited<ReturnType<typeof runFfprobeCapture>>;
  try {
    streamsResult = await runFfprobeCapture([
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,channel_layout,time_base,start_pts,duration_ts",
      "-of", "json",
      options.input,
    ], 60_000, probeCaptureLimits);
  } catch (error) {
    probeProcessFailure(error, options, "stream-probe-failure", "could not inspect the staged audio stream");
  }
  const parsed = parseJson(streamsResult.stdout, options, "stream-probe");
  const streams = Array.isArray(parsed.streams) ? parsed.streams.map(record).filter((value): value is UnknownRecord => Boolean(value)) : [];
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  const streamShapeValid = options.kind === "normalized-pcm"
    ? streams.length === 1 && audioStreams.length === 1 && videoStreams.length === 0
    : streams.length === 2 && audioStreams.length === 1 && videoStreams.length === 1;
  if (!streamShapeValid) {
    fail(
      "CUT_AUDIO_DELIVERY_PROBE",
      options,
      options.kind === "normalized-pcm"
        ? "normalized master must contain exactly one audio stream and no other streams."
        : "staged delivery must contain exactly one video and one audio stream and no other streams.",
      { kind: "probe", reason: "media-stream-contract", expectedFrames: options.expectedFrames },
    );
  }
  const stream = audioStreams[0];
  if (options.kind === "aac-candidate") {
    const video = videoStreams[0];
    const videoStart = safeInteger(video.start_pts);
    const videoDurationFrames = exactDurationFrames(video.duration_ts, video.time_base, options.sampleRate, options);
    if (videoStart !== 0 || videoDurationFrames !== options.expectedFrames) {
      fail(
        "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
        options,
        `staged picture spans ${videoDurationFrames} authored audio frames; CUT authored ${options.expectedFrames}.`,
        { kind: "decode", reason: "video-duration", expectedFrames: options.expectedFrames, streamDurationFrames: videoDurationFrames },
      );
    }
  }
  const codec = safeText(stream.codec_name) ?? "unknown";
  const sampleRate = safeInteger(stream.sample_rate);
  const observedChannels = safeInteger(stream.channels);
  const startPts = safeInteger(stream.start_pts);
  const layoutValid = stream.channel_layout === undefined || stream.channel_layout === "stereo";
  const startValid = options.kind === "normalized-pcm" ? startPts === undefined || startPts === 0 : startPts === 0;
  if (sampleRate !== options.sampleRate || observedChannels !== channels || !layoutValid || !startValid) {
    fail(
      "CUT_AUDIO_DELIVERY_PROBE",
      options,
      "staged audio does not preserve CUT's stereo sample-grid contract.",
      {
        kind: "probe",
        reason: "stream-contract",
        expectedFrames: options.expectedFrames,
        expectedSampleRate: options.sampleRate,
        ...(sampleRate === undefined ? {} : { observedSampleRate: sampleRate }),
        ...(observedChannels === undefined ? {} : { observedChannels }),
        codec,
      },
    );
  }
  if (options.kind === "aac-candidate" && codec !== "aac") {
    fail(
      "CUT_AUDIO_DELIVERY_PROBE",
      options,
      `staged delivery codec is ${codec}; expected AAC.`,
      { kind: "probe", reason: "codec", expectedFrames: options.expectedFrames, codec },
    );
  }
  if (options.kind === "normalized-pcm" && !codec.startsWith("pcm_")) {
    fail(
      "CUT_AUDIO_DELIVERY_PROBE",
      options,
      `normalized master codec is ${codec}; expected PCM.`,
      { kind: "probe", reason: "codec", expectedFrames: options.expectedFrames, codec },
    );
  }
  const streamDurationFrames = exactDurationFrames(stream.duration_ts, stream.time_base, sampleRate, options);
  if (streamDurationFrames !== options.expectedFrames) {
    fail(
      "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
      options,
      `staged audio declares ${streamDurationFrames} frames; CUT authored ${options.expectedFrames}.`,
      { kind: "decode", reason: "stream-duration", expectedFrames: options.expectedFrames, streamDurationFrames, codec },
    );
  }

  if (options.kind === "normalized-pcm") {
    return { codec, sampleRate, streamDurationFrames, packet: { pts: 0, duration: null, skip: 0, discard: 0 } };
  }

  let packetResult: Awaited<ReturnType<typeof runFfprobeCapture>>;
  try {
    packetResult = await runFfprobeCapture([
      "-v", "error",
      "-select_streams", "a:0",
      "-show_packets",
      "-show_entries", "packet=pts,duration:packet_side_data=side_data_type,skip_samples,discard_padding",
      "-read_intervals", "%+#1",
      "-of", "json",
      options.input,
    ], 60_000, probeCaptureLimits);
  } catch (error) {
    probeProcessFailure(error, options, "packet-probe-failure", "could not inspect AAC priming metadata", codec);
  }
  const packet = firstPacketEvidence(parseJson(packetResult.stdout, options, "packet-probe"));
  if (packet.pts !== -aacFrameSamples || packet.duration !== aacFrameSamples || packet.skip !== aacFrameSamples || packet.discard !== 0) {
    fail(
      "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
      options,
      "AAC priming metadata does not match CUT's owned encoder contract.",
      { kind: "decode", reason: "aac-priming", expectedFrames: options.expectedFrames, codec, leadingPrimingFrames: packet.skip },
    );
  }
  return { codec, sampleRate, streamDurationFrames, packet };
}

/**
 * Decode one private PCM/AAC artifact without resampling, prove exact framing,
 * and measure only CUT's authored sample boundary. AAC priming is removed by
 * the decoder; a final partial codec frame is reported but excluded.
 */
export async function inspectReferenceDecodedTruePeak(
  options: InspectReferenceDecodedTruePeakOptions,
): Promise<ReferenceDecodedTruePeakEvidence> {
  if (!Number.isSafeInteger(options.expectedFrames) || options.expectedFrames < 0) {
    fail(
      "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
      options,
      "expectedFrames must be a non-negative safe integer.",
      { kind: "decode", reason: "invalid-expected-frames" },
    );
  }
  // Reuse the scanner's exact 48 kHz and bounded-MAC contract before probing or
  // decoding. Its source-located diagnostic is the normative failure.
  assertReferenceAudioTruePeakScanContract({
    expectedFrames: options.expectedFrames,
    sampleRate: options.sampleRate,
    source: options.source,
  });
  let physicalWorkDirectory: string;
  try {
    const metadata = await lstat(options.workDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail(
        "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
        options,
        "true-peak work directory must be a direct private directory.",
        { kind: "decode", reason: "work-directory-structure", expectedFrames: options.expectedFrames },
      );
    }
    physicalWorkDirectory = await realpath(options.workDirectory);
  } catch (error) {
    if (error instanceof ReferenceAudioDeliveryError) throw error;
    fail(
      "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
      options,
      `true-peak work directory is unavailable (${processErrorCode(error)}).`,
      { kind: "decode", reason: "work-directory-unavailable", expectedFrames: options.expectedFrames },
      error,
    );
  }
  const probe = await probeAudio(options);
  const decodedPath = resolve(physicalWorkDirectory, `.cut-true-peak-${randomUUID()}.f32le`);
  const maximumDecodedFrames = options.expectedFrames + (options.kind === "aac-candidate" ? aacFrameSamples : 0);
  const maximumDecodedBytes = maximumDecodedFrames * bytesPerFrame;
  let handle: FileHandle | undefined;
  let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
  try {
    try {
      await runFfmpeg([
        "-y", "-v", "error",
        "-i", options.input,
        "-map", "0:a:0",
        "-af", `atrim=end_sample=${maximumDecodedFrames}`,
        "-c:a", "pcm_f32le",
        "-f", "f32le",
        "-fs", String(maximumDecodedBytes),
        decodedPath,
      ], 120_000);
    } catch (error) {
      fail(
        "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
        options,
        `could not decode staged audio for CUT true-peak inspection (${processErrorCode(error)}).`,
        { kind: "decode", reason: "decode-failure", expectedFrames: options.expectedFrames, codec: probe.codec },
        error,
      );
    }
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      fail(
        "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
        options,
        "this platform cannot open decoded true-peak bytes with no-follow semantics.",
        { kind: "decode", reason: "no-follow-unavailable", expectedFrames: options.expectedFrames, codec: probe.codec },
      );
    }
    try {
      handle = await open(decodedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      fail(
        "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
        options,
        `decoded true-peak artifact is unavailable (${processErrorCode(error)}).`,
        { kind: "decode", reason: "decoded-artifact-missing", expectedFrames: options.expectedFrames, codec: probe.codec },
        error,
      );
    }
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size % bytesPerFrame !== 0) {
      fail(
        "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
        options,
        "decoded true-peak artifact is not a complete regular stereo f32le stream.",
        { kind: "decode", reason: "decoded-artifact-structure", expectedFrames: options.expectedFrames, codec: probe.codec },
      );
    }
    const decodedFrames = metadata.size / bytesPerFrame;
    const trailingPaddingFrames = decodedFrames - options.expectedFrames;
    const maximumPaddingFrames = options.kind === "aac-candidate" ? aacFrameSamples - 1 : 0;
    if (trailingPaddingFrames < 0 || trailingPaddingFrames > maximumPaddingFrames) {
      fail(
        "CUT_AUDIO_DELIVERY_DECODE_STRUCTURE",
        options,
        `decoded audio has ${decodedFrames} frames for CUT's ${options.expectedFrames}-frame boundary.`,
        {
          kind: "decode",
          reason: "decoded-frame-boundary",
          expectedFrames: options.expectedFrames,
          observedFrames: decodedFrames,
          codec: probe.codec,
          trailingPaddingFrames,
        },
      );
    }
    const expectedBytes = options.expectedFrames * bytesPerFrame;
    const input = expectedBytes === 0
      ? []
      : (stream = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: expectedBytes - 1,
        highWaterMark: referenceAudioTruePeakLimits.fileReadChunkBytes,
      }));
    const digest = createHash("sha256");
    const hashingInput = (async function* () {
      for await (const chunk of input) {
        digest.update(chunk);
        yield chunk;
      }
    })();
    const truePeak = await measureReferenceStereoF32LeTruePeak(hashingInput, {
      expectedFrames: options.expectedFrames,
      sampleRate: options.sampleRate,
      source: options.source,
    });
    return Object.freeze({
      framing: Object.freeze({
        source: options.kind,
        codec: probe.codec,
        sampleRate: probe.sampleRate,
        channels: 2,
        expectedFrames: options.expectedFrames,
        decodedFrames,
        streamDurationFrames: probe.streamDurationFrames,
        leadingPrimingFrames: probe.packet.skip,
        trailingPaddingFrames,
        firstPacketPts: probe.packet.pts,
        firstPacketDurationFrames: probe.packet.duration,
        framingDerivation: options.kind === "aac-candidate"
          ? "ffmpeg-aac-skip-samples-and-stream-duration"
          : "exact-pcm",
      }),
      truePeak,
      authoredPcmSha256: digest.digest("hex"),
    });
  } finally {
    stream?.destroy();
    if (handle) await handle.close().catch(() => undefined);
    await rm(decodedPath, { force: true }).catch(() => undefined);
  }
}
