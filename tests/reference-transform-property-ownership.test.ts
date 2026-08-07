import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { rational, rationalToNumber } from "../lib/language/rational";
import { propertyAt } from "../lib/runtime/reference/signals";
import { referenceVisualTransformAt, validateReferenceVisualTransform } from "../lib/runtime/reference/visual-config";

function compile(body: string) {
  const source = `cut 0.4;
project "transform property ownership";
import { Globe } from "@cut/geo";
timeline main(duration: 1s, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 1920px, height: 1080px, codec: "h264");`;
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(parsed.module).ir;
}

test("animated Globe rotation remains geographic state and cannot inflate generic compositor allocation", () => {
  const ir = compile(`
    Globe(rotation: 45deg, scale: 5) as globe;
    animate globe.rotation from 45deg to 46deg over 1s;
  `);
  const composition = ir.compositions[0]!;
  const globe = Object.values(ir.nodes).find((node) => node.op === "cut.geo.globe")!;

  // The public signal still carries the geographic longitude sampled by the
  // Globe executor; it is not discarded to make generic validation pass.
  const geographicRotation = propertyAt(ir, globe, "rotation", rational(0));
  assert.equal(geographicRotation?.kind, "quantity");
  assert.equal(geographicRotation?.kind === "quantity" ? rationalToNumber(geographicRotation.magnitude) : Number.NaN, 45);
  validateReferenceVisualTransform(ir, composition, globe);

  // 1920x1080 at scale 5 is within the compositor's scalar/pixel ceiling, but
  // combining it with a generic 45-degree rotation would falsely estimate a
  // >67M-pixel intermediate. Globe rotation belongs only to geo projection.
  const transform = referenceVisualTransformAt(
    ir,
    composition,
    globe,
    rational(0),
    { staticPosition: false, staticRotation: false },
  );
  assert.equal(transform.scale, 5);
  assert.equal(transform.rotation, 0);
});
