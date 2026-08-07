import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { CutAVIR, IRSignal, IRValue } from "../lib/language/ir";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational, zeroRational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import {
  ReferenceColorGradeConfigError,
  referenceColorGradeConfigAt,
  referenceColorGradeLimits,
} from "../lib/runtime/reference/color-grade-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { ReferenceNoOpContractError } from "../lib/runtime/reference/noop-contract";

function program(body: string) {
  return `cut 0.4;
project "color grade contract proof";
import { ColorGrade, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 32px, height: 24px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(body: string) {
  const cutModule = parse(program(body)), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function grade(ir: CutAVIR) {
  return Object.values(ir.nodes).find((node) => node.op === "cut.visual.color_grade")!;
}

function digest(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

async function render(body: string, frame = 0) {
  const ir = compile(body), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-color-grade-contract-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try { return { ir, pixels: (await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], frame)).data }; }
  finally { renderer.close(); }
}

const card = "Rect(width: 32px, height: 24px, fill: #406080);";

test("ColorGrade source API is closed and statically typed", () => {
  for (const [body, expected] of [
    [`ColorGrade(brightness: 50%) { ${card} }`, /brightness.*expects Number.*Ratio/],
    [`ColorGrade(hue: 1) { ${card} }`, /hue.*expects Angle.*Number/],
    [`ColorGrade(exposure: 1deg) { ${card} }`, /exposure.*expects Number.*Angle/],
    [`ColorGrade(temperature: 50%) { ${card} }`, /temperature.*expects Number.*Ratio/],
    [`ColorGrade(tint: 1s) { ${card} }`, /tint.*expects Number.*Time/],
    [`ColorGrade(kelvin: 5600) { ${card} }`, /does not execute input “kelvin”/],
  ] as const) {
    const cutModule = parse(program(body));
    assert.match(checkCutModule(cutModule).diagnostics.map((item) => item.message).join("\n"), expected);
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }
});

test("ColorGrade exact bounds and graph shape fail with stable source-located codes", () => {
  assert.deepEqual(referenceColorGradeLimits, {
    exposure: { minimum: -16, maximum: 16, default: 0 },
    temperature: { minimum: -1, maximum: 1, default: 0 },
    tint: { minimum: -1, maximum: 1, default: 0 },
    brightness: { minimum: 0.01, maximum: 4, default: 1 },
    saturation: { minimum: 0, maximum: 4, default: 1 },
    contrast: { minimum: 0, maximum: 4, default: 1 },
    hue: { minimumDegrees: -360_000, maximumDegrees: 360_000, defaultDegrees: 0 },
  });

  for (const [body, code] of [
    [`ColorGrade(exposure: -16.01) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(exposure: 16.01) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(temperature: -1.01) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(temperature: 1.01) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(tint: -1.01) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(tint: 1.01) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(brightness: 0) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(saturation: -0.01) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(contrast: 4.01) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
    [`ColorGrade(hue: 360001deg) { ${card} }`, "CUT_COLOR_VALUE_RANGE"],
  ] as const) {
    assert.throws(() => validateReferenceSession(compile(body)), (error: unknown) => {
      assert.ok(error instanceof ReferenceColorGradeConfigError);
      assert.equal(error.code, code);
      assert.match(error.message, /project\.cut:\d+:\d+/);
      return true;
    });
  }
  for (const body of ["ColorGrade();", `ColorGrade() { ${card} ${card} }`]) {
    assert.throws(() => compile(body), (error: unknown) => {
      assert.ok(error instanceof CutCompileError);
      const diagnostic = error.result.diagnostics.find((item) => item.code === "CUT2085");
      assert.match(diagnostic?.message ?? "", /requires exactly one visual child/);
      assert.ok((diagnostic?.span.start.line ?? 0) > 0);
      return true;
    });
  }
  assert.doesNotThrow(() => validateReferenceSession(compile(`ColorGrade(exposure: -16, temperature: -1, tint: 1, brightness: 0.01, saturation: 4, hue: -360000deg, contrast: 0) { ${card} }`)));
  assert.doesNotThrow(() => validateReferenceSession(compile(`ColorGrade(exposure: 16, temperature: 1, tint: -1) { ${card} }`)));

  for (const body of [
    `ColorGrade() as look { ${card} } animate look.exposure from 0 to 17 over 1s;`,
    `ColorGrade() as look { ${card} } animate look.temperature from 0 to 1.01 over 1s;`,
    `ColorGrade() as look { ${card} } animate look.tint from 0 to -1.01 over 1s;`,
  ]) {
    assert.throws(() => validateReferenceSession(compile(body)), (error: unknown) => {
      assert.ok(error instanceof ReferenceColorGradeConfigError);
      assert.equal(error.code, "CUT_COLOR_VALUE_RANGE");
      assert.match(error.message, /events\[0\]\.to.*project\.cut:\d+:\d+|project\.cut:\d+:\d+.*events\[0\]\.to/);
      return true;
    });
  }

  const corrupted = compile(`ColorGrade(saturation: 1) { ${card} }`);
  grade(corrupted).inputs.saturation = { kind: "null" };
  assert.throws(() => validateReferenceSession(corrupted), (error: unknown) => {
    assert.ok(error instanceof ReferenceColorGradeConfigError);
    assert.equal(error.code, "CUT_COLOR_INPUT_TYPE");
    assert.match(error.message, /project\.cut:\d+:\d+.*canonical scalar/);
    return true;
  });
});

test("loaded IR cannot bypass ColorGrade type/range closure", () => {
  const authored = compileCutModule(parse(program(`ColorGrade(temperature: 0.25) { ${card} }`))).ir;
  const authoredGrade = grade(authored);
  authoredGrade.inputs.temperature = { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(1, 2) };
  finalizeGraphHashes(authored);
  const loaded = loadCutAvIr(JSON.stringify(authored));
  loaded.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(loaded), (error: unknown) => {
    assert.ok(error instanceof ReferenceColorGradeConfigError);
    assert.equal(error.code, "CUT_COLOR_INPUT_TYPE");
    assert.match(error.message, /project\.cut:\d+:\d+.*temperature.*canonical scalar/);
    return true;
  });
});

test("ColorGrade preflights every constant, step, keyframe, and track signal value", () => {
  const invalid: IRValue = { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(5) };
  const valid: IRValue = { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(1) };
  const curve: IRValue = { kind: "symbol", name: "cut:intrinsic#linear" };
  const cases: Array<[string, (base: IRSignal) => IRSignal, RegExp]> = [
    ["constant", (base) => ({ id: base.id, kind: "constant", valueType: "Number", value: invalid, contentHash: base.contentHash, provenance: base.provenance }), /\.value/],
    ["step", (base) => ({ id: base.id, kind: "step", valueType: "Number", points: [{ time: zeroRational, value: valid }, { time: rational(1, 2), value: invalid }], contentHash: base.contentHash, provenance: base.provenance }), /points\[1\]\.value/],
    ["keyframes", (base) => ({ id: base.id, kind: "keyframes", valueType: "Number", keyframes: [{ time: zeroRational, value: valid, curve }, { time: rational(1), value: invalid, curve }], contentHash: base.contentHash, provenance: base.provenance }), /keyframes\[1\]\.value/],
    ["track", (base) => ({ id: base.id, kind: "track", valueType: "Number", initial: valid, events: [{ kind: "animate", start: zeroRational, end: rational(1), from: valid, to: invalid, curve }], contentHash: base.contentHash, provenance: base.provenance }), /events\[0\]\.to/],
  ];

  for (const [name, makeSignal, expectedLabel] of cases) {
    const ir = compile(`ColorGrade() as look { ${card} } animate look.brightness from 1 to 2 over 1s;`);
    const reference = grade(ir).properties.brightness;
    assert.ok(reference && "signal" in reference, name);
    ir.signals[reference.signal] = makeSignal(ir.signals[reference.signal]);
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceColorGradeConfigError, name);
      assert.equal(error.code, "CUT_COLOR_VALUE_RANGE", name);
      assert.match(error.message, expectedLabel, name);
      assert.match(error.message, /project\.cut:\d+:\d+/, name);
      return true;
    });
  }

  const missing = compile(`ColorGrade() as look { ${card} } animate look.brightness from 1 to 2 over 1s;`);
  const reference = grade(missing).properties.brightness;
  assert.ok(reference && "signal" in reference);
  delete missing.signals[reference.signal];
  assert.throws(() => validateReferenceSession(missing), (error: unknown) => {
    assert.ok(error instanceof ReferenceColorGradeConfigError);
    assert.equal(error.code, "CUT_COLOR_SIGNAL");
    assert.match(error.message, /missing signal.*project\.cut:\d+:\d+|project\.cut:\d+:\d+.*missing signal/);
    return true;
  });

  const empty = compile(`ColorGrade() as look { ${card} } animate look.brightness from 1 to 2 over 1s;`);
  const emptyReference = grade(empty).properties.brightness;
  assert.ok(emptyReference && "signal" in emptyReference);
  const emptyBase = empty.signals[emptyReference.signal];
  empty.signals[emptyReference.signal] = { id: emptyBase.id, kind: "step", valueType: "Number", points: [], contentHash: emptyBase.contentHash, provenance: emptyBase.provenance };
  assert.throws(() => validateReferenceSession(empty), (error: unknown) => {
    assert.ok(error instanceof ReferenceNoOpContractError);
    assert.equal(error.code, "CUT_NODE_NOOP");
    assert.match(error.message, /property “brightness”.*has no step points.*project\.cut:\d+:\d+/);
    return true;
  });
});

test("CUT owns exact hue normalization and identity is byte-preserving", async () => {
  const negative = compile(`ColorGrade(hue: -30deg) { ${card} }`), wrapped = compile(`ColorGrade(hue: 360000deg) { ${card} }`);
  assert.equal(referenceColorGradeConfigAt(negative, grade(negative), zeroRational).hueDegrees, 330);
  assert.equal(referenceColorGradeConfigAt(wrapped, grade(wrapped), zeroRational).hueDegrees, 0);

  const plain = await render(card), identity = await render(`ColorGrade() { ${card} }`);
  assert.equal(digest(identity.pixels), digest(plain.pixels), "identity grade must not round-trip pixels through a native image operation");

  const negativePixels = await render(`ColorGrade(hue: -30deg) { ${card} }`);
  const normalizedPixels = await render(`ColorGrade(hue: 330deg) { ${card} }`);
  assert.equal(digest(negativePixels.pixels), digest(normalizedPixels.pixels), "equivalent normalized hues must render identically");
});

test("every grade primitive changes pixels and static/property execution is identical", async () => {
  const identity = await render(`ColorGrade() { ${card} }`);
  for (const authored of ["exposure: 1", "temperature: 1", "tint: 1", "brightness: 1.5", "saturation: 0", "hue: 90deg", "contrast: 1.5"]) {
    const changed = await render(`ColorGrade(${authored}) { ${card} }`);
    assert.notEqual(digest(changed.pixels), digest(identity.pixels), authored);
  }

  const staticGrade = await render(`ColorGrade(exposure: 0.5, temperature: 0.5, tint: -0.5, brightness: 1.5, saturation: 0.5, hue: 90deg, contrast: 1.25) { ${card} }`);
  const propertyGrade = await render(`ColorGrade() as look { ${card} } set look.exposure = 0.5; set look.temperature = 0.5; set look.tint = -0.5; set look.brightness = 1.5; set look.saturation = 0.5; set look.hue = 90deg; set look.contrast = 1.25;`);
  assert.equal(digest(propertyGrade.pixels), digest(staticGrade.pixels), "static inputs and executed properties must share one grade evaluator");

  for (const animation of [
    "animate look.exposure from 0 to 1 over 1s;",
    "animate look.temperature from 0 to 1 over 1s;",
    "animate look.tint from 0 to -1 over 1s;",
    "animate look.hue from 0deg to 180deg over 1s;",
  ]) {
    const animated = await render(`ColorGrade() as look { ${card} } ${animation}`, 3);
    assert.notEqual(digest(animated.pixels), digest(identity.pixels), `frame-sampled ${animation} must affect output pixels`);
  }
});

test("linear-light exposure and creative temperature/tint have locked pixel semantics and preserve alpha", async () => {
  const firstPixel = (pixels: Uint8Array) => [...pixels.subarray(0, 4)];
  assert.deepEqual(firstPixel((await render(`ColorGrade(exposure: 1) { ${card} }`)).pixels), [90, 133, 176, 255]);
  assert.deepEqual(firstPixel((await render(`ColorGrade(temperature: 1) { ${card} }`)).pixels), [76, 96, 109, 255]);
  assert.deepEqual(firstPixel((await render(`ColorGrade(tint: 1) { ${card} }`)).pixels), [70, 81, 139, 255]);
  assert.deepEqual(firstPixel((await render(`ColorGrade(exposure: 0.5, temperature: 0.5, tint: -0.5) { ${card} }`)).pixels), [79, 123, 133, 255]);

  const translucent = "Rect(width: 32px, height: 24px, fill: #40608040);";
  const before = await render(translucent), after = await render(`ColorGrade(exposure: 1, temperature: 0.5, tint: -0.5, brightness: 1.1, contrast: 1.1) { ${translucent} }`);
  const beforeAlpha = [...before.pixels].filter((_, index) => index % 4 === 3);
  const afterAlpha = [...after.pixels].filter((_, index) => index % 4 === 3);
  assert.deepEqual(afterAlpha, beforeAlpha, "every grade stage must preserve exact straight-alpha bytes");
});

test("ColorGrade has a fixed authored stage order and nesting can express a different order", async () => {
  const firstPixel = (pixels: Uint8Array) => [...pixels.subarray(0, 4)];
  const flat = await render(`ColorGrade(exposure: 1, contrast: 1.5) { ${card} }`);
  const reversedByNesting = await render(`ColorGrade(exposure: 1) { ColorGrade(contrast: 1.5) { ${card} } }`);
  assert.deepEqual(firstPixel(flat.pixels), [71, 135, 200, 255], "one grade runs linear exposure before encoded-sRGB contrast");
  assert.deepEqual(firstPixel(reversedByNesting.pixels), [47, 111, 176, 255], "inner contrast then outer exposure is observably different");
});
