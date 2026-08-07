import { TextDecoder } from "node:util";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";
import { validateStrictResearchPack } from "../../research/validate";
import type { ResearchClaim, ResearchPack, ResearchSource } from "../../research/types";
import { lockedGlyphAdvance, lockedGlyphRun, type LockedGlyphRun, type LockedOpenTypeFont } from "./locked-font";

export const referenceEvidenceLimits = Object.freeze({
  maxNodesPerComposition: 64,
  maxResearchBytes: 2 * 1024 * 1024,
  maxFontBytes: 16 * 1024 * 1024,
  maxFontGlyphs: 100_000,
  maxSessionResourceBytes: 64 * 1024 * 1024,
  maxFontSize: 512,
  maxWidth: 8_192,
  maxLines: 6,
  maxOutlineCommandsPerNode: 100_000,
  maxOutlineBytesPerNode: 4 * 1024 * 1024,
  maxSessionOutlineCommands: 1_000_000,
  maxSessionOutlineBytes: 16 * 1024 * 1024,
});

type EvidenceColor = { color: string; opacity: number };
export type ReferenceEvidenceMode = "claim-card" | "source-chip";

export type ReferenceEvidenceConfig = {
  nodeId: string;
  sourceId: string;
  fontId: string;
  claimId: string;
  mode: ReferenceEvidenceMode;
  x: number;
  y: number;
  size: number;
  color: EvidenceColor;
  accent: EvidenceColor;
  maxWidth: number;
  canvasWidth: number;
  canvasHeight: number;
};

export type PreparedReferenceEvidence = {
  config: ReferenceEvidenceConfig;
  pack: ResearchPack;
  claim: ResearchClaim;
  sources: readonly ResearchSource[];
  label: string;
  claimLines: readonly string[];
  labelOutline: LockedGlyphRun;
  claimOutlines: readonly LockedGlyphRun[];
  layout: {
    x: number;
    y: number;
    width: number;
    height: number;
    accentWidth: number;
    radius: number;
    labelX: number;
    labelBaseline: number;
    claimX: number;
    claimFirstBaseline: number;
    claimLineHeight: number;
  };
  outlineCommands: number;
  outlineBytes: number;
};

function evidenceFailure(node: IRNode, message: string): never {
  throw new Error(`Evidence at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column} ${message}`);
}

function requiredResource(node: IRNode, ir: CutAVIR, input: "research" | "font", kind: "data" | "font") {
  const value = node.inputs[input];
  if (value?.kind !== "resource-ref") evidenceFailure(node, `input “${input}” must be a locked ${kind === "data" ? "DataAsset" : "FontAsset"}.`);
  if (ir.resources[value.id]?.kind !== kind) evidenceFailure(node, `input “${input}” must reference a ${kind === "data" ? "DataAsset" : "FontAsset"}.`);
  return value.id;
}

function requiredString(node: IRNode, input: string, value: IRValue | undefined) {
  if (value?.kind !== "string" || !value.value || value.value.length > 80 || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value.value)) evidenceFailure(node, `input “${input}” must be a stable 1-80 character research ID String.`);
  return value.value;
}

function requiredLength(node: IRNode, input: string, value: IRValue | undefined) {
  if (value?.kind !== "quantity" || value.dimension !== "length") evidenceFailure(node, `input “${input}” must be a Length quantity.`);
  const number = rationalToNumber(value.magnitude);
  if (!Number.isFinite(number)) evidenceFailure(node, `input “${input}” must be finite.`);
  return number;
}

function requiredColor(node: IRNode, input: string, value: IRValue | undefined): EvidenceColor {
  if (value?.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value.value)) evidenceFailure(node, `input “${input}” must be a canonical #RRGGBB or #RRGGBBAA Color.`);
  return { color: value.value.slice(0, 7), opacity: value.value.length === 9 ? Number.parseInt(value.value.slice(7), 16) / 255 : 1 };
}

function evidenceMode(node: IRNode, value: IRValue | undefined): ReferenceEvidenceMode {
  if (value === undefined) return "claim-card";
  if (value.kind !== "string" || (value.value !== "claim-card" && value.value !== "source-chip")) evidenceFailure(node, "input “mode” must be exactly one of: claim-card, source-chip.");
  return value.value;
}

export function referenceEvidenceConfig(node: IRNode, ir: CutAVIR, composition: IRComposition): ReferenceEvidenceConfig | undefined {
  if (node.op !== "cut.documentary.evidence") return undefined;
  const sourceId = requiredResource(node, ir, "research", "data"), fontId = requiredResource(node, ir, "font", "font");
  const claimId = requiredString(node, "claimId", node.inputs.claimId), mode = evidenceMode(node, node.inputs.mode);
  const x = requiredLength(node, "x", node.inputs.x), y = requiredLength(node, "y", node.inputs.y);
  const size = requiredLength(node, "size", node.inputs.size), maxWidth = requiredLength(node, "maxWidth", node.inputs.maxWidth);
  const color = requiredColor(node, "color", node.inputs.color), accent = requiredColor(node, "accent", node.inputs.accent);
  if (x < 0 || x >= composition.width || y < 0 || y >= composition.height) evidenceFailure(node, "inputs “x” and “y” must place the card origin inside the canvas.");
  if (size < 8 || size > referenceEvidenceLimits.maxFontSize) evidenceFailure(node, `input “size” must be from 8 through ${referenceEvidenceLimits.maxFontSize}px.`);
  const minimumWidthRatio = mode === "claim-card" ? 6 : 4;
  if (maxWidth < size * minimumWidthRatio || maxWidth > referenceEvidenceLimits.maxWidth) evidenceFailure(node, `input “maxWidth” must be at least ${minimumWidthRatio}× size in ${mode} mode and no greater than ${referenceEvidenceLimits.maxWidth}px.`);
  if (x + maxWidth > composition.width + 1e-7) evidenceFailure(node, "x + maxWidth must fit inside the canvas.");
  if (color.opacity <= 0 || accent.opacity <= 0) evidenceFailure(node, "inputs “color” and “accent” must remain visibly non-transparent.");
  return { nodeId: node.id, sourceId, fontId, claimId, mode, x, y, size, color, accent, maxWidth, canvasWidth: composition.width, canvasHeight: composition.height };
}

function inline(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateWithMarker(node: IRNode, font: LockedOpenTypeFont, value: string, size: number, maximumWidth: number) {
  const marker = "...";
  if (lockedGlyphAdvance(font, marker, size) > maximumWidth + 1e-7) evidenceFailure(node, "cannot fit the deterministic truncation marker inside maxWidth.");
  let result = "";
  for (const character of value) {
    if (lockedGlyphAdvance(font, `${result}${character}${marker}`, size) > maximumWidth + 1e-7) break;
    result += character;
  }
  return `${result.trimEnd()}${marker}`;
}

function truncateLine(node: IRNode, font: LockedOpenTypeFont, value: string, size: number, maximumWidth: number) {
  return lockedGlyphAdvance(font, value, size) <= maximumWidth + 1e-7 ? value : truncateWithMarker(node, font, value, size, maximumWidth);
}

function splitToken(node: IRNode, font: LockedOpenTypeFont, token: string, size: number, maximumWidth: number) {
  const chunks: string[] = []; let current = "";
  for (const character of token) {
    const candidate = current + character;
    if (lockedGlyphAdvance(font, candidate, size) <= maximumWidth + 1e-7) { current = candidate; continue; }
    if (!current) evidenceFailure(node, `cannot fit U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} inside maxWidth at the configured size.`);
    chunks.push(current); current = character;
  }
  if (current) chunks.push(current);
  return chunks;
}

function wrapClaim(node: IRNode, font: LockedOpenTypeFont, value: string, size: number, maximumWidth: number, maximumLines: number) {
  const words = inline(value).split(" ").filter(Boolean), lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (lockedGlyphAdvance(font, candidate, size) <= maximumWidth + 1e-7) { current = candidate; continue; }
    if (current) { lines.push(current); current = ""; }
    if (lockedGlyphAdvance(font, word, size) <= maximumWidth + 1e-7) { current = word; continue; }
    const chunks = splitToken(node, font, word, size, maximumWidth);
    lines.push(...chunks.slice(0, -1)); current = chunks.at(-1) ?? "";
  }
  if (current) lines.push(current);
  if (!lines.length) evidenceFailure(node, "selected claim has no visible text after normalization.");
  if (lines.length <= maximumLines) return lines;
  const visible = lines.slice(0, maximumLines);
  const last = visible.at(-1) ?? "";
  visible[visible.length - 1] = lockedGlyphAdvance(font, `${last}...`, size) <= maximumWidth + 1e-7
    ? `${last}...`
    : truncateWithMarker(node, font, last, size, maximumWidth);
  return visible;
}

function sourceLabel(sources: readonly ResearchSource[]) {
  const first = sources[0].shortLabel ?? sources[0].publisher;
  return `EVIDENCE - ${inline(first)}${sources.length > 1 ? ` +${sources.length - 1}` : ""}`;
}

function compactSourceLabel(sources: readonly ResearchSource[]) {
  const first = sources[0].shortLabel ?? sources[0].publisher;
  return `${inline(first)}${sources.length > 1 ? ` +${sources.length - 1}` : ""}`;
}

function outline(node: IRNode, font: LockedOpenTypeFont, text: string, size: number, commands: number, bytes: number) {
  try { return lockedGlyphRun(font, text, size, { maxCommands: commands, maxPathBytes: bytes }); }
  catch (error) { evidenceFailure(node, error instanceof Error ? error.message : String(error)); }
}

function prepareSourceChip(node: IRNode, config: ReferenceEvidenceConfig, pack: ResearchPack, claim: ResearchClaim, sources: readonly ResearchSource[], font: LockedOpenTypeFont): PreparedReferenceEvidence {
  const paddingX = config.size * .55, paddingY = config.size * .34, accentWidth = Math.max(4, config.size * .12), radius = Math.max(6, config.size * .3);
  const maximumTextWidth = config.maxWidth - accentWidth - 2 * paddingX;
  if (maximumTextWidth < config.size * 2) evidenceFailure(node, "maxWidth leaves less than 2× size for the source label after deterministic chip padding.");
  const label = truncateLine(node, font, compactSourceLabel(sources), config.size, maximumTextWidth);
  const labelOutline = outline(node, font, label, config.size, referenceEvidenceLimits.maxOutlineCommandsPerNode, referenceEvidenceLimits.maxOutlineBytesPerNode);
  const height = labelOutline.y2 - labelOutline.y1 + 2 * paddingY;
  const width = accentWidth + 2 * paddingX + labelOutline.width;
  if (!Number.isFinite(width) || width <= 0 || width > config.maxWidth + 1e-7) evidenceFailure(node, "prepared source chip exceeds maxWidth.");
  if (!Number.isFinite(height) || height <= 0 || config.y + height > config.canvasHeight + 1e-7) evidenceFailure(node, "prepared source chip exceeds the canvas; reduce y or size, or increase the canvas.");
  const labelX = config.x + accentWidth + paddingX, labelBaseline = config.y + paddingY - labelOutline.y1;
  return {
    config, pack, claim, sources, label, claimLines: [], labelOutline, claimOutlines: [],
    layout: { x: config.x, y: config.y, width, height, accentWidth, radius, labelX, labelBaseline, claimX: labelX, claimFirstBaseline: 0, claimLineHeight: 0 },
    outlineCommands: labelOutline.commands, outlineBytes: labelOutline.pathBytes,
  };
}

export function prepareReferenceEvidence(node: IRNode, config: ReferenceEvidenceConfig, researchBytes: Buffer, font: LockedOpenTypeFont): PreparedReferenceEvidence {
  if (researchBytes.byteLength > referenceEvidenceLimits.maxResearchBytes) evidenceFailure(node, `locked research DataAsset exceeds the ${referenceEvidenceLimits.maxResearchBytes}-byte budget.`);
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(researchBytes); }
  catch { evidenceFailure(node, "locked research DataAsset is not valid UTF-8."); }
  let data: unknown;
  try { data = JSON.parse(decoded); }
  catch { evidenceFailure(node, "locked research DataAsset is not valid JSON."); }
  let pack: ResearchPack;
  try { pack = validateStrictResearchPack(data); }
  catch (error) { evidenceFailure(node, `locked research DataAsset failed cut-research v1 validation: ${error instanceof Error ? error.message : String(error)}`); }
  const claim = pack.claims.find((candidate) => candidate.id === config.claimId);
  if (!claim) evidenceFailure(node, `cannot find claimId “${config.claimId}” in the locked research pack.`);
  const sources = claim.sourceIds.map((id) => pack.sources.find((candidate) => candidate.id === id));
  if (sources.some((source) => !source)) evidenceFailure(node, `claimId “${config.claimId}” references a missing source.`);
  const lockedSources = sources as ResearchSource[];
  if (config.mode === "source-chip") return prepareSourceChip(node, config, pack, claim, lockedSources, font);

  const padding = config.size * .65, accentWidth = Math.max(4, config.size * .12), radius = Math.max(4, config.size * .22);
  const innerWidth = config.maxWidth - accentWidth - 2 * padding;
  if (innerWidth < config.size * 4) evidenceFailure(node, "maxWidth leaves less than 4× size for visible claim text after deterministic card padding.");
  const labelSize = Math.max(10, Math.min(32, config.size * .52));
  const label = truncateLine(node, font, sourceLabel(lockedSources), labelSize, innerWidth);
  let remainingCommands = referenceEvidenceLimits.maxOutlineCommandsPerNode, remainingBytes = referenceEvidenceLimits.maxOutlineBytesPerNode;
  const labelOutline = outline(node, font, label, labelSize, remainingCommands, remainingBytes);
  remainingCommands -= labelOutline.commands; remainingBytes -= labelOutline.pathBytes;

  const labelTop = config.y + padding, labelBaseline = labelTop - labelOutline.y1, labelBottom = labelBaseline + labelOutline.y2;
  const gap = config.size * .45, claimTop = labelBottom + gap, claimLineHeight = config.size * 1.18;
  const availableClaimHeight = config.canvasHeight - padding - claimTop;
  const maximumLines = Math.min(referenceEvidenceLimits.maxLines, Math.floor((availableClaimHeight + config.size * .25) / claimLineHeight));
  if (maximumLines < 1) evidenceFailure(node, "configured y/size leaves no vertical space for one claim line.");
  const claimLines = wrapClaim(node, font, claim.text, config.size, innerWidth, maximumLines);
  const claimOutlines: LockedGlyphRun[] = [];
  for (const line of claimLines) {
    if (remainingCommands < 1 || remainingBytes < 1) evidenceFailure(node, "exceeds its locked-font outline budget before all claim lines are prepared.");
    const prepared = outline(node, font, line, config.size, remainingCommands, remainingBytes);
    if (prepared.width > innerWidth + 1e-7) evidenceFailure(node, "prepared claim line is wider than maxWidth.");
    claimOutlines.push(prepared); remainingCommands -= prepared.commands; remainingBytes -= prepared.pathBytes;
  }
  const claimContentTop = Math.min(...claimOutlines.map((item, index) => item.y1 + index * claimLineHeight));
  const claimContentBottom = Math.max(...claimOutlines.map((item, index) => item.y2 + index * claimLineHeight));
  const claimFirstBaseline = claimTop - claimContentTop, height = claimFirstBaseline + claimContentBottom + padding - config.y;
  if (!Number.isFinite(height) || height <= 0 || config.y + height > config.canvasHeight + 1e-7) evidenceFailure(node, "prepared card exceeds the canvas; reduce y or size, or increase the canvas.");
  const outlineCommands = referenceEvidenceLimits.maxOutlineCommandsPerNode - remainingCommands;
  const outlineBytes = referenceEvidenceLimits.maxOutlineBytesPerNode - remainingBytes;
  return {
    config, pack, claim, sources: lockedSources, label, claimLines, labelOutline, claimOutlines,
    layout: { x: config.x, y: config.y, width: config.maxWidth, height, accentWidth, radius, labelX: config.x + accentWidth + padding, labelBaseline, claimX: config.x + accentWidth + padding, claimFirstBaseline, claimLineHeight },
    outlineCommands, outlineBytes,
  };
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function referenceEvidenceSvg(prepared: PreparedReferenceEvidence) {
  const { config, layout } = prepared;
  const labelPath = `<path d="${prepared.labelOutline.pathData}" transform="translate(${layout.labelX - prepared.labelOutline.x1} ${layout.labelBaseline})"/>`;
  if (config.mode === "source-chip") {
    const accessible = xml(prepared.label);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${config.canvasWidth}" height="${config.canvasHeight}" role="img" aria-labelledby="evidence-title"><title id="evidence-title">${accessible}</title><rect x="${layout.x}" y="${layout.y}" width="${layout.width}" height="${layout.height}" rx="${layout.radius}" fill="#071015" fill-opacity="0.92"/><rect x="${layout.x}" y="${layout.y}" width="${layout.accentWidth}" height="${layout.height}" rx="${layout.accentWidth / 2}" fill="${config.accent.color}" fill-opacity="${config.accent.opacity}"/><g fill="${config.color.color}" fill-opacity="${config.color.opacity}">${labelPath}</g></svg>`;
  }
  const claimPaths = prepared.claimOutlines.map((item, index) => `<path d="${item.pathData}" transform="translate(${layout.claimX - item.x1} ${layout.claimFirstBaseline + index * layout.claimLineHeight})"/>`).join("");
  const accessible = xml([prepared.label, ...prepared.claimLines].join("\n"));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${config.canvasWidth}" height="${config.canvasHeight}" role="img" aria-labelledby="evidence-title"><title id="evidence-title">${accessible}</title><rect x="${layout.x}" y="${layout.y}" width="${layout.width}" height="${layout.height}" rx="${layout.radius}" fill="#071015" fill-opacity="0.92"/><rect x="${layout.x}" y="${layout.y}" width="${layout.accentWidth}" height="${layout.height}" rx="${layout.accentWidth / 2}" fill="${config.accent.color}" fill-opacity="${config.accent.opacity}"/><g fill="${config.accent.color}" fill-opacity="${config.accent.opacity}">${labelPath}</g><g fill="${config.color.color}" fill-opacity="${config.color.opacity}">${claimPaths}</g></svg>`;
}
