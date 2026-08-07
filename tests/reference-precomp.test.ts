import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes, createIncrementalRenderPlan } from "../lib/runtime/graph";
import {
  ReferencePrecompError,
  referencePrecompLimits,
} from "../lib/runtime/reference/precomp-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(sourceColor = "#ef233c", otherColor = "#334455") {
  return `cut 0.4;
project "unrelated precomposition proof";
import { Precomp, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene delivery(duration: 1s) {
    Rect(width: 32px, height: 24px, fill: #24a148);
    Precomp(source: insert);
  }
}
timeline insert(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene first(duration: 500ms) { Rect(width: 8px, height: 8px, fill: ${sourceColor}); }
  scene second(duration: 500ms) { Rect(width: 8px, height: 8px, fill: #2667ff); }
}
timeline unrelated(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene only(duration: 1s) { Rect(width: 32px, height: 24px, fill: ${otherColor}); }
}
export out = render(main, width: 32px, height: 24px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source = program()) {
  const cutModule = parse(source);
  assert.deepEqual(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function digest(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

async function renderFrames(source = program(), frames = [0, 2]) {
  const ir = compile(source), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-precomp-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]];
    const rendered = [];
    for (const frame of frames) rendered.push(await renderer.sceneFrame(scene, frame));
    return { ir, frames: rendered };
  } finally { renderer.close(); }
}

test("Precomp is a typed childless Timeline instance, supports forward references, and does not clone source nodes", () => {
  assert.deepEqual(packageSymbol("cut:visual", "Precomp")?.parameters?.map((parameter) => [
    parameter.name,
    parameter.type,
    parameter.optional ?? false,
  ]), [
    ["source", "Timeline", false],
    ["range", "Range<Time>", true],
    ["x", "Length", true],
    ["y", "Length", true],
    ["scale", "Number", true],
    ["rotation", "Angle", true],
    ["opacity", "Ratio", true],
    ["editId", "String", true],
    ["role", "String", true],
    ["metadata", "EditorialMetadata", true],
  ]);
  const kernel = referenceKernelSchema("cut.visual.precomp");
  assert.ok(kernel?.support === "supported");
  if (kernel?.support === "supported") {
    assert.deepEqual(kernel.inputs, ["source", "range", "x", "y", "scale", "rotation", "opacity"]);
  }
  const ir = compile();
  const instance = Object.values(ir.nodes).find((node) => node.op === "cut.visual.precomp")!;
  const sourceRects = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.rect" && node.sceneId && ir.compositions.find((item) => item.id === "insert")!.sceneIds.includes(node.sceneId));
  assert.deepEqual(instance.children, []);
  assert.deepEqual(instance.inputs.source, { kind: "timeline-ref", id: "insert" });
  assert.deepEqual(instance.interval, { start: { numerator: "0", denominator: "1" }, duration: { numerator: "1", denominator: "1" } });
  assert.equal(sourceRects.length, 2, "source graph must remain owned by the source timeline rather than copied into the host");
  assert.ok(sourceRects.every((node) => !instance.children.includes(node.id)));
});

test("Precomp executes one exact half-open source range without changing its 1:1 picture clock", async () => {
  const source = program().replace("Precomp(source: insert);", "Precomp(source: insert, range: 500ms ..< 1s);");
  const result = await renderFrames(source, [0]);
  const instance = Object.values(result.ir.nodes).find((node) => node.op === "cut.visual.precomp")!;
  assert.deepEqual(instance.interval, {
    start: { numerator: "0", denominator: "1" },
    duration: { numerator: "1", denominator: "2" },
  });
  assert.deepEqual(pixel(result.frames[0], 16, 12), [38, 103, 255, 255]);
});

test("Precomp renders a transparent two-scene source on its own exact clock", async () => {
  const result = await renderFrames();
  const [red, blue] = result.frames;
  assert.deepEqual(pixel(red, 16, 12), [239, 35, 60, 255]);
  assert.deepEqual(pixel(blue, 16, 12), [38, 103, 255, 255]);
  assert.deepEqual(pixel(red, 1, 1), [36, 161, 72, 255], "uncovered nested pixels must remain transparent and reveal the host layer");
  assert.notEqual(digest(red.data), digest(blue.data));
});

test("multiple instances have independent transforms and reuse one immutable source graph", async () => {
  const source = program().replace(
    "Rect(width: 32px, height: 24px, fill: #24a148);\n    Precomp(source: insert);",
    "Precomp(source: insert, x: -8px);\n    Precomp(source: insert, x: 8px);",
  );
  const result = await renderFrames(source, [0]);
  const instances = Object.values(result.ir.nodes).filter((node) => node.op === "cut.visual.precomp");
  assert.equal(instances.length, 2);
  assert.notEqual(instances[0].id, instances[1].id);
  assert.deepEqual(pixel(result.frames[0], 8, 12), [239, 35, 60, 255]);
  assert.deepEqual(pixel(result.frames[0], 24, 12), [239, 35, 60, 255]);
  assert.deepEqual(pixel(result.frames[0], 16, 12), [5, 11, 16, 255]);
});

test("nested Precomp instances execute recursively without flattening composition clocks", async () => {
  const source = `cut 0.4;
project "nested precomposition proof";
import { Precomp, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene delivery(duration: 1s) { Precomp(source: middle, x: 4px); }
}
timeline middle(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene wrapper(duration: 1s) { Precomp(source: insert, x: -4px); }
}
timeline insert(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene first(duration: 500ms) { Rect(width: 8px, height: 8px, fill: #ef233c); }
  scene second(duration: 500ms) { Rect(width: 8px, height: 8px, fill: #2667ff); }
}
export out = render(main);`;
  const result = await renderFrames(source, [0, 2]);
  assert.equal(Object.values(result.ir.nodes).filter((node) => node.op === "cut.visual.precomp").length, 2);
  assert.deepEqual(pixel(result.frames[0], 16, 12), [239, 35, 60, 255]);
  assert.deepEqual(pixel(result.frames[1], 16, 12), [38, 103, 255, 255]);
});

test("Precomp source edits invalidate the instance and host scene while unrelated timeline edits remain local", () => {
  const before = compile(), previous = createIncrementalRenderPlan(before, "main").manifest;
  const sourceEdit = compile(program("#ffb000"));
  const sourceInstance = Object.values(sourceEdit.nodes).find((node) => node.op === "cut.visual.precomp")!;
  const sourcePlan = createIncrementalRenderPlan(sourceEdit, "main", previous);
  assert.equal(sourcePlan.nodes.find((item) => item.id === sourceInstance.id)?.status, "miss");
  assert.ok(sourcePlan.scenes.every((item) => item.status === "miss"));

  const unrelatedEdit = compile(program("#ef233c", "#ffffff"));
  const unrelatedPlan = createIncrementalRenderPlan(unrelatedEdit, "main", previous);
  assert.ok(unrelatedPlan.nodes.every((item) => item.status === "hit"));
  assert.ok(unrelatedPlan.scenes.every((item) => item.status === "hit"));
});

test("Precomp fails closed on authored children, unknown controls, audio discard, and source format/timing mismatch", () => {
  const authoredFailures = [
    program().replace("Precomp(source: insert);", "Precomp(source: insert) { Rect(width: 1px, height: 1px, fill: #ffffff); }"),
    program().replace("Precomp(source: insert);", "Precomp(source: insert, loop: true);"),
  ];
  for (const source of authoredFailures) {
    const cutModule = parse(source), messages = checkCutModule(cutModule).diagnostics.map((item) => item.message).join("\n");
    assert.match(messages, /does not accept child nodes|does not execute input “loop”/);
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }

  const formatMismatch = program().replace(
    "timeline insert(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz)",
    "timeline insert(duration: 1s, fps: 5, width: 32px, height: 24px, sampleRate: 48khz)",
  ).replace("scene first(duration: 500ms)", "scene first(duration: 400ms)").replace("scene second(duration: 500ms)", "scene second(duration: 600ms)");
  assert.throws(() => compile(formatMismatch), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_PRECOMP_FORMAT" && item.span.start.line > 0));

  const tooLong = program().replace("timeline main(duration: 1s", "timeline main(duration: 500ms").replace("scene delivery(duration: 1s)", "scene delivery(duration: 500ms)");
  assert.throws(() => compile(tooLong), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_PRECOMP_TIMING" && item.span.start.line > 0));

  const audioSource = program()
    .replace('import { Precomp, Rect } from "cut:visual";', 'import { Precomp, Rect } from "cut:visual";\nimport { Tone } from "@cut/audio";')
    .replace("scene first(duration: 500ms) {", "scene first(duration: 500ms) { Tone(frequency: 440hz, duration: 500ms);");
  assert.throws(() => compile(audioSource), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_PRECOMP_AUDIO" && item.span.start.line > 0));
});

test("loaded IR cannot bypass Precomp format closure or composition-content identity", () => {
  const ir = compileCutModule(parse(program())).ir;
  const insert = ir.compositions.find((item) => item.id === "insert")!;
  insert.width = 31;
  finalizeGraphHashes(ir);
  const loaded = loadCutAvIr(JSON.stringify(ir));
  loaded.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(loaded), (error: unknown) => error instanceof ReferencePrecompError
    && error.code === "CUT_PRECOMP_FORMAT"
    && error.source.line > 0);

  const tampered = compileCutModule(parse(program())).ir;
  tampered.compositions.find((item) => item.id === "insert")!.height = 23;
  assert.throws(() => loadCutAvIr(JSON.stringify(tampered)), /CUT_IR_IDENTITY.*contentHash/);
});

test("Precomp cycles and nesting budgets fail with stable source-located diagnostics", () => {
  const cycle = `cut 0.4;
project "precomp cycle";
import { Precomp } from "cut:visual";
timeline first(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) { scene a(duration: 1s) { Precomp(source: second); } }
timeline second(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) { scene b(duration: 1s) { Precomp(source: first); } }
export out = render(first);`;
  assert.throws(() => compile(cycle), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_PRECOMP_CYCLE" && item.span.start.line > 0));

  const declarations = Array.from({ length: referencePrecompLimits.maxDepth + 1 }, (_, index) => {
    const body = index === referencePrecompLimits.maxDepth
      ? "Rect(width: 2px, height: 2px, fill: #ffffff);"
      : `Precomp(source: t${index + 1});`;
    return `timeline t${index}(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) { scene s${index}(duration: 1s) { ${body} } }`;
  }).join("\n");
  const tooDeep = `cut 0.4; project "precomp budget"; import { Precomp, Rect } from "cut:visual"; ${declarations} export out = render(t0);`;
  assert.throws(() => compile(tooDeep), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_PRECOMP_BUDGET" && item.span.start.line > 0));
});
