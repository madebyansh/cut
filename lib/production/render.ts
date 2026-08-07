import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProductionManifest, ProductionNarration } from "./types";
import { resolveProjectPath, validateProductionPlan } from "./validate";
import { hash } from "../core/stable";
import { productionGraphicSvg } from "./graphics";
import sharp from "sharp";

const run = promisify(execFile);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function command(program: string, args: string[], timeout = 300_000) {
  await run(program, args, { maxBuffer: 16_000_000, timeout });
}

async function sha256(path: string) {
  return new Promise<string>((accept, reject) => {
    const digest = createHash("sha256");
    createReadStream(path).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => accept(digest.digest("hex")));
  });
}

async function duration(path: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { timeout: 30_000 });
  return Number(stdout.trim());
}

function drawText(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "’").replaceAll(":", "\\:").replaceAll("%", "\\%");
}

function wrapText(value: string, maxCharacters: number, maxLines = 2) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let truncated = false;
  for (const word of words) {
    const current = lines.at(-1);
    if (!current) lines.push(word.slice(0, maxCharacters));
    else if (current.length + 1 + word.length <= maxCharacters) lines[lines.length - 1] = `${current} ${word}`;
    else if (lines.length < maxLines) lines.push(word.slice(0, maxCharacters));
    else { truncated = true; break; }
  }
  if (truncated && lines.length) lines[lines.length - 1] = `${lines.at(-1)!.slice(0, Math.max(1, maxCharacters - 1)).replace(/[.…]+$/, "")}…`;
  return lines;
}

function evidenceStatus(status: string | undefined, signal: string) {
  if (status === "reported") return { label: "REPORTED DATA", color: signal };
  if (status === "estimated") return { label: "SOURCE ESTIMATE", color: "#ffd166" };
  if (status === "derived") return { label: "DERIVED VALUE", color: "#ffd166" };
  if (status === "modeled") return { label: "SCENARIO MODEL", color: "#79c7ff" };
  return { label: "SOURCED", color: signal };
}

function conciseDisplay(value: string, maxCharacters: number) {
  if (value.length <= maxCharacters) return value;
  const prefix = value.slice(0, maxCharacters - 1); const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > maxCharacters * .62 ? boundary : undefined).trimEnd()}…`;
}

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${String(Math.floor(ms % 3_600_000 / 60_000)).padStart(2, "0")}:${String(Math.floor(ms % 60_000 / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function captions(items: Array<ProductionNarration & { duration: number }>) {
  let cue = 1;
  const result: string[] = [];
  for (const item of items) {
    const words = item.text.trim().split(/\s+/);
    let cursor = item.start;
    for (let offset = 0; offset < words.length; offset += 4) {
      const phrase = words.slice(offset, offset + 4);
      const segment = item.duration * phrase.length / words.length;
      result.push(`${cue++}\n${srtTime(cursor)} --> ${srtTime(cursor + segment)}\n${phrase.join(" ")}\n`);
      cursor += segment;
    }
  }
  return result.join("\n");
}

async function ensureFile(path: string, label: string) {
  await access(path).catch(() => { throw new Error(`Missing ${label}: ${path}`); });
}

export async function renderProduction(planPath: string, outputDirectory?: string) {
  const absolutePlan = resolve(planPath);
  const root = dirname(absolutePlan);
  const plan = validateProductionPlan(JSON.parse(await readFile(absolutePlan, "utf8")));
  const out = outputDirectory ? resolve(outputDirectory) : join(root, "final");
  const work = await mkdtemp(join(tmpdir(), "cut-production-"));
  await mkdir(out, { recursive: true });
  const totalDuration = plan.shots.reduce((sum, shot) => sum + shot.duration, 0);
  const sources = [...new Set(plan.shots.map((shot) => shot.source).filter((source): source is string => Boolean(source)))];
  const resolvedSources = new Map<string, string>();
  for (const source of sources) {
    const path = resolveProjectPath(root, source);
    await ensureFile(path, "production source");
    resolvedSources.set(source, path);
  }
  await ensureFile(plan.theme.fontFile, "theme font");
  await ensureFile(plan.theme.monoFontFile, "theme mono font");

  const parts: string[] = [];
  for (const [index, shot] of plan.shots.entries()) {
    const graphic = ["title", "metric", "chart", "timeline", "map", "flow-map", "network", "causal-map"].includes(shot.kind ?? "");
    let input: string;
    let kind: "video" | "image";
    if (graphic) {
      const frames = join(work, `graphic-${String(index).padStart(4, "0")}`);
      await mkdir(frames, { recursive: true });
      const frameRate = 12; const frameCount = Math.ceil(shot.duration * frameRate);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const linear = Math.min(1, frame / Math.max(1, frameCount * .92));
        // Begin at an actually unrevealed state so motion communicates the
        // relationship instead of presenting an almost-finished card.
        const progress = 1 - (1 - linear) ** 1.35;
        await sharp(Buffer.from(productionGraphicSvg(shot, plan, progress))).png().toFile(join(frames, `${String(frame).padStart(4, "0")}.png`));
      }
      input = join(work, `graphic-${String(index).padStart(4, "0")}.mp4`);
      await command("ffmpeg", ["-y", "-v", "error", "-framerate", String(frameRate), "-i", join(frames, "%04d.png"), "-t", String(shot.duration), "-vf", `fps=${plan.canvas.fps},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", input]);
      kind = "video";
    } else {
      input = resolvedSources.get(shot.source!)!;
      kind = shot.kind === "image" || imageExtensions.has(extname(input).toLowerCase()) ? "image" : "video";
    }
    const output = join(work, `shot-${String(index).padStart(4, "0")}.mp4`);
    const crop = shot.crop ? `crop=iw*${shot.crop.width}:ih*${shot.crop.height}:iw*${shot.crop.x}:ih*${shot.crop.y},` : "";
    const imageFrames = Math.max(1, Math.ceil(shot.duration * plan.canvas.fps));
    const panDirection = shot.motion === "pull" ? -1 : 1;
    const hero = shot.composition === "hero";
    const zoomStep = hero ? .0012 : .00065; const zoomMax = hero ? 1.18 : 1.12; const zoomMin = hero ? 1 : 1.02;
    const imageZoom = shot.motion === "pull" ? `if(eq(on,0),${zoomMax},max(zoom-${zoomStep},${zoomMin}))` : `if(eq(on,0),${zoomMin},min(zoom+${zoomStep},${zoomMax}))`;
    const panScale = hero ? .48 : .34; const verticalPanScale = hero ? .2 : .14;
    const imagePanX = `iw/2-(iw/zoom/2)+${panDirection}*(iw-iw/zoom)*${panScale}*(2*on/${imageFrames}-1)`;
    const imagePanY = `ih/2-(ih/zoom/2)-${panDirection}*(ih-ih/zoom)*${verticalPanScale}*(2*on/${imageFrames}-1)`;
    const base = kind === "image"
      ? shot.motion === "none" || graphic ? `${crop}scale=${plan.canvas.width}:${plan.canvas.height}:force_original_aspect_ratio=increase,crop=${plan.canvas.width}:${plan.canvas.height}` : `${crop}zoompan=z='${imageZoom}':x='${imagePanX}':y='${imagePanY}':d=1:s=${plan.canvas.width}x${plan.canvas.height}:fps=${plan.canvas.fps}`
      : `${crop}scale=${plan.canvas.width}:${plan.canvas.height}:force_original_aspect_ratio=increase,crop=${plan.canvas.width}:${plan.canvas.height},setsar=1,fps=${plan.canvas.fps}`;
    const filters = graphic ? [base] : [base, "eq=contrast=1.06:saturation=0.86:brightness=-0.015", "vignette=PI/5"];
    if (!graphic && shot.motion === "flow") {
      const reverse = shot.composition === "evidence-left";
      for (const [arrowIndex, y] of [180, 320, 460, 600, 740, 880].entries()) {
        const phase = arrowIndex * 350;
        const x = reverse ? `w-mod(t*360+${phase}\\,w+520)` : `mod(t*360+${phase}\\,w+520)-520`;
        filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='›  ›  ›':x='${x}':y=${y}:fontsize=108:fontcolor=${plan.theme.signal}@0.68:shadowcolor=${plan.theme.background}:shadowx=5:shadowy=5`);
      }
    }
    if (!graphic && shot.title && (shot.composition === "evidence-left" || shot.composition === "evidence-right")) {
      const titleOnRight = shot.composition === "evidence-left";
      filters.push(`drawbox=x=${titleOnRight ? "iw-710" : "0"}:y=52:w=670:h=150:c=black@0.76:t=fill`);
      filters.push(`drawbox=x=${titleOnRight ? "iw-82" : "52"}:y=78:w=8:h=88:c=${plan.theme.accent}:t=fill`);
      filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(shot.graphic?.kicker ?? "CUT / EVIDENCE")}':x=${titleOnRight ? "w-tw-108" : "82"}:y=72:fontsize=32:fontcolor=${plan.theme.signal}`);
      filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.title)}':x=${titleOnRight ? "w-tw-108" : "82"}:y=119:fontsize=52:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=3:shadowy=3`);
    } else if (!graphic && shot.title && shot.composition === "minimal" && !shot.graphic?.metric) {
      const minimalTitleSize = Math.min(50, Math.max(34, 1_450 / Math.max(18, shot.title.length)));
      filters.push("drawbox=x=48:y=ih-310:w=720:h=140:c=black@0.74:t=fill");
      filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(shot.graphic?.kicker ?? "CUT / CONTEXT")}':x=78:y=h-286:fontsize=28:fontcolor=${plan.theme.signal}`);
      filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.title)}':x=78:y=h-240:fontsize=${minimalTitleSize}:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=3:shadowy=3`);
    } else if (!graphic && shot.title && shot.composition === "hero") {
      const heroTitleSize = Math.min(82, Math.max(52, 3400 / Math.max(20, shot.title.length)));
      filters.push("drawbox=x=0:y=ih-390:w=iw:h=390:c=black@0.70:t=fill");
      filters.push(`drawbox=x=80:y=ih-320:w=10:h=220:c=${plan.theme.accent}:t=fill`);
      filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(shot.graphic?.kicker ?? "CUT / FIELD EVIDENCE")}':x=120:y=h-315:fontsize=36:fontcolor=${plan.theme.signal}`);
      filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.title)}':x=120:y=h-235:fontsize=${heroTitleSize}:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=3:shadowy=3`);
      if (shot.subtitle) filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(shot.subtitle)}':x=122:y=h-135:fontsize=40:fontcolor=${plan.theme.signal}`);
    } else if (!graphic && shot.title && !(shot.composition === "minimal" && shot.graphic?.metric)) {
      filters.push("drawbox=x=0:y=0:w=iw:h=240:c=black@0.68:t=fill");
      filters.push(`drawbox=x=70:y=70:w=8:h=80:c=${plan.theme.accent}:t=fill`);
      filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='CUT / SOURCE ${String(index + 1).padStart(2, "0")}':x=94:y=72:fontsize=26:fontcolor=${plan.theme.muted}`);
      filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.title)}':x=94:y=112:fontsize=54:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=2:shadowy=2`);
    }
    if (!graphic && shot.subtitle && shot.composition !== "hero" && !(shot.composition === "minimal" && shot.graphic?.metric)) {
      const subtitleX = shot.composition === "evidence-left" ? "w-tw-108" : "96";
      filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(shot.subtitle)}':x=${subtitleX}:y=178:fontsize=34:fontcolor=${plan.theme.signal}`);
    }
    if (!graphic && shot.graphic?.metric) {
      const entrance = "min(max((t-0.35)/0.8\\,0)\\,1)";
      const overlaySize = Math.min(148, Math.max(76, 760 / Math.max(5, shot.graphic.metric.value.length) * 1.55));
      const onLeft = shot.composition === "evidence-left";
      const minimal = shot.composition === "minimal";
      const status = evidenceStatus(shot.graphic.metric.status, plan.theme.signal);
      if (minimal) {
        // A wide evidence lower third gives single-share footage a distinct
        // visual grammar from the opposing side-card compositions. Its value
        // and explanation own separate columns, and every measurement scales
        // with the export canvas while staying above the fixed citation rail.
        const uiScale = Math.max(.6, Math.min(1, plan.canvas.width / 1920, plan.canvas.height / 1080));
        const px = (value: number) => Math.round(value * uiScale);
        const citationRail = 106;
        const panelHeight = px(290);
        const entranceDistance = px(420);
        const boxY = `ih-${citationRail + panelHeight}+(1-${entrance})*${entranceDistance}`;
        const stagedEntrance = (delay: number) => `min(max((t-${delay})/0.55\\,0)\\,1)`;
        const y = (fromPanelBottom: number, delay: number) => `h-${citationRail + px(fromPanelBottom)}+(1-${stagedEntrance(delay)})*${px(56)}`;
        const boxElementY = (fromPanelBottom: number, delay: number) => `ih-${citationRail + px(fromPanelBottom)}+(1-${stagedEntrance(delay)})*${px(56)}`;
        const valueX = px(92); const contentX = px(620); const rightMargin = px(92);
        const contextFontSize = Math.max(29, px(44));
        const contextWidth = Math.max(24, Math.min(54, Math.floor((plan.canvas.width - contentX - rightMargin) / (contextFontSize * .58))));
        const contextParts = shot.graphic.metric.context?.split(/\s*·\s*/).filter(Boolean) ?? [];
        const contextLines = contextParts.length > 1
          ? [contextParts[0].toUpperCase(), contextParts.slice(1).map((part) => part.replace(/\bvia\b/gi, "→").toUpperCase()).join("  ·  ")]
          : shot.graphic.metric.context ? wrapText(shot.graphic.metric.context, contextWidth) : [];
        filters.push(`drawbox=x=${px(54)}:y='${boxY}':w=iw-${px(108)}:h=${panelHeight}:c=black@0.86:t=fill`);
        filters.push(`drawbox=x=${px(54)}:y='${boxY}':w=${Math.max(8, px(12))}:h=${panelHeight}:c=${plan.theme.accent}:t=fill`);
        filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.graphic.metric.value)}':x=${valueX}:y='${y(216, .8)}':fontsize=${Math.max(px(80), Math.round(overlaySize * uiScale))}:fontcolor=${plan.theme.accent}:shadowcolor=${plan.theme.background}:shadowx=4:shadowy=4`);
        filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.title ?? shot.graphic.metric.label)}':x=${contentX}:y='${y(212, .8)}':fontsize=${Math.max(30, px(42))}:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=3:shadowy=3`);
        filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.graphic.metric.label)}':x=${contentX}:y='${y(136, 1.15)}':fontsize=${Math.max(30, px(48))}:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=3:shadowy=3`);
        contextLines.forEach((line, lineIndex) => filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(line)}':x=${contentX}:y='${y(74 - lineIndex * 40, 1.5 + lineIndex * .32)}':fontsize=${contextFontSize}:fontcolor=${status.color}:shadowcolor=${plan.theme.background}:shadowx=2:shadowy=2`));
        const badgeWidth = px(340); const badgeHeight = px(52);
        const badgeBoxY = boxElementY(270, .48);
        filters.push(`drawbox=x=${contentX}:y='${badgeBoxY}':w=${badgeWidth}:h=${badgeHeight}:c=${status.color}@0.96:t=fill`);
        filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(status.label)}':x=${contentX + px(18)}:y='${y(262, .48)}':fontsize=${Math.max(24, px(36))}:fontcolor=${plan.theme.background}`);
      } else {
        if (onLeft) {
          // A horizontal proportion ribbon creates a distinct destination
          // grammar instead of mirroring the supplier side card.
          const ribbonX = `42-(1-${entrance})*1040`; const ribbonTextX = `74-(1-${entrance})*1040`; const contentX = `430-(1-${entrance})*1040`;
          const labelLines = wrapText(shot.graphic.metric.label, 32); const contextLines = shot.graphic.metric.context ? wrapText(shot.graphic.metric.context, 34) : [];
          const percentage = Number(shot.graphic.metric.value.match(/([0-9]+(?:\.[0-9]+)?)%/)?.[1] ?? 0) / 100;
          filters.push(`drawbox=x='${ribbonX}':y=560:w=980:h=330:c=black@0.88:t=fill`);
          filters.push(`drawbox=x='${ribbonTextX}':y=584:w=480:h=66:c=${status.color}@0.96:t=fill`);
          filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(status.label)}':x='${ribbonTextX}+20':y=594:fontsize=44:fontcolor=${plan.theme.background}`);
          filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.graphic.metric.value)}':x='${ribbonTextX}':y=672:fontsize=${overlaySize}:fontcolor=${plan.theme.accent}:shadowcolor=${plan.theme.background}:shadowx=4:shadowy=4`);
          labelLines.forEach((line, lineIndex) => filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(line)}':x='${contentX}':y=${662 + lineIndex * 52}:fontsize=48:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=3:shadowy=3`));
          contextLines.forEach((line, lineIndex) => filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(line)}':x='${contentX}':y=${770 + lineIndex * 46}:fontsize=42:fontcolor=${status.color}:shadowcolor=${plan.theme.background}:shadowx=2:shadowy=2`));
          if (percentage > 0) {
            filters.push(`drawbox=x='${contentX}':y=842:w=470:h=18:c=${plan.theme.muted}@0.35:t=fill`);
            filters.push(`drawbox=x='${contentX}':y=842:w=${Math.round(470 * percentage)}:h=18:c=${status.color}@0.96:t=fill`);
          }
        } else {
          const animatedBoxX = `iw-670+(1-${entrance})*680`; const animatedTextX = `w-tw-72+(1-${entrance})*680`; const cardTextX = `w-638+(1-${entrance})*680`;
          const labelLines = wrapText(shot.graphic.metric.label, 24); const contextLines = shot.graphic.metric.context ? wrapText(shot.graphic.metric.context, 22, 3) : [];
          filters.push(`drawbox=x='${animatedBoxX}':y=235:w=620:h=575:c=black@0.88:t=fill`);
          filters.push(`drawbox=x='iw-638+(1-${entrance})*680':y=262:w=430:h=66:c=${status.color}@0.96:t=fill`);
          filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(status.label)}':x='${cardTextX}':y=272:fontsize=44:fontcolor=${plan.theme.background}`);
          filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(shot.graphic.metric.value)}':x='${animatedTextX}':y=350:fontsize=${overlaySize}:fontcolor=${plan.theme.accent}:shadowcolor=${plan.theme.background}:shadowx=4:shadowy=4`);
          labelLines.forEach((line, lineIndex) => filters.push(`drawtext=fontfile=${plan.theme.fontFile}:expansion=none:text='${drawText(line)}':x='${cardTextX}':y=${500 + lineIndex * 52}:fontsize=46:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=3:shadowy=3`));
          contextLines.forEach((line, lineIndex) => filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(line)}':x='${cardTextX}':y=${626 + lineIndex * 48}:fontsize=44:fontcolor=${status.color}:shadowcolor=${plan.theme.background}:shadowx=2:shadowy=2`));
        }
      }
    }
    if (!graphic && shot.citations?.[0]) {
      const mediaMetric = shot.graphic?.metric;
      const visualCitation = `VISUAL · ${conciseDisplay(shot.citations[0].label, 44)}`;
      const dataCitation = mediaMetric ? `DATA · ${conciseDisplay(mediaMetric.sourceLabel ?? (shot.citations.slice(1).map((citation) => citation.label).join(" · ") || "LOCKED SOURCE"), 34)}` : undefined;
      filters.push("drawbox=x=0:y=ih-106:w=iw:h=86:c=black@0.9:t=fill");
      if (dataCitation) {
        filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(visualCitation)}':x=60:y=h-th-44:fontsize=44:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=2:shadowy=2`);
        filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(dataCitation)}':x=w-tw-60:y=h-th-44:fontsize=44:fontcolor=${evidenceStatus(mediaMetric?.status, plan.theme.signal).color}:shadowcolor=${plan.theme.background}:shadowx=2:shadowy=2`);
      } else filters.push(`drawtext=fontfile=${plan.theme.monoFontFile}:expansion=none:text='${drawText(visualCitation)}':x=w-tw-60:y=h-th-44:fontsize=44:fontcolor=${plan.theme.foreground}:shadowcolor=${plan.theme.background}:shadowx=2:shadowy=2`);
    }
    filters.push("fade=t=in:st=0:d=0.18", `fade=t=out:st=${Math.max(0, shot.duration - .18)}:d=0.18`, "format=yuv420p");
    const args = kind === "image"
      ? ["-y", "-v", "error", "-framerate", String(plan.canvas.fps), "-loop", "1", "-t", String(shot.duration), "-i", input]
      : ["-y", "-v", "error", "-ss", String(shot.start ?? 0), "-t", String(shot.duration), "-i", input];
    // Multiple drawtext layers over zoompan can corrupt glyph caches when the
    // filter graph is frame-threaded. A single filter thread is deterministic
    // and keeps typography intact; encoding itself remains multithreaded.
    args.push("-an", "-filter_threads", "1", "-vf", filters.join(","), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", output);
    await command("ffmpeg", args);
    parts.push(output);
  }

  const concat = join(work, "visuals.txt");
  await writeFile(concat, parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n"));
  const visuals = join(work, "visuals.mp4");
  await command("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concat, "-c", "copy", visuals]);

  const renderedNarration: Array<ProductionNarration & { duration: number }> = [];
  for (const [index, item] of (plan.narration ?? []).entries()) {
    const audio = join(work, `voice-${String(index).padStart(4, "0")}.aiff`);
    const rawAudio = join(work, `voice-raw-${String(index).padStart(4, "0")}.aiff`);
    if (item.audio) {
      const supplied = resolveProjectPath(root, item.audio);
      await ensureFile(supplied, "narration audio");
      await command("ffmpeg", ["-y", "-v", "error", "-i", supplied, "-ar", "48000", "-ac", "2", rawAudio]);
    } else {
      await command("say", ["-v", item.voice ?? plan.audio?.narrationVoice ?? "Daniel", "-r", String(item.rate ?? plan.audio?.narrationRate ?? 168), "-o", rawAudio, item.text]);
    }
    let audioDuration = await duration(rawAudio);
    if (!Number.isFinite(audioDuration) || audioDuration <= 0) throw new Error(`Narration ${index + 1} produced no audio. Supply narration.audio or configure a working speech adapter.`);
    const nextStart = plan.narration?.[index + 1]?.start ?? totalDuration;
    const available = Math.max(.25, nextStart - item.start - .12);
    if (audioDuration > available) {
      const tempo = audioDuration / available;
      if (tempo > 2) throw new Error(`Narration ${index + 1} is ${tempo.toFixed(2)}x too long for its editorial window; shorten the script instead of making speech unintelligible.`);
      await command("ffmpeg", ["-y", "-v", "error", "-i", rawAudio, "-af", `atempo=${tempo.toFixed(6)}`, "-ar", "48000", "-ac", "2", audio]);
      audioDuration = await duration(audio);
    } else await copyFile(rawAudio, audio);
    renderedNarration.push({ ...item, duration: audioDuration });
  }

  const masterName = plan.output?.filename ?? `${plan.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`;
  const master = join(out, basename(masterName));
  let mixed: string | undefined;
  if (renderedNarration.length) {
    const voiceFiles = renderedNarration.map((_, index) => join(work, `voice-${String(index).padStart(4, "0")}.aiff`));
    const filters = renderedNarration.map((item, index) => `[${index}:a]aresample=48000,adelay=${Math.round(item.start * 1000)}|${Math.round(item.start * 1000)}[v${index}]`).join(";");
    const labels = renderedNarration.map((_, index) => `[v${index}]`).join("");
    const voice = join(work, "voice.wav");
    await command("ffmpeg", ["-y", "-v", "error", ...voiceFiles.flatMap((path) => ["-i", path]), "-filter_complex", `${filters};${labels}amix=inputs=${renderedNarration.length}:normalize=0,apad=whole_dur=${totalDuration},atrim=0:${totalDuration},loudnorm=I=${plan.audio?.dialogueLufs ?? -16}:LRA=7:TP=${plan.audio?.truePeakDb ?? -1.5}[voice]`, "-map", "[voice]", "-ar", "48000", voice]);
    mixed = voice;
    const music = plan.audio?.music;
    if (music) {
      const score = join(work, "score.wav");
      const harmonics = music.frequencies.map((frequency, index) => `${index ? "+" : ""}${1 / (index + 1)}*sin(2*PI*${frequency}*t)`).join("");
      let editCursor = 0;
      const editPoints = plan.shots.slice(0, -1).map((shot) => { editCursor += shot.duration; return editCursor; });
      const impacts = music.impactOnCuts ? editPoints.slice(0, 100).map((at) => `+.18*sin(2*PI*52*(t-${at}))*exp(-7*(t-${at}))*between(t,${at},${at + .7})+.025*sin(2*PI*210*(t-${at}))*exp(-18*(t-${at}))*between(t,${at},${at + .25})`).join("") : "";
      // A slowly breathing harmonic bed plus restrained edit impacts gives the
      // score structure without requiring copyrighted or opaque music assets.
      const expression = `(.62+.08*sin(2*PI*.07*t))*(${harmonics})${impacts}`;
      await command("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `aevalsrc='${expression}':s=48000:d=${totalDuration}`, "-af", `lowpass=f=520,volume=${music.volume},afade=t=in:st=0:d=${music.fadeIn ?? 3},afade=t=out:st=${Math.max(0, totalDuration - (music.fadeOut ?? 5))}:d=${music.fadeOut ?? 5}`, score]);
      mixed = join(work, "mix.m4a");
      await command("ffmpeg", ["-y", "-v", "error", "-i", voice, "-i", score, "-filter_complex", `[1:a][0:a]sidechaincompress=threshold=.025:ratio=8:attack=15:release=500[ducked];[0:a][ducked]amix=inputs=2:weights='1 0.8':normalize=0,loudnorm=I=${plan.audio?.masterLufs ?? -14}:LRA=8:TP=${plan.audio?.truePeakDb ?? -1.2},aformat=channel_layouts=stereo[a]`, "-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ac", "2", mixed]);
    }
  }

  const subtitlePath = join(out, masterName.replace(/\.[^.]+$/, ".en.srt"));
  const subtitleText = plan.captions?.enabled && renderedNarration.length ? captions(renderedNarration) : "";
  if (subtitleText) await writeFile(subtitlePath, subtitleText);
  const args = ["-y", "-v", "error", "-i", visuals];
  if (mixed) args.push("-i", mixed);
  if (subtitleText && plan.captions?.burn !== false) {
    const escaped = subtitlePath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
    args.push("-vf", `subtitles=filename='${escaped}':force_style='FontName=Arial,FontSize=${plan.captions?.fontSize ?? 18},PrimaryColour=&H00F5F1E6,OutlineColour=&H00101010,BackColour=&H90000000,BorderStyle=3,Outline=7,Shadow=0,Alignment=2,MarginV=${plan.captions?.margin ?? 44}'`);
  }
  args.push("-map", "0:v:0");
  if (mixed) args.push("-map", "1:a:0");
  args.push("-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-preset", "medium", "-crf", "17");
  if (mixed) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
  args.push("-movflags", "+faststart", "-shortest", master);
  await command("ffmpeg", args, 600_000);

  const manifest: ProductionManifest = {
    format: "cut-production-manifest", version: 1, title: plan.title, duration: totalDuration, planHash: hash(plan),
    export: { file: basename(master), ...plan.canvas, video: "H.264 High / CRF 17", audio: mixed ? `AAC 192 kbps / ${plan.audio?.masterLufs ?? -14} LUFS target` : "none" },
    sources: await Promise.all(sources.map(async (source) => ({ file: source, sha256: await sha256(resolvedSources.get(source)!) }))),
    shots: plan.shots.map((shot, index) => ({ order: index + 1, ...shot })), narration: renderedNarration,
  };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { master, subtitle: subtitleText ? subtitlePath : undefined, manifest };
}
