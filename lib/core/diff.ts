import type { BuildArtifact, TimelineClip } from "../types";

export type TimelineChange = { kind: "add" | "remove" | "move" | "replace"; message: string };

const signature = (clip: TimelineClip) => `${clip.source}:${clip.start.toFixed(3)}:${clip.end.toFixed(3)}:${clip.role}`;

export function diffBuilds(before: BuildArtifact, after: BuildArtifact): TimelineChange[] {
  const changes: TimelineChange[] = [];
  const oldBySignature = new Map(before.clips.map((clip) => [signature(clip), clip]));
  const newBySignature = new Map(after.clips.map((clip) => [signature(clip), clip]));
  for (const clip of before.clips) {
    const next = newBySignature.get(signature(clip));
    if (!next) changes.push({ kind: "remove", message: `${clip.role} ${clip.source} ${clip.start.toFixed(2)}–${clip.end.toFixed(2)}s` });
    else if (Math.abs(next.timelineStart - clip.timelineStart) > .001) changes.push({ kind: "move", message: `${clip.role} moved ${clip.timelineStart.toFixed(2)}s → ${next.timelineStart.toFixed(2)}s` });
  }
  for (const clip of after.clips) if (!oldBySignature.has(signature(clip))) changes.push({ kind: "add", message: `${clip.role} ${clip.source} ${clip.start.toFixed(2)}–${clip.end.toFixed(2)}s` });
  return changes;
}
