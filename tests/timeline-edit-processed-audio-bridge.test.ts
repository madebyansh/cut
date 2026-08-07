import assert from "node:assert/strict";
import test from "node:test";
import { rational } from "../lib/language/rational";
import type { IRProvenance } from "../lib/language/ir";
import {
  processedAudioGraphAuthorityIdentity,
  type ProcessedAudioGraphAuthorityContentV1,
} from "../lib/language/processed-audio-timeline-edit";
import {
  stageTimelineEditProcessedAudioBridgeV1,
  TimelineEditProcessedAudioBridgeError,
  timelineEditProcessedAudioBindingIdentity,
  type TimelineEditProcessedAudioAuthorityBindingV1,
} from "../lib/language/timeline-edit-processed-audio-bridge";
import type {
  TimelineEditItemV1,
  TimelineEditOperationV1,
  TimelineEditPlanV1,
  TimelineEditSourceView,
} from "../lib/language/timeline-edit-operations";

const digest = (character: string) => character.repeat(64);
const provenance: IRProvenance = {
  module: "bridge.cut",
  span: {
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 1, line: 1, column: 2 },
  },
};
const interval = (start: number, duration: number, denominator = 1) => ({
  start: rational(start, denominator),
  duration: rational(duration, denominator),
});

function binding(): TimelineEditProcessedAudioAuthorityBindingV1 {
  const authorityContent: ProcessedAudioGraphAuthorityContentV1 = {
    version: 1,
    graphIdentity: digest("1"),
    sourceIdentity: digest("2"),
    processorChainIdentity: digest("3"),
    sampleRate: 100,
    sourceSampleCount: 2_000,
    stateModel: "stateless",
  };
  const authority = {
    ...authorityContent,
    authorityIdentity: processedAudioGraphAuthorityIdentity(authorityContent),
  };
  const content = {
    version: 1 as const,
    timelineAuthorityId: "timeline_authority",
    graphAuthorityId: "graph_authority",
    regionId: "dialogue_region",
    sourceNodeId: "dialogue_source",
    processorNodeIds: ["dialogue_gain", "dialogue_eq"],
    processedAuthorityIdentity: authority.authorityIdentity,
  };
  return {
    ...content,
    bindingIdentity: timelineEditProcessedAudioBindingIdentity(content),
    authority,
  };
}

function view(sourceStart: number, duration: number): TimelineEditSourceView {
  return {
    kind: "processed-audio",
    regionId: "dialogue_region",
    sourceNodeId: "dialogue_source",
    processorNodeIds: ["dialogue_gain", "dialogue_eq"],
    graphAuthorityId: "graph_authority",
    source: interval(sourceStart, duration),
    handles: { head: rational(1), tail: rational(1) },
    authorityId: "timeline_authority",
    rate: rational(1),
    fadeIn: rational(1, 2),
    fadeOut: rational(1, 2),
    presentationClock: {
      originDuration: rational(duration),
      sliceOffset: rational(0),
      fadePolicy: "origin-relative",
    },
    statePolicy: "single-authorized-evaluation",
  };
}

function item(originId: string, start: number, duration: number, sourceStart: number): TimelineEditItemV1 {
  return {
    originId,
    segmentId: `segment_${originId}`,
    trackId: "dialogue",
    domain: "audio",
    linkId: "take",
    destination: interval(start, duration),
    sourceView: view(sourceStart, duration),
    role: "dialogue",
    metadata: {},
    provenance,
  };
}

function plan(operations: readonly TimelineEditOperationV1[]): TimelineEditPlanV1 {
  return {
    version: 1,
    id: "processed_edit",
    compositionId: "main",
    sceneId: "scene_main",
    initialDuration: rational(4),
    finalDuration: rational(4),
    tracks: [{
      trackId: "dialogue",
      domain: "audio",
      order: 0,
      duration: rational(4),
      role: "dialogue",
      metadata: {},
      items: [
        item("outgoing", 0, 2, 2),
        item("incoming", 2, 2, 6),
      ],
    }],
    operations,
    provenance,
  };
}

function evaluator(counter: { value: number }) {
  return (authority: ReturnType<typeof binding>["authority"]) => {
    counter.value += 1;
    return {
      authorityIdentity: authority.authorityIdentity,
      graphIdentity: authority.graphIdentity,
      sourceSampleCount: authority.sourceSampleCount,
      pcmIdentity: digest("4"),
    };
  };
}

test("canonical TimelineEdit slices bridge to one graph evaluation with origin-clock fades and exact J/L clocks", async () => {
  const splitOperations: TimelineEditOperationV1[] = [{
    id: "split_outgoing",
    kind: "split",
    selection: { trackIds: ["dialogue"], originIds: ["outgoing"] },
    at: { audio: rational(1) },
    provenance,
  }];
  const jlOperations: TimelineEditOperationV1[] = [{
    id: "move_audio_cut",
    kind: "boundary-adjust",
    selection: { trackIds: ["dialogue"], originIds: ["outgoing", "incoming"] },
    at: { picture: rational(2), audio: rational(9, 4) },
    provenance,
  }, {
    id: "jl_crossfade",
    kind: "transition",
    left: { trackIds: ["dialogue"], originIds: ["outgoing"] },
    right: { trackIds: ["dialogue"], originIds: ["incoming"] },
    at: { picture: rational(2), audio: rational(9, 4) },
    duration: { picture: rational(1, 2), audio: rational(1, 2) },
    audio: { curve: "equal-power" },
    provenance,
  }];
  const source = plan(splitOperations);
  const jlSource = plan(jlOperations);
  const snapshot = structuredClone(source);
  const jlSnapshot = structuredClone(jlSource);
  const selectedBinding = binding();
  const bindingSnapshot = structuredClone(selectedBinding);
  const count = { value: 0 };
  const first = await stageTimelineEditProcessedAudioBridgeV1(source, 100, [selectedBinding], evaluator(count));
  const second = await stageTimelineEditProcessedAudioBridgeV1(source, 100, [selectedBinding], evaluator(count));

  assert.deepEqual(source, snapshot);
  assert.deepEqual(jlSource, jlSnapshot);
  assert.deepEqual(selectedBinding, bindingSnapshot);
  assert.equal(count.value, 2, "one graph evaluation occurs per complete bridge invocation, not per segment");
  assert.equal(first.graphEvaluations.length, 1);
  assert.equal(first.graphEvaluations[0].count, 1);
  assert.equal(first.tracks[0].processedStage.graphEvaluations.length, 1);
  assert.equal(first.bridgeIdentity, second.bridgeIdentity);
  assert.equal(first.timelineMaterializationId, second.timelineMaterializationId);

  const outgoing = first.tracks[0].segments.filter((segment) => segment.originId === "outgoing");
  assert.equal(outgoing.length, 2);
  assert.equal(new Set(outgoing.map((segment) => segment.fadeAuthorityIdentity)).size, 1);
  assert.deepEqual(outgoing.map((segment) => segment.presentationOffsetSamples), [0, 100]);
  const processedItems = first.tracks[0].processedStage.items.filter((entry) => entry.kind === "processed");
  const secondSlice = processedItems.find((entry) => entry.id === outgoing[1].processedItemId);
  assert.ok(secondSlice?.kind === "processed");
  assert.equal(secondSlice.presentation.fadeIn, undefined, "the origin fade is outside the second slice and must not restart");

  const jl = await stageTimelineEditProcessedAudioBridgeV1(jlSource, 100, [selectedBinding], evaluator(count));
  assert.equal(count.value, 3);
  assert.equal(jl.transitions.length, 1);
  assert.equal(jl.transitions[0].pictureCutSample, 200);
  assert.equal(jl.transitions[0].audioCutSample, 225);
  assert.equal(jl.transitions[0].pictureDurationSamples, 50);
  assert.equal(jl.transitions[0].audioDurationSamples, 50);
  assert.notEqual(jl.transitions[0].pictureCutSample, jl.transitions[0].audioCutSample);
  assert.ok(jl.transitions[0].outgoingProcessedItemId);
  assert.ok(jl.transitions[0].incomingProcessedItemId);
});

test("exact grid, graph binding and retime mismatches fail before graph evaluation", async () => {
  const fixtures: Array<{
    source: TimelineEditPlanV1;
    selectedBinding: any;
    code: string;
  }> = [];
  const offGrid = plan([{
    id: "off_grid_split",
    kind: "split",
    selection: { trackIds: ["dialogue"], originIds: ["outgoing"] },
    at: { audio: rational(1, 3) },
    provenance,
  }]);
  fixtures.push({ source: offGrid, selectedBinding: binding(), code: "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID" });

  const mismatched = binding() as any;
  mismatched.graphAuthorityId = "other_graph";
  const mismatchContent = {
    version: 1 as const,
    timelineAuthorityId: mismatched.timelineAuthorityId,
    graphAuthorityId: mismatched.graphAuthorityId,
    regionId: mismatched.regionId,
    sourceNodeId: mismatched.sourceNodeId,
    processorNodeIds: mismatched.processorNodeIds,
    processedAuthorityIdentity: mismatched.processedAuthorityIdentity,
  };
  mismatched.bindingIdentity = timelineEditProcessedAudioBindingIdentity(mismatchContent);
  fixtures.push({
    source: plan([{
      id: "split",
      kind: "split",
      selection: { trackIds: ["dialogue"], originIds: ["outgoing"] },
      at: { audio: rational(1) },
      provenance,
    }]),
    selectedBinding: mismatched,
    code: "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY",
  });

  const retimed = structuredClone(plan([{
    id: "split",
    kind: "split",
    selection: { trackIds: ["dialogue"], originIds: ["outgoing"] },
    at: { audio: rational(1) },
    provenance,
  }])) as any;
  retimed.tracks[0].items[0].sourceView.rate = rational(2);
  fixtures.push({ source: retimed, selectedBinding: binding(), code: "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED" });

  for (const fixture of fixtures) {
    const count = { value: 0 };
    await assert.rejects(
      stageTimelineEditProcessedAudioBridgeV1(fixture.source, 100, [fixture.selectedBinding], evaluator(count)),
      (error: unknown) => error instanceof TimelineEditProcessedAudioBridgeError && error.code === fixture.code,
    );
    assert.equal(count.value, 0);
  }
});

test("TimelineEdit remains authoritative: bridge rejects direct audio instead of flattening it", async () => {
  const direct = structuredClone(plan([{
    id: "split",
    kind: "split",
    selection: { trackIds: ["dialogue"], originIds: ["outgoing"] },
    at: { audio: rational(1) },
    provenance,
  }])) as any;
  direct.tracks[0].items[1].sourceView = {
    kind: "audio",
    nodeId: "direct_audio",
    source: interval(6, 2),
    handles: { head: rational(1), tail: rational(1) },
    authorityId: "direct_authority",
    rate: rational(1),
    fadeIn: zero(),
    fadeOut: zero(),
    presentationClock: {
      originDuration: rational(2),
      sliceOffset: rational(0),
      fadePolicy: "origin-relative",
    },
  };
  const count = { value: 0 };
  await assert.rejects(
    stageTimelineEditProcessedAudioBridgeV1(direct, 100, [binding()], evaluator(count)),
    (error: unknown) => error instanceof TimelineEditProcessedAudioBridgeError
      && error.code === "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED",
  );
  assert.equal(count.value, 0);
});

function zero() {
  return rational(0);
}
