import { createHash } from "crypto";
import { demoMoments } from "./demo";
import { parseCut } from "./parser";
import type { CompileResult, CutProgram, MediaMoment, TimelineClip } from "./types";

const colors = ["#ff5c35", "#f1c84b", "#6ee7b7", "#5ea6ff", "#d99cff"];
const roles: TimelineClip["role"][] = ["hook", "problem", "turn", "proof", "resolution"];

function selectMoments(program: CutProgram, catalog: MediaMoment[]) {
  const requested = program.directives.filter((item) => item.kind === "hook" || item.kind === "beat");
  const unused = [...catalog];
  return requested.map((directive, index) => {
    const query = directive.kind === "hook" ? directive.query : `${directive.name} ${directive.query}`;
    const tokens = query.toLowerCase().split(/\W+/).filter(Boolean);
    const ranked = unused
      .map((moment) => {
        const haystack = `${moment.transcript} ${moment.visual} ${moment.emotion}`.toLowerCase();
        const lexical = tokens.filter((token) => haystack.includes(token)).length / Math.max(tokens.length, 1);
        const arcBoost = index === 0 && moment.salience > 0.95 ? 0.35 : 0;
        return { moment, score: lexical + moment.salience * 0.65 + arcBoost };
      })
      .sort((a, b) => b.score - a.score);
    const chosen = ranked[0]?.moment ?? catalog[index % catalog.length];
    const usedIndex = unused.findIndex((item) => item.id === chosen.id);
    if (usedIndex >= 0) unused.splice(usedIndex, 1);
    return { directive, moment: chosen, query };
  });
}

export function compileCut(source: string, catalog: MediaMoment[] = demoMoments, semanticPlan?: Array<{ momentId: string; role: TimelineClip["role"]; rationale: string; sourceLine: number }>): CompileResult {
  const parsed = parseCut(source);
  const buildId = createHash("sha1").update(source).digest("hex").slice(0, 8);
  if (!parsed.program) return { program: null, diagnostics: parsed.diagnostics, clips: [], duration: 0, model: "compiler", buildId };

  const chosen = semanticPlan?.length
    ? semanticPlan.map((selection) => ({
        directive: parsed.program!.directives.find((item) => item.line === selection.sourceLine) ?? parsed.program!.directives[0],
        moment: catalog.find((item) => item.id === selection.momentId) ?? catalog[0],
        query: selection.rationale,
        role: selection.role,
      }))
    : selectMoments(parsed.program, catalog).map((item, index) => ({
        ...item,
        role: item.directive.kind === "beat" && roles.includes(item.directive.name as TimelineClip["role"])
          ? item.directive.name as TimelineClip["role"]
          : roles[Math.min(index, roles.length - 1)],
      }));

  let cursor = 0;
  const available = parsed.program.duration;
  const baseDuration = available / Math.max(chosen.length, 1);
  const clips: TimelineClip[] = [];
  const selectedIds = new Set(chosen.map((item) => item.moment.id));
  const coverage = catalog.filter((moment) => !selectedIds.has(moment.id)).sort((a, b) => b.salience - a.salience);

  const addClip = (moment: MediaMoment, duration: number, role: TimelineClip["role"], rationale: string, sourceLine: number, colorIndex: number) => {
    const safeDuration = Math.min(duration, moment.end - moment.start, available - cursor);
    if (safeDuration <= .15) return;
    const timelineStart = cursor;
    cursor += safeDuration;
    clips.push({ ...moment, end: moment.start + safeDuration, timelineStart, timelineEnd: cursor, role, rationale, sourceLine, color: colors[colorIndex % colors.length] });
  };

  chosen.forEach((item, index) => {
    const targetDuration = item.directive?.kind === "beat" ? item.directive.duration ?? baseDuration : item.directive?.kind === "hook" ? item.directive.before : baseDuration;
    const primaryDuration = Math.min(targetDuration, item.moment.end - item.moment.start);
    const rationale = semanticPlan ? item.query : `Best match for “${item.query}”; salience ${Math.round(item.moment.salience * 100)}%.`;
    addClip(item.moment, primaryDuration, item.role, rationale, item.directive?.line ?? 1, index);

    if (primaryDuration < item.moment.end - item.moment.start - .15) {
      coverage.unshift({ ...item.moment, id: `${item.moment.id}-tail-${Math.round((item.moment.start + primaryDuration) * 1000)}`, start: item.moment.start + primaryDuration, transcript: "" });
    }

    let remainingBeat = targetDuration - primaryDuration;
    while (remainingBeat > .15 && coverage.length) {
      const support = coverage.shift()!;
      const supportDuration = Math.min(remainingBeat, support.end - support.start);
      addClip(support, supportDuration, "broll", `Coverage selected to complete the ${item.role} beat without stretching or synthesizing footage.`, item.directive?.line ?? 1, index);
      if (supportDuration < support.end - support.start - .15) {
        coverage.unshift({ ...support, id: `${support.id}-tail-${Math.round((support.start + supportDuration) * 10)}`, start: support.start + supportDuration });
      }
      remainingBeat -= supportDuration;
    }
  });

  while (cursor < available - .15 && coverage.length) {
    const support = coverage.shift()!;
    const supportDuration = Math.min(available - cursor, support.end - support.start);
    addClip(support, supportDuration, "broll", "Traceable closing coverage selected to satisfy the declared story duration.", parsed.program.directives.at(-1)?.line ?? 1, clips.length);
    if (supportDuration < support.end - support.start - .15) {
      coverage.unshift({ ...support, id: `${support.id}-tail-${Math.round((support.start + supportDuration) * 10)}`, start: support.start + supportDuration });
    }
  }

  return {
    program: parsed.program,
    diagnostics: parsed.diagnostics,
    clips,
    duration: Math.min(cursor, parsed.program.duration),
    model: semanticPlan ? "gpt-5.6 + cut compiler" : "cut compiler · deterministic fallback",
    buildId,
  };
}
