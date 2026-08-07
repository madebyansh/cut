import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { stableJsonStringify } from "../core/stable";
import type { LanguageDiagnostic } from "../language/ast";
import { checkCutModule } from "../language/checker";
import { compileCutModule, CutCompileError } from "../language/compiler";
import { CutFormatError, formatCutSource } from "../language/formatter";
import { parseCutLanguage } from "../language/parser";
import { validateReferenceStaticVisualGraphs } from "../runtime/reference/static-visual-validation";

export type CutAgentProvider = "chatgpt" | "api";
export type CutAgentMode = "author" | "repair";

export type CutAgentDiagnostic = Readonly<{
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  hint?: string;
  source?: Readonly<{ line: number; column: number; endLine: number; endColumn: number }>;
}>;

export type CutAgentAttemptReport = Readonly<{
  attempt: number;
  status: "valid" | "invalid" | "provider-failed";
  prompt: Readonly<{ bytes: number; sha256: string }>;
  response?: Readonly<{ bytes: number; sha256: string }>;
  events?: Readonly<{ bytes: number; sha256: string; toolCalls: number }>;
  diagnostics: readonly CutAgentDiagnostic[];
}>;

export type CutAgentReport = Readonly<{
  format: "cut-agent-author-report";
  version: 1;
  command: "agent author" | "agent repair";
  status: "pass" | "fail";
  provider: Readonly<{ name: CutAgentProvider; model: string; transport: "codex-subprocess" | "responses-api" | "injected-test-runner" }>;
  context: Readonly<{
    files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[];
    machineReference: Readonly<{ bytes: number; sha256: string }>;
  }>;
  brief: Readonly<{ path: string; bytes: number; sha256: string }>;
  input?: Readonly<{ path: string; bytes: number; sha256: string; diagnostics: readonly CutAgentDiagnostic[] }>;
  output?: Readonly<{ path: string; bytes: number; sha256: string; formatted: true }>;
  attempts: readonly CutAgentAttemptReport[];
}>;

export type CutAgentOptions = Readonly<{
  mode: CutAgentMode;
  briefPath: string;
  outputPath: string;
  sourcePath?: string;
  provider: CutAgentProvider;
  model: string;
  maximumAttempts?: number;
  machineReference: string;
  publicRoot?: string;
  reportPath?: string;
  traceDirectory?: string;
}>;

type ModelRequest = Readonly<{ prompt: string; model: string; provider: CutAgentProvider }>;
type ModelResponse = Readonly<{ source: string; events?: string; stderr?: string }>;
export type CutAgentModelRunner = (request: ModelRequest) => Promise<ModelResponse>;

const maximumBriefBytes = 32 * 1024;
const maximumSourceBytes = 256 * 1024;
const maximumPromptBytes = 192 * 1024;
const maximumModelOutputBytes = 512 * 1024;
const maximumEventBytes = 4 * 1024 * 1024;
const maximumStderrBytes = 64 * 1024;
const modelTimeoutMs = 180_000;
const publicContextFiles = ["docs/AGENT_GUIDE.md", "docs/CLI.md"] as const;

export const cutAgentDisabledCodexFeatures = Object.freeze([
  "shell_tool",
  "shell_snapshot",
  "unified_exec",
  "unified_exec_zsh_fork",
  "apps",
  "enable_mcp_apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "multi_agent",
  "multi_agent_v2",
  "standalone_web_search",
  "skill_mcp_dependency_install",
  "tool_call_mcp_elicitation",
  "tool_suggest",
] as const);

export function cutAgentCodexArgs(model: string, outputPath: string) {
  return [
    ...cutAgentDisabledCodexFeatures.flatMap((feature) => ["--disable", feature]),
    "--strict-config", "--ask-for-approval", "never",
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "read-only", "--model", model, "--config", "model_reasoning_effort=\"medium\"",
    "--json", "-o", outputPath, "-",
  ];
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedUtf8(value: string, maximum: number, label: string) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximum) throw Object.assign(new Error(`${label} exceeds the ${maximum}-byte UTF-8 limit.`), { code: "CUT_AGENT_INPUT_LIMIT" });
  if (value.includes("\0")) throw Object.assign(new Error(`${label} contains a NUL byte.`), { code: "CUT_AGENT_INPUT_UTF8" });
  return { value, bytes, sha256: sha256(value) };
}

async function readRegularUtf8(path: string, maximum: number, label: string) {
  const absolute = resolve(path), metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw Object.assign(new Error(`${label} must be a regular, non-symlink file.`), { code: "CUT_AGENT_INPUT_FILE" });
  if (metadata.size > maximum) throw Object.assign(new Error(`${label} exceeds the ${maximum}-byte limit.`), { code: "CUT_AGENT_INPUT_LIMIT" });
  const bytes = await readFile(absolute);
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw Object.assign(new Error(`${label} is not valid UTF-8.`), { code: "CUT_AGENT_INPUT_UTF8" }); }
  return { path: absolute, ...boundedUtf8(value, maximum, label) };
}

function validateModel(model: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model)) {
    throw Object.assign(new Error("--model must contain 1 to 100 letters, numbers, dots, underscores, colons, slashes, or hyphens."), { code: "CUT_AGENT_MODEL" });
  }
  return model;
}

function diagnostic(value: LanguageDiagnostic): CutAgentDiagnostic {
  return {
    code: value.code,
    severity: value.severity,
    message: value.message,
    ...(value.hint ? { hint: value.hint } : {}),
    source: {
      line: value.span.start.line,
      column: value.span.start.column,
      endLine: value.span.end.line,
      endColumn: value.span.end.column,
    },
  };
}

function failureDiagnostic(error: unknown, code = "CUT_AGENT_PROVIDER"): CutAgentDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  return { code, severity: "error", message: sanitizeDiagnostic(message) };
}

export function validateCutAgentCandidate(raw: string): Readonly<{
  status: "valid" | "invalid";
  source: string;
  diagnostics: readonly CutAgentDiagnostic[];
}> {
  let source: string;
  try { source = boundedUtf8(raw, maximumModelOutputBytes, "Model source").value; }
  catch (error) { return { status: "invalid", source: raw.slice(0, maximumModelOutputBytes), diagnostics: [failureDiagnostic(error, "CUT_AGENT_OUTPUT_LIMIT")] }; }
  const parsed = parseCutLanguage(source);
  if (!parsed.module) return { status: "invalid", source, diagnostics: parsed.diagnostics.map(diagnostic) };
  const checked = checkCutModule(parsed.module, { moduleKind: "entry" });
  const initialDiagnostics = [...parsed.diagnostics, ...checked.diagnostics];
  if (initialDiagnostics.some((item) => item.severity === "error")) {
    return { status: "invalid", source, diagnostics: initialDiagnostics.map(diagnostic) };
  }
  let initialStaticDiagnostics: readonly LanguageDiagnostic[];
  try {
    const compiled = compileCutModule(parsed.module);
    initialStaticDiagnostics = validateReferenceStaticVisualGraphs(compiled.ir);
  } catch (error) {
    if (error instanceof CutCompileError) return { status: "invalid", source, diagnostics: error.result.diagnostics.map(diagnostic) };
    throw error;
  }
  if (initialStaticDiagnostics.some((item) => item.severity === "error")) {
    return { status: "invalid", source, diagnostics: initialStaticDiagnostics.map(diagnostic) };
  }
  let formatted: string;
  try { formatted = formatCutSource(source); }
  catch (error) {
    if (error instanceof CutFormatError && error.diagnostic) return { status: "invalid", source, diagnostics: [diagnostic(error.diagnostic)] };
    throw error;
  }
  const formattedParsed = parseCutLanguage(formatted);
  if (!formattedParsed.module) return { status: "invalid", source, diagnostics: formattedParsed.diagnostics.map(diagnostic) };
  try {
    const compiled = compileCutModule(formattedParsed.module);
    const diagnostics = [...formattedParsed.diagnostics, ...compiled.check.diagnostics, ...validateReferenceStaticVisualGraphs(compiled.ir)];
    return {
      status: diagnostics.some((item) => item.severity === "error") ? "invalid" : "valid",
      source: formatted,
      diagnostics: diagnostics.map(diagnostic),
    };
  } catch (error) {
    if (error instanceof CutCompileError) return { status: "invalid", source, diagnostics: error.result.diagnostics.map(diagnostic) };
    throw error;
  }
}

function sanitizeDiagnostic(value: string) {
  return value
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bOPENAI_API_KEY\s*=\s*[^\s]+/gi, "OPENAI_API_KEY=[REDACTED]")
    .slice(0, maximumStderrBytes);
}

function appendBounded(chunks: Buffer[], chunk: Buffer | string, state: { bytes: number }, maximum: number, abort: () => void) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.bytes += value.length;
  if (state.bytes > maximum) { abort(); return false; }
  chunks.push(value);
  return true;
}

function cleanCodexEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;
  return {
    NODE_ENV: "production",
    ...Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
  };
}

function auditCodexEvents(events: string) {
  const lines = events.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw Object.assign(new Error("Codex returned no auditable JSON events."), { code: "CUT_AGENT_EVENT_STREAM" });
  let toolCalls = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "type" && typeof child === "string" && /(?:command|shell|tool|mcp|web_search|file_change|computer)/i.test(child)) toolCalls += 1;
      visit(child);
    }
  };
  for (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { throw Object.assign(new Error("Codex emitted a non-JSON event while authoring."), { code: "CUT_AGENT_EVENT_STREAM" }); }
    visit(event);
  }
  if (toolCalls) throw Object.assign(new Error(`Codex attempted ${toolCalls} tool event(s); isolated authoring accepts model text only.`), { code: "CUT_AGENT_TOOL_USE", toolCalls });
  return toolCalls;
}

async function runChatGptModel(request: ModelRequest): Promise<ModelResponse> {
  const directory = await mkdtemp(join(tmpdir(), "cut-agent-codex-")), outputPath = join(directory, "candidate.cut");
  try {
    const args = cutAgentCodexArgs(request.model, outputPath);
    const result = await new Promise<{ events: string; stderr: string }>((accept, reject) => {
      const child = spawn("codex", args, { cwd: directory, env: cleanCodexEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [], stdoutState = { bytes: 0 }, stderrState = { bytes: 0 };
      let killedForLimit = "", settled = false;
      const abort = (stream: string) => { killedForLimit ||= stream; child.kill("SIGTERM"); };
      child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState, maximumEventBytes, () => abort("event")));
      child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, stderrState, maximumStderrBytes, () => abort("stderr")));
      const timer = setTimeout(() => { abort("timeout"); }, modelTimeoutMs);
      child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
      child.on("close", (code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const stderrText = sanitizeDiagnostic(Buffer.concat(stderr).toString("utf8"));
        const evidence = { events: Buffer.concat(stdout).toString("utf8"), stderr: stderrText };
        if (killedForLimit === "timeout") return reject(Object.assign(new Error(`Codex authoring timed out after ${modelTimeoutMs / 1000}s.`), { code: "CUT_AGENT_TIMEOUT", ...evidence }));
        if (killedForLimit) return reject(Object.assign(new Error(`Codex ${killedForLimit} output exceeded its bound.`), { code: "CUT_AGENT_OUTPUT_LIMIT", ...evidence }));
        if (code !== 0) return reject(Object.assign(new Error(`Codex authoring failed with status ${code}. ${stderrText}`.trim()), { code: "CUT_AGENT_PROVIDER", ...evidence }));
        accept({ events: Buffer.concat(stdout).toString("utf8"), stderr: stderrText });
      });
      child.stdin.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE" && !settled) abort("stdin"); });
      child.stdin.end(request.prompt, "utf8");
    });
    const metadata = await lstat(outputPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumModelOutputBytes) {
      throw Object.assign(new Error("Codex did not produce one bounded regular CUT source response."), { code: "CUT_AGENT_OUTPUT_FILE" });
    }
    const bytes = await readFile(outputPath);
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw Object.assign(new Error("Codex response is not valid UTF-8."), { code: "CUT_AGENT_OUTPUT_UTF8" }); }
    return { source, events: result.events, stderr: result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function responsesOutputText(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const root = data as { output_text?: unknown; output?: unknown };
  if (typeof root.output_text === "string") return root.output_text;
  if (!Array.isArray(root.output)) return "";
  return root.output.flatMap((item) => item && typeof item === "object" && Array.isArray((item as { content?: unknown }).content)
    ? (item as { content: unknown[] }).content
    : []).map((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "").join("");
}

async function runApiModel(request: ModelRequest): Promise<ModelResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("--provider api requires OPENAI_API_KEY."), { code: "CUT_AGENT_API_KEY" });
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(modelTimeoutMs),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: request.model,
      reasoning: { effort: "medium" },
      store: false,
      input: [
        { role: "developer", content: "Return only ordinary UTF-8 CUT source. Do not use tools, browse, or emit Markdown, JSON, IR, commentary, or commands." },
        { role: "user", content: request.prompt },
      ],
    }),
  });
  if (!response.ok) {
    const body = sanitizeDiagnostic((await response.text()).slice(0, 8 * 1024));
    throw Object.assign(new Error(`OpenAI authoring failed with HTTP ${response.status}. ${body}`), { code: "CUT_AGENT_PROVIDER" });
  }
  const source = responsesOutputText(await response.json());
  if (!source) throw Object.assign(new Error("OpenAI returned no CUT source text."), { code: "CUT_AGENT_OUTPUT_FILE" });
  boundedUtf8(source, maximumModelOutputBytes, "OpenAI source");
  return { source };
}

async function noClobber(path: string, contents: string) {
  const absolute = resolve(path), parent = dirname(absolute);
  await mkdir(parent, { recursive: true });
  const temporary = resolve(parent, `.${basename(absolute)}.${process.pid}.${createHash("sha256").update(absolute).update(String(Date.now())).digest("hex").slice(0, 12)}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
    await link(temporary, absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error(`Refusing to overwrite existing path: ${path}`), { code: "CUT_AGENT_NO_CLOBBER" });
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function refuseExisting(path: string, label: string) {
  if (await lstat(resolve(path)).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) {
    throw Object.assign(new Error(`${label} already exists; agent authoring never overwrites it.`), { code: "CUT_AGENT_NO_CLOBBER" });
  }
}

type Trace = Readonly<{ directory: string; write: (path: string, contents: string) => Promise<void> }>;

async function createTrace(directory: string | undefined, files: readonly { path: string; value: string }[], machineReference: string, brief: string, source?: string): Promise<Trace | undefined> {
  if (!directory) return undefined;
  await refuseExisting(directory, "Trace directory");
  const absolute = resolve(directory);
  await mkdir(absolute, { recursive: false, mode: 0o700 });
  await chmod(absolute, 0o700);
  const write = async (path: string, contents: string) => {
    const destination = resolve(absolute, path);
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    await writeFile(destination, contents, { flag: "wx", mode: 0o600 });
  };
  await write("README.txt", "Sensitive opt-in authoring trace. Contains the supplied brief/source and model responses, but never environment variables, auth tokens, or API request headers.\n");
  await Promise.all(files.map((file) => write(`context/${file.path}`, file.value)));
  await write("context/machine-reference.json", machineReference.endsWith("\n") ? machineReference : `${machineReference}\n`);
  await write("brief.txt", brief);
  if (source !== undefined) await write("input.cut", source);
  return { directory: absolute, write };
}

function diagnosticsForPrompt(diagnostics: readonly CutAgentDiagnostic[]) {
  return stableJsonStringify(diagnostics.map((item) => ({ code: item.code, severity: item.severity, message: item.message, hint: item.hint ?? null, source: item.source ?? null })));
}

function basePrompt(mode: CutAgentMode, context: readonly { path: string; value: string }[], machineReference: string, brief: string, source?: string, sourceDiagnostics: readonly CutAgentDiagnostic[] = []) {
  const sections = [
    "You are the isolated CUT 0.4 source author. Return exactly one ordinary UTF-8 .cut source file and nothing else: no Markdown fence, JSON, IR, prose, or shell command.",
    "Do not run tools or commands. Use only the packed public references included below. Produce a standalone entry module. Do not invent external assets or undocumented syntax. The publisher will format, parse, typecheck, and lower your response before accepting it.",
    ...context.map((file) => `PUBLIC FILE ${file.path}\n---\n${file.value}\n---`),
    `PUBLIC MACHINE CLI REFERENCE\n---\n${machineReference}\n---`,
    `USER BRIEF\n---\n${brief}\n---`,
  ];
  if (mode === "repair") {
    sections.push(`CURRENT CUT SOURCE TO REPAIR\n---\n${source ?? ""}\n---`);
    sections.push(`CURRENT SOURCE COMPILER DIAGNOSTICS\n---\n${diagnosticsForPrompt(sourceDiagnostics)}\n---`);
  }
  return sections.join("\n\n");
}

export async function runCutAgent(options: CutAgentOptions, runner?: CutAgentModelRunner): Promise<CutAgentReport> {
  const maximumAttempts = options.maximumAttempts ?? 3;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3) {
    throw Object.assign(new Error("--attempts must be an integer from 1 to 3."), { code: "CUT_AGENT_ATTEMPTS" });
  }
  validateModel(options.model);
  if (!options.outputPath.endsWith(".cut")) throw Object.assign(new Error("--out must name a .cut source file."), { code: "CUT_AGENT_OUTPUT_PATH" });
  await refuseExisting(options.outputPath, "Output");
  if (options.reportPath) await refuseExisting(options.reportPath, "Report");
  if (options.mode === "repair" && !options.sourcePath) throw Object.assign(new Error("agent repair requires a current CUT source."), { code: "CUT_AGENT_REPAIR_SOURCE" });
  const [brief, source] = await Promise.all([
    readRegularUtf8(options.briefPath, maximumBriefBytes, "Brief"),
    options.sourcePath ? readRegularUtf8(options.sourcePath, maximumSourceBytes, "Repair source") : Promise.resolve(undefined),
  ]);
  const publicRoot = resolve(options.publicRoot ?? resolve(__dirname, "../../.."));
  const publicFiles = await Promise.all(publicContextFiles.map(async (path) => {
    const loaded = await readRegularUtf8(resolve(publicRoot, path), maximumSourceBytes, `Public context ${path}`);
    return { publicPath: path, value: loaded.value, bytes: loaded.bytes, sha256: loaded.sha256 };
  }));
  const context = publicFiles.map((file) => ({ path: file.publicPath, value: file.value }));
  const machine = boundedUtf8(options.machineReference, maximumSourceBytes, "Machine reference");
  const sourceValidation = source ? validateCutAgentCandidate(source.value) : undefined;
  const initialPrompt = basePrompt(options.mode, context, machine.value, brief.value, source?.value, sourceValidation?.diagnostics);
  boundedUtf8(initialPrompt, maximumPromptBytes, "Agent prompt");
  const trace = await createTrace(options.traceDirectory, context, machine.value, brief.value, source?.value);
  const attempts: CutAgentAttemptReport[] = [];
  const modelRunner = runner ?? (options.provider === "chatgpt" ? runChatGptModel : runApiModel);
  let prompt = initialPrompt;
  let validSource: string | undefined;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const promptIdentity = boundedUtf8(prompt, maximumPromptBytes, `Attempt ${attempt} prompt`);
    await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/prompt.txt`, prompt);
    let response: ModelResponse;
    try { response = await modelRunner({ prompt, model: options.model, provider: options.provider }); }
    catch (error) {
      const diagnostics = [failureDiagnostic(error, (error as { code?: string })?.code ?? "CUT_AGENT_PROVIDER")];
      const evidence = error as { events?: unknown; stderr?: unknown };
      const failedEvents = typeof evidence.events === "string" ? boundedUtf8(evidence.events, maximumEventBytes, `Attempt ${attempt} failed events`) : undefined;
      attempts.push({
        attempt,
        status: "provider-failed",
        prompt: { bytes: promptIdentity.bytes, sha256: promptIdentity.sha256 },
        ...(failedEvents ? { events: { bytes: failedEvents.bytes, sha256: failedEvents.sha256, toolCalls: 0 } } : {}),
        diagnostics,
      });
      if (failedEvents) await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/events.jsonl`, failedEvents.value);
      if (typeof evidence.stderr === "string" && evidence.stderr) await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/stderr.txt`, sanitizeDiagnostic(evidence.stderr));
      await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/failure.json`, `${stableJsonStringify({ diagnostics })}\n`);
      break;
    }
    const responseIdentity = boundedUtf8(response.source, maximumModelOutputBytes, `Attempt ${attempt} source`);
    const eventIdentity = response.events === undefined ? undefined : boundedUtf8(response.events, maximumEventBytes, `Attempt ${attempt} events`);
    await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/response.cut`, response.source);
    if (response.events !== undefined) await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/events.jsonl`, response.events);
    if (response.stderr) await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/stderr.txt`, sanitizeDiagnostic(response.stderr));
    let toolCalls = 0;
    try { toolCalls = response.events === undefined ? 0 : auditCodexEvents(response.events); }
    catch (error) {
      const diagnostics = [failureDiagnostic(error, (error as { code?: string })?.code ?? "CUT_AGENT_EVENT_STREAM")];
      attempts.push({
        attempt,
        status: "provider-failed",
        prompt: { bytes: promptIdentity.bytes, sha256: promptIdentity.sha256 },
        response: { bytes: responseIdentity.bytes, sha256: responseIdentity.sha256 },
        ...(eventIdentity ? { events: { bytes: eventIdentity.bytes, sha256: eventIdentity.sha256, toolCalls: Number((error as { toolCalls?: unknown }).toolCalls) || 0 } } : {}),
        diagnostics,
      });
      await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/failure.json`, `${stableJsonStringify({ diagnostics })}\n`);
      break;
    }
    const validation = validateCutAgentCandidate(response.source);
    attempts.push({
      attempt,
      status: validation.status,
      prompt: { bytes: promptIdentity.bytes, sha256: promptIdentity.sha256 },
      response: { bytes: responseIdentity.bytes, sha256: responseIdentity.sha256 },
      ...(eventIdentity ? { events: { bytes: eventIdentity.bytes, sha256: eventIdentity.sha256, toolCalls } } : {}),
      diagnostics: validation.diagnostics,
    });
    await trace?.write(`attempt-${String(attempt).padStart(2, "0")}/diagnostics.json`, `${stableJsonStringify({ status: validation.status, diagnostics: validation.diagnostics })}\n`);
    if (validation.status === "valid") { validSource = validation.source; break; }
    prompt = `${initialPrompt}\n\nPREVIOUS CANDIDATE (INVALID)\n---\n${response.source}\n---\n\nEXACT CUT COMPILER DIAGNOSTICS\n---\n${diagnosticsForPrompt(validation.diagnostics)}\n---\n\nRepair only the diagnosed source. Return the complete replacement .cut source and nothing else.`;
  }
  const reportBase = {
    format: "cut-agent-author-report" as const,
    version: 1 as const,
    command: `agent ${options.mode}` as "agent author" | "agent repair",
    provider: {
      name: options.provider,
      model: options.model,
      transport: runner ? "injected-test-runner" as const : options.provider === "chatgpt" ? "codex-subprocess" as const : "responses-api" as const,
    },
    context: {
      files: publicFiles.map((file) => ({ path: file.publicPath, bytes: file.bytes, sha256: file.sha256 })),
      machineReference: { bytes: machine.bytes, sha256: machine.sha256 },
    },
    brief: { path: options.briefPath, bytes: brief.bytes, sha256: brief.sha256 },
    ...(source ? { input: { path: options.sourcePath!, bytes: source.bytes, sha256: source.sha256, diagnostics: sourceValidation!.diagnostics } } : {}),
    attempts,
  };
  let report: CutAgentReport;
  if (validSource === undefined) report = { ...reportBase, status: "fail" };
  else {
    const outputIdentity = boundedUtf8(validSource, maximumSourceBytes, "Formatted CUT output");
    await noClobber(options.outputPath, validSource);
    report = { ...reportBase, status: "pass", output: { path: options.outputPath, bytes: outputIdentity.bytes, sha256: outputIdentity.sha256, formatted: true } };
  }
  const encodedReport = `${stableJsonStringify(report)}\n`;
  await trace?.write("report.json", encodedReport);
  if (options.reportPath) await noClobber(options.reportPath, encodedReport);
  return report;
}
