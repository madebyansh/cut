import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";

const source = `cut 0.4;
project "GeoAnnotation hostile loader proof";
import { ParallaxCamera, DepthLayer, Rect } from "cut:visual";
import { GeoAnnotation } from "@cut/geo";
import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) {
      DepthLayer(depth: 0px, edge: "transparent") {
        Rect(width: 100px, height: 80px, x: 50px, y: 40px, fill: #111111);
        GeoAnnotation(
          anchor: { latitude: 29.97, longitude: 32.55 },
          width: 40px,
          height: 20px,
          placements: ["right", "above"],
          offset: 4px,
          safeArea: 4px,
          priority: 2,
          leader: "straight",
          leaderColor: #ffffffff,
          leaderWidth: 1px,
          opacity: 50%
        ) as note {
          Rect(width: 40px, height: 20px, x: 50px, y: 40px, fill: #ffffff);
        }
        animate note.opacity from 25% to 75% over 1s ease linear;
      }
      DepthLayer(depth: 100px, edge: "transparent") {
        Rect(width: 100px, height: 80px, x: 50px, y: 40px, fill: #222222);
      }
    }
  }
}
export out = render(main);`;

type Fixture = {
  ir: CutAVIR;
  annotation: IRNode;
  child: IRNode;
  layer: IRNode;
  otherLayer: IRNode;
  camera: IRNode;
};

function fixture(): Fixture {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  const annotation = Object.values(ir.nodes).find((node) => node.op === "cut.geo.annotation");
  assert.ok(annotation);
  const child = ir.nodes[annotation.children[0]];
  assert.ok(child);
  const layer = Object.values(ir.nodes).find((node) => node.op === "cut.visual.depth_layer" && node.children.includes(annotation.id));
  assert.ok(layer);
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.parallax_camera" && node.children.includes(layer.id));
  assert.ok(camera);
  const otherLayer = camera.children.map((id) => ir.nodes[id]).find((node) => node?.op === "cut.visual.depth_layer" && node.id !== layer.id);
  assert.ok(otherLayer);
  return { ir, annotation, child, layer, otherLayer, camera };
}

function quantity(dimension: string, numerator: number, denominator = 1): IRValue {
  const unit = dimension === "length" ? "px" : dimension === "angle" ? "deg" : dimension;
  return { kind: "quantity", dimension, magnitude: { numerator: String(numerator), denominator: String(denominator) }, unit };
}

function expectMutation(
  name: string,
  mutate: (value: Fixture) => void,
  code: CutAvIrValidationError["code"],
  pathSuffix: string,
) {
  const value = fixture();
  mutate(value);
  finalizeGraphHashes(value.ir);
  assert.throws(() => loadCutAvIr(JSON.stringify(value.ir)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, `${name}: ${String(error)}`);
    assert.equal(error.code, code, name);
    assert.ok(error.path.endsWith(pathSuffix), `${name}: received ${error.path}`);
    return true;
  });
}

test("loaded IR accepts the ordinary compiler's closed GeoAnnotation graph", () => {
  const { ir, annotation } = fixture();
  assert.equal(loadCutAvIr(JSON.stringify(ir)).nodes[annotation.id].op, "cut.geo.annotation");
});

test("loaded IR admits the explicit GeoAnnotation no-leader policy only without inert leader styling", () => {
  const { ir, annotation } = fixture();
  annotation.inputs.leader = { kind: "string", value: "none" };
  delete annotation.inputs.leaderColor;
  delete annotation.inputs.leaderWidth;
  finalizeGraphHashes(ir);
  const loaded = loadCutAvIr(JSON.stringify(ir));
  assert.deepEqual(loaded.nodes[annotation.id].inputs.leader, { kind: "string", value: "none" });
  assert.equal(loaded.nodes[annotation.id].inputs.leaderColor, undefined);
  assert.equal(loaded.nodes[annotation.id].inputs.leaderWidth, undefined);
});

test("loaded IR closes every required GeoAnnotation value shape and range", () => {
  const cases: Array<{
    name: string;
    mutate: (value: Fixture) => void;
    code: CutAvIrValidationError["code"];
    suffix: string;
  }> = [
    { name: "missing anchor", mutate: ({ annotation }) => { delete annotation.inputs.anchor; }, code: "CUT_IR_MISSING_FIELD", suffix: ".inputs.anchor" },
    { name: "non-object anchor", mutate: ({ annotation }) => { annotation.inputs.anchor = { kind: "string", value: "29,32" }; }, code: "CUT_IR_TYPE", suffix: ".inputs.anchor" },
    { name: "anchor label", mutate: ({ annotation }) => { const anchor = annotation.inputs.anchor; assert.equal(anchor.kind, "object"); anchor.entries.label = { kind: "string", value: "ignored" }; }, code: "CUT_IR_TYPE", suffix: ".inputs.anchor" },
    { name: "latitude range", mutate: ({ annotation }) => { const anchor = annotation.inputs.anchor; assert.equal(anchor.kind, "object"); anchor.entries.latitude = quantity("scalar", 91); }, code: "CUT_IR_TYPE", suffix: ".inputs.anchor.entries.latitude" },
    { name: "fractional width", mutate: ({ annotation }) => { annotation.inputs.width = quantity("length", 3, 2); }, code: "CUT_IR_TYPE", suffix: ".inputs.width" },
    { name: "noncanonical length unit", mutate: ({ annotation }) => { annotation.inputs.width = { kind: "quantity", dimension: "length", magnitude: { numerator: "40", denominator: "1" }, unit: "cm" }; }, code: "CUT_IR_TYPE", suffix: ".inputs.width.unit" },
    { name: "composition-width overflow", mutate: ({ annotation }) => { annotation.inputs.width = quantity("length", 101); }, code: "CUT_IR_TYPE", suffix: ".inputs.width" },
    { name: "empty placements", mutate: ({ annotation }) => { annotation.inputs.placements = { kind: "array", items: [] }; }, code: "CUT_IR_LIMIT", suffix: ".inputs.placements" },
    { name: "duplicate placement", mutate: ({ annotation }) => { annotation.inputs.placements = { kind: "array", items: [{ kind: "string", value: "right" }, { kind: "string", value: "right" }] }; }, code: "CUT_IR_IDENTITY", suffix: ".inputs.placements.items[1].value" },
    { name: "unknown placement", mutate: ({ annotation }) => { annotation.inputs.placements = { kind: "array", items: [{ kind: "string", value: "diagonal" }] }; }, code: "CUT_IR_ENUM", suffix: ".inputs.placements.items[0].value" },
    { name: "non-string placement", mutate: ({ annotation }) => { annotation.inputs.placements = { kind: "array", items: [{ kind: "boolean", value: true }] }; }, code: "CUT_IR_TYPE", suffix: ".inputs.placements.items[0]" },
    { name: "zero offset", mutate: ({ annotation }) => { annotation.inputs.offset = quantity("length", 0); }, code: "CUT_IR_TYPE", suffix: ".inputs.offset" },
    { name: "zero safe area", mutate: ({ annotation }) => { annotation.inputs.safeArea = quantity("length", 0); }, code: "CUT_IR_TYPE", suffix: ".inputs.safeArea" },
    { name: "empty safe rectangle", mutate: ({ annotation }) => { annotation.inputs.safeArea = quantity("length", 40); }, code: "CUT_IR_LIMIT", suffix: ".inputs.safeArea" },
    { name: "viewport cannot fit safe rectangle", mutate: ({ annotation }) => { annotation.inputs.width = quantity("length", 94); }, code: "CUT_IR_LIMIT", suffix: ".inputs" },
    { name: "zero priority", mutate: ({ annotation }) => { annotation.inputs.priority = quantity("scalar", 0); }, code: "CUT_IR_IDENTITY", suffix: ".inputs.priority" },
    { name: "fractional priority", mutate: ({ annotation }) => { annotation.inputs.priority = quantity("scalar", 3, 2); }, code: "CUT_IR_TYPE", suffix: ".inputs.priority" },
    { name: "priority overflow", mutate: ({ annotation }) => { annotation.inputs.priority = quantity("scalar", 1_000_001); }, code: "CUT_IR_TYPE", suffix: ".inputs.priority" },
    { name: "unknown leader", mutate: ({ annotation }) => { annotation.inputs.leader = { kind: "string", value: "curved" }; }, code: "CUT_IR_ENUM", suffix: ".inputs.leader.value" },
    { name: "none retains inert style", mutate: ({ annotation }) => { annotation.inputs.leader = { kind: "string", value: "none" }; }, code: "CUT_IR_IDENTITY", suffix: ".inputs" },
    { name: "visible leader missing color", mutate: ({ annotation }) => { delete annotation.inputs.leaderColor; }, code: "CUT_IR_MISSING_FIELD", suffix: ".inputs" },
    { name: "transparent leader", mutate: ({ annotation }) => { annotation.inputs.leaderColor = { kind: "color", value: "#ffffff00" }; }, code: "CUT_IR_IDENTITY", suffix: ".inputs.leaderColor" },
    { name: "zero leader width", mutate: ({ annotation }) => { annotation.inputs.leaderWidth = quantity("length", 0); }, code: "CUT_IR_TYPE", suffix: ".inputs.leaderWidth" },
    { name: "leader width exceeds canvas", mutate: ({ annotation }) => { annotation.inputs.leaderWidth = quantity("length", 81); }, code: "CUT_IR_TYPE", suffix: ".inputs.leaderWidth" },
    { name: "opacity range", mutate: ({ annotation }) => { annotation.inputs.opacity = quantity("ratio", 2); }, code: "CUT_IR_TYPE", suffix: ".inputs.opacity" },
    { name: "static property type", mutate: ({ annotation }) => { annotation.properties.opacity = { kind: "string", value: "opaque" }; }, code: "CUT_IR_TYPE", suffix: ".properties.opacity" },
    {
      name: "permanently hidden static opacity",
      mutate: ({ ir, annotation }) => {
        const property = annotation.properties.opacity;
        assert.ok(property && "signal" in property);
        delete ir.signals[property.signal];
        delete annotation.properties.opacity;
        annotation.inputs.opacity = quantity("ratio", 0);
      },
      code: "CUT_IR_IDENTITY",
      suffix: ".inputs.opacity",
    },
    {
      name: "neutral explicit static opacity",
      mutate: ({ ir, annotation }) => {
        const property = annotation.properties.opacity;
        assert.ok(property && "signal" in property);
        delete ir.signals[property.signal];
        delete annotation.properties.opacity;
        annotation.inputs.opacity = quantity("ratio", 1);
      },
      code: "CUT_IR_IDENTITY",
      suffix: ".inputs.opacity",
    },
  ];
  for (const item of cases) expectMutation(item.name, item.mutate, item.code, item.suffix);
});

test("loaded IR permits 0% and 100% opacity baselines when an executing property signal exists", () => {
  for (const baseline of [0, 1]) {
    const value = fixture();
    const property = value.annotation.properties.opacity;
    assert.ok(property && "signal" in property);
    const signal = value.ir.signals[property.signal];
    assert.equal(signal.valueType, "Ratio");
    assert.equal(signal.kind, "track");
    value.annotation.inputs.opacity = quantity("ratio", baseline);
    if (signal.kind === "track") {
      signal.initial = quantity("ratio", baseline);
      signal.contentHash = cutSignalContentHash(signal);
    }
    finalizeGraphHashes(value.ir);
    assert.equal(loadCutAvIr(JSON.stringify(value.ir)).nodes[value.annotation.id].op, "cut.geo.annotation");
  }
});

test("loaded IR closes GeoAnnotation kernel fields, domain, child, interval, and direct parentage", () => {
  const cases: Array<{
    name: string;
    mutate: (value: Fixture) => void;
    code: CutAvIrValidationError["code"];
    suffix: string;
  }> = [
    { name: "unknown input", mutate: ({ annotation }) => { annotation.inputs.projection = { kind: "string", value: "map" }; }, code: "CUT_IR_UNKNOWN_FIELD", suffix: ".inputs.projection" },
    { name: "unknown property", mutate: ({ annotation }) => { annotation.properties.x = quantity("length", 1); }, code: "CUT_IR_UNKNOWN_FIELD", suffix: ".properties.x" },
    { name: "wrong domain", mutate: ({ annotation }) => { annotation.domain = "audio"; }, code: "CUT_IR_TYPE", suffix: ".domain" },
    { name: "no child", mutate: ({ annotation }) => { annotation.children = []; }, code: "CUT_IR_TYPE", suffix: ".children" },
    { name: "two children", mutate: ({ annotation, layer }) => { annotation.children.push(layer.children.find((id) => id !== annotation.id)!); }, code: "CUT_IR_TYPE", suffix: ".children" },
    { name: "child interval differs", mutate: ({ child }) => { child.interval.duration = { numerator: "1", denominator: "2" }; }, code: "CUT_IR_TIMING", suffix: ".children[0]" },
    {
      name: "annotation is not a direct DepthLayer child",
      mutate: ({ annotation, layer, camera }) => {
        layer.children = layer.children.filter((id) => id !== annotation.id);
        camera.children.push(annotation.id);
      },
      code: "CUT_IR_IDENTITY",
      suffix: ".ownership",
    },
    {
      name: "annotation has multiple DepthLayer parents",
      mutate: ({ annotation, otherLayer }) => { otherLayer.children.push(annotation.id); },
      code: "CUT_IR_IDENTITY",
      suffix: ".ownership",
    },
  ];
  for (const item of cases) expectMutation(item.name, item.mutate, item.code, item.suffix);
});
