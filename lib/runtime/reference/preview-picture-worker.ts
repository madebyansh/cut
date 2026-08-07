import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";

import { createCutBuiltinImplementationIdentity } from "../../language/builtin-implementation-identity";
import { builtinPackages } from "../../language/packages";
import type { CutAVIR } from "../../language/ir";
import { validateCutAvIr } from "../../language/ir-loader";
import { registerAppliedCutLockIr } from "../../language/locked-ir-state";
import { hash } from "../../core/stable";
import { cutReferenceRuntimeIdentity } from "../../version";
import { convertReferenceColorSurface, type ReferenceColorProfile } from "./color-management";
import { collectReferenceBackendIdentity } from "./runtime-identity";
import {
  maximumStaticMediaGradeCacheBytes,
  ReferenceLocalPaintSurfaceCache,
  ReferenceVisualRenderer,
} from "./visual";
import {
  registerReferenceMediaProfileExecutionAuthority,
  type ReferenceMediaProfileExecutionAuthority,
} from "./media-profile-state";

type ResourceBinding = Readonly<{
  id: string;
  path: string;
  physicalPath: string;
  bytes: number;
  sha256: string;
  identity: Readonly<{ dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string }>;
}>;

type WorkerFault = Readonly<{
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

type WorkerBootstrap = Readonly<{
  format: "cut-reference-preview-picture-worker-bootstrap";
  version: 1;
  workerIndex: number;
  workerModuleSha256: string;
  runtimeIdentity: string;
  implementationIntegrity: string;
  packageIntegrity: string;
  backendIntegrity: string;
  ir: CutAVIR;
  irSemanticHash: string;
  mediaProfileAuthority?: ReferenceMediaProfileExecutionAuthority;
  compositionId: string;
  projectRoot: string;
  cacheRoot: string;
  resources: readonly ResourceBinding[];
  width: number;
  height: number;
  color: ReferenceColorProfile | "legacy";
  surfaceCacheByteLimit: number;
  localPaintCacheBytes: number;
  staticMediaGradeCacheBytes: number;
  staticMediaGradeHandoffMode: "copied" | "immutable-lease";
  privateStraightCompositeMode?: "automatic" | "forced-js-fast" | "forced-scalar";
  privateLocalPaintAlphaBoundsMode?: "automatic" | "forced-full-surface";
  performanceDiagnostic?: Readonly<{
    format: "cut-reference-preview-picture-worker-performance-diagnostic";
    version: 1;
    nativeConcurrency: number;
  }>;
  fault?: WorkerFault;
}>;

type RenderChunk = Readonly<{
  type: "render";
  requestId: number;
  sceneId: string;
  firstGlobalFrame: number;
  firstSceneFrame: number;
  frames: number;
}>;

type ParentMessage = RenderChunk | Readonly<{ type: "close" }>;

function digestHandle(handle: Awaited<ReturnType<typeof open>>) {
  return new Promise<string>((accept, reject) => {
    const sha = createHash("sha256");
    handle.createReadStream({ autoClose: false, start: 0 })
      .on("data", (chunk) => sha.update(chunk))
      .on("error", reject)
      .on("end", () => accept(sha.digest("hex")));
  });
}

function stableIdentity(stat: Readonly<{
  dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint;
}>) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function serializedError(error: unknown) {
  const candidate = error instanceof Error ? error : new Error(String(error));
  return Object.freeze({
    name: candidate.name,
    message: candidate.message,
    stack: candidate.stack,
    code: "code" in candidate && typeof candidate.code === "string" ? candidate.code : undefined,
  });
}

function assertResourceIdentities(resources: readonly ResourceBinding[]) {
  for (const resource of resources) {
    const current = lstatSync(resource.path, { bigint: true });
    if (current.isSymbolicLink()
      || JSON.stringify(stableIdentity(current)) !== JSON.stringify(resource.identity)
      || realpathSync(resource.path) !== resource.physicalPath) {
      throw new Error(`CUT_PREVIEW_PICTURE_WORKER_RESOURCE: resource ${resource.id} changed after worker authentication.`);
    }
  }
}

async function validateBootstrap(input: WorkerBootstrap) {
  if (input.format !== "cut-reference-preview-picture-worker-bootstrap" || input.version !== 1) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: invalid bootstrap envelope.");
  }
  if (input.performanceDiagnostic !== undefined
    && (Object.keys(input.performanceDiagnostic).sort().join(",") !== "format,nativeConcurrency,version"
      || input.performanceDiagnostic.format !== "cut-reference-preview-picture-worker-performance-diagnostic"
      || input.performanceDiagnostic.version !== 1
      || !Number.isSafeInteger(input.performanceDiagnostic.nativeConcurrency)
      || input.performanceDiagnostic.nativeConcurrency < 1
      || input.performanceDiagnostic.nativeConcurrency > 1_024)) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: invalid private performance diagnostic authority.");
  }
  if (!Number.isSafeInteger(input.staticMediaGradeCacheBytes)
    || input.staticMediaGradeCacheBytes < 4
    || input.staticMediaGradeCacheBytes > maximumStaticMediaGradeCacheBytes) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: static media grade cache bytes exceed the closed renderer limit.");
  }
  if (input.staticMediaGradeHandoffMode !== "copied"
    && input.staticMediaGradeHandoffMode !== "immutable-lease") {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: static media grade handoff mode is invalid.");
  }
  if (input.privateStraightCompositeMode !== undefined
    && input.privateStraightCompositeMode !== "automatic"
    && input.privateStraightCompositeMode !== "forced-js-fast"
    && input.privateStraightCompositeMode !== "forced-scalar") {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: private compositor mode is invalid.");
  }
  if (input.privateLocalPaintAlphaBoundsMode !== undefined
    && input.privateLocalPaintAlphaBoundsMode !== "automatic"
    && input.privateLocalPaintAlphaBoundsMode !== "forced-full-surface") {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: private LocalSpace paint alpha-bounds mode is invalid.");
  }
  const ownBytes = await readFile(__filename);
  if (createHash("sha256").update(ownBytes).digest("hex") !== input.workerModuleSha256) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_IDENTITY: static worker module bytes changed after parent admission.");
  }
  if (input.runtimeIdentity !== cutReferenceRuntimeIdentity) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_IDENTITY: runtime identity differs from the parent authority.");
  }
  if (createCutBuiltinImplementationIdentity("cut:visual").integrity !== input.implementationIntegrity) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_IDENTITY: visual implementation closure differs from the parent authority.");
  }
  const visualPackage = builtinPackages.get("cut:visual");
  if (!visualPackage || visualPackage.integrity !== input.packageIntegrity) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_IDENTITY: visual package manifest differs from the parent authority.");
  }
  if ((await collectReferenceBackendIdentity()).integrity !== input.backendIntegrity) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_IDENTITY: native backend closure differs from the parent authority.");
  }
  for (const resource of input.resources) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(resource.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const [before, pathBefore] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(resource.path, { bigint: true }),
      ]);
      if (!before.isFile() || pathBefore.isSymbolicLink()
        || JSON.stringify(stableIdentity(before)) !== JSON.stringify(resource.identity)
        || JSON.stringify(stableIdentity(pathBefore)) !== JSON.stringify(resource.identity)
        || Number(before.size) !== resource.bytes
        || await realpath(resource.path) !== resource.physicalPath
        || await digestHandle(handle) !== resource.sha256) {
        throw new Error(`CUT_PREVIEW_PICTURE_WORKER_RESOURCE: verified resource ${resource.id} changed identity or bytes.`);
      }
      const [after, pathAfter] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(resource.path, { bigint: true }),
      ]);
      if (JSON.stringify(stableIdentity(after)) !== JSON.stringify(resource.identity)
        || JSON.stringify(stableIdentity(pathAfter)) !== JSON.stringify(resource.identity)) {
        throw new Error(`CUT_PREVIEW_PICTURE_WORKER_RESOURCE: verified resource ${resource.id} changed during authentication.`);
      }
    } finally {
      await handle?.close();
    }
  }
  // IR identity validation itself recomputes executable graph hashes, which
  // deliberately requires invocation-local selected-media authority. Restore
  // that authority from the authenticated parent envelope before asking the
  // strict loader to evaluate selected resource semantics.
  registerReferenceMediaProfileExecutionAuthority(input.ir, input.mediaProfileAuthority);
  const ir = validateCutAvIr(input.ir);
  if (hash(ir) !== input.irSemanticHash) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_IDENTITY: cloned locked IR differs from the parent semantic authority.");
  }
  const irVisualModule = ir.modules.find((module) => module.specifier === "cut:visual");
  if (!irVisualModule || irVisualModule.integrity !== input.packageIntegrity) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_IDENTITY: cloned IR cut:visual module is not bound to the current visual package manifest.");
  }
  registerAppliedCutLockIr(ir);
  return ir;
}

async function main() {
  const mainStartedAt = performance.now();
  const input = workerData as WorkerBootstrap;
  if (!parentPort) throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: worker has no parent port.");
  const port = parentPort;
  if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "prepare-exit") process.exit(91);
  if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "prepare-error") {
    throw new Error("injected preview worker prepare failure");
  }
  const authenticationStartedAt = performance.now();
  const ir = await validateBootstrap(input);
  const authenticationEndedAt = performance.now();
  const composition = ir.compositions.find((candidate) => candidate.id === input.compositionId);
  if (!composition) throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: admitted composition is missing after strict IR load.");
  const resources = new Map(input.resources.map((resource) => [resource.id, resource.path]));
  const rendererConstructionStartedAt = performance.now();
  const renderer = new ReferenceVisualRenderer(
    ir,
    composition,
    input.projectRoot,
    input.cacheRoot,
    (resourceId) => {
      const resource = input.resources.find((candidate) => candidate.id === resourceId);
      const path = resources.get(resourceId);
      if (!path || !resource) throw new Error(`CUT_PREVIEW_PICTURE_WORKER_RESOURCE: renderer requested unauthenticated resource ${resourceId}.`);
      const current = lstatSync(path, { bigint: true });
      if (current.isSymbolicLink()
        || JSON.stringify(stableIdentity(current)) !== JSON.stringify(resource.identity)
        || realpathSync(path) !== resource.physicalPath) {
        throw new Error(`CUT_PREVIEW_PICTURE_WORKER_RESOURCE: resource ${resourceId} changed before renderer open.`);
      }
      return path;
    },
    undefined,
    1,
    {
      sharedLocalPaintSurfaceCache: new ReferenceLocalPaintSurfaceCache(input.localPaintCacheBytes),
      staticMediaGradeCacheByteLimit: input.staticMediaGradeCacheBytes,
      staticMediaGradeHandoffMode: input.staticMediaGradeHandoffMode,
      privateStraightCompositeMode: input.privateStraightCompositeMode,
      privateLocalPaintAlphaBoundsMode: input.privateLocalPaintAlphaBoundsMode,
      surfaceCacheByteLimit: input.surfaceCacheByteLimit,
      lazyNestedCompositionPreparation: true,
    },
  );
  const rendererConstructionEndedAt = performance.now();
  const rendererPrepareStartedAt = performance.now();
  await renderer.prepare();
  const rendererPrepareEndedAt = performance.now();
  const observedNativeConcurrency = input.performanceDiagnostic === undefined
    ? undefined
    : sharp.concurrency();
  if (observedNativeConcurrency !== undefined
    && observedNativeConcurrency !== input.performanceDiagnostic!.nativeConcurrency) {
    throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: worker Sharp concurrency differs from its authenticated parent expectation.");
  }
  const readyDiagnostic = input.performanceDiagnostic === undefined
    ? undefined
    : Object.freeze({
      nativeConcurrency: observedNativeConcurrency!,
      bootstrapAuthenticationMs: authenticationEndedAt - authenticationStartedAt,
      rendererConstructionMs: rendererConstructionEndedAt - rendererConstructionStartedAt,
      rendererPrepareMs: rendererPrepareEndedAt - rendererPrepareStartedAt,
      workerActiveMs: rendererPrepareEndedAt - mainStartedAt,
    });
  port.postMessage(readyDiagnostic === undefined
    ? Object.freeze({ type: "ready", workerIndex: input.workerIndex })
    : Object.freeze({ type: "ready", workerIndex: input.workerIndex, diagnostic: readyDiagnostic }));
  if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "ready-duplicate") {
    port.postMessage(Object.freeze({ type: "ready", workerIndex: input.workerIndex }));
  }
  if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "closed-early") {
    port.postMessage(Object.freeze({ type: "closed", workerIndex: input.workerIndex }));
  }
  let tail = Promise.resolve();
  let lastActiveEndAt = performance.now();
  port.on("message", (message: ParentMessage) => {
    tail = tail.then(async () => {
      const messageReceivedAt = performance.now();
      const idleBeforeMs = messageReceivedAt - lastActiveEndAt;
      if (!message || typeof message !== "object" || !("type" in message)) {
        throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: malformed parent message.");
      }
      if (message.type === "close") {
        if (Object.keys(message).sort().join(",") !== "type") {
          throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: close message has unknown fields.");
        }
        if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "close-hang") {
          await new Promise(() => undefined);
          return;
        }
        if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "close-error") {
          throw new Error("injected preview worker close failure");
        }
        if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "close-nonzero") process.exit(92);
        await renderer.closeAndWait();
        if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "close-no-receipt") {
          port.close();
          return;
        }
        port.postMessage(Object.freeze({ type: "closed", workerIndex: input.workerIndex }));
        if (input.fault?.workerIndex === input.workerIndex && input.fault.phase === "closed-duplicate") {
          port.postMessage(Object.freeze({ type: "closed", workerIndex: input.workerIndex }));
        }
        port.close();
        return;
      }
      if (Object.keys(message).sort().join(",") !== "firstGlobalFrame,firstSceneFrame,frames,requestId,sceneId,type"
        || !Number.isSafeInteger(message.requestId) || message.requestId < 0
        || typeof message.sceneId !== "string" || message.sceneId.length < 1
        || !Number.isSafeInteger(message.firstGlobalFrame) || message.firstGlobalFrame < 0
        || !Number.isSafeInteger(message.firstSceneFrame) || message.firstSceneFrame < 0
        || !Number.isSafeInteger(message.frames) || message.frames < 1 || message.frames > 2) {
        throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: render message violates the exact two-frame protocol.");
      }
      if (input.fault?.workerIndex === input.workerIndex
        && input.fault.phase === "chunk-hang"
        && (input.fault.globalFrame === undefined || input.fault.globalFrame === message.firstGlobalFrame)) {
        await new Promise(() => undefined);
        return;
      }
      if (input.fault?.workerIndex === input.workerIndex
        && input.fault.phase === "chunk-error"
        && (input.fault.globalFrame === undefined || input.fault.globalFrame === message.firstGlobalFrame)) {
        throw new Error("injected preview worker chunk failure");
      }
      const eventLoopStart = performance.eventLoopUtilization();
      const workerActiveStartedAt = performance.now();
      const resourceRevalidationStartedAt = performance.now();
      assertResourceIdentities(input.resources);
      const resourceRevalidationEndedAt = performance.now();
      const scene = ir.scenes[message.sceneId];
      if (!scene) throw new Error(`CUT_PREVIEW_PICTURE_WORKER_CONTRACT: missing scene ${message.sceneId}.`);
      const frames: Array<Readonly<{
        globalFrame: number;
        sceneFrame: number;
        surface: ArrayBuffer;
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
      }>> = [];
      let sceneFrameMs = 0;
      let resizeMs = 0;
      let colorMs = 0;
      let arrayBufferCopyMs = 0;
      for (let offset = 0; offset < message.frames; offset += 1) {
        const globalFrame = message.firstGlobalFrame + offset;
        const sceneFrame = message.firstSceneFrame + offset;
        const sceneFrameStartedAt = performance.now();
        const compositeBefore = renderer.referencePrivateStraightCompositeEvidence();
        const cacheBefore = renderer.referenceStaticMediaGradeCacheEvidence();
        const rendered = await renderer.sceneFrame(scene, sceneFrame);
        const compositeAfter = renderer.referencePrivateStraightCompositeEvidence();
        const cacheAfter = renderer.referenceStaticMediaGradeCacheEvidence();
        const staticGradeCache = Object.freeze({
          hit: cacheAfter.hit - cacheBefore.hit,
          miss: cacheAfter.miss - cacheBefore.miss,
          bypassCapacity: cacheAfter.bypassCapacity - cacheBefore.bypassCapacity,
          bypassDynamic: cacheAfter.bypassDynamic - cacheBefore.bypassDynamic,
          residentCopies: cacheAfter.residentCopies - cacheBefore.residentCopies,
          residentCopyRgbaBytes: cacheAfter.residentCopyRgbaBytes - cacheBefore.residentCopyRgbaBytes,
          handoffCopies: cacheAfter.handoffCopies - cacheBefore.handoffCopies,
          handoffRgbaBytes: cacheAfter.handoffRgbaBytes - cacheBefore.handoffRgbaBytes,
          leaseHandoffs: cacheAfter.leaseHandoffs - cacheBefore.leaseHandoffs,
          leaseRgbaBytes: cacheAfter.leaseRgbaBytes - cacheBefore.leaseRgbaBytes,
        });
        if (Object.values(staticGradeCache).some((value) => !Number.isSafeInteger(value) || value < 0)) {
          throw new Error("CUT_PREVIEW_PICTURE_WORKER_CONTRACT: shared static-grade cache counters regressed during one frame.");
        }
        const privateStraightComposite = compositeAfter
          ? Object.freeze({
            mode: compositeAfter.mode,
            executions: compositeAfter.executions - (compositeBefore?.executions ?? 0),
            fastNormalStraightPixels: compositeAfter.fastNormalStraightPixels - (compositeBefore?.fastNormalStraightPixels ?? 0),
            scalarPixels: compositeAfter.scalarPixels - (compositeBefore?.scalarPixels ?? 0),
            quantizerBoundaryFallbacks: compositeAfter.quantizerBoundaryFallbacks - (compositeBefore?.quantizerBoundaryFallbacks ?? 0),
            nativeExecutions: compositeAfter.nativeExecutions - (compositeBefore?.nativeExecutions ?? 0),
            nativeFastNormalStraightPixels: compositeAfter.nativeFastNormalStraightPixels - (compositeBefore?.nativeFastNormalStraightPixels ?? 0),
          })
          : Object.freeze({
            mode: "unobserved" as const,
            executions: 0,
            fastNormalStraightPixels: 0,
            scalarPixels: 0,
            quantizerBoundaryFallbacks: 0,
            nativeExecutions: 0,
            nativeFastNormalStraightPixels: 0,
          });
        const sceneFrameEndedAt = performance.now();
        const resizeStartedAt = performance.now();
        const resized = input.width === rendered.width && input.height === rendered.height
          ? Buffer.from(rendered.data)
          : await sharp(Buffer.from(rendered.data), { raw: { width: rendered.width, height: rendered.height, channels: 4 } })
            .resize(input.width, input.height, { fit: "fill", kernel: "lanczos3" })
            .ensureAlpha().raw().toBuffer();
        const resizeEndedAt = performance.now();
        const colorStartedAt = performance.now();
        const colored = input.color === "legacy" || input.color === "srgb"
          ? resized
          : Buffer.from(convertReferenceColorSurface(
            { data: resized, width: input.width, height: input.height },
            "srgb",
            input.color === "rec709-limited" ? "rec709-full" : input.color,
          ).data);
        const colorEndedAt = performance.now();
        const arrayBufferCopyStartedAt = performance.now();
        const surface = colored.buffer.slice(colored.byteOffset, colored.byteOffset + colored.byteLength) as ArrayBuffer;
        const arrayBufferCopyEndedAt = performance.now();
        sceneFrameMs += sceneFrameEndedAt - sceneFrameStartedAt;
        resizeMs += resizeEndedAt - resizeStartedAt;
        colorMs += colorEndedAt - colorStartedAt;
        arrayBufferCopyMs += arrayBufferCopyEndedAt - arrayBufferCopyStartedAt;
        frames.push(Object.freeze({
          globalFrame,
          sceneFrame,
          surface,
          staticGradeCache,
          privateStraightComposite,
        }));
      }
      const fault = input.fault?.workerIndex === input.workerIndex ? input.fault.phase : undefined;
      const diagnosticFrames = frames.map((frame, index) => {
        if (index !== 0) return frame;
        if (fault === "chunk-cache-negative") return Object.freeze({
          ...frame,
          staticGradeCache: Object.freeze({ ...frame.staticGradeCache, hit: -1 }),
        });
        if (fault === "chunk-cache-noninteger") return Object.freeze({
          ...frame,
          staticGradeCache: Object.freeze({ ...frame.staticGradeCache, hit: 0.5 }),
        });
        if (fault === "chunk-cache-extra") return Object.freeze({
          ...frame,
          staticGradeCache: Object.freeze({ ...frame.staticGradeCache, hostile: 1 }),
        });
        if (fault === "chunk-cache-excessive") return Object.freeze({
          ...frame,
          staticGradeCache: Object.freeze({ ...frame.staticGradeCache, hit: 33 }),
        });
        if (fault === "chunk-composite-mode") return Object.freeze({
          ...frame,
          privateStraightComposite: Object.freeze({ ...frame.privateStraightComposite, mode: "hostile" }),
        });
        if (fault === "chunk-composite-noninteger") return Object.freeze({
          ...frame,
          privateStraightComposite: Object.freeze({ ...frame.privateStraightComposite, executions: 0.5 }),
        });
        if (fault === "chunk-composite-extra") return Object.freeze({
          ...frame,
          privateStraightComposite: Object.freeze({ ...frame.privateStraightComposite, hostile: 1 }),
        });
        if (fault === "chunk-composite-relation") return Object.freeze({
          ...frame,
          privateStraightComposite: Object.freeze({
            ...frame.privateStraightComposite,
            mode: "forced-scalar",
            fastNormalStraightPixels: 1,
            quantizerBoundaryFallbacks: 4,
          }),
        });
        return frame;
      });
      const emitted = fault === "chunk-reorder"
        ? [...diagnosticFrames].reverse()
        : fault === "chunk-extra"
          ? [...diagnosticFrames, Object.freeze({ ...diagnosticFrames.at(-1)!, globalFrame: diagnosticFrames.at(-1)!.globalFrame + 1 })]
          : fault === "chunk-wrong-size"
            ? [Object.freeze({ ...diagnosticFrames[0]!, surface: diagnosticFrames[0]!.surface.slice(0, Math.max(0, diagnosticFrames[0]!.surface.byteLength - 4)) }), ...diagnosticFrames.slice(1)]
            : diagnosticFrames;
      const workerActiveEndedAt = performance.now();
      const eventLoop = performance.eventLoopUtilization(eventLoopStart);
      const diagnostic = input.performanceDiagnostic === undefined
        ? undefined
        : Object.freeze({
          nativeConcurrency: sharp.concurrency(),
          idleBeforeMs,
          resourceRevalidationMs: resourceRevalidationEndedAt - resourceRevalidationStartedAt,
          sceneFrameMs,
          resizeMs,
          colorMs,
          arrayBufferCopyMs,
          workerActiveMs: workerActiveEndedAt - workerActiveStartedAt,
          eventLoopIdleMs: eventLoop.idle,
          eventLoopActiveMs: eventLoop.active,
          eventLoopUtilization: eventLoop.utilization,
        });
      const response = Object.freeze({
        type: "chunk" as const,
        requestId: fault === "chunk-wrong-request" ? message.requestId + 1_000_000 : message.requestId,
        workerIndex: input.workerIndex,
        sceneId: fault === "chunk-wrong-subject" ? `${message.sceneId}-hostile` : message.sceneId,
        firstGlobalFrame: message.firstGlobalFrame,
        firstSceneFrame: message.firstSceneFrame,
        frameCount: message.frames,
        frames: emitted,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      });
      const responseTransfers = [...new Set(emitted.map((frame) => frame.surface))];
      const duplicate = fault === "chunk-duplicate"
        ? Object.freeze({
          ...response,
          frames: Object.freeze(emitted.map((frame) => Object.freeze({
            ...frame,
            surface: frame.surface.slice(0),
          }))),
        })
        : undefined;
      port.postMessage(response, responseTransfers);
      lastActiveEndAt = performance.now();
      if (fault === "ready-late") {
        port.postMessage(Object.freeze({ type: "ready", workerIndex: input.workerIndex }));
      }
      if (fault === "chunk-duplicate") {
        port.postMessage(duplicate!, duplicate!.frames.map((frame) => frame.surface));
      }
    }).catch(async (error) => {
      await renderer.closeAndWait().catch(() => undefined);
      port.postMessage(Object.freeze({ type: "failure", error: serializedError(error) }));
      port.close();
    });
  });
}

void main().catch((error) => {
  parentPort?.postMessage(Object.freeze({ type: "failure", error: serializedError(error) }));
  parentPort?.close();
});
