import type { CutAVIR, IRNode, IRSignal, IRValue } from "../../language/ir";
import { rationalToNumber, type Rational } from "../../language/rational";
import { propertyAt } from "./signals";

export type ReferenceLutErrorCode =
  | "CUT_LUT_INPUT_TYPE"
  | "CUT_LUT_VALUE_RANGE"
  | "CUT_LUT_SIGNAL"
  | "CUT_LUT_GRAPH"
  | "CUT_LUT_RESOURCE"
  | "CUT_LUT_FORMAT"
  | "CUT_LUT_LIMIT";

export const referenceCubeLutLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxLineBytes: 4_096,
  maxTitleBytes: 512,
  minSize: 2,
  max1dSize: 65_536,
  max3dSize: 65,
  maxLines: 300_000,
  maxProjectTables: 64,
  maxProjectBytes: 64 * 1024 * 1024,
  maxCompositionTables: 32,
  maxCompositionBytes: 32 * 1024 * 1024,
  minimumDomain: -16,
  maximumDomain: 16,
});

export class ReferenceLutError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceLutErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${node.op} at ${module}:${span.start.line}:${span.start.column} ${message}`);
    this.name = "ReferenceLutError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

export type ReferenceCubeLut = Readonly<{
  kind: "1d" | "3d";
  size: number;
  title?: string;
  domainMin: readonly [number, number, number];
  domainMax: readonly [number, number, number];
  /** RGB triplets in .cube order. For 3D tables red changes fastest. */
  data: Float64Array;
}>;

export type ReferenceLutConfig = Readonly<{
  nodeId: string;
  sourceId: string;
}>;

type LabeledValue = { value: IRValue; label: string };
const finiteDecimal = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function fail(node: IRNode, code: ReferenceLutErrorCode, message: string): never {
  throw new ReferenceLutError(code, node, message);
}

function canonicalRatio(node: IRNode, label: string, value: IRValue | undefined, fallback = 1) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_LUT_INPUT_TYPE", `${label} must be a canonical Ratio.`);
  }
  try {
    if (BigInt(value.magnitude.denominator) <= 0n) fail(node, "CUT_LUT_INPUT_TYPE", `${label} must have a positive exact denominator.`);
    BigInt(value.magnitude.numerator);
  } catch (error) {
    if (error instanceof ReferenceLutError) throw error;
    fail(node, "CUT_LUT_INPUT_TYPE", `${label} must contain a canonical exact rational.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < 0 || result > 1) fail(node, "CUT_LUT_VALUE_RANGE", `${label} must be between 0% and 100%, inclusive.`);
  return result;
}

function signalValues(node: IRNode, signal: IRSignal, prefix: string, allowUnsetTrackInitial: boolean): LabeledValue[] {
  if (signal.kind === "constant") return [{ value: signal.value, label: `${prefix}.value` }];
  if (signal.kind === "step") {
    if (!signal.points.length) fail(node, "CUT_LUT_SIGNAL", `${prefix} must contain at least one step point.`);
    return signal.points.map((point, index) => ({ value: point.value, label: `${prefix}.points[${index}].value` }));
  }
  if (signal.kind === "keyframes") {
    if (!signal.keyframes.length) fail(node, "CUT_LUT_SIGNAL", `${prefix} must contain at least one keyframe.`);
    return signal.keyframes.map((keyframe, index) => ({ value: keyframe.value, label: `${prefix}.keyframes[${index}].value` }));
  }
  if (signal.initial.kind === "null" && !signal.events.length) fail(node, "CUT_LUT_SIGNAL", `${prefix} has no value to execute.`);
  return [
    ...(allowUnsetTrackInitial && signal.initial.kind === "null" ? [] : [{ value: signal.initial, label: `${prefix}.initial` }]),
    ...signal.events.flatMap((event, index) => event.kind === "set"
      ? [{ value: event.value, label: `${prefix}.events[${index}].value` }]
      : [
        { value: event.from, label: `${prefix}.events[${index}].from` },
        { value: event.to, label: `${prefix}.events[${index}].to` },
      ]),
  ];
}

function strengthValues(ir: CutAVIR, node: IRNode) {
  const property = node.properties.strength;
  if (!property) return [];
  if (!("signal" in property)) return [{ value: property, label: "property “strength”" }];
  const signal = ir.signals[property.signal];
  if (!signal) fail(node, "CUT_LUT_SIGNAL", `property “strength” references missing signal ${property.signal}.`);
  return signalValues(node, signal, `property “strength” signal ${property.signal}`, node.inputs.strength === undefined);
}

function executedStrength(ir: CutAVIR, node: IRNode, time: Rational) {
  const property = node.properties.strength;
  if (property && "signal" in property && !ir.signals[property.signal]) fail(node, "CUT_LUT_SIGNAL", `property “strength” references missing signal ${property.signal}.`);
  const value = propertyAt(ir, node, "strength", time);
  return value?.kind === "null" ? node.inputs.strength : value ?? node.inputs.strength;
}

function referencesResource(value: IRValue, resourceId: string): boolean {
  const pending: IRValue[] = [value];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.kind === "resource-ref" && current.id === resourceId) return true;
    if (current.kind === "array") pending.push(...current.items);
    else if (current.kind === "object") pending.push(...Object.values(current.entries));
    else if (current.kind === "range") pending.push(current.start, current.end);
    else if (current.kind === "unary") pending.push(current.value);
    else if (current.kind === "binary") pending.push(current.left, current.right);
    else if (current.kind === "member") pending.push(current.object);
    else if (current.kind === "index") pending.push(current.object, current.index);
    else if (current.kind === "call") pending.push(...current.positional, ...Object.values(current.named));
  }
  return false;
}

/** Validate the public node/resource graph and every stored strength value. */
export function referenceLutConfig(ir: CutAVIR, node: IRNode): ReferenceLutConfig | undefined {
  if (node.op !== "cut.visual.lut") return undefined;
  if (node.domain !== "visual" || node.children.length !== 1) fail(node, "CUT_LUT_GRAPH", `requires exactly one visual child; found ${node.children.length}.`);
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") fail(node, "CUT_LUT_INPUT_TYPE", "source must be a DataAsset resource reference.");
  const resource = ir.resources[source.id];
  if (!resource || resource.kind !== "data") fail(node, "CUT_LUT_RESOURCE", `source ${source.id} must resolve to a DataAsset.`);
  // Legacy untyped DataAsset keeps its historical extension declaration.
  // LUTAsset carries an explicit compiler-owned format/policy authority, so
  // its semantics never depend on or get inferred from the locator spelling.
  if (!resource.byteAuthority && !resource.locator.endsWith(".cube")) {
    fail(node, "CUT_LUT_RESOURCE", `legacy DataAsset source locator “${resource.locator}” must use the lowercase .cube extension; extension guessing is forbidden.`);
  }
  canonicalRatio(node, "strength", node.inputs.strength);
  for (const item of strengthValues(ir, node)) canonicalRatio(node, item.label, item.value);
  return Object.freeze({ nodeId: node.id, sourceId: source.id });
}

export function referenceLutStrengthAt(ir: CutAVIR, node: IRNode, time: Rational) {
  if (node.op !== "cut.visual.lut") fail(node, "CUT_LUT_GRAPH", "is not a LUT node.");
  return canonicalRatio(node, "strength", executedStrength(ir, node, time));
}

function stripComment(node: IRNode, value: string, line: number) {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    else if (character === "#" && !quoted) return value.slice(0, index);
  }
  if (quoted) fail(node, "CUT_LUT_FORMAT", `line ${line} contains an unterminated quoted TITLE.`);
  return value;
}

function cubeLines(node: IRNode, text: string) {
  const result: Array<{ number: number; value: string }> = [];
  let start = 0, line = 1;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index];
    if (index < text.length && character !== "\n" && character !== "\r") continue;
    const value = text.slice(start, index);
    if (Buffer.byteLength(value, "utf8") > referenceCubeLutLimits.maxLineBytes) fail(node, "CUT_LUT_LIMIT", `line ${line} exceeds ${referenceCubeLutLimits.maxLineBytes} UTF-8 bytes.`);
    result.push({ number: line, value });
    if (result.length > referenceCubeLutLimits.maxLines) fail(node, "CUT_LUT_LIMIT", `file exceeds ${referenceCubeLutLimits.maxLines} lines.`);
    if (character === "\r" && text[index + 1] === "\n") index += 1;
    start = index + 1; line += 1;
  }
  return result;
}

function numberToken(node: IRNode, token: string, line: number, label: string) {
  if (!finiteDecimal.test(token)) fail(node, "CUT_LUT_FORMAT", `line ${line} ${label} must be a finite decimal number.`);
  const value = Number(token);
  if (!Number.isFinite(value)) fail(node, "CUT_LUT_FORMAT", `line ${line} ${label} is not finite.`);
  return value;
}

function triplet(node: IRNode, tokens: string[], line: number, label: string) {
  if (tokens.length !== 4) fail(node, "CUT_LUT_FORMAT", `line ${line} ${label} requires exactly three numeric values.`);
  return [
    numberToken(node, tokens[1], line, `${label}[0]`),
    numberToken(node, tokens[2], line, `${label}[1]`),
    numberToken(node, tokens[3], line, `${label}[2]`),
  ] as [number, number, number];
}

/** Parse CUT's strict, bounded SDR subset of the Adobe/Resolve .cube format. */
export function parseReferenceCubeLut(node: IRNode, input: Uint8Array): ReferenceCubeLut {
  if (!(input instanceof Uint8Array)) fail(node, "CUT_LUT_INPUT_TYPE", "locked LUT bytes must be a Uint8Array.");
  if (input.byteLength < 1 || input.byteLength > referenceCubeLutLimits.maxBytes) fail(node, "CUT_LUT_LIMIT", `locked .cube bytes must be between 1 and ${referenceCubeLutLimits.maxBytes}.`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); }
  catch { fail(node, "CUT_LUT_FORMAT", "locked .cube bytes are not valid UTF-8."); }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      fail(node, "CUT_LUT_FORMAT", `locked .cube text contains unsupported control U+${code.toString(16).toUpperCase().padStart(4, "0")}.`);
    }
  }

  let title: string | undefined, domainMin: [number, number, number] | undefined, domainMax: [number, number, number] | undefined;
  let kind: "1d" | "3d" | undefined, size: number | undefined, dataStarted = false;
  const values: number[] = [];
  for (const item of cubeLines(node, text)) {
    const line = stripComment(node, item.value, item.number).trim();
    if (!line) continue;
    if (line.startsWith("TITLE")) {
      if (dataStarted) fail(node, "CUT_LUT_FORMAT", `line ${item.number} places TITLE after table data.`);
      if (title !== undefined) fail(node, "CUT_LUT_FORMAT", `line ${item.number} repeats TITLE.`);
      const match = /^TITLE[ \t]+"([^"\r\n]*)"$/.exec(line);
      if (!match) fail(node, "CUT_LUT_FORMAT", `line ${item.number} TITLE must contain exactly one quoted string without escapes.`);
      if (Buffer.byteLength(match[1], "utf8") > referenceCubeLutLimits.maxTitleBytes) fail(node, "CUT_LUT_LIMIT", `line ${item.number} TITLE exceeds ${referenceCubeLutLimits.maxTitleBytes} UTF-8 bytes.`);
      title = match[1]; continue;
    }
    const tokens = line.split(/[ \t]+/);
    const directive = tokens[0];
    if (directive === "DOMAIN_MIN" || directive === "DOMAIN_MAX") {
      if (dataStarted) fail(node, "CUT_LUT_FORMAT", `line ${item.number} places ${directive} after table data.`);
      const value = triplet(node, tokens, item.number, directive);
      if (directive === "DOMAIN_MIN") {
        if (domainMin) fail(node, "CUT_LUT_FORMAT", `line ${item.number} repeats DOMAIN_MIN.`);
        domainMin = value;
      } else {
        if (domainMax) fail(node, "CUT_LUT_FORMAT", `line ${item.number} repeats DOMAIN_MAX.`);
        domainMax = value;
      }
      continue;
    }
    if (directive === "LUT_1D_SIZE" || directive === "LUT_3D_SIZE") {
      if (dataStarted) fail(node, "CUT_LUT_FORMAT", `line ${item.number} declares a second table after data began.`);
      if (kind !== undefined || size !== undefined) fail(node, "CUT_LUT_FORMAT", `line ${item.number} declares multiple or ambiguous LUT tables.`);
      if (tokens.length !== 2 || !/^\d+$/.test(tokens[1])) fail(node, "CUT_LUT_FORMAT", `line ${item.number} ${directive} requires one decimal integer.`);
      const parsed = Number(tokens[1]);
      const maximum = directive === "LUT_1D_SIZE" ? referenceCubeLutLimits.max1dSize : referenceCubeLutLimits.max3dSize;
      if (!Number.isSafeInteger(parsed) || parsed < referenceCubeLutLimits.minSize || parsed > maximum) fail(node, "CUT_LUT_LIMIT", `line ${item.number} ${directive} must be from ${referenceCubeLutLimits.minSize} through ${maximum}.`);
      kind = directive === "LUT_1D_SIZE" ? "1d" : "3d"; size = parsed; continue;
    }
    if (/^[A-Za-z_]/.test(directive)) fail(node, "CUT_LUT_FORMAT", `line ${item.number} uses unsupported .cube directive or semantics “${directive}”.`);
    if (!kind || !size) fail(node, "CUT_LUT_FORMAT", `line ${item.number} begins table data before exactly one LUT size declaration.`);
    if (tokens.length !== 3) fail(node, "CUT_LUT_FORMAT", `line ${item.number} table row must contain exactly three numeric values.`);
    dataStarted = true;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = numberToken(node, tokens[channel], item.number, `table channel ${channel}`);
      if (value < 0 || value > 1) fail(node, "CUT_LUT_VALUE_RANGE", `line ${item.number} table channel ${channel} is outside CUT's normalized SDR output domain 0...1.`);
      values.push(value);
    }
    const expected = (kind === "1d" ? size : size ** 3) * 3;
    if (values.length > expected) fail(node, "CUT_LUT_FORMAT", `line ${item.number} adds data beyond the declared ${kind.toUpperCase()} table size.`);
  }
  if (!kind || !size) fail(node, "CUT_LUT_FORMAT", "file must declare exactly one LUT_1D_SIZE or LUT_3D_SIZE table.");
  if ((domainMin === undefined) !== (domainMax === undefined)) fail(node, "CUT_LUT_FORMAT", "DOMAIN_MIN and DOMAIN_MAX must either both be omitted or both be declared exactly once.");
  const minimum = domainMin ?? [0, 0, 0], maximum = domainMax ?? [1, 1, 1];
  for (let channel = 0; channel < 3; channel += 1) {
    if (minimum[channel] < referenceCubeLutLimits.minimumDomain || maximum[channel] > referenceCubeLutLimits.maximumDomain || minimum[channel] >= maximum[channel]) {
      fail(node, "CUT_LUT_VALUE_RANGE", `DOMAIN channel ${channel} must be finite, increasing, and inside ${referenceCubeLutLimits.minimumDomain}...${referenceCubeLutLimits.maximumDomain}.`);
    }
    if (minimum[channel] > 0 || maximum[channel] < 1) fail(node, "CUT_LUT_VALUE_RANGE", `DOMAIN channel ${channel} must contain CUT's complete normalized encoded-sRGB input interval 0...1.`);
  }
  const entries = kind === "1d" ? size : size ** 3, expected = entries * 3;
  if (values.length !== expected) fail(node, "CUT_LUT_FORMAT", `declared ${kind.toUpperCase()} table needs ${entries} RGB rows; found ${values.length / 3}.`);
  return Object.freeze({ kind, size, ...(title === undefined ? {} : { title }), domainMin: minimum, domainMax: maximum, data: Float64Array.from(values) });
}

function normalizedCoordinate(lut: ReferenceCubeLut, channel: number, value: number) {
  const minimum = lut.domainMin[channel], maximum = lut.domainMax[channel];
  return Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
}

function lerp(left: number, right: number, amount: number) { return left + (right - left) * amount; }

/** Sample one straight-alpha encoded-sRGB RGB triplet through the parsed table. */
export function sampleReferenceCubeLut(lut: ReferenceCubeLut, red: number, green: number, blue: number): readonly [number, number, number] {
  const source = [red, green, blue].map((value, channel) => normalizedCoordinate(lut, channel, value));
  if (lut.kind === "1d") {
    return source.map((value, channel) => {
      const position = value * (lut.size - 1), lower = Math.floor(position), upper = Math.min(lut.size - 1, lower + 1), amount = position - lower;
      return lerp(lut.data[lower * 3 + channel], lut.data[upper * 3 + channel], amount);
    }) as [number, number, number];
  }
  const axes = source.map((value) => {
    const position = value * (lut.size - 1), lower = Math.floor(position);
    return { lower, upper: Math.min(lut.size - 1, lower + 1), amount: position - lower };
  });
  const table = (r: number, g: number, b: number, channel: number) => lut.data[(r + g * lut.size + b * lut.size * lut.size) * 3 + channel];
  return [0, 1, 2].map((channel) => {
    const c000 = table(axes[0].lower, axes[1].lower, axes[2].lower, channel), c100 = table(axes[0].upper, axes[1].lower, axes[2].lower, channel);
    const c010 = table(axes[0].lower, axes[1].upper, axes[2].lower, channel), c110 = table(axes[0].upper, axes[1].upper, axes[2].lower, channel);
    const c001 = table(axes[0].lower, axes[1].lower, axes[2].upper, channel), c101 = table(axes[0].upper, axes[1].lower, axes[2].upper, channel);
    const c011 = table(axes[0].lower, axes[1].upper, axes[2].upper, channel), c111 = table(axes[0].upper, axes[1].upper, axes[2].upper, channel);
    const low = lerp(lerp(c000, c100, axes[0].amount), lerp(c010, c110, axes[0].amount), axes[1].amount);
    const high = lerp(lerp(c001, c101, axes[0].amount), lerp(c011, c111, axes[0].amount), axes[1].amount);
    return lerp(low, high, axes[2].amount);
  }) as [number, number, number];
}

/**
 * Validate every LUT node and reserve each LUT DataAsset for that byte format
 * across the complete project. The map keeps the first source-located
 * consumer for deterministic lock/parser diagnostics.
 */
export function validateReferenceLutResourceOwnership(ir: CutAVIR) {
  const consumers = new Map<string, { node: IRNode; config: ReferenceLutConfig }>();
  const nodes = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.lut").sort((left, right) => left.id.localeCompare(right.id));
  for (const node of nodes) {
    const config = referenceLutConfig(ir, node)!;
    if (!consumers.has(config.sourceId)) consumers.set(config.sourceId, { node, config });
  }
  if (consumers.size > referenceCubeLutLimits.maxProjectTables) {
    const excess = [...consumers.values()][referenceCubeLutLimits.maxProjectTables];
    fail(excess.node, "CUT_LUT_LIMIT", `project references more than ${referenceCubeLutLimits.maxProjectTables} distinct LUT tables.`);
  }
  for (const [sourceId, consumer] of consumers) {
    const incompatible = Object.values(ir.nodes).sort((left, right) => left.id.localeCompare(right.id)).find((candidate) => candidate.op !== "cut.visual.lut"
      && Object.values(candidate.inputs).some((value) => referencesResource(value, sourceId)));
    if (incompatible) fail(consumer.node, "CUT_LUT_RESOURCE", `DataAsset ${sourceId} is also consumed by ${incompatible.op}; declare separate assets for distinct byte-format semantics.`);
  }
  return consumers;
}

/** Parse every unique public LUT resource, suitable for lock-time validation. */
export async function validateReferenceLutResources(ir: CutAVIR, load: (resourceId: string, node: IRNode) => Promise<Uint8Array>) {
  const parsed = new Map<string, ReferenceCubeLut>();
  let projectBytes = 0;
  for (const [sourceId, consumer] of validateReferenceLutResourceOwnership(ir)) {
    const bytes = await load(sourceId, consumer.node);
    if (!(bytes instanceof Uint8Array)) fail(consumer.node, "CUT_LUT_INPUT_TYPE", "locked LUT bytes must be a Uint8Array.");
    projectBytes += bytes.byteLength;
    if (!Number.isSafeInteger(projectBytes) || projectBytes > referenceCubeLutLimits.maxProjectBytes) {
      fail(consumer.node, "CUT_LUT_LIMIT", `project LUT bytes exceed ${referenceCubeLutLimits.maxProjectBytes}.`);
    }
    parsed.set(sourceId, parseReferenceCubeLut(consumer.node, bytes));
  }
  return parsed;
}
