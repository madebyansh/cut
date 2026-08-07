import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import {
  createReferenceRetainedAlphaScaleDiagnostic,
  ReferenceRetainedSurfaceError,
  referenceRetainedAlphaScaleKernelAlgorithmVersion,
  referenceRetainedAlphaScaleDiagnosticSnapshot,
  referenceRetainedSurfaceAlphaSupport,
  referenceRetainedSurfaceAlphaSupportAlgorithmVersion,
  referenceRetainedSurfaceLimits,
  referenceRetainedSurfacePhaseUnits,
  scaleReferenceRetainedSurfaceAlpha,
  translateReferenceRetainedSurface,
  translateReferenceRetainedSurfaceWithinAlphaSupport,
} from "../lib/runtime/reference/retained-surface";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";
import {
  ReferenceVisualRenderer,
  referenceLocalSpaceAlphaBoundedTranslationAlgorithmVersion,
  translateReferenceLocalSpaceSurface,
} from "../lib/runtime/reference/visual";

const canvas = 64;
const rect = "Rect(width: 8px, height: 8px, x: 32px, y: 32px, fill: #c86432)";

function compileSource(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function source(body: string, declarations = "") {
  return `cut 0.4;
project "retained subpixel";
import { Camera2D, ColorGrade, Composite, Group, Mask, Precomp, Rect, Shadow, Stack } from "cut:visual";
${declarations}
timeline main(duration: 1s, fps: 24, width: ${canvas}px, height: ${canvas}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: ${canvas}px, height: ${canvas}px, codec: "h264");`;
}

async function renderFrame(ir: CutAVIR, frame = 0) {
  ir.determinism.semantic = "locked";
  const composition = validateReferenceSession(ir).composition;
  const scene = ir.scenes[composition.sceneIds[0]];
  const root = await mkdtemp(resolve(tmpdir(), "cut-retained-subpixel-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    return Buffer.from((await renderer.sceneFrame(scene, frame, false)).data);
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function renderBody(body: string, declarations = "", frame = 0) {
  return renderFrame(compileSource(source(body, declarations)), frame);
}

function translated(frame: Uint8Array, left: number, top: number) {
  return Buffer.from(translateReferenceRetainedSurface({ data: frame, width: canvas, height: canvas }, canvas, canvas, left, top).data);
}

function frozenRoundedRatio(numerator: number, denominator: number) {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/** Frozen pre-support translation law. This deliberately has no metadata
 * shortcut and remains the byte counterfactual for the optimized path. */
function frozenTranslate(
  surface: Readonly<{ data: Uint8Array; width: number; height: number }>,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
) {
  const quantize = (value: number) => {
    let integer = Math.floor(value);
    let phase = Math.round((value - integer) * referenceRetainedSurfacePhaseUnits);
    if (phase === referenceRetainedSurfacePhaseUnits) {
      integer += 1;
      phase = 0;
    }
    return { integer, phase };
  };
  const horizontal = quantize(left), vertical = quantize(top);
  const output = new Uint8Array(canvasWidth * canvasHeight * 4);
  if (horizontal.phase === 0 && vertical.phase === 0) {
    const sourceLeft = Math.max(0, -horizontal.integer), sourceTop = Math.max(0, -vertical.integer);
    const targetLeft = Math.max(0, horizontal.integer), targetTop = Math.max(0, vertical.integer);
    const copyWidth = Math.min(surface.width - sourceLeft, canvasWidth - targetLeft);
    const copyHeight = Math.min(surface.height - sourceTop, canvasHeight - targetTop);
    if (copyWidth <= 0 || copyHeight <= 0) return output;
    const bytesPerRow = copyWidth * 4;
    for (let row = 0; row < copyHeight; row += 1) {
      const sourceOffset = ((sourceTop + row) * surface.width + sourceLeft) * 4;
      const targetOffset = ((targetTop + row) * canvasWidth + targetLeft) * 4;
      output.set(surface.data.subarray(sourceOffset, sourceOffset + bytesPerRow), targetOffset);
    }
    return output;
  }
  const units = referenceRetainedSurfacePhaseUnits;
  const inverseX = units - horizontal.phase, inverseY = units - vertical.phase;
  const firstX = Math.max(0, horizontal.integer), firstY = Math.max(0, vertical.integer);
  const lastX = Math.min(canvasWidth - 1, horizontal.integer + surface.width - 1 + (horizontal.phase === 0 ? 0 : 1));
  const lastY = Math.min(canvasHeight - 1, vertical.integer + surface.height - 1 + (vertical.phase === 0 ? 0 : 1));
  if (firstX > lastX || firstY > lastY) return output;
  const denominator = units * units;
  for (let destinationY = firstY; destinationY <= lastY; destinationY += 1) {
    const localY = destinationY - vertical.integer;
    const sourceYs = [localY - 1, localY] as const;
    const weightsY = [vertical.phase, inverseY] as const;
    for (let destinationX = firstX; destinationX <= lastX; destinationX += 1) {
      const localX = destinationX - horizontal.integer;
      const sourceXs = [localX - 1, localX] as const;
      const weightsX = [horizontal.phase, inverseX] as const;
      let alphaNumerator = 0, redNumerator = 0, greenNumerator = 0, blueNumerator = 0;
      for (let yIndex = 0; yIndex < 2; yIndex += 1) {
        const sourceY = sourceYs[yIndex], weightY = weightsY[yIndex];
        if (weightY === 0 || sourceY < 0 || sourceY >= surface.height) continue;
        for (let xIndex = 0; xIndex < 2; xIndex += 1) {
          const sourceX = sourceXs[xIndex], weightX = weightsX[xIndex];
          if (weightX === 0 || sourceX < 0 || sourceX >= surface.width) continue;
          const weight = weightX * weightY;
          const sourceOffset = (sourceY * surface.width + sourceX) * 4;
          const alpha = surface.data[sourceOffset + 3];
          if (alpha === 0) continue;
          alphaNumerator += alpha * weight;
          redNumerator += surface.data[sourceOffset] * alpha * weight;
          greenNumerator += surface.data[sourceOffset + 1] * alpha * weight;
          blueNumerator += surface.data[sourceOffset + 2] * alpha * weight;
        }
      }
      const alpha = frozenRoundedRatio(alphaNumerator, denominator);
      if (alpha === 0 || alphaNumerator === 0) continue;
      const destinationOffset = (destinationY * canvasWidth + destinationX) * 4;
      output[destinationOffset] = frozenRoundedRatio(redNumerator, alphaNumerator);
      output[destinationOffset + 1] = frozenRoundedRatio(greenNumerator, alphaNumerator);
      output[destinationOffset + 2] = frozenRoundedRatio(blueNumerator, alphaNumerator);
      output[destinationOffset + 3] = alpha;
    }
  }
  return output;
}

function observedAlphaSupport(data: Uint8Array, width: number, height: number) {
  let left = width, top = height, right = 0, bottom = 0, nonzeroAlphaPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      nonzeroAlphaPixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return nonzeroAlphaPixels === 0
    ? { empty: true, left: 0, top: 0, right: 0, bottom: 0, nonzeroAlphaPixels }
    : { empty: false, left, top, right, bottom, nonzeroAlphaPixels };
}

/** Frozen pre-row-extrema scalar support scan for an integer retained copy. */
function frozenIntegerCopySupport(
  surface: Readonly<{ data: Uint8Array; width: number; height: number }>,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
) {
  const sourceLeft = Math.max(0, -left), sourceTop = Math.max(0, -top);
  const targetLeft = Math.max(0, left), targetTop = Math.max(0, top);
  const copyWidth = Math.min(surface.width - sourceLeft, canvasWidth - targetLeft);
  const copyHeight = Math.min(surface.height - sourceTop, canvasHeight - targetTop);
  if (copyWidth <= 0 || copyHeight <= 0) {
    return {
      empty: true,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      nonzeroAlphaPixels: 0,
      alphaBytesObserved: 0,
      destinationPixelsVisited: 0,
    };
  }
  let supportLeft = canvasWidth, supportTop = canvasHeight;
  let supportRight = 0, supportBottom = 0, nonzeroAlphaPixels = 0;
  for (let sourceY = sourceTop; sourceY < sourceTop + copyHeight; sourceY += 1) {
    for (let sourceX = sourceLeft; sourceX < sourceLeft + copyWidth; sourceX += 1) {
      if (surface.data[(sourceY * surface.width + sourceX) * 4 + 3] === 0) continue;
      const targetX = targetLeft + sourceX - sourceLeft;
      const targetY = targetTop + sourceY - sourceTop;
      nonzeroAlphaPixels += 1;
      supportLeft = Math.min(supportLeft, targetX);
      supportTop = Math.min(supportTop, targetY);
      supportRight = Math.max(supportRight, targetX + 1);
      supportBottom = Math.max(supportBottom, targetY + 1);
    }
  }
  const empty = nonzeroAlphaPixels === 0;
  return {
    empty,
    left: empty ? 0 : supportLeft,
    top: empty ? 0 : supportTop,
    right: empty ? 0 : supportRight,
    bottom: empty ? 0 : supportBottom,
    nonzeroAlphaPixels,
    alphaBytesObserved: copyWidth * copyHeight,
    destinationPixelsVisited: copyWidth * copyHeight,
  };
}

/** Frozen pre-row-copy LocalSpace owner-opacity law. */
function frozenScaleRetainedAlpha(
  surface: Readonly<{ data: Uint8Array; width: number; height: number }>,
  opacity: number,
) {
  if (opacity === 1) return Buffer.from(surface.data);
  const output = Buffer.from(surface.data);
  for (let offset = 0; offset < output.length; offset += 4) {
    const alpha = Math.round(surface.data[offset + 3] * opacity);
    if (alpha === 0) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
      output[offset + 3] = 0;
      continue;
    }
    output[offset + 3] = alpha;
  }
  return output;
}

test("CUT-owned Q16 translation has exact signed half-pixel analytic pixels", () => {
  const pixel = { data: Uint8Array.of(200, 100, 50, 255), width: 1, height: 1 };
  const positive = translateReferenceRetainedSurface(pixel, 5, 1, 2.5, 0).data;
  assert.deepEqual([...positive], [
    0, 0, 0, 0,
    0, 0, 0, 0,
    200, 100, 50, 128,
    200, 100, 50, 128,
    0, 0, 0, 0,
  ]);
  const negative = translateReferenceRetainedSurface(pixel, 5, 1, 1.5, 0).data;
  assert.deepEqual([...negative], [
    0, 0, 0, 0,
    200, 100, 50, 128,
    200, 100, 50, 128,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);

  const quarter = translateReferenceRetainedSurface(pixel, 3, 3, 0.5, 0.5).data;
  const nonzero = Array.from({ length: 9 }, (_, index) => [...quarter.subarray(index * 4, index * 4 + 4)])
    .filter((value) => value[3] !== 0);
  assert.deepEqual(nonzero, [
    [200, 100, 50, 64],
    [200, 100, 50, 64],
    [200, 100, 50, 64],
    [200, 100, 50, 64],
  ]);
});

test("associated interpolation returns straight RGBA and clears hidden RGB", () => {
  const translucent = translateReferenceRetainedSurface(
    { data: Uint8Array.of(200, 100, 50, 128), width: 1, height: 1 },
    2,
    1,
    0.5,
    0,
  ).data;
  assert.deepEqual([...translucent], [200, 100, 50, 64, 200, 100, 50, 64]);

  const hiddenBesideBlue = translateReferenceRetainedSurface(
    { data: Uint8Array.of(255, 0, 0, 0, 0, 0, 255, 255), width: 2, height: 1 },
    3,
    1,
    0.5,
    0,
  ).data;
  assert.deepEqual([...hiddenBesideBlue], [
    0, 0, 0, 0,
    0, 0, 255, 128,
    0, 0, 255, 128,
  ]);

  const integerBypass = translateReferenceRetainedSurface(
    { data: Uint8Array.of(255, 0, 0, 0, 0, 0, 255, 255), width: 2, height: 1 },
    3,
    1,
    1,
    0,
  ).data;
  assert.deepEqual([...integerBypass], [
    0, 0, 0, 0,
    255, 0, 0, 0,
    0, 0, 255, 255,
  ], "integer placement must preserve independent straight hidden RGB byte-for-byte");
});

test("retained translation publishes exact support with frozen integer/fractional byte parity", () => {
  const width = 5, height = 4;
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0, index = 0; offset < data.length; offset += 4, index += 1) {
    data.set([(index * 31) & 255, (index * 73) & 255, (index * 127) & 255, 0], offset);
  }
  data.set([210, 40, 90, 1], (0 * width + 0) * 4);
  data.set([20, 190, 230, 254], (1 * width + 4) * 4);
  data.set([250, 120, 10, 255], (3 * width + 2) * 4);
  const source = { data, width, height };
  const snapshot = Uint8Array.from(data);
  const cases = [
    { left: 1, top: 1 },
    { left: -2, top: -1 },
    { left: 0.5, top: -0.5 },
    { left: 1.25, top: 2.75 },
    { left: 20, top: 20 },
  ] as const;
  for (const placement of cases) {
    const actual = translateReferenceRetainedSurface(source, 7, 6, placement.left, placement.top);
    const frozen = frozenTranslate(source, 7, 6, placement.left, placement.top);
    assert.deepEqual(actual.data, Buffer.from(frozen), `frozen translation bytes at ${placement.left},${placement.top}`);
    const support = referenceRetainedSurfaceAlphaSupport(actual);
    assert.ok(support);
    assert.equal(support.algorithmVersion, referenceRetainedSurfaceAlphaSupportAlgorithmVersion);
    assert.deepEqual(
      {
        empty: support.empty,
        left: support.left,
        top: support.top,
        right: support.right,
        bottom: support.bottom,
        nonzeroAlphaPixels: support.nonzeroAlphaPixels,
      },
      observedAlphaSupport(actual.data, actual.width, actual.height),
      `exact translated support at ${placement.left},${placement.top}`,
    );
    assert.ok(support.alphaBytesObserved >= 0);
    assert.ok(support.destinationPixelsVisited >= 0);
  }
  assert.deepEqual(source.data, snapshot, "translation support derivation must not mutate caller-owned bytes");

  const first = translateReferenceRetainedSurface(source, 9, 8, 2, 2);
  const firstSupport = referenceRetainedSurfaceAlphaSupport(first);
  assert.ok(firstSupport && !firstSupport.empty);
  const propagated = translateReferenceRetainedSurface(first, 12, 10, 1, 1);
  const propagatedSupport = referenceRetainedSurfaceAlphaSupport(propagated);
  assert.equal(propagatedSupport?.derivation, "integer-copy-propagated");
  assert.equal(propagatedSupport?.alphaBytesObserved, 0);
  assert.deepEqual(propagated.data, Buffer.from(frozenTranslate(first, 12, 10, 1, 1)));
  assert.equal(
    referenceRetainedSurfaceAlphaSupport({ ...propagated, data: Buffer.from(propagated.data) }),
    undefined,
    "copied/foreign bytes must not inherit the authoritative support receipt",
  );
});

test("integer retained row-extrema support scan is frozen-law exact for clipped randomized alpha and hidden RGB", () => {
  const width = 37, height = 29;
  const bytes = Buffer.alloc(width * height * 4);
  const boundaryAlpha = [0, 1, 2, 127, 128, 254, 255] as const;
  let state = 0x96e2_a149;
  const randomByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 24;
  };
  for (let offset = 0, pixel = 0; offset < bytes.length; offset += 4, pixel += 1) {
    bytes[offset] = randomByte();
    bytes[offset + 1] = randomByte();
    bytes[offset + 2] = randomByte();
    bytes[offset + 3] = pixel % 11 < boundaryAlpha.length
      ? boundaryAlpha[pixel % boundaryAlpha.length]
      : randomByte();
  }
  const source = { data: bytes, width, height };
  const snapshot = Buffer.from(bytes);
  const canvasWidth = 31, canvasHeight = 23;
  for (const placement of [
    { left: 0, top: 0 },
    { left: 5, top: 3 },
    { left: -7, top: -4 },
    { left: 26, top: 19 },
    { left: -36, top: -28 },
    { left: 80, top: 80 },
  ] as const) {
    const first = translateReferenceRetainedSurface(
      source,
      canvasWidth,
      canvasHeight,
      placement.left,
      placement.top,
    );
    const second = translateReferenceRetainedSurface(
      source,
      canvasWidth,
      canvasHeight,
      placement.left,
      placement.top,
    );
    assert.deepEqual(
      first.data,
      Buffer.from(frozenTranslate(source, canvasWidth, canvasHeight, placement.left, placement.top)),
      `integer copy bytes at ${placement.left},${placement.top}`,
    );
    assert.deepEqual(second.data, first.data, `deterministic copy bytes at ${placement.left},${placement.top}`);
    const support = referenceRetainedSurfaceAlphaSupport(first);
    assert.ok(support);
    const frozenSupport = frozenIntegerCopySupport(
      source,
      canvasWidth,
      canvasHeight,
      placement.left,
      placement.top,
    );
    assert.deepEqual(
      {
        empty: support.empty,
        left: support.left,
        top: support.top,
        right: support.right,
        bottom: support.bottom,
        nonzeroAlphaPixels: support.nonzeroAlphaPixels,
        alphaBytesObserved: support.alphaBytesObserved,
        destinationPixelsVisited: support.destinationPixelsVisited,
      },
      frozenSupport,
      `frozen scalar support/counters at ${placement.left},${placement.top}`,
    );
    assert.equal(
      support.derivation,
      "integer-copy-scan",
      "foreign bytes must remain a scanned authority boundary",
    );
  }

  const retained = translateReferenceRetainedSurface(source, 45, 37, 4, 3);
  const retainedSupport = referenceRetainedSurfaceAlphaSupport(retained);
  assert.ok(retainedSupport && !retainedSupport.empty);
  const cropped = translateReferenceRetainedSurface(retained, 21, 17, -9, -7);
  assert.deepEqual(
    cropped.data,
    Buffer.from(frozenTranslate(retained, 21, 17, -9, -7)),
    "partially clipped authoritative bytes preserve the integer law",
  );
  const croppedSupport = referenceRetainedSurfaceAlphaSupport(cropped);
  assert.ok(croppedSupport);
  assert.deepEqual(
    {
      empty: croppedSupport.empty,
      left: croppedSupport.left,
      top: croppedSupport.top,
      right: croppedSupport.right,
      bottom: croppedSupport.bottom,
      nonzeroAlphaPixels: croppedSupport.nonzeroAlphaPixels,
    },
    observedAlphaSupport(cropped.data, cropped.width, cropped.height),
    "partially clipped authoritative support remains exact",
  );
  const croppedSourceLeft = 9, croppedSourceTop = 7;
  const croppedSourceRight = croppedSourceLeft + 21;
  const croppedSourceBottom = croppedSourceTop + 17;
  const scannedLeft = Math.max(croppedSourceLeft, retainedSupport.left);
  const scannedTop = Math.max(croppedSourceTop, retainedSupport.top);
  const scannedRight = Math.min(croppedSourceRight, retainedSupport.right);
  const scannedBottom = Math.min(croppedSourceBottom, retainedSupport.bottom);
  assert.equal(
    croppedSupport.alphaBytesObserved,
    Math.max(0, scannedRight - scannedLeft) * Math.max(0, scannedBottom - scannedTop),
    "authoritative clipping retains the frozen support-bounded scan counter",
  );
  assert.equal(croppedSupport.destinationPixelsVisited, 21 * 17);
  assert.equal(croppedSupport.derivation, "integer-copy-scan");
  assert.deepEqual(source.data, snapshot, "row-extrema support derivation must not mutate source bytes");
});

test("retained opacity scaling reuses sparse support and preserves the frozen LocalSpace alpha law", () => {
  const source = translateReferenceRetainedSurface(
    {
      data: Uint8Array.of(
        241, 19, 173, 0,
        11, 22, 33, 255,
        99, 88, 77, 1,
        55, 44, 33, 0,
      ),
      width: 4,
      height: 1,
    },
    10,
    4,
    3,
    2,
  );
  const snapshot = Uint8Array.from(source.data);
  const expected = Buffer.from(source.data);
  for (let offset = 0; offset < expected.length; offset += 4) {
    const alpha = Math.round(expected[offset + 3] * 0.5);
    expected[offset + 3] = alpha;
    if (alpha === 0) expected.fill(0, offset, offset + 4);
  }
  const scaled = scaleReferenceRetainedSurfaceAlpha(source, 0.5);
  assert.deepEqual(scaled.data, expected, "sparse support optimization must preserve frozen owner-opacity bytes");
  assert.deepEqual(
    source.data,
    Buffer.from(snapshot),
    "alpha scaling must not mutate cached/shared source bytes",
  );
  const support = referenceRetainedSurfaceAlphaSupport(scaled);
  assert.equal(support?.derivation, "alpha-scale");
  assert.deepEqual(
    support && {
      empty: support.empty,
      left: support.left,
      top: support.top,
      right: support.right,
      bottom: support.bottom,
      nonzeroAlphaPixels: support.nonzeroAlphaPixels,
    },
    observedAlphaSupport(scaled.data, scaled.width, scaled.height),
  );
  assert.ok((support?.alphaBytesObserved ?? Infinity) < scaled.width * scaled.height,
    "known sparse support must bound the alpha work below a full-canvas scan");
  assert.deepEqual(
    scaleReferenceRetainedSurfaceAlpha(source, 0).data,
    Buffer.alloc(source.data.byteLength),
    "zero opacity remains canonical transparent black",
  );
});

test("retained opacity row-copy optimization is frozen-law exact for hidden RGB, boundary alpha, and deterministic randomized bytes", () => {
  const sourceWidth = 17, sourceHeight = 13;
  const sourceBytes = Buffer.alloc(sourceWidth * sourceHeight * 4);
  const alphaBoundaries = [0, 1, 2, 127, 128, 254, 255] as const;
  let state = 0x8db3_41f7;
  const randomByte = () => {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b_3c6d) >>> 0;
    state = Math.imul(state ^ (state >>> 12), 0x297a_2d39) >>> 0;
    state = (state ^ (state >>> 15)) >>> 0;
    return state & 255;
  };
  for (let offset = 0, pixel = 0; offset < sourceBytes.length; offset += 4, pixel += 1) {
    sourceBytes[offset] = randomByte();
    sourceBytes[offset + 1] = randomByte();
    sourceBytes[offset + 2] = randomByte();
    sourceBytes[offset + 3] = alphaBoundaries[pixel % alphaBoundaries.length];
  }
  const foreign = { data: sourceBytes, width: sourceWidth, height: sourceHeight };
  const retained = translateReferenceRetainedSurface(foreign, 31, 23, 7, 5);
  assert.ok(referenceRetainedSurfaceAlphaSupport(retained), "fixture must enter the known-support row-copy path");
  const foreignSnapshot = Buffer.from(foreign.data);
  const retainedSnapshot = Buffer.from(retained.data);

  for (const opacity of [0, 1 / 255, 0.25, 0.5, 127 / 255, 254 / 255, 1] as const) {
    for (const fixture of [foreign, retained] as const) {
      const first = scaleReferenceRetainedSurfaceAlpha(fixture, opacity);
      const second = scaleReferenceRetainedSurfaceAlpha(fixture, opacity);
      const frozen = frozenScaleRetainedAlpha(fixture, opacity);
      assert.deepEqual(first.data, frozen, `frozen opacity bytes at ${opacity}`);
      assert.deepEqual(second.data, frozen, `deterministic repeat bytes at ${opacity}`);
      const support = referenceRetainedSurfaceAlphaSupport(first);
      if (opacity === 1 && fixture === foreign) {
        assert.equal(support, undefined, "identity opacity must not mint authority for caller-owned bytes");
        continue;
      }
      assert.ok(support);
      assert.deepEqual(
        {
          empty: support.empty,
          left: support.left,
          top: support.top,
          right: support.right,
          bottom: support.bottom,
          nonzeroAlphaPixels: support.nonzeroAlphaPixels,
        },
        observedAlphaSupport(first.data, first.width, first.height),
        `exact output support at ${opacity}`,
      );
    }
  }
  assert.deepEqual(foreign.data, foreignSnapshot, "foreign source bytes must remain immutable");
  assert.deepEqual(retained.data, retainedSnapshot, "retained shared bytes must remain immutable");
});

test("retained opacity aligned-word dispatch and scalar fallback preserve the frozen law and exact support", () => {
  const width = 19, height = 11;
  const alignedBytes = Buffer.alloc(width * height * 4);
  assert.equal(
    alignedBytes.byteOffset % Uint32Array.BYTES_PER_ELEMENT,
    0,
    "the aligned fixture must admit a Uint32 view",
  );
  const alphaBoundaries = [0, 1, 254, 255] as const;
  let state = 0x72b4_91e3;
  const randomByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 24) & 255;
  };
  for (let offset = 0, pixel = 0; offset < alignedBytes.length; offset += 4, pixel += 1) {
    alignedBytes[offset] = randomByte();
    alignedBytes[offset + 1] = randomByte();
    alignedBytes[offset + 2] = randomByte();
    alignedBytes[offset + 3] = pixel < alphaBoundaries.length
      ? alphaBoundaries[pixel]
      : randomByte();
  }
  // Preserve noncanonical hidden RGB at alpha zero at every rectangle edge and
  // exercise the exact 1/254/255 boundaries beside randomized intermediates.
  const edgePixels = [
    { x: 0, y: 0, rgba: [241, 19, 173, 0] },
    { x: width - 1, y: 0, rgba: [11, 22, 33, 1] },
    { x: 0, y: height - 1, rgba: [99, 88, 77, 254] },
    { x: width - 1, y: height - 1, rgba: [55, 44, 33, 255] },
  ] as const;
  for (const edge of edgePixels) {
    alignedBytes.set(edge.rgba, (edge.y * width + edge.x) * 4);
  }
  const aligned = { data: alignedBytes, width, height };
  const alignedSnapshot = Buffer.from(alignedBytes);
  const littleEndian = new Uint8Array(new Uint32Array([0x0102_0304]).buffer)[0] === 0x04;
  const observationIdentity = (mode: "automatic" | "forced-scalar") =>
    createHash("sha256").update(
      `${referenceRetainedAlphaScaleKernelAlgorithmVersion};mode=${mode}`,
    ).digest("hex");

  for (const opacity of [1 / 255, 0.125, 0.5, 0.731, 254 / 255] as const) {
    const automaticDiagnostic = createReferenceRetainedAlphaScaleDiagnostic("automatic");
    const scalarDiagnostic = createReferenceRetainedAlphaScaleDiagnostic("forced-scalar");
    const automatic = scaleReferenceRetainedSurfaceAlpha(aligned, opacity, automaticDiagnostic);
    const forcedScalar = scaleReferenceRetainedSurfaceAlpha(aligned, opacity, scalarDiagnostic);
    const repeated = scaleReferenceRetainedSurfaceAlpha(
      aligned,
      opacity,
      createReferenceRetainedAlphaScaleDiagnostic("automatic"),
    );
    const frozen = frozenScaleRetainedAlpha(aligned, opacity);

    assert.deepEqual(automatic.data, frozen, `aligned automatic frozen bytes at ${opacity}`);
    assert.deepEqual(forcedScalar.data, frozen, `forced scalar frozen bytes at ${opacity}`);
    assert.deepEqual(repeated.data, frozen, `aligned deterministic repeat bytes at ${opacity}`);
    assert.notEqual(automatic.data, aligned.data, "nonidentity scaling must allocate independent output bytes");
    assert.notEqual(forcedScalar.data, aligned.data, "forced scalar output must not alias caller bytes");
    assert.deepEqual(
      observedAlphaSupport(automatic.data, width, height),
      observedAlphaSupport(forcedScalar.data, width, height),
      `word/scalar exact support at ${opacity}`,
    );
    assert.deepEqual(
      referenceRetainedSurfaceAlphaSupport(automatic),
      referenceRetainedSurfaceAlphaSupport(repeated),
      `word-path repeat support receipt at ${opacity}`,
    );

    const automaticSnapshot = referenceRetainedAlphaScaleDiagnosticSnapshot(automaticDiagnostic);
    assert.equal(automaticSnapshot.automaticExecutions, 1);
    assert.equal(
      automaticSnapshot.algorithmVersion,
      referenceRetainedAlphaScaleKernelAlgorithmVersion,
    );
    assert.equal(
      automaticSnapshot.observationIdentity,
      observationIdentity("automatic"),
    );
    assert.equal(automaticSnapshot.requests, 1);
    assert.equal(automaticSnapshot.identitySkips, 0);
    assert.equal(automaticSnapshot.zeroOpacityExecutions, 0);
    assert.equal(automaticSnapshot.alignedWordExecutions, littleEndian ? 1 : 0);
    assert.equal(automaticSnapshot.scalarExecutions, littleEndian ? 0 : 1);
    assert.equal(automaticSnapshot.unalignedFallbackExecutions, 0);
    assert.equal(automaticSnapshot.endianFallbackExecutions, littleEndian ? 0 : 1);
    assert.equal(automaticSnapshot.alphaBytesObserved, width * height);
    assert.deepEqual(
      referenceRetainedAlphaScaleDiagnosticSnapshot(scalarDiagnostic),
      {
        format: "cut-reference-retained-alpha-scale-kernel",
        version: 1,
        mode: "forced-scalar",
        algorithmVersion: referenceRetainedAlphaScaleKernelAlgorithmVersion,
        observationIdentity: observationIdentity("forced-scalar"),
        requests: 1,
        identitySkips: 0,
        zeroOpacityExecutions: 0,
        automaticExecutions: 0,
        scalarExecutions: 1,
        alignedWordExecutions: 0,
        unalignedFallbackExecutions: 0,
        endianFallbackExecutions: 0,
        alphaBytesObserved: width * height,
      },
    );
  }
  assert.deepEqual(aligned.data, alignedSnapshot, "aligned word reads must not mutate caller-owned bytes");

  const unalignedBacking = Buffer.alloc(alignedBytes.byteLength + 1);
  const unalignedBytes = unalignedBacking.subarray(1);
  unalignedBytes.set(alignedBytes);
  assert.notEqual(
    unalignedBytes.byteOffset % Uint32Array.BYTES_PER_ELEMENT,
    0,
    "the unaligned fixture must force the scalar fallback",
  );
  const unaligned = { data: unalignedBytes, width, height };
  const unalignedSnapshot = Buffer.from(unalignedBytes);
  const unalignedDiagnostic = createReferenceRetainedAlphaScaleDiagnostic("automatic");
  const unalignedOutput = scaleReferenceRetainedSurfaceAlpha(unaligned, 0.5, unalignedDiagnostic);
  assert.deepEqual(unalignedOutput.data, frozenScaleRetainedAlpha(unaligned, 0.5));
  assert.deepEqual(
    referenceRetainedAlphaScaleDiagnosticSnapshot(unalignedDiagnostic),
    {
      format: "cut-reference-retained-alpha-scale-kernel",
      version: 1,
      mode: "automatic",
      algorithmVersion: referenceRetainedAlphaScaleKernelAlgorithmVersion,
      observationIdentity: observationIdentity("automatic"),
      requests: 1,
      identitySkips: 0,
      zeroOpacityExecutions: 0,
      automaticExecutions: 1,
      scalarExecutions: 1,
      alignedWordExecutions: 0,
      unalignedFallbackExecutions: 1,
      endianFallbackExecutions: littleEndian ? 0 : 1,
      alphaBytesObserved: width * height,
    },
  );
  assert.deepEqual(unaligned.data, unalignedSnapshot, "unaligned fallback must not mutate its source view");

  const onePixel = translateReferenceRetainedSurface(
    { data: Uint8Array.of(201, 71, 19, 1), width: 1, height: 1 },
    13,
    9,
    12,
    8,
  );
  const onePixelSupport = referenceRetainedSurfaceAlphaSupport(onePixel);
  assert.deepEqual(
    onePixelSupport && {
      empty: onePixelSupport.empty,
      left: onePixelSupport.left,
      top: onePixelSupport.top,
      right: onePixelSupport.right,
      bottom: onePixelSupport.bottom,
      nonzeroAlphaPixels: onePixelSupport.nonzeroAlphaPixels,
    },
    { empty: false, left: 12, top: 8, right: 13, bottom: 9, nonzeroAlphaPixels: 1 },
    "the sparse fixture must carry exact one-pixel corner support",
  );
  const sparseDiagnostic = createReferenceRetainedAlphaScaleDiagnostic("automatic");
  const sparse = scaleReferenceRetainedSurfaceAlpha(onePixel, 0.49, sparseDiagnostic);
  assert.deepEqual(sparse.data, frozenScaleRetainedAlpha(onePixel, 0.49));
  assert.deepEqual(sparse.data, Buffer.alloc(sparse.data.byteLength),
    "alpha one rounded through 50% must become canonical transparent black");
  assert.equal(
    referenceRetainedAlphaScaleDiagnosticSnapshot(sparseDiagnostic).alphaBytesObserved,
    1,
    "known one-pixel support must retain sparse work accounting",
  );
  assert.deepEqual(
    referenceRetainedSurfaceAlphaSupport(sparse),
    {
      format: "cut-reference-retained-surface-alpha-support",
      version: 1,
      algorithmVersion: referenceRetainedSurfaceAlphaSupportAlgorithmVersion,
      derivation: "alpha-scale",
      empty: true,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      nonzeroAlphaPixels: 0,
      alphaBytesObserved: 1,
      destinationPixelsVisited: 1,
    },
  );

  const noKernelDiagnostic = createReferenceRetainedAlphaScaleDiagnostic("automatic");
  assert.equal(
    scaleReferenceRetainedSurfaceAlpha(aligned, 1, noKernelDiagnostic),
    aligned,
    "identity opacity preserves the established zero-allocation identity result",
  );
  const zero = scaleReferenceRetainedSurfaceAlpha(aligned, 0, noKernelDiagnostic);
  assert.notEqual(zero.data, aligned.data, "zero opacity must allocate an independent canonical surface");
  assert.deepEqual(zero.data, Buffer.alloc(aligned.data.byteLength));
  assert.deepEqual(
    referenceRetainedAlphaScaleDiagnosticSnapshot(noKernelDiagnostic),
    {
      format: "cut-reference-retained-alpha-scale-kernel",
      version: 1,
      mode: "automatic",
      algorithmVersion: referenceRetainedAlphaScaleKernelAlgorithmVersion,
      observationIdentity: observationIdentity("automatic"),
      requests: 2,
      identitySkips: 1,
      zeroOpacityExecutions: 1,
      automaticExecutions: 0,
      scalarExecutions: 0,
      alignedWordExecutions: 0,
      unalignedFallbackExecutions: 0,
      endianFallbackExecutions: 0,
      alphaBytesObserved: 0,
    },
    "identity and zero-opacity fast paths must not claim a scaling-kernel execution",
  );

  const isolated = scaleReferenceRetainedSurfaceAlpha(aligned, 0.5);
  const beforeMutation = Buffer.from(aligned.data);
  isolated.data[0] ^= 0xff;
  assert.deepEqual(aligned.data, beforeMutation, "caller mutation of an output must not alias the source");
});

test("LocalSpace alpha-bounded fractional translation is frozen-byte exact and integer hidden RGB stays untouched", () => {
  assert.equal(
    referenceLocalSpaceAlphaBoundedTranslationAlgorithmVersion,
    "cut-reference-local-space-alpha-bounded-translation-v2",
  );
  const width = 8, height = 6;
  const bytes = Buffer.alloc(width * height * 4);
  for (let offset = 0, index = 0; offset < bytes.length; offset += 4, index += 1) {
    bytes.set([(index * 43) & 255, (index * 101) & 255, (index * 179) & 255, 0], offset);
  }
  bytes.set([241, 19, 173, 0], 0);
  bytes.set([210, 70, 30, 255], (2 * width + 3) * 4);
  bytes.set([20, 180, 240, 128], (3 * width + 4) * 4);
  const source = { data: bytes, width, height };
  const snapshot = Buffer.from(bytes);

  for (const placement of [{ left: -1.5, top: 0.5 }, { left: 2.25, top: -2.75 }] as const) {
    const actual = translateReferenceLocalSpaceSurface(source, 12, 9, placement.left, placement.top);
    assert.deepEqual(
      actual.data,
      Buffer.from(frozenTranslate(source, 12, 9, placement.left, placement.top)),
      `alpha-bounded fractional bytes at ${placement.left},${placement.top}`,
    );
    const support = referenceRetainedSurfaceAlphaSupport(actual);
    assert.ok(support);
    assert.ok(
      support.destinationPixelsVisited < (width + 1) * (height + 1),
      "the sparse alpha crop must reduce fractional destination visits",
    );
  }

  const integer = translateReferenceLocalSpaceSurface(source, 12, 9, 2, 1);
  assert.deepEqual(integer.data, Buffer.from(frozenTranslate(source, 12, 9, 2, 1)));
  const hiddenSourceOffset = (0 * width + 0) * 4;
  const hiddenDestinationOffset = (1 * 12 + 2) * 4;
  assert.deepEqual(
    [...integer.data.subarray(hiddenDestinationOffset, hiddenDestinationOffset + 4)],
    [...source.data.subarray(hiddenSourceOffset, hiddenSourceOffset + 4)],
    "integer LocalSpace placement must preserve noncanonical hidden RGB",
  );
  const integerSupport = referenceRetainedSurfaceAlphaSupport(integer);
  assert.equal(integerSupport?.derivation, "integer-copy-propagated");
  assert.equal(
    integerSupport?.alphaBytesObserved,
    0,
    "a fully admitted trusted integer placement must propagate exact support without rescanning alpha",
  );
  assert.deepEqual(
    integerSupport && {
      empty: integerSupport.empty,
      left: integerSupport.left,
      top: integerSupport.top,
      right: integerSupport.right,
      bottom: integerSupport.bottom,
      nonzeroAlphaPixels: integerSupport.nonzeroAlphaPixels,
    },
    observedAlphaSupport(integer.data, integer.width, integer.height),
  );

  const clippedInteger = translateReferenceLocalSpaceSurface(source, 4, 6, -4, 0);
  assert.deepEqual(
    clippedInteger.data,
    Buffer.from(frozenTranslate(source, 4, 6, -4, 0)),
    "trusted integer clipping must retain the frozen byte law",
  );
  const clippedIntegerSupport = referenceRetainedSurfaceAlphaSupport(clippedInteger);
  assert.equal(
    clippedIntegerSupport?.derivation,
    "integer-copy-scan",
    "partial trusted-support clipping must scan rather than propagate an inexact count",
  );
  assert.ok(
    (clippedIntegerSupport?.alphaBytesObserved ?? 0) > 0,
    "partial clipping must report its real bounded alpha inspection",
  );
  assert.deepEqual(
    clippedIntegerSupport && {
      empty: clippedIntegerSupport.empty,
      left: clippedIntegerSupport.left,
      top: clippedIntegerSupport.top,
      right: clippedIntegerSupport.right,
      bottom: clippedIntegerSupport.bottom,
      nonzeroAlphaPixels: clippedIntegerSupport.nonzeroAlphaPixels,
    },
    observedAlphaSupport(clippedInteger.data, clippedInteger.width, clippedInteger.height),
  );
  assert.deepEqual(source.data, snapshot, "alpha-bounded placement must not mutate its cached source");

  const changedBytes = Buffer.from(source.data);
  changedBytes[(5 * width + 7) * 4 + 3] = 255;
  const changed = translateReferenceLocalSpaceSurface(
    { data: changedBytes, width, height },
    12,
    9,
    -1.5,
    0.5,
  );
  assert.notDeepEqual(
    changed.data,
    translateReferenceLocalSpaceSurface(source, 12, 9, -1.5, 0.5).data,
    "new source bytes must derive a new alpha crop rather than reuse prior support",
  );
});

test("trusted retained alpha support rejects malformed counts before placement allocation", () => {
  const source = {
    data: Uint8Array.of(
      90, 80, 70, 255,
      61, 51, 41, 0,
    ),
    width: 2,
    height: 1,
  };
  assert.throws(
    () => translateReferenceRetainedSurfaceWithinAlphaSupport(
      source,
      4,
      2,
      1,
      0,
      {
        empty: false,
        left: 0,
        top: 0,
        right: 1,
        bottom: 1,
        nonzeroAlphaPixels: 2,
      },
    ),
    (error: unknown) => error instanceof ReferenceRetainedSurfaceError
      && error.code === "CUT_VISUAL_SUBPIXEL_SURFACE"
      && /exact nonzero-alpha count/.test(error.message),
  );
  assert.throws(
    () => translateReferenceRetainedSurfaceWithinAlphaSupport(
      source,
      4,
      2,
      1,
      0,
      {
        empty: true,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        nonzeroAlphaPixels: 1,
      },
    ),
    (error: unknown) => error instanceof ReferenceRetainedSurfaceError
      && error.code === "CUT_VISUAL_SUBPIXEL_SURFACE"
      && /exact nonzero-alpha count/.test(error.message),
  );
});

test("LocalSpace refreshes alpha-bound authority when one runtime-owned surface wrapper receives new frame bytes", () => {
  const width = 4, height = 3;
  const firstBytes = Buffer.alloc(width * height * 4);
  firstBytes.set([220, 40, 20, 255], 0);
  firstBytes.set([19, 91, 203, 0], (2 * width + 3) * 4);
  const secondBytes = Buffer.alloc(width * height * 4);
  secondBytes.set([17, 211, 93, 0], 0);
  secondBytes.set([30, 150, 240, 192], (2 * width + 3) * 4);
  const firstSnapshot = Buffer.from(firstBytes);
  const secondSnapshot = Buffer.from(secondBytes);
  const wrapper = { data: firstBytes, width, height };

  const first = translateReferenceLocalSpaceSurface(wrapper, 8, 6, 1.5, 0.5);
  assert.deepEqual(first.data, Buffer.from(frozenTranslate(wrapper, 8, 6, 1.5, 0.5)));

  wrapper.data = secondBytes;
  const second = translateReferenceLocalSpaceSurface(wrapper, 8, 6, 1.5, 0.5);
  assert.deepEqual(
    second.data,
    Buffer.from(frozenTranslate(wrapper, 8, 6, 1.5, 0.5)),
    "the same wrapper with new immutable frame bytes must derive fresh alpha-bound authority",
  );
  assert.notDeepEqual(second.data, first.data, "the replacement frame must not reuse the prior frame's support");
  assert.deepEqual(firstBytes, firstSnapshot, "the retired frame bytes remain immutable");
  assert.deepEqual(secondBytes, secondSnapshot, "the current frame bytes remain immutable");
});

test("retained translation rejects malformed surfaces, positions, and work before allocation", () => {
  const pixel = { data: Uint8Array.of(1, 2, 3, 255), width: 1, height: 1 };
  assert.throws(
    () => translateReferenceRetainedSurface({ ...pixel, data: Uint8Array.of(1, 2, 3) }, 1, 1, 0, 0),
    (error: unknown) => error instanceof ReferenceRetainedSurfaceError && error.code === "CUT_VISUAL_SUBPIXEL_SURFACE",
  );
  assert.throws(
    () => translateReferenceRetainedSurface(pixel, 1, 1, Number.NaN, 0),
    (error: unknown) => error instanceof ReferenceRetainedSurfaceError && error.code === "CUT_VISUAL_SUBPIXEL_POSITION",
  );
  assert.throws(
    () => translateReferenceRetainedSurface(pixel, 4_097, 4_097, 0, 0),
    (error: unknown) => error instanceof ReferenceRetainedSurfaceError
      && error.code === "CUT_VISUAL_SUBPIXEL_WORK_LIMIT"
      && error.message.includes(String(referenceRetainedSurfaceLimits.maximumCanvasPixels)),
  );
  assert.throws(
    () => scaleReferenceRetainedSurfaceAlpha(pixel, Number.NaN),
    (error: unknown) => error instanceof ReferenceRetainedSurfaceError
      && error.code === "CUT_VISUAL_SUBPIXEL_SURFACE",
  );
  assert.throws(
    () => scaleReferenceRetainedSurfaceAlpha(
      { data: Uint8Array.of(1, 2, 3, 4), width: referenceRetainedSurfaceLimits.maximumTransformedPixels + 1, height: 1 },
      0.5,
    ),
    (error: unknown) => error instanceof ReferenceRetainedSurfaceError
      && error.code === "CUT_VISUAL_SUBPIXEL_WORK_LIMIT"
      && error.message.includes(String(referenceRetainedSurfaceLimits.maximumTransformedPixels)),
    "alpha work must fail closed before attempting a transformed-size allocation",
  );
});

test("Group, Stack, Composite, Mask, Camera2D, and ColorGrade share exact fractional final placement", async () => {
  const wrappers = [
    (position: string) => `Group(${position}) { ${rect}; }`,
    (position: string) => `Stack(${position}) { ${rect}; Rect(width: 4px, height: 4px, fill: #00ff00); }`,
    (position: string) => `Composite(${position}) { ${rect}; Rect(width: 3px, height: 3px, x: 20px, y: 20px, fill: #0000ff); }`,
    (position: string) => `Mask(${position}) { ${rect}; Rect(width: 64px, height: 64px, x: 32px, y: 32px, fill: #ffffff); }`,
    (position: string) => `Camera2D(${position}) { ${rect}; }`,
    (position: string) => `ColorGrade(${position}${position ? ", " : ""}exposure: 0.5) { ${rect}; }`,
  ];
  for (const wrapper of wrappers) {
    const baseline = await renderBody(wrapper(""));
    const fractional = await renderBody(wrapper("x: 0.5px, y: -0.5px"));
    assert.deepEqual(fractional, translated(baseline, 0.5, -0.5), wrapper("x/y"));
  }
});

test("Precomp and internal component fragments use the same retained sampler", async () => {
  const precompSource = (position: string) => `cut 0.4;
project "subpixel precomp";
import { Precomp, Rect } from "cut:visual";
timeline insert(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene insertScene(duration: 1s) { ${rect}; }
}
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { Precomp(source: insert${position}); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const precompBaseline = await renderFrame(compileSource(precompSource("")));
  const precompFractional = await renderFrame(compileSource(precompSource(", x: -0.5px, y: 0.5px")));
  assert.deepEqual(precompFractional, translated(precompBaseline, -0.5, 0.5));

  const declarations = `component Tile() -> Visual { ${rect}; }`;
  const fragmentBaseline = await renderBody("Tile();", declarations);
  const fragmentFractional = await renderBody("Tile() as tile; set tile.x = 0.5px; set tile.y = -0.5px;", declarations);
  assert.deepEqual(fragmentFractional, translated(fragmentBaseline, 0.5, -0.5));
});

test("fractional Group anchors transform the pivot with the opposite signed translation", async () => {
  const baseline = await renderBody(`Group() { ${rect}; }`);
  const anchored = await renderBody(`Group(anchorX: 0.5px, anchorY: -0.5px) { ${rect}; }`);
  assert.deepEqual(anchored, translated(baseline, -0.5, 0.5));

  const reverse = await renderBody(`Group(anchorX: -0.5px, anchorY: 0.5px) { ${rect}; }`);
  assert.deepEqual(reverse, translated(baseline, 0.5, -0.5));
});

test("fractional animation samples and effect order remain deterministic", async () => {
  const baseline = await renderBody(`Group() { Shadow(x: 2px, y: 1px, radius: 1px, color: #000000, opacity: 75%) { ${rect}; } }`);
  const movedEffect = await renderBody(`Group(x: 0.5px, y: -0.5px) { Shadow(x: 2px, y: 1px, radius: 1px, color: #000000, opacity: 75%) { ${rect}; } }`);
  assert.deepEqual(movedEffect, translated(baseline, 0.5, -0.5), "the completed effect surface must move as one retained result");

  const moving = compileSource(source(`Group() as layer { ${rect}; } animate layer.x from -0.5px to 0.5px over 2f;`));
  const [first, middle, last] = await Promise.all([0, 1, 2].map((frame) => renderFrame(structuredClone(moving), frame)));
  const still = await renderBody(`Group() { ${rect}; }`);
  assert.deepEqual(first, translated(still, -0.5, 0));
  assert.deepEqual(middle, still);
  assert.deepEqual(last, translated(still, 0.5, 0));
});

test("hostile loaded IR keeps source-located visual bounds while valid fractions execute", async () => {
  const valid = compileSource(source(`Group(x: 0.5px, y: -0.5px) { ${rect}; }`));
  const validGroup = Object.values(valid.nodes).find((candidate) => candidate.op === "cut.visual.group");
  assert.ok(validGroup);
  assert.deepEqual(validGroup.inputs.x, { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(1, 2) });
  assert.deepEqual(validGroup.inputs.y, { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(-1, 2) });
  valid.determinism.semantic = "locked";
  assert.doesNotThrow(() => validateReferenceSession(loadCutAvIr(JSON.stringify(valid))));
  assert.ok((await renderFrame(valid)).some((byte) => byte !== 0));

  const hostile = compileSource(source(`Group(x: 0.5px) { ${rect}; }`));
  const group = Object.values(hostile.nodes).find((candidate) => candidate.op === "cut.visual.group");
  assert.ok(group);
  group.inputs.x = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(65_537) };
  hostile.determinism.semantic = "locked";
  finalizeGraphHashes(hostile);
  const loaded = loadCutAvIr(JSON.stringify(hostile));
  assert.throws(() => validateReferenceSession(loaded), (error: unknown) => {
    assert.ok(error instanceof ReferenceVisualConfigError, String(error));
    assert.equal(error.code, "CUT_VISUAL_VALUE_RANGE");
    assert.match(error.message, /project\.cut:\d+:\d+.*input “x”/);
    return true;
  });
});

test("fractional position identity invalidates only its dependent node and scene", () => {
  const cacheSource = (position: string) => `cut 0.4;
project "subpixel cache locality";
import { Group, Rect } from "cut:visual";
timeline main(duration: 2s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene changed(duration: 1s) { Group(${position}) { ${rect}; } }
  scene stable(duration: 1s) { Rect(width: 6px, height: 6px, x: 16px, y: 16px, fill: #00ff00); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const before = compileSource(cacheSource("x: 0px"));
  const after = compileSource(cacheSource("x: 0.5px"));
  const first = createIncrementalRenderPlan(before, before.compositions[0].id);
  const second = createIncrementalRenderPlan(after, after.compositions[0].id, first.manifest);
  const scenes = Object.fromEntries(second.scenes.map((item) => [after.scenes[item.id].name, item.status]));
  assert.deepEqual(scenes, { changed: "miss", stable: "hit" });
  const group = Object.values(after.nodes).find((candidate) => candidate.op === "cut.visual.group");
  assert.ok(group);
  assert.equal(second.nodes.find((item) => item.id === group.id)?.status, "miss");
  const stableRect = Object.values(after.nodes).find((candidate) => after.scenes[candidate.sceneId ?? ""]?.name === "stable");
  assert.ok(stableRect);
  assert.equal(second.nodes.find((item) => item.id === stableRect.id)?.status, "hit");
});
