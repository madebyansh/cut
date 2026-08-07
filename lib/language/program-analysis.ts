import type { CutModule, LanguageDiagnostic } from "./ast";
import { checkCutModule } from "./checker";
import {
  compileCutModule,
  CutCompileError,
  type CutCompileInputs,
} from "./compiler";
import { parseCutLanguage } from "./parser";
import { loadCutTranscriptCompileInputs } from "./transcript-compile-inputs";
import { loadCutUserModuleGraph, type CutUserModuleGraph } from "./user-modules";
import type { CutExternalPackageContext } from "../package/context";
import { validateReferenceStaticVisualGraphs } from "../runtime/reference/static-visual-validation";

export type CutCompiledLanguageProgram = ReturnType<typeof compileCutModule>;

export type CutLanguageProgramAnalysis = Readonly<{
  source: string;
  module: CutModule | null;
  diagnostics: readonly LanguageDiagnostic[];
  diagnosticPath: string;
  externalPackages?: CutExternalPackageContext;
  userModules?: CutUserModuleGraph;
  compileInputs?: CutCompileInputs;
  compiled?: CutCompiledLanguageProgram;
}>;

type CutLanguageProgramAnalysisDependencies = Readonly<{
  compile?: typeof compileCutModule;
  validateStaticVisualGraphs?: typeof validateReferenceStaticVisualGraphs;
}>;

/**
 * Parse, check, lower, and statically validate one already-loaded CUT entry.
 *
 * The successful compiled result is part of the analysis contract so callers
 * can execute the exact IR that produced the published diagnostics without a
 * second compiler invocation. The optional dependencies are a closed testing
 * seam; production callers use the canonical compiler and static validator.
 */
export async function analyzeCutLanguageProgramSource(
  path: string,
  source: string,
  externalPackages?: CutExternalPackageContext,
  dependencies: CutLanguageProgramAnalysisDependencies = {},
): Promise<CutLanguageProgramAnalysis> {
  const compile = dependencies.compile ?? compileCutModule;
  const validateStaticVisualGraphs = dependencies.validateStaticVisualGraphs ?? validateReferenceStaticVisualGraphs;
  const parsed = parseCutLanguage(source);
  if (!parsed.module) {
    return {
      source,
      module: null,
      diagnostics: parsed.diagnostics,
      diagnosticPath: path,
      externalPackages,
    };
  }
  const loaded = await loadCutUserModuleGraph(path, parsed.module, { packages: externalPackages?.packages });
  if (!loaded.graph) {
    return {
      source,
      module: parsed.module,
      diagnostics: [...parsed.diagnostics, ...loaded.diagnostics],
      diagnosticPath: path,
      externalPackages,
    };
  }
  const checked = checkCutModule(parsed.module, {
    packages: externalPackages?.packages,
    userModules: loaded.graph.contracts,
    moduleKind: "entry",
  });
  const transcriptInputs = checked.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? { inputs: {} as CutCompileInputs, diagnostics: [] as readonly LanguageDiagnostic[] }
    : await loadCutTranscriptCompileInputs(path, parsed.module, checked);
  const diagnostics = [
    ...parsed.diagnostics,
    ...loaded.diagnostics,
    ...checked.diagnostics,
    ...transcriptInputs.diagnostics,
  ];
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      source,
      module: parsed.module,
      diagnostics,
      diagnosticPath: path,
      externalPackages,
      userModules: loaded.graph,
      compileInputs: transcriptInputs.inputs,
    };
  }
  try {
    const compiled = compile(parsed.module, {}, externalPackages, loaded.graph, transcriptInputs.inputs);
    const loweredDiagnostics = [...parsed.diagnostics, ...loaded.diagnostics, ...compiled.check.diagnostics];
    const staticVisualDiagnostics = loweredDiagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? []
      : validateStaticVisualGraphs(compiled.ir);
    return {
      source,
      module: parsed.module,
      diagnostics: [...loweredDiagnostics, ...staticVisualDiagnostics],
      diagnosticPath: path,
      externalPackages,
      userModules: loaded.graph,
      compileInputs: transcriptInputs.inputs,
      compiled,
    };
  } catch (error) {
    if (error instanceof CutCompileError) {
      return {
        source,
        module: parsed.module,
        diagnostics: [...parsed.diagnostics, ...loaded.diagnostics, ...error.result.diagnostics],
        diagnosticPath: error.moduleName ?? path,
        externalPackages,
        userModules: loaded.graph,
        compileInputs: transcriptInputs.inputs,
      };
    }
    throw error;
  }
}
