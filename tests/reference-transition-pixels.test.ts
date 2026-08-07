import test from "node:test";
import assert from "node:assert/strict";
import {
  applyReferencePictureTransition,
  type ReferencePictureTransition,
} from "../lib/runtime/reference/transition";

const base: ReferencePictureTransition = {
  kind: "cross-dissolve",
  direction: "left",
  softness: 0,
  dipColor: [0, 0, 0, 1],
};

function solid(width: number, height: number, color: readonly [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { data, width, height, alphaMode: "straight" as const };
}

function row(colors: readonly (readonly [number, number, number, number])[]) {
  const data = new Uint8Array(colors.length * 4);
  colors.forEach((color, index) => data.set(color, index * 4));
  return { data, width: colors.length, height: 1, alphaMode: "straight" as const };
}

function flatGrid(width: number, colors: readonly (readonly [number, number, number, number])[]) {
  assert.equal(colors.length % width, 0);
  const data = new Uint8Array(colors.length * 4);
  colors.forEach((color, index) => data.set(color, index * 4));
  return { data, width, height: colors.length / width, alphaMode: "straight" as const };
}

type Rgba = readonly [number, number, number, number];

function grid(rows: readonly (readonly Rgba[])[], alphaMode: "straight" | "premultiplied" = "straight") {
  assert.ok(rows.length > 0 && rows[0].length > 0);
  const width = rows[0].length;
  assert.ok(rows.every((value) => value.length === width));
  const data = new Uint8Array(width * rows.length * 4);
  rows.flat().forEach((color, index) => data.set(color, index * 4));
  return { data, width, height: rows.length, alphaMode };
}

function premultiplied(surface: ReturnType<typeof grid>) {
  const data = Uint8Array.from(surface.data);
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    for (let channel = 0; channel < 3; channel += 1) data[offset + channel] = Math.round(data[offset + channel] * alpha / 255);
  }
  return { ...surface, data, alphaMode: "premultiplied" as const };
}

function pixel(data: Uint8Array, index: number) { return [...data.slice(index * 4, index * 4 + 4)]; }

test("picture cross-dissolve is endpoint exact and mixes opaque pixels in linear-light sRGB", () => {
  const red = solid(1, 1, [255, 0, 0, 255]), blue = solid(1, 1, [0, 0, 255, 255]);
  assert.deepEqual(pixel(applyReferencePictureTransition(red, blue, base, 0).data, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(applyReferencePictureTransition(red, blue, base, 1).data, 0), [0, 0, 255, 255]);
  const middle = pixel(applyReferencePictureTransition(red, blue, base, .5).data, 0);
  assert.ok(middle[0] >= 187 && middle[0] <= 189, String(middle));
  assert.equal(middle[1], 0);
  assert.ok(middle[2] >= 187 && middle[2] <= 189, String(middle));
  assert.equal(middle[3], 255);
});

test("dip reaches the authored color and wipe direction/softness change pixels", () => {
  const white = solid(3, 1, [255, 255, 255, 255]), blue = solid(3, 1, [0, 0, 255, 255]);
  const dip = applyReferencePictureTransition(white, blue, { ...base, kind: "dip", dipColor: [0, 0, 0, 1] }, .5);
  assert.deepEqual(pixel(dip.data, 1), [0, 0, 0, 255]);

  const hard = applyReferencePictureTransition(white, blue, { ...base, kind: "wipe", direction: "left" }, .5);
  assert.deepEqual([pixel(hard.data, 0), pixel(hard.data, 1), pixel(hard.data, 2)], [
    [255, 255, 255, 255], [0, 0, 255, 255], [0, 0, 255, 255],
  ]);
  const soft = applyReferencePictureTransition(white, blue, { ...base, kind: "wipe", direction: "left", softness: 1 }, .5);
  const center = pixel(soft.data, 1);
  assert.ok(center[0] > 100 && center[0] < 230 && center[2] === 255, String(center));
  for (const direction of ["left", "right", "up", "down"] as const) {
    for (const softness of [0, 1]) {
      const transition = { ...base, kind: "wipe" as const, direction, softness };
      assert.deepEqual(applyReferencePictureTransition(white, blue, transition, 0).data, white.data, `${direction}/${softness}/0`);
      assert.deepEqual(applyReferencePictureTransition(white, blue, transition, 1).data, blue.data, `${direction}/${softness}/1`);
    }
  }
  const onePixel = solid(1, 1, [12, 34, 56, 255]);
  const onePixelBlue = solid(1, 1, [0, 0, 255, 255]);
  assert.deepEqual(applyReferencePictureTransition(onePixel, onePixelBlue, { ...base, kind: "wipe", softness: 1 }, 0).data, onePixel.data);
  const early = pixel(applyReferencePictureTransition(white, blue, { ...base, kind: "wipe", softness: 1 }, 1e-6).data, 2);
  const later = pixel(applyReferencePictureTransition(white, blue, { ...base, kind: "wipe", softness: 1 }, .05).data, 2);
  assert.ok(early[0] > 250, `soft wipe jumped at its leading edge: ${early}`);
  assert.ok(later[0] < early[0] && later[0] > 245, `soft wipe is not continuous/monotone: ${early} -> ${later}`);
  const nearlyDone = pixel(applyReferencePictureTransition(white, blue, { ...base, kind: "wipe", softness: 1 }, .99).data, 0);
  assert.ok(nearlyDone[0] > 0 && nearlyDone[0] < 15, `soft wipe trailing edge is discontinuous: ${nearlyDone}`);
});

test("slide overlays the incoming edge while push moves both outgoing and incoming pixels", () => {
  const outgoing = row([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
  const incoming = row([[255, 255, 0, 255], [255, 0, 255, 255], [0, 255, 255, 255]]);
  const slide = applyReferencePictureTransition(outgoing, incoming, { ...base, kind: "slide", direction: "left" }, 1 / 3);
  assert.deepEqual([pixel(slide.data, 0), pixel(slide.data, 1), pixel(slide.data, 2)], [
    [255, 0, 0, 255], [0, 255, 0, 255], [255, 255, 0, 255],
  ]);
  const push = applyReferencePictureTransition(outgoing, incoming, { ...base, kind: "push", direction: "left" }, 1 / 3);
  assert.deepEqual([pixel(push.data, 0), pixel(push.data, 1), pixel(push.data, 2)], [
    [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255],
  ]);

  const transparentIncoming = row([[255, 255, 0, 128], [255, 0, 255, 128], [0, 255, 255, 128]]);
  const alphaPush = applyReferencePictureTransition(outgoing, transparentIncoming, { ...base, kind: "push", direction: "left" }, 1 / 3);
  const edge = pixel(alphaPush.data, 2);
  assert.ok(edge[0] > 250 && edge[1] > 250 && edge[2] < 5 && edge[3] >= 127 && edge[3] <= 129, String(edge));

  const squareA = solid(3, 3, [255, 0, 0, 255]), squareB = solid(3, 3, [0, 0, 255, 255]);
  for (const direction of ["left", "right", "up", "down"] as const) {
    const oddPush = applyReferencePictureTransition(squareA, squareB, { ...base, kind: "push", direction }, .5);
    for (let offset = 3; offset < oddPush.data.length; offset += 4) assert.equal(oddPush.data[offset], 255, `${direction} push seam at byte ${offset}`);
  }
});

test("wipe, push, and slide preserve asymmetric content orientation in every direction", () => {
  const o = [
    [[11, 12, 13, 255], [21, 22, 23, 255], [31, 32, 33, 255]],
    [[41, 42, 43, 255], [51, 52, 53, 255], [61, 62, 63, 255]],
    [[71, 72, 73, 255], [81, 82, 83, 255], [91, 92, 93, 255]],
  ] as const satisfies readonly (readonly Rgba[])[];
  const i = [
    [[111, 112, 113, 255], [121, 122, 123, 255], [131, 132, 133, 255]],
    [[141, 142, 143, 255], [151, 152, 153, 255], [161, 162, 163, 255]],
    [[171, 172, 173, 255], [181, 182, 183, 255], [191, 192, 193, 255]],
  ] as const satisfies readonly (readonly Rgba[])[];
  const outgoing = grid(o), incoming = grid(i);
  const expectedWipe = {
    left: [[o[0][0], i[0][1], i[0][2]], [o[1][0], i[1][1], i[1][2]], [o[2][0], i[2][1], i[2][2]]],
    right: [[i[0][0], i[0][1], o[0][2]], [i[1][0], i[1][1], o[1][2]], [i[2][0], i[2][1], o[2][2]]],
    up: [o[0], i[1], i[2]],
    down: [i[0], i[1], o[2]],
  } as const;
  const expectedPush = {
    left: [[o[0][1], o[0][2], i[0][0]], [o[1][1], o[1][2], i[1][0]], [o[2][1], o[2][2], i[2][0]]],
    right: [[i[0][2], o[0][0], o[0][1]], [i[1][2], o[1][0], o[1][1]], [i[2][2], o[2][0], o[2][1]]],
    up: [o[1], o[2], i[0]],
    down: [i[2], o[0], o[1]],
  } as const;
  const expectedSlide = {
    left: [[o[0][0], o[0][1], i[0][0]], [o[1][0], o[1][1], i[1][0]], [o[2][0], o[2][1], i[2][0]]],
    right: [[i[0][2], o[0][1], o[0][2]], [i[1][2], o[1][1], o[1][2]], [i[2][2], o[2][1], o[2][2]]],
    up: [o[0], o[1], i[0]],
    down: [i[2], o[1], o[2]],
  } as const;

  for (const direction of ["left", "right", "up", "down"] as const) {
    const wipe = applyReferencePictureTransition(outgoing, incoming, { ...base, kind: "wipe", direction }, .5);
    assert.deepEqual(wipe.data, grid(expectedWipe[direction]).data, `${direction} wipe orientation`);
    const push = applyReferencePictureTransition(outgoing, incoming, { ...base, kind: "push", direction }, 1 / 3);
    assert.deepEqual(push.data, grid(expectedPush[direction]).data, `${direction} push orientation`);
    const slide = applyReferencePictureTransition(outgoing, incoming, { ...base, kind: "slide", direction }, 1 / 3);
    assert.deepEqual(slide.data, grid(expectedSlide[direction]).data, `${direction} slide orientation`);
  }
});

test("all picture transitions treat equivalent straight and premultiplied alpha identically", () => {
  // These channel/alpha pairs premultiply to exact integer bytes, so this is
  // an exact representation-equivalence assertion rather than a tolerance for
  // a differently quantized source.
  const outgoing = grid(Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => [240, 120, 60, 85] as const)));
  const incoming = grid(Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => [30, 210, 90, 170] as const)));
  const outgoingPremultiplied = premultiplied(outgoing), incomingPremultiplied = premultiplied(incoming);
  const cases: readonly ReferencePictureTransition[] = [
    { ...base, kind: "cross-dissolve" },
    { ...base, kind: "dip", dipColor: [.2, .4, .6, .5] },
    { ...base, kind: "wipe", direction: "right", softness: .3 },
    { ...base, kind: "push", direction: "up" },
    { ...base, kind: "slide", direction: "down" },
  ];
  for (const transition of cases) {
    const straight = applyReferencePictureTransition(outgoing, incoming, transition, .37);
    const premult = applyReferencePictureTransition(outgoingPremultiplied, incomingPremultiplied, transition, .37);
    assert.deepEqual(premult.data, straight.data, transition.kind);
  }
});

test("transparent hidden RGB cannot bleed through any picture transition", () => {
  const visibleOutgoing: Rgba = [60, 120, 180, 255], visibleIncoming: Rgba = [210, 90, 30, 255];
  const outgoingCleanRows: Rgba[][] = [], outgoingHiddenRows: Rgba[][] = [];
  const incomingCleanRows: Rgba[][] = [], incomingHiddenRows: Rgba[][] = [];
  for (let y = 0; y < 3; y += 1) {
    outgoingCleanRows[y] = []; outgoingHiddenRows[y] = [];
    incomingCleanRows[y] = []; incomingHiddenRows[y] = [];
    for (let x = 0; x < 3; x += 1) {
      const outgoingTransparent = (x + y) % 2 === 0, incomingTransparent = (x + y) % 2 === 1;
      outgoingCleanRows[y][x] = outgoingTransparent ? [0, 0, 0, 0] : visibleOutgoing;
      outgoingHiddenRows[y][x] = outgoingTransparent ? [255, 1, 254, 0] : visibleOutgoing;
      incomingCleanRows[y][x] = incomingTransparent ? [0, 0, 0, 0] : visibleIncoming;
      incomingHiddenRows[y][x] = incomingTransparent ? [2, 253, 252, 0] : visibleIncoming;
    }
  }
  const modes = ["straight", "premultiplied"] as const;
  const cases: readonly ReferencePictureTransition[] = [
    { ...base, kind: "cross-dissolve" },
    { ...base, kind: "dip", dipColor: [.1, .2, .3, .4] },
    ...(["left", "right", "up", "down"] as const).flatMap((direction) => [
      { ...base, kind: "wipe" as const, direction, softness: .25 },
      { ...base, kind: "push" as const, direction },
      { ...base, kind: "slide" as const, direction },
    ]),
  ];
  for (const alphaMode of modes) {
    const outgoingClean = grid(outgoingCleanRows, alphaMode), incomingClean = grid(incomingCleanRows, alphaMode);
    const outgoingHidden = grid(outgoingHiddenRows, alphaMode), incomingHidden = grid(incomingHiddenRows, alphaMode);
    for (const transition of cases) {
      const clean = applyReferencePictureTransition(outgoingClean, incomingClean, transition, .37);
      const hidden = applyReferencePictureTransition(outgoingHidden, incomingHidden, transition, .37);
      assert.deepEqual(hidden.data, clean.data, `${alphaMode}/${transition.kind}/${transition.direction}`);
      for (let offset = 0; offset < hidden.data.length; offset += 4) {
        if (hidden.data[offset + 3] === 0) assert.deepEqual([...hidden.data.subarray(offset, offset + 3)], [0, 0, 0], `${alphaMode}/${transition.kind}/transparent pixel ${offset / 4}`);
      }
    }
  }
});

test("every accepted direction and dip color changes executable picture pixels", () => {
  const outgoing = flatGrid(3, [
    [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
    [255, 255, 0, 255], [255, 0, 255, 255], [0, 255, 255, 255],
    [64, 32, 16, 255], [96, 160, 224, 255], [240, 128, 32, 255],
  ]);
  const incoming = flatGrid(3, [
    [10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255],
    [100, 110, 120, 255], [130, 140, 150, 255], [160, 170, 180, 255],
    [190, 200, 210, 255], [220, 230, 240, 255], [250, 245, 235, 255],
  ]);
  const key = (data: Uint8Array) => Buffer.from(data).toString("hex");
  for (const kind of ["wipe", "push", "slide"] as const) {
    const outputs = new Set(
      (["left", "right", "up", "down"] as const).map((direction) => key(
        applyReferencePictureTransition(outgoing, incoming, { ...base, kind, direction }, 1 / 3).data,
      )),
    );
    assert.equal(outputs.size, 4, `${kind} accepted a direction that did not alter pixels`);
  }

  const redDip = applyReferencePictureTransition(outgoing, incoming, { ...base, kind: "dip", dipColor: [1, 0, 0, 1] }, .5);
  const translucentGreenDip = applyReferencePictureTransition(outgoing, incoming, { ...base, kind: "dip", dipColor: [0, 1, 0, .5] }, .5);
  assert.deepEqual(pixel(redDip.data, 4), [255, 0, 0, 255]);
  assert.deepEqual(pixel(translucentGreenDip.data, 4), [0, 255, 0, 128]);
  assert.notEqual(key(redDip.data), key(translucentGreenDip.data));
});

test("picture transition rejects malformed surfaces and controls", () => {
  const red = solid(1, 1, [255, 0, 0, 255]), blue = solid(1, 1, [0, 0, 255, 255]);
  assert.throws(() => applyReferencePictureTransition({ ...red, data: new Uint8Array(3) }, blue, base, .5), /buffer length/);
  assert.throws(() => applyReferencePictureTransition(red, solid(2, 1, [0, 0, 255, 255]), base, .5), /identical dimensions/);
  assert.throws(() => applyReferencePictureTransition(red, blue, { ...base, softness: 2 }, .5), /softness/);
  assert.throws(() => applyReferencePictureTransition(red, blue, base, Number.NaN), /finite/);
});
