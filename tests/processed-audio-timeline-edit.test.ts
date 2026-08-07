import assert from "node:assert/strict";
import test from "node:test";
import {
  ProcessedAudioTimelineEditError,
  processedAudioGraphAuthorityIdentity,
  processedAudioTimelineEditLimits,
  stageProcessedAudioTimelineEditV1,
  type ProcessedAudioGraphAuthorityContentV1,
  type ProcessedAudioGraphAuthorityV1,
  type ProcessedAudioTimelinePlanV1,
} from "../lib/language/processed-audio-timeline-edit";

const digest = (character: string) => character.repeat(64);

function authority(
  overrides: Partial<ProcessedAudioGraphAuthorityContentV1> = {},
): ProcessedAudioGraphAuthorityV1 {
  const content: ProcessedAudioGraphAuthorityContentV1 = {
    version: 1,
    graphIdentity: digest("1"),
    sourceIdentity: digest("2"),
    processorChainIdentity: digest("3"),
    sampleRate: 48_000,
    sourceSampleCount: 20_000,
    stateModel: "stateless",
    ...overrides,
  };
  return { ...content, authorityIdentity: processedAudioGraphAuthorityIdentity(content) };
}

function processed(
  id: string,
  destination: { start: number; end: number },
  source: { start: number; end: number },
  selectedAuthority = authority(),
  linkId = "take",
) {
  return {
    kind: "processed" as const,
    id,
    authorityIdentity: selectedAuthority.authorityIdentity,
    destination,
    source,
    availableSource: { start: 0, end: selectedAuthority.sourceSampleCount },
    timeMap: { kind: "identity" as const },
    presentation: {
      fadeIn: { kind: "equal-power" as const, interval: { start: destination.start, end: destination.start + 100 } },
      fadeOut: { kind: "linear" as const, interval: { start: destination.end - 100, end: destination.end } },
    },
    linkId,
  };
}

function basePlan(): ProcessedAudioTimelinePlanV1 {
  const selectedAuthority = authority();
  return {
    version: 1,
    durationSamples: 4_000,
    authorities: [selectedAuthority],
    items: [
      processed("a", { start: 0, end: 2_000 }, { start: 1_000, end: 3_000 }, selectedAuthority),
      processed("b", { start: 2_000, end: 4_000 }, { start: 5_000, end: 7_000 }, selectedAuthority),
    ],
    operations: [],
  };
}

function mutablePlan(): any {
  return structuredClone(basePlan());
}

function evaluator(counter: { value: number }) {
  return (selectedAuthority: ProcessedAudioGraphAuthorityV1) => {
    counter.value += 1;
    return {
      authorityIdentity: selectedAuthority.authorityIdentity,
      graphIdentity: selectedAuthority.graphIdentity,
      sourceSampleCount: selectedAuthority.sourceSampleCount,
      pcmIdentity: digest("4"),
    };
  };
}

test("split, trim, lift and extract retain one authenticated processed graph and exact presentation slices", async () => {
  const plan = mutablePlan();
  plan.operations = [
    { kind: "split", itemId: "a", atSample: 1_000 },
  ];
  const untouched = structuredClone(plan);
  const count = { value: 0 };
  const first = await stageProcessedAudioTimelineEditV1(plan, evaluator(count));
  const second = await stageProcessedAudioTimelineEditV1(plan, evaluator(count));

  assert.deepEqual(plan, untouched, "staging cannot mutate caller-owned plan bytes");
  assert.equal(count.value, 2, "each complete invocation evaluates the shared graph once, not once per slice");
  assert.equal(first.graphEvaluations.length, 1);
  assert.equal(first.graphEvaluations[0].count, 1);
  assert.equal(first.items.length, 3);
  assert.ok(first.items.every((item) => item.kind !== "processed" || item.authorityIdentity === plan.authorities[0].authorityIdentity));
  assert.deepEqual(
    first.items.filter((item) => item.kind === "processed").map((item) => item.source),
    [{ start: 1_000, end: 2_000 }, { start: 2_000, end: 3_000 }, { start: 5_000, end: 7_000 }],
  );
  assert.equal(first.stageIdentity, second.stageIdentity);
  assert.deepEqual(first.sampleWitnesses, second.sampleWitnesses);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.items));

  const trim = mutablePlan();
  trim.operations = [{ kind: "trim", itemId: "a", keep: { start: 500, end: 1_500 } }];
  const trimmed = await stageProcessedAudioTimelineEditV1(trim, evaluator({ value: 0 }));
  const kept = trimmed.items.find((item) => item.kind === "processed" && item.destination.start === 500);
  assert.ok(kept && kept.kind === "processed");
  assert.deepEqual(kept.source, { start: 1_500, end: 2_500 });
  const originalFirst = basePlan().items[0];
  assert.ok(originalFirst.kind === "processed");
  assert.deepEqual(kept.presentation, originalFirst.presentation);

  const lift = mutablePlan();
  lift.operations = [{ kind: "lift", range: { start: 500, end: 2_500 } }];
  const lifted = await stageProcessedAudioTimelineEditV1(lift, evaluator({ value: 0 }));
  assert.equal(lifted.durationSamples, 4_000);
  assert.deepEqual(lifted.items.map((item) => [item.kind, item.destination]), [
    ["processed", { start: 0, end: 500 }],
    ["gap", { start: 500, end: 2_500 }],
    ["processed", { start: 2_500, end: 4_000 }],
  ]);

  const extract = mutablePlan();
  extract.operations = [{ kind: "extract", range: { start: 500, end: 2_500 } }];
  const extracted = await stageProcessedAudioTimelineEditV1(extract, evaluator({ value: 0 }));
  assert.equal(extracted.durationSamples, 2_000);
  assert.deepEqual(extracted.items.map((item) => item.destination), [
    { start: 0, end: 500 },
    { start: 500, end: 2_000 },
  ]);
});

test("a split windows one origin-clock fade instead of restarting the envelope on each presentation slice", async () => {
  const plan = mutablePlan();
  plan.operations = [{ kind: "split", itemId: "a", atSample: 1_000 }];
  const staged = await stageProcessedAudioTimelineEditV1(plan, evaluator({ value: 0 }));
  const slices = staged.items
    .filter((item: any) => item.kind === "processed" && item.linkId === "take")
    .slice(0, 2) as any[];
  assert.equal(slices.length, 2);
  assert.deepEqual(slices[0].presentation, slices[1].presentation);
  assert.deepEqual(slices[1].presentation.fadeIn.interval, { start: 0, end: 100 });

  const originClockLinearGain = (item: any, destinationSample: number) => {
    const fade = item.presentation.fadeIn;
    if (!fade || destinationSample >= fade.interval.end) return 1;
    if (destinationSample <= fade.interval.start) return 0;
    return (destinationSample - fade.interval.start) / (fade.interval.end - fade.interval.start);
  };
  const unitPcm = 1;
  assert.equal(unitPcm * originClockLinearGain(slices[0], 50), 0.5);
  assert.equal(unitPcm * originClockLinearGain(slices[1], 1_050), 1);
  const incorrectRestartedGain = (1_050 - slices[1].destination.start) / 100;
  assert.equal(incorrectRestartedGain, 0.5, "counterfactual slice-local fade would audibly restart");
  assert.notEqual(originClockLinearGain(slices[1], 1_050), incorrectRestartedGain);
});

test("slip, slide and boundary adjustment preserve processor identity, handles and distinct J/L clocks", async () => {
  const selectedAuthority = authority();
  const plan: ProcessedAudioTimelinePlanV1 = {
    version: 1,
    durationSamples: 6_000,
    authorities: [selectedAuthority],
    items: [
      processed("left", { start: 0, end: 2_000 }, { start: 2_000, end: 4_000 }, selectedAuthority, "dialogue"),
      processed("middle", { start: 2_000, end: 4_000 }, { start: 7_000, end: 9_000 }, selectedAuthority, "dialogue"),
      processed("right", { start: 4_000, end: 6_000 }, { start: 12_000, end: 14_000 }, selectedAuthority, "room-tone"),
    ],
    operations: [
      { kind: "slip", itemId: "middle", bySamples: 100 },
    ],
  };
  const count = { value: 0 };
  const staged = await stageProcessedAudioTimelineEditV1(plan, evaluator(count));
  assert.equal(count.value, 1);
  assert.ok(staged.items.every((item) => item.kind !== "processed" || item.authorityIdentity === selectedAuthority.authorityIdentity));
  const slippedMiddle = staged.items.find((item) => item.kind === "processed" && item.destination.start === 2_000);
  assert.ok(slippedMiddle?.kind === "processed");
  assert.deepEqual(slippedMiddle.source, { start: 7_100, end: 9_100 });

  const slidePlan = structuredClone(plan) as any;
  slidePlan.operations = [{ kind: "slide", itemId: "middle", bySamples: 100 }];
  const slid = await stageProcessedAudioTimelineEditV1(slidePlan, evaluator(count));
  assert.equal(count.value, 2, "each independent transaction evaluates the graph once");
  assert.deepEqual(slid.items.map((item) => item.destination), [
    { start: 0, end: 2_100 },
    { start: 2_100, end: 4_100 },
    { start: 4_100, end: 6_000 },
  ]);

  const jl = mutablePlan();
  jl.operations = [
    { kind: "boundary-adjust", leftItemId: "a", rightItemId: "b", bySamples: 200 },
  ];
  const adjusted = await stageProcessedAudioTimelineEditV1(jl, evaluator({ value: 0 }));
  const [outgoing, incoming] = adjusted.items;
  jl.items = adjusted.items;
  jl.operations = [{
    kind: "jl-transition",
    outgoingItemId: outgoing.id,
    incomingItemId: incoming.id,
    pictureCutSample: 2_000,
    audioCutSample: 2_200,
    durationSamples: 200,
    curve: "equal-power",
  }];
  const transitioned = await stageProcessedAudioTimelineEditV1(jl, evaluator({ value: 0 }));
  assert.equal(transitioned.transitions.length, 1);
  assert.equal(transitioned.transitions[0].pictureCutSample, 2_000);
  assert.equal(transitioned.transitions[0].audioCutSample, 2_200);
  assert.notEqual(transitioned.transitions[0].pictureCutSample, transitioned.transitions[0].audioCutSample);
  assert.deepEqual(transitioned.transitions[0].outgoingHandle, { start: 3_200, end: 3_300 });
  assert.deepEqual(transitioned.transitions[0].incomingHandle, { start: 5_100, end: 5_200 });
});

test("hostile authority mutation, stateful graphs and retime refuse atomically before graph evaluation", async () => {
  const cases: Array<{ mutate(plan: any): void; code: string }> = [
    {
      mutate: (plan) => { plan.authorities[0].graphIdentity = digest("9"); },
      code: "CUT_PROCESSED_AUDIO_EDIT_AUTHORITY",
    },
    {
      mutate: (plan) => {
        const stateful = authority({ stateModel: "stateful" });
        plan.authorities = [stateful];
        plan.items = plan.items.map((item: any) => item.kind === "processed"
          ? { ...item, authorityIdentity: stateful.authorityIdentity }
          : item);
        plan.operations = [{ kind: "split", itemId: "a", atSample: 1_000 }];
      },
      code: "CUT_PROCESSED_AUDIO_EDIT_UNSUPPORTED",
    },
    {
      mutate: (plan) => {
        plan.items[0].timeMap = { kind: "constant", numerator: 2, denominator: 1 };
        plan.operations = [{ kind: "split", itemId: "a", atSample: 1_000 }];
      },
      code: "CUT_PROCESSED_AUDIO_EDIT_UNSUPPORTED",
    },
  ];
  for (const fixture of cases) {
    const plan = mutablePlan();
    fixture.mutate(plan);
    const count = { value: 0 };
    await assert.rejects(
      stageProcessedAudioTimelineEditV1(plan, evaluator(count)),
      (error: unknown) => error instanceof ProcessedAudioTimelineEditError && error.code === fixture.code,
    );
    assert.equal(count.value, 0, "structural/authentication failure must precede graph evaluation");
  }
});

test("closed shapes, nonmutation and budgets fail without partial staging", async () => {
  const extra = structuredClone(basePlan()) as unknown as Record<string, unknown>;
  extra.ignored = true;
  await assert.rejects(
    stageProcessedAudioTimelineEditV1(extra, evaluator({ value: 0 })),
    (error: unknown) => error instanceof ProcessedAudioTimelineEditError
      && error.code === "CUT_PROCESSED_AUDIO_EDIT_SHAPE",
  );

  const accessor = mutablePlan();
  Object.defineProperty(accessor.operations, "0", { get() { throw new Error("must not execute"); } });
  await assert.rejects(
    stageProcessedAudioTimelineEditV1(accessor, evaluator({ value: 0 })),
    (error: unknown) => error instanceof ProcessedAudioTimelineEditError
      && error.code === "CUT_PROCESSED_AUDIO_EDIT_SHAPE",
  );

  const overBudget = mutablePlan();
  overBudget.operations = Array.from(
    { length: processedAudioTimelineEditLimits.maximumOperations + 1 },
    () => ({ kind: "lift" as const, range: { start: 1, end: 2 } }),
  );
  const count = { value: 0 };
  await assert.rejects(
    stageProcessedAudioTimelineEditV1(overBudget, evaluator(count)),
    (error: unknown) => error instanceof ProcessedAudioTimelineEditError
      && error.code === "CUT_PROCESSED_AUDIO_EDIT_LIMIT",
  );
  assert.equal(count.value, 0);
});
