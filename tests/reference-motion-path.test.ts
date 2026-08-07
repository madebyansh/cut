import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  prepareReferenceMotionPathNode,
  ReferenceMotionPathError,
  referenceMotionPathAt,
  referenceMotionPathInspect,
} from "../lib/runtime/reference/motion-path";
import { referenceTracePrefixWithTangent } from "../lib/runtime/reference/trace";
import { prepareReferenceVectorPathNode } from "../lib/runtime/reference/vector-path";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";

function source(body: string, declarations = "") {
  return `cut 0.4;
project "unrelated motion path proof";
import { MotionPath, Path, Rect, Circle, cubicTo, lineTo, vectorPath } from "cut:visual";
import { Tone } from "@cut/audio";
${declarations}
timeline main(duration: 1s, fps: 24, width: 100px, height: 100px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: 100px, height: 100px, codec: "h264");`;
}

function compile(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  const validation = validateReferenceSession(ir);
  const node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.motion_path");
  assert.ok(node);
  return { ir, node, composition: validation.composition };
}

async function render(program: string, frame = 0) {
  const result = compile(program);
  const root = await mkdtemp(resolve(tmpdir(), "cut-motion-path-"));
  const renderer = new ReferenceVisualRenderer(result.ir, result.composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const scene = result.ir.scenes[result.composition.sceneIds[0]];
    return { ...result, frame: await renderer.sceneFrame(scene, frame, false) };
  } finally {
    renderer.close();
  }
}

function alphaBounds(frame: { data: Uint8Array; width: number; height: number }) {
  let left = frame.width, top = frame.height, right = -1, bottom = -1;
  let weight = 0, xWeight = 0, yWeight = 0;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    const alpha = frame.data[(y * frame.width + x) * 4 + 3] / 255;
    if (alpha <= 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    weight += alpha; xWeight += x * alpha; yWeight += y * alpha;
  }
  assert.ok(weight > 0, "expected visible alpha");
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1, x: xWeight / weight, y: yWeight / weight };
}

function loaded(program: string, mutate: (node: IRNode, ir: CutAVIR) => void) {
  const { ir, node } = compile(program);
  mutate(node, ir);
  finalizeGraphHashes(ir);
  return loadCutAvIr(JSON.stringify(ir));
}

const base = `MotionPath(
  points: [{ x: 0px, y: 0px }, { x: 100px, y: 0px }, { x: 100px, y: 100px }],
  progress: 50%
) { Rect(width: 8px, height: 8px, fill: #ef233c); }`;

const sharedGeometry = `const route = vectorPath(
  start: { x: 10px, y: 80px },
  segments: [
    cubicTo(control1: { x: 10px, y: 10px }, control2: { x: 90px, y: 10px }, to: { x: 90px, y: 80px })
  ],
  closed: false
);`;

test("one public VectorPathGeometry drives both retained Path pixels and MotionPath sampling", () => {
  const result = compile(source(`
    Path(geometry: route, stroke: #293241, width: 2px);
    MotionPath(geometry: route, progress: 50%, orientToPath: true) {
      Circle(radius: 3px, fill: #ef233c);
    }`, sharedGeometry));
  const retained = Object.values(result.ir.nodes).find((item) => item.op === "cut.visual.path");
  assert.ok(retained);
  assert.deepEqual(result.node.inputs.geometry, retained.inputs.geometry, "both public nodes must own the exact same typed IR value");
  const motionPlan = prepareReferenceMotionPathNode(result.node);
  const pathPlan = prepareReferenceVectorPathNode(result.ir, retained);
  assert.ok(pathPlan);
  assert.equal(motionPlan.pathForm, "geometry");
  assert.equal(motionPlan.authoredSegments, 1);
  assert.equal(motionPlan.flatteningVersion, 1);
  assert.deepEqual(motionPlan.trace.points, pathPlan.sourcePrepared.points);
  assert.deepEqual(motionPlan.trace.cumulativeLengths, pathPlan.sourcePrepared.cumulativeLengths);
  const sharedHead = referenceTracePrefixWithTangent(pathPlan.sourcePrepared, .5);
  const sampled = referenceMotionPathAt(result.ir, result.composition, result.node, rational(0));
  assert.ok(Math.abs(sampled.x - (sharedHead.head.x - 50)) < 1e-12);
  assert.ok(Math.abs(sampled.y - (sharedHead.head.y - 50)) < 1e-12);
  assert.ok(Math.abs(sampled.rotation - Math.atan2(sharedHead.tangent.y, sharedHead.tangent.x) * 180 / Math.PI) < 1e-12);
  assert.deepEqual(referenceMotionPathInspect(result.ir, result.composition, result.node, motionPlan), {
    pathForm: "geometry",
    authoredSegments: 1,
    flattenedPoints: motionPlan.trace.points.length,
    totalLengthPx: motionPlan.trace.totalLength,
    closed: false,
    flatteningVersion: 1,
    orientToPath: true,
    executedAtActiveStart: { time: rational(0), progress: .5, ...sampled },
  });
});

test("a prepared MotionPath plan reuses immutable flattened geometry without per-frame decoding", () => {
  const result = compile(source(`MotionPath(geometry: route, progress: 50%, orientToPath: true) {
    Circle(radius: 3px, fill: #ef233c);
  }`, sharedGeometry));
  const plan = prepareReferenceMotionPathNode(result.node), geometry = result.node.inputs.geometry;
  let geometryReads = 0;
  Object.defineProperty(result.node.inputs, "geometry", {
    configurable: true,
    enumerable: true,
    get() { geometryReads += 1; return geometry; },
  });
  const first = referenceMotionPathAt(result.ir, result.composition, result.node, rational(0), plan);
  const second = referenceMotionPathAt(result.ir, result.composition, result.node, rational(1, 2), plan);
  assert.deepEqual(first, second, "constant progress must remain stable across exact frame times");
  assert.equal(geometryReads, 0, "a renderer-owned plan must not decode or flatten geometry again per frame");
  assert.throws(
    () => referenceMotionPathAt(result.ir, result.composition, result.node, rational(0), { ...plan, nodeId: "other" }),
    (error) => error instanceof ReferenceMotionPathError && error.code === "CUT_MOTION_PATH_GEOMETRY" && /prepared plan belongs to other/u.test(error.message),
  );
});

test("geometry MotionPath executes cubic arc-length position, tangent orientation, and exact progress timing", async () => {
  const program = (progress: string) => source(`MotionPath(geometry: route, progress: ${progress}, orientToPath: true) {
    Rect(width: 14px, height: 4px, fill: #ef233c);
  }`, sharedGeometry);
  const start = alphaBounds((await render(program("0%"))).frame);
  const middle = alphaBounds((await render(program("50%"))).frame);
  const end = alphaBounds((await render(program("100%"))).frame);
  // A 90-degree retained rotation places the even-sized raster centre at the
  // destination's lower half-pixel under CUT's locked Sharp placement rule.
  assert.ok(Math.abs(start.x - 9.5) < .15 && Math.abs(start.y - 80.5) < .15, JSON.stringify(start));
  assert.ok(Math.abs(middle.x - 49.5) < .7 && middle.y < 31, JSON.stringify(middle));
  // The opposite (+90-degree) endpoint produces the corresponding upper/right
  // half-pixel placement; this is intentionally direction-specific.
  assert.ok(Math.abs(end.x - 90.5) < .15 && Math.abs(end.y - 79.5) < .15, JSON.stringify(end));
  assert.ok(start.height > start.width, "the cubic start tangent must orient the wide subject vertically");
  assert.ok(middle.width > middle.height, "the symmetric cubic midpoint tangent must orient the subject horizontally");
  assert.ok(end.height > end.width, "the cubic end tangent must orient the wide subject vertically");

  const animated = source(`MotionPath(geometry: route, progress: 0%, orientToPath: true) as mover {
      Rect(width: 14px, height: 4px, fill: #ef233c);
    }
    animate mover.progress from 0% to 100% over 1s;`, sharedGeometry);
  const atTwelve = alphaBounds((await render(animated, 12)).frame);
  assert.ok(Math.abs(atTwelve.x - middle.x) < .1 && Math.abs(atTwelve.y - middle.y) < .1, "frame 12 at 24fps must execute the exact shared half-arc sample");
});

test("MotionPath samples a public polyline by cumulative arc length in canvas coordinates", () => {
  const { ir, node, composition } = compile(base.includes("MotionPath") ? source(base) : base);
  assert.equal(node.inputs.points.kind, "array");
  assert.equal(node.inputs.progress.kind, "quantity");
  assert.deepEqual(referenceMotionPathAt(ir, composition, node, rational(0)), { x: 50, y: -50, rotation: 0 });

  const later = compile(source(base.replace("progress: 50%", "progress: 75%, orientToPath: true")));
  assert.deepEqual(referenceMotionPathAt(later.ir, later.composition, later.node, rational(0)), { x: 50, y: 0, rotation: 90 });
});

test("MotionPath progress is a typed animatable Ratio sampled on the composition clock", () => {
  const program = source(`MotionPath(points: [{ x: 10px, y: 50px }, { x: 90px, y: 50px }]) as mover {
      Rect(width: 8px, height: 8px, fill: #ef233c);
    }
    animate mover.progress from 0% to 100% over 1s;`);
  const { ir, node, composition } = compile(program);
  assert.ok("signal" in node.properties.progress);
  if ("signal" in node.properties.progress) assert.equal(ir.signals[node.properties.progress.signal].valueType, "Ratio");
  assert.deepEqual(referenceMotionPathAt(ir, composition, node, rational(1, 2)), { x: 0, y: 0, rotation: 0 });
});

test("MotionPath changes rendered pixels and positions its child on the exact sampled path", async () => {
  const start = await render(source(`MotionPath(points: [{ x: 10px, y: 50px }, { x: 90px, y: 50px }], progress: 0%) {
    Rect(width: 8px, height: 6px, fill: #ef233c);
  }`));
  const middle = await render(source(`MotionPath(points: [{ x: 10px, y: 50px }, { x: 90px, y: 50px }], progress: 50%) {
    Rect(width: 8px, height: 6px, fill: #ef233c);
  }`));
  const end = await render(source(`MotionPath(points: [{ x: 10px, y: 50px }, { x: 90px, y: 50px }], progress: 100%) {
    Rect(width: 8px, height: 6px, fill: #ef233c);
  }`));
  const a = alphaBounds(start.frame), b = alphaBounds(middle.frame), c = alphaBounds(end.frame);
  assert.ok(Math.abs(a.x - 9.5) < 0.6 && Math.abs(a.y - 49.5) < 0.6);
  assert.ok(Math.abs(b.x - 49.5) < 0.6 && Math.abs(b.y - 49.5) < 0.6);
  assert.ok(Math.abs(c.x - 89.5) < 0.6 && Math.abs(c.y - 49.5) < 0.6);
  assert.notEqual(createHash("sha256").update(start.frame.data).digest("hex"), createHash("sha256").update(middle.frame.data).digest("hex"));
});

test("MotionPath progress animation reaches the expected rendered midpoint at frame 12", async () => {
  const program = source(`MotionPath(points: [{ x: 10px, y: 50px }, { x: 90px, y: 50px }]) as mover {
      Rect(width: 8px, height: 6px, fill: #ef233c);
    }
    animate mover.progress from 0% to 100% over 1s;`);
  const initial = alphaBounds((await render(program, 0)).frame);
  const midpoint = alphaBounds((await render(program, 12)).frame);
  assert.ok(Math.abs(initial.x - 9.5) < 0.6);
  assert.ok(Math.abs(midpoint.x - 49.5) < 0.6);
  assert.ok(Math.abs(initial.y - midpoint.y) < 0.1);
});

test("MotionPath composes tangent orientation, authored rotation, offsets and anchor pivot", async () => {
  const vertical = await render(source(`MotionPath(points: [{ x: 50px, y: 20px }, { x: 50px, y: 80px }], progress: 50%, orientToPath: true) {
    Rect(width: 16px, height: 4px, fill: #ef233c);
  }`));
  const rotatedAgain = await render(source(`MotionPath(points: [{ x: 50px, y: 20px }, { x: 50px, y: 80px }], progress: 50%, orientToPath: true, rotation: 90deg) {
    Rect(width: 16px, height: 4px, fill: #ef233c);
  }`));
  assert.ok(alphaBounds(vertical.frame).height > alphaBounds(vertical.frame).width);
  assert.ok(alphaBounds(rotatedAgain.frame).width > alphaBounds(rotatedAgain.frame).height);

  const pivot = await render(source(`MotionPath(points: [{ x: 20px, y: 30px }, { x: 80px, y: 30px }], progress: 50%, x: 7px, y: -3px, anchorX: 10px, anchorY: 6px, scale: 1.4, skewX: 8deg, skewY: -5deg, rotation: 27deg) {
    Circle(x: 60px, y: 56px, radius: 2px, fill: #ef233c);
  }`));
  const centre = alphaBounds(pivot.frame);
  assert.ok(Math.abs(centre.x - 56.5) < 0.6, `pivot x was ${centre.x}`);
  assert.ok(Math.abs(centre.y - 26.5) < 0.6, `pivot y was ${centre.y}`);
});

test("closed MotionPath returns to its first point and uses the closing tangent", () => {
  const result = compile(source(base.replace("progress: 50%", "progress: 100%, closed: true, orientToPath: true")));
  const sampled = referenceMotionPathAt(result.ir, result.composition, result.node, rational(0));
  assert.ok(Math.abs(sampled.x + 50) < 1e-9);
  assert.ok(Math.abs(sampled.y + 50) < 1e-9);
  assert.ok(Math.abs(sampled.rotation + 135) < 1e-9);
});

test("VectorPathGeometry owns closed MotionPath return and closing tangent semantics", () => {
  const declarations = `const loop = vectorPath(
    start: { x: 10px, y: 10px },
    segments: [lineTo(to: { x: 90px, y: 10px }), lineTo(to: { x: 90px, y: 90px })],
    closed: true
  );`;
  const result = compile(source(`MotionPath(geometry: loop, progress: 100%, orientToPath: true) {
    Rect(width: 4px, height: 2px, fill: #ef233c);
  }`, declarations));
  assert.equal(result.node.inputs.closed, undefined, "closure must remain inside the typed geometry value");
  const plan = prepareReferenceMotionPathNode(result.node);
  assert.equal(plan.closed, true);
  assert.deepEqual(referenceMotionPathAt(result.ir, result.composition, result.node, rational(0), plan), { x: -40, y: -40, rotation: -135 });
});

test("MotionPath rejects hostile shapes, ranges, booleans and ineffective paths with stable codes", () => {
  const cases: Array<[(node: IRNode) => void, ReferenceMotionPathError["code"], RegExp]> = [
    [(node) => { node.inputs.points = { kind: "string", value: "no" }; }, "CUT_MOTION_PATH_TYPE", /List<Vec2>/],
    [(node) => { node.inputs.points = { kind: "array", items: [] }; }, "CUT_MOTION_PATH_LIMIT", /2 through 1024/],
    [(node) => { node.inputs.points = { kind: "array", items: Array.from({ length: 1_025 }, () => point(0, 0)) }; }, "CUT_MOTION_PATH_LIMIT", /2 through 1024/],
    [(node) => { node.inputs.points = { kind: "array", items: [point(0, 0, true), point(1, 1)] }; }, "CUT_MOTION_PATH_SHAPE", /closed Vec2/],
    [(node) => { node.inputs.points = { kind: "array", items: [point(0, 0), point(0, 0)] }; }, "CUT_MOTION_PATH_SHAPE", /positive-length/],
    [(node) => { node.inputs.points = { kind: "array", items: [point(0, 0), point(65_537, 0)] }; }, "CUT_MOTION_PATH_RANGE", /65536px/],
    [(node) => { node.inputs.progress = ratioValue(1.01); }, "CUT_MOTION_PATH_RANGE", /between 0% and 100%/],
    [(node) => { node.inputs.orientToPath = { kind: "string", value: "yes" }; }, "CUT_MOTION_PATH_TYPE", /must be Boolean/],
  ];
  for (const [mutate, code, message] of cases) {
    const ir = loaded(source(base), mutate);
    assert.throws(
      () => validateReferenceSession(ir),
      (error) => error instanceof ReferenceMotionPathError && error.code === code && message.test(error.message),
    );
  }
});

test("MotionPath geometry has source-located exactly-one and closure-owner diagnostics", () => {
  const cases = [
    {
      body: "MotionPath() { Rect(width: 1px, height: 1px); }",
      needle: "MotionPath()",
      message: /requires exactly one path form/u,
    },
    {
      body: "MotionPath(points: [{ x: 0px, y: 0px }, { x: 10px, y: 10px }], geometry: route) { Rect(width: 1px, height: 1px); }",
      needle: "route)",
      message: /requires exactly one path form/u,
    },
    {
      body: "MotionPath(geometry: route, closed: false) { Rect(width: 1px, height: 1px); }",
      needle: "false",
      message: /VectorPathGeometry owns its closure/u,
    },
  ];
  for (const item of cases) {
    const program = source(item.body, sharedGeometry), parsed = parseCutLanguage(program);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    const diagnostics = checkCutModule(parsed.module).diagnostics.filter((diagnostic) => diagnostic.code === "CUT_MOTION_PATH_GEOMETRY");
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    assert.match(diagnostics[0]!.message, item.message);
    const expectedOffset = program.indexOf(item.needle, program.indexOf("timeline main"));
    assert.ok(expectedOffset >= 0);
    const expectedLine = program.slice(0, expectedOffset).split("\n").length;
    assert.equal(diagnostics[0]!.span.start.line, expectedLine, "the stable diagnostic must point to the authored conflicting form");
    assert.ok(diagnostics[0]!.span.start.column > 0);
  }
});

test("MotionPath rejects explicit neutral booleans at their source spans and in hostile IR", () => {
  const sourceCases = [
    { body: "MotionPath(points: [{ x: 0px, y: 0px }, { x: 10px, y: 10px }], closed: false) { Rect(width: 1px, height: 1px); }", needle: "false", message: /closed: false/u },
    { body: "MotionPath(geometry: route, orientToPath: false) { Rect(width: 1px, height: 1px); }", needle: "false", message: /orientToPath: false/u },
  ];
  for (const item of sourceCases) {
    const program = source(item.body, sharedGeometry), parsed = parseCutLanguage(program);
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    const diagnostics = checkCutModule(parsed.module).diagnostics.filter((diagnostic) => diagnostic.code === "CUT_MOTION_PATH_NOOP");
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    assert.match(diagnostics[0]!.message, item.message);
    const expectedOffset = program.indexOf(item.needle, program.indexOf("timeline main"));
    assert.equal(diagnostics[0]!.span.start.line, program.slice(0, expectedOffset).split("\n").length);
  }

  const pointsIr = loaded(source(base), (node) => { node.inputs.closed = { kind: "boolean", value: false }; });
  assert.throws(
    () => validateReferenceSession(pointsIr),
    (error) => error instanceof ReferenceMotionPathError && error.code === "CUT_MOTION_PATH_NOOP" && /closed: false/u.test(error.message),
  );
  const geometryIr = loaded(source(`MotionPath(geometry: route) { Rect(width: 1px, height: 1px); }`, sharedGeometry), (node) => {
    node.inputs.orientToPath = { kind: "boolean", value: false };
  });
  assert.throws(
    () => validateReferenceSession(geometryIr),
    (error) => error instanceof ReferenceMotionPathError && error.code === "CUT_MOTION_PATH_NOOP" && /orientToPath: false/u.test(error.message),
  );

  const inertClosedIr = loaded(source(`MotionPath(
    points: [{ x: 8px, y: 50px }, { x: 92px, y: 50px }],
    closed: true
  ) as mover { Rect(width: 1px, height: 1px); }
  animate mover.progress from 0% to 100% over 1s;`), (node, ir) => {
    const binding = node.properties.progress;
    if (binding && "signal" in binding) delete ir.signals[binding.signal];
    node.properties.progress = ratioValue(0);
  });
  assert.throws(
    () => validateReferenceSession(inertClosedIr),
    (error) => error instanceof ReferenceMotionPathError
      && error.code === "CUT_MOTION_PATH_NOOP"
      && /closed: true.*never changes position or executed tangent orientation.*exact reachable output-frame sample/u.test(error.message),
  );
});

test("MotionPath control counterfactuals fail closed when no change is proved inside 4096 exact frames", () => {
  const result = compile(source(`MotionPath(
    points: [{ x: 50px, y: 10px }, { x: 50px, y: 90px }],
    orientToPath: true
  ) as mover { Rect(width: 2px, height: 2px); }
  animate mover.progress from 0% to 100% over 1s;`));
  const { ir, node, composition } = result;
  node.inputs.points = { kind: "array", items: [point(0, 0), point(65_536, 0), point(65_536, 1)] };
  const duration = rational(5_000, 24);
  for (const candidate of Object.values(ir.nodes)) candidate.interval.duration = duration;
  node.interval.duration = duration;
  composition.duration = duration;
  const scene = ir.scenes[composition.sceneIds[0]]!;
  scene.duration = duration;
  const binding = node.properties.progress;
  assert.ok(binding && "signal" in binding);
  if (binding && "signal" in binding) {
    const signal = ir.signals[binding.signal];
    assert.equal(signal.kind, "track");
    if (signal.kind === "track" && signal.events[0]?.kind === "animate") signal.events[0].end = duration;
    signal.contentHash = cutSignalContentHash(signal);
  }
  finalizeGraphHashes(ir);
  const hostile = loadCutAvIr(JSON.stringify(ir));
  assert.throws(
    () => validateReferenceSession(hostile),
    (error) => error instanceof ReferenceMotionPathError
      && error.code === "CUT_MOTION_PATH_LIMIT"
      && /orientToPath: true.*4096-sample control-effect bound/u.test(error.message),
  );
});

test("loaded MotionPath closes unknown inputs and properties through the shared kernel schema", () => {
  const program = source(`MotionPath(geometry: route) { Rect(width: 1px, height: 1px); }`, sharedGeometry);
  for (const [kind, mutate, suffix] of [
    ["input", (node: IRNode) => { node.inputs.smoothing = ratioValue(.5); }, ".inputs.smoothing"],
    ["property", (node: IRNode) => { node.properties.smoothing = ratioValue(.5); }, ".properties.smoothing"],
  ] as const) {
    const { ir, node } = compile(program);
    mutate(node); finalizeGraphHashes(ir);
    assert.throws(
      () => loadCutAvIr(JSON.stringify(ir)),
      (error) => error instanceof CutAvIrValidationError
        && error.code === "CUT_IR_UNKNOWN_FIELD"
        && error.path === `$.nodes.${node.id}${suffix}`,
      `${kind} must fail at its exact loaded-IR path`,
    );
  }
});

test("loaded MotionPath geometry rejects both forms, neither form, authored closed, malformed records, no-op segments, and excessive arc work", () => {
  const geometryProgram = source(`MotionPath(geometry: route) {
    Rect(width: 2px, height: 2px, fill: #ef233c);
  }`, sharedGeometry);
  const pointValue = { kind: "array", items: [point(0, 0), point(1, 1)] } as IRValue;
  const cases: Array<[(node: IRNode) => void, ReferenceMotionPathError["code"], RegExp]> = [
    [(node) => { node.inputs.points = pointValue; }, "CUT_MOTION_PATH_GEOMETRY", /exactly one path form/u],
    [(node) => { delete node.inputs.geometry; }, "CUT_MOTION_PATH_GEOMETRY", /exactly one path form/u],
    [(node) => { node.inputs.closed = { kind: "boolean", value: false }; }, "CUT_MOTION_PATH_GEOMETRY", /cannot be authored.*owns its closure/u],
    [(node) => {
      assert.equal(node.inputs.geometry?.kind, "object");
      if (node.inputs.geometry?.kind === "object") node.inputs.geometry.entries.extra = ratioValue(1);
    }, "CUT_MOTION_PATH_GEOMETRY", /exactly start, segments, closed/u],
    [(node) => {
      assert.equal(node.inputs.geometry?.kind, "object");
      if (node.inputs.geometry?.kind === "object") {
        node.inputs.geometry.entries.start = point(10, 80);
        node.inputs.geometry.entries.segments = { kind: "array", items: [{ kind: "object", entries: { to: point(10, 80) } }] };
      }
    }, "CUT_MOTION_PATH_GEOMETRY", /zero-length lineTo/u],
    [(node) => {
      const segments: IRValue[] = [];
      for (let index = 0; index < 256; index += 1) segments.push({
        kind: "object",
        entries: { to: point(index % 2 === 0 ? 65_536 : -65_536, index % 4 < 2 ? 65_536 : -65_536) },
      });
      node.inputs.geometry = {
        kind: "object",
        entries: { start: point(-65_536, -65_536), segments: { kind: "array", items: segments }, closed: { kind: "boolean", value: false } },
      };
    }, "CUT_MOTION_PATH_LIMIT", /cumulative arc length exceeds/u],
  ];
  for (const [mutate, code, expected] of cases) {
    const ir = loaded(geometryProgram, mutate);
    assert.throws(
      () => validateReferenceSession(ir),
      (error) => error instanceof ReferenceMotionPathError && error.code === code && expected.test(error.message),
    );
  }
});

test("MotionPath geometry participates in inspect, semantic diff, graph identity, and localized cache invalidation", () => {
  const body = `MotionPath(geometry: route, progress: 50%, orientToPath: true) {
      Rect(width: 8px, height: 3px, fill: #ef233c);
    }
    Tone(frequency: 440hz, duration: 1s);`;
  const beforeSource = source(body, sharedGeometry);
  const afterSource = beforeSource.replace("control1: { x: 10px, y: 10px }", "control1: { x: 12px, y: 10px }");
  assert.notEqual(afterSource, beforeSource);
  const before = compile(beforeSource), after = compile(afterSource);
  const inspectedBefore = inspectCutIr(before.ir, "before.cut"), inspectedAfter = inspectCutIr(after.ir, "after.cut");
  const beforeNode = inspectedBefore.graph.nodes.find((item) => item.op === "cut.visual.motion_path");
  const afterNode = inspectedAfter.graph.nodes.find((item) => item.op === "cut.visual.motion_path");
  assert.ok(beforeNode && afterNode);
  assert.equal(beforeNode.motionPath?.pathForm, "geometry");
  assert.equal(beforeNode.motionPath?.authoredSegments, 1);
  assert.equal(beforeNode.motionPath?.flatteningVersion, 1);
  assert.equal(beforeNode.motionPath?.orientToPath, true);
  assert.ok((beforeNode.motionPath?.flattenedPoints ?? 0) > 2);
  assert.notEqual(beforeNode.motionPath?.totalLengthPx, afterNode.motionPath?.totalLengthPx, "inspect must expose the changed executed arc, not only a node hash");
  assert.notEqual(beforeNode.contentHash, afterNode.contentHash, "inspect must expose the changed executable node identity");
  assert.ok(diffCutAVIR(before.ir, after.ir).changes.some((change) => change.entity === "node" && change.id === after.node.id));
  const locality = createIncrementalRenderPlan(after.ir, "main", createIncrementalRenderPlan(before.ir, "main").manifest);
  assert.equal(locality.nodes.find((item) => item.id === after.node.id)?.status, "miss");
  const tone = Object.values(after.ir.nodes).find((item) => item.op === "cut.audio.tone");
  assert.ok(tone);
  assert.equal(locality.nodes.find((item) => item.id === tone.id)?.status, "hit", "a geometry edit must not invalidate unrelated audio work");
  assert.deepEqual(locality.scenes.map((scene) => scene.status), ["miss"]);
});

test("MotionPath tangent orientation cannot bypass transform allocation preflight", () => {
  const program = source(`MotionPath(
    points: [{ x: 0px, y: 0px }, { x: 100px, y: 100px }],
    orientToPath: true,
    scale: 2
  ) { Rect(width: 1px, height: 1px, fill: #ef233c); }`)
    .replaceAll("width: 100px, height: 100px", "width: 4096px, height: 4096px");
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(checkCutModule(parsed.module).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  assert.throws(
    () => validateReferenceSession(ir),
    (error) => error instanceof ReferenceVisualConfigError
      && error.code === "CUT_VISUAL_VALUE_RANGE"
      && /combined scale\/skew\/rotation would allocate.*estimated/.test(error.message),
  );
});

test("MotionPath child cardinality and named controls are closed before rendering", () => {
  for (const body of [
    "MotionPath(points: [{ x: 0px, y: 0px }, { x: 1px, y: 1px }]) {}",
    "MotionPath(points: [{ x: 0px, y: 0px }, { x: 1px, y: 1px }]) { Rect(width: 1px, height: 1px); Rect(width: 1px, height: 1px); }",
  ]) {
    const parsed = parseCutLanguage(source(body));
    assert.ok(parsed.module);
    assert.throws(
      () => compileCutModule(parsed.module!),
      (error) => error instanceof CutCompileError
        && error.result.diagnostics.some((item) => item.code === "CUT2085" && /requires exactly one visual child/.test(item.message)),
    );
  }
  const unknown = parseCutLanguage(source("MotionPath(points: [{ x: 0px, y: 0px }, { x: 1px, y: 1px }], smoothing: 1) { Rect(width: 1px, height: 1px); }"));
  assert.ok(unknown.module);
  assert.ok(checkCutModule(unknown.module).diagnostics.some((item) => item.severity === "error" && /smoothing/.test(item.message)));
});

function quantity(dimension: "length" | "ratio", value: number, unit: "px" | "ratio"): IRValue {
  const scale = 100;
  return { kind: "quantity", dimension, magnitude: rational(Math.round(value * scale), scale), unit };
}

function point(x: number, y: number, extra = false): IRValue {
  return { kind: "object", entries: { x: quantity("length", x, "px"), y: quantity("length", y, "px"), ...(extra ? { extra: quantity("length", 0, "px") } : {}) } };
}

function ratioValue(value: number): IRValue {
  return quantity("ratio", value, "ratio");
}
