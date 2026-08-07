import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { geoNaturalEarth1 } from "d3-geo";
import { feature } from "topojson-client";
import countries from "world-atlas/countries-110m.json";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { builtinPackageImplementationFiles, fingerprintPackageImplementation } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import {
  ReferenceGeoProjectionError,
  referenceGeoMapInset,
  referenceGeoMapPoint,
  referenceGeoMapProjection,
  referenceGeoWorldGeometry,
} from "../lib/runtime/reference/geo-projection";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const topology = countries as unknown as { objects: { countries: object } };
const world = feature(topology as never, topology.objects.countries as never);

function program(imports: string, body: string, setup = "") {
  return `cut 0.4;
project "geo contract proof";
import { ${imports} } from "@cut/geo";
${setup}
timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function checked(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return { module: parsed.module, diagnostics: checkCutModule(parsed.module).diagnostics };
}

function compile(source: string) {
  const result = checked(source);
  assert.deepEqual(result.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(result.module).ir;
  ir.determinism.semantic = "locked";
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
  }
  return ir;
}

function findNode(ir: CutAVIR, op: string) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(node, `missing ${op}`);
  return node;
}

function quantity(numerator: number, dimension: "scalar" | "angle", denominator = 1): IRValue {
  return {
    kind: "quantity",
    dimension,
    magnitude: { numerator: String(numerator), denominator: String(denominator) },
    unit: dimension === "angle" ? "deg" : "scalar",
  };
}

function geoPoint(latitude: number, longitude: number, label?: string): IRValue {
  return {
    kind: "object",
    entries: {
      latitude: quantity(latitude, "scalar"),
      longitude: quantity(longitude, "scalar"),
      ...(label === undefined ? {} : { label: { kind: "string", value: label } as const }),
    },
  };
}

function capturedValidationError(ir: CutAVIR) {
  try {
    validateReferenceSession(ir);
    assert.fail("expected geo preflight failure");
  } catch (error) {
    assert.ok(error instanceof ReferenceVisualConfigError);
    assert.match(error.message, /project\.cut:\d+:\d+/);
    return { code: error.code, nodeId: error.nodeId, message: error.message };
  }
}

test("GeoPoint literals and geo kernel arguments are closed at the source checker boundary", () => {
  const cases = [
    {
      source: program("Marker", "Marker(point: { lat: 20, longitude: 78 });"),
      codes: ["CUT2029"],
      token: "lat",
    },
    {
      source: program("Marker", "Marker(point: { latitude: 20, longitude: 78, id: \"delhi\" });"),
      codes: ["CUT2029"],
      token: 'id: "delhi"',
    },
    {
      source: program("Marker", "Marker(point: { latitude: 20, longitude: 78, label: 9 });"),
      codes: ["CUT2029"],
      token: "label",
    },
    {
      source: program("Route", "Route(points: [{ latitude: 20, longitude: 78 }, { latitude: 1, longitude: 2, extra: true }]);"),
      codes: ["CUT2011", "CUT2029"],
      token: "extra",
    },
    {
      source: program("Marker", "Marker(point: { latitude: 20, longitude: 78 }, projection: \"mercator\");"),
      codes: ["CUT2068"],
      token: "mercator",
    },
    {
      source: program("Marker", "Marker(point: { latitude: 20, longitude: 78 }, latitude: 20);"),
      codes: ["CUT2059"],
      token: "latitude: 20",
    },
  ] as const;

  for (const entry of cases) {
    const diagnostics = checked(entry.source).diagnostics.filter((item) => item.severity === "error");
    assert.ok(diagnostics.some((item) => entry.codes.includes(item.code as never)), `${entry.token}: ${JSON.stringify(diagnostics)}`);
    const tokenOffset = entry.source.lastIndexOf(entry.token);
    assert.ok(diagnostics.some((item) => item.span.start.offset <= tokenOffset && item.span.end.offset >= tokenOffset), `${entry.token} must have a source-located diagnostic`);
  }
});

test("all current geo kernels accept their valid map, globe, canvas, data, and inline-point combinations", () => {
  const ir = compile(program(
    "Globe, Map, Route, Marker, Wavefront, Connections",
    `
      Globe(points: places, rotation: 12deg, tilt: -8deg, radius: 45px, x: 96px, y: 64px, markerRadius: 3px, ocean: #07141f, land: #1f4854, line: #5f8d97, signal: #ff6b45, reveal: 80%);
      Map(points: places, font: face, signal: #ff6b45, reveal: 75%);
      Route(points: [{ latitude: 28, longitude: 77 }, { latitude: 35, longitude: 139 }], color: #f97316, width: 3px, reveal: 90%);
      Marker(point: { latitude: 28, longitude: 77 }, color: #22d3ee, radius: 7px, label: "Capital", font: face);
      Marker(point: { latitude: 35, longitude: 139 }, projection: "globe", globeRotation: 139deg, globeTilt: 35deg, globeX: 96px, globeY: 64px, globeRadius: 45px);
      Wavefront(projection: "canvas", x: 44px, y: 70px, radius: 24px, count: 2, reveal: 100%);
      Wavefront(origin: { latitude: -23, longitude: -46 }, projection: "map", radius: 20px, count: 3, reveal: 80%);
      Wavefront(origin: { latitude: 51, longitude: 0 }, projection: "globe", globeRotation: 0deg, globeTilt: 35deg, globeX: 96px, globeY: 64px, globeRadius: 45px, radius: 18px, count: 2);
      Connections(points: places, target: { latitude: 28, longitude: 77, label: "Delhi" }, count: 4, color: #22d3ee, width: 2px, reveal: 75%, font: face);
    `,
    `asset places: DataAsset = data("fixtures/places.json");
asset face: FontAsset = font("fixtures/Geist-Regular.ttf");`,
  ));
  const session = validateReferenceSession(ir);
  assert.equal(session.composition.name, "main");
  assert.deepEqual(
    new Set(Object.values(ir.nodes).map((node) => node.op)),
    new Set(["cut.geo.globe", "cut.geo.map", "cut.geo.route", "cut.geo.marker", "cut.geo.wavefront", "cut.geo.connections"]),
  );
});

test("loaded geo IR fails closed with stable codes, node identities, and source locations", () => {
  const base = program(
    "Route, Marker, Connections",
    `
      Route(points: [routeStart, routeEnd], color: #f97316, width: 3px);
      Marker(point: { latitude: 28, longitude: 77 }, color: #22d3ee);
      Connections(points: places, target: { latitude: 28, longitude: 77 }, count: 4);
    `,
    `const routeStart: GeoPoint = { latitude: 28, longitude: 77 };
const routeEnd: GeoPoint = { latitude: 35, longitude: 139 };
asset places: DataAsset = data("fixtures/places.json");`,
  );

  const cases: Array<{ op: string; mutate: (node: IRNode, ir: CutAVIR) => void; code: string; message: RegExp }> = [
    {
      op: "cut.geo.marker",
      mutate: (node) => { node.inputs.point = geoPoint(91, 77); },
      code: "CUT_VISUAL_VALUE_RANGE",
      message: /point\.latitude.*between -90 and 90/,
    },
    {
      op: "cut.geo.marker",
      mutate: (node) => {
        const point = geoPoint(28, 77);
        assert.equal(point.kind, "object");
        if (point.kind === "object") point.entries.id = { kind: "string", value: "hidden-alias" };
        node.inputs.point = point;
      },
      code: "CUT_VISUAL_INPUT_TYPE",
      message: /exactly latitude, longitude, and optional label/,
    },
    {
      op: "cut.geo.marker",
      mutate: (node) => { node.inputs.globeRotation = quantity(12, "angle"); },
      code: "CUT_VISUAL_INPUT_COMBINATION",
      message: /map projection does not execute inputs.*globeRotation/,
    },
    {
      op: "cut.geo.route",
      mutate: (node) => { node.inputs.stroke = { kind: "color", value: "#ffffff" }; },
      code: "CUT_VISUAL_INPUT_COMBINATION",
      message: /color.*stroke.*aliases/,
    },
    {
      op: "cut.geo.route",
      mutate: (node) => { node.inputs.points = { kind: "array", items: [geoPoint(28, 77)] }; },
      code: "CUT_VISUAL_VALUE_RANGE",
      message: /must contain 2 through 10000 points/,
    },
    {
      op: "cut.geo.connections",
      mutate: (node) => { node.inputs.stations = node.inputs.points; },
      code: "CUT_VISUAL_INPUT_COMBINATION",
      message: /exactly one of.*points.*stations/,
    },
    {
      op: "cut.geo.connections",
      mutate: (node) => { node.inputs.count = quantity(3, "scalar", 2); },
      code: "CUT_VISUAL_VALUE_RANGE",
      message: /integer from 1 through 500/,
    },
    {
      op: "cut.geo.connections",
      mutate: (_node, ir) => { ir.resources.places.kind = "audio"; },
      code: "CUT_VISUAL_INPUT_TYPE",
      message: /points.*DataAsset/,
    },
  ];

  for (const entry of cases) {
    const ir = compile(base), node = findNode(ir, entry.op);
    entry.mutate(node, ir);
    const first = capturedValidationError(ir), second = capturedValidationError(ir);
    assert.deepEqual(second, first, `${entry.op} diagnostics must be deterministic`);
    assert.equal(first.code, entry.code);
    assert.equal(first.nodeId, node.id);
    assert.match(first.message, entry.message);
  }
});

async function markerPixels(point: string) {
  const ir = compile(program("Marker", `Marker(point: ${point}, color: #ff6b45, radius: 8px);`));
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-geo-contract-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    return (await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0)).data;
  } finally {
    renderer.close();
  }
}

test("Marker coordinates change rendered pixels rather than serving as validation-only metadata", async () => {
  const delhi = await markerPixels("{ latitude: 28, longitude: 77 }");
  const saoPaulo = await markerPixels("{ latitude: -23, longitude: -46 }");
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  assert.notEqual(digest(delhi), digest(saoPaulo));
});

test("the shared Natural Earth helper exactly preserves the historical fit and point projection", () => {
  const deliveries = [[192, 128], [640, 360], [1080, 1920]] as const;
  const points = [
    { latitude: 0, longitude: 0 },
    { latitude: 28.6139, longitude: 77.209 },
    { latitude: -23.5505, longitude: -46.6333 },
    { latitude: 90, longitude: 180 },
  ] as const;
  for (const [width, height] of deliveries) {
    const legacy = geoNaturalEarth1().fitExtent(
      [[referenceGeoMapInset, referenceGeoMapInset], [width - referenceGeoMapInset, height - referenceGeoMapInset]],
      world as never,
    );
    const shared = referenceGeoMapProjection(width, height);
    assert.notEqual(shared, referenceGeoMapProjection(width, height), "each call must isolate mutable d3 projection state");
    assert.equal(shared.scale(), legacy.scale());
    assert.deepEqual(shared.translate(), legacy.translate());
    for (const point of points) {
      const expected = legacy([point.longitude, point.latitude]);
      assert.ok(expected);
      assert.deepEqual(shared([point.longitude, point.latitude]), expected);
      assert.deepEqual(referenceGeoMapPoint(width, height, point), expected);
    }
  }
});

test("the shared Natural Earth helper fails closed on invalid delivery and point configuration", () => {
  const failure = (code: ReferenceGeoProjectionError["code"]) => (error: unknown) => error instanceof ReferenceGeoProjectionError && error.code === code;
  for (const [width, height] of [[0, 128], [192, 0], [192.5, 128], [Number.NaN, 128]]) {
    assert.throws(() => referenceGeoMapProjection(width, height), failure("CUT_GEO_PROJECTION_CONFIG"));
  }
  assert.deepEqual(referenceGeoWorldGeometry(), world);
  for (const point of [
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
    { latitude: Number.NaN, longitude: 0 },
  ]) assert.throws(() => referenceGeoMapPoint(192, 128, point), failure("CUT_GEO_PROJECTION_POINT"));
});

const publicGeoData = Buffer.from(JSON.stringify([
  { latitude: 28, longitude: 77 },
  { latitude: 35, longitude: 139 },
  { latitude: -23, longitude: -46 },
]));

async function publicGeoPixels(symbol: string, body: string, setup = "") {
  const root = await mkdtemp(resolve(tmpdir(), "cut-geo-byte-regression-"));
  try {
    await writeFile(resolve(root, "places.json"), publicGeoData);
    const ir = compile(program(symbol, body, setup));
    const resourceHash = createHash("sha256").update(publicGeoData).digest("hex");
    for (const resource of Object.values(ir.resources)) {
      resource.sha256 = resourceHash;
      resource.metadata = { ...resource.metadata, bytes: publicGeoData.byteLength };
    }
    const { composition } = validateReferenceSession(ir);
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
    await renderer.prepare();
    try {
      return (await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 1)).data;
    } finally {
      await renderer.closeAndWait();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("all public Natural Earth consumers retain their pre-refactor RGBA bytes", async () => {
  const cases = [
    {
      name: "Map",
      body: "Map(points: places, signal: #ff6b45, reveal: 83%);",
      setup: 'asset places: DataAsset = data("places.json");',
      sha256: "00744cafbf3c085079433838ac268dd7f8a099e9afc74503d11ce48761d40f5b",
    },
    {
      name: "Route",
      body: "Route(points: [{ latitude: 28, longitude: 77 }, { latitude: 35, longitude: 139 }, { latitude: -23, longitude: -46 }], color: #f97316, width: 3px, reveal: 63%);",
      sha256: "033a1a4f9659354cf4834848df931fb82e210f2ed428712daf1efe894d4c5403",
    },
    {
      name: "Marker",
      body: "Marker(point: { latitude: 28, longitude: 77 }, color: #22d3ee, radius: 7px);",
      sha256: "e5018af1e23c69007b685a3cbeda651f1b628669a245e6567d492db5dfa51b17",
    },
    {
      name: "Wavefront",
      body: 'Wavefront(origin: { latitude: -23, longitude: -46 }, projection: "map", radius: 20px, count: 3, reveal: 80%);',
      sha256: "94d885b35ab00d62227c8130bc4b4283e2055d626147a24580c08025a42b8ad5",
    },
    {
      name: "Connections",
      body: "Connections(points: places, target: { latitude: 51, longitude: 0 }, count: 3, color: #22d3ee, width: 2px, reveal: 75%);",
      setup: 'asset places: DataAsset = data("places.json");',
      sha256: "56a9b80ccde1f9fa3ff808cf4b22b005237e03264fd87d221d4ce9c3875c7ce7",
    },
  ] as const;
  for (const entry of cases) {
    const pixels = await publicGeoPixels(entry.name, entry.body, "setup" in entry ? entry.setup : "");
    assert.equal(createHash("sha256").update(pixels).digest("hex"), entry.sha256, entry.name);
  }
});

test("@cut/geo implementation identity closes over the shared projection helper", () => {
  const moduleId = "runtime/reference/geo-projection";
  const files = builtinPackageImplementationFiles("@cut/geo");
  assert.ok(files.includes(moduleId));
  assert.notEqual(
    fingerprintPackageImplementation("@cut/geo", undefined, new Map([[moduleId, "hostile projection mutation"]])),
    fingerprintPackageImplementation("@cut/geo"),
  );
});
