#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { buildArtifact } from "../lib/core/build";
import { createMediaIndex, transcribeMediaIndex } from "../lib/core/indexer";
import { renderArtifact } from "../lib/core/render";
import { diffBuilds } from "../lib/core/diff";
import { catalogFromIndex } from "../lib/core/build";
import { planWithCodex, planWithOpenAI } from "../lib/core/planner";
import { mediaIndexHash } from "../lib/core/indexer";
import { analyzeMediaIndex } from "../lib/core/vision";
import { renderProduction } from "../lib/production/render";
import { directWithCodex, directWithOpenAI, lowerDirection } from "../lib/production/director";
import type { ProductionTheme } from "../lib/production/types";
import { composeWithCodex, lowerResearchDirection } from "../lib/production/research-director";
import { validateResearchPack } from "../lib/research/validate";
import { researchWithCodex } from "../lib/research/director";
import { critiqueProduction } from "../lib/production/critique";
import { reviseProgramWithCodex } from "../lib/production/revise";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import type { BuildArtifact, MediaIndex } from "../lib/types";
import type { LanguageDiagnostic } from "../lib/language/ast";
import { applyCutLock, applyCutLockForVerifiedInputSession, createCutLock, loadCutLock, type CutLockfile } from "../lib/language/lock";
import { diffCutAVIR, formatCutAVIRSemanticDiff } from "../lib/language/semantic-diff";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { renderReferenceIr } from "../lib/runtime/reference/render";
import {
  createCutProject,
  cutVideoProxyGenerationPolicy,
  generateCutVideoProxy,
  loadCutAssetCatalogFile,
  loadCutProject,
  probeProjectMedia,
  relinkCutSource,
  searchCutAssetCatalog,
  type CutAssetCatalogKind,
} from "../lib/project";
import { writeProjectArtifacts } from "../lib/project/write-boundary";
import { stableJsonStringify } from "../lib/core/stable";
import { collectCutDoctorReport } from "../lib/system/doctor";
import {
  cutCompilerIdentity,
  cutIrVersion,
  cutLanguageVersion,
  cutPackageAbi,
  cutProductVersion,
  cutReferenceRuntimeIdentity,
  cutVersionLine,
} from "../lib/version";
import { formatCutSource } from "../lib/language/formatter";
import { lintCutModule } from "../lib/language/linter";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { importOtioTimeline } from "../lib/interchange/otio-import";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { inspectCutIr } from "../lib/runtime/inspect";
import { createCutExternalPackageContext, type CutExternalPackageContext } from "../lib/package/context";
import { analyzeCutLanguageProgramSource } from "../lib/language/program-analysis";
import { evaluateCutDomainAssertions } from "../lib/language/domain-assertions";
import {
  analyzeCutMigration,
  completedCutMigrationReport,
  inspectCutMigrationPaths,
  writeCutMigrationOutput,
} from "../lib/language/migration";
import { CutPackageError } from "../lib/package/diagnostics";
import { cutPackageLockFile, cutPackageManifestFile } from "../lib/package/manifest";
import {
  addCutPackageDependency,
  formatCutPackageList,
  initCutPackage,
  listCutPackageDependencies,
  regenerateCutPackageLock,
  removeCutPackageDependency,
  updateCutPackageDependencies,
} from "../lib/package/project";
import { loadCutPackageLock, resolveVerifiedCutPackageGraph } from "../lib/package/resolver";
import { runCutAgent, type CutAgentProvider } from "../lib/agent/author";
import { reviewProfessionalOutputFile } from "../lib/review/professional-output";
import { reviewReferenceStudyFile } from "../lib/review/reference-study";
import {
  renderReferenceAudioAuditionArtifact,
  renderReferenceContactSheetArtifact,
  renderReferenceFrameArtifact,
  renderReferencePreviewArtifact,
} from "../lib/runtime/reference/authoring-review";
import { referenceVideoColorInterpretationWarnings } from "../lib/runtime/reference/color-management";

const colorsEnabled = !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0" && (process.stdout.isTTY || process.stderr.isTTY);
const color = (code: string, text: string) => colorsEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
const green = (text: string) => color("32", text);
const cyan = (text: string) => color("36", text);
const red = (text: string) => color("31", text);
const yellow = (text: string) => color("33", text);
const dim = (text: string) => color("2", text);

function usage() {
  console.log(`${cutVersionLine()}

Typed audiovisual source (canonical)

  cut help [--json]
  cut init <directory> [--name "Project name"]
  cut project <directory>
  cut doctor [--json]
  cut review <professional-output-review.json> [--json]
  cut review-study <reference-study-review.json> [--json]
  cut agent author <brief.txt> --out main.cut [--provider chatgpt|api] [--model model] [--attempts 1..3] [--report report.json] [--trace directory] [--json]
  cut agent repair <program.cut> --brief brief.txt --out repaired.cut [--provider chatgpt|api] [--model model] [--attempts 1..3] [--report report.json] [--trace directory] [--json]
  cut fmt <program.cut> [--check | --stdout] [--json] [--stdin]
  cut check <program.cut> [--json] [--stdin]
  cut lint <program.cut> [--deny-warnings] [--json]
  cut migrate <artifact> [--check] [--out new-artifact] [--json]
  cut relink <program.cut> --asset <name> --to <project-relative-path> [--write] [--json]
  cut probe <project-relative-media> [--project <directory>] [--out media.probe.json]
  cut proxy <project-relative-video> --project <directory> --out <project-relative-proxy.mp4> --width 640 [--stream 0] [--json]
  cut lock <program.cut> [--out cut.lock] [--json]
  cut build <program.cut> [--lock cut.lock] [--out graph.cutir.json] [--json]
  cut inspect <program.cut> [--lock cut.lock] [--json]
  cut test <program.cut> [--lock cut.lock] [--json]
  cut diff <before.cutir.json> <after.cutir.json> [--json]
  cut otio export <program.cut> --lock cut.lock --out timeline.otio [--report report.json] [--composition name] [--allow-lossy]
  cut otio import <timeline.otio> --out program.cut [--report report.json] [--fps 24] [--width 1920 --height 1080 --sample-rate 48000] [--allow-lossy]
  cut frame <program.cut> --lock cut.lock (--frame 42 | --at 1.75s) --out review/frame.png [--output name] [--profile master|proxy] [--json]
  cut contact <program.cut> --lock cut.lock --frames 0,24,48 --out review/contact.png [--columns 3] [--thumbnail-width 480] [--output name] [--profile master|proxy] [--json]
  cut audition <program.cut> --lock cut.lock --samples 48000:96000 --out review/audition.wav [--stem dialogue] [--output name] [--profile master|proxy] [--json]
  cut preview <program.cut> --lock cut.lock [--output preview] [--range 2s:5s] [--width 640] [--out output/preview.mp4] [--json]
  cut render <program.cut> --lock cut.lock --out video.mp4 [--output name] [--stems directory] [--json]

Provenance-bearing asset discovery (candidate bytes are never trusted implicitly)

  cut asset search <catalog.json> --query "cargo ship" [--kind video] [--limit 20] [--json]

Local/file packages (no implicit registry)

  cut package init <directory> --name <package> [--version 0.1.0] [--entry index.cut] [--json]
  cut package add <file-source> [--project <directory>] [--exact] [--json]
  cut package remove <name> [--project <directory>] [--json]
  cut package list [--project <directory>] [--json]
  cut package update [--project <directory>] [--name <direct-dependency>] [--exact] [--json]
  cut package lock [--project <directory>] [--json]
  cut package verify [--project <directory>] [--json]

The 0.3 av-build/av-inspect/av-test/av-diff/av-render spellings remain
temporary aliases. Model-assisted pre-formal workflows are quarantined under:

  cut legacy <command> ...

Legacy commands: ingest, see, build, test, explain, render, diff, research,
produce, critique, direct, compose, improve, revise, and auth. They are not
part of the typed CUT execution contract.
`);
}

function printDiagnostic(path: string, diagnostic: LanguageDiagnostic) {
  const marker = diagnostic.severity === "error" ? red("error") : diagnostic.severity === "warning" ? yellow("warning") : cyan("info");
  console.error(`${diagnostic.module ?? path}:${diagnostic.span.start.line}:${diagnostic.span.start.column} ${marker} ${diagnostic.code}: ${diagnostic.message}`);
  if (diagnostic.hint) console.error(dim(`  ${diagnostic.hint}`));
}

async function packageContextForProgram(path: string): Promise<CutExternalPackageContext | undefined> {
  const program = resolve(path), projectRoot = dirname(program), manifestPath = resolve(projectRoot, cutPackageManifestFile);
  const manifestMetadata = await lstat(manifestPath).catch(() => undefined);
  if (!manifestMetadata) return undefined;
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) throw new CutPackageError("CUT_PACKAGE_MANIFEST_FILE", cutPackageManifestFile, "must be a regular, non-symlink file.");
  const lockPath = resolve(projectRoot, cutPackageLockFile), lockMetadata = await lstat(lockPath).catch(() => undefined);
  if (!lockMetadata) throw new CutPackageError("CUT_PACKAGE_LOCK_MISSING", cutPackageLockFile, "is required beside a packaged CUT entry; run `cut package update`.");
  if (lockMetadata.isSymbolicLink() || !lockMetadata.isFile()) throw new CutPackageError("CUT_PACKAGE_LOCK_FILE", cutPackageLockFile, "must be a regular, non-symlink file.");
  const lock = loadCutPackageLock(await readFile(lockPath)), graph = await resolveVerifiedCutPackageGraph(projectRoot, lock);
  const entryPath = resolve(projectRoot, ...graph.root.manifest.entry.split("/"));
  if (entryPath !== program) throw new CutPackageError("CUT_PACKAGE_ENTRY_MISMATCH", path, `packaged commands must target manifest entry ${JSON.stringify(graph.root.manifest.entry)}.`);
  return createCutExternalPackageContext(graph);
}

async function verifiedPackageLock(projectDirectory: string) {
  const projectRoot = resolve(projectDirectory), lockPath = resolve(projectRoot, cutPackageLockFile);
  const lockMetadata = await lstat(lockPath).catch(() => undefined);
  if (!lockMetadata) throw new CutPackageError("CUT_PACKAGE_LOCK_MISSING", cutPackageLockFile, "does not exist; run `cut package lock`.");
  if (lockMetadata.isSymbolicLink() || !lockMetadata.isFile()) throw new CutPackageError("CUT_PACKAGE_LOCK_FILE", cutPackageLockFile, "must be a regular, non-symlink file.");
  const graph = await resolveVerifiedCutPackageGraph(projectRoot, loadCutPackageLock(await readFile(lockPath)));
  return graph.lock;
}

function emitPackageCommandSuccess(command: string, payload: Record<string, unknown>, human: () => void) {
  if (process.argv.includes("--json")) {
    process.stdout.write(`${stableJsonStringify({ format: "cut-package-command-report", version: 1, command: `package ${command}`, status: "pass", ...payload })}\n`);
  } else human();
}

const maximumCliStdinBytes = 8 * 1024 * 1024;

function codedCliError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

async function readBoundedCliStdin() {
  if (process.stdin.isTTY) throw codedCliError("CUT_STDIN_REQUIRED", "--stdin requires UTF-8 CUT source on standard input.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maximumCliStdinBytes) throw codedCliError("CUT_STDIN_LIMIT", `Standard input exceeds the ${maximumCliStdinBytes}-byte CUT source limit.`);
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw codedCliError("CUT_STDIN_UTF8", "Standard input is not valid UTF-8 CUT source.");
  }
}

async function analyzeLanguageProgram(path: string, sourceOverride?: string) {
  const source = sourceOverride ?? await readFile(resolve(path), "utf8"), externalPackages = await packageContextForProgram(path);
  return analyzeCutLanguageProgramSource(path, source, externalPackages);
}

class CutCliLanguageError extends Error {
  constructor(readonly path: string, readonly diagnostics: readonly LanguageDiagnostic[]) {
    super(`CUT language validation failed with ${diagnostics.filter((item) => item.severity === "error").length} error(s).`);
    this.name = "CutCliLanguageError";
  }
}

async function languageProgram(path: string, sourceOverride?: string) {
  const analysis = await analyzeLanguageProgram(path, sourceOverride);
  if (!process.argv.includes("--json")) analysis.diagnostics.forEach((diagnostic) => printDiagnostic(analysis.diagnosticPath, diagnostic));
  if (!analysis.module || analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new CutCliLanguageError(analysis.diagnosticPath, analysis.diagnostics);
  }
  if (!analysis.compiled) throw new Error("Validated CUT program did not retain its compiled result.");
  return {
    module: analysis.module,
    externalPackages: analysis.externalPackages,
    userModules: analysis.userModules,
    compileInputs: analysis.compileInputs,
    compiled: analysis.compiled,
  };
}

function option(name: string, fallback?: string) {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be supplied only once`);
  if (!indexes.length) return fallback;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

type CliOptionKind = "flag" | "value";
type CliCommandSchema = Readonly<{
  options: Readonly<Record<string, CliOptionKind>>;
  positionals: number;
  requiredOptions: readonly string[];
}>;

class CutCliUsageError extends Error {
  constructor(readonly code: string, readonly command: string, message: string) {
    super(message);
    this.name = "CutCliUsageError";
  }
}

const schema = (positionals: number, options: Readonly<Record<string, CliOptionKind>> = {}, requiredOptions: readonly string[] = []): CliCommandSchema => ({ positionals, options, requiredOptions });

/**
 * Closed option contracts for every exposed CLI command. These are deliberately
 * independent of command execution so an unsupported flag fails before file,
 * media, model, or subprocess work can begin.
 */
const cliCommandSchemas: Readonly<Record<string, CliCommandSchema>> = Object.freeze({
  help: schema(0, { "--json": "flag" }),
  version: schema(0),
  init: schema(1, { "--name": "value" }),
  project: schema(1),
  doctor: schema(0, { "--json": "flag" }),
  review: schema(1, { "--json": "flag" }),
  "review-study": schema(1, { "--json": "flag" }),
  fmt: schema(1, { "--check": "flag", "--stdout": "flag", "--json": "flag", "--stdin": "flag" }),
  check: schema(1, { "--json": "flag", "--stdin": "flag" }),
  lint: schema(1, { "--deny-warnings": "flag", "--json": "flag" }),
  migrate: schema(1, { "--check": "flag", "--out": "value", "--json": "flag" }),
  relink: schema(1, { "--asset": "value", "--to": "value", "--write": "flag", "--json": "flag" }, ["--asset", "--to"]),
  probe: schema(1, { "--project": "value", "--out": "value" }),
  proxy: schema(1, { "--project": "value", "--out": "value", "--width": "value", "--stream": "value", "--json": "flag" }, ["--project", "--out", "--width"]),
  lock: schema(1, { "--out": "value", "--json": "flag" }),
  build: schema(1, { "--lock": "value", "--out": "value", "--json": "flag" }),
  inspect: schema(1, { "--lock": "value", "--json": "flag" }),
  test: schema(1, { "--lock": "value", "--json": "flag" }),
  diff: schema(2, { "--json": "flag" }),
  "otio-export": schema(1, { "--lock": "value", "--out": "value", "--report": "value", "--composition": "value", "--allow-lossy": "flag" }, ["--lock", "--out"]),
  "otio-import": schema(1, { "--out": "value", "--report": "value", "--fps": "value", "--width": "value", "--height": "value", "--sample-rate": "value", "--project-name": "value", "--timeline-name": "value", "--allow-lossy": "flag" }, ["--out"]),
  frame: schema(1, { "--lock": "value", "--out": "value", "--frame": "value", "--at": "value", "--output": "value", "--profile": "value", "--json": "flag" }, ["--lock", "--out"]),
  contact: schema(1, { "--lock": "value", "--out": "value", "--frames": "value", "--columns": "value", "--thumbnail-width": "value", "--output": "value", "--profile": "value", "--json": "flag" }, ["--lock", "--out", "--frames"]),
  audition: schema(1, { "--lock": "value", "--out": "value", "--samples": "value", "--stem": "value", "--output": "value", "--profile": "value", "--json": "flag" }, ["--lock", "--out", "--samples"]),
  preview: schema(1, { "--lock": "value", "--out": "value", "--output": "value", "--range": "value", "--width": "value", "--json": "flag" }, ["--lock"]),
  render: schema(1, { "--lock": "value", "--out": "value", "--output": "value", "--stems": "value", "--json": "flag" }, ["--lock", "--out"]),
  "agent-author": schema(1, { "--out": "value", "--provider": "value", "--model": "value", "--attempts": "value", "--report": "value", "--trace": "value", "--json": "flag" }, ["--out"]),
  "agent-repair": schema(1, { "--brief": "value", "--out": "value", "--provider": "value", "--model": "value", "--attempts": "value", "--report": "value", "--trace": "value", "--json": "flag" }, ["--brief", "--out"]),
  "package-init": schema(1, { "--name": "value", "--version": "value", "--entry": "value", "--json": "flag" }, ["--name"]),
  "package-add": schema(1, { "--project": "value", "--exact": "flag", "--json": "flag" }),
  "package-remove": schema(1, { "--project": "value", "--json": "flag" }),
  "package-list": schema(0, { "--project": "value", "--json": "flag" }),
  "package-update": schema(0, { "--project": "value", "--name": "value", "--exact": "flag", "--json": "flag" }),
  "package-lock": schema(0, { "--project": "value", "--json": "flag" }),
  "package-verify": schema(0, { "--project": "value", "--json": "flag" }),
  "asset-search": schema(1, { "--query": "value", "--kind": "value", "--limit": "value", "--json": "flag" }, ["--query"]),

  "legacy-auth": schema(1),
  "legacy-ingest": schema(1, { "--out": "value", "--transcribe": "flag" }),
  "legacy-see": schema(0, { "--index": "value", "--out": "value", "--model": "value" }),
  "legacy-build": schema(1, { "--index": "value", "--semantic": "flag", "--provider": "value" }),
  "legacy-test": schema(1, { "--index": "value", "--semantic": "flag", "--provider": "value" }),
  "legacy-explain": schema(1, { "--index": "value", "--semantic": "flag", "--provider": "value" }),
  "legacy-render": schema(1, { "--index": "value", "--semantic": "flag", "--provider": "value", "--out": "value" }),
  "legacy-diff": schema(2),
  "legacy-research": schema(1, { "--out": "value" }),
  "legacy-produce": schema(1, { "--out-dir": "value" }),
  "legacy-critique": schema(1, { "--manifest": "value", "--out": "value" }),
  "legacy-direct": schema(1, { "--out": "value", "--index": "value", "--style": "value", "--provider": "value" }),
  "legacy-compose": schema(1, { "--research": "value", "--out": "value", "--style": "value" }),
  "legacy-improve": schema(1, { "--research": "value", "--out-dir": "value", "--passes": "value", "--style": "value" }),
  "legacy-revise": schema(1, { "--critique": "value", "--out": "value" }),
});

function commandLabel(command: string) {
  if (command.startsWith("legacy-")) return `legacy ${command.slice("legacy-".length)}`;
  if (command.startsWith("package-")) return `package ${command.slice("package-".length)}`;
  if (command.startsWith("agent-")) return `agent ${command.slice("agent-".length)}`;
  if (command.startsWith("asset-")) return `asset ${command.slice("asset-".length)}`;
  return command.replace("otio-", "otio ");
}

function cliHelpReport() {
  const commands = Object.entries(cliCommandSchemas).map(([command, contract]) => ({
    command: commandLabel(command),
    category: command.startsWith("legacy-") ? "legacy" : command.startsWith("package-") ? "package" : command.startsWith("agent-") ? "agent" : command.startsWith("otio-") ? "interchange" : "formal",
    stability: command.startsWith("legacy-") ? "legacy" : "alpha",
    positionals: contract.positionals,
    options: Object.entries(contract.options).sort(([left], [right]) => left.localeCompare(right)).map(([name, kind]) => ({ name, kind, required: contract.requiredOptions.includes(name) })),
  })).sort((left, right) => left.command.localeCompare(right.command));
  return {
    format: "cut-cli-reference",
    version: 1,
    status: "pass",
    product: {
      name: "cut",
      version: cutProductVersion,
      language: cutLanguageVersion,
      ir: cutIrVersion,
      packageAbi: cutPackageAbi,
      compiler: cutCompilerIdentity,
      runtime: cutReferenceRuntimeIdentity,
    },
    commands,
    aliases: {
      "av-build": "build",
      "av-diff": "diff",
      "av-inspect": "inspect",
      "av-render": "render",
      "av-test": "test",
      "--help": "help",
      "--version": "version",
      "-v": "version",
    },
    summary: {
      commands: commands.length,
      formal: commands.filter((command) => command.category === "formal").length,
      interchange: commands.filter((command) => command.category === "interchange").length,
      package: commands.filter((command) => command.category === "package").length,
      agent: commands.filter((command) => command.category === "agent").length,
      legacy: commands.filter((command) => command.category === "legacy").length,
    },
  };
}

function requestedCommandLabel() {
  const raw = process.argv[2];
  if (raw === "otio") return `otio ${process.argv[3] ?? ""}`.trim();
  if (raw === "legacy") return `legacy ${process.argv[3] ?? ""}`.trim();
  if (raw === "package") return `package ${process.argv[3] ?? ""}`.trim();
  if (raw === "agent") return `agent ${process.argv[3] ?? ""}`.trim();
  if (raw === "asset") return `asset ${process.argv[3] ?? ""}`.trim();
  if (raw === "--version" || raw === "-v") return "version";
  return raw ?? "cut";
}

function validateCliInvocation(command: string, tokens: string[]) {
  const contract = cliCommandSchemas[command];
  if (!contract) return;
  const label = commandLabel(command), supplied = new Set<string>();
  let positionals = 0, sawOption = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("-")) {
      sawOption = true;
      const kind = contract.options[token];
      if (!kind) throw new CutCliUsageError("CUTC1001", label, `Unknown option ${JSON.stringify(token)} for ${label}.`);
      if (supplied.has(token)) throw new CutCliUsageError("CUTC1002", label, `Option ${JSON.stringify(token)} may be supplied only once for ${label}.`);
      supplied.add(token);
      if (kind === "value") {
        const value = tokens[index + 1];
        if (!value || value.startsWith("-")) throw new CutCliUsageError("CUTC1003", label, `Option ${JSON.stringify(token)} requires a value for ${label}.`);
        index += 1;
      }
      continue;
    }
    if (sawOption) throw new CutCliUsageError("CUTC1004", label, `Positional arguments must precede options for ${label}; found ${JSON.stringify(token)}.`);
    positionals += 1;
    if (positionals > contract.positionals) throw new CutCliUsageError("CUTC1004", label, `Unexpected positional argument ${JSON.stringify(token)} for ${label}.`);
  }
  if (positionals < contract.positionals) {
    throw new CutCliUsageError("CUTC1005", label, `${label} requires ${contract.positionals === 1 ? "one positional argument" : `${contract.positionals} positional arguments`}.`);
  }
  const missing = contract.requiredOptions.filter((name) => !supplied.has(name));
  if (missing.length) throw new CutCliUsageError("CUTC1006", label, `${label} requires ${missing.join(" and ")}.`);
}

async function codex(args: string[]) {
  await new Promise<void>((accept, reject) => {
    const child = spawn("codex", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`codex exited with status ${code}`)));
  });
}

async function loadIndex(path = ".cut/index.json"): Promise<MediaIndex> {
  const index = JSON.parse(await readFile(resolve(path), "utf8")) as MediaIndex;
  if (mediaIndexHash(index) !== index.indexHash) throw new Error("Media index integrity check failed. Run cut ingest again.");
  return index;
}

async function compile(programPath: string, indexPath?: string) {
  const [source, index] = await Promise.all([readFile(resolve(programPath), "utf8"), loadIndex(indexPath)]);
  const catalog = catalogFromIndex(index);
  let semanticPlan;
  if (process.argv.includes("--semantic")) {
    const apiKey = process.env.OPENAI_API_KEY;
    const provider = option("--provider", "auto");
    if (!provider || !["auto", "chatgpt", "api"].includes(provider)) throw new Error("--provider must be auto, chatgpt, or api");
    if (provider === "api" || (provider === "auto" && apiKey)) {
      if (!apiKey) throw new Error("--provider api requires OPENAI_API_KEY");
      console.log(`${cyan("plan")} GPT-5.6 API is selecting locked source moments…`);
      semanticPlan = await planWithOpenAI(source, catalog, apiKey, process.env.OPENAI_MODEL ?? "gpt-5.6");
    } else {
      console.log(`${cyan("plan")} Codex is planning with your ChatGPT subscription…`);
      semanticPlan = await planWithCodex(source, catalog);
    }
  }
  return { source, index, artifact: buildArtifact(source, index, catalog, semanticPlan) };
}

async function saveBuild(artifact: BuildArtifact) {
  const directory = resolve(".cut", "builds", artifact.buildId);
  const artifactPath = resolve(directory, "timeline.cutir.json");
  const cached = await access(artifactPath).then(() => true).catch(() => false);
  await mkdir(directory, { recursive: true });
  if (!cached) await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
  await writeFile(resolve(".cut", "latest.json"), JSON.stringify(artifact, null, 2));
  return { directory, cached };
}

async function main() {
  let [, , command, subject] = process.argv;
  if (!command) return usage();
  if (command === "help" || command === "--help") {
    validateCliInvocation("help", process.argv.slice(3));
    if (process.argv.includes("--json")) {
      process.stdout.write(`${stableJsonStringify(cliHelpReport())}\n`);
      return;
    }
    return usage();
  }
  if (command === "version" || command === "--version" || command === "-v") {
    validateCliInvocation("version", process.argv.slice(3));
    console.log(cutVersionLine());
    return;
  }
  const formalAliases: Record<string, string> = {
    "av-build": "build",
    "av-inspect": "inspect",
    "av-test": "test",
    "av-diff": "diff",
    "av-render": "render",
  };
  if (formalAliases[command]) command = formalAliases[command];
  if (command === "otio") {
    if (subject !== "export" && subject !== "import") throw new Error("otio needs the export or import subcommand");
    command = `otio-${subject}`;
    subject = process.argv[4];
  }
  if (command === "legacy") {
    const legacyCommands = ["ingest", "see", "build", "test", "explain", "render", "diff", "research", "produce", "critique", "direct", "compose", "improve", "revise", "auth"];
    if (!subject || !legacyCommands.includes(subject)) {
      throw new Error(`legacy needs one of: ${legacyCommands.join(", ")}`);
    }
    command = `legacy-${subject}`;
    subject = process.argv[4];
  }
  if (command === "package") {
    const packageCommands = ["init", "add", "remove", "list", "update", "lock", "verify"];
    if (!subject || !packageCommands.includes(subject)) throw new Error(`package needs one of: ${packageCommands.join(", ")}`);
    command = `package-${subject}`;
    subject = process.argv[4];
  }
  if (command === "agent") {
    const agentCommands = ["author", "repair"];
    if (!subject || !agentCommands.includes(subject)) throw new Error(`agent needs one of: ${agentCommands.join(", ")}`);
    command = `agent-${subject}`;
    subject = process.argv[4];
  }
  if (command === "asset") {
    if (subject !== "search") {
      throw new CutCliUsageError("CUTC1007", "asset", "asset needs the search subcommand.");
    }
    command = "asset-search";
    subject = process.argv[4];
  }
  validateCliInvocation(command, process.argv.slice(command.startsWith("otio-") || command.startsWith("legacy-") || command.startsWith("package-") || command.startsWith("agent-") || command.startsWith("asset-") ? 4 : 3));
  if (command === "asset-search") {
    if (!subject) throw new Error("asset search needs one catalog JSON file");
    const query = option("--query")!;
    const kind = option("--kind") as CutAssetCatalogKind | undefined;
    const limitText = option("--limit");
    if (limitText !== undefined && (!/^[1-9][0-9]*$/u.test(limitText) || !Number.isSafeInteger(Number(limitText)))) {
      throw new CutCliUsageError("CUTC1007", "asset search", "--limit must be one positive safe integer.");
    }
    const catalog = await loadCutAssetCatalogFile(resolve(subject));
    const report = searchCutAssetCatalog(catalog, {
      query,
      ...(kind === undefined ? {} : { kind }),
      ...(limitText === undefined ? {} : { limit: Number(limitText) }),
    });
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else {
      console.log(`${green("✓")} ${report.results.length} candidate${report.results.length === 1 ? "" : "s"} from ${report.catalog.name}`);
      for (const entry of report.results) {
        console.log(`${cyan(entry.id)} · ${entry.kind} · ${entry.label}`);
        console.log(dim(`  ${entry.provenance.creator} · ${entry.provenance.license} · ${entry.sha256.slice(0, 16)} · ${entry.bytes} bytes`));
        console.log(dim(`  ${entry.downloadUrl}`));
      }
      console.log(yellow("Candidates are not CUT runtime authority. Copy selected bytes project-locally, verify the declared hash, probe media, declare the asset, then run cut lock."));
    }
    return;
  }
  if (command === "agent-author" || command === "agent-repair") {
    if (!subject) throw new Error(`${commandLabel(command)} needs one positional input`);
    const provider = option("--provider", "chatgpt");
    if (provider !== "chatgpt" && provider !== "api") throw new CutCliUsageError("CUTC1007", commandLabel(command), "--provider must be chatgpt or api.");
    const attemptsRaw = option("--attempts", "3")!;
    if (!/^[1-3]$/.test(attemptsRaw)) throw new CutCliUsageError("CUTC1007", commandLabel(command), "--attempts must be an integer from 1 to 3.");
    const output = option("--out")!;
    const mode = command === "agent-author" ? "author" : "repair";
    const report = await runCutAgent({
      mode,
      briefPath: mode === "author" ? subject : option("--brief")!,
      ...(mode === "repair" ? { sourcePath: subject } : {}),
      outputPath: output,
      provider: provider as CutAgentProvider,
      model: option("--model", provider === "chatgpt" ? "gpt-5.6-luna" : "gpt-5.6")!,
      maximumAttempts: Number(attemptsRaw),
      machineReference: stableJsonStringify(cliHelpReport()),
      reportPath: option("--report"),
      traceDirectory: option("--trace"),
    });
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else {
      for (const attempt of report.attempts) {
        const marker = attempt.status === "valid" ? green("VALID") : attempt.status === "invalid" ? yellow("REPAIR") : red("FAILED");
        console.log(`${marker} attempt ${attempt.attempt} · ${attempt.diagnostics.filter((item) => item.severity === "error").length} compiler/provider error(s)`);
        attempt.diagnostics.filter((item) => item.severity === "error").slice(0, 4).forEach((item) => console.log(dim(`  ${item.code}${item.source ? ` ${item.source.line}:${item.source.column}` : ""} ${item.message}`)));
      }
      if (report.status === "pass") console.log(`${green("✓")} ${report.command} wrote formatted, checked CUT source → ${output}`);
      else console.log(red(`${report.command} produced no valid source; output was not created`));
    }
    if (report.status === "fail") process.exitCode = 1;
    return;
  }
  if (command === "package-init") {
    if (!subject) throw new Error("package init needs a directory");
    const name = option("--name"); if (!name) throw new Error("package init requires --name <package>");
    const created = await initCutPackage(subject, { name, version: option("--version"), entry: option("--entry") });
    emitPackageCommandSuccess("init", {
      project: created.manifest.name,
      packageVersion: created.manifest.version,
      lockIntegrity: created.lock.integrity,
      packages: created.lock.packages.length,
    }, () => {
      console.log(`${green("✓")} initialized ${created.manifest.name}@${created.manifest.version}`);
      console.log(dim(`  ${created.root}`));
    });
    return;
  }
  if (command === "package-add") {
    if (!subject) throw new Error("package add needs a local/file package source");
    const projectRoot = option("--project", ".")!;
    const added = await addCutPackageDependency(projectRoot, subject, { exact: process.argv.includes("--exact") });
    emitPackageCommandSuccess("add", {
      project: added.manifest.name,
      dependency: added.dependency,
      lockIntegrity: added.lock.integrity,
      packages: added.lock.packages.length,
    }, () => console.log(`${green("✓")} added ${added.dependency} and wrote ${cutPackageLockFile}`));
    return;
  }
  if (command === "package-remove") {
    if (!subject) throw new Error("package remove needs a direct dependency name");
    const removed = await removeCutPackageDependency(option("--project", ".")!, subject);
    emitPackageCommandSuccess("remove", {
      project: removed.manifest.name,
      dependency: removed.dependency,
      lockIntegrity: removed.lock.integrity,
      packages: removed.lock.packages.length,
    }, () => console.log(`${green("✓")} removed ${removed.dependency} and wrote ${cutPackageLockFile}`));
    return;
  }
  if (command === "package-list") {
    const listed = await listCutPackageDependencies(option("--project", ".")!);
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify({ format: "cut-package-list", version: 1, ...listed })}\n`);
    else console.log(formatCutPackageList(listed));
    return;
  }
  if (command === "package-update") {
    const name = option("--name"), updated = await updateCutPackageDependencies(option("--project", ".")!, name ? [name] : undefined, { exact: process.argv.includes("--exact") });
    emitPackageCommandSuccess("update", {
      project: updated.manifest.name,
      updated: updated.updated,
      lockIntegrity: updated.lock.integrity,
      packages: updated.lock.packages.length,
    }, () => console.log(`${green("✓")} updated ${updated.updated.length ? updated.updated.join(", ") : "dependency lock"}`));
    return;
  }
  if (command === "package-lock") {
    const lock = await regenerateCutPackageLock(option("--project", ".")!);
    emitPackageCommandSuccess("lock", {
      project: lock.project.name,
      packageVersion: lock.project.version,
      lockIntegrity: lock.integrity,
      packages: lock.packages.length,
    }, () => console.log(`${green("✓")} locked ${lock.project.name}@${lock.project.version} · ${lock.packages.length} package${lock.packages.length === 1 ? "" : "s"}`));
    return;
  }
  if (command === "package-verify") {
    const lock = await verifiedPackageLock(option("--project", ".")!);
    emitPackageCommandSuccess("verify", {
      project: lock.project.name,
      packageVersion: lock.project.version,
      lockIntegrity: lock.integrity,
      packages: lock.packages.length,
    }, () => console.log(`${green("✓")} verified ${lock.project.name}@${lock.project.version} · ${lock.packages.length} package${lock.packages.length === 1 ? "" : "s"}`));
    return;
  }
  if (command === "doctor") {
    const report = await collectCutDoctorReport();
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else {
      for (const check of report.checks) {
        const marker = check.status === "pass" ? green("PASS") : red("FAIL");
        console.log(`${marker} ${check.name.padEnd(22)} ${check.detail}`);
        if (check.remedy) console.log(dim(`     ${check.remedy}`));
      }
      console.log(report.status === "pass" ? `${green("✓")} bounded CUT prerequisite probe passed` : red("CUT prerequisite probe failed; resolve the checks above before rendering"));
    }
    if (report.status === "fail") process.exitCode = 1;
    return;
  }
  if (command === "review") {
    if (!subject) throw new Error("review needs a cut-professional-output-review v1 JSON artifact");
    const report = await reviewProfessionalOutputFile(subject);
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else {
      for (const category of report.categories) {
        const marker = category.status === "pass" ? green("PASS") : red("FAIL");
        console.log(`${marker} ${category.id.padEnd(28)} implementer ${category.scores.implementer}/10 · independent ${category.scores.independent}/10 · ${category.evidenceItems.implementer + category.evidenceItems.independent} timed evidence item(s)`);
      }
      for (const gate of report.gates) {
        const marker = gate.status === "pass" ? green("PASS") : red("FAIL");
        console.log(`${marker} ${gate.id.padEnd(28)} ${gate.detail}`);
      }
      console.log(report.status === "pass"
        ? `${green("✓")} professional-output evidence gate passed; this validates the retained review record, not taste automatically`
        : red("professional-output review requires revision; no category averaging is allowed"));
    }
    if (report.status === "revise") process.exitCode = 2;
    return;
  }
  if (command === "review-study") {
    if (!subject) throw new Error("review-study needs a cut-reference-study-review v1 JSON artifact");
    const report = await reviewReferenceStudyFile(subject);
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else {
      for (const requirement of report.requirements) {
        const marker = requirement.status === "pass" ? green("PASS") : red("FAIL");
        console.log(`${marker} ${requirement.id.padEnd(28)} ${requirement.evidenceItems} timecoded human observation(s)`);
      }
      for (const gate of report.gates) {
        const marker = gate.status === "pass" ? green("PASS") : red("FAIL");
        console.log(`${marker} ${gate.id.padEnd(28)} ${gate.detail}`);
      }
      console.log(report.status === "pass"
        ? `${green("✓")} reference-study evidence gate passed; this validates the retained human review record, not taste automatically`
        : red("reference-study review requires revision; every pattern and playback/listening gate is conjunctive"));
    }
    if (report.status === "revise") process.exitCode = 2;
    return;
  }
  if (command === "migrate") {
    if (!subject) throw new Error("migrate needs a CUT source, CutAVIR, lock, or project manifest artifact");
    const checkOnly = process.argv.includes("--check"), output = option("--out"), emitJson = process.argv.includes("--json");
    if (checkOnly && output) throw new CutCliUsageError("CUTC1007", "migrate", "migrate --check and --out are mutually exclusive; inspection is read-only and migration always writes a distinct explicit output.");
    const paths = await inspectCutMigrationPaths(subject, output);
    const analysis = analyzeCutMigration(await readFile(paths.input.real), { path: subject, protectedInput: paths.input.protected });
    let report = analysis.report;
    if (output) {
      if (!analysis.output || !paths.output) {
        throw Object.assign(new Error("The artifact is already current; migrate --out does not create redundant copies."), { code: "CUT_MIGRATE_NOT_NEEDED", path: subject });
      }
      await writeCutMigrationOutput(paths.output, analysis.output);
      report = completedCutMigrationReport(report);
    } else if (report.status === "migration-available") process.exitCode = 2;
    if (emitJson) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else if (report.status === "current") console.log(`${green("✓")} ${subject} is already current; input bytes were not changed`);
    else if (report.status === "migrated") {
      console.log(`${green("✓")} wrote ${output} with zero semantic audiovisual changes`);
      console.log(dim(`  ${report.transformation.changedDerivedFields.length} derived identity field${report.transformation.changedDerivedFields.length === 1 ? "" : "s"} · ${report.output?.sha256}`));
    } else {
      console.log(`${yellow("MIGRATION")} verified ${report.transformation.id}`);
      console.log(dim(`  zero semantic changes · rerun with --out <distinct-new-file>`));
    }
    return;
  }
  if (command === "init") {
    if (!subject) throw new Error("init needs a project directory");
    const created = await createCutProject(subject, option("--name"));
    console.log(`${green("✓")} initialized ${created.manifest.name}`);
    console.log(dim(`  ${created.root}`));
    console.log(dim(`  next: cd ${subject} && npx --no-install cut check ${created.manifest.entry}`));
    return;
  }
  if (command === "project") {
    if (!subject) throw new Error("project needs a directory containing cut.project.json");
    const project = await loadCutProject(subject);
    await languageProgram(project.entryPath);
    console.log(`${green("✓")} ${project.manifest.name} is a valid CUT project`);
    console.log(`${project.manifest.entry} · ${project.manifest.defaults.width}×${project.manifest.defaults.height} · ${project.manifest.defaults.fps} fps · ${project.manifest.defaults.sampleRate} Hz`);
    return;
  }
  if (command === "relink") {
    if (!subject) throw new Error("relink needs a CUT program");
    const asset = option("--asset"), locator = option("--to"), emitJson = process.argv.includes("--json");
    if (!asset) throw new CutCliUsageError("CUTC1006", "relink", "relink requires --asset <declaration-name>.");
    if (!locator) throw new CutCliUsageError("CUTC1006", "relink", "relink requires --to <project-relative-path>.");
    const externalPackages = await packageContextForProgram(subject);
    const report = await relinkCutSource({
      programPath: subject,
      assetName: asset,
      locator,
      write: process.argv.includes("--write"),
      packages: externalPackages?.packages,
    });
    if (emitJson) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else if (report.status === "written") {
      console.log(`${green("✓")} relinked ${report.asset.name}: ${JSON.stringify(report.locator.from)} → ${JSON.stringify(report.locator.to)}`);
      console.log(dim(`  ${report.program}:${report.asset.source.line}:${report.asset.source.column}`));
      console.log(yellow("  Existing cut.lock files are now stale; run cut lock again."));
    } else if (report.status === "unchanged") {
      console.log(`${green("✓")} ${report.asset.name} already uses ${JSON.stringify(report.locator.to)}; source is unchanged`);
    } else {
      console.log(`${cyan("DRY RUN")} ${report.asset.name}: ${JSON.stringify(report.locator.from)} → ${JSON.stringify(report.locator.to)}`);
      console.log(dim(`  validated ${report.asset.type} · ${report.probe.identity.file.sha256.slice(0, 16)}`));
      console.log(dim("  no source was changed; rerun with --write to commit this one-literal edit"));
    }
    return;
  }
  if (command === "fmt") {
    if (!subject) throw new Error("fmt needs a CUT program");
    const emitStdout = process.argv.includes("--stdout"), emitJson = process.argv.includes("--json"), checkOnly = process.argv.includes("--check"), fromStdin = process.argv.includes("--stdin");
    if (emitStdout && emitJson) throw new Error("fmt --stdout and --json cannot be combined");
    if (fromStdin && (!emitStdout || emitJson || checkOnly)) throw new CutCliUsageError("CUTC1007", "fmt", "fmt --stdin requires --stdout and cannot be combined with --check or --json.");
    const absolute = resolve(subject), metadata = fromStdin ? undefined : await lstat(absolute);
    if (metadata && (metadata.isSymbolicLink() || !metadata.isFile())) throw new Error("fmt accepts only a regular, non-symlink CUT source file");
    const source = fromStdin ? await readBoundedCliStdin() : await readFile(absolute, "utf8"), formatted = formatCutSource(source), changed = source !== formatted;
    if (emitStdout) process.stdout.write(formatted);
    else if (!checkOnly && changed) {
      const temporary = resolve(dirname(absolute), `.${basename(absolute)}.${process.pid}.cut-fmt.tmp`);
      try {
        await writeFile(temporary, formatted, { flag: "wx", mode: metadata!.mode });
        await rename(temporary, absolute);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const report = { format: "cut-format-report", version: 1, program: basename(absolute), status: changed ? checkOnly ? "needs-format" : emitStdout ? "formatted-stdout" : "formatted" : "unchanged", changed };
    if (emitJson) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else if (!emitStdout) console.log(changed ? checkOnly ? `${yellow("FORMAT")} ${basename(absolute)} needs formatting` : `${green("✓")} formatted ${basename(absolute)}` : `${green("✓")} ${basename(absolute)} is already formatted`);
    if (checkOnly && changed) process.exitCode = 2;
    return;
  }
  if (command === "probe") {
    if (!subject) throw new Error("probe needs a project-relative media locator");
    const projectRoot = resolve(option("--project", ".")!);
    const probe = await probeProjectMedia(projectRoot, subject);
    const encoded = `${JSON.stringify(probe, null, 2)}\n`;
    const output = option("--out");
    if (output) {
      const absolute = resolve(output);
      await writeProjectArtifacts([projectRoot, process.cwd()], [
        { destination: absolute, contents: encoded, role: "probe-report" },
      ]);
      console.log(`${green("✓")} probed ${probe.file.locator} · ${probe.streams.length} stream(s) · ${probe.file.sha256.slice(0, 16)}`);
      console.log(dim(`  ${absolute}`));
    } else process.stdout.write(encoded);
    return;
  }
  if (command === "proxy") {
    if (!subject) throw new Error("proxy needs a project-relative video locator");
    const widthText = option("--width")!;
    if (!/^[1-9][0-9]*$/u.test(widthText)
      || !Number.isSafeInteger(Number(widthText))
      || Number(widthText) < 64
      || Number(widthText) > cutVideoProxyGenerationPolicy.maximumWidth
      || Number(widthText) % 2 !== 0) {
      throw new CutCliUsageError(
        "CUTC1007",
        "proxy",
        `--width must be one even integer from 64 through ${cutVideoProxyGenerationPolicy.maximumWidth}.`,
      );
    }
    const streamText = option("--stream");
    if (streamText !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(streamText) || !Number.isSafeInteger(Number(streamText)))) {
      throw new CutCliUsageError("CUTC1007", "proxy", "--stream must be one non-negative safe integer.");
    }
    const report = await generateCutVideoProxy({
      projectRoot: option("--project")!,
      input: subject,
      output: option("--out")!,
      width: Number(widthText),
      ...(streamText === undefined ? {} : { streamIndex: Number(streamText) }),
    });
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else {
      console.log(`${green("✓")} generated ${report.proxy.width}×${report.proxy.height} authenticated proxy · ${report.proxy.bytes} bytes`);
      console.log(dim(`  ${report.proxy.locator} · ${report.proxy.sha256}`));
      console.log(dim(`  author on the VideoAsset: ${report.authoring.proxyArgument}`));
      console.log(yellow("  Generated bytes are not selected until source is edited and cut lock is regenerated."));
    }
    return;
  }
  if (command === "diff") {
    const afterPath = process.argv[4];
    if (!subject || !afterPath) throw new Error("diff needs two CutAVIR v3 .cutir.json artifacts");
    const [beforeSource, afterSource] = await Promise.all([readFile(resolve(subject)), readFile(resolve(afterPath))]);
    let before, after;
    try { before = loadCutAvIr(beforeSource); }
    catch (error) { throw new Error(`before CutAVIR: ${error instanceof Error ? error.message : String(error)}`); }
    try { after = loadCutAvIr(afterSource); }
    catch (error) { throw new Error(`after CutAVIR: ${error instanceof Error ? error.message : String(error)}`); }
    const diff = diffCutAVIR(before, after);
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(diff)}\n`);
    else console.log(formatCutAVIRSemanticDiff(diff));
    if (diff.changes.length) process.exitCode = 2;
    return;
  }
  if (command === "otio-export") {
    if (!subject) throw new Error("otio export needs a CUT program");
    const lockPath = option("--lock"), outputPath = option("--out");
    if (!lockPath) throw new Error("otio export requires --lock cut.lock");
    if (!outputPath) throw new Error("otio export requires --out timeline.otio");
    const absoluteOutput = resolve(outputPath), reportPath = resolve(option("--report", `${outputPath}.report.json`)!);
    if (absoluteOutput === reportPath) throw new Error("otio timeline and report paths must be different");
    const program = await languageProgram(subject), { ir } = program.compiled, projectRoot = dirname(resolve(subject));
    await applyCutLock(ir, loadCutLock(await readFile(resolve(lockPath))), projectRoot);
    const exported = exportCutTimelineToOtio(ir, { compositionId: option("--composition"), allowLossy: process.argv.includes("--allow-lossy") });
    await writeProjectArtifacts([projectRoot, process.cwd()], [
      { destination: absoluteOutput, contents: `${JSON.stringify(exported.timeline, null, 2)}\n`, order: 100, role: "otio-timeline" },
      { destination: reportPath, contents: `${stableJsonStringify(exported.report)}\n`, order: 200, role: "otio-report" },
    ]);
    console.log(`${exported.report.status === "lossless-editorial" ? green("✓") : yellow("LOSSY")} exported ${exported.report.exported.clipInstances} clip instance(s) to ${absoluteOutput}`);
    console.log(dim(`  interchange report: ${reportPath}`));
    if (exported.report.status === "lossy-editorial" && !process.argv.includes("--allow-lossy")) process.exitCode = 2;
    return;
  }
  if (command === "otio-import") {
    if (!subject) throw new Error("otio import needs an OTIO JSON timeline");
    const outputPath = option("--out");
    if (!outputPath) throw new Error("otio import requires --out program.cut");
    if (!outputPath.endsWith(".cut")) throw new Error("otio import --out must name a .cut source file");
    const absoluteInput = resolve(subject), inputMetadata = await lstat(absoluteInput);
    if (inputMetadata.isSymbolicLink() || !inputMetadata.isFile()) throw new Error("otio import accepts only a regular, non-symlink OTIO JSON file");
    const absoluteOutput = resolve(outputPath), reportPath = resolve(option("--report", `${outputPath}.import.report.json`)!);
    if (absoluteOutput === reportPath || absoluteInput === absoluteOutput || absoluteInput === reportPath) throw new Error("otio input, CUT source, and import report paths must be different");
    const integerOption = (name: string) => {
      const raw = option(name); if (raw === undefined) return undefined;
      if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} must be a positive safe integer`);
      return Number(raw);
    };
    const imported = importOtioTimeline(await readFile(absoluteInput), {
      fps: option("--fps"),
      width: integerOption("--width"),
      height: integerOption("--height"),
      sampleRate: integerOption("--sample-rate"),
      projectName: option("--project-name"),
      timelineName: option("--timeline-name"),
      allowLossy: process.argv.includes("--allow-lossy"),
    });
    await Promise.all([mkdir(dirname(absoluteOutput), { recursive: true }), mkdir(dirname(reportPath), { recursive: true })]);
    const sourceTemporary = resolve(dirname(absoluteOutput), `.${basename(absoluteOutput)}.${process.pid}.otio-import.tmp`);
    const reportTemporary = resolve(dirname(reportPath), `.${basename(reportPath)}.${process.pid}.otio-import.tmp`);
    try {
      await Promise.all([
        writeFile(sourceTemporary, imported.source, { flag: "wx", mode: 0o644 }),
        writeFile(reportTemporary, `${stableJsonStringify(imported.report)}\n`, { flag: "wx", mode: 0o644 }),
      ]);
      await rename(sourceTemporary, absoluteOutput);
      await rename(reportTemporary, reportPath);
    } finally {
      await Promise.all([rm(sourceTemporary, { force: true }), rm(reportTemporary, { force: true })]);
    }
    console.log(`${imported.report.status === "lossless-editorial" ? green("✓") : yellow("LOSSY")} imported ${imported.report.imported.clips} OTIO clip(s) as ${imported.report.imported.generatedNodes} typed CUT node(s)`);
    console.log(dim(`  ${absoluteOutput}`));
    console.log(dim(`  import report: ${reportPath}`));
    return;
  }
  if (command === "lint") {
    if (!subject) throw new Error("lint needs a CUT 0.4 program");
    const analysis = await analyzeLanguageProgram(subject);
    const languageErrors = analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    const diagnostics = languageErrors || !analysis.module
      ? analysis.diagnostics
      : [
          ...analysis.diagnostics,
          ...lintCutModule(analysis.module),
          ...[...(analysis.userModules?.modules.values() ?? [])].flatMap((source) =>
            lintCutModule(source.module).map((diagnostic) => ({ ...diagnostic, module: source.specifier }))),
        ];
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
    const denyWarnings = process.argv.includes("--deny-warnings");
    const status = errors ? "fail" : warnings ? "warnings" : "pass";
    const report = {
      format: "cut-lint-report",
      version: 1,
      command: "lint",
      program: basename(subject),
      status,
      denyWarnings,
      summary: { errors, warnings, total: diagnostics.length },
      diagnostics: diagnostics.map((diagnostic) => ({
        ...diagnostic,
        source: { path: diagnostic.module ?? analysis.diagnosticPath, line: diagnostic.span.start.line, column: diagnostic.span.start.column },
      })),
    };
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
    else {
      diagnostics.forEach((diagnostic) => printDiagnostic(analysis.diagnosticPath, diagnostic));
      const marker = errors ? red("FAIL") : warnings ? yellow("WARN") : green("PASS");
      console.log(`${marker} lint ${basename(subject)} · ${errors} error(s), ${warnings} warning(s)`);
    }
    if (errors) process.exitCode = 1;
    else if (warnings && denyWarnings) process.exitCode = 2;
    return;
  }
  if (["check", "lock", "build", "inspect", "test", "frame", "contact", "audition", "preview", "render"].includes(command)) {
    if (!subject) throw new Error(`${command} needs a CUT 0.4 program`);
    const sourceOverride = command === "check" && process.argv.includes("--stdin") ? await readBoundedCliStdin() : undefined;
    if (command === "check" && process.argv.includes("--json")) {
      const analysis = await analyzeLanguageProgram(subject, sourceOverride);
      const report = {
        format: "cut-diagnostics",
        version: 1,
        command: "check",
        program: basename(subject),
        status: analysis.module && !analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "pass" : "fail",
        diagnostics: analysis.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          source: { path: diagnostic.module ?? analysis.diagnosticPath, line: diagnostic.span.start.line, column: diagnostic.span.start.column },
        })),
      };
      process.stdout.write(`${stableJsonStringify(report)}\n`);
      if (report.status === "fail") process.exitCode = 1;
      return;
    }
    const program = await languageProgram(subject, sourceOverride);
    if (command === "check") { console.log(`${green("✓")} ${basename(subject)} is a valid, dimensionally typed CUT 0.4 program`); return; }
    const { ir } = program.compiled;
    const projectRoot = dirname(resolve(subject));
    if (command === "lock") {
      const lock = await createCutLock(ir, projectRoot); const output = resolve(option("--out", resolve(projectRoot, "cut.lock"))!);
      const interpretationWarnings = referenceVideoColorInterpretationWarnings(ir);
      await writeProjectArtifacts([projectRoot, process.cwd()], [
        { destination: output, contents: JSON.stringify(lock, null, 2), role: "cut-lock" },
      ]);
      if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify({
        format: "cut-lock-report",
        version: 1,
        command: "lock",
        status: "pass",
        program: basename(subject),
        output: option("--out", "cut.lock"),
        sourceHash: lock.sourceHash,
        determinism: lock.determinism,
        diagnostics: interpretationWarnings,
        summary: { resources: Object.keys(lock.resources).length, proxies: Object.values(lock.resources).filter((resource) => resource.proxy).length, interpretedVideoResources: interpretationWarnings.length, packages: lock.packages.length, jobs: Object.keys(lock.jobs).length },
      })}\n`);
      else {
        const proxies = Object.values(lock.resources).filter((resource) => resource.proxy).length;
        console.log(`${green("✓")} froze ${Object.keys(lock.resources).length} resource(s), ${proxies} proxy variant(s), and ${lock.packages.length} package signature(s)`);
        for (const warning of interpretationWarnings) console.warn(`${yellow("warning")} ${warning.code} ${warning.source.module}:${warning.source.line}:${warning.source.column} ${warning.message}`);
        console.log(dim(`  ${output}`));
      }
      return;
    }
    const lockPath = option("--lock");
    let appliedLockSha256: string | undefined, appliedLock: CutLockfile | undefined, lockedReferenceBackend: CutLockfile["toolchain"]["referenceBackend"] | undefined;
    if (lockPath) {
      const lockBytes = await readFile(resolve(lockPath));
      const verifiedInputCommands = new Set(["frame", "contact", "audition", "preview", "render"]);
      appliedLock = loadCutLock(lockBytes);
      if (verifiedInputCommands.has(command)) {
        const binding = await applyCutLockForVerifiedInputSession(ir, appliedLock, projectRoot);
        lockedReferenceBackend = binding.referenceBackend;
      } else await applyCutLock(ir, appliedLock, projectRoot);
      appliedLockSha256 = createHash("sha256").update(lockBytes).digest("hex");
    }
    if (command === "frame" || command === "contact" || command === "audition") {
      if (!lockPath || !appliedLockSha256 || !appliedLock || !lockedReferenceBackend) throw new Error(`${command} requires --lock cut.lock`);
      const outputPath = option("--out");
      if (!outputPath) throw new Error(`${command} requires --out`);
      const common = {
        outputName: option("--output"),
        mediaProfile: option("--profile", "master"),
        lockSha256: appliedLockSha256,
        __lockedReferenceBackend: lockedReferenceBackend,
      };
      const manifest = command === "frame"
        ? await renderReferenceFrameArtifact(ir, projectRoot, resolve(outputPath), { ...common, frame: option("--frame"), at: option("--at") })
        : command === "contact"
          ? await renderReferenceContactSheetArtifact(ir, projectRoot, resolve(outputPath), { ...common, frames: option("--frames"), columns: option("--columns"), thumbnailWidth: option("--thumbnail-width") })
          : await renderReferenceAudioAuditionArtifact(ir, projectRoot, resolve(outputPath), { ...common, samples: option("--samples"), stem: option("--stem") });
      const report = { format: `cut-${command}-report`, version: 1, command, status: "pass", program: basename(subject), manifest };
      if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
      else if (command === "frame" && manifest.format === "cut-reference-frame") {
        console.log(`${green("✓")} exact frame ${manifest.frame.index} at ${manifest.frame.timestamp.numerator}/${manifest.frame.timestamp.denominator}s · ${manifest.canvas.width}×${manifest.canvas.height} · ${manifest.media.requested}`);
        console.log(dim(`  ${resolve(outputPath)}`));
      } else if (command === "contact" && manifest.format === "cut-reference-contact-sheet") {
        console.log(`${green("✓")} ${manifest.frames.length} exact frame(s) · ${manifest.layout.columns}×${manifest.layout.rows} contact · ${manifest.media.requested}`);
        console.log(dim(`  ${resolve(outputPath)}`));
      } else if (command === "audition" && manifest.format === "cut-reference-audio-audition") {
        const selection = manifest.selection.kind === "stem" ? `stem ${manifest.selection.name}` : "authored master";
        console.log(`${green("✓")} ${manifest.artifact.samples} exact sample(s) · ${selection} · ${manifest.artifact.sampleRate} Hz`);
        console.log(dim(`  ${resolve(outputPath)}`));
      }
      return;
    }
    if (command === "test") {
      const assertionReport = evaluateCutDomainAssertions(ir);
      if (assertionReport.diagnostic && assertionReport.results.length === 0) {
        const failure = new Error(assertionReport.diagnostic.message) as Error & { code: string; source: typeof assertionReport.diagnostic.source };
        failure.code = assertionReport.diagnostic.code;
        failure.source = assertionReport.diagnostic.source;
        throw failure;
      }
      const assertions = ir.assertions.map((assertion, assertionIndex) => {
        const evaluated = assertionReport.results[assertionIndex]!;
        if (evaluated.status === "error") {
          const failure = new Error(evaluated.diagnostic.message) as Error & { code: string; source: typeof evaluated.source };
          failure.code = evaluated.diagnostic.code;
          failure.source = evaluated.source;
          throw failure;
        }
        const status = evaluated.status === "unsupported" ? "deferred" : evaluated.status;
        if (assertion.status !== status) {
          const failure = new Error(`CUT_ASSERT_STATUS_MISMATCH: stored assertion status ${assertion.status} does not match recomputed ${status} at ${evaluated.source.module}:${evaluated.source.line}:${evaluated.source.column}.`) as Error & { code: string; source: typeof evaluated.source };
          failure.code = "CUT_ASSERT_STATUS_MISMATCH";
          failure.source = evaluated.source;
          throw failure;
        }
        return {
          id: assertion.id,
          status,
          message: assertion.message ?? null,
          source: {
            module: assertion.provenance.module,
            line: assertion.provenance.span.start.line,
            column: assertion.provenance.span.start.column,
          },
        };
      });
      const summary = {
        pass: assertions.filter((assertion) => assertion.status === "pass").length,
        fail: assertions.filter((assertion) => assertion.status === "fail").length,
        deferred: assertions.filter((assertion) => assertion.status === "deferred").length,
        total: assertions.length,
      };
      const report = { format: "cut-av-test-report", version: 1, program: basename(subject), buildId: ir.buildId, summary, assertions };
      if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify(report)}\n`);
      else {
        for (const assertion of assertions) {
          const marker = assertion.status === "pass" ? green("PASS") : assertion.status === "fail" ? red("FAIL") : yellow("DEFER");
          console.log(`${marker} ${assertion.message ?? assertion.id} ${dim(`${assertion.source.module}:${assertion.source.line}:${assertion.source.column}`)}`);
        }
        if (!assertions.length) console.log(`${green("✓")} no authored assertions`);
        else console.log(`${summary.fail || summary.deferred ? red("FAILED") : green("✓")} ${summary.pass}/${summary.total} assertion(s) passed${summary.deferred ? ` · ${summary.deferred} deferred` : ""}`);
      }
      if (summary.fail || summary.deferred) process.exitCode = 2;
      return;
    }
    if (command === "preview" || command === "render") {
      const isPreview = command === "preview";
      if (!lockPath || !appliedLockSha256 || !appliedLock || !lockedReferenceBackend) throw new Error(`${command} requires --lock cut.lock`);
      const outputName = option("--output", isPreview ? "preview" : undefined);
      if (isPreview && !ir.outputs.some((item) => item.name === outputName)) {
        const error = new Error(`Preview requires an authored render output named ${JSON.stringify(outputName)}; declare it in CUT source or select one with --output.`) as Error & { code: string };
        error.code = "CUT_PREVIEW_OUTPUT_MISSING";
        throw error;
      }
      const output = option("--out", isPreview ? resolve(projectRoot, "output", "preview.mp4") : undefined);
      if (!output) throw new Error("render requires --out video.mp4");
      const stemsDirectory = isPreview ? undefined : option("--stems"), emitJson = process.argv.includes("--json");
      if (!emitJson) console.log(`${cyan(command)} locked CUT graph → authored ${isPreview ? "preview output" : "reference compositor + audio graph"}…`);
      const boundedPreview = isPreview && (option("--range") !== undefined || option("--width") !== undefined);
      const manifest = boundedPreview
        ? await renderReferencePreviewArtifact(ir, projectRoot, resolve(output), {
            range: option("--range"),
            width: option("--width"),
            outputName,
            mediaProfile: "proxy",
            lockSha256: appliedLockSha256,
            __lockedReferenceBackend: lockedReferenceBackend,
          })
        : await renderReferenceIr(ir, projectRoot, resolve(output), outputName, {
            lockSha256: appliedLockSha256,
            mediaProfile: isPreview ? "proxy" : "master",
            __lockedReferenceBackend: lockedReferenceBackend,
            ...(stemsDirectory ? { stemsDirectory: resolve(stemsDirectory) } : {}),
          });
      if (emitJson) process.stdout.write(`${stableJsonStringify({ format: isPreview ? "cut-preview-report" : "cut-render-report", version: 1, command, status: "pass", output: outputName, manifest })}\n`);
      else {
        if (manifest.format === "cut-reference-range-preview") {
          console.log(`${green("✓")} ${manifest.range.frames} exact frame(s) · ${manifest.range.samples} exact sample(s) · ${manifest.canvas.width}×${manifest.canvas.height} · proxy`); console.log(dim(`  ${manifest.artifact.file}`));
        } else {
          console.log(`${green("✓")} ${manifest.duration.toFixed(2)}s · ${manifest.canvas.width}×${manifest.canvas.height} · ${manifest.audio.filters} audio filters · ${manifest.cache.hits} scene cache hit(s)`); console.log(dim(`  ${manifest.output}`));
          if (manifest.stems) console.log(`${green("✓")} ${manifest.stems.count} pre-master stem(s) · ${manifest.stems.manifest}`);
        }
      }
      return;
    }
    if (command === "inspect") {
      const report = inspectCutIr(ir, basename(subject));
      if (process.argv.includes("--json")) {
        process.stdout.write(`${stableJsonStringify(report)}\n`);
        return;
      }
      console.log(`${cyan(ir.project)} · ${ir.buildId}`);
      console.log(`${ir.compositions.length} composition(s) · ${Object.keys(ir.scenes).length} scene(s) · ${Object.keys(ir.nodes).length} node(s) · ${Object.keys(ir.signals).length} signal(s) · ${Object.keys(ir.resources).length} resource(s)`);
      console.log(`${ir.modules.length} locked package signature(s) · ${ir.sourceModules?.length ?? 0} user source module(s) · semantic determinism ${ir.determinism.semantic}`);
      return;
    }
    const output = resolve(option("--out", resolve(projectRoot, ".cut", "builds", ir.buildId, "graph.cutir.json"))!);
    await writeProjectArtifacts([projectRoot, process.cwd()], [
      { destination: output, contents: JSON.stringify(ir, null, 2), role: "typed-ir" },
    ]);
    if (process.argv.includes("--json")) process.stdout.write(`${stableJsonStringify({
      format: "cut-build-report",
      version: 1,
      command: "build",
      status: "pass",
      program: basename(subject),
      output: option("--out", `.cut/builds/${ir.buildId}/graph.cutir.json`),
      buildId: ir.buildId,
      determinism: ir.determinism,
      summary: {
        compositions: ir.compositions.length,
        scenes: Object.keys(ir.scenes).length,
        nodes: Object.keys(ir.nodes).length,
        signals: Object.keys(ir.signals).length,
        resources: Object.keys(ir.resources).length,
        modules: ir.modules.length,
        sourceModules: ir.sourceModules?.length ?? 0,
        jobs: ir.jobs.length,
        outputs: ir.outputs.length,
        assertions: ir.assertions.length,
      },
    })}\n`);
    else {
      console.log(`${green("✓")} ${Object.keys(ir.nodes).length} typed AV nodes · ${Object.keys(ir.signals).length} signals · ${cyan(ir.buildId)}`);
      console.log(dim(`  ${output}`));
    }
    return;
  }
  if (command === "legacy-auth") {
    if (subject === "login") await codex(["login"]);
    else if (subject === "status") {
      await codex(["login", "status"]);
      console.log(process.env.OPENAI_API_KEY ? `${green("✓")} Platform API key is also configured` : dim("  Platform API key is not configured; semantic planning will use ChatGPT/Codex."));
    } else throw new Error("auth needs status or login");
    return;
  }
  if (command === "legacy-ingest") {
    if (!subject) throw new Error("ingest needs a media file or directory");
    const output = resolve(option("--out", ".cut/index.json")!);
    console.log(`${cyan("index")} probing, hashing, and detecting scenes…`);
    let index = await createMediaIndex(subject);
    if (process.argv.includes("--transcribe")) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("--transcribe requires OPENAI_API_KEY");
      console.log(`${cyan("speech")} creating word-aligned source transcripts…`);
      index = await transcribeMediaIndex(index, apiKey);
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(index, null, 2));
    const seconds = index.assets.reduce((sum, asset) => sum + asset.duration, 0);
    const words = index.assets.flatMap((asset) => asset.transcript ?? []).flatMap((segment) => segment.words ?? []).length;
    console.log(`${green("✓")} ${index.assets.length} asset(s), ${index.assets.reduce((sum, asset) => sum + asset.scenes.length, 0)} scenes, ${words} timed words, ${seconds.toFixed(1)}s indexed`);
    console.log(dim(`  ${index.indexHash.slice(0, 16)}  ${output}`));
    return;
  }
  if (command === "legacy-research") {
    if (!subject) throw new Error("research needs a quoted topic");
    const output = resolve(option("--out", "research.cutresearch.json")!);
    console.log(`${cyan("research")} searching authoritative sources and locking cited claims…`);
    const pack = await researchWithCodex(subject);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(pack, null, 2));
    console.log(`${green("✓")} ${pack.claims.length} claims · ${pack.sources.length} verified source URLs · ${pack.metrics?.length ?? 0} metrics → ${output}`);
    return;
  }
  if (command === "legacy-see") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("see requires OPENAI_API_KEY because sampled image inputs use the Responses API");
    const input = resolve(option("--index", ".cut/index.json")!);
    const output = resolve(option("--out", input)!);
    const index = await loadIndex(input);
    console.log(`${cyan("vision")} sampling locked scenes and describing visible evidence…`);
    const analyzed = await analyzeMediaIndex(index, apiKey, option("--model", process.env.OPENAI_MODEL ?? "gpt-5.6"));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(analyzed, null, 2));
    console.log(`${green("✓")} ${analyzed.assets.reduce((sum, asset) => sum + asset.scenes.filter((scene) => scene.visual).length, 0)} scene descriptions locked into ${output}`);
    return;
  }
  if (command === "legacy-diff") {
    const afterPath = process.argv[5];
    if (!subject || !afterPath) throw new Error("diff needs two .cutir.json build artifacts");
    const [before, after] = await Promise.all([readFile(resolve(subject), "utf8"), readFile(resolve(afterPath), "utf8")]);
    const changes = diffBuilds(JSON.parse(before) as BuildArtifact, JSON.parse(after) as BuildArtifact);
    if (!changes.length) console.log(`${green("✓")} timelines are semantically identical`);
    else changes.forEach((change) => console.log(`${change.kind === "add" ? green("+") : change.kind === "remove" ? red("−") : cyan("→")} ${change.kind.padEnd(7)} ${change.message}`));
    return;
  }
  if (command === "legacy-produce") {
    if (!subject) throw new Error("produce needs a .cutprod.json production plan");
    console.log(`${cyan("produce")} validating and rendering generic production plan…`);
    const result = await renderProduction(subject, option("--out-dir"));
    console.log(`${green("✓")} rendered ${result.master}`);
    console.log(dim(`  plan ${result.manifest.planHash.slice(0, 16)} · ${result.manifest.shots.length} shots · ${result.manifest.duration.toFixed(2)}s`));
    return;
  }
  if (command === "legacy-critique") {
    if (!subject) throw new Error("critique needs a rendered video");
    const manifest = option("--manifest");
    if (!manifest) throw new Error("critique requires --manifest <manifest.json>");
    console.log(`${cyan("critique")} sampling every shot and applying the documentary quality gate…`);
    const critique = await critiqueProduction(subject, manifest);
    const output = option("--out");
    if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(critique, null, 2)); }
    for (const [key, score] of Object.entries(critique.scores)) console.log(`${String(score).padStart(4)}  ${key}`);
    critique.findings.forEach((finding) => console.log(`${finding.severity === "high" ? red("HIGH") : finding.severity === "medium" ? cyan("MED ") : dim("LOW ")} ${finding.category}: ${finding.evidence}\n     ${finding.recommendation}`));
    console.log(`${critique.verdict === "pass" ? green("PASS") : red("REVISE")} ${critique.summary}`);
    if (critique.verdict !== "pass") process.exitCode = 2;
    return;
  }
  if (command === "legacy-direct") {
    if (!subject) throw new Error("direct needs a .cut program");
    const sourcePath = resolve(subject);
    const output = resolve(option("--out", resolve(dirname(sourcePath), "production.cutprod.json"))!);
    const [source, index, theme] = await Promise.all([
      readFile(sourcePath, "utf8"), loadIndex(option("--index", ".cut/index.json")),
      readFile(resolve(option("--style", "styles/documentary-production.json")!), "utf8").then((value) => JSON.parse(value) as ProductionTheme),
    ]);
    const catalog = catalogFromIndex(index);
    const provider = option("--provider", "auto");
    if (!provider || !["auto", "chatgpt", "api"].includes(provider)) throw new Error("--provider must be auto, chatgpt, or api");
    const apiKey = process.env.OPENAI_API_KEY;
    console.log(`${cyan("direct")} source-grounded model is writing a constrained production plan…`);
    const direction = provider === "api" || (provider === "auto" && apiKey)
      ? await directWithOpenAI(source, catalog, apiKey ?? (() => { throw new Error("--provider api requires OPENAI_API_KEY"); })(), process.env.OPENAI_MODEL ?? "gpt-5.6")
      : await directWithCodex(source, catalog);
    const plan = lowerDirection(direction, source, catalog, index, output, theme);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(plan, null, 2));
    console.log(`${green("✓")} ${direction.segments.length} evidence-locked segments → ${output}`);
    return;
  }
  if (command === "legacy-compose") {
    if (!subject) throw new Error("compose needs a .cut program");
    const researchPath = option("--research");
    if (!researchPath) throw new Error("compose requires --research <pack.cutresearch.json>");
    const sourcePath = resolve(subject);
    const output = resolve(option("--out", resolve(dirname(sourcePath), "production.cutprod.json"))!);
    const [source, research, theme] = await Promise.all([
      readFile(sourcePath, "utf8"),
      readFile(resolve(researchPath), "utf8").then((value) => validateResearchPack(JSON.parse(value))),
      readFile(resolve(option("--style", "styles/documentary-production.json")!), "utf8").then((value) => JSON.parse(value) as ProductionTheme),
    ]);
    console.log(`${cyan("compose")} grounding narrative and graphics in locked research IDs…`);
    const direction = await composeWithCodex(source, research);
    const plan = lowerResearchDirection(direction, source, research, theme);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(plan, null, 2));
    console.log(`${green("✓")} ${direction.segments.length} cited documentary segments → ${output}`);
    return;
  }
  if (command === "legacy-improve") {
    if (!subject) throw new Error("improve needs a .cut program");
    const researchPath = option("--research"); if (!researchPath) throw new Error("improve requires --research <pack.cutresearch.json>");
    const sourcePath = resolve(subject); const root = dirname(sourcePath); const out = resolve(option("--out-dir", resolve(root, "improve-output"))!);
    const passes = Number(option("--passes", "2")); if (!Number.isInteger(passes) || passes < 1 || passes > 5) throw new Error("--passes must be an integer from 1 to 5");
    const [initial, research, theme] = await Promise.all([readFile(sourcePath, "utf8"), readFile(resolve(researchPath), "utf8").then((value) => validateResearchPack(JSON.parse(value))), readFile(resolve(option("--style", "styles/documentary-production.json")!), "utf8").then((value) => JSON.parse(value) as ProductionTheme)]);
    let source = initial;
    for (let pass = 1; pass <= passes; pass += 1) {
      console.log(`${cyan(`improve ${pass}/${passes}`)} direct → render → watch`);
      const direction = await composeWithCodex(source, research); const plan = lowerResearchDirection(direction, source, research, theme);
      const planPath = resolve(root, `production.pass-${String(pass).padStart(2, "0")}.cutprod.json`); await writeFile(planPath, JSON.stringify(plan, null, 2));
      const passOut = resolve(out, `pass-${String(pass).padStart(2, "0")}`); const rendered = await renderProduction(planPath, passOut);
      const critique = await critiqueProduction(rendered.master, resolve(passOut, "manifest.json")); await mkdir(passOut, { recursive: true }); await writeFile(resolve(passOut, "critique.json"), JSON.stringify(critique, null, 2));
      console.log(`${critique.verdict === "pass" ? green("PASS") : red("REVISE")} ${critique.scores.overall}/10 · ${rendered.master}`);
      if (critique.verdict === "pass") return;
      if (pass < passes) { const revision = await reviseProgramWithCodex(source, critique); source = revision.program; await writeFile(resolve(root, `revision.pass-${String(pass + 1).padStart(2, "0")}.cut`), source); console.log(dim(`  ${revision.rationale}`)); }
      else process.exitCode = 2;
    }
    return;
  }
  if (command === "legacy-revise") {
    if (!subject) throw new Error("revise needs a .cut program");
    const critiquePath = option("--critique"); if (!critiquePath) throw new Error("revise requires --critique <critique.json>");
    const sourcePath = resolve(subject); const source = await readFile(sourcePath, "utf8"); const critique = JSON.parse(await readFile(resolve(critiquePath), "utf8"));
    const revision = await reviseProgramWithCodex(source, critique);
    const output = resolve(option("--out", resolve(dirname(sourcePath), "revision.cut"))!); await writeFile(output, revision.program);
    console.log(`${green("✓")} typed editorial revision → ${output}`); console.log(dim(`  ${revision.rationale}`));
    return;
  }
  if (command === "legacy-render" && subject?.endsWith(".json")) {
    const [artifact, index] = await Promise.all([
      readFile(resolve(subject), "utf8").then((value) => JSON.parse(value) as BuildArtifact),
      loadIndex(option("--index", ".cut/index.json")),
    ]);
    const output = resolve(option("--out", `${artifact.program.project.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`)!);
    console.log(`${cyan("render")} locked build ${artifact.buildId} → ${output}`);
    await renderArtifact(artifact, index, output);
    console.log(`${green("✓")} rendered exact build ${artifact.buildId}`);
    return;
  }
  if (!["legacy-build", "legacy-test", "legacy-explain", "legacy-render"].includes(command)) throw new Error(`unknown command ${JSON.stringify(command)}; run cut help`);
  if (!subject) throw new Error(`${command.slice("legacy-".length)} needs a program`);
  const { artifact, index } = await compile(subject, option("--index", ".cut/index.json"));
  if (command === "legacy-build") {
    const failures = artifact.verification.filter((result) => result.status === "fail");
    if (failures.length) throw new Error(`build failed verification: ${failures.map((result) => result.rule).join(", ")}`);
    const { directory, cached } = await saveBuild(artifact);
    console.log(`${green("✓")} ${artifact.clips.length} clips · ${artifact.duration.toFixed(2)}s · reproducible build ${cyan(artifact.buildId)}${cached ? " · cache hit" : ""}`);
    console.log(dim(`  ${directory}`));
    return;
  }
  if (command === "legacy-test") {
    let failed = false;
    for (const result of artifact.verification) {
      const marker = result.status === "pass" ? green("PASS") : result.status === "warn" ? yellow("WARN") : red("FAIL");
      console.log(`${marker} ${result.rule.padEnd(24)} ${result.message}`);
      failed ||= result.status === "fail";
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (command === "legacy-explain") {
    console.log(`${cyan(artifact.program.project)} · ${artifact.buildId}\n`);
    artifact.clips.forEach((clip, index) => console.log(`${String(index + 1).padStart(2, "0")} ${clip.timelineStart.toFixed(2).padStart(6)}–${clip.timelineEnd.toFixed(2).padEnd(6)} ${clip.role.padEnd(10)} ${basename(clip.source)} ${clip.start.toFixed(2)}s\n   ${dim(`line ${clip.sourceLine}: ${clip.rationale}`)}`));
    return;
  }
  const output = resolve(option("--out", `${basename(subject, ".cut")}.mp4`)!);
  console.log(`${cyan("render")} ${artifact.clips.length} traceable clips → ${output}`);
  await renderArtifact(artifact, index, output);
  await saveBuild(artifact);
  console.log(`${green("✓")} rendered ${output} from build ${artifact.buildId}`);
}

main().catch((error: unknown) => {
  if (error instanceof CutCliUsageError) {
    if (process.argv.includes("--json")) {
      process.stdout.write(`${stableJsonStringify({
        format: "cut-cli-diagnostics",
        version: 1,
        command: error.command,
        status: "fail",
        diagnostics: [{ code: error.code, severity: "error", message: error.message }],
      })}\n`);
    } else console.error(red(`cut: ${error.code}: ${error.message}`));
  } else if (process.argv.includes("--json")) {
    process.stdout.write(`${stableJsonStringify({
      format: "cut-cli-diagnostics",
      version: 1,
      command: requestedCommandLabel(),
      status: "fail",
      diagnostics: cutDiagnosticsFromError(error),
    })}\n`);
  } else console.error(red(`cut: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
