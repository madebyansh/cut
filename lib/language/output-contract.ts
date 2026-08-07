import type { IRComposition, IROutput, IRValue } from "./ir";
import { rationalToNumber } from "./rational";
import { referenceColorProfiles, type ReferenceColorProfile } from "../runtime/reference/color-management";

export const cutReferenceVideoCodecs = ["h264"] as const;
export type CutReferenceVideoCodec = typeof cutReferenceVideoCodecs[number];

export type CutOutputContract = {
  width: number;
  height: number;
  codec: CutReferenceVideoCodec;
  /** Omission is the byte-compatible alpha behavior; explicit profiles are managed and tagged. */
  color: ReferenceColorProfile | "legacy";
};

export class CutOutputContractError extends Error {
  constructor(readonly code: string, readonly source: string, message: string) {
    super(`${code} ${source}: ${message}`);
    this.name = "CutOutputContractError";
  }
}

function source(output: IROutput) {
  return `${output.provenance.module}:${output.provenance.span.start.line}:${output.provenance.span.start.column}`;
}

function dimension(output: IROutput, value: IRValue | undefined, name: "width" | "height", fallback: number) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px" || value.magnitude.denominator !== "1") {
    throw new CutOutputContractError("CUT_OUTPUT_TYPE", source(output), `render ${name} must be an exact integer Length in px.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isSafeInteger(result) || result < 1 || result > 4_096) throw new CutOutputContractError("CUT_OUTPUT_BOUNDS", source(output), `render ${name} must be an integer from 1px through 4096px.`);
  return result;
}

/**
 * The 0.4 reference backend has one explicit H.264 delivery profile. Width and
 * height are checked delivery assertions, not hidden resizers: they must match
 * the canonical timeline canvas.
 */
export function validateCutOutputContract(output: IROutput, composition: IRComposition): CutOutputContract {
  if (output.op !== "cut.output.render") throw new CutOutputContractError("CUT_OUTPUT_OP", source(output), `unsupported output operation “${output.op}”.`);
  const accepted = new Set(["width", "height", "codec", "color"]);
  const unknown = Object.keys(output.parameters).filter((name) => !accepted.has(name));
  if (unknown.length) throw new CutOutputContractError("CUT_OUTPUT_UNKNOWN_INPUT", source(output), `unsupported render input(s): ${unknown.join(", ")}.`);
  const width = dimension(output, output.parameters.width, "width", composition.width);
  const height = dimension(output, output.parameters.height, "height", composition.height);
  if (width !== composition.width || height !== composition.height) {
    throw new CutOutputContractError("CUT_OUTPUT_CANVAS_MISMATCH", source(output), `render canvas ${width}x${height} must match timeline “${composition.name}” canvas ${composition.width}x${composition.height}; implicit output resizing is forbidden.`);
  }
  const codecValue = output.parameters.codec;
  const codec = codecValue === undefined ? "h264" : codecValue.kind === "string" && cutReferenceVideoCodecs.includes(codecValue.value as CutReferenceVideoCodec)
    ? codecValue.value as CutReferenceVideoCodec
    : undefined;
  if (!codec) throw new CutOutputContractError("CUT_OUTPUT_CODEC", source(output), `render codec must be one of: ${cutReferenceVideoCodecs.join(", ")}.`);
  const colorValue = output.parameters.color;
  const color = colorValue === undefined ? "legacy" : colorValue.kind === "string" && referenceColorProfiles.includes(colorValue.value as ReferenceColorProfile)
    ? colorValue.value as ReferenceColorProfile
    : undefined;
  if (!color) throw new CutOutputContractError("CUT_OUTPUT_COLOR", source(output), `render color must be one of: ${referenceColorProfiles.join(", ")}. HDR, log, ICC and OCIO delivery profiles are unsupported.`);
  return { width, height, codec, color };
}
