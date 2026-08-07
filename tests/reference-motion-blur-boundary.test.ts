import assert from "node:assert/strict";
import test from "node:test";
import type { IRNode, IRValue } from "../lib/language/ir";
import { rational, type Rational } from "../lib/language/rational";
import {
  createReferenceMotionBlurBoundaryPlan,
  prepareReferenceMotionBlurBoundary,
} from "../lib/runtime/reference/motion-blur-boundary";
import { ReferenceMotionBlurError, type ReferenceMotionBlurConfig } from "../lib/runtime/reference/motion-blur";

const provenance = {
  module: "boundary-study.cut",
  span: {
    start: { offset: 10, line: 3, column: 5 },
    end: { offset: 20, line: 3, column: 15 },
  },
};

function interval(start: Rational, end: Rational) {
  return { start, duration: rational(
    BigInt(end.numerator) * BigInt(start.denominator) - BigInt(start.numerator) * BigInt(end.denominator),
    BigInt(end.denominator) * BigInt(start.denominator),
  ) };
}

function nodes(options: {
  nodeStart?: Rational;
  nodeEnd?: Rational;
  childStart?: Rational;
  childEnd?: Rational;
  startEdge?: unknown;
  extraInputs?: Record<string, unknown>;
} = {}) {
  const nodeStart = options.nodeStart ?? rational(0), nodeEnd = options.nodeEnd ?? rational(1);
  const childStart = options.childStart ?? nodeStart, childEnd = options.childEnd ?? nodeEnd;
  const inputs: Record<string, IRValue> = {
    shutterAngle: { kind: "quantity", dimension: "angle", magnitude: rational(360), unit: "deg" },
    samples: { kind: "quantity", dimension: "scalar", magnitude: rational(4), unit: "scalar" },
  };
  if (options.startEdge !== undefined) inputs.startEdge = options.startEdge as IRValue;
  Object.assign(inputs, options.extraInputs);
  const child: IRNode = {
    id: "child",
    op: "cut.visual.rect",
    domain: "visual",
    ownership: "child",
    sceneId: "scene",
    interval: interval(childStart, childEnd),
    inputs: {}, children: [], properties: {}, effects: ["pure"], contentHash: "child-hash", provenance,
  };
  const node: IRNode = {
    id: "blur",
    op: "cut.visual.motion_blur",
    domain: "visual",
    ownership: "detached",
    sceneId: "scene",
    interval: interval(nodeStart, nodeEnd),
    inputs, children: [child.id], properties: {}, effects: ["pure"], contentHash: "blur-hash", provenance,
  };
  return { node, child };
}

const motion = (angle = 360, samples = 4): ReferenceMotionBlurConfig => ({ shutterAngle: rational(angle), samples });

function expectCode(work: () => unknown, code: ReferenceMotionBlurError["code"], pattern?: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceMotionBlurError);
    assert.equal(error.code, code);
    assert.deepEqual(error.source, { module: "boundary-study.cut", line: 3, column: 5, nodeId: "blur" });
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("omitted policy preserves the exact transparent start boundary", () => {
  const { node, child } = nodes();
  const config = prepareReferenceMotionBlurBoundary(node, child, rational(1, 4), motion());
  assert.equal(config.startEdge, "transparent");
  assert.equal(config.authoredStartEdge, false);
  assert.deepEqual(config.reachability, {
    firstOwnedOutputTime: rational(0),
    earliestShutterTime: rational(-3, 32),
    affectedStartSamples: 2,
  });
  const plan = createReferenceMotionBlurBoundaryPlan(node, child, rational(0), config);
  assert.deepEqual(plan.samples.map((sample) => sample.disposition), [
    "transparent-start", "transparent-start", "inside", "inside",
  ]);
  assert.deepEqual(plan.samples.map((sample) => sample.sourceTime), [
    null, null, rational(1, 32), rational(3, 32),
  ]);
  assert.equal(plan.heldStartSamples, 0);
  assert.equal(plan.transparentStartSamples, 2);
});

test("hold maps only pre-start shutter samples to the exact direct-child start", () => {
  const { node, child } = nodes({ startEdge: { kind: "string", value: "hold" } });
  const config = prepareReferenceMotionBlurBoundary(node, child, rational(1, 4), motion());
  const plan = createReferenceMotionBlurBoundaryPlan(node, child, rational(0), config);
  assert.equal(config.startEdge, "hold");
  assert.equal(config.authoredStartEdge, true);
  assert.deepEqual(plan.samples.map((sample) => sample.disposition), ["held-start", "held-start", "inside", "inside"]);
  assert.deepEqual(plan.samples.map((sample) => sample.sourceTime), [rational(0), rational(0), rational(1, 32), rational(3, 32)]);
  assert.equal(plan.heldStartSamples, 2);
  assert.equal(plan.samples.length, 4, "holding changes no shutter/sample work bound");
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.childInterval) && Object.isFrozen(plan) && Object.isFrozen(plan.samples));
});

test("the planned spatial and product proof shutters have exact reachable start holds", () => {
  const spatial = nodes({ startEdge: { kind: "string", value: "hold" } });
  const spatialConfig = prepareReferenceMotionBlurBoundary(spatial.node, spatial.child, rational(1, 24), motion(100, 4));
  const spatialPlan = createReferenceMotionBlurBoundaryPlan(spatial.node, spatial.child, rational(0), spatialConfig);
  assert.deepEqual(spatialPlan.samples.map((sample) => sample.shutterTime), [
    rational(-5, 1_152), rational(-5, 3_456), rational(5, 3_456), rational(5, 1_152),
  ]);
  assert.equal(spatialPlan.heldStartSamples, 2, "four-planes additive v5 intent has two exact held samples at 24fps/100deg/4");

  const product = nodes({ startEdge: { kind: "string", value: "hold" } });
  const productConfig = prepareReferenceMotionBlurBoundary(product.node, product.child, rational(1, 30), motion(180, 8));
  const productPlan = createReferenceMotionBlurBoundaryPlan(product.node, product.child, rational(0), productConfig);
  assert.deepEqual(productPlan.samples.map((sample) => sample.shutterTime), [
    rational(-7, 960), rational(-5, 960), rational(-3, 960), rational(-1, 960),
    rational(1, 960), rational(3, 960), rational(5, 960), rational(7, 960),
  ]);
  assert.equal(productPlan.heldStartSamples, 4, "unrelated bright 1:1 product/type intent has four held samples at 30fps/180deg/8");
  assert.equal(productPlan.samples.length, 8);
});

test("hold respects child temporal ownership and cannot fill an intentional earlier gap", () => {
  const { node, child } = nodes({
    childStart: rational(1, 2),
    startEdge: { kind: "string", value: "hold" },
  });
  const config = prepareReferenceMotionBlurBoundary(node, child, rational(1, 4), motion());
  const before = createReferenceMotionBlurBoundaryPlan(node, child, rational(1, 4), config);
  assert.equal(before.outputOwnsChild, false);
  assert.ok(before.samples.every((sample) => sample.sourceTime === null && sample.disposition === "transparent-start"));

  const boundary = createReferenceMotionBlurBoundaryPlan(node, child, rational(1, 2), config);
  assert.equal(boundary.outputOwnsChild, true);
  assert.deepEqual(boundary.samples.map((sample) => sample.disposition), ["held-start", "held-start", "inside", "inside"]);
  assert.deepEqual(boundary.samples.slice(0, 2).map((sample) => sample.sourceTime), [rational(1, 2), rational(1, 2)]);
});

test("the half-open end remains transparent, including a sample exactly at end", () => {
  const { node, child } = nodes({
    childEnd: rational(13, 16),
    startEdge: { kind: "string", value: "hold" },
  });
  const config = prepareReferenceMotionBlurBoundary(node, child, rational(1, 4), motion(360, 2));
  const plan = createReferenceMotionBlurBoundaryPlan(node, child, rational(3, 4), config);
  assert.deepEqual(plan.samples.map((sample) => sample.shutterTime), [rational(11, 16), rational(13, 16)]);
  assert.deepEqual(plan.samples.map((sample) => sample.disposition), ["inside", "transparent-end"]);
  assert.deepEqual(plan.samples.map((sample) => sample.sourceTime), [rational(11, 16), null]);
  assert.equal(plan.transparentEndSamples, 1);
});

test("an authored transparent default and an unreachable hold are both exact no-ops", () => {
  const redundant = nodes({ startEdge: { kind: "string", value: "transparent" } });
  expectCode(
    () => prepareReferenceMotionBlurBoundary(redundant.node, redundant.child, rational(1, 4), motion()),
    "CUT_MOTION_BLUR_NOOP",
    /repeats the omitted default/,
  );

  const unreachable = {
    nodeStart: rational(1, 8),
    childStart: rational(1, 8),
    nodeEnd: rational(1),
    childEnd: rational(1),
  };
  const authored = nodes({ ...unreachable, startEdge: { kind: "string", value: "hold" } });
  expectCode(
    () => prepareReferenceMotionBlurBoundary(authored.node, authored.child, rational(1, 4), motion(180, 2)),
    "CUT_MOTION_BLUR_NOOP",
    /never affects an exact shutter sample/,
  );

  const { node, child } = nodes(unreachable);
  const implicit = prepareReferenceMotionBlurBoundary(node, child, rational(1, 4), motion(180, 2));
  assert.equal(implicit.startEdge, "transparent");
  assert.equal(implicit.reachability.affectedStartSamples, 0);
});

test("post-roll and symmetric holds are refused rather than assigned an invented epsilon", () => {
  for (const extraInputs of [
    { endEdge: { kind: "string", value: "hold" } },
    { edge: { kind: "string", value: "hold" } },
  ]) {
    const { node, child } = nodes({ extraInputs });
    expectCode(
      () => prepareReferenceMotionBlurBoundary(node, child, rational(1, 4), motion()),
      "CUT_MOTION_BLUR_CONFIG",
      /half-open|no exact final instant/,
    );
  }
});

test("invalid policies, graph drift, interval escape, and output escape fail source-located", () => {
  const hostile = `${"x\n".repeat(20_000)}secret`;
  const invalid = nodes({ startEdge: { kind: "string", value: hostile } });
  expectCode(
    () => prepareReferenceMotionBlurBoundary(invalid.node, invalid.child, rational(1, 4), motion()),
    "CUT_MOTION_BLUR_CONFIG",
    /sha256:/,
  );

  const wrongChild = nodes({ startEdge: { kind: "string", value: "hold" } });
  wrongChild.node.children = ["someone-else"];
  expectCode(
    () => prepareReferenceMotionBlurBoundary(wrongChild.node, wrongChild.child, rational(1, 4), motion()),
    "CUT_MOTION_BLUR_PLAN",
    /one exact direct visual child/,
  );

  const escaped = nodes({
    nodeStart: rational(1, 4), childStart: rational(0),
    startEdge: { kind: "string", value: "hold" },
  });
  expectCode(
    () => prepareReferenceMotionBlurBoundary(escaped.node, escaped.child, rational(1, 4), motion()),
    "CUT_MOTION_BLUR_PLAN",
    /contained by the wrapper/,
  );

  const valid = nodes({ startEdge: { kind: "string", value: "hold" } });
  const config = prepareReferenceMotionBlurBoundary(valid.node, valid.child, rational(1, 4), motion());
  expectCode(
    () => createReferenceMotionBlurBoundaryPlan(valid.node, valid.child, rational(1), config),
    "CUT_MOTION_BLUR_PLAN",
    /outside the wrapper's half-open interval/,
  );
  const drifted = structuredClone(valid.node);
  drifted.children = ["new-child"];
  expectCode(
    () => createReferenceMotionBlurBoundaryPlan(drifted, valid.child, rational(0), config),
    "CUT_MOTION_BLUR_PLAN",
    /no longer matches/,
  );

  const staleChild = structuredClone(valid.child);
  staleChild.interval = interval(rational(1, 8), rational(1));
  expectCode(
    () => createReferenceMotionBlurBoundaryPlan(valid.node, staleChild, rational(0), config),
    "CUT_MOTION_BLUR_PLAN",
    /no longer matches.*half-open intervals/,
  );
});

test("resolved policy, timing, and exact mapping participate in deterministic identity", () => {
  const implicitNodes = nodes();
  const holdNodes = nodes({ startEdge: { kind: "string", value: "hold" } });
  const implicit = prepareReferenceMotionBlurBoundary(implicitNodes.node, implicitNodes.child, rational(1, 4), motion());
  const repeatedImplicit = prepareReferenceMotionBlurBoundary(
    structuredClone(implicitNodes.node),
    structuredClone(implicitNodes.child),
    rational(1, 4),
    motion(),
  );
  const hold = prepareReferenceMotionBlurBoundary(holdNodes.node, holdNodes.child, rational(1, 4), motion());
  assert.equal(implicit.semanticIdentity, repeatedImplicit.semanticIdentity);
  assert.notEqual(implicit.semanticIdentity, hold.semanticIdentity, "executed hold policy changes semantic identity");

  const first = createReferenceMotionBlurBoundaryPlan(holdNodes.node, holdNodes.child, rational(0), hold);
  const second = createReferenceMotionBlurBoundaryPlan(
    structuredClone(holdNodes.node),
    structuredClone(holdNodes.child),
    rational(0),
    structuredClone(hold),
  );
  const later = createReferenceMotionBlurBoundaryPlan(holdNodes.node, holdNodes.child, rational(1, 4), hold);
  assert.equal(first.cacheIdentity, second.cacheIdentity);
  assert.notEqual(first.cacheIdentity, later.cacheIdentity);
});
