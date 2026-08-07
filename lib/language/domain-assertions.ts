import type { IRAssertion, IRComposition, IRNode, IRProvenance, IRResource, IRValue, CutAVIR } from "./ir";
import { addRational, compareRational, multiplyRational, rational, zeroRational, type Rational } from "./rational";
import { boundedDiagnosticString } from "../core/stable";
import { CutOutputContractError, validateCutOutputContract } from "./output-contract";

export const cutDomainAssertionPredicates = Object.freeze([
  "cut.assert.timeline_duration_is",
  "cut.assert.timeline_has_no_scene_gaps",
  "cut.assert.timeline_has_no_scene_overlaps",
  "cut.assert.time_is_on_frame_grid",
  "cut.assert.time_is_on_sample_grid",
  "cut.assert.video_range_within_locked_media",
  "cut.assert.audio_range_within_locked_media",
  "cut.assert.caption_coverage_includes",
  "cut.assert.delivery_target_matches",
] as const);

export type CutDomainAssertionPredicate = typeof cutDomainAssertionPredicates[number];

export type CutDomainAssertionDiagnosticCode =
  | "CUT_ASSERT_ARGUMENT"
  | "CUT_ASSERT_BOOLEAN_OPERATOR"
  | "CUT_ASSERT_BUDGET"
  | "CUT_ASSERT_CALL_SHAPE"
  | "CUT_ASSERT_CYCLE"
  | "CUT_ASSERT_EXPRESSION"
  | "CUT_ASSERT_CAPTION_GRAPH"
  | "CUT_ASSERT_DELIVERY_GRAPH"
  | "CUT_ASSERT_RANGE_ARGUMENT"
  | "CUT_ASSERT_RATIONAL"
  | "CUT_ASSERT_RESOURCE_LOCK"
  | "CUT_ASSERT_RESOURCE_REFERENCE"
  | "CUT_ASSERT_TIMELINE_GRAPH"
  | "CUT_ASSERT_TIMELINE_REFERENCE"
  | "CUT_ASSERT_TIME_ARGUMENT";

export type CutDomainAssertionUnsupportedCode =
  | "CUT_ASSERT_REQUIRES_LOCK"
  | "CUT_ASSERT_UNSUPPORTED_EXPRESSION"
  | "CUT_ASSERT_UNSUPPORTED_PREDICATE";

export type CutDomainAssertionSource = {
  module: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

export type CutDomainAssertionDiagnostic = {
  code: CutDomainAssertionDiagnosticCode;
  message: string;
  assertionId: string;
  source: CutDomainAssertionSource;
  predicate?: CutDomainAssertionPredicate;
};

type CutDomainAssertionResultBase = {
  assertionId: string;
  source: CutDomainAssertionSource;
  /** Predicates actually evaluated, in expression traversal order. */
  predicates: CutDomainAssertionPredicate[];
};

export type CutDomainAssertionResult =
  | (CutDomainAssertionResultBase & { status: "pass" | "fail"; value: boolean })
  | (CutDomainAssertionResultBase & {
      status: "unsupported";
      code: CutDomainAssertionUnsupportedCode;
      message: string;
    })
  | (CutDomainAssertionResultBase & { status: "error"; diagnostic: CutDomainAssertionDiagnostic });

export type CutDomainAssertionReport = {
  status: "pass" | "fail" | "error";
  results: CutDomainAssertionResult[];
  counts: { pass: number; fail: number; unsupported: number; error: number };
  diagnostic?: CutDomainAssertionDiagnostic;
};

export type CutDomainAssertionLimits = {
  maxAssertions: number;
  maxExpressionNodes: number;
  maxExpressionDepth: number;
  maxPredicateCalls: number;
  maxCompositions: number;
  maxScenesPerTimeline: number;
  maxGraphNodes: number;
  maxRationalDigits: number;
};

export const defaultCutDomainAssertionLimits: Readonly<CutDomainAssertionLimits> = Object.freeze({
  maxAssertions: 1_024,
  maxExpressionNodes: 4_096,
  maxExpressionDepth: 64,
  maxPredicateCalls: 1_024,
  maxCompositions: 1_024,
  maxScenesPerTimeline: 10_000,
  maxGraphNodes: 100_000,
  maxRationalDigits: 256,
});

const maximumLimits: Readonly<CutDomainAssertionLimits> = Object.freeze({
  maxAssertions: 100_000,
  maxExpressionNodes: 100_000,
  maxExpressionDepth: 256,
  maxPredicateCalls: 100_000,
  maxCompositions: 100_000,
  maxScenesPerTimeline: 100_000,
  maxGraphNodes: 100_000,
  maxRationalDigits: 4_096,
});

type EvaluationContext = {
  ir: CutAVIR;
  assertion: IRAssertion;
  source: CutDomainAssertionSource;
  limits: CutDomainAssertionLimits;
  budget: { nodes: number; calls: number; graphVisits: number };
  active: WeakSet<object>;
  predicates: CutDomainAssertionPredicate[];
};

type ValueEvaluation =
  | { kind: "value"; value: boolean }
  | { kind: "unsupported"; code: CutDomainAssertionUnsupportedCode; message: string };

class EvaluationFailure extends Error {
  constructor(
    readonly code: CutDomainAssertionDiagnosticCode,
    message: string,
    readonly predicate?: CutDomainAssertionPredicate,
  ) {
    super(message);
    this.name = "EvaluationFailure";
  }
}

class EvaluationDeferred extends Error {
  readonly code = "CUT_ASSERT_REQUIRES_LOCK" as const;

  constructor(message: string) {
    super(message);
    this.name = "EvaluationDeferred";
  }
}

const predicateSet: ReadonlySet<string> = new Set(cutDomainAssertionPredicates);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceOf(provenance: IRProvenance): CutDomainAssertionSource {
  return {
    module: provenance.module,
    line: provenance.span.start.line,
    column: provenance.span.start.column,
    endLine: provenance.span.end.line,
    endColumn: provenance.span.end.column,
  };
}

function boundedText(value: unknown): string {
  if (typeof value !== "string") return `<${value === null ? "null" : typeof value}>`;
  // Keep one canonical hostile-string policy across CUT diagnostics. The core
  // helper slices by Unicode scalar rather than UTF-16 code unit, escapes lone
  // surrogates/controls through JSON, and includes a stable bounded digest.
  return boundedDiagnosticString(value);
}

function location(source: CutDomainAssertionSource) {
  return `${boundedText(source.module)}:${source.line}:${source.column}`;
}

function fail(
  code: CutDomainAssertionDiagnosticCode,
  message: string,
  predicate?: CutDomainAssertionPredicate,
): never {
  throw new EvaluationFailure(code, message, predicate);
}

function consumeGraphVisit(
  context: EvaluationContext,
  predicate: CutDomainAssertionPredicate,
  label: string,
) {
  context.budget.graphVisits += 1;
  if (context.budget.graphVisits > context.limits.maxGraphNodes) {
    fail(
      "CUT_ASSERT_BUDGET",
      `${label} exceeds the shared final-graph visit budget maxGraphNodes=${context.limits.maxGraphNodes}.`,
      predicate,
    );
  }
}

function resolvedLimits(overrides: Partial<CutDomainAssertionLimits> | undefined): CutDomainAssertionLimits {
  const limits = { ...defaultCutDomainAssertionLimits, ...overrides };
  for (const key of Object.keys(defaultCutDomainAssertionLimits) as Array<keyof CutDomainAssertionLimits>) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximumLimits[key]) {
      throw new RangeError(`CUT domain assertion limit ${key} must be an integer from 1 through ${maximumLimits[key]}.`);
    }
  }
  return limits;
}

function checkedRational(value: unknown, label: string, context: EvaluationContext): Rational {
  if (!isRecord(value) || typeof value.numerator !== "string" || typeof value.denominator !== "string") {
    fail("CUT_ASSERT_RATIONAL", `${label} must be an exact rational with string numerator and denominator.`);
  }
  const numerator = value.numerator;
  const denominator = value.denominator;
  const numeratorDigits = numerator.startsWith("-") ? numerator.length - 1 : numerator.length;
  if (numeratorDigits > context.limits.maxRationalDigits || denominator.length > context.limits.maxRationalDigits) {
    fail("CUT_ASSERT_BUDGET", `${label} exceeds maxRationalDigits=${context.limits.maxRationalDigits}.`);
  }
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(numerator) || !/^[1-9][0-9]*$/u.test(denominator) || numerator === "-0") {
    fail("CUT_ASSERT_RATIONAL", `${label} is not a canonical exact rational.`);
  }
  const normalized = rational(numerator, denominator);
  if (normalized.numerator !== numerator || normalized.denominator !== denominator) {
    fail("CUT_ASSERT_RATIONAL", `${label} is not reduced to canonical form.`);
  }
  return normalized;
}

function checkedIntermediate(value: Rational, label: string, context: EvaluationContext): Rational {
  const numeratorDigits = value.numerator.startsWith("-") ? value.numerator.length - 1 : value.numerator.length;
  if (numeratorDigits > context.limits.maxRationalDigits || value.denominator.length > context.limits.maxRationalDigits) {
    fail("CUT_ASSERT_BUDGET", `${label} exceeds maxRationalDigits=${context.limits.maxRationalDigits} during exact evaluation.`);
  }
  return value;
}

function exactAdd(left: Rational, right: Rational, label: string, context: EvaluationContext) {
  return checkedIntermediate(addRational(left, right), label, context);
}

function exactMultiply(left: Rational, right: Rational, label: string, context: EvaluationContext) {
  return checkedIntermediate(multiplyRational(left, right), label, context);
}

function ownDataRecord(value: unknown, predicate: CutDomainAssertionPredicate): Record<string, IRValue> {
  if (!isRecord(value)) fail("CUT_ASSERT_CALL_SHAPE", `${predicate} named arguments must be a plain data object.`, predicate);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_ASSERT_CALL_SHAPE", `${predicate} named arguments must have a plain or null prototype.`, predicate);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    fail("CUT_ASSERT_CALL_SHAPE", `${predicate} named arguments cannot contain symbol keys.`, predicate);
  }
  const result: Record<string, IRValue> = Object.create(null) as Record<string, IRValue>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail("CUT_ASSERT_CALL_SHAPE", `${predicate} named argument ${boundedText(key)} must be enumerable data.`, predicate);
    }
    result[key] = descriptor.value as IRValue;
  }
  return result;
}

function bindArguments(
  expression: Extract<IRValue, { kind: "call" }>,
  predicate: CutDomainAssertionPredicate,
  parameters: readonly string[],
): Record<string, IRValue> {
  if (!Array.isArray(expression.positional)) fail("CUT_ASSERT_CALL_SHAPE", `${predicate} positional arguments must be an array.`, predicate);
  if (expression.effect !== "pure") fail("CUT_ASSERT_CALL_SHAPE", `${predicate} must be a pure native IR call.`, predicate);
  if (expression.positional.length > parameters.length) {
    fail("CUT_ASSERT_ARGUMENT", `${predicate} expects exactly ${parameters.length} argument(s).`, predicate);
  }
  const positionalDescriptors = Object.getOwnPropertyDescriptors(expression.positional);
  for (let index = 0; index < expression.positional.length; index += 1) {
    const descriptor = positionalDescriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("CUT_ASSERT_CALL_SHAPE", `${predicate} positional arguments must be a dense data array.`, predicate);
    }
  }
  if (Reflect.ownKeys(expression.positional).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= expression.positional.length))) {
    fail("CUT_ASSERT_CALL_SHAPE", `${predicate} positional arguments contain a non-index property.`, predicate);
  }
  const named = ownDataRecord(expression.named, predicate);
  const names = Object.keys(named);
  const unknown = names.find((name) => !parameters.includes(name));
  if (unknown !== undefined) fail("CUT_ASSERT_ARGUMENT", `${predicate} does not accept named argument ${boundedText(unknown)}.`, predicate);
  const result: Record<string, IRValue> = Object.create(null) as Record<string, IRValue>;
  expression.positional.forEach((value, index) => { result[parameters[index]!] = value; });
  for (const name of names) {
    if (Object.hasOwn(result, name)) fail("CUT_ASSERT_ARGUMENT", `${predicate} receives ${name} both positionally and by name.`, predicate);
    result[name] = named[name]!;
  }
  const missing = parameters.find((name) => !Object.hasOwn(result, name));
  if (missing !== undefined || Object.keys(result).length !== parameters.length) {
    fail("CUT_ASSERT_ARGUMENT", `${predicate} expects exactly ${parameters.length} argument(s); missing ${missing ?? "a required argument"}.`, predicate);
  }
  return result;
}

function timelineArgument(value: IRValue, predicate: CutDomainAssertionPredicate, context: EvaluationContext): IRComposition {
  if (!isRecord(value) || value.kind !== "timeline-ref" || typeof value.id !== "string" || value.id.length > 4_096) {
    fail("CUT_ASSERT_ARGUMENT", `${predicate} timeline must be a bounded Timeline reference.`, predicate);
  }
  if (!Array.isArray(context.ir.compositions)) fail("CUT_ASSERT_TIMELINE_GRAPH", "Final CUT IR compositions must be an array.", predicate);
  if (context.ir.compositions.length > context.limits.maxCompositions) {
    fail("CUT_ASSERT_BUDGET", `Final CUT IR exceeds maxCompositions=${context.limits.maxCompositions}.`, predicate);
  }
  const matches = context.ir.compositions.filter((composition) => isRecord(composition) && composition.id === value.id);
  if (matches.length !== 1) {
    fail("CUT_ASSERT_TIMELINE_REFERENCE", `${predicate} references ${matches.length ? "a duplicate" : "a missing"} Timeline ${boundedText(value.id)}.`, predicate);
  }
  const composition = matches[0]!;
  const duration = checkedRational(composition.duration, `Timeline ${boundedText(composition.id)} duration`, context);
  if (compareRational(duration, zeroRational) < 0) fail("CUT_ASSERT_TIMELINE_GRAPH", `Timeline ${boundedText(composition.id)} has a negative duration.`, predicate);
  return composition;
}

function timeArgument(value: IRValue, predicate: CutDomainAssertionPredicate, context: EvaluationContext): Rational {
  if (!isRecord(value) || value.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    fail("CUT_ASSERT_TIME_ARGUMENT", `${predicate} time must be an exact Time quantity in canonical seconds.`, predicate);
  }
  return checkedRational(value.magnitude, `${predicate} time`, context);
}

function rangeArgument(value: IRValue, predicate: CutDomainAssertionPredicate, context: EvaluationContext) {
  if (!isRecord(value) || value.kind !== "range" || value.exclusive !== true) {
    fail("CUT_ASSERT_RANGE_ARGUMENT", `${predicate} range must be one exact half-open Range<Time>.`, predicate);
  }
  const start = timeArgument(value.start as IRValue, predicate, context);
  const end = timeArgument(value.end as IRValue, predicate, context);
  return { start, end };
}

function resourceArgument(
  value: IRValue,
  expected: "video" | "audio",
  predicate: CutDomainAssertionPredicate,
  context: EvaluationContext,
): IRResource {
  if (!isRecord(value) || value.kind !== "resource-ref" || typeof value.id !== "string" || value.id.length > 4_096) {
    fail("CUT_ASSERT_RESOURCE_REFERENCE", `${predicate} source must be one bounded ${expected === "video" ? "VideoAsset" : "AudioAsset"} reference.`, predicate);
  }
  if (!isRecord(context.ir.resources) || !Object.hasOwn(context.ir.resources, value.id)) {
    fail("CUT_ASSERT_RESOURCE_REFERENCE", `${predicate} references missing resource ${boundedText(value.id)}.`, predicate);
  }
  const resource = context.ir.resources[value.id]!;
  if (resource.id !== value.id || resource.kind !== expected) {
    fail("CUT_ASSERT_RESOURCE_REFERENCE", `${predicate} source does not resolve to one ${expected === "video" ? "VideoAsset" : "AudioAsset"}.`, predicate);
  }
  return resource;
}

type LockedAssertionMedia = { duration: Rational; clock: Rational };

function lockedMediaAuthority(
  resource: IRResource,
  expected: "video" | "audio",
  predicate: CutDomainAssertionPredicate,
  context: EvaluationContext,
): LockedAssertionMedia {
  if (resource.state !== "locked") {
    throw new EvaluationDeferred(`${predicate} requires cut.lock authority for ${boundedText(resource.id)}.`);
  }
  if (typeof resource.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(resource.sha256) || !isRecord(resource.metadata) || resource.metadata.lockVersion !== 2) {
    fail("CUT_ASSERT_RESOURCE_LOCK", `${predicate} resource ${boundedText(resource.id)} has malformed embedded cut.lock authority.`, predicate);
  }
  const probe = resource.metadata.probe;
  if (!isRecord(probe) || probe.kind !== "media" || !isRecord(probe.selected) || !isRecord(probe.identity) || !Array.isArray(probe.identity.streams)) {
    fail("CUT_ASSERT_RESOURCE_LOCK", `${predicate} resource ${boundedText(resource.id)} has no exact selected-media authority.`, predicate);
  }
  const selected = probe.selected[expected];
  if (!isRecord(selected) || !Number.isSafeInteger(selected.streamIndex)) {
    fail("CUT_ASSERT_RESOURCE_LOCK", `${predicate} resource ${boundedText(resource.id)} has no selected ${expected} stream.`, predicate);
  }
  const duration = checkedRational(selected.duration, `${predicate} selected ${expected} duration`, context);
  if (compareRational(duration, zeroRational) <= 0) {
    fail("CUT_ASSERT_RESOURCE_LOCK", `${predicate} selected ${expected} duration must be positive.`, predicate);
  }
  const stream = probe.identity.streams.find((candidate) =>
    isRecord(candidate)
    && candidate.index === selected.streamIndex
    && candidate.type === expected);
  if (!stream) {
    fail("CUT_ASSERT_RESOURCE_LOCK", `${predicate} selected ${expected} stream is absent from locked media identity.`, predicate);
  }
  if (expected === "video") {
    const frameRate = checkedRational(selected.frameRate, `${predicate} selected video frame rate`, context);
    if (compareRational(frameRate, zeroRational) <= 0) {
      fail("CUT_ASSERT_RESOURCE_LOCK", `${predicate} selected video frame rate must be positive.`, predicate);
    }
    return { duration, clock: frameRate };
  }
  if (!Number.isSafeInteger(stream.sampleRate) || Number(stream.sampleRate) <= 0) {
    fail("CUT_ASSERT_RESOURCE_LOCK", `${predicate} selected audio stream has no positive exact sample rate.`, predicate);
  }
  return { duration, clock: rational(Number(stream.sampleRate)) };
}

function lockedRangeWithin(
  expression: Extract<IRValue, { kind: "call" }>,
  predicate: CutDomainAssertionPredicate,
  expected: "video" | "audio",
  context: EvaluationContext,
) {
  const args = bindArguments(expression, predicate, ["source", "range"]);
  const resource = resourceArgument(args.source!, expected, predicate, context);
  const range = rangeArgument(args.range!, predicate, context);
  const authority = lockedMediaAuthority(resource, expected, predicate, context);
  if (compareRational(range.start, zeroRational) < 0
    || compareRational(range.end, range.start) <= 0
    || compareRational(range.end, authority.duration) > 0) return false;
  return exactMultiply(range.start, authority.clock, `${predicate} source start`, context).denominator === "1"
    && exactMultiply(range.end, authority.clock, `${predicate} source end`, context).denominator === "1";
}

type SceneInterval = { id: string; start: Rational; end: Rational };

function orderedSceneIntervals(composition: IRComposition, predicate: CutDomainAssertionPredicate, context: EvaluationContext): SceneInterval[] {
  if (!Array.isArray(composition.sceneIds)) fail("CUT_ASSERT_TIMELINE_GRAPH", `Timeline ${boundedText(composition.id)} sceneIds must be an array.`, predicate);
  if (composition.sceneIds.length > context.limits.maxScenesPerTimeline) {
    fail("CUT_ASSERT_BUDGET", `Timeline ${boundedText(composition.id)} exceeds maxScenesPerTimeline=${context.limits.maxScenesPerTimeline}.`, predicate);
  }
  if (!isRecord(context.ir.scenes)) fail("CUT_ASSERT_TIMELINE_GRAPH", "Final CUT IR scenes must be a data object.", predicate);
  const timelineDuration = checkedRational(composition.duration, `Timeline ${boundedText(composition.id)} duration`, context);
  const ids = new Set<string>();
  const intervals: SceneInterval[] = [];
  for (const sceneId of composition.sceneIds) {
    consumeGraphVisit(context, predicate, `Timeline ${boundedText(composition.id)} assertion traversal`);
    if (typeof sceneId !== "string" || sceneId.length > 4_096) fail("CUT_ASSERT_TIMELINE_GRAPH", `Timeline ${boundedText(composition.id)} has an invalid scene id.`, predicate);
    if (ids.has(sceneId)) fail("CUT_ASSERT_TIMELINE_GRAPH", `Timeline ${boundedText(composition.id)} repeats scene ${boundedText(sceneId)}.`, predicate);
    ids.add(sceneId);
    if (!Object.hasOwn(context.ir.scenes, sceneId)) {
      fail("CUT_ASSERT_TIMELINE_GRAPH", `Timeline ${boundedText(composition.id)} references missing scene ${boundedText(sceneId)}.`, predicate);
    }
    const scene = context.ir.scenes[sceneId];
    if (!isRecord(scene) || scene.id !== sceneId) fail("CUT_ASSERT_TIMELINE_GRAPH", `Scene ${boundedText(sceneId)} has inconsistent identity.`, predicate);
    const start = checkedRational(scene.start, `Scene ${boundedText(sceneId)} start`, context);
    const duration = checkedRational(scene.duration, `Scene ${boundedText(sceneId)} duration`, context);
    if (compareRational(start, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) {
      fail("CUT_ASSERT_TIMELINE_GRAPH", `Scene ${boundedText(sceneId)} must have non-negative start and strictly positive duration.`, predicate);
    }
    const end = exactAdd(start, duration, `Scene ${boundedText(sceneId)} end`, context);
    if (compareRational(end, timelineDuration) > 0) {
      fail("CUT_ASSERT_TIMELINE_GRAPH", `Scene ${boundedText(sceneId)} exceeds Timeline ${boundedText(composition.id)}.`, predicate);
    }
    intervals.push({ id: sceneId, start, end });
  }
  return intervals.sort((left, right) => {
    const byStart = compareRational(left.start, right.start);
    if (byStart) return byStart;
    const byEnd = compareRational(left.end, right.end);
    if (byEnd) return byEnd;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function hasNoSceneGaps(composition: IRComposition, predicate: CutDomainAssertionPredicate, context: EvaluationContext) {
  const duration = checkedRational(composition.duration, `Timeline ${boundedText(composition.id)} duration`, context);
  const intervals = orderedSceneIntervals(composition, predicate, context);
  if (!intervals.length) return compareRational(duration, zeroRational) === 0;
  let cursor = zeroRational;
  for (const interval of intervals) {
    if (compareRational(interval.start, cursor) > 0) return false;
    if (compareRational(interval.end, cursor) > 0) cursor = interval.end;
  }
  return compareRational(cursor, duration) === 0;
}

function hasNoSceneOverlaps(composition: IRComposition, predicate: CutDomainAssertionPredicate, context: EvaluationContext) {
  const intervals = orderedSceneIntervals(composition, predicate, context);
  let cursor = zeroRational;
  for (const interval of intervals) {
    if (compareRational(interval.start, cursor) < 0) return false;
    if (compareRational(interval.end, cursor) > 0) cursor = interval.end;
  }
  return true;
}

function nodeInterval(node: IRNode, predicate: CutDomainAssertionPredicate, context: EvaluationContext) {
  if (!isRecord(node.interval)) fail("CUT_ASSERT_CAPTION_GRAPH", `Caption node ${boundedText(node.id)} has no exact interval.`, predicate);
  const start = checkedRational(node.interval.start, `Caption node ${boundedText(node.id)} start`, context);
  const duration = checkedRational(node.interval.duration, `Caption node ${boundedText(node.id)} duration`, context);
  if (compareRational(start, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) {
    fail("CUT_ASSERT_CAPTION_GRAPH", `Caption node ${boundedText(node.id)} interval must be non-negative and non-empty.`, predicate);
  }
  return { start, end: exactAdd(start, duration, `Caption node ${boundedText(node.id)} end`, context) };
}

function isSceneGraphNode(value: unknown, id: string, sceneId: string): value is IRNode {
  return isRecord(value)
    && value.id === id
    && value.sceneId === sceneId
    && typeof value.op === "string"
    && Array.isArray(value.children);
}

function reachableSceneNodes(
  rootIds: unknown,
  sceneId: string,
  predicate: CutDomainAssertionPredicate,
  context: EvaluationContext,
) {
  if (!Array.isArray(rootIds)) fail("CUT_ASSERT_CAPTION_GRAPH", `Scene ${boundedText(sceneId)} rootVisualIds must be an array.`, predicate);
  if (!isRecord(context.ir.nodes)) fail("CUT_ASSERT_CAPTION_GRAPH", "Final CUT IR nodes must be a data object.", predicate);
  const found: IRNode[] = [], seen = new Set<string>(), active = new Set<string>(), stack = [...rootIds].reverse().map((id) => ({ id, exiting: false }));
  while (stack.length) {
    const entry = stack.pop()!;
    if (typeof entry.id !== "string" || entry.id.length > 4_096) fail("CUT_ASSERT_CAPTION_GRAPH", `Scene ${boundedText(sceneId)} has an invalid visual root id.`, predicate);
    if (entry.exiting) { active.delete(entry.id); continue; }
    if (active.has(entry.id)) fail("CUT_ASSERT_CAPTION_GRAPH", `Scene ${boundedText(sceneId)} visual graph contains a cycle.`, predicate);
    if (seen.has(entry.id)) continue;
    const candidate = context.ir.nodes[entry.id];
    if (!isSceneGraphNode(candidate, entry.id, sceneId)) {
      fail("CUT_ASSERT_CAPTION_GRAPH", `Scene ${boundedText(sceneId)} references an absent or foreign visual node ${boundedText(entry.id)}.`, predicate);
    }
    const node = candidate;
    consumeGraphVisit(context, predicate, "Caption coverage traversal");
    active.add(entry.id); stack.push({ id: entry.id, exiting: true }); seen.add(entry.id); found.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push({ id: node.children[index], exiting: false });
  }
  return found;
}

function captionCoverageIncludes(
  expression: Extract<IRValue, { kind: "call" }>,
  predicate: CutDomainAssertionPredicate,
  context: EvaluationContext,
) {
  const args = bindArguments(expression, predicate, ["timeline", "range"]);
  const composition = timelineArgument(args.timeline!, predicate, context);
  const requested = rangeArgument(args.range!, predicate, context);
  const duration = checkedRational(composition.duration, `Timeline ${boundedText(composition.id)} duration`, context);
  if (compareRational(requested.start, zeroRational) < 0
    || compareRational(requested.end, requested.start) <= 0
    || compareRational(requested.end, duration) > 0) return false;
  const intervals: Array<{ start: Rational; end: Rational }> = [];
  for (const sceneInterval of orderedSceneIntervals(composition, predicate, context)) {
    const scene = context.ir.scenes[sceneInterval.id]!;
    for (const node of reachableSceneNodes(scene.rootVisualIds, scene.id, predicate, context)) {
      if (node.op !== "cut.visual.captions" && node.op !== "cut.visual.transcript_captions") continue;
      const local = nodeInterval(node, predicate, context);
      const start = exactAdd(sceneInterval.start, local.start, `${predicate} caption start`, context);
      const end = exactAdd(sceneInterval.start, local.end, `${predicate} caption end`, context);
      if (compareRational(end, sceneInterval.end) > 0) {
        fail("CUT_ASSERT_CAPTION_GRAPH", `Caption node ${boundedText(node.id)} exceeds its owning scene interval.`, predicate);
      }
      intervals.push({ start, end });
    }
  }
  intervals.sort((left, right) => {
    const byStart = compareRational(left.start, right.start);
    return byStart || compareRational(left.end, right.end);
  });
  let cursor = requested.start;
  for (const interval of intervals) {
    if (compareRational(interval.end, cursor) <= 0) continue;
    if (compareRational(interval.start, cursor) > 0) return false;
    cursor = interval.end;
    if (compareRational(cursor, requested.end) >= 0) return true;
  }
  return false;
}

function exactPixelLength(value: IRValue, label: string, predicate: CutDomainAssertionPredicate, context: EvaluationContext) {
  if (!isRecord(value) || value.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail("CUT_ASSERT_ARGUMENT", `${predicate} ${label} must be an exact Length in px.`, predicate);
  }
  const magnitude = checkedRational(value.magnitude, `${predicate} ${label}`, context);
  if (magnitude.denominator !== "1") fail("CUT_ASSERT_ARGUMENT", `${predicate} ${label} must be an integer number of pixels.`, predicate);
  const result = Number(magnitude.numerator);
  if (!Number.isSafeInteger(result) || result < 1 || result > 4_096) {
    fail("CUT_ASSERT_ARGUMENT", `${predicate} ${label} must be from 1px through 4096px.`, predicate);
  }
  return result;
}

function stringArgument(value: IRValue, label: string, predicate: CutDomainAssertionPredicate) {
  if (!isRecord(value) || value.kind !== "string" || typeof value.value !== "string" || value.value.length > 4_096) {
    fail("CUT_ASSERT_ARGUMENT", `${predicate} ${label} must be one bounded String.`, predicate);
  }
  return value.value;
}

function deliveryTargetMatches(
  expression: Extract<IRValue, { kind: "call" }>,
  predicate: CutDomainAssertionPredicate,
  context: EvaluationContext,
) {
  const args = bindArguments(expression, predicate, ["timeline", "width", "height", "codec", "color"]);
  const composition = timelineArgument(args.timeline!, predicate, context);
  const expected = {
    width: exactPixelLength(args.width!, "width", predicate, context),
    height: exactPixelLength(args.height!, "height", predicate, context),
    codec: stringArgument(args.codec!, "codec", predicate),
    color: stringArgument(args.color!, "color", predicate),
  };
  if (expected.codec !== "h264") fail("CUT_ASSERT_ARGUMENT", `${predicate} codec must be h264.`, predicate);
  if (!["legacy", "srgb", "linear-srgb", "rec709-full", "rec709-limited"].includes(expected.color)) {
    fail("CUT_ASSERT_ARGUMENT", `${predicate} color must be legacy, srgb, linear-srgb, rec709-full, or rec709-limited.`, predicate);
  }
  if (!Array.isArray(context.ir.outputs) || context.ir.outputs.length > context.limits.maxGraphNodes) {
    fail("CUT_ASSERT_BUDGET", `Final CUT IR outputs exceed maxGraphNodes=${context.limits.maxGraphNodes}.`, predicate);
  }
  for (const output of context.ir.outputs) {
    consumeGraphVisit(context, predicate, "Delivery output traversal");
    if (!isRecord(output) || typeof output.timelineId !== "string") fail("CUT_ASSERT_DELIVERY_GRAPH", "Final CUT IR contains a malformed output.", predicate);
    if (output.timelineId !== composition.id) continue;
    try {
      const actual = validateCutOutputContract(output, composition);
      if (actual.width === expected.width && actual.height === expected.height && actual.codec === expected.codec && actual.color === expected.color) return true;
    } catch (error) {
      const message = error instanceof CutOutputContractError ? error.message : String(error);
      fail("CUT_ASSERT_DELIVERY_GRAPH", `Delivery output ${boundedText(output.id)} is malformed: ${boundedText(message)}.`, predicate);
    }
  }
  return false;
}

function evaluatePredicate(expression: Extract<IRValue, { kind: "call" }>, predicate: CutDomainAssertionPredicate, context: EvaluationContext): boolean {
  context.budget.calls += 1;
  if (context.budget.calls > context.limits.maxPredicateCalls) {
    fail("CUT_ASSERT_BUDGET", `Assertion evaluation exceeds maxPredicateCalls=${context.limits.maxPredicateCalls}.`, predicate);
  }
  context.predicates.push(predicate);
  if (predicate === "cut.assert.timeline_duration_is") {
    const args = bindArguments(expression, predicate, ["timeline", "duration"]);
    const timeline = timelineArgument(args.timeline!, predicate, context);
    const expected = timeArgument(args.duration!, predicate, context);
    const actual = checkedRational(timeline.duration, `Timeline ${boundedText(timeline.id)} duration`, context);
    return compareRational(actual, expected) === 0;
  }
  if (predicate === "cut.assert.timeline_has_no_scene_gaps") {
    const args = bindArguments(expression, predicate, ["timeline"]);
    return hasNoSceneGaps(timelineArgument(args.timeline!, predicate, context), predicate, context);
  }
  if (predicate === "cut.assert.timeline_has_no_scene_overlaps") {
    const args = bindArguments(expression, predicate, ["timeline"]);
    return hasNoSceneOverlaps(timelineArgument(args.timeline!, predicate, context), predicate, context);
  }
  if (predicate === "cut.assert.video_range_within_locked_media") return lockedRangeWithin(expression, predicate, "video", context);
  if (predicate === "cut.assert.audio_range_within_locked_media") return lockedRangeWithin(expression, predicate, "audio", context);
  if (predicate === "cut.assert.caption_coverage_includes") return captionCoverageIncludes(expression, predicate, context);
  if (predicate === "cut.assert.delivery_target_matches") return deliveryTargetMatches(expression, predicate, context);
  const args = bindArguments(expression, predicate, ["timeline", "time"]);
  const timeline = timelineArgument(args.timeline!, predicate, context);
  const time = timeArgument(args.time!, predicate, context);
  if (predicate === "cut.assert.time_is_on_frame_grid") {
    const fps = checkedRational(timeline.fps, `Timeline ${boundedText(timeline.id)} fps`, context);
    if (compareRational(fps, zeroRational) <= 0) fail("CUT_ASSERT_TIMELINE_GRAPH", `Timeline ${boundedText(timeline.id)} fps must be positive.`, predicate);
    return exactMultiply(time, fps, `${predicate} frame index`, context).denominator === "1";
  }
  if (!Number.isSafeInteger(timeline.sampleRate) || timeline.sampleRate <= 0) {
    fail("CUT_ASSERT_TIMELINE_GRAPH", `Timeline ${boundedText(timeline.id)} sampleRate must be a positive safe integer.`, predicate);
  }
  return exactMultiply(time, rational(timeline.sampleRate), `${predicate} sample index`, context).denominator === "1";
}

function evaluateExpression(value: unknown, context: EvaluationContext, depth: number): ValueEvaluation {
  context.budget.nodes += 1;
  if (context.budget.nodes > context.limits.maxExpressionNodes) {
    fail("CUT_ASSERT_BUDGET", `Assertion evaluation exceeds maxExpressionNodes=${context.limits.maxExpressionNodes}.`);
  }
  if (depth > context.limits.maxExpressionDepth) {
    fail("CUT_ASSERT_BUDGET", `Assertion exceeds maxExpressionDepth=${context.limits.maxExpressionDepth}.`);
  }
  if (!isRecord(value) || typeof value.kind !== "string") fail("CUT_ASSERT_EXPRESSION", "Assertion expression must be a typed IR value.");
  if (context.active.has(value)) fail("CUT_ASSERT_CYCLE", "Assertion expression contains a cycle.");
  context.active.add(value);
  try {
    if (value.kind === "boolean") {
      if (typeof value.value !== "boolean") fail("CUT_ASSERT_EXPRESSION", "Boolean assertion literal must contain a boolean value.");
      return { kind: "value", value: value.value };
    }
    if (value.kind === "unary") {
      if (value.operator !== "!") fail("CUT_ASSERT_BOOLEAN_OPERATOR", `Unsupported assertion unary operator ${boundedText(value.operator)}.`);
      const child = evaluateExpression(value.value, context, depth + 1);
      return child.kind === "value" ? { kind: "value", value: !child.value } : child;
    }
    if (value.kind === "binary") {
      if (value.operator !== "&&" && value.operator !== "||") {
        fail("CUT_ASSERT_BOOLEAN_OPERATOR", `Unsupported assertion boolean operator ${boundedText(value.operator)}.`);
      }
      // Domain assertions are deliberately strict rather than short-circuiting:
      // unsupported or malformed predicates must not hide behind a true/false arm.
      const left = evaluateExpression(value.left, context, depth + 1);
      const right = evaluateExpression(value.right, context, depth + 1);
      if (left.kind === "unsupported") return left;
      if (right.kind === "unsupported") return right;
      return { kind: "value", value: value.operator === "&&" ? left.value && right.value : left.value || right.value };
    }
    if (value.kind === "call") {
      if (typeof value.op !== "string" || !predicateSet.has(value.op)) {
        return {
          kind: "unsupported",
          code: "CUT_ASSERT_UNSUPPORTED_PREDICATE",
          message: `Unsupported native assertion predicate ${boundedText(value.op)}.`,
        };
      }
      const predicate = value.op as CutDomainAssertionPredicate;
      return { kind: "value", value: evaluatePredicate(value as Extract<IRValue, { kind: "call" }>, predicate, context) };
    }
    return {
      kind: "unsupported",
      code: "CUT_ASSERT_UNSUPPORTED_EXPRESSION",
      message: `Unsupported assertion IR value kind ${boundedText(value.kind)}.`,
    };
  } finally {
    context.active.delete(value);
  }
}

function diagnostic(context: EvaluationContext, failure: EvaluationFailure): CutDomainAssertionDiagnostic {
  return {
    code: failure.code,
    message: `${failure.message} at ${location(context.source)}.`,
    assertionId: context.assertion.id,
    source: context.source,
    ...(failure.predicate ? { predicate: failure.predicate } : {}),
  };
}

/**
 * Evaluate one final-IR assertion from its expression. The stored assertion
 * status is intentionally ignored: callers cannot turn a failed predicate into
 * a pass by mutating IRAssertion.status.
 */
export function evaluateCutDomainAssertion(
  ir: CutAVIR,
  assertion: IRAssertion,
  options: { limits?: Partial<CutDomainAssertionLimits> } = {},
): CutDomainAssertionResult {
  const limits = resolvedLimits(options.limits);
  return evaluateCutDomainAssertionWithLimits(ir, assertion, limits, { nodes: 0, calls: 0, graphVisits: 0 });
}

function evaluateCutDomainAssertionWithLimits(
  ir: CutAVIR,
  assertion: IRAssertion,
  limits: CutDomainAssertionLimits,
  budget: { nodes: number; calls: number; graphVisits: number },
): CutDomainAssertionResult {
  const source = sourceOf(assertion.provenance);
  const context: EvaluationContext = {
    ir,
    assertion,
    source,
    limits,
    budget,
    active: new WeakSet(),
    predicates: [],
  };
  try {
    const evaluated = evaluateExpression(assertion.expression, context, 1);
    if (evaluated.kind === "unsupported") {
      return { assertionId: assertion.id, source, predicates: [...context.predicates], status: "unsupported", code: evaluated.code, message: `${evaluated.message} at ${location(source)}.` };
    }
    return { assertionId: assertion.id, source, predicates: [...context.predicates], status: evaluated.value ? "pass" : "fail", value: evaluated.value };
  } catch (error) {
    if (error instanceof EvaluationDeferred) {
      return {
        assertionId: assertion.id,
        source,
        predicates: [...context.predicates],
        status: "unsupported",
        code: error.code,
        message: `${error.message} at ${location(source)}.`,
      };
    }
    if (!(error instanceof EvaluationFailure)) throw error;
    return { assertionId: assertion.id, source, predicates: [...context.predicates], status: "error", diagnostic: diagnostic(context, error) };
  }
}

/** Evaluate every final-IR assertion with a closed aggregate budget. */
export function evaluateCutDomainAssertions(
  ir: CutAVIR,
  options: { limits?: Partial<CutDomainAssertionLimits> } = {},
): CutDomainAssertionReport {
  const limits = resolvedLimits(options.limits);
  if (!Array.isArray(ir.assertions)) throw new TypeError("Final CUT IR assertions must be an array.");
  if (ir.assertions.length > limits.maxAssertions) {
    const assertion = ir.assertions[limits.maxAssertions]!;
    const source = sourceOf(assertion.provenance);
    const diagnosticValue: CutDomainAssertionDiagnostic = {
      code: "CUT_ASSERT_BUDGET",
      message: `Final CUT IR exceeds maxAssertions=${limits.maxAssertions} at ${location(source)}.`,
      assertionId: assertion.id,
      source,
    };
    return { status: "error", results: [], counts: { pass: 0, fail: 0, unsupported: 0, error: 1 }, diagnostic: diagnosticValue };
  }
  // Expression-node and predicate-call limits are shared across the complete
  // assertion set. Otherwise a hostile graph could multiply the nominal
  // per-assertion budget by maxAssertions and repeatedly rescan large timelines.
  const budget = { nodes: 0, calls: 0, graphVisits: 0 };
  const results = ir.assertions.map((assertion) => evaluateCutDomainAssertionWithLimits(ir, assertion, limits, budget));
  const counts = {
    pass: results.filter((result) => result.status === "pass").length,
    fail: results.filter((result) => result.status === "fail").length,
    unsupported: results.filter((result) => result.status === "unsupported").length,
    error: results.filter((result) => result.status === "error").length,
  };
  const firstError = results.find((result): result is Extract<CutDomainAssertionResult, { status: "error" }> => result.status === "error");
  return {
    status: counts.error || counts.unsupported ? "error" : counts.fail ? "fail" : "pass",
    results,
    counts,
    ...(firstError ? { diagnostic: firstError.diagnostic } : {}),
  };
}

/**
 * Recompute stored assertion states after cut.lock metadata has been embedded.
 * Compile-time lock-dependent predicates are intentionally `deferred`; this
 * is the only transition that may replace that state with pass/fail. Unknown
 * third-party predicates remain deferred and are still refused by release
 * execution.
 */
export function refreshLockedCutDomainAssertionStatuses(ir: CutAVIR) {
  const report = evaluateCutDomainAssertions(ir);
  if (report.diagnostic && report.results.length === 0) {
    const error = new Error(report.diagnostic.message) as Error & {
      code: string;
      source: CutDomainAssertionSource;
    };
    error.code = report.diagnostic.code;
    error.source = report.diagnostic.source;
    throw error;
  }
  for (let index = 0; index < ir.assertions.length; index += 1) {
    const assertion = ir.assertions[index]!;
    const result = report.results[index]!;
    if (result.status === "error") {
      const error = new Error(result.diagnostic.message) as Error & {
        code: string;
        source: CutDomainAssertionSource;
      };
      error.code = result.diagnostic.code;
      error.source = result.source;
      throw error;
    }
    if (result.status === "unsupported" && result.code === "CUT_ASSERT_REQUIRES_LOCK") {
      const error = new Error(result.message) as Error & {
        code: string;
        source: CutDomainAssertionSource;
      };
      error.code = result.code;
      error.source = result.source;
      throw error;
    }
    assertion.status = result.status === "unsupported" ? "deferred" : result.status;
  }
  return report;
}
