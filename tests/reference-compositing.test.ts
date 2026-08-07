import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import {
  applyAlphaMaskRgba,
  applyLuminanceMaskRgba,
  compositeRgba,
  compositeRgbaInPlace,
  compositeRgbaIntoReferencePrivateStraightAccumulator,
  createReferencePrivateStraightRgbaCompositeDiagnostic,
  createReferencePrivateStraightRgbaAccumulator,
  deriveReferencePrivateRgbaSourceAlphaBounds,
  deriveReferencePrivateRgbaSourceAlphaBoundsWithin,
  referencePrivateStraightRgbaCompositeDiagnosticSnapshot,
  referencePrivateStraightRgbaAccumulatorAlphaBounds,
  referencePrivateStraightRgbaBoundsAlgorithmVersion,
  rgbaBlendModes,
  type ReferencePrivateRgbaSourceAlphaBounds,
  type RgbaAlphaMode,
  type RgbaBlendMode,
  type RgbaSurface,
} from "../lib/runtime/reference/compositing";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  referenceRetainedSurfaceAlphaSupport,
  scaleReferenceRetainedSurfaceAlpha,
  translateReferenceRetainedSurface,
} from "../lib/runtime/reference/retained-surface";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function surface(pixels: number[], width = 1, height = pixels.length / 4, alphaMode?: RgbaAlphaMode): RgbaSurface {
  return { data: Uint8Array.from(pixels), width, height, ...(alphaMode ? { alphaMode } : {}) };
}

function bytes(result: ReturnType<typeof compositeRgba>) { return [...result.data]; }

// Frozen copy of the pre-fast-path scalar law. Keep this independent from the
// production helpers so optimized branches must prove byte identity, including
// old canonicalization behavior for hidden RGB under zero alpha.
const frozenSrgbToLinearBytes = Float64Array.from({ length: 256 }, (_, value) => {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});
const frozenClampUnit = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value;
const frozenByte = (value: number) => Math.round(frozenClampUnit(value) * 255);
function frozenLinearToSrgb(value: number) {
  const linear = frozenClampUnit(value);
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}
function frozenDecodeChannel(data: Uint8Array, offset: number, alpha: number, mode: RgbaAlphaMode) {
  if (mode === "straight") return frozenSrgbToLinearBytes[data[offset]];
  if (alpha <= 0) return 0;
  const straightSrgb = frozenClampUnit((data[offset] / 255) / alpha);
  return straightSrgb <= 0.04045 ? straightSrgb / 12.92 : ((straightSrgb + 0.055) / 1.055) ** 2.4;
}
function frozenEncodeChannel(linear: number, alpha: number, mode: RgbaAlphaMode) {
  const encoded = frozenLinearToSrgb(linear);
  return frozenByte(mode === "premultiplied" ? encoded * alpha : encoded);
}
function frozenBlendChannel(mode: RgbaBlendMode, backdrop: number, source: number) {
  if (mode === "normal" || mode === "source-over") return source;
  if (mode === "multiply") return backdrop * source;
  if (mode === "screen") return backdrop + source - backdrop * source;
  if (mode === "overlay") return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  if (mode === "darken") return Math.min(backdrop, source);
  if (mode === "lighten") return Math.max(backdrop, source);
  if (mode === "add" || mode === "plus") return Math.min(1, backdrop + source);
  return Math.abs(backdrop - source);
}
function frozenCompositeRgba(
  backdrop: RgbaSurface,
  source: RgbaSurface,
  options: { mode?: RgbaBlendMode; outputAlphaMode?: RgbaAlphaMode } = {},
) {
  const mode = options.mode ?? "normal";
  const outputAlphaMode = options.outputAlphaMode ?? backdrop.alphaMode ?? "straight";
  const backdropAlphaMode = backdrop.alphaMode ?? "straight";
  const sourceAlphaMode = source.alphaMode ?? "straight";
  const output = new Uint8Array(backdrop.data.byteLength);
  for (let offset = 0; offset < output.length; offset += 4) {
    const backdropAlpha = backdrop.data[offset + 3] / 255;
    const sourceAlpha = source.data[offset + 3] / 255;
    const outputAlpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
    for (let channel = 0; channel < 3; channel += 1) {
      const backdropChannel = frozenDecodeChannel(backdrop.data, offset + channel, backdropAlpha, backdropAlphaMode);
      const sourceChannel = frozenDecodeChannel(source.data, offset + channel, sourceAlpha, sourceAlphaMode);
      const blended = frozenBlendChannel(mode, backdropChannel, sourceChannel);
      const premultiplied = sourceAlpha * (1 - backdropAlpha) * sourceChannel
        + sourceAlpha * backdropAlpha * blended
        + backdropAlpha * (1 - sourceAlpha) * backdropChannel;
      const straight = outputAlpha > 0 ? premultiplied / outputAlpha : 0;
      output[offset + channel] = frozenEncodeChannel(straight, outputAlpha, outputAlphaMode);
    }
    output[offset + 3] = frozenByte(outputAlpha);
  }
  return output;
}

function kernelProgram(body: string) {
  return `cut 0.4;
project "compositing kernel";
import { Composite, Mask, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 1, width: 4px, height: 4px, sampleRate: 8khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 4px, height: 4px, codec: "h264");`;
}

function compileKernel(body: string) {
  const parsed = parseCutLanguage(kernelProgram(body));
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function pixel(surface: { data: Uint8Array; width: number }, x = 2, y = 2) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function assertPixelClose(actual: number[], expected: number[], tolerance = 2) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `channel ${index}: expected ${expected[index]} ± ${tolerance}, found ${value}`));
}

async function renderKernel(body: string) {
  const ir = compileKernel(body);
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-composite-kernel-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    return { ir, frame: await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0) };
  } finally { renderer.close(); }
}

test("linear-light blend modes match hand-computed opaque reference pixels", () => {
  const backdrop = surface([64, 128, 192, 255]);
  const source = surface([192, 128, 64, 255]);
  const references: Array<[RgbaBlendMode, number[]]> = [
    ["normal", [192, 128, 64, 255]],
    ["source-over", [192, 128, 64, 255]],
    ["multiply", [46, 61, 46, 255]],
    ["screen", [196, 167, 196, 255]],
    ["overlay", [66, 86, 90, 255]],
    ["darken", [64, 128, 64, 255]],
    ["lighten", [192, 128, 192, 255]],
    ["add", [200, 176, 200, 255]],
    ["plus", [200, 176, 200, 255]],
    ["difference", [183, 0, 183, 255]],
  ];
  for (const [mode, expected] of references) assert.deepEqual(bytes(compositeRgba(backdrop, source, { mode })), expected, mode);
});

test("source-over handles partial coverage in linear light and preserves layer ordering", () => {
  const blue = surface([0, 0, 255, 255]);
  const red = surface([255, 0, 0, 128]);
  assert.deepEqual(bytes(compositeRgba(blue, red)), [188, 0, 187, 255]);
  assert.deepEqual(bytes(compositeRgba(surface([255, 0, 0, 255]), surface([0, 0, 255, 128]))), [187, 0, 188, 255]);

  const halfBlue = surface([0, 0, 255, 128]);
  assert.deepEqual(bytes(compositeRgba(halfBlue, red)), [213, 0, 156, 192]);
});

test("transparent and opaque source-over invariants hold for every blend mode", () => {
  const backdrop = surface([17, 83, 201, 149]);
  const transparent = surface([255, 1, 99, 0]);
  const opaque = surface([231, 44, 109, 255]);
  const clear = surface([0, 0, 0, 0]);
  const modes: RgbaBlendMode[] = ["normal", "source-over", "multiply", "screen", "overlay", "darken", "lighten", "add", "plus", "difference"];
  for (const mode of modes) {
    assert.deepEqual(bytes(compositeRgba(backdrop, transparent, { mode })), [...backdrop.data], `${mode} transparent source`);
    assert.deepEqual(bytes(compositeRgba(clear, opaque, { mode })), [...opaque.data], `${mode} transparent backdrop`);
  }
  assert.deepEqual(bytes(compositeRgba(backdrop, opaque)), [...opaque.data]);
});

test("compositing fast paths byte-match the frozen scalar law at exhaustive alpha boundaries", () => {
  const boundaryAlphas = [0, 1, 254, 255] as const;
  const pixels = 256 * boundaryAlphas.length;
  const backdropBytes = new Uint8Array(pixels * 4);
  const sourceBytes = new Uint8Array(pixels * 4);
  for (let value = 0; value < 256; value += 1) {
    for (let boundary = 0; boundary < boundaryAlphas.length; boundary += 1) {
      const offset = (value * boundaryAlphas.length + boundary) * 4;
      backdropBytes.set([value, 255 - value, (value * 73) & 255, boundaryAlphas[(boundary + value) & 3]], offset);
      sourceBytes.set([(value * 151) & 255, value, 255 - value, boundaryAlphas[boundary]], offset);
    }
  }
  const backdropSnapshot = Uint8Array.from(backdropBytes);
  const sourceSnapshot = Uint8Array.from(sourceBytes);
  const alphaModes: RgbaAlphaMode[] = ["straight", "premultiplied"];

  for (const backdropAlphaMode of alphaModes) {
    for (const sourceAlphaMode of alphaModes) {
      for (const outputAlphaMode of alphaModes) {
        const backdrop: RgbaSurface = { data: backdropBytes, width: pixels, height: 1, alphaMode: backdropAlphaMode };
        const source: RgbaSurface = { data: sourceBytes, width: pixels, height: 1, alphaMode: sourceAlphaMode };
        for (const mode of rgbaBlendModes) {
          const expected = frozenCompositeRgba(backdrop, source, { mode, outputAlphaMode });
          const actual = compositeRgba(backdrop, source, { mode, outputAlphaMode });
          assert.deepEqual(
            actual.data,
            expected,
            `${mode}: ${backdropAlphaMode} backdrop, ${sourceAlphaMode} source, ${outputAlphaMode} output`,
          );
        }
      }
    }
  }
  assert.deepEqual(backdropBytes, backdropSnapshot, "backdrop bytes must not be mutated");
  assert.deepEqual(sourceBytes, sourceSnapshot, "source bytes must not be mutated");
});

test("opaque premultiplied and clear-backdrop fast paths preserve every blend/output boundary", () => {
  const clearBackdrops = [
    surface([255, 99, 17, 0], 1, 1, "straight"),
    surface([255, 99, 17, 0], 1, 1, "premultiplied"),
  ];
  const sources = [
    surface([199, 37, 241, 255], 1, 1, "premultiplied"),
    surface([233, 71, 19, 1], 1, 1, "straight"),
    surface([111, 222, 7, 254], 1, 1, "straight"),
  ];
  for (const backdrop of clearBackdrops) {
    for (const source of sources) {
      for (const outputAlphaMode of ["straight", "premultiplied"] as const) {
        for (const mode of rgbaBlendModes) {
          assert.deepEqual(
            compositeRgba(backdrop, source, { mode, outputAlphaMode }).data,
            frozenCompositeRgba(backdrop, source, { mode, outputAlphaMode }),
            `${mode}: ${backdrop.alphaMode} clear backdrop, ${source.alphaMode} source, ${outputAlphaMode} output`,
          );
        }
      }
    }
  }
});

test("noncanonical premultiplied hidden RGB stays on byte-exact scalar semantics", () => {
  const hostileBackdrops = [
    surface([250, 200, 150, 1], 1, 1, "premultiplied"),
    surface([255, 99, 17, 0], 1, 1, "premultiplied"),
  ];
  const hostileSources = [
    surface([255, 1, 99, 0], 1, 1, "premultiplied"),
    surface([250, 200, 150, 1], 1, 1, "premultiplied"),
    surface([255, 254, 253, 254], 1, 1, "premultiplied"),
  ];
  for (const backdrop of hostileBackdrops) {
    for (const source of hostileSources) {
      for (const outputAlphaMode of ["straight", "premultiplied"] as const) {
        for (const mode of rgbaBlendModes) {
          assert.deepEqual(
            compositeRgba(backdrop, source, { mode, outputAlphaMode }).data,
            frozenCompositeRgba(backdrop, source, { mode, outputAlphaMode }),
            `${mode}: hostile premultiplied bytes to ${outputAlphaMode}`,
          );
        }
      }
    }
  }
});

test("optimized compositing is deterministic, non-mutating, and byte-identical on randomized surfaces", () => {
  let state = 0x6d2b79f5;
  const nextByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 24;
  };
  const pixels = 2_048;
  const backdropBytes = new Uint8Array(pixels * 4);
  const sourceBytes = new Uint8Array(pixels * 4);
  const alphaBoundaries = [0, 1, 254, 255] as const;
  for (let offset = 0, index = 0; offset < backdropBytes.length; offset += 4, index += 1) {
    backdropBytes.set([nextByte(), nextByte(), nextByte(), index % 3 === 0 ? alphaBoundaries[index & 3] : nextByte()], offset);
    sourceBytes.set([nextByte(), nextByte(), nextByte(), index % 2 === 0 ? alphaBoundaries[(index >>> 1) & 3] : nextByte()], offset);
  }
  const backdropSnapshot = Uint8Array.from(backdropBytes);
  const sourceSnapshot = Uint8Array.from(sourceBytes);
  for (const backdropAlphaMode of ["straight", "premultiplied"] as const) {
    for (const sourceAlphaMode of ["straight", "premultiplied"] as const) {
      const backdrop: RgbaSurface = { data: backdropBytes, width: 64, height: 32, alphaMode: backdropAlphaMode };
      const source: RgbaSurface = { data: sourceBytes, width: 64, height: 32, alphaMode: sourceAlphaMode };
      for (const outputAlphaMode of ["straight", "premultiplied"] as const) {
        for (const mode of rgbaBlendModes) {
          const expected = frozenCompositeRgba(backdrop, source, { mode, outputAlphaMode });
          const first = compositeRgba(backdrop, source, { mode, outputAlphaMode });
          const repeat = compositeRgba(backdrop, source, { mode, outputAlphaMode });
          assert.deepEqual(first.data, expected, `${mode}: randomized frozen-law parity`);
          assert.deepEqual(repeat.data, first.data, `${mode}: randomized repeat bytes`);
        }
      }
    }
  }
  assert.deepEqual(backdropBytes, backdropSnapshot, "randomized backdrop bytes must not be mutated");
  assert.deepEqual(sourceBytes, sourceSnapshot, "randomized source bytes must not be mutated");
});

test("in-place compositing preserves the frozen byte law without allocating or mutating source", () => {
  let state = 0x91e10da5;
  const nextByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 24;
  };
  const pixels = 1_024;
  const backdropSeed = new Uint8Array(pixels * 4);
  const sourceBytes = new Uint8Array(pixels * 4);
  const alphaBoundaries = [0, 1, 254, 255] as const;
  for (let offset = 0, index = 0; offset < backdropSeed.length; offset += 4, index += 1) {
    backdropSeed.set([nextByte(), nextByte(), nextByte(), index % 2 ? nextByte() : alphaBoundaries[index & 3]], offset);
    sourceBytes.set([nextByte(), nextByte(), nextByte(), index % 3 ? nextByte() : alphaBoundaries[(index >>> 1) & 3]], offset);
  }
  const sourceSnapshot = Uint8Array.from(sourceBytes);
  for (const backdropAlphaMode of ["straight", "premultiplied"] as const) {
    for (const sourceAlphaMode of ["straight", "premultiplied"] as const) {
      const source: RgbaSurface = {
        data: sourceBytes,
        width: 32,
        height: 32,
        alphaMode: sourceAlphaMode,
      };
      for (const mode of rgbaBlendModes) {
        const mutableBackdrop = Uint8Array.from(backdropSeed);
        const backdrop: RgbaSurface = {
          data: mutableBackdrop,
          width: 32,
          height: 32,
          alphaMode: backdropAlphaMode,
        };
        const expected = frozenCompositeRgba(
          { ...backdrop, data: Uint8Array.from(backdropSeed) },
          source,
          { mode, outputAlphaMode: backdropAlphaMode },
        );
        const actual = compositeRgbaInPlace(backdrop, source, {
          mode,
          outputAlphaMode: backdropAlphaMode,
        });
        assert.equal(actual.data, mutableBackdrop, `${mode}: output must reuse caller-owned backdrop bytes`);
        assert.deepEqual(actual.data, expected, `${mode}: in-place frozen-law parity`);
        assert.deepEqual(sourceBytes, sourceSnapshot, `${mode}: source bytes must remain immutable`);
      }
    }
  }
});

test("in-place compositing refuses alpha-mode conversion before mutating backdrop", () => {
  const backdropBytes = Uint8Array.from([250, 200, 150, 1]);
  const snapshot = Uint8Array.from(backdropBytes);
  assert.throws(
    () => compositeRgbaInPlace(
      { data: backdropBytes, width: 1, height: 1, alphaMode: "premultiplied" },
      surface([255, 1, 99, 0], 1, 1, "straight"),
      { outputAlphaMode: "straight" },
    ),
    /cannot change the backdrop alphaMode/,
  );
  assert.deepEqual(backdropBytes, snapshot);
});

test("private source bounds derive exact empty, full, edge, corner, one-pixel, and row-stride support", () => {
  const width = 5, height = 4;
  const hidden = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < hidden.length; offset += 4) hidden.set([241, 19, 173, 0], offset);
  const emptySource: RgbaSurface = { data: hidden, width, height };
  const emptySnapshot = Uint8Array.from(hidden);
  assert.deepEqual(deriveReferencePrivateRgbaSourceAlphaBounds(emptySource), {
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty: true,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    nonzeroAlphaPixels: 0,
    pixelsScanned: width * height,
  });
  assert.deepEqual(hidden, emptySnapshot, "bounds derivation must preserve hidden source RGB");

  const positions = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [2, 1],
  ] as const;
  for (const [x, y] of positions) {
    const data = Uint8Array.from(hidden);
    data[(y * width + x) * 4 + 3] = 1;
    assert.deepEqual(deriveReferencePrivateRgbaSourceAlphaBounds({ data, width, height }), {
      format: "cut-reference-private-rgba-source-alpha-bounds",
      version: 1,
      empty: false,
      left: x,
      top: y,
      right: x + 1,
      bottom: y + 1,
      nonzeroAlphaPixels: 1,
      pixelsScanned: width * height,
    }, `one-pixel support at ${x},${y}`);
  }

  const stride = Uint8Array.from(hidden);
  stride[(1 * width + 4) * 4 + 3] = 254;
  stride[(2 * width + 0) * 4 + 3] = 255;
  assert.deepEqual(deriveReferencePrivateRgbaSourceAlphaBounds({ data: stride, width, height }), {
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty: false,
    left: 0,
    top: 1,
    right: 5,
    bottom: 3,
    nonzeroAlphaPixels: 2,
    pixelsScanned: width * height,
  });

  const full = Uint8Array.from(hidden);
  for (let offset = 3; offset < full.length; offset += 4) full[offset] = 1;
  assert.deepEqual(deriveReferencePrivateRgbaSourceAlphaBounds({ data: full, width, height }), {
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty: false,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    nonzeroAlphaPixels: width * height,
    pixelsScanned: width * height,
  });
});

test("private source bounds scan only a producer-proved rectangle without changing exact support or pixels", () => {
  const width = 7, height = 5;
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0, pixelIndex = 0; offset < data.length; offset += 4, pixelIndex += 1) {
    data.set([(pixelIndex * 43) & 255, (pixelIndex * 97) & 255, (pixelIndex * 151) & 255, 0], offset);
  }
  for (const [x, y, alpha] of [[2, 1, 1], [5, 2, 127], [3, 3, 255]] as const) {
    data[(y * width + x) * 4 + 3] = alpha;
  }
  const source = { data, width, height };
  const sourceSnapshot = Uint8Array.from(data);
  const full = deriveReferencePrivateRgbaSourceAlphaBounds(source);
  const bounded = deriveReferencePrivateRgbaSourceAlphaBoundsWithin(source, {
    left: 2,
    top: 1,
    right: 6,
    bottom: 4,
  });
  assert.deepEqual(
    { ...bounded, pixelsScanned: full.pixelsScanned },
    full,
    "the conservative producer rectangle must retain exact byte-derived support",
  );
  assert.equal(full.pixelsScanned, 35);
  assert.equal(bounded.pixelsScanned, 12);
  assert.deepEqual(data, sourceSnapshot, "bounded support derivation must not mutate source bytes");

  const empty = deriveReferencePrivateRgbaSourceAlphaBoundsWithin(source, {
    left: 0,
    top: 0,
    right: 2,
    bottom: 1,
  });
  assert.deepEqual(empty, {
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty: true,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    nonzeroAlphaPixels: 0,
    pixelsScanned: 2,
  });

  for (const invalid of [
    { left: -1, top: 0, right: 1, bottom: 1 },
    { left: 0, top: 0, right: width + 1, bottom: 1 },
    { left: 3, top: 0, right: 2, bottom: 1 },
    { left: 0.5, top: 0, right: 2, bottom: 1 },
  ]) {
    assert.throws(
      () => deriveReferencePrivateRgbaSourceAlphaBoundsWithin(source, invalid),
      /valid half-open source rectangle/,
    );
  }

  const backdropA = createReferencePrivateStraightRgbaAccumulator(width, height);
  const backdropB = createReferencePrivateStraightRgbaAccumulator(width, height);
  compositeRgbaIntoReferencePrivateStraightAccumulator(backdropA, source, full);
  compositeRgbaIntoReferencePrivateStraightAccumulator(backdropB, source, bounded);
  assert.deepEqual(backdropB.data, backdropA.data, "bounded support must preserve exact composed RGBA");
  assert.deepEqual(data, sourceSnapshot, "bounded composition must retain source ownership");
});

test("private LocalSpace compositing consumes authoritative retained support without rescanning or changing bytes", () => {
  const width = 11, height = 7;
  const sparse = new Uint8Array(5 * 3 * 4);
  for (let offset = 0, index = 0; offset < sparse.length; offset += 4, index += 1) {
    sparse.set([(index * 37) & 255, (index * 83) & 255, (index * 149) & 255, 0], offset);
  }
  sparse.set([211, 41, 91, 1], (0 * 5 + 0) * 4);
  sparse.set([19, 181, 239, 254], (1 * 5 + 4) * 4);
  sparse.set([251, 117, 13, 255], (2 * 5 + 2) * 4);
  const translated = translateReferenceRetainedSurface(
    { data: sparse, width: 5, height: 3 },
    width,
    height,
    2.5,
    1.5,
  );
  const scaled = scaleReferenceRetainedSurfaceAlpha(translated, 0.75);
  const support = referenceRetainedSurfaceAlphaSupport(scaled);
  assert.ok(support && !support.empty);
  const bounds = deriveReferencePrivateRgbaSourceAlphaBounds(scaled);
  assert.deepEqual(bounds, {
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty: support.empty,
    left: support.left,
    top: support.top,
    right: support.right,
    bottom: support.bottom,
    nonzeroAlphaPixels: support.nonzeroAlphaPixels,
    pixelsScanned: 0,
  });

  const sourceSnapshot = Uint8Array.from(scaled.data);
  const clear = new Uint8Array(width * height * 4);
  for (const mode of rgbaBlendModes) {
    const accumulator = createReferencePrivateStraightRgbaAccumulator(width, height);
    compositeRgbaIntoReferencePrivateStraightAccumulator(accumulator, scaled, bounds, { mode });
    const expected = frozenCompositeRgba(
      { data: clear, width, height },
      scaled,
      { mode, outputAlphaMode: "straight" },
    );
    assert.deepEqual(accumulator.data, Buffer.from(expected), `${mode}: retained support frozen-law parity`);
  }
  assert.deepEqual(
    scaled.data,
    Buffer.from(sourceSnapshot),
    "retained support consumers must not mutate shared source bytes",
  );

  const shifted = translateReferenceRetainedSurface(
    { data: sparse, width: 5, height: 3 },
    width,
    height,
    -1,
    4,
  );
  const shiftedBounds = deriveReferencePrivateRgbaSourceAlphaBounds(shifted);
  assert.notDeepEqual(
    [shiftedBounds.left, shiftedBounds.top, shiftedBounds.right, shiftedBounds.bottom],
    [bounds.left, bounds.top, bounds.right, bounds.bottom],
    "placement changes must invalidate the prior support geometry",
  );
  assert.equal(shiftedBounds.pixelsScanned, 0);
});

test("private bounded LocalSpace law byte-matches the frozen scalar law for every blend mode and alpha boundary", () => {
  const width = 7, height = 5, pixels = width * height;
  const transparent = new Uint8Array(pixels * 4);
  const firstBytes = new Uint8Array(pixels * 4);
  const secondBytes = new Uint8Array(pixels * 4);
  for (let offset = 0, index = 0; offset < firstBytes.length; offset += 4, index += 1) {
    firstBytes.set([(index * 17) & 255, (index * 71) & 255, (index * 131) & 255, 0], offset);
    secondBytes.set([(index * 29) & 255, (index * 113) & 255, (index * 199) & 255, 0], offset);
  }
  // Disjoint islands force a rectangle with zero-alpha holes and cross row
  // boundaries. Hidden RGB remains noncanonical everywhere else.
  firstBytes.set([31, 97, 181, 1], (0 * width + 0) * 4);
  firstBytes.set([221, 73, 19, 254], (height - 1) * width * 4 + (width - 1) * 4);
  secondBytes.set([247, 151, 43, 255], (1 * width + 5) * 4);
  secondBytes.set([13, 233, 109, 128], (3 * width + 1) * 4);
  const first: RgbaSurface = { data: firstBytes, width, height };
  const second: RgbaSurface = { data: secondBytes, width, height };
  const firstSnapshot = Uint8Array.from(firstBytes), secondSnapshot = Uint8Array.from(secondBytes);

  for (const mode of rgbaBlendModes) {
    const accumulator = createReferencePrivateStraightRgbaAccumulator(width, height);
    const firstBounds = deriveReferencePrivateRgbaSourceAlphaBounds(first);
    const returned = compositeRgbaIntoReferencePrivateStraightAccumulator(accumulator, first, firstBounds, { mode });
    assert.equal(returned, accumulator, `${mode}: private accumulator object identity`);
    let expected = frozenCompositeRgba({ data: transparent, width, height }, first, {
      mode,
      outputAlphaMode: "straight",
    });
    assert.deepEqual(accumulator.data, Buffer.from(expected), `${mode}: first sparse layer`);
    const secondBounds = deriveReferencePrivateRgbaSourceAlphaBounds(second);
    compositeRgbaIntoReferencePrivateStraightAccumulator(accumulator, second, secondBounds, { mode });
    expected = frozenCompositeRgba({ data: expected, width, height }, second, {
      mode,
      outputAlphaMode: "straight",
    });
    assert.deepEqual(accumulator.data, Buffer.from(expected), `${mode}: second sparse layer`);
  }
  assert.deepEqual(firstBytes, firstSnapshot, "first cached/shared source remains immutable");
  assert.deepEqual(secondBytes, secondSnapshot, "second cached/shared source remains immutable");
});

test("private normal source-over fast kernel is byte-exact, bounded, and force-scalar comparable", () => {
  const width = 256, height = 256, pixels = width * height;
  let state = 0x4f1bbcdc;
  const nextByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 24;
  };
  const backdropBytes = new Uint8Array(pixels * 4);
  const sourceBytes = new Uint8Array(pixels * 4);
  const boundaries = [0, 1, 2, 127, 128, 253, 254, 255] as const;
  for (let offset = 0, index = 0; offset < backdropBytes.length; offset += 4, index += 1) {
    backdropBytes.set([
      nextByte(), index & 255, 255 - (index & 255),
      index % 3 === 0 ? boundaries[index & 7]! : nextByte(),
    ], offset);
    sourceBytes.set([
      255 - (index & 255), nextByte(), index & 255,
      index % 2 === 0 ? boundaries[(index >>> 1) & 7]! : nextByte(),
    ], offset);
  }
  const backdrop = { data: backdropBytes, width, height } as const;
  const source = { data: sourceBytes, width, height } as const;
  const backdropSnapshot = Uint8Array.from(backdropBytes);
  const sourceSnapshot = Uint8Array.from(sourceBytes);
  const backdropBounds = deriveReferencePrivateRgbaSourceAlphaBounds(backdrop);
  const sourceBounds = deriveReferencePrivateRgbaSourceAlphaBounds(source);
  const automaticDiagnostic = createReferencePrivateStraightRgbaCompositeDiagnostic();
  const scalarDiagnostic = createReferencePrivateStraightRgbaCompositeDiagnostic("forced-scalar");
  const automatic = createReferencePrivateStraightRgbaAccumulator(width, height);
  const forcedScalar = createReferencePrivateStraightRgbaAccumulator(width, height);
  compositeRgbaIntoReferencePrivateStraightAccumulator(automatic, backdrop, backdropBounds, { diagnostic: automaticDiagnostic });
  compositeRgbaIntoReferencePrivateStraightAccumulator(automatic, source, sourceBounds, { diagnostic: automaticDiagnostic });
  compositeRgbaIntoReferencePrivateStraightAccumulator(forcedScalar, backdrop, backdropBounds, { diagnostic: scalarDiagnostic });
  compositeRgbaIntoReferencePrivateStraightAccumulator(forcedScalar, source, sourceBounds, { diagnostic: scalarDiagnostic });
  const frozenBackdrop = frozenCompositeRgba({ data: new Uint8Array(backdropBytes.length), width, height }, backdrop);
  const frozen = frozenCompositeRgba({ data: frozenBackdrop, width, height }, source);
  assert.deepEqual(automatic.data, Buffer.from(frozen), "automatic fast kernel must preserve the frozen scalar law");
  assert.deepEqual(forcedScalar.data, automatic.data, "forced scalar and automatic private kernels must agree byte-for-byte");
  assert.deepEqual(backdropBytes, backdropSnapshot, "fast kernel must not mutate backdrop source bytes");
  assert.deepEqual(sourceBytes, sourceSnapshot, "fast kernel must not mutate foreground source bytes");
  assert.notEqual(automatic.data, backdropBytes, "private output must not alias backdrop source bytes");
  assert.notEqual(automatic.data, sourceBytes, "private output must not alias foreground source bytes");
  const automaticSnapshot = referencePrivateStraightRgbaCompositeDiagnosticSnapshot(automaticDiagnostic);
  const scalarSnapshot = referencePrivateStraightRgbaCompositeDiagnosticSnapshot(scalarDiagnostic);
  assert.equal(automaticSnapshot.executions, 2);
  assert.ok(automaticSnapshot.fastNormalStraightPixels > 0);
  assert.equal(automaticSnapshot.scalarPixels, 0);
  assert.equal(scalarSnapshot.fastNormalStraightPixels, 0);
  assert.ok(scalarSnapshot.scalarPixels > 0);
  assert.throws(
    () => compositeRgbaIntoReferencePrivateStraightAccumulator(
      createReferencePrivateStraightRgbaAccumulator(width, height), source, sourceBounds,
      { diagnostic: Object.freeze({ mode: "automatic" }) },
    ),
    /diagnostic authority is invalid/,
  );
});

test("private bounded LocalSpace law has deterministic randomized full-surface parity", () => {
  let state = 0x4f1bbcdc;
  const nextByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 24;
  };
  const width = 32, height = 18, pixels = width * height;
  const layers = Array.from({ length: 5 }, (_, layer) => {
    const data = new Uint8Array(pixels * 4);
    for (let offset = 0, index = 0; offset < data.length; offset += 4, index += 1) {
      const alpha = (index + layer) % 11 === 0
        ? [0, 1, 254, 255][(index + layer) & 3]!
        : (index + layer) % 7 === 0 ? nextByte() : 0;
      data.set([nextByte(), nextByte(), nextByte(), alpha], offset);
    }
    return { data, width, height } satisfies RgbaSurface;
  });
  const snapshots = layers.map((layer) => Uint8Array.from(layer.data));
  for (const mode of rgbaBlendModes) {
    const render = () => {
      const accumulator = createReferencePrivateStraightRgbaAccumulator(width, height);
      let expected = new Uint8Array(pixels * 4);
      for (const layer of layers) {
        const bounds = deriveReferencePrivateRgbaSourceAlphaBounds(layer);
        compositeRgbaIntoReferencePrivateStraightAccumulator(accumulator, layer, bounds, { mode });
        expected = frozenCompositeRgba({ data: expected, width, height }, layer, {
          mode,
          outputAlphaMode: "straight",
        });
      }
      assert.deepEqual(accumulator.data, Buffer.from(expected), `${mode}: randomized bounded/full parity`);
      return Uint8Array.from(accumulator.data);
    };
    assert.deepEqual(render(), render(), `${mode}: deterministic repeat`);
  }
  layers.forEach((layer, index) => assert.deepEqual(layer.data, snapshots[index], `random source ${index} is immutable`));
});

test("nested private accumulators publish exact maintained alpha support without a full-surface rescan", () => {
  const width = 9, height = 6;
  const first = new Uint8Array(width * height * 4);
  const second = new Uint8Array(width * height * 4);
  first.set([210, 31, 73, 1], (1 * width + 7) * 4);
  first.set([19, 141, 229, 255], (4 * width + 2) * 4);
  second.set([77, 88, 99, 254], (1 * width + 7) * 4);
  second.set([13, 199, 43, 128], (3 * width + 5) * 4);
  const firstSurface = { data: first, width, height };
  const secondSurface = { data: second, width, height };

  const child = createReferencePrivateStraightRgbaAccumulator(width, height);
  compositeRgbaIntoReferencePrivateStraightAccumulator(
    child,
    firstSurface,
    deriveReferencePrivateRgbaSourceAlphaBounds(firstSurface),
  );
  compositeRgbaIntoReferencePrivateStraightAccumulator(
    child,
    secondSurface,
    deriveReferencePrivateRgbaSourceAlphaBounds(secondSurface),
    { mode: "screen" },
  );

  const maintained = referencePrivateStraightRgbaAccumulatorAlphaBounds(child);
  assert.deepEqual(maintained, {
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty: false,
    left: 2,
    top: 1,
    right: 8,
    bottom: 5,
    nonzeroAlphaPixels: 3,
    pixelsScanned: 0,
  });
  assert.deepEqual(
    maintained,
    deriveReferencePrivateRgbaSourceAlphaBounds(child),
    "the ordinary private derivation surface must reuse accumulator authority",
  );

  const parent = createReferencePrivateStraightRgbaAccumulator(width, height);
  compositeRgbaIntoReferencePrivateStraightAccumulator(parent, child, maintained!);
  assert.deepEqual(parent.data, child.data, "nested straight source-over preserves exact child bytes");

  const stale = maintained!;
  const late = new Uint8Array(width * height * 4);
  late.set([250, 120, 30, 255], (5 * width + 8) * 4);
  const lateSurface = { data: late, width, height };
  compositeRgbaIntoReferencePrivateStraightAccumulator(
    child,
    lateSurface,
    deriveReferencePrivateRgbaSourceAlphaBounds(lateSurface),
  );
  const untouched = Buffer.from(parent.data);
  assert.throws(
    () => compositeRgbaIntoReferencePrivateStraightAccumulator(parent, child, stale),
    /stale private accumulator alpha-support receipt/,
  );
  assert.deepEqual(parent.data, untouched, "stale nested support fails before parent mutation");
  assert.deepEqual(referencePrivateStraightRgbaAccumulatorAlphaBounds(child), {
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty: false,
    left: 2,
    top: 1,
    right: 9,
    bottom: 6,
    nonzeroAlphaPixels: 4,
    pixelsScanned: 0,
  });
});

test("private bounded LocalSpace authority rejects forged bounds, aliases, foreign accumulators, and excessive allocation", () => {
  const source = surface([
    255, 1, 99, 0,
    11, 22, 33, 255,
    77, 88, 99, 0,
    44, 55, 66, 128,
  ], 2, 2);
  const receipt = deriveReferencePrivateRgbaSourceAlphaBounds(source);
  const forged = { ...receipt, left: -1, right: 3 } as ReferencePrivateRgbaSourceAlphaBounds;
  const accumulator = createReferencePrivateStraightRgbaAccumulator(2, 2);
  const before = Buffer.from(accumulator.data);
  assert.throws(
    () => compositeRgbaIntoReferencePrivateStraightAccumulator(accumulator, source, forged),
    /requires source bounds derived for these exact immutable bytes/,
  );
  assert.deepEqual(accumulator.data, before, "forged bounds fail before accumulator mutation");
  assert.throws(
    () => compositeRgbaIntoReferencePrivateStraightAccumulator(
      accumulator,
      { ...source, data: Uint8Array.from(source.data) },
      receipt,
    ),
    /requires source bounds derived for these exact immutable bytes/,
  );
  assert.deepEqual(accumulator.data, before, "foreign source bytes fail before mutation");

  const accumulatorBounds = deriveReferencePrivateRgbaSourceAlphaBounds(accumulator);
  assert.throws(
    () => compositeRgbaIntoReferencePrivateStraightAccumulator(accumulator, accumulator, accumulatorBounds),
    /must not alias/,
  );
  const callerOwned = {
    data: Buffer.alloc(16),
    width: 2,
    height: 2,
    alphaMode: "straight" as const,
  };
  assert.throws(
    () => compositeRgbaIntoReferencePrivateStraightAccumulator(
      callerOwned as ReturnType<typeof createReferencePrivateStraightRgbaAccumulator>,
      source,
      receipt,
    ),
    /private accumulator authority/,
  );
  assert.throws(
    () => createReferencePrivateStraightRgbaAccumulator(16_777_217, 1),
    /16777216-pixel resource limit/,
  );
});

test("straight and premultiplied alpha boundaries round-trip without double multiplication", () => {
  const clear = surface([0, 0, 0, 0]);
  const premultiplied = surface([100, 50, 25, 128], 1, 1, "premultiplied");
  const keptPremultiplied = compositeRgba(clear, premultiplied, { outputAlphaMode: "premultiplied" });
  assert.equal(keptPremultiplied.alphaMode, "premultiplied");
  assert.deepEqual(bytes(keptPremultiplied), [100, 50, 25, 128]);

  const straight = compositeRgba(clear, premultiplied, { outputAlphaMode: "straight" });
  assert.equal(straight.alphaMode, "straight");
  assert.deepEqual(bytes(straight), [199, 100, 50, 128]);
});

test("alpha masks preserve straight color and scale premultiplied color with coverage", () => {
  const mask = surface([9, 8, 7, 128]);
  assert.deepEqual([...applyAlphaMaskRgba(surface([120, 80, 40, 200]), mask).data], [120, 80, 40, 100]);
  const premultiplied = applyAlphaMaskRgba(surface([94, 63, 31, 200], 1, 1, "premultiplied"), mask);
  assert.equal(premultiplied.alphaMode, "premultiplied");
  assert.deepEqual([...premultiplied.data], [47, 32, 16, 100]);
});

test("luminance masks use linear Rec. 709 luminance multiplied by mask alpha", () => {
  const target = surface([120, 80, 40, 255]);
  assert.deepEqual([...applyLuminanceMaskRgba(target, surface([255, 0, 0, 255])).data], [120, 80, 40, 54]);
  assert.deepEqual([...applyLuminanceMaskRgba(target, surface([255, 0, 0, 128])).data], [120, 80, 40, 27]);
  assert.deepEqual([...applyLuminanceMaskRgba(target, surface([255, 255, 255, 0])).data], [120, 80, 40, 0]);
  assert.deepEqual([...applyLuminanceMaskRgba(target, surface([128, 128, 128, 128], 1, 1, "premultiplied")).data], [120, 80, 40, 128]);
});

test("RGBA compositing rejects invalid dimensions, lengths, alpha modes, and blend modes", () => {
  const pixel = surface([0, 0, 0, 0]);
  assert.throws(() => compositeRgba(pixel, surface([0, 0, 0, 0, 0, 0, 0, 0], 2, 1)), /dimensions must match/);
  assert.throws(() => compositeRgba(pixel, surface([0, 0, 0], 1, 1)), /buffer length/);
  assert.throws(() => compositeRgba(pixel, { data: new Uint8Array(0), width: 0, height: 1 }), /positive safe integers/);
  assert.throws(() => compositeRgba(pixel, { ...pixel, alphaMode: "associated" as RgbaAlphaMode }), /alphaMode/);
  assert.throws(() => compositeRgba(pixel, pixel, { mode: "divide" as RgbaBlendMode }), /Unsupported CUT RGBA blend mode/);
  assert.throws(() => compositeRgba(pixel, pixel, { outputAlphaMode: "associated" as RgbaAlphaMode }), /outputAlphaMode/);
  assert.throws(() => applyAlphaMaskRgba(pixel, surface([0, 0, 0, 0, 0, 0, 0, 0], 1, 2)), /dimensions must match/);
});

test("RGBA compositing remains linear in a modest frame-sized workload", () => {
  const width = 512, height = 288;
  const backdrop = new Uint8Array(width * height * 4);
  const source = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < backdrop.length; offset += 4) {
    backdrop.set([31, 97, 181, 255], offset);
    source.set([221, 73, 19, 137], offset);
  }
  const started = performance.now();
  const result = compositeRgba({ data: backdrop, width, height }, { data: source, width, height }, { mode: "overlay" });
  const elapsed = performance.now() - started;
  assert.equal(result.data.length, width * height * 4);
  assert.ok(elapsed < 10_000, `512×288 compositing took ${elapsed.toFixed(1)} ms`);
});

test("CUT Composite executes source-ordered layers and every documented blend mode", async () => {
  const first = await renderKernel('Composite() { Rect(width: 4px, height: 4px, fill: #ff0000); Rect(width: 4px, height: 4px, fill: #0000ff); }');
  const reversed = await renderKernel('Composite() { Rect(width: 4px, height: 4px, fill: #0000ff); Rect(width: 4px, height: 4px, fill: #ff0000); }');
  assert.deepEqual(pixel(first.frame), [0, 0, 255, 255]);
  assert.deepEqual(pixel(reversed.frame), [255, 0, 0, 255]);

  const backdrop = surface([64, 128, 192, 255]), source = surface([192, 128, 64, 255]);
  for (const mode of ["normal", "source-over", "multiply", "screen", "overlay", "darken", "lighten", "add", "plus", "difference"] as const) {
    const rendered = await renderKernel(`Composite(blend: "${mode}") { Rect(width: 4px, height: 4px, fill: #4080c0); Rect(width: 4px, height: 4px, fill: #c08040); }`);
    assert.deepEqual(pixel(rendered.frame), bytes(compositeRgba(backdrop, source, { mode })), mode);
    assert.equal(Object.values(rendered.ir.nodes).find((node) => node.op === "cut.visual.composite")?.inputs.blend.kind, "string");
  }
});

test("CUT Mask executes target-then-matte alpha and luminance semantics deterministically", async () => {
  const alpha = await renderKernel('Mask(mode: "alpha") { Rect(width: 4px, height: 4px, fill: #ff0000); Rect(width: 4px, height: 4px, fill: #ffffff80); }');
  const alphaReplay = await renderKernel('Mask(mode: "alpha") { Rect(width: 4px, height: 4px, fill: #ff0000); Rect(width: 4px, height: 4px, fill: #ffffff80); }');
  const luminance = await renderKernel('Mask(mode: "luminance") { Rect(width: 4px, height: 4px, fill: #ff0000); Rect(width: 4px, height: 4px, fill: #ff0000); }');
  assert.deepEqual(alpha.frame.data, alphaReplay.frame.data);
  assertPixelClose(pixel(alpha.frame), [130, 5, 8, 255]);
  assertPixelClose(pixel(luminance.frame), [58, 9, 13, 255]);

  const reversed = await renderKernel('Mask(mode: "alpha") { Rect(width: 4px, height: 4px, fill: #ffffff80); Rect(width: 4px, height: 4px, fill: #ff0000); }');
  assert.notDeepEqual(pixel(reversed.frame), pixel(alpha.frame), "reversing target and matte must change the result");
});

test("reference validation refuses ambiguous masks and unknown modes before frame work", () => {
  for (const body of [
    'Mask() { Rect(width: 4px, height: 4px); }',
    'Mask() { Rect(width: 4px, height: 4px); Rect(width: 4px, height: 4px); Rect(width: 4px, height: 4px); }',
  ]) {
    assert.throws(() => compileKernel(body), (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT2085" && /requires exactly two visual children: target, then matte/.test(item.message)));
  }
  const invalidMask = compileKernel('Mask(mode: "alpha") { Rect(width: 4px, height: 4px); Rect(width: 4px, height: 4px); }');
  const mask = Object.values(invalidMask.nodes).find((node) => node.op === "cut.visual.mask"); assert.ok(mask);
  mask.inputs.mode = { kind: "string", value: "inverse" };
  assert.throws(() => validateReferenceSession(invalidMask), /mode.*one of: alpha, luminance, red, green, blue/);

  const invalidComposite = compileKernel('Composite(blend: "normal") { Rect(width: 4px, height: 4px); Rect(width: 4px, height: 4px); }');
  const composite = Object.values(invalidComposite.nodes).find((node) => node.op === "cut.visual.composite"); assert.ok(composite);
  composite.inputs.blend = { kind: "string", value: "divide" };
  assert.throws(() => validateReferenceSession(invalidComposite), /blend must be one of: normal, source-over, multiply/);
});
