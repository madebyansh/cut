import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import {
  applyReferenceTonalCurve,
  inspectReferenceColorHistogram,
  ReferenceColorManagementError,
  referenceTonalCurveConfig,
  referenceTonalCurveLimits,
  validateReferenceTonalCurveNodeBudget,
} from "../lib/runtime/reference/color-management";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const points = "[curvePoint(input: 0%, output: 0%), curvePoint(input: 50%, output: 0%), curvePoint(input: 100%, output: 100%)]";

function program(body: string) {
  return `cut 0.4;
project "tonal curve proof";
import { Composite, curvePoint, Rect, TonalCurve } from "cut:visual";
timeline main(duration: 1s, fps: 1, width: 8px, height: 8px, sampleRate: 8khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main);`;
}

function compile(body: string) {
  const parsed = parseCutLanguage(program(body));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function curve(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.tonal_curve");
  assert.ok(node);
  return node;
}

async function frame(body: string) {
  const ir = compile(body), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-tonal-curve-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try { return await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false); }
  finally { renderer.close(); await rm(root, { recursive: true, force: true }); }
}

function center(surface: { data: Uint8Array; width: number; height: number }) {
  const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

test("TonalCurve is public typed syntax and curvePoint lowers to closed ordinary IR", () => {
  const ir = compile(`TonalCurve(points: ${points}, space: "linear-srgb", channel: "red") { Rect(width: 8px, height: 8px, fill: #4080c080); }`);
  const node = curve(ir), config = referenceTonalCurveConfig(node);
  assert.ok(config);
  assert.deepEqual(config.points.map((point) => [point.input, point.output]), [
    [{ numerator: "0", denominator: "1" }, { numerator: "0", denominator: "1" }],
    [{ numerator: "1", denominator: "2" }, { numerator: "0", denominator: "1" }],
    [{ numerator: "1", denominator: "1" }, { numerator: "1", denominator: "1" }],
  ]);
  assert.deepEqual({ channel: config.channel, space: config.space, alpha: config.alpha }, { channel: "red", space: "linear-srgb", alpha: "straight" });
  assert.deepEqual(Object.keys(node.inputs).sort(), ["channel", "points", "space"]);
  assert.equal(Object.values(ir.nodes).some((candidate) => candidate.op.includes("curvePoint")), false, "record helper must not leak a runtime node");
  assert.equal(node.children.length, 1);

  for (const body of [
    `TonalCurve(points: ${points}, space: "log") { Rect(width: 8px, height: 8px); }`,
    `TonalCurve(points: ${points}, space: "srgb", channel: "luma") { Rect(width: 8px, height: 8px); }`,
    `TonalCurve(points: ${points}, space: "srgb", invented: true) { Rect(width: 8px, height: 8px); }`,
    `TonalCurve(points: ${points}, space: "srgb") { Rect(width: 8px, height: 8px); Rect(width: 8px, height: 8px); }`,
  ]) {
    assert.throws(() => compile(body), (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.span.start.line > 0));
  }
});

test("loaded IR point, range, working-space, alpha, and graph corruption fail source-located", () => {
  const base = compile(`TonalCurve(points: ${points}, space: "srgb") { Rect(width: 8px, height: 8px); }`);
  const corrupted = (mutate: (node: IRNode) => void) => {
    const ir = structuredClone(base), node = curve(ir); mutate(node); return () => referenceTonalCurveConfig(node);
  };
  const expect = (run: () => unknown, code: string) => assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ReferenceColorManagementError);
    assert.equal(error.code, code);
    assert.equal(error.source?.module, "project.cut");
    assert.equal(error.source?.line, 5);
    assert.ok((error.source?.column ?? 0) > 0);
    return true;
  });
  expect(corrupted((node) => { node.inputs.points = { kind: "array", items: [] }; }), "CUT_COLOR_CURVE_POINTS");
  expect(corrupted((node) => {
    const authored = node.inputs.points; assert.equal(authored.kind, "array");
    const first = authored.items[0]; assert.equal(first.kind, "object");
    first.entries.extra = { kind: "boolean", value: true };
  }), "CUT_COLOR_CURVE_INPUT");
  expect(corrupted((node) => {
    const authored = node.inputs.points; assert.equal(authored.kind, "array");
    const first = authored.items[0]; assert.equal(first.kind, "object");
    first.entries.input = { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: { numerator: "01", denominator: "2" } };
  }), "CUT_COLOR_CURVE_INPUT");
  expect(corrupted((node) => {
    const authored = node.inputs.points; assert.equal(authored.kind, "array");
    const second = authored.items[1]; assert.equal(second.kind, "object");
    second.entries.output = { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: { numerator: "101", denominator: "100" } };
  }), "CUT_COLOR_CURVE_RANGE");
  expect(corrupted((node) => {
    const authored = node.inputs.points; assert.equal(authored.kind, "array");
    const second = authored.items[1], third = authored.items[2]; assert.equal(second.kind, "object"); assert.equal(third.kind, "object");
    third.entries.input = structuredClone(second.entries.input);
  }), "CUT_COLOR_CURVE_POINTS");
  expect(corrupted((node) => { node.inputs.space = { kind: "string", value: "acescg" }; }), "CUT_COLOR_CURVE_INPUT");
  expect(corrupted((node) => { node.inputs.alpha = { kind: "string", value: "premultiplied" }; }), "CUT_COLOR_CURVE_INPUT");
  expect(corrupted((node) => { node.children = []; }), "CUT_COLOR_GRAPH");
});

test("TonalCurve resource limits are executable over reachable nodes", () => {
  assert.deepEqual(referenceTonalCurveLimits, { minimumPoints: 2, maximumPoints: 32, maximumNodesPerComposition: 256, maximumPointsPerComposition: 4_096 });
  const base = compile(`TonalCurve(points: ${points}, space: "srgb") { Rect(width: 8px, height: 8px); }`), authored = curve(base);
  const ir = structuredClone(base), reachable = new Set<string>();
  for (let index = 0; index <= referenceTonalCurveLimits.maximumNodesPerComposition; index += 1) {
    const node = structuredClone(authored); node.id = `curve-${index}`; ir.nodes[node.id] = node; reachable.add(node.id);
  }
  assert.throws(() => validateReferenceTonalCurveNodeBudget(ir, reachable), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_CURVE_RESOURCE" && error.source?.module === "project.cut");
});

test("piecewise-linear pixel goldens distinguish encoded and linear spaces and preserve straight alpha", () => {
  const srgbIr = compile(`TonalCurve(points: ${points}, space: "srgb") { Rect(width: 8px, height: 8px); }`), srgb = referenceTonalCurveConfig(curve(srgbIr))!;
  const linearIr = compile(`TonalCurve(points: ${points}, space: "linear-srgb") { Rect(width: 8px, height: 8px); }`), linear = referenceTonalCurveConfig(curve(linearIr))!;
  const input = { data: Uint8Array.from([0, 64, 128, 255, 192, 255, 32, 0]), width: 2, height: 1 };
  assert.deepEqual([...applyReferenceTonalCurve(input, srgb).data], [0, 0, 1, 255, 129, 255, 0, 0]);
  assert.deepEqual([...applyReferenceTonalCurve(input, linear).data], [0, 0, 0, 255, 66, 255, 0, 0]);
  assert.deepEqual([...input.data], [0, 64, 128, 255, 192, 255, 32, 0], "input surface is immutable");

  const redIr = compile(`TonalCurve(points: ${points}, space: "srgb", channel: "red") { Rect(width: 8px, height: 8px); }`), red = referenceTonalCurveConfig(curve(redIr))!;
  assert.deepEqual([...applyReferenceTonalCurve(input, red).data], [0, 64, 128, 255, 129, 255, 32, 0], "unselected channels and alpha remain exact, including hidden RGB");
  assert.throws(() => applyReferenceTonalCurve({ ...input, alphaMode: "premultiplied" }, red), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_ALPHA");
});

test("identity bypass is byte/object preserving while authored channel curves execute in the renderer", async () => {
  const identityPoints = "[curvePoint(input: 0%, output: 0%), curvePoint(input: 25%, output: 25%), curvePoint(input: 100%, output: 100%)]";
  const identityIr = compile(`TonalCurve(points: ${identityPoints}, space: "linear-srgb") { Rect(width: 8px, height: 8px); }`), config = referenceTonalCurveConfig(curve(identityIr))!;
  const input = { data: Uint8Array.from([1, 127, 254, 91]), width: 1, height: 1 };
  assert.equal(applyReferenceTonalCurve(input, config), input, "mathematical identity must avoid a decode/re-encode round trip");

  const rendered = await frame(`TonalCurve(points: ${points}, space: "srgb", channel: "red") { Rect(width: 8px, height: 8px, fill: #4080c080); }`);
  assert.deepEqual(center(rendered), [0, 127, 191, 128]);
});

test("authored nesting controls curve/composite order", async () => {
  const after = await frame(`TonalCurve(points: ${points}, space: "srgb") { Composite() { Rect(width: 8px, height: 8px, fill: #0000ff); Rect(width: 8px, height: 8px, fill: #ff000080); } }`);
  const before = await frame(`Composite() { TonalCurve(points: ${points}, space: "srgb") { Rect(width: 8px, height: 8px, fill: #0000ff); } TonalCurve(points: ${points}, space: "srgb") { Rect(width: 8px, height: 8px, fill: #ff000080); } }`);
  assert.notDeepEqual(center(after), center(before));
});

test("histogram exact bins, linear projection, transparency, and option diagnostics are deterministic", () => {
  const surface = { data: Uint8Array.from([
    0, 0, 0, 255,
    128, 0, 0, 0,
    255, 255, 255, 128,
    0, 0, 255, 255,
  ]), width: 4, height: 1 };
  const report = inspectReferenceColorHistogram(surface, { bins: 16, space: "srgb", alpha: "nonzero" });
  assert.deepEqual({ format: report.format, version: report.version, pixels: report.pixels, sampledPixels: report.sampledPixels, excluded: report.excludedTransparentPixels, bins: report.bins, rgb: report.rgbSpace, luma: report.lumaSpace, alpha: report.alpha }, {
    format: "cut-color-histogram", version: 1, pixels: 4, sampledPixels: 3, excluded: 1, bins: 16, rgb: "srgb", luma: "linear-srgb", alpha: "nonzero",
  });
  const nonzero = (values: readonly number[]) => values.flatMap((count, index) => count ? [[index, count] as const] : []);
  assert.deepEqual(nonzero(report.channels.red), [[0, 2], [15, 1]]);
  assert.deepEqual(nonzero(report.channels.green), [[0, 2], [15, 1]]);
  assert.deepEqual(nonzero(report.channels.blue), [[0, 1], [15, 2]]);
  assert.deepEqual(nonzero(report.channels.luma), [[0, 1], [1, 1], [15, 1]]);
  assert.deepEqual(nonzero(report.channels.alpha), [[8, 1], [15, 2]]);

  const allEncoded = inspectReferenceColorHistogram(surface, { bins: 16, space: "srgb", alpha: "all" });
  const allLinear = inspectReferenceColorHistogram(surface, { bins: 16, space: "linear-srgb", alpha: "all" });
  assert.deepEqual(nonzero(allEncoded.channels.red), [[0, 2], [8, 1], [15, 1]]);
  assert.deepEqual(nonzero(allLinear.channels.red), [[0, 2], [3, 1], [15, 1]], "linear-space RGB projection decodes encoded input before binning");
  assert.deepEqual(nonzero(allEncoded.channels.alpha), [[0, 1], [8, 1], [15, 2]]);

  assert.throws(() => inspectReferenceColorHistogram(surface, { bins: 4 as 16 }), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_HISTOGRAM");
  assert.throws(() => inspectReferenceColorHistogram(surface, { space: "acescg" as "srgb" }), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_HISTOGRAM");
  assert.throws(() => inspectReferenceColorHistogram(surface, { alpha: "weighted" as "all" }), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_HISTOGRAM");
  assert.throws(() => inspectReferenceColorHistogram({ ...surface, alphaMode: "premultiplied" }), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_ALPHA");
});

function cacheProgram(midpoint: 0 | 25) {
  return compileCutModule(parseCutLanguage(`cut 0.4;
project "curve cache locality";
import { curvePoint, Rect, TonalCurve } from "cut:visual";
timeline main(duration: 2s, fps: 1, width: 8px, height: 8px, sampleRate: 8khz) {
  scene changed(duration: 1s) { TonalCurve(points: [curvePoint(input: 0%, output: 0%), curvePoint(input: 50%, output: ${midpoint}%), curvePoint(input: 100%, output: 100%)], space: "srgb") { Rect(width: 8px, height: 8px, fill: #4080c0); } }
  scene unrelated(duration: 1s) { Rect(width: 8px, height: 8px, fill: #ffcc00); }
}
export out = render(main);`).module!).ir;
}

test("control-point edits invalidate the wrapper and containing scene but retain child and unrelated scene", () => {
  const before = cacheProgram(0), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = cacheProgram(25), plan = createIncrementalRenderPlan(after, "main", previous), wrapper = curve(after);
  const child = Object.values(after.nodes).find((node) => node.sceneId === wrapper.sceneId && node.op === "cut.visual.rect")!;
  assert.equal(plan.nodes.find((item) => item.id === child.id)?.status, "hit");
  assert.equal(plan.nodes.find((item) => item.id === wrapper.id)?.status, "miss");
  assert.deepEqual(plan.scenes.map((item) => item.status), ["miss", "hit"]);

  const plain = compile("Rect(width: 8px, height: 8px, fill: #4080c0);");
  assert.equal(Object.values(plain.nodes).some((node) => node.op === "cut.visual.tonal_curve"), false, "absence adds no hidden curve node or input");
});
