import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCut } from "../parser";
import { runCodex } from "../core/planner";
import type { ProductionPlan, ProductionTheme } from "./types";
import type { ResearchPack } from "../research/types";

type ResearchSegment = {
  sourceLine: number;
  kind: "title" | "metric" | "chart" | "timeline" | "map" | "flow-map" | "network" | "causal-map" | "image" | "video";
  kicker: string;
  title: string;
  subtitle: string;
  narration: string;
  claimIds: string[];
  seriesId: string;
  timelineId: string;
  metricId: string;
  metricIds: string[];
  overlayMetricId: string;
  locationIds: string[];
  routes: Array<{ fromId: string; toId: string; label: string }>;
  assetId: string;
  cutawayAssetIds: string[];
  rationale: string;
};

export type ResearchDirection = { title: string; segments: ResearchSegment[] };

export function normalizeResearchDirection(direction: ResearchDirection, pack?: ResearchPack): ResearchDirection {
  return { ...direction, segments: direction.segments.map((segment) => ({
    ...segment,
    seriesId: segment.kind === "chart" ? segment.seriesId : "",
    timelineId: ["timeline", "causal-map"].includes(segment.kind) ? segment.timelineId : "",
    metricId: ["metric", "flow-map", "causal-map"].includes(segment.kind) ? segment.metricId : "",
    metricIds: segment.kind === "network" ? segment.metricIds : [],
    overlayMetricId: ["image", "video"].includes(segment.kind) && (!pack || (pack.metrics ?? []).some((item) => item.id === segment.overlayMetricId)) ? segment.overlayMetricId : "",
    locationIds: ["map", "flow-map", "network", "causal-map"].includes(segment.kind) ? segment.locationIds : [],
    routes: ["map", "flow-map", "network", "causal-map"].includes(segment.kind) ? segment.routes : [],
    assetId: ["image", "video"].includes(segment.kind) ? segment.assetId : "",
  })) };
}

export const researchDirectionSchema = {
  type: "object", additionalProperties: false, required: ["title", "segments"], properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    segments: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
      required: ["sourceLine", "kind", "kicker", "title", "subtitle", "narration", "claimIds", "seriesId", "timelineId", "metricId", "metricIds", "overlayMetricId", "locationIds", "routes", "assetId", "cutawayAssetIds", "rationale"], properties: {
        sourceLine: { type: "integer", minimum: 1 }, kind: { type: "string", enum: ["title", "metric", "chart", "timeline", "map", "flow-map", "network", "causal-map", "image", "video"] },
        kicker: { type: "string", minLength: 1, maxLength: 80 }, title: { type: "string", minLength: 1, maxLength: 160 }, subtitle: { type: "string", maxLength: 240 },
        narration: { type: "string", minLength: 1, maxLength: 5_000 }, claimIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 80 } },
        metricId: { type: "string", maxLength: 80 },
        metricIds: { type: "array", maxItems: 5, items: { type: "string", maxLength: 80 } },
        overlayMetricId: { type: "string", maxLength: 80 },
        seriesId: { type: "string", maxLength: 80 }, timelineId: { type: "string", maxLength: 80 }, locationIds: { type: "array", maxItems: 30, items: { type: "string", maxLength: 80 } },
        routes: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["fromId", "toId", "label"], properties: { fromId: { type: "string", maxLength: 80 }, toId: { type: "string", maxLength: 80 }, label: { type: "string", maxLength: 120 } } } },
        assetId: { type: "string", maxLength: 80 },
        cutawayAssetIds: { type: "array", maxItems: 2, items: { type: "string", maxLength: 80 } },
        rationale: { type: "string", minLength: 1, maxLength: 2_000 },
      },
    } },
  },
};

function requiredLines(source: string) {
  const parsed = parseCut(source);
  if (!parsed.program) throw new Error("Cannot compose an invalid CUT program.");
  return parsed.program.directives.filter((item) => item.kind === "hook" || item.kind === "beat").map((item) => item.line);
}

function normalizedMetricToken(value: string) {
  return value.toLowerCase().replace(/[~,\s]/g, "").replace(/[^\p{L}\p{N}.%]+/gu, "");
}

function conciseAssetLabel(value: string, maxCharacters = 34) {
  if (value.length <= maxCharacters) return value;
  const prefix = value.slice(0, maxCharacters - 1);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > maxCharacters * .62 ? boundary : undefined).trimEnd()}…`;
}

export function validateResearchDirection(direction: ResearchDirection, source: string, pack: ResearchPack) {
  const lines = requiredLines(source);
  if (!direction || !direction.title?.trim() || direction.title.length > 200 || !Array.isArray(direction.segments) || direction.segments.length !== lines.length) throw new Error("Research director returned an invalid title or segment count.");
  const claims = new Set(pack.claims.map((item) => item.id));
  const series = new Set(pack.series.map((item) => item.id));
  const timelines = new Set(pack.timelines.map((item) => item.id));
  const metrics = new Set((pack.metrics ?? []).map((item) => item.id));
  const locations = new Set(pack.locations.map((item) => item.id));
  const assets = new Map((pack.assets ?? []).map((item) => [item.id, item]));
  direction.segments.forEach((segment, index) => {
    const directive = parseCut(source).program!.directives.find((item) => item.line === lines[index])!;
    const duration = directive.kind === "hook" ? directive.before : directive.kind === "beat" ? directive.duration ?? 5 : 5;
    const wordCount = segment.narration.trim().split(/\s+/).length;
    const minimumWords = Math.ceil(duration * 1.1);
    const maximumWords = Math.floor(duration * 2.35);
    const asset = assets.get(segment.assetId);
    const cutaways = segment.cutawayAssetIds.map((id) => assets.get(id));
    const directiveQuery = directive.kind === "hook" || directive.kind === "beat" ? directive.query : "";
    const requiredName = directiveQuery.match(/\bname\s+(.+?)\s+in the title and first sentence\b/i)?.[1]?.trim();
    if (requiredName) {
      const firstSentence = segment.narration.split(/(?<=[.!?])\s/)[0] ?? segment.narration;
      if (!segment.title.toLowerCase().includes(requiredName.toLowerCase()) || !firstSentence.toLowerCase().includes(requiredName.toLowerCase())) throw new Error(`Segment on line ${lines[index]} must name "${requiredName}" in both its title and first narration sentence.`);
    }
    const asksQuestion = directive.kind === "hook" && /\b(?:ask|question|why|how|what|whether)\b/i.test(directiveQuery);
    if (asksQuestion && !segment.narration.trim().endsWith("?")) throw new Error(`Hook narration on line ${lines[index]} must be a direct question ending in '?' because the CUT intent asks a question.`);
    const requiresMedia = /\b(?:full-bleed|full-frame|real footage|real port image|real shipping evidence|real port-operation video|satellite traffic image)\b/i.test(directiveQuery);
    if (requiresMedia && !["image", "video"].includes(segment.kind)) throw new Error(`Segment on line ${lines[index]} must use image or video because the CUT intent explicitly requests full-bleed real-world media.`);
    if (/\breal\b[^.]*\bvideo\b/i.test(directiveQuery) && segment.kind !== "video") throw new Error(`Segment on line ${lines[index]} must use video because the CUT intent explicitly requests real video.`);
    const requiresCausalMap = !requiresMedia && /\bcausal map\b/i.test(directiveQuery);
    if (requiresCausalMap && segment.kind !== "causal-map") throw new Error(`Segment on line ${lines[index]} must use a causal map because the CUT intent explicitly combines geography with a causal chain.`);
    const requestedRouteCount = /\bthree\b[^.]*\broutes?\b/i.test(directiveQuery) ? 3 : /\btwo\b[^.]*\broutes?\b/i.test(directiveQuery) ? 2 : 0;
    if (requiresCausalMap && requestedRouteCount && segment.routes.length < requestedRouteCount) throw new Error(`Segment on line ${lines[index]} must include at least ${requestedRouteCount} routes because the CUT intent explicitly requests them.`);
    if (requiresCausalMap && /\b(?:quantified|measurable|cost estimate)\b/i.test(directiveQuery) && !segment.metricId) throw new Error(`Segment on line ${lines[index]} must bind a sourced metric because the causal map explicitly requests a quantified consequence.`);
    const requiresFlowMap = !requiresMedia && !requiresCausalMap && /\bflow map\b/i.test(directiveQuery);
    if (requiresFlowMap && (segment.kind !== "flow-map" || !segment.metricId || !segment.locationIds.length || !segment.routes.length)) throw new Error(`Segment on line ${lines[index]} must use a sourced flow map with a proportional metric and route.`);
    const requiresNetwork = !requiresMedia && !requiresCausalMap && !requiresFlowMap && /\b(?:convergence network|network diagram)\b/i.test(directiveQuery);
    if (requiresNetwork && (segment.kind !== "network" || segment.locationIds.length < 2 || segment.metricIds.length !== segment.locationIds.length || !segment.routes.length)) throw new Error(`Segment on line ${lines[index]} must use a sourced network with one metric per node and at least one directed edge.`);
    const requiresChart = !requiresMedia && !requiresCausalMap && !requiresFlowMap && !requiresNetwork && /\b(?:comparison chart|proportional comparison|ranked comparison|compare\b.*\bchokepoints)\b/i.test(directiveQuery);
    if (requiresChart && segment.kind !== "chart") throw new Error(`Segment on line ${lines[index]} must use a chart because the CUT intent explicitly requests a multi-value comparison.`);
    const requiresMetric = !requiresMedia && !requiresCausalMap && !requiresFlowMap && !requiresNetwork && !requiresChart && /\b(?:proportional|count graphic|unit count|metric graphic)\b/i.test(directiveQuery);
    if (requiresMetric && segment.kind !== "metric") throw new Error(`Segment on line ${lines[index]} must use a metric graphic because the CUT intent explicitly requests proportional or count evidence.`);
    const requiresMap = !requiresMedia && !requiresCausalMap && !requiresFlowMap && !requiresNetwork && !requiresChart && !requiresMetric && /\b(?:map|mapped)\b/i.test(directiveQuery);
    if (requiresMap && segment.kind !== "map") throw new Error(`Segment on line ${lines[index]} must use a map because the CUT intent explicitly requests one.`);
    const requiresOverlayMetric = requiresMedia && /\b(?:overlay|proportional|count graphic|unit count|metric graphic)\b/i.test(directiveQuery);
    if (requiresOverlayMetric && !segment.overlayMetricId) throw new Error(`Segment on line ${lines[index]} must use a sourced metric overlay on real media because the CUT intent combines evidence media with a quantitative graphic.`);
    const requestedMetricNumber = directiveQuery.match(/\b(\d+(?:\.\d+)?)\b/)?.[1];
    if ((requiresOverlayMetric || requiresFlowMap || requiresMetric) && requestedMetricNumber && !segment.narration.includes(requestedMetricNumber)) throw new Error(`Segment on line ${lines[index]} must speak the explicitly requested ${requestedMetricNumber} metric value so the evidence is understandable without reading small text.`);
    if (requiresMedia && !requiresOverlayMetric && segment.overlayMetricId) throw new Error(`Segment on line ${lines[index]} added an unrequested metric overlay; keep the real-world image visually clean.`);
    if (segment.overlayMetricId) {
      const value = pack.metrics?.find((item) => item.id === segment.overlayMetricId)?.value ?? "";
      const metricToken = normalizedMetricToken(value);
      const titleToken = normalizedMetricToken(segment.title);
      if (metricToken.length >= 3 && titleToken.includes(metricToken)) throw new Error(`Segment on line ${lines[index]} repeats the displayed metric value in its title; use the headline to explain the consequence instead.`);
    }
    if (["image", "video"].includes(segment.kind) && segment.title.length > (segment.overlayMetricId ? 36 : 52)) throw new Error(`Segment on line ${lines[index]} needs a shorter title so the real-world footage remains legible.`);
    if (!segment.claimIds?.length || segment.claimIds.some((id) => !claims.has(id))) throw new Error(`Segment on line ${lines[index]} selected an unknown or empty claim ID set.`);
    const selectedClaimSources = new Set(segment.claimIds.flatMap((id) => pack.claims.find((claim) => claim.id === id)!.sourceIds));
    const dataSourceIds = [
      ...(segment.seriesId ? pack.series.find((item) => item.id === segment.seriesId)?.sourceIds ?? [] : []),
      ...(segment.metricId ? pack.metrics?.find((item) => item.id === segment.metricId)?.sourceIds ?? [] : []),
      ...segment.metricIds.flatMap((metricId) => pack.metrics?.find((item) => item.id === metricId)?.sourceIds ?? []),
      ...(segment.overlayMetricId ? pack.metrics?.find((item) => item.id === segment.overlayMetricId)?.sourceIds ?? [] : []),
      ...segment.locationIds.flatMap((id) => pack.locations.find((item) => item.id === id)?.sourceIds ?? []),
    ];
    if (dataSourceIds.some((id) => !selectedClaimSources.has(id))) throw new Error(`Segment on line ${lines[index]} selected structured evidence whose provenance is not covered by its claim IDs.`);
    if (segment.timelineId) {
      const eventClaims = pack.timelines.find((item) => item.id === segment.timelineId)?.events.flatMap((event) => event.claimIds) ?? [];
      if (eventClaims.some((id) => !segment.claimIds.includes(id))) throw new Error(`Segment on line ${lines[index]} must include every claim used by its timeline events.`);
    }
    if (cutaways.some((item) => !item) || new Set(segment.cutawayAssetIds).size !== segment.cutawayAssetIds.length || segment.cutawayAssetIds.includes(segment.assetId)) throw new Error(`Segment on line ${lines[index]} selected an unknown, duplicate, or self-referential cutaway asset.`);
    const motionCutaways = /\bmotion cutaways?\b/i.test(directiveQuery);
    const twoMotionCutaways = /\btwo motion cutaways?\b/i.test(directiveQuery);
    if (motionCutaways && (segment.cutawayAssetIds.length < (twoMotionCutaways ? 2 : 1) || cutaways.some((item) => item?.kind !== "video"))) throw new Error(`Segment on line ${lines[index]} must use ${twoMotionCutaways ? "two" : "at least one"} real video cutaway because the CUT intent explicitly requests motion cutaways.`);
    if (/\bstill evidence cutaway\b/i.test(directiveQuery) && (segment.cutawayAssetIds.length < 1 || cutaways.some((item) => item?.kind !== "image"))) throw new Error(`Segment on line ${lines[index]} must use a real image cutaway because the CUT intent explicitly requests still evidence.`);
    if (segment.cutawayAssetIds.length > 1 && duration < 8) throw new Error(`Segment on line ${lines[index]} cannot fit two cutaways into ${duration}s while preserving an inspectable primary visual; select at most one.`);
    if (!segment || segment.sourceLine !== lines[index] || !["title", "metric", "chart", "timeline", "map", "flow-map", "network", "causal-map", "image", "video"].includes(segment.kind) || !segment.kicker?.trim() || !segment.title?.trim() || !segment.narration?.trim() || !segment.rationale?.trim() ||
      segment.locationIds.some((id) => !locations.has(id)) ||
      segment.routes.some((route) => !locations.has(route.fromId) || !locations.has(route.toId)) ||
      (segment.kind === "chart" ? !series.has(segment.seriesId) : segment.seriesId !== "") ||
      (["timeline", "causal-map"].includes(segment.kind) ? !timelines.has(segment.timelineId) : segment.timelineId !== "") ||
      (segment.kind === "metric" || segment.kind === "flow-map" ? !metrics.has(segment.metricId) : segment.kind === "causal-map" ? segment.metricId !== "" && !metrics.has(segment.metricId) : segment.metricId !== "") ||
      (segment.kind === "network" ? segment.metricIds.length !== segment.locationIds.length || new Set(segment.metricIds).size !== segment.metricIds.length || segment.metricIds.some((id) => !metrics.has(id)) : segment.metricIds.length > 0) ||
      (["image", "video"].includes(segment.kind) ? segment.overlayMetricId !== "" && !metrics.has(segment.overlayMetricId) : segment.overlayMetricId !== "") ||
      (["map", "flow-map", "network", "causal-map"].includes(segment.kind) ? !segment.locationIds.length : segment.locationIds.length > 0 || segment.routes.length > 0) ||
      (["image", "video"].includes(segment.kind) ? !asset || asset.kind !== segment.kind : segment.assetId !== "") ||
      wordCount > maximumWords || wordCount < minimumWords) throw new Error(`Research director returned invalid grounded data or ${wordCount}-word narration outside the ${minimumWords}-${maximumWords} word budget for ${duration}s on line ${lines[index]}. Selection: kind=${segment.kind}, series=${segment.seriesId || "-"}, timeline=${segment.timelineId || "-"}, metric=${segment.metricId || "-"}, asset=${segment.assetId || "-"}, locations=${segment.locationIds.length}, routes=${segment.routes.length}.`);
    if (segment.kind === "causal-map" && (segment.locationIds.length > 6 || segment.routes.length > 3)) throw new Error(`Causal map on line ${lines[index]} exceeds the legibility budget of six locations and three routes; select only the geography needed to explain the causal chain.`);
  });
  const selectedAssets = direction.segments.flatMap((segment) => [segment.assetId, ...segment.cutawayAssetIds]).filter(Boolean);
  if (new Set(selectedAssets).size !== selectedAssets.length) throw new Error("Research director repeated a documentary asset; each locked image or video may be used at most once.");
  const minimumAssets = Math.min(assets.size, Math.ceil(lines.length * .25));
  if (assets.size && selectedAssets.length < minimumAssets) throw new Error(`Research director used ${selectedAssets.length} real-world assets; this ${lines.length}-beat film requires at least ${minimumAssets} for visual texture.`);
  if ([...assets.values()].some((asset) => asset.kind === "video") && !selectedAssets.some((id) => assets.get(id)?.kind === "video")) throw new Error("Research director ignored all available video assets; use at least one vetted motion source.");
  const primaryMedia = direction.segments.filter((segment) => ["image", "video"].includes(segment.kind)).length;
  if (assets.size >= 5 && primaryMedia < 3 && direction.segments.reduce((sum, segment) => sum + segment.cutawayAssetIds.length, 0) < 2) throw new Error("Research director needs either three primary real-media scenes or two cutaways to avoid a one-beat/one-slide rhythm.");
  return direction;
}

function prompt(source: string, pack: ResearchPack) {
  return `You are CUT's source-grounded documentary director. Create exactly one visual segment for every hook or beat line, in line order. Use only IDs in the locked research pack. Every narration sentence must be directly supported by the segment's claimIds. Never add a number, date, causal claim, name, coordinate, route, or comparison absent from those claims/data IDs. Obey explicit naming instructions in both the title and first narration sentence. Obey primary visual precedence: full-bleed/full-frame/real media requires image or video; when that same line requests proportional, count, metric, or overlay evidence, keep the media primary, bind overlayMetricId, speak any explicitly requested numeric value and its denominator, and use a punchy title no longer than 36 characters that does not repeat the displayed metric value; explicit real video requires video. Causal map requires causal-map plus a valid timeline and no more than six locations and three routes; include the requested number of routes, select only the geography essential to the causal explanation, and bind metricId when the line asks for a quantified consequence. Proportional flow map requires flow-map with one sourced metric and the minimum locations/routes needed to show direction; speak an explicitly requested value and its denominator. A convergence network requires network, two to five ordered locationIds, the same number of ordered metricIds, and directed routes connecting them; each metric must describe its corresponding node. The network narration must explain the relationship or resulting vulnerability without restating the metric values already spoken in earlier beats. Comparison chart, proportional comparison, ranked comparison, or compare-chokepoints requires chart; a single proportional share, count graphic, unit count, or metric graphic without requested real media requires metric; map or mapped requires map. Question hooks must end in '?'. Choose only valid locked IDs for the selected kind. Motion cutaway means a video in cutawayAssetIds; still evidence cutaway means an image in cutawayAssetIds. Reserve enough videos for explicit primary-video beats. A segment may select up to two unique cutawayAssetIds; never reuse any asset. Empty irrelevant fields. Prefer sustained full-frame evidence over brief inserts; alternate real-world assets with maps and charts. Narration should normally use 1.2-2.05 words per declared second and has a hard maximum of 2.35; count every word and leave breathing room after major claims. Optimize for a rigorous 60-90 second causal explainer: short sentences, visual contrast, escalating stakes, no repetition, no hype, no commands/code/URLs/markdown.\n\nCUT PROGRAM\n${source}\n\nREQUIRED LINES\n${requiredLines(source).join(", ")}\n\nLOCKED RESEARCH PACK\n${JSON.stringify(pack)}`;
}

export async function composeWithCodex(source: string, pack: ResearchPack) {
  const directory = await mkdtemp(join(tmpdir(), "cut-research-direct-"));
  const schemaPath = join(directory, "schema.json"); const outputPath = join(directory, "direction.json");
  await writeFile(schemaPath, JSON.stringify(researchDirectionSchema));
  try {
    let instruction = prompt(source, pack);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await runCodex(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-5.6-luna", "--config", `model_reasoning_effort=\"${attempt === 1 ? "high" : "medium"}\"`, "--output-schema", schemaPath, "-o", outputPath, instruction], directory);
      const raw = await readFile(outputPath, "utf8");
      try { return validateResearchDirection(normalizeResearchDirection(JSON.parse(raw) as ResearchDirection, pack), source, pack); }
      catch (error) {
        lastError = error;
        instruction = `${prompt(source, pack)}\n\nThe previous structured direction failed deterministic validation. Correct it without weakening evidence or changing segment count. VALIDATION ERROR: ${error instanceof Error ? error.message : String(error)}\nPREVIOUS DIRECTION:\n${raw}`;
      }
    }
    throw lastError;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function lowerResearchDirection(direction: ResearchDirection, source: string, pack: ResearchPack, theme: ProductionTheme): ProductionPlan {
  const parsed = parseCut(source);
  if (!parsed.program) throw new Error("Cannot lower an invalid CUT program.");
  const shotGroups = direction.segments.map((segment, segmentIndex) => {
    const directive = parsed.program!.directives.find((item) => item.line === segment.sourceLine)!;
    const duration = directive.kind === "hook" ? directive.before : directive.kind === "beat" ? directive.duration ?? 5 : 5;
    const graphic: NonNullable<ProductionPlan["shots"][number]["graphic"]> = { kicker: segment.kicker };
    if (segment.kind === "chart") {
      const item = pack.series.find((series) => series.id === segment.seriesId)!;
      graphic.chart = { labels: item.labels, values: item.values, unit: item.unit, context: item.title, highlight: item.highlight };
    } else if (segment.kind === "metric" || segment.kind === "flow-map" || segment.kind === "causal-map" && segment.metricId) {
      const item = pack.metrics!.find((metric) => metric.id === segment.metricId)!;
      graphic.metric = { value: item.value, label: item.label, context: item.context, method: item.method, sourceLabel: item.sourceIds.map((id) => pack.sources.find((source) => source.id === id)?.shortLabel ?? pack.sources.find((source) => source.id === id)?.publisher ?? id).join(" · "), status: item.status };
    }
    if (["timeline", "causal-map"].includes(segment.kind)) graphic.timeline = { events: pack.timelines.find((timeline) => timeline.id === segment.timelineId)!.events.map((event) => ({ date: event.date, label: event.label })) };
    if (segment.kind === "network") {
      graphic.network = {
        nodes: segment.locationIds.map((id, index) => {
          const location = pack.locations.find((item) => item.id === id)!; const metric = pack.metrics!.find((item) => item.id === segment.metricIds[index])!;
          return { id, label: location.label, metric: { value: metric.value, label: metric.label, context: metric.context, method: metric.method, sourceLabel: metric.sourceIds.map((sourceId) => pack.sources.find((source) => source.id === sourceId)?.shortLabel ?? pack.sources.find((source) => source.id === sourceId)?.publisher ?? sourceId).join(" · "), status: metric.status } };
        }),
        edges: segment.routes.map((route) => ({ fromId: route.fromId, toId: route.toId, label: route.label })),
      };
    }
    if (["map", "flow-map", "causal-map"].includes(segment.kind)) {
      graphic.map = {
        points: segment.locationIds.map((id, index) => { const location = pack.locations.find((item) => item.id === id)!; return { latitude: location.latitude, longitude: location.longitude, label: location.label, emphasis: index === segment.locationIds.length - 1 }; }),
        routes: segment.routes.map((route) => { const from = pack.locations.find((item) => item.id === route.fromId)!; const to = pack.locations.find((item) => item.id === route.toId)!; return { from: [from.latitude, from.longitude], to: [to.latitude, to.longitude], label: route.label }; }),
      };
    }
    const sourceIds = [...new Set(segment.claimIds.flatMap((claimId) => pack.claims.find((claim) => claim.id === claimId)!.sourceIds))];
    const asset = ["image", "video"].includes(segment.kind) ? pack.assets!.find((item) => item.id === segment.assetId)! : undefined;
    if (segment.overlayMetricId) {
      const item = pack.metrics!.find((metric) => metric.id === segment.overlayMetricId)!;
      graphic.metric = { value: item.value, label: item.label, context: item.context, method: item.method, sourceLabel: item.sourceIds.map((id) => pack.sources.find((source) => source.id === id)?.shortLabel ?? pack.sources.find((source) => source.id === id)?.publisher ?? id).join(" · "), status: item.status };
    }
    const citations = sourceIds.map((id) => { const item = pack.sources.find((source) => source.id === id)!; return { label: item.shortLabel ?? item.publisher, url: item.url }; });
    if (asset) {
      const source = pack.sources.find((item) => item.id === asset.sourceIds[0])!;
      citations.unshift({ label: `${asset.usage === "illustrative" ? "ILLUSTRATIVE · " : ""}${asset.creator ?? source.publisher} · ${asset.license ?? "source"}`, url: source.url });
    }
    // Evidence cutaways need enough screen time to be perceived and inspected,
    // while remaining subordinate to the beat's primary visual.
    const cutDuration = segment.cutawayAssetIds.length ? Math.min(3.8, Math.max(3.2, duration * .35), (duration - 3.5) / segment.cutawayAssetIds.length) : 0;
    const query = directive.kind === "hook" || directive.kind === "beat" ? directive.query : "";
    const motion = ["image", "video"].includes(segment.kind) && /\b(?:directional flow|flow motion)\b/i.test(query) ? "flow" as const : segment.kind === "image" ? (segmentIndex % 2 ? "pull" as const : "push" as const) : segment.kind === "video" ? "source" as const : "reveal" as const;
    const composition = /\bleft-anchored\b/i.test(query) ? "evidence-left" as const : /\bright-anchored\b/i.test(query) ? "evidence-right" as const : /\bminimal(?:ist)?\b/i.test(query) ? "minimal" as const : /\b(?:full-bleed|full-frame)\b/i.test(query) ? "hero" as const : "editorial" as const;
    // Structured graphics and evidence overlays already own their status,
    // period, denominator, method, and source in dedicated high-contrast
    // regions. Repeating that material as a subtitle creates mobile-illegible
    // microcopy without adding evidence.
    const structuredEvidenceOwnsQualifier = ["metric", "chart", "flow-map", "network", "causal-map"].includes(segment.kind) || Boolean(segment.overlayMetricId) || composition === "hero";
    const primary = { kind: segment.kind, source: asset?.file, start: asset?.start, crop: asset?.crop, duration: duration - cutDuration * segment.cutawayAssetIds.length, title: segment.title, subtitle: structuredEvidenceOwnsQualifier ? undefined : segment.subtitle || undefined, motion, composition, citations, graphic: ["image", "video"].includes(segment.kind) && !segment.overlayMetricId ? undefined : graphic };
    const secondary = segment.cutawayAssetIds.map((id, cutawayIndex) => {
      const item = pack.assets!.find((candidate) => candidate.id === id)!;
      const source = pack.sources.find((candidate) => candidate.id === item.sourceIds[0])!;
      return { kind: item.kind, source: item.file, start: item.start, crop: item.crop, duration: cutDuration, title: conciseAssetLabel(item.label), composition: "minimal" as const, motion: item.kind === "image" ? ((segmentIndex + cutawayIndex) % 2 ? "pull" as const : "push" as const) : "source" as const, citations: [{ label: `${item.usage === "illustrative" ? "ILLUSTRATIVE · " : ""}${item.creator ?? source.publisher} · ${item.license ?? "source"}`, url: source.url }] };
    });
    return [primary, ...secondary];
  });
  const shots = shotGroups.flat();
  let cursor = 0;
  const narration = direction.segments.map((segment, index) => { const start = cursor + .45; cursor += shotGroups[index].reduce((sum, shot) => sum + shot.duration, 0); return { start, text: segment.narration }; });
  const target = parsed.program.exports[0] ?? { width: 1920, height: 1080 };
  return { format: "cut-production", version: 1, title: direction.title, canvas: { width: target.width, height: target.height, fps: 30 }, theme, shots, narration,
    audio: { narrationVoice: "Reed (English (UK))", narrationRate: 174, dialogueLufs: -16, masterLufs: -14, truePeakDb: -1.2, music: { kind: "procedural-tone", frequencies: [55, 82.41, 110], volume: .13, fadeIn: 2, fadeOut: 4, impactOnCuts: true } },
    captions: { enabled: true, burn: false, fontSize: 14, margin: 38 }, output: { filename: `${direction.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4` } };
}
