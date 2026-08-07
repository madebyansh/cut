import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  CutOtioExportError,
  exportCutTimelineToOtio,
  type OtioClip,
  type OtioGap,
  type OtioTrack,
} from "../lib/interchange/otio";
import { CutOtioImportError, importOtioTimeline } from "../lib/interchange/otio-import";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function clips(track: OtioTrack) {
  return track.children.filter((item): item is OtioClip => item.OTIO_SCHEMA === "Clip.2");
}

function gaps(track: OtioTrack) {
  return track.children.filter((item): item is OtioGap => item.OTIO_SCHEMA === "Gap.1");
}

function exactSeconds(item: { value: number; rate: number }) {
  return rational(item.value, item.rate);
}

function runCut(args: string[], cwd: string) {
  return spawnSync(process.execPath, [resolve("dist-cli/cli/cut.js"), ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
}

test("OTIO export preserves exact formal scene, placement, source-range, clip, and gap timing", () => {
  const ir = compile(`
    cut 0.4;
    project "OTIO exact fixture";
    import { Video, Image } from "cut:visual";
    import { AudioClip } from "@cut/audio";
    asset picture: VideoAsset = video("media/picture.mov");
    asset still: ImageAsset = image("media/still.png");
    asset voice: AudioAsset = audio("media/voice.wav");
    timeline main(duration: 48f, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
      scene first(duration: 25f) {
        Video(source: picture, range: 5f ..< 30f);
        AudioClip(source: voice, range: 11f ..< 36f);
      }
      scene second(duration: 23f) {
        Image(source: still);
      }
    }
    export out = render(main);
  `);

  const { timeline, report } = exportCutTimelineToOtio(ir);
  assert.equal(timeline.OTIO_SCHEMA, "Timeline.1");
  assert.equal(timeline.tracks.OTIO_SCHEMA, "Stack.1");
  assert.equal(report.status, "lossy-editorial", "unlocked formal fixture must be disclosed");
  assert.equal(report.exported.videoTracks, 2);
  assert.equal(report.exported.audioTracks, 1);
  assert.equal(report.exported.clipInstances, 3);
  assert.equal(report.unsupportedSemantics.filter((item) => item.code === "CUT_OTIO_RESOURCE_UNLOCKED").length, 3);

  const video = timeline.tracks.children.find((track) => track.kind === "Video" && clips(track)[0]?.name === "picture");
  const audio = timeline.tracks.children.find((track) => track.kind === "Audio");
  const still = timeline.tracks.children.find((track) => track.kind === "Video" && clips(track)[0]?.name === "still");
  assert.ok(video && audio && still);

  assert.deepEqual(exactSeconds(clips(video)[0].source_range.start_time), rational(5, 24));
  assert.deepEqual(exactSeconds(clips(video)[0].source_range.duration), rational(25, 24));
  assert.deepEqual(exactSeconds(clips(audio)[0].source_range.start_time), rational(11, 24));
  assert.deepEqual(exactSeconds(clips(audio)[0].source_range.duration), rational(25, 24));
  assert.equal(gaps(video).length, 1);
  assert.deepEqual(exactSeconds(gaps(video)[0].source_range.duration), rational(23, 24));
  assert.equal(gaps(still).length, 1);
  assert.deepEqual(exactSeconds(gaps(still)[0].source_range.duration), rational(25, 24));
  assert.deepEqual(exactSeconds(clips(still)[0].source_range.duration), rational(23, 24));

  const roundTrip = JSON.parse(JSON.stringify(timeline)) as typeof timeline;
  assert.equal(roundTrip.tracks.children[0].children[0].OTIO_SCHEMA, "Clip.2");
  const cutMetadata = roundTrip.metadata.cut as { exact_scenes: Array<{ start: { numerator: string; denominator: string } }> };
  assert.deepEqual(cutMetadata.exact_scenes.map((scene) => scene.start), [
    { numerator: "0", denominator: "1" },
    { numerator: "25", denominator: "24" },
  ]);
});

test("OTIO report enumerates flattened nodes, render parameters, animation signals, and effect jobs", () => {
  const ir = compile(`
    cut 0.4;
    project "OTIO loss fixture";
    import { Video, Text, Group } from "cut:visual";
    import { AudioClip, Gain } from "@cut/audio";
    asset picture: VideoAsset = video("media/picture.mov");
    asset voice: AudioAsset = audio("media/voice.wav");
    asset face: FontAsset = font("media/InterVariable.ttf");
    timeline main(duration: 2s, fps: 24) {
      scene only(duration: 2s) {
        Group() {
          Video(source: picture, range: 0s ..< 2s, fit: "cover") as background;
          animate background.scale from 1 to 1.1 over 2s;
          Text(content: "not editorial media", font: face);
        }
        Video(source: picture, range: 0s ..< 2s);
        Gain(amount: -3db) {
          AudioClip(source: voice, range: 0s ..< 2s, fadeIn: 100ms);
        }
      }
    }
    export out = render(main);
  `);

  // Begin with compiler-produced formal IR, then exercise the interchange
  // boundary against the effect fields already defined by CutAVIR. Native and
  // shader execution is intentionally unavailable in the current compiler, so
  // a source-level fixture cannot legally author this state yet.
  const effectNode = Object.values(ir.nodes).find((node) => node.op === "cut.visual.video")!;
  effectNode.effects = ["read"];
  ir.jobs.push({
    id: "job_otio_fixture",
    effect: "external",
    op: effectNode.op,
    inputs: {},
    state: "unresolved",
    provenance: effectNode.provenance,
  });

  const { timeline, report } = exportCutTimelineToOtio(ir);
  const codes = new Set(report.unsupportedSemantics.map((item) => item.code));
  assert.equal(report.status, "lossy-editorial");
  assert.ok(codes.has("CUT_OTIO_NODE_FLATTENED"));
  assert.ok(codes.has("CUT_OTIO_NODE_UNSUPPORTED"));
  assert.ok(codes.has("CUT_OTIO_PARAMETER_UNSUPPORTED"));
  assert.ok(codes.has("CUT_OTIO_SIGNAL_UNSUPPORTED"));
  assert.ok(codes.has("CUT_OTIO_EFFECT_UNSUPPORTED"));
  assert.ok(codes.has("CUT_OTIO_EFFECT_JOB_UNSUPPORTED"));
  assert.equal(report.exported.videoTracks, 2, "media descendants remain useful while their lost effects are reported");
  assert.equal(report.exported.audioTracks, 1);
  assert.deepEqual((timeline.metadata.cut as { interchange_report: unknown }).interchange_report, report);
  assert.ok(report.unsupportedSemantics.every((item) => item.message && item.subject.id));
});

test("OTIO preserves an AudioRegion hard clip exactly while reporting processing, link, and automation loss", () => {
  const ir = compile(`
    cut 0.4;
    project "OTIO AudioRegion loss fixture";
    import { Sequence, PictureTrack, PictureClip, Gap, AudioTrack, AudioRegion, AudioGap } from "@cut/edit";
    import { AudioClip, Gain } from "@cut/audio";
    asset picture: VideoAsset = video("media/picture.mov");
    asset voice: AudioAsset = audio("media/voice.wav");
    timeline main(duration: 3s, fps: 4, sampleRate: 48khz) {
      scene only(duration: 3s) {
        Sequence(duration: 3s) {
          PictureTrack() {
            Gap(duration: 500ms);
            PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "take-a");
            Gap(duration: 1500ms);
          }
        }
        AudioTrack() {
          AudioGap(destination: 0s ..< 500ms);
          AudioRegion(destination: 500ms ..< 1500ms, link: "take-a") {
            Gain(amount: -6db) as cleanup {
              AudioClip(source: voice, range: 2s ..< 3s);
            }
            at 500ms { set cleanup.amount = 0db; }
          }
          AudioGap(destination: 1500ms ..< 3s);
        }
      }
    }
    export out = render(main);
  `);
  const region = Object.values(ir.nodes).find((node) => node.op === "cut.edit.audio_region");
  assert.ok(region);

  const exported = exportCutTimelineToOtio(ir);
  const audioTracks = exported.timeline.tracks.children.filter((track) => track.kind === "Audio");
  assert.equal(audioTracks.length, 1);
  const hardClip = clips(audioTracks[0])[0];
  assert.ok(hardClip);
  assert.deepEqual(exactSeconds(hardClip.source_range.start_time), rational(2));
  assert.deepEqual(exactSeconds(hardClip.source_range.duration), rational(1));
  assert.deepEqual(
    (hardClip.metadata.cut as { exact_placement: { numerator: string; denominator: string } }).exact_placement,
    { numerator: "1", denominator: "2" },
  );
  assert.deepEqual(gaps(audioTracks[0]).map((item) => exactSeconds(item.source_range.duration)), [rational(1, 2), rational(3, 2)]);
  assert.equal((hardClip.metadata.cut as { linked_av_id: string | null }).linked_av_id, null, "AudioRegion link grouping must not be invented on its unprocessed leaf");

  const issues = exported.report.unsupportedSemantics.filter((item) => item.code === "CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED");
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    code: "CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED",
    category: "effect",
    disposition: "flattened",
    subject: {
      kind: "node",
      id: region.id,
      op: "cut.edit.audio_region",
      property: "processing-link-automation",
    },
    message: `AudioRegion ${region.id} is flattened to its one exact AudioClip descendant as an unprocessed hard clip. OTIO preserves that leaf's visible source range and destination placement, but cannot preserve the region's ordered processor chain, link grouping, declared head/tail handles, expanded transition windows, envelopes, or processor state across a cut. Import will not reconstruct AudioRegion; this export is explicitly lossy rather than round-trippable.`,
    provenance: region.provenance,
  });
  assert.equal(exported.report.status, "lossy-editorial");
  assert.ok(exported.report.unsupportedSemantics.some((item) => item.code === "CUT_OTIO_SIGNAL_UNSUPPORTED"));
  assert.equal(
    exported.report.unsupportedSemantics.some((item) => item.code === "CUT_OTIO_NODE_UNSUPPORTED" && item.subject.id === region.id),
    false,
    "the truthful AudioRegion flattening issue replaces the inaccurate generic omitted-node issue",
  );
  assert.deepEqual(
    ((exported.timeline.metadata.cut as { interchange_report: typeof exported.report }).interchange_report)
      .unsupportedSemantics.find((item) => item.code === "CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED"),
    issues[0],
  );
});

test("OTIO reports a LinkedTrim transaction as provenance-backed lossy editorial state", () => {
  const ir = compile(`
    cut 0.4;
    project "OTIO LinkedTrim fixture";
    import { LinkedTrim, Sequence, PictureTrack, PictureClip, Gap, AudioTrack, AudioGap } from "@cut/edit";
    import { AudioClip } from "@cut/audio";
    asset picture: VideoAsset = video("media/picture.mov");
    asset voice: AudioAsset = audio("media/voice.wav");
    timeline main(duration: 4s, fps: 4, sampleRate: 48khz) {
      scene only(duration: 4s) {
        LinkedTrim(link: "take-a", keep: 1s ..< 3s);
        Sequence(duration: 4s) { PictureTrack() {
          Gap(duration: 500ms);
          PictureClip(source: picture, range: 0s ..< 3s, duration: 3s, link: "take-a");
          Gap(duration: 500ms);
        } }
        AudioTrack() {
          AudioGap(destination: 0s ..< 500ms);
          AudioClip(source: voice, range: 0s ..< 3s, destination: 500ms ..< 3500ms, link: "take-a");
          AudioGap(destination: 3500ms ..< 4s);
        }
      }
    }
    export out = render(main);
  `);
  const transaction = ir.linkedEdits?.[0];
  assert.ok(transaction);

  const exported = exportCutTimelineToOtio(ir);
  const issues = exported.report.unsupportedSemantics.filter((item) => item.code === "CUT_OTIO_LINKED_TRIM_UNSUPPORTED");
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    code: "CUT_OTIO_LINKED_TRIM_UNSUPPORTED",
    category: "timing",
    disposition: "flattened",
    subject: {
      kind: "linked-edit",
      id: transaction.id,
      op: "cut.edit.linked_trim",
      property: "atomic-correlation",
    },
    message: `LinkedTrim transaction ${transaction.id} atomically correlates the picture and audio trims for link "take-a". CUT's materialized hard-cut state remains independently useful where representable, but this OTIO subset cannot reconstruct the transaction or its cross-track correlation; the export is explicitly lossy rather than round-trippable.`,
    provenance: transaction.provenance,
  });
  assert.equal(exported.report.status, "lossy-editorial");
  assert.deepEqual(
    ((exported.timeline.metadata.cut as { interchange_report: typeof exported.report }).interchange_report)
      .unsupportedSemantics.find((item) => item.code === "CUT_OTIO_LINKED_TRIM_UNSUPPORTED"),
    issues[0],
  );
});

test("OTIO never silently loses a LinkedRippleDelete transaction", () => {
  const ir = compile(`
    cut 0.4;
    project "OTIO LinkedRippleDelete fixture";
    import { LinkedRippleDelete, Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
    import { AudioClip } from "@cut/audio";
    asset picture: VideoAsset = video("media/picture.mov");
    asset voice: AudioAsset = audio("media/voice.wav");
    timeline main(duration: 4s, fps: 4, sampleRate: 48khz) {
      scene only(duration: 4s) {
        LinkedRippleDelete(link: "drop");
        Sequence(duration: 4s) { PictureTrack() {
          PictureClip(source: picture, range: 0s ..< 1s, duration: 1s);
          PictureClip(source: picture, range: 1s ..< 2s, duration: 1s, link: "drop");
          PictureClip(source: picture, range: 2s ..< 4s, duration: 2s);
        } }
        AudioTrack() {
          AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s);
          AudioClip(source: voice, range: 1s ..< 2s, destination: 1s ..< 2s, link: "drop");
          AudioClip(source: voice, range: 2s ..< 4s, destination: 2s ..< 4s);
        }
      }
    }
    export out = render(main);
  `);
  const transaction = ir.linkedEdits?.[0];
  assert.ok(transaction && transaction.kind === "linked-ripple-delete");

  const exported = exportCutTimelineToOtio(ir);
  const issues = exported.report.unsupportedSemantics.filter((item) => item.code === "CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED");
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    code: "CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED",
    category: "timing",
    disposition: "flattened",
    subject: {
      kind: "linked-edit",
      id: transaction.id,
      op: "cut.edit.linked_ripple_delete",
      property: "atomic-ripple-correlation",
    },
    message: `LinkedRippleDelete transaction ${transaction.id} atomically correlates the picture and audio ripple closures for link "drop" over scene-local range 1/1s + 1/1s. CUT's materialized post-edit track state remains independently useful where representable, but standard OTIO cannot reconstruct the transaction, its insert-before-delete ordering, or its cross-track correlation; the export is explicitly lossy rather than round-trippable.`,
    provenance: transaction.provenance,
  });
  assert.equal(exported.report.status, "lossy-editorial");
  assert.equal(exported.report.unsupportedSemantics.some((item) => item.code === "CUT_OTIO_LINKED_TRIM_UNSUPPORTED"), false);
  const jsonTimeline = JSON.parse(JSON.stringify(exported.timeline)) as typeof exported.timeline;
  const persistedIssue = ((jsonTimeline.metadata.cut as { interchange_report: typeof exported.report }).interchange_report)
    .unsupportedSemantics.find((item) => item.code === "CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED");
  assert.deepEqual(persistedIssue, issues[0]);
  assert.deepEqual(Object.keys(persistedIssue ?? {}).sort(), ["category", "code", "disposition", "message", "provenance", "subject"]);
  assert.deepEqual(Object.keys(persistedIssue?.subject ?? {}).sort(), ["id", "kind", "op", "property"]);
});

test("OTIO export never labels sparse, overlapping, or non-covering CUT scenes as lossless when import must refuse", () => {
  const layouts = [
    { project: "sparse", scenes: "scene Delayed(duration: 1s, at: 1s) {}" },
    { project: "overlap", scenes: "scene First(duration: 2s) {} scene Overlap(duration: 2s, at: 1s) {}" },
    { project: "non-covering", scenes: "scene Beginning(duration: 1s) {}" },
  ];
  for (const layout of layouts) {
    const ir = compile(`cut 0.4;
project ${JSON.stringify(`${layout.project} OTIO scene proof`)};
timeline MainTimeline(duration: 3s, fps: 24, sampleRate: 48khz) {
  ${layout.scenes}
}
export out = render(MainTimeline);`);
    const exported = exportCutTimelineToOtio(ir);
    assert.equal(exported.report.status, "lossy-editorial", layout.project);
    const issue = exported.report.unsupportedSemantics.find((item) => item.code === "CUT_OTIO_SCENE_LAYOUT_UNSUPPORTED");
    assert.deepEqual(issue?.subject, { kind: "composition", id: "MainTimeline" }, layout.project);
    assert.equal(issue?.category, "timing", layout.project);
    assert.throws(
      () => importOtioTimeline(JSON.stringify(exported.timeline)),
      (error) => error instanceof CutOtioImportError
        && error.code === "CUT_OTIO_IMPORT_TIMING"
        && /exact_scenes/.test(error.path),
      `${layout.project}: report and executable importer must agree that this scene layout is not round-trippable`,
    );
  }
});

test("OTIO export reports media-driven scene subdivision before its own importer refuses exact scene identity", () => {
  const ir = compile(`cut 0.4;
project "scene partition proof";
import { Video } from "cut:visual";
asset picture: VideoAsset = video("media/picture.mov");
timeline MainTimeline(duration: 2s, fps: 24, sampleRate: 48khz) {
  scene AuthoredScene(duration: 2s) {
    at 1s { Video(source: picture, range: 0s ..< 1s); }
  }
}
export out = render(MainTimeline);`);
  const exported = exportCutTimelineToOtio(ir);
  assert.ok(exported.report.unsupportedSemantics.some((item) => item.code === "CUT_OTIO_SCENE_PARTITION_UNSUPPORTED"));
  assert.equal(exported.report.status, "lossy-editorial");
  assert.throws(
    () => importOtioTimeline(JSON.stringify(exported.timeline)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_UNSUPPORTED"
      && error.path === "$.metadata.cut.exact_scenes",
  );
});

test("looped CUT video expands to ordinary exact OTIO clips without a hidden time effect", () => {
  const ir = compile(`
    cut 0.4;
    project "OTIO loop fixture";
    import { Video } from "cut:visual";
    asset picture: VideoAsset = video("media/picture.mov");
    timeline main(duration: 5s, fps: 24) {
      scene only(duration: 5s) {
        Video(source: picture, range: 2s ..< 4s, loop: true);
      }
    }
    export out = render(main);
  `);
  const { timeline, report } = exportCutTimelineToOtio(ir);
  const track = timeline.tracks.children[0];
  assert.deepEqual(clips(track).map((item) => exactSeconds(item.source_range.duration)), [rational(2), rational(2), rational(1)]);
  assert.deepEqual(clips(track).map((item) => (item.metadata.cut as { loop_iteration: number }).loop_iteration), [0, 1, 2]);
  assert.equal(report.unsupportedSemantics.some((item) => item.subject.property === "loop"), false);
});

test("OTIO preserves valid Narration role and never silently publishes archived transcript metadata", () => {
  const valid = compile(`cut 0.4;
project "Narration OTIO closure";
import { Narration } from "@cut/documentary";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 1s) { Narration(source: voice, range: 0s ..< 1s); }
}
export out = render(main);`);
  const validExport = exportCutTimelineToOtio(valid);
  const validClip = validExport.timeline.tracks.children.flatMap(clips)[0];
  assert.ok(validClip);
  assert.equal((validClip.metadata.cut as { node_op?: string }).node_op, "cut.documentary.narration");
  assert.equal(Object.hasOwn(validClip.metadata.cut as object, "transcript"), false);
  const validImport = importOtioTimeline(JSON.stringify(validExport.timeline));
  assert.match(validImport.source, /import \{ Narration \} from "@cut\/documentary";/);
  assert.match(validImport.source, /Narration\(source: audio_001, range: 0s\.\.<1s\);/);
  assert.doesNotMatch(validImport.source, /transcript:/);
  const roundTripped = compile(validImport.source);
  assert.ok(Object.values(roundTripped.nodes).some((node) => node.op === "cut.documentary.narration"));

  for (const value of ["", "archived spoken words"]) {
    const hostile = structuredClone(valid);
    const narration = Object.values(hostile.nodes).find((node) => node.op === "cut.documentary.narration");
    assert.ok(narration);
    narration.inputs.transcript = { kind: "string", value };
    for (const allowLossy of [false, true]) {
      assert.throws(
        () => exportCutTimelineToOtio(hostile, { allowLossy }),
        (error) => error instanceof CutOtioExportError
          && error.code === "CUT_OTIO_CURRENT_NARRATION_TRANSCRIPT"
          && error.source?.nodeId === narration.id
          && error.issue?.evidence?.inputKind === "string"
          && error.issue.evidence.value === value,
        "explicit lossy acceptance must not make hostile current IR publishable",
      );
    }

    hostile.compiler = "cut-ts/0.3.0";
    assert.throws(
      () => exportCutTimelineToOtio(hostile),
      (error) => error instanceof CutOtioExportError
        && error.code === "CUT_OTIO_NARRATION_TRANSCRIPT_REFUSED"
        && error.issue?.evidence?.value === value,
    );
    const accepted = exportCutTimelineToOtio(hostile, { allowLossy: true });
    const issue = accepted.report.unsupportedSemantics.find((item) => item.code === "CUT_OTIO_NARRATION_TRANSCRIPT_UNSUPPORTED");
    assert.deepEqual(issue, {
      code: "CUT_OTIO_NARRATION_TRANSCRIPT_UNSUPPORTED",
      category: "parameter",
      disposition: "omitted",
      subject: { kind: "node", id: narration.id, op: "cut.documentary.narration", property: "transcript" },
      message: "Narration transcript was metadata-only in the archived CUT 0.4 path and has no executable current Narration meaning. It is omitted only under explicit lossy acceptance; use Captions for visible timed text or Marker/Region role metadata for non-rendering notes.",
      provenance: narration.provenance,
      evidence: { inputKind: "string", value },
    });
    assert.equal(accepted.report.status, "lossy-editorial");
    const acceptedClip = accepted.timeline.tracks.children.flatMap(clips)[0];
    assert.ok(acceptedClip);
    assert.equal(Object.hasOwn(acceptedClip.metadata.cut as object, "transcript"), false);
    assert.deepEqual(
      ((accepted.timeline.metadata.cut as { interchange_report: typeof accepted.report }).interchange_report)
        .unsupportedSemantics.find((item) => item.code === "CUT_OTIO_NARRATION_TRANSCRIPT_UNSUPPORTED"),
      issue,
    );
  }
});

test("OTIO export refuses ambiguous compositions, inexact doubles, and unbounded loop expansion", () => {
  const one = compile('cut 0.4; project "one"; timeline a(duration: 1s, fps: 24) {} timeline b(duration: 1s, fps: 24) {} export out = render(a);');
  assert.throws(
    () => exportCutTimelineToOtio(one),
    (error) => error instanceof CutOtioExportError && error.code === "CUT_OTIO_COMPOSITION_REQUIRED",
  );
  assert.equal(exportCutTimelineToOtio(one, { compositionId: "a" }).timeline.name, "a");

  const exact = compile('cut 0.4; project "large"; timeline main(duration: 1s, fps: 24) {} export out = render(main);');
  exact.compositions[0].duration = { numerator: "9007199254740993", denominator: "1" };
  assert.throws(
    () => exportCutTimelineToOtio(exact),
    (error) => error instanceof CutOtioExportError && error.code === "CUT_OTIO_INEXACT_TIME",
  );

  const loop = compile('cut 0.4; project "bounded"; import { Video } from "cut:visual"; asset v: VideoAsset = video("v.mov"); timeline main(duration: 3s, fps: 24) { scene only(duration: 3s) { Video(source: v, range: 0s ..< 1s, loop: true); } } export out = render(main);');
  assert.throws(
    () => exportCutTimelineToOtio(loop, { maxClipInstances: 2 }),
    (error) => error instanceof CutOtioExportError && error.code === "CUT_OTIO_CLIP_LIMIT",
  );
});

test("installed otio export requires a lock and makes lossy acceptance explicit", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-otio-cli-"));
  try {
    await mkdir(resolve(directory, "media"));
    const generated = spawnSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x225588:s=64x64:r=24:d=1",
      "-c:v", "ffv1", resolve(directory, "media", "picture.mov"),
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    await writeFile(resolve(directory, "main.cut"), `cut 0.4;
project "OTIO CLI";
import { Video } from "cut:visual";
asset picture: VideoAsset = video("media/picture.mov");
timeline main(duration: 1s, fps: 24) {
  scene only(duration: 1s) {
    Video(source: picture, range: 0s ..< 1s) as layer;
    set layer.opacity = 50%;
  }
}
export out = render(main);
`);
    const unlocked = runCut(["otio", "export", "main.cut", "--out", "timeline.otio"], directory);
    assert.equal(unlocked.status, 1);
    assert.match(unlocked.stderr, /requires --lock/);
    const locked = runCut(["lock", "main.cut", "--out", "cut.lock"], directory);
    assert.equal(locked.status, 0, locked.stderr);
    const strict = runCut(["otio", "export", "main.cut", "--lock", "cut.lock", "--out", "timeline.otio"], directory);
    assert.equal(strict.status, 2, strict.stderr);
    assert.match(strict.stdout, /^LOSSY exported/);
    const report = JSON.parse(await readFile(resolve(directory, "timeline.otio.report.json"), "utf8")) as { status: string; unsupportedSemantics: Array<{ code: string }> };
    assert.equal(report.status, "lossy-editorial");
    assert.ok(report.unsupportedSemantics.some((item) => item.code === "CUT_OTIO_SIGNAL_UNSUPPORTED"));
    const accepted = runCut(["otio", "export", "main.cut", "--lock", "cut.lock", "--out", "accepted.otio", "--allow-lossy"], directory);
    assert.equal(accepted.status, 0, accepted.stderr);
    const timeline = JSON.parse(await readFile(resolve(directory, "accepted.otio"), "utf8")) as { OTIO_SCHEMA: string; tracks: { children: unknown[] } };
    assert.equal(timeline.OTIO_SCHEMA, "Timeline.1");
    assert.equal(timeline.tracks.children.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
