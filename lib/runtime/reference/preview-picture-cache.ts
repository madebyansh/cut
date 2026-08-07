import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { hash, stableJsonStringify } from "../../core/stable";
import type { CutAVIR, IRComposition, IRScene } from "../../language/ir";
import { createCutBuiltinImplementationIdentity } from "../../language/builtin-implementation-identity";
import { builtinPackages } from "../../language/packages";
import { addRational, compareRational, multiplyRational, rational, subtractRational, type Rational } from "../../language/rational";
import { ensureProjectWriteDirectory } from "../../project/write-boundary";
import { compositionNodeRoots, createIncrementalRenderPlan, finalizeGraphHashes, nodeReferences } from "../graph";
import { cutReferenceRuntimeIdentity } from "../../version";
import { convertReferenceColorSurface, type ReferenceColorProfile } from "./color-management";
import type { ReferenceVerifiedInputSession } from "./verified-input-session";
import type { CutReferenceBackendIdentity } from "./runtime-identity";
import {
  abortEncoderAndWait,
  finishEncoder,
  spawnBoundRawEncoder,
  spawnRawEncoder,
  writeFrame,
  type ReferenceMediaNativeProcessExecution,
} from "./ffmpeg";
import type { bindReferenceFfmpegExecutableToolchain } from "./audio-limiter-compatibility";
import { referenceSceneEncodingContract } from "./scene-encoding";
import { assertReferenceSceneArtifactContract } from "./render";
import {
  maximumLocalPaintSurfaceCacheBytes,
  maximumStaticMediaGradeCacheBytes,
  ReferenceLocalPaintSurfaceCache,
  ReferenceVisualRenderer,
} from "./visual";
import { validateReferencePrecompGraph } from "./precomp-config";
import {
  validateReferenceMediaCamera2DGraph,
} from "./media-camera2d";
import {
  referenceMediaProfileExecutionAuthority,
  type ReferenceMediaProfileExecutionAuthority,
} from "./media-profile-state";

export const referencePreviewPictureCacheAlgorithm = "cut-reference-preview-picture-range-cache-v2" as const;
const maximumManifestBytes = 64 * 1024;
const maximumArtifactBytes = 2_147_483_648;
export const referencePreviewPictureParallelLimits = Object.freeze({
  /**
   * More than one renderer is a measurement-only override until an exact
   * production range establishes a bounded native/process RSS ceiling. The
   * RGBA arithmetic below deliberately is not that authority.
   */
  maximumMeasurementRenderers: 2,
  productionWorkerThreads: 3,
  framesPerRendererChunk: 2,
  maximumBufferedFrames: 6,
  maximumBufferedRgbaBytes: 134_217_728,
  maximumMeasurementRgbaLowerBoundBytes: 536_870_912,
  maximumParallelRgbaLowerBoundBytes: 1_073_741_824,
  maximumProductionCanvasPixels: 2_073_600,
  maximumProcessRssBytes: 4_294_967_296,
  workerPrepareTimeoutMs: 120_000,
  workerChunkTimeoutMs: 120_000,
  workerCloseTimeoutMs: 30_000,
  workerLocalPaintCacheBytes: 192 * 1024 * 1024,
  workerStaticMediaGradeCacheBytes: maximumStaticMediaGradeCacheBytes,
  perRendererSurfaceCacheBytes: 8_388_608,
  maximumTemporalReachabilityVisits: 262_144,
});
const statefulPictureOps = new Set([
  "cut.visual.video",
  "cut.edit.clip",
  "cut.edit.picture_clip",
]);

type SceneSegment = Readonly<{
  scene: IRScene;
  key: string;
  firstFrame: number;
  endFrameExclusive: number;
  firstSceneFrame: number;
}>;

export type ReferencePreviewPictureCacheEvidence = Readonly<{
  format: "cut-reference-preview-picture-cache";
  version: 1;
  algorithm: typeof referencePreviewPictureCacheAlgorithm;
  status: "hit" | "miss" | "rebuilt";
  reason:
    | "CUT_PREVIEW_PICTURE_CACHE_HIT"
    | "CUT_PREVIEW_PICTURE_CACHE_COLD"
    | "CUT_PREVIEW_PICTURE_CACHE_CORRUPT";
  key: string;
  identity: Readonly<{
    runtime: string;
    backendIntegrity: string;
    toolchainIntegrity: string;
    selectedSceneKeys: readonly Readonly<{ id: string; key: string }>[];
    range: Readonly<{ firstFrame: number; endFrameExclusive: number; frames: number }>;
    sourceCanvas: Readonly<{ width: number; height: number }>;
    canvas: Readonly<{ width: number; height: number; resize: "none" | "lanczos3-v1" }>;
    fps: Rational;
    color: ReferenceColorProfile | "legacy";
    sceneEncoding: typeof referenceSceneEncodingContract;
  }>;
  artifact: Readonly<{
    locator: string;
    sha256: string;
    bytes: number;
    frames: number;
    width: number;
    height: number;
    verification: "sha256+bytes+h264-decoded-contract";
  }>;
  publication: "existing-valid" | "atomic-no-clobber";
}>;

type CacheEntry = Readonly<{
  format: "cut-reference-preview-picture-cache-entry";
  version: 1;
  algorithm: typeof referencePreviewPictureCacheAlgorithm;
  key: string;
  identity: ReferencePreviewPictureCacheEvidence["identity"];
  artifact: ReferencePreviewPictureCacheEvidence["artifact"];
}>;

export class ReferencePreviewPictureCacheError extends Error {
  constructor(
    readonly code:
      | "CUT_PREVIEW_PICTURE_CACHE_CONTRACT"
      | "CUT_PREVIEW_PICTURE_CACHE_PATH"
      | "CUT_PREVIEW_PICTURE_CACHE_PUBLICATION"
      | "CUT_PREVIEW_PICTURE_CACHE_NONDETERMINISM"
      | "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferencePreviewPictureCacheError";
  }
}

export type ReferencePreviewPictureTestHooks = Readonly<{
  requestedRenderers?: number;
  /** Private diagnostic only; production remains serial until exact subset evidence is accepted. */
  requestedWorkerThreads?: 1 | 3;
  /** Internal same-build exact cache A/B only; four bytes forces bypass. */
  staticMediaGradeCacheBytes?: number;
  /** Internal same-build copied-handoff/immutable-lease A/B only. */
  staticMediaGradeHandoffMode?: "copied" | "immutable-lease";
  /** Internal same-build exact private compositor A/B only. */
  privateStraightCompositeMode?: "automatic" | "forced-js-fast" | "forced-scalar";
  /** Internal same-build exact LocalSpace paint-support A/B only. */
  privateLocalPaintAlphaBoundsMode?: "automatic" | "forced-full-surface";
  /** Private measurement authority; production callers omit this surface. */
  nativeProcesses?: Readonly<{
    encoder: ReferenceMediaNativeProcessExecution;
    artifactProbe: () => ReferenceMediaNativeProcessExecution;
  }>;
  plan?: (plan: ReferencePreviewPictureParallelPlan) => void | Promise<void>;
  phase?: (event: Readonly<{
    phase: "prepare-start" | "prepare-end" | "picture-start" | "picture-end";
  }>) => void | Promise<void>;
  beforeFrame?: (event: Readonly<{
    rendererIndex: number;
    globalFrame: number;
    sceneId: string;
    sceneFrame: number;
  }>) => void | Promise<void>;
  afterFrame?: (event: Readonly<{
    rendererIndex: number;
    globalFrame: number;
    sceneId: string;
    sceneFrame: number;
  }>) => void | Promise<void>;
  staticMediaGradeCacheFrame?: (event: Readonly<{
    rendererIndex: number;
    globalFrame: number;
    sceneFrame: number;
    counts: Readonly<{
      hit: number;
      miss: number;
      bypassCapacity: number;
      bypassDynamic: number;
      residentCopies: number;
      residentCopyRgbaBytes: number;
      handoffCopies: number;
      handoffRgbaBytes: number;
      leaseHandoffs: number;
      leaseRgbaBytes: number;
    }>;
  }>) => void;
  privateStraightCompositeFrame?: (event: Readonly<{
    rendererIndex: number;
    globalFrame: number;
    sceneFrame: number;
    counts: Readonly<{
      mode: "automatic" | "forced-js-fast" | "forced-scalar" | "unobserved";
      executions: number;
      fastNormalStraightPixels: number;
      scalarPixels: number;
      quantizerBoundaryFallbacks: number;
      nativeExecutions: number;
      nativeFastNormalStraightPixels: number;
    }>;
  }>) => void;
  frameWritten?: (event: Readonly<{
    globalFrame: number;
    sceneId: string;
    sceneFrame: number;
  }>) => void | Promise<void>;
  rendererClosed?: (event: Readonly<{
    rendererIndex: number;
    status: "fulfilled" | "rejected";
  }>) => void | Promise<void>;
  workerFault?: Readonly<{
    workerIndex: number;
    phase:
      | "prepare-error" | "prepare-exit" | "chunk-error" | "chunk-hang"
      | "chunk-duplicate" | "chunk-reorder" | "chunk-extra" | "chunk-wrong-size"
      | "chunk-wrong-request" | "chunk-wrong-subject"
      | "chunk-cache-negative" | "chunk-cache-noninteger" | "chunk-cache-extra" | "chunk-cache-excessive"
      | "chunk-composite-mode" | "chunk-composite-noninteger" | "chunk-composite-extra" | "chunk-composite-relation"
      | "ready-duplicate" | "ready-late" | "closed-early" | "closed-duplicate"
      | "close-error" | "close-hang" | "close-no-receipt" | "close-nonzero";
    globalFrame?: number;
  }>;
  workerBootstrapMutation?:
    | "module-sha" | "ir" | "module-integrity" | "resource-sha"
    | "media-profile-authority" | "media-profile-authority-extra-field"
    | "media-profile-authority-omit-field" | "media-profile-authority-semantic-hash"
    | "media-profile-authority-missing-resource" | "media-profile-authority-duplicate-resource"
    | "media-profile-authority-reordered-resources" | "media-profile-authority-resource-digest"
    | "media-profile-authority-resource-selected" | "media-profile-authority-resource-authored-proxy";
  workerTimeouts?: Readonly<{ prepareMs?: number; chunkMs?: number; closeMs?: number }>;
  workerTerminated?: (event: Readonly<{
    workerIndex: number;
    reason: "abort" | "unconfirmed-close";
  }>) => void | Promise<void>;
  workersReady?: (event: Readonly<{
    resources: readonly Readonly<{ id: string; path: string; sha256: string }>[];
  }>) => void | Promise<void>;
  workerFailureObserved?: (event: Readonly<{
    workerIndex: number;
    message: string;
  }>) => void | Promise<void>;
  /** Private hostile-test witness emitted immediately before a chunk message. */
  workerChunkDispatched?: (event: Readonly<{
    rendererIndex: number;
    requestId: number;
    sceneId: string;
    firstGlobalFrame: number;
    firstSceneFrame: number;
    frameCount: number;
  }>) => void;
  /**
   * Private non-release phase instrumentation. Omitting this callback leaves
   * the worker protocol and renderer behavior unchanged.
   */
  performanceDiagnostic?: (event: ReferencePreviewPicturePerformanceDiagnosticEvent) => void;
}>;

export type ReferencePreviewPicturePerformanceDiagnosticEvent =
  | Readonly<{
    kind: "worker-ready";
    workerIndex: number;
    nativeConcurrency: number;
    bootstrapAuthenticationMs: number;
    rendererConstructionMs: number;
    rendererPrepareMs: number;
    workerActiveMs: number;
  }>
  | Readonly<{
    kind: "worker-chunk";
    workerIndex: number;
    requestId: number;
    sceneId: string;
    firstGlobalFrame: number;
    frameCount: number;
    nativeConcurrency: number;
    idleBeforeMs: number;
    resourceRevalidationMs: number;
    sceneFrameMs: number;
    resizeMs: number;
    colorMs: number;
    arrayBufferCopyMs: number;
    workerActiveMs: number;
    eventLoopIdleMs: number;
    eventLoopActiveMs: number;
    eventLoopUtilization: number;
    parentRoundTripMs: number;
    parentResponseValidationMs: number;
  }>
  | Readonly<{
    kind: "serial-frame";
    rendererIndex: number;
    globalFrame: number;
    sceneId: string;
    sceneFrame: number;
    sceneFrameMs: number;
    resizeMs: number;
    colorMs: number;
    frameActiveMs: number;
  }>
  | Readonly<{
    kind: "parent-wave";
    firstGlobalFrame: number;
    frameCount: number;
    workerWaitMs: number;
    orderedPublicationMs: number;
    encoderWriteMs: number;
  }>
  | Readonly<{
    kind: "parent-tail";
    workerCloseMs: number;
    encoderFinishMs: number;
    artifactVerificationMs: number;
  }>;

export type ReferencePreviewPictureParallelPlan = Readonly<{
  mode: "serial" | "ordered-parallel";
  reason:
    | "stateful-picture-context"
    | "production-serial-native-rss-unmeasured"
    | "production-worker-threads"
    | "worker-thread-measurement-override"
    | "insufficient-frames"
    | "measurement-override";
  performanceClaim: "INSUFFICIENT_FOR_CCH05" | "REQUIRES_EXACT_RANGE_MEASUREMENT";
  admissionScope: "rgba-only-lower-bound-not-total-process-memory" | "closed-rgba+node-process-rss-watchdog";
  nativePeakRss: "UNMEASURED" | "NODE_PROCESS_RSS_WATCHDOG_4_GIB_PROCESS_TREE_UNMEASURED";
  preparationScope: "root-eager+nested-lazy-on-first-active-frame" | "canonical-parent-plan+worker-closure-and-resource-revalidation";
  measurementOnly: boolean;
  rendererCount: number;
  framesPerRendererChunk: number;
  maximumBufferedFrames: number;
  frameRgbaBytes: number;
  maximumBufferedRgbaBytes: number;
  maximumStaticGradeHandoffRgbaBytes: number;
  maximumStaticGradeEventsPerFrame: number;
  perRendererRgbaLowerBoundBytes: number;
  aggregateRgbaLowerBoundBytes: number;
}>;

function exactRgbaBytes(width: number, height: number, label: string) {
  const bytes = BigInt(width) * BigInt(height) * 4n;
  if (bytes < 4n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
      `${label} has an unbounded RGBA byte count.`,
    );
  }
  return Number(bytes);
}

function later(left: Rational, right: Rational) {
  return compareRational(left, right) >= 0 ? left : right;
}

function earlier(left: Rational, right: Rational) {
  return compareRational(left, right) <= 0 ? left : right;
}

function previewIrValueContainsSignal(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if ("signal" in value || (value as { kind?: unknown }).kind === "signal-ref") return true;
  if (Array.isArray(value)) return value.some((item) => previewIrValueContainsSignal(item, seen));
  return Object.values(value).some((item) => previewIrValueContainsSignal(item, seen));
}

/**
 * Conservatively charge every isolated static-grade handoff reachable during
 * the selected parent interval. Sequential scenes use their maximum rather
 * than their sum; concurrently reachable branches and repeated Precomp
 * instances are summed. Oversized and signal-bearing grades cannot hit this
 * cache and are excluded.
 */
function maximumStaticGradeHandoffBytesForRendererTree(
  ir: CutAVIR,
  root: IRComposition,
  firstFrame: number,
  endFrameExclusive: number,
) {
  const precomp = validateReferencePrecompGraph(ir, root);
  const compositionById = new Map(ir.compositions.map((candidate) => [candidate.id, candidate]));
  const eligibleByComposition = new Map<string, ReadonlyMap<string, bigint>>();
  const localNodeIds = (composition: IRComposition) => {
    const roots = compositionNodeRoots(ir, composition.id)?.roots ?? [];
    const pending = [...roots], selected = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (selected.has(id)) continue;
      selected.add(id);
      const node = ir.nodes[id];
      if (node) pending.push(...node.children, ...nodeReferences(node));
    }
    return selected;
  };
  const eligiblePlans = (composition: IRComposition) => {
    const existing = eligibleByComposition.get(composition.id);
    if (existing) return existing;
    const local = localNodeIds(composition);
    const result = new Map<string, bigint>();
    for (const plan of validateReferenceMediaCamera2DGraph(ir, composition, local).values()) {
      if (plan.leafKind !== "image" || plan.gradeNodeId === undefined || plan.nativeEffectChain !== undefined) continue;
      const grade = ir.nodes[plan.gradeNodeId];
      const handoff = BigInt(plan.decodedCrop.pixels) * 4n;
      if (!grade || handoff > BigInt(referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes)
        || previewIrValueContainsSignal(grade.inputs)
        || previewIrValueContainsSignal(grade.properties)) continue;
      result.set(plan.cameraNodeId, handoff);
    }
    eligibleByComposition.set(composition.id, result);
    return result;
  };

  let visits = 0;
  const activePath = new Set<string>();
  const visitNode = (
    composition: IRComposition,
    nodeId: string,
    selectedStart: Rational,
    selectedEnd: Rational,
    visited: Set<string>,
  ): Readonly<{ bytes: bigint; events: number }> => {
    visits += 1;
    if (visits > referencePreviewPictureParallelLimits.maximumTemporalReachabilityVisits) {
      throw new ReferencePreviewPictureCacheError(
        "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
        `selected-range static-grade handoff accounting exceeds ${referencePreviewPictureParallelLimits.maximumTemporalReachabilityVisits} bounded node/interval visits.`,
      );
    }
    const node = ir.nodes[nodeId];
    if (!node) {
      throw new ReferencePreviewPictureCacheError(
        "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
        `selected-range static-grade handoff accounting references missing node ${nodeId}.`,
      );
    }
    const nodeStart = later(selectedStart, node.interval.start);
    const nodeEnd = earlier(selectedEnd, addRational(node.interval.start, node.interval.duration));
    if (compareRational(nodeStart, nodeEnd) >= 0 || visited.has(node.id)) return Object.freeze({ bytes: 0n, events: 0 });
    visited.add(node.id);

    const cameraBytes = eligiblePlans(composition).get(node.id);
    if (cameraBytes !== undefined) return Object.freeze({ bytes: cameraBytes, events: 1 });

    const nested = precomp.configs.get(node.id);
    if (nested) {
      const source = compositionById.get(nested.sourceCompositionId);
      if (!source) {
        throw new ReferencePreviewPictureCacheError(
          "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
          `selected-range static-grade handoff accounting cannot resolve nested composition ${nested.sourceCompositionId}.`,
        );
      }
      const sourceStart = addRational(nested.sourceRange.start, subtractRational(nodeStart, node.interval.start));
      const sourceEnd = addRational(nested.sourceRange.start, subtractRational(nodeEnd, node.interval.start));
      const pathKey = `${composition.id}\0${node.id}\0${source.id}`;
      if (activePath.has(pathKey)) {
        throw new ReferencePreviewPictureCacheError(
          "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
          `selected-range static-grade handoff accounting encountered nested composition cycle ${pathKey}.`,
        );
      }
      activePath.add(pathKey);
      try {
        let maximumBytes = 0n, maximumEvents = 0;
        for (const sourceSceneId of source.sceneIds) {
          const sourceScene = ir.scenes[sourceSceneId];
          if (!sourceScene) continue;
          const overlapStart = later(sourceStart, sourceScene.start);
          const overlapEnd = earlier(sourceEnd, addRational(sourceScene.start, sourceScene.duration));
          if (compareRational(overlapStart, overlapEnd) >= 0) continue;
          const localStart = subtractRational(overlapStart, sourceScene.start);
          const localEnd = subtractRational(overlapEnd, sourceScene.start);
          const nestedVisited = new Set<string>();
          let sceneBytes = 0n, sceneEvents = 0;
          for (const item of sourceScene.items) {
            if (item.domain !== "visual" && item.domain !== "av") continue;
            const nestedResult = visitNode(source, item.id, localStart, localEnd, nestedVisited);
            sceneBytes += nestedResult.bytes;
            sceneEvents += nestedResult.events;
          }
          if (sceneBytes > maximumBytes) maximumBytes = sceneBytes;
          if (sceneEvents > maximumEvents) maximumEvents = sceneEvents;
        }
        return Object.freeze({ bytes: maximumBytes, events: maximumEvents });
      } finally {
        activePath.delete(pathKey);
      }
    }

    let bytes = 0n, events = 0;
    for (const referenced of nodeReferences(node)) {
      const child = visitNode(composition, referenced, nodeStart, nodeEnd, visited);
      bytes += child.bytes;
      events += child.events;
    }
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ReferencePreviewPictureCacheError(
        "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
        "static-grade handoff RGBA accounting exceeds the safe-integer envelope.",
      );
    }
    return Object.freeze({ bytes, events });
  };

  let maximumBytes = 0n, maximumEvents = 0;
  for (let frame = firstFrame; frame < endFrameExclusive;) {
    const { scene, sceneStart } = sceneAtFrame(ir, root, frame);
    const sceneFrames = multiplyRational(scene.duration, root.fps);
    if (sceneFrames.denominator !== "1") {
      throw new ReferencePreviewPictureCacheError(
        "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
        `scene ${JSON.stringify(scene.name)} duration does not land on the exact composition frame grid.`,
      );
    }
    const sceneEndFrame = sceneStart + Number(sceneFrames.numerator);
    const selectedEndFrame = Math.min(sceneEndFrame, endFrameExclusive);
    const localStart = rational(
      BigInt(frame - sceneStart) * BigInt(root.fps.denominator),
      root.fps.numerator,
    );
    const localEnd = rational(
      BigInt(selectedEndFrame - sceneStart) * BigInt(root.fps.denominator),
      root.fps.numerator,
    );
    const visited = new Set<string>();
    let sceneBytes = 0n, sceneEvents = 0;
    for (const item of scene.items) {
      if (item.domain !== "visual" && item.domain !== "av") continue;
      const child = visitNode(root, item.id, localStart, localEnd, visited);
      sceneBytes += child.bytes;
      sceneEvents += child.events;
    }
    if (sceneBytes > maximumBytes) maximumBytes = sceneBytes;
    if (sceneEvents > maximumEvents) maximumEvents = sceneEvents;
    frame = selectedEndFrame;
  }
  if (maximumBytes > BigInt(Number.MAX_SAFE_INTEGER)
    || !Number.isSafeInteger(maximumEvents)
    || maximumEvents > referencePreviewPictureParallelLimits.maximumTemporalReachabilityVisits) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
      "static-grade handoff RGBA accounting exceeds the safe-integer envelope.",
    );
  }
  return Object.freeze({ bytes: Number(maximumBytes), events: maximumEvents });
}

/**
 * Video decoders are mutable sequential readers. Parallel admission therefore
 * follows only the exact selected parent interval into active node intervals
 * and active Precomp/NestedSequence source intervals. An inactive video in a
 * different scene or a non-overlapping nested instance cannot serialize an
 * otherwise stateless review range; an overlapping one always does.
 */
function hasStatefulPictureContext(
  ir: CutAVIR,
  composition: IRComposition,
  firstFrame: number,
  endFrameExclusive: number,
) {
  const precomp = validateReferencePrecompGraph(ir, composition).configs;
  let visits = 0;
  const activePath = new Set<string>();
  const compositionById = new Map(ir.compositions.map((candidate) => [candidate.id, candidate]));

  const visitNode = (
    owner: IRComposition,
    nodeId: string,
    selectedStart: Rational,
    selectedEnd: Rational,
  ): boolean => {
    visits += 1;
    if (visits > referencePreviewPictureParallelLimits.maximumTemporalReachabilityVisits) {
      throw new ReferencePreviewPictureCacheError(
        "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
        `selected-range picture-state reachability exceeds ${referencePreviewPictureParallelLimits.maximumTemporalReachabilityVisits} bounded node/interval visits.`,
      );
    }
    const node = ir.nodes[nodeId];
    if (!node) {
      throw new ReferencePreviewPictureCacheError(
        "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
        `selected-range picture-state reachability references missing node ${nodeId}.`,
      );
    }
    const nodeStart = later(selectedStart, node.interval.start);
    const nodeEnd = earlier(selectedEnd, addRational(node.interval.start, node.interval.duration));
    if (compareRational(nodeStart, nodeEnd) >= 0) return false;
    if (statefulPictureOps.has(node.op)) return true;

    const nested = precomp.get(node.id);
    if (nested) {
      const source = compositionById.get(nested.sourceCompositionId);
      if (!source) {
        throw new ReferencePreviewPictureCacheError(
          "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
          `selected-range picture-state reachability cannot resolve nested composition ${nested.sourceCompositionId}.`,
        );
      }
      const sourceOffset = nested.sourceRange.start;
      const sourceStart = addRational(sourceOffset, subtractRational(nodeStart, node.interval.start));
      const sourceEnd = addRational(sourceOffset, subtractRational(nodeEnd, node.interval.start));
      const pathKey = `${owner.id}\0${node.id}\0${source.id}`;
      if (activePath.has(pathKey)) {
        throw new ReferencePreviewPictureCacheError(
          "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
          `selected-range picture-state reachability encountered nested composition cycle ${pathKey}.`,
        );
      }
      activePath.add(pathKey);
      try {
        for (const sourceSceneId of source.sceneIds) {
          const sourceScene = ir.scenes[sourceSceneId];
          if (!sourceScene) continue;
          const overlapStart = later(sourceStart, sourceScene.start);
          const overlapEnd = earlier(sourceEnd, addRational(sourceScene.start, sourceScene.duration));
          if (compareRational(overlapStart, overlapEnd) >= 0) continue;
          const localStart = subtractRational(overlapStart, sourceScene.start);
          const localEnd = subtractRational(overlapEnd, sourceScene.start);
          for (const item of sourceScene.items) {
            if ((item.domain === "visual" || item.domain === "av")
              && visitNode(source, item.id, localStart, localEnd)) return true;
          }
        }
      } finally {
        activePath.delete(pathKey);
      }
      return false;
    }

    for (const referenced of nodeReferences(node)) {
      if (visitNode(owner, referenced, nodeStart, nodeEnd)) return true;
    }
    return false;
  };

  for (let frame = firstFrame; frame < endFrameExclusive;) {
    const { scene, sceneStart } = sceneAtFrame(ir, composition, frame);
    const sceneFrames = multiplyRational(scene.duration, composition.fps);
    if (sceneFrames.denominator !== "1") {
      throw new ReferencePreviewPictureCacheError(
        "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
        `scene ${JSON.stringify(scene.name)} duration does not land on the exact composition frame grid.`,
      );
    }
    const sceneEndFrame = sceneStart + Number(sceneFrames.numerator);
    const selectedEndFrame = Math.min(sceneEndFrame, endFrameExclusive);
    const localStart = rational(
      BigInt(frame - sceneStart) * BigInt(composition.fps.denominator),
      composition.fps.numerator,
    );
    const localEnd = rational(
      BigInt(selectedEndFrame - sceneStart) * BigInt(composition.fps.denominator),
      composition.fps.numerator,
    );
    for (const item of scene.items) {
      if ((item.domain === "visual" || item.domain === "av")
        && visitNode(composition, item.id, localStart, localEnd)) return true;
    }
    frame = selectedEndFrame;
  }
  return false;
}

function requestedRendererCount(value: unknown) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > referencePreviewPictureParallelLimits.maximumMeasurementRenderers) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
      `measurement-only renderer count must be from 1 through ${referencePreviewPictureParallelLimits.maximumMeasurementRenderers}.`,
    );
  }
  return value as number;
}

function previewPictureParallelPlan(input: Readonly<{
  ir: CutAVIR;
  composition: IRComposition;
  firstFrame: number;
  endFrameExclusive: number;
  width: number;
  height: number;
  requestedRenderers?: number;
  requestedWorkerThreads?: number;
}>): ReferencePreviewPictureParallelPlan {
  const frames = input.endFrameExclusive - input.firstFrame;
  if (!Number.isSafeInteger(input.firstFrame) || !Number.isSafeInteger(input.endFrameExclusive)
    || input.firstFrame < 0 || frames < 1) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
      "parallel picture admission requires one positive exact half-open frame range.",
    );
  }
  const frameRgbaBytes = exactRgbaBytes(input.width, input.height, "preview destination");
  const sourceRgbaBytes = exactRgbaBytes(input.composition.width, input.composition.height, "authored canvas");
  const staticGradeReachability = maximumStaticGradeHandoffBytesForRendererTree(
    input.ir,
    input.composition,
    input.firstFrame,
    input.endFrameExclusive,
  );
  const maximumStaticGradeHandoffRgbaBytes = staticGradeReachability.bytes;
  const maximumStaticGradeEventsPerFrame = staticGradeReachability.events;
  // Each pool renderer receives a lower eviction budget for four independent
  // immutable typography/evidence caches. One surface may exceed that budget,
  // so account max(limit, source canvas) for each cache. The 256 MiB immutable
  // local-paint cache is shared across the pool and charged once below.
  const perRendererPersistentCacheBytes =
    4 * Math.max(referencePreviewPictureParallelLimits.perRendererSurfaceCacheBytes, sourceRgbaBytes)
    + referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes;
  // One exact static-grade cache hit owns a cache-private resident surface and
  // an isolated decoded-crop-sized consumer handoff. Derive that handoff from
  // the admitted graph rather than assuming it is no larger than the authored
  // canvas. Native decoder/library/process memory remains outside this
  // deliberately named RGBA lower bound and is enforced by the RSS watchdog.
  const perRendererRgbaLowerBoundBytes =
    perRendererPersistentCacheBytes + sourceRgbaBytes
    + maximumStaticGradeHandoffRgbaBytes + frameRgbaBytes * 2;
  if (!Number.isSafeInteger(perRendererRgbaLowerBoundBytes)) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
      "preview renderer RGBA lower-bound accounting exceeds the safe-integer envelope.",
    );
  }
  const framesPerRendererChunk = referencePreviewPictureParallelLimits.framesPerRendererChunk;
  const usefulRenderers = Math.max(1, Math.min(
    referencePreviewPictureParallelLimits.productionWorkerThreads,
    Math.ceil(frames / framesPerRendererChunk),
  ));
  const measurementMemoryRenderers = Math.max(1, Math.min(
    referencePreviewPictureParallelLimits.maximumMeasurementRenderers,
    Math.floor(referencePreviewPictureParallelLimits.maximumBufferedRgbaBytes / (frameRgbaBytes * framesPerRendererChunk)),
    Math.floor((referencePreviewPictureParallelLimits.maximumMeasurementRgbaLowerBoundBytes
      - maximumLocalPaintSurfaceCacheBytes)
      / (perRendererRgbaLowerBoundBytes + frameRgbaBytes * framesPerRendererChunk)),
  ));
  const stateful = hasStatefulPictureContext(
    input.ir,
    input.composition,
    input.firstFrame,
    input.endFrameExclusive,
  );
  const admittedMeasurementRenderers =
    stateful ? 1 : Math.max(1, Math.min(usefulRenderers, measurementMemoryRenderers));
  const requested = requestedRendererCount(input.requestedRenderers);
  if (input.requestedRenderers !== undefined && input.requestedWorkerThreads !== undefined) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
      "in-process and worker-thread picture diagnostics are mutually exclusive.",
    );
  }
  const requestedWorkers = input.requestedWorkerThreads === undefined
    ? undefined
    : input.requestedWorkerThreads === 1
        || input.requestedWorkerThreads === referencePreviewPictureParallelLimits.productionWorkerThreads
      ? input.requestedWorkerThreads
      : (() => { throw new ReferencePreviewPictureCacheError(
        "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
        `worker-thread diagnostic requires 1 or ${referencePreviewPictureParallelLimits.productionWorkerThreads} workers.`,
      ); })();
  if (requested !== undefined && requested > admittedMeasurementRenderers) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
      stateful
        ? "stateful Video/Clip/PictureClip picture contexts are deliberately serial until independent decoder chunk-boundary parity is proved."
        : `requested ${requested} renderers exceed the ${admittedMeasurementRenderers}-renderer RGBA-only measurement admission.`,
    );
  }
  const productionWorkerAdmitted = requestedWorkers !== undefined
    && !stateful
    && frames >= requestedWorkers * framesPerRendererChunk
    && input.width * input.height <= referencePreviewPictureParallelLimits.maximumProductionCanvasPixels
    && input.composition.width * input.composition.height <= referencePreviewPictureParallelLimits.maximumProductionCanvasPixels
    && requestedWorkers
      * (referencePreviewPictureParallelLimits.workerLocalPaintCacheBytes
        + perRendererRgbaLowerBoundBytes
        + frameRgbaBytes * framesPerRendererChunk)
      <= referencePreviewPictureParallelLimits.maximumParallelRgbaLowerBoundBytes;
  if (requestedWorkers !== undefined && !productionWorkerAdmitted) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
      stateful
        ? "stateful Video/Clip/PictureClip picture contexts are deliberately serial; worker threads cannot bypass decoder state."
        : "worker-thread diagnostic exceeds the closed frame/canvas/RGBA admission.",
    );
  }
  const rendererCount = requestedWorkers ?? requested ?? 1;
  const maximumBufferedFrames = rendererCount * framesPerRendererChunk;
  const maximumBufferedRgbaBytes = maximumBufferedFrames * frameRgbaBytes;
  const aggregateRgbaLowerBoundBytes =
    (requestedWorkers !== undefined
      ? rendererCount * referencePreviewPictureParallelLimits.workerLocalPaintCacheBytes
      : maximumLocalPaintSurfaceCacheBytes)
    + rendererCount * (perRendererRgbaLowerBoundBytes + frameRgbaBytes * framesPerRendererChunk);
  if (!Number.isSafeInteger(maximumBufferedRgbaBytes)
    || !Number.isSafeInteger(aggregateRgbaLowerBoundBytes)
    || maximumBufferedFrames > referencePreviewPictureParallelLimits.maximumBufferedFrames
    || maximumBufferedRgbaBytes > referencePreviewPictureParallelLimits.maximumBufferedRgbaBytes
    || (rendererCount > 1
      && aggregateRgbaLowerBoundBytes > referencePreviewPictureParallelLimits.maximumParallelRgbaLowerBoundBytes)) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_RESOURCE_LIMIT",
      "ordered preview frame measurement exceeds its closed RGBA-only lower-bound admission.",
    );
  }
  const reason = stateful
    ? "stateful-picture-context" as const
    : requestedWorkers !== undefined
      ? "worker-thread-measurement-override" as const
    : rendererCount === 1 && usefulRenderers === 1
      ? "insufficient-frames" as const
      : requested === undefined
        ? "production-serial-native-rss-unmeasured" as const
        : "measurement-override" as const;
  return Object.freeze({
    mode: rendererCount === 1 ? "serial" : "ordered-parallel",
    reason,
    performanceClaim: stateful
      ? "INSUFFICIENT_FOR_CCH05"
      : "REQUIRES_EXACT_RANGE_MEASUREMENT",
    admissionScope: requestedWorkers !== undefined
      ? "closed-rgba+node-process-rss-watchdog"
      : "rgba-only-lower-bound-not-total-process-memory",
    nativePeakRss: requestedWorkers !== undefined
      ? "NODE_PROCESS_RSS_WATCHDOG_4_GIB_PROCESS_TREE_UNMEASURED"
      : "UNMEASURED",
    preparationScope: requestedWorkers !== undefined
      ? "canonical-parent-plan+worker-closure-and-resource-revalidation"
      : "root-eager+nested-lazy-on-first-active-frame",
    measurementOnly: requested !== undefined || requestedWorkers !== undefined,
    rendererCount,
    framesPerRendererChunk,
    maximumBufferedFrames,
    frameRgbaBytes,
    maximumBufferedRgbaBytes,
    maximumStaticGradeHandoffRgbaBytes,
    maximumStaticGradeEventsPerFrame,
    perRendererRgbaLowerBoundBytes,
    aggregateRgbaLowerBoundBytes,
  });
}

export function referencePreviewPictureParallelPlanForTest(input: Readonly<{
  ir: CutAVIR;
  composition: IRComposition;
  firstFrame?: number;
  endFrameExclusive: number;
  width: number;
  height: number;
  requestedRenderers?: number;
  requestedWorkerThreads?: 1 | 3;
}>) {
  return previewPictureParallelPlan({
    ...input,
    firstFrame: input.firstFrame ?? 0,
  });
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function sha256(path: string) {
  return new Promise<string>((accept, reject) => {
    const digest = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => digest.update(chunk))
      .on("error", reject)
      .on("end", () => accept(digest.digest("hex")));
  });
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sceneStartFrame(composition: IRComposition, scene: IRScene) {
  const exact = multiplyRational(scene.start, composition.fps);
  if (exact.denominator !== "1") {
    throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_CONTRACT", `scene ${JSON.stringify(scene.name)} does not start on the exact composition frame grid.`);
  }
  const value = Number(exact.numerator);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_CONTRACT", `scene ${JSON.stringify(scene.name)} has an unbounded frame start.`);
  }
  return value;
}

function sceneAtFrame(ir: CutAVIR, composition: IRComposition, frame: number) {
  const time = rational(BigInt(frame) * BigInt(composition.fps.denominator), composition.fps.numerator);
  const scene = composition.sceneIds
    .map((id) => ir.scenes[id])
    .find((candidate) => candidate
      && compareRational(time, candidate.start) >= 0
      && compareRational(time, addRational(candidate.start, candidate.duration)) < 0);
  if (!scene) {
    throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_CONTRACT", `frame ${frame} has no authored scene in composition ${JSON.stringify(composition.name)}.`);
  }
  return { scene, sceneStart: sceneStartFrame(composition, scene) };
}

function selectedSegments(
  ir: CutAVIR,
  composition: IRComposition,
  firstFrame: number,
  endFrameExclusive: number,
  sceneKeys: ReadonlyMap<string, string>,
) {
  const segments: SceneSegment[] = [];
  for (let frame = firstFrame; frame < endFrameExclusive;) {
    const { scene, sceneStart } = sceneAtFrame(ir, composition, frame);
    const duration = multiplyRational(scene.duration, composition.fps);
    if (duration.denominator !== "1") {
      throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_CONTRACT", `scene ${JSON.stringify(scene.name)} duration does not land on the exact composition frame grid.`);
    }
    const sceneEnd = sceneStart + Number(duration.numerator);
    const end = Math.min(endFrameExclusive, sceneEnd), key = sceneKeys.get(scene.id);
    if (!key) {
      throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_CONTRACT", `scene ${JSON.stringify(scene.name)} has no picture cache identity.`);
    }
    segments.push(Object.freeze({
      scene,
      key,
      firstFrame: frame,
      endFrameExclusive: end,
      firstSceneFrame: frame - sceneStart,
    }));
    frame = end;
  }
  return Object.freeze(segments);
}

function entryIdentity(value: Readonly<{
  runtime: string;
  backendIntegrity: string;
  toolchainIntegrity: string;
  segments: readonly SceneSegment[];
  firstFrame: number;
  endFrameExclusive: number;
  composition: IRComposition;
  width: number;
  height: number;
  color: ReferenceColorProfile | "legacy";
}>) {
  const selectedSceneKeys = Object.freeze(value.segments.map((segment) => Object.freeze({ id: segment.scene.id, key: segment.key })));
  return Object.freeze({
    runtime: value.runtime,
    backendIntegrity: value.backendIntegrity,
    toolchainIntegrity: value.toolchainIntegrity,
    selectedSceneKeys,
    range: Object.freeze({
      firstFrame: value.firstFrame,
      endFrameExclusive: value.endFrameExclusive,
      frames: value.endFrameExclusive - value.firstFrame,
    }),
    sourceCanvas: Object.freeze({ width: value.composition.width, height: value.composition.height }),
    canvas: Object.freeze({
      width: value.width,
      height: value.height,
      resize: value.width === value.composition.width ? "none" as const : "lanczos3-v1" as const,
    }),
    fps: Object.freeze({ ...value.composition.fps }),
    color: value.color,
    sceneEncoding: referenceSceneEncodingContract,
  });
}

function cacheKey(identity: ReturnType<typeof entryIdentity>) {
  return hash({
    format: "cut-reference-preview-picture-cache-key",
    version: 1,
    algorithm: referencePreviewPictureCacheAlgorithm,
    identity,
  });
}

async function boundedEntry(path: string) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximumManifestBytes) return undefined;
    const bytes = await readFile(path);
    if (bytes.byteLength !== metadata.size) return undefined;
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    return plain(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sameEntryIdentity(value: unknown, key: string, identity: ReturnType<typeof entryIdentity>): value is CacheEntry {
  if (!plain(value)
    || !exactKeys(value, ["format", "version", "algorithm", "key", "identity", "artifact"])
    || value.format !== "cut-reference-preview-picture-cache-entry"
    || value.version !== 1
    || value.algorithm !== referencePreviewPictureCacheAlgorithm
    || value.key !== key
    || stableJsonStringify(value.identity) !== stableJsonStringify(identity)
    || !plain(value.artifact)
    || !exactKeys(value.artifact, ["locator", "sha256", "bytes", "frames", "width", "height", "verification"])
    || typeof value.artifact.locator !== "string"
    || !/^\.cut\/cache\/reference\/preview-picture\/blobs\/[a-f0-9]{64}\.mp4$/u.test(value.artifact.locator)
    || typeof value.artifact.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.artifact.sha256)
    || basename(value.artifact.locator) !== `${value.artifact.sha256}.mp4`
    || !Number.isSafeInteger(value.artifact.bytes)
    || Number(value.artifact.bytes) < 1
    || Number(value.artifact.bytes) > maximumArtifactBytes
    || value.artifact.frames !== identity.range.frames
    || value.artifact.width !== identity.canvas.width
    || value.artifact.height !== identity.canvas.height
    || value.artifact.verification !== "sha256+bytes+h264-decoded-contract") return false;
  return true;
}

function artifactExpectation(identity: ReturnType<typeof entryIdentity>, key: string) {
  return {
    key,
    frames: identity.range.frames,
    width: identity.canvas.width,
    height: identity.canvas.height,
    fps: identity.fps,
    runtime: identity.runtime,
    backendIntegrity: identity.backendIntegrity,
    toolchainIntegrity: identity.toolchainIntegrity,
    color: identity.color,
  } as const;
}

async function validArtifact(
  projectRoot: string,
  entry: CacheEntry,
  artifactProbe?: () => ReferenceMediaNativeProcessExecution,
) {
  const path = resolve(projectRoot, ...entry.artifact.locator.split("/"));
  if (relative(resolve(projectRoot), path).split(sep).includes("..")) return undefined;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== entry.artifact.bytes) return undefined;
    if (await sha256(path) !== entry.artifact.sha256) return undefined;
    await assertReferenceSceneArtifactContract(path, artifactExpectation(entry.identity, entry.key), artifactProbe?.());
    return path;
  } catch {
    return undefined;
  }
}

async function quarantine(path: string) {
  const candidate = resolve(`${path}.corrupt-${process.pid}-${randomUUID()}`);
  try {
    await rename(path, candidate);
    return candidate;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_PUBLICATION", `cannot quarantine an invalid cache leaf ${JSON.stringify(basename(path))} (${errorCode(error) ?? "UNKNOWN"}).`);
  }
}

async function publishLinkNoClobber(staged: string, destination: string, validExisting: () => Promise<boolean>) {
  try {
    await link(staged, destination);
    return "published" as const;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_PUBLICATION", `cannot publish immutable cache leaf ${JSON.stringify(basename(destination))} (${errorCode(error) ?? "UNKNOWN"}).`);
    }
  }
  if (await validExisting()) return "existing" as const;
  const quarantined = await quarantine(destination);
  try {
    await link(staged, destination);
    return "published" as const;
  } catch (error) {
    if (errorCode(error) === "EEXIST" && await validExisting()) return "existing" as const;
    throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_PUBLICATION", `cannot republish immutable cache leaf ${JSON.stringify(basename(destination))} (${errorCode(error) ?? "UNKNOWN"}).`);
  } finally {
    if (quarantined) await rm(quarantined, { force: true }).catch(() => undefined);
  }
}

type PictureToolchain = Awaited<ReturnType<typeof bindReferenceFfmpegExecutableToolchain>>;

type WorkerChunk = Readonly<{
  rendererIndex: number;
  sceneId: string;
  firstFrame: number;
  endFrameExclusive: number;
  firstSceneFrame: number;
}>;

type WorkerFrame = Readonly<{
  surface: Buffer;
  globalFrame: number;
  sceneFrame: number;
  staticGradeCache: Readonly<{
    hit: number;
    miss: number;
    bypassCapacity: number;
    bypassDynamic: number;
    residentCopies: number;
    residentCopyRgbaBytes: number;
    handoffCopies: number;
    handoffRgbaBytes: number;
    leaseHandoffs: number;
    leaseRgbaBytes: number;
  }>;
  privateStraightComposite: Readonly<{
    mode: "automatic" | "forced-js-fast" | "forced-scalar" | "unobserved";
    executions: number;
    fastNormalStraightPixels: number;
    scalarPixels: number;
    quantizerBoundaryFallbacks: number;
    nativeExecutions: number;
    nativeFastNormalStraightPixels: number;
  }>;
}>;

type WorkerPending = {
  accept: (frames: readonly WorkerFrame[]) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
  chunk: WorkerChunk;
  dispatchedAtMs: number;
};

type WorkerState = {
  index: number;
  worker: Worker;
  ready: Promise<void>;
  acceptReady: () => void;
  rejectReady: (error: unknown) => void;
  readyReceived: boolean;
  pending: Map<number, WorkerPending>;
  closed: boolean;
  closeRequested: boolean;
  exit: Promise<number>;
  acceptExit: (code: number) => void;
};

function workerFailure(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
  return new ReferencePreviewPictureCacheError(
    "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
    `isolated picture worker failed closed (${detail}).`,
  );
}

function diagnosticNumber(value: unknown, label: string, maximum = 3_600_000) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw workerFailure(`worker performance diagnostic ${label} is outside its bounded finite range`);
  }
  return value;
}

function workerReadyDiagnostic(value: unknown) {
  if (!value || typeof value !== "object"
    || Object.keys(value).sort().join(",")
      !== "bootstrapAuthenticationMs,nativeConcurrency,rendererConstructionMs,rendererPrepareMs,workerActiveMs") {
    throw workerFailure("worker emitted a malformed ready performance diagnostic");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.nativeConcurrency)
    || (candidate.nativeConcurrency as number) < 1
    || (candidate.nativeConcurrency as number) > 1_024) {
    throw workerFailure("worker ready diagnostic changed native concurrency authority");
  }
  return Object.freeze({
    nativeConcurrency: candidate.nativeConcurrency as number,
    bootstrapAuthenticationMs: diagnosticNumber(candidate.bootstrapAuthenticationMs, "bootstrap authentication"),
    rendererConstructionMs: diagnosticNumber(candidate.rendererConstructionMs, "renderer construction"),
    rendererPrepareMs: diagnosticNumber(candidate.rendererPrepareMs, "renderer preparation"),
    workerActiveMs: diagnosticNumber(candidate.workerActiveMs, "worker preparation active"),
  });
}

function workerChunkDiagnostic(value: unknown) {
  if (!value || typeof value !== "object"
    || Object.keys(value).sort().join(",")
      !== "arrayBufferCopyMs,colorMs,eventLoopActiveMs,eventLoopIdleMs,eventLoopUtilization,idleBeforeMs,nativeConcurrency,resizeMs,resourceRevalidationMs,sceneFrameMs,workerActiveMs") {
    throw workerFailure("worker emitted a malformed chunk performance diagnostic");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.nativeConcurrency)
    || (candidate.nativeConcurrency as number) < 1
    || (candidate.nativeConcurrency as number) > 1_024) {
    throw workerFailure("worker chunk diagnostic changed native concurrency authority");
  }
  return Object.freeze({
    nativeConcurrency: candidate.nativeConcurrency as number,
    idleBeforeMs: diagnosticNumber(candidate.idleBeforeMs, "idle-before"),
    resourceRevalidationMs: diagnosticNumber(candidate.resourceRevalidationMs, "resource revalidation"),
    sceneFrameMs: diagnosticNumber(candidate.sceneFrameMs, "scene frame"),
    resizeMs: diagnosticNumber(candidate.resizeMs, "resize"),
    colorMs: diagnosticNumber(candidate.colorMs, "color"),
    arrayBufferCopyMs: diagnosticNumber(candidate.arrayBufferCopyMs, "array-buffer copy"),
    workerActiveMs: diagnosticNumber(candidate.workerActiveMs, "worker active"),
    eventLoopIdleMs: diagnosticNumber(candidate.eventLoopIdleMs, "event-loop idle"),
    eventLoopActiveMs: diagnosticNumber(candidate.eventLoopActiveMs, "event-loop active"),
    eventLoopUtilization: diagnosticNumber(candidate.eventLoopUtilization, "event-loop utilization", 1),
  });
}

function timeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_accept, reject) => {
      timer = setTimeout(() => reject(workerFailure(`${label} exceeded ${milliseconds}ms`)), milliseconds);
      timer.unref();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

class ReferencePreviewPictureWorkerPool {
  private requestId = 0;
  private readonly states: WorkerState[];
  private rssTimer?: NodeJS.Timeout;
  private failed?: unknown;
  private aborting?: Promise<void>;
  private readonly prepareTimeoutMs: number;
  private readonly chunkTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly hooks?: ReferencePreviewPictureTestHooks;

  private constructor(
    states: WorkerState[],
    timeouts: Readonly<{ prepareMs: number; chunkMs: number; closeMs: number }>,
    hooks?: ReferencePreviewPictureTestHooks,
  ) {
    this.states = states;
    this.prepareTimeoutMs = timeouts.prepareMs;
    this.chunkTimeoutMs = timeouts.chunkMs;
    this.closeTimeoutMs = timeouts.closeMs;
    this.hooks = hooks;
  }

  static async create(input: Readonly<{
    ir: CutAVIR;
    composition: IRComposition;
    projectRoot: string;
    cacheRoot: string;
    verifiedResourcePath: ReferenceVerifiedInputSession["pathFor"];
    backendIntegrity: string;
    width: number;
    height: number;
    color: ReferenceColorProfile | "legacy";
    workerCount: 1 | 3;
    maximumStaticGradeEventsPerFrame: number;
    hooks?: ReferencePreviewPictureTestHooks;
  }>) {
    const workerModule = resolve(__dirname, "preview-picture-worker.js");
    const workerModuleSha256 = createHash("sha256").update(await readFile(workerModule)).digest("hex");
    const resources = await Promise.all(Object.values(input.ir.resources).map(async (resource) => {
      if (resource.state !== "locked" || !resource.sha256) {
        throw workerFailure(`resource ${resource.id} is not locked before worker admission`);
      }
      const path = input.verifiedResourcePath(resource.id);
      const metadata = await lstat(path, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw workerFailure(`verified resource ${resource.id} is not a regular immutable snapshot`);
      }
      return Object.freeze({
        id: resource.id,
        path,
        physicalPath: await realpath(path),
        bytes: Number(metadata.size),
        sha256: resource.sha256,
        identity: Object.freeze({
          dev: String(metadata.dev),
          ino: String(metadata.ino),
          size: String(metadata.size),
          mtimeNs: String(metadata.mtimeNs),
          ctimeNs: String(metadata.ctimeNs),
        }),
      });
    }));
    const implementationIntegrity = createCutBuiltinImplementationIdentity("cut:visual").integrity;
    const visualPackage = builtinPackages.get("cut:visual");
    const irVisualModule = input.ir.modules.find((module) => module.specifier === "cut:visual");
    if (!visualPackage || !irVisualModule || irVisualModule.integrity !== visualPackage.integrity) {
      throw workerFailure("parent IR cut:visual module is not bound to the current visual package manifest");
    }
    const packageIntegrity = visualPackage.integrity;
    const workerIr = input.hooks?.workerBootstrapMutation === "ir"
      ? { ...input.ir, buildId: `${input.ir.buildId}-hostile-worker-mutation` }
      : input.hooks?.workerBootstrapMutation === "module-integrity"
        ? (() => {
          const forged = {
            ...input.ir,
            modules: input.ir.modules.map((module) => module.specifier === "cut:visual"
              ? { ...module, integrity: "0".repeat(64) }
              : module),
          };
          return finalizeGraphHashes(forged);
        })()
        : input.ir;
    const workerIrSemanticHash = input.hooks?.workerBootstrapMutation === "module-integrity"
      ? hash(workerIr)
      : hash(input.ir);
    const mediaProfileAuthority = referenceMediaProfileExecutionAuthority(input.ir);
    const authorityMutation = input.hooks?.workerBootstrapMutation;
    const resignMediaProfileAuthority = (
      value: Omit<ReferenceMediaProfileExecutionAuthority, "authoritySha256">,
    ) => Object.freeze({ ...value, authoritySha256: hash(value) });
    let workerMediaProfileAuthority: ReferenceMediaProfileExecutionAuthority | undefined = mediaProfileAuthority;
    if (authorityMutation === "media-profile-authority") {
      workerMediaProfileAuthority = mediaProfileAuthority === undefined
        ? Object.freeze({
          format: "cut-reference-media-profile-execution-authority" as const,
          version: 1 as const,
          irSemanticHash: hash(input.ir),
          resources: Object.freeze([]),
          authoritySha256: "0".repeat(64),
        })
        : Object.freeze({ ...mediaProfileAuthority, authoritySha256: "0".repeat(64) });
    } else if (mediaProfileAuthority !== undefined && authorityMutation?.startsWith("media-profile-authority-")) {
      const { authoritySha256: _authoritySha256, ...content } = mediaProfileAuthority;
      const resources = [...content.resources];
      if (authorityMutation === "media-profile-authority-extra-field") {
        workerMediaProfileAuthority = Object.freeze({ ...mediaProfileAuthority, unexpected: true }) as ReferenceMediaProfileExecutionAuthority;
      } else if (authorityMutation === "media-profile-authority-omit-field") {
        const { irSemanticHash: _irSemanticHash, ...missing } = content;
        workerMediaProfileAuthority = Object.freeze({ ...missing, authoritySha256: hash(missing) }) as ReferenceMediaProfileExecutionAuthority;
      } else if (authorityMutation === "media-profile-authority-semantic-hash") {
        workerMediaProfileAuthority = resignMediaProfileAuthority({ ...content, irSemanticHash: "0".repeat(64) });
      } else if (authorityMutation === "media-profile-authority-missing-resource") {
        workerMediaProfileAuthority = resignMediaProfileAuthority({ ...content, resources: Object.freeze(resources.slice(1)) });
      } else if (authorityMutation === "media-profile-authority-duplicate-resource") {
        workerMediaProfileAuthority = resignMediaProfileAuthority({ ...content, resources: Object.freeze([...resources, resources[0]!]) });
      } else if (authorityMutation === "media-profile-authority-reordered-resources") {
        workerMediaProfileAuthority = resignMediaProfileAuthority({ ...content, resources: Object.freeze(resources.toReversed()) });
      } else {
        const first = resources[0]!;
        const mutated = authorityMutation === "media-profile-authority-resource-digest"
          ? Object.freeze({ ...first, digest: "0".repeat(64) })
          : authorityMutation === "media-profile-authority-resource-selected"
            ? Object.freeze({ ...first, selected: first.selected === "master" ? "proxy" as const : "master" as const })
            : Object.freeze({ ...first, authoredProxy: !first.authoredProxy });
        workerMediaProfileAuthority = resignMediaProfileAuthority({
          ...content,
          resources: Object.freeze([mutated, ...resources.slice(1)]),
        });
      }
    }
    const selectedMediaResourceIds = new Set(
      mediaProfileAuthority?.resources.map((resource) => resource.resourceId) ?? [],
    );
    const selectedMediaResourceIndex = resources.findIndex(
      (resource) => selectedMediaResourceIds.has(resource.id),
    );
    const mutatedResourceIndex = selectedMediaResourceIndex >= 0 ? selectedMediaResourceIndex : 0;
    const workerResources = input.hooks?.workerBootstrapMutation === "resource-sha" && resources[mutatedResourceIndex]
      ? Object.freeze([
        ...resources.slice(0, mutatedResourceIndex),
        Object.freeze({ ...resources[mutatedResourceIndex]!, sha256: "0".repeat(64) }),
        ...resources.slice(mutatedResourceIndex + 1),
      ])
      : resources;
    const boundedTimeout = (value: number | undefined, maximum: number, label: string) => {
      const selected = value ?? maximum;
      if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
        throw workerFailure(`${label} timeout must be from 1 through ${maximum}ms`);
      }
      return selected;
    };
    const performanceDiagnosticNativeConcurrency = input.hooks?.performanceDiagnostic === undefined
      ? undefined
      : sharp.concurrency();
    if (performanceDiagnosticNativeConcurrency !== undefined
      && (!Number.isSafeInteger(performanceDiagnosticNativeConcurrency)
        || performanceDiagnosticNativeConcurrency < 1
        || performanceDiagnosticNativeConcurrency > 1_024)) {
      throw workerFailure("parent Sharp native concurrency is outside the closed diagnostic range");
    }
    const staticMediaGradeCacheBytes = input.hooks?.staticMediaGradeCacheBytes
      ?? referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes;
    if (!Number.isSafeInteger(staticMediaGradeCacheBytes)
      || staticMediaGradeCacheBytes < 4
      || staticMediaGradeCacheBytes > referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes) {
      throw workerFailure(
        `static media grade cache bytes must be from 4 through ${referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes}`,
      );
    }
    const staticMediaGradeHandoffMode = input.hooks?.staticMediaGradeHandoffMode
      ?? "immutable-lease";
    if (staticMediaGradeHandoffMode !== "copied"
      && staticMediaGradeHandoffMode !== "immutable-lease") {
      throw workerFailure("static media grade handoff mode must be copied or immutable-lease");
    }
    const privateLocalPaintAlphaBoundsMode = input.hooks?.privateLocalPaintAlphaBoundsMode;
    if (privateLocalPaintAlphaBoundsMode !== undefined
      && privateLocalPaintAlphaBoundsMode !== "automatic"
      && privateLocalPaintAlphaBoundsMode !== "forced-full-surface") {
      throw workerFailure("private LocalSpace paint alpha-bounds mode is invalid");
    }
    const states: WorkerState[] = [];
    const pool = new ReferencePreviewPictureWorkerPool(states, {
      prepareMs: boundedTimeout(input.hooks?.workerTimeouts?.prepareMs, referencePreviewPictureParallelLimits.workerPrepareTimeoutMs, "prepare"),
      chunkMs: boundedTimeout(input.hooks?.workerTimeouts?.chunkMs, referencePreviewPictureParallelLimits.workerChunkTimeoutMs, "chunk"),
      closeMs: boundedTimeout(input.hooks?.workerTimeouts?.closeMs, referencePreviewPictureParallelLimits.workerCloseTimeoutMs, "close"),
    }, input.hooks);
    for (let index = 0; index < input.workerCount; index += 1) {
      let acceptReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((accept, reject) => { acceptReady = accept; rejectReady = reject; });
      let acceptExit!: (code: number) => void;
      const exit = new Promise<number>((accept) => { acceptExit = accept; });
      const worker = new Worker(workerModule, {
        workerData: Object.freeze({
          format: "cut-reference-preview-picture-worker-bootstrap",
          version: 1,
          workerIndex: index,
          workerModuleSha256: input.hooks?.workerBootstrapMutation === "module-sha"
            ? "0".repeat(64)
            : workerModuleSha256,
          runtimeIdentity: cutReferenceRuntimeIdentity,
          implementationIntegrity,
          packageIntegrity,
          backendIntegrity: input.backendIntegrity,
          ir: workerIr,
          irSemanticHash: workerIrSemanticHash,
          mediaProfileAuthority: workerMediaProfileAuthority,
          compositionId: input.composition.id,
          projectRoot: input.projectRoot,
          cacheRoot: resolve(input.cacheRoot, `preview-worker-${index}`),
          resources: workerResources,
          width: input.width,
          height: input.height,
          color: input.color,
          surfaceCacheByteLimit: referencePreviewPictureParallelLimits.perRendererSurfaceCacheBytes,
          localPaintCacheBytes: referencePreviewPictureParallelLimits.workerLocalPaintCacheBytes,
          staticMediaGradeCacheBytes,
          staticMediaGradeHandoffMode,
          privateStraightCompositeMode: input.hooks?.privateStraightCompositeMode,
          privateLocalPaintAlphaBoundsMode,
          ...(input.hooks?.performanceDiagnostic === undefined
            ? {}
            : {
              performanceDiagnostic: Object.freeze({
                format: "cut-reference-preview-picture-worker-performance-diagnostic" as const,
                version: 1 as const,
                nativeConcurrency: performanceDiagnosticNativeConcurrency!,
              }),
            }),
          fault: input.hooks?.workerFault,
        }),
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
          maxYoungGenerationSizeMb: 64,
          stackSizeMb: 8,
        },
      });
      const state: WorkerState = {
        index, worker, ready, acceptReady, rejectReady, pending: new Map(),
        readyReceived: false, closed: false, closeRequested: false, exit, acceptExit,
      };
      states.push(state);
      const rejectAll = (error: unknown) => {
        const firstFailure = pool.failed === undefined;
        state.rejectReady(error);
        for (const pending of state.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        state.pending.clear();
        pool.failed ??= error;
        if (firstFailure) {
          let observed: void | Promise<void>;
          try {
            observed = input.hooks?.workerFailureObserved?.(Object.freeze({
              workerIndex: state.index,
              message: error instanceof Error ? error.message : String(error),
            }));
          } catch {
            observed = undefined;
          }
          if (observed) void Promise.resolve(observed).catch((hookError) => { pool.failed ??= hookError; });
        }
      };
      worker.on("message", (message: unknown) => {
        const responseReceivedAtMs = performance.now();
        if (!message || typeof message !== "object" || !("type" in message)) {
          rejectAll(workerFailure("worker emitted a malformed message"));
          return;
        }
        const response = message as Record<string, unknown>;
        const exactKeys = (...keys: string[]) => {
          const actual = Object.keys(response).sort();
          return actual.length === keys.length && actual.every((key, keyIndex) => key === [...keys].sort()[keyIndex]);
        };
        const diagnosticEnabled = input.hooks?.performanceDiagnostic !== undefined;
        if (response.type === "ready"
          && (diagnosticEnabled
            ? exactKeys("type", "workerIndex", "diagnostic")
            : exactKeys("type", "workerIndex"))
          && response.workerIndex === index) {
          if (state.readyReceived || state.closed || state.closeRequested || state.pending.size > 0) {
            rejectAll(workerFailure(`worker ${index} emitted a duplicate or late ready receipt`));
            return;
          }
          try {
            if (diagnosticEnabled) {
              const diagnostic = workerReadyDiagnostic(response.diagnostic);
              if (diagnostic.nativeConcurrency !== performanceDiagnosticNativeConcurrency) {
                throw workerFailure("worker ready diagnostic differs from parent native concurrency authority");
              }
              input.hooks!.performanceDiagnostic!(Object.freeze({
                kind: "worker-ready",
                workerIndex: index,
                ...diagnostic,
              }));
            }
          } catch (error) {
            rejectAll(error);
            return;
          }
          state.readyReceived = true;
          state.acceptReady();
        }
        else if (response.type === "closed" && exactKeys("type", "workerIndex") && response.workerIndex === index) {
          if (!state.readyReceived || !state.closeRequested || state.closed || state.pending.size > 0) {
            rejectAll(workerFailure(`worker ${index} emitted an early, duplicate, or out-of-order close receipt`));
            return;
          }
          state.closed = true;
        }
        else if (response.type === "failure" && exactKeys("type", "error")) rejectAll(workerFailure(response.error));
        else if (response.type === "chunk") {
          const id = response.requestId;
          const requestId = typeof id === "number" ? id : undefined;
          const pending = requestId === undefined ? undefined : state.pending.get(requestId);
          const chunkKeys = [
            "type", "requestId", "workerIndex", "sceneId", "firstGlobalFrame",
            "firstSceneFrame", "frameCount", "frames",
            ...(diagnosticEnabled ? ["diagnostic"] : []),
          ];
          if (!exactKeys(...chunkKeys) || !pending || !Array.isArray(response.frames)
            || response.workerIndex !== state.index
            || response.sceneId !== pending.chunk.sceneId
            || response.firstGlobalFrame !== pending.chunk.firstFrame
            || response.firstSceneFrame !== pending.chunk.firstSceneFrame
            || response.frameCount !== pending.chunk.endFrameExclusive - pending.chunk.firstFrame) {
            rejectAll(workerFailure("worker emitted an unbound chunk response"));
            return;
          }
          try {
            if (response.frames.length !== pending.chunk.endFrameExclusive - pending.chunk.firstFrame) {
              throw workerFailure("worker chunk response has an unexpected frame count");
            }
            const decoded = Object.freeze(response.frames.map((frame, frameIndex) => {
              const candidate = frame as Record<string, unknown>;
              const cache = candidate.staticGradeCache as Record<string, unknown> | undefined;
              const composite = candidate.privateStraightComposite as Record<string, unknown> | undefined;
              const cacheKeys = cache ? Object.keys(cache).sort().join(",") : "";
              const cacheCounts = cache
                ? [
                  cache.hit,
                  cache.miss,
                  cache.bypassCapacity,
                  cache.bypassDynamic,
                  cache.residentCopies,
                  cache.residentCopyRgbaBytes,
                  cache.handoffCopies,
                  cache.handoffRgbaBytes,
                  cache.leaseHandoffs,
                  cache.leaseRgbaBytes,
                ]
                : [];
              const compositeKeys = composite ? Object.keys(composite).sort().join(",") : "";
              const compositeCounts = composite
                ? [
                  composite.executions,
                  composite.fastNormalStraightPixels,
                  composite.scalarPixels,
                  composite.quantizerBoundaryFallbacks,
                  composite.nativeExecutions,
                  composite.nativeFastNormalStraightPixels,
                ]
                : [];
              if (!(candidate.surface instanceof ArrayBuffer)
                || candidate.surface.byteLength !== input.width * input.height * 4
                || candidate.globalFrame !== pending.chunk.firstFrame + frameIndex
                || candidate.sceneFrame !== pending.chunk.firstSceneFrame + frameIndex
                || Object.keys(candidate).sort().join(",") !== "globalFrame,privateStraightComposite,sceneFrame,staticGradeCache,surface"
                || cacheKeys !== "bypassCapacity,bypassDynamic,handoffCopies,handoffRgbaBytes,hit,leaseHandoffs,leaseRgbaBytes,miss,residentCopies,residentCopyRgbaBytes"
                || cacheCounts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0)
                || Number(cache!.hit) + Number(cache!.miss) + Number(cache!.bypassCapacity) + Number(cache!.bypassDynamic)
                  > input.maximumStaticGradeEventsPerFrame
                || Number(cache!.handoffCopies) + Number(cache!.leaseHandoffs) !== Number(cache!.hit)
                || cache!.residentCopies !== cache!.miss
                || Number(cache!.residentCopyRgbaBytes) < Number(cache!.residentCopies) * 4
                || Number(cache!.residentCopyRgbaBytes)
                  > Number(cache!.residentCopies) * referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes
                || Number(cache!.handoffRgbaBytes) < Number(cache!.handoffCopies) * 4
                || Number(cache!.handoffRgbaBytes)
                  > Number(cache!.handoffCopies) * referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes
                || Number(cache!.leaseRgbaBytes) < Number(cache!.leaseHandoffs) * 4
                || Number(cache!.leaseRgbaBytes)
                  > Number(cache!.leaseHandoffs) * referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes
                || compositeKeys !== "executions,fastNormalStraightPixels,mode,nativeExecutions,nativeFastNormalStraightPixels,quantizerBoundaryFallbacks,scalarPixels"
                || (composite?.mode !== "automatic" && composite?.mode !== "forced-js-fast" && composite?.mode !== "forced-scalar" && composite?.mode !== "unobserved")
                || compositeCounts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0)
                || (composite?.mode === "unobserved" && compositeCounts.some((count) => Number(count) !== 0))
                || (composite?.mode === "forced-scalar"
                  && (composite.fastNormalStraightPixels !== 0
                    || composite.quantizerBoundaryFallbacks !== 0
                    || composite.nativeExecutions !== 0
                    || composite.nativeFastNormalStraightPixels !== 0))
                || (composite?.mode === "forced-js-fast"
                  && (composite.nativeExecutions !== 0 || composite.nativeFastNormalStraightPixels !== 0))
                || (composite?.executions === 0
                  && (composite.fastNormalStraightPixels !== 0
                    || composite.scalarPixels !== 0
                    || composite.quantizerBoundaryFallbacks !== 0
                    || composite.nativeExecutions !== 0
                    || composite.nativeFastNormalStraightPixels !== 0))
                || Number(composite!.quantizerBoundaryFallbacks)
                  > Number(composite!.fastNormalStraightPixels) * 3
                || Number(composite!.nativeExecutions) > Number(composite!.executions)
                || Number(composite!.nativeFastNormalStraightPixels) > Number(composite!.fastNormalStraightPixels)
                || (Number(composite!.nativeExecutions) === 0 && Number(composite!.nativeFastNormalStraightPixels) !== 0)) {
                throw workerFailure("worker emitted malformed frame bytes");
              }
              const staticGradeCache = Object.freeze({
                hit: cache!.hit as number,
                miss: cache!.miss as number,
                bypassCapacity: cache!.bypassCapacity as number,
                bypassDynamic: cache!.bypassDynamic as number,
                residentCopies: cache!.residentCopies as number,
                residentCopyRgbaBytes: cache!.residentCopyRgbaBytes as number,
                handoffCopies: cache!.handoffCopies as number,
                handoffRgbaBytes: cache!.handoffRgbaBytes as number,
                leaseHandoffs: cache!.leaseHandoffs as number,
                leaseRgbaBytes: cache!.leaseRgbaBytes as number,
              });
              const privateStraightComposite = Object.freeze({
                mode: composite!.mode as "automatic" | "forced-js-fast" | "forced-scalar" | "unobserved",
                executions: composite!.executions as number,
                fastNormalStraightPixels: composite!.fastNormalStraightPixels as number,
                scalarPixels: composite!.scalarPixels as number,
                quantizerBoundaryFallbacks: composite!.quantizerBoundaryFallbacks as number,
                nativeExecutions: composite!.nativeExecutions as number,
                nativeFastNormalStraightPixels: composite!.nativeFastNormalStraightPixels as number,
              });
              return Object.freeze({
                surface: Buffer.from(candidate.surface),
                globalFrame: candidate.globalFrame as number,
                sceneFrame: candidate.sceneFrame as number,
                staticGradeCache,
                privateStraightComposite,
              });
            }));
            for (const frame of decoded) {
              input.hooks?.staticMediaGradeCacheFrame?.(Object.freeze({
                rendererIndex: state.index,
                globalFrame: frame.globalFrame,
                sceneFrame: frame.sceneFrame,
                counts: frame.staticGradeCache,
              }));
              input.hooks?.privateStraightCompositeFrame?.(Object.freeze({
                rendererIndex: state.index,
                globalFrame: frame.globalFrame,
                sceneFrame: frame.sceneFrame,
                counts: frame.privateStraightComposite,
              }));
            }
            if (diagnosticEnabled) {
              const diagnostic = workerChunkDiagnostic(response.diagnostic);
              if (diagnostic.nativeConcurrency !== performanceDiagnosticNativeConcurrency) {
                throw workerFailure("worker chunk diagnostic differs from parent native concurrency authority");
              }
              input.hooks!.performanceDiagnostic!(Object.freeze({
                kind: "worker-chunk",
                workerIndex: state.index,
                requestId: requestId!,
                sceneId: pending.chunk.sceneId,
                firstGlobalFrame: pending.chunk.firstFrame,
                frameCount: pending.chunk.endFrameExclusive - pending.chunk.firstFrame,
                ...diagnostic,
                parentRoundTripMs: responseReceivedAtMs - pending.dispatchedAtMs,
                parentResponseValidationMs: performance.now() - responseReceivedAtMs,
              }));
            }
            state.pending.delete(requestId!);
            clearTimeout(pending.timeout);
            pending.accept(decoded);
          } catch (error) {
            state.pending.delete(requestId!);
            clearTimeout(pending.timeout);
            pending.reject(error);
            rejectAll(error);
          }
        } else rejectAll(workerFailure("worker emitted an unknown or malformed protocol message"));
      });
      worker.on("error", (error) => rejectAll(workerFailure(error)));
      worker.on("exit", (code) => {
        state.acceptExit(code);
        if (!state.closeRequested || !state.closed || code !== 0) rejectAll(workerFailure(`worker ${index} exited with code ${code} without a valid close receipt`));
      });
    }
    pool.rssTimer = setInterval(() => {
      if (process.memoryUsage().rss > referencePreviewPictureParallelLimits.maximumProcessRssBytes) {
        void pool.abort(workerFailure(`process RSS exceeded ${referencePreviewPictureParallelLimits.maximumProcessRssBytes} bytes`)).catch(() => undefined);
      }
    }, 100);
    pool.rssTimer.unref();
    try {
      await timeout(
        Promise.all(states.map((state) => state.ready)).then(() => undefined),
        pool.prepareTimeoutMs,
        "worker preparation",
      );
      if (pool.failed) throw pool.failed;
      await input.hooks?.workersReady?.(Object.freeze({
        resources: Object.freeze(resources.map((resource) => Object.freeze({
          id: resource.id,
          path: resource.path,
          sha256: resource.sha256,
        }))),
      }));
      if (pool.failed) throw pool.failed;
      return pool;
    } catch (error) {
      await pool.abort(error);
      throw error;
    }
  }

  render(chunk: WorkerChunk) {
    if (this.failed) return Promise.reject(this.failed);
    const state = this.states[chunk.rendererIndex];
    if (!state || state.pending.size > 0) return Promise.reject(workerFailure("worker chunk dispatch is not bounded to one in-flight request per worker"));
    const requestId = this.requestId++;
    return new Promise<readonly WorkerFrame[]>((accept, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(requestId);
        const error = workerFailure(`worker ${state.index} chunk ${requestId} hung`);
        reject(error);
        void this.abort(error).catch(() => undefined);
      }, this.chunkTimeoutMs);
      timer.unref();
      this.hooks?.workerChunkDispatched?.(Object.freeze({
        rendererIndex: chunk.rendererIndex,
        requestId,
        sceneId: chunk.sceneId,
        firstGlobalFrame: chunk.firstFrame,
        firstSceneFrame: chunk.firstSceneFrame,
        frameCount: chunk.endFrameExclusive - chunk.firstFrame,
      }));
      state.pending.set(requestId, {
        accept,
        reject,
        timeout: timer,
        chunk,
        dispatchedAtMs: performance.now(),
      });
      state.worker.postMessage(Object.freeze({
        type: "render",
        requestId,
        sceneId: chunk.sceneId,
        firstGlobalFrame: chunk.firstFrame,
        firstSceneFrame: chunk.firstSceneFrame,
        frames: chunk.endFrameExclusive - chunk.firstFrame,
      }));
    });
  }

  async abort(error: unknown) {
    if (this.aborting) return this.aborting;
    this.failed ??= error;
    this.aborting = (async () => {
      if (this.rssTimer) clearInterval(this.rssTimer);
      for (const state of this.states) {
        state.rejectReady(this.failed);
        for (const pending of state.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(this.failed);
        }
        state.pending.clear();
      }
      const results = await Promise.allSettled(this.states.map(async (state) => {
        await timeout(state.worker.terminate(), this.closeTimeoutMs, `worker ${state.index} abort termination`);
        await this.hooks?.workerTerminated?.(Object.freeze({ workerIndex: state.index, reason: "abort" }));
      }));
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length) {
        throw new AggregateError(failures, "one or more isolated picture workers did not terminate after abort");
      }
    })();
    return this.aborting;
  }

  async close(hooks?: ReferencePreviewPictureTestHooks) {
    if (this.rssTimer) clearInterval(this.rssTimer);
    if (this.failed) {
      await this.abort(this.failed);
      throw this.failed;
    }
    for (const state of this.states) {
      state.closeRequested = true;
      state.worker.postMessage(Object.freeze({ type: "close" }));
    }
    const results = await Promise.allSettled(this.states.map(async (state) => {
      let status: "fulfilled" | "rejected" = "fulfilled";
      try {
        const code = await timeout(state.exit, this.closeTimeoutMs, `worker ${state.index} close`);
        if (!state.closed || code !== 0) throw workerFailure(`worker ${state.index} did not confirm close and exit zero`);
      } catch (error) {
        status = "rejected";
        await timeout(state.worker.terminate(), this.closeTimeoutMs, `worker ${state.index} unconfirmed-close termination`);
        await this.hooks?.workerTerminated?.(Object.freeze({ workerIndex: state.index, reason: "unconfirmed-close" }));
        throw error;
      } finally {
        await hooks?.rendererClosed?.(Object.freeze({ rendererIndex: state.index, status }));
      }
    }));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (this.failed) failures.unshift(this.failed);
    if (failures.length) throw new AggregateError(failures, "one or more isolated picture workers failed to close cleanly");
  }
}

export async function renderReferencePreviewPictureArtifact(input: Readonly<{
  ir: CutAVIR;
  composition: IRComposition;
  projectRoot: string;
  cacheRoot: string;
  firstFrame: number;
  endFrameExclusive: number;
  width: number;
  height: number;
  color: ReferenceColorProfile | "legacy";
  backend: CutReferenceBackendIdentity;
  toolchain: PictureToolchain;
  verifiedResourcePath: ReferenceVerifiedInputSession["pathFor"];
  __testHooks?: ReferencePreviewPictureTestHooks;
}>): Promise<Readonly<{ path: string; cache: ReferencePreviewPictureCacheEvidence }>> {
  const frames = input.endFrameExclusive - input.firstFrame;
  if (!Number.isSafeInteger(input.firstFrame) || !Number.isSafeInteger(input.endFrameExclusive)
    || input.firstFrame < 0 || frames < 1
    || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)
    || input.width < 2 || input.height < 2) {
    throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_CONTRACT", "range and canvas must be one bounded positive exact frame interval and raster.");
  }
  const plan = createIncrementalRenderPlan(
    input.ir,
    input.composition.id,
    undefined,
    cutReferenceRuntimeIdentity,
    input.backend.integrity,
    input.color,
    input.toolchain.toolchain.integrity,
  );
  const segments = selectedSegments(
    input.ir,
    input.composition,
    input.firstFrame,
    input.endFrameExclusive,
    new Map(plan.scenes.map((scene) => [scene.id, scene.key])),
  );
  const identity = entryIdentity({
    runtime: cutReferenceRuntimeIdentity,
    backendIntegrity: input.backend.integrity,
    toolchainIntegrity: input.toolchain.toolchain.integrity,
    segments,
    firstFrame: input.firstFrame,
    endFrameExclusive: input.endFrameExclusive,
    composition: input.composition,
    width: input.width,
    height: input.height,
    color: input.color,
  });
  const key = cacheKey(identity);
  const cacheDirectory = await ensureProjectWriteDirectory(input.projectRoot, ".cut/cache/reference/preview-picture");
  const entriesDirectory = await ensureProjectWriteDirectory(input.projectRoot, ".cut/cache/reference/preview-picture/entries");
  const blobsDirectory = await ensureProjectWriteDirectory(input.projectRoot, ".cut/cache/reference/preview-picture/blobs");
  const entryPath = resolve(entriesDirectory, `${key}.json`);
  const existing = await boundedEntry(entryPath);
  if (sameEntryIdentity(existing, key, identity)) {
    const artifact = await validArtifact(input.projectRoot, existing, input.__testHooks?.nativeProcesses?.artifactProbe);
    if (artifact) return Object.freeze({
      path: artifact,
      cache: Object.freeze({
        ...existing,
        format: "cut-reference-preview-picture-cache",
        status: "hit",
        reason: "CUT_PREVIEW_PICTURE_CACHE_HIT",
        publication: "existing-valid",
      }),
    });
  }
  const corrupt = existing !== undefined || await lstat(entryPath).then(() => true).catch(() => false);
  const staging = await mkdtemp(resolve(cacheDirectory, ".cut-preview-picture-build-"));
  const stagedArtifact = resolve(staging, "picture.mp4");
  const parallelPlan = previewPictureParallelPlan({
    ir: input.ir,
    composition: input.composition,
    firstFrame: input.firstFrame,
    endFrameExclusive: input.endFrameExclusive,
    width: input.width,
    height: input.height,
    requestedRenderers: input.__testHooks?.requestedRenderers,
    requestedWorkerThreads: input.__testHooks?.requestedWorkerThreads,
  });
  await input.__testHooks?.plan?.(parallelPlan);
  const useWorkerThreads = parallelPlan.reason === "worker-thread-measurement-override";
  const sharedLocalPaintSurfaceCache = useWorkerThreads ? undefined : new ReferenceLocalPaintSurfaceCache();
  const renderers = useWorkerThreads ? [] : Array.from(
    { length: parallelPlan.rendererCount },
    () => new ReferenceVisualRenderer(
      input.ir,
      input.composition,
      input.projectRoot,
      input.cacheRoot,
      input.verifiedResourcePath,
      undefined,
      1,
      {
        sharedLocalPaintSurfaceCache: sharedLocalPaintSurfaceCache!,
        staticMediaGradeCacheByteLimit: input.__testHooks?.staticMediaGradeCacheBytes
          ?? referencePreviewPictureParallelLimits.workerStaticMediaGradeCacheBytes,
        staticMediaGradeHandoffMode: input.__testHooks?.staticMediaGradeHandoffMode,
        privateStraightCompositeMode: input.__testHooks?.privateStraightCompositeMode,
        privateLocalPaintAlphaBoundsMode: input.__testHooks?.privateLocalPaintAlphaBoundsMode,
        surfaceCacheByteLimit: referencePreviewPictureParallelLimits.perRendererSurfaceCacheBytes,
        lazyNestedCompositionPreparation: true,
      },
    ),
  );
  const encoder = input.__testHooks?.nativeProcesses
    ? await spawnBoundRawEncoder(
      input.width,
      input.height,
      `${input.composition.fps.numerator}/${input.composition.fps.denominator}`,
      stagedArtifact,
      input.color,
      input.__testHooks.nativeProcesses.encoder,
    )
    : spawnRawEncoder(
      input.width,
      input.height,
      `${input.composition.fps.numerator}/${input.composition.fps.denominator}`,
      stagedArtifact,
      input.color,
      input.toolchain.executablePath,
    );
  let encoderFinished = false;
  let bodyError: unknown;
  let workerPool: ReferencePreviewPictureWorkerPool | undefined;
  let completed: Readonly<{ path: string; cache: ReferencePreviewPictureCacheEvidence }> | undefined;
  try {
    completed = await (async () => {
    await input.__testHooks?.phase?.(Object.freeze({ phase: "prepare-start" }));
    if (useWorkerThreads) {
      workerPool = await ReferencePreviewPictureWorkerPool.create({
        ir: input.ir,
        composition: input.composition,
        projectRoot: input.projectRoot,
        cacheRoot: input.cacheRoot,
        verifiedResourcePath: input.verifiedResourcePath,
        backendIntegrity: input.backend.integrity,
        width: input.width,
        height: input.height,
        color: input.color,
        workerCount: parallelPlan.rendererCount as 1 | 3,
        maximumStaticGradeEventsPerFrame: parallelPlan.maximumStaticGradeEventsPerFrame,
        hooks: input.__testHooks,
      });
    } else {
      const preparations = await Promise.allSettled(renderers.map((renderer) => renderer.prepare()));
      const failedPreparation = preparations.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failedPreparation) throw failedPreparation.reason;
    }
    await input.__testHooks?.phase?.(Object.freeze({ phase: "prepare-end" }));
    await input.__testHooks?.phase?.(Object.freeze({ phase: "picture-start" }));
    for (const segment of segments) {
      for (let waveStart = segment.firstFrame; waveStart < segment.endFrameExclusive;) {
        const waveStartedAt = performance.now();
        const chunks = [];
        for (let rendererIndex = 0;
          rendererIndex < parallelPlan.rendererCount && waveStart < segment.endFrameExclusive;
          rendererIndex += 1) {
          const firstFrame = waveStart;
          const endFrameExclusive = Math.min(
            segment.endFrameExclusive,
            firstFrame + parallelPlan.framesPerRendererChunk,
          );
          chunks.push(Object.freeze({
            rendererIndex,
            sceneId: segment.scene.id,
            firstFrame,
            endFrameExclusive,
            firstSceneFrame: segment.firstSceneFrame + firstFrame - segment.firstFrame,
          }));
          waveStart = endFrameExclusive;
        }
        const renderedChunks = await Promise.allSettled(chunks.map(async (chunk) => {
          if (useWorkerThreads) {
            for (let globalFrame = chunk.firstFrame; globalFrame < chunk.endFrameExclusive; globalFrame += 1) {
              await input.__testHooks?.beforeFrame?.(Object.freeze({
                rendererIndex: chunk.rendererIndex,
                globalFrame,
                sceneId: chunk.sceneId,
                sceneFrame: chunk.firstSceneFrame + globalFrame - chunk.firstFrame,
              }));
            }
            const output = await workerPool!.render(chunk);
            for (const frame of output) {
              if (frame.surface.byteLength !== parallelPlan.frameRgbaBytes) {
                throw new ReferencePreviewPictureCacheError(
                  "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
                  `worker-rendered frame ${frame.globalFrame} produced ${frame.surface.byteLength} RGBA bytes; expected ${parallelPlan.frameRgbaBytes}.`,
                );
              }
              await input.__testHooks?.afterFrame?.(Object.freeze({
                rendererIndex: chunk.rendererIndex,
                globalFrame: frame.globalFrame,
                sceneId: chunk.sceneId,
                sceneFrame: frame.sceneFrame,
              }));
            }
            return output;
          }
          const renderer = renderers[chunk.rendererIndex]!;
          const output: Array<Readonly<{
            surface: Buffer;
            globalFrame: number;
            sceneFrame: number;
          }>> = [];
          for (let globalFrame = chunk.firstFrame; globalFrame < chunk.endFrameExclusive; globalFrame += 1) {
            const sceneFrame = segment.firstSceneFrame + globalFrame - segment.firstFrame;
            const event = Object.freeze({
              rendererIndex: chunk.rendererIndex,
              globalFrame,
              sceneId: chunk.sceneId,
              sceneFrame,
            });
            await input.__testHooks?.beforeFrame?.(event);
            const frameActiveStartedAt = performance.now();
            const sceneFrameStartedAt = performance.now();
            const rendered = await renderer.sceneFrame(segment.scene, sceneFrame);
            const sceneFrameEndedAt = performance.now();
            const resizeStartedAt = performance.now();
            const resized = input.width === rendered.width && input.height === rendered.height
              ? Buffer.from(rendered.data)
              : await sharp(Buffer.from(rendered.data), { raw: { width: rendered.width, height: rendered.height, channels: 4 } })
                .resize(input.width, input.height, { fit: "fill", kernel: "lanczos3" })
                .ensureAlpha()
                .raw()
                .toBuffer();
            const resizeEndedAt = performance.now();
            const colorStartedAt = performance.now();
            const surface = input.color === "legacy" || input.color === "srgb"
              ? resized
              : Buffer.from(convertReferenceColorSurface(
                { data: resized, width: input.width, height: input.height },
                "srgb",
                input.color === "rec709-limited" ? "rec709-full" : input.color,
              ).data);
            const colorEndedAt = performance.now();
            if (surface.byteLength !== parallelPlan.frameRgbaBytes) {
              throw new ReferencePreviewPictureCacheError(
                "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
                `rendered frame ${globalFrame} produced ${surface.byteLength} RGBA bytes; expected ${parallelPlan.frameRgbaBytes}.`,
              );
            }
            output.push(Object.freeze({ surface, globalFrame, sceneFrame }));
            input.__testHooks?.performanceDiagnostic?.(Object.freeze({
              kind: "serial-frame",
              rendererIndex: chunk.rendererIndex,
              globalFrame,
              sceneId: chunk.sceneId,
              sceneFrame,
              sceneFrameMs: sceneFrameEndedAt - sceneFrameStartedAt,
              resizeMs: resizeEndedAt - resizeStartedAt,
              colorMs: colorEndedAt - colorStartedAt,
              frameActiveMs: colorEndedAt - frameActiveStartedAt,
            }));
            await input.__testHooks?.afterFrame?.(event);
          }
          return Object.freeze(output);
        }));
        const chunksRenderedAt = performance.now();
        const failedChunk = renderedChunks.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failedChunk) throw failedChunk.reason;
        const orderedPublicationStartedAt = performance.now();
        let encoderWriteMs = 0;
        let publishedFrames = 0;
        for (let chunkIndex = 0; chunkIndex < renderedChunks.length; chunkIndex += 1) {
          const renderedChunk = renderedChunks[chunkIndex] as PromiseFulfilledResult<
            readonly Readonly<{ surface: Buffer; globalFrame: number; sceneFrame: number }>[]
          >;
          for (const frame of renderedChunk.value) {
            const writeStartedAt = performance.now();
            await writeFrame(encoder, frame.surface);
            encoderWriteMs += performance.now() - writeStartedAt;
            publishedFrames += 1;
            await input.__testHooks?.frameWritten?.(Object.freeze({
              globalFrame: frame.globalFrame,
              sceneId: segment.scene.id,
              sceneFrame: frame.sceneFrame,
            }));
          }
        }
        input.__testHooks?.performanceDiagnostic?.(Object.freeze({
          kind: "parent-wave",
          firstGlobalFrame: chunks[0]!.firstFrame,
          frameCount: publishedFrames,
          workerWaitMs: chunksRenderedAt - waveStartedAt,
          orderedPublicationMs: performance.now() - orderedPublicationStartedAt,
          encoderWriteMs,
        }));
      }
    }
    await input.__testHooks?.phase?.(Object.freeze({ phase: "picture-end" }));
    let workerCloseMs = 0;
    if (workerPool) {
      const workerCloseStartedAt = performance.now();
      await workerPool.close(input.__testHooks);
      workerCloseMs = performance.now() - workerCloseStartedAt;
      workerPool = undefined;
    }
    const encoderFinishStartedAt = performance.now();
    await finishEncoder(encoder);
    const encoderFinishMs = performance.now() - encoderFinishStartedAt;
    encoderFinished = true;
    const artifactVerificationStartedAt = performance.now();
    await input.toolchain.verify();
    await assertReferenceSceneArtifactContract(
      stagedArtifact,
      artifactExpectation(identity, key),
      input.__testHooks?.nativeProcesses?.artifactProbe(),
    );
    input.__testHooks?.performanceDiagnostic?.(Object.freeze({
      kind: "parent-tail",
      workerCloseMs,
      encoderFinishMs,
      artifactVerificationMs: performance.now() - artifactVerificationStartedAt,
    }));
    const artifactMetadata = await stat(stagedArtifact);
    if (!artifactMetadata.isFile() || artifactMetadata.size < 1 || artifactMetadata.size > maximumArtifactBytes) {
      throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_CONTRACT", `encoded picture cache artifact has an invalid bounded byte count ${artifactMetadata.size}.`);
    }
    const artifactSha256 = await sha256(stagedArtifact);
    const locator = `.cut/cache/reference/preview-picture/blobs/${artifactSha256}.mp4`;
    const artifact = Object.freeze({
      locator,
      sha256: artifactSha256,
      bytes: artifactMetadata.size,
      frames,
      width: input.width,
      height: input.height,
      verification: "sha256+bytes+h264-decoded-contract" as const,
    });
    const entry = Object.freeze({
      format: "cut-reference-preview-picture-cache-entry" as const,
      version: 1 as const,
      algorithm: referencePreviewPictureCacheAlgorithm,
      key,
      identity,
      artifact,
    });
    const blobPath = resolve(blobsDirectory, `${artifactSha256}.mp4`);
    const blobPublication = await publishLinkNoClobber(stagedArtifact, blobPath, async () => {
      try {
        const metadata = await lstat(blobPath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.bytes || await sha256(blobPath) !== artifactSha256) return false;
        await assertReferenceSceneArtifactContract(
          blobPath,
          artifactExpectation(identity, key),
          input.__testHooks?.nativeProcesses?.artifactProbe(),
        );
        return true;
      } catch { return false; }
    });
    const stagedEntry = resolve(staging, "entry.json");
    await writeFile(stagedEntry, `${stableJsonStringify(entry)}\n`, { flag: "wx", mode: 0o600 });
    const entryPublication = await publishLinkNoClobber(stagedEntry, entryPath, async () => {
      const winner = await boundedEntry(entryPath);
      if (!sameEntryIdentity(winner, key, identity)) return false;
      if (winner.artifact.sha256 !== artifact.sha256) {
        throw new ReferencePreviewPictureCacheError("CUT_PREVIEW_PICTURE_CACHE_NONDETERMINISM", `cache key ${key} produced both ${winner.artifact.sha256} and ${artifact.sha256}.`);
      }
      return Boolean(await validArtifact(input.projectRoot, winner, input.__testHooks?.nativeProcesses?.artifactProbe));
    });
    return Object.freeze({
      path: blobPath,
      cache: Object.freeze({
        ...entry,
        format: "cut-reference-preview-picture-cache",
        status: corrupt ? "rebuilt" : "miss",
        reason: corrupt ? "CUT_PREVIEW_PICTURE_CACHE_CORRUPT" : "CUT_PREVIEW_PICTURE_CACHE_COLD",
        publication: blobPublication === "existing" && entryPublication === "existing"
          ? "existing-valid"
          : "atomic-no-clobber",
      }),
    });
    })();
  } catch (error) {
    bodyError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (!encoderFinished) {
    try { await abortEncoderAndWait(encoder); }
    catch (error) { cleanupErrors.push(error); }
  }
  const closures = await Promise.allSettled(renderers.map(async (renderer, rendererIndex) => {
    try {
      await renderer.closeAndWait();
    } catch (error) {
      await input.__testHooks?.rendererClosed?.(Object.freeze({ rendererIndex, status: "rejected" }));
      throw error;
    }
    await input.__testHooks?.rendererClosed?.(Object.freeze({ rendererIndex, status: "fulfilled" }));
  }));
  cleanupErrors.push(...closures
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason));
  if (workerPool) {
    try {
      if (bodyError === undefined) await workerPool.close(input.__testHooks);
      else await workerPool.abort(bodyError);
    } catch (error) { cleanupErrors.push(error); }
  }
  try { await rm(staging, { recursive: true, force: true }); }
  catch (error) { cleanupErrors.push(error); }
  if (bodyError !== undefined) {
    if (cleanupErrors.length) {
      throw new AggregateError(
        [bodyError, ...cleanupErrors],
        "CUT preview picture rendering failed and one or more cleanup operations also failed.",
        { cause: bodyError },
      );
    }
    throw bodyError;
  }
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, "CUT preview picture cleanup failed.");
  }
  if (!completed) {
    throw new ReferencePreviewPictureCacheError(
      "CUT_PREVIEW_PICTURE_CACHE_CONTRACT",
      "preview picture execution completed without one published result.",
    );
  }
  return completed;
}
