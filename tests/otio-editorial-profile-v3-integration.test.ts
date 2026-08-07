import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import {
  exportCutTimelineToOtio,
  type OtioTimeline,
} from "../lib/interchange/otio";
import {
  CutOtioImportError,
  importOtioTimeline,
} from "../lib/interchange/otio-import";
import { checkCutModule } from "../lib/language/checker";
import type { CutOtioEditorialProfile } from "../lib/interchange/otio-editorial-profile";
import {
  createCutOtioEditorialProfileV3,
  cutOtioEditorialAudioLineageSha256,
  type CutOtioEditorialProfileV3,
} from "../lib/interchange/otio-editorial-profile-v3";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

const processedTimelineSource = `cut 0.4;
project "OTIO V3 processed origin";
import {
  AudioRegion, AudioTrack, TimelineEdit,
  editSelection, editSplit, editTrim, avTime,
  editorialMetadata, editorialMetadataEntry
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(
      trackId: "dialogue",
      role: "dialogue",
      metadata: editorialMetadata(entries: [
        editorialMetadataEntry(key: "org.example.track", value: "dialogue")
      ])
    ) {
      AudioRegion(
        destination: 0ms ..< 20ms,
        headHandle: 2ms,
        tailHandle: 2ms,
        editId: "processed-line",
        role: "dialogue",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.item", value: "processed")
        ])
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 800hz) {
            AudioClip(
              source: voice,
              range: 2ms ..< 22ms,
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
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          at: avTime(audio: 10ms)
        ),
        editTrim(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          keep: 0ms ..< 15ms
        )
      ]
    );
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

const twoBoundaryTrimSource = processedTimelineSource
  .replace(
    "editSelection, editSplit, editTrim, avTime,",
    "editSelection, editTrim, avTime,",
  )
  .replace(
    `id: "split-trim-processed-line",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          at: avTime(audio: 10ms)
        ),
        editTrim(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          keep: 0ms ..< 15ms
        )
      ]`,
    `id: "trim-inside-processed-line",
      operations: [
        editTrim(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          keep: 5ms ..< 15ms
        )
      ]`,
  );

const retimedProcessedTimelineSource = `cut 0.4;
project "OTIO V3 retimed processed origin";
import {
  AudioRegion, AudioTrack, TimelineEdit,
  editSelection, editSplit, editTrim, avTime
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 200ms, fps: 20, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 200ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 200ms,
        editId: "processed-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 800hz) {
            TimeStretch(
              sourceDuration: 100ms,
              duration: 200ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 0ms ..< 100ms,
                fadeIn: 20ms,
                fadeOut: 20ms
              );
            }
          }
        }
      }
    }
    TimelineEdit(
      id: "split-trim-retimed-line",
      operations: [
        editSplit(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          at: avTime(audio: 100ms)
        ),
        editTrim(
          selection: editSelection(
            trackIds: ["dialogue"],
            originIds: ["processed-line"]
          ),
          keep: 0ms ..< 150ms
        )
      ]
    );
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

const placedProcessedTimelineSource = `cut 0.4;
project "OTIO V3 processed insert overwrite";
import {
  AudioRegion, AudioTrack, AudioGap, TimelineEdit,
  editSelection, avTime, editOperandPart, editOperand, editInsert, editOverwrite,
  editorialMetadata, editorialMetadataEntry
} from "@cut/edit";
import { AudioClip, Gain, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 400ms, fps: 25, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 400ms) {
    AudioTrack(
      trackId: "dialogue",
      role: "dialogue",
      metadata: editorialMetadata(entries: [
        editorialMetadataEntry(key: "org.example.track", value: "dialogue")
      ])
    ) {
      AudioRegion(
        destination: 0ms ..< 100ms,
        editId: "processed-source",
        role: "dialogue",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.item", value: "source")
        ])
      ) {
        Gain(amount: -3db) {
          TimeStretch(sourceDuration: 50ms, duration: 100ms, pitch: 0, quality: "draft") {
            AudioClip(source: voice, range: 0ms ..< 50ms, fadeIn: 10ms, fadeOut: 10ms);
          }
        }
      }
      AudioClip(
        source: voice,
        range: 100ms ..< 300ms,
        destination: 100ms ..< 300ms,
        editId: "body",
        role: "dialogue"
      );
      AudioGap(destination: 300ms ..< 400ms);
    }
    TimelineEdit(id: "processed-placement", operations: [
      editInsert(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 100ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "processed-source",
            originId: "inserted-processed",
            duration: 100ms,
            metadata: editorialMetadata(entries: [
              editorialMetadataEntry(key: "org.example.placement", value: "insert")
            ])
          )
        ])
      ),
      editOverwrite(
        audio: editSelection(trackIds: ["dialogue"]),
        at: avTime(audio: 300ms),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "audio",
            sourceOriginId: "processed-source",
            originId: "overwritten-processed",
            duration: 100ms,
            metadata: editorialMetadata(entries: [
              editorialMetadataEntry(key: "org.example.placement", value: "overwrite")
            ])
          )
        ])
      )
    ]);
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

const fadedDirectSlideSource = `cut 0.4;
project "OTIO V3 in-origin faded slide";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editSplit, editSlide
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 60ms, fps: 50, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 60ms) {
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
    TimelineEdit(id: "split-slide-faded-line", operations: [
      editSplit(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        at: avTime(audio: 20ms)
      ),
      editSplit(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        at: avTime(audio: 40ms)
      ),
      editSlide(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        range: 20ms ..< 40ms,
        by: avTime(audio: 4ms)
      )
    ]);
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

const processedRetimedBoundarySource = `cut 0.4;
project "OTIO V3 in-origin retimed boundary";
import {
  AudioTrack, AudioRegion, TimelineEdit,
  editSelection, avTime, editSplit, editBoundary
} from "@cut/edit";
import { AudioClip, Gain, HighPass, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 120ms, fps: 25, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 120ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 120ms,
        editId: "slow-line",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          HighPass(frequency: 700hz) {
            TimeStretch(
              sourceDuration: 60ms,
              duration: 120ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(
                source: voice,
                range: 100ms ..< 160ms,
                fadeIn: 12ms,
                fadeOut: 12ms
              );
            }
          }
        }
      }
    }
    TimelineEdit(id: "split-boundary-retimed-line", operations: [
      editSplit(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["slow-line"]),
        at: avTime(audio: 60ms)
      ),
      editBoundary(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["slow-line"]),
        at: avTime(audio: 72ms)
      )
    ]);
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

const crossTrackProcessedPlacementSource = `cut 0.4;
project "OTIO V3 cross-track processed placement";
import {
  AudioRegion, AudioTrack, AudioGap, TimelineEdit,
  editSelection, editOperandPart, editOperand, editInsert, editOverwrite, avTime
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 200, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "source-track", role: "dialogue") {
      AudioRegion(destination: 0ms ..< 5ms, editId: "processed-source", role: "dialogue") {
        Gain(amount: -3db) {
          HighPass(frequency: 800hz) {
            AudioClip(source: voice, range: 0ms ..< 5ms, fadeIn: 1ms, fadeOut: 1ms);
          }
        }
      }
      AudioGap(destination: 5ms ..< 20ms);
    }
    AudioTrack(trackId: "destination-track", role: "dialogue") {
      AudioGap(destination: 0ms ..< 20ms);
    }
    TimelineEdit(id: "cross-track-placement", operations: [
      editInsert(
        audio: editSelection(trackIds: ["destination-track"]),
        at: avTime(audio: 5ms),
        operand: editOperand(parts: [
          editOperandPart(domain: "audio", sourceOriginId: "processed-source", originId: "inserted", duration: 5ms)
        ])
      ),
      editOverwrite(
        audio: editSelection(trackIds: ["destination-track"]),
        at: avTime(audio: 10ms),
        operand: editOperand(parts: [
          editOperandPart(domain: "audio", sourceOriginId: "processed-source", originId: "overwritten", duration: 5ms)
        ])
      )
    ]);
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

const linkedPictureProcessedPlacementSource = `cut 0.4;
project "OTIO V3 linked picture processed placement";
import {
  Sequence, PictureTrack, PictureClip, Gap,
  AudioRegion, AudioTrack, AudioGap, TimelineEdit,
  editSelection, editOperandPart, editOperand, editInsert, editOverwrite, avTime
} from "@cut/edit";
import { AudioClip, Gain, HighPass } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 200, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    Sequence(duration: 20ms) {
      PictureTrack(trackId: "v1", role: "primary") {
        PictureClip(source: picture, range: 0ms ..< 5ms, duration: 5ms, link: "source-pair", editId: "source-picture", role: "primary");
        Gap(duration: 15ms);
      }
    }
    AudioTrack(trackId: "source-track", role: "dialogue") {
      AudioRegion(destination: 0ms ..< 5ms, link: "source-pair", editId: "processed-source", role: "dialogue") {
        Gain(amount: -3db) {
          HighPass(frequency: 800hz) {
            AudioClip(source: voice, range: 0ms ..< 5ms, fadeIn: 1ms, fadeOut: 1ms);
          }
        }
      }
      AudioGap(destination: 5ms ..< 20ms);
    }
    AudioTrack(trackId: "destination-track", role: "dialogue") {
      AudioGap(destination: 0ms ..< 20ms);
    }
    TimelineEdit(id: "linked-cross-track-placement", operations: [
      editInsert(
        picture: editSelection(trackIds: ["v1"]),
        audio: editSelection(trackIds: ["destination-track"]),
        at: avTime(picture: 5ms, audio: 5ms),
        operand: editOperand(linkId: "inserted-pair", parts: [
          editOperandPart(domain: "picture", sourceOriginId: "source-picture", originId: "inserted-picture", duration: 5ms),
          editOperandPart(domain: "audio", sourceOriginId: "processed-source", originId: "inserted-audio", duration: 5ms)
        ])
      ),
      editOverwrite(
        picture: editSelection(trackIds: ["v1"]),
        audio: editSelection(trackIds: ["destination-track"]),
        at: avTime(picture: 10ms, audio: 10ms),
        operand: editOperand(linkId: "overwritten-pair", parts: [
          editOperandPart(domain: "picture", sourceOriginId: "source-picture", originId: "overwritten-picture", duration: 5ms),
          editOperandPart(domain: "audio", sourceOriginId: "processed-source", originId: "overwritten-audio", duration: 5ms)
        ])
      )
    ]);
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function cutMetadata(timeline: OtioTimeline) {
  return timeline.metadata.cut as {
    editorial_profile: CutOtioEditorialProfile;
    editorial_profile_extension: CutOtioEditorialProfileV3;
  };
}

function mutate<T>(value: T) {
  return structuredClone(value) as Mutable<T>;
}

function mutableCutMetadata(value: unknown) {
  return (value as {
    metadata: {
      cut: Mutable<{
        editorial_profile: CutOtioEditorialProfile;
        editorial_profile_extension: CutOtioEditorialProfileV3;
      }>;
    };
  }).metadata.cut;
}

function importProfileError(value: unknown, path: RegExp) {
  return assert.throws(
    () => importOtioTimeline(JSON.stringify(value), { allowLossy: true }),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_PROFILE"
      && path.test(error.path),
  );
}

test("production OTIO export publishes deterministic V2 plus V3 processed origin-clock authority", () => {
  const ir = compile(processedTimelineSource);
  const first = exportCutTimelineToOtio(ir);
  const second = exportCutTimelineToOtio(compile(processedTimelineSource));
  const cut = cutMetadata(first.timeline);
  const repeated = cutMetadata(second.timeline);

  assert.equal(cut.editorial_profile.version, 2);
  assert.equal(cut.editorial_profile_extension.version, 3);
  assert.equal(
    cut.editorial_profile_extension.baseProfileSemanticSha256,
    cut.editorial_profile.semanticSha256,
  );
  assert.deepEqual(cut.editorial_profile_extension, repeated.editorial_profile_extension);
  assert.equal(
    first.report.editorialProfile?.extension?.semanticSha256,
    cut.editorial_profile_extension.semanticSha256,
  );
  const origin = cut.editorial_profile_extension.audioOrigins[0];
  assert.equal(first.report.editorialProfile?.extension?.origins, 1);
  assert.equal(first.report.editorialProfile?.extension?.views, 2);
  assert.equal(
    first.report.editorialProfile?.extension?.lineageSegments,
    origin.lineageSegments.length,
  );

  assert.equal(origin.kind, "processed-audio");
  assert.deepEqual(origin.fadeIn, { numerator: "1", denominator: "250" });
  assert.deepEqual(origin.fadeOut, { numerator: "1", denominator: "250" });
  assert.equal(origin.views.length, 2);
  assert.deepEqual(
    origin.views.map((view) => ({
      segmentId: view.segmentId,
      parentSegmentId: view.parentSegmentId ?? null,
      sliceOffset: view.sliceOffset,
      source: view.source,
      destination: view.destination,
      handles: view.handles,
      role: view.role,
      metadata: view.metadata,
      lineageSha256: view.lineageSha256,
    })),
    repeated.editorial_profile_extension.audioOrigins[0].views.map((view) => ({
      segmentId: view.segmentId,
      parentSegmentId: view.parentSegmentId ?? null,
      sliceOffset: view.sliceOffset,
      source: view.source,
      destination: view.destination,
      handles: view.handles,
      role: view.role,
      metadata: view.metadata,
      lineageSha256: view.lineageSha256,
    })),
  );
  assert.ok(origin.processorNodeIds.length >= 2);
  assert.match(origin.processorGraphSemanticSha256 ?? "", /^[a-f0-9]{64}$/u);
});

test("V3 publishes the exact parent-first ancestor closure for a two-boundary trim", () => {
  const first = cutMetadata(
    exportCutTimelineToOtio(compile(twoBoundaryTrimSource)).timeline,
  ).editorial_profile_extension.audioOrigins[0];
  const repeated = cutMetadata(
    exportCutTimelineToOtio(compile(twoBoundaryTrimSource)).timeline,
  ).editorial_profile_extension.audioOrigins[0];
  assert.deepEqual(first, repeated);
  assert.equal(first.views.length, 1);
  assert.equal(first.lineageSegments.length, 3);
  const [root, interiorParent, visible] = first.lineageSegments;
  assert.equal(root.parentSegmentId, undefined);
  assert.equal(interiorParent.parentSegmentId, root.segmentId);
  assert.equal(visible.parentSegmentId, interiorParent.segmentId);
  assert.equal(first.views[0].segmentId, visible.segmentId);
  assert.equal(first.views[0].lineageSha256, visible.lineageSha256);
  assert.deepEqual(first.views[0].sliceOffset, {
    numerator: "1",
    denominator: "200",
  });
  assert.deepEqual(first.views[0].source, {
    start: { numerator: "7", denominator: "1000" },
    duration: { numerator: "1", denominator: "100" },
  });
  assert.deepEqual(first.views[0].destination, {
    start: { numerator: "1", denominator: "200" },
    duration: { numerator: "1", denominator: "100" },
  });
});

test("public importer authenticates V3 before source generation and records exact scoped allow-lossy evidence", () => {
  const exported = exportCutTimelineToOtio(compile(processedTimelineSource));
  const cut = cutMetadata(exported.timeline);

  assert.throws(
    () => importOtioTimeline(JSON.stringify(exported.timeline)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_LOSSY_REFUSED",
  );

  const imported = importOtioTimeline(
    JSON.stringify(exported.timeline),
    { allowLossy: true },
  );
  assert.equal(imported.report.status, "lossy-editorial");
  assert.equal(
    imported.report.editorialProfile?.extension?.semanticSha256,
    cut.editorial_profile_extension.semanticSha256,
  );
  assert.equal(imported.report.editorialProfile?.extension?.origins, 1);
  assert.equal(imported.report.editorialProfile?.extension?.views, 2);
  assert.equal(
    imported.report.editorialProfile?.extension?.lineageSegments,
    cut.editorial_profile_extension.audioOrigins[0].lineageSegments.length,
  );
  assert.ok(imported.report.losses.some((loss) =>
    "target" in loss
    && loss.code === "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED"
    && loss.evidence.inputKind === "cut-otio-editorial-profile-extension"
    && loss.evidence.value === cut.editorial_profile_extension.semanticSha256));
  assert.doesNotThrow(() => compile(imported.source));
  assert.doesNotMatch(imported.source, /\b(?:Gain|HighPass|TimelineEdit)\(/u);
});

test("public importer reconstructs exact forward audio retime timing through executable AudioRegion and TimeStretch", () => {
  const exported = exportCutTimelineToOtio(compile(retimedProcessedTimelineSource));
  const imported = importOtioTimeline(
    JSON.stringify(exported.timeline),
    { allowLossy: true },
  );
  assert.match(imported.source, /\bAudioRegion\(/u);
  assert.match(imported.source, /\bTimeStretch\(sourceDuration:/u);
  assert.doesNotMatch(imported.source, /\b(?:Gain|HighPass|TimelineEdit)\(/u);
  const parsed = parseCutLanguage(imported.source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(checkCutModule(parsed.module).diagnostics, []);
  const roundtrip = compile(imported.source);
  const stretches = Object.values(roundtrip.nodes).filter((node) =>
    node.op === "cut.audio.time_stretch");
  assert.equal(stretches.length, 2);
  assert.deepEqual(
    stretches.map((node) => ({
      sourceDuration: node.inputs.sourceDuration,
      duration: node.inputs.duration,
    })),
    [
      {
        sourceDuration: {
          kind: "quantity",
          dimension: "time",
          magnitude: { numerator: "1", denominator: "20" },
          unit: "s",
        },
        duration: {
          kind: "quantity",
          dimension: "time",
          magnitude: { numerator: "1", denominator: "10" },
          unit: "s",
        },
      },
      {
        sourceDuration: {
          kind: "quantity",
          dimension: "time",
          magnitude: { numerator: "1", denominator: "40" },
          unit: "s",
        },
        duration: {
          kind: "quantity",
          dimension: "time",
          magnitude: { numerator: "1", denominator: "20" },
          unit: "s",
        },
      },
    ],
  );
});

test("cross-track processed placement exports one source-owned origin with exact multi-track lineage and deterministic losses", () => {
  const first = exportCutTimelineToOtio(
    compile(crossTrackProcessedPlacementSource),
  );
  const repeated = exportCutTimelineToOtio(
    compile(crossTrackProcessedPlacementSource),
  );
  const cut = cutMetadata(first.timeline);
  const repeatedCut = cutMetadata(repeated.timeline);
  assert.deepEqual(
    cut.editorial_profile_extension,
    repeatedCut.editorial_profile_extension,
  );
  assert.equal(cut.editorial_profile_extension.audioOrigins.length, 1);
  const origin = cut.editorial_profile_extension.audioOrigins[0];
  assert.equal(origin.trackId, "source-track");
  assert.equal(origin.timelineEditPlanId, "cross-track-placement");
  assert.equal(origin.timelineEditOriginId, "processed-source");
  assert.deepEqual(
    origin.views.map((view) => view.itemId),
    ["processed-source", "inserted", "overwritten"],
  );
  assert.deepEqual(
    origin.views.map((view) => {
      const lineage = origin.lineageSegments.find((segment) =>
        segment.segmentId === view.segmentId);
      assert.ok(lineage);
      return [view.itemId, lineage.trackId, lineage.originId];
    }),
    [
      ["processed-source", "source-track", "processed-source"],
      ["inserted", "destination-track", "inserted"],
      ["overwritten", "destination-track", "overwritten"],
    ],
  );
  assert.equal(
    origin.lineageSegments.filter((segment) =>
      segment.trackId === "source-track"
      && segment.originId === "processed-source"
      && segment.parentSegmentId === undefined).length,
    1,
  );
  for (const view of origin.views) {
    assert.equal(
      cut.editorial_profile_extension.losses.filter((loss) =>
        loss.subject.kind === "item"
        && loss.subject.id === view.itemId
        && (loss.code === "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED"
          || loss.code === "CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED"))
        .length,
      2,
    );
  }
  const wrongSegmentTrack = mutate(cut.editorial_profile_extension);
  const targetSegment = wrongSegmentTrack.audioOrigins[0].lineageSegments
    .find((segment) => segment.trackId === "destination-track");
  assert.ok(targetSegment);
  targetSegment.trackId = "source-track";
  targetSegment.lineageSha256 = cutOtioEditorialAudioLineageSha256(
    targetSegment,
  );
  const {
    semanticSha256: _wrongSegmentSemanticSha256,
    ...wrongSegmentBody
  } = wrongSegmentTrack;
  assert.throws(
    () => createCutOtioEditorialProfileV3(
      cut.editorial_profile,
      wrongSegmentBody,
    ),
    /exact Audio track carried by its lineage segment/u,
  );

  const wrongOwnerTrack = mutate(cut.editorial_profile_extension);
  wrongOwnerTrack.audioOrigins[0].trackId = "destination-track";
  const {
    semanticSha256: _wrongOwnerSemanticSha256,
    ...wrongOwnerBody
  } = wrongOwnerTrack;
  assert.throws(
    () => createCutOtioEditorialProfileV3(
      cut.editorial_profile,
      wrongOwnerBody,
    ),
    /source-track base segment/u,
  );
});

test("linked picture plus cross-track processed audio placement preserves pair multiplicity and scopes losses to audio views", () => {
  const first = exportCutTimelineToOtio(
    compile(linkedPictureProcessedPlacementSource),
  );
  const repeated = exportCutTimelineToOtio(
    compile(linkedPictureProcessedPlacementSource),
  );
  const cut = cutMetadata(first.timeline);
  assert.deepEqual(cut, cutMetadata(repeated.timeline));
  const origin = cut.editorial_profile_extension.audioOrigins[0];
  assert.equal(origin.trackId, "source-track");
  assert.equal(origin.timelineEditPlanId, "linked-cross-track-placement");
  assert.deepEqual(
    origin.views.map((view) => view.itemId),
    ["processed-source", "inserted-audio", "overwritten-audio"],
  );
  const expectedPairs = [
    ["inserted-picture", "inserted-audio"],
    ["overwritten-picture", "overwritten-audio"],
    ["source-picture", "processed-source"],
  ] as const;
  assert.equal(new Set(cut.editorial_profile.linkGroups.map((group) => group.id)).size, 3);
  assert.ok(cut.editorial_profile.linkGroups.every((group) =>
    /^otio_link_[a-f0-9]{20}$/u.test(group.id)));
  assert.deepEqual(
    cut.editorial_profile.linkGroups.map((group) => {
      assert.equal(group.segments.length, 1);
      const segment = group.segments[0]!;
      return [segment.pictureItemId, segment.audioItemId];
    }),
    expectedPairs,
  );
  const pictureIds = new Set<string>(expectedPairs.map((pair) => pair[0]));
  assert.equal(
    cut.editorial_profile_extension.losses.filter((loss) =>
      loss.subject.kind === "item" && pictureIds.has(loss.subject.id))
      .length,
    0,
  );
  for (const view of origin.views) {
    assert.equal(
      cut.editorial_profile_extension.losses.filter((loss) =>
        loss.subject.kind === "item"
        && loss.subject.id === view.itemId
        && (loss.code === "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED"
          || loss.code === "CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED"))
        .length,
      2,
    );
  }
});

test("processed insert/overwrite exports exact native placement while refusing graph, fade, and shared-clock reconstruction per view", () => {
  const exported = exportCutTimelineToOtio(
    compile(placedProcessedTimelineSource),
  );
  const cut = cutMetadata(exported.timeline);
  const origin = cut.editorial_profile_extension.audioOrigins[0];
  assert.equal(exported.report.status, "lossy-editorial");
  assert.equal(origin.kind, "processed-audio");
  assert.equal(origin.timelineEditPlanId, "processed-placement");
  assert.equal(origin.timelineEditOriginId, "processed-source");
  assert.deepEqual(origin.fadeIn, { numerator: "1", denominator: "100" });
  assert.deepEqual(origin.fadeOut, { numerator: "1", denominator: "100" });
  assert.deepEqual(
    origin.views.map((view) => view.itemId),
    ["processed-source", "inserted-processed", "overwritten-processed"],
  );

  const track = cut.editorial_profile.tracks.find((item) =>
    item.id === "dialogue");
  assert.ok(track);
  const exact = origin.views.map((view) => {
    const item = track.items.find((candidate) =>
      candidate.id === view.itemId);
    assert.ok(item?.kind === "clip");
    return {
      id: view.itemId,
      source: item.source,
      destination: item.destination,
      retime: item.retime,
      role: item.role,
      metadata: item.metadata,
      lineageOriginId: origin.lineageSegments.find((segment) =>
        segment.segmentId === view.segmentId)?.originId,
    };
  });
  assert.deepEqual(exact, [
    {
      id: "processed-source",
      source: {
        start: { numerator: "0", denominator: "1" },
        duration: { numerator: "1", denominator: "20" },
      },
      destination: {
        start: { numerator: "0", denominator: "1" },
        duration: { numerator: "1", denominator: "10" },
      },
      retime: {
        kind: "constant",
        direction: "forward",
        rate: { numerator: "1", denominator: "2" },
      },
      role: "dialogue",
      metadata: { "org.example.item": "source" },
      lineageOriginId: "processed-source",
    },
    {
      id: "inserted-processed",
      source: {
        start: { numerator: "0", denominator: "1" },
        duration: { numerator: "1", denominator: "20" },
      },
      destination: {
        start: { numerator: "1", denominator: "10" },
        duration: { numerator: "1", denominator: "10" },
      },
      retime: {
        kind: "constant",
        direction: "forward",
        rate: { numerator: "1", denominator: "2" },
      },
      role: "dialogue",
      metadata: {
        "org.example.item": "source",
        "org.example.placement": "insert",
      },
      lineageOriginId: "inserted-processed",
    },
    {
      id: "overwritten-processed",
      source: {
        start: { numerator: "0", denominator: "1" },
        duration: { numerator: "1", denominator: "20" },
      },
      destination: {
        start: { numerator: "3", denominator: "10" },
        duration: { numerator: "1", denominator: "10" },
      },
      retime: {
        kind: "constant",
        direction: "forward",
        rate: { numerator: "1", denominator: "2" },
      },
      role: "dialogue",
      metadata: {
        "org.example.item": "source",
        "org.example.placement": "overwrite",
      },
      lineageOriginId: "overwritten-processed",
    },
  ]);

  const lossIds = new Set(origin.views.map((view) => view.itemId));
  for (const [code, target] of [
    ["CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED", "cut-roundtrip"],
    ["CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED", "generic-otio"],
  ] as const) {
    const losses = cut.editorial_profile_extension.losses.filter((loss) =>
      loss.code === code && loss.target.kind === target);
    assert.deepEqual(
      new Set(losses.map((loss) => loss.subject.id)),
      lossIds,
    );
    assert.equal(losses.length, lossIds.size);
    assert.ok(losses.every((loss) =>
      /processor graph/u.test(loss.message)
      && /fade/u.test(loss.message)
      && /origin clock|origin-clock/u.test(loss.message)));
  }

  assert.throws(
    () => importOtioTimeline(JSON.stringify(exported.timeline)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_LOSSY_REFUSED"
      && /^\$\.metadata\.cut\.editorial_profile\.losses\[\d+\]$/u
        .test(error.path),
  );
  const imported = importOtioTimeline(
    JSON.stringify(exported.timeline),
    { allowLossy: true },
  );
  const placementLosses = imported.report.losses.filter((loss) =>
    loss.code === "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED");
  assert.deepEqual(
    new Set(placementLosses.map((loss) => {
      const subject = "subject" in loss ? loss.subject : undefined;
      assert.ok(subject && typeof subject === "object" && "id" in subject
        && typeof subject.id === "string");
      return subject.id;
    })),
    lossIds,
  );
  assert.ok(placementLosses.every((loss) =>
    /^[$]\.metadata\.cut\.editorial_profile_extension\.losses\[\d+\]$/u
      .test(loss.path)));
  assert.doesNotMatch(imported.source, /\b(?:Gain|TimelineEdit)\(/u);
  assert.equal((imported.source.match(/\bTimeStretch\(/gu) ?? []).length, 3);

  const reexported = exportCutTimelineToOtio(compile(imported.source));
  assert.equal(reexported.report.status, "lossy-editorial");
  assert.equal(
    Object.hasOwn(
      reexported.timeline.metadata.cut as Record<string, unknown>,
      "editorial_profile_extension",
    ),
    false,
  );
  assert.ok(reexported.report.unsupportedSemantics.some((issue) =>
    issue.code === "CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED"));
  assert.ok(reexported.report.unsupportedSemantics.some((issue) =>
    issue.code === "CUT_OTIO_AUDIO_REGION_RETIME_UNSUPPORTED"));

  const nativeRetime = mutate(exported.timeline);
  const nativeTracks = (nativeRetime.tracks as unknown as {
    children: Array<{
      children: Array<{
        metadata?: { cut?: { editorial_item_id?: string } };
        effects?: Array<{ time_scalar: number }>;
      }>;
    }>;
  }).children;
  const inserted = nativeTracks
    .flatMap((nativeTrack) => nativeTrack.children)
    .find((item) =>
      item.metadata?.cut?.editorial_item_id === "inserted-processed");
  assert.ok(inserted);
  assert.equal(inserted.effects?.length, 1);
  inserted.effects![0]!.time_scalar = 1;
  importProfileError(
    nativeRetime,
    /\$\.tracks\.children\[\d+\]\.children\[\d+\]\.effects\[0\]\.time_scalar/u,
  );
});

test("in-origin faded direct slide exports exact residual clocks and truthful target-scoped fade loss", () => {
  const first = exportCutTimelineToOtio(compile(fadedDirectSlideSource));
  const repeated = exportCutTimelineToOtio(compile(fadedDirectSlideSource));
  const cut = cutMetadata(first.timeline);
  const repeatedCut = cutMetadata(repeated.timeline);
  assert.deepEqual(
    cut.editorial_profile_extension,
    repeatedCut.editorial_profile_extension,
  );
  assert.equal(
    cut.editorial_profile_extension.semanticSha256,
    repeatedCut.editorial_profile_extension.semanticSha256,
  );
  assert.equal(first.report.status, "lossy-editorial");

  assert.equal(cut.editorial_profile_extension.audioOrigins.length, 1);
  const origin = cut.editorial_profile_extension.audioOrigins[0];
  assert.equal(origin.kind, "direct-audio");
  assert.equal(origin.timelineEditPlanId, "split-slide-faded-line");
  assert.equal(origin.timelineEditOriginId, "line");
  assert.deepEqual(origin.source, {
    start: { numerator: "0", denominator: "1" },
    duration: { numerator: "3", denominator: "50" },
  });
  assert.deepEqual(origin.originDuration, {
    numerator: "3",
    denominator: "50",
  });
  assert.deepEqual(origin.rate, { numerator: "1", denominator: "1" });
  assert.deepEqual(origin.fadeIn, { numerator: "3", denominator: "500" });
  assert.deepEqual(origin.fadeOut, { numerator: "3", denominator: "500" });
  assert.deepEqual(
    origin.views.map((view) => ({
      source: view.source,
      destination: view.destination,
      handles: view.handles,
      sliceOffset: view.sliceOffset,
    })),
    [
      {
        source: {
          start: { numerator: "0", denominator: "1" },
          duration: { numerator: "3", denominator: "125" },
        },
        destination: {
          start: { numerator: "0", denominator: "1" },
          duration: { numerator: "3", denominator: "125" },
        },
        handles: {
          head: { numerator: "0", denominator: "1" },
          tail: { numerator: "9", denominator: "250" },
        },
        sliceOffset: { numerator: "0", denominator: "1" },
      },
      {
        source: {
          start: { numerator: "1", denominator: "50" },
          duration: { numerator: "1", denominator: "50" },
        },
        destination: {
          start: { numerator: "3", denominator: "125" },
          duration: { numerator: "1", denominator: "50" },
        },
        handles: {
          head: { numerator: "1", denominator: "50" },
          tail: { numerator: "1", denominator: "50" },
        },
        sliceOffset: { numerator: "1", denominator: "50" },
      },
      {
        source: {
          start: { numerator: "11", denominator: "250" },
          duration: { numerator: "2", denominator: "125" },
        },
        destination: {
          start: { numerator: "11", denominator: "250" },
          duration: { numerator: "2", denominator: "125" },
        },
        handles: {
          head: { numerator: "11", denominator: "250" },
          tail: { numerator: "0", denominator: "1" },
        },
        sliceOffset: { numerator: "11", denominator: "250" },
      },
    ],
  );
  assert.ok(origin.views.every((view) => view.role === undefined));
  assert.equal(origin.lineageSegments.length, 7);
  const lineage = new Map(origin.lineageSegments.map((segment) => [
    segment.segmentId,
    segment,
  ]));
  assert.equal(
    origin.lineageSegments.filter((segment) => segment.parentSegmentId === undefined).length,
    1,
  );
  for (const view of origin.views) {
    const segment = lineage.get(view.segmentId);
    assert.ok(segment);
    assert.equal(view.lineageSha256, segment.lineageSha256);
    let current = segment;
    while (current.parentSegmentId !== undefined) {
      const parent = lineage.get(current.parentSegmentId);
      assert.ok(parent);
      current = parent;
    }
  }

  const viewIds = new Set(origin.views.map((view) => view.itemId));
  for (const target of ["cut-roundtrip", "generic-otio"] as const) {
    const losses = cut.editorial_profile.losses.filter((loss) =>
      loss.code === "CUT_OTIO_AUDIO_FADE_UNSUPPORTED"
      && loss.target.kind === target);
    assert.equal(losses.length, 3);
    assert.deepEqual(new Set(losses.map((loss) => loss.subject.id)), viewIds);
  }
  assert.equal(
    cut.editorial_profile.losses.some((loss) =>
      loss.code.includes("AVAILABLE_HANDLE")),
    false,
    "split-created in-origin slack must not be reported as external handle authority",
  );
  assert.throws(
    () => importOtioTimeline(JSON.stringify(first.timeline)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_LOSSY_REFUSED",
  );
  const imported = importOtioTimeline(
    JSON.stringify(first.timeline),
    { allowLossy: true },
  );
  const importedFadeLosses = imported.report.losses.filter((loss) =>
    loss.code === "CUT_OTIO_AUDIO_FADE_UNSUPPORTED");
  assert.equal(importedFadeLosses.length, 3);
  assert.deepEqual(
    new Set(importedFadeLosses.map((loss) => {
      const subject = "subject" in loss ? loss.subject : undefined;
      assert.ok(subject && typeof subject === "object" && "id" in subject
        && typeof subject.id === "string");
      return subject.id;
    })),
    viewIds,
  );
  assert.doesNotMatch(imported.source, /\b(?:TimelineEdit|fadeIn|fadeOut)\b/u);
});

test("in-origin 0.5x processed boundary exports exact residual clocks and truthful graph, fade, and retime loss", () => {
  const first = exportCutTimelineToOtio(compile(processedRetimedBoundarySource));
  const repeated = exportCutTimelineToOtio(compile(processedRetimedBoundarySource));
  const cut = cutMetadata(first.timeline);
  const repeatedCut = cutMetadata(repeated.timeline);
  assert.deepEqual(
    cut.editorial_profile_extension,
    repeatedCut.editorial_profile_extension,
  );
  assert.equal(
    cut.editorial_profile_extension.semanticSha256,
    repeatedCut.editorial_profile_extension.semanticSha256,
  );
  assert.equal(first.report.status, "lossy-editorial");

  assert.equal(cut.editorial_profile_extension.audioOrigins.length, 1);
  const origin = cut.editorial_profile_extension.audioOrigins[0];
  assert.equal(origin.kind, "processed-audio");
  assert.equal(origin.timelineEditPlanId, "split-boundary-retimed-line");
  assert.equal(origin.timelineEditOriginId, "slow-line");
  assert.deepEqual(origin.source, {
    start: { numerator: "1", denominator: "10" },
    duration: { numerator: "3", denominator: "50" },
  });
  assert.deepEqual(origin.originDuration, {
    numerator: "3",
    denominator: "25",
  });
  assert.deepEqual(origin.rate, { numerator: "1", denominator: "2" });
  assert.deepEqual(origin.fadeIn, { numerator: "3", denominator: "250" });
  assert.deepEqual(origin.fadeOut, { numerator: "3", denominator: "250" });
  assert.ok(origin.processorNodeIds.length >= 3);
  assert.match(origin.processorGraphSemanticSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    origin.views.map((view) => ({
      source: view.source,
      destination: view.destination,
      handles: view.handles,
      sliceOffset: view.sliceOffset,
      role: view.role,
    })),
    [
      {
        source: {
          start: { numerator: "1", denominator: "10" },
          duration: { numerator: "9", denominator: "250" },
        },
        destination: {
          start: { numerator: "0", denominator: "1" },
          duration: { numerator: "9", denominator: "125" },
        },
        handles: {
          head: { numerator: "0", denominator: "1" },
          tail: { numerator: "3", denominator: "125" },
        },
        sliceOffset: { numerator: "0", denominator: "1" },
        role: "dialogue",
      },
      {
        source: {
          start: { numerator: "17", denominator: "125" },
          duration: { numerator: "3", denominator: "125" },
        },
        destination: {
          start: { numerator: "9", denominator: "125" },
          duration: { numerator: "6", denominator: "125" },
        },
        handles: {
          head: { numerator: "9", denominator: "250" },
          tail: { numerator: "0", denominator: "1" },
        },
        sliceOffset: { numerator: "9", denominator: "125" },
        role: "dialogue",
      },
    ],
  );
  assert.equal(origin.lineageSegments.length, 5);
  const lineage = new Map(origin.lineageSegments.map((segment) => [
    segment.segmentId,
    segment,
  ]));
  assert.equal(
    origin.lineageSegments.filter((segment) => segment.parentSegmentId === undefined).length,
    1,
  );
  for (const view of origin.views) {
    const segment = lineage.get(view.segmentId);
    assert.ok(segment);
    assert.equal(view.lineageSha256, segment.lineageSha256);
    assert.deepEqual(segment.source, view.source);
    assert.deepEqual(segment.destination, view.destination);
    assert.deepEqual(segment.handles, view.handles);
  }

  const track = cut.editorial_profile.tracks.find((candidate) =>
    candidate.id === "dialogue");
  assert.ok(track);
  const viewIds = new Set(origin.views.map((view) => view.itemId));
  const items = track.items.filter((item) =>
    item.kind === "clip" && viewIds.has(item.id));
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.kind === "clip"
    && item.retime.kind === "constant"
    && item.retime.direction === "forward"
    && item.retime.rate.numerator === "1"
    && item.retime.rate.denominator === "2"));

  for (const [losses, code, target] of [
    [cut.editorial_profile.losses, "CUT_OTIO_AUDIO_FADE_UNSUPPORTED", "cut-roundtrip"],
    [cut.editorial_profile.losses, "CUT_OTIO_AUDIO_FADE_UNSUPPORTED", "generic-otio"],
    [cut.editorial_profile.losses, "CUT_OTIO_RETIME_METADATA_REQUIRED", "generic-otio"],
    [cut.editorial_profile_extension.losses, "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED", "cut-roundtrip"],
    [cut.editorial_profile_extension.losses, "CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED", "generic-otio"],
  ] as const) {
    const matching = losses.filter((loss) =>
      loss.code === code && loss.target.kind === target);
    assert.equal(matching.length, 2, `${code}:${target}`);
    assert.deepEqual(
      new Set(matching.map((loss) => loss.subject.id)),
      viewIds,
      `${code}:${target}`,
    );
  }
  assert.equal(
    cut.editorial_profile.losses.some((loss) =>
      loss.code.includes("AVAILABLE_HANDLE")),
    false,
    "split-created in-origin slack must not be reported as external handle authority",
  );
  assert.throws(
    () => importOtioTimeline(JSON.stringify(first.timeline)),
    (error) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_LOSSY_REFUSED",
  );
  const imported = importOtioTimeline(
    JSON.stringify(first.timeline),
    { allowLossy: true },
  );
  for (const code of [
    "CUT_OTIO_AUDIO_FADE_UNSUPPORTED",
    "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED",
  ]) {
    const matching = imported.report.losses.filter((loss) => loss.code === code);
    assert.equal(matching.length, 2, code);
    assert.deepEqual(
      new Set(matching.map((loss) => {
        const subject = "subject" in loss ? loss.subject : undefined;
        assert.ok(subject && typeof subject === "object" && "id" in subject
          && typeof subject.id === "string");
        return subject.id;
      })),
      viewIds,
      code,
    );
  }
  assert.doesNotMatch(imported.source, /\b(?:Gain|HighPass|TimelineEdit)\b/u);
  assert.equal((imported.source.match(/\bTimeStretch\(/gu) ?? []).length, 2);
});

test("V3 importer refuses absent base and hostile authority, clock, lineage, or native-profile mutations", () => {
  const exported = exportCutTimelineToOtio(compile(processedTimelineSource));

  const withoutBase = mutate(exported.timeline);
  delete (withoutBase.metadata.cut as Record<string, unknown>).editorial_profile;
  importProfileError(withoutBase, /editorial_profile_extension$/u);

  const authority = mutate(exported.timeline);
  mutableCutMetadata(authority).editorial_profile_extension.audioOrigins[0]
    .graphAuthorityId = "forged_graph";
  importProfileError(authority, /semanticSha256$/u);

  const clock = mutate(exported.timeline);
  mutableCutMetadata(clock).editorial_profile_extension.audioOrigins[0]
    .views[1].sliceOffset = { numerator: "9", denominator: "1000" };
  importProfileError(clock, /audioOrigins\[0\]\.views\[1\]/u);

  const lineage = mutate(exported.timeline);
  mutableCutMetadata(lineage).editorial_profile_extension.audioOrigins[0]
    .views[1].lineageSha256 = "0".repeat(64);
  importProfileError(lineage, /audioOrigins\[0\]\.views\[1\]/u);

  const base = mutate(exported.timeline);
  mutableCutMetadata(base).editorial_profile.semanticSha256 = "0".repeat(64);
  importProfileError(base, /editorial_profile\.semanticSha256$/u);
});
