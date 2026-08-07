import { hash, stableJsonStringify } from "../core/stable";
import type { IREditorial, IRNode, IRPictureTimeMap, IRProvenance, IRResource, IRValue, CutAVIR } from "../language/ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  type Rational,
  zeroRational,
} from "../language/rational";
import {
  CutInterchangeBackendRegistry,
  cutInterchangeBackendReportIdentity,
  defineCutInterchangeExportBackend,
  dispatchCutInterchangeExport,
  type CutInterchangeBackendDescriptor,
  type CutInterchangeBackendReportIdentity,
} from "./backend";
import {
  createCutOtioEditorialProfile,
  type CutOtioEditorialItem,
  type CutOtioEditorialLinkGroup,
  type CutOtioEditorialLinkedCut,
  type CutOtioEditorialLoss,
  type CutOtioEditorialProfile,
  type CutOtioEditorialRetime,
  type CutOtioEditorialTrack,
  type CutOtioEditorialTransition,
} from "./otio-editorial-profile";
import {
  cutOtioEditorialProfileV3Limits,
  cutOtioEditorialAudioLineageSha256,
  createCutOtioEditorialProfileV3,
  type CutOtioEditorialAudioLineageSegment,
  type CutOtioEditorialAudioOrigin,
  type CutOtioEditorialAudioOriginView,
  type CutOtioEditorialProfileV3,
} from "./otio-editorial-profile-v3";
import {
  createCutOtioEditorialProfileV4,
  cutOtioEditorialNestedLineageSha256,
  type CutOtioEditorialNestedLineageSegment,
  type CutOtioEditorialProfileV4,
} from "./otio-editorial-profile-v4";
import {
  createCutOtioDirectMediaAuthority,
  createCutOtioEditorialProfileV5,
  type CutOtioDirectMediaAuthority,
  type CutOtioEditorialProfileV5,
} from "./otio-editorial-profile-v5";
import {
  createCutOtioEditorialProfileV6,
  createCutOtioPictureTimeMapAuthority,
  cutOtioPictureTimeMapPolicy,
  type CutOtioEditorialProfileV6,
  type CutOtioPictureTimeMapAuthority,
} from "./otio-editorial-profile-v6";
import {
  executeTimelineEditPlan,
  timelineEditAudioPresentationOriginKey,
  timelineEditAudioPresentationOriginId,
  timelineEditAudioPresentationOriginTrackId,
  type TimelineEditItemV1,
  type TimelineEditTrackV1,
} from "../language/timeline-edit-operations";
import {
  isTimelineEditStaticPrecompOperand,
  timelineEditStaticPrecompPresentationInputNames,
} from "../language/timeline-edit-ir-adapter";

/**
 * OpenTimelineIO's native JSON adapter serializes RationalTime as two IEEE-754
 * doubles. CUT writes the reduced integer numerator as `value` and denominator
 * as `rate`; this preserves an exact CUT rational whenever both integers are in
 * JavaScript's exactly representable range. The exporter fails rather than
 * rounding a time it cannot preserve.
 */
export type OtioRationalTime = {
  OTIO_SCHEMA: "RationalTime.1";
  value: number;
  rate: number;
};

export type OtioTimeRange = {
  OTIO_SCHEMA: "TimeRange.1";
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
};

export type OtioMarker = {
  OTIO_SCHEMA: "Marker.2";
  name: string;
  metadata: Record<string, unknown>;
  marked_range: OtioTimeRange;
  color: string;
  comment: string;
};

export type OtioExternalReference = {
  OTIO_SCHEMA: "ExternalReference.1";
  name: string;
  metadata: Record<string, unknown>;
  target_url: string;
  available_range: OtioTimeRange | null;
  available_image_bounds: null;
};

export type OtioGap = {
  OTIO_SCHEMA: "Gap.1";
  name: string;
  metadata: Record<string, unknown>;
  source_range: OtioTimeRange;
  effects: [];
  markers: [];
  enabled: true;
};

export type OtioLinearTimeWarp = {
  OTIO_SCHEMA: "LinearTimeWarp.1";
  name: string;
  metadata: Record<string, unknown>;
  effect_name: "LinearTimeWarp";
  enabled: true;
  time_scalar: number;
};

export type OtioClip = {
  OTIO_SCHEMA: "Clip.2";
  name: string;
  metadata: Record<string, unknown>;
  source_range: OtioTimeRange;
  effects: OtioLinearTimeWarp[];
  markers: [];
  enabled: true;
  media_references: { DEFAULT_MEDIA: OtioExternalReference };
  active_media_reference_key: "DEFAULT_MEDIA";
};

export type OtioTransition = {
  OTIO_SCHEMA: "Transition.1";
  name: string;
  metadata: Record<string, unknown>;
  transition_type: "SMPTE_Dissolve";
  in_offset: OtioRationalTime;
  out_offset: OtioRationalTime;
  enabled: true;
};

export type OtioNestedStack = {
  OTIO_SCHEMA: "Stack.1";
  name: string;
  metadata: Record<string, unknown>;
  source_range: OtioTimeRange;
  effects: [];
  markers: [];
  enabled: true;
  children: [];
};

export type OtioTrackChild = OtioGap | OtioClip | OtioTransition | OtioNestedStack;

export type OtioTrack = {
  OTIO_SCHEMA: "Track.1";
  name: string;
  metadata: Record<string, unknown>;
  source_range: null;
  effects: [];
  markers: [];
  enabled: true;
  kind: "Video" | "Audio";
  children: OtioTrackChild[];
};

export type OtioStack = {
  OTIO_SCHEMA: "Stack.1";
  name: "tracks";
  metadata: Record<string, unknown>;
  source_range: null;
  effects: [];
  markers: OtioMarker[];
  enabled: true;
  children: OtioTrack[];
};

export type OtioTimeline = {
  OTIO_SCHEMA: "Timeline.1";
  name: string;
  metadata: Record<string, unknown>;
  global_start_time: null;
  tracks: OtioStack;
};

export type CutOtioUnsupportedSemantic = {
  code: string;
  category: "node" | "parameter" | "property" | "signal" | "effect" | "resource" | "timing";
  disposition: "omitted" | "partial" | "flattened" | "metadata-only";
  subject: {
    kind: "composition" | "node" | "signal" | "job" | "resource" | "linked-edit" | "semantic-match";
    id: string;
    op?: string;
    property?: string;
  };
  message: string;
  provenance?: IRProvenance;
  /** Exact bounded input evidence when omission would otherwise be ambiguous. */
  evidence?: {
    inputKind: IRValue["kind"];
    value?: string;
  };
};

export type CutOtioInterchangeReport = {
  format: "cut-otio-interchange-report";
  version: 1;
  backend: CutInterchangeBackendReportIdentity<"cut.otio-json">;
  source: {
    irFormat: CutAVIR["format"];
    irVersion: CutAVIR["version"];
    language: CutAVIR["language"];
    buildId: string;
    project: string;
    compositionId: string;
  };
  timing: {
    guarantee: "exact-rational";
    encoding: "RationalTime.value=numerator; RationalTime.rate=denominator";
    numericBoundary: "signed integers at or below Number.MAX_SAFE_INTEGER";
  };
  status: "lossless-editorial" | "lossy-editorial";
  exported: {
    sourceNodeIds: string[];
    videoTracks: number;
    audioTracks: number;
    clipInstances: number;
    gaps: number;
    markers: number;
    regions: number;
  };
  unsupportedSemantics: CutOtioUnsupportedSemantic[];
  editorialProfile?: {
    format: CutOtioEditorialProfile["format"];
    version: CutOtioEditorialProfile["version"];
    semanticSha256: string;
    targetScopedLosses: number;
    extension?: {
      format: CutOtioEditorialProfileV3["format"];
      version: CutOtioEditorialProfileV3["version"];
      semanticSha256: string;
      origins: number;
      views: number;
      lineageSegments: number;
      targetScopedLosses: number;
    };
    nestedExtension?: {
      format: CutOtioEditorialProfileV4["format"];
      version: CutOtioEditorialProfileV4["version"];
      semanticSha256: string;
      lineageSegments: number;
      placements: number;
    };
    directMediaExtension?: {
      format: CutOtioEditorialProfileV5["format"];
      version: CutOtioEditorialProfileV5["version"];
      semanticSha256: string;
      authorities: number;
    };
    pictureTimeMapExtension?: {
      format: CutOtioEditorialProfileV6["format"];
      version: CutOtioEditorialProfileV6["version"];
      semanticSha256: string;
      authorities: number;
    };
  };
};

function audioRegionTimeStretch(ir: CutAVIR, region: IRNode) {
  if (region.op !== "cut.edit.audio_region" || region.children.length !== 1) return undefined;
  const visited = new Set<string>();
  let current = ir.nodes[region.children[0]];
  for (let depth = 0; current && depth <= 32 && !visited.has(current.id); depth += 1) {
    visited.add(current.id);
    if (current.op === "cut.audio.time_stretch") return current;
    if (current.children.length !== 1) return undefined;
    current = ir.nodes[current.children[0]];
  }
  return undefined;
}

export type CutOtioExport = {
  timeline: OtioTimeline;
  report: CutOtioInterchangeReport;
};

export type CutOtioExportOptions = {
  compositionId?: string;
  /** Bound expansion of looped media into ordinary OTIO clips. */
  maxClipInstances?: number;
  /** Explicitly accept reported editorial loss where a compatibility path exists. */
  allowLossy?: boolean;
};

export const cutOtioInterchangeBackendDescriptor = Object.freeze({
  format: "cut-interchange-backend",
  version: 1,
  id: "cut.otio-json",
  implementation: "cut-otio-json-export-v1",
  target: "OpenTimelineIO JSON",
  direction: "export",
  sourceMeaning: "cut-av-ir-v3-editorial",
  artifact: Object.freeze({
    mediaType: "application/json",
    extension: ".otio",
  }),
  report: Object.freeze({
    format: "cut-otio-interchange-report",
    version: 1,
  }),
} as const satisfies CutInterchangeBackendDescriptor<"cut.otio-json", "cut-otio-interchange-report">);

export const cutOtioInterchangeBackendReportIdentity = cutInterchangeBackendReportIdentity(
  cutOtioInterchangeBackendDescriptor,
);

export class CutOtioExportError extends Error {
  readonly source?: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: string, message: string, readonly issue?: CutOtioUnsupportedSemantic) {
    super(message);
    this.name = "CutOtioExportError";
    if (issue?.provenance && issue.subject.kind === "node") {
      this.source = {
        module: issue.provenance.module,
        line: issue.provenance.span.start.line,
        column: issue.provenance.span.start.column,
        nodeId: issue.subject.id,
      };
    }
  }
}

type MediaKind = "video" | "audio";
type MediaSegment = {
  sourceStart: Rational;
  duration: Rational;
  iteration: number;
};

const visualMediaOps = new Set(["cut.visual.video", "cut.visual.image"]);
const audioMediaOps = new Set(["cut.audio.clip", "cut.documentary.narration"]);
const linkedMediaOps = new Set(["cut.edit.clip"]);
const transparentContainers = new Set(["cut.kernel.fragment"]);
const flattenedContainers = new Set([
  "cut.visual.group",
  "cut.visual.stack",
  "cut.visual.composite",
  "cut.visual.clip_path",
  "cut.visual.camera2d",
  "cut.visual.color_grade",
  "cut.audio.bus",
  "cut.audio.meter",
]);
const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

function exactRational(value: Rational, context: string): Rational {
  let numerator: bigint;
  let denominator: bigint;
  try {
    numerator = BigInt(value.numerator);
    denominator = BigInt(value.denominator);
  } catch {
    throw new CutOtioExportError("CUT_OTIO_INVALID_RATIONAL", `${context} is not an integer rational.`);
  }
  if (denominator <= 0n) throw new CutOtioExportError("CUT_OTIO_INVALID_RATIONAL", `${context} has a non-positive denominator.`);
  if (numerator > maxSafe || numerator < -maxSafe || denominator > maxSafe) {
    throw new CutOtioExportError(
      "CUT_OTIO_INEXACT_TIME",
      `${context} cannot be encoded exactly in OTIO RationalTime's double fields.`,
    );
  }
  return rational(numerator, denominator);
}

function otioTime(value: Rational, context: string): OtioRationalTime {
  const exact = exactRational(value, context);
  return {
    OTIO_SCHEMA: "RationalTime.1",
    value: Number(exact.numerator),
    rate: Number(exact.denominator),
  };
}

function exactMetadata(value: Rational) {
  return { numerator: value.numerator, denominator: value.denominator };
}

const otioMarkerPalette = {
  RED: "#ff0000",
  PINK: "#ff80bf",
  ORANGE: "#ff8000",
  YELLOW: "#ffff00",
  GREEN: "#00ff00",
  CYAN: "#00ffff",
  BLUE: "#0000ff",
  PURPLE: "#8000ff",
  MAGENTA: "#ff00ff",
  BLACK: "#000000",
  DARK_GRAY: "#404040",
  GRAY: "#808080",
  LIGHT_GRAY: "#c0c0c0",
  WHITE: "#ffffff",
} as const;

function otioMarkerColor(color: string) {
  const rgb = [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16)];
  return Object.entries(otioMarkerPalette).map(([name, hex]) => {
    const candidate = [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
    return { name, distance: rgb.reduce((sum, value, index) => sum + (value - candidate[index]) ** 2, 0) };
  }).sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))[0].name;
}

function annotationMarkers(ir: CutAVIR, compositionId: string): OtioMarker[] {
  const markers = ir.annotations?.markers.filter((marker) => marker.compositionId === compositionId).map((marker): OtioMarker => ({
    OTIO_SCHEMA: "Marker.2",
    name: marker.name,
    metadata: {
      cut: {
        annotation_id: marker.id,
        annotation_kind: marker.kind,
        composition_id: marker.compositionId,
        scene_id: marker.sceneId ?? null,
        exact_color: marker.color,
        role: marker.role,
        grid: marker.grid,
        exact_start: exactMetadata(marker.at),
        exact_duration: exactMetadata(zeroRational),
        source: { module: marker.provenance.module, line: marker.provenance.span.start.line, column: marker.provenance.span.start.column },
      },
    },
    marked_range: timeRange(marker.at, zeroRational, `Marker ${marker.id}`),
    color: otioMarkerColor(marker.color),
    comment: marker.comment,
  })) ?? [];
  const regions = ir.annotations?.regions.filter((region) => region.compositionId === compositionId).map((region): OtioMarker => ({
    OTIO_SCHEMA: "Marker.2",
    name: region.name,
    metadata: {
      cut: {
        annotation_id: region.id,
        annotation_kind: region.kind,
        composition_id: region.compositionId,
        scene_id: region.sceneId ?? null,
        exact_color: region.color,
        role: region.role,
        grid: region.grid,
        exact_start: exactMetadata(region.range.start),
        exact_duration: exactMetadata(region.range.duration),
        source: { module: region.provenance.module, line: region.provenance.span.start.line, column: region.provenance.span.start.column },
      },
    },
    marked_range: timeRange(region.range.start, region.range.duration, `Region ${region.id}`),
    color: otioMarkerColor(region.color),
    comment: region.comment,
  })) ?? [];
  return [...markers, ...regions];
}

function timeRange(start: Rational, duration: Rational, context: string): OtioTimeRange {
  if (compareRational(duration, zeroRational) < 0) {
    throw new CutOtioExportError("CUT_OTIO_NEGATIVE_DURATION", `${context} has a negative duration.`);
  }
  return {
    OTIO_SCHEMA: "TimeRange.1",
    start_time: otioTime(start, `${context} start`),
    duration: otioTime(duration, `${context} duration`),
  };
}

function gap(duration: Rational, context: string): OtioGap {
  return {
    OTIO_SCHEMA: "Gap.1",
    name: "",
    metadata: {
      cut: { exact_duration: exactMetadata(duration) },
    },
    source_range: timeRange(zeroRational, duration, context),
    effects: [],
    markers: [],
    enabled: true,
  };
}

function minRational(left: Rational, right: Rational) {
  return compareRational(left, right) <= 0 ? left : right;
}

function intervalEnd(interval: { start: Rational; duration: Rational }) {
  return addRational(interval.start, interval.duration);
}

function booleanInput(value: IRValue | undefined, fallback = false) {
  return value?.kind === "boolean" ? value.value : fallback;
}

function timeInput(value: IRValue | undefined): Rational | undefined {
  return value?.kind === "quantity" && value.dimension === "time" ? value.magnitude : undefined;
}

function sourceRange(node: IRNode): { start: Rational; duration: Rational } | undefined {
  const value = node.inputs.range;
  if (!value) return { start: zeroRational, duration: node.interval.duration };
  if (value.kind !== "range") return undefined;
  const start = timeInput(value.start);
  const end = timeInput(value.end);
  if (!start || !end || compareRational(end, start) <= 0) return undefined;
  return { start, duration: subtractRational(end, start) };
}

function collectNodeReferences(value: IRValue, result: string[]) {
  if (value.kind === "node-ref") result.push(value.id);
  else if (value.kind === "array") value.items.forEach((item) => collectNodeReferences(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => collectNodeReferences(item, result));
  else if (value.kind === "range") {
    collectNodeReferences(value.start, result);
    collectNodeReferences(value.end, result);
  } else if (value.kind === "unary") collectNodeReferences(value.value, result);
  else if (value.kind === "binary") {
    collectNodeReferences(value.left, result);
    collectNodeReferences(value.right, result);
  } else if (value.kind === "member") collectNodeReferences(value.object, result);
  else if (value.kind === "index") {
    collectNodeReferences(value.object, result);
    collectNodeReferences(value.index, result);
  } else if (value.kind === "call") {
    value.positional.forEach((item) => collectNodeReferences(item, result));
    Object.values(value.named).forEach((item) => collectNodeReferences(item, result));
  }
}

function graphOrder(ir: CutAVIR, roots: string[], includeReferences: boolean) {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) return;
    ordered.push(id);
    node.children.forEach(visit);
    if (includeReferences) {
      const references: string[] = [];
      Object.values(node.inputs).forEach((value) => collectNodeReferences(value, references));
      references.forEach(visit);
    }
  };
  roots.forEach(visit);
  return ordered;
}

function sceneForNode(ir: CutAVIR, compositionSceneIds: Set<string>, node: IRNode) {
  if (!node.sceneId) return undefined;
  return compositionSceneIds.has(node.sceneId) ? ir.scenes[node.sceneId] : undefined;
}

function resourceFor(node: IRNode, ir: CutAVIR) {
  const source = node.inputs.source;
  return source?.kind === "resource-ref" ? ir.resources[source.id] : undefined;
}

function clip(
  node: IRNode,
  resource: IRResource,
  segment: MediaSegment,
  placement: Rational,
  mediaKind: MediaKind,
  sceneId: string | undefined,
  linkedId: string | undefined,
): OtioClip {
  return {
    OTIO_SCHEMA: "Clip.2",
    name: resource.name,
    metadata: {
      cut: {
        node_id: node.id,
        node_op: node.op,
        media_kind: mediaKind,
        resource_id: resource.id,
        resource_kind: resource.kind,
        resource_sha256: resource.sha256 ?? null,
        scene_id: sceneId ?? null,
        linked_av_id: linkedId ?? null,
        loop_iteration: segment.iteration,
        exact_placement: exactMetadata(placement),
        exact_source_start: exactMetadata(segment.sourceStart),
        exact_duration: exactMetadata(segment.duration),
      },
    },
    source_range: timeRange(segment.sourceStart, segment.duration, `Node ${node.id} source range`),
    effects: [],
    markers: [],
    enabled: true,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: resource.name,
        metadata: {
          cut: {
            resource_id: resource.id,
            kind: resource.kind,
            state: resource.state,
            sha256: resource.sha256 ?? null,
          },
        },
        target_url: resource.locator,
        available_range: null,
        available_image_bounds: null,
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
  };
}

function makeTrack(
  node: IRNode,
  resource: IRResource,
  kind: MediaKind,
  placement: Rational,
  segments: MediaSegment[],
  compositionDuration: Rational,
  sceneId: string | undefined,
  linkedId: string | undefined,
  ordinal: number,
): { track: OtioTrack; gaps: number; clips: number } {
  const children: Array<OtioGap | OtioClip> = [];
  let gaps = 0;
  if (compareRational(placement, zeroRational) > 0) {
    children.push(gap(placement, `Track ${node.id} leading gap`));
    gaps += 1;
  }
  let cursor = placement;
  for (const segment of segments) {
    children.push(clip(node, resource, segment, cursor, kind, sceneId, linkedId));
    cursor = addRational(cursor, segment.duration);
  }
  if (compareRational(cursor, compositionDuration) < 0) {
    children.push(gap(subtractRational(compositionDuration, cursor), `Track ${node.id} trailing gap`));
    gaps += 1;
  }
  return {
    track: {
      OTIO_SCHEMA: "Track.1",
      name: `${kind === "video" ? "V" : "A"}${ordinal} · ${resource.name}`,
      metadata: {
        cut: {
          source_node_id: node.id,
          source_node_op: node.op,
          scene_id: sceneId ?? null,
          layer_index: ordinal - 1,
          exact_placement: exactMetadata(placement),
        },
      },
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      kind: kind === "video" ? "Video" : "Audio",
      children,
    },
    gaps,
    clips: segments.length,
  };
}

function mediaSegments(
  node: IRNode,
  kind: MediaKind,
  availableDuration: Rational,
  maxInstances: number,
  issues: CutOtioUnsupportedSemantic[],
): MediaSegment[] | undefined {
  const range = sourceRange(node);
  if (!range || compareRational(range.duration, zeroRational) <= 0) {
    issues.push({
      code: "CUT_OTIO_SOURCE_RANGE_UNSUPPORTED",
      category: "timing",
      disposition: "omitted",
      subject: { kind: "node", id: node.id, op: node.op, property: "range" },
      message: "The node's source range is not a positive, exact CUT time range.",
      provenance: node.provenance,
    });
    return undefined;
  }

  if (kind === "audio") {
    const duration = minRational(range.duration, availableDuration);
    return compareRational(duration, zeroRational) > 0 ? [{ sourceStart: range.start, duration, iteration: 0 }] : [];
  }

  const displayDuration = minRational(node.interval.duration, availableDuration);
  if (node.op === "cut.visual.image") {
    return compareRational(displayDuration, zeroRational) > 0
      ? [{ sourceStart: zeroRational, duration: displayDuration, iteration: 0 }]
      : [];
  }

  if (!booleanInput(node.inputs.loop)) {
    const duration = minRational(range.duration, displayDuration);
    if (compareRational(range.duration, displayDuration) < 0) {
      issues.push({
        code: "CUT_OTIO_VIDEO_TAIL_UNSUPPORTED",
        category: "timing",
        disposition: "partial",
        subject: { kind: "node", id: node.id, op: node.op, property: "endBehavior" },
        message: `OTIO receives the ${range.duration.numerator}/${range.duration.denominator}s source portion, but CUT's remaining hold/error tail is not representable as an ordinary clip.`,
        provenance: node.provenance,
      });
    }
    return compareRational(duration, zeroRational) > 0 ? [{ sourceStart: range.start, duration, iteration: 0 }] : [];
  }

  const result: MediaSegment[] = [];
  let remaining = displayDuration;
  while (compareRational(remaining, zeroRational) > 0) {
    if (result.length >= maxInstances) {
      throw new CutOtioExportError(
        "CUT_OTIO_CLIP_LIMIT",
        `Loop expansion exceeded the configured ${maxInstances} clip-instance limit.`,
      );
    }
    const duration = minRational(range.duration, remaining);
    result.push({ sourceStart: range.start, duration, iteration: result.length });
    remaining = subtractRational(remaining, duration);
  }
  return result;
}

function rootIds(ir: CutAVIR, compositionId: string) {
  const composition = ir.compositions.find((item) => item.id === compositionId)!;
  const roots: string[] = [];
  for (const item of composition.items) {
    if (item.kind === "node") roots.push(item.id);
    else {
      const scene = ir.scenes[item.id];
      if (scene) scene.items.forEach((entry) => roots.push(entry.id));
    }
  }
  return roots;
}

type EditorialTrackNode = IRNode & {
  editorial: Extract<IREditorial, { kind: "picture-track" | "audio-track" }>;
};

type EditorialProfileDraftItem = {
  id: string;
  kind: "clip" | "gap" | "nested-sequence";
  order: number;
  destination: { start: Rational; duration: Rational };
  source: { start: Rational; duration: Rational } | null;
  retime: CutOtioEditorialRetime;
  node?: IRNode;
  resource?: IRResource;
  pictureTimeMap?: IRPictureTimeMap;
  linkId?: string;
  role?: string;
  metadata?: Readonly<Record<string, string>>;
  nesting?: Extract<CutOtioEditorialItem, { kind: "nested-sequence" }>["nesting"];
  timelineAudio?: {
    planId: string;
    item: TimelineEditItemV1;
    lineageItems: readonly TimelineEditItemV1[];
    originNode: IRNode;
    sourceRoot: IRNode;
    sourceLeaf: IRNode;
    processorNodeIds: readonly string[];
  };
  timelineNested?: {
    planId: string;
    item: TimelineEditItemV1;
    lineageItems: readonly TimelineEditItemV1[];
  };
};

type EditorialProfileDraftTrack = {
  id: string;
  kind: "Video" | "Audio";
  order: number;
  node: IRNode;
  role?: string;
  metadata?: Readonly<Record<string, string>>;
  items: EditorialProfileDraftItem[];
  transitions: CutOtioEditorialTransition[];
};

type EditorialProfileNativeExport = {
  profile: CutOtioEditorialProfile;
  profileV3?: CutOtioEditorialProfileV3;
  profileV4?: CutOtioEditorialProfileV4;
  profileV5?: CutOtioEditorialProfileV5;
  profileV6?: CutOtioEditorialProfileV6;
  tracks: OtioTrack[];
  ownedNodeIds: Set<string>;
  sourceNodeIds: string[];
  linkNames: Array<{ groupId: string; linkId: string }>;
  gaps: number;
  clips: number;
};

type TimelineAudioTrace = Readonly<{
  finalItems: readonly TimelineEditItemV1[];
  lineageItemsByAuthority: ReadonlyMap<
    string,
    readonly TimelineEditItemV1[]
  >;
}>;

type TimelineNestedTrace = Readonly<{
  finalItems: readonly TimelineEditItemV1[];
  lineageItems: readonly TimelineEditItemV1[];
}>;

const editorialProfileIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

function generatedEditorialId(prefix: string, value: unknown) {
  return `${prefix}_${hash(value).slice(0, 20)}`;
}

function profileItemId(trackId: string, item: { editId?: string; order: number; kind: string; destination: { start: Rational; duration: Rational } }) {
  if (item.editId) return editorialProfileIdPattern.test(item.editId) ? item.editId : undefined;
  return generatedEditorialId("otio_item", { trackId, order: item.order, kind: item.kind, destination: item.destination });
}

function profileTrackId(node: EditorialTrackNode, order: number) {
  const authored = node.editorial.trackId;
  if (authored) return editorialProfileIdPattern.test(authored) ? authored : undefined;
  return generatedEditorialId("otio_track", { nodeId: node.id, order, kind: node.editorial.kind });
}

function profileRetime(item: Extract<IREditorial, { kind: "picture-track" }>["items"][number]): CutOtioEditorialRetime | undefined {
  if (!item.timeMap) return { kind: "identity" };
  if (item.timeMap.kind !== "constant") return undefined;
  if (item.timeMap.direction === "forward" && compareRational(item.timeMap.rate, rational(1)) === 0) return { kind: "identity" };
  return { kind: "constant", direction: item.timeMap.direction, rate: item.timeMap.rate };
}

function profileCompatibleMediaNode(node: IRNode, kind: "Video" | "Audio") {
  if (node.properties && Object.keys(node.properties).length) return false;
  if (node.effects.some((effect) => effect !== "pure")) return false;
  const allowed = kind === "Video"
    ? new Set([
        "source", "range", "duration", "playback", "rate", "link", "headHandle", "tailHandle", "editId",
        "freezeAt", "speedRamp", "frameSelection", "fit", "opacity", "scale", "rotation", "inputColor", "inputColorInterpretation",
        "transcriptBindingId", "transcriptMediaAuthorityId", "transcriptPictureOriginIdentity",
        "transcriptPictureSegmentIdentity",
      ])
    : new Set([
        "source", "range", "destination", "link", "headHandle", "tailHandle", "editId",
        "fadeIn", "fadeOut", "transcriptBindingId",
      ]);
  if (Object.keys(node.inputs).some((key) => !allowed.has(key))) return false;
  return true;
}

function directMediaClock(
  resource: IRResource,
  trackKind: "Video" | "Audio",
): CutOtioDirectMediaAuthority["clock"] | undefined {
  const probe = resource.metadata?.probe;
  if (!probe || typeof probe !== "object"
    || (probe as { kind?: unknown }).kind !== "media") return undefined;
  const media = probe as {
    identity?: {
      streams?: Array<{
        index?: unknown;
        type?: unknown;
        sampleRate?: unknown;
        frameRate?: unknown;
      }>;
    };
    selected?: {
      video?: {
        streamIndex?: unknown;
        timeBase?: unknown;
        frameRate?: unknown;
      };
      audio?: {
        streamIndex?: unknown;
        timeBase?: unknown;
      };
    };
  };
  const selected = trackKind === "Video"
    ? media.selected?.video
    : media.selected?.audio;
  if (!selected
    || !Number.isSafeInteger(selected.streamIndex)
    || Number(selected.streamIndex) < 0
    || !selected.timeBase
    || typeof selected.timeBase !== "object") return undefined;
  const stream = media.identity?.streams?.find((candidate) =>
    candidate.index === selected.streamIndex
    && candidate.type === (trackKind === "Video" ? "video" : "audio"));
  if (!stream) return undefined;
  const rate = trackKind === "Video"
    ? ("frameRate" in selected ? selected.frameRate : undefined)
      ?? stream.frameRate
    : Number.isSafeInteger(stream.sampleRate) && Number(stream.sampleRate) > 0
      ? rational(Number(stream.sampleRate))
      : undefined;
  if (!rate || typeof rate !== "object") return undefined;
  try {
    const timeBase = rational(
      (selected.timeBase as Rational).numerator,
      (selected.timeBase as Rational).denominator,
    );
    const exactRate = rational(
      (rate as Rational).numerator,
      (rate as Rational).denominator,
    );
    if (compareRational(timeBase, zeroRational) <= 0
      || compareRational(exactRate, zeroRational) <= 0) return undefined;
    return Object.freeze({
      kind: trackKind === "Video" ? "frame" : "sample",
      streamIndex: Number(selected.streamIndex),
      timeBase,
      rate: exactRate,
    });
  } catch {
    return undefined;
  }
}

function timelineAudioOriginDraft(
  ir: CutAVIR,
  composition: CutAVIR["compositions"][number],
  sceneId: string,
  trackId: string,
  editorialItem: Extract<IREditorial, { kind: "audio-track" }>["items"][number],
  itemNode: IRNode,
  traceCache: Map<string, TimelineAudioTrace>,
) {
  if (itemNode.op !== "cut.edit.timeline_audio_view"
    || itemNode.inputs.origin?.kind !== "node-ref") return undefined;
  const originNode = ir.nodes[itemNode.inputs.origin.id];
  if (!originNode
    || originNode.op !== "cut.edit.timeline_audio_origin"
    || originNode.children.length !== 1) return undefined;
  const sourceRoot = ir.nodes[originNode.children[0]];
  if (!sourceRoot) return undefined;
  const processorNodeIds: string[] = [];
  const visited = new Set<string>();
  let current: IRNode | undefined = sourceRoot;
  while (current && current.op !== "cut.audio.clip") {
    if (visited.has(current.id) || current.children.length !== 1) return undefined;
    visited.add(current.id);
    if (current.op !== "cut.edit.audio_region") processorNodeIds.push(current.id);
    current = ir.nodes[current.children[0]];
  }
  const sourceLeaf = current;
  if (!sourceLeaf || sourceLeaf.op !== "cut.audio.clip") return undefined;

  const candidates: Array<{
    planId: string;
    item: TimelineEditItemV1;
    lineageItems: readonly TimelineEditItemV1[];
  }> = [];
  for (const plan of ir.timelineEdits ?? []) {
    if (plan.compositionId !== composition.id || plan.sceneId !== sceneId) continue;
    const cacheKey = stableJsonStringify({ planId: plan.id });
    let trace = traceCache.get(cacheKey);
    if (!trace) {
      const lineageItemsByAuthority =
        new Map<string, Map<string, TimelineEditItemV1>>();
      const collectItem = (item: TimelineEditItemV1) => {
        if (item.sourceView.kind === "gap"
          || item.sourceView.kind === "picture"
          || item.sourceView.kind === "nested") return;
        const authorityOriginId = timelineEditAudioPresentationOriginKey(item);
        const lineageItems = lineageItemsByAuthority.get(authorityOriginId)
          ?? new Map<string, TimelineEditItemV1>();
        if (!lineageItems.has(item.segmentId)
          && lineageItems.size
            >= cutOtioEditorialProfileV3Limits.maximumLineageSegments) {
          throw new CutOtioExportError(
            "CUT_OTIO_EDITORIAL_PROFILE",
            `Timeline audio authority ${authorityOriginId} lineage exceeds ${cutOtioEditorialProfileV3Limits.maximumLineageSegments} segments.`,
          );
        }
        // Map insertion order records the first observation (parent-before-
        // child), while replacing the value preserves the segment's latest
        // exact destination after later ripple/reflow operations.
        lineageItems.set(item.segmentId, item);
        lineageItemsByAuthority.set(authorityOriginId, lineageItems);
      };
      const collectTrack = (tracks: readonly TimelineEditTrackV1[]) => {
        tracks.forEach((stageTrack) => stageTrack.items.forEach(collectItem));
      };
      collectTrack(plan.tracks);
      const result = executeTimelineEditPlan(
        plan,
        (stage) => collectTrack(stage.tracks),
        collectItem,
      );
      trace = Object.freeze({
        finalItems: Object.freeze(result.tracks.flatMap((stageTrack) =>
          stageTrack.items)),
        lineageItemsByAuthority: new Map(
          [...lineageItemsByAuthority.entries()].map(
            ([authorityOriginId, lineageItems]) => [
              authorityOriginId,
              Object.freeze([...lineageItems.values()]),
            ] as const,
          ),
        ),
      });
      traceCache.set(cacheKey, trace);
    }
    for (const item of trace.finalItems) {
      if (item.trackId !== trackId
        || item.originId !== editorialItem.editId
        || item.sourceView.kind === "gap"
        || item.sourceView.kind === "picture"
        || item.sourceView.kind === "nested"
        || compareRational(item.destination.start, editorialItem.destination.start) !== 0
        || compareRational(item.destination.duration, editorialItem.destination.duration) !== 0
        || !editorialItem.source
        || compareRational(item.sourceView.source.start, editorialItem.source.start) !== 0
        || compareRational(item.sourceView.source.duration, editorialItem.source.duration) !== 0) continue;
      candidates.push({
        planId: plan.id,
        item,
        lineageItems:
          trace.lineageItemsByAuthority.get(
            timelineEditAudioPresentationOriginKey(item),
          ) ?? Object.freeze([]),
      });
    }
  }
  if (candidates.length !== 1) return undefined;
  return {
    planId: candidates[0].planId,
    item: candidates[0].item,
    lineageItems: candidates[0].lineageItems,
    originNode,
    sourceRoot,
    sourceLeaf,
    processorNodeIds: Object.freeze(processorNodeIds),
  };
}

function timelineAudioLineageSegment(
  planId: string,
  item: TimelineEditItemV1,
): CutOtioEditorialAudioLineageSegment {
  if (item.sourceView.kind !== "audio"
    && item.sourceView.kind !== "processed-audio") {
    throw new CutOtioExportError(
      "CUT_OTIO_EDITORIAL_PROFILE",
      `Timeline audio segment ${item.segmentId} has a non-audio source view.`,
    );
  }
  const lineage: Omit<
    CutOtioEditorialAudioLineageSegment,
    "lineageSha256"
  > = {
    planId,
    trackId: item.trackId,
    originId: item.originId,
    segmentId: item.segmentId,
    ...(item.parentSegmentId === undefined
      ? {}
      : { parentSegmentId: item.parentSegmentId }),
    sliceOffset: item.sourceView.presentationClock.sliceOffset,
    source: item.sourceView.source,
    destination: item.destination,
    handles: item.sourceView.handles,
    ...(item.linkId === undefined ? {} : { linkId: item.linkId }),
    ...(item.role === undefined ? {} : { role: item.role }),
    ...(Object.keys(item.metadata).length ? { metadata: item.metadata } : {}),
  };
  return Object.freeze({
    ...lineage,
    lineageSha256: cutOtioEditorialAudioLineageSha256(lineage),
  });
}

function timelineNestedDraft(
  ir: CutAVIR,
  composition: CutAVIR["compositions"][number],
  sceneId: string,
  trackId: string,
  editorialItem: Extract<IREditorial, { kind: "picture-track" }>["items"][number],
  itemNode: IRNode,
  traceCache: Map<string, TimelineNestedTrace>,
) {
  const candidates: Array<{
    planId: string;
    item: TimelineEditItemV1;
    lineageItems: readonly TimelineEditItemV1[];
  }> = [];
  let applicable = false;
  for (const plan of ir.timelineEdits ?? []) {
    if (plan.compositionId !== composition.id || plan.sceneId !== sceneId) continue;
    const initialTrack = plan.tracks.find((candidate) =>
      candidate.trackId === trackId);
    if (!initialTrack?.items.some((item) => item.sourceView.kind === "nested")) {
      continue;
    }
    applicable = true;
    const cacheKey = stableJsonStringify({ planId: plan.id, trackId });
    let trace = traceCache.get(cacheKey);
    if (!trace) {
      const lineage = new Map<string, TimelineEditItemV1>();
      const collectItem = (item: TimelineEditItemV1) => {
        if (item.trackId !== trackId || item.sourceView.kind !== "nested") return;
        lineage.set(item.segmentId, item);
      };
      const collectTrack = (tracks: readonly TimelineEditTrackV1[]) => {
        const stageTrack = tracks.find((candidate) =>
          candidate.trackId === trackId);
        (stageTrack?.items ?? []).forEach(collectItem);
      };
      collectTrack(plan.tracks);
      const result = executeTimelineEditPlan(
        plan,
        (stage) => collectTrack(stage.tracks),
        collectItem,
      );
      trace = Object.freeze({
        finalItems: Object.freeze([...(result.tracks.find((candidate) =>
          candidate.trackId === trackId)?.items ?? [])]),
        lineageItems: Object.freeze([...lineage.values()]),
      });
      traceCache.set(cacheKey, trace);
    }
    for (const item of trace.finalItems) {
      if (item.originId !== editorialItem.editId
        || item.sourceView.kind !== "nested"
        || item.sourceView.compositionId
          !== (itemNode.inputs.source?.kind === "timeline-ref"
            ? itemNode.inputs.source.id
            : undefined)
        || compareRational(item.destination.start, editorialItem.destination.start) !== 0
        || compareRational(item.destination.duration, editorialItem.destination.duration) !== 0
        || !editorialItem.source
        || compareRational(item.sourceView.source.start, editorialItem.source.start) !== 0
        || compareRational(item.sourceView.source.duration, editorialItem.source.duration) !== 0
        || item.role !== editorialItem.role
        || stableJsonStringify(item.metadata)
          !== stableJsonStringify(editorialItem.metadata ?? {})) continue;
      candidates.push({
        planId: plan.id,
        item,
        lineageItems: trace.lineageItems,
      });
    }
  }
  if (!applicable) return undefined;
  if (candidates.length !== 1) {
    throw new CutOtioExportError(
      "CUT_OTIO_EDITORIAL_PROFILE",
      `Nested placement ${editorialItem.editId ?? itemNode.id} does not map to exactly one authenticated TimelineEdit result.`,
    );
  }
  return candidates[0];
}

function timelineNestedLineageSegment(
  planId: string,
  item: TimelineEditItemV1,
): CutOtioEditorialNestedLineageSegment {
  if (item.sourceView.kind !== "nested") {
    throw new CutOtioExportError(
      "CUT_OTIO_EDITORIAL_PROFILE",
      `Timeline nested segment ${item.segmentId} has a non-nested source view.`,
    );
  }
  const lineage: Omit<
    CutOtioEditorialNestedLineageSegment,
    "lineageSha256"
  > = {
    planId,
    trackId: item.trackId,
    originId: item.originId,
    segmentId: item.segmentId,
    ...(item.parentSegmentId === undefined
      ? {}
      : { parentSegmentId: item.parentSegmentId }),
    compositionId: item.sourceView.compositionId,
    sourceAuthorityId: item.sourceView.authorityId,
    placementPolicy: item.sourceView.placementPolicy ?? "structural-only",
    source: item.sourceView.source,
    destination: item.destination,
    ...(item.role === undefined ? {} : { role: item.role }),
    ...(Object.keys(item.metadata).length
      ? { metadata: item.metadata }
      : {}),
  };
  return Object.freeze({
    ...lineage,
    lineageSha256: cutOtioEditorialNestedLineageSha256(lineage),
  });
}

function itemProfileLosses(
  node: IRNode,
  itemId: string,
  trackKind: "Video" | "Audio",
  timeMap: Extract<IREditorial, { kind: "picture-track" }>["items"][number]["timeMap"] | undefined,
  pictureTimeMapProfile: boolean,
  directAvailabilityProfile: boolean,
  consumedHandles: Readonly<{ head: Rational; tail: Rational }>,
) {
  const result: CutOtioEditorialLoss[] = [];
  const add = (
    code: string,
    category: CutOtioEditorialLoss["category"],
    disposition: CutOtioEditorialLoss["disposition"],
    message: string,
    targets: readonly ("cut-roundtrip" | "generic-otio")[] = [
      "cut-roundtrip",
      "generic-otio",
    ],
  ) => {
    for (const kind of targets) {
      const target: CutOtioEditorialLoss["target"] = { kind };
      result.push({
        code,
        category,
        disposition,
        target,
        subject: { kind: "item", id: itemId },
        message,
      });
    }
  };
  if (timeMap?.kind === "speed-ramp") {
    add(
      "CUT_OTIO_VARIABLE_RETIME_UNSUPPORTED",
      "retime",
      "approximated",
      `Native OTIO LinearTimeWarp can preserve only the exact endpoint rate; CUT variable retime ${stableJsonStringify(timeMap)} requires CUT runtime and is not executable after generic or CUT-source import.`,
      pictureTimeMapProfile ? ["generic-otio"] : undefined,
    );
  } else if (timeMap?.kind === "freeze") {
    add(
      "CUT_OTIO_FREEZE_RETIME_UNSUPPORTED",
      "retime",
      "approximated",
      `Native OTIO LinearTimeWarp cannot preserve CUT freeze mapping ${stableJsonStringify(timeMap)}; the exact destination/source interval remains profiled but the held-frame law is not executable after import.`,
      pictureTimeMapProfile ? ["generic-otio"] : undefined,
    );
  }
  if (timeMap
    && "frameSelection" in timeMap
    && timeMap.frameSelection !== undefined
    && timeMap.frameSelection !== "floor") {
    add(
      "CUT_OTIO_FRAME_SELECTION_UNSUPPORTED",
      "retime",
      "dropped",
      `Native OTIO does not preserve CUT's ${JSON.stringify(timeMap.frameSelection)} frame-selection law; the exact source/destination clock remains profiled, while imported playback falls back to the target renderer's sampling policy.`,
      pictureTimeMapProfile ? ["generic-otio"] : undefined,
    );
  }
  const transcriptInputs = Object.fromEntries(
    [
      "transcriptBindingId",
      "transcriptMediaAuthorityId",
      "transcriptPictureOriginIdentity",
      "transcriptPictureSegmentIdentity",
    ].filter((key) => Object.hasOwn(node.inputs, key)).map((key) => [key, node.inputs[key]]),
  );
  if (Object.keys(transcriptInputs).length) {
    add(
      "CUT_OTIO_TRANSCRIPT_ORIGIN_UNSUPPORTED",
      "metadata",
      "dropped",
      `The native clip retains exact media timing, linkage, role, and namespaced metadata, but locked transcript-origin authority ${stableJsonStringify(transcriptInputs)} has no executable OTIO/CUT-source reconstruction and requires explicit lossy import.`,
    );
  }
  const presentationInputs = Object.fromEntries(
    (trackKind === "Video"
      ? ["fit", "opacity", "scale", "rotation", "inputColor", "inputColorInterpretation"]
      : ["fadeIn", "fadeOut"])
      .filter((key) => Object.hasOwn(node.inputs, key))
      .map((key) => [key, node.inputs[key]]),
  );
  if (Object.keys(presentationInputs).length) {
    add(
      trackKind === "Video" ? "CUT_OTIO_PICTURE_PRESENTATION_UNSUPPORTED" : "CUT_OTIO_AUDIO_FADE_UNSUPPORTED",
      "effect",
      "dropped",
      `The native clip retains exact source/destination timing, while CUT ${trackKind === "Video" ? "picture presentation" : "audio fade"} inputs ${stableJsonStringify(presentationInputs)} are not executable through this OTIO profile and require explicit lossy import.`,
    );
  }
  // Native OTIO Transition offsets plus the V2 profile already preserve the
  // portion of each handle that the transition actually consumes. Only
  // surplus declared availability needs V5 authority (or a scoped loss when
  // the resource is not locked enough to create that authority).
  const declaredHandles = Object.fromEntries(
    ([
      ["headHandle", consumedHandles.head],
      ["tailHandle", consumedHandles.tail],
    ] as const)
      .filter(([key, consumed]) => {
        if (!Object.hasOwn(node.inputs, key)) return false;
        const declared = timeInput(node.inputs[key]);
        return declared === undefined || compareRational(declared, consumed) > 0;
      })
      .map(([key]) => [key, node.inputs[key]]),
  );
  if (Object.keys(declaredHandles).length) {
    if (directAvailabilityProfile) {
      result.push({
        code: "CUT_OTIO_AVAILABLE_HANDLE_AUTHORITY_METADATA_REQUIRED",
        category: "timing",
        disposition: "metadata-required",
        target: { kind: "generic-otio" },
        subject: { kind: "item", id: itemId },
        message: `Native OTIO retains the visible source interval and transition offsets, but exact declared/surplus CUT source availability ${stableJsonStringify(declaredHandles)} requires the closed V5 direct-media extension. Generic OTIO alone is not lossless for unused handles.`,
      });
    } else if (node.provenance.symbol !== "TimelineEdit operation") {
      add(
        "CUT_OTIO_AVAILABLE_HANDLE_AUTHORITY_UNSUPPORTED",
        "timing",
        "dropped",
        `The native clip retains its visible source interval, but unused CUT source-handle authority ${stableJsonStringify(declaredHandles)} is not represented by the closed profile and requires explicit lossy import.`,
      );
    }
  }
  return result;
}

function nativeEditorialGap(item: Extract<CutOtioEditorialItem, { kind: "gap" }>): OtioGap {
  return {
    OTIO_SCHEMA: "Gap.1",
    name: "",
    metadata: {
      cut: {
        editorial_item_id: item.id,
        editorial_item_order: item.order,
        exact_destination: item.destination,
        exact_link: item.link,
        exact_retime: item.retime,
        exact_nesting: null,
        exact_duration: exactMetadata(item.destination.duration),
      },
    },
    source_range: timeRange(zeroRational, item.destination.duration, `Editorial gap ${item.id}`),
    effects: [],
    markers: [],
    enabled: true,
  };
}

function nativeEditorialClip(
  item: Extract<CutOtioEditorialItem, { kind: "clip" }>,
  draft: EditorialProfileDraftItem,
  trackKind: "Video" | "Audio",
  sceneId: string,
  directMediaAuthority?: CutOtioDirectMediaAuthority,
  pictureTimeMapAuthority?: CutOtioPictureTimeMapAuthority,
): OtioClip {
  if (!draft.node || !draft.resource || !item.source) throw new CutOtioExportError("CUT_OTIO_EDITORIAL_PROFILE", `Editorial clip ${item.id} lost its source node or resource.`);
  const scalar = item.retime.kind === "constant"
    ? rationalToNumber(item.retime.rate) * (item.retime.direction === "reverse" ? -1 : 1)
    : undefined;
  if (scalar !== undefined && (!Number.isFinite(scalar) || scalar === 0)) {
    throw new CutOtioExportError("CUT_OTIO_EDITORIAL_PROFILE", `Editorial clip ${item.id} has a non-finite OTIO time scalar.`);
  }
  return {
    OTIO_SCHEMA: "Clip.2",
    name: draft.resource.name,
    metadata: {
      cut: {
        node_id: draft.node.id,
        node_op: draft.node.op,
        media_kind: trackKind.toLowerCase(),
        resource_id: draft.resource.id,
        resource_kind: draft.resource.kind,
        resource_sha256: draft.resource.sha256 ?? null,
        scene_id: sceneId,
        linked_av_id: null,
        authored_link_id: draft.linkId ?? null,
        editorial_item_id: item.id,
        editorial_item_order: item.order,
        exact_placement: exactMetadata(item.destination.start),
        exact_source_start: exactMetadata(item.source.start),
        exact_duration: exactMetadata(item.source.duration),
        exact_destination: item.destination,
        exact_link: item.link,
        exact_retime: item.retime,
        exact_nesting: null,
        ...(item.role === undefined ? {} : { editorial_role: item.role }),
        ...(item.metadata === undefined ? {} : { editorial_metadata: item.metadata }),
        ...(directMediaAuthority === undefined
          ? {}
          : { direct_media_authority: directMediaAuthority }),
        ...(pictureTimeMapAuthority === undefined
          ? {}
          : { picture_time_map_authority: pictureTimeMapAuthority }),
        loop_iteration: 0,
      },
    },
    // OTIO source_range.duration is the clip's duration in its parent track.
    // LinearTimeWarp advances the media clock through the exact source interval,
    // which remains losslessly declared in the closed CUT profile/metadata.
    source_range: timeRange(item.source.start, item.destination.duration, `Editorial clip ${item.id} source range`),
    effects: scalar === undefined ? [] : [{
      OTIO_SCHEMA: "LinearTimeWarp.1",
      name: "CUT constant retime",
      metadata: {
        cut: {
          direction: item.retime.kind === "constant" ? item.retime.direction : "forward",
          exact_rate: item.retime.kind === "constant" ? item.retime.rate : rational(1),
        },
      },
      effect_name: "LinearTimeWarp",
      enabled: true,
      time_scalar: scalar,
    }],
    markers: [],
    enabled: true,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: draft.resource.name,
        metadata: {
          cut: {
            resource_id: draft.resource.id,
            kind: draft.resource.kind,
            state: draft.resource.state,
            sha256: draft.resource.sha256 ?? null,
          },
        },
        target_url: draft.resource.locator,
        available_range: null,
        available_image_bounds: null,
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
  };
}

function nativeEditorialNested(
  item: Extract<CutOtioEditorialItem, { kind: "nested-sequence" }>,
  placement?: Pick<EditorialProfileDraftItem, "role" | "metadata">,
): OtioNestedStack {
  return {
    OTIO_SCHEMA: "Stack.1",
    name: item.nesting.compositionId,
    metadata: {
      cut: {
        editorial_item_id: item.id,
        editorial_item_order: item.order,
        exact_destination: item.destination,
        exact_source: item.source,
        exact_link: item.link,
        exact_retime: item.retime,
        exact_nesting: item.nesting,
        ...(placement?.role === undefined
          ? {}
          : { editorial_role: placement.role }),
        ...(placement?.metadata === undefined
          ? {}
          : { editorial_metadata: placement.metadata }),
      },
    },
    source_range: timeRange(item.source.start, item.source.duration, `Nested editorial item ${item.id}`),
    effects: [],
    markers: [],
    enabled: true,
    children: [],
  };
}

function nativeEditorialTransition(transition: CutOtioEditorialTransition): OtioTransition {
  const half = divideRational(transition.duration, rational(2));
  return {
    OTIO_SCHEMA: "Transition.1",
    name: transition.mapping.kind === "picture" ? transition.mapping.style.kind : `${transition.mapping.curve} audio crossfade`,
    metadata: {
      cut: {
        editorial_transition_id: transition.id,
        track_id: transition.trackId,
        outgoing_item_id: transition.outgoingItemId,
        incoming_item_id: transition.incomingItemId,
        exact_cut: transition.cut,
        exact_duration: transition.duration,
        exact_overlap: transition.overlap,
        exact_outgoing_source: transition.outgoingSource,
        exact_incoming_source: transition.incomingSource,
        mapping: transition.mapping,
      },
    },
    transition_type: "SMPTE_Dissolve",
    in_offset: otioTime(half, `Transition ${transition.id} incoming offset`),
    out_offset: otioTime(half, `Transition ${transition.id} outgoing offset`),
    enabled: true,
  };
}

function linkedSplitProfileNativeExport(
  ir: CutAVIR,
  composition: CutAVIR["compositions"][number],
  scene: CutAVIR["scenes"][string],
  relevantOrder: string[],
  split: IRNode,
  issues: CutOtioUnsupportedSemantic[],
): EditorialProfileNativeExport | undefined {
  if ((split.op !== "cut.edit.jcut" && split.op !== "cut.edit.lcut")
    || split.sceneId !== scene.id
    || compareRational(split.interval.start, zeroRational) !== 0
    || compareRational(split.interval.duration, composition.duration) !== 0
    || split.children.length !== 2) return undefined;
  const outgoing = ir.nodes[split.children[0]], incoming = ir.nodes[split.children[1]];
  if (!outgoing || !incoming || outgoing.op !== "cut.edit.clip" || incoming.op !== "cut.edit.clip") return undefined;
  const outgoingRange = sourceRange(outgoing), incomingRange = sourceRange(incoming);
  const outgoingResource = resourceFor(outgoing, ir), incomingResource = resourceFor(incoming, ir);
  const overlap = timeInput(split.inputs.overlap);
  if (!outgoingRange || !incomingRange || !outgoingResource || !incomingResource || !overlap
    || outgoingResource.kind !== "video" || incomingResource.kind !== "video") return undefined;
  const overlapStart = incoming.interval.start;
  const overlapEnd = intervalEnd(outgoing.interval);
  if (compareRational(subtractRational(overlapEnd, overlapStart), overlap) !== 0
    || compareRational(outgoing.interval.start, zeroRational) !== 0
    || compareRational(intervalEnd(incoming.interval), composition.duration) !== 0) return undefined;
  const pictureCut = split.op === "cut.edit.jcut" ? overlapEnd : overlapStart;
  const audioCut = split.op === "cut.edit.jcut" ? overlapStart : overlapEnd;
  const seed = {
    compositionId: composition.id,
    kind: split.op,
    overlap,
    children: [
      { interval: outgoing.interval, source: outgoingRange, locator: outgoingResource.locator, sha256: outgoingResource.sha256 ?? null },
      { interval: incoming.interval, source: incomingRange, locator: incomingResource.locator, sha256: incomingResource.sha256 ?? null },
    ],
  };
  const videoTrackId = generatedEditorialId("otio_track", { seed, kind: "Video" });
  const audioTrackId = generatedEditorialId("otio_track", { seed, kind: "Audio" });
  const groupId = generatedEditorialId("otio_link", { seed });
  const linkId = `linked-split-${hash(seed).slice(0, 24)}`;
  const sourceFor = (node: IRNode, source: { start: Rational; duration: Rational }, destination: { start: Rational; duration: Rational }) => {
    const offset = subtractRational(destination.start, node.interval.start);
    if (compareRational(offset, zeroRational) < 0 || compareRational(addRational(offset, destination.duration), source.duration) > 0) return undefined;
    return { start: addRational(source.start, offset), duration: destination.duration };
  };
  const destinations = {
    video: [
      { start: zeroRational, duration: pictureCut },
      { start: pictureCut, duration: subtractRational(composition.duration, pictureCut) },
    ],
    audio: [
      { start: zeroRational, duration: audioCut },
      { start: audioCut, duration: subtractRational(composition.duration, audioCut) },
    ],
  };
  const nodes = [outgoing, incoming], ranges = [outgoingRange, incomingRange], resources = [outgoingResource, incomingResource];
  const videoDrafts: EditorialProfileDraftItem[] = [], audioDrafts: EditorialProfileDraftItem[] = [];
  for (const index of [0, 1] as const) {
    const videoSource = sourceFor(nodes[index], ranges[index], destinations.video[index]);
    const audioSource = sourceFor(nodes[index], ranges[index], destinations.audio[index]);
    if (!videoSource || !audioSource) return undefined;
    videoDrafts.push({
      id: generatedEditorialId("otio_item", { trackId: videoTrackId, order: index, destination: destinations.video[index], source: videoSource }),
      kind: "clip",
      order: index,
      destination: destinations.video[index],
      source: videoSource,
      retime: { kind: "identity" },
      node: nodes[index],
      resource: resources[index],
      linkId,
    });
    audioDrafts.push({
      id: generatedEditorialId("otio_item", { trackId: audioTrackId, order: index, destination: destinations.audio[index], source: audioSource }),
      kind: "clip",
      order: index,
      destination: destinations.audio[index],
      source: audioSource,
      retime: { kind: "identity" },
      node: nodes[index],
      resource: resources[index],
      linkId,
    });
  }
  const segmentIds = [0, 1].map((index) => generatedEditorialId("otio_segment", { groupId, index }));
  const profileTracks: CutOtioEditorialTrack[] = [
    {
      id: videoTrackId,
      kind: "Video",
      order: 0,
      items: videoDrafts.map((item, index) => ({
        id: item.id,
        kind: "clip",
        order: index,
        destination: item.destination,
        source: item.source!,
        link: { kind: "linked", groupId, segmentId: segmentIds[index] },
        retime: { kind: "identity" },
        nesting: null,
      })),
    },
    {
      id: audioTrackId,
      kind: "Audio",
      order: 1,
      items: audioDrafts.map((item, index) => ({
        id: item.id,
        kind: "clip",
        order: index,
        destination: item.destination,
        source: item.source!,
        link: { kind: "linked", groupId, segmentId: segmentIds[index] },
        retime: { kind: "identity" },
        nesting: null,
      })),
    },
  ];
  const linkGroups: CutOtioEditorialLinkGroup[] = [{
    id: groupId,
    kind: "linked-av",
    segments: segmentIds.map((id, index) => ({
      id,
      pictureItemId: videoDrafts[index].id,
      audioItemId: audioDrafts[index].id,
    })),
  }];
  const linkedCut: CutOtioEditorialLinkedCut = {
    id: generatedEditorialId("otio_linked_cut", { groupId, kind: split.op, pictureCut, audioCut }),
    kind: split.op === "cut.edit.jcut" ? "j-cut" : "l-cut",
    groupId,
    picture: { outgoingItemId: videoDrafts[0].id, incomingItemId: videoDrafts[1].id, at: pictureCut },
    audio: { outgoingItemId: audioDrafts[0].id, incomingItemId: audioDrafts[1].id, at: audioCut },
  };
  let profile: CutOtioEditorialProfile;
  try {
    profile = createCutOtioEditorialProfile({
      format: "cut-otio-editorial-profile",
      version: 2,
      compositionId: composition.id,
      duration: composition.duration,
      tracks: profileTracks,
      linkGroups,
      linkedCuts: [linkedCut],
      transitions: [],
      losses: [{
        code: "CUT_OTIO_LINK_METADATA_REQUIRED",
        category: "linkage",
        disposition: "metadata-required",
        target: { kind: "generic-otio" },
        subject: { kind: "link-group", id: groupId },
        message: "Native OTIO clips are independently useful, while exact CUT A/V segment linkage requires the closed editorial profile.",
      }, {
        code: "CUT_OTIO_LINKED_CUT_METADATA_REQUIRED",
        category: "timing",
        disposition: "metadata-required",
        target: { kind: "generic-otio" },
        subject: { kind: "linked-cut", id: linkedCut.id },
        message: "Native OTIO retains both hard boundaries, while exact CUT J/L intent requires the closed editorial profile.",
      }],
    });
  } catch (error) {
    throw new CutOtioExportError("CUT_OTIO_EDITORIAL_PROFILE", error instanceof Error ? error.message : "Failed to construct the J/L editorial profile.");
  }
  const profileTracksById = new Map(profile.tracks.map((track) => [track.id, track]));
  const drafts = [
    { trackId: videoTrackId, kind: "Video" as const, items: videoDrafts },
    { trackId: audioTrackId, kind: "Audio" as const, items: audioDrafts },
  ];
  const nativeTracks = drafts.map((draft, trackIndex): OtioTrack => {
    const profileTrack = profileTracksById.get(draft.trackId)!;
    return {
      OTIO_SCHEMA: "Track.1",
      name: `${draft.kind === "Video" ? "V" : "A"}1 · ${draft.trackId}`,
      metadata: {
        cut: {
          source_node_id: split.id,
          source_node_op: split.op,
          scene_id: scene.id,
          layer_index: trackIndex,
          exact_placement: exactMetadata(zeroRational),
          editorial_track_id: profileTrack.id,
          editorial_track_order: profileTrack.order,
          editorial_profile_version: 2,
        },
      },
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      kind: draft.kind,
      children: profileTrack.items.map((item, index) =>
        nativeEditorialClip(item as Extract<CutOtioEditorialItem, { kind: "clip" }>, draft.items[index], draft.kind, scene.id)),
    };
  });
  const unlocked = new Set<string>();
  for (const resource of resources) {
    if (resource.state === "locked" && resource.sha256 || unlocked.has(resource.id)) continue;
    unlocked.add(resource.id);
    issues.push({
      code: "CUT_OTIO_RESOURCE_UNLOCKED",
      category: "resource",
      disposition: "metadata-only",
      subject: { kind: "resource", id: resource.id },
      message: `Resource ${resource.id} is exported by locator but is not content-locked.`,
      provenance: resource.provenance,
    });
  }
  const ownedNodeIds = new Set<string>([split.id, outgoing.id, incoming.id]);
  for (const node of relevantOrder.map((id) => ir.nodes[id])) {
    if (!node) continue;
    if ((visualMediaOps.has(node.op) || audioMediaOps.has(node.op) || linkedMediaOps.has(node.op)) && !ownedNodeIds.has(node.id)) return undefined;
  }
  return {
    profile,
    tracks: nativeTracks,
    ownedNodeIds,
    sourceNodeIds: [outgoing.id, incoming.id],
    linkNames: [{ groupId, linkId }],
    gaps: 0,
    clips: 4,
  };
}

function editorialProfileNativeExport(
  ir: CutAVIR,
  composition: CutAVIR["compositions"][number],
  relevantOrder: string[],
  issues: CutOtioUnsupportedSemantic[],
): EditorialProfileNativeExport | null | undefined {
  if (composition.sceneIds.length !== 1) return null;
  const scene = ir.scenes[composition.sceneIds[0]];
  if (!scene || compareRational(scene.start, zeroRational) !== 0 || compareRational(scene.duration, composition.duration) !== 0) return null;
  const linkedSplits = relevantOrder
    .map((id) => ir.nodes[id])
    .filter((node): node is IRNode => node?.op === "cut.edit.jcut" || node?.op === "cut.edit.lcut");
  if (linkedSplits.length) {
    if (linkedSplits.length !== 1) return undefined;
    return linkedSplitProfileNativeExport(ir, composition, scene, relevantOrder, linkedSplits[0], issues);
  }
  const trackNodes = relevantOrder
    .map((id) => ir.nodes[id])
    .filter((node): node is EditorialTrackNode => Boolean(node?.editorial && (node.editorial.kind === "picture-track" || node.editorial.kind === "audio-track")));
  const nestedNodes = relevantOrder
    .map((id) => ir.nodes[id])
    .filter((node): node is IRNode => node?.op === "cut.edit.nested_sequence");
  if (!trackNodes.length && !nestedNodes.length) return null;
  if (trackNodes.some((node) => node.sceneId !== scene.id
    || compareRational(node.interval.start, zeroRational) !== 0
    || compareRational(node.interval.duration, composition.duration) !== 0)) return undefined;

  const drafts: EditorialProfileDraftTrack[] = [], ownedNodeIds = new Set<string>(), sourceNodeIds: string[] = [];
  const profileIssues: CutOtioUnsupportedSemantic[] = [], profileLosses: CutOtioEditorialLoss[] = [];
  const timelineAudioTraceCache = new Map<string, TimelineAudioTrace>();
  const timelineNestedTraceCache = new Map<string, TimelineNestedTrace>();
  for (const [trackIndex, node] of trackNodes.entries()) {
    const trackId = profileTrackId(node, trackIndex);
    if (!trackId) return undefined;
    const trackKind = node.editorial.kind === "picture-track" ? "Video" : "Audio";
    const preliminaryTransitions = (node.editorial.transitions ?? []).map((transition, transitionIndex): CutOtioEditorialTransition => ({
      id: generatedEditorialId("otio_transition", { trackId, transitionIndex, cut: transition.cut, kind: trackKind }),
      trackId,
      outgoingItemId: transition.outgoingNodeId,
      incomingItemId: transition.incomingNodeId,
      cut: transition.cut,
      duration: transition.duration,
      overlap: transition.overlap,
      outgoingSource: transition.outgoingSource,
      incomingSource: transition.incomingSource,
      mapping: "style" in transition
        ? { kind: "picture", style: transition.style }
        : { kind: "audio", curve: transition.curve },
    }));
    const editIdCounts = new Map<string, number>();
    for (const editorialItem of node.editorial.items) {
      if (editorialItem.editId !== undefined) {
        editIdCounts.set(editorialItem.editId, (editIdCounts.get(editorialItem.editId) ?? 0) + 1);
      }
    }
    const items: EditorialProfileDraftItem[] = [];
    for (const [itemIndex, editorialItem] of node.editorial.items.entries()) {
      const sharedEditId = editorialItem.editId !== undefined && (editIdCounts.get(editorialItem.editId) ?? 0) > 1
        ? editorialItem.editId
        : undefined;
      const itemId = sharedEditId === undefined
        ? profileItemId(trackId, editorialItem)
        : generatedEditorialId("otio_item", {
            trackId,
            editId: sharedEditId,
            order: editorialItem.order,
            kind: editorialItem.kind,
            destination: editorialItem.destination,
          });
      if (!itemId || editorialItem.order !== itemIndex) return undefined;
      if (editorialItem.kind === "gap") {
        if (editorialItem.role !== undefined || editorialItem.metadata !== undefined) return undefined;
        items.push({
          id: itemId,
          kind: "gap",
          order: itemIndex,
          destination: editorialItem.destination,
          source: null,
          retime: { kind: "identity" },
        });
        const gapNode = ir.nodes[editorialItem.nodeId];
        if (gapNode) ownedNodeIds.add(gapNode.id);
        continue;
      }
      const itemNode = ir.nodes[editorialItem.nodeId];
      if (!itemNode || !editorialItem.source) return undefined;
      if (trackKind === "Video" && itemNode.op === "cut.visual.precomp") {
        const pictureEditorialItem =
          editorialItem as Extract<
            IREditorial,
            { kind: "picture-track" }
          >["items"][number];
        const sourceInput = itemNode.inputs.source;
        const nestedSource = sourceRange(itemNode);
        const sourceComposition = sourceInput?.kind === "timeline-ref"
          ? ir.compositions.find((candidate) => candidate.id === sourceInput.id)
          : undefined;
        const staticPresentation = Object.freeze(Object.fromEntries(
          timelineEditStaticPrecompPresentationInputNames
            .filter((name) => Object.hasOwn(itemNode.inputs, name))
            .map((name) => [name, itemNode.inputs[name]!] as const),
        ));
        if (!sourceComposition
          || !nestedSource
          || sourceComposition.id === composition.id
          || editorialItem.linkId !== undefined
          || pictureEditorialItem.timeMap !== undefined
          || compareRational(editorialItem.source.start, nestedSource.start) !== 0
          || compareRational(editorialItem.source.duration, nestedSource.duration) !== 0
          || !isTimelineEditStaticPrecompOperand(itemNode)) {
          return undefined;
        }
        const nestedOrder = graphOrder(
          ir,
          rootIds(ir, sourceComposition.id),
          true,
        );
        const nesting = {
          instanceId: generatedEditorialId("otio_nested_instance", {
            trackId,
            itemId,
            nodeId: itemNode.id,
          }),
          compositionId: sourceComposition.id,
          sourceRange: nestedSource,
          // The semantic authority binds both the retained source graph and
          // this exact instance's static controls. Generic OTIO receives an
          // empty Stack plus explicit target-scoped loss; CUT never pretends
          // that the opaque digest reconstructs the omitted control.
          semanticSha256: hash({
            composition: sourceComposition,
            nodes: nestedOrder.map((id) => ir.nodes[id]).filter(Boolean)
              .map((candidate) => ({
                id: candidate.id,
                op: candidate.op,
                interval: candidate.interval,
                inputs: candidate.inputs,
                children: candidate.children,
                editorial: candidate.editorial,
                properties: candidate.properties,
                effects: candidate.effects,
                contentHash: candidate.contentHash,
              })),
            instance: {
              destination: editorialItem.destination,
              source: nestedSource,
              ...Object.fromEntries(
                timelineEditStaticPrecompPresentationInputNames
                  .filter((name) => name !== "opacity"
                    && Object.hasOwn(staticPresentation, name))
                  .map((name) => [name, staticPresentation[name]!] as const),
              ),
              // Preserve the historical opacity-only identity shape while
              // binding every newly admitted static presentation input above.
              opacity: itemNode.inputs.opacity ?? null,
            },
          }),
          depth: 1,
          ancestry: [composition.id, sourceComposition.id],
        } as const;
        const timelineNested = timelineNestedDraft(
          ir,
          composition,
          scene.id,
          trackId,
          pictureEditorialItem,
          itemNode,
          timelineNestedTraceCache,
        );
        items.push({
          id: itemId,
          kind: "nested-sequence",
          order: itemIndex,
          destination: editorialItem.destination,
          source: nestedSource,
          retime: { kind: "identity" },
          node: itemNode,
          nesting,
          ...(editorialItem.role === undefined
            ? {}
            : { role: editorialItem.role }),
          ...(editorialItem.metadata === undefined
            ? {}
            : { metadata: editorialItem.metadata }),
          ...(timelineNested === undefined ? {} : { timelineNested }),
        });
        ownedNodeIds.add(itemNode.id);
        sourceNodeIds.push(itemNode.id);
        if (Object.keys(staticPresentation).length) {
          const presentation = stableJsonStringify(staticPresentation);
          const loss: CutOtioEditorialLoss = {
            code: "CUT_OTIO_NESTED_INSTANCE_CONTROLS_UNSUPPORTED",
            category: "nesting",
            disposition: "unsupported",
            target: { kind: "cut-roundtrip" },
            subject: { kind: "nesting", id: nesting.instanceId },
            message: `The exact nested-instance semantic authority binds CUT static presentation inputs ${presentation}, but the current source importer cannot reconstruct those controls from a generic OTIO Stack.`,
          };
          profileLosses.push(loss, {
            ...loss,
            disposition: "metadata-required",
            target: { kind: "generic-otio" },
            message: `The generic OTIO Stack retains the nested timing boundary; CUT static presentation inputs ${presentation} remain authenticated only by the closed profile and are not portable OTIO controls.`,
          });
          profileIssues.push({
            code: loss.code,
            category: "timing",
            disposition: "omitted",
            subject: {
              kind: "node",
              id: itemNode.id,
              op: itemNode.op,
              property: `nesting:${nesting.instanceId}`,
            },
            message: loss.message,
            provenance: itemNode.provenance,
          });
        }
        continue;
      }
      const timelineAudio = trackKind === "Audio"
        ? timelineAudioOriginDraft(
            ir,
            composition,
            scene.id,
            trackId,
            editorialItem as Extract<IREditorial, { kind: "audio-track" }>["items"][number],
            itemNode,
            timelineAudioTraceCache,
          )
        : undefined;
      const mediaNode = timelineAudio?.sourceLeaf ?? itemNode;
      const expectedOp = trackKind === "Video"
        ? "cut.edit.picture_clip"
        : "cut.audio.clip";
      if (mediaNode.op !== expectedOp
        || (itemNode.op !== expectedOp
          && itemNode.op !== "cut.edit.timeline_audio_view")) return undefined;
      let retime = trackKind === "Video"
        ? profileRetime(editorialItem as Extract<IREditorial, { kind: "picture-track" }>["items"][number])
        : timelineAudio && editorialItem.source
          ? (() => {
              const rate = divideRational(
                editorialItem.source.duration,
                editorialItem.destination.duration,
              );
              return compareRational(rate, rational(1)) === 0
                ? { kind: "identity" as const }
                : {
                    kind: "constant" as const,
                    direction: "forward" as const,
                    rate,
                  };
            })()
          : { kind: "identity" as const };
      const pictureTimeMap = trackKind === "Video"
        ? (editorialItem as Extract<IREditorial, { kind: "picture-track" }>["items"][number]).timeMap
        : undefined;
      if (!retime) {
        if (pictureTimeMap?.kind !== "speed-ramp" && pictureTimeMap?.kind !== "freeze") return undefined;
        const endpointRate = divideRational(editorialItem.source.duration, editorialItem.destination.duration);
        retime = compareRational(endpointRate, rational(1)) === 0
          ? { kind: "identity" as const }
          : { kind: "constant" as const, direction: "forward" as const, rate: endpointRate };
      }
      const resource = resourceFor(mediaNode, ir);
      if (!resource || (trackKind === "Video" ? resource.kind !== "video" : resource.kind !== "audio")) return undefined;
      if (!profileCompatibleMediaNode(mediaNode, trackKind)) return undefined;
      const pictureTimeMapProfile = trackKind === "Video"
        && pictureTimeMap !== undefined
        && (pictureTimeMap.kind === "speed-ramp"
          || pictureTimeMap.kind === "freeze"
          || pictureTimeMap.frameSelection !== undefined)
        && itemNode.op === "cut.edit.picture_clip"
        && resource.state === "locked"
        && Boolean(resource.sha256)
        && directMediaClock(resource, "Video")?.kind === "frame";
      const directAvailabilityProfile = timelineAudio === undefined
        && itemNode.op === expectedOp
        && resource.state === "locked"
        && Boolean(resource.sha256)
        && directMediaClock(resource, trackKind) !== undefined;
      const maximumRational = (left: Rational, right: Rational) =>
        compareRational(left, right) >= 0 ? left : right;
      const consumedHandles = preliminaryTransitions.reduce(
        (result, transition) => ({
          head: transition.incomingItemId === itemNode.id
            ? maximumRational(result.head, transition.incomingSource.duration)
            : result.head,
          tail: transition.outgoingItemId === itemNode.id
            ? maximumRational(result.tail, transition.outgoingSource.duration)
            : result.tail,
        }),
        { head: zeroRational, tail: zeroRational },
      );
      const itemLosses = itemProfileLosses(
        mediaNode,
        itemId,
        trackKind,
        pictureTimeMap,
        pictureTimeMapProfile,
        directAvailabilityProfile,
        consumedHandles,
      );
      profileLosses.push(...itemLosses);
      for (const loss of itemLosses) {
        if (loss.target.kind !== "cut-roundtrip") continue;
        profileIssues.push({
          code: loss.code,
          category: loss.category === "retime" || loss.category === "timing" ? "timing" : loss.category === "effect" ? "effect" : "parameter",
          disposition: loss.disposition === "approximated" ? "partial" : "omitted",
          subject: {
            kind: "node",
            id: itemNode.id,
            op: itemNode.op,
            property: `${loss.subject.kind}:${loss.subject.id}`,
          },
          message: loss.message,
          provenance: itemNode.provenance,
        });
      }
      items.push({
        id: itemId,
        kind: "clip",
        order: itemIndex,
        destination: editorialItem.destination,
        source: editorialItem.source,
        retime,
        node: itemNode,
        resource,
        ...(pictureTimeMapProfile ? { pictureTimeMap } : {}),
        ...(editorialItem.linkId ? { linkId: editorialItem.linkId } : {}),
        ...(editorialItem.role === undefined ? {} : { role: editorialItem.role }),
        ...(editorialItem.metadata === undefined ? {} : { metadata: editorialItem.metadata }),
        ...(timelineAudio === undefined ? {} : { timelineAudio }),
      });
      ownedNodeIds.add(itemNode.id);
      if (timelineAudio) {
        ownedNodeIds.add(timelineAudio.originNode.id);
        let owned: IRNode | undefined = timelineAudio.sourceRoot;
        const visited = new Set<string>();
        while (owned && !visited.has(owned.id)) {
          visited.add(owned.id);
          ownedNodeIds.add(owned.id);
          owned = owned.children.length === 1 ? ir.nodes[owned.children[0]] : undefined;
        }
      }
      sourceNodeIds.push(itemNode.id);
      if (resource.state !== "locked" || !resource.sha256) {
        profileIssues.push({
          code: "CUT_OTIO_RESOURCE_UNLOCKED",
          category: "resource",
          disposition: "metadata-only",
          subject: { kind: "resource", id: resource.id },
          message: `Resource ${resource.id} is exported by locator but is not content-locked.`,
          provenance: resource.provenance,
        });
      }
    }
    const itemIdForNode = (nodeId: string) => {
      const matches = items.filter((item) => item.node?.id === nodeId);
      return matches.length === 1 ? matches[0].id : undefined;
    };
    const transitions = preliminaryTransitions.map((transition) => {
      const outgoingItemId = itemIdForNode(transition.outgoingItemId), incomingItemId = itemIdForNode(transition.incomingItemId);
      if (!outgoingItemId || !incomingItemId) return undefined;
      return { ...transition, outgoingItemId, incomingItemId };
    });
    if (transitions.some((transition) => !transition)) return undefined;
    drafts.push({
      id: trackId,
      kind: trackKind,
      order: drafts.length,
      node,
      ...(node.editorial.role === undefined ? {} : { role: node.editorial.role }),
      ...(node.editorial.metadata === undefined ? {} : { metadata: node.editorial.metadata }),
      items,
      transitions: transitions as CutOtioEditorialTransition[],
    });
    ownedNodeIds.add(node.id);
  }

  for (const node of nestedNodes) {
    const sourceInput = node.inputs.source;
    if (node.sceneId !== scene.id || sourceInput?.kind !== "timeline-ref") return undefined;
    const sourceComposition = ir.compositions.find((candidate) => candidate.id === sourceInput.id), source = sourceRange(node);
    if (!sourceComposition || !source) return undefined;
    const trackId = generatedEditorialId("otio_nested_track", { nodeId: node.id });
    const items: EditorialProfileDraftItem[] = [];
    let order = 0;
    if (compareRational(node.interval.start, zeroRational) > 0) {
      items.push({
        id: generatedEditorialId("otio_gap", { trackId, order, duration: node.interval.start }),
        kind: "gap",
        order: order++,
        destination: { start: zeroRational, duration: node.interval.start },
        source: null,
        retime: { kind: "identity" },
      });
    }
    const nestedId = generatedEditorialId("otio_nested_item", { nodeId: node.id });
    const nestedOrder = graphOrder(ir, rootIds(ir, sourceComposition.id), true);
    const nesting = {
      instanceId: generatedEditorialId("otio_nested_instance", { nodeId: node.id }),
      compositionId: sourceComposition.id,
      sourceRange: source,
      semanticSha256: hash({
        composition: sourceComposition,
        nodes: nestedOrder.map((id) => ir.nodes[id]).filter(Boolean).map((candidate) => ({
          id: candidate.id,
          op: candidate.op,
          interval: candidate.interval,
          inputs: candidate.inputs,
          children: candidate.children,
          editorial: candidate.editorial,
          properties: candidate.properties,
          effects: candidate.effects,
          contentHash: candidate.contentHash,
        })),
      }),
      depth: 1,
      ancestry: [composition.id, sourceComposition.id],
    } as const;
    items.push({
      id: nestedId,
      kind: "nested-sequence",
      order: order++,
      destination: { start: node.interval.start, duration: node.interval.duration },
      source,
      retime: { kind: "identity" },
      node,
      nesting,
    });
    const end = addRational(node.interval.start, node.interval.duration);
    if (compareRational(end, composition.duration) < 0) {
      items.push({
        id: generatedEditorialId("otio_gap", { trackId, order, start: end }),
        kind: "gap",
        order,
        destination: { start: end, duration: subtractRational(composition.duration, end) },
        source: null,
        retime: { kind: "identity" },
      });
    }
    drafts.push({ id: trackId, kind: "Video", order: drafts.length, node, items, transitions: [] });
    ownedNodeIds.add(node.id);
  }

  for (const node of relevantOrder.map((id) => ir.nodes[id])) {
    if (!node) continue;
    if ((visualMediaOps.has(node.op) || audioMediaOps.has(node.op) || linkedMediaOps.has(node.op)) && !ownedNodeIds.has(node.id)) return undefined;
  }
  for (const node of relevantOrder.map((id) => ir.nodes[id])) {
    if (node?.op === "cut.edit.sequence" && node.children.every((childId) => ownedNodeIds.has(childId))) ownedNodeIds.add(node.id);
  }

  const linked = new Map<string, { picture: Array<{ track: EditorialProfileDraftTrack; item: EditorialProfileDraftItem }>; audio: Array<{ track: EditorialProfileDraftTrack; item: EditorialProfileDraftItem }> }>();
  for (const track of drafts) for (const item of track.items) {
    if (!item.linkId) continue;
    const group = linked.get(item.linkId) ?? { picture: [], audio: [] };
    (track.kind === "Video" ? group.picture : group.audio).push({ track, item });
    linked.set(item.linkId, group);
  }
  const linkAssignments = new Map<string, { groupId: string; segmentId: string }>();
  const linkGroups: CutOtioEditorialLinkGroup[] = [], linkNames: Array<{ groupId: string; linkId: string }> = [];
  const segmentMembers = new Map<string, { picture: { track: EditorialProfileDraftTrack; item: EditorialProfileDraftItem }; audio: { track: EditorialProfileDraftTrack; item: EditorialProfileDraftItem } }>();
  for (const [linkId, group] of [...linked.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const order = (left: { track: EditorialProfileDraftTrack; item: EditorialProfileDraftItem }, right: { track: EditorialProfileDraftTrack; item: EditorialProfileDraftItem }) =>
      compareRational(left.item.destination.start, right.item.destination.start) || left.track.order - right.track.order || left.item.order - right.item.order;
    group.picture.sort(order); group.audio.sort(order);
    if (!group.picture.length || group.picture.length !== group.audio.length) return undefined;
    const groupId = generatedEditorialId("otio_link", { linkId }), segments: CutOtioEditorialLinkGroup["segments"][number][] = [];
    for (const [index, picture] of group.picture.entries()) {
      const audio = group.audio[index];
      const segmentId = generatedEditorialId("otio_segment", { groupId, index });
      segments.push({ id: segmentId, pictureItemId: picture.item.id, audioItemId: audio.item.id });
      linkAssignments.set(picture.item.id, { groupId, segmentId });
      linkAssignments.set(audio.item.id, { groupId, segmentId });
      segmentMembers.set(segmentId, { picture, audio });
    }
    linkGroups.push({ id: groupId, kind: "linked-av", segments });
    linkNames.push({ groupId, linkId });
  }

  const profileTracks: CutOtioEditorialTrack[] = drafts.map((track) => ({
    id: track.id,
    kind: track.kind,
    order: track.order,
    ...(track.role === undefined ? {} : { role: track.role }),
    ...(track.metadata === undefined ? {} : { metadata: track.metadata }),
    items: track.items.map((item): CutOtioEditorialItem => {
      if (item.kind === "gap") return { id: item.id, kind: "gap", order: item.order, destination: item.destination, source: null, link: { kind: "unlinked" }, retime: { kind: "identity" }, nesting: null };
      if (item.kind === "nested-sequence" && item.source && item.nesting) return { id: item.id, kind: "nested-sequence", order: item.order, destination: item.destination, source: item.source, link: { kind: "unlinked" }, retime: { kind: "identity" }, nesting: item.nesting };
      if (item.kind !== "clip" || !item.source) throw new CutOtioExportError("CUT_OTIO_EDITORIAL_PROFILE", `Editorial item ${item.id} has an incomplete profile projection.`);
      const assignment = linkAssignments.get(item.id);
      return {
        id: item.id,
        kind: "clip",
        order: item.order,
        destination: item.destination,
        source: item.source,
        link: assignment ? { kind: "linked", ...assignment } : { kind: "unlinked" },
        retime: item.retime,
        nesting: null,
        ...(item.role === undefined ? {} : { role: item.role }),
        ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
      };
    }),
  }));

  const owners = new Map<string, { track: EditorialProfileDraftTrack; item: EditorialProfileDraftItem }>();
  drafts.forEach((track) => track.items.forEach((item) => owners.set(item.id, { track, item })));
  const linkedCuts: CutOtioEditorialLinkedCut[] = [];
  for (const group of linkGroups) {
    for (let index = 1; index < group.segments.length; index += 1) {
      const outgoing = segmentMembers.get(group.segments[index - 1].id), incoming = segmentMembers.get(group.segments[index].id);
      if (!outgoing || !incoming
        || outgoing.picture.track.id !== incoming.picture.track.id
        || outgoing.audio.track.id !== incoming.audio.track.id
        || incoming.picture.item.order !== outgoing.picture.item.order + 1
        || incoming.audio.item.order !== outgoing.audio.item.order + 1) continue;
      const pictureAt = intervalEnd(outgoing.picture.item.destination), audioAt = intervalEnd(outgoing.audio.item.destination);
      if (compareRational(pictureAt, incoming.picture.item.destination.start) !== 0
        || compareRational(audioAt, incoming.audio.item.destination.start) !== 0
        || compareRational(pictureAt, audioAt) === 0) continue;
      const kind = compareRational(audioAt, pictureAt) < 0 ? "j-cut" : "l-cut";
      linkedCuts.push({
        id: generatedEditorialId("otio_linked_cut", { groupId: group.id, index, kind, pictureAt, audioAt }),
        kind,
        groupId: group.id,
        picture: { outgoingItemId: outgoing.picture.item.id, incomingItemId: incoming.picture.item.id, at: pictureAt },
        audio: { outgoingItemId: outgoing.audio.item.id, incomingItemId: incoming.audio.item.id, at: audioAt },
      });
    }
  }

  const transitions = drafts.flatMap((track) => track.transitions);
  const requiresClosedEditorialRoleMetadata = profileTracks.some((track) =>
    track.role !== undefined
      || track.metadata !== undefined
      || track.items.some((item) =>
        item.kind === "clip"
          && (item.role !== undefined || item.metadata !== undefined)));
  const losses: CutOtioEditorialLoss[] = [
    ...profileLosses,
    ...(requiresClosedEditorialRoleMetadata ? [{
      code: "CUT_OTIO_EDITORIAL_ROLE_METADATA_REQUIRED",
      category: "metadata" as const,
      disposition: "metadata-required" as const,
      target: { kind: "generic-otio" as const },
      subject: { kind: "composition" as const, id: composition.id },
      message: "Native OTIO carries exact CUT track/item roles and namespaced editorial metadata, but their semantic preservation by a generic adapter requires the closed CUT editorial profile.",
    }] : []),
    ...linkGroups.map((group): CutOtioEditorialLoss => ({
      code: "CUT_OTIO_LINKAGE_METADATA_REQUIRED",
      category: "linkage",
      disposition: "metadata-required",
      target: { kind: "generic-otio" },
      subject: { kind: "link-group", id: group.id },
      message: "Native OTIO tracks retain the hard edits, while explicit CUT A/V correlation requires the closed editorial profile.",
    })),
    ...linkedCuts.map((cut): CutOtioEditorialLoss => ({
      code: "CUT_OTIO_LINKED_CUT_METADATA_REQUIRED",
      category: "linkage",
      disposition: "metadata-required",
      target: { kind: "generic-otio" },
      subject: { kind: "linked-cut", id: cut.id },
      message: "Native OTIO retains both hard boundaries, while CUT J/L intent requires the closed editorial profile.",
    })),
    ...transitions.flatMap((transition): CutOtioEditorialLoss[] => {
      if (transition.mapping.kind === "audio") return [{
        code: "CUT_OTIO_AUDIO_TRANSITION_METADATA_REQUIRED",
        category: "transition",
        disposition: "metadata-required",
        target: { kind: "generic-otio" },
        subject: { kind: "transition", id: transition.id },
        message: "The native OTIO transition retains exact offsets, while CUT's audio curve requires the closed editorial profile.",
      }];
      if (transition.mapping.style.kind === "cross-dissolve") return [];
      return [{
        code: "CUT_OTIO_PICTURE_TRANSITION_APPROXIMATED",
        category: "transition",
        disposition: "approximated",
        target: { kind: "generic-otio" },
        subject: { kind: "transition", id: transition.id },
        message: "The native OTIO core uses SMPTE_Dissolve; exact CUT transition style controls require the closed editorial profile.",
      }];
    }),
    ...profileTracks.flatMap((track) => track.items.flatMap((item): CutOtioEditorialLoss[] => item.kind === "clip" && item.retime.kind === "constant" ? [{
      code: "CUT_OTIO_RETIME_METADATA_REQUIRED",
      category: "retime",
      disposition: "metadata-required",
      target: { kind: "generic-otio" },
      subject: { kind: "item", id: item.id },
      message: "LinearTimeWarp carries a numeric scalar; CUT's exact rational direction/rate contract requires the closed editorial profile.",
    }] : item.kind === "nested-sequence" ? [{
      code: "CUT_OTIO_NESTING_EXECUTABLE_IMPORT_UNSUPPORTED",
      category: "nesting",
      disposition: "unsupported",
      target: { kind: "cut-roundtrip" },
      subject: { kind: "nesting", id: item.nesting.instanceId },
      message: "Profile v2 preserves exact bounded nesting identity and source range, but executable CUT import intentionally refuses the empty native Stack placeholder unless lossy omission is explicit.",
    }, {
      code: "CUT_OTIO_NESTING_ADAPTER_UNSUPPORTED",
      category: "nesting",
      disposition: "unsupported",
      target: { kind: "generic-otio" },
      subject: { kind: "nesting", id: item.nesting.instanceId },
      message: "The bounded nested instance requires CUT profile metadata and has no verified generic adapter preservation.",
    }] : [])),
  ];

  let profile: CutOtioEditorialProfile;
  try {
    profile = createCutOtioEditorialProfile({
      format: "cut-otio-editorial-profile",
      version: 2,
      compositionId: composition.id,
      duration: composition.duration,
      tracks: profileTracks,
      linkGroups,
      linkedCuts,
      transitions,
      losses,
    });
  } catch (error) {
    throw new CutOtioExportError("CUT_OTIO_EDITORIAL_PROFILE", error instanceof Error ? error.message : "Failed to construct the closed OTIO editorial profile.");
  }
  let profileV6: CutOtioEditorialProfileV6 | undefined;
  const pictureTimeMapAuthorities: CutOtioPictureTimeMapAuthority[] = [];
  for (const draftTrack of drafts) {
    if (draftTrack.kind !== "Video") continue;
    const profileTrack = profile.tracks.find((candidate) =>
      candidate.id === draftTrack.id);
    if (!profileTrack) continue;
    for (const draftItem of draftTrack.items) {
      if (draftItem.kind !== "clip"
        || !draftItem.pictureTimeMap
        || !draftItem.node
        || !draftItem.resource
        || draftItem.node.op !== "cut.edit.picture_clip"
        || draftItem.resource.state !== "locked"
        || !draftItem.resource.sha256) continue;
      const profileItem = profileTrack.items.find((candidate) =>
        candidate.id === draftItem.id);
      if (!profileItem || profileItem.kind !== "clip") continue;
      const clock = directMediaClock(draftItem.resource, "Video");
      if (!clock || clock.kind !== "frame") continue;
      const pictureClock = Object.freeze({
        kind: "frame" as const,
        streamIndex: clock.streamIndex,
        timeBase: clock.timeBase,
        rate: clock.rate,
      });
      pictureTimeMapAuthorities.push(
        createCutOtioPictureTimeMapAuthority({
          itemId: profileItem.id,
          trackId: profileTrack.id,
          execution: "direct-picture-time-map-no-lineage",
          policy: cutOtioPictureTimeMapPolicy,
          resource: {
            id: draftItem.resource.id,
            sha256: draftItem.resource.sha256,
          },
          clock: pictureClock,
          source: profileItem.source,
          destination: profileItem.destination,
          nativeRetime: profileItem.retime,
          timeMap: draftItem.pictureTimeMap,
        }),
      );
    }
  }
  if (pictureTimeMapAuthorities.length) {
    try {
      profileV6 = createCutOtioEditorialProfileV6(profile, {
        format: "cut-otio-editorial-picture-time-map-extension",
        version: 6,
        compositionId: composition.id,
        baseProfileSemanticSha256: profile.semanticSha256,
        authorities: pictureTimeMapAuthorities,
      });
    } catch (error) {
      throw new CutOtioExportError(
        "CUT_OTIO_EDITORIAL_PROFILE",
        error instanceof Error
          ? error.message
          : "Failed to construct the V6 picture-time-map extension.",
      );
    }
  }
  let profileV5: CutOtioEditorialProfileV5 | undefined;
  const directMediaAuthorities: CutOtioDirectMediaAuthority[] = [];
  const maximumRational = (left: Rational, right: Rational) =>
    compareRational(left, right) >= 0 ? left : right;
  for (const draftTrack of drafts) {
    const profileTrack = profile.tracks.find((candidate) =>
      candidate.id === draftTrack.id);
    if (!profileTrack) continue;
    for (const draftItem of draftTrack.items) {
      if (draftItem.kind !== "clip"
        || !draftItem.node
        || !draftItem.resource
        || draftItem.timelineAudio
        || draftItem.node.op !== (draftTrack.kind === "Video"
          ? "cut.edit.picture_clip"
          : "cut.audio.clip")
        || draftItem.resource.state !== "locked"
        || !draftItem.resource.sha256) continue;
      const profileItem = profileTrack.items.find((candidate) =>
        candidate.id === draftItem.id);
      if (!profileItem || profileItem.kind !== "clip") continue;
      const clock = directMediaClock(draftItem.resource, draftTrack.kind);
      if (!clock) continue;
      const head = timeInput(draftItem.node.inputs.headHandle)
        ?? zeroRational;
      const tail = timeInput(draftItem.node.inputs.tailHandle)
        ?? zeroRational;
      if (compareRational(head, zeroRational) === 0
        && compareRational(tail, zeroRational) === 0) continue;
      let consumedHead = zeroRational;
      let consumedTail = zeroRational;
      for (const transition of profile.transitions) {
        if (transition.incomingItemId === profileItem.id) {
          consumedHead = maximumRational(
            consumedHead,
            transition.incomingSource.duration,
          );
        }
        if (transition.outgoingItemId === profileItem.id) {
          consumedTail = maximumRational(
            consumedTail,
            transition.outgoingSource.duration,
          );
        }
      }
      directMediaAuthorities.push(createCutOtioDirectMediaAuthority({
        itemId: profileItem.id,
        trackId: profileTrack.id,
        mediaKind: draftTrack.kind === "Video" ? "picture" : "audio",
        execution: "direct-media-no-processor-graph",
        resource: {
          id: draftItem.resource.id,
          kind: draftTrack.kind === "Video" ? "video" : "audio",
          sha256: draftItem.resource.sha256,
        },
        clock,
        source: profileItem.source,
        availableSource: {
          start: subtractRational(profileItem.source.start, head),
          duration: addRational(
            profileItem.source.duration,
            addRational(head, tail),
          ),
        },
        destination: profileItem.destination,
        declaredHandles: { head, tail },
        consumedHandles: {
          head: consumedHead,
          tail: consumedTail,
        },
        retime: profileItem.retime,
        link: profileItem.link,
        ...(profileItem.role === undefined
          ? {}
          : { role: profileItem.role }),
        ...(profileItem.metadata === undefined
          ? {}
          : { metadata: profileItem.metadata }),
        linkedCutIds: profile.linkedCuts
          .filter((cut) =>
            cut.picture.outgoingItemId === profileItem.id
            || cut.picture.incomingItemId === profileItem.id
            || cut.audio.outgoingItemId === profileItem.id
            || cut.audio.incomingItemId === profileItem.id)
          .map((cut) => cut.id)
          .sort((left, right) => left.localeCompare(right)),
        transitionIds: profile.transitions
          .filter((transition) =>
            transition.outgoingItemId === profileItem.id
            || transition.incomingItemId === profileItem.id)
          .map((transition) => transition.id)
          .sort((left, right) => left.localeCompare(right)),
      }));
    }
  }
  if (directMediaAuthorities.length) {
    try {
      profileV5 = createCutOtioEditorialProfileV5(profile, {
        format: "cut-otio-editorial-direct-media-extension",
        version: 5,
        compositionId: composition.id,
        baseProfileSemanticSha256: profile.semanticSha256,
        authorities: directMediaAuthorities,
      });
    } catch (error) {
      throw new CutOtioExportError(
        "CUT_OTIO_EDITORIAL_PROFILE",
        error instanceof Error
          ? error.message
          : "Failed to construct the V5 direct-media extension.",
      );
    }
  }
  let profileV4: CutOtioEditorialProfileV4 | undefined;
  const timelineNestedDrafts = drafts.flatMap((track) =>
    track.items.flatMap((item) =>
      item.timelineNested
        ? [{ track, item, timelineNested: item.timelineNested }]
        : []));
  if (timelineNestedDrafts.length) {
    const completeLineage = new Map<string, {
      planId: string;
      item: TimelineEditItemV1;
    }>();
    for (const entry of timelineNestedDrafts) {
      for (const item of entry.timelineNested.lineageItems) {
        const existing = completeLineage.get(item.segmentId);
        if (existing
          && (existing.planId !== entry.timelineNested.planId
            || stableJsonStringify(existing.item) !== stableJsonStringify(item))) {
          throw new CutOtioExportError(
            "CUT_OTIO_EDITORIAL_PROFILE",
            `Nested lineage segment ${item.segmentId} is ambiguous across TimelineEdit plans.`,
          );
        }
        completeLineage.set(item.segmentId, {
          planId: entry.timelineNested.planId,
          item,
        });
      }
    }
    const retained = new Set<string>();
    const ordered: Array<{ planId: string; item: TimelineEditItemV1 }> = [];
    const retain = (segmentId: string): void => {
      if (retained.has(segmentId)) return;
      const value = completeLineage.get(segmentId);
      if (!value) {
        throw new CutOtioExportError(
          "CUT_OTIO_EDITORIAL_PROFILE",
          `Nested visible placement has no lineage segment ${segmentId}.`,
        );
      }
      if (value.item.parentSegmentId) retain(value.item.parentSegmentId);
      retained.add(segmentId);
      ordered.push(value);
    };
    timelineNestedDrafts.forEach((entry) =>
      retain(entry.timelineNested.item.segmentId));
    const lineageSegments = ordered.map(({ planId, item }) =>
      timelineNestedLineageSegment(planId, item));
    const lineageById = new Map(lineageSegments.map((segment) =>
      [segment.segmentId, segment] as const));
    const placements = timelineNestedDrafts.map((entry) => {
      const profileTrack = profile.tracks.find((track) =>
        track.id === entry.track.id);
      const profileItem = profileTrack?.items.find((item) =>
        item.id === entry.item.id);
      const lineage = lineageById.get(entry.timelineNested.item.segmentId);
      if (!profileTrack
        || !profileItem
        || profileItem.kind !== "nested-sequence"
        || !lineage) {
        throw new CutOtioExportError(
          "CUT_OTIO_EDITORIAL_PROFILE",
          `Nested placement ${entry.item.id} lost its V2 item or V4 lineage.`,
        );
      }
      return {
        itemId: profileItem.id,
        trackId: profileTrack.id,
        segmentId: lineage.segmentId,
        nestingInstanceId: profileItem.nesting.instanceId,
        source: profileItem.source,
        destination: profileItem.destination,
        ...(entry.item.role === undefined ? {} : { role: entry.item.role }),
        ...(entry.item.metadata === undefined
          ? {}
          : { metadata: entry.item.metadata }),
        lineageSha256: lineage.lineageSha256,
      };
    });
    try {
      profileV4 = createCutOtioEditorialProfileV4(profile, {
        format: "cut-otio-editorial-nested-placement-extension",
        version: 4,
        compositionId: composition.id,
        baseProfileSemanticSha256: profile.semanticSha256,
        lineageSegments,
        placements,
      });
    } catch (error) {
      throw new CutOtioExportError(
        "CUT_OTIO_EDITORIAL_PROFILE",
        error instanceof Error
          ? error.message
          : "Failed to construct the V4 nested-placement extension.",
      );
    }
  }
  let profileV3: CutOtioEditorialProfileV3 | undefined;
  const timelineAudioDrafts = drafts.flatMap((track) =>
    track.items.flatMap((item) =>
      item.timelineAudio ? [{ track, item, timelineAudio: item.timelineAudio }] : []));
  if (timelineAudioDrafts.length) {
    const origins = new Map<string, {
      drafts: typeof timelineAudioDrafts;
    }>();
    for (const entry of timelineAudioDrafts) {
      const existing = origins.get(entry.timelineAudio.originNode.id)
        ?? { drafts: [] };
      existing.drafts.push(entry);
      origins.set(entry.timelineAudio.originNode.id, existing);
    }
    const extensionLosses: CutOtioEditorialLoss[] = [];
    const audioOrigins: CutOtioEditorialAudioOrigin[] = [];
    for (const [originId, origin] of [...origins.entries()]
      .sort(([left], [right]) => left.localeCompare(right))) {
      const representative = origin.drafts[0].timelineAudio;
      const sourceView = representative.item.sourceView;
      if (sourceView.kind !== "audio" && sourceView.kind !== "processed-audio") {
        return undefined;
      }
      const originKind = representative.originNode.inputs.originKind;
      const originAuthority = representative.originNode.inputs.originAuthorityId;
      const sourceAuthority = representative.originNode.inputs.sourceAuthorityId;
      const graphAuthority = representative.originNode.inputs.graphAuthorityId;
      const statePolicy = representative.originNode.inputs.statePolicy;
      if (originKind?.kind !== "string"
        || originAuthority?.kind !== "string"
        || sourceAuthority?.kind !== "string"
        || statePolicy?.kind !== "string"
        || statePolicy.value !== "single-authorized-evaluation"
        || (originKind.value === "processed-audio") !== (graphAuthority?.kind === "string")) {
        return undefined;
      }
      const baseStart = subtractRational(
        sourceView.source.start,
        multiplyRational(
          sourceView.presentationClock.sliceOffset,
          sourceView.rate,
        ),
      );
      const completeLineage = representative.lineageItems.map((item) =>
        timelineAudioLineageSegment(representative.planId, item));
      const lineageIdentity = stableJsonStringify(completeLineage);
      if (origin.drafts.some((entry) =>
        entry.timelineAudio.planId !== representative.planId
        || stableJsonStringify(entry.timelineAudio.lineageItems.map((item) =>
          timelineAudioLineageSegment(entry.timelineAudio.planId, item)))
          !== lineageIdentity)) {
        throw new CutOtioExportError(
          "CUT_OTIO_EDITORIAL_PROFILE",
          `Timeline audio origin ${originId} has inconsistent plan lineage across visible views.`,
        );
      }
      const completeLineageBySegmentId = new Map(completeLineage.map((segment) =>
        [segment.segmentId, segment] as const));
      const retainedLineageIds = new Set<string>();
      const retainLineage = (segmentId: string): void => {
        if (retainedLineageIds.has(segmentId)) return;
        const segment = completeLineageBySegmentId.get(segmentId);
        if (!segment) {
          throw new CutOtioExportError(
            "CUT_OTIO_EDITORIAL_PROFILE",
            `Timeline audio origin ${originId} has an orphan lineage segment ${segmentId}.`,
          );
        }
        if (segment.parentSegmentId) retainLineage(segment.parentSegmentId);
        retainedLineageIds.add(segmentId);
      };
      origin.drafts.forEach((entry) =>
        retainLineage(entry.timelineAudio.item.segmentId));
      const lineageSegments = completeLineage.filter((segment) =>
        retainedLineageIds.has(segment.segmentId));
      const lineageBySegmentId = new Map(lineageSegments.map((segment) =>
        [segment.segmentId, segment] as const));
      const views: CutOtioEditorialAudioOriginView[] = origin.drafts.map((entry) => {
        const view = entry.timelineAudio.item;
        if (view.sourceView.kind !== "audio"
          && view.sourceView.kind !== "processed-audio") {
          throw new CutOtioExportError(
            "CUT_OTIO_EDITORIAL_PROFILE",
            `Timeline audio origin ${originId} mixed incompatible source views.`,
          );
        }
        const profileTrack = profile.tracks.find((track) =>
          track.id === entry.track.id);
        const profileItem = profileTrack?.items.find((item) =>
          item.id === entry.item.id);
        if (!profileItem || profileItem.kind !== "clip") {
          throw new CutOtioExportError(
            "CUT_OTIO_EDITORIAL_PROFILE",
            `Timeline audio view ${entry.item.id} lost its V2 native item.`,
          );
        }
        const lineage = lineageBySegmentId.get(view.segmentId);
        if (!lineage) {
          throw new CutOtioExportError(
            "CUT_OTIO_EDITORIAL_PROFILE",
            `Timeline audio view ${entry.item.id} has no authenticated lineage segment.`,
          );
        }
        return {
          itemId: profileItem.id,
          segmentId: view.segmentId,
          ...(view.parentSegmentId
            ? { parentSegmentId: view.parentSegmentId }
            : {}),
          sliceOffset: view.sourceView.presentationClock.sliceOffset,
          source: profileItem.source,
          destination: profileItem.destination,
          handles: view.sourceView.handles,
          link: profileItem.link,
          ...(profileItem.role === undefined
            ? {}
            : { role: profileItem.role }),
          ...(profileItem.metadata === undefined
            ? {}
            : { metadata: profileItem.metadata }),
          lineageSha256: lineage.lineageSha256,
        };
      });
      if (originKind.value === "processed-audio") {
        for (const view of views) {
          extensionLosses.push({
            code: "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED",
            category: "effect",
            disposition: "unsupported",
            target: { kind: "cut-roundtrip" },
            subject: { kind: "item", id: view.itemId },
            message: "The V3 extension authenticates this visible placement's shared CUT processor graph, source-relative fade envelope, and single origin-clock evaluation. The current source importer can recreate its exact native timing and forward constant retime, but cannot serialize or reconstruct those shared processed semantics.",
          }, {
            code: "CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED",
            category: "effect",
            disposition: "metadata-required",
            target: { kind: "generic-otio" },
            subject: { kind: "item", id: view.itemId },
            message: "Native OTIO retains this placement's exact media slice, destination, role, metadata, and LinearTimeWarp. Its CUT processor graph, source-relative fades, and shared origin clock require the closed V3 metadata and are not generic-lossless.",
          });
        }
      }
      for (const transition of profile.transitions.filter((candidate) =>
        views.some((view) =>
          candidate.outgoingItemId === view.itemId
          || candidate.incomingItemId === view.itemId))) {
        extensionLosses.push({
          code: "CUT_OTIO_AUDIO_ORIGIN_TRANSITION_UNSUPPORTED",
          category: "transition",
          disposition: "unsupported",
          target: { kind: "cut-roundtrip" },
          subject: { kind: "transition", id: transition.id },
          message: "The current importer cannot reconstruct a transition that consumes handles from a shared origin-clock Audio view without restarting the origin graph.",
        });
      }
      const graphNodes = [
        representative.sourceRoot,
        ...representative.processorNodeIds.map((id) => ir.nodes[id]).filter(Boolean),
        representative.sourceLeaf,
      ];
      audioOrigins.push({
        id: originId,
        trackId: timelineEditAudioPresentationOriginTrackId(
          representative.item,
        ),
        timelineEditPlanId: representative.planId,
        timelineEditOriginId:
          timelineEditAudioPresentationOriginId(representative.item),
        kind: originKind.value as "direct-audio" | "processed-audio",
        originAuthorityId: originAuthority.value,
        sourceAuthorityId: sourceAuthority.value,
        ...(graphAuthority?.kind === "string"
          ? { graphAuthorityId: graphAuthority.value }
          : {}),
        sourceNodeId: representative.sourceLeaf.id,
        processorNodeIds: representative.processorNodeIds,
        ...(originKind.value === "processed-audio"
          ? {
              processorGraphSemanticSha256: hash(graphNodes.map((node) => ({
                id: node.id,
                op: node.op,
                interval: node.interval,
                inputs: node.inputs,
                children: node.children,
                properties: node.properties,
                effects: node.effects,
                contentHash: node.contentHash,
              }))),
            }
          : {}),
        statePolicy: "single-authorized-evaluation",
        source: {
          start: baseStart,
          duration: multiplyRational(
            sourceView.presentationClock.originDuration,
            sourceView.rate,
          ),
        },
        originDuration: sourceView.presentationClock.originDuration,
        rate: sourceView.rate,
        fadeIn: sourceView.fadeIn,
        fadeOut: sourceView.fadeOut,
        lineageSegments,
        views,
      });
    }
    try {
      profileV3 = createCutOtioEditorialProfileV3(profile, {
        format: "cut-otio-editorial-profile-extension",
        version: 3,
        compositionId: composition.id,
        baseProfileSemanticSha256: profile.semanticSha256,
        audioOrigins,
        losses: extensionLosses,
      });
    } catch (error) {
      throw new CutOtioExportError(
        "CUT_OTIO_EDITORIAL_PROFILE",
        error instanceof Error
          ? error.message
          : "Failed to construct the V3 origin-clock extension.",
      );
    }
    for (const loss of extensionLosses) {
      if (loss.target.kind !== "cut-roundtrip") continue;
      profileIssues.push({
        code: loss.code,
        category: loss.category === "effect" ? "effect" : "timing",
        disposition: loss.disposition === "unsupported" ? "omitted" : "metadata-only",
        subject: {
          kind: "composition",
          id: composition.id,
          property: `${loss.subject.kind}:${loss.subject.id}`,
        },
        message: loss.message,
        provenance: composition.provenance,
      });
    }
  }
  const profileTrackById = new Map(profile.tracks.map((track) => [track.id, track]));
  const draftItemById = new Map(drafts.flatMap((track) => track.items.map((item) => [item.id, item] as const)));
  const transitionByIncoming = new Map<string, CutOtioEditorialTransition[]>();
  profile.transitions.forEach((transition) => {
    const values = transitionByIncoming.get(transition.incomingItemId) ?? [];
    values.push(transition);
    transitionByIncoming.set(transition.incomingItemId, values);
  });
  const nativeTracks = drafts.map((draft): OtioTrack => {
    const profileTrack = profileTrackById.get(draft.id);
    if (!profileTrack) throw new CutOtioExportError("CUT_OTIO_EDITORIAL_PROFILE", `Missing finalized profile track ${draft.id}.`);
    const children: OtioTrackChild[] = [];
    profileTrack.items.forEach((item) => {
      for (const transition of transitionByIncoming.get(item.id) ?? []) children.push(nativeEditorialTransition(transition));
      if (item.kind === "gap") children.push(nativeEditorialGap(item));
      else if (item.kind === "nested-sequence") {
        const draftItem = draftItemById.get(item.id);
        if (!draftItem) {
          throw new CutOtioExportError(
            "CUT_OTIO_EDITORIAL_PROFILE",
            `Missing finalized nested profile item ${item.id}.`,
          );
        }
        children.push(nativeEditorialNested(item, draftItem));
      }
      else {
        const draftItem = draftItemById.get(item.id);
        if (!draftItem) throw new CutOtioExportError("CUT_OTIO_EDITORIAL_PROFILE", `Missing finalized profile item ${item.id}.`);
        children.push(nativeEditorialClip(
          item,
          draftItem,
          profileTrack.kind,
          scene.id,
          profileV5?.authorities.find((authority) =>
            authority.itemId === item.id),
          profileV6?.authorities.find((authority) =>
            authority.itemId === item.id),
        ));
      }
    });
    return {
      OTIO_SCHEMA: "Track.1",
      name: `${profileTrack.kind === "Video" ? "V" : "A"}${profileTrack.order + 1} · ${profileTrack.id}`,
      metadata: {
        cut: {
          source_node_id: draft.node.id,
          source_node_op: draft.node.op,
          scene_id: scene.id,
          layer_index: profileTrack.order,
          exact_placement: exactMetadata(zeroRational),
          editorial_track_id: profileTrack.id,
          editorial_track_order: profileTrack.order,
          editorial_profile_version: 2,
          ...(profileTrack.role === undefined ? {} : { editorial_role: profileTrack.role }),
          ...(profileTrack.metadata === undefined ? {} : { editorial_metadata: profileTrack.metadata }),
        },
      },
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      kind: profileTrack.kind,
      children,
    };
  });
  issues.push(...profileIssues);
  return {
    profile,
    ...(profileV3 ? { profileV3 } : {}),
    ...(profileV4 ? { profileV4 } : {}),
    ...(profileV5 ? { profileV5 } : {}),
    ...(profileV6 ? { profileV6 } : {}),
    tracks: nativeTracks,
    ownedNodeIds,
    sourceNodeIds,
    linkNames,
    gaps: profile.tracks.reduce((total, track) => total + track.items.filter((item) => item.kind === "gap").length, 0),
    clips: profile.tracks.reduce((total, track) => total + track.items.filter((item) => item.kind === "clip").length, 0),
  };
}

function unsupportedNodeIssues(ir: CutAVIR, nodeIds: string[], issues: CutOtioUnsupportedSemantic[], profileCovered = new Set<string>()) {
  const relevantSignals = new Set<string>();
  const relevantEffectProvenance = new Set<string>();
  const provenanceKey = (op: string, value: IRProvenance) =>
    `${op}\0${value.module}\0${value.span.start.offset}\0${value.span.end.offset}\0${value.symbol ?? ""}`;
  for (const id of nodeIds) {
    const node = ir.nodes[id];
    if (!node) continue;
    if (profileCovered.has(id)) continue;
    relevantEffectProvenance.add(provenanceKey(node.op, node.provenance));
    if (node.editorial?.kind === "picture-track") {
      for (const transition of node.editorial.transitions ?? []) {
        issues.push({
          code: "CUT_OTIO_TRACK_TRANSITION_UNSUPPORTED",
          category: "timing",
          disposition: "omitted",
          subject: { kind: "node", id: node.id, op: node.op, property: `transition@${transition.cut.numerator}/${transition.cut.denominator}s` },
          message: `CUT's centered ${transition.style.kind} PictureTrack transition consumes explicit source handles and is not serialized as a hard cut or silently flattened into OTIO.`,
          provenance: transition.provenance,
        });
      }
    }
    if (node.editorial?.kind === "audio-track") {
      const processed = node.editorial.operationPlan?.version === 2;
      for (const transition of node.editorial.transitions ?? []) {
        issues.push({
          code: "CUT_OTIO_AUDIO_CROSSFADE_UNSUPPORTED",
          category: "timing",
          disposition: "omitted",
          subject: { kind: "node", id: node.id, op: node.op, property: `audioCrossfade@${transition.cut.numerator}/${transition.cut.denominator}s` },
          message: processed
            ? `CUT's centered ${transition.curve} processed AudioRegion crossfade consumes exact outer-region handles, evaluates each ordered static processor chain across its expanded window, and applies CUT-owned envelopes before track mix. OTIO receives neither those handles, processor-state semantics, nor the transition envelope; the hard-cut export is explicitly lossy.`
            : `CUT's centered ${transition.curve} AudioTrack crossfade consumes exact source handles and is not flattened into an OTIO hard cut.`,
          provenance: transition.provenance,
        });
      }
    }
    const linkedSplit = node.op === "cut.edit.jcut" || node.op === "cut.edit.lcut";
    if (linkedSplit) {
      issues.push({
        code: "CUT_OTIO_LINKED_SPLIT_UNSUPPORTED",
        category: "timing",
        disposition: "flattened",
        subject: { kind: "node", id: node.id, op: node.op, property: "overlap" },
        message: `${node.op} is exported as its two exact linked Clip track pairs, but standard OTIO cannot preserve CUT's distinct hard-picture and hard-audio cuts. The export is explicitly lossy rather than silently turning it into a dissolve or ordinary overlap.`,
        provenance: node.provenance,
      });
    }
    const nestedSequence = node.op === "cut.edit.nested_sequence";
    if (nestedSequence) {
      issues.push({
        code: "CUT_OTIO_NESTED_SEQUENCE_UNSUPPORTED",
        category: "timing",
        disposition: "omitted",
        subject: { kind: "node", id: node.id, op: node.op, property: "source" },
        message: "CUT NestedSequence retains a separately owned audiovisual timeline and exact source clock. This OTIO subset does not silently flatten or duplicate that source graph; the nested instance is explicitly omitted as lossy.",
        provenance: node.provenance,
      });
    }
    const audioRegion = node.op === "cut.edit.audio_region";
    if (audioRegion) {
      const retime = audioRegionTimeStretch(ir, node);
      issues.push({
        code: "CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED",
        category: "effect",
        disposition: "flattened",
        subject: { kind: "node", id: node.id, op: node.op, property: "processing-link-automation" },
        message: `AudioRegion ${node.id} is flattened to its one exact AudioClip descendant as an unprocessed hard clip. OTIO preserves that leaf's visible source range and destination placement, but cannot preserve the region's ordered processor chain, link grouping, declared head/tail handles, expanded transition windows, envelopes, or processor state across a cut. Import will not reconstruct AudioRegion; this export is explicitly lossy rather than round-trippable.`,
        provenance: node.provenance,
      });
      if (retime) {
        issues.push({
          code: "CUT_OTIO_AUDIO_REGION_RETIME_UNSUPPORTED",
          category: "timing",
          disposition: "flattened",
          subject: { kind: "node", id: node.id, op: node.op, property: "time-stretch" },
          message: `AudioRegion ${node.id} owns TimeStretch ${retime.id}; standard OTIO cannot preserve CUT's exact sourceDuration/destination duration, static pitch/quality, processor-side ordering, or CUT-owned DSP identity. The exported clip is therefore explicitly lossy.`,
          provenance: retime.provenance,
        });
      }
    }
    const isMedia = visualMediaOps.has(node.op) || audioMediaOps.has(node.op) || linkedMediaOps.has(node.op);
    if (!isMedia && !transparentContainers.has(node.op) && !linkedSplit && !nestedSequence && !audioRegion) {
      issues.push({
        code: flattenedContainers.has(node.op) ? "CUT_OTIO_NODE_FLATTENED" : "CUT_OTIO_NODE_UNSUPPORTED",
        category: "node",
        disposition: flattenedContainers.has(node.op) ? "flattened" : "omitted",
        subject: { kind: "node", id: node.id, op: node.op },
        message: flattenedContainers.has(node.op)
          ? `${node.op} is flattened to its media descendants; its processing/compositing semantics are not portable OTIO editorial semantics.`
          : `${node.op} has no standard OTIO editorial representation and is omitted.`,
        provenance: node.provenance,
      });
    }

    const supportedInputs = node.op === "cut.visual.video"
      ? new Set(["source", "range", "loop", "endBehavior"])
      : node.op === "cut.visual.image"
        ? new Set(["source"])
        : node.op === "cut.audio.clip"
          ? new Set(["source", "range"])
          : node.op === "cut.documentary.narration"
            ? new Set(["source", "range"])
            : node.op === "cut.edit.clip"
              ? new Set(["source", "range"])
              : undefined;
    if (supportedInputs) {
      for (const input of Object.keys(node.inputs)) {
        // Narration transcript compatibility is handled once, with exact
        // evidence and explicit acceptance, before this generic report pass.
        if (node.op === "cut.documentary.narration" && input === "transcript") continue;
        if (supportedInputs.has(input)) continue;
        issues.push({
          code: "CUT_OTIO_PARAMETER_UNSUPPORTED",
          category: "parameter",
          disposition: "omitted",
          subject: { kind: "node", id: node.id, op: node.op, property: input },
          message: `${node.op}.${input} is not a portable OTIO editorial parameter.`,
          provenance: node.provenance,
        });
      }
    }

    for (const [property, value] of Object.entries(node.properties)) {
      if ("signal" in value) relevantSignals.add(value.signal);
      else {
        issues.push({
          code: "CUT_OTIO_PROPERTY_UNSUPPORTED",
          category: "property",
          disposition: "omitted",
          subject: { kind: "node", id: node.id, op: node.op, property },
          message: `${node.op}.${property} is a CUT render property without a portable OTIO editorial representation.`,
          provenance: node.provenance,
        });
      }
    }
    for (const effect of node.effects) {
      if (effect === "pure") continue;
      issues.push({
        code: "CUT_OTIO_EFFECT_UNSUPPORTED",
        category: "effect",
        disposition: "omitted",
        subject: { kind: "node", id: node.id, op: node.op, property: effect },
        message: `CUT effect capability “${effect}” is not executed or serialized as an OTIO effect.`,
        provenance: node.provenance,
      });
    }
  }

  for (const signalId of [...relevantSignals].sort()) {
    const signal = ir.signals[signalId];
    issues.push({
      code: "CUT_OTIO_SIGNAL_UNSUPPORTED",
      category: "signal",
      disposition: "omitted",
      subject: { kind: "signal", id: signalId },
      message: `CUT ${signal?.kind ?? "unknown"} signal ${signalId} is not a portable OTIO editorial effect.`,
      provenance: signal?.provenance,
    });
  }

  for (const job of ir.jobs) {
    if (!relevantEffectProvenance.has(provenanceKey(job.op, job.provenance))) continue;
    issues.push({
      code: "CUT_OTIO_EFFECT_JOB_UNSUPPORTED",
      category: "effect",
      disposition: "omitted",
      subject: { kind: "job", id: job.id, op: job.op, property: job.effect },
      message: `CUT ${job.effect} job ${job.id} is not executed by the OTIO exporter.`,
      provenance: job.provenance,
    });
  }
}

function unsupportedLinkedEditIssues(ir: CutAVIR, compositionId: string, issues: CutOtioUnsupportedSemantic[]) {
  for (const edit of ir.linkedEdits ?? []) {
    if (edit.compositionId !== compositionId) continue;
    switch (edit.kind) {
      case "linked-ripple-delete":
        issues.push({
          code: "CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED",
          category: "timing",
          disposition: "flattened",
          subject: {
            kind: "linked-edit",
            id: edit.id,
            op: "cut.edit.linked_ripple_delete",
            property: "atomic-ripple-correlation",
          },
          message: `LinkedRippleDelete transaction ${edit.id} atomically correlates the picture and audio ripple closures for link ${JSON.stringify(edit.linkId)} over scene-local range ${edit.range.start.numerator}/${edit.range.start.denominator}s + ${edit.range.duration.numerator}/${edit.range.duration.denominator}s. CUT's materialized post-edit track state remains independently useful where representable, but standard OTIO cannot reconstruct the transaction, its insert-before-delete ordering, or its cross-track correlation; the export is explicitly lossy rather than round-trippable.`,
          provenance: edit.provenance,
        });
        break;
      case "linked-trim":
        issues.push({
          code: "CUT_OTIO_LINKED_TRIM_UNSUPPORTED",
          category: "timing",
          disposition: "flattened",
          subject: {
            kind: "linked-edit",
            id: edit.id,
            op: "cut.edit.linked_trim",
            property: "atomic-correlation",
          },
          message: `LinkedTrim transaction ${edit.id} atomically correlates the picture and audio trims for link ${JSON.stringify(edit.linkId)}. CUT's materialized hard-cut state remains independently useful where representable, but this OTIO subset cannot reconstruct the transaction or its cross-track correlation; the export is explicitly lossy rather than round-trippable.`,
          provenance: edit.provenance,
        });
        break;
      default: {
        const unreachable: never = edit;
        throw new CutOtioExportError("CUT_OTIO_LINKED_EDIT_KIND", `Unsupported CUT linked-edit kind ${JSON.stringify((unreachable as { kind?: unknown }).kind)}.`);
      }
    }
  }
}

function unsupportedSemanticMatchIssues(ir: CutAVIR, compositionId: string, issues: CutOtioUnsupportedSemantic[]) {
  const matches = ir.semanticMatches;
  if (!matches) return;
  for (const subject of matches.subjects) {
    if (subject.compositionId !== compositionId) continue;
    issues.push({
      code: "CUT_OTIO_SEMANTIC_MATCH_UNSUPPORTED",
      category: "timing",
      disposition: "omitted",
      subject: {
        kind: "semantic-match",
        id: subject.id,
        op: "cut.edit.match_subject",
        property: subject.authoredId,
      },
      message: `MatchSubject ${JSON.stringify(subject.authoredId)} binds retained Camera2D/LocalSpace identity and scene ownership that standard OTIO cannot reconstruct. The declaration is explicitly omitted; it is never converted to a clip effect or metadata-only substitute.`,
      provenance: subject.provenance,
    });
  }
  for (const transition of matches.transitions) {
    if (transition.compositionId !== compositionId) continue;
    issues.push({
      code: "CUT_OTIO_SEMANTIC_MATCH_UNSUPPORTED",
      category: "timing",
      disposition: "omitted",
      subject: {
        kind: "semantic-match",
        id: transition.id,
        op: "cut.edit.match_transition",
        property: transition.authoredId,
      },
      message: `MatchTransition ${JSON.stringify(transition.authoredId)} owns two exact adjacent-scene half-windows, retained subject pose continuity, optional color convergence, and velocity semantics that standard OTIO cannot preserve. The hard-cut export is explicitly lossy and cannot round-trip the match.`,
      provenance: transition.provenance,
    });
  }
}

function validateOptions(options: CutOtioExportOptions) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new CutOtioExportError("CUT_OTIO_INVALID_OPTIONS", "OTIO export options must be a plain object.");
  }
  const allowed = new Set(["compositionId", "maxClipInstances", "allowLossy"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new CutOtioExportError("CUT_OTIO_INVALID_OPTIONS", `Unknown OTIO export option ${JSON.stringify(key)}.`);
  }
  if (options.allowLossy !== undefined && typeof options.allowLossy !== "boolean") {
    throw new CutOtioExportError("CUT_OTIO_INVALID_OPTIONS", "allowLossy must be a boolean.");
  }
  const maxClipInstances = options.maxClipInstances ?? 100_000;
  if (!Number.isSafeInteger(maxClipInstances) || maxClipInstances < 1 || maxClipInstances > 1_000_000) {
    throw new CutOtioExportError("CUT_OTIO_INVALID_LIMIT", "maxClipInstances must be an integer from 1 through 1,000,000.");
  }
  return { maxClipInstances, allowLossy: options.allowLossy ?? false };
}

function narrationTranscriptIssue(node: IRNode): CutOtioUnsupportedSemantic | undefined {
  if (node.op !== "cut.documentary.narration" || !Object.hasOwn(node.inputs, "transcript")) return undefined;
  const input = node.inputs.transcript;
  return {
    code: "CUT_OTIO_NARRATION_TRANSCRIPT_UNSUPPORTED",
    category: "parameter",
    disposition: "omitted",
    subject: { kind: "node", id: node.id, op: node.op, property: "transcript" },
    message: "Narration transcript was metadata-only in the archived CUT 0.4 path and has no executable current Narration meaning. It is omitted only under explicit lossy acceptance; use Captions for visible timed text or Marker/Region role metadata for non-rendering notes.",
    provenance: node.provenance,
    evidence: {
      inputKind: input.kind,
      ...(input.kind === "string" ? { value: input.value } : {}),
    },
  };
}

function unsupportedSceneLayout(ir: CutAVIR, composition: CutAVIR["compositions"][number]) {
  let cursor = zeroRational;
  for (const [index, sceneId] of composition.sceneIds.entries()) {
    const scene = ir.scenes[sceneId];
    if (!scene) return `scene ${sceneId} at index ${index} is missing from the IR`;
    if (compareRational(scene.start, cursor) !== 0) {
      return `scene ${sceneId} starts at ${scene.start.numerator}/${scene.start.denominator}, but the reconstructable contiguous layout requires ${cursor.numerator}/${cursor.denominator}`;
    }
    if (compareRational(scene.duration, zeroRational) <= 0) return `scene ${sceneId} has a non-positive duration`;
    cursor = addRational(scene.start, scene.duration);
  }
  if (compareRational(cursor, composition.duration) !== 0) {
    return `declared scenes end at ${cursor.numerator}/${cursor.denominator}, not the composition duration ${composition.duration.numerator}/${composition.duration.denominator}`;
  }
  return undefined;
}

function unsupportedScenePartition(ir: CutAVIR, composition: CutAVIR["compositions"][number], tracks: OtioTrack[]) {
  const key = (value: Rational) => `${value.numerator}/${value.denominator}`;
  const boundaries = new Set<string>([key(zeroRational), key(composition.duration)]);
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (!scene) continue;
    boundaries.add(key(scene.start));
    boundaries.add(key(addRational(scene.start, scene.duration)));
  }
  for (const track of tracks) {
    if (track.kind !== "Video") continue;
    let cursor = zeroRational;
    for (const item of track.children) {
      if (item.OTIO_SCHEMA === "Transition.1") continue;
      const duration = rational(item.source_range.duration.value, item.source_range.duration.rate);
      const end = addRational(cursor, duration);
      if (item.OTIO_SCHEMA === "Clip.2" && (!boundaries.has(key(cursor)) || !boundaries.has(key(end)))) {
        return `video track ${JSON.stringify(track.name)} has a clip boundary at ${cursor.numerator}/${cursor.denominator}..${end.numerator}/${end.denominator} inside an authored scene`;
      }
      cursor = end;
    }
  }
  return undefined;
}

/**
 * Export the editorial subset of one CutAVIR composition to native OTIO JSON.
 *
 * This function never invokes FFmpeg, a model, package code, or a hidden edit
 * plan. The returned report is part of the contract: callers must not treat a
 * `lossy-editorial` export as a faithful substitute for rendering CUT source.
 */
function exportCutTimelineToOtioAdapter(ir: CutAVIR, options: CutOtioExportOptions = {}): CutOtioExport {
  if (ir.format !== "cut-av-ir" || ir.version !== 3) {
    throw new CutOtioExportError("CUT_OTIO_IR_VERSION", "The OTIO exporter requires CutAVIR v3.");
  }
  const { maxClipInstances, allowLossy } = validateOptions(options);
  let composition = options.compositionId
    ? ir.compositions.find((item) => item.id === options.compositionId || item.name === options.compositionId)
    : undefined;
  if (!composition && !options.compositionId && ir.compositions.length === 1) composition = ir.compositions[0];
  if (!composition) {
    const message = options.compositionId
      ? `Unknown CUT composition “${options.compositionId}”.`
      : ir.compositions.length
        ? "CUT IR contains multiple compositions; compositionId is required."
        : "CUT IR contains no composition to export.";
    throw new CutOtioExportError("CUT_OTIO_COMPOSITION_REQUIRED", message);
  }

  exactRational(composition.duration, `Composition ${composition.id} duration`);
  exactRational(composition.fps, `Composition ${composition.id} fps`);
  const compositionSceneIds = new Set(composition.sceneIds);
  const roots = rootIds(ir, composition.id);
  const renderOrder = graphOrder(ir, roots, false);
  const relevantOrder = graphOrder(ir, roots, true);
  const issues: CutOtioUnsupportedSemantic[] = [];
  const narrationTranscriptIssues = relevantOrder.flatMap((id) => {
    const node = ir.nodes[id], issue = node ? narrationTranscriptIssue(node) : undefined;
    return issue ? [issue] : [];
  });
  if (narrationTranscriptIssues.length) {
    const first = narrationTranscriptIssues[0];
    if (ir.compiler !== "cut-ts/0.3.0") {
      throw new CutOtioExportError(
        "CUT_OTIO_CURRENT_NARRATION_TRANSCRIPT",
        "Current CutAVIR contains the removed cut.documentary.narration transcript input; refusing invalid current IR before OTIO publication.",
        first,
      );
    }
    if (!allowLossy) {
      throw new CutOtioExportError(
        "CUT_OTIO_NARRATION_TRANSCRIPT_REFUSED",
        "Archived Narration transcript metadata cannot be preserved as executable current CUT; rerun with explicit allowLossy only if the reported omission is acceptable.",
        first,
      );
    }
    issues.push(...narrationTranscriptIssues);
  }
  unsupportedSemanticMatchIssues(ir, composition.id, issues);
  unsupportedLinkedEditIssues(ir, composition.id, issues);
  const editorialProfileExport = editorialProfileNativeExport(ir, composition, relevantOrder, issues);
  if (editorialProfileExport === undefined) {
    issues.push({
      code: "CUT_OTIO_EDITORIAL_PROFILE_UNAVAILABLE",
      category: "timing",
      disposition: "flattened",
      subject: { kind: "composition", id: composition.id },
      message: "The composition contains canonical editorial state that is outside the closed OTIO editorial profile; the compatibility exporter will retain only independently representable leaf media and report every omitted semantic.",
      provenance: composition.provenance,
    });
  }
  for (const loss of editorialProfileExport?.profile.losses ?? []) {
    if (loss.target.kind !== "cut-roundtrip") continue;
    if (issues.some((issue) => issue.code === loss.code
      && issue.subject.property === `${loss.subject.kind}:${loss.subject.id}`)) continue;
    issues.push({
      code: loss.code,
      category: "timing",
      disposition: "metadata-only",
      subject: {
        kind: "composition",
        id: composition.id,
        property: `${loss.subject.kind}:${loss.subject.id}`,
      },
      message: loss.message,
      provenance: composition.provenance,
    });
  }
  unsupportedNodeIssues(ir, relevantOrder, issues, editorialProfileExport?.ownedNodeIds);
  const sceneLayoutProblem = unsupportedSceneLayout(ir, composition);
  if (sceneLayoutProblem) {
    issues.push({
      code: "CUT_OTIO_SCENE_LAYOUT_UNSUPPORTED",
      category: "timing",
      disposition: "metadata-only",
      subject: { kind: "composition", id: composition.id },
      message: `CUT scene layout cannot be reconstructed by the executable OTIO importer: ${sceneLayoutProblem}. Exact scene metadata is retained, but this export is not lossless-editorial.`,
      provenance: composition.provenance,
    });
  }

  const tracks: OtioTrack[] = editorialProfileExport ? [...editorialProfileExport.tracks] : [];
  const sourceNodeIds: string[] = editorialProfileExport ? [...editorialProfileExport.sourceNodeIds] : [];
  let videoTracks = editorialProfileExport?.tracks.filter((track) => track.kind === "Video").length ?? 0;
  let audioTracks = editorialProfileExport?.tracks.filter((track) => track.kind === "Audio").length ?? 0;
  let clipInstances = editorialProfileExport?.clips ?? 0;
  let gaps = editorialProfileExport?.gaps ?? 0;
  for (const nodeId of renderOrder) {
    const node = ir.nodes[nodeId];
    if (!node || (!visualMediaOps.has(node.op) && !audioMediaOps.has(node.op) && !linkedMediaOps.has(node.op))) continue;
    if (editorialProfileExport?.ownedNodeIds.has(node.id)) continue;
    const scene = sceneForNode(ir, compositionSceneIds, node);
    if (node.sceneId && !scene) {
      issues.push({
        code: "CUT_OTIO_SCENE_OUTSIDE_COMPOSITION",
        category: "timing",
        disposition: "omitted",
        subject: { kind: "node", id: node.id, op: node.op },
        message: `Node ${node.id} belongs to a scene outside composition ${composition.id}.`,
        provenance: node.provenance,
      });
      continue;
    }
    const placement = addRational(scene?.start ?? zeroRational, node.interval.start);
    if (compareRational(placement, zeroRational) < 0 || compareRational(placement, composition.duration) >= 0) {
      issues.push({
        code: "CUT_OTIO_PLACEMENT_OUTSIDE_COMPOSITION",
        category: "timing",
        disposition: "omitted",
        subject: { kind: "node", id: node.id, op: node.op },
        message: `Node ${node.id} starts outside composition ${composition.id}.`,
        provenance: node.provenance,
      });
      continue;
    }
    exactRational(placement, `Node ${node.id} placement`);
    const availableDuration = subtractRational(composition.duration, placement);
    const resource = resourceFor(node, ir);
    if (!resource) {
      issues.push({
        code: "CUT_OTIO_RESOURCE_UNRESOLVED",
        category: "resource",
        disposition: "omitted",
        subject: { kind: "node", id: node.id, op: node.op, property: "source" },
        message: `Node ${node.id} has no resolvable resource-ref source.`,
        provenance: node.provenance,
      });
      continue;
    }
    if (resource.state !== "locked" || !resource.sha256) {
      issues.push({
        code: "CUT_OTIO_RESOURCE_UNLOCKED",
        category: "resource",
        disposition: "metadata-only",
        subject: { kind: "resource", id: resource.id },
        message: `Resource ${resource.id} is exported by locator but is not content-locked.`,
        provenance: resource.provenance,
      });
    }

    const kinds: MediaKind[] = linkedMediaOps.has(node.op)
      ? ["video", "audio"]
      : visualMediaOps.has(node.op)
        ? ["video"]
        : ["audio"];
    let emitted = false;
    for (const kind of kinds) {
      const segments = mediaSegments(node, kind, availableDuration, maxClipInstances - clipInstances, issues);
      if (!segments?.length) continue;
      if (clipInstances + segments.length > maxClipInstances) {
        throw new CutOtioExportError("CUT_OTIO_CLIP_LIMIT", `Export exceeded the configured ${maxClipInstances} clip-instance limit.`);
      }
      const ordinal = kind === "video" ? ++videoTracks : ++audioTracks;
      const built = makeTrack(
        node,
        resource,
        kind,
        placement,
        segments,
        composition.duration,
        scene?.id,
        linkedMediaOps.has(node.op) ? node.id : undefined,
        ordinal,
      );
      tracks.push(built.track);
      gaps += built.gaps;
      clipInstances += built.clips;
      emitted = true;
    }
    if (emitted) sourceNodeIds.push(node.id);
  }

  if (!sceneLayoutProblem && !editorialProfileExport) {
    const scenePartitionProblem = unsupportedScenePartition(ir, composition, tracks);
    if (scenePartitionProblem) {
      issues.push({
        code: "CUT_OTIO_SCENE_PARTITION_UNSUPPORTED",
        category: "timing",
        disposition: "metadata-only",
        subject: { kind: "composition", id: composition.id },
        message: `CUT scene identity cannot be reconstructed by the executable OTIO importer: ${scenePartitionProblem}. Exact scene metadata is retained, but this export is not lossless-editorial.`,
        provenance: composition.provenance,
      });
    }
  }

  const exportedAnnotations = annotationMarkers(ir, composition.id);
  const exportedMarkerCount = ir.annotations?.markers.filter((marker) => marker.compositionId === composition.id).length ?? 0;
  const exportedRegionCount = ir.annotations?.regions.filter((region) => region.compositionId === composition.id).length ?? 0;
  const report: CutOtioInterchangeReport = {
    format: "cut-otio-interchange-report",
    version: 1,
    backend: cutOtioInterchangeBackendReportIdentity,
    source: {
      irFormat: ir.format,
      irVersion: ir.version,
      language: ir.language,
      buildId: ir.buildId,
      project: ir.project,
      compositionId: composition.id,
    },
    timing: {
      guarantee: "exact-rational",
      encoding: "RationalTime.value=numerator; RationalTime.rate=denominator",
      numericBoundary: "signed integers at or below Number.MAX_SAFE_INTEGER",
    },
    status: issues.length ? "lossy-editorial" : "lossless-editorial",
    exported: { sourceNodeIds, videoTracks, audioTracks, clipInstances, gaps, markers: exportedMarkerCount, regions: exportedRegionCount },
    unsupportedSemantics: issues,
    ...(editorialProfileExport ? {
      editorialProfile: {
        format: editorialProfileExport.profile.format,
        version: editorialProfileExport.profile.version,
        semanticSha256: editorialProfileExport.profile.semanticSha256,
        targetScopedLosses: editorialProfileExport.profile.losses.length,
        ...(editorialProfileExport.profileV3 ? {
          extension: {
            format: editorialProfileExport.profileV3.format,
            version: editorialProfileExport.profileV3.version,
            semanticSha256: editorialProfileExport.profileV3.semanticSha256,
            origins: editorialProfileExport.profileV3.audioOrigins.length,
            views: editorialProfileExport.profileV3.audioOrigins.reduce(
              (total, origin) => total + origin.views.length,
              0,
            ),
            lineageSegments:
              editorialProfileExport.profileV3.audioOrigins.reduce(
                (total, origin) =>
                  total + origin.lineageSegments.length,
                0,
              ),
            targetScopedLosses: editorialProfileExport.profileV3.losses.length,
          },
        } : {}),
        ...(editorialProfileExport.profileV4 ? {
          nestedExtension: {
            format: editorialProfileExport.profileV4.format,
            version: editorialProfileExport.profileV4.version,
            semanticSha256: editorialProfileExport.profileV4.semanticSha256,
            lineageSegments:
              editorialProfileExport.profileV4.lineageSegments.length,
            placements: editorialProfileExport.profileV4.placements.length,
          },
        } : {}),
        ...(editorialProfileExport.profileV5 ? {
          directMediaExtension: {
            format: editorialProfileExport.profileV5.format,
            version: editorialProfileExport.profileV5.version,
            semanticSha256:
              editorialProfileExport.profileV5.semanticSha256,
            authorities:
              editorialProfileExport.profileV5.authorities.length,
          },
        } : {}),
        ...(editorialProfileExport.profileV6 ? {
          pictureTimeMapExtension: {
            format: editorialProfileExport.profileV6.format,
            version: editorialProfileExport.profileV6.version,
            semanticSha256:
              editorialProfileExport.profileV6.semanticSha256,
            authorities:
              editorialProfileExport.profileV6.authorities.length,
          },
        } : {}),
      },
    } : {}),
  };

  const timeline: OtioTimeline = {
    OTIO_SCHEMA: "Timeline.1",
    name: composition.name,
    metadata: {
      cut: {
        project: ir.project,
        build_id: ir.buildId,
        composition_id: composition.id,
        canvas: { width: composition.width, height: composition.height },
        sample_rate: composition.sampleRate,
        exact_fps: exactMetadata(composition.fps),
        exact_duration: exactMetadata(composition.duration),
        exact_scenes: composition.sceneIds.map((sceneId) => {
          const scene = ir.scenes[sceneId];
          return scene
            ? {
                id: scene.id,
                name: scene.name,
                start: exactMetadata(scene.start),
                duration: exactMetadata(scene.duration),
              }
            : { id: sceneId, missing: true };
        }),
        ...(editorialProfileExport ? {
          editorial_profile: editorialProfileExport.profile,
          ...(editorialProfileExport.profileV3
            ? { editorial_profile_extension: editorialProfileExport.profileV3 }
            : {}),
          ...(editorialProfileExport.profileV4
            ? {
                editorial_profile_nested_extension:
                  editorialProfileExport.profileV4,
              }
            : {}),
          ...(editorialProfileExport.profileV5
            ? {
                editorial_profile_direct_media_extension:
                  editorialProfileExport.profileV5,
              }
            : {}),
          ...(editorialProfileExport.profileV6
            ? {
                editorial_profile_picture_time_map_extension:
                  editorialProfileExport.profileV6,
              }
            : {}),
          editorial_link_names: editorialProfileExport.linkNames,
        } : {}),
        interchange_report: report,
      },
    },
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      metadata: {
        cut: {
          ordering: "CUT authored descendant order; layer_index is zero-based",
        },
      },
      source_range: null,
      effects: [],
      markers: exportedAnnotations,
      enabled: true,
      children: tracks,
    },
  };
  return { timeline, report };
}

/**
 * The production OTIO adapter for the common CUT editorial-interchange
 * boundary. It receives the same canonical CutAVIR v3 meaning as every future
 * interchange target; target-specific loss remains explicit in its report.
 */
export const cutOtioInterchangeBackend = defineCutInterchangeExportBackend({
  descriptor: cutOtioInterchangeBackendDescriptor,
  exportEditorial(source, options: Readonly<CutOtioExportOptions>) {
    const exported = exportCutTimelineToOtioAdapter(source.ir as CutAVIR, {
      ...options,
      ...(source.selection.composition === null
        ? {}
        : { compositionId: source.selection.composition }),
    });
    return Object.freeze({
      artifact: exported.timeline,
      report: exported.report,
    });
  },
});

const builtInCutInterchangeBackends = new CutInterchangeBackendRegistry()
  .register(cutOtioInterchangeBackend);

/**
 * Export the editorial subset of one CutAVIR composition through CUT's
 * registered interchange-backend dispatcher.
 *
 * The legacy public return shape remains stable while registration, isolated
 * semantic input, backend/report identity validation and mutation refusal are
 * now exercised by the production CLI path.
 */
export function exportCutTimelineToOtio(ir: CutAVIR, options: CutOtioExportOptions = {}): CutOtioExport {
  const exported = dispatchCutInterchangeExport<
    CutOtioExportOptions,
    OtioTimeline,
    CutOtioInterchangeReport,
    "cut.otio-json"
  >(builtInCutInterchangeBackends, cutOtioInterchangeBackendDescriptor.id, {
    ir,
    ...(options.compositionId === undefined ? {} : { composition: options.compositionId }),
    options,
  });
  return {
    timeline: exported.artifact,
    report: exported.report,
  };
}
