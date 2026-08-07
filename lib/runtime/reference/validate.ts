import type { CutAVIR, IRComposition, IREditorialInterval, IRNode, IROutput, IRPictureTimeMap, IRSignal, IRValue } from "../../language/ir";
import { kernelAcceptsInput, kernelAcceptsProperty, kernelStringInputValues, referenceKernelSchema } from "../../language/kernel-registry";
import { validateCutVisualPropertyTrackBaselines } from "../../language/visual-property-baselines";
import { addRational, compareRational, divideRational, multiplyRational, rational, rationalToNumber, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { compileReferenceAudioAutomation, compileReferenceCompressorAutomations, compileReferenceDeEsserAutomations, compileReferenceLimiterAutomations, compileReferenceParametricEqAutomations, compileReferenceSidechainAutomations, compileReferenceStateVariableFilterAutomations, compressorAutomationProperties, deEsserAutomationProperties, limiterAutomationProperties, sidechainAutomationProperties, validateReferenceAudioAutomationBudget } from "./audio-automation";
import { validateReferenceTimeStretchPlans } from "./audio-time-stretch";
import { rgbaBlendModes, type RgbaBlendMode } from "./compositing";
import { referenceVisualEffectConfig } from "./visual-effects";
import { validateReferenceSynthPlans } from "./synth";
import {
  referenceCaptionConfig,
  referenceCaptionLimits,
  referenceTranscriptCaptionConfig,
} from "./caption-render";
import { referenceEvidenceConfig, referenceEvidenceLimits } from "./evidence";
import { prepareReferenceTraceNode, referenceTraceEasings, referenceTraceLimits, type ReferenceTraceEasing } from "./trace";
import { referenceStackConfig } from "./layout";
import { validateReferenceEasings } from "./easing";
import { validateCutOutputContract, type CutOutputContract } from "../../language/output-contract";
import { referenceAudioNodeConfig } from "./audio-config";
import { referenceAudioCompositionRootIds, validateReferenceAudioCompositionResources } from "./audio-resource";
import { assertCutGraphExecutionBudget } from "../graph";
import { referenceVisualTransformAt, validateReferenceGeoConfig, validateReferenceVisualReveal, validateReferenceVisualTransform, validateReferenceVisualTransformAllocation } from "./visual-config";
import { referenceShapeNodeConfig } from "./shape-config";
import { referenceChartConfig } from "./chart-config";
import { referenceSeriesChartConfig } from "./series-chart-config";
import { referenceTextConfig, referenceTextLimits } from "./text-config";
import { referenceFlowTextConfig, referenceFlowTextLimits } from "./text-flow";
import { validateReferenceColorGradeConfig } from "./color-grade-config";
import { referenceLutConfig, validateReferenceLutResourceOwnership } from "./lut-config";
import { referenceMaskConfig } from "./mask-config";
import { referenceChromaKeyConfig, validateReferenceChromaKeyCompositionBudget } from "./chroma-key";
import { prepareReferenceClipPath, referenceClipPathConfig, validateReferenceClipPathContextBudget } from "./clip-path";
import { referenceMotionBlurConfig, validateReferenceMotionBlurCompositionBudget } from "./motion-blur";
import { prepareReferenceMotionBlurBoundary } from "./motion-blur-boundary";
import { validateReferenceAudioLimiterPlans } from "./audio-limiter-preparation";
import { validateReferenceTempoDelayPlans } from "./audio-tempo-delay-config";
import { referenceColorConvertConfig, referenceTonalCurveConfig, validateReferenceTonalCurveNodeBudget } from "./color-management";
import type { LockedResourceProbe } from "../../language/lock";
import { referenceVideoConfig, referenceVideoInputColorConfig } from "./video-config";
import { referenceDirectNodeParents, referenceTransitionContract } from "./transition-config";
import { referenceLinkedSplitContract } from "./linked-split-config";
import { evaluateCutDomainAssertions, type CutDomainAssertionResult } from "../../language/domain-assertions";
import { referenceGeoLabelConfig, validateReferenceGeoLabelNodeBudget } from "./geo-labels";
import { validateReferenceNoOpContract } from "./noop-contract";
import { referenceMotionPathTangentRotations, validateReferenceMotionPath } from "./motion-path";
import { planReferenceAudioRouting } from "./audio-routing";
import { stableJsonStringify } from "../../core/stable";
import { PictureTimeMapInputError, authoredPictureTimeMap, canonicalPictureTimeMapInputs, isDefaultPictureTimeMap } from "../../language/picture-time-map";
import { ReferencePictureTimeMapError, referencePictureTimeMapConfig } from "./picture-time-map";
import { validateReferencePictureTrackOperationPlan } from "./picture-edit-operations";
import { validateReferenceAudioTrackOperationPlan } from "./audio-edit-operations";
import { referencePrecompConfig, validateReferencePrecompGraph } from "./precomp-config";
import { validateReferenceLinkedEditTransactions, type ReferenceLinkedEditAuthorizations, type ReferenceLinkedEditSideAuthorization } from "./linked-edit";
import { authorizeReferenceAudioRegion, ReferenceAudioRegionError } from "./audio-region";
import { referenceTrack2DConfig, validateReferenceTrack2DResourceOwnership } from "./tracking-2d";
import { referencePlanarTrackConfig, validateReferencePlanarTrackResourceOwnership } from "./planar-tracking";
import {
  prepareReferenceAnchoredVectorPathNode,
  prepareReferenceVectorPathNode,
  validateReferenceAnchoredVectorPathCompositionStructuralWork,
  validateReferenceAnchoredVectorPathStructuralWork,
  validateReferenceVectorPathCompositionAuthoredWork,
  validateReferenceVectorPathCompositionWork,
  validateReferenceVectorPathFrameStates,
} from "./vector-path";
import {
  decodeReferenceAnchoredPathGeometry,
  isReferenceAnchoredPathGeometryValue,
  validateReferenceAnchoredPathGeometry,
  type ReferenceValidatedAnchoredPathGeometry,
} from "./anchored-path";
import {
  validateReferenceMediaCamera2DGraph,
  type ReferenceMediaCamera2DPlan,
} from "./media-camera2d";
import { validateReferenceParallaxCameraGraph } from "./parallax-camera";
import { validateReferenceGeoAnnotationGraph } from "./geo-annotation";
import {
  createReferenceLocalSpaceStructuralValidationIndex,
  referenceLocalSpaceDescendantContexts,
  referenceLocalSpaceTextLayoutContext,
  validateReferenceLocalSpaceGraph,
  type ReferenceLocalSpaceConfig,
} from "./local-space";
import {
  referenceResponsiveStackDescendantContexts,
  referenceResponsiveStackTextLayoutContext,
  validateReferenceResponsiveStackGraph,
  type ReferenceResponsiveStackLocalContext,
} from "./responsive-layout";
import { validateReferenceIdentityComponentFragments } from "./identity-component-fragment";
import { referenceLinkedAvPresentationPlan } from "./linked-av-presentation";
import {
  referenceTimelineEditTrackOwnership,
  validateReferenceTimelineEditMaterializations,
} from "./timeline-edit";

export type ReferenceSession = { output: IROutput; composition: IRComposition; outputContract: CutOutputContract };

function nodeReferences(value: IRValue, result: Set<string>) {
  if (value.kind === "node-ref") result.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => nodeReferences(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => nodeReferences(item, result));
  else if (value.kind === "range") { nodeReferences(value.start, result); nodeReferences(value.end, result); }
  else if (value.kind === "unary") nodeReferences(value.value, result);
  else if (value.kind === "binary") { nodeReferences(value.left, result); nodeReferences(value.right, result); }
  else if (value.kind === "member") nodeReferences(value.object, result);
  else if (value.kind === "index") { nodeReferences(value.object, result); nodeReferences(value.index, result); }
  else if (value.kind === "call") { value.positional.forEach((item) => nodeReferences(item, result)); Object.values(value.named).forEach((item) => nodeReferences(item, result)); }
}

export function referenceReachableCompositionNodes(ir: CutAVIR, composition: IRComposition) {
  const pending = [...composition.rootAudioIds, ...composition.rootAVIds, ...composition.rootVisualIds];
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (scene) pending.push(...scene.rootAudioIds, ...scene.rootAVIds, ...scene.rootVisualIds);
  }
  const result = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (result.has(id)) continue; result.add(id);
    const node = ir.nodes[id]; if (!node) continue; pending.push(...node.children);
    const references = new Set<string>(); Object.values(node.inputs).forEach((value) => nodeReferences(value, references)); pending.push(...references);
  }
  return result;
}

/**
 * The exact dependency closure needed to produce picture. Standalone audio
 * roots are deliberately absent; an AV node or a visual node that explicitly
 * references audio still pulls that dependency into the closure.
 */
function referenceReachablePictureCompositionNodes(ir: CutAVIR, composition: IRComposition) {
  const pending = [...composition.rootAVIds, ...composition.rootVisualIds];
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (scene) pending.push(...scene.rootAVIds, ...scene.rootVisualIds);
  }
  const result = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (result.has(id)) continue; result.add(id);
    const node = ir.nodes[id]; if (!node) continue; pending.push(...node.children);
    const references = new Set<string>(); Object.values(node.inputs).forEach((value) => nodeReferences(value, references)); pending.push(...references);
  }
  return result;
}

function nodeLocation(node: IRNode) { return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`; }

function clipTime(node: IRNode, value: IRValue | undefined, label: string): Rational {
  if (value?.kind !== "quantity" || value.dimension !== "time") throw new Error(`Linked Clip ${label} at ${nodeLocation(node)} must be an exact Time quantity.`);
  return value.magnitude;
}

function exactClipBoundary(node: IRNode, composition: IRComposition, value: Rational, label: string) {
  if (multiplyRational(value, composition.fps).denominator !== "1") throw new Error(`Linked Clip ${label} at ${nodeLocation(node)} does not land on the ${composition.fps.numerator}/${composition.fps.denominator} fps frame boundary.`);
  if (multiplyRational(value, rational(composition.sampleRate)).denominator !== "1") throw new Error(`Linked Clip ${label} at ${nodeLocation(node)} does not land on the ${composition.sampleRate} Hz sample boundary.`);
}

function validateLinkedClip(ir: CutAVIR, composition: IRComposition, node: IRNode) {
  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  if (node.sceneId && (!scene || !composition.sceneIds.includes(node.sceneId))) throw new Error(`Linked Clip at ${nodeLocation(node)} belongs to a missing or different composition scene.`);
  const ownerDuration = scene?.duration ?? composition.duration;
  if (compareRational(node.interval.start, zeroRational) < 0 || compareRational(node.interval.duration, zeroRational) <= 0 || compareRational(addRational(node.interval.start, node.interval.duration), ownerDuration) > 0) {
    throw new Error(`Linked Clip destination interval at ${nodeLocation(node)} must be positive and remain inside its owning scene or timeline.`);
  }
  const durationInput = node.inputs.duration, expectedDuration = durationInput === undefined ? subtractRational(ownerDuration, node.interval.start) : clipTime(node, durationInput, "duration");
  if (compareRational(expectedDuration, node.interval.duration) !== 0) throw new Error(`Linked Clip duration at ${nodeLocation(node)} was not lowered exactly into its destination interval.`);
  const placement = addRational(scene?.start ?? zeroRational, node.interval.start);
  exactClipBoundary(node, composition, placement, "placement"); exactClipBoundary(node, composition, node.interval.duration, "duration");

  const fades: Rational[] = [];
  for (const name of ["fadeIn", "fadeOut"] as const) {
    const value = node.inputs[name];
    if (value === undefined) { fades.push(zeroRational); continue; }
    const fade = clipTime(node, value, name);
    if (compareRational(fade, zeroRational) < 0) throw new Error(`Linked Clip ${name} at ${nodeLocation(node)} cannot be negative.`);
    exactClipBoundary(node, composition, fade, name); fades.push(fade);
  }

  const source = node.inputs.source;
  if (source?.kind !== "resource-ref" || ir.resources[source.id]?.kind !== "video") throw new Error(`Linked Clip source at ${nodeLocation(node)} must reference a locked video resource.`);
  const lockedProbe = ir.resources[source.id]?.metadata?.probe as LockedResourceProbe | undefined;
  const selectedVideo = lockedProbe?.kind === "media" ? lockedProbe.selected.video : undefined;
  const selectedAudio = lockedProbe?.kind === "media" ? lockedProbe.selected.audio : undefined;
  const selectedVideoStream = lockedProbe?.kind === "media" && selectedVideo
    ? lockedProbe.identity.streams.find((candidate) => candidate.type === "video" && candidate.index === selectedVideo.streamIndex)
    : undefined;
  if (!selectedVideoStream?.start || !selectedAudio?.decodedAudioSamples) {
    throw new ReferencePictureEditorialError("CUT_EDIT_LINKED_CLIP", node.id, node, "Linked Clip requires exact selected video-start and decoded-audio presentation witnesses");
  }
  const range = node.inputs.range;
  let mediaDuration = node.interval.duration;
  let sourceStart = zeroRational;
  let authoredSourceEnd = node.interval.duration;
  if (range !== undefined) {
    if (range.kind !== "range") throw new Error(`Linked Clip range at ${nodeLocation(node)} must be an exact Range<Time>.`);
    const start = clipTime(node, range.start, "source-range start"), end = clipTime(node, range.end, "source-range end");
    if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) throw new Error(`Linked Clip source range at ${nodeLocation(node)} must be positive and cannot begin before zero.`);
    exactClipBoundary(node, composition, start, "source-range start"); exactClipBoundary(node, composition, end, "source-range end");
    sourceStart = start; authoredSourceEnd = end;
    if (durationInput === undefined) mediaDuration = subtractRational(end, start);
    if (durationInput !== undefined && compareRational(subtractRational(end, start), node.interval.duration) < 0) throw new Error(`Linked Clip source range at ${nodeLocation(node)} is shorter than its destination duration; implicit time stretching or hold is forbidden.`);
  }
  const playbackEnd = addRational(sourceStart, mediaDuration);
  exactSourcePictureBoundary(ir, node, source.id, sourceStart, "source-range start", "CUT_EDIT_LINKED_CLIP");
  exactSourcePictureBoundary(ir, node, source.id, authoredSourceEnd, "source-range end", "CUT_EDIT_LINKED_CLIP");
  exactSourcePictureBoundary(ir, node, source.id, playbackEnd, "source playback end", "CUT_EDIT_LINKED_CLIP");
  referenceLinkedAvPresentationPlan(ir, composition, node);
  if (compareRational(addRational(fades[0], fades[1]), mediaDuration) > 0) throw new Error(`Linked Clip fadeIn + fadeOut at ${nodeLocation(node)} cannot exceed its media duration.`);
}

export type PictureEditorialCode =
  | "CUT_EDIT_LINKED_CLIP"
  | "CUT_EDIT_SEQUENCE"
  | "CUT_EDIT_TRACK"
  | "CUT_EDIT_PICTURE_CLIP"
  | "CUT_EDIT_PICTURE_TIME_MAP"
  | "CUT_EDIT_GAP"
  | "CUT_EDIT_AUDIO_TRACK"
  | "CUT_EDIT_AUDIO_REGION"
  | "CUT_EDIT_AUDIO_CLIP"
  | "CUT_EDIT_AUDIO_GAP"
  | "CUT_EDIT_LINK";

export class ReferencePictureEditorialError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: PictureEditorialCode, readonly nodeId: string, node: IRNode, message: string) {
    const location = nodeLocation(node);
    super(`${code}: ${message} at ${location}.`);
    this.name = "ReferencePictureEditorialError";
    this.source = { module: node.provenance.module, line: node.provenance.span.start.line, column: node.provenance.span.start.column, nodeId };
  }
}

function pictureEditorialError(code: PictureEditorialCode, node: IRNode, message: string): never {
  throw new ReferencePictureEditorialError(code, node.id, node, message);
}

function pictureTime(node: IRNode, value: IRValue | undefined, label: string, code: PictureEditorialCode): Rational {
  if (value?.kind !== "quantity" || value.dimension !== "time") pictureEditorialError(code, node, `${label} must be an exact Time quantity`);
  return value.magnitude;
}

function exactPictureBoundary(node: IRNode, composition: IRComposition, value: Rational, label: string, code: PictureEditorialCode) {
  if (multiplyRational(value, composition.fps).denominator !== "1") {
    pictureEditorialError(code, node, `${label} does not land on the ${composition.fps.numerator}/${composition.fps.denominator} fps picture-frame boundary`);
  }
}

function exactSourcePictureBoundary(ir: CutAVIR, node: IRNode, resourceId: string, value: Rational, label: string, code: PictureEditorialCode = "CUT_EDIT_PICTURE_CLIP") {
  const probe = ir.resources[resourceId]?.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.video : undefined;
  const stream = probe?.kind === "media" && selected ? probe.identity.streams.find((candidate) => candidate.index === selected.streamIndex) : undefined;
  const rate = stream?.frameRate;
  if (!rate || compareRational(rate, zeroRational) <= 0) {
    pictureEditorialError(code, node, "locked selected video stream has no positive source frame rate; exact picture trimming is unsupported");
  }
  if (multiplyRational(value, rate).denominator !== "1") {
    pictureEditorialError(code, node, `${label} does not land on the locked source stream's ${rate.numerator}/${rate.denominator} fps frame boundary`);
  }
  const timeBase = selected?.timeBase;
  if (!timeBase || compareRational(timeBase, zeroRational) <= 0) {
    pictureEditorialError(code, node, "locked selected video stream has no positive exact source time base; exact picture trimming is unsupported");
  }
  if (multiplyRational(value, rational(timeBase.denominator, timeBase.numerator)).denominator !== "1") {
    pictureEditorialError(code, node, `${label} does not land on the locked source stream's ${timeBase.numerator}/${timeBase.denominator}s time base`);
  }
}

function exactAudioBoundary(node: IRNode, composition: IRComposition, value: Rational, label: string, code: PictureEditorialCode) {
  if (multiplyRational(value, rational(composition.sampleRate)).denominator !== "1") {
    pictureEditorialError(code, node, `${label} does not land on the ${composition.sampleRate} Hz destination sample grid`);
  }
}

function exactSourceAudioBoundary(ir: CutAVIR, node: IRNode, resourceId: string, value: Rational, label: string, code: PictureEditorialCode = "CUT_EDIT_AUDIO_CLIP") {
  const probe = ir.resources[resourceId]?.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.audio : undefined;
  const stream = probe?.kind === "media" && selected ? probe.identity.streams.find((candidate) => candidate.index === selected.streamIndex) : undefined;
  const sampleRate = stream?.sampleRate;
  if (!sampleRate || !Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    pictureEditorialError(code, node, "locked selected audio stream has no positive exact source sample rate");
  }
  if (multiplyRational(value, rational(sampleRate)).denominator !== "1") {
    pictureEditorialError(code, node, `${label} does not land on the locked source stream's ${sampleRate} Hz sample grid`);
  }
}

function editorialRange(node: IRNode, value: IRValue | undefined, label: string, code: PictureEditorialCode) {
  if (value?.kind !== "range" || !value.exclusive) pictureEditorialError(code, node, `${label} must be an exact half-open Range<Time>`);
  const start = pictureTime(node, value.start, `${label} start`, code);
  const end = pictureTime(node, value.end, `${label} end`, code);
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    pictureEditorialError(code, node, `${label} must be positive and cannot begin before zero`);
  }
  return { start, duration: subtractRational(end, start) };
}

function editorialLink(node: IRNode, code: PictureEditorialCode) {
  const authored = node.inputs.link;
  if (authored === undefined) return undefined;
  if (authored.kind !== "string" || !authored.value || authored.value !== authored.value.trim() || authored.value.length > 128 || /[\u0000-\u001f\u007f]/.test(authored.value)) {
    pictureEditorialError(code, node, "link must be a non-empty trimmed String of at most 128 characters without control characters");
  }
  return authored.value;
}

function validateAudioHandleAvailability(ir: CutAVIR, node: IRNode, resourceId: string, sourceRange: IREditorialInterval) {
  const code: PictureEditorialCode = "CUT_EDIT_AUDIO_CLIP";
  const amount = (name: "headHandle" | "tailHandle") => {
    const value = node.inputs[name];
    if (value === undefined) return zeroRational;
    const handle = pictureTime(node, value, name, code);
    if (compareRational(handle, zeroRational) < 0) pictureEditorialError(code, node, `${name} cannot be negative`);
    return handle;
  };
  const availableStart = subtractRational(sourceRange.start, amount("headHandle"));
  const availableEnd = addRational(addRational(sourceRange.start, sourceRange.duration), amount("tailHandle"));
  if (compareRational(availableStart, zeroRational) < 0) pictureEditorialError(code, node, "headHandle extends before source time zero");
  exactSourceAudioBoundary(ir, node, resourceId, availableStart, "available source start");
  exactSourceAudioBoundary(ir, node, resourceId, availableEnd, "available source end");
  const probe = ir.resources[resourceId]?.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.audio : undefined;
  if (!selected) pictureEditorialError(code, node, "source requires one locked selected audio stream");
  if (compareRational(availableEnd, selected.duration) > 0) pictureEditorialError(code, node, "tailHandle extends beyond the locked selected audio stream");
}

function directAudioTrackParents(ir: CutAVIR, node: IRNode) {
  return Object.values(ir.nodes).filter((candidate) => candidate.op === "cut.edit.audio_track" && candidate.children.includes(node.id));
}

function directTimelineAudioOriginParents(ir: CutAVIR, node: IRNode) {
  return Object.values(ir.nodes).filter((candidate) =>
    candidate.op === "cut.edit.timeline_audio_origin"
    && candidate.children.length === 1
    && candidate.children[0] === node.id);
}

function timelineAudioViewOrigin(ir: CutAVIR, node: IRNode) {
  const value = node.inputs.origin;
  return value?.kind === "node-ref" ? ir.nodes[value.id] : undefined;
}

function hasAudioRegionAncestor(ir: CutAVIR, nodeId: string, parents: ReadonlyMap<string, readonly string[]>) {
  const pending = [...(parents.get(nodeId) ?? [])], visited = new Set<string>();
  while (pending.length) {
    const parentId = pending.pop()!;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const parent = ir.nodes[parentId];
    if (!parent) continue;
    if (parent.op === "cut.edit.audio_region") return true;
    pending.push(...(parents.get(parentId) ?? []));
  }
  return false;
}

function referenceAudioRegionSource(ir: CutAVIR, composition: IRComposition, region: IRNode) {
  try {
    return ir.nodes[authorizeReferenceAudioRegion(ir, composition, region).sourceNodeId];
  } catch (error) {
    if (!(error instanceof ReferenceAudioRegionError)) throw error;
    // Preserve the public retime diagnostics emitted by the AudioRegion
    // authorization boundary.  Only the legacy generic region error is
    // translated into the older editorial validator namespace.
    if (error.code !== "CUT_EDIT_AUDIO_REGION") throw error;
    pictureEditorialError("CUT_EDIT_AUDIO_REGION", ir.nodes[error.nodeId] ?? region, error.message.replace(/^CUT_EDIT_AUDIO_REGION:\s*/u, "").replace(/ at .*:\d+:\d+\.$/u, ""));
  }
}

function samePictureInterval(left: { start: Rational; duration: Rational }, right: { start: Rational; duration: Rational }) {
  return compareRational(left.start, right.start) === 0 && compareRational(left.duration, right.duration) === 0;
}

function samePictureTimeMap(left: IRPictureTimeMap, right: IRPictureTimeMap) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "freeze" && right.kind === "freeze") {
    return compareRational(left.at, right.at) === 0 && left.frameSelection === right.frameSelection;
  }
  if (left.kind === "speed-ramp" && right.kind === "speed-ramp") {
    return left.interpolation === right.interpolation
      && left.frameSelection === right.frameSelection
      && left.points.length === right.points.length
      && left.points.every((point, index) => compareRational(point.at, right.points[index].at) === 0 && compareRational(point.rate, right.points[index].rate) === 0);
  }
  return left.kind === "constant"
    && right.kind === "constant"
    && left.direction === right.direction
    && left.frameSelection === right.frameSelection
    && compareRational(left.rate, right.rate) === 0;
}

function canonicalAuthoredPictureTimeMap(node: IRNode) {
  let map: IRPictureTimeMap;
  try {
    map = authoredPictureTimeMap(node.inputs, node.interval.duration);
  } catch (error) {
    if (!(error instanceof PictureTimeMapInputError)) throw error;
    pictureEditorialError("CUT_EDIT_PICTURE_TIME_MAP", node, error.message);
  }
  const canonicalInputs = canonicalPictureTimeMapInputs(node.inputs, map);
  if (stableJsonStringify(canonicalInputs) !== stableJsonStringify(node.inputs)) {
    pictureEditorialError("CUT_EDIT_PICTURE_TIME_MAP", node, "time-map inputs are semantically valid but non-canonical; redundant default controls and omitted non-default rate are forbidden");
  }
  return map;
}

function reconcilePictureTimeMap(node: IRNode, encoded: IRPictureTimeMap | undefined) {
  const authored = canonicalAuthoredPictureTimeMap(node);
  if (isDefaultPictureTimeMap(authored)) {
    if (encoded !== undefined) pictureEditorialError("CUT_EDIT_PICTURE_TIME_MAP", node, "default forward 1x playback must not emit redundant timeMap metadata");
    return;
  }
  if (encoded === undefined) pictureEditorialError("CUT_EDIT_PICTURE_TIME_MAP", node, "non-default picture playback requires typed timeMap metadata");
  if (!samePictureTimeMap(authored, encoded)) pictureEditorialError("CUT_EDIT_PICTURE_TIME_MAP", node, "typed timeMap metadata must exactly equal canonical PictureClip inputs");
}

function validatePictureEditorialNode(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  linkedEditAuthorizations: ReadonlyMap<string, ReferenceLinkedEditSideAuthorization> = new Map(),
) {
  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  const placement = addRational(scene?.start ?? zeroRational, node.interval.start);
  if (node.op === "cut.edit.sequence") {
    const code: PictureEditorialCode = "CUT_EDIT_SEQUENCE";
    if (!node.editorial || node.editorial.kind !== "sequence") pictureEditorialError(code, node, "requires explicit sequence editorial metadata");
    const duration = pictureTime(node, node.inputs.duration, "duration", code);
    if (compareRational(duration, node.interval.duration) !== 0 || compareRational(duration, zeroRational) <= 0) pictureEditorialError(code, node, "duration must be positive and equal its lowered destination duration");
    exactPictureBoundary(node, composition, placement, "placement", code);
    exactPictureBoundary(node, composition, duration, "duration", code);
    if (!node.children.length || node.editorial.tracks.length !== node.children.length) pictureEditorialError(code, node, "track metadata must cover every child exactly once");
    node.editorial.tracks.forEach((track, index) => {
      const child = ir.nodes[track.nodeId];
      if (track.order !== index || node.children[index] !== track.nodeId) pictureEditorialError(code, node, `track ${index} must preserve explicit source order`);
      if (!child || child.op !== "cut.edit.picture_track" || child.domain !== "visual") pictureEditorialError(code, node, `track ${index} must reference a visual PictureTrack child`);
      if (child.sceneId !== node.sceneId) pictureEditorialError(code, node, `track ${index} must share the Sequence scene`);
      if (!samePictureInterval(track.destination, child.interval) || !samePictureInterval(track.destination, node.interval)) pictureEditorialError(code, node, `track ${index} destination must equal the Sequence interval`);
    });
    return;
  }
  if (node.op === "cut.edit.picture_track") {
    const code: PictureEditorialCode = "CUT_EDIT_TRACK";
    if (!node.editorial || node.editorial.kind !== "picture-track") pictureEditorialError(code, node, "requires explicit temporally ordered picture-track metadata");
    validateReferencePictureTrackOperationPlan(ir, composition, node, linkedEditAuthorizations);
    if (!node.children.length || node.editorial.items.length !== node.children.length) pictureEditorialError(code, node, "item metadata must cover every child exactly once");
    let cursor = node.interval.start;
    node.editorial.items.forEach((item, index) => {
      const child = ir.nodes[item.nodeId];
      if (item.order !== index || node.children[index] !== item.nodeId) pictureEditorialError(code, node, `item ${index} must preserve explicit temporal source order`);
      if (!child || child.domain !== "visual") pictureEditorialError(code, node, `item ${index} must reference a visual child`);
      const pictureChild = child.op === "cut.edit.picture_clip" || child.op === "cut.visual.precomp";
      if ((item.kind === "picture" && !pictureChild) || (item.kind === "gap" && child.op !== "cut.edit.gap")) {
        pictureEditorialError(code, node, `item ${index} kind does not match child ${child.op}`);
      }
      if (child.sceneId !== node.sceneId) pictureEditorialError(code, node, `item ${index} must share the PictureTrack scene`);
      if (!samePictureInterval(item.destination, child.interval) || compareRational(item.destination.start, cursor) !== 0 || compareRational(item.destination.duration, zeroRational) <= 0) {
        pictureEditorialError(code, node, `item ${index} destination must be positive, contiguous, and equal its child interval`);
      }
      if (item.kind === "picture") {
        if (!item.source) pictureEditorialError(code, node, `picture item ${index} requires an explicit source interval`);
        if (child.op === "cut.visual.precomp") {
          const config = referencePrecompConfig(ir, composition, child);
          if (!config || config.kind !== "visual") pictureEditorialError(code, node, `picture item ${index} Precomp must resolve one exact picture source`);
          const sourceDuration = subtractRational(config.sourceRange.end, config.sourceRange.start);
          if (compareRational(item.source.start, config.sourceRange.start) !== 0 || compareRational(item.source.duration, sourceDuration) !== 0) {
            pictureEditorialError(code, node, `picture item ${index} source metadata must equal the Precomp's authenticated half-open range`);
          }
          if (item.timeMap !== undefined) pictureEditorialError(code, node, `picture item ${index} Precomp cannot claim an independent picture time map`);
          if (item.linkId !== undefined) pictureEditorialError("CUT_EDIT_LINK", child, `picture item ${index} Precomp cannot claim an editorial link`);
        } else {
          const range = child.inputs.range;
          if (range?.kind !== "range" || !range.exclusive) pictureEditorialError(code, node, `picture item ${index} requires a half-open source range`);
          const rangeStart = pictureTime(child, range.start, "source-range start", "CUT_EDIT_PICTURE_CLIP");
          const rangeEnd = pictureTime(child, range.end, "source-range end", "CUT_EDIT_PICTURE_CLIP");
          if (compareRational(item.source.start, rangeStart) !== 0 || compareRational(item.source.duration, subtractRational(rangeEnd, rangeStart)) !== 0) {
            pictureEditorialError(code, node, `picture item ${index} source metadata must equal the authored half-open range`);
          }
          reconcilePictureTimeMap(child, item.timeMap);
          const linkId = editorialLink(child, "CUT_EDIT_LINK");
          if (item.linkId !== linkId) pictureEditorialError("CUT_EDIT_LINK", child, `picture item ${index} link metadata must exactly equal its authored link`);
        }
      } else {
        if (item.source !== undefined) pictureEditorialError(code, node, `gap item ${index} cannot claim a source interval`);
        if (item.linkId !== undefined) pictureEditorialError("CUT_EDIT_LINK", child, `gap item ${index} cannot claim an editorial link`);
      }
      cursor = addRational(cursor, item.destination.duration);
    });
    if (compareRational(cursor, addRational(node.interval.start, node.interval.duration)) !== 0) {
      pictureEditorialError(code, node, "items must fill the track exactly; intentional holes require an explicit Gap");
    }
    return;
  }
  if (node.op === "cut.edit.picture_clip") {
    const code: PictureEditorialCode = "CUT_EDIT_PICTURE_CLIP";
    if (node.editorial) pictureEditorialError(code, node, "cannot contain child editorial metadata");
    const duration = pictureTime(node, node.inputs.duration, "duration", code);
    if (compareRational(duration, node.interval.duration) !== 0 || compareRational(duration, zeroRational) <= 0) pictureEditorialError(code, node, "duration must be positive and equal its destination duration");
    const source = node.inputs.source;
    if (source?.kind !== "resource-ref" || ir.resources[source.id]?.kind !== "video") pictureEditorialError(code, node, "source must reference a locked video resource");
    const range = node.inputs.range;
    if (range?.kind !== "range" || !range.exclusive) pictureEditorialError(code, node, "range must be an exact half-open Range<Time>");
    const start = pictureTime(node, range.start, "source-range start", code);
    const end = pictureTime(node, range.end, "source-range end", code);
    if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) pictureEditorialError(code, node, "source range must be positive and cannot begin before zero");
    canonicalAuthoredPictureTimeMap(node);
    exactPictureBoundary(node, composition, placement, "placement", code);
    exactPictureBoundary(node, composition, duration, "duration", code);
    exactSourcePictureBoundary(ir, node, source.id, start, "source-range start");
    exactSourcePictureBoundary(ir, node, source.id, end, "source-range end");
    try {
      referencePictureTimeMapConfig(ir, composition, node);
    } catch (error) {
      if (!(error instanceof ReferencePictureTimeMapError)) throw error;
      pictureEditorialError("CUT_EDIT_PICTURE_TIME_MAP", node, error.detail);
    }
    editorialLink(node, "CUT_EDIT_LINK");
    return;
  }
  if (node.op === "cut.edit.gap") {
    const code: PictureEditorialCode = "CUT_EDIT_GAP";
    if (node.editorial) pictureEditorialError(code, node, "cannot contain child editorial metadata");
    const duration = pictureTime(node, node.inputs.duration, "duration", code);
    if (compareRational(duration, node.interval.duration) !== 0 || compareRational(duration, zeroRational) <= 0) pictureEditorialError(code, node, "duration must be positive and equal its destination duration");
    exactPictureBoundary(node, composition, placement, "placement", code);
    exactPictureBoundary(node, composition, duration, "duration", code);
  }
}

function validateAudioEditorialNode(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  linkedEditAuthorizations: ReadonlyMap<string, ReferenceLinkedEditSideAuthorization> = new Map(),
) {
  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  const sceneStart = scene?.start ?? zeroRational;
  const placement = addRational(sceneStart, node.interval.start);
  if (node.op === "cut.edit.audio_track") {
    const code: PictureEditorialCode = "CUT_EDIT_AUDIO_TRACK";
    if (!node.editorial || node.editorial.kind !== "audio-track") pictureEditorialError(code, node, "requires explicit temporally ordered audio-track metadata");
    const timelineOwned = referenceTimelineEditTrackOwnership(ir, node) !== undefined;
    const hasProcessedRegions = node.editorial.items.some((item) => item.sourceNodeId !== undefined);
    if (hasProcessedRegions && node.editorial.operationPlan && node.editorial.operationPlan.version !== 2) pictureEditorialError("CUT_EDIT_AUDIO_REGION", node, "processed AudioRegion items cannot enter structural edit plans; only closed version-2 crossfade plans execute");
    if (hasProcessedRegions && node.editorial.transitions?.length && node.editorial.operationPlan?.version !== 2 && !timelineOwned) pictureEditorialError("CUT_EDIT_AUDIO_REGION", node, "processed AudioRegion transitions require one closed version-2 crossfade or TimelineEdit plan");
    validateReferenceAudioTrackOperationPlan(ir, composition, node, linkedEditAuthorizations);
    if (!node.children.length || node.editorial.items.length !== node.children.length) pictureEditorialError(code, node, "item metadata must cover every child exactly once");
    let coverageEnd = node.interval.start;
    let previousStart = node.interval.start;
    let latestGapEnd = node.interval.start;
    node.editorial.items.forEach((item, index) => {
      const child = ir.nodes[item.nodeId];
      if (item.order !== index || node.children[index] !== item.nodeId) pictureEditorialError(code, node, `item ${index} must preserve explicit temporal source order`);
      if (!child || child.domain !== "audio") pictureEditorialError(code, node, `item ${index} must reference an audio child`);
      const timelineView = timelineOwned && child.op === "cut.edit.timeline_audio_view";
      const expectedOp = timelineView
        ? "cut.edit.timeline_audio_view"
        : item.kind === "audio"
          ? item.sourceNodeId
            ? "cut.edit.audio_region"
            : "cut.audio.clip"
          : "cut.edit.audio_gap";
      if (child.op !== expectedOp) pictureEditorialError(code, node, `item ${index} kind does not match child ${child.op}`);
      if (child.sceneId !== node.sceneId) pictureEditorialError(code, node, `item ${index} must share the AudioTrack scene`);
      if (!samePictureInterval(item.destination, child.interval) || compareRational(item.destination.duration, zeroRational) <= 0) pictureEditorialError(code, node, `item ${index} destination must be positive and equal its child interval`);
      const itemEnd = addRational(item.destination.start, item.destination.duration);
      if (compareRational(item.destination.start, previousStart) < 0) pictureEditorialError(code, node, `item ${index} destination start is out of nondecreasing temporal source order`);
      if (compareRational(item.destination.start, coverageEnd) > 0) pictureEditorialError(code, node, `item ${index} leaves an uncovered interval that requires an explicit AudioGap`);
      if (item.kind === "gap" && compareRational(item.destination.start, coverageEnd) !== 0) pictureEditorialError(code, node, `audio gap item ${index} overlaps audio or another gap instead of beginning at the current coverage boundary`);
      if (item.kind === "audio" && compareRational(item.destination.start, latestGapEnd) < 0) pictureEditorialError(code, node, `audio item ${index} overlaps an explicit AudioGap interval`);
      const authoredDestination = timelineView
        ? {
            start: subtractRational(item.destination.start, node.interval.start),
            duration: item.destination.duration,
          }
        : editorialRange(child, child.inputs.destination, "destination", item.kind === "audio" ? "CUT_EDIT_AUDIO_CLIP" : "CUT_EDIT_AUDIO_GAP");
      const translatedDestination = { start: addRational(node.interval.start, authoredDestination.start), duration: authoredDestination.duration };
      if (!samePictureInterval(item.destination, translatedDestination)) pictureEditorialError(code, node, `item ${index} destination metadata must equal its authored track-relative half-open range`);
      exactAudioBoundary(child, composition, addRational(sceneStart, item.destination.start), "destination start", item.kind === "audio" ? "CUT_EDIT_AUDIO_CLIP" : "CUT_EDIT_AUDIO_GAP");
      exactAudioBoundary(child, composition, addRational(sceneStart, addRational(item.destination.start, item.destination.duration)), "destination end", item.kind === "audio" ? "CUT_EDIT_AUDIO_CLIP" : "CUT_EDIT_AUDIO_GAP");
      if (item.kind === "audio") {
        if (!item.source) pictureEditorialError(code, node, `audio item ${index} requires an explicit source interval`);
        const timelineOrigin = timelineView ? timelineAudioViewOrigin(ir, child) : undefined;
        const timelineRoot = timelineOrigin?.children.length === 1
          ? ir.nodes[timelineOrigin.children[0]!]
          : undefined;
        const sourceNode = timelineRoot?.op === "cut.edit.audio_region"
          ? referenceAudioRegionSource(ir, composition, timelineRoot)
          : timelineRoot?.op === "cut.audio.clip"
            ? timelineRoot
            : child.op === "cut.edit.audio_region"
              ? referenceAudioRegionSource(ir, composition, child)
              : child;
        if (timelineView) {
          if (!timelineOrigin || !timelineRoot || item.sourceNodeId !== sourceNode.id) {
            pictureEditorialError("CUT_EDIT_AUDIO_REGION", child, `audio item ${index} sourceNodeId must identify its exact immutable timeline origin AudioClip descendant`);
          }
        } else if (child.op === "cut.edit.audio_region") {
          if (item.sourceNodeId !== sourceNode.id) pictureEditorialError("CUT_EDIT_AUDIO_REGION", child, `audio item ${index} sourceNodeId must identify its exact AudioClip descendant`);
        } else if (item.sourceNodeId !== undefined) pictureEditorialError("CUT_EDIT_AUDIO_REGION", child, `direct AudioClip item ${index} cannot claim a separate sourceNodeId`);
        const sourceRange = timelineView
          ? editorialRange(child, child.inputs.source, "source range", "CUT_EDIT_AUDIO_CLIP")
          : editorialRange(sourceNode, sourceNode.inputs.range, "source range", "CUT_EDIT_AUDIO_CLIP");
        if (!samePictureInterval(item.source, sourceRange)) pictureEditorialError(code, node, `audio item ${index} source metadata must equal its authored half-open range`);
        // Direct AudioClip items remain duration-locked. Processed regions are
        // authorized above, where an exact public TimeStretch is the sole
        // mechanism allowed to reconcile unequal source and destination spans.
        if (child.op !== "cut.edit.audio_region" && !timelineView && compareRational(item.source.duration, item.destination.duration) !== 0) {
          pictureEditorialError("CUT_EDIT_AUDIO_CLIP", child, "source and destination durations must match exactly; implicit time stretch is forbidden");
        }
        const source = sourceNode.inputs.source;
        if (source?.kind !== "resource-ref" || ir.resources[source.id]?.kind !== "audio") pictureEditorialError("CUT_EDIT_AUDIO_CLIP", sourceNode, "source must reference a locked audio resource");
        exactSourceAudioBoundary(ir, sourceNode, source.id, item.source.start, "source-range start");
        exactSourceAudioBoundary(ir, sourceNode, source.id, addRational(item.source.start, item.source.duration), "source-range end");
        const linkId = editorialLink(child, "CUT_EDIT_LINK");
        if (item.linkId !== linkId) pictureEditorialError("CUT_EDIT_LINK", child, `audio item ${index} link metadata must exactly equal its authored link`);
      } else {
        if (item.source !== undefined || item.sourceNodeId !== undefined) pictureEditorialError(code, node, `audio gap item ${index} cannot claim source metadata`);
        if (item.linkId !== undefined || child.inputs.link !== undefined) pictureEditorialError("CUT_EDIT_LINK", child, `audio gap item ${index} cannot claim an editorial link`);
      }
      previousStart = item.destination.start;
      if (compareRational(itemEnd, coverageEnd) > 0) coverageEnd = itemEnd;
      if (item.kind === "gap") latestGapEnd = itemEnd;
    });
    if (compareRational(coverageEnd, addRational(node.interval.start, node.interval.duration)) !== 0) {
      pictureEditorialError(code, node, "item coverage must fill the track exactly; intentional silence requires an explicit AudioGap");
    }
    exactAudioBoundary(node, composition, placement, "placement", code);
    exactAudioBoundary(node, composition, node.interval.duration, "duration", code);
    return;
  }
  if (node.op === "cut.edit.audio_region") {
    const code: PictureEditorialCode = "CUT_EDIT_AUDIO_REGION";
    if (node.editorial) pictureEditorialError(code, node, "cannot contain child editorial metadata");
    const timelineOrigins = directTimelineAudioOriginParents(ir, node);
    if (timelineOrigins.length === 1) {
      referenceAudioRegionSource(ir, composition, node);
      exactAudioBoundary(node, composition, placement, "origin placement", code);
      exactAudioBoundary(node, composition, node.interval.duration, "origin duration", code);
      return;
    }
    const parents = directAudioTrackParents(ir, node);
    if (parents.length !== 1) pictureEditorialError(code, node, "requires exactly one direct AudioTrack parent");
    const destination = editorialRange(node, node.inputs.destination, "destination", code);
    if (!samePictureInterval(node.interval, { start: addRational(parents[0].interval.start, destination.start), duration: destination.duration })) pictureEditorialError(code, node, "lowered interval must equal its authored AudioTrack-relative destination");
    referenceAudioRegionSource(ir, composition, node);
    exactAudioBoundary(node, composition, placement, "destination placement", code);
    exactAudioBoundary(node, composition, node.interval.duration, "destination duration", code);
    editorialLink(node, "CUT_EDIT_LINK");
    return;
  }
  if (node.op === "cut.audio.clip") {
    const code: PictureEditorialCode = "CUT_EDIT_AUDIO_CLIP";
    if (node.editorial) pictureEditorialError(code, node, "cannot contain child editorial metadata");
    const timelineOrigins = directTimelineAudioOriginParents(ir, node);
    if (timelineOrigins.length === 1) {
      const sourceRange = editorialRange(node, node.inputs.range, "source range", code);
      const source = node.inputs.source;
      if (source?.kind !== "resource-ref" || ir.resources[source.id]?.kind !== "audio") pictureEditorialError(code, node, "source must reference a locked audio resource");
      exactSourceAudioBoundary(ir, node, source.id, sourceRange.start, "source-range start");
      exactSourceAudioBoundary(ir, node, source.id, addRational(sourceRange.start, sourceRange.duration), "source-range end");
      validateAudioHandleAvailability(ir, node, source.id, sourceRange);
      return;
    }
    const parents = directAudioTrackParents(ir, node);
    if (parents.length !== 1) pictureEditorialError(code, node, "destination and link inputs require exactly one direct AudioTrack parent");
    const sourceRange = editorialRange(node, node.inputs.range, "source range", code);
    const destination = editorialRange(node, node.inputs.destination, "destination", code);
    if (compareRational(sourceRange.duration, destination.duration) !== 0 || compareRational(destination.duration, node.interval.duration) !== 0) {
      pictureEditorialError(code, node, "source, authored destination, and lowered destination durations must match exactly; implicit time stretch is forbidden");
    }
    if (compareRational(node.interval.start, addRational(parents[0].interval.start, destination.start)) !== 0) {
      pictureEditorialError(code, node, "lowered destination start must equal its authored AudioTrack-relative start");
    }
    const source = node.inputs.source;
    if (source?.kind !== "resource-ref" || ir.resources[source.id]?.kind !== "audio") pictureEditorialError(code, node, "source must reference a locked audio resource");
    exactAudioBoundary(node, composition, placement, "destination placement", code);
    exactAudioBoundary(node, composition, node.interval.duration, "destination duration", code);
    exactSourceAudioBoundary(ir, node, source.id, sourceRange.start, "source-range start");
    exactSourceAudioBoundary(ir, node, source.id, addRational(sourceRange.start, sourceRange.duration), "source-range end");
    validateAudioHandleAvailability(ir, node, source.id, sourceRange);
    editorialLink(node, "CUT_EDIT_LINK");
    return;
  }
  if (node.op === "cut.edit.audio_gap") {
    const code: PictureEditorialCode = "CUT_EDIT_AUDIO_GAP";
    if (node.editorial) pictureEditorialError(code, node, "cannot contain child editorial metadata");
    const parents = directAudioTrackParents(ir, node);
    if (parents.length !== 1) pictureEditorialError(code, node, "requires exactly one direct AudioTrack parent");
    const destination = editorialRange(node, node.inputs.destination, "destination", code);
    if (compareRational(destination.duration, node.interval.duration) !== 0) pictureEditorialError(code, node, "authored and lowered destination durations must match exactly");
    if (compareRational(node.interval.start, addRational(parents[0].interval.start, destination.start)) !== 0) {
      pictureEditorialError(code, node, "lowered destination start must equal its authored AudioTrack-relative start");
    }
    exactAudioBoundary(node, composition, placement, "destination placement", code);
    exactAudioBoundary(node, composition, node.interval.duration, "destination duration", code);
  }
}

function validateEditorialLinkGroups(
  ir: CutAVIR,
  timelineEditTrackNodeIds: ReadonlySet<string>,
) {
  const groups = new Map<string, { linkId: string; members: Array<{ kind: "picture" | "audio"; node: IRNode }> }>();
  // Picture-only frame/contact validation deliberately excludes audio roots
  // from its executable closure. Editorial link cardinality is nevertheless a
  // graph contract spanning picture and audio tracks, so validate the paired
  // metadata from the complete locked IR rather than treating the omitted
  // audio execution closure as a broken link.
  for (const track of Object.values(ir.nodes)) {
    if (!track?.editorial || (track.editorial.kind !== "picture-track" && track.editorial.kind !== "audio-track")) continue;
    // Canonical TimelineEdit replay has already correlated every terminal
    // picture/audio link on this exact track. Its algebra may split one link
    // into multiple terminal segments without the legacy linkSegmentId field,
    // so re-grouping those items as one legacy pair is both redundant and
    // wrong. Ordinary tracks remain in this complete-IR cardinality pass.
    if (timelineEditTrackNodeIds.has(track.id)) continue;
    for (const item of track.editorial.items) {
      if (!item.linkId) continue;
      const child = ir.nodes[item.nodeId];
      if (!child) pictureEditorialError("CUT_EDIT_LINK", track, `editorial link ${item.linkId} references missing child ${item.nodeId}`);
      const scope = `${track.sceneId ?? "timeline"}\u0000${item.linkId}\u0000${item.linkSegmentId ?? "legacy-pair"}`;
      const group = groups.get(scope) ?? { linkId: item.linkId, members: [] };
      const members = group.members;
      members.push({ kind: track.editorial.kind === "picture-track" ? "picture" : "audio", node: child });
      groups.set(scope, group);
    }
  }
  for (const { linkId, members } of groups.values()) {
    const pictures = members.filter((member) => member.kind === "picture");
    const audio = members.filter((member) => member.kind === "audio");
    const sceneIds = new Set(members.map((member) => member.node.sceneId));
    if (pictures.length === 1 && audio.length === 1 && sceneIds.size === 1 && !sceneIds.has(undefined)) continue;
    pictureEditorialError("CUT_EDIT_LINK", members[0].node, `editorial link “${linkId}” must identify exactly one picture/audio member per legacy or compiler-owned segment identity in the same scene`);
  }
}

function validateVisualCompositingNode(node: IRNode, location: string) {
  if (node.op === "cut.visual.composite") {
    const blend = node.inputs.blend;
    if (blend !== undefined && (blend.kind !== "string" || !rgbaBlendModes.includes(blend.value as RgbaBlendMode))) {
      throw new Error(`Reference kernel ${node.op} at ${location} blend must be one of: ${rgbaBlendModes.join(", ")}.`);
    }
  }
}

export const referencePathLimits = Object.freeze({ maxPoints: 4_096, maxAbsoluteCoordinate: 65_536, maxStrokeWidth: 4_096 });

function pathLength(op: string, value: IRValue | undefined, label: string, location: string) {
  if (value?.kind !== "quantity" || value.dimension !== "length") {
    throw new Error(`Reference kernel ${op} at ${location} ${label} must be an exact Length quantity.`);
  }
  const number = rationalToNumber(value.magnitude);
  if (!Number.isFinite(number)) throw new Error(`Reference kernel ${op} at ${location} ${label} must be finite.`);
  return number;
}

function validateVisualPolylineNode(node: IRNode, location: string) {
  if (node.op !== "cut.visual.path" && node.op !== "cut.visual.trace") return;
  if (node.op === "cut.visual.trace") prepareReferenceTraceNode(node);
  else {
    if (node.inputs.points === undefined) return;
    const points = node.inputs.points;
    if (points?.kind !== "array") throw new Error(`Reference kernel ${node.op} at ${location} points must be a List<Vec2>.`);
    if (points.items.length < 2 || points.items.length > referencePathLimits.maxPoints) {
      throw new Error(`Reference kernel ${node.op} at ${location} points must contain between 2 and ${referencePathLimits.maxPoints} coordinates.`);
    }
    points.items.forEach((point, index) => {
      if (point.kind !== "object" || Object.keys(point.entries).length !== 2 || !Object.hasOwn(point.entries, "x") || !Object.hasOwn(point.entries, "y")) {
        throw new Error(`Reference kernel ${node.op} at ${location} points[${index}] must be a closed Vec2 with exactly x and y.`);
      }
      for (const axis of ["x", "y"] as const) {
        const number = pathLength(node.op, point.entries[axis], `points[${index}].${axis}`, location);
        if (Math.abs(number) > referencePathLimits.maxAbsoluteCoordinate) {
          throw new Error(`Reference kernel ${node.op} at ${location} points[${index}].${axis} exceeds the ${referencePathLimits.maxAbsoluteCoordinate}px coordinate limit.`);
        }
      }
    });
  }
  const width = node.inputs.width;
  if (node.op === "cut.visual.trace" && width === undefined) throw new Error(`Reference kernel cut.visual.trace at ${location} width is required.`);
  if (width !== undefined) {
    const number = pathLength(node.op, width, "width", location);
    if (number <= 0 || number > referencePathLimits.maxStrokeWidth) {
      throw new Error(`Reference kernel ${node.op} at ${location} width must be greater than 0px and at most ${referencePathLimits.maxStrokeWidth}px.`);
    }
  }
  for (const paint of ["stroke"] as const) {
    const value = node.inputs[paint];
    if (node.op === "cut.visual.trace" && value === undefined) throw new Error(`Reference kernel cut.visual.trace at ${location} ${paint} is required.`);
    if (value !== undefined && (value.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(value.value))) {
      throw new Error(`Reference kernel ${node.op} at ${location} ${paint} must be a canonical Color.`);
    }
  }
}

function traceTime(node: IRNode, value: IRValue | undefined, label: string, fallback?: Rational) {
  if (value === undefined && fallback) return fallback;
  if (value?.kind !== "quantity" || value.dimension !== "time") {
    throw new Error(`Reference kernel cut.visual.trace at ${nodeLocation(node)} ${label} must be an exact Time quantity.`);
  }
  return value.magnitude;
}

type TraceTransformName = "opacity" | "x" | "y" | "scale" | "rotation";

const traceTransformContracts: Readonly<Record<TraceTransformName, {
  dimension: string;
  unit: string;
  minimum: Rational;
  maximum: Rational;
  range: string;
}>> = Object.freeze({
  opacity: { dimension: "ratio", unit: "ratio", minimum: zeroRational, maximum: rational(1), range: "between 0% and 100%" },
  x: { dimension: "length", unit: "px", minimum: rational(-referenceTraceLimits.maxAbsolutePosition), maximum: rational(referenceTraceLimits.maxAbsolutePosition), range: `within ±${referenceTraceLimits.maxAbsolutePosition}px` },
  y: { dimension: "length", unit: "px", minimum: rational(-referenceTraceLimits.maxAbsolutePosition), maximum: rational(referenceTraceLimits.maxAbsolutePosition), range: `within ±${referenceTraceLimits.maxAbsolutePosition}px` },
  scale: { dimension: "scalar", unit: "scalar", minimum: rational(1, 1_000), maximum: rational(referenceTraceLimits.maxScale), range: `between ${referenceTraceLimits.minScale} and ${referenceTraceLimits.maxScale}` },
  rotation: { dimension: "angle", unit: "deg", minimum: rational(-referenceTraceLimits.maxAbsoluteRotationDegrees), maximum: rational(referenceTraceLimits.maxAbsoluteRotationDegrees), range: `within ±${referenceTraceLimits.maxAbsoluteRotationDegrees}deg` },
});

function validateTraceTransformValue(value: IRValue, name: TraceTransformName, label: string, location: string, allowNull = false) {
  if (allowNull && value.kind === "null") return;
  const contract = traceTransformContracts[name];
  if (value.kind !== "quantity" || value.dimension !== contract.dimension || value.unit !== contract.unit) {
    throw new Error(`Reference kernel cut.visual.trace at ${location} ${label} must be a canonical ${contract.dimension} quantity in ${contract.unit}.`);
  }
  const number = rationalToNumber(value.magnitude);
  if (!Number.isFinite(number)) throw new Error(`Reference kernel cut.visual.trace at ${location} ${label} must be finite.`);
  if (compareRational(value.magnitude, contract.minimum) < 0 || compareRational(value.magnitude, contract.maximum) > 0) {
    throw new Error(`Reference kernel cut.visual.trace at ${location} ${label} must be ${contract.range}.`);
  }
}

function validateTraceTransformSignal(signal: IRSignal, name: TraceTransformName, location: string) {
  const label = (suffix: string) => `property “${name}” signal ${signal.id}${suffix}`;
  if (signal.kind === "constant") validateTraceTransformValue(signal.value, name, label(" value"), location);
  else if (signal.kind === "step") {
    if (!signal.points.length) throw new Error(`Reference kernel cut.visual.trace at ${location} property “${name}” signal ${signal.id} must contain at least one point.`);
    signal.points.forEach((point, index) => validateTraceTransformValue(point.value, name, label(` points[${index}].value`), location));
  } else if (signal.kind === "keyframes") {
    if (!signal.keyframes.length) throw new Error(`Reference kernel cut.visual.trace at ${location} property “${name}” signal ${signal.id} must contain at least one keyframe.`);
    signal.keyframes.forEach((keyframe, index) => validateTraceTransformValue(keyframe.value, name, label(` keyframes[${index}].value`), location));
  } else {
    validateTraceTransformValue(signal.initial, name, label(" initial"), location, true);
    signal.events.forEach((event, index) => {
      if (event.kind === "set") validateTraceTransformValue(event.value, name, label(` events[${index}].value`), location);
      else {
        validateTraceTransformValue(event.from, name, label(` events[${index}].from`), location);
        validateTraceTransformValue(event.to, name, label(` events[${index}].to`), location);
      }
    });
  }
}

function validateTraceTransforms(node: IRNode, ir: CutAVIR, location: string) {
  for (const name of ["opacity", "scale", "rotation"] as const) {
    const value = node.inputs[name];
    if (value !== undefined) validateTraceTransformValue(value, name, `input “${name}”`, location);
  }
  for (const name of ["opacity", "x", "y", "scale", "rotation"] as const) {
    const property = node.properties[name];
    if (property === undefined) continue;
    if (!("signal" in property)) validateTraceTransformValue(property, name, `property “${name}”`, location);
    else {
      const signal = ir.signals[property.signal];
      if (!signal) throw new Error(`Reference kernel cut.visual.trace at ${location} references missing signal ${property.signal} for property “${name}”.`);
      validateTraceTransformSignal(signal, name, location);
    }
  }
}

function validateVisualTraceNode(node: IRNode, ir: CutAVIR, location: string) {
  if (node.op !== "cut.visual.trace") return;
  prepareReferenceTraceNode(node);
  const duration = traceTime(node, node.inputs.duration, "duration");
  const delay = traceTime(node, node.inputs.delay, "delay", zeroRational);
  const headFade = traceTime(node, node.inputs.headFade, "headFade", rational(3, 25));
  if (compareRational(duration, zeroRational) <= 0) throw new Error(`Reference kernel cut.visual.trace at ${location} duration must be greater than 0s.`);
  if (compareRational(delay, zeroRational) < 0) throw new Error(`Reference kernel cut.visual.trace at ${location} delay cannot be negative.`);
  if (compareRational(headFade, zeroRational) < 0) throw new Error(`Reference kernel cut.visual.trace at ${location} headFade cannot be negative.`);

  const headRadius = node.inputs.headRadius === undefined ? 0 : pathLength(node.op, node.inputs.headRadius, "headRadius", location);
  if (headRadius < 0 || headRadius > referencePathLimits.maxStrokeWidth) {
    throw new Error(`Reference kernel cut.visual.trace at ${location} headRadius must be between 0px and ${referencePathLimits.maxStrokeWidth}px.`);
  }
  const headColor = node.inputs.headColor;
  if (headColor !== undefined && (headColor.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(headColor.value))) {
    throw new Error(`Reference kernel cut.visual.trace at ${location} headColor must be a canonical Color.`);
  }
  const easing = node.inputs.easing;
  if (easing !== undefined && (easing.kind !== "string" || !referenceTraceEasings.includes(easing.value as ReferenceTraceEasing))) {
    throw new Error(`Reference kernel cut.visual.trace at ${location} easing must be one of: ${referenceTraceEasings.join(", ")}.`);
  }
  validateTraceTransforms(node, ir, location);

  const visibleFinish = addRational(delay, duration);
  const effectFinish = headRadius > 0 ? addRational(visibleFinish, headFade) : visibleFinish;
  if (compareRational(effectFinish, node.interval.duration) > 0) {
    throw new Error(`Reference kernel cut.visual.trace at ${location} delay + duration${headRadius > 0 ? " + headFade" : ""} must fit its owning interval.`);
  }
}

function validateReachableNodeInterval(ir: CutAVIR, composition: IRComposition, node: IRNode) {
  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  if (node.sceneId && (!scene || !composition.sceneIds.includes(node.sceneId))) {
    throw new Error(`Reference node ${node.op} at ${nodeLocation(node)} belongs to a missing or different composition scene.`);
  }
  const owner = scene?.duration ?? composition.duration;
  if (compareRational(node.interval.start, zeroRational) < 0 || compareRational(node.interval.duration, zeroRational) < 0 || compareRational(addRational(node.interval.start, node.interval.duration), owner) > 0) {
    throw new Error(`Reference node ${node.op} interval at ${nodeLocation(node)} must be non-negative and remain inside its owning scene or timeline.`);
  }
}

function ceilNonNegativeRational(value: Rational) {
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function validateReachableTraceWork(ir: CutAVIR, composition: IRComposition, reachable: ReadonlySet<string>) {
  let total = 0n;
  for (const id of reachable) {
    const node = ir.nodes[id];
    if (!node || node.op !== "cut.visual.trace") continue;
    const prepared = prepareReferenceTraceNode(node);
    if (!prepared) continue;
    const activeFrames = ceilNonNegativeRational(multiplyRational(node.interval.duration, composition.fps));
    const pointFrames = activeFrames * BigInt(prepared.trace.points.length);
    if (pointFrames > BigInt(referenceTraceLimits.maxPointFramesPerNode)) {
      throw new Error(`Reference kernel cut.visual.trace at ${nodeLocation(node)} costs ${pointFrames} point-frames; the per-node limit is ${referenceTraceLimits.maxPointFramesPerNode}.`);
    }
    total += pointFrames;
    if (total > BigInt(referenceTraceLimits.maxPointFramesPerComposition)) {
      throw new Error(`Reachable Trace nodes cost ${total} point-frames; the composition limit is ${referenceTraceLimits.maxPointFramesPerComposition}.`);
    }
  }
}

type ReferenceValidationScope = "full" | "picture";

function validateReferenceSessionForScope(ir: CutAVIR, outputName: string | undefined, scope: ReferenceValidationScope): ReferenceSession {
  if (ir.format !== "cut-av-ir" || ir.version !== 3 || ir.language !== "0.4") throw new Error("Reference renderer needs CUT AV IR v3.");
  if (ir.determinism.semantic !== "locked") throw new Error("Reference renderer refuses unlocked IR. Run cut lock and av-build --lock first.");
  if (Object.values(ir.resources).some((resource) => resource.state !== "locked" || !resource.sha256)) throw new Error("Every CUT resource must be content-locked before rendering.");
  if (ir.jobs.some((job) => job.state !== "locked")) throw new Error("CUT effect jobs must be resolved and locked before rendering.");
  // Camera and other visual preflights sample authored signals before the
  // generic node loop. Validate those easings up front so malformed curves
  // fail source-located instead of escaping from propertyAt. Audio-owned
  // signals deliberately remain for the processor-specific validators below,
  // which preserve their stable CUT_AUDIO_AUTOMATION_* diagnostics.
  const earlyVisualEasingSignals = new Set<string>();
  for (const node of Object.values(ir.nodes)) if (node.domain !== "audio") {
    for (const property of Object.values(node.properties)) if ("signal" in property) earlyVisualEasingSignals.add(property.signal);
  }
  validateReferenceEasings(ir, earlyVisualEasingSignals);
  const assertionReport = evaluateCutDomainAssertions(ir);
  if (assertionReport.diagnostic && assertionReport.results.length === 0) {
    const diagnostic = assertionReport.diagnostic;
    const error = new Error(diagnostic.message) as Error & { code: string; source: CutDomainAssertionResult["source"] };
    error.code = diagnostic.code;
    error.source = diagnostic.source;
    throw error;
  }
  for (let assertionIndex = 0; assertionIndex < ir.assertions.length; assertionIndex += 1) {
    const assertion = ir.assertions[assertionIndex]!;
    const evaluated = assertionReport.results[assertionIndex]!;
    const source = evaluated.source;
    const reject = (code: string, message: string): never => {
      const error = new Error(`${code}: ${message} at ${source.module}:${source.line}:${source.column}.`) as Error & { code: string; source: CutDomainAssertionResult["source"] };
      error.code = code;
      error.source = source;
      throw error;
    };
    if (evaluated.status === "error") reject(evaluated.diagnostic.code, evaluated.diagnostic.message.replace(/ at .*:\d+:\d+\.$/u, ""));
    if (evaluated.status === "unsupported") reject(evaluated.code, evaluated.message.replace(/ at .*:\d+:\d+\.$/u, ""));
    if (assertion.status !== evaluated.status) reject("CUT_ASSERT_STATUS_MISMATCH", `stored assertion status ${assertion.status} does not match recomputed ${evaluated.status}`);
    if (evaluated.status === "fail") reject("CUT_ASSERT_FAILED", assertion.message ? `authored assertion failed: ${assertion.message}` : `authored assertion ${assertion.id} failed`);
  }
  const output = outputName ? ir.outputs.find((item) => item.name === outputName) : ir.outputs[0]; if (!output) throw new Error(`Unknown CUT output “${outputName ?? "(first)"}”.`);
  const composition = ir.compositions.find((item) => item.id === output.timelineId); if (!composition) throw new Error(`Output references missing composition ${output.timelineId}.`);
  const outputContract = validateCutOutputContract(output, composition);
  const durationSeconds = rationalToNumber(composition.duration), framesPerSecond = rationalToNumber(composition.fps);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 7_200) throw new Error(`Timeline “${composition.name}” exceeds the reference runtime's two-hour duration limit.`);
  if (!Number.isFinite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 120) throw new Error(`Timeline “${composition.name}” fps must be between 1 and 120 for the reference runtime.`);
  if (!Number.isSafeInteger(composition.width) || !Number.isSafeInteger(composition.height) || composition.width < 1 || composition.height < 1 || composition.width > 4_096 || composition.height > 4_096 || composition.width * composition.height > 16_777_216) throw new Error(`Timeline “${composition.name}” exceeds the reference runtime's canvas limit.`);
  if (!Number.isSafeInteger(composition.sampleRate) || composition.sampleRate < 8_000 || composition.sampleRate > 192_000) throw new Error(`Timeline “${composition.name}” sample rate must be between 8 kHz and 192 kHz.`);
  if (durationSeconds * framesPerSecond > 1_000_000) throw new Error(`Timeline “${composition.name}” exceeds the reference runtime's one-million-frame limit.`);
  if (composition.sceneIds.length > 10_000 || Object.keys(ir.nodes).length > 100_000 || Object.keys(ir.signals).length > 100_000) throw new Error("CUT graph exceeds the reference runtime's structural limits.");
  if (multiplyRational(composition.duration, rational(composition.sampleRate)).denominator !== "1") throw new Error(`Timeline “${composition.name}” duration does not land on a ${composition.sampleRate} Hz sample boundary.`);
  const unsupportedTimelineNodes = composition.items.filter((item) => item.kind === "node" && item.domain !== "audio");
  if (unsupportedTimelineNodes.length) throw new Error("Reference renderer v0.2 supports timeline-level audio nodes only; place visual and linked audiovisual nodes in scenes.");
  let cursor = zeroRational;
  for (const item of composition.items) {
    if (item.kind !== "scene") continue; const scene = ir.scenes[item.id];
    if (compareRational(scene.start, cursor) !== 0) throw new Error("Reference renderer v0.1 requires contiguous, non-overlapping scenes.");
    cursor = addRational(scene.start, scene.duration);
  }
  // Audio-only compositions may consist entirely of timeline-level audio
  // nodes. Once picture scenes exist, they must cover the destination exactly
  // so the renderer never invents implicit black gaps.
  if (composition.sceneIds.length > 0 && compareRational(cursor, composition.duration) !== 0) throw new Error("Reference renderer v0.1 requires scenes to cover the composition exactly.");
  const precompGraph = validateReferencePrecompGraph(ir, composition);
  // Replay and correlate the signed semantic edit plans to their executable
  // track materializations before picture or PCM preparation trusts them.
  const timelineEditValidation = validateReferenceTimelineEditMaterializations(ir);
  const timelineEditTrackNodeIds = new Set(
    timelineEditValidation.plans.flatMap((plan) =>
      plan.trackBindings.map((binding) => binding.trackNodeId)),
  );
  const reachableByComposition = new Map<string, Set<string>>();
  const audioExecutionByComposition = new Map<string, { roots: string[]; expansionVisits: number }>();
  const linkedEditByComposition = new Map<string, ReferenceLinkedEditAuthorizations>();
  const localSpaceContextByNode = new Map<string, ReferenceLocalSpaceConfig>();
  const validatedAnchoredGeometryByNode = new Map<string, ReferenceValidatedAnchoredPathGeometry>();
  const responsiveContextByNode = new Map<string, ReferenceResponsiveStackLocalContext>();
  const reachable = new Set<string>();
  const localSpaceStructuralIndex = createReferenceLocalSpaceStructuralValidationIndex(ir);
  for (const compositionId of precompGraph.compositionIds) {
    const nestedComposition = ir.compositions.find((candidate) => candidate.id === compositionId);
    if (!nestedComposition) throw new Error(`Precomp graph references missing composition ${compositionId}.`);
    const linkedEditAuthorizations = validateReferenceLinkedEditTransactions(ir, nestedComposition);
    linkedEditByComposition.set(compositionId, linkedEditAuthorizations);
    if (scope === "full") {
      const audioRoots = referenceAudioCompositionRootIds(ir, nestedComposition);
      const audioGraph = assertCutGraphExecutionBudget(ir, audioRoots);
      audioExecutionByComposition.set(compositionId, { roots: audioRoots, expansionVisits: audioGraph.expansionVisits });
    }
    const nestedReachable = scope === "full"
      ? referenceReachableCompositionNodes(ir, nestedComposition)
      : referenceReachablePictureCompositionNodes(ir, nestedComposition);
    reachableByComposition.set(compositionId, nestedReachable);
    nestedReachable.forEach((id) => reachable.add(id));
    // A structural AudioTrack plan owns the source ranges it derives. Replay
    // it before generic child-interval validation so a split/trim/slide-created
    // native-clock or bound failure is reported against the causative edit,
    // not merely against its compiler-materialized AudioClip child.
    for (const id of nestedReachable) {
      const node = ir.nodes[id];
      if (node?.op === "cut.edit.audio_track") validateReferenceAudioTrackOperationPlan(
        ir,
        nestedComposition,
        node,
        linkedEditAuthorizations.audioByTrackId.get(node.id),
      );
    }
    for (const id of nestedReachable) {
      const node = ir.nodes[id];
      // Linked Clip owns a stricter frame/sample validator below.
      if (node && node.op !== "cut.edit.clip") validateReachableNodeInterval(ir, nestedComposition, node);
    }
    validateReferenceGeoLabelNodeBudget(ir, nestedReachable);
    validateReferenceTonalCurveNodeBudget(ir, nestedReachable);
    validateReachableTraceWork(ir, nestedComposition, nestedReachable);
    const localSpaceConfigs = validateReferenceLocalSpaceGraph(ir, nestedComposition, nestedReachable, {
      structuralIndex: localSpaceStructuralIndex,
    });
    const identityComponentFragments = validateReferenceIdentityComponentFragments(
      ir,
      nestedComposition,
      nestedReachable,
      localSpaceStructuralIndex.componentFragmentAdmissionIndex,
    );
    for (const [nodeId, config] of referenceLocalSpaceDescendantContexts(ir, localSpaceConfigs)) localSpaceContextByNode.set(nodeId, config);
    const responsiveConfigs = validateReferenceResponsiveStackGraph(
      ir,
      nestedComposition,
      nestedReachable,
      identityComponentFragments,
    );
    for (const [nodeId, config] of referenceResponsiveStackDescendantContexts(responsiveConfigs)) responsiveContextByNode.set(nodeId, config);
    const parallaxConfigs = validateReferenceParallaxCameraGraph(ir, nestedComposition, nestedReachable, { easingsValidated: true });
    validateReferenceGeoAnnotationGraph(ir, nestedComposition, parallaxConfigs, nestedReachable, localSpaceConfigs);
    let mediaCameraPlans: ReadonlyMap<string, ReferenceMediaCamera2DPlan> | undefined;
    for (const id of nestedReachable) {
      const node = ir.nodes[id];
      if (!node || !isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) continue;
      if (node.op !== "cut.visual.path" && node.op !== "cut.visual.motion_path") {
        throw new Error(`CUT anchored geometry reached unsupported consumer ${node.op} at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}.`);
      }
      const decoded = decodeReferenceAnchoredPathGeometry(node, node.inputs.geometry, "geometry");
      if (decoded.ownerNodeIds.some((ownerNodeId) => ir.nodes[ownerNodeId]?.op === "cut.visual.media_camera2d")) {
        mediaCameraPlans ??= validateReferenceMediaCamera2DGraph(ir, nestedComposition, nestedReachable);
      }
      validatedAnchoredGeometryByNode.set(
        node.id,
        validateReferenceAnchoredPathGeometry(
          ir,
          nestedComposition,
          node,
          decoded,
          localSpaceConfigs,
          mediaCameraPlans,
          identityComponentFragments,
        ),
      );
    }
    const vectorPathWork = [...nestedReachable].flatMap((id) => {
      const node = ir.nodes[id];
      if (!node || node.op !== "cut.visual.path" || node.inputs.geometry === undefined) return [];
      if (isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) return [];
      const plan = prepareReferenceVectorPathNode(ir, node);
      if (!plan) throw new Error(`Internal CUT retained Path ${node.id} did not produce an executable plan.`);
      return [{ node, work: validateReferenceVectorPathFrameStates(ir, nestedComposition, node, plan) }];
    });
    const anchoredVectorPathWork = [...nestedReachable].flatMap((id) => {
      const node = ir.nodes[id], geometry = validatedAnchoredGeometryByNode.get(id);
      if (!node || node.op !== "cut.visual.path" || !geometry) return [];
      const plan = prepareReferenceAnchoredVectorPathNode(ir, node, geometry);
      if (!plan) throw new Error(`Internal CUT anchored Path ${node.id} did not produce an executable plan.`);
      return [{ node, work: validateReferenceAnchoredVectorPathStructuralWork(nestedComposition, node, plan) }];
    });
    validateReferenceVectorPathCompositionWork(vectorPathWork);
    validateReferenceVectorPathCompositionAuthoredWork([
      ...vectorPathWork.map(({ node, work }) => ({ node, authoredSegmentFrames: work.authoredSegmentFrames })),
      ...anchoredVectorPathWork.map(({ node, work }) => ({ node, authoredSegmentFrames: work.authoredSegmentFrames })),
    ]);
    validateReferenceAnchoredVectorPathCompositionStructuralWork(anchoredVectorPathWork);
    validateReferenceChromaKeyCompositionBudget(
      [...nestedReachable].flatMap((id) => {
        const node = ir.nodes[id];
        return node?.op === "cut.visual.chroma_key" ? [node] : [];
      }),
      nestedComposition.width,
      nestedComposition.height,
    );
    const clipPaths = [...nestedReachable].flatMap((id) => {
      const node = ir.nodes[id];
      if (!node || node.op !== "cut.visual.clip_path") return [];
      const config = referenceClipPathConfig(ir, node);
      if (!config) throw new Error("Internal CUT ClipPath configuration mismatch.");
      const context = localSpaceContextByNode.get(node.id);
      return [{
        node,
        config,
        width: context?.width ?? nestedComposition.width,
        height: context?.height ?? nestedComposition.height,
      }];
    });
    validateReferenceClipPathContextBudget(clipPaths);
    validateReferenceMotionBlurCompositionBudget(ir, nestedReachable, nestedComposition.width, nestedComposition.height);
  }
  const owningComposition = (node: IRNode) => {
    const sceneId = node.sceneId;
    if (sceneId) return ir.compositions.find((candidate) => candidate.sceneIds.includes(sceneId)) ?? composition;
    return ir.compositions.find((candidate) =>
      candidate.rootVisualIds.includes(node.id)
      || candidate.rootAudioIds.includes(node.id)
      || candidate.rootAVIds.includes(node.id)
      || candidate.items.some((item) => item.kind === "node" && item.id === node.id)) ?? composition;
  };
  if (scope === "full") planReferenceAudioRouting(ir, composition);
  validateReferenceLutResourceOwnership(ir);
  validateReferenceTrack2DResourceOwnership(ir);
  validateReferencePlanarTrackResourceOwnership(ir);
  const directNodeParents = referenceDirectNodeParents(ir);
  const reachableCaptionNodes = [...reachable].filter((id) =>
    ir.nodes[id]?.op === "cut.visual.captions"
    || ir.nodes[id]?.op === "cut.visual.transcript_captions");
  const reachableEvidenceNodes = [...reachable].filter((id) => ir.nodes[id]?.op === "cut.documentary.evidence");
  const reachableTextNodes = [...reachable].filter((id) => ir.nodes[id]?.op === "cut.visual.text");
  const reachableFlowTextNodes = [...reachable].filter((id) => ir.nodes[id]?.op === "cut.visual.flow_text");
  if (reachableCaptionNodes.length > referenceCaptionLimits.maxNodesPerComposition) throw new Error(`CUT composition exceeds the ${referenceCaptionLimits.maxNodesPerComposition}-caption-node reference limit.`);
  if (reachableEvidenceNodes.length > referenceEvidenceLimits.maxNodesPerComposition) throw new Error(`CUT composition exceeds the ${referenceEvidenceLimits.maxNodesPerComposition}-Evidence-node reference limit.`);
  if (reachableTextNodes.length > referenceTextLimits.maxNodesPerComposition) throw new Error(`CUT composition exceeds the ${referenceTextLimits.maxNodesPerComposition}-Text-node reference limit.`);
  if (reachableFlowTextNodes.length > referenceFlowTextLimits.maxNodesPerComposition) throw new Error(`CUT composition exceeds the ${referenceFlowTextLimits.maxNodesPerComposition}-FlowText-node reference limit.`);
  for (const node of Object.values(ir.nodes)) {
    const location = `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
    const nodeComposition = owningComposition(node);
    const linkedEditAuthorizations = linkedEditByComposition.get(nodeComposition.id);
    const schema = referenceKernelSchema(node.op);
    if (!schema) throw new Error(`Reference renderer does not implement ${node.op} at ${location}; it will not substitute a placeholder.`);
    if (schema.support === "refused") throw new Error(`Reference renderer refuses ${node.op} at ${location}: ${schema.reason}`);
    validateCutVisualPropertyTrackBaselines(ir, node);
    // AudioRegion establishes its structural cardinality before the generic
    // kernel no-op check so every materialization boundary shares one stable
    // CUT_EDIT_AUDIO_REGION precedence for forged branches.
    if (node.op !== "cut.edit.audio_region") validateReferenceNoOpContract(node, ir);
    if (node.editorial && node.op !== "cut.edit.sequence" && node.op !== "cut.edit.picture_track" && node.op !== "cut.edit.audio_track") {
      throw new ReferencePictureEditorialError("CUT_EDIT_SEQUENCE", node.id, node, `${node.op} cannot carry Sequence/PictureTrack/AudioTrack editorial metadata`);
    }
    validateVisualCompositingNode(node, location);
    referenceStackConfig(node, nodeComposition);
    referenceGeoLabelConfig(node, ir);
    validateReferenceGeoConfig(ir, nodeComposition, node);
    validateReferenceVisualReveal(ir, node);
    referenceShapeNodeConfig(ir, nodeComposition, node);
    referenceChartConfig(ir, node, nodeComposition);
    referenceSeriesChartConfig(ir, node, nodeComposition);
    referenceVideoConfig(ir, nodeComposition, node);
    referenceVideoInputColorConfig(ir, node);
    validateReferenceColorGradeConfig(ir, node);
    referenceColorConvertConfig(node);
    referenceTonalCurveConfig(node);
    referenceLutConfig(ir, node);
    referenceMaskConfig(ir, node);
    referenceChromaKeyConfig(ir, node);
    const clipPath = referenceClipPathConfig(ir, node);
    if (clipPath && reachable.has(node.id)) {
      const context = localSpaceContextByNode.get(node.id);
      prepareReferenceClipPath(node, clipPath, context?.width ?? nodeComposition.width, context?.height ?? nodeComposition.height);
    }
    const motionBlur = referenceMotionBlurConfig(node);
    if (motionBlur) {
      const child = ir.nodes[node.children[0]];
      if (!child) throw new Error(`CUT MotionBlur ${node.id} has no direct child for boundary preflight.`);
      prepareReferenceMotionBlurBoundary(node, child, divideRational(rational(1), nodeComposition.fps), motionBlur);
    }
    referenceTrack2DConfig(ir, node);
    referencePlanarTrackConfig(ir, node);
    if (isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) {
      prepareReferenceAnchoredVectorPathNode(ir, node, validatedAnchoredGeometryByNode.get(node.id));
    } else {
      prepareReferenceVectorPathNode(ir, node);
    }
    validateVisualPolylineNode(node, location);
    validateVisualTraceNode(node, ir, location);
    validateReferenceMotionPath(ir, node);
    validateReferenceVisualTransform(ir, nodeComposition, node);
    if (node.op === "cut.visual.motion_path" && !isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) {
      // Preflight every authored nonzero segment, not only the segment selected
      // by the initial progress. Dynamic transform tracks are revalidated on
      // every executed frame after their tangent is composed by visual.ts.
      const authored = referenceVisualTransformAt(ir, nodeComposition, node, node.interval.start, { staticPosition: true, staticRotation: true });
      for (const tangent of referenceMotionPathTangentRotations(node)) {
        validateReferenceVisualTransformAllocation(node, nodeComposition, { ...authored, rotation: authored.rotation + tangent });
      }
    }
    referenceVisualEffectConfig(node);
    if (reachable.has(node.id)) referenceAudioNodeConfig(ir, nodeComposition, node);
    if (reachable.has(node.id)) referenceCaptionConfig(node, ir, nodeComposition);
    if (reachable.has(node.id)) referenceTranscriptCaptionConfig(node, ir, nodeComposition);
    if (reachable.has(node.id)) referenceEvidenceConfig(node, ir, nodeComposition);
    const localSpace = localSpaceContextByNode.get(node.id), responsive = responsiveContextByNode.get(node.id);
    const boundedContext = localSpace ?? responsive;
    const visualComposition = boundedContext ? { ...nodeComposition, width: boundedContext.width, height: boundedContext.height } : nodeComposition;
    const textLayoutContext = localSpace ? referenceLocalSpaceTextLayoutContext(localSpace) : responsive ? referenceResponsiveStackTextLayoutContext(responsive) : undefined;
    if (reachable.has(node.id)) referenceTextConfig(node, ir, visualComposition, textLayoutContext);
    if (reachable.has(node.id)) referenceFlowTextConfig(node, ir, visualComposition, textLayoutContext);
    if (schema.domain !== "any" && schema.domain !== node.domain) throw new Error(`Reference kernel ${node.op} at ${location} has domain ${node.domain}; its executable contract requires ${schema.domain}.`);
    for (const input of Object.keys(node.inputs)) if (!kernelAcceptsInput(schema, input)) {
      throw new Error(`Reference kernel ${node.op} at ${location} does not execute input “${input}”; refusing a silent no-op.`);
    }
    for (const [input, value] of Object.entries(node.inputs)) {
      const allowed = kernelStringInputValues(schema, input);
      if (allowed && (value.kind !== "string" || !allowed.includes(value.value))) {
        throw new Error(`Reference kernel ${node.op} at ${location} input “${input}” must be one of: ${allowed.join(", ")}.`);
      }
    }
    for (const [property, value] of Object.entries(node.properties)) {
      if (!kernelAcceptsProperty(schema, property)) throw new Error(`Reference kernel ${node.op} at ${location} does not execute property “${property}”; refusing a silent no-op.`);
      const automationOwnsMissingSignal =
        (node.op === "cut.audio.gain" && property === "amount")
        || (node.op === "cut.audio.pan" && property === "position")
        || (node.op === "cut.audio.reverb" && property === "wet")
        || (node.op === "cut.audio.eq" && (property === "frequency" || property === "gain" || property === "q"))
        || ((node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass") && (property === "frequency" || property === "q"))
        || (node.op === "cut.audio.compressor" && compressorAutomationProperties.includes(property as typeof compressorAutomationProperties[number]))
        || (node.op === "cut.audio.limiter" && limiterAutomationProperties.includes(property as typeof limiterAutomationProperties[number]))
        || (node.op === "cut.audio.deesser" && deEsserAutomationProperties.includes(property as typeof deEsserAutomationProperties[number]))
        || (node.op === "cut.audio.sidechain" && sidechainAutomationProperties.includes(property as typeof sidechainAutomationProperties[number]));
      if ("signal" in value && !ir.signals[value.signal] && !automationOwnsMissingSignal) throw new Error(`Reference kernel ${node.op} at ${location} references missing signal ${value.signal} for property “${property}”.`);
    }
    if (schema.children === "none" && node.children.length) throw new Error(`Reference kernel ${node.op} at ${location} does not execute child nodes; refusing ${node.children.length} ignored child node(s).`);
    if (schema.children !== "none" && schema.children !== "any") {
      for (const childId of node.children) {
        const child = ir.nodes[childId];
        if (!child) throw new Error(`Reference kernel ${node.op} at ${location} references missing child ${childId}.`);
        if (child.domain !== schema.children) throw new Error(`Reference kernel ${node.op} at ${location} requires ${schema.children} children; ${child.op} has domain ${child.domain}.`);
      }
    }
    if (reachable.has(node.id) && node.op === "cut.edit.clip") validateLinkedClip(ir, nodeComposition, node);
    if (reachable.has(node.id) && node.op === "cut.edit.transition") referenceTransitionContract(ir, nodeComposition, node, directNodeParents);
    if (reachable.has(node.id) && (node.op === "cut.edit.jcut" || node.op === "cut.edit.lcut")) referenceLinkedSplitContract(ir, nodeComposition, node, directNodeParents);
    if (reachable.has(node.id) && (node.op === "cut.edit.sequence" || node.op === "cut.edit.picture_track" || node.op === "cut.edit.picture_clip" || node.op === "cut.edit.gap")) validatePictureEditorialNode(
      ir,
      nodeComposition,
      node,
      linkedEditAuthorizations?.pictureByTrackId.get(node.id),
    );
    if (reachable.has(node.id) && (node.op === "cut.edit.audio_track" || node.op === "cut.edit.audio_region" || node.op === "cut.edit.audio_gap" || (node.op === "cut.audio.clip" && !hasAudioRegionAncestor(ir, node.id, directNodeParents) && (node.inputs.destination !== undefined || node.inputs.link !== undefined || node.inputs.headHandle !== undefined || node.inputs.tailHandle !== undefined || directAudioTrackParents(ir, node).length > 0)))) validateAudioEditorialNode(
      ir,
      nodeComposition,
      node,
      linkedEditAuthorizations?.audioByTrackId.get(node.id),
    );
    if (reachable.has(node.id) && (node.op === "cut.audio.gain" || node.op === "cut.audio.pan" || node.op === "cut.audio.reverb")) compileReferenceAudioAutomation(ir, nodeComposition, node);
    if (reachable.has(node.id) && node.op === "cut.audio.eq") compileReferenceParametricEqAutomations(ir, nodeComposition, node);
    if (reachable.has(node.id) && (node.op === "cut.audio.highpass" || node.op === "cut.audio.lowpass")) compileReferenceStateVariableFilterAutomations(ir, nodeComposition, node);
    if (reachable.has(node.id) && node.op === "cut.audio.compressor") compileReferenceCompressorAutomations(ir, nodeComposition, node);
    if (reachable.has(node.id) && node.op === "cut.audio.limiter") compileReferenceLimiterAutomations(ir, nodeComposition, node);
    if (reachable.has(node.id) && node.op === "cut.audio.deesser") compileReferenceDeEsserAutomations(ir, nodeComposition, node);
    if (reachable.has(node.id) && node.op === "cut.audio.sidechain") compileReferenceSidechainAutomations(ir, nodeComposition, node);
  }
  validateEditorialLinkGroups(ir, timelineEditTrackNodeIds);
  // Catch unattached or otherwise non-visual easing signals after every
  // reachable audio processor had the opportunity to issue its stronger,
  // domain-specific diagnostic.
  if (scope === "full") {
    validateReferenceEasings(ir);
    for (const [compositionId, nestedReachable] of reachableByComposition) {
      const nestedComposition = ir.compositions.find((candidate) => candidate.id === compositionId)!;
      const audioExecution = audioExecutionByComposition.get(compositionId)!;
      validateReferenceAudioCompositionResources(ir, nestedComposition, audioExecution.roots, audioExecution.expansionVisits);
      validateReferenceAudioAutomationBudget(ir, nestedComposition, nestedReachable);
      validateReferenceAudioLimiterPlans(ir, nestedComposition, audioExecution.roots);
      validateReferenceTempoDelayPlans(ir, nestedComposition, audioExecution.roots);
      validateReferenceTimeStretchPlans(ir, nestedComposition, [...nestedReachable].filter((id) => ir.nodes[id]?.op === "cut.audio.time_stretch"));
      validateReferenceSynthPlans(ir, nestedComposition, [...nestedReachable].filter((id) => ir.nodes[id]?.op === "cut.audio.synth"));
    }
  }
  return { output, composition, outputContract };
}

/** Validate the complete picture and audio program before an audiovisual render. */
export function validateReferenceSession(ir: CutAVIR, outputName?: string): ReferenceSession {
  return validateReferenceSessionForScope(ir, outputName, "full");
}

/**
 * Validate only the executable picture closure for frame/contact extraction.
 * Compiler, lock, output, assertion, schema and visual runtime contracts remain
 * fail-closed; unrelated standalone audio work is not planned or materialized.
 */
export function validateReferencePictureSession(ir: CutAVIR, outputName?: string): ReferenceSession {
  return validateReferenceSessionForScope(ir, outputName, "picture");
}
