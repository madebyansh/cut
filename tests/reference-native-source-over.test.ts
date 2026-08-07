import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  compositeRgbaIntoReferencePrivateStraightAccumulator,
  createReferencePrivateStraightRgbaAccumulator,
  createReferencePrivateStraightRgbaCompositeDiagnostic,
  deriveReferencePrivateRgbaSourceAlphaBounds,
  referencePrivateStraightRgbaCompositeDiagnosticSnapshot,
  type RgbaBlendMode,
} from "../lib/runtime/reference/compositing";
import {
  executeReferenceNativeRetainedMediaViewportRaster,
  referenceNativeSourceOverIdentity,
  verifyReferenceNativeSourceOverBinaryForTest,
} from "../lib/runtime/reference/native-source-over";

function retainedRasterControl(input: Readonly<{
  source: Uint8Array;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  affine: Readonly<{ tx: number; ty: number }>;
  inverse: Readonly<{ a: number; b: number; c: number; d: number }>;
  opacity: number;
}>) {
  const output = new Uint8Array(input.outputWidth * input.outputHeight * 4);
  const clampRound = (value: number) => Math.round(Math.max(0, Math.min(255, value)));
  const units = 65_536;
  for (let y = input.bounds.top; y < input.bounds.bottom; y += 1) {
    for (let x = input.bounds.left; x < input.bounds.right; x += 1) {
      const dx = x - input.affine.tx, dy = y - input.affine.ty;
      const sxQ = Math.round((input.inverse.a * dx + input.inverse.c * dy) * units);
      const syQ = Math.round((input.inverse.b * dx + input.inverse.d * dy) * units);
      const x0 = Math.floor(sxQ / units), y0 = Math.floor(syQ / units);
      const fx = sxQ - x0 * units, fy = syQ - y0 * units;
      const taps = [
        [(units - fx) * (units - fy), x0, y0],
        [fx * (units - fy), x0 + 1, y0],
        [(units - fx) * fy, x0, y0 + 1],
        [fx * fy, x0 + 1, y0 + 1],
      ] as const;
      let alpha = 0, red = 0, green = 0, blue = 0;
      for (const [weightQ, sampleX, sampleY] of taps) {
        if (weightQ === 0 || sampleX < 0 || sampleY < 0
          || sampleX >= input.sourceWidth || sampleY >= input.sourceHeight) continue;
        const weight = weightQ / units ** 2;
        const offset = (sampleY * input.sourceWidth + sampleX) * 4;
        const sourceAlpha = input.source[offset + 3]!;
        alpha += sourceAlpha * weight;
        red += input.source[offset]! * sourceAlpha * weight;
        green += input.source[offset + 1]! * sourceAlpha * weight;
        blue += input.source[offset + 2]! * sourceAlpha * weight;
      }
      const scaledAlpha = clampRound(alpha * input.opacity);
      if (scaledAlpha === 0 || alpha <= 0) continue;
      const destination = (y * input.outputWidth + x) * 4;
      output[destination] = clampRound(red / alpha);
      output[destination + 1] = clampRound(green / alpha);
      output[destination + 2] = clampRound(blue / alpha);
      output[destination + 3] = scaledAlpha;
    }
  }
  return output;
}

function fixtures(width: number, height: number) {
  let state = 0x9e3779b9;
  const nextByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 255;
  };
  const alpha = [0, 1, 63, 127, 128, 191, 254, 255];
  return Array.from({ length: 4 }, (_, layer) => {
    const data = new Uint8Array(width * height * 4);
    for (let offset = 0, pixel = 0; offset < data.length; offset += 4, pixel += 1) {
      data[offset] = nextByte();
      data[offset + 1] = nextByte();
      data[offset + 2] = nextByte();
      data[offset + 3] = (pixel + layer) % 5 === 0
        ? alpha[(pixel + layer) % alpha.length]!
        : nextByte();
    }
    return Object.freeze({ data, width, height });
  });
}

function compose(
  layers: ReturnType<typeof fixtures>,
  mode: "automatic" | "forced-js-fast" | "forced-scalar",
  blend: RgbaBlendMode = "normal",
) {
  const diagnostic = createReferencePrivateStraightRgbaCompositeDiagnostic(mode);
  const accumulator = createReferencePrivateStraightRgbaAccumulator(layers[0]!.width, layers[0]!.height);
  for (const layer of layers) {
    compositeRgbaIntoReferencePrivateStraightAccumulator(
      accumulator,
      layer,
      deriveReferencePrivateRgbaSourceAlphaBounds(layer),
      { mode: blend, diagnostic },
    );
  }
  return Object.freeze({
    bytes: Buffer.from(accumulator.data),
    counters: referencePrivateStraightRgbaCompositeDiagnosticSnapshot(diagnostic),
  });
}

test("authenticated native normal source-over is byte-identical to the JS-fast and scalar laws", () => {
  const layers = fixtures(97, 53);
  const native = compose(layers, "automatic");
  const js = compose(layers, "forced-js-fast");
  const scalar = compose(layers, "forced-scalar");
  assert.deepEqual(native.bytes, js.bytes);
  assert.deepEqual(native.bytes, scalar.bytes);
  assert.equal(native.counters.executions, layers.length);
  assert.equal(native.counters.nativeExecutions, layers.length);
  assert.equal(native.counters.nativeFastNormalStraightPixels, native.counters.fastNormalStraightPixels);
  assert.ok(native.counters.nativeFastNormalStraightPixels > 0);
  assert.equal(native.counters.scalarPixels, 0);
  assert.equal(js.counters.nativeExecutions, 0);
  assert.equal(js.counters.nativeFastNormalStraightPixels, 0);
  assert.equal(js.counters.fastNormalStraightPixels, native.counters.fastNormalStraightPixels);
  assert.equal(js.counters.quantizerBoundaryFallbacks, native.counters.quantizerBoundaryFallbacks);
  assert.ok(scalar.counters.scalarPixels > 0);
});

test("unsupported blend semantics fail closed to the unchanged JS compositor", () => {
  const layers = fixtures(31, 19);
  const automatic = compose(layers, "automatic", "multiply");
  const forced = compose(layers, "forced-js-fast", "multiply");
  assert.deepEqual(automatic.bytes, forced.bytes);
  assert.equal(automatic.counters.nativeExecutions, 0);
  assert.equal(automatic.counters.nativeFastNormalStraightPixels, 0);
  assert.ok(automatic.counters.scalarPixels > 0);
});

test("authenticated native retained-media raster is byte-exact, bounded, and mutation isolated", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const source = fixtures(13, 9)[2]!.data.slice();
  const sourceBefore = source.slice();
  for (const fixture of [
    {
      bounds: { left: 0, top: 0, right: 17, bottom: 11 },
      affine: { tx: -2, ty: 1 },
      inverse: { a: 1, b: 0, c: 0, d: 1 },
      opacity: 1,
    },
    {
      bounds: { left: 1, top: 2, right: 16, bottom: 10 },
      affine: { tx: -0.5, ty: 0.25 },
      inverse: { a: 0.875, b: -0.125, c: 0.25, d: 1.125 },
      opacity: 0.61,
    },
    {
      bounds: { left: 0, top: 0, right: 17, bottom: 11 },
      affine: { tx: 0.5, ty: -0.5 },
      inverse: { a: 1, b: 0, c: 0, d: 1 },
      opacity: 0,
    },
  ] as const) {
    const output = new Uint8Array(17 * 11 * 4);
    output.fill(173);
    const input = {
      source,
      output,
      sourceWidth: 13,
      sourceHeight: 9,
      outputWidth: 17,
      outputHeight: 11,
      ...fixture,
    };
    const result = executeReferenceNativeRetainedMediaViewportRaster(input);
    assert.ok(result);
    assert.deepEqual(output, retainedRasterControl(input));
    assert.deepEqual(source, sourceBefore, "native raster must not mutate source bytes");
    assert.equal(result.tapEvaluations, (fixture.bounds.right - fixture.bounds.left)
      * (fixture.bounds.bottom - fixture.bounds.top) * 4);
    assert.equal(result.outputPixelsWritten, result.support.nonzeroAlphaPixels);
    const repeated = new Uint8Array(output.byteLength);
    const repeatedResult = executeReferenceNativeRetainedMediaViewportRaster({ ...input, output: repeated });
    assert.deepEqual(repeated, output);
    assert.deepEqual(repeatedResult, result);
    output[0] ^= 255;
    assert.notDeepEqual(output, repeated, "separate native calls must not alias outputs");
  }

  const valid = {
    source,
    output: new Uint8Array(17 * 11 * 4),
    sourceWidth: 13,
    sourceHeight: 9,
    outputWidth: 17,
    outputHeight: 11,
    bounds: { left: 0, top: 0, right: 17, bottom: 11 },
    affine: { tx: 0, ty: 0 },
    inverse: { a: 1, b: 0, c: 0, d: 1 },
    opacity: 1,
  } as const;
  assert.throws(
    () => executeReferenceNativeRetainedMediaViewportRaster({ ...valid, output: new Uint8Array(8) }),
    /dimensions, bounds, opacity, or ownership/u,
  );
  assert.throws(
    () => executeReferenceNativeRetainedMediaViewportRaster({
      ...valid,
      output: source,
      outputWidth: 13,
      outputHeight: 9,
      bounds: { left: 0, top: 0, right: 13, bottom: 9 },
    }),
    /dimensions, bounds, opacity, or ownership/u,
  );
  assert.throws(
    () => executeReferenceNativeRetainedMediaViewportRaster({ ...valid, opacity: Number.NaN }),
    /invalid closed shapes/u,
  );
  assert.throws(
    () => executeReferenceNativeRetainedMediaViewportRaster({
      ...valid,
      bounds: { left: 0, top: 0, right: 18, bottom: 11 },
    }),
    /dimensions, bounds, opacity, or ownership/u,
  );
});

test("native executable authority rejects byte mutation and symlink substitution", async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const source = resolve("native", "reference-retained-source-over-darwin-arm64.node");
  assert.equal((await readFile(source)).byteLength, referenceNativeSourceOverIdentity.binary.bytes);
  const root = await mkdtemp(join(tmpdir(), "cut-native-source-over-"));
  try {
    const exact = join(root, "exact.node"), changed = join(root, "changed.node"), linked = join(root, "linked.node");
    await copyFile(source, exact);
    const exactCanonical = await realpath(exact);
    assert.equal(verifyReferenceNativeSourceOverBinaryForTest(exactCanonical), exactCanonical);
    const bytes = await readFile(exact);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    await writeFile(changed, bytes);
    const changedCanonical = await realpath(changed);
    assert.throws(() => verifyReferenceNativeSourceOverBinaryForTest(changedCanonical), /do not match their implementation authority/);
    await symlink(exact, linked);
    assert.throws(() => verifyReferenceNativeSourceOverBinaryForTest(linked), /regular non-link artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
