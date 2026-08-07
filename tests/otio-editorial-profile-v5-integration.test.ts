import assert from "node:assert/strict";
import test from "node:test";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import {
  CutOtioImportError,
  importOtioTimeline,
} from "../lib/interchange/otio-import";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRResource } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";

const source = `cut 0.4;
project "OTIO direct media V5 integration";
import {
  AudioTrack,
  PictureClip,
  PictureTrack,
  Sequence,
  audioCrossfadeAt,
  editorialMetadata,
  editorialMetadataEntry,
  transitionAt
} from "@cut/edit";
import { AudioClip } from "@cut/audio";

asset picture: VideoAsset = video("media/picture.mov");
asset voice: AudioAsset = audio("media/voice.wav");

timeline main(duration: 3s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 3s) {
    Sequence(duration: 3s) {
      PictureTrack(
        sourceDuration: 3s,
        edits: [transitionAt(at: 1500ms, duration: 500ms, kind: "cross-dissolve")],
        trackId: "picture.main",
        role: "primary",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.track", value: "picture")
        ])
      ) {
        PictureClip(
          source: picture,
          range: 500ms ..< 2s,
          duration: 1500ms,
          tailHandle: 500ms,
          editId: "picture.out",
          role: "b-roll",
          metadata: editorialMetadata(entries: [
            editorialMetadataEntry(key: "org.example.item", value: "picture-out")
          ])
        );
        PictureClip(
          source: picture,
          range: 3s ..< 4500ms,
          duration: 1500ms,
          headHandle: 500ms,
          editId: "picture.in",
          role: "primary"
        );
      }
    }
    AudioTrack(
      sourceDuration: 3s,
      edits: [audioCrossfadeAt(at: 1500ms, duration: 500ms, curve: "linear")],
      trackId: "audio.main",
      role: "dialogue",
      metadata: editorialMetadata(entries: [
        editorialMetadataEntry(key: "org.example.track", value: "dialogue")
      ])
    ) {
      AudioClip(
        source: voice,
        range: 500ms ..< 2s,
        destination: 0s ..< 1500ms,
        tailHandle: 500ms,
        editId: "audio.out",
        role: "dialogue",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(key: "org.example.item", value: "audio-out")
        ])
      );
      AudioClip(
        source: voice,
        range: 3s ..< 4500ms,
        destination: 1500ms ..< 3s,
        headHandle: 500ms,
        editId: "audio.in",
        role: "dialogue"
      );
    }
  }
}

export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

function compile(text = source) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function lockResource(resource: IRResource) {
  const picture = resource.kind === "video";
  const streamIndex = picture ? 0 : 1;
  resource.state = "locked";
  resource.sha256 = (picture ? "a" : "b").repeat(64);
  resource.metadata = {
    lockVersion: 2,
    bytes: 1024,
    probe: {
      kind: "media",
      identity: {
        streams: [picture
          ? {
              index: streamIndex,
              type: "video",
              frameRate: rational(24),
            }
          : {
              index: streamIndex,
              type: "audio",
              sampleRate: 48_000,
            }],
      },
      selected: picture
        ? {
            video: {
              streamIndex,
              duration: rational(10),
              durationSource: "decoded-video-cadence",
              timeBase: rational(1, 24),
              frameRate: rational(24),
            },
          }
        : {
            audio: {
              streamIndex,
              duration: rational(10),
              durationSource: "decoded-audio-samples",
              timeBase: rational(1, 48_000),
            },
          },
    },
  };
}

function locked(text = source) {
  const ir = compile(text);
  Object.values(ir.resources).forEach(lockResource);
  ir.determinism.semantic = "locked";
  return ir;
}

function cutMetadata(ir: CutAVIR) {
  return exportCutTimelineToOtio(ir, { compositionId: "main" });
}

function profileError(error: unknown) {
  return error instanceof CutOtioImportError
    && error.code === "CUT_OTIO_IMPORT_PROFILE";
}

test("production OTIO V5 preserves direct surplus handles, selected clocks, roles, metadata, unlinked identity, and transitions", () => {
  const first = cutMetadata(locked());
  const cut = first.timeline.metadata.cut as {
    editorial_profile: {
      semanticSha256: string;
      tracks: Array<{
        items: Array<{
          id: string;
          kind: "clip" | "gap";
          role?: string;
          metadata?: Readonly<Record<string, string>>;
        }>;
      }>;
      losses: Array<{
        code: string;
        target: { kind: string };
      }>;
    };
    editorial_profile_direct_media_extension: {
      format: string;
      version: number;
      semanticSha256: string;
      authorities: Array<{
        itemId: string;
        mediaKind: "picture" | "audio";
        clock: {
          kind: "frame" | "sample";
          streamIndex: number;
          rate: { numerator: string; denominator: string };
        };
        declaredHandles: {
          head: { numerator: string; denominator: string };
          tail: { numerator: string; denominator: string };
        };
        consumedHandles: {
          head: { numerator: string; denominator: string };
          tail: { numerator: string; denominator: string };
        };
        role?: string;
        metadata?: Readonly<Record<string, string>>;
        link: { kind: string };
        transitionIds: string[];
      }>;
    };
  };
  const extension = cut.editorial_profile_direct_media_extension;
  assert.equal(extension.format, "cut-otio-editorial-direct-media-extension");
  assert.equal(extension.version, 5);
  assert.match(extension.semanticSha256, /^[a-f0-9]{64}$/u);
  const nativeProfileClipIds = cut.editorial_profile.tracks
    .flatMap((track) => track.items)
    .filter((item) => item.kind === "clip")
    .map((item) => item.id);
  assert.deepEqual(
    extension.authorities.map((authority) => authority.itemId),
    nativeProfileClipIds,
  );
  assert.deepEqual(
    extension.authorities.map((authority) => [
      authority.mediaKind,
      authority.clock.kind,
      authority.clock.rate.numerator,
      `${authority.declaredHandles.head.numerator}/${authority.declaredHandles.head.denominator}`,
      `${authority.declaredHandles.tail.numerator}/${authority.declaredHandles.tail.denominator}`,
      `${authority.consumedHandles.head.numerator}/${authority.consumedHandles.head.denominator}`,
      `${authority.consumedHandles.tail.numerator}/${authority.consumedHandles.tail.denominator}`,
      authority.transitionIds.length,
    ]),
    [
      ["picture", "frame", "24", "0/1", "1/2", "0/1", "1/4", 1],
      ["picture", "frame", "24", "1/2", "0/1", "1/4", "0/1", 1],
      ["audio", "sample", "48000", "0/1", "1/2", "0/1", "1/4", 1],
      ["audio", "sample", "48000", "1/2", "0/1", "1/4", "0/1", 1],
    ],
  );
  const nativeProfileItems = new Map(cut.editorial_profile.tracks
    .flatMap((track) => track.items)
    .filter((item) => item.kind === "clip")
    .map((item) => [item.id, item] as const));
  for (const authority of extension.authorities) {
    const item = nativeProfileItems.get(authority.itemId);
    assert.ok(item);
    assert.equal(authority.role, item.role);
    assert.deepEqual(authority.metadata, item.metadata);
  }
  assert.ok(extension.authorities.every((authority) =>
    authority.link.kind === "unlinked"));
  assert.ok(cut.editorial_profile.losses.some((loss) =>
    loss.code === "CUT_OTIO_AVAILABLE_HANDLE_AUTHORITY_METADATA_REQUIRED"
    && loss.target.kind === "generic-otio"));
  assert.ok(!cut.editorial_profile.losses.some((loss) =>
    loss.code === "CUT_OTIO_AVAILABLE_HANDLE_AUTHORITY_METADATA_REQUIRED"
    && loss.target.kind === "cut-roundtrip"));
  assert.equal(first.report.editorialProfile?.directMediaExtension?.authorities, 4);

  const nativeAuthorities = first.timeline.tracks.children
    .flatMap((track) => track.children)
    .filter((child) => child.OTIO_SCHEMA === "Clip.2")
    .map((clip) =>
      (clip.metadata.cut as { direct_media_authority?: unknown })
        .direct_media_authority);
  assert.deepEqual(nativeAuthorities, extension.authorities);

  const imported = importOtioTimeline(JSON.stringify(first.timeline));
  assert.equal(
    imported.report.editorialProfile?.directMediaExtension?.authorities,
    4,
  );
  assert.match(
    imported.source,
    /PictureClip\([\s\S]*tailHandle: \(1s \/ 2\)/u,
  );
  assert.match(
    imported.source,
    /AudioClip\([\s\S]*headHandle: \(1s \/ 2\)/u,
  );
  const second = cutMetadata(locked(imported.source));
  const secondCut = second.timeline.metadata.cut as {
    editorial_profile_direct_media_extension: {
      semanticSha256: string;
      authorities: unknown[];
    };
  };
  assert.equal(
    secondCut.editorial_profile_direct_media_extension.semanticSha256,
    extension.semanticSha256,
  );
  assert.deepEqual(
    secondCut.editorial_profile_direct_media_extension.authorities,
    extension.authorities,
  );
});

test("V5 import refuses hash, handle, native, duplicate, orphan, and unknown-field tampering", () => {
  const exported = cutMetadata(locked());
  const mutations: Array<(timeline: typeof exported.timeline) => void> = [
    (timeline) => {
      const cut = timeline.metadata.cut as {
        editorial_profile_direct_media_extension: {
          authorities: Array<{
            resource: { sha256: string };
          }>;
        };
      };
      cut.editorial_profile_direct_media_extension.authorities[0]
        .resource.sha256 = "f".repeat(64);
    },
    (timeline) => {
      const cut = timeline.metadata.cut as {
        editorial_profile_direct_media_extension: {
          authorities: Array<{
            declaredHandles: {
              tail: { numerator: string; denominator: string };
            };
          }>;
        };
      };
      cut.editorial_profile_direct_media_extension.authorities[0]
        .declaredHandles.tail = rational(3, 4);
    },
    (timeline) => {
      const clip = timeline.tracks.children
        .flatMap((track) => track.children)
        .find((child) => child.OTIO_SCHEMA === "Clip.2");
      assert.ok(clip && clip.OTIO_SCHEMA === "Clip.2");
      delete (clip.metadata.cut as { direct_media_authority?: unknown })
        .direct_media_authority;
    },
    (timeline) => {
      const cut = timeline.metadata.cut as {
        editorial_profile_direct_media_extension: {
          authorities: unknown[];
        };
      };
      cut.editorial_profile_direct_media_extension.authorities.push(
        structuredClone(
          cut.editorial_profile_direct_media_extension.authorities[0],
        ),
      );
    },
    (timeline) => {
      const cut = timeline.metadata.cut as {
        editorial_profile_direct_media_extension: {
          authorities: Array<{ itemId: string }>;
        };
      };
      cut.editorial_profile_direct_media_extension.authorities[0].itemId =
        "orphan.item";
    },
    (timeline) => {
      const cut = timeline.metadata.cut as {
        editorial_profile_direct_media_extension: Record<string, unknown>;
      };
      cut.editorial_profile_direct_media_extension.private = true;
    },
  ];
  for (const mutate of mutations) {
    const hostile = structuredClone(exported.timeline);
    mutate(hostile);
    assert.throws(
      () => importOtioTimeline(JSON.stringify(hostile)),
      profileError,
    );
  }
});

test("V5 omission is exact for handle-free media and orphan native authority metadata is refused", () => {
  const withoutHandles = source
    .replaceAll("tailHandle: 500ms,\n", "")
    .replaceAll("headHandle: 500ms,\n", "")
    .replaceAll("sourceDuration: 3s,\n", "")
    .replace(
      "edits: [transitionAt(at: 1500ms, duration: 500ms, kind: \"cross-dissolve\")],",
      "",
    )
    .replace(
      "      edits: [audioCrossfadeAt(at: 1500ms, duration: 500ms, curve: \"linear\")],\n",
      "",
    );
  const exported = cutMetadata(locked(withoutHandles));
  const cut = exported.timeline.metadata.cut as Record<string, unknown>;
  assert.ok(!Object.hasOwn(
    cut,
    "editorial_profile_direct_media_extension",
  ));
  assert.ok(!exported.report.editorialProfile?.directMediaExtension);
  assert.ok(exported.timeline.tracks.children
    .flatMap((track) => track.children)
    .filter((child) => child.OTIO_SCHEMA === "Clip.2")
    .every((clip) => !Object.hasOwn(
      clip.metadata.cut as object,
      "direct_media_authority",
    )));

  const orphan = structuredClone(exported.timeline);
  const clip = orphan.tracks.children
    .flatMap((track) => track.children)
    .find((child) => child.OTIO_SCHEMA === "Clip.2");
  assert.ok(clip && clip.OTIO_SCHEMA === "Clip.2");
  (clip.metadata.cut as Record<string, unknown>).direct_media_authority = {};
  assert.throws(
    () => importOtioTimeline(JSON.stringify(orphan)),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_FIELD"
      && /direct_media_authority/u.test(error.path),
  );
});

test("V5 and the closed profile remain absent for mixed processed audio rather than overstating partial graph reconstruction", () => {
  const processed = source
    .replace(
      "import { AudioClip } from \"@cut/audio\";",
      "import { AudioClip, Gain } from \"@cut/audio\";",
    )
    .replace(
      /AudioClip\(\n        source: voice,\n        range: 500ms \.\.< 2s,\n        destination: 0s \.\.< 1500ms,\n        tailHandle: 500ms,\n        editId: "audio\.out",\n        role: "dialogue",\n        metadata: editorialMetadata\(entries: \[\n          editorialMetadataEntry\(key: "org\.example\.item", value: "audio-out"\)\n        \]\)\n      \);/u,
      `AudioRegion(destination: 0s ..< 1500ms, tailHandle: 500ms, editId: "audio.out", role: "dialogue") {
        Gain(amount: -3db) {
          AudioClip(source: voice, range: 500ms ..< 2s);
        }
      }`,
    )
    .replace(
      "AudioTrack,",
      "AudioRegion,\n  AudioTrack,",
    )
    .replace(
      "      edits: [audioCrossfadeAt(at: 1500ms, duration: 500ms, curve: \"linear\")],\n",
      "",
    )
    .replace(
      "AudioTrack(\n      sourceDuration: 3s,\n",
      "AudioTrack(\n",
    );
  const exported = cutMetadata(locked(processed));
  const cut = exported.timeline.metadata.cut as {
    editorial_profile?: unknown;
    editorial_profile_direct_media_extension?: {
      authorities: Array<{
        mediaKind: "picture" | "audio";
        destination: {
          start: { numerator: string; denominator: string };
        };
      }>;
    };
  };
  assert.equal(cut.editorial_profile, undefined);
  assert.equal(cut.editorial_profile_direct_media_extension, undefined);
  assert.ok(exported.report.unsupportedSemantics.some((loss) =>
    loss.code === "CUT_OTIO_EDITORIAL_PROFILE_UNAVAILABLE"));
  assert.ok(exported.report.unsupportedSemantics.some((loss) =>
    loss.code === "CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED"));
});
