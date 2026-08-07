import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(imports: string, body: string) {
  return `cut 0.4;
project "unrelated visual contract proof";
${imports}
timeline main(duration: 1s, fps: 4, width: 96px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 96px, height: 64px, codec: "h264");`;
}

function compile(source: string) {
  const parsed = parseCutLanguage(source); assert.ok(parsed.module); assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module); assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir; ir.determinism.semantic = "locked"; return ir;
}

async function pixels(source: string, frame = 3) {
  const ir = compile(source), { composition } = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-visual-contract-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache")); await renderer.prepare();
  try { return (await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], frame)).data; }
  finally { renderer.close(); }
}

function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

test("static rotation executes on leaf shapes, paths, and geo visuals", async () => {
  const cases = [
    ['import { Rect } from "cut:visual";', (rotation: number) => `Rect(width: 34px, height: 10px, fill: #ef233c, rotation: ${rotation}deg);`],
    ['import { Trace } from "cut:visual";', (rotation: number) => `Trace(points: [{ x: 8px, y: 16px }, { x: 70px, y: 20px }, { x: 82px, y: 52px }], stroke: #2ec4b6, width: 5px, duration: 400ms, rotation: ${rotation}deg);`],
    ['import { Map } from "@cut/geo";', (rotation: number) => `Map(rotation: ${rotation}deg);`],
  ] as const;
  for (const [imports, body] of cases) {
    const identity = await pixels(program(imports, body(0))), rotated = await pixels(program(imports, body(45)));
    assert.notEqual(digest(identity), digest(rotated), body(45));
  }

  const staticRotation = await pixels(program('import { Rect } from "cut:visual";', 'Rect(width: 34px, height: 10px, fill: #ef233c, rotation: 45deg);'));
  const propertyRotation = await pixels(program('import { Rect } from "cut:visual";', 'Rect(width: 34px, height: 10px, fill: #ef233c) as card; set card.rotation = 45deg;'));
  assert.equal(digest(staticRotation), digest(propertyRotation), "static and property transforms must share one meaning");
});

test("intrinsic primitive coordinates are not double-applied before a later transform-property write", async () => {
  const imports = 'import { Rect } from "cut:visual";';
  const staticOnly = program(imports, 'Rect(width: 18px, height: 12px, x: 20px, y: 18px, fill: #ef233c);');
  const futureWrite = program(imports, 'Rect(width: 18px, height: 12px, x: 20px, y: 18px, fill: #ef233c) as card; at 500ms { set card.x = 12px; }');
  assert.equal(digest(await pixels(staticOnly, 0)), digest(await pixels(futureWrite, 0)), "pre-write geometry must use only the intrinsic x input");
  assert.notEqual(digest(await pixels(staticOnly, 3)), digest(await pixels(futureWrite, 3)), "the later x property must execute as an independent transform");
});

test("shared transform preflight rejects clamped or unsafe values with stable source diagnostics", () => {
  for (const [body, code] of [
    ['Rect(width: 20px, height: 10px, opacity: 200%);', "CUT_VISUAL_VALUE_RANGE"],
    ['Rect(width: 20px, height: 10px, scale: -1);', "CUT_VISUAL_VALUE_RANGE"],
    ['Rect(width: 20px, height: 10px, scale: 64);', "CUT_VISUAL_VALUE_RANGE"],
  ] as const) {
    const ir = compile(program('import { Rect } from "cut:visual";', body));
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceVisualConfigError); assert.equal(error.code, code); assert.match(error.message, /project\.cut:\d+:\d+/); return true;
    });
  }
});

test("Wavefront has explicit canvas/map/globe origins and executes static reveal", async () => {
  const imports = 'import { Wavefront } from "@cut/geo";';
  const hidden = await pixels(program(imports, 'Wavefront(projection: "canvas", x: 20px, y: 24px, radius: 28px, count: 1, reveal: 0%);'), 0);
  const shown = await pixels(program(imports, 'Wavefront(projection: "canvas", x: 20px, y: 24px, radius: 28px, count: 1, reveal: 100%);'), 0);
  assert.notEqual(digest(hidden), digest(shown), "authored reveal must override time-derived progress");

  const india = await pixels(program(imports, 'Wavefront(origin: { latitude: 20, longitude: 78 }, radius: 18px, count: 1, reveal: 100%);'), 0);
  const brazil = await pixels(program(imports, 'Wavefront(origin: { latitude: -10, longitude: -52 }, radius: 18px, count: 1, reveal: 100%);'), 0);
  assert.notEqual(digest(india), digest(brazil), "a supplied geographic origin must affect the default map projection");
});

test("Wavefront projection combinations and enums fail rather than ignoring inputs", () => {
  const imports = 'import { Wavefront } from "@cut/geo";';
  const invalidEnum = parseCutLanguage(program(imports, 'Wavefront(projection: "planet", x: 20px, y: 20px);'));
  assert.ok(invalidEnum.module); assert.ok(checkCutModule(invalidEnum.module).diagnostics.some((item) => item.code === "CUT2068"));

  for (const [body, code] of [
    ['Wavefront(origin: { latitude: 20, longitude: 78 }, projection: "canvas", x: 20px, y: 20px);', "CUT_VISUAL_INPUT_COMBINATION"],
    ['Wavefront(projection: "map");', "CUT_VISUAL_INPUT_TYPE"],
    ['Wavefront(origin: { latitude: 20, longitude: 78 }, projection: "map", x: 20px);', "CUT_VISUAL_INPUT_COMBINATION"],
  ] as const) {
    const ir = compile(program(imports, body));
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceVisualConfigError); assert.equal(error.code, code); assert.match(error.message, /project\.cut:\d+:\d+/); return true;
    });
  }
});
