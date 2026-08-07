import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import {
  applyMaskRgba,
  type RgbaAlphaMode,
  type RgbaSurface,
} from "../lib/runtime/reference/compositing";
import {
  ReferenceMaskError,
  referenceMaskConfig,
  referenceMaskLimits,
  validateReferenceMaskCanvas,
} from "../lib/runtime/reference/mask-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(body: string, width = 7, height = 7) {
  return `cut 0.4;
project "unrelated mask contract";
import { Composite, Mask, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 1, width: ${width}px, height: ${height}px, sampleRate: 8khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source: string) {
  const cutModule = parse(source);
  assert.deepEqual(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(cutModule).ir;
}

function maskNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.mask");
  assert.ok(node);
  return node;
}

function solid(width: number, height: number, rgba: readonly number[], alphaMode?: RgbaAlphaMode): RgbaSurface {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(rgba, offset);
  return { data, width, height, ...(alphaMode ? { alphaMode } : {}) };
}

function alphaMatte(rows: readonly (readonly number[])[], rgb: readonly number[] = [255, 255, 255]): RgbaSurface {
  const height = rows.length, width = rows[0]?.length ?? 0, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(rows[y].length, width);
    for (let x = 0; x < width; x += 1) data.set([...rgb, rows[y][x]], (y * width + x) * 4);
  }
  return { data, width, height };
}

function alphaPlane(surface: RgbaSurface) {
  const result: number[] = [];
  for (let offset = 3; offset < surface.data.length; offset += 4) result.push(surface.data[offset]);
  return result;
}

function pixel(surface: RgbaSurface, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function digest(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

async function render(source: string) {
  const ir = compile(source), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-mask-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]];
    return { ir, surface: await renderer.sceneFrame(scene, 0, false) };
  } finally { renderer.close(); }
}

function expectMaskError(action: () => unknown, code: ReferenceMaskError["code"], message?: RegExp) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceMaskError);
    assert.equal(error.code, code);
    assert.ok(error.source.module && error.source.line > 0 && error.source.column > 0 && error.source.nodeId);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("Mask is a closed typed two-child API and lowers every executable control canonically", () => {
  const symbol = packageSymbol("cut:visual", "Mask");
  assert.deepEqual(symbol?.parameters?.map((parameter) => parameter.name), ["mode", "invert", "feather", "expand", "x", "y", "scale", "rotation", "opacity"]);
  assert.deepEqual(symbol?.parameters?.find((parameter) => parameter.name === "mode")?.values, ["alpha", "luminance", "red", "green", "blue"]);
  assert.equal(symbol?.children, "visual");

  const ir = compile(program('Mask(mode: "red", invert: true, feather: 2px, expand: -1px) { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }'));
  const node = maskNode(ir), config = referenceMaskConfig(ir, node);
  assert.deepEqual(node.inputs.mode, { kind: "string", value: "red" });
  assert.deepEqual(node.inputs.invert, { kind: "boolean", value: true });
  assert.deepEqual(node.inputs.feather, { kind: "quantity", dimension: "length", magnitude: rational(2), unit: "px" });
  assert.deepEqual(node.inputs.expand, { kind: "quantity", dimension: "length", magnitude: rational(-1), unit: "px" });
  assert.deepEqual(config, { mode: "red", invert: true, featherPx: 2, expandPx: -1 });

  const failures = [
    [program('Mask(mode: "key") { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }'), /mode.*one of: alpha, luminance, red, green, blue/],
    [program('Mask(invert: 1) { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }'), /invert.*expects Bool.*Number/],
    [program('Mask(feather: 10%) { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }'), /feather.*expects Length.*Ratio/],
    [program('Mask(channel: "red") { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }'), /does not execute input “channel”/],
  ] as const;
  for (const [source, expected] of failures) {
    const cutModule = parse(source), diagnostics = checkCutModule(cutModule).diagnostics;
    assert.match(diagnostics.map((item) => item.message).join("\n"), expected);
    assert.ok(diagnostics.some((item) => item.span.start.line > 0 && item.span.start.column > 0));
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }
  assert.throws(() => compileCutModule(parse(program('Mask() { Rect(width: 7px, height: 7px); }'))), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT2085"
      && /requires exactly two visual children: target, then matte/.test(item.message)
      && item.span.start.line > 0));
  for (const [source, expected] of [
    [program('Mask(feather: 0.5px) { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }'), /exact integer pixel radius/],
    [program('Mask(feather: 65px) { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }'), /0px through 64px/],
    [program('Mask(expand: -65px) { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }'), /-64px through 64px/],
  ] as const) {
    assert.throws(() => compileCutModule(parse(source)), (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT_MASK_VALUE_RANGE"
        && expected.test(item.message)
        && item.span.start.line > 0
        && item.span.start.column > 0));
  }
});

test("positive expansion and negative erosion have exact zero-padded square-neighborhood pixels", () => {
  const width = 5, height = 5, target = solid(width, height, [120, 80, 40, 255]);
  const single = alphaMatte([
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 255, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]);
  assert.deepEqual(alphaPlane(applyMaskRgba(target, single, { expandPx: 1 })), [
    0, 0, 0, 0, 0,
    0, 255, 255, 255, 0,
    0, 255, 255, 255, 0,
    0, 255, 255, 255, 0,
    0, 0, 0, 0, 0,
  ]);

  const block = alphaMatte([
    [0, 0, 0, 0, 0],
    [0, 255, 255, 255, 0],
    [0, 255, 255, 255, 0],
    [0, 255, 255, 255, 0],
    [0, 0, 0, 0, 0],
  ]);
  assert.deepEqual(alphaPlane(applyMaskRgba(target, block, { expandPx: -1 })), [
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 255, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ]);

  const corner = alphaMatte([
    [255, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]);
  assert.deepEqual(alphaPlane(applyMaskRgba(target, corner, { expandPx: 1 })), [
    255, 255, 0, 0, 0,
    255, 255, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ], "positive expansion clips at the canvas instead of wrapping");

  const full = alphaMatte(Array.from({ length: 5 }, () => [255, 255, 255, 255, 255]));
  assert.deepEqual(alphaPlane(applyMaskRgba(target, full, { expandPx: -1 })), [
    0, 0, 0, 0, 0,
    0, 255, 255, 255, 0,
    0, 255, 255, 255, 0,
    0, 255, 255, 255, 0,
    0, 0, 0, 0, 0,
  ], "zero coverage beyond the canvas participates in erosion");
});

test("feather is a deterministic finite-support tent and inversion executes after edge operations", () => {
  const target = solid(5, 5, [120, 80, 40, 255]);
  const single = alphaMatte([
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 255, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]);
  const feathered = applyMaskRgba(target, single, { featherPx: 1 });
  assert.deepEqual(alphaPlane(feathered), [
    0, 0, 0, 0, 0,
    0, 28, 28, 28, 0,
    0, 28, 28, 28, 0,
    0, 28, 28, 28, 0,
    0, 0, 0, 0, 0,
  ]);
  const inverted = applyMaskRgba(target, single, { featherPx: 1, invert: true });
  assert.equal(pixel(inverted, 2, 2)[3], 227);
  assert.equal(pixel(inverted, 0, 0)[3], 255);
  assert.deepEqual(pixel(applyMaskRgba(target, single, { invert: true }), 2, 2), [0, 0, 0, 0]);
});

test("alpha, linear luminance and RGB selection are distinct and hidden RGB is safe", () => {
  const target = solid(1, 1, [120, 80, 40, 255]);
  const redHalf = solid(1, 1, [255, 0, 0, 128]);
  assert.deepEqual(pixel(applyMaskRgba(target, redHalf, { mode: "alpha" }), 0, 0), [120, 80, 40, 128]);
  assert.deepEqual(pixel(applyMaskRgba(target, redHalf, { mode: "red" }), 0, 0), [120, 80, 40, 128]);
  assert.deepEqual(pixel(applyMaskRgba(target, redHalf, { mode: "luminance" }), 0, 0), [120, 80, 40, 27]);
  assert.deepEqual(pixel(applyMaskRgba(target, redHalf, { mode: "green" }), 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(applyMaskRgba(target, redHalf, { mode: "blue" }), 0, 0), [0, 0, 0, 0]);

  const premultipliedRedHalf = solid(1, 1, [128, 0, 0, 128], "premultiplied");
  assert.deepEqual(pixel(applyMaskRgba(target, premultipliedRedHalf, { mode: "red" }), 0, 0), [120, 80, 40, 128]);
  const hiddenWhite = solid(1, 1, [255, 255, 255, 0]);
  assert.deepEqual(pixel(applyMaskRgba(target, hiddenWhite, { mode: "luminance", featherPx: 1 }), 0, 0), [0, 0, 0, 0]);

  const premultipliedTarget = solid(1, 1, [100, 50, 25, 128], "premultiplied");
  const straight = applyMaskRgba(premultipliedTarget, solid(1, 1, [0, 0, 0, 255]));
  assert.equal(straight.alphaMode, "straight");
  assert.deepEqual(pixel(straight, 0, 0), [199, 100, 50, 128]);
  assert.deepEqual(pixel(applyMaskRgba(solid(1, 1, [255, 1, 99, 0]), hiddenWhite), 0, 0), [0, 0, 0, 0]);
});

test("public Mask modes, expansion, feather and inversion reach deterministic rendered pixels", async () => {
  const target = "Rect(width: 7px, height: 7px, fill: #336699);";
  const matte = "Rect(width: 1px, height: 1px, fill: #ff0000);";
  const red = await render(program(`Mask(mode: "red") { ${target} ${matte} }`));
  const green = await render(program(`Mask(mode: "green") { ${target} ${matte} }`));
  const invertedGreen = await render(program(`Mask(mode: "green", invert: true) { ${target} ${matte} }`));
  const expanded = await render(program(`Mask(mode: "red", expand: 1px) { ${target} ${matte} }`));
  const eroded = await render(program(`Mask(mode: "red", expand: -1px) { ${target} Rect(width: 3px, height: 3px, fill: #ff0000); }`));
  const feathered = await render(program(`Mask(mode: "red", feather: 1px) { ${target} ${matte} }`));
  assert.deepEqual(pixel(red.surface, 3, 3), [51, 102, 153, 255]);
  assert.deepEqual(pixel(green.surface, 3, 3), [0, 0, 0, 0]);
  assert.deepEqual(pixel(invertedGreen.surface, 3, 3), [51, 102, 153, 255]);
  assert.deepEqual(pixel(expanded.surface, 2, 3), [51, 102, 153, 255]);
  assert.deepEqual(pixel(eroded.surface, 2, 3), [0, 0, 0, 0]);
  assert.deepEqual(pixel(eroded.surface, 3, 3), [51, 102, 153, 255]);
  assert.deepEqual(pixel(feathered.surface, 2, 3), [51, 102, 153, 28]);
  assert.equal(digest((await render(program(`Mask(mode: "red", feather: 1px) { ${target} ${matte} }`))).surface.data), digest(feathered.surface.data));
});

test("authored compositing nesting determines whether masking happens before or after source-over", async () => {
  const maskInside = await render(program('Composite() { Rect(width: 7px, height: 7px, fill: #0000ff); Mask() { Rect(width: 7px, height: 7px, fill: #ff0000); Rect(width: 7px, height: 7px, fill: #ffffff80); } }'));
  const maskOutside = await render(program('Mask() { Composite() { Rect(width: 7px, height: 7px, fill: #0000ff); Rect(width: 7px, height: 7px, fill: #ff0000); } Rect(width: 7px, height: 7px, fill: #ffffff80); }'));
  assert.deepEqual(pixel(maskInside.surface, 3, 3), [188, 0, 187, 255]);
  assert.deepEqual(pixel(maskOutside.surface, 3, 3), [255, 0, 0, 128]);
  assert.notEqual(digest(maskInside.surface.data), digest(maskOutside.surface.data));
});

test("stable diagnostics close bounds, types, modes, unknown controls and hostile loaded IR", () => {
  const base = program('Mask() { Rect(width: 7px, height: 7px); Rect(width: 3px, height: 3px); }');
  const cases: Array<[string, (node: IRNode) => void, ReferenceMaskError["code"], RegExp]> = [
    ["mode", (node) => { node.inputs.mode = { kind: "string", value: "key" }; }, "CUT_MASK_MODE", /one of: alpha, luminance, red, green, blue/],
    ["invert", (node) => { node.inputs.invert = { kind: "string", value: "yes" }; }, "CUT_MASK_INPUT_TYPE", /invert.*Boolean/],
    ["feather", (node) => { node.inputs.feather = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(referenceMaskLimits.maximumFeatherPx + 1) }; }, "CUT_MASK_VALUE_RANGE", /0px through 64px/],
    ["fractional expansion", (node) => { node.inputs.expand = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(1, 2) }; }, "CUT_MASK_VALUE_RANGE", /exact integer pixel radius/],
    ["clipping path", (node) => { node.inputs.clipPath = { kind: "string", value: "M0,0" }; }, "CUT_MASK_INPUT_TYPE", /does not execute input “clipPath”/],
    ["unknown property", (node) => { node.properties.feather = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(1) }; }, "CUT_MASK_INPUT_TYPE", /does not execute property “feather”/],
  ];
  for (const [name, mutate, code, message] of cases) {
    const ir = compile(base); mutate(maskNode(ir)); finalizeGraphHashes(ir);
    let loaded: CutAVIR;
    try {
      loaded = loadCutAvIr(JSON.stringify(ir));
    } catch (error) {
      assert.ok(name === "clipping path" || name === "unknown property", name);
      assert.ok(error instanceof CutAvIrValidationError, name);
      assert.equal(error.code, "CUT_IR_UNKNOWN_FIELD", name);
      assert.match(error.path, name === "clipping path" ? /inputs\.clipPath$/ : /properties\.feather$/);
      continue;
    }
    expectMaskError(() => validateReferenceSession(loaded), code, message);
    let captured: unknown;
    try { validateReferenceSession(loaded); } catch (error) { captured = error; }
    const diagnostic = JSON.parse(JSON.stringify(cutDiagnosticsFromError(captured)))[0];
    assert.equal(diagnostic.code, code, name);
    assert.deepEqual(diagnostic.source, {
      module: "project.cut",
      line: maskNode(loaded).provenance.span.start.line,
      column: maskNode(loaded).provenance.span.start.column,
      nodeId: maskNode(loaded).id,
    }, name);
  }
  assert.throws(() => applyMaskRgba(solid(1, 1, [0, 0, 0, 255]), solid(1, 1, [0, 0, 0, 255]), { featherPx: 65 }), /0 through 64/);
  expectMaskError(() => validateReferenceMaskCanvas(maskNode(compile(base)), 4_097, 4_097), "CUT_MASK_RESOURCE_LIMIT", /16777216-pixel mask budget/);
});

test("mask input edits invalidate only the mask kernel and containing scene", () => {
  const before = compile(program('Mask(mode: "alpha", expand: 0px) { Rect(width: 7px, height: 7px, fill: #336699); Rect(width: 1px, height: 1px, fill: #ffffff); }'));
  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = compile(program('Mask(mode: "alpha", expand: 1px) { Rect(width: 7px, height: 7px, fill: #336699); Rect(width: 1px, height: 1px, fill: #ffffff); }'));
  const plan = createIncrementalRenderPlan(after, "main", previous), mask = maskNode(after);
  const rects = Object.values(after.nodes).filter((node) => node.op === "cut.visual.rect");
  assert.equal(rects.length, 2);
  for (const rect of rects) assert.equal(plan.nodes.find((node) => node.id === rect.id)?.status, "hit", "unchanged child stays reusable");
  assert.equal(plan.nodes.find((node) => node.id === mask.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "miss"));
  assert.notEqual(before.buildId, after.buildId);
});
