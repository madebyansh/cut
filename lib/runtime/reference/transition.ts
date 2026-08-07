import type { RgbaAlphaMode, RgbaSurface } from "./compositing";

export const referencePictureTransitionKinds = ["cross-dissolve", "dip", "wipe", "push", "slide"] as const;
export const referencePictureTransitionDirections = ["left", "right", "up", "down"] as const;

export type ReferencePictureTransitionKind = typeof referencePictureTransitionKinds[number];
export type ReferencePictureTransitionDirection = typeof referencePictureTransitionDirections[number];
export type ReferenceTransitionColor = readonly [red: number, green: number, blue: number, alpha: number];

export type ReferencePictureTransition = Readonly<{
  kind: ReferencePictureTransitionKind;
  direction: ReferencePictureTransitionDirection;
  /** Soft-edge width as a normalized fraction of the transition axis. */
  softness: number;
  dipColor: ReferenceTransitionColor;
}>;

export type ReferenceTransitionSurface = {
  data: Uint8Array;
  width: number;
  height: number;
  alphaMode: "straight";
};

const clampUnit = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value;
const byte = (value: number) => Math.round(clampUnit(value) * 255);
const srgbToLinearBytes = Float64Array.from({ length: 256 }, (_, value) => {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});

function linearToSrgb(value: number) {
  const linear = clampUnit(value);
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}

function validateSurface(surface: RgbaSurface, label: string): RgbaAlphaMode {
  if (!surface || typeof surface !== "object") throw new Error(`${label} must be an RGBA surface.`);
  if (!Number.isSafeInteger(surface.width) || !Number.isSafeInteger(surface.height) || surface.width < 1 || surface.height < 1) {
    throw new Error(`${label} dimensions must be positive safe integers.`);
  }
  const pixels = surface.width * surface.height;
  if (!Number.isSafeInteger(pixels) || pixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)) throw new Error(`${label} dimensions exceed the RGBA addressable range.`);
  if (!(surface.data instanceof Uint8Array) || surface.data.byteLength !== pixels * 4) throw new Error(`${label} buffer length must equal width x height x 4.`);
  const alphaMode = surface.alphaMode ?? "straight";
  if (alphaMode !== "straight" && alphaMode !== "premultiplied") throw new Error(`${label} alpha mode is unsupported.`);
  return alphaMode;
}

function validateColor(color: ReferenceTransitionColor) {
  if (!Array.isArray(color) || color.length !== 4 || color.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 1)) {
    throw new Error("CUT transition dip color must contain four finite normalized RGBA channels.");
  }
}

function decodePixel(surface: RgbaSurface, mode: RgbaAlphaMode, offset: number) {
  const alpha = surface.data[offset + 3] / 255;
  const channels: [number, number, number] = [0, 1, 2].map((channel) => {
    if (mode === "straight") return srgbToLinearBytes[surface.data[offset + channel]];
    if (alpha <= 0) return 0;
    const straightEncoded = clampUnit((surface.data[offset + channel] / 255) / alpha);
    return straightEncoded <= 0.04045 ? straightEncoded / 12.92 : ((straightEncoded + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return { alpha, channels };
}

function writeMixedPixel(
  output: Uint8Array,
  offset: number,
  outgoing: ReturnType<typeof decodePixel>,
  incoming: ReturnType<typeof decodePixel>,
  amount: number,
) {
  const mix = clampUnit(amount), inverse = 1 - mix;
  const alpha = outgoing.alpha * inverse + incoming.alpha * mix;
  for (let channel = 0; channel < 3; channel += 1) {
    const premultiplied = outgoing.channels[channel] * outgoing.alpha * inverse + incoming.channels[channel] * incoming.alpha * mix;
    const linear = alpha > 0 ? premultiplied / alpha : 0;
    output[offset + channel] = byte(linearToSrgb(linear));
  }
  output[offset + 3] = byte(alpha);
}

function solidPixel(color: ReferenceTransitionColor) {
  return {
    alpha: color[3],
    channels: [0, 1, 2].map((channel) => {
      const encoded = color[channel];
      return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number],
  };
}

function axisDistance(x: number, y: number, width: number, height: number, direction: ReferencePictureTransitionDirection) {
  if (direction === "left") return width === 1 ? 0 : (width - 1 - x) / (width - 1);
  if (direction === "right") return width === 1 ? 0 : x / (width - 1);
  if (direction === "up") return height === 1 ? 0 : (height - 1 - y) / (height - 1);
  return height === 1 ? 0 : y / (height - 1);
}

function wipeCoverage(distance: number, progress: number, softness: number) {
  if (softness <= 0) return progress >= distance ? 1 : 0;
  // Move the feather completely from outside the incoming edge to outside
  // the outgoing edge. This keeps p=0 and p=1 continuous rather than jumping
  // the first/last cell to a half mix for every positive softness.
  const edge = (progress * (1 + softness) - distance) / softness;
  const value = clampUnit(edge);
  return value * value * (3 - 2 * value);
}

function shiftedSource(
  x: number,
  y: number,
  width: number,
  height: number,
  direction: ReferencePictureTransitionDirection,
  distance: number,
) {
  if (direction === "left") return { x: x + distance, y };
  if (direction === "right") return { x: x - distance, y };
  if (direction === "up") return { x, y: y + distance };
  return { x, y: y - distance };
}

function sampledPixel(surface: RgbaSurface, mode: RgbaAlphaMode, x: number, y: number) {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return { alpha: 0, channels: [0, 0, 0] as [number, number, number] };
  return decodePixel(surface, mode, (y * surface.width + x) * 4);
}

/**
 * Execute one deterministic picture-transition frame in premultiplied
 * linear-light sRGB and return straight-alpha RGBA bytes.
 *
 * Direction names describe the incoming layer's travel direction. For
 * example, `left` enters from the right edge and moves left.
 */
export function applyReferencePictureTransition(
  outgoingSurface: RgbaSurface,
  incomingSurface: RgbaSurface,
  transition: ReferencePictureTransition,
  authoredProgress: number,
): ReferenceTransitionSurface {
  const outgoingMode = validateSurface(outgoingSurface, "CUT transition outgoing surface");
  const incomingMode = validateSurface(incomingSurface, "CUT transition incoming surface");
  if (outgoingSurface.width !== incomingSurface.width || outgoingSurface.height !== incomingSurface.height) {
    throw new Error("CUT transition surfaces must have identical dimensions.");
  }
  if (!referencePictureTransitionKinds.includes(transition.kind)) throw new Error(`Unsupported CUT picture transition kind “${String(transition.kind)}”.`);
  if (!referencePictureTransitionDirections.includes(transition.direction)) throw new Error(`Unsupported CUT picture transition direction “${String(transition.direction)}”.`);
  if (!Number.isFinite(transition.softness) || transition.softness < 0 || transition.softness > 1) throw new Error("CUT transition softness must be in [0, 1].");
  if (!Number.isFinite(authoredProgress)) throw new Error("CUT transition progress must be finite.");
  validateColor(transition.dipColor);

  const progress = clampUnit(authoredProgress), width = outgoingSurface.width, height = outgoingSurface.height;
  const output = new Uint8Array(outgoingSurface.data.byteLength), dip = solidPixel(transition.dipColor);
  const axisLength = transition.direction === "left" || transition.direction === "right" ? width : height;
  const travel = Math.round((1 - progress) * axisLength);
  // Derive the outgoing displacement from the quantized incoming one. Two
  // independent round() calls can sum to axisLength +/- 1 on odd canvases,
  // creating a transparent seam or duplicated column in a push.
  const outgoingTravel = axisLength - travel;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const outgoing = decodePixel(outgoingSurface, outgoingMode, offset);
      const incoming = decodePixel(incomingSurface, incomingMode, offset);
      // Every transition kind shares literal source endpoints. Besides being
      // editorially unsurprising, this prevents a hard wipe's first edge cell
      // or a soft wipe's feather from leaking into progress 0/1.
      if (progress === 0) writeMixedPixel(output, offset, outgoing, incoming, 0);
      else if (progress === 1) writeMixedPixel(output, offset, outgoing, incoming, 1);
      else if (transition.kind === "cross-dissolve") writeMixedPixel(output, offset, outgoing, incoming, progress);
      else if (transition.kind === "dip") {
        if (progress < .5) writeMixedPixel(output, offset, outgoing, dip, progress * 2);
        else writeMixedPixel(output, offset, dip, incoming, (progress - .5) * 2);
      } else if (transition.kind === "wipe") {
        const distance = axisDistance(x, y, width, height, transition.direction);
        writeMixedPixel(output, offset, outgoing, incoming, wipeCoverage(distance, progress, transition.softness));
      } else if (transition.kind === "slide") {
        const source = shiftedSource(x, y, width, height, transition.direction, -travel);
        const overlay = sampledPixel(incomingSurface, incomingMode, source.x, source.y);
        // The incoming slide is source-over. Because professional picture
        // clips are normally opaque this is also the expected straight copy;
        // alpha material remains correctly composited over the outgoing clip.
        const coverage = overlay.alpha;
        const opaqueOverlay = coverage > 0 ? { alpha: 1, channels: overlay.channels } : overlay;
        writeMixedPixel(output, offset, outgoing, opaqueOverlay, coverage);
      } else {
        const outgoingSource = shiftedSource(x, y, width, height, transition.direction, outgoingTravel);
        const incomingSource = shiftedSource(x, y, width, height, transition.direction, -travel);
        const shiftedOutgoing = sampledPixel(outgoingSurface, outgoingMode, outgoingSource.x, outgoingSource.y);
        const shiftedIncoming = sampledPixel(incomingSurface, incomingMode, incomingSource.x, incomingSource.y);
        const coverage = shiftedIncoming.alpha;
        const opaqueIncoming = coverage > 0 ? { alpha: 1, channels: shiftedIncoming.channels } : shiftedIncoming;
        writeMixedPixel(output, offset, shiftedOutgoing, opaqueIncoming, coverage);
      }
    }
  }

  return { data: output, width, height, alphaMode: "straight" };
}
