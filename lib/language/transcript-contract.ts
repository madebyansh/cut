import { hash } from "../core/stable";
import type { IRPictureTimeMap } from "./ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";

/**
 * Closed bounds shared by CUT source lowering and strict CutAVIR admission.
 * A compiler-emitted transcript binding or caption consumer must never exceed
 * these values; the strict loader may apply a smaller caller-supplied word
 * limit, but it must not silently accept a larger executable contract.
 */
export const cutTranscriptExecutableLimits = Object.freeze({
  maximumSelectedWords: 4_096,
  maximumSelectedTextBytes: 1024 * 1024,
  minimumCaptionMaxWords: 1,
  maximumCaptionMaxWords: 64,
});

/**
 * JSON.parse can materialize lone UTF-16 surrogates from escaped input even
 * when the byte stream was valid UTF-8. Keep this check shared so interchange
 * and executable IR cannot disagree about which Unicode strings exist.
 */
export function cutTranscriptHasUnpairedUnicodeSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Closed Unicode policy for transcript word and speaker payloads. In
 * addition to lone surrogates, reject controls, bidi formatting/isolate
 * controls, byte-order marks, line separators, and Unicode noncharacters.
 * Ordinary whitespace remains a field-specific rule: it is forbidden in a
 * word but may occur inside a trimmed speaker label.
 */
export function cutTranscriptHasUnsafeUnicodeScalar(value: string) {
  if (cutTranscriptHasUnpairedUnicodeSurrogate(value)) return true;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code <= 0x1f
      || (code >= 0x7f && code <= 0x9f)
      || code === 0x061c
      || code === 0x200e
      || code === 0x200f
      || code === 0x2028
      || code === 0x2029
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x206f)
      || code === 0xfeff
      || (code >= 0xfdd0 && code <= 0xfdef)
      || (code & 0xffff) === 0xfffe
      || (code & 0xffff) === 0xffff
    ) return true;
  }
  return false;
}

export const cutTranscriptMediaAuthorityContract = Object.freeze({
  version: 1 as const,
  policy: "authenticated-affine-audio-to-video-clock-v1" as const,
  maximumStreamIndex: 65_535,
  minimumVideoRate: rational(1, 64),
  maximumVideoRate: rational(64),
});

export type CutTranscriptMediaAuthorityIdentityInput = Readonly<{
  version: 1;
  kind: "transcript-media-authority";
  compositionId: string;
  sceneId: string;
  transcriptResourceId: string;
  audioResourceId: string;
  audioStreamIndex: number;
  videoResourceId: string;
  videoStreamIndex: number;
  videoFrameRate: Rational;
  videoDuration: Rational;
  audioAt: Rational;
  videoAt: Rational;
  videoRate: Rational;
}>;

export type CutTranscriptMediaClockTransform = Readonly<{
  audioAt: Rational;
  videoAt: Rational;
  videoRate: Rational;
  videoDuration: Rational;
}>;

export class CutTranscriptMediaAuthorityError extends Error {
  readonly code = "CUT_TRANSCRIPT_MEDIA_AUTHORITY" as const;

  constructor(message: string) {
    super(`${"CUT_TRANSCRIPT_MEDIA_AUTHORITY"}: ${message}`);
    this.name = "CutTranscriptMediaAuthorityError";
  }
}

function canonicalTranscriptRational(value: Rational, label: string) {
  let canonical: Rational;
  try {
    canonical = rational(value.numerator, value.denominator);
  } catch {
    throw new CutTranscriptMediaAuthorityError(`${label} must be a canonical exact rational.`);
  }
  if (canonical.numerator !== value.numerator || canonical.denominator !== value.denominator) {
    throw new CutTranscriptMediaAuthorityError(`${label} must be a canonical exact rational.`);
  }
  return canonical;
}

function nonNegativeTranscriptRational(value: Rational, label: string) {
  const canonical = canonicalTranscriptRational(value, label);
  if (compareRational(canonical, zeroRational) < 0) {
    throw new CutTranscriptMediaAuthorityError(`${label} must be non-negative.`);
  }
  return canonical;
}

function positiveTranscriptRational(value: Rational, label: string) {
  const canonical = canonicalTranscriptRational(value, label);
  if (compareRational(canonical, zeroRational) <= 0) {
    throw new CutTranscriptMediaAuthorityError(`${label} must be positive.`);
  }
  return canonical;
}

function transcriptAuthorityStreamIndex(value: number, label: string) {
  if (!Number.isSafeInteger(value)
    || value < 0
    || value > cutTranscriptMediaAuthorityContract.maximumStreamIndex) {
    throw new CutTranscriptMediaAuthorityError(
      `${label} must be an integer in [0, ${cutTranscriptMediaAuthorityContract.maximumStreamIndex}].`,
    );
  }
  return value;
}

function transcriptAuthorityId(value: string, label: string) {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CutTranscriptMediaAuthorityError(`${label} must be a non-empty trimmed identifier without control characters.`);
  }
  return value;
}

/**
 * Semantic identity for one authenticated audio-to-video clock authority.
 * Provenance, the compiler-owned record id, and the derived `identity` field
 * are deliberately absent; every semantic field that can alter resource
 * selection or exact clock mapping is bound.
 */
export function cutTranscriptMediaAuthorityIdentity(
  input: CutTranscriptMediaAuthorityIdentityInput,
) {
  const semantic = {
    version: input.version,
    kind: input.kind,
    policy: cutTranscriptMediaAuthorityContract.policy,
    compositionId: transcriptAuthorityId(input.compositionId, "compositionId"),
    sceneId: transcriptAuthorityId(input.sceneId, "sceneId"),
    transcriptResourceId: transcriptAuthorityId(input.transcriptResourceId, "transcriptResourceId"),
    audioResourceId: transcriptAuthorityId(input.audioResourceId, "audioResourceId"),
    audioStreamIndex: transcriptAuthorityStreamIndex(input.audioStreamIndex, "audioStreamIndex"),
    videoResourceId: transcriptAuthorityId(input.videoResourceId, "videoResourceId"),
    videoStreamIndex: transcriptAuthorityStreamIndex(input.videoStreamIndex, "videoStreamIndex"),
    videoFrameRate: positiveTranscriptRational(input.videoFrameRate, "videoFrameRate"),
    videoDuration: positiveTranscriptRational(input.videoDuration, "videoDuration"),
    audioAt: nonNegativeTranscriptRational(input.audioAt, "audioAt"),
    videoAt: nonNegativeTranscriptRational(input.videoAt, "videoAt"),
    videoRate: positiveTranscriptRational(input.videoRate, "videoRate"),
  };
  if (compareRational(
    semantic.videoRate,
    cutTranscriptMediaAuthorityContract.minimumVideoRate,
  ) < 0 || compareRational(
    semantic.videoRate,
    cutTranscriptMediaAuthorityContract.maximumVideoRate,
  ) > 0) {
    throw new CutTranscriptMediaAuthorityError("videoRate must be from 1/64 through 64.");
  }
  if (compareRational(semantic.videoAt, semantic.videoDuration) >= 0) {
    throw new CutTranscriptMediaAuthorityError("videoAt must be strictly earlier than videoDuration.");
  }
  return hash(semantic);
}

/** Map one exact audio-clock time onto the independently authenticated video clock. */
export function cutTranscriptMediaVideoTime(
  audioTime: Rational,
  authority: CutTranscriptMediaClockTransform,
) {
  const input = nonNegativeTranscriptRational(audioTime, "audioTime");
  const audioAt = nonNegativeTranscriptRational(authority.audioAt, "audioAt");
  const videoAt = nonNegativeTranscriptRational(authority.videoAt, "videoAt");
  const videoRate = positiveTranscriptRational(authority.videoRate, "videoRate");
  positiveTranscriptRational(authority.videoDuration, "videoDuration");
  return addRational(videoAt, multiplyRational(subtractRational(input, audioAt), videoRate));
}

/**
 * Map one exact positive audio interval through the authority's affine clock.
 * The complete mapped interval must remain inside the selected video stream.
 */
export function cutTranscriptMediaVideoSourceRange(
  source: Readonly<{ start: Rational; duration: Rational }>,
  authority: CutTranscriptMediaClockTransform,
) {
  const start = nonNegativeTranscriptRational(source.start, "source start");
  const duration = positiveTranscriptRational(source.duration, "source duration");
  const videoDuration = positiveTranscriptRational(authority.videoDuration, "videoDuration");
  const mappedStart = cutTranscriptMediaVideoTime(start, authority);
  const mappedDuration = multiplyRational(
    duration,
    positiveTranscriptRational(authority.videoRate, "videoRate"),
  );
  const mappedEnd = addRational(mappedStart, mappedDuration);
  if (compareRational(mappedStart, zeroRational) < 0) {
    throw new CutTranscriptMediaAuthorityError(
      `audio source range maps to video-local start ${mappedStart.numerator}/${mappedStart.denominator}s before zero.`,
    );
  }
  if (compareRational(mappedEnd, videoDuration) > 0) {
    throw new CutTranscriptMediaAuthorityError(
      `audio source range maps to video-local end ${mappedEnd.numerator}/${mappedEnd.denominator}s beyond videoDuration ${videoDuration.numerator}/${videoDuration.denominator}s.`,
    );
  }
  return Object.freeze({ start: mappedStart, duration: mappedDuration });
}

export const cutTranscriptPictureLineageContract = Object.freeze({
  version: 1 as const,
  originPolicy: "authenticated-transcript-picture-origin-v1" as const,
  segmentPolicy: "authenticated-transcript-picture-segment-v1" as const,
});

export type CutTranscriptPictureOriginIdentityInput = Readonly<{
  transcriptBindingId: string;
  transcriptMediaAuthorityId: string;
  transcriptMediaAuthorityIdentity: string;
  audioResourceId: string;
  pictureResourceId: string;
  mappedSourceRange: Readonly<{ start: Rational; duration: Rational }>;
  destinationRange: Readonly<{ start: Rational; duration: Rational }>;
  timeMap: IRPictureTimeMap;
  linkId?: string;
}>;

export type CutTranscriptPictureSegmentIdentityInput = Readonly<{
  transcriptPictureOriginIdentity: string;
  sourceRange: Readonly<{ start: Rational; duration: Rational }>;
  destinationRange: Readonly<{ start: Rational; duration: Rational }>;
  timeMap: IRPictureTimeMap;
}>;

/**
 * Bind the authenticated authority-backed base PictureClip before ordinary
 * split/trim materialization. The caller supplies the canonical effective time
 * map, including explicit forward one-times, so it always enters identity.
 */
export function cutTranscriptPictureOriginIdentity(
  input: CutTranscriptPictureOriginIdentityInput,
) {
  return hash({
    version: cutTranscriptPictureLineageContract.version,
    policy: cutTranscriptPictureLineageContract.originPolicy,
    transcriptBindingId: input.transcriptBindingId,
    transcriptMediaAuthorityId: input.transcriptMediaAuthorityId,
    transcriptMediaAuthorityIdentity: input.transcriptMediaAuthorityIdentity,
    audioResourceId: input.audioResourceId,
    pictureResourceId: input.pictureResourceId,
    mappedSourceRange: input.mappedSourceRange,
    destinationRange: input.destinationRange,
    timeMap: input.timeMap,
    ...(input.linkId === undefined ? {} : { linkId: input.linkId }),
  });
}

/** Bind one final ordinary picture segment to its authenticated base origin. */
export function cutTranscriptPictureSegmentIdentity(
  input: CutTranscriptPictureSegmentIdentityInput,
) {
  return hash({
    version: cutTranscriptPictureLineageContract.version,
    policy: cutTranscriptPictureLineageContract.segmentPolicy,
    transcriptPictureOriginIdentity: input.transcriptPictureOriginIdentity,
    sourceRange: input.sourceRange,
    destinationRange: input.destinationRange,
    timeMap: input.timeMap,
  });
}

export const cutTranscriptPictureSnapContract = Object.freeze({
  version: 1 as const,
  policy: "cover-intersecting-source-frames-v1" as const,
});

export type CutTranscriptPictureIdentityInput = Readonly<{
  transcriptBindingId: string;
  audioResourceId: string;
  pictureResourceId: string;
  mediaSha256: string;
  videoStreamIndex: number;
  videoFrameRate: Rational;
  videoDuration: Rational;
  /** Nonzero audio anchor minus video anchor; omission is canonical zero. */
  audioVideoPresentationDelta?: Rational;
  sourceRange: Readonly<{ start: Rational; duration: Rational }>;
  destinationStart: Rational;
  pictureRange: Readonly<{
    start: Rational;
    duration: Rational;
    firstFrame: string;
    frameCount: string;
  }>;
  linkId?: string;
}>;

/**
 * Compiler/loader shared identity for the ordinary PictureClip produced by
 * TranscriptPicture. Text is deliberately absent: spelling-only transcript
 * corrections do not change selected pixels, while every timing, media,
 * stream, placement, link, and frame-snap fact does.
 */
export function cutTranscriptPictureIdentity(
  input: CutTranscriptPictureIdentityInput,
) {
  return hash({
    version: cutTranscriptPictureSnapContract.version,
    policy: cutTranscriptPictureSnapContract.policy,
    transcriptBindingId: input.transcriptBindingId,
    audioResourceId: input.audioResourceId,
    pictureResourceId: input.pictureResourceId,
    mediaSha256: input.mediaSha256,
    videoStreamIndex: input.videoStreamIndex,
    videoFrameRate: input.videoFrameRate,
    videoDuration: input.videoDuration,
    ...(input.audioVideoPresentationDelta === undefined
      ? {}
      : {
        audioVideoPresentationDelta: input.audioVideoPresentationDelta,
      }),
    sourceRange: input.sourceRange,
    destinationStart: input.destinationStart,
    pictureRange: input.pictureRange,
    ...(input.linkId === undefined ? {} : { linkId: input.linkId }),
  });
}

export class CutTranscriptPictureSnapError extends Error {
  readonly code = "CUT_TRANSCRIPT_PICTURE_TIME" as const;

  constructor(message: string) {
    super(`${"CUT_TRANSCRIPT_PICTURE_TIME"}: ${message}`);
    this.name = "CutTranscriptPictureSnapError";
  }
}

function floorNonnegative(value: Rational) {
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (numerator < 0n) {
    throw new CutTranscriptPictureSnapError(
      "picture source times must be non-negative before frame snapping.",
    );
  }
  return numerator / denominator;
}

function ceilNonnegative(value: Rational) {
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (numerator < 0n) {
    throw new CutTranscriptPictureSnapError(
      "picture source times must be non-negative before frame snapping.",
    );
  }
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Translate one decoder-audio-local transcript interval onto the
 * decoder-video-local source clock.
 *
 * delta = audio presentation anchor - video presentation anchor, therefore a
 * word at audio-local t belongs at video-local t + delta. TranscriptPicture
 * promises complete picture coverage for the selected spoken range, so this
 * contract refuses rather than intersecting, holding, or inventing frames.
 */
export function cutTranscriptPictureVideoSourceRange(
  source: Readonly<{ start: Rational; duration: Rational }>,
  audioVideoPresentationDelta: Rational,
  videoDuration: Rational,
) {
  const start = addRational(source.start, audioVideoPresentationDelta);
  const end = addRational(start, source.duration);
  if (compareRational(start, zeroRational) < 0) {
    throw new CutTranscriptPictureSnapError(
      `audio-local transcript range maps to video-local start ${start.numerator}/${start.denominator}s before decoded frame zero through audioVideoPresentationDelta ${audioVideoPresentationDelta.numerator}/${audioVideoPresentationDelta.denominator}s.`,
    );
  }
  if (compareRational(end, videoDuration) > 0) {
    throw new CutTranscriptPictureSnapError(
      `audio-local transcript range maps to video-local end ${end.numerator}/${end.denominator}s beyond decoded-video duration ${videoDuration.numerator}/${videoDuration.denominator}s through audioVideoPresentationDelta ${audioVideoPresentationDelta.numerator}/${audioVideoPresentationDelta.denominator}s.`,
    );
  }
  return Object.freeze({ start, duration: source.duration });
}

/**
 * Select the smallest half-open source-frame range that completely contains
 * one exact transcript audio range. The returned boundaries are exact frame
 * boundaries; no floating-point clock conversion or hidden nearest-frame
 * choice is permitted. Because both the leading and trailing partial source
 * frames are retained, covering duration minus exact audio duration is
 * non-negative and strictly less than two frame periods (not one).
 */
export function cutTranscriptPictureCoverRange(
  source: Readonly<{ start: Rational; duration: Rational }>,
  frameRate: Rational,
  mediaDuration: Rational,
) {
  if (compareRational(frameRate, zeroRational) <= 0) {
    throw new CutTranscriptPictureSnapError(
      "video frame rate must be positive.",
    );
  }
  if (compareRational(source.start, zeroRational) < 0
    || compareRational(source.duration, zeroRational) <= 0) {
    throw new CutTranscriptPictureSnapError(
      "transcript source range must have a non-negative start and positive duration.",
    );
  }
  if (compareRational(mediaDuration, zeroRational) <= 0) {
    throw new CutTranscriptPictureSnapError(
      "transcript media duration must be positive.",
    );
  }
  const sourceEnd = addRational(source.start, source.duration);
  if (compareRational(sourceEnd, mediaDuration) > 0) {
    throw new CutTranscriptPictureSnapError(
      "transcript source range exceeds the declared media duration.",
    );
  }
  const firstFrame = floorNonnegative(
    multiplyRational(source.start, frameRate),
  );
  const endFrame = ceilNonnegative(
    multiplyRational(sourceEnd, frameRate),
  );
  if (endFrame <= firstFrame) {
    throw new CutTranscriptPictureSnapError(
      "transcript source range did not select a positive source-frame interval.",
    );
  }
  const start = divideRational(rational(firstFrame), frameRate);
  const end = divideRational(rational(endFrame), frameRate);
  if (compareRational(end, mediaDuration) > 0) {
    throw new CutTranscriptPictureSnapError(
      "the covering source-frame range would extend beyond the declared media duration.",
    );
  }
  return Object.freeze({
    start,
    duration: subtractRational(end, start),
    firstFrame: firstFrame.toString(),
    frameCount: (endFrame - firstFrame).toString(),
    frameRate,
    contract: cutTranscriptPictureSnapContract,
  });
}
