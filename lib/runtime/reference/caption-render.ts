import type { CaptionCue, CaptionLimits, CaptionTrack } from "../../interchange/captions";
import { CaptionInterchangeError, cutCaptionAppearanceLimits, parseSubRip, parseWebVtt } from "../../interchange/captions";
import { hash } from "../../core/stable";
import type {
  CutAVIR,
  IRComposition,
  IRNode,
  IRTranscriptBindingV1,
  IRValue,
} from "../../language/ir";
import {
  cutAudioProxyAlignmentContractV1,
  cutAudioProxyAlignmentContractV2,
  cutAudioProxyAlignmentIntegrity,
  type CutAudioProxyAlignment,
  type CutAudioProxyAlignmentWithoutIntegrity,
} from "../../language/audio-proxy-alignment";
import type { LockedResourceProbe } from "../../language/lock";
import {
  addRational,
  compareRational,
  rational,
  rationalToNumber,
  subtractRational,
  zeroRational,
  type Rational,
} from "../../language/rational";
import { cutTranscriptHasUnsafeUnicodeScalar } from "../../language/transcript-contract";
import {
  CutTranscriptTimelineCaptionError,
  cutTranscriptCaptionIdentity,
  cutTranscriptTimelineCaptionProjection,
  type CutTranscriptTimelineCaptionWord,
} from "../../language/transcript-timeline-edit";
import { lockedFontBytesIdentity, lockedGlyphRun, parseLockedOpenTypeFont, type LockedGlyphRun, type LockedOpenTypeFont } from "./locked-font";
import { referenceMediaProfileResourceState } from "./media-profile-state";

export const referenceCaptionLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxCues: 10_000,
  maxLines: 40_000,
  maxLinesPerCue: 4,
  maxCueTextBytes: 4_096,
  maxTextBytes: 1024 * 1024,
  maxCodePointsPerLine: 240,
  maxFontBytes: 16 * 1024 * 1024,
  maxFontGlyphs: 100_000,
  maxOutlineCommandsPerCue: 20_000,
  maxOutlineCommandsPerTrack: 500_000,
  maxOutlineBytesPerCue: 2 * 1024 * 1024,
  maxOutlineBytesPerTrack: 4 * 1024 * 1024,
  maxSessionOutlineCommands: 2_000_000,
  maxSessionOutlineBytes: 32 * 1024 * 1024,
  maxNodesPerComposition: 64,
  maxSessionResourceBytes: 64 * 1024 * 1024,
} satisfies CaptionLimits & { maxCodePointsPerLine: number; maxFontBytes: number; maxFontGlyphs: number; maxOutlineCommandsPerCue: number; maxOutlineCommandsPerTrack: number; maxOutlineBytesPerCue: number; maxOutlineBytesPerTrack: number; maxSessionOutlineCommands: number; maxSessionOutlineBytes: number; maxNodesPerComposition: number; maxSessionResourceBytes: number });

export type ReferenceCaptionFormat = "webvtt" | "srt";
export type ReferenceCaptionPosition = "cue" | "top" | "bottom";
export type ReferenceCaptionAlignment = "cue" | "left" | "center" | "right";
export type ReferenceCaptionFont = LockedOpenTypeFont;

/**
 * Transcript captions may use modest horizontal compression, but never the
 * arbitrary squashing previously permitted by the generic caption renderer.
 * The locked-font preflight is authoritative; approximate wrapping only
 * chooses a deterministic word boundary before those glyphs are available.
 */
export const referenceTranscriptCaptionMinimumHorizontalScale = 0.85;
export const referenceTranscriptCaptionApproximateCodePointsPerEm = 2;

export type ReferenceCaptionAppearanceConfig = {
  nodeId: string;
  fontId: string;
  size: number;
  color: string;
  background: string;
  position: ReferenceCaptionPosition;
  align: ReferenceCaptionAlignment;
  safeX: number;
  safeY: number;
  maxWidth: number;
  padding: number;
  radius: number;
  lineHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  minimumHorizontalScale?: number;
};

export type ReferenceCaptionConfig = ReferenceCaptionAppearanceConfig & {
  sourceId: string;
  format: ReferenceCaptionFormat;
};

export type ReferenceTranscriptCaptionConfig =
  ReferenceCaptionAppearanceConfig & Readonly<{
    transcriptBindingId: string;
    transcriptCaptionIdentity: string;
    maxWords: number;
    groupingAlgorithm: "cut-transcript-caption-groups-v2";
    meaningfulGap: Rational;
    softLineCodePointBudget: number;
    minimumHorizontalScale: number;
    track: CaptionTrack;
    trackIdentity: string;
  }>;

export type PreparedReferenceCaptions = {
  node: IRNode;
  config: ReferenceCaptionAppearanceConfig;
  track: CaptionTrack;
  font: ReferenceCaptionFont;
  outlines: ReadonlyMap<string, readonly LockedGlyphRun[]>;
  outlineCommands: number;
  outlineBytes: number;
};

type CachedCaptionTrack = {
  track: CaptionTrack;
  format: ReferenceCaptionFormat;
  byteLength: number;
  sha256: string;
};

export type ReferenceCaptionPreparationCache = {
  fonts: Map<string, ReferenceCaptionFont>;
  tracks: Map<string, CachedCaptionTrack>;
};

export function createReferenceCaptionPreparationCache(): ReferenceCaptionPreparationCache {
  return { fonts: new Map(), tracks: new Map() };
}

export type ReferenceCaptionLayout = {
  box: { x: number; y: number; width: number; height: number };
  text: { x: number; firstBaseline: number; anchor: "start" | "middle" | "end"; lineHeight: number; maximumLineWidth: number };
};

const captionLimits: CaptionLimits = {
  maxBytes: referenceCaptionLimits.maxBytes,
  maxCues: referenceCaptionLimits.maxCues,
  maxLines: referenceCaptionLimits.maxLines,
  maxLinesPerCue: referenceCaptionLimits.maxLinesPerCue,
  maxCueTextBytes: referenceCaptionLimits.maxCueTextBytes,
  maxTextBytes: referenceCaptionLimits.maxTextBytes,
};

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

export class ReferenceCaptionLegibilityError extends Error {
  readonly code = "CUT_CAPTION_LEGIBILITY";
  readonly path: string;
  readonly source: Readonly<{
    module: string;
    line: number;
    column: number;
    nodeId: string;
  }>;

  constructor(
    node: IRNode,
    readonly cueId: string,
    readonly lineNumber: number,
    readonly requiredScale: number,
    readonly minimumScale: number,
  ) {
    const { module, span } = node.provenance;
    super(
      `CUT_CAPTION_LEGIBILITY: Reference captions ${node.op} at ${location(node)} `
      + `cue ${cueId} line ${lineNumber} would require horizontal scale below `
      + `${minimumScale}; shorten the cue, reduce size or padding, or increase maxWidth.`,
    );
    this.name = "ReferenceCaptionLegibilityError";
    this.path = `$.nodes[${JSON.stringify(node.id)}]`;
    this.source = Object.freeze({
      module,
      line: span.start.line,
      column: span.start.column,
      nodeId: node.id,
    });
  }
}

function fail(node: IRNode, detail: string): never {
  throw new Error(`Reference captions ${node.op} at ${location(node)} ${detail}`);
}

function finiteQuantity(node: IRNode, name: string, value: IRValue | undefined, dimension: string, unit: string, fallback: number) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) fail(node, `input “${name}” must be a ${dimension} quantity in ${unit}.`);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, `input “${name}” must be finite.`);
  return result;
}

function bounded(node: IRNode, name: string, value: number, minimum: number, maximum: number) {
  if (value < minimum || value > maximum) fail(node, `input “${name}” must be between ${minimum} and ${maximum}.`);
  return value;
}

function resource(node: IRNode, ir: CutAVIR, name: string, expected: "data" | "font") {
  const value = node.inputs[name];
  if (value?.kind !== "resource-ref") fail(node, `requires locked ${expected === "data" ? "DataAsset" : "FontAsset"} input “${name}”.`);
  const resolved = ir.resources[value.id];
  if (!resolved || resolved.kind !== expected) fail(node, `input “${name}” must reference a ${expected === "data" ? "DataAsset" : "FontAsset"}.`);
  return value.id;
}

function stringChoice<T extends string>(node: IRNode, name: string, value: IRValue | undefined, allowed: readonly T[], fallback?: T): T {
  if (value === undefined) {
    if (fallback === undefined) fail(node, `requires String input “${name}”.`);
    return fallback;
  }
  if (value.kind !== "string" || !allowed.includes(value.value as T)) fail(node, `input “${name}” must be one of: ${allowed.join(", ")}.`);
  return value.value as T;
}

function color(node: IRNode, name: string, value: IRValue | undefined, fallback: string) {
  const result = value === undefined ? fallback : value.kind === "color" ? value.value : fail(node, `input “${name}” must be a Color.`);
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(result)) fail(node, `input “${name}” must be a six- or eight-digit CUT color literal.`);
  return result.toLowerCase();
}

function referenceCaptionAppearanceConfig(
  node: IRNode,
  ir: CutAVIR,
  composition: IRComposition,
): ReferenceCaptionAppearanceConfig {
  if (node.domain !== "visual") fail(node, `must have visual domain, found ${node.domain}.`);
  if (node.children.length) fail(node, `is a source and cannot contain child nodes.`);
  if (Object.keys(node.properties).length) fail(node, `has no settable or animatable properties.`);
  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  if (node.sceneId && (!scene || !composition.sceneIds.includes(node.sceneId))) fail(node, `belongs to a missing or different composition scene.`);
  const ownerDuration = scene?.duration ?? composition.duration;
  if (compareRational(node.interval.start, zeroRational) < 0 || compareRational(node.interval.duration, zeroRational) <= 0 || compareRational(addRational(node.interval.start, node.interval.duration), ownerDuration) > 0) {
    fail(node, `destination interval must be positive and remain inside its owning scene or timeline.`);
  }
  const fontId = resource(node, ir, "font", "font");
  const size = bounded(
    node,
    "size",
    finiteQuantity(node, "size", node.inputs.size, "length", "px", 52),
    cutCaptionAppearanceLimits.minimumSizePx,
    cutCaptionAppearanceLimits.maximumSizePx,
  );
  const safeX = bounded(node, "safeX", finiteQuantity(node, "safeX", node.inputs.safeX, "ratio", "ratio", 0.05), 0, 0.25);
  const safeY = bounded(node, "safeY", finiteQuantity(node, "safeY", node.inputs.safeY, "ratio", "ratio", 0.08), 0, 0.25);
  const maxWidth = bounded(node, "maxWidth", finiteQuantity(node, "maxWidth", node.inputs.maxWidth, "ratio", "ratio", 0.9), 0.25, 1);
  const padding = bounded(node, "padding", finiteQuantity(node, "padding", node.inputs.padding, "length", "px", 16), 0, 128);
  const radius = bounded(node, "radius", finiteQuantity(node, "radius", node.inputs.radius, "length", "px", 12), 0, 64);
  const lineHeight = bounded(node, "lineHeight", finiteQuantity(node, "lineHeight", node.inputs.lineHeight, "ratio", "ratio", 1.2), 1, 2);
  if (maxWidth > 1 - 2 * safeX + Number.EPSILON) fail(node, `input “maxWidth” must fit inside the horizontal safe area defined by “safeX”.`);
  const safeWidth = composition.width * maxWidth;
  if (safeWidth - 2 * padding < size) fail(node, `caption text area is smaller than one glyph at the configured size; increase maxWidth or reduce padding/size.`);
  return {
    nodeId: node.id,
    fontId,
    size,
    color: color(node, "color", node.inputs.color, "#ffffff"),
    background: color(node, "background", node.inputs.background, "#000000d9"),
    position: stringChoice(node, "position", node.inputs.position, ["cue", "top", "bottom"] as const, "cue"),
    align: stringChoice(node, "align", node.inputs.align, ["cue", "left", "center", "right"] as const, "cue"),
    safeX,
    safeY,
    maxWidth,
    padding,
    radius,
    lineHeight,
    canvasWidth: composition.width,
    canvasHeight: composition.height,
  };
}

/**
 * Reduce a typed Captions node to the closed CPU-reference configuration.
 * This is deliberately reusable by validation and rendering so loaded IR
 * cannot acquire looser semantics than authored CUT source.
 */
export function referenceCaptionConfig(node: IRNode, ir: CutAVIR, composition: IRComposition): ReferenceCaptionConfig | undefined {
  if (node.op !== "cut.visual.captions") return undefined;
  return {
    ...referenceCaptionAppearanceConfig(node, ir, composition),
    sourceId: resource(node, ir, "source", "data"),
    format: stringChoice(node, "format", node.inputs.format, ["webvtt", "srt"] as const),
  };
}

export const referenceTranscriptCaptionMeaningfulGap = rational(1, 4);
const transcriptCaptionGroupingAlgorithm =
  "cut-transcript-caption-groups-v2" as const;
const sentenceFinalWord = /[.!?…](?:["'”’)\]}]+)?$/u;
const transcriptCaptionInputs = new Set([
  "font",
  "maxWords",
  "size",
  "color",
  "background",
  "position",
  "align",
  "safeX",
  "safeY",
  "maxWidth",
  "padding",
  "radius",
  "lineHeight",
  "transcriptBindingId",
  "transcriptCaptionIdentity",
]);

function transcriptCaptionString(
  node: IRNode,
  name: string,
  pattern?: RegExp,
) {
  const value = node.inputs[name];
  if (value?.kind !== "string" || (pattern && !pattern.test(value.value))) {
    fail(node, `compiler input “${name}” is missing or malformed.`);
  }
  return value.value;
}

function transcriptCaptionMaxWords(node: IRNode) {
  const value = node.inputs.maxWords;
  if (value === undefined) return 6;
  if (value.kind !== "quantity"
    || value.dimension !== "scalar"
    || value.unit !== "scalar"
    || value.magnitude.denominator !== "1"
    || !/^[1-9][0-9]{0,2}$/u.test(value.magnitude.numerator)) {
    fail(node, "input “maxWords” must be one whole Number from 1 through 64.");
  }
  const result = Number(value.magnitude.numerator);
  if (!Number.isSafeInteger(result) || result < 1 || result > 64) {
    fail(node, "input “maxWords” must be one whole Number from 1 through 64.");
  }
  return result;
}

function transcriptWordText(
  words: readonly IRTranscriptBindingV1["words"][number][],
) {
  return words.map((word, index) =>
    `${index > 0 && word.join === "space" ? " " : ""}${word.text}`).join("");
}

function transcriptCaptionSoftLineCodePointBudget(
  appearance: ReferenceCaptionAppearanceConfig,
) {
  const textWidth = appearance.canvasWidth * appearance.maxWidth
    - 2 * appearance.padding;
  return Math.max(
    1,
    Math.floor(
      textWidth
      / appearance.size
      * referenceTranscriptCaptionApproximateCodePointsPerEm,
    ),
  );
}

function balancedTranscriptCaptionLines(
  words: readonly IRTranscriptBindingV1["words"][number][],
  softLineCodePointBudget: number,
) {
  const complete = transcriptWordText(words);
  if (words.length < 2 || codePoints(complete) <= softLineCodePointBudget) {
    return [complete];
  }
  let best:
    | Readonly<{
      lines: [string, string];
      score: readonly [number, number, number, number];
    }>
    | undefined;
  for (let split = 1; split < words.length; split += 1) {
    if (words[split]?.join !== "space") continue;
    const left = transcriptWordText(words.slice(0, split));
    const right = transcriptWordText(words.slice(split));
    const leftLength = codePoints(left);
    const rightLength = codePoints(right);
    const score = [
      Math.max(leftLength, rightLength),
      Math.abs(leftLength - rightLength),
      Math.abs(words.length - 2 * split),
      split,
    ] as const;
    if (!best || score.some(
      (value, index) => value < best!.score[index]!
        && score.slice(0, index).every(
          (prior, priorIndex) => prior === best!.score[priorIndex],
        ),
    )) {
      best = { lines: [left, right], score };
    }
  }
  return best?.lines ?? [complete];
}

function authenticatedTranscriptAudioProxy(
  ir: CutAVIR,
  audio: CutAVIR["resources"][string],
  binding: IRTranscriptBindingV1,
) {
  const selectedState = referenceMediaProfileResourceState(ir, audio.id);
  if (selectedState?.selected !== "proxy" || !selectedState.authoredProxy) return false;
  const metadata = audio.metadata as {
    activeMediaVariant?: unknown;
    probe?: LockedResourceProbe;
    audioProxyAlignment?: CutAudioProxyAlignment;
  } | undefined;
  const alignment = metadata?.audioProxyAlignment;
  if (metadata?.activeMediaVariant !== "proxy"
    || metadata.probe?.kind !== "media"
    || !alignment
    || alignment.format !== "cut-audio-proxy-alignment"
    || alignment.decision !== "equivalent"
    || !((alignment.version === cutAudioProxyAlignmentContractV1.version
      && alignment.method === cutAudioProxyAlignmentContractV1.method)
      || (alignment.version === cutAudioProxyAlignmentContractV2.version
        && alignment.method === cutAudioProxyAlignmentContractV2.method))) {
    return false;
  }
  const { integrity, ...withoutIntegrity } = alignment;
  if (integrity !== cutAudioProxyAlignmentIntegrity(
    withoutIntegrity as CutAudioProxyAlignmentWithoutIntegrity,
  )) return false;
  const selected = metadata.probe.selected.audio;
  const stream = selected === undefined
    ? undefined
    : metadata.probe.identity.streams.find(
      (candidate) => candidate.type === "audio"
        && candidate.index === selected.streamIndex,
    );
  return audio.sha256 === alignment.proxy.fileSha256
    && alignment.master.fileSha256 === binding.media.sha256
    && alignment.master.streamIndex === binding.media.audioStreamIndex
    && alignment.master.sourceSampleRate === binding.media.audioSampleRate
    && alignment.proxy.streamIndex === selected?.streamIndex
    && alignment.proxy.sourceSampleRate === binding.media.audioSampleRate
    && stream?.sampleRate === binding.media.audioSampleRate
    && compareRational(selected?.duration ?? zeroRational, binding.media.duration) === 0
    && (audio.streamSelection?.audio === undefined
      || audio.streamSelection.audio === alignment.proxy.streamIndex);
}

function validateTranscriptCaptionBinding(
  node: IRNode,
  ir: CutAVIR,
  composition: IRComposition,
  binding: IRTranscriptBindingV1,
) {
  if (binding.version !== 1
    || binding.kind !== "transcript-edit"
    || binding.compositionId !== composition.id
    || binding.sceneId !== node.sceneId) {
    fail(node, `transcript binding “${binding.id}” does not belong to this exact composition and scene.`);
  }
  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  if (!scene) fail(node, "must belong to one scene-owned transcript binding.");
  const transcript = ir.resources[binding.transcriptResourceId];
  const audio = ir.resources[binding.audioResourceId];
  if (transcript?.kind !== "data" || audio?.kind !== "audio") {
    fail(node, `transcript binding “${binding.id}” lost its DataAsset or AudioAsset authority.`);
  }
  const masterAuthority = (audio.sha256 === undefined
    || audio.sha256 === binding.media.sha256)
    && (audio.streamSelection?.audio === undefined
      || audio.streamSelection.audio === binding.media.audioStreamIndex);
  if (!masterAuthority && !authenticatedTranscriptAudioProxy(ir, audio, binding)) {
    fail(node, `transcript binding “${binding.id}” media authority contradicts its locked AudioAsset.`);
  }
  if (!binding.words.length
    || binding.words.length > 4_096
    || binding.selectedWordCount !== binding.words.length
    || binding.from !== binding.words[0]?.id
    || binding.through !== binding.words.at(-1)?.id) {
    fail(node, `transcript binding “${binding.id}” has contradictory selected-word cardinality or endpoints.`);
  }
  const selectedIds = binding.words.map((word) => word.id);
  if (binding.selectedIdsSha256 !== hash(JSON.stringify(selectedIds))) {
    fail(node, `transcript binding “${binding.id}” selected-word identity is stale.`);
  }
  if (binding.text !== transcriptWordText(binding.words)) {
    fail(node, `transcript binding “${binding.id}” text contradicts its selected words.`);
  }
  const first = binding.words[0]!;
  const last = binding.words.at(-1)!;
  if (compareRational(binding.sourceRange.start, first.start) !== 0
    || compareRational(
      addRational(binding.sourceRange.start, binding.sourceRange.duration),
      last.end,
    ) !== 0
    || compareRational(
      binding.sourceRange.duration,
      binding.destinationRange.duration,
    ) !== 0) {
    fail(node, `transcript binding “${binding.id}” source/destination ranges do not exactly cover its selected words.`);
  }
  const wordIds = new Set<string>();
  let previous: IRTranscriptBindingV1["words"][number] | undefined;
  for (const word of binding.words) {
    if (!word.id
      || wordIds.has(word.id)
      || !word.text
      || cutTranscriptHasUnsafeUnicodeScalar(word.text)
      || /\s/u.test(word.text)
      || (word.join !== "none" && word.join !== "space")
      || (word.speaker !== undefined
        && (!word.speaker
          || word.speaker !== word.speaker.trim()
          || cutTranscriptHasUnsafeUnicodeScalar(word.speaker)))
      || compareRational(word.start, binding.sourceRange.start) < 0
      || compareRational(word.end, word.start) <= 0
      || compareRational(
        word.end,
        addRational(binding.sourceRange.start, binding.sourceRange.duration),
      ) > 0
      || (previous !== undefined
        && compareRational(word.start, previous.end) < 0)) {
      fail(node, `transcript binding “${binding.id}” contains malformed, overlapping, or out-of-range word “${word.id}”.`);
    }
    wordIds.add(word.id);
    previous = word;
  }
  const destinationEnd = addRational(
    binding.destinationRange.start,
    binding.destinationRange.duration,
  );
  const nodeEnd = addRational(node.interval.start, node.interval.duration);
  if (compareRational(binding.destinationRange.start, zeroRational) < 0
    || compareRational(destinationEnd, scene.duration) > 0
    || compareRational(binding.destinationRange.start, node.interval.start) < 0
    || compareRational(destinationEnd, nodeEnd) > 0) {
    fail(node, `transcript binding “${binding.id}” destination must fit completely inside the caption node and owning scene.`);
  }
}

function transcriptCaptionTrack(
  node: IRNode,
  binding: IRTranscriptBindingV1,
  projectedWords: readonly CutTranscriptTimelineCaptionWord[],
  maxWords: number,
  softLineCodePointBudget: number,
) {
  const groups: CutTranscriptTimelineCaptionWord[][] = [];
  let group: CutTranscriptTimelineCaptionWord[] = [];
  for (const word of projectedWords) {
    const previous = group.at(-1);
    const gap = previous
      ? subtractRational(word.destinationStart, previous.destinationEnd)
      : zeroRational;
    const shouldBreak = group.length > 0
      && (
        group.length >= maxWords
        || word.speaker !== group[0]?.speaker
        || compareRational(gap, referenceTranscriptCaptionMeaningfulGap) >= 0
        || sentenceFinalWord.test(previous!.text)
      );
    if (shouldBreak) {
      groups.push(group);
      group = [];
    }
    group.push(word);
  }
  if (group.length) groups.push(group);
  const cues = groups.map((words) => {
    const first = words[0]!;
    const last = words.at(-1)!;
    const start = subtractRational(
      first.destinationStart,
      node.interval.start,
    );
    const end = subtractRational(
      last.destinationEnd,
      node.interval.start,
    );
    const lines = balancedTranscriptCaptionLines(
      words,
      softLineCodePointBudget,
    );
    return {
      id: `transcript-${hash({
        bindingId: binding.id,
        from: first.id,
        through: last.id,
        start,
        end,
        lines,
      }).slice(0, 24)}`,
      start,
      end,
      lines,
    };
  });
  return {
    format: "cut-caption-track" as const,
    version: 1 as const,
    cues,
  };
}

/**
 * Bind one public TranscriptCaptions node to the exact authenticated
 * TranscriptEdit ledger, then derive a normal CaptionTrack. Cue formation is
 * deterministic: maxWords is a hard ceiling; speaker changes, sentence-final
 * punctuation, and an inter-word gap of at least 250ms close the current cue.
 */
export function referenceTranscriptCaptionConfig(
  node: IRNode,
  ir: CutAVIR,
  composition: IRComposition,
): ReferenceTranscriptCaptionConfig | undefined {
  if (node.op !== "cut.visual.transcript_captions") return undefined;
  for (const name of Object.keys(node.inputs)) {
    if (!transcriptCaptionInputs.has(name)) {
      fail(node, `does not execute input “${name}”.`);
    }
  }
  const transcriptBindingId = transcriptCaptionString(
    node,
    "transcriptBindingId",
  );
  const matches = (ir.transcriptBindings ?? []).filter(
    (binding) => binding.id === transcriptBindingId,
  );
  if (matches.length !== 1) {
    fail(node, `must reference exactly one transcript binding “${transcriptBindingId}”; found ${matches.length}.`);
  }
  const binding = matches[0]!;
  validateTranscriptCaptionBinding(node, ir, composition, binding);
  const transcriptCaptionIdentity = transcriptCaptionString(
    node,
    "transcriptCaptionIdentity",
    /^[a-f0-9]{64}$/u,
  );
  let expectedCaptionIdentity: string;
  let projection;
  try {
    expectedCaptionIdentity = cutTranscriptCaptionIdentity(ir, binding);
    projection = cutTranscriptTimelineCaptionProjection(ir, binding);
  } catch (error) {
    if (!(error instanceof CutTranscriptTimelineCaptionError)) throw error;
    fail(node, error.message);
  }
  if (transcriptCaptionIdentity !== expectedCaptionIdentity) {
    fail(node, `compiler caption identity does not authenticate transcript binding “${binding.id}”.`);
  }
  const maxWords = transcriptCaptionMaxWords(node);
  const appearance = referenceCaptionAppearanceConfig(node, ir, composition);
  const softLineCodePointBudget =
    transcriptCaptionSoftLineCodePointBudget(appearance);
  const track = transcriptCaptionTrack(
    node,
    binding,
    projection.words,
    maxWords,
    softLineCodePointBudget,
  );
  if (!track.cues.length || track.cues.length > referenceCaptionLimits.maxCues) {
    fail(node, `derived cue count must be between 1 and ${referenceCaptionLimits.maxCues}.`);
  }
  const trackIdentity = hash({
    algorithm: transcriptCaptionGroupingAlgorithm,
    transcriptBindingId,
    transcriptCaptionIdentity,
    maxWords,
    meaningfulGap: referenceTranscriptCaptionMeaningfulGap,
    softLineCodePointBudget,
    minimumHorizontalScale:
      referenceTranscriptCaptionMinimumHorizontalScale,
    track,
  });
  return {
    ...appearance,
    minimumHorizontalScale:
      referenceTranscriptCaptionMinimumHorizontalScale,
    transcriptBindingId,
    transcriptCaptionIdentity,
    maxWords,
    groupingAlgorithm: transcriptCaptionGroupingAlgorithm,
    meaningfulGap: referenceTranscriptCaptionMeaningfulGap,
    softLineCodePointBudget,
    track,
    trackIdentity,
  };
}

function parseTrack(node: IRNode, config: ReferenceCaptionConfig, bytes: Buffer) {
  try { return config.format === "webvtt" ? parseWebVtt(bytes, captionLimits) : parseSubRip(bytes, captionLimits); }
  catch (error) {
    if (error instanceof CaptionInterchangeError) fail(node, `cannot parse locked ${config.format} source (${error.code}): ${error.message}`);
    throw error;
  }
}

function codePoints(value: string) { return [...value].length; }

function requiredCaptionHorizontalScale(
  maximumLineWidth: number,
  outline: LockedGlyphRun,
) {
  if (!Number.isFinite(outline.width) || outline.width <= 0) return 0;
  return Math.min(1, maximumLineWidth / outline.width);
}

/** Parse, bound, and validate all external bytes before frame rendering. */
export function prepareReferenceCaptions(
  node: IRNode,
  config: ReferenceCaptionConfig,
  captionBytes: Buffer,
  fontLocator: string,
  fontBytes: Buffer,
  cache?: ReferenceCaptionPreparationCache,
): PreparedReferenceCaptions {
  const captionSha256 = lockedFontBytesIdentity(captionBytes), cachedTrack = cache?.tracks.get(config.sourceId);
  if (cachedTrack && (cachedTrack.format !== config.format || cachedTrack.byteLength !== captionBytes.byteLength || cachedTrack.sha256 !== captionSha256)) {
    fail(node, "cached caption-track identity does not match the current locked bytes or explicit format.");
  }
  const track = cachedTrack?.track ?? parseTrack(node, config, captionBytes);
  if (!cachedTrack) cache?.tracks.set(config.sourceId, { track, format: config.format, byteLength: captionBytes.byteLength, sha256: captionSha256 });
  return prepareReferenceCaptionTrack(
    node,
    config,
    track,
    fontLocator,
    fontBytes,
    cache,
  );
}

/**
 * Preflight and shape an already typed exact-rational CaptionTrack. This is
 * the shared rendering boundary for parsed WebVTT/SRT and transcript-derived
 * cues; it deliberately imposes no millisecond time quantization.
 */
export function prepareReferenceCaptionTrack(
  node: IRNode,
  config: ReferenceCaptionAppearanceConfig,
  track: CaptionTrack,
  fontLocator: string,
  fontBytes: Buffer,
  cache?: ReferenceCaptionPreparationCache,
): PreparedReferenceCaptions {
  if (track.format !== "cut-caption-track"
    || track.version !== 1
    || track.cues.length > referenceCaptionLimits.maxCues) {
    fail(node, `caption track must be closed v1 with at most ${referenceCaptionLimits.maxCues} cues.`);
  }
  const cueIds = new Set<string>();
  let previousEnd: Rational | undefined;
  let totalLines = 0;
  let totalTextBytes = 0;
  for (const [cueIndex, cue] of track.cues.entries()) {
    const cueTextBytes = cue.lines.reduce(
      (total, line) => total + Buffer.byteLength(line, "utf8"),
      0,
    );
    totalLines += cue.lines.length;
    totalTextBytes += cueTextBytes;
    if (compareRational(cue.end, node.interval.duration) > 0) {
      fail(node, `cue ${cue.id} at index ${cueIndex} ends after the Captions node duration.`);
    }
    if (!cue.id
      || cueIds.has(cue.id)
      || compareRational(cue.start, zeroRational) < 0
      || compareRational(cue.end, cue.start) <= 0
      || (previousEnd !== undefined
        && compareRational(cue.start, previousEnd) < 0)
      || cue.lines.length < 1
      || cue.lines.length > referenceCaptionLimits.maxLinesPerCue
      || cue.lines.some((line) => !line)
      || cueTextBytes > referenceCaptionLimits.maxCueTextBytes
      || totalLines > referenceCaptionLimits.maxLines
      || totalTextBytes > referenceCaptionLimits.maxTextBytes) {
      fail(node, `cue ${cue.id || "(empty)"} at index ${cueIndex} violates exact timing, ordering, identity, line, or text bounds.`);
    }
    cueIds.add(cue.id);
    previousEnd = cue.end;
  }
  let font: ReferenceCaptionFont;
  try {
    const cachedFont = cache?.fonts.get(config.fontId);
    font = cachedFont ?? parseLockedOpenTypeFont(fontBytes, fontLocator, {
      maxBytes: referenceCaptionLimits.maxFontBytes,
      maxGlyphs: referenceCaptionLimits.maxFontGlyphs,
    });
    if (cachedFont && (cachedFont.locator !== fontLocator || cachedFont.byteLength !== fontBytes.byteLength || cachedFont.sha256 !== lockedFontBytesIdentity(fontBytes))) {
      throw new Error("cached locked font identity does not match the current locked bytes and locator.");
    }
    if (!cachedFont) cache?.fonts.set(config.fontId, font);
  } catch (error) {
    fail(node, error instanceof Error ? error.message : String(error));
  }
  const outlines = new Map<string, readonly LockedGlyphRun[]>();
  const prepared: PreparedReferenceCaptions = {
    node,
    config,
    track,
    font,
    outlines,
    outlineCommands: 0,
    outlineBytes: 0,
  };
  let trackCommands = 0, trackOutlineBytes = 0;
  for (const [cueIndex, cue] of track.cues.entries()) {
    if (compareRational(cue.end, node.interval.duration) > 0) fail(node, `cue ${cue.id} at index ${cueIndex} ends after the Captions node duration.`);
    if (cue.settings?.line?.unit === "line") fail(node, `cue ${cue.id} uses snap-to-line WebVTT placement, which the reference burn-in renderer does not implement.`);
    const cueOutlines: LockedGlyphRun[] = [];
    let cueCommands = 0, cueOutlineBytes = 0;
    for (const [lineIndex, line] of cue.lines.entries()) {
      if (codePoints(line) > referenceCaptionLimits.maxCodePointsPerLine) fail(node, `cue ${cue.id} line ${lineIndex + 1} exceeds the ${referenceCaptionLimits.maxCodePointsPerLine}-code-point render budget.`);
      const commandBudget = Math.min(referenceCaptionLimits.maxOutlineCommandsPerCue - cueCommands, referenceCaptionLimits.maxOutlineCommandsPerTrack - trackCommands);
      const byteBudget = Math.min(referenceCaptionLimits.maxOutlineBytesPerCue - cueOutlineBytes, referenceCaptionLimits.maxOutlineBytesPerTrack - trackOutlineBytes);
      if (commandBudget < 1) fail(node, `cue ${cue.id} exceeds a locked-font outline command budget before line ${lineIndex + 1}.`);
      if (byteBudget < 1) fail(node, `cue ${cue.id} exceeds a locked-font outline byte budget before line ${lineIndex + 1}.`);
      let outline: LockedGlyphRun;
      try { outline = lockedGlyphRun(font, line, config.size, { maxCommands: commandBudget, maxPathBytes: byteBudget }); }
      catch (error) { fail(node, `cue ${cue.id} line ${lineIndex + 1} ${error instanceof Error ? error.message : String(error)}`); }
      cueOutlines.push(outline);
      cueCommands += outline.commands;
      cueOutlineBytes += outline.pathBytes;
      trackCommands += outline.commands;
      trackOutlineBytes += outline.pathBytes;
    }
    if (cueCommands > referenceCaptionLimits.maxOutlineCommandsPerCue) fail(node, `cue ${cue.id} exceeds the ${referenceCaptionLimits.maxOutlineCommandsPerCue}-command locked-font outline budget.`);
    if (cueOutlineBytes > referenceCaptionLimits.maxOutlineBytesPerCue) fail(node, `cue ${cue.id} exceeds the ${referenceCaptionLimits.maxOutlineBytesPerCue}-byte locked-font outline budget.`);
    if (trackCommands > referenceCaptionLimits.maxOutlineCommandsPerTrack) fail(node, `caption track exceeds the ${referenceCaptionLimits.maxOutlineCommandsPerTrack}-command locked-font outline budget.`);
    if (trackOutlineBytes > referenceCaptionLimits.maxOutlineBytesPerTrack) fail(node, `caption track exceeds the ${referenceCaptionLimits.maxOutlineBytesPerTrack}-byte locked-font outline budget.`);
    outlines.set(cue.id, cueOutlines);
    try {
      const layout = captionLayout(
        prepared,
        cue,
        config.canvasWidth,
        config.canvasHeight,
        cueOutlines,
      );
      if (config.minimumHorizontalScale !== undefined) {
        for (const [lineIndex, outline] of cueOutlines.entries()) {
          const requiredScale = requiredCaptionHorizontalScale(
            layout.text.maximumLineWidth,
            outline,
          );
          if (requiredScale < config.minimumHorizontalScale) {
            throw new ReferenceCaptionLegibilityError(
              node,
              cue.id,
              lineIndex + 1,
              requiredScale,
              config.minimumHorizontalScale,
            );
          }
        }
      }
    }
    catch (error) {
      if (error instanceof ReferenceCaptionLegibilityError) throw error;
      fail(node, error instanceof Error ? error.message : String(error));
    }
  }
  prepared.outlineCommands = trackCommands;
  prepared.outlineBytes = trackOutlineBytes;
  return prepared;
}

/** Exact, end-exclusive cue lookup. Contiguous cues switch at one rational boundary. */
export function referenceCaptionCueAt(track: CaptionTrack, localTime: Rational): CaptionCue | undefined {
  if (compareRational(localTime, zeroRational) < 0) return undefined;
  let low = 0, high = track.cues.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), cue = track.cues[middle];
    if (compareRational(localTime, cue.start) < 0) high = middle - 1;
    else if (compareRational(localTime, cue.end) >= 0) low = middle + 1;
    else return cue;
  }
  return undefined;
}

function cuePercentage(value: Rational | undefined, fallback: number) {
  return value === undefined ? fallback : rationalToNumber(value) / 100;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function captionAlignment(config: ReferenceCaptionAppearanceConfig, cue: CaptionCue): "left" | "center" | "right" {
  if (config.align !== "cue") return config.align;
  const cueAlign = cue.settings?.align;
  if (cueAlign === "left" || cueAlign === "start") return "left";
  if (cueAlign === "right" || cueAlign === "end") return "right";
  return "center";
}

function cueOutlines(prepared: PreparedReferenceCaptions, cue: CaptionCue) {
  if (!prepared.track.cues.includes(cue)) throw new Error(`Caption cue ${cue.id} does not belong to the prepared locked track.`);
  const outlines = prepared.outlines.get(cue.id);
  if (!outlines) throw new Error(`Caption cue ${cue.id} has no preflighted locked-font outlines.`);
  return outlines;
}

function captionLayout(prepared: PreparedReferenceCaptions, cue: CaptionCue, width: number, height: number, outlines: readonly LockedGlyphRun[]): ReferenceCaptionLayout {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error("Reference caption canvas must use positive safe-integer dimensions.");
  const { config } = prepared, safeLeft = width * config.safeX, safeRight = width * (1 - config.safeX), safeTop = height * config.safeY, safeBottom = height * (1 - config.safeY);
  const configuredWidth = width * config.maxWidth, cueWidth = cue.settings?.size ? width * cuePercentage(cue.settings.size, config.maxWidth) : configuredWidth;
  const boxWidth = Math.min(configuredWidth, cueWidth), lineHeight = config.size * config.lineHeight;
  const contentTop = Math.min(...outlines.map((outline, index) => outline.y1 + index * lineHeight));
  const contentBottom = Math.max(...outlines.map((outline, index) => outline.y2 + index * lineHeight));
  const boxHeight = contentBottom - contentTop + 2 * config.padding;
  if (boxWidth - 2 * config.padding < config.size) throw new Error(`Caption cue ${cue.id} has no usable text width after its WebVTT size and CUT padding.`);
  if (boxHeight > safeBottom - safeTop + 1e-7) throw new Error(`Caption cue ${cue.id} does not fit inside the configured vertical safe area.`);

  const alignment = captionAlignment(config, cue), automaticPosition = alignment === "left" ? 0 : alignment === "right" ? 1 : 0.5;
  const horizontalAnchor = width * cuePercentage(cue.settings?.position?.value, automaticPosition);
  const positionAlign = cue.settings?.position?.align ?? (alignment === "left" ? "line-left" : alignment === "right" ? "line-right" : "center");
  const requestedX = positionAlign === "line-left" ? horizontalAnchor : positionAlign === "line-right" ? horizontalAnchor - boxWidth : horizontalAnchor - boxWidth / 2;
  const x = clamp(requestedX, safeLeft, safeRight - boxWidth);

  let requestedY = safeBottom - boxHeight;
  if (config.position === "top") requestedY = safeTop;
  else if (config.position === "cue" && cue.settings?.line?.unit === "percent") {
    const lineAnchor = height * cuePercentage(cue.settings.line.value, 1), lineAlign = cue.settings.line.align ?? "start";
    requestedY = lineAlign === "center" ? lineAnchor - boxHeight / 2 : lineAlign === "end" ? lineAnchor - boxHeight : lineAnchor;
  }
  const y = config.position === "bottom" ? safeBottom - boxHeight : clamp(requestedY, safeTop, safeBottom - boxHeight);
  const textX = alignment === "left" ? x + config.padding : alignment === "right" ? x + boxWidth - config.padding : x + boxWidth / 2;
  return {
    box: { x, y, width: boxWidth, height: boxHeight },
    text: {
      x: textX,
      firstBaseline: y + config.padding - contentTop,
      anchor: alignment === "left" ? "start" : alignment === "right" ? "end" : "middle",
      lineHeight,
      maximumLineWidth: boxWidth - 2 * config.padding,
    },
  };
}

export function referenceCaptionLayout(prepared: PreparedReferenceCaptions, cue: CaptionCue, width: number, height: number): ReferenceCaptionLayout {
  return captionLayout(prepared, cue, width, height, cueOutlines(prepared, cue));
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function svgColor(value: string) {
  return { color: value.slice(0, 7), opacity: value.length === 9 ? Number.parseInt(value.slice(7), 16) / 255 : 1 };
}

/**
 * Emit one transparent, full-canvas SVG surface. Authored line order and code
 * points are preserved. Glyph paths and bounds come directly from the locked
 * OpenType bytes; no host font lookup or SVG text shaping is involved.
 */
export function referenceCaptionSvg(prepared: PreparedReferenceCaptions, cue: CaptionCue, width: number, height: number) {
  const { config } = prepared, outlines = cueOutlines(prepared, cue), layout = captionLayout(prepared, cue, width, height, outlines), foreground = svgColor(config.color), background = svgColor(config.background);
  const title = xml(cue.lines.join("\n"));
  const lines = outlines.map((outline, index) => {
    const scaleX = requiredCaptionHorizontalScale(
      layout.text.maximumLineWidth,
      outline,
    ), displayedWidth = outline.width * scaleX;
    if (config.minimumHorizontalScale !== undefined
      && scaleX < config.minimumHorizontalScale) {
      throw new ReferenceCaptionLegibilityError(
        prepared.node,
        cue.id,
        index + 1,
        scaleX,
        config.minimumHorizontalScale,
      );
    }
    const desiredLeft = layout.text.anchor === "start" ? layout.text.x : layout.text.anchor === "end" ? layout.text.x - displayedWidth : layout.text.x - displayedWidth / 2;
    const translateX = desiredLeft - outline.x1 * scaleX, baseline = layout.text.firstBaseline + index * layout.text.lineHeight;
    return `<path d="${outline.pathData}" transform="translate(${translateX} ${baseline}) scale(${scaleX} 1)"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-labelledby="caption-title"><title id="caption-title">${title}</title><rect x="${layout.box.x}" y="${layout.box.y}" width="${layout.box.width}" height="${layout.box.height}" rx="${config.radius}" fill="${background.color}" fill-opacity="${background.opacity}"/><g fill="${foreground.color}" fill-opacity="${foreground.opacity}">${lines}</g></svg>`;
}
