import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational, type Rational } from "../lib/language/rational";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

type AnalysisKind = "Waveform" | "Spectrogram";
type RawSurface = { data: Uint8Array; width: number; height: number };

const width = 96;
const height = 64;
const sampleRate = 48_000;

function pcm16MonoWav(seconds = 1) {
  const frames = sampleRate * seconds;
  const dataBytes = frames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // linear PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    const envelope = Math.sin(Math.PI * Math.min(1, time / seconds)) ** 2;
    const chirpPhase = 2 * Math.PI * (110 * time + 330 * time * time);
    const pulse = frame % 6_000 < 1_000 ? Math.sin(2 * Math.PI * 880 * time) : 0;
    const value = envelope * (Math.sin(chirpPhase) * 0.56 + Math.sin(2 * Math.PI * 220 * time) * 0.22 + pulse * 0.12);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32_767), 44 + frame * 2);
  }
  return wav;
}

async function fixtureRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-analysis-visual-"));
  await mkdir(resolve(root, "media"), { recursive: true });
  await writeFile(resolve(root, "media", "analysis.wav"), pcm16MonoWav());
  return root;
}

function source(kind: AnalysisKind, authored: string) {
  return `cut 0.4;
project "analysis reveal proof";
import { ${kind} } from "@cut/data";
asset analysis: AudioAsset = audio("media/analysis.wav");
timeline main(duration: 1s, fps: 4, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${authored}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function compile(sourceText: string) {
  const parsed = parseCutLanguage(sourceText);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(parsed.module).ir;
}

function digest(surface: RawSurface) {
  return createHash("sha256").update(surface.data).digest("hex");
}

function alphaAt(surface: RawSurface, x: number, y: number) {
  return surface.data[(y * surface.width + x) * 4 + 3];
}

function opaquePixels(surface: RawSurface, left: number, right: number) {
  let result = 0;
  for (let y = 0; y < surface.height; y += 1) {
    for (let x = left; x < right; x += 1) if (alphaAt(surface, x, y) !== 0) result += 1;
  }
  return result;
}

async function render(root: string, sourceText: string, kind: AnalysisKind) {
  const ir = compile(sourceText);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir);
  const scene = ir.scenes[composition.sceneIds[0]];
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === `cut.data.${kind.toLowerCase()}`);
  assert.ok(node, `${kind} must lower to its public reference kernel`);
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "analysis-visual-cache"));
  await renderer.prepare();
  try {
    // The raw node surface lets this test distinguish transparent reveal from
    // merely drawing the scene's dark background color over the analysis.
    const internal = renderer as unknown as {
      nodeFrame(nodeId: string, time: Rational, frame: number): Promise<RawSurface | undefined>;
    };
    const nodeSurface = await internal.nodeFrame(node.id, rational(0), 0);
    assert.ok(nodeSurface);
    const sceneSurface = await renderer.sceneFrame(scene, 0);
    return { node: nodeSurface, scene: sceneSurface };
  } finally {
    renderer.close();
  }
}

for (const kind of ["Waveform", "Spectrogram"] as const) {
  test(`${kind} public syntax locks audio and executes static reveal in decoded RGBA`, { timeout: 60_000 }, async () => {
    const root = await fixtureRoot();
    const rendered = await Promise.all([0, 50, 100].map((reveal) => render(
      root,
      source(kind, `${kind}(source: analysis, range: 0s ..< 1s, reveal: ${reveal}%);`),
      kind,
    )));
    const [hidden, half, full] = rendered.map((item) => item.node);

    assert.equal(new Set(rendered.map((item) => digest(item.node))).size, 3, "0%, 50%, and 100% must decode to distinct RGBA");
    assert.equal(opaquePixels(hidden, 0, width), 0, "0% reveal must be a truly transparent node layer before scene compositing");
    assert.ok(opaquePixels(half, 0, width / 2) > 0, "50% reveal must expose the left half");
    assert.equal(opaquePixels(half, width / 2, width), 0, "50% reveal must leave the right half transparent");
    assert.ok(opaquePixels(full, width / 2, width) > 0, "100% reveal must expose analysis pixels in the right half");
    assert.notEqual(digest(hidden), digest(rendered[0].scene), "scene compositing must add its background after the transparent node layer");
  });

  test(`${kind} property signal has pixel parity with the equivalent static reveal`, { timeout: 60_000 }, async () => {
    const root = await fixtureRoot();
    const staticValue = await render(root, source(kind, `${kind}(source: analysis, range: 0s ..< 1s, reveal: 50%);`), kind);
    const propertyValue = await render(root, source(kind, `${kind}(source: analysis, range: 0s ..< 1s) as analysisGraphic; set analysisGraphic.reveal = 50%;`), kind);
    assert.equal(digest(propertyValue.node), digest(staticValue.node));
    assert.equal(digest(propertyValue.scene), digest(staticValue.scene));
  });
}

test("loaded Waveform/Spectrogram IR rejects malformed and out-of-range reveal values", async () => {
  for (const kind of ["Waveform", "Spectrogram"] as const) {
    for (const reveal of [
      { kind: "quantity", dimension: "ratio", magnitude: rational(2), unit: "ratio" },
      { kind: "string", value: "half" },
    ] as const) {
      const root = await fixtureRoot(), ir = compile(source(kind, `${kind}(source: analysis, range: 0s ..< 1s, reveal: 50%);`));
      await applyCutLock(ir, await createCutLock(ir, root), root);
      const node = Object.values(ir.nodes).find((candidate) => candidate.op === `cut.data.${kind.toLowerCase()}`); assert.ok(node);
      node.inputs.reveal = reveal;
      assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
        assert.ok(error instanceof ReferenceVisualConfigError);
        assert.equal(error.code, reveal.kind === "string" ? "CUT_VISUAL_INPUT_TYPE" : "CUT_VISUAL_VALUE_RANGE");
        assert.match(error.message, /project\.cut:\d+:\d+/); return true;
      });
    }
  }
});
