import { parseCut } from "../parser";
import type { MediaMoment, TimelineClip } from "../types";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SemanticSelection = { momentId: string; role: TimelineClip["role"]; rationale: string; sourceLine: number };

export async function runCodex(args: string[], cwd: string) {
  return new Promise<void>((accept, reject) => {
    const child = spawn("codex", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.resume();
    child.stdin.end();
    // Evidence-heavy documentary plans routinely contain a long locked source
    // pack plus a strict structured schema. Keep the call bounded, but allow a
    // high-reasoning first pass enough time to finish instead of discarding a
    // nearly complete source-grounded direction at four minutes.
    const timeout = 480_000;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Codex timed out after ${timeout / 1000}s. ${stderr}`)); }, timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) accept(); else reject(new Error(`Codex exited with status ${code}. ${stderr}`));
    });
  });
}

export function validateSemanticPlan(selections: SemanticSelection[], requestedLines: number[], catalog: MediaMoment[]) {
  const validRoles = new Set<TimelineClip["role"]>(["hook", "problem", "turn", "proof", "resolution", "broll"]);
  if (selections.length !== requestedLines.length || selections.some((item, index) =>
    !item || typeof item.momentId !== "string" || item.momentId.length > 160 ||
    typeof item.rationale !== "string" || item.rationale.length > 2_000 || !validRoles.has(item.role) ||
    item.sourceLine !== requestedLines[index] || !catalog.some((moment) => moment.id === item.momentId)
  )) {
    throw new Error("Model returned a structurally valid but semantically invalid source plan.");
  }
  if (new Set(selections.map((item) => item.momentId)).size !== selections.length) throw new Error("Model reused a source moment despite the unique-selection contract.");
  return selections;
}

export const editorialPlanSchema = {
  type: "object", additionalProperties: false, required: ["selections"], properties: { selections: { type: "array", maxItems: 500, items: {
    type: "object", additionalProperties: false, required: ["momentId", "role", "rationale", "sourceLine"], properties: {
      momentId: { type: "string", maxLength: 160 }, role: { type: "string", enum: ["hook", "problem", "turn", "proof", "resolution", "broll"] },
      rationale: { type: "string", maxLength: 2_000 }, sourceLine: { type: "integer", minimum: 1 },
    },
  } } },
};

export async function planWithOpenAI(source: string, catalog: MediaMoment[], apiKey: string, model = "gpt-5.6"): Promise<SemanticSelection[]> {
  const parsed = parseCut(source);
  if (!parsed.program) throw new Error("Cannot create a semantic plan for an invalid Cut program.");
  const requestedLines = parsed.program.directives.filter((item) => item.kind === "hook" || item.kind === "beat").map((item) => item.line);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(90_000), body: JSON.stringify({
      model, reasoning: { effort: "medium" }, store: false,
      input: [
        { role: "developer", content: "You are Cut's professional editorial planner. Select exactly one unique indexed moment for each hook or beat line, in program order. Optimize for a compelling cold open, causal story clarity, emotional contrast, visual proof, and a satisfying payoff. Use only supplied moment IDs and source lines. Never invent dialogue or timecodes. If evidence is weak, choose the least misleading source moment and say so in the rationale." },
        { role: "user", content: `CUT PROGRAM\n${source}\n\nREQUIRED SOURCE LINES\n${requestedLines.join(", ")}\n\nLOCKED MEDIA MOMENTS\n${JSON.stringify(catalog)}` },
      ],
      text: { format: { type: "json_schema", name: "cut_editorial_plan", strict: true, schema: editorialPlanSchema } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI planning failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }> };
  const refusal = data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "refusal")?.refusal;
  if (refusal) throw new Error(`Editorial planner refused: ${refusal}`);
  const text = data.output_text ?? data.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
  const plan = JSON.parse(text) as { selections: SemanticSelection[] };
  return validateSemanticPlan(plan.selections, requestedLines, catalog);
}

export async function planWithCodex(source: string, catalog: MediaMoment[]): Promise<SemanticSelection[]> {
  const parsed = parseCut(source);
  if (!parsed.program) throw new Error("Cannot create a semantic plan for an invalid Cut program.");
  const requestedLines = parsed.program.directives.filter((item) => item.kind === "hook" || item.kind === "beat").map((item) => item.line);
  const directory = await mkdtemp(join(tmpdir(), "cut-codex-plan-"));
  const schemaPath = join(directory, "schema.json");
  const outputPath = join(directory, "plan.json");
  await writeFile(schemaPath, JSON.stringify(editorialPlanSchema));
  const prompt = `Act only as Cut's professional editorial planner. Return the requested structured JSON and do not modify files or run commands. Select exactly one unique locked media moment for every required source line, in order. Optimize for cold-open strength, causal clarity, emotional contrast, visual proof, and payoff. Never invent IDs, dialogue, or timecodes.\n\nCUT PROGRAM\n${source}\n\nREQUIRED SOURCE LINES\n${requestedLines.join(", ")}\n\nLOCKED MEDIA MOMENTS\n${JSON.stringify(catalog)}`;
  try {
    try {
      await runCodex(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-5.6-luna", "--config", "model_reasoning_effort=\"low\"", "--output-schema", schemaPath, "-o", outputPath, prompt], directory);
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr: unknown }).stderr) : String(error);
      throw new Error(`Codex subscription planner failed. Run 'cut auth login' and retry. ${detail}`);
    }
    const plan = JSON.parse(await readFile(outputPath, "utf8")) as { selections: SemanticSelection[] };
    return validateSemanticPlan(plan.selections, requestedLines, catalog);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
