import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import { referenceDirectNodeParents } from "./transition-config";

export const referenceLinkedSplitDiagnosticCode = "CUT_LINKED_SPLIT_CONTRACT" as const;

export type ReferenceLinkedSplitKind = "jcut" | "lcut";

export class ReferenceLinkedSplitContractError extends Error {
  readonly code = referenceLinkedSplitDiagnosticCode;
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${referenceLinkedSplitDiagnosticCode}: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceLinkedSplitContractError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

function fail(node: IRNode, message: string): never {
  throw new ReferenceLinkedSplitContractError(node, message);
}

function exactTime(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "quantity" || value.dimension !== "time") fail(node, `${label} must be an exact Time quantity`);
  return value.magnitude;
}

function exactGrid(node: IRNode, composition: IRComposition, value: Rational, label: string) {
  if (multiplyRational(value, composition.fps).denominator !== "1") {
    fail(node, `${label} does not land on the ${composition.fps.numerator}/${composition.fps.denominator} fps frame grid`);
  }
  if (multiplyRational(value, rational(composition.sampleRate)).denominator !== "1") {
    fail(node, `${label} does not land on the ${composition.sampleRate} Hz sample grid`);
  }
}

function intervalEnd(node: IRNode) {
  return addRational(node.interval.start, node.interval.duration);
}

export type ReferenceLinkedSplitContract = Readonly<{
  kind: ReferenceLinkedSplitKind;
  outgoingNodeId: string;
  incomingNodeId: string;
  overlapStart: Rational;
  overlapDuration: Rational;
  overlapEnd: Rational;
  pictureCut: Rational;
  audioCut: Rational;
  parentStart: Rational;
  parentDuration: Rational;
}>;

/**
 * Validate CUT's bounded atomic linked-A/V split edit.
 *
 * Both source-ordered Clip children retain their exact linked source clocks and
 * overlap in destination time. During that interval the wrapper crosses their
 * linked channels: JCut selects outgoing picture with incoming audio, while
 * LCut selects incoming picture with outgoing audio. No overlap mix, envelope,
 * source retime, frame hold, or hidden edit is inferred.
 */
export function referenceLinkedSplitContract(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  directParents?: ReadonlyMap<string, readonly string[]>,
): ReferenceLinkedSplitContract {
  const kind: ReferenceLinkedSplitKind = node.op === "cut.edit.jcut"
    ? "jcut"
    : node.op === "cut.edit.lcut"
      ? "lcut"
      : fail(node, "linked split node must use the cut.edit.jcut or cut.edit.lcut AV kernel");
  if (node.domain !== "av") fail(node, "linked split node must have the av domain");
  if (node.children.length !== 2) fail(node, `${kind === "jcut" ? "JCut" : "LCut"} requires exactly two source-ordered Clip children`);

  const outgoing = ir.nodes[node.children[0]], incoming = ir.nodes[node.children[1]];
  if (!outgoing || !incoming) fail(node, "linked split references a missing child");
  if (outgoing.op !== "cut.edit.clip" || incoming.op !== "cut.edit.clip" || outgoing.domain !== "av" || incoming.domain !== "av") {
    fail(node, "linked split children must be direct linked Clip nodes");
  }
  if (outgoing.sceneId !== node.sceneId || incoming.sceneId !== node.sceneId) {
    fail(node, "linked split and both Clip children must share one scene or timeline scope");
  }
  if (outgoing.ownership !== "child" || incoming.ownership !== "child") {
    fail(node, "linked split Clip ownership must remain child-only");
  }
  const parentsByChild = directParents ?? referenceDirectNodeParents(ir);
  for (const child of [outgoing, incoming]) {
    const parents = parentsByChild.get(child.id) ?? [];
    if (parents.length !== 1 || parents[0] !== node.id) {
      fail(node, "each linked split Clip child must have this edit as its one direct parent");
    }
  }

  const outgoingEnd = intervalEnd(outgoing), incomingEnd = intervalEnd(incoming);
  if (compareRational(outgoing.interval.start, incoming.interval.start) >= 0) {
    fail(node, "outgoing Clip must start before incoming Clip");
  }
  if (compareRational(outgoingEnd, incoming.interval.start) <= 0) {
    fail(node, "Clip intervals must have a positive overlap");
  }
  if (compareRational(incomingEnd, outgoingEnd) <= 0) {
    fail(node, "incoming Clip must end after outgoing Clip");
  }

  const overlapStart = incoming.interval.start;
  const overlapEnd = outgoingEnd;
  const overlapDuration = subtractRational(overlapEnd, overlapStart);
  const authoredOverlap = exactTime(node, node.inputs.overlap, "overlap");
  if (compareRational(authoredOverlap, zeroRational) <= 0) fail(node, "overlap must be positive");
  if (compareRational(authoredOverlap, overlapDuration) !== 0) {
    fail(node, "overlap must exactly equal the two Clip intervals' overlap");
  }

  const parentStart = outgoing.interval.start;
  const parentDuration = subtractRational(incomingEnd, parentStart);
  if (compareRational(node.interval.start, parentStart) !== 0 || compareRational(node.interval.duration, parentDuration) !== 0) {
    fail(node, "parent interval must exactly equal the ordered union of both Clip intervals");
  }
  const sceneStart = node.sceneId ? ir.scenes[node.sceneId]?.start : undefined;
  if (node.sceneId && !sceneStart) fail(node, "linked split belongs to a missing scene");
  exactGrid(node, composition, addRational(sceneStart ?? zeroRational, parentStart), "parent placement");
  exactGrid(node, composition, parentDuration, "parent duration");
  exactGrid(node, composition, addRational(sceneStart ?? zeroRational, overlapStart), "overlap placement");
  exactGrid(node, composition, overlapDuration, "overlap duration");

  return {
    kind,
    outgoingNodeId: outgoing.id,
    incomingNodeId: incoming.id,
    overlapStart,
    overlapDuration,
    overlapEnd,
    pictureCut: kind === "jcut" ? overlapEnd : overlapStart,
    audioCut: kind === "jcut" ? overlapStart : overlapEnd,
    parentStart,
    parentDuration,
  };
}
