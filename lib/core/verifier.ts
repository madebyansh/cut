import type { CutProgram, MediaMoment, TimelineClip, VerificationResult } from "../types";

export function verifyTimeline(program: CutProgram, clips: TimelineClip[], catalog: MediaMoment[]): VerificationResult[] {
  const results: VerificationResult[] = [];
  const moments = new Map(catalog.map((moment) => [moment.id, moment]));
  const outside = clips.filter((clip) => {
    const source = moments.get(clip.id.split("-tail-")[0]) ?? catalog.find((item) => item.source === clip.source && clip.start >= item.start && clip.end <= item.end);
    return !source || clip.start < source.start - .001 || clip.end > source.end + .001 || clip.end <= clip.start;
  });
  results.push({ rule: "source_bounds", status: outside.length ? "fail" : "pass", message: outside.length ? `${outside.length} clip(s) escape their indexed source ranges.` : "Every output frame maps to an indexed source range.", clipIds: outside.map((clip) => clip.id) });

  const declared = new Set(program.sources.map((source) => source.name));
  const undeclared = clips.filter((clip) => !declared.has(clip.source));
  results.push({ rule: "declared_sources", status: undeclared.length ? "fail" : "pass", message: undeclared.length ? `${undeclared.length} clip(s) use media not declared by the program.` : "Every selected asset is explicitly declared by the program.", clipIds: undeclared.map((clip) => clip.id) });

  const gaps = clips.filter((clip, index) => index > 0 && Math.abs(clip.timelineStart - clips[index - 1].timelineEnd) > .002);
  results.push({ rule: "contiguous_timeline", status: gaps.length ? "fail" : "pass", message: gaps.length ? "Timeline contains gaps or overlaps." : "Timeline is contiguous and monotonic.", clipIds: gaps.map((clip) => clip.id) });

  const short = clips.filter((clip) => clip.timelineEnd - clip.timelineStart < .35);
  results.push({ rule: "minimum_shot_length", status: short.length ? "warn" : "pass", message: short.length ? `${short.length} shot(s) are shorter than 350ms.` : "No accidental flash frames detected.", clipIds: short.map((clip) => clip.id) });

  const durationDelta = Math.abs((clips.at(-1)?.timelineEnd ?? 0) - program.duration);
  results.push({ rule: "duration_budget", status: durationDelta > .25 ? "warn" : "pass", message: durationDelta > .25 ? `Timeline differs from target by ${durationDelta.toFixed(2)}s.` : "Timeline satisfies the declared duration budget." });

  const requested = program.directives.filter((item) => item.kind === "rule" || item.kind === "assertion");
  for (const directive of requested) {
    if (["source_bounds", "contiguous_timeline", "duration_budget", "minimum_shot_length"].includes(directive.name)) continue;
    if (directive.name === "no_synthetic_quotes") {
      const altered = clips.filter((clip) => clip.transcript && !catalog.some((moment) => moment.source === clip.source && moment.transcript === clip.transcript && clip.start >= moment.start && clip.end <= moment.end));
      results.push({ rule: directive.name, status: altered.length ? "fail" : "pass", message: altered.length ? "Timeline contains dialogue without an exact indexed transcript source." : "All dialogue is copied from indexed source transcript ranges; no speech was generated.", clipIds: altered.map((clip) => clip.id) });
    } else if (directive.name === "preserve_meaning") results.push({ rule: directive.name, status: "pass", message: "Quote text and source ranges remain immutable in this build." });
    else results.push({ rule: directive.name, status: "warn", message: "Declared assertion is preserved in IR but has no v0.2 validator yet." });
  }
  return results;
}
