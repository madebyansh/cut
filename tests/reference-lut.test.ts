import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock, CutLockError, verifyLockedIrResources } from "../lib/language/lock";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational, zeroRational } from "../lib/language/rational";
import { createIncrementalRenderPlan, cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import {
  parseReferenceCubeLut,
  ReferenceLutError,
  referenceCubeLutLimits,
  referenceLutStrengthAt,
  sampleReferenceCubeLut,
  validateReferenceLutResourceOwnership,
} from "../lib/runtime/reference/lut-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const identity1d = `# CUT strict one-dimensional identity
TITLE "Identity 1D"
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
LUT_1D_SIZE 2
0 0 0
1 1 1
`;

const creative1d = `TITLE "Independent channel curves"
LUT_1D_SIZE 2
0 0 0
1 .5 2.5e-1
`;

// The .cube 3D order is red-fastest, then green, then blue. These rows
// produce B,G,R and therefore make ordering mistakes visible in pixels.
const swap3d = `TITLE "BGR channel swap"
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`;

function source(options: { strength?: string; locator?: string; trailer?: string; fill?: string } = {}) {
  const strength = options.strength === undefined ? "" : `, strength: ${options.strength}`;
  return `cut 0.4;
project "unrelated locked LUT proof";
import { LUT, Rect } from "cut:visual";
asset look: DataAsset = data("${options.locator ?? "assets/look.cube"}");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    LUT(source: look${strength}) as grade {
      Rect(width: 8px, height: 8px, fill: ${options.fill ?? "#33669980"});
    }
    ${options.trailer ?? ""}
  }
}
export out = render(main, width: 8px, height: 8px, codec: "h264");`;
}

function parse(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(program = source()) {
  const cutModule = parse(program);
  assert.deepEqual(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(cutModule).ir;
}

function lutNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.lut");
  assert.ok(node);
  return node;
}

function bytes(value: string) { return Buffer.from(value, "utf8"); }
function digest(value: Uint8Array | Float64Array) { return createHash("sha256").update(value).digest("hex"); }
function pixel(surface: { data: Uint8Array; width: number }, x = 4, y = 4) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

async function project(cube = identity1d, program = source()) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-lut-"));
  await mkdir(resolve(root, "assets"));
  await writeFile(resolve(root, "assets/look.cube"), cube);
  const ir = compile(program), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { root, ir, lock };
}

async function renderProgram(cube: string, program: string, frame = 0) {
  const locked = await project(cube, program);
  const { composition } = validateReferenceSession(locked.ir);
  const renderer = new ReferenceVisualRenderer(locked.ir, composition, locked.root, resolve(locked.root, ".cut/cache"));
  await renderer.prepare();
  try {
    const scene = locked.ir.scenes[composition.sceneIds[0]];
    return { ir: locked.ir, surface: await renderer.sceneFrame(scene, frame, false) };
  } finally { renderer.close(); }
}

async function render(cube: string, strength: string, trailer = "") {
  return renderProgram(cube, source({ strength, trailer }));
}

function orderSource(gradeOutside: boolean) {
  const visual = gradeOutside
    ? "ColorGrade(temperature: 1) { LUT(source: look) { Rect(width: 8px, height: 8px, fill: #336699); } }"
    : "LUT(source: look) { ColorGrade(temperature: 1) { Rect(width: 8px, height: 8px, fill: #336699); } }";
  return `cut 0.4;
project "authored LUT operation order";
import { ColorGrade, LUT, Rect } from "cut:visual";
asset look: DataAsset = data("assets/look.cube");
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${visual} }
}
export out = render(main);`;
}

function multiOutputSource() {
  return `cut 0.4;
project "LUT composition locality";
import { LUT, Rect } from "cut:visual";
asset look: DataAsset = data("assets/look.cube");
timeline plainTimeline(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) { Rect(width: 8px, height: 8px, fill: #24a148); }
}
timeline lookedTimeline(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 1s) { LUT(source: look) { Rect(width: 8px, height: 8px, fill: #336699); } }
}
export plain = render(plainTimeline);
export looked = render(lookedTimeline);`;
}

function tableBudgetSource(count: number) {
  const assets = Array.from({ length: count }, (_, index) => `asset look${index}: DataAsset = data("assets/look${index}.cube");`).join("\n");
  const nodes = Array.from({ length: count }, (_, index) => `LUT(source: look${index}) { Rect(width: 1px, height: 1px, fill: #000000); }`).join("\n");
  return `cut 0.4;
project "bounded LUT table count";
import { LUT, Rect } from "cut:visual";
${assets}
timeline main(duration: 1s, fps: 1, width: 1px, height: 1px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${nodes} }
}
export out = render(main);`;
}

function expectLutError(action: () => unknown, code: ReferenceLutError["code"], message?: RegExp) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceLutError);
    assert.equal(error.code, code);
    assert.ok(error.source.line > 0 && error.source.column > 0);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("LUT is a closed public DataAsset unary visual kernel with canonical strength", () => {
  const symbol = packageSymbol("cut:visual", "LUT");
  assert.deepEqual(symbol?.parameters?.map((parameter) => parameter.name), ["source", "strength"]);
  assert.deepEqual(symbol?.parameters?.find((parameter) => parameter.name === "source"), { name: "source", type: "LUTAsset" });
  assert.equal(symbol?.children, "visual");
  assert.equal(symbol?.native, "cut.visual.lut");

  const ir = compile(), node = lutNode(ir);
  assert.deepEqual(node.inputs.source, { kind: "resource-ref", id: "look" });
  assert.equal(node.children.length, 1);
  assert.equal(referenceLutStrengthAt(ir, node, zeroRational), 1);
  assert.deepEqual(lutNode(compile(source({ strength: "50%" }))).inputs.strength, {
    kind: "quantity",
    dimension: "ratio",
    magnitude: { numerator: "1", denominator: "2" },
    unit: "ratio",
  });

  const authoredFailures = [
    [source().replace("source: look", "source: 7"), /source.*expects LUTAsset.*Number/],
    [source({ strength: "7" }), /strength.*expects Ratio.*Number/],
    [source().replace("source: look", "source: look, mode: \"film\""), /does not execute input “mode”/],
    [source({ trailer: "set grade.opacity = 50%;" }), /has no executable property “opacity”/],
  ] as const;
  for (const [program, expected] of authoredFailures) {
    const cutModule = parse(program), diagnostics = checkCutModule(cutModule).diagnostics;
    assert.match(diagnostics.map((item) => item.message).join("\n"), expected);
    assert.ok(diagnostics.some((item) => item.span.start.line > 0));
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }
  for (const program of [
    source().replace("      Rect(width: 8px, height: 8px, fill: #33669980);", ""),
    source().replace("      Rect(width: 8px, height: 8px, fill: #33669980);", "      Rect(width: 8px, height: 8px, fill: #33669980); Rect(width: 1px, height: 1px, fill: #ffffff);"),
  ]) {
    assert.throws(() => compileCutModule(parse(program)), (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT2085"
        && /requires exactly one visual child/.test(item.message)
        && item.span.start.line > 0));
  }
});

test("strict bounded .cube parser accepts its documented 1D/3D subset and deterministic interpolation", () => {
  const node = lutNode(compile());
  const one = parseReferenceCubeLut(node, bytes(`# comment before metadata\r\nTITLE "Creative # title" # comment\r\nDOMAIN_MIN 0 0 0\r\nDOMAIN_MAX 1 1 1\r\nLUT_1D_SIZE 2\r\n0 0 0\r\n1 .5 2.5e-1\r\n`));
  assert.equal(one.kind, "1d");
  assert.equal(one.title, "Creative # title");
  assert.deepEqual(sampleReferenceCubeLut(one, 0.2, 0.4, 0.6).map((value) => Number(value.toFixed(6))), [0.2, 0.2, 0.15]);

  const three = parseReferenceCubeLut(node, bytes(swap3d));
  assert.equal(three.kind, "3d");
  assert.deepEqual(sampleReferenceCubeLut(three, 0.2, 0.4, 0.6).map((value) => Number(value.toFixed(6))), [0.6, 0.4, 0.2]);
  assert.equal(digest(three.data), digest(parseReferenceCubeLut(node, bytes(swap3d)).data));

  const wideDomain = parseReferenceCubeLut(node, bytes("DOMAIN_MIN -1 -1 -1\nDOMAIN_MAX 1 1 1\nLUT_1D_SIZE 2\n0 0 0\n1 1 1\n"));
  assert.deepEqual(sampleReferenceCubeLut(wideDomain, 0, 0.5, 1).map((value) => Number(value.toFixed(6))), [0.5, 0.75, 1], "DOMAIN metadata must execute rather than be accepted and ignored");
});

test("strict .cube parser refuses malformed, ambiguous, non-finite, out-of-domain, and unsupported semantics", () => {
  const node = lutNode(compile());
  const failures: Array<[string | Uint8Array, ReferenceLutError["code"], RegExp]> = [
    ["TITLE no-quotes\nLUT_1D_SIZE 2\n0 0 0\n1 1 1", "CUT_LUT_FORMAT", /TITLE/],
    ["TITLE \"one\"\nTITLE \"two\"\nLUT_1D_SIZE 2\n0 0 0\n1 1 1", "CUT_LUT_FORMAT", /repeats TITLE/],
    ["LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n0 0 0\n1 1 1", "CUT_LUT_FORMAT", /multiple or ambiguous/],
    ["DOMAIN_MIN 0 0 0\nLUT_1D_SIZE 2\n0 0 0\n1 1 1", "CUT_LUT_FORMAT", /both be omitted or both be declared/],
    ["DOMAIN_MIN 0.1 0 0\nDOMAIN_MAX 1 1 1\nLUT_1D_SIZE 2\n0 0 0\n1 1 1", "CUT_LUT_VALUE_RANGE", /complete.*0\.\.\.1/],
    ["DOMAIN_MIN -17 0 0\nDOMAIN_MAX 1 1 1\nLUT_1D_SIZE 2\n0 0 0\n1 1 1", "CUT_LUT_VALUE_RANGE", /inside -16\.\.\.16/],
    ["LUT_1D_SIZE 2\n0 0 0\n1 1 1.01", "CUT_LUT_VALUE_RANGE", /normalized SDR output domain/],
    ["LUT_1D_SIZE 2\n0 0 0\n1 NaN 1", "CUT_LUT_FORMAT", /finite decimal/],
    ["LUT_1D_SIZE 2\n0 0 0\n1 1 Infinity", "CUT_LUT_FORMAT", /finite decimal/],
    ["LUT_1D_SIZE 2\n0 0 0", "CUT_LUT_FORMAT", /needs 2 RGB rows/],
    ["LUT_1D_SIZE 2\n0 0 0\n1 1 1\n0 0 0", "CUT_LUT_FORMAT", /beyond the declared/],
    ["LUT_1D_SIZE 2\n0 0 0 0\n1 1 1", "CUT_LUT_FORMAT", /exactly three/],
    ["LUT_1D_SIZE 1\n0 0 0", "CUT_LUT_LIMIT", /from 2 through/],
    ["LUT_3D_SIZE 66", "CUT_LUT_LIMIT", /from 2 through 65/],
    ["LUT_2D_SIZE 2\n0 0 0", "CUT_LUT_FORMAT", /unsupported.*directive/],
    ["LUT_1D_SIZE 2\n0 0 0\n1 1 1\nDOMAIN_MAX 1 1 1", "CUT_LUT_FORMAT", /after table data/],
    [new Uint8Array([0xff, 0xfe, 0xfd]), "CUT_LUT_FORMAT", /valid UTF-8/],
    [bytes("LUT_1D_SIZE 2\n0 0 \u0000\n1 1 1"), "CUT_LUT_FORMAT", /unsupported control/],
    [`#${"x".repeat(referenceCubeLutLimits.maxLineBytes + 1)}\nLUT_1D_SIZE 2\n0 0 0\n1 1 1`, "CUT_LUT_LIMIT", /line 1 exceeds/],
  ];
  for (const [input, code, expected] of failures) {
    expectLutError(() => parseReferenceCubeLut(node, typeof input === "string" ? bytes(input) : input), code, expected);
  }
  expectLutError(() => parseReferenceCubeLut(node, new Uint8Array(referenceCubeLutLimits.maxBytes + 1)), "CUT_LUT_LIMIT", /between 1 and/);
  expectLutError(() => parseReferenceCubeLut(node, bytes(`${"\n".repeat(referenceCubeLutLimits.maxLines)}LUT_1D_SIZE 2\n0 0 0\n1 1 1`)), "CUT_LUT_LIMIT", /exceeds 300000 lines/);

  let captured: unknown;
  try { parseReferenceCubeLut(node, bytes("LUT_1D_SIZE 2\n0 0 0")); }
  catch (error) { captured = error; }
  const diagnostics = JSON.parse(JSON.stringify(cutDiagnosticsFromError(captured))) as ReturnType<typeof cutDiagnosticsFromError>;
  assert.equal(diagnostics[0].code, "CUT_LUT_FORMAT");
  assert.deepEqual(diagnostics[0].source, { module: "project.cut", line: 7, column: 5, nodeId: node.id });
  assert.match(diagnostics[0].message, /needs 2 RGB rows/);
});

test("project LUT ownership has a source-located aggregate table budget", () => {
  const ir = compile(tableBudgetSource(referenceCubeLutLimits.maxProjectTables + 1));
  expectLutError(() => validateReferenceLutResourceOwnership(ir), "CUT_LUT_LIMIT", /more than 64 distinct LUT tables/);
});

test("locked 1D/3D LUT pixels, strength endpoints, interpolation, and alpha are exact", async () => {
  const identity = await render(identity1d, "100%");
  // The Rect rasterizer's semi-transparent straight-alpha boundary is itself
  // pinned here. Identity must preserve those actual child bytes, not infer the
  // authored hex literal through a second backend.
  assert.deepEqual(pixel(identity.surface), [49, 101, 153, 128]);

  const creative = await render(creative1d, "100%");
  assert.deepEqual(pixel(creative.surface), [49, 51, 38, 128]);

  const zero = await render(swap3d, "0%"), half = await render(swap3d, "50%"), full = await render(swap3d, "100%");
  assert.deepEqual(pixel(zero.surface), [49, 101, 153, 128]);
  assert.deepEqual(pixel(half.surface), [101, 101, 101, 128]);
  assert.deepEqual(pixel(full.surface), [153, 101, 49, 128]);
  assert.equal(digest(zero.surface.data), digest(identity.surface.data), "0% must preserve every source byte");
  assert.equal(full.surface.data.filter((_, index) => index % 4 === 3).every((alpha) => alpha === 128), true, "LUT must preserve every alpha sample exactly");
});

test("LUT strength is real curve-driven execution rather than a static disguised control", async () => {
  const trailer = "animate grade.strength from 0% to 100% over 1s;";
  const locked = await project(swap3d, source({ strength: "0%", trailer }));
  const node = lutNode(locked.ir), { composition } = validateReferenceSession(locked.ir);
  assert.equal(referenceLutStrengthAt(locked.ir, node, zeroRational), 0);
  assert.equal(referenceLutStrengthAt(locked.ir, node, rational(1, 2)), 0.5);
  const renderer = new ReferenceVisualRenderer(locked.ir, composition, locked.root, resolve(locked.root, ".cut/cache"));
  await renderer.prepare();
  try {
    const scene = locked.ir.scenes[composition.sceneIds[0]];
    assert.deepEqual(pixel(await renderer.sceneFrame(scene, 0, false)), [49, 101, 153, 128]);
    assert.deepEqual(pixel(await renderer.sceneFrame(scene, 2, false)), [101, 101, 101, 128]);
  } finally { renderer.close(); }
});

test("authored nesting, not argument order, determines LUT and grade operation order", async () => {
  const lutThenGrade = await renderProgram(swap3d, orderSource(true));
  const gradeThenLut = await renderProgram(swap3d, orderSource(false));
  assert.deepEqual(pixel(lutThenGrade.surface), [179, 102, 42, 255]);
  assert.deepEqual(pixel(gradeThenLut.surface), [131, 102, 61, 255]);
  assert.notEqual(digest(lutThenGrade.surface.data), digest(gradeThenLut.surface.data));
  const replay = await renderProgram(swap3d, orderSource(true));
  assert.equal(digest(replay.surface.data), digest(lutThenGrade.surface.data));
});

test("an unrelated output does not parse an unreachable LUT as generic JSON", async () => {
  const locked = await project(swap3d, multiOutputSource());
  const plain = validateReferenceSession(locked.ir, "plain").composition;
  const plainRenderer = new ReferenceVisualRenderer(locked.ir, plain, locked.root, resolve(locked.root, ".cut/plain-cache"));
  await plainRenderer.prepare();
  try {
    const frame = await plainRenderer.sceneFrame(locked.ir.scenes[plain.sceneIds[0]], 0, false);
    assert.deepEqual(pixel(frame), [36, 161, 72, 255]);
  } finally { plainRenderer.close(); }

  const looked = validateReferenceSession(locked.ir, "looked").composition;
  const lookedRenderer = new ReferenceVisualRenderer(locked.ir, looked, locked.root, resolve(locked.root, ".cut/looked-cache"));
  await lookedRenderer.prepare();
  try {
    const frame = await lookedRenderer.sceneFrame(locked.ir.scenes[looked.sceneIds[0]], 0, false);
    assert.deepEqual(pixel(frame), [153, 102, 51, 255]);
  } finally { lookedRenderer.close(); }
});

test("LUT format and bytes are validated while locking and reverified before render", async () => {
  const malformedRoot = await mkdtemp(resolve(tmpdir(), "cut-reference-lut-malformed-"));
  await mkdir(resolve(malformedRoot, "assets"));
  await writeFile(resolve(malformedRoot, "assets/look.cube"), "LUT_3D_SIZE 2\n0 0 0\n");
  await assert.rejects(() => createCutLock(compile(), malformedRoot), (error: unknown) => error instanceof ReferenceLutError
    && error.code === "CUT_LUT_FORMAT"
    && error.source.line > 0);

  const wrongExtensionRoot = await mkdtemp(resolve(tmpdir(), "cut-reference-lut-extension-"));
  await mkdir(resolve(wrongExtensionRoot, "assets"));
  await writeFile(resolve(wrongExtensionRoot, "assets/look.CUBE"), identity1d);
  await assert.rejects(() => createCutLock(compile(source({ locator: "assets/look.CUBE" })), wrongExtensionRoot), (error: unknown) => error instanceof ReferenceLutError
    && error.code === "CUT_LUT_RESOURCE"
    && /lowercase \.cube/.test(error.message));

  const sharedRoot = await mkdtemp(resolve(tmpdir(), "cut-reference-lut-shared-"));
  await mkdir(resolve(sharedRoot, "assets"));
  await writeFile(resolve(sharedRoot, "assets/look.cube"), identity1d);
  const shared = source()
    .replace('import { LUT, Rect } from "cut:visual";', 'import { LUT, Rect } from "cut:visual";\nimport { Map } from "@cut/geo";')
    .replace("    LUT(source: look)", "    Map(points: look);\n    LUT(source: look)");
  await assert.rejects(() => createCutLock(compile(shared), sharedRoot), (error: unknown) => error instanceof ReferenceLutError
    && error.code === "CUT_LUT_RESOURCE"
    && /also consumed by cut\.geo\.map/.test(error.message));

  const oversizedRoot = await mkdtemp(resolve(tmpdir(), "cut-reference-lut-oversized-"));
  await mkdir(resolve(oversizedRoot, "assets"));
  await writeFile(resolve(oversizedRoot, "assets/look.cube"), new Uint8Array(referenceCubeLutLimits.maxBytes + 1));
  await assert.rejects(() => createCutLock(compile(), oversizedRoot), (error: unknown) => error instanceof ReferenceLutError
    && error.code === "CUT_LUT_LIMIT"
    && /found 16777217/.test(error.message));

  const locked = await project(identity1d);
  await verifyLockedIrResources(locked.ir, locked.root);
  await writeFile(resolve(locked.root, "assets/look.cube"), creative1d);
  await assert.rejects(() => verifyLockedIrResources(locked.ir, locked.root), (error: unknown) => error instanceof CutLockError
    && error.code === "CUT_LOCK_INTEGRITY"
    && /Locked resource (size|bytes) changed/.test(error.message));
});

test("loaded hostile IR cannot bypass LUT resource, graph, signal, or value closure", async () => {
  const cases: Array<[string, (node: IRNode, ir: CutAVIR) => void, string]> = [
    ["strength", (node, ir) => {
      const strength = { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(2) } as const;
      node.inputs.strength = strength;
      const property = node.properties.strength;
      assert.ok(property && "signal" in property);
      const signal = ir.signals[property.signal];
      assert.ok(signal?.kind === "track");
      signal.initial = strength;
      signal.contentHash = cutSignalContentHash(signal);
    }, "CUT_LUT_VALUE_RANGE"],
    ["source", (node) => { node.inputs.source = { kind: "resource-ref", id: "missing" }; }, "CUT_IR_REFERENCE"],
    ["graph", (node) => { node.children = []; }, "CUT_IR_TYPE"],
    ["signal", (node, ir) => {
      const property = node.properties.strength;
      assert.ok(property && "signal" in property);
      delete ir.signals[property.signal];
    }, "CUT_IR_REFERENCE"],
  ];
  for (const [name, mutate, expectedCode] of cases) {
    const locked = await project(identity1d, source({ strength: "0%", trailer: "animate grade.strength from 0% to 100% over 1s;" }));
    mutate(lutNode(locked.ir), locked.ir);
    finalizeGraphHashes(locked.ir);
    if (expectedCode.startsWith("CUT_IR_")) {
      assert.throws(() => loadCutAvIr(JSON.stringify(locked.ir)), (error: unknown) => {
        assert.ok(error instanceof CutAvIrValidationError, name);
        assert.equal(error.code, expectedCode, name);
        assert.match(error.path, /^\$\./, name);
        return true;
      });
    } else {
      const loaded = loadCutAvIr(JSON.stringify(locked.ir));
      assert.throws(() => validateReferenceSession(loaded), (error: unknown) => {
        assert.ok(error instanceof ReferenceLutError, name);
        assert.equal(error.code, expectedCode, name);
        assert.ok(error.source.line > 0, name);
        return true;
      });
    }
  }
});

test("locked LUT bytes participate in localized picture cache identity", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-lut-cache-"));
  await mkdir(resolve(root, "assets"));
  await writeFile(resolve(root, "assets/look.cube"), identity1d);
  const before = compile(); await applyCutLock(before, await createCutLock(before, root), root);
  const previous = createIncrementalRenderPlan(before, "main").manifest;

  await writeFile(resolve(root, "assets/look.cube"), creative1d);
  const after = compile(); await applyCutLock(after, await createCutLock(after, root), root);
  const plan = createIncrementalRenderPlan(after, "main", previous);
  const lut = lutNode(after), rect = Object.values(after.nodes).find((node) => node.op === "cut.visual.rect")!;
  assert.equal(plan.nodes.find((node) => node.id === rect.id)?.status, "hit", "unchanged child stays reusable");
  assert.equal(plan.nodes.find((node) => node.id === lut.id)?.status, "miss", "locked table bytes invalidate the LUT kernel");
  assert.ok(plan.scenes.every((scene) => scene.status === "miss"), "the containing picture scene must invalidate");
});
