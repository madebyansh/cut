import type { IRValue } from "./ir";
import { compareRational, rational, zeroRational } from "./rational";
import { cutVideoColorInterpretationProfiles, cutVideoInputColorProfiles } from "./video-input-color";

const pictureInputKeys = new Set([
  "source",
  "range",
  "duration",
  "headHandle",
  "tailHandle",
  "playback",
  "rate",
  "fit",
  "inputColor",
  "inputColorInterpretation",
  "opacity",
  "scale",
  "rotation",
  "link",
]);

function stringEntry(value: IRValue | undefined) { return value?.kind === "string" && value.value.length > 0 && value.value.length <= 128; }
function observedColor(value: IRValue | undefined) {
  if (value?.kind !== "object") return false;
  const required = ["pixelFormat", "fieldOrder"], allowed = new Set([...required, "range", "matrix", "transfer", "primaries"]);
  const fields = Object.keys(value.entries);
  return fields.every((field) => allowed.has(field))
    && required.every((field) => Object.hasOwn(value.entries, field) && stringEntry(value.entries[field]))
    && fields.every((field) => stringEntry(value.entries[field]));
}
function colorInterpretation(value: IRValue | undefined) {
  if (value?.kind !== "object") return false;
  const keys = Object.keys(value.entries);
  if (keys.some((key) => key !== "profile" && key !== "master" && key !== "proxy") || !keys.includes("profile") || !keys.includes("master")) return false;
  const profile = value.entries.profile;
  return profile?.kind === "string"
    && (cutVideoColorInterpretationProfiles as readonly string[]).includes(profile.value)
    && observedColor(value.entries.master)
    && (value.entries.proxy === undefined || observedColor(value.entries.proxy));
}

function quantityEquals(value: IRValue | undefined, dimension: string, expected: ReturnType<typeof rational>) {
  return value === undefined
    || (value.kind === "quantity"
      && value.dimension === dimension
      && compareRational(value.magnitude, expected) === 0);
}

/**
 * The bounded v2 ripple planner deliberately accepts only a neutral direct
 * PictureClip. Keep this predicate shared by compilation, strict IR loading,
 * and runtime authorization so no visual treatment is silently discarded or
 * accepted differently at a later entry point.
 */
export function isNeutralLinkedRipplePictureInputs(inputs: Readonly<Record<string, IRValue>>) {
  if (Object.keys(inputs).some((key) => !pictureInputKeys.has(key))) return false;
  if (inputs.source?.kind !== "resource-ref"
    || inputs.range?.kind !== "range"
    || inputs.duration?.kind !== "quantity"
    || inputs.duration.dimension !== "time"
    || inputs.link?.kind !== "string") return false;
  if (inputs.playback !== undefined && (inputs.playback.kind !== "string" || inputs.playback.value !== "normal")) return false;
  if (inputs.fit !== undefined && (inputs.fit.kind !== "string" || inputs.fit.value !== "cover")) return false;
  if (inputs.inputColor !== undefined && (inputs.inputColor.kind !== "string"
    || !(cutVideoInputColorProfiles as readonly string[]).includes(inputs.inputColor.value))) return false;
  if (inputs.inputColor !== undefined && inputs.inputColorInterpretation !== undefined) return false;
  if (inputs.inputColorInterpretation !== undefined && !colorInterpretation(inputs.inputColorInterpretation)) return false;
  return quantityEquals(inputs.headHandle, "time", zeroRational)
    && quantityEquals(inputs.tailHandle, "time", zeroRational)
    && quantityEquals(inputs.rate, "scalar", rational(1))
    && quantityEquals(inputs.opacity, "ratio", rational(1))
    && quantityEquals(inputs.scale, "scalar", rational(1))
    && quantityEquals(inputs.rotation, "angle", zeroRational);
}
