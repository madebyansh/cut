import type { BuildArtifact, MediaIndex, MediaMoment, TimelineClip } from "../types";
import { compileCut } from "../compiler";
import { hash } from "./stable";
import { verifyTimeline } from "./verifier";

export function catalogFromIndex(index: MediaIndex): MediaMoment[] {
  return index.assets.flatMap<MediaMoment>((asset): MediaMoment[] => asset.transcript?.length
    ? asset.transcript.map((segment, index) => ({
        id: `${asset.id}-${segment.id}`, source: asset.sourceName, start: segment.start, end: segment.end,
        transcript: segment.text, visual: `Transcript-aligned moment ${index + 1} in ${asset.sourceName}`, emotion: "reflective" as const,
        salience: Math.min(.99, .65 + Math.min(segment.text.length, 170) / 500), speaker: segment.speaker,
      }))
    : asset.scenes.map((scene, index) => ({
        id: `${asset.id}-${scene.id}`, source: asset.sourceName, start: scene.start, end: scene.end,
        transcript: "", visual: scene.visual ? [scene.visual.description, scene.visual.setting, scene.visual.composition, scene.visual.camera, scene.visual.motion, scene.visual.visibleText].filter(Boolean).join(" · ") : `Detected scene ${index + 1} in ${asset.sourceName}`,
        emotion: "energetic" as const,
        salience: scene.visual ? Math.min(.99, Math.max(.35, scene.visual.confidence * (scene.visual.usability === "hero" ? 1 : scene.visual.usability === "weak" ? .55 : .8))) : Math.max(.5, 1 - index * .02),
      })) as MediaMoment[]);
}

export function buildArtifact(source: string, index: MediaIndex, catalog: MediaMoment[] = catalogFromIndex(index), semanticPlan?: Array<{ momentId: string; role: TimelineClip["role"]; rationale: string; sourceLine: number }>): BuildArtifact {
  const result = compileCut(source, catalog, semanticPlan);
  if (!result.program || result.diagnostics.some((item) => item.level === "error")) throw new Error(result.diagnostics.map((item) => `line ${item.line}: ${item.message}`).join("\n"));
  const sourceHash = hash(source);
  const buildId = hash({ sourceHash, indexHash: index.indexHash, compiler: "cutc-0.2.0", clips: result.clips }).slice(0, 16);
  const verification = verifyTimeline(result.program, result.clips, catalog);
  return {
    format: "cut-ir", version: 2, buildId, sourceHash, indexHash: index.indexHash, compiler: "cutc-0.2.0",
    program: result.program, clips: result.clips, duration: result.duration, verification,
    provenance: result.clips.map((clip) => ({ clipId: clip.id, source: clip.source, sourceStart: clip.start, sourceEnd: clip.start + (clip.timelineEnd - clip.timelineStart), sourceLine: clip.sourceLine, rationale: clip.rationale })),
  };
}
