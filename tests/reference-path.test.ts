import test from "node:test";
import assert from "node:assert/strict";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const source = `cut 0.4;
project "reference path";
import { Path } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Path(points: [{ x: 40px, y: 180px }, { x: 320px, y: 40px }, { x: 600px, y: 180px }], stroke: #55d6be, width: 4px);
  }
}
export out = render(main);`;

function canonicalIr(mutate?: (node: IRNode) => void) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  const node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.path");
  assert.ok(node);
  mutate?.(node);
  finalizeGraphHashes(ir);
  return loadCutAvIr(JSON.stringify(ir));
}

function coordinate(x: IRValue, y: IRValue, extra?: IRValue): IRValue {
  return { kind: "object", entries: { x, y, ...(extra ? { extra } : {}) } };
}

const px = (value: number): IRValue => ({ kind: "quantity", dimension: "length", magnitude: rational(value), unit: "px" });

test("canonical loaded IR executes a bounded closed Path Vec2 contract", () => {
  assert.doesNotThrow(() => validateReferenceSession(canonicalIr()));

  const cases: Array<[(node: IRNode) => void, RegExp]> = [
    [(node) => { node.inputs.points = { kind: "string", value: "not points" }; }, /points must be a List<Vec2>/],
    [(node) => { node.inputs.points = { kind: "array", items: [coordinate(px(1), px(2))] }; }, /between 2 and 4096/],
    [(node) => { node.inputs.points = { kind: "array", items: Array.from({ length: 4_097 }, () => coordinate(px(1), px(2))) }; }, /between 2 and 4096/],
    [(node) => { node.inputs.points = { kind: "array", items: [coordinate(px(1), px(2), px(3)), coordinate(px(3), px(4))] }; }, /closed Vec2 with exactly x and y/],
    [(node) => { node.inputs.points = { kind: "array", items: [coordinate({ kind: "quantity", dimension: "scalar", magnitude: rational(1), unit: "scalar" }, px(2)), coordinate(px(3), px(4))] }; }, /points\[0\]\.x must be an exact Length/],
    [(node) => { node.inputs.points = { kind: "array", items: [coordinate(px(65_537), px(2)), coordinate(px(3), px(4))] }; }, /65536px coordinate limit/],
    [(node) => { node.inputs.width = px(0); }, /width must be greater than 0px/],
    [(node) => { node.inputs.stroke = { kind: "string", value: `#fff\"/><script>` }; }, /stroke must be a canonical Color/],
  ];

  for (const [mutate, expected] of cases) {
    const loaded = canonicalIr(mutate) as CutAVIR;
    assert.throws(() => validateReferenceSession(loaded), expected);
  }

  assert.throws(
    () => canonicalIr((node) => { node.inputs.fill = { kind: "color", value: "#ffffff" }; }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "CUT_IR_UNKNOWN_FIELD"
      && /inputs\.fill/.test(error.message),
    "the strict public loader must reject an undeclared Path paint before runtime",
  );
});
