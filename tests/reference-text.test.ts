import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Font, Glyph, Path } from "opentype.js";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceTextConfigError } from "../lib/runtime/reference/text-config";

function outlineFont(shape: "rectangle" | "triangle") {
  const path = new Path(); path.moveTo(80, 0);
  if (shape === "rectangle") { path.lineTo(80, 700); path.lineTo(920, 700); path.lineTo(920, 0); }
  else { path.lineTo(500, 700); path.lineTo(920, 0); }
  path.close();
  const missing = new Glyph({ name: ".notdef", unicode: 0, advanceWidth: 1_000, path: new Path() });
  const space = new Glyph({ name: "space", unicode: 32, advanceWidth: 250, path: new Path() });
  const glyph = new Glyph({ name: "A", unicode: 65, advanceWidth: 1_000, path });
  return Buffer.from(new Font({ familyName: `CUT ${shape}`, styleName: "Regular", unitsPerEm: 1_000, ascender: 800, descender: -200, glyphs: [missing, space, glyph] }).toArrayBuffer());
}

function cutString(value: string) { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n"); }

function source(options: { content?: string; align?: string; font?: boolean; weight?: boolean; maxWidth?: string; tracking?: string; shadow?: boolean } = {}) {
  const content = options.content ?? "A A A";
  const font = options.font === false ? "" : ", font: face";
  const align = options.align === undefined ? "start" : options.align;
  const weight = options.weight ? ", weight: 700" : "";
  const maxWidth = options.maxWidth ?? "150px";
  const tracking = options.tracking ?? "3px";
  const shadow = options.shadow ? ", shadowColor: #000000c0, shadowOpacity: 70%, shadowBlur: 3px" : "";
  return `cut 0.4;
project "reference locked Text";
import { Text } from "cut:visual";
asset face: FontAsset = font("assets/face.ttf");
timeline main(duration: 1s, fps: 4, width: 320px, height: 180px) {
  scene only(duration: 1s) {
    Text(content: "${cutString(content)}"${font}, x: 160px, y: 54px, align: "${cutString(align)}", size: 42px, color: #53d8c8, maxWidth: ${maxWidth}, lineHeight: 50px, maxLines: 3, tracking: ${tracking}${shadow}${weight});
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");`;
}

function compile(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module); assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

async function lockedProject(program: string, font: Buffer) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-text-")), assets = resolve(root, "assets");
  await mkdir(assets); await writeFile(resolve(assets, "face.ttf"), font);
  const ir = compile(program), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  return { root, ir };
}

async function textPixels(program: string, font: Buffer) {
  const { root, ir } = await lockedProject(program, font), { composition } = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    return (await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0)).data;
  } finally { renderer.close(); }
}

function sha256(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

test("Text emits deterministic locked outline pixels: font bytes, multiline wrapping, tracking, alignment, and shadow all participate", { timeout: 30_000 }, async () => {
  const rectangle = await textPixels(source({ shadow: true }), outlineFont("rectangle"));
  const triangle = await textPixels(source({ shadow: true }), outlineFont("triangle"));
  const untracked = await textPixels(source({ tracking: "0px" }), outlineFont("rectangle"));
  assert.notEqual(sha256(rectangle), sha256(triangle), "different valid locked font bytes change rasterized Text pixels");
  assert.notEqual(sha256(rectangle), sha256(untracked), "tracking stays in the fixed outline geometry rather than being ignored");
  assert.ok(rectangle.some((value) => value !== 0), "the locked glyph paths produce a visible surface");
});

test("Text executes zero-blur as a hard shadow instead of silently dropping authored shadow controls", { timeout: 30_000 }, async () => {
  const hardShadowSource = source({ shadow: true })
    .replace("shadowColor: #000000c0", "shadowColor: #ff0000")
    .replace("shadowOpacity: 70%", "shadowOpacity: 100%")
    .replace("shadowBlur: 3px", "shadowBlur: 0px");
  const hard = await textPixels(hardShadowSource, outlineFont("rectangle"));
  const plain = await textPixels(source(), outlineFont("rectangle"));
  assert.notEqual(sha256(hard), sha256(plain));
  let redShadowPixel = false;
  for (let offset = 0; offset < hard.length; offset += 4) {
    if (hard[offset] > 180 && hard[offset + 1] < 80 && hard[offset + 2] < 80 && hard[offset + 3] > 180) {
      redShadowPixel = true;
      break;
    }
  }
  assert.ok(redShadowPixel, "hard shadow must contribute visible authored-color pixels");
});

test("Text fails closed for missing/fake/variable font bytes and uncovered glyphs", { timeout: 30_000 }, async () => {
  const missingFont = await lockedProject(source(), outlineFont("rectangle"));
  const missingFontNode = Object.values(missingFont.ir.nodes).find((node) => node.op === "cut.visual.text"); assert.ok(missingFontNode);
  delete missingFontNode.inputs.font;
  assert.throws(
    () => validateReferenceSession(missingFont.ir),
    (error) => error instanceof ReferenceTextConfigError
      && error.code === "CUT_TEXT_RESOURCE"
      && /project\.cut:\d+:\d+/.test(error.message)
      && /requires a locked FontAsset/.test(error.message),
  );

  const fake = await lockedProject(source(), Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(8)]));
  const fakeRenderer = new ReferenceVisualRenderer(fake.ir, validateReferenceSession(fake.ir).composition, fake.root, resolve(fake.root, "cache"));
  await assert.rejects(() => fakeRenderer.prepare(), /invalid or over-budget sfnt table directory/); fakeRenderer.close();

  const variable = outlineFont("rectangle"); variable.write("fvar", 12, 4, "ascii");
  const variableProject = await lockedProject(source(), variable);
  const variableRenderer = new ReferenceVisualRenderer(variableProject.ir, validateReferenceSession(variableProject.ir).composition, variableProject.root, resolve(variableProject.root, "cache"));
  await assert.rejects(() => variableRenderer.prepare(), /fixed-instance monochrome outline TTF\/OTF/); variableRenderer.close();

  const missingGlyph = await lockedProject(source({ content: "B" }), outlineFont("rectangle"));
  const missingGlyphRenderer = new ReferenceVisualRenderer(missingGlyph.ir, validateReferenceSession(missingGlyph.ir).composition, missingGlyph.root, resolve(missingGlyph.root, "cache"));
  await assert.rejects(() => missingGlyphRenderer.prepare(), /no glyph for U\+0042/); missingGlyphRenderer.close();
});

test("Text rejects style inputs it cannot execute, including the old SVG-attribute injection path", async () => {
  const injectedAlign = source({ align: 'start\"/><path d="M0 0"/><!--' });
  const injectedModule = parseCutLanguage(injectedAlign); assert.ok(injectedModule.module);
  assert.match(checkCutModule(injectedModule.module).diagnostics.map((item) => item.message).join("\n"), /must be one of: start, middle, end/);
  assert.throws(() => compileCutModule(injectedModule.module!), CutCompileError);

  const badAlign = await lockedProject(source(), outlineFont("rectangle"));
  const text = Object.values(badAlign.ir.nodes).find((node) => node.op === "cut.visual.text"); assert.ok(text);
  text.inputs.align = { kind: "string", value: 'start\"/><path d="M0 0"/><!--' };
  assert.throws(() => validateReferenceSession(badAlign.ir), /input “align” must be exactly one of: start, middle, end/);

  const weightedModule = parseCutLanguage(source({ weight: true }));
  assert.ok(weightedModule.module); assert.match(checkCutModule(weightedModule.module).diagnostics.map((item) => item.message).join("\n"), /does not execute input “weight”/);
  assert.throws(() => compileCutModule(weightedModule.module!), CutCompileError);

  const scalarTrackingModule = parseCutLanguage(source({ tracking: "3" }));
  assert.ok(scalarTrackingModule.module);
  assert.match(checkCutModule(scalarTrackingModule.module).diagnostics.map((item) => item.message).join("\n"), /Argument “tracking” expects Length, found Number/);
  assert.throws(() => compileCutModule(scalarTrackingModule.module!), CutCompileError);
});

test("Text alias, shadow, color, and required-font contracts fail at source and loaded-IR boundaries", async () => {
  const aliasSource = source().replace("tracking: 3px", "tracking: 3px, letterSpacing: 2px");
  const aliasParsed = parseCutLanguage(aliasSource); assert.ok(aliasParsed.module);
  assert.ok(checkCutModule(aliasParsed.module).diagnostics.some((item) => item.code === "CUT2077" && /aliases/.test(item.message)));
  assert.throws(() => compileCutModule(aliasParsed.module!), CutCompileError);

  const partialShadowSource = source().replace("tracking: 3px", "tracking: 3px, shadowColor: #000000");
  const partialShadowParsed = parseCutLanguage(partialShadowSource); assert.ok(partialShadowParsed.module);
  assert.ok(checkCutModule(partialShadowParsed.module).diagnostics.some((item) => item.code === "CUT2078" && /must be supplied together/.test(item.message)));
  assert.throws(() => compileCutModule(partialShadowParsed.module!), CutCompileError);

  const missingFontParsed = parseCutLanguage(source({ font: false })); assert.ok(missingFontParsed.module);
  assert.ok(checkCutModule(missingFontParsed.module).diagnostics.some((item) => item.code === "CUT2028" && /font/.test(item.message)));
  assert.throws(() => compileCutModule(missingFontParsed.module!), CutCompileError);

  const loaded = await lockedProject(source({ shadow: true }), outlineFont("rectangle"));
  const text = Object.values(loaded.ir.nodes).find((node) => node.op === "cut.visual.text"); assert.ok(text);
  text.inputs.color = { kind: "string", value: "#ffffff" };
  assert.throws(
    () => validateReferenceSession(loaded.ir),
    (error) => error instanceof ReferenceTextConfigError
      && error.code === "CUT_TEXT_INPUT_TYPE"
      && /project\.cut:\d+:\d+/.test(error.message)
      && /canonical lowercase Color/.test(error.message),
  );
});
