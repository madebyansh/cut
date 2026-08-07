import test from "node:test";
import assert from "node:assert/strict";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { CutOutputContractError } from "../lib/language/output-contract";
import { parseCutLanguage } from "../lib/language/parser";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

const base = (timelineArgs = "duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz", sceneArgs = "duration: 1s", output = "render(main)") => `cut 0.4;
project "closed contracts";
timeline main(${timelineArgs}) { scene only(${sceneArgs}) {} }
export out = ${output};`;

test("timeline and scene argument sets are closed and reject duplicates at source spans", () => {
  const source = base("duration: 1s, fps: 24, invented: 1, duration: 2s", "duration: 1s, mystery: true, duration: 1s");
  const diagnostics = checkCutModule(parse(source)).diagnostics;
  assert.ok(diagnostics.some((item) => item.code === "CUT2065" && /timeline.*invented/.test(item.message)));
  assert.ok(diagnostics.some((item) => item.code === "CUT2065" && /scene.*mystery/.test(item.message)));
  assert.equal(diagnostics.filter((item) => item.code === "CUT2066" && /duration/.test(item.message)).length, 2);
  assert.throws(() => compileCutModule(parse(source)), CutCompileError);
});

test("project identity is singular instead of first-declaration-wins", () => {
  const source = base().replace('project "closed contracts";', 'project "first";\nproject "second";');
  const diagnostics = checkCutModule(parse(source)).diagnostics;
  assert.ok(diagnostics.some((item) => item.code === "CUT2069" && /exactly one project declaration, found 2/.test(item.message)));
  assert.throws(() => compileCutModule(parse(source)), CutCompileError);
});

test("set and animate reject non-node targets instead of disappearing during lowering", () => {
  const source = `cut 0.4;
project "closed mutation";
const level: Ratio = 0%;
timeline main(duration: 1s, fps: 24) {
  scene only(duration: 1s) { set level = 50%; animate level from 0% to 100% over 1s; }
}
export out = render(main);`;
  const diagnostics = checkCutModule(parse(source)).diagnostics.filter((item) => item.code === "CUT2067");
  assert.equal(diagnostics.length, 2);
  assert.throws(() => compileCutModule(parse(source)), CutCompileError);
});

test("render dimensions are checked canvas assertions and codec is a closed executable profile", () => {
  assert.throws(
    () => compileCutModule(parse(base(undefined, undefined, 'render(main, width: 999px, height: 777px, codec: "h264")'))),
    (error) => error instanceof CutOutputContractError && error.code === "CUT_OUTPUT_CANVAS_MISMATCH" && /project\.cut:\d+:\d+/.test(error.message),
  );

  const invalidCodec = base(undefined, undefined, 'render(main, codec: "definitely-not-a-codec")');
  assert.ok(checkCutModule(parse(invalidCodec)).diagnostics.some((item) => item.code === "CUT2068" && /h264/.test(item.message)));
  assert.throws(() => compileCutModule(parse(invalidCodec)), CutCompileError);

  const ir = compileCutModule(parse(base(undefined, undefined, 'render(main, width: 64px, height: 64px, codec: "h264")'))).ir;
  ir.determinism.semantic = "locked";
  assert.doesNotThrow(() => validateReferenceSession(ir));
  ir.outputs[0].parameters.codec = { kind: "string", value: "vp9" };
  assert.throws(() => validateReferenceSession(ir), (error) => error instanceof CutOutputContractError && error.code === "CUT_OUTPUT_CODEC");
});
