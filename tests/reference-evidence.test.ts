import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Font, Glyph, Path } from "opentype.js";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { packageSymbol } from "../lib/language/packages";
import { rational } from "../lib/language/rational";
import type { ResearchPack } from "../lib/research/types";
import { validateStrictResearchPack } from "../lib/research/validate";
import { prepareReferenceEvidence, referenceEvidenceConfig, referenceEvidenceLimits, referenceEvidenceSvg } from "../lib/runtime/reference/evidence";
import { parseLockedOpenTypeFont } from "../lib/runtime/reference/locked-font";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const fontFixture = resolve("examples/fixtures/Geist-Regular.ttf");

const pack: ResearchPack = {
  format: "cut-research",
  version: 1,
  topic: "A general battery system",
  sources: [
    { id: "lab", title: "Primary battery measurement", url: "https://example.com/research/battery", publisher: "Independent Energy Laboratory", shortLabel: "Energy Lab", retrievedAt: "2026-07-18" },
    { id: "grid", title: "Grid storage report", url: "https://example.org/reports/grid", publisher: "Grid Institute", shortLabel: "Grid Institute", retrievedAt: "2026-07-18" },
  ],
  claims: [
    { id: "cycle-life", text: "The tested cell retained most of its measured capacity after repeated charge cycles.", sourceIds: ["lab"] },
    { id: "shared-result", text: "The reported result is independently supported by two locked sources.", sourceIds: ["lab", "grid"] },
  ],
  locations: [],
  series: [],
  timelines: [],
  metrics: [],
  assets: [],
};

function source(claimId = "cycle-life", options: { mode?: string; width?: number; height?: number; x?: number; y?: number; size?: number; maxWidth?: number } = {}) {
  const width = options.width ?? 640, height = options.height ?? 360, x = options.x ?? 20, y = options.y ?? 176, size = options.size ?? 28, maxWidth = options.maxWidth ?? 600;
  const mode = options.mode === undefined ? "" : `, mode: "${options.mode}"`;
  return `cut 0.4;
project "locked Evidence";
import { Evidence } from "@cut/documentary";
asset research: DataAsset = data("assets/research.json");
asset face: FontAsset = font("assets/Geist-Regular.ttf");
timeline main(duration: 1s, fps: 4, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Evidence(research: research, claimId: "${claimId}", font: face, x: ${x}px, y: ${y}px, size: ${size}px, color: #f4f6f2, accent: #53d8c8, maxWidth: ${maxWidth}px${mode});
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function parse(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module); assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(program = source()) { return compileCutModule(parse(program)).ir; }

function evidenceNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.documentary.evidence");
  assert.ok(node); return node;
}

async function lockedProject(research: ResearchPack | Buffer = pack, program = source(), fontPath = fontFixture) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-evidence-")), assets = resolve(root, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(resolve(assets, "research.json"), Buffer.isBuffer(research) ? research : JSON.stringify(research)),
    copyFile(fontPath, resolve(assets, "Geist-Regular.ttf")),
  ]);
  const ir = compile(program), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  return { root, ir };
}

function lockedWithoutFiles(program = source()) {
  const ir = compile(program);
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked"; resource.sha256 = "0".repeat(64); resource.metadata = { bytes: 128 };
  }
  ir.determinism.semantic = "locked";
  return ir;
}

function sha256(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

function sparseEvidenceFont() {
  const path = new Path(); path.moveTo(80, 0); path.lineTo(80, 700); path.lineTo(920, 700); path.lineTo(920, 0); path.close();
  const missing = new Glyph({ name: ".notdef", unicode: 0, advanceWidth: 1_000, path: new Path() });
  const glyphs = [...new Set(" EVIDENCE-LabA.")].map((character) => new Glyph({ name: `u${character.codePointAt(0)}`, unicode: character.codePointAt(0), advanceWidth: character === " " ? 300 : 1_000, path: character === " " ? new Path() : path }));
  return Buffer.from(new Font({ familyName: "CUT sparse Evidence", styleName: "Regular", unitsPerEm: 1_000, ascender: 800, descender: -200, glyphs: [missing, ...glyphs] }).toArrayBuffer());
}

test("Evidence is a closed typed DataAsset + claim ID + locked font contract and retains both resources in IR", () => {
  const symbol = packageSymbol("@cut/documentary", "Evidence");
  assert.equal(symbol?.openNamed, undefined);
  assert.deepEqual(symbol?.parameters?.map((parameter) => parameter.name), ["research", "claimId", "font", "x", "y", "size", "color", "accent", "maxWidth", "mode", "opacity", "scale", "rotation"]);
  assert.deepEqual(symbol?.parameters?.find((parameter) => parameter.name === "mode"), {
    name: "mode",
    type: "String",
    optional: true,
    default: "claim-card",
    values: ["claim-card", "source-chip"],
  });
  const ir = compile(), node = evidenceNode(ir);
  assert.deepEqual(node.inputs.research, { kind: "resource-ref", id: "research" });
  assert.deepEqual(node.inputs.font, { kind: "resource-ref", id: "face" });
  assert.deepEqual(Object.keys(ir.resources).sort(), ["face", "research"]);

  const invalid = [
    [source().replace("research: research", "research: face"), /research.*expects DataAsset.*FontAsset/],
    [source().replace("font: face", "font: research"), /font.*expects FontAsset.*DataAsset/],
    [source().replace('claimId: "cycle-life"', "claimId: 7"), /claimId.*expects String.*Number/],
    [source().replace("size: 28px", "size: 28"), /size.*expects Length.*Number/],
    [source().replace("maxWidth: 600px", "maxWidth: 600px, mode: 7"), /mode.*expects String.*Number/],
    [source().replace("maxWidth: 600px", "maxWidth: 600px, sourceLabel: \"invented\""), /does not execute input “sourceLabel”/],
  ] as const;
  for (const [program, expected] of invalid) {
    const cutModule = parse(program), messages = checkCutModule(cutModule).diagnostics.map((item) => item.message).join("\n");
    assert.match(messages, expected); assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }
  const missing = source().replace(", font: face", "");
  assert.match(checkCutModule(parse(missing)).diagnostics.map((item) => item.message).join("\n"), /Missing required argument “font”/);
  const obsoleteNominal = source().replace("asset research:", "const loose: Evidence = null;\nasset research:");
  assert.match(checkCutModule(parse(obsoleteNominal)).diagnostics.map((item) => item.message).join("\n"), /Unknown type “Evidence”/);
});

test("loaded Evidence IR receives the same resource, style, and canvas validation", () => {
  const mutate = (action: (node: IRNode, ir: CutAVIR) => void) => { const ir = lockedWithoutFiles(); action(evidenceNode(ir), ir); return ir; };
  assert.throws(() => validateReferenceSession(mutate((node, ir) => { const sourceRef = node.inputs.research; assert.equal(sourceRef.kind, "resource-ref"); ir.resources[sourceRef.id].kind = "font"; })), /research.*DataAsset/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.claimId = { kind: "string", value: "not a valid id" }; })), /claimId.*research ID/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.size = { kind: "quantity", dimension: "length", magnitude: rational(4), unit: "px" }; })), /size.*8 through/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.maxWidth = { kind: "quantity", dimension: "length", magnitude: rational(630), unit: "px" }; })), /x \+ maxWidth.*canvas/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.color = { kind: "color", value: "#ffffff00" }; })), /visibly non-transparent/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.mode = { kind: "string", value: "footnote" }; })), /input “mode” must be (?:exactly )?one of: claim-card, source-chip/);
});

test("strict cut-research v1 validation rejects ignored fields and broken claim provenance", () => {
  assert.doesNotThrow(() => validateStrictResearchPack(pack));
  assert.throws(() => validateStrictResearchPack({ ...pack, invented: true }), /unknown field.*invented/);
  assert.throws(() => validateStrictResearchPack({ ...pack, claims: [{ ...pack.claims[0], sourceIds: ["missing"] }] }), /missing research source/);
  assert.throws(() => validateStrictResearchPack({ ...pack, sources: [{ ...pack.sources[0], title: "A", trackingPixel: true }] }), /unknown field.*trackingPixel/);
  assert.throws(() => validateStrictResearchPack({ ...pack, sources: [{ ...pack.sources[0], retrievedAt: "2026-02-30" }] }), /ISO calendar date/);
});

test("Evidence derives bounded source/claim text into locked glyph paths and deterministic pixels", { timeout: 30_000 }, async () => {
  const { root, ir } = await lockedProject(), { composition } = validateReferenceSession(ir), node = evidenceNode(ir);
  const config = referenceEvidenceConfig(node, ir, composition); assert.ok(config);
  const researchBytes = await readFile(resolve(root, "assets/research.json")), fontBytes = await readFile(resolve(root, "assets/Geist-Regular.ttf"));
  const font = parseLockedOpenTypeFont(fontBytes, "assets/Geist-Regular.ttf", { maxBytes: referenceEvidenceLimits.maxFontBytes, maxGlyphs: referenceEvidenceLimits.maxFontGlyphs });
  const prepared = prepareReferenceEvidence(node, config, researchBytes, font), svg = referenceEvidenceSvg(prepared);
  assert.equal(config.mode, "claim-card");
  assert.equal(prepared.claim.id, "cycle-life"); assert.equal(prepared.sources[0].id, "lab");
  assert.match(svg, /<title[^>]*>EVIDENCE - Energy Lab/);
  assert.match(svg, /<path d=/); assert.doesNotMatch(svg, /<text|font-family|@font-face/);
  assert.ok(prepared.claimLines.length >= 1 && prepared.claimLines.length <= referenceEvidenceLimits.maxLines);

  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  let baselineHash = "";
  try {
    await renderer.prepare(); const scene = ir.scenes[composition.sceneIds[0]], first = await renderer.sceneFrame(scene, 0), repeated = await renderer.sceneFrame(scene, 0);
    baselineHash = sha256(first.data); assert.equal(baselineHash, sha256(repeated.data)); assert.ok(first.data.some((value) => value !== 0));
  } finally { renderer.close(); }

  const explicit = await lockedProject(pack, source("cycle-life", { mode: "claim-card" })), explicitSession = validateReferenceSession(explicit.ir), explicitNode = evidenceNode(explicit.ir);
  const explicitConfig = referenceEvidenceConfig(explicitNode, explicit.ir, explicitSession.composition); assert.ok(explicitConfig);
  const explicitPrepared = prepareReferenceEvidence(explicitNode, explicitConfig, await readFile(resolve(explicit.root, "assets/research.json")), parseLockedOpenTypeFont(await readFile(resolve(explicit.root, "assets/Geist-Regular.ttf")), "assets/Geist-Regular.ttf", { maxBytes: referenceEvidenceLimits.maxFontBytes, maxGlyphs: referenceEvidenceLimits.maxFontGlyphs }));
  assert.equal(referenceEvidenceSvg(explicitPrepared), svg, "explicit claim-card must preserve the default SVG geometry exactly");
  const explicitRenderer = new ReferenceVisualRenderer(explicit.ir, explicitSession.composition, explicit.root, resolve(explicit.root, "cache"));
  try { await explicitRenderer.prepare(); assert.equal(sha256((await explicitRenderer.sceneFrame(explicit.ir.scenes[explicitSession.composition.sceneIds[0]], 0)).data), baselineHash, "explicit claim-card must preserve default pixels exactly"); }
  finally { explicitRenderer.close(); }

  const other = await lockedProject(pack, source("shared-result")), otherSession = validateReferenceSession(other.ir), otherRenderer = new ReferenceVisualRenderer(other.ir, otherSession.composition, other.root, resolve(other.root, "cache"));
  try { await otherRenderer.prepare(); assert.notEqual(sha256((await otherRenderer.sceneFrame(other.ir.scenes[otherSession.composition.sceneIds[0]], 0)).data), baselineHash); }
  finally { otherRenderer.close(); }
});

test("source-chip is compact, mobile-sized, source-only, locked-outline, and pixel deterministic", { timeout: 30_000 }, async () => {
  const program = source("cycle-life", { mode: "source-chip", width: 390, height: 160, x: 12, y: 52, size: 22, maxWidth: 366 });
  const { root, ir } = await lockedProject(pack, program), { composition } = validateReferenceSession(ir), node = evidenceNode(ir), config = referenceEvidenceConfig(node, ir, composition); assert.ok(config);
  const font = parseLockedOpenTypeFont(await readFile(resolve(root, "assets/Geist-Regular.ttf")), "assets/Geist-Regular.ttf", { maxBytes: referenceEvidenceLimits.maxFontBytes, maxGlyphs: referenceEvidenceLimits.maxFontGlyphs });
  const prepared = prepareReferenceEvidence(node, config, await readFile(resolve(root, "assets/research.json")), font), svg = referenceEvidenceSvg(prepared);
  assert.equal(config.mode, "source-chip"); assert.equal(config.size, 22); assert.equal(prepared.label, "Energy Lab");
  assert.deepEqual(prepared.claimLines, []); assert.deepEqual(prepared.claimOutlines, []);
  assert.ok(prepared.layout.width < config.maxWidth && prepared.layout.x + prepared.layout.width <= 390);
  assert.ok(prepared.layout.height < 2 * config.size && prepared.layout.y + prepared.layout.height <= 160);
  assert.match(svg, /<title[^>]*>Energy Lab<\/title>/); assert.match(svg, /<rect/); assert.match(svg, /<path d=/);
  assert.doesNotMatch(svg, /tested cell|retained most|EVIDENCE -|<text|font-family|@font-face/);

  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare(); const scene = ir.scenes[composition.sceneIds[0]], first = await renderer.sceneFrame(scene, 0), replay = await renderer.sceneFrame(scene, 0);
    assert.equal(sha256(first.data), sha256(replay.data));
  } finally { renderer.close(); }
});

test("Evidence preparation fails closed on malformed bytes, schema drift, missing claims, glyph fallback, and resource budgets", { timeout: 30_000 }, async () => {
  const malformed = await lockedProject(Buffer.from([0xff, 0xfe, 0xfd])), malformedSession = validateReferenceSession(malformed.ir), malformedRenderer = new ReferenceVisualRenderer(malformed.ir, malformedSession.composition, malformed.root, resolve(malformed.root, "cache"));
  await assert.rejects(() => malformedRenderer.prepare(), /not valid UTF-8/); malformedRenderer.close();

  const unknown = await lockedProject({ ...pack, ignoredStyle: "host-font" } as ResearchPack), unknownSession = validateReferenceSession(unknown.ir), unknownRenderer = new ReferenceVisualRenderer(unknown.ir, unknownSession.composition, unknown.root, resolve(unknown.root, "cache"));
  await assert.rejects(() => unknownRenderer.prepare(), /unknown field.*ignoredStyle/); unknownRenderer.close();

  const missing = await lockedProject(pack, source("missing-claim")), missingSession = validateReferenceSession(missing.ir), missingRenderer = new ReferenceVisualRenderer(missing.ir, missingSession.composition, missing.root, resolve(missing.root, "cache"));
  await assert.rejects(() => missingRenderer.prepare(), /cannot find claimId “missing-claim”/); missingRenderer.close();

  const sparseRoot = await mkdtemp(resolve(tmpdir(), "cut-reference-evidence-font-")), sparsePath = resolve(sparseRoot, "sparse.ttf"); await writeFile(sparsePath, sparseEvidenceFont());
  const sparsePack = { ...pack, sources: [{ ...pack.sources[0], shortLabel: "Lab" }], claims: [{ id: "cycle-life", text: "B", sourceIds: ["lab"] }] };
  const sparse = await lockedProject(sparsePack, source(), sparsePath), sparseSession = validateReferenceSession(sparse.ir), sparseRenderer = new ReferenceVisualRenderer(sparse.ir, sparseSession.composition, sparse.root, resolve(sparse.root, "cache"));
  await assert.rejects(() => sparseRenderer.prepare(), /no glyph for U\+0042/); sparseRenderer.close();

  const budget = await lockedProject(), budgetSession = validateReferenceSession(budget.ir), budgetNode = evidenceNode(budget.ir), sourceRef = budgetNode.inputs.research; assert.equal(sourceRef.kind, "resource-ref");
  budget.ir.resources[sourceRef.id].metadata = { bytes: referenceEvidenceLimits.maxResearchBytes + 1 };
  const budgetRenderer = new ReferenceVisualRenderer(budget.ir, budgetSession.composition, budget.root, resolve(budget.root, "cache"));
  await assert.rejects(() => budgetRenderer.prepare(), /Evidence resource.*exceeds/); budgetRenderer.close();
});
