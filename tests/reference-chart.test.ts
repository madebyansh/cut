import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { ReferenceChartError, referenceChartConfig } from "../lib/runtime/reference/chart-config";
import { evaluateSignal } from "../lib/runtime/reference/signals";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";

function source(body: string, width = 160, height = 100, fps = 10) {
  return `cut 0.4;
project "general chart";
import { Chart } from "@cut/data";
import { cubicBezier, linear, spring } from "@cut/motion";
timeline main(duration: 1s, fps: ${fps}, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function parsed(text: string) {
  const result = parseCutLanguage(text);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(text: string) {
  return compileCutModule(parsed(text)).ir;
}

function chart(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.data.chart");
  assert.ok(node);
  return node;
}

function px(value: number): IRValue {
  return { kind: "quantity", dimension: "length", magnitude: rational(value), unit: "px" };
}

function scalar(value: number): IRValue {
  return { kind: "quantity", dimension: "scalar", magnitude: rational(value), unit: "scalar" };
}

function ratio(value: number, denominator = 100): IRValue {
  return { kind: "quantity", dimension: "ratio", magnitude: rational(value, denominator), unit: "ratio" };
}

function angle(value: number): IRValue {
  return { kind: "quantity", dimension: "angle", magnitude: rational(value), unit: "deg" };
}

function lockedIr(mutate: (node: IRNode) => void) {
  const ir = compile(source('Chart(values: [-4, 0, 8], kind: "bar", width: 120px, height: 80px, primary: #ff0000, secondary: #0000ff);'));
  mutate(chart(ir));
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  return loadCutAvIr(JSON.stringify(ir));
}

async function frame(text: string, frameIndex: number) {
  const ir = compile(text);
  ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-chart-"));
  const composition = ir.compositions[0];
  const scene = ir.scenes[composition.sceneIds[0]];
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut-cache"));
  await renderer.prepare();
  try {
    return await renderer.sceneFrame(scene, frameIndex, false);
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
}

function hashPixels(value: { data: Buffer }) {
  return createHash("sha256").update(value.data).digest("hex");
}

function opaquePixels(value: { data: Buffer }) {
  let result = 0;
  for (let offset = 3; offset < value.data.length; offset += 4) if (value.data[offset] > 0) result += 1;
  return result;
}

function exactPixels(value: { data: Buffer }, rgba: readonly number[]) {
  let result = 0;
  for (let offset = 0; offset < value.data.length; offset += 4) {
    if (rgba.every((channel, index) => value.data[offset + index] === channel)) result += 1;
  }
  return result;
}

function pixelsWhere(value: { data: Buffer }, predicate: (red: number, green: number, blue: number, alpha: number) => boolean) {
  let result = 0;
  for (let offset = 0; offset < value.data.length; offset += 4) {
    if (predicate(value.data[offset], value.data[offset + 1], value.data[offset + 2], value.data[offset + 3])) result += 1;
  }
  return result;
}

test("Chart is a closed supported public kernel instead of a reserved open-named mock", () => {
  const text = source(`Chart(
    values: [-4, 0, 8], kind: "area", width: 120px, height: 80px,
    min: -5, max: 10, primary: #7c3aed, secondary: #f59e0b,
    background: #fafaf9, showAxes: true, axisColor: #292524,
    strokeWidth: 3px, reveal: 75%
  ) as chart;`);
  const checked = checkCutModule(parsed(text));
  assert.deepEqual(checked.diagnostics, []);
  const ir = compileCutModule(checked.module).ir;
  const node = chart(ir);
  const publicSymbol = packageSymbol("@cut/data", "Chart");
  assert.ok(publicSymbol);
  assert.equal(publicSymbol.openNamed, undefined);
  assert.deepEqual(publicSymbol.parameters?.map((parameter) => parameter.name), [
    "values", "kind", "width", "height", "x", "y", "min", "max", "primary", "secondary", "background",
    "showAxes", "axisColor", "gap", "strokeWidth", "reveal", "opacity", "scale", "rotation",
  ]);
  const schema = referenceKernelSchema(node.op);
  assert.ok(schema?.support === "supported");
  if (schema.support === "supported") {
    assert.ok(schema.inputs.includes("values"));
    assert.ok(schema.properties.includes("reveal"));
    assert.equal(schema.stringInputs.kind?.join(","), "bar,line,area");
  }
  const config = referenceChartConfig(ir, node, ir.compositions[0]);
  assert.deepEqual(config && {
    kind: config.kind,
    values: config.values,
    domain: [config.minimum, config.maximum],
    geometry: [config.width, config.height],
    palette: [config.primary, config.secondary, config.background, config.axisColor],
    showAxes: config.showAxes,
    strokeWidth: config.strokeWidth,
  }, {
    kind: "area",
    values: [-4, 0, 8],
    domain: [-5, 10],
    geometry: [120, 80],
    palette: ["#7c3aed", "#f59e0b", "#fafaf9", "#292524"],
    showAxes: true,
    strokeWidth: 3,
  });

  const unknown = checkCutModule(parsed(source("Chart(values: [1, 2], width: 100px, height: 60px, labels: [\"one\", \"two\"]);"))).diagnostics;
  assert.ok(unknown.some((diagnostic) => diagnostic.code === "CUT2059" && /labels/.test(diagnostic.message)), JSON.stringify(unknown));
  const oldSurface = checkCutModule(parsed(source("Chart(data: [1, 2], width: 100px, height: 60px);"))).diagnostics;
  assert.ok(oldSurface.some((diagnostic) => diagnostic.code === "CUT2059" && /data/.test(diagnostic.message)), JSON.stringify(oldSurface));
  assert.ok(oldSurface.some((diagnostic) => diagnostic.code === "CUT2028" && /values/.test(diagnostic.message)), JSON.stringify(oldSurface));

  const children = checkCutModule(parsed(source("Chart(values: [1], width: 100px, height: 60px) { Chart(values: [2], width: 40px, height: 20px); }"))).diagnostics;
  assert.ok(children.some((diagnostic) => diagnostic.code === "CUT2034" && /child nodes/.test(diagnostic.message)), JSON.stringify(children));

  const property = checkCutModule(parsed(source("Chart(values: [1], width: 100px, height: 60px) as chart; set chart.unknown = 1;"))).diagnostics;
  assert.ok(property.some((diagnostic) => diagnostic.code === "CUT2060" && /unknown/.test(diagnostic.message)), JSON.stringify(property));
});

test("every accepted Chart control reaches pixels or a closed selected-kind contract", { timeout: 30_000 }, async () => {
  const baseline = "Chart(values: [1, 3, 2], kind: \"bar\", width: 90px, height: 60px, x: 80px, y: 50px, min: 0, max: 4, primary: #ff0000, secondary: #ff0000, gap: 20%, reveal: 100%, opacity: 100%, scale: 1, rotation: 0deg);";
  const baselinePixels = hashPixels(await frame(source(baseline), 0));
  const variants = [
    baseline.replace("[1, 3, 2]", "[1, 2, 3]"),
    baseline.replace("width: 90px", "width: 80px"),
    baseline.replace("height: 60px", "height: 50px"),
    baseline.replace("x: 80px", "x: 70px"),
    baseline.replace("y: 50px", "y: 40px"),
    baseline.replace("min: 0, max: 4", "min: -1, max: 4"),
    baseline.replace("primary: #ff0000", "primary: #00ff00"),
    baseline.replace("secondary: #ff0000", "secondary: #0000ff"),
    baseline.replace("gap: 20%", "background: #fef3c7, gap: 20%"),
    baseline.replace("gap: 20%", "showAxes: true, gap: 20%"),
    baseline.replace("gap: 20%", "showAxes: true, axisColor: #7c3aed, gap: 20%"),
    baseline.replace("gap: 20%", "gap: 50%"),
    baseline.replace("reveal: 100%", "reveal: 50%"),
    baseline.replace("opacity: 100%", "opacity: 50%"),
    baseline.replace("scale: 1", "scale: 0.75"),
    baseline.replace("rotation: 0deg", "rotation: 12deg"),
  ];
  for (const variant of variants) assert.notEqual(hashPixels(await frame(source(variant), 0)), baselinePixels, variant);

  const thinLine = await frame(source('Chart(values: [1, 3, 2], kind: "line", width: 90px, height: 60px, primary: #ff0000, secondary: #ff0000, strokeWidth: 2px);'), 0);
  const thickLine = await frame(source('Chart(values: [1, 3, 2], kind: "line", width: 90px, height: 60px, primary: #ff0000, secondary: #ff0000, strokeWidth: 8px);'), 0);
  assert.notEqual(hashPixels(thinLine), hashPixels(thickLine), "strokeWidth did not reach line pixels");
});

test("Chart combinations and budgets fail during public compile with stable located diagnostics", () => {
  const cases = [
    { call: 'Chart(values: [1, 2], kind: "line", width: 100px, height: 60px, gap: 20%);', code: "CUT_CHART_COMBINATION" },
    { call: 'Chart(values: [1, 2], kind: "bar", width: 100px, height: 60px, strokeWidth: 2px);', code: "CUT_CHART_COMBINATION" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, axisColor: #000000);', code: "CUT_CHART_COMBINATION" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, min: 0);', code: "CUT_CHART_COMBINATION" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, min: 0, max: 1);', code: "CUT_CHART_VALUE_RANGE" },
    { call: 'Chart(values: [1], kind: "line", width: 100px, height: 60px);', code: "CUT_CHART_VALUE_RANGE" },
    { call: 'Chart(values: [], width: 100px, height: 60px);', code: "CUT_CHART_VALUE_RANGE" },
    { call: 'Chart(values: [1, 2], width: 0px, height: 60px);', code: "CUT_CHART_VALUE_RANGE" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, primary: #ff000000);', code: "CUT_CHART_COMBINATION" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, reveal: 101%);', code: "CUT_CHART_VALUE_RANGE" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, reveal: 0%);', code: "CUT_CHART_COMBINATION" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, opacity: 101%);', code: "CUT_VISUAL_VALUE_RANGE" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, scale: 0);', code: "CUT_VISUAL_VALUE_RANGE" },
    { call: 'Chart(values: [1, 2], width: 100px, height: 60px, rotation: 999999deg);', code: "CUT_VISUAL_VALUE_RANGE" },
  ] as const;
  for (const fixture of cases) {
    assert.throws(() => compile(source(fixture.call)), (error: unknown) => {
      assert.ok(error instanceof CutCompileError, fixture.call);
      const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === fixture.code);
      assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
      assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
      return true;
    });
  }

  const tooMany = Array.from({ length: 513 }, () => "1").join(", ");
  assert.throws(() => compile(source(`Chart(values: [${tooMany}], width: 100px, height: 60px);`)), (error: unknown) =>
    error instanceof CutCompileError && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT_CHART_LIMIT"));

  const endpointOnly = source(`
    Chart(values: [1, 2], width: 100px, height: 60px, reveal: 0%) as chart;
    animate chart.reveal from 0% to 100% over 100ms delay 900ms ease linear;
  `);
  assert.throws(() => compile(endpointOnly), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT2085" && /events\[0\] animate never changes an exact output-frame sample/.test(diagnostic.message)));
});

test("loaded Chart IR is revalidated before rendering and cannot bypass the closed source contract", () => {
  const cases: Array<[(node: IRNode) => void, ReferenceChartError["code"]]> = [
    [(node) => { node.inputs.values = { kind: "string", value: "1,2" }; }, "CUT_CHART_INPUT_TYPE"],
    [(node) => { node.inputs.values = { kind: "array", items: [scalar(1), { kind: "string", value: "2" }] }; }, "CUT_CHART_INPUT_TYPE"],
    [(node) => { node.inputs.width = px(0); }, "CUT_CHART_VALUE_RANGE"],
    [(node) => { node.inputs.min = scalar(9); node.inputs.max = scalar(10); }, "CUT_CHART_VALUE_RANGE"],
    [(node) => { node.inputs.kind = { kind: "string", value: "pie" }; }, "CUT_CHART_INPUT_TYPE"],
    [(node) => { node.inputs.gap = ratio(95); }, "CUT_CHART_VALUE_RANGE"],
    [(node) => { node.inputs.background = { kind: "color", value: "#ffffff00" }; }, "CUT_CHART_COMBINATION"],
  ];
  for (const [mutate, code] of cases) {
    const ir = lockedIr(mutate);
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceChartError);
      assert.equal(error.code, code);
      assert.ok(error.source.line > 0 && error.source.column > 0 && error.source.nodeId);
      return true;
    });
  }

  const transformCases: Array<[(node: IRNode) => void, ReferenceVisualConfigError["code"]]> = [
    [(node) => { node.inputs.opacity = ratio(101); }, "CUT_VISUAL_VALUE_RANGE"],
    [(node) => { node.inputs.scale = scalar(0); }, "CUT_VISUAL_VALUE_RANGE"],
    [(node) => { node.inputs.rotation = angle(999_999); }, "CUT_VISUAL_VALUE_RANGE"],
  ];
  for (const [mutate, code] of transformCases) {
    const ir = lockedIr(mutate);
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceVisualConfigError);
      assert.equal(error.code, code);
      assert.ok(error.nodeId);
      assert.match(error.message, /project\.cut:\d+:\d+/u);
      return true;
    });
  }
});

test("bar, line, and area semantics render different real pixels without a forced background or font", { timeout: 30_000 }, async () => {
  const common = "values: [-4, 0, 8, 3], width: 120px, height: 80px, x: 80px, y: 50px, primary: #ff0000, secondary: #ff0000, reveal: 100%";
  const bar = await frame(source(`Chart(${common}, kind: "bar", gap: 25%);`), 0);
  const line = await frame(source(`Chart(${common}, kind: "line", strokeWidth: 4px);`), 0);
  const area = await frame(source(`Chart(${common}, kind: "area", strokeWidth: 4px);`), 0);
  assert.notEqual(hashPixels(bar), hashPixels(line));
  assert.notEqual(hashPixels(line), hashPixels(area));
  assert.notEqual(hashPixels(bar), hashPixels(area));
  assert.ok(exactPixels(bar, [255, 0, 0, 255]) > 100, "custom solid-red bars were not present in decoded RGBA");
  assert.ok(opaquePixels(line) > 0 && opaquePixels(area) > opaquePixels(line), "area fill must add coverage beyond its line");

  const styled = await frame(source('Chart(values: [1, 2], kind: "bar", width: 120px, height: 80px, background: #00ff00, showAxes: true, axisColor: #0000ff, primary: #ff0000, secondary: #ff0000);'), 0);
  assert.ok(exactPixels(styled, [0, 255, 0, 255]) > 100, "authored background did not execute");
  assert.ok(pixelsWhere(styled, (red, green, blue, alpha) => alpha > 0 && blue > red && blue > green && blue > 100) > 0, "authored axes did not execute");
});

test("baseline values stay transparent and partial-alpha Chart output remains straight RGBA", { timeout: 30_000 }, async () => {
  const zero = await frame(source('Chart(values: [0], kind: "bar", width: 120px, height: 80px, primary: #ff0000, secondary: #ff0000);'), 0);
  assert.equal(opaquePixels(zero), 0, "a zero datum emitted a phantom baseline bar");

  const translucent = await frame(source('Chart(values: [1, 2], kind: "bar", width: 120px, height: 80px, primary: #ff000080, secondary: #ff000080, opacity: 50%);'), 0);
  const alphas = new Set<number>();
  for (let offset = 0; offset < translucent.data.length; offset += 4) {
    const alpha = translucent.data[offset + 3];
    alphas.add(alpha);
    if (alpha === 0) assert.deepEqual(Array.from(translucent.data.subarray(offset, offset + 3)), [0, 0, 0], "transparent Chart pixel retained hidden RGB");
  }
  assert.deepEqual([...alphas].sort((left, right) => left - right), [0, 64]);
});

test("animated reveal changes exact frames while values and palette remain in semantic identity", { timeout: 30_000 }, async () => {
  const text = source(`
    Chart(values: [1, 4, 2, 6], kind: "bar", width: 120px, height: 80px, primary: #7c3aed, secondary: #f59e0b, reveal: 0%) as chart;
    animate chart.reveal from 0% to 100% over 800ms ease linear;
  `);
  const first = await frame(text, 0);
  const middle = await frame(text, 4);
  const final = await frame(text, 9);
  assert.equal(opaquePixels(first), 0, "0% reveal must not leak data marks");
  assert.ok(opaquePixels(middle) > 0, "mid-animation chart is empty");
  assert.ok(opaquePixels(final) > opaquePixels(middle), "later reveal did not add chart coverage");

  const original = compile(text);
  const changedValues = compile(text.replace("[1, 4, 2, 6]", "[1, 4, 5, 6]"));
  const changedPalette = compile(text.replace("#7c3aed", "#0891b2"));
  assert.notEqual(changedValues.buildId, original.buildId);
  assert.notEqual(changedPalette.buildId, original.buildId);
  assert.notEqual(chart(changedValues).contentHash, chart(original).contentHash);
  assert.notEqual(chart(changedPalette).contentHash, chart(original).contentHash);
});

test("a delayed reveal track retains the constructor default before its first event", { timeout: 30_000 }, async () => {
  const text = source(`
    Chart(values: [1, 4, 2, 6], kind: "bar", width: 120px, height: 80px, primary: #7c3aed, secondary: #f59e0b) as chart;
    animate chart.reveal from 0% to 100% over 500ms delay 200ms ease linear;
  `);
  const before = await frame(text, 0);
  const eventStart = await frame(text, 2);
  const during = await frame(text, 4);
  assert.ok(opaquePixels(before) > 0, "the default 100% reveal was not retained before the delayed event");
  assert.equal(opaquePixels(eventStart), 0, "the authored 0% event start leaked marks");
  assert.ok(opaquePixels(during) > 0 && opaquePixels(during) < opaquePixels(before), "delayed reveal did not execute after its exact start");
});

test("reveal clamps only derived easing overshoot while authored endpoints remain bounded", { timeout: 30_000 }, async () => {
  const full = await frame(source('Chart(values: [1, 4, 2, 6], kind: "bar", width: 120px, height: 80px, primary: #7c3aed, secondary: #f59e0b, reveal: 100%);', 160, 100, 20), 0);
  const cases = [
    { easing: "spring()", frameIndex: 5 },
    { easing: "cubicBezier(0.2, 2, 0.8, 2)", frameIndex: 4 },
  ] as const;
  for (const fixture of cases) {
    const text = source(`
      Chart(values: [1, 4, 2, 6], kind: "bar", width: 120px, height: 80px, primary: #7c3aed, secondary: #f59e0b, reveal: 0%) as chart;
      animate chart.reveal from 0% to 100% over 1s ease ${fixture.easing};
    `, 160, 100, 20);
    const ir = compile(text), node = chart(ir), property = node.properties.reveal;
    assert.ok(property && "signal" in property);
    const interpolated = evaluateSignal(ir, property.signal, rational(fixture.frameIndex, 20));
    assert.equal(interpolated.kind, "quantity");
    assert.ok(Number(interpolated.magnitude.numerator) / Number(interpolated.magnitude.denominator) > 1, `${fixture.easing} did not exercise overshoot`);
    const saturated = await frame(text, fixture.frameIndex);
    assert.equal(hashPixels(saturated), hashPixels(full), `${fixture.easing} reveal did not saturate to the exact 100% frame`);
  }
});

test("Chart data and reveal invalidate only their owning picture scene cache", () => {
  const project = (middle: number, target: number) => `cut 0.4;
project "chart cache locality";
import { Chart } from "@cut/data";
import { linear } from "@cut/motion";
import { Rect } from "cut:visual";
timeline main(duration: 2s, fps: 10, width: 160px, height: 100px, sampleRate: 48khz) {
  scene data(duration: 1s) {
    Chart(values: [1, ${middle}, 3], kind: "line", width: 120px, height: 80px, primary: #7c3aed, secondary: #f59e0b, strokeWidth: 4px, reveal: 0%) as chart;
    animate chart.reveal from 0% to ${target}% over 800ms ease linear;
  }
  scene stable(duration: 1s) { Rect(width: 80px, height: 40px, fill: #f5f5f4); }
}
export out = render(main);`;
  const before = compile(project(2, 50));
  const previous = createIncrementalRenderPlan(before, "main").manifest;

  const dataEdit = createIncrementalRenderPlan(compile(project(4, 50)), "main", previous);
  assert.deepEqual(dataEdit.scenes.map((scene) => scene.status), ["miss", "hit"]);

  const revealEdit = createIncrementalRenderPlan(compile(project(2, 100)), "main", previous);
  assert.deepEqual(revealEdit.scenes.map((scene) => scene.status), ["miss", "hit"]);
});
