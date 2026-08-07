import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type {
  CutAVIR,
  IREditorial,
  IRNode,
  IRProvenance,
  IRValue,
} from "../lib/language/ir";
import {
  timelineEditSourceAuthority,
} from "../lib/language/timeline-edit-ir-adapter";
import {
  executeTimelineEditPlan,
  type TimelineEditItemV1,
  type TimelineEditPlanV1,
  type TimelineEditTrackV1,
} from "../lib/language/timeline-edit-operations";
import { parseCutLanguage } from "../lib/language/parser";
import { validateCutAvIr } from "../lib/language/ir-loader";
import {
  addRational,
  rational,
  type Rational,
  zeroRational,
} from "../lib/language/rational";
import {
  ReferenceTimelineEditMaterializationError,
  referenceTimelineEditTrackOwnership,
  validateReferenceTimelineEditMaterializations,
} from "../lib/runtime/reference/timeline-edit";
import { validateReferencePictureTrackOperationPlan } from "../lib/runtime/reference/picture-edit-operations";
import { validateReferenceAudioTrackOperationPlan } from "../lib/runtime/reference/audio-edit-operations";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

type PictureTrackNode = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrackNode = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };

const source = `cut 0.4;
project "runtime timeline edit";
import { Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack() {
        PictureClip(source: picture, range: 1s ..< 3s, duration: 2s, link: "take_left");
        PictureClip(source: picture, range: 3s ..< 5s, duration: 2s, link: "take_right");
      }
    }
    AudioTrack() {
      AudioClip(source: voice, range: 1s ..< 3s, destination: 0s ..< 2s, link: "take_left");
      AudioClip(source: voice, range: 3s ..< 5s, destination: 2s ..< 4s, link: "take_right");
    }
  }
}
export out = render(main);`;

const publicTimelineEditSource = `cut 0.4;
project "public runtime timeline edit";
import {
  Sequence, PictureTrack, PictureClip, AudioTrack, TimelineEdit,
  editSelection, avTime, editBoundary, editTransition
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(trackId: "v1", role: "primary") {
        PictureClip(source: picture, range: 1s ..< 3s, duration: 2s, link: "take-left", headHandle: 1s, tailHandle: 1s, editId: "picture-left");
        PictureClip(source: picture, range: 3s ..< 5s, duration: 2s, link: "take-right", headHandle: 1s, tailHandle: 1s, editId: "picture-right");
      }
    }
    AudioTrack(trackId: "a1", role: "dialogue") {
      AudioClip(source: voice, range: 1s ..< 3s, destination: 0s ..< 2s, link: "take-left", headHandle: 1s, tailHandle: 1s, editId: "audio-left");
      AudioClip(source: voice, range: 3s ..< 5s, destination: 2s ..< 4s, link: "take-right", headHandle: 1s, tailHandle: 1s, editId: "audio-right");
    }
    TimelineEdit(
      id: "public-jl",
      operations: [
        editBoundary(
          selection: editSelection(trackIds: ["v1", "a1"]),
          at: avTime(picture: 2250ms, audio: 1750ms)
        ),
        editTransition(
          left: editSelection(
            trackIds: ["v1", "a1"],
            originIds: ["picture-left", "audio-left"]
          ),
          right: editSelection(
            trackIds: ["v1", "a1"],
            originIds: ["picture-right", "audio-right"]
          ),
          at: avTime(picture: 2250ms, audio: 1750ms),
          duration: avTime(picture: 500ms, audio: 500ms),
          pictureKind: "cross-dissolve",
          audioCurve: "equal-power"
        )
      ]
    );
  }
}
export out = render(main);`;

function provenance(label = "runtime"): IRProvenance {
  return {
    module: `reference-timeline-edit-materialization.${label}.cut`,
    span: {
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 1, line: 1, column: 2 },
    },
  };
}

function time(value: Rational): IRValue {
  return { kind: "quantity", dimension: "time", magnitude: value, unit: "s" };
}

function range(start: Rational, duration: Rational): IRValue {
  return {
    kind: "range",
    start: time(start),
    end: time(addRational(start, duration)),
    exclusive: true,
  };
}

function compile() {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function compileSource(value: string) {
  const parsed = parseCutLanguage(value);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function tracks(ir: CutAVIR) {
  const picture = Object.values(ir.nodes).find((node): node is PictureTrackNode =>
    node.editorial?.kind === "picture-track");
  const audio = Object.values(ir.nodes).find((node): node is AudioTrackNode =>
    node.editorial?.kind === "audio-track");
  assert.ok(picture);
  assert.ok(audio);
  return { picture, audio };
}

function mappedItem(
  ir: CutAVIR,
  trackId: string,
  domain: "picture" | "audio",
  node: IRNode,
  originId: string,
  segmentId: string,
  destinationStart: number,
  sourceStart: number,
  linkId: string,
): TimelineEditItemV1 {
  const common = {
    originId,
    segmentId,
    trackId,
    domain,
    linkId,
    destination: { start: rational(destinationStart), duration: rational(2) },
    role: domain === "picture" ? "picture" : "dialogue",
    metadata: { "org.example.take": originId.endsWith("left") ? "left" : "right" },
    provenance: provenance(originId),
  };
  const sourceView = domain === "picture"
    ? {
        kind: "picture" as const,
        nodeId: node.id,
        source: { start: rational(sourceStart), duration: rational(2) },
        handles: { head: rational(1), tail: rational(1) },
        authorityId: timelineEditSourceAuthority(ir, node),
        timeMap: { kind: "constant" as const, direction: "forward" as const, rate: rational(1) },
      }
    : {
        kind: "audio" as const,
        nodeId: node.id,
        source: { start: rational(sourceStart), duration: rational(2) },
        handles: { head: rational(1), tail: rational(1) },
        authorityId: timelineEditSourceAuthority(ir, node),
        rate: rational(1),
        fadeIn: rational(1, 10),
        fadeOut: rational(1, 10),
        presentationClock: {
          originDuration: rational(2),
          sliceOffset: zeroRational,
          fadePolicy: "origin-relative" as const,
        },
      };
  return { ...common, sourceView };
}

function materializeTrack(
  ir: CutAVIR,
  plan: TimelineEditPlanV1,
  expected: TimelineEditTrackV1,
  track: PictureTrackNode | AudioTrackNode,
) {
  const oldChildren = [...track.children];
  const oldByOrigin = new Map(
    track.editorial.items.map((item, index) => [
      item.editId!,
      ir.nodes[item.nodeId]!,
    ]),
  );
  const children: string[] = [];
  const editorialItems: EditorialTrackItem[] = [];
  for (const [index, item] of expected.items.entries()) {
    const original = oldByOrigin.get(item.originId);
    assert.ok(original);
    const id = `${track.editorial.kind === "picture-track" ? "picture" : "audio"}_timeline_materialized_${index}`;
    const destination = {
      start: addRational(track.interval.start, item.destination.start),
      duration: item.destination.duration,
    };
    const child = structuredClone(original);
    child.id = id;
    child.interval = destination;
    child.provenance = structuredClone(item.provenance);
    if (item.sourceView.kind === "gap") {
      throw new Error("fixture does not materialize gaps");
    }
    child.inputs.range = range(item.sourceView.source.start, item.sourceView.source.duration);
    child.inputs.headHandle = time(item.sourceView.handles.head);
    child.inputs.tailHandle = time(item.sourceView.handles.tail);
    if (item.sourceView.kind === "picture") {
      child.inputs.duration = time(item.destination.duration);
    } else {
      assert.ok(item.sourceView.kind === "audio" || item.sourceView.kind === "processed-audio");
      child.inputs.destination = range(item.destination.start, item.destination.duration);
      child.inputs.fadeIn = time(item.sourceView.fadeIn);
      child.inputs.fadeOut = time(item.sourceView.fadeOut);
    }
    ir.nodes[id] = child;
    children.push(id);
    editorialItems.push({
      nodeId: id,
      order: index,
      kind: expected.domain === "picture" ? "picture" : "audio",
      destination,
      source: item.sourceView.source,
      ...(item.sourceView.kind === "picture"
        && !(item.sourceView.timeMap.kind === "constant"
          && item.sourceView.timeMap.direction === "forward"
          && item.sourceView.timeMap.rate.numerator === "1"
          && item.sourceView.timeMap.rate.denominator === "1")
        ? { timeMap: item.sourceView.timeMap }
        : {}),
      linkId: item.linkId,
      editId: item.originId,
      ...(item.role ? { role: item.role } : {}),
      metadata: { ...item.metadata },
    } as EditorialTrackItem);
  }
  oldChildren.forEach((id) => { delete ir.nodes[id]; });
  track.children = children;
  if (expected.domain === "picture") {
    assert.equal(track.editorial.kind, "picture-track");
    track.editorial.items = editorialItems as Extract<IREditorial, { kind: "picture-track" }>["items"];
  } else {
    assert.equal(track.editorial.kind, "audio-track");
    track.editorial.items = editorialItems as Extract<IREditorial, { kind: "audio-track" }>["items"];
  }
  track.editorial.trackId = expected.trackId;
  track.editorial.role = expected.role;
  track.editorial.metadata = { ...expected.metadata };
  const execution = executeTimelineEditPlan(plan);
  const transitions = execution.transitions.filter((candidate) => candidate.trackId === expected.trackId);
  if (track.editorial.kind === "picture-track") {
    track.editorial.transitions = transitions.map((transition) => {
      const outgoing = expected.items.findIndex((item) => item.segmentId === transition.outgoingSegmentId);
      const incoming = expected.items.findIndex((item) => item.segmentId === transition.incomingSegmentId);
      return {
        cut: addRational(track.interval.start, transition.cut),
        duration: transition.duration,
        overlap: {
          start: addRational(track.interval.start, transition.overlap.start),
          duration: transition.overlap.duration,
        },
        outgoingNodeId: children[outgoing]!,
        incomingNodeId: children[incoming]!,
        outgoingSource: transition.outgoingSource,
        incomingSource: transition.incomingSource,
        style: transition.picture!,
        provenance: structuredClone(plan.operations.find((operation) => operation.id === transition.operationId)!.provenance),
      };
    });
  } else {
    track.editorial.transitions = transitions.map((transition) => {
      const outgoing = expected.items.findIndex((item) => item.segmentId === transition.outgoingSegmentId);
      const incoming = expected.items.findIndex((item) => item.segmentId === transition.incomingSegmentId);
      return {
        cut: addRational(track.interval.start, transition.cut),
        duration: transition.duration,
        overlap: {
          start: addRational(track.interval.start, transition.overlap.start),
          duration: transition.overlap.duration,
        },
        outgoingNodeId: children[outgoing]!,
        incomingNodeId: children[incoming]!,
        outgoingSource: transition.outgoingSource,
        incomingSource: transition.incomingSource,
        curve: transition.audio!.curve,
        provenance: structuredClone(plan.operations.find((operation) => operation.id === transition.operationId)!.provenance),
      };
    });
  }
}

type EditorialTrackItem =
  | Extract<IREditorial, { kind: "picture-track" }>["items"][number]
  | Extract<IREditorial, { kind: "audio-track" }>["items"][number];

function fixture() {
  const ir = compile();
  const { picture, audio } = tracks(ir);
  const pictureNodes = picture.editorial.items.map((item) => ir.nodes[item.nodeId]!);
  const audioNodes = audio.editorial.items.map((item) => ir.nodes[item.nodeId]!);
  const audioResourceId = audioNodes[0]?.inputs.source?.kind === "resource-ref"
    ? audioNodes[0].inputs.source.id
    : undefined;
  const audioResource = audioResourceId ? ir.resources[audioResourceId] : undefined;
  assert.ok(audioResource?.kind === "audio");
  // TimelineEdit J/L transitions are executable render plans, so the runtime
  // fixture must carry the same selected-stream authority that a real applied
  // lock supplies. A destination sample rate alone is not source-grid proof.
  audioResource.metadata = {
    bytes: 1,
    probe: {
      kind: "media",
      identity: {
        streams: [{
          index: 0,
          type: "audio",
          sampleRate: 48_000,
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
  for (const node of [...pictureNodes, ...audioNodes]) {
    node.inputs.headHandle = time(rational(1));
    node.inputs.tailHandle = time(rational(1));
  }
  for (const node of audioNodes) {
    node.inputs.fadeIn = time(rational(1, 10));
    node.inputs.fadeOut = time(rational(1, 10));
  }
  picture.editorial.trackId = "v1";
  picture.editorial.role = "primary-picture";
  picture.editorial.metadata = { lane: "main" };
  audio.editorial.trackId = "a1";
  audio.editorial.role = "dialogue";
  audio.editorial.metadata = { lane: "dialogue" };
  picture.editorial.items.forEach((item, index) => {
    item.editId = index === 0 ? "picture_left" : "picture_right";
    item.role = "picture";
    item.metadata = { take: index === 0 ? "left" : "right" };
  });
  audio.editorial.items.forEach((item, index) => {
    item.editId = index === 0 ? "audio_left" : "audio_right";
    item.role = "dialogue";
    item.metadata = { take: index === 0 ? "left" : "right" };
  });
  const pictureTrack: TimelineEditTrackV1 = {
    trackId: "v1",
    domain: "picture",
    order: 0,
    duration: rational(4),
    role: "primary-picture",
    metadata: { "org.example.lane": "main" },
    items: [
      mappedItem(ir, "v1", "picture", pictureNodes[0]!, "picture_left", "segment_picture_left", 0, 1, "take_left"),
      mappedItem(ir, "v1", "picture", pictureNodes[1]!, "picture_right", "segment_picture_right", 2, 3, "take_right"),
    ],
  };
  const audioTrack: TimelineEditTrackV1 = {
    trackId: "a1",
    domain: "audio",
    order: 1,
    duration: rational(4),
    role: "dialogue",
    metadata: { "org.example.lane": "dialogue" },
    items: [
      mappedItem(ir, "a1", "audio", audioNodes[0]!, "audio_left", "segment_audio_left", 0, 1, "take_left"),
      mappedItem(ir, "a1", "audio", audioNodes[1]!, "audio_right", "segment_audio_right", 2, 3, "take_right"),
    ],
  };
  const plan: TimelineEditPlanV1 = {
    version: 1,
    id: "canonical_jl",
    compositionId: ir.compositions[0]!.id,
    sceneId: Object.values(ir.scenes)[0]!.id,
    initialDuration: rational(4),
    finalDuration: rational(4),
    tracks: [pictureTrack, audioTrack],
    operations: [
      {
        id: "jl_boundary",
        kind: "boundary-adjust",
        selection: { trackIds: ["v1", "a1"] },
        at: { picture: rational(9, 4), audio: rational(7, 4) },
        provenance: provenance("jl-boundary"),
      },
      {
        id: "linked_transition",
        kind: "transition",
        left: {
          trackIds: ["v1", "a1"],
          originIds: ["picture_left", "audio_left"],
        },
        right: {
          trackIds: ["v1", "a1"],
          originIds: ["picture_right", "audio_right"],
        },
        at: { picture: rational(9, 4), audio: rational(7, 4) },
        duration: { picture: rational(1, 2), audio: rational(1, 2) },
        picture: { kind: "wipe", direction: "left", softness: rational(1, 5) },
        audio: { curve: "equal-power" },
        provenance: provenance("transition"),
      },
    ],
    provenance: provenance("plan"),
  };
  const execution = executeTimelineEditPlan(plan);
  ir.timelineEdits = [plan];
  materializeTrack(ir, plan, execution.tracks.find((track) => track.trackId === "v1")!, picture);
  materializeTrack(ir, plan, execution.tracks.find((track) => track.trackId === "a1")!, audio);
  return { ir, plan, picture, audio, execution };
}

function sessionFixture() {
  const value = fixture();
  for (const resource of Object.values(value.ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "a".repeat(64);
    resource.metadata = resource.kind === "audio"
      ? {
          bytes: 1,
          probe: {
            kind: "media",
            identity: {
              streams: [{
                index: 0,
                type: "audio",
                sampleRate: 48_000,
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
        } as never
      : {
          bytes: 1,
          probe: {
            kind: "media",
            identity: {
              streams: [{
                index: 0,
                type: "video",
                start: rational(0),
                frameRate: rational(24),
                timeBase: rational(1, 24),
                width: 640,
                height: 360,
              }],
            },
            selected: {
              video: {
                streamIndex: 0,
                start: rational(0),
                duration: rational(10),
                durationSource: "decoded-video-cadence",
                timeBase: rational(1, 24),
                frameRate: rational(24),
                decodedVideoCadence: {
                  format: "cut-decoded-video-cadence",
                  version: 2,
                  method: "ffprobe-show-frames-cfr-v2",
                  quantization: "phase-floor",
                  phaseNumerator: "0",
                  streamIndex: 0,
                  firstPts: "0",
                  lastPts: "239",
                  quantizedEndPts: "240",
                  frameCount: "240",
                  durationPresentCount: "240",
                  durationCoverage: "complete",
                  recordsSha256: "0".repeat(64),
                  timeBase: rational(1, 24),
                  frameRate: rational(24),
                },
              },
            },
          },
        } as never;
  }
  value.ir.determinism.semantic = "locked";
  return value;
}

type RuntimeFixture = ReturnType<typeof fixture>;

function expectFailure(
  mutate: (state: RuntimeFixture) => void,
  code: string,
  path?: RegExp,
) {
  const value = fixture();
  mutate(value);
  assert.throws(
    () => validateReferenceTimelineEditMaterializations(value.ir),
    (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
      && error.code === code
      && (path === undefined || path.test(error.path)),
  );
}

test("TimelineEdit runtime replays and correlates direct picture/audio J-L materialization before legacy validators", () => {
  const { ir, picture, audio, execution } = fixture();
  const receipt = validateReferenceTimelineEditMaterializations(ir);
  assert.equal(receipt.plans.length, 1);
  assert.equal(receipt.plans[0]!.materializationId, execution.materializationId);
  assert.deepEqual(
    receipt.plans[0]!.trackBindings.map((entry) => [entry.trackId, entry.items, entry.transitions]),
    [["v1", 2, 1], ["a1", 2, 1]],
  );
  assert.equal(referenceTimelineEditTrackOwnership(ir, picture)?.planId, "canonical_jl");
  assert.equal(referenceTimelineEditTrackOwnership(ir, audio)?.planId, "canonical_jl");
  assert.doesNotThrow(() => validateReferencePictureTrackOperationPlan(ir, ir.compositions[0]!, picture));
  assert.doesNotThrow(() => validateReferenceAudioTrackOperationPlan(ir, ir.compositions[0]!, audio));
});

test("public TimelineEdit compilation atomically publishes one loader-valid runtime-correlated picture/audio materialization", () => {
  const ir = compileSource(publicTimelineEditSource);
  assert.equal(ir.timelineEdits?.length, 1);
  assert.doesNotThrow(() => validateCutAvIr(ir));
  const result = validateReferenceTimelineEditMaterializations(ir);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0]!.planId, "public-jl");
  assert.deepEqual(
    result.plans[0]!.trackBindings.map((entry) => [entry.trackId, entry.items, entry.transitions]),
    [["v1", 2, 1], ["a1", 2, 1]],
  );
});

test("full reference-session entry revalidates TimelineEdit before picture or PCM allocation", () => {
  const valid = sessionFixture();
  assert.doesNotThrow(() => validateReferenceSession(valid.ir));

  const hostile = sessionFixture();
  hostile.audio.editorial.transitions![0]!.incomingSource.start = rational(3, 2);
  assert.throws(
    () => validateReferenceSession(hostile.ir),
    /CUT_TIMELINE_EDIT_TRANSITION/u,
  );
});

test("edit source lineage survives lock application while declaration mutations invalidate it", () => {
  const ir = compile();
  const { audio } = tracks(ir);
  const sourceNode = ir.nodes[audio.editorial.items[0]!.nodeId]!;
  const source = sourceNode.inputs.source;
  assert.equal(source?.kind, "resource-ref");
  if (source?.kind !== "resource-ref") return;
  const resource = ir.resources[source.id]!;
  const initial = timelineEditSourceAuthority(ir, sourceNode);
  resource.state = "locked";
  resource.sha256 = "b".repeat(64);
  assert.equal(
    timelineEditSourceAuthority(ir, sourceNode),
    initial,
    "cut.lock byte authentication must not rewrite pre-lock edit lineage",
  );
  resource.locator = "replacement.wav";
  assert.notEqual(
    timelineEditSourceAuthority(ir, sourceNode),
    initial,
    "a different authored resource declaration must invalidate edit lineage",
  );
});

test("TimelineEdit runtime rejects forged aggregate, materialization, link, metadata, lineage, and transition state", () => {
  expectFailure(
    ({ ir, picture }) => {
      const duplicate = structuredClone(picture);
      duplicate.id = "duplicate_timeline_track";
      ir.nodes[duplicate.id] = duplicate;
    },
    "CUT_TIMELINE_EDIT_REFERENCE",
    /tracks\.v1/u,
  );
  expectFailure(
    ({ picture }) => {
      picture.editorial.items[0]!.destination.duration = rational(1);
    },
    "CUT_TIMELINE_EDIT_RESULT",
    /destination/u,
  );
  expectFailure(
    ({ audio }) => {
      audio.editorial.items[0]!.source!.start = rational(9);
    },
    "CUT_TIMELINE_EDIT_RESULT",
    /items\[0\]/u,
  );
  expectFailure(
    ({ picture }) => {
      picture.editorial.items[0]!.editId = "stale_origin";
    },
    "CUT_TIMELINE_EDIT_RESULT",
    /editId/u,
  );
  expectFailure(
    ({ audio }) => {
      audio.editorial.items[0]!.linkId = "forged_link";
    },
    "CUT_TIMELINE_EDIT_LINK",
    /linkId/u,
  );
  expectFailure(
    ({ picture }) => {
      picture.editorial.items[0]!.metadata = { "org.example.take": "forged" };
    },
    "CUT_TIMELINE_EDIT_RESULT",
    /metadata/u,
  );
  expectFailure(
    ({ ir, picture }) => {
      const child = ir.nodes[picture.editorial.items[0]!.nodeId]!;
      child.properties.forged = { kind: "boolean", value: true };
    },
    "CUT_TIMELINE_EDIT_RESULT",
    /items\[0\]/u,
  );
  expectFailure(
    ({ picture }) => {
      picture.editorial.transitions![0]!.outgoingNodeId = picture.editorial.items[1]!.nodeId;
    },
    "CUT_TIMELINE_EDIT_TRANSITION",
    /transitions/u,
  );
  expectFailure(
    ({ audio }) => {
      audio.editorial.transitions![0]!.curve = "linear";
    },
    "CUT_TIMELINE_EDIT_TRANSITION",
    /transitions/u,
  );
  expectFailure(
    ({ ir, audio }) => {
      delete ir.nodes[audio.editorial.items[0]!.nodeId];
    },
    "CUT_TIMELINE_EDIT_REFERENCE",
    /nodeId/u,
  );
});

test("TimelineEdit runtime rejects stale replay results and dual edit authorities", () => {
  expectFailure(
    ({ plan }) => {
      (plan.tracks[0]!.metadata as Record<string, string>)["org.example.lane"] = "stale";
    },
    "CUT_TIMELINE_EDIT_RESULT",
  );
  expectFailure(
    ({ picture }) => {
      picture.editorial.operationPlan = {
        version: 1,
        sourceDuration: rational(4),
        baseItems: [],
        operations: [],
      };
    },
    "CUT_TIMELINE_EDIT_RESULT",
    /operationPlan/u,
  );
});

test("TimelineEdit omission preserves legacy track validation and empty runtime identity", () => {
  const ir = compile();
  const { picture, audio } = tracks(ir);
  const receipt = validateReferenceTimelineEditMaterializations(ir);
  assert.equal(receipt.plans.length, 0);
  assert.equal(referenceTimelineEditTrackOwnership(ir, picture), undefined);
  assert.equal(referenceTimelineEditTrackOwnership(ir, audio), undefined);
  assert.doesNotThrow(() => validateReferencePictureTrackOperationPlan(ir, ir.compositions[0]!, picture));
  assert.doesNotThrow(() => validateReferenceAudioTrackOperationPlan(ir, ir.compositions[0]!, audio));
});
