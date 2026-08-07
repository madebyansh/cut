type DiagnosticSeverity = "error" | "warning" | "info";

export type CutRuntimeDiagnosticSource = {
  path?: string;
  module?: string;
  line?: number;
  column?: number;
  nodeId?: string;
};

export type CutRuntimeDiagnostic = {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  source?: CutRuntimeDiagnosticSource;
  hint?: string;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? value as UnknownRecord : undefined;
}

function stableCode(value: unknown) {
  return typeof value === "string" && /^(?:CUT[A-Z0-9_]*|CUTC[0-9]{4})$/.test(value) ? value : undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function location(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = /^(.*):(\d+):(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const line = Number(match[2]), column = Number(match[3]);
  return positiveInteger(line) && positiveInteger(column) ? { module: match[1], line, column } : undefined;
}

function sourceFromError(error: UnknownRecord): CutRuntimeDiagnosticSource | undefined {
  const source: CutRuntimeDiagnosticSource = {};
  if (typeof error.path === "string") source.path = error.path;
  if (typeof error.nodeId === "string") source.nodeId = error.nodeId;

  if (typeof error.source === "string") {
    const parsed = location(error.source);
    if (parsed) Object.assign(source, parsed);
    else source.path ??= error.source;
  } else {
    const structured = record(error.source);
    if (structured) {
      if (typeof structured.path === "string") source.path = structured.path;
      if (typeof structured.module === "string") source.module = structured.module;
      if (typeof structured.nodeId === "string") source.nodeId = structured.nodeId;
      source.line = positiveInteger(structured.line);
      source.column = positiveInteger(structured.column);
    }
  }

  const span = record(error.span), start = record(span?.start);
  if (start) {
    source.line ??= positiveInteger(start.line);
    source.column ??= positiveInteger(start.column);
  }

  // ReferenceAudioConfigError predates the structured source field. Preserve
  // its stable node id and recover the exact compiler provenance that its
  // constructor includes in the message until that public error can evolve.
  if ((!source.module || !source.line || !source.column) && typeof error.message === "string") {
    const match = /\sat\s(.+):(\d+):(\d+)\s/.exec(error.message);
    if (match) {
      source.module ??= match[1];
      source.line ??= positiveInteger(Number(match[2]));
      source.column ??= positiveInteger(Number(match[3]));
    }
  }
  return Object.keys(source).length ? source : undefined;
}

function diagnosticFromLanguage(value: unknown, path?: string): CutRuntimeDiagnostic | undefined {
  const diagnostic = record(value), span = record(diagnostic?.span), start = record(span?.start);
  const code = stableCode(diagnostic?.code);
  if (!diagnostic || !code || typeof diagnostic.message !== "string") return undefined;
  const severity = diagnostic.severity === "warning" || diagnostic.severity === "info" ? diagnostic.severity : "error";
  const line = positiveInteger(start?.line), column = positiveInteger(start?.column);
  const diagnosticPath = typeof diagnostic.module === "string" ? diagnostic.module : path;
  const source = diagnosticPath || line || column ? { ...(diagnosticPath ? { path: diagnosticPath } : {}), ...(line ? { line } : {}), ...(column ? { column } : {}) } : undefined;
  return { code, severity, message: diagnostic.message, ...(source ? { source } : {}), ...(typeof diagnostic.hint === "string" ? { hint: diagnostic.hint } : {}) };
}

export function cutDiagnosticsFromError(value: unknown, fallbackCode = "CUTC9000"): CutRuntimeDiagnostic[] {
  const error = record(value);
  if (error) {
    const ownDiagnostics = Array.isArray(error.diagnostics) ? error.diagnostics : undefined;
    const result = record(error.result);
    const nestedDiagnostics = ownDiagnostics ?? (Array.isArray(result?.diagnostics) ? result.diagnostics : undefined);
    if (nestedDiagnostics) {
      const path = typeof error.path === "string" ? error.path : undefined;
      const diagnostics = nestedDiagnostics.map((item) => diagnosticFromLanguage(item, path)).filter((item): item is CutRuntimeDiagnostic => Boolean(item));
      if (diagnostics.length) return diagnostics;
    }
  }

  const code = stableCode(error?.code) ?? fallbackCode;
  const rawMessage = value instanceof Error ? value.message : String(value);
  const prefix = `${code}: `, pathPrefix = typeof error?.path === "string" ? `${code} at ${error.path}: ` : undefined;
  const message = pathPrefix && rawMessage.startsWith(pathPrefix) ? rawMessage.slice(pathPrefix.length) : rawMessage.startsWith(prefix) ? rawMessage.slice(prefix.length) : rawMessage;
  const source = error ? sourceFromError(error) : undefined;
  return [{ code, severity: "error", message, ...(source ? { source } : {}) }];
}
