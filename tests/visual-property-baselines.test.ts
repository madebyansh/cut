import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRSignal, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import {
  kernelPropertyInputIsIntrinsic,
  kernelPropertyValueType,
  referenceKernelRegistry,
} from "../lib/language/kernel-registry";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  CutVisualPropertyBaselineError,
  cutVisualPropertyBaselineRegistry,
  resolveCutVisualPropertyTrackBaseline,
  validateCutVisualPropertyTrackBaselines,
} from "../lib/language/visual-property-baselines";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import { referenceChartRevealAt } from "../lib/runtime/reference/chart-config";
import { referenceColorGradeConfigAt } from "../lib/runtime/reference/color-grade-config";
import { referenceMapCameraStateAt } from "../lib/runtime/reference/map-camera";
import { propertyAt } from "../lib/runtime/reference/signals";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  prepareReferenceVectorPathNode,
  referenceVectorPathFrameAt,
} from "../lib/runtime/reference/vector-path";
import { referenceVisualTransformAt } from "../lib/runtime/reference/visual-config";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const linearImport = 'import { linear } from "@cut/motion";';
const exec = promisify(execFile);

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return parsed.module;
}

function compile(source: string) {
  const cutModule = moduleFor(source);
  const checked = checkCutModule(cutModule);
  assert.deepEqual(
    checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(checked.diagnostics),
  );
  return compileCutModule(cutModule).ir;
}

function compileDiagnostic(source: string, code: string) {
  const cutModule = moduleFor(source);
  const checked = checkCutModule(cutModule);
  const checkedDiagnostic = checked.diagnostics.find((diagnostic) => diagnostic.severity === "error" && diagnostic.code === code);
  if (checkedDiagnostic) return checkedDiagnostic;
  try {
    compileCutModule(cutModule);
  } catch (error) {
    assert.ok(error instanceof CutCompileError, String(error));
    const diagnostic = error.result.diagnostics.find((item) => item.severity === "error" && item.code === code);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    return diagnostic;
  }
  assert.fail(`Expected ${code}.`);
}

function node(ir: CutAVIR, operation: string) {
  const found = Object.values(ir.nodes).find((candidate) => candidate.op === operation);
  assert.ok(found, operation);
  return found;
}

function propertyTrack(ir: CutAVIR, operation: string, property: string) {
  const owner = node(ir, operation), reference = owner.properties[property];
  assert.ok(reference && "signal" in reference, `${operation}.${property}`);
  const signal = ir.signals[reference.signal];
  assert.equal(signal?.kind, "track", `${operation}.${property}`);
  return { owner, signal: signal as Extract<IRSignal, { kind: "track" }> };
}

function simpleProgram(imports: string, body: string, declarations = "") {
  return `cut 0.4;
project "visual baseline proof";
${imports}
${linearImport}
${declarations}
timeline main(duration: 3s, fps: 4, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 3s) {
    ${body}
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");`;
}

function groupProgram(animated = true) {
  return simpleProgram(
    'import { Group, Rect } from "cut:visual";',
    `Group() as target { Rect(width: 24px, height: 16px, fill: #ffffff); }
    ${animated ? "at 1s { animate target.x from 0px to 20px over 1s ease linear; }" : ""}`,
  );
}

function colorGradeProgram(animated = true) {
  return simpleProgram(
    'import { ColorGrade, Rect } from "cut:visual";',
    `ColorGrade() as target { Rect(width: 24px, height: 16px, fill: #406080); }
    ${animated ? "at 1s { animate target.exposure from 0 to 1 over 1s ease linear; }" : ""}`,
  );
}

function lutProgram(animated = true) {
  return simpleProgram(
    'import { LUT, Rect } from "cut:visual";',
    `LUT(source: look) as target { Rect(width: 24px, height: 16px, fill: #406080); }
    ${animated ? "at 1s { animate target.strength from 100% to 25% over 1s ease linear; }" : ""}`,
    'asset look: DataAsset = data("assets/look.cube");',
  );
}

function chartProgram(animated = true) {
  return simpleProgram(
    'import { Chart } from "@cut/data";',
    `Chart(values: [1, 3, 2], kind: "bar", width: 120px, height: 80px) as target;
    ${animated ? "at 1s { animate target.reveal from 100% to 20% over 1s ease linear; }" : ""}`,
  );
}

function chartPositionProgram(animated = true) {
  return simpleProgram(
    'import { Chart } from "@cut/data";',
    `Chart(values: [1, 3, 2], kind: "bar", width: 120px, height: 80px, x: 160px, y: 90px) as target;
    ${animated ? "at 1s { animate target.x from 0px to 18px over 1s ease linear; }" : ""}`,
  );
}

function mapCameraProgram(animated = true) {
  return simpleProgram(
    'import { MapCamera, Map, Marker } from "@cut/geo";',
    `MapCamera() as target {
      Map(detail: "110m");
      Marker(point: { latitude: 20, longitude: 78 }, color: #ff3300, radius: 4px);
    }
    ${animated ? "at 1s { animate target.pitch from 0deg to 40deg over 1s ease linear; }" : ""}`,
  );
}

function globeProgram(animated = true) {
  return simpleProgram(
    'import { Globe } from "@cut/geo";',
    `Globe(
      rotation: 30deg,
      tilt: -12deg,
      radius: 66px,
      x: 160px,
      y: 90px,
      ocean: #07141f,
      land: #d7c7a8,
      line: #5f8d97
    ) as target;
    ${animated ? "at 1s { animate target.rotation from 30deg to 90deg over 1s ease linear; }" : ""}`,
  );
}

function pathProgram(animated = true) {
  return simpleProgram(
    'import { Path, lineTo, vectorPath } from "cut:visual";',
    `Path(
      geometry: vectorPath(
        start: { x: 10px, y: 20px },
        segments: [lineTo(to: { x: 90px, y: 20px })],
        closed: false
      ),
      stroke: #ffffff,
      width: 3px
    ) as target;
    ${animated ? "at 1s { animate target.trimEnd from 100% to 25% over 1s ease linear; }" : ""}`,
  );
}

function pathPositionProgram(animated = true, positioned = true) {
  const position = positioned ? ",\n      x: 7px,\n      y: -3px" : "";
  return simpleProgram(
    'import { Path, lineTo, vectorPath } from "cut:visual";',
    `Path(
      geometry: vectorPath(
        start: { x: 30px, y: 70px },
        segments: [
          lineTo(to: { x: 110px, y: 30px }),
          lineTo(to: { x: 180px, y: 90px })
        ],
        closed: false
      ),
      stroke: #f4d35e,
      width: 5px${position}
    ) as target;
    ${animated ? `at 1s { animate target.x from ${positioned ? "7px" : "0px"} to ${positioned ? "27px" : "20px"} over 1s ease linear; }` : ""}`,
  );
}

function mapRotationProgram(animated = true) {
  return simpleProgram(
    'import { Map } from "@cut/geo";',
    `Map(rotation: 12deg) as target;
    ${animated ? "at 1s { animate target.rotation from 12deg to 24deg over 1s ease linear; }" : ""}`,
  );
}

function mediaPositionProgram(kind: "Image" | "Video", animated = true, positioned = true) {
  const declaration = kind === "Image"
    ? 'asset media: ImageAsset = image("assets/source.png");'
    : 'asset media: VideoAsset = video("assets/source.mkv");';
  const position = positioned ? ", x: 7px, y: -3px" : "";
  const endBehavior = kind === "Video" ? ', endBehavior: "hold"' : "";
  return simpleProgram(
    `import { ${kind} } from "cut:visual";`,
    `${kind}(source: media, fit: "contain"${endBehavior}${position}) as target;
    ${animated ? `at 1s { animate target.x from ${positioned ? "7px" : "0px"} to ${positioned ? "27px" : "20px"} over 1s ease linear; }` : ""}`,
    declaration,
  );
}

function motionPathProgram(animated = true) {
  return simpleProgram(
    'import { MotionPath, Rect } from "cut:visual";',
    `MotionPath(points: [{ x: 10px, y: 30px }, { x: 100px, y: 30px }]) as target {
      Rect(width: 8px, height: 8px, fill: #ff3300);
    }
    ${animated ? "at 1s { animate target.progress from 0% to 100% over 1s ease linear; }" : ""}`,
  );
}

function geoAnnotationProgram() {
  return simpleProgram(
    'import { ParallaxCamera, DepthLayer, Rect } from "cut:visual";\nimport { GeoAnnotation } from "@cut/geo";',
    `ParallaxCamera(focalLength: 300px) {
      DepthLayer(depth: 100px, edge: "transparent") {
        Rect(width: 320px, height: 180px, x: 160px, y: 90px, fill: #111111);
        GeoAnnotation(
          anchor: { latitude: 29.97, longitude: 32.55 },
          width: 40px,
          height: 20px,
          placements: ["right"],
          offset: 4px,
          safeArea: 4px,
          leader: "straight",
          leaderColor: #ffffff,
          leaderWidth: 1px
        ) as target {
          Rect(width: 40px, height: 20px, x: 50px, y: 40px, fill: #ffffff);
        }
        at 1s { animate target.opacity from 100% to 25% over 1s ease linear; }
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        Rect(width: 10px, height: 10px, x: 10px, y: 10px, fill: #333333);
      }
    }`,
  );
}

function camera3DProgram(options: { animated?: boolean; focalLength?: boolean; planeZ?: boolean } = {}) {
  const animated = options.animated ?? true;
  const firstPlaneArguments = [options.planeZ === false ? "" : "z: 120px", 'edge: "transparent"'].filter(Boolean).join(", ");
  return simpleProgram(
    'import { Camera3D, LocalSpace, Plane3D, Rect } from "cut:visual";',
    `Camera3D(${options.focalLength === false ? "" : "focalLength: 180px"}) as camera {
      Plane3D(${firstPlaneArguments}) as plane {
        LocalSpace(width: 80px, height: 60px, origin: { x: 40px, y: 30px }) {
          Rect(width: 80px, height: 60px, x: 0px, y: 0px, fill: #e4d7b9);
        }
      }
      Plane3D(z: 260px, edge: "transparent") {
        LocalSpace(width: 80px, height: 60px, origin: { x: 40px, y: 30px }) {
          Rect(width: 80px, height: 60px, x: 0px, y: 0px, fill: #8fa8bc);
        }
      }
      ${animated ? "animate plane.z from 120px to 180px over 1s ease linear; animate plane.rotationY from 0deg to 12deg over 1s ease linear;" : ""}
    }
    ${animated ? "at 1s { animate camera.focalLength from 180px to 220px over 1s ease linear; animate camera.x from 0px to 8px over 1s ease linear; }" : ""}`,
  );
}

function parallaxProgram(options: { animated?: boolean; explicitFocus?: boolean; focusMode?: boolean } = {}) {
  const animated = options.animated ?? true;
  const explicitFocus = options.explicitFocus ?? true;
  const focusMode = options.focusMode ?? true;
  const focus = focusMode
    ? `, focus: "linear"${explicitFocus ? ", focusDepth: 0px" : ""}, focusRange: 200px, maxBlur: 4px`
    : "";
  return simpleProgram(
    'import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";',
    `ParallaxCamera(focalLength: 300px${focus}) as camera {
      DepthLayer(depth: 100px, edge: "clamp") {
        Rect(width: 320px, height: 180px, x: 160px, y: 90px, fill: #f0e6d2);
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        Circle(x: 160px, y: 90px, radius: 20px, fill: #2457d6);
      }
    }
    ${animated ? `at 1s { animate camera.x from 0px to 20px over 1s ease linear; animate camera.focusDepth from ${explicitFocus ? "0px" : "0px"} to 100px over 1s ease linear; }` : ""}`,
  );
}

function diagramProgram(options: { animated?: boolean; transition?: boolean; explicitProgress?: boolean } = {}) {
  const animated = options.animated ?? true;
  const transition = options.transition ?? true;
  const explicitProgress = options.explicitProgress ?? true;
  return simpleProgram(
    'import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";\nimport { Rect } from "cut:visual";',
    `DiagramLayout(
      state: branch${transition ? ",\n      fromState: source" : ""}${explicitProgress ? ",\n      progress: 0%" : ""},
      direction: "horizontal",
      width: 280px,
      height: 140px
    ) as graph {
      DiagramNode(id: "claim", width: 80px, height: 40px, rank: 0) {
        Rect(width: 80px, height: 40px, fill: #243b53);
      }
      DiagramNode(id: "proof", width: 80px, height: 40px, rank: 1) {
        Rect(width: 80px, height: 40px, fill: #f4d35e);
      }
    }
    ${animated ? "at 1s { animate graph.progress from 0% to 100% over 1s ease linear; }" : ""}`,
    `const source: DiagramState = diagramState(id: "source", nodes: ["claim"], edges: []);
const branch: DiagramState = diagramState(
  id: "branch",
  nodes: ["claim", "proof"],
  edges: [diagramEdge(id: "claim-proof", from: "claim", to: "proof", stroke: #25a18e, width: 3px)]
);`,
  );
}

function wavefrontProgram(options: { animated?: boolean; explicitReveal?: boolean } = {}) {
  const animated = options.animated ?? true;
  const explicitReveal = options.explicitReveal ?? true;
  return simpleProgram(
    'import { Wavefront } from "@cut/geo";',
    `Wavefront(projection: "canvas", x: 80px, y: 60px, radius: 24px, count: 2${explicitReveal ? ", reveal: 0%" : ""}) as pulse;
    ${animated ? "at 1s { animate pulse.reveal from 0% to 100% over 1s ease linear; }" : ""}`,
  );
}

test("the visual baseline registry exhaustively and exactly closes every supported non-audio kernel property", () => {
  const rows: Array<{ operation: string; property: string }> = [];
  const required: string[] = [];
  const expectedDimension = {
    Angle: "angle",
    Length: "length",
    Number: "scalar",
    Ratio: "ratio",
  } as const;

  for (const [operation, schema] of Object.entries(referenceKernelRegistry)) {
    if (schema.support !== "supported" || schema.domain === "audio" || operation === "cut.visual.media_camera2d") continue;
    assert.deepEqual(Object.keys(cutVisualPropertyBaselineRegistry[operation] ?? {}).sort(), [...schema.properties].sort(), operation);
    for (const property of schema.properties) {
      rows.push({ operation, property });
      const policy = cutVisualPropertyBaselineRegistry[operation]?.[property];
      assert.ok(policy, `${operation}.${property}`);
      if (policy.kind === "input-required") {
        required.push(`${operation}.${property}`);
        continue;
      }
      assert.notEqual(policy.value.kind, "null", `${operation}.${property}`);
      assert.equal(policy.value.kind, "quantity", `${operation}.${property}`);
      if (policy.value.kind !== "quantity") continue;
      const valueType = kernelPropertyValueType(schema, property);
      assert.ok(valueType === "Angle" || valueType === "Length" || valueType === "Number" || valueType === "Ratio");
      assert.equal(policy.value.dimension, expectedDimension[valueType], `${operation}.${property}`);

      const synthetic: IRNode = {
        id: `${operation}.${property}`,
        op: operation,
        domain: schema.domain === "any" ? "visual" : schema.domain,
        ownership: "root",
        interval: { start: rational(0), duration: rational(1) },
        inputs: { [property]: { ...policy.value, magnitude: rational(37) } },
        children: [],
        properties: {},
        effects: ["pure"],
        contentHash: "0".repeat(64),
        provenance: { module: "matrix.cut", span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 2, offset: 1 } } },
      };
      const resolved = resolveCutVisualPropertyTrackBaseline(synthetic, property);
      assert.equal(resolved?.kind, "value", `${operation}.${property}`);
      if (resolved?.kind !== "value") continue;
      if (policy.constructorInput === "independent") {
        assert.equal(resolved.origin, "public-default", `${operation}.${property}`);
        assert.deepEqual(resolved.value, policy.value, `${operation}.${property}`);
        assert.equal(kernelPropertyInputIsIntrinsic(schema, property), true, `${operation}.${property}`);
      } else {
        assert.equal(resolved.origin, "constructor-input", `${operation}.${property}`);
        assert.deepEqual(resolved.value, synthetic.inputs[property], `${operation}.${property}`);
        if (kernelPropertyInputIsIntrinsic(schema, property)) {
          assert.equal(`${operation}.${property}`, "cut.geo.globe.rotation", "intrinsic constructor-baseline exceptions must remain explicit");
        }
      }
    }
  }

  assert.deepEqual(
    { operations: Object.keys(cutVisualPropertyBaselineRegistry).length, properties: rows.length },
    { operations: 42, properties: 221 },
    "ImageSequence adds exactly one retained visual operation and the five canonical transform properties",
  );
  assert.deepEqual(required, [
    "cut.diagram.layout.progress",
    "cut.visual.parallax_camera.focusDepth",
    "cut.visual.camera3d.focalLength",
    "cut.visual.plane3d.z",
    "cut.geo.wavefront.reveal",
  ]);
});

const loweringFixtures = [
  { name: "Group", source: groupProgram(), rows: [["cut.visual.group", "x"]] },
  { name: "ColorGrade", source: colorGradeProgram(), rows: [["cut.visual.color_grade", "exposure"]] },
  { name: "LUT", source: lutProgram(), rows: [["cut.visual.lut", "strength"]] },
  { name: "Chart", source: chartProgram(), rows: [["cut.data.chart", "reveal"]] },
  { name: "GeoAnnotation", source: geoAnnotationProgram(), rows: [["cut.geo.annotation", "opacity"]] },
  { name: "MapCamera", source: mapCameraProgram(), rows: [["cut.geo.map_camera", "pitch"]] },
  { name: "Map.rotation", source: mapRotationProgram(), rows: [["cut.geo.map", "rotation"]] },
  { name: "Globe", source: globeProgram(), rows: [["cut.geo.globe", "rotation"]] },
  { name: "Path", source: pathProgram(), rows: [["cut.visual.path", "trimEnd"]] },
  { name: "Path.x", source: pathPositionProgram(), rows: [["cut.visual.path", "x"]] },
  { name: "Chart.x", source: chartPositionProgram(), rows: [["cut.data.chart", "x"]] },
  { name: "Image.x", source: mediaPositionProgram("Image"), rows: [["cut.visual.image", "x"]] },
  { name: "Video.x", source: mediaPositionProgram("Video"), rows: [["cut.visual.video", "x"]] },
  {
    name: "Camera3D/Plane3D",
    source: camera3DProgram(),
    rows: [
      ["cut.visual.camera3d", "focalLength"],
      ["cut.visual.camera3d", "x"],
      ["cut.visual.plane3d", "z"],
      ["cut.visual.plane3d", "rotationY"],
    ],
  },
  {
    name: "ParallaxCamera",
    source: parallaxProgram(),
    rows: [["cut.visual.parallax_camera", "x"], ["cut.visual.parallax_camera", "focusDepth"]],
  },
  { name: "MotionPath", source: motionPathProgram(), rows: [["cut.visual.motion_path", "progress"]] },
  { name: "DiagramLayout", source: diagramProgram(), rows: [["cut.diagram.layout", "progress"]] },
] as const;

test("public CUT lowering gives ordinary property tracks one exact canonical non-null initial value", () => {
  for (const fixture of loweringFixtures) {
    const ir = compile(fixture.source);
    for (const [operation, property] of fixture.rows) {
      const { owner, signal } = propertyTrack(ir, operation, property);
      const baseline = resolveCutVisualPropertyTrackBaseline(owner, property);
      assert.equal(baseline?.kind, "value", `${fixture.name} ${operation}.${property}`);
      assert.notEqual(signal.initial.kind, "null", `${fixture.name} ${operation}.${property}`);
      if (baseline?.kind === "value") assert.deepEqual(signal.initial, baseline.value, `${fixture.name} ${operation}.${property}`);
      assert.doesNotThrow(() => validateCutVisualPropertyTrackBaselines(ir, owner), `${fixture.name} ${operation}.${property}`);
    }
  }
});

test("Image and Video expose x/y through public source and preserve the authored constructor as the delayed-track baseline", () => {
  for (const [kind, operation] of [["Image", "cut.visual.image"], ["Video", "cut.visual.video"]] as const) {
    const ir = compile(mediaPositionProgram(kind)), owner = node(ir, operation);
    const schema = referenceKernelRegistry[operation];
    assert.ok(schema && schema.support === "supported", operation);
    assert.equal(exactQuantityNumber(owner.inputs.x), 7, `${kind}.x public constructor input`);
    assert.equal(exactQuantityNumber(owner.inputs.y), -3, `${kind}.y public constructor input`);
    assert.equal(kernelPropertyInputIsIntrinsic(schema, "x"), false, `${kind}.x is compositor-owned`);
    assert.equal(kernelPropertyInputIsIntrinsic(schema, "y"), false, `${kind}.y is compositor-owned`);
    const { signal } = propertyTrack(ir, operation, "x");
    assert.equal(exactQuantityNumber(signal.initial), 7, `${kind}.x delayed-track initial`);
    assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(ir)), `${kind} canonical loaded IR`);
  }
});

function conflictingBaseline(value: IRValue): IRValue {
  assert.equal(value.kind, "quantity");
  if (value.kind !== "quantity") return { kind: "null" };
  return {
    ...value,
    magnitude: value.magnitude.numerator === "0" ? rational(1) : rational(0),
  };
}

test("strict loaded IR and the runtime guard reject null or conflicting ordinary visual baselines", () => {
  for (const fixture of loweringFixtures) {
    const canonical = compile(fixture.source);
    for (const [operation, property] of fixture.rows) {
      for (const corruption of ["null", "conflict"] as const) {
        const ir = structuredClone(canonical), { owner, signal } = propertyTrack(ir, operation, property);
        signal.initial = corruption === "null" ? { kind: "null" } : conflictingBaseline(signal.initial);
        signal.contentHash = cutSignalContentHash(signal);
        finalizeGraphHashes(ir);
        assert.throws(
          () => validateCutVisualPropertyTrackBaselines(ir, owner),
          (error: unknown) => error instanceof CutVisualPropertyBaselineError
            && error.code === "CUT_VISUAL_BASELINE"
            && error.issue.kind === corruption,
          `${fixture.name} ${operation}.${property} ${corruption} runtime guard`,
        );
        assert.throws(
          () => loadCutAvIr(JSON.stringify(ir)),
          (error: unknown) => error instanceof CutAvIrValidationError
            && error.code === "CUT_VISUAL_BASELINE"
            && error.path.endsWith(".initial")
            && error.message.includes(`${operation}.${property}`),
          `${fixture.name} ${operation}.${property} ${corruption} loader`,
        );
      }
    }
  }
});

test("explicit-input-only baselines fail at public source, while explicit tracks and legitimate static omission remain valid", () => {
  for (const [name, source] of [
    ["DiagramLayout.progress", diagramProgram({ transition: false, explicitProgress: false })],
    ["ParallaxCamera.focusDepth", parallaxProgram({ explicitFocus: false })],
    ["Wavefront.reveal", wavefrontProgram({ explicitReveal: false })],
  ] as const) {
    const diagnostic = compileDiagnostic(source, "CUT_VISUAL_BASELINE");
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0, name);
    assert.match(diagnostic.message, /explicit same-named constructor baseline/u, name);
  }

  for (const [name, source, operation, property] of [
    ["DiagramLayout.progress", diagramProgram(), "cut.diagram.layout", "progress"],
    ["ParallaxCamera.focusDepth", parallaxProgram(), "cut.visual.parallax_camera", "focusDepth"],
    ["Camera3D.focalLength", camera3DProgram(), "cut.visual.camera3d", "focalLength"],
    ["Plane3D.z", camera3DProgram(), "cut.visual.plane3d", "z"],
    ["Wavefront.reveal", wavefrontProgram(), "cut.geo.wavefront", "reveal"],
  ] as const) {
    const ir = compile(source), { owner, signal } = propertyTrack(ir, operation, property);
    assert.notEqual(signal.initial.kind, "null", name);
    assert.deepEqual(signal.initial, owner.inputs[property], name);
    assert.doesNotThrow(() => validateCutVisualPropertyTrackBaselines(ir, owner), name);
    assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(ir)), name);
  }

  assert.doesNotThrow(() => compile(diagramProgram({ animated: false, transition: false, explicitProgress: false })));
  assert.doesNotThrow(() => compile(parallaxProgram({ animated: false, explicitFocus: false, focusMode: false })));
  assert.doesNotThrow(() => compile(wavefrontProgram({ animated: false, explicitReveal: false })));

  const cameraMissing = checkCutModule(moduleFor(camera3DProgram({ animated: false, focalLength: false }))).diagnostics;
  assert.ok(cameraMissing.some((diagnostic) => diagnostic.severity === "error" && /focalLength/u.test(diagnostic.message)), JSON.stringify(cameraMissing));
  const planeMissing = checkCutModule(moduleFor(camera3DProgram({ animated: false, planeZ: false }))).diagnostics;
  assert.ok(planeMissing.some((diagnostic) => diagnostic.severity === "error" && /\bz\b/u.test(diagnostic.message)), JSON.stringify(planeMissing));
});

function transformProgram(kind: "Rect" | "Text" | "Group" | "Image" | "Video", animated: boolean) {
  const independentControl = animated ? "at 1s { animate target.x from 0px to 12px over 1s ease linear; }" : "";
  if (kind === "Rect") return simpleProgram(
    'import { Rect } from "cut:visual";',
    `Rect(width: 24px, height: 16px, x: 17px, y: 11px, fill: #ffffff) as target; ${independentControl}`,
  );
  if (kind === "Text") return simpleProgram(
    'import { Text } from "cut:visual";',
    `Text(content: "baseline", font: face, size: 18px, x: 17px, y: 11px) as target; ${independentControl}`,
    'asset face: FontAsset = font("assets/face.ttf");',
  );
  if (kind === "Image") return simpleProgram(
    'import { Image } from "cut:visual";',
    `Image(source: still, fit: "contain", x: 7px, y: -3px) as target;
    ${animated ? "at 1s { animate target.x from 7px to 19px over 1s ease linear; }" : ""}`,
    'asset still: ImageAsset = image("assets/still.png");',
  );
  if (kind === "Video") return simpleProgram(
    'import { Video } from "cut:visual";',
    `Video(source: footage, fit: "contain", endBehavior: "hold", x: 7px, y: -3px) as target;
    ${animated ? "at 1s { animate target.x from 7px to 19px over 1s ease linear; }" : ""}`,
    'asset footage: VideoAsset = video("assets/footage.mkv");',
  );
  return simpleProgram(
    'import { Group, Rect } from "cut:visual";',
    `Group(x: 7px) as target { Rect(width: 24px, height: 16px, fill: #ffffff); }
    ${animated ? "at 1s { animate target.x from 7px to 17px over 1s ease linear; }" : ""}`,
  );
}

test("runtime ownership agrees with canonical baselines before delayed events and changes after them", () => {
  for (const kind of ["Rect", "Text", "Group", "Image", "Video"] as const) {
    const plain = compile(transformProgram(kind, false)), animated = compile(transformProgram(kind, true));
    const operation = { Rect: "cut.visual.rect", Text: "cut.visual.text", Group: "cut.visual.group", Image: "cut.visual.image", Video: "cut.visual.video" }[kind];
    const plainNode = node(plain, operation), animatedNode = node(animated, operation);
    const staticPosition = kind === "Group" || kind === "Image" || kind === "Video";
    const beforePlain = referenceVisualTransformAt(plain, plain.compositions[0]!, plainNode, rational(1, 2), { staticPosition, staticRotation: true });
    const beforeAnimated = referenceVisualTransformAt(animated, animated.compositions[0]!, animatedNode, rational(1, 2), { staticPosition, staticRotation: true });
    const afterAnimated = referenceVisualTransformAt(animated, animated.compositions[0]!, animatedNode, rational(3, 2), { staticPosition, staticRotation: true });
    assert.deepEqual(beforeAnimated, beforePlain, `${kind} pre-event runtime baseline`);
    assert.notEqual(afterAnimated.x, beforeAnimated.x, `${kind} post-event execution`);
    if (kind === "Rect" || kind === "Text") assert.equal(beforeAnimated.x, 0, `${kind} intrinsic x is geometry, not a second compositor translation`);
    if (kind === "Group") assert.equal(beforeAnimated.x, 7, "Group constructor x owns the container baseline");
    if (kind === "Image" || kind === "Video") assert.equal(beforeAnimated.x, 7, `${kind} constructor x owns the media compositor baseline`);
  }

  for (const [name, source, operation, options] of [
    ["Path.x", pathPositionProgram, "cut.visual.path", { staticPosition: true, staticRotation: true }],
    ["Chart.x", chartPositionProgram, "cut.data.chart", { staticPosition: false, staticRotation: true }],
    ["Map.rotation", mapRotationProgram, "cut.geo.map", { staticPosition: true, staticRotation: true }],
  ] as const) {
    const plain = compile(source(false)), animated = compile(source(true));
    const plainNode = node(plain, operation), animatedNode = node(animated, operation);
    const beforePlain = referenceVisualTransformAt(plain, plain.compositions[0]!, plainNode, rational(1, 2), options);
    const beforeAnimated = referenceVisualTransformAt(animated, animated.compositions[0]!, animatedNode, rational(1, 2), options);
    const afterAnimated = referenceVisualTransformAt(animated, animated.compositions[0]!, animatedNode, rational(3, 2), options);
    assert.deepEqual(beforeAnimated, beforePlain, `${name} pre-event runtime baseline`);
    if (name === "Map.rotation") assert.notEqual(afterAnimated.rotation, beforeAnimated.rotation, `${name} post-event execution`);
    else assert.notEqual(afterAnimated.x, beforeAnimated.x, `${name} post-event execution`);
    if (name === "Chart.x") assert.equal(beforeAnimated.x, 0, "Chart constructor x is intrinsic geometry, not a second compositor translation");
    if (name === "Path.x") assert.equal(beforeAnimated.x, 7, "Path constructor x owns the compositor baseline");
    if (name === "Map.rotation") assert.equal(beforeAnimated.rotation, 12, "Map constructor rotation owns the compositor baseline");
  }

  const specialized = [
    {
      name: "MapCamera.pitch",
      plain: compile(mapCameraProgram(false)),
      animated: compile(mapCameraProgram(true)),
      operation: "cut.geo.map_camera",
      execute: (ir: CutAVIR, owner: IRNode, time: ReturnType<typeof rational>) => referenceMapCameraStateAt(ir, owner, time).pitch,
    },
    {
      name: "Chart.reveal",
      plain: compile(chartProgram(false)),
      animated: compile(chartProgram(true)),
      operation: "cut.data.chart",
      execute: (ir: CutAVIR, owner: IRNode, time: ReturnType<typeof rational>) => referenceChartRevealAt(ir, owner, time),
    },
    {
      name: "ColorGrade.exposure",
      plain: compile(colorGradeProgram(false)),
      animated: compile(colorGradeProgram(true)),
      operation: "cut.visual.color_grade",
      execute: (ir: CutAVIR, owner: IRNode, time: ReturnType<typeof rational>) => referenceColorGradeConfigAt(ir, owner, time).exposureStops,
    },
  ] as const;
  for (const fixture of specialized) {
    const plainNode = node(fixture.plain, fixture.operation), animatedNode = node(fixture.animated, fixture.operation);
    const beforePlain = fixture.execute(fixture.plain, plainNode, rational(1, 2));
    const beforeAnimated = fixture.execute(fixture.animated, animatedNode, rational(1, 2));
    const afterAnimated = fixture.execute(fixture.animated, animatedNode, rational(3, 2));
    assert.equal(beforeAnimated, beforePlain, `${fixture.name} pre-event runtime baseline`);
    assert.notEqual(afterAnimated, beforeAnimated, `${fixture.name} post-event execution`);
  }

  const plainPath = compile(pathProgram(false)), animatedPath = compile(pathProgram(true));
  const plainPathNode = node(plainPath, "cut.visual.path"), animatedPathNode = node(animatedPath, "cut.visual.path");
  const plainPlan = prepareReferenceVectorPathNode(plainPath, plainPathNode), animatedPlan = prepareReferenceVectorPathNode(animatedPath, animatedPathNode);
  assert.ok(plainPlan && animatedPlan);
  const beforePlain = referenceVectorPathFrameAt(plainPath, plainPathNode, plainPlan, rational(1, 2)).trimEnd;
  const beforeAnimated = referenceVectorPathFrameAt(animatedPath, animatedPathNode, animatedPlan, rational(1, 2)).trimEnd;
  const afterAnimated = referenceVectorPathFrameAt(animatedPath, animatedPathNode, animatedPlan, rational(3, 2)).trimEnd;
  assert.equal(beforeAnimated, beforePlain, "Path.trimEnd pre-event runtime baseline");
  assert.notEqual(afterAnimated, beforeAnimated, "Path.trimEnd post-event execution");
});

function exactQuantityNumber(value: IRValue | undefined) {
  assert.equal(value?.kind, "quantity");
  if (value?.kind !== "quantity") return Number.NaN;
  return Number(value.magnitude.numerator) / Number(value.magnitude.denominator);
}

function intrinsicGlobeRotation(ir: CutAVIR, owner: IRNode, time: ReturnType<typeof rational>) {
  return exactQuantityNumber(propertyAt(ir, owner, "rotation", time) ?? owner.inputs.rotation);
}

async function assetFreeFrame(source: string, frame: number) {
  const ir = compile(source);
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-visual-baseline-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    return await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]!]!, frame, false);
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
}

function rgbaDigest(frame: { data: Uint8Array }) {
  return createHash("sha256").update(frame.data).digest("hex");
}

async function mediaFixtureRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-media-position-baseline-")), assets = resolve(root, "assets");
  await mkdir(assets);
  const width = 16, height = 8, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    raw[offset] = x < width / 2 ? 236 : 18;
    raw[offset + 1] = y < height / 2 ? 42 : 196;
    raw[offset + 2] = x < width / 2 ? 28 : 230;
    raw[offset + 3] = 255;
  }
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(resolve(assets, "source.png"));
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "4", "-i", resolve(assets, "source.png"),
    "-frames:v", "12", "-c:v", "ffv1", "-pix_fmt", "bgra", resolve(assets, "source.mkv"),
  ]);
  return root;
}

async function lockedMediaFrames(root: string, source: string, frames: readonly number[], cacheName: string) {
  const ir = compile(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir, "out"), scene = ir.scenes[composition.sceneIds[0]!]!;
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", cacheName));
  try {
    await renderer.prepare();
    const output = [];
    for (const frame of frames) output.push(await renderer.sceneFrame(scene, frame, false));
    return output;
  } finally {
    await renderer.closeAndWait();
  }
}

test("Globe rotation is single-owned by projection, preserves its constructor before a delayed event, and changes pixels after it", async () => {
  const plain = compile(globeProgram(false)), animated = compile(globeProgram(true));
  const plainNode = node(plain, "cut.geo.globe"), animatedNode = node(animated, "cut.geo.globe");
  assert.equal(intrinsicGlobeRotation(plain, plainNode, rational(1, 2)), 30);
  assert.equal(intrinsicGlobeRotation(animated, animatedNode, rational(1, 2)), 30);
  assert.equal(intrinsicGlobeRotation(animated, animatedNode, rational(3, 2)), 60);

  const beforeOuter = referenceVisualTransformAt(animated, animated.compositions[0]!, animatedNode, rational(1, 2), { staticPosition: false, staticRotation: false });
  const afterOuter = referenceVisualTransformAt(animated, animated.compositions[0]!, animatedNode, rational(3, 2), { staticPosition: false, staticRotation: false });
  assert.equal(beforeOuter.rotation, 0, "projection rotation must not also become an outer canvas transform");
  assert.equal(afterOuter.rotation, 0, "animated projection rotation must remain single-owned");

  const beforePlain = await assetFreeFrame(globeProgram(false), 2);
  const beforeAnimated = await assetFreeFrame(globeProgram(true), 2);
  const afterAnimated = await assetFreeFrame(globeProgram(true), 6);
  assert.equal(rgbaDigest(beforeAnimated), rgbaDigest(beforePlain), "delayed automation must preserve static projection pixels before its first event");
  assert.notEqual(rgbaDigest(afterAnimated), rgbaDigest(beforeAnimated), "post-event projection rotation must change rendered pixels");
});

test("Path x/y reach the actual compositor exactly once and delayed x preserves pre-event pixels", async () => {
  const plain = await assetFreeFrame(pathPositionProgram(false, true), 2);
  const beforeAnimated = await assetFreeFrame(pathPositionProgram(true, true), 2);
  const afterAnimated = await assetFreeFrame(pathPositionProgram(true, true), 6);
  const origin = await assetFreeFrame(pathPositionProgram(false, false), 2);
  assert.equal(rgbaDigest(beforeAnimated), rgbaDigest(plain), "Path delayed automation must preserve its constructor x/y before 1s");
  assert.notEqual(rgbaDigest(afterAnimated), rgbaDigest(beforeAnimated), "Path delayed x must change compositor pixels after 1s");
  assert.notEqual(rgbaDigest(plain), rgbaDigest(origin), "Path static x/y must reach nodeFrame placement rather than being ignored");
});

test("public Image and Video x/y execute exactly once and delayed x preserves constructor pixels before its first event", { timeout: 90_000 }, async () => {
  const root = await mediaFixtureRoot();
  try {
    for (const kind of ["Image", "Video"] as const) {
      const plain = await lockedMediaFrames(root, mediaPositionProgram(kind, false, true), [2], `${kind.toLowerCase()}-plain`);
      const animated = await lockedMediaFrames(root, mediaPositionProgram(kind, true, true), [2, 6], `${kind.toLowerCase()}-animated`);
      const origin = await lockedMediaFrames(root, mediaPositionProgram(kind, false, false), [2], `${kind.toLowerCase()}-origin`);
      assert.equal(rgbaDigest(animated[0]!), rgbaDigest(plain[0]!), `${kind}.x delayed automation preserves authored x/y before 1s`);
      assert.notEqual(rgbaDigest(animated[1]!), rgbaDigest(animated[0]!), `${kind}.x changes exact pixels after the delayed event`);
      assert.notEqual(rgbaDigest(plain[0]!), rgbaDigest(origin[0]!), `${kind} static x/y execute rather than being ignored`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
