import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  prepareReferenceTrack2D,
  referenceTrack2DAt,
  referenceTrack2DConfig,
  ReferenceTrack2DError,
} from "../lib/runtime/reference/tracking-2d";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

type TrackSample = {
  at: { numerator: string; denominator: string };
  x: { numerator: string; denominator: string };
  y: { numerator: string; denominator: string };
  confidence: { numerator: string; denominator: string };
  status: "visible" | "occluded" | "out-of-frame";
  scale?: { numerator: string; denominator: string };
  rotation?: { numerator: string; denominator: string };
};

const q = (numerator: number | string, denominator: number | string = 1) => ({ numerator: String(numerator), denominator: String(denominator) });

function sidecar(samples?: TrackSample[], width = 100, height = 100) {
  return {
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width,
    height,
    samples: samples ?? [
      { at: q(0), x: q(10), y: q(20), confidence: q(9, 10), status: "visible" },
      { at: q(1, 2), x: q(50), y: q(60), confidence: q(1, 5), status: "occluded" },
      { at: q(1), x: q(90), y: q(80), confidence: q(1), status: "visible" },
    ],
  };
}

function source(options: { interpolation?: "linear" | "hold"; bindScale?: boolean; bindRotation?: boolean; policies?: string } = {}) {
  const policies = options.policies ?? 'minConfidence: 60%, lowConfidence: "hold", occluded: "hold", outOfFrame: "hide"';
  return `cut 0.4;
project "unrelated robotics tracking fixture";
import { Circle, Rect, Track2D } from "cut:visual";
asset tracking: DataAsset = data("assets/robot-arm.track.json");
timeline main(duration: 1s, fps: 4, width: 100px, height: 100px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Track2D(source: tracking, ${policies}, interpolation: "${options.interpolation ?? "linear"}", bindScale: ${options.bindScale ?? false}, bindRotation: ${options.bindRotation ?? false}) as target {
      Rect(width: 12px, height: 4px, fill: #ff3d20);
    }
  }
}
export out = render(main, width: 100px, height: 100px, codec: "h264");`;
}

function parsed(value: string) {
  const result = parseCutLanguage(value);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(value = source()) {
  const cutModule = parsed(value), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(cutModule).ir;
}

function trackNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.track_2d");
  assert.ok(node);
  return node;
}

function unlockedConfig(ir = compile()) {
  const node = trackNode(ir), composition = ir.compositions[0], config = referenceTrack2DConfig(ir, node);
  assert.ok(config);
  return { ir, node, composition, config };
}

function alphaBounds(surface: { data: Buffer; width: number; height: number }) {
  let left = surface.width, top = surface.height, right = -1, bottom = -1;
  for (let y = 0; y < surface.height; y += 1) for (let x = 0; x < surface.width; x += 1) {
    if (surface.data[(y * surface.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return right < left ? undefined : { left, right, top, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

async function projectRoot(track: object | string = sidecar()) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-track-2d-")), assets = resolve(root, "assets");
  await mkdir(assets);
  await writeFile(resolve(assets, "robot-arm.track.json"), typeof track === "string" ? track : JSON.stringify(track));
  return root;
}

async function locked(root: string, value = source()) {
  const ir = compile(value), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

test("Track2D is a closed typed public unary API and every accepted argument reaches typed IR", () => {
  const symbol = packageSymbol("cut:visual", "Track2D");
  assert.deepEqual(symbol?.parameters?.map((parameter) => parameter.name), [
    "source", "minConfidence", "lowConfidence", "occluded", "outOfFrame", "interpolation", "bindScale", "bindRotation", "x", "y", "scale", "rotation", "opacity",
  ]);
  assert.deepEqual(symbol?.parameters?.find((parameter) => parameter.name === "outOfFrame")?.values, ["fail", "hold", "hide"]);
  assert.deepEqual(symbol?.parameters?.find((parameter) => parameter.name === "interpolation")?.values, ["linear", "hold"]);
  assert.equal(symbol?.children, "visual");

  const ir = compile(source().replace("bindRotation: false", "bindRotation: true, x: 2px, y: -3px, scale: 1.2, rotation: 8deg, opacity: 80%"));
  const node = trackNode(ir);
  assert.deepEqual(Object.keys(node.inputs).sort(), [
    "bindRotation", "bindScale", "interpolation", "lowConfidence", "minConfidence", "occluded", "opacity", "outOfFrame", "rotation", "scale", "source", "x", "y",
  ]);
  assert.equal(node.inputs.source?.kind, "resource-ref");
  assert.equal(node.children.length, 1);

  for (const invalid of [
    source({ policies: 'minConfidence: 60%, lowConfidence: "guess", occluded: "hold", outOfFrame: "hide"' }),
    source().replace("source: tracking", "source: 4"),
    source().replace("bindScale: false", "bindScale: 1"),
    source().replace(") as target {", ", smoothing: 0.2) as target {"),
  ]) {
    const cutModule = parsed(invalid), errors = checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error");
    assert.ok(errors.length > 0 && errors.every((item) => item.span.start.line > 0 && item.span.start.column > 0));
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }
  for (const body of [
    source().replace("Rect(width: 12px, height: 4px, fill: #ff3d20);", ""),
    source().replace("Rect(width: 12px, height: 4px, fill: #ff3d20);", "Circle(radius: 2px); Circle(radius: 3px);"),
  ]) assert.throws(() => compileCutModule(parsed(body)), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT2085" && /exactly one visual child/u.test(item.message)));
});

test("exact source-clock interpolation, hold, visibility policies, and optional scale/rotation are deterministic", () => {
  const linear = unlockedConfig(compile(source({ bindScale: true, bindRotation: true })));
  const bytes = Buffer.from(JSON.stringify(sidecar([
    { at: q(0), x: q(10), y: q(20), scale: q(1), rotation: q(0), confidence: q(9, 10), status: "visible" },
    { at: q(1, 2), x: q(50), y: q(60), scale: q(2), rotation: q(90), confidence: q(1), status: "visible" },
    { at: q(3, 4), x: q(75), y: q(75), scale: q(3), rotation: q(180), confidence: q(1, 10), status: "visible" },
    { at: q(1), x: q(90), y: q(80), scale: q(4), rotation: q(270), confidence: q(1), status: "visible" },
  ])));
  const track = prepareReferenceTrack2D(linear.node, linear.config, linear.composition, bytes);
  assert.deepEqual(referenceTrack2DAt(linear.node, track, linear.config, rational(1, 4)), { x: -20, y: -10, scale: 1.5, rotation: 45, hidden: false });
  assert.deepEqual(referenceTrack2DAt(linear.node, track, linear.config, rational(7, 8)), { x: 0, y: 10, scale: 2, rotation: 90, hidden: false }, "a held observation remains held across its half-open sample interval");
  assert.deepEqual(referenceTrack2DAt(linear.node, track, linear.config, rational(3, 4)), { x: 0, y: 10, scale: 2, rotation: 90, hidden: false }, "low-confidence hold uses the most recent acceptable observation");

  const held = unlockedConfig(compile(source({ interpolation: "hold", bindScale: true, bindRotation: true })));
  const heldTrack = prepareReferenceTrack2D(held.node, held.config, held.composition, bytes);
  assert.deepEqual(referenceTrack2DAt(held.node, heldTrack, held.config, rational(1, 4)), { x: -40, y: -30, scale: 1, rotation: 0, hidden: false });

  const hiddenConfig = unlockedConfig();
  const hiddenTrack = prepareReferenceTrack2D(hiddenConfig.node, hiddenConfig.config, hiddenConfig.composition, Buffer.from(JSON.stringify(sidecar([
    { at: q(0), x: q(10), y: q(20), confidence: q(1), status: "visible" },
    { at: q(1, 2), x: q(-2), y: q(60), confidence: q(1), status: "out-of-frame" },
    { at: q(1), x: q(90), y: q(80), confidence: q(1), status: "visible" },
  ]))));
  assert.equal(referenceTrack2DAt(hiddenConfig.node, hiddenTrack, hiddenConfig.config, rational(1, 2)).hidden, true);

  const failing = unlockedConfig(compile(source({ policies: 'minConfidence: 60%, lowConfidence: "fail", occluded: "fail", outOfFrame: "fail"' })));
  const failingTrack = prepareReferenceTrack2D(failing.node, failing.config, failing.composition, Buffer.from(JSON.stringify(sidecar())));
  assert.throws(() => referenceTrack2DAt(failing.node, failingTrack, failing.config, rational(1, 2)), (error: unknown) => error instanceof ReferenceTrack2DError
    && error.code === "CUT_TRACK2D_SAMPLE" && error.source.line > 0 && /1\/2s/u.test(error.message));
});

test("locked unrelated fixture moves and hides real rendered pixels at exact output frames", async () => {
  const fixture = sidecar([
    { at: q(0), x: q(10), y: q(20), scale: q(1), rotation: q(0), confidence: q(1), status: "visible" },
    { at: q(1, 4), x: q(30), y: q(30), scale: q(2), rotation: q(90), confidence: q(1), status: "visible" },
    { at: q(1, 2), x: q(-3), y: q(50), confidence: q(1), status: "out-of-frame" },
    { at: q(3, 4), x: q(70), y: q(70), scale: q(1), rotation: q(0), confidence: q(1), status: "visible" },
    { at: q(1), x: q(90), y: q(80), scale: q(1), rotation: q(0), confidence: q(1), status: "visible" },
  ]);
  const root = await projectRoot(fixture), ir = await locked(root, source({ bindScale: true, bindRotation: true })), { composition } = validateReferenceSession(ir, "out");
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "tracking-fixture-cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]];
    const frames = [];
    for (const index of [0, 1, 2, 3]) frames.push(await renderer.sceneFrame(scene, index, false));
    const bounds = frames.map(alphaBounds);
    assert.ok(bounds[0] && Math.abs(bounds[0].centerX - 9.5) <= 0.6 && Math.abs(bounds[0].centerY - 19.5) <= 0.6);
    assert.ok(bounds[1] && Math.abs(bounds[1].centerX - 29.5) <= 0.6 && Math.abs(bounds[1].centerY - 29.5) <= 0.6);
    assert.ok(bounds[0] && bounds[0].right - bounds[0].left > 2 * (bounds[0].bottom - bounds[0].top), "the unbound-shape baseline must remain horizontal");
    assert.ok(bounds[1] && bounds[1].bottom - bounds[1].top > 2 * (bounds[1].right - bounds[1].left), "tracked 2× scale plus 90-degree rotation must change actual pixels");
    assert.equal(bounds[2], undefined, "outOfFrame: hide must skip the child rather than paint a placeholder");
    assert.ok(bounds[3] && Math.abs(bounds[3].centerX - 69.5) <= 0.6 && Math.abs(bounds[3].centerY - 69.5) <= 0.6);
  } finally { renderer.close(); }
});

test("strict schema, hostile bytes, finite bounds, exact coverage, and binding requirements fail closed", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-track-2d-v1.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  assert.equal(validate(sidecar()), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...sidecar(), secretRenderer: true }), false);
  assert.equal(validate({ ...sidecar(), samples: [{ ...sidecar().samples[0], executable: "shader" }, sidecar().samples[2]] }), false);

  const base = unlockedConfig(), expect = (value: object | string, code: ReferenceTrack2DError["code"], message?: RegExp) => {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    assert.throws(() => prepareReferenceTrack2D(base.node, base.config, base.composition, bytes), (error: unknown) => error instanceof ReferenceTrack2DError
      && error.code === code && error.source.line > 0 && (!message || message.test(error.message)));
  };
  expect('{"format":"cut-track-2d","format":"cut-track-2d","version":1,"coordinateSpace":"composition-pixels","width":100,"height":100,"samples":[]}', "CUT_TRACK2D_JSON", /duplicate decoded/u);
  expect({ ...sidecar(), extra: true }, "CUT_TRACK2D_SCHEMA", /extra/u);
  expect({ ...sidecar(), width: 101 }, "CUT_TRACK2D_DIMENSIONS", /101×100/u);
  expect({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index === 1 ? { ...sample, at: q(2, 4) } : sample) }, "CUT_TRACK2D_SCHEMA", /lowest terms/u);
  expect({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index === 1 ? { ...sample, at: q(3, 2) } : sample) }, "CUT_TRACK2D_TIME", /strictly later/u);
  expect({ ...sidecar(), samples: sidecar().samples.slice(0, 2) }, "CUT_TRACK2D_TIME", /complete node-local/u);
  expect({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index === 0 ? { ...sample, x: q(-1) } : sample) }, "CUT_TRACK2D_RANGE", /out-of-frame/u);
  expect({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index === 0 ? { ...sample, confidence: q(2) } : sample) }, "CUT_TRACK2D_RANGE", /finite bound/u);

  const binding = unlockedConfig(compile(source({ bindScale: true })));
  assert.throws(() => prepareReferenceTrack2D(binding.node, binding.config, binding.composition, Buffer.from(JSON.stringify(sidecar()))), (error: unknown) => error instanceof ReferenceTrack2DError
    && error.code === "CUT_TRACK2D_BINDING" && /scale is required/u.test(error.message));

  const hostileIr = structuredClone(base.ir), hostileNode = trackNode(hostileIr);
  hostileNode.inputs.privateRenderer = { kind: "string", value: "hidden" };
  finalizeGraphHashes(hostileIr);
  assert.throws(() => loadCutAvIr(JSON.stringify(hostileIr)), (error: unknown) => error instanceof CutAvIrValidationError
    && error.code === "CUT_IR_UNKNOWN_FIELD" && error.path.endsWith(".inputs.privateRenderer"));
});

test("locked bytes participate in inspect, semantic diff, node-cache identity, and tamper refusal", async () => {
  const root = await projectRoot(), path = resolve(root, "assets", "robot-arm.track.json");
  const before = await locked(root), beforeNode = trackNode(before), beforeInspect = inspectCutIr(before, "main.cut");
  const inspected = beforeInspect.resources.find((resource) => resource.id === "tracking");
  assert.equal(inspected?.sha256, createHash("sha256").update(await readFile(path)).digest("hex"));
  const inspectedNode = beforeInspect.graph.nodes.find((node) => node.id === beforeNode.id);
  assert.deepEqual(inspectedNode?.tracking2D, {
    sourceId: "tracking",
    interpolation: "linear",
    minConfidence: rational(3, 5),
    policies: { lowConfidence: "hold", occluded: "hold", outOfFrame: "hide" },
    bindScale: false,
    bindRotation: false,
  });
  const firstPlan = createIncrementalRenderPlan(before, before.compositions[0].id);

  const changed = sidecar();
  changed.samples[0] = { ...changed.samples[0], x: q(12) };
  await writeFile(path, JSON.stringify(changed));
  const after = await locked(root), secondPlan = createIncrementalRenderPlan(after, after.compositions[0].id, firstPlan.manifest);
  assert.notEqual(before.resources.tracking.sha256, after.resources.tracking.sha256);
  assert.ok(diffCutAVIR(before, after).changes.some((change) => change.entity === "resource" && change.id === "tracking"));
  assert.equal(secondPlan.nodes.find((entry) => entry.id === beforeNode.id)?.status, "miss", "tracking bytes must invalidate the dependent retained node");
  const retainedChild = Object.values(after.nodes).find((node) => node.op === "cut.visual.rect");
  assert.ok(retainedChild);
  assert.equal(secondPlan.nodes.find((entry) => entry.id === retainedChild.id)?.status, "hit", "the resource-independent retained child remains reusable");

  const policyEdit = compile(source({ interpolation: "hold" }));
  assert.ok(diffCutAVIR(compile(), policyEdit).changes.some((change) => change.entity === "node" && change.id === beforeNode.id), "authored tracking policy/interpolation changes remain visible to semantic diff");

  await writeFile(path, JSON.stringify(sidecar()));
  const { composition } = validateReferenceSession(after, "out"), renderer = new ReferenceVisualRenderer(after, composition, root, resolve(root, ".cut", "tamper-cache"));
  await assert.rejects(() => renderer.prepare(), (error: unknown) => error instanceof ReferenceTrack2DError
    && error.code === "CUT_TRACK2D_RESOURCE" && error.source.line > 0 && /bytes changed|byte count changed/u.test(error.message));
  renderer.close();
});

test("a hold policy without an earlier acceptable observation fails instead of inventing a transform", () => {
  const base = unlockedConfig();
  const track = prepareReferenceTrack2D(base.node, base.config, base.composition, Buffer.from(JSON.stringify(sidecar([
    { at: q(0), x: q(10), y: q(10), confidence: q(1, 10), status: "visible" },
    { at: q(1, 2), x: q(50), y: q(50), confidence: q(1), status: "visible" },
    { at: q(1), x: q(90), y: q(90), confidence: q(1), status: "visible" },
  ]))));
  assert.throws(() => referenceTrack2DAt(base.node, track, base.config, rational(0)), (error: unknown) => error instanceof ReferenceTrack2DError
    && error.code === "CUT_TRACK2D_HOLD_EMPTY" && error.source.line > 0);
});
