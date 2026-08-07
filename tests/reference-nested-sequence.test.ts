import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { referenceMasterAudioRootIds, renderReferenceAudio } from "../lib/runtime/reference/audio";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity } from "../lib/runtime/reference/audio-cache";
import { ReferencePrecompError, referencePrecompConfig } from "../lib/runtime/reference/precomp-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function source(picture = "#ef233c", frequency = "440hz", unrelated = "#506070") {
  return `cut 0.4;
project "nested audiovisual sequence proof";
import { NestedSequence } from "@cut/edit";
import { Rect } from "cut:visual";
import { Tone } from "@cut/audio";
timeline main(duration: 2s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene host(duration: 2s) {
    Rect(width: 32px, height: 24px, fill: #050b10);
    at 500ms { NestedSequence(source: insert); }
  }
}
timeline insert(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene first(duration: 500ms) {
    Rect(width: 12px, height: 12px, fill: ${picture});
    Tone(frequency: ${frequency}, duration: 500ms, amplitude: 20%);
  }
  scene second(duration: 500ms) {
    Rect(width: 12px, height: 12px, fill: #2667ff);
    Tone(frequency: 880hz, duration: 500ms, amplitude: 10%);
  }
}
timeline unrelated(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene only(duration: 1s) { Rect(width: 32px, height: 24px, fill: ${unrelated}); }
}
export out = render(main, width: 32px, height: 24px, codec: "h264");`;
}

function recursiveSource() {
  return `cut 0.4;
project "recursive nested audiovisual sequence proof";
import { NestedSequence } from "@cut/edit";
import { Rect } from "cut:visual";
import { Tone } from "@cut/audio";
timeline main(duration: 2s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene host(duration: 2s) {
    Rect(width: 32px, height: 24px, fill: #050b10);
    at 500ms { NestedSequence(source: middle); }
  }
}
timeline middle(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  scene wrapper(duration: 1s) { NestedSequence(source: leaf); }
}
timeline leaf(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) {
  Tone(frequency: 220hz, duration: 1s, amplitude: 5%);
  scene first(duration: 500ms) {
    Rect(width: 12px, height: 12px, fill: #ef233c);
    Tone(frequency: 440hz, duration: 500ms, amplitude: 10%);
  }
  scene second(duration: 500ms) {
    Rect(width: 12px, height: 12px, fill: #2667ff);
    Tone(frequency: 880hz, duration: 500ms, amplitude: 10%);
  }
}
export out = render(main, width: 32px, height: 24px, codec: "h264");`;
}

function parse(text: string) {
  const result = parseCutLanguage(text);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(text = source()) {
  const cutModule = parse(text);
  assert.deepEqual(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function nested(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.edit.nested_sequence");
  assert.ok(node);
  return node;
}

function pcm24(buffer: Buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4);
      blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14);
    }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.deepEqual({ channels, sampleRate, blockAlign, bits }, { channels: 2, sampleRate: 48_000, blockAlign: 6, bits: 24 });
  const sample = (frame: number, channel: 0 | 1) => {
    const position = frame * blockAlign + channel * 3;
    let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000;
    return value;
  };
  return { frames: data.length / blockAlign, sample };
}

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

test("NestedSequence is a public childless Timeline-to-AV vertical slice with exact typed clocks", () => {
  const ir = compile(), node = nested(ir), main = ir.compositions.find((item) => item.id === "main")!;
  assert.deepEqual(node.inputs.source, { kind: "timeline-ref", id: "insert" });
  assert.deepEqual(node.children, []);
  assert.deepEqual(node.interval, {
    start: { numerator: "1", denominator: "2" },
    duration: { numerator: "1", denominator: "1" },
  });
  const config = referencePrecompConfig(ir, main, node);
  assert.deepEqual(config, {
    kind: "av",
    nodeId: node.id,
    sourceCompositionId: "insert",
    duration: { numerator: "1", denominator: "1" },
    frames: 4n,
    samples: 48_000n,
    sourceRange: {
      start: { numerator: "0", denominator: "1" },
      end: { numerator: "1", denominator: "1" },
    },
  });
  assert.equal(Object.values(ir.nodes).filter((candidate) => candidate.sceneId && ir.compositions.find((item) => item.id === "insert")!.sceneIds.includes(candidate.sceneId)).length, 4, "the source graph remains separately owned rather than cloned into the host");
});

test("NestedSequence renders unrelated picture grammars and the exact pre-master source root mix on independent clocks", { timeout: 60_000 }, async () => {
  const ir = compile(), main = ir.compositions.find((item) => item.id === "main")!, insert = ir.compositions.find((item) => item.id === "insert")!;
  validateReferenceSession(ir);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-nested-sequence-"));
  const renderer = new ReferenceVisualRenderer(ir, main, directory, resolve(directory, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[main.sceneIds[0]];
    const before = await renderer.sceneFrame(scene, 0), first = await renderer.sceneFrame(scene, 2), second = await renderer.sceneFrame(scene, 4), after = await renderer.sceneFrame(scene, 6);
    assert.deepEqual(pixel(before, 16, 12), [5, 11, 16, 255]);
    assert.deepEqual(pixel(first, 16, 12), [239, 35, 60, 255]);
    assert.deepEqual(pixel(second, 16, 12), [38, 103, 255, 255]);
    assert.deepEqual(pixel(after, 16, 12), [5, 11, 16, 255]);

    const sourceWave = resolve(directory, "source.wav"), parentWave = resolve(directory, "parent.wav");
    await renderReferenceAudio(ir, insert, directory, sourceWave);
    await renderReferenceAudio(ir, main, directory, parentWave);
    const sourcePcm = pcm24(await readFile(sourceWave)), parentPcm = pcm24(await readFile(parentWave));
    assert.equal(sourcePcm.frames, 48_000);
    assert.equal(parentPcm.frames, 96_000);
    for (const frame of [0, 1, 11_999, 23_998, 23_999]) {
      assert.equal(parentPcm.sample(frame, 0), 0, `parent frame ${frame} before placement must be silent`);
      assert.equal(parentPcm.sample(frame, 1), 0, `parent frame ${frame} before placement must be silent`);
    }
    for (const frame of [0, 1, 11_999, 24_000, 24_001, 47_998, 47_999]) {
      assert.equal(parentPcm.sample(24_000 + frame, 0), sourcePcm.sample(frame, 0), `left source sample ${frame}`);
      assert.equal(parentPcm.sample(24_000 + frame, 1), sourcePcm.sample(frame, 1), `right source sample ${frame}`);
    }
    for (const frame of [72_000, 72_001, 83_999, 95_999]) {
      assert.equal(parentPcm.sample(frame, 0), 0, `parent frame ${frame} after nested sequence must be silent`);
      assert.equal(parentPcm.sample(frame, 1), 0, `parent frame ${frame} after nested sequence must be silent`);
    }
  } finally {
    renderer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two-level NestedSequence recursion mixes timeline and scene audio exactly once", { timeout: 60_000 }, async () => {
  const ir = compile(recursiveSource()), main = ir.compositions.find((item) => item.id === "main")!, middle = ir.compositions.find((item) => item.id === "middle")!, leaf = ir.compositions.find((item) => item.id === "leaf")!;
  validateReferenceSession(ir);
  assert.equal(Object.values(ir.nodes).filter((node) => node.op === "cut.edit.nested_sequence").length, 2);
  assert.ok(leaf.items.some((item) => item.kind === "node" && item.domain === "audio"), "leaf must exercise timeline-level audio");
  assert.ok(leaf.sceneIds.some((id) => ir.scenes[id].rootAudioIds.length > 0), "leaf must also exercise scene-level audio");
  const directory = await mkdtemp(resolve(tmpdir(), "cut-recursive-nested-sequence-"));
  const renderer = new ReferenceVisualRenderer(ir, main, directory, resolve(directory, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[main.sceneIds[0]];
    assert.deepEqual(pixel(await renderer.sceneFrame(scene, 2), 16, 12), [239, 35, 60, 255]);
    assert.deepEqual(pixel(await renderer.sceneFrame(scene, 4), 16, 12), [38, 103, 255, 255]);

    const leafWave = resolve(directory, "leaf.wav"), middleWave = resolve(directory, "middle.wav"), mainWave = resolve(directory, "main.wav");
    await renderReferenceAudio(ir, leaf, directory, leafWave);
    await renderReferenceAudio(ir, middle, directory, middleWave);
    await renderReferenceAudio(ir, main, directory, mainWave);
    const leafPcm = pcm24(await readFile(leafWave)), middlePcm = pcm24(await readFile(middleWave)), mainPcm = pcm24(await readFile(mainWave));
    assert.equal(leafPcm.frames, 48_000); assert.equal(middlePcm.frames, 48_000); assert.equal(mainPcm.frames, 96_000);
    for (const frame of [0, 1, 1_337, 11_999, 24_000, 24_001, 36_001, 47_998, 47_999]) {
      for (const channel of [0, 1] as const) {
        assert.equal(middlePcm.sample(frame, channel), leafPcm.sample(frame, channel), `recursive middle sample ${frame}:${channel} must not double-count the leaf root mix`);
        assert.equal(mainPcm.sample(24_000 + frame, channel), leafPcm.sample(frame, channel), `recursive parent sample ${frame}:${channel} must place the leaf mix exactly once`);
      }
    }
  } finally {
    renderer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("NestedSequence picture and audio cache projections invalidate only their executable domains", () => {
  const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version nested-sequence-cache-test");
  const cache = (ir: CutAVIR) => {
    const main = ir.compositions.find((item) => item.id === "main")!;
    return createReferenceAudioCachePlan(ir, main, referenceMasterAudioRootIds(ir, main), toolchain);
  };
  const baseline = compile(), previous = createIncrementalRenderPlan(baseline, "main").manifest, baselineAudio = cache(baseline);

  const pictureEdit = compile(source("#24a148"));
  const picturePlan = createIncrementalRenderPlan(pictureEdit, "main", previous);
  assert.equal(picturePlan.nodes.find((item) => item.id === nested(pictureEdit).id)?.status, "miss");
  assert.ok(picturePlan.scenes.every((item) => item.status === "miss"));
  assert.equal(cache(pictureEdit).key, baselineAudio.key, "source picture-only edits must preserve the parent audio artifact key");

  const audioEdit = compile(source("#ef233c", "660hz"));
  const audioPlan = createIncrementalRenderPlan(audioEdit, "main", previous);
  assert.equal(audioPlan.nodes.find((item) => item.id === nested(audioEdit).id)?.status, "hit");
  assert.ok(audioPlan.scenes.every((item) => item.status === "hit"), "source audio-only edits must preserve parent picture frames");
  assert.notEqual(cache(audioEdit).key, baselineAudio.key);

  const unrelatedEdit = compile(source("#ef233c", "440hz", "#ffffff"));
  const unrelatedPlan = createIncrementalRenderPlan(unrelatedEdit, "main", previous);
  assert.ok(unrelatedPlan.nodes.every((item) => item.status === "hit"));
  assert.ok(unrelatedPlan.scenes.every((item) => item.status === "hit"));
  assert.equal(cache(unrelatedEdit).key, baselineAudio.key);
});

test("NestedSequence fails closed on source/format/timing/children/cycles and loaded-IR tampering", () => {
  const authored = [
    source().replace("NestedSequence(source: insert);", "NestedSequence(source: insert, loop: true);"),
    source().replace("NestedSequence(source: insert);", "NestedSequence(source: insert) { Rect(width: 1px, height: 1px, fill: #ffffff); }"),
  ];
  for (const text of authored) {
    const cutModule = parse(text), diagnostics = checkCutModule(cutModule).diagnostics;
    assert.ok(diagnostics.some((item) => /does not execute input “loop”|does not accept child nodes/.test(item.message)));
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }

  const formatMismatch = source().replace(
    "timeline insert(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz)",
    "timeline insert(duration: 1s, fps: 4, width: 30px, height: 24px, sampleRate: 48khz)",
  );
  assert.throws(() => compile(formatMismatch), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_NESTED_FORMAT" && item.span.start.line > 0));

  const tooLong = source().replace("timeline main(duration: 2s", "timeline main(duration: 1s").replace("scene host(duration: 2s)", "scene host(duration: 1s)").replace("at 500ms", "at 250ms");
  assert.throws(() => compile(tooLong), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_NESTED_TIMING" && item.span.start.line > 0));

  const cycle = `cut 0.4; project "nested cycle"; import { NestedSequence } from "@cut/edit";
timeline a(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) { scene sa(duration: 1s) { NestedSequence(source: b); } }
timeline b(duration: 1s, fps: 4, width: 32px, height: 24px, sampleRate: 48khz) { scene sb(duration: 1s) { NestedSequence(source: a); } }
export out = render(a);`;
  assert.throws(() => compile(cycle), (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT_NESTED_CYCLE" && item.span.start.line > 0));

  const hostile = compileCutModule(parse(source())).ir;
  hostile.compositions.find((candidate) => candidate.id === "insert")!.width = 30;
  finalizeGraphHashes(hostile);
  const loaded = loadCutAvIr(JSON.stringify(hostile)); loaded.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(loaded), (error: unknown) => error instanceof ReferencePrecompError
    && error.code === "CUT_NESTED_FORMAT" && error.source.line > 0);
});

test("OTIO preserves NestedSequence ownership in the closed profile without flattening its private source graph", () => {
  const { timeline, report } = exportCutTimelineToOtio(compile(), { compositionId: "main" });
  assert.equal(report.status, "lossy-editorial");
  const issue = report.unsupportedSemantics.find((item) => item.code === "CUT_OTIO_NESTING_EXECUTABLE_IMPORT_UNSUPPORTED");
  assert.ok(issue);
  assert.equal(issue.disposition, "metadata-only");
  assert.ok(report.editorialProfile);
  const nested = timeline.tracks.children.flatMap((track) => track.children).find((item) => item.OTIO_SCHEMA === "Stack.1");
  assert.ok(nested, "the bounded nested instance must remain one native Stack placeholder");
  assert.deepEqual(nested.children, [], "the private source graph must not be flattened into the parent OTIO");
});
