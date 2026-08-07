import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RgbaAlphaMode, RgbaSurface } from "../lib/runtime/reference/compositing";
import {
  accumulateReferenceMotionBlur,
  createReferenceMotionBlurPlan,
  ReferenceMotionBlurError,
  type ReferenceMotionBlurConfig,
  type ReferenceMotionBlurPlan,
} from "../lib/runtime/reference/motion-blur";
import { rational } from "../lib/language/rational";

function config(shutterNumerator = 180, shutterDenominator = 1, samples = 2): ReferenceMotionBlurConfig {
  return { shutterAngle: rational(shutterNumerator, shutterDenominator), samples };
}

function plan(samples = 2) {
  return createReferenceMotionBlurPlan(rational(0), rational(1, 24), config(180, 1, samples));
}

function surface(width: number, height: number, bytes: readonly number[], alphaMode?: RgbaAlphaMode): RgbaSurface {
  return { data: Uint8Array.from(bytes), width, height, ...(alphaMode ? { alphaMode } : {}) };
}

function solid(rgba: readonly number[], width = 1, height = 1, alphaMode?: RgbaAlphaMode): RgbaSurface {
  return surface(width, height, Array.from({ length: width * height }, () => rgba).flat(), alphaMode);
}

const bytes = (value: { data: Uint8Array }) => [...value.data];
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function expectCode(work: () => unknown, code: ReferenceMotionBlurError["code"]) {
  assert.throws(work, (error: unknown) => error instanceof ReferenceMotionBlurError && error.code === code);
}

test("centered shutter planning uses exact uniform midpoint times and weights", () => {
  const result = createReferenceMotionBlurPlan(rational(10), rational(1, 24), config(180, 1, 4));
  assert.deepEqual(result, {
    outputTime: rational(10),
    frameDuration: rational(1, 24),
    shutterAngle: rational(180),
    exposureDuration: rational(1, 48),
    samples: [
      { index: 0, time: rational(1_279, 128), weight: rational(1, 4) },
      { index: 1, time: rational(3_839, 384), weight: rational(1, 4) },
      { index: 2, time: rational(3_841, 384), weight: rational(1, 4) },
      { index: 3, time: rational(1_281, 128), weight: rational(1, 4) },
    ],
  });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.samples) && result.samples.every(Object.isFrozen));
});

test("NTSC schedules remain exact and expose rather than silently clamp boundary samples", () => {
  const result = createReferenceMotionBlurPlan(rational(0), rational(1_001, 30_000), config(180, 1, 2));
  assert.deepEqual(result.exposureDuration, rational(1_001, 60_000));
  assert.deepEqual(result.samples.map((sample) => sample.time), [rational(-1_001, 240_000), rational(1_001, 240_000)]);
  assert.deepEqual(result.samples.map((sample) => sample.weight), [rational(1, 2), rational(1, 2)]);
});

test("opaque black and white average in linear light, not encoded sRGB", () => {
  const result = accumulateReferenceMotionBlur(plan(), [solid([0, 0, 0, 255]), solid([255, 255, 255, 255])]);
  assert.deepEqual(bytes(result), [188, 188, 188, 255]);
  assert.equal(result.alphaMode, "straight");
});

test("premultiplied linear accumulation removes hidden RGB and preserves straight color under partial coverage", () => {
  const result = accumulateReferenceMotionBlur(plan(), [
    solid([255, 0, 0, 255]),
    solid([0, 255, 255, 0]),
  ]);
  assert.deepEqual(bytes(result), [255, 0, 0, 128], "transparent cyan cannot tint or darken visible red");

  const hiddenOnly = accumulateReferenceMotionBlur(plan(), [solid([255, 1, 99, 0]), solid([4, 250, 80, 0])]);
  assert.deepEqual(bytes(hiddenOnly), [0, 0, 0, 0]);

  const premultipliedOutput = accumulateReferenceMotionBlur(plan(), [
    solid([255, 0, 0, 255]),
    solid([200, 100, 50, 0]),
  ], { outputAlphaMode: "premultiplied" });
  assert.deepEqual(bytes(premultipliedOutput), [128, 0, 0, 128]);
  assert.equal(premultipliedOutput.alphaMode, "premultiplied");
});

test("straight and conventional premultiplied inputs with equivalent coverage accumulate identically", () => {
  const straight = accumulateReferenceMotionBlur(plan(), [solid([255, 0, 0, 128]), solid([0, 0, 255, 128])]);
  const premultiplied = accumulateReferenceMotionBlur(plan(), [
    solid([128, 0, 0, 128], 1, 1, "premultiplied"),
    solid([0, 0, 128, 128], 1, 1, "premultiplied"),
  ]);
  assert.deepEqual(bytes(premultiplied), bytes(straight));
  assert.deepEqual(bytes(straight), [188, 0, 188, 128]);
});

test("multi-pixel accumulation has deterministic byte output across independent runs", () => {
  const schedule = plan(4);
  const samples = [
    surface(2, 1, [255, 0, 0, 255, 0, 0, 0, 0]),
    surface(2, 1, [0, 255, 0, 192, 255, 255, 255, 64]),
    surface(2, 1, [0, 0, 255, 128, 255, 0, 255, 128]),
    surface(2, 1, [255, 255, 255, 0, 0, 255, 255, 255]),
  ];
  const first = accumulateReferenceMotionBlur(schedule, samples);
  const second = accumulateReferenceMotionBlur(structuredClone(schedule), samples.map((sample) => ({ ...sample, data: sample.data.slice() })));
  assert.deepEqual(bytes(second), bytes(first));
  assert.equal(digest(first.data), "f2ac98ce5c4454a3b374dbf76a25fd5c3310e29ccb5b8f71ef5e7c98302f8a68");
});

test("the temporal contract rejects semantic no-ops but stationary content remains valid", () => {
  expectCode(() => createReferenceMotionBlurPlan(rational(0), rational(1, 24), config(0, 1, 8)), "CUT_MOTION_BLUR_NOOP");
  expectCode(() => createReferenceMotionBlurPlan(rational(0), rational(1, 24), config(180, 1, 1)), "CUT_MOTION_BLUR_NOOP");
  const stationary = solid([12, 34, 56, 200]);
  assert.deepEqual(bytes(accumulateReferenceMotionBlur(plan(), [stationary, stationary])), [12, 34, 56, 200]);
});

test("hostile config is closed and rational/sample budgets apply before exact arithmetic", () => {
  const hostileKey = `bad\0\n${"x".repeat(20_000)}😀`;
  const hostile = Object.create(null) as Record<string, unknown>;
  hostile.shutterAngle = rational(180);
  hostile.samples = 2;
  hostile[hostileKey] = true;
  assert.throws(
    () => createReferenceMotionBlurPlan(rational(0), rational(1, 24), hostile as unknown as ReferenceMotionBlurConfig),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceMotionBlurError);
      assert.equal(error.code, "CUT_MOTION_BLUR_CONFIG");
      assert.ok(error.message.length < 1_024);
      assert.doesNotMatch(error.message, /[\0\n]/u);
      assert.match(error.message, /sha256:/u);
      return true;
    },
  );

  let getterCalls = 0;
  const accessor = { samples: 2 } as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "shutterAngle", { enumerable: true, get() { getterCalls += 1; return rational(180); } });
  expectCode(() => createReferenceMotionBlurPlan(rational(0), rational(1, 24), accessor as unknown as ReferenceMotionBlurConfig), "CUT_MOTION_BLUR_CONFIG");
  assert.equal(getterCalls, 0, "configuration accessors are rejected without execution");

  const huge = "9".repeat(20_000);
  expectCode(() => createReferenceMotionBlurPlan(rational(0), rational(1, 24), {
    shutterAngle: { numerator: huge, denominator: "1" },
    samples: 2,
  }), "CUT_MOTION_BLUR_BUDGET");
  expectCode(() => createReferenceMotionBlurPlan(rational(0), rational(1, 24), config(180, 1, 33)), "CUT_MOTION_BLUR_BUDGET");
  expectCode(() => createReferenceMotionBlurPlan(rational(0), rational(0), config()), "CUT_MOTION_BLUR_CONFIG");
  expectCode(() => createReferenceMotionBlurPlan(rational(0), rational(1, 24), config(361)), "CUT_MOTION_BLUR_CONFIG");
});

test("tampered plans cannot alter times, weights, exposure, or sample count", () => {
  const cases: Array<(value: ReferenceMotionBlurPlan) => void> = [
    (value) => { (value as { exposureDuration: ReturnType<typeof rational> }).exposureDuration = rational(1); },
    (value) => { (value.samples[0] as { time: ReturnType<typeof rational> }).time = rational(0); },
    (value) => { (value.samples[0] as { weight: ReturnType<typeof rational> }).weight = rational(3, 4); },
    (value) => { (value.samples[0] as { index: number }).index = 1; },
    (value) => { (value.samples as Array<unknown>).pop(); },
  ];
  for (const mutate of cases) {
    const value = structuredClone(plan());
    mutate(value);
    expectCode(() => accumulateReferenceMotionBlur(value, [solid([0, 0, 0, 255]), solid([255, 255, 255, 255])]), "CUT_MOTION_BLUR_PLAN");
  }
});

test("surface shape, alpha mode, and work budgets fail before accumulation", () => {
  const schedule = plan();
  const pixel = solid([0, 0, 0, 255]);
  expectCode(() => accumulateReferenceMotionBlur(schedule, [pixel]), "CUT_MOTION_BLUR_SURFACE");
  expectCode(() => accumulateReferenceMotionBlur(schedule, [pixel, solid([0, 0, 0, 255], 2, 1)]), "CUT_MOTION_BLUR_SURFACE");
  expectCode(() => accumulateReferenceMotionBlur(schedule, [pixel, { ...pixel, data: new Uint8Array(3) }]), "CUT_MOTION_BLUR_SURFACE");
  expectCode(() => accumulateReferenceMotionBlur(schedule, [pixel, { ...pixel, alphaMode: "associated" as RgbaAlphaMode }]), "CUT_MOTION_BLUR_SURFACE");

  const twoByTwo = solid([0, 0, 0, 255], 2, 2);
  expectCode(() => accumulateReferenceMotionBlur(schedule, [twoByTwo, twoByTwo], { limits: { maxPixels: 3 } }), "CUT_MOTION_BLUR_BUDGET");
  expectCode(() => accumulateReferenceMotionBlur(schedule, [twoByTwo, twoByTwo], { limits: { maxPixelSamples: 7 } }), "CUT_MOTION_BLUR_BUDGET");

  const sparse = new Array<RgbaSurface>(2);
  sparse[0] = pixel;
  expectCode(() => accumulateReferenceMotionBlur(schedule, sparse), "CUT_MOTION_BLUR_PLAN");

  const oversized = new Array<RgbaSurface>(1_000);
  expectCode(() => accumulateReferenceMotionBlur(schedule, oversized), "CUT_MOTION_BLUR_BUDGET");
});
