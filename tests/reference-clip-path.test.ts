import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import {
  applyReferenceClipPath,
  prepareReferenceClipPath,
  ReferenceClipPathError,
  referenceClipPathConfig,
  referenceClipPathLimits,
  referenceClipPathWorkUnits,
  validateReferenceClipPathCompositionBudget,
} from "../lib/runtime/reference/clip-path";
import type { RgbaSurface } from "../lib/runtime/reference/compositing";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const square = "[{ x: 1px, y: 1px }, { x: 4px, y: 1px }, { x: 4px, y: 4px }, { x: 1px, y: 4px }]";

function program(body: string, width = 5, height = 5) {
  return `cut 0.4;
project "unrelated polygon clipping";
import { ClipPath, Composite, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 1, width: ${width}px, height: ${height}px, sampleRate: 8khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source: string) {
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(cutModule).ir;
}

function clipNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.clip_path");
  assert.ok(node);
  return node;
}

function point(x: number, y: number): IRValue {
  return {
    kind: "object",
    entries: {
      x: { kind: "quantity", dimension: "length", magnitude: rational(x), unit: "px" },
      y: { kind: "quantity", dimension: "length", magnitude: rational(y), unit: "px" },
    },
  };
}

function surface(width: number, height: number, rgba: readonly number[], alphaMode?: "straight" | "premultiplied"): RgbaSurface {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(rgba, offset);
  return { data, width, height, ...(alphaMode ? { alphaMode } : {}) };
}

function alphaPlane(value: RgbaSurface) {
  const result: number[] = [];
  for (let offset = 3; offset < value.data.length; offset += 4) result.push(value.data[offset]);
  return result;
}

function pixel(value: RgbaSurface, x: number, y: number) {
  const offset = (y * value.width + x) * 4;
  return [...value.data.subarray(offset, offset + 4)];
}

function digest(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

async function render(source: string) {
  const ir = compile(source), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-clip-path-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/cache"));
  await renderer.prepare();
  try {
    return { ir, surface: await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false) };
  } finally { renderer.close(); }
}

function expectClipError(action: () => unknown, code: ReferenceClipPathError["code"], message?: RegExp) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceClipPathError);
    assert.equal(error.code, code);
    assert.ok(error.source.module && error.source.line > 0 && error.source.column > 0 && error.source.nodeId);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("ClipPath is a closed typed unary API and lowers every accepted control", () => {
  const symbol = packageSymbol("cut:visual", "ClipPath");
  assert.deepEqual(symbol?.parameters?.map((parameter) => parameter.name), ["points", "fillRule", "invert"]);
  assert.deepEqual(symbol?.parameters?.find((parameter) => parameter.name === "fillRule")?.values, ["nonzero", "evenodd"]);
  assert.equal(symbol?.children, "visual");
  const kernel = referenceKernelSchema("cut.visual.clip_path");
  assert.equal(kernel?.support, "supported");
  if (kernel?.support === "supported") {
    assert.deepEqual(kernel.inputs, ["points", "fillRule", "invert"]);
    assert.deepEqual([kernel.minimumChildren, kernel.maximumChildren], [1, 1]);
  }

  const ir = compile(program(`ClipPath(points: ${square}, fillRule: "evenodd", invert: true) { Rect(width: 5px, height: 5px, fill: #336699); }`));
  const node = clipNode(ir), config = referenceClipPathConfig(ir, node);
  assert.deepEqual(node.inputs.fillRule, { kind: "string", value: "evenodd" });
  assert.deepEqual(node.inputs.invert, { kind: "boolean", value: true });
  assert.equal(config?.points.length, 4);
  assert.equal(config?.points[0].exactX.numerator, "1");
  assert.deepEqual({ fillRule: config?.fillRule, invert: config?.invert }, { fillRule: "evenodd", invert: true });

  const sourceFailures = [
    [program(`ClipPath(points: ${square}, fillRule: "winding") { Rect(width: 5px, height: 5px); }`), /fillRule.*one of: nonzero, evenodd/],
    [program(`ClipPath(points: ${square}, invert: 1) { Rect(width: 5px, height: 5px); }`), /invert.*expects Bool.*Number/],
    [program(`ClipPath(points: ${square}, feather: 1px) { Rect(width: 5px, height: 5px); }`), /does not execute input “feather”/],
  ] as const;
  for (const [source, expected] of sourceFailures) {
    const cutModule = parse(source), diagnostics = checkCutModule(cutModule).diagnostics;
    assert.match(diagnostics.map((item) => item.message).join("\n"), expected);
    assert.ok(diagnostics.some((item) => item.span.start.line > 0 && item.span.start.column > 0));
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }
  for (const source of [
    program(`ClipPath(points: ${square});`),
    program(`ClipPath(points: ${square}) { Rect(width: 5px, height: 5px); Rect(width: 2px, height: 2px); }`),
  ]) {
    assert.throws(() => compileCutModule(parse(source)), (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT2085"
        && /requires exactly one visual child/.test(item.message)
        && item.span.start.line > 0));
  }
});

test("ClipPath check/compile preflight rejects malformed, repeated, collinear, oversized and identity geometry with stable located codes", () => {
  for (const [points, code, expected] of [
    ["[{ x: 1px, y: 1px }, { x: 4px, y: 1px }]", "CUT_CLIP_PATH_VALUE_RANGE", /3 through 512/],
    ["[{ x: 1px, y: 1px }, { x: 1px, y: 1px }, { x: 4px, y: 4px }]", "CUT_CLIP_PATH_DEGENERATE", /zero-length edge/],
    ["[{ x: 1px, y: 1px }, { x: 2px, y: 2px }, { x: 3px, y: 3px }]", "CUT_CLIP_PATH_DEGENERATE", /collinear/],
    ["[{ x: 1px, y: 1px }, { x: 4px, y: 1px }, { x: 1px, y: 1px }]", "CUT_CLIP_PATH_DEGENERATE", /final point must not repeat/],
    ["[{ x: 65537px, y: 1px }, { x: 4px, y: 1px }, { x: 1px, y: 4px }]", "CUT_CLIP_PATH_VALUE_RANGE", /±65536px/],
  ] as const) {
    assert.throws(
      () => compileCutModule(parse(program(`ClipPath(points: ${points}) { Rect(width: 5px, height: 5px); }`))),
      (error: unknown) => error instanceof CutCompileError
        && error.result.diagnostics.some((item) => item.code === code && expected.test(item.message) && item.span.start.line > 0),
    );
  }

  const identitySource = program("ClipPath(points: [{ x: -1px, y: -1px }, { x: 6px, y: -1px }, { x: 6px, y: 6px }, { x: -1px, y: 6px }]) { Rect(width: 5px, height: 5px); }");
  assert.throws(() => compileCutModule(parse(identitySource)), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_CLIP_PATH_NOOP"
      && /identity wrapper/.test(item.message)
      && item.span.start.line > 0
      && item.span.start.column > 0));
});

test("fixed 4x4 scan conversion gives exact square, antialias, fill-rule and inversion pixels", async () => {
  const unclipped = await render(program("Rect(width: 5px, height: 5px, fill: #78502880);"));
  const squareRender = await render(program(`ClipPath(points: ${square}) { Rect(width: 5px, height: 5px, fill: #78502880); }`));
  assert.deepEqual(alphaPlane(squareRender.surface), [
    0, 0, 0, 0, 0,
    0, 128, 128, 128, 0,
    0, 128, 128, 128, 0,
    0, 128, 128, 128, 0,
    0, 0, 0, 0, 0,
  ]);
  assert.deepEqual(pixel(squareRender.surface, 2, 2), pixel(unclipped.surface, 2, 2), "full path coverage preserves the child's straight RGBA bytes exactly");
  assert.deepEqual(pixel(squareRender.surface, 0, 0), [0, 0, 0, 0]);

  const triangle = "[{ x: 0px, y: 0px }, { x: 4px, y: 0px }, { x: 0px, y: 4px }]";
  const normal = await render(program(`ClipPath(points: ${triangle}) { Rect(width: 5px, height: 5px, fill: #ffffff); }`));
  const inverted = await render(program(`ClipPath(points: ${triangle}, invert: true) { Rect(width: 5px, height: 5px, fill: #ffffff); }`));
  assert.ok(alphaPlane(normal.surface).some((alpha) => alpha > 0 && alpha < 255), "diagonal edge must use fixed fractional coverage");
  assert.deepEqual(alphaPlane(normal.surface).map((alpha, index) => alpha + alphaPlane(inverted.surface)[index]), Array(25).fill(255));
  assert.equal(digest((await render(program(`ClipPath(points: ${triangle}) { Rect(width: 5px, height: 5px, fill: #ffffff); }`))).surface.data), digest(normal.surface.data));

  const doubleWound = "[{ x: 1px, y: 1px }, { x: 4px, y: 1px }, { x: 4px, y: 4px }, { x: 1px, y: 4px }, { x: 1px, y: 1px }, { x: 4px, y: 1px }, { x: 4px, y: 4px }, { x: 1px, y: 4px }]";
  const nonzero = await render(program(`ClipPath(points: ${doubleWound}, fillRule: "nonzero") { Rect(width: 5px, height: 5px, fill: #ffffff); }`));
  const evenodd = await render(program(`ClipPath(points: ${doubleWound}, fillRule: "evenodd") { Rect(width: 5px, height: 5px, fill: #ffffff); }`));
  assert.equal(pixel(nonzero.surface, 2, 2)[3], 255);
  assert.equal(pixel(evenodd.surface, 2, 2)[3], 0);
});

test("ClipPath safely unpremultiplies child RGB and zeroes hidden RGB", () => {
  const ir = compile(program(`ClipPath(points: ${square}) { Rect(width: 5px, height: 5px); }`));
  const node = clipNode(ir), config = referenceClipPathConfig(ir, node)!;
  const plan = prepareReferenceClipPath(node, config, 5, 5);
  const clipped = applyReferenceClipPath(surface(5, 5, [64, 32, 16, 128], "premultiplied"), plan);
  assert.deepEqual(pixel(clipped, 2, 2), [128, 64, 32, 128]);
  assert.deepEqual(pixel(clipped, 0, 0), [0, 0, 0, 0]);
  assert.equal(clipped.alphaMode, "straight");
});

test("ClipPath order is authored: clipping a layer differs from clipping the completed composite", async () => {
  const inside = await render(program(`Composite() { Rect(width: 5px, height: 5px, fill: #0000ff); ClipPath(points: ${square}) { Rect(width: 5px, height: 5px, fill: #ff0000); } }`));
  const outside = await render(program(`ClipPath(points: ${square}) { Composite() { Rect(width: 5px, height: 5px, fill: #0000ff); Rect(width: 5px, height: 5px, fill: #ff0000); } }`));
  assert.deepEqual(pixel(inside.surface, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixel(outside.surface, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(inside.surface, 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(pixel(outside.surface, 2, 2), [255, 0, 0, 255]);
  assert.notEqual(digest(inside.surface.data), digest(outside.surface.data));
});

test("hostile loaded IR and scan work fail with bounded structured diagnostics", () => {
  const base = compile(program(`ClipPath(points: ${square}) { Rect(width: 5px, height: 5px); }`));
  const hostile = structuredClone(base), name = `${"🧨\n".repeat(20_000)}secret-control`;
  clipNode(hostile).inputs[name] = { kind: "boolean", value: true };
  finalizeGraphHashes(hostile);
  let captured: unknown;
  try { loadCutAvIr(JSON.stringify(hostile)); } catch (error) { captured = error; }
  assert.ok(captured instanceof CutAvIrValidationError);
  const encoded = JSON.stringify(cutDiagnosticsFromError(captured));
  assert.ok(Buffer.byteLength(encoded) < 1_024, `diagnostic amplified to ${Buffer.byteLength(encoded)} bytes`);
  const diagnostic = JSON.parse(encoded)[0];
  assert.equal(diagnostic.code, "CUT_IR_UNKNOWN_FIELD");
  assert.match(encoded, /Unicode code points.*UTF-8 bytes.*sha256/);

  const hostileProperty = structuredClone(base), propertyName = `${"🌀\r".repeat(20_000)}phantom-property`;
  clipNode(hostileProperty).properties[propertyName] = { kind: "boolean", value: true };
  finalizeGraphHashes(hostileProperty);
  let propertyCaptured: unknown;
  try { loadCutAvIr(JSON.stringify(hostileProperty)); } catch (error) { propertyCaptured = error; }
  assert.ok(propertyCaptured instanceof CutAvIrValidationError);
  const propertyDiagnostic = JSON.stringify(cutDiagnosticsFromError(propertyCaptured));
  assert.ok(Buffer.byteLength(propertyDiagnostic) < 1_024, `property diagnostic amplified to ${Buffer.byteLength(propertyDiagnostic)} bytes`);
  assert.match(propertyDiagnostic, /Unicode code points.*UTF-8 bytes.*sha256/);

  const node = clipNode(base), config = referenceClipPathConfig(base, node)!;
  assert.equal(
    referenceClipPathWorkUnits(1_920, 1_080, config.points.length),
    1_920 * 1_080 + 1_080 * 4 * (2 * 1_920 + 1 + config.points.length * (config.points.length - 1) + 4 * config.points.length),
    "declared work is exactly the documented coverage init plus four bounded sub-row passes",
  );
  expectClipError(
    () => prepareReferenceClipPath(node, config, 1, referenceClipPathLimits.maximumCanvasPixels),
    "CUT_CLIP_PATH_RESOURCE_LIMIT",
    /work units.*budget/,
  );
  expectClipError(
    () => validateReferenceClipPathCompositionBudget(
      Array.from({ length: referenceClipPathLimits.maximumNodesPerComposition + 1 }, () => ({ node, config })),
      5,
      5,
    ),
    "CUT_CLIP_PATH_RESOURCE_LIMIT",
    /128-ClipPath node limit/,
  );
  const malformed = structuredClone(base), malformedNode = clipNode(malformed);
  malformedNode.inputs.points = { kind: "string", value: "M0,0" };
  finalizeGraphHashes(malformed);
  expectClipError(() => validateReferenceSession(loadCutAvIr(JSON.stringify(malformed))), "CUT_CLIP_PATH_INPUT_TYPE", /List<Vec2>/);

  const identity = structuredClone(base), identityNode = clipNode(identity);
  identityNode.inputs.points = {
    kind: "array",
    items: [point(-1, -1), point(6, -1), point(6, 6), point(-1, 6)],
  };
  finalizeGraphHashes(identity);
  expectClipError(() => validateReferenceSession(loadCutAvIr(JSON.stringify(identity))), "CUT_CLIP_PATH_NOOP", /identity wrapper/);
});

test("ClipPath geometry participates in semantic identity and localized picture cache invalidation", () => {
  const before = compile(program(`ClipPath(points: ${square}, fillRule: "nonzero") { Rect(width: 5px, height: 5px, fill: #336699); }`));
  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = compile(program("ClipPath(points: [{ x: 1px, y: 1px }, { x: 3px, y: 1px }, { x: 4px, y: 4px }, { x: 1px, y: 4px }], fillRule: \"nonzero\") { Rect(width: 5px, height: 5px, fill: #336699); }"));
  const plan = createIncrementalRenderPlan(after, "main", previous), clip = clipNode(after);
  const rect = Object.values(after.nodes).find((node) => node.op === "cut.visual.rect");
  assert.ok(rect);
  assert.equal(plan.nodes.find((node) => node.id === rect.id)?.status, "hit", "unchanged arbitrary child stays reusable");
  assert.equal(plan.nodes.find((node) => node.id === clip.id)?.status, "miss");
  assert.ok(plan.scenes.every((scene) => scene.status === "miss"));
  assert.notEqual(before.buildId, after.buildId);

  const evenodd = compile(program(`ClipPath(points: ${square}, fillRule: "evenodd") { Rect(width: 5px, height: 5px, fill: #336699); }`));
  assert.notEqual(before.buildId, evenodd.buildId);
});
