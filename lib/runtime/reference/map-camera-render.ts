import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { geoGraticule10, geoInterpolate, geoPath, type GeoPermissibleObjects } from "d3-geo";
import sharp, { type OutputInfo } from "sharp";
import { feature } from "topojson-client";
import { hash, stableJsonStringify } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import { addRational, compareRational, rational, rationalToNumber, type Rational } from "../../language/rational";
import {
  referenceMapCameraAlgorithmVersion,
  referenceMapCameraAtlasIdentity,
  referenceMapCameraFinalSpaceRasterAlgorithmVersion,
  referenceMapCameraLimits,
  referenceMapCameraPlanAt,
  referenceMapCameraRetainedStyleDefaults,
  referenceMapCameraRouteSubjectAlgorithmVersion,
  referenceMapCameraStateAt,
  referenceMapCameraValidationTimes,
  validateReferenceMapCameraGraph,
  type ReferenceMapCameraAtlasDetail,
  type ReferenceMapCameraChildConfig,
  type ReferenceMapCameraChildKind,
  type ReferenceMapCameraConfig,
  type ReferenceMapCameraState,
} from "./map-camera";
import {
  ReferenceGeoProjectionError,
  referenceGeoMapCameraProjection,
  referenceGeoMapCameraMaximumProjectedStreamPointEvents,
  referenceGeoMapCameraProjectionAlgorithm,
  type ReferenceGeoMapCameraProjection,
} from "./geo-projection";
import { ReferenceMapCameraProjectivePitchError } from "./map-camera-projective-pitch";
import { evaluateSignal, propertyAt } from "./signals";

export const referenceMapCameraRenderAlgorithmVersion = referenceMapCameraFinalSpaceRasterAlgorithmVersion;
export const referenceMapCameraRenderEvidenceFormat = "cut-reference-map-camera-rendered-frame-evidence" as const;
export const referenceMapCameraCanonicalRasterCacheAlgorithmVersion =
  "cut-reference-map-camera-canonical-raster-cache-v1" as const;

export const referenceMapCameraRenderLimits = Object.freeze({
  maximumRasterAxis: 16_384,
  maximumRasterPixels: 67_108_864,
  maximumRasterRgbaBytes: 268_435_456,
  maximumAtlasBytes: 4_194_304,
  maximumCanonicalDrawingStreamBytes: 33_554_432,
  maximumCanonicalFragmentBytes: 16_777_216,
  maximumSignalConsumers: 256,
  maximumSignalEntries: 1_024,
  maximumSignalInfluenceComparisons: 250_000,
  maximumProjectedStreamPointEvents: referenceGeoMapCameraMaximumProjectedStreamPointEvents,
  maximumPitchPreimageExpansion: 8,
  maximumCanonicalRasterCacheBytes: 134_217_728,
  maximumCanonicalRasterCacheEntries: 64,
});

export type ReferenceMapCameraCanonicalRasterCacheOutcome =
  | "disabled"
  | "hit"
  | "miss"
  | "bypass";

export type ReferenceMapCameraCanonicalRasterCacheEvidence = Readonly<{
  algorithmVersion: typeof referenceMapCameraCanonicalRasterCacheAlgorithmVersion;
  scope: "renderer-invocation-memory";
  outcome: ReferenceMapCameraCanonicalRasterCacheOutcome;
  key: string;
  entryBytes: number;
  residentBytes: number;
  entries: number;
  evictions: number;
  byteLimit: number;
  entryLimit: number;
}>;

export type ReferenceMapCameraRenderErrorCode =
  | "CUT_MAP_CAMERA_RENDER_GRAPH"
  | "CUT_MAP_CAMERA_RENDER_RESOURCE"
  | "CUT_MAP_CAMERA_RENDER_STYLE"
  | "CUT_MAP_CAMERA_RENDER_SIGNAL"
  | "CUT_MAP_CAMERA_RENDER_NOOP"
  | "CUT_MAP_CAMERA_RENDER_LIMIT"
  | "CUT_MAP_CAMERA_RENDER_STREAM"
  | "CUT_MAP_CAMERA_RENDER_RASTER"
  | "CUT_MAP_CAMERA_RENDER_ALPHA"
  | "CUT_MAP_CAMERA_RENDER_UNSUPPORTED";

export class ReferenceMapCameraRenderError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceMapCameraRenderErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: MapCamera execution at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceMapCameraRenderError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceMapCameraAtlasEvidence = Readonly<{
  detail: ReferenceMapCameraAtlasDetail;
  bytes: number;
  arcs: number;
  coordinateRecords: number;
  sha256: string;
  licenseSha256: string;
  packages: Readonly<{
    worldAtlas: string;
    topojsonClient: string;
    d3Geo: string;
  }>;
}>;

export type ReferenceMapCameraChildExecutionEvidence = Readonly<{
  nodeId: string;
  kind: Exclude<ReferenceMapCameraChildKind, "annotation">;
  sourceOrder: number;
  status: "drawn" | "clipped-empty";
  fragmentBytes: number;
  fragmentDigest: string;
  screenSpace: Readonly<{
    strokeWidths: readonly number[];
    radii: readonly number[];
    cameraScaleAppliedToStyle: false;
  }>;
  routeSubject?: Readonly<{
    algorithmVersion: typeof referenceMapCameraRouteSubjectAlgorithmVersion;
    distanceAlgorithm: "d3-geo@3.1.1.geoDistance";
    metric: "cumulative-spherical-great-circle-angular-distance";
    interpolation: "d3-geo-geoInterpolate";
    segments: number;
    exactFrameSamples: number;
    segmentFrameEvaluations: number;
    segmentFrameEvaluationLimit: typeof referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations;
    progress: number;
    segmentIndex: number;
    segmentProgress: number;
    totalAngularDistanceRadians: number;
    geographicPoint: Readonly<{ latitude: number; longitude: number }>;
    projectedCenter: readonly [number, number] | null;
  }>;
}>;

export type ReferenceMapCameraRenderedFrameEvidence = Readonly<{
  format: typeof referenceMapCameraRenderEvidenceFormat;
  version: 5;
  evidenceKind: "completed-isolated-frame-execution" | "completed-public-retained-geo-pass";
  publicRuntimeStatus: "not-connected" | "connected-reference-visual-renderer";
  cacheStatus:
    | "identity-only-no-cache-read-write-or-locality-evidence"
    | "renderer-invocation-canonical-raster-cache-no-persistent-cache";
  algorithmVersion: typeof referenceMapCameraRenderAlgorithmVersion;
  cameraAlgorithmVersion: typeof referenceMapCameraAlgorithmVersion;
  projectionAlgorithm: typeof referenceGeoMapCameraProjectionAlgorithm;
  compositionId: string;
  cameraId: string;
  exactTime: Rational;
  state: ReferenceMapCameraState;
  atlas: readonly ReferenceMapCameraAtlasEvidence[];
  children: readonly ReferenceMapCameraChildExecutionEvidence[];
  projectivePitch: Readonly<{
    model: "bounded-flat-plane-projective";
    applied: boolean;
    transformOrder: "bearing-then-pitch";
    focalDistance: number;
    preimage: Readonly<{
      left: number;
      top: number;
      right: number;
      bottom: number;
      expansionX: number;
      expansionY: number;
      maximumExpansion: number;
      limit: 8;
    }>;
    forwardDenominator: Readonly<{ minimum: number; finite: true; positive: true }>;
    inverseDenominator: Readonly<{ minimum: number; finite: true; positive: true }>;
    projectedStreamPointEvents: number;
    projectedStreamPointEventLimit: 2_097_152;
  }>;
  execution: Readonly<{
    retainedGeometry: "executed-in-final-delivery-space";
    raster: "executed-once-at-delivery-resolution" | "reused-canonical-renderer-invocation-raster";
    resize: "not-executed";
    resample: "not-executed";
    planCacheIdentity: string;
    deferredAnnotationIds: readonly string[];
  }>;
  canonicalDrawingStream: Readonly<{
    format: "canonical-final-space-svg";
    numericDigits: 6;
    clip: Readonly<{ left: 0; top: 0; right: number; bottom: number; halfOpen: true }>;
    bytes: number;
    sha256: string;
  }>;
  canonicalRasterCache: ReferenceMapCameraCanonicalRasterCacheEvidence;
  surface: Readonly<{
    width: number;
    height: number;
    channels: 4;
    alphaMode: "straight";
    colorSpace: "encoded-srgb";
    rgbaBytes: number;
    sha256: string;
    data: Buffer;
  }>;
  backend: Readonly<{
    sharp: string;
    rsvg: string;
    vips: string;
    sharpStackIdentity: string;
    node: string;
    v8: string;
    platform: NodeJS.Platform;
    arch: string;
    worldAtlas: string;
    topojsonClient: string;
    d3Geo: string;
  }>;
  counters: Readonly<{
    measurement: "instrumented-isolated-executor";
    atlasByteVerifications: number;
    dependencyIdentityVerifications: 0 | 1;
    projectedChildren: number;
    drawnChildren: number;
    clippedEmptyChildren: number;
    canonicalStreamSerializations: 1;
    rasterizations: 0 | 1;
    resizePasses: 0;
    resamplePasses: 0;
    alphaCanonicalizationPasses: 0 | 1;
    clearedTransparentRgbPixels: number;
    preProjectiveClipConfigurations: 0 | 1;
    postProjectiveClipConfigurations: 1;
    projectivePitchPointEvents: number;
    routeSubjectSegments: number;
    routeSubjectSegmentFrameEvaluations: number;
    routeSubjectSegmentFrameEvaluationLimit: typeof referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations;
  }>;
  semanticIdentity: string;
  cacheIdentity: string;
  executionIdentity: string;
}>;

export type ReferenceMapCameraRenderContext = Readonly<{
  annotationMode: "reject" | "defer-local-space";
  evidenceKind: ReferenceMapCameraRenderedFrameEvidence["evidenceKind"];
  publicRuntimeStatus: ReferenceMapCameraRenderedFrameEvidence["publicRuntimeStatus"];
  cacheStatus: ReferenceMapCameraRenderedFrameEvidence["cacheStatus"];
  preparation?: ReferenceMapCameraRenderPreparation;
  canonicalRasterCache?: ReferenceMapCameraCanonicalRasterCache;
}>;

/**
 * One renderer-invocation validation receipt. It is deliberately not a
 * persistent pixel cache: frame projection and drawing-stream serialization
 * still execute for every requested frame. Identity-matched canonical rasters
 * may reuse renderer-invocation memory, while a miss or bypass executes
 * rasterization and alpha canonicalization. The receipt proves that immutable
 * graph/signal validation and exact dependency/atlas input binding happened
 * once before frame iteration instead of repeating the same package reads,
 * topology decode, and whole-timeline proof for every output frame.
 */
export type ReferenceMapCameraRenderPreparation = Readonly<{
  format: "cut-reference-map-camera-render-preparation";
  version: 1;
  algorithmVersion: typeof referenceMapCameraRenderAlgorithmVersion;
  compositionId: string;
  cameras: readonly Readonly<{
    nodeId: string;
    semanticIdentity: string;
    exactFrameSamples: number;
  }>[];
  verifiedInputs: Readonly<{
    scope: "renderer-invocation-only";
    backendIdentity: string;
    atlases: readonly ReferenceMapCameraAtlasEvidence[];
    dependencyIdentityVerifications: 1 | 0;
    atlasByteVerifications: number;
    persistentCacheReads: 0;
    persistentCacheWrites: 0;
  }>;
  validation: "whole-graph-and-signal-influence-once-before-frame-raster";
  semanticIdentity: string;
}>;

type TrustedReferenceMapCameraRenderPreparation = Readonly<{
  ir: CutAVIR;
  composition: IRComposition;
  configs: ReadonlyMap<string, ReferenceMapCameraConfig>;
  frameTimeKeys: ReadonlyMap<string, ReadonlySet<string>>;
  backend?: ReturnType<typeof dependencyEvidence>;
  atlasByCamera: ReadonlyMap<string, ReadonlyMap<string, VerifiedAtlas>>;
}>;

const trustedReferenceMapCameraRenderPreparations =
  new WeakMap<ReferenceMapCameraRenderPreparation, TrustedReferenceMapCameraRenderPreparation>();

export type ReferenceMapCameraPublishedFrameEvidence = Omit<ReferenceMapCameraRenderedFrameEvidence, "surface"> & Readonly<{
  surface: Omit<ReferenceMapCameraRenderedFrameEvidence["surface"], "data">;
}>;

type ReferenceMapCameraSemanticFrameEvidence = Pick<
  ReferenceMapCameraRenderedFrameEvidence,
  | "version"
  | "algorithmVersion"
  | "atlas"
  | "backend"
  | "cameraAlgorithmVersion"
  | "cacheStatus"
  | "canonicalDrawingStream"
  | "canonicalRasterCache"
  | "children"
  | "counters"
  | "execution"
> & Readonly<{
  surface: Pick<
    ReferenceMapCameraRenderedFrameEvidence["surface"],
    "width" | "height" | "rgbaBytes"
  >;
}>;

/**
 * Correlate current-v5 RouteSubject work evidence. The JSON schema closes
 * shape and scalar bounds; this verifier owns multiplication and aggregation.
 */
export function validateReferenceMapCameraFrameEvidenceSemantics<T extends ReferenceMapCameraSemanticFrameEvidence>(
  evidence: T,
): T {
  if (evidence.version !== 5
    || evidence.algorithmVersion !== referenceMapCameraRenderAlgorithmVersion
    || evidence.cameraAlgorithmVersion !== referenceMapCameraAlgorithmVersion) {
    throw new Error("CUT_MAP_CAMERA_FRAME_EVIDENCE: semantic validation accepts only the current v5 retained receipt.");
  }
  let segments = 0;
  let evaluations = 0;
  for (const child of evidence.children) {
    const subject = child.routeSubject;
    if (child.kind !== "route-subject") {
      if (subject !== undefined) {
        throw new Error("CUT_MAP_CAMERA_FRAME_EVIDENCE: only a route-subject child may carry RouteSubject work evidence.");
      }
      continue;
    }
    if (!subject) {
      throw new Error("CUT_MAP_CAMERA_FRAME_EVIDENCE: every route-subject child must carry RouteSubject work evidence.");
    }
    const expected = subject.segments * subject.exactFrameSamples;
    if (!Number.isSafeInteger(subject.segments)
      || subject.segments < 1
      || subject.segments > referenceMapCameraLimits.maximumRoutePointsPerRoute - 1
      || !Number.isSafeInteger(subject.exactFrameSamples)
      || subject.exactFrameSamples < 1
      || subject.exactFrameSamples > referenceMapCameraLimits.maximumValidationSamplesPerComposition
      || !Number.isSafeInteger(expected)
      || subject.segmentFrameEvaluations !== expected
      || subject.segmentFrameEvaluationLimit !== referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations
      || subject.segmentFrameEvaluations > subject.segmentFrameEvaluationLimit
      || subject.segmentIndex < 0
      || subject.segmentIndex >= subject.segments) {
      throw new Error("CUT_MAP_CAMERA_FRAME_EVIDENCE: RouteSubject segment, sample, evaluation, limit, and selected-index evidence does not correlate.");
    }
    segments += subject.segments;
    evaluations += subject.segmentFrameEvaluations;
  }
  if (!Number.isSafeInteger(segments)
    || !Number.isSafeInteger(evaluations)
    || evidence.counters.routeSubjectSegments !== segments
    || evidence.counters.routeSubjectSegmentFrameEvaluations !== evaluations
    || evidence.counters.routeSubjectSegmentFrameEvaluationLimit
      !== referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations) {
    throw new Error("CUT_MAP_CAMERA_FRAME_EVIDENCE: aggregate RouteSubject work counters do not correlate with child receipts.");
  }
  const cache = evidence.canonicalRasterCache;
  const rgbaBytes = evidence.surface.width * evidence.surface.height * 4;
  const expectedCacheKey = referenceMapCameraCanonicalRasterCacheIdentity({
    canonicalDrawingStreamSha256: evidence.canonicalDrawingStream.sha256,
    canonicalDrawingStreamBytes: evidence.canonicalDrawingStream.bytes,
    width: evidence.surface.width,
    height: evidence.surface.height,
    backend: evidence.backend,
    atlas: evidence.atlas,
  });
  const connected = evidence.cacheStatus === "renderer-invocation-canonical-raster-cache-no-persistent-cache";
  if (cache.algorithmVersion !== referenceMapCameraCanonicalRasterCacheAlgorithmVersion
    || cache.scope !== "renderer-invocation-memory"
    || !/^[a-f0-9]{64}$/u.test(cache.key)
    || cache.key !== expectedCacheKey
    || !Number.isSafeInteger(rgbaBytes)
    || evidence.surface.rgbaBytes !== rgbaBytes
    || cache.entryBytes !== rgbaBytes
    || !Number.isSafeInteger(cache.residentBytes)
    || cache.residentBytes < 0
    || !Number.isSafeInteger(cache.entries)
    || cache.entries < 0
    || !Number.isSafeInteger(cache.evictions)
    || cache.evictions < 0
    || !Number.isSafeInteger(cache.byteLimit)
    || cache.byteLimit < 0
    || !Number.isSafeInteger(cache.entryLimit)
    || cache.entryLimit < 0
    || cache.residentBytes > cache.byteLimit
    || cache.entries > cache.entryLimit
    || (connected && cache.outcome === "disabled")
    || (!connected && cache.outcome !== "disabled")
    || (cache.outcome === "disabled"
      && (cache.residentBytes !== 0 || cache.entries !== 0 || cache.evictions !== 0
        || cache.byteLimit !== 0 || cache.entryLimit !== 0))
    || ((cache.outcome === "hit" || cache.outcome === "miss")
      && (cache.entryBytes > cache.byteLimit || cache.entries < 1 || cache.residentBytes < cache.entryBytes))) {
    throw new Error("CUT_MAP_CAMERA_FRAME_EVIDENCE: canonical-raster cache identity, bounds, scope, and terminal outcome do not correlate.");
  }
  const cacheHit = cache.outcome === "hit";
  const expectedRasterPasses = cacheHit ? 0 : 1;
  if (evidence.counters.rasterizations !== expectedRasterPasses
    || evidence.counters.alphaCanonicalizationPasses !== expectedRasterPasses
    || evidence.execution.raster !== (cacheHit
      ? "reused-canonical-renderer-invocation-raster"
      : "executed-once-at-delivery-resolution")) {
    throw new Error("CUT_MAP_CAMERA_FRAME_EVIDENCE: canonical-raster cache outcome does not correlate with raster, alpha, and execution evidence.");
  }
  return evidence;
}

export type ReferenceMapCameraPublicFrameEvidence = Readonly<{
  format: "cut-reference-map-camera-public-frame-evidence";
  version: 5;
  evidenceKind: "completed-public-frame-execution";
  publicRuntimeStatus: "connected-reference-visual-renderer";
  cacheStatus: "renderer-invocation-canonical-raster-cache-no-persistent-cache";
  compositionId: string;
  cameraId: string;
  exactTime: Rational;
  retainedGeoPass: ReferenceMapCameraPublishedFrameEvidence;
  annotations: Readonly<{
    active: number;
    accepted: number;
    painted: number;
    opacityQuantizedTransparent: number;
    localSpaceNodeIds: readonly string[];
    subgraphSemanticIdentity?: string;
    decisionIdentity?: string;
    executionIdentity?: string;
  }>;
  finalSurface: Readonly<{
    width: number;
    height: number;
    channels: 4;
    alphaMode: "straight";
    colorSpace: "encoded-srgb";
    rgbaBytes: number;
    sha256: string;
  }>;
  counters: Readonly<{
    retainedRasterizations: 0 | 1;
    invocationCanonicalRasterCacheHits: 0 | 1;
    invocationCanonicalRasterCacheMisses: 0 | 1;
    invocationCanonicalRasterCacheBypasses: 0 | 1;
    annotationOverlayComposites: number;
    persistentCacheReads: 0;
    persistentCacheWrites: 0;
    rendererFrameMemoPublication: 1;
  }>;
  semanticIdentity: string;
  cacheIdentity: string;
  executionIdentity: string;
}>;

/** Remove live RGBA bytes before evidence enters JSON manifests while keeping
 * their exact byte count and SHA-256 binding. */
export function referenceMapCameraPublishedFrameEvidence(
  evidence: ReferenceMapCameraRenderedFrameEvidence,
): ReferenceMapCameraPublishedFrameEvidence {
  validateReferenceMapCameraFrameEvidenceSemantics(evidence);
  const surface = {
    width: evidence.surface.width,
    height: evidence.surface.height,
    channels: evidence.surface.channels,
    alphaMode: evidence.surface.alphaMode,
    colorSpace: evidence.surface.colorSpace,
    rgbaBytes: evidence.surface.rgbaBytes,
    sha256: evidence.surface.sha256,
  };
  return Object.freeze({ ...evidence, surface: Object.freeze(surface) });
}

/** Bind the retained geographic pass, optional delivery-space annotation
 * decisions, and the actual post-annotation RGBA surface into one public
 * same-invocation receipt. This reports identity and frame memo honestly; no
 * persistent cache read/write is implied. */
export function referenceMapCameraPublicFrameEvidence(input: Readonly<{
  retained: ReferenceMapCameraRenderedFrameEvidence;
  annotations?: Readonly<{
    active: number;
    accepted: number;
    localSpaceNodeIds: readonly string[];
    subgraphSemanticIdentity: string;
    decisionIdentity: string;
    executionIdentity: string;
    painted: number;
    opacityQuantizedTransparent: number;
  }>;
  finalSurface: Readonly<{ data: Buffer; width: number; height: number }>;
}>): ReferenceMapCameraPublicFrameEvidence {
  const { retained, annotations: authored } = input;
  validateReferenceMapCameraFrameEvidenceSemantics(retained);
  if (retained.publicRuntimeStatus !== "connected-reference-visual-renderer"
    || retained.cacheStatus !== "renderer-invocation-canonical-raster-cache-no-persistent-cache"
    || retained.evidenceKind !== "completed-public-retained-geo-pass") {
    throw new Error("CUT_MAP_CAMERA_RENDER_GRAPH: public frame evidence requires a connected retained geo-pass receipt.");
  }
  const expectedBytes = input.finalSurface.width * input.finalSurface.height * 4;
  if (input.finalSurface.width !== retained.surface.width || input.finalSurface.height !== retained.surface.height
    || !Number.isSafeInteger(expectedBytes) || input.finalSurface.data.byteLength !== expectedBytes) {
    throw new Error("CUT_MAP_CAMERA_RENDER_GRAPH: public post-annotation surface does not match the retained delivery raster shape.");
  }
  const annotations = Object.freeze(authored ? {
    active: authored.active,
    accepted: authored.accepted,
    painted: authored.painted,
    opacityQuantizedTransparent: authored.opacityQuantizedTransparent,
    localSpaceNodeIds: Object.freeze([...authored.localSpaceNodeIds]),
    subgraphSemanticIdentity: authored.subgraphSemanticIdentity,
    decisionIdentity: authored.decisionIdentity,
    executionIdentity: authored.executionIdentity,
  } : {
    active: 0,
    accepted: 0,
    painted: 0,
    opacityQuantizedTransparent: 0,
    localSpaceNodeIds: Object.freeze([] as string[]),
  });
  if (![annotations.active, annotations.accepted, annotations.painted, annotations.opacityQuantizedTransparent]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    || annotations.accepted > annotations.active
    || annotations.painted + annotations.opacityQuantizedTransparent !== annotations.accepted) {
    throw new Error("CUT_MAP_CAMERA_RENDER_GRAPH: annotation painted and quantized-transparent counts must partition accepted decisions.");
  }
  const finalSurface = Object.freeze({
    width: input.finalSurface.width,
    height: input.finalSurface.height,
    channels: 4 as const,
    alphaMode: "straight" as const,
    colorSpace: "encoded-srgb" as const,
    rgbaBytes: expectedBytes,
    sha256: sha256(input.finalSurface.data),
  });
  const semanticIdentity = hash({
    retained: retained.semanticIdentity,
    annotationSubgraphSemanticIdentity: authored?.subgraphSemanticIdentity,
    annotationDecisionIdentity: authored?.decisionIdentity,
    annotationExecutionIdentity: authored?.executionIdentity,
    paintedAnnotations: annotations.painted,
    opacityQuantizedTransparentAnnotations: annotations.opacityQuantizedTransparent,
    localSpaceNodeIds: annotations.localSpaceNodeIds,
  });
  const cacheIdentity = hash({
    retained: retained.cacheIdentity,
    semanticIdentity,
    cacheStatus: "renderer-invocation-canonical-raster-cache-no-persistent-cache",
  });
  const cacheOutcome = retained.canonicalRasterCache.outcome;
  const receipt = Object.freeze({
    format: "cut-reference-map-camera-public-frame-evidence" as const,
    version: 5 as const,
    evidenceKind: "completed-public-frame-execution" as const,
    publicRuntimeStatus: "connected-reference-visual-renderer" as const,
    cacheStatus: "renderer-invocation-canonical-raster-cache-no-persistent-cache" as const,
    compositionId: retained.compositionId,
    cameraId: retained.cameraId,
    exactTime: Object.freeze({ ...retained.exactTime }),
    retainedGeoPass: referenceMapCameraPublishedFrameEvidence(retained),
    annotations,
    finalSurface,
    counters: Object.freeze({
      retainedRasterizations: retained.counters.rasterizations,
      invocationCanonicalRasterCacheHits: (cacheOutcome === "hit" ? 1 : 0) as 0 | 1,
      invocationCanonicalRasterCacheMisses: (cacheOutcome === "miss" ? 1 : 0) as 0 | 1,
      invocationCanonicalRasterCacheBypasses: (cacheOutcome === "bypass" ? 1 : 0) as 0 | 1,
      annotationOverlayComposites: annotations.painted,
      persistentCacheReads: 0 as const,
      persistentCacheWrites: 0 as const,
      rendererFrameMemoPublication: 1 as const,
    }),
    semanticIdentity,
    cacheIdentity,
  });
  return Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
}

const isolatedRenderContext: ReferenceMapCameraRenderContext = Object.freeze({
  annotationMode: "reject",
  evidenceKind: "completed-isolated-frame-execution",
  publicRuntimeStatus: "not-connected",
  cacheStatus: "identity-only-no-cache-read-write-or-locality-evidence",
});

type AtlasTopology = {
  type: "Topology";
  objects: { countries: object };
  arcs: unknown[][];
};

type VerifiedAtlas = Readonly<{
  evidence: ReferenceMapCameraAtlasEvidence;
  world: GeoPermissibleObjects;
}>;

type RenderFragment = Readonly<{
  child: ReferenceMapCameraChildConfig;
  svg: string;
  screenStrokeWidths: readonly number[];
  screenRadii: readonly number[];
  clippedEmpty: boolean;
  routeSubject?: NonNullable<ReferenceMapCameraChildExecutionEvidence["routeSubject"]>;
}>;

type SignalConsumer = Readonly<{
  node: IRNode;
  property: string;
  signalId: string;
  times: readonly Rational[];
}>;

const mapDefaults = referenceMapCameraRetainedStyleDefaults.map;
const routeDefaults = referenceMapCameraRetainedStyleDefaults.route;
const routeSubjectDefaults = referenceMapCameraRetainedStyleDefaults.routeSubject;
const markerDefaults = referenceMapCameraRetainedStyleDefaults.marker;
const wavefrontDefaults = referenceMapCameraRetainedStyleDefaults.wavefront;
const connectionsDefaults = Object.freeze({ color: "#22d3ee", count: 24, width: 2.5 });
const lowerColor = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u;
const lockedRasterBackend = Object.freeze({ sharp: "0.35.3", rsvg: "2.62.90", vips: "8.18.3" });

function fail(node: IRNode, code: ReferenceMapCameraRenderErrorCode, detail: string): never {
  throw new ReferenceMapCameraRenderError(code, node, detail);
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function packageVersion(path: string) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : undefined;
}

function dependencyEvidence(node: IRNode) {
  let worldAtlas: string | undefined, topojsonClient: string | undefined, d3Geo: string | undefined;
  try {
    worldAtlas = packageVersion(require.resolve("world-atlas/package.json"));
    topojsonClient = packageVersion(require.resolve("topojson-client/package.json"));
    const d3Entry = require.resolve("d3-geo");
    d3Geo = packageVersion(resolve(dirname(d3Entry), "..", "package.json"));
  } catch (error) {
    fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `geographic dependency manifests cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (`world-atlas@${worldAtlas}` !== referenceMapCameraAtlasIdentity.worldAtlas
    || `topojson-client@${topojsonClient}` !== referenceMapCameraAtlasIdentity.topojsonClient
    || `d3-geo@${d3Geo}` !== referenceMapCameraAtlasIdentity.d3Geo) {
    fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `installed geographic dependency identity is world-atlas@${worldAtlas}, topojson-client@${topojsonClient}, d3-geo@${d3Geo}; the locked plan requires ${referenceMapCameraAtlasIdentity.worldAtlas}, ${referenceMapCameraAtlasIdentity.topojsonClient}, ${referenceMapCameraAtlasIdentity.d3Geo}.`);
  }
  if (sharp.versions.sharp !== lockedRasterBackend.sharp
    || sharp.versions.rsvg !== lockedRasterBackend.rsvg
    || sharp.versions.vips !== lockedRasterBackend.vips) {
    fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `Sharp/librsvg backend identity ${sharp.versions.sharp}/${sharp.versions.rsvg}/${sharp.versions.vips} differs from the isolated v1 lock ${lockedRasterBackend.sharp}/${lockedRasterBackend.rsvg}/${lockedRasterBackend.vips}.`);
  }
  return Object.freeze({
    worldAtlas: referenceMapCameraAtlasIdentity.worldAtlas,
    topojsonClient: referenceMapCameraAtlasIdentity.topojsonClient,
    d3Geo: referenceMapCameraAtlasIdentity.d3Geo,
    sharp: sharp.versions.sharp,
    rsvg: sharp.versions.rsvg,
    vips: sharp.versions.vips,
    sharpStackIdentity: hash(Object.fromEntries(Object.entries(sharp.versions).sort(([left], [right]) => left.localeCompare(right)))),
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
  });
}

type ReferenceMapCameraCanonicalRaster = Readonly<{
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
  clearedTransparentRgbPixels: number;
  visiblePixels: number;
}>;

type ReferenceMapCameraCanonicalRasterCacheEntry = {
  pending: Promise<ReferenceMapCameraCanonicalRaster>;
  width: number;
  height: number;
  bytes: number;
  settled: boolean;
  generation: number;
};

export type ReferenceMapCameraCanonicalRasterCacheIdentityInput = Readonly<{
  canonicalDrawingStreamSha256: string;
  canonicalDrawingStreamBytes: number;
  width: number;
  height: number;
  backend: ReferenceMapCameraRenderedFrameEvidence["backend"];
  atlas: readonly ReferenceMapCameraAtlasEvidence[];
}>;

/**
 * Exact identity for one immutable canonicalized final-space raster. Exact
 * frame time is deliberately absent: the canonical SVG already closes every
 * sampled camera/child value, while the completed frame receipt retains its
 * own current exact time and execution identity.
 */
export function referenceMapCameraCanonicalRasterCacheIdentity(
  input: ReferenceMapCameraCanonicalRasterCacheIdentityInput,
) {
  return hash({
    format: referenceMapCameraCanonicalRasterCacheAlgorithmVersion,
    finalSpaceRasterAlgorithm: referenceMapCameraRenderAlgorithmVersion,
    alphaCanonicalization: "clear-hidden-rgb-where-alpha-zero-v1",
    pixelFormat: "rgba8-straight-encoded-srgb",
    width: input.width,
    height: input.height,
    canonicalDrawingStreamSha256: input.canonicalDrawingStreamSha256,
    canonicalDrawingStreamBytes: input.canonicalDrawingStreamBytes,
    backend: input.backend,
    atlas: input.atlas,
  });
}

export type ReferenceMapCameraCanonicalRasterCacheRequestResult = Readonly<{
  raster: ReferenceMapCameraCanonicalRaster;
  evidence: ReferenceMapCameraCanonicalRasterCacheEvidence;
}>;

/**
 * Renderer-invocation-owned, byte- and entry-bounded LRU. Cached bytes are
 * private immutable copies; every lookup returns a fresh Buffer so evidence
 * consumers cannot mutate shared cache state. Pending bytes are reserved
 * before materialization, preventing concurrent requests from oversubscribing
 * the declared bound.
 */
export class ReferenceMapCameraCanonicalRasterCache {
  private readonly entries = new Map<string, ReferenceMapCameraCanonicalRasterCacheEntry>();
  private bytes = 0;
  private generation = 0;

  constructor(
    readonly maximumBytes: number = referenceMapCameraRenderLimits.maximumCanonicalRasterCacheBytes,
    readonly maximumEntries: number = referenceMapCameraRenderLimits.maximumCanonicalRasterCacheEntries,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4
      || maximumBytes > referenceMapCameraRenderLimits.maximumCanonicalRasterCacheBytes
      || !Number.isSafeInteger(maximumEntries) || maximumEntries < 1
      || maximumEntries > referenceMapCameraRenderLimits.maximumCanonicalRasterCacheEntries) {
      throw new Error(
        `CUT_MAP_CAMERA_RENDER_LIMIT: canonical-raster cache bounds must be 4..${referenceMapCameraRenderLimits.maximumCanonicalRasterCacheBytes} bytes and 1..${referenceMapCameraRenderLimits.maximumCanonicalRasterCacheEntries} entries.`,
      );
    }
  }

  get residentBytes() { return this.bytes; }
  get entryCount() { return this.entries.size; }

  private evictOldestSettled() {
    for (const [key, entry] of this.entries) {
      if (!entry.settled) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
      return true;
    }
    return false;
  }

  private evidence(
    outcome: Exclude<ReferenceMapCameraCanonicalRasterCacheOutcome, "disabled">,
    key: string,
    entryBytes: number,
    evictions: number,
  ): ReferenceMapCameraCanonicalRasterCacheEvidence {
    return Object.freeze({
      algorithmVersion: referenceMapCameraCanonicalRasterCacheAlgorithmVersion,
      scope: "renderer-invocation-memory" as const,
      outcome,
      key,
      entryBytes,
      residentBytes: this.bytes,
      entries: this.entries.size,
      evictions,
      byteLimit: this.maximumBytes,
      entryLimit: this.maximumEntries,
    });
  }

  async request(
    key: string,
    width: number,
    height: number,
    materialize: () => Promise<ReferenceMapCameraCanonicalRaster>,
  ): Promise<ReferenceMapCameraCanonicalRasterCacheRequestResult> {
    const entryBytes = width * height * 4;
    if (!/^[a-f0-9]{64}$/u.test(key)
      || !Number.isSafeInteger(width) || width < 1
      || !Number.isSafeInteger(height) || height < 1
      || !Number.isSafeInteger(entryBytes) || entryBytes < 4) {
      throw new Error("CUT_MAP_CAMERA_RENDER_LIMIT: canonical-raster cache request must bind one digest and positive bounded RGBA dimensions.");
    }
    const copy = (raster: ReferenceMapCameraCanonicalRaster): ReferenceMapCameraCanonicalRaster =>
      Object.freeze({ ...raster, data: Buffer.from(raster.data) });
    const validateAndCopy = (raster: ReferenceMapCameraCanonicalRaster) => {
      if (!Buffer.isBuffer(raster.data)
        || raster.width !== width || raster.height !== height
        || raster.data.byteLength !== entryBytes
        || raster.sha256 !== sha256(raster.data)
        || !Number.isSafeInteger(raster.clearedTransparentRgbPixels)
        || raster.clearedTransparentRgbPixels < 0
        || !Number.isSafeInteger(raster.visiblePixels)
        || raster.visiblePixels < 1
        || raster.visiblePixels > width * height) {
        throw new Error("CUT_MAP_CAMERA_RENDER_RASTER: canonical-raster cache materializer returned malformed or unauthenticated RGBA bytes.");
      }
      return copy(raster);
    };
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.width !== width || existing.height !== height || existing.bytes !== entryBytes) {
        throw new Error("CUT_MAP_CAMERA_RENDER_RASTER: canonical-raster cache digest was reused with conflicting RGBA dimensions.");
      }
      this.entries.delete(key);
      this.entries.set(key, existing);
      const raster = await existing.pending;
      const live = this.entries.get(key) === existing && existing.generation === this.generation;
      if (!live) {
        throw new Error("CUT_MAP_CAMERA_RENDER_RASTER: canonical-raster cache entry was invalidated before coalesced reuse completed.");
      }
      return Object.freeze({
        raster: copy(raster),
        evidence: this.evidence("hit", key, entryBytes, 0),
      });
    }
    if (entryBytes > this.maximumBytes) {
      const raster = validateAndCopy(await materialize());
      return Object.freeze({
        raster,
        evidence: this.evidence("bypass", key, entryBytes, 0),
      });
    }
    let evictions = 0;
    while ((this.entries.size >= this.maximumEntries || this.bytes + entryBytes > this.maximumBytes)
      && this.evictOldestSettled()) evictions += 1;
    if (this.entries.size >= this.maximumEntries || this.bytes + entryBytes > this.maximumBytes) {
      const raster = validateAndCopy(await materialize());
      return Object.freeze({
        raster,
        evidence: this.evidence("bypass", key, entryBytes, evictions),
      });
    }

    // The pending callback observes the exact entry published immediately
    // afterward; the delayed self-reference is intentional cache identity.
    let entry!: ReferenceMapCameraCanonicalRasterCacheEntry;
    const generation = this.generation;
    const pending = Promise.resolve().then(materialize).then(validateAndCopy).then((raster) => {
      const live = this.entries.get(key);
      if (live === entry && entry.generation === this.generation) live.settled = true;
      return raster;
    });
    entry = { pending, width, height, bytes: entryBytes, settled: false, generation };
    this.entries.set(key, entry);
    this.bytes += entryBytes;
    try {
      const raster = await pending;
      const admitted = this.entries.get(key) === entry;
      return Object.freeze({
        raster: copy(raster),
        evidence: this.evidence(admitted ? "miss" : "bypass", key, entryBytes, evictions),
      });
    } catch (error) {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
        this.bytes -= entryBytes;
      }
      throw error;
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.generation += 1;
  }
}

const atlasPaths: Readonly<Record<ReferenceMapCameraAtlasDetail, string>> = Object.freeze({
  "110m": require.resolve("world-atlas/countries-110m.json"),
  "50m": require.resolve("world-atlas/countries-50m.json"),
  "10m": require.resolve("world-atlas/countries-10m.json"),
});

function atlasPath(detail: ReferenceMapCameraAtlasDetail) { return atlasPaths[detail]; }

/** Verify exact package bytes before JSON decoding or topology allocation. */
export function referenceMapCameraVerifyAtlasBytes(
  node: IRNode,
  detail: ReferenceMapCameraAtlasDetail,
  bytes: Buffer,
  licenseBytes: Buffer,
): VerifiedAtlas {
  const expected = referenceMapCameraAtlasIdentity.details[detail];
  if (bytes.byteLength > referenceMapCameraRenderLimits.maximumAtlasBytes) {
    fail(node, "CUT_MAP_CAMERA_RENDER_LIMIT", `${detail} atlas contains ${bytes.byteLength} bytes; the pre-decode ceiling is ${referenceMapCameraRenderLimits.maximumAtlasBytes}.`);
  }
  const digest = sha256(bytes), licenseDigest = sha256(licenseBytes);
  if (bytes.byteLength !== expected.bytes || digest !== expected.sha256) {
    fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `${detail} atlas bytes/hash are ${bytes.byteLength}/${digest}; expected ${expected.bytes}/${expected.sha256}.`);
  }
  if (licenseDigest !== referenceMapCameraAtlasIdentity.licenseSha256) {
    fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `world-atlas license hash ${licenseDigest} differs from ${referenceMapCameraAtlasIdentity.licenseSha256}.`);
  }
  let topology: AtlasTopology;
  try { topology = JSON.parse(bytes.toString("utf8")) as AtlasTopology; }
  catch (error) { fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `${detail} atlas JSON cannot decode: ${error instanceof Error ? error.message : String(error)}`); }
  if (topology.type !== "Topology" || !topology.objects?.countries || !Array.isArray(topology.arcs)) {
    fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `${detail} atlas lacks the locked countries topology.`);
  }
  const coordinateRecords = topology.arcs.reduce((total, arc) => total + (Array.isArray(arc) ? arc.length : 0), 0);
  if (topology.arcs.length !== expected.arcs || coordinateRecords !== expected.coordinateRecords) {
    fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `${detail} topology work is ${topology.arcs.length} arcs/${coordinateRecords} coordinate records; expected ${expected.arcs}/${expected.coordinateRecords}.`);
  }
  let world: GeoPermissibleObjects;
  try { world = feature(topology as never, topology.objects.countries as never) as GeoPermissibleObjects; }
  catch (error) { fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `${detail} countries topology cannot convert: ${error instanceof Error ? error.message : String(error)}`); }
  return Object.freeze({
    evidence: Object.freeze({
      detail,
      bytes: bytes.byteLength,
      arcs: topology.arcs.length,
      coordinateRecords,
      sha256: digest,
      licenseSha256: licenseDigest,
      packages: Object.freeze({
        worldAtlas: referenceMapCameraAtlasIdentity.worldAtlas,
        topojsonClient: referenceMapCameraAtlasIdentity.topojsonClient,
        d3Geo: referenceMapCameraAtlasIdentity.d3Geo,
      }),
    }),
    world,
  });
}

function loadAtlas(node: IRNode, detail: ReferenceMapCameraAtlasDetail) {
  try {
    return referenceMapCameraVerifyAtlasBytes(
      node,
      detail,
      readFileSync(atlasPath(detail)),
      readFileSync(require.resolve("world-atlas/LICENSE")),
    );
  } catch (error) {
    if (error instanceof ReferenceMapCameraRenderError) throw error;
    fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", `${detail} atlas bytes cannot be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function quantity(node: IRNode, value: IRValue | undefined, label: string, dimension: string, fallback: number) {
  if (value === undefined) {
    if (!Number.isFinite(fallback)) fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", `${label} is required and must be finite.`);
    return fallback;
  }
  if (value.kind !== "quantity" || value.dimension !== dimension) fail(node, "CUT_MAP_CAMERA_RENDER_STYLE", `${label} must be a canonical ${dimension} quantity.`);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_MAP_CAMERA_RENDER_STYLE", `${label} must be finite.`);
  return Object.is(result, -0) ? 0 : result;
}

function color(node: IRNode, name: string, fallback: string) {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "color" || !lowerColor.test(value.value)) {
    fail(node, "CUT_MAP_CAMERA_RENDER_STYLE", `input “${name}” must use canonical lowercase #rrggbb or #rrggbbaa; uppercase is refused rather than silently normalized.`);
  }
  if (value.value === fallback) fail(node, "CUT_MAP_CAMERA_RENDER_NOOP", `input “${name}” repeats the isolated v1 default ${fallback}; omit it.`);
  return value.value;
}

function visibleColor(node: IRNode, name: string, fallback: string) {
  const result = color(node, name, fallback);
  if (alphaColor(result) === 0) {
    fail(node, "CUT_MAP_CAMERA_RENDER_NOOP", `input “${name}” resolves to a fully transparent required drawing color.`);
  }
  return result;
}

function length(node: IRNode, name: string, fallback: number) {
  const value = node.inputs[name];
  const result = quantity(node, value, `input “${name}”`, "length", fallback);
  if (result <= 0 || result > 4_096) fail(node, "CUT_MAP_CAMERA_RENDER_STYLE", `input “${name}” must be greater than 0px through 4096px.`);
  if (value !== undefined && result === fallback) fail(node, "CUT_MAP_CAMERA_RENDER_NOOP", `input “${name}” repeats the isolated v1 default ${fallback}px; omit it.`);
  return result;
}

function integer(node: IRNode, name: string, fallback: number, minimum: number, maximum: number) {
  const value = node.inputs[name];
  const result = quantity(node, value, `input “${name}”`, "scalar", fallback);
  if (!Number.isInteger(result) || result < minimum || result > maximum) fail(node, "CUT_MAP_CAMERA_RENDER_STYLE", `input “${name}” must be a whole Number from ${minimum} through ${maximum}.`);
  if (value !== undefined && result === fallback) fail(node, "CUT_MAP_CAMERA_RENDER_NOOP", `input “${name}” repeats the isolated v1 default ${fallback}; omit it.`);
  return result;
}

function ratioAt(ir: CutAVIR, node: IRNode, name: "opacity" | "reveal" | "progress", time: Rational) {
  const propertyValue = propertyAt(ir, node, name, time);
  const value = propertyValue?.kind === "null" ? node.inputs[name] : propertyValue ?? node.inputs[name];
  const result = quantity(node, value, `executed ${name}`, "ratio", name === "progress" ? 0 : 1);
  if (result < 0 || result > 1) fail(node, "CUT_MAP_CAMERA_RENDER_STYLE", `executed ${name} must be from 0% through 100%.`);
  return result;
}

function point(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "object") fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", `${label} must be one closed GeoPoint.`);
  const latitude = quantity(node, value.entries.latitude, `${label}.latitude`, "scalar", Number.NaN);
  const longitude = quantity(node, value.entries.longitude, `${label}.longitude`, "scalar", Number.NaN);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", `${label} is outside latitude/longitude bounds.`);
  return Object.freeze({ latitude, longitude });
}

function points(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "array") fail(node, "CUT_MAP_CAMERA_RENDER_UNSUPPORTED", `${label} must be the phase-one inline GeoPoint list; legacy DataAsset controls are not silently reinterpreted.`);
  return Object.freeze(value.items.map((item, index) => point(node, item, `${label}[${index}]`)));
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) throw new Error("MapCamera canonical drawing stream received a non-finite coordinate.");
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function canonicalExecutionTime(node: IRNode, value: Rational) {
  const integer = /^-?(?:0|[1-9]\d*)$/u, positive = /^(?:[1-9]\d*)$/u;
  if (!value || typeof value.numerator !== "string" || typeof value.denominator !== "string"
    || !integer.test(value.numerator) || !positive.test(value.denominator)
    || value.numerator.length > 256 || value.denominator.length > 256) {
    fail(node, "CUT_MAP_CAMERA_RENDER_SIGNAL", "execution time must be one bounded canonical Rational.");
  }
  let canonical: Rational;
  try { canonical = rational(value.numerator, value.denominator); }
  catch { fail(node, "CUT_MAP_CAMERA_RENDER_SIGNAL", "execution time must be one bounded canonical Rational."); }
  if (canonical.numerator !== value.numerator || canonical.denominator !== value.denominator) {
    fail(node, "CUT_MAP_CAMERA_RENDER_SIGNAL", "execution time must be reduced and canonically encoded.");
  }
  return canonical;
}

function projected(projection: ReferenceGeoMapCameraProjection, coordinate: Readonly<{ latitude: number; longitude: number }>) {
  const result = projection([coordinate.longitude, coordinate.latitude]);
  if (!result || !Number.isFinite(result[0]) || !Number.isFinite(result[1])) return undefined;
  return Object.freeze({ x: result[0], y: result[1] });
}

function alphaColor(colorValue: string) {
  return colorValue.length === 9 ? Number.parseInt(colorValue.slice(7, 9), 16) / 255 : 1;
}

function mapFragment(
  ir: CutAVIR,
  node: IRNode,
  child: ReferenceMapCameraChildConfig,
  projection: ReferenceGeoMapCameraProjection,
  atlas: VerifiedAtlas,
  time: Rational,
) {
  const background = color(node, "background", mapDefaults.background);
  const land = color(node, "land", mapDefaults.land);
  const border = color(node, "border", mapDefaults.border);
  const borderWidth = length(node, "borderWidth", mapDefaults.borderWidth);
  const graticule = color(node, "graticule", mapDefaults.graticule);
  const graticuleWidth = length(node, "graticuleWidth", mapDefaults.graticuleWidth);
  const path = geoPath(projection).digits(6);
  const landPath = path(atlas.world) ?? "";
  const graticulePath = alphaColor(graticule) === 0 ? "" : path(geoGraticule10()) ?? "";
  const opacity = ratioAt(ir, node, "opacity", time);
  const svg = `<g opacity="${formatNumber(opacity)}"><rect x="0" y="0" width="100%" height="100%" fill="${background}"/>${landPath ? `<path d="${landPath}" fill="${land}" stroke="${border}" stroke-width="${formatNumber(borderWidth)}" vector-effect="non-scaling-stroke"/>` : ""}${graticulePath ? `<path d="${graticulePath}" fill="none" stroke="${graticule}" stroke-width="${formatNumber(graticuleWidth)}" vector-effect="non-scaling-stroke"/>` : ""}</g>`;
  return fragment(
    node,
    child,
    svg,
    [
      ...(landPath && alphaColor(border) > 0 ? [borderWidth] : []),
      ...(graticulePath ? [graticuleWidth] : []),
    ],
    [],
    false,
  );
}

function fragment(
  node: IRNode,
  child: ReferenceMapCameraChildConfig,
  svg: string,
  screenStrokeWidths: readonly number[],
  screenRadii: readonly number[],
  clippedEmpty: boolean,
  routeSubject?: NonNullable<ReferenceMapCameraChildExecutionEvidence["routeSubject"]>,
): RenderFragment {
  const bytes = Buffer.byteLength(svg, "utf8");
  if (bytes > referenceMapCameraRenderLimits.maximumCanonicalFragmentBytes) {
    fail(node, "CUT_MAP_CAMERA_RENDER_LIMIT", `canonical child fragment contains ${bytes} bytes; the limit is ${referenceMapCameraRenderLimits.maximumCanonicalFragmentBytes}.`);
  }
  return Object.freeze({
    child,
    svg,
    screenStrokeWidths: Object.freeze([...screenStrokeWidths]),
    screenRadii: Object.freeze([...screenRadii]),
    clippedEmpty,
    ...(routeSubject ? { routeSubject } : {}),
  });
}

function measuredOne(node: IRNode, value: number, label: string): 1 {
  if (value !== 1) fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", `instrumented ${label} count is ${value}; isolated frame execution requires exactly one.`);
  return 1;
}

function measuredZero(node: IRNode, value: number, label: string): 0 {
  if (value !== 0) fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", `instrumented ${label} count is ${value}; isolated frame execution requires zero.`);
  return 0;
}

function routeFragment(ir: CutAVIR, node: IRNode, child: ReferenceMapCameraChildConfig, projection: ReferenceGeoMapCameraProjection, time: Rational) {
  const coordinates = points(node, node.inputs.points, "input “points”").map((entry) => [entry.longitude, entry.latitude]);
  const path = geoPath(projection).digits(6)({ type: "LineString", coordinates } as never) ?? "";
  const stroke = visibleColor(node, node.inputs.color !== undefined ? "color" : "stroke", routeDefaults.color);
  const width = length(node, "width", routeDefaults.width);
  const reveal = ratioAt(ir, node, "reveal", time), opacity = ratioAt(ir, node, "opacity", time);
  const svg = path && reveal > 0 && opacity > 0
    ? `<path d="${path}" pathLength="1" fill="none" stroke="${stroke}" stroke-width="${formatNumber(width)}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1" stroke-dashoffset="${formatNumber(1 - reveal)}" opacity="${formatNumber(opacity)}" vector-effect="non-scaling-stroke"/>`
    : "";
  return fragment(node, child, svg, svg ? [width] : [], [], !svg);
}

function routeSubjectFragment(
  ir: CutAVIR,
  node: IRNode,
  child: ReferenceMapCameraChildConfig,
  projection: ReferenceGeoMapCameraProjection,
  width: number,
  height: number,
  time: Rational,
) {
  const authored = points(node, node.inputs.points, "input “points”");
  const planned = child.routeSubject;
  if (!planned || planned.algorithmVersion !== referenceMapCameraRouteSubjectAlgorithmVersion
    || planned.distanceAlgorithm !== "d3-geo@3.1.1.geoDistance") {
    fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", "RouteSubject is missing its pinned planner distance contract.");
  }
  if (authored.length < 2 || authored.length > referenceMapCameraLimits.maximumRoutePointsPerRoute) {
    fail(node, authored.length > referenceMapCameraLimits.maximumRoutePointsPerRoute
      ? "CUT_MAP_CAMERA_RENDER_LIMIT"
      : "CUT_MAP_CAMERA_RENDER_GRAPH", `RouteSubject needs 2 through ${referenceMapCameraLimits.maximumRoutePointsPerRoute} authored points.`);
  }
  if (planned.segments !== authored.length - 1
    || planned.segmentAngularDistancesRadians.length !== authored.length - 1) {
    fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", "RouteSubject authored points do not correlate with the pinned planner segment count.");
  }
  const segments = authored.slice(1).map((to, index) => {
    const from = authored[index]!, radians = planned.segmentAngularDistancesRadians[index]!;
    if (!Number.isFinite(radians) || radians <= 0 || radians > Math.PI) {
      fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", `RouteSubject planner segment ${index} has invalid spherical distance ${radians}.`);
    }
    return Object.freeze({ from, to, radians });
  });
  const totalAngularDistanceRadians = segments.reduce((total, segment) => total + segment.radians, 0);
  if (!Number.isFinite(totalAngularDistanceRadians) || totalAngularDistanceRadians <= 0) {
    fail(node, "CUT_MAP_CAMERA_RENDER_NOOP", "RouteSubject route has zero total geographic length.");
  }
  if (totalAngularDistanceRadians !== planned.totalAngularDistanceRadians) {
    fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", "RouteSubject planner total does not correlate with its segment-distance closure.");
  }
  const progress = ratioAt(ir, node, "progress", time);
  let remaining = totalAngularDistanceRadians * progress;
  let segmentIndex = segments.length - 1;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (remaining <= segment.radians || index === segments.length - 1) {
      segmentIndex = index;
      break;
    }
    remaining -= segment.radians;
  }
  const selected = segments[segmentIndex]!;
  const segmentProgress = selected.radians === 0 ? 1 : Math.max(0, Math.min(1, remaining / selected.radians));
  let coordinate: readonly [number, number];
  try {
    coordinate = geoInterpolate(
      [selected.from.longitude, selected.from.latitude],
      [selected.to.longitude, selected.to.latitude],
    )(segmentProgress);
  } catch (error) {
    fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", `RouteSubject segment ${segmentIndex} interpolation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
    fail(node, "CUT_MAP_CAMERA_RENDER_GRAPH", `RouteSubject segment ${segmentIndex} interpolation produced a non-finite GeoPoint.`);
  }
  const geographicPoint = Object.freeze({ latitude: coordinate[1], longitude: coordinate[0] });
  const center = projected(projection, geographicPoint);
  const radius = length(node, "radius", routeSubjectDefaults.radius);
  const fill = visibleColor(node, "color", routeSubjectDefaults.color);
  const opacity = ratioAt(ir, node, "opacity", time);
  const visible = Boolean(center && opacity > 0
    && center.x + radius > 0 && center.x - radius < width
    && center.y + radius > 0 && center.y - radius < height);
  const svg = visible
    ? `<circle cx="${formatNumber(center!.x)}" cy="${formatNumber(center!.y)}" r="${formatNumber(radius)}" fill="${fill}" opacity="${formatNumber(opacity)}"/>`
    : "";
  const routeSubject = Object.freeze({
    algorithmVersion: referenceMapCameraRouteSubjectAlgorithmVersion,
    distanceAlgorithm: "d3-geo@3.1.1.geoDistance" as const,
    metric: "cumulative-spherical-great-circle-angular-distance" as const,
    interpolation: "d3-geo-geoInterpolate" as const,
    segments: planned.segments,
    exactFrameSamples: planned.exactFrameSamples,
    segmentFrameEvaluations: planned.segments * planned.exactFrameSamples,
    segmentFrameEvaluationLimit: referenceMapCameraLimits.maximumRouteSubjectSegmentFrameEvaluations,
    progress,
    segmentIndex,
    segmentProgress,
    totalAngularDistanceRadians,
    geographicPoint,
    projectedCenter: center ? Object.freeze([center.x, center.y] as const) : null,
  });
  return fragment(node, child, svg, [], svg ? [radius] : [], !svg, routeSubject);
}

function markerFragment(ir: CutAVIR, node: IRNode, child: ReferenceMapCameraChildConfig, projection: ReferenceGeoMapCameraProjection, width: number, height: number, time: Rational) {
  const authored = node.inputs.point;
  if (authored?.kind === "object" && authored.entries.label !== undefined || node.inputs.label !== undefined || node.inputs.font !== undefined) {
    fail(node, "CUT_MAP_CAMERA_RENDER_UNSUPPORTED", "marker label shaping is not completed in this isolated phase; label/font controls are refused rather than ignored.");
  }
  const center = projected(projection, point(node, authored, "input “point”"));
  const radius = length(node, "radius", markerDefaults.radius), fill = visibleColor(node, "color", markerDefaults.color), opacity = ratioAt(ir, node, "opacity", time);
  const visible = Boolean(center && opacity > 0 && center.x + radius > 0 && center.x - radius < width && center.y + radius > 0 && center.y - radius < height);
  const svg = visible ? `<circle cx="${formatNumber(center!.x)}" cy="${formatNumber(center!.y)}" r="${formatNumber(radius)}" fill="${fill}" opacity="${formatNumber(opacity)}"/>` : "";
  return fragment(node, child, svg, [], svg ? [radius] : [], !svg);
}

function wavefrontFragment(ir: CutAVIR, node: IRNode, child: ReferenceMapCameraChildConfig, projection: ReferenceGeoMapCameraProjection, width: number, height: number, time: Rational) {
  const center = projected(projection, point(node, node.inputs.origin, "input “origin”"));
  const maximumRadius = node.inputs.radius === undefined ? Math.min(width, height) * 0.35 : length(node, "radius", Math.min(width, height) * 0.35);
  const count = integer(node, "count", wavefrontDefaults.count, 1, 12);
  const stroke = visibleColor(node, "color", wavefrontDefaults.color), reveal = ratioAt(ir, node, "reveal", time), opacity = ratioAt(ir, node, "opacity", time);
  const visibleRadius = maximumRadius * reveal;
  const potentiallyVisible = Boolean(center && reveal > 0 && opacity > 0 && center.x + visibleRadius > 0 && center.x - visibleRadius < width && center.y + visibleRadius > 0 && center.y - visibleRadius < height);
  const radii = potentiallyVisible ? Array.from({ length: count }, (_, index) => maximumRadius * ((index + 1) / count) * reveal) : [];
  const rings = radii.map((radius, index) => {
    const ringOpacity = opacity * (1 - index / (count + 1));
    return `<circle cx="${formatNumber(center!.x)}" cy="${formatNumber(center!.y)}" r="${formatNumber(radius)}" fill="none" stroke="${stroke}" stroke-width="2" opacity="${formatNumber(ringOpacity)}" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  return fragment(node, child, rings, rings ? [2] : [], radii, !rings);
}

function connectionsFragment(ir: CutAVIR, node: IRNode, child: ReferenceMapCameraChildConfig, projection: ReferenceGeoMapCameraProjection, width: number, height: number, time: Rational) {
  const targetValue = node.inputs.target;
  if (targetValue?.kind === "object" && targetValue.entries.label !== undefined || node.inputs.font !== undefined) {
    fail(node, "CUT_MAP_CAMERA_RENDER_UNSUPPORTED", "Connections target-label shaping is not completed in this isolated phase; label/font controls are refused rather than ignored.");
  }
  const sourceName = node.inputs.points !== undefined ? "points" : "stations";
  const sources = points(node, node.inputs[sourceName], `input “${sourceName}”`);
  const target = point(node, targetValue, "input “target”");
  const count = integer(node, "count", connectionsDefaults.count, 1, 500);
  if (node.inputs.count !== undefined && count > sources.length) {
    fail(node, "CUT_MAP_CAMERA_RENDER_NOOP", `input “count” ${count} exceeds the ${sources.length} executed source points.`);
  }
  const selected = sources.slice(0, Math.min(count, sources.length));
  const path = geoPath(projection).digits(6);
  const stroke = visibleColor(node, "color", connectionsDefaults.color), strokeWidth = length(node, "width", connectionsDefaults.width);
  const reveal = ratioAt(ir, node, "reveal", time), opacity = ratioAt(ir, node, "opacity", time);
  const fragments = selected.map((source) => path({ type: "LineString", coordinates: [[source.longitude, source.latitude], [target.longitude, target.latitude]] } as never) ?? "").filter(Boolean);
  const projectedTarget = projected(projection, target);
  const targetRadius = 8;
  const targetVisible = Boolean(projectedTarget
    && projectedTarget.x + targetRadius > 0 && projectedTarget.x - targetRadius < width
    && projectedTarget.y + targetRadius > 0 && projectedTarget.y - targetRadius < height);
  const svg = reveal > 0 && opacity > 0
    ? `${fragments.map((entry) => `<path d="${entry}" pathLength="1" fill="none" stroke="${stroke}" stroke-width="${formatNumber(strokeWidth)}" stroke-linecap="round" stroke-dasharray="1" stroke-dashoffset="${formatNumber(1 - reveal)}" opacity="${formatNumber(opacity)}" vector-effect="non-scaling-stroke"/>`).join("")}${targetVisible ? `<circle cx="${formatNumber(projectedTarget!.x)}" cy="${formatNumber(projectedTarget!.y)}" r="${targetRadius}" fill="${stroke}" opacity="${formatNumber(opacity)}"/>` : ""}`
    : "";
  return fragment(node, child, svg, svg ? [strokeWidth] : [], targetVisible && svg ? [targetRadius] : [], !svg);
}

function signalCollections(signal: IRSignal) {
  if (signal.kind === "step") return signal.points.map((_, index) => ({ kind: "step" as const, index }));
  if (signal.kind === "keyframes") return signal.keyframes.map((_, index) => ({ kind: "keyframes" as const, index }));
  if (signal.kind === "track") return signal.events.map((_, index) => ({ kind: "track" as const, index }));
  return [];
}

function signalEntryStart(signal: IRSignal, entry: ReturnType<typeof signalCollections>[number]) {
  if (entry.kind === "step" && signal.kind === "step") return signal.points[entry.index].time;
  if (entry.kind === "keyframes" && signal.kind === "keyframes") return signal.keyframes[entry.index].time;
  if (entry.kind === "track" && signal.kind === "track") {
    const event = signal.events[entry.index];
    return event.kind === "set" ? event.time : event.start;
  }
  return rational(0);
}

function withoutSignalEntry(signal: IRSignal, entry: ReturnType<typeof signalCollections>[number]): IRSignal {
  if (entry.kind === "step" && signal.kind === "step") return { ...signal, points: signal.points.filter((_, index) => index !== entry.index) };
  if (entry.kind === "keyframes" && signal.kind === "keyframes") return { ...signal, keyframes: signal.keyframes.filter((_, index) => index !== entry.index) };
  if (entry.kind === "track" && signal.kind === "track") return { ...signal, events: signal.events.filter((_, index) => index !== entry.index) };
  return signal;
}

function signalValueIdentity(value: IRValue) {
  return stableJsonStringify(value);
}

function validateSampleRelevantSignals(ir: CutAVIR, composition: IRComposition, camera: IRNode, config: ReferenceMapCameraConfig) {
  const cameraTimes = referenceMapCameraValidationTimes(composition, camera);
  const consumers: SignalConsumer[] = [];
  const register = (node: IRNode, properties: readonly string[], times: readonly Rational[]) => {
    for (const property of properties) {
      const authored = node.properties[property];
      if (authored && "signal" in authored) {
        if (times.length === 0) fail(node, "CUT_MAP_CAMERA_RENDER_SIGNAL", `property “${property}” has no bounded output-frame sample for signal ${authored.signal}.`);
        consumers.push(Object.freeze({ node, property, signalId: authored.signal, times }));
      }
    }
  };
  register(camera, ["latitude", "longitude", "scale", "bearing", "pitch"], cameraTimes);
  for (const child of config.children) {
    const node = ir.nodes[child.nodeId];
    if (!node) fail(camera, "CUT_MAP_CAMERA_RENDER_GRAPH", `validated child ${child.nodeId} is missing.`);
    const times = cameraTimes.filter((time) => {
      const end = addRational(node.interval.start, node.interval.duration);
      return compareRational(time, node.interval.start) >= 0 && compareRational(time, end) < 0;
    });
    register(
      node,
      child.kind === "route-subject"
        ? ["opacity", "progress"]
        : child.kind === "route" || child.kind === "wavefront" || child.kind === "connections"
          ? ["opacity", "reveal"]
          : ["opacity"],
      times,
    );
  }
  if (consumers.length > referenceMapCameraRenderLimits.maximumSignalConsumers) fail(camera, "CUT_MAP_CAMERA_RENDER_LIMIT", `signal consumer count ${consumers.length} exceeds ${referenceMapCameraRenderLimits.maximumSignalConsumers}.`);
  const grouped = new Map<string, SignalConsumer[]>();
  for (const consumer of consumers) grouped.set(consumer.signalId, [...(grouped.get(consumer.signalId) ?? []), consumer]);
  for (const [signalId, signalConsumers] of grouped) {
    const signal = ir.signals[signalId];
    if (!signal) fail(signalConsumers[0].node, "CUT_MAP_CAMERA_RENDER_SIGNAL", `property “${signalConsumers[0].property}” references missing signal ${signalId}.`);
    const entries = signalCollections(signal);
    if (entries.length > referenceMapCameraRenderLimits.maximumSignalEntries) {
      fail(signalConsumers[0].node, "CUT_MAP_CAMERA_RENDER_LIMIT", `signal ${signalId} contains ${entries.length} entries; the isolated execution limit is ${referenceMapCameraRenderLimits.maximumSignalEntries}.`);
    }
    const allTimes = signalConsumers.flatMap((consumer) => consumer.times);
    const influenceComparisons = entries.length * allTimes.length;
    if (!Number.isSafeInteger(influenceComparisons)
      || influenceComparisons > referenceMapCameraRenderLimits.maximumSignalInfluenceComparisons) {
      fail(signalConsumers[0].node, "CUT_MAP_CAMERA_RENDER_LIMIT", `signal ${signalId} needs ${influenceComparisons} bounded influence comparisons; the isolated execution limit is ${referenceMapCameraRenderLimits.maximumSignalInfluenceComparisons}.`);
    }
    const latest = allTimes.reduce((right, time) => compareRational(time, right) > 0 ? time : right, allTimes[0]);
    for (const entry of entries) {
      if (compareRational(signalEntryStart(signal, entry), latest) > 0) {
        fail(signalConsumers[0].node, "CUT_MAP_CAMERA_RENDER_NOOP", `signal ${signalId} ${entry.kind}[${entry.index}] begins after every bounded output-frame sample of its MapCamera consumers.`);
      }
      const reduced = withoutSignalEntry(signal, entry);
      const reducedIr = { ...ir, signals: { ...ir.signals, [signalId]: reduced } };
      let affects = false;
      for (const consumer of signalConsumers) for (const time of consumer.times) {
        const original = evaluateSignal(ir, signalId, time), candidate = evaluateSignal(reducedIr, signalId, time);
        if (signalValueIdentity(original) !== signalValueIdentity(candidate)) { affects = true; break; }
      }
      if (!affects) {
        fail(signalConsumers[0].node, "CUT_MAP_CAMERA_RENDER_NOOP", `signal ${signalId} ${entry.kind}[${entry.index}] cannot affect any bounded output-frame sample of its MapCamera consumers.`);
      }
    }
  }
}

function frameTimeKey(time: Rational) {
  return `${time.numerator}/${time.denominator}`;
}

/**
 * Prepare the immutable MapCamera graph once for one renderer invocation.
 * The returned public receipt carries no executable graph references; those
 * remain in a module-private WeakMap so callers cannot forge a preparation for
 * another IR or composition.
 */
export function prepareReferenceMapCameraRenderInvocation(
  ir: CutAVIR,
  composition: IRComposition,
  selectedNodeIds?: ReadonlySet<string>,
): ReferenceMapCameraRenderPreparation {
  const configs = validateReferenceMapCameraGraph(ir, composition, selectedNodeIds);
  const frameTimeKeys = new Map<string, ReadonlySet<string>>();
  const firstConfig = configs.values().next().value as ReferenceMapCameraConfig | undefined;
  const firstCamera = firstConfig ? ir.nodes[firstConfig.nodeId] : undefined;
  const backend = firstCamera ? dependencyEvidence(firstCamera) : undefined;
  const atlasByDetail = new Map<ReferenceMapCameraAtlasDetail, VerifiedAtlas>();
  const atlasByCamera = new Map<string, ReadonlyMap<string, VerifiedAtlas>>();
  const cameras = Object.freeze([...configs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, config]) => {
      const camera = ir.nodes[nodeId];
      if (!camera || camera.op !== "cut.geo.map_camera") {
        const source = Object.values(ir.nodes)[0];
        if (!source) throw new Error("CUT_MAP_CAMERA_RENDER_GRAPH: MapCamera preparation received an empty IR graph.");
        fail(source, "CUT_MAP_CAMERA_RENDER_GRAPH", `validated MapCamera ${nodeId} disappeared before preparation.`);
      }
      validateSampleRelevantSignals(ir, composition, camera, config);
      const times = referenceMapCameraValidationTimes(composition, camera);
      frameTimeKeys.set(nodeId, new Set(times.map(frameTimeKey)));
      const atlases = new Map<string, VerifiedAtlas>();
      for (const child of config.children) if (child.kind === "map") {
        const mapNode = ir.nodes[child.nodeId];
        if (!mapNode) fail(camera, "CUT_MAP_CAMERA_RENDER_GRAPH", `validated map ${child.nodeId} disappeared before preparation.`);
        if (!child.atlas) fail(mapNode, "CUT_MAP_CAMERA_RENDER_RESOURCE", "Map planner omitted its exact atlas selection.");
        let verified = atlasByDetail.get(child.atlas.detail);
        if (!verified) {
          verified = loadAtlas(mapNode, child.atlas.detail);
          atlasByDetail.set(child.atlas.detail, verified);
        }
        atlases.set(child.nodeId, verified);
      }
      atlasByCamera.set(nodeId, atlases);
      return Object.freeze({
        nodeId,
        semanticIdentity: config.semanticIdentity,
        exactFrameSamples: times.length,
      });
    }));
  const receipt = Object.freeze({
    format: "cut-reference-map-camera-render-preparation" as const,
    version: 1 as const,
    algorithmVersion: referenceMapCameraRenderAlgorithmVersion,
    compositionId: composition.id,
    cameras,
    verifiedInputs: Object.freeze({
      scope: "renderer-invocation-only" as const,
      backendIdentity: hash(backend ?? { status: "no-map-camera" }),
      atlases: Object.freeze([...atlasByDetail.values()]
        .map((entry) => entry.evidence)
        .sort((left, right) => left.detail.localeCompare(right.detail))),
      dependencyIdentityVerifications: (backend ? 1 : 0) as 1 | 0,
      atlasByteVerifications: atlasByDetail.size,
      persistentCacheReads: 0 as const,
      persistentCacheWrites: 0 as const,
    }),
    validation: "whole-graph-and-signal-influence-once-before-frame-raster" as const,
    semanticIdentity: hash({
      format: "cut-reference-map-camera-render-preparation",
      version: 1,
      algorithmVersion: referenceMapCameraRenderAlgorithmVersion,
      compositionId: composition.id,
      cameras,
      backend,
      atlases: Object.freeze([...atlasByDetail.values()].map((entry) => entry.evidence)),
    }),
  });
  trustedReferenceMapCameraRenderPreparations.set(receipt, Object.freeze({
    ir,
    composition,
    configs: new Map(configs),
    frameTimeKeys,
    ...(backend ? { backend } : {}),
    atlasByCamera,
  }));
  return receipt;
}

export function referenceMapCameraPreparedConfigurations(
  preparation: ReferenceMapCameraRenderPreparation,
): ReadonlyMap<string, ReferenceMapCameraConfig> {
  const trusted = trustedReferenceMapCameraRenderPreparations.get(preparation);
  if (!trusted) {
    throw new Error("CUT_MAP_CAMERA_RENDER_GRAPH: MapCamera preparation was not created by this runtime invocation.");
  }
  return new Map(trusted.configs);
}

function renderFragment(
  ir: CutAVIR,
  composition: IRComposition,
  child: ReferenceMapCameraChildConfig,
  projection: ReferenceGeoMapCameraProjection,
  atlases: ReadonlyMap<string, VerifiedAtlas>,
  time: Rational,
  camera: IRNode,
) {
  const node = ir.nodes[child.nodeId];
  if (!node) fail(camera, "CUT_MAP_CAMERA_RENDER_GRAPH", `validated child ${child.nodeId} is missing.`);
  if (child.kind === "annotation") fail(node, "CUT_MAP_CAMERA_RENDER_UNSUPPORTED", "GeoAnnotation/LocalSpace callback placement is explicitly outside isolated phase two.");
  if (child.kind === "map") {
    const atlas = atlases.get(child.nodeId);
    if (!atlas) fail(node, "CUT_MAP_CAMERA_RENDER_RESOURCE", "Map has no verified selected atlas.");
    return mapFragment(ir, node, child, projection, atlas, time);
  }
  if (child.kind === "route") return routeFragment(ir, node, child, projection, time);
  if (child.kind === "route-subject") return routeSubjectFragment(ir, node, child, projection, composition.width, composition.height, time);
  if (child.kind === "marker") return markerFragment(ir, node, child, projection, composition.width, composition.height, time);
  if (child.kind === "wavefront") return wavefrontFragment(ir, node, child, projection, composition.width, composition.height, time);
  return connectionsFragment(ir, node, child, projection, composition.width, composition.height, time);
}

function clearTransparentRgb(data: Buffer) {
  let cleared = 0;
  for (let offset = 0; offset < data.byteLength; offset += 4) if (data[offset + 3] === 0) {
    if (data[offset] !== 0 || data[offset + 1] !== 0 || data[offset + 2] !== 0) cleared += 1;
    data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0;
  }
  return cleared;
}

/** Enforce CUT's canonical stream envelope before the raster backend sees any
 * bytes. This guard remains authoritative when Sharp's `unlimited` switch is
 * used to remove librsvg's lower incidental XML buffer ceiling. */
export function assertReferenceMapCameraCanonicalStreamBytes(node: IRNode, streamBytes: number) {
  if (!Number.isSafeInteger(streamBytes) || streamBytes < 0) {
    fail(node, "CUT_MAP_CAMERA_RENDER_STREAM", "canonical drawing stream byte count must be one non-negative safe integer.");
  }
  if (streamBytes > referenceMapCameraRenderLimits.maximumCanonicalDrawingStreamBytes) {
    fail(node, "CUT_MAP_CAMERA_RENDER_STREAM", `canonical drawing stream is ${streamBytes} bytes; limit ${referenceMapCameraRenderLimits.maximumCanonicalDrawingStreamBytes}.`);
  }
  return streamBytes;
}

/**
 * Execute one actual final-space MapCamera frame in the isolated reference
 * backend. Public compiler/runtime integration remains intentionally absent.
 */
export async function renderReferenceMapCameraFrame(
  ir: CutAVIR,
  composition: IRComposition,
  config: ReferenceMapCameraConfig,
  exactTime: Rational,
  context: ReferenceMapCameraRenderContext = isolatedRenderContext,
): Promise<ReferenceMapCameraRenderedFrameEvidence> {
  const camera = ir.nodes[config.nodeId];
  if (!camera || camera.op !== "cut.geo.map_camera") {
    const source = Object.values(ir.nodes)[0];
    if (!source) throw new Error("CUT_MAP_CAMERA_RENDER_GRAPH: MapCamera execution received an empty IR graph.");
    fail(source, "CUT_MAP_CAMERA_RENDER_GRAPH", `MapCamera ${config.nodeId} is missing.`);
  }
  const prepared = context.preparation === undefined
    ? undefined
    : trustedReferenceMapCameraRenderPreparations.get(context.preparation);
  if (context.preparation !== undefined
    && (!prepared || prepared.ir !== ir || prepared.composition !== composition)) {
    fail(camera, "CUT_MAP_CAMERA_RENDER_GRAPH", "renderer preparation is untrusted or belongs to another IR/composition invocation.");
  }
  const validated = prepared?.configs.get(camera.id)
    ?? validateReferenceMapCameraGraph(ir, composition).get(camera.id);
  if (!validated || validated.semanticIdentity !== config.semanticIdentity) {
    fail(camera, "CUT_MAP_CAMERA_RENDER_GRAPH", "supplied MapCamera configuration does not match the validated semantic graph.");
  }
  config = validated;
  exactTime = canonicalExecutionTime(camera, exactTime);
  const preparedFrameTimes = prepared?.frameTimeKeys.get(camera.id);
  const exactTimeIsFrameSample = preparedFrameTimes
    ? preparedFrameTimes.has(frameTimeKey(exactTime))
    : referenceMapCameraValidationTimes(composition, camera)
      .some((time) => compareRational(time, exactTime) === 0);
  if (!exactTimeIsFrameSample) {
    fail(camera, "CUT_MAP_CAMERA_RENDER_SIGNAL", `execution time ${exactTime.numerator}/${exactTime.denominator}s is not one bounded exact output-frame sample.`);
  }
  if (config.children.some((child) => child.kind === "annotation") && context.annotationMode === "reject") {
    const annotation = config.children.find((child) => child.kind === "annotation")!;
    fail(ir.nodes[annotation.nodeId]!, "CUT_MAP_CAMERA_RENDER_UNSUPPORTED", "GeoAnnotation/LocalSpace callback placement is explicitly outside isolated phase two.");
  }
  const measured = {
    atlasByteVerifications: 0,
    dependencyIdentityVerifications: 0,
    canonicalStreamSerializations: 0,
    rasterizations: 0,
    resizePasses: 0,
    resamplePasses: 0,
    alphaCanonicalizationPasses: 0,
  };
  const pixels = composition.width * composition.height, rgbaBytes = pixels * 4;
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(rgbaBytes)
    || composition.width < 1 || composition.height < 1
    || composition.width > referenceMapCameraRenderLimits.maximumRasterAxis
    || composition.height > referenceMapCameraRenderLimits.maximumRasterAxis
    || pixels > referenceMapCameraRenderLimits.maximumRasterPixels
    || rgbaBytes > referenceMapCameraRenderLimits.maximumRasterRgbaBytes) {
    fail(camera, "CUT_MAP_CAMERA_RENDER_LIMIT", `delivery raster ${composition.width}x${composition.height}/${pixels} pixels/${rgbaBytes} RGBA bytes exceeds the isolated backend envelope.`);
  }
  const backend = prepared?.backend ?? dependencyEvidence(camera);
  if (!prepared) measured.dependencyIdentityVerifications += 1;
  if (!prepared) validateSampleRelevantSignals(ir, composition, camera, config);
  const plan = referenceMapCameraPlanAt(ir, composition, config, exactTime);
  const state = referenceMapCameraStateAt(ir, camera, exactTime);
  let projection: ReferenceGeoMapCameraProjection;
  try {
    projection = referenceGeoMapCameraProjection(
      composition.width,
      composition.height,
      { latitude: state.latitude, longitude: state.longitude },
      state.scale,
      state.effectiveBearing,
      state.pitch,
    ).clipExtent([[0, 0], [composition.width, composition.height]]);
  } catch (error) {
    fail(camera, error instanceof ReferenceMapCameraProjectivePitchError && error.code === "CUT_MAP_CAMERA_PITCH_RESOURCE_LIMIT"
      ? "CUT_MAP_CAMERA_RENDER_LIMIT"
      : "CUT_MAP_CAMERA_RENDER_GRAPH", `projective camera preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const preparedAtlases = prepared?.atlasByCamera.get(camera.id);
  const atlasByNode = new Map<string, VerifiedAtlas>(preparedAtlases ?? []);
  if (!prepared) for (const child of config.children) if (child.kind === "map") {
    if (!child.atlas) fail(ir.nodes[child.nodeId]!, "CUT_MAP_CAMERA_RENDER_RESOURCE", "Map planner omitted its exact atlas selection.");
    atlasByNode.set(child.nodeId, loadAtlas(ir.nodes[child.nodeId]!, child.atlas.detail));
    measured.atlasByteVerifications += 1;
  }
  const active = new Set(plan.activeChildren.map((child) => child.nodeId));
  let fragments: readonly RenderFragment[];
  try {
    fragments = Object.freeze(config.children
      .filter((child) => active.has(child.nodeId))
      .filter((child) => child.kind !== "annotation")
      .map((child) => renderFragment(ir, composition, child, projection, atlasByNode, exactTime, camera)));
  } catch (error) {
    if (error instanceof ReferenceMapCameraRenderError) throw error;
    if (error instanceof ReferenceMapCameraProjectivePitchError || error instanceof ReferenceGeoProjectionError) {
      fail(camera, error.code.endsWith("LIMIT") || error.code.endsWith("RESOURCE_LIMIT")
        ? "CUT_MAP_CAMERA_RENDER_LIMIT"
        : "CUT_MAP_CAMERA_RENDER_GRAPH", `projective geographic stream failed: ${error.message}`);
    }
    throw error;
  }
  if (!fragments.some((entry) => !entry.clippedEmpty)) fail(camera, "CUT_MAP_CAMERA_RENDER_NOOP", "every active geographic leaf clips to an empty final-space drawing at this sample.");
  const clipId = "cut-map-camera-final-clip";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${composition.width}" height="${composition.height}" viewBox="0 0 ${composition.width} ${composition.height}"><defs><clipPath id="${clipId}"><rect x="0" y="0" width="${composition.width}" height="${composition.height}"/></clipPath></defs><g clip-path="url(#${clipId})">${fragments.map((entry) => entry.svg).join("")}</g></svg>`;
  measured.canonicalStreamSerializations += 1;
  const streamBytes = assertReferenceMapCameraCanonicalStreamBytes(camera, Buffer.byteLength(svg, "utf8"));
  const atlas = Object.freeze([...atlasByNode.values()].map((entry) => entry.evidence));
  const streamDigest = sha256(svg);
  const canonicalRasterCacheKey = referenceMapCameraCanonicalRasterCacheIdentity({
    canonicalDrawingStreamSha256: streamDigest,
    canonicalDrawingStreamBytes: streamBytes,
    width: composition.width,
    height: composition.height,
    backend,
    atlas,
  });
  const materializeCanonicalRaster = async (): Promise<ReferenceMapCameraCanonicalRaster> => {
    let rendered: { data: Buffer; info: OutputInfo };
    try {
      measured.rasterizations += 1;
      // `unlimited` removes librsvg's ~10 MB XML buffer ceiling, not CUT's
      // safety contract. The trusted canonical serializer above is bounded by
      // exact atlas/point/fragment/stream limits and the delivery raster is
      // independently bounded before this call.
      rendered = await sharp(Buffer.from(svg), {
        density: 72,
        limitInputPixels: referenceMapCameraRenderLimits.maximumRasterPixels,
        unlimited: true,
      })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      fail(camera, "CUT_MAP_CAMERA_RENDER_RASTER", `single-pass SVG rasterization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (rendered.info.width !== composition.width || rendered.info.height !== composition.height || rendered.info.channels !== 4 || rendered.data.byteLength !== rgbaBytes) {
      fail(camera, "CUT_MAP_CAMERA_RENDER_RASTER", `raster backend returned ${rendered.info.width}x${rendered.info.height}x${rendered.info.channels}/${rendered.data.byteLength} bytes instead of ${composition.width}x${composition.height}x4/${rgbaBytes}.`);
    }
    const clearedTransparentRgbPixels = clearTransparentRgb(rendered.data);
    measured.alphaCanonicalizationPasses += 1;
    let visiblePixels = 0;
    for (let offset = 0; offset < rendered.data.byteLength; offset += 4) if (rendered.data[offset + 3] === 0
      && (rendered.data[offset] !== 0 || rendered.data[offset + 1] !== 0 || rendered.data[offset + 2] !== 0)) {
      fail(camera, "CUT_MAP_CAMERA_RENDER_ALPHA", `transparent pixel ${offset / 4} retains hidden RGB after canonicalization.`);
    } else if (rendered.data[offset + 3] > 0) visiblePixels += 1;
    if (visiblePixels === 0) fail(camera, "CUT_MAP_CAMERA_RENDER_NOOP", "canonical drawing stream rasterized to a fully transparent delivery frame.");
    return Object.freeze({
      data: rendered.data,
      width: composition.width,
      height: composition.height,
      sha256: sha256(rendered.data),
      clearedTransparentRgbPixels,
      visiblePixels,
    });
  };
  const canonicalRasterResult = context.canonicalRasterCache
    ? await context.canonicalRasterCache.request(
      canonicalRasterCacheKey,
      composition.width,
      composition.height,
      materializeCanonicalRaster,
    )
    : Object.freeze({
      raster: await materializeCanonicalRaster(),
      evidence: Object.freeze({
        algorithmVersion: referenceMapCameraCanonicalRasterCacheAlgorithmVersion,
        scope: "renderer-invocation-memory" as const,
        outcome: "disabled" as const,
        key: canonicalRasterCacheKey,
        entryBytes: rgbaBytes,
        residentBytes: 0,
        entries: 0,
        evictions: 0,
        byteLimit: 0,
        entryLimit: 0,
      }),
    });
  const rendered = canonicalRasterResult.raster;
  const clearedTransparentRgbPixels = rendered.clearedTransparentRgbPixels;
  const children = Object.freeze(fragments.map((entry): ReferenceMapCameraChildExecutionEvidence => Object.freeze({
    nodeId: entry.child.nodeId,
    kind: entry.child.kind as Exclude<ReferenceMapCameraChildKind, "annotation">,
    sourceOrder: entry.child.sourceOrder,
    status: entry.clippedEmpty ? "clipped-empty" : "drawn",
    fragmentBytes: Buffer.byteLength(entry.svg, "utf8"),
    fragmentDigest: sha256(entry.svg),
    screenSpace: Object.freeze({
      strokeWidths: Object.freeze([...entry.screenStrokeWidths]),
      radii: Object.freeze([...entry.screenRadii]),
      cameraScaleAppliedToStyle: false as const,
    }),
    ...(entry.routeSubject ? { routeSubject: entry.routeSubject } : {}),
  })));
  const pitchExecution = projection.referencePitchEvidence();
  const preimage = pitchExecution.preimage;
  if (!Number.isSafeInteger(pitchExecution.projectedStreamPointEvents)
    || pitchExecution.projectedStreamPointEvents < 0
    || pitchExecution.projectedStreamPointEvents > referenceMapCameraRenderLimits.maximumProjectedStreamPointEvents) {
    fail(camera, "CUT_MAP_CAMERA_RENDER_LIMIT", `projective pitch measured ${pitchExecution.projectedStreamPointEvents} stream point events; the limit is ${referenceMapCameraRenderLimits.maximumProjectedStreamPointEvents}.`);
  }
  const projectivePitch = Object.freeze({
    model: "bounded-flat-plane-projective" as const,
    applied: !preimage.plan.identity,
    transformOrder: "bearing-then-pitch" as const,
    focalDistance: preimage.plan.focalDistance,
    preimage: Object.freeze({
      left: preimage.bounds.left,
      top: preimage.bounds.top,
      right: preimage.bounds.right,
      bottom: preimage.bounds.bottom,
      expansionX: preimage.expansion.x,
      expansionY: preimage.expansion.y,
      maximumExpansion: preimage.expansion.maximumAxis,
      limit: 8 as const,
    }),
    forwardDenominator: Object.freeze({
      minimum: preimage.denominators.minimumForwardOverPreimageBounds,
      finite: true as const,
      positive: true as const,
    }),
    inverseDenominator: Object.freeze({
      minimum: preimage.denominators.minimumInverseOverDeliveryCorners,
      finite: true as const,
      positive: true as const,
    }),
    projectedStreamPointEvents: pitchExecution.projectedStreamPointEvents,
    projectedStreamPointEventLimit: 2_097_152 as const,
  });
  const surfaceDigest = rendered.sha256;
  // Planning owns the composition-wide worst-case admission total. A completed
  // frame receipt owns only work for the active children it actually rendered.
  // Keeping these domains distinct lets the semantic verifier correlate every
  // frame counter with the child receipts beside it when RouteSubjects enter
  // and leave over time.
  const activeRouteSubjectSegments = children.reduce(
    (total, child) => total + (child.routeSubject?.segments ?? 0),
    0,
  );
  const activeRouteSubjectSegmentFrameEvaluations = children.reduce(
    (total, child) => total + (child.routeSubject?.segmentFrameEvaluations ?? 0),
    0,
  );
  const cacheHit = canonicalRasterResult.evidence.outcome === "hit";
  const expectedRasterPasses = cacheHit ? 0 : 1;
  if (measured.rasterizations !== expectedRasterPasses
    || measured.alphaCanonicalizationPasses !== expectedRasterPasses) {
    fail(
      camera,
      "CUT_MAP_CAMERA_RENDER_RASTER",
      `canonical-raster cache outcome ${canonicalRasterResult.evidence.outcome} must correlate with ${expectedRasterPasses} raster/alpha pass; measured ${measured.rasterizations}/${measured.alphaCanonicalizationPasses}.`,
    );
  }
  const counters = Object.freeze({
    measurement: "instrumented-isolated-executor" as const,
    atlasByteVerifications: measured.atlasByteVerifications,
    dependencyIdentityVerifications: prepared
      ? measuredZero(camera, measured.dependencyIdentityVerifications, "per-frame dependency identity verification after invocation preparation")
      : measuredOne(camera, measured.dependencyIdentityVerifications, "dependency identity verification"),
    projectedChildren: fragments.length,
    drawnChildren: fragments.filter((entry) => !entry.clippedEmpty).length,
    clippedEmptyChildren: fragments.filter((entry) => entry.clippedEmpty).length,
    canonicalStreamSerializations: measuredOne(camera, measured.canonicalStreamSerializations, "canonical stream serialization"),
    rasterizations: measured.rasterizations as 0 | 1,
    resizePasses: measuredZero(camera, measured.resizePasses, "resize pass"),
    resamplePasses: measuredZero(camera, measured.resamplePasses, "resample pass"),
    alphaCanonicalizationPasses: measured.alphaCanonicalizationPasses as 0 | 1,
    clearedTransparentRgbPixels,
    preProjectiveClipConfigurations: (projectivePitch.applied ? 1 : 0) as 0 | 1,
    postProjectiveClipConfigurations: 1 as const,
    projectivePitchPointEvents: projectivePitch.projectedStreamPointEvents,
    routeSubjectSegments: activeRouteSubjectSegments,
    routeSubjectSegmentFrameEvaluations: activeRouteSubjectSegmentFrameEvaluations,
    routeSubjectSegmentFrameEvaluationLimit: config.validation.routeSubjectSegmentFrameEvaluationLimit,
  });
  const cacheIdentity = hash({
    algorithmVersion: referenceMapCameraRenderAlgorithmVersion,
    canonicalRasterCacheAlgorithmVersion: referenceMapCameraCanonicalRasterCacheAlgorithmVersion,
    canonicalRasterCacheKey,
    backend,
    semanticIdentity: config.semanticIdentity,
    exactTime,
    state: state.exact,
    atlas,
    streamDigest,
  });
  const receipt = Object.freeze({
    format: referenceMapCameraRenderEvidenceFormat,
    version: 5 as const,
    evidenceKind: context.evidenceKind,
    publicRuntimeStatus: context.publicRuntimeStatus,
    cacheStatus: context.cacheStatus,
    algorithmVersion: referenceMapCameraRenderAlgorithmVersion,
    cameraAlgorithmVersion: referenceMapCameraAlgorithmVersion,
    projectionAlgorithm: referenceGeoMapCameraProjectionAlgorithm,
    compositionId: composition.id,
    cameraId: camera.id,
    exactTime: Object.freeze({ ...exactTime }),
    state,
    atlas,
    children,
    projectivePitch,
    execution: Object.freeze({
      retainedGeometry: "executed-in-final-delivery-space" as const,
      raster: cacheHit
        ? "reused-canonical-renderer-invocation-raster" as const
        : "executed-once-at-delivery-resolution" as const,
      resize: "not-executed" as const,
      resample: "not-executed" as const,
      planCacheIdentity: plan.planCacheIdentity,
      deferredAnnotationIds: Object.freeze(config.children.filter((child) => child.kind === "annotation" && active.has(child.nodeId)).map((child) => child.nodeId)),
    }),
    canonicalDrawingStream: Object.freeze({
      format: "canonical-final-space-svg" as const,
      numericDigits: 6 as const,
      clip: Object.freeze({ left: 0 as const, top: 0 as const, right: composition.width, bottom: composition.height, halfOpen: true as const }),
      bytes: streamBytes,
      sha256: streamDigest,
    }),
    canonicalRasterCache: canonicalRasterResult.evidence,
    surface: Object.freeze({
      width: composition.width,
      height: composition.height,
      channels: 4 as const,
      alphaMode: "straight" as const,
      colorSpace: "encoded-srgb" as const,
      rgbaBytes,
      sha256: surfaceDigest,
      data: rendered.data,
    }),
    backend,
    counters,
    semanticIdentity: config.semanticIdentity,
    cacheIdentity,
  });
  const completed = Object.freeze({
    ...receipt,
    executionIdentity: hash({
      ...receipt,
      surface: {
        width: receipt.surface.width,
        height: receipt.surface.height,
        channels: receipt.surface.channels,
        alphaMode: receipt.surface.alphaMode,
        colorSpace: receipt.surface.colorSpace,
        rgbaBytes: receipt.surface.rgbaBytes,
        sha256: receipt.surface.sha256,
      },
    }),
  });
  return validateReferenceMapCameraFrameEvidenceSemantics(completed);
}
