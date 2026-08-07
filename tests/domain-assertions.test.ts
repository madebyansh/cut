import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCutDomainAssertion,
  evaluateCutDomainAssertions,
  type CutDomainAssertionPredicate,
} from "../lib/language/domain-assertions";
import type { CutAVIR, IRAssertion, IRComposition, IRScene, IRValue } from "../lib/language/ir";
import { rational, type Rational } from "../lib/language/rational";

const provenance = {
  module: "assertions.cut",
  span: {
    start: { offset: 60, line: 7, column: 5 },
    end: { offset: 120, line: 7, column: 65 },
  },
};

const timeline = (id = "main"): IRValue => ({ kind: "timeline-ref", id });
const time = (magnitude: Rational): IRValue => ({ kind: "quantity", dimension: "time", magnitude, unit: "s" });
const call = (
  op: CutDomainAssertionPredicate | string,
  positional: IRValue[],
  named: Record<string, IRValue> = {},
  effect: Extract<IRValue, { kind: "call" }>["effect"] = "pure",
): IRValue => ({ kind: "call", op, positional, named, effect });

function assertion(expression: IRValue, status: IRAssertion["status"] = "deferred", id = "assert_1"): IRAssertion {
  return { id, expression, status, provenance };
}

type SceneTiming = { id: string; start: Rational; duration: Rational };

function fixture({
  id = "main",
  duration = rational(2),
  fps = rational(24),
  sampleRate = 48_000,
  scenes = [
    { id: "one", start: rational(0), duration: rational(1) },
    { id: "two", start: rational(1), duration: rational(1) },
  ],
}: {
  id?: string;
  duration?: Rational;
  fps?: Rational;
  sampleRate?: number;
  scenes?: SceneTiming[];
} = {}): CutAVIR {
  const sceneRecord: Record<string, IRScene> = {};
  for (const scene of scenes) {
    sceneRecord[scene.id] = {
      ...scene,
      name: scene.id,
      rootVisualIds: [],
      rootAudioIds: [],
      rootAVIds: [],
      items: [],
      provenance,
    };
  }
  const composition: IRComposition = {
    id,
    name: id,
    width: 1920,
    height: 1080,
    fps,
    sampleRate,
    duration,
    sceneIds: scenes.map((scene) => scene.id),
    rootVisualIds: [],
    rootAudioIds: [],
    rootAVIds: [],
    items: scenes.map((scene) => ({ kind: "scene", id: scene.id })),
    provenance,
  };
  return {
    format: "cut-av-ir",
    version: 3,
    language: "0.4",
    compiler: "test",
    project: "domain assertion proof",
    sourceHash: "source",
    buildId: "build",
    determinism: { semantic: "unlocked", decodedMedia: "unverified", bitstream: "unverified" },
    timebase: { defaultFps: fps, audioSampleRate: sampleRate },
    modules: [],
    resources: {},
    compositions: [composition],
    scenes: sceneRecord,
    nodes: {},
    signals: {},
    jobs: [],
    outputs: [],
    assertions: [],
  };
}

function evaluate(ir: CutAVIR, expression: IRValue, stored: IRAssertion["status"] = "deferred") {
  return evaluateCutDomainAssertion(ir, assertion(expression, stored));
}

test("timeline duration uses exact rationals and never trusts stored assertion status", () => {
  const ir = fixture({ duration: rational(1001, 1000), scenes: [] });
  const exact = evaluate(ir, call("cut.assert.timeline_duration_is", [timeline(), time(rational(1001, 1000))]), "fail");
  assert.deepEqual(exact, {
    assertionId: "assert_1",
    source: { module: "assertions.cut", line: 7, column: 5, endLine: 7, endColumn: 65 },
    predicates: ["cut.assert.timeline_duration_is"],
    status: "pass",
    value: true,
  });
  const approximate = evaluate(ir, call("cut.assert.timeline_duration_is", [], { timeline: timeline(), duration: time(rational(1)) }), "pass");
  assert.equal(approximate.status, "fail");
  if (approximate.status === "fail") assert.equal(approximate.value, false);
});

test("NTSC frame and sample grids are tested with exact multiplication", () => {
  const ir = fixture({ duration: rational(1001, 1000), fps: rational(30_000, 1_001), sampleRate: 48_000, scenes: [] });
  const frame = (value: Rational) => call("cut.assert.time_is_on_frame_grid", [timeline(), time(value)]);
  const sample = (value: Rational) => call("cut.assert.time_is_on_sample_grid", [timeline(), time(value)]);
  assert.equal(evaluate(ir, frame(rational(1_001, 30_000))).status, "pass", "one 30000/1001 frame is exact");
  assert.equal(evaluate(ir, frame(rational(1, 30))).status, "fail", "1/30 second is not one NTSC frame");
  assert.equal(evaluate(ir, sample(rational(1, 48_000))).status, "pass", "one sample is exact");
  assert.equal(evaluate(ir, sample(rational(1_001, 30_000))).status, "fail", "one NTSC frame is 8008/5 samples");

  const both: IRValue = { kind: "binary", operator: "&&", left: frame(rational(1_001, 6_000)), right: sample(rational(1_001, 6_000)) };
  const result = evaluate(ir, both);
  assert.equal(result.status, "pass", "five NTSC frames land on sample 8008");
  assert.deepEqual(result.predicates, ["cut.assert.time_is_on_frame_grid", "cut.assert.time_is_on_sample_grid"]);
});

test("scene coverage distinguishes touching boundaries, gaps, and overlaps", () => {
  const gaps = (ir: CutAVIR) => evaluate(ir, call("cut.assert.timeline_has_no_scene_gaps", [timeline()]));
  const overlaps = (ir: CutAVIR) => evaluate(ir, call("cut.assert.timeline_has_no_scene_overlaps", [timeline()]));

  const touching = fixture();
  assert.equal(gaps(touching).status, "pass");
  assert.equal(overlaps(touching).status, "pass", "half-open scene boundaries may touch exactly");

  const withGap = fixture({ scenes: [
    { id: "one", start: rational(0), duration: rational(1) },
    { id: "two", start: rational(3, 2), duration: rational(1, 2) },
  ] });
  assert.equal(gaps(withGap).status, "fail");
  assert.equal(overlaps(withGap).status, "pass");

  const withOverlap = fixture({ scenes: [
    { id: "one", start: rational(0), duration: rational(3, 2) },
    { id: "two", start: rational(1), duration: rational(1) },
  ] });
  assert.equal(gaps(withOverlap).status, "pass", "overlap does not manufacture an uncovered interval");
  assert.equal(overlaps(withOverlap).status, "fail");
});

test("coverage is independent of composition and scene serialization order", () => {
  const ir = fixture({ scenes: [
    { id: "first", start: rational(0), duration: rational(4, 3) },
    { id: "middle", start: rational(1), duration: rational(1, 3) },
    { id: "last", start: rational(4, 3), duration: rational(2, 3) },
  ] });
  const irrelevant = fixture({ id: "other", duration: rational(0), scenes: [] }).compositions[0];
  ir.compositions.unshift(irrelevant);
  ir.compositions[1]!.sceneIds.reverse();
  ir.compositions[1]!.items.reverse();
  const noGap = evaluate(ir, call("cut.assert.timeline_has_no_scene_gaps", [timeline()]));
  const noOverlap = evaluate(ir, call("cut.assert.timeline_has_no_scene_overlaps", [timeline()]));
  assert.equal(noGap.status, "pass");
  assert.equal(noOverlap.status, "fail");

  const replay = evaluate(structuredClone(ir), call("cut.assert.timeline_has_no_scene_gaps", [timeline()]));
  assert.deepEqual(replay, noGap, "the result is deterministic across independent object graphs");
});

test("an empty zero-duration timeline has no gap or overlap; a positive empty timeline is one gap", () => {
  const zero = fixture({ duration: rational(0), scenes: [] });
  const positive = fixture({ duration: rational(1), scenes: [] });
  for (const ir of [zero, positive]) {
    assert.equal(evaluate(ir, call("cut.assert.timeline_has_no_scene_overlaps", [timeline()])).status, "pass");
  }
  assert.equal(evaluate(zero, call("cut.assert.timeline_has_no_scene_gaps", [timeline()])).status, "pass");
  assert.equal(evaluate(positive, call("cut.assert.timeline_has_no_scene_gaps", [timeline()])).status, "fail");
});

test("bounded boolean composition supports !, &&, and || without hiding unsupported predicates", () => {
  const ir = fixture();
  const noGap = call("cut.assert.timeline_has_no_scene_gaps", [timeline()]);
  const duration = call("cut.assert.timeline_duration_is", [timeline(), time(rational(2))]);
  const composed: IRValue = {
    kind: "binary",
    operator: "&&",
    left: noGap,
    right: { kind: "unary", operator: "!", value: { kind: "unary", operator: "!", value: duration } },
  };
  assert.equal(evaluate(ir, composed).status, "pass");

  const hiddenUnknown: IRValue = {
    kind: "binary",
    operator: "||",
    left: { kind: "boolean", value: true },
    right: call("third.party.assertion", []),
  };
  const unsupported = evaluate(ir, hiddenUnknown);
  assert.equal(unsupported.status, "unsupported", "strict evaluation prevents unsupported semantics from being short-circuited away");
  if (unsupported.status === "unsupported") assert.equal(unsupported.code, "CUT_ASSERT_UNSUPPORTED_PREDICATE");
});

test("recognized predicates fail closed with stable source-located call and argument diagnostics", () => {
  const ir = fixture();
  const cases: Array<[IRValue, string]> = [
    [call("cut.assert.timeline_duration_is", [timeline()]), "CUT_ASSERT_ARGUMENT"],
    [call("cut.assert.timeline_duration_is", [timeline(), time(rational(2))], {}, "external"), "CUT_ASSERT_CALL_SHAPE"],
    [call("cut.assert.timeline_duration_is", [{ kind: "string", value: "main" }, time(rational(2))]), "CUT_ASSERT_ARGUMENT"],
    [call("cut.assert.timeline_duration_is", [timeline("missing"), time(rational(2))]), "CUT_ASSERT_TIMELINE_REFERENCE"],
    [call("cut.assert.timeline_duration_is", [timeline(), { kind: "quantity", dimension: "scalar", magnitude: rational(2), unit: "scalar" }]), "CUT_ASSERT_TIME_ARGUMENT"],
  ];
  for (const [expression, code] of cases) {
    const result = evaluate(ir, expression);
    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.equal(result.diagnostic.code, code);
      assert.deepEqual(result.diagnostic.source, { module: "assertions.cut", line: 7, column: 5, endLine: 7, endColumn: 65 });
      assert.match(result.diagnostic.message, /assertions\.cut.*:7:5/u);
    }
  }
});

test("hostile names and rationals are bounded before diagnostic amplification or BigInt work", () => {
  const ir = fixture();
  const hostileName = `bad\0\n${"x".repeat(20_000)}😀`;
  const named = Object.create(null) as Record<string, IRValue>;
  named.timeline = timeline();
  named.duration = time(rational(2));
  named[hostileName] = { kind: "boolean", value: true };
  const badName = evaluate(ir, call("cut.assert.timeline_duration_is", [], named));
  assert.equal(badName.status, "error");
  if (badName.status === "error") {
    assert.equal(badName.diagnostic.code, "CUT_ASSERT_ARGUMENT");
    assert.ok(badName.diagnostic.message.length < 1_024);
    assert.doesNotMatch(badName.diagnostic.message, /[\0\n]/u);
    assert.match(badName.diagnostic.message, /\\u0000\\n/u);
  }

  const huge = "9".repeat(20_000);
  const badRational = evaluate(ir, call("cut.assert.timeline_duration_is", [timeline(), {
    kind: "quantity",
    dimension: "time",
    unit: "s",
    magnitude: { numerator: huge, denominator: "1" },
  }]));
  assert.equal(badRational.status, "error");
  if (badRational.status === "error") {
    assert.equal(badRational.diagnostic.code, "CUT_ASSERT_BUDGET");
    assert.ok(badRational.diagnostic.message.length < 1_024);
    assert.doesNotMatch(badRational.diagnostic.message, new RegExp(huge.slice(0, 100)));
  }

  const unknown = evaluate(ir, call(`unknown\0${"z".repeat(20_000)}😀`, []));
  assert.equal(unknown.status, "unsupported");
  if (unknown.status === "unsupported") {
    assert.ok(unknown.message.length < 1_024);
    assert.doesNotMatch(unknown.message, /\0/u);
  }

  const boundary = `unknown.${"a".repeat(87)}😀${"b".repeat(20)}`;
  const boundaryResult = evaluate(ir, call(boundary, []));
  assert.equal(boundaryResult.status, "unsupported");
  if (boundaryResult.status === "unsupported") {
    assert.match(boundaryResult.message, /😀/u, "the 96th scalar remains a complete supplementary code point");
    assert.doesNotMatch(boundaryResult.message, /\uFFFD/u);
    assert.equal(Buffer.from(boundaryResult.message, "utf8").toString("utf8"), boundaryResult.message, "diagnostic is valid UTF-8");
  }
});

test("malformed exact rationals and timeline scene graphs are rejected rather than coerced", () => {
  const badDuration = fixture();
  badDuration.compositions[0]!.duration = { numerator: "2", denominator: "2" };
  const durationResult = evaluate(badDuration, call("cut.assert.timeline_duration_is", [timeline(), time(rational(1))]));
  assert.equal(durationResult.status, "error");
  if (durationResult.status === "error") assert.equal(durationResult.diagnostic.code, "CUT_ASSERT_RATIONAL");

  const missing = fixture();
  delete missing.scenes.two;
  const missingResult = evaluate(missing, call("cut.assert.timeline_has_no_scene_gaps", [timeline()]));
  assert.equal(missingResult.status, "error");
  if (missingResult.status === "error") assert.equal(missingResult.diagnostic.code, "CUT_ASSERT_TIMELINE_GRAPH");

  const repeated = fixture();
  repeated.compositions[0]!.sceneIds.push("two");
  const repeatedResult = evaluate(repeated, call("cut.assert.timeline_has_no_scene_overlaps", [timeline()]));
  assert.equal(repeatedResult.status, "error");

  const outside = fixture();
  outside.scenes.two.duration = rational(2);
  const outsideResult = evaluate(outside, call("cut.assert.timeline_has_no_scene_gaps", [timeline()]));
  assert.equal(outsideResult.status, "error");
  if (outsideResult.status === "error") assert.equal(outsideResult.diagnostic.code, "CUT_ASSERT_TIMELINE_GRAPH");

  const zeroLength = fixture();
  zeroLength.scenes.two.duration = rational(0);
  const zeroLengthResult = evaluate(zeroLength, call("cut.assert.timeline_has_no_scene_overlaps", [timeline()]));
  assert.equal(zeroLengthResult.status, "error");
  if (zeroLengthResult.status === "error") assert.equal(zeroLengthResult.diagnostic.code, "CUT_ASSERT_TIMELINE_GRAPH");
});

test("cycles and configurable expression, predicate, scene, rational, and aggregate budgets fail closed", () => {
  const ir = fixture();
  const cycle = { kind: "unary", operator: "!" } as unknown as Extract<IRValue, { kind: "unary" }>;
  cycle.value = cycle;
  const cyclic = evaluateCutDomainAssertion(ir, assertion(cycle));
  assert.equal(cyclic.status, "error");
  if (cyclic.status === "error") assert.equal(cyclic.diagnostic.code, "CUT_ASSERT_CYCLE");

  const nested: IRValue = { kind: "unary", operator: "!", value: { kind: "unary", operator: "!", value: { kind: "boolean", value: true } } };
  const depth = evaluateCutDomainAssertion(ir, assertion(nested), { limits: { maxExpressionDepth: 2 } });
  assert.equal(depth.status, "error");
  if (depth.status === "error") assert.equal(depth.diagnostic.code, "CUT_ASSERT_BUDGET");

  const nodes = evaluateCutDomainAssertion(ir, assertion(nested), { limits: { maxExpressionNodes: 2 } });
  assert.equal(nodes.status, "error");
  if (nodes.status === "error") assert.equal(nodes.diagnostic.code, "CUT_ASSERT_BUDGET");

  const twoCalls: IRValue = { kind: "binary", operator: "&&", left: call("cut.assert.timeline_has_no_scene_gaps", [timeline()]), right: call("cut.assert.timeline_has_no_scene_overlaps", [timeline()]) };
  const calls = evaluateCutDomainAssertion(ir, assertion(twoCalls), { limits: { maxPredicateCalls: 1 } });
  assert.equal(calls.status, "error");

  const scenes = evaluateCutDomainAssertion(ir, assertion(call("cut.assert.timeline_has_no_scene_gaps", [timeline()])), { limits: { maxScenesPerTimeline: 1 } });
  assert.equal(scenes.status, "error");

  const rationalBudget = evaluateCutDomainAssertion(ir, assertion(call("cut.assert.timeline_duration_is", [timeline(), time(rational(2))])), { limits: { maxRationalDigits: 1 } });
  assert.equal(rationalBudget.status, "pass");
  const tooManyDigits = fixture({ duration: rational(10), scenes: [] });
  const rationalExceeded = evaluateCutDomainAssertion(tooManyDigits, assertion(call("cut.assert.timeline_duration_is", [timeline(), time(rational(10))])), { limits: { maxRationalDigits: 1 } });
  assert.equal(rationalExceeded.status, "error");

  const batch = fixture();
  batch.assertions = [assertion({ kind: "boolean", value: true }, "fail", "a"), assertion({ kind: "boolean", value: true }, "fail", "b")];
  const report = evaluateCutDomainAssertions(batch, { limits: { maxAssertions: 1 } });
  assert.equal(report.status, "error");
  assert.deepEqual(report.results, []);
  assert.equal(report.diagnostic?.code, "CUT_ASSERT_BUDGET");

  const sharedNodes = fixture();
  sharedNodes.assertions = [
    assertion({ kind: "boolean", value: true }, "fail", "a"),
    assertion({ kind: "boolean", value: true }, "fail", "b"),
  ];
  const sharedNodeReport = evaluateCutDomainAssertions(sharedNodes, { limits: { maxExpressionNodes: 1 } });
  assert.equal(sharedNodeReport.status, "error");
  assert.deepEqual(sharedNodeReport.results.map((result) => result.status), ["pass", "error"]);
  assert.equal(sharedNodeReport.diagnostic?.code, "CUT_ASSERT_BUDGET");

  const sharedCalls = fixture();
  sharedCalls.assertions = [
    assertion(call("cut.assert.timeline_has_no_scene_gaps", [timeline()]), "fail", "a"),
    assertion(call("cut.assert.timeline_has_no_scene_overlaps", [timeline()]), "fail", "b"),
  ];
  const sharedCallReport = evaluateCutDomainAssertions(sharedCalls, { limits: { maxPredicateCalls: 1 } });
  assert.equal(sharedCallReport.status, "error");
  assert.deepEqual(sharedCallReport.results.map((result) => result.status), ["pass", "error"]);
  assert.equal(sharedCallReport.diagnostic?.code, "CUT_ASSERT_BUDGET");
});

test("aggregate evaluation recomputes all statuses and reports unsupported as an error gate", () => {
  const ir = fixture();
  ir.assertions = [
    assertion(call("cut.assert.timeline_duration_is", [timeline(), time(rational(2))]), "fail", "pass"),
    assertion(call("cut.assert.timeline_duration_is", [timeline(), time(rational(3))]), "pass", "fail"),
    assertion(call("unknown.assert", []), "pass", "unsupported"),
  ];
  const report = evaluateCutDomainAssertions(ir);
  assert.equal(report.status, "error");
  assert.deepEqual(report.counts, { pass: 1, fail: 1, unsupported: 1, error: 0 });
  assert.deepEqual(report.results.map((result) => result.status), ["pass", "fail", "unsupported"]);
});
