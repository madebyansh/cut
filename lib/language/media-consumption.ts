import type { IRNode, IRResource } from "./ir";

export type CutConsumedMediaKind = "video" | "audio";

/** Canonical selected-stream kinds consumed by one direct media node. */
export function directNodeConsumedMediaKinds(
  node: IRNode,
  resourceKind: IRResource["kind"],
): readonly CutConsumedMediaKind[] {
  if (node.op === "cut.data.waveform" || node.op === "cut.data.spectrogram") return ["audio"];
  if (node.domain === "av" || node.op === "cut.edit.clip") return ["video", "audio"];
  if (node.domain === "audio") return ["audio"];
  if (resourceKind === "video") return ["video"];
  if (resourceKind === "audio") return ["audio"];
  return [];
}
