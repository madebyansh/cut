import {
  ReferenceProjectiveWarpError,
  referenceProjectiveWarpLimits,
  type ReferenceProjectiveWarpResult,
} from "./projective-warp-kernel";

export const referenceProjectiveWarpCanvasAlgorithmVersion = "cut-reference-projective-warp-canvas-v1";

export type ReferenceProjectiveWarpCanvasResult = Readonly<{
  surface: Readonly<{ data: Uint8Array; width: number; height: number; alphaMode: "straight" }>;
  copy: Readonly<{
    sourceOriginX: number;
    sourceOriginY: number;
    clippedLeft: number;
    clippedTop: number;
    clippedRight: number;
    clippedBottom: number;
    coveredPixels: number;
    copiedPixels: number;
    copiedRgbaBytes: number;
    opacityScaledPixels: number;
  }>;
}>;

function fail(message: string): never {
  throw new ReferenceProjectiveWarpError("CUT_PROJECTIVE_WARP_SURFACE", message);
}

function canvasDimension(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > referenceProjectiveWarpLimits.maximumDestinationAxis) {
    fail(`${label} must be a positive safe integer no greater than ${referenceProjectiveWarpLimits.maximumDestinationAxis}.`);
  }
  return value;
}

/**
 * Copy one tight straight-alpha projective result into a composition canvas.
 * The kernel's integer origin is authoritative, negative/off-canvas bounds are
 * clipped, and zero post-opacity alpha clears hidden RGB deterministically.
 */
export function placeReferenceProjectiveWarpOnCanvas(
  warp: ReferenceProjectiveWarpResult,
  canvasWidth: number,
  canvasHeight: number,
  opacity: number,
): ReferenceProjectiveWarpCanvasResult {
  const width = canvasDimension(canvasWidth, "canvas width"), height = canvasDimension(canvasHeight, "canvas height");
  const canvasPixels = width * height;
  if (!Number.isSafeInteger(canvasPixels) || canvasPixels > referenceProjectiveWarpLimits.maximumDestinationPixels) {
    fail(`canvas exceeds ${referenceProjectiveWarpLimits.maximumDestinationPixels} pixels.`);
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) fail("opacity must be finite and between 0 and 1.");

  const source = warp?.surface;
  if (!source || source.alphaMode !== "straight") fail("projective result must expose one straight-alpha surface.");
  canvasDimension(source.width, "projective surface width");
  canvasDimension(source.height, "projective surface height");
  if (!Number.isSafeInteger(source.originX) || !Number.isSafeInteger(source.originY)
    || Math.abs(source.originX) > referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate
    || Math.abs(source.originY) > referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate) {
    fail("projective surface origin must be a bounded safe integer coordinate.");
  }
  const expectedBytes = source.width * source.height * 4;
  if (!Number.isSafeInteger(expectedBytes) || source.data.byteLength !== expectedBytes) {
    fail(`projective surface byte length ${source.data.byteLength} does not match ${source.width}x${source.height} straight RGBA8.`);
  }

  const left = Math.max(0, source.originX), top = Math.max(0, source.originY);
  const right = Math.min(width, source.originX + source.width), bottom = Math.min(height, source.originY + source.height);
  const clippedRight = Math.max(left, right), clippedBottom = Math.max(top, bottom);
  const coveredPixels = (clippedRight - left) * (clippedBottom - top);
  let copiedPixels = 0, opacityScaledPixels = 0;
  const output = new Uint8Array(canvasPixels * 4);
  if (coveredPixels > 0 && opacity > 0) {
    for (let destinationY = top; destinationY < clippedBottom; destinationY += 1) {
      const sourceY = destinationY - source.originY;
      for (let destinationX = left; destinationX < clippedRight; destinationX += 1) {
        const sourceX = destinationX - source.originX;
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const destinationOffset = (destinationY * width + destinationX) * 4;
        const alpha = opacity === 1 ? source.data[sourceOffset + 3]! : Math.round(source.data[sourceOffset + 3]! * opacity);
        if (alpha === 0) continue;
        copiedPixels += 1;
        if (opacity < 1) opacityScaledPixels += 1;
        output[destinationOffset] = source.data[sourceOffset]!;
        output[destinationOffset + 1] = source.data[sourceOffset + 1]!;
        output[destinationOffset + 2] = source.data[sourceOffset + 2]!;
        output[destinationOffset + 3] = alpha;
      }
    }
  }
  return Object.freeze({
    surface: Object.freeze({ data: output, width, height, alphaMode: "straight" as const }),
    copy: Object.freeze({
      sourceOriginX: source.originX,
      sourceOriginY: source.originY,
      clippedLeft: left,
      clippedTop: top,
      clippedRight,
      clippedBottom,
      coveredPixels,
      copiedPixels,
      copiedRgbaBytes: copiedPixels * 4,
      opacityScaledPixels,
    }),
  });
}
