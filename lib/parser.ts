import type { CutProgram, Diagnostic, ExportDeclaration, SourceDeclaration, StoryDirective } from "./types";

const seconds = (value: string) => Number(value.replace(/s$/, ""));

export function parseCut(source: string): { program: CutProgram | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const sources: SourceDeclaration[] = [];
  const directives: StoryDirective[] = [];
  const exports: ExportDeclaration[] = [];
  let project = "Untitled";
  let duration = 45;
  let hasStory = false;

  source.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (!text || text.startsWith("#")) return;

    let match = text.match(/^project\s+"([^"]+)"$/);
    if (match) {
      project = match[1];
      return;
    }

    match = text.match(/^source\s+"([^"]+)"\s+from\s+"([^"]+)"$/);
    if (match) {
      sources.push({ name: match[1], path: match[2], line });
      return;
    }

    match = text.match(/^story\s+"([^"]+)"\s+in\s+(\d+(?:\.\d+)?)s:$/);
    if (match) {
      hasStory = true;
      duration = seconds(match[2]);
      return;
    }

    match = text.match(/^hook\s+(.+)\s+before\s+(\d+(?:\.\d+)?)s$/);
    if (match) {
      directives.push({ kind: "hook", query: match[1], before: seconds(match[2]), line });
      return;
    }

    match = text.match(/^beat\s+([a-zA-Z_][\w-]*)\s*:\s*(.+?)(?:\s+for\s+(\d+(?:\.\d+)?)s)?$/);
    if (match) {
      directives.push({ kind: "beat", name: match[1], query: match[2], duration: match[3] ? seconds(match[3]) : undefined, line });
      return;
    }

    match = text.match(/^rule\s+([a-zA-Z_][\w-]*)(?:\s*=\s*(.+))?$/);
    if (match) {
      directives.push({ kind: "rule", name: match[1], value: match[2], line });
      return;
    }

    match = text.match(/^captions\s+(.+)$/);
    if (match) {
      directives.push({ kind: "caption", style: match[1], line });
      return;
    }

    match = text.match(/^music\s+(.+)$/);
    if (match) {
      directives.push({ kind: "music", instruction: match[1], line });
      return;
    }

    match = text.match(/^(select|trim|split|sequence|remove|replace|intercut|montage|match_cut|jump_cut|j_cut|l_cut|reaction|broll|pace|hold|compress|accelerate|cut_on_beat|cut_on_action|breathing_room|crop|reframe|track|stabilize|zoom|color_match|grade|mask|blur|overlay|denoise|normalize|duck|crossfade|remove_filler|repair|music_sync|pattern_interrupt|remove_dead_air|retention_reset|cold_open|open_loop)\s+(.+)$/);
    if (match) {
      directives.push({ kind: "operation", name: match[1], instruction: match[2], line });
      return;
    }

    match = text.match(/^assert\s+([a-zA-Z_][\w-]*)(?:\s*=\s*(.+))?$/);
    if (match) {
      directives.push({ kind: "assertion", name: match[1], value: match[2], line });
      return;
    }

    match = text.match(/^export\s+([a-zA-Z_][\w-]*)\s+(\d+)x(\d+)(?:\s+in\s+(\d+(?:\.\d+)?)s)?$/);
    if (match) {
      const item: ExportDeclaration = {
        name: match[1],
        width: Number(match[2]),
        height: Number(match[3]),
        duration: match[4] ? seconds(match[4]) : undefined,
        line,
      };
      exports.push(item);
      return;
    }

    diagnostics.push({
      line,
      level: "error",
      message: `Cut does not understand “${text}”.`,
      hint: "Try a declaration, story beat, editorial operation, assertion, or export.",
    });
  });

  if (!hasStory) diagnostics.push({ line: 1, level: "error", message: "Every Cut program needs a story declaration.", hint: 'Example: story "Launch" in 45s:' });
  if (!sources.length) diagnostics.push({ line: 1, level: "warning", message: "No media sources declared; the compiler will use the demo rushes." });
  if (!exports.length) diagnostics.push({ line: 1, level: "info", message: "No export target declared; previewing at 16:9." });

  return {
    program: diagnostics.some((item) => item.level === "error") ? null : { project, duration, sources, directives, exports },
    diagnostics,
  };
}
