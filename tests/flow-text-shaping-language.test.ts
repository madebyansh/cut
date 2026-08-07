import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { IRNode, IRValue } from "../lib/language/ir";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { builtinPackages } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";

function source(profile: string, motion: string) {
  return `cut 0.4;
project "FlowText shaping language";
import { FlowText, textShaping, textSpan, textUnitMotion, textUnitPose } from "cut:visual";
asset primary: FontAsset = font("primary.ttf");
asset arabic: FontAsset = font("arabic.ttf");
asset fallback: FontAsset = font("fallback.ttf");
timeline main(duration: 2s, fps: 24, width: 640px, height: 360px) {
  scene only(duration: 2s) {
    FlowText(
      spans: [textSpan(id: "title", content: "CUT 10")],
      font: primary,
      size: 54px,
      color: #ffffff,
      ${profile}
      motions: [${motion}],
      layoutX: 40px,
      baselineY: 100px,
      maxWidth: 560px,
      lineHeight: 64px,
      maxLines: 2
    );
  }
}
export preview = render(main, width: 640px, height: 360px, codec: "h264");
`;
}

function parsed(sourceText: string) {
  const result = parseCutLanguage(sourceText);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function flowNode(sourceText: string): IRNode {
  const checked = checkCutModule(parsed(sourceText));
  assert.deepEqual(checked.diagnostics, []);
  const ir = compileCutModule(parsed(sourceText)).ir;
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.flow_text");
  assert.ok(node);
  return node;
}

function object(value: IRValue | undefined) {
  assert.equal(value?.kind, "object");
  return (value as Extract<IRValue, { kind: "object" }>).entries;
}

test("public textShaping and cluster motion lower to closed typed IR records", () => {
  const node = flowNode(source(
    'shaping: textShaping(paragraphDirection: "rtl", language: "ar", fallbackFonts: [arabic, fallback]),',
    'textUnitMotion(span: "title", by: "cluster", order: "visual", each: 1f, duration: 12f, from: textUnitPose(y: 12px, opacity: 0%), before: "from")',
  ));
  const shaping = object(node.inputs.shaping);
  assert.deepEqual(Object.keys(shaping), ["paragraphDirection", "language", "fallbackFonts"]);
  assert.deepEqual(shaping.paragraphDirection, { kind: "string", value: "rtl" });
  assert.deepEqual(shaping.language, { kind: "string", value: "ar" });
  assert.equal(shaping.fallbackFonts?.kind, "array");
  assert.deepEqual(
    (shaping.fallbackFonts as Extract<IRValue, { kind: "array" }>).items,
    [{ kind: "resource-ref", id: "arabic" }, { kind: "resource-ref", id: "fallback" }],
  );

  assert.equal(node.inputs.motions?.kind, "array");
  const motion = object((node.inputs.motions as Extract<IRValue, { kind: "array" }>).items[0]);
  assert.deepEqual(Object.keys(motion), ["span", "by", "order", "each", "duration", "from", "before"]);
  assert.deepEqual(motion.by, { kind: "string", value: "cluster" });
  assert.deepEqual(motion.order, { kind: "string", value: "visual" });
});

test("omitting textShaping and motion order preserves the legacy FlowText IR surface", () => {
  const node = flowNode(source(
    "",
    'textUnitMotion(span: "title", by: "glyph", each: 1f, duration: 12f, from: textUnitPose(y: 12px, opacity: 0%), before: "from")',
  ));
  assert.equal(node.inputs.shaping, undefined);
  assert.equal(node.inputs.motions?.kind, "array");
  const motion = object((node.inputs.motions as Extract<IRValue, { kind: "array" }>).items[0]);
  assert.deepEqual(Object.keys(motion), ["span", "by", "each", "duration", "from", "before"]);
  assert.equal(motion.order, undefined);
  assert.deepEqual(motion.by, { kind: "string", value: "glyph" });
});

test("the package and kernel contracts expose only the additive shaping surface", () => {
  const visual = builtinPackages.get("cut:visual");
  assert.ok(visual);
  assert.deepEqual(visual.symbols.textShaping?.parameters?.map(({ name, type, optional, values }) => ({
    name,
    type,
    optional: optional ?? false,
    values: values ?? null,
  })), [
    { name: "paragraphDirection", type: "String", optional: false, values: ["ltr", "rtl"] },
    { name: "language", type: "String", optional: false, values: null },
    { name: "fallbackFonts", type: "List<FontAsset>", optional: false, values: null },
  ]);
  assert.equal(visual.symbols.textShaping?.returns, "TextShaping");
  assert.equal(visual.symbols.textShaping?.lowering, "record");
  assert.equal(visual.symbols.FlowText?.parameters?.find(({ name }) => name === "shaping")?.type, "TextShaping");
  assert.deepEqual(
    visual.symbols.textUnitMotion?.parameters?.find(({ name }) => name === "by")?.values,
    ["line", "word", "glyph", "cluster"],
  );
  assert.deepEqual(
    visual.symbols.textUnitMotion?.parameters?.find(({ name }) => name === "order")?.values,
    ["logical", "visual"],
  );
  const kernel = referenceKernelSchema("cut.visual.flow_text");
  assert.equal(kernel?.support, "supported");
  assert.ok(kernel?.inputs.includes("shaping"));
});

test("textShaping direction, language, fallback, motion unit, and order remain closed at source", () => {
  const cases = [
    {
      source: source(
        'shaping: textShaping(paragraphDirection: "auto", language: "ar", fallbackFonts: [arabic]),',
        'textUnitMotion(span: "title", by: "cluster", duration: 12f, from: textUnitPose(y: 12px))',
      ),
      pattern: /paragraphDirection|auto|ltr|rtl/u,
    },
    {
      source: source(
        'shaping: textShaping(paragraphDirection: "rtl", language: 1, fallbackFonts: [arabic]),',
        'textUnitMotion(span: "title", by: "cluster", duration: 12f, from: textUnitPose(y: 12px))',
      ),
      pattern: /language|String|Number/u,
    },
    {
      source: source(
        'shaping: textShaping(paragraphDirection: "rtl", language: "ar", fallbackFonts: ["Arial"]),',
        'textUnitMotion(span: "title", by: "cluster", duration: 12f, from: textUnitPose(y: 12px))',
      ),
      pattern: /fallbackFonts|FontAsset|String/u,
    },
    {
      source: source(
        'shaping: textShaping(paragraphDirection: "rtl", language: "ar", fallbackFonts: [arabic], script: "Arab"),',
        'textUnitMotion(span: "title", by: "cluster", duration: 12f, from: textUnitPose(y: 12px))',
      ),
      pattern: /script|argument|textShaping/u,
    },
    {
      source: source(
        'shaping: textShaping(paragraphDirection: "rtl", language: "ar", fallbackFonts: [arabic]),',
        'textUnitMotion(span: "title", by: "codepoint", duration: 12f, from: textUnitPose(y: 12px))',
      ),
      pattern: /codepoint|line|word|glyph|cluster/u,
    },
    {
      source: source(
        'shaping: textShaping(paragraphDirection: "rtl", language: "ar", fallbackFonts: [arabic]),',
        'textUnitMotion(span: "title", by: "cluster", order: "paint", duration: 12f, from: textUnitPose(y: 12px))',
      ),
      pattern: /order|paint|logical|visual/u,
    },
  ];
  for (const fixture of cases) {
    const diagnostics = checkCutModule(parsed(fixture.source)).diagnostics;
    assert.ok(diagnostics.some(({ message }) => fixture.pattern.test(message)), diagnostics.map(({ message }) => message).join("\n"));
  }
});
