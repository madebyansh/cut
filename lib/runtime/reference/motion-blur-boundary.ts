import { boundedDiagnosticString, hash } from "../../core/stable";
import type { IRNode } from "../../language/ir";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  type Rational,
} from "../../language/rational";
import {
  createReferenceMotionBlurPlan,
  ReferenceMotionBlurError,
  throwReferenceMotionBlurNodeError,
  type ReferenceMotionBlurConfig,
  type ReferenceMotionBlurPlan,
} from "./motion-blur";

/**
 * Exact boundary planner for the integrated public
 * `MotionBlur(startEdge: "hold")` input. Package, loader, compiler, renderer,
 * inspect and diagnostics all call this shared contract so no accepted policy
 * can diverge into an ignored or backend-private behavior.
 */
export const referenceMotionBlurBoundaryAlgorithmVersion = "cut-reference-motion-blur-start-edge-v1" as const;

export type ReferenceMotionBlurStartEdge = "transparent" | "hold";

export type ReferenceMotionBlurBoundaryReachability = Readonly<{
  /** First composition-grid output time at which both wrapper and child own time. */
  firstOwnedOutputTime: Rational | null;
  /** Exact earliest shutter sample at firstOwnedOutputTime, when it exists. */
  earliestShutterTime: Rational | null;
  /** Samples before the direct child's start at that first owned output time. */
  affectedStartSamples: number;
}>;

export type ReferenceMotionBlurBoundaryConfig = Readonly<{
  algorithmVersion: typeof referenceMotionBlurBoundaryAlgorithmVersion;
  nodeId: string;
  childNodeId: string;
  startEdge: ReferenceMotionBlurStartEdge;
  /** Whether startEdge was present in source/IR rather than resolved by default. */
  authoredStartEdge: boolean;
  nodeInterval: Readonly<{ start: Rational; end: Rational }>;
  childInterval: Readonly<{ start: Rational; end: Rational }>;
  frameDuration: Rational;
  shutterAngle: Rational;
  samples: number;
  reachability: ReferenceMotionBlurBoundaryReachability;
  /** Resolved behavior identity; a redundant authored default is refused before this point. */
  semanticIdentity: string;
}>;

export type ReferenceMotionBlurBoundaryDisposition =
  | "inside"
  | "held-start"
  | "transparent-start"
  | "transparent-end";

export type ReferenceMotionBlurBoundarySample = Readonly<{
  index: number;
  shutterTime: Rational;
  /** Null means that the renderer must contribute one transparent surface. */
  sourceTime: Rational | null;
  weight: Rational;
  disposition: ReferenceMotionBlurBoundaryDisposition;
}>;

export type ReferenceMotionBlurBoundaryPlan = Readonly<{
  algorithmVersion: typeof referenceMotionBlurBoundaryAlgorithmVersion;
  shutter: ReferenceMotionBlurPlan;
  outputOwnsChild: boolean;
  samples: readonly ReferenceMotionBlurBoundarySample[];
  heldStartSamples: number;
  transparentStartSamples: number;
  transparentEndSamples: number;
  /** Exact per-output mapping identity for inspect/cache evidence. */
  cacheIdentity: string;
}>;

const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const frozenRational = (value: Rational): Rational => Object.freeze(rational(value.numerator, value.denominator));

function fail(code: "CUT_MOTION_BLUR_CONFIG" | "CUT_MOTION_BLUR_NOOP" | "CUT_MOTION_BLUR_PLAN", message: string): never {
  throw new ReferenceMotionBlurError(code, message);
}

function owned<T>(node: IRNode, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ReferenceMotionBlurError && error.source) throw error;
    return throwReferenceMotionBlurNodeError(node, error);
  }
}

function intervalEnd(node: IRNode) {
  return addRational(node.interval.start, node.interval.duration);
}

function later(left: Rational, right: Rational) {
  return compareRational(left, right) >= 0 ? left : right;
}

function earlier(left: Rational, right: Rational) {
  return compareRational(left, right) <= 0 ? left : right;
}

/** First non-negative integer multiple of step greater than or equal to time. */
function ceilToGrid(time: Rational, step: Rational): Rational {
  if (compareRational(time, rational(0)) < 0 || compareRational(step, rational(0)) <= 0) {
    fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur boundary planning requires non-negative time and a positive frame duration.");
  }
  const numerator = BigInt(time.numerator) * BigInt(step.denominator);
  const denominator = BigInt(time.denominator) * BigInt(step.numerator);
  const index = (numerator + denominator - 1n) / denominator;
  return multiplyRational(rational(index), step);
}

function decodeStartEdge(node: IRNode): { startEdge: ReferenceMotionBlurStartEdge; authored: boolean } {
  const inputs = node.inputs as Record<string, unknown>;
  if (hasOwn(inputs, "edge")) {
    fail(
      "CUT_MOTION_BLUR_CONFIG",
      "CUT MotionBlur does not accept symmetric edge: holding a half-open end has no exact final instant; use the startEdge contract only.",
    );
  }
  if (hasOwn(inputs, "endEdge")) {
    fail(
      "CUT_MOTION_BLUR_CONFIG",
      "CUT MotionBlur endEdge is unsupported: a half-open child interval has no exact last instant, and CUT will not invent an epsilon or sample past a media range.",
    );
  }
  const authored = hasOwn(inputs, "startEdge");
  if (!authored) return { startEdge: "transparent" as const, authored };
  const value = inputs.startEdge;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur startEdge must be the static String transparent or hold.");
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "string" || typeof record.value !== "string") {
    fail("CUT_MOTION_BLUR_CONFIG", "CUT MotionBlur startEdge must be the static String transparent or hold.");
  }
  if (record.value !== "transparent" && record.value !== "hold") {
    fail("CUT_MOTION_BLUR_CONFIG", `CUT MotionBlur startEdge must be transparent or hold; received ${boundedDiagnosticString(record.value)}.`);
  }
  return { startEdge: record.value as ReferenceMotionBlurStartEdge, authored };
}

/** Stable machine-facing evidence for `cut inspect --json`. */
export function referenceMotionBlurBoundaryInspect(
  node: IRNode,
  child: IRNode,
  config: ReferenceMotionBlurBoundaryConfig,
) {
  const outputTime = config.reachability.firstOwnedOutputTime ?? config.nodeInterval.start;
  const plan = createReferenceMotionBlurBoundaryPlan(node, child, outputTime, config);
  return Object.freeze({
    kind: "exact-centered-shutter" as const,
    algorithmVersion: config.algorithmVersion,
    directChildId: config.childNodeId,
    startEdge: Object.freeze({
      resolved: config.startEdge,
      authored: config.authoredStartEdge,
      omittedDefault: "transparent" as const,
    }),
    nodeInterval: config.nodeInterval,
    childInterval: config.childInterval,
    frameDuration: config.frameDuration,
    shutterAngle: config.shutterAngle,
    samples: config.samples,
    reachability: config.reachability,
    semanticIdentity: config.semanticIdentity,
    inspectionSample: Object.freeze({
      outputTime,
      outputOwnsChild: plan.outputOwnsChild,
      heldStartSamples: plan.heldStartSamples,
      transparentStartSamples: plan.transparentStartSamples,
      transparentEndSamples: plan.transparentEndSamples,
      mapping: Object.freeze(plan.samples.map((sample) => Object.freeze({
        index: sample.index,
        shutterTime: sample.shutterTime,
        sourceTime: sample.sourceTime,
        weight: sample.weight,
        disposition: sample.disposition,
      }))),
      cacheIdentity: plan.cacheIdentity,
    }),
  });
}

function canonicalInterval(start: Rational, end: Rational) {
  return Object.freeze({ start: frozenRational(start), end: frozenRational(end) });
}

/**
 * Resolve and preflight one direct-child boundary policy.
 *
 * Reachability is analytic: with a centered shutter no wider than one output
 * frame, the first grid sample jointly owned by wrapper and child is the only
 * output that can cross the child's start. If it does not cross, no later
 * output can make startEdge observable.
 */
export function prepareReferenceMotionBlurBoundary(
  node: IRNode,
  child: IRNode,
  frameDurationValue: Rational,
  motionConfig: ReferenceMotionBlurConfig,
): ReferenceMotionBlurBoundaryConfig {
  return owned(node, () => {
    if (node.op !== "cut.visual.motion_blur") {
      fail("CUT_MOTION_BLUR_CONFIG", `CUT MotionBlur boundary planner received operation ${boundedDiagnosticString(node.op)}.`);
    }
    if (node.children.length !== 1 || node.children[0] !== child.id) {
      fail("CUT_MOTION_BLUR_PLAN", "CUT MotionBlur boundary planning requires its one exact direct visual child.");
    }
    if (child.domain !== "visual") {
      fail("CUT_MOTION_BLUR_PLAN", `CUT MotionBlur boundary child ${boundedDiagnosticString(child.id)} must have visual domain.`);
    }

    const frameDuration = frozenRational(frameDurationValue);
    const nodeStart = frozenRational(node.interval.start), nodeEnd = frozenRational(intervalEnd(node));
    const childStart = frozenRational(child.interval.start), childEnd = frozenRational(intervalEnd(child));
    if (compareRational(nodeStart, rational(0)) < 0 || compareRational(nodeEnd, nodeStart) <= 0) {
      fail("CUT_MOTION_BLUR_PLAN", "CUT MotionBlur must own one positive non-negative half-open interval.");
    }
    if (compareRational(childStart, nodeStart) < 0 || compareRational(childEnd, childStart) <= 0 || compareRational(childEnd, nodeEnd) > 0) {
      fail("CUT_MOTION_BLUR_PLAN", "CUT MotionBlur direct child must own one positive half-open interval contained by the wrapper.");
    }

    // Validate exact shutter/frame inputs even if there is no jointly owned
    // output frame. This keeps an unreachable boundary from bypassing core
    // MotionBlur configuration checks.
    const shutterConfig: ReferenceMotionBlurConfig = {
      shutterAngle: motionConfig.shutterAngle,
      samples: motionConfig.samples,
    };
    createReferenceMotionBlurPlan(nodeStart, frameDuration, shutterConfig);
    const { startEdge, authored } = decodeStartEdge(node);
    if (authored && startEdge === "transparent") {
      fail(
        "CUT_MOTION_BLUR_NOOP",
        "CUT MotionBlur startEdge: transparent repeats the omitted default; remove the redundant argument.",
      );
    }
    const ownedStart = later(nodeStart, childStart), ownedEnd = earlier(nodeEnd, childEnd);
    const firstOwnedOutputTime = ceilToGrid(ownedStart, frameDuration);
    const hasOwnedOutput = compareRational(firstOwnedOutputTime, ownedEnd) < 0;
    const firstPlan = hasOwnedOutput
      ? createReferenceMotionBlurPlan(firstOwnedOutputTime, frameDuration, shutterConfig)
      : undefined;
    const affectedStartSamples = firstPlan
      ? firstPlan.samples.filter((sample) => compareRational(sample.time, childStart) < 0).length
      : 0;
    if (authored && affectedStartSamples === 0) {
      fail(
        "CUT_MOTION_BLUR_NOOP",
        "CUT MotionBlur startEdge never affects an exact shutter sample at an output time owned by its direct child's half-open interval.",
      );
    }

    const nodeInterval = canonicalInterval(nodeStart, nodeEnd);
    const childInterval = canonicalInterval(childStart, childEnd);
    const shutterAngle = frozenRational(motionConfig.shutterAngle);
    const reachability: ReferenceMotionBlurBoundaryReachability = Object.freeze({
      firstOwnedOutputTime: hasOwnedOutput ? frozenRational(firstOwnedOutputTime) : null,
      earliestShutterTime: firstPlan ? frozenRational(firstPlan.samples[0]!.time) : null,
      affectedStartSamples,
    });
    const semanticIdentity = hash({
      algorithmVersion: referenceMotionBlurBoundaryAlgorithmVersion,
      startEdge,
      nodeInterval,
      childNodeId: child.id,
      childInterval,
      frameDuration,
      shutterAngle,
      samples: motionConfig.samples,
    });
    return Object.freeze({
      algorithmVersion: referenceMotionBlurBoundaryAlgorithmVersion,
      nodeId: node.id,
      childNodeId: child.id,
      startEdge,
      authoredStartEdge: authored,
      nodeInterval,
      childInterval,
      frameDuration,
      shutterAngle,
      samples: motionConfig.samples,
      reachability,
      semanticIdentity,
    });
  });
}

/**
 * Create the exact child sample mapping for one output. `held-start` maps only
 * samples whose nominal output time is itself inside the direct child's
 * interval. This prevents startEdge from filling an intentional gap before a
 * delayed child. Descendants retain their own intervals when the renderer
 * evaluates the direct child at childInterval.start.
 */
export function createReferenceMotionBlurBoundaryPlan(
  node: IRNode,
  child: IRNode,
  outputTimeValue: Rational,
  config: ReferenceMotionBlurBoundaryConfig,
): ReferenceMotionBlurBoundaryPlan {
  return owned(node, () => {
    if (node.id !== config.nodeId || child.id !== config.childNodeId || node.children.length !== 1 || node.children[0] !== child.id) {
      fail("CUT_MOTION_BLUR_PLAN", "CUT MotionBlur boundary config no longer matches its wrapper/direct-child graph.");
    }
    const currentNodeEnd = intervalEnd(node), currentChildEnd = intervalEnd(child);
    if (compareRational(node.interval.start, config.nodeInterval.start) !== 0
      || compareRational(currentNodeEnd, config.nodeInterval.end) !== 0
      || compareRational(child.interval.start, config.childInterval.start) !== 0
      || compareRational(currentChildEnd, config.childInterval.end) !== 0) {
      fail("CUT_MOTION_BLUR_PLAN", "CUT MotionBlur boundary config no longer matches its wrapper/direct-child half-open intervals.");
    }
    const outputTime = frozenRational(outputTimeValue);
    if (compareRational(outputTime, config.nodeInterval.start) < 0 || compareRational(outputTime, config.nodeInterval.end) >= 0) {
      fail("CUT_MOTION_BLUR_PLAN", "CUT MotionBlur boundary plan output time lies outside the wrapper's half-open interval.");
    }
    const shutter = createReferenceMotionBlurPlan(outputTime, config.frameDuration, {
      shutterAngle: config.shutterAngle,
      samples: config.samples,
    });
    const outputOwnsChild = compareRational(outputTime, config.childInterval.start) >= 0
      && compareRational(outputTime, config.childInterval.end) < 0;
    const samples = shutter.samples.map((sample): ReferenceMotionBlurBoundarySample => {
      let disposition: ReferenceMotionBlurBoundaryDisposition;
      let sourceTime: Rational | null;
      if (compareRational(sample.time, config.childInterval.start) < 0) {
        if (config.startEdge === "hold" && outputOwnsChild) {
          disposition = "held-start";
          sourceTime = frozenRational(config.childInterval.start);
        } else {
          disposition = "transparent-start";
          sourceTime = null;
        }
      } else if (compareRational(sample.time, config.childInterval.end) >= 0) {
        disposition = "transparent-end";
        sourceTime = null;
      } else {
        disposition = "inside";
        sourceTime = frozenRational(sample.time);
      }
      return Object.freeze({
        index: sample.index,
        shutterTime: frozenRational(sample.time),
        sourceTime,
        weight: frozenRational(sample.weight),
        disposition,
      });
    });
    const heldStartSamples = samples.filter((sample) => sample.disposition === "held-start").length;
    const transparentStartSamples = samples.filter((sample) => sample.disposition === "transparent-start").length;
    const transparentEndSamples = samples.filter((sample) => sample.disposition === "transparent-end").length;
    const cacheIdentity = hash({
      algorithmVersion: referenceMotionBlurBoundaryAlgorithmVersion,
      semanticIdentity: config.semanticIdentity,
      outputTime,
      samples: samples.map((sample) => ({
        index: sample.index,
        shutterTime: sample.shutterTime,
        sourceTime: sample.sourceTime,
        weight: sample.weight,
        disposition: sample.disposition,
      })),
    });
    return Object.freeze({
      algorithmVersion: referenceMotionBlurBoundaryAlgorithmVersion,
      shutter,
      outputOwnsChild,
      samples: Object.freeze(samples),
      heldStartSamples,
      transparentStartSamples,
      transparentEndSamples,
      cacheIdentity,
    });
  });
}
