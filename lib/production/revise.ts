import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCut } from "../parser";
import { runCodex } from "../core/planner";
import type { ProductionCritique } from "./critique";

const schema = { type: "object", additionalProperties: false, required: ["edits", "rationale"], properties: {
  edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["sourceLine", "query", "duration"], properties: {
    sourceLine: { type: "integer", minimum: 1 }, query: { type: "string", minLength: 1, maxLength: 1_000 }, duration: { type: "number", minimum: .2, maximum: 600 },
  } } },
  rationale: { type: "string", minLength: 1, maxLength: 2_000 },
} };

type RevisionEdit = { sourceLine: number; query: string; duration: number };

function withoutLine<T extends { line: number }>(item: T) {
  const copy = { ...item } as Omit<T, "line"> & { line?: number };
  delete copy.line;
  return copy;
}

function narrativeDuration(source: string) {
  const parsed = parseCut(source).program!;
  return parsed.directives.filter((item) => item.kind === "hook" || item.kind === "beat").reduce((sum, item) => sum + (item.kind === "hook" ? item.before : item.duration ?? 5), 0);
}

export function validateProgramRevision(before: string, after: string) {
  const original = parseCut(before); const revised = parseCut(after);
  if (!original.program || !revised.program) throw new Error(`Revised CUT program does not parse: ${revised.diagnostics.map((item) => item.message).join("; ")}`);
  if (original.program.project !== revised.program.project || original.program.duration !== revised.program.duration || JSON.stringify(original.program.sources.map(withoutLine)) !== JSON.stringify(revised.program.sources.map(withoutLine)) || JSON.stringify(original.program.exports.map(withoutLine)) !== JSON.stringify(revised.program.exports.map(withoutLine))) throw new Error("Revision changed project, story duration, sources, or export contract.");
  const beforeNarrative = original.program.directives.filter((item) => item.kind === "hook" || item.kind === "beat");
  const afterNarrative = revised.program.directives.filter((item) => item.kind === "hook" || item.kind === "beat");
  if (beforeNarrative.length !== afterNarrative.length || beforeNarrative.some((item, index) => item.kind !== afterNarrative[index].kind || (item.kind === "beat" && afterNarrative[index].kind === "beat" && item.name !== afterNarrative[index].name))) throw new Error("Revision changed the narrative beat structure.");
  const fixed = (program: typeof original.program) => program!.directives.filter((item) => item.kind !== "hook" && item.kind !== "beat").map(withoutLine);
  if (JSON.stringify(fixed(original.program)) !== JSON.stringify(fixed(revised.program))) throw new Error("Revision changed non-narrative rules or assertions.");
  if (Math.abs(narrativeDuration(before) - narrativeDuration(after)) > .001) throw new Error("Revision changed the total declared beat duration.");
  return after;
}

export function applyProgramRevision(source: string, edits: RevisionEdit[]) {
  const parsed = parseCut(source);
  if (!parsed.program) throw new Error("Cannot revise an invalid CUT program.");
  const narrative = parsed.program.directives.filter((item) => item.kind === "hook" || item.kind === "beat");
  if (edits.length !== narrative.length || edits.some((edit, index) => edit.sourceLine !== narrative[index].line || !edit.query.trim() || !Number.isFinite(edit.duration) || edit.duration < .2 || edit.duration > 600 || /[\r\n]/.test(edit.query))) throw new Error("Revision edits must cover every narrative line in order with bounded single-line intent.");
  const expected = narrative.reduce((sum, item) => sum + (item.kind === "hook" ? item.before : item.duration ?? 5), 0);
  const received = edits.reduce((sum, item) => sum + item.duration, 0);
  if (Math.abs(expected - received) > .001) throw new Error(`Revision durations total ${received}s; preserve ${expected}s.`);
  edits.forEach((edit, index) => {
    if (narrative[index].kind === "hook" && /\b(?:ask|question|why|how|what|whether|full-bleed)\b/i.test(edit.query) && edit.duration < 5) throw new Error("Question or full-bleed hooks require at least 5 seconds for a grounded, intelligible opening.");
  });
  const lines = source.split("\n");
  narrative.forEach((item, index) => {
    const edit = edits[index]; const indent = lines[item.line - 1].match(/^\s*/)?.[0] ?? "";
    lines[item.line - 1] = item.kind === "hook" ? `${indent}hook ${edit.query.trim()} before ${edit.duration}s` : `${indent}beat ${item.name}: ${edit.query.trim()} for ${edit.duration}s`;
  });
  return validateProgramRevision(source, lines.join("\n"));
}

export async function reviseProgramWithCodex(source: string, critique: ProductionCritique) {
  const directory = await mkdtemp(join(tmpdir(), "cut-revise-")); const schemaPath = join(directory, "schema.json"); const outputPath = join(directory, "revision.json");
  await writeFile(schemaPath, JSON.stringify(schema));
  const parsed = parseCut(source);
  if (!parsed.program) throw new Error("Cannot revise an invalid CUT program.");
  const narrative = parsed.program.directives.filter((item) => item.kind === "hook" || item.kind === "beat");
  const locked = narrative.map((item) => ({ sourceLine: item.line, kind: item.kind, name: item.kind === "beat" ? item.name : "hook", currentQuery: item.query, currentDuration: item.kind === "hook" ? item.before : item.duration ?? 5 }));
  const basePrompt = `Act only as CUT's senior story editor. Respond with exactly one typed edit for every locked narrative line, in order. You may revise only query and redistribute duration; sourceLine is immutable and all durations must preserve the exact current total. Do not write CUT syntax. Do not add facts. Express evidence modes, visual contrast, escalation, and pacing more clearly for the later grounded director. Preserve explicit words such as full-bleed, proportional, map, overlay, and real media when they enforce a visual contract.\n\nCRITIQUE\n${JSON.stringify(critique)}\n\nLOCKED NARRATIVE LINES\n${JSON.stringify(locked)}`;
  try {
    let instruction = basePrompt; let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runCodex(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-5.6-luna", "--config", `model_reasoning_effort=\"${attempt === 1 ? "high" : "medium"}\"`, "--output-schema", schemaPath, "-o", outputPath, instruction], directory);
      const raw = await readFile(outputPath, "utf8");
      try { const result = JSON.parse(raw) as { edits: RevisionEdit[]; rationale: string }; return { ...result, program: applyProgramRevision(source, result.edits) }; }
      catch (error) { lastError = error; instruction = `${basePrompt}\n\nThe previous revision failed the compiler contract. Correct it. ERROR: ${error instanceof Error ? error.message : String(error)}\nPREVIOUS OUTPUT:\n${raw}`; }
    }
    throw lastError;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
