import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { hash } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import {
  cutMediaCamera2DOp,
  cutMediaCamera2DProperties,
  cutMediaCamera2DResponsiveSlotContextInput,
} from "../lib/language/media-camera2d-contract";
import { parseCutLanguage } from "../lib/language/parser";
import {
  cutResponsiveSlotMediaContextAlgorithmVersion,
  decodeCutResponsiveSlotMediaContext,
} from "../lib/language/responsive-layout";
import { finalizeGraphHashes } from "../lib/runtime/graph";

function parse(source: string) {
  const result = parseCutLanguage(source);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(source: string) {
  return compileCutModule(parse(source)).ir;
}

function diagnostic(source: string, code: string) {
  const parsedModule = parse(source);
  const checked = checkCutModule(parsedModule);
  const found = checked.diagnostics.find((item) => item.severity === "error" && item.code === code);
  if (found) {
    assert.ok(found.span.start.line > 0 && found.span.start.column > 0);
    return found;
  }
  assert.throws(() => compileCutModule(parsedModule), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, String(error));
    const compiled = error.result.diagnostics.find((item) => item.severity === "error" && item.code === code);
    assert.ok(compiled, JSON.stringify(error.result.diagnostics));
    assert.ok(compiled.span.start.line > 0 && compiled.span.start.column > 0);
    return true;
  });
}

const animatedSlot = `ResponsiveSlot() {
  MediaCamera2D(
    focusX: 55%, focusY: 45%, zoom: 1.2, rotation: 2deg, opacity: 90%, edge: "clamp"
  ) as camera {
    Image(source: still, fit: "cover");
  }
  animate camera.focusX from 55% to 65% over 1s ease linear;
  animate camera.focusY from 45% to 35% over 1s ease linear;
  animate camera.zoom from 1.2 to 1.8 over 1s ease linear;
  animate camera.rotation from 2deg to -2deg over 1s ease linear;
  animate camera.opacity from 90% to 75% over 1s ease linear;
}`;

function source(firstSlot = animatedSlot, secondSlot = `ResponsiveSlot() {
  Rect(width: 24px, height: 24px, fill: #ffcc00);
}`) {
  return `cut 0.4;
project "Responsive MediaCamera2D language proof";
import {
  Image, MediaCamera2D, Rect, ResponsiveSlot, ResponsiveStack, responsiveStackPlan
} from "cut:visual";
import { linear } from "@cut/motion";
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 2s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    let plan = responsiveStackPlan(weights: [2, 1], safeX: 5%, safeY: 10%, gap: 20px);
    ResponsiveStack(plan: plan) {
      ${firstSlot}
      ${secondSlot}
    }
  }
}
export out = render(main);`;
}

function node(ir: CutAVIR, op: string) {
  const matches = Object.values(ir.nodes).filter((candidate) => candidate.op === op);
  assert.equal(matches.length, 1, op);
  return matches[0]!;
}

function responsiveNodes(ir: CutAVIR) {
  const stack = node(ir, "cut.visual.responsive_stack");
  const slot = ir.nodes[stack.children[0]!];
  assert.equal(slot?.op, "cut.visual.responsive_slot");
  const camera = ir.nodes[slot.children[0]!];
  assert.equal(camera?.op, cutMediaCamera2DOp);
  return { stack, slot, camera };
}

function resignContext(value: IRValue) {
  assert.equal(value.kind, "object");
  const semantic = structuredClone(value);
  assert.equal(semantic.kind, "object");
  delete semantic.entries.contextIdentity;
  value.entries.contextIdentity = { kind: "string", value: hash(semantic) };
}

test("ResponsiveSlot lowers one signal-driven MediaCamera2D child with an explicit rederived typed context", () => {
  const program = source();
  assert.deepEqual(checkCutModule(parse(program)).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compile(program);
  const { stack, slot, camera } = responsiveNodes(ir);

  assert.equal(camera.ownership, "child");
  assert.equal(slot.ownership, "child");
  assert.equal(stack.ownership, "root");
  assert.deepEqual(slot.children, [camera.id]);
  assert.deepEqual(Object.keys(camera.properties), [...cutMediaCamera2DProperties]);
  for (const property of cutMediaCamera2DProperties) {
    const reference = camera.properties[property];
    assert.ok(reference && "signal" in reference, property);
    assert.equal(ir.signals[reference.signal]?.kind, "track", property);
  }

  const value = camera.inputs[cutMediaCamera2DResponsiveSlotContextInput];
  assert.ok(value);
  const context = decodeCutResponsiveSlotMediaContext(
    value,
    stack.inputs.plan!,
    { stackNodeId: stack.id, slotNodeId: slot.id, index: 0 },
    `$.nodes.${camera.id}.inputs.${cutMediaCamera2DResponsiveSlotContextInput}`,
  );
  assert.equal(context.algorithm, cutResponsiveSlotMediaContextAlgorithmVersion);
  assert.equal(context.planIdentity, context.exactSlot.index === 0
    && stack.inputs.plan?.kind === "object"
    && stack.inputs.plan.entries.id.kind === "string"
    ? stack.inputs.plan.entries.id.value
    : "missing");
  assert.deepEqual(context.rasterSlot, {
    left: 32,
    top: 36,
    right: 403,
    bottom: 324,
    width: 371,
    height: 288,
  });
  assert.deepEqual(context.localContext, {
    originX: { numerator: "0", denominator: "1" },
    originY: { numerator: "0", denominator: "1" },
    width: { numerator: "371", denominator: "1" },
    height: { numerator: "288", denominator: "1" },
  });
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
});

test("ordinary scene-root MediaCamera2D remains root-owned and carries no responsive compiler input", () => {
  const ir = compile(`cut 0.4;
project "ordinary root camera";
import { Image, MediaCamera2D } from "cut:visual";
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(zoom: 1.2) { Image(source: still); }
  }
}
export out = render(main);`);
  const camera = node(ir, cutMediaCamera2DOp);
  assert.equal(camera.ownership, "root");
  assert.equal(camera.inputs[cutMediaCamera2DResponsiveSlotContextInput], undefined);
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
});

test("responsive plan geometry enters camera graph identity while formatting remains semantic", () => {
  const landscape = compile(source());
  const reweighted = compile(source().replace(
    "weights: [2, 1]",
    "weights: [1, 2]",
  ));
  const portrait = compile(source()
    .replace("width: 640px, height: 360px", "width: 270px, height: 480px"));
  const formatted = compile(source().replace(
    "ResponsiveStack(plan: plan) {",
    "// layout-only source comment\n    ResponsiveStack(plan: plan) {",
  ));
  const landscapeCamera = responsiveNodes(landscape).camera;
  const reweightedCamera = responsiveNodes(reweighted).camera;
  const portraitCamera = responsiveNodes(portrait).camera;
  const formattedCamera = responsiveNodes(formatted).camera;
  assert.notEqual(reweightedCamera.contentHash, landscapeCamera.contentHash);
  assert.notEqual(portraitCamera.contentHash, landscapeCamera.contentHash);
  assert.notEqual(reweighted.buildId, landscape.buildId);
  assert.notEqual(portrait.buildId, landscape.buildId);
  assert.equal(formattedCamera.contentHash, landscapeCamera.contentHash);
  assert.equal(formatted.buildId, landscape.buildId);
});

test("slot camera topology remains closed around one branch and its five local control tracks", () => {
  diagnostic(source(
    `${animatedSlot}
     Rect(width: 8px, height: 8px, fill: #ffffff);`,
  ), "CUT_RESPONSIVE_STACK_GRAPH");
  diagnostic(source(`ResponsiveSlot() {
    if true { MediaCamera2D(zoom: 1.2) { Image(source: still); } }
  }`), "CUT_RESPONSIVE_STACK_GRAPH");
  diagnostic(source(`ResponsiveSlot() {
    MediaCamera2D(zoom: 1.2) as camera { Image(source: still); }
    set camera.edge = "clamp";
  }`), "CUT_RESPONSIVE_STACK_GRAPH");
  diagnostic(source(`ResponsiveSlot() {
    Rect(width: 20px, height: 20px, fill: #ffffff) as panel;
    animate panel.opacity from 100% to 50% over 1s ease linear;
  }`), "CUT_RESPONSIVE_STACK_GRAPH");
  diagnostic(source(`ResponsiveSlot() {
    Rect(width: 20px, height: 20px, fill: #ffffff) {
      MediaCamera2D(zoom: 1.2) { Image(source: still); }
    }
  }`), "CUT_MEDIA_CAMERA_SCOPE");
  diagnostic(source(`ResponsiveSlot() {
    MediaCamera2D(zoom: 1.2, responsiveSlotContext: {}) { Image(source: still); }
  }`), "CUT2059");
});

function hostile(
  name: string,
  mutate: (ir: CutAVIR, camera: IRNode, stack: IRNode, slot: IRNode) => void,
  path: RegExp,
) {
  const ir = structuredClone(compile(source()));
  const { camera, stack, slot } = responsiveNodes(ir);
  mutate(ir, camera, stack, slot);
  finalizeGraphHashes(ir);
  assert.throws(() => loadCutAvIr(JSON.stringify(ir)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, `${name}: ${String(error)}`);
    assert.equal(error.code, "CUT_MEDIA_CAMERA_CONTEXT", name);
    assert.match(error.path, path, name);
    return true;
  });
}

test("strict loading rejects missing, transplanted, and re-signed invented slot geometry", () => {
  hostile("missing context", (_ir, camera) => {
    delete camera.inputs[cutMediaCamera2DResponsiveSlotContextInput];
  }, /responsiveSlotContext$/u);

  hostile("wrong structural slot id", (_ir, camera) => {
    const context = camera.inputs[cutMediaCamera2DResponsiveSlotContextInput]!;
    assert.equal(context.kind, "object");
    context.entries.slotNodeId = { kind: "string", value: "invented-slot" };
    resignContext(context);
  }, /slotNodeId$/u);

  hostile("invented raster width", (_ir, camera) => {
    const context = camera.inputs[cutMediaCamera2DResponsiveSlotContextInput]!;
    assert.equal(context.kind, "object");
    const raster = context.entries.rasterSlot;
    assert.equal(raster.kind, "object");
    raster.entries.width = {
      kind: "quantity",
      dimension: "length",
      magnitude: { numerator: "999", denominator: "1" },
      unit: "px",
    };
    resignContext(context);
  }, /rasterSlot\.width$/u);
});

test("the public IR schema admits the closed responsive camera context and rejects hidden context fields", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({
    schemaId: "auto",
    meta: false,
    validateSchema: false,
    allErrors: true,
    jsonPointers: true,
  }).compile(schema);
  const canonical = compile(source());
  assert.equal(validate(canonical), true, JSON.stringify(validate.errors));

  const hostile = structuredClone(canonical);
  const { camera } = responsiveNodes(hostile);
  const context = camera.inputs[cutMediaCamera2DResponsiveSlotContextInput]!;
  assert.equal(context.kind, "object");
  context.entries.privateViewportHint = { kind: "string", value: "portrait" };
  assert.equal(validate(hostile), false);
  assert.ok(
    validate.errors?.some((error) => /responsiveSlotContext/u.test(error.dataPath)),
    JSON.stringify(validate.errors),
  );
});
