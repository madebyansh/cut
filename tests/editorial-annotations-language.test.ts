import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { formatCutSource } from "../lib/language/formatter";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr, validateCutAvIr } from "../lib/language/ir-loader";
import { lintCutModule } from "../lib/language/linter";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { importOtioTimeline, CutOtioImportError } from "../lib/interchange/otio-import";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { inspectCutIr } from "../lib/runtime/inspect";
import { renderReferenceIr } from "./reference-render-test-helper";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const source = `cut 0.4;
project "annotation proof";
import { Marker, Region, marker, region } from "@cut/edit";

timeline main(duration: 4s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  Marker(id: "opening", at: 1s, name: "Opening beat", color: #ff5500, role: "beat", comment: "Land on the reveal.", grid: "frame");
  Region(id: "chapter-a", range: 1s ..< 3s, name: "First chapter", color: #3366ccdd, role: "chapter", comment: "Editorial chapter.", grid: "frame");
  Marker(id: "sample-cue", at: seconds(1 / 48000), name: "Sample cue", color: #00aa88, role: "sync", comment: "One exact sample.", grid: "sample");
  assert marker("opening").at == 1s, "marker time survives lowering";
  assert marker("opening").name == "Opening beat", "marker metadata is queryable";
  assert marker("sample-cue").grid == "sample", "sample grid is queryable";
  assert region("chapter-a").range == (1s ..< 3s), "region range survives lowering";
  assert region("chapter-a").comment == "Editorial chapter.", "region metadata is queryable";
  scene canvas(duration: 4s) {}
}

export out = render(main, width: 64px, height: 64px, codec: "h264");
`;

function parsedModule(text: string) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(text: string): CutAVIR {
  return compileCutModule(parsedModule(text)).ir;
}

function semanticAnnotations(ir: CutAVIR) {
  const semantic = <T extends { provenance: unknown }>(value: T) => {
    const { provenance, ...rest } = value;
    void provenance;
    return rest;
  };
  return {
    markers: ir.annotations?.markers.map(semantic),
    regions: ir.annotations?.regions.map(semantic),
  };
}

test("Marker/Region lower to typed non-rendering IR and drive inspect/assert/diff identity", () => {
  const ir = compile(source);
  assert.equal(Object.keys(ir.nodes).length, 0, "annotations must never masquerade as render nodes");
  assert.deepEqual(ir.annotations?.markers.map((marker) => marker.id), ["opening", "sample-cue"]);
  assert.deepEqual(ir.annotations?.regions.map((region) => region.id), ["chapter-a"]);
  assert.deepEqual(ir.annotations?.markers[2], undefined);
  assert.deepEqual(ir.annotations?.markers[1].at, { numerator: "1", denominator: "48000" });
  assert.deepEqual(ir.annotations?.regions[0].range, { start: { numerator: "1", denominator: "1" }, duration: { numerator: "2", denominator: "1" } });
  assert.ok(ir.assertions.length === 5 && ir.assertions.every((assertion) => assertion.status === "pass"));

  const inspected = inspectCutIr(ir, "annotations.cut") as ReturnType<typeof inspectCutIr> & { annotations: { markers: Array<{ id: string; role: string }>; regions: Array<{ id: string; comment: string }> } };
  assert.equal(inspected.summary.markers, 2);
  assert.equal(inspected.summary.regions, 1);
  assert.deepEqual(inspected.annotations.markers.map((marker) => [marker.id, marker.role]), [["opening", "beat"], ["sample-cue", "sync"]]);
  assert.deepEqual(inspected.annotations.regions.map((region) => [region.id, region.comment]), [["chapter-a", "Editorial chapter."]]);

  const recolored = compile(source.replace("#ff5500", "#aa22ff"));
  assert.notEqual(recolored.buildId, ir.buildId);
  const diff = diffCutAVIR(ir, recolored);
  assert.ok(diff.changes.some((change) => change.entity === "marker" && change.id === "opening" && change.operation === "modify"));
  assert.deepEqual(diff.summary.byEntity.marker, { add: 0, remove: 0, modify: 1 });
});

test("formatting/comments preserve annotation graph identity and lint sees public imports", () => {
  const formatted = formatCutSource(`// source comment\n${source.replace("Marker(id:", "Marker( id:")}`);
  assert.equal(formatCutSource(formatted), formatted);
  const before = compile(source), after = compile(formatted);
  assert.notEqual(before.sourceHash, after.sourceHash);
  assert.equal(before.buildId, after.buildId);
  assert.deepEqual(semanticAnnotations(before), semanticAnnotations(after));
  const parsed = parsedModule(formatted), checked = checkCutModule(parsed);
  assert.deepEqual(checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  assert.ok(!lintCutModule(parsed).some((diagnostic) => diagnostic.code === "CUTL1001" && /Marker|Region|marker|region/.test(diagnostic.message)));
});

test("strict IR loader validates annotation schema, bounds, references, grids, and identity", () => {
  const ir = compile(source), loaded = loadCutAvIr(stableJsonStringify(ir));
  assert.deepEqual(semanticAnnotations(loaded), semanticAnnotations(ir));
  const unknown = structuredClone(ir) as CutAVIR & { annotations: NonNullable<CutAVIR["annotations"]> };
  (unknown.annotations.markers[0] as unknown as Record<string, unknown>).ignored = true;
  assert.throws(() => validateCutAvIr(unknown), (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD" && /annotations\.markers/.test(error.path));
  const tampered = structuredClone(ir) as CutAVIR & { annotations: NonNullable<CutAVIR["annotations"]> };
  tampered.annotations.markers[0].comment = "changed without rebuilding identity";
  assert.throws(() => validateCutAvIr(tampered), (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_IDENTITY" && error.path === "$.buildId");
  const empty = structuredClone(ir); empty.annotations = { markers: [], regions: [] };
  assert.throws(() => validateCutAvIr(empty), (error: unknown) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_IDENTITY" && error.path === "$.annotations");
});

test("source-located annotation diagnostics refuse duplicates, off-grid timing, inclusive regions, and component context", () => {
  const expectCode = (text: string, code: string) => assert.throws(() => compile(text), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, String(error));
    const diagnostic = error.result.diagnostics.find((item) => item.code === code);
    assert.ok(diagnostic && diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0, JSON.stringify(error.result.diagnostics));
    return true;
  });
  expectCode(source.replace('Region(id: "chapter-a"', 'Region(id: "opening"'), "CUT_ANNOTATION_DUPLICATE");
  expectCode(source.replace('at: 1s, name: "Opening beat"', 'at: 1ms, name: "Opening beat"'), "CUT_ANNOTATION_TIMING");
  expectCode(source.replace("range: 1s ..< 3s", "range: 1s .. 3s"), "CUT_ANNOTATION_TIMING");
  const component = `cut 0.4; project "bad"; import { Marker } from "@cut/edit"; import { Rect } from "cut:visual"; component Bad() -> Visual { Marker(id: "bad", at: 0s); Rect(width: 1px, height: 1px); } timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Bad(); } } export out = render(main);`;
  const checked = checkCutModule(parsedModule(component));
  assert.ok(checked.diagnostics.some((diagnostic) => diagnostic.code === "CUT_ANNOTATION_CONTEXT" && diagnostic.span.start.line > 0));
});

test("annotation authoring is legal only at a direct statement root, including through nested value shapes", () => {
  const cases = [
    {
      name: "assert expression",
      declarations: "",
      body: 'assert Marker(id: "bad-assert", at: 0s) == null, "not an authoring position";',
      calls: ['Marker(id: "bad-assert", at: 0s)'],
    },
    {
      name: "node argument",
      declarations: "",
      body: 'Rect(width: Marker(id: "bad-argument", at: 0s), height: 1px);',
      calls: ['Marker(id: "bad-argument", at: 0s)'],
    },
    {
      name: "array value",
      declarations: 'const notes = [Marker(id: "bad-array-a", at: 0s), Marker(id: "bad-array-b", at: 0s)];',
      body: "",
      calls: ['Marker(id: "bad-array-a", at: 0s)', 'Marker(id: "bad-array-b", at: 0s)'],
    },
    {
      name: "object value",
      declarations: 'const note = { value: Region(id: "bad-object", range: 0s ..< 1s) };',
      body: "",
      calls: ['Region(id: "bad-object", range: 0s ..< 1s)'],
    },
    {
      name: "at expression",
      declarations: "",
      body: 'at Marker(id: "bad-at", at: 0s) { Rect(width: 1px, height: 1px); }',
      calls: ['Marker(id: "bad-at", at: 0s)'],
    },
    {
      name: "if expression",
      declarations: "",
      body: 'if Region(id: "bad-if", range: 0s ..< 1s) { Rect(width: 1px, height: 1px); }',
      calls: ['Region(id: "bad-if", range: 0s ..< 1s)'],
    },
    {
      name: "pure function value",
      declarations: 'function bad() -> EditorialAnnotation = Marker(id: "bad-function", at: 0s);',
      body: "",
      calls: ['Marker(id: "bad-function", at: 0s)'],
    },
    {
      name: "component value",
      declarations: 'component Bad() -> Visual { let note = { value: Marker(id: "bad-component", at: 0s) }; Rect(width: 1px, height: 1px); }',
      body: "Bad();",
      calls: ['Marker(id: "bad-component", at: 0s)'],
    },
  ] as const;

  for (const fixture of cases) {
    const text = `cut 0.4;
project "annotation context ${fixture.name}";
import { Marker, Region } from "@cut/edit";
import { Rect } from "cut:visual";
${fixture.declarations}
timeline main(duration: 1s, fps: 24) {
  scene only(duration: 1s) {
    ${fixture.body}
    Rect(width: 1px, height: 1px);
  }
}
export out = render(main);`;
    const diagnostics = checkCutModule(parsedModule(text)).diagnostics.filter((item) => item.code === "CUT_ANNOTATION_CONTEXT");
    assert.equal(diagnostics.length, fixture.calls.length, `${fixture.name}: ${JSON.stringify(diagnostics)}`);
    assert.deepEqual(
      diagnostics.map((item) => item.span.start.offset).sort((left, right) => left - right),
      fixture.calls.map((call) => text.indexOf(call)).sort((left, right) => left - right),
      `${fixture.name}: every rejected authoring call must own one exact source span`,
    );
  }
});

test("OTIO Stack Marker.2 round-trips exact CUT annotation semantics and refuses hostile metadata", () => {
  const original = compile(source), exported = exportCutTimelineToOtio(original);
  assert.deepEqual(exported.report.exported.markers, 2);
  assert.deepEqual(exported.report.exported.regions, 1);
  assert.equal(exported.timeline.tracks.markers.length, 3);
  assert.deepEqual(exported.timeline.tracks.markers.map((marker) => [marker.OTIO_SCHEMA, marker.comment]), [["Marker.2", "Land on the reveal."], ["Marker.2", "One exact sample."], ["Marker.2", "Editorial chapter."]]);

  const imported = importOtioTimeline(stableJsonStringify(exported.timeline));
  assert.deepEqual({ markers: imported.report.imported.markers, regions: imported.report.imported.regions }, { markers: 2, regions: 1 });
  const roundTrip = compile(imported.source);
  assert.deepEqual(semanticAnnotations(roundTrip), semanticAnnotations(original));

  const mismatch = structuredClone(exported.timeline);
  const cut = mismatch.tracks.markers[0].metadata.cut as Record<string, unknown>;
  cut.exact_start = { numerator: "2", denominator: "1" };
  assert.throws(() => importOtioTimeline(stableJsonStringify(mismatch)), (error: unknown) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_TIMING" && /exact_start/.test(error.path));

  const hostile = structuredClone(exported.timeline);
  (hostile.tracks.markers[0].metadata.cut as Record<string, unknown>).surprise = "ignored?";
  assert.throws(() => importOtioTimeline(stableJsonStringify(hostile)), (error: unknown) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_FIELD" && /surprise/.test(error.path));

  const duplicate = structuredClone(exported.timeline);
  (duplicate.tracks.markers[1].metadata.cut as Record<string, unknown>).annotation_id = "opening";
  assert.throws(() => importOtioTimeline(stableJsonStringify(duplicate)), (error: unknown) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED" && /annotation_id/.test(error.path));

  const sceneOwned = compile(`cut 0.4;
project "scene annotation interchange";
import { Marker, Region } from "@cut/edit";
timeline main(duration: 3s, fps: 24, sampleRate: 48khz) {
  scene first(duration: 1s) {}
  scene second(duration: 2s) {
    Marker(id: "scene-marker", at: 250ms, role: "edit", grid: "frame");
    Region(id: "scene-region", range: 500ms ..< 1s, role: "review", grid: "frame");
  }
}
export out = render(main);`);
  const sceneRoundTrip = compile(importOtioTimeline(stableJsonStringify(exportCutTimelineToOtio(sceneOwned).timeline)).source);
  assert.deepEqual(
    semanticAnnotations(sceneRoundTrip),
    semanticAnnotations(sceneOwned),
    "OTIO import must restore scene ownership and scene-relative authoring rather than flattening annotations to the timeline root",
  );

  const orphanedScene = structuredClone(exportCutTimelineToOtio(sceneOwned).timeline);
  (orphanedScene.tracks.markers[0].metadata.cut as Record<string, unknown>).scene_id = "scene_missing";
  assert.throws(
    () => importOtioTimeline(stableJsonStringify(orphanedScene)),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED"
      && /scene_id/.test(error.path),
    "scene ownership that cannot be reconstructed must fail rather than flatten",
  );

  const duplicateScene = structuredClone(exportCutTimelineToOtio(sceneOwned).timeline);
  const exactScenes = (duplicateScene.metadata.cut as Record<string, unknown>).exact_scenes as Array<Record<string, unknown>>;
  exactScenes[1].id = exactScenes[0].id;
  assert.throws(
    () => importOtioTimeline(stableJsonStringify(duplicateScene)),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED"
      && /exact_scenes\[1\]\.id/.test(error.path),
  );
});

test("annotation absence preserves the pre-extension optional IR shape", () => {
  const plain = compile(`cut 0.4; project "plain"; timeline main(duration: 1s, fps: 24) { scene only(duration: 1s) {} } export out = render(main);`);
  assert.equal(Object.hasOwn(plain, "annotations"), false);
  assert.equal(Object.hasOwn(inspectCutIr(plain, "plain.cut"), "annotations"), false);
  assert.equal(Object.hasOwn(inspectCutIr(plain, "plain.cut").summary, "markers"), false);
});

test("scene and at-block annotations retain exact composition offsets and missing queries stay located", () => {
  const local = compile(`cut 0.4;
project "local annotation clocks";
import { Marker, Region, marker } from "@cut/edit";
timeline main(duration: 3s, fps: 24, sampleRate: 48khz) {
  scene first(duration: 1s) {}
  scene second(duration: 2s) {
    Marker(id: "scene-start", at: 0s);
    at 500ms {
      Marker(id: "nested", at: 250ms, grid: "frame");
      Region(id: "nested-range", range: 0s ..< 500ms, grid: "frame");
    }
    assert marker("nested").at == 1750ms, "nested marker uses the composition clock";
  }
}
export out = render(main);`);
  const secondScene = Object.values(local.scenes).find((scene) => scene.name === "second");
  assert.ok(secondScene);
  assert.deepEqual(local.annotations?.markers.map(({ id, sceneId, at }) => ({ id, sceneId, at })), [
    { id: "scene-start", sceneId: secondScene.id, at: { numerator: "1", denominator: "1" } },
    { id: "nested", sceneId: secondScene.id, at: { numerator: "7", denominator: "4" } },
  ]);
  assert.deepEqual(local.annotations?.regions[0].range, {
    start: { numerator: "3", denominator: "2" },
    duration: { numerator: "1", denominator: "2" },
  });
  assert.equal(local.assertions[0]?.status, "pass");

  const unresolved = source.replace('marker("opening").at', 'marker("missing").at');
  assert.throws(() => compile(unresolved), (error: unknown) => {
    if (!(error instanceof CutCompileError)) return false;
    const diagnostic = error.result.diagnostics.find((item) => item.code === "CUT_ANNOTATION_REFERENCE");
    return Boolean(
      diagnostic
      && diagnostic.span.start.offset === unresolved.indexOf('marker("missing")')
      && diagnostic.span.start.line > 0
      && diagnostic.span.start.column > 0
      && /missing/.test(diagnostic.message),
    );
  });
});

test("unqueried annotation-only edits preserve picture/audio caches and the delivered bytes", { timeout: 30_000 }, async () => {
  const program = (annotation: string) => `cut 0.4;
project "annotation render locality";
import { Marker } from "@cut/edit";
import { Rect } from "cut:visual";
import { Tone } from "@cut/audio";
timeline main(duration: 120ms, fps: 25, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 120ms) {
    ${annotation}
    Rect(width: 64px, height: 64px, fill: #314159);
    Tone(frequency: 440hz, duration: 120ms, amplitude: 5%);
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const root = await mkdtemp(resolve(tmpdir(), "cut-annotation-render-"));
  try {
    const beforeIr = compile(program(""));
    const before = await renderReferenceIr(beforeIr, root, resolve(root, "before.mp4"), "out");
    const afterIr = compile(program('Marker(id: "editor-note", at: 40ms, role: "review", comment: "Metadata only.", grid: "frame");'));
    assert.notEqual(afterIr.buildId, beforeIr.buildId, "annotation semantics must change canonical edit identity");
    const after = await renderReferenceIr(afterIr, root, resolve(root, "after.mp4"), "out");
    assert.equal(after.sha256, before.sha256, "non-rendering annotations must not change delivered audiovisual bytes");
    assert.equal(after.cache.hits, 1);
    assert.equal(after.cache.misses, 0);
    assert.equal(after.cache.audio.status, "hit");
    assert.equal(after.cache.audio.key, before.cache.audio.key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a queried marker at scene start drives pixels and invalidates only its dependent scene", { timeout: 30_000 }, async () => {
  const program = (markerAt: "0ms" | "40ms") => `cut 0.4;
project "annotation query render dependency";
import { Marker, marker } from "@cut/edit";
import { Rect } from "cut:visual";
timeline main(duration: 160ms, fps: 25, width: 64px, height: 64px, sampleRate: 48khz) {
  scene lead(duration: 40ms) {
    Rect(width: 64px, height: 64px, fill: #102030);
  }
  scene query(duration: 120ms) {
    Marker(id: "cue", at: ${markerAt}, grid: "frame");
    Rect(width: 64px, height: 64px, fill: #203040);
    at marker("cue").at - 40ms {
      Rect(width: 32px, height: 32px, fill: #ff3366);
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const root = await mkdtemp(resolve(tmpdir(), "cut-annotation-query-render-"));
  const framePixel = async (ir: CutAVIR, cacheName: string) => {
    const composition = ir.compositions[0], scene = ir.scenes[composition.sceneIds[1]];
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, cacheName));
    await renderer.prepare();
    try {
      const frame = await renderer.sceneFrame(scene, 0);
      const offset = (32 * frame.width + 32) * 4;
      return [...frame.data.subarray(offset, offset + 4)];
    } finally { renderer.close(); }
  };

  try {
    const atStart = compile(program("0ms")), delayed = compile(program("40ms"));
    const driven = (ir: CutAVIR) => Object.values(ir.nodes).find((node) => node.inputs.fill?.kind === "color" && node.inputs.fill.value === "#ff3366");
    assert.deepEqual(driven(atStart)?.interval.start, { numerator: "0", denominator: "1" });
    assert.deepEqual(driven(delayed)?.interval.start, { numerator: "1", denominator: "25" });
    assert.notEqual(driven(atStart)?.contentHash, driven(delayed)?.contentHash, "the queried absolute marker time must enter dependent node identity");
    assert.notDeepEqual(
      await framePixel(atStart, "pixels-at-start"),
      await framePixel(delayed, "pixels-delayed"),
      "moving the queried marker must change the first rendered frame of its scene",
    );

    const before = await renderReferenceIr(atStart, root, resolve(root, "at-start.mp4"), "out");
    const after = await renderReferenceIr(delayed, root, resolve(root, "delayed.mp4"), "out");
    assert.notEqual(after.sha256, before.sha256, "query-dependent timing must change delivered pixels");
    assert.equal(after.cache.hits, 1, "the unrelated lead scene must remain cached");
    assert.equal(after.cache.misses, 1, "the query-dependent scene must be rebuilt");
    assert.deepEqual(after.cache.scenes.map((scene) => scene.status), ["hit", "miss"]);
    assert.equal(after.cache.audio.status, "hit", "a picture-only query dependency must preserve the audio cache");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
