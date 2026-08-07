import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import {
  cutMediaCamera2DControlDefaults,
  cutMediaCamera2DDefaultIRValue,
  cutMediaCamera2DInputs,
  cutMediaCamera2DOp,
  cutMediaCamera2DProperties,
} from "../lib/language/media-camera2d-contract";
import { parseCutLanguage } from "../lib/language/parser";
import { builtinPackageImplementationFiles, builtinPackages } from "../lib/language/packages";
import { assertResolvedCutIr } from "../lib/language/resolution";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { finalizeGraphHashes } from "../lib/runtime/graph";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  return parsed.module;
}

function compile(source: string) {
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  return compileCutModule(cutModule).ir;
}

function expectDiagnostic(source: string, code: string) {
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  const checkedDiagnostic = checked.diagnostics.find((item) => item.severity === "error" && item.code === code);
  if (checkedDiagnostic) {
    assert.ok(checkedDiagnostic.span.start.line >= 1 && checkedDiagnostic.span.start.column >= 1);
    return checkedDiagnostic;
  }
  assert.throws(() => compileCutModule(cutModule), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, String(error));
    const diagnostic = error.result.diagnostics.find((item) => item.severity === "error" && item.code === code);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.ok(diagnostic.span.start.line >= 1 && diagnostic.span.start.column >= 1);
    return true;
  });
}

function source(sceneBody: string, options: Readonly<{ timelineBody?: string; declarations?: string; note?: string }> = {}) {
  return `cut 0.4;
project "MediaCamera2D language proof";
${options.note ?? ""}
import { MediaCamera2D, Camera2D, Image, Video, ColorGrade, Group } from "cut:visual";
import { linear } from "@cut/motion";
asset still: ImageAsset = image("media/still.png");
asset footage: VideoAsset = video("media/footage.mp4");
${options.declarations ?? ""}
timeline main(duration: 2s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  ${options.timelineBody ?? `scene only(duration: 2s) {
    ${sceneBody}
  }`}
}
export out = render(main);`;
}

function camera(ir: CutAVIR) {
  const matches = Object.values(ir.nodes).filter((node) => node.op === cutMediaCamera2DOp);
  assert.equal(matches.length, 1);
  return matches[0]!;
}

function child(ir: CutAVIR, node = camera(ir)) {
  assert.equal(node.children.length, 1);
  const result = ir.nodes[node.children[0]!];
  assert.ok(result);
  return result;
}

function clone<T>(value: T): T { return structuredClone(value); }

function ratio(numerator: number, denominator = 1): IRValue {
  return { kind: "quantity", dimension: "ratio", magnitude: { numerator: String(numerator), denominator: String(denominator) }, unit: "ratio" };
}

const namedCamera = `MediaCamera2D(
  focusX: 55%, focusY: 45%, zoom: 1.5, rotation: 2deg, opacity: 90%, edge: "clamp"
) as camera {
  Image(source: still, fit: "cover", crop: { x: 10%, y: 0%, width: 80%, height: 100% });
}
animate camera.focusX from 55% to 65% over 1s ease linear;
animate camera.focusY from 45% to 35% over 1s ease linear;
animate camera.zoom from 1.5 to 2 over 1s ease linear;
animate camera.rotation from 2deg to -3deg over 1s ease linear;
animate camera.opacity from 90% to 75% over 1s ease linear;`;

test("cut:visual exposes one closed public MediaCamera2D V1 operation and implementation root", () => {
  const visual = builtinPackages.get("cut:visual"), symbol = visual?.symbols.MediaCamera2D;
  assert.ok(symbol);
  assert.equal(symbol.kind, "component");
  assert.equal(symbol.native, cutMediaCamera2DOp);
  assert.equal(symbol.domain, "visual");
  assert.equal(symbol.children, "visual");
  assert.deepEqual(symbol.parameters?.map((parameter) => [parameter.name, parameter.type, parameter.default]), [
    ["focusX", "Ratio", "50%"],
    ["focusY", "Ratio", "50%"],
    ["zoom", "Number", 1],
    ["rotation", "Angle", "0deg"],
    ["opacity", "Ratio", "100%"],
    ["edge", "String", "transparent"],
  ]);
  assert.deepEqual(cutMediaCamera2DInputs, ["focusX", "focusY", "zoom", "rotation", "opacity", "edge"]);
  assert.deepEqual(cutMediaCamera2DProperties, ["focusX", "focusY", "zoom", "rotation", "opacity"]);
  assert.deepEqual(Object.fromEntries(Object.entries(cutMediaCamera2DControlDefaults).map(([name, value]) => [name, value])), {
    focusX: { numerator: "1", denominator: "2" },
    focusY: { numerator: "1", denominator: "2" },
    zoom: { numerator: "1", denominator: "1" },
    rotation: { numerator: "0", denominator: "1" },
    opacity: { numerator: "1", denominator: "1" },
  });
  assert.deepEqual(cutMediaCamera2DDefaultIRValue("focusX"), ratio(1, 2));
  assert.equal(cutMediaCamera2DDefaultIRValue("notAControl"), undefined);
  assert.ok(builtinPackageImplementationFiles("cut:visual").includes("language/media-camera2d-contract"));
});

test("named and positional source lower to the same closed typed graph and all five camera controls animate", () => {
  const named = compile(source(namedCamera));
  const positional = compile(source(namedCamera.replace(
    "focusX: 55%, focusY: 45%, zoom: 1.5, rotation: 2deg, opacity: 90%, edge: \"clamp\"",
    "55%, 45%, 1.5, 2deg, 90%, \"clamp\"",
  )));
  const namedNode = camera(named), positionalNode = camera(positional);
  assert.deepEqual(namedNode.inputs, positionalNode.inputs);
  assert.equal(namedNode.domain, "visual");
  assert.equal(namedNode.ownership, "root");
  assert.equal(namedNode.sceneId, named.scenes[Object.keys(named.scenes)[0]!]!.id);
  assert.deepEqual(namedNode.interval, { start: { numerator: "0", denominator: "1" }, duration: { numerator: "2", denominator: "1" } });
  assert.deepEqual(Object.keys(namedNode.inputs), [...cutMediaCamera2DInputs]);
  assert.deepEqual(Object.keys(namedNode.properties), [...cutMediaCamera2DProperties]);
  for (const property of cutMediaCamera2DProperties) {
    const reference = namedNode.properties[property];
    assert.ok(reference && "signal" in reference, property);
    const signal = named.signals[reference.signal];
    assert.ok(signal, property);
    assert.equal(signal.valueType, property === "zoom" ? "Number" : property === "rotation" ? "Angle" : "Ratio");
    assert.equal(signal.kind, "track");
    if (signal.kind === "track") {
      assert.deepEqual(signal.initial, namedNode.inputs[property], `${property} track owns its exact constructor baseline`);
    }
  }
  const leaf = child(named, namedNode);
  assert.equal(leaf.op, "cut.visual.image");
  assert.equal(leaf.ownership, "child");
  assert.deepEqual(leaf.interval, namedNode.interval);
  assert.deepEqual(Object.keys(leaf.inputs), ["source", "fit", "crop"]);
  assert.doesNotThrow(() => assertResolvedCutIr(named));
  assert.equal(loadCutAvIr(JSON.stringify(named)).buildId, named.buildId);
});

test("omitted defaults remain absent while direct Video and one ColorGrade wrapper preserve public leaf semantics", () => {
  const image = compile(source("MediaCamera2D(zoom: 1.25) { Image(source: still); }"));
  assert.deepEqual(Object.keys(camera(image).inputs), ["zoom"]);
  assert.deepEqual(camera(image).properties, {});

  const video = compile(source(`MediaCamera2D(zoom: 1.25) {
    Video(source: footage, range: 250ms ..< 1250ms, fit: "contain", crop: { x: 10%, y: 5%, width: 80%, height: 90% }, loop: true);
  }`));
  const videoLeaf = child(video);
  assert.equal(videoLeaf.op, "cut.visual.video");
  assert.deepEqual(Object.keys(videoLeaf.inputs), ["source", "range", "fit", "crop", "loop"]);
  assert.equal(videoLeaf.inputs.range?.kind, "range");
  assert.equal(videoLeaf.inputs.loop?.kind, "boolean");

  const graded = compile(source("MediaCamera2D(focusX: 60%) { ColorGrade(exposure: 0.2) { Image(source: still, fit: \"fill\"); } }"));
  const grade = child(graded);
  assert.equal(grade.op, "cut.visual.color_grade");
  assert.equal(grade.children.length, 1);
  assert.equal(graded.nodes[grade.children[0]!]!.op, "cut.visual.image");
  assert.equal(loadCutAvIr(JSON.stringify(graded)).buildId, graded.buildId);
});

test("checker confines MediaCamera2D to one direct scene-root declaration", () => {
  const statement = "MediaCamera2D(zoom: 1.2) { Image(source: still); }";
  for (const invalid of [
    source(`at 0s { ${statement} }`),
    source(`if true { ${statement} }`),
    source(`let detached = MediaCamera2D(zoom: 1.2);`),
    source("Image(source: still);", { timelineBody: `${statement} scene only(duration: 2s) { Image(source: still); }` }),
    source("Shot();", { declarations: `component Shot() -> Visual { ${statement} }` }),
  ]) expectDiagnostic(invalid, "CUT_MEDIA_CAMERA_SCOPE");
});

test("checker rejects every graph outside direct Image/Video or ColorGrade-to-Image/Video", () => {
  for (const body of [
    "MediaCamera2D(zoom: 1.2) {}",
    "MediaCamera2D(zoom: 1.2) { Image(source: still); Image(source: still); }",
    "MediaCamera2D(zoom: 1.2) { Group() { Image(source: still); } }",
    "MediaCamera2D(zoom: 1.2) { ColorGrade(exposure: 0.1) { ColorGrade(exposure: 0.2) { Image(source: still); } } }",
    "MediaCamera2D(zoom: 1.2) { Image(source: still, opacity: 90%); }",
    "MediaCamera2D(zoom: 1.2) { Video(source: footage, scale: 1.1); }",
    "MediaCamera2D(zoom: 1.2) { ColorGrade(exposure: 0.1, rotation: 1deg) { Image(source: still); } }",
  ]) expectDiagnostic(source(body), "CUT_MEDIA_CAMERA_GRAPH");
});

test("bounds, types, edge policy, and inert cameras fail with stable diagnostics", () => {
  for (const args of [
    "focusX: -1%, zoom: 1.2",
    "focusY: 101%, zoom: 1.2",
    "zoom: 0.99",
    "zoom: 8.01",
    "rotation: 360001deg",
    "opacity: 101%, zoom: 1.2",
    "edge: \"mirror\", zoom: 1.2",
    "focusX: 12px, zoom: 1.2",
  ]) expectDiagnostic(source(`MediaCamera2D(${args}) { Image(source: still); }`), "CUT_MEDIA_CAMERA_VALUE");

  for (const body of [
    "MediaCamera2D() { Image(source: still); }",
    "MediaCamera2D(focusX: 50%, focusY: 50%, zoom: 1, rotation: 360deg, opacity: 100%, edge: \"transparent\") { Image(source: still); }",
    "MediaCamera2D(zoom: 2, opacity: 0%) { Image(source: still); }",
    `MediaCamera2D(zoom: 2, opacity: 0%) as camera { Image(source: still); }
     animate camera.opacity from 0% to 0% over 2s ease linear;`,
  ]) expectDiagnostic(source(body), "CUT_MEDIA_CAMERA_NOOP");

  for (const body of [
    "MediaCamera2D(zoom: 2, focusX: 50%) { Image(source: still); }",
    "MediaCamera2D(zoom: 2, focusY: 50%) { Image(source: still); }",
    "MediaCamera2D(focusX: 60%, zoom: 1) { Image(source: still); }",
    "MediaCamera2D(zoom: 2, rotation: 0deg) { Image(source: still); }",
    "MediaCamera2D(zoom: 2, rotation: 360deg) { Image(source: still); }",
    "MediaCamera2D(zoom: 2, opacity: 100%) { Image(source: still); }",
    "MediaCamera2D(zoom: 2, edge: \"transparent\") { Image(source: still); }",
  ]) expectDiagnostic(source(body), "CUT_MEDIA_CAMERA_NOOP");

  assert.doesNotThrow(() => compile(source("MediaCamera2D(edge: \"clamp\") { Image(source: still); }")));
  assert.doesNotThrow(() => compile(source(`MediaCamera2D() as camera { Image(source: still); }
    animate camera.rotation from 0deg to 360deg over 2s ease linear;`)));
  assert.doesNotThrow(() => compile(source(`MediaCamera2D(opacity: 0%) as camera { Image(source: still); }
    animate camera.opacity from 0% to 100% over 2s ease linear;`)));
  expectDiagnostic(source(`MediaCamera2D(zoom: 1.2) as camera { Image(source: still); }
    animate camera.zoom from 1.2 to 9 over 2s ease linear;`), "CUT_MEDIA_CAMERA_VALUE");

  for (const animation of [
    "animate camera.focusX from 50% to 60% over 1f ease linear;",
    "animate camera.focusY from 50% to 40% over 1f ease linear;",
    "animate camera.zoom from 1 to 2 over 1f ease linear;",
  ]) {
    expectDiagnostic(source("", {
      timelineBody: `scene only(duration: 1f) {
        MediaCamera2D() as camera { Image(source: still); }
        ${animation}
      }`,
    }).replace("timeline main(duration: 2s", "timeline main(duration: 1f"), "CUT2085");
  }

  for (const statement of [
    "set camera.focusX = 60%;",
    "set camera.focusY = 40%;",
    "set camera.zoom = 2;",
    "set camera.rotation = 10deg;",
    "set camera.opacity = 50%;",
  ]) {
    expectDiagnostic(source(`MediaCamera2D(zoom: 1.2) as camera { Image(source: still); }
      at 1990ms { ${statement} }`), "CUT2085");
  }
});

test("unknown, extra positional, and hidden spatial arguments remain closed", () => {
  expectDiagnostic(source("MediaCamera2D(x: 10px, zoom: 1.2) { Image(source: still); }"), "CUT2059");
  expectDiagnostic(source("MediaCamera2D(50%, 50%, 1.2, 0deg, 100%, \"clamp\", 1) { Image(source: still); }"), "CUT2025");
  expectDiagnostic(source("MediaCamera2D(zoom: 1.2, crop: { x: 0%, y: 0%, width: 100%, height: 100% }) { Image(source: still); }"), "CUT2059");
});

function expectHostileMutation(
  name: string,
  mutate: (ir: CutAVIR, camera: IRNode, leaf: IRNode) => void,
  code: CutAvIrValidationError["code"],
  path: RegExp,
) {
  const ir = clone(compile(source("MediaCamera2D(zoom: 1.25) { Image(source: still); }")));
  const cameraNode = camera(ir), leafNode = child(ir, cameraNode);
  mutate(ir, cameraNode, leafNode);
  finalizeGraphHashes(ir);
  assert.throws(() => loadCutAvIr(JSON.stringify(ir)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, `${name}: ${String(error)}`);
    assert.equal(error.code, code, name);
    assert.match(error.path, path, name);
    return true;
  });
}

test("strict loading repeats scope, graph, value, no-op, and closed-field contracts against re-signed hostile IR", () => {
  expectHostileMutation("short interval", (_ir, cameraNode) => {
    cameraNode.interval.duration = { numerator: "1", denominator: "1" };
  }, "CUT_MEDIA_CAMERA_SCOPE", /\.interval$/u);
  expectHostileMutation("arbitrary branch", (_ir, _cameraNode, leafNode) => {
    leafNode.op = "cut.visual.group";
    leafNode.inputs = {};
  }, "CUT_MEDIA_CAMERA_GRAPH", /nodes/u);
  expectHostileMutation("out of range", (_ir, cameraNode) => {
    cameraNode.inputs.zoom = { kind: "quantity", dimension: "scalar", magnitude: { numerator: "9", denominator: "1" }, unit: "scalar" };
  }, "CUT_MEDIA_CAMERA_VALUE", /\.inputs\.zoom$/u);
  expectHostileMutation("default-only", (_ir, cameraNode) => {
    Reflect.deleteProperty(cameraNode.inputs, "zoom");
  }, "CUT_MEDIA_CAMERA_NOOP", /nodes/u);
  expectHostileMutation("explicit default focusX beside zoom", (_ir, cameraNode) => {
    cameraNode.inputs.focusX = ratio(1, 2);
  }, "CUT_MEDIA_CAMERA_NOOP", /\.inputs\.focusX$/u);
  expectHostileMutation("explicit default focusY beside zoom", (_ir, cameraNode) => {
    cameraNode.inputs.focusY = ratio(1, 2);
  }, "CUT_MEDIA_CAMERA_NOOP", /\.inputs\.focusY$/u);
  expectHostileMutation("explicit default zoom beside focus", (_ir, cameraNode) => {
    cameraNode.inputs.focusX = ratio(3, 5);
    cameraNode.inputs.zoom = { kind: "quantity", dimension: "scalar", magnitude: { numerator: "1", denominator: "1" }, unit: "scalar" };
  }, "CUT_MEDIA_CAMERA_NOOP", /\.inputs\.zoom$/u);
  expectHostileMutation("explicit default rotation beside zoom", (_ir, cameraNode) => {
    cameraNode.inputs.rotation = { kind: "quantity", dimension: "angle", magnitude: { numerator: "0", denominator: "1" }, unit: "deg" };
  }, "CUT_MEDIA_CAMERA_NOOP", /\.inputs\.rotation$/u);
  expectHostileMutation("explicit whole turn beside zoom", (_ir, cameraNode) => {
    cameraNode.inputs.rotation = { kind: "quantity", dimension: "angle", magnitude: { numerator: "360", denominator: "1" }, unit: "deg" };
  }, "CUT_MEDIA_CAMERA_NOOP", /\.inputs\.rotation$/u);
  expectHostileMutation("explicit default opacity beside zoom", (_ir, cameraNode) => {
    cameraNode.inputs.opacity = ratio(1);
  }, "CUT_MEDIA_CAMERA_NOOP", /\.inputs\.opacity$/u);
  expectHostileMutation("explicit default edge beside zoom", (_ir, cameraNode) => {
    cameraNode.inputs.edge = { kind: "string", value: "transparent" };
  }, "CUT_MEDIA_CAMERA_NOOP", /\.inputs\.edge$/u);
  expectHostileMutation("static property escape", (_ir, cameraNode) => {
    cameraNode.properties.focusX = ratio(3, 5);
  }, "CUT_MEDIA_CAMERA_GRAPH", /\.properties\.focusX$/u);
  expectHostileMutation("unknown input", (_ir, cameraNode) => {
    cameraNode.inputs.x = { kind: "quantity", dimension: "length", magnitude: { numerator: "10", denominator: "1" }, unit: "px" };
  }, "CUT_IR_UNKNOWN_FIELD", /\.inputs\.x$/u);
});

test("every authored control and signal participates in semantic diff, node graph identity, and build identity", () => {
  const baseline = compile(source("MediaCamera2D(zoom: 1.25) { Image(source: still); }"));
  const baselineNode = camera(baseline);
  const variants = [
    ["focusX", "MediaCamera2D(focusX: 60%, zoom: 1.25) { Image(source: still); }"],
    ["focusY", "MediaCamera2D(focusY: 40%, zoom: 1.25) { Image(source: still); }"],
    ["zoom", "MediaCamera2D(zoom: 1.5) { Image(source: still); }"],
    ["rotation", "MediaCamera2D(zoom: 1.25, rotation: 5deg) { Image(source: still); }"],
    ["opacity", "MediaCamera2D(zoom: 1.25, opacity: 90%) { Image(source: still); }"],
    ["edge", "MediaCamera2D(zoom: 1.25, edge: \"clamp\") { Image(source: still); }"],
  ] as const;
  for (const [field, body] of variants) {
    const changed = compile(source(body)), changedNode = camera(changed);
    assert.notEqual(changedNode.contentHash, baselineNode.contentHash, field);
    assert.notEqual(changed.buildId, baseline.buildId, field);
    const difference = diffCutAVIR(baseline, changed).changes.find((item) => item.entity === "node" && item.id === baselineNode.id);
    assert.ok(difference && difference.operation === "modify", field);
    assert.ok(difference.fields?.some((entry) => entry.path.includes(field)), JSON.stringify(difference));
  }

  const animated = (end: string) => compile(source(`MediaCamera2D(zoom: 1.25) as camera { Image(source: still); }
    animate camera.focusX from 50% to ${end} over 2s ease linear;`));
  const first = animated("60%"), second = animated("70%");
  assert.notEqual(camera(first).contentHash, camera(second).contentHash);
  assert.notEqual(first.buildId, second.buildId);
  const changes = diffCutAVIR(first, second).changes;
  assert.ok(changes.some((item) => item.entity === "signal" && item.operation === "modify"));
  assert.equal(changes.some((item) => item.entity === "node" && item.id === camera(first).id), false, "semantic diff attributes a signal-only edit to the signal while graph hashing still invalidates its owner node");
});

test("formatting and comments preserve camera identity while legacy visual node wires gain no camera fields", () => {
  const canonical = compile(source("MediaCamera2D(zoom: 1.25) { Image(source: still); }"));
  const formatted = compile(source("MediaCamera2D(zoom: 1.25) {\n      Image(source: still);\n    }", { note: "// source-only camera note" }));
  assert.equal(formatted.buildId, canonical.buildId);

  const legacy = compile(source("Camera2D(x: 3px, y: 4px, scale: 1.1, rotation: 2deg, opacity: 90%) { Image(source: still, fit: \"contain\"); }"));
  assert.equal(Object.values(legacy.nodes).some((node) => node.op === cutMediaCamera2DOp), false);
  const oldCamera = Object.values(legacy.nodes).find((node) => node.op === "cut.visual.camera2d");
  assert.ok(oldCamera);
  assert.deepEqual(Object.keys(oldCamera.inputs), ["x", "y", "scale", "rotation", "opacity"]);
  assert.deepEqual(oldCamera.properties, {});
  assert.equal(Object.hasOwn(oldCamera.inputs, "focusX"), false);
  assert.equal(Object.hasOwn(oldCamera.inputs, "edge"), false);
});

test("the public IR schema accepts canonical MediaCamera2D and rejects hidden fields and static property escapes", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  const canonical = compile(source(namedCamera));
  assert.equal(validate(canonical), true, JSON.stringify(validate.errors));

  const hidden = clone(canonical), hiddenNode = camera(hidden);
  hiddenNode.inputs.x = { kind: "quantity", dimension: "length", magnitude: { numerator: "1", denominator: "1" }, unit: "px" };
  assert.equal(validate(hidden), false);
  assert.ok(validate.errors?.some((error) => /inputs/u.test(error.dataPath)), JSON.stringify(validate.errors));

  const property = clone(canonical), propertyNode = camera(property);
  propertyNode.properties.focusX = ratio(3, 5);
  assert.equal(validate(property), false);
  assert.ok(validate.errors?.some((error) => /properties/u.test(error.dataPath)), JSON.stringify(validate.errors));
});
