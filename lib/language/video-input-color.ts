/**
 * Canonical public input-only color assertions for every video-consuming CUT
 * kernel. Delivery and ColorConvert intentionally use their smaller retained-
 * surface profile set and must not import this list as an output enum.
 */
export const cutVideoInputColorProfiles = [
  "srgb",
  "linear-srgb",
  "rec709-full",
  "rec709-limited",
  "bt470bg-smpte170m-limited",
] as const;

export type CutVideoInputColorProfile = typeof cutVideoInputColorProfiles[number];

/**
 * The deliberately smaller first slice that may be author-interpreted when
 * selected-stream tags are incomplete or known to be wrong.  These profiles
 * all have one closed 8-bit planar-YUV decoder contract.  RGB, linear, HDR,
 * log, ICC and OCIO interpretation remain refused rather than guessed.
 */
export const cutVideoColorInterpretationProfiles = [
  "rec709-full",
  "rec709-limited",
  "bt470bg-smpte170m-limited",
] as const;

export type CutVideoColorInterpretationProfile = typeof cutVideoColorInterpretationProfiles[number];
