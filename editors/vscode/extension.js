"use strict";

const { dirname } = require("node:path");
const vscode = require("vscode");
const { CutEditorCliError, runCutCheck, runCutFormat } = require("./lib/cut-cli");

const diagnostics = vscode.languages.createDiagnosticCollection("cut");
const timers = new Map();
const generations = new Map();
const running = new Map();

function configuration(document) {
  return vscode.workspace.getConfiguration("cut", document?.uri);
}

function cliOptions(document, signal) {
  const config = configuration(document);
  const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
  const cwd = workspace?.uri.fsPath
    || (document.uri.scheme === "file" ? dirname(document.uri.fsPath) : undefined);
  return {
    executable: config.get("cli.path", "cut"),
    timeoutMs: config.get("cli.timeout", 15_000),
    cwd,
    sourcePath: document.uri.scheme === "file" ? document.uri.fsPath : undefined,
    signal,
  };
}

function point(document, sourcePosition) {
  const line = Math.max(0, Math.min(document.lineCount - 1, sourcePosition.line - 1));
  const character = Math.max(0, Math.min(document.lineAt(line).text.length, sourcePosition.column - 1));
  return new vscode.Position(line, character);
}

function diagnosticRange(document, span) {
  const start = point(document, span.start);
  let end = point(document, span.end);
  if (end.isBefore(start)) end = start;
  if (end.isEqual(start)) {
    const lineLength = document.lineAt(start.line).text.length;
    end = start.character < lineLength
      ? start.translate(0, 1)
      : start;
  }
  return new vscode.Range(start, end);
}

function vscodeDiagnostic(document, item) {
  const severity = item.severity === "error"
    ? vscode.DiagnosticSeverity.Error
    : item.severity === "warning"
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;
  const external = item.source?.current === false;
  const externalPath = item.source?.path || item.source?.module || "external CUT source";
  const externalPosition = item.source?.line && item.source?.column ? `:${item.source.line}:${item.source.column}` : "";
  const location = external ? `${externalPath}${externalPosition}: ` : "";
  const message = `${location}${item.message}${item.hint ? `\n${item.hint}` : ""}`;
  const range = external
    ? new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, Math.min(1, document.lineAt(0).text.length)))
    : diagnosticRange(document, item.span);
  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.code = item.code;
  diagnostic.source = "cut check";
  return diagnostic;
}

function editorErrorDiagnostic(document, error) {
  const code = error instanceof CutEditorCliError ? error.code : "CUT_EDITOR_UNKNOWN";
  const message = error instanceof Error ? error.message : "CUT editor integration failed.";
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, Math.min(1, document.lineAt(0).text.length))),
    message,
    vscode.DiagnosticSeverity.Error,
  );
  diagnostic.code = code;
  diagnostic.source = "CUT editor";
  return diagnostic;
}

function invalidate(uri) {
  const key = uri.toString();
  const generation = (generations.get(key) || 0) + 1;
  generations.set(key, generation);
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  running.get(key)?.abort();
  running.delete(key);
  return generation;
}

async function checkDocument(document, generation, notify) {
  if (document.languageId !== "cut") return;
  const key = document.uri.toString();
  if (!configuration(document).get("diagnostics.enabled", true)) {
    diagnostics.delete(document.uri);
    return;
  }
  const controller = new AbortController();
  running.set(key, controller);
  try {
    const options = cliOptions(document, controller.signal);
    const report = await runCutCheck(options.executable, document.getText(), options);
    if (generations.get(key) !== generation) return;
    diagnostics.set(document.uri, report.diagnostics.map((item) => vscodeDiagnostic(document, item)));
    if (notify) {
      const errors = report.diagnostics.filter((item) => item.severity === "error").length;
      const warnings = report.diagnostics.filter((item) => item.severity === "warning").length;
      if (report.status === "pass") vscode.window.showInformationMessage(`CUT check passed${warnings ? ` with ${warnings} warning(s)` : ""}.`);
      else vscode.window.showErrorMessage(`CUT check found ${errors} error(s)${warnings ? ` and ${warnings} warning(s)` : ""}.`);
    }
  } catch (error) {
    if (error?.name === "AbortError" || generations.get(key) !== generation) return;
    diagnostics.set(document.uri, [editorErrorDiagnostic(document, error)]);
    if (notify) vscode.window.showErrorMessage(error instanceof Error ? error.message : "CUT check failed.");
  } finally {
    if (running.get(key) === controller) running.delete(key);
  }
}

function schedule(document, delay, notify = false) {
  if (document.languageId !== "cut") return Promise.resolve();
  const generation = invalidate(document.uri);
  if (delay <= 0) return checkDocument(document, generation, notify);
  const key = document.uri.toString();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(key);
      Promise.resolve(checkDocument(document, generation, notify)).finally(resolve);
    }, delay);
    timers.set(key, timer);
  });
}

async function formatDocument(document, token) {
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  try {
    const options = cliOptions(document, controller.signal);
    const formatted = await runCutFormat(options.executable, document.getText(), options);
    if (formatted === document.getText()) return [];
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    return [vscode.TextEdit.replace(fullRange, formatted)];
  } catch (error) {
    if (error?.name === "AbortError") return [];
    throw new Error(error instanceof Error ? error.message : "CUT formatting failed.");
  } finally {
    cancellation.dispose();
  }
}

function activate(context) {
  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerDocumentFormattingEditProvider({ language: "cut", scheme: "file" }, { provideDocumentFormattingEdits: formatDocument }),
    vscode.languages.registerDocumentFormattingEditProvider({ language: "cut", scheme: "untitled" }, { provideDocumentFormattingEdits: formatDocument }),
    vscode.commands.registerCommand("cut.checkDocument", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || document.languageId !== "cut") {
        vscode.window.showWarningMessage("Open a .cut document before running CUT: Check Current Document.");
        return;
      }
      await schedule(document, 0, true);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => { void schedule(document, 0); }),
    vscode.workspace.onDidSaveTextDocument((document) => { void schedule(document, 0); }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== "cut") return;
      const delay = configuration(event.document).get("diagnostics.delay", 350);
      void schedule(event.document, delay);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      invalidate(document.uri);
      generations.delete(document.uri.toString());
      diagnostics.delete(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("cut")) return;
      for (const document of vscode.workspace.textDocuments) void schedule(document, 0);
    }),
  );
  for (const document of vscode.workspace.textDocuments) void schedule(document, 0);
}

function deactivate() {
  for (const timer of timers.values()) clearTimeout(timer);
  for (const controller of running.values()) controller.abort();
  timers.clear();
  running.clear();
  generations.clear();
  diagnostics.dispose();
}

module.exports = { activate, deactivate };
