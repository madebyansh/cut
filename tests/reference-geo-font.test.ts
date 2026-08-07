import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Font, Glyph, Path } from "opentype.js";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { builtinPackageImplementationFiles } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import {
  ReferenceGeoLabelError,
  parseReferenceGeoLabelFont,
  prepareReferenceGeoLabels,
  referenceGeoLabelCandidates,
  referenceGeoLabelConfig,
  referenceGeoLabelPath,
  referenceGeoPoints,
} from "../lib/runtime/reference/geo-labels";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function outlineFont(shape: "rectangle" | "triangle") {
  const path = new Path(); path.moveTo(80, 0);
  if (shape === "rectangle") { path.lineTo(80, 700); path.lineTo(920, 700); path.lineTo(920, 0); }
  else { path.lineTo(500, 700); path.lineTo(920, 0); }
  path.close();
  const missing = new Glyph({ name: ".notdef", unicode: 0, advanceWidth: 1_000, path: new Path() });
  const space = new Glyph({ name: "space", unicode: 32, advanceWidth: 250, path: new Path() });
  const glyph = new Glyph({ name: "A", unicode: 65, advanceWidth: 1_000, path });
  return Buffer.from(new Font({ familyName: `CUT Geo ${shape}`, styleName: "Regular", unitsPerEm: 1_000, ascender: 800, descender: -200, glyphs: [missing, space, glyph] }).toArrayBuffer());
}

function program(body: string, assets = "") {
  return `cut 0.4;
project "locked geo labels";
import { Map, Marker, Connections } from "@cut/geo";
${assets}
timeline main(duration: 1s, fps: 4, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");`;
}

const fontAsset = `asset face: FontAsset = font("assets/face.ttf");`;
const dataAsset = `asset places: DataAsset = data("assets/places.json");`;
const labeledData = JSON.stringify({ points: [{ latitude: 0, longitude: -30, label: "AAA" }, { latitude: 20, longitude: 60 }] });

function parsed(source: string) {
  const result = parseCutLanguage(source); assert.ok(result.module); assert.deepEqual(result.diagnostics, []); return result.module;
}

function compile(source: string) {
  const cutModule = parsed(source), diagnostics = checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(cutModule).ir;
}

async function lockedProject(source: string, files: Readonly<Record<string, Buffer | string>> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-geo-font-"));
  for (const [locator, bytes] of Object.entries(files)) {
    const path = resolve(root, locator); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
  }
  const ir = compile(source), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  return { root, ir };
}

function node(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op); assert.ok(result); return result;
}

async function pixels(project: { root: string; ir: CutAVIR }) {
  const { composition } = validateReferenceSession(project.ir), renderer = new ReferenceVisualRenderer(project.ir, composition, project.root, resolve(project.root, "cache"));
  try { await renderer.prepare(); return (await renderer.sceneFrame(project.ir.scenes[composition.sceneIds[0]], 0)).data; }
  finally { renderer.close(); }
}

function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

function geoError(code: ReferenceGeoLabelError["code"]) {
  return (error: unknown) => error instanceof ReferenceGeoLabelError && error.code === code && /project\.cut:\d+:\d+/.test(error.message);
}

test("Geo label source diagnostics are collision-free and source-located", () => {
  assert.ok(builtinPackageImplementationFiles("@cut/geo").includes("runtime/reference/geo-labels"));
  assert.ok(builtinPackageImplementationFiles("@cut/geo").includes("runtime/reference/locked-font"));
  const visible = parsed(program('Marker(point: { latitude: 0, longitude: 0, label: "AAA" });'));
  const visibleDiagnostics = checkCutModule(visible).diagnostics.filter((item) => item.severity === "error");
  assert.ok(visibleDiagnostics.some((item) => item.code === "CUT2082" && /host font fallback is forbidden/.test(item.message)));

  const noOp = parsed(program("Marker(point: { latitude: 0, longitude: 0 }, font: face);", fontAsset));
  const noOpDiagnostics = checkCutModule(noOp).diagnostics.filter((item) => item.severity === "error");
  assert.ok(noOpDiagnostics.some((item) => item.code === "CUT2083" && /no-op/.test(item.message)));

  const wrongType = parsed(program("Marker(point: { latitude: 0, longitude: 0, label: \"AAA\" }, font: places);", dataAsset));
  assert.ok(checkCutModule(wrongType).diagnostics.some((item) => item.code === "CUT2029" && /FontAsset/.test(item.message)));
  const reserved = new Set(["CUT2079", "CUT2080", "CUT2081"]);
  for (const code of ["CUT2082", "CUT2083"]) assert.equal(reserved.has(code), false, `${code} must remain disjoint from editorial and Video diagnostics`);
});

test("Map, Marker, and Connections render locked outline labels; font bytes affect pixels and cache identity", { timeout: 30_000 }, async () => {
  const cases = [
    `Map(points: places, font: face, reveal: 100%);`,
    `Marker(point: { latitude: 0, longitude: 0, label: "AAA" }, font: face, color: #22d3ee, radius: 7px);`,
    `Connections(points: places, target: { latitude: 0, longitude: 0, label: "AAA" }, font: face, count: 2, reveal: 100%);`,
  ];
  for (const body of cases) {
    const project = await lockedProject(program(body, `${fontAsset}\n${dataAsset}`), { "assets/face.ttf": outlineFont("rectangle"), "assets/places.json": labeledData });
    const rendered = await pixels(project);
    assert.ok(rendered.some((value) => value !== 0), `${body.split("(")[0]} must render visible pixels`);
  }

  const source = program(`Marker(point: { latitude: 0, longitude: 0, label: "AAA" }, font: face, color: #22d3ee, radius: 7px);`, fontAsset);
  const rectangle = await lockedProject(source, { "assets/face.ttf": outlineFont("rectangle") });
  const triangle = await lockedProject(source, { "assets/face.ttf": outlineFont("triangle") });
  assert.notEqual(digest(await pixels(rectangle)), digest(await pixels(triangle)), "different fixed locked font bytes must change geo-label pixels");
  assert.notEqual(createIncrementalRenderPlan(rectangle.ir, "main").scenes[0].key, createIncrementalRenderPlan(triangle.ir, "main").scenes[0].key, "font bytes must invalidate the picture scene cache key");
});

test("Geo loaded IR and resolved data fail before frames for missing, wrong, and no-op fonts", { timeout: 30_000 }, async () => {
  const source = program(`Marker(point: { latitude: 0, longitude: 0, label: "AAA" }, font: face);`, fontAsset);
  const missing = await lockedProject(source, { "assets/face.ttf": outlineFont("rectangle") }); delete node(missing.ir, "cut.geo.marker").inputs.font;
  assert.throws(() => validateReferenceSession(missing.ir), geoError("CUT_GEO_FONT_RESOURCE"));

  const wrong = await lockedProject(source, { "assets/face.ttf": outlineFont("rectangle") });
  node(wrong.ir, "cut.geo.marker").inputs.font = { kind: "string", value: "sans-serif" };
  assert.throws(() => validateReferenceSession(wrong.ir), geoError("CUT_GEO_FONT_RESOURCE"));

  const wrongKind = await lockedProject(source, { "assets/face.ttf": outlineFont("rectangle") });
  wrongKind.ir.resources.face.kind = "data";
  assert.throws(() => validateReferenceSession(wrongKind.ir), geoError("CUT_GEO_FONT_RESOURCE"));

  const noOp = await lockedProject(source, { "assets/face.ttf": outlineFont("rectangle") }), noOpNode = node(noOp.ir, "cut.geo.marker");
  noOpNode.inputs.label = { kind: "string", value: "" };
  assert.throws(() => validateReferenceSession(noOp.ir), geoError("CUT_GEO_FONT_COMBINATION"));

  const map = await lockedProject(program(`Map(points: places, font: face);`, `${fontAsset}\n${dataAsset}`), { "assets/face.ttf": outlineFont("rectangle"), "assets/places.json": labeledData });
  delete node(map.ir, "cut.geo.map").inputs.font;
  const mapSession = validateReferenceSession(map.ir), mapRenderer = new ReferenceVisualRenderer(map.ir, mapSession.composition, map.root, resolve(map.root, "cache"));
  await assert.rejects(() => mapRenderer.prepare(), geoError("CUT_GEO_FONT_RESOURCE")); mapRenderer.close();

  const malformedLabel = await lockedProject(program(`Map(points: places, font: face);`, `${fontAsset}\n${dataAsset}`), {
    "assets/face.ttf": outlineFont("rectangle"),
    "assets/places.json": JSON.stringify({ points: [{ latitude: 0, longitude: 0, label: 42 }] }),
  });
  const malformedSession = validateReferenceSession(malformedLabel.ir), malformedRenderer = new ReferenceVisualRenderer(malformedLabel.ir, malformedSession.composition, malformedLabel.root, resolve(malformedLabel.root, "cache"));
  await assert.rejects(() => malformedRenderer.prepare(), geoError("CUT_GEO_LABEL_TYPE")); malformedRenderer.close();

  const resolvedNoOp = await lockedProject(program(`Map(points: places, font: face);`, `${fontAsset}\n${dataAsset}`), {
    "assets/face.ttf": outlineFont("rectangle"),
    "assets/places.json": JSON.stringify({ points: [{ latitude: 0, longitude: 0 }] }),
  });
  const resolvedNoOpSession = validateReferenceSession(resolvedNoOp.ir), resolvedNoOpRenderer = new ReferenceVisualRenderer(resolvedNoOp.ir, resolvedNoOpSession.composition, resolvedNoOp.root, resolve(resolvedNoOp.root, "cache"));
  await assert.rejects(() => resolvedNoOpRenderer.prepare(), geoError("CUT_GEO_FONT_COMBINATION")); resolvedNoOpRenderer.close();
});

test("Geo fonts fail closed for malformed, variable, uncovered, and over-budget outline input", { timeout: 30_000 }, async () => {
  const sourceFor = (label: string) => program(`Marker(point: { latitude: 0, longitude: 0, label: "${label}" }, font: face);`, fontAsset);
  const malformed = await lockedProject(sourceFor("AAA"), { "assets/face.ttf": Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(8)]) });
  let session = validateReferenceSession(malformed.ir), renderer = new ReferenceVisualRenderer(malformed.ir, session.composition, malformed.root, resolve(malformed.root, "cache"));
  await assert.rejects(() => renderer.prepare(), geoError("CUT_GEO_FONT_PARSE")); renderer.close();

  const variableBytes = outlineFont("rectangle"); variableBytes.write("fvar", 12, 4, "ascii");
  const variable = await lockedProject(sourceFor("AAA"), { "assets/face.ttf": variableBytes });
  session = validateReferenceSession(variable.ir); renderer = new ReferenceVisualRenderer(variable.ir, session.composition, variable.root, resolve(variable.root, "cache"));
  await assert.rejects(() => renderer.prepare(), geoError("CUT_GEO_FONT_PARSE")); renderer.close();

  const uncovered = await lockedProject(sourceFor("B"), { "assets/face.ttf": outlineFont("rectangle") });
  session = validateReferenceSession(uncovered.ir); renderer = new ReferenceVisualRenderer(uncovered.ir, session.composition, uncovered.root, resolve(uncovered.root, "cache"));
  await assert.rejects(() => renderer.prepare(), geoError("CUT_GEO_FONT_COVERAGE")); renderer.close();

  const overBudget = await lockedProject(sourceFor("A".repeat(257)), { "assets/face.ttf": outlineFont("rectangle") });
  session = validateReferenceSession(overBudget.ir); renderer = new ReferenceVisualRenderer(overBudget.ir, session.composition, overBudget.root, resolve(overBudget.root, "cache"));
  await assert.rejects(() => renderer.prepare(), geoError("CUT_GEO_FONT_BUDGET")); renderer.close();
});

test("label-free geo is resource-free and prepared geo markup contains paths, never host text", { timeout: 30_000 }, async () => {
  const ir = compile(program(`Marker(point: { latitude: 0, longitude: 0 }, color: #22d3ee);`));
  assert.deepEqual(Object.keys(ir.resources), []); ir.determinism.semantic = "locked";
  const project = { root: await mkdtemp(resolve(tmpdir(), "cut-reference-geo-no-font-")), ir };
  assert.ok((await pixels(project)).some((value) => value !== 0));

  const marker = node(ir, "cut.geo.marker"), config = referenceGeoLabelConfig(marker, ir); assert.ok(config);
  assert.deepEqual(referenceGeoLabelCandidates(marker, referenceGeoPoints({ latitude: 0, longitude: 0 })), []);
  assert.equal(prepareReferenceGeoLabels(marker, config, [], undefined).runs.size, 0);

  const bytes = outlineFont("rectangle"), font = parseReferenceGeoLabelFont(marker, bytes, "assets/face.ttf");
  const candidate = referenceGeoLabelCandidates(
    { ...marker, inputs: { ...marker.inputs, label: { kind: "string", value: "AAA" } } } as IRNode,
    referenceGeoPoints({ latitude: 0, longitude: 0 }),
  );
  const prepared = prepareReferenceGeoLabels(marker, { ...config, fontId: "face" }, candidate, font);
  const markup = referenceGeoLabelPath(prepared.runs.get(0), { x: 10, y: 20, fill: "#ffffff" });
  assert.match(markup, /^<path d=/); assert.doesNotMatch(markup, /<text|font-family|@font-face|sans-serif/u);
});
