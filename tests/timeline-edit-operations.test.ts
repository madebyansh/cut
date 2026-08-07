import assert from "node:assert/strict";
import test from "node:test";
import {
  executeTimelineEditPlan,
  TimelineEditError,
  timelineEditOperationsFromInput,
  timelineEditLimits,
  type TimelineEditItemV1,
  type TimelineEditOperationV1,
  type TimelineEditPlanV1,
  type TimelineEditSourceView,
  type TimelineEditTrackV1,
} from "../lib/language/timeline-edit-operations";
import type { IRProvenance, IRValue } from "../lib/language/ir";
import { rational } from "../lib/language/rational";

const provenance: IRProvenance = {
  module: "fixture.cut",
  span: {
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 1, line: 1, column: 2 },
  },
};

const time = (start: number, duration: number) => ({
  start: rational(start),
  duration: rational(duration),
});

function pictureView(nodeId: string, sourceStart: number, duration: number, handles = 2): TimelineEditSourceView {
  return {
    kind: "picture",
    nodeId,
    source: time(sourceStart, duration),
    handles: { head: rational(handles), tail: rational(handles) },
    authorityId: `authority_${nodeId}`,
    timeMap: { kind: "constant", direction: "forward", rate: rational(1) },
  };
}

function audioView(nodeId: string, sourceStart: number, duration: number, handles = 2): TimelineEditSourceView {
  return {
    kind: "audio",
    nodeId,
    source: time(sourceStart, duration),
    handles: { head: rational(handles), tail: rational(handles) },
    authorityId: `authority_${nodeId}`,
    rate: rational(1),
    fadeIn: rational(0),
    fadeOut: rational(0),
    presentationClock: {
      originDuration: rational(duration),
      sliceOffset: rational(0),
      fadePolicy: "origin-relative",
    },
  };
}

function processedView(regionId: string, sourceStart: number, sourceDuration: number, destinationDuration: number): TimelineEditSourceView {
  return {
    kind: "processed-audio",
    regionId,
    sourceNodeId: `${regionId}_source`,
    processorNodeIds: [`${regionId}_gain`, `${regionId}_eq`],
    graphAuthorityId: `${regionId}_graph`,
    source: time(sourceStart, sourceDuration),
    handles: { head: rational(1), tail: rational(1) },
    authorityId: `${regionId}_authority`,
    rate: rational(sourceDuration, destinationDuration),
    fadeIn: rational(1, 4),
    fadeOut: rational(1, 2),
    presentationClock: {
      originDuration: rational(destinationDuration),
      sliceOffset: rational(0),
      fadePolicy: "origin-relative",
    },
    statePolicy: "single-authorized-evaluation",
  };
}

function item(
  trackId: string,
  domain: TimelineEditTrackV1["domain"],
  originId: string,
  start: number,
  duration: number,
  sourceView: TimelineEditSourceView,
  linkId?: string,
): TimelineEditItemV1 {
  return {
    originId,
    segmentId: `segment_${originId}`,
    trackId,
    domain,
    ...(linkId ? { linkId } : {}),
    destination: time(start, duration),
    sourceView,
    role: domain === "audio" ? "dialogue" : "picture",
    metadata: {},
    provenance,
  };
}

function gap(trackId: string, domain: TimelineEditTrackV1["domain"], start: number, duration: number): TimelineEditItemV1 {
  return item(
    trackId,
    domain,
    `gap_${trackId}_${start}`,
    start,
    duration,
    { kind: "gap", authorityId: `gap_authority_${trackId}_${start}` },
  );
}

function track(
  trackId: string,
  domain: TimelineEditTrackV1["domain"],
  order: number,
  items: readonly TimelineEditItemV1[],
): TimelineEditTrackV1 {
  return {
    trackId,
    domain,
    order,
    duration: rational(10),
    role: domain === "audio" ? "dialogue" : "picture",
    metadata: { "org.example.owner": "fixture" },
    items,
  };
}

function baseTracks() {
  const picture = track("v1", "picture", 0, [
    item("v1", "picture", "picture_a", 0, 4, pictureView("picture_a_node", 2, 4), "take_a"),
    item("v1", "picture", "picture_b", 4, 4, pictureView("picture_b_node", 8, 4), "take_b"),
    gap("v1", "picture", 8, 2),
  ]);
  const dialogue = track("a1", "audio", 1, [
    item("a1", "audio", "audio_a", 0, 4, audioView("audio_a_node", 2, 4), "take_a"),
    item("a1", "audio", "audio_b", 4, 4, audioView("audio_b_node", 8, 4), "take_b"),
    gap("a1", "audio", 8, 2),
  ]);
  const music = track("a2", "audio", 2, [
    item("a2", "audio", "music", 0, 10, audioView("music_node", 2, 10)),
  ]);
  return [picture, dialogue, music] as const;
}

function plan(
  operations: readonly TimelineEditOperationV1[],
  tracks: readonly TimelineEditTrackV1[] = baseTracks(),
): TimelineEditPlanV1 {
  return {
    version: 1,
    id: "assembly",
    compositionId: "main",
    sceneId: "scene_main",
    initialDuration: rational(10),
    finalDuration: rational(10),
    tracks,
    operations,
    provenance,
  };
}

function expectError(
  execute: () => unknown,
  code: TimelineEditError["code"],
  message?: RegExp,
) {
  assert.throws(execute, (error: unknown) => {
    assert.ok(error instanceof TimelineEditError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("one immutable transaction edits linked picture/dialogue and an explicitly unlinked music track", () => {
  const operations: TimelineEditOperationV1[] = [
    {
      id: "remove_false_start",
      kind: "ripple-delete",
      selection: { trackIds: ["v1", "a1"], linkIds: ["take_a"] },
      range: { picture: time(1, 1), audio: time(1, 1) },
      provenance,
    },
    {
      id: "lift_music_breath",
      kind: "lift",
      selection: { trackIds: ["a2"] },
      range: { audio: time(3, 1) },
      provenance,
    },
  ];
  const original = plan(operations);
  const snapshot = structuredClone(original);
  const first = executeTimelineEditPlan(original);
  const second = executeTimelineEditPlan(original);

  assert.deepEqual(original, snapshot, "planning must not mutate caller-owned IR-shaped data");
  assert.deepEqual(first, second);
  assert.equal(first.materializationId, second.materializationId);

  const picture = first.tracks.find((candidate) => candidate.trackId === "v1")!;
  const dialogue = first.tracks.find((candidate) => candidate.trackId === "a1")!;
  const music = first.tracks.find((candidate) => candidate.trackId === "a2")!;
  assert.deepEqual(
    picture.items.map((value) => [
      value.sourceView.kind === "gap" ? "gap" : value.originId,
      value.destination.start,
      value.destination.duration,
    ]),
    dialogue.items.map((value) => [
      value.sourceView.kind === "gap" ? "gap" : value.originId.replace("audio", "picture"),
      value.destination.start,
      value.destination.duration,
    ]),
    "linked picture and dialogue receive the same exact destination closure",
  );
  assert.equal(picture.items.find((value) => value.originId === "picture_a")?.sourceView.kind, "picture");
  const firstPicture = picture.items.find((value) => value.originId === "picture_a")!;
  assert.deepEqual(firstPicture.destination, time(0, 1));
  assert.deepEqual((firstPicture.sourceView as Extract<TimelineEditSourceView, { kind: "picture" }>).source, time(2, 1));
  assert.equal(picture.items.at(-1)?.sourceView.kind, "gap");
  assert.deepEqual(
    picture.items.at(-1)?.destination,
    time(7, 3),
    "the shifted pre-existing tail gap and fixed-duration closure gap coalesce",
  );

  assert.equal(music.items.length, 3);
  assert.equal(music.items[1]?.sourceView.kind, "gap");
  assert.deepEqual(music.items[1]?.destination, time(3, 1));
});

test("processed AudioRegion slices retain one graph authority and authored fade law", () => {
  const processed = track("dialogue", "audio", 0, [
    item("dialogue", "audio", "processed_take", 0, 6, processedView("region_take", 4, 9, 6), "take"),
    gap("dialogue", "audio", 6, 4),
  ]);
  const operation: TimelineEditOperationV1 = {
    id: "split_processed",
    kind: "split",
    selection: { trackIds: ["dialogue"], originIds: ["processed_take"] },
    at: { audio: rational(2) },
    provenance,
  };
  const result = executeTimelineEditPlan(plan([operation], [processed]));
  const slices = result.tracks[0].items.filter((value) => value.originId === "processed_take");
  assert.equal(slices.length, 2);
  for (const slice of slices) {
    assert.equal(slice.sourceView.kind, "processed-audio");
    const view = slice.sourceView as Extract<TimelineEditSourceView, { kind: "processed-audio" }>;
    assert.equal(view.regionId, "region_take");
    assert.equal(view.graphAuthorityId, "region_take_graph");
    assert.deepEqual(view.processorNodeIds, ["region_take_gain", "region_take_eq"]);
    assert.deepEqual(view.fadeIn, rational(1, 4));
    assert.deepEqual(view.fadeOut, rational(1, 2));
    assert.equal(view.statePolicy, "single-authorized-evaluation");
  }
  assert.deepEqual((slices[0].sourceView as Exclude<TimelineEditSourceView, { kind: "gap" }>).source, time(4, 3));
  assert.deepEqual((slices[1].sourceView as Exclude<TimelineEditSourceView, { kind: "gap" }>).source, time(7, 6));
  const firstClock = (slices[0].sourceView as Extract<TimelineEditSourceView, { kind: "processed-audio" }>).presentationClock;
  const secondClock = (slices[1].sourceView as Extract<TimelineEditSourceView, { kind: "processed-audio" }>).presentationClock;
  assert.deepEqual(firstClock, {
    originDuration: rational(6),
    sliceOffset: rational(0),
    fadePolicy: "origin-relative",
  });
  assert.deepEqual(secondClock, {
    originDuration: rational(6),
    sliceOffset: rational(2),
    fadePolicy: "origin-relative",
  });
});

test("processed retimed slip preserves the origin envelope and recomputes exact residual handles", () => {
  const processed = track("dialogue", "audio", 0, [
    item("dialogue", "audio", "processed_take", 0, 6, processedView("region_take", 4, 9, 6)),
    gap("dialogue", "audio", 6, 4),
  ]);
  const result = executeTimelineEditPlan(plan([
    {
      id: "trim_processed",
      kind: "trim",
      selection: { trackIds: ["dialogue"], originIds: ["processed_take"] },
      keep: { audio: time(1, 4) },
      provenance,
    },
    {
      id: "slip_processed_inside_origin",
      kind: "slip",
      selection: { trackIds: ["dialogue"], originIds: ["processed_take"] },
      range: { audio: time(1, 4) },
      by: { audio: rational(1, 3) },
      provenance,
    },
  ], [processed]));
  const slipped = result.tracks[0]!.items.find((entry) =>
    entry.originId === "processed_take");
  assert.ok(slipped?.sourceView.kind === "processed-audio");
  assert.deepEqual(slipped.destination, time(1, 4));
  assert.deepEqual(slipped.sourceView.source, time(6, 6));
  assert.deepEqual(slipped.sourceView.handles, {
    head: rational(3),
    tail: rational(2),
  });
  assert.deepEqual(slipped.sourceView.presentationClock, {
    originDuration: rational(6),
    sliceOffset: rational(4, 3),
    fadePolicy: "origin-relative",
  });
  assert.equal(slipped.sourceView.graphAuthorityId, "region_take_graph");
  assert.equal(slipped.sourceView.statePolicy, "single-authorized-evaluation");
});

test("variable picture maps split with exact integrated source time and stable sliced curves", () => {
  const ramp = track("ramp", "picture", 0, [
    item("ramp", "picture", "ramp_take", 0, 4, {
      kind: "picture",
      nodeId: "ramp_node",
      source: time(10, 6),
      handles: { head: rational(2), tail: rational(2) },
      authorityId: "ramp_authority",
      timeMap: {
        kind: "speed-ramp",
        interpolation: "linear-rate",
        frameSelection: "floor",
        points: [
          { at: rational(0), rate: rational(1) },
          { at: rational(2), rate: rational(2) },
          { at: rational(4), rate: rational(1) },
        ],
      },
    }),
    gap("ramp", "picture", 4, 6),
  ]);
  const result = executeTimelineEditPlan(plan([{
    id: "split_ramp",
    kind: "split",
    selection: { trackIds: ["ramp"], originIds: ["ramp_take"] },
    at: { picture: rational(2) },
    provenance,
  }], [ramp]));
  const slices = result.tracks[0]!.items.filter((entry) => entry.originId === "ramp_take");
  assert.equal(slices.length, 2);
  assert.deepEqual(
    slices.map((entry) => entry.sourceView.kind === "picture"
      ? [entry.destination, entry.sourceView.source, entry.sourceView.timeMap]
      : undefined),
    [
      [
        time(0, 2),
        time(10, 3),
        {
          kind: "speed-ramp",
          interpolation: "linear-rate",
          frameSelection: "floor",
          points: [
            { at: rational(0), rate: rational(1) },
            { at: rational(2), rate: rational(2) },
          ],
        },
      ],
      [
        time(2, 2),
        time(13, 3),
        {
          kind: "speed-ramp",
          interpolation: "linear-rate",
          frameSelection: "floor",
          points: [
            { at: rational(0), rate: rational(2) },
            { at: rational(2), rate: rational(1) },
          ],
        },
      ],
    ],
  );
});

test("trim, lift, extract, ripple, slip, and slide share exact direct-item interval laws", () => {
  const direct = track("direct", "picture", 0, [
    item("direct", "picture", "left", 0, 3, pictureView("left_node", 4, 3)),
    item("direct", "picture", "middle", 3, 4, pictureView("middle_node", 10, 4)),
    item("direct", "picture", "right", 7, 3, pictureView("right_node", 20, 3)),
  ]);
  const run = (operation: TimelineEditOperationV1) =>
    executeTimelineEditPlan(plan([operation], [direct])).tracks[0]!;

  const trimmed = run({
    id: "trim_middle",
    kind: "trim",
    selection: { trackIds: ["direct"], originIds: ["middle"] },
    keep: { picture: time(4, 2) },
    provenance,
  });
  assert.deepEqual(
    trimmed.items.map((entry) => [entry.sourceView.kind, entry.destination]),
    [["gap", time(0, 4)], ["picture", time(4, 2)], ["gap", time(6, 4)]],
  );
  const trimmedMedia = trimmed.items[1]!;
  assert.equal(trimmedMedia.sourceView.kind, "picture");
  if (trimmedMedia.sourceView.kind === "picture") {
    assert.deepEqual(trimmedMedia.sourceView.source, time(11, 2));
  }

  const lifted = run({
    id: "lift_middle",
    kind: "lift",
    selection: { trackIds: ["direct"], originIds: ["middle"] },
    range: { picture: time(4, 1) },
    provenance,
  });
  assert.deepEqual(
    lifted.items.map((entry) => [entry.sourceView.kind, entry.destination]),
    [
      ["picture", time(0, 3)],
      ["picture", time(3, 1)],
      ["gap", time(4, 1)],
      ["picture", time(5, 2)],
      ["picture", time(7, 3)],
    ],
  );

  for (const kind of ["extract", "ripple-delete"] as const) {
    const compacted = run({
      id: `${kind}_middle`,
      kind,
      selection: { trackIds: ["direct"], originIds: ["middle"] },
      range: { picture: time(4, 1) },
      provenance,
    });
    assert.deepEqual(
      compacted.items.map((entry) => [entry.sourceView.kind, entry.destination]),
      [
        ["picture", time(0, 3)],
        ["picture", time(3, 1)],
        ["picture", time(4, 2)],
        ["picture", time(6, 3)],
        ["gap", time(9, 1)],
      ],
      kind,
    );
  }

  const slipped = run({
    id: "slip_middle",
    kind: "slip",
    selection: { trackIds: ["direct"], originIds: ["middle"] },
    range: { picture: time(3, 4) },
    by: { picture: rational(1) },
    provenance,
  });
  const slippedMiddle = slipped.items[1]!;
  assert.deepEqual(slippedMiddle.destination, time(3, 4));
  assert.equal(slippedMiddle.sourceView.kind, "picture");
  if (slippedMiddle.sourceView.kind === "picture") {
    assert.deepEqual(slippedMiddle.sourceView.source, time(11, 4));
  }

  const slid = run({
    id: "slide_middle",
    kind: "slide",
    selection: { trackIds: ["direct"], originIds: ["middle"] },
    range: { picture: time(3, 4) },
    by: { picture: rational(1) },
    provenance,
  });
  assert.deepEqual(
    slid.items.map((entry) => entry.destination),
    [time(0, 4), time(4, 4), time(8, 2)],
  );
  assert.deepEqual(
    slid.items.map((entry) => entry.sourceView.kind === "picture"
      ? entry.sourceView.source
      : undefined),
    [time(4, 4), time(10, 4), time(21, 2)],
  );
});

test("boundary-adjust preserves distinct picture and audio cut clocks for an exact J edit", () => {
  const result = executeTimelineEditPlan(plan([{
    id: "dialogue_leads_picture",
    kind: "boundary-adjust",
    selection: {
      trackIds: ["v1", "a1"],
      originIds: ["picture_a", "picture_b", "audio_a", "audio_b"],
    },
    at: { picture: rational(6), audio: rational(4) },
    provenance,
  }]));
  const picture = result.tracks.find((candidate) => candidate.trackId === "v1")!;
  const audio = result.tracks.find((candidate) => candidate.trackId === "a1")!;
  assert.deepEqual(picture.items.slice(0, 2).map((value) => value.destination), [time(0, 6), time(6, 2)]);
  assert.deepEqual(audio.items.slice(0, 2).map((value) => value.destination), [time(0, 4), time(4, 4)]);
  assert.notEqual(result.materializationId, executeTimelineEditPlan(plan([{
    id: "dialogue_leads_picture",
    kind: "boundary-adjust",
    selection: {
      trackIds: ["v1", "a1"],
      originIds: ["picture_a", "picture_b", "audio_a", "audio_b"],
    },
    at: { picture: rational(5), audio: rational(5) },
    provenance,
  }])).materializationId);
});

test("terminal transitions consume exact declared handles and block later structural edits", () => {
  const picture = track("v1", "picture", 0, [
    item("v1", "picture", "left_picture", 0, 5, pictureView("left_picture_node", 2, 5, 2)),
    item("v1", "picture", "right_picture", 5, 5, pictureView("right_picture_node", 10, 5, 2)),
  ]);
  const audio = track("a1", "audio", 1, [
    item("a1", "audio", "left_audio", 0, 5, audioView("left_audio_node", 2, 5, 2)),
    item("a1", "audio", "right_audio", 5, 5, audioView("right_audio_node", 10, 5, 2)),
  ]);
  const transition: TimelineEditOperationV1 = {
    id: "av_transition",
    kind: "transition",
    left: { trackIds: ["v1", "a1"], originIds: ["left_picture", "left_audio"] },
    right: { trackIds: ["v1", "a1"], originIds: ["right_picture", "right_audio"] },
    at: { picture: rational(5), audio: rational(5) },
    duration: { picture: rational(2), audio: rational(1) },
    picture: { kind: "cross-dissolve" },
    audio: { curve: "equal-power" },
    provenance,
  };
  const result = executeTimelineEditPlan(plan([transition], [picture, audio]));
  assert.equal(result.transitions.length, 2);
  assert.deepEqual(result.transitions.find((value) => value.domain === "picture")?.outgoingSource, time(7, 1));
  assert.deepEqual(result.transitions.find((value) => value.domain === "picture")?.incomingSource, time(9, 1));
  assert.deepEqual(result.transitions.find((value) => value.domain === "audio")?.outgoingSource, { start: rational(7), duration: rational(1, 2) });
  assert.deepEqual(result.transitions.find((value) => value.domain === "audio")?.incomingSource, { start: rational(19, 2), duration: rational(1, 2) });

  expectError(
    () => executeTimelineEditPlan(plan([
      transition,
      {
        id: "too_late",
        kind: "lift",
        selection: { trackIds: ["a1"] },
        range: { audio: time(1, 1) },
        provenance,
      },
    ], [picture, audio])),
    "CUT_TIMELINE_EDIT_TRANSITION",
    /follows terminal transition/,
  );
});

test("hostile partial links, unsupported maps, invalid handles, and limits fail atomically", () => {
  const base = baseTracks();
  const snapshot = structuredClone(base);
  expectError(
    () => executeTimelineEditPlan(plan([{
      id: "orphan_audio",
      kind: "lift",
      selection: { trackIds: ["v1"], linkIds: ["take_a"] },
      range: { picture: time(1, 1) },
      provenance,
    }], base)),
    "CUT_TIMELINE_EDIT_LINK",
    /unselected track/,
  );
  assert.deepEqual(base, snapshot);

  const freeze = track("freeze_track", "picture", 0, [
    item("freeze_track", "picture", "freeze_item", 0, 10, {
      kind: "picture",
      nodeId: "freeze_node",
      source: time(4, 1),
      handles: { head: rational(1), tail: rational(1) },
      authorityId: "freeze_authority",
      timeMap: { kind: "freeze", at: rational(4) },
    }),
  ]);
  expectError(
    () => executeTimelineEditPlan(plan([{
      id: "bad_freeze_slip",
      kind: "slip",
      selection: { trackIds: ["freeze_track"], originIds: ["freeze_item"] },
      range: { picture: time(0, 10) },
      by: { picture: rational(1) },
      provenance,
    }], [freeze])),
    "CUT_TIMELINE_EDIT_UNSUPPORTED",
    /freeze or variable/,
  );

  const tinyHandles = track("tiny", "picture", 0, [
    item("tiny", "picture", "tiny_left", 0, 5, pictureView("tiny_left_node", 2, 5, 0)),
    item("tiny", "picture", "tiny_right", 5, 5, pictureView("tiny_right_node", 8, 5, 0)),
  ]);
  expectError(
    () => executeTimelineEditPlan(plan([{
      id: "bad_handles",
      kind: "transition",
      left: { trackIds: ["tiny"], originIds: ["tiny_left"] },
      right: { trackIds: ["tiny"], originIds: ["tiny_right"] },
      at: { picture: rational(5) },
      duration: { picture: rational(2) },
      picture: { kind: "cross-dissolve" },
      provenance,
    }], [tinyHandles])),
    "CUT_TIMELINE_EDIT_HANDLE",
    /handle/,
  );

  const tooMany = Array.from({ length: timelineEditLimits.maximumOperations + 1 }, (_unused, index): TimelineEditOperationV1 => ({
    id: `operation_${index}`,
    kind: "split",
    selection: { trackIds: ["v1"], originIds: ["picture_a"] },
    at: { picture: rational(1) },
    provenance,
  }));
  expectError(() => executeTimelineEditPlan(plan(tooMany)), "CUT_TIMELINE_EDIT_LIMIT", /1 through/);
});

test("implicit linked selections fail closed unless intentional unlinking is explicit", () => {
  expectError(
    () => executeTimelineEditPlan(plan([{
      id: "implicit_orphan",
      kind: "lift",
      selection: { trackIds: ["v1"], originIds: ["picture_a"] },
      range: { picture: time(1, 1) },
      provenance,
    }])),
    "CUT_TIMELINE_EDIT_LINK",
    /selected item link "take_a".*unselected track or range "a1"/,
  );

  const explicitlyUnlinked = executeTimelineEditPlan(plan([{
    id: "intentional_unlink",
    kind: "lift",
    selection: {
      trackIds: ["v1"],
      originIds: ["picture_a"],
      allowUnlinked: true,
    },
    range: { picture: time(1, 1) },
    provenance,
  }]));
  assert.equal(explicitlyUnlinked.tracks.find((candidate) => candidate.trackId === "v1")?.items[1]?.sourceView.kind, "gap");
  assert.deepEqual(
    explicitlyUnlinked.tracks.find((candidate) => candidate.trackId === "a1"),
    baseTracks().find((candidate) => candidate.trackId === "a1"),
  );
});

const irString = (value: string): IRValue => ({ kind: "string", value });
const irBool = (value: boolean): IRValue => ({ kind: "boolean", value });
const irTime = (value: number): IRValue => ({
  kind: "quantity",
  dimension: "time",
  magnitude: rational(value),
  unit: "s",
});
const irRatio = (numerator: number, denominator = 1): IRValue => ({
  kind: "quantity",
  dimension: "ratio",
  magnitude: rational(numerator, denominator),
  unit: "ratio",
});
const irStrings = (...values: string[]): IRValue => ({
  kind: "array",
  items: values.map(irString),
});
const irSelection = (
  entries: Record<string, IRValue> = {},
): IRValue => ({
  kind: "object",
  entries: {
    trackIds: irStrings("v1"),
    ...entries,
  },
});
const irAVTime = (value: number): IRValue => ({
  kind: "object",
  entries: { picture: irTime(value) },
});
const irOperation = (entries: Record<string, IRValue>): IRValue => ({
  kind: "object",
  entries,
});

function decodeHostile(entries: Record<string, IRValue>) {
  return timelineEditOperationsFromInput([irOperation(entries)], [provenance]);
}

test("operation-record decoding rejects hostile discriminants, styles, and opt-out shapes", () => {
  expectError(
    () => decodeHostile({
      kind: irString("split"),
      selection: irSelection({ relation: irString("near") }),
      at: irAVTime(1),
    }),
    "CUT_TIMELINE_EDIT_SHAPE",
    /overlaps, contained, or touches/,
  );
  expectError(
    () => decodeHostile({
      kind: irString("transition"),
      left: irSelection(),
      right: irSelection(),
      at: irAVTime(1),
      duration: irAVTime(1),
      pictureKind: irString("wipe"),
      pictureDirection: irString("diagonal"),
    }),
    "CUT_TIMELINE_EDIT_SHAPE",
    /left, right, up, or down/,
  );
  expectError(
    () => decodeHostile({
      kind: irString("transition"),
      left: irSelection(),
      right: irSelection(),
      at: irAVTime(1),
      duration: irAVTime(1),
      audioCurve: irString("logarithmic"),
    }),
    "CUT_TIMELINE_EDIT_SHAPE",
    /equal-power or linear/,
  );
  expectError(
    () => decodeHostile({
      kind: irString("transition"),
      left: irSelection(),
      right: irSelection(),
      at: irAVTime(1),
      duration: irAVTime(1),
      pictureKind: irString("cross-dissolve"),
      pictureSoftness: irRatio(1, 2),
    }),
    "CUT_TIMELINE_EDIT_SHAPE",
    /not valid for pictureKind/,
  );
  expectError(
    () => decodeHostile({
      kind: irString("split"),
      selection: irSelection({ allowUnlinked: irString("true") }),
      at: irAVTime(1),
    }),
    "CUT_TIMELINE_EDIT_SHAPE",
    /Bool/,
  );

  const decoded = decodeHostile({
    kind: irString("split"),
    selection: irSelection({ allowUnlinked: irBool(true) }),
    at: irAVTime(1),
  });
  assert.equal((decoded[0] as Extract<TimelineEditOperationV1, { kind: "split" }>).selection.allowUnlinked, true);
});

test("canonical linked insert consumes only explicit tail gaps and preserves exact source-view authority", () => {
  const picture = track("insert_v", "picture", 0, [
    item("insert_v", "picture", "source_picture", 0, 2, pictureView("source_picture_node", 3, 2, 1), "source_link"),
    item("insert_v", "picture", "body_picture", 2, 4, pictureView("body_picture_node", 8, 4), "body_link"),
    gap("insert_v", "picture", 6, 4),
  ]);
  const audio = track("insert_a", "audio", 1, [
    item("insert_a", "audio", "source_audio", 0, 2, audioView("source_audio_node", 3, 2, 1), "source_link"),
    item("insert_a", "audio", "body_audio", 2, 4, audioView("body_audio_node", 8, 4), "body_link"),
    gap("insert_a", "audio", 6, 4),
  ]);
  const operation: TimelineEditOperationV1 = {
    id: "coupled_insert",
    kind: "insert",
    targets: {
      picture: { trackIds: ["insert_v"] },
      audio: { trackIds: ["insert_a"] },
    },
    at: { picture: rational(2), audio: rational(2) },
    operand: {
      linkId: "inserted_take",
      parts: [
        {
          domain: "picture",
          sourceOriginId: "source_picture",
          originId: "inserted_picture",
          destinationDuration: rational(2),
          metadata: { "org.example.purpose": "picture-copy" },
        },
        {
          domain: "audio",
          sourceOriginId: "source_audio",
          originId: "inserted_audio",
          destinationDuration: rational(2),
          metadata: { "org.example.purpose": "audio-copy" },
        },
      ],
    },
    provenance,
  };
  const result = executeTimelineEditPlan(plan([operation], [picture, audio]));
  for (const target of result.tracks) {
    assert.deepEqual(target.items.map((entry) => entry.destination), [
      time(0, 2),
      time(2, 2),
      time(4, 4),
      time(8, 2),
    ]);
    const inserted = target.items[1]!;
    assert.equal(inserted.linkId, "inserted_take");
    assert.equal(inserted.originId, target.domain === "picture" ? "inserted_picture" : "inserted_audio");
    assert.equal(inserted.sourceView.authorityId, target.items[0]!.sourceView.authorityId);
    assert.equal(inserted.role, target.domain === "audio" ? "dialogue" : "picture");
    assert.deepEqual(inserted.metadata, {
      "org.example.purpose": target.domain === "picture" ? "picture-copy" : "audio-copy",
    });
    assert.equal(target.items.at(-1)?.sourceView.kind, "gap");
  }
});

test("overwrite preserves fixed duration while cloning processed and nested operand laws", () => {
  const processed = track("processed_target", "audio", 0, [
    item("processed_target", "audio", "processed_source", 0, 2, processedView("processed_region", 4, 2, 2)),
    gap("processed_target", "audio", 2, 8),
  ]);
  const nested = track("nested_target", "audiovisual", 1, [
    item("nested_target", "audiovisual", "nested_source", 0, 2, {
      kind: "nested",
      nodeId: "nested_node",
      compositionId: "nested_composition",
      source: time(1, 2),
      handles: { head: rational(0), tail: rational(0) },
      authorityId: "nested_authority",
      rate: rational(1),
      sharedClock: true,
      placementPolicy: "static-same-track-copy",
    }),
    gap("nested_target", "audiovisual", 2, 8),
  ]);
  const result = executeTimelineEditPlan(plan([{
    id: "processed_nested_overwrite",
    kind: "overwrite",
    targets: {
      audio: { trackIds: ["processed_target"] },
      audiovisual: { trackIds: ["nested_target"] },
    },
    at: { picture: rational(4), audio: rational(4) },
    operand: {
      linkId: "replacement_pair",
      parts: [
        {
          domain: "audio",
          sourceOriginId: "processed_source",
          originId: "processed_replacement",
          destinationDuration: rational(2),
          metadata: {},
        },
        {
          domain: "audiovisual",
          sourceOriginId: "nested_source",
          originId: "nested_replacement",
          destinationDuration: rational(2),
          metadata: {},
        },
      ],
    },
    provenance,
  }], [processed, nested]));
  const processedReplacement = result.tracks[0]!.items.find((entry) => entry.originId === "processed_replacement")!;
  const nestedReplacement = result.tracks[1]!.items.find((entry) => entry.originId === "nested_replacement")!;
  assert.deepEqual(processedReplacement.destination, time(4, 2));
  assert.equal(processedReplacement.sourceView.kind, "processed-audio");
  assert.equal((processedReplacement.sourceView as Extract<TimelineEditSourceView, { kind: "processed-audio" }>).statePolicy, "single-authorized-evaluation");
  assert.deepEqual(nestedReplacement.destination, time(4, 2));
  assert.equal(nestedReplacement.sourceView.kind, "nested");
  assert.equal((nestedReplacement.sourceView as Extract<TimelineEditSourceView, { kind: "nested" }>).sharedClock, true);
  assert.ok(result.tracks.every((entry) => entry.items.reduce(
    (sum, value) => sum + Number(value.destination.duration.numerator) / Number(value.destination.duration.denominator),
    0,
  ) === 10));
});

test("insert and overwrite refuse implicit unlinking, occupied tail closure, and mismatched domains", () => {
  const linkedPictureOnly: TimelineEditOperationV1 = {
    id: "linked_picture_only",
    kind: "overwrite",
    targets: { picture: { trackIds: ["v1"] } },
    at: { picture: rational(1) },
    operand: {
      parts: [{
        domain: "picture",
        sourceOriginId: "picture_a",
        originId: "replacement",
        destinationDuration: rational(4),
        metadata: {},
      }],
    },
    provenance,
  };
  expectError(() => executeTimelineEditPlan(plan([linkedPictureOnly])), "CUT_TIMELINE_EDIT_LINK", /omitted audio media/);

  const occupied = track("occupied", "picture", 0, [
    item("occupied", "picture", "source", 0, 2, pictureView("source_node", 0, 2)),
    item("occupied", "picture", "tail_media", 2, 8, pictureView("tail_node", 2, 8)),
  ]);
  expectError(() => executeTimelineEditPlan(plan([{
    id: "occupied_tail",
    kind: "insert",
    targets: { picture: { trackIds: ["occupied"], allowUnlinked: true } },
    at: { picture: rational(2) },
    operand: {
      parts: [{
        domain: "picture",
        sourceOriginId: "source",
        originId: "inserted",
        destinationDuration: rational(2),
        metadata: {},
      }],
    },
    provenance,
  }], [occupied])), "CUT_TIMELINE_EDIT_RESULT", /tail gap coverage/);

  expectError(() => executeTimelineEditPlan(plan([{
    ...linkedPictureOnly,
    id: "wrong_domain",
    targets: { picture: { trackIds: ["a1"], allowUnlinked: true } },
  }])), "CUT_TIMELINE_EDIT_SELECTION", /not picture/);
});

test("TimelineEdit metadata is a bounded non-CUT namespaced string map", () => {
  const invalid: Array<{
    metadata: Readonly<Record<string, string>>;
    code: TimelineEditError["code"];
    message: RegExp;
  }> = [
    {
      metadata: { owner: "fixture" },
      code: "CUT_TIMELINE_EDIT_SHAPE" as const,
      message: /metadata/u,
    },
    {
      metadata: { "CuT.private": "fixture" },
      code: "CUT_TIMELINE_EDIT_SHAPE" as const,
      message: /metadata/u,
    },
    {
      metadata: { "org.example.owner": "bad\nvalue" },
      code: "CUT_TIMELINE_EDIT_SHAPE" as const,
      message: /printable String/u,
    },
    {
      metadata: Object.fromEntries(Array.from(
        { length: timelineEditLimits.maximumMetadataEntries },
        (_, index) => [`org.example.field_${index}`, "é".repeat(512)],
      )),
      code: "CUT_TIMELINE_EDIT_LIMIT" as const,
      message: /text budget/u,
    },
  ];
  for (const entry of invalid) {
    const [first, ...rest] = baseTracks();
    const tracks = [{ ...first, metadata: entry.metadata }, ...rest];
    expectError(
      () => executeTimelineEditPlan(plan([{
        id: "validate_metadata",
        kind: "lift",
        selection: { trackIds: ["a2"] },
        range: { audio: time(3, 1) },
        provenance,
      }], tracks)),
      entry.code,
      entry.message,
    );
  }
});
