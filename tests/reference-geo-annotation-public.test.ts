import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { rational } from "../lib/language/rational";
import { inspectCutIr } from "../lib/runtime/inspect";
import { ReferenceGeoAnnotationError, referenceGeoAnnotationRectsCollide, validateReferenceGeoAnnotationGraph } from "../lib/runtime/reference/geo-annotation";
import { referenceParallaxCameraPlanAt, validateReferenceParallaxCameraGraph } from "../lib/runtime/reference/parallax-camera";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function source(options: { fill?: string; mapScale?: string; childX?: string; opacity?: string } = {}) {
  return `cut 0.4;
project "public GeoAnnotation renderer proof";
import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";
import { GeoAnnotation, Map } from "@cut/geo";
timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) {
      DepthLayer(depth: 100px, edge: "transparent") {
        Map(${options.mapScale ? `scale: ${options.mapScale}` : ""});
        GeoAnnotation(
          anchor: { latitude: 0, longitude: 0 },
          width: 48px,
          height: 20px,
          placements: ["right"],
          offset: 6px,
          safeArea: 8px,
          leader: "straight",
          leaderColor: #f8fafc,
          leaderWidth: 2px${options.opacity ? `,
          opacity: ${options.opacity}` : ""}
        ) {
          Rect(width: 48px, height: 20px, x: ${options.childX ?? "96px"}, y: 64px, fill: ${options.fill ?? "#f59e0b"});
        }
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        Circle(x: 20px, y: 20px, radius: 4px, fill: #2563eb);
      }
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function dynamicOpacitySource() {
  return `cut 0.4;
project "GeoAnnotation RGBA8 fade boundary proof";
import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";
import { GeoAnnotation, Map } from "@cut/geo";
import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) {
      DepthLayer(depth: 100px, edge: "transparent") {
        Map();
        GeoAnnotation(anchor: { latitude: 0, longitude: 0 }, width: 48px, height: 20px, placements: ["right"], offset: 6px, safeArea: 8px, leader: "none", opacity: 0.1%) as note {
          Rect(width: 48px, height: 20px, x: 96px, y: 64px, fill: #f59e0b);
        }
        animate note.opacity from 0.1% to 0.3% over 1s ease linear;
      }
      DepthLayer(depth: 0px, edge: "transparent") { Circle(x: 20px, y: 20px, radius: 4px, fill: #2563eb); }
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function multiAnnotationSource() {
  return `cut 0.4;
project "public GeoAnnotation collision proof";
import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";
import { GeoAnnotation, Map } from "@cut/geo";
timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) {
      DepthLayer(depth: 100px, edge: "transparent") {
        Map();
        GeoAnnotation(anchor: { latitude: 0, longitude: 0 }, width: 48px, height: 20px, placements: ["right", "left"], offset: 6px, safeArea: 8px, leader: "none") {
          Rect(width: 48px, height: 20px, x: 96px, y: 64px, fill: #10b981);
        }
        GeoAnnotation(anchor: { latitude: 0, longitude: 0 }, width: 48px, height: 20px, placements: ["right"], offset: 6px, safeArea: 8px, priority: 10, leader: "none") {
          Rect(width: 48px, height: 20px, x: 96px, y: 64px, fill: #f59e0b);
        }
      }
      DepthLayer(depth: 0px, edge: "transparent") { Circle(x: 20px, y: 20px, radius: 4px, fill: #2563eb); }
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function offscreenSource() {
  return `cut 0.4;
project "public GeoAnnotation offscreen proof";
import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";
import { GeoAnnotation, Map } from "@cut/geo";
import { linear } from "@cut/motion";
timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) as camera {
      DepthLayer(depth: 100px, edge: "transparent") {
        Map();
        GeoAnnotation(anchor: { latitude: 0, longitude: 0 }, width: 48px, height: 20px, placements: ["right"], offset: 6px, safeArea: 8px, leader: "none") {
          Rect(width: 8px, height: 8px, x: 180px, y: 120px, fill: #f59e0b);
        }
      }
      DepthLayer(depth: 0px, edge: "transparent") { Circle(x: 20px, y: 20px, radius: 4px, fill: #2563eb); }
    }
    animate camera.x from 0px to 600px over 1s ease linear;
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function nestedAnnotationSource() {
  return `cut 0.4;
project "nested GeoAnnotation evidence proof";
import { ParallaxCamera, DepthLayer, Rect, Circle, Precomp } from "cut:visual";
import { GeoAnnotation, Map } from "@cut/geo";
timeline insert(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene nested(duration: 1s) {
    ParallaxCamera(focalLength: 100px) {
      DepthLayer(depth: 100px, edge: "transparent") {
        Map();
        GeoAnnotation(anchor: { latitude: 0, longitude: 0 }, width: 48px, height: 20px, placements: ["right"], offset: 6px, safeArea: 8px, leader: "none") {
          Rect(width: 48px, height: 20px, x: 96px, y: 64px, fill: #f59e0b);
        }
      }
      DepthLayer(depth: 0px, edge: "transparent") { Circle(x: 20px, y: 20px, radius: 4px, fill: #2563eb); }
    }
  }
}
timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene host(duration: 1s) { Precomp(source: insert); }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function repeatedNestedAnnotationSource() {
  return nestedAnnotationSource().replace(
    'scene host(duration: 1s) { Precomp(source: insert); }',
    'scene host(duration: 1s) { Precomp(source: insert); Precomp(source: insert); }',
  );
}

function legacyParallaxSource() {
  return `cut 0.4;
project "GeoAnnotation legacy parallax byte fixture";
import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 64px, height: 48px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 80px) {
      DepthLayer(depth: 80px, edge: "transparent") {
        Rect(width: 32px, height: 20px, x: 20px, y: 18px, fill: #f59e0b);
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        Circle(x: 42px, y: 28px, radius: 7px, fill: #2563eb);
      }
    }
  }
}
export out = render(main, width: 64px, height: 48px, codec: "h264");`;
}

function compile(program = source()) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  return { ir, session: validateReferenceSession(ir) };
}

async function render(program = source(), frameIndex = 0, includeDeliveryBackground = false) {
  const { ir, session } = compile(program);
  const root = await mkdtemp(resolve(tmpdir(), "cut-geo-annotation-"));
  const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, ".cut-cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[session.composition.sceneIds[0]];
    const frame = await renderer.sceneFrame(scene, frameIndex, includeDeliveryBackground);
    return { frame, evidence: renderer.referenceGeoAnnotationEvidence() };
  } finally {
    await renderer.closeAndWait();
  }
}

function rgba(frame: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * frame.width + x) * 4;
  return [...frame.data.subarray(offset, offset + 4)];
}

test("public GeoAnnotation executes collision, fixed crop, leader, overlay pixels, and same-renderer evidence", async () => {
  const rendered = await render();
  assert.equal(rendered.evidence.length, 1);
  const evidence = rendered.evidence[0];
  assert.equal(evidence.format, "cut-reference-geo-annotation-frame-decisions");
  assert.equal(evidence.version, 1);
  assert.equal(evidence.decisions.length, 1);
  const decision = evidence.decisions[0];
  assert.equal(decision.status, "accepted");
  assert.equal(decision.chosenPlacement, "right");
  assert.equal(decision.paintOrder, 0);
  assert.ok(decision.rect);
  assert.deepEqual({ width: decision.rect.width, height: decision.rect.height }, { width: 48, height: 20 });
  assert.ok(decision.visibleAlpha && decision.visibleAlpha.visiblePixels > 0);
  assert.equal(decision.visibleAlpha?.maximum, 255);
  const childPixel = rgba(rendered.frame, decision.rect.left + 4, decision.rect.top + 4);
  assert.ok(childPixel[0] > 200 && childPixel[1] > 100 && childPixel[2] < 80 && childPixel[3] === 255, String(childPixel));
  const leaderMidX = Math.round((decision.exactAnchor.x + decision.rect.left) / 2);
  const leaderPixel = rgba(rendered.frame, leaderMidX, Math.round(decision.exactAnchor.y));
  assert.ok(leaderPixel[0] > 190 && leaderPixel[1] > 190 && leaderPixel[2] > 190 && leaderPixel[3] > 0, String(leaderPixel));
});

test("no-annotation ParallaxCamera keeps frozen RGBA while current alpha package identity remains deterministic", async () => {
  const program = legacyParallaxSource();
  const rendered = await render(program, 0, true);
  assert.deepEqual(rendered.evidence, []);
  assert.equal(createHash("sha256").update(rendered.frame.data).digest("hex"), "5f4075f8e5f10d4c7cc7f23a79c4e627a64499abf5a904c0fd2761c265e56df5");
  const planIdentity = () => {
    const { ir, session } = compile(program);
    const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.parallax_camera")!;
    const config = validateReferenceParallaxCameraGraph(ir, session.composition).get(camera.id)!;
    return referenceParallaxCameraPlanAt(ir, session.composition, config, rational(0)).cacheIdentity;
  };
  // The old alpha cache key belongs to its frozen package/runtime. Adding a
  // public built-in intentionally rekeys the current package implementation;
  // it must not be relabelled as the historical identity. Current compilation
  // remains deterministic, while the immutable release verifier owns replay of
  // the old key.
  assert.match(planIdentity(), /^[a-f0-9]{64}$/);
  assert.equal(planIdentity(), planIdentity());
});

test("decision identity binds the complete ordinary child semantic graph", async () => {
  const amber = await render(source({ fill: "#f59e0b" }));
  const green = await render(source({ fill: "#10b981" }));
  assert.notEqual(amber.evidence[0].decisionIdentity, green.evidence[0].decisionIdentity);
});

test("annotation child edits produce field-level semantic diff and localized transitive cache misses", () => {
  const before = compile(source({ fill: "#f59e0b" }));
  const after = compile(source({ fill: "#10b981" }));
  const child = Object.values(after.ir.nodes).find((node) => node.op === "cut.visual.rect" && node.inputs.fill?.kind === "color" && node.inputs.fill.value === "#10b981")!;
  const change = diffCutAVIR(before.ir, after.ir).changes.find((item) => item.entity === "node" && item.id === child.id);
  assert.ok(change && change.operation === "modify");
  if (change.operation === "modify") assert.deepEqual(change.fields, [{ path: "/inputs/fill/value", before: "#f59e0b", after: "#10b981" }]);
  const previous = createIncrementalRenderPlan(before.ir, before.session.composition.id).manifest;
  const incremental = createIncrementalRenderPlan(after.ir, after.session.composition.id, previous);
  const status = (op: string) => incremental.nodes.find((entry) => after.ir.nodes[entry.id]?.op === op)?.status;
  assert.equal(status("cut.visual.rect"), "miss");
  assert.equal(status("cut.geo.annotation"), "miss");
  assert.equal(status("cut.visual.parallax_camera"), "miss");
  assert.equal(status("cut.visual.circle"), "hit", "an unrelated depth-plane leaf must remain reusable");
  assert.deepEqual(incremental.scenes.map((scene) => scene.status), ["miss"]);
});

test("visible-alpha evidence describes post-opacity RGBA8 pixels and refuses positive opacity that quantizes away", async () => {
  const half = await render(source({ opacity: "50%" }));
  const alpha = half.evidence[0].decisions[0].visibleAlpha!;
  assert.equal(alpha.sourceMaximum, 255);
  assert.equal(alpha.maximum, 128);
  assert.equal(alpha.visiblePixels, alpha.sourceVisiblePixels);
  await assert.rejects(
    () => render(source({ opacity: "0.1%" })),
    (error: unknown) => error instanceof ReferenceGeoAnnotationError
      && error.code === "CUT_GEO_ANNOTATION_NOOP"
      && /never reaches the first fully-opaque RGBA8 visibility step/.test(error.message),
  );
});

test("dynamic annotation fades keep accepted layout stable while exact RGBA8-transparent samples skip overlay work", async () => {
  const early = await render(dynamicOpacitySource(), 0);
  const later = await render(dynamicOpacitySource(), 2);
  const earlyDecision = early.evidence[0].decisions[0];
  const laterDecision = later.evidence[0].decisions[0];
  assert.equal(earlyDecision.status, "accepted");
  assert.equal(laterDecision.status, "accepted");
  assert.deepEqual(earlyDecision.rect, laterDecision.rect, "opacity quantization must not perturb collision/layout state");
  assert.equal(earlyDecision.renderedDecision?.status, "opacity-quantized-transparent");
  assert.deepEqual(earlyDecision.renderedDecision?.work, {
    annotationOverlayPlacements: 0,
    annotationOverlayComposites: 0,
    overlayCanvasPixels: 0,
    overlayCanvasBytes: 0,
  });
  assert.ok((earlyDecision.renderedDecision?.sourceVisiblePixels ?? 0) > 0);
  assert.equal(earlyDecision.visibleAlpha, undefined, "a skipped RGBA8 sample must not claim visible-alpha work");
  assert.equal(laterDecision.renderedDecision?.status, "painted");
  assert.equal(laterDecision.renderedDecision?.work.annotationOverlayComposites, 1);
  assert.equal(laterDecision.visibleAlpha?.maximum, 1);
  assert.notEqual(early.evidence[0].executionIdentity, later.evidence[0].executionIdentity, "execution identity must bind the rendered decision");
});

test("multi-annotation resolution executes fallback, priority counterfactual, half-open touching, and reverse paint", async () => {
  const rendered = await render(multiAnnotationSource());
  const plan = rendered.evidence[0];
  assert.equal(plan.decisions.length, 2);
  const high = plan.decisions.find((decision) => decision.priority === 10)!;
  const low = plan.decisions.find((decision) => decision.priority === 0)!;
  assert.equal(high.status, "accepted");
  assert.equal(high.chosenPlacement, "right");
  assert.equal(high.paintOrder, 1, "high priority must paint last");
  assert.equal(low.status, "accepted");
  assert.equal(low.chosenPlacement, "left");
  assert.equal(low.chosenPlacementIndex, 1, "the authored fallback must execute after collision");
  assert.equal(low.candidates[0].collisionWith, high.nodeId);
  assert.equal(low.paintOrder, 0);
  assert.equal(plan.work.aggregateOverlayCanvasPixels, 2 * 192 * 128 * 6);
  assert.equal(plan.work.aggregateOverlayCanvasBytes, plan.work.aggregateOverlayCanvasPixels * 4);
  assert.equal(referenceGeoAnnotationRectsCollide(
    { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 },
    { left: 10, top: 4, right: 20, bottom: 14, width: 10, height: 10 },
  ), false, "half-open rectangles touching at one edge must not collide");
});

test("loaded IR cannot share one retained child across multiple GeoAnnotations", () => {
  const { ir, session } = compile(multiAnnotationSource());
  const annotations = Object.values(ir.nodes).filter((node) => node.op === "cut.geo.annotation");
  assert.equal(annotations.length, 2);
  annotations[1].children = [annotations[0].children[0]];
  const parallax = validateReferenceParallaxCameraGraph(ir, session.composition);
  assert.throws(
    () => validateReferenceGeoAnnotationGraph(ir, session.composition, parallax),
    (error: unknown) => error instanceof ReferenceGeoAnnotationError
      && error.code === "CUT_GEO_ANNOTATION_GRAPH"
      && /owned directly and exclusively/.test(error.message),
  );
});

test("offscreen anchors omit candidate work and do not raster an otherwise empty child viewport", async () => {
  const rendered = await render(offscreenSource(), 3);
  const decision = rendered.evidence[0].decisions[0];
  assert.equal(decision.status, "hidden");
  assert.equal(decision.reason, "anchor-offscreen");
  assert.deepEqual(decision.candidates, []);
  assert.equal(decision.visibleAlpha, undefined);
  assert.equal(rendered.evidence[0].work.acceptedAnnotations, 0);
  assert.equal(rendered.evidence[0].work.aggregateChildCanvasPixels, 0);
});

test("inspect exposes exact public ownership, viewport, validation, and first-sample decision without opening assets", () => {
  const { ir } = compile();
  const annotation = Object.values(ir.nodes).find((node) => node.op === "cut.geo.annotation")!;
  const inspected = inspectCutIr(ir, "proof.cut") as { graph: { nodes: Array<{ id: string; geoAnnotation?: Record<string, unknown> }> } };
  const value = inspected.graph.nodes.find((node) => node.id === annotation.id)?.geoAnnotation as {
    kind: string;
    viewport: { width: number; height: number; cropLeft: number; cropTop: number };
    validation: { exactSamples: number; fallbackReached: number[]; everAccepted: boolean };
    firstSample: { decisionIdentity: string; decision: { status: string } };
  };
  assert.equal(value.kind, "fixed-map-camera-overlay");
  assert.deepEqual(value.viewport, { width: 48, height: 20, cropLeft: 72, cropTop: 54, coordinateSpace: "ParallaxCamera-output-delivery-pixels" });
  assert.deepEqual(value.validation, { exactSamples: 4, fallbackReached: [0], priorityAffected: false, everAccepted: true });
  assert.equal(value.firstSample.decision.status, "accepted");
  assert.equal(value.firstSample.decisionIdentity.length, 64);
});

test("cut frame v2 publishes same-invocation GeoAnnotation decisions beside the real PNG", async () => {
  const { ir } = compile();
  const root = await mkdtemp(resolve(tmpdir(), "cut-geo-annotation-frame-"));
  const output = resolve(root, "review/frame.png");
  const manifest = await renderReferenceFrameArtifact(ir, root, output, { frame: 0, mediaProfile: "master" });
  assert.equal(manifest.format, "cut-reference-frame");
  assert.equal(manifest.version, 2);
  assert.equal(manifest.execution.geoAnnotations.length, 1);
  assert.equal(manifest.execution.geoAnnotations[0].format, "cut-reference-geo-annotation-frame-decisions");
  assert.ok(manifest.execution.geoAnnotations[0].decisions[0].visibleAlpha?.visiblePixels);
  assert.equal(manifest.execution.geoAnnotations[0].decisions[0].renderedDecision?.status, "painted");
  const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
  assert.equal(persisted.execution.geoAnnotations[0].decisionIdentity, manifest.execution.geoAnnotations[0].decisionIdentity);
  const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  assert.equal(validate(persisted), true, JSON.stringify(validate.errors));
  const hostile = structuredClone(persisted);
  hostile.execution.geoAnnotations[0].silentlyIgnored = true;
  assert.equal(validate(hostile), false, "frame v2 machine evidence must reject unknown nested fields");
  const incompleteAccepted = structuredClone(persisted);
  delete incompleteAccepted.execution.geoAnnotations[0].decisions[0].paintOrder;
  assert.equal(validate(incompleteAccepted), false, "accepted execution evidence must retain its paint order");
  const missingRenderedDecision = structuredClone(persisted);
  delete missingRenderedDecision.execution.geoAnnotations[0].decisions[0].renderedDecision;
  assert.equal(validate(missingRenderedDecision), false, "v2 accepted execution evidence must retain its exact rendered decision");
  const contradictorySkip = structuredClone(persisted);
  contradictorySkip.execution.geoAnnotations[0].decisions[0].renderedDecision = {
    status: "opacity-quantized-transparent",
    sourceVisiblePixels: 1,
    sourceMaximum: 255,
    maximumQuantizedAlpha: 0,
    work: { annotationOverlayPlacements: 0, annotationOverlayComposites: 0, overlayCanvasPixels: 0, overlayCanvasBytes: 0 },
  };
  assert.equal(validate(contradictorySkip), false, "a quantized-transparent rendered decision cannot retain visibleAlpha");
  const historicalV1 = structuredClone(persisted);
  historicalV1.execution.geoAnnotations[0].algorithmVersion = "cut-reference-geo-annotation-map-v1";
  delete historicalV1.execution.geoAnnotations[0].decisions[0].renderedDecision;
  assert.equal(validate(historicalV1), true, JSON.stringify(validate.errors));
  const contradictoryHidden = structuredClone(persisted);
  contradictoryHidden.execution.geoAnnotations[0].decisions[0].status = "hidden";
  contradictoryHidden.execution.geoAnnotations[0].decisions[0].reason = "opacity-zero";
  contradictoryHidden.execution.geoAnnotations[0].decisions[0].candidates = [];
  assert.equal(validate(contradictoryHidden), false, "hidden evidence cannot retain accepted-only raster fields");
  const partialExecutionPath = structuredClone(persisted);
  partialExecutionPath.execution.geoAnnotations[0].executionPath[0].instanceNodeId = "instance-only";
  assert.equal(validate(partialExecutionPath), false, "nested execution path identity fields must appear as a pair");
});

test("outer frame evidence aggregates a nested Precomp renderer with a stable execution path", async () => {
  const { ir } = compile(nestedAnnotationSource());
  const root = await mkdtemp(resolve(tmpdir(), "cut-geo-annotation-nested-frame-"));
  const manifest = await renderReferenceFrameArtifact(ir, root, resolve(root, "review/nested.png"), { frame: 0, mediaProfile: "master" });
  const main = ir.compositions.find((composition) => composition.name === "main")!;
  const insert = ir.compositions.find((composition) => composition.name === "insert")!;
  assert.equal(manifest.execution.geoAnnotations.length, 1);
  const evidence = manifest.execution.geoAnnotations[0];
  assert.equal(evidence.executionPath.length, 2);
  assert.equal(evidence.executionPath[0].compositionId, main.id);
  assert.ok(evidence.executionPath[0].instanceNodeId);
  assert.equal(evidence.executionPath[0].sourceCompositionId, insert.id);
  assert.equal(evidence.executionPath[1].compositionId, insert.id);
  assert.equal(evidence.executionIdentity.length, 64);
  assert.equal(evidence.decisions[0].status, "accepted");
});

test("two instances of one annotated Precomp emit total-ordered byte-stable frame evidence", async () => {
  const { ir } = compile(repeatedNestedAnnotationSource());
  const root = await mkdtemp(resolve(tmpdir(), "cut-geo-annotation-repeat-frame-"));
  const output = resolve(root, "review/repeat.png");
  const first = await renderReferenceFrameArtifact(ir, root, output, { frame: 0, mediaProfile: "master" });
  const firstBytes = await readFile(`${output}.manifest.json`);
  const second = await renderReferenceFrameArtifact(ir, root, output, { frame: 0, mediaProfile: "master" });
  const secondBytes = await readFile(`${output}.manifest.json`);
  assert.equal(first.execution.geoAnnotations.length, 2);
  const identities = first.execution.geoAnnotations.map((item) => item.executionIdentity);
  assert.deepEqual(identities, [...identities].sort(), "evidence must use a total stable key, not concurrent completion order");
  assert.equal(new Set(identities).size, 2, "instance execution paths must disambiguate the same source camera");
  assert.deepEqual(second.execution.geoAnnotations.map((item) => item.executionIdentity), identities);
  assert.deepEqual(secondBytes, firstBytes, "replaying the same exact frame must publish byte-identical JSON evidence");
});

test("a transformed base map sibling fails the fixed shared-projection contract before raster", () => {
  assert.throws(
    () => compile(source({ mapScale: "1.1" })),
    (error: unknown) => error instanceof ReferenceGeoAnnotationError
      && error.code === "CUT_GEO_ANNOTATION_PROJECTION"
      && /non-identity geometry transform/.test(error.message),
  );
});

test("an accepted positive-opacity viewport with no visible child alpha fails source-located", async () => {
  await assert.rejects(
    () => render(source({ childX: "180px" })),
    (error: unknown) => error instanceof ReferenceGeoAnnotationError
      && error.code === "CUT_GEO_ANNOTATION_NOOP"
      && /viewport contains no visible child alpha/.test(error.message),
  );
});
