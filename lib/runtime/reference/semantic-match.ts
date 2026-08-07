import { createHash } from "node:crypto";
import { hash } from "../../core/stable";
import type {
  CutAVIR,
  IRComposition,
  IRNode,
  IRProvenance,
  IRScene,
  IRSemanticMatchSubjectV1,
  IRSemanticMatchTransitionV1,
  IRValue,
} from "../../language/ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import { referenceCamera2DLocalSpacePlanAt } from "./camera2d-local-space";
import {
  referenceLocalSpaceRasterOrigin,
  validateReferenceLocalSpaceGraph,
  type ReferenceLocalSpaceConfig,
  type ReferenceLocalSpacePlacement,
} from "./local-space";
import {
  planReferenceLocalSpaceTileTransformWork,
  type ReferenceLocalSpaceUniformTileTransformWork,
} from "./local-space-transform-work";
import { propertyAt, type ReferencePreparedSignalResolver } from "./signals";

export const referenceSemanticMatchAlgorithmVersion = "cut-reference-semantic-match-v1" as const;
export const referenceSemanticMatchFrameEvidenceFormat = "cut-reference-semantic-match-frame-evidence" as const;

export const referenceSemanticMatchLimits = Object.freeze({
  maximumSubjectsPerComposition: 256,
  maximumTransitionsPerComposition: 128,
  maximumPairsAtCut: 8,
  maximumFramesPerTransition: 600,
  maximumTintedLocalPixelsPerFrame: 16_777_216,
  maximumTargetScale: 64,
});

export type ReferenceSemanticMatchErrorCode =
  | "CUT_MATCH_SCOPE"
  | "CUT_MATCH_ID"
  | "CUT_MATCH_SUBJECT"
  | "CUT_MATCH_CAMERA"
  | "CUT_MATCH_CUT"
  | "CUT_MATCH_BASIS"
  | "CUT_MATCH_TRANSFORM"
  | "CUT_MATCH_EASING"
  | "CUT_MATCH_VELOCITY"
  | "CUT_MATCH_CONFLICT"
  | "CUT_MATCH_LIMIT"
  | "CUT_MATCH_NOOP"
  | "CUT_MATCH_CONTRACT"
  | "CUT_MATCH_RENDER"
  | "CUT_MATCH_NESTING";

type SourceLocated = Readonly<{ id: string; provenance: IRProvenance }>;

export class ReferenceSemanticMatchError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; declarationId: string }>;

  constructor(readonly code: ReferenceSemanticMatchErrorCode, declaration: SourceLocated, detail: string) {
    const { module, span } = declaration.provenance;
    super(`${code}: semantic match at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceSemanticMatchError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, declarationId: declaration.id });
  }
}

type ExactPose = Readonly<{
  x: Rational;
  y: Rational;
  scale: Rational;
  rotation: Rational;
  opacity: Rational;
}>;

export type ReferenceSemanticMatchAppliedPose = Readonly<{
  x: Rational;
  y: Rational;
  scale: Rational;
  rotation: Rational;
  opacity: Rational;
}>;

type PreparedSubject = Readonly<{
  record: IRSemanticMatchSubjectV1;
  scene: IRScene;
  camera: IRNode;
  localSpace: ReferenceLocalSpaceConfig;
}>;

type PreparedTransition = Readonly<{
  record: IRSemanticMatchTransitionV1;
  outgoing: PreparedSubject;
  incoming: PreparedSubject;
  halfDuration: Rational;
  frameCount: number;
  carry?: Readonly<{
    start: Readonly<{ x: Rational; y: Rational }>;
    end: Readonly<{ x: Rational; y: Rational }>;
    normalizedTangent: Readonly<{ x: Rational; y: Rational }>;
    velocityPerSecond: Readonly<{ x: Rational; y: Rational }>;
  }>;
  planIdentity: string;
}>;

type PreparedSide = Readonly<{
  transition: PreparedTransition;
  side: "outgoing" | "incoming";
  subject: PreparedSubject;
  window: Readonly<{ start: Rational; duration: Rational }>;
}>;

export type ReferenceSemanticMatchSample = Readonly<{
  algorithmVersion: typeof referenceSemanticMatchAlgorithmVersion;
  transitionId: string;
  authoredTransitionId: string;
  subjectId: string;
  authoredSubjectId: string;
  cameraNodeId: string;
  localSpaceNodeId: string;
  side: "outgoing" | "incoming";
  exactTime: Rational;
  sceneLocalTime: Rational;
  window: Readonly<{ start: Rational; duration: Rational }>;
  progress: Rational;
  easedProgress: Rational;
  tintAmount: Rational;
  nativePose: ExactPose;
  appliedPose: ReferenceSemanticMatchAppliedPose;
  placement: ReferenceLocalSpacePlacement;
  transformWork: ReferenceLocalSpaceUniformTileTransformWork;
  targetColor?: string;
  carryVelocity?: Readonly<{ x: Rational; y: Rational }>;
  /** Invocation-local source authority for late surface diagnostics. It is
   * intentionally omitted from execution identity and public frame receipts. */
  declaration: SourceLocated;
  planIdentity: string;
  executionIdentity: string;
}>;

export type ReferenceSemanticMatchFrameEvidence = Readonly<{
  format: typeof referenceSemanticMatchFrameEvidenceFormat;
  version: 1;
  evidenceKind: "completed-frame-execution";
  algorithmVersion: typeof referenceSemanticMatchAlgorithmVersion;
  compositionId: string;
  transitionId: string;
  authoredTransitionId: string;
  subjectId: string;
  authoredSubjectId: string;
  cameraNodeId: string;
  localSpaceNodeId: string;
  side: "outgoing" | "incoming";
  exactTime: Rational;
  sceneLocalTime: Rational;
  window: Readonly<{ start: Rational; duration: Rational }>;
  progress: Rational;
  easedProgress: Rational;
  tintAmount: Rational;
  nativePose: ExactPose;
  appliedPose: ReferenceSemanticMatchAppliedPose;
  carryVelocity?: Readonly<{ x: Rational; y: Rational }>;
  color?: Readonly<{ target: string; algorithm: "linear-srgb-luminance-preserving-chroma-v1" }>;
  surfaces: Readonly<{
    tileRgbaSha256: string;
    tintedTileRgbaSha256: string;
    placedRgbaSha256: string;
    width: number;
    height: number;
  }>;
  work: Readonly<{
    tintedPixels: number;
    transformWorkIdentity: string;
    placementContextIdentity: string;
  }>;
  planIdentity: string;
  executionIdentity: string;
}>;

type RgbaSurface = Readonly<{ data: Buffer; width: number; height: number }>;

function fail(declaration: SourceLocated, code: ReferenceSemanticMatchErrorCode, detail: string): never {
  throw new ReferenceSemanticMatchError(code, declaration, detail);
}

function same(left: Rational, right: Rational) { return compareRational(left, right) === 0; }
function clone(value: Rational): Rational { return Object.freeze({ ...value }); }
function exactZero(value: Rational) { return BigInt(value.numerator) === 0n; }

function intervalEnd(interval: Readonly<{ start: Rational; duration: Rational }>) {
  return addRational(interval.start, interval.duration);
}

function sameInterval(left: Readonly<{ start: Rational; duration: Rational }>, right: Readonly<{ start: Rational; duration: Rational }>) {
  return same(left.start, right.start) && same(left.duration, right.duration);
}

function overlaps(left: Readonly<{ start: Rational; duration: Rational }>, right: Readonly<{ start: Rational; duration: Rational }>) {
  return compareRational(left.start, intervalEnd(right)) < 0 && compareRational(right.start, intervalEnd(left)) < 0;
}

function add(...values: Rational[]) { return values.reduce(addRational, zeroRational); }
function sub(left: Rational, right: Rational) { return subtractRational(left, right); }
function mul(left: Rational, right: Rational) { return multiplyRational(left, right); }
function div(left: Rational, right: Rational) { return divideRational(left, right); }
function oneMinus(value: Rational) { return sub(rational(1), value); }
function square(value: Rational) { return mul(value, value); }
function cube(value: Rational) { return mul(square(value), value); }

function ease(progress: Rational, easing: IRSemanticMatchTransitionV1["easing"]): Rational {
  if (compareRational(progress, zeroRational) <= 0) return zeroRational;
  if (compareRational(progress, rational(1)) >= 0) return rational(1);
  if (easing === "linear") return progress;
  if (easing === "inCubic") return cube(progress);
  if (easing === "outCubic") return oneMinus(cube(oneMinus(progress)));
  if (easing === "inOutCubic") {
    if (compareRational(mul(progress, rational(2)), rational(1)) < 0) return mul(rational(4), cube(progress));
    return sub(rational(1), div(cube(sub(rational(2), mul(rational(2), progress))), rational(2)));
  }
  return progress;
}

function lerp(left: Rational, right: Rational, amount: Rational) {
  return add(left, mul(sub(right, left), amount));
}

function hermite(p0: Rational, p1: Rational, m0: Rational, m1: Rational, progress: Rational) {
  const s2 = square(progress), s3 = mul(s2, progress);
  const h00 = add(mul(rational(2), s3), mul(rational(-3), s2), rational(1));
  const h10 = add(s3, mul(rational(-2), s2), progress);
  const h01 = add(mul(rational(-2), s3), mul(rational(3), s2));
  const h11 = sub(s3, s2);
  return add(mul(h00, p0), mul(h10, m0), mul(h01, p1), mul(h11, m1));
}

function quantity(
  declaration: SourceLocated,
  value: IRValue | undefined,
  label: string,
  dimension: "length" | "scalar" | "angle" | "ratio",
  unit: "px" | "scalar" | "deg" | "ratio",
  fallback: Rational,
) {
  if (value === undefined || value.kind === "null") return fallback;
  if (value.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail(declaration, "CUT_MATCH_TRANSFORM", `${label} must resolve to one canonical ${dimension} quantity in ${unit}.`);
  }
  return value.magnitude;
}

function nativePose(
  ir: CutAVIR,
  camera: IRNode,
  sceneLocalTime: Rational,
  resolver?: ReferencePreparedSignalResolver,
): ExactPose {
  const resolved = (name: string) => propertyAt(ir, camera, name, sceneLocalTime, resolver) ?? camera.inputs[name];
  return Object.freeze({
    x: clone(quantity(camera, resolved("x"), "Camera2D x", "length", "px", zeroRational)),
    y: clone(quantity(camera, resolved("y"), "Camera2D y", "length", "px", zeroRational)),
    scale: clone(quantity(camera, resolved("scale"), "Camera2D scale", "scalar", "scalar", rational(1))),
    rotation: clone(quantity(camera, resolved("rotation"), "Camera2D rotation", "angle", "deg", zeroRational)),
    opacity: clone(quantity(camera, resolved("opacity"), "Camera2D opacity", "ratio", "ratio", rational(1))),
  });
}

function poseNumbers(pose: ExactPose) {
  return Object.freeze({
    x: rationalToNumber(pose.x),
    y: rationalToNumber(pose.y),
    scale: rationalToNumber(pose.scale),
    rotation: rationalToNumber(pose.rotation),
    opacity: rationalToNumber(pose.opacity),
  });
}

function exactFrameCount(declaration: SourceLocated, duration: Rational, fps: Rational, label: string) {
  const exact = mul(duration, fps);
  if (exact.denominator !== "1") fail(declaration, "CUT_MATCH_CUT", `${label} must land on the exact composition frame grid.`);
  const frames = BigInt(exact.numerator);
  if (frames < 0n || frames > BigInt(Number.MAX_SAFE_INTEGER)) fail(declaration, "CUT_MATCH_LIMIT", `${label} has an unbounded frame count.`);
  return Number(frames);
}

function validateColor(transition: IRSemanticMatchTransitionV1) {
  const color = transition.target.color;
  if (color === undefined) return;
  if (!/^#[0-9a-f]{6}(?:ff)?$/u.test(color)) {
    fail(transition, "CUT_MATCH_TRANSFORM", "target color must be one canonical lowercase opaque sRGB Color.");
  }
}

function validateTarget(transition: IRSemanticMatchTransitionV1) {
  if (!(new Set(["linear", "inCubic", "outCubic", "inOutCubic"])).has(transition.easing)) {
    fail(transition, "CUT_MATCH_EASING", `unsupported easing ${JSON.stringify(transition.easing)}.`);
  }
  if (transition.velocity !== undefined && transition.velocity !== "settle" && transition.velocity !== "carry") {
    fail(transition, "CUT_MATCH_VELOCITY", `unsupported velocity continuity ${JSON.stringify(transition.velocity)}.`);
  }
  const within = (value: Rational, minimum: number, maximum: number, label: string) => {
    if (compareRational(value, rational(minimum)) < 0 || compareRational(value, rational(maximum)) > 0) {
      fail(transition, "CUT_MATCH_TRANSFORM", `${label} must be between ${minimum} and ${maximum}.`);
    }
  };
  within(transition.target.x, -65_536, 65_536, "target x");
  within(transition.target.y, -65_536, 65_536, "target y");
  if (compareRational(transition.target.scale, zeroRational) <= 0
    || compareRational(transition.target.scale, rational(referenceSemanticMatchLimits.maximumTargetScale)) > 0) {
    fail(transition, "CUT_MATCH_TRANSFORM", `target scale must be greater than zero and at most ${referenceSemanticMatchLimits.maximumTargetScale}.`);
  }
  within(transition.target.rotation, -360_000, 360_000, "target rotation");
  validateColor(transition);
  if (transition.velocity !== undefined && transition.easing !== "inOutCubic") {
    fail(transition, "CUT_MATCH_EASING", `velocity ${JSON.stringify(transition.velocity)} requires easing inOutCubic.`);
  }
}

function validateSubject(
  ir: CutAVIR,
  composition: IRComposition,
  subject: IRSemanticMatchSubjectV1,
  localSpaces: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
) {
  if (subject.compositionId !== composition.id) fail(subject, "CUT_MATCH_CONTRACT", `subject compositionId ${subject.compositionId} does not match ${composition.id}.`);
  const scene = ir.scenes[subject.sceneId];
  if (!scene || !composition.sceneIds.includes(scene.id)) fail(subject, "CUT_MATCH_SUBJECT", `references missing or foreign scene ${subject.sceneId}.`);
  const camera = ir.nodes[subject.cameraNodeId];
  if (!camera) fail(subject, "CUT_MATCH_SUBJECT", `references missing Camera2D node ${subject.cameraNodeId}.`);
  if (camera.op !== "cut.visual.camera2d" || camera.domain !== "visual" || camera.ownership !== "root"
    || camera.sceneId !== scene.id || !scene.rootVisualIds.includes(camera.id)) {
    fail(subject, "CUT_MATCH_CAMERA", `camera ${camera.id} must be one direct visual root Camera2D in scene ${scene.id}.`);
  }
  if (camera.children.length !== 1 || camera.children[0] !== subject.localSpaceNodeId) {
    fail(subject, "CUT_MATCH_CAMERA", `Camera2D ${camera.id} must contain exactly declared LocalSpace ${subject.localSpaceNodeId}.`);
  }
  if (!same(camera.interval.start, zeroRational) || !same(camera.interval.duration, scene.duration)) {
    fail(subject, "CUT_MATCH_SUBJECT", `Camera2D ${camera.id} must span its complete scene interval.`);
  }
  const localNode = ir.nodes[subject.localSpaceNodeId], localSpace = localSpaces.get(subject.localSpaceNodeId);
  if (!localNode || localNode.op !== "cut.visual.local_space" || !localSpace
    || localSpace.owner !== "camera-2d" || localSpace.ownerNodeId !== camera.id) {
    fail(subject, "CUT_MATCH_CAMERA", `declared LocalSpace ${subject.localSpaceNodeId} is not Camera2D ${camera.id}'s retained local basis.`);
  }
  if (!same(localNode.interval.start, zeroRational) || !same(localNode.interval.duration, scene.duration)) {
    fail(subject, "CUT_MATCH_SUBJECT", `LocalSpace ${localNode.id} must span its complete scene interval.`);
  }
  if (subject.basis.width !== localSpace.width || subject.basis.height !== localSpace.height
    || !same(subject.basis.origin.x, localSpace.origin.x) || !same(subject.basis.origin.y, localSpace.origin.y)) {
    fail(subject, "CUT_MATCH_CONTRACT", `stored basis does not equal LocalSpace ${localNode.id}'s exact declared basis.`);
  }
  return Object.freeze({ record: subject, scene, camera, localSpace }) satisfies PreparedSubject;
}

function validateTransitionReference(
  transition: IRSemanticMatchTransitionV1,
  label: "outgoing" | "incoming",
  subject: PreparedSubject,
) {
  const reference = transition[label];
  if (reference.subjectId !== subject.record.id || reference.sceneId !== subject.scene.id
    || reference.cameraNodeId !== subject.camera.id || reference.localSpaceNodeId !== subject.localSpace.nodeId) {
    fail(transition, "CUT_MATCH_CONTRACT", `${label} stored scene/node references disagree with subject ${subject.record.id}.`);
  }
}

/** Validate the complete optional IR section before selecting one composition.
 *
 * The renderer prepares one composition at a time, but `semanticMatches` is a
 * project-level collection. Filtering first would turn a forged record whose
 * `compositionId` names a missing timeline into inert data. It would also let
 * an extra MatchSubject survive without any transition consuming it. Keep this
 * structural pass independent of LocalSpace preparation so every supplied
 * record is rejected or accounted for even when it belongs to another valid
 * composition.
 */
function validateSemanticMatchRecordUniverse(ir: CutAVIR, matches: NonNullable<CutAVIR["semanticMatches"]>) {
  const compositions = new Map(ir.compositions.map((candidate) => [candidate.id, candidate]));
  const subjects = new Map<string, IRSemanticMatchSubjectV1>();
  const subjectScopes = new Set<string>();
  const subjectsPerComposition = new Map<string, number>();

  for (const record of matches.subjects) {
    if (record.version !== 1 || record.kind !== "semantic-match-subject") {
      fail(record, "CUT_MATCH_CONTRACT", "subject must use the closed semantic-match-subject v1 record shape.");
    }
    const composition = compositions.get(record.compositionId);
    if (!composition) fail(record, "CUT_MATCH_SCOPE", `subject references missing composition ${JSON.stringify(record.compositionId)}.`);
    if (subjects.has(record.id)) fail(record, "CUT_MATCH_ID", `duplicate subject identity ${JSON.stringify(record.id)}.`);
    const scope = `${record.compositionId}\0${record.authoredId}`;
    if (subjectScopes.has(scope)) fail(record, "CUT_MATCH_ID", `duplicate subject identity ${JSON.stringify(record.authoredId)} in composition ${JSON.stringify(record.compositionId)}.`);
    const count = (subjectsPerComposition.get(record.compositionId) ?? 0) + 1;
    if (count > referenceSemanticMatchLimits.maximumSubjectsPerComposition) {
      fail(record, "CUT_MATCH_LIMIT", `composition exceeds ${referenceSemanticMatchLimits.maximumSubjectsPerComposition} subjects.`);
    }
    subjectsPerComposition.set(record.compositionId, count);
    subjects.set(record.id, record);

    const scene = ir.scenes[record.sceneId];
    if (!scene || !composition.sceneIds.includes(scene.id)) {
      fail(record, "CUT_MATCH_SCOPE", `subject scene ${JSON.stringify(record.sceneId)} is not owned by composition ${JSON.stringify(record.compositionId)}.`);
    }
    const camera = ir.nodes[record.cameraNodeId], localSpace = ir.nodes[record.localSpaceNodeId];
    if (!camera || camera.op !== "cut.visual.camera2d" || camera.domain !== "visual" || camera.ownership !== "root"
      || camera.sceneId !== scene.id || !scene.rootVisualIds.includes(camera.id)) {
      fail(record, "CUT_MATCH_CAMERA", `subject Camera2D ${JSON.stringify(record.cameraNodeId)} is not a direct visual root of scene ${JSON.stringify(scene.id)}.`);
    }
    if (camera.children.length !== 1 || camera.children[0] !== record.localSpaceNodeId
      || !localSpace || localSpace.op !== "cut.visual.local_space" || localSpace.domain !== "visual"
      || localSpace.ownership !== "child" || localSpace.sceneId !== scene.id) {
      fail(record, "CUT_MATCH_CAMERA", `subject LocalSpace ${JSON.stringify(record.localSpaceNodeId)} is not the sole direct child of Camera2D ${JSON.stringify(record.cameraNodeId)}.`);
    }
  }

  const transitionIds = new Set<string>();
  const transitionScopes = new Set<string>();
  const transitionsPerComposition = new Map<string, number>();
  const usedSubjects = new Set<string>();
  for (const record of matches.transitions) {
    if (record.version !== 1 || record.kind !== "semantic-match-transition") {
      fail(record, "CUT_MATCH_CONTRACT", "transition must use the closed semantic-match-transition v1 record shape.");
    }
    if (!compositions.has(record.compositionId)) {
      fail(record, "CUT_MATCH_SCOPE", `transition references missing composition ${JSON.stringify(record.compositionId)}.`);
    }
    if (transitionIds.has(record.id)) fail(record, "CUT_MATCH_ID", `duplicate transition identity ${JSON.stringify(record.id)}.`);
    transitionIds.add(record.id);
    const scope = `${record.compositionId}\0${record.authoredId}`;
    if (transitionScopes.has(scope)) fail(record, "CUT_MATCH_ID", `duplicate transition identity ${JSON.stringify(record.authoredId)} in composition ${JSON.stringify(record.compositionId)}.`);
    transitionScopes.add(scope);
    const count = (transitionsPerComposition.get(record.compositionId) ?? 0) + 1;
    if (count > referenceSemanticMatchLimits.maximumTransitionsPerComposition) {
      fail(record, "CUT_MATCH_LIMIT", `composition exceeds ${referenceSemanticMatchLimits.maximumTransitionsPerComposition} transitions.`);
    }
    transitionsPerComposition.set(record.compositionId, count);
    validateTarget(record);

    const outgoing = subjects.get(record.outgoing.subjectId), incoming = subjects.get(record.incoming.subjectId);
    if (!outgoing || !incoming) fail(record, "CUT_MATCH_SUBJECT", "transition references a missing semantic-match subject.");
    if (outgoing === incoming) fail(record, "CUT_MATCH_SUBJECT", "outgoing and incoming must reference two distinct semantic-match subjects.");
    if (outgoing.compositionId !== record.compositionId || incoming.compositionId !== record.compositionId) {
      fail(record, "CUT_MATCH_SCOPE", "transition and both referenced subjects must belong to the same composition.");
    }
    const sideMatches = (side: IRSemanticMatchTransitionV1["outgoing"], subject: IRSemanticMatchSubjectV1) => side.sceneId === subject.sceneId
      && side.cameraNodeId === subject.cameraNodeId && side.localSpaceNodeId === subject.localSpaceNodeId;
    if (!sideMatches(record.outgoing, outgoing) || !sideMatches(record.incoming, incoming)) {
      fail(record, "CUT_MATCH_CONTRACT", "stored transition scene/node references disagree with a referenced MatchSubject.");
    }
    usedSubjects.add(outgoing.id);
    usedSubjects.add(incoming.id);
  }

  for (const subject of matches.subjects) if (!usedSubjects.has(subject.id)) {
    fail(subject, "CUT_MATCH_SUBJECT", `subject ${JSON.stringify(subject.authoredId)} is unused; MatchSubject declarations cannot be inert in v1.`);
  }
}

function sourceAt(scene: IRScene, absolute: Rational) { return sub(absolute, scene.start); }

function staticCarryEndpoint(
  ir: CutAVIR,
  subject: PreparedSubject,
  absolute: Rational,
  resolver?: ReferencePreparedSignalResolver,
) {
  const pose = nativePose(ir, subject.camera, sourceAt(subject.scene, absolute), resolver);
  return Object.freeze({ x: pose.x, y: pose.y });
}

function preparedTransitionIdentity(record: IRSemanticMatchTransitionV1, outgoing: PreparedSubject, incoming: PreparedSubject, carry?: PreparedTransition["carry"]) {
  const { provenance, ...semantic } = record;
  void provenance;
  return hash({
    algorithmVersion: referenceSemanticMatchAlgorithmVersion,
    transition: semantic,
    bases: [outgoing.record.basis, incoming.record.basis],
    ...(carry ? { carry } : {}),
  });
}

function makePreparedTransition(
  ir: CutAVIR,
  composition: IRComposition,
  transition: IRSemanticMatchTransitionV1,
  subjects: ReadonlyMap<string, PreparedSubject>,
  resolver?: ReferencePreparedSignalResolver,
): PreparedTransition {
  if (transition.compositionId !== composition.id) fail(transition, "CUT_MATCH_CONTRACT", `transition compositionId ${transition.compositionId} does not match ${composition.id}.`);
  validateTarget(transition);
  const outgoing = subjects.get(transition.outgoing.subjectId), incoming = subjects.get(transition.incoming.subjectId);
  if (!outgoing || !incoming) fail(transition, "CUT_MATCH_SUBJECT", "references a missing semantic-match subject.");
  validateTransitionReference(transition, "outgoing", outgoing);
  validateTransitionReference(transition, "incoming", incoming);
  const outgoingIndex = composition.sceneIds.indexOf(outgoing.scene.id), incomingIndex = composition.sceneIds.indexOf(incoming.scene.id);
  if (outgoingIndex < 0 || incomingIndex !== outgoingIndex + 1
    || !same(addRational(outgoing.scene.start, outgoing.scene.duration), transition.cut)
    || !same(incoming.scene.start, transition.cut)) {
    fail(transition, "CUT_MATCH_CUT", "must join exactly two adjacent contiguous scenes at their authored hard cut.");
  }
  const frames = exactFrameCount(transition, transition.duration, composition.fps, "duration");
  if (frames < 4 || frames % 2 !== 0) fail(transition, "CUT_MATCH_CUT", "duration must contain an even number of frames and at least four frames.");
  if (frames > referenceSemanticMatchLimits.maximumFramesPerTransition) {
    fail(transition, "CUT_MATCH_LIMIT", `duration exceeds ${referenceSemanticMatchLimits.maximumFramesPerTransition} frames.`);
  }
  const halfDuration = div(transition.duration, rational(2));
  const expectedOutgoing = Object.freeze({ start: sub(transition.cut, halfDuration), duration: halfDuration });
  const expectedIncoming = Object.freeze({ start: transition.cut, duration: halfDuration });
  if (!sameInterval(transition.outgoingWindow, expectedOutgoing) || !sameInterval(transition.incomingWindow, expectedIncoming)) {
    fail(transition, "CUT_MATCH_CONTRACT", "stored half-open windows disagree with the centered duration and cut.");
  }
  if (compareRational(expectedOutgoing.start, outgoing.scene.start) < 0
    || compareRational(intervalEnd(expectedIncoming), intervalEnd({ start: incoming.scene.start, duration: incoming.scene.duration })) > 0) {
    fail(transition, "CUT_MATCH_CUT", "centered half-windows must fit completely inside their adjacent scenes.");
  }
  if (outgoing.record.basis.width !== incoming.record.basis.width || outgoing.record.basis.height !== incoming.record.basis.height
    || !same(outgoing.record.basis.origin.x, incoming.record.basis.origin.x)
    || !same(outgoing.record.basis.origin.y, incoming.record.basis.origin.y)) {
    fail(transition, "CUT_MATCH_BASIS", "paired LocalSpaces must have exactly equal width, height, and origin.");
  }
  if (transition.target.color && outgoing.localSpace.width * outgoing.localSpace.height > referenceSemanticMatchLimits.maximumTintedLocalPixelsPerFrame) {
    fail(transition, "CUT_MATCH_LIMIT", `tinted LocalSpace exceeds ${referenceSemanticMatchLimits.maximumTintedLocalPixelsPerFrame} pixels per frame.`);
  }
  let carry: PreparedTransition["carry"];
  if (transition.velocity === "carry") {
    const start = staticCarryEndpoint(ir, outgoing, expectedOutgoing.start, resolver);
    const end = staticCarryEndpoint(ir, incoming, intervalEnd(expectedIncoming), resolver);
    const normalizedTangent = Object.freeze({ x: div(sub(end.x, start.x), rational(2)), y: div(sub(end.y, start.y), rational(2)) });
    const velocityPerSecond = Object.freeze({ x: div(normalizedTangent.x, halfDuration), y: div(normalizedTangent.y, halfDuration) });
    carry = Object.freeze({ start, end, normalizedTangent, velocityPerSecond });
  }
  const planIdentity = preparedTransitionIdentity(transition, outgoing, incoming, carry);
  return Object.freeze({ record: transition, outgoing, incoming, halfDuration, frameCount: frames, ...(carry ? { carry } : {}), planIdentity });
}

function sideFor(transition: PreparedTransition, side: "outgoing" | "incoming"): PreparedSide {
  return Object.freeze({
    transition,
    side,
    subject: side === "outgoing" ? transition.outgoing : transition.incoming,
    window: side === "outgoing" ? transition.record.outgoingWindow : transition.record.incomingWindow,
  });
}

function poseEqual(left: ExactPose, right: ExactPose) {
  return same(left.x, right.x) && same(left.y, right.y) && same(left.scale, right.scale)
    && same(left.rotation, right.rotation) && same(left.opacity, right.opacity);
}

function semanticMatchSample(
  ir: CutAVIR,
  composition: IRComposition,
  prepared: PreparedSide,
  exactTime: Rational,
  sceneLocalTime: Rational,
  resolver?: ReferencePreparedSignalResolver,
): ReferenceSemanticMatchSample {
  const { transition, side, subject, window } = prepared;
  if (compareRational(exactTime, window.start) < 0 || compareRational(exactTime, intervalEnd(window)) >= 0) {
    fail(transition.record, "CUT_MATCH_RENDER", `${side} sample lies outside its owned half-open window.`);
  }
  const progress = div(sub(exactTime, window.start), window.duration), easedProgress = ease(progress, transition.record.easing);
  const native = nativePose(ir, subject.camera, sceneLocalTime, resolver);
  if (!same(native.opacity, rational(1))) fail(transition.record, "CUT_MATCH_TRANSFORM", `${side} Camera2D opacity must remain exactly 100% on every executed match frame.`);
  // Re-run the ordinary retained Camera2D planner so semantic match cannot
  // bypass its source-located transform/type/allocation contract.
  referenceCamera2DLocalSpacePlanAt(ir, composition, subject.camera, subject.localSpace, sceneLocalTime, resolver);
  const target = transition.record.target;
  let x: Rational, y: Rational;
  if (transition.carry) {
    const tangent = transition.carry.normalizedTangent;
    if (side === "outgoing") {
      x = hermite(transition.carry.start.x, target.x, zeroRational, tangent.x, progress);
      y = hermite(transition.carry.start.y, target.y, zeroRational, tangent.y, progress);
    } else {
      x = hermite(target.x, transition.carry.end.x, tangent.x, zeroRational, progress);
      y = hermite(target.y, transition.carry.end.y, tangent.y, zeroRational, progress);
    }
  } else if (side === "outgoing") {
    x = lerp(native.x, target.x, easedProgress); y = lerp(native.y, target.y, easedProgress);
  } else {
    x = lerp(target.x, native.x, easedProgress); y = lerp(target.y, native.y, easedProgress);
  }
  const scale = side === "outgoing" ? lerp(native.scale, target.scale, easedProgress) : lerp(target.scale, native.scale, easedProgress);
  const rotation = side === "outgoing" ? lerp(native.rotation, target.rotation, easedProgress) : lerp(target.rotation, native.rotation, easedProgress);
  const appliedPose = Object.freeze({ x, y, scale, rotation, opacity: rational(1) });
  const numbers = poseNumbers(appliedPose), origin = referenceLocalSpaceRasterOrigin(subject.localSpace);
  if (!Number.isFinite(numbers.x) || !Number.isFinite(numbers.y) || !Number.isFinite(numbers.scale) || !Number.isFinite(numbers.rotation)
    || numbers.scale <= 0 || numbers.scale > referenceSemanticMatchLimits.maximumTargetScale) {
    fail(transition.record, transition.carry ? "CUT_MATCH_VELOCITY" : "CUT_MATCH_TRANSFORM", `${side} sampled pose is non-finite or outside the admitted scale range.`);
  }
  const transformWork = planReferenceLocalSpaceTileTransformWork(subject.camera, {
    source: { width: subject.localSpace.width, height: subject.localSpace.height },
    destination: { width: composition.width, height: composition.height },
    scale: numbers.scale,
    rotation: numbers.rotation,
    opacity: 1,
  });
  const contextIdentity = hash({
    algorithmVersion: referenceSemanticMatchAlgorithmVersion,
    planIdentity: transition.planIdentity,
    side,
    exactTime,
    appliedPose,
    transformWorkIdentity: transformWork.workIdentity,
  });
  const placement: ReferenceLocalSpacePlacement = Object.freeze({
    owner: "camera-2d",
    contextIdentity,
    destinationX: composition.width / 2 + numbers.x,
    destinationY: composition.height / 2 + numbers.y,
    registrationRasterX: origin.x,
    registrationRasterY: origin.y,
    scale: numbers.scale,
    skewX: 0,
    skewY: 0,
    rotation: numbers.rotation,
    opacity: 1,
  });
  const tintAmount = side === "outgoing" ? easedProgress : oneMinus(easedProgress);
  const execution = {
    algorithmVersion: referenceSemanticMatchAlgorithmVersion,
    transitionId: transition.record.id,
    subjectId: subject.record.id,
    side,
    exactTime,
    sceneLocalTime,
    progress,
    easedProgress,
    tintAmount,
    nativePose: native,
    appliedPose,
    placement,
    transformWorkIdentity: transformWork.workIdentity,
    planIdentity: transition.planIdentity,
  };
  return Object.freeze({
    ...execution,
    authoredTransitionId: transition.record.authoredId,
    authoredSubjectId: subject.record.authoredId,
    cameraNodeId: subject.camera.id,
    localSpaceNodeId: subject.localSpace.nodeId,
    window,
    transformWork,
    ...(target.color ? { targetColor: target.color } : {}),
    ...(transition.carry ? { carryVelocity: transition.carry.velocityPerSecond } : {}),
    declaration: Object.freeze({ id: transition.record.id, provenance: transition.record.provenance }),
    executionIdentity: hash(execution),
  });
}

function validateStaticCarry(
  ir: CutAVIR,
  transition: PreparedTransition,
  samples: readonly ReferenceSemanticMatchSample[],
  resolver?: ReferencePreparedSignalResolver,
) {
  if (!transition.carry) return;
  const outgoing = samples.filter((sample) => sample.side === "outgoing"), incoming = samples.filter((sample) => sample.side === "incoming");
  const check = (sideSamples: readonly ReferenceSemanticMatchSample[], subject: PreparedSubject, endpoint: Rational) => {
    const poses = [...sideSamples.map((sample) => sample.nativePose), nativePose(ir, subject.camera, sourceAt(subject.scene, endpoint), resolver)];
    const first = poses[0];
    if (!first || poses.some((pose) => !same(pose.x, first.x) || !same(pose.y, first.y))) {
      fail(transition.record, "CUT_MATCH_VELOCITY", `${subject.record.authoredId} uses x/y automation inside a carry window; V1 carry requires static authored translation.`);
    }
  };
  check(outgoing, transition.outgoing, intervalEnd(transition.record.outgoingWindow));
  check(incoming, transition.incoming, intervalEnd(transition.record.incomingWindow));
}

/** Prepared semantic-match execution. It is absent for legacy IR so merely
 * constructing the renderer cannot perturb pre-extension identities. */
export class ReferencePreparedSemanticMatches {
  readonly transitions: readonly PreparedTransition[];
  private readonly sidesByCamera = new Map<string, readonly PreparedSide[]>();

  constructor(
    readonly ir: CutAVIR,
    readonly composition: IRComposition,
    transitions: readonly PreparedTransition[],
    readonly resolver?: ReferencePreparedSignalResolver,
  ) {
    this.transitions = Object.freeze([...transitions]);
    const mutable = new Map<string, PreparedSide[]>();
    for (const transition of transitions) for (const side of [sideFor(transition, "outgoing"), sideFor(transition, "incoming")]) {
      const entries = mutable.get(side.subject.camera.id) ?? [];
      entries.push(side); mutable.set(side.subject.camera.id, entries);
    }
    for (const [camera, entries] of mutable) this.sidesByCamera.set(camera, Object.freeze(entries.sort((left, right) => compareRational(left.window.start, right.window.start))));
  }

  sampleAt(cameraNodeId: string, exactTime: Rational, sceneLocalTime: Rational) {
    const entries = (this.sidesByCamera.get(cameraNodeId) ?? []).filter((side) => compareRational(exactTime, side.window.start) >= 0 && compareRational(exactTime, intervalEnd(side.window)) < 0);
    if (entries.length > 1) fail(entries[0]!.transition.record, "CUT_MATCH_CONFLICT", `Camera2D ${cameraNodeId} has ${entries.length} active semantic matches at one frame.`);
    return entries[0] ? semanticMatchSample(this.ir, this.composition, entries[0], exactTime, sceneLocalTime, this.resolver) : undefined;
  }

  inspect() {
    return Object.freeze(this.transitions.map((prepared) => Object.freeze({
      algorithmVersion: referenceSemanticMatchAlgorithmVersion,
      id: prepared.record.id,
      authoredId: prepared.record.authoredId,
      compositionId: prepared.record.compositionId,
      cut: prepared.record.cut,
      duration: prepared.record.duration,
      frameCount: prepared.frameCount,
      outgoingWindow: prepared.record.outgoingWindow,
      incomingWindow: prepared.record.incomingWindow,
      outgoing: prepared.record.outgoing,
      incoming: prepared.record.incoming,
      basis: prepared.outgoing.record.basis,
      target: prepared.record.target,
      easing: prepared.record.easing,
      ...(prepared.record.velocity ? { velocity: prepared.record.velocity } : {}),
      ...(prepared.carry ? { carryVelocity: prepared.carry.velocityPerSecond } : {}),
      cacheDependencies: Object.freeze({
        bothSides: Object.freeze(["target", "timing", "easing", "color", ...(prepared.carry ? ["outgoing-position-endpoint", "incoming-position-endpoint"] : [])]),
        sideLocal: Object.freeze(["subject-local-content", "subject-native-pose"]),
        audio: "unaffected",
      }),
      limits: referenceSemanticMatchLimits,
      planIdentity: prepared.planIdentity,
    })));
  }
}

function prepareReferenceSemanticMatchesForComposition(
  ir: CutAVIR,
  composition: IRComposition,
  matches: NonNullable<CutAVIR["semanticMatches"]>,
  localSpaces: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
  resolver?: ReferencePreparedSignalResolver,
) {
  const subjectRecords = matches.subjects.filter((subject) => subject.compositionId === composition.id);
  const transitionRecords = matches.transitions.filter((transition) => transition.compositionId === composition.id);
  if (subjectRecords.length > referenceSemanticMatchLimits.maximumSubjectsPerComposition) {
    fail(subjectRecords[referenceSemanticMatchLimits.maximumSubjectsPerComposition]!, "CUT_MATCH_LIMIT", `composition exceeds ${referenceSemanticMatchLimits.maximumSubjectsPerComposition} subjects.`);
  }
  if (transitionRecords.length > referenceSemanticMatchLimits.maximumTransitionsPerComposition) {
    fail(transitionRecords[referenceSemanticMatchLimits.maximumTransitionsPerComposition]!, "CUT_MATCH_LIMIT", `composition exceeds ${referenceSemanticMatchLimits.maximumTransitionsPerComposition} transitions.`);
  }
  const subjects = new Map<string, PreparedSubject>(), authoredSubjects = new Set<string>();
  for (const record of subjectRecords) {
    if (subjects.has(record.id) || authoredSubjects.has(record.authoredId)) fail(record, "CUT_MATCH_ID", `duplicate subject identity ${JSON.stringify(record.authoredId)}.`);
    subjects.set(record.id, validateSubject(ir, composition, record, localSpaces)); authoredSubjects.add(record.authoredId);
  }
  const transitions: PreparedTransition[] = [], ids = new Set<string>(), authored = new Set<string>(), pairsByCut = new Map<string, number>();
  for (const record of transitionRecords) {
    if (ids.has(record.id) || authored.has(record.authoredId)) fail(record, "CUT_MATCH_ID", `duplicate transition identity ${JSON.stringify(record.authoredId)}.`);
    ids.add(record.id); authored.add(record.authoredId);
    const cutKey = `${record.cut.numerator}/${record.cut.denominator}`, pairs = (pairsByCut.get(cutKey) ?? 0) + 1;
    if (pairs > referenceSemanticMatchLimits.maximumPairsAtCut) fail(record, "CUT_MATCH_LIMIT", `cut exceeds ${referenceSemanticMatchLimits.maximumPairsAtCut} semantic-match pairs.`);
    pairsByCut.set(cutKey, pairs);
    transitions.push(makePreparedTransition(ir, composition, record, subjects, resolver));
  }
  for (const subject of subjects.values()) {
    const uses = transitions.flatMap((transition) => [
      ...(transition.outgoing.record.id === subject.record.id ? [{ transition, window: transition.record.outgoingWindow }] : []),
      ...(transition.incoming.record.id === subject.record.id ? [{ transition, window: transition.record.incomingWindow }] : []),
    ]).sort((left, right) => compareRational(left.window.start, right.window.start));
    for (let index = 1; index < uses.length; index += 1) if (overlaps(uses[index - 1]!.window, uses[index]!.window)) {
      fail(uses[index]!.transition.record, "CUT_MATCH_CONFLICT", `subject ${JSON.stringify(subject.record.authoredId)} is reused by overlapping half-windows.`);
    }
  }
  const prepared = new ReferencePreparedSemanticMatches(ir, composition, transitions, resolver);
  for (const transition of transitions) {
    const samples: ReferenceSemanticMatchSample[] = [];
    const halfFrames = transition.frameCount / 2;
    for (const side of ["outgoing", "incoming"] as const) {
      const window = side === "outgoing" ? transition.record.outgoingWindow : transition.record.incomingWindow;
      const subject = side === "outgoing" ? transition.outgoing : transition.incoming;
      for (let frame = 0; frame < halfFrames; frame += 1) {
        const absolute = addRational(window.start, divideRational(rational(frame), composition.fps));
        const sample = prepared.sampleAt(subject.camera.id, absolute, sourceAt(subject.scene, absolute));
        if (!sample) fail(transition.record, "CUT_MATCH_RENDER", `${side} preflight frame ${frame} did not resolve its prepared match.`);
        samples.push(sample);
      }
    }
    validateStaticCarry(ir, transition, samples, resolver);
    if (!transition.record.target.color && !samples.some((sample) => !poseEqual(sample.nativePose, sample.appliedPose))) {
      fail(transition.record, "CUT_MATCH_NOOP", "does not change any executed transform channel and has no color operation.");
    }
  }
  return prepared;
}

export function prepareReferenceSemanticMatches(
  ir: CutAVIR,
  composition: IRComposition,
  localSpaces: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
  resolver?: ReferencePreparedSignalResolver,
) {
  const matches = ir.semanticMatches;
  if (!matches) return undefined;
  const declaration = matches.subjects[0] ?? matches.transitions[0] ?? { id: "semanticMatches", provenance: composition.provenance };
  if (matches.version !== 1 || !matches.subjects.length || !matches.transitions.length) {
    fail(declaration, "CUT_MATCH_CONTRACT", "semanticMatches must be version 1 with at least one subject and transition, or be omitted.");
  }
  validateSemanticMatchRecordUniverse(ir, matches);

  const canonicalSelected = ir.compositions.find((candidate) => candidate.id === composition.id);
  if (!canonicalSelected) fail(declaration, "CUT_MATCH_SCOPE", `selected composition ${JSON.stringify(composition.id)} is missing from CutAVIR.`);
  let selected: ReferencePreparedSemanticMatches | undefined;
  const compositionIds = new Set(matches.transitions.map((transition) => transition.compositionId));
  for (const compositionId of compositionIds) {
    const canonical = ir.compositions.find((candidate) => candidate.id === compositionId);
    // validateSemanticMatchRecordUniverse has already source-located this case.
    if (!canonical) fail(declaration, "CUT_MATCH_SCOPE", `semantic-match composition ${JSON.stringify(compositionId)} is missing from CutAVIR.`);
    const spaces = compositionId === canonicalSelected.id
      ? localSpaces
      : validateReferenceLocalSpaceGraph(
        ir,
        canonical,
        new Set(matches.subjects.filter((subject) => subject.compositionId === compositionId).map((subject) => subject.localSpaceNodeId)),
      );
    const prepared = prepareReferenceSemanticMatchesForComposition(ir, canonical, matches, spaces, resolver);
    if (compositionId === canonicalSelected.id) selected = prepared;
  }
  return selected;
}

const srgbToLinear = Float64Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});

function linearToSrgb(value: number) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded <= 0.0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - 0.055;
}

function byte(value: number) { return Math.max(0, Math.min(255, Math.floor(value * 255 + 0.5))); }

function colorBytes(color: string) {
  return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16)] as const;
}

/** Apply optional convergence inside the retained LocalSpace, before its
 * matched placement. Amount zero is an exact byte-preserving bypass. */
export function applyReferenceSemanticMatchColor(surface: RgbaSurface, sample: ReferenceSemanticMatchSample) {
  if (!sample.targetColor || exactZero(sample.tintAmount)) return Object.freeze({ surface, tintedPixels: 0, rgbaSha256: createHash("sha256").update(surface.data).digest("hex") });
  const pixels = surface.width * surface.height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceSemanticMatchLimits.maximumTintedLocalPixelsPerFrame || surface.data.byteLength !== pixels * 4) {
    fail(sample.declaration, "CUT_MATCH_RENDER", "semantic color input violates the admitted straight RGBA8 surface bounds.");
  }
  const amount = rationalToNumber(sample.tintAmount), target = colorBytes(sample.targetColor).map((value) => srgbToLinear[value]!) as [number, number, number];
  const targetLuma = Math.max(1e-12, target[0] * 0.2126 + target[1] * 0.7152 + target[2] * 0.0722);
  const output = Buffer.from(surface.data);
  for (let offset = 0; offset < output.length; offset += 4) {
    const alpha = output[offset + 3]!;
    if (alpha === 0) { output[offset] = 0; output[offset + 1] = 0; output[offset + 2] = 0; continue; }
    const native = [srgbToLinear[output[offset]!]!, srgbToLinear[output[offset + 1]!]!, srgbToLinear[output[offset + 2]!]!];
    const luma = native[0]! * 0.2126 + native[1]! * 0.7152 + native[2]! * 0.0722;
    for (let channel = 0; channel < 3; channel += 1) {
      const tinted = Math.max(0, Math.min(1, target[channel]! * luma / targetLuma));
      output[offset + channel] = byte(linearToSrgb(native[channel]! * (1 - amount) + tinted * amount));
    }
  }
  const result = Object.freeze({ data: output, width: surface.width, height: surface.height });
  return Object.freeze({ surface: result, tintedPixels: pixels, rgbaSha256: createHash("sha256").update(output).digest("hex") });
}

export function referenceSemanticMatchFrameEvidence(input: Readonly<{
  compositionId: string;
  sample: ReferenceSemanticMatchSample;
  tile: RgbaSurface;
  tinted: RgbaSurface;
  placed: RgbaSurface;
  tintedPixels: number;
}>): ReferenceSemanticMatchFrameEvidence {
  const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const sample = input.sample;
  const receipt = Object.freeze({
    format: referenceSemanticMatchFrameEvidenceFormat,
    version: 1 as const,
    evidenceKind: "completed-frame-execution" as const,
    algorithmVersion: referenceSemanticMatchAlgorithmVersion,
    compositionId: input.compositionId,
    transitionId: sample.transitionId,
    authoredTransitionId: sample.authoredTransitionId,
    subjectId: sample.subjectId,
    authoredSubjectId: sample.authoredSubjectId,
    cameraNodeId: sample.cameraNodeId,
    localSpaceNodeId: sample.localSpaceNodeId,
    side: sample.side,
    exactTime: sample.exactTime,
    sceneLocalTime: sample.sceneLocalTime,
    window: sample.window,
    progress: sample.progress,
    easedProgress: sample.easedProgress,
    tintAmount: sample.tintAmount,
    nativePose: sample.nativePose,
    appliedPose: sample.appliedPose,
    ...(sample.carryVelocity ? { carryVelocity: sample.carryVelocity } : {}),
    ...(sample.targetColor ? { color: Object.freeze({ target: sample.targetColor, algorithm: "linear-srgb-luminance-preserving-chroma-v1" as const }) } : {}),
    surfaces: Object.freeze({
      tileRgbaSha256: sha(input.tile.data),
      tintedTileRgbaSha256: sha(input.tinted.data),
      placedRgbaSha256: sha(input.placed.data),
      width: input.tile.width,
      height: input.tile.height,
    }),
    work: Object.freeze({
      tintedPixels: input.tintedPixels,
      transformWorkIdentity: sample.transformWork.workIdentity,
      placementContextIdentity: sample.placement.contextIdentity,
    }),
    planIdentity: sample.planIdentity,
  });
  return Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
}

export function referenceSemanticMatchInspect(
  ir: CutAVIR,
  composition: IRComposition,
  localSpaces: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
) {
  const prepared = prepareReferenceSemanticMatches(ir, composition, localSpaces);
  return prepared?.inspect() ?? Object.freeze([]);
}
