import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { applyReferenceVisualEffect } from "../lib/runtime/reference/visual-effects";

function program(body: string, width = 17, height = 17) {
  return `cut 0.4;
project "reference effects";
import { Blur, Glow, Group, Rect, Shadow, Vignette } from "cut:visual";
timeline main(duration: 1s, fps: 1, width: ${width}px, height: ${height}px, sampleRate: 8khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(body: string, width = 17, height = 17) {
  const ir = compileCutModule(parse(program(body, width, height))).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function sha256(data: Uint8Array) { return createHash("sha256").update(data).digest("hex"); }

async function render(body: string, width = 17, height = 17, includeDeliveryBackground = true) {
  const ir = compile(body, width, height), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-effect-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try { return { ir, frame: await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, includeDeliveryBackground) }; }
  finally { renderer.close(); }
}

test("visual-effect package parameters are closed and statically typed", () => {
  const invalid = [
    ['Blur(radius: 50%) { Rect(width: 4px, height: 4px); }', /radius.*expects Length.*Ratio/],
    ['Shadow(opacity: 2px) { Rect(width: 4px, height: 4px); }', /opacity.*expects Ratio.*Length/],
    ['Glow(color: "red") { Rect(width: 4px, height: 4px); }', /color.*expects Color.*String/],
    ['Vignette(radius: 2px) { Rect(width: 4px, height: 4px); }', /radius.*expects Ratio.*Length/],
    ['Blur(radius: 2px, invented: 1) { Rect(width: 4px, height: 4px); }', /does not execute input “invented”/],
  ] as const;
  for (const [body, expected] of invalid) {
    const cutModule = parse(program(body)), messages = checkCutModule(cutModule).diagnostics.map((item) => item.message).join("\n");
    assert.match(messages, expected);
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }

  const animated = parse(program('Blur(radius: 2px) as softened { Rect(width: 4px, height: 4px); } animate softened.radius from 1px to 4px over 1s;'));
  assert.match(checkCutModule(animated).diagnostics.map((item) => item.message).join("\n"), /no executable property “radius”/);
  assert.throws(() => compileCutModule(animated), CutCompileError);
});

test("effect bounds and unary shape fail before native image work", () => {
  const failures: Array<[string, RegExp]> = [
    ['Blur(radius: 0.2px) { Rect(width: 4px, height: 4px); }', /0px or at least 0.3px/],
    ['Blur(radius: 65px) { Rect(width: 4px, height: 4px); }', /between 0 and 64/],
    ['Shadow(x: 0.5px) { Rect(width: 4px, height: 4px); }', /exact integer pixel offset/],
    ['Shadow(y: 4097px) { Rect(width: 4px, height: 4px); }', /between -4096 and 4096/],
    ['Vignette(amount: 101%) { Rect(width: 4px, height: 4px); }', /between 0 and 1/],
    ['Vignette(softness: 0%) { Rect(width: 4px, height: 4px); }', /greater than 0/],
  ];
  for (const [body, expected] of failures) assert.throws(() => validateReferenceSession(compile(body)), expected);

  for (const body of [
    'Blur(radius: 2px);',
    'Glow() { Rect(width: 4px, height: 4px); Rect(width: 4px, height: 4px); }',
  ]) {
    assert.throws(() => compile(body), (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT2085" && /requires exactly one visual child/.test(item.message)));
  }

  const corrupted = compile('Shadow(color: #ff0000) { Rect(width: 4px, height: 4px); }');
  const shadow = Object.values(corrupted.nodes).find((node) => node.op === "cut.visual.shadow")!;
  shadow.inputs.color = { kind: "string", value: "red" };
  assert.throws(() => validateReferenceSession(corrupted), /six- or eight-digit CUT color literal/);
});

test("direct kernels preserve dimensions and implement alpha and linear-light boundaries", async () => {
  const data = Buffer.alloc(5 * 5 * 4), center = (2 * 5 + 2) * 4;
  data.set([255, 255, 255, 255], center);
  const source = { data, width: 5, height: 5 };
  await assert.rejects(() => applyReferenceVisualEffect({ kind: "blur", radius: 1 }, { ...source, alphaMode: "premultiplied" }), /require a straight-alpha RGBA boundary/);
  await assert.rejects(() => applyReferenceVisualEffect({ kind: "blur", radius: Number.POSITIVE_INFINITY }, source), /finite Gaussian sigma/);
  await assert.rejects(() => applyReferenceVisualEffect({ kind: "shadow", x: 4_097, y: 0, radius: 0, color: "#000000", opacity: 1 }, source), /offsets must be exact integers/);

  const shadow = await applyReferenceVisualEffect({ kind: "shadow", x: 1, y: 1, radius: 0, color: "#ff0000", opacity: 1 }, source);
  assert.deepEqual([shadow.width, shadow.height], [5, 5]);
  assert.deepEqual(pixel(shadow, 2, 2), [255, 255, 255, 255]);
  assert.deepEqual(pixel(shadow, 3, 3), [255, 0, 0, 255]);
  assert.deepEqual(pixel(shadow, 1, 1), [0, 0, 0, 0]);

  const glow = await applyReferenceVisualEffect({ kind: "glow", radius: 1, color: "#00ffff80", opacity: 0.5 }, source);
  assert.deepEqual([glow.width, glow.height], [5, 5]);
  assert.deepEqual(pixel(glow, 2, 2), [255, 255, 255, 255]);
  assert.ok(pixel(glow, 2, 1)[3] > 0 && pixel(glow, 2, 1)[3] < 128, "glow coverage includes color alpha and effect opacity");

  const blurred = await applyReferenceVisualEffect({ kind: "blur", radius: 1 }, source);
  assert.deepEqual([blurred.width, blurred.height], [5, 5]);
  assert.ok(pixel(blurred, 2, 2)[3] < 255 && pixel(blurred, 2, 2)[3] > pixel(blurred, 0, 0)[3]);
  assert.deepEqual(pixel(blurred, 2, 1).slice(0, 3), [255, 255, 255], "premultiplied blur does not create dark color fringes where alpha is nonzero");

  const alphaShape = { data: Buffer.alloc(9 * 9 * 4), width: 9, height: 9 };
  const alphaLevels = [0, 1, 24, 96, 255];
  for (let index = 0; index < 9 * 9; index += 1) {
    alphaShape.data.set([64, 64, 64, alphaLevels[index % alphaLevels.length]], index * 4);
  }
  for (const radius of [1, 2, 8]) {
    const constantColor = await applyReferenceVisualEffect({ kind: "blur", radius }, alphaShape);
    for (let index = 0; index < 9 * 9; index += 1) {
      const blurredPixel = pixel(constantColor, index % 9, Math.floor(index / 9));
      if (blurredPixel[3] > 0) {
        assert.ok(blurredPixel.slice(0, 3).every((value) => Math.abs(value - 64) <= 1), `radius ${radius} must not invent contrast while spreading nonuniform alpha`);
      }
    }
  }

  const opaque = { data: Buffer.alloc(5 * 5 * 4), width: 5, height: 5 };
  for (let offset = 0; offset < opaque.data.length; offset += 4) opaque.data.set([128, 128, 128, 255], offset);
  const vignette = await applyReferenceVisualEffect({ kind: "vignette", amount: 1, radius: 0, softness: 1, color: "#000000" }, opaque);
  assert.deepEqual(pixel(vignette, 2, 2), [128, 128, 128, 255]);
  assert.ok(pixel(vignette, 0, 0)[0] < pixel(vignette, 2, 2)[0]);
  assert.ok(Array.from({ length: 25 }, (_, index) => vignette.data[index * 4 + 3]).every((alpha) => alpha === 255), "vignette preserves child alpha");
});

test("public Shadow and Glow opacity controls affect only the authored halo, never the child or whole result", async () => {
  const shadow = await render(
    "Shadow(x: 4px, y: 0px, radius: 0px, color: #ff0000, opacity: 50%) { Rect(width: 3px, height: 3px, x: 5px, y: 8px, fill: #ffffff); }",
    17,
    17,
    false,
  );
  assert.deepEqual(pixel(shadow.frame, 5, 8), [255, 255, 255, 255], "Shadow opacity must not dim the unchanged child");
  assert.deepEqual(pixel(shadow.frame, 9, 8), [255, 0, 0, 128], "Shadow opacity must execute once on shadow coverage");

  const glow = await render(
    "Glow(radius: 1px, color: #00ffff, opacity: 50%) { Rect(width: 5px, height: 5px, x: 8px, y: 8px, fill: #ffffff); }",
    17,
    17,
    false,
  );
  assert.deepEqual(pixel(glow.frame, 8, 8), [255, 255, 255, 255], "Glow opacity must not dim the unchanged child");
  const neighbor = pixel(glow.frame, 8, 4);
  assert.ok(neighbor[1] > neighbor[0] && neighbor[2] > neighbor[0], "neighboring halo keeps the authored cyan bias");
  assert.ok(neighbor[3] > 0 && neighbor[3] < 128, `Glow opacity must execute once on blurred halo coverage; got ${JSON.stringify(neighbor)}`);
});

test("typed CUT lowers, fingerprints, chains in authored order, and reaches deterministic pixels", async () => {
  const sources = {
    blur: 'Blur(radius: 1px) { Rect(width: 5px, height: 5px, x: 8px, y: 8px, fill: #ffffff); }',
    shadow: 'Shadow(x: 2px, y: 1px, radius: 0px, color: #ff3355, opacity: 75%) { Rect(width: 5px, height: 5px, x: 8px, y: 8px, fill: #f8fafc); }',
    glow: 'Glow(radius: 1px, color: #22d3ee, opacity: 80%) { Rect(width: 5px, height: 5px, x: 8px, y: 8px, fill: #ffffff); }',
    vignette: 'Vignette(amount: 80%, radius: 20%, softness: 80%, color: #050b10) { Rect(width: 17px, height: 17px, x: 8px, y: 8px, fill: #e2e8f0); }',
  } as const;
  const frames = await Promise.all(Object.entries(sources).map(async ([name, body]) => [name, await render(body)] as const));
  const expectedOps = { blur: "cut.visual.blur", shadow: "cut.visual.shadow", glow: "cut.visual.glow", vignette: "cut.visual.vignette" } as const;
  const expectedHashes = {
    blur: "8214f02557119889b3a047e7d4bfba1bbd7c3816b821d0c34b18126e9f853345",
    shadow: "30e0498feb99622daf6f3ef1ba0223f485b8e7c0870d6fc05ab6b47fee7b5e79",
    glow: "371def5f193d8f0734afff462873f61cfe5d7cd137ef51e2ab8196c6342f137a",
    vignette: "238907218b8b11caa95168ae435c599de213549b30db0dbc2dae431b464e5caf",
  } as const;
  for (const [name, result] of frames) {
    const effect = Object.values(result.ir.nodes).find((node) => node.op === expectedOps[name as keyof typeof expectedOps])!;
    assert.equal(effect.children.length, 1);
    assert.match(effect.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(sha256(result.frame.data), expectedHashes[name as keyof typeof expectedHashes], `${name} pixel golden`);
  }

  const blurOne = compile(sources.blur), blurTwo = compile(sources.blur.replace("1px", "2px"));
  const oneNode = Object.values(blurOne.nodes).find((node) => node.op === "cut.visual.blur")!, twoNode = Object.values(blurTwo.nodes).find((node) => node.op === "cut.visual.blur")!;
  assert.notEqual(oneNode.contentHash, twoNode.contentHash, "authored effect parameters participate in node fingerprints");
  assert.notEqual(blurOne.buildId, blurTwo.buildId, "authored effect parameters participate in the graph identity");

  const blurThenShadow = await render('Shadow(x: 2px, y: 1px, radius: 0px, color: #ff3355, opacity: 75%) { Blur(radius: 1px) { Rect(width: 5px, height: 5px, x: 8px, y: 8px, fill: #ffffff); } }');
  const shadowThenBlur = await render('Blur(radius: 1px) { Shadow(x: 2px, y: 1px, radius: 0px, color: #ff3355, opacity: 75%) { Rect(width: 5px, height: 5px, x: 8px, y: 8px, fill: #ffffff); } }');
  assert.notEqual(sha256(blurThenShadow.frame.data), sha256(shadowThenBlur.frame.data), "nested unary effects execute inner-to-outer in authored source order");
});

test("asset-light product card fixture compiles and renders through only public CUT primitives", async () => {
  const source = await readFile(resolve("examples/product-card-effects.cut"), "utf8"), cutModule = parse(source), ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-product-card-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const frame = await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0);
    assert.equal(frame.data.byteLength, composition.width * composition.height * 4);
    assert.equal(Object.values(ir.nodes).filter((node) => ["cut.visual.blur", "cut.visual.shadow", "cut.visual.glow", "cut.visual.vignette"].includes(node.op)).length, 4);
  } finally { renderer.close(); }
});
