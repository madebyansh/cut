import { hash, stableJsonStringify } from "../core/stable";
import type { CutModule, Declaration, Expression, SourceSpan, Statement } from "./ast";
import { checkCutModule, hasTypeErrors, nodeDomain, type CheckResult } from "./checker";
import { cutAnchoredPathLimits, cutAnchoredSpatialOps } from "./anchored-path-contract";
import {
  CutMediaCamera2DContractError,
  cutMediaCamera2DDefaultIRValue,
  cutMediaCamera2DOp,
  validateCutMediaCamera2DLanguageIR,
} from "./media-camera2d-contract";
import {
  CutDataLayoutError,
  decodeCutKeyedNumber,
  decodeCutMarkTarget,
  deriveCutBarLayout,
  formatCutNumber,
  joinCutBarLayoutTargets,
} from "./data-layout";
import { CutTableQueryError } from "./table-query";
import { cutTableQueryPlanFromIr } from "./table-query-ir";
import {
  CutResponsiveStackError,
  deriveCutResponsiveSlotMediaContext,
  deriveCutResponsiveStackPlan,
} from "./responsive-layout";
import { CutDiagramContractError, validateCutDiagramLanguageIR } from "./diagram-contract";
import type { CutAVIR, IRAudioAmplitudeProducer, IRAssertion, IRComposition, IREditorial, IREditorialInterval, IREffectJob, IRLinkedEdit, IRNode, IROutput, IRProvenance, IRResource, IRScene, IRSemanticMatchSubjectV1, IRSemanticMatchTransitionV1, IRSignal, IRSignalEvent, IRTimelineMarker, IRTimelineRegion, IRTranscriptBindingV1, IRTranscriptMediaAuthorityV1, IRValue } from "./ir";
import { builtinPackages, type NodeDomain, type PackageCompileTimeLowering, type PackageSymbol } from "./packages";
import { addRational as rawAddRational, compareRational, decimalRational, divideRational as rawDivideRational, multiplyRational as rawMultiplyRational, rational, rationalToNumber, subtractRational as rawSubtractRational, type Rational, zeroRational } from "./rational";
import { cutIrIdentity, cutSignalContentHash, finalizeGraphHashes } from "../runtime/graph";
import { cutCompilerIdentity, cutLanguageVersion } from "../version";
import { assertResolvedCutIr } from "./resolution";
import { validateCutOutputContract } from "./output-contract";
import { kernelPropertyValueType, kernelStringInputValues, referenceKernelSchema } from "./kernel-registry";
import { resolveCutVisualPropertyTrackBaseline } from "./visual-property-baselines";
import { ReferenceTransitionContractError, referenceTransitionContract } from "../runtime/reference/transition-config";
import { ReferenceLinkedSplitContractError, referenceLinkedSplitContract } from "../runtime/reference/linked-split-config";
import { ReferenceNoOpContractError, validateReferenceNoOpContract } from "../runtime/reference/noop-contract";
import { planReferenceAudioRouting, ReferenceAudioRoutingError } from "../runtime/reference/audio-routing";
import { ReferenceAudioConfigError } from "../runtime/reference/audio-config";
import { referenceAudioCompositionRootIds } from "../runtime/reference/audio-resource";
import {
  ReferenceTempoDelayConfigError,
  validateReferenceTempoDelayPlans,
} from "../runtime/reference/audio-tempo-delay-config";
import { ReferencePrecompError, validateReferencePrecompGraph } from "../runtime/reference/precomp-config";
import { ReferenceMaskError, referenceMaskConfig } from "../runtime/reference/mask-config";
import {
  ReferencePlanarTrackMatteError,
  referencePlanarTrackMatteConfig,
} from "../runtime/reference/planar-track-matte";
import { ReferenceChromaKeyError, referenceChromaKeyConfig, referenceChromaKeyNodesForComposition, validateReferenceChromaKeyCompositionBudget } from "../runtime/reference/chroma-key";
import { prepareReferenceClipPath, ReferenceClipPathError, referenceClipPathConfig, validateReferenceClipPathCompositionBudget, type ReferenceClipPathConfig } from "../runtime/reference/clip-path";
import { ReferenceMotionBlurError, referenceMotionBlurConfig, validateReferenceMotionBlurCompositionBudget } from "../runtime/reference/motion-blur";
import { prepareReferenceMotionBlurBoundary } from "../runtime/reference/motion-blur-boundary";
import { ReferenceChartError, referenceChartConfig } from "../runtime/reference/chart-config";
import { ReferenceSeriesChartError, referenceSeriesChartConfig } from "../runtime/reference/series-chart-config";
import { ReferenceVisualConfigError, validateReferenceVisualTransform } from "../runtime/reference/visual-config";
import { cutPackageImplementationKey, type CutExternalPackageContext } from "../package/context";
import { linkedRippleSegmentIds } from "./linked-ripple-identity";
import { isNeutralLinkedRipplePictureInputs } from "./linked-ripple-neutral";
import { collectInstalledComplexTextBackendIdentity } from "./dependency-identity";
import { PictureTimeMapInputError, authoredPictureTimeMap, canonicalPictureTimeMapInputs, isDefaultPictureTimeMap } from "./picture-time-map";
import {
  executePictureTrackOperationPlan,
  pictureEditMaterializedNodeId,
  pictureEditOperationsFromInput,
  PictureEditOperationError,
  type IRPictureEditItem,
  type IRPictureTrackExecution,
  type IRPictureTrackOperationPlan,
} from "./picture-edit-operations";
import {
  audioEditMaterializedNodeId,
  audioEditOperationsFromInput,
  AudioEditOperationError,
  executeAudioEditOperationPlan,
  type AudioEditExecution,
  type AudioEditItem,
  type AudioEditOperationErrorCode,
  type AudioEditOperationPlan,
  type AudioEditOperationPlanV1,
  type AudioEditOperationPlanV2,
  type AudioEditRegionItem,
} from "./audio-edit-operations";
import {
  executeTimelineEditPlan,
  timelineEditLimits,
  TimelineEditError,
} from "./timeline-edit-operations";
import {
  stageTimelineEditIrV1,
  type TimelineEditIrStageV1,
} from "./timeline-edit-ir-adapter";
import {
  stageTimelineEditIrMaterializationV1,
  type TimelineEditIrMaterializationV1,
} from "./timeline-edit-ir-materializer";
import type { CutUserModuleGraph, CutUserSourceModule } from "./user-modules";
import {
  assertEditorialMarkerTime,
  assertEditorialRegionRange,
  editorialAnnotationLimits,
  editorialAnnotationMetadataBytes,
  EditorialAnnotationError,
  normalizeEditorialAnnotationMetadata,
} from "./editorial-annotations";
import { evaluateCutDomainAssertions } from "./domain-assertions";
import { prepareReferenceTraceNode, ReferenceTraceError } from "../runtime/reference/trace";
import { ReferenceMotionPathError, validateReferenceMotionPath } from "../runtime/reference/motion-path";
import {
  ReferenceCamera3DError,
  referenceCamera3DLimits,
  referenceCamera3DPlanAt,
  validateReferenceCamera3DGraph,
} from "../runtime/reference/camera3d";
import { ReferenceResponsiveStackError, validateReferenceResponsiveStackGraph } from "../runtime/reference/responsive-layout";
import { ReferenceColorManagementError, referenceVideoInputColorDeclaration } from "../runtime/reference/color-management";
import {
  parseCutTranscript,
  selectTranscriptRange,
  TranscriptInterchangeError,
} from "../interchange/transcript";
import { cutCaptionAppearanceLimits } from "../interchange/captions";
import {
  CutTranscriptMediaAuthorityError,
  CutTranscriptPictureSnapError,
  cutTranscriptExecutableLimits,
  cutTranscriptMediaAuthorityContract,
  cutTranscriptMediaAuthorityIdentity,
  cutTranscriptMediaVideoSourceRange,
  cutTranscriptPictureCoverRange,
  cutTranscriptPictureIdentity,
  cutTranscriptPictureOriginIdentity,
  cutTranscriptPictureSegmentIdentity,
  cutTranscriptPictureVideoSourceRange,
} from "./transcript-contract";
import {
  CutTranscriptTimelineCaptionError,
  cutTranscriptCaptionIdentity,
} from "./transcript-timeline-edit";
import {
  CutTypedDataAssetAuthorityError,
  assertCutTypedDataAssetConsumerCompatibility,
  cutTypedDataAssetAuthorityForConstructor,
} from "./typed-data-asset";

export class CutCompileError extends Error {
  constructor(readonly result: CheckResult, readonly moduleName?: string) {
    super(`CUT compilation failed with ${result.diagnostics.filter((item) => item.severity === "error").length} error(s)${moduleName ? ` in ${moduleName}` : ""}.`);
  }
}

export type CutCompileLimits = {
  maxExpansionDepth: number;
  maxFunctionCalls: number;
  maxValueNodes: number;
  maxStatements: number;
  maxNodes: number;
  maxSignals: number;
  maxAssertions: number;
  maxAnnotations: number;
  maxAnnotationMetadataBytes: number;
  maxResources: number;
  maxScenes: number;
  maxCompositions: number;
};

/**
 * Bounded, caller-supplied semantic sidecars needed during pure lowering.
 * Keys are declared DataAsset resource ids. The compiler never performs I/O;
 * CLI callers securely resolve and read only sidecars referenced by
 * transcriptEdit before invoking compilation.
 */
export type CutCompileInputs = Readonly<{
  transcriptSidecars?: ReadonlyMap<string, string | Uint8Array>;
}>;

export class CutCompileLimitError extends Error {
  constructor(readonly limit: keyof CutCompileLimits) { super(`CUT compilation exceeded ${limit}.`); }
}

export class CutCompileRationalLimitError extends Error {
  constructor() {
    super("CUT exact rational exceeds the 256-digit CutAVIR limit during compilation.");
    this.name = "CutCompileRationalLimitError";
  }
}

const defaultCompileLimits: CutCompileLimits = {
  maxExpansionDepth: 64,
  maxFunctionCalls: 100_000,
  maxValueNodes: 1_000_000,
  maxStatements: 250_000,
  maxNodes: 100_000,
  maxSignals: 100_000,
  maxAssertions: 1_024,
  maxAnnotations: editorialAnnotationLimits.maximumAnnotations,
  maxAnnotationMetadataBytes: editorialAnnotationLimits.maximumTotalMetadataBytes,
  maxResources: 10_000,
  maxScenes: 10_000,
  maxCompositions: 1_000,
};

type BudgetCounter = "functionCalls" | "values" | "statements" | "nodes" | "signals" | "assertions" | "annotations" | "resources" | "scenes" | "compositions";
type CompileBudget = { limits: CutCompileLimits; annotationMetadataBytes: number } & Record<BudgetCounter, number>;

function compileLimits(overrides: Partial<CutCompileLimits>): CutCompileLimits {
  const limits = { ...defaultCompileLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`CUT compile limit ${name} must be a positive safe integer.`);
  return limits;
}

export { cutIrIdentity } from "../runtime/graph";
export function recomputeBuildId(ir: CutAVIR) { ir.buildId = cutIrIdentity(ir); return ir; }

type Environment = Map<string, IRValue>;
type Binding = { nodeId: string; domain: NodeDomain };
type IdentityState = { counters: Map<string, number> };
type UserModuleRuntimeExport = {
  kind: "value" | "function" | "component";
  value?: IRValue;
  declaration?: Extract<Declaration, { kind: "function" | "component" }>;
  check: CheckResult;
  moduleName: string;
  environment: Environment;
};
type UserModuleRuntime = {
  source: CutUserSourceModule;
  environment: Environment;
  exports: Map<string, UserModuleRuntimeExport>;
};
type UserModuleRuntimeContext = { graph: CutUserModuleGraph; modules: Map<string, UserModuleRuntime> };

export type LinkedTrimRequest = {
  id: string;
  compositionId: string;
  sceneId: string;
  linkId: string;
  /** Scene-local half-open destination interval. */
  keep: IREditorialInterval;
  provenance: IRProvenance;
};

export type LinkedRippleDeleteRequest = {
  kind: "linked-ripple-delete";
  id: string;
  compositionId: string;
  sceneId: string;
  linkId: string;
  /** Omitted preserves the exact complete-pair v1 transaction. */
  range?: IREditorialInterval;
  provenance: IRProvenance;
};

export type LinkedEditRequest = LinkedTrimRequest | LinkedRippleDeleteRequest;

type TimelineEditRequest = {
  id: string;
  compositionId: string;
  sceneId: string;
  duration?: Rational;
  operations: IRValue[];
  operationSpans: SourceSpan[];
  provenance: IRProvenance;
};

type EditorialAuthoringAttributes = {
  trackId?: string;
  editId?: string;
  role?: string;
  metadata?: Readonly<Record<string, string>>;
};

type SemanticMatchTransitionRequest = {
  authoredId: string;
  compositionId: string;
  cut: Rational;
  duration: Rational;
  outgoingAuthoredId: string;
  incomingAuthoredId: string;
  target: IRSemanticMatchTransitionV1["target"];
  easing: IRSemanticMatchTransitionV1["easing"];
  velocity?: IRSemanticMatchTransitionV1["velocity"];
  provenance: IRProvenance;
};

export type LinkedTrimDiagnosticCode =
  | "CUT_LINKED_TRIM_SCOPE"
  | "CUT_LINKED_TRIM_TIME"
  | "CUT_LINKED_TRIM_UNSUPPORTED"
  | "CUT_LINKED_TRIM_RESULT"
  | "CUT_LINKED_TRIM_LIMIT";

export class LinkedTrimError extends Error {
  constructor(
    readonly code: LinkedTrimDiagnosticCode,
    message: string,
    readonly requestIndex?: number,
  ) {
    super(message);
    this.name = "LinkedTrimError";
  }
}

export type LinkedRippleDeleteDiagnosticCode =
  | "CUT_LINKED_RIPPLE_SCOPE"
  | "CUT_LINKED_RIPPLE_TIME"
  | "CUT_LINKED_RIPPLE_UNSUPPORTED"
  | "CUT_LINKED_RIPPLE_RESULT"
  | "CUT_LINKED_RIPPLE_LIMIT";

export class LinkedRippleDeleteError extends Error {
  constructor(
    readonly code: LinkedRippleDeleteDiagnosticCode,
    message: string,
    readonly requestIndex?: number,
  ) {
    super(message);
    this.name = "LinkedRippleDeleteError";
  }
}

type LinkedEditDiagnosticCode = LinkedTrimDiagnosticCode | LinkedRippleDeleteDiagnosticCode;

type LowerContext = {
  check: CheckResult;
  ir: CutAVIR;
  moduleName: string;
  timeline: IRComposition;
  scene?: IRScene;
  localTime: Rational;
  duration: Rational;
  environment: Environment;
  moduleEnvironment: Environment;
  bindings: Map<string, Binding>;
  expansion: Array<{ module: string; span: SourceSpan; symbol: string }>;
  identity: IdentityState;
  budget: CompileBudget;
  externalPackages?: CutExternalPackageContext;
  externalChecks?: ReadonlyMap<string, CheckResult>;
  userModules?: UserModuleRuntimeContext;
  functionExpansion: Array<{ module: string; span: SourceSpan; symbol: string }>;
  /** Shared across spread lowering contexts; committed only after every scene lowers. */
  pendingLinkedEdits: LinkedEditRequest[];
  /** Shared across scene lowering; canonical operations resolve only after all
   * authored tracks and legacy per-track materializations exist. */
  pendingTimelineEdits: TimelineEditRequest[];
  /** Shared across all timeline passes and resolved only after every scene. */
  pendingSemanticMatchTransitions: SemanticMatchTransitionRequest[];
  /** Compile-local authored selector IDs removed from executable kernel inputs
   * and persisted only through closed editorial metadata. */
  editorialAuthoringIds: Map<string, EditorialAuthoringAttributes>;
  /** Compiler-authenticated identity component fragments whose first child is
   * one ResponsiveStack and whose remaining direct children are its anchored
   * Path/CalloutLayer consumers. This is compile-local evidence only; the
   * strict loader independently re-derives the boundary from persisted IR. */
  responsiveAnnotatedFragmentIds: Set<string>;
  /** True only for the immediate body of a declared scene. */
  directSceneStatementBlock: boolean;
  /** True only for one direct non-scene statement in a declared timeline. */
  directTimelineStatementBlock: boolean;
  /**
   * Exact AST identity of the direct scene-local let initializer currently
   * being lowered. Compiler-only authorities compare by object identity so an
   * authority nested in another call cannot masquerade as the direct
   * declaration even though recursive argument lowering shares scene context.
   */
  directSceneLetInitializer?: Expression;
  compileInputs: CutCompileInputs;
};

const budgetLimit: Record<BudgetCounter, keyof CutCompileLimits> = {
  functionCalls: "maxFunctionCalls",
  values: "maxValueNodes",
  statements: "maxStatements",
  nodes: "maxNodes",
  signals: "maxSignals",
  assertions: "maxAssertions",
  annotations: "maxAnnotations",
  resources: "maxResources",
  scenes: "maxScenes",
  compositions: "maxCompositions",
};

function consumeBudget(context: LowerContext, counter: BudgetCounter) {
  context.budget[counter] += 1;
  const limit = budgetLimit[counter];
  if (context.budget[counter] > context.budget.limits[limit]) throw new CutCompileLimitError(limit);
}

const maximumRationalDigits = 256;
function boundedRational(value: Rational) {
  const numeratorDigits = value.numerator.startsWith("-") ? value.numerator.length - 1 : value.numerator.length;
  if (numeratorDigits > maximumRationalDigits || value.denominator.length > maximumRationalDigits) throw new CutCompileRationalLimitError();
  return value;
}
function addRational(left: Rational, right: Rational) { return boundedRational(rawAddRational(left, right)); }
function subtractRational(left: Rational, right: Rational) { return boundedRational(rawSubtractRational(left, right)); }
function multiplyRational(left: Rational, right: Rational) { return boundedRational(rawMultiplyRational(left, right)); }
function divideRational(left: Rational, right: Rational) { return boundedRational(rawDivideRational(left, right)); }

// Pi is irrational, so a radian cannot have a mathematically exact finite
// rational degree representation. CUT makes that boundary explicit and
// deterministic with this versioned 16-decimal rational approximation rather
// than leaking host floating-point conversion into lowering or rendering.
const degreesPerRadian = decimalRational("57.29577951308232");

const quantityUnits: Record<string, { dimension: string; unit: string; scale: Rational }> = {
  "": { dimension: "scalar", unit: "scalar", scale: rational(1) }, ms: { dimension: "time", unit: "s", scale: rational(1, 1000) }, s: { dimension: "time", unit: "s", scale: rational(1) }, f: { dimension: "time", unit: "frame", scale: rational(1) }, beat: { dimension: "beat", unit: "beat", scale: rational(1) }, px: { dimension: "length", unit: "px", scale: rational(1) }, "%": { dimension: "ratio", unit: "ratio", scale: rational(1, 100) }, deg: { dimension: "angle", unit: "deg", scale: rational(1) }, rad: { dimension: "angle", unit: "deg", scale: degreesPerRadian }, db: { dimension: "gain", unit: "db", scale: rational(1) }, hz: { dimension: "frequency", unit: "hz", scale: rational(1) }, khz: { dimension: "frequency", unit: "hz", scale: rational(1000) }, lufs: { dimension: "loudness", unit: "lufs", scale: rational(1) }, dbtp: { dimension: "true-peak", unit: "dbtp", scale: rational(1) }, dbfs: { dimension: "sample-peak", unit: "dbfs", scale: rational(1) },
};

function provenance(module: string, span: SourceSpan, symbol?: string, expandedFrom?: LowerContext["expansion"]): IRProvenance {
  return { module, span, ...(symbol ? { symbol } : {}), ...(expandedFrom?.length ? { expandedFrom } : {}) };
}

function stableId(prefix: string, value: unknown) { return `${prefix}_${hash(value).slice(0, 16)}`; }
function semanticId(context: LowerContext, prefix: string, semantic: unknown) {
  const scope = `${context.moduleName}\0${context.timeline.id}\0${context.scene?.id ?? "timeline"}\0${prefix}`;
  const ordinal = context.identity.counters.get(scope) ?? 0;
  context.identity.counters.set(scope, ordinal + 1);
  return stableId(prefix, { module: context.moduleName, timeline: context.timeline.id, scene: context.scene?.id ?? null, ordinal, semantic });
}
function calleeName(expression: Expression): string | undefined {
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "member") { const parent = calleeName(expression.object); return parent ? `${parent}.${expression.property}` : undefined; }
  return undefined;
}

function quantityValue(expression: Extract<Expression, { kind: "number" }>, fps?: Rational): IRValue {
  const definition = quantityUnits[expression.unit];
  let magnitude = multiplyRational(decimalRational(expression.raw.slice(0, expression.raw.length - expression.unit.length)), definition.scale);
  let unit = definition.unit;
  if (expression.unit === "f" && fps) { magnitude = divideRational(magnitude, fps); unit = "s"; }
  return { kind: "quantity", dimension: definition.dimension, magnitude, unit };
}

function valueRational(value: IRValue | undefined, expectedDimension?: string): Rational | undefined {
  return value?.kind === "quantity" && (!expectedDimension || value.dimension === expectedDimension) ? value.magnitude : undefined;
}

function literalString(value: IRValue | undefined): string | undefined {
  return value?.kind === "string" ? value.value : undefined;
}
function cloneEnvironment(environment: Environment) { return new Map(environment); }

function evaluateBinary(operator: string, left: IRValue, right: IRValue): IRValue {
  if (left.kind === "quantity" && right.kind === "quantity") {
    if (operator === "+" && left.dimension === right.dimension && left.unit === right.unit) return { ...left, magnitude: addRational(left.magnitude, right.magnitude) };
    if (operator === "-" && left.dimension === right.dimension && left.unit === right.unit) return { ...left, magnitude: subtractRational(left.magnitude, right.magnitude) };
    if (operator === "*" && left.dimension === "scalar") return { ...right, magnitude: multiplyRational(left.magnitude, right.magnitude) };
    if (operator === "*" && right.dimension === "scalar") return { ...left, magnitude: multiplyRational(left.magnitude, right.magnitude) };
    if (operator === "/" && right.dimension === "scalar") return { ...left, magnitude: divideRational(left.magnitude, right.magnitude) };
    if (operator === "/" && left.dimension === right.dimension) return { kind: "quantity", dimension: "scalar", magnitude: divideRational(left.magnitude, right.magnitude), unit: "scalar" };
    if (["<", "<=", ">", ">=", "==", "!="].includes(operator) && left.dimension === right.dimension && left.unit === right.unit) {
      const comparison = compareRational(left.magnitude, right.magnitude); const value = operator === "<" ? comparison < 0 : operator === "<=" ? comparison <= 0 : operator === ">" ? comparison > 0 : operator === ">=" ? comparison >= 0 : operator === "==" ? comparison === 0 : comparison !== 0;
      return { kind: "boolean", value };
    }
  }
  if (operator === "==" || operator === "!=") { const equal = JSON.stringify(left) === JSON.stringify(right); return { kind: "boolean", value: operator === "==" ? equal : !equal }; }
  if (left.kind === "boolean" && right.kind === "boolean" && ["&&", "||"].includes(operator)) return { kind: "boolean", value: operator === "&&" ? left.value && right.value : left.value || right.value };
  return { kind: "binary", operator, left, right };
}

function lowerPackageFields(
  symbol: PackageSymbol,
  positional: IRValue[],
  named: Record<string, IRValue>,
  lowering: PackageCompileTimeLowering,
) {
  const parameters = symbol.parameters ?? [];
  const names = parameters.map((parameter) => parameter.name);
  if (symbol.lowering !== lowering || symbol.kind !== "function" || symbol.effect !== "pure" || symbol.native !== undefined || symbol.domain !== undefined || symbol.children !== undefined || symbol.openNamed !== undefined || !parameters.length || parameters.some((parameter) => parameter.default !== undefined) || new Set(names).size !== names.length || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ["__proto__", "prototype", "constructor"].includes(name))) {
    throw new Error(`CUT package symbol ${symbol.name} has an invalid ${lowering} compile-time lowering contract.`);
  }
  if (positional.length > parameters.length || Object.keys(named).some((name) => !parameters.some((parameter) => parameter.name === name))) {
    throw new Error(`Checked CUT compile-time function ${symbol.name} contains an unexpected argument.`);
  }
  const entries = parameters.flatMap((parameter, index): Array<[string, IRValue]> => {
    const value = Object.hasOwn(named, parameter.name) ? named[parameter.name] : positional[index];
    if (value === undefined) {
      if (parameter.optional) return [];
      throw new Error(`Checked CUT compile-time function ${symbol.name} is missing ${parameter.name}.`);
    }
    return [[parameter.name, value]];
  });
  return Object.fromEntries(entries) as Record<string, IRValue>;
}

function lowerPackageRecord(symbol: PackageSymbol, positional: IRValue[], named: Record<string, IRValue>): IRValue {
  return { kind: "object", entries: lowerPackageFields(symbol, positional, named, "record") };
}

function lowerImageSequenceAsset(symbol: PackageSymbol, positional: IRValue[], named: Record<string, IRValue>): IRValue {
  if (symbol.name !== "imageSequence" || symbol.returns !== "ImageSequenceAsset"
    || symbol.lowering !== "image-sequence-asset") {
    throw new Error("CUT built-in image-sequence-asset lowering has an invalid public contract.");
  }
  const fields = lowerPackageFields(symbol, positional, named, "image-sequence-asset");
  return {
    kind: "object",
    entries: {
      format: { kind: "string", value: "cut-image-sequence-source" },
      version: { kind: "quantity", dimension: "scalar", magnitude: rational(1), unit: "scalar" },
      ...fields,
    },
  };
}

const timelineEditOperationKinds = Object.freeze({
  editSplit: "split",
  editTrim: "trim",
  editRippleDelete: "ripple-delete",
  editLift: "lift",
  editExtract: "extract",
  editSlip: "slip",
  editSlide: "slide",
  editBoundary: "boundary-adjust",
  editInsert: "insert",
  editOverwrite: "overwrite",
  editTransition: "transition",
} as const);

function lowerTimelineEditOperation(
  symbol: PackageSymbol,
  positional: IRValue[],
  named: Record<string, IRValue>,
): IRValue {
  const kind = timelineEditOperationKinds[symbol.name as keyof typeof timelineEditOperationKinds];
  if (!kind) throw new Error(`CUT package symbol ${symbol.name} is not a canonical TimelineEdit operation.`);
  return {
    kind: "object",
    entries: {
      kind: { kind: "string", value: kind },
      ...lowerPackageFields(symbol, positional, named, "timeline-edit-operation"),
    },
  };
}

/** Canonicalize the public positional/named spellings into one versioned,
 * closed IR call. Unlike generic record lowering, the operation discriminator
 * survives into executable identity and cannot be forged by an untagged
 * object that happens to contain similarly named fields. */
function lowerAnchoredSpatialCall(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  positional: IRValue[],
  named: Record<string, IRValue>,
  context: LowerContext,
): IRValue {
  const visualSymbols = builtinPackages.get("cut:visual")?.symbols;
  const op = cutAnchoredSpatialOps[symbol.name as keyof typeof cutAnchoredSpatialOps];
  if (!visualSymbols || visualSymbols[symbol.name] !== symbol || symbol.lowering !== "anchored-spatial-call" || !op) {
    throw new Error(`CUT package symbol ${symbol.name} is not a canonical anchored spatial call lowering.`);
  }
  const fields = lowerPackageFields(symbol, positional, named, "anchored-spatial-call");
  if (symbol.name === "visualAnchor" && fields.owner?.kind !== "node-ref") {
    userModuleCompileError(
      context,
      expression.named.find((item) => item.name === "owner")?.value.span ?? expression.positional[0]?.span ?? expression.span,
      "CUT_ANCHORED_PATH_OWNER",
      "visualAnchor owner must lower to a visual node bound earlier in the same lexical production scope.",
    );
  }
  const vec2 = (value: IRValue | undefined, label: string) => {
    if (value?.kind !== "object" || Object.keys(value.entries).length !== 2) {
      userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_TYPE", `${label} must lower to an exact closed Vec2.`);
    }
    const result = {} as { x: Rational; y: Rational };
    for (const axis of ["x", "y"] as const) {
      const coordinate = value.entries[axis];
      if (coordinate?.kind !== "quantity" || coordinate.dimension !== "length" || coordinate.unit !== "px") {
        userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_TYPE", `${label}.${axis} must lower to one exact pixel Length.`);
      }
      if (compareRational(coordinate.magnitude, rational(-cutAnchoredPathLimits.maximumAbsoluteCoordinatePx)) < 0
        || compareRational(coordinate.magnitude, rational(cutAnchoredPathLimits.maximumAbsoluteCoordinatePx)) > 0) {
        userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_LIMIT", `${label}.${axis} cannot exceed ±${cutAnchoredPathLimits.maximumAbsoluteCoordinatePx}px.`);
      }
      result[axis] = coordinate.magnitude;
    }
    return result;
  };
  const vec2Value = (point: { x: Rational; y: Rational }): IRValue => ({
    kind: "object",
    entries: {
      x: { kind: "quantity", dimension: "length", magnitude: point.x, unit: "px" },
      y: { kind: "quantity", dimension: "length", magnitude: point.y, unit: "px" },
    },
  });
  if (symbol.name === "visualAnchor") vec2(fields.local, "visualAnchor local");
  if (symbol.name === "compositionOffset") {
    let point = fields.point;
    let offset = vec2(fields.by, "compositionOffset by");
    if (point?.kind === "call" && point.op === cutAnchoredSpatialOps.compositionOffset
      && point.positional.length === 0 && point.effect === "pure") {
      const nested = vec2(point.named.by, "nested compositionOffset by");
      offset = { x: addRational(nested.x, offset.x), y: addRational(nested.y, offset.y) };
      point = point.named.point;
    }
    for (const axis of ["x", "y"] as const) {
      if (compareRational(offset[axis], rational(-cutAnchoredPathLimits.maximumAbsoluteCoordinatePx)) < 0
        || compareRational(offset[axis], rational(cutAnchoredPathLimits.maximumAbsoluteCoordinatePx)) > 0) {
        userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_LIMIT", `compositionOffset net ${axis} cannot exceed ±${cutAnchoredPathLimits.maximumAbsoluteCoordinatePx}px.`);
      }
    }
    if (compareRational(offset.x, zeroRational) === 0 && compareRational(offset.y, zeroRational) === 0) {
      userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_NOOP", "compositionOffset has zero net displacement; use its base point directly.");
    }
    fields.point = point;
    fields.by = vec2Value(offset);
  }
  if (symbol.name === "anchoredPath") {
    const segments = fields.segments;
    if (segments?.kind !== "array" || segments.items.length < 1 || segments.items.length > cutAnchoredPathLimits.maximumSegments) {
      userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_GEOMETRY", `anchoredPath requires 1 through ${cutAnchoredPathLimits.maximumSegments} segments.`);
    }
    const containsAnchor = (value: IRValue): boolean => value.kind === "call"
      ? value.op === cutAnchoredSpatialOps.visualAnchor
        || value.positional.some(containsAnchor)
        || Object.values(value.named).some(containsAnchor)
      : value.kind === "array" ? value.items.some(containsAnchor)
        : value.kind === "object" ? Object.values(value.entries).some(containsAnchor)
          : false;
    if (!containsAnchor(fields.start!) && !segments.items.some(containsAnchor)) {
      userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_OWNER", "anchoredPath must contain at least one visualAnchor; use vectorPath for entirely static composition points.");
    }
    const startIdentity = stableJsonStringify(fields.start), closed = fields.closed;
    let currentIdentity = startIdentity;
    for (const [index, segment] of segments.items.entries()) {
      if (segment.kind !== "call") userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_TYPE", `anchoredPath segment ${index} must be anchoredLineTo or anchoredCubicTo.`);
      if (segment.op === cutAnchoredSpatialOps.anchoredLineTo) {
        const toIdentity = stableJsonStringify(segment.named.to);
        if (toIdentity === currentIdentity) userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_NOOP", `anchoredPath line segment ${index} has a determinable zero length.`);
        currentIdentity = toIdentity;
      } else if (segment.op === cutAnchoredSpatialOps.anchoredCubicTo) {
        const control1Identity = stableJsonStringify(segment.named.control1), control2Identity = stableJsonStringify(segment.named.control2), toIdentity = stableJsonStringify(segment.named.to);
        if (control1Identity === currentIdentity && control2Identity === currentIdentity && toIdentity === currentIdentity) {
          userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_NOOP", `anchoredPath cubic segment ${index} has a determinable zero length.`);
        }
        currentIdentity = toIdentity;
      } else userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_TYPE", `anchoredPath segment ${index} has an unknown versioned operation.`);
    }
    if (closed?.kind !== "boolean") userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_TYPE", "anchoredPath closed must lower to a Boolean.");
    if (closed.value && currentIdentity === startIdentity) {
      userModuleCompileError(context, expression.span, "CUT_ANCHORED_PATH_NOOP", "closed anchoredPath must omit a terminal endpoint equal to its start; closure already supplies that edge.");
    }
  }
  return { kind: "call", op, positional: [], named: fields, effect: "pure" };
}

function userModuleCompileError(context: LowerContext, span: SourceSpan, code: string, message: string): never {
  context.check.diagnostics.push({ severity: "error", code, message, span, module: context.moduleName });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function validateClosedPackageArguments(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol | undefined,
  positional: readonly IRValue[],
  named: Readonly<Record<string, IRValue>>,
  context: LowerContext,
) {
  if (!symbol) return;
  const schema = symbol.native ? referenceKernelSchema(symbol.native) : undefined;
  for (const [index, parameter] of (symbol.parameters ?? []).entries()) {
    const kernelValues = schema?.support === "supported" ? kernelStringInputValues(schema, parameter.name) : undefined;
    const constraints = [kernelValues, parameter.values].filter((values): values is readonly string[] => values !== undefined);
    if (!constraints.length) continue;
    const namedExpression = expression.named.find((argument) => argument.name === parameter.name)?.value;
    const positionalExpression = expression.positional[index];
    const authored = namedExpression ?? positionalExpression;
    if (!authored) continue;
    const value = namedExpression ? named[parameter.name] : positional[index];
    const rejected = constraints.find((values) => value?.kind !== "string" || !values.includes(value.value));
    if (!rejected) continue;
    context.check.diagnostics.push({
      severity: "error",
      code: "CUT2068",
      message: `Argument “${parameter.name}” for ${symbol.name} must reduce to one of: ${rejected.join(", ")}.`,
      span: authored.span,
      ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
    });
    throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
  }
  if (symbol.native === "cut.visual.captions" || symbol.native === "cut.visual.transcript_captions") {
    const authored = callParameterExpression(expression, symbol, "size");
    if (!authored) return;
    const index = (symbol.parameters ?? []).findIndex((parameter) => parameter.name === "size");
    const value = expression.named.some((argument) => argument.name === "size")
      ? named.size
      : index < 0 ? undefined : positional[index];
    const size = value?.kind === "quantity" && value.dimension === "length" && value.unit === "px"
      ? value.magnitude
      : undefined;
    if (size === undefined
      || compareRational(size, rational(cutCaptionAppearanceLimits.minimumSizePx)) < 0
      || compareRational(size, rational(cutCaptionAppearanceLimits.maximumSizePx)) > 0) {
      context.check.diagnostics.push({
        severity: "error",
        code: "CUT_CAPTION_VALUE_RANGE",
        message: `${symbol.name} size must resolve to a pixel Length from ${cutCaptionAppearanceLimits.minimumSizePx}px through ${cutCaptionAppearanceLimits.maximumSizePx}px; CUT never clamps caption typography at render time.`,
        span: authored.span,
        ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
      });
      throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
    }
  }
}

const cutDataLoweringContracts = {
  "data-bar-layout": {
    name: "barLayout",
    returns: "BarLayout",
    parameters: [
      ["data", "List<KeyedNumber>"], ["x", "Length"], ["y", "Length"], ["width", "Length"], ["height", "Length"],
      ["min", "Number"], ["max", "Number"], ["gap", "Ratio"], ["padding", "Length"],
    ],
  },
  "data-bar-targets": {
    name: "barTargets",
    returns: "List<BarMarkTransform>",
    parameters: [["layout", "BarLayout"], ["targets", "List<MarkTarget>"]],
  },
  "data-format-number": {
    name: "formatNumber",
    returns: "String",
    parameters: [["value", "Number"], ["decimals", "Number"], ["suffix", "String"]],
  },
} as const;

type CutDataLowering = keyof typeof cutDataLoweringContracts;

function assertCutDataLoweringSymbol(symbol: PackageSymbol, lowering: CutDataLowering) {
  const contract = cutDataLoweringContracts[lowering], parameters = symbol.parameters ?? [];
  if (symbol.lowering !== lowering
    || symbol.name !== contract.name
    || symbol.returns !== contract.returns
    || parameters.length !== contract.parameters.length
    || parameters.some((parameter, index) => parameter.name !== contract.parameters[index][0]
      || parameter.type !== contract.parameters[index][1]
      || parameter.optional
      || parameter.default !== undefined)) {
    throw new Error(`CUT built-in ${lowering} lowering has an invalid public signature.`);
  }
}

function callParameterExpression(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  name: string,
) {
  const named = expression.named.find((argument) => argument.name === name)?.value;
  if (named) return named;
  const index = (symbol.parameters ?? []).findIndex((parameter) => parameter.name === name);
  return index < 0 ? undefined : expression.positional[index];
}

function calledPackageSymbol(expression: Extract<Expression, { kind: "call" }>, context: LowerContext) {
  const name = calleeName(expression.callee);
  return name ? context.check.imports.get(name)?.symbol ?? context.check.symbols.get(name)?.packageSymbol : undefined;
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "group") current = current.value;
  return current;
}

function dataLayoutDiagnosticSpan(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  path: string,
  context: LowerContext,
) {
  const segments: Array<string | number> = [];
  const pattern = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/gu;
  for (const match of path.slice(1).matchAll(pattern)) segments.push(match[1] ?? Number(match[2]));
  const first = segments.shift();
  if (typeof first !== "string") return expression.span;
  let current = callParameterExpression(expression, symbol, first);
  if (!current) return expression.span;
  let best = current;
  for (const segment of segments) {
    const unwrapped = unwrapExpression(current);
    let next: Expression | undefined;
    if (typeof segment === "number" && unwrapped.kind === "array") next = unwrapped.items[segment];
    else if (typeof segment === "string" && unwrapped.kind === "object") next = unwrapped.entries.find((entry) => entry.key === segment)?.value;
    else if (typeof segment === "string" && unwrapped.kind === "call") {
      const nested = calledPackageSymbol(unwrapped, context);
      if (nested) next = callParameterExpression(unwrapped, nested, segment);
    }
    if (!next) break;
    current = next;
    best = next;
  }
  return best.span;
}

function dataLayoutCompileError(
  context: LowerContext,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  error: CutDataLayoutError,
): never {
  const prefix = `${error.code}: `;
  const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  context.check.diagnostics.push({
    severity: "error",
    code: error.code,
    message,
    span: dataLayoutDiagnosticSpan(expression, symbol, error.path, context),
    ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
  });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function withCutDataDiagnostic(
  context: LowerContext,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  operation: () => IRValue,
) {
  try { return operation(); }
  catch (error) {
    if (error instanceof CutDataLayoutError) dataLayoutCompileError(context, expression, symbol, error);
    throw error;
  }
}

function lowerCutDataCompileTime(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  positional: IRValue[],
  named: Record<string, IRValue>,
  context: LowerContext,
) {
  const lowering = symbol.lowering;
  if (lowering !== "data-bar-layout" && lowering !== "data-bar-targets" && lowering !== "data-format-number") {
    throw new Error(`CUT package symbol ${symbol.name} is not a data compile-time lowering.`);
  }
  assertCutDataLoweringSymbol(symbol, lowering);
  const fields = lowerPackageFields(symbol, positional, named, lowering);
  return withCutDataDiagnostic(context, expression, symbol, () => {
    if (lowering === "data-bar-layout") return deriveCutBarLayout({ kind: "object", entries: fields });
    if (lowering === "data-bar-targets") return joinCutBarLayoutTargets(fields.layout, fields.targets);
    return formatCutNumber(fields.value, fields.decimals, fields.suffix);
  });
}

function dataQueryString(value: IRValue | undefined, name: string) {
  if (value?.kind !== "string") throw new Error(`Checked CUT data-query helper requires literal String field ${name}.`);
  return value;
}

function dataQueryObject(entries: Record<string, IRValue>): IRValue {
  return { kind: "object", entries };
}

function dataQueryLiteral(value: string): IRValue { return { kind: "string", value }; }

function dataQueryCompileError(
  context: LowerContext,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  error: CutTableQueryError,
): never {
  const prefix = `${error.code}: `;
  const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  context.check.diagnostics.push({
    severity: "error",
    code: error.code,
    message,
    span: dataLayoutDiagnosticSpan(expression, symbol, error.path, context),
    ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
  });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function lowerCutDataQueryRecord(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  positional: IRValue[],
  named: Record<string, IRValue>,
  context: LowerContext,
) {
  const dataSymbols = builtinPackages.get("@cut/data")?.symbols;
  if (!dataSymbols || dataSymbols[symbol.name] !== symbol || (symbol.lowering !== "data-query-record" && symbol.lowering !== "data-query-plan")) {
    throw new Error(`CUT package symbol ${symbol.name} is not a canonical @cut/data query lowering.`);
  }
  const fields = lowerPackageFields(symbol, positional, named, symbol.lowering);
  const object = (entries: Record<string, IRValue>) => dataQueryObject(entries);
  const tagged = (tag: string, entries = fields) => object({ op: dataQueryLiteral(tag), ...entries });
  let lowered: IRValue;
  switch (symbol.name) {
    case "tableField": {
      const kind = dataQueryString(fields.type, "type");
      const typeEntries: Record<string, IRValue> = { kind };
      if (fields.maxBytes !== undefined) typeEntries.maxBytes = fields.maxBytes;
      lowered = object({ name: fields.name, type: object(typeEntries) });
      break;
    }
    case "tableSchema": lowered = object(fields); break;
    case "tableSource": {
      if (fields.source?.kind !== "resource-ref") throw new Error("Checked tableSource source is not a DataAsset resource reference.");
      lowered = object({ name: fields.name, resourceId: dataQueryLiteral(fields.source.id), schema: fields.schema });
      break;
    }
    case "tableCompare": lowered = tagged("compare", { field: fields.field, operator: fields.operator, value: fields.value }); break;
    case "tableLogic": lowered = tagged(dataQueryString(fields.op, "op").value, { items: fields.items }); break;
    case "tableNot": lowered = tagged("not"); break;
    case "tableFilter": lowered = tagged("filter"); break;
    case "tableJoinKey": lowered = object(fields); break;
    case "tableSelect": lowered = object(fields); break;
    case "tableJoin": lowered = tagged("inner-join"); break;
    case "tableGroupKey": lowered = object(fields); break;
    case "tableGroup": lowered = tagged("group"); break;
    case "tableAggregateValue": {
      const aggregate: Record<string, IRValue> = { as: fields.as, function: fields.method };
      if (fields.field !== undefined) aggregate.field = fields.field;
      lowered = object(aggregate);
      break;
    }
    case "tableAggregate": lowered = tagged("aggregate"); break;
    case "tableSortKey": lowered = object(fields); break;
    case "tableSort": lowered = tagged("sort"); break;
    case "tableSeriesValue": lowered = object(fields); break;
    case "tableSeries": lowered = tagged("series"); break;
    case "tableQuery": lowered = object({ format: dataQueryLiteral("cut-query-plan"), version: { kind: "quantity", dimension: "scalar", magnitude: rational(1), unit: "scalar" }, ...fields }); break;
    case "dataLinearScale": lowered = object({
      kind: dataQueryLiteral("linear"),
      domain: object({ min: fields.min, max: fields.max }),
      ticks: object({ count: fields.ticks, format: object({ kind: dataQueryLiteral("decimal"), fractionDigits: fields.decimals, trimTrailingZeros: fields.trimTrailingZeros }) }),
    }); break;
    case "dataLogScale": lowered = object({
      kind: dataQueryLiteral("log"),
      domain: object({ min: fields.min, max: fields.max }),
      ticks: object({ format: object({ kind: dataQueryLiteral("decimal"), fractionDigits: fields.decimals, trimTrailingZeros: fields.trimTrailingZeros }) }),
    }); break;
    case "dataCategoricalScale": lowered = object({ kind: dataQueryLiteral("categorical"), order: fields.order }); break;
    case "dataDateScale": lowered = object({
      kind: dataQueryLiteral("date"),
      domain: object({ min: fields.min, max: fields.max }),
      ticks: object({ interval: fields.interval, step: fields.step, format: fields.format }),
    }); break;
    case "chartSeries": lowered = object(fields); break;
    case "chartFrame": lowered = object(fields); break;
    default: throw new Error(`Canonical @cut/data query lowering ${symbol.name} has no implementation.`);
  }
  if (symbol.lowering !== "data-query-plan") return lowered;
  try {
    cutTableQueryPlanFromIr(lowered);
    return lowered;
  } catch (error) {
    if (error instanceof CutTableQueryError) dataQueryCompileError(context, expression, symbol, error);
    throw error;
  }
}

function assertCutResponsiveStackLoweringSymbol(symbol: PackageSymbol) {
  const parameters = symbol.parameters ?? [];
  if (symbol.lowering !== "responsive-stack-plan"
    || symbol.name !== "responsiveStackPlan"
    || symbol.returns !== "ResponsiveStackPlan"
    || parameters.length !== 4
    || parameters.some((parameter, index) => parameter.name !== ["weights", "safeX", "safeY", "gap"][index]
      || parameter.optional
      || parameter.default !== undefined)) {
    throw new Error("CUT built-in responsive-stack-plan lowering has an invalid public signature.");
  }
}

function responsiveStackCompileError(
  context: LowerContext,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  error: CutResponsiveStackError,
): never {
  const prefix = `${error.code}: `;
  const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  context.check.diagnostics.push({
    severity: "error",
    code: error.code,
    message,
    span: dataLayoutDiagnosticSpan(expression, symbol, error.path, context),
    ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
  });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function lowerCutResponsiveStackPlan(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  positional: IRValue[],
  named: Record<string, IRValue>,
  context: LowerContext,
) {
  assertCutResponsiveStackLoweringSymbol(symbol);
  if (context.timeline.id === "module") {
    responsiveStackCompileError(
      context,
      expression,
      symbol,
      new CutResponsiveStackError(
        "CUT_RESPONSIVE_STACK_CONTEXT",
        "$",
        "responsiveStackPlan is context-bound and must be evaluated inside a timeline, scene, or invoked component; a top-level const has no active composition",
      ),
    );
  }
  const fields = lowerPackageFields(symbol, positional, named, "responsive-stack-plan");
  try {
    return deriveCutResponsiveStackPlan({ kind: "object", entries: fields }, context.timeline);
  } catch (error) {
    if (error instanceof CutResponsiveStackError) responsiveStackCompileError(context, expression, symbol, error);
    throw error;
  }
}

function annotationCompileError(context: LowerContext, span: SourceSpan, code: string, message: string): never {
  context.check.diagnostics.push({ severity: "error", code, message, span, module: context.moduleName });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function linkedTrimCompileError(context: LowerContext, span: SourceSpan, code: LinkedTrimDiagnosticCode, message: string): never {
  context.check.diagnostics.push({ severity: "error", code, message, span, module: context.moduleName });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function linkedRippleDeleteCompileError(context: LowerContext, span: SourceSpan, code: LinkedRippleDeleteDiagnosticCode, message: string): never {
  context.check.diagnostics.push({ severity: "error", code, message, span, module: context.moduleName });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function linkedEditCompileError(context: LowerContext, span: SourceSpan, code: LinkedEditDiagnosticCode, message: string): never {
  if (code.startsWith("CUT_LINKED_RIPPLE_")) return linkedRippleDeleteCompileError(context, span, code as LinkedRippleDeleteDiagnosticCode, message);
  return linkedTrimCompileError(context, span, code as LinkedTrimDiagnosticCode, message);
}

function annotationInfoValue(annotation: IRTimelineMarker | IRTimelineRegion): IRValue {
  const metadata: Record<string, IRValue> = {
    id: { kind: "string", value: annotation.id },
    name: { kind: "string", value: annotation.name },
    color: { kind: "color", value: annotation.color },
    role: { kind: "string", value: annotation.role },
    comment: { kind: "string", value: annotation.comment },
    grid: { kind: "string", value: annotation.grid },
  };
  if (annotation.kind === "marker") metadata.at = { kind: "quantity", dimension: "time", magnitude: annotation.at, unit: "s" };
  else metadata.range = {
    kind: "range",
    start: { kind: "quantity", dimension: "time", magnitude: annotation.range.start, unit: "s" },
    end: { kind: "quantity", dimension: "time", magnitude: addRational(annotation.range.start, annotation.range.duration), unit: "s" },
    exclusive: true,
  };
  return { kind: "object", entries: metadata };
}

function resolveAnnotationInfo(
  kind: "marker" | "region",
  idValue: IRValue | undefined,
  context: LowerContext,
  span: SourceSpan,
) {
  const id = idValue && literalString(idValue);
  if (!id) annotationCompileError(context, span, "CUT_ANNOTATION_REFERENCE", `${kind}() requires a compile-time String id.`);
  const annotation = kind === "marker"
    ? context.ir.annotations?.markers.find((item) => item.id === id)
    : context.ir.annotations?.regions.find((item) => item.id === id);
  if (!annotation) annotationCompileError(context, span, "CUT_ANNOTATION_REFERENCE", `No ${kind} “${id}” has been authored before this use.`);
  return annotationInfoValue(annotation);
}

function checkedUserFunction(name: string, context: LowerContext): UserModuleRuntimeExport | undefined {
  const local = context.check.symbols.get(name)?.declaration;
  if (local?.kind === "function") return {
    kind: "function",
    declaration: local,
    check: context.check,
    moduleName: context.moduleName,
    environment: context.moduleEnvironment,
  };
  const imported = context.check.userImports.get(name);
  if (imported?.symbol.kind !== "function") return undefined;
  return context.userModules?.modules.get(imported.specifier)?.exports.get(imported.imported);
}

function lowerUserFunction(
  definition: UserModuleRuntimeExport,
  expression: Extract<Expression, { kind: "call" }>,
  context: LowerContext,
): IRValue {
  const declaration = definition.declaration;
  if (!declaration || declaration.kind !== "function") throw new Error("Checked CUT user function lost its implementation.");
  context.budget.functionCalls += 1;
  if (context.budget.functionCalls > context.budget.limits.maxFunctionCalls) {
    userModuleCompileError(context, expression.span, "CUT_MODULE_FUNCTION_LIMIT", `Pure function calls exceed maxFunctionCalls=${context.budget.limits.maxFunctionCalls}.`);
  }
  if (context.functionExpansion.length >= context.budget.limits.maxExpansionDepth) {
    userModuleCompileError(context, expression.span, "CUT_MODULE_FUNCTION_LIMIT", `Pure function expansion exceeds maxExpansionDepth=${context.budget.limits.maxExpansionDepth}.`);
  }
  const environment = cloneEnvironment(definition.environment);
  const positional = expression.positional.map((item) => lowerExpression(item, context));
  for (const [index, parameter] of declaration.parameters.entries()) {
    const named = expression.named.find((item) => item.name === parameter.name);
    let value = named ? lowerExpression(named.value, context) : positional[index];
    if (value === undefined && parameter.defaultValue) {
      const defaultContext: LowerContext = {
        ...context,
        check: definition.check,
        moduleName: definition.moduleName,
        environment,
        moduleEnvironment: definition.environment,
      };
      value = lowerExpression(parameter.defaultValue, defaultContext);
    }
    if (value === undefined) userModuleCompileError(context, expression.span, "CUT_MODULE_FUNCTION_ARGUMENT", `Checked function ${declaration.name} is missing parameter ${parameter.name}.`);
    environment.set(parameter.name, value);
  }
  const expansion = [...context.functionExpansion, { module: definition.moduleName, span: declaration.span, symbol: declaration.name }];
  return lowerExpression(declaration.value, {
    ...context,
    check: definition.check,
    moduleName: definition.moduleName,
    environment,
    moduleEnvironment: definition.environment,
    bindings: new Map(),
    functionExpansion: expansion,
  });
}

function transcriptCompileError(
  context: LowerContext,
  span: SourceSpan,
  code: string,
  message: string,
): never {
  context.check.diagnostics.push({
    severity: "error",
    code,
    message,
    span,
    ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
  });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function transcriptArgumentSpan(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  name: string,
) {
  return callParameterExpression(expression, symbol, name)?.span ?? expression.span;
}

function transcriptWholeNumber(
  value: IRValue | undefined,
  context: LowerContext,
  span: SourceSpan,
  label: string,
) {
  const amount = valueRational(value, "scalar");
  if (!amount
    || amount.denominator !== "1"
    || compareRational(amount, zeroRational) < 0
    || BigInt(amount.numerator)
      > BigInt(cutTranscriptMediaAuthorityContract.maximumStreamIndex)) {
    transcriptCompileError(
      context,
      span,
      "CUT_TRANSCRIPT_MEDIA",
      `${label} must reduce to one non-negative whole stream index no larger than ${cutTranscriptMediaAuthorityContract.maximumStreamIndex}.`,
    );
  }
  return Number(amount.numerator);
}

function lowerTranscriptMediaAuthority(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  context: LowerContext,
): IRValue {
  if (symbol.lowering !== "transcript-media-authority"
    || symbol.name !== "transcriptMedia") {
    throw new Error("Invalid transcript-media-authority lowering symbol.");
  }
  if (!context.scene
    || !context.directSceneStatementBlock
    || context.directTimelineStatementBlock
    || context.directSceneLetInitializer !== expression) {
    transcriptCompileError(
      context,
      expression.span,
      "CUT_TRANSCRIPT_SCOPE",
      "transcriptMedia must be the direct initializer of a let binding in one declared scene.",
    );
  }
  const inputs = callArguments(expression, symbol, context);
  const transcript = inputs.transcript;
  const audio = inputs.audio;
  const video = inputs.video;
  if (transcript?.kind !== "resource-ref"
    || context.ir.resources[transcript.id]?.kind !== "data") {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "transcript"),
      "CUT_TRANSCRIPT_RESOURCE",
      "transcriptMedia transcript must resolve to one declared DataAsset.",
    );
  }
  if (audio?.kind !== "resource-ref"
    || context.ir.resources[audio.id]?.kind !== "audio") {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "audio"),
      "CUT_TRANSCRIPT_RESOURCE",
      "transcriptMedia audio must resolve to one declared AudioAsset.",
    );
  }
  if (video?.kind !== "resource-ref"
    || context.ir.resources[video.id]?.kind !== "video") {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "video"),
      "CUT_TRANSCRIPT_RESOURCE",
      "transcriptMedia video must resolve to one declared VideoAsset.",
    );
  }
  const audioStreamIndex = transcriptWholeNumber(
    inputs.audioStream,
    context,
    transcriptArgumentSpan(expression, symbol, "audioStream"),
    "transcriptMedia audioStream",
  );
  const videoStreamIndex = transcriptWholeNumber(
    inputs.videoStream,
    context,
    transcriptArgumentSpan(expression, symbol, "videoStream"),
    "transcriptMedia videoStream",
  );
  const audioResource = context.ir.resources[audio.id]!;
  const videoResource = context.ir.resources[video.id]!;
  if (audioResource.streamSelection?.audio !== audioStreamIndex) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "audioStream"),
      "CUT_TRANSCRIPT_MEDIA",
      `transcriptMedia requires AudioAsset ${audio.id} to explicitly select audioStream ${audioStreamIndex}.`,
    );
  }
  if (videoResource.streamSelection?.video !== videoStreamIndex) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "videoStream"),
      "CUT_TRANSCRIPT_MEDIA",
      `transcriptMedia requires VideoAsset ${video.id} to explicitly select videoStream ${videoStreamIndex}.`,
    );
  }
  const videoFrameRate = valueRational(inputs.videoFrameRate, "scalar");
  const videoDuration = valueRational(inputs.videoDuration, "time");
  const audioAt = valueRational(inputs.audioAt, "time");
  const videoAt = valueRational(inputs.videoAt, "time");
  const videoRate = valueRational(inputs.videoRate, "scalar");
  if (!videoFrameRate || compareRational(videoFrameRate, zeroRational) <= 0) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "videoFrameRate"),
      "CUT_TRANSCRIPT_MEDIA",
      "transcriptMedia videoFrameRate must be a positive exact Number.",
    );
  }
  if (!videoDuration || compareRational(videoDuration, zeroRational) <= 0) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "videoDuration"),
      "CUT_TRANSCRIPT_MEDIA",
      "transcriptMedia videoDuration must be a positive exact Time.",
    );
  }
  if (!audioAt || compareRational(audioAt, zeroRational) < 0) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "audioAt"),
      "CUT_TRANSCRIPT_MEDIA",
      "transcriptMedia audioAt must be a non-negative exact Time.",
    );
  }
  if (!videoAt || compareRational(videoAt, zeroRational) < 0) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "videoAt"),
      "CUT_TRANSCRIPT_MEDIA",
      "transcriptMedia videoAt must be a non-negative exact Time.",
    );
  }
  if (!videoRate
    || compareRational(videoRate, rational(1, 64)) < 0
    || compareRational(videoRate, rational(64)) > 0) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "videoRate"),
      "CUT_TRANSCRIPT_MEDIA",
      "transcriptMedia videoRate must be an exact positive Number from 1/64 through 64.",
    );
  }
  if (multiplyRational(videoAt, videoFrameRate).denominator !== "1") {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "videoAt"),
      "CUT_TRANSCRIPT_MEDIA",
      `transcriptMedia videoAt must land exactly on the declared ${videoFrameRate.numerator}/${videoFrameRate.denominator} fps video grid.`,
    );
  }
  if (compareRational(videoAt, videoDuration) >= 0) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "videoAt"),
      "CUT_TRANSCRIPT_MEDIA",
      "transcriptMedia videoAt must be strictly earlier than videoDuration.",
    );
  }
  const semantic = {
    version: 1 as const,
    kind: "transcript-media-authority" as const,
    compositionId: context.timeline.id,
    sceneId: context.scene.id,
    transcriptResourceId: transcript.id,
    audioResourceId: audio.id,
    audioStreamIndex,
    videoResourceId: video.id,
    videoStreamIndex,
    videoFrameRate,
    videoDuration,
    audioAt,
    videoAt,
    videoRate,
  };
  const id = semanticId(context, "transcript_media_authority", semantic);
  const authority: IRTranscriptMediaAuthorityV1 = {
    id,
    ...semantic,
    identity: cutTranscriptMediaAuthorityIdentity(semantic),
    provenance: provenance(
      context.moduleName,
      expression.span,
      "transcriptMedia",
      context.expansion,
    ),
  };
  (context.ir.transcriptMediaAuthorities ??= []).push(authority);
  return {
    kind: "object",
    entries: {
      __transcriptMediaAuthorityId: { kind: "string", value: id },
    },
  };
}

function transcriptMediaAuthorityFromValue(
  value: IRValue | undefined,
  context: LowerContext,
  span: SourceSpan,
) {
  const authorityId = value?.kind === "object"
    && value.entries.__transcriptMediaAuthorityId?.kind === "string"
    ? value.entries.__transcriptMediaAuthorityId.value
    : undefined;
  const authority = authorityId === undefined
    ? undefined
    : context.ir.transcriptMediaAuthorities
      ?.find((candidate) => candidate.id === authorityId);
  if (!authority
    || authority.compositionId !== context.timeline.id
    || authority.sceneId !== context.scene?.id) {
    transcriptCompileError(
      context,
      span,
      "CUT_TRANSCRIPT_BINDING",
      "media must resolve directly to one scene-local transcriptMedia let binding.",
    );
  }
  return authority;
}

function lowerTranscriptEdit(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  context: LowerContext,
): IRValue {
  if (symbol.lowering !== "transcript-edit" || symbol.name !== "transcriptEdit") {
    throw new Error("Invalid transcript-edit lowering symbol.");
  }
  if (!context.scene || !context.directSceneStatementBlock || context.directTimelineStatementBlock) {
    transcriptCompileError(
      context,
      expression.span,
      "CUT_TRANSCRIPT_SCOPE",
      "transcriptEdit must be the direct initializer of a let binding in one declared scene so its destination clock and consumers are unambiguous.",
    );
  }
  const inputs = callArguments(expression, symbol, context);
  const transcriptReference = inputs.transcript;
  const audioReference = inputs.source;
  const mediaAuthority = inputs.media === undefined
    ? undefined
    : transcriptMediaAuthorityFromValue(
      inputs.media,
      context,
      transcriptArgumentSpan(expression, symbol, "media"),
    );
  if (transcriptReference?.kind !== "resource-ref" || context.ir.resources[transcriptReference.id]?.kind !== "data") {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "transcript"),
      "CUT_TRANSCRIPT_RESOURCE",
      "transcriptEdit transcript must resolve to one declared DataAsset.",
    );
  }
  if (audioReference?.kind !== "resource-ref" || context.ir.resources[audioReference.id]?.kind !== "audio") {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "source"),
      "CUT_TRANSCRIPT_RESOURCE",
      "transcriptEdit source must resolve to one declared AudioAsset.",
    );
  }
  const from = inputs.from, through = inputs.through;
  if (from?.kind !== "string" || through?.kind !== "string") {
    transcriptCompileError(
      context,
      from?.kind !== "string"
        ? transcriptArgumentSpan(expression, symbol, "from")
        : transcriptArgumentSpan(expression, symbol, "through"),
      "CUT_TRANSCRIPT_ID",
      "transcriptEdit from and through must reduce to stable transcript word-ID strings.",
    );
  }
  const at = valueRational(inputs.at, "time");
  if (!at) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "at"),
      "CUT_TRANSCRIPT_TIME",
      "transcriptEdit at must reduce to an exact Time in scene-local destination coordinates.",
    );
  }
  let linkId: string | undefined;
  if (inputs.link !== undefined) {
    if (inputs.link.kind !== "string"
      || !inputs.link.value
      || inputs.link.value !== inputs.link.value.trim()
      || Buffer.byteLength(inputs.link.value, "utf8") > 128
      || /[\u0000-\u001f\u007f]/u.test(inputs.link.value)) {
      transcriptCompileError(
        context,
        transcriptArgumentSpan(expression, symbol, "link"),
        "CUT_TRANSCRIPT_ID",
        "transcriptEdit link must be a non-empty trimmed UTF-8 string of at most 128 bytes without control characters.",
      );
    }
    linkId = inputs.link.value;
  }
  const sidecarBytes = context.compileInputs.transcriptSidecars?.get(transcriptReference.id);
  if (sidecarBytes === undefined) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "transcript"),
      "CUT_TRANSCRIPT_RESOURCE",
      `No bounded transcript sidecar bytes were supplied for DataAsset ${transcriptReference.id}.`,
    );
  }
  let transcript;
  let selection;
  try {
    transcript = parseCutTranscript(sidecarBytes);
    selection = selectTranscriptRange(transcript, { from: from.value, through: through.value });
  } catch (error) {
    if (!(error instanceof TranscriptInterchangeError)) throw error;
    const span = error.path === "$.selection.from"
      ? transcriptArgumentSpan(expression, symbol, "from")
      : error.path === "$.selection.through"
        ? transcriptArgumentSpan(expression, symbol, "through")
        : transcriptArgumentSpan(expression, symbol, "transcript");
    transcriptCompileError(context, span, error.code, error.message);
  }
  if (selection.selectedWordCount
    > cutTranscriptExecutableLimits.maximumSelectedWords) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "through"),
      "CUT_TRANSCRIPT_LIMIT",
      `transcriptEdit selects ${selection.selectedWordCount} words; one edit is limited to ${cutTranscriptExecutableLimits.maximumSelectedWords}.`,
    );
  }
  const selectedTextBytes = Buffer.byteLength(selection.text, "utf8");
  if (selectedTextBytes
    > cutTranscriptExecutableLimits.maximumSelectedTextBytes) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "through"),
      "CUT_TRANSCRIPT_LIMIT",
      `transcriptEdit selected text is ${selectedTextBytes} UTF-8 bytes; one executable edit is limited to ${cutTranscriptExecutableLimits.maximumSelectedTextBytes} bytes.`,
    );
  }
  const source = context.ir.resources[audioReference.id]!;
  if (source.streamSelection?.audio !== undefined
    && source.streamSelection.audio !== selection.media.audioStreamIndex) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "source"),
      "CUT_TRANSCRIPT_MEDIA",
      `Transcript media audio stream ${selection.media.audioStreamIndex} does not match AudioAsset ${audioReference.id} stream selector ${source.streamSelection.audio}.`,
    );
  }
  if (mediaAuthority) {
    if (mediaAuthority.transcriptResourceId !== transcriptReference.id
      || mediaAuthority.audioResourceId !== audioReference.id) {
      transcriptCompileError(
        context,
        transcriptArgumentSpan(expression, symbol, "media"),
        "CUT_TRANSCRIPT_MEDIA",
        "transcriptEdit media must bind the exact same transcript and audio resources as this edit.",
      );
    }
    if (mediaAuthority.audioStreamIndex !== selection.media.audioStreamIndex) {
      transcriptCompileError(
        context,
        transcriptArgumentSpan(expression, symbol, "media"),
        "CUT_TRANSCRIPT_MEDIA",
        `transcriptEdit media audio stream ${mediaAuthority.audioStreamIndex} does not match transcript stream ${selection.media.audioStreamIndex}.`,
      );
    }
    if (multiplyRational(
      mediaAuthority.audioAt,
      rational(selection.media.audioSampleRate),
    ).denominator !== "1") {
      transcriptCompileError(
        context,
        transcriptArgumentSpan(expression, symbol, "media"),
        "CUT_TRANSCRIPT_MEDIA",
        `transcriptMedia audioAt must land exactly on the authenticated ${selection.media.audioSampleRate} Hz audio grid.`,
      );
    }
  }
  const destinationEnd = addRational(at, selection.sourceRange.duration);
  if (compareRational(at, zeroRational) < 0 || compareRational(destinationEnd, context.scene.duration) > 0) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "at"),
      "CUT_TRANSCRIPT_TIME",
      "transcriptEdit destination start plus the selected spoken duration must stay inside its owning scene.",
    );
  }
  const absoluteStart = addRational(context.scene.start, at);
  const absoluteEnd = addRational(context.scene.start, destinationEnd);
  exactAudioSample(context, transcriptArgumentSpan(expression, symbol, "at"), absoluteStart, "transcriptEdit destination start");
  exactAudioSample(context, transcriptArgumentSpan(expression, symbol, "at"), absoluteEnd, "transcriptEdit destination end");
  const fromIndex = transcript.words.findIndex((word) => word.id === from.value);
  const throughIndex = transcript.words.findIndex((word) => word.id === through.value);
  if (fromIndex < 0 || throughIndex < fromIndex) throw new Error("Validated transcript selection lost its selected word indexes.");
  const selectedWords = transcript.words.slice(fromIndex, throughIndex + 1).map((word) => ({
    id: word.id,
    start: word.start,
    end: word.end,
    text: word.text,
    join: word.join,
    ...(word.speaker === undefined ? {} : { speaker: word.speaker }),
  }));
  const sourceRange: IREditorialInterval = {
    start: selection.sourceRange.start,
    duration: selection.sourceRange.duration,
  };
  const destinationRange: IREditorialInterval = {
    start: at,
    duration: selection.sourceRange.duration,
  };
  const bindingId = semanticId(context, "transcript_binding", {
    transcriptResourceId: transcriptReference.id,
    audioResourceId: audioReference.id,
    from: from.value,
    through: through.value,
    at,
    ...(linkId === undefined ? {} : { linkId }),
    ...(mediaAuthority === undefined
      ? {}
      : { mediaAuthorityId: mediaAuthority.id }),
  });
  const binding: IRTranscriptBindingV1 = {
    id: bindingId,
    version: 1,
    kind: "transcript-edit",
    compositionId: context.timeline.id,
    sceneId: context.scene.id,
    transcriptResourceId: transcriptReference.id,
    audioResourceId: audioReference.id,
    from: from.value,
    through: through.value,
    selectedWordCount: selection.selectedWordCount,
    selectedIdsSha256: selection.selectedIdsSha256,
    text: selection.text,
    words: selectedWords,
    sourceRange,
    destinationRange,
    ...(linkId === undefined ? {} : { linkId }),
    ...(mediaAuthority === undefined
      ? {}
      : { mediaAuthorityId: mediaAuthority.id }),
    media: selection.media,
    provenance: provenance(context.moduleName, expression.span, "transcriptEdit", context.expansion),
  };
  (context.ir.transcriptBindings ??= []).push(binding);
  const time = (magnitude: Rational): IRValue => ({ kind: "quantity", dimension: "time", magnitude, unit: "s" });
  const range = (interval: IREditorialInterval): IRValue => ({
    kind: "range",
    start: time(interval.start),
    end: time(addRational(interval.start, interval.duration)),
    exclusive: true,
  });
  return {
    kind: "object",
    entries: {
      __transcriptBindingId: { kind: "string", value: bindingId },
      sourceRange: range(sourceRange),
      destinationRange: range(destinationRange),
      duration: time(sourceRange.duration),
      text: { kind: "string", value: selection.text },
    },
  };
}

function lowerExpression(expression: Expression, context: LowerContext): IRValue {
  context.budget.values += 1;
  if (context.budget.values > context.budget.limits.maxValueNodes) {
    userModuleCompileError(context, expression.span, "CUT_MODULE_VALUE_LIMIT", `Compile-time value expansion exceeds maxValueNodes=${context.budget.limits.maxValueNodes}.`);
  }
  if (expression.kind === "number") return quantityValue(expression, context.timeline.fps);
  if (expression.kind === "string") return { kind: "string", value: expression.value };
  if (expression.kind === "boolean") return { kind: "boolean", value: expression.value };
  if (expression.kind === "null") return { kind: "null" };
  if (expression.kind === "color") return { kind: "color", value: expression.value };
  if (expression.kind === "identifier") {
    const imported = context.check.imports.get(expression.name);
    if (imported?.symbol.kind === "value") {
      const package_ = builtinPackages.get(imported.specifier)!;
      return { kind: "symbol", name: `${imported.specifier}@${package_.version}#${imported.imported}` };
    }
    return context.environment.get(expression.name) ?? (context.ir.resources[expression.name] ? { kind: "resource-ref", id: expression.name } : context.ir.compositions.some((item) => item.id === expression.name || item.name === expression.name) ? { kind: "timeline-ref", id: context.ir.compositions.find((item) => item.id === expression.name || item.name === expression.name)!.id } : context.bindings.has(expression.name) ? { kind: "node-ref", id: context.bindings.get(expression.name)!.nodeId } : { kind: "symbol", name: expression.name });
  }
  if (expression.kind === "group") return lowerExpression(expression.value, context);
  if (expression.kind === "array") return { kind: "array", items: expression.items.map((item) => lowerExpression(item, context)) };
  if (expression.kind === "object") return { kind: "object", entries: Object.fromEntries(expression.entries.map((item) => [item.key, lowerExpression(item.value, context)])) };
  if (expression.kind === "range") return { kind: "range", start: lowerExpression(expression.start, context), end: lowerExpression(expression.end, context), exclusive: expression.exclusive };
  if (expression.kind === "member") {
    const object = lowerExpression(expression.object, context);
    if (object.kind === "object" && Object.hasOwn(object.entries, expression.property)) return object.entries[expression.property];
    return { kind: "member", object, property: expression.property };
  }
  if (expression.kind === "index") {
    const object = lowerExpression(expression.object, context), index = lowerExpression(expression.index, context);
    if (object.kind === "array" && index.kind === "quantity" && index.dimension === "scalar" && index.magnitude.denominator === "1") return object.items[Number(index.magnitude.numerator)] ?? { kind: "null" };
    return { kind: "index", object, index };
  }
  if (expression.kind === "unary") {
    const value = lowerExpression(expression.value, context);
    if (expression.operator === "!" && value.kind === "boolean") return { kind: "boolean", value: !value.value };
    if (expression.operator === "-" && value.kind === "quantity") return { ...value, magnitude: multiplyRational(value.magnitude, rational(-1)) };
    return { kind: "unary", operator: expression.operator, value };
  }
  if (expression.kind === "binary") return evaluateBinary(expression.operator, lowerExpression(expression.left, context), lowerExpression(expression.right, context));
  const name = calleeName(expression.callee) ?? "anonymous";
  const userFunction = checkedUserFunction(name, context);
  if (userFunction) return lowerUserFunction(userFunction, expression, context);
  const symbol = context.check.imports.get(name)?.symbol ?? context.check.symbols.get(name)?.packageSymbol;
  if (symbol?.native === "cut.data.amplitude_envelope") {
    userModuleCompileError(
      context,
      expression.span,
      "CUT_AUDIO_REACTIVE_CONTEXT",
      "AmplitudeEnvelope is valid only as the direct initializer of a scene-local let binding.",
    );
  }
  if (["cut.data.map_number", "cut.data.map_ratio", "cut.data.map_length", "cut.data.map_angle"].includes(symbol?.native ?? "")) {
    userModuleCompileError(
      context,
      expression.span,
      "CUT_AUDIO_REACTIVE_CONTEXT",
      `${symbol!.name} is valid only as the direct value of set targeting one supported visual property.`,
    );
  }
  if (symbol?.native === "cut.edit.marker" || symbol?.native === "cut.edit.region") {
    annotationCompileError(
      context,
      expression.span,
      "CUT_ANNOTATION_CONTEXT",
      `${symbol.name} authors ordered editorial metadata and is valid only as a direct timeline or scene statement.`,
    );
  }
  if (symbol?.native === "cut.edit.linked_trim") {
    linkedTrimCompileError(
      context,
      expression.span,
      "CUT_LINKED_TRIM_SCOPE",
      `${symbol.name} authors a linked editorial transaction and is valid only as a direct scene statement.`,
    );
  }
  if (symbol?.native === "cut.edit.linked_ripple_delete") {
    linkedRippleDeleteCompileError(
      context,
      expression.span,
      "CUT_LINKED_RIPPLE_SCOPE",
      `${symbol.name} authors a linked editorial transaction and is valid only as a direct scene statement.`,
    );
  }
  if (symbol?.native === "cut.edit.timeline_edit") {
    timelineEditCompileError(
      context,
      expression.span,
      "CUT_TIMELINE_EDIT_SCOPE",
      `${symbol.name} authors a canonical editorial transaction and is valid only as a direct scene statement.`,
    );
  }
  if (symbol?.native === "cut.edit.match_subject" || symbol?.native === "cut.edit.match_transition") {
    annotationCompileError(
      context,
      expression.span,
      "CUT_MATCH_SCOPE",
      `${symbol.name} is a non-rendering declaration and is valid only as a direct ${symbol.native === "cut.edit.match_subject" ? "scene" : "timeline"} statement.`,
    );
  }
  if (symbol?.lowering === "transcript-edit") {
    return lowerTranscriptEdit(expression, symbol, context);
  }
  if (symbol?.lowering === "transcript-media-authority") {
    return lowerTranscriptMediaAuthority(expression, symbol, context);
  }
  const positional = expression.positional.map((item) => lowerExpression(item, context));
  const named = Object.fromEntries(expression.named.map((item) => [item.name, lowerExpression(item.value, context)]));
  validateClosedPackageArguments(expression, symbol, positional, named, context);
  if (symbol?.lowering === "anchored-spatial-call") {
    return lowerAnchoredSpatialCall(expression, symbol, positional, named, context);
  }
  if (symbol?.lowering === "timeline-edit-operation") {
    return lowerTimelineEditOperation(symbol, positional, named);
  }
  if (symbol?.lowering === "image-sequence-asset") {
    return lowerImageSequenceAsset(symbol, positional, named);
  }
  if (symbol?.lowering === "record") {
    const lowered = lowerPackageRecord(symbol, positional, named);
    const dataSymbols = builtinPackages.get("@cut/data")?.symbols;
    if (symbol === dataSymbols?.keyedNumber) {
      return withCutDataDiagnostic(context, expression, symbol, () => { decodeCutKeyedNumber(lowered); return lowered; });
    }
    if (symbol === dataSymbols?.markTarget) {
      return withCutDataDiagnostic(context, expression, symbol, () => { decodeCutMarkTarget(lowered); return lowered; });
    }
    return lowered;
  }
  if (symbol?.lowering === "data-bar-layout" || symbol?.lowering === "data-bar-targets" || symbol?.lowering === "data-format-number") {
    return lowerCutDataCompileTime(expression, symbol, positional, named, context);
  }
  if (symbol?.lowering === "data-query-record" || symbol?.lowering === "data-query-plan") {
    return lowerCutDataQueryRecord(expression, symbol, positional, named, context);
  }
  if (symbol?.lowering === "responsive-stack-plan") {
    return lowerCutResponsiveStackPlan(expression, symbol, positional, named, context);
  }
  if (symbol?.native === "cut.edit.marker_info") return resolveAnnotationInfo("marker", positional[0] ?? named.id, context, expression.span);
  if (symbol?.native === "cut.edit.region_info") return resolveAnnotationInfo("region", positional[0] ?? named.id, context, expression.span);
  if (symbol?.native === "cut.time.seconds") {
    const value = positional[0] ?? named.value;
    if (value?.kind === "quantity" && value.dimension === "scalar") return { kind: "quantity", dimension: "time", magnitude: value.magnitude, unit: "s" };
  }
  if (symbol?.native === "cut.motion.stagger") {
    const index = positional[0] ?? named.index;
    const each = positional[1] ?? named.each;
    const offset = positional[2] ?? named.offset ?? { kind: "quantity", dimension: "time", magnitude: zeroRational, unit: "s" };
    if (index?.kind !== "quantity" || index.dimension !== "scalar" || index.unit !== "scalar" || index.magnitude.denominator !== "1") {
      userModuleCompileError(context, expression.span, "CUT_MOTION_STAGGER", "stagger index must reduce to an exact non-negative integer Number.");
    }
    const indexNumber = Number(index.magnitude.numerator);
    if (!Number.isSafeInteger(indexNumber) || indexNumber < 0 || indexNumber > 4_095) {
      userModuleCompileError(context, expression.span, "CUT_MOTION_STAGGER", "stagger index must be from 0 through 4095.");
    }
    if (each?.kind !== "quantity" || each.dimension !== "time" || each.unit !== "s" || compareRational(each.magnitude, zeroRational) <= 0) {
      userModuleCompileError(context, expression.span, "CUT_MOTION_STAGGER", "stagger each must reduce to a positive exact Time.");
    }
    if (offset.kind !== "quantity" || offset.dimension !== "time" || offset.unit !== "s" || compareRational(offset.magnitude, zeroRational) < 0) {
      userModuleCompileError(context, expression.span, "CUT_MOTION_STAGGER", "stagger offset must reduce to a non-negative exact Time.");
    }
    return { kind: "quantity", dimension: "time", magnitude: addRational(offset.magnitude, multiplyRational(index.magnitude, each.magnitude)), unit: "s" };
  }
  return { kind: "call", op: symbol?.native ?? name, positional, named, effect: symbol?.effect ?? "pure" };
}

const intrinsicLinear: IRValue = { kind: "symbol", name: "cut:intrinsic#linear" };

function callArguments(expression: Extract<Expression, { kind: "call" }>, symbol: PackageSymbol | undefined, context: LowerContext) {
  const positional = expression.positional.map((item) => lowerExpression(item, context));
  const named = Object.fromEntries(expression.named.map((item) => [item.name, lowerExpression(item.value, context)]));
  validateClosedPackageArguments(expression, symbol, positional, named, context);
  const entries: Record<string, IRValue> = {};
  positional.forEach((item, index) => { entries[symbol?.parameters?.[index]?.name ?? `$${index}`] = item; });
  Object.assign(entries, named);
  return entries;
}

const audioReactiveMapTypes = Object.freeze({
  "cut.data.map_number": "Number",
  "cut.data.map_ratio": "Ratio",
  "cut.data.map_length": "Length",
  "cut.data.map_angle": "Angle",
} as const);

type AudioReactiveMapNative = keyof typeof audioReactiveMapTypes;

function audioReactiveCompileError(context: LowerContext, span: SourceSpan, code: string, message: string): never {
  context.check.diagnostics.push({
    severity: "error",
    code,
    message,
    span,
    ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
  });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function audioReactiveArgumentSpan(expression: Extract<Expression, { kind: "call" }>, symbol: PackageSymbol, name: string) {
  return callParameterExpression(expression, symbol, name)?.span ?? expression.span;
}

function audioReactiveTime(
  value: IRValue | undefined,
  name: string,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  context: LowerContext,
) {
  if (value?.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, name), "CUT_AUDIO_REACTIVE_TYPE", `${symbol.name} ${name} must reduce to one exact Time in seconds.`);
  }
  return value.magnitude;
}

function assertAudioReactiveSampleGrid(
  value: Rational,
  name: string,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  context: LowerContext,
) {
  if (multiplyRational(value, rational(context.timeline.sampleRate)).denominator !== "1") {
    audioReactiveCompileError(
      context,
      audioReactiveArgumentSpan(expression, symbol, name),
      "CUT_AUDIO_REACTIVE_TIME",
      `${symbol.name} ${name} must land exactly on the ${context.timeline.sampleRate} Hz composition sample grid.`,
    );
  }
}

function lowerAudioAmplitudeEnvelope(
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  context: LowerContext,
): IRValue {
  if (symbol.native !== "cut.data.amplitude_envelope") throw new Error("Invalid audio-reactive envelope symbol.");
  if (!context.scene || !context.directSceneStatementBlock) {
    audioReactiveCompileError(
      context,
      expression.span,
      "CUT_AUDIO_REACTIVE_SCOPE",
      "AmplitudeEnvelope must be a direct let binding in one declared scene so its composition sample clock and scene-local placement are unambiguous.",
    );
  }
  const inputs = callArguments(expression, symbol, context);
  const source = inputs.source;
  if (source?.kind !== "resource-ref" || context.ir.resources[source.id]?.kind !== "audio") {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "source"), "CUT_AUDIO_REACTIVE_RESOURCE", "AmplitudeEnvelope source must resolve to one declared AudioAsset resource.");
  }
  const range = inputs.range;
  if (range?.kind !== "range" || !range.exclusive) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "range"), "CUT_AUDIO_REACTIVE_RANGE", "AmplitudeEnvelope range must be one explicit half-open Time range written with ..<.");
  }
  const rangeStart = audioReactiveTime(range.start, "range", expression, symbol, context);
  const rangeEnd = audioReactiveTime(range.end, "range", expression, symbol, context);
  if (compareRational(rangeStart, zeroRational) < 0 || compareRational(rangeEnd, rangeStart) <= 0) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "range"), "CUT_AUDIO_REACTIVE_RANGE", "AmplitudeEnvelope range must have a non-negative start and a strictly later exclusive end.");
  }
  const at = audioReactiveTime(inputs.at, "at", expression, symbol, context);
  const window = audioReactiveTime(inputs.window, "window", expression, symbol, context);
  const hop = audioReactiveTime(inputs.hop, "hop", expression, symbol, context);
  const attack = audioReactiveTime(inputs.attack, "attack", expression, symbol, context);
  const release = audioReactiveTime(inputs.release, "release", expression, symbol, context);
  for (const [name, value] of Object.entries({ rangeStart, rangeEnd, at, window, hop, attack, release }) as Array<[string, Rational]>) {
    assertAudioReactiveSampleGrid(value, name.startsWith("range") ? "range" : name, expression, symbol, context);
  }
  const selectionDuration = subtractRational(rangeEnd, rangeStart);
  if (compareRational(at, zeroRational) < 0 || compareRational(addRational(at, selectionDuration), context.scene.duration) > 0) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "at"), "CUT_AUDIO_REACTIVE_TIME", "AmplitudeEnvelope scene-local at plus the selected source duration must stay inside its owning scene.");
  }
  if (compareRational(window, zeroRational) <= 0 || compareRational(window, rational(10)) > 0 || compareRational(window, selectionDuration) >= 0) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "window"), "CUT_AUDIO_REACTIVE_RANGE", "AmplitudeEnvelope window must be positive, no longer than 10s, and strictly shorter than the selected range.");
  }
  if (compareRational(hop, zeroRational) <= 0 || compareRational(hop, window) > 0) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "hop"), "CUT_AUDIO_REACTIVE_RANGE", "AmplitudeEnvelope hop must be positive and no longer than window.");
  }
  if (compareRational(attack, zeroRational) <= 0 || compareRational(attack, rational(10)) > 0) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "attack"), "CUT_AUDIO_REACTIVE_RANGE", "AmplitudeEnvelope attack must be at least one sample and no longer than 10s.");
  }
  if (compareRational(release, zeroRational) <= 0 || compareRational(release, rational(30)) > 0) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "release"), "CUT_AUDIO_REACTIVE_RANGE", "AmplitudeEnvelope release must be at least one sample and no longer than 30s.");
  }
  const ratioBound = (name: "floor" | "ceiling") => {
    const value = inputs[name];
    if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
      audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, name), "CUT_AUDIO_REACTIVE_TYPE", `AmplitudeEnvelope ${name} must reduce to one exact linear-amplitude Ratio.`);
    }
    return value.magnitude;
  };
  const floor = ratioBound("floor"), ceiling = ratioBound("ceiling");
  if (compareRational(floor, zeroRational) < 0 || compareRational(ceiling, rational(1)) > 0 || compareRational(ceiling, floor) <= 0) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "ceiling"), "CUT_AUDIO_REACTIVE_NOOP", "AmplitudeEnvelope requires exact bounds 0 <= floor < ceiling <= 100%.");
  }
  const detector = inputs.detector;
  if (detector?.kind !== "string" || (detector.value !== "peak" && detector.value !== "rms")) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "detector"), "CUT_AUDIO_REACTIVE_TYPE", "AmplitudeEnvelope detector must be exactly peak or rms.");
  }
  // This compile-environment value is consumed only by a direct map* set. It
  // never survives into public IR; the closed producer descriptor below does.
  return { kind: "call", op: symbol.native, positional: [], named: inputs, effect: "analyze" };
}

function irValuesEqual(left: IRValue, right: IRValue) { return JSON.stringify(left) === JSON.stringify(right); }

function lowerAudioReactiveSet(
  statement: Extract<Statement, { kind: "set" }>,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
  context: LowerContext,
) {
  const native = symbol.native as AudioReactiveMapNative;
  const mappedType = audioReactiveMapTypes[native];
  if (!mappedType) throw new Error("Invalid audio-reactive map symbol.");
  if (!context.scene || !context.directSceneStatementBlock) {
    audioReactiveCompileError(context, statement.span, "CUT_AUDIO_REACTIVE_SCOPE", `${symbol.name} must be attached by a direct set statement in the scene that declared its AmplitudeEnvelope.`);
  }
  const target = expressionTarget(statement.target), binding = target.binding ? context.bindings.get(target.binding) : undefined;
  if (!binding || binding.domain !== "visual" || !["x", "y", "scale", "rotation", "opacity"].includes(target.property)) {
    audioReactiveCompileError(context, statement.target.span, "CUT_AUDIO_REACTIVE_TARGET", "Audio-reactive signals may initially drive only Group x, y, scale, rotation, or opacity.");
  }
  const node = context.ir.nodes[binding.nodeId];
  if (node?.op !== "cut.visual.group") {
    audioReactiveCompileError(context, statement.target.span, "CUT_AUDIO_REACTIVE_TARGET", "Audio-reactive signals initially require a Group target so the generic visual transform resolver executes every prepared value.");
  }
  if (!node || node.sceneId !== context.scene.id) {
    audioReactiveCompileError(context, statement.target.span, "CUT_AUDIO_REACTIVE_SCOPE", "The audio-reactive target must be a visual node owned by the same scene as the producer.");
  }
  const expectedType = (() => {
    const schema = referenceKernelSchema(node.op);
    return schema?.support === "supported" ? kernelPropertyValueType(schema, target.property) : undefined;
  })();
  if (expectedType !== mappedType) {
    audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_TYPE", `${symbol.name} produces Signal<${mappedType}> but ${node.op}.${target.property} requires ${expectedType ?? "an unsupported property type"}.`);
  }
  if (node.properties[target.property] && "signal" in node.properties[target.property]) {
    audioReactiveCompileError(context, statement.target.span, "CUT_AUDIO_REACTIVE_CONFLICT", "An audio-reactive producer cannot be combined with authored signal events or another producer on the same property.");
  }
  const inputs = callArguments(expression, symbol, context);
  const sourceSignal = inputs.signal;
  if (sourceSignal?.kind !== "call" || sourceSignal.op !== "cut.data.amplitude_envelope" || sourceSignal.effect !== "analyze") {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "signal"), "CUT_AUDIO_REACTIVE_TYPE", `${symbol.name} signal must reference one direct AmplitudeEnvelope let binding.`);
  }
  const envelope = sourceSignal.named;
  const scopeScene = context.scene;
  const source = envelope.source;
  const range = envelope.range;
  const detector = envelope.detector;
  if (source?.kind !== "resource-ref" || range?.kind !== "range" || !range.exclusive
    || detector?.kind !== "string" || (detector.value !== "peak" && detector.value !== "rms")) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "signal"), "CUT_AUDIO_REACTIVE_IDENTITY", "AmplitudeEnvelope compile identity is malformed or escaped its declaring scene.");
  }
  const from = inputs.from, to = inputs.to;
  if (!from || !to || from.kind !== "quantity" || to.kind !== "quantity" || from.dimension !== to.dimension || from.unit !== to.unit) {
    audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_TYPE", `${symbol.name} endpoints must be exact matching quantities.`);
  }
  const expectedQuantity: readonly [string, string] = mappedType === "Number" ? ["scalar", "scalar"]
    : mappedType === "Ratio" ? ["ratio", "ratio"]
      : mappedType === "Length" ? ["length", "px"]
        : ["angle", "deg"];
  if (from.dimension !== expectedQuantity[0] || from.unit !== expectedQuantity[1]) {
    audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_TYPE", `${symbol.name} endpoints do not match ${mappedType}.`);
  }
  if (compareRational(from.magnitude, to.magnitude) === 0) {
    audioReactiveCompileError(context, audioReactiveArgumentSpan(expression, symbol, "to"), "CUT_AUDIO_REACTIVE_NOOP", `${symbol.name} from and to must differ.`);
  }
  const endpointMagnitudes = [from.magnitude, to.magnitude];
  const outside = (minimum: Rational, maximum: Rational) => endpointMagnitudes.some((value) => compareRational(value, minimum) < 0 || compareRational(value, maximum) > 0);
  if ((target.property === "x" || target.property === "y") && outside(rational(-65_536), rational(65_536))) {
    audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_BASELINE", `Audio-reactive ${target.property} endpoints must remain from -65536px through 65536px.`);
  }
  if (target.property === "rotation" && outside(rational(-360_000), rational(360_000))) {
    audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_BASELINE", "Audio-reactive rotation endpoints must remain from -360000deg through 360000deg.");
  }
  if (target.property === "scale") {
    const maximumDimensionScale = Math.min(8, 16_384 / context.timeline.width, 16_384 / context.timeline.height);
    const maximumPixelScale = Math.sqrt(67_108_864 / (context.timeline.width * context.timeline.height));
    const maximumScale = Math.max(0.001, Math.min(maximumDimensionScale, maximumPixelScale));
    if (endpointMagnitudes.some((value) => {
      const number = rationalToNumber(value);
      return !Number.isFinite(number) || number < 0.001 || number > maximumScale;
    })) {
      audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_BASELINE", `Audio-reactive scale endpoints must remain from 0.001 through ${maximumScale} for this composition.`);
    }
  }
  if (target.property === "opacity" && outside(zeroRational, rational(1))) {
    audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_BASELINE", "Audio-reactive opacity endpoints must remain from 0% through 100%.");
  }
  const authoredBaseline = node.inputs[target.property];
  if (authoredBaseline && !irValuesEqual(authoredBaseline, from)) {
    audioReactiveCompileError(context, statement.target.span, "CUT_AUDIO_REACTIVE_BASELINE", `Authored ${target.property} baseline must equal ${symbol.name} from, or be omitted.`);
  }
  const exactEnvelopeTime = (name: "at" | "window" | "hop" | "attack" | "release") => {
    const value = envelope[name];
    if (value?.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
      audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_IDENTITY", `AmplitudeEnvelope ${name} identity is malformed.`);
    }
    return value.magnitude;
  };
  const exactEnvelopeRatio = (name: "floor" | "ceiling") => {
    const value = envelope[name];
    if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
      audioReactiveCompileError(context, statement.value.span, "CUT_AUDIO_REACTIVE_IDENTITY", `AmplitudeEnvelope ${name} identity is malformed.`);
    }
    return value.magnitude;
  };
  const rangeStart = audioReactiveTime(range.start, "range", expression, symbol, context);
  const rangeEnd = audioReactiveTime(range.end, "range", expression, symbol, context);
  const producer: IRAudioAmplitudeProducer = {
    format: "cut-audio-amplitude-producer",
    version: 1,
    source,
    scope: { compositionId: context.timeline.id, sceneId: scopeScene.id },
    range: { start: rangeStart, end: rangeEnd },
    at: exactEnvelopeTime("at"),
    detector: detector.value,
    window: exactEnvelopeTime("window"),
    hop: exactEnvelopeTime("hop"),
    attack: exactEnvelopeTime("attack"),
    release: exactEnvelopeTime("release"),
    floor: exactEnvelopeRatio("floor"),
    ceiling: exactEnvelopeRatio("ceiling"),
    mapping: { kind: "linear", from, to },
  };
  consumeBudget(context, "signals");
  const signal: IRSignal = {
    id: semanticId(context, "signal", { kind: "audio-reactive", target }),
    kind: "track",
    valueType: mappedType,
    initial: from,
    events: [],
    producer,
    contentHash: "",
    provenance: provenance(context.moduleName, statement.span, target.property, context.expansion),
  };
  signal.contentHash = cutSignalContentHash(signal);
  context.ir.signals[signal.id] = signal;
  node.properties[target.property] = { signal: signal.id };
  node.contentHash = hash({ ...node, contentHash: undefined });
}

function expressionTarget(expression: Extract<Expression, { kind: "identifier" | "member" }>): { binding?: string; property: string } {
  if (expression.kind === "identifier") return { binding: expression.name, property: "value" };
  let object: Expression = expression.object; const properties = [expression.property];
  while (object.kind === "member") { properties.unshift(object.property); object = object.object; }
  return { binding: object.kind === "identifier" ? object.name : undefined, property: properties.join(".") };
}

function signalEvents(signal: IRSignal): IRSignalEvent[] {
  if (signal.kind === "track") return signal.events;
  if (signal.kind === "constant") return [{ kind: "set", time: zeroRational, value: signal.value }];
  if (signal.kind === "step") return signal.points.map((point) => ({ kind: "set", time: point.time, value: point.value }));
  if (signal.keyframes.length < 2) return signal.keyframes.map((point) => ({ kind: "set", time: point.time, value: point.value }));
  return signal.keyframes.slice(1).map((point, index) => ({
    kind: "animate",
    start: signal.keyframes[index].time,
    end: point.time,
    from: signal.keyframes[index].value,
    to: point.value,
    curve: point.curve,
  }));
}

function signalEventTime(event: IRSignalEvent) { return event.kind === "set" ? event.time : event.start; }

function attachSignal(context: LowerContext, targetExpression: Extract<Expression, { kind: "identifier" | "member" }>, signal: IRSignal) {
  const target = expressionTarget(targetExpression), binding = target.binding ? context.bindings.get(target.binding) : undefined;
  if (!binding) throw new Error(`Checked CUT mutation target ${target.binding ?? "(unbound)"}.${target.property} has no executable node binding.`);
  const node = context.ir.nodes[binding.nodeId]; const currentReference = node.properties[target.property];
  const schema = referenceKernelSchema(node.op);
  const valueType = schema?.support === "supported" ? kernelPropertyValueType(schema, target.property) : undefined;
  if (!valueType) throw new Error(`Checked CUT mutation target ${node.op}.${target.property} has no declared semantic signal type.`);
  const canonicalInitial = () => {
    if (node.op === cutMediaCamera2DOp) {
      const baseline = node.inputs[target.property] ?? cutMediaCamera2DDefaultIRValue(target.property);
      if (baseline) return baseline;
    }
    const baseline = resolveCutVisualPropertyTrackBaseline(node, target.property);
    if (baseline?.kind === "value") return baseline.value;
    if (baseline?.kind === "missing-input") {
      userModuleCompileError(
        context,
        targetExpression.span,
        "CUT_VISUAL_BASELINE",
        `${node.op}.${target.property} requires an explicit same-named constructor baseline before property automation: ${baseline.reason}`,
      );
    }
    // Audio kernels retain the established same-named constructor semantics.
    // The visual baseline registry is deliberately closed only over visual/AV
    // operations; falling through to null here silently discarded authored
    // Gain/EQ/Send/limiter baselines before their first event.
    return node.inputs[target.property] ?? { kind: "null" } as IRValue;
  };
  if (currentReference && "signal" in currentReference) {
    const current = context.ir.signals[currentReference.signal];
    // Array.sort is stable: temporal order is canonical, and source order is the
    // deterministic tie-breaker for exact-time discontinuities.
    const events = [...signalEvents(current), ...signalEvents(signal)].sort((left, right) => compareRational(signalEventTime(left), signalEventTime(right)));
    const combined: IRSignal = { id: current.id, kind: "track", valueType, initial: current.kind === "track" ? current.initial : canonicalInitial(), events, contentHash: "", provenance: current.provenance };
    combined.contentHash = cutSignalContentHash(combined); context.ir.signals[current.id] = combined;
  } else {
    const initial = currentReference && !("signal" in currentReference) ? currentReference : canonicalInitial();
    const attached: IRSignal = signal.kind === "track"
      ? { ...signal, valueType, initial, contentHash: "" }
      : { ...signal, valueType, contentHash: "" };
    attached.contentHash = cutSignalContentHash(attached); context.ir.signals[signal.id] = attached; node.properties[target.property] = { signal: signal.id };
  }
  node.contentHash = hash({ ...node, contentHash: undefined });
}

function rootNode(context: LowerContext, id: string, domain: NodeDomain) {
  const target = context.scene ?? context.timeline;
  if (domain === "visual") target.rootVisualIds.push(id);
  else if (domain === "audio") target.rootAudioIds.push(id);
  else target.rootAVIds.push(id);
  context.ir.nodes[id].ownership = "root";
  if (context.scene) context.scene.items.push({ id, domain }); else context.timeline.items.push({ kind: "node", id, domain });
}

type ComponentDefinitionContext = {
  check: CheckResult;
  moduleName: string;
  isolateLexicalScope?: boolean;
  lexicalEnvironment?: Environment;
  publicSymbol?: string;
};

function lowerUserComponent(
  declaration: Extract<Declaration, { kind: "component" }>,
  expression: Extract<Expression, { kind: "call" }>,
  context: LowerContext,
  body: Statement[],
  definition: ComponentDefinitionContext = { check: context.check, moduleName: context.moduleName },
): { id: string; domain: NodeDomain } {
  if (context.expansion.length / 2 >= context.budget.limits.maxExpansionDepth) throw new CutCompileLimitError("maxExpansionDepth");
  const responsiveAnnotated = definition.check.responsiveAnnotatedComponents.has(declaration.name);
  if (responsiveAnnotated) {
    if (!context.scene
      || !context.directSceneStatementBlock
      || context.directTimelineStatementBlock
      || context.expansion.length !== 0
      || compareRational(context.localTime, zeroRational) !== 0
      || compareRational(context.duration, context.scene.duration) !== 0) {
      userModuleCompileError(
        context,
        expression.span,
        "CUT_RESPONSIVE_STACK_CONTEXT",
        "A responsive annotated component must be invoked directly as one complete-interval scene root.",
      );
    }
    if (body.length > 0) {
      userModuleCompileError(
        context,
        expression.span,
        "CUT_RESPONSIVE_STACK_GRAPH",
        "A responsive annotated component invocation is structurally closed and cannot accept invocation children.",
      );
    }
  }
  const environment = definition.lexicalEnvironment
    ? cloneEnvironment(definition.lexicalEnvironment)
    : definition.isolateLexicalScope ? new Map<string, IRValue>() : cloneEnvironment(context.environment);
  const positional = expression.positional.map((item) => lowerExpression(item, context));
  declaration.parameters.forEach((parameter, index) => {
    const named = expression.named.find((item) => item.name === parameter.name);
    const defaultContext: LowerContext = {
      ...context,
      check: definition.check,
      moduleName: definition.moduleName,
      environment,
      moduleEnvironment: definition.lexicalEnvironment ?? context.moduleEnvironment,
      bindings: definition.isolateLexicalScope ? new Map() : new Map(context.bindings),
    };
    const value = named ? lowerExpression(named.value, context) : positional[index] ?? (parameter.defaultValue ? lowerExpression(parameter.defaultValue, defaultContext) : { kind: "null" } as IRValue);
    environment.set(parameter.name, value);
  });
  const returnName = declaration.returnType?.name ?? "AVNode"; const domain: NodeDomain = returnName === "Visual" || returnName === "DiagramNode" ? "visual" : returnName === "AudioNode" ? "audio" : "av";
  const symbol = definition.publicSymbol ?? declaration.name;
  const expansion = [...context.expansion, { module: definition.moduleName, span: declaration.span, symbol: `${declaration.name}:definition` }, { module: context.moduleName, span: expression.span, symbol: `${symbol}:invocation` }];
  if (returnName === "DiagramNode") {
    if (body.length) throw new Error(`Checked DiagramNode component ${symbol} received an invocation child block.`);
    const definitionBindings = definition.isolateLexicalScope ? new Map<string, Binding>() : new Map(context.bindings);
    const definitionContext: LowerContext = {
      ...context,
      check: definition.check,
      moduleName: definition.moduleName,
      environment,
      moduleEnvironment: definition.lexicalEnvironment ?? context.moduleEnvironment,
      bindings: definitionBindings,
      expansion,
    };
    const emitted = lowerStatements(declaration.body, { ...definitionContext, directSceneStatementBlock: false, directTimelineStatementBlock: false }, false);
    if (emitted.length !== 1 || context.ir.nodes[emitted[0]]?.op !== "cut.diagram.node") {
      throw new Error(`Checked DiagramNode component ${symbol} did not lower to exactly one direct cut.diagram.node.`);
    }
    return { id: emitted[0], domain: "visual" };
  }
  const id = semanticId(context, "node", { op: "cut.kernel.fragment", module: definition.moduleName, symbol });
  const node: IRNode = { id, op: "cut.kernel.fragment", domain, ownership: "detached", ...(context.scene ? { sceneId: context.scene.id } : {}), interval: { start: context.localTime, duration: context.duration }, inputs: {}, children: [], properties: {}, effects: ["pure"], contentHash: "", provenance: provenance(context.moduleName, expression.span, symbol, expansion) };
  node.contentHash = hash({ ...node, contentHash: undefined }); context.ir.nodes[id] = node;

  // A visual component's implicit self is the fragment already emitted for
  // this expansion. It is a compile-time binding, not a new runtime node.
  // Installing the fragment before lowering the definition lets ordinary
  // set/animate lowering attach its tracks directly to that fragment.
  const definitionBindings = definition.isolateLexicalScope ? new Map<string, Binding>() : new Map(context.bindings);
  if (domain === "visual") definitionBindings.set("self", { nodeId: id, domain });
  const definitionContext: LowerContext = { ...context, check: definition.check, moduleName: definition.moduleName, environment, moduleEnvironment: definition.lexicalEnvironment ?? context.moduleEnvironment, bindings: definitionBindings, expansion };
  const children = lowerStatements(declaration.body, { ...definitionContext, directSceneStatementBlock: false, directTimelineStatementBlock: false }, false);

  // Invocation children retain their call-site lexical bindings. In
  // particular, neither implicit self nor definition-local names leak into
  // the caller-authored child block.
  const invocationContext: LowerContext = { ...context, environment: cloneEnvironment(context.environment), bindings: new Map(context.bindings), expansion };
  const explicitChildren = lowerStatements(body, { ...invocationContext, directSceneStatementBlock: false, directTimelineStatementBlock: false }, false);
  node.children = [...children, ...explicitChildren];
  if (responsiveAnnotated) {
    const childNodes = node.children.map((childId) => context.ir.nodes[childId]!);
    const stack = childNodes[0];
    const consumers = childNodes.slice(1);
    const paths = consumers.filter((child) => child?.op === "cut.visual.path");
    const layers = consumers.filter((child) => child?.op === "cut.visual.callout_layer");
    if (node.domain !== "visual"
      || Object.keys(node.inputs).length !== 0
      || Object.keys(node.properties).length !== 0
      || node.effects.length !== 1
      || node.effects[0] !== "pure"
      || node.editorial !== undefined
      || node.sceneId !== context.scene?.id
      || compareRational(node.interval.start, zeroRational) !== 0
      || compareRational(node.interval.duration, context.scene?.duration ?? zeroRational) !== 0
      || !stack
      || stack.op !== "cut.visual.responsive_stack"
      || consumers.length < 1
      || paths.length > 1
      || layers.length > 1
      || paths.length + layers.length !== consumers.length
      || childNodes.some((child) => !child
        || child.domain !== "visual"
        || child.ownership !== "child"
        || child.sceneId !== node.sceneId
        || compareRational(child.interval.start, node.interval.start) !== 0
        || compareRational(child.interval.duration, node.interval.duration) !== 0)) {
      userModuleCompileError(
        context,
        expression.span,
        "CUT_RESPONSIVE_STACK_GRAPH",
        "Responsive annotated component lowering lost its exact identity fragment -> ResponsiveStack -> anchored consumer boundary.",
      );
    }
    const cameras = stack.children.flatMap((slotId) => {
      const slot = context.ir.nodes[slotId];
      if (slot?.op !== "cut.visual.responsive_slot" || slot.children.length !== 1) return [];
      const camera = context.ir.nodes[slot.children[0]!];
      return camera?.op === cutMediaCamera2DOp ? [camera] : [];
    });
    const visualAnchorOwners = (value: IRValue): Array<string | undefined> => {
      if (value.kind === "call") {
        if (value.op === cutAnchoredSpatialOps.visualAnchor) {
          const owner = value.named.owner;
          return [owner?.kind === "node-ref" ? owner.id : undefined];
        }
        return [
          ...value.positional.flatMap(visualAnchorOwners),
          ...Object.values(value.named).flatMap(visualAnchorOwners),
        ];
      }
      if (value.kind === "array") return value.items.flatMap(visualAnchorOwners);
      if (value.kind === "object") return Object.values(value.entries).flatMap(visualAnchorOwners);
      if (value.kind === "range") return [...visualAnchorOwners(value.start), ...visualAnchorOwners(value.end)];
      if (value.kind === "unary") return visualAnchorOwners(value.value);
      if (value.kind === "binary") return [...visualAnchorOwners(value.left), ...visualAnchorOwners(value.right)];
      if (value.kind === "member") return visualAnchorOwners(value.object);
      if (value.kind === "index") return [...visualAnchorOwners(value.object), ...visualAnchorOwners(value.index)];
      return [];
    };
    const subtreeAnchorOwners = (consumer: IRNode): Array<string | undefined> => [
      ...Object.values(consumer.inputs).flatMap(visualAnchorOwners),
      ...consumer.children.flatMap((childId) => {
        const child = context.ir.nodes[childId];
        return child ? subtreeAnchorOwners(child) : [undefined];
      }),
    ];
    if (cameras.length !== 1 || consumers.some((consumer) => {
      const owners = subtreeAnchorOwners(consumer);
      return owners.length === 0 || owners.some((ownerId) => ownerId !== cameras[0]!.id);
    })) {
      userModuleCompileError(
        context,
        expression.span,
        "CUT_RESPONSIVE_STACK_GRAPH",
        "Responsive annotated component consumers must anchor only to its one direct ResponsiveSlot MediaCamera2D alias.",
      );
    }
    const reachable = new Set<string>([id]);
    const pending = [...node.children];
    while (pending.length) {
      const childId = pending.pop()!;
      if (reachable.has(childId)) continue;
      reachable.add(childId);
      pending.push(...(context.ir.nodes[childId]?.children ?? []));
    }
    const expansionIdentity = stableJsonStringify(expansion);
    const orphan = Object.values(context.ir.nodes).find((candidate) =>
      candidate.id !== id
      && !reachable.has(candidate.id)
      && stableJsonStringify(candidate.provenance.expandedFrom ?? [])
        === expansionIdentity);
    if (orphan) {
      userModuleCompileError(
        context,
        expression.span,
        "CUT_RESPONSIVE_STACK_GRAPH",
        `Responsive annotated component lowering emitted orphan node ${orphan.id}; every same-expansion node must be reachable from its exact identity fragment.`,
      );
    }
    context.responsiveAnnotatedFragmentIds.add(id);
  }
  node.contentHash = hash({ ...node, contentHash: undefined });
  return { id, domain };
}

function clipCompileError(context: LowerContext, span: SourceSpan, message: string): never {
  throw new Error(`${context.moduleName}:${span.start.line}:${span.start.column}: Clip ${message}`);
}

function exactClipBoundary(context: LowerContext, span: SourceSpan, value: Rational, label: string) {
  if (multiplyRational(value, context.timeline.fps).denominator !== "1") clipCompileError(context, span, `${label} does not land on the ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps frame boundary.`);
  if (multiplyRational(value, rational(context.timeline.sampleRate)).denominator !== "1") clipCompileError(context, span, `${label} does not land on the ${context.timeline.sampleRate} Hz sample boundary.`);
}

function precompCompileError(context: LowerContext, span: SourceSpan, code: ReferencePrecompError["code"], message: string): never {
  context.check.diagnostics.push({ severity: "error", code, message, span });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function precompSourceSelection(inputs: Record<string, IRValue>, context: LowerContext, span: SourceSpan, kind: "visual" | "av" = "visual") {
  const label = kind === "av" ? "NestedSequence" : "Precomp";
  const code = (suffix: "INPUT" | "REFERENCE" | "TIMING") => `CUT_${kind === "av" ? "NESTED" : "PRECOMP"}_${suffix}` as ReferencePrecompError["code"];
  const source = inputs.source;
  if (source?.kind !== "timeline-ref") precompCompileError(context, span, code("INPUT"), `${label} source must resolve to a Timeline.`);
  const sourceComposition = context.ir.compositions.find((candidate) => candidate.id === source.id);
  if (!sourceComposition) precompCompileError(context, span, code("REFERENCE"), `${label} source timeline ${source.id} is missing.`);
  let sourceStart = zeroRational, sourceEnd = sourceComposition.duration;
  if (inputs.range !== undefined) {
    const range = inputs.range;
    if (range.kind !== "range" || !range.exclusive) {
      precompCompileError(context, span, code("INPUT"), `${label} range must reduce to an exact half-open Range<Time>; use start ..< end.`);
    }
    const start = valueRational(range.start, "time"), end = valueRational(range.end, "time");
    if (!start || !end) precompCompileError(context, span, code("INPUT"), `${label} range endpoints must reduce to exact Time values.`);
    if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0 || compareRational(end, sourceComposition.duration) > 0) {
      precompCompileError(context, span, code("TIMING"), `${label} range must be positive and remain inside source timeline “${sourceComposition.name}”.`);
    }
    sourceStart = start; sourceEnd = end;
  }
  return { label, code, sourceComposition, sourceStart, sourceEnd };
}

function precompInterval(inputs: Record<string, IRValue>, context: LowerContext, span: SourceSpan, kind: "visual" | "av" = "visual") {
  const { label, code, sourceComposition, sourceStart, sourceEnd } = precompSourceSelection(inputs, context, span, kind);
  const selectedDuration = subtractRational(sourceEnd, sourceStart);
  const end = addRational(context.localTime, selectedDuration), ownerEnd = addRational(context.localTime, context.duration);
  if (compareRational(end, ownerEnd) > 0) {
    precompCompileError(context, span, code("TIMING"), `${label} selected source duration lies outside its owning scene interval.`);
  }
  const placement = addRational(context.scene?.start ?? zeroRational, context.localTime);
  if (multiplyRational(placement, context.timeline.fps).denominator !== "1" || multiplyRational(selectedDuration, context.timeline.fps).denominator !== "1") {
    precompCompileError(context, span, code("TIMING"), `${label} placement and duration must land on the parent ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps frame grid.`);
  }
  if (multiplyRational(sourceStart, sourceComposition.fps).denominator !== "1" || multiplyRational(sourceEnd, sourceComposition.fps).denominator !== "1") {
    precompCompileError(context, span, code("TIMING"), `${label} range endpoints must land on the source ${sourceComposition.fps.numerator}/${sourceComposition.fps.denominator} fps frame grid.`);
  }
  if (kind === "av") {
    if (multiplyRational(sourceStart, rational(sourceComposition.sampleRate)).denominator !== "1" || multiplyRational(sourceEnd, rational(sourceComposition.sampleRate)).denominator !== "1") {
      precompCompileError(context, span, code("TIMING"), `${label} range endpoints must land on the source ${sourceComposition.sampleRate} Hz sample grid.`);
    }
    if (multiplyRational(placement, rational(context.timeline.sampleRate)).denominator !== "1" || multiplyRational(selectedDuration, rational(context.timeline.sampleRate)).denominator !== "1") {
      precompCompileError(context, span, code("TIMING"), `${label} placement and duration must land on the parent ${context.timeline.sampleRate} Hz sample grid.`);
    }
  }
  return { start: context.localTime, duration: selectedDuration };
}

function precompPictureSourceInterval(
  node: IRNode,
  context: LowerContext,
  span: SourceSpan,
) {
  const selection = precompSourceSelection(node.inputs, context, span, "visual");
  return {
    start: selection.sourceStart,
    duration: subtractRational(selection.sourceEnd, selection.sourceStart),
  };
}

function linkedClipInterval(inputs: Record<string, IRValue>, context: LowerContext, span: SourceSpan) {
  const authoredDuration = Object.hasOwn(inputs, "duration");
  const duration = authoredDuration ? valueRational(inputs.duration, "time") : context.duration;
  if (!duration) clipCompileError(context, span, "duration must reduce to an exact Time value.");
  if (compareRational(duration, zeroRational) <= 0) clipCompileError(context, span, "duration must be positive.");
  const ownerEnd = addRational(context.localTime, context.duration), end = addRational(context.localTime, duration);
  if (compareRational(context.localTime, zeroRational) < 0 || compareRational(end, ownerEnd) > 0) clipCompileError(context, span, "destination interval lies outside its owning scene or timeline interval.");
  const placement = addRational(context.scene?.start ?? zeroRational, context.localTime);
  exactClipBoundary(context, span, placement, "placement"); exactClipBoundary(context, span, duration, "duration");

  const fades: Rational[] = [];
  for (const name of ["fadeIn", "fadeOut"] as const) {
    if (!Object.hasOwn(inputs, name)) { fades.push(zeroRational); continue; }
    const fade = valueRational(inputs[name], "time");
    if (!fade) clipCompileError(context, span, `${name} must reduce to an exact Time value.`);
    if (compareRational(fade, zeroRational) < 0) clipCompileError(context, span, `${name} cannot be negative.`);
    exactClipBoundary(context, span, fade, name); fades.push(fade);
  }
  const range = inputs.range;
  let mediaDuration = duration;
  if (range !== undefined) {
    if (range.kind !== "range") clipCompileError(context, span, "range must reduce to an exact Range<Time> value.");
    const start = valueRational(range.start, "time"), sourceEnd = valueRational(range.end, "time");
    if (!start || !sourceEnd) clipCompileError(context, span, "range endpoints must reduce to exact Time values.");
    if (compareRational(start, zeroRational) < 0 || compareRational(sourceEnd, start) <= 0) clipCompileError(context, span, "source range must be positive and cannot begin before zero.");
    exactClipBoundary(context, span, start, "source-range start"); exactClipBoundary(context, span, sourceEnd, "source-range end");
    if (!authoredDuration) mediaDuration = subtractRational(sourceEnd, start);
    if (authoredDuration && compareRational(subtractRational(sourceEnd, start), duration) < 0) clipCompileError(context, span, "source range is shorter than the explicit destination duration; time stretching and final-frame hold are not implicit.");
  }
  if (compareRational(addRational(fades[0], fades[1]), mediaDuration) > 0) clipCompileError(context, span, "fadeIn + fadeOut cannot exceed its media duration.");
  return { start: context.localTime, duration };
}

function editorialCompileError(context: LowerContext, span: SourceSpan, code: "CUT2074" | "CUT2075" | "CUT2076" | "CUT2079" | "CUT2081" | "CUT2086" | "CUT2090" | "CUT2091" | "CUT2092" | "CUT2093" | "CUT_AUDIO_REGION_SHAPE" | "CUT_AUDIO_REGION_TIME" | "CUT_AUDIO_REGION_UNSUPPORTED" | "CUT_AUDIO_REGION_LIMIT" | "CUT_AUDIO_REGION_RETIME_TOPOLOGY" | "CUT_AUDIO_REGION_RETIME_PLAN" | "CUT_AUDIO_REGION_RETIME_AUTOMATION" | AudioEditOperationErrorCode, message: string): never {
  context.check.diagnostics.push({ severity: "error", code, message, span });
  throw new CutCompileError(context.check);
}

function exactTimelineHeaderInteger(
  context: LowerContext,
  span: SourceSpan,
  name: "width" | "height" | "sampleRate",
  value: Rational,
  unit: "px" | "Hz",
) {
  const integer = value.denominator === "1" ? Number(value.numerator) : Number.NaN;
  if (!Number.isSafeInteger(integer) || integer <= 0) {
    context.check.diagnostics.push({
      severity: "error",
      code: "CUT_TIMELINE_INTEGER",
      message: `timeline ${name} must be a positive safe integer in ${unit}; CUT does not round authored header values.`,
      span,
    });
    throw new CutCompileError(context.check);
  }
  return integer;
}

function exactPictureFrame(context: LowerContext, span: SourceSpan, value: Rational, label: string) {
  if (multiplyRational(value, context.timeline.fps).denominator !== "1") {
    editorialCompileError(context, span, "CUT2074", `${label} does not land on the ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps picture-frame boundary.`);
  }
}

function authoredPictureInterval(op: "Sequence" | "PictureClip" | "Gap", inputs: Record<string, IRValue>, context: LowerContext, span: SourceSpan): IREditorialInterval {
  const duration = valueRational(inputs.duration, "time");
  if (!duration) editorialCompileError(context, span, "CUT2074", `${op} duration must reduce to an exact Time value.`);
  if (compareRational(duration, zeroRational) <= 0) editorialCompileError(context, span, "CUT2074", `${op} duration must be positive.`);
  const ownerEnd = addRational(context.localTime, context.duration);
  const end = addRational(context.localTime, duration);
  if (compareRational(context.localTime, zeroRational) < 0 || compareRational(end, ownerEnd) > 0) {
    editorialCompileError(context, span, "CUT2074", `${op} destination interval lies outside its owning interval.`);
  }
  const placement = addRational(context.scene?.start ?? zeroRational, context.localTime);
  exactPictureFrame(context, span, placement, `${op} placement`);
  exactPictureFrame(context, span, duration, `${op} duration`);
  return { start: context.localTime, duration };
}

function pictureSourceInterval(inputs: Record<string, IRValue>, context: LowerContext, span: SourceSpan): IREditorialInterval {
  const range = inputs.range;
  if (!range || range.kind !== "range") editorialCompileError(context, span, "CUT2075", "PictureClip range must reduce to an exact Range<Time> value.");
  if (!range.exclusive) editorialCompileError(context, span, "CUT2075", "PictureClip range must be half-open; use start ..< end.");
  const start = valueRational(range.start, "time");
  const end = valueRational(range.end, "time");
  if (!start || !end) editorialCompileError(context, span, "CUT2075", "PictureClip range endpoints must reduce to exact Time values.");
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    editorialCompileError(context, span, "CUT2075", "PictureClip source range must be positive and cannot begin before zero.");
  }
  const duration = subtractRational(end, start);
  return { start, duration };
}

function validatePictureHandleAvailability(inputs: Record<string, IRValue>, source: IREditorialInterval, context: LowerContext, span: SourceSpan) {
  const handles = (["headHandle", "tailHandle"] as const).map((name) => {
    const input = inputs[name];
    if (input === undefined) return { name, value: zeroRational };
    const value = valueRational(input, "time");
    if (!value || compareRational(value, zeroRational) < 0) editorialCompileError(context, span, "CUT2075", `PictureClip ${name} must reduce to a non-negative exact Time value.`);
    return { name, value };
  });
  const head = handles[0].value, tail = handles[1].value;
  const availableStart = subtractRational(source.start, head), availableEnd = addRational(addRational(source.start, source.duration), tail);
  if (compareRational(availableStart, zeroRational) < 0) editorialCompileError(context, span, "CUT2075", "PictureClip headHandle extends before source time zero.");
  // Source frame-rate/time-base alignment and the upper media bound are lock
  // facts, not composition facts, and are enforced by the locked runtime.
  void availableEnd;
}

function compilePictureTimeMap(inputs: Record<string, IRValue>, destination: IREditorialInterval, context: LowerContext, span: SourceSpan) {
  try {
    const map = authoredPictureTimeMap(inputs, destination.duration);
    if (map.kind === "speed-ramp") {
      for (const [index, point] of map.points.entries()) {
        if (multiplyRational(point.at, context.timeline.fps).denominator !== "1") {
          editorialCompileError(context, span, "CUT2086", `PictureClip speedRamp point ${index + 1} at ${point.at.numerator}/${point.at.denominator}s does not land on the ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps destination frame grid.`);
        }
      }
    }
    return map;
  } catch (error) {
    if (!(error instanceof PictureTimeMapInputError)) throw error;
    const legacyDefault = inputs.playback === undefined && inputs.rate === undefined && inputs.freezeAt === undefined && inputs.speedRamp === undefined;
    const legacyDurationMismatch = legacyDefault && error.message.startsWith("PictureClip source duration must equal destination duration");
    editorialCompileError(
      context,
      span,
      legacyDurationMismatch ? "CUT2075" : "CUT2086",
      legacyDurationMismatch
        ? "PictureClip source and destination durations must match exactly; implicit time stretching or frame holding is not permitted."
        : error.message,
    );
  }
}

function editorialLinkId(inputs: Record<string, IRValue>, context: LowerContext, span: SourceSpan): string | undefined {
  if (!Object.hasOwn(inputs, "link")) return undefined;
  const link = inputs.link?.kind === "string" ? inputs.link.value : undefined;
  if (!link || link !== link.trim() || link.length > 128 || /[\u0000-\u001f\u007f]/.test(link)) {
    editorialCompileError(context, span, "CUT2081", "Editorial link must reduce to a non-empty trimmed String of at most 128 characters without control characters.");
  }
  return link;
}

function exactAudioSample(context: LowerContext, span: SourceSpan, value: Rational, label: string) {
  if (multiplyRational(value, rational(context.timeline.sampleRate)).denominator !== "1") {
    editorialCompileError(context, span, "CUT2074", `${label} does not land on the ${context.timeline.sampleRate} Hz destination sample grid.`);
  }
}

function authoredAudioDestinationInterval(inputs: Record<string, IRValue>, context: LowerContext, span: SourceSpan, op: "AudioClip" | "AudioRegion" | "AudioGap"): IREditorialInterval {
  const destination = inputs.destination;
  if (!destination || destination.kind !== "range") editorialCompileError(context, span, "CUT2074", `${op} destination must reduce to an exact Range<Time> value.`);
  if (!destination.exclusive) editorialCompileError(context, span, "CUT2074", `${op} destination must be half-open; use start ..< end.`);
  const authoredStart = valueRational(destination.start, "time"), authoredEnd = valueRational(destination.end, "time");
  if (!authoredStart || !authoredEnd) editorialCompileError(context, span, "CUT2074", `${op} destination endpoints must reduce to exact Time values.`);
  if (compareRational(authoredStart, zeroRational) < 0 || compareRational(authoredEnd, authoredStart) <= 0) {
    editorialCompileError(context, span, "CUT2074", `${op} destination range must be positive and cannot begin before the AudioTrack origin.`);
  }
  const start = addRational(context.localTime, authoredStart), end = addRational(context.localTime, authoredEnd);
  const ownerEnd = addRational(context.localTime, context.duration);
  if (compareRational(end, ownerEnd) > 0) editorialCompileError(context, span, "CUT2074", `${op} destination range lies outside its owning AudioTrack interval.`);
  const absoluteStart = addRational(context.scene?.start ?? zeroRational, start);
  const absoluteEnd = addRational(context.scene?.start ?? zeroRational, end);
  exactAudioSample(context, span, absoluteStart, `${op} destination start`);
  exactAudioSample(context, span, absoluteEnd, `${op} destination end`);
  return { start, duration: subtractRational(end, start) };
}

const audioRegionInsertOps = new Set([
  "cut.audio.gain",
  "cut.audio.pan",
  "cut.audio.eq",
  "cut.audio.highpass",
  "cut.audio.lowpass",
  "cut.audio.compressor",
  "cut.audio.deesser",
  "cut.audio.time_stretch",
]);

/** Resolve the one source leaf and ordered outer-to-inner processor chain. */
function compiledAudioRegionChain(context: LowerContext, region: IRNode, span: SourceSpan) {
  if (region.op !== "cut.edit.audio_region" || region.children.length !== 1) {
    editorialCompileError(context, span, "CUT_AUDIO_REGION_SHAPE", "AudioRegion requires exactly one direct audio processor/source root.");
  }
  const visited = new Set<string>();
  const processorNodeIds: string[] = [];
  let timeStretchNode: IRNode | undefined;
  let node = context.ir.nodes[region.children[0]];
  for (let depth = 0; depth <= 32; depth += 1) {
    if (!node || node.domain !== "audio" || visited.has(node.id)) {
      editorialCompileError(context, span, "CUT_AUDIO_REGION_SHAPE", "AudioRegion must contain one finite acyclic audio source chain.");
    }
    visited.add(node.id);
    if (compareRational(node.interval.start, region.interval.start) !== 0 || compareRational(node.interval.duration, region.interval.duration) !== 0 || node.sceneId !== region.sceneId) {
      editorialCompileError(context, node.provenance.span, "CUT_AUDIO_REGION_TIME", "Every AudioRegion insert and source leaf must share the region's exact destination interval and scene.");
    }
    if (node.op === "cut.audio.clip") {
      if (node.children.length !== 0) editorialCompileError(context, node.provenance.span, "CUT_AUDIO_REGION_SHAPE", "AudioRegion's AudioClip leaf cannot have children.");
      if (node.inputs.range === undefined) editorialCompileError(context, node.provenance.span, "CUT_AUDIO_REGION_SHAPE", "AudioRegion's AudioClip leaf requires an explicit half-open source range.");
      const forbidden = ["destination", "link", "headHandle", "tailHandle"].find((name) => node.inputs[name] !== undefined);
      if (forbidden) editorialCompileError(context, node.provenance.span, "CUT_AUDIO_REGION_SHAPE", `AudioRegion owns placement/link; its AudioClip leaf cannot author ${forbidden}:.`);
      return { sourceNode: node, processorNodeIds, ...(timeStretchNode ? { timeStretchNode } : {}) };
    }
    if (!audioRegionInsertOps.has(node.op)) {
      editorialCompileError(context, node.provenance.span, "CUT_AUDIO_REGION_UNSUPPORTED", `AudioRegion does not yet support ${node.op}; use only the closed boundary-contained Gain/Pan/ParametricEQ/HighPass/LowPass/Compressor/DeEsser insert set with at most one TimeStretch.`);
    }
    if (node.children.length !== 1) {
      editorialCompileError(context, node.provenance.span, "CUT_AUDIO_REGION_SHAPE", `${node.op} inside AudioRegion must have exactly one direct audio child.`);
    }
    if (node.op === "cut.audio.time_stretch") {
      if (timeStretchNode) editorialCompileError(context, node.provenance.span, "CUT_AUDIO_REGION_RETIME_TOPOLOGY", "AudioRegion supports exactly one TimeStretch in its closed unary chain; nested or repeated retimes are refused.");
      timeStretchNode = node;
    }
    processorNodeIds.push(node.id);
    node = context.ir.nodes[node.children[0]];
  }
  editorialCompileError(context, span, "CUT_AUDIO_REGION_LIMIT", "AudioRegion insert depth exceeds the 32-node bound.");
}

function audioSourceInterval(inputs: Record<string, IRValue>, destination: IREditorialInterval, context: LowerContext, span: SourceSpan, allowRetime = false): IREditorialInterval {
  const range = inputs.range;
  if (!range || range.kind !== "range") editorialCompileError(context, span, "CUT2075", "AudioTrack AudioClip range must reduce to an exact Range<Time> value.");
  if (!range.exclusive) editorialCompileError(context, span, "CUT2075", "AudioTrack AudioClip range must be half-open; use start ..< end.");
  const start = valueRational(range.start, "time"), end = valueRational(range.end, "time");
  if (!start || !end) editorialCompileError(context, span, "CUT2075", "AudioTrack AudioClip source endpoints must reduce to exact Time values.");
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    editorialCompileError(context, span, "CUT2075", "AudioTrack AudioClip source range must be positive and cannot begin before zero.");
  }
  const duration = subtractRational(end, start);
  if (!allowRetime && compareRational(duration, destination.duration) !== 0) {
    editorialCompileError(context, span, "CUT2075", "AudioTrack AudioClip source and destination durations must match exactly; implicit time stretch is not permitted.");
  }
  return { start, duration };
}

function validateAudioTrackFades(inputs: Record<string, IRValue>, destination: IREditorialInterval, context: LowerContext, span: SourceSpan) {
  let total = zeroRational;
  for (const name of ["fadeIn", "fadeOut"] as const) {
    const input = inputs[name];
    if (input === undefined) continue;
    const fade = valueRational(input, "time");
    if (!fade || compareRational(fade, zeroRational) < 0) editorialCompileError(context, span, "CUT2079", `AudioTrack AudioClip ${name} must be a non-negative exact Time value.`);
    exactAudioSample(context, span, fade, `AudioTrack AudioClip ${name}`);
    total = addRational(total, fade);
  }
  if (compareRational(total, destination.duration) > 0) {
    editorialCompileError(context, span, "CUT2079", "AudioTrack AudioClip fadeIn + fadeOut cannot exceed its destination duration.");
  }
}

function validateAudioTrackHandles(inputs: Record<string, IRValue>, context: LowerContext, span: SourceSpan) {
  for (const name of ["headHandle", "tailHandle"] as const) {
    const input = inputs[name];
    if (input === undefined) continue;
    const handle = valueRational(input, "time");
    if (!handle || compareRational(handle, zeroRational) < 0) editorialCompileError(context, span, "CUT_AUDIO_EDIT_TIME", `AudioTrack AudioClip ${name} must be a non-negative exact Time value.`);
    // Declared availability belongs to the selected native source clock, not
    // the composition clock. Exact grid and bounds are validated after lock.
  }
}

function lowerSequenceChildren(statements: Statement[], context: LowerContext, span: SourceSpan): { children: string[]; editorial: IREditorial } {
  const children: string[] = [];
  const tracks: Extract<IREditorial, { kind: "sequence" }>["tracks"] = [];
  for (const statement of statements) {
    consumeBudget(context, "statements");
    if (statement.kind !== "node") editorialCompileError(context, statement.span, "CUT2076", "Sequence bodies may contain only direct PictureTrack nodes.");
    const lowered = lowerNode(statement, { ...context, bindings: new Map(context.bindings) });
    const child = context.ir.nodes[lowered.id];
    if (child.op !== "cut.edit.picture_track" || child.domain !== "visual") {
      editorialCompileError(context, statement.span, "CUT2076", "Sequence bodies may contain only direct visual PictureTrack nodes.");
    }
    child.ownership = "child";
    children.push(child.id);
    tracks.push({ nodeId: child.id, order: tracks.length, destination: child.interval });
  }
  if (!children.length) editorialCompileError(context, span, "CUT2076", "Sequence requires at least one PictureTrack.");
  return { children, editorial: { kind: "sequence", tracks } };
}

function pictureEditDiagnosticCode(error: PictureEditOperationError): "CUT2090" | "CUT2091" | "CUT2092" | "CUT2093" {
  if (error.kind === "time") return "CUT2091";
  if (error.kind === "result") return "CUT2092";
  if (error.kind === "unsupported") return "CUT2093";
  return "CUT2090";
}

function pictureEditExpressionSpans(expression: Extract<Expression, { kind: "call" }>) {
  const edits = expression.named.find((argument) => argument.name === "edits")?.value;
  return edits?.kind === "array" ? edits.items.map((item) => item.span) : [];
}

function relativePictureEditBaseItem(item: Extract<IREditorial, { kind: "picture-track" }>["items"][number], node: IRNode, origin: Rational, index: number): IRPictureEditItem {
  return {
    origin: `base:${index}`,
    kind: item.kind,
    destination: { start: subtractRational(item.destination.start, origin), duration: item.destination.duration },
    inputs: { ...node.inputs },
    provenance: node.provenance,
    ...(item.source ? { source: { ...item.source } } : {}),
    ...(item.timeMap ? { timeMap: item.timeMap.kind === "speed-ramp" ? { ...item.timeMap, points: item.timeMap.points.map((point) => ({ ...point })) } : { ...item.timeMap } } : {}),
    ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}),
  };
}

function operationTimes(operation: IRPictureTrackOperationPlan["operations"][number]) {
  const intervals: Array<{ value: Rational; label: string }> = [];
  if ("at" in operation) intervals.push({ value: operation.at, label: `${operation.kind} point` });
  if ("range" in operation) {
    intervals.push({ value: operation.range.start, label: `${operation.kind} range start` });
    intervals.push({ value: addRational(operation.range.start, operation.range.duration), label: `${operation.kind} range end` });
  }
  if ("keep" in operation) {
    intervals.push({ value: operation.keep.start, label: "trim keep start" });
    intervals.push({ value: addRational(operation.keep.start, operation.keep.duration), label: "trim keep end" });
  }
  if ("by" in operation) intervals.push({ value: operation.by, label: `${operation.kind} delta` });
  if ("item" in operation) intervals.push({ value: operation.item.destination.duration, label: `${operation.kind} item duration` });
  if ("item" in operation && operation.item.timeMap?.kind === "speed-ramp") {
    operation.item.timeMap.points.forEach((point, index) => intervals.push({ value: point.at, label: `${operation.kind} speedRamp point ${index + 1}` }));
  }
  if (operation.kind === "transition") {
    const half = divideRational(operation.duration, rational(2));
    intervals.push({ value: operation.duration, label: "transition duration" });
    intervals.push({ value: subtractRational(operation.at, half), label: "transition overlap start" });
    intervals.push({ value: addRational(operation.at, half), label: "transition overlap end" });
  }
  return intervals;
}

function exactPictureEditFrame(context: LowerContext, span: SourceSpan, value: Rational, label: string) {
  if (multiplyRational(value, context.timeline.fps).denominator !== "1") {
    editorialCompileError(context, span, "CUT2091", `${label} does not land on the ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps picture-frame grid.`);
  }
}

function materializePictureEditItems(
  context: LowerContext,
  trackId: string,
  trackOrigin: Rational,
  baseNodeIds: readonly string[],
  plan: IRPictureTrackOperationPlan,
  execution: IRPictureTrackExecution,
) {
  const result = execution.items;
  for (const id of baseNodeIds) delete context.ir.nodes[id];
  for (let index = baseNodeIds.length; index < result.length; index += 1) consumeBudget(context, "nodes");
  const children: string[] = [];
  const items: Extract<IREditorial, { kind: "picture-track" }>["items"] = [];
  for (const [index, item] of result.entries()) {
    const id = pictureEditMaterializedNodeId(trackId, index, item);
    if (context.ir.nodes[id]) editorialCompileError(context, item.provenance.span, "CUT2092", `PictureTrack edit materialization collided with existing node ${id}.`);
    const destination = { start: addRational(trackOrigin, item.destination.start), duration: item.destination.duration };
    const node: IRNode = {
      id,
      op: item.kind === "picture" ? "cut.edit.picture_clip" : "cut.edit.gap",
      domain: "visual",
      ownership: "child",
      ...(context.scene ? { sceneId: context.scene.id } : {}),
      interval: destination,
      inputs: { ...item.inputs },
      children: [],
      properties: {},
      effects: ["pure"],
      contentHash: "",
      provenance: item.provenance,
    };
    node.contentHash = hash({ ...node, contentHash: undefined });
    context.ir.nodes[id] = node;
    children.push(id);
    items.push({
      nodeId: id,
      order: index,
      kind: item.kind,
      destination,
      ...(item.source ? { source: item.source } : {}),
      ...(item.timeMap ? { timeMap: item.timeMap } : {}),
      ...(item.inputs.link?.kind === "string" ? { linkId: item.inputs.link.value } : {}),
      ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}),
    });
  }
  const transitions: NonNullable<Extract<IREditorial, { kind: "picture-track" }>["transitions"]> = execution.transitions.map((transition) => ({
    cut: addRational(trackOrigin, transition.cut),
    duration: transition.duration,
    overlap: { start: addRational(trackOrigin, transition.overlap.start), duration: transition.overlap.duration },
    outgoingNodeId: children[transition.outgoingIndex],
    incomingNodeId: children[transition.incomingIndex],
    outgoingSource: transition.outgoingSource,
    incomingSource: transition.incomingSource,
    style: transition.style,
    provenance: transition.provenance,
  }));
  return { children, editorial: { kind: "picture-track", items, operationPlan: plan, ...(transitions.length ? { transitions } : {}) } as IREditorial };
}

function lowerPictureTrackChildren(
  statements: Statement[],
  context: LowerContext,
  span: SourceSpan,
  operation?: { trackId: string; inputs: Record<string, IRValue>; finalDuration: Rational; spans: SourceSpan[] },
): { children: string[]; editorial: IREditorial } {
  const children: string[] = [];
  const items: Extract<IREditorial, { kind: "picture-track" }>["items"] = [];
  let cursor = context.localTime;
  const trackEnd = addRational(context.localTime, context.duration);
  for (const statement of statements) {
    consumeBudget(context, "statements");
    if (statement.kind !== "node") editorialCompileError(context, statement.span, "CUT2076", "PictureTrack bodies may contain only direct PictureClip, Precomp, or Gap nodes.");
    const lowered = lowerNode(statement, { ...context, localTime: cursor, duration: subtractRational(trackEnd, cursor), bindings: new Map(context.bindings) });
    const child = context.ir.nodes[lowered.id];
    const kind = child.op === "cut.edit.picture_clip" || child.op === "cut.visual.precomp"
      ? "picture"
      : child.op === "cut.edit.gap"
        ? "gap"
        : undefined;
    if (!kind || child.domain !== "visual") {
      editorialCompileError(context, statement.span, "CUT2076", "PictureTrack bodies may contain only direct visual PictureClip, Precomp, or Gap nodes.");
    }
    child.ownership = "child";
    children.push(child.id);
    const linkId = kind === "picture" ? editorialLinkId(child.inputs, context, statement.span) : undefined;
    const source = child.op === "cut.visual.precomp"
      ? precompPictureSourceInterval(child, context, statement.span)
      : kind === "picture"
        ? pictureSourceInterval(child.inputs, context, statement.span)
        : undefined;
    const authored = context.editorialAuthoringIds.get(child.id);
    const editId = authored?.editId;
    if (source && child.op === "cut.edit.picture_clip") validatePictureHandleAvailability(child.inputs, source, context, statement.span);
    const pictureTimeMap = child.op === "cut.edit.picture_clip"
      ? compilePictureTimeMap(child.inputs, child.interval, context, statement.span)
      : undefined;
    items.push({
      nodeId: child.id,
      order: items.length,
      kind,
      destination: child.interval,
      ...(kind === "picture" ? {
        source: source!,
        ...(pictureTimeMap && !isDefaultPictureTimeMap(pictureTimeMap) ? { timeMap: pictureTimeMap } : {}),
        ...(linkId ? { linkId } : {}),
        ...(editId ? { editId } : {}),
        ...(authored?.role ? { role: authored.role } : {}),
        ...(authored?.metadata ? { metadata: { ...authored.metadata } } : {}),
      } : {}),
    });
    cursor = addRational(cursor, child.interval.duration);
  }
  if (!children.length) editorialCompileError(context, span, "CUT2076", "PictureTrack requires at least one PictureClip, Precomp, or Gap.");
  if (compareRational(cursor, trackEnd) !== 0) {
    editorialCompileError(context, span, "CUT2074", "PictureTrack items must fill the owning Sequence interval exactly; author an explicit Gap for intentional empty picture time.");
  }
  if (operation) {
    const transcriptPicture = children
      .map((id) => context.ir.nodes[id])
      .find((node) => node?.inputs.transcriptPictureIdentity !== undefined);
    if (transcriptPicture) {
      transcriptCompileError(
        context,
        transcriptPicture.provenance.span,
        "CUT_TRANSCRIPT_SCOPE",
        "TranscriptPicture must remain a direct, unmaterialized PictureTrack item; PictureTrack structural edit plans cannot rewrite its authenticated source, destination, or frame-snap identity.",
      );
    }
    const provenances = operation.spans.map((operationSpan) => provenance(context.moduleName, operationSpan, "PictureTrack edit", context.expansion));
    let operations: IRPictureTrackOperationPlan["operations"], execution: IRPictureTrackExecution;
    const baseItems = items.map((item, index) => relativePictureEditBaseItem(item, context.ir.nodes[item.nodeId], context.localTime, index));
    if (items.some((item) => item.linkId)) editorialCompileError(context, span, "CUT2093", "PictureTrack edit operations do not yet couple linked audio; remove link: or author picture/audio endpoints independently.");
    try {
      operations = pictureEditOperationsFromInput(operation.inputs.edits, provenances);
      if (baseItems.some((item) =>
        item.inputs.transcriptMediaAuthorityId !== undefined)) {
        const unsupported = operations.findIndex((edit) =>
          edit.kind !== "split" && edit.kind !== "trim");
        if (unsupported >= 0) {
          transcriptCompileError(
            context,
            operation.spans[unsupported] ?? span,
            "CUT_TRANSCRIPT_SCOPE",
            `Authority-backed TranscriptPicture admits only ordinary split and trim operations in this contract; ${operations[unsupported]!.kind === "transition" ? "transition" : operations[unsupported]!.kind} requires separately authenticated media-handle ownership.`,
          );
        }
      }
      const plan: IRPictureTrackOperationPlan = { version: 1, sourceDuration: context.duration, baseItems, operations };
      for (const [index, edit] of operations.entries()) {
        const operationSpan = operation.spans[index] ?? span;
        const trackPlacement = addRational(context.scene?.start ?? zeroRational, context.localTime);
        if (edit.kind === "transition") {
          const frames = multiplyRational(edit.duration, context.timeline.fps);
          if (frames.denominator !== "1" || BigInt(frames.numerator) < 2n || BigInt(frames.numerator) % 2n !== 0n) {
            throw new PictureEditOperationError("time", "transitionAt duration must span an even number of at least two composition frames so its centered half-handles are exact.", index);
          }
        }
        for (const time of operationTimes(edit)) exactPictureEditFrame(context, operationSpan, addRational(trackPlacement, time.value), time.label);
        if ("item" in edit && edit.item.kind === "picture") {
          const source = edit.item.inputs.source;
          if (source?.kind !== "resource-ref" || context.ir.resources[source.id]?.kind !== "video") throw new PictureEditOperationError("shape", "editClip source must resolve to a declared VideoAsset.", index);
          validatePictureHandleAvailability(edit.item.inputs, edit.item.source!, context, operationSpan);
        }
      }
      execution = executePictureTrackOperationPlan(plan);
      const resultDuration = execution.items.length ? addRational(execution.items.at(-1)!.destination.start, execution.items.at(-1)!.destination.duration) : zeroRational;
      if (compareRational(resultDuration, operation.finalDuration) !== 0) {
        throw new PictureEditOperationError("result", `PictureTrack edits materialize ${resultDuration.numerator}/${resultDuration.denominator}s, but the owning Sequence requires exactly ${operation.finalDuration.numerator}/${operation.finalDuration.denominator}s.`);
      }
      // sourceDuration/edits are compile-time language operands. Their closed,
      // executable meaning is the typed operationPlan; unresolved function
      // calls must never leak into runtime node inputs.
      delete operation.inputs.sourceDuration;
      delete operation.inputs.edits;
      return materializePictureEditItems(context, operation.trackId, context.localTime, children, plan, execution);
    } catch (error) {
      if (!(error instanceof PictureEditOperationError)) throw error;
      editorialCompileError(context, operation.spans[error.operationIndex ?? -1] ?? span, pictureEditDiagnosticCode(error), error.message);
    }
  }
  return { children, editorial: { kind: "picture-track", items } };
}

function audioEditExpressionSpans(expression: Extract<Expression, { kind: "call" }>) {
  const edits = expression.named.find((argument) => argument.name === "edits")?.value;
  return edits?.kind === "array" ? edits.items.map((item) => item.span) : [];
}

function relativeAudioEditBaseItem(
  item: Extract<IREditorial, { kind: "audio-track" }>["items"][number],
  node: IRNode,
  origin: Rational,
  index: number,
): AudioEditItem {
  const destination = { start: subtractRational(item.destination.start, origin), duration: item.destination.duration };
  if (item.kind === "gap") return { origin: `base:${index}`, kind: "gap", destination, inputs: {}, provenance: node.provenance };
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") throw new AudioEditOperationError("shape", "AudioTrack edit source item must reference an AudioAsset.", `$.baseItems[${index}].inputs.resourceId`);
  const inputs: Extract<AudioEditItem, { kind: "clip" }>["inputs"] = {
    resourceId: source.id,
    ...(item.linkId ? { linkId: item.linkId } : {}),
  };
  for (const name of ["fadeIn", "fadeOut", "headHandle", "tailHandle"] as const) {
    const value = node.inputs[name];
    if (value === undefined) continue;
    const amount = valueRational(value, "time");
    if (!amount) throw new AudioEditOperationError("shape", `AudioTrack edit source ${name} must be an exact Time.`, `$.baseItems[${index}].inputs.${name}`);
    inputs[name] = amount;
  }
  return { origin: `base:${index}`, kind: "clip", destination, source: item.source!, inputs, ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}), provenance: node.provenance };
}

function relativeAudioEditRegionBaseItem(
  item: Extract<IREditorial, { kind: "audio-track" }>["items"][number],
  region: IRNode,
  sourceNode: IRNode,
  processorNodeIds: readonly string[],
  origin: Rational,
  index: number,
): AudioEditRegionItem {
  const source = sourceNode.inputs.source;
  if (source?.kind !== "resource-ref") throw new AudioEditOperationError("region-plan", "AudioRegion source leaf must reference an AudioAsset.", `$.baseItems[${index}].inputs.resourceId`);
  const inputs: AudioEditRegionItem["inputs"] = {
    resourceId: source.id,
    ...(item.linkId ? { linkId: item.linkId } : {}),
  };
  for (const name of ["headHandle", "tailHandle"] as const) {
    const value = region.inputs[name];
    if (value === undefined) continue;
    const amount = valueRational(value, "time");
    if (!amount) throw new AudioEditOperationError("region-handle", `AudioRegion ${name} must be an exact Time.`, `$.baseItems[${index}].inputs.${name}`);
    inputs[name] = amount;
  }
  return {
    origin: `base:${index}`,
    kind: "region",
    regionId: region.id,
    sourceNodeId: sourceNode.id,
    processorNodeIds: [...processorNodeIds],
    destination: { start: subtractRational(item.destination.start, origin), duration: item.destination.duration },
    source: { ...item.source! },
    inputs,
    provenance: region.provenance,
  };
}

function audioEditTimes(operation: AudioEditOperationPlan["operations"][number]) {
  const values: Array<{ value: Rational; label: string }> = [];
  if ("at" in operation) values.push({ value: operation.at, label: `${operation.kind} point` });
  if ("range" in operation) values.push({ value: operation.range.start, label: `${operation.kind} range start` }, { value: addRational(operation.range.start, operation.range.duration), label: `${operation.kind} range end` });
  if ("keep" in operation) values.push({ value: operation.keep.start, label: "trim keep start" }, { value: addRational(operation.keep.start, operation.keep.duration), label: "trim keep end" });
  // slide.by changes destination timing and therefore belongs to the
  // composition sample clock. slip.by changes only the source window; its
  // exact clock is the selected locked source stream and is unavailable until
  // runtime validation.
  if (operation.kind === "slide") values.push({ value: operation.by, label: "slide delta" });
  if ("item" in operation) values.push({ value: operation.item.destination.duration, label: `${operation.kind} item duration` });
  if (operation.kind === "crossfade") {
    const half = divideRational(operation.duration, rational(2));
    values.push(
      { value: operation.duration, label: "audio crossfade duration" },
      { value: subtractRational(operation.at, half), label: "audio crossfade overlap start" },
      { value: addRational(operation.at, half), label: "audio crossfade overlap end" },
    );
  }
  return values;
}

function exactAudioEditSample(context: LowerContext, span: SourceSpan, value: Rational, label: string) {
  if (multiplyRational(value, rational(context.timeline.sampleRate)).denominator !== "1") {
    editorialCompileError(context, span, "CUT_AUDIO_EDIT_TIME", `${label} does not land on the ${context.timeline.sampleRate} Hz destination sample grid.`);
  }
}

function audioEditTimeValue(value: Rational): IRValue {
  return { kind: "quantity", dimension: "time", magnitude: value, unit: "s" };
}

function audioEditRangeValue(interval: IREditorialInterval): IRValue {
  return { kind: "range", start: audioEditTimeValue(interval.start), end: audioEditTimeValue(addRational(interval.start, interval.duration)), exclusive: true };
}

function materializeAudioEditItems(
  context: LowerContext,
  trackId: string,
  trackOrigin: Rational,
  baseNodeIds: readonly string[],
  plan: AudioEditOperationPlan,
  execution: AudioEditExecution,
) {
  for (const id of baseNodeIds) delete context.ir.nodes[id];
  for (let index = baseNodeIds.length; index < execution.items.length; index += 1) consumeBudget(context, "nodes");
  const children: string[] = [];
  const items: Extract<IREditorial, { kind: "audio-track" }>["items"] = [];
  for (const [index, item] of execution.items.entries()) {
    const id = audioEditMaterializedNodeId(trackId, index, item);
    if (context.ir.nodes[id]) editorialCompileError(context, item.provenance.span, "CUT_AUDIO_EDIT_RESULT", `AudioTrack edit materialization collided with existing node ${id}.`);
    const destination = { start: addRational(trackOrigin, item.destination.start), duration: item.destination.duration };
    const inputs: Record<string, IRValue> = item.kind === "clip"
      ? {
          source: { kind: "resource-ref", id: item.inputs.resourceId },
          range: audioEditRangeValue(item.source),
          destination: audioEditRangeValue(item.destination),
          ...(item.inputs.linkId ? { link: { kind: "string", value: item.inputs.linkId } as IRValue } : {}),
          ...(item.inputs.headHandle ? { headHandle: audioEditTimeValue(item.inputs.headHandle) } : {}),
          ...(item.inputs.tailHandle ? { tailHandle: audioEditTimeValue(item.inputs.tailHandle) } : {}),
        }
      : { destination: audioEditRangeValue(item.destination) };
    const node: IRNode = {
      id,
      op: item.kind === "clip" ? "cut.audio.clip" : "cut.edit.audio_gap",
      domain: "audio",
      ownership: "child",
      ...(context.scene ? { sceneId: context.scene.id } : {}),
      interval: destination,
      inputs,
      children: [],
      properties: {},
      effects: ["pure"],
      contentHash: "",
      provenance: item.provenance,
    };
    node.contentHash = hash({ ...node, contentHash: undefined });
    context.ir.nodes[id] = node;
    children.push(id);
    items.push({
      nodeId: id,
      order: index,
      kind: item.kind === "clip" ? "audio" : "gap",
      destination,
      ...(item.kind === "clip" ? { source: item.source } : {}),
      ...(item.kind === "clip" && item.inputs.linkId ? { linkId: item.inputs.linkId } : {}),
      ...(item.kind === "clip" && item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}),
    });
  }
  const transitions: NonNullable<Extract<IREditorial, { kind: "audio-track" }>["transitions"]> = execution.transitions.map((transition) => ({
    cut: addRational(trackOrigin, transition.cut),
    duration: transition.duration,
    overlap: { start: addRational(trackOrigin, transition.overlap.start), duration: transition.overlap.duration },
    outgoingNodeId: children[transition.outgoingIndex],
    incomingNodeId: children[transition.incomingIndex],
    outgoingSource: transition.outgoingSource,
    incomingSource: transition.incomingSource,
    curve: transition.curve,
    provenance: transition.provenance,
  }));
  return { children, editorial: { kind: "audio-track", items, operationPlan: plan, ...(transitions.length ? { transitions } : {}) } as IREditorial };
}

function encodeAudioRegionCrossfades(
  trackOrigin: Rational,
  children: readonly string[],
  items: Extract<IREditorial, { kind: "audio-track" }>["items"],
  plan: AudioEditOperationPlanV2,
  execution: AudioEditExecution,
) {
  if (execution.items.length !== items.length || execution.items.some((item, index) => item.kind !== "region" || item.regionId !== children[index])) {
    throw new AudioEditOperationError("region-plan", "AudioRegion transition-only execution changed authored item identity or cardinality.", "$.baseItems");
  }
  const transitions: NonNullable<Extract<IREditorial, { kind: "audio-track" }>["transitions"]> = execution.transitions.map((transition) => ({
    cut: addRational(trackOrigin, transition.cut),
    duration: transition.duration,
    overlap: { start: addRational(trackOrigin, transition.overlap.start), duration: transition.overlap.duration },
    outgoingNodeId: children[transition.outgoingIndex],
    incomingNodeId: children[transition.incomingIndex],
    outgoingSource: transition.outgoingSource,
    incomingSource: transition.incomingSource,
    curve: transition.curve,
    provenance: transition.provenance,
  }));
  return { children: [...children], editorial: { kind: "audio-track", items, operationPlan: plan, transitions } as IREditorial };
}

export type LinkedEditTrackStage = {
  trackId: string;
  removeNodeIds: string[];
  nodes: IRNode[];
  children: string[];
  editorial: Extract<IREditorial, { kind: "picture-track" | "audio-track" }>;
};

export type LinkedEditStage = {
  linkedEdits: IRLinkedEdit[];
  tracks: LinkedEditTrackStage[];
};

/** Backward-compatible public aliases for the original bounded transaction. */
export type LinkedTrimTrackStage = LinkedEditTrackStage;
export type LinkedTrimStage = LinkedEditStage;

type LinkedEditFailureKind = "scope" | "time" | "unsupported" | "result" | "limit";

function linkedEditRequestKind(request: LinkedEditRequest) {
  return "kind" in request ? request.kind : "linked-trim";
}

function isLinkedRippleDeleteRequest(request: LinkedEditRequest): request is LinkedRippleDeleteRequest {
  return "kind" in request && request.kind === "linked-ripple-delete";
}

function linkedEditLabel(request: LinkedEditRequest) {
  return linkedEditRequestKind(request) === "linked-ripple-delete" ? "LinkedRippleDelete" : "LinkedTrim";
}

function linkedEditFail(request: LinkedEditRequest, failure: LinkedEditFailureKind, message: string, requestIndex?: number): never {
  if (linkedEditRequestKind(request) === "linked-ripple-delete") {
    const codes: Record<LinkedEditFailureKind, LinkedRippleDeleteDiagnosticCode> = {
      scope: "CUT_LINKED_RIPPLE_SCOPE",
      time: "CUT_LINKED_RIPPLE_TIME",
      unsupported: "CUT_LINKED_RIPPLE_UNSUPPORTED",
      result: "CUT_LINKED_RIPPLE_RESULT",
      limit: "CUT_LINKED_RIPPLE_LIMIT",
    };
    throw new LinkedRippleDeleteError(codes[failure], message, requestIndex);
  }
  const codes: Record<LinkedEditFailureKind, LinkedTrimDiagnosticCode> = {
    scope: "CUT_LINKED_TRIM_SCOPE",
    time: "CUT_LINKED_TRIM_TIME",
    unsupported: "CUT_LINKED_TRIM_UNSUPPORTED",
    result: "CUT_LINKED_TRIM_RESULT",
    limit: "CUT_LINKED_TRIM_LIMIT",
  };
  throw new LinkedTrimError(codes[failure], message, requestIndex);
}

function linkedTrimIntervalEnd(interval: IREditorialInterval) {
  return addRational(interval.start, interval.duration);
}

function linkedTrimContainsProperly(container: IREditorialInterval, keep: IREditorialInterval) {
  const containerEnd = linkedTrimIntervalEnd(container), keepEnd = linkedTrimIntervalEnd(keep);
  return compareRational(keep.duration, zeroRational) > 0
    && compareRational(keep.start, container.start) >= 0
    && compareRational(keepEnd, containerEnd) <= 0
    && (compareRational(keep.start, container.start) !== 0 || compareRational(keepEnd, containerEnd) !== 0);
}

function linkedRippleContainsStrictly(container: IREditorialInterval, range: IREditorialInterval) {
  const containerEnd = linkedTrimIntervalEnd(container), rangeEnd = linkedTrimIntervalEnd(range);
  return compareRational(range.duration, zeroRational) > 0
    && compareRational(range.start, container.start) > 0
    && compareRational(rangeEnd, containerEnd) < 0;
}

function sameEditorialInterval(left: IREditorialInterval, right: IREditorialInterval) {
  return compareRational(left.start, right.start) === 0 && compareRational(left.duration, right.duration) === 0;
}

function stagedPictureLinkedEdit(
  track: IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> },
  plan: IRPictureTrackOperationPlan,
  execution: IRPictureTrackExecution,
): LinkedEditTrackStage {
  const children: string[] = [];
  const items: Extract<IREditorial, { kind: "picture-track" }>["items"] = [];
  const nodes: IRNode[] = [];
  for (const [index, item] of execution.items.entries()) {
    const id = pictureEditMaterializedNodeId(track.id, index, item);
    const destination = { start: addRational(track.interval.start, item.destination.start), duration: item.destination.duration };
    const node: IRNode = {
      id,
      op: item.kind === "picture" ? "cut.edit.picture_clip" : "cut.edit.gap",
      domain: "visual",
      ownership: "child",
      ...(track.sceneId ? { sceneId: track.sceneId } : {}),
      interval: destination,
      inputs: { ...item.inputs },
      children: [],
      properties: {},
      effects: ["pure"],
      contentHash: "",
      provenance: item.provenance,
    };
    node.contentHash = hash({ ...node, contentHash: undefined });
    nodes.push(node);
    children.push(id);
    items.push({
      nodeId: id,
      order: index,
      kind: item.kind,
      destination,
      ...(item.source ? { source: item.source } : {}),
      ...(item.timeMap ? { timeMap: item.timeMap } : {}),
      ...(item.inputs.link?.kind === "string" ? { linkId: item.inputs.link.value } : {}),
      ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}),
    });
  }
  if (execution.transitions.length) throw new PictureEditOperationError("unsupported", `Linked edit internal picture materialization for ${track.id} unexpectedly produced transitions.`);
  return {
    trackId: track.id,
    removeNodeIds: [...track.children],
    nodes,
    children,
    editorial: { kind: "picture-track", items, operationPlan: plan },
  };
}

function stagedAudioLinkedEdit(
  track: IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> },
  plan: AudioEditOperationPlan,
  execution: AudioEditExecution,
): LinkedEditTrackStage {
  const children: string[] = [];
  const items: Extract<IREditorial, { kind: "audio-track" }>["items"] = [];
  const nodes: IRNode[] = [];
  for (const [index, item] of execution.items.entries()) {
    const id = audioEditMaterializedNodeId(track.id, index, item);
    const destination = { start: addRational(track.interval.start, item.destination.start), duration: item.destination.duration };
    const inputs: Record<string, IRValue> = item.kind === "clip"
      ? {
          source: { kind: "resource-ref", id: item.inputs.resourceId },
          range: audioEditRangeValue(item.source),
          destination: audioEditRangeValue(item.destination),
          ...(item.inputs.linkId ? { link: { kind: "string", value: item.inputs.linkId } as IRValue } : {}),
          ...(item.inputs.headHandle ? { headHandle: audioEditTimeValue(item.inputs.headHandle) } : {}),
          ...(item.inputs.tailHandle ? { tailHandle: audioEditTimeValue(item.inputs.tailHandle) } : {}),
        }
      : { destination: audioEditRangeValue(item.destination) };
    const node: IRNode = {
      id,
      op: item.kind === "clip" ? "cut.audio.clip" : "cut.edit.audio_gap",
      domain: "audio",
      ownership: "child",
      ...(track.sceneId ? { sceneId: track.sceneId } : {}),
      interval: destination,
      inputs,
      children: [],
      properties: {},
      effects: ["pure"],
      contentHash: "",
      provenance: item.provenance,
    };
    node.contentHash = hash({ ...node, contentHash: undefined });
    nodes.push(node);
    children.push(id);
    items.push({
      nodeId: id,
      order: index,
      kind: item.kind === "clip" ? "audio" : "gap",
      destination,
      ...(item.kind === "clip" ? { source: item.source } : {}),
      ...(item.kind === "clip" && item.inputs.linkId ? { linkId: item.inputs.linkId } : {}),
      ...(item.kind === "clip" && item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}),
    });
  }
  if (execution.transitions.length) throw new AudioEditOperationError("unsupported", `Linked edit internal audio materialization for ${track.id} unexpectedly produced transitions.`, "$.transitions");
  return {
    trackId: track.id,
    removeNodeIds: [...track.children],
    nodes,
    children,
    editorial: { kind: "audio-track", items, operationPlan: plan },
  };
}

/**
 * Pure transaction planner used by compilation and hostile atomicity tests.
 * It never mutates `ir`; every track result is materialized before callers may
 * commit any node, track, or linkedEdits change.
 */
export function stageLinkedEditTransactions(ir: CutAVIR, requests: readonly LinkedEditRequest[]): LinkedEditStage {
  if (!requests.length) return { linkedEdits: [], tracks: [] };
  if (requests.length > 256) linkedEditFail(requests[0], "limit", "CUT permits at most 256 linked editorial transactions per compilation unit.");

  type PictureGroup = {
    track: IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
    plan: IRPictureTrackOperationPlan;
  };
  type AudioGroup = {
    track: IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };
    plan: AudioEditOperationPlanV1;
  };
  const pictureGroups = new Map<string, PictureGroup>();
  const audioGroups = new Map<string, AudioGroup>();
  const linkedEdits: IRLinkedEdit[] = [];
  const seenIds = new Set<string>(), seenGroups = new Set<string>();
  const ripplePictureTracks = new Set<string>(), rippleAudioTracks = new Set<string>();
  const sortedNodes = Object.values(ir.nodes).sort((left, right) => left.id.localeCompare(right.id));

  for (const [requestIndex, request] of requests.entries()) {
    const isRippleDelete = isLinkedRippleDeleteRequest(request);
    const partialRippleRange = isRippleDelete ? request.range : undefined;
    const label = linkedEditLabel(request);
    if (seenIds.has(request.id)) linkedEditFail(request, "result", `${label} transaction id ${request.id} is duplicated.`, requestIndex);
    seenIds.add(request.id);
    const groupKey = `${request.compositionId}\0${request.sceneId}\0${request.linkId}`;
    if (seenGroups.has(groupKey)) linkedEditFail(request, "result", `Editorial link ${JSON.stringify(request.linkId)} has more than one linked transaction in the same scene.`, requestIndex);
    seenGroups.add(groupKey);
    const composition = ir.compositions.find((candidate) => candidate.id === request.compositionId);
    if (!composition || !composition.sceneIds.includes(request.sceneId) || !ir.scenes[request.sceneId]) {
      linkedEditFail(request, "scope", `${label} transaction ${request.id} does not belong to an existing scene of composition ${request.compositionId}.`, requestIndex);
    }

    const pictureMembers: Array<{ track: PictureGroup["track"]; item: Extract<IREditorial, { kind: "picture-track" }>["items"][number] }> = [];
    const audioMembers: Array<{ track: AudioGroup["track"]; item: Extract<IREditorial, { kind: "audio-track" }>["items"][number] }> = [];
    for (const candidate of sortedNodes) {
      if (candidate.sceneId !== request.sceneId || !candidate.editorial) continue;
      if (candidate.editorial.kind === "picture-track") {
        for (const item of candidate.editorial.items) if (item.linkId === request.linkId) pictureMembers.push({ track: candidate as PictureGroup["track"], item });
      } else if (candidate.editorial.kind === "audio-track") {
        for (const item of candidate.editorial.items) if (item.linkId === request.linkId) audioMembers.push({ track: candidate as AudioGroup["track"], item });
      }
    }
    if (pictureMembers.length !== 1 || audioMembers.length !== 1) {
      linkedEditFail(
        request,
        "result",
        `${label} link ${JSON.stringify(request.linkId)} must resolve to exactly one direct PictureClip and one direct AudioClip in scene ${request.sceneId}; found ${pictureMembers.length} picture and ${audioMembers.length} audio members.`,
        requestIndex,
      );
    }
    const pictureMember = pictureMembers[0], audioMember = audioMembers[0];
    if (audioMember.item.sourceNodeId !== undefined) {
      linkedEditFail(request, "unsupported", `${label} does not yet slice or rebase processed AudioRegion graphs; author the processed take after the linked structural edit or use a direct AudioClip.`, requestIndex);
    }
    if (pictureMember.track.editorial.operationPlan || pictureMember.track.editorial.transitions?.length
      || audioMember.track.editorial.operationPlan || audioMember.track.editorial.transitions?.length) {
      linkedEditFail(request, "unsupported", `${label} currently requires direct, non-overlapping source tracks without a pre-existing edit plan or transition window.`, requestIndex);
    }
    if (!isRippleDelete && (!linkedTrimContainsProperly(pictureMember.item.destination, request.keep)
      || !linkedTrimContainsProperly(audioMember.item.destination, request.keep))) {
      linkedEditFail(request, "time", "LinkedTrim keep must be one positive proper destination subrange contained by both linked members.", requestIndex);
    }
    if (isRippleDelete && partialRippleRange
      && (!linkedRippleContainsStrictly(pictureMember.item.destination, partialRippleRange)
        || !linkedRippleContainsStrictly(audioMember.item.destination, partialRippleRange))) {
      linkedEditFail(request, "time", "LinkedRippleDelete range must be one positive strict interior scene-local subrange of both direct linked members, leaving positive before/after picture and audio fragments.", requestIndex);
    }
    if (isRippleDelete && !partialRippleRange && !sameEditorialInterval(pictureMember.item.destination, audioMember.item.destination)) {
      linkedEditFail(request, "time", "LinkedRippleDelete requires the complete linked PictureClip and AudioClip to have one identical scene-local destination interval; asymmetric J/L ranges require a later explicit policy.", requestIndex);
    }
    if (partialRippleRange) {
      const pictureNode = ir.nodes[pictureMember.item.nodeId], audioNode = ir.nodes[audioMember.item.nodeId];
      if (!pictureNode || !audioNode) linkedEditFail(request, "result", "LinkedRippleDelete(range:) operands must reference their direct materialized child nodes.", requestIndex);
      const nonNeutralTime = (node: IRNode, name: string) => {
        const value = valueRational(node.inputs[name], "time");
        return value !== undefined && compareRational(value, zeroRational) !== 0;
      };
      const pictureForwardOne = !pictureMember.item.timeMap
        || (pictureMember.item.timeMap.kind === "constant"
          && pictureMember.item.timeMap.direction === "forward"
          && compareRational(pictureMember.item.timeMap.rate, rational(1)) === 0);
      if (!pictureForwardOne
        || !pictureMember.item.source
        || compareRational(pictureMember.item.source.duration, pictureMember.item.destination.duration) !== 0
        || !isNeutralLinkedRipplePictureInputs(pictureNode.inputs)
        || Object.keys(pictureNode.properties).length !== 0) {
        linkedEditFail(request, "unsupported", "LinkedRippleDelete(range:) v2 accepts only direct neutral forward-1x PictureClip operands without transforms, opacity treatment, animated properties, source handles, freeze, reverse, constant retime, or speed ramps.", requestIndex);
      }
      if (!audioMember.item.source
        || compareRational(audioMember.item.source.duration, audioMember.item.destination.duration) !== 0
        || nonNeutralTime(audioNode, "fadeIn")
        || nonNeutralTime(audioNode, "fadeOut")
        || nonNeutralTime(audioNode, "headHandle")
        || nonNeutralTime(audioNode, "tailHandle")
        || nonNeutralTime(audioNode, "overlap")) {
        linkedEditFail(request, "unsupported", "LinkedRippleDelete(range:) v2 accepts only direct neutral forward-1x AudioClip operands without fades, handles, overlap, processing, or retiming.", requestIndex);
      }
      if (pictureMember.item.linkSegmentId || audioMember.item.linkSegmentId) {
        linkedEditFail(request, "unsupported", "LinkedRippleDelete(range:) v2 cannot re-split an already segmented linked survivor.", requestIndex);
      }
    }
    if (isRippleDelete
      && (pictureGroups.has(pictureMember.track.id) || audioGroups.has(audioMember.track.id))) {
      linkedEditFail(request, "unsupported", "LinkedRippleDelete permits only one linked transaction on each affected picture/audio track; mixed or repeated same-track transactions require explicit coordinate rebasing.", requestIndex);
    }
    if (!isRippleDelete
      && (ripplePictureTracks.has(pictureMember.track.id) || rippleAudioTracks.has(audioMember.track.id))) {
      linkedEditFail(request, "unsupported", "LinkedTrim cannot share a track with LinkedRippleDelete because mixed transaction coordinates are not yet rebased.", requestIndex);
    }

    let pictureGroup = pictureGroups.get(pictureMember.track.id);
    if (!pictureGroup) {
      const baseItems = pictureMember.track.editorial.items.map((item, index) => {
        const node = ir.nodes[item.nodeId];
        if (!node) linkedEditFail(request, "result", `PictureTrack ${pictureMember.track.id} references missing child ${item.nodeId}.`, requestIndex);
        return relativePictureEditBaseItem(item, node!, pictureMember.track.interval.start, index);
      });
      pictureGroup = { track: pictureMember.track, plan: { version: 1, sourceDuration: pictureMember.track.interval.duration, baseItems, operations: [] } };
      pictureGroups.set(pictureMember.track.id, pictureGroup);
    }
    let audioGroup = audioGroups.get(audioMember.track.id);
    if (!audioGroup) {
      let baseItems: AudioEditItem[];
      try {
        baseItems = audioMember.track.editorial.items.map((item, index) => {
          const node = ir.nodes[item.nodeId];
          if (!node) linkedEditFail(request, "result", `AudioTrack ${audioMember.track.id} references missing child ${item.nodeId}.`, requestIndex);
          return relativeAudioEditBaseItem(item, node!, audioMember.track.interval.start, index);
        });
      } catch (error) {
        if (!(error instanceof AudioEditOperationError)) throw error;
        linkedEditFail(request, "unsupported", error.message, requestIndex);
      }
      audioGroup = { track: audioMember.track, plan: { version: 1, sourceDuration: audioMember.track.interval.duration, baseItems, operations: [] } };
      audioGroups.set(audioMember.track.id, audioGroup);
    }
    if (!isRippleDelete) {
      const pictureKeep = { start: subtractRational(request.keep.start, pictureMember.track.interval.start), duration: request.keep.duration };
      const audioKeep = { start: subtractRational(request.keep.start, audioMember.track.interval.start), duration: request.keep.duration };
      pictureGroup.plan.operations.push({ kind: "trim", keep: pictureKeep, transactionId: request.id, provenance: request.provenance });
      audioGroup.plan.operations.push({ kind: "trim", keep: audioKeep, transactionId: request.id, provenance: request.provenance });
      linkedEdits.push({
        id: request.id,
        version: 1,
        kind: "linked-trim",
        compositionId: request.compositionId,
        sceneId: request.sceneId,
        linkId: request.linkId,
        keep: request.keep,
        pictureTrackId: pictureMember.track.id,
        audioTrackId: audioMember.track.id,
        provenance: request.provenance,
      });
    } else {
      const range = request.range ?? pictureMember.item.destination;
      const segmentIds = request.range ? linkedRippleSegmentIds(request.id) : undefined;
      const pictureRange = { start: subtractRational(range.start, pictureMember.track.interval.start), duration: range.duration };
      const audioRange = { start: subtractRational(range.start, audioMember.track.interval.start), duration: range.duration };
      const pictureInsertIndex = pictureGroup.plan.operations.length;
      pictureGroup.plan.operations.push({
        kind: "ripple-insert",
        at: pictureGroup.plan.sourceDuration,
        item: {
          origin: `operation:${pictureInsertIndex}`,
          kind: "gap",
          destination: { start: zeroRational, duration: range.duration },
          inputs: { duration: audioEditTimeValue(range.duration) },
          provenance: request.provenance,
        },
        transactionId: request.id,
        provenance: request.provenance,
      });
      pictureGroup.plan.operations.push({ kind: "ripple-delete", range: pictureRange, transactionId: request.id, transactionVersion: segmentIds ? 2 : 1, ...(segmentIds ? { linkSegmentIds: { ...segmentIds } } : {}), provenance: request.provenance });
      const audioInsertIndex = audioGroup.plan.operations.length;
      audioGroup.plan.operations.push({
        kind: "ripple-insert",
        at: audioGroup.plan.sourceDuration,
        item: {
          origin: `operation:${audioInsertIndex}`,
          kind: "gap",
          destination: { start: zeroRational, duration: range.duration },
          inputs: {},
          provenance: request.provenance,
        },
        transactionId: request.id,
        provenance: request.provenance,
      });
      audioGroup.plan.operations.push({ kind: "ripple-delete", range: audioRange, transactionId: request.id, transactionVersion: segmentIds ? 2 : 1, ...(segmentIds ? { linkSegmentIds: { ...segmentIds } } : {}), provenance: request.provenance });
      ripplePictureTracks.add(pictureMember.track.id);
      rippleAudioTracks.add(audioMember.track.id);
      linkedEdits.push(segmentIds ? {
        id: request.id,
        version: 2,
        kind: "linked-ripple-delete",
        compositionId: request.compositionId,
        sceneId: request.sceneId,
        linkId: request.linkId,
        range,
        linkSegmentIds: { ...segmentIds },
        pictureTrackId: pictureMember.track.id,
        audioTrackId: audioMember.track.id,
        provenance: request.provenance,
      } : {
        id: request.id,
        version: 1,
        kind: "linked-ripple-delete",
        compositionId: request.compositionId,
        sceneId: request.sceneId,
        linkId: request.linkId,
        range,
        pictureTrackId: pictureMember.track.id,
        audioTrackId: audioMember.track.id,
        provenance: request.provenance,
      });
    }
  }

  const tracks: LinkedEditTrackStage[] = [];
  for (const group of [...pictureGroups.values()].sort((left, right) => left.track.id.localeCompare(right.track.id))) {
    try {
      tracks.push(stagedPictureLinkedEdit(group.track, group.plan, executePictureTrackOperationPlan(group.plan)));
    } catch (error) {
      if (!(error instanceof PictureEditOperationError)) throw error;
      const operation = group.plan.operations[error.operationIndex ?? -1];
      const requestIndex = operation && "transactionId" in operation && operation.transactionId
        ? requests.findIndex((request) => request.id === operation.transactionId)
        : undefined;
      const request = requests[requestIndex ?? 0];
      linkedEditFail(request, error.kind === "unsupported" ? "unsupported" : error.kind === "time" ? "time" : "result", error.message, requestIndex);
    }
  }
  for (const group of [...audioGroups.values()].sort((left, right) => left.track.id.localeCompare(right.track.id))) {
    try {
      tracks.push(stagedAudioLinkedEdit(group.track, group.plan, executeAudioEditOperationPlan(group.plan)));
    } catch (error) {
      if (!(error instanceof AudioEditOperationError)) throw error;
      const operation = group.plan.operations[error.operationIndex ?? -1];
      const requestIndex = operation && "transactionId" in operation && operation.transactionId
        ? requests.findIndex((request) => request.id === operation.transactionId)
        : undefined;
      const request = requests[requestIndex ?? 0];
      linkedEditFail(request, error.kind === "unsupported" ? "unsupported" : error.kind === "time" ? "time" : error.kind === "limit" ? "limit" : "result", error.message, requestIndex);
    }
  }
  return { linkedEdits, tracks };
}

export function stageLinkedTrimTransactions(ir: CutAVIR, requests: readonly LinkedTrimRequest[]): LinkedTrimStage {
  return stageLinkedEditTransactions(ir, requests);
}

export function stageLinkedRippleDeleteTransactions(ir: CutAVIR, requests: readonly LinkedRippleDeleteRequest[]): LinkedEditStage {
  return stageLinkedEditTransactions(ir, requests);
}

function commitLinkedEditStage(context: LowerContext, stage: LinkedEditStage) {
  if (!stage.linkedEdits.length) return;
  const removeNodeIds = new Set(stage.tracks.flatMap((track) => track.removeNodeIds));
  const additions = new Map<string, IRNode>();
  for (const track of stage.tracks) {
    for (const node of track.nodes) {
      if (additions.has(node.id) || (context.ir.nodes[node.id] && !removeNodeIds.has(node.id))) {
        const transaction = stage.linkedEdits[0];
        linkedEditCompileError(context, node.provenance.span, transaction.kind === "linked-ripple-delete" ? "CUT_LINKED_RIPPLE_RESULT" : "CUT_LINKED_TRIM_RESULT", `Linked edit materialization collided with existing node ${node.id}.`);
      }
      additions.set(node.id, node);
    }
  }
  const extraNodes = stage.tracks.reduce((total, track) => total + Math.max(0, track.nodes.length - track.removeNodeIds.length), 0);
  if (context.budget.nodes + extraNodes > context.budget.limits.maxNodes) {
    const transaction = stage.linkedEdits[0];
    linkedEditCompileError(context, transaction.provenance.span, transaction.kind === "linked-ripple-delete" ? "CUT_LINKED_RIPPLE_LIMIT" : "CUT_LINKED_TRIM_LIMIT", `Linked edit materialization exceeds maxNodes=${context.budget.limits.maxNodes}.`);
  }
  // Everything above is pure/preflight. The commit below cannot fail under the
  // validated closed stage, so no observer can see only one half of a linked edit.
  context.budget.nodes += extraNodes;
  for (const id of removeNodeIds) delete context.ir.nodes[id];
  for (const node of additions.values()) context.ir.nodes[node.id] = node;
  for (const patch of stage.tracks) {
    const track = context.ir.nodes[patch.trackId];
    if (!track) throw new Error(`Linked edit commit lost owning track ${patch.trackId}.`);
    track.children = patch.children;
    track.editorial = patch.editorial;
    track.contentHash = hash({ ...track, contentHash: undefined });
  }
  context.ir.linkedEdits = stage.linkedEdits;
}

function lowerAudioTrackChildren(
  statements: Statement[],
  context: LowerContext,
  span: SourceSpan,
  operation?: { trackId: string; inputs: Record<string, IRValue>; finalDuration: Rational; spans: SourceSpan[] },
): { children: string[]; editorial: IREditorial } {
  const children: string[] = [];
  const items: Extract<IREditorial, { kind: "audio-track" }>["items"] = [];
  let coverageEnd = context.localTime;
  let previousStart = context.localTime;
  let latestGapEnd = context.localTime;
  const trackEnd = addRational(context.localTime, context.duration);
  const regionChains = new Map<string, { sourceNode: IRNode; processorNodeIds: string[]; timeStretchNode?: IRNode }>();
  for (const statement of statements) {
    consumeBudget(context, "statements");
    if (statement.kind !== "node") editorialCompileError(context, statement.span, "CUT2076", "AudioTrack bodies may contain only direct AudioClip, AudioRegion, or AudioGap nodes.");
    const lowered = lowerNode(statement, { ...context, bindings: new Map(context.bindings) });
    const child = context.ir.nodes[lowered.id];
    const kind = child.op === "cut.audio.clip" || child.op === "cut.edit.audio_region" ? "audio" : child.op === "cut.edit.audio_gap" ? "gap" : undefined;
    if (!kind || child.domain !== "audio") {
      editorialCompileError(context, statement.span, "CUT2076", "AudioTrack bodies may contain only direct audio AudioClip, AudioRegion, or AudioGap nodes.");
    }
    const regionChain = child.op === "cut.edit.audio_region" ? compiledAudioRegionChain(context, child, statement.span) : undefined;
    if (regionChain) regionChains.set(child.id, regionChain);
    const sourceNode = regionChain?.sourceNode ?? child;
    const sourceInterval = kind === "audio"
      ? audioSourceInterval(sourceNode.inputs, child.interval, context, statement.span, Boolean(regionChain?.timeStretchNode))
      : undefined;
    if (regionChain?.timeStretchNode) {
      const stretch = regionChain.timeStretchNode;
      const sourceDuration = valueRational(stretch.inputs.sourceDuration, "time");
      const destinationDuration = valueRational(stretch.inputs.duration, "time");
      if (!sourceDuration || !destinationDuration
        || !sourceInterval
        || compareRational(sourceDuration, sourceInterval.duration) !== 0
        || compareRational(destinationDuration, child.interval.duration) !== 0) {
        editorialCompileError(
          context,
          stretch.provenance.span,
          "CUT_AUDIO_REGION_RETIME_PLAN",
          "AudioRegion TimeStretch.sourceDuration must exactly equal the AudioClip source-range duration and TimeStretch.duration must exactly equal the outer destination duration.",
        );
      }
      exactAudioSample(context, stretch.provenance.span, sourceDuration, "AudioRegion TimeStretch sourceDuration");
      exactAudioSample(context, stretch.provenance.span, destinationDuration, "AudioRegion TimeStretch duration");
      const handle = (["headHandle", "tailHandle"] as const).find((name) => child.inputs[name] !== undefined);
      if (handle) {
        if (regionChain.processorNodeIds.at(-1) !== stretch.id
          || stretch.children[0] !== sourceNode.id) {
          editorialCompileError(
            context,
            stretch.provenance.span,
            "CUT_AUDIO_REGION_RETIME_TOPOLOGY",
            "AudioRegion TimeStretch with source-clock handles must be the innermost processor directly above its AudioClip; outer static inserts remain supported.",
          );
        }
        validateAudioTrackHandles(child.inputs, context, child.provenance.span);
      }
      const automated = [sourceNode, ...regionChain.processorNodeIds.map((id) => context.ir.nodes[id])]
        .find((node) => node && Object.keys(node.properties).length > 0);
      if (automated) {
        editorialCompileError(context, automated.provenance.span, "CUT_AUDIO_REGION_RETIME_AUTOMATION", "AudioRegion TimeStretch chains must be fully static because source-clock versus destination-clock automation mapping is not defined.");
      }
    }
    const childEnd = addRational(child.interval.start, child.interval.duration);
    if (compareRational(child.interval.start, previousStart) < 0) {
      editorialCompileError(context, statement.span, "CUT2074", "AudioTrack item destination starts must be in nondecreasing temporal source order.");
    }
    if (compareRational(child.interval.start, coverageEnd) > 0) {
      editorialCompileError(context, statement.span, "CUT2074", "AudioTrack contains an uncovered destination interval; author an exact AudioGap for intentional silence.");
    }
    if (kind === "gap" && compareRational(child.interval.start, coverageEnd) !== 0) {
      editorialCompileError(context, statement.span, "CUT2074", "AudioGap cannot overlap audio or another gap and must begin at the current coverage boundary.");
    }
    if (kind === "audio" && compareRational(child.interval.start, latestGapEnd) < 0) {
      editorialCompileError(context, statement.span, "CUT2074", "AudioClip cannot overlap an explicit AudioGap interval.");
    }
    child.ownership = "child";
    children.push(child.id);
    const linkId = kind === "audio" ? editorialLinkId(child.inputs, context, statement.span) : undefined;
    const authored = context.editorialAuthoringIds.get(child.id);
    const editId = authored?.editId;
    if (kind === "audio") {
      validateAudioTrackFades(sourceNode.inputs, sourceInterval!, context, statement.span);
      if (child.op === "cut.audio.clip") validateAudioTrackHandles(sourceNode.inputs, context, statement.span);
    }
    items.push({
      nodeId: child.id,
      ...(child.op === "cut.edit.audio_region" ? { sourceNodeId: sourceNode.id } : {}),
      order: items.length,
      kind,
      destination: child.interval,
      ...(kind === "audio" ? {
        source: sourceInterval!,
        ...(linkId ? { linkId } : {}),
        ...(editId ? { editId } : {}),
        ...(authored?.role ? { role: authored.role } : {}),
        ...(authored?.metadata ? { metadata: { ...authored.metadata } } : {}),
      } : {}),
    });
    previousStart = child.interval.start;
    if (compareRational(childEnd, coverageEnd) > 0) coverageEnd = childEnd;
    if (kind === "gap") latestGapEnd = childEnd;
  }
  if (!children.length) editorialCompileError(context, span, "CUT2076", "AudioTrack requires at least one AudioClip, AudioRegion, or AudioGap.");
  if (compareRational(coverageEnd, trackEnd) !== 0) {
    editorialCompileError(context, span, "CUT2074", "AudioTrack item coverage must fill the owning interval exactly; author an explicit AudioGap for intentional silence.");
  }
  if (operation) {
    const retimedRegion = items.map((item) => regionChains.get(item.nodeId)?.timeStretchNode).find((node): node is IRNode => Boolean(node));
    if (retimedRegion) {
      editorialCompileError(
        context,
        retimedRegion.provenance.span,
        "CUT_AUDIO_REGION_RETIME_PLAN",
        "AudioRegion TimeStretch is a closed manual-track item and cannot participate in AudioTrack structural edits or audioCrossfadeAt.",
      );
    }
    const provenances = operation.spans.map((operationSpan) => provenance(context.moduleName, operationSpan, "AudioTrack edit", context.expansion));
    try {
      const operations = audioEditOperationsFromInput(operation.inputs.edits, provenances);
      const processedIndex = items.findIndex((item) => item.sourceNodeId !== undefined);
      if (processedIndex >= 0) {
        const mixedIndex = items.findIndex((item) => item.sourceNodeId === undefined);
        if (mixedIndex >= 0) {
          throw new AudioEditOperationError(
            "region-topology",
            "Processed AudioRegion crossfades require a closed track made only of adjacent AudioRegion items; direct AudioClip and AudioGap items cannot be mixed into that plan.",
            `$.baseItems[${mixedIndex}]`,
          );
        }
        const structuralIndex = operations.findIndex((edit) => edit.kind !== "crossfade");
        if (structuralIndex >= 0) {
          throw new AudioEditOperationError(
            "region-plan",
            "Processed AudioRegion plans are transition-only and cannot contain structural edit operations.",
            `$.operations[${structuralIndex}]`,
            structuralIndex,
          );
        }
        const baseItems = items.map((item, index) => {
          const region = context.ir.nodes[item.nodeId];
          const chain = regionChains.get(item.nodeId);
          if (!region || region.op !== "cut.edit.audio_region" || !chain || item.sourceNodeId !== chain.sourceNode.id) {
            throw new AudioEditOperationError("region-plan", "AudioRegion editorial identity disagrees with its closed source/processor chain.", `$.baseItems[${index}]`);
          }
          const automated = [chain.sourceNode, ...chain.processorNodeIds.map((id) => context.ir.nodes[id])]
            .find((node) => node && Object.keys(node.properties).length > 0);
          if (automated) {
            throw new AudioEditOperationError(
              "region-automation",
              `AudioRegion crossfade processor/source ${automated.id} must be static; property automation is not supported in a transition window.`,
              `$.baseItems[${index}].processorNodeIds`,
            );
          }
          for (const name of ["fadeIn", "fadeOut"] as const) {
            const value = chain.sourceNode.inputs[name];
            if (value === undefined) continue;
            const amount = valueRational(value, "time");
            if (!amount || compareRational(amount, zeroRational) !== 0) {
              throw new AudioEditOperationError(
                "region-plan",
                `AudioRegion crossfade source leaves require an exact zero ${name}; the transition envelope exclusively owns the overlap gain.`,
                `$.baseItems[${index}].sourceNodeId`,
              );
            }
          }
          for (const name of ["headHandle", "tailHandle"] as const) {
            const value = region.inputs[name];
            if (value === undefined) continue;
            const amount = valueRational(value, "time");
            if (!amount || compareRational(amount, zeroRational) < 0) {
              throw new AudioEditOperationError("region-handle", `AudioRegion ${name} must be a non-negative exact Time.`, `$.baseItems[${index}].inputs.${name}`);
            }
          }
          return relativeAudioEditRegionBaseItem(item, region, chain.sourceNode, chain.processorNodeIds, context.localTime, index);
        });
        const plan: AudioEditOperationPlanV2 = {
          version: 2,
          sourceDuration: context.duration,
          baseItems,
          operations: operations as AudioEditOperationPlanV2["operations"],
        };
        const trackPlacement = addRational(context.scene?.start ?? zeroRational, context.localTime);
        exactAudioEditSample(context, span, trackPlacement, "AudioTrack edit placement");
        exactAudioEditSample(context, span, context.duration, "AudioTrack edit sourceDuration");
        for (const [index, edit] of plan.operations.entries()) {
          const durationSamples = multiplyRational(edit.duration, rational(context.timeline.sampleRate));
          if (durationSamples.denominator !== "1" || BigInt(durationSamples.numerator) < 2n || BigInt(durationSamples.numerator) % 2n !== 0n) {
            throw new AudioEditOperationError(
              "region-handle",
              "Processed AudioRegion crossfade duration must span an even integer number of at least two destination samples so its centered handles are exact.",
              `$.operations[${index}].duration`,
              index,
            );
          }
          const cutSamples = multiplyRational(edit.at, rational(context.timeline.sampleRate));
          if (cutSamples.denominator !== "1") {
            throw new AudioEditOperationError("region-topology", `audioCrossfadeAt cut does not land on the ${context.timeline.sampleRate} Hz destination sample grid.`, `$.operations[${index}].at`, index);
          }
        }
        const execution = executeAudioEditOperationPlan(plan);
        if (compareRational(execution.duration, operation.finalDuration) !== 0) {
          throw new AudioEditOperationError("region-plan", `AudioRegion crossfades preserve ${execution.duration.numerator}/${execution.duration.denominator}s, but the owning interval requires exactly ${operation.finalDuration.numerator}/${operation.finalDuration.denominator}s.`);
        }
        delete operation.inputs.sourceDuration;
        delete operation.inputs.edits;
        return encodeAudioRegionCrossfades(context.localTime, children, items, plan, execution);
      }
      const baseItems = items.map((item, index) => relativeAudioEditBaseItem(item, context.ir.nodes[item.nodeId], context.localTime, index));
      const linkedOperationIndex = baseItems.some((item) => item.kind === "clip" && item.inputs.linkId) ? 0 : -1;
      if (linkedOperationIndex >= 0) {
        throw new AudioEditOperationError("unsupported", "AudioTrack edit plans do not yet couple linked picture; remove link: or author picture/audio endpoints independently.", `$.operations[${linkedOperationIndex}]`, linkedOperationIndex);
      }
      const plan: AudioEditOperationPlanV1 = { version: 1, sourceDuration: context.duration, baseItems, operations };
      const trackPlacement = addRational(context.scene?.start ?? zeroRational, context.localTime);
      exactAudioEditSample(context, span, trackPlacement, "AudioTrack edit placement");
      exactAudioEditSample(context, span, context.duration, "AudioTrack edit sourceDuration");
      for (const [index, edit] of operations.entries()) {
        const operationSpan = operation.spans[index] ?? span;
        if (edit.kind === "crossfade") {
          const samples = multiplyRational(edit.duration, rational(context.timeline.sampleRate));
          if (samples.denominator !== "1" || BigInt(samples.numerator) < 2n || BigInt(samples.numerator) % 2n !== 0n) {
            throw new AudioEditOperationError("time", "audioCrossfadeAt duration must span an even integer number of at least two destination samples so its centered half-handles are exact.", `$.operations[${index}].duration`, index);
          }
        }
        for (const time of audioEditTimes(edit)) exactAudioEditSample(context, operationSpan, time.value, time.label);
        if ("item" in edit && edit.item.kind === "clip" && context.ir.resources[edit.item.inputs.resourceId]?.kind !== "audio") {
          throw new AudioEditOperationError("shape", "editAudio source must resolve to a declared AudioAsset.", `$.operations[${index}].item.inputs.resourceId`, index);
        }
      }
      const execution = executeAudioEditOperationPlan(plan);
      if (compareRational(execution.duration, operation.finalDuration) !== 0) {
        throw new AudioEditOperationError("result", `AudioTrack edits materialize ${execution.duration.numerator}/${execution.duration.denominator}s, but the owning interval requires exactly ${operation.finalDuration.numerator}/${operation.finalDuration.denominator}s.`);
      }
      delete operation.inputs.sourceDuration;
      delete operation.inputs.edits;
      return materializeAudioEditItems(context, operation.trackId, context.localTime, children, plan, execution);
    } catch (error) {
      if (!(error instanceof AudioEditOperationError)) throw error;
      const baseIndex = /^\$\.baseItems\[(\d+)\]/u.exec(error.path)?.[1];
      const baseSpan = baseIndex === undefined ? undefined : items[Number(baseIndex)]?.nodeId
        ? context.ir.nodes[items[Number(baseIndex)].nodeId]?.provenance.span
        : undefined;
      editorialCompileError(context, operation.spans[error.operationIndex ?? -1] ?? baseSpan ?? span, error.code, error.message);
    }
  }
  return { children, editorial: { kind: "audio-track", items } };
}

function validateEditorialLinks(ir: CutAVIR, check: CheckResult) {
  const sceneOwners = new Map<string, string>();
  for (const composition of ir.compositions) for (const sceneId of composition.sceneIds) sceneOwners.set(sceneId, composition.id);
  const timelineSegmentScopes = new Map<string, string>();
  for (const plan of ir.timelineEdits ?? []) {
    const execution = executeTimelineEditPlan(plan);
    for (const resultTrack of execution.tracks) {
      const owners = Object.values(ir.nodes).filter((node) =>
        node.sceneId === plan.sceneId
        && (node.editorial?.kind === "picture-track" || node.editorial?.kind === "audio-track")
        && node.editorial.trackId === resultTrack.trackId);
      if (owners.length !== 1) continue;
      const owner = owners[0]!;
      const editorial = owner.editorial;
      if (editorial?.kind !== "picture-track"
        && editorial?.kind !== "audio-track") continue;
      const occurrences = new Map<string, number>();
      resultTrack.items.forEach((item, index) => {
        if (!item.linkId) return;
        const occurrence = occurrences.get(item.linkId) ?? 0;
        occurrences.set(item.linkId, occurrence + 1);
        const nodeId = editorial.items[index]?.nodeId;
        if (nodeId) {
          timelineSegmentScopes.set(
            nodeId,
            `timeline-edit:${plan.id}:${item.linkId}:${occurrence}`,
          );
        }
      });
    }
  }
  const groups = new Map<string, { linkId: string; members: Array<{ kind: "picture" | "audio"; node: IRNode }> }>();
  for (const track of Object.values(ir.nodes)) {
    if (!track.editorial || (track.editorial.kind !== "picture-track" && track.editorial.kind !== "audio-track")) continue;
    for (const item of track.editorial.items) {
      if (!item.linkId) continue;
      const node = ir.nodes[item.nodeId];
      if (!node) continue;
      const scope = `${track.sceneId ? sceneOwners.get(track.sceneId) ?? "unknown-composition" : "timeline"}\u0000${track.sceneId ?? "timeline"}\u0000${item.linkId}\u0000${item.linkSegmentId ?? timelineSegmentScopes.get(item.nodeId) ?? "legacy-pair"}`;
      const group = groups.get(scope) ?? { linkId: item.linkId, members: [] };
      const members = group.members;
      members.push({ kind: track.editorial.kind === "picture-track" ? "picture" : "audio", node });
      groups.set(scope, group);
    }
  }
  for (const { linkId, members } of groups.values()) {
    const pictures = members.filter((member) => member.kind === "picture");
    const audio = members.filter((member) => member.kind === "audio");
    const sceneIds = new Set(members.map((member) => member.node.sceneId));
    if (pictures.length === 1 && audio.length === 1 && sceneIds.size === 1 && !sceneIds.has(undefined)) continue;
    check.diagnostics.push({
      severity: "error",
      code: "CUT2081",
      message: `Editorial link “${linkId}” must identify exactly one picture/audio member per legacy or compiler-owned segment identity in the same scene.`,
      span: members[0].node.provenance.span,
    });
  }
  if (hasTypeErrors(check)) throw new CutCompileError(check);
}

function transitionParentInterval(context: LowerContext, children: string[]) {
  if (children.length !== 2) return { start: context.localTime, duration: context.duration };
  const outgoing = context.ir.nodes[children[0]], incoming = context.ir.nodes[children[1]];
  if (!outgoing || !incoming) return { start: context.localTime, duration: context.duration };
  const end = addRational(incoming.interval.start, incoming.interval.duration);
  return { start: outgoing.interval.start, duration: subtractRational(end, outgoing.interval.start) };
}

function validateCompiledTransition(context: LowerContext, node: IRNode, span: SourceSpan) {
  try {
    referenceTransitionContract(context.ir, context.timeline, node);
  } catch (error) {
    if (!(error instanceof ReferenceTransitionContractError)) throw error;
    context.check.diagnostics.push({ severity: "error", code: "CUT2084", message: error.message, span });
    throw new CutCompileError(context.check);
  }
}

function validateCompiledLinkedSplit(context: LowerContext, node: IRNode, span: SourceSpan) {
  try {
    referenceLinkedSplitContract(context.ir, context.timeline, node);
  } catch (error) {
    if (!(error instanceof ReferenceLinkedSplitContractError)) throw error;
    context.check.diagnostics.push({ severity: "error", code: "CUT2094", message: error.message, span });
    throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
  }
}

function validateCompiledNoOpContracts(ir: CutAVIR, check: CheckResult) {
  for (const node of Object.values(ir.nodes)) {
    try {
      validateReferenceNoOpContract(node, ir);
    } catch (error) {
      if (!(error instanceof ReferenceNoOpContractError)) throw error;
      check.diagnostics.push({
        severity: "error",
        code: "CUT2085",
        message: error.message,
        span: node.provenance.span,
      });
      const moduleName = node.provenance.module === "project.cut" ? undefined : node.provenance.module;
      throw new CutCompileError(check, moduleName);
    }
  }
}

function validateCompiledVideoInputColorContracts(ir: CutAVIR, check: CheckResult) {
  const validate = (node: IRNode) => {
    try {
      referenceVideoInputColorDeclaration(node);
    } catch (error) {
      if (!(error instanceof ReferenceColorManagementError)) throw error;
      check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
      throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
    }
  };
  const directVideoOps = new Set(["cut.visual.video", "cut.edit.clip", "cut.edit.picture_clip"]);
  for (const node of Object.values(ir.nodes)) {
    if (directVideoOps.has(node.op)) validate(node);
    if (node.op !== "cut.edit.picture_track" || node.editorial?.kind !== "picture-track") continue;
    const plan = node.editorial.operationPlan;
    if (!plan) continue;
    const items = [
      ...plan.baseItems,
      ...plan.operations.flatMap((operation) => "item" in operation ? [operation.item] : []),
    ];
    for (const item of items) {
      if (item.kind !== "picture") continue;
      validate({ ...node, op: "cut.edit.picture_clip", inputs: item.inputs, provenance: item.provenance });
    }
  }
}

function validateCompiledTraceContracts(ir: CutAVIR, check: CheckResult) {
  for (const node of Object.values(ir.nodes)) {
    try { prepareReferenceTraceNode(node); }
    catch (error) {
      if (!(error instanceof ReferenceTraceError)) throw error;
      check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
      throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
    }
  }
}

function validateCompiledMotionPathContracts(ir: CutAVIR, check: CheckResult) {
  for (const node of Object.values(ir.nodes)) {
    try { validateReferenceMotionPath(ir, node); }
    catch (error) {
      if (!(error instanceof ReferenceMotionPathError)) throw error;
      check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
      throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
    }
  }
}

function validateCompiledMaskContracts(ir: CutAVIR, check: CheckResult) {
  for (const node of Object.values(ir.nodes)) {
    try {
      referenceMaskConfig(ir, node);
    } catch (error) {
      if (!(error instanceof ReferenceMaskError)) throw error;
      check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
      throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
    }
  }
}

function validateCompiledPlanarTrackMatteContracts(ir: CutAVIR, check: CheckResult) {
  for (const node of Object.values(ir.nodes)) {
    try {
      referencePlanarTrackMatteConfig(ir, node);
    } catch (error) {
      if (!(error instanceof ReferencePlanarTrackMatteError)) throw error;
      check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: error.node.provenance.span });
      throw new CutCompileError(check, error.node.provenance.module === "project.cut" ? undefined : error.node.provenance.module);
    }
  }
}

function validateCompiledChromaKeyContracts(ir: CutAVIR, check: CheckResult) {
  const report = (error: ReferenceChromaKeyError): never => {
    const node = error.node;
    check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
    throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
  };
  for (const node of Object.values(ir.nodes)) {
    try { referenceChromaKeyConfig(ir, node); }
    catch (error) {
      if (!(error instanceof ReferenceChromaKeyError)) throw error;
      report(error);
    }
  }
  for (const composition of ir.compositions) {
    try {
      validateReferenceChromaKeyCompositionBudget(
        referenceChromaKeyNodesForComposition(ir, composition),
        composition.width,
        composition.height,
      );
    } catch (error) {
      if (!(error instanceof ReferenceChromaKeyError)) throw error;
      report(error);
    }
  }
}

function validateCompiledClipPathContracts(ir: CutAVIR, check: CheckResult) {
  const groups = new Map<string, { composition: IRComposition; entries: Array<{ node: IRNode; config: ReferenceClipPathConfig }> }>();
  const report = (error: ReferenceClipPathError): never => {
    const node = error.node;
    check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
    throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
  };
  for (const node of Object.values(ir.nodes)) {
    try {
      const config = referenceClipPathConfig(ir, node);
      if (config) {
        const composition = node.sceneId
          ? ir.compositions.find((candidate) => candidate.sceneIds.includes(node.sceneId!))
          : ir.compositions.find((candidate) => candidate.rootVisualIds.includes(node.id));
        if (!composition) {
          throw new ReferenceClipPathError("CUT_CLIP_PATH_GRAPH", node, "must belong to one executable composition before coverage preflight.");
        }
        const group = groups.get(composition.id) ?? { composition, entries: [] };
        group.entries.push({ node, config }); groups.set(composition.id, group);
      }
    } catch (error) {
      if (!(error instanceof ReferenceClipPathError)) throw error;
      report(error);
    }
  }
  for (const { composition, entries } of groups.values()) {
    try {
      // Aggregate budgets fail before a coverage plane is allocated. Public
      // check/compile then owns identity refusal, not just render. Static
      // polygon coverage is the authoritative proof that each wrapper changes
      // output for its exact composition.
      validateReferenceClipPathCompositionBudget(entries, composition.width, composition.height);
      for (const { node, config } of entries) prepareReferenceClipPath(node, config, composition.width, composition.height);
    } catch (error) {
      if (!(error instanceof ReferenceClipPathError)) throw error;
      report(error);
    }
  }
}

function validateCompiledMotionBlurContracts(ir: CutAVIR, check: CheckResult) {
  const report = (error: ReferenceMotionBlurError, fallback?: IRNode): never => {
    const node = (error.source ? ir.nodes[error.source.nodeId] : undefined) ?? fallback;
    if (!node) throw error;
    check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
    throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
  };
  const owningComposition = (node: IRNode) => {
    if (node.sceneId) return ir.compositions.find((composition) => composition.sceneIds.includes(node.sceneId!));
    return ir.compositions.find((composition) =>
      composition.rootVisualIds.includes(node.id)
      || composition.rootAVIds.includes(node.id)
      || composition.items.some((item) => item.kind === "node" && item.id === node.id));
  };
  for (const node of Object.values(ir.nodes)) {
    try {
      const config = referenceMotionBlurConfig(node);
      if (config) {
        const composition = owningComposition(node), child = ir.nodes[node.children[0]];
        if (!composition || !child) {
          throw new ReferenceMotionBlurError(
            "CUT_MOTION_BLUR_PLAN",
            "CUT MotionBlur must belong to one executable composition and retain its exact direct child before boundary preflight.",
          );
        }
        prepareReferenceMotionBlurBoundary(node, child, divideRational(rational(1), composition.fps), config);
      }
    }
    catch (error) {
      if (!(error instanceof ReferenceMotionBlurError)) throw error;
      report(error, node);
    }
  }
  for (const composition of ir.compositions) {
    const reachable = new Set(Object.values(ir.nodes).filter((node) => (
      node.sceneId ? composition.sceneIds.includes(node.sceneId) : (
        composition.rootVisualIds.includes(node.id)
        || composition.rootAudioIds.includes(node.id)
        || composition.rootAVIds.includes(node.id)
      )
    )).map((node) => node.id));
    try { validateReferenceMotionBlurCompositionBudget(ir, reachable, composition.width, composition.height); }
    catch (error) {
      if (!(error instanceof ReferenceMotionBlurError)) throw error;
      report(error);
    }
  }
}

function validateCompiledChartContracts(ir: CutAVIR, check: CheckResult) {
  const owningComposition = (node: IRNode) => {
    if (node.sceneId) return ir.compositions.find((composition) => composition.sceneIds.includes(node.sceneId!));
    return ir.compositions.find((composition) =>
      composition.rootVisualIds.includes(node.id)
      || composition.rootAVIds.includes(node.id)
      || composition.items.some((item) => item.kind === "node" && item.id === node.id));
  };
  for (const node of Object.values(ir.nodes)) {
    if (node.op !== "cut.data.chart" && node.op !== "cut.data.series_chart") continue;
    const composition = owningComposition(node);
    if (!composition) {
      check.diagnostics.push({ severity: "error", code: node.op === "cut.data.series_chart" ? "CUT_SERIES_CHART_LAYOUT" : "CUT_CHART_COMBINATION", message: `${node.op === "cut.data.series_chart" ? "SeriesChart" : "Chart"} must belong to one executable composition.`, span: node.provenance.span });
      throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
    }
    try {
      if (node.op === "cut.data.series_chart") referenceSeriesChartConfig(ir, node, composition);
      else referenceChartConfig(ir, node, composition);
      // Chart publicly accepts the shared retained-transform controls. Close
      // their authored value/signal boundary during `cut check`, rather than
      // allowing an impossible opacity/scale/rotation to survive until the
      // first reference-runtime frame.
      validateReferenceVisualTransform(ir, composition, node);
    } catch (error) {
      if (!(error instanceof ReferenceChartError) && !(error instanceof ReferenceSeriesChartError) && !(error instanceof ReferenceVisualConfigError)) throw error;
      check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
      throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
    }
  }
}

function validateCompiledAudioRouting(ir: CutAVIR, check: CheckResult) {
  for (const composition of ir.compositions) {
    try {
      planReferenceAudioRouting(ir, composition);
    } catch (error) {
      if (error instanceof ReferenceAudioRoutingError) {
        check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: error.node.provenance.span });
        throw new CutCompileError(check, error.node.provenance.module === "project.cut" ? undefined : error.node.provenance.module);
      }
      if (error instanceof ReferenceAudioConfigError) {
        const node = ir.nodes[error.nodeId];
        if (!node) throw error;
        check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: node.provenance.span });
        throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
      }
      throw error;
    }
  }
}

function validateCompiledTempoDelayContracts(ir: CutAVIR, check: CheckResult) {
  for (const composition of ir.compositions) {
    try {
      validateReferenceTempoDelayPlans(ir, composition, referenceAudioCompositionRootIds(ir, composition));
    } catch (error) {
      if (!(error instanceof ReferenceTempoDelayConfigError)) throw error;
      const node = ir.nodes[error.source.nodeId];
      if (!node) throw error;
      const prefix = `${error.code}: `;
      check.diagnostics.push({
        severity: "error",
        code: error.code,
        message: error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
        span: node.provenance.span,
        ...(node.provenance.module === "project.cut" ? {} : { module: node.provenance.module }),
      });
      throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
    }
  }
}

function validateCompiledRetimedAudioRegionHandleOwnership(ir: CutAVIR, check: CheckResult) {
  const parents = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) {
    for (const childId of parent.children) {
      const entries = parents.get(childId) ?? [];
      entries.push(parent);
      parents.set(childId, entries);
    }
  }
  const containsTimeStretch = (node: IRNode) => {
    const pending = [...node.children];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const child = ir.nodes[id];
      if (!child) continue;
      if (child.op === "cut.audio.time_stretch") return true;
      pending.push(...child.children);
    }
    return false;
  };
  for (const node of Object.values(ir.nodes)) {
    if (node.op !== "cut.edit.audio_region"
      || (node.inputs.headHandle === undefined && node.inputs.tailHandle === undefined)
      || !containsTimeStretch(node)) continue;
    const owners = parents.get(node.id) ?? [];
    if (owners.length === 1 && owners[0].op === "cut.edit.timeline_audio_origin") continue;
    check.diagnostics.push({
      severity: "error",
      code: "CUT_AUDIO_REGION_RETIME_TOPOLOGY",
      message: "AudioRegion TimeStretch may declare source-clock handles only when one canonical TimelineEdit materializes the region as an authenticated origin.",
      span: node.provenance.span,
      ...(node.provenance.module === "project.cut" ? {} : { module: node.provenance.module }),
    });
    throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
  }
}

function validateCompiledResponsiveStackContracts(
  ir: CutAVIR,
  check: CheckResult,
  responsiveAnnotatedFragmentIds: ReadonlySet<string>,
) {
  for (const composition of ir.compositions) {
    const selected = new Set(Object.values(ir.nodes).filter((node) => node.sceneId
      ? composition.sceneIds.includes(node.sceneId)
      : composition.items.some((item) => item.kind === "node" && item.id === node.id)).map((node) => node.id));
    for (const fragmentId of responsiveAnnotatedFragmentIds) selected.delete(fragmentId);
    try { validateReferenceResponsiveStackGraph(ir, composition, selected); }
    catch (error) {
      if (!(error instanceof ReferenceResponsiveStackError)) throw error;
      const node = ir.nodes[error.source.nodeId];
      if (!node) throw error;
      const prefix = `${error.code}: `;
      check.diagnostics.push({
        severity: "error",
        code: error.code,
        message: error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
        span: node.provenance.span,
        ...(node.provenance.module === "project.cut" ? {} : { module: node.provenance.module }),
      });
      throw new CutCompileError(check, node.provenance.module === "project.cut" ? undefined : node.provenance.module);
    }
  }
}

function validateCompiledDiagramContracts(ir: CutAVIR, check: CheckResult) {
  try { validateCutDiagramLanguageIR(ir); }
  catch (error) {
    if (!(error instanceof CutDiagramContractError)) throw error;
    const node = error.nodeId ? ir.nodes[error.nodeId] : undefined;
    const prefix = `${error.code}: `;
    check.diagnostics.push({
      severity: "error",
      code: error.code,
      message: error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
      span: node?.provenance.span ?? check.module.span,
      ...(node && node.provenance.module !== "project.cut" ? { module: node.provenance.module } : {}),
    });
    throw new CutCompileError(check, node?.provenance.module === "project.cut" ? undefined : node?.provenance.module);
  }
}

function validateCompiledMediaCamera2DContracts(ir: CutAVIR, check: CheckResult) {
  try { validateCutMediaCamera2DLanguageIR(ir); }
  catch (error) {
    if (!(error instanceof CutMediaCamera2DContractError)) throw error;
    const node = ir.nodes[error.nodeId], prefix = `${error.code}: `;
    check.diagnostics.push({
      severity: "error",
      code: error.code,
      message: error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
      span: node?.provenance.span ?? check.module.span,
      ...(node && node.provenance.module !== "project.cut" ? { module: node.provenance.module } : {}),
    });
    throw new CutCompileError(check, node?.provenance.module === "project.cut" ? undefined : node?.provenance.module);
  }
}

function validateCompiledCamera3DContracts(ir: CutAVIR, check: CheckResult) {
  const report = (error: ReferenceCamera3DError): never => {
    check.diagnostics.push({
      severity: "error",
      code: error.code,
      message: error.message,
      span: error.node.provenance.span,
      ...(error.node.provenance.module === "project.cut" ? {} : { module: error.node.provenance.module }),
    });
    throw new CutCompileError(check, error.node.provenance.module === "project.cut" ? undefined : error.node.provenance.module);
  };
  for (const composition of ir.compositions) {
    const selected = new Set(Object.values(ir.nodes).filter((node) => node.sceneId
      ? composition.sceneIds.includes(node.sceneId)
      : composition.items.some((item) => item.kind === "node" && item.id === node.id)).map((node) => node.id));
    let cameras: ReturnType<typeof validateReferenceCamera3DGraph> = new Map();
    try { cameras = validateReferenceCamera3DGraph(ir, composition, selected); }
    catch (error) { if (!(error instanceof ReferenceCamera3DError)) throw error; report(error); }
    let validationSamples = 0;
    for (const config of cameras.values()) {
      const camera = ir.nodes[config.nodeId]!;
      const exactFrames = rawMultiplyRational(camera.interval.duration, composition.fps);
      if (exactFrames.denominator !== "1") {
        report(new ReferenceCamera3DError("CUT_CAMERA3D_GRAPH", camera, "interval duration must land on the owning composition frame grid."));
      }
      const count = Number(BigInt(exactFrames.numerator));
      validationSamples += count;
      if (!Number.isSafeInteger(count) || count < 1 || validationSamples > referenceCamera3DLimits.maximumValidationFrameSamples) {
        report(new ReferenceCamera3DError("CUT_CAMERA3D_LIMIT", camera, `compile-time Camera3D validation exceeds ${referenceCamera3DLimits.maximumValidationFrameSamples} exact output-frame samples per composition.`));
      }
      const visiblePlaneIds = new Set<string>();
      for (let frame = 0; frame < count; frame += 1) {
        const time = rawAddRational(camera.interval.start, rawDivideRational(rational(frame), composition.fps));
        try {
          const plan = referenceCamera3DPlanAt(ir, composition, config, time, "compile-preflight-plan-only");
          for (const plane of plan.planes) if (plane.status === "visible" && plane.intersectsOutput) visiblePlaneIds.add(plane.nodeId);
        } catch (error) { if (!(error instanceof ReferenceCamera3DError)) throw error; report(error); }
      }
      const neverVisible = config.planes.find((plane) => !visiblePlaneIds.has(plane.nodeId));
      if (neverVisible) {
        const plane = ir.nodes[neverVisible.nodeId]!;
        report(new ReferenceCamera3DError("CUT_CAMERA3D_NOOP", plane, "does not produce positive-opacity output coverage on any exact output frame in its interval."));
      }
    }
  }
}

function annotationStatementNative(statement: Extract<Statement, { kind: "node" }>, context: LowerContext) {
  const name = calleeName(statement.expression.callee) ?? "anonymous";
  return context.check.imports.get(name)?.symbol.native ?? context.check.symbols.get(name)?.packageSymbol?.native;
}

function annotationArgumentSpan(statement: Extract<Statement, { kind: "node" }>, name: string) {
  return statement.expression.named.find((argument) => argument.name === name)?.value.span ?? statement.expression.span;
}

function lowerAnnotationStatement(statement: Extract<Statement, { kind: "node" }>, context: LowerContext) {
  const native = annotationStatementNative(statement, context);
  if (native !== "cut.edit.marker" && native !== "cut.edit.region") throw new Error("Internal CUT annotation lowering received a non-annotation statement.");
  if (statement.body.length || statement.binding) annotationCompileError(context, statement.span, "CUT_ANNOTATION_CONTEXT", "Marker/Region statements cannot have child blocks or node bindings.");
  const name = calleeName(statement.expression.callee) ?? (native === "cut.edit.marker" ? "Marker" : "Region");
  const symbol = context.check.imports.get(name)?.symbol ?? context.check.symbols.get(name)?.packageSymbol;
  const inputs = callArguments(statement.expression, symbol, context);
  const stringInput = (field: string) => {
    const value = inputs[field];
    if (!value) return undefined;
    if (value.kind !== "string") annotationCompileError(context, annotationArgumentSpan(statement, field), "CUT_ANNOTATION_METADATA", `${name} ${field}: must reduce to a compile-time String.`);
    return value.value;
  };
  const id = stringInput("id");
  if (!id) annotationCompileError(context, annotationArgumentSpan(statement, "id"), "CUT_ANNOTATION_ID", `${name} id: must reduce to a non-empty compile-time String.`);
  const colorValue = inputs.color;
  if (colorValue && colorValue.kind !== "color") annotationCompileError(context, annotationArgumentSpan(statement, "color"), "CUT_ANNOTATION_METADATA", `${name} color: must reduce to a CUT Color.`);

  let metadata;
  try {
    metadata = normalizeEditorialAnnotationMetadata({
      id,
      name: stringInput("name"),
      color: colorValue?.kind === "color" ? colorValue.value : undefined,
      role: stringInput("role"),
      comment: stringInput("comment"),
      grid: stringInput("grid"),
    });
  } catch (error) {
    if (!(error instanceof EditorialAnnotationError)) throw error;
    const field = error.code === "CUT_ANNOTATION_ID" ? "id" : error.code === "CUT_ANNOTATION_ROLE" ? "role" : error.code === "CUT_ANNOTATION_GRID" ? "grid" : "name";
    annotationCompileError(context, annotationArgumentSpan(statement, field), error.code, error.message);
  }

  context.budget.annotations += 1;
  if (context.budget.annotations > context.budget.limits.maxAnnotations) {
    annotationCompileError(context, statement.span, "CUT_ANNOTATION_LIMIT", `CUT annotations exceed maxAnnotations=${context.budget.limits.maxAnnotations}.`);
  }
  context.budget.annotationMetadataBytes += editorialAnnotationMetadataBytes(metadata);
  if (context.budget.annotationMetadataBytes > context.budget.limits.maxAnnotationMetadataBytes) {
    annotationCompileError(context, statement.span, "CUT_ANNOTATION_LIMIT", `CUT annotation metadata exceeds maxAnnotationMetadataBytes=${context.budget.limits.maxAnnotationMetadataBytes}.`);
  }

  const existing = context.ir.annotations
    ? [...context.ir.annotations.markers, ...context.ir.annotations.regions].find((annotation) => annotation.id === metadata.id)
    : undefined;
  if (existing) annotationCompileError(context, annotationArgumentSpan(statement, "id"), "CUT_ANNOTATION_DUPLICATE", `Annotation id “${metadata.id}” duplicates ${existing.kind} authored at ${existing.provenance.module}:${existing.provenance.span.start.line}:${existing.provenance.span.start.column}.`);

  const base = addRational(context.scene?.start ?? zeroRational, context.localTime);
  const clock = { fps: context.timeline.fps, sampleRate: context.timeline.sampleRate, duration: context.timeline.duration };
  const ownerDuration = context.duration;
  const authoredProvenance = provenance(context.moduleName, statement.expression.span, name, context.expansion);
  let annotation: IRTimelineMarker | IRTimelineRegion;
  try {
    if (native === "cut.edit.marker") {
      const relative = valueRational(inputs.at, "time");
      if (!relative) annotationCompileError(context, annotationArgumentSpan(statement, "at"), "CUT_ANNOTATION_TIMING", "Marker at: must reduce to an exact Time.");
      if (compareRational(relative, zeroRational) < 0 || compareRational(relative, ownerDuration) > 0) annotationCompileError(context, annotationArgumentSpan(statement, "at"), "CUT_ANNOTATION_TIMING", `Marker “${metadata.id}” time lies outside its owning statement interval.`);
      const at = addRational(base, relative);
      assertEditorialMarkerTime(at, metadata, clock);
      annotation = { kind: "marker", ...metadata, compositionId: context.timeline.id, ...(context.scene ? { sceneId: context.scene.id } : {}), at, provenance: authoredProvenance };
    } else {
      const range = inputs.range;
      if (!range || range.kind !== "range" || !range.exclusive) annotationCompileError(context, annotationArgumentSpan(statement, "range"), "CUT_ANNOTATION_TIMING", "Region range: must reduce to an exact half-open Range<Time>; use start ..< end.");
      const relativeStart = valueRational(range.start, "time"), relativeEnd = valueRational(range.end, "time");
      if (!relativeStart || !relativeEnd) annotationCompileError(context, annotationArgumentSpan(statement, "range"), "CUT_ANNOTATION_TIMING", "Region range endpoints must reduce to exact Time values.");
      if (compareRational(relativeStart, zeroRational) < 0 || compareRational(relativeEnd, relativeStart) <= 0 || compareRational(relativeEnd, ownerDuration) > 0) annotationCompileError(context, annotationArgumentSpan(statement, "range"), "CUT_ANNOTATION_TIMING", `Region “${metadata.id}” range must be positive and lie inside its owning statement interval.`);
      const start = addRational(base, relativeStart), duration = subtractRational(relativeEnd, relativeStart);
      assertEditorialRegionRange(start, duration, metadata, clock);
      annotation = { kind: "region", ...metadata, compositionId: context.timeline.id, ...(context.scene ? { sceneId: context.scene.id } : {}), range: { start, duration }, provenance: authoredProvenance };
    }
  } catch (error) {
    if (!(error instanceof EditorialAnnotationError)) throw error;
    annotationCompileError(context, annotationArgumentSpan(statement, native === "cut.edit.marker" ? "at" : "range"), error.code, error.message);
  }
  const annotations = context.ir.annotations ?? { markers: [], regions: [] };
  if (annotation.kind === "marker") annotations.markers.push(annotation);
  else annotations.regions.push(annotation);
  context.ir.annotations = annotations;
}

function lowerLinkedTrimStatement(statement: Extract<Statement, { kind: "node" }>, context: LowerContext) {
  if (!context.scene || !context.directSceneStatementBlock) {
    linkedTrimCompileError(context, statement.span, "CUT_LINKED_TRIM_SCOPE", "LinkedTrim is valid only as a direct statement in a declared scene body.");
  }
  if (statement.body.length || statement.binding) {
    linkedTrimCompileError(context, statement.span, "CUT_LINKED_TRIM_SCOPE", "LinkedTrim cannot have a child block or an “as” binding.");
  }
  if (context.pendingLinkedEdits.length >= 256) {
    linkedTrimCompileError(context, statement.span, "CUT_LINKED_TRIM_LIMIT", "CUT permits at most 256 LinkedTrim transactions per compilation unit.");
  }
  const name = calleeName(statement.expression.callee) ?? "LinkedTrim";
  const symbol = context.check.imports.get(name)?.symbol ?? context.check.symbols.get(name)?.packageSymbol;
  const inputs = callArguments(statement.expression, symbol, context);
  const link = inputs.link;
  if (link?.kind !== "string" || !link.value || link.value !== link.value.trim() || link.value.length > 128 || /[\u0000-\u001f\u007f]/.test(link.value)) {
    linkedTrimCompileError(context, annotationArgumentSpan(statement, "link"), "CUT_LINKED_TRIM_RESULT", "LinkedTrim link must reduce to a non-empty trimmed String of at most 128 characters without control characters.");
  }
  const keep = inputs.keep;
  if (!keep || keep.kind !== "range" || !keep.exclusive) {
    linkedTrimCompileError(context, annotationArgumentSpan(statement, "keep"), "CUT_LINKED_TRIM_TIME", "LinkedTrim keep must reduce to an exact half-open Range<Time>; use start ..< end.");
  }
  const start = valueRational(keep.start, "time"), end = valueRational(keep.end, "time");
  if (!start || !end || compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0 || compareRational(end, context.scene.duration) > 0) {
    linkedTrimCompileError(context, annotationArgumentSpan(statement, "keep"), "CUT_LINKED_TRIM_TIME", "LinkedTrim keep must be positive and lie inside the owning scene in scene-local destination coordinates.");
  }
  const absoluteStart = addRational(context.scene.start, start), absoluteEnd = addRational(context.scene.start, end);
  if (multiplyRational(absoluteStart, context.timeline.fps).denominator !== "1"
    || multiplyRational(absoluteEnd, context.timeline.fps).denominator !== "1") {
    linkedTrimCompileError(context, annotationArgumentSpan(statement, "keep"), "CUT_LINKED_TRIM_TIME", `LinkedTrim keep endpoints must land on the ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps picture grid.`);
  }
  if (multiplyRational(absoluteStart, rational(context.timeline.sampleRate)).denominator !== "1"
    || multiplyRational(absoluteEnd, rational(context.timeline.sampleRate)).denominator !== "1") {
    linkedTrimCompileError(context, annotationArgumentSpan(statement, "keep"), "CUT_LINKED_TRIM_TIME", `LinkedTrim keep endpoints must land on the ${context.timeline.sampleRate} Hz audio sample grid.`);
  }
  const interval = { start, duration: subtractRational(end, start) };
  const authoredProvenance = provenance(context.moduleName, statement.expression.span, "LinkedTrim", context.expansion);
  context.pendingLinkedEdits.push({
    id: stableId("linked_edit", {
      kind: "linked-trim",
      compositionId: context.timeline.id,
      sceneId: context.scene.id,
      linkId: link.value,
    }),
    compositionId: context.timeline.id,
    sceneId: context.scene.id,
    linkId: link.value,
    keep: interval,
    provenance: authoredProvenance,
  });
}

function lowerLinkedRippleDeleteStatement(statement: Extract<Statement, { kind: "node" }>, context: LowerContext) {
  if (!context.scene || !context.directSceneStatementBlock) {
    linkedRippleDeleteCompileError(context, statement.span, "CUT_LINKED_RIPPLE_SCOPE", "LinkedRippleDelete is valid only as a direct statement in a declared scene body.");
  }
  if (statement.body.length || statement.binding) {
    linkedRippleDeleteCompileError(context, statement.span, "CUT_LINKED_RIPPLE_SCOPE", "LinkedRippleDelete cannot have a child block or an “as” binding.");
  }
  if (context.pendingLinkedEdits.length >= 256) {
    linkedRippleDeleteCompileError(context, statement.span, "CUT_LINKED_RIPPLE_LIMIT", "CUT permits at most 256 linked editorial transactions per compilation unit.");
  }
  const name = calleeName(statement.expression.callee) ?? "LinkedRippleDelete";
  const symbol = context.check.imports.get(name)?.symbol ?? context.check.symbols.get(name)?.packageSymbol;
  const inputs = callArguments(statement.expression, symbol, context);
  const link = inputs.link;
  if (link?.kind !== "string" || !link.value || link.value !== link.value.trim() || link.value.length > 128 || /[\u0000-\u001f\u007f]/.test(link.value)) {
    linkedRippleDeleteCompileError(context, annotationArgumentSpan(statement, "link"), "CUT_LINKED_RIPPLE_RESULT", "LinkedRippleDelete link must reduce to a non-empty trimmed String of at most 128 characters without control characters.");
  }
  let interval: IREditorialInterval | undefined;
  if (inputs.range !== undefined) {
    const range = inputs.range;
    if (range.kind !== "range" || !range.exclusive) {
      linkedRippleDeleteCompileError(context, annotationArgumentSpan(statement, "range"), "CUT_LINKED_RIPPLE_TIME", "LinkedRippleDelete range must reduce to an exact half-open Range<Time>; use start ..< end.");
    }
    const start = valueRational(range.start, "time"), end = valueRational(range.end, "time");
    if (!start || !end || compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0 || compareRational(end, context.scene.duration) > 0) {
      linkedRippleDeleteCompileError(context, annotationArgumentSpan(statement, "range"), "CUT_LINKED_RIPPLE_TIME", "LinkedRippleDelete range must be positive and lie inside the owning scene in scene-local destination coordinates.");
    }
    const absoluteStart = addRational(context.scene.start, start), absoluteEnd = addRational(context.scene.start, end);
    if (multiplyRational(absoluteStart, context.timeline.fps).denominator !== "1"
      || multiplyRational(absoluteEnd, context.timeline.fps).denominator !== "1") {
      linkedRippleDeleteCompileError(context, annotationArgumentSpan(statement, "range"), "CUT_LINKED_RIPPLE_TIME", `LinkedRippleDelete range endpoints must land on the ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps picture grid.`);
    }
    if (multiplyRational(absoluteStart, rational(context.timeline.sampleRate)).denominator !== "1"
      || multiplyRational(absoluteEnd, rational(context.timeline.sampleRate)).denominator !== "1") {
      linkedRippleDeleteCompileError(context, annotationArgumentSpan(statement, "range"), "CUT_LINKED_RIPPLE_TIME", `LinkedRippleDelete range endpoints must land on the ${context.timeline.sampleRate} Hz audio sample grid.`);
    }
    interval = { start, duration: subtractRational(end, start) };
  }
  const authoredProvenance = provenance(context.moduleName, statement.expression.span, "LinkedRippleDelete", context.expansion);
  const id = stableId("linked_edit", {
    kind: "linked-ripple-delete",
    compositionId: context.timeline.id,
    sceneId: context.scene.id,
    linkId: link.value,
    ...(interval ? { range: interval } : {}),
  });
  context.pendingLinkedEdits.push({
    kind: "linked-ripple-delete",
    id,
    compositionId: context.timeline.id,
    sceneId: context.scene.id,
    linkId: link.value,
    ...(interval ? { range: interval } : {}),
    provenance: authoredProvenance,
  });
}

function timelineEditCompileError(
  context: LowerContext,
  span: SourceSpan,
  code: string,
  message: string,
): never {
  context.check.diagnostics.push({
    severity: "error",
    code,
    message,
    span,
    ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
  });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function lowerTimelineEditStatement(statement: Extract<Statement, { kind: "node" }>, context: LowerContext) {
  if (!context.scene || !context.directSceneStatementBlock) {
    timelineEditCompileError(
      context,
      statement.span,
      "CUT_TIMELINE_EDIT_SCOPE",
      "TimelineEdit is valid only as a direct statement in a declared scene body.",
    );
  }
  if (statement.body.length || statement.binding) {
    timelineEditCompileError(
      context,
      statement.span,
      "CUT_TIMELINE_EDIT_SCOPE",
      "TimelineEdit cannot have a child block or an “as” binding.",
    );
  }
  if (context.pendingTimelineEdits.length >= timelineEditLimits.maximumOperations) {
    timelineEditCompileError(
      context,
      statement.span,
      "CUT_TIMELINE_EDIT_LIMIT",
      `CUT permits at most ${timelineEditLimits.maximumOperations} TimelineEdit declarations per compilation unit.`,
    );
  }
  const name = calleeName(statement.expression.callee) ?? "TimelineEdit";
  const symbol = context.check.imports.get(name)?.symbol ?? context.check.symbols.get(name)?.packageSymbol;
  const inputs = callArguments(statement.expression, symbol, context);
  const id = inputs.id;
  if (id?.kind !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(id.value)) {
    timelineEditCompileError(
      context,
      annotationArgumentSpan(statement, "id"),
      "CUT_TIMELINE_EDIT_SHAPE",
      "TimelineEdit id must be a stable identifier beginning with an ASCII letter and containing at most 128 safe characters.",
    );
  }
  let duration: Rational | undefined;
  if (inputs.duration !== undefined) {
    duration = valueRational(inputs.duration, "time");
    if (!duration || compareRational(duration, zeroRational) <= 0 || compareRational(duration, context.scene.duration) !== 0) {
      timelineEditCompileError(
        context,
        annotationArgumentSpan(statement, "duration"),
        "CUT_TIMELINE_EDIT_TIME",
        "TimelineEdit duration must exactly equal its owning fixed-duration scene in the v1 closure.",
      );
    }
  }
  const operations = inputs.operations;
  const expressionOperations = statement.expression.named.find((argument) => argument.name === "operations")?.value
    ?? statement.expression.positional[2];
  if (operations?.kind !== "array"
    || !operations.items.length
    || operations.items.length > timelineEditLimits.maximumOperations
    || expressionOperations?.kind !== "array"
    || expressionOperations.items.length !== operations.items.length) {
    timelineEditCompileError(
      context,
      annotationArgumentSpan(statement, "operations"),
      "CUT_TIMELINE_EDIT_LIMIT",
      `TimelineEdit operations must be one non-empty literal list bounded to ${timelineEditLimits.maximumOperations} entries.`,
    );
  }
  const supported = new Set([
    "split",
    "trim",
    "ripple-delete",
    "lift",
    "extract",
    "slip",
    "slide",
    "boundary-adjust",
    "insert",
    "overwrite",
    "transition",
  ]);
  for (const [index, operation] of operations.items.entries()) {
    if (operation.kind !== "object"
      || operation.entries.kind?.kind !== "string"
      || !supported.has(operation.entries.kind.value)) {
      timelineEditCompileError(
        context,
        expressionOperations.items[index]?.span ?? annotationArgumentSpan(statement, "operations"),
        "CUT_TIMELINE_EDIT_SHAPE",
        "TimelineEdit operation lost its closed public operation discriminator.",
      );
    }
  }
  const authoredProvenance = provenance(context.moduleName, statement.expression.span, "TimelineEdit", context.expansion);
  context.pendingTimelineEdits.push({
    id: id.value,
    compositionId: context.timeline.id,
    sceneId: context.scene.id,
    ...(duration ? { duration } : {}),
    operations: operations.items,
    operationSpans: expressionOperations.items.map((operation) => operation.span),
    provenance: authoredProvenance,
  });
}

function commitTimelineEditStage(
  context: LowerContext,
  stage: TimelineEditIrStageV1,
  materialization: TimelineEditIrMaterializationV1,
) {
  const removed = new Set(materialization.patches.flatMap((patch) => patch.removeNodeIds));
  const additions = materialization.patches.flatMap((patch) => patch.nodes);
  const extraNodes = Math.max(0, additions.length - removed.size);
  if (context.budget.nodes + extraNodes > context.budget.limits.maxNodes) {
    throw new TimelineEditError(
      "CUT_TIMELINE_EDIT_LIMIT",
      `materialization exceeds maxNodes=${context.budget.limits.maxNodes}.`,
      "$.materialization",
    );
  }
  const trackIds = new Set<string>();
  for (const patch of materialization.patches) {
    if (trackIds.has(patch.trackNodeId)) {
      throw new TimelineEditError(
        "CUT_TIMELINE_EDIT_RESULT",
        `materialization patches track ${patch.trackNodeId} more than once.`,
        "$.materialization",
      );
    }
    trackIds.add(patch.trackNodeId);
    const track = context.ir.nodes[patch.trackNodeId];
    if (!track || track.editorial?.kind !== patch.editorial.kind) {
      throw new TimelineEditError(
        "CUT_TIMELINE_EDIT_RESULT",
        `materialization lost owning track ${patch.trackNodeId}.`,
        "$.materialization",
      );
    }
  }
  // Staging above is pure. The bounded commit below cannot fail after all
  // identities, grids, nodes and complete multi-track results have passed, so
  // an invalid linked edit never publishes only one side into returned IR.
  context.budget.nodes += extraNodes;
  for (const id of removed) delete context.ir.nodes[id];
  for (const node of additions) context.ir.nodes[node.id] = node;
  for (const patch of materialization.patches) {
    const track = context.ir.nodes[patch.trackNodeId]!;
    track.children = [...patch.children];
    track.editorial = structuredClone(patch.editorial);
    track.contentHash = hash({ ...track, contentHash: undefined });
  }
  context.ir.timelineEdits = [...(context.ir.timelineEdits ?? []), structuredClone(stage.plan)];
}

const semanticMatchIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const semanticMatchEasings = new Set<IRSemanticMatchTransitionV1["easing"]>(["linear", "inCubic", "outCubic", "inOutCubic"]);

function semanticMatchCompileError(context: LowerContext, span: SourceSpan, code: string, message: string): never {
  context.check.diagnostics.push({
    severity: "error",
    code,
    message,
    span,
    ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
  });
  throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
}

function semanticMatchAuthoredId(
  value: IRValue | undefined,
  label: string,
  statement: Extract<Statement, { kind: "node" }>,
  context: LowerContext,
) {
  if (value?.kind !== "string" || !semanticMatchIdPattern.test(value.value)) {
    semanticMatchCompileError(
      context,
      annotationArgumentSpan(statement, label),
      "CUT_MATCH_ID",
      `${label} must reduce to a 1-128 character identifier beginning with a letter and containing only letters, digits, dot, underscore, or hyphen.`,
    );
  }
  return value.value;
}

function semanticMatchQuantity(
  value: IRValue | undefined,
  dimension: string,
  label: string,
  statement: Extract<Statement, { kind: "node" }>,
  context: LowerContext,
) {
  const exact = valueRational(value, dimension);
  if (!exact) semanticMatchCompileError(context, annotationArgumentSpan(statement, label), "CUT_MATCH_TRANSFORM", `MatchTransition ${label}: must reduce to an exact ${dimension} quantity.`);
  return exact;
}

function semanticMatchLocalSpaceBasis(localSpace: IRNode, context: LowerContext, span: SourceSpan): IRSemanticMatchSubjectV1["basis"] {
  const wholePixel = (field: "width" | "height") => {
    const value = localSpace.inputs[field], exact = valueRational(value, "length");
    if (!exact || value?.kind !== "quantity" || value.unit !== "px" || exact.denominator !== "1") {
      semanticMatchCompileError(context, span, "CUT_MATCH_BASIS", `MatchSubject LocalSpace ${field} must be a positive whole-pixel Length.`);
    }
    const number = Number(exact.numerator);
    if (!Number.isSafeInteger(number) || number < 1 || number > 16_384) semanticMatchCompileError(context, span, "CUT_MATCH_BASIS", `MatchSubject LocalSpace ${field} exceeds the 1-16384px retained basis bound.`);
    return number;
  };
  const origin = localSpace.inputs.origin;
  if (origin?.kind !== "object" || Object.keys(origin.entries).length !== 2) semanticMatchCompileError(context, span, "CUT_MATCH_BASIS", "MatchSubject LocalSpace origin must contain exactly x and y pixel Length values.");
  const coordinate = (axis: "x" | "y") => {
    const value = origin.entries[axis], exact = valueRational(value, "length");
    if (!exact || value?.kind !== "quantity" || value.unit !== "px") semanticMatchCompileError(context, span, "CUT_MATCH_BASIS", `MatchSubject LocalSpace origin.${axis} must be an exact pixel Length.`);
    return exact;
  };
  return { width: wholePixel("width"), height: wholePixel("height"), origin: { x: coordinate("x"), y: coordinate("y") } };
}

function lowerSemanticMatchSubjectStatement(statement: Extract<Statement, { kind: "node" }>, context: LowerContext) {
  if (!context.scene || !context.directSceneStatementBlock || context.directTimelineStatementBlock) {
    semanticMatchCompileError(context, statement.span, "CUT_MATCH_SCOPE", "MatchSubject is valid only as a direct statement in a declared scene body.");
  }
  if (statement.body.length || statement.binding) semanticMatchCompileError(context, statement.span, "CUT_MATCH_SCOPE", "MatchSubject cannot have a child block or an “as” binding.");
  const name = calleeName(statement.expression.callee) ?? "MatchSubject";
  const symbol = context.check.imports.get(name)?.symbol ?? context.check.symbols.get(name)?.packageSymbol;
  const inputs = callArguments(statement.expression, symbol, context);
  const authoredId = semanticMatchAuthoredId(inputs.id, "id", statement, context);
  const subjectRef = inputs.subject;
  if (subjectRef?.kind !== "node-ref") semanticMatchCompileError(context, annotationArgumentSpan(statement, "subject"), "CUT_MATCH_SUBJECT", "MatchSubject subject: must name a visual node bound earlier in this scene.");
  const camera = context.ir.nodes[subjectRef.id];
  if (!camera || camera.op !== "cut.visual.camera2d" || camera.domain !== "visual") {
    semanticMatchCompileError(context, annotationArgumentSpan(statement, "subject"), "CUT_MATCH_CAMERA", "MatchSubject subject: must reference a Camera2D node.");
  }
  if (camera.sceneId !== context.scene.id || camera.ownership !== "root" || !context.scene.items.some((item) => item.id === camera.id)) {
    semanticMatchCompileError(context, annotationArgumentSpan(statement, "subject"), "CUT_MATCH_CAMERA", "MatchSubject Camera2D must be a direct root of the declaring scene.");
  }
  if (compareRational(camera.interval.start, zeroRational) !== 0 || compareRational(camera.interval.duration, context.scene.duration) !== 0) {
    semanticMatchCompileError(context, annotationArgumentSpan(statement, "subject"), "CUT_MATCH_SUBJECT", "MatchSubject Camera2D must span the complete scene interval exactly.");
  }
  if (camera.children.length !== 1) semanticMatchCompileError(context, annotationArgumentSpan(statement, "subject"), "CUT_MATCH_CAMERA", "MatchSubject Camera2D must own exactly one direct LocalSpace child.");
  const localSpace = context.ir.nodes[camera.children[0]!];
  if (!localSpace || localSpace.op !== "cut.visual.local_space" || localSpace.ownership !== "child" || localSpace.sceneId !== context.scene.id) {
    semanticMatchCompileError(context, annotationArgumentSpan(statement, "subject"), "CUT_MATCH_CAMERA", "MatchSubject Camera2D must own exactly one direct LocalSpace child.");
  }
  if (compareRational(localSpace.interval.start, zeroRational) !== 0 || compareRational(localSpace.interval.duration, context.scene.duration) !== 0) {
    semanticMatchCompileError(context, annotationArgumentSpan(statement, "subject"), "CUT_MATCH_SUBJECT", "MatchSubject LocalSpace must span the complete scene interval exactly.");
  }
  const semanticMatches = context.ir.semanticMatches ?? { version: 1 as const, subjects: [], transitions: [] };
  const duplicate = semanticMatches.subjects.find((candidate) => candidate.compositionId === context.timeline.id && candidate.authoredId === authoredId);
  if (duplicate) semanticMatchCompileError(context, annotationArgumentSpan(statement, "id"), "CUT_MATCH_ID", `MatchSubject id “${authoredId}” is already declared in this timeline.`);
  if (semanticMatches.subjects.filter((candidate) => candidate.compositionId === context.timeline.id).length >= 256) semanticMatchCompileError(context, statement.span, "CUT_MATCH_LIMIT", "A timeline may declare at most 256 MatchSubject values.");
  semanticMatches.subjects.push({
    id: stableId("semantic_match_subject", { compositionId: context.timeline.id, sceneId: context.scene.id, authoredId }),
    version: 1,
    kind: "semantic-match-subject",
    compositionId: context.timeline.id,
    sceneId: context.scene.id,
    authoredId,
    cameraNodeId: camera.id,
    localSpaceNodeId: localSpace.id,
    basis: semanticMatchLocalSpaceBasis(localSpace, context, annotationArgumentSpan(statement, "subject")),
    provenance: provenance(context.moduleName, statement.expression.span, "MatchSubject", context.expansion),
  });
  context.ir.semanticMatches = semanticMatches;
}

function lowerSemanticMatchTransitionStatement(statement: Extract<Statement, { kind: "node" }>, context: LowerContext) {
  if (context.scene || !context.directTimelineStatementBlock || context.directSceneStatementBlock || context.timeline.id === "module") {
    semanticMatchCompileError(context, statement.span, "CUT_MATCH_SCOPE", "MatchTransition is valid only as a direct statement in a declared timeline body, outside every scene.");
  }
  if (statement.body.length || statement.binding) semanticMatchCompileError(context, statement.span, "CUT_MATCH_SCOPE", "MatchTransition cannot have a child block or an “as” binding.");
  const name = calleeName(statement.expression.callee) ?? "MatchTransition";
  const symbol = context.check.imports.get(name)?.symbol ?? context.check.symbols.get(name)?.packageSymbol;
  const inputs = callArguments(statement.expression, symbol, context);
  const authoredId = semanticMatchAuthoredId(inputs.id, "id", statement, context);
  const outgoingAuthoredId = semanticMatchAuthoredId(inputs.outgoing, "outgoing", statement, context);
  const incomingAuthoredId = semanticMatchAuthoredId(inputs.incoming, "incoming", statement, context);
  if (outgoingAuthoredId === incomingAuthoredId) semanticMatchCompileError(context, annotationArgumentSpan(statement, "incoming"), "CUT_MATCH_SUBJECT", "MatchTransition outgoing and incoming must reference distinct subjects.");
  const cut = semanticMatchQuantity(inputs.at, "time", "at", statement, context);
  const duration = semanticMatchQuantity(inputs.duration, "time", "duration", statement, context);
  const x = semanticMatchQuantity(inputs.x, "length", "x", statement, context);
  const y = semanticMatchQuantity(inputs.y, "length", "y", statement, context);
  const scale = semanticMatchQuantity(inputs.scale, "scalar", "scale", statement, context);
  const rotation = semanticMatchQuantity(inputs.rotation, "angle", "rotation", statement, context);
  if (compareRational(scale, zeroRational) <= 0 || compareRational(scale, rational(64)) > 0) semanticMatchCompileError(context, annotationArgumentSpan(statement, "scale"), "CUT_MATCH_TRANSFORM", "MatchTransition scale must be greater than zero and no larger than 64.");
  let color: string | undefined;
  if (inputs.color !== undefined) {
    if (inputs.color.kind !== "color" || !/^#[0-9a-fA-F]{6}$/.test(inputs.color.value)) semanticMatchCompileError(context, annotationArgumentSpan(statement, "color"), "CUT_MATCH_TRANSFORM", "MatchTransition color must be one opaque six-digit CUT Color.");
    color = inputs.color.value.toLowerCase();
  }
  const easingValue = inputs.easing;
  const easingSymbol = easingValue?.kind === "symbol" && easingValue.name.startsWith("@cut/motion@") ? easingValue.name : "";
  const easingName = easingSymbol.slice(easingSymbol.lastIndexOf("#") + 1);
  if (!semanticMatchEasings.has(easingName as IRSemanticMatchTransitionV1["easing"])) semanticMatchCompileError(context, annotationArgumentSpan(statement, "easing"), "CUT_MATCH_EASING", "MatchTransition easing must be linear, inCubic, outCubic, or inOutCubic from @cut/motion.");
  const easing = easingName as IRSemanticMatchTransitionV1["easing"];
  const velocityValue = inputs.velocity;
  const velocity = velocityValue?.kind === "string" ? velocityValue.value as IRSemanticMatchTransitionV1["velocity"] : undefined;
  if (velocityValue !== undefined && (velocityValue.kind !== "string" || (velocity !== "settle" && velocity !== "carry"))) semanticMatchCompileError(context, annotationArgumentSpan(statement, "velocity"), "CUT_MATCH_VELOCITY", "MatchTransition velocity must be settle or carry.");
  if (velocity && easing !== "inOutCubic") semanticMatchCompileError(context, annotationArgumentSpan(statement, "easing"), "CUT_MATCH_EASING", `MatchTransition velocity: “${velocity}” requires inOutCubic easing in v1.`);
  if (context.pendingSemanticMatchTransitions.filter((candidate) => candidate.compositionId === context.timeline.id).length >= 128) semanticMatchCompileError(context, statement.span, "CUT_MATCH_LIMIT", "A timeline may declare at most 128 MatchTransition values.");
  context.pendingSemanticMatchTransitions.push({
    authoredId,
    compositionId: context.timeline.id,
    cut,
    duration,
    outgoingAuthoredId,
    incomingAuthoredId,
    target: { x, y, scale, rotation, ...(color ? { color } : {}) },
    easing,
    ...(velocity ? { velocity } : {}),
    provenance: provenance(context.moduleName, statement.expression.span, "MatchTransition", context.expansion),
  });
}

function resolveSemanticMatchTransitions(context: LowerContext) {
  const semanticMatches = context.ir.semanticMatches;
  if (!context.pendingSemanticMatchTransitions.length) {
    if (semanticMatches?.subjects.length) semanticMatchCompileError(context, semanticMatches.subjects[0]!.provenance.span, "CUT_MATCH_SUBJECT", "MatchSubject is unused; semantic-match v1 requires every declared subject to participate in a MatchTransition.");
    return;
  }
  if (!semanticMatches?.subjects.length) semanticMatchCompileError(context, context.pendingSemanticMatchTransitions[0]!.provenance.span, "CUT_MATCH_SUBJECT", "MatchTransition requires declared MatchSubject values in the same timeline.");
  const transitionIds = new Set<string>();
  const subjectWindows = new Map<string, IREditorialInterval[]>();
  for (const request of context.pendingSemanticMatchTransitions) {
    const composition = context.ir.compositions.find((candidate) => candidate.id === request.compositionId);
    if (!composition) semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_CONTRACT", `MatchTransition references missing timeline “${request.compositionId}”.`);
    if (transitionIds.has(`${request.compositionId}\0${request.authoredId}`)) semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_ID", `MatchTransition id “${request.authoredId}” is duplicated in timeline “${request.compositionId}”.`);
    transitionIds.add(`${request.compositionId}\0${request.authoredId}`);
    const candidates = semanticMatches.subjects.filter((subject) => subject.compositionId === request.compositionId);
    const outgoing = candidates.find((subject) => subject.authoredId === request.outgoingAuthoredId);
    const incoming = candidates.find((subject) => subject.authoredId === request.incomingAuthoredId);
    if (!outgoing || !incoming) semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_SUBJECT", `MatchTransition “${request.authoredId}” references an undeclared outgoing or incoming subject in timeline “${request.compositionId}”.`);
    const outgoingScene = context.ir.scenes[outgoing.sceneId], incomingScene = context.ir.scenes[incoming.sceneId];
    if (!outgoingScene || !incomingScene) semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_CONTRACT", "MatchTransition subject scene is missing from typed IR.");
    const outgoingIndex = composition.sceneIds.indexOf(outgoingScene.id), incomingIndex = composition.sceneIds.indexOf(incomingScene.id);
    const outgoingEnd = addRational(outgoingScene.start, outgoingScene.duration);
    if (outgoingIndex < 0 || incomingIndex !== outgoingIndex + 1 || compareRational(outgoingEnd, request.cut) !== 0 || compareRational(incomingScene.start, request.cut) !== 0) {
      semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_CUT", "MatchTransition subjects must belong to source-adjacent scenes whose exact hard boundary equals at:.");
    }
    const frameCount = multiplyRational(request.duration, composition.fps);
    const cutFrame = multiplyRational(request.cut, composition.fps);
    if (cutFrame.denominator !== "1") semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_CUT", `MatchTransition at: must land on the ${composition.fps.numerator}/${composition.fps.denominator} fps frame grid.`);
    if (frameCount.denominator !== "1" || BigInt(frameCount.numerator) < 4n || BigInt(frameCount.numerator) > 600n || BigInt(frameCount.numerator) % 2n !== 0n) {
      semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_CUT", "MatchTransition duration must be an even count of 4 through 600 composition frames.");
    }
    const half = divideRational(request.duration, rational(2));
    const outgoingWindow = { start: subtractRational(request.cut, half), duration: half };
    const incomingWindow = { start: request.cut, duration: half };
    if (compareRational(outgoingWindow.start, outgoingScene.start) < 0 || compareRational(addRational(incomingWindow.start, incomingWindow.duration), addRational(incomingScene.start, incomingScene.duration)) > 0) {
      semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_CUT", "Each centered MatchTransition half-window must fit completely inside its owning scene.");
    }
    const transitionStart = outgoingWindow.start, transitionEnd = addRational(incomingWindow.start, incomingWindow.duration);
    for (const sceneId of composition.sceneIds) {
      if (sceneId === outgoingScene.id || sceneId === incomingScene.id) continue;
      const scene = context.ir.scenes[sceneId];
      if (scene && compareRational(scene.start, transitionEnd) < 0 && compareRational(addRational(scene.start, scene.duration), transitionStart) > 0) {
        semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_CUT", "MatchTransition active windows cannot overlap a third scene; the boundary must remain a hard two-scene cut.");
      }
    }
    const sameBasis = outgoing.basis.width === incoming.basis.width
      && outgoing.basis.height === incoming.basis.height
      && compareRational(outgoing.basis.origin.x, incoming.basis.origin.x) === 0
      && compareRational(outgoing.basis.origin.y, incoming.basis.origin.y) === 0;
    if (!sameBasis) semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_BASIS", "MatchTransition outgoing and incoming LocalSpace width, height, and origin must match exactly.");
    const cameraHasSignal = (subject: IRSemanticMatchSubjectV1, fields: readonly string[]) => fields.some((field) => {
      const value = context.ir.nodes[subject.cameraNodeId]?.properties[field];
      return value !== undefined && "signal" in value;
    });
    if (request.velocity === "carry" && (cameraHasSignal(outgoing, ["x", "y"]) || cameraHasSignal(incoming, ["x", "y"]))) {
      semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_VELOCITY", "MatchTransition velocity: carry requires static authored Camera2D x/y throughout both active half-windows.");
    }
    const staticPose = (subject: IRSemanticMatchSubjectV1) => {
      const camera = context.ir.nodes[subject.cameraNodeId]!;
      if (cameraHasSignal(subject, ["x", "y", "scale", "rotation"])) return undefined;
      const exact = (field: "x" | "y" | "scale" | "rotation", dimension: string, fallback: Rational) => valueRational(camera.inputs[field], dimension) ?? fallback;
      return { x: exact("x", "length", zeroRational), y: exact("y", "length", zeroRational), scale: exact("scale", "scalar", rational(1)), rotation: exact("rotation", "angle", zeroRational) };
    };
    const outgoingPose = staticPose(outgoing), incomingPose = staticPose(incoming);
    const samePose = (pose: NonNullable<typeof outgoingPose>) => compareRational(pose.x, request.target.x) === 0
      && compareRational(pose.y, request.target.y) === 0
      && compareRational(pose.scale, request.target.scale) === 0
      && compareRational(pose.rotation, request.target.rotation) === 0;
    if (request.target.color === undefined && outgoingPose && incomingPose && samePose(outgoingPose) && samePose(incomingPose)) {
      semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_NOOP", "MatchTransition target equals both static native Camera2D poses and has no color convergence, so it cannot affect output.");
    }
    for (const [subject, window] of [[outgoing, outgoingWindow], [incoming, incomingWindow]] as const) {
      const existing = subjectWindows.get(subject.id) ?? [];
      const end = addRational(window.start, window.duration);
      if (existing.some((candidate) => compareRational(candidate.start, end) < 0 && compareRational(addRational(candidate.start, candidate.duration), window.start) > 0)) {
        semanticMatchCompileError(context, request.provenance.span, "CUT_MATCH_CONFLICT", `MatchSubject “${subject.authoredId}” is reused by overlapping transition windows.`);
      }
      existing.push(window); subjectWindows.set(subject.id, existing);
    }
    semanticMatches.transitions.push({
      id: stableId("semantic_match_transition", { compositionId: request.compositionId, authoredId: request.authoredId }),
      version: 1,
      kind: "semantic-match-transition",
      compositionId: request.compositionId,
      authoredId: request.authoredId,
      cut: request.cut,
      duration: request.duration,
      outgoingWindow,
      incomingWindow,
      outgoing: { sceneId: outgoing.sceneId, subjectId: outgoing.id, cameraNodeId: outgoing.cameraNodeId, localSpaceNodeId: outgoing.localSpaceNodeId },
      incoming: { sceneId: incoming.sceneId, subjectId: incoming.id, cameraNodeId: incoming.cameraNodeId, localSpaceNodeId: incoming.localSpaceNodeId },
      target: request.target,
      easing: request.easing,
      ...(request.velocity ? { velocity: request.velocity } : {}),
      provenance: request.provenance,
    });
  }
  const usedSubjects = new Set(semanticMatches.transitions.flatMap((transition) => [transition.outgoing.subjectId, transition.incoming.subjectId]));
  const unused = semanticMatches.subjects.find((subject) => !usedSubjects.has(subject.id));
  if (unused) semanticMatchCompileError(context, unused.provenance.span, "CUT_MATCH_SUBJECT", `MatchSubject “${unused.authoredId}” is unused; semantic-match v1 declarations cannot be inert.`);
}

function checkedNodeNative(
  statement: Statement,
  context: LowerContext,
) {
  if (statement.kind !== "node") return undefined;
  const resolved = context.check.expressionTypes.get(statement.expression.callee);
  return resolved?.kind === "callable" ? resolved.native : undefined;
}

function responsiveStackEscapedCameraAliases(
  statement: Extract<Statement, { kind: "node" }>,
  stackNodeId: string,
  context: LowerContext,
) {
  const stack = context.ir.nodes[stackNodeId];
  if (!stack || stack.op !== "cut.visual.responsive_stack") return [];
  return statement.body.flatMap((slotStatement, slotIndex) => {
    if (slotStatement.kind !== "node"
      || checkedNodeNative(slotStatement, context) !== "cut.visual.responsive_slot") return [];
    const directNodes = slotStatement.body.filter(
      (item): item is Extract<Statement, { kind: "node" }> => item.kind === "node",
    );
    const cameraStatement = directNodes.length === 1 ? directNodes[0] : undefined;
    if (!cameraStatement?.binding
      || checkedNodeNative(cameraStatement, context) !== cutMediaCamera2DOp) return [];
    const slot = context.ir.nodes[stack.children[slotIndex]!];
    const camera = slot?.op === "cut.visual.responsive_slot" && slot.children.length === 1
      ? context.ir.nodes[slot.children[0]!]
      : undefined;
    if (camera?.op !== cutMediaCamera2DOp) {
      userModuleCompileError(
        context,
        cameraStatement.span,
        "CUT_MEDIA_CAMERA_SCOPE",
        "ResponsiveSlot camera alias lost its exact camera-to-slot-to-stack lowering context.",
      );
    }
    return [{
      name: cameraStatement.binding,
      statement: cameraStatement,
      nodeId: camera.id,
      domain: camera.domain,
    }];
  });
}

function transcriptBindingFromValue(
  value: IRValue | undefined,
  context: LowerContext,
  span: SourceSpan,
  consumer: "TranscriptAudio" | "TranscriptCaptions" | "TranscriptPicture",
) {
  const bindingId = value?.kind === "object"
    && value.entries.__transcriptBindingId?.kind === "string"
    ? value.entries.__transcriptBindingId.value
    : undefined;
  if (!bindingId) {
    transcriptCompileError(
      context,
      span,
      "CUT_TRANSCRIPT_BINDING",
      `${consumer} edit must resolve directly to one scene-local transcriptEdit let binding.`,
    );
  }
  const binding = context.ir.transcriptBindings
    ?.find((candidate) => candidate.id === bindingId);
  if (!binding || binding.compositionId !== context.timeline.id || binding.sceneId !== context.scene?.id) {
    transcriptCompileError(
      context,
      span,
      "CUT_TRANSCRIPT_BINDING",
      `${consumer} must consume a transcriptEdit declared in the same scene.`,
    );
  }
  return binding;
}

function lowerTranscriptPictureNodeInputs(
  inputs: Record<string, IRValue>,
  context: LowerContext,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
) {
  const binding = transcriptBindingFromValue(
    inputs.edit,
    context,
    expression.span,
    "TranscriptPicture",
  );
  const sourceReference = inputs.source;
  const pictureResource = sourceReference?.kind === "resource-ref"
    ? context.ir.resources[sourceReference.id]
    : undefined;
  if (sourceReference?.kind !== "resource-ref" || pictureResource?.kind !== "video") {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "source"),
      "CUT_TRANSCRIPT_RESOURCE",
      "TranscriptPicture source must resolve to one declared VideoAsset.",
    );
  }
  const audioResource = context.ir.resources[binding.audioResourceId];
  if (!audioResource || audioResource.kind !== "audio") {
    throw new Error("Checked TranscriptPicture lost its transcript AudioAsset.");
  }
  const authority = binding.mediaAuthorityId === undefined
    ? undefined
    : context.ir.transcriptMediaAuthorities
      ?.find((candidate) => candidate.id === binding.mediaAuthorityId);
  if (binding.mediaAuthorityId !== undefined
    && (!authority
      || authority.compositionId !== binding.compositionId
      || authority.sceneId !== binding.sceneId)) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "edit"),
      "CUT_TRANSCRIPT_MEDIA",
      "TranscriptPicture edit references a missing or foreign-scene transcript media authority.",
    );
  }
  const videoStreamIndex = authority?.videoStreamIndex
    ?? binding.media.videoStreamIndex;
  const videoFrameRate = authority?.videoFrameRate
    ?? binding.media.videoFrameRate;
  const videoDuration = authority?.videoDuration
    ?? binding.media.videoDuration;
  if (videoStreamIndex === undefined
    || videoFrameRate === undefined
    || videoDuration === undefined) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "edit"),
      "CUT_TRANSCRIPT_MEDIA",
      "TranscriptPicture requires authenticated videoStreamIndex, videoFrameRate, and independently probed videoDuration provenance in the cut-transcript v1 sidecar.",
    );
  }
  if (authority
    ? pictureResource.id !== authority.videoResourceId
    : pictureResource.locator !== audioResource.locator) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "source"),
      "CUT_TRANSCRIPT_MEDIA",
      authority
        ? `TranscriptPicture source must be the exact independently authenticated VideoAsset ${authority.videoResourceId}.`
        : "TranscriptPicture VideoAsset must use the exact same project-relative media locator as the TranscriptEdit AudioAsset; v1 never guesses synchronization across separate files.",
    );
  }
  if (pictureResource.streamSelection?.video !== videoStreamIndex) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "source"),
      "CUT_TRANSCRIPT_MEDIA",
      `TranscriptPicture VideoAsset must explicitly select authenticated video stream ${videoStreamIndex}.`,
    );
  }
  if (!authority
    && compareRational(videoFrameRate, context.timeline.fps) !== 0) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "edit"),
      "CUT_TRANSCRIPT_PICTURE_TIME",
      `TranscriptPicture v1 requires sidecar video rate ${videoFrameRate.numerator}/${videoFrameRate.denominator} fps to exactly equal the owning composition rate ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps.`,
    );
  }
  if (compareRational(context.localTime, binding.destinationRange.start) !== 0) {
    transcriptCompileError(
      context,
      expression.span,
      "CUT_TRANSCRIPT_PICTURE_TIME",
      "TranscriptPicture must begin at its TranscriptEdit destination start; use an explicit preceding Gap to place the PictureTrack cursor.",
    );
  }
  const absoluteDestinationStart = addRational(
    context.scene?.start ?? zeroRational,
    binding.destinationRange.start,
  );
  if (multiplyRational(absoluteDestinationStart, context.timeline.fps).denominator !== "1") {
    transcriptCompileError(
      context,
      expression.span,
      "CUT_TRANSCRIPT_PICTURE_TIME",
      `TranscriptPicture destination start must land on the owning ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps composition frame grid.`,
    );
  }
  let pictureRange;
  try {
    const videoSourceRange = authority
      ? cutTranscriptMediaVideoSourceRange(binding.sourceRange, authority)
      : cutTranscriptPictureVideoSourceRange(
        binding.sourceRange,
        binding.media.audioVideoPresentationDelta ?? zeroRational,
        videoDuration,
      );
    pictureRange = cutTranscriptPictureCoverRange(
      videoSourceRange,
      videoFrameRate,
      videoDuration,
    );
  } catch (error) {
    if (error instanceof CutTranscriptMediaAuthorityError) {
      transcriptCompileError(
        context,
        transcriptArgumentSpan(expression, symbol, "edit"),
        "CUT_TRANSCRIPT_PICTURE_TIME",
        error.message.replace(/^CUT_TRANSCRIPT_MEDIA_AUTHORITY:\s*/u, ""),
      );
    }
    if (!(error instanceof CutTranscriptPictureSnapError)) throw error;
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "edit"),
      error.code,
      error.message.replace(/^CUT_TRANSCRIPT_PICTURE_TIME:\s*/u, ""),
    );
  }
  const hasDuration = inputs.duration !== undefined;
  const hasRate = inputs.rate !== undefined;
  if (!authority && (hasDuration || hasRate)) {
    transcriptCompileError(
      context,
      hasDuration
        ? transcriptArgumentSpan(expression, symbol, "duration")
        : transcriptArgumentSpan(expression, symbol, "rate"),
      "CUT_TRANSCRIPT_PICTURE_TIME",
      "Explicit TranscriptPicture duration/rate is admitted only with an authenticated transcriptMedia authority; legacy co-located v1 remains forward one-times.",
    );
  }
  if (hasDuration !== hasRate) {
    transcriptCompileError(
      context,
      hasDuration
        ? transcriptArgumentSpan(expression, symbol, "rate")
        : transcriptArgumentSpan(expression, symbol, "duration"),
      "CUT_TRANSCRIPT_PICTURE_TIME",
      "Authority-backed TranscriptPicture requires duration and rate together so the ordinary source-duration equation is explicit.",
    );
  }
  let destinationDuration = pictureRange.duration;
  let pictureRate: Rational | undefined;
  if (hasDuration && hasRate) {
    destinationDuration = valueRational(inputs.duration, "time")!;
    pictureRate = valueRational(inputs.rate, "scalar")!;
    if (compareRational(destinationDuration, zeroRational) <= 0
      || compareRational(pictureRate, rational(1, 64)) < 0
      || compareRational(pictureRate, rational(64)) > 0) {
      transcriptCompileError(
        context,
        expression.span,
        "CUT_TRANSCRIPT_PICTURE_TIME",
        "Authority-backed TranscriptPicture duration must be positive and rate must be from 1/64 through 64.",
      );
    }
    if (compareRational(
      multiplyRational(destinationDuration, pictureRate),
      pictureRange.duration,
    ) !== 0) {
      transcriptCompileError(
        context,
        expression.span,
        "CUT_TRANSCRIPT_PICTURE_TIME",
        `TranscriptPicture source cover ${pictureRange.duration.numerator}/${pictureRange.duration.denominator}s must exactly equal duration ${destinationDuration.numerator}/${destinationDuration.denominator}s multiplied by rate ${pictureRate.numerator}/${pictureRate.denominator}.`,
      );
    }
  }
  const absoluteDestinationEnd = addRational(
    absoluteDestinationStart,
    destinationDuration,
  );
  if (multiplyRational(
    absoluteDestinationEnd,
    context.timeline.fps,
  ).denominator !== "1") {
    transcriptCompileError(
      context,
      hasDuration
        ? transcriptArgumentSpan(expression, symbol, "duration")
        : transcriptArgumentSpan(expression, symbol, "edit"),
      "CUT_TRANSCRIPT_PICTURE_TIME",
      authority
        ? `TranscriptPicture destination end must land on the owning ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps composition frame grid; supply an exact duration/rate pair for cross-cadence media.`
        : `TranscriptPicture destination end must land on the owning ${context.timeline.fps.numerator}/${context.timeline.fps.denominator} fps composition frame grid.`,
    );
  }
  const effectiveTimeMap = {
    kind: "constant" as const,
    direction: "forward" as const,
    rate: pictureRate ?? rational(1),
  };
  const { edit: _edit, source: _source, duration: _duration, rate: _rate, ...appearance } = inputs;
  void _edit;
  void _source;
  void _duration;
  void _rate;
  if (authority) {
    const mappedSourceInterval = {
      start: pictureRange.start,
      duration: pictureRange.duration,
    };
    const originIdentity = cutTranscriptPictureOriginIdentity({
      transcriptBindingId: binding.id,
      transcriptMediaAuthorityId: authority.id,
      transcriptMediaAuthorityIdentity: authority.identity,
      audioResourceId: binding.audioResourceId,
      pictureResourceId: sourceReference.id,
      mappedSourceRange: mappedSourceInterval,
      destinationRange: {
        start: binding.destinationRange.start,
        duration: destinationDuration,
      },
      timeMap: effectiveTimeMap,
      ...(binding.linkId === undefined ? {} : { linkId: binding.linkId }),
    });
    const destination = {
      start: binding.destinationRange.start,
      duration: destinationDuration,
    };
    const segmentIdentity = cutTranscriptPictureSegmentIdentity({
      transcriptPictureOriginIdentity: originIdentity,
      sourceRange: mappedSourceInterval,
      destinationRange: destination,
      timeMap: effectiveTimeMap,
    });
    return {
      source: sourceReference,
      range: intervalValue(pictureRange),
      duration: timeValue(destinationDuration),
      ...(pictureRate === undefined ? {} : { rate: inputs.rate! }),
      ...appearance,
      ...(binding.linkId === undefined
        ? {}
        : { link: { kind: "string", value: binding.linkId } as IRValue }),
      transcriptBindingId: { kind: "string", value: binding.id } as IRValue,
      transcriptMediaAuthorityId: {
        kind: "string",
        value: authority.id,
      } as IRValue,
      transcriptPictureOriginIdentity: {
        kind: "string",
        value: originIdentity,
      } as IRValue,
      transcriptPictureSegmentIdentity: {
        kind: "string",
        value: segmentIdentity,
      } as IRValue,
    };
  }
  const pictureIdentity = cutTranscriptPictureIdentity({
    transcriptBindingId: binding.id,
    audioResourceId: binding.audioResourceId,
    pictureResourceId: sourceReference.id,
    mediaSha256: binding.media.sha256,
    videoStreamIndex,
    videoFrameRate,
    videoDuration,
    ...(binding.media.audioVideoPresentationDelta === undefined
      ? {}
      : {
        audioVideoPresentationDelta:
          binding.media.audioVideoPresentationDelta,
      }),
    sourceRange: binding.sourceRange,
    destinationStart: binding.destinationRange.start,
    pictureRange,
    ...(binding.linkId === undefined ? {} : { linkId: binding.linkId }),
  });
  return {
    source: sourceReference,
    range: intervalValue(pictureRange),
    duration: timeValue(pictureRange.duration),
    ...appearance,
    ...(binding.linkId === undefined
      ? {}
      : { link: { kind: "string", value: binding.linkId } as IRValue }),
    transcriptBindingId: { kind: "string", value: binding.id } as IRValue,
    transcriptPictureIdentity: { kind: "string", value: pictureIdentity } as IRValue,
  };
}

function timeValue(value: Rational): IRValue {
  return { kind: "quantity", dimension: "time", magnitude: value, unit: "s" };
}

function intervalValue(interval: IREditorialInterval): IRValue {
  return {
    kind: "range",
    start: timeValue(interval.start),
    end: timeValue(addRational(interval.start, interval.duration)),
    exclusive: true,
  };
}

function lowerTranscriptAudioNodeInputs(
  inputs: Record<string, IRValue>,
  context: LowerContext,
  span: SourceSpan,
) {
  const binding = transcriptBindingFromValue(inputs.edit, context, span, "TranscriptAudio");
  return {
    source: { kind: "resource-ref", id: binding.audioResourceId } as IRValue,
    range: intervalValue(binding.sourceRange),
    destination: intervalValue(binding.destinationRange),
    ...(inputs.fadeIn === undefined ? {} : { fadeIn: inputs.fadeIn }),
    ...(inputs.fadeOut === undefined ? {} : { fadeOut: inputs.fadeOut }),
    ...(binding.linkId === undefined ? {} : { link: { kind: "string", value: binding.linkId } as IRValue }),
    transcriptBindingId: { kind: "string", value: binding.id } as IRValue,
  };
}

function lowerTranscriptCaptionNodeInputs(
  inputs: Record<string, IRValue>,
  context: LowerContext,
  expression: Extract<Expression, { kind: "call" }>,
  symbol: PackageSymbol,
) {
  const binding = transcriptBindingFromValue(
    inputs.edit,
    context,
    expression.span,
    "TranscriptCaptions",
  );
  const maxWords = inputs.maxWords;
  if (maxWords !== undefined
    && (maxWords.kind !== "quantity"
      || maxWords.dimension !== "scalar"
      || maxWords.unit !== "scalar"
      || maxWords.magnitude.denominator !== "1"
      || compareRational(
        maxWords.magnitude,
        rational(cutTranscriptExecutableLimits.minimumCaptionMaxWords),
      ) < 0
      || compareRational(
        maxWords.magnitude,
        rational(cutTranscriptExecutableLimits.maximumCaptionMaxWords),
      ) > 0)) {
    transcriptCompileError(
      context,
      transcriptArgumentSpan(expression, symbol, "maxWords"),
      "CUT_TRANSCRIPT_LIMIT",
      `TranscriptCaptions maxWords must resolve to one exact whole Number from ${cutTranscriptExecutableLimits.minimumCaptionMaxWords} through ${cutTranscriptExecutableLimits.maximumCaptionMaxWords}; CUT never rounds caption grouping.`,
    );
  }
  const { edit: _edit, ...appearance } = inputs;
  void _edit;
  return {
    ...appearance,
    transcriptBindingId: { kind: "string", value: binding.id } as IRValue,
    transcriptCaptionIdentity: {
      kind: "string",
      value: hash({
        selectedIdsSha256: binding.selectedIdsSha256,
        text: binding.text,
        words: binding.words,
        sourceRange: binding.sourceRange,
        destinationRange: binding.destinationRange,
      }),
    } as IRValue,
  };
}

function reconcileTranscriptTimelineCaptionIdentities(context: LowerContext) {
  for (const node of Object.values(context.ir.nodes)) {
    if (node.op !== "cut.visual.transcript_captions") continue;
    const bindingId = node.inputs.transcriptBindingId;
    const binding = bindingId?.kind === "string"
      ? context.ir.transcriptBindings?.find((candidate) =>
        candidate.id === bindingId.value)
      : undefined;
    if (!binding) throw new Error("Checked TranscriptCaptions lost its transcript binding during TimelineEdit reconciliation.");
    try {
      node.inputs.transcriptCaptionIdentity = {
        kind: "string",
        value: cutTranscriptCaptionIdentity(context.ir, binding),
      };
    } catch (error) {
      if (!(error instanceof CutTranscriptTimelineCaptionError)) throw error;
      transcriptCompileError(
        { ...context, moduleName: node.provenance.module },
        node.provenance.span,
        error.code,
        error.message,
      );
    }
  }
}

const editorialMetadataKeyPattern = /^(?![Cc][Uu][Tt]\.)(?:[A-Za-z][A-Za-z0-9_-]*\.)+[A-Za-z][A-Za-z0-9_-]*$/u;
const editorialAuthoringOps = new Set([
  "cut.edit.picture_track",
  "cut.edit.audio_track",
  "cut.edit.picture_clip",
  "cut.visual.precomp",
  "cut.audio.clip",
  "cut.edit.audio_region",
]);

function consumeEditorialAuthoringAttributes(
  inputs: Record<string, IRValue>,
  authoredOp: string,
  expression: Extract<Expression, { kind: "call" }>,
  context: LowerContext,
): Pick<EditorialAuthoringAttributes, "role" | "metadata"> {
  if (!editorialAuthoringOps.has(authoredOp)) return {};
  const spanFor = (name: string) =>
    expression.named.find((argument) => argument.name === name)?.value.span
      ?? expression.span;
  const result: Pick<EditorialAuthoringAttributes, "role" | "metadata"> = {};
  const role = inputs.role;
  if (role !== undefined) {
    if (role.kind !== "string" || role.value.length < 1 || role.value.length > 64) {
      timelineEditCompileError(
        context,
        spanFor("role"),
        "CUT_TIMELINE_EDIT_METADATA",
        "editorial role must be one non-empty closed role token of at most 64 characters.",
      );
    }
    result.role = role.value;
    delete inputs.role;
  }
  const metadata = inputs.metadata;
  if (metadata === undefined) return result;
  delete inputs.metadata;
  if (metadata.kind !== "object"
    || Object.keys(metadata.entries).length !== 1
    || metadata.entries.entries?.kind !== "array") {
    timelineEditCompileError(
      context,
      spanFor("metadata"),
      "CUT_TIMELINE_EDIT_METADATA",
      "editorial metadata must be constructed by editorialMetadata(entries: [...]).",
    );
  }
  const entries = metadata.entries.entries.items;
  if (entries.length < 1 || entries.length > 64) {
    timelineEditCompileError(
      context,
      spanFor("metadata"),
      "CUT_TIMELINE_EDIT_LIMIT",
      "editorial metadata requires 1 through 64 unique namespaced entries.",
    );
  }
  const values: Record<string, string> = {};
  let encodedBytes = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== "object"
      || Object.keys(entry.entries).length !== 2
      || entry.entries.key?.kind !== "string"
      || entry.entries.value?.kind !== "string") {
      timelineEditCompileError(
        context,
        spanFor("metadata"),
        "CUT_TIMELINE_EDIT_METADATA",
        `editorial metadata entry ${index} must be editorialMetadataEntry(key: String, value: String).`,
      );
    }
    const key = entry.entries.key.value;
    const value = entry.entries.value.value;
    if (!editorialMetadataKeyPattern.test(key) || key.length > 128) {
      timelineEditCompileError(
        context,
        spanFor("metadata"),
        "CUT_TIMELINE_EDIT_METADATA",
        `editorial metadata key ${JSON.stringify(key)} must be a non-CUT dotted namespace with bounded safe segments.`,
      );
    }
    if (Object.hasOwn(values, key)) {
      timelineEditCompileError(
        context,
        spanFor("metadata"),
        "CUT_TIMELINE_EDIT_METADATA",
        `editorial metadata key ${JSON.stringify(key)} is duplicated.`,
      );
    }
    if (value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
      timelineEditCompileError(
        context,
        spanFor("metadata"),
        "CUT_TIMELINE_EDIT_METADATA",
        `editorial metadata value for ${JSON.stringify(key)} must contain at most 1024 printable characters.`,
      );
    }
    encodedBytes += new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength;
    if (encodedBytes > 16_384) {
      timelineEditCompileError(
        context,
        spanFor("metadata"),
        "CUT_TIMELINE_EDIT_LIMIT",
        "editorial metadata exceeds the 16384-byte UTF-8 payload ceiling.",
      );
    }
    values[key] = value;
  }
  result.metadata = Object.freeze(values);
  return result;
}

function lowerNode(statement: Extract<Statement, { kind: "node" }>, context: LowerContext): { id: string; domain: NodeDomain } {
  consumeBudget(context, "nodes");
  const name = calleeName(statement.expression.callee) ?? "anonymous"; const checked = context.check.symbols.get(name); const user = checked?.declaration?.kind === "component" ? checked.declaration : undefined;
  const imported = context.check.imports.get(name);
  const importedUser = context.check.userImports.get(name);
  const userImplementation = importedUser?.symbol.kind === "component"
    ? context.userModules?.modules.get(importedUser.specifier)?.exports.get(importedUser.imported)
    : undefined;
  const externalImplementation = imported
    ? context.externalPackages?.implementations.get(cutPackageImplementationKey(imported.specifier, imported.imported))
    : undefined;
  let lowered: { id: string; domain: NodeDomain };
  if (userImplementation) {
    if (userImplementation.declaration?.kind !== "component") throw new Error(`Checked CUT component ${importedUser!.specifier}#${importedUser!.imported} lost its implementation.`);
    lowered = lowerUserComponent(userImplementation.declaration, statement.expression, context, statement.body, {
      check: userImplementation.check,
      moduleName: userImplementation.moduleName,
      isolateLexicalScope: true,
      lexicalEnvironment: userImplementation.environment,
      publicSymbol: importedUser!.imported,
    });
  }
  else if (externalImplementation) {
    const externalCheck = context.externalChecks?.get(externalImplementation.specifier);
    if (!externalCheck) throw new Error(`Verified CUT package ${externalImplementation.specifier} has no checked implementation context.`);
    lowered = lowerUserComponent(externalImplementation.declaration, statement.expression, context, statement.body, {
      check: externalCheck,
      moduleName: externalImplementation.moduleName,
      isolateLexicalScope: true,
      publicSymbol: externalImplementation.exported,
    });
  }
  else if (user) lowered = lowerUserComponent(user, statement.expression, context, statement.body);
  else {
    const packageSymbol = imported?.symbol ?? checked?.packageSymbol;
    const domain = packageSymbol?.domain ?? nodeDomain(context.check.expressionTypes.get(statement.expression)!) ?? "av";
    const authoredOp = packageSymbol?.native ?? name;
    const id = semanticId(context, "node", { op: authoredOp });
    let inputs = callArguments(statement.expression, packageSymbol, context); const effects = [packageSymbol?.effect ?? "pure"];
    const authoredId = (name: "trackId" | "editId") => {
      const value = inputs[name];
      if (value === undefined) return undefined;
      if (value.kind !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value.value)) {
        timelineEditCompileError(
          context,
          statement.expression.named.find((argument) => argument.name === name)?.value.span ?? statement.expression.span,
          "CUT_TIMELINE_EDIT_SHAPE",
          `${name} must be a stable identifier beginning with an ASCII letter and containing at most 128 safe characters.`,
        );
      }
      delete inputs[name];
      return value.value;
    };
    const authoredTrackId = authoredOp === "cut.edit.picture_track" || authoredOp === "cut.edit.audio_track"
      ? authoredId("trackId")
      : undefined;
    const authoredEditId = authoredOp === "cut.edit.picture_clip"
      || authoredOp === "cut.visual.precomp"
      || authoredOp === "cut.audio.clip"
      || authoredOp === "cut.edit.audio_region"
      ? authoredId("editId")
      : undefined;
    const authoredEditorial = consumeEditorialAuthoringAttributes(
      inputs,
      authoredOp,
      statement.expression,
      context,
    );
    let op = authoredOp;
    if (authoredOp === "cut.edit.transcript_audio") {
      inputs = lowerTranscriptAudioNodeInputs(inputs, context, statement.expression.span);
      op = "cut.audio.clip";
    } else if (authoredOp === "cut.edit.transcript_picture") {
      if (!packageSymbol) {
        throw new Error("Checked TranscriptPicture lost its package signature.");
      }
      inputs = lowerTranscriptPictureNodeInputs(
        inputs,
        context,
        statement.expression,
        packageSymbol,
      );
      op = "cut.edit.picture_clip";
    } else if (authoredOp === "cut.visual.transcript_captions") {
      if (!packageSymbol) {
        throw new Error("Checked TranscriptCaptions lost its package signature.");
      }
      inputs = lowerTranscriptCaptionNodeInputs(
        inputs,
        context,
        statement.expression,
        packageSymbol,
      );
    }
    const interval = op === "cut.visual.precomp" || op === "cut.edit.nested_sequence"
      ? precompInterval(inputs, context, statement.expression.span, op === "cut.edit.nested_sequence" ? "av" : "visual")
      : op === "cut.edit.clip"
      ? linkedClipInterval(inputs, context, statement.expression.span)
      : op === "cut.edit.sequence"
        ? authoredPictureInterval("Sequence", inputs, context, statement.expression.span)
        : op === "cut.edit.picture_clip"
          ? authoredPictureInterval("PictureClip", inputs, context, statement.expression.span)
          : op === "cut.edit.gap"
            ? authoredPictureInterval("Gap", inputs, context, statement.expression.span)
            : op === "cut.audio.clip" && Object.hasOwn(inputs, "destination")
              ? authoredAudioDestinationInterval(inputs, context, statement.expression.span, "AudioClip")
              : op === "cut.edit.audio_region"
                ? authoredAudioDestinationInterval(inputs, context, statement.expression.span, "AudioRegion")
              : op === "cut.edit.audio_gap"
                ? authoredAudioDestinationInterval(inputs, context, statement.expression.span, "AudioGap")
            : { start: context.localTime, duration: context.duration };
    if (op === "cut.edit.picture_clip") {
      pictureSourceInterval(inputs, context, statement.expression.span);
      const timeMap = compilePictureTimeMap(inputs, interval, context, statement.expression.span);
      inputs = canonicalPictureTimeMapInputs(inputs, timeMap);
    }
    let pictureTrackOperation: { trackId: string; inputs: Record<string, IRValue>; finalDuration: Rational; spans: SourceSpan[] } | undefined;
    let audioTrackOperation: { trackId: string; inputs: Record<string, IRValue>; finalDuration: Rational; spans: SourceSpan[] } | undefined;
    let childDuration = interval.duration;
    if (op === "cut.edit.picture_track") {
      const hasSourceDuration = Object.hasOwn(inputs, "sourceDuration"), hasEdits = Object.hasOwn(inputs, "edits");
      if (hasSourceDuration !== hasEdits) {
        const offending = statement.expression.named.find((argument) => argument.name === (hasSourceDuration ? "sourceDuration" : "edits"))?.span ?? statement.expression.span;
        editorialCompileError(context, offending, "CUT2090", "PictureTrack sourceDuration: and edits: must be authored together; neither can be a silent no-op.");
      }
      if (hasEdits) {
        const sourceDuration = valueRational(inputs.sourceDuration, "time");
        if (!sourceDuration || compareRational(sourceDuration, zeroRational) <= 0) editorialCompileError(context, statement.expression.span, "CUT2091", "PictureTrack sourceDuration must reduce to a positive exact Time value.");
        exactPictureEditFrame(context, statement.expression.span, sourceDuration, "PictureTrack sourceDuration");
        const spans = pictureEditExpressionSpans(statement.expression);
        if (inputs.edits?.kind !== "array" || !inputs.edits.items.length || spans.length !== inputs.edits.items.length) editorialCompileError(context, statement.expression.span, "CUT2090", "PictureTrack edits must be a non-empty literal List<PictureEdit> so every operation has stable source diagnostics.");
        if (inputs.edits.items.length > 256) editorialCompileError(context, statement.expression.span, "CUT2090", "PictureTrack edit plans are bounded to 256 operations per track in the reference compiler.");
        childDuration = sourceDuration;
        pictureTrackOperation = { trackId: id, inputs, finalDuration: interval.duration, spans };
      }
    }
    if (op === "cut.edit.audio_track") {
      const hasSourceDuration = Object.hasOwn(inputs, "sourceDuration"), hasEdits = Object.hasOwn(inputs, "edits");
      if (hasSourceDuration !== hasEdits) {
        const offending = statement.expression.named.find((argument) => argument.name === (hasSourceDuration ? "sourceDuration" : "edits"))?.span ?? statement.expression.span;
        editorialCompileError(context, offending, "CUT_AUDIO_EDIT_SHAPE", "AudioTrack sourceDuration: and edits: must be authored together; neither can be a silent no-op.");
      }
      if (hasEdits) {
        const sourceDuration = valueRational(inputs.sourceDuration, "time");
        if (!sourceDuration || compareRational(sourceDuration, zeroRational) <= 0) editorialCompileError(context, statement.expression.span, "CUT_AUDIO_EDIT_TIME", "AudioTrack sourceDuration must reduce to a positive exact Time value.");
        exactAudioEditSample(context, statement.expression.span, sourceDuration, "AudioTrack sourceDuration");
        const spans = audioEditExpressionSpans(statement.expression);
        if (inputs.edits?.kind !== "array" || !inputs.edits.items.length || spans.length !== inputs.edits.items.length) editorialCompileError(context, statement.expression.span, "CUT_AUDIO_EDIT_SHAPE", "AudioTrack edits must be a non-empty literal List<AudioEdit> so every operation has stable source diagnostics.");
        if (inputs.edits.items.length > 256) editorialCompileError(context, statement.expression.span, "CUT_AUDIO_EDIT_LIMIT", "AudioTrack edit plans are bounded to 256 operations per track in the reference compiler.");
        childDuration = sourceDuration;
        audioTrackOperation = { trackId: id, inputs, finalDuration: interval.duration, spans };
      }
    }
    const childContext: LowerContext = { ...context, localTime: interval.start, duration: childDuration, bindings: new Map(context.bindings) };
    const loweredChildren = op === "cut.edit.sequence"
      ? lowerSequenceChildren(statement.body, childContext, statement.expression.span)
      : op === "cut.edit.picture_track"
        ? lowerPictureTrackChildren(statement.body, childContext, statement.expression.span, pictureTrackOperation)
        : op === "cut.edit.audio_track"
          ? lowerAudioTrackChildren(statement.body, childContext, statement.expression.span, audioTrackOperation)
        : { children: lowerStatements(statement.body, { ...childContext, directSceneStatementBlock: false, directTimelineStatementBlock: false }, false), editorial: undefined };
    const executableInterval = op === "cut.edit.transition" || op === "cut.edit.jcut" || op === "cut.edit.lcut"
      ? transitionParentInterval(context, loweredChildren.children)
      : interval;
    if (op === "cut.visual.transcript_captions") {
      const bindingId = inputs.transcriptBindingId?.kind === "string"
        ? inputs.transcriptBindingId.value
        : undefined;
      const binding = context.ir.transcriptBindings
        ?.find((candidate) => candidate.id === bindingId);
      if (!binding) {
        throw new Error("Checked TranscriptCaptions lost its transcript binding.");
      }
      const intervalEnd = addRational(
        executableInterval.start,
        executableInterval.duration,
      );
      const bindingEnd = addRational(
        binding.destinationRange.start,
        binding.destinationRange.duration,
      );
      if (compareRational(
        executableInterval.start,
        binding.destinationRange.start,
      ) > 0 || compareRational(intervalEnd, bindingEnd) < 0) {
        transcriptCompileError(
          context,
          statement.expression.span,
          "CUT_TRANSCRIPT_TIME",
          "TranscriptCaptions statement interval must contain the complete scene-local TranscriptEdit destination; move or widen the caption statement instead of clipping transcript timing implicitly.",
        );
      }
    }
    if (op === "cut.visual.responsive_stack") {
      for (const [index, slotId] of loweredChildren.children.entries()) {
        const slot = context.ir.nodes[slotId];
        const camera = slot?.op === "cut.visual.responsive_slot" && slot.children.length === 1
          ? context.ir.nodes[slot.children[0]!]
          : undefined;
        if (camera?.op !== cutMediaCamera2DOp) continue;
        if (inputs.plan === undefined) throw new Error("Checked ResponsiveStack lost its required context-bound plan.");
        try {
          camera.inputs.responsiveSlotContext = deriveCutResponsiveSlotMediaContext(
            inputs.plan,
            { stackNodeId: id, slotNodeId: slot.id, index },
            `${id}.inputs.responsiveSlotContext`,
          );
        } catch (error) {
          if (error instanceof CutResponsiveStackError && packageSymbol) {
            responsiveStackCompileError(context, statement.expression, packageSymbol, error);
          }
          throw error;
        }
      }
    }
    if (loweredChildren.editorial?.kind === "picture-track" || loweredChildren.editorial?.kind === "audio-track") {
      if (authoredTrackId) loweredChildren.editorial.trackId = authoredTrackId;
      if (authoredEditorial.role) loweredChildren.editorial.role = authoredEditorial.role;
      if (authoredEditorial.metadata) loweredChildren.editorial.metadata = { ...authoredEditorial.metadata };
    }
    const node: IRNode = { id, op, domain, ownership: "detached", ...(context.scene ? { sceneId: context.scene.id } : {}), interval: executableInterval, inputs, children: loweredChildren.children, ...(loweredChildren.editorial ? { editorial: loweredChildren.editorial } : {}), properties: {}, effects, contentHash: "", provenance: provenance(context.moduleName, statement.expression.span, imported?.imported ?? name, context.expansion) };
    node.contentHash = hash({ ...node, contentHash: undefined }); context.ir.nodes[id] = node; lowered = { id, domain };
    if (authoredTrackId || authoredEditId || authoredEditorial.role || authoredEditorial.metadata) {
      context.editorialAuthoringIds.set(id, {
        ...(authoredTrackId ? { trackId: authoredTrackId } : {}),
        ...(authoredEditId ? { editId: authoredEditId } : {}),
        ...(authoredEditorial.role ? { role: authoredEditorial.role } : {}),
        ...(authoredEditorial.metadata ? { metadata: authoredEditorial.metadata } : {}),
      });
    }
    if (op === "cut.edit.transition") validateCompiledTransition(context, node, statement.expression.span);
    if (op === "cut.edit.jcut" || op === "cut.edit.lcut") validateCompiledLinkedSplit(context, node, statement.expression.span);
    if (packageSymbol && ["analyze", "generate", "external"].includes(packageSymbol.effect)) {
      const job: IREffectJob = { id: stableId("job", { node: node.id, effect: packageSymbol.effect, op: node.op }), effect: packageSymbol.effect as IREffectJob["effect"], op: node.op, inputs, state: "unresolved", provenance: node.provenance }; context.ir.jobs.push(job);
    }
  }
  if (statement.binding && context.responsiveAnnotatedFragmentIds.has(lowered.id)) {
    userModuleCompileError(
      context,
      statement.span,
      "CUT_RESPONSIVE_STACK_GRAPH",
      "A responsive annotated component invocation cannot use “as”; its identity fragment cannot be transformed or automated.",
    );
  }
  if (statement.binding) context.bindings.set(statement.binding, { nodeId: lowered.id, domain: lowered.domain });
  const loweredNode = context.ir.nodes[lowered.id];
  if (loweredNode?.op === "cut.visual.responsive_stack") {
    const escaped = responsiveStackEscapedCameraAliases(statement, lowered.id, context);
    if (escaped.length > 1) {
      userModuleCompileError(
        context,
        escaped[1]!.statement.span,
        "CUT_MEDIA_CAMERA_SCOPE",
        "ResponsiveStack may expose at most one direct ResponsiveSlot MediaCamera2D alias to its enclosing lexical scope.",
      );
    }
    const camera = escaped[0];
    if (camera) {
      if (context.bindings.has(camera.name) || context.environment.has(camera.name)) {
        userModuleCompileError(
          context,
          camera.statement.span,
          "CUT_MEDIA_CAMERA_SCOPE",
          `ResponsiveSlot MediaCamera2D alias “${camera.name}” collides with a binding already visible in the enclosing scope.`,
        );
      }
      context.bindings.set(camera.name, { nodeId: camera.nodeId, domain: camera.domain });
    }
  }
  return lowered;
}

function lowerStatements(statements: Statement[], context: LowerContext, addRoots = true): string[] {
  const emitted: string[] = [];
  for (const statement of statements) {
    consumeBudget(context, "statements");
    if (statement.kind === "let") {
      const packageSymbol = statement.value.kind === "call" ? calledPackageSymbol(statement.value, context) : undefined;
      if (statement.value.kind === "call" && packageSymbol?.native === "cut.data.amplitude_envelope") {
        context.environment.set(statement.name, lowerAudioAmplitudeEnvelope(statement.value, packageSymbol, context));
      } else if (statement.value.kind === "call" && nodeDomain(context.check.expressionTypes.get(statement.value)!) !== undefined) {
        const lowered = lowerNode({ kind: "node", expression: statement.value, binding: statement.name, body: [], span: statement.span }, context);
        context.ir.nodes[lowered.id].ownership = "reference";
        context.environment.set(statement.name, { kind: "node-ref", id: lowered.id });
      } else {
        context.environment.set(
          statement.name,
          lowerExpression(statement.value, {
            ...context,
            directSceneLetInitializer: statement.value,
          }),
        );
      }
    }
    else if (statement.kind === "node") {
      const native = annotationStatementNative(statement, context);
      if (native === "cut.edit.marker" || native === "cut.edit.region") lowerAnnotationStatement(statement, context);
      else if (native === "cut.edit.linked_trim") lowerLinkedTrimStatement(statement, context);
      else if (native === "cut.edit.linked_ripple_delete") lowerLinkedRippleDeleteStatement(statement, context);
      else if (native === "cut.edit.timeline_edit") lowerTimelineEditStatement(statement, context);
      else if (native === "cut.edit.match_subject") lowerSemanticMatchSubjectStatement(statement, context);
      else if (native === "cut.edit.match_transition") lowerSemanticMatchTransitionStatement(statement, context);
      else {
        const node = lowerNode(statement, context); emitted.push(node.id); if (addRoots) rootNode(context, node.id, node.domain); else context.ir.nodes[node.id].ownership = "child";
      }
    } else if (statement.kind === "set") {
      const packageSymbol = statement.value.kind === "call" ? calledPackageSymbol(statement.value, context) : undefined;
      if (statement.value.kind === "call" && packageSymbol?.native && Object.hasOwn(audioReactiveMapTypes, packageSymbol.native)) {
        lowerAudioReactiveSet(statement, statement.value, packageSymbol, context);
        continue;
      }
      const target = expressionTarget(statement.target), binding = target.binding ? context.bindings.get(target.binding) : undefined;
      if (binding) {
        consumeBudget(context, "signals");
        const value = lowerExpression(statement.value, context); const signalId = semanticId(context, "signal", { kind: "set", target, time: context.localTime });
        const signal: IRSignal = { id: signalId, kind: "track", valueType: "inferred", initial: { kind: "null" }, events: [{ kind: "set", time: context.localTime, value }], contentHash: "", provenance: provenance(context.moduleName, statement.span, target.property, context.expansion) };
        signal.contentHash = cutSignalContentHash(signal); attachSignal(context, statement.target, signal);
      }
    } else if (statement.kind === "animate") {
      consumeBudget(context, "signals");
      const delay = statement.delay ? valueRational(lowerExpression(statement.delay, context), "time") ?? zeroRational : zeroRational;
      const duration = valueRational(lowerExpression(statement.duration, context), "time") ?? zeroRational; const start = addRational(context.localTime, delay), end = addRational(start, duration);
      const intervalEnd = addRational(context.localTime, context.duration);
      if (compareRational(delay, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0 || compareRational(end, intervalEnd) > 0) throw new Error("Animation delay/duration lies outside its owning interval.");
      const target = expressionTarget(statement.target); const curve = statement.easing ? lowerExpression(statement.easing, context) : intrinsicLinear;
      const signal: IRSignal = { id: semanticId(context, "signal", { kind: "animate", target }), kind: "track", valueType: "inferred", initial: { kind: "null" }, events: [{ kind: "animate", start, end, from: lowerExpression(statement.from, context), to: lowerExpression(statement.to, context), curve }], contentHash: "", provenance: provenance(context.moduleName, statement.span, target.property, context.expansion) };
      signal.contentHash = cutSignalContentHash(signal); attachSignal(context, statement.target, signal);
    } else if (statement.kind === "at") {
      const offset = valueRational(lowerExpression(statement.time, context), "time") ?? zeroRational;
      if (compareRational(offset, zeroRational) < 0 || compareRational(offset, context.duration) > 0) throw new Error("at block lies outside its owning interval.");
      emitted.push(...lowerStatements(statement.body, { ...context, directSceneStatementBlock: false, directTimelineStatementBlock: false, localTime: addRational(context.localTime, offset), duration: subtractRational(context.duration, offset), environment: cloneEnvironment(context.environment), bindings: new Map(context.bindings) }, addRoots));
    } else if (statement.kind === "if") {
      const condition = lowerExpression(statement.condition, context); if (condition.kind !== "boolean") throw new Error("CUT 0.4 if conditions must be compile-time booleans."); const selected = condition.value ? statement.consequent : statement.alternate;
      emitted.push(...lowerStatements(selected, { ...context, directSceneStatementBlock: false, directTimelineStatementBlock: false, environment: cloneEnvironment(context.environment), bindings: new Map(context.bindings) }, addRoots));
    } else if (statement.kind === "for") {
      const iterable = lowerExpression(statement.iterable, context);
      if (iterable.kind !== "array") throw new Error("CUT 0.4 for loops require a compile-time array.");
      for (const item of iterable.items) { const environment = cloneEnvironment(context.environment); environment.set(statement.item, item); emitted.push(...lowerStatements(statement.body, { ...context, directSceneStatementBlock: false, directTimelineStatementBlock: false, environment, bindings: new Map(context.bindings) }, addRoots)); }
    } else if (statement.kind === "assert") {
      if (context.budget.assertions >= context.budget.limits.maxAssertions) {
        context.check.diagnostics.push({
          severity: "error",
          code: "CUT_ASSERT_BUDGET",
          message: `CUT assertion set exceeds maxAssertions=${context.budget.limits.maxAssertions}.`,
          span: statement.span,
          ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
        });
        throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
      }
      consumeBudget(context, "assertions");
      const expression = lowerExpression(statement.condition, context); const assertion: IRAssertion = { id: semanticId(context, "assert", { expression, message: statement.message ?? null }), expression, message: statement.message, status: expression.kind === "boolean" ? expression.value ? "pass" : "fail" : "deferred", provenance: provenance(context.moduleName, statement.span, undefined, context.expansion) }; context.ir.assertions.push(assertion);
    }
  }
  return emitted;
}

function resolveCompiledAssertions(ir: CutAVIR, check: CheckResult) {
  const report = evaluateCutDomainAssertions(ir);
  if (report.diagnostic && report.results.length === 0) {
    check.diagnostics.push({
      severity: "error",
      code: report.diagnostic.code,
      message: report.diagnostic.message,
      span: ir.assertions[0]?.provenance.span ?? check.module.span,
      ...(report.diagnostic.source.module === "project.cut" ? {} : { module: report.diagnostic.source.module }),
    });
    throw new CutCompileError(check, report.diagnostic.source.module === "project.cut" ? undefined : report.diagnostic.source.module);
  }
  for (let index = 0; index < ir.assertions.length; index += 1) {
    const assertion = ir.assertions[index]!;
    const result = report.results[index]!;
    if (result.status === "error") {
      check.diagnostics.push({
        severity: "error",
        code: result.diagnostic.code,
        message: result.diagnostic.message,
        span: assertion.provenance.span,
        ...(assertion.provenance.module === "project.cut" ? {} : { module: assertion.provenance.module }),
      });
      throw new CutCompileError(check, assertion.provenance.module === "project.cut" ? undefined : assertion.provenance.module);
    }
    assertion.status = result.status === "unsupported" ? "deferred" : result.status;
  }
}

function bootstrapIr(module: CutModule): CutAVIR {
  const project = module.declarations.find((item) => item.kind === "project")?.name ?? "Untitled CUT Project";
  return { format: "cut-av-ir", version: 3, language: cutLanguageVersion, compiler: cutCompilerIdentity, project, sourceHash: hash(module.source), buildId: "", determinism: { semantic: "unlocked", decodedMedia: "unverified", bitstream: "unverified" }, timebase: { defaultFps: rational(30), audioSampleRate: 48_000 }, modules: [], resources: {}, compositions: [], scenes: {}, nodes: {}, signals: {}, jobs: [], outputs: [], assertions: [] };
}

function resourceKind(op: string): IRResource["kind"] | undefined {
  return op === "cut.asset.video" ? "video"
    : op === "cut.asset.audio" ? "audio"
      : op === "cut.asset.image" ? "image"
        : op === "cut.asset.font" ? "font"
          : ["cut.asset.data", "cut.asset.caption", "cut.asset.transcript", "cut.asset.lut"].includes(op) ? "data"
            : undefined;
}

function expressionDependencies(expression: Expression, topLevelNames: Set<string>, result = new Set<string>(), shadowed = new Set<string>()): Set<string> {
  if (expression.kind === "identifier") { if (!shadowed.has(expression.name) && topLevelNames.has(expression.name)) result.add(expression.name); return result; }
  if (["number", "string", "boolean", "null", "color"].includes(expression.kind)) return result;
  if (expression.kind === "array") expression.items.forEach((item) => expressionDependencies(item, topLevelNames, result, shadowed));
  else if (expression.kind === "object") expression.entries.forEach((entry) => expressionDependencies(entry.value, topLevelNames, result, shadowed));
  else if (expression.kind === "member") expressionDependencies(expression.object, topLevelNames, result, shadowed);
  else if (expression.kind === "index") { expressionDependencies(expression.object, topLevelNames, result, shadowed); expressionDependencies(expression.index, topLevelNames, result, shadowed); }
  else if (expression.kind === "range") { expressionDependencies(expression.start, topLevelNames, result, shadowed); expressionDependencies(expression.end, topLevelNames, result, shadowed); }
  else if (expression.kind === "group" || expression.kind === "unary") expressionDependencies(expression.value, topLevelNames, result, shadowed);
  else if (expression.kind === "binary") { expressionDependencies(expression.left, topLevelNames, result, shadowed); expressionDependencies(expression.right, topLevelNames, result, shadowed); }
  else if (expression.kind === "call") { expressionDependencies(expression.callee, topLevelNames, result, shadowed); expression.positional.forEach((item) => expressionDependencies(item, topLevelNames, result, shadowed)); expression.named.forEach((item) => expressionDependencies(item.value, topLevelNames, result, shadowed)); }
  return result;
}

function expressionNames(expression: Expression, result = new Set<string>()): Set<string> {
  if (expression.kind === "identifier") { result.add(expression.name); return result; }
  if (["number", "string", "boolean", "null", "color"].includes(expression.kind)) return result;
  if (expression.kind === "array") expression.items.forEach((item) => expressionNames(item, result));
  else if (expression.kind === "object") expression.entries.forEach((entry) => expressionNames(entry.value, result));
  else if (expression.kind === "member") expressionNames(expression.object, result);
  else if (expression.kind === "index") { expressionNames(expression.object, result); expressionNames(expression.index, result); }
  else if (expression.kind === "range") { expressionNames(expression.start, result); expressionNames(expression.end, result); }
  else if (expression.kind === "group" || expression.kind === "unary") expressionNames(expression.value, result);
  else if (expression.kind === "binary") { expressionNames(expression.left, result); expressionNames(expression.right, result); }
  else if (expression.kind === "call") { expressionNames(expression.callee, result); expression.positional.forEach((item) => expressionNames(item, result)); expression.named.forEach((item) => expressionNames(item.value, result)); }
  return result;
}

function resolveTopLevelValues(module: CutModule, context: LowerContext) {
  const declarations = module.declarations.filter((item): item is Extract<Declaration, { kind: "asset" | "const" }> => item.kind === "asset" || item.kind === "const");
  const byName = new Map(declarations.map((item) => [item.name, item])); const names = new Set(byName.keys());
  const functions = new Map(module.declarations.filter((item): item is Extract<Declaration, { kind: "function" }> => item.kind === "function").map((item) => [item.name, item]));
  const valueDependencies = (expression: Expression) => {
    const dependencies = expressionDependencies(expression, names), visitedFunctions = new Set<string>();
    const visit = (candidate: Expression) => {
      for (const name of expressionNames(candidate)) {
        const declaration = functions.get(name);
        if (!declaration || visitedFunctions.has(name)) continue;
        visitedFunctions.add(name);
        expressionDependencies(declaration.value, names, dependencies, new Set(declaration.parameters.map((parameter) => parameter.name)));
        visit(declaration.value);
      }
    };
    visit(expression);
    return dependencies;
  };
  const state = new Map<string, "visiting" | "done">(); const stack: string[] = []; const constants = new Map<string, IRValue>();
  const resolveOne = (name: string) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") { const start = stack.indexOf(name); throw new Error(`CUT top-level value cycle: ${[...stack.slice(start), name].join(" -> ")}.`); }
    const declaration = byName.get(name)!; state.set(name, "visiting"); stack.push(name);
    for (const dependency of valueDependencies(declaration.value)) resolveOne(dependency);
    const value = lowerExpression(declaration.value, context);
    if (declaration.kind === "asset") {
      consumeBudget(context, "resources");
      if (value.kind !== "call") throw new Error(`CUT asset “${name}” must be a direct asset-constructor call.`);
      const kind = resourceKind(value.op), locator = literalString(value.positional[0] ?? value.named.path);
      if (!kind || !locator) throw new Error(`CUT asset “${name}” must resolve to a known asset constructor with a literal project-local path.`);
      let byteAuthority: IRResource["byteAuthority"];
      try {
        const format = literalString(value.positional[1] ?? value.named.format);
        byteAuthority = cutTypedDataAssetAuthorityForConstructor(value.op, format);
      } catch (error) {
        if (!(error instanceof CutTypedDataAssetAuthorityError)) throw error;
        context.check.diagnostics.push({
          severity: "error",
          code: error.code,
          message: error.message,
          span: declaration.span,
          ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
        });
        throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
      }
      // `proxy` is the second declared parameter of video()/audio(), so both
      // positional and named calls are public syntax. Keep lowering aligned
      // with the checker instead of silently discarding an accepted
      // positional proxy.
      const proxyValue = value.op === "cut.asset.video" || value.op === "cut.asset.audio"
        ? value.positional[1] ?? value.named.proxy
        : undefined;
      const proxyLocator = proxyValue ? literalString(proxyValue) : undefined;
      if (proxyValue && !proxyLocator) throw new Error(`CUT asset “${name}” proxy must resolve to a literal project-local path.`);
      if (proxyLocator && kind !== "video" && kind !== "audio") throw new Error(`CUT asset “${name}” cannot attach a proxy to ${kind} bytes.`);
      const mediaStreamIndex = (candidate: IRValue | undefined, parameter: string): number | undefined => {
        if (candidate === undefined) return undefined;
        const magnitude = candidate.kind === "quantity" && candidate.dimension === "scalar" ? candidate.magnitude : undefined;
        const integer = magnitude?.denominator === "1" ? BigInt(magnitude.numerator) : undefined;
        if (integer === undefined || integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
          context.check.diagnostics.push({
            severity: "error",
            code: "CUT_MEDIA_STREAM_SELECTOR",
            message: `${value.op.endsWith(".video") ? "video" : "audio"} ${parameter} must resolve to a non-negative safe integer absolute ffprobe/ffmpeg stream index; CUT never rounds a selector.`,
            span: declaration.span,
            ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
          });
          throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
        }
        return Number(integer);
      };
      const argument = (position: number, parameter: string) => value.positional[position] ?? value.named[parameter];
      const masterSelection = kind === "video"
        ? {
            ...(argument(2, "videoStream") === undefined ? {} : { video: mediaStreamIndex(argument(2, "videoStream"), "videoStream")! }),
            ...(argument(3, "audioStream") === undefined ? {} : { audio: mediaStreamIndex(argument(3, "audioStream"), "audioStream")! }),
          }
        : kind === "audio"
          ? { ...(argument(2, "stream") === undefined ? {} : { audio: mediaStreamIndex(argument(2, "stream"), "stream")! }) }
          : {};
      const proxySelection = kind === "video"
        ? {
            ...(argument(4, "proxyVideoStream") === undefined ? {} : { video: mediaStreamIndex(argument(4, "proxyVideoStream"), "proxyVideoStream")! }),
            ...(argument(5, "proxyAudioStream") === undefined ? {} : { audio: mediaStreamIndex(argument(5, "proxyAudioStream"), "proxyAudioStream")! }),
          }
        : kind === "audio"
          ? { ...(argument(3, "proxyStream") === undefined ? {} : { audio: mediaStreamIndex(argument(3, "proxyStream"), "proxyStream")! }) }
          : {};
      if (Object.keys(proxySelection).length && !proxyLocator) {
        context.check.diagnostics.push({
          severity: "error",
          code: "CUT_MEDIA_STREAM_PROXY",
          message: `${value.op.endsWith(".video") ? "video" : "audio"} proxy stream selection requires an authored proxy path.`,
          span: declaration.span,
          ...(context.moduleName === "project.cut" ? {} : { module: context.moduleName }),
        });
        throw new CutCompileError(context.check, context.moduleName === "project.cut" ? undefined : context.moduleName);
      }
      context.ir.resources[name] = {
        id: name,
        name,
        kind,
        ...(byteAuthority ? { byteAuthority } : {}),
        locator,
        ...(Object.keys(masterSelection).length ? { streamSelection: masterSelection } : {}),
        ...(proxyLocator ? { proxy: { locator: proxyLocator, ...(Object.keys(proxySelection).length ? { streamSelection: proxySelection } : {}) } } : {}),
        state: "unlocked",
        provenance: provenance(context.moduleName, declaration.span, name),
      };
      context.environment.set(name, { kind: "resource-ref", id: name });
    } else { context.environment.set(name, value); constants.set(name, value); }
    stack.pop(); state.set(name, "done");
  };
  declarations.forEach((item) => resolveOne(item.name)); return constants;
}

function injectUserModuleValues(check: CheckResult, runtimes: UserModuleRuntimeContext | undefined, environment: Environment) {
  for (const [local, imported] of check.userImports) {
    if (imported.symbol.kind !== "value") continue;
    const exported = runtimes?.modules.get(imported.specifier)?.exports.get(imported.imported);
    if (!exported?.value) throw new Error(`Checked CUT module import ${imported.specifier}#${imported.imported} lost its compile-time value.`);
    environment.set(local, exported.value);
  }
}

function prepareUserModuleRuntimes(graph: CutUserModuleGraph | undefined, base: LowerContext): UserModuleRuntimeContext | undefined {
  if (!graph) return undefined;
  const runtimeContext: UserModuleRuntimeContext = { graph, modules: new Map() };
  for (const specifier of graph.order) {
    const source = graph.modules.get(specifier);
    if (!source) throw new Error(`CUT user-module order references missing ${specifier}.`);
    if (hasTypeErrors(source.check)) throw new CutCompileError(source.check, specifier);
    const environment: Environment = new Map();
    const runtime: UserModuleRuntime = { source, environment, exports: new Map() };
    runtimeContext.modules.set(specifier, runtime);
    injectUserModuleValues(source.check, runtimeContext, environment);
    const context: LowerContext = {
      ...base,
      check: source.check,
      moduleName: specifier,
      environment,
      moduleEnvironment: environment,
      bindings: new Map(),
      expansion: [],
      functionExpansion: [],
      userModules: runtimeContext,
    };
    resolveTopLevelValues(source.module, context);
    for (const declaration of source.module.declarations) {
      if (declaration.kind !== "export") continue;
      const contract = source.check.exports.get(declaration.name);
      if (!contract) continue;
      const directName = declaration.value.kind === "identifier" ? declaration.value.name : undefined;
      const implementation = directName ? source.check.symbols.get(directName)?.declaration : undefined;
      const baseExport = { kind: contract.kind, check: source.check, moduleName: specifier, environment } as UserModuleRuntimeExport;
      if (contract.kind === "function") {
        if (implementation?.kind !== "function") throw new Error(`Checked CUT function export ${specifier}#${declaration.name} lost its declaration.`);
        runtime.exports.set(declaration.name, { ...baseExport, declaration: implementation });
      } else if (contract.kind === "component") {
        if (implementation?.kind !== "component") throw new Error(`Checked CUT component export ${specifier}#${declaration.name} lost its declaration.`);
        runtime.exports.set(declaration.name, { ...baseExport, declaration: implementation });
      } else runtime.exports.set(declaration.name, { ...baseExport, value: lowerExpression(declaration.value, context) });
    }
  }
  return runtimeContext;
}

export function compileCutModule(
  module: CutModule,
  limitOverrides: Partial<CutCompileLimits> = {},
  externalPackages?: CutExternalPackageContext,
  userModuleGraph?: CutUserModuleGraph,
  compileInputs: CutCompileInputs = {},
): { ir: CutAVIR; check: CheckResult } {
  const externalChecks = new Map<string, CheckResult>();
  if (externalPackages) {
    for (const [specifier, resolved] of [...externalPackages.modules].sort(([left], [right]) => left.localeCompare(right))) {
      const packageCheck = checkCutModule(resolved.module, { packages: externalPackages.packages });
      if (hasTypeErrors(packageCheck)) throw new CutCompileError(packageCheck, `${specifier}/${resolved.manifest.entry}`);
      externalChecks.set(specifier, packageCheck);
    }
  }
  const check = checkCutModule(module, { packages: externalPackages?.packages, userModules: userModuleGraph?.contracts, moduleKind: "entry" }); if (hasTypeErrors(check)) throw new CutCompileError(check);
  const ir = bootstrapIr(module);
  const availablePackages = new Map([...builtinPackages, ...(externalPackages?.packages ?? [])]);
  const usedPackages = new Set<string>(["cut:core", ...[...check.imports.values()].map((item) => item.specifier), ...externalChecks.keys()]);
  // TranscriptAudio is a public @cut/edit construct that deliberately lowers
  // to the ordinary cut.audio.clip kernel. Pin the owning implementation
  // package whenever that public lowering is imported so resolution never
  // depends on an unrelated explicit AudioClip import.
  if ([...check.imports.values()].some((item) => item.symbol.native === "cut.edit.transcript_audio")) {
    usedPackages.add("@cut/audio");
  }
  for (const packageCheck of externalChecks.values()) for (const imported of packageCheck.imports.values()) usedPackages.add(imported.specifier);
  for (const source of userModuleGraph?.modules.values() ?? []) for (const imported of source.check.imports.values()) usedPackages.add(imported.specifier);
  ir.modules = [...usedPackages].sort().map((specifier) => availablePackages.get(specifier)).filter((item) => item !== undefined).map((item) => ({ specifier: item.specifier, version: item.version, integrity: item.integrity }));
  if (userModuleGraph?.modules.size) ir.sourceModules = [...userModuleGraph.modules.values()]
    .map((source) => ({ specifier: source.specifier, sha256: source.sha256, bytes: source.bytes }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
  const placeholder: IRComposition = { id: "module", name: "module", width: 1920, height: 1080, fps: rational(30), sampleRate: 48_000, duration: zeroRational, sceneIds: [], rootVisualIds: [], rootAudioIds: [], rootAVIds: [], items: [], provenance: provenance("project.cut", module.span) };
  const limits = compileLimits(limitOverrides);
  const budget: CompileBudget = { limits, functionCalls: 0, values: 0, statements: 0, nodes: 0, signals: 0, assertions: 0, annotations: 0, annotationMetadataBytes: 0, resources: 0, scenes: 0, compositions: 0 };
  const moduleEnvironment: Environment = new Map();
  const context: LowerContext = { check, ir, moduleName: "project.cut", timeline: placeholder, localTime: zeroRational, duration: zeroRational, environment: moduleEnvironment, moduleEnvironment, bindings: new Map(), expansion: [], functionExpansion: [], identity: { counters: new Map() }, budget, externalPackages, externalChecks, pendingLinkedEdits: [], pendingTimelineEdits: [], pendingSemanticMatchTransitions: [], editorialAuthoringIds: new Map(), responsiveAnnotatedFragmentIds: new Set(), directSceneStatementBlock: false, directTimelineStatementBlock: false, compileInputs };
  context.userModules = prepareUserModuleRuntimes(userModuleGraph, context);
  injectUserModuleValues(check, context.userModules, moduleEnvironment);
  const topLevelConstants = resolveTopLevelValues(module, context);

  // Declare every timeline header before lowering any body. Timeline values
  // are ordinary typed references, so Precomp can use a later declaration and
  // the explicit composition-cycle validator—not source order—owns recursion.
  for (const declaration of module.declarations) {
    if (declaration.kind !== "timeline") continue;
    consumeBudget(context, "compositions");
    const fpsArgument = declaration.arguments.find((item) => item.name === "fps");
    const fps = valueRational(fpsArgument ? lowerExpression(fpsArgument.value, context) : undefined, "scalar") ?? rational(30);
    const timelineEvaluationContext: LowerContext = { ...context, timeline: { ...placeholder, fps } };
    const argumentValues = Object.fromEntries(declaration.arguments.map((item) => [item.name, lowerExpression(item.value, timelineEvaluationContext)]));
    const duration = valueRational(argumentValues.duration, "time") ?? zeroRational;
    const headerArgument = (name: "width" | "height" | "sampleRate") => declaration.arguments.find((item) => item.name === name);
    const widthArgument = headerArgument("width"), heightArgument = headerArgument("height"), sampleRateArgument = headerArgument("sampleRate");
    const width = exactTimelineHeaderInteger(context, widthArgument?.value.span ?? declaration.span, "width", valueRational(argumentValues.width, "length") ?? rational(1920), "px");
    const height = exactTimelineHeaderInteger(context, heightArgument?.value.span ?? declaration.span, "height", valueRational(argumentValues.height, "length") ?? rational(1080), "px");
    const sampleRate = exactTimelineHeaderInteger(context, sampleRateArgument?.value.span ?? declaration.span, "sampleRate", valueRational(argumentValues.sampleRate, "frequency") ?? rational(48_000), "Hz");
    if (compareRational(duration, zeroRational) <= 0 || compareRational(fps, zeroRational) <= 0) throw new Error(`Timeline “${declaration.name}” has a non-positive rate or duration.`);
    const composition: IRComposition = { id: declaration.name, name: declaration.name, width, height, fps, sampleRate, duration, sceneIds: [], rootVisualIds: [], rootAudioIds: [], rootAVIds: [], items: [], provenance: provenance("project.cut", declaration.span, declaration.name) };
    ir.compositions.push(composition); context.environment.set(declaration.name, { kind: "timeline-ref", id: composition.id });
  }

  for (const declaration of module.declarations) {
    if (declaration.kind !== "timeline") continue;
    const composition = ir.compositions.find((candidate) => candidate.id === declaration.name);
    if (!composition) throw new Error(`Internal CUT timeline header ${declaration.name} is missing.`);
    const duration = composition.duration;
    let sceneCursor = zeroRational, sceneOrdinal = 0; const timelineContext: LowerContext = { ...context, timeline: composition, duration, environment: cloneEnvironment(context.environment), bindings: new Map() };
    for (const item of declaration.items) {
      if (item.kind !== "scene") { lowerStatements([item], { ...timelineContext, directSceneStatementBlock: false, directTimelineStatementBlock: true }); continue; }
      consumeBudget(context, "scenes");
      const args = Object.fromEntries(item.arguments.map((argument) => [argument.name, lowerExpression(argument.value, timelineContext)]));
      const sceneDuration = valueRational(args.duration, "time") ?? zeroRational; const start = valueRational(args.at, "time") ?? sceneCursor;
      if (compareRational(start, zeroRational) < 0 || compareRational(sceneDuration, zeroRational) <= 0 || compareRational(addRational(start, sceneDuration), duration) > 0) throw new Error(`Scene “${item.name}” lies outside timeline “${declaration.name}”.`);
      const id = stableId("scene", { timeline: composition.id, name: item.name, ordinal: sceneOrdinal++ });
      const scene: IRScene = { id, name: item.name, start, duration: sceneDuration, rootVisualIds: [], rootAudioIds: [], rootAVIds: [], items: [], provenance: provenance("project.cut", item.span, item.name) };
      ir.scenes[id] = scene; composition.sceneIds.push(id); composition.items.push({ kind: "scene", id });
      lowerStatements(item.body, { ...timelineContext, scene, directSceneStatementBlock: true, directTimelineStatementBlock: false, localTime: zeroRational, duration: sceneDuration, environment: cloneEnvironment(timelineContext.environment), bindings: new Map(timelineContext.bindings) });
      sceneCursor = compareRational(addRational(start, sceneDuration), sceneCursor) > 0 ? addRational(start, sceneDuration) : sceneCursor;
    }
  }

  resolveSemanticMatchTransitions(context);

  if (context.pendingLinkedEdits.length) {
    try {
      commitLinkedEditStage(context, stageLinkedEditTransactions(ir, context.pendingLinkedEdits));
    } catch (error) {
      if (!(error instanceof LinkedTrimError) && !(error instanceof LinkedRippleDeleteError)) throw error;
      const request = context.pendingLinkedEdits[error.requestIndex ?? 0];
      linkedEditCompileError(
        { ...context, moduleName: request?.provenance.module ?? context.moduleName },
        request?.provenance.span ?? module.span,
        error.code,
        error.message,
      );
    }
  }

  const timelineEditClaimedTrackNodes = new Set<string>();
  for (const request of context.pendingTimelineEdits) {
    try {
      const composition = ir.compositions.find((candidate) => candidate.id === request.compositionId);
      if (!composition) {
        throw new TimelineEditError(
          "CUT_TIMELINE_EDIT_REFERENCE",
          `missing owning composition ${request.compositionId}.`,
          "$.compositionId",
        );
      }
      const operationProvenances = request.operationSpans.map((span) =>
        provenance(
          request.provenance.module,
          span,
          "TimelineEdit operation",
          [],
        ));
      const stage = stageTimelineEditIrV1(ir, {
        id: request.id,
        compositionId: request.compositionId,
        sceneId: request.sceneId,
        ...(request.duration ? { duration: request.duration } : {}),
        operations: request.operations,
        operationProvenances,
        provenance: request.provenance,
      });
      const duplicateTrack = stage.trackBindings.find((binding) =>
        timelineEditClaimedTrackNodes.has(binding.trackNodeId));
      if (duplicateTrack) {
        throw new TimelineEditError(
          "CUT_TIMELINE_EDIT_REFERENCE",
          `track ${JSON.stringify(duplicateTrack.trackId)} is already claimed by an earlier TimelineEdit transaction in this compilation; compose its operations into one atomic plan.`,
          "$.tracks",
        );
      }
      const materialization = stageTimelineEditIrMaterializationV1(ir, composition, stage);
      commitTimelineEditStage(context, stage, materialization);
      stage.trackBindings.forEach((binding) =>
        timelineEditClaimedTrackNodes.add(binding.trackNodeId));
    } catch (error) {
      if (!(error instanceof TimelineEditError)) throw error;
      const operationSpan = error.operationIndex === undefined
        ? undefined
        : request.operationSpans[error.operationIndex];
      timelineEditCompileError(
        { ...context, moduleName: request.provenance.module },
        operationSpan ?? request.provenance.span,
        error.code,
        error.message,
      );
    }
  }

  validateCompiledRetimedAudioRegionHandleOwnership(ir, check);

  // Transcript captions consume the final canonical TimelineEdit result, not
  // a second transcript-only edit model. Reconcile only after every atomic
  // track materialization has committed so the persisted identity binds the
  // exact retained whole-word destination projection.
  reconcileTranscriptTimelineCaptionIdentities(context);

  for (const composition of ir.compositions) {
    try { validateReferencePrecompGraph(ir, composition); }
    catch (error) {
      if (!(error instanceof ReferencePrecompError)) throw error;
      check.diagnostics.push({ severity: "error", code: error.code, message: error.message, span: error.node.provenance.span });
      throw new CutCompileError(check, error.node.provenance.module === "project.cut" ? undefined : error.node.provenance.module);
    }
  }

  validateEditorialLinks(ir, check);
  validateCompiledTraceContracts(ir, check);
  validateCompiledVideoInputColorContracts(ir, check);
  validateCompiledMediaCamera2DContracts(ir, check);
  validateCompiledNoOpContracts(ir, check);
  validateCompiledMotionPathContracts(ir, check);
  validateCompiledMaskContracts(ir, check);
  validateCompiledPlanarTrackMatteContracts(ir, check);
  validateCompiledChromaKeyContracts(ir, check);
  validateCompiledClipPathContracts(ir, check);
  validateCompiledMotionBlurContracts(ir, check);
  validateCompiledChartContracts(ir, check);
  validateCompiledAudioRouting(ir, check);
  validateCompiledTempoDelayContracts(ir, check);
  validateCompiledResponsiveStackContracts(ir, check, context.responsiveAnnotatedFragmentIds);
  validateCompiledCamera3DContracts(ir, check);
  validateCompiledDiagramContracts(ir, check);

  let outputOrdinal = 0;
  for (const declaration of module.declarations) {
    if (declaration.kind !== "export") continue;
    const value = lowerExpression(declaration.value, context); if (value.kind !== "call" || declaration.value.kind !== "call") continue;
    const renderSymbol = context.check.symbols.get("render")?.packageSymbol; const normalized = callArguments(declaration.value, renderSymbol, context);
    const timeline = normalized.timeline; const timelineId = timeline?.kind === "timeline-ref" ? timeline.id : "main";
    const parameters = { ...normalized }; delete parameters.timeline;
    const output: IROutput = { id: stableId("output", { name: declaration.name, timelineId, ordinal: outputOrdinal++ }), name: declaration.name, op: value.op, timelineId, parameters, provenance: provenance("project.cut", declaration.span, declaration.name) };
    const outputComposition = ir.compositions.find((item) => item.id === timelineId || item.name === timelineId);
    if (!outputComposition) throw new Error(`Checked CUT output “${declaration.name}” references missing timeline ${timelineId}.`);
    validateCutOutputContract(output, outputComposition);
    ir.outputs.push(output);
  }

  // Domain assertions depend on the completed composition/scene graph, so
  // source order cannot change their result. Unknown third-party assertion
  // expressions remain explicitly deferred; recognized malformed predicates
  // fail at the assertion's source span.
  resolveCompiledAssertions(ir, check);

  const lockable = Object.values(ir.resources).every((resource) => resource.state === "locked") && ir.jobs.every((job) => job.state === "locked");
  ir.determinism.semantic = lockable ? "locked" : "unlocked";
  if (Object.values(ir.nodes).some((node) =>
    node.op === "cut.visual.flow_text"
    && node.inputs.shaping?.kind === "object"
  )) {
    ir.features = { complexTextShaping: collectInstalledComplexTextBackendIdentity() };
  }
  const moduleValues = [...(context.userModules?.modules.values() ?? [])].flatMap((runtime) => [...runtime.exports]
    .flatMap(([name, exported]) => exported.value ? [{ path: `sourceModules.${runtime.source.specifier}.exports.${name}`, value: exported.value }] : []));
  assertCutTypedDataAssetConsumerCompatibility(ir);
  assertResolvedCutIr(ir, [...[...topLevelConstants].map(([name, value]) => ({ path: `constants.${name}`, value })), ...moduleValues]);
  finalizeGraphHashes(ir);
  return { ir, check };
}
