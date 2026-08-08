import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../lib/language/ir";
import { rational } from "../lib/language/rational";
import {
  ReferenceMapCameraRenderError,
  assertReferenceMapCameraCanonicalStreamBytes,
  prepareReferenceMapCameraRenderInvocation,
  referenceMapCameraPreparedConfigurations,
  referenceMapCameraRenderAlgorithmVersion,
  referenceMapCameraRenderLimits,
  referenceMapCameraVerifyAtlasBytes,
  renderReferenceMapCameraFrame,
} from "../lib/runtime/reference/map-camera-render";
import { ReferenceMapCameraError, validateReferenceMapCameraGraph } from "../lib/runtime/reference/map-camera";

const span = { start: { offset: 0, line: 11, column: 5 }, end: { offset: 1, line: 11, column: 6 } };
const provenance = (symbol: string) => ({ module: "map-camera-render-proof.cut", span, symbol });

function scalar(numerator: number, denominator = 1): IRValue {
  return { kind: "quantity", dimension: "scalar", unit: "scalar", magnitude: rational(numerator, denominator) };
}

function angle(numerator: number, denominator = 1): IRValue {
  return { kind: "quantity", dimension: "angle", unit: "deg", magnitude: rational(numerator, denominator) };
}

function ratio(numerator: number, denominator = 1): IRValue {
  return { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(numerator, denominator) };
}

function length(numerator: number, denominator = 1): IRValue {
  return { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(numerator, denominator) };
}

function point(latitude: number, longitude: number, label?: string): IRValue {
  return {
    kind: "object",
    entries: {
      latitude: scalar(latitude),
      longitude: scalar(longitude),
      ...(label === undefined ? {} : { label: { kind: "string", value: label } as IRValue }),
    },
  };
}

function list(...items: IRValue[]): IRValue {
  return { kind: "array", items };
}

function visualNode(
  id: string,
  op: string,
  inputs: Record<string, IRValue> = {},
  children: string[] = [],
  properties: IRNode["properties"] = {},
): IRNode {
  return {
    id,
    op,
    domain: "visual",
    ownership: id === "camera" ? "root" : "child",
    sceneId: "scene",
    interval: { start: rational(0), duration: rational(1) },
    inputs,
    children,
    properties,
    effects: ["pure"],
    contentHash: `${id}-content`,
    provenance: provenance(id),
  };
}

function fixture(options: {
  children?: IRNode[];
  additionalNodes?: IRNode[];
  width?: number;
  height?: number;
  fps?: number;
  cameraInputs?: Record<string, IRValue>;
  cameraProperties?: IRNode["properties"];
  signals?: Record<string, IRSignal>;
} = {}) {
  const children = options.children ?? [visualNode("marker", "cut.geo.marker", { point: point(0, 0), radius: length(7) })];
  const camera = visualNode("camera", "cut.geo.map_camera", options.cameraInputs, children.map((child) => child.id), options.cameraProperties);
  const nodes: Record<string, IRNode> = { camera };
  for (const node of [...children, ...(options.additionalNodes ?? [])]) nodes[node.id] = node;
  const composition: IRComposition = {
    id: "composition",
    name: "isolated final-space map camera proof",
    width: options.width ?? 160,
    height: options.height ?? 90,
    fps: rational(options.fps ?? 4),
    sampleRate: 48_000,
    duration: rational(1),
    sceneIds: ["scene"],
    rootVisualIds: [camera.id],
    rootAudioIds: [],
    rootAVIds: [],
    items: [{ kind: "scene", id: "scene" }],
    provenance: provenance("composition"),
  };
  const ir: CutAVIR = {
    format: "cut-av-ir",
    version: 3,
    language: "0.4",
    compiler: "cut-ts/test",
    project: "isolated map camera render proof",
    sourceHash: "source",
    buildId: "build",
    determinism: { semantic: "locked", decodedMedia: "verified", bitstream: "unverified" },
    timebase: { defaultFps: composition.fps, audioSampleRate: 48_000 },
    modules: [{ specifier: "@cut/geo", version: "0.4.0-alpha.2", integrity: "geo-integrity" }],
    resources: {},
    compositions: [composition],
    scenes: {
      scene: {
        id: "scene",
        name: "only",
        start: rational(0),
        duration: rational(1),
        rootVisualIds: [camera.id],
        rootAudioIds: [],
        rootAVIds: [],
        items: [{ id: camera.id, domain: "visual" }],
        provenance: provenance("scene"),
      },
    },
    nodes,
    signals: options.signals ?? {},
    jobs: [],
    outputs: [],
    assertions: [],
    annotations: { markers: [], regions: [] },
    linkedEdits: [],
  };
  const config = validateReferenceMapCameraGraph(ir, composition).get(camera.id);
  assert.ok(config);
  return { ir, composition, camera, children, config };
}

function expectRenderCode(work: () => Promise<unknown>, code: ReferenceMapCameraRenderError["code"], message?: RegExp) {
  return assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceMapCameraRenderError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.source.module, "map-camera-render-proof.cut");
    assert.equal(error.source.line, 11);
    assert.equal(error.source.column, 5);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function alphaBounds(data: Buffer, width: number, height: number) {
  let left = width, top = height, right = -1, bottom = -1, count = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (data[(y * width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y); count += 1;
  }
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1, count };
}

function exactRgbBounds(data: Buffer, width: number, height: number, rgb: readonly [number, number, number]) {
  let left = width, top = height, right = -1, bottom = -1, count = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    if (data[offset] !== rgb[0] || data[offset + 1] !== rgb[1] || data[offset + 2] !== rgb[2] || data[offset + 3] !== 255) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y); count += 1;
  }
  assert.ok(count > 0, `expected opaque rgb(${rgb.join(",")}) pixels`);
  return { left, top, right, bottom, count, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

function assertTransparentRgbIsClear(data: Buffer) {
  for (let offset = 0; offset < data.byteLength; offset += 4) if (data[offset + 3] === 0) {
    assert.equal(data[offset], 0, `red at pixel ${offset / 4}`);
    assert.equal(data[offset + 1], 0, `green at pixel ${offset / 4}`);
    assert.equal(data[offset + 2], 0, `blue at pixel ${offset / 4}`);
  }
}

test("isolated MapCamera executes every non-annotation leaf in one alpha-safe final raster", async () => {
  const map = visualNode("map", "cut.geo.map", {
    detail: { kind: "string", value: "110m" },
    background: { kind: "color", value: "#091820" },
    land: { kind: "color", value: "#31545d" },
  });
  const route = visualNode("route", "cut.geo.route", {
    points: list(point(0, -45), point(12, 0), point(0, 45)),
    color: { kind: "color", value: "#e74c3c" },
    width: length(4),
  });
  const marker = visualNode("marker", "cut.geo.marker", {
    point: point(12, 0), color: { kind: "color", value: "#f9c74f" }, radius: length(7),
  });
  const wavefront = visualNode("wavefront", "cut.geo.wavefront", {
    origin: point(0, 0), radius: length(28), color: { kind: "color", value: "#90be6d" }, count: scalar(4), reveal: ratio(3, 4),
  });
  const connections = visualNode("connections", "cut.geo.connections", {
    points: list(point(-20, -50), point(28, 35), point(-10, 60)),
    target: point(5, 5), color: { kind: "color", value: "#43aa8b" }, width: length(3), count: scalar(2), reveal: ratio(4, 5),
  });
  const value = fixture({ children: [map, route, marker, wavefront, connections], width: 240, height: 135 });
  const frame = await renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));

  assert.equal(frame.evidenceKind, "completed-isolated-frame-execution");
  assert.equal(frame.publicRuntimeStatus, "not-connected");
  assert.equal(frame.cacheStatus, "identity-only-no-cache-read-write-or-locality-evidence");
  assert.deepEqual(frame.children.map((entry) => [entry.kind, entry.status]), [
    ["map", "drawn"], ["route", "drawn"], ["marker", "drawn"], ["wavefront", "drawn"], ["connections", "drawn"],
  ]);
  assert.deepEqual(frame.atlas[0], {
    detail: "110m",
    bytes: 107_761,
    arcs: 595,
    coordinateRecords: 8_246,
    sha256: "2516c915867c7baf18ddec727aec46c315541a07cfb3d79a6559b05d5e94eee8",
    licenseSha256: "8048290dfdb6e83fbed17e8985c8cfc4ce9da9b842642f3d3e497280790cfa31",
    packages: { worldAtlas: "world-atlas@2.0.2", topojsonClient: "topojson-client@3.1.0", d3Geo: "d3-geo@3.1.1" },
  });
  assert.deepEqual({
    worldAtlas: frame.backend.worldAtlas, topojsonClient: frame.backend.topojsonClient, d3Geo: frame.backend.d3Geo,
    sharp: frame.backend.sharp, rsvg: frame.backend.rsvg, vips: frame.backend.vips,
  }, {
    worldAtlas: "world-atlas@2.0.2", topojsonClient: "topojson-client@3.1.0", d3Geo: "d3-geo@3.1.1",
    sharp: "0.35.3", rsvg: "2.62.90", vips: "8.18.3",
  });
  assert.match(frame.backend.sharpStackIdentity, /^[0-9a-f]{64}$/u);
  assert.equal(frame.backend.node, process.versions.node);
  assert.equal(frame.backend.v8, process.versions.v8);
  assert.equal(frame.backend.platform, process.platform);
  assert.equal(frame.backend.arch, process.arch);
  assert.equal(frame.surface.data.byteLength, 240 * 135 * 4);
  assert.ok(alphaBounds(frame.surface.data, 240, 135).count > 20_000);
  assertTransparentRgbIsClear(frame.surface.data);
  assert.deepEqual(frame.counters, {
    measurement: "instrumented-isolated-executor",
    atlasByteVerifications: 1,
    dependencyIdentityVerifications: 1,
    projectedChildren: 5,
    drawnChildren: 5,
    clippedEmptyChildren: 0,
    canonicalStreamSerializations: 1,
    rasterizations: 1,
    resizePasses: 0,
    resamplePasses: 0,
    alphaCanonicalizationPasses: 1,
    clearedTransparentRgbPixels: frame.counters.clearedTransparentRgbPixels,
    preProjectiveClipConfigurations: 0,
    postProjectiveClipConfigurations: 1,
    projectivePitchPointEvents: 0,
    routeSubjectSegments: 0,
    routeSubjectSegmentFrameEvaluations: 0,
    routeSubjectSegmentFrameEvaluationLimit: 4_000_000,
  });
  assert.deepEqual(frame.execution, {
    retainedGeometry: "executed-in-final-delivery-space",
    raster: "executed-once-at-delivery-resolution",
    resize: "not-executed",
    resample: "not-executed",
    planCacheIdentity: frame.execution.planCacheIdentity,
    deferredAnnotationIds: [],
  });
  assert.match(frame.execution.planCacheIdentity, /^[0-9a-f]{64}$/u);
  assert.match(frame.semanticIdentity, /^[0-9a-f]{64}$/u);
  assert.match(frame.cacheIdentity, /^[0-9a-f]{64}$/u);
  assert.match(frame.executionIdentity, /^[0-9a-f]{64}$/u);
});

test("MapCamera v5 rasterizes an admitted >10 MB canonical atlas stream while CUT's own stream ceiling remains authoritative", { timeout: 90_000 }, async () => {
  const map = visualNode("map", "cut.geo.map", {
    detail: { kind: "string", value: "10m" },
    background: { kind: "color", value: "#d9e9e2" },
    land: { kind: "color", value: "#cad0a9" },
    border: { kind: "color", value: "#52695f" },
    graticule: { kind: "color", value: "#52695f2e" },
    graticuleWidth: length(3, 5),
  });
  const value = fixture({
    children: [map],
    width: 640,
    height: 360,
    cameraInputs: { latitude: scalar(26), longitude: scalar(12), scale: scalar(41, 50) },
  });
  const frame = await renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
  assert.equal(referenceMapCameraRenderAlgorithmVersion, "cut-reference-map-camera-final-space-render-v5");
  assert.ok(frame.canonicalDrawingStream.bytes > 10_003_992, String(frame.canonicalDrawingStream.bytes));
  assert.ok(frame.canonicalDrawingStream.bytes <= referenceMapCameraRenderLimits.maximumCanonicalDrawingStreamBytes);
  assert.equal(frame.algorithmVersion, referenceMapCameraRenderAlgorithmVersion);
  assert.equal(frame.surface.data.byteLength, 640 * 360 * 4);
  assert.ok(alphaBounds(frame.surface.data, 640, 360).count > 200_000);

  assert.throws(
    () => assertReferenceMapCameraCanonicalStreamBytes(value.camera, referenceMapCameraRenderLimits.maximumCanonicalDrawingStreamBytes + 1),
    (error: unknown) => error instanceof ReferenceMapCameraRenderError
      && error.code === "CUT_MAP_CAMERA_RENDER_STREAM"
      && /33554433 bytes; limit 33554432/.test(error.message),
    "a stream above CUT's own ceiling must fail before backend invocation",
  );
  assert.throws(
    () => assertReferenceMapCameraCanonicalStreamBytes(value.camera, Number.NaN),
    (error: unknown) => error instanceof ReferenceMapCameraRenderError
      && error.code === "CUT_MAP_CAMERA_RENDER_STREAM"
      && /non-negative safe integer/.test(error.message),
  );
});

test("MapCamera pixel geometry pans and zooms while delivery-pixel strokes and radii stay invariant", async () => {
  const routeAt = async (scale?: number) => {
    const route = visualNode("route", "cut.geo.route", {
      points: list(point(0, -40), point(0, 40)), color: { kind: "color", value: "#e63946" }, width: length(4),
    });
    const value = fixture({ children: [route], ...(scale === undefined ? {} : { cameraInputs: { scale: scalar(scale) } }) });
    return renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
  };
  const route1 = await routeAt(), route9 = await routeAt(9);
  assert.notEqual(route1.surface.sha256, route9.surface.sha256);
  assert.deepEqual(route1.children[0].screenSpace, { strokeWidths: [4], radii: [], cameraScaleAppliedToStyle: false });
  assert.deepEqual(route9.children[0].screenSpace, route1.children[0].screenSpace);
  assert.equal(alphaBounds(route1.surface.data, 160, 90).height, alphaBounds(route9.surface.data, 160, 90).height);

  const markerAt = async (cameraInputs?: Record<string, IRValue>, longitude = 0) => {
    const marker = visualNode("marker", "cut.geo.marker", { point: point(0, longitude), color: { kind: "color", value: "#f94144" }, radius: length(7) });
    const value = fixture({ children: [marker], cameraInputs });
    return renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
  };
  const marker1 = await markerAt(), marker9 = await markerAt({ scale: scalar(9) });
  assert.equal(marker1.surface.sha256, marker9.surface.sha256, "the same centre marker must not be rescaled by camera zoom");
  assert.deepEqual(marker1.children[0].screenSpace.radii, [7]);
  assert.deepEqual(marker9.children[0].screenSpace.radii, [7]);
  assert.deepEqual(alphaBounds(marker1.surface.data, 160, 90), alphaBounds(marker9.surface.data, 160, 90));

  const unpanned = await markerAt({ scale: scalar(4) }, 20);
  const panned = await markerAt({ scale: scalar(4), longitude: scalar(20) }, 20);
  const unpannedBounds = alphaBounds(unpanned.surface.data, 160, 90), pannedBounds = alphaBounds(panned.surface.data, 160, 90);
  assert.notEqual(unpanned.surface.sha256, panned.surface.sha256);
  assert.ok(Math.abs((pannedBounds.left + pannedBounds.right) / 2 - 80) <= 0.5);
  assert.ok((unpannedBounds.left + unpannedBounds.right) / 2 > 80);
  assert.ok(Math.abs(unpannedBounds.width - pannedBounds.width) <= 1, "subpixel translation may move one antialias fringe pixel");
  assert.ok(Math.abs(unpannedBounds.height - pannedBounds.height) <= 1, "subpixel translation may move one antialias fringe pixel");
});

test("omitting bearing preserves the frozen north-up pixel result exactly", async () => {
  const marker = visualNode("marker", "cut.geo.marker", {
    point: point(0, 20), color: { kind: "color", value: "#f94144" }, radius: length(7),
  });
  const value = fixture({ children: [marker], cameraInputs: { scale: scalar(4) } });
  const frame = await renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
  assert.equal(frame.surface.sha256, "9167ecf3ada7a01ee91be74fc4ab0f04367ac6c228ffc7e36e21166b6663a961");
  assert.equal(frame.state.bearing, 0);
  assert.equal(frame.state.effectiveBearing, 0);
  assert.deepEqual(frame.state.exact.bearing, rational(0));
  assert.deepEqual(frame.state.exact.effectiveBearing, rational(0));
});

test("+90deg bearing rotates maps, routes, and markers through one counterclockwise projection without rotating screen-space style", async () => {
  const render = async (bearing?: number) => {
    const map = visualNode("map", "cut.geo.map", {
      detail: { kind: "string", value: "110m" },
      background: { kind: "color", value: "#fff8ed" },
      land: { kind: "color", value: "#c9e6d0" },
      border: { kind: "color", value: "#396c52" },
    });
    const route = visualNode("route", "cut.geo.route", {
      points: list(point(0, -30), point(0, 30)), color: { kind: "color", value: "#161a24" }, width: length(3),
    });
    const marker = visualNode("marker", "cut.geo.marker", {
      point: point(0, 30), color: { kind: "color", value: "#ff00ff" }, radius: length(6),
    });
    const value = fixture({
      children: [map, route, marker],
      cameraInputs: { scale: scalar(2), ...(bearing === undefined ? {} : { bearing: angle(bearing) }) },
      width: 240,
      height: 135,
    });
    return renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
  };
  const northUp = await render(), eastUp = await render(90);
  const northMarker = exactRgbBounds(northUp.surface.data, 240, 135, [255, 0, 255]);
  const eastMarker = exactRgbBounds(eastUp.surface.data, 240, 135, [255, 0, 255]);
  assert.ok(northMarker.centerX > 120 && Math.abs(northMarker.centerY - 67.5) <= 1, JSON.stringify(northMarker));
  assert.ok(Math.abs(eastMarker.centerX - 120) <= 1 && eastMarker.centerY < 67.5, JSON.stringify(eastMarker));
  assert.equal(eastUp.state.bearing, 90);
  assert.equal(eastUp.state.effectiveBearing, 90);

  for (const kind of ["map", "route", "marker"] as const) {
    const north = northUp.children.find((child) => child.kind === kind)!;
    const east = eastUp.children.find((child) => child.kind === kind)!;
    assert.notEqual(east.fragmentDigest, north.fragmentDigest, `${kind} geometry must bind the sampled bearing`);
    assert.deepEqual(east.screenSpace, north.screenSpace, `${kind} delivery-pixel style must not rotate or scale`);
  }
  assert.notEqual(eastUp.canonicalDrawingStream.sha256, northUp.canonicalDrawingStream.sha256);
  assert.notEqual(eastUp.surface.sha256, northUp.surface.sha256);
  assert.notEqual(eastUp.cacheIdentity, northUp.cacheIdentity);
  assert.notEqual(eastUp.executionIdentity, northUp.executionIdentity);
});

test("MapCamera clips leaves, exposes clipped evidence, and refuses an all-empty sample", async () => {
  const map = visualNode("map", "cut.geo.map", { detail: { kind: "string", value: "110m" } });
  const marker = visualNode("marker", "cut.geo.marker", { point: point(0, 180), radius: length(7) });
  const withMap = fixture({ children: [map, marker], cameraInputs: { scale: scalar(64) } });
  const frame = await renderReferenceMapCameraFrame(withMap.ir, withMap.composition, withMap.config, rational(0));
  assert.equal(frame.children.find((entry) => entry.kind === "marker")?.status, "clipped-empty");
  assert.equal(frame.counters.clippedEmptyChildren, 1);

  const onlyMarker = fixture({ children: [visualNode("marker", "cut.geo.marker", { point: point(0, 180), radius: length(7) })], cameraInputs: { scale: scalar(64) } });
  await expectRenderCode(
    () => renderReferenceMapCameraFrame(onlyMarker.ir, onlyMarker.composition, onlyMarker.config, rational(0)),
    "CUT_MAP_CAMERA_RENDER_NOOP",
    /every active geographic leaf clips/,
  );
});

test("MapCamera verifies exact atlas bytes before decode", () => {
  const value = fixture({ children: [visualNode("map", "cut.geo.map", { detail: { kind: "string", value: "110m" } })] });
  const license = readFileSync(require.resolve("world-atlas/LICENSE"));
  const expected = { "110m": 8_246, "50m": 80_617, "10m": 477_295 } as const;
  for (const detail of ["110m", "50m", "10m"] as const) {
    const bytes = readFileSync(require.resolve(`world-atlas/countries-${detail}.json`));
    const verified = referenceMapCameraVerifyAtlasBytes(value.children[0], detail, bytes, license);
    assert.equal(verified.evidence.coordinateRecords, expected[detail]);
  }
  const bytes = readFileSync(require.resolve("world-atlas/countries-110m.json"));
  const corrupt = Buffer.from(bytes); corrupt[corrupt.byteLength - 2] ^= 1;
  assert.throws(
    () => referenceMapCameraVerifyAtlasBytes(value.children[0], "110m", corrupt, license),
    (error: unknown) => error instanceof ReferenceMapCameraRenderError && error.code === "CUT_MAP_CAMERA_RENDER_RESOURCE",
  );
});

test("MapCamera refuses uppercase style, explicit style defaults, and out-of-frame signal entries", async () => {
  assert.throws(
    () => fixture({ children: [visualNode("route", "cut.geo.route", {
      points: list(point(0, -20), point(0, 20)), color: { kind: "color", value: "#FF0000" },
    })] }),
    (error: unknown) => error instanceof ReferenceMapCameraError && error.code === "CUT_MAP_CAMERA_CHILD" && /canonical lowercase/.test(error.message),
  );

  assert.throws(
    () => fixture({ children: [visualNode("route", "cut.geo.route", {
      points: list(point(0, -20), point(0, 20)), width: length(5),
    })] }),
    (error: unknown) => error instanceof ReferenceMapCameraError && error.code === "CUT_MAP_CAMERA_NOOP" && /repeats the retained renderer default/.test(error.message),
  );

  const transparent = fixture({ children: [visualNode("marker", "cut.geo.marker", {
    point: point(0, 0), color: { kind: "color", value: "#f9414400" },
  })] });
  await expectRenderCode(
    () => renderReferenceMapCameraFrame(transparent.ir, transparent.composition, transparent.config, rational(0)),
    "CUT_MAP_CAMERA_RENDER_NOOP",
    /fully transparent required drawing color/,
  );

  const halfAlpha = fixture({ children: [visualNode("marker", "cut.geo.marker", {
    point: point(0, 0), color: { kind: "color", value: "#ff000080" }, radius: length(7),
  })] });
  const halfAlphaFrame = await renderReferenceMapCameraFrame(halfAlpha.ir, halfAlpha.composition, halfAlpha.config, rational(0));
  const centre = (45 * 160 + 80) * 4;
  assert.deepEqual([...halfAlphaFrame.surface.data.subarray(centre, centre + 4)], [255, 0, 0, 128], "RGBA output must be straight, not premultiplied");

  const linear: IRValue = { kind: "symbol", name: "@cut/motion#linear" };
  const longitude: IRSignal = {
    id: "longitude",
    kind: "track",
    valueType: "Number",
    initial: scalar(0),
    events: [
      { kind: "animate", start: rational(0), end: rational(1), from: scalar(0), to: scalar(20), curve: linear },
      { kind: "set", time: rational(2), value: scalar(30) },
    ],
    contentHash: "longitude",
    provenance: provenance("longitude"),
  };
  const future = fixture({
    cameraProperties: { longitude: { signal: longitude.id } },
    signals: { [longitude.id]: longitude },
  });
  await expectRenderCode(
    () => renderReferenceMapCameraFrame(future.ir, future.composition, future.config, rational(0)),
    "CUT_MAP_CAMERA_RENDER_NOOP",
    /begins after every bounded output-frame sample/,
  );
  future.ir.signals[longitude.id] = {
    ...longitude,
    events: [longitude.events[0], { kind: "set", time: rational(2), value: scalar(200) }],
  };
  await assert.rejects(
    () => renderReferenceMapCameraFrame(future.ir, future.composition, future.config, rational(0)),
    (error: unknown) => error instanceof ReferenceMapCameraError && error.code === "CUT_MAP_CAMERA_RANGE" && /signal longitude\.events\[1\]\.value/.test(error.message),
    "fresh graph validation must inspect an invalid future entry even though no current sample reaches it",
  );
});

test("MapCamera samples animated camera state into different executed pixels and cache identities", async () => {
  const linear: IRValue = { kind: "symbol", name: "@cut/motion#linear" };
  const scale: IRSignal = {
    id: "scale",
    kind: "track",
    valueType: "Number",
    initial: scalar(1),
    events: [{ kind: "animate", start: rational(0), end: rational(1), from: scalar(1), to: scalar(9), curve: linear }],
    contentHash: "scale",
    provenance: provenance("scale"),
  };
  const route = visualNode("route", "cut.geo.route", {
    points: list(point(0, -40), point(0, 40)), color: { kind: "color", value: "#577590" }, width: length(4),
  });
  const value = fixture({ children: [route], cameraProperties: { scale: { signal: scale.id } }, signals: { [scale.id]: scale } });
  const first = await renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
  const middle = await renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(1, 2));
  assert.equal(first.state.scale, 1);
  assert.equal(middle.state.scale, 5);
  assert.notEqual(first.surface.sha256, middle.surface.sha256);
  assert.notEqual(first.cacheIdentity, middle.cacheIdentity);
  assert.notEqual(first.executionIdentity, middle.executionIdentity);
  assert.equal(alphaBounds(first.surface.data, 160, 90).height, alphaBounds(middle.surface.data, 160, 90).height);
  assert.equal(first.counters.rasterizations, 1);
  assert.equal(middle.counters.rasterizations, 1);
});

test("MapCamera refuses annotations and non-frame execution times explicitly", async () => {
  const rect = visualNode("rect", "cut.visual.rect", { width: length(80), height: length(30) });
  const local = visualNode("local", "cut.visual.local_space", {
    width: length(80), height: length(30), origin: { kind: "object", entries: { x: length(0), y: length(0) } },
  }, [rect.id]);
  const annotation = visualNode("annotation", "cut.geo.annotation", {
    anchor: point(0, 0),
    leader: { kind: "string", value: "none" },
  }, [local.id]);
  const base = visualNode("base", "cut.geo.marker", { point: point(0, 0), color: { kind: "color", value: "#f94144" }, radius: length(7) });
  const value = fixture({ children: [base, annotation], additionalNodes: [local, rect] });
  await expectRenderCode(
    () => renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0)),
    "CUT_MAP_CAMERA_RENDER_UNSUPPORTED",
    /GeoAnnotation\/LocalSpace callback placement/,
  );

  const marker = fixture();
  await expectRenderCode(
    () => renderReferenceMapCameraFrame(marker.ir, marker.composition, marker.config, rational(1, 8)),
    "CUT_MAP_CAMERA_RENDER_SIGNAL",
    /not one bounded exact output-frame sample/,
  );
});

test("MapCamera replay is byte-deterministic for 16:9, 9:16, and 1:1 delivery", async () => {
  const identities = new Set<string>();
  for (const [width, height] of [[160, 90], [90, 160], [96, 96]] as const) {
    const route = visualNode("route", "cut.geo.route", {
      points: list(point(-12, -40), point(8, 0), point(20, 40)), color: { kind: "color", value: "#277da1" }, width: length(3),
    });
    const marker = visualNode("marker", "cut.geo.marker", { point: point(8, 0), color: { kind: "color", value: "#f9844a" }, radius: length(6) });
    const value = fixture({ children: [route, marker], width, height, cameraInputs: { scale: scalar(3, 2) } });
    const first = await renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
    const second = await renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
    assert.equal(first.canonicalDrawingStream.sha256, second.canonicalDrawingStream.sha256);
    assert.equal(first.surface.sha256, second.surface.sha256);
    assert.equal(first.cacheIdentity, second.cacheIdentity);
    assert.equal(first.executionIdentity, second.executionIdentity);
    assert.deepEqual(first.surface.data, second.surface.data);
    assertTransparentRgbIsClear(first.surface.data);
    identities.add(first.executionIdentity);
  }
  assert.equal(identities.size, 3, "delivery aspect is part of semantic and execution identity");
});

test("renderer-invocation preparation reuses only verified graph/dependency/atlas work and preserves exact pixels", async () => {
  const map = visualNode("map", "cut.geo.map", {
    detail: { kind: "string", value: "110m" },
    background: { kind: "color", value: "#091820" },
    land: { kind: "color", value: "#31545d" },
  });
  const route = visualNode("route", "cut.geo.route", {
    points: list(point(0, -45), point(12, 0), point(0, 45)),
    color: { kind: "color", value: "#e74c3c" },
    width: length(4),
  });
  const value = fixture({ children: [map, route], width: 160, height: 90 });
  const preparation = prepareReferenceMapCameraRenderInvocation(
    value.ir,
    value.composition,
    new Set(["camera", "map", "route"]),
  );
  assert.equal(preparation.validation, "whole-graph-and-signal-influence-once-before-frame-raster");
  assert.equal(preparation.verifiedInputs.scope, "renderer-invocation-only");
  assert.equal(preparation.verifiedInputs.dependencyIdentityVerifications, 1);
  assert.equal(preparation.verifiedInputs.atlasByteVerifications, 1);
  assert.equal(preparation.verifiedInputs.persistentCacheReads, 0);
  assert.equal(preparation.verifiedInputs.persistentCacheWrites, 0);
  assert.equal(preparation.verifiedInputs.atlases[0]?.sha256, "2516c915867c7baf18ddec727aec46c315541a07cfb3d79a6559b05d5e94eee8");
  assert.equal(Object.isFrozen(preparation), true);
  assert.equal(Object.isFrozen(preparation.verifiedInputs), true);
  assert.equal(Object.isFrozen(preparation.verifiedInputs.atlases), true);
  assert.throws(
    () => referenceMapCameraPreparedConfigurations({ ...preparation }),
    /was not created by this runtime invocation/,
  );

  const preparedConfig = referenceMapCameraPreparedConfigurations(preparation).get(value.camera.id);
  assert.ok(preparedConfig);
  const fresh = await renderReferenceMapCameraFrame(value.ir, value.composition, value.config, rational(0));
  const prepared = await renderReferenceMapCameraFrame(value.ir, value.composition, preparedConfig, rational(0), {
    annotationMode: "reject",
    evidenceKind: "completed-isolated-frame-execution",
    publicRuntimeStatus: "not-connected",
    cacheStatus: "identity-only-no-cache-read-write-or-locality-evidence",
    preparation,
  });
  assert.deepEqual(prepared.surface.data, fresh.surface.data);
  assert.equal(prepared.surface.sha256, fresh.surface.sha256);
  assert.equal(prepared.canonicalDrawingStream.sha256, fresh.canonicalDrawingStream.sha256);
  assert.equal(prepared.cacheIdentity, fresh.cacheIdentity);
  assert.notEqual(prepared.executionIdentity, fresh.executionIdentity);
  assert.equal(prepared.counters.dependencyIdentityVerifications, 0);
  assert.equal(prepared.counters.atlasByteVerifications, 0);
  assert.equal(prepared.counters.rasterizations, 1);

  const foreign = fixture({ children: [visualNode("foreign-marker", "cut.geo.marker", { point: point(0, 0), radius: length(7) })] });
  await expectRenderCode(
    () => renderReferenceMapCameraFrame(foreign.ir, foreign.composition, foreign.config, rational(0), {
      annotationMode: "reject",
      evidenceKind: "completed-isolated-frame-execution",
      publicRuntimeStatus: "not-connected",
      cacheStatus: "identity-only-no-cache-read-write-or-locality-evidence",
      preparation,
    }),
    "CUT_MAP_CAMERA_RENDER_GRAPH",
    /belongs to another IR\/composition invocation/,
  );
});
