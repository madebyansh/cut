import { boundedDiagnosticString, hash } from "../core/stable";
import type { IRProvenance, CutAVIR } from "../language/ir";

export const cutInterchangeBackendFormat = "cut-interchange-backend" as const;
export const cutInterchangeBackendVersion = 1 as const;
export const cutInterchangeSourceMeaning = "cut-av-ir-v3-editorial" as const;

export type CutInterchangeBackendDescriptor<
  Id extends string = string,
  ReportFormat extends string = string,
> = Readonly<{
  format: typeof cutInterchangeBackendFormat;
  version: typeof cutInterchangeBackendVersion;
  id: Id;
  implementation: string;
  target: string;
  direction: "export";
  sourceMeaning: typeof cutInterchangeSourceMeaning;
  artifact: Readonly<{
    mediaType: string;
    extension: string;
  }>;
  report: Readonly<{
    format: ReportFormat;
    version: number;
  }>;
}>;

export type CutInterchangeBackendReportIdentity<Id extends string = string> = Readonly<{
  id: Id;
  implementation: string;
  sourceMeaning: typeof cutInterchangeSourceMeaning;
}>;

export type CutInterchangeLoss = Readonly<{
  code: string;
  category: string;
  disposition: "omitted" | "partial" | "flattened" | "metadata-only";
  subject: Readonly<{
    kind: string;
    id: string;
    op?: string;
    property?: string;
  }>;
  message: string;
  provenance?: IRProvenance;
  evidence?: Readonly<{
    inputKind: string;
    value?: string;
  }>;
}>;

/**
 * The common report law every editorial export backend must satisfy.
 *
 * A backend may add target-specific fields, but cannot rename the loss array,
 * hide a lossy status, or publish a report for a different CUT build or
 * composition. This keeps loss handling target-independent.
 */
export type CutInterchangeLossReport<
  Format extends string = string,
  BackendId extends string = string,
> = Readonly<{
  format: Format;
  version: number;
  backend: CutInterchangeBackendReportIdentity<BackendId>;
  source: Readonly<{
    buildId: string;
    compositionId: string;
  }>;
  status: "lossless-editorial" | "lossy-editorial";
  unsupportedSemantics: ReadonlyArray<CutInterchangeLoss>;
}>;

export type CutInterchangeEditorialSource = Readonly<{
  format: "cut-interchange-editorial-source";
  version: 1;
  meaning: typeof cutInterchangeSourceMeaning;
  ir: Readonly<CutAVIR>;
  selection: Readonly<{
    composition: string | null;
  }>;
  identity: Readonly<{
    buildId: string;
    semanticSha256: string;
  }>;
}>;

export type CutInterchangeBackendResult<
  Artifact,
  Report extends CutInterchangeLossReport,
> = Readonly<{
  artifact: Artifact;
  report: Report;
}>;

export type CutInterchangeExportBackend<
  Options,
  Artifact,
  Report extends CutInterchangeLossReport,
  Id extends string = string,
> = Readonly<{
  descriptor: CutInterchangeBackendDescriptor<Id, Report["format"]>;
  exportEditorial(
    source: CutInterchangeEditorialSource,
    options: Readonly<Options>,
  ): CutInterchangeBackendResult<Artifact, Report>;
}>;

export type CutInterchangeExecutionReceipt<Id extends string = string> = Readonly<{
  format: "cut-interchange-backend-execution";
  version: 1;
  backend: CutInterchangeBackendReportIdentity<Id>;
  source: Readonly<{
    buildId: string;
    semanticSha256: string;
    compositionId: string;
  }>;
  status: "lossless-editorial" | "lossy-editorial";
  unsupportedSemanticCount: number;
}>;

export type CutInterchangeDispatchResult<
  Artifact,
  Report extends CutInterchangeLossReport,
  Id extends string = string,
> = CutInterchangeBackendResult<Artifact, Report> & Readonly<{
  execution: CutInterchangeExecutionReceipt<Id>;
}>;

export type CutInterchangeBackendErrorCode =
  | "CUT_INTERCHANGE_BACKEND_DESCRIPTOR"
  | "CUT_INTERCHANGE_BACKEND_DUPLICATE"
  | "CUT_INTERCHANGE_BACKEND_NOT_FOUND"
  | "CUT_INTERCHANGE_BACKEND_IR"
  | "CUT_INTERCHANGE_BACKEND_EXECUTION"
  | "CUT_INTERCHANGE_BACKEND_MUTATION"
  | "CUT_INTERCHANGE_BACKEND_RESULT"
  | "CUT_INTERCHANGE_BACKEND_REPORT";

export class CutInterchangeBackendError extends Error {
  constructor(
    readonly code: CutInterchangeBackendErrorCode,
    message: string,
    readonly backendId?: string,
    readonly causeValue?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = "CutInterchangeBackendError";
  }
}

type JsonRecord = Record<string, unknown>;
type AnyInterchangeBackend = CutInterchangeExportBackend<
  unknown,
  unknown,
  CutInterchangeLossReport,
  string
>;

const backendIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const implementationPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._@/+:-]{0,254}[A-Za-z0-9])?$/u;
const mediaTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const extensionPattern = /^\.[a-z0-9][a-z0-9._-]{0,31}$/u;
const diagnosticCodePattern = /^CUT_[A-Z0-9_]+$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumLosses = 100_000;
const maximumDiagnosticUtf8Bytes = 1024 * 1024;

function fail(
  code: CutInterchangeBackendErrorCode,
  message: string,
  backendId?: string,
  causeValue?: unknown,
): never {
  throw new CutInterchangeBackendError(code, message, backendId, causeValue);
}

function dataRecord(
  value: unknown,
  label: string,
  code: CutInterchangeBackendErrorCode,
  backendId?: string,
): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be a plain data object.`, backendId);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must have a plain or null prototype.`, backendId);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(code, `${label} cannot contain symbol keys.`, backendId);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(code, `${label}.${key} must be an enumerable data property.`, backendId);
    }
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
  code: CutInterchangeBackendErrorCode,
  backendId?: string,
) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    fail(code, `${label} must contain exactly ${canonical.join(", ")}.`, backendId);
  }
}

function boundedString(
  value: unknown,
  label: string,
  code: CutInterchangeBackendErrorCode,
  backendId?: string,
) {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${label} must be a non-empty string.`, backendId);
  }
  if (Buffer.byteLength(value, "utf8") > maximumDiagnosticUtf8Bytes) {
    fail(code, `${label} exceeds the ${maximumDiagnosticUtf8Bytes}-byte boundary.`, backendId);
  }
  return value;
}

export function validateCutInterchangeBackendDescriptor<
  Id extends string,
  ReportFormat extends string,
>(
  value: CutInterchangeBackendDescriptor<Id, ReportFormat>,
): CutInterchangeBackendDescriptor<Id, ReportFormat> {
  const descriptor = dataRecord(value, "interchange backend descriptor", "CUT_INTERCHANGE_BACKEND_DESCRIPTOR");
  exactKeys(
    descriptor,
    ["format", "version", "id", "implementation", "target", "direction", "sourceMeaning", "artifact", "report"],
    "interchange backend descriptor",
    "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
  );
  if (descriptor.format !== cutInterchangeBackendFormat || descriptor.version !== cutInterchangeBackendVersion) {
    fail(
      "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
      `interchange backend descriptor must be ${cutInterchangeBackendFormat} v${cutInterchangeBackendVersion}.`,
    );
  }
  const id = boundedString(descriptor.id, "interchange backend id", "CUT_INTERCHANGE_BACKEND_DESCRIPTOR");
  if (!backendIdPattern.test(id)) {
    fail("CUT_INTERCHANGE_BACKEND_DESCRIPTOR", `interchange backend id ${boundedDiagnosticString(id)} is not canonical.`, id);
  }
  const implementation = boundedString(
    descriptor.implementation,
    "interchange backend implementation",
    "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
    id,
  );
  if (!implementationPattern.test(implementation)) {
    fail("CUT_INTERCHANGE_BACKEND_DESCRIPTOR", "interchange backend implementation is not canonical.", id);
  }
  boundedString(descriptor.target, "interchange backend target", "CUT_INTERCHANGE_BACKEND_DESCRIPTOR", id);
  if (descriptor.direction !== "export" || descriptor.sourceMeaning !== cutInterchangeSourceMeaning) {
    fail(
      "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
      `interchange backend must export ${cutInterchangeSourceMeaning}.`,
      id,
    );
  }
  const artifact = dataRecord(
    descriptor.artifact,
    "interchange backend artifact descriptor",
    "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
    id,
  );
  exactKeys(
    artifact,
    ["mediaType", "extension"],
    "interchange backend artifact descriptor",
    "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
    id,
  );
  const mediaType = boundedString(
    artifact.mediaType,
    "interchange backend artifact mediaType",
    "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
    id,
  );
  const extension = boundedString(
    artifact.extension,
    "interchange backend artifact extension",
    "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
    id,
  );
  if (!mediaTypePattern.test(mediaType) || !extensionPattern.test(extension)) {
    fail("CUT_INTERCHANGE_BACKEND_DESCRIPTOR", "interchange backend artifact mediaType or extension is not canonical.", id);
  }
  const report = dataRecord(
    descriptor.report,
    "interchange backend report descriptor",
    "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
    id,
  );
  exactKeys(
    report,
    ["format", "version"],
    "interchange backend report descriptor",
    "CUT_INTERCHANGE_BACKEND_DESCRIPTOR",
    id,
  );
  boundedString(report.format, "interchange backend report format", "CUT_INTERCHANGE_BACKEND_DESCRIPTOR", id);
  if (!Number.isSafeInteger(report.version) || (report.version as number) < 1) {
    fail("CUT_INTERCHANGE_BACKEND_DESCRIPTOR", "interchange backend report version must be a positive safe integer.", id);
  }
  return value;
}

export function cutInterchangeBackendReportIdentity<Id extends string>(
  descriptor: CutInterchangeBackendDescriptor<Id>,
): CutInterchangeBackendReportIdentity<Id> {
  validateCutInterchangeBackendDescriptor(descriptor);
  return Object.freeze({
    id: descriptor.id,
    implementation: descriptor.implementation,
    sourceMeaning: descriptor.sourceMeaning,
  });
}

export function defineCutInterchangeExportBackend<
  Options,
  Artifact,
  Report extends CutInterchangeLossReport,
  Id extends string,
>(
  backend: CutInterchangeExportBackend<Options, Artifact, Report, Id>,
): CutInterchangeExportBackend<Options, Artifact, Report, Id> {
  const record = dataRecord(backend, "interchange backend", "CUT_INTERCHANGE_BACKEND_DESCRIPTOR");
  exactKeys(record, ["descriptor", "exportEditorial"], "interchange backend", "CUT_INTERCHANGE_BACKEND_DESCRIPTOR");
  const descriptor = validateCutInterchangeBackendDescriptor(backend.descriptor);
  if (typeof backend.exportEditorial !== "function") {
    fail("CUT_INTERCHANGE_BACKEND_DESCRIPTOR", "interchange backend exportEditorial must be a function.", descriptor.id);
  }
  return Object.freeze({
    descriptor: Object.freeze({
      ...descriptor,
      artifact: Object.freeze({ ...descriptor.artifact }),
      report: Object.freeze({ ...descriptor.report }),
    }),
    exportEditorial: backend.exportEditorial,
  }) as CutInterchangeExportBackend<Options, Artifact, Report, Id>;
}

export class CutInterchangeBackendRegistry {
  readonly #backends = new Map<string, AnyInterchangeBackend>();

  register<
    Options,
    Artifact,
    Report extends CutInterchangeLossReport,
    Id extends string,
  >(backend: CutInterchangeExportBackend<Options, Artifact, Report, Id>) {
    const descriptor = validateCutInterchangeBackendDescriptor(backend.descriptor);
    if (typeof backend.exportEditorial !== "function") {
      fail("CUT_INTERCHANGE_BACKEND_DESCRIPTOR", "interchange backend exportEditorial must be a function.", descriptor.id);
    }
    if (this.#backends.has(descriptor.id)) {
      fail("CUT_INTERCHANGE_BACKEND_DUPLICATE", `interchange backend ${boundedDiagnosticString(descriptor.id)} is already registered.`, descriptor.id);
    }
    this.#backends.set(descriptor.id, backend as unknown as AnyInterchangeBackend);
    return this;
  }

  resolve(id: string) {
    if (typeof id !== "string" || !backendIdPattern.test(id)) {
      fail("CUT_INTERCHANGE_BACKEND_NOT_FOUND", `interchange backend id ${boundedDiagnosticString(String(id))} is not canonical.`);
    }
    const backend = this.#backends.get(id);
    if (!backend) {
      fail("CUT_INTERCHANGE_BACKEND_NOT_FOUND", `interchange backend ${boundedDiagnosticString(id)} is not registered.`, id);
    }
    return backend;
  }

  descriptors() {
    return Object.freeze(
      [...this.#backends.values()]
        .map((backend) => backend.descriptor)
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }
}

function stableAdapterDiagnostic(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const code = Object.getOwnPropertyDescriptor(value, "code");
  return Boolean(code && "value" in code && typeof code.value === "string" && diagnosticCodePattern.test(code.value));
}

function validateIr(value: unknown) {
  const ir = dataRecord(value, "interchange CutAVIR", "CUT_INTERCHANGE_BACKEND_IR");
  if (ir.format !== "cut-av-ir" || ir.version !== 3) {
    fail("CUT_INTERCHANGE_BACKEND_IR", "interchange backends require CutAVIR v3.");
  }
  if (typeof ir.buildId !== "string" || !sha256Pattern.test(ir.buildId)) {
    fail("CUT_INTERCHANGE_BACKEND_IR", "interchange CutAVIR buildId must be a lowercase SHA-256 digest.");
  }
  if (!Array.isArray(ir.compositions)) {
    fail("CUT_INTERCHANGE_BACKEND_IR", "interchange CutAVIR compositions must be an array.");
  }
  return value as CutAVIR;
}

function validateLossReport(
  value: unknown,
  descriptor: CutInterchangeBackendDescriptor,
  source: CutInterchangeEditorialSource,
) {
  const report = dataRecord(value, "interchange backend report", "CUT_INTERCHANGE_BACKEND_REPORT", descriptor.id);
  if (report.format !== descriptor.report.format || report.version !== descriptor.report.version) {
    fail(
      "CUT_INTERCHANGE_BACKEND_REPORT",
      `interchange backend report must be ${descriptor.report.format} v${descriptor.report.version}.`,
      descriptor.id,
    );
  }
  const identity = dataRecord(
    report.backend,
    "interchange backend report identity",
    "CUT_INTERCHANGE_BACKEND_REPORT",
    descriptor.id,
  );
  exactKeys(
    identity,
    ["id", "implementation", "sourceMeaning"],
    "interchange backend report identity",
    "CUT_INTERCHANGE_BACKEND_REPORT",
    descriptor.id,
  );
  if (
    identity.id !== descriptor.id
    || identity.implementation !== descriptor.implementation
    || identity.sourceMeaning !== descriptor.sourceMeaning
  ) {
    fail("CUT_INTERCHANGE_BACKEND_REPORT", "interchange report does not bind the dispatched backend identity.", descriptor.id);
  }
  const reportSource = dataRecord(
    report.source,
    "interchange backend report source",
    "CUT_INTERCHANGE_BACKEND_REPORT",
    descriptor.id,
  );
  if (reportSource.buildId !== source.identity.buildId || typeof reportSource.compositionId !== "string") {
    fail("CUT_INTERCHANGE_BACKEND_REPORT", "interchange report does not bind the dispatched CUT build.", descriptor.id);
  }
  const composition = source.ir.compositions.find((item) => item.id === reportSource.compositionId);
  if (!composition) {
    fail("CUT_INTERCHANGE_BACKEND_REPORT", "interchange report names a composition outside the dispatched CUT graph.", descriptor.id);
  }
  if (
    source.selection.composition !== null
    && source.selection.composition !== composition.id
    && source.selection.composition !== composition.name
  ) {
    fail("CUT_INTERCHANGE_BACKEND_REPORT", "interchange report does not bind the requested CUT composition.", descriptor.id);
  }
  if (report.status !== "lossless-editorial" && report.status !== "lossy-editorial") {
    fail("CUT_INTERCHANGE_BACKEND_REPORT", "interchange report status must be lossless-editorial or lossy-editorial.", descriptor.id);
  }
  if (!Array.isArray(report.unsupportedSemantics) || report.unsupportedSemantics.length > maximumLosses) {
    fail(
      "CUT_INTERCHANGE_BACKEND_REPORT",
      `interchange report unsupportedSemantics must be an array with at most ${maximumLosses} entries.`,
      descriptor.id,
    );
  }
  for (const [index, rawIssue] of report.unsupportedSemantics.entries()) {
    const issue = dataRecord(
      rawIssue,
      `interchange report unsupportedSemantics[${index}]`,
      "CUT_INTERCHANGE_BACKEND_REPORT",
      descriptor.id,
    );
    if (typeof issue.code !== "string" || !diagnosticCodePattern.test(issue.code)) {
      fail("CUT_INTERCHANGE_BACKEND_REPORT", `interchange report issue ${index} has a noncanonical code.`, descriptor.id);
    }
    boundedString(issue.category, `interchange report issue ${index} category`, "CUT_INTERCHANGE_BACKEND_REPORT", descriptor.id);
    if (!["omitted", "partial", "flattened", "metadata-only"].includes(String(issue.disposition))) {
      fail("CUT_INTERCHANGE_BACKEND_REPORT", `interchange report issue ${index} has an invalid disposition.`, descriptor.id);
    }
    const subject = dataRecord(
      issue.subject,
      `interchange report issue ${index} subject`,
      "CUT_INTERCHANGE_BACKEND_REPORT",
      descriptor.id,
    );
    boundedString(subject.kind, `interchange report issue ${index} subject.kind`, "CUT_INTERCHANGE_BACKEND_REPORT", descriptor.id);
    boundedString(subject.id, `interchange report issue ${index} subject.id`, "CUT_INTERCHANGE_BACKEND_REPORT", descriptor.id);
    boundedString(issue.message, `interchange report issue ${index} message`, "CUT_INTERCHANGE_BACKEND_REPORT", descriptor.id);
  }
  if (
    (report.unsupportedSemantics.length === 0 && report.status !== "lossless-editorial")
    || (report.unsupportedSemantics.length > 0 && report.status !== "lossy-editorial")
  ) {
    fail("CUT_INTERCHANGE_BACKEND_REPORT", "interchange report status contradicts its unsupportedSemantics entries.", descriptor.id);
  }
  return value as CutInterchangeLossReport;
}

export function executeCutInterchangeExport<
  Options,
  Artifact,
  Report extends CutInterchangeLossReport,
  Id extends string,
>(
  backend: CutInterchangeExportBackend<Options, Artifact, Report, Id>,
  invocation: Readonly<{
    ir: CutAVIR;
    composition?: string;
    options: Readonly<Options>;
  }>,
): CutInterchangeDispatchResult<Artifact, Report, Id> {
  const descriptor = validateCutInterchangeBackendDescriptor(backend.descriptor);
  if (typeof backend.exportEditorial !== "function") {
    fail("CUT_INTERCHANGE_BACKEND_DESCRIPTOR", "interchange backend exportEditorial must be a function.", descriptor.id);
  }
  const callerIr = validateIr(invocation.ir);
  let isolatedIr: CutAVIR;
  try {
    isolatedIr = structuredClone(callerIr);
  } catch (error) {
    fail("CUT_INTERCHANGE_BACKEND_IR", "interchange CutAVIR must be structured-cloneable data.", descriptor.id, error);
  }
  const semanticSha256 = hash(isolatedIr);
  const source: CutInterchangeEditorialSource = Object.freeze({
    format: "cut-interchange-editorial-source",
    version: 1,
    meaning: cutInterchangeSourceMeaning,
    ir: isolatedIr,
    selection: Object.freeze({ composition: invocation.composition ?? null }),
    identity: Object.freeze({ buildId: isolatedIr.buildId, semanticSha256 }),
  });

  let rawResult: unknown;
  let thrown: unknown;
  try {
    rawResult = backend.exportEditorial(source, invocation.options);
  } catch (error) {
    thrown = error;
  }
  if (hash(isolatedIr) !== semanticSha256) {
    fail(
      "CUT_INTERCHANGE_BACKEND_MUTATION",
      `interchange backend ${boundedDiagnosticString(descriptor.id)} mutated its canonical editorial input.`,
      descriptor.id,
      thrown,
    );
  }
  if (thrown !== undefined) {
    if (stableAdapterDiagnostic(thrown)) throw thrown;
    fail(
      "CUT_INTERCHANGE_BACKEND_EXECUTION",
      `interchange backend ${boundedDiagnosticString(descriptor.id)} failed without a stable CUT diagnostic.`,
      descriptor.id,
      thrown,
    );
  }
  if (rawResult && typeof (rawResult as { then?: unknown }).then === "function") {
    fail("CUT_INTERCHANGE_BACKEND_RESULT", "interchange export backends must return a synchronous data result.", descriptor.id);
  }
  const result = dataRecord(rawResult, "interchange backend result", "CUT_INTERCHANGE_BACKEND_RESULT", descriptor.id);
  exactKeys(result, ["artifact", "report"], "interchange backend result", "CUT_INTERCHANGE_BACKEND_RESULT", descriptor.id);
  if (result.artifact === undefined) {
    fail("CUT_INTERCHANGE_BACKEND_RESULT", "interchange backend artifact cannot be undefined.", descriptor.id);
  }
  const report = validateLossReport(result.report, descriptor, source) as Report;
  const compositionId = report.source.compositionId;
  const execution: CutInterchangeExecutionReceipt<Id> = Object.freeze({
    format: "cut-interchange-backend-execution",
    version: 1,
    backend: cutInterchangeBackendReportIdentity(descriptor),
    source: Object.freeze({ buildId: source.identity.buildId, semanticSha256, compositionId }),
    status: report.status,
    unsupportedSemanticCount: report.unsupportedSemantics.length,
  });
  return Object.freeze({
    artifact: result.artifact as Artifact,
    report,
    execution,
  });
}

export function dispatchCutInterchangeExport<
  Options,
  Artifact,
  Report extends CutInterchangeLossReport,
  Id extends string,
>(
  registry: CutInterchangeBackendRegistry,
  id: Id,
  invocation: Readonly<{
    ir: CutAVIR;
    composition?: string;
    options: Readonly<Options>;
  }>,
): CutInterchangeDispatchResult<Artifact, Report, Id> {
  const backend = registry.resolve(id) as unknown as CutInterchangeExportBackend<Options, Artifact, Report, Id>;
  return executeCutInterchangeExport(backend, invocation);
}
