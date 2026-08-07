import type { ProductionPlan, ProductionShot } from "./types";
import { geoInterpolate, geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import countries from "world-atlas/countries-110m.json";

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function text(x: number, y: number, value: string, size: number, color: string, weight = 500, anchor = "start", stroke = "#071015") {
  return `<text x="${x}" y="${y}" fill="${color}" stroke="${stroke}" stroke-width="${Math.max(2, size * .075)}" stroke-linejoin="round" paint-order="stroke fill" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${xml(value)}</text>`;
}

function wrappedText(x: number, y: number, value: string, maxCharacters: number, size: number, color: string, weight = 500, anchor = "start", maxLines = 2) {
  const words = value.trim().split(/\s+/); const lines: string[] = [];
  for (const word of words) {
    const candidate = lines.length ? `${lines.at(-1)} ${word}` : word;
    if (!lines.length || candidate.length > maxCharacters) lines.push(word); else lines[lines.length - 1] = candidate;
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (`${last}…`.length > maxCharacters && last.length > 1) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return lines.map((line, index) => text(x, y + index * size * 1.08, line, size, color, weight, anchor)).join("");
}

function evidenceStatus(status: string | undefined, signal: string) {
  if (status === "reported") return { label: "REPORTED DATA", short: "REPORTED", color: signal };
  if (status === "estimated") return { label: "SOURCE ESTIMATE", short: "ESTIMATE", color: "#ffd166" };
  if (status === "derived") return { label: "DERIVED VALUE", short: "DERIVED", color: "#ffd166" };
  if (status === "modeled") return { label: "SCENARIO MODEL", short: "MODEL", color: "#79c7ff" };
  return { label: "SOURCED", short: "SOURCED", color: signal };
}

function header(shot: ProductionShot, plan: ProductionPlan) {
  const { width } = plan.canvas;
  const theme = plan.theme;
  return [
    `<rect x="72" y="68" width="8" height="76" fill="${theme.accent}"/>`,
    shot.graphic?.kicker ? text(104, 88, shot.graphic.kicker.toUpperCase(), 36, theme.foreground, 750) : "",
    shot.title ? text(104, 154, shot.title, Math.min(78, Math.max(62, width / Math.max(15, shot.title.length))), theme.foreground, 750) : "",
    shot.subtitle ? text(106, 210, shot.subtitle, 40, theme.signal, 650) : "",
  ].join("");
}

function footer(shot: ProductionShot, plan: ProductionPlan) {
  const label = shot.citations?.map((citation) => citation.label).join("  ·  ");
  return label ? text(plan.canvas.width - 76, plan.canvas.height - 34, `SOURCE · ${label}`, 48, plan.theme.foreground, 700, "end") : "";
}

function base(plan: ProductionPlan, contents: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.canvas.width}" height="${plan.canvas.height}" viewBox="0 0 ${plan.canvas.width} ${plan.canvas.height}">
  <defs><radialGradient id="bg"><stop offset="0" stop-color="#172126"/><stop offset="1" stop-color="${plan.theme.background}"/></radialGradient></defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <g opacity=".12" stroke="${plan.theme.muted}">${Array.from({ length: 12 }, (_, i) => `<line x1="${i * plan.canvas.width / 11}" y1="0" x2="${i * plan.canvas.width / 11}" y2="${plan.canvas.height}"/>`).join("")}${Array.from({ length: 8 }, (_, i) => `<line x1="0" y1="${i * plan.canvas.height / 7}" x2="${plan.canvas.width}" y2="${i * plan.canvas.height / 7}"/>`).join("")}</g>
  ${contents}</svg>`;
}

function chart(shot: ProductionShot, plan: ProductionPlan, progress: number) {
  const data = shot.graphic?.chart;
  if (!data) throw new Error("Chart shot is missing graphic.chart data.");
  const { width, height } = plan.canvas;
  // Charts use a light analytical canvas, creating a deliberate texture break
  // from geographic maps and cinematic footage while preserving the theme's
  // signal/accent hierarchy.
  const paper = "#e9e5d8", ink = "#111b20", teal = "#176b73", grid = "#aaa79e";
  const left = 120, top = 430, bottom = height - 155, right = width - 100;
  const max = Math.max(...data.values.map(Math.abs), 1);
  const gap = (right - left) / data.values.length;
  const bar = Math.min(130, gap * .58);
  const marks = data.values.map((value, index) => {
    const local = Math.max(0, Math.min(1, progress * data.values.length - index));
    const h = Math.abs(value) / max * (bottom - top) * (1 - (1 - local) ** 3);
    const x = left + gap * index + (gap - bar) / 2;
    const y = bottom - h;
    const color = index === data.highlight ? plan.theme.accent : teal;
    const pulse = index === data.highlight ? .45 + .55 * Math.sin(progress * Math.PI * 8) ** 2 : 0;
    return `<rect x="${x}" y="${y}" width="${bar}" height="${h}" rx="5" fill="${color}"/><rect x="${x - 12}" y="${y - 12}" width="${bar + 24}" height="${h + 24}" rx="10" fill="none" stroke="${color}" stroke-width="8" opacity="${pulse}"/><line x1="${x + bar / 2}" y1="${y}" x2="${x + bar / 2}" y2="${top - 15}" stroke="${color}" opacity=".25"/>${text(x + bar / 2, y - 22, String(value), 60, ink, 750, "middle", paper)}${wrappedText(x + bar / 2, bottom + 54, data.labels[index], 12, 52, ink, 650, "middle")}`;
  }).join("");
  const unit = data.unit ? text(right, 362, `UNIT · ${data.unit.toUpperCase()}`, 44, teal, 700, "end", paper) : "";
  const context = data.context ? text(left, 362, data.context.toUpperCase(), 44, ink, 700, "start", paper) : "";
  const sourceBadge = `<rect x="${right - 330}" y="220" width="330" height="72" rx="10" fill="${teal}"/>${text(right - 165, 271, "SOURCE DATA", 42, paper, 850, "middle", teal)}`;
  const chartHeader = `<rect x="72" y="68" width="8" height="76" fill="${plan.theme.accent}"/>${shot.graphic?.kicker ? text(104, 88, shot.graphic.kicker.toUpperCase(), 36, ink, 750, "start", paper) : ""}${shot.title ? text(104, 154, shot.title, Math.min(78, Math.max(62, width / Math.max(15, shot.title.length))), ink, 750, "start", paper) : ""}`;
  const chartFooter = shot.citations?.length ? text(width - 76, height - 34, `SOURCE · ${shot.citations.map((citation) => citation.label).join(" · ")}`, 48, ink, 700, "end", paper) : "";
  return base(plan, `<rect width="${width}" height="${height}" fill="${paper}"/><g stroke="${grid}" opacity=".25">${Array.from({ length: 8 }, (_, index) => `<line x1="${left}" y1="${top + index * (bottom - top) / 7}" x2="${right}" y2="${top + index * (bottom - top) / 7}"/>`).join("")}</g>${chartHeader}${sourceBadge}${context}${unit}<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${grid}" stroke-width="3"/>${marks}${chartFooter}`);
}

function network(shot: ProductionShot, plan: ProductionPlan, progress: number) {
  const data = shot.graphic?.network;
  if (!data?.nodes.length) throw new Error("Network shot is missing graphic.network data.");
  const { width, height } = plan.canvas; const left = 230, right = width - 230, y = 585;
  const gap = data.nodes.length > 1 ? (right - left) / (data.nodes.length - 1) : 0;
  const positions = new Map(data.nodes.map((node, index) => [node.id, { center: left + index * gap }]));
  const edges = data.edges.map((edge, index) => {
    const from = positions.get(edge.fromId); const to = positions.get(edge.toId); if (!from || !to) return "";
    const local = Math.max(0, Math.min(1, progress * 1.7 - index * .24)); const start = from.center + 126, end = to.center - 126, midY = y;
    const drawnEnd = start + (end - start) * local;
    const phase = (progress * 3.2 + index * .31) % 1; const carrier = start + (end - start) * phase;
    return `<path d="M ${start} ${midY} H ${drawnEnd}" stroke="#071015" stroke-width="26"/><path d="M ${start} ${midY} H ${drawnEnd}" stroke="${plan.theme.accent}" stroke-width="13"/><path d="M ${start} ${midY} H ${drawnEnd}" stroke="${plan.theme.signal}" stroke-width="4" stroke-dasharray="20 28" stroke-dashoffset="${-progress * 180}"/>${local > .35 ? `<circle cx="${carrier}" cy="${midY}" r="17" fill="${plan.theme.foreground}" stroke="${plan.theme.accent}" stroke-width="7"/>` : ""}${local > .9 ? `<path d="M ${end - 24} ${midY - 20} L ${end} ${midY} L ${end - 24} ${midY + 20}" fill="none" stroke="${plan.theme.accent}" stroke-width="12"/>${edge.label ? text((start + end) / 2, midY - 52, edge.label.toUpperCase(), 38, plan.theme.foreground, 700, "middle") : ""}` : ""}`;
  }).join("");
  const nodes = data.nodes.map((node, index) => {
    const position = positions.get(node.id)!; const local = Math.max(0, Math.min(1, progress * data.nodes.length - index));
    const color = index === Math.floor(data.nodes.length / 2) ? plan.theme.accent : plan.theme.signal;
    const metricSize = Math.min(108, Math.max(72, 500 / Math.max(5, node.metric.value.length)));
    const status = evidenceStatus(node.metric.status, plan.theme.signal);
    const pulse = 1 + Math.sin((progress * 8 + index) * Math.PI) * .035;
    return `<g opacity="${.08 + .92 * local}" transform="translate(${position.center} ${y}) scale(${pulse}) translate(${-position.center} ${-y})"><circle cx="${position.center}" cy="${y}" r="128" fill="#10232b" stroke="${color}" stroke-width="7"/><circle cx="${position.center}" cy="${y}" r="150" fill="none" stroke="${color}" stroke-width="3" opacity=".35"/>${text(position.center, y - 182, node.label, 50, plan.theme.foreground, 800, "middle")}${text(position.center, y + 28, node.metric.value, metricSize, color, 850, "middle")}${wrappedText(position.center, y + 202, node.metric.label, 24, 40, plan.theme.foreground, 700, "middle")}<rect x="${position.center - 120}" y="${y + 270}" width="240" height="62" rx="31" fill="${status.color}"/>${text(position.center, y + 314, status.short, 34, plan.theme.background, 850, "middle")}</g>`;
  }).join("");
  return base(plan, `<rect x="0" y="230" width="${width}" height="${height - 330}" fill="#0b1a21" opacity=".72"/><path d="M ${left - 160} ${y} H ${right + 160}" stroke="${plan.theme.muted}" stroke-width="2" opacity=".25"/>${edges}${nodes}${header(shot, plan)}${footer(shot, plan)}`);
}

function timeline(shot: ProductionShot, plan: ProductionPlan, progress: number) {
  const events = shot.graphic?.timeline?.events;
  if (!events?.length) throw new Error("Timeline shot is missing events.");
  const { width, height } = plan.canvas;
  const left = 100, right = width - 100, y = height * .58;
  const gap = 28;
  const cardWidth = (right - left - gap * (events.length - 1)) / events.length;
  const cardHeight = 265;
  const marks = events.map((event, index) => {
    const local = Math.max(0, Math.min(1, progress * events.length - index));
    const x = left + index * (cardWidth + gap);
    const top = y - cardHeight / 2 + (1 - local) * 55;
    const color = index === events.length - 1 ? plan.theme.accent : plan.theme.signal;
    const arrow = index < events.length - 1 ? `<path d="M ${x + cardWidth + 6} ${y} L ${x + cardWidth + gap - 8} ${y}" stroke="${plan.theme.accent}" stroke-width="7"/><path d="M ${x + cardWidth + gap - 20} ${y - 12} L ${x + cardWidth + gap - 8} ${y} L ${x + cardWidth + gap - 20} ${y + 12}" fill="none" stroke="${plan.theme.accent}" stroke-width="7"/>` : "";
    return `<g opacity="${.1 + .9 * local}"><rect x="${x}" y="${top}" width="${cardWidth}" height="${cardHeight}" rx="22" fill="#10232b" stroke="${color}" stroke-width="4"/><rect x="${x}" y="${top}" width="14" height="${cardHeight}" rx="7" fill="${color}"/>${text(x + 42, top + 70, `0${event.date}`, 44, color, 800)}${text(x + cardWidth / 2, top + 165, event.label, Math.min(38, cardWidth / Math.max(10, event.label.length) * 1.3), plan.theme.foreground, 700, "middle")}${arrow}</g>`;
  }).join("");
  return base(plan, header(shot, plan) + marks + footer(shot, plan));
}

function map(shot: ProductionShot, plan: ProductionPlan, progress: number) {
  const data = shot.graphic?.map;
  if (!data) throw new Error("Map shot is missing graphic.map data.");
  const { width, height } = plan.canvas;
  const isFlow = shot.kind === "flow-map";
  const flowMetric = isFlow ? shot.graphic?.metric : undefined;
  if (isFlow && !flowMetric) throw new Error("Flow map shot is missing graphic.metric data.");
  const causalEvents = shot.kind === "causal-map" ? shot.graphic?.timeline?.events : undefined;
  if (shot.kind === "causal-map" && !causalEvents?.length) throw new Error("Causal map shot is missing graphic.timeline data.");
  const mapProgress = causalEvents ? Math.min(1, progress / .58) : progress;
  const topology = countries as unknown as { objects: { countries: object } };
  const world = feature(topology as never, topology.objects.countries as never);
  const coordinates = [...(data.points ?? []).map((point) => [point.longitude, point.latitude] as [number, number]), ...(data.routes ?? []).flatMap((route) => [[route.from[1], route.from[0]] as [number, number], [route.to[1], route.to[0]] as [number, number]])];
  const projection = geoNaturalEarth1();
  if (coordinates.length) {
    const longitudes = coordinates.map((coordinate) => coordinate[0]); const latitudes = coordinates.map((coordinate) => coordinate[1]);
    const span = Math.max(Math.max(...longitudes) - Math.min(...longitudes), (Math.max(...latitudes) - Math.min(...latitudes)) * 1.8);
    const scale = span > 140 ? 250 : span > 80 ? 420 : span > 40 ? 680 : span > 15 ? 1_150 : span > 5 ? 2_200 : 4_800;
    projection.center([(Math.max(...longitudes) + Math.min(...longitudes)) / 2, (Math.max(...latitudes) + Math.min(...latitudes)) / 2]).scale(scale * (.88 + .12 * mapProgress)).translate([width / 2, height * .52]);
  } else projection.fitExtent([[0, 0], [width, height]], world);
  const path = geoPath(projection);
  const worldPath = path(world) ?? "";
  const routes = (data.routes ?? []).map((route, index) => {
    const interpolate = geoInterpolate([route.from[1], route.from[0]], [route.to[1], route.to[0]]);
    const coordinates = Array.from({ length: 41 }, (_, index) => interpolate(index / 40));
    const routePath = path({ type: "LineString", coordinates }) ?? "";
    const midpoint = projection(interpolate(.5)) ?? [width / 2, height / 2];
    const local = Math.max(0, Math.min(1, mapProgress * Math.max(1, data.routes?.length ?? 1) - index));
    // Quantified flow maps communicate direction through the animated route,
    // endpoints, and evidence card. Multiple prose labels compete with that
    // evidence and frequently collide near the chokepoint.
    const showLabel = route.label && !isFlow && (data.routes?.length ?? 0) === 1;
    const percentage = Number(flowMetric?.value.match(/([0-9]+(?:\.[0-9]+)?)%/)?.[1] ?? 50) / 100;
    const routeWidth = isFlow ? 16 + Math.min(1, percentage) * 24 : 7;
    const blocked = Boolean(causalEvents && /\b(?:block(?:ed|age)?|clos(?:ed|ure)|disabled|disrupted?)\b/i.test(route.label ?? ""));
    const carriers = !blocked ? Array.from({ length: isFlow ? 3 : 1 }, (_, carrierIndex) => {
      const carrierProgress = local < .92
        ? Math.max(0, Math.min(1, local - carrierIndex * .16))
        : (progress * 3.1 + carrierIndex * .31 + index * .19) % 1;
      if (carrierProgress <= 0) return "";
      const position = projection(interpolate(carrierProgress)) ?? midpoint;
      return `<circle cx="${position[0]}" cy="${position[1]}" r="${13 + carrierIndex * 2}" fill="${plan.theme.foreground}" stroke="${plan.theme.signal}" stroke-width="6"/>`;
    }).join("") : "";
    const routeColor = blocked ? "#ff5d47" : plan.theme.accent;
    const blockMark = blocked && progress > .28 ? `<g opacity="${Math.min(1, (progress - .28) * 4)}"><circle cx="${midpoint[0]}" cy="${midpoint[1]}" r="42" fill="#071015" stroke="${routeColor}" stroke-width="8"/><path d="M ${midpoint[0] - 22} ${midpoint[1] - 22} L ${midpoint[0] + 22} ${midpoint[1] + 22} M ${midpoint[0] + 22} ${midpoint[1] - 22} L ${midpoint[0] - 22} ${midpoint[1] + 22}" stroke="${routeColor}" stroke-width="10" stroke-linecap="round"/></g>` : "";
    return `<path d="${routePath}" pathLength="1" fill="none" stroke="#071015" stroke-width="${routeWidth + 8}" stroke-dasharray="1" stroke-dashoffset="${1 - local}"/><path d="${routePath}" pathLength="1" fill="none" stroke="${routeColor}" stroke-width="${routeWidth}" stroke-linecap="round" stroke-dasharray="${blocked && progress > .28 ? ".035 .025" : "1"}" stroke-dashoffset="${1 - local}"/>${carriers}${blockMark}${showLabel ? `<g opacity="${local > .72 ? 1 : 0}">${text(midpoint[0], midpoint[1] - 28 + (index % 3 - 1) * 52, route.label!, 50, plan.theme.foreground, 700, "middle")}</g>` : ""}`;
  }).join("");
  const dense = (data.points?.length ?? 0) > 5;
  const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = flowMetric
    ? [{ left: width / 2 - 500, top: height - 520, right: width / 2 + 500, bottom: height - 100 }]
    : [];
  const points = (data.points ?? []).map((point, pointIndex) => {
    const [x, y] = projection([point.longitude, point.latitude]) ?? [width / 2, height / 2];
    const color = point.emphasis ? plan.theme.accent : plan.theme.signal;
    const pulse = 1 + Math.sin(mapProgress * Math.PI * 6) * .16;
    if (dense && !point.emphasis) return `<g opacity="${mapProgress > .2 ? 1 : .15}"><circle cx="${x}" cy="${y}" r="${10 * pulse}" fill="${color}"/><circle cx="${x}" cy="${y}" r="21" fill="none" stroke="${color}" stroke-width="3" opacity=".55"/></g>`;
    const labelWidth = Math.max(150, point.label.length * 34); const labelHeight = 66;
    const candidates = [
      { dx: 24, dy: -24, anchor: "start" }, { dx: 24, dy: 72, anchor: "start" },
      { dx: -24, dy: -24, anchor: "end" }, { dx: -24, dy: 72, anchor: "end" },
      { dx: 24, dy: -94, anchor: "start" }, { dx: -24, dy: -94, anchor: "end" },
      { dx: 24, dy: -164, anchor: "start" }, { dx: -24, dy: -164, anchor: "end" },
      { dx: 160, dy: -24, anchor: "start" }, { dx: -160, dy: -24, anchor: "end" },
      { dx: 160, dy: -94, anchor: "start" }, { dx: -160, dy: -94, anchor: "end" },
      { dx: 24, dy: 142, anchor: "start" }, { dx: -24, dy: 142, anchor: "end" },
    ];
    const ordered = candidates.slice(pointIndex % candidates.length).concat(candidates.slice(0, pointIndex % candidates.length));
    const laidOut = ordered.map((candidate) => {
      const textX = x + candidate.dx; const baseline = y + candidate.dy;
      const left = candidate.anchor === "end" ? textX - labelWidth - 12 : textX - 12;
      const box = { left, top: baseline - 52, right: left + labelWidth + 24, bottom: baseline + 14 };
      return { ...candidate, textX, baseline, box };
    });
    const bounded = laidOut.filter((candidate) => candidate.box.left >= 18 && candidate.box.right <= width - 18 && candidate.box.top >= 225 && candidate.box.bottom <= height - (causalEvents ? 322 : 105));
    const overlapArea = (candidate: typeof laidOut[number]) => occupied.reduce((sum, box) => {
      const overlapWidth = Math.max(0, Math.min(candidate.box.right, box.right) - Math.max(candidate.box.left, box.left));
      const overlapHeight = Math.max(0, Math.min(candidate.box.bottom, box.bottom) - Math.max(candidate.box.top, box.top));
      return sum + overlapWidth * overlapHeight;
    }, 0);
    const choice = bounded.find((candidate) => overlapArea(candidate) === 0) ?? bounded.sort((a, b) => overlapArea(a) - overlapArea(b))[0] ?? laidOut[0];
    occupied.push(choice.box);
    const connectorX = choice.anchor === "end" ? choice.box.right : choice.box.left;
    return `<g opacity="${mapProgress > .2 ? 1 : .15}"><circle cx="${x}" cy="${y}" r="${(point.emphasis ? 15 : 10) * pulse}" fill="${color}"/><circle cx="${x}" cy="${y}" r="${point.emphasis ? 30 : 21}" fill="none" stroke="${color}" stroke-width="3" opacity=".55"/><path d="M ${x} ${y} L ${connectorX} ${choice.baseline - 22}" stroke="${color}" stroke-width="3" opacity=".7"/><rect x="${choice.box.left}" y="${choice.box.top}" width="${choice.box.right - choice.box.left}" height="${labelHeight}" rx="10" fill="#071015" opacity=".82"/>${text(choice.textX, choice.baseline, point.label, 52, plan.theme.foreground, 750, choice.anchor)}</g>`;
  }).join("");
  const causalChain = causalEvents ? (() => {
    const reveal = Math.max(0, Math.min(1, (progress - .38) / .62));
    const left = 86, right = width - 86, gap = 24;
    const cardWidth = (right - left - gap * (causalEvents.length - 1)) / causalEvents.length;
    const y = height - 310, cardHeight = 190;
    return `<rect x="0" y="${y - 28}" width="${width}" height="${cardHeight + 70}" fill="#071015" opacity=".88"/>${causalEvents.map((event, index) => {
      const local = Math.max(0, Math.min(1, reveal * causalEvents.length - index));
      const x = left + index * (cardWidth + gap);
      const color = index === causalEvents.length - 1 ? plan.theme.accent : plan.theme.signal;
      const arrow = index < causalEvents.length - 1 ? `<path d="M ${x + cardWidth + 4} ${y + cardHeight / 2} H ${x + cardWidth + gap - 7}" stroke="${plan.theme.accent}" stroke-width="7"/><path d="M ${x + cardWidth + gap - 20} ${y + cardHeight / 2 - 12} L ${x + cardWidth + gap - 7} ${y + cardHeight / 2} L ${x + cardWidth + gap - 20} ${y + cardHeight / 2 + 12}" fill="none" stroke="${plan.theme.accent}" stroke-width="7"/>` : "";
      const labelSize = Math.min(54, Math.max(48, cardWidth / Math.max(10, event.label.length) * 2.15));
      return `<g opacity="${.08 + .92 * local}" transform="translate(0 ${(1 - local) * 24})"><rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="18" fill="#10232b" stroke="${color}" stroke-width="4"/><rect x="${x}" y="${y}" width="12" height="${cardHeight}" rx="6" fill="${color}"/>${text(x + 34, y + 50, event.date, 36, color, 800)}${wrappedText(x + cardWidth / 2, y + 114, event.label, 16, labelSize, plan.theme.foreground, 750, "middle")}${arrow}</g>`;
    }).join("")}`;
  })() : "";
  const quantifiedOutcome = causalEvents && shot.graphic?.metric ? (() => {
    const metric = shot.graphic!.metric!; const reveal = Math.max(0, Math.min(1, (progress - .68) / .22));
    const status = `${metric.status?.toUpperCase() ?? "QUANTIFIED"} CONSEQUENCE`;
    return `<g opacity="${reveal}"><rect x="${width - 800}" y="245" width="720" height="350" rx="22" fill="#071015" opacity=".94" stroke="${plan.theme.accent}" stroke-width="4"/>${text(width - 758, 296, status, 40, plan.theme.signal, 850)}${text(width - 758, 404, metric.value, 108, plan.theme.accent, 850)}${text(width - 758, 458, metric.label, 44, plan.theme.foreground, 750)}${metric.context ? wrappedText(width - 758, 508, metric.context, 32, 38, plan.theme.foreground, 650) : ""}</g>`;
  })() : "";
  const flowCallout = flowMetric ? (() => {
    const status = evidenceStatus(flowMetric.status, plan.theme.signal);
    // Status, denominator, period, and source are already visible elsewhere in
    // this card. Keep only the first methodology clause so the evidence note
    // remains readable rather than becoming duplicative microcopy.
    const methodClause = flowMetric.method?.split(/[;·]/)[0]?.trim() || "SOURCE-REPORTED VALUE";
    const method = `METHOD · ${methodClause}`;
    return `<g opacity="${Math.max(0, Math.min(1, (progress - .28) / .32))}"><rect x="${width / 2 - 480}" y="${height - 500}" width="960" height="380" rx="24" fill="#071015" opacity=".96" stroke="${status.color}" stroke-width="5"/><rect x="${width / 2 - 438}" y="${height - 470}" width="450" height="72" rx="9" fill="${status.color}"/>${text(width / 2 - 213, height - 419, status.label, 44, plan.theme.background, 850, "middle")}${text(width / 2, height - 306, flowMetric.value, 120, plan.theme.accent, 850, "middle")}${wrappedText(width / 2, height - 238, flowMetric.label, 40, 44, plan.theme.foreground, 750, "middle", 1)}${flowMetric.context ? text(width / 2, height - 178, flowMetric.context, 44, status.color, 700, "middle") : ""}${wrappedText(width / 2, height - 128, method.toUpperCase(), 48, 38, plan.theme.foreground, 700, "middle", 1)}</g>`;
  })() : "";
  const evidenceFooter = flowMetric?.sourceLabel
    ? text(width - 76, height - 34, `SOURCE · ${flowMetric.sourceLabel}`, 48, plan.theme.foreground, 700, "end")
    : footer(shot, plan);
  return base(plan, `<g><path d="${worldPath}" fill="${isFlow ? "#1c3c46" : "#17313c"}" stroke="${plan.theme.muted}" stroke-width="1.2" opacity=".96"/>${routes}${points}</g><rect x="0" y="0" width="${width}" height="225" fill="#071015" opacity=".78"/>${quantifiedOutcome}${flowCallout}${causalChain}<rect x="0" y="${height - 92}" width="${width}" height="92" fill="#071015" opacity=".82"/>${header(shot, plan)}${evidenceFooter}`);
}

function titleCard(shot: ProductionShot, plan: ProductionPlan, progress: number) {
  const { width, height } = plan.canvas;
  const titleValue = shot.title ?? plan.title;
  const sweep = width * (1 - progress);
  return base(plan, `<circle cx="${width * .82}" cy="${height * .52}" r="${180 + 220 * progress}" fill="none" stroke="${plan.theme.accent}" stroke-width="3" opacity=".18"/><circle cx="${width * .82}" cy="${height * .52}" r="${90 + 130 * progress}" fill="none" stroke="${plan.theme.signal}" stroke-width="2" opacity=".2"/><path d="M ${width * .82} ${height * .52} L ${width * .82 + 390 * Math.cos(progress * Math.PI * 1.2)} ${height * .52 + 390 * Math.sin(progress * Math.PI * 1.2)}" stroke="${plan.theme.accent}" stroke-width="4" opacity=".3"/><rect x="${width * .1}" y="${height * .16}" width="14" height="${height * .62 * progress}" fill="${plan.theme.accent}"/><g transform="translate(${sweep * .08} 0)" opacity="${Math.min(1, progress * 1.7)}">${shot.graphic?.kicker ? text(width * .14, height * .29, shot.graphic.kicker.toUpperCase(), 32, plan.theme.muted, 700) : ""}${text(width * .14, height * .5, titleValue, Math.min(112, width / Math.max(11, titleValue.length) * 1.85), plan.theme.foreground, 800)}${shot.subtitle ? text(width * .14, height * .61, shot.subtitle, 42, plan.theme.signal, 600) : ""}${shot.graphic?.body ? text(width * .14, height * .72, shot.graphic.body, 34, plan.theme.muted, 400) : ""}${footer(shot, plan)}</g>`);
}

function metricCard(shot: ProductionShot, plan: ProductionPlan, progress: number) {
  const metric = shot.graphic?.metric;
  if (!metric) throw new Error("Metric shot is missing graphic.metric data.");
  const { width, height } = plan.canvas;
  const assumptions = metric.context?.split(/\s*·\s*/).filter(Boolean) ?? [];
  if (metric.status === "modeled" && assumptions.length > 1) {
    const status = evidenceStatus(metric.status, plan.theme.signal); const left = 100; const rowWidth = 1_030; const resultX = 1_220; const resultWidth = width - resultX - 90;
    const rows = assumptions.slice(0, 4).map((assumption, index) => {
      const local = Math.max(0, Math.min(1, progress * assumptions.length * 1.15 - index)); const y = 330 + index * 165;
      const value = assumption.replace(/\bvia\b/gi, "→").toUpperCase();
      const valueSize = Math.min(46, Math.max(34, 1_050 / Math.max(24, value.length)));
      const feedStart = left + rowWidth; const feedEnd = resultX; const feedPhase = (progress * 3.2 + index * .27) % 1; const feedX = feedStart + (feedEnd - feedStart) * feedPhase;
      return `<g opacity="${.08 + .92 * local}" transform="translate(${(1 - local) * -80} 0)"><rect x="${left}" y="${y}" width="${rowWidth}" height="135" rx="18" fill="#10232b" stroke="${status.color}" stroke-width="4"/><rect x="${left}" y="${y}" width="16" height="135" rx="8" fill="${status.color}"/>${text(left + 48, y + 50, `ASSUMPTION ${String(index + 1).padStart(2, "0")}`, 38, status.color, 850)}${wrappedText(left + rowWidth / 2, y + 96, value, 34, valueSize, plan.theme.foreground, 800, "middle", 1)}${local > .72 ? `<path d="M ${feedStart} ${y + 68} H ${feedEnd}" stroke="${status.color}" stroke-width="5" opacity=".6"/><circle cx="${feedX}" cy="${y + 68}" r="11" fill="${plan.theme.foreground}" stroke="${status.color}" stroke-width="5"/>` : ""}</g>`;
    }).join("");
    const resultReveal = Math.max(0, Math.min(1, (progress - .48) / .34));
    const method = metric.method ? `METHOD · ${metric.method.toUpperCase()}` : "METHOD · LOCKED SCENARIO ASSUMPTIONS";
    return base(plan, `${header(shot, plan)}<rect x="${resultX}" y="245" width="${resultWidth}" height="76" rx="10" fill="${status.color}"/>${text(resultX + resultWidth / 2, 298, status.label, 46, plan.theme.background, 850, "middle")}${rows}<g opacity="${resultReveal}" transform="translate(0 ${(1 - resultReveal) * 46})"><rect x="${resultX}" y="350" width="${resultWidth}" height="475" rx="28" fill="#071015" stroke="${plan.theme.accent}" stroke-width="6"/>${text(resultX + resultWidth / 2, 420, "MODEL OUTPUT", 42, status.color, 850, "middle")}${text(resultX + resultWidth / 2, 575, metric.value, Math.min(160, resultWidth / Math.max(5, metric.value.length) * 1.5), plan.theme.accent, 900, "middle")}${wrappedText(resultX + resultWidth / 2, 655, metric.label.toUpperCase(), 22, 52, plan.theme.foreground, 800, "middle")}${wrappedText(resultX + resultWidth / 2, 735, method, 28, 32, status.color, 750, "middle", 3)}</g>${footer(shot, plan)}`);
  }
  const scale = .82 + .18 * progress;
  // Never animate a sourced headline through false intermediate values. The
  // surrounding ring/count marks reveal over time; the claim itself stays true.
  const value = metric.value;
  const percent = metric.value.match(/~?([0-9]+(?:\.[0-9]+)?)%/);
  const integer = metric.value.match(/^([0-9]{1,2})$/);
  const distance = /\b(?:NM|nautical mile)/i.test(`${metric.value} ${metric.label}`);
  let evidence = "";
  if (distance) {
    // The banks visibly close toward the sourced width. This is explanatory
    // motion: the geometry tightens before the exact metric resolves.
    const left = width * (.12 + .13 * progress), right = width * (.88 - .13 * progress), y = height * .69;
    const vesselY = height * .38 + height * .38 * ((progress * 2.4) % 1);
    evidence = `<g opacity="${.35 + .65 * progress}"><rect x="${left - 100}" y="${height * .34}" width="100" height="${height * .48}" fill="#203943"/><rect x="${right}" y="${height * .34}" width="100" height="${height * .48}" fill="#203943"/><path d="M ${width / 2} ${height * .34} V ${height * .82}" stroke="${plan.theme.muted}" stroke-width="3" stroke-dasharray="18 20" opacity=".45"/><g transform="translate(${width / 2} ${vesselY})"><path d="M 0 -34 L 24 22 L 0 36 L -24 22 Z" fill="${plan.theme.foreground}" stroke="${plan.theme.accent}" stroke-width="6"/></g><line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${plan.theme.signal}" stroke-width="8"/><path d="M ${left} ${y} l 30 -18 v 36 z M ${right} ${y} l -30 -18 v 36 z" fill="${plan.theme.signal}"/><line x1="${left}" y1="${y - 38}" x2="${left}" y2="${y + 38}" stroke="${plan.theme.signal}" stroke-width="7"/><line x1="${right}" y1="${y - 38}" x2="${right}" y2="${y + 38}" stroke="${plan.theme.signal}" stroke-width="7"/></g>`;
  } else if (percent) {
    const ratio = Math.min(1, Number(percent[1]) / 100) * progress;
    const radius = 178; const circumference = 2 * Math.PI * radius;
    evidence = `<g transform="rotate(-90 ${width / 2} ${height * .6})"><circle cx="${width / 2}" cy="${height * .6}" r="${radius}" fill="none" stroke="#23363e" stroke-width="34"/><circle cx="${width / 2}" cy="${height * .6}" r="${radius}" fill="none" stroke="${plan.theme.accent}" stroke-width="34" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - ratio)}"/></g>`;
  } else if (integer && Number(integer[1]) <= 12) {
    const count = Number(integer[1]); const gap = 36; const size = 48; const total = count * size + (count - 1) * gap; const left = (width - total) / 2;
    evidence = `<g>${Array.from({ length: count }, (_, index) => `<rect x="${left + index * (size + gap)}" y="${height * .79}" width="${size}" height="${size}" rx="8" fill="${index < Math.ceil(count * progress) ? plan.theme.signal : "#23363e"}"/>`).join("")}</g>`;
  }
  const statusInfo = evidenceStatus(metric.status, plan.theme.signal);
  const status = metric.status ? `<rect x="${width / 2 - 280}" y="${height * .238}" width="560" height="76" rx="10" fill="${statusInfo.color}"/>${text(width / 2, height * .292, statusInfo.label, 46, plan.theme.background, 850, "middle")}` : "";
  return base(plan, header(shot, plan) + `${status}${evidence}<g opacity="1" transform="translate(${width / 2} ${height * .6}) scale(${scale}) translate(${-width / 2} ${-height * .6})">${text(width / 2, distance ? height * .57 : height * .64, value, Math.min(220, width / Math.max(5, metric.value.length) * .78), plan.theme.accent, 800, "middle")}${text(width / 2, distance ? height * .80 : height * .73, metric.label, 60, plan.theme.foreground, 700, "middle")}${metric.context ? text(width / 2, distance ? height * .88 : height * .82, metric.context, 48, plan.theme.signal, 650, "middle") : ""}</g>${footer(shot, plan)}`);
}

export function productionGraphicSvg(shot: ProductionShot, plan: ProductionPlan, progress = 1) {
  const bounded = Math.max(0, Math.min(1, progress));
  if (shot.kind === "chart") return chart(shot, plan, bounded);
  if (shot.kind === "metric") return metricCard(shot, plan, bounded);
  if (shot.kind === "timeline") return timeline(shot, plan, bounded);
  if (shot.kind === "map") return map(shot, plan, bounded);
  if (shot.kind === "flow-map") return map(shot, plan, bounded);
  if (shot.kind === "network") return network(shot, plan, bounded);
  if (shot.kind === "causal-map") return map(shot, plan, bounded);
  if (shot.kind === "title") return titleCard(shot, plan, bounded);
  throw new Error(`Unsupported graphic shot kind: ${shot.kind}`);
}
