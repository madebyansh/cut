import type { CutAVIR, IRNode, IRValue } from "../../language/ir";
import { lockedGlyphRun, parseLockedOpenTypeFont, type LockedGlyphRun, type LockedOpenTypeFont } from "./locked-font";

export const referenceGeoLabelLimits = Object.freeze({
  maxNodesPerComposition: 256,
  maxFontBytes: 16 * 1024 * 1024,
  maxFontGlyphs: 100_000,
  maxLabelsPerNode: 2_048,
  maxCodePointsPerLabel: 256,
  maxCodePointsPerNode: 32_768,
  maxOutlineCommandsPerNode: 250_000,
  maxOutlineBytesPerNode: 8 * 1024 * 1024,
  maxSessionResourceBytes: 64 * 1024 * 1024,
  maxSessionOutlineCommands: 2_000_000,
  maxSessionOutlineBytes: 32 * 1024 * 1024,
});

export type ReferenceGeoLabelErrorCode =
  | "CUT_GEO_LABEL_TYPE"
  | "CUT_GEO_FONT_RESOURCE"
  | "CUT_GEO_FONT_COMBINATION"
  | "CUT_GEO_FONT_PARSE"
  | "CUT_GEO_FONT_COVERAGE"
  | "CUT_GEO_FONT_OUTLINE"
  | "CUT_GEO_FONT_BUDGET";

export class ReferenceGeoLabelError extends Error {
  constructor(readonly code: ReferenceGeoLabelErrorCode, readonly nodeId: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceGeoLabelError";
  }
}

export type ReferenceGeoLabelConfig = {
  nodeId: string;
  kind: "map" | "marker" | "connections";
  fontId?: string;
  size: number;
};

export type ReferenceGeoPoint = {
  latitude: number;
  longitude: number;
  label: string;
  rawLabel?: unknown;
  emphasis: boolean;
  id: string;
};

export type ReferenceGeoLabelCandidate = { index: number; label: string };

export type PreparedReferenceGeoLabels = {
  config: ReferenceGeoLabelConfig;
  runs: ReadonlyMap<number, LockedGlyphRun>;
  outlineCommands: number;
  outlineBytes: number;
};

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

export function referenceGeoLabelFailure(node: IRNode, code: ReferenceGeoLabelErrorCode, message: string): never {
  throw new ReferenceGeoLabelError(code, node.id, `${node.op} at ${location(node)} ${message}`);
}

function directObjectLabel(node: IRNode, input: string, value: IRValue | undefined) {
  if (value?.kind !== "object") return { known: false, label: undefined } as const;
  const label = value.entries.label;
  if (label === undefined) return { known: true, label: undefined } as const;
  if (label.kind !== "string") referenceGeoLabelFailure(node, "CUT_GEO_LABEL_TYPE", `input “${input}.label” must be a String.`);
  return { known: true, label: label.value } as const;
}

function staticallyEffectiveLabel(node: IRNode) {
  if (node.op === "cut.geo.map") return { known: node.inputs.points === undefined, label: undefined } as const;
  if (node.op === "cut.geo.marker") {
    const authored = node.inputs.label;
    if (authored !== undefined) {
      if (authored.kind !== "string") referenceGeoLabelFailure(node, "CUT_GEO_LABEL_TYPE", "input “label” must be a String.");
      return { known: true, label: authored.value } as const;
    }
    return directObjectLabel(node, "point", node.inputs.point);
  }
  return directObjectLabel(node, "target", node.inputs.target);
}

/** Closed label/font contract shared by loaded-IR preflight and preparation. */
export function referenceGeoLabelConfig(node: IRNode, ir: CutAVIR): ReferenceGeoLabelConfig | undefined {
  const kind = node.op === "cut.geo.map" ? "map" : node.op === "cut.geo.marker" ? "marker" : node.op === "cut.geo.connections" ? "connections" : undefined;
  if (!kind) return undefined;
  const font = node.inputs.font;
  if (font !== undefined && (font.kind !== "resource-ref" || ir.resources[font.id]?.kind !== "font")) {
    referenceGeoLabelFailure(node, "CUT_GEO_FONT_RESOURCE", "input “font” must reference a locked FontAsset; host font fallback is forbidden.");
  }
  const effective = staticallyEffectiveLabel(node), hasVisibleLabel = typeof effective.label === "string" && effective.label.trim().length > 0;
  if (effective.known && hasVisibleLabel && font === undefined) {
    referenceGeoLabelFailure(node, "CUT_GEO_FONT_RESOURCE", "a visible label requires input “font”: FontAsset; host font fallback is forbidden.");
  }
  if (effective.known && !hasVisibleLabel && font !== undefined) {
    referenceGeoLabelFailure(node, "CUT_GEO_FONT_COMBINATION", "input “font” would be a no-op because this node has no visible label.");
  }
  return { nodeId: node.id, kind, fontId: font?.kind === "resource-ref" ? font.id : undefined, size: kind === "marker" ? 30 : 28 };
}

export function validateReferenceGeoLabelNodeBudget(ir: CutAVIR, reachable: ReadonlySet<string>) {
  const nodes = [...reachable].map((id) => ir.nodes[id]).filter((node): node is IRNode => Boolean(node)).filter((node) => referenceGeoLabelConfig(node, ir) !== undefined);
  if (nodes.length > referenceGeoLabelLimits.maxNodesPerComposition) {
    referenceGeoLabelFailure(nodes[referenceGeoLabelLimits.maxNodesPerComposition], "CUT_GEO_FONT_BUDGET", `composition exceeds the ${referenceGeoLabelLimits.maxNodesPerComposition}-geo-label-node limit.`);
  }
}

/** Parse the exact point forms consumed by Map, Marker, and Connections. */
export function referenceGeoPoints(rawValue: unknown): ReferenceGeoPoint[] {
  const record = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue as Record<string, unknown> : undefined;
  const candidates = Array.isArray(rawValue)
    ? rawValue
    : Array.isArray(record?.points)
      ? record.points
      : Array.isArray(record?.features)
        ? record.features
        : record && (record.latitude !== undefined || record.lat !== undefined)
          ? [record]
          : [];
  return candidates.flatMap((candidate, index): ReferenceGeoPoint[] => {
    if (Array.isArray(candidate) && candidate.length >= 2) {
      const longitude = Number(candidate[0]), latitude = Number(candidate[1]);
      return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
        ? [{ latitude, longitude, label: "", emphasis: false, id: String(index) }]
        : [];
    }
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>, geometry = item.geometry && typeof item.geometry === "object" ? item.geometry as Record<string, unknown> : undefined;
    const properties = item.properties && typeof item.properties === "object" ? item.properties as Record<string, unknown> : item;
    const coordinates = Array.isArray(geometry?.coordinates) ? geometry.coordinates : undefined;
    const latitude = Number(properties.latitude ?? properties.lat ?? coordinates?.[1]);
    const longitude = Number(properties.longitude ?? properties.lon ?? properties.lng ?? coordinates?.[0]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
    const rawLabel = properties.label ?? properties.name;
    return [{
      latitude,
      longitude,
      label: typeof rawLabel === "string" ? rawLabel : "",
      ...(rawLabel === undefined ? {} : { rawLabel }),
      emphasis: properties.emphasis === true,
      id: String(properties.id ?? properties.code ?? index),
    }];
  });
}

function pointLabel(node: IRNode, input: string, point: ReferenceGeoPoint | undefined) {
  if (!point || point.rawLabel === undefined) return undefined;
  if (typeof point.rawLabel !== "string") referenceGeoLabelFailure(node, "CUT_GEO_LABEL_TYPE", `data-derived “${input}.label” or “${input}.name” must be a String when it can render.`);
  return point.rawLabel;
}

export function referenceGeoLabelCandidates(node: IRNode, points: readonly ReferenceGeoPoint[]): ReferenceGeoLabelCandidate[] {
  let candidates: ReferenceGeoLabelCandidate[];
  if (node.op === "cut.geo.map") {
    candidates = points.flatMap((point, index) => {
      const label = pointLabel(node, `points[${index}]`, point);
      return label !== undefined && label.trim().length > 0 ? [{ index, label }] : [];
    });
  } else if (node.op === "cut.geo.marker") {
    const authored = node.inputs.label;
    if (authored !== undefined && authored.kind !== "string") referenceGeoLabelFailure(node, "CUT_GEO_LABEL_TYPE", "input “label” must be a String.");
    const label = authored?.kind === "string" ? authored.value : pointLabel(node, "point", points[0]);
    candidates = label !== undefined && label.trim().length > 0 ? [{ index: 0, label }] : [];
  } else if (node.op === "cut.geo.connections") {
    const label = pointLabel(node, "target", points[0]);
    candidates = label !== undefined && label.trim().length > 0 ? [{ index: 0, label }] : [];
  } else return [];
  if (candidates.length > referenceGeoLabelLimits.maxLabelsPerNode) {
    referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", `visible labels exceed the ${referenceGeoLabelLimits.maxLabelsPerNode}-label per-node budget.`);
  }
  let codePoints = 0;
  for (const candidate of candidates) {
    const length = [...candidate.label].length;
    if (length > referenceGeoLabelLimits.maxCodePointsPerLabel) referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", `label ${candidate.index} exceeds the ${referenceGeoLabelLimits.maxCodePointsPerLabel}-code-point budget.`);
    codePoints += length;
    if (!Number.isSafeInteger(codePoints) || codePoints > referenceGeoLabelLimits.maxCodePointsPerNode) referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", `labels exceed the ${referenceGeoLabelLimits.maxCodePointsPerNode}-code-point per-node budget.`);
  }
  return candidates;
}

export function parseReferenceGeoLabelFont(node: IRNode, bytes: Buffer, locator: string) {
  try {
    return parseLockedOpenTypeFont(bytes, locator, { maxBytes: referenceGeoLabelLimits.maxFontBytes, maxGlyphs: referenceGeoLabelLimits.maxFontGlyphs });
  } catch (error) {
    referenceGeoLabelFailure(node, "CUT_GEO_FONT_PARSE", error instanceof Error ? error.message : String(error));
  }
}

export function prepareReferenceGeoLabels(
  node: IRNode,
  config: ReferenceGeoLabelConfig,
  candidates: readonly ReferenceGeoLabelCandidate[],
  font: LockedOpenTypeFont | undefined,
): PreparedReferenceGeoLabels {
  if (!candidates.length) {
    if (config.fontId !== undefined) referenceGeoLabelFailure(node, "CUT_GEO_FONT_COMBINATION", "input “font” would be a no-op because the resolved data has no visible label.");
    return { config, runs: new Map(), outlineCommands: 0, outlineBytes: 0 };
  }
  if (!config.fontId || !font) referenceGeoLabelFailure(node, "CUT_GEO_FONT_RESOURCE", "resolved visible labels require a locked FontAsset; host font fallback is forbidden.");
  const runs = new Map<number, LockedGlyphRun>();
  let outlineCommands = 0, outlineBytes = 0;
  for (const candidate of candidates) {
    let run: LockedGlyphRun;
    try {
      run = lockedGlyphRun(font, candidate.label, config.size, {
        maxCommands: referenceGeoLabelLimits.maxOutlineCommandsPerNode - outlineCommands,
        maxPathBytes: referenceGeoLabelLimits.maxOutlineBytesPerNode - outlineBytes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no glyph|\.notdef|font fallback/u.test(message)) referenceGeoLabelFailure(node, "CUT_GEO_FONT_COVERAGE", `label ${candidate.index}: ${message}`);
      if (/budget/u.test(message)) referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", `label ${candidate.index}: ${message}`);
      referenceGeoLabelFailure(node, "CUT_GEO_FONT_OUTLINE", `label ${candidate.index}: ${message}`);
    }
    outlineCommands += run.commands; outlineBytes += run.pathBytes;
    if (outlineCommands > referenceGeoLabelLimits.maxOutlineCommandsPerNode || outlineBytes > referenceGeoLabelLimits.maxOutlineBytesPerNode) {
      referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", "locked label outlines exceed the per-node outline budget.");
    }
    runs.set(candidate.index, run);
  }
  return { config, runs, outlineCommands, outlineBytes };
}

export function referenceGeoLabelPath(
  run: LockedGlyphRun | undefined,
  options: { x: number; y: number; anchor?: "start" | "middle" | "end"; fill: string; opacity?: number; stroke?: string; strokeWidth?: number },
) {
  if (!run) return "";
  const x = options.anchor === "end" ? options.x - run.advance : options.anchor === "middle" ? options.x - run.advance / 2 : options.x;
  const opacity = options.opacity ?? 1, stroke = options.stroke ? ` stroke="${options.stroke}" stroke-width="${options.strokeWidth ?? 0}" paint-order="stroke" stroke-linejoin="round"` : "";
  return `<path d="${run.pathData}" transform="translate(${x} ${options.y})" fill="${options.fill}" opacity="${opacity}"${stroke}/>`;
}
