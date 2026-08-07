import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";

export type ReferenceMasteringTarget = {
  integratedLufs: number;
  truePeakDbtp: number;
  samplePeakDbfs: number;
  loudnessRangeLu: number;
};

export const defaultReferenceMasteringTarget: Readonly<ReferenceMasteringTarget> = Object.freeze({
  integratedLufs: -14,
  truePeakDbtp: -1,
  samplePeakDbfs: 0,
  loudnessRangeLu: 9,
});

function sourceLabel(node: IRNode) {
  const { module, span } = node.provenance;
  return `${module}:${span.start.line}:${span.start.column}`;
}

function quantityInput(node: IRNode, name: string, dimension: string, fallback: number) {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== dimension) {
    throw new Error(`Master Meter at ${sourceLabel(node)} requires ${name} to have dimension ${dimension}.`);
  }
  const number = rationalToNumber(value.magnitude);
  if (!Number.isFinite(number)) throw new Error(`Master Meter at ${sourceLabel(node)} has a non-finite ${name}.`);
  return number;
}

function targetAt(node: IRNode): ReferenceMasteringTarget {
  const target = {
    integratedLufs: quantityInput(node, "target", "loudness", defaultReferenceMasteringTarget.integratedLufs),
    truePeakDbtp: quantityInput(node, "truePeak", "true-peak", defaultReferenceMasteringTarget.truePeakDbtp),
    samplePeakDbfs: quantityInput(node, "samplePeak", "sample-peak", defaultReferenceMasteringTarget.samplePeakDbfs),
    loudnessRangeLu: quantityInput(node, "range", "scalar", defaultReferenceMasteringTarget.loudnessRangeLu),
  };
  if (target.integratedLufs < -70 || target.integratedLufs > -5) throw new Error(`Master Meter at ${sourceLabel(node)} target must be between -70 and -5 LUFS.`);
  if (target.truePeakDbtp < -9 || target.truePeakDbtp > 0) throw new Error(`Master Meter at ${sourceLabel(node)} truePeak must be between -9 and 0 dBTP.`);
  if (target.samplePeakDbfs < -24 || target.samplePeakDbfs > 0) throw new Error(`Master Meter at ${sourceLabel(node)} samplePeak must be between -24 and 0 dBFS.`);
  if (target.loudnessRangeLu < 1 || target.loudnessRangeLu > 50) throw new Error(`Master Meter at ${sourceLabel(node)} range must be between 1 and 50 LU.`);
  return target;
}

function nodeReferences(value: IRValue, references: Set<string>) {
  if (value.kind === "node-ref") references.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => nodeReferences(item, references));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => nodeReferences(item, references));
  else if (value.kind === "range") { nodeReferences(value.start, references); nodeReferences(value.end, references); }
  else if (value.kind === "unary") nodeReferences(value.value, references);
  else if (value.kind === "binary") { nodeReferences(value.left, references); nodeReferences(value.right, references); }
  else if (value.kind === "member") nodeReferences(value.object, references);
  else if (value.kind === "index") { nodeReferences(value.object, references); nodeReferences(value.index, references); }
  else if (value.kind === "call") {
    value.positional.forEach((item) => nodeReferences(item, references));
    Object.values(value.named).forEach((item) => nodeReferences(item, references));
  }
}

function masterRoots(ir: CutAVIR, composition: IRComposition) {
  const roots = [...composition.rootAudioIds, ...composition.rootAVIds];
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (!scene) throw new Error(`Timeline “${composition.name}” references missing scene ${sceneId}.`);
    roots.push(...scene.rootAudioIds, ...scene.rootAVIds);
  }
  return roots;
}

function reachableMasterMeters(ir: CutAVIR, composition: IRComposition) {
  const pending = masterRoots(ir, composition), visited = new Set<string>(), meters: IRNode[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) throw new Error(`Master audio graph references missing node ${id}.`);
    if (node.op === "cut.audio.meter") meters.push(node);
    pending.push(...node.children);
    const references = new Set<string>();
    Object.values(node.inputs).forEach((value) => nodeReferences(value, references));
    pending.push(...references);
  }
  return meters;
}

/** Source identity for final decoded-sample validation and JSON diagnostics. */
export function referenceMasteringPeakSource(ir: CutAVIR, composition: IRComposition) {
  const owner = reachableMasterMeters(ir, composition)[0];
  const provenance = owner?.provenance ?? composition.provenance;
  return Object.freeze({
    module: provenance.module,
    line: provenance.span.start.line,
    column: provenance.span.start.column,
    nodeId: owner?.id ?? composition.id,
  });
}

/**
 * Resolve the one release target authored by Meter nodes reachable from the
 * composition's rendered audio roots. Unreachable/detached meters cannot alter
 * an export. Multiple reachable meters are permitted only when their complete
 * targets (including defaults) agree exactly.
 */
export function deriveReferenceMasteringTarget(ir: CutAVIR, composition: IRComposition): ReferenceMasteringTarget {
  const meters = reachableMasterMeters(ir, composition).map((node) => ({ node, target: targetAt(node) }));
  if (!meters.length) return { ...defaultReferenceMasteringTarget };
  const selected = meters[0];
  for (const meter of meters.slice(1)) {
    if (meter.target.integratedLufs !== selected.target.integratedLufs || meter.target.truePeakDbtp !== selected.target.truePeakDbtp || meter.target.samplePeakDbfs !== selected.target.samplePeakDbfs || meter.target.loudnessRangeLu !== selected.target.loudnessRangeLu) {
      throw new Error(`Conflicting master Meter targets at ${sourceLabel(selected.node)} and ${sourceLabel(meter.node)}; a composition must resolve to one release target.`);
    }
  }
  return { ...selected.target };
}
