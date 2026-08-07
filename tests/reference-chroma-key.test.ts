import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import {
  applyReferenceChromaKey,
  ReferenceChromaKeyError,
  referenceChromaKeyConfig,
  referenceChromaKeyKeepCoverage,
  referenceChromaKeyLimits,
  referenceChromaKeySpillProximity,
  validateReferenceChromaKeyCompositionBudget,
} from "../lib/runtime/reference/chroma-key";
import type { RgbaSurface } from "../lib/runtime/reference/compositing";
import { renderReferenceIr } from "./reference-render-test-helper";
import { ReferencePictureEditorialError, validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(body: string, width = 5, height = 5, audio = false) {
  return `cut 0.4;
project "unrelated chroma key contract";
import { ChromaKey, ColorConvert, Composite, Duotone, Group, Rect } from "cut:visual";
${audio ? 'import { Tone } from "@cut/audio";' : ""}
timeline main(duration: 1s, fps: 1, width: ${width}px, height: ${height}px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    ${body}
    ${audio ? "Tone(frequency: 440hz, duration: 1s);" : ""}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source: string) {
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(cutModule).ir;
}

function chromaNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.chroma_key");
  assert.ok(node);
  return node;
}

function rgba(pixels: ReadonlyArray<readonly [number, number, number, number]>, width: number, alphaMode?: "straight" | "premultiplied"): RgbaSurface {
  return { data: Uint8Array.from(pixels.flatMap((pixel) => [...pixel])), width, height: pixels.length / width, ...(alphaMode ? { alphaMode } : {}) };
}

function pixel(surface: RgbaSurface, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function digest(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

async function render(source: string) {
  const ir = compile(source), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-chroma-key-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/cache"));
  await renderer.prepare();
  try {
    return { ir, surface: await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false) };
  } finally { renderer.close(); }
}

function expectKeyError(action: () => unknown, code: ReferenceChromaKeyError["code"], message?: RegExp) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceChromaKeyError);
    assert.equal(error.code, code);
    assert.ok(error.source.module && error.source.line > 0 && error.source.column > 0 && error.source.nodeId);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function linearSrgb(code: number) {
  const encoded = code / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function linearLuma(value: readonly number[]) {
  return 0.2126 * linearSrgb(value[0]) + 0.7152 * linearSrgb(value[1]) + 0.0722 * linearSrgb(value[2]);
}

test("ChromaKey is a closed static unary API and lowers its exact defaults", () => {
  const symbol = packageSymbol("cut:visual", "ChromaKey");
  assert.deepEqual(symbol?.parameters?.map((parameter) => parameter.name), ["key", "tolerance", "softness", "spill"]);
  assert.deepEqual(symbol?.parameters?.map((parameter) => parameter.default), [undefined, "12%", "8%", "50%"]);
  assert.equal(symbol?.children, "visual");
  const kernel = referenceKernelSchema("cut.visual.chroma_key");
  assert.equal(kernel?.support, "supported");
  if (kernel?.support === "supported") {
    assert.deepEqual(kernel.inputs, ["key", "tolerance", "softness", "spill"]);
    assert.deepEqual(kernel.properties, []);
    assert.deepEqual([kernel.minimumChildren, kernel.maximumChildren], [1, 1]);
  }

  const ir = compile(program("ChromaKey(key: #00ff00) { Rect(width: 5px, height: 5px, fill: #00a000); }"));
  const node = chromaNode(ir), config = referenceChromaKeyConfig(ir, node);
  assert.deepEqual(node.inputs.key, { kind: "color", value: "#00ff00" });
  assert.equal(node.inputs.tolerance, undefined, "omitted defaults stay canonical omissions in CutAVIR");
  assert.equal(node.inputs.softness, undefined);
  assert.equal(node.inputs.spill, undefined);
  assert.deepEqual({ tolerance: config?.tolerance, softness: config?.softness, spill: config?.spill }, { tolerance: 0.12, softness: 0.08, spill: 0.5 });

  const failures = [
    ["ChromaKey() { Rect(width: 5px, height: 5px); }", /Missing required argument “key”/],
    ["ChromaKey(key: \"green\") { Rect(width: 5px, height: 5px); }", /key.*expects Color.*String/],
    ["ChromaKey(key: #00ff00, tolerance: 2px) { Rect(width: 5px, height: 5px); }", /tolerance.*expects Ratio.*Length/],
    ["ChromaKey(key: #00ff00, invented: 1) { Rect(width: 5px, height: 5px); }", /does not execute input “invented”/],
  ] as const;
  for (const [body, expected] of failures) {
    const cutModule = parse(program(body)), diagnostics = checkCutModule(cutModule).diagnostics;
    assert.match(diagnostics.map((item) => item.message).join("\n"), expected);
    assert.ok(diagnostics.some((item) => item.span.start.line > 0 && item.span.start.column > 0));
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }
  const animated = parse(program("ChromaKey(key: #00ff00) as keyed { Rect(width: 5px, height: 5px); } animate keyed.tolerance from 5% to 10% over 1s;"));
  assert.match(checkCutModule(animated).diagnostics.map((item) => item.message).join("\n"), /no executable property “tolerance”/);
  assert.throws(() => compileCutModule(animated), CutCompileError);

  for (const body of [
    "ChromaKey(key: #00ff00);",
    "ChromaKey(key: #00ff00) { Rect(width: 5px, height: 5px); Rect(width: 1px, height: 1px); }",
  ]) {
    assert.throws(() => compileCutModule(parse(program(body))), (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT2085" && /requires exactly one visual child/.test(item.message)));
  }
});

test("compile preflight refuses neutral, alpha-bearing, sub-code, excessive, and inert key controls", () => {
  const cases = [
    ["ChromaKey(key: #808080) { Rect(width: 5px, height: 5px); }", "CUT_CHROMA_KEY_COLOR", /at least 0\.1 away from neutral/],
    ["ChromaKey(key: #00ff0080) { Rect(width: 5px, height: 5px); }", "CUT_CHROMA_KEY_COLOR", /opaque six-digit/],
    ["ChromaKey(key: #00ff00, tolerance: 0.1%) { Rect(width: 5px, height: 5px); }", "CUT_CHROMA_KEY_RANGE", /at least 1\/255/],
    ["ChromaKey(key: #00ff00, tolerance: 30%, softness: 21%) { Rect(width: 5px, height: 5px); }", "CUT_CHROMA_KEY_RANGE", /must not exceed 50%/],
    ["ChromaKey(key: #00ff00, tolerance: 0%, softness: 0%, spill: 50%) { Rect(width: 5px, height: 5px); }", "CUT_CHROMA_KEY_NOOP", /no retained color to despill/],
  ] as const;
  for (const [body, code, expected] of cases) {
    assert.throws(() => compileCutModule(parse(program(body))), (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === code && expected.test(item.message)
        && item.span.start.line > 0 && item.span.start.column > 0));
  }
  assert.doesNotThrow(() => compile(program("ChromaKey(key: #00ff00, tolerance: 0%, softness: 0%, spill: 0%) { Rect(width: 5px, height: 5px); }")));
});

test("encoded-sRGB input proof refuses wrong-space output through wrappers and accepts an explicit conversion back", () => {
  const unsafe = [
    "ChromaKey(key: #00ff00) { ColorConvert(from: \"srgb\", to: \"linear-srgb\") { Rect(width: 5px, height: 5px); } }",
    "ChromaKey(key: #00ff00) { Group() { ColorConvert(from: \"srgb\", to: \"rec709-full\") { Rect(width: 5px, height: 5px); } } }",
  ];
  for (const body of unsafe) {
    assert.throws(() => compileCutModule(parse(program(body))), (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT_CHROMA_KEY_COLOR_SPACE"
        && /convert back to srgb|produces linear-srgb/.test(item.message)
        && item.span.start.line > 0 && item.span.start.column > 0));
  }
  assert.doesNotThrow(() => compile(program(`ChromaKey(key: #00ff00) {
    ColorConvert(from: "linear-srgb", to: "srgb") {
      ColorConvert(from: "srgb", to: "linear-srgb") { Rect(width: 5px, height: 5px); }
    }
  }`)));
});

test("matte and retained spill bands have exact threshold and smoothstep boundaries", () => {
  assert.equal(referenceChromaKeyKeepCoverage(0.12, 0.12, 0.08), 0, "threshold is removed");
  assert.ok(Math.abs(referenceChromaKeyKeepCoverage(0.16, 0.12, 0.08) - 0.5) < Number.EPSILON, "transition midpoint is exact within binary64 evaluation");
  assert.equal(referenceChromaKeyKeepCoverage(0.2, 0.12, 0.08), 1, "outer boundary is retained");
  assert.equal(referenceChromaKeyKeepCoverage(0.12, 0.12, 0), 0);
  assert.equal(referenceChromaKeyKeepCoverage(0.1200001, 0.12, 0), 1, "hard key retains immediately beyond tolerance");

  assert.equal(referenceChromaKeySpillProximity(0.2, 0.12, 0.08), 1, "despill is full at the retained matte boundary");
  assert.ok(Math.abs(referenceChromaKeySpillProximity(0.26, 0.12, 0.08) - 0.5) < Number.EPSILON, "despill midpoint uses the larger 12% key band");
  assert.equal(referenceChromaKeySpillProximity(0.32, 0.12, 0.08), 0);
  assert.ok(Math.abs(referenceChromaKeySpillProximity(0.18, 0.12, 0) - 0.5) < Number.EPSILON, "hard keys retain a useful near-key despill band");
});

test("CUT-owned pixel kernel removes exact key, preserves far RGB, and multiplies existing alpha", () => {
  const exactIr = compile(program("ChromaKey(key: #00ff00, tolerance: 0%, softness: 0%, spill: 0%) { Rect(width: 5px, height: 5px); }"));
  const exactNode = chromaNode(exactIr), exactConfig = referenceChromaKeyConfig(exactIr, exactNode)!;
  const exact = applyReferenceChromaKey(exactNode, exactConfig, rgba([
    [0, 255, 0, 255],
    [255, 0, 0, 255],
    [7, 11, 13, 0],
  ], 3));
  assert.deepEqual(pixel(exact, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(exact, 1, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(exact, 2, 0), [0, 0, 0, 0], "zero-alpha hidden RGB cannot leak");

  const softIr = compile(program("ChromaKey(key: #00ff00, tolerance: 12%, softness: 8%, spill: 0%) { Rect(width: 5px, height: 5px); }"));
  const softNode = chromaNode(softIr), softConfig = referenceChromaKeyConfig(softIr, softNode)!;
  const opaque = applyReferenceChromaKey(softNode, softConfig, rgba([[0, 160, 0, 255]], 1));
  const translucent = applyReferenceChromaKey(softNode, softConfig, rgba([[0, 160, 0, 128]], 1));
  assert.ok(pixel(opaque, 0, 0)[3] > 0 && pixel(opaque, 0, 0)[3] < 255);
  assert.equal(pixel(translucent, 0, 0)[3], Math.round(pixel(opaque, 0, 0)[3] * 128 / 255));
  assert.deepEqual(pixel(opaque, 0, 0).slice(0, 3), [0, 160, 0], "zero spill preserves straight RGB byte-for-byte");
});

test("premultiplied input is safely unassociated and output is straight with hidden RGB cleared", () => {
  const ir = compile(program("ChromaKey(key: #00ff00, tolerance: 0%, softness: 0%, spill: 0%) { Rect(width: 5px, height: 5px); }"));
  const node = chromaNode(ir), config = referenceChromaKeyConfig(ir, node)!;
  const result = applyReferenceChromaKey(node, config, rgba([
    [128, 0, 0, 128],
    [0, 255, 0, 0],
  ], 2, "premultiplied"));
  assert.equal(result.alphaMode, "straight");
  assert.deepEqual(pixel(result, 0, 0), [255, 0, 0, 128]);
  assert.deepEqual(pixel(result, 1, 0), [0, 0, 0, 0]);
});

test("hard-key despill changes retained near-key color while preserving linear luminance", () => {
  const configFor = (spill: string) => {
    const ir = compile(program(`ChromaKey(key: #00ff00, tolerance: 12%, softness: 0%, spill: ${spill}) { Rect(width: 5px, height: 5px); }`));
    const node = chromaNode(ir);
    return { node, config: referenceChromaKeyConfig(ir, node)! };
  };
  const dry = configFor("0%"), wet = configFor("100%");
  const source = rgba([[0, 160, 0, 255]], 1);
  const original = applyReferenceChromaKey(dry.node, dry.config, source);
  const corrected = applyReferenceChromaKey(wet.node, wet.config, source);
  assert.equal(pixel(corrected, 0, 0)[3], 255, "near-key pixel is outside the hard matte");
  assert.notDeepEqual(pixel(corrected, 0, 0), pixel(original, 0, 0), "nonzero spill executes with zero softness");
  assert.ok(pixel(corrected, 0, 0)[0] > 0 && pixel(corrected, 0, 0)[1] < 160 && pixel(corrected, 0, 0)[2] > 0);
  assert.ok(Math.abs(linearLuma(pixel(corrected, 0, 0)) - linearLuma(pixel(original, 0, 0))) < 0.005, "despill preserves linear Rec.709 luma within one 8-bit round trip");
});

test("public renderer keys a layered subject before source-over and nesting order remains authored", async () => {
  const keyed = await render(program(`Composite() {
    Rect(width: 5px, height: 5px, fill: #0000ff);
    ChromaKey(key: #00ff00, tolerance: 0%, softness: 0%, spill: 0%) {
      Composite() {
        Rect(width: 5px, height: 5px, fill: #00ff00);
        Rect(width: 1px, height: 1px, fill: #ff0000);
      }
    }
  }`));
  assert.deepEqual(pixel(keyed.surface, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixel(keyed.surface, 2, 2), [255, 0, 0, 255]);
  const replay = await render(program(`Composite() {
    Rect(width: 5px, height: 5px, fill: #0000ff);
    ChromaKey(key: #00ff00, tolerance: 0%, softness: 0%, spill: 0%) {
      Composite() { Rect(width: 5px, height: 5px, fill: #00ff00); Rect(width: 1px, height: 1px, fill: #ff0000); }
    }
  }`));
  assert.equal(digest(replay.surface.data), digest(keyed.surface.data));

  const keyAfterTone = await render(program("ChromaKey(key: #00ff00, tolerance: 0%, softness: 0%, spill: 0%) { Duotone(shadows: #101010, highlights: #f0f0f0) { Rect(width: 5px, height: 5px, fill: #00ff00); } }"));
  const toneAfterKey = await render(program("Duotone(shadows: #101010, highlights: #f0f0f0) { ChromaKey(key: #00ff00, tolerance: 0%, softness: 0%, spill: 0%) { Rect(width: 5px, height: 5px, fill: #00ff00); } }"));
  assert.notEqual(digest(keyAfterTone.surface.data), digest(toneAfterKey.surface.data));
  assert.ok(pixel(keyAfterTone.surface, 2, 2)[3] > 0);
  assert.deepEqual(pixel(toneAfterKey.surface, 2, 2), [0, 0, 0, 0]);
});

test("hostile loaded IR receives stable source-located key diagnostics before rendering", () => {
  const base = program("ChromaKey(key: #00ff00) { Rect(width: 5px, height: 5px); }");
  const cases: Array<[string, (node: IRNode) => void, ReferenceChromaKeyError["code"], RegExp]> = [
    ["unknown input", (node) => { node.inputs.channel = { kind: "string", value: "green" }; }, "CUT_CHROMA_KEY_INPUT_TYPE", /does not execute input “channel”/],
    ["unknown property", (node) => { node.properties.tolerance = { kind: "quantity", dimension: "ratio", magnitude: rational(1, 10), unit: "ratio" }; }, "CUT_CHROMA_KEY_INPUT_TYPE", /does not execute property “tolerance”/],
    ["alpha key", (node) => { node.inputs.key = { kind: "color", value: "#00ff0080" }; }, "CUT_CHROMA_KEY_COLOR", /opaque six-digit/],
    ["neutral key", (node) => { node.inputs.key = { kind: "color", value: "#808080" }; }, "CUT_CHROMA_KEY_COLOR", /away from neutral/],
    ["wrong ratio", (node) => { node.inputs.softness = { kind: "quantity", dimension: "length", magnitude: rational(1), unit: "px" }; }, "CUT_CHROMA_KEY_INPUT_TYPE", /canonical Ratio/],
    ["negative ratio", (node) => { node.inputs.tolerance = { kind: "quantity", dimension: "ratio", magnitude: rational(-1, 100), unit: "ratio" }; }, "CUT_CHROMA_KEY_RANGE", /0% through 100%/],
    ["ratio over one", (node) => { node.inputs.spill = { kind: "quantity", dimension: "ratio", magnitude: rational(101, 100), unit: "ratio" }; }, "CUT_CHROMA_KEY_RANGE", /0% through 100%/],
    ["sub-code ratio", (node) => { node.inputs.softness = { kind: "quantity", dimension: "ratio", magnitude: rational(1, 1000), unit: "ratio" }; }, "CUT_CHROMA_KEY_RANGE", /at least 1\/255/],
    ["inert despill", (node) => { node.inputs.tolerance = { kind: "quantity", dimension: "ratio", magnitude: rational(0), unit: "ratio" }; node.inputs.softness = { kind: "quantity", dimension: "ratio", magnitude: rational(0), unit: "ratio" }; node.inputs.spill = { kind: "quantity", dimension: "ratio", magnitude: rational(1, 2), unit: "ratio" }; }, "CUT_CHROMA_KEY_NOOP", /no retained color to despill/],
    ["excess window", (node) => { node.inputs.tolerance = { kind: "quantity", dimension: "ratio", magnitude: rational(1, 2), unit: "ratio" }; node.inputs.softness = { kind: "quantity", dimension: "ratio", magnitude: rational(1, 255), unit: "ratio" }; }, "CUT_CHROMA_KEY_RANGE", /must not exceed 50%/],
  ];
  for (const [name, mutate, code, message] of cases) {
    const ir = compile(base); mutate(chromaNode(ir)); finalizeGraphHashes(ir);
    let loaded: CutAVIR;
    try {
      loaded = loadCutAvIr(JSON.stringify(ir));
    } catch (error) {
      assert.ok(name === "unknown input" || name === "unknown property", name);
      assert.ok(error instanceof CutAvIrValidationError, name);
      assert.equal(error.code, "CUT_IR_UNKNOWN_FIELD", name);
      assert.match(error.path, name === "unknown input" ? /inputs\.channel$/ : /properties\.tolerance$/);
      continue;
    }
    expectKeyError(() => validateReferenceSession(loaded), code, message);
    let captured: unknown;
    try { validateReferenceSession(loaded); } catch (error) { captured = error; }
    const diagnostic = JSON.parse(JSON.stringify(cutDiagnosticsFromError(captured)))[0];
    assert.equal(diagnostic.code, code, name);
    assert.deepEqual(diagnostic.source, {
      module: "project.cut",
      line: chromaNode(loaded).provenance.span.start.line,
      column: chromaNode(loaded).provenance.span.start.column,
      nodeId: chromaNode(loaded).id,
    }, name);
  }

  const graph = compile(base), node = chromaNode(graph);
  const originalDomain = node.domain; node.domain = "audio";
  expectKeyError(() => referenceChromaKeyConfig(graph, node), "CUT_CHROMA_KEY_GRAPH", /visual domain/);
  node.domain = originalDomain; node.children = [];
  expectKeyError(() => referenceChromaKeyConfig(graph, node), "CUT_CHROMA_KEY_GRAPH", /exactly one visual child/);

  const wrongChildDomain = compile(base), wrongChildNode = chromaNode(wrongChildDomain);
  wrongChildDomain.nodes[wrongChildNode.children[0]].domain = "audio";
  finalizeGraphHashes(wrongChildDomain);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(wrongChildDomain)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TYPE"
      && /\.domain$/.test(error.path),
    "the strict public loader refuses the forged child domain before rendering",
  );
});

test("the hostile IR loader closes noncanonical rationals, dangling children, and forged ownership", () => {
  const base = program("ChromaKey(key: #00ff00) { Rect(width: 5px, height: 5px); }");

  const noncanonical = compile(base), noncanonicalNode = chromaNode(noncanonical);
  noncanonicalNode.inputs.tolerance = {
    kind: "quantity",
    dimension: "ratio",
    magnitude: { numerator: "2", denominator: "2" },
    unit: "ratio",
  };
  assert.throws(
    () => loadCutAvIr(JSON.stringify(noncanonical)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_RATIONAL"
      && /canonical|reduced/.test(error.message),
  );

  const dangling = compile(base), danglingNode = chromaNode(dangling);
  danglingNode.children = ["missing-chroma-key-child"];
  assert.throws(
    () => loadCutAvIr(JSON.stringify(dangling)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_REFERENCE"
      && /missing-chroma-key-child/.test(error.message),
  );

  const ownership = compile(base), ownershipNode = chromaNode(ownership);
  ownership.nodes[ownershipNode.children[0]].ownership = "root";
  finalizeGraphHashes(ownership);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(ownership)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_IDENTITY"
      && /root node.*child|cannot be a child/.test(error.message),
  );

  const editorial = compile(base), editorialNode = chromaNode(editorial);
  const editorialChild = editorial.nodes[editorialNode.children[0]];
  editorialNode.editorial = {
    kind: "sequence",
    tracks: [{ nodeId: editorialChild.id, order: 0, destination: editorialChild.interval }],
  };
  finalizeGraphHashes(editorial);
  const loadedEditorial = loadCutAvIr(JSON.stringify(editorial));
  assert.throws(
    () => validateReferenceSession(loadedEditorial),
    (error: unknown) => error instanceof ReferencePictureEditorialError
      && error.code === "CUT_EDIT_SEQUENCE"
      && error.source.nodeId === editorialNode.id
      && /chroma_key cannot carry/.test(error.message),
    "generic preflight closes forged editorial metadata before ChromaKey execution",
  );
});

test("node and aggregate budgets fail before an RGBA allocation", () => {
  const ir = compile(program("ChromaKey(key: #00ff00) { Rect(width: 5px, height: 5px); }"));
  const node = chromaNode(ir), config = referenceChromaKeyConfig(ir, node)!;
  let allocations = 0;
  expectKeyError(
    () => applyReferenceChromaKey(
      node,
      config,
      { data: new Uint8Array(4), width: 4_097, height: 4_097 },
      { allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); } },
    ),
    "CUT_CHROMA_KEY_RESOURCE_LIMIT",
    /16777216-pixel ChromaKey budget/,
  );
  assert.equal(allocations, 0, "the per-node surface budget is checked before output allocation");
  expectKeyError(
    () => validateReferenceChromaKeyCompositionBudget(Array.from({ length: referenceChromaKeyLimits.maximumNodesPerComposition + 1 }, () => node), 1, 1),
    "CUT_CHROMA_KEY_RESOURCE_LIMIT",
    /64-ChromaKey-node limit/,
  );
  expectKeyError(
    () => validateReferenceChromaKeyCompositionBudget(Array.from({ length: 5 }, () => node), 4_096, 4_096),
    "CUT_CHROMA_KEY_RESOURCE_LIMIT",
    /aggregate|key-pixel passes/,
  );

  const nested = (count: number, child: string): string => count === 0
    ? child
    : `ChromaKey(key: #00ff00) { ${nested(count - 1, child)} }`;
  assert.throws(
    () => compileCutModule(parse(program(nested(5, "Rect(width: 1px, height: 1px);"), 4_096, 4_096))),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT_CHROMA_KEY_RESOURCE_LIMIT" && /key-pixel passes/.test(item.message)),
  );
});

test("every key input participates in localized picture/cache identity", () => {
  const body = (args: string) => program(`ChromaKey(${args}) { Rect(width: 5px, height: 5px, fill: #00a000); }`, 5, 5, true);
  const before = compile(body("key: #00ff00, tolerance: 12%, softness: 8%, spill: 50%"));
  const manifest = createIncrementalRenderPlan(before, "main").manifest;
  for (const args of [
    "key: #00ee00, tolerance: 12%, softness: 8%, spill: 50%",
    "key: #00ff00, tolerance: 13%, softness: 8%, spill: 50%",
    "key: #00ff00, tolerance: 12%, softness: 9%, spill: 50%",
    "key: #00ff00, tolerance: 12%, softness: 8%, spill: 51%",
  ]) {
    const after = compile(body(args)), plan = createIncrementalRenderPlan(after, "main", manifest);
    const key = chromaNode(after), rect = Object.values(after.nodes).find((node) => node.op === "cut.visual.rect"), tone = Object.values(after.nodes).find((node) => node.op === "cut.audio.tone");
    assert.ok(rect); assert.ok(tone);
    assert.equal(plan.nodes.find((entry) => entry.id === key.id)?.status, "miss", args);
    assert.equal(plan.nodes.find((entry) => entry.id === rect.id)?.status, "hit", args);
    assert.equal(plan.nodes.find((entry) => entry.id === tone.id)?.status, "hit", args);
    assert.ok(plan.scenes.every((scene) => scene.status === "miss"), args);
    assert.notEqual(before.buildId, after.buildId, args);
  }
});

test("the on-disk scene cache hits unchanged ChromaKey work and misses a parameter edit", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-chroma-key-cache-"));
  const source = (tolerance: number) => program(`Composite() {
    Rect(width: 32px, height: 32px, fill: #0000ff);
    ChromaKey(key: #00ff00, tolerance: ${tolerance}%, softness: 8%, spill: 0%) {
      Rect(width: 32px, height: 32px, fill: #00a000);
    }
  }`, 32, 32, true).replace("fps: 1", "fps: 4").replace("sampleRate: 8khz", "sampleRate: 48khz");
  try {
    const first = await renderReferenceIr(compile(source(12)), root, resolve(root, "cold.mp4"), "out");
    assert.deepEqual(first.cache.scenes.map(({ status }) => status), ["miss"]);

    const warm = await renderReferenceIr(compile(source(12)), root, resolve(root, "warm.mp4"), "out");
    assert.deepEqual(warm.cache.scenes.map(({ status }) => status), ["hit"]);
    assert.equal(warm.sha256, first.sha256, "an unchanged warm render reuses byte-identical picture semantics");

    const compositionCache = JSON.parse(await readFile(resolve(root, ".cut", "cache", "reference", "composition-main.json"), "utf8")) as { scenes: Record<string, string> };
    const warmSceneKey = Object.values(compositionCache.scenes)[0];
    assert.match(warmSceneKey, /^[a-f0-9]{64}$/);

    const edited = await renderReferenceIr(compile(source(13)), root, resolve(root, "edited.mp4"), "out");
    assert.deepEqual(edited.cache.scenes.map(({ status }) => status), ["miss"]);
    assert.notEqual(edited.sha256, warm.sha256, "the executed tolerance edit changes delivered pixels");
    const editedCompositionCache = JSON.parse(await readFile(resolve(root, ".cut", "cache", "reference", "composition-main.json"), "utf8")) as { scenes: Record<string, string> };
    assert.notEqual(Object.values(editedCompositionCache.scenes)[0], warmSceneKey, "the on-disk scene cache key changes with tolerance");

    const replay = await renderReferenceIr(compile(source(13)), root, resolve(root, "edited-replay.mp4"), "out");
    assert.deepEqual(replay.cache.scenes.map(({ status }) => status), ["hit"]);
    assert.equal(replay.sha256, edited.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
