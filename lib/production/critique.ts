import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runCodex } from "../core/planner";
import type { ProductionManifest } from "./types";

const run = promisify(execFile);
const scoreKeys = ["narrative", "visualVariety", "legibility", "motion", "evidence", "pacing", "overall"] as const;
type ScoreKey = typeof scoreKeys[number];

export type ProductionCritique = {
  verdict: "pass" | "revise";
  scores: Record<ScoreKey, number>;
  summary: string;
  findings: Array<{ category: ScoreKey; severity: "high" | "medium" | "low"; evidence: string; recommendation: string }>;
  motionAudit?: ProductionMotionAudit;
};

export type ProductionMotionAudit = {
  sampleFps: number;
  shots: Array<{ order: number; kind: string; title: string; meanYdif: number; activeRatio: number; state: "active" | "subtle" | "static" }>;
  staticShotCount: number;
};

export const productionCritiqueSchema = {
  type: "object", additionalProperties: false, required: ["verdict", "scores", "summary", "findings"], properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    scores: { type: "object", additionalProperties: false, required: [...scoreKeys], properties: Object.fromEntries(scoreKeys.map((key) => [key, { type: "number", minimum: 1, maximum: 10 }])) },
    summary: { type: "string", minLength: 1, maxLength: 1_000 },
    findings: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["category", "severity", "evidence", "recommendation"], properties: {
      category: { type: "string", enum: [...scoreKeys] }, severity: { type: "string", enum: ["high", "medium", "low"] },
      evidence: { type: "string", minLength: 1, maxLength: 500 }, recommendation: { type: "string", minLength: 1, maxLength: 500 },
    } } },
  },
};

export function validateProductionCritique(value: unknown): ProductionCritique {
  const critique = value as ProductionCritique;
  if (!critique || !["pass", "revise"].includes(critique.verdict) || !critique.summary?.trim() || !Array.isArray(critique.findings) || critique.findings.length > 6) throw new Error("Invalid production critique.");
  for (const key of scoreKeys) if (!Number.isFinite(critique.scores?.[key]) || critique.scores[key] < 1 || critique.scores[key] > 10) throw new Error(`Invalid critique score: ${key}`);
  if (critique.findings.some((item) => !scoreKeys.includes(item.category) || !["high", "medium", "low"].includes(item.severity) || !item.evidence?.trim() || !item.recommendation?.trim())) throw new Error("Invalid production critique finding.");
  const shouldPass = critique.scores.overall >= 8 && scoreKeys.filter((key) => key !== "overall").every((key) => critique.scores[key] >= 7);
  if ((critique.verdict === "pass") !== shouldPass) throw new Error("Critique verdict conflicts with the deterministic quality gate.");
  if (critique.motionAudit) {
    if (critique.motionAudit.sampleFps !== 2 || !Array.isArray(critique.motionAudit.shots) || !Number.isInteger(critique.motionAudit.staticShotCount)) throw new Error("Invalid deterministic motion audit.");
    for (const shot of critique.motionAudit.shots) if (!Number.isFinite(shot.meanYdif) || !Number.isFinite(shot.activeRatio) || shot.activeRatio < 0 || shot.activeRatio > 1 || !["active", "subtle", "static"].includes(shot.state)) throw new Error("Invalid motion-audit shot.");
  }
  return critique;
}

export async function auditProductionMotion(videoPath: string, manifest: ProductionManifest): Promise<ProductionMotionAudit> {
  const video = resolve(videoPath); const sampleFps = 2; let cursor = 0;
  const shots: ProductionMotionAudit["shots"] = [];
  for (const [index, shot] of manifest.shots.entries()) {
    const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", String(cursor), "-t", String(shot.duration), "-i", video, "-vf", `fps=${sampleFps},scale=320:-1,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-`, "-an", "-f", "null", "-"], { timeout: 120_000, maxBuffer: 4_000_000 });
    cursor += shot.duration;
    const differences = [...stdout.matchAll(/YDIF=([0-9.]+)/g)].map((match) => Number(match[1])).slice(1);
    const meanYdif = differences.length ? differences.reduce((sum, value) => sum + value, 0) / differences.length : 0;
    const activeRatio = differences.length ? differences.filter((value) => value > .5).length / differences.length : 0;
    const state = activeRatio >= .55 || meanYdif >= 1 ? "active" : activeRatio >= .25 || meanYdif >= .25 ? "subtle" : "static";
    shots.push({ order: index + 1, kind: shot.kind ?? "media", title: shot.title ?? `Shot ${index + 1}`, meanYdif: Number(meanYdif.toFixed(3)), activeRatio: Number(activeRatio.toFixed(3)), state });
  }
  return { sampleFps, shots, staticShotCount: shots.filter((shot) => shot.state === "static").length };
}

async function contactSheet(video: string, manifest: ProductionManifest, output: string) {
  let cursor = 0;
  // Early/mid/final triplets expose the actual motion arc while ensuring the
  // last sample contains the settled factual value.
  const frames = manifest.shots.flatMap((shot) => { const samples = [cursor + shot.duration * .03, cursor + shot.duration * .45, cursor + shot.duration * .88]; cursor += shot.duration; return samples.map((time) => Math.max(0, Math.round(time * manifest.export.fps))); });
  const columns = Math.min(6, frames.length); const rows = Math.ceil(frames.length / columns);
  await run("ffmpeg", ["-y", "-v", "error", "-i", video, "-vf", `select='${frames.map((frame) => `eq(n\\,${frame})`).join("+")}',scale=480:270,tile=${columns}x${rows}`, "-frames:v", "1", output], { timeout: 120_000 });
}

export async function critiqueProduction(videoPath: string, manifestPath: string) {
  const video = resolve(videoPath); const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8")) as ProductionManifest;
  if (manifest.format !== "cut-production-manifest" || !manifest.shots?.length) throw new Error("critique needs a valid CUT production manifest.");
  const directory = await mkdtemp(join(tmpdir(), "cut-critique-")); const image = join(directory, "contact-sheet.jpg"); const schema = join(directory, "schema.json"); const output = join(directory, "critique.json");
  try {
    const motionAudit = await auditProductionMotion(video, manifest);
    await contactSheet(video, manifest, image); await writeFile(schema, JSON.stringify(productionCritiqueSchema));
    const prompt = `Act only as a demanding senior documentary editor. Judge the attached contact sheet as a 60-90 second explanatory film aiming for the visual and editorial standard of top YouTube geopolitics channels. The frames show early, middle, and final samples from every shot in chronological triplets, so compare each triplet to judge purposeful within-shot motion; use the final sample for factual-value checks. The deterministic YDIF audit measures actual frame-to-frame change at 2 fps; use it to distinguish genuinely static shots from motion that may be hard to see in the grid, but still judge whether that motion communicates meaning. Use the locked manifest below to assess narrative progression, visual variety, legibility, motion, evidence/source integrity, and pacing. Do not reward mere technical correctness. A pass requires overall >= 8 and every category >= 7. Give concrete visible evidence and reusable engine-level recommendations, never project-specific code.\n\nDETERMINISTIC MOTION AUDIT\n${JSON.stringify(motionAudit)}\n\nLOCKED MANIFEST\n${JSON.stringify(manifest)}`;
    await runCodex(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-5.6-luna", "--config", "model_reasoning_effort=\"high\"", "--image", image, "--output-schema", schema, "-o", output, prompt], directory);
    const critique = validateProductionCritique(JSON.parse(await readFile(output, "utf8")));
    return validateProductionCritique({ ...critique, motionAudit });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
