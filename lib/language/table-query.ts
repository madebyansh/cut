import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { boundedDiagnosticString, hash, stableJsonStringify } from "../core/stable";
import {
  addRational,
  compareRational,
  divideRational,
  rational,
  type Rational,
  zeroRational,
} from "./rational";

export type CutTableQueryErrorCode =
  | "CUT_TABLE_RESOURCE_TYPE"
  | "CUT_TABLE_RESOURCE_STATE"
  | "CUT_TABLE_RESOURCE_INTEGRITY"
  | "CUT_TABLE_RESOURCE_LIMIT"
  | "CUT_TABLE_JSON_ENCODING"
  | "CUT_TABLE_JSON_PARSE"
  | "CUT_TABLE_JSON_DUPLICATE_KEY"
  | "CUT_TABLE_JSON_LIMIT"
  | "CUT_TABLE_FORMAT"
  | "CUT_TABLE_UNKNOWN_FIELD"
  | "CUT_TABLE_SCHEMA_TYPE"
  | "CUT_TABLE_SCHEMA_NAME"
  | "CUT_TABLE_SCHEMA_DUPLICATE"
  | "CUT_TABLE_SCHEMA_KEY"
  | "CUT_TABLE_SCHEMA_LIMIT"
  | "CUT_TABLE_ROW_TYPE"
  | "CUT_TABLE_ROW_FIELD"
  | "CUT_TABLE_ROW_DUPLICATE_KEY"
  | "CUT_TABLE_ROW_LIMIT"
  | "CUT_TABLE_CELL_TYPE"
  | "CUT_TABLE_CELL_VALUE"
  | "CUT_TABLE_CELL_LIMIT"
  | "CUT_QUERY_PLAN_TYPE"
  | "CUT_QUERY_PLAN_UNKNOWN_FIELD"
  | "CUT_QUERY_PLAN_VERSION"
  | "CUT_QUERY_PLAN_NAME"
  | "CUT_QUERY_PLAN_DUPLICATE"
  | "CUT_QUERY_PLAN_REFERENCE"
  | "CUT_QUERY_PLAN_FIELD"
  | "CUT_QUERY_PLAN_TYPE_ERROR"
  | "CUT_QUERY_SCHEMA_CONFLICT"
  | "CUT_QUERY_SOURCE_SCHEMA"
  | "CUT_QUERY_PLAN_LIMIT"
  | "CUT_QUERY_CARDINALITY"
  | "CUT_QUERY_RESULT_KEY"
  | "CUT_QUERY_NUMERIC_LIMIT";

export class CutTableQueryError extends Error {
  constructor(
    readonly code: CutTableQueryErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code}: ${message} at ${path}.`);
    this.name = "CutTableQueryError";
  }
}

export type CutTableQueryLimits = Readonly<{
  maxInputBytes: number;
  maxTotalInputBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxJsonStringBytes: number;
  maxTotalStringBytes: number;
  maxFields: number;
  maxRowsPerSource: number;
  maxCellsPerSource: number;
  maxRationalDigits: number;
  maxSources: number;
  maxSteps: number;
  maxPredicateNodes: number;
  maxJoinRows: number;
  maxGroups: number;
  maxResultRows: number;
  maxResultCells: number;
}>;

export const defaultCutTableQueryLimits: CutTableQueryLimits = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxTotalInputBytes: 64 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 2_000_000,
  maxJsonStringBytes: 1 * 1024 * 1024,
  maxTotalStringBytes: 32 * 1024 * 1024,
  maxFields: 128,
  maxRowsPerSource: 100_000,
  maxCellsPerSource: 1_000_000,
  maxRationalDigits: 256,
  maxSources: 32,
  maxSteps: 128,
  maxPredicateNodes: 1_024,
  maxJoinRows: 250_000,
  maxGroups: 100_000,
  maxResultRows: 250_000,
  maxResultCells: 2_000_000,
});

export type CutExactNumber = Readonly<Rational>;

export type CutTableFieldType =
  | Readonly<{ kind: "number" }>
  | Readonly<{ kind: "string"; maxBytes: number }>
  | Readonly<{ kind: "boolean" }>
  | Readonly<{ kind: "date" }>;

export type CutTableField = Readonly<{
  name: string;
  type: CutTableFieldType;
}>;

export type CutTableSchema = Readonly<{
  fields: readonly CutTableField[];
  key: readonly string[];
}>;

export type CutTableCell = CutExactNumber | string | boolean;
export type CutTableRow = Readonly<Record<string, CutTableCell>>;

export type CutLockedTableResource = Readonly<{
  id: string;
  kind: "data";
  state: "locked";
  lockVersion: 2;
  sha256: string;
  bytes: number;
}>;

export type CutLockedTableInput = Readonly<{
  resource: CutLockedTableResource;
  bytes: Uint8Array;
}>;

export type CutSourceTable = Readonly<{
  format: "cut-source-table";
  version: 1;
  id: string;
  schemaId: string;
  resource: CutLockedTableResource;
  schema: CutTableSchema;
  rows: readonly CutTableRow[];
}>;

export type CutQueryPredicate =
  | Readonly<{
      op: "compare";
      field: string;
      operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      value: CutTableCell;
    }>
  | Readonly<{ op: "and"; items: readonly CutQueryPredicate[] }>
  | Readonly<{ op: "or"; items: readonly CutQueryPredicate[] }>
  | Readonly<{ op: "not"; item: CutQueryPredicate }>;

export type CutQuerySource = Readonly<{
  name: string;
  resourceId: string;
  schema: CutTableSchema;
}>;

export type CutQueryFilterStep = Readonly<{
  id: string;
  op: "filter";
  input: string;
  where: CutQueryPredicate;
}>;

export type CutQueryJoinStep = Readonly<{
  id: string;
  op: "inner-join";
  left: string;
  right: string;
  on: readonly Readonly<{ left: string; right: string }>[];
  select: readonly Readonly<{ from: "left" | "right"; field: string; as: string }>[];
  key: readonly string[];
}>;

export type CutQueryGroupStep = Readonly<{
  id: string;
  op: "group";
  input: string;
  by: readonly Readonly<{ field: string; as: string }>[];
}>;

export type CutQueryAggregate =
  | Readonly<{ as: string; function: "count" }>
  | Readonly<{ as: string; function: "sum" | "mean" | "min" | "max"; field: string }>;

export type CutQueryAggregateStep = Readonly<{
  id: string;
  op: "aggregate";
  input: string;
  values: readonly CutQueryAggregate[];
}>;

export type CutQuerySortStep = Readonly<{
  id: string;
  op: "sort";
  input: string;
  by: readonly Readonly<{ field: string; direction: "asc" | "desc" }>[];
}>;

export type CutQuerySeriesStep = Readonly<{
  id: string;
  op: "series";
  input: string;
  x: string;
  values: readonly Readonly<{ field: string; as: string }>[];
}>;

export type CutQueryStep =
  | CutQueryFilterStep
  | CutQueryJoinStep
  | CutQueryGroupStep
  | CutQueryAggregateStep
  | CutQuerySortStep
  | CutQuerySeriesStep;

export type CutTableQueryPlan = Readonly<{
  format: "cut-query-plan";
  version: 1;
  sources: readonly CutQuerySource[];
  steps: readonly CutQueryStep[];
  result: string;
}>;

export type CutQuerySeriesSchema = Readonly<{
  key: readonly CutTableField[];
  x: CutTableField;
  values: readonly CutTableField[];
}>;

export type CutCheckedTableQueryPlan = Readonly<{
  format: "cut-checked-query-plan";
  version: 1;
  id: string;
  plan: CutTableQueryPlan;
  output:
    | Readonly<{ kind: "table"; schema: CutTableSchema; schemaId: string }>
    | Readonly<{ kind: "series"; schema: CutQuerySeriesSchema }>;
}>;

export type CutQuerySeriesPoint = Readonly<{
  key: Readonly<Record<string, CutTableCell>>;
  x: CutTableCell;
  values: Readonly<Record<string, CutExactNumber>>;
}>;

export type CutEvaluatedTableQuery =
  | Readonly<{
      format: "cut-query-result";
      version: 1;
      kind: "table";
      id: string;
      planId: string;
      sources: readonly Readonly<{ name: string; tableId: string }>[];
      schemaId: string;
      schema: CutTableSchema;
      rows: readonly CutTableRow[];
    }>
  | Readonly<{
      format: "cut-query-result";
      version: 1;
      kind: "series";
      id: string;
      planId: string;
      sources: readonly Readonly<{ name: string; tableId: string }>[];
      schema: CutQuerySeriesSchema;
      points: readonly CutQuerySeriesPoint[];
    }>;

type JsonRecord = Record<string, unknown>;
type ValidationContext = {
  limits: CutTableQueryLimits;
  jsonNodes: number;
  totalStringBytes: number;
  predicateNodes: number;
};

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const unsafeIdentifiers = new Set(["__proto__", "prototype", "constructor"]);
const digestPattern = /^[a-f0-9]{64}$/u;
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/u;
const positiveIntegerPattern = /^(?:0|[1-9][0-9]*)$/u;
const utf8Encoder = new TextEncoder();

function fail(code: CutTableQueryErrorCode, path: string, message: string): never {
  throw new CutTableQueryError(code, path, message);
}

function childPath(parent: string, field: string) {
  return identifierPattern.test(field) ? `${parent}.${field}` : `${parent}[${boundedDiagnosticString(field)}]`;
}

function indexPath(parent: string, index: number) { return `${parent}[${index}]`; }

function isRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string, code: CutTableQueryErrorCode): JsonRecord {
  if (!isRecord(value)) fail(code, path, "must be a plain object");
  return value;
}

function assertSafeDataProperties(value: JsonRecord, path: string, code: CutTableQueryErrorCode) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") fail(code, path, "symbol-keyed properties are forbidden at the closed data boundary");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail(code, childPath(path, key), "accessor properties are forbidden at the closed data boundary");
    }
    if (!descriptor.enumerable) fail(code, childPath(path, key), "non-enumerable properties are forbidden at the closed data boundary");
  }
}

function closed(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
  code: CutTableQueryErrorCode = "CUT_TABLE_UNKNOWN_FIELD",
) {
  const object = record(value, path, code === "CUT_TABLE_UNKNOWN_FIELD" ? "CUT_TABLE_FORMAT" : code);
  assertSafeDataProperties(object, path, code === "CUT_TABLE_UNKNOWN_FIELD" ? "CUT_TABLE_FORMAT" : code);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(code, childPath(path, key), `unknown field ${boundedDiagnosticString(key)} is not part of this closed contract`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail(code, childPath(path, key), "required field is missing");
  }
  return object;
}

function array(value: unknown, path: string, code: CutTableQueryErrorCode) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) fail(code, path, "must be a direct ordinary array");
  let indices = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key === "symbol") fail(code, path, "symbol-keyed array properties are forbidden at the closed data boundary");
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      fail(code, childPath(path, key), "array contains a non-index own property");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail(code, indexPath(path, Number(key)), "array accessors are forbidden at the closed data boundary");
    if (!descriptor.enumerable) fail(code, indexPath(path, Number(key)), "array elements must be enumerable data properties");
    indices += 1;
  }
  if (indices !== value.length) fail(code, path, "array must be dense and cannot contain holes");
  return value;
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number, code: CutTableQueryErrorCode) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(code, path, `must be a safe integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function exactString(value: unknown, path: string, code: CutTableQueryErrorCode) {
  if (typeof value !== "string") fail(code, path, "must be a string");
  ensureWellFormedUnicode(value, path, code);
  return value;
}

function identifier(value: unknown, path: string, code: CutTableQueryErrorCode) {
  const result = exactString(value, path, code);
  if (!identifierPattern.test(result) || unsafeIdentifiers.has(result)) {
    fail(code, path, "must be 1..64 safe ASCII identifier characters beginning with a letter or underscore and not a prototype-control name");
  }
  return result;
}

function digest(value: unknown, path: string, code: CutTableQueryErrorCode) {
  const result = exactString(value, path, code);
  if (!digestPattern.test(result)) fail(code, path, "must be a lowercase SHA-256 digest");
  return result;
}

function ensureWellFormedUnicode(value: string, path: string, code: CutTableQueryErrorCode) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) fail(code, path, "contains an unpaired UTF-16 high surrogate");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(code, path, "contains an unpaired UTF-16 low surrogate");
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function resolveLimits(overrides: Partial<CutTableQueryLimits> = {}) {
  if (!isRecord(overrides)) fail("CUT_QUERY_PLAN_TYPE", "$.options.limits", "must be a plain object");
  assertSafeDataProperties(overrides, "$.options.limits", "CUT_QUERY_PLAN_TYPE");
  const allowed = new Set(Object.keys(defaultCutTableQueryLimits));
  for (const [name, value] of Object.entries(overrides)) {
    if (!allowed.has(name)) fail("CUT_QUERY_PLAN_UNKNOWN_FIELD", childPath("$.options.limits", name), "is not a supported table/query limit");
    const ceiling = defaultCutTableQueryLimits[name as keyof CutTableQueryLimits];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > ceiling) {
      fail("CUT_QUERY_PLAN_LIMIT", childPath("$.options.limits", name), `must be a positive safe integer no greater than the hard ceiling ${ceiling}`);
    }
  }
  return Object.freeze({ ...defaultCutTableQueryLimits, ...overrides });
}

function validationContext(limits: CutTableQueryLimits): ValidationContext {
  return { limits, jsonNodes: 0, totalStringBytes: 0, predicateNodes: 0 };
}

class StrictJsonScanner {
  private offset = 0;

  constructor(
    private readonly source: string,
    private readonly context: ValidationContext,
    private readonly rootPath: string,
  ) {}

  scan() {
    this.space();
    this.value(this.rootPath, 0);
    this.space();
    if (this.offset !== this.source.length) this.syntax(this.rootPath, "unexpected trailing input");
  }

  private syntax(path: string, message: string): never {
    fail("CUT_TABLE_JSON_PARSE", path, `${message} at UTF-16 text offset ${this.offset}`);
  }

  private space() {
    while (this.offset < this.source.length && /[\u0009\u000a\u000d\u0020]/u.test(this.source[this.offset])) this.offset += 1;
  }

  private node(path: string, depth: number) {
    this.context.jsonNodes += 1;
    if (this.context.jsonNodes > this.context.limits.maxJsonNodes) {
      fail("CUT_TABLE_JSON_LIMIT", path, `JSON exceeds maxJsonNodes=${this.context.limits.maxJsonNodes}`);
    }
    if (depth > this.context.limits.maxJsonDepth) {
      fail("CUT_TABLE_JSON_LIMIT", path, `JSON exceeds maxJsonDepth=${this.context.limits.maxJsonDepth}`);
    }
  }

  private value(path: string, depth: number) {
    this.node(path, depth);
    this.space();
    const character = this.source[this.offset];
    if (character === "{") return this.object(path, depth);
    if (character === "[") return this.array(path, depth);
    if (character === '"') { this.string(path); return; }
    if (this.source.startsWith("true", this.offset)) { this.offset += 4; return; }
    if (this.source.startsWith("false", this.offset)) { this.offset += 5; return; }
    if (this.source.startsWith("null", this.offset)) { this.offset += 4; return; }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.offset));
    if (!match) this.syntax(path, "expected a JSON value");
    this.offset += match[0].length;
  }

  private string(path: string) {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        let decoded: string;
        try { decoded = JSON.parse(this.source.slice(start, this.offset)) as string; }
        catch { this.syntax(path, "invalid JSON string"); }
        ensureWellFormedUnicode(decoded, path, "CUT_TABLE_JSON_PARSE");
        const bytes = Buffer.byteLength(decoded, "utf8");
        if (bytes > this.context.limits.maxJsonStringBytes) {
          fail("CUT_TABLE_JSON_LIMIT", path, `decoded string exceeds maxJsonStringBytes=${this.context.limits.maxJsonStringBytes}`);
        }
        this.context.totalStringBytes += bytes;
        if (this.context.totalStringBytes > this.context.limits.maxTotalStringBytes) {
          fail("CUT_TABLE_JSON_LIMIT", path, `decoded strings exceed maxTotalStringBytes=${this.context.limits.maxTotalStringBytes}`);
        }
        return decoded;
      }
      if (character === "\\") {
        const escape = this.source[this.offset + 1];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.source.slice(this.offset + 2, this.offset + 6))) this.syntax(path, "invalid Unicode escape");
          this.offset += 6;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) this.syntax(path, "invalid string escape");
        this.offset += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.syntax(path, "unescaped control character in string");
      this.offset += 1;
    }
    this.syntax(path, "unterminated JSON string");
  }

  private object(path: string, depth: number) {
    this.offset += 1;
    this.space();
    const keys = new Set<string>();
    if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax(path, "expected an object key");
      const key = this.string(path);
      const keyPath = childPath(path, key);
      if (keys.has(key)) fail("CUT_TABLE_JSON_DUPLICATE_KEY", keyPath, `duplicate decoded object key ${boundedDiagnosticString(key)}`);
      keys.add(key);
      this.space();
      if (this.source[this.offset] !== ":") this.syntax(keyPath, "expected ':' after object key");
      this.offset += 1;
      this.value(keyPath, depth + 1);
      this.space();
      if (this.source[this.offset] === "}") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax(path, "expected ',' or '}'");
      this.offset += 1;
      this.space();
    }
  }

  private array(path: string, depth: number) {
    this.offset += 1;
    this.space();
    if (this.source[this.offset] === "]") { this.offset += 1; return; }
    let index = 0;
    while (true) {
      this.value(indexPath(path, index), depth + 1);
      index += 1;
      this.space();
      if (this.source[this.offset] === "]") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax(path, "expected ',' or ']'");
      this.offset += 1;
      this.space();
    }
  }
}

function parseStrictJson(bytes: Uint8Array, path: string, context: ValidationContext) {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("CUT_TABLE_JSON_ENCODING", path, "locked table bytes are not valid UTF-8"); }
  new StrictJsonScanner(source, context, path).scan();
  try { return JSON.parse(source) as unknown; }
  catch (error) {
    fail("CUT_TABLE_JSON_PARSE", path, error instanceof Error ? error.message : "invalid JSON");
  }
}

function fieldType(value: unknown, path: string, limits: CutTableQueryLimits): CutTableFieldType {
  const preliminary = record(value, path, "CUT_TABLE_SCHEMA_TYPE");
  assertSafeDataProperties(preliminary, path, "CUT_TABLE_SCHEMA_TYPE");
  const kind = exactString(preliminary.kind, childPath(path, "kind"), "CUT_TABLE_SCHEMA_TYPE");
  if (kind === "string") {
    const object = closed(preliminary, path, ["kind", "maxBytes"], [], "CUT_TABLE_SCHEMA_TYPE");
    const maxBytes = safeInteger(object.maxBytes, childPath(path, "maxBytes"), 1, limits.maxJsonStringBytes, "CUT_TABLE_SCHEMA_LIMIT");
    return Object.freeze({ kind, maxBytes });
  }
  if (kind === "number" || kind === "boolean" || kind === "date") {
    closed(preliminary, path, ["kind"], [], "CUT_TABLE_SCHEMA_TYPE");
    return Object.freeze({ kind });
  }
  fail("CUT_TABLE_SCHEMA_TYPE", childPath(path, "kind"), "must be one of number, string, boolean, or date");
}

function decodeSchema(value: unknown, path: string, limits: CutTableQueryLimits): CutTableSchema {
  const object = closed(value, path, ["fields", "key"], [], "CUT_TABLE_SCHEMA_TYPE");
  const fieldValues = array(object.fields, childPath(path, "fields"), "CUT_TABLE_SCHEMA_TYPE");
  if (fieldValues.length < 1 || fieldValues.length > limits.maxFields) {
    fail("CUT_TABLE_SCHEMA_LIMIT", childPath(path, "fields"), `must contain 1..${limits.maxFields} fields`);
  }
  const seen = new Set<string>();
  const fields = fieldValues.map((entry, index) => {
    const fieldPath = indexPath(childPath(path, "fields"), index);
    const item = closed(entry, fieldPath, ["name", "type"], [], "CUT_TABLE_SCHEMA_TYPE");
    const name = identifier(item.name, childPath(fieldPath, "name"), "CUT_TABLE_SCHEMA_NAME");
    if (seen.has(name)) fail("CUT_TABLE_SCHEMA_DUPLICATE", childPath(fieldPath, "name"), `duplicate schema field ${boundedDiagnosticString(name)}`);
    seen.add(name);
    return Object.freeze({ name, type: fieldType(item.type, childPath(fieldPath, "type"), limits) });
  });
  const keyValues = array(object.key, childPath(path, "key"), "CUT_TABLE_SCHEMA_KEY");
  if (keyValues.length < 1 || keyValues.length > fields.length) {
    fail("CUT_TABLE_SCHEMA_KEY", childPath(path, "key"), "must contain at least one field and no more entries than the schema");
  }
  const keySeen = new Set<string>();
  const key = keyValues.map((entry, index) => {
    const keyPath = indexPath(childPath(path, "key"), index);
    const name = identifier(entry, keyPath, "CUT_TABLE_SCHEMA_KEY");
    if (!seen.has(name)) fail("CUT_TABLE_SCHEMA_KEY", keyPath, `unknown key field ${boundedDiagnosticString(name)}`);
    if (keySeen.has(name)) fail("CUT_TABLE_SCHEMA_KEY", keyPath, `duplicate key field ${boundedDiagnosticString(name)}`);
    keySeen.add(name);
    return name;
  });
  return deepFreeze({ fields, key });
}

function schemaIdentity(schema: CutTableSchema) {
  return hash({ format: "cut-table-schema", version: 1, schema });
}

function canonicalNumber(value: unknown, path: string, limits: CutTableQueryLimits): CutExactNumber {
  const object = closed(value, path, ["numerator", "denominator"], [], "CUT_TABLE_CELL_TYPE");
  const numerator = exactString(object.numerator, childPath(path, "numerator"), "CUT_TABLE_CELL_TYPE");
  const denominator = exactString(object.denominator, childPath(path, "denominator"), "CUT_TABLE_CELL_TYPE");
  if (!integerPattern.test(numerator) || numerator === "-0") {
    fail("CUT_TABLE_CELL_VALUE", childPath(path, "numerator"), "must be a canonical signed integer string without -0");
  }
  if (!positiveIntegerPattern.test(denominator) || denominator === "0") {
    fail("CUT_TABLE_CELL_VALUE", childPath(path, "denominator"), "must be a canonical positive integer string");
  }
  const numeratorDigits = numerator.startsWith("-") ? numerator.length - 1 : numerator.length;
  if (numeratorDigits > limits.maxRationalDigits || denominator.length > limits.maxRationalDigits) {
    fail("CUT_TABLE_CELL_LIMIT", path, `exact number exceeds maxRationalDigits=${limits.maxRationalDigits}`);
  }
  const reduced = rational(numerator, denominator);
  if (reduced.numerator !== numerator || reduced.denominator !== denominator) {
    fail("CUT_TABLE_CELL_VALUE", path, "must be reduced canonical exact rational form");
  }
  return Object.freeze({ ...reduced });
}

function leapYear(year: number) { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }

function isoDate(value: unknown, path: string) {
  const result = exactString(value, path, "CUT_TABLE_CELL_TYPE");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(result);
  if (!match) fail("CUT_TABLE_CELL_VALUE", path, "must be a strict ISO Gregorian date in YYYY-MM-DD form");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    fail("CUT_TABLE_CELL_VALUE", path, "must be a real proleptic-Gregorian calendar date");
  }
  return result;
}

function decodeCell(value: unknown, type: CutTableFieldType, path: string, limits: CutTableQueryLimits): CutTableCell {
  if (type.kind === "number") return canonicalNumber(value, path, limits);
  if (type.kind === "boolean") {
    if (typeof value !== "boolean") fail("CUT_TABLE_CELL_TYPE", path, "must be a Boolean");
    return value;
  }
  if (type.kind === "date") return isoDate(value, path);
  const result = exactString(value, path, "CUT_TABLE_CELL_TYPE");
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes > type.maxBytes) fail("CUT_TABLE_CELL_LIMIT", path, `string is ${bytes} UTF-8 bytes; schema limit is ${type.maxBytes}`);
  return result;
}

function fieldMap(schema: CutTableSchema) {
  return new Map(schema.fields.map((field) => [field.name, field]));
}

function typedCellIdentity(type: CutTableFieldType, value: CutTableCell): readonly unknown[] {
  if (type.kind === "number") {
    const exact = value as CutExactNumber;
    return ["number", exact.numerator, exact.denominator];
  }
  if (type.kind === "string") return ["string", value];
  if (type.kind === "date") return ["date", value];
  return ["boolean", value];
}

function tupleIdentity(schema: CutTableSchema, row: CutTableRow, names: readonly string[]) {
  const fields = fieldMap(schema);
  return JSON.stringify(names.map((name) => {
    const field = fields.get(name);
    if (!field) throw new Error(`Internal CUT table identity field ${name} is absent.`);
    return typedCellIdentity(field.type, row[name]);
  }));
}

/** Canonical, type-tagged, length-safe composite key identity. */
export function cutTableRowKeyIdentity(schema: CutTableSchema, row: CutTableRow) {
  return tupleIdentity(schema, row, schema.key);
}

function decodeRows(value: unknown, schema: CutTableSchema, path: string, limits: CutTableQueryLimits) {
  const rows = array(value, path, "CUT_TABLE_ROW_TYPE");
  if (rows.length > limits.maxRowsPerSource) fail("CUT_TABLE_ROW_LIMIT", path, `contains ${rows.length} rows; limit is ${limits.maxRowsPerSource}`);
  const cells = BigInt(rows.length) * BigInt(schema.fields.length);
  if (cells > BigInt(limits.maxCellsPerSource)) fail("CUT_TABLE_ROW_LIMIT", path, `declares ${cells} cells; limit is ${limits.maxCellsPerSource}`);
  const names = new Set(schema.fields.map((field) => field.name));
  const keys = new Map<string, number>();
  return Object.freeze(rows.map((entry, index) => {
    const rowPath = indexPath(path, index);
    const object = record(entry, rowPath, "CUT_TABLE_ROW_TYPE");
    assertSafeDataProperties(object, rowPath, "CUT_TABLE_ROW_TYPE");
    for (const name of Object.keys(object)) {
      if (!names.has(name)) fail("CUT_TABLE_ROW_FIELD", childPath(rowPath, name), `unknown row field ${boundedDiagnosticString(name)}`);
    }
    const decoded: Record<string, CutTableCell> = Object.create(null) as Record<string, CutTableCell>;
    for (const field of schema.fields) {
      const cellPath = childPath(rowPath, field.name);
      if (!Object.hasOwn(object, field.name)) fail("CUT_TABLE_ROW_FIELD", cellPath, "required schema field is missing");
      decoded[field.name] = decodeCell(object[field.name], field.type, cellPath, limits);
    }
    const frozen = Object.freeze(decoded);
    const identity = cutTableRowKeyIdentity(schema, frozen);
    const previous = keys.get(identity);
    if (previous !== undefined) {
      fail(
        "CUT_TABLE_ROW_DUPLICATE_KEY",
        childPath(rowPath, schema.key[0]),
        `composite key duplicates row ${previous}; keys are type-tagged in schema key order`,
      );
    }
    keys.set(identity, index);
    return frozen;
  }));
}

function validateLockedInput(value: unknown, path: string, limits: CutTableQueryLimits) {
  const input = closed(value, path, ["resource", "bytes"], [], "CUT_TABLE_RESOURCE_TYPE");
  const resourcePath = childPath(path, "resource");
  const rawResource = closed(
    input.resource,
    resourcePath,
    ["id", "kind", "state", "lockVersion", "sha256", "bytes"],
    [],
    "CUT_TABLE_RESOURCE_TYPE",
  );
  const id = identifier(rawResource.id, childPath(resourcePath, "id"), "CUT_TABLE_RESOURCE_TYPE");
  if (rawResource.kind !== "data") fail("CUT_TABLE_RESOURCE_STATE", childPath(resourcePath, "kind"), "must be a DataAsset resource");
  if (rawResource.state !== "locked") fail("CUT_TABLE_RESOURCE_STATE", childPath(resourcePath, "state"), "must be locked before table bytes can be read");
  if (rawResource.lockVersion !== 2) fail("CUT_TABLE_RESOURCE_STATE", childPath(resourcePath, "lockVersion"), "requires validated cut.lock v3 state");
  const sha256 = digest(rawResource.sha256, childPath(resourcePath, "sha256"), "CUT_TABLE_RESOURCE_STATE");
  const declaredBytes = safeInteger(rawResource.bytes, childPath(resourcePath, "bytes"), 1, limits.maxInputBytes, "CUT_TABLE_RESOURCE_LIMIT");
  const suppliedBytes = input.bytes;
  const directBytes = !nodeTypes.isProxy(suppliedBytes)
    && ((Buffer.isBuffer(suppliedBytes) && Object.getPrototypeOf(suppliedBytes) === Buffer.prototype)
      || (suppliedBytes instanceof Uint8Array && Object.getPrototypeOf(suppliedBytes) === Uint8Array.prototype));
  if (!directBytes) {
    fail("CUT_TABLE_RESOURCE_TYPE", childPath(path, "bytes"), "must be a direct ordinary Uint8Array or Buffer containing already locked bytes");
  }
  const ordinaryBytes = suppliedBytes as Uint8Array;
  if (typeof SharedArrayBuffer !== "undefined" && ordinaryBytes.buffer instanceof SharedArrayBuffer) {
    fail("CUT_TABLE_RESOURCE_TYPE", childPath(path, "bytes"), "SharedArrayBuffer-backed bytes are forbidden because locked hash/parse input must be immutable during evaluation");
  }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(ordinaryBytes); }
  catch { fail("CUT_TABLE_RESOURCE_TYPE", childPath(path, "bytes"), "must have an attached ordinary ArrayBuffer that can be snapshotted"); }
  if (bytes.byteLength !== declaredBytes) {
    fail("CUT_TABLE_RESOURCE_INTEGRITY", childPath(path, "bytes"), `actual byte length ${bytes.byteLength} does not match locked length ${declaredBytes}`);
  }
  const resource: CutLockedTableResource = Object.freeze({ id, kind: "data", state: "locked", lockVersion: 2, sha256, bytes: declaredBytes });
  return { resource, bytes };
}

function loadValidatedTable(input: ReturnType<typeof validateLockedInput>, path: string, context: ValidationContext): CutSourceTable {
  const actualHash = createHash("sha256").update(input.bytes).digest("hex");
  if (actualHash !== input.resource.sha256) {
    fail("CUT_TABLE_RESOURCE_INTEGRITY", childPath(childPath(path, "resource"), "sha256"), "locked table byte digest does not match the supplied bytes");
  }
  const tablePath = childPath(path, "table");
  const decoded = parseStrictJson(input.bytes, tablePath, context);
  const document = closed(decoded, tablePath, ["format", "version", "schema", "rows"], [], "CUT_TABLE_UNKNOWN_FIELD");
  if (document.format !== "cut-table" || document.version !== 1) {
    fail("CUT_TABLE_FORMAT", tablePath, "requires strict cut-table version 1");
  }
  const schema = decodeSchema(document.schema, childPath(tablePath, "schema"), context.limits);
  const rows = decodeRows(document.rows, schema, childPath(tablePath, "rows"), context.limits);
  const schemaId = schemaIdentity(schema);
  const identity = {
    format: "cut-source-table-identity",
    version: 1,
    resource: input.resource,
    schemaId,
    schema,
    rows,
  };
  return deepFreeze({
    format: "cut-source-table" as const,
    version: 1 as const,
    id: hash(identity),
    schemaId,
    resource: input.resource,
    schema,
    rows,
  });
}

/**
 * Load one strict cut-table v1 only after the caller supplies cut.lock v3 state
 * and exact bytes. This is the resource/runtime boundary; it is intentionally
 * not a compiler helper.
 */
export function loadCutTableFromLockedResource(
  input: unknown,
  options: Readonly<{ limits?: Partial<CutTableQueryLimits> }> = {},
) {
  const limits = resolveLimits(options.limits ?? {});
  const context = validationContext(limits);
  return loadValidatedTable(validateLockedInput(input, "$", limits), "$", context);
}

type TableDescriptor = Readonly<{ kind: "table"; schema: CutTableSchema }>;
type GroupDescriptor = Readonly<{
  kind: "group";
  schema: CutTableSchema;
  by: CutQueryGroupStep["by"];
}>;
type SeriesDescriptor = Readonly<{ kind: "series"; schema: CutQuerySeriesSchema }>;
type RelationDescriptor = TableDescriptor | GroupDescriptor | SeriesDescriptor;

function planObject(value: unknown, path: string, required: readonly string[]) {
  record(value, path, "CUT_QUERY_PLAN_TYPE");
  return closed(value, path, required, [], "CUT_QUERY_PLAN_UNKNOWN_FIELD");
}

function planArray(value: unknown, path: string) {
  return array(value, path, "CUT_QUERY_PLAN_TYPE");
}

function planIdentifier(value: unknown, path: string) {
  return identifier(value, path, "CUT_QUERY_PLAN_NAME");
}

function exactEnum<T extends string>(value: unknown, path: string, allowed: readonly T[], code: CutTableQueryErrorCode): T {
  const result = exactString(value, path, code);
  if (!allowed.includes(result as T)) fail(code, path, `must be one of ${allowed.join(", ")}`);
  return result as T;
}

function requireRelation(
  relations: ReadonlyMap<string, RelationDescriptor>,
  value: unknown,
  path: string,
): [string, RelationDescriptor] {
  const name = planIdentifier(value, path);
  const relation = relations.get(name);
  if (!relation) fail("CUT_QUERY_PLAN_REFERENCE", path, `must reference an earlier source or step; ${boundedDiagnosticString(name)} is unavailable`);
  return [name, relation];
}

function requireTable(
  relations: ReadonlyMap<string, RelationDescriptor>,
  value: unknown,
  path: string,
): [string, TableDescriptor] {
  const [name, relation] = requireRelation(relations, value, path);
  if (relation.kind !== "table") fail("CUT_QUERY_PLAN_TYPE_ERROR", path, `${boundedDiagnosticString(name)} is ${relation.kind}, not a table`);
  return [name, relation];
}

function requireField(schema: CutTableSchema, value: unknown, path: string) {
  const name = planIdentifier(value, path);
  const field = schema.fields.find((candidate) => candidate.name === name);
  if (!field) fail("CUT_QUERY_PLAN_FIELD", path, `unknown field ${boundedDiagnosticString(name)}`);
  return field;
}

function sameValueType(left: CutTableFieldType, right: CutTableFieldType) {
  return left.kind === right.kind;
}

function decodePredicate(
  value: unknown,
  schema: CutTableSchema,
  path: string,
  context: ValidationContext,
): CutQueryPredicate {
  context.predicateNodes += 1;
  if (context.predicateNodes > context.limits.maxPredicateNodes) {
    fail("CUT_QUERY_PLAN_LIMIT", path, `filter predicates exceed maxPredicateNodes=${context.limits.maxPredicateNodes}`);
  }
  const preliminary = record(value, path, "CUT_QUERY_PLAN_TYPE");
  assertSafeDataProperties(preliminary, path, "CUT_QUERY_PLAN_TYPE");
  const op = exactString(preliminary.op, childPath(path, "op"), "CUT_QUERY_PLAN_TYPE");
  if (op === "compare") {
    const object = planObject(preliminary, path, ["op", "field", "operator", "value"]);
    const field = requireField(schema, object.field, childPath(path, "field"));
    const operator = exactEnum(
      object.operator,
      childPath(path, "operator"),
      ["eq", "ne", "lt", "lte", "gt", "gte"] as const,
      "CUT_QUERY_PLAN_TYPE",
    );
    if (field.type.kind === "boolean" && operator !== "eq" && operator !== "ne") {
      fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(path, "operator"), "Boolean fields support only eq and ne comparisons");
    }
    return deepFreeze({
      op,
      field: field.name,
      operator,
      value: decodeCell(object.value, field.type, childPath(path, "value"), context.limits),
    });
  }
  if (op === "and" || op === "or") {
    const object = planObject(preliminary, path, ["op", "items"]);
    const values = planArray(object.items, childPath(path, "items"));
    if (values.length < 1) fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(path, "items"), `${op} requires at least one predicate`);
    return deepFreeze({
      op,
      items: values.map((item, index) => decodePredicate(item, schema, indexPath(childPath(path, "items"), index), context)),
    });
  }
  if (op === "not") {
    const object = planObject(preliminary, path, ["op", "item"]);
    return deepFreeze({ op, item: decodePredicate(object.item, schema, childPath(path, "item"), context) });
  }
  fail("CUT_QUERY_PLAN_TYPE", childPath(path, "op"), "must be compare, and, or, or not");
}

function uniqueAlias(
  seen: Set<string>,
  value: unknown,
  path: string,
  existing: ReadonlySet<string> = new Set(),
) {
  const alias = planIdentifier(value, path);
  if (seen.has(alias) || existing.has(alias)) {
    fail("CUT_QUERY_SCHEMA_CONFLICT", path, `output field ${boundedDiagnosticString(alias)} conflicts with an earlier field`);
  }
  seen.add(alias);
  return alias;
}

function decodeFilterStep(
  object: JsonRecord,
  path: string,
  id: string,
  relations: ReadonlyMap<string, RelationDescriptor>,
  context: ValidationContext,
): [CutQueryFilterStep, TableDescriptor] {
  const closedStep = planObject(object, path, ["id", "op", "input", "where"]);
  const [input, relation] = requireTable(relations, closedStep.input, childPath(path, "input"));
  return [
    deepFreeze({ id, op: "filter" as const, input, where: decodePredicate(closedStep.where, relation.schema, childPath(path, "where"), context) }),
    relation,
  ];
}

function decodeJoinStep(
  object: JsonRecord,
  path: string,
  id: string,
  relations: ReadonlyMap<string, RelationDescriptor>,
  limits: CutTableQueryLimits,
): [CutQueryJoinStep, TableDescriptor] {
  const step = planObject(object, path, ["id", "op", "left", "right", "on", "select", "key"]);
  const [left, leftRelation] = requireTable(relations, step.left, childPath(path, "left"));
  const [right, rightRelation] = requireTable(relations, step.right, childPath(path, "right"));
  const onValues = planArray(step.on, childPath(path, "on"));
  if (onValues.length < 1 || onValues.length > limits.maxFields) {
    fail("CUT_QUERY_PLAN_LIMIT", childPath(path, "on"), `must contain 1..${limits.maxFields} equi-join pairs`);
  }
  const onSeen = new Set<string>();
  const on = onValues.map((entry, index) => {
    const itemPath = indexPath(childPath(path, "on"), index);
    const item = planObject(entry, itemPath, ["left", "right"]);
    const leftField = requireField(leftRelation.schema, item.left, childPath(itemPath, "left"));
    const rightField = requireField(rightRelation.schema, item.right, childPath(itemPath, "right"));
    if (!sameValueType(leftField.type, rightField.type)) {
      fail(
        "CUT_QUERY_PLAN_TYPE_ERROR",
        childPath(itemPath, "right"),
        `join fields have incompatible types ${leftField.type.kind} and ${rightField.type.kind}`,
      );
    }
    const identity = JSON.stringify([leftField.name, rightField.name]);
    if (onSeen.has(identity)) fail("CUT_QUERY_PLAN_DUPLICATE", itemPath, "duplicate join field pair");
    onSeen.add(identity);
    return Object.freeze({ left: leftField.name, right: rightField.name });
  });
  const selectValues = planArray(step.select, childPath(path, "select"));
  if (selectValues.length < 1 || selectValues.length > limits.maxFields) {
    fail("CUT_QUERY_PLAN_LIMIT", childPath(path, "select"), `must project 1..${limits.maxFields} fields`);
  }
  const aliases = new Set<string>();
  const fields: CutTableField[] = [];
  const select = selectValues.map((entry, index) => {
    const itemPath = indexPath(childPath(path, "select"), index);
    const item = planObject(entry, itemPath, ["from", "field", "as"]);
    const from = exactEnum(item.from, childPath(itemPath, "from"), ["left", "right"] as const, "CUT_QUERY_PLAN_TYPE");
    const sourceSchema = from === "left" ? leftRelation.schema : rightRelation.schema;
    const field = requireField(sourceSchema, item.field, childPath(itemPath, "field"));
    const as = uniqueAlias(aliases, item.as, childPath(itemPath, "as"));
    fields.push(Object.freeze({ name: as, type: field.type }));
    return Object.freeze({ from, field: field.name, as });
  });
  const keyValues = planArray(step.key, childPath(path, "key"));
  if (keyValues.length < 1 || keyValues.length > fields.length) {
    fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(path, "key"), "join output key must name at least one projected field");
  }
  const keySeen = new Set<string>();
  const key = keyValues.map((entry, index) => {
    const keyPath = indexPath(childPath(path, "key"), index);
    const name = planIdentifier(entry, keyPath);
    if (!aliases.has(name)) fail("CUT_QUERY_PLAN_FIELD", keyPath, `join key ${boundedDiagnosticString(name)} is not projected`);
    if (keySeen.has(name)) fail("CUT_QUERY_PLAN_DUPLICATE", keyPath, `duplicate join key field ${boundedDiagnosticString(name)}`);
    keySeen.add(name);
    return name;
  });
  const schema = deepFreeze({ fields, key });
  return [deepFreeze({ id, op: "inner-join" as const, left, right, on, select, key }), Object.freeze({ kind: "table", schema })];
}

function decodeGroupStep(
  object: JsonRecord,
  path: string,
  id: string,
  relations: ReadonlyMap<string, RelationDescriptor>,
  limits: CutTableQueryLimits,
): [CutQueryGroupStep, GroupDescriptor] {
  const step = planObject(object, path, ["id", "op", "input", "by"]);
  const [input, relation] = requireTable(relations, step.input, childPath(path, "input"));
  const byValues = planArray(step.by, childPath(path, "by"));
  if (byValues.length < 1 || byValues.length > limits.maxFields) {
    fail("CUT_QUERY_PLAN_LIMIT", childPath(path, "by"), `must contain 1..${limits.maxFields} group fields`);
  }
  const aliases = new Set<string>(), inputs = new Set<string>();
  const by = byValues.map((entry, index) => {
    const itemPath = indexPath(childPath(path, "by"), index);
    const item = planObject(entry, itemPath, ["field", "as"]);
    const field = requireField(relation.schema, item.field, childPath(itemPath, "field"));
    if (inputs.has(field.name)) fail("CUT_QUERY_PLAN_DUPLICATE", childPath(itemPath, "field"), "group field is repeated");
    inputs.add(field.name);
    return Object.freeze({ field: field.name, as: uniqueAlias(aliases, item.as, childPath(itemPath, "as")) });
  });
  const canonical = deepFreeze({ id, op: "group" as const, input, by });
  return [canonical, Object.freeze({ kind: "group", schema: relation.schema, by })];
}

function decodeAggregateStep(
  object: JsonRecord,
  path: string,
  id: string,
  relations: ReadonlyMap<string, RelationDescriptor>,
  limits: CutTableQueryLimits,
): [CutQueryAggregateStep, TableDescriptor] {
  const step = planObject(object, path, ["id", "op", "input", "values"]);
  const [input, relation] = requireRelation(relations, step.input, childPath(path, "input"));
  if (relation.kind !== "group") fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(path, "input"), "aggregate input must be a group step");
  const sourceFields = fieldMap(relation.schema);
  const groupNames = new Set(relation.by.map((item) => item.as));
  const outputFields: CutTableField[] = relation.by.map((item) => {
    const field = sourceFields.get(item.field)!;
    return Object.freeze({ name: item.as, type: field.type });
  });
  const values = planArray(step.values, childPath(path, "values"));
  if (values.length < 1 || values.length + outputFields.length > limits.maxFields) {
    fail("CUT_QUERY_PLAN_LIMIT", childPath(path, "values"), `aggregate output must contain at most ${limits.maxFields} fields and at least one value`);
  }
  const aliases = new Set<string>();
  const aggregates: CutQueryAggregate[] = values.map((entry, index) => {
    const itemPath = indexPath(childPath(path, "values"), index);
    const preliminary = record(entry, itemPath, "CUT_QUERY_PLAN_TYPE");
    assertSafeDataProperties(preliminary, itemPath, "CUT_QUERY_PLAN_TYPE");
    const function_ = exactEnum(
      preliminary.function,
      childPath(itemPath, "function"),
      ["count", "sum", "mean", "min", "max"] as const,
      "CUT_QUERY_PLAN_TYPE",
    );
    const item = planObject(preliminary, itemPath, function_ === "count" ? ["as", "function"] : ["as", "function", "field"]);
    const as = uniqueAlias(aliases, item.as, childPath(itemPath, "as"), groupNames);
    if (function_ === "count") {
      outputFields.push(Object.freeze({ name: as, type: Object.freeze({ kind: "number" }) }));
      return Object.freeze({ as, function: function_ });
    }
    const field = requireField(relation.schema, item.field, childPath(itemPath, "field"));
    if ((function_ === "sum" || function_ === "mean") && field.type.kind !== "number") {
      fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(itemPath, "field"), `${function_} requires an exact number field`);
    }
    if ((function_ === "min" || function_ === "max") && field.type.kind === "boolean") {
      fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(itemPath, "field"), `${function_} does not order Boolean fields`);
    }
    const type: CutTableFieldType = function_ === "sum" || function_ === "mean"
      ? Object.freeze({ kind: "number" })
      : field.type;
    outputFields.push(Object.freeze({ name: as, type }));
    return Object.freeze({ as, function: function_, field: field.name });
  });
  const schema = deepFreeze({ fields: outputFields, key: relation.by.map((item) => item.as) });
  return [deepFreeze({ id, op: "aggregate" as const, input, values: aggregates }), Object.freeze({ kind: "table", schema })];
}

function decodeSortStep(
  object: JsonRecord,
  path: string,
  id: string,
  relations: ReadonlyMap<string, RelationDescriptor>,
  limits: CutTableQueryLimits,
): [CutQuerySortStep, TableDescriptor] {
  const step = planObject(object, path, ["id", "op", "input", "by"]);
  const [input, relation] = requireTable(relations, step.input, childPath(path, "input"));
  const byValues = planArray(step.by, childPath(path, "by"));
  if (byValues.length < 1 || byValues.length > limits.maxFields) {
    fail("CUT_QUERY_PLAN_LIMIT", childPath(path, "by"), `must contain 1..${limits.maxFields} sort fields`);
  }
  const seen = new Set<string>();
  const by = byValues.map((entry, index) => {
    const itemPath = indexPath(childPath(path, "by"), index);
    const item = planObject(entry, itemPath, ["field", "direction"]);
    const field = requireField(relation.schema, item.field, childPath(itemPath, "field"));
    if (seen.has(field.name)) fail("CUT_QUERY_PLAN_DUPLICATE", childPath(itemPath, "field"), "sort field is repeated");
    seen.add(field.name);
    const direction = exactEnum(item.direction, childPath(itemPath, "direction"), ["asc", "desc"] as const, "CUT_QUERY_PLAN_TYPE");
    return Object.freeze({ field: field.name, direction });
  });
  return [deepFreeze({ id, op: "sort" as const, input, by }), relation];
}

function decodeSeriesStep(
  object: JsonRecord,
  path: string,
  id: string,
  relations: ReadonlyMap<string, RelationDescriptor>,
  limits: CutTableQueryLimits,
): [CutQuerySeriesStep, SeriesDescriptor] {
  const step = planObject(object, path, ["id", "op", "input", "x", "values"]);
  const [input, relation] = requireTable(relations, step.input, childPath(path, "input"));
  const x = requireField(relation.schema, step.x, childPath(path, "x"));
  if (x.type.kind === "boolean") fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(path, "x"), "series x field must be number, bounded string, or date");
  const valueEntries = planArray(step.values, childPath(path, "values"));
  if (valueEntries.length < 1 || valueEntries.length > limits.maxFields) {
    fail("CUT_QUERY_PLAN_LIMIT", childPath(path, "values"), `must contain 1..${limits.maxFields} numeric series fields`);
  }
  const aliases = new Set<string>();
  const values = valueEntries.map((entry, index) => {
    const itemPath = indexPath(childPath(path, "values"), index);
    const item = planObject(entry, itemPath, ["field", "as"]);
    const field = requireField(relation.schema, item.field, childPath(itemPath, "field"));
    if (field.type.kind !== "number") fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(itemPath, "field"), "series values must be exact number fields");
    return Object.freeze({ field: field.name, as: uniqueAlias(aliases, item.as, childPath(itemPath, "as")) });
  });
  const fields = fieldMap(relation.schema);
  const schema: CutQuerySeriesSchema = deepFreeze({
    key: relation.schema.key.map((name) => fields.get(name)!),
    x,
    values: values.map((item) => Object.freeze({ name: item.as, type: Object.freeze({ kind: "number" as const }) })),
  });
  return [deepFreeze({ id, op: "series" as const, input, x: x.name, values }), Object.freeze({ kind: "series", schema })];
}

function validatePlan(value: unknown, path: string, context: ValidationContext): CutCheckedTableQueryPlan {
  const document = planObject(value, path, ["format", "version", "sources", "steps", "result"]);
  if (document.format !== "cut-query-plan" || document.version !== 1) {
    fail("CUT_QUERY_PLAN_VERSION", path, "requires strict cut-query-plan version 1");
  }
  const sourceValues = planArray(document.sources, childPath(path, "sources"));
  if (sourceValues.length < 1 || sourceValues.length > context.limits.maxSources) {
    fail("CUT_QUERY_PLAN_LIMIT", childPath(path, "sources"), `must contain 1..${context.limits.maxSources} sources`);
  }
  const relations = new Map<string, RelationDescriptor>();
  const sources: CutQuerySource[] = sourceValues.map((entry, index) => {
    const sourcePath = indexPath(childPath(path, "sources"), index);
    const item = planObject(entry, sourcePath, ["name", "resourceId", "schema"]);
    const name = planIdentifier(item.name, childPath(sourcePath, "name"));
    if (relations.has(name)) fail("CUT_QUERY_PLAN_DUPLICATE", childPath(sourcePath, "name"), `duplicate source or step name ${boundedDiagnosticString(name)}`);
    const source = deepFreeze({
      name,
      resourceId: planIdentifier(item.resourceId, childPath(sourcePath, "resourceId")),
      schema: decodeSchema(item.schema, childPath(sourcePath, "schema"), context.limits),
    });
    relations.set(name, Object.freeze({ kind: "table", schema: source.schema }));
    return source;
  });
  const stepValues = planArray(document.steps, childPath(path, "steps"));
  if (stepValues.length > context.limits.maxSteps) {
    fail("CUT_QUERY_PLAN_LIMIT", childPath(path, "steps"), `contains ${stepValues.length} steps; limit is ${context.limits.maxSteps}`);
  }
  const steps: CutQueryStep[] = stepValues.map((entry, index) => {
    const stepPath = indexPath(childPath(path, "steps"), index);
    const preliminary = record(entry, stepPath, "CUT_QUERY_PLAN_TYPE");
    assertSafeDataProperties(preliminary, stepPath, "CUT_QUERY_PLAN_TYPE");
    const id = planIdentifier(preliminary.id, childPath(stepPath, "id"));
    if (relations.has(id)) fail("CUT_QUERY_PLAN_DUPLICATE", childPath(stepPath, "id"), `duplicate source or step name ${boundedDiagnosticString(id)}`);
    const op = exactString(preliminary.op, childPath(stepPath, "op"), "CUT_QUERY_PLAN_TYPE");
    let decoded: [CutQueryStep, RelationDescriptor];
    if (op === "filter") decoded = decodeFilterStep(preliminary, stepPath, id, relations, context);
    else if (op === "inner-join") decoded = decodeJoinStep(preliminary, stepPath, id, relations, context.limits);
    else if (op === "group") decoded = decodeGroupStep(preliminary, stepPath, id, relations, context.limits);
    else if (op === "aggregate") decoded = decodeAggregateStep(preliminary, stepPath, id, relations, context.limits);
    else if (op === "sort") decoded = decodeSortStep(preliminary, stepPath, id, relations, context.limits);
    else if (op === "series") decoded = decodeSeriesStep(preliminary, stepPath, id, relations, context.limits);
    else fail("CUT_QUERY_PLAN_TYPE", childPath(stepPath, "op"), "must be filter, inner-join, group, aggregate, sort, or series");
    relations.set(id, decoded[1]);
    return decoded[0];
  });
  const result = planIdentifier(document.result, childPath(path, "result"));
  const output = relations.get(result);
  if (!output) fail("CUT_QUERY_PLAN_REFERENCE", childPath(path, "result"), `unknown result relation ${boundedDiagnosticString(result)}`);
  if (output.kind === "group") fail("CUT_QUERY_PLAN_TYPE_ERROR", childPath(path, "result"), "a group is intermediate and must be consumed by aggregate");
  const plan: CutTableQueryPlan = deepFreeze({ format: "cut-query-plan", version: 1, sources, steps, result });
  const checkedOutput = output.kind === "table"
    ? Object.freeze({ kind: "table" as const, schema: output.schema, schemaId: schemaIdentity(output.schema) })
    : Object.freeze({ kind: "series" as const, schema: output.schema });
  return deepFreeze({
    format: "cut-checked-query-plan" as const,
    version: 1 as const,
    id: hash({ format: "cut-query-plan-identity", version: 1, plan }),
    plan,
    output: checkedOutput,
  });
}

/** Validate and type every plan step without reading DataAsset bytes. */
export function validateCutTableQueryPlan(
  value: unknown,
  options: Readonly<{ limits?: Partial<CutTableQueryLimits> }> = {},
) {
  const limits = resolveLimits(options.limits ?? {});
  return validatePlan(value, "$", validationContext(limits));
}

type RuntimeTable = Readonly<{
  kind: "table";
  schema: CutTableSchema;
  rows: readonly CutTableRow[];
}>;

type RuntimeGroup = Readonly<{
  kind: "group";
  schema: CutTableSchema;
  by: CutQueryGroupStep["by"];
  groups: readonly Readonly<{ rows: readonly CutTableRow[] }>[];
}>;

type RuntimeSeries = Readonly<{
  kind: "series";
  schema: CutQuerySeriesSchema;
  points: readonly CutQuerySeriesPoint[];
}>;

type RuntimeRelation = RuntimeTable | RuntimeGroup | RuntimeSeries;

function compareUtf8(left: string, right: string) {
  const leftBytes = utf8Encoder.encode(left), rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] < rightBytes[index]) return -1;
    if (leftBytes[index] > rightBytes[index]) return 1;
  }
  return leftBytes.length < rightBytes.length ? -1 : leftBytes.length > rightBytes.length ? 1 : 0;
}

function compareCells(type: CutTableFieldType, left: CutTableCell, right: CutTableCell) {
  if (type.kind === "number") return compareRational(left as CutExactNumber, right as CutExactNumber);
  if (type.kind === "boolean") return left === right ? 0 : left === false ? -1 : 1;
  return compareUtf8(left as string, right as string);
}

function evaluatePredicate(predicate: CutQueryPredicate, schema: CutTableSchema, row: CutTableRow): boolean {
  if (predicate.op === "and" || predicate.op === "or") {
    return predicate.op === "and"
      ? predicate.items.every((item) => evaluatePredicate(item, schema, row))
      : predicate.items.some((item) => evaluatePredicate(item, schema, row));
  }
  if (predicate.op === "not") return !evaluatePredicate(predicate.item, schema, row);
  const field = schema.fields.find((candidate) => candidate.name === predicate.field)!;
  const comparison = compareCells(field.type, row[field.name], predicate.value);
  if (predicate.operator === "eq") return comparison === 0;
  if (predicate.operator === "ne") return comparison !== 0;
  if (predicate.operator === "lt") return comparison < 0;
  if (predicate.operator === "lte") return comparison <= 0;
  if (predicate.operator === "gt") return comparison > 0;
  return comparison >= 0;
}

function preflightTableShape(
  rows: number,
  schema: CutTableSchema,
  path: string,
  limits: CutTableQueryLimits,
  rowLimit = limits.maxResultRows,
) {
  if (!Number.isSafeInteger(rows) || rows < 0 || rows > rowLimit) {
    fail("CUT_QUERY_CARDINALITY", path, `would produce ${rows} rows; limit is ${rowLimit}`);
  }
  const cells = BigInt(rows) * BigInt(schema.fields.length);
  if (cells > BigInt(limits.maxResultCells)) {
    fail("CUT_QUERY_CARDINALITY", path, `would produce ${cells} cells; limit is ${limits.maxResultCells}`);
  }
}

function runtimeTable(relation: RuntimeRelation | undefined, path: string): RuntimeTable {
  if (!relation) throw new Error(`Internal CUT query relation is missing at ${path}.`);
  if (relation.kind !== "table") throw new Error(`Internal CUT query relation at ${path} is ${relation.kind}, not table.`);
  return relation;
}

function runtimeGroup(relation: RuntimeRelation | undefined, path: string): RuntimeGroup {
  if (!relation) throw new Error(`Internal CUT query relation is missing at ${path}.`);
  if (relation.kind !== "group") throw new Error(`Internal CUT query relation at ${path} is ${relation.kind}, not group.`);
  return relation;
}

function joinTupleIdentity(
  schema: CutTableSchema,
  row: CutTableRow,
  names: readonly string[],
) {
  const fields = fieldMap(schema);
  return JSON.stringify(names.map((name) => typedCellIdentity(fields.get(name)!.type, row[name])));
}

function projectedJoinRow(
  step: CutQueryJoinStep,
  left: CutTableRow,
  right: CutTableRow,
) {
  const result: Record<string, CutTableCell> = Object.create(null) as Record<string, CutTableCell>;
  for (const selection of step.select) result[selection.as] = (selection.from === "left" ? left : right)[selection.field];
  return Object.freeze(result);
}

function evaluateJoin(
  step: CutQueryJoinStep,
  left: RuntimeTable,
  right: RuntimeTable,
  schema: CutTableSchema,
  path: string,
  limits: CutTableQueryLimits,
): RuntimeTable {
  const rightIndex = new Map<string, CutTableRow[]>();
  for (const row of right.rows) {
    const identity = joinTupleIdentity(right.schema, row, step.on.map((item) => item.right));
    const matches = rightIndex.get(identity);
    if (matches) matches.push(row);
    else rightIndex.set(identity, [row]);
  }

  let outputRows = 0;
  for (const row of left.rows) {
    const identity = joinTupleIdentity(left.schema, row, step.on.map((item) => item.left));
    const matches = rightIndex.get(identity)?.length ?? 0;
    if (outputRows > limits.maxJoinRows - matches) {
      fail("CUT_QUERY_CARDINALITY", path, `inner join exceeds maxJoinRows=${limits.maxJoinRows} before output row allocation`);
    }
    outputRows += matches;
  }
  preflightTableShape(outputRows, schema, path, limits, Math.min(limits.maxJoinRows, limits.maxResultRows));

  const keys = new Map<string, number>();
  let outputIndex = 0;
  for (const leftRow of left.rows) {
    const identity = joinTupleIdentity(left.schema, leftRow, step.on.map((item) => item.left));
    for (const rightRow of rightIndex.get(identity) ?? []) {
      const row = projectedJoinRow(step, leftRow, rightRow);
      const key = cutTableRowKeyIdentity(schema, row);
      const previous = keys.get(key);
      if (previous !== undefined) {
        fail(
          "CUT_QUERY_RESULT_KEY",
          childPath(indexPath(childPath(path, "rows"), outputIndex), schema.key[0]),
          `join output key duplicates row ${previous}`,
        );
      }
      keys.set(key, outputIndex);
      outputIndex += 1;
    }
  }

  const rows: CutTableRow[] = [];
  for (const leftRow of left.rows) {
    const identity = joinTupleIdentity(left.schema, leftRow, step.on.map((item) => item.left));
    for (const rightRow of rightIndex.get(identity) ?? []) rows.push(projectedJoinRow(step, leftRow, rightRow));
  }
  return deepFreeze({ kind: "table", schema, rows });
}

function evaluateGroup(
  step: CutQueryGroupStep,
  input: RuntimeTable,
  path: string,
  limits: CutTableQueryLimits,
): RuntimeGroup {
  const groupsByKey = new Map<string, CutTableRow[]>();
  const groups: Array<{ rows: CutTableRow[] }> = [];
  for (const row of input.rows) {
    const identity = joinTupleIdentity(input.schema, row, step.by.map((item) => item.field));
    let rows = groupsByKey.get(identity);
    if (!rows) {
      if (groups.length >= limits.maxGroups) {
        fail("CUT_QUERY_CARDINALITY", path, `group count exceeds maxGroups=${limits.maxGroups} before creating another group`);
      }
      rows = [];
      groupsByKey.set(identity, rows);
      groups.push({ rows });
    }
    rows.push(row);
  }
  return deepFreeze({ kind: "group", schema: input.schema, by: step.by, groups });
}

function boundedComputedNumber(value: Rational, path: string, limits: CutTableQueryLimits): CutExactNumber {
  const numeratorDigits = value.numerator.startsWith("-") ? value.numerator.length - 1 : value.numerator.length;
  if (numeratorDigits > limits.maxRationalDigits || value.denominator.length > limits.maxRationalDigits) {
    fail("CUT_QUERY_NUMERIC_LIMIT", path, `aggregate exact number exceeds maxRationalDigits=${limits.maxRationalDigits}`);
  }
  return Object.freeze({ ...value });
}

function aggregateValue(
  aggregate: CutQueryAggregate,
  group: readonly CutTableRow[],
  schema: CutTableSchema,
  path: string,
  limits: CutTableQueryLimits,
): CutTableCell {
  if (aggregate.function === "count") return Object.freeze(rational(group.length));
  const field = schema.fields.find((candidate) => candidate.name === aggregate.field)!;
  if (aggregate.function === "min" || aggregate.function === "max") {
    let selected = group[0][field.name];
    for (let index = 1; index < group.length; index += 1) {
      const candidate = group[index][field.name], comparison = compareCells(field.type, candidate, selected);
      if ((aggregate.function === "min" && comparison < 0) || (aggregate.function === "max" && comparison > 0)) selected = candidate;
    }
    return selected;
  }
  let total: Rational = zeroRational;
  for (const row of group) {
    total = boundedComputedNumber(addRational(total, row[field.name] as CutExactNumber), path, limits);
  }
  if (aggregate.function === "sum") return boundedComputedNumber(total, path, limits);
  return boundedComputedNumber(divideRational(total, rational(group.length)), path, limits);
}

function evaluateAggregate(
  step: CutQueryAggregateStep,
  input: RuntimeGroup,
  schema: CutTableSchema,
  path: string,
  limits: CutTableQueryLimits,
): RuntimeTable {
  preflightTableShape(input.groups.length, schema, path, limits);
  const rows = input.groups.map((group, groupIndex) => {
    if (!group.rows.length) throw new Error("Internal CUT query group cannot be empty.");
    const row: Record<string, CutTableCell> = Object.create(null) as Record<string, CutTableCell>;
    for (const item of input.by) row[item.as] = group.rows[0][item.field];
    for (const [index, aggregate] of step.values.entries()) {
      row[aggregate.as] = aggregateValue(
        aggregate,
        group.rows,
        input.schema,
        childPath(indexPath(childPath(path, "groups"), groupIndex), step.values[index].as),
        limits,
      );
    }
    return Object.freeze(row);
  });
  return deepFreeze({ kind: "table", schema, rows });
}

function evaluateSort(step: CutQuerySortStep, input: RuntimeTable, path: string, limits: CutTableQueryLimits): RuntimeTable {
  preflightTableShape(input.rows.length, input.schema, path, limits);
  const fields = fieldMap(input.schema);
  const rows = input.rows.map((row, index) => ({ row, index }));
  rows.sort((left, right) => {
    for (const item of step.by) {
      const field = fields.get(item.field)!;
      const comparison = compareCells(field.type, left.row[item.field], right.row[item.field]);
      if (comparison !== 0) return item.direction === "asc" ? comparison : -comparison;
    }
    return left.index - right.index;
  });
  return deepFreeze({ kind: "table", schema: input.schema, rows: rows.map((item) => item.row) });
}

function evaluateSeries(
  step: CutQuerySeriesStep,
  input: RuntimeTable,
  schema: CutQuerySeriesSchema,
  path: string,
  limits: CutTableQueryLimits,
): RuntimeSeries {
  const cellsPerPoint = schema.key.length + 1 + schema.values.length;
  const cells = BigInt(input.rows.length) * BigInt(cellsPerPoint);
  if (input.rows.length > limits.maxResultRows || cells > BigInt(limits.maxResultCells)) {
    fail("CUT_QUERY_CARDINALITY", path, `series would produce ${input.rows.length} points / ${cells} cells beyond result limits`);
  }
  const points = input.rows.map((row) => {
    const key: Record<string, CutTableCell> = Object.create(null) as Record<string, CutTableCell>;
    for (const field of schema.key) key[field.name] = row[field.name];
    const values: Record<string, CutExactNumber> = Object.create(null) as Record<string, CutExactNumber>;
    for (const item of step.values) values[item.as] = row[item.field] as CutExactNumber;
    return deepFreeze({ key, x: row[step.x], values });
  });
  return deepFreeze({ kind: "series", schema, points });
}

function firstSchemaDifference(expected: CutTableSchema, actual: CutTableSchema, path: string): string {
  if (expected.fields.length !== actual.fields.length) return childPath(path, "fields");
  for (let index = 0; index < expected.fields.length; index += 1) {
    const expectedField = expected.fields[index], actualField = actual.fields[index];
    const fieldPath = indexPath(childPath(path, "fields"), index);
    if (expectedField.name !== actualField.name) return childPath(fieldPath, "name");
    if (expectedField.type.kind !== actualField.type.kind) return childPath(childPath(fieldPath, "type"), "kind");
    if (expectedField.type.kind === "string"
      && (actualField.type.kind !== "string" || expectedField.type.maxBytes !== actualField.type.maxBytes)) {
      return childPath(childPath(fieldPath, "type"), "maxBytes");
    }
  }
  if (expected.key.length !== actual.key.length) return childPath(path, "key");
  for (let index = 0; index < expected.key.length; index += 1) {
    if (expected.key[index] !== actual.key[index]) return indexPath(childPath(path, "key"), index);
  }
  return path;
}

function stepOutputDescriptor(checked: CutCheckedTableQueryPlan) {
  const relations = new Map<string, RelationDescriptor>();
  for (const source of checked.plan.sources) relations.set(source.name, Object.freeze({ kind: "table", schema: source.schema }));
  for (const step of checked.plan.steps) {
    if (step.op === "filter" || step.op === "sort") {
      relations.set(step.id, relations.get(step.input)!);
    } else if (step.op === "inner-join") {
      const fields = step.select.map((item) => {
        const relation = relations.get(item.from === "left" ? step.left : step.right) as TableDescriptor;
        const source = relation.schema.fields.find((field) => field.name === item.field)!;
        return Object.freeze({ name: item.as, type: source.type });
      });
      relations.set(step.id, Object.freeze({ kind: "table", schema: deepFreeze({ fields, key: step.key }) }));
    } else if (step.op === "group") {
      const relation = relations.get(step.input) as TableDescriptor;
      relations.set(step.id, Object.freeze({ kind: "group", schema: relation.schema, by: step.by }));
    } else if (step.op === "aggregate") {
      const group = relations.get(step.input) as GroupDescriptor;
      const fields = fieldMap(group.schema);
      const outputFields: CutTableField[] = group.by.map((item) => Object.freeze({ name: item.as, type: fields.get(item.field)!.type }));
      for (const value of step.values) {
        const type: CutTableFieldType = value.function === "count" || value.function === "sum" || value.function === "mean"
          ? Object.freeze({ kind: "number" })
          : fields.get(value.field)!.type;
        outputFields.push(Object.freeze({ name: value.as, type }));
      }
      relations.set(step.id, Object.freeze({ kind: "table", schema: deepFreeze({ fields: outputFields, key: group.by.map((item) => item.as) }) }));
    } else {
      const input = relations.get(step.input) as TableDescriptor;
      const fields = fieldMap(input.schema);
      relations.set(step.id, Object.freeze({
        kind: "series",
        schema: deepFreeze({
          key: input.schema.key.map((name) => fields.get(name)!),
          x: fields.get(step.x)!,
          values: step.values.map((item) => Object.freeze({ name: item.as, type: Object.freeze({ kind: "number" as const }) })),
        }),
      }));
    }
  }
  return relations;
}

/**
 * Evaluate a checked closed plan over exact locked bytes. This function is
 * intentionally data-only: a terminal series is still not a visual plot.
 */
export function evaluateCutTableQuery(
  planValue: unknown,
  inputValue: unknown,
  options: Readonly<{ limits?: Partial<CutTableQueryLimits> }> = {},
): CutEvaluatedTableQuery {
  const limits = resolveLimits(options.limits ?? {});
  const context = validationContext(limits);
  const checked = validatePlan(planValue, "$.plan", context);
  const inputEntries = array(inputValue, "$.resources", "CUT_TABLE_RESOURCE_TYPE");
  if (inputEntries.length > limits.maxSources) {
    fail("CUT_TABLE_RESOURCE_LIMIT", "$.resources", `contains ${inputEntries.length} resource inputs; limit is ${limits.maxSources}`);
  }
  const validated = new Map<string, ReturnType<typeof validateLockedInput>>();
  inputEntries.forEach((entry, index) => {
    const path = indexPath("$.resources", index);
    const item = validateLockedInput(entry, path, limits);
    if (validated.has(item.resource.id)) fail("CUT_TABLE_RESOURCE_TYPE", childPath(childPath(path, "resource"), "id"), "duplicate resource input id");
    validated.set(item.resource.id, item);
  });
  const requiredIds = new Set(checked.plan.sources.map((source) => source.resourceId));
  for (const [index, source] of checked.plan.sources.entries()) {
    if (!validated.has(source.resourceId)) {
      fail("CUT_QUERY_PLAN_REFERENCE", childPath(indexPath("$.plan.sources", index), "resourceId"), `missing locked bytes for resource ${boundedDiagnosticString(source.resourceId)}`);
    }
  }
  for (const [index, entry] of inputEntries.entries()) {
    const item = validateLockedInput(entry, indexPath("$.resources", index), limits);
    if (!requiredIds.has(item.resource.id)) {
      fail("CUT_TABLE_RESOURCE_TYPE", childPath(childPath(indexPath("$.resources", index), "resource"), "id"), "resource is not declared by this plan");
    }
  }
  let totalBytes = 0;
  for (const id of requiredIds) {
    const bytes = validated.get(id)!.resource.bytes;
    if (totalBytes > limits.maxTotalInputBytes - bytes) {
      fail("CUT_TABLE_RESOURCE_LIMIT", "$.resources", `locked inputs exceed maxTotalInputBytes=${limits.maxTotalInputBytes} before parsing`);
    }
    totalBytes += bytes;
  }

  const loaded = new Map<string, CutSourceTable>();
  for (const source of checked.plan.sources) {
    if (loaded.has(source.resourceId)) continue;
    const resourcePath = childPath("$.resourcesById", source.resourceId);
    loaded.set(source.resourceId, loadValidatedTable(validated.get(source.resourceId)!, resourcePath, context));
  }

  const runtime = new Map<string, RuntimeRelation>();
  const sourceIdentities: Array<{ name: string; tableId: string }> = [];
  for (const [index, source] of checked.plan.sources.entries()) {
    const table = loaded.get(source.resourceId)!;
    if (stableJsonStringify(source.schema) !== stableJsonStringify(table.schema)) {
      const schemaPath = childPath(indexPath("$.plan.sources", index), "schema");
      fail(
        "CUT_QUERY_SOURCE_SCHEMA",
        firstSchemaDifference(source.schema, table.schema, schemaPath),
        `declared schema ${schemaIdentity(source.schema)} does not exactly match locked table schema ${table.schemaId}`,
      );
    }
    runtime.set(source.name, Object.freeze({ kind: "table", schema: table.schema, rows: table.rows }));
    sourceIdentities.push(Object.freeze({ name: source.name, tableId: table.id }));
  }

  const descriptors = stepOutputDescriptor(checked);
  checked.plan.steps.forEach((step, index) => {
    const path = indexPath("$.plan.steps", index);
    if (step.op === "filter") {
      const input = runtimeTable(runtime.get(step.input), path);
      let matches = 0;
      for (const row of input.rows) if (evaluatePredicate(step.where, input.schema, row)) matches += 1;
      preflightTableShape(matches, input.schema, path, limits);
      const rows = input.rows.filter((row) => evaluatePredicate(step.where, input.schema, row));
      runtime.set(step.id, deepFreeze({ kind: "table", schema: input.schema, rows }));
    } else if (step.op === "inner-join") {
      const descriptor = descriptors.get(step.id) as TableDescriptor;
      runtime.set(step.id, evaluateJoin(
        step,
        runtimeTable(runtime.get(step.left), path),
        runtimeTable(runtime.get(step.right), path),
        descriptor.schema,
        path,
        limits,
      ));
    } else if (step.op === "group") {
      runtime.set(step.id, evaluateGroup(step, runtimeTable(runtime.get(step.input), path), path, limits));
    } else if (step.op === "aggregate") {
      const descriptor = descriptors.get(step.id) as TableDescriptor;
      runtime.set(step.id, evaluateAggregate(step, runtimeGroup(runtime.get(step.input), path), descriptor.schema, path, limits));
    } else if (step.op === "sort") {
      runtime.set(step.id, evaluateSort(step, runtimeTable(runtime.get(step.input), path), path, limits));
    } else {
      const descriptor = descriptors.get(step.id) as SeriesDescriptor;
      runtime.set(step.id, evaluateSeries(step, runtimeTable(runtime.get(step.input), path), descriptor.schema, path, limits));
    }
  });

  const result = runtime.get(checked.plan.result);
  if (!result || result.kind === "group") throw new Error("Internal CUT checked query result is unavailable or intermediate.");
  if (result.kind === "table") {
    const schemaId = schemaIdentity(result.schema);
    const identity = {
      format: "cut-query-result-identity",
      version: 1,
      kind: "table",
      planId: checked.id,
      sources: sourceIdentities,
      schemaId,
      schema: result.schema,
      rows: result.rows,
    };
    return deepFreeze({
      format: "cut-query-result",
      version: 1,
      kind: "table",
      id: hash(identity),
      planId: checked.id,
      sources: sourceIdentities,
      schemaId,
      schema: result.schema,
      rows: result.rows,
    });
  }
  const identity = {
    format: "cut-query-result-identity",
    version: 1,
    kind: "series",
    planId: checked.id,
    sources: sourceIdentities,
    schema: result.schema,
    points: result.points,
  };
  return deepFreeze({
    format: "cut-query-result",
    version: 1,
    kind: "series",
    id: hash(identity),
    planId: checked.id,
    sources: sourceIdentities,
    schema: result.schema,
    points: result.points,
  });
}
