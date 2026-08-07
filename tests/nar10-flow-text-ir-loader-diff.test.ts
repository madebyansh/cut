import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import {
  CutAvIrValidationError,
  loadCutAvIr,
} from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { finalizeGraphHashes } from "../lib/runtime/graph";

type FixtureOptions = Readonly<{
  paragraphDirection?: "ltr" | "rtl";
  language?: string;
  fallbackFonts?: string;
  content?: string;
  order?: "" | ', order: "visual"';
}>;

function fixture(options: FixtureOptions = {}) {
  const paragraphDirection = options.paragraphDirection ?? "rtl";
  const language = options.language ?? "ar";
  const fallbackFonts = options.fallbackFonts ?? "arabic, indic";
  const content = options.content ?? "CUT العربية";
  const order = options.order ?? ', order: "visual"';
  return `cut 0.4;
project "NAR-10 strict IR";
import { FlowText, textShaping, textSpan, textUnitMotion, textUnitPose } from "cut:visual";
asset primary: FontAsset = font("primary.ttf");
asset arabic: FontAsset = font("arabic.ttf");
asset indic: FontAsset = font("indic.ttf");
asset foreign: ImageAsset = image("foreign.png");
timeline main(duration: 2s, fps: 24, width: 640px, height: 360px) {
  scene only(duration: 2s) {
    FlowText(
      spans: [textSpan(id: "title", content: "${content}")],
      font: primary,
      size: 54px,
      color: #ffffff,
      shaping: textShaping(
        paragraphDirection: "${paragraphDirection}",
        language: "${language}",
        fallbackFonts: [${fallbackFonts}]
      ),
      motions: [
        textUnitMotion(
          span: "title",
          by: "cluster"${order},
          duration: 12f,
          from: textUnitPose(y: 12px, opacity: 0%),
          before: "from"
        )
      ],
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

function compile(options: FixtureOptions = {}) {
  const parsed = parseCutLanguage(fixture(options));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function flowNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.flow_text");
  assert.ok(node);
  return node;
}

function record(value: IRValue | undefined) {
  assert.equal(value?.kind, "object");
  return (value as Extract<IRValue, { kind: "object" }>).entries;
}

function array(value: IRValue | undefined) {
  assert.equal(value?.kind, "array");
  return (value as Extract<IRValue, { kind: "array" }>).items;
}

function hostile(mutate: (node: IRNode, ir: CutAVIR) => void) {
  const ir = compile(), node = flowNode(ir);
  mutate(node, ir);
  finalizeGraphHashes(ir);
  return () => loadCutAvIr(JSON.stringify(ir));
}

function expectStrictFailure(
  mutate: (node: IRNode, ir: CutAVIR) => void,
  code: CutAvIrValidationError["code"],
  path: RegExp,
) {
  assert.throws(hostile(mutate), (error: unknown) =>
    error instanceof CutAvIrValidationError
    && error.code === code
    && path.test(error.path));
}

test("strict loaded IR closes the shaped FlowText records without changing valid compiler output", () => {
  const ir = compile();
  const loaded = loadCutAvIr(JSON.stringify(ir));
  assert.equal(loaded.buildId, ir.buildId);
  const node = flowNode(loaded);
  assert.deepEqual(Object.keys(record(node.inputs.shaping)), [
    "paragraphDirection",
    "language",
    "fallbackFonts",
  ]);
  assert.equal(record(array(node.inputs.motions)[0]).by?.kind, "string");
});

test("fully rehashed hostile shaping, fallback, control, and selector combinations fail closed", () => {
  expectStrictFailure((node) => {
    record(node.inputs.shaping).paragraphDirection = { kind: "string", value: "auto" };
  }, "CUT_IR_ENUM", /inputs\.shaping\.entries\.paragraphDirection/u);

  expectStrictFailure((node) => {
    (array(record(node.inputs.shaping).fallbackFonts)[0] as Extract<IRValue, { kind: "resource-ref" }>).id = "foreign";
  }, "CUT_IR_TYPE", /inputs\.shaping\.entries\.fallbackFonts\.items\[0\]\.id/u);

  expectStrictFailure((node) => {
    (array(record(node.inputs.shaping).fallbackFonts)[0] as Extract<IRValue, { kind: "resource-ref" }>).id = "missing";
  }, "CUT_IR_REFERENCE", /fallbackFonts\.items\[0\]\.id|inputs\.shaping/u);

  expectStrictFailure((node) => {
    array(record(node.inputs.shaping).fallbackFonts)[1] = { kind: "resource-ref", id: "primary" };
  }, "CUT_IR_IDENTITY", /fallbackFonts\.items\[1\]\.id/u);

  expectStrictFailure((node) => {
    record(node.inputs.shaping).unknown = { kind: "null" };
  }, "CUT_IR_UNKNOWN_FIELD", /inputs\.shaping\.entries\.unknown/u);

  expectStrictFailure((node) => {
    record(array(node.inputs.spans)[0]).content = { kind: "string", value: "CUT\u202e123" };
  }, "CUT_IR_TYPE", /inputs\.spans\.items\[0\]\.entries\.content/u);

  expectStrictFailure((node) => {
    record(array(node.inputs.motions)[0]).order = { kind: "string", value: "paint" };
  }, "CUT_IR_ENUM", /inputs\.motions\.items\[0\]\.entries\.order/u);

  expectStrictFailure((node) => {
    record(array(node.inputs.motions)[0]).order = { kind: "string", value: "logical" };
  }, "CUT_IR_IDENTITY", /inputs\.motions\.items\[0\]\.entries\.order/u);

  expectStrictFailure((node) => {
    record(array(node.inputs.motions)[0]).by = { kind: "string", value: "glyph" };
  }, "CUT_IR_TYPE", /inputs\.motions\.items\[0\]\.entries\.by/u);

  expectStrictFailure((node) => {
    const motion = record(array(node.inputs.motions)[0]);
    motion.by = { kind: "string", value: "word" };
  }, "CUT_IR_TYPE", /inputs\.motions\.items\[0\]\.entries\.order/u);

  expectStrictFailure((node, ir) => {
    delete node.inputs.shaping;
    delete ir.features;
  }, "CUT_IR_TYPE", /inputs\.motions\.items\[0\]\.entries\.by/u);
});

function nodeChangePaths(before: CutAVIR, after: CutAVIR) {
  const changes = diffCutAVIR(before, after).changes.filter((change) => change.entity === "node");
  assert.equal(changes.length, 1, JSON.stringify(changes));
  const change = changes[0];
  assert.equal(change.operation, "modify");
  return change.operation === "modify" ? change.fields.map(({ path }) => path) : [];
}

test("direction, language, fallback order, text, and cluster order remain semantic changes", () => {
  const base = compile();
  const variants: Array<readonly [CutAVIR, RegExp]> = [
    [compile({ paragraphDirection: "ltr" }), /\/inputs\/shaping\/entries\/paragraphDirection\/value/u],
    [compile({ language: "hi-deva" }), /\/inputs\/shaping\/entries\/language\/value/u],
    [compile({ fallbackFonts: "indic, arabic" }), /\/inputs\/shaping\/entries\/fallbackFonts\/items\/[01]\/id/u],
    [compile({ content: "CUT العربية الآن" }), /\/inputs\/spans\/items\/0\/entries\/content\/value/u],
    [compile({ order: "" }), /\/inputs\/motions\/items\/0\/entries\/order/u],
  ];
  for (const [variant, expectedPath] of variants) {
    assert.equal(loadCutAvIr(JSON.stringify(variant)).buildId, variant.buildId);
    assert.ok(
      nodeChangePaths(base, variant).some((path) => expectedPath.test(path)),
      `${expectedPath} was absent from ${JSON.stringify(nodeChangePaths(base, variant))}`,
    );
  }
});
