import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  applyReferenceVisualEffect,
  ReferenceVisualEffectError,
  referenceVisualEffectConfig,
} from "../lib/runtime/reference/visual-effects";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(body: string, options: { fps?: number; audio?: boolean } = {}) {
  const fps = options.fps ?? 2;
  return `cut 0.4;
project "extended visual effects";
import { Duotone, Grain, Rect, Sharpen } from "cut:visual";
${options.audio ? 'import { Tone } from "@cut/audio";' : ""}
timeline main(duration: 1s, fps: ${fps}, width: 8px, height: 8px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    ${body}
    ${options.audio ? "Tone(frequency: 440hz, duration: 1s);" : ""}
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(body: string, options: { fps?: number; audio?: boolean } = {}) {
  const ir = compileCutModule(parse(program(body, options))).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function digest(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function rgba(data: ReadonlyArray<readonly [number, number, number, number]>, width: number) {
  return { data: Buffer.from(data.flatMap((pixel) => [...pixel])), width, height: data.length / width };
}

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

type FrozenGrainConfig = Readonly<{
  kind: "grain";
  amount: number;
  size: number;
  seed: number;
  mode: "static" | "temporal";
  monochrome: boolean;
}>;

function frozenGrainMix32(value: number) {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb_352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846c_a68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function frozenGrainSample(seed: number, cellX: number, cellY: number, frame: number, channel: number) {
  let state = seed >>> 0;
  state = frozenGrainMix32(state ^ Math.imul((cellX + 1) >>> 0, 0x9e37_79b1));
  state = frozenGrainMix32(state ^ Math.imul((cellY + 1) >>> 0, 0x85eb_ca77));
  state = frozenGrainMix32(state ^ Math.imul((frame + 1) >>> 0, 0xc2b2_ae3d));
  state = frozenGrainMix32(state ^ Math.imul((channel + 1) >>> 0, 0x27d4_eb2f));
  return state / 0xffff_ffff * 2 - 1;
}

/** Frozen pre-optimization scalar law: one deterministic sample invocation per
 * covered pixel (and the intentionally redundant monochrome sample in color
 * mode). This remains independent of the runtime's cell traversal. */
function frozenScalarGrain(
  source: Readonly<{ data: Uint8Array; width: number; height: number }>,
  config: FrozenGrainConfig,
  frame: number,
) {
  const output = Buffer.from(source.data);
  const phase = config.mode === "temporal" ? frame : 0;
  const amplitude = config.amount * 64;
  for (let y = 0; y < source.height; y += 1) {
    const cellY = Math.floor(y / config.size);
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      if (source.data[offset + 3] === 0) continue;
      const cellX = Math.floor(x / config.size);
      const monochrome = frozenGrainSample(config.seed, cellX, cellY, phase, 0);
      for (let channel = 0; channel < 3; channel += 1) {
        const noise = config.monochrome
          ? monochrome
          : frozenGrainSample(config.seed, cellX, cellY, phase, channel);
        output[offset + channel] = Math.max(
          0,
          Math.min(255, Math.round(source.data[offset + channel] + noise * amplitude)),
        );
      }
    }
  }
  return output;
}

test("Sharpen, Grain, and Duotone are closed typed unary source APIs", () => {
  const valid = compile(`
    Grain(amount: 12%, size: 2px, seed: 42, mode: "temporal", monochrome: false) {
      Duotone(shadows: #102030, highlights: #f0e0d0, amount: 75%) {
        Sharpen(radius: 1px, amount: 50%) { Rect(width: 8px, height: 8px, fill: #607080); }
      }
    }
  `);
  for (const op of ["cut.visual.sharpen", "cut.visual.grain", "cut.visual.duotone"]) {
    const node = Object.values(valid.nodes).find((candidate) => candidate.op === op);
    assert.ok(node, op);
    assert.equal(node.children.length, 1);
    assert.match(node.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(referenceVisualEffectConfig(node));
  }

  const invalid = [
    ['Sharpen(radius: 50%) { Rect(width: 8px, height: 8px); }', /radius.*expects Length.*Ratio/],
    ['Grain(seed: 2px) { Rect(width: 8px, height: 8px); }', /seed.*expects Number.*Length/],
    ['Grain(mode: "drifting") { Rect(width: 8px, height: 8px); }', /mode.*must be one of.*static.*temporal/],
    ['Duotone(shadows: "black") { Rect(width: 8px, height: 8px); }', /shadows.*expects Color.*String/],
    ['Grain(invented: true) { Rect(width: 8px, height: 8px); }', /does not execute input “invented”/],
  ] as const;
  for (const [body, expected] of invalid) {
    const cutModule = parse(program(body));
    assert.match(checkCutModule(cutModule).diagnostics.map((item) => item.message).join("\n"), expected);
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }

  const badShape = parse(program('Duotone() { Rect(width: 8px, height: 8px); Rect(width: 8px, height: 8px); }'));
  assert.throws(() => compileCutModule(badShape), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT2085" && /requires exactly one visual child/.test(item.message)));

  const dynamic = parse(program('Grain(amount: 10%) as texture { Rect(width: 8px, height: 8px); } animate texture.amount from 0% to 100% over 1s;'));
  assert.match(checkCutModule(dynamic).diagnostics.map((item) => item.message).join("\n"), /no executable property “amount”/);
  assert.throws(() => compileCutModule(dynamic), CutCompileError);
});

test("new effect bounds and malformed loaded IR fail with stable source-located diagnostics before render", () => {
  const cases = [
    {
      body: 'Sharpen(radius: 1px) { Rect(width: 8px, height: 8px); }',
      op: "cut.visual.sharpen",
      mutate: (node: ReturnType<typeof Object.values>[number] & { inputs: Record<string, unknown> }) => { node.inputs.radius = { kind: "quantity", dimension: "length", magnitude: rational(17), unit: "px" }; },
      code: "CUT_VISUAL_EFFECT_RANGE",
    },
    {
      body: 'Grain(seed: 1) { Rect(width: 8px, height: 8px); }',
      op: "cut.visual.grain",
      mutate: (node: ReturnType<typeof Object.values>[number] & { inputs: Record<string, unknown> }) => { node.inputs.seed = { kind: "quantity", dimension: "scalar", magnitude: rational(1, 2), unit: "scalar" }; },
      code: "CUT_VISUAL_EFFECT_RANGE",
    },
    {
      body: 'Grain(size: 1px) { Rect(width: 8px, height: 8px); }',
      op: "cut.visual.grain",
      mutate: (node: ReturnType<typeof Object.values>[number] & { inputs: Record<string, unknown> }) => { node.inputs.size = { kind: "quantity", dimension: "length", magnitude: rational(65), unit: "px" }; },
      code: "CUT_VISUAL_EFFECT_RANGE",
    },
    {
      body: 'Grain(mode: "static") { Rect(width: 8px, height: 8px); }',
      op: "cut.visual.grain",
      mutate: (node: ReturnType<typeof Object.values>[number] & { inputs: Record<string, unknown> }) => { node.inputs.mode = { kind: "string", value: "drifting" }; },
      code: "CUT_VISUAL_EFFECT_INPUT",
    },
    {
      body: 'Duotone(shadows: #102030) { Rect(width: 8px, height: 8px); }',
      op: "cut.visual.duotone",
      mutate: (node: ReturnType<typeof Object.values>[number] & { inputs: Record<string, unknown> }) => { node.inputs.shadows = { kind: "color", value: "#10203080" }; },
      code: "CUT_VISUAL_EFFECT_COLOR",
    },
  ] as const;
  for (const fixture of cases) {
    const ir = compile(fixture.body), node = Object.values(ir.nodes).find((candidate) => candidate.op === fixture.op)!;
    fixture.mutate(node as never);
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => error instanceof ReferenceVisualEffectError
      && error.code === fixture.code
      && error.nodeId === node.id
      && error.message.includes("project.cut:"));
  }
});

test("Sharpen preserves alpha and hidden RGB and ignores transparent-neighbor color", async () => {
  const pixels: Array<readonly [number, number, number, number]> = Array.from({ length: 25 }, () => [255, 0, 0, 0]);
  pixels[12] = [128, 128, 128, 255];
  const source = rgba(pixels, 5);
  const sharpened = await applyReferenceVisualEffect({ kind: "sharpen", radius: 1, amount: 1 }, source);
  const center = pixel(sharpened, 2, 2);
  assert.equal(new Set(center.slice(0, 3)).size, 1, "transparent red neighbors cannot color-tint an opaque neutral edge");
  assert.deepEqual(center, [128, 128, 128, 255], "a constant straight-color alpha edge cannot manufacture contrast");
  assert.deepEqual(pixel(sharpened, 0, 0), [255, 0, 0, 0], "fully transparent hidden RGB is byte-preserved");
  assert.deepEqual(Array.from({ length: 25 }, (_, index) => sharpened.data[index * 4 + 3]), Array.from({ length: 25 }, (_, index) => source.data[index * 4 + 3]));

  const translucentPixels: Array<readonly [number, number, number, number]> = Array.from({ length: 25 }, () => [255, 0, 0, 0]);
  translucentPixels[12] = [128, 128, 128, 128];
  const translucent = await applyReferenceVisualEffect({ kind: "sharpen", radius: 1, amount: 1 }, rgba(translucentPixels, 5));
  const translucentCenter = pixel(translucent, 2, 2);
  assert.equal(translucentCenter[3], 128);
  assert.equal(new Set(translucentCenter.slice(0, 3)).size, 1, "separate premultiplied RGB/coverage planes prevent a translucent color fringe");
  assert.deepEqual(translucentCenter, [128, 128, 128, 128], "high-precision alpha normalization does not double-premultiply translucent RGB");

  for (const [value, alpha, radius] of [[128, 255, 8], [127, 24, 2], [128, 96, 4], [128, 1, 16]] as const) {
    const broadPixels: Array<readonly [number, number, number, number]> = Array.from({ length: 81 }, () => [value, value, value, 0]);
    broadPixels[40] = [value, value, value, alpha];
    const broad = await applyReferenceVisualEffect({ kind: "sharpen", radius, amount: 1 }, rgba(broadPixels, 9));
    assert.deepEqual(pixel(broad, 4, 4), [value, value, value, alpha], `radius ${radius} and alpha ${alpha} cannot create false neutral contrast`);
  }

  const varyingAlphaPixels: Array<readonly [number, number, number, number]> = Array.from({ length: 81 }, (_, index) => [128, 128, 128, (index * 37) % 256]);
  const varyingAlpha = await applyReferenceVisualEffect({ kind: "sharpen", radius: 8, amount: 1 }, rgba(varyingAlphaPixels, 9));
  for (let index = 0; index < varyingAlphaPixels.length; index += 1) {
    const actual = pixel(varyingAlpha, index % 9, Math.floor(index / 9));
    assert.equal(actual[3], varyingAlphaPixels[index][3], "Sharpen copies source alpha byte-for-byte");
    if (actual[3] > 0) assert.deepEqual(actual.slice(0, 3), [128, 128, 128], "a nonuniform alpha field with constant straight RGB remains constant");
  }

  const detailed = rgba(Array.from({ length: 25 }, (_, index) => [index === 12 ? 150 : 96, index === 12 ? 150 : 96, index === 12 ? 150 : 96, 255] as const), 5);
  const result = await applyReferenceVisualEffect({ kind: "sharpen", radius: 1, amount: 1 }, detailed);
  assert.ok(pixel(result, 2, 2)[0] > 150, "bounded unsharp mask increases local contrast");
});

test("Grain is seeded, spatially explicit, temporally deterministic, alpha-safe, and context-bounded", async () => {
  const sourcePixels: Array<readonly [number, number, number, number]> = Array.from({ length: 16 }, () => [128, 128, 128, 255]);
  sourcePixels[15] = [7, 11, 13, 0];
  const source = rgba(sourcePixels, 4);
  const staticConfig = { kind: "grain", amount: 0.5, size: 2, seed: 9182, mode: "static", monochrome: true } as const;
  const staticZero = await applyReferenceVisualEffect(staticConfig, source, { frame: 0 });
  const staticLater = await applyReferenceVisualEffect(staticConfig, source, { frame: 99 });
  assert.equal(digest(staticZero.data), digest(staticLater.data), "static grain does not consume frame phase");
  assert.equal(digest(staticZero.data), "18c8a7de9a5276a7c86f72d2e426e2634d577752cd4e34acd52fec551c549b65", "pure integer grain field has a cross-run byte golden");
  assert.deepEqual(pixel(staticZero, 0, 0).slice(0, 3), pixel(staticZero, 1, 1).slice(0, 3), "size creates canvas-anchored constant spatial cells");
  const delta = pixel(staticZero, 0, 0).slice(0, 3).map((value) => value - 128);
  assert.equal(new Set(delta).size, 1, "monochrome grain uses one sample for all RGB channels");
  assert.deepEqual(pixel(staticZero, 3, 3), [7, 11, 13, 0], "hidden RGB and alpha are preserved");

  const temporalConfig = { ...staticConfig, mode: "temporal" as const };
  const frameZeroA = await applyReferenceVisualEffect(temporalConfig, source, { frame: 0 });
  const frameZeroB = await applyReferenceVisualEffect(temporalConfig, source, { frame: 0 });
  const frameOne = await applyReferenceVisualEffect(temporalConfig, source, { frame: 1 });
  const otherSeed = await applyReferenceVisualEffect({ ...temporalConfig, seed: 9183 }, source, { frame: 0 });
  assert.equal(digest(frameZeroA.data), digest(frameZeroB.data), "same seed/frame is repeatable across executions");
  assert.notEqual(digest(frameZeroA.data), digest(frameOne.data), "temporal mode changes deterministically by exact frame index");
  assert.notEqual(digest(frameZeroA.data), digest(otherSeed.data), "seed participates in the noise field");
  await assert.rejects(() => applyReferenceVisualEffect(temporalConfig, source), (error: unknown) => error instanceof ReferenceVisualEffectError && error.code === "CUT_VISUAL_EFFECT_FRAME");
  await assert.rejects(
    () => applyReferenceVisualEffect(staticConfig, { data: Buffer.alloc(4), width: 4_097, height: 4_097 }),
    (error: unknown) => error instanceof ReferenceVisualEffectError && error.code === "CUT_VISUAL_EFFECT_SURFACE" && /16,777,216-pixel CPU budget/.test(error.message),
  );
});

test("Grain cell-sample reuse is byte-identical to the frozen scalar law", async () => {
  let randomState = 0x51a7_9e3d;
  const nextByte = () => {
    randomState = Math.imul(randomState, 1_664_525) + 1_013_904_223 >>> 0;
    return randomState >>> 24;
  };
  const cases = [
    { width: 11, height: 7, size: 1, monochrome: true, mode: "static", frame: 0 },
    { width: 11, height: 7, size: 2, monochrome: true, mode: "temporal", frame: 91 },
    { width: 11, height: 7, size: 3, monochrome: false, mode: "static", frame: 0 },
    { width: 11, height: 7, size: 64, monochrome: false, mode: "temporal", frame: 0xffff_ffff },
  ] as const;
  for (const [caseIndex, fixture] of cases.entries()) {
    const bytes = Buffer.alloc(fixture.width * fixture.height * 4);
    const alphaSequence = [0, 1, 127, 254, 255] as const;
    for (let offset = 0, pixelIndex = 0; offset < bytes.length; offset += 4, pixelIndex += 1) {
      bytes[offset] = nextByte();
      bytes[offset + 1] = nextByte();
      bytes[offset + 2] = nextByte();
      bytes[offset + 3] = alphaSequence[(pixelIndex + caseIndex) % alphaSequence.length]!;
    }
    const source = { data: bytes, width: fixture.width, height: fixture.height };
    const sourceBefore = Buffer.from(bytes);
    const config: FrozenGrainConfig = {
      kind: "grain",
      amount: caseIndex === 0 ? 0.03125 : caseIndex === 1 ? 0.5 : caseIndex === 2 ? 1 : 0.78125,
      size: fixture.size,
      seed: [0, 9182, 0xffff_ffff, 73][caseIndex]!,
      mode: fixture.mode,
      monochrome: fixture.monochrome,
    };
    const expected = frozenScalarGrain(source, config, fixture.frame);
    const first = await applyReferenceVisualEffect(config, source, { frame: fixture.frame });
    const repeated = await applyReferenceVisualEffect(config, source, { frame: fixture.frame });
    assert.deepEqual(first.data, expected, `case ${caseIndex} matches the frozen per-pixel scalar law`);
    assert.deepEqual(repeated.data, expected, `case ${caseIndex} repeats exact bytes`);
    assert.deepEqual(source.data, sourceBefore, `case ${caseIndex} never mutates caller-owned input`);
    for (let offset = 0; offset < bytes.length; offset += 4) {
      assert.equal(first.data[offset + 3], bytes[offset + 3], `case ${caseIndex} preserves alpha`);
      if (bytes[offset + 3] === 0) {
        assert.deepEqual(
          first.data.subarray(offset, offset + 4),
          bytes.subarray(offset, offset + 4),
          `case ${caseIndex} preserves noncanonical hidden RGB`,
        );
      }
    }
  }
});

test("Duotone has exact linear-light endpoints while preserving source alpha and hidden RGB", async () => {
  const source = rgba([
    [0, 0, 0, 255],
    [128, 128, 128, 128],
    [255, 255, 255, 64],
    [9, 8, 7, 0],
  ], 4);
  const result = await applyReferenceVisualEffect({ kind: "duotone", shadows: "#102030", highlights: "#e0d0c0", amount: 1 }, source);
  assert.deepEqual(pixel(result, 0, 0), [16, 32, 48, 255], "black maps exactly to the shadows endpoint");
  assert.deepEqual(pixel(result, 2, 0), [224, 208, 192, 64], "white maps exactly to the highlights endpoint");
  assert.deepEqual(pixel(result, 3, 0), [9, 8, 7, 0], "transparent hidden RGB is byte-preserved");
  assert.deepEqual([0, 1, 2, 3].map((x) => pixel(result, x, 0)[3]), [255, 128, 64, 0]);
  const identity = await applyReferenceVisualEffect({ kind: "duotone", shadows: "#ff0000", highlights: "#00ffff", amount: 0 }, source);
  assert.equal(digest(identity.data), digest(source.data), "zero amount is byte identity");
  await assert.rejects(
    () => applyReferenceVisualEffect({ kind: "duotone", shadows: "#102030ff", highlights: "#ffffff", amount: 1 }, source),
    (error: unknown) => error instanceof ReferenceVisualEffectError && error.code === "CUT_VISUAL_EFFECT_COLOR",
  );
});

test("public runtime executes temporal Grain and effect nesting in authored order", async () => {
  const temporalBody = 'Grain(amount: 50%, size: 1px, seed: 42, mode: "temporal") { Rect(width: 8px, height: 8px, fill: #808080); }';
  const ir = compile(temporalBody), { composition } = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-extended-effects-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const first = await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false);
    const second = await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 1, false);
    assert.notEqual(digest(first.data), digest(second.data), "exact output-frame index reaches the temporal grain kernel");
  } finally { await renderer.closeAndWait(); }

  async function frame(body: string) {
    const graph = compile(body), session = validateReferenceSession(graph), directory = await mkdtemp(resolve(tmpdir(), "cut-effect-order-"));
    const visual = new ReferenceVisualRenderer(graph, session.composition, directory, resolve(directory, "cache"));
    await visual.prepare();
    try { return await visual.sceneFrame(graph.scenes[session.composition.sceneIds[0]], 0, false); }
    finally { await visual.closeAndWait(); }
  }
  const grainThenDuotone = await frame('Duotone(shadows: #102030, highlights: #f0e0d0) { Grain(amount: 50%, seed: 7) { Rect(width: 8px, height: 8px, fill: #808080); } }');
  const duotoneThenGrain = await frame('Grain(amount: 50%, seed: 7) { Duotone(shadows: #102030, highlights: #f0e0d0) { Rect(width: 8px, height: 8px, fill: #808080); } }');
  assert.notEqual(digest(grainThenDuotone.data), digest(duotoneThenGrain.data), "nested effects execute inner-to-outer in source order");
});

test("temporal Grain phase uses the absolute composition frame and does not reset at scene cuts", async () => {
  const repeated = 'Grain(amount: 50%, size: 1px, seed: 42, mode: "temporal") { Rect(width: 8px, height: 8px, fill: #808080); }';
  const cutModule = parse(`cut 0.4;
project "temporal grain across scenes";
import { Grain, Rect } from "cut:visual";
timeline main(duration: 2s, fps: 1, width: 8px, height: 8px, sampleRate: 8khz) {
  scene first(duration: 1s) { ${repeated} }
  scene second(duration: 1s) { ${repeated} }
}
export out = render(main);`);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-grain-scene-phase-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const first = await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false);
    const second = await renderer.sceneFrame(ir.scenes[composition.sceneIds[1]], 0, false);
    assert.notEqual(digest(first.data), digest(second.data), "scene-local frame zero maps to composition frames zero and one");
  } finally { await renderer.closeAndWait(); }
});

test("effect parameter edits invalidate picture only and preserve unrelated audio cache identity", () => {
  const body = (seed: number) => `Grain(amount: 20%, seed: ${seed}, mode: "temporal") {
    Duotone(shadows: #102030, highlights: #f0e0d0) {
      Sharpen(radius: 1px, amount: 50%) { Rect(width: 8px, height: 8px, fill: #708090); }
    }
  }`;
  const before = compile(body(7), { audio: true }), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = compile(body(8), { audio: true }), grainNode = Object.values(after.nodes).find((node) => node.op === "cut.visual.grain"), tone = Object.values(after.nodes).find((node) => node.op === "cut.audio.tone");
  assert.ok(grainNode); assert.ok(tone);
  const plan = createIncrementalRenderPlan(after, "main", previous);
  assert.equal(plan.nodes.find((node) => node.id === grainNode.id)?.status, "miss");
  assert.equal(plan.nodes.find((node) => node.id === tone.id)?.status, "hit");
  assert.ok(plan.scenes.every((scene) => scene.status === "miss"));
  assert.notEqual(before.buildId, after.buildId, "seed participates in whole-build identity");
});
