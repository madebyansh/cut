import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { formatCutSource } from "../lib/language/formatter";
import type { CutAVIR, IRValue } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { builtinPackageImplementationFiles, builtinPackages } from "../lib/language/packages";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { evaluateSignal } from "../lib/runtime/reference/signals";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source: string) {
  return compileCutModule(parse(source)).ir;
}

function expectCompileDiagnostic(source: string, code: string) {
  try { compile(source); }
  catch (error) {
    assert.ok(error instanceof CutCompileError, String(error));
    const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === code);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    return diagnostic;
  }
  assert.fail(`Expected ${code}.`);
}

function valueCalls(value: IRValue): string[] {
  if (value.kind === "call") return [value.op, ...value.positional.flatMap(valueCalls), ...Object.values(value.named).flatMap(valueCalls)];
  if (value.kind === "array") return value.items.flatMap(valueCalls);
  if (value.kind === "object") return Object.values(value.entries).flatMap(valueCalls);
  if (value.kind === "range") return [...valueCalls(value.start), ...valueCalls(value.end)];
  if (value.kind === "unary") return valueCalls(value.value);
  if (value.kind === "binary") return [...valueCalls(value.left), ...valueCalls(value.right)];
  if (value.kind === "member") return valueCalls(value.object);
  if (value.kind === "index") return [...valueCalls(value.object), ...valueCalls(value.index)];
  return [];
}

type ProgramOptions = {
  alpha?: string;
  alphaTargetX?: string;
  comment?: boolean;
};

function program({ alpha = "3", alphaTargetX = "80px", comment = false }: ProgramOptions = {}) {
  return `${comment ? "// Formatting and comments are non-semantic.\n" : ""}cut 0.4;
project "public keyed bars";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";
import { keyedNumber, markTarget, barLayout, barTargets, formatNumber } from "@cut/data";

const layout: BarLayout = barLayout(
  data: [
    keyedNumber(key: "alpha", label: "Alpha", value: ${alpha}),
    keyedNumber(key: "beta", label: "Beta", value: 7),
    keyedNumber(key: "gamma", label: "Gamma", value: 5)
  ],
  x: 160px, y: 90px, width: 240px, height: 120px,
  min: 0, max: 10, gap: 20%, padding: 10px
);
const moves: List<BarMarkTransform> = barTargets(layout, [
  markTarget(key: "gamma", x: 250px, y: 65px),
  markTarget(key: "alpha", x: ${alphaTargetX}, y: 65px),
  markTarget(key: "beta", x: 170px, y: 65px)
]);

timeline main(duration: 2s, fps: 10, width: 320px, height: 180px, sampleRate: 48khz) {
  scene bars(duration: 1s) {
    assert layout.id != "", "layout identity is public";
    assert formatNumber(201 / 200, 2, "%") == "1.01%", "exact format";
    for mark in layout.marks {
      assert mark.key != "", "key";
      assert mark.label != "", "label";
      assert mark.value >= 0, "value";
      assert mark.index >= 0, "index";
      assert mark.x == mark.x, "x";
      assert mark.y == mark.y, "y";
      assert mark.width > 0px, "width";
      assert mark.height > 0px, "height";
      assert mark.left < mark.right, "horizontal bounds";
      assert mark.top < mark.bottom, "vertical bounds";
      assert mark.baselineY >= mark.top, "baseline";
    }
    for move in moves {
      assert move.key != "", "transform key";
      assert move.label != "", "transform label";
      assert move.value >= 0, "transform value";
      assert move.index >= 0, "transform index";
      assert move.left < move.right, "transform horizontal bounds";
      assert move.top < move.bottom, "transform vertical bounds";
      assert move.baselineY >= move.top, "transform baseline";
      Rect(width: move.width, height: move.height, x: move.x, y: move.y, fill: #e63946) as bar;
      animate bar.x from 0px to move.targetX - move.x over 800ms ease linear;
      animate bar.y from 0px to move.targetY - move.y over 800ms ease linear;
    }
  }
  scene stable(duration: 1s) {
    Rect(width: 40px, height: 40px, x: 160px, y: 90px, fill: #457b9d);
  }
}
export out = render(main);`;
}

function rects(ir: CutAVIR) {
  return Object.values(ir.nodes).filter((node) => node.op === "cut.visual.rect");
}

function pixelHash(frame: { data: Buffer }) {
  return createHash("sha256").update(frame.data).digest("hex");
}

function opaquePixelCount(frame: { data: Buffer }) {
  let count = 0;
  for (let offset = 3; offset < frame.data.length; offset += 4) if (frame.data[offset] > 0) count += 1;
  return count;
}

function rgbaAt(frame: { data: Buffer; width: number }, x: number, y: number) {
  const offset = (y * frame.width + x) * 4;
  return [...frame.data.subarray(offset, offset + 4)];
}

test("@cut/data publishes exact compile-time keyed-bar functions and implementation closure", () => {
  const symbols = builtinPackages.get("@cut/data")?.symbols;
  assert.ok(symbols);
  assert.deepEqual({ returns: symbols.keyedNumber.returns, lowering: symbols.keyedNumber.lowering }, { returns: "KeyedNumber", lowering: "record" });
  assert.deepEqual({ returns: symbols.markTarget.returns, lowering: symbols.markTarget.lowering }, { returns: "MarkTarget", lowering: "record" });
  assert.deepEqual({ returns: symbols.barLayout.returns, lowering: symbols.barLayout.lowering }, { returns: "BarLayout", lowering: "data-bar-layout" });
  assert.deepEqual({ returns: symbols.barTargets.returns, lowering: symbols.barTargets.lowering }, { returns: "List<BarMarkTransform>", lowering: "data-bar-targets" });
  assert.deepEqual({ returns: symbols.formatNumber.returns, lowering: symbols.formatNumber.lowering }, { returns: "String", lowering: "data-format-number" });
  assert.ok(builtinPackageImplementationFiles("@cut/data").includes("language/data-layout"));
});

test("public source checks and lowers to ordinary Rects, exact signals, and no hidden data operation", () => {
  const source = program(), parsedModule = parse(source), checked = checkCutModule(parsedModule);
  assert.deepEqual(checked.diagnostics, []);
  const ir = compileCutModule(parsedModule).ir, bars = rects(ir);
  assert.equal(bars.length, 4, "three generated bars plus the unrelated stable Rect");
  assert.equal(Object.keys(ir.signals).length, 6, "x/y motion remains ordinary Rect animation");
  assert.ok(ir.assertions.every((item) => item.status === "pass"));
  assert.deepEqual(Object.values(ir.nodes).map((node) => node.op), [
    "cut.visual.rect", "cut.visual.rect", "cut.visual.rect", "cut.visual.rect",
  ]);
  assert.deepEqual(Object.values(ir.nodes).flatMap((node) => Object.values(node.inputs).flatMap(valueCalls)), []);
  assert.deepEqual(Object.values(ir.signals).flatMap((signal) => signal.kind === "track"
    ? signal.events.flatMap((event) => event.kind === "set" ? valueCalls(event.value) : [...valueCalls(event.from), ...valueCalls(event.to), ...valueCalls(event.curve)])
    : []), []);

  const alpha = bars[0], xReference = alpha.properties.x, yReference = alpha.properties.y;
  assert.ok(xReference && "signal" in xReference && yReference && "signal" in yReference);
  if (!(xReference && "signal" in xReference && yReference && "signal" in yReference)) return;
  const startX = evaluateSignal(ir, xReference.signal, rational(0));
  const endX = evaluateSignal(ir, xReference.signal, rational(4, 5));
  const endY = evaluateSignal(ir, yReference.signal, rational(4, 5));
  assert.equal(startX.kind, "quantity");
  assert.equal(endX.kind, "quantity");
  assert.equal(endY.kind, "quantity");
  if (startX.kind === "quantity" && endX.kind === "quantity" && endY.kind === "quantity") {
    assert.deepEqual(startX.magnitude, rational(0));
    assert.deepEqual(endX.magnitude, rational(-20, 3));
    assert.deepEqual(endY.magnitude, rational(-60));
  }
  assert.doesNotThrow(() => validateReferenceSession(ir));
});

test("keyed Rect animation changes real rendered pixels at full frame speed", { timeout: 30_000 }, async () => {
  const ir = compile(program());
  ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-keyed-bars-"));
  const composition = ir.compositions[0], scene = ir.scenes[composition.sceneIds[0]];
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut-cache"));
  await renderer.prepare();
  try {
    const first = await renderer.sceneFrame(scene, 0, false);
    const middle = await renderer.sceneFrame(scene, 4, false);
    const moved = await renderer.sceneFrame(scene, 8, false);
    const firstOpaque = opaquePixelCount(first), middleOpaque = opaquePixelCount(middle), movedOpaque = opaquePixelCount(moved);
    assert.ok(firstOpaque > 1_000, `expected rendered source bars, found ${firstOpaque} opaque pixels`);
    assert.ok(middleOpaque > 1_000, `expected rendered in-flight bars, found ${middleOpaque} opaque pixels`);
    assert.ok(movedOpaque > 1_000, `expected rendered moved bars, found ${movedOpaque} opaque pixels`);
    assert.equal(new Set([pixelHash(first), pixelHash(middle), pixelHash(moved)]).size, 3, "start, mid, and exact 800ms end frames must differ");
    const red = [230, 57, 70, 255];
    for (const [x, y] of [[87, 125], [160, 105], [233, 115]]) {
      assert.deepEqual(rgbaAt(first, x, y), red, `frame 0 must paint the source centre ${x},${y}`);
    }
    for (const [x, y] of [[80, 65], [170, 65], [250, 65]]) {
      assert.deepEqual(rgbaAt(moved, x, y), red, `frame 8 must paint the exact keyed target centre ${x},${y}`);
    }
    assert.deepEqual(rgbaAt(moved, 87, 125), [0, 0, 0, 0], "the vacated alpha source centre must become transparent at the exact endpoint");
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bar layout diagnostics retain stable codes and the exact nested authored span", () => {
  const source = program().replace(
    'keyedNumber(key: "beta", label: "Beta", value: 7)',
    'keyedNumber(key: "alpha", label: "Beta", value: 7)',
  );
  const secondKey = source.indexOf('key: "alpha"', source.indexOf('key: "alpha"') + 1) + "key: ".length;
  const diagnostic = expectCompileDiagnostic(source, "CUT_DATA_KEY_DUPLICATE");
  assert.equal(diagnostic.span.start.offset, secondKey);
  assert.match(diagnostic.message, /\$\.data\[1\]\.key/u);

  const malformed = program().replace('key: "alpha"', 'key: "bad key"');
  const keyDiagnostic = expectCompileDiagnostic(malformed, "CUT_DATA_KEY_VALUE");
  assert.equal(keyDiagnostic.span.start.offset, malformed.indexOf('"bad key"'));
  assert.match(keyDiagnostic.message, /1\.\.128 ASCII/u);

  const formatter = program().replace('formatNumber(201 / 200, 2, "%")', 'formatNumber(1, 7, "%")');
  const formatDiagnostic = expectCompileDiagnostic(formatter, "CUT_DATA_FORMAT_RANGE");
  assert.equal(formatDiagnostic.span.start.offset, formatter.indexOf("7, \"%\""));
  assert.match(formatDiagnostic.message, /\$\.decimals/u);
});

test("public lowering enforces exact keyed target coverage and hostile item budgets", () => {
  const missing = program().replace('markTarget(key: "beta", x: 170px, y: 65px)', 'markTarget(key: "delta", x: 170px, y: 65px)');
  const targetDiagnostic = expectCompileDiagnostic(missing, "CUT_BAR_TARGET_COVERAGE");
  assert.equal(targetDiagnostic.span.start.offset, missing.indexOf('"delta"'));
  assert.match(targetDiagnostic.message, /does not match any layout key/u);

  const many = Array.from({ length: 513 }, (_, index) => `keyedNumber("k${index}", "Item ${index}", 1)`).join(", ");
  const hostile = `cut 0.4;
project "hostile bar budget";
import { keyedNumber, barLayout } from "@cut/data";
const layout: BarLayout = barLayout([${many}], 160px, 90px, 240px, 120px, 0, 10, 20%, 10px);`;
  const budgetDiagnostic = expectCompileDiagnostic(hostile, "CUT_BAR_LAYOUT_LIMIT");
  assert.equal(budgetDiagnostic.span.start.offset, hostile.indexOf("["));
  assert.match(budgetDiagnostic.message, /512-datum budget/u);
});

test("nominal layout and mark members are closed in the public checker", () => {
  const invalid = program().replace("move.width", "move.privateWidth");
  const checked = checkCutModule(parse(invalid));
  assert.ok(checked.diagnostics.some((diagnostic) => diagnostic.code === "CUT2013" && /BarMarkTransform.*privateWidth/u.test(diagnostic.message)), JSON.stringify(checked.diagnostics));
});

test("comments are semantically stable while data and target edits invalidate only the owning scene", () => {
  const source = program(), before = compile(source);
  const formattedSource = formatCutSource(program({ comment: true }));
  const formatted = compile(formattedSource);
  assert.notEqual(formatted.sourceHash, before.sourceHash);
  assert.equal(formatted.buildId, before.buildId);
  assert.deepEqual(diffCutAVIR(before, formatted).changes, []);

  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const dataEditIr = compile(program({ alpha: "4" }));
  const dataDiff = diffCutAVIR(before, dataEditIr);
  assert.ok(dataDiff.changes.some((change) => change.entity === "node" || change.entity === "signal"));
  assert.deepEqual(createIncrementalRenderPlan(dataEditIr, "main", previous).scenes.map((scene) => scene.status), ["miss", "hit"]);

  const targetEditIr = compile(program({ alphaTargetX: "100px" }));
  const targetDiff = diffCutAVIR(before, targetEditIr);
  assert.ok(targetDiff.changes.some((change) => change.entity === "signal"));
  assert.deepEqual(createIncrementalRenderPlan(targetEditIr, "main", previous).scenes.map((scene) => scene.status), ["miss", "hit"]);
});
