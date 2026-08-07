import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import {
  compileCutModule,
  CutCompileError,
  type CutCompileInputs,
} from "../lib/language/compiler";
import {
  CutAvIrValidationError,
  validateCutAvIr,
} from "../lib/language/ir-loader";
import type { CutAVIR, IREditorial, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
} from "../lib/runtime/reference/audio-cache";
import { referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import {
  executeTimelineEditPlan,
  type TimelineEditItemV1,
  type TimelineEditTrackV1,
} from "../lib/language/timeline-edit-operations";
import { validateReferenceTimelineEditMaterializations } from "../lib/runtime/reference/timeline-edit";
import { referenceTranscriptCaptionConfig } from "../lib/runtime/reference/caption-render";

const audioDigest = "9".repeat(64);
type EditorialTrackNode = IRNode & {
  editorial: Extract<IREditorial, { kind: "picture-track" | "audio-track" }>;
};

function sidecar() {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: audioDigest,
      audioStreamIndex: 2,
      audioSampleRate: 48_000,
      duration: rational(8),
    },
    words: [
      {
        id: "quote.1",
        start: rational(1),
        end: rational(2),
        text: "Canonical",
        join: "none",
      },
      {
        id: "quote.2",
        start: rational(2),
        end: rational(3),
        text: "edits.",
        join: "space",
      },
      {
        id: "quote.3",
        start: rational(3),
        end: rational(4),
        text: "Now.",
        join: "space",
      },
    ],
  });
}

const source = `cut 0.4;
project "transcript canonical TimelineEdit";
import {
  AudioGap, AudioTrack, Gap, PictureTrack, Sequence,
  TimelineEdit, TranscriptAudio, TranscriptPicture,
  avTime, editSelection, editSplit, transcriptEdit, transcriptMedia
} from "@cut/edit";
import { TranscriptCaptions } from "cut:visual";

asset words: DataAsset = data("assets/quote.transcript.json");
asset voice: AudioAsset = audio("assets/recorder.wav", stream: 2);
asset camera: VideoAsset = video("assets/camera.mkv", videoStream: 1);
asset spare: VideoAsset = video("assets/spare.mkv", videoStream: 1);
asset face: FontAsset = font("assets/face.ttf");

timeline main(duration: 4s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene answer(duration: 4s) {
    let sync: TranscriptMediaAuthority = transcriptMedia(
      transcript: words,
      audio: voice,
      audioStream: 2,
      video: camera,
      videoStream: 1,
      videoFrameRate: 24,
      videoDuration: 8s,
      audioAt: 0s,
      videoAt: 0s,
      videoRate: 1
    );
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "quote.1",
      through: "quote.2",
      at: 1s,
      link: "quote-av",
      media: sync
    );
    Sequence(duration: 4s) {
      PictureTrack(trackId: "v-dialogue") {
        Gap(duration: 1s);
        TranscriptPicture(edit: quote, source: camera, duration: 2s, rate: 1);
        Gap(duration: 1s);
      }
    }
    AudioTrack(trackId: "a-dialogue") {
      AudioGap(destination: 0s ..< 1s);
      TranscriptAudio(edit: quote);
      AudioGap(destination: 3s ..< 4s);
    }
    TranscriptCaptions(edit: quote, font: face, maxWords: 1, position: "bottom");
    TimelineEdit(id: "transcript-split", operations: [
      editSplit(
        selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
        at: avTime(picture: 2s, audio: 2s)
      )
    ]);
  }
}
export out = render(main);`;

const splitOperation = `editSplit(
        selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
        at: avTime(picture: 2s, audio: 2s)
      )`;

function sourceWithTranscriptOperation(
  operationImport: "editTrim" | "editRippleDelete",
  operation: string,
) {
  return source
    .replace(
      "avTime, editSelection, editSplit, transcriptEdit",
      `avTime, editSelection, ${operationImport}, editSplit, transcriptEdit`,
    )
    .replace(splitOperation, operation);
}

function moduleFor(text: string) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return parsed.module;
}

function compile(text = source) {
  const inputs: CutCompileInputs = {
    transcriptSidecars: new Map([["words", sidecar()]]),
  };
  return compileCutModule(
    moduleFor(text),
    {},
    undefined,
    undefined,
    inputs,
  ).ir;
}

function pictureCacheKey(ir: CutAVIR) {
  const candidate = structuredClone(ir);
  const composition = candidate.compositions[0]!;
  const result = createIncrementalRenderPlan(candidate, composition.id);
  assert.equal(result.scenes.length, 1);
  return result.scenes[0]!.key;
}

function audioCacheIdentity(ir: CutAVIR) {
  const candidate = structuredClone(ir);
  for (const resource of Object.values(candidate.resources)) {
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
  const composition = candidate.compositions[0]!;
  const plan = createReferenceAudioCachePlan(
    candidate,
    composition,
    referenceMasterAudioRootIds(candidate, composition),
    createReferenceAudioToolchainIdentity("ffmpeg version transcript-timeline-edit-cache-locality"),
  );
  return Object.freeze({ key: plan.key, graphSha256: plan.graph.sha256 });
}

function track<T extends "picture-track" | "audio-track">(
  ir: CutAVIR,
  kind: T,
) {
  const result = Object.values(ir.nodes).find(
    (node): node is IRNode & { editorial: Extract<IREditorial, { kind: T }> } =>
      node.editorial?.kind === kind,
  );
  assert.ok(result);
  return result;
}

function transcriptChildren(
  ir: CutAVIR,
  owner: EditorialTrackNode,
) {
  return owner.children
    .map((id: string) => ir.nodes[id]!)
    .filter((node: IRNode) => node.inputs.transcriptBindingId !== undefined);
}

function inputString(node: IRNode, name: string) {
  const value = node.inputs[name];
  assert.ok(value?.kind === "string", `${name} must be one String input`);
  return value.value;
}

function diagnostic(text: string, code: string) {
  assert.throws(
    () => compile(text),
    (error: unknown) => {
      assert.ok(error instanceof CutCompileError, String(error));
      const found = error.result.diagnostics.find((item) => item.code === code);
      assert.ok(found, JSON.stringify(error.result.diagnostics));
      assert.ok(found.span.start.offset < found.span.end.offset);
      return true;
    },
  );
}

test("EDT-09: transcript picture/audio use one canonical linked TimelineEdit split and runtime replay", () => {
  const first = compile();
  const repeated = compile();
  assert.equal(first.timelineEdits?.length, 1);
  assert.equal(
    stableJsonStringify(first.timelineEdits),
    stableJsonStringify(repeated.timelineEdits),
  );

  const plan = first.timelineEdits![0]!;
  const execution = executeTimelineEditPlan(plan);
  assert.equal(plan.id, "transcript-split");
  assert.deepEqual(plan.tracks.map((item) => item.trackId), [
    "v-dialogue",
    "a-dialogue",
  ]);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]?.kind, "split");
  assert.match(execution.materializationId, /^[0-9a-f]{64}$/u);

  const picture = track(first, "picture-track");
  const audio = track(first, "audio-track");
  const pictures = transcriptChildren(first, picture);
  const audios = transcriptChildren(first, audio);
  assert.equal(pictures.length, 2);
  assert.equal(audios.length, 2);

  assert.deepEqual(pictures.map((node) => node.interval), [
    { start: rational(1), duration: rational(1) },
    { start: rational(2), duration: rational(1) },
  ]);
  assert.deepEqual(
    picture.editorial.items.filter((item) => item.kind === "picture")
      .map((item) => item.source),
    [
      { start: rational(1), duration: rational(1) },
      { start: rational(2), duration: rational(1) },
    ],
  );
  assert.equal(new Set(pictures.map((node: IRNode) =>
    inputString(node, "transcriptPictureOriginIdentity"))).size, 1);
  assert.equal(new Set(pictures.map((node: IRNode) =>
    inputString(node, "transcriptPictureSegmentIdentity"))).size, 2);

  assert.deepEqual(audios.map((node) => node.interval), [
    { start: rational(1), duration: rational(1) },
    { start: rational(2), duration: rational(1) },
  ]);
  assert.deepEqual(
    audio.editorial.items.filter((item) => item.kind === "audio")
      .map((item) => item.source),
    [
      { start: rational(1), duration: rational(1) },
      { start: rational(2), duration: rational(1) },
    ],
  );
  assert.ok([...pictures, ...audios].every((node: IRNode) =>
    inputString(node, "transcriptBindingId")
      === inputString(pictures[0]!, "transcriptBindingId")));
  assert.ok([
    ...picture.editorial.items.filter((item) => item.kind === "picture"),
    ...audio.editorial.items.filter((item) => item.kind === "audio"),
  ].every((item) => item.linkId === "quote-av"));

  for (const resultTrack of execution.tracks) {
    const selected = resultTrack.items.filter((item) =>
      item.sourceView.kind !== "gap");
    assert.equal(selected.length, 2);
    assert.equal(new Set(selected.map((item) => item.originId)).size, 1);
    assert.equal(new Set(selected.map((item) => item.segmentId)).size, 2);
    assert.ok(selected.every((item) => item.parentSegmentId !== undefined));
  }

  assert.doesNotThrow(() => validateCutAvIr(structuredClone(first)));
  const forgedSegmentIdentity = structuredClone(first);
  const forgedPicture = transcriptChildren(
    forgedSegmentIdentity,
    track(forgedSegmentIdentity, "picture-track"),
  )[0]!;
  forgedPicture.inputs.transcriptPictureSegmentIdentity = {
    kind: "string",
    value: "0".repeat(64),
  };
  assert.throws(
    () => validateCutAvIr(forgedSegmentIdentity),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_HASH"
      && /transcriptPictureSegmentIdentity/u.test(error.path),
  );
  const runtime = validateReferenceTimelineEditMaterializations(first);
  assert.equal(runtime.plans.length, 1);
  assert.equal(runtime.plans[0]!.materializationId, execution.materializationId);
  assert.deepEqual(
    runtime.plans[0]!.trackBindings.map((item) =>
      [item.trackId, item.domain, item.items, item.transitions]),
    [
      ["v-dialogue", "picture", 4, 0],
      ["a-dialogue", "audio", 4, 0],
    ],
  );

  const forgedAudioHandle = structuredClone(first);
  const forgedAudio = transcriptChildren(
    forgedAudioHandle,
    track(forgedAudioHandle, "audio-track"),
  )[0]!;
  forgedAudio.inputs.tailHandle = {
    kind: "quantity",
    dimension: "time",
    magnitude: rational(1, 2),
    unit: "s",
  };
  finalizeGraphHashes(forgedAudioHandle);
  assert.throws(
    () => validateCutAvIr(forgedAudioHandle),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_IDENTITY"
      && /\.inputs\.tailHandle$/u.test(error.path),
  );

  const forgedCaptionProjection = structuredClone(first);
  const caption = Object.values(forgedCaptionProjection.nodes).find((node) =>
    node.op === "cut.visual.transcript_captions");
  assert.ok(caption);
  caption.inputs.transcriptCaptionIdentity = {
    kind: "string",
    value: "f".repeat(64),
  };
  finalizeGraphHashes(forgedCaptionProjection);
  assert.throws(
    () => validateCutAvIr(forgedCaptionProjection),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_HASH"
      && /\.inputs\.transcriptCaptionIdentity\.value$/u.test(error.path),
  );
});

test("EDT-09: transcript word lineage survives canonical linked trim and ripple materialization", () => {
  const trimSource = sourceWithTranscriptOperation(
    "editTrim",
    `editTrim(
        selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
        keep: 1s ..< 2s
      )`,
  );
  const rippleSource = sourceWithTranscriptOperation(
    "editRippleDelete",
    `editRippleDelete(
        selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
        range: 2s ..< 3s
      )`,
  );
  const trimIr = compile(trimSource);
  const trimRepeat = compile(trimSource);
  const rippleIr = compile(rippleSource);
  const rippleRepeat = compile(rippleSource);
  const materializationIds = new Map<string, string>();

  for (const [label, ir, repeated, operationKind] of [
    ["trim", trimIr, trimRepeat, "trim"],
    ["ripple", rippleIr, rippleRepeat, "ripple-delete"],
  ] as const) {
    assert.equal(ir.timelineEdits?.length, 1, label);
    assert.equal(ir.timelineEdits![0]!.operations[0]!.kind, operationKind, label);
    assert.equal(
      stableJsonStringify(ir.timelineEdits),
      stableJsonStringify(repeated.timelineEdits),
      `${label} canonical plan must repeat byte-for-data`,
    );
    const execution = executeTimelineEditPlan(ir.timelineEdits![0]!);
    materializationIds.set(label, execution.materializationId);
    const receipt = validateReferenceTimelineEditMaterializations(ir);
    assert.equal(receipt.plans[0]!.materializationId, execution.materializationId, label);
    assert.doesNotThrow(() => validateCutAvIr(structuredClone(ir)), label);

    const binding = ir.transcriptBindings?.[0];
    assert.ok(binding, label);
    assert.deepEqual(binding.words.map((word) => word.id), ["quote.1", "quote.2"], label);
    assert.equal(binding.selectedWordCount, 2, label);
    const captionNode = Object.values(ir.nodes).find((node) =>
      node.op === "cut.visual.transcript_captions");
    assert.ok(captionNode, label);
    const caption = referenceTranscriptCaptionConfig(
      captionNode,
      ir,
      ir.compositions[0]!,
    );
    assert.ok(caption, label);
    assert.deepEqual(caption.track.cues.map((cue) => ({
      start: cue.start,
      end: cue.end,
      lines: cue.lines,
    })), [{
      start: rational(1),
      end: rational(2),
      lines: ["Canonical"],
    }], `${label}: captions must consume the retained canonical word lineage`);

    for (const kind of ["picture-track", "audio-track"] as const) {
      const owner = track(ir, kind);
      const selected = transcriptChildren(ir, owner);
      assert.equal(selected.length, 1, `${label}:${kind}`);
      assert.deepEqual(selected[0]!.interval, {
        start: rational(1),
        duration: rational(1),
      }, `${label}:${kind}`);
      assert.equal(
        inputString(selected[0]!, "transcriptBindingId"),
        binding.id,
        `${label}:${kind}`,
      );
      const editorial = owner.editorial.items.find((item) =>
        item.nodeId === selected[0]!.id);
      assert.ok(editorial?.source, `${label}:${kind}`);
      assert.deepEqual(editorial.source, {
        start: rational(1),
        duration: rational(1),
      }, `${label}:${kind}`);

      const materialized = execution.tracks
        .find((result) => result.trackId === owner.editorial.trackId)!;
      const media = materialized.items.filter((item) =>
        item.sourceView.kind !== "gap");
      assert.equal(media.length, 1, `${label}:${kind}`);
      const base: TimelineEditTrackV1 = ir.timelineEdits![0]!.tracks
        .find((candidate) => candidate.trackId === owner.editorial.trackId)!;
      const baseMedia: TimelineEditItemV1 | undefined = base.items.find(
        (item: TimelineEditItemV1) => item.sourceView.kind !== "gap",
      );
      assert.ok(baseMedia, `${label}:${kind}`);
      assert.equal(
        media[0]!.originId,
        baseMedia.originId,
        `${label}:${kind} must retain its frozen transcript origin`,
      );
      assert.ok(media[0]!.parentSegmentId, `${label}:${kind}`);
      assert.deepEqual(media[0]!.sourceView.kind === "gap"
        ? undefined
        : media[0]!.sourceView.source, {
        start: rational(1),
        duration: rational(1),
      }, `${label}:${kind}`);
    }
  }

  assert.notEqual(
    materializationIds.get("trim"),
    materializationIds.get("ripple"),
    "trim and ripple-delete must remain distinct canonical/cache identities",
  );
});

test("EDT-09: transcript TimelineEdit refuses a trim that splits one locked word", () => {
  const partialWord = sourceWithTranscriptOperation(
    "editTrim",
    `editTrim(
        selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
        keep: 1s ..< (3s / 2)
      )`,
  );
  diagnostic(partialWord, "CUT_TRANSCRIPT_TIMELINE_CAPTION");
});

test("EDT-09: a selected-word mutation invalidates picture and PCM cache identities while provenance stays nonsemantic", () => {
  const trimSource = sourceWithTranscriptOperation(
    "editTrim",
    `editTrim(
        selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
        keep: 1s ..< 2s
      )`,
  );
  const before = compile(trimSource);
  const repeated = compile(trimSource);
  const changedSource = trimSource
    .replace('from: "quote.1"', 'from: "quote.2"')
    .replace('through: "quote.2"', 'through: "quote.3"');
  const changed = compile(changedSource);
  const changedRepeat = compile(changedSource);
  assert.deepEqual(diffCutAVIR(before, repeated).changes, []);
  assert.deepEqual(diffCutAVIR(changed, changedRepeat).changes, []);

  const transcriptChanges = diffCutAVIR(before, changed).changes.filter(
    (entry) => entry.entity === "transcript-binding",
  );
  assert.deepEqual(
    transcriptChanges.map((entry) => entry.operation).sort(),
    ["add", "remove"],
    "selection-derived transcript identities must be replaced explicitly",
  );
  const beforeBinding = before.transcriptBindings?.[0];
  const changedBinding = changed.transcriptBindings?.[0];
  assert.ok(beforeBinding);
  assert.ok(changedBinding);
  assert.notEqual(beforeBinding.id, changedBinding.id);
  assert.deepEqual(
    [beforeBinding.from, beforeBinding.through, beforeBinding.sourceRange],
    ["quote.1", "quote.2", { start: rational(1), duration: rational(2) }],
  );
  assert.deepEqual(
    [changedBinding.from, changedBinding.through, changedBinding.sourceRange],
    ["quote.2", "quote.3", { start: rational(2), duration: rational(2) }],
  );
  const timelineChange = diffCutAVIR(before, changed).changes.find((entry) =>
    entry.entity === "timeline-edit" && entry.id === "transcript-split");
  assert.equal(timelineChange?.operation, "modify");
  assert.notEqual(pictureCacheKey(before), pictureCacheKey(changed));
  assert.notDeepEqual(audioCacheIdentity(before), audioCacheIdentity(changed));
  assert.equal(pictureCacheKey(changed), pictureCacheKey(changedRepeat));
  assert.deepEqual(audioCacheIdentity(changed), audioCacheIdentity(changedRepeat));

  const provenanceOnly = structuredClone(before);
  provenanceOnly.timelineEdits![0]!.provenance.span.start.line += 20;
  provenanceOnly.timelineEdits![0]!.provenance.span.end.line += 20;
  provenanceOnly.transcriptBindings![0]!.provenance.span.start.line += 20;
  provenanceOnly.transcriptBindings![0]!.provenance.span.end.line += 20;
  for (const ownerKind of ["picture-track", "audio-track"] as const) {
    const owner = track(provenanceOnly, ownerKind);
    owner.provenance.span.start.line += 20;
    owner.provenance.span.end.line += 20;
  }
  assert.deepEqual(diffCutAVIR(before, provenanceOnly).changes, []);
  assert.equal(pictureCacheKey(provenanceOnly), pictureCacheKey(before));
  assert.deepEqual(audioCacheIdentity(provenanceOnly), audioCacheIdentity(before));
});

test("EDT-09: transcript authority refuses cross-file picture and non-split source retime", () => {
  diagnostic(
    source.replace(
      "TranscriptPicture(edit: quote, source: camera",
      "TranscriptPicture(edit: quote, source: spare",
    ),
    "CUT_TRANSCRIPT_MEDIA",
  );

  const slip = source
    .replace(
      "avTime, editSelection, editSplit, transcriptEdit",
      "avTime, editSelection, editSlip, editSplit, transcriptEdit",
    )
    .replace(
      `editSplit(
        selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
        at: avTime(picture: 2s, audio: 2s)
      )`,
      `editSlip(
        selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
        range: 1s ..< 3s,
        by: avTime(picture: 0s, audio: 0s)
      )`,
    );
  diagnostic(slip, "CUT_TIMELINE_EDIT_UNSUPPORTED");
});
