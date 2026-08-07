import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function source(options: {
  x?: number;
  far?: string;
  focus?: boolean;
  farEdge?: "clamp" | "transparent";
  nearFirst?: boolean;
  ordering?: "source";
} = {}) {
  const x = options.x ?? 24, far = options.far ?? "#f4c35b", focus = options.focus ?? false;
  const farEdge = options.farEdge ?? "clamp";
  const farLayer = `      DepthLayer(depth: 100px, edge: "${farEdge}") {
        Rect(width: 100px, height: 80px, fill: ${far});
        Rect(width: 20px, height: 20px, x: 72px, y: 40px, fill: #d84b45);
      }`;
  const nearLayer = `      DepthLayer(depth: 0px, edge: "transparent") {
        Circle(x: 50px, y: 40px, radius: 6px, fill: #2855d9);
      }`;
  const layers = options.nearFirst ? `${nearLayer}\n${farLayer}` : `${farLayer}\n${nearLayer}`;
  return `cut 0.4;
project "public deterministic 2.5D proof";
import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";
import { linear } from "@cut/motion";

timeline main(duration: 1s, fps: 24, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(
      focalLength: 100px${options.ordering ? `,\n      ordering: "${options.ordering}"` : ""}${focus ? ",\n      focus: \"linear\",\n      focusDepth: 0px,\n      focusRange: 200px,\n      maxBlur: 4px" : ""}
    ) as camera {
${layers}
    }
    animate camera.x from 0px to ${x}px over 1s ease linear;
  }
}

export out = render(main, width: 100px, height: 80px, codec: "h264");`;
}

function documentedRackFocusSource() {
  return `cut 0.4;
project "documented rack focus";
import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";
import { inOutCubic } from "@cut/motion";
timeline main(duration: 6s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 6s) {
    ParallaxCamera(focalLength: 900px, focus: "linear", focusDepth: 0px, focusRange: 800px, maxBlur: 6px) as camera {
      DepthLayer(depth: 1200px, edge: "clamp") { Rect(width: 640px, height: 360px, x: 320px, y: 180px, fill: #f0e6d2); }
      DepthLayer(depth: 240px, edge: "transparent") { Circle(x: 320px, y: 180px, radius: 80px, fill: #2457d6); }
      DepthLayer(depth: -180px, edge: "transparent") { Rect(width: 70px, height: 70px, x: 420px, y: 200px, fill: #ef6a45); }
    }
    animate camera.x from 0px to 180px over 6s ease inOutCubic;
    animate camera.y from 0px to -36px over 6s ease inOutCubic;
    animate camera.z from 0px to 120px over 6s ease inOutCubic;
    animate camera.focusDepth from 0px to 240px over 6s ease inOutCubic;
  }
}
export out = render(main, width: 640px, height: 360px, codec: "h264");`;
}

function compile(program = source()) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  const session = validateReferenceSession(ir);
  return { ir, session };
}

async function render(program: string, frame: number) {
  const { ir, session } = compile(program);
  const root = await mkdtemp(resolve(tmpdir(), "cut-public-parallax-"));
  const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, ".cut-cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[session.composition.sceneIds[0]];
    return { ir, frame: await renderer.sceneFrame(scene, frame, false) };
  } finally {
    await renderer.closeAndWait();
  }
}

function rgba(frame: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * frame.width + x) * 4;
  return [...frame.data.subarray(offset, offset + 4)];
}

function colorBounds(frame: { data: Uint8Array; width: number; height: number }, kind: "blue" | "red") {
  let left = frame.width, right = -1, top = frame.height, bottom = -1;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    const offset = (y * frame.width + x) * 4;
    const red = frame.data[offset], green = frame.data[offset + 1], blue = frame.data[offset + 2];
    if (kind === "blue" && !(blue > red + 40 && blue > green + 30)) continue;
    if (kind === "red" && !(red > 150 && green < 140 && red > green + 50 && red > blue + 40)) continue;
    if (frame.data[offset + 3] === 0) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { left, right, top, bottom };
}

function differingPixels(left: { data: Uint8Array }, right: { data: Uint8Array }) {
  assert.equal(left.data.length, right.data.length);
  let count = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    if (left.data[offset] !== right.data[offset]
      || left.data[offset + 1] !== right.data[offset + 1]
      || left.data[offset + 2] !== right.data[offset + 2]
      || left.data[offset + 3] !== right.data[offset + 3]) count += 1;
  }
  return count;
}

test("public CUT source checks, lowers, validates, and exposes typed camera/layer IR", () => {
  const { ir } = compile();
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.parallax_camera");
  assert.ok(camera);
  assert.deepEqual(camera.children.map((id) => ir.nodes[id].op), ["cut.visual.depth_layer", "cut.visual.depth_layer"]);
  assert.ok("signal" in camera.properties.x);
  if ("signal" in camera.properties.x) assert.equal(ir.signals[camera.properties.x.signal].valueType, "Length");
  assert.deepEqual(camera.inputs.focalLength, { kind: "quantity", dimension: "length", magnitude: { numerator: "100", denominator: "1" }, unit: "px" });
});

test("the documented continuous focusDepth example compiles and validates through the public deadband semantics", () => {
  const { ir } = compile(documentedRackFocusSource());
  const camera = Object.values(ir.nodes).find((node) => node.op === "cut.visual.parallax_camera")!;
  assert.ok(camera.properties.focusDepth && "signal" in camera.properties.focusDepth);
});

test("public renderer derives parallax pixels and clamp prevents the full-canvas preclip seam", async () => {
  const start = await render(source(), 0), middle = await render(source(), 12), transparentEdge = await render(source({ farEdge: "transparent" }), 0);
  assert.deepEqual(rgba(start.frame, 0, 0), [244, 195, 91, 255]);
  assert.deepEqual(rgba(start.frame, 99, 79), [244, 195, 91, 255]);
  assert.deepEqual(rgba(middle.frame, 0, 0), [244, 195, 91, 255]);
  assert.deepEqual(rgba(middle.frame, 99, 79), [244, 195, 91, 255]);
  assert.equal(rgba(transparentEdge.frame, 0, 0)[3], 0, "transparent edge must expose the projected materialized-canvas boundary");
  const initialBlue = colorBounds(start.frame, "blue"), movedBlue = colorBounds(middle.frame, "blue");
  const initialRed = colorBounds(start.frame, "red"), movedRed = colorBounds(middle.frame, "red");
  assert.ok(initialBlue.left >= 43 && initialBlue.right <= 56, JSON.stringify(initialBlue));
  assert.ok(movedBlue.left >= 31 && movedBlue.right <= 44, JSON.stringify(movedBlue));
  assert.ok(initialBlue.left - movedBlue.left >= 11 && initialBlue.left - movedBlue.left <= 13);
  assert.ok(initialRed.left - movedRed.left >= 5 && initialRed.left - movedRed.left <= 7, `${JSON.stringify(initialRed)} -> ${JSON.stringify(movedRed)}`);
  assert.ok((initialBlue.left - movedBlue.left) >= 1.8 * (initialRed.left - movedRed.left), "one camera path must derive a larger near-plane displacement");
});

test("focus executes after projection through the alpha-coupled blur and visibly changes structured far pixels", async () => {
  const focused = await render(source({ focus: true }), 0), sharp = await render(source(), 0);
  assert.deepEqual(rgba(focused.frame, 0, 0), [244, 195, 91, 255]);
  assert.deepEqual(rgba(focused.frame, 99, 79), [244, 195, 91, 255]);
  assert.ok(differingPixels(focused.frame, sharp.frame) > 80, "focus must change the projected red structure, not merely report a sigma over a uniform plate");
  const centre = rgba(focused.frame, 50, 40);
  assert.ok(centre[2] > centre[0], `focused near plane should remain sharp and on top: ${centre}`);
});

test("source ordering executes at overlap and changes the top pixel relative to depth ordering", async () => {
  const depth = await render(source({ nearFirst: true }), 0);
  const authoredSource = await render(source({ nearFirst: true, ordering: "source" }), 0);
  const depthCentre = rgba(depth.frame, 50, 40), sourceCentre = rgba(authoredSource.frame, 50, 40);
  assert.ok(depthCentre[2] > depthCentre[0], `depth order should paint the near blue circle last: ${depthCentre}`);
  assert.deepEqual(sourceCentre, [244, 195, 91, 255], "source order should paint the far amber layer last at overlap");
});

test("inspect, semantic diff, and localized graph cache expose public camera meaning", () => {
  const before = compile(source()), camera = Object.values(before.ir.nodes).find((node) => node.op === "cut.visual.parallax_camera")!;
  const inspected = inspectCutIr(before.ir, "proof.cut") as {
    graph: { nodes: Array<{ id: string; parallaxCamera?: { kind: string; projection: { isCamera3D: boolean }; pipeline: readonly string[] } }> };
  };
  const cameraInspect = inspected.graph.nodes.find((node) => node.id === camera.id)?.parallaxCamera;
  assert.equal(cameraInspect?.kind, "deterministic-2.5d");
  assert.equal(cameraInspect?.projection.isCamera3D, false);
  assert.deepEqual(cameraInspect?.pipeline.map((step) => step.split(" ")[0]), ["materialize", "apply", "project", "apply", "composite"]);

  const changed = compile(source({ x: 30 }));
  assert.ok(diffCutAVIR(before.ir, changed.ir).changes.some((change) => change.entity === "node" || change.entity === "signal"));
  const warm = createIncrementalRenderPlan(before.ir, before.session.composition.id);
  const edited = createIncrementalRenderPlan(changed.ir, changed.session.composition.id, warm.manifest);
  const changedIds = new Set(edited.nodes.filter((node) => node.status === "miss").map((node) => node.id));
  assert.ok(changedIds.has(camera.id));
  const farLeaf = Object.values(changed.ir.nodes).find((node) => node.op === "cut.visual.rect")!;
  assert.equal(changedIds.has(farLeaf.id), false, "camera motion must not invalidate the independent leaf node artifact identity");
});

test("the public checker rejects DepthLayer outside ParallaxCamera and non-layer camera children", () => {
  const bad = [
    source().replace("ParallaxCamera(\n      focalLength: 100px\n    ) as camera {", "Rect(width: 1px, height: 1px);\n    ParallaxCamera(focalLength: 100px) as camera {")
      .replace("DepthLayer(depth: 100px, edge: \"clamp\")", "Rect(width: 100px, height: 80px)"),
    `cut 0.4; project "orphan"; import { DepthLayer, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 100px, height: 80px, sampleRate: 48khz) { scene only(duration: 1s) { DepthLayer(depth: 0px, edge: "transparent") { Rect(width: 1px, height: 1px); } } }
export out = render(main, codec: "h264");`,
  ];
  for (const program of bad) {
    const parsed = parseCutLanguage(program);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.ok(checkCutModule(parsed.module).diagnostics.some((item) => item.code === "CUT_PARALLAX_GRAPH" && item.severity === "error"));
  }
});

test("public MotionBlur(startEdge: hold) still refuses a reachable ParallaxCamera child", () => {
  const wrapped = source()
    .replace(
      'import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";',
      'import { MotionBlur, ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";',
    )
    .replace("    ParallaxCamera(\n", '    MotionBlur(shutterAngle: 180deg, samples: 4, startEdge: "hold") {\n      ParallaxCamera(\n')
    .replace("    }\n    animate camera.x", "      }\n      animate camera.x")
    .replace(" over 1s ease linear;\n  }\n}", " over 1s ease linear;\n    }\n  }\n}");
  const parsed = parseCutLanguage(wrapped);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(checkCutModule(parsed.module).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  assert.throws(
    () => validateReferenceSession(ir),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "CUT_PARALLAX_GRAPH"
      && /beneath a reachable MotionBlur ancestor.*shutter subframes/.test(error.message),
  );
});

test("public validation refuses a constructor baseline shadowed at animation start", () => {
  const program = source().replace(
    "focalLength: 100px\n    ) as camera",
    "focalLength: 100px,\n      x: 10px\n    ) as camera",
  ).replace("animate camera.x from 0px", "animate camera.x from 20px");
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(checkCutModule(parsed.module).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  assert.throws(
    () => validateReferenceSession(ir),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "CUT_PARALLAX_NOOP"
      && /immediately shadowed/.test(error.message),
  );
});
