import { hash } from "../../core/stable";

export const referencePictureFrameBlendPhaseUnits = 65_536;

export const referencePictureFrameBlendContract = Object.freeze({
  format: "cut-reference-picture-frame-blend" as const,
  version: 1 as const,
  phase: "exact-source-phase-round-half-up-to-q16" as const,
  interpolation: "associated-alpha-encoded-srgb-round-half-up" as const,
  endpoints: "literal-source-rgba-copy" as const,
  transparent: "fractional-zero-alpha-clears-rgb" as const,
  output: "rgba8-straight" as const,
});

export const referencePictureFrameBlendPolicyIdentity = hash(
  referencePictureFrameBlendContract,
);

export const referencePictureFrameBlendLimits = Object.freeze({
  maximumPixels: 7_680 * 4_320,
  maximumRgbaBytes: 7_680 * 4_320 * 4,
});

export type ReferencePictureFrameBlendSurface = Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
}>;

export type ReferencePictureFrameBlendObservedWork = Readonly<{
  policyIdentity: string;
  phaseQ16: number;
  sourceFramesRead: 1 | 2;
  pixelsCopied: number;
  pixelsBlended: number;
  associatedChannelProducts: number;
  transparentPixelsCanonicalized: number;
  outputRgbaBytes: number;
}>;

export type ReferencePictureFrameBlendResult = Readonly<{
  surface: ReferencePictureFrameBlendSurface;
  observedWork: ReferencePictureFrameBlendObservedWork;
}>;

export class ReferencePictureFrameBlendError extends Error {
  readonly code = "CUT_EDIT_PICTURE_FRAME_BLEND" as const;

  constructor(readonly detail: string) {
    super(`CUT_EDIT_PICTURE_FRAME_BLEND: ${detail}`);
    this.name = "ReferencePictureFrameBlendError";
  }
}

function fail(message: string): never {
  throw new ReferencePictureFrameBlendError(message);
}

function validateSurface(
  value: ReferencePictureFrameBlendSurface,
  label: string,
) {
  if (!value || typeof value !== "object") fail(`${label} must be one RGBA surface.`);
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || value.width < 1 || value.height < 1) {
    fail(`${label} dimensions must be positive safe integers.`);
  }
  const pixels = value.width * value.height;
  if (!Number.isSafeInteger(pixels)
    || pixels > referencePictureFrameBlendLimits.maximumPixels) {
    fail(`${label} exceeds the ${referencePictureFrameBlendLimits.maximumPixels}-pixel frame-blend limit.`);
  }
  const rgbaBytes = pixels * 4;
  if (!Number.isSafeInteger(rgbaBytes)
    || rgbaBytes > referencePictureFrameBlendLimits.maximumRgbaBytes) {
    fail(`${label} exceeds the ${referencePictureFrameBlendLimits.maximumRgbaBytes}-byte frame-blend limit.`);
  }
  if (!(value.data instanceof Uint8Array) || value.data.byteLength !== rgbaBytes) {
    fail(`${label} bytes must equal width × height × 4.`);
  }
  return { pixels, rgbaBytes };
}

function roundedRatio(numerator: number, denominator: number) {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/**
 * Interpolate two decoded straight-RGBA frames under the closed v1 temporal
 * law. Q16 is derived once from the exact source phase by the time-map planner.
 * Integer endpoints copy every byte (including hidden RGB). Fractional samples
 * interpolate encoded-sRGB in associated alpha and clear RGB when alpha rounds
 * to zero, so transparent hidden color cannot leak into visible pixels.
 */
export function blendReferencePictureFrames(
  before: ReferencePictureFrameBlendSurface,
  after: ReferencePictureFrameBlendSurface,
  phaseQ16: number,
): ReferencePictureFrameBlendResult {
  const first = validateSurface(before, "PictureClip frame-blend before surface");
  const second = validateSurface(after, "PictureClip frame-blend after surface");
  if (before.width !== after.width || before.height !== after.height
    || first.rgbaBytes !== second.rgbaBytes) {
    fail("PictureClip frame-blend surfaces must have identical dimensions.");
  }
  if (!Number.isSafeInteger(phaseQ16)
    || phaseQ16 < 0 || phaseQ16 > referencePictureFrameBlendPhaseUnits) {
    fail(`PictureClip frame-blend phase must be an integer from 0 through ${referencePictureFrameBlendPhaseUnits}.`);
  }
  const output = new Uint8Array(first.rgbaBytes);
  if (phaseQ16 === 0 || phaseQ16 === referencePictureFrameBlendPhaseUnits) {
    output.set(phaseQ16 === 0 ? before.data : after.data);
    return Object.freeze({
      surface: Object.freeze({ data: output, width: before.width, height: before.height }),
      observedWork: Object.freeze({
        policyIdentity: referencePictureFrameBlendPolicyIdentity,
        phaseQ16,
        sourceFramesRead: 1 as const,
        pixelsCopied: first.pixels,
        pixelsBlended: 0,
        associatedChannelProducts: 0,
        transparentPixelsCanonicalized: 0,
        outputRgbaBytes: output.byteLength,
      }),
    });
  }

  const inverse = referencePictureFrameBlendPhaseUnits - phaseQ16;
  let transparentPixelsCanonicalized = 0;
  for (let offset = 0; offset < output.byteLength; offset += 4) {
    const beforeAlpha = before.data[offset + 3]!;
    const afterAlpha = after.data[offset + 3]!;
    const alphaNumerator = beforeAlpha * inverse + afterAlpha * phaseQ16;
    const alpha = roundedRatio(alphaNumerator, referencePictureFrameBlendPhaseUnits);
    if (alpha === 0 || alphaNumerator === 0) {
      transparentPixelsCanonicalized += 1;
      continue;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      const channelNumerator = before.data[offset + channel]! * beforeAlpha * inverse
        + after.data[offset + channel]! * afterAlpha * phaseQ16;
      output[offset + channel] = roundedRatio(channelNumerator, alphaNumerator);
    }
    output[offset + 3] = alpha;
  }
  return Object.freeze({
    surface: Object.freeze({ data: output, width: before.width, height: before.height }),
    observedWork: Object.freeze({
      policyIdentity: referencePictureFrameBlendPolicyIdentity,
      phaseQ16,
      sourceFramesRead: 2 as const,
      pixelsCopied: 0,
      pixelsBlended: first.pixels,
      associatedChannelProducts: first.pixels * 8,
      transparentPixelsCanonicalized,
      outputRgbaBytes: output.byteLength,
    }),
  });
}
