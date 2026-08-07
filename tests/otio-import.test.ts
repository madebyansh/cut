import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../lib/core/stable";
import { compileCutModule } from "../lib/language/compiler";
import { formatCutSource } from "../lib/language/formatter";
import { parseCutLanguage } from "../lib/language/parser";
import { addRational, rational, type Rational, zeroRational } from "../lib/language/rational";
import { exportCutTimelineToOtio, type OtioTimeline } from "../lib/interchange/otio";
import { CutOtioImportError, importOtioTimeline } from "../lib/interchange/otio-import";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function time(value: number, rate = 1) { return { OTIO_SCHEMA: "RationalTime.1" as const, value, rate }; }
function range(start: number, duration: number, rate = 1) {
  return { OTIO_SCHEMA: "TimeRange.1" as const, start_time: time(start, rate), duration: time(duration, rate) };
}
function gap(duration: number, rate = 1) {
  return { OTIO_SCHEMA: "Gap.1" as const, name: "", metadata: {}, source_range: range(0, duration, rate), effects: [] as [], markers: [] as [], enabled: true as const };
}
function clip(locator: string, start: number, duration: number, rate = 1) {
  return {
    OTIO_SCHEMA: "Clip.2" as const,
    name: locator,
    metadata: {},
    source_range: range(start, duration, rate),
    effects: [] as [],
    markers: [] as [],
    enabled: true as const,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1" as const,
        name: locator,
        metadata: {},
        target_url: locator,
        available_range: null,
        available_image_bounds: null,
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA" as const,
  };
}
function track(kind: "Video" | "Audio", children: Array<ReturnType<typeof gap> | ReturnType<typeof clip>>, name: string = kind) {
  return { OTIO_SCHEMA: "Track.1" as const, name, metadata: {}, source_range: null, effects: [] as [], markers: [] as [], enabled: true as const, kind, children };
}
function timeline(tracks: ReturnType<typeof track>[], name = "Imported timeline"): OtioTimeline {
  return {
    OTIO_SCHEMA: "Timeline.1",
    name,
    metadata: {},
    global_start_time: null,
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", metadata: {}, source_range: null, effects: [], markers: [], enabled: true, children: tracks },
  };
}

function otioEvents(value: OtioTimeline) {
  const events: Array<{ kind: string; locator: string; start: Rational; duration: Rational; sourceStart: Rational }> = [];
  for (const item of value.tracks.children) {
    let cursor = zeroRational;
    for (const child of item.children) {
      if (child.OTIO_SCHEMA === "Transition.1") continue;
      const duration = rational(child.source_range.duration.value, child.source_range.duration.rate);
      if (child.OTIO_SCHEMA === "Clip.2") {
        events.push({
          kind: item.kind,
          locator: child.media_references.DEFAULT_MEDIA.target_url,
          start: cursor,
          duration,
          sourceStart: rational(child.source_range.start_time.value, child.source_range.start_time.rate),
        });
      }
      cursor = addRational(cursor, duration);
    }
  }
  return events.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

test("OTIO export imports to canonical typed CUT and preserves exact editorial events on re-export", () => {
  const original = compile(`
    cut 0.4;
    project "OTIO round trip";
    import { Video, Image } from "cut:visual";
    import { AudioClip } from "@cut/audio";
    import { Clip } from "@cut/edit";
    asset picture: VideoAsset = video("media/picture.mov");
    asset linked: VideoAsset = video("media/linked.mkv");
    asset still: ImageAsset = image("media/still.png");
    asset sound: AudioAsset = audio("media/sound.wav");
    timeline main(duration: 3s, fps: 4, width: 640px, height: 360px, sampleRate: 48khz) {
      scene opening(duration: 1s) {
        Video(source: picture, range: 2s ..< 3s);
      }
      scene linked_scene(duration: 1s) {
        Clip(source: linked, range: 4s ..< 5s, duration: 1s);
        AudioClip(source: sound, range: 1s ..< 2s);
      }
      scene card(duration: 1s) {
        Image(source: still);
      }
    }
    export out = render(main);
  `);
  const first = exportCutTimelineToOtio(original).timeline;
  const imported = importOtioTimeline(Buffer.from(JSON.stringify(first)));
  assert.equal(imported.report.imported.linkedPairs, 1);
  assert.equal(imported.report.output.fps.numerator, "4");
  assert.deepEqual(imported.report.sourceTracks.map((item) => item.kind), ["Video", "Video", "Audio", "Audio", "Video"]);
  assert.match(imported.source, /import \{ Clip \} from "@cut\/edit";/);
  assert.match(imported.source, /asset video_002: VideoAsset = video\("media\/linked\.mkv"\);/);
  assert.match(imported.source, /scene linked_scene\(duration: 1s\)/);
  const regenerated = compile(imported.source);
  assert.equal(formatCutSource(imported.source), imported.source, "OTIO import must emit canonical formatter output");
  const second = exportCutTimelineToOtio(regenerated).timeline;
  assert.deepEqual(otioEvents(second), otioEvents(first));
  assert.equal(importOtioTimeline(JSON.stringify(first)).source, imported.source, "same OTIO bytes must generate stable source");
});

test("CUT OTIO identity metadata round-trips exact timeline and scene identifiers or fails closed", () => {
  const original = compile(`cut 0.4;
project "OTIO identity";
import { Marker } from "@cut/edit";
timeline MixedCaseTimeline(duration: 2s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene OpeningBeat(duration: 1s) {
    Marker(id: "opening", at: 0s, role: "beat");
  }
  scene FinalScene(duration: 1s) {}
}
export out = render(MixedCaseTimeline);`);
  const exported = exportCutTimelineToOtio(original).timeline;
  exported.name = "A display name that must not rename CUT";
  const imported = importOtioTimeline(JSON.stringify(exported));
  assert.equal(imported.report.output.timeline, "MixedCaseTimeline");
  assert.match(imported.source, /timeline MixedCaseTimeline\(/);
  assert.match(imported.source, /scene OpeningBeat\(duration: 1s\)/);
  assert.match(imported.source, /scene FinalScene\(duration: 1s\)/);
  const regenerated = compile(imported.source);
  assert.equal(regenerated.compositions[0].id, original.compositions[0].id);
  assert.deepEqual(
    regenerated.compositions[0].sceneIds.map((id) => ({ id, name: regenerated.scenes[id].name })),
    original.compositions[0].sceneIds.map((id) => ({ id, name: original.scenes[id].name })),
  );
  assert.equal(regenerated.annotations?.markers[0].compositionId, "MixedCaseTimeline");
  assert.equal(regenerated.annotations?.markers[0].sceneId, original.annotations?.markers[0].sceneId);

  const annotationMismatch = structuredClone(exported);
  (annotationMismatch.tracks.markers[0].metadata.cut as Record<string, unknown>).composition_id = "DifferentTimeline";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(annotationMismatch)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_SETTING_CONFLICT"
      && /composition_id/.test(error.path),
  );

  const invalidIdentifier = structuredClone(exported);
  (invalidIdentifier.metadata.cut as Record<string, unknown>).composition_id = "not-a-cut-identifier";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(invalidIdentifier)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED"
      && /composition_id/.test(error.path),
  );

  const coreCollision = structuredClone(exported);
  (coreCollision.metadata.cut as Record<string, unknown>).composition_id = "render";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(coreCollision)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED"
      && /composition_id/.test(error.path),
    "an exact identifier that canonical generated source cannot bind/reference must be refused, not emitted as broken CUT",
  );

  assert.throws(
    () => importOtioTimeline(JSON.stringify(exported), { timelineName: "mixedcasetimeline" }),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_SETTING_CONFLICT"
      && error.path === "$.options.timelineName",
  );

  const changedSceneName = structuredClone(exported);
  const scenes = (changedSceneName.metadata.cut as Record<string, unknown>).exact_scenes as Array<Record<string, unknown>>;
  scenes[0].name = "openingbeat";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(changedSceneName)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED"
      && /exact_scenes\[0\]\.id/.test(error.path),
    "scene metadata may not be silently normalized when that changes canonical CUT ownership identity",
  );
});

test("contextual CUT words remain exact OTIO identifiers when the executable grammar accepts them", () => {
  const original = compile(`cut 0.4;
project "contextual identifier proof";
timeline timeline(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene scene(duration: 1s) {}
}
export out = render(timeline);`);
  const imported = importOtioTimeline(JSON.stringify(exportCutTimelineToOtio(original).timeline));
  assert.match(imported.source, /timeline timeline\(/);
  assert.match(imported.source, /scene scene\(duration: 1s\)/);
  const regenerated = compile(imported.source);
  assert.equal(regenerated.compositions[0].id, "timeline");
  assert.deepEqual(regenerated.compositions[0].sceneIds, original.compositions[0].sceneIds);
  assert.equal(regenerated.scenes[regenerated.compositions[0].sceneIds[0]].name, "scene");
});

test("exact CUT timeline identity survives regenerated import and asset binding collisions", () => {
  const original = compile(`cut 0.4;
project "identity collision fixture";
import { Video } from "cut:visual";
asset picture: VideoAsset = video("media/picture.mov");
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene Only(duration: 1s) { Video(source: picture, range: 0s ..< 1s); }
}
export out = render(main);`);
  const retarget = (timelineId: string) => {
    const value = structuredClone(exportCutTimelineToOtio(original).timeline);
    (value.metadata.cut as Record<string, unknown>).composition_id = timelineId;
    const exactScenes = (value.metadata.cut as Record<string, unknown>).exact_scenes as Array<Record<string, unknown>>;
    const sceneId = `scene_${hash({ timeline: timelineId, name: "Only", ordinal: 0 }).slice(0, 16)}`;
    exactScenes[0].id = sceneId;
    for (const track of value.tracks.children) {
      (track.metadata.cut as Record<string, unknown>).scene_id = sceneId;
      for (const item of track.children) if (item.OTIO_SCHEMA === "Clip.2") (item.metadata.cut as Record<string, unknown>).scene_id = sceneId;
    }
    return value;
  };

  const constructorCollision = importOtioTimeline(JSON.stringify(retarget("Video")));
  assert.match(constructorCollision.source, /import \{ Video as CutVideo \} from "cut:visual";/);
  assert.match(constructorCollision.source, /timeline Video\(/);
  assert.match(constructorCollision.source, /CutVideo\(source: video_001,/);
  assert.equal(compile(constructorCollision.source).compositions[0].id, "Video");

  const assetCollision = importOtioTimeline(JSON.stringify(retarget("video_001")));
  assert.match(assetCollision.source, /asset video_002: VideoAsset/);
  assert.match(assetCollision.source, /timeline video_001\(/);
  assert.match(assetCollision.source, /Video\(source: video_002,/);
  assert.equal(compile(assetCollision.source).compositions[0].id, "video_001");

  const outputNameCollision = importOtioTimeline(JSON.stringify(retarget("out")));
  assert.match(outputNameCollision.source, /timeline out\(/);
  assert.match(outputNameCollision.source, /export out = render\(out,/);
  const outputNameIr = compile(outputNameCollision.source);
  assert.equal(outputNameIr.compositions[0].id, "out");
  assert.equal(outputNameIr.outputs[0].name, "out", "export names and timeline bindings occupy distinct executable namespaces");

  const hostileClipOwner = retarget("main");
  const hostileClip = hostileClipOwner.tracks.children[0].children.find((item) => item.OTIO_SCHEMA === "Clip.2");
  assert.ok(hostileClip && hostileClip.OTIO_SCHEMA === "Clip.2");
  (hostileClip.metadata.cut as Record<string, unknown>).scene_id = "scene_missing";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(hostileClipOwner)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED"
      && /children\[0\].*scene_id/.test(error.path),
    "CUT clip scene ownership metadata must never be silently discarded",
  );

  const hostileTrackOwner = retarget("main");
  (hostileTrackOwner.tracks.children[0].metadata.cut as Record<string, unknown>).scene_id = "scene_missing";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(hostileTrackOwner)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED"
      && /tracks\.children\[0\].*scene_id/.test(error.path),
    "CUT track scene ownership metadata must never be silently discarded",
  );
});

test("generic OTIO needs explicit execution settings and deterministically segments overlapping picture tracks", () => {
  const external = timeline([
    track("Video", [clip("media/base.mov", 10, 2)], "base"),
    track("Video", [gap(1), clip("media/overlay.mov", 20, 1)], "overlay"),
    track("Audio", [gap(1, 2), clip("media/voice.wav", 3, 2, 2), gap(1, 2)], "voice"),
  ]);
  assert.throws(
    () => importOtioTimeline(JSON.stringify(external)),
    (error) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_SETTING_REQUIRED",
  );
  const imported = importOtioTimeline(JSON.stringify(external), { fps: "2", width: 320, height: 180, sampleRate: 48_000, projectName: "Generic import", timelineName: "main" });
  assert.equal(imported.report.imported.scenes, 2);
  assert.equal(imported.report.imported.generatedNodes, 4);
  assert.equal(imported.report.imported.segmentedVideoClips, 2);
  assert.match(imported.source, /Video\(source: video_001, range: 10s\.\.<11s\);/);
  assert.match(imported.source, /Video\(source: video_001, range: 11s\.\.<12s\);/);
  assert.match(imported.source, /at \(1s \/ 2\) \{\s+AudioClip\(source: audio_001, range: \(3s \/ 2\)\.\.<\(5s \/ 2\)\);\s+\}/);
  const ir = compile(imported.source);
  assert.equal(ir.compositions[0].sceneIds.length, 2);
  assert.deepEqual(ir.compositions[0].duration, rational(2));

  const collidingDisplayName = structuredClone(external);
  collidingDisplayName.name = "render";
  const safelyNamed = importOtioTimeline(JSON.stringify(collidingDisplayName), { fps: "2", width: 320, height: 180, sampleRate: 48_000, projectName: "Generic import" });
  assert.equal(safelyNamed.report.output.timeline, "render_item");
  compile(safelyNamed.source);
});

test("legacy OTIO Narration transcript metadata is refused by default and exactly reported under explicit loss", () => {
  const ir = compile(`cut 0.4;
project "legacy Narration OTIO import";
import { Narration } from "@cut/documentary";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) { Narration(source: voice, range: 0s ..< 1s); }
}
export out = render(main);`);
  const base = exportCutTimelineToOtio(ir).timeline;
  const trackIndex = base.tracks.children.findIndex((item) => item.kind === "Audio");
  assert.notEqual(trackIndex, -1);
  const itemIndex = base.tracks.children[trackIndex].children.findIndex((item) => item.OTIO_SCHEMA === "Clip.2");
  assert.notEqual(itemIndex, -1);
  const transcriptPath = `$.tracks.children[${trackIndex}].children[${itemIndex}].metadata.cut.transcript`;

  for (const value of ["", "legacy spoken words"]) {
    const legacy = structuredClone(base);
    const item = legacy.tracks.children[trackIndex].children[itemIndex];
    assert.equal(item.OTIO_SCHEMA, "Clip.2");
    if (item.OTIO_SCHEMA !== "Clip.2") assert.fail("missing Narration clip");
    (item.metadata.cut as Record<string, unknown>).transcript = value;

    assert.throws(
      () => importOtioTimeline(JSON.stringify(legacy)),
      (error) => error instanceof CutOtioImportError
        && error.code === "CUT_OTIO_IMPORT_LOSSY_REFUSED"
        && error.path === transcriptPath
        && error.message === `CUT_OTIO_IMPORT_LOSSY_REFUSED at ${transcriptPath}: legacy Narration transcript metadata ${JSON.stringify(value)} cannot be represented by current CUT; explicit allowLossy is required to omit it with a machine-readable loss report.`,
    );

    const imported = importOtioTimeline(JSON.stringify(legacy), { allowLossy: true });
    assert.equal(imported.report.status, "lossy-editorial");
    assert.deepEqual(imported.report.losses, [{
      code: "CUT_OTIO_IMPORT_NARRATION_TRANSCRIPT_UNSUPPORTED",
      category: "metadata",
      disposition: "omitted",
      path: transcriptPath,
      subject: { kind: "clip", trackIndex, itemIndex, nodeOp: "cut.documentary.narration", property: "transcript" },
      evidence: { inputKind: "string", value },
      message: "Legacy Narration transcript metadata has no executable current Narration input. The imported source omits it only under explicit lossy acceptance; use Captions for visible timed text or Marker/Region role metadata for non-rendering notes.",
    }]);
    assert.equal(imported.report.guarantees.unsupportedSemantics, "explicitly-reported-lossy");
    assert.match(imported.source, /import \{ Narration \} from "@cut\/documentary";/);
    assert.match(imported.source, /Narration\(source: audio_001, range:/);
    assert.doesNotMatch(imported.source, /transcript:/);
    if (value) assert.doesNotMatch(imported.source, new RegExp(value));
    compile(imported.source);
  }
});

test("OTIO import rejects unsupported semantics, unsafe resources, ambiguous times, and conflicting metadata", () => {
  const base = timeline([track("Video", [clip("media/source.mov", 0, 1)])]);
  const reject = (mutate: (value: OtioTimeline) => void, code: CutOtioImportError["code"]) => {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => importOtioTimeline(JSON.stringify(value), { fps: "24", width: 320, height: 180, sampleRate: 48_000 }), (error) => error instanceof CutOtioImportError && error.code === code);
  };
  reject((value) => { value.tracks.children[0].effects.push({} as never); }, "CUT_OTIO_IMPORT_UNSUPPORTED");
  reject((value) => { (value.tracks.children[0].children[0] as { OTIO_SCHEMA: string }).OTIO_SCHEMA = "Transition.1"; }, "CUT_OTIO_IMPORT_UNSUPPORTED");
  reject((value) => { const item = value.tracks.children[0].children[0]; if (item.OTIO_SCHEMA === "Clip.2") item.media_references.DEFAULT_MEDIA.target_url = "../escape.mov"; }, "CUT_OTIO_IMPORT_RESOURCE");
  reject((value) => {
    const item = value.tracks.children[0].children[0];
    if (item.OTIO_SCHEMA !== "Transition.1") item.source_range.duration.rate = 23.976;
  }, "CUT_OTIO_IMPORT_TIMING");
  reject((value) => { value.tracks.children[0].metadata = { vendor: { semantic: true } }; }, "CUT_OTIO_IMPORT_UNSUPPORTED");
  reject((value) => { value.metadata = { cut: { canvas: { width: 640, height: 360 }, sample_rate: 48_000, exact_fps: { numerator: "25", denominator: "1" } } }; }, "CUT_OTIO_IMPORT_SETTING_CONFLICT");

  const escapedDuplicate = JSON.stringify(base).replace('"name":"Imported timeline"', '"name":"Imported timeline","\\u006eame":"duplicate"');
  assert.throws(() => importOtioTimeline(escapedDuplicate, { fps: "24", width: 320, height: 180, sampleRate: 48_000 }), (error) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_DUPLICATE_KEY");
  assert.throws(() => importOtioTimeline(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])), (error) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_ENCODING");
  assert.throws(() => importOtioTimeline(JSON.stringify(base), { fps: "24", width: 320, height: 180, sampleRate: 48_000, limits: { maxStringBytes: 4 } }), (error) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_LIMIT");
});

test("OTIO import refuses destination timing that canonical CUT cannot execute exactly", () => {
  const offFrame = timeline([track("Video", [gap(1, 5), clip("media/source.mov", 0, 4, 5)])]);
  assert.throws(
    () => importOtioTimeline(JSON.stringify(offFrame), { fps: "24", width: 320, height: 180, sampleRate: 48_000 }),
    (error) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_TIMING" && /frame boundary/.test(error.message),
  );
  const offSample = timeline([track("Audio", [gap(1, 44_101), clip("media/source.wav", 0, 1, 44_101), gap(44_099, 44_101)])]);
  assert.throws(
    () => importOtioTimeline(JSON.stringify(offSample), { fps: "24", width: 320, height: 180, sampleRate: 48_000 }),
    (error) => error instanceof CutOtioImportError && error.code === "CUT_OTIO_IMPORT_TIMING" && /sample boundary/.test(error.message),
  );
});

test("installed CLI requires explicit --allow-lossy for legacy Narration transcript metadata", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-otio-import-narration-cli-"));
  try {
    const ir = compile('cut 0.4; project "CLI legacy narration"; import { Narration } from "@cut/documentary"; asset voice: AudioAsset = audio("media/voice.wav"); timeline main(duration: 1s, fps: 24, sampleRate: 48khz) { scene only(duration: 1s) { Narration(source: voice, range: 0s ..< 1s); } } export out = render(main);');
    const timeline = exportCutTimelineToOtio(ir).timeline;
    const audio = timeline.tracks.children.find((track) => track.kind === "Audio");
    const item = audio?.children.find((candidate) => candidate.OTIO_SCHEMA === "Clip.2");
    assert.ok(item && item.OTIO_SCHEMA === "Clip.2");
    (item.metadata.cut as Record<string, unknown>).transcript = "CLI legacy words";
    await writeFile(resolve(directory, "legacy.otio"), JSON.stringify(timeline));
    const run = (args: string[]) => spawnSync(process.execPath, [resolve("dist-cli/cli/cut.js"), ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    const strict = run(["otio", "import", "legacy.otio", "--out", "strict.cut"]);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /CUT_OTIO_IMPORT_LOSSY_REFUSED/);
    const accepted = run(["otio", "import", "legacy.otio", "--out", "accepted.cut", "--allow-lossy"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /^LOSSY imported/);
    const source = await readFile(resolve(directory, "accepted.cut"), "utf8");
    assert.match(source, /Narration\(source:/);
    assert.doesNotMatch(source, /transcript:/);
    const report = JSON.parse(await readFile(resolve(directory, "accepted.cut.import.report.json"), "utf8")) as { status: string; losses: Array<{ evidence: { value: string } }> };
    assert.equal(report.status, "lossy-editorial");
    assert.equal(report.losses[0]?.evidence.value, "CLI legacy words");
    const check = run(["check", "accepted.cut"]);
    assert.equal(check.status, 0, check.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed CLI imports deterministically, writes a canonical report, and its source passes cut check", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-otio-import-cli-"));
  try {
    const source = compile('cut 0.4; project "CLI OTIO import"; import { Video } from "cut:visual"; asset source: VideoAsset = video("media/source.mov"); timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) { scene only(duration: 1s) { Video(source: source, range: 0s ..< 1s); } } export out = render(main);');
    await writeFile(resolve(directory, "timeline.otio"), JSON.stringify(exportCutTimelineToOtio(source).timeline));
    const run = (args: string[]) => spawnSync(process.execPath, [resolve("dist-cli/cli/cut.js"), ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    const first = run(["otio", "import", "timeline.otio", "--out", "main.cut"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /imported 1 OTIO clip/);
    const check = run(["check", "main.cut"]); assert.equal(check.status, 0, check.stderr);
    const second = run(["otio", "import", "timeline.otio", "--out", "second.cut", "--report", "second.report.json"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(resolve(directory, "main.cut"), "utf8"), await readFile(resolve(directory, "second.cut"), "utf8"));
    const defaultReport = JSON.parse(await readFile(resolve(directory, "main.cut.import.report.json"), "utf8")) as { format: string; output: { sha256: string } };
    const secondReport = JSON.parse(await readFile(resolve(directory, "second.report.json"), "utf8")) as typeof defaultReport;
    assert.equal(defaultReport.format, "cut-otio-import-report");
    assert.equal(defaultReport.output.sha256, secondReport.output.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
