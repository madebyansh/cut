import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  executeReferenceNativeLimiterEnvelopeRange,
  executeReferenceNativeRetainedAlphaScale,
  executeReferenceNativeRetainedMediaViewportRaster,
  executeReferenceNativeRgbaAlphaBounds,
  executeReferenceNativeScaleTranslationQ16,
  referenceJavascriptSourceOverImplementation,
  referenceNativeSourceOverBackend,
  referenceNativeSourceOverIdentity,
  verifyReferenceNativeSourceOverBinaryForTest,
} from "../lib/runtime/reference/native-source-over";
import { referenceAudioLimiterLimits } from "../lib/runtime/reference/audio-limiter";
import { referenceAudioTruePeakCoefficients } from "../lib/runtime/reference/audio-true-peak";

const limiterPhases = referenceAudioLimiterLimits.oversampleFactor;
const limiterTaps = referenceAudioLimiterLimits.tapsPerPhase;
const limiterFirOrder = limiterPhases * limiterTaps - 1;
const limiterCoefficients = new Float64Array(referenceAudioTruePeakCoefficients.flat());

function limiterEnvelopeWindow(totalFrames: number, rangeStart: number, rangeEnd: number) {
  const oversampledStart = rangeStart === 0
    ? 0
    : Math.ceil((8 * rangeStart + limiterFirOrder) / 2);
  const oversampledEnd = rangeEnd === totalFrames
    ? totalFrames * limiterPhases + limiterFirOrder - (limiterPhases - 1)
    : 4 * rangeEnd + 24;
  const convolutionStart = Math.max(0, Math.ceil((oversampledStart - limiterFirOrder) / limiterPhases));
  const convolutionEnd = Math.min(totalFrames, Math.floor((oversampledEnd - 1) / limiterPhases) + 1);
  return {
    oversampledStart,
    oversampledEnd,
    readStart: Math.min(rangeStart, convolutionStart),
    readEnd: Math.max(rangeEnd, convolutionEnd),
  };
}

function limiterEnvelopeControl(
  decoded: Float32Array,
  totalFrames: number,
  rangeStart: number,
  rangeEnd: number,
  readStart: number,
  oversampledStart: number,
  oversampledEnd: number,
) {
  const envelope = new Float64Array(rangeEnd - rangeStart);
  let anyNonzero = false;
  for (const sample of decoded) if (sample !== 0) anyNonzero = true;
  for (let frame = rangeStart; frame < rangeEnd; frame += 1) {
    const local = (frame - readStart) * 2;
    envelope[frame - rangeStart] = Math.max(Math.abs(decoded[local]!), Math.abs(decoded[local + 1]!));
  }
  if (!anyNonzero) return envelope;
  for (let baseFrame = oversampledStart / limiterPhases;
    baseFrame < oversampledEnd / limiterPhases;
    baseFrame += 1) {
    const firstInputFrame = Math.max(0, baseFrame - (limiterTaps - 1));
    const lastInputFrame = Math.min(totalFrames - 1, baseFrame);
    const sourceFrame = Math.max(0, Math.min(totalFrames - 1, baseFrame - 6));
    for (let phase = 0; phase < limiterPhases; phase += 1) {
      let left = 0, right = 0, coefficientRow = baseFrame - firstInputFrame;
      for (let inputFrame = firstInputFrame;
        inputFrame <= lastInputFrame;
        inputFrame += 1, coefficientRow -= 1) {
        const local = (inputFrame - readStart) * 2;
        const inputLeft = decoded[local]!, inputRight = decoded[local + 1]!;
        if (inputLeft === 0 && inputRight === 0) continue;
        const coefficient = referenceAudioTruePeakCoefficients[coefficientRow]![phase]!;
        left += inputLeft * coefficient;
        right += inputRight * coefficient;
      }
      if (sourceFrame < rangeStart || sourceFrame >= rangeEnd) continue;
      const peak = Math.max(Math.abs(left), Math.abs(right));
      if (peak > envelope[sourceFrame - rangeStart]!) envelope[sourceFrame - rangeStart] = peak;
    }
  }
  return envelope;
}

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

test("importing the native adapter does not load a platform binary eagerly", () => {
  const modulePath = resolve(__dirname, "../lib/runtime/reference/native-source-over.js");
  const result = spawnSync(process.execPath, ["-e", `
    require(${JSON.stringify(modulePath)});
    process.stdout.write(String(Object.keys(require.cache).some((path) => path.endsWith(".node"))));
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "false");
});

test("native adapter publishes the exact selected compositor identity", () => {
  const selected = referenceNativeSourceOverBackend();
  const common = {
    platform: process.platform,
    architecture: process.arch,
    algorithm: referenceNativeSourceOverIdentity.algorithm,
  };
  assert.deepEqual(selected, process.platform === "darwin" && process.arch === "arm64"
    ? { mode: "native", ...common, binarySha256: referenceNativeSourceOverIdentity.binary.sha256 }
    : { mode: "javascript", ...common, implementation: "cut-reference-javascript-source-over-v1" });
  assert.equal(referenceJavascriptSourceOverImplementation, "cut-reference-javascript-source-over-v1");
});

test("Linux compositor selection never loads the bundled Darwin native binary", { skip: process.platform !== "linux" }, () => {
  const modulePath = resolve(__dirname, "../lib/runtime/reference/native-source-over.js");
  const result = spawnSync(process.execPath, ["-e", `
    const adapter = require(${JSON.stringify(modulePath)});
    const selected = adapter.referenceNativeSourceOverBackend();
    const nativeBinary = Object.keys(require.cache).some((path) => /reference-retained-source-over-darwin-arm64\\.node$/.test(path));
    process.stdout.write(JSON.stringify({ mode: selected.mode, nativeBinary }));
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { mode: "javascript", nativeBinary: false });
});

test("authenticated native normal source-over is byte-identical to the JS-fast and scalar laws", () => {
  const layers = fixtures(97, 53);
  const native = compose(layers, "automatic");
  const js = compose(layers, "forced-js-fast");
  const scalar = compose(layers, "forced-scalar");
  assert.deepEqual(native.bytes, js.bytes);
  assert.deepEqual(native.bytes, scalar.bytes);
  assert.equal(native.counters.executions, layers.length);
  const nativeHost = process.platform === referenceNativeSourceOverIdentity.platform
    && process.arch === referenceNativeSourceOverIdentity.architecture;
  assert.equal(native.counters.nativeExecutions, nativeHost ? layers.length : 0);
  assert.equal(native.counters.nativeFastNormalStraightPixels, nativeHost ? native.counters.fastNormalStraightPixels : 0);
  if (nativeHost) assert.ok(native.counters.nativeFastNormalStraightPixels > 0);
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

test("authenticated native alpha support and retained opacity are exact, isolated, and bounded", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const width = 17, height = 9;
  const source = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    source[offset] = (pixel * 31 + 7) & 255;
    source[offset + 1] = (pixel * 67 + 11) & 255;
    source[offset + 2] = (pixel * 101 + 13) & 255;
    source[offset + 3] = pixel % 7 === 0 ? 0 : [1, 63, 127, 128, 191, 254, 255][pixel % 7]!;
  }
  const before = Buffer.from(source);
  const expectedBounds = (() => {
    let left = width, top = height, right = 0, bottom = 0, nonzeroAlphaPixels = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (source[(y * width + x) * 4 + 3] === 0) continue;
        nonzeroAlphaPixels += 1;
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
    }
    const empty = nonzeroAlphaPixels === 0;
    return { empty, left: empty ? 0 : left, top: empty ? 0 : top, right: empty ? 0 : right, bottom: empty ? 0 : bottom, nonzeroAlphaPixels };
  })();
  assert.deepEqual(executeReferenceNativeRgbaAlphaBounds({ source, width, height }), expectedBounds);

  for (const opacity of [1 / 255, 0.125, 0.5, 0.731, 254 / 255]) {
    const bounds = { left: 2, top: 1, right: 15, bottom: 8 };
    const output = new Uint8Array(source.byteLength).fill(0xaa);
    const result = executeReferenceNativeRetainedAlphaScale({ source, output, width, height, bounds, opacity });
    const expected = new Uint8Array(source.byteLength);
    let left = width, top = height, right = 0, bottom = 0, nonzeroAlphaPixels = 0;
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) {
        const offset = (y * width + x) * 4;
        const alpha = Math.round(source[offset + 3]! * opacity);
        if (alpha === 0) continue;
        expected.set(source.subarray(offset, offset + 3), offset);
        expected[offset + 3] = alpha;
        nonzeroAlphaPixels += 1;
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
    }
    const empty = nonzeroAlphaPixels === 0;
    assert.deepEqual(output, expected, `native retained opacity bytes at ${opacity}`);
    assert.deepEqual(result, {
      empty,
      left: empty ? 0 : left,
      top: empty ? 0 : top,
      right: empty ? 0 : right,
      bottom: empty ? 0 : bottom,
      nonzeroAlphaPixels,
    });
  }
  assert.deepEqual(Buffer.from(source), before, "native alpha kernels must not mutate caller-owned source bytes");
  assert.throws(
    () => executeReferenceNativeRetainedAlphaScale({
      source,
      output: source,
      width,
      height,
      bounds: { left: 0, top: 0, right: width, bottom: height },
      opacity: 0.5,
    }),
    /separate|ownership|typed boundary/u,
  );
  assert.throws(
    () => executeReferenceNativeRgbaAlphaBounds({ source: source.subarray(1), width, height }),
    /typed boundary/u,
  );
});

test("authenticated native Q16 scale-translation is scalar-law exact and rejects hostile ownership or axes", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const sourceWidth = 3, sourceHeight = 2, outputWidth = 5, outputHeight = 3;
  const source = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 128, 9, 8, 7, 0,
    0, 0, 255, 64, 255, 255, 255, 254, 50, 60, 70, 255,
  ]);
  const before = Buffer.from(source);
  const sourceXQ16 = new Float64Array([-32768, 0, 32768, 65536, 98304]);
  const sourceYQ16 = new Float64Array([-32768, 0, 32768]);
  const output = new Uint8Array(outputWidth * outputHeight * 4).fill(0xaa);
  const result = executeReferenceNativeScaleTranslationQ16({
    source, output, sourceWidth, sourceHeight, sourceXQ16, sourceYQ16, outputWidth, outputHeight,
  });
  assert.ok(result);
  const scalar = executeReferenceNativeScaleTranslationQ16({
    source: source.slice(),
    output: new Uint8Array(output.byteLength),
    sourceWidth,
    sourceHeight,
    sourceXQ16,
    sourceYQ16,
    outputWidth,
    outputHeight,
  });
  assert.deepEqual(scalar, result);
  const repeated = new Uint8Array(output.byteLength);
  executeReferenceNativeScaleTranslationQ16({
    source, output: repeated, sourceWidth, sourceHeight, sourceXQ16, sourceYQ16, outputWidth, outputHeight,
  });
  assert.deepEqual(repeated, output);
  assert.deepEqual(Buffer.from(source), before);
  assert.throws(
    () => executeReferenceNativeScaleTranslationQ16({
      source,
      output: source,
      sourceWidth,
      sourceHeight,
      sourceXQ16,
      sourceYQ16,
      outputWidth,
      outputHeight,
    }),
    /typed boundary|alias/u,
  );
  const hostileX = new Float64Array(sourceXQ16);
  hostileX[2] = Number.NaN;
  assert.throws(
    () => executeReferenceNativeScaleTranslationQ16({
      source,
      output: new Uint8Array(output.byteLength),
      sourceWidth,
      sourceHeight,
      sourceXQ16: hostileX,
      sourceYQ16,
      outputWidth,
      outputHeight,
    }),
    /typed boundary/u,
  );
});

test("authenticated native limiter envelope is Float64-byte-identical to the scalar law across chunk boundaries", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const totalFrames = 257;
  let state = 0x6d2b79f5;
  const source = new Float32Array(totalFrames * 2);
  for (let index = 0; index < source.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    source[index] = index % 37 === 0 ? 0 : Math.fround(((state / 0xffff_ffff) * 2 - 1) * 0.95);
  }
  const sourceBefore = Buffer.from(source.buffer.slice(0));
  for (const [rangeStart, rangeEnd] of [[0, 64], [64, 128], [193, 257]] as const) {
    const window = limiterEnvelopeWindow(totalFrames, rangeStart, rangeEnd);
    const decoded = source.slice(window.readStart * 2, window.readEnd * 2);
    const decodedBefore = Buffer.from(decoded.buffer.slice(0));
    const output = new Float64Array(rangeEnd - rangeStart);
    const result = executeReferenceNativeLimiterEnvelopeRange({
      decoded,
      output,
      coefficients: limiterCoefficients,
      totalFrames,
      rangeStart,
      rangeEnd,
      readStart: window.readStart,
      oversampledStart: window.oversampledStart,
      oversampledEnd: window.oversampledEnd,
      maximumAbsoluteInputSample: referenceAudioLimiterLimits.maximumAbsoluteInputSample,
      maximumEnvelopeLinear: referenceAudioLimiterLimits.maximumEnvelopeLinear,
    });
    assert.ok(result);
    assert.equal(result.frames, rangeEnd - rangeStart);
    assert.equal(result.firBaseFrames, (window.oversampledEnd - window.oversampledStart) / limiterPhases);
    const expected = limiterEnvelopeControl(
      decoded,
      totalFrames,
      rangeStart,
      rangeEnd,
      window.readStart,
      window.oversampledStart,
      window.oversampledEnd,
    );
    assert.deepEqual(Buffer.from(output.buffer), Buffer.from(expected.buffer));
    assert.deepEqual(Buffer.from(decoded.buffer), decodedBefore);
    assert.notEqual(output.buffer, decoded.buffer);
  }
  assert.deepEqual(Buffer.from(source.buffer), sourceBefore);

  const zero = new Float32Array(16);
  const zeroOutput = new Float64Array(8);
  const zeroResult = executeReferenceNativeLimiterEnvelopeRange({
    decoded: zero,
    output: zeroOutput,
    coefficients: limiterCoefficients,
    totalFrames: 8,
    rangeStart: 0,
    rangeEnd: 8,
    readStart: 0,
    oversampledStart: 0,
    oversampledEnd: 8 * limiterPhases + limiterFirOrder - (limiterPhases - 1),
    maximumAbsoluteInputSample: referenceAudioLimiterLimits.maximumAbsoluteInputSample,
    maximumEnvelopeLinear: referenceAudioLimiterLimits.maximumEnvelopeLinear,
  });
  assert.deepEqual(zeroResult, { frames: 8, firBaseFrames: 0 });
  assert.deepEqual(zeroOutput, new Float64Array(8));
});

test("native limiter envelope rejects malformed work, nonfinite bytes, and aliased ownership", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const valid = {
    decoded: new Float32Array([0.5, -0.25]),
    output: new Float64Array(1),
    coefficients: limiterCoefficients,
    totalFrames: 1,
    rangeStart: 0,
    rangeEnd: 1,
    readStart: 0,
    oversampledStart: 0,
    oversampledEnd: limiterPhases + limiterFirOrder - (limiterPhases - 1),
    maximumAbsoluteInputSample: referenceAudioLimiterLimits.maximumAbsoluteInputSample,
    maximumEnvelopeLinear: referenceAudioLimiterLimits.maximumEnvelopeLinear,
  } as const;
  assert.throws(
    () => executeReferenceNativeLimiterEnvelopeRange({ ...valid, output: new Float64Array(2) }),
    /exact typed boundary/,
  );
  const nonfinite = valid.decoded.slice();
  nonfinite[0] = Number.NaN;
  assert.throws(
    () => executeReferenceNativeLimiterEnvelopeRange({ ...valid, decoded: nonfinite }),
    /invalid sample/,
  );
  const badCoefficients = valid.coefficients.slice();
  badCoefficients[0] = Number.POSITIVE_INFINITY;
  assert.throws(
    () => executeReferenceNativeLimiterEnvelopeRange({ ...valid, coefficients: badCoefficients }),
    /exact typed boundary/,
  );
  const shared = new ArrayBuffer(8);
  assert.throws(
    () => executeReferenceNativeLimiterEnvelopeRange({
      ...valid,
      decoded: new Float32Array(shared),
      output: new Float64Array(shared),
    }),
    /exact typed boundary/,
  );
  assert.throws(
    () => executeReferenceNativeLimiterEnvelopeRange({ ...valid, readStart: 1 }),
    /inconsistent|cover/,
  );
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
    assert.throws(() => verifyReferenceNativeSourceOverBinaryForTest(join(root, "missing.node")), /binary is missing/);
    await symlink(exact, linked);
    assert.throws(() => verifyReferenceNativeSourceOverBinaryForTest(linked), /regular non-link artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
