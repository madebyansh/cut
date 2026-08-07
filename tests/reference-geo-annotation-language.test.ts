import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";

function source(annotation = `GeoAnnotation(
          anchor: { latitude: 29.97, longitude: 32.55 },
          width: 40px,
          height: 20px,
          placements: ["right"],
          offset: 4px,
          safeArea: 4px,
          leader: "straight",
          leaderColor: #ffffff,
          leaderWidth: 1px,
          opacity: 0%
        ) as note {
          Rect(width: 40px, height: 20px, x: 50px, y: 40px, fill: #ffffff);
        }`) {
  return `cut 0.4;
project "GeoAnnotation language proof";
import { ParallaxCamera, DepthLayer, Rect } from "cut:visual";
import { GeoAnnotation } from "@cut/geo";
import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) as camera {
      DepthLayer(depth: 100px, edge: "transparent") {
        Rect(width: 100px, height: 80px, x: 50px, y: 40px, fill: #111111);
        ${annotation}
        animate note.opacity from 0% to 100% over 1s ease linear;
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        Rect(width: 10px, height: 10px, x: 10px, y: 10px, fill: #333333);
      }
    }
    animate camera.x from 0px to 10px over 1s ease linear;
  }
}
export out = render(main, width: 100px, height: 80px, codec: "h264");`;
}

function check(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return { parsed, checked: checkCutModule(parsed.module) };
}

test("public GeoAnnotation source lowers through ordinary typed IR with one public child and Ratio automation", () => {
  const { parsed, checked } = check(source());
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module!).ir;
  const annotation = Object.values(ir.nodes).find((node) => node.op === "cut.geo.annotation");
  assert.ok(annotation);
  assert.equal(annotation.children.length, 1);
  assert.equal(ir.nodes[annotation.children[0]].op, "cut.visual.rect");
  assert.equal(Object.hasOwn(annotation.inputs, "projection"), false);
  assert.deepEqual(Object.keys(annotation.properties), ["opacity"]);
  assert.ok("signal" in annotation.properties.opacity);
  if ("signal" in annotation.properties.opacity) assert.equal(ir.signals[annotation.properties.opacity.signal].valueType, "Ratio");
});

test("public GeoAnnotation checker closes direct parent, anchor fields, placement literals, and one-child shape", () => {
  const cases: Array<{ program: string; code: string }> = [
    {
      program: source().replace("anchor: { latitude: 29.97, longitude: 32.55 }", "anchor: { latitude: 29.97, longitude: 32.55, label: \"ignored\" }"),
      code: "CUT_GEO_ANNOTATION_TYPE",
    },
    {
      program: source().replace('placements: ["right"]', 'placements: ["right", "right"]'),
      code: "CUT_GEO_ANNOTATION_NOOP",
    },
    {
      program: source().replace('placements: ["right"]', 'placements: ["diagonal"]'),
      code: "CUT_GEO_ANNOTATION_TYPE",
    },
    {
      program: source().replace("          Rect(width: 40px, height: 20px, x: 50px, y: 40px, fill: #ffffff);", ""),
      code: "CUT_GEO_ANNOTATION_GRAPH",
    },
    {
      program: source().replace("        GeoAnnotation(", "      }\n      GeoAnnotation(").replace("      }\n      DepthLayer(depth: 0px", "      DepthLayer(depth: 0px"),
      code: "CUT_GEO_ANNOTATION_GRAPH",
    },
  ];
  for (const item of cases) {
    const { checked } = check(item.program);
    assert.ok(checked.diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.code === item.code), JSON.stringify(checked.diagnostics));
  }
});

test("public GeoAnnotation has no one-value projection selector and closes leader style combinations", () => {
  const projection = check(source().replace("width: 40px,", 'projection: "map",\n          width: 40px,'));
  assert.ok(projection.checked.diagnostics.some((diagnostic) => diagnostic.severity === "error" && (diagnostic.code === "CUT2059" || diagnostic.code === "CUT2027")));
  const leader = check(source().replace('leader: "straight",\n          leaderColor: #ffffff,\n          leaderWidth: 1px,', 'leader: "none",\n          leaderColor: #ffffff,\n          leaderWidth: 1px,'));
  assert.ok(leader.checked.diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.code === "CUT_GEO_ANNOTATION_NOOP"));
});

test("GeoAnnotation keeps a required explicit leader policy and admits the no-leader spelling", () => {
  const symbol = packageSymbol("@cut/geo", "GeoAnnotation");
  const leaderParameter = symbol?.parameters?.find((parameter) => parameter.name === "leader");
  assert.deepEqual(leaderParameter, {
    name: "leader",
    type: "String",
    values: ["none", "straight", "elbow"],
  });
  const kernel = referenceKernelSchema("cut.geo.annotation");
  assert.equal(kernel?.support, "supported");
  if (kernel?.support === "supported") {
    assert.deepEqual(kernel.stringInputs.leader, ["none", "straight", "elbow"]);
  }

  const explicitNone = source().replace(
    'leader: "straight",\n          leaderColor: #ffffff,\n          leaderWidth: 1px,',
    'leader: "none",',
  );
  const accepted = check(explicitNone);
  assert.deepEqual(accepted.checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  const annotation = Object.values(compileCutModule(accepted.parsed.module!).ir.nodes)
    .find((node) => node.op === "cut.geo.annotation");
  assert.ok(annotation);
  assert.deepEqual(annotation.inputs.leader, { kind: "string", value: "none" });
  assert.equal(annotation.inputs.leaderColor, undefined);
  assert.equal(annotation.inputs.leaderWidth, undefined);

  const omitted = check(explicitNone.replace('          leader: "none",\n', ""));
  assert.ok(omitted.checked.diagnostics.some((diagnostic) => diagnostic.severity === "error"
    && diagnostic.code === "CUT2028"
    && /leader/u.test(diagnostic.message)));
});
