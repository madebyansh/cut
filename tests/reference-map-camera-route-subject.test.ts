import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { hash } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import {
  ReferenceMapCameraError,
  referenceMapCameraAlgorithmVersion,
  referenceMapCameraFinalSpaceRasterAlgorithmVersion,
  referenceMapCameraLimits,
  referenceMapCameraRouteSubjectAlgorithmVersion,
  validateReferenceMapCameraGraph,
} from "../lib/runtime/reference/map-camera";
import {
  renderReferenceMapCameraFrame,
  validateReferenceMapCameraFrameEvidenceSemantics,
} from "../lib/runtime/reference/map-camera-render";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const source = `cut 0.4;
project "Public moving geographic subject";
import { MapCamera, Route, RouteSubject } from "@cut/geo";
import { linear } from "@cut/motion";

timeline main(duration: 1s, fps: 4, width: 240px, height: 135px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MapCamera() {
      Route(
        points: [
          { latitude: 0, longitude: -60 },
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 60 }
        ],
        color: #16324f,
        width: 3px
      );
      RouteSubject(
        points: [
          { latitude: 0, longitude: -60 },
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 60 }
        ],
        progress: 0%,
        color: #ff00ff,
        radius: 6px,
        opacity: 40%
      ) as vessel;
      animate vessel.progress from 0% to 100% over 1s ease linear;
      animate vessel.opacity from 40% to 100% over 1s ease linear;
    }
  }
}

export out = render(main, width: 240px, height: 135px, codec: "h264");`;

const portraitSource = `cut 0.4;
project "Unrelated portrait moving subject";
import { MapCamera, Route, RouteSubject, Marker } from "@cut/geo";
import { inOutCubic } from "@cut/motion";

timeline main(duration: 2s, fps: 4, width: 180px, height: 320px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    MapCamera(latitude: 19, longitude: 103, scale: 2.5, bearing: -12deg, pitch: 24deg) {
      Route(
        points: [
          { latitude: 1.29, longitude: 103.85 },
          { latitude: 22.32, longitude: 114.17 },
          { latitude: 35.68, longitude: 139.76 }
        ],
        color: #2c3e50,
        width: 2px
      );
      RouteSubject(
        points: [
          { latitude: 1.29, longitude: 103.85 },
          { latitude: 22.32, longitude: 114.17 },
          { latitude: 35.68, longitude: 139.76 }
        ],
        progress: 5%,
        color: #f72585,
        radius: 5px
      ) as train;
      Marker(point: { latitude: 35.68, longitude: 139.76 }, color: #4cc9f0, radius: 4px);
      animate train.progress from 5% to 95% over 2s ease inOutCubic;
    }
  }
}

export out = render(main, width: 180px, height: 320px, codec: "h264");`;

const staggeredSubjectsSource = `cut 0.4;
project "Active RouteSubject frame accounting";
import { MapCamera, Route, RouteSubject } from "@cut/geo";
import { linear } from "@cut/motion";

timeline main(duration: 1s, fps: 4, width: 240px, height: 135px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MapCamera() {
      Route(
        points: [
          { latitude: 0, longitude: -60 },
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 60 }
        ],
        color: #16324f,
        width: 3px
      );
      RouteSubject(
        points: [
          { latitude: 0, longitude: -60 },
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 60 }
        ],
        progress: 0%,
        color: #ff00ff,
        radius: 6px,
        opacity: 100%
      ) as departing;
      RouteSubject(
        points: [
          { latitude: 0, longitude: -60 },
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 60 }
        ],
        progress: 0%,
        color: #00ffff,
        radius: 5px,
        opacity: 0%
      ) as arriving;
      animate departing.progress from 0% to 100% over 1s ease linear;
      animate arriving.progress from 0% to 100% over 1s ease linear;
      animate departing.opacity from 100% to 0% over 250ms delay 250ms ease linear;
      animate arriving.opacity from 0% to 100% over 250ms delay 500ms ease linear;
    }
  }
}

export out = render(main, width: 240px, height: 135px, codec: "h264");`;

function compile(program = source) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((entry) => entry.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  const loaded = loadCutAvIr(JSON.stringify(ir));
  const session = validateReferenceSession(loaded);
  const camera = Object.values(loaded.nodes).find((node) => node.op === "cut.geo.map_camera");
  assert.ok(camera);
  const config = validateReferenceMapCameraGraph(loaded, session.composition).get(camera.id);
  assert.ok(config);
  return { ir: loaded, session, camera, config };
}

function subjectEvidence(frame: Awaited<ReturnType<typeof renderReferenceMapCameraFrame>>) {
  const child = frame.children.find((entry) => entry.kind === "route-subject");
  assert.ok(child);
  assert.ok(child.routeSubject);
  return child;
}

function coordinate(latitudeNumerator: number, longitudeNumerator: number, denominator = 1) {
  return {
    kind: "object" as const,
    entries: {
      latitude: {
        kind: "quantity" as const,
        dimension: "scalar" as const,
        unit: "scalar" as const,
        magnitude: rational(latitudeNumerator, denominator),
      },
      longitude: {
        kind: "quantity" as const,
        dimension: "scalar" as const,
        unit: "scalar" as const,
        magnitude: rational(longitudeNumerator, denominator),
      },
    },
  };
}

function routeSubjectNode(ir: ReturnType<typeof compile>["ir"]) {
  const subject = Object.values(ir.nodes).find((node) => node.op === "cut.geo.route_subject");
  assert.ok(subject);
  return subject;
}

test("RouteSubject is one closed public MapCamera child with typed animated properties", () => {
  const symbol = packageSymbol("@cut/geo", "RouteSubject");
  assert.ok(symbol);
  assert.deepEqual(symbol.parameters?.map((entry) => [entry.name, entry.type, Boolean(entry.optional)]), [
    ["points", "List<GeoPoint>", false],
    ["progress", "Ratio", true],
    ["color", "Color", true],
    ["radius", "Length", true],
    ["opacity", "Ratio", true],
  ]);
  const { ir, camera, config } = compile();
  assert.deepEqual(camera.children.map((id) => ir.nodes[id]!.op), ["cut.geo.route", "cut.geo.route_subject"]);
  const subject = config.children.find((entry) => entry.kind === "route-subject");
  assert.ok(subject?.routeSubject);
  assert.equal(subject.routeSubject.algorithmVersion, referenceMapCameraRouteSubjectAlgorithmVersion);
  assert.equal(subject.routeSubject.distanceAlgorithm, "d3-geo@3.1.1.geoDistance");
  assert.equal(subject.routeSubject.metric, "cumulative-spherical-great-circle-angular-distance");
  assert.equal(subject.routeSubject.interpolation, "d3-geo-geoInterpolate");
  assert.equal(subject.routeSubject.segments, 2);
  assert.equal(subject.routeSubject.exactFrameSamples, 4);
  assert.equal(subject.routeSubject.segmentAngularDistancesRadians.length, 2);
  assert.ok(subject.routeSubject.segmentAngularDistancesRadians.every((distance) => Math.abs(distance - Math.PI / 3) < 1e-12));
  assert.ok(Math.abs(subject.routeSubject.totalAngularDistanceRadians - 2 * Math.PI / 3) < 1e-12);
  assert.deepEqual(config.validation, {
    exactSamples: 4,
    activeChildIds: config.validation.activeChildIds,
    distinctCameraStates: 1,
    routeSubjectSegments: 2,
    routeSubjectSegmentFrameEvaluations: 8,
    routeSubjectSegmentFrameEvaluationLimit: referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations,
  });
});

test("RouteSubject seeks directly by great-circle progress and repeats exact bytes", async () => {
  const { ir, session, config } = compile();
  const middle = await renderReferenceMapCameraFrame(ir, session.composition, config, rational(1, 2));
  const start = await renderReferenceMapCameraFrame(ir, session.composition, config, rational(0));
  const replay = await renderReferenceMapCameraFrame(ir, session.composition, config, rational(1, 2));
  const startSubject = subjectEvidence(start), middleSubject = subjectEvidence(middle), replaySubject = subjectEvidence(replay);

  assert.equal(startSubject.routeSubject!.progress, 0);
  assert.equal(startSubject.routeSubject!.segmentIndex, 0);
  assert.equal(startSubject.routeSubject!.segmentProgress, 0);
  assert.ok(Math.abs(startSubject.routeSubject!.geographicPoint.longitude + 60) < 1e-9);
  assert.equal(middleSubject.routeSubject!.progress, 0.5);
  assert.equal(middleSubject.routeSubject!.segmentIndex, 0);
  assert.ok(Math.abs(middleSubject.routeSubject!.segmentProgress - 1) < 1e-9);
  assert.ok(Math.abs(middleSubject.routeSubject!.geographicPoint.longitude) < 1e-9);
  assert.deepEqual(middleSubject.routeSubject, replaySubject.routeSubject);
  assert.equal(middleSubject.routeSubject!.distanceAlgorithm, "d3-geo@3.1.1.geoDistance");
  assert.equal(middleSubject.routeSubject!.segments, 2);
  assert.equal(middleSubject.routeSubject!.exactFrameSamples, 4);
  assert.equal(middleSubject.routeSubject!.segmentFrameEvaluations, 8);
  assert.equal(middleSubject.routeSubject!.segmentFrameEvaluationLimit, 4_000_000);
  assert.equal(middle.counters.routeSubjectSegments, 2);
  assert.equal(middle.counters.routeSubjectSegmentFrameEvaluations, 8);
  assert.equal(middle.counters.routeSubjectSegmentFrameEvaluationLimit, referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations);
  assert.equal(middle.surface.sha256, replay.surface.sha256);
  assert.deepEqual(middle.surface.data, replay.surface.data);
  assert.notEqual(start.surface.sha256, middle.surface.sha256);
  assert.deepEqual(middleSubject.screenSpace.radii, [6]);
});

test("completed frame counters correlate only the active staggered RouteSubject receipts", async () => {
  const { ir, session, config } = compile(staggeredSubjectsSource);
  assert.equal(config.validation.routeSubjectSegments, 4, "planner retains the composition-wide admission total");
  assert.equal(config.validation.routeSubjectSegmentFrameEvaluations, 16);

  const departing = await renderReferenceMapCameraFrame(ir, session.composition, config, rational(0));
  const arriving = await renderReferenceMapCameraFrame(ir, session.composition, config, rational(3, 4));
  for (const frame of [departing, arriving]) {
    const subjects = frame.children.filter((entry) => entry.kind === "route-subject");
    assert.equal(subjects.length, 1, "only one staggered subject is active in this completed frame");
    assert.equal(subjects[0]!.routeSubject?.segments, 2);
    assert.equal(subjects[0]!.routeSubject?.segmentFrameEvaluations, 8);
    assert.equal(frame.counters.routeSubjectSegments, 2);
    assert.equal(frame.counters.routeSubjectSegmentFrameEvaluations, 8);
    assert.equal(
      validateReferenceMapCameraFrameEvidenceSemantics(frame),
      frame,
      "active frame counters must correlate with the adjacent child receipt",
    );
  }
  assert.notEqual(
    departing.children.find((entry) => entry.kind === "route-subject")?.nodeId,
    arriving.children.find((entry) => entry.kind === "route-subject")?.nodeId,
    "the regression must exercise two different active RouteSubject owners",
  );
});

test("RouteSubject evidence closes current frame-v2 schema without reopening historical kinds", async () => {
  const { ir } = compile();
  const root = await mkdtemp(resolve(tmpdir(), "cut-route-subject-frame-"));
  try {
    const output = resolve(root, "subject.png");
    const manifest = await renderReferenceFrameArtifact(ir, root, output, { frame: 2, mediaProfile: "master" });
    const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
    const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
    const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
    assert.equal(validate(persisted), true, JSON.stringify(validate.errors));
    assert.equal(manifest.execution.mapCameras[0]!.version, 5);
    assert.equal(manifest.execution.mapCameras[0]!.retainedGeoPass.version, 5);
    assert.equal(manifest.execution.mapCameras[0]!.retainedGeoPass.cameraAlgorithmVersion, referenceMapCameraAlgorithmVersion);
    assert.equal(manifest.execution.mapCameras[0]!.retainedGeoPass.algorithmVersion, referenceMapCameraFinalSpaceRasterAlgorithmVersion);
    assert.equal(
      validateReferenceMapCameraFrameEvidenceSemantics(manifest.execution.mapCameras[0]!.retainedGeoPass),
      manifest.execution.mapCameras[0]!.retainedGeoPass,
    );
    const subject = manifest.execution.mapCameras[0]!.retainedGeoPass.children.find((entry) => entry.kind === "route-subject");
    assert.ok(subject);
    assert.equal(subject?.routeSubject?.algorithmVersion, referenceMapCameraRouteSubjectAlgorithmVersion);
    assert.equal(subject?.routeSubject?.distanceAlgorithm, "d3-geo@3.1.1.geoDistance");
    assert.equal(subject?.routeSubject?.segmentFrameEvaluations, 8);

    const legalLargeSampleCount = structuredClone(persisted);
    const legalLargeSubject = legalLargeSampleCount.execution.mapCameras[0].retainedGeoPass.children
      .find((entry: { kind: string }) => entry.kind === "route-subject");
    legalLargeSubject.routeSubject.exactFrameSamples = 5_000;
    legalLargeSubject.routeSubject.segmentFrameEvaluations = 10_000;
    legalLargeSampleCount.execution.mapCameras[0].retainedGeoPass.counters.routeSubjectSegmentFrameEvaluations = 10_000;
    assert.equal(validate(legalLargeSampleCount), true, JSON.stringify(validate.errors));
    assert.equal(
      validateReferenceMapCameraFrameEvidenceSemantics(legalLargeSampleCount.execution.mapCameras[0].retainedGeoPass),
      legalLargeSampleCount.execution.mapCameras[0].retainedGeoPass,
      "a legal exact-frame sample count above 4096 must remain admitted",
    );

    const forgedChildWork = structuredClone(persisted);
    const forgedSubject = forgedChildWork.execution.mapCameras[0].retainedGeoPass.children
      .find((entry: { kind: string }) => entry.kind === "route-subject");
    forgedSubject.routeSubject.segmentFrameEvaluations = 7;
    assert.equal(validate(forgedChildWork), true, "shape schema delegates multiplication to the semantic validator");
    assert.throws(
      () => validateReferenceMapCameraFrameEvidenceSemantics(forgedChildWork.execution.mapCameras[0].retainedGeoPass),
      /CUT_MAP_CAMERA_FRAME_EVIDENCE: RouteSubject .* does not correlate/u,
    );

    const forgedAggregateWork = structuredClone(persisted);
    forgedAggregateWork.execution.mapCameras[0].retainedGeoPass.counters.routeSubjectSegmentFrameEvaluations = 7;
    assert.equal(validate(forgedAggregateWork), true, "shape schema delegates child aggregation to the semantic validator");
    assert.throws(
      () => validateReferenceMapCameraFrameEvidenceSemantics(forgedAggregateWork.execution.mapCameras[0].retainedGeoPass),
      /CUT_MAP_CAMERA_FRAME_EVIDENCE: aggregate RouteSubject work counters do not correlate/u,
    );

    const missingWorkCounter = structuredClone(persisted);
    delete missingWorkCounter.execution.mapCameras[0].retainedGeoPass.counters.routeSubjectSegmentFrameEvaluations;
    assert.equal(validate(missingWorkCounter), false, "current v5 receipts require bounded RouteSubject segment-frame work");

    const widenedWorkLimit = structuredClone(persisted);
    widenedWorkLimit.execution.mapCameras[0].retainedGeoPass.counters.routeSubjectSegmentFrameEvaluationLimit = 4_000_001;
    assert.equal(validate(widenedWorkLimit), false, "current v5 receipts pin the exact RouteSubject work ceiling");

    const historicalV3 = structuredClone(persisted);
    const historicalWrapper = historicalV3.execution.mapCameras[0];
    historicalWrapper.version = 3;
    historicalWrapper.cacheStatus = "renderer-frame-memo-only-no-persistent-map-camera-cache";
    historicalWrapper.retainedGeoPass.version = 3;
    historicalWrapper.retainedGeoPass.cacheStatus = "renderer-frame-memo-only-no-persistent-map-camera-cache";
    historicalWrapper.retainedGeoPass.algorithmVersion = "cut-reference-map-camera-final-space-render-v4";
    historicalWrapper.retainedGeoPass.cameraAlgorithmVersion = "cut-reference-map-camera-v3";
    delete historicalWrapper.retainedGeoPass.canonicalRasterCache;
    historicalWrapper.retainedGeoPass.children = historicalWrapper.retainedGeoPass.children.filter((entry: { kind: string }) => entry.kind !== "route-subject");
    delete historicalWrapper.retainedGeoPass.counters.routeSubjectSegments;
    delete historicalWrapper.retainedGeoPass.counters.routeSubjectSegmentFrameEvaluations;
    delete historicalWrapper.retainedGeoPass.counters.routeSubjectSegmentFrameEvaluationLimit;
    delete historicalWrapper.counters.invocationCanonicalRasterCacheHits;
    delete historicalWrapper.counters.invocationCanonicalRasterCacheMisses;
    delete historicalWrapper.counters.invocationCanonicalRasterCacheBypasses;
    assert.equal(validate(historicalV3), true, JSON.stringify(validate.errors));

    const reopenedV3 = structuredClone(historicalV3);
    reopenedV3.execution.mapCameras[0].retainedGeoPass.children.push(structuredClone(subject));
    assert.equal(validate(reopenedV3), false, "frozen v3 retained evidence must reject RouteSubject");

    const mismatchedWrapper = structuredClone(persisted);
    mismatchedWrapper.execution.mapCameras[0].version = 3;
    assert.equal(validate(mismatchedWrapper), false, "a public v3 wrapper cannot conceal a retained v5 pass");

    const mismatchedRetainedPass = structuredClone(historicalV3);
    mismatchedRetainedPass.execution.mapCameras[0].version = 5;
    assert.equal(validate(mismatchedRetainedPass), false, "a public v5 wrapper cannot relabel a historical retained v3 pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RouteSubject fails source-located for context, labeled coordinates, unknown inputs, constant signals, invisible paint, and every zero-length segment", () => {
  const standalone = parseCutLanguage(source.replace("    MapCamera() {", "    RouteSubject(points: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }]);\n    MapCamera() {"));
  assert.ok(standalone.module);
  assert.ok(checkCutModule(standalone.module).diagnostics.some((entry) => entry.code === "CUT_MAP_CAMERA_CONTEXT" && entry.span.start.line > 0));

  const unknown = parseCutLanguage(source.replace("        radius: 6px,", "        radius: 6px,\n        size: 8px,"));
  assert.ok(unknown.module);
  const unknownDiagnostic = checkCutModule(unknown.module).diagnostics.find((entry) => entry.severity === "error" && /size/u.test(entry.message));
  assert.ok(unknownDiagnostic);
  assert.ok(unknownDiagnostic.span.start.line > 0);

  const labeled = parseCutLanguage(source.replace(
    `          { latitude: 0, longitude: -60 },
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 60 }
        ],
        progress:`,
    `          { latitude: 0, longitude: -60, label: "start" },
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 60 }
        ],
        progress:`,
  ));
  assert.ok(labeled.module);
  const labeledDiagnostic = checkCutModule(labeled.module).diagnostics.find((entry) => entry.code === "CUT_MAP_CAMERA_CHILD" && /unlabeled coordinates/u.test(entry.message));
  assert.ok(labeledDiagnostic);
  assert.ok(labeledDiagnostic.span.start.line > 0);

  const constant = compile();
  const constantSubject = Object.values(constant.ir.nodes).find((node) => node.op === "cut.geo.route_subject");
  assert.ok(constantSubject);
  const progressProperty = constantSubject.properties.progress;
  assert.ok(progressProperty && "signal" in progressProperty);
  const progressSignal = constant.ir.signals[progressProperty.signal];
  assert.ok(progressSignal?.kind === "track");
  const twentyPercent = {
    kind: "quantity" as const,
    dimension: "ratio" as const,
    unit: "ratio" as const,
    magnitude: rational(1, 5),
  };
  constantSubject.inputs.progress = twentyPercent;
  progressSignal.initial = twentyPercent;
  progressSignal.events = progressSignal.events.map((event) => event.kind === "animate"
    ? { ...event, from: twentyPercent, to: twentyPercent }
    : { ...event, value: twentyPercent });
  assert.throws(
    () => validateReferenceMapCameraGraph(constant.ir, constant.session.composition),
    (error: unknown) => error instanceof ReferenceMapCameraError
      && error.code === "CUT_MAP_CAMERA_NOOP"
      && error.source.line > 0
      && /progress/u.test(error.message)
      && /constant/u.test(error.message),
  );

  const executing = compile().ir;
  const repeatedSegment = structuredClone(executing);
  routeSubjectNode(repeatedSegment).inputs.points = {
    kind: "array",
    items: [coordinate(0, -60), coordinate(0, -60), coordinate(0, 60)],
  };
  assert.throws(
    () => validateReferenceMapCameraGraph(repeatedSegment, repeatedSegment.compositions[0]!),
    (error: unknown) => error instanceof ReferenceMapCameraError
      && error.code === "CUT_MAP_CAMERA_NOOP"
      && error.source.line > 0
      && /segment 0 has zero spherical length/u.test(error.message),
  );

  const antimeridianAlias = structuredClone(executing);
  routeSubjectNode(antimeridianAlias).inputs.points = {
    kind: "array",
    items: [coordinate(0, -180), coordinate(0, 180)],
  };
  assert.throws(
    () => validateReferenceMapCameraGraph(antimeridianAlias, antimeridianAlias.compositions[0]!),
    (error: unknown) => error instanceof ReferenceMapCameraError
      && error.code === "CUT_MAP_CAMERA_NOOP"
      && error.source.line > 0
      && /segment 0 has zero spherical length/u.test(error.message),
  );

  const northPoleAlias = structuredClone(executing);
  routeSubjectNode(northPoleAlias).inputs.points = {
    kind: "array",
    items: [coordinate(90, -120), coordinate(90, 75)],
  };
  assert.throws(
    () => validateReferenceMapCameraGraph(northPoleAlias, northPoleAlias.compositions[0]!),
    (error: unknown) => error instanceof ReferenceMapCameraError
      && error.code === "CUT_MAP_CAMERA_NOOP"
      && error.source.line > 0
      && /segment 0 has zero spherical length/u.test(error.message),
  );

  const southPoleAlias = structuredClone(executing);
  routeSubjectNode(southPoleAlias).inputs.points = {
    kind: "array",
    items: [coordinate(-90, -75), coordinate(-90, 140)],
  };
  assert.throws(
    () => validateReferenceMapCameraGraph(southPoleAlias, southPoleAlias.compositions[0]!),
    (error: unknown) => error instanceof ReferenceMapCameraError
      && error.code === "CUT_MAP_CAMERA_NOOP"
      && error.source.line > 0
      && /segment 0 has zero spherical length/u.test(error.message),
  );

  const transparent = structuredClone(executing);
  routeSubjectNode(transparent).inputs.color = { kind: "color", value: "#ff00ff00" };
  assert.throws(
    () => validateReferenceMapCameraGraph(transparent, transparent.compositions[0]!),
    (error: unknown) => error instanceof ReferenceMapCameraError
      && error.code === "CUT_MAP_CAMERA_NOOP"
      && error.source.line > 0
      && /fully transparent/u.test(error.message),
  );
});

test("hostile IR loader closes RouteSubject shape, per-node, per-camera, and segment-frame work limits", () => {
  const { ir } = compile();
  const subject = routeSubjectNode(ir);
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.geo.map_camera");
  assert.ok(camera);
  assert.ok(subject.sceneId);

  const orphan = structuredClone(ir);
  orphan.nodes[camera.id]!.children = orphan.nodes[camera.id]!.children.filter((id) => id !== subject.id);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(orphan)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_IDENTITY"
      && error.path.endsWith(".ownership")
      && /child node must have a parent/u.test(error.message),
  );

  const malformed = structuredClone(ir);
  routeSubjectNode(malformed).inputs.points = { kind: "string", value: "not-a-route" };
  finalizeGraphHashes(malformed);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(malformed)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TYPE"
      && error.path.endsWith(".inputs.points")
      && /inline array/u.test(error.message),
  );

  const oversized = structuredClone(ir);
  routeSubjectNode(oversized).inputs.points = {
    kind: "array",
    items: Array.from({ length: 4_097 }, (_, index) => coordinate(index, 0, 10_000)),
  };
  finalizeGraphHashes(oversized);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(oversized)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_LIMIT"
      && error.path.endsWith(".inputs.points")
      && /2 through 4096 entries/u.test(error.message),
  );

  const labeled = structuredClone(ir);
  const labeledPoints = routeSubjectNode(labeled).inputs.points;
  if (labeledPoints.kind !== "array") assert.fail("compiled RouteSubject points must be an array");
  const first = labeledPoints.items[0];
  if (!first || first.kind !== "object") assert.fail("compiled RouteSubject point must be an object");
  first.entries.label = { kind: "string", value: "hostile label" };
  finalizeGraphHashes(labeled);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(labeled)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_UNKNOWN_FIELD"
      && error.path.endsWith(".entries.label")
      && /exactly latitude and longitude/u.test(error.message),
  );

  const forgedAngle = structuredClone(ir);
  const forgedAnglePoints = routeSubjectNode(forgedAngle).inputs.points;
  if (forgedAnglePoints.kind !== "array") assert.fail("compiled RouteSubject points must be an array");
  const forgedAnglePoint = forgedAnglePoints.items[0];
  if (!forgedAnglePoint || forgedAnglePoint.kind !== "object") assert.fail("compiled RouteSubject point must be an object");
  forgedAnglePoint.entries.latitude = {
    kind: "quantity",
    dimension: "angle",
    unit: "deg",
    magnitude: rational(0),
  };
  finalizeGraphHashes(forgedAngle);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(forgedAngle)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TYPE"
      && error.path.endsWith(".entries.latitude")
      && /canonical scalar quantity/u.test(error.message),
  );

  const aggregate = structuredClone(ir);
  const aggregateCamera = Object.values(aggregate.nodes).find((node) => node.op === "cut.geo.map_camera");
  const aggregateSubject = routeSubjectNode(aggregate);
  assert.ok(aggregateCamera);
  const maximumRoute = Array.from({ length: 4_096 }, (_, index) => coordinate(index, 0, 10_000));
  aggregateSubject.inputs.points = { kind: "array", items: maximumRoute };
  for (let index = 1; index < 16; index += 1) {
    const clone = structuredClone(aggregateSubject);
    clone.id = `route_subject_aggregate_${index}`;
    clone.inputs.points = { kind: "array", items: structuredClone(maximumRoute) };
    clone.inputs.progress = { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(1, 2) };
    clone.inputs.opacity = { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(1, 2) };
    clone.properties = {};
    aggregate.nodes[clone.id] = clone;
    aggregateCamera.children.push(clone.id);
  }
  finalizeGraphHashes(aggregate);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(aggregate)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_LIMIT"
      && error.path.endsWith(".children")
      && /65536-point camera limit/u.test(error.message),
  );

  const excessiveWork = structuredClone(ir);
  routeSubjectNode(excessiveWork).inputs.points = {
    kind: "array",
    items: Array.from({ length: 4_096 }, (_, index) => coordinate(index, 0, 10_000)),
  };
  excessiveWork.compositions[0]!.fps = rational(1_000);
  assert.equal(4_095 * 1_000, 4_095_000);
  assert.ok(4_096 <= referenceMapCameraLimits.maximumAuthoredGeoPointsPerCamera);
  assert.ok(1_000 <= referenceMapCameraLimits.maximumValidationSamplesPerComposition);
  assert.throws(
    () => validateReferenceMapCameraGraph(excessiveWork, excessiveWork.compositions[0]!),
    (error: unknown) => error instanceof ReferenceMapCameraError
      && error.code === "CUT_MAP_CAMERA_LIMIT"
      && error.source.line > 0
      && /4095000 segment × exact-frame evaluations/u.test(error.message)
      && /4000000/u.test(error.message),
  );
});

test("an unrelated portrait MapCamera uses the same rule with stable out-of-order seeking", async () => {
  const { ir, session, config } = compile(portraitSource);
  const late = await renderReferenceMapCameraFrame(ir, session.composition, config, rational(3, 2));
  const early = await renderReferenceMapCameraFrame(ir, session.composition, config, rational(1, 2));
  const lateReplay = await renderReferenceMapCameraFrame(ir, session.composition, config, rational(3, 2));
  assert.notEqual(early.surface.sha256, late.surface.sha256);
  assert.equal(late.surface.sha256, lateReplay.surface.sha256);
  assert.equal(subjectEvidence(late).routeSubject!.algorithmVersion, referenceMapCameraRouteSubjectAlgorithmVersion);
  assert.equal(subjectEvidence(early).routeSubject!.metric, "cumulative-spherical-great-circle-angular-distance");
  assert.equal(hash(subjectEvidence(late).routeSubject), hash(subjectEvidence(lateReplay).routeSubject));
  assert.equal(createHash("sha256").update(late.surface.data).digest("hex"), late.surface.sha256);
});
