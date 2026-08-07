"use strict";

const { spawn } = require("node:child_process");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

class CutEditorCliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CutEditorCliError";
    this.code = code;
    this.details = details;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function validateExecutable(executable) {
  if (typeof executable !== "string" || !executable.trim() || executable.includes("\0")) {
    throw new CutEditorCliError("CUT_EDITOR_CLI_PATH", "cut.cli.path must name one executable.");
  }
  return executable.trim();
}

function abortError() {
  const error = new CutEditorCliError("CUT_EDITOR_ABORTED", "CUT CLI invocation was cancelled.");
  error.name = "AbortError";
  return error;
}

function runProcess(executable, args, options = {}) {
  const command = validateExecutable(executable);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000);
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, MAX_OUTPUT_BYTES, 1_024, 64 * 1024 * 1024);
  const prefixArgs = Array.isArray(options.prefixArgs) ? options.prefixArgs : [];

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }

    let child;
    try {
      child = spawn(command, [...prefixArgs, ...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
    } catch (error) {
      reject(new CutEditorCliError("CUT_EDITOR_CLI_START", `Could not start ${JSON.stringify(command)}.`, { cause: error }));
      return;
    }

    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new CutEditorCliError("CUT_EDITOR_CLI_OUTPUT", `CUT CLI output exceeded ${maxOutputBytes} bytes.`));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(abortError());
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", (error) => {
      if (!settled) finish(new CutEditorCliError("CUT_EDITOR_CLI_STDIN", "Could not send the current CUT buffer to the CLI.", { cause: error }));
    });
    child.on("error", (error) => {
      const missing = error && typeof error === "object" && error.code === "ENOENT";
      finish(new CutEditorCliError(
        missing ? "CUT_EDITOR_CLI_NOT_FOUND" : "CUT_EDITOR_CLI_START",
        missing
          ? `CUT could not find ${JSON.stringify(command)}. Install the CUT CLI or set cut.cli.path to its absolute executable path.`
          : `CUT could not start ${JSON.stringify(command)}.`,
        { cause: error },
      ));
    });
    child.on("exit", (code, signal) => finish(undefined, {
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new CutEditorCliError("CUT_EDITOR_CLI_TIMEOUT", `CUT CLI exceeded the ${timeoutMs}ms editor timeout.`));
    }, timeoutMs);
    child.stdin.end(typeof options.stdin === "string" ? options.stdin : undefined, "utf8");
  });
}

async function withSourceIdentity(source, options, callback) {
  if (typeof source !== "string") throw new CutEditorCliError("CUT_EDITOR_SOURCE", "CUT editor input must be UTF-8 text.");
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_SOURCE_BYTES) {
    throw new CutEditorCliError("CUT_EDITOR_SOURCE", `CUT editor input exceeds the ${MAX_SOURCE_BYTES}-byte safety limit.`);
  }
  if (options.sourcePath !== undefined) {
    if (typeof options.sourcePath !== "string" || !options.sourcePath || options.sourcePath.includes("\0")) {
      throw new CutEditorCliError("CUT_EDITOR_SOURCE_PATH", "The editor document path is not a valid CUT source identity.");
    }
    return callback(options.sourcePath);
  }
  const directory = await mkdtemp(join(tmpdir(), "cut-vscode-"));
  const path = join(directory, "document.cut");
  try {
    await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sourcePosition(value, label) {
  if (!value || typeof value !== "object"
    || !Number.isInteger(value.offset) || value.offset < 0
    || !Number.isInteger(value.line) || value.line < 1
    || !Number.isInteger(value.column) || value.column < 1) {
    throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `${label} is not a valid CUT source position.`);
  }
  return { offset: value.offset, line: value.line, column: value.column };
}

function diagnosticSource(value, index) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.path !== "string" || !value.path || value.path.includes("\0")
    || Buffer.byteLength(value.path, "utf8") > 4_096
    || !Number.isInteger(value.line) || value.line < 1
    || !Number.isInteger(value.column) || value.column < 1) {
    throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `cut check diagnostic ${index} has an invalid source identity.`);
  }
  return { path: value.path, line: value.line, column: value.column };
}

function runtimeDiagnosticSource(value, index) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `cut check runtime diagnostic ${index} has an invalid source identity.`);
  }
  const source = {};
  for (const name of ["path", "module", "nodeId"]) {
    if (value[name] === undefined) continue;
    if (typeof value[name] !== "string" || !value[name] || value[name].includes("\0") || Buffer.byteLength(value[name], "utf8") > 4_096) {
      throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `cut check runtime diagnostic ${index} has an invalid ${name}.`);
    }
    source[name] = value[name];
  }
  for (const name of ["line", "column"]) {
    if (value[name] === undefined) continue;
    if (!Number.isInteger(value[name]) || value[name] < 1) {
      throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `cut check runtime diagnostic ${index} has an invalid ${name}.`);
    }
    source[name] = value[name];
  }
  if ((source.line === undefined) !== (source.column === undefined)) {
    throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `cut check runtime diagnostic ${index} must provide line and column together.`);
  }
  return Object.keys(source).length ? source : undefined;
}

function parseDiagnosticReport(stdout) {
  let report;
  try {
    report = JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", "cut check did not return valid JSON diagnostics.", { cause: error });
  }
  if (!report || typeof report !== "object" || Array.isArray(report)
    || !["cut-diagnostics", "cut-cli-diagnostics"].includes(report.format)
    || report.version !== 1 || report.command !== "check"
    || !["pass", "fail"].includes(report.status) || !Array.isArray(report.diagnostics)
    || report.diagnostics.length > 256) {
    throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", "cut check returned an unsupported diagnostics contract.");
  }
  const runtimeEnvelope = report.format === "cut-cli-diagnostics";
  if (runtimeEnvelope && report.status !== "fail") {
    throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", "cut check runtime diagnostics cannot report a passing invocation.");
  }
  const diagnostics = report.diagnostics.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !["error", "warning", "info"].includes(item.severity)
      || typeof item.code !== "string" || !item.code
      || typeof item.message !== "string" || !item.message
      || (item.hint !== undefined && typeof item.hint !== "string")) {
      throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `cut check diagnostic ${index} is malformed.`);
    }
    if (runtimeEnvelope) {
      const source = runtimeDiagnosticSource(item.source, index);
      const line = source?.line ?? 1, column = source?.column ?? 1;
      return {
        severity: item.severity,
        code: item.code,
        message: item.message,
        hint: item.hint,
        span: { start: { offset: 0, line, column }, end: { offset: 0, line, column } },
        source,
      };
    }
    if (!item.span || typeof item.span !== "object") {
      throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `cut check diagnostic ${index} is missing its source span.`);
    }
    const start = sourcePosition(item.span.start, `diagnostic ${index} start`);
    const end = sourcePosition(item.span.end, `diagnostic ${index} end`);
    if (end.offset < start.offset) {
      throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", `cut check diagnostic ${index} has a reversed source span.`);
    }
    return { severity: item.severity, code: item.code, message: item.message, hint: item.hint, span: { start, end }, source: diagnosticSource(item.source, index) };
  });
  const hasError = diagnostics.some((item) => item.severity === "error");
  if ((report.status === "pass" && hasError) || (report.status === "fail" && !hasError)) {
    throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", "cut check status disagrees with its diagnostics.");
  }
  return { ...report, diagnostics };
}

function failedInvocation(action, result) {
  const detail = result.stderr.trim().slice(0, 2_000);
  return new CutEditorCliError(
    "CUT_EDITOR_CLI_EXIT",
    detail || `cut ${action} exited with status ${result.code ?? result.signal ?? "unknown"}.`,
    { code: result.code, signal: result.signal },
  );
}

async function runCutCheck(executable, source, options = {}) {
  return withSourceIdentity(source, options, async (path) => {
    const result = await runProcess(executable, ["check", path, "--stdin", "--json"], { ...options, stdin: source });
    if (result.code !== 0 && result.code !== 1) throw failedInvocation("check", result);
    const report = parseDiagnosticReport(result.stdout);
    if ((result.code === 0) !== (report.status === "pass")) {
      throw new CutEditorCliError("CUT_EDITOR_DIAGNOSTIC_JSON", "cut check exit status disagrees with its diagnostics report.");
    }
    return {
      ...report,
      diagnostics: report.diagnostics.map((item) => ({
        ...item,
        source: item.source ? { ...item.source, current: (item.source.path ?? item.source.module) === path } : undefined,
      })),
    };
  });
}

async function runCutFormat(executable, source, options = {}) {
  return withSourceIdentity(source, options, async (path) => {
    const result = await runProcess(executable, ["fmt", path, "--stdin", "--stdout"], { ...options, stdin: source });
    if (result.code !== 0) throw failedInvocation("fmt", result);
    return result.stdout;
  });
}

module.exports = {
  CutEditorCliError,
  parseDiagnosticReport,
  runCutCheck,
  runCutFormat,
  runProcess,
};
