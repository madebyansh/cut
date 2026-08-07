import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { MediaAsset, MediaIndex } from "../types";
import { mediaIndexHash } from "./indexer";

const run = promisify(execFile);
type Scene = MediaAsset["scenes"][number];
type Visual = NonNullable<Scene["visual"]>;
type VisionResult = { scenes: Array<{ sceneId: string } & Visual> };

export const sceneVisionSchema = {
  type: "object", additionalProperties: false, required: ["scenes"], properties: {
    scenes: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false,
      required: ["sceneId", "description", "subjects", "setting", "composition", "camera", "motion", "visibleText", "usability", "confidence"], properties: {
        sceneId: { type: "string", maxLength: 100 }, description: { type: "string", maxLength: 500 },
        subjects: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } }, setting: { type: "string", maxLength: 200 },
        composition: { type: "string", maxLength: 200 }, camera: { type: "string", maxLength: 160 }, motion: { type: "string", maxLength: 160 },
        visibleText: { type: "string", maxLength: 300 }, usability: { type: "string", enum: ["hero", "broll", "transition", "weak"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    } },
  },
};

function assetPath(index: MediaIndex, asset: MediaAsset) {
  return index.assets.length === 1 && basename(index.root) === asset.path ? index.root : resolve(index.root, asset.path);
}

export function validateSceneVision(result: VisionResult, scenes: Scene[]) {
  if (!result || !Array.isArray(result.scenes) || result.scenes.length !== scenes.length) throw new Error("Vision model returned an invalid scene count.");
  const expected = scenes.map((scene) => scene.id);
  result.scenes.forEach((item, index) => {
    if (!item || item.sceneId !== expected[index] || !["hero", "broll", "transition", "weak"].includes(item.usability) ||
      typeof item.description !== "string" || !item.description.trim() || item.description.length > 500 ||
      !Array.isArray(item.subjects) || item.subjects.length > 20 || item.subjects.some((subject) => typeof subject !== "string" || subject.length > 100) ||
      [item.setting, item.composition, item.camera, item.motion, item.visibleText].some((value) => typeof value !== "string") ||
      typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error(`Vision model returned invalid analysis for ${expected[index]}.`);
  });
  return result;
}

function outputText(data: { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }) {
  return data.output_text ?? data.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
}

async function analyzeBatch(asset: MediaAsset, source: string, scenes: Scene[], apiKey: string, model: string) {
  const temp = await mkdtemp(join(tmpdir(), "cut-vision-"));
  try {
    const content: Array<Record<string, unknown>> = [{ type: "input_text", text: `Analyze these sampled frames from one video asset for professional documentary editing. Return exactly one item per scene in this order: ${scenes.map((scene) => scene.id).join(", ")}. Describe only visible evidence. Do not infer identities, places, events, causes, or facts that are not visually established. Composition should mention framing and usable negative space. Camera and motion should distinguish static, pan, tilt, zoom, handheld, tracking, or indeterminate. Usability means: hero for a compelling primary shot, broll for useful coverage, transition for connective imagery, weak for visually poor or redundant footage.` }];
    for (const [index, scene] of scenes.entries()) {
      const frame = join(temp, `${String(index).padStart(3, "0")}.jpg`);
      const time = Math.max(scene.start, Math.min(scene.end - .05, scene.start + (scene.end - scene.start) / 2));
      await run("ffmpeg", ["-y", "-v", "error", "-ss", time.toFixed(3), "-i", source, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", frame], { timeout: 30_000, maxBuffer: 4_000_000 });
      const encoded = (await readFile(frame)).toString("base64");
      content.push({ type: "input_text", text: `Scene ${scene.id}, sampled at ${time.toFixed(2)} seconds:` });
      content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${encoded}`, detail: "low" });
    }
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", signal: AbortSignal.timeout(120_000), headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, store: false, reasoning: { effort: "medium" }, input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: "cut_scene_vision", strict: true, schema: sceneVisionSchema } },
      }),
    });
    if (!response.ok) throw new Error(`Vision analysis failed for ${asset.path}: ${response.status} ${await response.text()}`);
    return validateSceneVision(JSON.parse(outputText(await response.json())) as VisionResult, scenes);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function analyzeMediaIndex(index: MediaIndex, apiKey: string, model = "gpt-5.6") {
  for (const asset of index.assets) {
    const source = assetPath(index, asset);
    for (let offset = 0; offset < asset.scenes.length; offset += 32) {
      const batch = asset.scenes.slice(offset, offset + 32);
      const result = await analyzeBatch(asset, source, batch, apiKey, model);
      result.scenes.forEach(({ sceneId, ...visual }) => {
        const scene = asset.scenes.find((item) => item.id === sceneId)!;
        scene.visual = visual;
      });
    }
  }
  index.indexHash = mediaIndexHash(index);
  return index;
}
