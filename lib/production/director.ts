import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { MediaIndex, MediaMoment, TimelineClip } from "../types";
import type { ProductionPlan, ProductionTheme } from "./types";
import { parseCut } from "../parser";
import { runCodex } from "../core/planner";

export type DirectedSegment = {
  sourceLine: number;
  momentId: string;
  role: TimelineClip["role"];
  title: string;
  subtitle: string;
  narration: string;
  rationale: string;
};

export type Direction = { title: string; segments: DirectedSegment[] };

const roleValues = ["hook", "problem", "turn", "proof", "resolution", "broll"] as const;

export const directionSchema = {
  type: "object", additionalProperties: false, required: ["title", "segments"], properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    segments: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object", additionalProperties: false,
      required: ["sourceLine", "momentId", "role", "title", "subtitle", "narration", "rationale"], properties: {
        sourceLine: { type: "integer", minimum: 1 }, momentId: { type: "string", maxLength: 160 },
        role: { type: "string", enum: roleValues }, title: { type: "string", maxLength: 160 },
        subtitle: { type: "string", maxLength: 240 }, narration: { type: "string", maxLength: 5_000 },
        rationale: { type: "string", maxLength: 2_000 },
      },
    } },
  },
};

function requestedLines(source: string) {
  const parsed = parseCut(source);
  if (!parsed.program) throw new Error("Cannot direct an invalid CUT program.");
  return parsed.program.directives.filter((item) => item.kind === "hook" || item.kind === "beat").map((item) => item.line);
}

export function validateDirection(direction: Direction, source: string, catalog: MediaMoment[]) {
  const lines = requestedLines(source);
  if (!direction || typeof direction.title !== "string" || !direction.title.trim() || direction.title.length > 200 || !Array.isArray(direction.segments) || direction.segments.length !== lines.length) throw new Error("Director returned an invalid segment count or title.");
  const moments = new Set(catalog.map((item) => item.id));
  const roles = new Set(roleValues);
  direction.segments.forEach((segment, index) => {
    if (!segment || segment.sourceLine !== lines[index] || !moments.has(segment.momentId) || !roles.has(segment.role) ||
      typeof segment.title !== "string" || segment.title.length > 160 || typeof segment.subtitle !== "string" || segment.subtitle.length > 240 ||
      typeof segment.narration !== "string" || !segment.narration.trim() || segment.narration.length > 5_000 ||
      typeof segment.rationale !== "string" || !segment.rationale.trim() || segment.rationale.length > 2_000) throw new Error(`Director returned an invalid segment for source line ${lines[index]}.`);
  });
  if (new Set(direction.segments.map((item) => item.momentId)).size !== direction.segments.length) throw new Error("Director reused a locked moment despite the unique-moment contract.");
  return direction;
}

function prompt(source: string, catalog: MediaMoment[]) {
  return `You are CUT's documentary director. Return only the requested structured direction. Create exactly one segment for every hook or beat line, in source-line order. Select only supplied locked moment IDs. Never invent a filename, timecode, quote, statistic, or visual fact. Narration must be supported by the CUT program or the selected moment's transcript/visual description. Keep on-screen titles concise. Build a causal arc with a strong cold open and payoff. Do not output commands, code, filter graphs, URLs, or markdown.\n\nCUT PROGRAM\n${source}\n\nREQUIRED SOURCE LINES\n${requestedLines(source).join(", ")}\n\nLOCKED MEDIA MOMENTS\n${JSON.stringify(catalog)}`;
}

export async function directWithOpenAI(source: string, catalog: MediaMoment[], apiKey: string, model = "gpt-5.6") {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal: AbortSignal.timeout(120_000), headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, reasoning: { effort: "high" }, store: false,
      input: [{ role: "developer", content: "Act as a source-grounded documentary director. Obey the schema and evidence constraints exactly." }, { role: "user", content: prompt(source, catalog) }],
      text: { format: { type: "json_schema", name: "cut_documentary_direction", strict: true, schema: directionSchema } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI directing failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string; refusal?: string }> }> };
  const refusal = data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "refusal")?.refusal;
  if (refusal) throw new Error(`Documentary director refused: ${refusal}`);
  const text = data.output_text ?? data.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
  return validateDirection(JSON.parse(text) as Direction, source, catalog);
}

export async function directWithCodex(source: string, catalog: MediaMoment[]) {
  const directory = await mkdtemp(join(tmpdir(), "cut-codex-direct-"));
  const schemaPath = join(directory, "schema.json");
  const outputPath = join(directory, "direction.json");
  await writeFile(schemaPath, JSON.stringify(directionSchema));
  try {
    await runCodex(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-5.6-luna", "--config", "model_reasoning_effort=\"medium\"", "--output-schema", schemaPath, "-o", outputPath, prompt(source, catalog)], directory);
    return validateDirection(JSON.parse(await readFile(outputPath, "utf8")) as Direction, source, catalog);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assetPath(index: MediaIndex, source: string) {
  const asset = index.assets.find((item) => item.sourceName === source);
  if (!asset) throw new Error(`Direction references an unknown indexed source: ${source}`);
  return index.assets.length === 1 && basename(index.root) === asset.path ? index.root : resolve(index.root, asset.path);
}

export function lowerDirection(direction: Direction, source: string, catalog: MediaMoment[], index: MediaIndex, outputPath: string, theme: ProductionTheme): ProductionPlan {
  const parsed = parseCut(source);
  if (!parsed.program) throw new Error("Cannot lower an invalid CUT program.");
  const outputRoot = dirname(resolve(outputPath));
  let cursor = 0;
  const shots = direction.segments.map((segment) => {
    const directive = parsed.program!.directives.find((item) => item.line === segment.sourceLine)!;
    const moment = catalog.find((item) => item.id === segment.momentId)!;
    const budget = directive.kind === "hook" ? directive.before : directive.kind === "beat" ? directive.duration ?? moment.end - moment.start : moment.end - moment.start;
    const shotDuration = Math.max(.2, Math.min(budget, moment.end - moment.start));
    const path = relative(outputRoot, assetPath(index, moment.source));
    const shot = { source: path, kind: "video" as const, start: moment.start, duration: shotDuration, title: segment.title, subtitle: segment.subtitle || undefined };
    cursor += shotDuration;
    return shot;
  });
  cursor = 0;
  const narration = direction.segments.map((segment, index) => {
    const start = cursor + .35;
    cursor += shots[index].duration;
    return { start, text: segment.narration };
  });
  const target = parsed.program.exports[0] ?? { width: 1920, height: 1080 };
  return {
    format: "cut-production", version: 1, title: direction.title,
    canvas: { width: target.width, height: target.height, fps: 30 }, theme, shots, narration,
    audio: { narrationVoice: "Reed (English (UK))", narrationRate: 174, dialogueLufs: -16, masterLufs: -14, truePeakDb: -1.2 }, captions: { enabled: true, fontSize: 23, margin: 54 },
    output: { filename: `${direction.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4` },
  };
}
