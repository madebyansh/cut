import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CutAVIR, IRComposition } from "../../language/ir";
import {
  addRational,
  compareRational,
  decimalRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
} from "../../language/rational";
import { stableJsonStringify } from "../../core/stable";
import {
  ensureProjectWriteDirectory,
  publishStagedFileTransaction,
  publishStagedFileTransactionForTest,
  writeProjectArtifacts,
  type StagedFileTransactionTestHooks,
} from "../../project/write-boundary";
import { cutReferenceRuntimeIdentity } from "../../version";
import { cutSignalContentHash, finalizeGraphHashes } from "../graph";
import { normalizeReferenceAudio, referenceMasterAudioRootIds, renderReferenceAudioSelection } from "./audio";
import {
  readReferenceAudioSelectionFromCache,
  type ReferenceAudioCacheSelectionEvidence,
} from "./audio-cache";
import { scanReferenceStereoF32LeFile } from "./audio-peak";
import {
  bindReferencePictureMediaToolchain,
  type ReferencePictureMediaToolchainIdentity,
} from "./picture-media-toolchain";
import type { ReferenceColorProfile } from "./color-management";
import { prepareReferenceAacDelivery, type PreparedReferenceAacDelivery } from "./delivery";
import { deriveReferenceMasteringTarget, referenceMasteringPeakSource } from "./mastering";
import type { ReferenceMediaProfile, ReferenceMediaProfileEvidence } from "./media-profile";
import { collectReferenceBackendIdentity, type CutReferenceBackendIdentity } from "./runtime-identity";
import { assertCutLockReferenceBackendIdentity } from "../../language/lock";
import { planReferenceAudioStems, type ReferenceStemRoute } from "./stems";
import {
  referenceReachableCompositionNodes,
  validateReferencePictureSession,
  validateReferenceSession,
} from "./validate";
import { ReferenceVisualRenderer } from "./visual";
import { prepareReferenceVerifiedInputSession, type ReferenceVerifiedInputSession } from "./verified-input-session";
import {
  ReferencePlanarTrackFrameEvidenceError,
  validateReferencePlanarTrackFrameEvidenceSemantics,
} from "./planar-track-evidence";
import {
  currentReferenceFrameExecutionEvidenceProfile,
  validateCurrentReferenceFrameLocalSpaceExecutionTree,
  validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics,
} from "./local-space-frame-evidence";
import { validateReferenceCalloutFrameEvidenceSemantics } from "./callout";
import { validateReferenceResponsiveSlotMediaAnchorFrameEvidence } from "./responsive-slot-media-anchor";
import {
  validateReferenceIdentityComponentFragments,
} from "./identity-component-fragment";
import {
  validateReferenceIdentityComponentFragmentFrameEvidence,
} from "./identity-component-fragment-evidence";
import {
  renderReferencePreviewPictureArtifact,
  type ReferencePreviewPictureCacheEvidence,
  type ReferencePreviewPictureParallelPlan,
  type ReferencePreviewPictureTestHooks,
} from "./preview-picture-cache";

export type ReferenceAuthoringReviewErrorCode =
  | "CUT_REVIEW_TOOL_CONTRACT"
  | "CUT_REVIEW_TOOL_IR_IDENTITY"
  | "CUT_REVIEW_TOOL_TIME"
  | "CUT_REVIEW_TOOL_TIME_GRID"
  | "CUT_REVIEW_TOOL_FRAME_RANGE"
  | "CUT_REVIEW_TOOL_FRAME_ORDER"
  | "CUT_REVIEW_TOOL_SAMPLE_RANGE"
  | "CUT_REVIEW_TOOL_RESOURCE_LIMIT"
  | "CUT_REVIEW_TOOL_OUTPUT"
  | "CUT_REVIEW_TOOL_STEM"
  | "CUT_REVIEW_TOOL_WAVE";

export class ReferenceAuthoringReviewError extends Error {
  constructor(readonly code: ReferenceAuthoringReviewErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceAuthoringReviewError";
  }
}

function fail(code: ReferenceAuthoringReviewErrorCode, message: string): never {
  throw new ReferenceAuthoringReviewError(code, message);
}

const maximumSelectorBytes = 4_096;
const maximumContactFrames = 24;
const maximumContactColumns = 8;
const maximumContactThumbWidth = 1_024;
const maximumContactPixels = 32 * 1_024 * 1_024;
const maximumAuditionSeconds = 120;
const maximumAuditionWaveBytes = 128 * 1_024 * 1_024;
const maximumAnchoredPathFrameEvidence = 4_096;

type ClosedOptions = Record<string, unknown>;

function closedOptions(value: unknown, allowed: readonly string[], label: string): ClosedOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("CUT_REVIEW_TOOL_CONTRACT", `${label} options must be one plain data object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value), accepted = new Set(allowed);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !accepted.has(key)) fail("CUT_REVIEW_TOOL_CONTRACT", `${label} options contain unsupported property ${JSON.stringify(String(key))}.`);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set) fail("CUT_REVIEW_TOOL_CONTRACT", `${label} option ${JSON.stringify(key)} must be an inert data property.`);
  }
  return value as ClosedOptions;
}

function textOption(value: unknown, label: string, maximumBytes = maximumSelectorBytes) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("CUT_REVIEW_TOOL_CONTRACT", `${label} must be one bounded non-empty string without NUL bytes.`);
  }
  return value;
}

function mediaProfile(value: unknown): ReferenceMediaProfile {
  const selected = value ?? "master";
  if (selected !== "master" && selected !== "proxy") fail("CUT_REVIEW_TOOL_CONTRACT", `mediaProfile must be exactly "master" or "proxy".`);
  return selected;
}

function lockDigest(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("CUT_REVIEW_TOOL_CONTRACT", "lockSha256 must be one lowercase SHA-256 digest.");
  return value;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalLockedIr(ir: CutAVIR) {
  const identityCheck = structuredClone(ir);
  for (const signal of Object.values(identityCheck.signals)) signal.contentHash = cutSignalContentHash(signal);
  try { finalizeGraphHashes(identityCheck); }
  catch (error) { fail("CUT_REVIEW_TOOL_IR_IDENTITY", `cannot derive canonical graph identity: ${error instanceof Error ? error.message : String(error)}`); }
  if (identityCheck.buildId !== ir.buildId) fail("CUT_REVIEW_TOOL_IR_IDENTITY", "CutAVIR buildId is stale; rebuild and reapply the lock after semantic edits.");
  // The clone is identity evidence only. Execution must retain the original
  // invocation-local applyCutLock authority instead of laundering a validated
  // serialized graph into a fresh authority.
  return ir;
}

type PreparedReviewSession = Readonly<{
  canonicalBuildId: string;
  executionBuildId: string;
  ir: CutAVIR;
  composition: IRComposition;
  output: { name: string; color: ReferenceColorProfile | "legacy" };
  media: ReferenceMediaProfileEvidence;
  backend: CutReferenceBackendIdentity;
  pathFor: ReferenceVerifiedInputSession["pathFor"];
  cleanup: ReferenceVerifiedInputSession["cleanup"];
}>;

async function prepareReviewSession(
  ir: CutAVIR,
  projectRoot: string,
  outputName: unknown,
  requestedProfile: unknown,
  lockedReferenceBackend: CutReferenceBackendIdentity | undefined,
  validationScope: "picture" | "full",
): Promise<PreparedReviewSession> {
  // Validate caller-owned scalars before graph/resource/native work so a bad
  // selector cannot be masked by unrelated media drift or backend discovery.
  const selectedOutput = outputName === undefined ? undefined : textOption(outputName, "outputName");
  const selectedProfile = mediaProfile(requestedProfile);
  const validate = validationScope === "picture" ? validateReferencePictureSession : validateReferenceSession;
  const canonical = canonicalLockedIr(ir), canonicalSession = validate(canonical, selectedOutput);
  const verifiedInputs = await prepareReferenceVerifiedInputSession(canonical, projectRoot, selectedProfile);
  try {
    const backend = await collectReferenceBackendIdentity();
    if (lockedReferenceBackend) assertCutLockReferenceBackendIdentity(lockedReferenceBackend, backend);
    const executionSession = validate(verifiedInputs.ir, canonicalSession.output.name);
    return {
      canonicalBuildId: canonical.buildId,
      executionBuildId: verifiedInputs.ir.buildId,
      ir: verifiedInputs.ir,
      composition: executionSession.composition,
      output: { name: executionSession.output.name, color: executionSession.outputContract.color },
      media: verifiedInputs.media,
      backend,
      pathFor: verifiedInputs.pathFor,
      cleanup: verifiedInputs.cleanup,
    };
  } catch (error) {
    await verifiedInputs.cleanup();
    throw error;
  }
}

function exactCompositionFrames(composition: IRComposition) {
  const exact = multiplyRational(composition.duration, composition.fps);
  if (exact.denominator !== "1") fail("CUT_REVIEW_TOOL_TIME_GRID", `timeline ${JSON.stringify(composition.name)} duration does not land on its exact frame grid.`);
  const frames = Number(exact.numerator);
  if (!Number.isSafeInteger(frames) || frames < 1) fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", "timeline frame count is not one bounded positive safe integer.");
  return frames;
}

/** Parse a CLI-authored exact non-negative time. Decimal and rational s/ms forms are accepted. */
export function parseReferenceReviewTime(value: unknown): Rational {
  const source = textOption(value, "exact time", 128);
  const match = /^(?:(\d{1,24})(?:\/(\d{1,24}))?|(\d{1,18}(?:\.\d{1,18})?))(ms|s)$/u.exec(source);
  if (!match) fail("CUT_REVIEW_TOOL_TIME", "exact time must use non-negative decimal or rational seconds/milliseconds, for example 1250ms, 1.25s, or 1001/24000s.");
  let magnitude: Rational;
  try {
    magnitude = match[3] !== undefined ? decimalRational(match[3]) : rational(match[1]!, match[2] ?? "1");
  } catch {
    fail("CUT_REVIEW_TOOL_TIME", "exact time contains an invalid rational value.");
  }
  return match[4] === "ms" ? divideRational(magnitude, rational(1_000)) : magnitude;
}

function frameNumber(value: unknown) {
  const source = typeof value === "number" ? String(value) : textOption(value, "frame index", 32);
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(source)) fail("CUT_REVIEW_TOOL_TIME", "frame index must be one non-negative decimal safe integer.");
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed)) fail("CUT_REVIEW_TOOL_TIME", "frame index exceeds the safe-integer boundary.");
  return parsed;
}

type NormalizedFrameSelector = Readonly<{ kind: "frame"; frame: number } | { kind: "time"; at: Rational }>;

function normalizeFrameSelector(selector: { frame?: unknown; at?: unknown }): NormalizedFrameSelector {
  if ((selector.frame === undefined) === (selector.at === undefined)) fail("CUT_REVIEW_TOOL_CONTRACT", "select exactly one of frame or at.");
  return selector.frame !== undefined
    ? { kind: "frame", frame: frameNumber(selector.frame) }
    : { kind: "time", at: parseReferenceReviewTime(selector.at) };
}

function frameFromSelector(composition: IRComposition, selector: NormalizedFrameSelector) {
  let frame: number;
  if (selector.kind === "frame") frame = selector.frame;
  else {
    const at = selector.at, exact = multiplyRational(at, composition.fps);
    if (exact.denominator !== "1") fail("CUT_REVIEW_TOOL_TIME_GRID", `time ${at.numerator}/${at.denominator}s does not land on the ${composition.fps.numerator}/${composition.fps.denominator} fps frame grid; CUT never rounds review times.`);
    frame = Number(exact.numerator);
    if (!Number.isSafeInteger(frame)) fail("CUT_REVIEW_TOOL_TIME", "selected time produces a frame index outside the safe-integer boundary.");
  }
  const total = exactCompositionFrames(composition);
  if (frame < 0 || frame >= total) fail("CUT_REVIEW_TOOL_FRAME_RANGE", `frame ${frame} is outside the half-open composition frame interval [0, ${total}).`);
  return frame;
}

/** Parse a comma-separated, strictly increasing list of exact frame indices. */
export function parseReferenceContactFrames(value: unknown) {
  const source = textOption(value, "contact frames");
  const tokens = source.split(",");
  if (!tokens.length || tokens.length > maximumContactFrames || tokens.some((token) => token.length === 0 || token.trim() !== token)) {
    fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `contact frames must contain 1–${maximumContactFrames} comma-separated frame indices without whitespace.`);
  }
  const frames = tokens.map(frameNumber);
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index] <= frames[index - 1]) fail("CUT_REVIEW_TOOL_FRAME_ORDER", "contact frames must be unique and strictly increasing so forward media decoding cannot silently reorder authored review points.");
  }
  return frames;
}

/** Parse one exact half-open interleaved-frame/sample interval START:END. */
export function parseReferenceSampleRange(value: unknown) {
  const source = textOption(value, "sample range", 128), match = /^(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15})$/u.exec(source);
  if (!match) fail("CUT_REVIEW_TOOL_SAMPLE_RANGE", "sample range must be START:END using non-negative decimal sample indices and half-open semantics.");
  const start = Number(match[1]), end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) fail("CUT_REVIEW_TOOL_SAMPLE_RANGE", "sample range must be a non-empty half-open safe-integer interval with END greater than START.");
  return { start, end };
}

function selectedScene(ir: CutAVIR, composition: IRComposition, frame: number) {
  const time = rational(BigInt(frame) * BigInt(composition.fps.denominator), composition.fps.numerator);
  const scene = composition.sceneIds.map((id) => ir.scenes[id]).find((candidate) => candidate
    && compareRational(time, candidate.start) >= 0
    && compareRational(time, addRational(candidate.start, candidate.duration)) < 0);
  if (!scene) fail("CUT_REVIEW_TOOL_FRAME_RANGE", `frame ${frame} is not covered by an authored scene in timeline ${JSON.stringify(composition.name)}.`);
  const sceneStart = multiplyRational(scene.start, composition.fps);
  if (sceneStart.denominator !== "1") fail("CUT_REVIEW_TOOL_TIME_GRID", `scene ${JSON.stringify(scene.name)} start does not land on the exact frame grid.`);
  const local = BigInt(frame) - BigInt(sceneStart.numerator);
  if (local < 0n || local > BigInt(Number.MAX_SAFE_INTEGER)) fail("CUT_REVIEW_TOOL_FRAME_RANGE", "scene-local frame is outside the safe-integer boundary.");
  return { scene, localFrame: Number(local), time };
}

async function exactFrameSurface(session: PreparedReviewSession, projectRoot: string, frame: number, renderer?: ReferenceVisualRenderer) {
  const selection = selectedScene(session.ir, session.composition, frame);
  const cacheRoot = await ensureProjectWriteDirectory(projectRoot, ".cut/cache/reference");
  const ownedRenderer = renderer ?? new ReferenceVisualRenderer(session.ir, session.composition, projectRoot, cacheRoot, session.pathFor);
  try {
    if (!renderer) await ownedRenderer.prepare();
    const surface = await ownedRenderer.sceneFrame(selection.scene, selection.localFrame);
    const geoAnnotations = ownedRenderer.referenceGeoAnnotationEvidence();
    const calloutLayers = Object.freeze(
      ownedRenderer.referenceCalloutLayerEvidence()
        .map((receipt) => validateReferenceCalloutFrameEvidenceSemantics(receipt)),
    );
    const mapCameras = ownedRenderer.referenceMapCameraEvidence();
    const camera3Ds = ownedRenderer.referenceCamera3DEvidence();
    const mediaCamera2Ds = ownedRenderer.referenceMediaCamera2DEvidence();
    const responsiveStacks = ownedRenderer.referenceResponsiveStackEvidence();
    const responsiveSlotMediaAnchors =
      ownedRenderer.referenceResponsiveSlotMediaAnchorEvidence();
    const identityComponentFragments =
      ownedRenderer.referenceIdentityComponentFragmentEvidence();
    const retainedMediaViewports = ownedRenderer.referenceRetainedMediaViewportEvidence();
    const retainedMediaCompositions = ownedRenderer.referenceRetainedMediaCompositionEvidence();
    const retainedMediaLocalCompositors = ownedRenderer.referenceRetainedMediaLocalCompositorEvidence();
    const diagramLayouts = ownedRenderer.referenceDiagramLayoutEvidence();
    const planarReceipts = ownedRenderer.referencePlanarTrackEvidence();
    const planarContexts = ownedRenderer.referencePlanarTrackEvidenceTrustedContexts();
    if (planarReceipts.length !== planarContexts.length) {
      throw new ReferencePlanarTrackFrameEvidenceError("$.trustedContext", "completed PlanarTrack receipts do not have one independently retained locked live-frame context each.");
    }
    const planarTracks = Object.freeze(planarReceipts
      .map((receipt, index) => validateReferencePlanarTrackFrameEvidenceSemantics(receipt, {
        trustedContext: planarContexts[index]!,
        outputWidth: surface.width,
        outputHeight: surface.height,
        minimumExactTime: selection.scene.start,
        maximumExactTime: addRational(selection.scene.start, selection.scene.duration),
        outputFrame: String(frame),
      })));
    const localSpace = ownedRenderer.referenceLocalSpaceEvidence();
    if (!localSpace) throw new Error("CUT_LOCAL_SPACE_RASTER: a completed exact-frame render did not publish its LocalSpace execution receipt.");
    // One top-level renderer emits one completed-frame receipt, even when the
    // frame contains no LocalSpace nodes (the zero counters are meaningful).
    // Keep the public field plural so independently identified nested renderer
    // receipts can be added without changing the frame-manifest shape.
    const localSpaces = Object.freeze([localSpace]);
    const localSpaceTransformPreflight = ownedRenderer.referenceLocalSpaceCompositionTransformPreflightEvidence();
    if (!localSpaceTransformPreflight) {
      throw new Error("CUT_LOCAL_SPACE_RASTER: a completed exact-frame render did not publish its composition-wide affine transform preflight receipt.");
    }
    const localTime = rational(
      BigInt(selection.localFrame) * BigInt(session.composition.fps.denominator),
      session.composition.fps.numerator,
    );
    if (localSpaceTransformPreflight.compositionId !== session.composition.id
      || localSpaceTransformPreflight.sceneId !== selection.scene.id
      || compareRational(localSpaceTransformPreflight.exactTime, localTime) !== 0
      || localSpaceTransformPreflight.outputFrame !== String(frame)) {
      throw new Error(
        `CUT_LOCAL_SPACE_RASTER: completed affine transform preflight does not match composition ${session.composition.id}, scene ${selection.scene.id}, local time ${localTime.numerator}/${localTime.denominator}, output frame ${frame}.`,
      );
    }
    const localSpaceExecutionTree = ownedRenderer.referenceLocalSpaceRendererFrameExecutionTreeEvidence();
    const localSpaceExecutions = validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics(
      ownedRenderer.referenceLocalSpaceRendererFrameExecutionEvidence(),
      {
        ir: session.ir,
        rootCompositionId: session.composition.id,
        treeEvidence: localSpaceExecutionTree,
        trustedAuthority: ownedRenderer.referenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority(),
      },
    );
    const anchoredPaths = ownedRenderer.referenceAnchoredPathEvidence();
    if (anchoredPaths.length > maximumAnchoredPathFrameEvidence) {
      fail(
        "CUT_REVIEW_TOOL_RESOURCE_LIMIT",
        `one exact frame may publish at most ${maximumAnchoredPathFrameEvidence} anchored Path/MotionPath execution receipts.`,
      );
    }
    validateReferenceResponsiveSlotMediaAnchorFrameEvidence(
      responsiveSlotMediaAnchors,
      session.composition.id,
      anchoredPaths,
      calloutLayers,
      mediaCamera2Ds,
      responsiveStacks,
    );
    const identityComponentFragmentConfigs =
      validateReferenceIdentityComponentFragments(
        session.ir,
        session.composition,
        referenceReachableCompositionNodes(session.ir, session.composition),
      );
    if (identityComponentFragments.length
      !== identityComponentFragmentConfigs.size) {
      throw new Error(
        "CUT_IDENTITY_FRAGMENT_EVIDENCE: completed frame fragment receipt count does not match the authenticated graph.",
      );
    }
    const seenIdentityComponentFragments = new Set<string>();
    for (const evidence of identityComponentFragments) {
      const config = identityComponentFragmentConfigs.get(
        evidence.fragmentNodeId,
      );
      if (!config || seenIdentityComponentFragments.has(evidence.fragmentNodeId)) {
        throw new Error(
          `CUT_IDENTITY_FRAGMENT_EVIDENCE: completed frame contains a missing, foreign, or duplicate fragment receipt ${evidence.fragmentNodeId}.`,
        );
      }
      seenIdentityComponentFragments.add(evidence.fragmentNodeId);
      validateReferenceIdentityComponentFragmentFrameEvidence(
        evidence,
        config,
        {
          anchoredPaths,
          calloutLayers,
          cameras: mediaCamera2Ds,
          responsiveStacks,
          slotMediaAnchorLinks: responsiveSlotMediaAnchors,
        },
        createHash("sha256").update(surface.data).digest("hex"),
      );
    }
    const semanticMatches = ownedRenderer.referenceSemanticMatchEvidence();
    return { surface, geoAnnotations, calloutLayers, mapCameras, camera3Ds, mediaCamera2Ds, responsiveStacks, responsiveSlotMediaAnchors, identityComponentFragments, retainedMediaViewports, retainedMediaCompositions, retainedMediaLocalCompositors, diagramLayouts, planarTracks, localSpaces, localSpaceTransformPreflight, localSpaceExecutionTree, localSpaceExecutions, anchoredPaths, semanticMatches, ...selection };
  } finally {
    if (!renderer) await ownedRenderer.closeAndWait();
  }
}

async function pngBytes(data: Uint8Array, width: number, height: number) {
  const sharpModule = await import("sharp"), sharp = sharpModule.default ?? sharpModule;
  return sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

function outputPath(projectRoot: string, value: unknown, extension: ".png" | ".wav" | ".mp4") {
  const path = resolve(textOption(value, "output path", 16_384)), local = relative(resolve(projectRoot), path);
  if (!path.toLowerCase().endsWith(extension)) fail("CUT_REVIEW_TOOL_OUTPUT", `output path must end in ${extension}.`);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) fail("CUT_REVIEW_TOOL_OUTPUT", "review output must remain inside the CUT source project root.");
  return path;
}

function commonManifest(session: PreparedReviewSession, lockSha256: string | undefined) {
  return {
    runtime: cutReferenceRuntimeIdentity,
    backend: session.backend,
    buildId: session.canonicalBuildId,
    executionBuildId: session.executionBuildId,
    outputContract: session.output,
    lock: { resourcesVerified: true as const, ...(lockSha256 ? { sha256: lockSha256 } : {}) },
    media: session.media,
  };
}

export type ReferenceFrameManifest = ReturnType<typeof commonManifest> & {
  format: "cut-reference-frame";
  version: 2;
  /** Present only when the rendered graph executes shaped FlowText. */
  features?: NonNullable<CutAVIR["features"]>;
  artifact: { file: string; sha256: string; bytes: number; rgbaSha256: string };
  canvas: { width: number; height: number; fps: Rational; pixelFormat: "rgba8"; pngColor: "srgb" };
  frame: { index: number; timestamp: Rational; sceneId: string; scene: string; sceneFrame: number };
  execution: {
    evidenceProfile: typeof currentReferenceFrameExecutionEvidenceProfile;
    geoAnnotations: ReturnType<ReferenceVisualRenderer["referenceGeoAnnotationEvidence"]>;
    calloutLayers?: ReturnType<ReferenceVisualRenderer["referenceCalloutLayerEvidence"]>;
    mapCameras: ReturnType<ReferenceVisualRenderer["referenceMapCameraEvidence"]>;
    camera3Ds?: ReturnType<ReferenceVisualRenderer["referenceCamera3DEvidence"]>;
    mediaCamera2Ds?: ReturnType<ReferenceVisualRenderer["referenceMediaCamera2DEvidence"]>;
    responsiveStacks: ReturnType<ReferenceVisualRenderer["referenceResponsiveStackEvidence"]>;
    responsiveSlotMediaAnchors?: ReturnType<ReferenceVisualRenderer["referenceResponsiveSlotMediaAnchorEvidence"]>;
    identityComponentFragments?: ReturnType<ReferenceVisualRenderer["referenceIdentityComponentFragmentEvidence"]>;
    retainedMediaViewports: ReturnType<ReferenceVisualRenderer["referenceRetainedMediaViewportEvidence"]>;
    retainedMediaCompositions: ReturnType<ReferenceVisualRenderer["referenceRetainedMediaCompositionEvidence"]>;
    retainedMediaLocalCompositors?: ReturnType<ReferenceVisualRenderer["referenceRetainedMediaLocalCompositorEvidence"]>;
    diagramLayouts: ReturnType<ReferenceVisualRenderer["referenceDiagramLayoutEvidence"]>;
    planarTracks: ReturnType<ReferenceVisualRenderer["referencePlanarTrackEvidence"]>;
    localSpaces: readonly NonNullable<ReturnType<ReferenceVisualRenderer["referenceLocalSpaceEvidence"]>>[];
    localSpaceTransformPreflight: NonNullable<ReturnType<ReferenceVisualRenderer["referenceLocalSpaceCompositionTransformPreflightEvidence"]>>;
    localSpaceExecutionTree: ReturnType<ReferenceVisualRenderer["referenceLocalSpaceRendererFrameExecutionTreeEvidence"]>;
    localSpaceExecutions: ReturnType<typeof validateReferenceLocalSpaceRendererFrameExecutionTreeSemantics>;
    anchoredPaths?: ReturnType<ReferenceVisualRenderer["referenceAnchoredPathEvidence"]>;
    semanticMatches?: ReturnType<ReferenceVisualRenderer["referenceSemanticMatchEvidence"]>;
  };
};

export async function renderReferenceFrameArtifact(ir: CutAVIR, projectRoot: string, destination: string, authoredOptions: unknown) {
  const options = closedOptions(authoredOptions, ["frame", "at", "outputName", "mediaProfile", "lockSha256", "__lockedReferenceBackend"], "frame");
  const output = outputPath(projectRoot, destination, ".png"), digest = lockDigest(options.lockSha256);
  const selector = normalizeFrameSelector({ frame: options.frame, at: options.at });
  const session = await prepareReviewSession(ir, projectRoot, options.outputName, options.mediaProfile, options.__lockedReferenceBackend as CutReferenceBackendIdentity | undefined, "picture");
  try {
  const frame = frameFromSelector(session.composition, selector);
  const rendered = await exactFrameSurface(session, projectRoot, frame);
  const png = await pngBytes(rendered.surface.data, rendered.surface.width, rendered.surface.height);
  const manifest: ReferenceFrameManifest = {
    format: "cut-reference-frame",
    version: 2,
    ...commonManifest(session, digest),
    ...(session.ir.features ? { features: session.ir.features } : {}),
    artifact: { file: basename(output), sha256: sha256(png), bytes: png.byteLength, rgbaSha256: sha256(rendered.surface.data) },
    canvas: { width: rendered.surface.width, height: rendered.surface.height, fps: session.composition.fps, pixelFormat: "rgba8", pngColor: "srgb" },
    frame: { index: frame, timestamp: rendered.time, sceneId: rendered.scene.id, scene: rendered.scene.name, sceneFrame: rendered.localFrame },
    execution: {
      evidenceProfile: currentReferenceFrameExecutionEvidenceProfile,
      geoAnnotations: rendered.geoAnnotations,
      ...(rendered.calloutLayers.length ? { calloutLayers: rendered.calloutLayers } : {}),
      mapCameras: rendered.mapCameras,
      ...(rendered.camera3Ds.length ? { camera3Ds: rendered.camera3Ds } : {}),
      ...(rendered.mediaCamera2Ds.length ? { mediaCamera2Ds: rendered.mediaCamera2Ds } : {}),
      responsiveStacks: rendered.responsiveStacks,
      ...(rendered.responsiveSlotMediaAnchors.length
        ? { responsiveSlotMediaAnchors: rendered.responsiveSlotMediaAnchors }
        : {}),
      ...(rendered.identityComponentFragments.length
        ? { identityComponentFragments: rendered.identityComponentFragments }
        : {}),
      retainedMediaViewports: rendered.retainedMediaViewports,
      retainedMediaCompositions: rendered.retainedMediaCompositions,
      ...(rendered.retainedMediaLocalCompositors.length ? { retainedMediaLocalCompositors: rendered.retainedMediaLocalCompositors } : {}),
      diagramLayouts: rendered.diagramLayouts,
      planarTracks: rendered.planarTracks,
      localSpaces: rendered.localSpaces,
      localSpaceTransformPreflight: rendered.localSpaceTransformPreflight,
      localSpaceExecutionTree: rendered.localSpaceExecutionTree,
      localSpaceExecutions: rendered.localSpaceExecutions,
      ...(rendered.anchoredPaths.length ? { anchoredPaths: rendered.anchoredPaths } : {}),
      ...(rendered.semanticMatches.length ? { semanticMatches: rendered.semanticMatches } : {}),
    },
  };
  validateCurrentReferenceFrameLocalSpaceExecutionTree(manifest);
  await session.cleanup();
  await writeProjectArtifacts([projectRoot], [
    { destination: output, contents: png, order: 100, role: "review-frame" },
    { destination: `${output}.manifest.json`, contents: `${stableJsonStringify(manifest)}\n`, order: 200, role: "review-frame-manifest" },
  ]);
  return manifest;
  } finally {
    await session.cleanup();
  }
}

const glyphs: Readonly<Record<string, readonly string[]>> = Object.freeze({
  F: ["111", "100", "110", "100", "100"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
});

type LabelClip = Readonly<{ left: number; top: number; right: number; bottom: number }>;

function paintLabel(target: Buffer, width: number, height: number, x: number, y: number, label: string, clip: LabelClip) {
  const scale = 2;
  for (const character of label) {
    const glyph = glyphs[character];
    if (!glyph) { x += 4 * scale; continue; }
    for (let row = 0; row < glyph.length; row += 1) for (let column = 0; column < 3; column += 1) {
      if (glyph[row][column] !== "1") continue;
      for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
        const pixelX = x + column * scale + dx, pixelY = y + row * scale + dy;
        if (pixelX < clip.left || pixelX >= clip.right || pixelY < clip.top || pixelY >= clip.bottom || pixelX < 0 || pixelX >= width || pixelY < 0 || pixelY >= height) continue;
        const offset = (pixelY * width + pixelX) * 4;
        target[offset] = 238; target[offset + 1] = 242; target[offset + 2] = 247; target[offset + 3] = 255;
      }
    }
    x += 4 * scale;
  }
}

/** @internal Deterministic hostile-label coverage without exporting a product API. */
export function rasterReferenceContactLabelForTest(width: number, height: number, label: string, clip: LabelClip) {
  const data = Buffer.alloc(width * height * 4);
  paintLabel(data, width, height, clip.left, clip.top, label, clip);
  return { data, label };
}

function integerOption(value: unknown, label: string, minimum: number, maximum: number, fallback: number) {
  if (value === undefined) return fallback;
  const source = typeof value === "number" ? String(value) : textOption(value, label, 32);
  if (!/^[1-9][0-9]{0,8}$/u.test(source)) fail("CUT_REVIEW_TOOL_CONTRACT", `${label} must be a positive decimal integer.`);
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `${label} must be from ${minimum} through ${maximum}.`);
  return parsed;
}

export type ReferenceContactManifest = ReturnType<typeof commonManifest> & {
  format: "cut-reference-contact-sheet";
  version: 1;
  /** Present only when the rendered graph executes shaped FlowText. */
  features?: NonNullable<CutAVIR["features"]>;
  artifact: { file: string; sha256: string; bytes: number };
  layout: { columns: number; rows: number; thumbnailWidth: number; thumbnailHeight: number; labelHeight: number; gutter: number; width: number; height: number; resizeKernel: "lanczos3"; labelRaster: "cut-3x5-v1" };
  canvas: { width: number; height: number; fps: Rational; pixelFormat: "rgba8"; pngColor: "srgb" };
  frames: Array<{ index: number; timestamp: Rational; sceneId: string; scene: string; sceneFrame: number; rgbaSha256: string; label: string }>;
};

export async function renderReferenceContactSheetArtifact(ir: CutAVIR, projectRoot: string, destination: string, authoredOptions: unknown) {
  const options = closedOptions(authoredOptions, ["frames", "columns", "thumbnailWidth", "outputName", "mediaProfile", "lockSha256", "__lockedReferenceBackend"], "contact");
  const output = outputPath(projectRoot, destination, ".png"), digest = lockDigest(options.lockSha256);
  const frames = parseReferenceContactFrames(options.frames);
  const columns = integerOption(options.columns, "columns", 1, maximumContactColumns, Math.min(4, frames.length));
  const requestedThumbnailWidth = options.thumbnailWidth === undefined ? undefined : integerOption(options.thumbnailWidth, "thumbnailWidth", 64, maximumContactThumbWidth, 64);
  const session = await prepareReviewSession(ir, projectRoot, options.outputName, options.mediaProfile, options.__lockedReferenceBackend as CutReferenceBackendIdentity | undefined, "picture");
  try {
  const total = exactCompositionFrames(session.composition);
  if (frames.some((frame) => frame >= total)) fail("CUT_REVIEW_TOOL_FRAME_RANGE", `contact frames must remain inside the half-open composition interval [0, ${total}).`);
  const defaultWidth = Math.min(maximumContactThumbWidth, Math.max(64, session.composition.width));
  const thumbnailWidth = requestedThumbnailWidth ?? defaultWidth;
  const thumbnailHeight = Math.max(1, Math.round(session.composition.height * thumbnailWidth / session.composition.width));
  const labelHeight = 20, gutter = 8, rows = Math.ceil(frames.length / columns);
  const width = columns * thumbnailWidth + (columns - 1) * gutter, height = rows * (thumbnailHeight + labelHeight) + (rows - 1) * gutter;
  if (width > 8_192 || height > 8_192 || width * height > maximumContactPixels) fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `contact sheet exceeds the bounded 8192px edge / ${maximumContactPixels}-pixel review surface.`);

  const sheet = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < sheet.length; offset += 4) { sheet[offset] = 8; sheet[offset + 1] = 11; sheet[offset + 2] = 15; sheet[offset + 3] = 255; }
  const entries: ReferenceContactManifest["frames"] = [];
  const sharpModule = await import("sharp"), sharp = sharpModule.default ?? sharpModule;
  // Each requested frame owns one renderer. Extraction is still sequential,
  // but an authored cut/reverse/freeze cannot make a forward-only decoder or
  // mutable frame memo from one review point leak into the next one.
  for (const [index, frame] of frames.entries()) {
    const rendered = await exactFrameSurface(session, projectRoot, frame);
    const resized = await sharp(Buffer.from(rendered.surface.data), { raw: { width: rendered.surface.width, height: rendered.surface.height, channels: 4 } })
      .resize(thumbnailWidth, thumbnailHeight, { fit: "fill", kernel: "lanczos3" })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const column = index % columns, row = Math.floor(index / columns), left = column * (thumbnailWidth + gutter), top = row * (thumbnailHeight + labelHeight + gutter);
    for (let y = 0; y < thumbnailHeight; y += 1) resized.copy(sheet, ((top + y) * width + left) * 4, y * thumbnailWidth * 4, (y + 1) * thumbnailWidth * 4);
    const label = `F${frame}`;
    paintLabel(sheet, width, height, left + 6, top + thumbnailHeight + 5, label, {
      left,
      top: top + thumbnailHeight,
      right: left + thumbnailWidth,
      bottom: top + thumbnailHeight + labelHeight,
    });
    entries.push({ index: frame, timestamp: rendered.time, sceneId: rendered.scene.id, scene: rendered.scene.name, sceneFrame: rendered.localFrame, rgbaSha256: sha256(rendered.surface.data), label });
  }
  const png = await pngBytes(sheet, width, height);
  const manifest: ReferenceContactManifest = {
    format: "cut-reference-contact-sheet",
    version: 1,
    ...commonManifest(session, digest),
    ...(session.ir.features ? { features: session.ir.features } : {}),
    artifact: { file: basename(output), sha256: sha256(png), bytes: png.byteLength },
    layout: { columns, rows, thumbnailWidth, thumbnailHeight, labelHeight, gutter, width, height, resizeKernel: "lanczos3", labelRaster: "cut-3x5-v1" },
    canvas: { width: session.composition.width, height: session.composition.height, fps: session.composition.fps, pixelFormat: "rgba8", pngColor: "srgb" },
    frames: entries,
  };
  await session.cleanup();
  await writeProjectArtifacts([projectRoot], [
    { destination: output, contents: png, order: 100, role: "review-contact-sheet" },
    { destination: `${output}.manifest.json`, contents: `${stableJsonStringify(manifest)}\n`, order: 200, role: "review-contact-sheet-manifest" },
  ]);
  return manifest;
  } finally {
    await session.cleanup();
  }
}

function inspectPcm24WaveBytes(bytes: Buffer, expectedSampleRate: number, expectedSamples: number) {
  const read = (start: number, length: number) => {
    if (start < 0 || length < 0 || start + length > bytes.length) fail("CUT_REVIEW_TOOL_WAVE", "audition WAVE contains a truncated chunk.");
    return bytes.subarray(start, start + length);
  };
  if (bytes.length < 44 || bytes.length > maximumAuditionWaveBytes || read(0, 4).toString("ascii") !== "RIFF" || read(8, 4).toString("ascii") !== "WAVE") {
    fail("CUT_REVIEW_TOOL_WAVE", "audition output is not one bounded classic RIFF/WAVE byte stream.");
  }
  if (bytes.readUInt32LE(4) !== bytes.length - 8) fail("CUT_REVIEW_TOOL_WAVE", "audition WAVE RIFF size does not bind the complete byte stream.");
  let cursor = 12, format: {
    chunkBytes: number;
    code: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bits: number;
    cbSize?: number;
    validBits?: number;
    channelMask?: number;
    subformatGuid?: string;
  } | undefined, dataBytes: number | undefined;
  while (cursor + 8 <= bytes.length && (!format || dataBytes === undefined)) {
    const id = read(cursor, 4).toString("ascii"), size = read(cursor + 4, 4).readUInt32LE(0), body = cursor + 8;
    const value = read(body, size);
    if (id === "fmt ") {
      if (size < 16) fail("CUT_REVIEW_TOOL_WAVE", "audition WAVE has a short format chunk.");
      const code = value.readUInt16LE(0);
      format = {
        chunkBytes: size,
        code,
        channels: value.readUInt16LE(2),
        sampleRate: value.readUInt32LE(4),
        byteRate: value.readUInt32LE(8),
        blockAlign: value.readUInt16LE(12),
        bits: value.readUInt16LE(14),
        ...(code === 0xfffe && size >= 40 ? {
          cbSize: value.readUInt16LE(16),
          validBits: value.readUInt16LE(18),
          channelMask: value.readUInt32LE(20),
          subformatGuid: value.subarray(24, 40).toString("hex"),
        } : {}),
      };
    } else if (id === "data") dataBytes = size;
    cursor = body + size + (size % 2);
  }
  const pcmFormat = format && (
    (format.code === 1 && format.chunkBytes === 16)
    || (format.code === 0xfffe
      && format.chunkBytes === 40
      && format.cbSize === 22
      && format.validBits === 24
      && format.channelMask === 3
      && format.subformatGuid === "0100000000001000800000aa00389b71")
  );
  if (!format || !pcmFormat || dataBytes === undefined || format.channels !== 2 || format.sampleRate !== expectedSampleRate || format.byteRate !== expectedSampleRate * 6 || format.blockAlign !== 6 || format.bits !== 24 || dataBytes !== expectedSamples * 6) {
    fail("CUT_REVIEW_TOOL_WAVE", `audition output violates the exact ${expectedSampleRate} Hz stereo signed-24-bit PCM / ${expectedSamples}-sample contract.`);
  }
}

/** @internal Closed byte-fixture entry point for hostile WAVE conformance tests. */
export function inspectReferencePcm24WaveBytesForTest(bytes: Buffer, expectedSampleRate: number, expectedSamples: number) {
  inspectPcm24WaveBytes(bytes, expectedSampleRate, expectedSamples);
}

async function inspectPcm24Wave(path: string, expectedSampleRate: number, expectedSamples: number) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 44 || metadata.size > maximumAuditionWaveBytes) fail("CUT_REVIEW_TOOL_WAVE", "audition output is not one bounded regular WAVE file.");
    const bytes = await readFile(path);
    inspectPcm24WaveBytes(bytes, expectedSampleRate, expectedSamples);
    return { bytes, fileBytes: metadata.size };
  } finally { await handle.close(); }
}

function selectedStem(ir: CutAVIR, composition: IRComposition, name: unknown): ReferenceStemRoute | undefined {
  if (name === undefined) return undefined;
  const requested = textOption(name, "stem", 64), plan = planReferenceAudioStems(ir, composition);
  const route = plan.routes.find((candidate) => candidate.name === requested);
  if (!route) fail("CUT_REVIEW_TOOL_STEM", `unknown authored stem ${JSON.stringify(requested)}; available stems: ${plan.routes.map((candidate) => candidate.name).join(", ") || "none"}.`);
  return route;
}

export type ReferenceAudioAuditionManifest = ReturnType<typeof commonManifest> & {
  format: "cut-reference-audio-audition";
  version: 1;
  artifact: { file: string; sha256: string; bytes: number; sampleFormat: "s24le"; channels: 2; sampleRate: number; samples: number };
  range: { semantics: "half-open"; startSample: number; endSample: number; start: Rational; end: Rational; duration: Rational };
  selection: { kind: "master"; stage: "authored-master-pre-delivery"; rootIds: string[] } | { kind: "stem"; stage: "pre-master-bus-stem"; name: string; nodeId: string; role?: string; graphHash: string };
  execution: { roots: number; filters: number; limiter: unknown };
};

export async function renderReferenceAudioAuditionArtifact(ir: CutAVIR, projectRoot: string, destination: string, authoredOptions: unknown) {
  const options = closedOptions(authoredOptions, ["samples", "stem", "outputName", "mediaProfile", "lockSha256", "__lockedReferenceBackend"], "audition");
  const output = outputPath(projectRoot, destination, ".wav"), digest = lockDigest(options.lockSha256);
  const range = parseReferenceSampleRange(options.samples), requestedStem = options.stem === undefined ? undefined : textOption(options.stem, "stem", 64);
  const session = await prepareReviewSession(ir, projectRoot, options.outputName, options.mediaProfile, options.__lockedReferenceBackend as CutReferenceBackendIdentity | undefined, "full");
  try {
  const totalExact = multiplyRational(session.composition.duration, rational(session.composition.sampleRate));
  if (totalExact.denominator !== "1") fail("CUT_REVIEW_TOOL_SAMPLE_RANGE", "timeline duration does not land on the exact audio sample grid.");
  const total = Number(totalExact.numerator), sampleCount = range.end - range.start;
  if (!Number.isSafeInteger(total) || range.end > total) fail("CUT_REVIEW_TOOL_SAMPLE_RANGE", `sample range must remain inside the half-open composition interval [0, ${totalExact.numerator}).`);
  if (sampleCount > session.composition.sampleRate * maximumAuditionSeconds || sampleCount * 6 > maximumAuditionWaveBytes) {
    fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `audition range exceeds the ${maximumAuditionSeconds}-second / ${maximumAuditionWaveBytes}-byte review limit.`);
  }
  const stem = selectedStem(session.ir, session.composition, requestedStem), rootIds = stem ? [stem.nodeId] : referenceMasterAudioRootIds(session.ir, session.composition);
  if (!rootIds.length) fail("CUT_REVIEW_TOOL_STEM", "selected timeline has no authored audible master roots.");
  const stagingRoot = await ensureProjectWriteDirectory(projectRoot, ".cut/review-staging"), staging = await mkdtemp(resolve(stagingRoot, ".cut-audition-")), temporary = resolve(staging, "audition.wav");
  try {
    const execution = await renderReferenceAudioSelection(session.ir, session.composition, projectRoot, temporary, rootIds, {
      outputFormat: "pcm24-wave",
      bitExactWave: true,
      sampleRange: range,
      __verifiedResourcePath: session.pathFor,
    });
    const inspected = await inspectPcm24Wave(temporary, session.composition.sampleRate, sampleCount), bytes = inspected.bytes;
    const start = rational(range.start, session.composition.sampleRate), end = rational(range.end, session.composition.sampleRate), duration = subtractRational(end, start);
    const manifest: ReferenceAudioAuditionManifest = {
      format: "cut-reference-audio-audition",
      version: 1,
      ...commonManifest(session, digest),
      artifact: { file: basename(output), sha256: sha256(bytes), bytes: inspected.fileBytes, sampleFormat: "s24le", channels: 2, sampleRate: session.composition.sampleRate, samples: sampleCount },
      range: { semantics: "half-open", startSample: range.start, endSample: range.end, start, end, duration },
      selection: stem
        ? { kind: "stem", stage: "pre-master-bus-stem", name: stem.name, nodeId: stem.nodeId, ...(stem.role ? { role: stem.role } : {}), graphHash: stem.graphHash }
        : { kind: "master", stage: "authored-master-pre-delivery", rootIds },
      execution: { roots: execution.roots, filters: execution.filters, limiter: execution.limiter },
    };
    await session.cleanup();
    await writeProjectArtifacts([projectRoot], [
      { destination: output, contents: bytes, order: 100, role: "review-audio-audition" },
      { destination: `${output}.manifest.json`, contents: `${stableJsonStringify(manifest)}\n`, order: 200, role: "review-audio-audition-manifest" },
    ]);
    return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
  } finally {
    await session.cleanup();
  }
}

const maximumPreviewSeconds = 300;
const maximumPreviewFrames = 18_000;
const maximumPreviewWidth = 3_840;

/** Parse one exact half-open composition-time interval START:END. */
export function parseReferencePreviewRange(value: unknown) {
  const source = textOption(value, "preview range", 260);
  const separator = source.indexOf(":");
  if (separator <= 0 || separator !== source.lastIndexOf(":") || separator === source.length - 1) {
    fail("CUT_REVIEW_TOOL_TIME", "preview range must be START:END using exact non-negative s/ms times and half-open semantics.");
  }
  const start = parseReferenceReviewTime(source.slice(0, separator));
  const end = parseReferenceReviewTime(source.slice(separator + 1));
  if (compareRational(end, start) <= 0) fail("CUT_REVIEW_TOOL_TIME", "preview range must be a non-empty half-open interval with END greater than START.");
  return { start, end };
}

function exactGridIndex(time: Rational, rate: Rational, label: string) {
  const exact = multiplyRational(time, rate);
  if (exact.denominator !== "1") fail("CUT_REVIEW_TOOL_TIME_GRID", `${label} ${time.numerator}/${time.denominator}s does not land on its exact authored grid; CUT never rounds preview boundaries.`);
  const index = Number(exact.numerator);
  if (!Number.isSafeInteger(index) || index < 0) fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `${label} is outside the bounded safe-integer grid.`);
  return index;
}

function previewWidth(value: unknown, composition: IRComposition) {
  const width = value === undefined
    ? composition.width
    : integerOption(value, "preview width", 64, maximumPreviewWidth, composition.width);
  if (!Number.isSafeInteger(width) || width < 2 || width > maximumPreviewWidth) fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `preview width must be from 2 through ${maximumPreviewWidth}px.`);
  if (width > composition.width) fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `preview width ${width}px would upscale the authored ${composition.width}px canvas.`);
  if (width % 2 !== 0) fail("CUT_REVIEW_TOOL_CONTRACT", "preview width must be even for CUT's deterministic H.264 4:2:0 contract.");
  const heightNumerator = composition.height * width;
  if (!Number.isSafeInteger(heightNumerator) || heightNumerator % composition.width !== 0) {
    fail("CUT_REVIEW_TOOL_CONTRACT", "preview width must preserve the authored aspect ratio at an exact integer output height.");
  }
  const height = heightNumerator / composition.width;
  if (height < 2 || height > maximumPreviewWidth) fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `preview output height must be from 2 through ${maximumPreviewWidth}px.`);
  if (height % 2 !== 0) fail("CUT_REVIEW_TOOL_CONTRACT", "preview width must preserve aspect ratio at a positive even output height for H.264 4:2:0.");
  return width;
}

function normalizedPreviewSelection(composition: IRComposition, rangeValue: unknown, widthValue: unknown) {
  const range = rangeValue === undefined ? { start: rational(0), end: composition.duration } : parseReferencePreviewRange(rangeValue);
  if (compareRational(range.end, composition.duration) > 0) {
    fail("CUT_REVIEW_TOOL_FRAME_RANGE", `preview range ends outside the half-open composition interval [0, ${composition.duration.numerator}/${composition.duration.denominator}s].`);
  }
  const frameRate = rational(composition.fps.numerator, composition.fps.denominator);
  const frameStart = exactGridIndex(range.start, frameRate, "preview start");
  const frameEnd = exactGridIndex(range.end, frameRate, "preview end");
  const sampleRate = rational(composition.sampleRate);
  const sampleStart = exactGridIndex(range.start, sampleRate, "preview start");
  const sampleEnd = exactGridIndex(range.end, sampleRate, "preview end");
  const frames = frameEnd - frameStart, samples = sampleEnd - sampleStart;
  const duration = subtractRational(range.end, range.start);
  if (frames < 1 || samples < 1) fail("CUT_REVIEW_TOOL_TIME_GRID", "preview range must contain at least one exact video frame and one exact audio sample.");
  if (frames > maximumPreviewFrames || compareRational(duration, rational(maximumPreviewSeconds)) > 0) {
    fail("CUT_REVIEW_TOOL_RESOURCE_LIMIT", `bounded range preview supports at most ${maximumPreviewSeconds}s and ${maximumPreviewFrames} frames per invocation.`);
  }
  const width = previewWidth(widthValue, composition), height = composition.height * width / composition.width;
  return { range, duration, frameStart, frameEnd, frames, sampleStart, sampleEnd, samples, width, height };
}

async function fileSha256(path: string) {
  return new Promise<string>((accept, reject) => {
    const digest = createHash("sha256");
    createReadStream(path).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => accept(digest.digest("hex")));
  });
}

export type ReferencePreviewManifest = ReturnType<typeof commonManifest> & {
  format: "cut-reference-range-preview";
  version: 4;
  pictureToolchain: ReferencePictureMediaToolchainIdentity;
  /** Present only when the rendered graph executes shaped FlowText. */
  features?: NonNullable<CutAVIR["features"]>;
  artifact: { file: string; sha256: string; bytes: number; container: "mp4"; videoCodec: "h264"; audioCodec: "aac" };
  range: {
    semantics: "half-open";
    start: Rational;
    end: Rational;
    duration: Rational;
    firstFrame: number;
    endFrameExclusive: number;
    frames: number;
    startSample: number;
    endSampleExclusive: number;
    samples: number;
  };
  clock: { fps: Rational; sampleRate: number; evaluation: "canonical-composition-clock" };
  canvas: { sourceWidth: number; sourceHeight: number; width: number; height: number; resize: "none" | "lanczos3-v1"; aspect: "preserved-exactly" };
  execution: {
    picture: "selected-frames-only";
    audio: "selected-samples-serialized";
    audioState: "full-program-cache-authority-no-graph-execution" | "causal-history-executed-from-zero";
    inputProfile: "proxy";
    cache: ReferencePreviewPictureCacheEvidence;
    audioSource:
      | {
        mode: "full-program-cache-slice";
        graphExecution: "not-executed-this-invocation";
        authorizedCachedBuild: { roots: number; filters: number };
        selection: Extract<ReferenceAudioCacheSelectionEvidence, { status: "hit" }>;
      }
      | {
        mode: "selected-execution";
        graphExecution: "causal-history-from-zero-through-selected-end";
        execution: { roots: number; filters: number };
        selection: Extract<ReferenceAudioCacheSelectionEvidence, { status: "miss" }>;
        artifact: {
          semantics: "half-open";
          startSample: number;
          endSampleExclusive: number;
          samples: number;
          bytes: number;
          sha256: string;
          verification: "selected-execution+exact-f32le+sha256";
        };
      };
  };
  audio: { normalization: unknown; delivery: unknown };
};

export type ReferenceDraftPreviewManifest = ReturnType<typeof commonManifest> & {
  format: "cut-reference-draft-preview";
  version: 1;
  authority: "non-authoritative-draft";
  visibleMark: "CUT DRAFT pixel label";
  pictureToolchain: ReferencePictureMediaToolchainIdentity;
  artifact: { file: string; sha256: string; bytes: number; container: "mp4"; videoCodec: "h264"; audioCodec: "aac" };
  range: {
    semantics: "half-open";
    start: Rational;
    end: Rational;
    duration: Rational;
    firstFrame: number;
    endFrameExclusive: number;
    frames: number;
    startSample: number;
    endSampleExclusive: number;
    samples: number;
  };
  canvas: { sourceWidth: number; sourceHeight: number; width: number; height: number; resize: "none" | "lanczos3-v1"; aspect: "preserved-exactly" };
  execution: {
    inputProfile: "proxy";
    picture: "canonical-selected-frames-with-draft-delivery-encode";
    pictureCache: ReferencePreviewPictureCacheEvidence;
    audio: "selected-f32le-direct-draft-aac";
    audioGraph: { roots: number; filters: number; sha256: string; bytes: number };
    omitted: readonly [
      "loudness-normalization",
      "true-peak-scan",
      "aac-delivery-verification",
      "stems",
      "release-manifest",
    ];
  };
};

const draftGlyphs: Readonly<Record<string, readonly string[]>> = Object.freeze({
  C: Object.freeze(["01111", "10000", "10000", "10000", "10000", "10000", "01111"]),
  U: Object.freeze(["10001", "10001", "10001", "10001", "10001", "10001", "01110"]),
  D: Object.freeze(["11110", "10001", "10001", "10001", "10001", "10001", "11110"]),
  R: Object.freeze(["11110", "10001", "10001", "11110", "10100", "10010", "10001"]),
  A: Object.freeze(["01110", "10001", "10001", "11111", "10001", "10001", "10001"]),
  F: Object.freeze(["11111", "10000", "10000", "11110", "10000", "10000", "10000"]),
  T: Object.freeze(["11111", "00100", "00100", "00100", "00100", "00100", "00100"]),
  " ": Object.freeze(["000", "000", "000", "000", "000", "000", "000"]),
});

async function draftWatermark(path: string) {
  const label = "CUT DRAFT", scale = 3, padding = 7, gap = 1;
  const glyphWidths = [...label].map((glyph) => draftGlyphs[glyph]?.[0]?.length ?? 0);
  if (glyphWidths.some((width) => width < 1)) fail("CUT_REVIEW_TOOL_CONTRACT", "internal draft label contains an unsupported glyph.");
  const width = padding * 2 + (glyphWidths.reduce((sum, value) => sum + value, 0) + gap * (label.length - 1)) * scale;
  const height = padding * 2 + 7 * scale;
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    rgba[offset] = 255; rgba[offset + 1] = 45; rgba[offset + 2] = 137; rgba[offset + 3] = 224;
  }
  let cursor = padding;
  for (const glyph of label) {
    const rows = draftGlyphs[glyph]!;
    for (let row = 0; row < rows.length; row += 1) {
      for (let column = 0; column < rows[row]!.length; column += 1) {
        if (rows[row]![column] !== "1") continue;
        for (let y = 0; y < scale; y += 1) for (let x = 0; x < scale; x += 1) {
          const offset = ((padding + row * scale + y) * width + cursor + column * scale + x) * 4;
          rgba[offset] = 8; rgba[offset + 1] = 12; rgba[offset + 2] = 22; rgba[offset + 3] = 255;
        }
      }
    }
    cursor += (rows[0]!.length + gap) * scale;
  }
  const sharpModule = await import("sharp"), sharp = sharpModule.default ?? sharpModule;
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(path);
}

async function runDraftMux(ffmpeg: string, input: Readonly<{
  picture: string;
  audio: string;
  watermark: string;
  output: string;
  sampleRate: number;
}>) {
  const arguments_ = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", input.picture,
    "-f", "f32le", "-ar", String(input.sampleRate), "-ac", "2", "-i", input.audio,
    "-loop", "1", "-i", input.watermark,
    "-filter_complex", "[0:v][2:v]overlay=16:16:format=auto[v]",
    "-map", "[v]", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", input.output,
  ];
  await new Promise<void>((accept, reject) => {
    const child = spawn(ffmpeg, arguments_, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    let stderrBytes = 0, settled = false, forcedFailure: Error | undefined;
    let forcedKill: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (forcedKill) clearTimeout(forcedKill);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      if (error) reject(error); else accept();
    };
    const interrupted = (signal: string) => {
      if (forcedFailure) return;
      forcedFailure = new Error(`CUT_DRAFT_CANCELLED: draft mux was cancelled by ${signal}.`);
      child.kill("SIGTERM");
      forcedKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const interrupt = () => interrupted("SIGINT"), terminate = () => interrupted("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 1_048_576) {
        forcedFailure = new Error("CUT_DRAFT_MUX_LIMIT: ffmpeg diagnostic output exceeded 1 MiB.");
        child.kill("SIGKILL");
      } else stderr.push(Buffer.from(chunk));
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (forcedFailure) finish(forcedFailure);
      else if (code === 0) finish();
      else finish(new Error(`CUT_DRAFT_MUX: ffmpeg exited ${code ?? signal}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

/**
 * Render a bounded review interval directly from canonical CUT clocks.
 * Picture frames use one immutable content-addressed range artifact keyed by
 * selected-profile scene semantics, exact interval, review canvas, runtime,
 * backend, encoder toolchain and verified input closure. Audio first probes
 * for an exact, already-published full-program pre-master cache hit and slices
 * only the requested bytes after fresh verification. A miss retains the
 * independently executed selected-sample graph and never populates that cache.
 */
export async function renderReferencePreviewArtifact(ir: CutAVIR, projectRoot: string, destination: string, authoredOptions: unknown) {
  const options = closedOptions(authoredOptions, [
    "range", "width", "outputName", "mediaProfile", "lockSha256", "__lockedReferenceBackend",
    "__testAfterInputSnapshot", "__testBeforeInputCleanup", "__testPreparationFault", "__testPublicationHooks",
    "__testPictureHooks",
  ], "preview");
  if (options.mediaProfile !== undefined && options.mediaProfile !== "proxy") fail("CUT_REVIEW_TOOL_CONTRACT", "bounded preview mediaProfile is fixed to proxy.");
  const requestedOutput = outputPath(projectRoot, destination, ".mp4"), digest = lockDigest(options.lockSha256);
  const session = await prepareReviewSession(ir, projectRoot, options.outputName, "proxy", options.__lockedReferenceBackend as CutReferenceBackendIdentity | undefined, "full");
  let sessionCleanupStarted = false;
  const cleanupSession = async () => {
    if (sessionCleanupStarted) return;
    sessionCleanupStarted = true;
    await session.cleanup();
  };
  let staging: string | undefined, delivery: PreparedReferenceAacDelivery | undefined;
  try {
    await (options.__testAfterInputSnapshot as (() => void | Promise<void>) | undefined)?.();
    const selection = normalizedPreviewSelection(session.composition, options.range, options.width);
    const localParent = relative(resolve(projectRoot), dirname(requestedOutput));
    const parent = localParent ? await ensureProjectWriteDirectory(projectRoot, localParent.split(sep).join("/")) : resolve(projectRoot);
    const output = resolve(parent, basename(requestedOutput));
    staging = await mkdtemp(resolve(parent, ".cut-range-preview-"));
    const selectedAudio = resolve(staging, "selected.f32le"), normalizedAudio = resolve(staging, "normalized.wav");
    const cacheRoot = await ensureProjectWriteDirectory(projectRoot, ".cut/cache/reference");
    const sceneToolchain = await bindReferencePictureMediaToolchain();
    const originalPictureHooks = options.__testPictureHooks as ReferencePreviewPictureTestHooks | undefined;
    let releaseAudioStart!: () => void;
    let audioStartReleased = false;
    let overlapEligible = false;
    let writtenPictureFrames = 0;
    const audioStart = new Promise<void>((accept) => {
      releaseAudioStart = () => {
        if (audioStartReleased) return;
        audioStartReleased = true;
        accept();
      };
    });
    const pictureHooks: ReferencePreviewPictureTestHooks = Object.freeze({
      ...originalPictureHooks,
      async plan(value: ReferencePreviewPictureParallelPlan) {
        overlapEligible = value.reason === "production-worker-threads"
          || value.reason === "worker-thread-measurement-override";
        await originalPictureHooks?.plan?.(value);
      },
      async frameWritten(value) {
        await originalPictureHooks?.frameWritten?.(value);
        writtenPictureFrames += 1;
        if (overlapEligible && writtenPictureFrames >= Math.ceil(selection.frames / 2)) releaseAudioStart();
      },
    });
    const picturePromise = renderReferencePreviewPictureArtifact({
      ir: session.ir,
      composition: session.composition,
      projectRoot,
      cacheRoot,
      firstFrame: selection.frameStart,
      endFrameExclusive: selection.frameEnd,
      width: selection.width,
      height: selection.height,
      color: session.output.color,
      backend: session.backend,
      toolchain: sceneToolchain,
      verifiedResourcePath: session.pathFor,
      __testHooks: pictureHooks,
    });
    // Cache hits, serial/stateful ranges, and early picture failures start audio
    // only after the picture branch settles. Eligible worker ranges release it
    // after half the ordered frames publish, limiting native CPU contention
    // while still hiding the exact audio preparation behind the picture tail.
    void picturePromise.then(releaseAudioStart, releaseAudioStart);
    const roots = referenceMasterAudioRootIds(session.ir, session.composition);
    const target = deriveReferenceMasteringTarget(session.ir, session.composition);
    const peakSource = referenceMasteringPeakSource(session.ir, session.composition);
    const audioPreparationPromise = audioStart.then(async () => {
      const cachedSelection = await readReferenceAudioSelectionFromCache(session.ir, session.composition, projectRoot, {
        sampleRange: { start: selection.sampleStart, end: selection.sampleEnd },
        output: selectedAudio,
        samplePeakDbfs: target.samplePeakDbfs,
        source: peakSource,
      });
      let audioSource: ReferencePreviewManifest["execution"]["audioSource"];
      if (cachedSelection.status === "hit") {
        audioSource = Object.freeze({
          mode: "full-program-cache-slice",
          graphExecution: "not-executed-this-invocation",
          authorizedCachedBuild: Object.freeze({ ...cachedSelection.build }),
          selection: cachedSelection.evidence,
        });
      } else {
        const audioExecution = await renderReferenceAudioSelection(session.ir, session.composition, projectRoot, selectedAudio, roots, {
          outputFormat: "raw-stereo-f32le",
          sampleRange: { start: selection.sampleStart, end: selection.sampleEnd },
          __verifiedResourcePath: session.pathFor,
        });
        const selectedSha256 = await fileSha256(selectedAudio);
        audioSource = Object.freeze({
          mode: "selected-execution",
          graphExecution: "causal-history-from-zero-through-selected-end",
          execution: Object.freeze({ roots: audioExecution.roots, filters: audioExecution.filters }),
          selection: cachedSelection.evidence,
          artifact: Object.freeze({
            semantics: "half-open",
            startSample: selection.sampleStart,
            endSampleExclusive: selection.sampleEnd,
            samples: selection.samples,
            bytes: selection.samples * 8,
            sha256: selectedSha256,
            verification: "selected-execution+exact-f32le+sha256",
          }),
        });
      }
      // Keep the bounded authoring path on the same pre-master boundary as a
      // final render. PCM24 WAVE is an intentional delivery/audition format,
      // but quantizing to it before loudness normalization made a full-range
      // preview normalize different samples from the final raw-f32 cache.
      const inputPeak = await scanReferenceStereoF32LeFile(selectedAudio, {
        expectedFrames: selection.samples,
        thresholdDbfs: target.samplePeakDbfs,
        source: peakSource,
      });
      const normalization = await normalizeReferenceAudio(
        selectedAudio,
        normalizedAudio,
        target.integratedLufs,
        target.truePeakDbtp,
        target.loudnessRangeLu,
        session.composition.sampleRate,
        { inputFormat: "raw-stereo-f32le", inputPeak },
      );
      return Object.freeze({
        audioSource,
        audioState: cachedSelection.status === "hit"
          ? "full-program-cache-authority-no-graph-execution" as const
          : "causal-history-executed-from-zero" as const,
        normalization,
        audioToolchain: cachedSelection.evidence.identity.toolchain,
      });
    });
    // Picture workers and the exact audio graph own disjoint staging files.
    // Drain both bounded branches before surfacing either failure so no worker,
    // decoder, limiter, or staging transaction survives a rejected preview.
    const [pictureResult, audioPreparationResult] = await Promise.allSettled([
      picturePromise,
      audioPreparationPromise,
    ]);
    if (pictureResult.status === "rejected") throw pictureResult.reason;
    if (audioPreparationResult.status === "rejected") throw audioPreparationResult.reason;
    const picture = pictureResult.value;
    const { audioSource, audioState, normalization, audioToolchain } = audioPreparationResult.value;
    delivery = await prepareReferenceAacDelivery({
      silentVideo: picture.path,
      normalizedPcm: normalizedAudio,
      stagingRoot: parent,
      target: normalization.target,
      sampleRate: session.composition.sampleRate,
      expectedFrames: selection.samples,
      source: peakSource,
      toolchain: audioToolchain,
    });
    await delivery.verify();
    await (options.__testPreparationFault as (() => void | Promise<void>) | undefined)?.();
    const artifactSha256 = await fileSha256(delivery.artifact), artifactBytes = (await stat(delivery.artifact)).size;
    const manifest: ReferencePreviewManifest = {
      format: "cut-reference-range-preview",
      version: 4,
      pictureToolchain: sceneToolchain.toolchain,
      ...commonManifest(session, digest),
      ...(session.ir.features ? { features: session.ir.features } : {}),
      artifact: { file: basename(output), sha256: artifactSha256, bytes: artifactBytes, container: "mp4", videoCodec: "h264", audioCodec: "aac" },
      range: {
        semantics: "half-open", start: selection.range.start, end: selection.range.end, duration: selection.duration,
        firstFrame: selection.frameStart, endFrameExclusive: selection.frameEnd, frames: selection.frames,
        startSample: selection.sampleStart, endSampleExclusive: selection.sampleEnd, samples: selection.samples,
      },
      clock: { fps: session.composition.fps, sampleRate: session.composition.sampleRate, evaluation: "canonical-composition-clock" },
      canvas: { sourceWidth: session.composition.width, sourceHeight: session.composition.height, width: selection.width, height: selection.height, resize: selection.width === session.composition.width ? "none" : "lanczos3-v1", aspect: "preserved-exactly" },
      execution: {
        picture: "selected-frames-only",
        audio: "selected-samples-serialized",
        audioState,
        inputProfile: "proxy",
        cache: picture.cache,
        audioSource,
      },
      audio: { normalization, delivery: delivery.report },
    };
    const stagedManifest = resolve(staging, "preview.manifest.json");
    await writeFile(stagedManifest, `${stableJsonStringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    await (options.__testBeforeInputCleanup as (() => void | Promise<void>) | undefined)?.();
    await cleanupSession();
    const publications = [
      { staged: delivery.artifact, destination: output, order: 100, role: "range-preview" },
      { staged: stagedManifest, destination: `${output}.manifest.json`, order: 200, role: "range-preview-manifest" },
    ];
    const hooks = options.__testPublicationHooks as StagedFileTransactionTestHooks | undefined;
    if (hooks) await publishStagedFileTransactionForTest(publications, hooks);
    else await publishStagedFileTransaction(publications);
    return manifest;
  } finally {
    await cleanupSession();
    if (delivery) await delivery.cleanup().catch(() => undefined);
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Fast, visibly marked authoring output. This is deliberately not a reference
 * preview: it retains locked proxy inputs and canonical picture evaluation but
 * omits final mastering and delivery verification.
 */
export async function renderReferenceDraftPreviewArtifact(ir: CutAVIR, projectRoot: string, destination: string, authoredOptions: unknown) {
  const options = closedOptions(authoredOptions, [
    "range", "width", "outputName", "mediaProfile", "lockSha256", "__lockedReferenceBackend",
    "__testAfterInputSnapshot", "__testBeforeInputCleanup", "__testPreparationFault", "__testPublicationHooks",
    "__testPictureHooks",
  ], "draft preview");
  if (options.mediaProfile !== undefined && options.mediaProfile !== "proxy") fail("CUT_REVIEW_TOOL_CONTRACT", "draft preview mediaProfile is fixed to proxy.");
  const requestedOutput = outputPath(projectRoot, destination, ".mp4"), digest = lockDigest(options.lockSha256);
  const session = await prepareReviewSession(ir, projectRoot, options.outputName, "proxy", options.__lockedReferenceBackend as CutReferenceBackendIdentity | undefined, "full");
  let sessionCleanupStarted = false, staging: string | undefined;
  const cleanupSession = async () => {
    if (sessionCleanupStarted) return;
    sessionCleanupStarted = true;
    await session.cleanup();
  };
  try {
    await (options.__testAfterInputSnapshot as (() => void | Promise<void>) | undefined)?.();
    const selection = normalizedPreviewSelection(session.composition, options.range, options.width);
    const localParent = relative(resolve(projectRoot), dirname(requestedOutput));
    const parent = localParent ? await ensureProjectWriteDirectory(projectRoot, localParent.split(sep).join("/")) : resolve(projectRoot);
    const output = resolve(parent, basename(requestedOutput));
    staging = await mkdtemp(resolve(parent, ".cut-draft-preview-"));
    const selectedAudio = resolve(staging, "selected.f32le");
    const watermark = resolve(staging, "draft-watermark.png");
    const stagedArtifact = resolve(staging, "draft.mp4");
    const stagedManifest = resolve(staging, "draft.manifest.json");
    const cacheRoot = await ensureProjectWriteDirectory(projectRoot, ".cut/cache/reference");
    const sceneToolchain = await bindReferencePictureMediaToolchain();
    const picture = await renderReferencePreviewPictureArtifact({
      ir: session.ir,
      composition: session.composition,
      projectRoot,
      cacheRoot,
      firstFrame: selection.frameStart,
      endFrameExclusive: selection.frameEnd,
      width: selection.width,
      height: selection.height,
      color: session.output.color,
      backend: session.backend,
      toolchain: sceneToolchain,
      verifiedResourcePath: session.pathFor,
      __testHooks: options.__testPictureHooks as ReferencePreviewPictureTestHooks | undefined,
    });
    const audioExecution = await renderReferenceAudioSelection(
      session.ir,
      session.composition,
      projectRoot,
      selectedAudio,
      referenceMasterAudioRootIds(session.ir, session.composition),
      {
        outputFormat: "raw-stereo-f32le",
        sampleRange: { start: selection.sampleStart, end: selection.sampleEnd },
        __verifiedResourcePath: session.pathFor,
      },
    );
    const audioSha256 = await fileSha256(selectedAudio), audioBytes = (await stat(selectedAudio)).size;
    if (audioBytes !== selection.samples * 8) fail("CUT_REVIEW_TOOL_WAVE", "draft audio output does not contain the exact selected stereo f32le sample count.");
    await draftWatermark(watermark);
    await runDraftMux(sceneToolchain.ffmpegExecutablePath, {
      picture: picture.path,
      audio: selectedAudio,
      watermark,
      output: stagedArtifact,
      sampleRate: session.composition.sampleRate,
    });
    await (options.__testPreparationFault as (() => void | Promise<void>) | undefined)?.();
    const artifactSha256 = await fileSha256(stagedArtifact), artifactBytes = (await stat(stagedArtifact)).size;
    const manifest: ReferenceDraftPreviewManifest = {
      format: "cut-reference-draft-preview",
      version: 1,
      authority: "non-authoritative-draft",
      visibleMark: "CUT DRAFT pixel label",
      pictureToolchain: sceneToolchain.toolchain,
      ...commonManifest(session, digest),
      artifact: { file: basename(output), sha256: artifactSha256, bytes: artifactBytes, container: "mp4", videoCodec: "h264", audioCodec: "aac" },
      range: {
        semantics: "half-open", start: selection.range.start, end: selection.range.end, duration: selection.duration,
        firstFrame: selection.frameStart, endFrameExclusive: selection.frameEnd, frames: selection.frames,
        startSample: selection.sampleStart, endSampleExclusive: selection.sampleEnd, samples: selection.samples,
      },
      canvas: { sourceWidth: session.composition.width, sourceHeight: session.composition.height, width: selection.width, height: selection.height, resize: selection.width === session.composition.width ? "none" : "lanczos3-v1", aspect: "preserved-exactly" },
      execution: {
        inputProfile: "proxy",
        picture: "canonical-selected-frames-with-draft-delivery-encode",
        pictureCache: picture.cache,
        audio: "selected-f32le-direct-draft-aac",
        audioGraph: { roots: audioExecution.roots, filters: audioExecution.filters, sha256: audioSha256, bytes: audioBytes },
        omitted: Object.freeze([
          "loudness-normalization",
          "true-peak-scan",
          "aac-delivery-verification",
          "stems",
          "release-manifest",
        ]),
      },
    };
    await writeFile(stagedManifest, `${stableJsonStringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    await (options.__testBeforeInputCleanup as (() => void | Promise<void>) | undefined)?.();
    await cleanupSession();
    const publications = [
      { staged: stagedArtifact, destination: output, order: 100, role: "draft-preview" },
      { staged: stagedManifest, destination: `${output}.manifest.json`, order: 200, role: "draft-preview-manifest" },
    ];
    const hooks = options.__testPublicationHooks as StagedFileTransactionTestHooks | undefined;
    if (hooks) await publishStagedFileTransactionForTest(publications, hooks);
    else await publishStagedFileTransaction(publications);
    return manifest;
  } finally {
    await cleanupSession();
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
