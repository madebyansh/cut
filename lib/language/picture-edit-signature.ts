import { cutVideoInputColorProfiles } from "./video-input-color";

/**
 * Canonical public parameter order for picture-only editorial clips.
 *
 * The compiler's operation-value lowerer and the package manifest must share
 * this source of truth: inserting an optional argument into either positional
 * table would silently reinterpret valid pre-extension CUT source.
 */
const commonPictureClipParameters = [
  { name: "source", type: "VideoAsset" },
  { name: "range", type: "Range<Time>" },
  { name: "duration", type: "Time" },
  { name: "headHandle", type: "Time", optional: true },
  { name: "tailHandle", type: "Time", optional: true },
  { name: "playback", type: "String", optional: true, values: ["normal", "reverse", "freeze"] },
  { name: "rate", type: "Number", optional: true },
  { name: "freezeAt", type: "Time", optional: true },
  { name: "speedRamp", type: "List<PictureSpeedPoint>", optional: true },
  { name: "fit", type: "String", optional: true, values: ["cover", "contain", "fill"] },
  { name: "opacity", type: "Ratio", optional: true },
  { name: "scale", type: "Number", optional: true },
  { name: "rotation", type: "Angle", optional: true },
] as const;

export const editClipPackageParameters = [
  ...commonPictureClipParameters,
  { name: "inputColor", type: "String", optional: true, values: cutVideoInputColorProfiles },
  { name: "inputColorInterpretation", type: "VideoColorInterpretation", optional: true },
  // Append-only: existing positional inputColor arguments must not move.
  { name: "frameSelection", type: "String", optional: true, values: ["floor", "nearest", "frame-blend", "optical-flow"] },
] as const;

export const pictureClipPackageParameters = [
  ...commonPictureClipParameters,
  { name: "link", type: "String", optional: true },
  { name: "inputColor", type: "String", optional: true, values: cutVideoInputColorProfiles },
  { name: "inputColorInterpretation", type: "VideoColorInterpretation", optional: true },
  // Append-only: link/input-color positional spellings retain their ABI.
  { name: "frameSelection", type: "String", optional: true, values: ["floor", "nearest", "frame-blend", "optical-flow"] },
] as const;

export const editClipParameterNames = editClipPackageParameters.map((parameter) => parameter.name);
