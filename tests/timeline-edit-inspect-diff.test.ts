import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
} from "../lib/runtime/reference/audio-cache";
import { referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import { ReferenceTimelineEditMaterializationError } from "../lib/runtime/reference/timeline-edit";

type FixtureOptions = Readonly<{
  audioCut?: "1750ms" | "2s";
  curve?: "equal-power" | "linear";
  leftLink?: "left" | "left-relinked";
  pictureAsset?: "picture.mkv" | "picture-v2.mkv";
  pictureRole?: "primary" | "overlay";
  lane?: "hero" | "alternate";
  reverseFirstPicture?: boolean;
  timelineEdit?: boolean;
}>;

function source({
  audioCut = "1750ms",
  curve = "equal-power",
  leftLink = "left",
  pictureAsset = "picture.mkv",
  pictureRole = "primary",
  lane = "hero",
  reverseFirstPicture = false,
  timelineEdit = true,
}: FixtureOptions = {}) {
  return `cut 0.4;
project "timeline edit inspect diff";
import {
  Sequence, PictureTrack, PictureClip, AudioTrack, TimelineEdit,
  editSelection, avTime, editBoundary, editTransition,
  editorialMetadataEntry, editorialMetadata
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("${pictureAsset}");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(
        trackId: "v1",
        role: "${pictureRole}",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.lane", value: "${lane}")
        ])
      ) {
        PictureClip(source: picture, range: 1s ..< 3s, duration: 2s, headHandle: 1s, tailHandle: 1s, link: "${leftLink}", editId: "picture-left", role: "${pictureRole}", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "left")])${reverseFirstPicture ? ', playback: "reverse"' : ""});
        PictureClip(source: picture, range: 3s ..< 5s, duration: 2s, headHandle: 1s, tailHandle: 1s, link: "right", editId: "picture-right", role: "b-roll", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "right")]));
      }
    }
    AudioTrack(trackId: "a1", role: "dialogue", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.lane", value: "dialogue")])) {
      AudioClip(source: voice, range: 1s ..< 3s, destination: 0s ..< 2s, headHandle: 1s, tailHandle: 1s, link: "${leftLink}", editId: "audio-left", role: "dialogue", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "left")]));
      AudioClip(source: voice, range: 3s ..< 5s, destination: 2s ..< 4s, headHandle: 1s, tailHandle: 1s, link: "right", editId: "audio-right", role: "dialogue", metadata: editorialMetadata(entries: [editorialMetadataEntry(key: "org.example.take", value: "right")]));
    }
    ${timelineEdit ? `TimelineEdit(id: "linked-jl", operations: [
      editBoundary(
        selection: editSelection(trackIds: ["v1", "a1"]),
        at: avTime(picture: 2250ms, audio: ${audioCut})
      ),
      editTransition(
        left: editSelection(trackIds: ["v1", "a1"], originIds: ["picture-left", "audio-left"]),
        right: editSelection(trackIds: ["v1", "a1"], originIds: ["picture-right", "audio-right"]),
        at: avTime(picture: 2250ms, audio: ${audioCut}),
        duration: avTime(picture: 500ms, audio: 500ms),
        pictureKind: "cross-dissolve",
        audioCurve: "${curve}"
      )
    ]);` : ""}
  }
}
export out = render(main);`;
}

function compile(options: FixtureOptions = {}): CutAVIR {
  const parsed = parseCutLanguage(source(options));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return compileCutModule(parsed.module).ir;
}

function sceneCacheKey(ir: CutAVIR) {
  const composition = ir.compositions[0];
  assert.ok(composition);
  const result = createIncrementalRenderPlan(ir, composition.id);
  assert.equal(result.scenes.length, 1);
  return result.scenes[0]!.key;
}

function audioCacheIdentity(ir: CutAVIR) {
  const locked = structuredClone(ir);
  for (const resource of Object.values(locked.resources)) {
    resource.state = "locked";
    resource.sha256 = createHash("sha256")
      .update(`${resource.kind}\0${resource.locator}`)
      .digest("hex");
    if (resource.kind === "audio") {
      resource.metadata = {
        lockVersion: 2,
        bytes: 1,
        probe: {
          kind: "media",
          identity: {
            format: "cut-media-probe",
            version: 1,
            streams: [{
              index: 0,
              type: "audio",
              codec: "pcm_s16le",
              disposition: [],
              sampleRate: 48_000,
              channels: 1,
              timeBase: rational(1, 48_000),
              duration: rational(10),
            }],
          },
          selected: {
            audio: {
              streamIndex: 0,
              duration: rational(10),
              durationSource: "stream",
              timeBase: rational(1, 48_000),
            },
          },
        },
      } as never;
    }
  }
  const composition = locked.compositions[0]!;
  const plan = createReferenceAudioCachePlan(
    locked,
    composition,
    referenceMasterAudioRootIds(locked, composition),
    createReferenceAudioToolchainIdentity("ffmpeg version timeline-edit-cache-locality"),
  );
  return Object.freeze({ key: plan.key, graphSha256: plan.graph.sha256 });
}

function placementSource(kind: "insert" | "overwrite") {
  const operation = kind === "insert" ? "editInsert" : "editOverwrite";
  return `cut 0.4;
project "timeline edit ${kind} inspect diff";
import {
  Sequence, PictureTrack, PictureClip, Gap, AudioTrack, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, ${operation}
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(trackId: "v1") {
        PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, link: "source-pair", editId: "source-picture");
        PictureClip(source: picture, range: 1s ..< 3s, duration: 2s, link: "body-pair", editId: "body-picture");
        Gap(duration: 1s);
      }
    }
    AudioTrack(trackId: "a1") {
      AudioClip(source: voice, range: 0s ..< 1s, destination: 0s ..< 1s, link: "source-pair", editId: "source-audio");
      AudioClip(source: voice, range: 1s ..< 3s, destination: 1s ..< 3s, link: "body-pair", editId: "body-audio");
      AudioGap(destination: 3s ..< 4s);
    }
    TimelineEdit(id: "linked-placement", operations: [
      ${operation}(
        picture: editSelection(trackIds: ["v1"]),
        audio: editSelection(trackIds: ["a1"]),
        at: avTime(picture: 1s, audio: 1s),
        operand: editOperand(
          linkId: "placed-pair",
          parts: [
            editOperandPart(
              domain: "picture",
              sourceOriginId: "source-picture",
              originId: "placed-picture",
              duration: 1s
            ),
            editOperandPart(
              domain: "audio",
              sourceOriginId: "source-audio",
              originId: "placed-audio",
              duration: 1s
            )
          ]
        )
      )
    ]);
  }
}
export out = render(main);`;
}

function compilePlacement(kind: "insert" | "overwrite") {
  const parsed = parseCutLanguage(placementSource(kind));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return compileCutModule(parsed.module).ir;
}

test("inspect exposes one canonical TimelineEdit plan, exact J/L clocks, handles, roles, metadata, links, transitions, and materialization identity", () => {
  const ir = compile();
  const report = inspectCutIr(ir, "timeline-edit-inspect.cut");
  assert.equal(report.summary.timelineEdits, 1);
  assert.deepEqual(report.compositions[0]?.timelineEdits, ["linked-jl"]);
  assert.equal(report.timelineEdits?.length, 1);
  const edit = report.timelineEdits?.[0];
  assert.ok(edit);
  assert.equal(edit.id, "linked-jl");
  assert.deepEqual(edit.tracks.map((track) => [track.trackId, track.role, track.metadata]), [
    ["v1", "primary", { "org.example.lane": "hero" }],
    ["a1", "dialogue", { "org.example.lane": "dialogue" }],
  ]);
  const picture = edit.tracks[0]!.items[0]!;
  const audio = edit.tracks[1]!.items[0]!;
  assert.equal(picture.linkId, "left");
  assert.equal(picture.role, "primary");
  assert.deepEqual(picture.metadata, { "org.example.take": "left" });
  assert.deepEqual(picture.sourceView.kind === "picture" ? picture.sourceView.handles : undefined, {
    head: { numerator: "1", denominator: "1" },
    tail: { numerator: "1", denominator: "1" },
  });
  assert.deepEqual(picture.sourceView.kind === "picture" ? picture.sourceView.timeMap : undefined, {
    kind: "constant",
    direction: "forward",
    rate: { numerator: "1", denominator: "1" },
  });
  assert.equal(audio.sourceView.kind, "audio");
  assert.deepEqual(edit.operationClocks.map((clock) => [clock.kind, clock.at?.relationship]), [
    ["boundary-adjust", "j-cut"],
    ["transition", "j-cut"],
  ]);
  assert.deepEqual(edit.execution.linkedBoundaries.map((boundary) => boundary.relationship), ["j-cut"]);
  assert.match(edit.execution.materializationId, /^[a-f0-9]{64}$/u);
  assert.match(edit.execution.semanticMaterializationId, /^[a-f0-9]{64}$/u);
  assert.equal(edit.identities.executable, edit.execution.semanticMaterializationId);
  assert.equal(edit.execution.transitions.length, 2);
  assert.equal(edit.execution.transitions.find((transition) => transition.domain === "picture")?.picture?.kind, "cross-dissolve");
  assert.equal(edit.execution.transitions.find((transition) => transition.domain === "audio")?.audio?.curve, "equal-power");

  const pictureTrack = report.graph.nodes.find((node) => node.pictureEditorial?.trackId === "v1");
  const audioTrack = report.graph.nodes.find((node) => node.editorial?.trackId === "a1");
  assert.equal(pictureTrack?.pictureEditorial?.role, "primary");
  assert.deepEqual(pictureTrack?.pictureEditorial?.metadata, { "org.example.lane": "hero" });
  assert.equal(pictureTrack?.pictureEditorial?.items[0]?.editId, "picture-left");
  assert.equal(audioTrack?.editorial?.role, "dialogue");
  assert.equal(audioTrack?.editorial?.items[0]?.editId, "audio-left");
});

test("TimelineEdit semantic diff isolates plan changes while stable repeat and legacy omission remain exact", () => {
  const before = compile();
  const repeat = compile();
  assert.equal(repeat.buildId, before.buildId);
  assert.equal(sceneCacheKey(structuredClone(repeat)), sceneCacheKey(structuredClone(before)));
  assert.deepEqual(diffCutAVIR(before, repeat).changes, []);

  const cases: readonly [string, FixtureOptions, RegExp][] = [
    ["operation J/L clock", { audioCut: "2s" }, /^\/operations\/[01]\/at\/audio/u],
    ["source authority", { pictureAsset: "picture-v2.mkv" }, /^\/tracks\/0\/items\/[01]\/sourceView\/authorityId/u],
    ["track and item role", { pictureRole: "overlay" }, /^\/tracks\/0\/(?:role|items\/0\/role)/u],
    ["metadata", { lane: "alternate" }, /^\/tracks\/0\/metadata\/org\.example\.lane/u],
    ["retime", { reverseFirstPicture: true }, /^\/tracks\/0\/items\/0\/sourceView\/timeMap\/direction/u],
    ["link", { leftLink: "left-relinked" }, /^\/tracks\/[01]\/items\/0\/linkId/u],
    ["transition curve", { curve: "linear" }, /^\/operations\/1\/audio\/curve/u],
  ];
  const baseSceneKey = sceneCacheKey(structuredClone(before));
  const baseAudioIdentity = audioCacheIdentity(before);
  for (const [label, options, expectedPath] of cases) {
    const after = compile(options);
    const change = diffCutAVIR(before, after).changes.find((entry) =>
      entry.entity === "timeline-edit" && entry.id === "linked-jl");
    assert.equal(change?.operation, "modify", label);
    if (change?.operation === "modify") {
      assert.ok(change.fields.some((field) => expectedPath.test(field.path)), `${label}: ${JSON.stringify(change.fields)}`);
    }
    assert.notEqual(after.buildId, before.buildId, `${label} must change graph/build identity`);
    assert.notEqual(sceneCacheKey(structuredClone(after)), baseSceneKey, `${label} must change localized picture-cache identity`);
    if (label === "source authority") {
      assert.deepEqual(
        audioCacheIdentity(after),
        baseAudioIdentity,
        "a picture-only source edit must not invalidate terminal PCM",
      );
    }
  }

  const provenanceOnly = structuredClone(before);
  provenanceOnly.timelineEdits![0]!.provenance.span.start.line += 40;
  provenanceOnly.timelineEdits![0]!.provenance.span.end.line += 40;
  const audioTrack = Object.values(provenanceOnly.nodes).find((node) =>
    node.editorial?.kind === "audio-track");
  assert.ok(audioTrack);
  audioTrack.provenance.span.start.line += 40;
  audioTrack.provenance.span.end.line += 40;
  assert.deepEqual(diffCutAVIR(before, provenanceOnly).changes, []);
  assert.equal(sceneCacheKey(provenanceOnly), baseSceneKey);
  assert.deepEqual(audioCacheIdentity(provenanceOnly), baseAudioIdentity);

  const legacy = compile({ timelineEdit: false });
  const legacyReport = inspectCutIr(legacy, "legacy-no-timeline-edit.cut");
  assert.equal(Object.hasOwn(legacyReport.summary, "timelineEdits"), false);
  assert.equal(Object.hasOwn(legacyReport, "timelineEdits"), false);
  assert.equal(Object.hasOwn(legacyReport.compositions[0]!, "timelineEdits"), false);
  assert.deepEqual(diffCutAVIR(legacy, structuredClone(legacy)).changes, []);
});

test("valid canonical insert and overwrite remain exact positive inspect/diff and picture/PCM cache counterfactuals", () => {
  const insert = compilePlacement("insert");
  const insertRepeat = compilePlacement("insert");
  const overwrite = compilePlacement("overwrite");
  const overwriteRepeat = compilePlacement("overwrite");
  for (const [label, ir, repeat] of [
    ["insert", insert, insertRepeat],
    ["overwrite", overwrite, overwriteRepeat],
  ] as const) {
    const report = inspectCutIr(ir, `${label}.cut`);
    const edit = report.timelineEdits?.[0];
    assert.ok(edit, label);
    assert.equal(edit.id, "linked-placement", label);
    assert.deepEqual(edit.operations.map((operation) => operation.kind), [label]);
    assert.deepEqual(
      edit.operationClocks.map((clock) => [
        clock.kind,
        clock.at?.relationship,
        clock.at?.picture,
        clock.at?.audio,
      ]),
      [[
        label,
        "aligned",
        { numerator: "1", denominator: "1" },
        { numerator: "1", denominator: "1" },
      ]],
      label,
    );
    assert.equal(edit.identities.plan, inspectCutIr(repeat, `${label}-repeat.cut`).timelineEdits?.[0]?.identities.plan);
    assert.equal(edit.identities.executable, inspectCutIr(repeat, `${label}-repeat.cut`).timelineEdits?.[0]?.identities.executable);
    assert.deepEqual(diffCutAVIR(ir, repeat).changes, [], label);
    assert.equal(sceneCacheKey(structuredClone(ir)), sceneCacheKey(structuredClone(repeat)), label);
    assert.deepEqual(audioCacheIdentity(ir), audioCacheIdentity(repeat), label);
  }

  const change = diffCutAVIR(insert, overwrite).changes.find((entry) =>
    entry.entity === "timeline-edit" && entry.id === "linked-placement");
  assert.equal(change?.operation, "modify");
  assert.ok(change?.operation === "modify");
  assert.ok(change.fields.some((field) =>
    field.path === "/operations/0/kind"
      && field.before === "insert"
      && field.after === "overwrite"), JSON.stringify(change.fields));
  assert.notEqual(
    inspectCutIr(insert, "insert.cut").timelineEdits?.[0]?.identities.executable,
    inspectCutIr(overwrite, "overwrite.cut").timelineEdits?.[0]?.identities.executable,
  );
  assert.notEqual(sceneCacheKey(structuredClone(insert)), sceneCacheKey(structuredClone(overwrite)));
  assert.notDeepEqual(audioCacheIdentity(insert), audioCacheIdentity(overwrite));
});

test("installed inspect and diff publish the TimelineEdit projection", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-timeline-edit-inspect-diff-"));
  try {
    const program = resolve(directory, "timeline-edit.cut");
    const beforePath = resolve(directory, "before.cutir.json");
    const afterPath = resolve(directory, "after.cutir.json");
    await Promise.all([
      writeFile(program, source()),
      writeFile(beforePath, JSON.stringify(compile())),
      writeFile(afterPath, JSON.stringify(compile({ curve: "linear" }))),
    ]);
    const inspect = spawnSync(
      process.execPath,
      [resolve("dist-cli/cli/cut.js"), "inspect", program, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(inspect.status, 0, inspect.stderr);
    const report = JSON.parse(inspect.stdout) as ReturnType<typeof inspectCutIr>;
    assert.deepEqual(report.timelineEdits?.map((edit) => edit.id), ["linked-jl"]);
    assert.equal(report.timelineEdits?.[0]?.execution.linkedBoundaries[0]?.relationship, "j-cut");

    const diff = spawnSync(
      process.execPath,
      [resolve("dist-cli/cli/cut.js"), "diff", beforePath, afterPath, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(diff.status, 2, diff.stderr);
    const changes = JSON.parse(diff.stdout) as ReturnType<typeof diffCutAVIR>;
    const timelineChange = changes.changes.find((change) => change.entity === "timeline-edit");
    assert.equal(timelineChange?.operation, "modify");
    assert.ok(timelineChange?.operation === "modify"
      && timelineChange.fields.some((field) => field.path === "/operations/1/audio/curve"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audio-cache planning replays canonical TimelineEdit before media or cache allocation", () => {
  const ir = compile();
  const composition = ir.compositions[0]!;
  const plan = ir.timelineEdits?.[0];
  assert.ok(plan);
  const boundary = plan.operations.find((operation) => operation.kind === "boundary-adjust");
  assert.ok(boundary?.at.audio);
  (boundary as unknown as {
    at: { audio?: { numerator: string; denominator: string } };
  }).at.audio = { numerator: "2", denominator: "1" };

  assert.throws(
    () => createReferenceAudioCachePlan(
      ir,
      composition,
      referenceMasterAudioRootIds(ir, composition),
      createReferenceAudioToolchainIdentity("ffmpeg version cache-authority-test"),
    ),
    (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
      && error.code === "CUT_TIMELINE_EDIT_TRANSITION",
  );
});

type OriginSlideIdentityOptions = Readonly<{
  by?: "4ms" | "6ms";
  firstSplit?: "16ms" | "20ms";
  padded?: boolean;
}>;

function originSlideIdentitySource({
  by = "4ms",
  firstSplit = "20ms",
  padded = false,
}: OriginSlideIdentityOptions = {}) {
  return `cut 0.4;
project "TimelineEdit origin slide identity";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editSplit, editSlide
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 60ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 60ms) {${padded ? "\n\n" : ""}
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 0ms ..< 60ms,
        destination: 0ms ..< 60ms,
        fadeIn: 6ms,
        fadeOut: 6ms,
        editId: "line"
      );
    }
    TimelineEdit(id: "origin-slide", operations: [
      editSplit(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        at: avTime(audio: ${firstSplit})
      ),
      editSplit(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        at: avTime(audio: 40ms)
      ),
      editSlide(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        range: ${firstSplit} ..< 40ms,
        by: avTime(audio: ${by})
      )
    ]);
  }
}
export out = render(main);`;
}

type OriginBoundaryIdentityOptions = Readonly<{
  at?: "68ms" | "72ms";
  gain?: "-3db" | "-6db";
  padded?: boolean;
  rate?: "double" | "half";
}>;

function originBoundaryIdentitySource({
  at = "72ms",
  gain = "-3db",
  padded = false,
  rate = "half",
}: OriginBoundaryIdentityOptions = {}) {
  const sourceEnd = rate === "half" ? "160ms" : "340ms";
  const sourceDuration = rate === "half" ? "60ms" : "240ms";
  return `cut 0.4;
project "TimelineEdit origin boundary identity";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editBoundary
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 120ms, fps: 25, sampleRate: 48khz) {
  scene only(duration: 120ms) {${padded ? "\n\n" : ""}
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 120ms,
        editId: "line",
        role: "dialogue"
      ) {
        Gain(amount: ${gain}) {
          HighPass(frequency: 700hz) {
            TimeStretch(
              sourceDuration: ${sourceDuration},
              duration: 120ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 100ms ..< ${sourceEnd},
                fadeIn: 12ms,
                fadeOut: 12ms
              );
            }
          }
        }
      }
    }
    TimelineEdit(id: "origin-boundary", operations: [
      editSplit(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        at: avTime(audio: 60ms)
      ),
      editBoundary(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        at: avTime(audio: ${at})
      )
    ]);
  }
}
export out = render(main);`;
}

function compileOriginIdentity(sourceText: string) {
  const parsed = parseCutLanguage(sourceText);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return compileCutModule(parsed.module).ir;
}

function exactTimelineChange(
  before: CutAVIR,
  after: CutAVIR,
  id: "origin-slide" | "origin-boundary",
  expectedPath: RegExp,
) {
  const change = diffCutAVIR(before, after).changes.find((entry) =>
    entry.entity === "timeline-edit" && entry.id === id);
  assert.equal(change?.operation, "modify", id);
  assert.ok(change?.operation === "modify");
  assert.ok(
    change.fields.some((field) => expectedPath.test(field.path)),
    `${id}: ${JSON.stringify(change.fields)}`,
  );
}

test("origin-clock slide and boundary inspect/diff/PCM-cache identity bind exact operations, rates, residual handles, and source graphs", () => {
  const slide = compileOriginIdentity(originSlideIdentitySource());
  const slideRepeat = compileOriginIdentity(originSlideIdentitySource());
  const slidePadded = compileOriginIdentity(originSlideIdentitySource({ padded: true }));
  const slideCache = audioCacheIdentity(slide);
  assert.deepEqual(diffCutAVIR(slide, slideRepeat).changes, []);
  assert.deepEqual(diffCutAVIR(slide, slidePadded).changes, []);
  assert.deepEqual(audioCacheIdentity(slideRepeat), slideCache);
  assert.deepEqual(audioCacheIdentity(slidePadded), slideCache);

  const slideBy = compileOriginIdentity(originSlideIdentitySource({ by: "6ms" }));
  exactTimelineChange(slide, slideBy, "origin-slide", /^\/operations\/2\/by\/audio(?:\/|$)/u);
  assert.notDeepEqual(audioCacheIdentity(slideBy), slideCache);

  const slideResidual = compileOriginIdentity(originSlideIdentitySource({ firstSplit: "16ms" }));
  exactTimelineChange(slide, slideResidual, "origin-slide", /^\/operations\/(?:0\/at|2\/range)\/audio(?:\/|$)/u);
  assert.notDeepEqual(audioCacheIdentity(slideResidual), slideCache);
  const directViews = (ir: CutAVIR) => inspectCutIr(ir, "origin-slide.cut").graph.nodes
    .flatMap((node) => node.timelineAudioMaterialization?.kind === "view"
      && node.timelineAudioMaterialization.originKind === "direct-audio"
      ? [node.timelineAudioMaterialization]
      : [])
    .sort((left, right) => Number(left.destination.start.numerator)
      / Number(left.destination.start.denominator)
      - Number(right.destination.start.numerator)
        / Number(right.destination.start.denominator));
  assert.deepEqual(
    directViews(slide).map((view) => view.handles),
    [
      { head: rational(0), tail: rational(9, 250) },
      { head: rational(1, 50), tail: rational(1, 50) },
      { head: rational(11, 250), tail: rational(0) },
    ],
  );
  assert.deepEqual(
    directViews(slideResidual).map((view) => view.handles),
    [
      { head: rational(0), tail: rational(1, 25) },
      { head: rational(2, 125), tail: rational(1, 50) },
      { head: rational(11, 250), tail: rational(0) },
    ],
  );

  const boundary = compileOriginIdentity(originBoundaryIdentitySource());
  const boundaryRepeat = compileOriginIdentity(originBoundaryIdentitySource());
  const boundaryPadded = compileOriginIdentity(originBoundaryIdentitySource({ padded: true }));
  const boundaryCache = audioCacheIdentity(boundary);
  assert.deepEqual(diffCutAVIR(boundary, boundaryRepeat).changes, []);
  assert.deepEqual(diffCutAVIR(boundary, boundaryPadded).changes, []);
  assert.deepEqual(audioCacheIdentity(boundaryRepeat), boundaryCache);
  assert.deepEqual(audioCacheIdentity(boundaryPadded), boundaryCache);

  const boundaryAt = compileOriginIdentity(originBoundaryIdentitySource({ at: "68ms" }));
  exactTimelineChange(boundary, boundaryAt, "origin-boundary", /^\/operations\/1\/at\/audio(?:\/|$)/u);
  assert.notDeepEqual(audioCacheIdentity(boundaryAt), boundaryCache);

  const boundaryRate = compileOriginIdentity(originBoundaryIdentitySource({ rate: "double" }));
  exactTimelineChange(boundary, boundaryRate, "origin-boundary", /^\/tracks\/0\/items\/0\/sourceView\/rate(?:\/|$)/u);
  assert.notDeepEqual(audioCacheIdentity(boundaryRate), boundaryCache);

  const boundaryGraph = compileOriginIdentity(originBoundaryIdentitySource({ gain: "-6db" }));
  exactTimelineChange(boundary, boundaryGraph, "origin-boundary", /^\/tracks\/0\/items\/0\/sourceView\/graphAuthorityId$/u);
  assert.notDeepEqual(audioCacheIdentity(boundaryGraph), boundaryCache);
});

type ProcessedOriginFixtureOptions = Readonly<{
  gain?: "-3db" | "-6db";
  link?: "dialogue-a" | "dialogue-b";
  originEnd?: "20ms" | "25ms";
  splitAt?: "5ms" | "10ms";
  voice?: "voice.wav" | "voice-v2.wav";
}>;

function processedOriginSource({
  gain = "-3db",
  link = "dialogue-a",
  originEnd = "20ms",
  splitAt = "10ms",
  voice = "voice.wav",
}: ProcessedOriginFixtureOptions = {}) {
  return `cut 0.4;
project "TimelineEdit inspect origin clock";
import {
  Sequence, PictureTrack, PictureClip, AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editTrim
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("${voice}");
timeline main(duration: ${originEnd}, fps: 200, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: ${originEnd}) {
    Sequence(duration: ${originEnd}) {
      PictureTrack(trackId: "v1", role: "primary") {
        PictureClip(
          source: picture,
          range: 0ms ..< ${originEnd},
          duration: ${originEnd},
          link: "${link}",
          editId: "picture-line",
          role: "primary"
        );
      }
    }
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< ${originEnd},
        link: "${link}",
        editId: "processed-line",
        role: "dialogue"
      ) {
        Gain(amount: ${gain}) {
          HighPass(frequency: 800hz) {
            AudioClip(
              source: voice,
              range: 0ms ..< ${originEnd},
              fadeIn: 4ms,
              fadeOut: 4ms
            );
          }
        }
      }
    }
    TimelineEdit(
      id: "split-trim-processed-line",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["v1", "dialogue"],
            originIds: ["picture-line", "processed-line"]
          ),
          at: avTime(picture: ${splitAt}, audio: ${splitAt})
        ),
        editTrim(
          selection: editSelection(
            trackIds: ["v1", "dialogue"],
            originIds: ["picture-line", "processed-line"]
          ),
          keep: 0ms ..< 15ms
        )
      ]
    );
  }
}
export out = render(main);`;
}

function compileProcessedOrigin(options: ProcessedOriginFixtureOptions = {}) {
  const parsed = parseCutLanguage(processedOriginSource(options));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return compileCutModule(parsed.module).ir;
}

function compileProcessedOriginProvenanceOnly(padded: boolean) {
  const source = `cut 0.4;
project "TimelineEdit origin provenance";
import {
  AudioTrack, AudioRegion, TimelineEdit, editSelection, avTime, editSplit
} from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    ${padded ? "\n\n" : ""}
    AudioTrack(trackId: "dialogue") {
      AudioRegion(destination: 0ms ..< 20ms, editId: "line") {
        Gain(amount: -3db) {
          AudioClip(source: voice, range: 0ms ..< 20ms, fadeIn: 4ms);
        }
      }
    }
    TimelineEdit(
      id: "split-line",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["line"]
          ),
          at: avTime(audio: 10ms)
        )
      ]
    );
  }
}
export out = render(main);`;
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return compileCutModule(parsed.module).ir;
}

test("TimelineEdit origin/view inspect, semantic diff, and PCM cache identity bind exact clocks and authorities", () => {
  const before = compileProcessedOrigin();
  const repeat = compileProcessedOrigin();
  const report = inspectCutIr(before, "processed-origin.cut");
  const origins = report.graph.nodes.filter((node) =>
    node.timelineAudioMaterialization?.kind === "origin");
  const views = report.graph.nodes
    .filter((node) => node.timelineAudioMaterialization?.kind === "view")
    .sort((left, right) => {
      const leftStart = left.timelineAudioMaterialization?.kind === "view"
        ? Number(left.timelineAudioMaterialization.destination.start.numerator)
          / Number(left.timelineAudioMaterialization.destination.start.denominator)
        : 0;
      const rightStart = right.timelineAudioMaterialization?.kind === "view"
        ? Number(right.timelineAudioMaterialization.destination.start.numerator)
          / Number(right.timelineAudioMaterialization.destination.start.denominator)
        : 0;
      return leftStart - rightStart;
    });
  assert.equal(origins.length, 1);
  assert.equal(views.length, 2);
  const origin = origins[0]!.timelineAudioMaterialization;
  assert.ok(origin?.kind === "origin");
  assert.equal(origin.originKind, "processed-audio");
  assert.equal(origin.statePolicy, "single-authorized-evaluation");
  assert.match(origin.originAuthorityId, /^[a-f0-9]{64}$/u);
  assert.match(origin.sourceAuthorityId, /^authority_[a-f0-9]{24}$/u);
  assert.match(origin.graphAuthorityId ?? "", /^graph_[a-f0-9]{24}$/u);
  assert.deepEqual(origin.originDuration, rational(1, 50));
  assert.ok(before.nodes[origin.childNodeId]);
  const first = views[0]!.timelineAudioMaterialization;
  const second = views[1]!.timelineAudioMaterialization;
  assert.ok(first?.kind === "view" && second?.kind === "view");
  assert.equal(first.originNodeId, origin.originNodeId);
  assert.equal(second.originNodeId, origin.originNodeId);
  assert.notEqual(first.segmentNodeId, second.segmentNodeId);
  assert.deepEqual(first.originDuration, rational(1, 50));
  assert.deepEqual(second.originDuration, rational(1, 50));
  assert.deepEqual(first.sliceOffset, rational(0));
  assert.deepEqual(second.sliceOffset, rational(1, 100));
  assert.deepEqual(first.handles, {
    head: rational(0),
    tail: rational(1, 100),
  });
  assert.deepEqual(second.handles, {
    head: rational(1, 100),
    tail: rational(1, 200),
  });
  assert.deepEqual(first.source, { start: rational(0), end: rational(1, 100) });
  assert.deepEqual(second.source, { start: rational(1, 100), end: rational(3, 200) });
  assert.deepEqual(first.destination, { start: rational(0), duration: rational(1, 100) });
  assert.deepEqual(second.destination, { start: rational(1, 100), duration: rational(1, 200) });
  assert.equal(first.link, "dialogue-a");
  assert.equal(second.link, "dialogue-a");
  assert.deepEqual(diffCutAVIR(before, repeat).changes, []);
  assert.deepEqual(audioCacheIdentity(before), audioCacheIdentity(repeat));

  const cases: ReadonlyArray<Readonly<{
    label: string;
    options: ProcessedOriginFixtureOptions;
    expectedTimelineField: RegExp;
  }>> = [
    {
      label: "processor graph authority",
      options: { gain: "-6db" },
      expectedTimelineField: /^\/tracks\/1\/items\/0\/sourceView\/graphAuthorityId$/u,
    },
    {
      label: "source authority",
      options: { voice: "voice-v2.wav" },
      expectedTimelineField: /^\/tracks\/1\/items\/0\/sourceView\/authorityId$/u,
    },
    {
      label: "origin duration",
      options: { originEnd: "25ms" },
      expectedTimelineField:
        /^\/tracks\/1\/items\/0\/sourceView\/presentationClock\/originDuration(?:\/|$)/u,
    },
    {
      label: "origin view clocks and segment placement",
      options: { splitAt: "5ms" },
      expectedTimelineField: /^\/operations\/0\/at\/(?:picture|audio)(?:\/|$)/u,
    },
    {
      label: "link identity",
      options: { link: "dialogue-b" },
      expectedTimelineField: /^\/tracks\/[01]\/items\/0\/linkId$/u,
    },
  ];
  const baseCache = audioCacheIdentity(before);
  for (const fixture of cases) {
    const after = compileProcessedOrigin(fixture.options);
    const timelineChange = diffCutAVIR(before, after).changes.find((change) =>
      change.entity === "timeline-edit"
      && change.id === "split-trim-processed-line"
      && change.operation === "modify");
    assert.ok(timelineChange?.operation === "modify", fixture.label);
    assert.ok(
      timelineChange.fields.some((field) =>
        fixture.expectedTimelineField.test(field.path)),
      `${fixture.label}: ${JSON.stringify(timelineChange.fields)}`,
    );
    assert.notDeepEqual(audioCacheIdentity(after), baseCache, fixture.label);
  }

  const provenanceBefore = compileProcessedOriginProvenanceOnly(false);
  const provenanceAfter = compileProcessedOriginProvenanceOnly(true);
  assert.notEqual(provenanceAfter.sourceHash, provenanceBefore.sourceHash);
  assert.equal(provenanceAfter.buildId, provenanceBefore.buildId);
  assert.deepEqual(diffCutAVIR(provenanceBefore, provenanceAfter).changes, []);
  assert.deepEqual(
    audioCacheIdentity(provenanceAfter),
    audioCacheIdentity(provenanceBefore),
  );
});
