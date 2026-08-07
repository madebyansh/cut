import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { Font, Glyph, Path } from "opentype.js";
import { serializeSubRip, serializeWebVtt } from "../lib/interchange/captions";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  createReferenceCaptionPreparationCache,
  prepareReferenceCaptions,
  referenceCaptionConfig,
  referenceCaptionCueAt,
  referenceCaptionLayout,
  referenceCaptionSvg,
} from "../lib/runtime/reference/caption-render";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { parseLockedOpenTypeFont } from "../lib/runtime/reference/locked-font";

const fontFixture = resolve("examples/fixtures/Geist-Regular.ttf");

const vtt = `WEBVTT

first
00:00:00.000 --> 00:00:00.500
One exact cue

second
00:00:00.500 --> 00:00:01.000 line:80%,end position:20%,line-left size:60% align:left
Two & more
Second line
`;

function source(format: "webvtt" | "srt" = "webvtt", locator = format === "webvtt" ? "captions.vtt" : "captions.srt", body = "") {
  return `cut 0.4;
project "reference captions";
import { Captions${body ? ", Rect" : ""} } from "cut:visual";
asset captions: DataAsset = data("assets/${locator}");
asset face: FontAsset = font("assets/Geist-Regular.ttf");
timeline main(duration: 2s, fps: 4, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    Captions(source: captions, font: face, format: "${format}", size: 22px, color: #ffffff, background: #000000d9, safeX: 5%, safeY: 5%, maxWidth: 90%, padding: 8px, radius: 6px, lineHeight: 110%);
    ${body}
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");`;
}

function parse(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(program = source()) { return compileCutModule(parse(program)).ir; }

function captionNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.captions");
  assert.ok(node);
  return node;
}

function sha256(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

function outlineFont(shape: "rectangle" | "triangle") {
  const path = new Path(); path.moveTo(50, 0);
  if (shape === "rectangle") { path.lineTo(50, 700); path.lineTo(950, 700); path.lineTo(950, 0); }
  else { path.lineTo(500, 700); path.lineTo(950, 0); }
  path.close();
  const missing = new Glyph({ name: ".notdef", unicode: 0, advanceWidth: 1_000, path: new Path() });
  const glyph = new Glyph({ name: "A", unicode: 65, advanceWidth: 1_000, path });
  return Buffer.from(new Font({ familyName: `Cut ${shape}`, styleName: "Regular", unitsPerEm: 1_000, ascender: 800, descender: -200, glyphs: [missing, glyph] }).toArrayBuffer());
}

async function lockedProject(captionText = vtt, program = source()) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-captions-")), assets = resolve(root, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(resolve(assets, "captions.vtt"), captionText),
    writeFile(resolve(assets, "captions.srt"), captionText),
    copyFile(fontFixture, resolve(assets, "Geist-Regular.ttf")),
  ]);
  const ir = compile(program), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return { root, ir };
}

function lockedWithoutFiles(program = source()) {
  const ir = compile(program);
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = { bytes: 1 };
  }
  ir.determinism.semantic = "locked";
  return ir;
}

test("Captions is one closed typed source primitive with no hidden text or animation path", () => {
  const invalid = [
    [source().replace("source: captions", "source: face"), /source.*expects CaptionAsset.*FontAsset/],
    [source().replace("font: face", "font: captions"), /font.*expects FontAsset.*DataAsset/],
    [source().replace('format: "webvtt"', "format: 1"), /format.*expects String.*Number/],
    [source().replace("size: 22px", "size: 22%"), /size.*expects Length.*Ratio/],
    [source().replace("lineHeight: 110%", "lineHeight: 22px"), /lineHeight.*expects Ratio.*Length/],
    [source().replace("lineHeight: 110%", "lineHeight: 110%, invented: true"), /does not execute input “invented”/],
  ] as const;
  for (const [program, expected] of invalid) {
    const cutModule = parse(program), messages = checkCutModule(cutModule).diagnostics.map((item) => item.message).join("\n");
    assert.match(messages, expected);
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }

  const missing = source().replace(", font: face", "");
  assert.match(checkCutModule(parse(missing)).diagnostics.map((item) => item.message).join("\n"), /Missing required argument “font”/);
  const animated = source().replace(");\n    ", ") as subtitles;\n    animate subtitles.opacity from 0% to 100% over 1s;\n    ");
  assert.match(checkCutModule(parse(animated)).diagnostics.map((item) => item.message).join("\n"), /no executable property “opacity”/);
});

test("Captions size fails during source checking and resolved compiler lowering before rendering", () => {
  for (const invalidSize of ["11px", "257px"] as const) {
    const program = source().replace("size: 22px", `size: ${invalidSize}`);
    const diagnostics = checkCutModule(parse(program)).diagnostics;
    const failure = diagnostics.find((item) => item.code === "CUT_CAPTION_VALUE_RANGE");
    assert.ok(failure, JSON.stringify(diagnostics));
    assert.match(failure.message, /pixel Length from 12px through 256px/u);
    assert.equal(program.slice(failure.span.start.offset, failure.span.end.offset), invalidSize);
    assert.throws(() => compileCutModule(parse(program)), CutCompileError);
  }

  for (const boundary of ["12px", "256px"] as const) {
    const program = source().replace("size: 22px", `size: ${boundary}`);
    assert.equal(
      checkCutModule(parse(program)).diagnostics.filter((item) => item.code === "CUT_CAPTION_VALUE_RANGE").length,
      0,
      boundary,
    );
    assert.doesNotThrow(() => compileCutModule(parse(program)), boundary);
  }

  const indirect = source()
    .replace("timeline main", "const captionSize: Length = 8px;\ntimeline main")
    .replace("size: 22px", "size: captionSize");
  assert.equal(
    checkCutModule(parse(indirect)).diagnostics.filter((item) => item.code === "CUT_CAPTION_VALUE_RANGE").length,
    0,
    "the source checker does not pretend to evaluate an identifier",
  );
  assert.throws(
    () => compileCutModule(parse(indirect)),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT_CAPTION_VALUE_RANGE"
        && /12px through 256px/u.test(item.message)
        && indirect.slice(item.span.start.offset, item.span.end.offset) === "captionSize"),
  );
});

test("loaded IR receives the same closed style, resource, and safe-area validation", () => {
  const mutate = (action: (node: IRNode, ir: CutAVIR) => void) => {
    const ir = lockedWithoutFiles(); action(captionNode(ir), ir); return ir;
  };
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.format = { kind: "string", value: "auto" }; })), /format.*webvtt, srt/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.safeX = { kind: "quantity", dimension: "ratio", magnitude: rational(3, 10), unit: "ratio" }; })), /safeX.*between 0 and 0.25/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.maxWidth = { kind: "quantity", dimension: "ratio", magnitude: rational(1), unit: "ratio" }; })), /maxWidth.*horizontal safe area/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.inputs.lineHeight = { kind: "quantity", dimension: "length", magnitude: rational(22), unit: "px" }; })), /lineHeight.*ratio quantity/);
  assert.throws(() => validateReferenceSession(mutate((node) => { node.interval.duration = rational(0); })), /destination interval.*must be positive/);
  assert.throws(() => validateReferenceSession(mutate((node, ir) => { const sourceRef = node.inputs.source; assert.equal(sourceRef.kind, "resource-ref"); ir.resources[sourceRef.id].kind = "font"; })), /source.*DataAsset/);
});

test("locked WebVTT crosses typed CUT -> AV IR -> exact cue lookup -> deterministic pixels", { timeout: 30_000 }, async () => {
  const { root, ir } = await lockedProject(), { composition } = validateReferenceSession(ir);
  const node = captionNode(ir), config = referenceCaptionConfig(node, ir, composition);
  assert.ok(config);
  assert.deepEqual({ source: config.sourceId, font: config.fontId, format: config.format, canvas: [config.canvasWidth, config.canvasHeight] }, { source: "captions", font: "face", format: "webvtt", canvas: [320, 180] });
  assert.match(node.contentHash, /^[a-f0-9]{64}$/);

  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]], frames = [];
    for (let frame = 0; frame < 6; frame += 1) frames.push(await renderer.sceneFrame(scene, frame));
    const hashes = frames.map((frame) => sha256(frame.data));
    assert.equal(hashes[0], hashes[1], "one cue is a stable cached surface across its exact interval");
    assert.equal(hashes[2], hashes[3], "the contiguous cue switches exactly at 500 ms");
    assert.notEqual(hashes[0], hashes[2], "different authored cue pixels differ");
    assert.equal(hashes[4], hashes[5], "caption silence is stable after the exact end boundary");
    assert.notEqual(hashes[3], hashes[4], "the cue disappears at its end rather than leaking one frame");
  } finally { renderer.close(); }
});

test("prepared tracks retain pure WebVTT/SRT interchange and preserve glyph-covered Unicode multiline order", async () => {
  const { root, ir } = await lockedProject(), { composition } = validateReferenceSession(ir), node = captionNode(ir), config = referenceCaptionConfig(node, ir, composition);
  assert.ok(config);
  const captionBytes = await readFile(resolve(root, "assets/captions.vtt")), fontBytes = await readFile(resolve(root, "assets/Geist-Regular.ttf"));
  const prepared = prepareReferenceCaptions(node, config, captionBytes, "assets/Geist-Regular.ttf", fontBytes);
  assert.equal(serializeWebVtt(prepared.track), vtt);
  assert.equal(referenceCaptionCueAt(prepared.track, rational(499, 1000))?.id, "first");
  assert.equal(referenceCaptionCueAt(prepared.track, rational(1, 2))?.id, "second");
  assert.equal(referenceCaptionCueAt(prepared.track, rational(1)), undefined);

  const unicode = vtt.replace("Two & more\nSecond line", "Café & déjà vu\nnaïve — résumé");
  const latin = prepareReferenceCaptions(node, config, Buffer.from(unicode), "assets/Geist-Regular.ttf", fontBytes), cue = latin.track.cues[1];
  const svg = referenceCaptionSvg(latin, cue, 320, 180);
  assert.ok(svg.indexOf("Café &amp; déjà vu") < svg.indexOf("naïve — résumé"), "authored multiline order is unchanged");
  assert.match(svg, /<title[^>]*>Café &amp; déjà vu\nnaïve — résumé<\/title>/);
  assert.match(svg, /<path d=/, "locked glyphs are explicit geometry");
  assert.doesNotMatch(svg, /<text|font-family|@font-face/, "no host text or font fallback enters the formal render path");

  const srt = "1\r\n00:00:00,000 --> 00:00:00,500\r\nFirst\r\n\r\n2\r\n00:00:00,500 --> 00:00:01,000\r\nSecond\r\n";
  const srtIr = compile(source("srt")), srtNode = captionNode(srtIr), srtConfig = referenceCaptionConfig(srtNode, srtIr, srtIr.compositions[0]);
  assert.ok(srtConfig);
  const preparedSrt = prepareReferenceCaptions(srtNode, srtConfig, Buffer.from(srt), "assets/Geist-Regular.ttf", fontBytes);
  assert.equal(serializeSubRip(preparedSrt.track), srt);
});

test("WebVTT horizontal settings map to a bounded safe-area layout without reordering text", async () => {
  const positioned = `WEBVTT

cue
00:00:00.000 --> 00:00:01.000 line:10%,start position:25%,line-left size:50% align:left
First
Second
`;
  const { root, ir } = await lockedProject(positioned), { composition } = validateReferenceSession(ir), node = captionNode(ir), config = referenceCaptionConfig(node, ir, composition);
  assert.ok(config);
  const prepared = prepareReferenceCaptions(node, config, Buffer.from(positioned), "assets/Geist-Regular.ttf", await readFile(resolve(root, "assets/Geist-Regular.ttf"))), cue = prepared.track.cues[0];
  const layout = referenceCaptionLayout(prepared, cue, 320, 180);
  assert.equal(layout.box.x, 80); assert.equal(layout.box.y, 18); assert.equal(layout.box.width, 160);
  assert.ok(layout.box.height > 0 && layout.box.y + layout.box.height <= 171, "actual glyph bounds stay within the vertical safe area");
  assert.equal(layout.text.x, 88); assert.equal(layout.text.anchor, "start"); assert.equal(layout.text.maximumLineWidth, 144);

  const automatic = (align: "left" | "right") => positioned.replace("line:10%,start position:25%,line-left size:50% align:left", `line:10%,start size:50% align:${align}`);
  const left = prepareReferenceCaptions(node, config, Buffer.from(automatic("left")), "assets/Geist-Regular.ttf", await readFile(resolve(root, "assets/Geist-Regular.ttf")));
  const right = prepareReferenceCaptions(node, config, Buffer.from(automatic("right")), "assets/Geist-Regular.ttf", await readFile(resolve(root, "assets/Geist-Regular.ttf")));
  assert.equal(referenceCaptionLayout(left, left.track.cues[0], 320, 180).box.x, 16, "left alignment defaults to the safe-left anchor");
  assert.equal(referenceCaptionLayout(right, right.track.cues[0], 320, 180).box.x, 144, "right alignment defaults to the safe-right anchor");
});

test("two valid locked outline fonts produce different SVG geometry and pixels", async () => {
  const ir = lockedWithoutFiles(), node = captionNode(ir), config = referenceCaptionConfig(node, ir, ir.compositions[0]); assert.ok(config);
  const cueBytes = Buffer.from("WEBVTT\n\nonly\n00:00:00.000 --> 00:00:01.000\nA\n"), rectangle = outlineFont("rectangle"), triangle = outlineFont("triangle");
  const rectanglePrepared = prepareReferenceCaptions(node, config, cueBytes, "rectangle.otf", rectangle), trianglePrepared = prepareReferenceCaptions(node, config, cueBytes, "triangle.otf", triangle);
  const rectangleSvg = referenceCaptionSvg(rectanglePrepared, rectanglePrepared.track.cues[0], 320, 180), triangleSvg = referenceCaptionSvg(trianglePrepared, trianglePrepared.track.cues[0], 320, 180);
  assert.notEqual(rectangleSvg, triangleSvg, "locked outline bytes control emitted geometry");
  const rectanglePixels = await sharp(Buffer.from(rectangleSvg)).ensureAlpha().raw().toBuffer(), trianglePixels = await sharp(Buffer.from(triangleSvg)).ensureAlpha().raw().toBuffer();
  assert.notEqual(sha256(rectanglePixels), sha256(trianglePixels), "locked outline bytes control rasterized pixels");
  assert.doesNotMatch(rectangleSvg + triangleSvg, /<text|font-family|@font-face/);
});

test("preparation cache shares parsed locked font and caption track objects", async () => {
  const { root, ir } = await lockedProject(), node = captionNode(ir), config = referenceCaptionConfig(node, ir, ir.compositions[0]); assert.ok(config);
  const captionBytes = await readFile(resolve(root, "assets/captions.vtt")), fontBytes = await readFile(resolve(root, "assets/Geist-Regular.ttf")), cache = createReferenceCaptionPreparationCache();
  const first = prepareReferenceCaptions(node, config, captionBytes, "assets/Geist-Regular.ttf", fontBytes, cache);
  const second = prepareReferenceCaptions(node, config, captionBytes, "assets/Geist-Regular.ttf", fontBytes, cache);
  assert.equal(first.font, second.font, "one font resource retains one parsed OpenType graph");
  assert.equal(first.track, second.track, "one source/format retains one parsed caption track");
  assert.notEqual(first.outlines, second.outlines, "per-node preflight data remains independently bounded");
});

test("caption preparation fails closed on malformed bytes, unsupported placement, bounds, font, and format reuse", async () => {
  const cases: Array<[string, RegExp]> = [
    [vtt.replace("One exact cue", "<i>styled</i>"), /CUT_CAPTION_MARKUP/],
    [vtt.replace("00:00:00.500 --> 00:00:01.000", "00:00:00.400 --> 00:00:01.000"), /CUT_CAPTION_OVERLAP/],
    [vtt.replace("line:80%,end", "line:-1,end"), /snap-to-line WebVTT placement/],
    [vtt.replace("00:00:00.500 --> 00:00:01.000", "00:00:00.500 --> 00:00:02.001"), /ends after the Captions node duration/],
    [vtt.replace("One exact cue", "x".repeat(241)), /240-code-point render budget/],
    [vtt.replace("One exact cue", "こんにちは"), /no glyph for U\+3053/],
    [vtt.replace("line:80%,end position:20%,line-left size:60%", "line:80%,end position:20%,line-left size:0%"), /no usable text width/],
  ];
  for (const [text, expected] of cases) {
    const { root, ir } = await lockedProject(text), { composition } = validateReferenceSession(ir), renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
    await assert.rejects(() => renderer.prepare(), expected);
  }

  const explicitMismatch = await lockedProject(vtt, source("srt", "captions.vtt"));
  const mismatchSession = validateReferenceSession(explicitMismatch.ir), mismatchRenderer = new ReferenceVisualRenderer(explicitMismatch.ir, mismatchSession.composition, explicitMismatch.root, resolve(explicitMismatch.root, "cache"));
  await assert.rejects(() => mismatchRenderer.prepare(), /cannot parse locked srt source/);

  const corruptFont = await lockedProject();
  await writeFile(resolve(corruptFont.root, "assets/Geist-Regular.ttf"), Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(8)]));
  const relocked = compile(), newLock = await createCutLock(relocked, corruptFont.root); await applyCutLock(relocked, newLock, corruptFont.root);
  const corruptSession = validateReferenceSession(relocked), corruptRenderer = new ReferenceVisualRenderer(relocked, corruptSession.composition, corruptFont.root, resolve(corruptFont.root, "cache"));
  await assert.rejects(() => corruptRenderer.prepare(), /invalid or over-budget sfnt table directory/);

  const shared = await lockedProject(vtt, source("webvtt", "captions.vtt", "Rect(width: 8px, height: 8px);")), sharedSession = validateReferenceSession(shared.ir);
  const rect = Object.values(shared.ir.nodes).find((node) => node.op === "cut.visual.rect"); assert.ok(rect);
  rect.inputs.captionBytes = captionNode(shared.ir).inputs.source;
  const sharedRenderer = new ReferenceVisualRenderer(shared.ir, sharedSession.composition, shared.root, resolve(shared.root, "cache"));
  await assert.rejects(() => sharedRenderer.prepare(), /cannot also be consumed as JSON/);
});

test("caption preparation rejects unsupported variable/color font semantics before parsing", () => {
  const base = outlineFont("rectangle"), tableCount = base.readUInt16BE(4);
  assert.ok(tableCount > 0);
  for (const tag of ["fvar", "COLR"] as const) {
    const bytes = Buffer.from(base); bytes.write(tag, 12, 4, "ascii");
    assert.throws(() => parseLockedOpenTypeFont(bytes, `${tag}.otf`, { maxBytes: 2_000_000, maxGlyphs: 10_000 }), /fixed-instance monochrome outline TTF\/OTF/);
  }
});

test("selected-output caption validation ignores different-composition and detached caption nodes", async () => {
  const program = `cut 0.4;
project "caption output isolation";
import { Captions } from "cut:visual";
asset captions: DataAsset = data("assets/captions.vtt");
asset face: FontAsset = font("assets/Geist-Regular.ttf");
timeline small(duration: 1s, fps: 4, width: 320px, height: 180px) {
  scene smallScene(duration: 1s) { Captions(source: captions, font: face, format: "webvtt", size: 22px); }
}
timeline large(duration: 1s, fps: 4, width: 1920px, height: 1080px) {
  scene largeScene(duration: 1s) { Captions(source: captions, font: face, format: "webvtt", size: 256px, padding: 64px); }
}
export smallOut = render(small);
export largeOut = render(large);`;
  const ir = lockedWithoutFiles(program), session = validateReferenceSession(ir, "smallOut");
  assert.equal(session.composition.name, "small");
  const renderer = new ReferenceVisualRenderer(ir, session.composition, "/unused", "/unused"); renderer.close();

  const project = await lockedProject(), base = captionNode(project.ir);
  for (let index = 0; index < 65; index += 1) {
    const detached = structuredClone(base); detached.id = `detached-caption-${index}`;
    // Keep the intrinsic contract valid while making the node impossible for
    // the selected canvas. Detached nodes must not receive reachable-only
    // caption layout validation.
    detached.inputs.size = { kind: "quantity", dimension: "length", magnitude: rational(100_000), unit: "px" };
    project.ir.nodes[detached.id] = detached;
  }
  const selected = validateReferenceSession(project.ir), selectedRenderer = new ReferenceVisualRenderer(project.ir, selected.composition, project.root, resolve(project.root, "cache"));
  await selectedRenderer.prepare(); selectedRenderer.close();
});
