import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import {
  referencePictureTransitionDirections,
  referencePictureTransitionKinds,
  type ReferencePictureTransition,
  type ReferencePictureTransitionDirection,
  type ReferencePictureTransitionKind,
  type ReferenceTransitionColor,
} from "./transition";

export const referenceTransitionDiagnosticCode = "CUT_TRANSITION_CONTRACT" as const;

export class ReferenceTransitionContractError extends Error {
  readonly code = referenceTransitionDiagnosticCode;
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${referenceTransitionDiagnosticCode}: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceTransitionContractError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

function fail(node: IRNode, message: string): never { throw new ReferenceTransitionContractError(node, message); }

function time(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "quantity" || value.dimension !== "time") fail(node, `${label} must be an exact Time quantity`);
  return value.magnitude;
}

function string(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "string") fail(node, `${label} must be a String literal`);
  return value.value;
}

function ratio(node: IRNode, value: IRValue | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== "ratio") fail(node, `${label} must be a Ratio quantity`);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < 0 || result > 1) fail(node, `${label} must be in [0%, 100%]`);
  return result;
}

function transitionColor(node: IRNode, value: IRValue | undefined): ReferenceTransitionColor {
  if (value === undefined) return [0, 0, 0, 1];
  if (value.kind !== "color" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value.value)) {
    fail(node, "color must be a six- or eight-digit hexadecimal Color");
  }
  const red = Number.parseInt(value.value.slice(1, 3), 16) / 255;
  const green = Number.parseInt(value.value.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(value.value.slice(5, 7), 16) / 255;
  const alpha = value.value.length === 9 ? Number.parseInt(value.value.slice(7, 9), 16) / 255 : 1;
  return [red, green, blue, alpha];
}

function exactGrid(node: IRNode, composition: IRComposition, value: Rational, label: string) {
  if (multiplyRational(value, composition.fps).denominator !== "1") {
    fail(node, `${label} does not land on the ${composition.fps.numerator}/${composition.fps.denominator} fps frame grid`);
  }
  if (multiplyRational(value, rational(composition.sampleRate)).denominator !== "1") {
    fail(node, `${label} does not land on the ${composition.sampleRate} Hz sample grid`);
  }
}

function intervalEnd(node: IRNode) { return addRational(node.interval.start, node.interval.duration); }

export type ReferenceTransitionContract = Readonly<{
  picture: ReferencePictureTransition;
  outgoingNodeId: string;
  incomingNodeId: string;
  overlapStart: Rational;
  overlapDuration: Rational;
  overlapEnd: Rational;
  parentStart: Rational;
  parentDuration: Rational;
}>;

export function referenceDirectNodeParents(ir: CutAVIR) {
  const parents = new Map<string, string[]>();
  for (const parent of Object.values(ir.nodes)) {
    for (const childId of parent.children) {
      const values = parents.get(childId) ?? [];
      values.push(parent.id); parents.set(childId, values);
    }
  }
  return parents as ReadonlyMap<string, readonly string[]>;
}

/**
 * Validate the generic two-clip overlap model consumed by picture and audio.
 * The first clip must start first, the second must end last, and the exact
 * overlap is the half-open interval [incoming.start, outgoing.end).
 */
export function referenceTransitionContract(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  directParents?: ReadonlyMap<string, readonly string[]>,
): ReferenceTransitionContract {
  if (node.op !== "cut.edit.transition" || node.domain !== "av") fail(node, "transition node must use the cut.edit.transition AV kernel");
  if (node.children.length !== 2) fail(node, "Transition requires exactly two source-ordered Clip children");
  const outgoing = ir.nodes[node.children[0]], incoming = ir.nodes[node.children[1]];
  if (!outgoing || !incoming) fail(node, "Transition references a missing child");
  if (outgoing.op !== "cut.edit.clip" || incoming.op !== "cut.edit.clip" || outgoing.domain !== "av" || incoming.domain !== "av") {
    fail(node, "Transition children must be direct linked Clip nodes");
  }
  if (outgoing.sceneId !== node.sceneId || incoming.sceneId !== node.sceneId) fail(node, "Transition and both Clip children must share one scene or timeline scope");
  if (outgoing.ownership !== "child" || incoming.ownership !== "child") fail(node, "Transition Clip ownership must remain child-only");
  const parentsByChild = directParents ?? referenceDirectNodeParents(ir);
  for (const child of [outgoing, incoming]) {
    const parents = parentsByChild.get(child.id) ?? [];
    if (parents.length !== 1 || parents[0] !== node.id) fail(node, `Clip child ${child.id} must have this Transition as its one direct parent`);
  }

  const outgoingEnd = intervalEnd(outgoing), incomingEnd = intervalEnd(incoming);
  if (compareRational(outgoing.interval.start, incoming.interval.start) >= 0) fail(node, "outgoing Clip must start before incoming Clip");
  if (compareRational(outgoingEnd, incoming.interval.start) <= 0) fail(node, "Clip intervals must overlap; a hard cut or gap is not a Transition");
  if (compareRational(incomingEnd, outgoingEnd) <= 0) fail(node, "incoming Clip must end after outgoing Clip");
  const overlapDuration = subtractRational(outgoingEnd, incoming.interval.start);
  const authoredDuration = time(node, node.inputs.duration, "duration");
  if (compareRational(authoredDuration, zeroRational) <= 0) fail(node, "duration must be positive");
  if (compareRational(authoredDuration, overlapDuration) !== 0) fail(node, "duration must exactly equal the two Clip intervals' overlap");

  const parentDuration = subtractRational(incomingEnd, outgoing.interval.start);
  if (compareRational(node.interval.start, outgoing.interval.start) !== 0 || compareRational(node.interval.duration, parentDuration) !== 0) {
    fail(node, "parent interval must exactly equal the ordered union of both Clip intervals");
  }
  exactGrid(node, composition, node.interval.start, "parent start");
  exactGrid(node, composition, node.interval.duration, "parent duration");
  exactGrid(node, composition, incoming.interval.start, "overlap start");
  exactGrid(node, composition, overlapDuration, "overlap duration");
  const overlapFrames = multiplyRational(overlapDuration, composition.fps);
  if (overlapFrames.denominator !== "1" || BigInt(overlapFrames.numerator) < 2n) {
    fail(node, "duration must span at least two picture frames so the authored transition has a visible in-overlap sample");
  }

  const kind = string(node, node.inputs.kind, "kind") as ReferencePictureTransitionKind;
  if (!referencePictureTransitionKinds.includes(kind)) fail(node, `kind must be one of: ${referencePictureTransitionKinds.join(", ")}`);
  const direction = (node.inputs.direction === undefined ? "left" : string(node, node.inputs.direction, "direction")) as ReferencePictureTransitionDirection;
  if (!referencePictureTransitionDirections.includes(direction)) fail(node, `direction must be one of: ${referencePictureTransitionDirections.join(", ")}`);
  const softness = ratio(node, node.inputs.softness, 0, "softness");
  if (kind !== "wipe" && node.inputs.softness !== undefined) fail(node, "softness is valid only for a wipe transition");
  if (kind !== "dip" && node.inputs.color !== undefined) fail(node, "color is valid only for a dip transition");
  if ((kind === "cross-dissolve" || kind === "dip") && node.inputs.direction !== undefined) fail(node, `direction is not meaningful for ${kind}`);
  if (outgoing.inputs.fadeOut !== undefined || incoming.inputs.fadeIn !== undefined) {
    fail(node, "Transition owns the overlap envelope; outgoing fadeOut and incoming fadeIn would double-apply it");
  }

  return {
    picture: { kind, direction, softness, dipColor: transitionColor(node, node.inputs.color) },
    outgoingNodeId: outgoing.id,
    incomingNodeId: incoming.id,
    overlapStart: incoming.interval.start,
    overlapDuration,
    overlapEnd: outgoingEnd,
    parentStart: node.interval.start,
    parentDuration,
  };
}

export function referenceTransitionProgress(contract: ReferenceTransitionContract, time: Rational) {
  if (compareRational(time, contract.overlapStart) <= 0) return 0;
  if (compareRational(time, contract.overlapEnd) >= 0) return 1;
  return rationalToNumber(subtractRational(time, contract.overlapStart)) / rationalToNumber(contract.overlapDuration);
}
