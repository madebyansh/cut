import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { referenceShapeNodeConfig } from "../lib/runtime/reference/shape-config";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(body: string, setup = "", imports = "Rect, Circle") {
  return `cut 0.4;
project "shape contract proof";
import { ${imports} } from "cut:visual";
${setup}
timeline main(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 32px, height: 24px, codec: "h264");`;
}

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function findNode(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(result, `missing ${op}`);
  return result;
}

function config(ir: CutAVIR, node: IRNode) {
  return referenceShapeNodeConfig(ir, ir.compositions[0], node);
}

function quantity(value: number, dimension: "length" | "ratio", unit = dimension === "length" ? "px" : "%"): IRValue {
  return { kind: "quantity", dimension, magnitude: { numerator: String(value), denominator: "1" }, unit };
}

function rejects(
  source: string,
  op: string,
  mutate: (node: IRNode, ir: CutAVIR) => void,
  code: string,
  message: RegExp,
) {
  const ir = compile(source), node = findNode(ir, op);
  mutate(node, ir);
  assert.throws(() => config(ir, node), (error: unknown) => {
    assert.ok(error instanceof ReferenceVisualConfigError);
    assert.equal(error.code, code);
    assert.match(error.message, /project\.cut:\d+:\d+/);
    assert.match(error.message, message);
    return true;
  });
}

test("Rect and Circle return closed executable geometry and paint configs", () => {
  const ir = compile(program(`
    Rect(width: 20px, height: 10px, radius: 4px, gradientFrom: #102030, gradientTo: #f0e0d0);
    Circle(radius: 6px, fill: #11223380);
  `));
  assert.deepEqual(config(ir, findNode(ir, "cut.visual.rect")), {
    kind: "rect",
    width: 20,
    height: 10,
    radius: 4,
    paint: { kind: "linear-gradient", from: "#102030", to: "#f0e0d0" },
  });
  assert.deepEqual(config(ir, findNode(ir, "cut.visual.circle")), {
    kind: "circle",
    radius: 6,
    paint: { kind: "solid", color: "#11223380" },
  });

  const defaultPaint = compile(program("Rect(width: 4px, height: 5px);"));
  assert.deepEqual(config(defaultPaint, findNode(defaultPaint, "cut.visual.rect")), {
    kind: "rect",
    width: 4,
    height: 5,
    radius: 0,
    paint: { kind: "solid", color: "#ffffff" },
  });
});

test("loaded Rect and Circle IR rejects missing, non-positive, unbounded, and implicit geometry", () => {
  const rect = program("Rect(width: 20px, height: 10px, radius: 2px, fill: #123456);");
  const circle = program("Circle(radius: 6px, fill: #123456);");
  const cases: Array<[string, string, (node: IRNode, ir: CutAVIR) => void, string, RegExp]> = [
    [rect, "cut.visual.rect", (node) => { delete node.inputs.width; }, "CUT_VISUAL_INPUT_TYPE", /requires input “width”/],
    [rect, "cut.visual.rect", (node) => { node.inputs.width = quantity(0, "length"); }, "CUT_VISUAL_VALUE_RANGE", /greater than 0px/],
    [rect, "cut.visual.rect", (node) => { node.inputs.height = quantity(65_537, "length"); }, "CUT_VISUAL_VALUE_RANGE", /at most 65536px/],
    [rect, "cut.visual.rect", (node) => { node.inputs.radius = quantity(6, "length"); }, "CUT_VISUAL_VALUE_RANGE", /between 0px and 5px/],
    [circle, "cut.visual.circle", (node) => { delete node.inputs.radius; }, "CUT_VISUAL_INPUT_TYPE", /requires input “radius”/],
    [circle, "cut.visual.circle", (node) => { node.inputs.radius = quantity(0, "length"); }, "CUT_VISUAL_VALUE_RANGE", /greater than 0px/],
    [circle, "cut.visual.circle", (node) => { node.inputs.radius = quantity(32_769, "length"); }, "CUT_VISUAL_VALUE_RANGE", /at most 32768px/],
  ];
  for (const entry of cases) rejects(...entry);
});

test("loaded shape IR accepts only canonical Color values and an unambiguous Rect paint model", () => {
  const solid = program("Rect(width: 20px, height: 10px, fill: #123456);");
  const circle = program("Circle(radius: 6px, fill: #123456);");
  const cases: Array<[string, string, (node: IRNode, ir: CutAVIR) => void, string, RegExp]> = [
    [solid, "cut.visual.rect", (node) => { node.inputs.fill = { kind: "string", value: "#123456" }; }, "CUT_VISUAL_INPUT_TYPE", /canonical lowercase/],
    [circle, "cut.visual.circle", (node) => { node.inputs.fill = { kind: "color", value: "#ABCDEF" }; }, "CUT_VISUAL_INPUT_TYPE", /canonical lowercase/],
    [solid, "cut.visual.rect", (node) => { node.inputs.gradientFrom = { kind: "color", value: "#000000" }; }, "CUT_VISUAL_INPUT_COMBINATION", /supplied together/],
    [solid, "cut.visual.rect", (node) => {
      node.inputs.gradientFrom = { kind: "color", value: "#000000" };
      node.inputs.gradientTo = { kind: "color", value: "#ffffff" };
    }, "CUT_VISUAL_INPUT_COMBINATION", /does not permit fill together/],
  ];
  for (const entry of cases) rejects(...entry);
});

const imageSetup = 'asset still: ImageAsset = image("fixture.png");';
const imageProgram = program(
  'Image(source: still, fit: "contain", crop: { x: 10%, y: 20%, width: 80%, height: 70% });',
  imageSetup,
  "Image",
);

test("Image returns an exact normalized crop and closed fit/resource config", () => {
  const ir = compile(imageProgram), node = findNode(ir, "cut.visual.image");
  const result = config(ir, node);
  assert.equal(result?.kind, "image");
  if (result?.kind !== "image") assert.fail("expected image config");
  assert.equal(result.fit, "contain");
  assert.equal(ir.resources[result.sourceId]?.kind, "image");
  assert.deepEqual(result.crop, { x: .1, y: .2, width: .8, height: .7 });
});

test("Image contain preserves transparent letterbox pixels while cover fills the layer", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-image-fit-contract-"));
  await sharp({
    create: { width: 16, height: 8, channels: 4, background: { r: 220, g: 35, b: 60, alpha: 1 } },
  }).png().toFile(resolve(root, "fixture.png"));

  const render = async (fit: "contain" | "cover") => {
    const ir = compile(program(`
      Rect(width: 32px, height: 24px, fill: #00ff00);
      Image(source: still, fit: "${fit}");
    `, imageSetup, "Rect, Image"));
    await applyCutLock(ir, await createCutLock(ir, root), root);
    const session = validateReferenceSession(ir);
    const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, `cache-${fit}`));
    await renderer.prepare();
    try {
      return (await renderer.sceneFrame(ir.scenes[session.composition.sceneIds[0]], 0)).data;
    } finally {
      renderer.close();
    }
  };

  const contain = await render("contain"), cover = await render("cover");
  const pixel = (bytes: Uint8Array, x: number, y: number) => Array.from(bytes.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
  assert.deepEqual(pixel(contain, 0, 0), [0, 255, 0, 255], "contain must expose the layer below rather than bake black bars");
  assert.deepEqual(pixel(contain, 16, 12), [220, 35, 60, 255], "contain must preserve the fitted image body");
  assert.deepEqual(pixel(cover, 0, 0), [220, 35, 60, 255], "cover must fill the output layer rather than letterbox it");
});

test("loaded Image crop is exact, ratio-typed, positive, and contained", () => {
  const cases: Array<[(node: IRNode, ir: CutAVIR) => void, string, RegExp]> = [
    [(node) => { if (node.inputs.crop?.kind === "object") node.inputs.crop.entries.extra = quantity(0, "ratio"); }, "CUT_VISUAL_INPUT_TYPE", /contain exactly x, y, width, and height/],
    [(node) => { if (node.inputs.crop?.kind === "object") node.inputs.crop.entries.width = quantity(10, "length"); }, "CUT_VISUAL_INPUT_TYPE", /crop\.width.*ratio/],
    [(node) => { if (node.inputs.crop?.kind === "object") node.inputs.crop.entries.height = quantity(0, "ratio"); }, "CUT_VISUAL_VALUE_RANGE", /crop\.height.*greater than 0/],
    [(node) => { if (node.inputs.crop?.kind === "object") node.inputs.crop.entries.x = quantity(1, "ratio"); }, "CUT_VISUAL_VALUE_RANGE", /entirely inside/],
    [(node) => { node.inputs.crop = { kind: "array", items: [] }; }, "CUT_VISUAL_INPUT_TYPE", /NormalizedCrop object/],
    [(node) => { node.inputs.source = { kind: "string", value: "fixture.png" }; }, "CUT_VISUAL_INPUT_TYPE", /ImageAsset resource reference/],
    [(node, ir) => { const source = node.inputs.source; assert.equal(source?.kind, "resource-ref"); if (source?.kind === "resource-ref") ir.resources[source.id].kind = "audio"; }, "CUT_VISUAL_INPUT_TYPE", /reference an image resource/],
  ];
  for (const [mutate, code, message] of cases) rejects(imageProgram, "cut.visual.image", mutate, code, message);
});

async function gradientPixels(from: string, to: string) {
  const ir = compile(program(`Rect(width: 28px, height: 20px, gradientFrom: ${from}, gradientTo: ${to});`));
  const session = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-shape-contract-"));
  const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    return (await renderer.sceneFrame(ir.scenes[session.composition.sceneIds[0]], 0)).data;
  } finally {
    renderer.close();
  }
}

test("paired gradient endpoints affect rendered pixels rather than acting as validated no-ops", async () => {
  const forward = await gradientPixels("#ff0000", "#0000ff");
  const reversed = await gradientPixels("#0000ff", "#ff0000");
  assert.notEqual(createHash("sha256").update(forward).digest("hex"), createHash("sha256").update(reversed).digest("hex"));
});
