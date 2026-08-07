import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { CutModule, Declaration, LanguageDiagnostic, SourceSpan } from "./ast";
import { checkCutModule, type CheckResult, type CutCheckOptions, type CutUserModuleContract } from "./checker";
import { parseCutLanguage } from "./parser";

export type CutUserModuleLimits = {
  maxModules: number;
  maxModuleBytes: number;
  maxTotalBytes: number;
  maxImportDepth: number;
};

export const defaultCutUserModuleLimits: Readonly<CutUserModuleLimits> = Object.freeze({
  maxModules: 256,
  maxModuleBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxImportDepth: 64,
});

export type CutUserSourceModule = {
  specifier: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
  source: string;
  module: CutModule;
  check: CheckResult;
};

export type CutUserModuleGraph = {
  projectRoot: string;
  modules: ReadonlyMap<string, CutUserSourceModule>;
  contracts: ReadonlyMap<string, CutUserModuleContract>;
  order: readonly string[];
};

export type CutUserModuleLoadResult = {
  graph?: CutUserModuleGraph;
  diagnostics: LanguageDiagnostic[];
};

function normalizedLimits(overrides: Partial<CutUserModuleLimits>): CutUserModuleLimits {
  const allowed = new Set(Object.keys(defaultCutUserModuleLimits));
  if (Object.keys(overrides).some((key) => !allowed.has(key))) throw new Error("Unknown CUT user-module resource limit.");
  const limits = { ...defaultCutUserModuleLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > defaultCutUserModuleLimits[name as keyof CutUserModuleLimits]) {
    throw new Error(`CUT user-module limit ${name} must be a positive safe integer no greater than the public ceiling.`);
  }
  return limits;
}

function diagnostic(module: string, span: SourceSpan, code: string, message: string, hint?: string): LanguageDiagnostic {
  return { severity: "error", code, message, span, module, ...(hint ? { hint } : {}) };
}

function canonicalSpecifier(value: string): { value?: string; code?: string; message?: string } {
  if (value === ".." || value.startsWith("../") || value.includes("/../")) {
    return { code: "CUT_MODULE_ESCAPE", message: "User-module paths cannot contain .. or leave the project root." };
  }
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return { code: "CUT_MODULE_SPECIFIER", message: "User-module imports must use forward-slash project-relative .cut paths." };
  }
  if (!value.startsWith("./") || !value.endsWith(".cut")) {
    return { code: "CUT_MODULE_SPECIFIER", message: "User-module imports must be explicit canonical paths such as ./lib/theme.cut." };
  }
  const segments = value.slice(2).split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === ".")) {
    return { code: "CUT_MODULE_SPECIFIER", message: "User-module paths cannot contain empty or dot segments." };
  }
  if (segments.some((segment) => segment === "..")) return { code: "CUT_MODULE_ESCAPE", message: "User-module paths cannot contain .. or leave the project root." };
  if (segments.some((segment) => /[\u0000-\u001f\u007f]/.test(segment))) {
    return { code: "CUT_MODULE_SPECIFIER", message: "User-module paths cannot contain control characters." };
  }
  return { value: `./${segments.join("/")}` };
}

function localImports(module: CutModule) {
  return module.declarations.filter((item): item is Extract<Declaration, { kind: "import" }> => item.kind === "import" && item.module.startsWith("."));
}

function privateNames(module: CutModule) {
  return new Set(module.declarations.flatMap((item) =>
    item.kind === "asset" || item.kind === "const" || item.kind === "function" || item.kind === "component" || item.kind === "timeline"
      ? [item.name]
      : []));
}

async function rejectSymlinkComponents(root: string, specifier: string) {
  let current = root;
  for (const segment of specifier.slice(2).split("/")) {
    current = resolve(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) return current;
  }
  return undefined;
}

/**
 * Load a closed DAG of project-relative CUT modules without executing source.
 *
 * All specifiers are rooted at the entry file's directory (not the importing
 * module's directory), which makes one spelling identify one module everywhere.
 * Both lexical and realpath containment are enforced and every path component
 * is rejected if it is a symlink.
 */
export async function loadCutUserModuleGraph(
  entryPath: string,
  entryModule: CutModule,
  options: Pick<CutCheckOptions, "packages"> & { limits?: Partial<CutUserModuleLimits> } = {},
): Promise<CutUserModuleLoadResult> {
  const limits = normalizedLimits(options.limits ?? {});
  const projectRoot = await realpath(dirname(resolve(entryPath)));
  const diagnostics: LanguageDiagnostic[] = [];
  const parsed = new Map<string, Omit<CutUserSourceModule, "check">>();
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  let totalBytes = 0;

  const visit = async (specifier: string, owner: string, span: SourceSpan, depth: number): Promise<void> => {
    const canonical = canonicalSpecifier(specifier);
    if (!canonical.value) {
      diagnostics.push(diagnostic(owner, span, canonical.code!, canonical.message!, "Package imports use cut: or a locked package name; user modules use ./path.cut."));
      return;
    }
    specifier = canonical.value;
    if (depth > limits.maxImportDepth) {
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_LIMIT", `User-module import depth exceeds ${limits.maxImportDepth}.`));
      return;
    }
    if (state.get(specifier) === "done") return;
    if (state.get(specifier) === "visiting") {
      const start = stack.indexOf(specifier);
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_CYCLE", `User-module cycle: ${[...stack.slice(Math.max(0, start)), specifier].join(" -> ")}.`, "Break the import cycle; compile-time module initialization is acyclic."));
      return;
    }
    if (!parsed.has(specifier) && parsed.size >= limits.maxModules) {
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_LIMIT", `User-module graph exceeds ${limits.maxModules} files.`));
      return;
    }

    const absolutePath = resolve(projectRoot, specifier.slice(2));
    const lexicalRelative = relative(projectRoot, absolutePath);
    if (!lexicalRelative || lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || resolve(projectRoot, lexicalRelative) !== absolutePath) {
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_ESCAPE", `Module “${specifier}” leaves the project root.`));
      return;
    }
    let metadata;
    try {
      const symlink = await rejectSymlinkComponents(projectRoot, specifier);
      if (symlink) {
        diagnostics.push(diagnostic(owner, span, "CUT_MODULE_SYMLINK", `Module “${specifier}” traverses a symbolic link; module sources must be regular project files.`));
        return;
      }
      metadata = await lstat(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      diagnostics.push(diagnostic(owner, span, code === "ENOENT" ? "CUT_MODULE_MISSING" : "CUT_MODULE_IO", `Cannot read module “${specifier}”${code ? ` (${code})` : ""}.`));
      return;
    }
    if (!metadata.isFile()) {
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_FILE", `Module “${specifier}” must be a regular file.`));
      return;
    }
    if (metadata.size > limits.maxModuleBytes) {
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_LIMIT", `Module “${specifier}” exceeds ${limits.maxModuleBytes} bytes.`));
      return;
    }
    const resolved = await realpath(absolutePath);
    const physicalRelative = relative(projectRoot, resolved);
    if (!physicalRelative || physicalRelative === ".." || physicalRelative.startsWith(`..${sep}`)) {
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_ESCAPE", `Module “${specifier}” resolves outside the project root.`));
      return;
    }
    const bytes = await readFile(resolved);
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_LIMIT", `User-module bytes exceed ${limits.maxTotalBytes}.`));
      return;
    }
    const source = bytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(bytes)) {
      diagnostics.push(diagnostic(owner, span, "CUT_MODULE_ENCODING", `Module “${specifier}” is not canonical UTF-8 text.`));
      return;
    }
    const result = parseCutLanguage(source);
    if (!result.module) {
      diagnostics.push(...result.diagnostics.map((item) => ({ ...item, module: specifier })));
      return;
    }
    parsed.set(specifier, { specifier, absolutePath: resolved, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), source, module: result.module });
    state.set(specifier, "visiting"); stack.push(specifier);
    const seenSpecifiers = new Set<string>();
    for (const declaration of localImports(result.module)) {
      const importedCanonical = canonicalSpecifier(declaration.module);
      if (importedCanonical.value && seenSpecifiers.has(importedCanonical.value)) {
        diagnostics.push(diagnostic(specifier, declaration.span, "CUT_MODULE_DUPLICATE_IMPORT", `Module “${importedCanonical.value}” is imported by this source more than once.`));
        continue;
      }
      if (importedCanonical.value) seenSpecifiers.add(importedCanonical.value);
      await visit(declaration.module, specifier, declaration.span, depth + 1);
    }
    stack.pop(); state.set(specifier, "done"); order.push(specifier);
  };

  const entrySeen = new Set<string>();
  for (const declaration of localImports(entryModule)) {
    const canonical = canonicalSpecifier(declaration.module);
    if (canonical.value && entrySeen.has(canonical.value)) {
      diagnostics.push(diagnostic("project.cut", declaration.span, "CUT_MODULE_DUPLICATE_IMPORT", `Module “${canonical.value}” is imported by the entry source more than once.`));
      continue;
    }
    if (canonical.value) entrySeen.add(canonical.value);
    await visit(declaration.module, "project.cut", declaration.span, 1);
  }

  const contracts = new Map<string, CutUserModuleContract>();
  const modules = new Map<string, CutUserSourceModule>();
  for (const specifier of order) {
    const sourceModule = parsed.get(specifier);
    if (!sourceModule) continue;
    const check = checkCutModule(sourceModule.module, { packages: options.packages, userModules: contracts, moduleKind: "user" });
    check.diagnostics.forEach((item) => { if (!item.module) item.module = specifier; });
    diagnostics.push(...check.diagnostics);
    const contract: CutUserModuleContract = { specifier, exports: check.exports, privateNames: privateNames(sourceModule.module) };
    contracts.set(specifier, contract);
    modules.set(specifier, { ...sourceModule, check });
  }

  if (diagnostics.some((item) => item.severity === "error")) return { diagnostics };
  return { diagnostics, graph: { projectRoot, modules, contracts, order } };
}
