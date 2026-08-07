import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import {
  defaultTranscriptLimits,
  parseCutTranscript,
  selectTranscriptRange,
  TranscriptInterchangeError,
  type CutTranscript,
} from "../interchange/transcript";
import type {
  CutAVIR,
  IRResource,
  IRTranscriptBindingV1,
  IRTranscriptMediaAuthorityV1,
} from "./ir";
import type { LockedResource } from "./lock";
import {
  CutTranscriptMediaAuthorityError,
  cutTranscriptMediaAuthorityIdentity,
} from "./transcript-contract";
import {
  compareRational,
  multiplyRational,
  rational,
  subtractRational,
  zeroRational,
} from "./rational";

export type CutTranscriptLockErrorCode =
  | "CUT_TRANSCRIPT_LOCK_RESOURCE"
  | "CUT_TRANSCRIPT_LOCK_SIDECAR"
  | "CUT_TRANSCRIPT_LOCK_SELECTION"
  | "CUT_TRANSCRIPT_LOCK_MEDIA"
  | "CUT_TRANSCRIPT_LOCK_INTEGRITY";

export class CutTranscriptLockError extends Error {
  readonly source: {
    module: string;
    line: number;
    column: number;
    bindingId: string;
  };

  constructor(
    readonly code: CutTranscriptLockErrorCode,
    readonly path: string,
    binding: IRTranscriptBindingV1,
    detail: string,
  ) {
    const start = binding.provenance.span.start;
    super(`${code} at ${path}: ${detail} at ${binding.provenance.module}:${start.line}:${start.column}.`);
    this.name = "CutTranscriptLockError";
    this.source = {
      module: binding.provenance.module,
      line: start.line,
      column: start.column,
      bindingId: binding.id,
    };
  }
}

export type CutTranscriptResourceReader = (
  resource: IRResource,
  locked: LockedResource,
  binding: IRTranscriptBindingV1,
  path: string,
) => Promise<Uint8Array>;

export const cutTranscriptSidecarMaxBytes = defaultTranscriptLimits.maxBytes;

function fail(
  code: CutTranscriptLockErrorCode,
  path: string,
  binding: IRTranscriptBindingV1,
  detail: string,
): never {
  throw new CutTranscriptLockError(code, path, binding, detail);
}

function canonicalEqual(left: unknown, right: unknown) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function exactRationalEqual(left: { numerator: string; denominator: string }, right: { numerator: string; denominator: string }) {
  return compareRational(left, right) === 0;
}

function selectedWords(
  transcript: CutTranscript,
  binding: IRTranscriptBindingV1,
  path: string,
) {
  const fromIndex = transcript.words.findIndex((word) => word.id === binding.from);
  const throughIndex = transcript.words.findIndex((word) => word.id === binding.through);
  if (fromIndex < 0 || throughIndex < fromIndex) {
    fail("CUT_TRANSCRIPT_LOCK_SELECTION", path, binding, "cannot reproduce the inclusive word selection from the locked sidecar.");
  }
  return transcript.words.slice(fromIndex, throughIndex + 1);
}

function assertSelection(
  transcript: CutTranscript,
  binding: IRTranscriptBindingV1,
  path: string,
) {
  let selection;
  try {
    selection = selectTranscriptRange(transcript, { from: binding.from, through: binding.through });
  } catch (error) {
    if (error instanceof TranscriptInterchangeError) {
      fail(
        "CUT_TRANSCRIPT_LOCK_SELECTION",
        path,
        binding,
        `locked sidecar selection failed (${error.code} at ${error.path}).`,
      );
    }
    throw error;
  }
  const words = selectedWords(transcript, binding, path);
  if (selection.from !== binding.from
    || selection.through !== binding.through
    || selection.selectedWordCount !== binding.selectedWordCount
    || selection.selectedIdsSha256 !== binding.selectedIdsSha256
    || selection.text !== binding.text
    || !exactRationalEqual(selection.sourceRange.start, binding.sourceRange.start)
    || !exactRationalEqual(selection.sourceRange.duration, binding.sourceRange.duration)
    || !canonicalEqual(words, binding.words)) {
    fail(
      "CUT_TRANSCRIPT_LOCK_SELECTION",
      path,
      binding,
      "selected IDs, words, hash, text, or exact source timing cannot be reproduced from the locked sidecar bytes.",
    );
  }
  if (!canonicalEqual(selection.media, binding.media)) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.media`,
      binding,
      "ledger media authority does not exactly match the locked transcript sidecar.",
    );
  }
}

function assertLockedAudio(
  ir: CutAVIR,
  lockedResources: Readonly<Record<string, LockedResource>>,
  binding: IRTranscriptBindingV1,
  path: string,
) {
  const authored = ir.resources[binding.audioResourceId];
  const locked = lockedResources[binding.audioResourceId];
  if (!authored || authored.kind !== "audio" || !locked || locked.kind !== "audio") {
    fail(
      "CUT_TRANSCRIPT_LOCK_RESOURCE",
      `${path}.audioResourceId`,
      binding,
      "must resolve to the same declared and locked AudioAsset.",
    );
  }
  const authoredSelector = authored.streamSelection?.audio;
  if (authoredSelector !== undefined && authoredSelector !== binding.media.audioStreamIndex) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.media.audioStreamIndex`,
      binding,
      `authored AudioAsset selector ${authoredSelector} does not match transcript stream ${binding.media.audioStreamIndex}.`,
    );
  }
  if (locked.sha256 !== binding.media.sha256) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.media.sha256`,
      binding,
      "transcript media digest does not match the locked AudioAsset bytes.",
    );
  }
  if (locked.probe.kind !== "media") {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.audioResourceId`,
      binding,
      "locked AudioAsset has no media probe.",
    );
  }
  const selected = locked.probe.selected.audio;
  if (!selected) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.media.audioStreamIndex`,
      binding,
      "locked AudioAsset has no probed selected audio stream.",
    );
  }
  if (selected.streamIndex !== binding.media.audioStreamIndex) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.media.audioStreamIndex`,
      binding,
      `probed locked stream ${selected.streamIndex} does not match transcript stream ${binding.media.audioStreamIndex}.`,
    );
  }
  const stream = locked.probe.identity.streams.find((candidate) =>
    candidate.type === "audio" && candidate.index === selected.streamIndex);
  if (!stream || stream.sampleRate !== binding.media.audioSampleRate) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.media.audioSampleRate`,
      binding,
      `probed locked sample rate ${stream?.sampleRate ?? "missing"} does not match transcript rate ${binding.media.audioSampleRate}.`,
    );
  }
  if (!exactRationalEqual(selected.duration, binding.media.duration)) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.media.duration`,
      binding,
      `probed locked duration ${selected.duration.numerator}/${selected.duration.denominator}s does not match transcript duration ${binding.media.duration.numerator}/${binding.media.duration.denominator}s.`,
    );
  }
  const videoStreamIndex = binding.media.videoStreamIndex;
  const videoFrameRate = binding.media.videoFrameRate;
  if ((videoStreamIndex === undefined) !== (videoFrameRate === undefined)) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.media`,
      binding,
      "optional videoStreamIndex and videoFrameRate must be present together.",
    );
  }
  if (videoStreamIndex !== undefined && videoFrameRate !== undefined) {
    const videoStream = locked.probe.identity.streams.find((candidate) =>
      candidate.type === "video" && candidate.index === videoStreamIndex);
    if (!videoStream) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.videoStreamIndex`,
        binding,
        `locked transcript media has no probed video stream ${videoStreamIndex}.`,
      );
    }
    if (!videoStream.frameRate
      || !exactRationalEqual(videoStream.frameRate, videoFrameRate)) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.videoFrameRate`,
        binding,
        `probed locked video rate ${videoStream.frameRate
          ? `${videoStream.frameRate.numerator}/${videoStream.frameRate.denominator}`
          : "missing"} does not match transcript rate ${videoFrameRate.numerator}/${videoFrameRate.denominator}.`,
      );
    }
  }
}

function transcriptAuthorityForBinding(
  ir: CutAVIR,
  binding: IRTranscriptBindingV1,
  path: string,
) {
  if (binding.mediaAuthorityId === undefined) return undefined;
  const authority = ir.transcriptMediaAuthorities
    ?.find((candidate) => candidate.id === binding.mediaAuthorityId);
  if (!authority) {
    fail(
      "CUT_TRANSCRIPT_LOCK_RESOURCE",
      `${path}.mediaAuthorityId`,
      binding,
      `does not resolve to declared transcript media authority ${binding.mediaAuthorityId}.`,
    );
  }
  return authority;
}

function assertLockedTranscriptMediaAuthority(
  ir: CutAVIR,
  lockedResources: Readonly<Record<string, LockedResource>>,
  binding: IRTranscriptBindingV1,
  authority: IRTranscriptMediaAuthorityV1,
  path: string,
) {
  const authorityPath = `$.transcriptMediaAuthorities[${ir.transcriptMediaAuthorities!
    .findIndex((candidate) => candidate.id === authority.id)}]`;
  if (authority.version !== 1
    || authority.kind !== "transcript-media-authority"
    || authority.compositionId !== binding.compositionId
    || authority.sceneId !== binding.sceneId
    || authority.transcriptResourceId !== binding.transcriptResourceId
    || authority.audioResourceId !== binding.audioResourceId
    || authority.audioStreamIndex !== binding.media.audioStreamIndex) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${path}.mediaAuthorityId`,
      binding,
      "authority ownership, transcript, audio resource, or selected audio stream does not match the transcript edit.",
    );
  }
  let expectedIdentity: string;
  try {
    expectedIdentity = cutTranscriptMediaAuthorityIdentity(authority);
  } catch (error) {
    if (!(error instanceof CutTranscriptMediaAuthorityError)) throw error;
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      authorityPath,
      binding,
      error.message,
    );
  }
  if (authority.identity !== expectedIdentity) {
    fail(
      "CUT_TRANSCRIPT_LOCK_INTEGRITY",
      `${authorityPath}.identity`,
      binding,
      `does not match the authenticated authority semantics (${expectedIdentity}).`,
    );
  }
  const audio = ir.resources[authority.audioResourceId];
  const lockedAudio = lockedResources[authority.audioResourceId];
  if (!audio
    || audio.kind !== "audio"
    || audio.streamSelection?.audio !== authority.audioStreamIndex
    || !lockedAudio
    || lockedAudio.kind !== "audio"
    || lockedAudio.probe.kind !== "media"
    || lockedAudio.probe.selected.audio?.streamIndex
      !== authority.audioStreamIndex) {
    fail(
      "CUT_TRANSCRIPT_LOCK_RESOURCE",
      `${authorityPath}.audioResourceId`,
      binding,
      "authority audio must resolve to one explicitly selected locked audio stream.",
    );
  }
  if (multiplyRational(
    authority.audioAt,
    rational(binding.media.audioSampleRate),
  ).denominator !== "1") {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${authorityPath}.audioAt`,
      binding,
      `must land exactly on the authenticated ${binding.media.audioSampleRate} Hz audio grid.`,
    );
  }
  const video = ir.resources[authority.videoResourceId];
  const lockedVideo = lockedResources[authority.videoResourceId];
  if (!video
    || video.kind !== "video"
    || video.streamSelection?.video !== authority.videoStreamIndex
    || !lockedVideo
    || lockedVideo.kind !== "video"
    || lockedVideo.locator !== video.locator
    || lockedVideo.probe.kind !== "media") {
    fail(
      "CUT_TRANSCRIPT_LOCK_RESOURCE",
      `${authorityPath}.videoResourceId`,
      binding,
      "authority video must resolve to one independently locked VideoAsset with an explicit selected stream.",
    );
  }
  const selected = lockedVideo.probe.selected.video;
  if (!selected
    || selected.streamIndex !== authority.videoStreamIndex
    || selected.durationSource !== "decoded-video-cadence"
    || !selected.decodedVideoCadence) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${authorityPath}.videoStreamIndex`,
      binding,
      "authority video requires the exact selected stream and decoded-video-cadence duration authority.",
    );
  }
  if (!selected.frameRate
    || !exactRationalEqual(selected.frameRate, authority.videoFrameRate)) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${authorityPath}.videoFrameRate`,
      binding,
      `locked selected-video rate ${selected.frameRate
        ? `${selected.frameRate.numerator}/${selected.frameRate.denominator}`
        : "missing"} does not match the authority.`,
    );
  }
  if (!exactRationalEqual(selected.duration, authority.videoDuration)) {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${authorityPath}.videoDuration`,
      binding,
      `locked selected-video duration ${selected.duration.numerator}/${selected.duration.denominator}s does not match the authority.`,
    );
  }
  if (multiplyRational(
    authority.videoAt,
    authority.videoFrameRate,
  ).denominator !== "1") {
    fail(
      "CUT_TRANSCRIPT_LOCK_MEDIA",
      `${authorityPath}.videoAt`,
      binding,
      `must land exactly on the authenticated ${authority.videoFrameRate.numerator}/${authority.videoFrameRate.denominator} fps video grid.`,
    );
  }
}

function assertLockedTranscriptPictures(
  ir: CutAVIR,
  lockedResources: Readonly<Record<string, LockedResource>>,
  binding: IRTranscriptBindingV1,
  path: string,
) {
  const consumers = Object.values(ir.nodes).filter((node) =>
    node.op === "cut.edit.picture_clip"
    && node.inputs.transcriptBindingId?.kind === "string"
    && node.inputs.transcriptBindingId.value === binding.id);
  if (!consumers.length) return;
  const authority = transcriptAuthorityForBinding(ir, binding, path);
  if (authority) {
    assertLockedTranscriptMediaAuthority(
      ir,
      lockedResources,
      binding,
      authority,
      path,
    );
  }
  const audio = ir.resources[binding.audioResourceId];
  const lockedAudio = lockedResources[binding.audioResourceId];
  for (const node of consumers) {
    const source = node.inputs.source;
    const video = source?.kind === "resource-ref"
      ? ir.resources[source.id]
      : undefined;
    const locked = source?.kind === "resource-ref"
      ? lockedResources[source.id]
      : undefined;
    if (authority) {
      if (!video
        || video.kind !== "video"
        || source?.kind !== "resource-ref"
        || source.id !== authority.videoResourceId
        || !locked
        || locked.kind !== "video"
        || locked.probe.kind !== "media"
        || locked.probe.selected.video?.streamIndex
          !== authority.videoStreamIndex) {
        fail(
          "CUT_TRANSCRIPT_LOCK_RESOURCE",
          `${path}.mediaAuthorityId`,
          binding,
          "authority-backed TranscriptPicture must consume the authority's exact independently locked selected video resource.",
        );
      }
      continue;
    }
    if (!audio
      || !lockedAudio
      || lockedAudio.kind !== "audio"
      || lockedAudio.probe.kind !== "media"
      || !video
      || video.kind !== "video"
      || !locked
      || locked.kind !== "video"
      || video.locator !== audio.locator
      || locked.locator !== video.locator
      || locked.sha256 !== binding.media.sha256) {
      fail(
        "CUT_TRANSCRIPT_LOCK_RESOURCE",
        `${path}.media.videoStreamIndex`,
        binding,
        "TranscriptPicture must resolve to one locked co-located VideoAsset with the transcript media byte digest.",
      );
    }
    if (locked.probe.kind !== "media") {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.videoStreamIndex`,
        binding,
        "locked TranscriptPicture VideoAsset has no media probe.",
      );
    }
    const selected = locked.probe.selected.video;
    if (!selected
      || selected.streamIndex !== binding.media.videoStreamIndex) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.videoStreamIndex`,
        binding,
        `locked TranscriptPicture selected video stream ${selected?.streamIndex ?? "missing"} does not match transcript stream ${binding.media.videoStreamIndex ?? "missing"}.`,
      );
    }
    if (selected.durationSource !== "decoded-video-cadence"
      || !selected.decodedVideoCadence) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.duration`,
        binding,
        "TranscriptPicture requires decoded-video-cadence duration authority for the selected picture stream.",
      );
    }
    if (!selected.frameRate
      || binding.media.videoFrameRate === undefined
      || !exactRationalEqual(selected.frameRate, binding.media.videoFrameRate)) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.videoFrameRate`,
        binding,
        `decoded TranscriptPicture rate ${selected.frameRate
          ? `${selected.frameRate.numerator}/${selected.frameRate.denominator}`
          : "missing"} does not match transcript rate ${binding.media.videoFrameRate
            ? `${binding.media.videoFrameRate.numerator}/${binding.media.videoFrameRate.denominator}`
            : "missing"}.`,
      );
    }
    if (binding.media.videoDuration === undefined) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.videoDuration`,
        binding,
        "TranscriptPicture requires independently declared selected-video duration authority.",
      );
    }
    if (!exactRationalEqual(selected.duration, binding.media.videoDuration)) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.videoDuration`,
        binding,
        `decoded TranscriptPicture duration ${selected.duration.numerator}/${selected.duration.denominator}s does not match sidecar videoDuration ${binding.media.videoDuration.numerator}/${binding.media.videoDuration.denominator}s.`,
      );
    }
    const videoStream = locked.probe.identity.streams.find((candidate) =>
      candidate.type === "video"
      && candidate.index === binding.media.videoStreamIndex);
    const audioSelection = lockedAudio.probe.selected.audio;
    const audioWitness = audioSelection?.decodedAudioSamples;
    if (!audioSelection
      || audioSelection.streamIndex !== binding.media.audioStreamIndex
      || !audioWitness
      || !/^-?(?:0|[1-9]\d*)$/u.test(audioWitness.firstPts)
      || !videoStream?.start) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.videoStreamIndex`,
        binding,
        "TranscriptPicture v1 requires decoded-audio first-PTS authority and one exact selected-video presentation start; co-location alone does not prove a shared time origin.",
      );
    }
    const audioAnchor = multiplyRational(
      rational(audioWitness.firstPts),
      audioWitness.timeBase,
    );
    const observedPresentationDelta = subtractRational(
      audioAnchor,
      videoStream.start,
    );
    const declaredPresentationDelta =
      binding.media.audioVideoPresentationDelta ?? zeroRational;
    if (!exactRationalEqual(
      observedPresentationDelta,
      declaredPresentationDelta,
    )) {
      fail(
        "CUT_TRANSCRIPT_LOCK_MEDIA",
        `${path}.media.audioVideoPresentationDelta`,
        binding,
        `${binding.media.audioVideoPresentationDelta === undefined
          ? "omitted audioVideoPresentationDelta canonically asserts exact 0/1s"
          : `declared audioVideoPresentationDelta ${declaredPresentationDelta.numerator}/${declaredPresentationDelta.denominator}s`} but independently observed audio-anchor minus video-anchor delta is ${observedPresentationDelta.numerator}/${observedPresentationDelta.denominator}s (decoded audio starts at ${audioAnchor.numerator}/${audioAnchor.denominator}s; video starts at ${videoStream.start.numerator}/${videoStream.start.denominator}s).`,
      );
    }
  }
}

/**
 * Re-authenticate every typed transcript selection against exact locked
 * DataAsset bytes and the independently probed media master. Audio selection,
 * sample rate, duration, and optional co-located video stream/rate provenance
 * are all authenticated before the ledger can reach execution.
 */
export async function verifyCutTranscriptBindingsForLock(
  ir: CutAVIR,
  lockedResources: Readonly<Record<string, LockedResource>>,
  readTranscriptResource: CutTranscriptResourceReader,
) {
  if (!ir.transcriptBindings?.length) return;
  const parsedByResource = new Map<string, CutTranscript>();
  for (const [index, binding] of ir.transcriptBindings.entries()) {
    const path = `$.transcriptBindings[${index}]`;
    const authored = ir.resources[binding.transcriptResourceId];
    const locked = lockedResources[binding.transcriptResourceId];
    if (!authored || authored.kind !== "data" || !locked || locked.kind !== "data") {
      fail(
        "CUT_TRANSCRIPT_LOCK_RESOURCE",
        `${path}.transcriptResourceId`,
        binding,
        "must resolve to the same declared and locked DataAsset.",
      );
    }
    let transcript = parsedByResource.get(binding.transcriptResourceId);
    if (!transcript) {
      if (locked.bytes > defaultTranscriptLimits.maxBytes) {
        fail(
          "CUT_TRANSCRIPT_LOCK_SIDECAR",
          `${path}.transcriptResourceId`,
          binding,
          `locked transcript exceeds maxBytes (${defaultTranscriptLimits.maxBytes}).`,
        );
      }
      const bytes = await readTranscriptResource(authored, locked, binding, path);
      const observedSha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== locked.bytes || observedSha256 !== locked.sha256) {
        fail(
          "CUT_TRANSCRIPT_LOCK_INTEGRITY",
          `${path}.transcriptResourceId`,
          binding,
          "transcript DataAsset bytes do not match their locked byte identity.",
        );
      }
      try {
        transcript = parseCutTranscript(bytes);
      } catch (error) {
        if (error instanceof TranscriptInterchangeError) {
          fail(
            "CUT_TRANSCRIPT_LOCK_SIDECAR",
            `${path}.transcriptResourceId`,
            binding,
            `locked DataAsset is not a valid cut-transcript v1 sidecar (${error.code} at ${error.path}).`,
          );
        }
        throw error;
      }
      parsedByResource.set(binding.transcriptResourceId, transcript);
    }
    assertSelection(transcript, binding, path);
    assertLockedAudio(ir, lockedResources, binding, path);
    const authority = transcriptAuthorityForBinding(ir, binding, path);
    if (authority) {
      assertLockedTranscriptMediaAuthority(
        ir,
        lockedResources,
        binding,
        authority,
        path,
      );
    }
    assertLockedTranscriptPictures(ir, lockedResources, binding, path);
  }
}
