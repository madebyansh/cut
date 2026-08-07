import type { CutModule, Declaration, Expression, LanguageDiagnostic, SourceSpan, Statement, TypeReference } from "./ast";
import { kernelAcceptsAuthoringInput, kernelAcceptsProperty, kernelPropertyValueType, kernelStringInputValues, referenceKernelSchema } from "./kernel-registry";
import { builtinPackages, implicitSymbols, type CutPackageManifest, type EffectKind, type NodeDomain, type PackageSymbol } from "./packages";
import { cutDomainAssertionPredicates } from "./domain-assertions";
import { compareRational, decimalRational, rational, type Rational } from "./rational";
import { cutAnchoredPathLimits } from "./anchored-path-contract";
import {
  cutMediaCamera2DMaximumNativeEffectDepth,
  cutMediaCamera2DNativeEffectOps,
  cutMediaCamera2DOp,
} from "./media-camera2d-contract";
import { cutTranscriptExecutableLimits } from "./transcript-contract";
import { cutCaptionAppearanceLimits } from "../interchange/captions";

export type QuantityDimension = "scalar" | "time" | "beat" | "length" | "ratio" | "angle" | "gain" | "frequency" | "loudness" | "true-peak" | "sample-peak";

export type SemanticType =
  | { kind: "error" }
  | { kind: "unknown" }
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "string" }
  | { kind: "color" }
  | { kind: "quantity"; dimension: QuantityDimension }
  | { kind: "list"; element: SemanticType }
  | { kind: "record"; fields: Record<string, SemanticType> }
  | { kind: "range"; element: SemanticType }
  | { kind: "nominal"; name: string; arguments: SemanticType[] }
  | { kind: "callable"; name: string; parameters: CheckedParameter[]; result: SemanticType; effect: EffectKind; domain?: NodeDomain; children?: PackageSymbol["children"]; openNamed?: boolean; native?: string };

export type CheckedParameter = { name: string; type: SemanticType; optional: boolean; values?: readonly string[] };
export type CheckedSymbol = {
  name: string;
  type: SemanticType;
  declaration?: Declaration;
  package?: string;
  packageSymbol?: PackageSymbol;
  userSymbol?: { specifier: string; imported: string; kind: "value" | "function" | "component" };
  writable?: boolean;
  kernel?: string;
};

export type CutUserModuleExport = {
  name: string;
  kind: "value" | "function" | "component";
  type: SemanticType;
  responsiveAnnotatedComponent?: true;
};

export type CutUserModuleContract = {
  specifier: string;
  exports: ReadonlyMap<string, CutUserModuleExport>;
  privateNames: ReadonlySet<string>;
};

export type CheckResult = {
  module: CutModule;
  diagnostics: LanguageDiagnostic[];
  expressionTypes: WeakMap<Expression, SemanticType>;
  symbols: Map<string, CheckedSymbol>;
  imports: Map<string, { specifier: string; imported: string; symbol: PackageSymbol }>;
  userImports: Map<string, { specifier: string; imported: string; symbol: CutUserModuleExport }>;
  exports: Map<string, CutUserModuleExport>;
  effects: Set<EffectKind>;
  responsiveAnnotatedComponents: ReadonlySet<string>;
};

export type CutCheckOptions = {
  /** Additional, already-resolved package contracts. Built-ins always win. */
  packages?: ReadonlyMap<string, CutPackageManifest>;
  /** Already-parsed and checked project-relative user modules, keyed by canonical ./path.cut. */
  userModules?: ReadonlyMap<string, CutUserModuleContract>;
  moduleKind?: "entry" | "user";
};

const errorType: SemanticType = { kind: "error" };
const unknownType: SemanticType = { kind: "unknown" };
const boolType: SemanticType = { kind: "boolean" };
const stringType: SemanticType = { kind: "string" };
const colorType: SemanticType = { kind: "color" };
const quantity = (dimension: QuantityDimension): SemanticType => ({ kind: "quantity", dimension });
const nominal = (name: string, ...arguments_: SemanticType[]): SemanticType => ({ kind: "nominal", name, arguments: arguments_ });

const knownNominals = new Set([
  "Any", "VideoAsset", "AudioAsset", "ImageAsset", "ImageSequenceAsset", "FontAsset", "DataAsset", "CaptionAsset", "TranscriptAsset", "LUTAsset", "Data", "Visual", "DiagramNode", "AudioNode", "AVNode", "Timeline", "Scene", "RenderTarget", "Easing", "Vec2", "Vec3", "GeoPoint", "NormalizedCrop", "ObservedVideoColor", "VideoColorInterpretation", "NoteEvent", "TempoPoint", "TempoMap", "PictureSpeedPoint", "ColorCurvePoint", "PathSegment", "LinePathSegment", "CubicPathSegment", "VectorPathGeometry", "SpatialPoint", "VisualAnchor", "AnchoredPathSegment", "AnchoredLinePathSegment", "AnchoredCubicPathSegment", "AnchoredPathGeometry", "PathGeometry", "TraceArrowhead", "TextSpan", "TextShaping", "TextUnitPose", "TextUnitMotion", "KeyedNumber", "MarkTarget", "BarLayout", "BarMark", "BarMarkTransform", "DiagramEdge", "DiagramState", "TableField", "TableSchema", "TableSource", "TablePredicate", "TableJoinKey", "TableSelection", "TableGroupKey", "TableAggregateValue", "TableSortKey", "TableSeriesValue", "TableStep", "TableQuery", "DataScale", "ChartSeries", "ChartFrame", "EditorialAnnotation", "EditorialTransaction", "EditorialMetadataEntry", "EditorialMetadata", "EditSelection", "AVTime", "TimelineEditOperandPart", "TimelineEditOperand", "TimelineEditOperation", "MarkerInfo", "RegionInfo", "TranscriptMediaAuthority", "TranscriptEdit", "Camera", "Light", "Mask", "Effect", "Shader", "ColorSpace",
]);

const annotationAuthoringNatives = new Set(["cut.edit.marker", "cut.edit.region"]);
const linkedEditAuthoringNatives = new Set(["cut.edit.linked_trim", "cut.edit.linked_ripple_delete"]);
const timelineEditAuthoringNatives = new Set(["cut.edit.timeline_edit"]);
const semanticMatchAuthoringNatives = new Set(["cut.edit.match_subject", "cut.edit.match_transition"]);
const nonRenderingAuthoringNatives = new Set([...annotationAuthoringNatives, ...linkedEditAuthoringNatives, ...timelineEditAuthoringNatives, ...semanticMatchAuthoringNatives]);
const canonicalTimelineIdentityAuthoringInputs: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "cut.edit.picture_track": new Set(["trackId", "role", "metadata"]),
  "cut.edit.audio_track": new Set(["trackId", "role", "metadata"]),
  "cut.edit.picture_clip": new Set(["editId", "role", "metadata"]),
  "cut.visual.precomp": new Set(["editId", "role", "metadata"]),
  "cut.audio.clip": new Set(["editId", "role", "metadata"]),
  "cut.edit.audio_region": new Set(["editId", "role", "metadata"]),
});

function isCanonicalTimelineIdentityAuthoringInput(native: string | undefined, name: string) {
  return native !== undefined && canonicalTimelineIdentityAuthoringInputs[native]?.has(name) === true;
}

function linkedEditStatementContract(native: string | undefined, fallbackName = "Linked edit") {
  return native === "cut.edit.linked_ripple_delete"
    ? {
        code: "CUT_LINKED_RIPPLE_SCOPE",
        name: fallbackName === "Linked edit" ? "LinkedRippleDelete" : fallbackName,
        hint: "Place LinkedRippleDelete(...) directly in the scene that owns the linked PictureClip and AudioClip; it is not a value or render node.",
      }
    : {
        code: "CUT_LINKED_TRIM_SCOPE",
        name: fallbackName === "Linked edit" ? "LinkedTrim" : fallbackName,
        hint: "Place LinkedTrim(...) directly in the scene that owns the linked PictureClip and AudioClip; it is not a value or render node.",
      };
}

const quantityNames: Record<string, QuantityDimension> = {
  Number: "scalar", Scalar: "scalar", Time: "time", Duration: "time", Frame: "time", Beat: "beat", Length: "length", Px: "length", Ratio: "ratio", Percent: "ratio", Angle: "angle", Gain: "gain", Db: "gain", Frequency: "frequency", Hz: "frequency", Loudness: "loudness", Lufs: "loudness", TruePeak: "true-peak", SamplePeak: "sample-peak",
};

const unitDimensions: Record<string, QuantityDimension> = { "": "scalar", ms: "time", s: "time", f: "time", beat: "beat", px: "length", "%": "ratio", deg: "angle", rad: "angle", db: "gain", hz: "frequency", khz: "frequency", lufs: "loudness", dbtp: "true-peak", dbfs: "sample-peak" };
const maximumRationalDigits = 256;

function decimalLiteralExceedsRationalBudget(expression: Extract<Expression, { kind: "number" }>) {
  const decimal = expression.raw.slice(0, expression.raw.length - expression.unit.length);
  const [integer = "0", fraction = ""] = decimal.split(".");
  const combined = `${integer}${fraction}`.replace(/^0+/, "");
  if (!combined) return false;
  const trailingZeros = combined.length - combined.replace(/0+$/, "").length;
  const cancelled = Math.min(trailingZeros, fraction.length);
  const numeratorDigits = combined.length - cancelled;
  const denominatorDigits = fraction.length - cancelled + 1;
  return numeratorDigits > maximumRationalDigits || denominatorDigits > maximumRationalDigits;
}

function containsFrameLiteral(expression: Expression): boolean {
  if (expression.kind === "number") return expression.unit === "f";
  if (["string", "boolean", "null", "color", "identifier"].includes(expression.kind)) return false;
  if (expression.kind === "array") return expression.items.some(containsFrameLiteral);
  if (expression.kind === "object") return expression.entries.some((entry) => containsFrameLiteral(entry.value));
  if (expression.kind === "member") return containsFrameLiteral(expression.object);
  if (expression.kind === "index") return containsFrameLiteral(expression.object) || containsFrameLiteral(expression.index);
  if (expression.kind === "range") return containsFrameLiteral(expression.start) || containsFrameLiteral(expression.end);
  if (expression.kind === "group" || expression.kind === "unary") return containsFrameLiteral(expression.value);
  if (expression.kind === "binary") return containsFrameLiteral(expression.left) || containsFrameLiteral(expression.right);
  if (expression.kind === "call") return containsFrameLiteral(expression.callee) || expression.positional.some(containsFrameLiteral) || expression.named.some((item) => containsFrameLiteral(item.value));
  return false;
}

function expressionIdentifiers(expression: Expression, result = new Set<string>()): Set<string> {
  if (expression.kind === "identifier") { result.add(expression.name); return result; }
  if (["number", "string", "boolean", "null", "color"].includes(expression.kind)) return result;
  if (expression.kind === "array") expression.items.forEach((item) => expressionIdentifiers(item, result));
  else if (expression.kind === "object") expression.entries.forEach((entry) => expressionIdentifiers(entry.value, result));
  else if (expression.kind === "member") expressionIdentifiers(expression.object, result);
  else if (expression.kind === "index") { expressionIdentifiers(expression.object, result); expressionIdentifiers(expression.index, result); }
  else if (expression.kind === "range") { expressionIdentifiers(expression.start, result); expressionIdentifiers(expression.end, result); }
  else if (expression.kind === "group" || expression.kind === "unary") expressionIdentifiers(expression.value, result);
  else if (expression.kind === "binary") { expressionIdentifiers(expression.left, result); expressionIdentifiers(expression.right, result); }
  else if (expression.kind === "call") { expressionIdentifiers(expression.callee, result); expression.positional.forEach((item) => expressionIdentifiers(item, result)); expression.named.forEach((item) => expressionIdentifiers(item.value, result)); }
  return result;
}

function expressionCalls(expression: Expression, result: Array<Extract<Expression, { kind: "call" }>> = []): Array<Extract<Expression, { kind: "call" }>> {
  if (["number", "string", "boolean", "null", "color", "identifier"].includes(expression.kind)) return result;
  if (expression.kind === "array") expression.items.forEach((item) => expressionCalls(item, result));
  else if (expression.kind === "object") expression.entries.forEach((entry) => expressionCalls(entry.value, result));
  else if (expression.kind === "member") expressionCalls(expression.object, result);
  else if (expression.kind === "index") { expressionCalls(expression.object, result); expressionCalls(expression.index, result); }
  else if (expression.kind === "range") { expressionCalls(expression.start, result); expressionCalls(expression.end, result); }
  else if (expression.kind === "group" || expression.kind === "unary") expressionCalls(expression.value, result);
  else if (expression.kind === "binary") { expressionCalls(expression.left, result); expressionCalls(expression.right, result); }
  else if (expression.kind === "call") {
    result.push(expression);
    expressionCalls(expression.callee, result);
    expression.positional.forEach((item) => expressionCalls(item, result));
    expression.named.forEach((item) => expressionCalls(item.value, result));
  }
  return result;
}

type StaticCallArgument =
  | { state: "missing" }
  | { state: "ambiguous" }
  | { state: "value"; value: Expression; span: SourceSpan };

function unwrapStaticGroup(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "group") current = current.value;
  return current;
}

/** Return only an unambiguous authored argument. Invalid duplicate
 * positional/named spellings are diagnosed by the ordinary call checker and
 * deliberately do not participate in static no-op inference. */
function staticCallArgument(
  call: Extract<Expression, { kind: "call" }>,
  parameterNames: readonly string[],
  name: string,
): StaticCallArgument {
  const candidates: Array<{ value: Expression; span: SourceSpan }> = [];
  const positionalIndex = parameterNames.indexOf(name);
  if (positionalIndex >= 0 && call.positional[positionalIndex]) {
    const value = call.positional[positionalIndex]!;
    candidates.push({ value, span: value.span });
  }
  for (const item of call.named) if (item.name === name) candidates.push({ value: item.value, span: item.span });
  return candidates.length === 0 ? { state: "missing" }
    : candidates.length === 1 ? { state: "value", ...candidates[0]! }
      : { state: "ambiguous" };
}

/** Exact literal pixel Length only. Identifiers, const references, arithmetic,
 * and other expressions are intentionally outside this source-check slice. */
function staticPixelLength(expression: Expression): Rational | undefined {
  let current = unwrapStaticGroup(expression), sign = 1n;
  while (current.kind === "unary" && current.operator === "-") {
    sign = -sign;
    current = unwrapStaticGroup(current.value);
  }
  if (current.kind !== "number" || current.unit !== "px") return undefined;
  if (decimalLiteralExceedsRationalBudget(current)) return undefined;
  const exact = decimalRational(current.raw.slice(0, current.raw.length - current.unit.length));
  return sign < 0n ? rational(-BigInt(exact.numerator), exact.denominator) : exact;
}

function staticPercentRatio(expression: Expression): Rational | undefined {
  let current = unwrapStaticGroup(expression), sign = 1n;
  while (current.kind === "unary" && current.operator === "-") {
    sign = -sign;
    current = unwrapStaticGroup(current.value);
  }
  if (current.kind !== "number" || current.unit !== "%" || decimalLiteralExceedsRationalBudget(current)) return undefined;
  const exact = decimalRational(current.raw.slice(0, current.raw.length - current.unit.length));
  const numerator = BigInt(exact.numerator) * sign;
  return rational(numerator, BigInt(exact.denominator) * 100n);
}

/** Validate a directly authored media-stream selector without pretending that
 * source checking can evaluate arbitrary const arithmetic. Resolved values are
 * checked again by the compiler before entering typed IR. */
function staticMediaStreamIndexIsInvalid(expression: Expression): boolean | undefined {
  let current = unwrapStaticGroup(expression), negative = false;
  while (current.kind === "unary" && current.operator === "-") {
    negative = !negative;
    current = unwrapStaticGroup(current.value);
  }
  if (current.kind !== "number" || current.unit !== "") return undefined;
  if (decimalLiteralExceedsRationalBudget(current)) return undefined;
  const exact = decimalRational(current.raw);
  const numerator = BigInt(exact.numerator) * (negative ? -1n : 1n);
  return exact.denominator !== "1" || numerator < 0n || numerator > BigInt(Number.MAX_SAFE_INTEGER);
}

function staticTranscriptCaptionMaxWordsIsInvalid(
  expression: Expression,
): boolean | undefined {
  let current = unwrapStaticGroup(expression), negative = false;
  while (current.kind === "unary" && current.operator === "-") {
    negative = !negative;
    current = unwrapStaticGroup(current.value);
  }
  if (current.kind !== "number" || current.unit !== "") return undefined;
  if (decimalLiteralExceedsRationalBudget(current)) return undefined;
  const exact = decimalRational(current.raw);
  const numerator = BigInt(exact.numerator) * (negative ? -1n : 1n);
  return exact.denominator !== "1"
    || numerator < BigInt(cutTranscriptExecutableLimits.minimumCaptionMaxWords)
    || numerator > BigInt(cutTranscriptExecutableLimits.maximumCaptionMaxWords);
}

function staticCaptionSizeIsInvalid(expression: Expression): boolean | undefined {
  const size = staticPixelLength(expression);
  if (size === undefined) return undefined;
  return compareRational(size, rational(cutCaptionAppearanceLimits.minimumSizePx)) < 0
    || compareRational(size, rational(cutCaptionAppearanceLimits.maximumSizePx)) > 0;
}

function staticColorLiteral(expression: Expression): string | undefined {
  const current = unwrapStaticGroup(expression);
  if (current.kind !== "color") return undefined;
  return current.value.length === 7 ? `${current.value}ff` : current.value;
}

function displayType(type: SemanticType): string {
  if (type.kind === "quantity") return Object.entries(quantityNames).find(([, value]) => value === type.dimension)?.[0] ?? type.dimension;
  if (type.kind === "list") return `List<${displayType(type.element)}>`;
  if (type.kind === "range") return `Range<${displayType(type.element)}>`;
  if (type.kind === "record") return "Record";
  if (type.kind === "nominal") return type.arguments.length ? `${type.name}<${type.arguments.map(displayType).join(", ")}>` : type.name;
  if (type.kind === "callable") return type.name;
  return type.kind === "boolean" ? "Bool" : type.kind === "string" ? "String" : type.kind === "color" ? "Color" : type.kind;
}

function sameType(left: SemanticType, right: SemanticType): boolean {
  if (left.kind === "error" || right.kind === "error" || left.kind === "unknown" || right.kind === "unknown") return true;
  const vec2Record = (type: SemanticType) => {
    if (type.kind !== "record") return false;
    const keys = Object.keys(type.fields);
    if (keys.length !== 2 || !keys.includes("x") || !keys.includes("y")) return false;
    const x = type.fields.x, y = type.fields.y;
    return x?.kind === "quantity" && x.dimension === "length"
      && y?.kind === "quantity" && y.dimension === "length";
  };
  if (left.kind === "nominal" && left.name === "Vec2" && vec2Record(right)) return true;
  if (right.kind === "nominal" && right.name === "Vec2" && vec2Record(left)) return true;
  if (vec2Record(left) && vec2Record(right)) return true;
  // Vec2 is a closed structural literal at the language boundary. Prevent a
  // valid point followed by an invalid lookalike from falling through to the
  // generally open record-compatibility rule during list inference.
  if (left.kind === "record" && right.kind === "record" && (vec2Record(left) || vec2Record(right))) return false;
  const geoRecord = (type: SemanticType) => {
    if (type.kind !== "record") return false;
    const keys = Object.keys(type.fields), allowed = new Set(["latitude", "longitude", "label"]);
    if (keys.some((key) => !allowed.has(key)) || !keys.includes("latitude") || !keys.includes("longitude")) return false;
    const latitude = type.fields.latitude, longitude = type.fields.longitude, label = type.fields.label;
    return latitude?.kind === "quantity" && longitude?.kind === "quantity"
      && ["scalar", "angle"].includes(latitude.dimension) && ["scalar", "angle"].includes(longitude.dimension)
      && (label === undefined || label.kind === "string");
  };
  if (left.kind === "nominal" && left.name === "GeoPoint" && geoRecord(right)) return true;
  if (right.kind === "nominal" && right.name === "GeoPoint" && geoRecord(left)) return true;
  if (geoRecord(left) && geoRecord(right)) return true;
  if (left.kind === "record" && right.kind === "record" && (geoRecord(left) || geoRecord(right))) return false;
  const normalizedCropRecord = (type: SemanticType) => {
    if (type.kind !== "record") return false;
    const keys = Object.keys(type.fields);
    if (keys.length !== 4 || !["x", "y", "width", "height"].every((key) => keys.includes(key))) return false;
    return [type.fields.x, type.fields.y, type.fields.width, type.fields.height]
      .every((field) => field?.kind === "quantity" && field.dimension === "ratio");
  };
  if (left.kind === "nominal" && left.name === "NormalizedCrop" && normalizedCropRecord(right)) return true;
  if (right.kind === "nominal" && right.name === "NormalizedCrop" && normalizedCropRecord(left)) return true;
  const noteEventRecord = (type: SemanticType) => {
    if (type.kind !== "record") return false;
    const keys = Object.keys(type.fields), allowed = new Set(["start", "duration", "pitch", "hz", "velocity"]);
    if (keys.some((key) => !allowed.has(key)) || keys.length !== 4) return false;
    const start = type.fields.start, duration = type.fields.duration, pitch = type.fields.pitch, hz = type.fields.hz, velocity = type.fields.velocity;
    return start?.kind === "quantity" && start.dimension === "time"
      && duration?.kind === "quantity" && duration.dimension === "time"
      && velocity?.kind === "quantity" && velocity.dimension === "ratio"
      && ((pitch?.kind === "quantity" && pitch.dimension === "scalar" && hz === undefined)
        || (hz?.kind === "quantity" && hz.dimension === "frequency" && pitch === undefined));
  };
  if (left.kind === "nominal" && left.name === "NoteEvent" && noteEventRecord(right)) return true;
  if (right.kind === "nominal" && right.name === "NoteEvent" && noteEventRecord(left)) return true;
  // NoteEvent's pitch and Hz spellings are a tagged union. Treat both closed
  // record variants as one list element type without making records generally
  // open or weakening the nominal package boundary.
  if (noteEventRecord(left) && noteEventRecord(right)) return true;
  // A valid NoteEvent alongside an invalid lookalike must not fall through to
  // structural record subtyping: that would let a later list item add both
  // pitch and hz (or another forbidden field) after a valid first event set
  // the array's inferred element type.
  if (left.kind === "record" && right.kind === "record" && (noteEventRecord(left) || noteEventRecord(right))) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "quantity" && right.kind === "quantity") return left.dimension === right.dimension;
  if (left.kind === "list" && right.kind === "list") return sameType(left.element, right.element);
  if (left.kind === "range" && right.kind === "range") return sameType(left.element, right.element);
  if (left.kind === "nominal" && right.kind === "nominal") {
    if (left.name === "Any" || right.name === "Any") return true;
    const av = new Set(["Visual", "AudioNode", "AVNode"]);
    if (left.name !== right.name && !(left.name === "AVNode" && av.has(right.name))) return false;
    return left.arguments.length === right.arguments.length && left.arguments.every((item, index) => sameType(item, right.arguments[index]));
  }
  if (left.kind === "record" && right.kind === "record") return Object.entries(left.fields).every(([key, value]) => right.fields[key] && sameType(value, right.fields[key]));
  return true;
}

const concretePathSegmentNames = new Set(["LinePathSegment", "CubicPathSegment"]);
const concreteAnchoredPathSegmentNames = new Set(["AnchoredLinePathSegment", "AnchoredCubicPathSegment"]);
const concretePathGeometryNames = new Set(["VectorPathGeometry", "AnchoredPathGeometry"]);

/** Directional expected <- actual compatibility. PathSegment is deliberately
 * the only new nominal widening: Trace continues to require concrete cubic
 * segments and cannot consume a mixed/general retained-path list. */
function acceptsType(expected: SemanticType, actual: SemanticType): boolean {
  if (expected.kind === "nominal" && expected.name === "Any") return true;
  if (expected.kind === "list" && actual.kind === "list") return acceptsType(expected.element, actual.element);
  if (expected.kind === "range" && actual.kind === "range") return acceptsType(expected.element, actual.element);
  if (expected.kind === "nominal" && expected.name === "PathSegment" && actual.kind === "nominal") {
    return actual.name === "PathSegment" || concretePathSegmentNames.has(actual.name);
  }
  if (expected.kind === "nominal" && expected.name === "AnchoredPathSegment" && actual.kind === "nominal") {
    return actual.name === "AnchoredPathSegment" || concreteAnchoredPathSegmentNames.has(actual.name);
  }
  if (expected.kind === "nominal" && expected.name === "SpatialPoint" && actual.kind === "nominal") {
    return actual.name === "SpatialPoint" || actual.name === "VisualAnchor" || actual.name === "Vec2";
  }
  if (expected.kind === "nominal" && expected.name === "SpatialPoint" && actual.kind === "record") {
    return sameType(nominal("Vec2"), actual);
  }
  if (expected.kind === "nominal" && expected.name === "PathGeometry" && actual.kind === "nominal") {
    return actual.name === "PathGeometry" || concretePathGeometryNames.has(actual.name);
  }
  if (expected.kind === "nominal" && actual.kind === "nominal"
    && ["CaptionAsset", "TranscriptAsset", "LUTAsset"].includes(expected.name)) {
    // Dedicated byte consumers preserve legacy DataAsset source compatibility,
    // but one typed asset can never be substituted for another.
    return actual.name === expected.name || actual.name === "DataAsset";
  }
  if (expected.kind === "nominal" && actual.kind === "nominal" && actual.name === "DiagramNode") {
    return expected.name === "DiagramNode" || expected.name === "Visual" || expected.name === "AVNode";
  }
  return sameType(expected, actual);
}

function typeFromName(value: string): SemanticType {
  const trimmed = value.trim();
  const generic = /^([A-Za-z_][A-Za-z0-9_]*)<(.+)>$/.exec(trimmed);
  if (generic) {
    const inner = typeFromName(generic[2]);
    if (generic[1] === "List" || generic[1] === "Array") return { kind: "list", element: inner };
    if (generic[1] === "Range") return { kind: "range", element: inner };
    return nominal(generic[1], inner);
  }
  if (trimmed === "String") return stringType;
  if (trimmed === "Bool" || trimmed === "Boolean") return boolType;
  if (trimmed === "Color") return colorType;
  if (quantityNames[trimmed]) return quantity(quantityNames[trimmed]);
  return nominal(trimmed);
}

function callableFromPackage(symbol: PackageSymbol): SemanticType {
  if (symbol.kind === "value") return typeFromName(symbol.returns);
  return {
    kind: "callable",
    name: symbol.name,
    parameters: (symbol.parameters ?? []).map((parameter) => ({ name: parameter.name, type: typeFromName(parameter.type), optional: Boolean(parameter.optional), values: parameter.values })),
    result: typeFromName(symbol.returns),
    effect: symbol.effect,
    domain: symbol.domain,
    children: symbol.children,
    openNamed: symbol.openNamed,
    native: symbol.native,
  };
}

function typeReference(type: TypeReference, diagnostics: LanguageDiagnostic[]): SemanticType {
  const arguments_ = type.arguments.map((item) => typeReference(item, diagnostics));
  if (type.name === "List" || type.name === "Array") {
    if (arguments_.length !== 1) diagnostics.push({ severity: "error", code: "CUT2007", message: `${type.name} requires one type argument.`, span: type.span });
    return { kind: "list", element: arguments_[0] ?? unknownType };
  }
  if (type.name === "Range") {
    if (arguments_.length !== 1) diagnostics.push({ severity: "error", code: "CUT2007", message: "Range requires one type argument.", span: type.span });
    return { kind: "range", element: arguments_[0] ?? unknownType };
  }
  if (type.name === "String") return stringType;
  if (type.name === "Bool" || type.name === "Boolean") return boolType;
  if (type.name === "Color") return colorType;
  if (quantityNames[type.name]) return quantity(quantityNames[type.name]);
  if (!knownNominals.has(type.name) && !["Asset", "Signal", "Optional", "Curve"].includes(type.name)) diagnostics.push({ severity: "error", code: "CUT2008", message: `Unknown type “${type.name}”.`, span: type.span });
  return nominal(type.name, ...arguments_);
}

class Scope {
  private readonly values = new Map<string, CheckedSymbol>();
  constructor(readonly parent?: Scope) {}
  define(symbol: CheckedSymbol) { if (this.values.has(symbol.name)) return false; this.values.set(symbol.name, symbol); return true; }
  lookupOwn(name: string): CheckedSymbol | undefined { return this.values.get(name); }
  lookup(name: string): CheckedSymbol | undefined { return this.values.get(name) ?? this.parent?.lookup(name); }
}

const visualProperties: Record<string, SemanticType> = {
  opacity: quantity("ratio"), position: nominal("Vec2"), x: quantity("length"), y: quantity("length"), z: quantity("length"), anchorX: quantity("length"), anchorY: quantity("length"), scale: quantity("scalar"), skewX: quantity("angle"), skewY: quantity("angle"), rotation: quantity("angle"), width: quantity("length"), height: quantity("length"), color: colorType, reveal: quantity("ratio"), progress: quantity("ratio"), blur: quantity("length"), exposure: quantity("scalar"), temperature: quantity("scalar"), tint: quantity("scalar"), brightness: quantity("scalar"), hue: quantity("angle"), contrast: quantity("scalar"), saturation: quantity("scalar"), strength: quantity("ratio"), sourceTime: quantity("time"),
};
const audioProperties: Record<string, SemanticType> = { amount: quantity("gain"), position: quantity("ratio"), gain: quantity("gain"), pan: quantity("ratio"), cutoff: quantity("frequency"), frequency: quantity("frequency"), q: quantity("scalar"), wet: quantity("ratio"), threshold: quantity("gain"), ratio: quantity("scalar"), attack: quantity("time"), release: quantity("time"), makeup: quantity("gain") };
const keyedNumberMembers: Record<string, SemanticType> = { key: stringType, label: stringType, value: quantity("scalar") };
const markTargetMembers: Record<string, SemanticType> = { key: stringType, x: quantity("length"), y: quantity("length") };
const barMarkMembers: Record<string, SemanticType> = {
  key: stringType,
  label: stringType,
  value: quantity("scalar"),
  index: quantity("scalar"),
  x: quantity("length"),
  y: quantity("length"),
  width: quantity("length"),
  height: quantity("length"),
  left: quantity("length"),
  top: quantity("length"),
  right: quantity("length"),
  bottom: quantity("length"),
  baselineY: quantity("length"),
};
const barMarkTransformMembers: Record<string, SemanticType> = {
  ...barMarkMembers,
  targetX: quantity("length"),
  targetY: quantity("length"),
};

function memberType(object: SemanticType, property: string): SemanticType | undefined {
  if (object.kind === "record") return object.fields[property];
  if (object.kind === "nominal") {
    if (["Visual", "Camera", "Light", "Mask", "Effect", "Shader"].includes(object.name)) return visualProperties[property];
    if (object.name === "AudioNode") return audioProperties[property];
    if (object.name === "AVNode") return audioProperties[property] ?? visualProperties[property];
    if (object.name === "KeyedNumber") return keyedNumberMembers[property];
    if (object.name === "MarkTarget") return markTargetMembers[property];
    if (object.name === "BarLayout") return ({ id: stringType, marks: { kind: "list", element: nominal("BarMark") } as SemanticType })[property];
    if (object.name === "BarMark") return barMarkMembers[property];
    if (object.name === "BarMarkTransform") return barMarkTransformMembers[property];
    if (object.name === "MarkerInfo") return {
      id: stringType,
      at: quantity("time"),
      name: stringType,
      color: colorType,
      role: stringType,
      comment: stringType,
      grid: stringType,
    }[property];
    if (object.name === "RegionInfo") return {
      id: stringType,
      range: { kind: "range", element: quantity("time") } as SemanticType,
      name: stringType,
      color: colorType,
      role: stringType,
      comment: stringType,
      grid: stringType,
    }[property];
    if (object.name === "TranscriptEdit") return {
      sourceRange: { kind: "range", element: quantity("time") } as SemanticType,
      destinationRange: { kind: "range", element: quantity("time") } as SemanticType,
      duration: quantity("time"),
      text: stringType,
    }[property];
  }
  return undefined;
}

function isNodeType(type: SemanticType) { return type.kind === "nominal" && ["Visual", "DiagramNode", "AudioNode", "AVNode"].includes(type.name); }
function isCompileTimeValueType(type: SemanticType): boolean {
  if (type.kind === "error" || type.kind === "unknown" || type.kind === "callable") return false;
  if (type.kind === "list" || type.kind === "range") return isCompileTimeValueType(type.element);
  if (type.kind === "record") return Object.values(type.fields).every(isCompileTimeValueType);
  if (type.kind === "nominal") {
    if (["Visual", "DiagramNode", "AudioNode", "AVNode", "Timeline", "RenderTarget", "VideoAsset", "AudioAsset", "ImageAsset", "ImageSequenceAsset", "FontAsset", "DataAsset", "CaptionAsset", "TranscriptAsset", "LUTAsset", "Asset"].includes(type.name)) return false;
    return type.arguments.every(isCompileTimeValueType);
  }
  return true;
}
function nodeDomain(type: SemanticType): NodeDomain | undefined { return type.kind !== "nominal" ? undefined : type.name === "Visual" || type.name === "DiagramNode" ? "visual" : type.name === "AudioNode" ? "audio" : type.name === "AVNode" ? "av" : undefined; }
function componentChildPolicy(type: SemanticType): PackageSymbol["children"] {
  if (type.kind === "nominal" && type.name === "DiagramNode") return "none";
  const domain = nodeDomain(type);
  return domain === "visual" ? "visual" : domain === "audio" ? "audio" : domain === "av" ? "any" : "none";
}

export function checkCutModule(module: CutModule, options: CutCheckOptions = {}): CheckResult {
  const diagnostics: LanguageDiagnostic[] = [];
  const expressionTypes = new WeakMap<Expression, SemanticType>();
  const symbols = new Map<string, CheckedSymbol>();
  const imports = new Map<string, { specifier: string; imported: string; symbol: PackageSymbol }>();
  const userImports = new Map<string, { specifier: string; imported: string; symbol: CutUserModuleExport }>();
  const exportedSymbols = new Map<string, CutUserModuleExport>();
  const responsiveAnnotatedComponents = new Set<string>();
  const effects = new Set<EffectKind>();
  const global = new Scope();
  const availablePackages = new Map(options.packages ?? []);
  const userModules = new Map(options.userModules ?? []);
  const moduleKind = options.moduleKind ?? "entry";
  for (const [specifier, package_] of builtinPackages) availablePackages.set(specifier, package_);

  const diagnostic = (code: string, message: string, span: SourceSpan, hint?: string, severity: LanguageDiagnostic["severity"] = "error") => diagnostics.push({ severity, code, message, span, hint });
  const checkClosedArguments = (owner: string, values: Array<{ name: string; span: SourceSpan }>, allowed: readonly string[]) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (!allowed.includes(value.name)) diagnostic("CUT2065", `${owner} has no argument “${value.name}”.`, value.span, `Accepted arguments: ${allowed.join(", ")}.`);
      if (seen.has(value.name)) diagnostic("CUT2066", `${owner} argument “${value.name}” is supplied more than once.`, value.span);
      seen.add(value.name);
    }
  };
  const defineGlobal = (value: CheckedSymbol, span: SourceSpan) => {
    if (value.name === "self") diagnostic("CUT2062", "“self” is reserved for the implicit Visual component fragment and cannot be declared.", span, "Choose another name; use self only inside a component declared -> Visual.");
    if (!global.define(value)) diagnostic("CUT2002", `Duplicate top-level symbol “${value.name}”.`, span);
    else symbols.set(value.name, value);
  };

  for (const [name, packageItem] of Object.entries(implicitSymbols)) defineGlobal({ name, type: callableFromPackage(packageItem), package: "cut:core", packageSymbol: packageItem }, module.span);

  const languageDeclarations = module.declarations.filter((item) => item.kind === "language");
  if (languageDeclarations.length !== 1) diagnostic("CUT2001", `Expected exactly one “cut 0.4;” declaration, found ${languageDeclarations.length}.`, module.span);
  const projectDeclarations = module.declarations.filter((item) => item.kind === "project");
  if (moduleKind === "entry" && projectDeclarations.length !== 1) diagnostic("CUT2069", `Expected exactly one project declaration, found ${projectDeclarations.length}.`, module.span);
  if (moduleKind === "user" && projectDeclarations.length !== 0) diagnostic("CUT_MODULE_PROJECT", "A user module cannot declare a project; only the entry .cut file owns project identity.", projectDeclarations[0].span);

  const duplicateImportKeys = new Set<string>();

  for (const declaration of module.declarations) {
    if (declaration.kind === "import") {
      if (declaration.module.startsWith(".")) {
        const contract = userModules.get(declaration.module);
        if (!contract) {
          diagnostic("CUT_MODULE_UNRESOLVED", `Project module “${declaration.module}” was not securely loaded.`, declaration.span, "Use one canonical project-relative path such as ./lib/theme.cut.");
          continue;
        }
        for (const imported of declaration.names) {
          const duplicateKey = `${declaration.module}\0${imported.imported}\0${imported.local}`;
          if (duplicateImportKeys.has(duplicateKey)) {
            diagnostic("CUT_MODULE_DUPLICATE_IMPORT", `Duplicate import of “${imported.imported}” from “${declaration.module}”.`, declaration.span);
            continue;
          }
          duplicateImportKeys.add(duplicateKey);
          const exported = contract.exports.get(imported.imported);
          if (!exported) {
            const isPrivate = contract.privateNames.has(imported.imported);
            diagnostic(
              isPrivate ? "CUT_MODULE_PRIVATE_SYMBOL" : "CUT_MODULE_MISSING_SYMBOL",
              isPrivate
                ? `Module “${declaration.module}” declares “${imported.imported}” but does not export it.`
                : `Module “${declaration.module}” does not export “${imported.imported}”.`,
              declaration.span,
            );
            continue;
          }
          const checked: CheckedSymbol = {
            name: imported.local,
            type: exported.type,
            userSymbol: { specifier: declaration.module, imported: imported.imported, kind: exported.kind },
          };
          defineGlobal(checked, declaration.span);
          userImports.set(imported.local, { specifier: declaration.module, imported: imported.imported, symbol: exported });
        }
        continue;
      }
      const package_ = availablePackages.get(declaration.module);
      if (!package_) { diagnostic("CUT2003", `Unknown or unlocked package “${declaration.module}”.`, declaration.span, "Use a package present in cut.lock or a built-in cut: module."); continue; }
      for (const imported of declaration.names) {
        const packageItem = package_.symbols[imported.imported];
        if (!packageItem) { diagnostic("CUT2004", `Package “${declaration.module}” does not export “${imported.imported}”.`, declaration.span); continue; }
        const checked = { name: imported.local, type: callableFromPackage(packageItem), package: declaration.module, packageSymbol: packageItem };
        defineGlobal(checked, declaration.span); imports.set(imported.local, { specifier: declaration.module, imported: imported.imported, symbol: packageItem });
      }
    } else if (declaration.kind === "asset") defineGlobal({ name: declaration.name, type: declaration.assetType ? typeReference(declaration.assetType, diagnostics) : unknownType, declaration }, declaration.span);
    else if (declaration.kind === "const") defineGlobal({ name: declaration.name, type: declaration.type ? typeReference(declaration.type, diagnostics) : unknownType, declaration }, declaration.span);
    else if (declaration.kind === "function") {
      const parameters = declaration.parameters.map((parameter) => ({ name: parameter.name, type: typeReference(parameter.type, diagnostics), optional: Boolean(parameter.defaultValue) }));
      const result = typeReference(declaration.returnType, diagnostics);
      defineGlobal({ name: declaration.name, type: { kind: "callable", name: declaration.name, parameters, result, effect: "pure", children: "none" }, declaration }, declaration.span);
    }
    else if (declaration.kind === "component") {
      const parameters = declaration.parameters.map((parameter) => ({ name: parameter.name, type: typeReference(parameter.type, diagnostics), optional: Boolean(parameter.defaultValue) }));
      const result = declaration.returnType ? typeReference(declaration.returnType, diagnostics) : nominal("AVNode");
      defineGlobal({ name: declaration.name, type: { kind: "callable", name: declaration.name, parameters, result, effect: "pure", children: componentChildPolicy(result) }, declaration }, declaration.span);
    } else if (declaration.kind === "timeline") {
      if (moduleKind === "user") diagnostic("CUT_MODULE_DECLARATION", "User modules cannot declare timelines; timelines belong in the project entry source.", declaration.span);
      defineGlobal({ name: declaration.name, type: nominal("Timeline"), declaration }, declaration.span);
    }
    if (moduleKind === "user" && declaration.kind === "asset") diagnostic("CUT_MODULE_DECLARATION", "User modules cannot own project assets; pass typed assets into exported components instead.", declaration.span);
  }

  const checkStaticFlowTextSpanRedundancy = (
    expression: Extract<Expression, { kind: "call" }>,
    parameters: readonly CheckedParameter[],
  ) => {
    const flowParameterNames = parameters.map(({ name }) => name), spansArgument = staticCallArgument(expression, flowParameterNames, "spans");
    if (spansArgument.state !== "value") return;
    const spans = unwrapStaticGroup(spansArgument.value);
    if (spans.kind !== "array") return;

    const baseLength = (name: "size" | "tracking" | "baselineShift", omittedDefault?: Rational) => {
      const argument = staticCallArgument(expression, flowParameterNames, name);
      return argument.state === "value" ? staticPixelLength(argument.value)
        : argument.state === "missing" ? omittedDefault
          : undefined;
    };
    const validBaseLength = (name: "size" | "tracking" | "baselineShift", value: Rational | undefined) => {
      if (value === undefined) return undefined;
      const limit = name === "tracking" ? 1_024 : 4_096;
      const minimum = name === "size" ? rational(1) : rational(-limit);
      return compareRational(value, minimum) >= 0 && compareRational(value, rational(limit)) <= 0 ? value : undefined;
    };
    // Match runtime precedence: an invalid FlowText base fails VALUE_RANGE
    // before span redundancy is considered.
    const baseSize = validBaseLength("size", baseLength("size"));
    const baseTracking = validBaseLength("tracking", baseLength("tracking", rational(0)));
    const baseBaselineShift = validBaseLength("baselineShift", baseLength("baselineShift", rational(0)));
    const baseColorArgument = staticCallArgument(expression, flowParameterNames, "color");
    const authoredBaseColor = baseColorArgument.state === "value" ? staticColorLiteral(baseColorArgument.value) : undefined;
    const baseColor = authoredBaseColor?.endsWith("00") ? undefined : authoredBaseColor;
    const baseFontArgument = staticCallArgument(expression, flowParameterNames, "font");
    const baseFontExpression = baseFontArgument.state === "value" ? unwrapStaticGroup(baseFontArgument.value) : undefined;
    const baseFontName = baseFontExpression?.kind === "identifier" ? baseFontExpression.name : undefined;
    spans.items.forEach((authoredSpan, index) => {
      const candidate = unwrapStaticGroup(authoredSpan);
      if (candidate.kind !== "call") return;
      const spanCallee = unwrapStaticGroup(candidate.callee);
      if (spanCallee.kind !== "identifier") return;
      const imported = imports.get(spanCallee.name);
      if (imported?.specifier !== "cut:visual" || imported.imported !== "textSpan") return;
      const textSpanParameters = imported.symbol.parameters;
      if (!textSpanParameters) return;
      const textSpanParameterNames = textSpanParameters.map(({ name }) => name);

      const repeatedLength = (name: "size" | "tracking" | "baselineShift", base: Rational | undefined) => {
        const override = staticCallArgument(candidate, textSpanParameterNames, name);
        if (override.state !== "value" || base === undefined) return;
        const value = staticPixelLength(override.value);
        if (value !== undefined && compareRational(value, base) === 0) {
          diagnostic("CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].${name} redundantly repeats the FlowText base ${name}.`, override.span, `Omit ${name}: from this textSpan; it inherits the enclosing FlowText value.`);
        }
      };
      repeatedLength("size", baseSize);
      repeatedLength("tracking", baseTracking);
      repeatedLength("baselineShift", baseBaselineShift);

      const colorOverride = staticCallArgument(candidate, textSpanParameterNames, "color");
      const color = colorOverride.state === "value" ? staticColorLiteral(colorOverride.value) : undefined;
      if (colorOverride.state === "value" && color !== undefined && baseColor !== undefined && color === baseColor) {
        diagnostic("CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].color redundantly repeats the FlowText base color.`, colorOverride.span, "Omit color: from this textSpan; it inherits the enclosing FlowText value.");
      }
      const fontOverride = staticCallArgument(candidate, textSpanParameterNames, "font");
      const fontExpression = fontOverride.state === "value" ? unwrapStaticGroup(fontOverride.value) : undefined;
      if (fontOverride.state === "value" && baseFontName !== undefined && fontExpression?.kind === "identifier" && fontExpression.name === baseFontName) {
        diagnostic("CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].font redundantly repeats the FlowText base font.`, fontOverride.span, "Omit font: from this textSpan; it inherits the enclosing FlowText FontAsset.");
      }
    });
  };

  const checkExpression = (
    expression: Expression,
    scope: Scope,
    allowDirectAssetConstructor = false,
    nodePropertyAccess: "read" | "write-target" = "read",
    allowAnnotationStatementRoot = false,
    allowTranscriptAudioTrackItemRoot = false,
    allowTranscriptPictureTrackItemRoot = false,
  ): SemanticType => {
    let result: SemanticType = errorType;
    if (expression.kind === "number") {
      if (decimalLiteralExceedsRationalBudget(expression)) diagnostic("CUT2064", `Exact numeric literal exceeds the ${maximumRationalDigits}-digit rational budget.`, expression.span, "Shorten the literal or use a smaller exact ratio; CUT does not silently round source numbers.");
      result = quantity(unitDimensions[expression.unit]);
    }
    else if (expression.kind === "string") result = stringType;
    else if (expression.kind === "boolean") result = boolType;
    else if (expression.kind === "null") result = { kind: "null" };
    else if (expression.kind === "color") result = colorType;
    else if (expression.kind === "identifier") {
      const symbol_ = scope.lookup(expression.name);
      if (!symbol_) {
        if (expression.name === "self") diagnostic("CUT2061", "“self” is available only inside a component declared -> Visual.", expression.span, "Use a bound node name outside the component, or declare the component result as Visual.");
        else diagnostic("CUT2010", `Unknown symbol “${expression.name}”.`, expression.span);
        result = errorType;
      }
      else result = symbol_.type;
    } else if (expression.kind === "group") result = checkExpression(expression.value, scope);
    else if (expression.kind === "array") {
      const items = expression.items.map((item) => checkExpression(item, scope)); const first = items[0] ?? unknownType;
      const allPathSegments = items.length > 0 && items.every((item) => item.kind === "nominal"
        && (item.name === "PathSegment" || concretePathSegmentNames.has(item.name)));
      const pathKinds = allPathSegments ? new Set(items.map((item) => (item as Extract<SemanticType, { kind: "nominal" }>).name)) : undefined;
      const allAnchoredPathSegments = items.length > 0 && items.every((item) => item.kind === "nominal"
        && (item.name === "AnchoredPathSegment" || concreteAnchoredPathSegmentNames.has(item.name)));
      const anchoredPathKinds = allAnchoredPathSegments ? new Set(items.map((item) => (item as Extract<SemanticType, { kind: "nominal" }>).name)) : undefined;
      items.slice(1).forEach((item) => { if (!allPathSegments && !allAnchoredPathSegments && !sameType(first, item)) diagnostic("CUT2011", `Array items must have one type; found ${displayType(first)} and ${displayType(item)}.`, expression.span); });
      result = {
        kind: "list",
        element: allPathSegments && pathKinds!.size > 1
          ? nominal("PathSegment")
          : allAnchoredPathSegments && anchoredPathKinds!.size > 1
            ? nominal("AnchoredPathSegment")
            : first,
      };
    } else if (expression.kind === "object") {
      const fields: Record<string, SemanticType> = {};
      for (const entry of expression.entries) { if (fields[entry.key]) diagnostic("CUT2012", `Duplicate object field “${entry.key}”.`, entry.span); fields[entry.key] = checkExpression(entry.value, scope); }
      result = { kind: "record", fields };
    } else if (expression.kind === "member") {
      const object = checkExpression(expression.object, scope, allowDirectAssetConstructor, nodePropertyAccess);
      const binding = expression.object.kind === "identifier" ? scope.lookup(expression.object.name) : undefined;
      const schema = binding?.kernel ? referenceKernelSchema(binding.kernel) : undefined;
      // A concrete native node may refine the generic AudioNode/Visual member
      // vocabulary (for example DeEsser.amount is Number, not Gain). The
      // synthetic fragment kernel is domain-polymorphic, so it must retain the
      // object's nominal member boundary instead of exposing visual properties
      // on an AudioNode fragment.
      const declaredProperty = schema?.support === "supported" && binding?.kernel !== "cut.kernel.fragment"
        ? kernelPropertyValueType(schema, expression.property)
        : undefined;
      const property = declaredProperty ? typeFromName(declaredProperty) : memberType(object, expression.property);
      if (schema?.support === "supported" && !kernelAcceptsProperty(schema, expression.property)) {
        diagnostic("CUT2060", `Reference kernel ${binding!.kernel} has no executable property “${expression.property}”.`, expression.span, "Only properties listed in the executable kernel registry may be set or animated.");
        result = errorType;
      } else if (object.kind === "error") result = errorType;
      else if (!property) { diagnostic("CUT2013", `Type ${displayType(object)} has no known member “${expression.property}”.`, expression.span); result = errorType; } else result = property;
      if (result.kind !== "error" && isNodeType(object) && nodePropertyAccess === "read") {
        diagnostic("CUT2063", `Node property “${expression.property}” is write-only; property-read expressions are not implemented.`, expression.span, "Keep the authored value in an explicit binding if it must also be read.");
        result = errorType;
      }
    } else if (expression.kind === "index") {
      const object = checkExpression(expression.object, scope); const index = checkExpression(expression.index, scope);
      if (object.kind !== "list") { diagnostic("CUT2014", `Cannot index ${displayType(object)}.`, expression.object.span); result = errorType; }
      else { if (!sameType(index, quantity("scalar"))) diagnostic("CUT2015", "List indices must be scalar numbers.", expression.index.span); result = object.element; }
    } else if (expression.kind === "range") {
      const start = checkExpression(expression.start, scope), end = checkExpression(expression.end, scope);
      if (!sameType(start, end)) diagnostic("CUT2016", `Range endpoints must match; found ${displayType(start)} and ${displayType(end)}.`, expression.span);
      result = { kind: "range", element: start };
    } else if (expression.kind === "unary") {
      const value = checkExpression(expression.value, scope);
      if (expression.operator === "!" && value.kind !== "boolean" && value.kind !== "error") diagnostic("CUT2017", `Operator ! needs Bool, found ${displayType(value)}.`, expression.span);
      if (expression.operator === "-" && value.kind !== "quantity" && value.kind !== "error") diagnostic("CUT2018", `Unary - needs a numeric quantity, found ${displayType(value)}.`, expression.span);
      result = expression.operator === "!" ? boolType : value;
    } else if (expression.kind === "binary") {
      const left = checkExpression(expression.left, scope), right = checkExpression(expression.right, scope);
      if (["&&", "||"].includes(expression.operator)) {
        if (left.kind !== "boolean" || right.kind !== "boolean") diagnostic("CUT2019", `${expression.operator} needs two Bool values.`, expression.span);
        result = boolType;
      } else if (["==", "!=", "<", "<=", ">", ">="].includes(expression.operator)) {
        if (!sameType(left, right)) diagnostic("CUT2020", `Cannot compare ${displayType(left)} with ${displayType(right)}.`, expression.span); result = boolType;
      } else if (["+", "-"].includes(expression.operator)) {
        if (!sameType(left, right) || left.kind !== "quantity") diagnostic("CUT2021", `${expression.operator} requires matching dimensions, found ${displayType(left)} and ${displayType(right)}.`, expression.span);
        result = left;
      } else if (["*", "/", "%"].includes(expression.operator)) {
        if (left.kind !== "quantity" || right.kind !== "quantity") { diagnostic("CUT2022", `${expression.operator} needs numeric quantities.`, expression.span); result = errorType; }
        else if (expression.operator === "*" && left.dimension === "scalar") result = right;
        else if (expression.operator === "*" && right.dimension === "scalar") result = left;
        else if (expression.operator === "/" && right.dimension === "scalar") result = left;
        else if (expression.operator === "/" && left.dimension === right.dimension) result = quantity("scalar");
        else if (expression.operator === "%" && left.dimension === right.dimension) result = left;
        else { diagnostic("CUT2023", `Unsupported dimensional arithmetic: ${displayType(left)} ${expression.operator} ${displayType(right)}.`, expression.span); result = errorType; }
      }
    } else if (expression.kind === "call") {
      const callee = checkExpression(expression.callee, scope);
      if (callee.kind !== "callable") { diagnostic("CUT2024", `${displayType(callee)} is not callable.`, expression.callee.span); result = errorType; }
      else {
        if (callee.native && nonRenderingAuthoringNatives.has(callee.native) && !allowAnnotationStatementRoot) {
          if (semanticMatchAuthoringNatives.has(callee.native)) {
            diagnostic(
              "CUT_MATCH_SCOPE",
              `${callee.name} is a non-rendering declaration and is valid only as a direct ${callee.native === "cut.edit.match_subject" ? "scene" : "timeline"} statement.`,
              expression.span,
            );
          } else if (timelineEditAuthoringNatives.has(callee.native)) {
            diagnostic(
              "CUT_TIMELINE_EDIT_SCOPE",
              `${callee.name} authors a canonical editorial transaction and is valid only as a direct scene statement.`,
              expression.span,
              "Place TimelineEdit(...) directly in the scene that owns its selected tracks; it is not a value or render node.",
            );
          } else if (linkedEditAuthoringNatives.has(callee.native)) {
            const contract = linkedEditStatementContract(callee.native, callee.name);
            diagnostic(
              contract.code,
              `${callee.name} authors an editorial transaction and is valid only as a direct scene statement.`,
              expression.span,
              contract.hint,
            );
          } else {
            diagnostic(
              "CUT_ANNOTATION_CONTEXT",
              `${callee.name} authors ordered editorial metadata and is valid only as a direct timeline or scene statement.`,
              expression.span,
              "Place Marker(...) or Region(...) directly in a timeline/scene statement block; use marker(...) or region(...) to query an earlier declaration as a value.",
            );
          }
        }
        if (callee.native === "cut.edit.transcript_audio" && !allowTranscriptAudioTrackItemRoot) {
          diagnostic(
            "CUT_TRANSCRIPT_SCOPE",
            "TranscriptAudio is valid only as a direct AudioTrack item; it cannot be detached, nested, or used as a value.",
            expression.span,
            "Place TranscriptAudio(edit: ...) directly inside AudioTrack; the compiler lowers it to one ordinary sample-accurate AudioClip.",
          );
        }
        if (callee.native === "cut.edit.transcript_picture" && !allowTranscriptPictureTrackItemRoot) {
          diagnostic(
            "CUT_TRANSCRIPT_SCOPE",
            "TranscriptPicture is valid only as a direct PictureTrack item; it cannot be detached, nested, or used as a value.",
            expression.span,
            "Place TranscriptPicture(edit: ..., source: ...) directly inside PictureTrack; the compiler lowers it to one ordinary frame-quantized PictureClip.",
          );
        }
        if (callee.native?.startsWith("cut.asset.") && !allowDirectAssetConstructor) {
          diagnostic(
            "CUT2057",
            `Asset constructor “${callee.name}” is only valid as the direct initializer of an asset declaration.`,
            expression.callee.span,
            `Use “asset name: ${displayType(callee.result)} = ${callee.name}(\"path\");” and reference that asset by name elsewhere.`,
          );
        }
        effects.add(callee.effect);
        const isKernelCall = callee.domain !== undefined && ["visual", "audio", "av"].includes(callee.domain);
        const kernel = isKernelCall && callee.native ? referenceKernelSchema(callee.native) : undefined;
        const isDiagramCall = callee.native?.startsWith("cut.diagram.")
          || callee.name === "diagramEdge"
          || callee.name === "diagramState";
        const isMediaCamera2DCall = callee.native === cutMediaCamera2DOp;
        const isCalloutCall = callee.native === "cut.visual.callout_layer"
          || callee.native === "cut.visual.callout";
        if (isKernelCall && callee.native) {
          if (!kernel) diagnostic("CUT2058", `No executable reference-kernel contract is registered for ${callee.native}.`, expression.callee.span, "Register a closed kernel schema before exposing this component as implemented.");
          else if (kernel.support === "refused") diagnostic("CUT2058", `Reference kernel ${callee.native} is unavailable: ${kernel.reason}`, expression.callee.span);
        }
        const supplied = new Map<string, Expression>();
        expression.positional.forEach((value, index) => {
          const parameter = callee.parameters[index];
          if (!parameter) diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2025", `Too many positional arguments for ${callee.name}.`, value.span);
          else {
            supplied.set(parameter.name, value);
            if (kernel?.support === "supported"
              && !kernelAcceptsAuthoringInput(kernel, parameter.name)
              && !isCanonicalTimelineIdentityAuthoringInput(callee.native, parameter.name)) {
              diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2059", `Reference kernel ${callee.native} does not execute input “${parameter.name}”.`, value.span);
            }
            const allowed = kernel?.support === "supported" ? kernelStringInputValues(kernel, parameter.name) : undefined;
            if (allowed && value.kind === "string" && !allowed.includes(value.value)) diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isMediaCamera2DCall ? "CUT_MEDIA_CAMERA_VALUE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2068", `Reference kernel ${callee.native} input “${parameter.name}” must be one of: ${allowed.join(", ")}.`, value.span);
          }
        });
        for (const item of expression.named) {
          if (supplied.has(item.name)) diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2026", `Argument “${item.name}” is supplied more than once.`, item.span);
          supplied.set(item.name, item.value);
          if (kernel?.support === "supported"
            && !kernelAcceptsAuthoringInput(kernel, item.name)
            && !isCanonicalTimelineIdentityAuthoringInput(callee.native, item.name)) {
            const acceptedInputs = [...(kernel.authoringInputs ?? []), ...kernel.inputs];
            const accepted = `Accepted inputs: ${acceptedInputs.join(", ") || "none"}.`;
            const replacement = callee.native === "cut.documentary.narration" && item.name === "transcript"
              ? " Use Captions for visible timed text, or Marker/Region with role: \"transcript\" and comment metadata for non-rendering notes."
              : "";
            diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2059", `Reference kernel ${callee.native} does not execute input “${item.name}”.`, item.span, `${accepted}${replacement}`);
          }
          else if (!callee.parameters.some((parameter) => parameter.name === item.name) && !callee.openNamed) diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2027", `${callee.name} has no parameter “${item.name}”.`, item.span);
          const allowed = kernel?.support === "supported" ? kernelStringInputValues(kernel, item.name) : undefined;
          if (allowed && item.value.kind === "string" && !allowed.includes(item.value.value)) diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isMediaCamera2DCall ? "CUT_MEDIA_CAMERA_VALUE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2068", `Reference kernel ${callee.native} input “${item.name}” must be one of: ${allowed.join(", ")}.`, item.value.span);
        }
        if (callee.native === "cut.visual.transcript_captions") {
          const maxWords = supplied.get("maxWords");
          if (maxWords && staticTranscriptCaptionMaxWordsIsInvalid(maxWords)) {
            diagnostic(
              "CUT_TRANSCRIPT_LIMIT",
              `TranscriptCaptions maxWords must be one exact whole Number from ${cutTranscriptExecutableLimits.minimumCaptionMaxWords} through ${cutTranscriptExecutableLimits.maximumCaptionMaxWords}.`,
              maxWords.span,
              "Choose the maximum number of transcript words allowed in one deterministic caption cue; CUT never rounds this value.",
            );
          }
        }
        if (callee.native === "cut.visual.captions" || callee.native === "cut.visual.transcript_captions") {
          const size = supplied.get("size");
          if (size && staticCaptionSizeIsInvalid(size)) {
            diagnostic(
              "CUT_CAPTION_VALUE_RANGE",
              `${callee.name} size must resolve to a pixel Length from ${cutCaptionAppearanceLimits.minimumSizePx}px through ${cutCaptionAppearanceLimits.maximumSizePx}px; CUT never clamps caption typography at render time.`,
              size.span,
            );
          }
        }
        if (callee.native === "cut.visual.text") {
          if (supplied.has("tracking") && supplied.has("letterSpacing")) {
            const conflict = expression.named.find((item) => item.name === "letterSpacing")?.span ?? expression.span;
            diagnostic("CUT2077", "Text inputs “tracking” and “letterSpacing” are aliases; supply exactly one.", conflict);
          }
          const shadowNames = ["shadowColor", "shadowOpacity", "shadowBlur"];
          const shadowCount = shadowNames.filter((name) => supplied.has(name)).length;
          if (shadowCount !== 0 && shadowCount !== shadowNames.length) {
            const conflict = expression.named.find((item) => shadowNames.includes(item.name))?.span ?? expression.span;
            diagnostic("CUT2078", "Text shadowColor, shadowOpacity, and shadowBlur must be supplied together so no shadow input becomes a no-op.", conflict);
          }
        }
        if (callee.native === "cut.visual.flow_text") checkStaticFlowTextSpanRedundancy(expression, callee.parameters);
        if (callee.native === "cut.asset.video" || callee.native === "cut.asset.audio") {
          const path = supplied.get("path"), proxy = supplied.get("proxy");
          if (path?.kind === "string" && proxy?.kind === "string" && path.value === proxy.value) {
            diagnostic("CUT2084", `${callee.name} proxy must differ from its master path; an identical proxy is a no-op.`, proxy.span, "Remove proxy:, or point it at independently encoded editorially-equivalent media.");
          }
          const selectorNames = callee.native === "cut.asset.video"
            ? ["videoStream", "audioStream", "proxyVideoStream", "proxyAudioStream"]
            : ["stream", "proxyStream"];
          for (const name of selectorNames) {
            const selector = supplied.get(name);
            if (selector && staticMediaStreamIndexIsInvalid(selector)) {
              diagnostic(
                "CUT_MEDIA_STREAM_SELECTOR",
                `${callee.name} ${name} must be a non-negative safe integer absolute ffprobe/ffmpeg stream index; CUT never rounds a selector.`,
                selector.span,
              );
            }
          }
          const proxySelectors = callee.native === "cut.asset.video"
            ? ["proxyVideoStream", "proxyAudioStream"]
            : ["proxyStream"];
          for (const name of proxySelectors) {
            const selector = supplied.get(name);
            if (selector && !proxy) {
              diagnostic(
                "CUT_MEDIA_STREAM_PROXY",
                `${callee.name} ${name} requires an authored proxy path.`,
                selector.span,
                "Add proxy: \"path\", or remove the proxy stream selector.",
              );
            }
          }
        }
        if (callee.native === "cut.visual.video") {
          const authoredLoop = supplied.get("loop");
          if (authoredLoop?.kind === "boolean" && authoredLoop.value) {
            if (supplied.has("endBehavior")) diagnostic("CUT2080", "Video cannot combine loop: true with endBehavior because a looping source has no authored end to hold or reject.", authoredLoop.span);
          }
        }
        if (callee.native === "cut.visual.path") {
          const points = supplied.get("points"), geometry = supplied.get("geometry");
          if (Boolean(points) === Boolean(geometry)) {
            diagnostic("CUT_VECTOR_PATH_GEOMETRY", "Path requires exactly one geometry form: legacy points:, or retained geometry:.", (geometry ?? points)?.span ?? expression.span, "Supply one form and remove the other.");
          }
          if (points) {
            const retainedOnly = ["morphTo", "morph", "trimStart", "trimEnd", "dash", "dashOffset", "fill", "fillRule", "lineCap", "lineJoin", "x", "y"];
            const incompatible = retainedOnly.find((name) => supplied.has(name));
            if (incompatible) diagnostic("CUT_VECTOR_PATH_LEGACY", `Path ${incompatible}: requires retained geometry:; legacy points: preserves the exact pre-0.4 renderer and cache behavior.`, supplied.get(incompatible)!.span, "Use vectorPath(...) or anchoredPath(...) as geometry:, or remove the retained-only control.");
          }
          const morphTo = supplied.get("morphTo"), morph = supplied.get("morph");
          if (Boolean(morphTo) !== Boolean(morph)) {
            diagnostic("CUT_VECTOR_PATH_MORPH", "Path morphTo: and morph: must be supplied together.", (morphTo ?? morph)!.span, "Supply both controls, or remove both.");
          }
          const staticNominalName = (value: Expression | undefined): string | undefined => {
            if (!value) return undefined;
            const current = unwrapStaticGroup(value);
            if (current.kind === "identifier") {
              const type = scope.lookup(current.name)?.type;
              return type?.kind === "nominal" ? type.name : undefined;
            }
            if (current.kind === "call" && current.callee.kind === "identifier") {
              const type = scope.lookup(current.callee.name)?.type;
              return type?.kind === "callable" && type.result.kind === "nominal" ? type.result.name : undefined;
            }
            return undefined;
          };
          if (morphTo && staticNominalName(geometry) === "AnchoredPathGeometry") {
            diagnostic(
              "CUT_ANCHORED_PATH_MORPH",
              "AnchoredPathGeometry cannot be combined with Path morphTo:/morph: in the v1 owner-resolved slice.",
              morphTo.span,
              "Remove morphTo:/morph:, or use VectorPathGeometry for both source and target geometry.",
            );
          }
        }
        if (callee.name === "anchoredPath") {
          const segments = supplied.get("segments");
          if (segments?.kind === "array" && (segments.items.length < 1 || segments.items.length > cutAnchoredPathLimits.maximumSegments)) {
            diagnostic(
              "CUT_ANCHORED_PATH_GEOMETRY",
              `anchoredPath segments must contain 1 through ${cutAnchoredPathLimits.maximumSegments} anchored line/cubic segments.`,
              segments.span,
            );
          }
        }
        if (callee.native === "cut.visual.local_space") {
          const literalNumber = (value: Expression | undefined) => {
            if (value?.kind !== "number") return undefined;
            const exact = decimalRational(value.raw.slice(0, value.raw.length - value.unit.length));
            return { value, exact, number: Number(exact.numerator) / Number(exact.denominator) };
          };
          const dimensions = new Map<string, Rational>();
          for (const name of ["width", "height"] as const) {
            const literal = literalNumber(supplied.get(name));
            if (!literal) continue;
            if (literal.value.unit !== "px" || literal.exact.denominator !== "1"
              || compareRational(literal.exact, rational(1)) < 0 || compareRational(literal.exact, rational(16_384)) > 0) {
              diagnostic("CUT_LOCAL_SPACE_BOUNDS", `LocalSpace ${name} must be a positive whole-pixel Length no larger than 16384px.`, literal.value.span);
            } else dimensions.set(name, literal.exact);
          }
          const origin = supplied.get("origin");
          if (origin?.kind === "object") {
            const keys = origin.entries.map((entry) => entry.key);
            const unknown = origin.entries.find((entry) => entry.key !== "x" && entry.key !== "y");
            if (unknown || keys.length !== 2 || !keys.includes("x") || !keys.includes("y")) {
              diagnostic("CUT_LOCAL_SPACE_TYPE", "LocalSpace origin must contain exactly x and y pixel Length fields.", unknown?.span ?? origin.span);
            }
            for (const axis of ["x", "y"] as const) {
              const entry = origin.entries.find((candidate) => candidate.key === axis);
              const literal = literalNumber(entry?.value);
              if (!literal) continue;
              const maximum = dimensions.get(axis === "x" ? "width" : "height");
              if (literal.value.unit !== "px" || !Number.isFinite(literal.number)
                || compareRational(literal.exact, rational(0)) < 0 || (maximum !== undefined && compareRational(literal.exact, maximum) > 0)) {
                diagnostic(
                  "CUT_LOCAL_SPACE_BOUNDS",
                  `LocalSpace origin.${axis} must be a finite pixel Length inside the declared closed ${axis === "x" ? "width" : "height"} range.`,
                  literal.value.span,
                );
              }
            }
          }
        }
        if (isDiagramCall) {
          const positiveLength = (name: string, wholePixels = false, allowZero = false) => {
            const value = supplied.get(name);
            if (!value) return;
            const exact = staticPixelLength(value);
            if (exact === undefined) return;
            if (compareRational(exact, rational(allowZero ? 0 : 1)) < 0
              || compareRational(exact, rational(65_536)) > 0
              || (wholePixels && exact.denominator !== "1")) {
              diagnostic(
                wholePixels ? "CUT_DIAGRAM_TYPE" : "CUT_DIAGRAM_BOUNDS",
                `${callee.name} ${name} must be ${wholePixels ? "a positive whole-pixel" : allowZero ? "a non-negative" : "a positive"} Length no larger than 65536px.`,
                value.span,
              );
            }
          };
          if (callee.native === "cut.diagram.layout") {
            const width = supplied.get("width"), height = supplied.get("height");
            if (Boolean(width) !== Boolean(height)) {
              diagnostic("CUT_DIAGRAM_TYPE", "DiagramLayout width and height must be supplied together.", (width ?? height)!.span);
            }
            const fromState = supplied.get("fromState"), progress = supplied.get("progress");
            if (Boolean(fromState) !== Boolean(progress)) {
              diagnostic("CUT_DIAGRAM_TYPE", "DiagramLayout fromState and progress must be supplied together.", (fromState ?? progress)!.span);
            }
            const staticIdentifier = (value: Expression | undefined) => {
              if (!value) return undefined;
              const unwrapped = unwrapStaticGroup(value);
              return unwrapped.kind === "identifier" ? unwrapped.name : undefined;
            };
            if (fromState && staticIdentifier(fromState) === staticIdentifier(supplied.get("state"))) {
              diagnostic("CUT_DIAGRAM_NOOP", "DiagramLayout fromState and state are the same value, so progress cannot affect output.", fromState.span);
            }
            positiveLength("width", true);
            positiveLength("height", true);
            for (const name of ["nodeGap", "rankGap", "edgeGap"] as const) positiveLength(name);
            positiveLength("edgeClearance", false, true);
          } else if (callee.native === "cut.diagram.node") {
            positiveLength("width", true);
            positiveLength("height", true);
            const rankExpression = supplied.get("rank"), rank = rankExpression && unwrapStaticGroup(rankExpression);
            if (rank?.kind === "number" && rank.unit === "") {
              const exact = decimalRational(rank.raw);
              const number = Number(exact.numerator) / Number(exact.denominator);
              if (exact.denominator !== "1" || !Number.isSafeInteger(number) || number < 0 || number > 31) {
                diagnostic("CUT_DIAGRAM_GRAPH", "DiagramNode rank must be a whole Number from 0 through 31.", rank.span);
              }
            }
          } else if (callee.name === "diagramEdge") {
            positiveLength("width");
            const from = supplied.get("from"), to = supplied.get("to");
            if (from?.kind === "string" && to?.kind === "string" && from.value === to.value) {
              diagnostic("CUT_DIAGRAM_GRAPH", "diagramEdge cannot connect a node to itself.", to.span);
            }
          }
        }
        if (callee.native === "cut.visual.motion_path") {
          const points = supplied.get("points"), geometry = supplied.get("geometry"), closed = supplied.get("closed");
          if (Boolean(points) === Boolean(geometry)) {
            diagnostic(
              "CUT_MOTION_PATH_GEOMETRY",
              "MotionPath requires exactly one path form: points:, or geometry:.",
              (geometry ?? points)?.span ?? expression.span,
              "Supply one form and remove the other.",
            );
          }
          if (geometry && closed) {
            diagnostic(
              "CUT_MOTION_PATH_GEOMETRY",
              "MotionPath closed: cannot be authored with geometry: because VectorPathGeometry owns its closure; AnchoredPathGeometry owns its closure too.",
              closed.span,
              "Remove closed: and set closed when constructing vectorPath(...) or anchoredPath(...).",
            );
          }
          if (points && closed?.kind === "boolean" && !closed.value) {
            diagnostic("CUT_MOTION_PATH_NOOP", "MotionPath closed: false is the points-form default and cannot affect execution.", closed.span, "Omit closed: false.");
          }
          const orientToPath = supplied.get("orientToPath");
          if (orientToPath?.kind === "boolean" && !orientToPath.value) {
            diagnostic("CUT_MOTION_PATH_NOOP", "MotionPath orientToPath: false is the default and cannot affect execution.", orientToPath.span, "Omit orientToPath: false.");
          }
        }
        if (callee.native === "cut.visual.trace") {
          const points = supplied.get("points"), start = supplied.get("start"), curves = supplied.get("curves"), arrow = supplied.get("arrow"), headRadius = supplied.get("headRadius");
          const hasCubicPart = Boolean(start || curves);
          if (points && hasCubicPart) {
            diagnostic("CUT_TRACE_GEOMETRY", "Trace must use exactly one geometry form: points:, or start: with curves:; the forms cannot be mixed.", (start ?? curves)!.span, "Remove points:, or remove both start: and curves:.");
          } else if (!points && (!start || !curves)) {
            diagnostic("CUT_TRACE_GEOMETRY", "Trace requires points:, or the complete start: with curves: geometry form.", (start ?? curves)?.span ?? expression.span, "Supply points:, or supply both start: and curves:.");
          }
          if (arrow && headRadius?.kind === "number") {
            const numeric = Number(headRadius.raw.slice(0, headRadius.raw.length - headRadius.unit.length));
            if (Number.isFinite(numeric) && numeric > 0) diagnostic("CUT_TRACE_ARROW", "Trace arrow: and a positive legacy headRadius: are mutually exclusive endpoint markers.", arrow.span, "Remove headRadius/headColor, or remove arrow:.");
          }
        }
        if (callee.native === "cut.geo.route_subject") {
          const authoredPoints = supplied.get("points");
          const points = authoredPoints ? unwrapStaticGroup(authoredPoints) : undefined;
          if (points?.kind === "array") {
            for (const item of points.items) {
              const point = unwrapStaticGroup(item);
              if (point.kind !== "object") continue;
              const label = point.entries.find((entry) => entry.key === "label");
              if (label) {
                diagnostic(
                  "CUT_MAP_CAMERA_CHILD",
                  "RouteSubject points are unlabeled coordinates; label is unsupported because the moving subject owns no text-shaping or label-placement semantics.",
                  label.span,
                  "Remove label from this RouteSubject point; use a separate Marker or GeoAnnotation for visible text.",
                );
              }
            }
          }
        }
        if (callee.native === "cut.geo.annotation") {
          const anchor = supplied.get("anchor");
          if (anchor?.kind === "object") {
            const keys = anchor.entries.map((entry) => entry.key);
            const unknown = anchor.entries.find((entry) => entry.key !== "latitude" && entry.key !== "longitude");
            if (unknown || keys.length !== 2 || !keys.includes("latitude") || !keys.includes("longitude")) {
              diagnostic(
                "CUT_GEO_ANNOTATION_TYPE",
                "GeoAnnotation anchor must contain exactly latitude and longitude; label and every other field are rejected because visible content belongs to the public child.",
                unknown?.span ?? anchor.span,
              );
            }
          }
          const placements = supplied.get("placements");
          if (placements?.kind === "array") {
            const allowed = new Set(["right", "above", "below", "left"]);
            if (placements.items.length < 1 || placements.items.length > 4) {
              diagnostic("CUT_GEO_ANNOTATION_LIMIT", "GeoAnnotation placements must contain one through four unique directions.", placements.span);
            }
            const seen = new Set<string>();
            for (const placement of placements.items) {
              if (placement.kind !== "string" || !allowed.has(placement.value)) {
                diagnostic("CUT_GEO_ANNOTATION_TYPE", "GeoAnnotation placement must be one of: right, above, below, left.", placement.span);
              } else if (seen.has(placement.value)) {
                diagnostic("CUT_GEO_ANNOTATION_NOOP", `GeoAnnotation placement “${placement.value}” is duplicated and can never be reached.`, placement.span);
              } else seen.add(placement.value);
            }
          }
          const literalNumber = (name: string) => {
            const value = supplied.get(name);
            if (value?.kind !== "number") return undefined;
            return { value, number: Number(value.raw.slice(0, value.raw.length - value.unit.length)) };
          };
          for (const dimension of ["width", "height"] as const) {
            const literal = literalNumber(dimension);
            if (literal && (!Number.isInteger(literal.number) || literal.number < 1 || literal.value.unit !== "px")) {
              diagnostic("CUT_GEO_ANNOTATION_TYPE", `GeoAnnotation ${dimension} must be a positive whole-pixel Length.`, literal.value.span);
            }
          }
          const offset = literalNumber("offset");
          if (offset && (offset.value.unit !== "px" || offset.number < 1)) {
            diagnostic("CUT_GEO_ANNOTATION_TYPE", "GeoAnnotation offset must be a finite delivery-pixel Length of at least 1px.", offset.value.span);
          }
          const safeArea = literalNumber("safeArea");
          if (safeArea && (safeArea.value.unit !== "px" || safeArea.number <= 0)) {
            diagnostic("CUT_GEO_ANNOTATION_SAFE_AREA", "GeoAnnotation safeArea must be a positive delivery-pixel Length.", safeArea.value.span);
          }
          const priority = literalNumber("priority");
          if (priority && (priority.value.unit !== "" || !Number.isInteger(priority.number) || priority.number === 0 || Math.abs(priority.number) > 1_000_000)) {
            diagnostic("CUT_GEO_ANNOTATION_TYPE", "GeoAnnotation priority must be a whole Number from -1000000 through 1000000 other than zero.", priority.value.span);
          }
          const leader = supplied.get("leader"), leaderColor = supplied.get("leaderColor"), leaderWidth = supplied.get("leaderWidth");
          if (leader?.kind === "string") {
            if (leader.value === "none" && (leaderColor || leaderWidth)) {
              diagnostic("CUT_GEO_ANNOTATION_NOOP", "GeoAnnotation leader: none forbids leaderColor and leaderWidth because neither could execute.", (leaderColor ?? leaderWidth)!.span);
            }
            if ((leader.value === "straight" || leader.value === "elbow") && (!leaderColor || !leaderWidth)) {
              diagnostic("CUT_GEO_ANNOTATION_STYLE", `GeoAnnotation leader: ${leader.value} requires both leaderColor and leaderWidth.`, leader.span);
            }
          }
        }
        if (callee.native === "cut.visual.callout") {
          const placements = supplied.get("placements");
          if (placements?.kind === "array") {
            const allowed = new Set(["right", "above", "below", "left"]);
            if (placements.items.length < 1 || placements.items.length > 4) {
              diagnostic("CUT_CALLOUT_LIMIT", "Callout placements must contain one through four unique directions.", placements.span);
            }
            const seen = new Set<string>();
            for (const placement of placements.items) {
              if (placement.kind !== "string" || !allowed.has(placement.value)) {
                diagnostic("CUT_CALLOUT_TYPE", "Callout placement must be one of: right, above, below, left.", placement.span);
              } else if (seen.has(placement.value)) {
                diagnostic("CUT_CALLOUT_NOOP", `Callout placement “${placement.value}” is duplicated and can never execute.`, placement.span);
              } else seen.add(placement.value);
            }
          }

          const staticQuantity = (name: string, unit: string) => {
            const authored = supplied.get(name);
            if (!authored) return undefined;
            let current = unwrapStaticGroup(authored), sign = 1n;
            while (current.kind === "unary" && current.operator === "-") {
              sign = -sign;
              current = unwrapStaticGroup(current.value);
            }
            if (current.kind !== "number" || current.unit !== unit || decimalLiteralExceedsRationalBudget(current)) return undefined;
            const literal = decimalRational(current.raw.slice(0, current.raw.length - current.unit.length));
            return {
              authored,
              exact: sign < 0n ? rational(-BigInt(literal.numerator), literal.denominator) : literal,
            };
          };
          const offset = staticQuantity("offset", "px");
          if (offset) {
            if (compareRational(offset.exact, rational(0)) <= 0) {
              diagnostic("CUT_CALLOUT_TYPE", "Callout offset must be a positive pixel Length.", offset.authored.span);
            } else if (compareRational(offset.exact, rational(65_536)) > 0) {
              diagnostic("CUT_CALLOUT_LIMIT", "Callout offset cannot exceed 65536px.", offset.authored.span);
            }
          }
          const safeArea = staticQuantity("safeArea", "px");
          if (safeArea) {
            if (compareRational(safeArea.exact, rational(0)) < 0) {
              diagnostic("CUT_CALLOUT_TYPE", "Callout safeArea must be a non-negative pixel Length; 0px is executable.", safeArea.authored.span);
            } else if (compareRational(safeArea.exact, rational(65_536)) > 0) {
              diagnostic("CUT_CALLOUT_LIMIT", "Callout safeArea cannot exceed 65536px.", safeArea.authored.span);
            }
          }
          const priority = staticQuantity("priority", "");
          if (priority) {
            if (priority.exact.denominator !== "1") {
              diagnostic("CUT_CALLOUT_TYPE", "Callout priority must be an exact whole Number.", priority.authored.span);
            } else if (compareRational(priority.exact, rational(0)) === 0) {
              diagnostic("CUT_CALLOUT_NOOP", "Callout priority: 0 repeats omitted source ordering and cannot affect execution.", priority.authored.span);
            } else if (compareRational(priority.exact, rational(-1_000_000)) < 0
              || compareRational(priority.exact, rational(1_000_000)) > 0) {
              diagnostic("CUT_CALLOUT_LIMIT", "Callout priority must be within -1000000 through 1000000.", priority.authored.span);
            }
          }
          const leader = supplied.get("leader"), leaderColor = supplied.get("leaderColor"), leaderWidth = supplied.get("leaderWidth");
          if (leader?.kind === "string") {
            if (leader.value === "none" && (leaderColor || leaderWidth)) {
              diagnostic("CUT_CALLOUT_NOOP", "Callout leader: none forbids leaderColor and leaderWidth because neither could execute.", (leaderColor ?? leaderWidth)!.span);
            } else if ((leader.value === "straight" || leader.value === "elbow") && (!leaderColor || !leaderWidth)) {
              diagnostic("CUT_CALLOUT_STYLE", `Callout leader: ${leader.value} requires both leaderColor and leaderWidth.`, leader.span);
            }
          }
          const staticLeaderColor = leaderColor ? staticColorLiteral(leaderColor) : undefined;
          if (staticLeaderColor?.endsWith("00")) {
            diagnostic("CUT_CALLOUT_NOOP", "Callout leaderColor cannot be fully transparent because the leader would be inert.", leaderColor!.span);
          }
          const width = staticQuantity("leaderWidth", "px");
          if (width) {
            if (compareRational(width.exact, rational(0)) <= 0) {
              diagnostic("CUT_CALLOUT_TYPE", "Callout leaderWidth must be a positive pixel Length.", width.authored.span);
            } else if (compareRational(width.exact, rational(65_536)) > 0) {
              diagnostic("CUT_CALLOUT_LIMIT", "Callout leaderWidth cannot exceed 65536px.", width.authored.span);
            }
          }
          const opacity = staticQuantity("opacity", "%");
          if (opacity) {
            const normalized = rational(BigInt(opacity.exact.numerator), BigInt(opacity.exact.denominator) * 100n);
            if (compareRational(normalized, rational(0)) < 0 || compareRational(normalized, rational(1)) > 0) {
              diagnostic("CUT_CALLOUT_TYPE", "Callout opacity must be within 0% through 100%.", opacity.authored.span);
            }
          }
        }
        if (callee.native === "cut.geo.map" || callee.native === "cut.geo.marker" || callee.native === "cut.geo.connections") {
          let labelKnown = false, label: Expression | undefined;
          if (callee.native === "cut.geo.map") labelKnown = !supplied.has("points");
          else if (callee.native === "cut.geo.marker" && supplied.has("label")) {
            label = supplied.get("label"); labelKnown = label?.kind === "string";
          } else {
            const point = supplied.get(callee.native === "cut.geo.marker" ? "point" : "target");
            if (point?.kind === "object") {
              const entry = point.entries.find((item) => item.key === "label");
              label = entry?.value; labelKnown = entry === undefined || entry.value.kind === "string";
            }
          }
          if (labelKnown) {
            const visible = label?.kind === "string" && label.value.trim().length > 0, font = supplied.get("font");
            if (visible && !font) diagnostic("CUT2082", `${callee.name} has a visible label and therefore requires font: FontAsset; host font fallback is forbidden.`, label!.span, "Declare a locked project font asset and pass it as font:.");
            if (!visible && font) diagnostic("CUT2083", `${callee.name} font would be a no-op because this literal node has no visible label.`, font.span, "Remove font:, or author a non-empty label.");
          }
        }
        for (const parameter of callee.parameters) {
          const value = supplied.get(parameter.name);
          if (!value && !parameter.optional) diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2028", `Missing required argument “${parameter.name}” for ${callee.name}.`, expression.span);
          if (value) {
            const actual = checkExpression(value, scope);
            if (!acceptsType(parameter.type, actual)) diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isMediaCamera2DCall ? "CUT_MEDIA_CAMERA_VALUE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2029", `Argument “${parameter.name}” expects ${displayType(parameter.type)}, found ${displayType(actual)}.`, value.span);
            if (parameter.values && value.kind === "string" && !parameter.values.includes(value.value)) {
              const kernelValues = kernel?.support === "supported" ? kernelStringInputValues(kernel, parameter.name) : undefined;
              const alreadyRejectedByKernel = Boolean(kernelValues && !kernelValues.includes(value.value));
              if (!alreadyRejectedByKernel) diagnostic(isDiagramCall ? "CUT_DIAGRAM_TYPE" : isMediaCamera2DCall ? "CUT_MEDIA_CAMERA_VALUE" : isCalloutCall ? "CUT_CALLOUT_TYPE" : "CUT2068", `Argument “${parameter.name}” for ${callee.name} must be one of: ${parameter.values.join(", ")}.`, value.span);
            }
          }
        }
        for (const item of expression.named) if (!callee.parameters.some((parameter) => parameter.name === item.name)) checkExpression(item.value, scope);
        result = callee.result;
      }
    }
    expressionTypes.set(expression, result); return result;
  };

  const mutationRootName = (target: Extract<Expression, { kind: "identifier" | "member" }>): string | undefined => {
    let current: Expression = target;
    while (current.kind === "member") current = current.object;
    return current.kind === "identifier" ? current.name : undefined;
  };
  const isExecutableMutationTarget = (target: Extract<Expression, { kind: "identifier" | "member" }>, scope: Scope) => {
    if (target.kind !== "member") return false;
    const name = mutationRootName(target), binding = name ? scope.lookup(name) : undefined;
    return Boolean(binding?.kernel && isNodeType(binding.type));
  };
  const isLocalExecutableMutationStatement = (statement: Statement, scope: Scope) => {
    if (statement.kind !== "set" && statement.kind !== "animate") return false;
    const name = mutationRootName(statement.target), binding = name ? scope.lookupOwn(name) : undefined;
    return Boolean(binding?.kernel && isNodeType(binding.type));
  };
  const isDirectCalloutOpacityAnimation = (statement: Statement, scope: Scope) => {
    if (statement.kind !== "animate"
      || statement.target.kind !== "member"
      || statement.target.property !== "opacity"
      || statement.target.object.kind !== "identifier") return false;
    const binding = scope.lookupOwn(statement.target.object.name);
    return binding?.kernel === "cut.visual.callout" && isNodeType(binding.type);
  };
  const isDirectResponsiveMediaCameraMutation = (statement: Statement, scope: Scope) => {
    if ((statement.kind !== "set" && statement.kind !== "animate")
      || statement.target.kind !== "member"
      || statement.target.object.kind !== "identifier"
      || !["focusX", "focusY", "zoom", "rotation", "opacity"].includes(statement.target.property)) return false;
    const binding = scope.lookupOwn(statement.target.object.name);
    return binding?.kernel === cutMediaCamera2DOp && isNodeType(binding.type);
  };
  const nativeNode = (statement: Statement) => {
    if (statement.kind !== "node") return undefined;
    const resolved = expressionTypes.get(statement.expression.callee);
    return resolved?.kind === "callable" ? resolved.native : undefined;
  };
  const responsiveStackEscapedCameraAliases = (
    statement: Extract<Statement, { kind: "node" }>,
  ) => statement.body.flatMap((slot) => {
    if (slot.kind !== "node" || nativeNode(slot) !== "cut.visual.responsive_slot") return [];
    const directNodes = slot.body.filter((item): item is Extract<Statement, { kind: "node" }> => item.kind === "node");
    if (directNodes.length !== 1) return [];
    const camera = directNodes[0]!;
    return nativeNode(camera) === cutMediaCamera2DOp && camera.binding
      ? [{ name: camera.binding, statement: camera, type: expressionTypes.get(camera.expression) ?? nominal("Visual") }]
      : [];
  });
  const authoredPackageSymbol = (expression: Expression) => {
    const callee = unwrapStaticGroup(expression);
    if (callee.kind !== "identifier") return undefined;
    return imports.get(callee.name)?.symbol ?? symbols.get(callee.name)?.packageSymbol;
  };
  const authoredNodeNative = (statement: Statement) =>
    statement.kind === "node" ? authoredPackageSymbol(statement.expression.callee)?.native : undefined;
  const expressionVisualAnchorOwners = (expression: Expression) =>
    expressionCalls(expression).flatMap((call) => {
      const callee = unwrapStaticGroup(call.callee);
      if (callee.kind !== "identifier") return [];
      const imported = imports.get(callee.name);
      const symbol = imported?.symbol ?? symbols.get(callee.name)?.packageSymbol;
      if (imported?.specifier !== "cut:visual"
        || imported.imported !== "visualAnchor"
        || symbol?.name !== "visualAnchor") return [];
      const authoredOwner = call.named.find((argument) => argument.name === "owner")?.value
        ?? call.positional[0];
      if (authoredOwner === undefined) return [undefined];
      const resolvedOwner = unwrapStaticGroup(authoredOwner);
      return [resolvedOwner.kind === "identifier" ? resolvedOwner.name : undefined];
    });
  const statementVisualAnchorOwners = (statement: Statement): Array<string | undefined> => {
    if (statement.kind !== "node") return [];
    return [
      ...expressionVisualAnchorOwners(statement.expression),
      ...statement.body.flatMap(statementVisualAnchorOwners),
    ];
  };
  const responsiveAnnotatedComponentShape = (
    declaration: Extract<Declaration, { kind: "component" }>,
  ) => {
    if (declaration.returnType?.name !== "Visual") return undefined;
    const stackIndexes = declaration.body.flatMap((statement, index) =>
      authoredNodeNative(statement) === "cut.visual.responsive_stack" ? [index] : []);
    if (stackIndexes.length !== 1) return undefined;
    const stackIndex = stackIndexes[0]!;
    if (declaration.body.slice(0, stackIndex).some((statement) => statement.kind !== "let")) return undefined;
    const stack = declaration.body[stackIndex];
    if (stack?.kind !== "node") return undefined;
    const consumers = declaration.body.slice(stackIndex + 1);
    if (!consumers.length || consumers.some((statement) =>
      statement.kind !== "node"
      || (authoredNodeNative(statement) !== "cut.visual.path"
        && authoredNodeNative(statement) !== "cut.visual.callout_layer"))) return undefined;
    const consumerNatives = consumers.map(authoredNodeNative);
    if (consumerNatives.filter((native) => native === "cut.visual.path").length > 1
      || consumerNatives.filter((native) => native === "cut.visual.callout_layer").length > 1) return undefined;
    const cameras = stack.body.flatMap((slot) => {
      if (slot.kind !== "node" || authoredNodeNative(slot) !== "cut.visual.responsive_slot") return [];
      const directNodes = slot.body.filter(
        (statement): statement is Extract<Statement, { kind: "node" }> => statement.kind === "node",
      );
      const camera = directNodes.length === 1 ? directNodes[0] : undefined;
      return camera && authoredNodeNative(camera) === cutMediaCamera2DOp
        ? [camera]
        : [];
    });
    if (cameras.length !== 1 || !cameras[0]!.binding) return undefined;
    const cameraAlias = cameras[0]!.binding;
    if (consumers.some((consumer) => {
      const owners = statementVisualAnchorOwners(consumer);
      return owners.length === 0 || owners.some((owner) => owner !== cameraAlias);
    })) return undefined;
    return { stack, cameraAlias, consumers };
  };
  for (const declaration of module.declarations) {
    if (declaration.kind === "component" && responsiveAnnotatedComponentShape(declaration)) {
      responsiveAnnotatedComponents.add(declaration.name);
    }
  }

  type EditorialParent = "cut.edit.sequence" | "cut.edit.picture_track" | "cut.edit.audio_track";
  type ParallaxParent = "cut.visual.parallax_camera" | "cut.visual.depth_layer" | "cut.geo.map_camera" | "cut.visual.camera3d" | "cut.visual.plane3d" | "cut.visual.callout_layer" | "cut.visual.callout";
  type ResponsiveParent = "cut.visual.responsive_stack" | "cut.visual.responsive_slot";
  type DiagramParent = "layout-body" | "node-subtree";
  const audioRegionInsertKernels = new Set([
    "cut.audio.gain",
    "cut.audio.pan",
    "cut.audio.eq",
    "cut.audio.highpass",
    "cut.audio.lowpass",
    "cut.audio.compressor",
    "cut.audio.deesser",
    "cut.audio.time_stretch",
  ]);
  const checkStatements = (statements: Statement[], parent: Scope, componentOutput?: SemanticType, reuseScope = false, editorialParent?: EditorialParent, inAudioRegion = false, parallaxParent?: ParallaxParent, responsiveParent?: ResponsiveParent, diagramParent?: DiagramParent, authoringRoot?: "scene" | "timeline", responsiveAnnotatedComponent = false) => {
    const scope = reuseScope ? parent : new Scope(parent);
    for (const statement of statements) {
      if (editorialParent && statement.kind !== "node") {
        const parentName = editorialParent === "cut.edit.sequence" ? "Sequence" : editorialParent === "cut.edit.picture_track" ? "PictureTrack" : "AudioTrack";
        const hint = editorialParent === "cut.edit.sequence"
          ? "Place PictureTrack nodes directly inside Sequence."
          : editorialParent === "cut.edit.picture_track"
            ? "Place PictureClip or Gap nodes directly inside PictureTrack; use explicit items rather than at/let/control-flow blocks."
            : "Place AudioClip or AudioGap nodes directly inside AudioTrack with explicit destination ranges.";
        diagnostic("CUT2070", `${parentName} accepts direct editorial node items only.`, statement.span, hint);
      }
      if (parallaxParent === "cut.visual.parallax_camera" && statement.kind !== "node") {
        diagnostic("CUT_PARALLAX_GRAPH", "ParallaxCamera accepts direct DepthLayer node statements only.", statement.span, "Move camera animation beside the bound ParallaxCamera; keep only DepthLayer nodes inside its body.");
      }
      if (parallaxParent === "cut.visual.camera3d" && statement.kind !== "node" && !isLocalExecutableMutationStatement(statement, scope)) {
        diagnostic("CUT_CAMERA3D_GRAPH", "Camera3D accepts direct Plane3D nodes plus set/animate statements targeting a Plane3D bound earlier in the same body.", statement.span, "Keep camera automation beside the bound Camera3D; plane automation must target a direct lexical Plane3D binding.");
      }
      if (parallaxParent === "cut.visual.plane3d" && statement.kind !== "node") {
        diagnostic("CUT_CAMERA3D_GRAPH", "Plane3D accepts exactly one direct LocalSpace node and no direct control flow or automation.", statement.span, "Bind Plane3D in its Camera3D body and automate that binding after the complete Plane3D block.");
      }
      if (parallaxParent === "cut.geo.map_camera" && statement.kind !== "node" && !isLocalExecutableMutationStatement(statement, scope)) {
        diagnostic("CUT_MAP_CAMERA_GRAPH", "MapCamera accepts direct retained geographic nodes plus set/animate statements targeting a child bound earlier in the same body.", statement.span, "Keep camera animation beside the bound MapCamera; child automation must target a lexical binding declared directly inside this MapCamera.");
      }
      if (parallaxParent === "cut.visual.callout_layer" && statement.kind !== "node" && !isDirectCalloutOpacityAnimation(statement, scope)) {
        diagnostic("CUT_CALLOUT_GRAPH", "CalloutLayer accepts direct Callout nodes plus animate statements targeting a direct lexical Callout binding's opacity.", statement.span, "Bind a direct Callout with “as name”, then animate name.opacity after its complete block.");
      }
      if (parallaxParent === "cut.visual.callout" && statement.kind !== "node") {
        diagnostic("CUT_CALLOUT_GRAPH", "Callout accepts exactly one direct LocalSpace node and no direct bindings, control flow, set, or animation.", statement.span);
      }
      if (responsiveParent && statement.kind !== "node") {
        const cameraMutation = responsiveParent === "cut.visual.responsive_slot"
          && isDirectResponsiveMediaCameraMutation(statement, scope);
        if (!cameraMutation) {
          diagnostic(
            "CUT_RESPONSIVE_STACK_GRAPH",
            responsiveParent === "cut.visual.responsive_stack"
              ? "ResponsiveStack accepts direct ResponsiveSlot node statements only."
              : "ResponsiveSlot accepts one direct visual node; only set/animate statements targeting that direct MediaCamera2D binding's camera controls may follow it.",
            statement.span,
          );
        }
      }
      if (diagramParent === "layout-body" && statement.kind !== "node") {
        diagnostic("CUT_DIAGRAM_BOUNDS", "DiagramLayout accepts 1 through 64 direct DiagramNode statements only; control flow, local values, and direct automation are not layout children.", statement.span);
      }
      if (statement.kind === "let") {
        const value = checkExpression(statement.value, scope); const annotated = statement.type ? typeReference(statement.type, diagnostics) : value;
        if (statement.type && !acceptsType(annotated, value)) diagnostic("CUT2030", `Binding “${statement.name}” expects ${displayType(annotated)}, found ${displayType(value)}.`, statement.value.span);
        if (responsiveAnnotatedComponent && isNodeType(value)) {
          diagnostic(
            "CUT_RESPONSIVE_STACK_GRAPH",
            "A responsive annotated component may use preparatory let bindings only for compile-time values; a let-bound Visual/Audio/AV node would be outside its exact executable fragment graph.",
            statement.span,
            "Author rendering nodes in the ResponsiveStack, anchored Path, or CalloutLayer structure instead.",
          );
        }
        const valueCallee = statement.value.kind === "call" ? expressionTypes.get(statement.value.callee) : undefined;
        const kernel = isNodeType(value) && valueCallee?.kind === "callable" ? valueCallee.native ?? "cut.kernel.fragment" : undefined;
        if (kernel === "cut.audio.send" && statement.value.kind === "call") {
          const sourceIndex = valueCallee?.kind === "callable" ? valueCallee.parameters.findIndex((parameter) => parameter.name === "source") : -1;
          const hasSource = statement.value.named.some((argument) => argument.name === "source") || (sourceIndex >= 0 && statement.value.positional.length > sourceIndex);
          if (!hasSource) diagnostic("CUT_AUDIO_SEND_SHAPE", "A detached let-bound Send requires source: AudioNode; child-form Sends must be authored as node statements with an audio child block.", statement.value.span);
        }
        if (kernel === cutMediaCamera2DOp) {
          diagnostic("CUT_MEDIA_CAMERA_SCOPE", "MediaCamera2D must be authored as one direct scene-root node or the sole direct ResponsiveSlot child with its media branch; it cannot be detached through let.", statement.span);
        }
        if (kernel === "cut.visual.callout_layer" || kernel === "cut.visual.callout") {
          diagnostic("CUT_CALLOUT_GRAPH", `${kernel === "cut.visual.callout_layer" ? "CalloutLayer" : "Callout"} must be authored in its closed structural node position and cannot be detached through let.`, statement.span);
        }
        if (statement.name === "self") diagnostic("CUT2062", "“self” is reserved for the implicit Visual component fragment and cannot be used as a local binding.", statement.span);
        else if (!scope.define({ name: statement.name, type: annotated, writable: false, kernel })) diagnostic("CUT2031", `Duplicate binding “${statement.name}”.`, statement.span);
      } else if (statement.kind === "node") {
        const result = checkExpression(
          statement.expression,
          scope,
          false,
          "read",
          true,
          editorialParent === "cut.edit.audio_track",
          editorialParent === "cut.edit.picture_track",
        ); const callee = expressionTypes.get(statement.expression.callee);
        const native = callee?.kind === "callable" ? callee.native : undefined;
        const authoredCallee = unwrapStaticGroup(statement.expression.callee);
        const responsiveAnnotatedInvocation = authoredCallee.kind === "identifier"
          && (responsiveAnnotatedComponents.has(authoredCallee.name)
            || userImports.get(authoredCallee.name)?.symbol.responsiveAnnotatedComponent === true);
        const isAnnotationStatement = Boolean(native && annotationAuthoringNatives.has(native));
        const isLinkedEditStatement = Boolean(native && linkedEditAuthoringNatives.has(native));
        const isTimelineEditStatement = Boolean(native && timelineEditAuthoringNatives.has(native));
        const isSemanticMatchStatement = Boolean(native && semanticMatchAuthoringNatives.has(native));
        const linkedEditContract = linkedEditStatementContract(native, callee?.kind === "callable" ? callee.name : "Linked edit");
        const isNonRenderingStatement = isAnnotationStatement || isLinkedEditStatement || isTimelineEditStatement || isSemanticMatchStatement;
        const hasArgument = (name: string) => {
          if (statement.expression.named.some((argument) => argument.name === name)) return true;
          const index = callee?.kind === "callable" ? callee.parameters.findIndex((parameter) => parameter.name === name) : -1;
          return index >= 0 && statement.expression.positional.length > index;
        };
        const isDiagramNodeResult = result.kind === "nominal" && result.name === "DiagramNode";
        if (diagramParent === "layout-body" && native !== "cut.diagram.node" && !isDiagramNodeResult) {
          diagnostic("CUT_DIAGRAM_BOUNDS", "DiagramLayout accepts DiagramNode as its only direct child type.", statement.span);
        }
        if (isDiagramNodeResult && native !== "cut.diagram.node" && statement.body.length) {
          diagnostic("CUT_DIAGRAM_BOUNDS", "A DiagramNode-returning component is structurally closed and cannot accept invocation children.", statement.span);
        }
        if (native === "cut.diagram.node" && diagramParent !== "layout-body") {
          diagnostic("CUT_DIAGRAM_BOUNDS", "DiagramNode is valid only as a direct DiagramLayout child.", statement.span);
        }
        if (native === "cut.diagram.layout" && diagramParent !== undefined) {
          diagnostic("CUT_DIAGRAM_BOUNDS", "DiagramLayout cannot be nested inside DiagramLayout or a DiagramNode visual subtree in v1.", statement.span);
        }
        if (editorialParent === "cut.edit.sequence" && native !== "cut.edit.picture_track") diagnostic("CUT2071", "Sequence accepts PictureTrack children only; audio, AV, and ordinary visual nodes are not tracks.", statement.span, "Wrap picture-only PictureClip and Gap items in PictureTrack().");
        if (editorialParent === "cut.edit.picture_track" && native !== "cut.edit.picture_clip" && native !== "cut.edit.transcript_picture" && native !== "cut.visual.precomp" && native !== "cut.edit.gap") diagnostic("CUT2071", "PictureTrack accepts PictureClip, TranscriptPicture, Precomp, or Gap items only; audio, AV, and other visual nodes are not picture-track items.", statement.span);
        if (editorialParent === "cut.edit.audio_track" && native !== "cut.audio.clip" && native !== "cut.edit.transcript_audio" && native !== "cut.edit.audio_region" && native !== "cut.edit.audio_gap") diagnostic("CUT2071", "AudioTrack accepts AudioClip, TranscriptAudio, AudioRegion, or AudioGap items only; processors, AV nodes, and ordinary audio nodes are not direct track items.", statement.span);
        if (parallaxParent === "cut.visual.parallax_camera" && native !== "cut.visual.depth_layer") diagnostic("CUT_PARALLAX_GRAPH", "ParallaxCamera accepts DepthLayer direct children only.", statement.span);
        if (parallaxParent === "cut.visual.camera3d" && native !== "cut.visual.plane3d") diagnostic("CUT_CAMERA3D_GRAPH", "Camera3D accepts Plane3D direct children only.", statement.span);
        if (parallaxParent === "cut.visual.plane3d" && native !== "cut.visual.local_space") diagnostic("CUT_CAMERA3D_GRAPH", "Plane3D accepts one direct LocalSpace child only.", statement.span);
        if (parallaxParent === "cut.visual.callout_layer" && native !== "cut.visual.callout") diagnostic("CUT_CALLOUT_GRAPH", "CalloutLayer accepts Callout as its only direct visual child type.", statement.span);
        if (parallaxParent === "cut.visual.callout" && native !== "cut.visual.local_space") diagnostic("CUT_CALLOUT_GRAPH", "Callout accepts one direct LocalSpace child only.", statement.span);
        if (responsiveParent === "cut.visual.responsive_stack" && native !== "cut.visual.responsive_slot") {
          diagnostic("CUT_RESPONSIVE_STACK_GRAPH", "ResponsiveStack accepts ResponsiveSlot direct children only; source order is the retained slot assignment.", statement.span);
        }
        if (native === "cut.visual.responsive_slot" && responsiveParent !== "cut.visual.responsive_stack") {
          diagnostic("CUT_RESPONSIVE_STACK_GRAPH", "ResponsiveSlot is valid only as a direct ResponsiveStack child.", statement.span);
        }
        if (native === "cut.visual.responsive_stack" && responsiveParent !== undefined) {
          diagnostic("CUT_RESPONSIVE_STACK_GRAPH", "ResponsiveStack cannot be nested inside another ResponsiveStack or ResponsiveSlot in the initial public vertical.", statement.span);
        }
        if (parallaxParent === "cut.geo.map_camera") {
          const allowed = new Set(["cut.geo.map", "cut.geo.route", "cut.geo.route_subject", "cut.geo.marker", "cut.geo.wavefront", "cut.geo.annotation"]);
          if (native === "cut.geo.connections") {
            diagnostic("CUT_MAP_CAMERA_CHILD", "Connections is not executable inside public MapCamera yet: its public DataAsset contract is not the retained inline-point contract.", statement.span, "Use Route nodes now; keep Connections outside MapCamera until its data contract is versioned without reinterpretation.");
          } else if (!allowed.has(native ?? "")) {
            diagnostic("CUT_MAP_CAMERA_GRAPH", "MapCamera accepts only direct Map, Route, RouteSubject, Marker, Wavefront, or LocalSpace-backed GeoAnnotation children in this public slice.", statement.span);
          }

          const forbidden = native === "cut.geo.map"
            ? ["points", "signal", "reveal", "scale", "rotation", "font"]
            : native === "cut.geo.route"
              ? ["scale", "rotation"]
              : native === "cut.geo.marker"
                ? ["projection", "globeRotation", "globeTilt", "globeX", "globeY", "globeRadius", "label", "font", "scale", "rotation"]
                : native === "cut.geo.wavefront"
                  ? ["projection", "x", "y", "globeRotation", "globeTilt", "globeX", "globeY", "globeRadius", "scale", "rotation"]
                  : [];
          for (const name of forbidden) if (hasArgument(name)) {
            const authored = statement.expression.named.find((argument) => argument.name === name);
            diagnostic("CUT_MAP_CAMERA_CHILD", `${callee?.kind === "callable" ? callee.name : "Geographic child"} argument “${name}” is not executed by MapCamera's retained final-space stream.`, authored?.span ?? statement.expression.span, "Remove the redundant selector/transform or author the node outside MapCamera.");
          }
          if (native === "cut.geo.map" && !hasArgument("detail")) {
            diagnostic("CUT_MAP_CAMERA_CHILD", "Map inside MapCamera requires an explicit retained atlas detail.", statement.expression.span, "Supply detail: \"110m\", \"50m\", or \"10m\".");
          }
        }
        if (native === "cut.visual.depth_layer" && parallaxParent !== "cut.visual.parallax_camera") diagnostic("CUT_PARALLAX_GRAPH", "DepthLayer is valid only as a direct ParallaxCamera child.", statement.span);
        if (native === "cut.visual.camera3d" && (componentOutput !== undefined || parallaxParent !== undefined)) diagnostic("CUT_CAMERA3D_GRAPH", "Camera3D is valid only as a direct scene-root visual in V1.", statement.span, "Place Camera3D directly in the scene; ordinary graphics remain separate scene-root visuals.");
        if (native === "cut.visual.plane3d" && parallaxParent !== "cut.visual.camera3d") diagnostic("CUT_CAMERA3D_GRAPH", "Plane3D is valid only as a direct Camera3D child.", statement.span);
        if (native === "cut.geo.map_camera" && (componentOutput !== undefined || parallaxParent !== undefined)) diagnostic("CUT_MAP_CAMERA_GRAPH", "MapCamera is valid only as an untransformed scene-root visual in this public slice.", statement.span, "Place MapCamera directly in the scene; compose ordinary graphics as separate scene-root visuals.");
        if (native === cutMediaCamera2DOp
          && authoringRoot !== "scene"
          && responsiveParent !== "cut.visual.responsive_slot") {
          diagnostic(
            "CUT_MEDIA_CAMERA_SCOPE",
            "MediaCamera2D is valid only as a direct scene-root visual or the sole direct child of ResponsiveSlot, spanning the complete scene.",
            statement.span,
            "Place the camera directly in the scene, or directly inside one ResponsiveSlot whose ResponsiveStack supplies its typed raster context.",
          );
        }
        if (native === "cut.visual.callout_layer"
          && authoringRoot !== "scene"
          && !responsiveAnnotatedComponent) {
          diagnostic("CUT_CALLOUT_GRAPH", "CalloutLayer is valid only as a direct scene-root visual spanning the scene.", statement.span, "Place CalloutLayer directly in the scene; Callout is valid only in that layer's body.");
        }
        if (responsiveAnnotatedInvocation) {
          if (authoringRoot !== "scene") {
            diagnostic(
              "CUT_RESPONSIVE_STACK_CONTEXT",
              "A responsive annotated component is valid only as one direct complete-interval scene-root invocation.",
              statement.span,
              "Invoke the component directly in the scene body, outside at/control-flow/node/component/precomp scopes.",
            );
          }
          if (statement.body.length > 0) {
            diagnostic(
              "CUT_RESPONSIVE_STACK_GRAPH",
              "A responsive annotated component invocation is structurally closed and cannot accept invocation children.",
              statement.span,
            );
          }
          if (statement.binding) {
            diagnostic(
              "CUT_RESPONSIVE_STACK_GRAPH",
              "A responsive annotated component invocation cannot use “as”; its identity fragment cannot be transformed or automated.",
              statement.span,
            );
          }
        }
        if (native === "cut.visual.callout" && parallaxParent !== "cut.visual.callout_layer") {
          diagnostic("CUT_CALLOUT_GRAPH", "Callout is valid only as a direct CalloutLayer child.", statement.span);
        }
        if (native === "cut.geo.annotation" && parallaxParent !== "cut.visual.depth_layer" && parallaxParent !== "cut.geo.map_camera") diagnostic("CUT_GEO_ANNOTATION_GRAPH", "GeoAnnotation is valid only as a direct DepthLayer child under ParallaxCamera or a direct MapCamera child.", statement.span);
        if (native === "cut.geo.annotation" && (statement.body.length !== 1 || statement.body[0]?.kind !== "node")) diagnostic("CUT_GEO_ANNOTATION_GRAPH", "GeoAnnotation requires exactly one direct visual child statement and no direct control-flow or automation statements.", statement.span);
        if (native === "cut.visual.local_space") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          if (directNodes.length < 1 || directNodes.length > 256) {
            diagnostic("CUT_LOCAL_SPACE_GRAPH", "LocalSpace requires 1 through 256 direct visual child nodes.", statement.span);
          }
        }
        if (native === "cut.visual.callout_layer") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          if (directNodes.length < 1 || directNodes.length > 64) {
            diagnostic("CUT_CALLOUT_LIMIT", "CalloutLayer requires 1 through 64 direct Callout nodes.", statement.span);
          }
        }
        if (native === "cut.visual.callout"
          && (statement.body.length !== 1 || statement.body[0]?.kind !== "node")) {
          diagnostic("CUT_CALLOUT_GRAPH", "Callout requires exactly one direct LocalSpace node and no other direct statements.", statement.span);
        }
        if (native === "cut.visual.responsive_stack") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          if (statement.body.length !== directNodes.length || directNodes.length < 1 || directNodes.length > 64) {
            diagnostic("CUT_RESPONSIVE_STACK_GRAPH", "ResponsiveStack requires 1 through 64 direct ResponsiveSlot node statements and no direct control flow or automation.", statement.span);
          }
        }
        if (native === "cut.visual.responsive_slot") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          if (directNodes.length !== 1) {
            diagnostic("CUT_RESPONSIVE_STACK_GRAPH", "ResponsiveSlot requires exactly one direct visual node statement.", statement.span);
          }
          if (statement.binding) diagnostic("CUT_RESPONSIVE_STACK_GRAPH", "ResponsiveSlot cannot use “as”; bind and animate nodes inside its single visual child instead.", statement.span);
        }
        if (native === "cut.diagram.layout") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          if (statement.body.length !== directNodes.length || directNodes.length < 1 || directNodes.length > 64) {
            diagnostic("CUT_DIAGRAM_LIMIT", "DiagramLayout requires 1 through 64 direct DiagramNode statements and no direct control flow, local values, or automation.", statement.span);
          }
        }
        if (native === "cut.diagram.node") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          if (directNodes.length < 1 || directNodes.length > 256) {
            diagnostic("CUT_DIAGRAM_BOUNDS", "DiagramNode requires 1 through 256 direct visual child nodes; ordinary child-local automation remains allowed.", statement.span);
          }
        }
        if ((native === "cut.edit.picture_clip" || native === "cut.edit.gap") && editorialParent !== "cut.edit.picture_track") diagnostic("CUT2072", `${native === "cut.edit.picture_clip" ? "PictureClip" : "Gap"} is valid only as a direct PictureTrack item.`, statement.span);
        if (native === "cut.edit.audio_gap" && editorialParent !== "cut.edit.audio_track") diagnostic("CUT2072", "AudioGap is valid only as a direct AudioTrack item.", statement.span);
        if (native === "cut.edit.audio_region" && editorialParent !== "cut.edit.audio_track") diagnostic("CUT_AUDIO_REGION_SCOPE", "AudioRegion is valid only as a direct AudioTrack item.", statement.span);
        if (native === "cut.edit.audio_region" && statement.body.filter((item) => item.kind === "node").length !== 1) diagnostic("CUT_AUDIO_REGION_SHAPE", "AudioRegion requires exactly one direct audio processor/source root; non-rendering automation statements may accompany it.", statement.span);
        if (inAudioRegion && native !== "cut.audio.clip" && !audioRegionInsertKernels.has(native ?? "")) {
          diagnostic("CUT_AUDIO_REGION_UNSUPPORTED", "AudioRegion currently accepts only a boundary-contained unary Gain/Pan/ParametricEQ/HighPass/LowPass/Compressor/DeEsser chain with at most one TimeStretch, ending in one AudioClip.", statement.span);
        }
        if (inAudioRegion && audioRegionInsertKernels.has(native ?? "") && statement.body.filter((item) => item.kind === "node").length !== 1) {
          diagnostic("CUT_AUDIO_REGION_SHAPE", "Every AudioRegion insert must have exactly one direct audio child so the region has one unambiguous source path.", statement.span);
        }
        if (inAudioRegion && native === "cut.audio.clip" && !hasArgument("range")) diagnostic("CUT_AUDIO_REGION_SHAPE", "AudioRegion's AudioClip leaf requires an explicit half-open range: argument.", statement.span);
        if (inAudioRegion && native === "cut.audio.clip" && ["destination", "link", "headHandle", "tailHandle", "editId", "role", "metadata"].some(hasArgument)) {
          diagnostic("CUT_AUDIO_REGION_SHAPE", "AudioRegion owns destination/link/editId/role/metadata and processed-transition handles; its nested AudioClip may author only source, range, fadeIn, and fadeOut.", statement.span);
        }
        if (native === "cut.audio.clip" && editorialParent === "cut.edit.audio_track" && (!hasArgument("range") || !hasArgument("destination"))) diagnostic("CUT2079", "AudioClip inside AudioTrack requires explicit half-open range: and destination: arguments.", statement.span, "Author independent source and destination ranges with equal durations; CUT does not infer time stretch or a hidden gap.");
        if (!inAudioRegion && native === "cut.audio.clip" && editorialParent !== "cut.edit.audio_track" && ["destination", "link", "headHandle", "tailHandle", "editId", "role", "metadata"].some(hasArgument)) diagnostic("CUT2072", "AudioClip destination:, link:, headHandle:, tailHandle:, editId:, role:, and metadata: are valid only for a direct AudioTrack item; ordinary AudioClip placement remains controlled by its owning interval.", statement.span);
        if (native === "cut.audio.send") {
          const hasSource = hasArgument("source");
          if (hasSource) diagnostic("CUT_AUDIO_SEND_SHAPE", "Send(source:) is a detached auxiliary tap and must be introduced with let, not rendered as a structural/root node statement.", statement.expression.span, "Bind the program Bus, then write let roomSend = Send(amount: ..., source: programBus);.");
          else if (statement.body.length === 0) diagnostic("CUT2085", "cut.audio.send requires at least one audio child; use source: on a detached let-bound Send to tap an existing program Bus.", statement.expression.span);
        }
        if ((native === "cut.edit.sequence" || native === "cut.edit.picture_track" || native === "cut.edit.audio_track") && statement.body.length === 0) diagnostic("CUT2073", `${native === "cut.edit.sequence" ? "Sequence" : native === "cut.edit.picture_track" ? "PictureTrack" : "AudioTrack"} requires at least one direct child.`, statement.span);
        if (!isNodeType(result) && !isNonRenderingStatement) diagnostic("CUT2032", `A node statement must return Visual, AudioNode, or AVNode; found ${displayType(result)}.`, statement.expression.span);
        if (isAnnotationStatement && componentOutput) diagnostic("CUT_ANNOTATION_CONTEXT", `${callee?.kind === "callable" ? callee.name : "Annotation"} is valid only in a timeline or scene statement block, not inside a component or render-node body.`, statement.span);
        if (isAnnotationStatement && statement.body.length) diagnostic("CUT_ANNOTATION_CONTEXT", `${callee?.kind === "callable" ? callee.name : "Annotation"} does not accept a child block.`, statement.span);
        if (isAnnotationStatement && statement.binding) diagnostic("CUT_ANNOTATION_CONTEXT", `${callee?.kind === "callable" ? callee.name : "Annotation"} cannot use “as”; query it later by authored id.`, statement.span);
        if (isLinkedEditStatement && componentOutput) diagnostic(linkedEditContract.code, `${linkedEditContract.name} is valid only as a direct scene statement, not inside a component, track, or render-node body.`, statement.span);
        if (isLinkedEditStatement && statement.body.length) diagnostic(linkedEditContract.code, `${linkedEditContract.name} does not accept a child block.`, statement.span);
        if (isLinkedEditStatement && statement.binding) diagnostic(linkedEditContract.code, `${linkedEditContract.name} cannot use “as”; its typed transaction is recorded in CutAVIR.`, statement.span);
        if (isTimelineEditStatement && authoringRoot !== "scene") diagnostic("CUT_TIMELINE_EDIT_SCOPE", "TimelineEdit is valid only as a direct scene statement, not at timeline scope or inside a component, track, control-flow, or render-node body.", statement.span);
        if (isTimelineEditStatement && statement.body.length) diagnostic("CUT_TIMELINE_EDIT_SCOPE", "TimelineEdit does not accept a child block.", statement.span);
        if (isTimelineEditStatement && statement.binding) diagnostic("CUT_TIMELINE_EDIT_SCOPE", "TimelineEdit cannot use “as”; its canonical transaction is recorded in typed CutAVIR.", statement.span);
        if (native === "cut.edit.match_subject" && authoringRoot !== "scene") diagnostic("CUT_MATCH_SCOPE", "MatchSubject is valid only as a direct scene statement after its bound scene-root Camera2D.", statement.span);
        if (native === "cut.edit.match_transition" && authoringRoot !== "timeline") diagnostic("CUT_MATCH_SCOPE", "MatchTransition is valid only as a direct timeline statement, outside every scene and render-node body.", statement.span);
        if (isSemanticMatchStatement && statement.body.length) diagnostic("CUT_MATCH_SCOPE", `${callee?.kind === "callable" ? callee.name : "Semantic match declaration"} does not accept a child block.`, statement.span);
        if (isSemanticMatchStatement && statement.binding) diagnostic("CUT_MATCH_SCOPE", `${callee?.kind === "callable" ? callee.name : "Semantic match declaration"} cannot use “as”; it is recorded as typed non-rendering CutAVIR.`, statement.span);
        if (componentOutput && isNodeType(result) && !acceptsType(componentOutput, result)) diagnostic("CUT2033", `Component output ${displayType(result)} is incompatible with ${displayType(componentOutput)}.`, statement.span);
        if (statement.body.length) {
          const kernel = callee?.kind === "callable" && callee.native ? referenceKernelSchema(callee.native) : undefined;
          const childMode = kernel?.support === "supported" ? kernel.children : callee?.kind === "callable" ? callee.children : "none";
          if (!childMode || childMode === "none") diagnostic("CUT2034", `${callee?.kind === "callable" ? callee.name : "This component"} does not accept child nodes.`, statement.span);
          const childEditorialParent = native === "cut.edit.sequence" || native === "cut.edit.picture_track" || native === "cut.edit.audio_track" ? native : undefined;
          const childParallaxParent = native === "cut.visual.parallax_camera" || native === "cut.visual.depth_layer" || native === "cut.geo.map_camera" || native === "cut.visual.camera3d" || native === "cut.visual.plane3d" || native === "cut.visual.callout_layer" || native === "cut.visual.callout" ? native : undefined;
          const childResponsiveParent = native === "cut.visual.responsive_stack" || native === "cut.visual.responsive_slot" ? native : undefined;
          const childDiagramParent: DiagramParent | undefined = native === "cut.diagram.layout"
            ? "layout-body"
            : native === "cut.diagram.node" || diagramParent === "node-subtree"
              ? "node-subtree"
              : undefined;
          checkStatements(statement.body, scope, childMode === "visual" ? nominal("Visual") : childMode === "audio" ? nominal("AudioNode") : nominal("AVNode"), false, childEditorialParent, inAudioRegion || native === "cut.edit.audio_region", childParallaxParent, childResponsiveParent, childDiagramParent);
        }
        if (native === "cut.visual.callout_layer") {
          const animatedBindings = new Set(statement.body.flatMap((item) =>
            item.kind === "animate"
              && item.target.kind === "member"
              && item.target.property === "opacity"
              && item.target.object.kind === "identifier"
              ? [item.target.object.name]
              : []));
          for (const item of statement.body) {
            if (item.kind !== "node") continue;
            const itemCallee = expressionTypes.get(item.expression.callee);
            if (itemCallee?.kind !== "callable" || itemCallee.native !== "cut.visual.callout") continue;
            const opacity = staticCallArgument(item.expression, itemCallee.parameters.map((parameter) => parameter.name), "opacity");
            if (opacity.state !== "value") continue;
            const value = staticPercentRatio(opacity.value);
            if (value === undefined
              || (compareRational(value, rational(0)) !== 0 && compareRational(value, rational(1)) !== 0)
              || (item.binding !== undefined && animatedBindings.has(item.binding))) continue;
            diagnostic(
              "CUT_CALLOUT_NOOP",
              compareRational(value, rational(0)) === 0
                ? "Callout opacity: 0% is permanently hidden without direct opacity animation."
                : "Callout opacity: 100% repeats the public default without direct opacity animation.",
              opacity.span,
              "Omit opacity: 100%, or bind this direct Callout and animate its opacity in the same CalloutLayer body.",
            );
          }
        }
        if (native === cutMediaCamera2DOp) {
          const direct = statement.body.length === 1 && statement.body[0]?.kind === "node" ? statement.body[0] : undefined;
          const callable = (candidate: Extract<Statement, { kind: "node" }>) => expressionTypes.get(candidate.expression.callee);
          const childNative = (candidate: Extract<Statement, { kind: "node" }>) => {
            const resolved = callable(candidate);
            return resolved?.kind === "callable" ? resolved.native : undefined;
          };
          const authoredArguments = (candidate: Extract<Statement, { kind: "node" }>) => {
            const resolved = callable(candidate);
            const positional = candidate.expression.positional.map((_, index) => resolved?.kind === "callable" ? resolved.parameters[index]?.name : undefined);
            return new Set([...positional.filter((name): name is string => Boolean(name)), ...candidate.expression.named.map((argument) => argument.name)]);
          };
          const validateLeaf = (leaf: Extract<Statement, { kind: "node" }>) => {
            const leafNative = childNative(leaf);
            if (leafNative !== "cut.visual.image" && leafNative !== "cut.visual.video") {
              diagnostic("CUT_MEDIA_CAMERA_GRAPH", "MediaCamera2D must terminate in exactly one direct Image or Video leaf.", leaf.span);
              return;
            }
            if (leaf.body.length) diagnostic("CUT_MEDIA_CAMERA_GRAPH", "The MediaCamera2D Image/Video leaf must be childless.", leaf.span);
            const spatial = ["x", "y", "scale", "rotation", "opacity"].find((name) => authoredArguments(leaf).has(name));
            if (spatial) {
              const authored = leaf.expression.named.find((argument) => argument.name === spatial);
              diagnostic("CUT_MEDIA_CAMERA_GRAPH", `Image/Video argument “${spatial}” cannot execute inside MediaCamera2D; the camera owns the only sampling transform.`, authored?.span ?? leaf.expression.span);
            }
          };
          if (!direct) {
            diagnostic("CUT_MEDIA_CAMERA_GRAPH", "MediaCamera2D requires exactly one direct Image/Video branch and no sibling, binding, control-flow, or direct automation statements.", statement.span);
          } else {
            const nativeEffects = new Set<string>(cutMediaCamera2DNativeEffectOps);
            let branch: Extract<Statement, { kind: "node" }> | undefined = direct;
            let depth = 0, colorGrades = 0;
            while (branch) {
              const branchNative = childNative(branch);
              if (branchNative === "cut.visual.image" || branchNative === "cut.visual.video") {
                validateLeaf(branch);
                break;
              }
              if (!branchNative || !nativeEffects.has(branchNative)) {
                diagnostic(
                  "CUT_MEDIA_CAMERA_GRAPH",
                  "MediaCamera2D admits only ColorGrade, Blur, Sharpen, Vignette, static Grain, and Duotone wrappers before exactly one Image/Video leaf.",
                  branch.span,
                );
                break;
              }
              depth += 1;
              if (depth > cutMediaCamera2DMaximumNativeEffectDepth) {
                diagnostic(
                  "CUT_MEDIA_CAMERA_GRAPH",
                  `MediaCamera2D native-crop effect depth exceeds ${cutMediaCamera2DMaximumNativeEffectDepth}.`,
                  branch.span,
                );
                break;
              }
              if (branchNative === "cut.visual.color_grade") {
                colorGrades += 1;
                if (colorGrades > 1) {
                  diagnostic("CUT_MEDIA_CAMERA_GRAPH", "MediaCamera2D permits at most one ColorGrade in its native-crop effect chain.", branch.span);
                  break;
                }
                const spatial = ["x", "y", "scale", "rotation", "opacity"].find((name) => authoredArguments(branch!).has(name));
                if (spatial) {
                  const authored = branch.expression.named.find((argument) => argument.name === spatial);
                  diagnostic("CUT_MEDIA_CAMERA_GRAPH", `ColorGrade argument “${spatial}” cannot execute inside MediaCamera2D; the camera owns the only sampling transform.`, authored?.span ?? branch.expression.span);
                }
              }
              if (branchNative === "cut.visual.grain") {
                const mode = branch.expression.named.find((argument) => argument.name === "mode")?.value;
                if (mode?.kind === "string" && mode.value === "temporal") {
                  diagnostic(
                    "CUT_MEDIA_CAMERA_GRAPH",
                    "MediaCamera2D native-crop V1 accepts static Grain only; temporal output-frame phase is not admitted.",
                    mode.span,
                  );
                }
              }
              const child: Extract<Statement, { kind: "node" }> | undefined =
                branch.body.length === 1 && branch.body[0]?.kind === "node"
                ? branch.body[0]
                : undefined;
              if (!child) {
                diagnostic(
                  "CUT_MEDIA_CAMERA_GRAPH",
                  `${branchNative} must contain exactly one direct native-crop wrapper or Image/Video leaf and no sibling statements.`,
                  branch.span,
                );
                break;
              }
              branch = child;
            }
          }
        }
        if (native === "cut.visual.planar_track") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          const localChildren = directNodes.filter((item) => {
            const childCallee = expressionTypes.get(item.expression.callee);
            return childCallee?.kind === "callable" && childCallee.native === "cut.visual.local_space";
          });
          if (statement.body.length !== 1 || directNodes.length !== 1 || localChildren.length !== 1) {
            diagnostic(
              "CUT_PLANAR_TRACK_GRAPH",
              "PlanarTrack requires exactly one direct LocalSpace node and no delivery-canvas siblings, control flow, or direct automation statements.",
              statement.span,
              "Keep the complete projective source surface inside one direct LocalSpace.",
            );
          }
          const local = statement.body.length === 1 && localChildren.length === 1 ? localChildren[0] : undefined;
          if (local) {
            let planarMasks = 0;
            const visitDirectPlaneLocalNode = (candidate: Extract<Statement, { kind: "node" }>) => {
              const candidateType = expressionTypes.get(candidate.expression.callee);
              const candidateNative = candidateType?.kind === "callable" ? candidateType.native : undefined;
              if (candidateNative === "cut.visual.local_space") return;
              if (candidateNative === "cut.visual.mask") {
                planarMasks += 1;
                if (planarMasks > 1) {
                  diagnostic(
                    "CUT_PLANAR_TRACK_MATTE_LIMIT",
                    "PlanarTrack admits at most one Mask in its direct LocalSpace coordinate context.",
                    candidate.span,
                    "Combine the intended partial-occlusion coverage into one alpha matte.",
                  );
                }
                const mode = candidate.expression.named.find((argument) => argument.name === "mode")?.value
                  ?? candidate.expression.positional[0];
                if (mode?.kind === "string" && mode.value !== "alpha") {
                  diagnostic(
                    "CUT_PLANAR_TRACK_MATTE_MODE",
                    `PlanarTrack partial occlusion accepts alpha Mask only; found ${JSON.stringify(mode.value)}.`,
                    mode.span,
                    "Author alpha coverage in the plane-local matte child.",
                  );
                }
              }
              for (const child of candidate.body) if (child.kind === "node") visitDirectPlaneLocalNode(child);
            };
            for (const child of local.body) if (child.kind === "node") visitDirectPlaneLocalNode(child);
          }
        }
        if (native === "cut.visual.camera3d") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          if (directNodes.length < 2 || directNodes.length > 16) {
            diagnostic("CUT_CAMERA3D_GRAPH", "Camera3D requires 2 through 16 direct Plane3D node statements.", statement.span);
          }
        }
        if (native === "cut.visual.plane3d") {
          const directNodes = statement.body.filter((item) => item.kind === "node");
          const localChildren = directNodes.filter((item) => {
            const childCallee = expressionTypes.get(item.expression.callee);
            return childCallee?.kind === "callable" && childCallee.native === "cut.visual.local_space";
          });
          if (statement.body.length !== 1 || directNodes.length !== 1 || localChildren.length !== 1) {
            diagnostic(
              "CUT_CAMERA3D_GRAPH",
              "Plane3D requires exactly one direct LocalSpace node and no delivery-canvas siblings, control flow, or direct automation statements.",
              statement.span,
              "Keep the complete projective rectangle inside one direct LocalSpace; animate the bound Plane3D from its Camera3D body.",
            );
          }
        }
        if (native === "cut.visual.motion_blur") {
          const cameraChild = statement.body.find((item) => {
            if (item.kind !== "node") return false;
            const childCallee = expressionTypes.get(item.expression.callee);
            return childCallee?.kind === "callable" && childCallee.native === "cut.visual.camera3d";
          });
          if (cameraChild) diagnostic("CUT_CAMERA3D_MOTION_BLUR_UNSUPPORTED", "Outer MotionBlur over Camera3D is not supported in planar-3D V1; shutter-time projective work and evidence remain open.", cameraChild.span, "Use exact-time Camera3D and Plane3D automation without MotionBlur.");
        }
        if ((native === "cut.visual.track_2d" || native === "cut.visual.depth_layer") && statement.body.length) {
          // Resolve aliases through the checked symbol table. A LocalSpace
          // owner selects one coordinate basis for the entire direct child
          // surface; mixing it with delivery-canvas siblings or direct control
          // statements would make placement ambiguous before the renderer.
          const directNodes = statement.body.filter((item) => item.kind === "node");
          const localChildren = directNodes.filter((item) => {
            const childCallee = expressionTypes.get(item.expression.callee);
            return childCallee?.kind === "callable" && childCallee.native === "cut.visual.local_space";
          });
          if (localChildren.length > 0 && (statement.body.length !== 1 || directNodes.length !== 1 || localChildren.length !== 1)) {
            diagnostic(
              "CUT_LOCAL_SPACE_GRAPH",
              `${native === "cut.visual.track_2d" ? "Track2D" : "DepthLayer"} using a local coordinate basis must contain exactly one direct LocalSpace node and no delivery-canvas siblings or direct control statements.`,
              statement.span,
              "Keep every bounded child inside that LocalSpace, or remove LocalSpace and use the legacy delivery-canvas child form.",
            );
          }
        }
        if (native === "cut.visual.camera2d" && statement.body.length) {
          // Camera2D retains its historical delivery-canvas compositor for
          // ordinary children. Opting into bounded local composition is an
          // explicit, unambiguous branch: exactly one direct LocalSpace.
          const directNodes = statement.body.filter((item) => item.kind === "node");
          const localChildren = directNodes.filter((item) => {
            const childCallee = expressionTypes.get(item.expression.callee);
            return childCallee?.kind === "callable" && childCallee.native === "cut.visual.local_space";
          });
          if (localChildren.length > 0 && (statement.body.length !== 1 || directNodes.length !== 1 || localChildren.length !== 1)) {
            diagnostic(
              "CUT_LOCAL_SPACE_GRAPH",
              "Camera2D using retained local composition must contain exactly one direct LocalSpace node and no delivery-canvas siblings or direct control statements.",
              statement.span,
              "Keep the complete bounded camera plane inside that LocalSpace, or remove LocalSpace to preserve legacy delivery-canvas Camera2D behavior.",
            );
          }
        }
        if (native === "cut.geo.annotation" && statement.body.length === 1 && statement.body[0]?.kind === "node") {
          // This predicate intentionally runs after checking the child block so
          // aliases/imports resolve through the same public symbol table as
          // every other component. Surface syntax alone is not trusted.
          const childCallee = expressionTypes.get(statement.body[0].expression.callee);
          const localSpaceChild = childCallee?.kind === "callable" && childCallee.native === "cut.visual.local_space";
          const width = hasArgument("width"), height = hasArgument("height");
          if (localSpaceChild && (width || height)) {
            const authored = statement.expression.named.find((argument) => argument.name === "width" || argument.name === "height");
            diagnostic(
              "CUT_GEO_ANNOTATION_VIEWPORT",
              "GeoAnnotation with a direct LocalSpace child derives its viewport from LocalSpace and forbids width and height.",
              authored?.span ?? statement.expression.span,
              "Remove width: and height: from GeoAnnotation; keep them on LocalSpace.",
            );
          } else if (!localSpaceChild && (!width || !height)) {
            diagnostic(
              "CUT_GEO_ANNOTATION_VIEWPORT",
              "Legacy GeoAnnotation with an ordinary visual child requires both width and height; only a direct LocalSpace child may omit them.",
              statement.body[0].span,
              "Supply both width: and height:, or wrap the local visual content in LocalSpace(width:, height:, origin:).",
            );
          }
        }
        if (native === "cut.geo.map") {
          const retainedOnly = ["detail", "background", "land", "border", "borderWidth", "graticule", "graticuleWidth"];
          if (parallaxParent !== "cut.geo.map_camera") for (const name of retainedOnly) if (hasArgument(name)) {
            const authored = statement.expression.named.find((argument) => argument.name === name);
            diagnostic("CUT_MAP_CAMERA_CONTEXT", `Map argument “${name}” is retained-MapCamera-only and cannot execute on the standalone raster Map path.`, authored?.span ?? statement.expression.span, "Move this Map directly inside MapCamera or remove the retained-only field.");
          }
        }
        if (native === "cut.geo.route_subject" && parallaxParent !== "cut.geo.map_camera") {
          diagnostic(
            "CUT_MAP_CAMERA_CONTEXT",
            "RouteSubject is retained-MapCamera-only and has no standalone projection semantics.",
            statement.span,
            "Place RouteSubject directly inside MapCamera.",
          );
        }
        const kernel = isNodeType(result) && callee?.kind === "callable" ? callee.native ?? "cut.kernel.fragment" : undefined;
        if (statement.binding === "self") diagnostic("CUT2062", "“self” is reserved for the implicit Visual component fragment and cannot be used as a node binding.", statement.span);
        else if (statement.binding && !isAnnotationStatement && !scope.define({ name: statement.binding, type: result, writable: true, kernel })) diagnostic("CUT2031", `Duplicate binding “${statement.binding}”.`, statement.span);
        if (native === "cut.visual.responsive_stack") {
          const escaped = responsiveStackEscapedCameraAliases(statement);
          if (escaped.length > 1) {
            for (const duplicate of escaped.slice(1)) {
              diagnostic(
                "CUT_MEDIA_CAMERA_SCOPE",
                "ResponsiveStack may expose at most one direct ResponsiveSlot MediaCamera2D alias to its enclosing lexical scope.",
                duplicate.statement.span,
                "Keep one aliased slot camera per ResponsiveStack; use another stack or leave unrelated slot cameras unaliased.",
              );
            }
          } else if (escaped.length === 1) {
            const camera = escaped[0]!;
            if (scope.lookup(camera.name)) {
              diagnostic(
                "CUT_MEDIA_CAMERA_SCOPE",
                `ResponsiveSlot MediaCamera2D alias “${camera.name}” collides with a binding already visible in the enclosing scope.`,
                camera.statement.span,
                "Choose a unique camera alias; escaped slot-camera aliases never shadow enclosing values or nodes.",
              );
            } else {
              scope.define({
                name: camera.name,
                type: camera.type,
                writable: true,
                kernel: cutMediaCamera2DOp,
              });
            }
          }
        }
      } else if (statement.kind === "set") {
        const target = checkExpression(statement.target, scope, false, "write-target"), value = checkExpression(statement.value, scope);
        if (!isExecutableMutationTarget(statement.target, scope)) diagnostic("CUT2067", "set requires a property of a bound executable node.", statement.target.span, "Bind a Visual, AudioNode, or AVNode with “as name” and set name.property.");
        if (statement.target.kind === "identifier" && statement.target.name === "self") diagnostic("CUT2060", "The Visual component fragment itself cannot be replaced; write one of self.opacity, self.x, self.y, self.scale, or self.rotation.", statement.target.span);
        const valueCallee = statement.value.kind === "call" ? expressionTypes.get(statement.value.callee) : undefined;
        const audioReactiveMap = valueCallee?.kind === "callable" && [
          "cut.data.map_number", "cut.data.map_ratio", "cut.data.map_length", "cut.data.map_angle",
        ].includes(valueCallee.native ?? "");
        if (audioReactiveMap) {
          const property = statement.target.kind === "member" ? statement.target.property : undefined;
          const root = mutationRootName(statement.target), targetBinding = root ? scope.lookup(root) : undefined;
          if (!property || !["x", "y", "scale", "rotation", "opacity"].includes(property) || targetBinding?.kernel !== "cut.visual.group") {
            diagnostic(
              "CUT_AUDIO_REACTIVE_TARGET",
              "An audio-reactive map may initially drive only Group x, y, scale, rotation, or opacity.",
              statement.target.span,
              "Wrap the intended visual in a bound Group and attach the mapped signal directly with set.",
            );
          }
          const mapped = value.kind === "nominal" && value.name === "Signal" && value.arguments.length === 1 ? value.arguments[0] : errorType;
          if (!acceptsType(target, mapped)) diagnostic("CUT_AUDIO_REACTIVE_TYPE", `Mapped signal ${displayType(value)} cannot drive target ${displayType(target)}.`, statement.value.span);
        } else if (!acceptsType(target, value)) diagnostic("CUT2035", `Cannot set ${displayType(target)} to ${displayType(value)}.`, statement.value.span);
      } else if (statement.kind === "animate") {
        const target = checkExpression(statement.target, scope, false, "write-target"), from = checkExpression(statement.from, scope), to = checkExpression(statement.to, scope), duration = checkExpression(statement.duration, scope);
        if (!isExecutableMutationTarget(statement.target, scope)) diagnostic("CUT2067", "animate requires a property of a bound executable node.", statement.target.span, "Bind a Visual, AudioNode, or AVNode with “as name” and animate name.property.");
        if (statement.target.kind === "identifier" && statement.target.name === "self") diagnostic("CUT2060", "The Visual component fragment itself cannot be animated as a value; animate one of self.opacity, self.x, self.y, self.scale, or self.rotation.", statement.target.span);
        if (!acceptsType(target, from) || !acceptsType(target, to)) diagnostic("CUT2036", `Animation values must match target ${displayType(target)}.`, statement.span);
        if (!sameType(duration, quantity("time"))) diagnostic("CUT2037", `Animation duration must be Time, found ${displayType(duration)}.`, statement.duration.span);
        if (statement.delay && !sameType(checkExpression(statement.delay, scope), quantity("time"))) diagnostic("CUT2038", "Animation delay must be Time.", statement.delay.span);
        if (statement.easing) { const easing = checkExpression(statement.easing, scope); if (!sameType(easing, nominal("Easing"))) diagnostic("CUT2039", `Animation easing must be Easing, found ${displayType(easing)}.`, statement.easing.span); }
      } else if (statement.kind === "at") {
        const time = checkExpression(statement.time, scope); if (!sameType(time, quantity("time"))) diagnostic("CUT2040", `at needs Time, found ${displayType(time)}.`, statement.time.span); checkStatements(statement.body, scope, componentOutput, false, editorialParent, inAudioRegion, parallaxParent, responsiveParent, diagramParent);
      } else if (statement.kind === "for") {
        const iterable = checkExpression(statement.iterable, scope); const child = new Scope(scope);
        if (iterable.kind !== "list") diagnostic("CUT2041", `for needs a List, found ${displayType(iterable)}.`, statement.iterable.span);
        if (statement.item === "self") diagnostic("CUT2062", "“self” is reserved for the implicit Visual component fragment and cannot be used as a loop binding.", statement.span);
        else child.define({ name: statement.item, type: iterable.kind === "list" ? iterable.element : errorType });
        checkStatements(statement.body, child, componentOutput, false, editorialParent, inAudioRegion, parallaxParent, responsiveParent, diagramParent);
      } else if (statement.kind === "if") {
        const condition = checkExpression(statement.condition, scope); if (!sameType(condition, boolType)) diagnostic("CUT2042", `if needs Bool, found ${displayType(condition)}.`, statement.condition.span);
        checkStatements(statement.consequent, scope, componentOutput, false, editorialParent, inAudioRegion, parallaxParent, responsiveParent, diagramParent); checkStatements(statement.alternate, scope, componentOutput, false, editorialParent, inAudioRegion, parallaxParent, responsiveParent, diagramParent);
      } else if (statement.kind === "assert") {
        const condition = checkExpression(statement.condition, scope); if (!sameType(condition, boolType)) diagnostic("CUT2043", `assert needs Bool, found ${displayType(condition)}.`, statement.condition.span);
      }
    }
  };

  const valueDeclarations = module.declarations.filter((item): item is Extract<Declaration, { kind: "asset" | "const" }> => item.kind === "asset" || item.kind === "const");
  const valuesByName = new Map(valueDeclarations.map((item) => [item.name, item])); const valueState = new Map<string, "visiting" | "done">(); const valueStack: string[] = [];
  const checkValueDeclaration = (declaration: Extract<Declaration, { kind: "asset" | "const" }>) => {
    if (valueState.get(declaration.name) === "done") return;
    if (valueState.get(declaration.name) === "visiting") {
      const start = valueStack.indexOf(declaration.name); diagnostic("CUT2056", `Top-level value cycle: ${[...valueStack.slice(start), declaration.name].join(" -> ")}.`, declaration.span, "Break the cycle by making at least one value independent."); return;
    }
    valueState.set(declaration.name, "visiting"); valueStack.push(declaration.name);
    for (const identifier of expressionIdentifiers(declaration.value)) { const dependency = valuesByName.get(identifier); if (dependency) checkValueDeclaration(dependency); }
      if (containsFrameLiteral(declaration.value)) diagnostic("CUT2054", `Frame literals in top-level ${declaration.kind} “${declaration.name}” are ambiguous because frame duration depends on a timeline's fps.`, declaration.value.span, "Use seconds, or move the frame expression into a timeline, scene, or component invocation where fps is known.");
      const value = checkExpression(declaration.value, global, declaration.kind === "asset"); const symbol_ = symbols.get(declaration.name)!;
      if (symbol_.type.kind === "unknown") symbol_.type = value;
      else if (!(declaration.kind === "asset" ? sameType(symbol_.type, value) : acceptsType(symbol_.type, value))) diagnostic("CUT2044", `${declaration.kind} “${declaration.name}” expects ${displayType(symbol_.type)}, found ${displayType(value)}.`, declaration.value.span);
      if (declaration.kind === "asset") {
        const callee = declaration.value.kind === "call" ? expressionTypes.get(declaration.value.callee) : undefined;
        const isDirectAssetConstructor = callee?.kind === "callable" && callee.native?.startsWith("cut.asset.");
        if (!isDirectAssetConstructor) diagnostic("CUT2045", `asset “${declaration.name}” must be created by a direct asset-constructor call.`, declaration.value.span);
      }
    valueStack.pop(); valueState.set(declaration.name, "done");
  };
  valueDeclarations.forEach(checkValueDeclaration);

  for (const declaration of module.declarations) {
    if (declaration.kind === "asset" || declaration.kind === "const") continue;
    if (declaration.kind === "function") {
      const scope = new Scope(global); const callable = symbols.get(declaration.name)?.type;
      declaration.parameters.forEach((parameter, index) => {
        const checked = callable?.kind === "callable" ? callable.parameters[index].type : errorType;
        if (!isCompileTimeValueType(checked)) diagnostic("CUT_MODULE_FUNCTION_TYPE", `Pure function parameter “${parameter.name}” must be a compile-time value type, found ${displayType(checked)}.`, parameter.type.span);
        if (parameter.defaultValue) {
          const actual = checkExpression(parameter.defaultValue, scope);
          if (!acceptsType(checked, actual)) diagnostic("CUT_MODULE_FUNCTION_DEFAULT", `Default for “${parameter.name}” expects ${displayType(checked)}, found ${displayType(actual)}.`, parameter.defaultValue.span);
        }
        if (!scope.define({ name: parameter.name, type: checked })) diagnostic("CUT_MODULE_FUNCTION_PARAMETER", `Duplicate function parameter “${parameter.name}”.`, parameter.span);
      });
      const actual = checkExpression(declaration.value, scope);
      const expected = callable?.kind === "callable" ? callable.result : errorType;
      if (!isCompileTimeValueType(expected)) diagnostic("CUT_MODULE_FUNCTION_TYPE", `Pure function “${declaration.name}” must return a compile-time value type, found ${displayType(expected)}.`, declaration.returnType.span);
      if (!acceptsType(expected, actual)) diagnostic("CUT_MODULE_FUNCTION_RETURN", `Function “${declaration.name}” promises ${displayType(expected)}, found ${displayType(actual)}.`, declaration.value.span);
      for (const call of expressionCalls(declaration.value)) {
        const called = expressionTypes.get(call.callee);
        if (called?.kind === "callable" && (called.effect !== "pure" || isNodeType(called.result))) {
          diagnostic("CUT_MODULE_FUNCTION_EFFECT", `Pure function “${declaration.name}” cannot invoke ${called.name}; expression functions may use compile-time pure value calls only.`, call.callee.span);
        }
      }
    } else if (declaration.kind === "component") {
      const scope = new Scope(global); const callable = symbols.get(declaration.name)?.type;
      declaration.parameters.forEach((parameter, index) => {
        const checked = callable?.kind === "callable" ? callable.parameters[index].type : errorType;
        if (parameter.name === "self") diagnostic("CUT2062", "“self” is reserved for the implicit Visual component fragment and cannot be used as a parameter.", parameter.span);
        else scope.define({ name: parameter.name, type: checked });
        if (parameter.defaultValue) { const actual = checkExpression(parameter.defaultValue, scope); if (!acceptsType(checked, actual)) diagnostic("CUT2046", `Default for “${parameter.name}” expects ${displayType(checked)}, found ${displayType(actual)}.`, parameter.defaultValue.span); }
      });
      if (callable?.kind === "callable" && callable.result.kind === "nominal" && callable.result.name === "Visual") scope.define({ name: "self", type: nominal("Visual"), writable: true, kernel: "cut.kernel.fragment" });
      const output = callable?.kind === "callable" ? callable.result : nominal("AVNode");
      const diagramNodeOutput = output.kind === "nominal" && output.name === "DiagramNode";
      if (diagramNodeOutput && (declaration.body.length !== 1 || declaration.body[0]?.kind !== "node")) {
        diagnostic(
          "CUT_DIAGRAM_BOUNDS",
          `DiagramNode component “${declaration.name}” must contain exactly one direct DiagramNode statement and no bindings, control flow, or automation outside that node.`,
          declaration.span,
        );
      }
      checkStatements(
        declaration.body,
        scope,
        output,
        false,
        undefined,
        false,
        undefined,
        undefined,
        diagramNodeOutput ? "layout-body" : undefined,
        undefined,
        responsiveAnnotatedComponents.has(declaration.name),
      );
    } else if (declaration.kind === "timeline") {
      checkClosedArguments(`timeline “${declaration.name}”`, declaration.arguments, ["duration", "fps", "width", "height", "sampleRate"]);
      const args = new Map(declaration.arguments.map((argument) => [argument.name, argument]));
      for (const required of ["duration", "fps"]) if (!args.has(required)) diagnostic("CUT2047", `timeline “${declaration.name}” requires ${required}:.`, declaration.span);
      for (const argument of declaration.arguments) {
        const type = checkExpression(argument.value, global);
        if (argument.name === "fps" && containsFrameLiteral(argument.value)) diagnostic("CUT2055", `timeline “${declaration.name}” cannot define fps in terms of frame literals.`, argument.value.span, "Use a scalar fps value such as 24 or 30000 / 1001.");
        if (argument.name === "duration" && !sameType(type, quantity("time"))) diagnostic("CUT2048", "timeline duration must be Time.", argument.value.span);
        else if (["fps", "width", "height"].includes(argument.name) && !sameType(type, quantity(argument.name === "fps" ? "scalar" : "length"))) diagnostic("CUT2049", `timeline ${argument.name} has the wrong dimension.`, argument.value.span);
        else if (argument.name === "sampleRate" && !sameType(type, quantity("frequency"))) diagnostic("CUT2050", "timeline sampleRate must be Frequency.", argument.value.span);
      }
      const timelineScope = new Scope(global);
      for (const item of declaration.items) {
        if (item.kind === "scene") {
          checkClosedArguments(`scene “${item.name}”`, item.arguments, ["duration", "at"]);
          const sceneArgs = new Map(item.arguments.map((argument) => [argument.name, argument]));
          if (!sceneArgs.has("duration")) diagnostic("CUT2051", `scene “${item.name}” requires duration:.`, item.span);
          for (const argument of item.arguments) { const type = checkExpression(argument.value, global); if (["duration", "at"].includes(argument.name) && !sameType(type, quantity("time"))) diagnostic("CUT2052", `scene ${argument.name} must be Time.`, argument.value.span); }
          checkStatements(item.body, timelineScope, undefined, false, undefined, false, undefined, undefined, undefined, "scene");
        } else checkStatements([item], timelineScope, undefined, true, undefined, false, undefined, undefined, undefined, "timeline");
      }
    } else if (declaration.kind === "export") {
      const type = checkExpression(declaration.value, global);
      if (moduleKind === "entry") {
        if (!sameType(type, nominal("RenderTarget"))) diagnostic("CUT2053", `export must produce RenderTarget, found ${displayType(type)}.`, declaration.value.span);
      } else {
        if (exportedSymbols.has(declaration.name)) {
          diagnostic("CUT_MODULE_DUPLICATE_EXPORT", `User module exports “${declaration.name}” more than once.`, declaration.span);
          continue;
        }
        const direct = declaration.value.kind === "identifier" ? symbols.get(declaration.value.name)?.declaration : undefined;
        const kind = direct?.kind === "function" ? "function" : direct?.kind === "component" ? "component" : "value";
        if (type.kind === "callable" && kind === "value") {
          diagnostic("CUT_MODULE_EXPORT_CALLABLE", `Callable export “${declaration.name}” must directly name a function or component declared in this module.`, declaration.value.span, "Declare a named function/component and export that identifier; callable aliases and re-exports are deliberately unsupported in this slice.");
        } else if (kind === "value" && !isCompileTimeValueType(type)) {
          diagnostic("CUT_MODULE_EXPORT_TYPE", `Value export “${declaration.name}” is not a supported compile-time value type (${displayType(type)}).`, declaration.value.span);
        } else exportedSymbols.set(declaration.name, {
          name: declaration.name,
          kind,
          type,
          ...(kind === "component" && direct?.kind === "component"
            && responsiveAnnotatedComponents.has(direct.name)
            ? { responsiveAnnotatedComponent: true as const }
            : {}),
        });
      }
    }
  }

  const functions = new Map(module.declarations.filter((item): item is Extract<Declaration, { kind: "function" }> => item.kind === "function").map((item) => [item.name, item]));
  const functionState = new Map<string, "visiting" | "done">(), functionStack: string[] = [];
  const visitFunction = (name: string) => {
    if (functionState.get(name) === "done") return;
    if (functionState.get(name) === "visiting") {
      const start = functionStack.indexOf(name);
      diagnostic("CUT_MODULE_FUNCTION_CYCLE", `Pure function cycle: ${[...functionStack.slice(start), name].join(" -> ")}.`, functions.get(name)!.span, "CUT expands pure functions at compile time; recursive functions are not supported.");
      return;
    }
    functionState.set(name, "visiting"); functionStack.push(name);
    for (const identifier of expressionIdentifiers(functions.get(name)!.value)) if (functions.has(identifier)) visitFunction(identifier);
    functionStack.pop(); functionState.set(name, "done");
  };
  functions.forEach((_, name) => visitFunction(name));

  // Final-graph predicates are deliberately assertion-only. They cannot drive
  // compile-time branches, constants, node arguments or function bodies because
  // their truth is unavailable until every timeline body has lowered. Refuse
  // those contexts at the authored call instead of leaking an unresolved-IR or
  // generic lowering error later.
  const domainAssertionNatives: ReadonlySet<string> = new Set(cutDomainAssertionPredicates);
  const checkDomainAssertionExpressionContext = (expression: Expression, assertionContext: boolean): void => {
    if (expression.kind === "call") {
      const callee = expressionTypes.get(expression.callee);
      if (!assertionContext && callee?.kind === "callable" && callee.native && domainAssertionNatives.has(callee.native)) {
        diagnostic(
          "CUT_ASSERT_CONTEXT",
          `${callee.name} is a final-IR predicate and is valid only inside an assert condition.`,
          expression.span,
          "Author it directly in assert, optionally composed with !, &&, or ||; it cannot drive compile-time control flow or ordinary values.",
        );
      }
      checkDomainAssertionExpressionContext(expression.callee, assertionContext);
      expression.positional.forEach((item) => checkDomainAssertionExpressionContext(item, assertionContext));
      expression.named.forEach((item) => checkDomainAssertionExpressionContext(item.value, assertionContext));
      return;
    }
    if (["number", "string", "boolean", "null", "color", "identifier"].includes(expression.kind)) return;
    if (expression.kind === "array") expression.items.forEach((item) => checkDomainAssertionExpressionContext(item, assertionContext));
    else if (expression.kind === "object") expression.entries.forEach((item) => checkDomainAssertionExpressionContext(item.value, assertionContext));
    else if (expression.kind === "member") checkDomainAssertionExpressionContext(expression.object, assertionContext);
    else if (expression.kind === "index") {
      checkDomainAssertionExpressionContext(expression.object, assertionContext);
      checkDomainAssertionExpressionContext(expression.index, assertionContext);
    } else if (expression.kind === "range") {
      checkDomainAssertionExpressionContext(expression.start, assertionContext);
      checkDomainAssertionExpressionContext(expression.end, assertionContext);
    } else if (expression.kind === "group" || expression.kind === "unary") checkDomainAssertionExpressionContext(expression.value, assertionContext);
    else if (expression.kind === "binary") {
      checkDomainAssertionExpressionContext(expression.left, assertionContext);
      checkDomainAssertionExpressionContext(expression.right, assertionContext);
    }
  };
  const checkDomainAssertionStatements = (statements: readonly Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "let") checkDomainAssertionExpressionContext(statement.value, false);
      else if (statement.kind === "node") {
        checkDomainAssertionExpressionContext(statement.expression, false);
        checkDomainAssertionStatements(statement.body);
      } else if (statement.kind === "set") {
        checkDomainAssertionExpressionContext(statement.target, false);
        checkDomainAssertionExpressionContext(statement.value, false);
      } else if (statement.kind === "animate") {
        checkDomainAssertionExpressionContext(statement.target, false);
        checkDomainAssertionExpressionContext(statement.from, false);
        checkDomainAssertionExpressionContext(statement.to, false);
        checkDomainAssertionExpressionContext(statement.duration, false);
        if (statement.delay) checkDomainAssertionExpressionContext(statement.delay, false);
        if (statement.easing) checkDomainAssertionExpressionContext(statement.easing, false);
      } else if (statement.kind === "at") {
        checkDomainAssertionExpressionContext(statement.time, false);
        checkDomainAssertionStatements(statement.body);
      } else if (statement.kind === "for") {
        checkDomainAssertionExpressionContext(statement.iterable, false);
        checkDomainAssertionStatements(statement.body);
      } else if (statement.kind === "if") {
        checkDomainAssertionExpressionContext(statement.condition, false);
        checkDomainAssertionStatements(statement.consequent);
        checkDomainAssertionStatements(statement.alternate);
      } else checkDomainAssertionExpressionContext(statement.condition, true);
    }
  };
  for (const declaration of module.declarations) {
    if (declaration.kind === "asset" || declaration.kind === "const" || declaration.kind === "export") {
      checkDomainAssertionExpressionContext(declaration.value, false);
    } else if (declaration.kind === "function") {
      declaration.parameters.forEach((parameter) => { if (parameter.defaultValue) checkDomainAssertionExpressionContext(parameter.defaultValue, false); });
      checkDomainAssertionExpressionContext(declaration.value, false);
    } else if (declaration.kind === "component") {
      declaration.parameters.forEach((parameter) => { if (parameter.defaultValue) checkDomainAssertionExpressionContext(parameter.defaultValue, false); });
      checkDomainAssertionStatements(declaration.body);
    } else if (declaration.kind === "timeline") {
      declaration.arguments.forEach((argument) => checkDomainAssertionExpressionContext(argument.value, false));
      for (const item of declaration.items) {
        if (item.kind === "scene") {
          item.arguments.forEach((argument) => checkDomainAssertionExpressionContext(argument.value, false));
          checkDomainAssertionStatements(item.body);
        } else checkDomainAssertionStatements([item]);
      }
    }
  }

  return { module, diagnostics, expressionTypes, symbols, imports, userImports, exports: exportedSymbols, effects, responsiveAnnotatedComponents };
}

export function hasTypeErrors(result: CheckResult) { return result.diagnostics.some((item) => item.severity === "error"); }
export { displayType, nodeDomain, sameType, typeFromName };
