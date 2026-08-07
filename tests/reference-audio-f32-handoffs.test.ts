import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRComposition } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import {
  ReferenceAudioSelectionError,
  referenceMasterAudioRootIds,
  renderReferenceAudio,
  renderReferenceAudioSelection,
} from "../lib/runtime/reference/audio";
import {
  quantizeReferenceStereoF32LeFileToPcm24Wave,
  ReferenceAudioPeakError,
} from "../lib/runtime/reference/audio-peak";
import {
  prepareReferenceTimeStretchSources,
  ReferenceTimeStretchError,
} from "../lib/runtime/reference/audio-time-stretch";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const sampleRate = 48_000;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  return ir;
}

function composition(ir: CutAVIR, id = "main") {
  const result = ir.compositions.find((candidate) => candidate.id === id);
  assert.ok(result);
  return result;
}

function audioProgram(body: string, duration = "200ms") {
  return `cut 0.4;
project "f32 handoff proof";
import { Bus, Compressor, Gain, TimeStretch, Tone } from "@cut/audio";
timeline main(duration: ${duration}, fps: 20, width: 32px, height: 24px, sampleRate: 48khz) {
  ${body}
}
export out = render(main);`;
}

function rawSample(buffer: Buffer, frame: number, channel: 0 | 1) {
  return buffer.readFloatLE(frame * 8 + channel * 4);
}

function rawPeak(buffer: Buffer) {
  assert.equal(buffer.byteLength % 8, 0);
  let peak = 0;
  for (let offset = 0; offset < buffer.byteLength; offset += 4) peak = Math.max(peak, Math.abs(buffer.readFloatLE(offset)));
  return peak;
}

function pcm24Data(buffer: Buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "data") return buffer.subarray(body, body + size);
    offset = body + size + (size % 2);
  }
  assert.fail("missing PCM24 WAVE data chunk");
}

function pcm24Peak(data: Buffer) {
  assert.equal(data.byteLength % 3, 0);
  let peak = 0;
  for (let offset = 0; offset < data.byteLength; offset += 3) {
    let sample = data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16;
    if (sample & 0x80_0000) sample -= 0x100_0000;
    peak = Math.max(peak, Math.abs(sample / 0x80_0000));
  }
  return peak;
}

async function renderPcm24(ir: CutAVIR, timeline: IRComposition, directory: string, name: string) {
  const output = resolve(directory, name);
  await renderReferenceAudio(ir, timeline, directory, output);
  return pcm24Data(await readFile(output));
}

const hotBus = `Bus(name: "hot") {
  Tone(frequency: 440hz, duration: 200ms, amplitude: 90%);
  Tone(frequency: 440hz, duration: 200ms, amplitude: 90%);
}`;

test("selection output is exact raw stereo f32le while canonical PCM24 refuses clipping and matches CUT quantization", { timeout: 30_000 }, async () => {
  const ir = compile(audioProgram(hotBus)), main = composition(ir), roots = referenceMasterAudioRootIds(ir, main);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-f32-selection-"));
  try {
    const rawPath = resolve(directory, "master.f32le"), wavePath = resolve(directory, "master.wav");
    await renderReferenceAudioSelection(ir, main, directory, rawPath, roots, { outputFormat: "raw-stereo-f32le" });
    const raw = await readFile(rawPath);
    assert.equal(raw.byteLength, 9_600 * 8);
    assert.ok(rawPeak(raw) > 1.2, `raw intermediate unexpectedly clipped at ${rawPeak(raw)}`);
    const priorWave = Buffer.from("previous validated audition", "utf8");
    await writeFile(wavePath, priorWave);
    await assert.rejects(
      () => renderReferenceAudioSelection(ir, main, directory, wavePath, roots),
      (error: unknown) => error instanceof ReferenceAudioPeakError
        && error.code === "CUT_AUDIO_CLIPPING"
        && error.detail.reason === "sample-peak-ceiling",
    );
    assert.deepEqual(await readFile(wavePath), priorWave, "clipping refusal must not replace a prior validated audition");

    const safe = compile(audioProgram(`Bus(name: "safe") {
      Tone(frequency: 440hz, duration: 200ms, amplitude: 25%);
      Tone(frequency: 660hz, duration: 200ms, amplitude: 25%);
    }`));
    const safeMain = composition(safe), safeRoots = referenceMasterAudioRootIds(safe, safeMain);
    const safeRaw = resolve(directory, "safe.f32le"), expectedWave = resolve(directory, "safe-expected.wav"), actualWave = resolve(directory, "safe-actual.wav");
    await renderReferenceAudioSelection(safe, safeMain, directory, safeRaw, safeRoots, { outputFormat: "raw-stereo-f32le" });
    await quantizeReferenceStereoF32LeFileToPcm24Wave(safeRaw, expectedWave, {
      expectedFrames: 9_600,
      sampleRate,
      thresholdDbfs: 0,
      source: { module: "f32-handoff.cut", line: 1, column: 1 },
    });
    await renderReferenceAudioSelection(safe, safeMain, directory, actualWave, safeRoots, { bitExactWave: true });
    assert.deepEqual(await readFile(actualWave), await readFile(expectedWave));
    assert.equal(pcm24Data(await readFile(actualWave)).byteLength, 9_600 * 6);

    await assert.rejects(
      () => renderReferenceAudioSelection(ir, main, directory, resolve(directory, "invalid.raw"), roots, {
        outputFormat: "raw-stereo-f32le",
        bitExactWave: true,
      }),
      (error: unknown) => error instanceof ReferenceAudioSelectionError && error.code === "CUT_AUDIO_SELECTION_FORMAT",
    );
    await assert.rejects(
      () => renderReferenceAudioSelection(safe, safeMain, directory, resolve(directory, "invalid-wave-option.wav"), safeRoots, {
        bitExactWave: false,
      }),
      (error: unknown) => error instanceof ReferenceAudioSelectionError && error.code === "CUT_AUDIO_SELECTION_FORMAT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw sampleRange is an exact slice of the fully evaluated processor history", { timeout: 30_000 }, async () => {
  const ir = compile(audioProgram(`Compressor(threshold: -36db, ratio: 12, attack: 80ms, release: 200ms, makeup: 0db) {
    Tone(frequency: 100hz, duration: 400ms, amplitude: 80%);
  }`, "400ms"));
  const main = composition(ir), roots = referenceMasterAudioRootIds(ir, main);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-f32-history-"));
  try {
    const fullPath = resolve(directory, "full.f32le"), rangePath = resolve(directory, "range.f32le");
    await renderReferenceAudioSelection(ir, main, directory, fullPath, roots, { outputFormat: "raw-stereo-f32le" });
    await renderReferenceAudioSelection(ir, main, directory, rangePath, roots, {
      outputFormat: "raw-stereo-f32le",
      sampleRange: { start: 4_800, end: 14_400 },
    });
    const full = await readFile(fullPath), range = await readFile(rangePath);
    assert.equal(full.byteLength, 19_200 * 8);
    assert.equal(range.byteLength, 9_600 * 8);
    assert.deepEqual(range, full.subarray(4_800 * 8, 14_400 * 8));
    const expectedWave = resolve(directory, "range-expected.wav"), actualWave = resolve(directory, "range-actual.wav");
    await quantizeReferenceStereoF32LeFileToPcm24Wave(rangePath, expectedWave, {
      expectedFrames: 9_600,
      sampleRate,
      thresholdDbfs: 0,
      source: { module: "f32-range.cut", line: 1, column: 1 },
    });
    await renderReferenceAudioSelection(ir, main, directory, actualWave, roots, {
      sampleRange: { start: 4_800, end: 14_400 },
      bitExactWave: true,
    });
    assert.deepEqual(await readFile(actualWave), await readFile(expectedWave), "sample-range PCM24 must use the same canonical quantizer as its exact raw selection");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("NestedSequence preserves an exact over-range source through its raw parent handoff", { timeout: 45_000 }, async () => {
  const nested = compile(`cut 0.4;
project "nested f32 preservation";
import { NestedSequence } from "@cut/edit";
import { Bus, Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: 200ms, fps: 20, width: 32px, height: 24px, sampleRate: 48khz) {
  scene host(duration: 200ms) { NestedSequence(source: insert); }
}
timeline insert(duration: 200ms, fps: 20, width: 32px, height: 24px, sampleRate: 48khz) {
  ${hotBus}
  scene picture(duration: 200ms) { Rect(width: 32px, height: 24px, fill: #123456); }
}
export out = render(main);`);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-f32-nested-"));
  try {
    const parent = composition(nested), insert = composition(nested, "insert");
    const parentPath = resolve(directory, "parent.f32le"), insertPath = resolve(directory, "insert.f32le");
    await renderReferenceAudioSelection(nested, parent, directory, parentPath, referenceMasterAudioRootIds(nested, parent), { outputFormat: "raw-stereo-f32le" });
    await renderReferenceAudioSelection(nested, insert, directory, insertPath, referenceMasterAudioRootIds(nested, insert), { outputFormat: "raw-stereo-f32le" });
    const parentRaw = await readFile(parentPath), insertRaw = await readFile(insertPath);
    assert.equal(parentRaw.byteLength, 9_600 * 8);
    assert.deepEqual(parentRaw, insertRaw, "nested raw handoff changed or clipped the upstream waveform");
    assert.ok(rawPeak(parentRaw) > 1.2, `nested raw handoff unexpectedly clipped at ${rawPeak(parentRaw)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nested raw-f32 retained-byte budgeting is enforced before preparation", () => {
  const instances = [3_000, 3_001, 3_002, 3_003]
    .map((end) => `NestedSequence(source: insert, range: 0s ..< ${end}s);`)
    .join("\n");
  const source = `cut 0.4;
project "nested raw budget";
import { NestedSequence } from "@cut/edit";
import { Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: 7200s, fps: 1, width: 8px, height: 8px, sampleRate: 48khz) {
  scene host(duration: 7200s) { ${instances} }
}
timeline insert(duration: 7200s, fps: 1, width: 8px, height: 8px, sampleRate: 48khz) {
  Tone(frequency: 440hz, duration: 7200s, amplitude: 1%);
  scene picture(duration: 7200s) { Rect(width: 8px, height: 8px, fill: #123456); }
}
export out = render(main);`;
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const cutModule = parsed.module;
  assert.throws(() => compileCutModule(cutModule), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === "CUT_NESTED_BUDGET");
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.match(diagnostic.message, /maxRetainedRawF32Bytes=4294967192.*selected raw stereo f32le bytes/);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    return true;
  });
});

test("TimeStretch raw child and output preserve over-range identity until downstream attenuation", { timeout: 45_000 }, async () => {
  const stretched = compile(audioProgram(`Gain(amount: -3db) {
    TimeStretch(sourceDuration: 200ms, duration: 200ms, pitch: 0) { ${hotBus} }
  }`));
  const flat = compile(audioProgram(`Gain(amount: -3db) { ${hotBus} }`));
  const directory = await mkdtemp(resolve(tmpdir(), "cut-f32-stretch-"));
  try {
    const stretchedPcm = await renderPcm24(stretched, composition(stretched), directory, "stretched.wav");
    const flatPcm = await renderPcm24(flat, composition(flat), directory, "flat.wav");
    assert.deepEqual(stretchedPcm, flatPcm, "identity TimeStretch quantized or clipped its raw child/intermediate");
    const peak = pcm24Peak(stretchedPcm);
    assert.ok(peak > 0.85 && peak < 0.95, `downstream -3 dB result has unexpected peak ${peak}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TimeStretch raw reader/writer retains finite over-range samples and refuses malformed handoffs", { timeout: 30_000 }, async () => {
  const ir = compile(audioProgram(`TimeStretch(sourceDuration: 200ms, duration: 200ms, pitch: 0) {
    Tone(frequency: 440hz, duration: 200ms, amplitude: 50%);
  }`));
  const main = composition(ir), roots = referenceMasterAudioRootIds(ir, main), expectedFrames = 9_600;
  const prepared = await prepareReferenceTimeStretchSources(ir, main, roots, async (_childId, output, start, end) => {
    assert.equal(end - start, expectedFrames);
    const raw = Buffer.alloc(expectedFrames * 8);
    for (let frame = 0; frame < expectedFrames; frame += 1) {
      raw.writeFloatLE(frame % 2 === 0 ? 1.25 : -1.25, frame * 8);
      raw.writeFloatLE(frame % 2 === 0 ? -1.5 : 1.5, frame * 8 + 4);
    }
    await writeFile(output, raw);
  });
  try {
    const source = [...prepared.sources.values()][0];
    assert.deepEqual({
      format: source.format,
      channels: source.channels,
      sampleRate: source.sampleRate,
      placementSamples: source.placementSamples,
      renderedSamples: source.renderedSamples,
    }, {
      format: "raw-stereo-f32le",
      channels: 2,
      sampleRate,
      placementSamples: 0,
      renderedSamples: expectedFrames,
    });
    const output = await readFile(source.path);
    assert.equal(output.byteLength, expectedFrames * 8);
    assert.equal(rawSample(output, 0, 0), 1.25);
    assert.equal(rawSample(output, 0, 1), -1.5);
    assert.equal(rawSample(output, 1, 0), -1.25);
    assert.equal(rawSample(output, 1, 1), 1.5);
  } finally {
    await prepared.cleanup();
  }

  await assert.rejects(
    () => prepareReferenceTimeStretchSources(ir, main, roots, async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceTimeStretchError);
      assert.equal(error.code, "CUT_AUDIO_TIME_STRETCH_SOURCE");
      assert.match(error.message, /missing or unreadable \(ENOENT\)/);
      return true;
    },
  );

  for (const malformed of [
    { kind: "truncated", bytes: expectedFrames * 8 - 4, nonfinite: false },
    { kind: "extra", bytes: expectedFrames * 8 + 8, nonfinite: false },
    { kind: "nonfinite", bytes: expectedFrames * 8, nonfinite: true },
  ] as const) {
    await assert.rejects(
      () => prepareReferenceTimeStretchSources(ir, main, roots, async (_childId, output) => {
        const raw = Buffer.alloc(malformed.bytes);
        if (malformed.nonfinite) raw.writeFloatLE(Number.NaN, 0);
        await writeFile(output, raw);
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceTimeStretchError);
        assert.equal(error.code, "CUT_AUDIO_TIME_STRETCH_SOURCE");
        assert.equal(error.source.module, "project.cut");
        assert.ok(error.source.line > 0 && error.source.column > 0);
        assert.match(error.message, malformed.nonfinite ? /frame 0, left channel is NaN/ : /must contain exactly/);
        assert.deepEqual(cutDiagnosticsFromError(error), [{
          code: error.code,
          severity: "error",
          message: error.message.slice(`${error.code}: `.length),
          source: error.source,
        }]);
        return true;
      },
      malformed.kind,
    );
  }
});
