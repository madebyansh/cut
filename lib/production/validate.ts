import { extname, isAbsolute, relative, resolve } from "node:path";
import type { ProductionPlan } from "./types";

const mediaExtensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".jpg", ".jpeg", ".png", ".webp"]);

function finite(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
}

export function resolveProjectPath(root: string, path: string) {
  if (!path || path.includes("\0")) throw new Error("Production paths must be non-empty strings.");
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`Production source escapes the project root: ${path}`);
  return absolute;
}

export function validateProductionPlan(value: unknown): ProductionPlan {
  if (!value || typeof value !== "object") throw new Error("Production plan must be an object.");
  const plan = value as ProductionPlan;
  if (plan.format !== "cut-production" || plan.version !== 1) throw new Error("Unsupported production plan format or version.");
  if (typeof plan.title !== "string" || !plan.title.trim() || plan.title.length > 200) throw new Error("Production title is invalid.");
  finite(plan.canvas?.width, 320, 4096, "canvas.width");
  finite(plan.canvas?.height, 320, 4096, "canvas.height");
  finite(plan.canvas?.fps, 12, 60, "canvas.fps");
  if (!Array.isArray(plan.shots) || !plan.shots.length || plan.shots.length > 2_000) throw new Error("Production needs between 1 and 2,000 shots.");
  let total = 0;
  for (const [index, shot] of plan.shots.entries()) {
    const kind = shot.kind ?? "video";
    const graphic = ["title", "metric", "chart", "timeline", "map", "flow-map", "network", "causal-map"].includes(kind);
    if (!graphic && (typeof shot.source !== "string" || !mediaExtensions.has(extname(shot.source).toLowerCase()))) throw new Error(`Shot ${index + 1} has an unsupported source.`);
    if (graphic && shot.source !== undefined) throw new Error(`Graphic shot ${index + 1} cannot declare an external source.`);
    if (kind === "chart") {
      const chart = shot.graphic?.chart;
      if (!chart || !Array.isArray(chart.labels) || !Array.isArray(chart.values) || !chart.labels.length || chart.labels.length !== chart.values.length || chart.labels.length > 20 || chart.values.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Chart shot ${index + 1} has invalid data.`);
    }
    if (kind === "metric" || kind === "flow-map") {
      const metric = shot.graphic?.metric;
      if (!metric?.value?.trim() || metric.value.length > 40 || !metric.label?.trim() || metric.label.length > 160 || (metric.context !== undefined && metric.context.length > 160) || (metric.method !== undefined && metric.method.length > 180) || (metric.sourceLabel !== undefined && metric.sourceLabel.length > 100) || (metric.status !== undefined && !["reported", "estimated", "modeled", "derived"].includes(metric.status))) throw new Error(`Metric shot ${index + 1} has invalid data.`);
    }
    if (kind === "timeline" || kind === "causal-map") {
      const events = shot.graphic?.timeline?.events;
      if (!Array.isArray(events) || !events.length || events.length > 12 || events.some((event) => typeof event.date !== "string" || typeof event.label !== "string")) throw new Error(`Timeline shot ${index + 1} has invalid events.`);
    }
    if (kind === "map" || kind === "flow-map" || kind === "causal-map") {
      const map = shot.graphic?.map;
      if (!map || (map.points?.length ?? 0) > 30 || (map.routes?.length ?? 0) > 20) throw new Error(`Map shot ${index + 1} has invalid data.`);
      for (const point of map.points ?? []) { finite(point.latitude, -90, 90, `shots[${index}].map.latitude`); finite(point.longitude, -180, 180, `shots[${index}].map.longitude`); }
      for (const route of map.routes ?? []) { finite(route.from[0], -90, 90, `shots[${index}].map.route.from.latitude`); finite(route.from[1], -180, 180, `shots[${index}].map.route.from.longitude`); finite(route.to[0], -90, 90, `shots[${index}].map.route.to.latitude`); finite(route.to[1], -180, 180, `shots[${index}].map.route.to.longitude`); }
    }
    if (kind === "network") {
      const network = shot.graphic?.network; const nodes = network?.nodes ?? []; const nodeIds = new Set(nodes.map((node) => node.id));
      if (!network || nodes.length < 2 || nodes.length > 5 || nodeIds.size !== nodes.length || nodes.some((node) => !node.id || !node.label || !node.metric?.value || !node.metric.label) || network.edges.length < 1 || network.edges.length > 8 || network.edges.some((edge) => !nodeIds.has(edge.fromId) || !nodeIds.has(edge.toId))) throw new Error(`Network shot ${index + 1} has invalid nodes or edges.`);
    }
    finite(shot.duration, .2, 600, `shots[${index}].duration`);
    if (shot.start !== undefined) finite(shot.start, 0, 86_400, `shots[${index}].start`);
    if (shot.crop) {
      const crop = shot.crop; [crop.x, crop.y, crop.width, crop.height].forEach((value, part) => finite(value, part < 2 ? 0 : .001, 1, `shots[${index}].crop`));
      if (crop.x + crop.width > 1 || crop.y + crop.height > 1) throw new Error(`Shot ${index + 1} crop escapes its source frame.`);
    }
    if (shot.title && shot.title.length > 160) throw new Error(`Shot ${index + 1} title is too long.`);
    if (shot.subtitle && shot.subtitle.length > 240) throw new Error(`Shot ${index + 1} subtitle is too long.`);
    if (shot.motion !== undefined && !["none", "source", "push", "pull", "reveal", "flow"].includes(shot.motion)) throw new Error(`Shot ${index + 1} has an invalid motion.`);
    if (shot.composition !== undefined && !["editorial", "hero", "evidence-left", "evidence-right", "minimal"].includes(shot.composition)) throw new Error(`Shot ${index + 1} has an invalid composition.`);
    total += shot.duration;
  }
  if (total > 7_200) throw new Error("Production duration exceeds the two-hour safety limit.");
  for (const [index, item] of (plan.narration ?? []).entries()) {
    if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 5_000) throw new Error(`Narration ${index + 1} is invalid.`);
    finite(item.start, 0, total, `narration[${index}].start`);
    if (item.rate !== undefined) finite(item.rate, 80, 360, `narration[${index}].rate`);
    if (item.audio !== undefined && (typeof item.audio !== "string" || ![".wav", ".aiff", ".aif", ".mp3", ".m4a"].includes(extname(item.audio).toLowerCase()))) throw new Error(`Narration ${index + 1} has an unsupported audio source.`);
  }
  if (plan.audio?.music) {
    const music = plan.audio.music;
    if (music.kind !== "procedural-tone" || !Array.isArray(music.frequencies) || !music.frequencies.length || music.frequencies.length > 8) throw new Error("Procedural music needs between one and eight frequencies.");
    music.frequencies.forEach((frequency, index) => finite(frequency, 20, 20_000, `audio.music.frequencies[${index}]`));
    finite(music.volume, 0, 1, "audio.music.volume");
    if (music.fadeIn !== undefined) finite(music.fadeIn, 0, total, "audio.music.fadeIn");
    if (music.fadeOut !== undefined) finite(music.fadeOut, 0, total, "audio.music.fadeOut");
    if (music.impactOnCuts !== undefined && typeof music.impactOnCuts !== "boolean") throw new Error("audio.music.impactOnCuts must be boolean.");
  }
  if (plan.audio?.narrationVoice !== undefined && (typeof plan.audio.narrationVoice !== "string" || !plan.audio.narrationVoice.trim() || plan.audio.narrationVoice.length > 100)) throw new Error("audio.narrationVoice must be a non-empty bounded voice name.");
  if (plan.audio?.narrationRate !== undefined) finite(plan.audio.narrationRate, 80, 320, "audio.narrationRate");
  if (!plan.theme || Object.values(plan.theme).some((value) => typeof value !== "string" || !value)) throw new Error("Production theme is incomplete.");
  return plan;
}
