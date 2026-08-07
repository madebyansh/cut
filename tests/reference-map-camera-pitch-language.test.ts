import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { parseCutLanguage } from "../lib/language/parser";
import { packageSymbol } from "../lib/language/packages";

const source = (camera: string, automation = "") => `cut 0.4;
project "MapCamera public pitch contract";
import { MapCamera, Map, Marker } from "@cut/geo";
import { linear } from "@cut/motion";

timeline main(duration: 1s, fps: 4, width: 160px, height: 90px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${camera} {
      Map(detail: "110m");
      Marker(point: { latitude: 0, longitude: 0 }, color: #ff3366, radius: 5px);
    }
    ${automation}
  }
}

export out = render(main, width: 160px, height: 90px, codec: "h264");`;

function checkedModule(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return parsed.module;
}

test("MapCamera publishes pitch as an animatable Angle on the closed kernel", () => {
  const symbol = packageSymbol("@cut/geo", "MapCamera");
  assert.deepEqual(symbol?.parameters?.find((parameter) => parameter.name === "pitch"), {
    name: "pitch",
    type: "Angle",
    optional: true,
  });

  const kernel = referenceKernelSchema("cut.geo.map_camera");
  assert.ok(kernel && kernel.support === "supported");
  assert.ok(kernel.inputs.includes("pitch"));
  assert.ok(kernel.properties.includes("pitch"));
  assert.equal(kernel.propertyTypes.pitch, "Angle");
});

test("static public pitch lowers as an exact Angle input without changing bearing", () => {
  const checked = checkedModule(source("MapCamera(latitude: 0, longitude: 0, scale: 2, bearing: 15deg, pitch: 38deg)"));
  const ir = compileCutModule(checked).ir;
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.geo.map_camera");
  assert.ok(camera);
  assert.deepEqual(camera.inputs.bearing, {
    kind: "quantity",
    dimension: "angle",
    unit: "deg",
    magnitude: { numerator: "15", denominator: "1" },
  });
  assert.deepEqual(camera.inputs.pitch, {
    kind: "quantity",
    dimension: "angle",
    unit: "deg",
    magnitude: { numerator: "38", denominator: "1" },
  });
});

test("executed 0deg to positive pitch animation lowers to one typed Angle signal", () => {
  const checked = checkedModule(source(
    "MapCamera(scale: 2, pitch: 0deg) as camera",
    "animate camera.pitch from 0deg to 48deg over 1s ease linear;",
  ));
  const ir = compileCutModule(checked).ir;
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.geo.map_camera");
  assert.ok(camera?.properties.pitch && "signal" in camera.properties.pitch);
  if (!(camera?.properties.pitch && "signal" in camera.properties.pitch)) return;
  const signal = ir.signals[camera.properties.pitch.signal];
  assert.equal(signal?.valueType, "Angle");
  assert.equal(signal?.kind, "track");
  assert.deepEqual(signal?.initial, {
    kind: "quantity",
    dimension: "angle",
    unit: "deg",
    magnitude: { numerator: "0", denominator: "1" },
  });
  assert.equal(signal?.events.length, 1);
});

test("pitch rejects scalar units and undeclared camera properties with stable source locations", () => {
  const wrongUnits = parseCutLanguage(source("MapCamera(scale: 2, pitch: 38)"));
  assert.ok(wrongUnits.module, JSON.stringify(wrongUnits.diagnostics));
  const unitFailure = checkCutModule(wrongUnits.module).diagnostics.find((item) =>
    item.severity === "error" && /pitch/u.test(item.message) && /Angle/u.test(item.message));
  assert.ok(unitFailure);
  assert.equal(unitFailure.code, "CUT2029");
  assert.ok(unitFailure.span.start.line > 0 && unitFailure.span.start.column > 0);

  const unknown = parseCutLanguage(source(
    "MapCamera(scale: 2) as camera",
    "animate camera.tilt from 0deg to 20deg over 1s ease linear;",
  ));
  assert.ok(unknown.module, JSON.stringify(unknown.diagnostics));
  const propertyFailure = checkCutModule(unknown.module).diagnostics.find((item) => item.code === "CUT2060");
  assert.ok(propertyFailure);
  assert.match(propertyFailure.message, /no executable property .tilt./u);
  assert.ok(propertyFailure.span.start.line > 0 && propertyFailure.span.start.column > 0);
});
