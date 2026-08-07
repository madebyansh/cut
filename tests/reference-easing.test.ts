import test from "node:test";
import assert from "node:assert/strict";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { ReferenceEasingConfigError, referenceEasingDiagnosticCode } from "../lib/runtime/reference/easing";
import { evaluateSignal } from "../lib/runtime/reference/signals";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function source(easing: string) {
  return `cut 0.4;
project "parameterized easing";
import { Rect } from "cut:visual";
import { cubicBezier, spring } from "@cut/motion";
timeline main(duration: 1s, fps: 2, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Rect(width: 8px, height: 8px) as box;
    animate box.x from 0px to 10px over 1s ease ${easing};
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function compile(value: string) {
  const parsed = parseCutLanguage(source(value));
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  const rectangle = Object.values(ir.nodes).find((node) => node.op === "cut.visual.rect")!;
  const property = rectangle.properties.x;
  assert.ok(property && "signal" in property);
  return { ir, signal: property.signal };
}

function midpoint(value: string) {
  const { ir, signal } = compile(value);
  const result = evaluateSignal(ir, signal, rational(1, 2));
  assert.equal(result.kind, "quantity");
  return Number(result.magnitude.numerator) / Number(result.magnitude.denominator);
}

test("cubicBezier executes all four authored control points", () => {
  const early = midpoint("cubicBezier(0.1, 0.9, 0.2, 0.8)"), late = midpoint("cubicBezier(0.9, 0.1, 0.8, 0.2)");
  assert.ok(early > late + 4, `${early} must materially exceed ${late}`);
  assert.equal(midpoint("cubicBezier(0.1, 0.9, 0.2, 0.8)"), early, "easing replay must be exact within one toolchain");
});

test("spring executes mass, stiffness, and damping instead of a fixed curve", () => {
  const loose = midpoint("spring(mass: 1, stiffness: 20, damping: 1)"), heavy = midpoint("spring(mass: 8, stiffness: 200, damping: 40)");
  assert.notEqual(loose, heavy);
  assert.ok(Math.abs(loose - heavy) > 0.1, `${loose} and ${heavy} must be observably different`);
});

test("invalid parameterized easing fails at its authored signal location before rendering", () => {
  const { ir } = compile("cubicBezier(1.2, 0, 0.5, 1)");
  ir.determinism.semantic = "locked";
  assert.throws(
    () => validateReferenceSession(ir),
    (error) => error instanceof ReferenceEasingConfigError
      && error.code === referenceEasingDiagnosticCode
      && /CUT easing at project\.cut:\d+:\d+ cubicBezier x1 and x2 must be between 0 and 1/.test(error.message),
  );
});
