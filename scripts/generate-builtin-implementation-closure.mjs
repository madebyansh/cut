#!/usr/bin/env node

import { builtinModules } from "node:module";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const builtinImplementationClosureLimits = Object.freeze({
  maximumFilesPerPackage: 512,
  maximumImportsPerFile: 2_048,
  maximumFileBytes: 8 * 1024 * 1024,
  maximumTotalBytes: 64 * 1024 * 1024,
  maximumSpecifierBytes: 1_024,
  maximumRootBytes: 1024 * 1024,
});

const moduleIdPattern = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.json)?$/u;
const externalNamePattern = /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)$/u;
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name.slice(5) : `node:${name}`]));
const createRequirePolicyModule = "language/dependency-identity";
const nativeBinaryLoaderPolicyModule = "runtime/reference/native-source-over";

export class BuiltinImplementationClosureError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "BuiltinImplementationClosureError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BuiltinImplementationClosureError(code, message);
}

function exactObject(value, path, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CUT_IMPLEMENTATION_ROOTS_SHAPE", `${path} must be an object.`);
  const keys = Object.keys(value).sort(), expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("CUT_IMPLEMENTATION_ROOTS_SHAPE", `${path} must contain exactly: ${expected.join(", ")}.`);
  }
  return value;
}

function boundedBytes(path, maximum, label) {
  let descriptor;
  try { descriptor = openSync(path, "r"); }
  catch { fail("CUT_IMPLEMENTATION_FILE_MISSING", `${label} is missing or unreadable.`); }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximum) {
      fail("CUT_IMPLEMENTATION_FILE_BOUNDS", `${label} must be a non-empty regular file no larger than ${maximum} bytes.`);
    }
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor);
    if (bytes.byteLength !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      fail("CUT_IMPLEMENTATION_FILE_CHANGED", `${label} changed while its bytes were read.`);
    }
    return bytes;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail("CUT_IMPLEMENTATION_ROOTS_JSON", `${label} is not valid UTF-8 JSON.`); }
}

function canonicalModuleId(value, path) {
  if (typeof value !== "string"
    || !value.length
    || Buffer.byteLength(value, "utf8") > builtinImplementationClosureLimits.maximumSpecifierBytes
    || !moduleIdPattern.test(value)
    || value.includes("\\")
    || isAbsolute(value)
    || value.split("/").some((part) => part === "." || part === "..")
    || [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(value))) {
    fail("CUT_IMPLEMENTATION_MODULE_ID", `${path} must be a canonical lib-root-relative TypeScript module ID or explicit .json ID.`);
  }
  return value;
}

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
}

function arrayOfStrings(value, path, validator) {
  if (!Array.isArray(value)) fail("CUT_IMPLEMENTATION_ROOTS_SHAPE", `${path} must be an array.`);
  const result = value.map((item, index) => validator(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail("CUT_IMPLEMENTATION_ROOTS_SHAPE", `${path} cannot contain duplicate entries.`);
  return result;
}

function readRoots(path) {
  const root = exactObject(
    parseJson(boundedBytes(path, builtinImplementationClosureLimits.maximumRootBytes, "built-in implementation roots"), "built-in implementation roots"),
    "$",
    ["format", "version", "externals", "shared", "packages"],
  );
  if (root.format !== "cut-builtin-implementation-roots" || root.version !== 1) {
    fail("CUT_IMPLEMENTATION_ROOTS_VERSION", "built-in implementation roots must use cut-builtin-implementation-roots v1.");
  }
  const externals = arrayOfStrings(root.externals, "$.externals", (value, path_) => {
    if (typeof value !== "string" || !externalNamePattern.test(value)) fail("CUT_IMPLEMENTATION_EXTERNAL", `${path_} is not a canonical external package name.`);
    return value;
  }).sort();
  const shared = arrayOfStrings(root.shared, "$.shared", canonicalModuleId);
  if (!shared.length) fail("CUT_IMPLEMENTATION_ROOTS_SHAPE", "$.shared must contain at least one implementation root.");
  if (!root.packages || typeof root.packages !== "object" || Array.isArray(root.packages)) fail("CUT_IMPLEMENTATION_ROOTS_SHAPE", "$.packages must be an object.");
  const packages = {};
  for (const name of Object.keys(root.packages).sort()) {
    if (!name.length || Buffer.byteLength(name, "utf8") > 256) fail("CUT_IMPLEMENTATION_ROOTS_SHAPE", `invalid built-in package name ${JSON.stringify(name)}.`);
    packages[name] = arrayOfStrings(root.packages[name], `$.packages[${JSON.stringify(name)}]`, canonicalModuleId);
  }
  if (!Object.keys(packages).length) fail("CUT_IMPLEMENTATION_ROOTS_SHAPE", "$.packages must declare at least one built-in package.");
  return { externals: new Set(externals), shared, packages };
}

function inside(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function secureExistingFile(path, libRoot, label) {
  let metadata;
  try { metadata = lstatSync(path); }
  catch { return false; }
  if (metadata.isSymbolicLink()) fail("CUT_IMPLEMENTATION_PATH_ESCAPE", `${label} cannot resolve through a symbolic link.`);
  if (!metadata.isFile()) return false;
  const canonical = realpathSync(path), lexical = resolve(path);
  if (!inside(libRoot, canonical) || canonical !== lexical) fail("CUT_IMPLEMENTATION_PATH_ESCAPE", `${label} must resolve to a regular file inside lib without symbolic path components.`);
  return true;
}

function idForPath(path, libRoot) {
  const value = relative(libRoot, path).split(sep).join("/");
  if (value.endsWith(".ts")) return canonicalModuleId(value.slice(0, -3), "resolved module");
  if (value.endsWith(".json")) return canonicalModuleId(value, "resolved module");
  fail("CUT_IMPLEMENTATION_RESOLUTION", `resolved implementation file ${JSON.stringify(value)} has an unsupported extension.`);
}

function pathForRootId(id, libRoot) {
  const lexical = resolve(libRoot, id.endsWith(".json") ? id : `${id}.ts`);
  if (!inside(libRoot, lexical) || !secureExistingFile(lexical, libRoot, `root ${JSON.stringify(id)}`)) {
    fail("CUT_IMPLEMENTATION_FILE_MISSING", `root ${JSON.stringify(id)} does not resolve to a bounded local implementation file.`);
  }
  return lexical;
}

function localCandidates(importerPath, specifier) {
  const base = resolve(dirname(importerPath), specifier), extension = extname(specifier);
  if (!extension) return [`${base}.ts`, resolve(base, "index.ts"), `${base}.json`];
  if (extension === ".js") return [base.slice(0, -3) + ".ts"];
  if (extension === ".ts" || extension === ".json") return [base];
  fail("CUT_IMPLEMENTATION_RESOLUTION", `local import ${JSON.stringify(specifier)} uses unsupported extension ${JSON.stringify(extension)}.`);
}

function resolveLocalImport(importerId, importerPath, specifier, libRoot) {
  if (specifier.includes("\\") || specifier.includes("\0") || Buffer.byteLength(specifier, "utf8") > builtinImplementationClosureLimits.maximumSpecifierBytes) {
    fail("CUT_IMPLEMENTATION_RESOLUTION", `${importerId} has an invalid local import specifier.`);
  }
  const candidates = localCandidates(importerPath, specifier);
  if (candidates.some((candidate) => !inside(libRoot, candidate))) {
    fail("CUT_IMPLEMENTATION_PATH_ESCAPE", `${importerId} import ${JSON.stringify(specifier)} escapes the lib implementation root.`);
  }
  const matches = candidates.filter((candidate) => secureExistingFile(candidate, libRoot, `${importerId} import ${JSON.stringify(specifier)}`));
  if (!matches.length) fail("CUT_IMPLEMENTATION_IMPORT_MISSING", `${importerId} import ${JSON.stringify(specifier)} does not resolve to local TypeScript or JSON.`);
  if (matches.length > 1) fail("CUT_IMPLEMENTATION_IMPORT_AMBIGUOUS", `${importerId} import ${JSON.stringify(specifier)} resolves to multiple local files.`);
  return { id: idForPath(matches[0], libRoot), path: matches[0] };
}

function hasRuntimeImport(importClause) {
  if (!importClause) return true;
  if (importClause.isTypeOnly) return false;
  const bindings = importClause.namedBindings;
  return Boolean(importClause.name)
    || !bindings
    || ts.isNamespaceImport(bindings)
    || (ts.isNamedImports(bindings) && bindings.elements.some((element) => !element.isTypeOnly));
}

function hasRuntimeExport(node) {
  if (node.isTypeOnly) return false;
  return !node.exportClause
    || !ts.isNamedExports(node.exportClause)
    || node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function literalSpecifier(argument) {
  return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : undefined;
}

function unwrapExpression(value) {
  let current = value;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) current = current.expression;
  return current;
}

function validateCreateRequirePolicy(id, source, roots) {
  if (id !== createRequirePolicyModule) return { importedName: undefined, complexTextDependencyNames: [] };
  let importedName, dependencyNames, complexTextDependencyNames;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ["node:module", "module"].includes(statement.moduleSpecifier.text)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) !== "createRequire" || element.isTypeOnly) continue;
          if (importedName !== undefined) fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} may import createRequire exactly once.`);
          importedName = element.name.text;
        }
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)
        || (declaration.name.text !== "referenceDependencyNames"
          && declaration.name.text !== "referenceComplexTextDependencyNames")) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!initializer || !ts.isArrayLiteralExpression(initializer) || initializer.elements.some((item) => !ts.isStringLiteral(item))) {
        fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} ${declaration.name.text} must remain a literal closed string array.`);
      }
      const names = initializer.elements.map((item) => item.text).sort();
      if (declaration.name.text === "referenceDependencyNames") dependencyNames = names;
      else complexTextDependencyNames = names;
    }
  }
  if (!importedName) fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} must import createRequire from node:module for bounded external package resolution.`);
  const expected = [...roots.externals].sort();
  const tracked = [...(dependencyNames ?? []), ...(complexTextDependencyNames ?? [])].sort();
  if (!dependencyNames
    || !complexTextDependencyNames
    || new Set(tracked).size !== tracked.length
    || tracked.length !== expected.length
    || tracked.some((value, index) => value !== expected[index])) {
    fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} base and feature dependency name arrays must be disjoint and exactly cover the tracked external closure: ${expected.join(", ")}.`);
  }
  return { importedName, complexTextDependencyNames };
}

function safeTrackedResolveArgument(value) {
  if (ts.isIdentifier(value) && value.text === "name") return true;
  if (!ts.isTemplateExpression(value) || value.head.text !== "" || value.templateSpans.length !== 1) return false;
  const [span] = value.templateSpans;
  return ts.isIdentifier(span.expression) && span.expression.text === "name" && span.literal.text === "/package.json";
}

function validateCreateRequireReferences(id, source, complexTextDependencyNames) {
  if (id !== createRequirePolicyModule) return;
  const trackedFeaturePackageCalls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "packageJsonFor") {
      if (node.arguments.length !== 2
        || !ts.isIdentifier(node.arguments[0])
        || node.arguments[0].text !== "requireFromHere"
        || !ts.isIdentifier(node.arguments[1])
        || node.arguments[1].text !== "name") {
        fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} may pass its bounded resolver only to packageJsonFor(requireFromHere, name).`);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "trackedPackageJson") {
      const name = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : undefined;
      if (name === undefined) {
        fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} trackedPackageJson calls must use one literal feature dependency name.`);
      }
      trackedFeaturePackageCalls.push(name);
    }
    if (ts.isIdentifier(node) && node.text === "requireFromHere") {
      const parent = node.parent;
      const declaration = (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node;
      const resolveReceiver = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "resolve";
      const boundedArgument = ts.isCallExpression(parent)
        && ts.isIdentifier(parent.expression)
        && parent.expression.text === "packageJsonFor"
        && parent.arguments[0] === node;
      if (!declaration && !resolveReceiver && !boundedArgument) {
        fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} uses requireFromHere outside its one closed external-resolution path.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const actual = trackedFeaturePackageCalls.sort();
  const expected = [...complexTextDependencyNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} must bind each feature dependency package root exactly once: ${expected.join(", ")}.`);
  }
}

function runtimeDependencies(id, path, bytes, roots, libRoot) {
  if (id.endsWith(".json")) return [];
  const source = ts.createSourceFile(path, bytes.toString("utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) {
    const diagnostic = source.parseDiagnostics[0], position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    fail("CUT_IMPLEMENTATION_PARSE", `${id}:${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  const createRequirePolicy = validateCreateRequirePolicy(id, source, roots);
  validateCreateRequireReferences(id, source, createRequirePolicy.complexTextDependencyNames);
  const dependencies = new Map(), trackedExternal = (specifier) => {
    if (nodeBuiltins.has(specifier) || roots.externals.has(packageName(specifier))) return;
    fail("CUT_IMPLEMENTATION_EXTERNAL", `${id} imports untracked external module ${JSON.stringify(specifier)}.`);
  };
  let imports = 0;
  const accept = (specifier) => {
    imports += 1;
    if (imports > builtinImplementationClosureLimits.maximumImportsPerFile) {
      fail("CUT_IMPLEMENTATION_IMPORT_LIMIT", `${id} exceeds ${builtinImplementationClosureLimits.maximumImportsPerFile} module references.`);
    }
    if (Buffer.byteLength(specifier, "utf8") > builtinImplementationClosureLimits.maximumSpecifierBytes || specifier.includes("\0")) {
      fail("CUT_IMPLEMENTATION_RESOLUTION", `${id} contains an invalid module specifier.`);
    }
    if (specifier.startsWith(".")) {
      const resolved = resolveLocalImport(id, path, specifier, libRoot);
      dependencies.set(resolved.id, resolved.path);
    } else trackedExternal(specifier);
  };
  let createRequireCalls = 0, trackedResolveCalls = 0, nativeBinaryLoaderCalls = 0;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && hasRuntimeImport(node.importClause)) {
      const createRequireImport = ["node:module", "module"].includes(node.moduleSpecifier.text)
        && node.importClause?.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some((element) => (element.propertyName?.text ?? element.name.text) === "createRequire" && !element.isTypeOnly);
      if (createRequireImport && id !== createRequirePolicyModule) {
        fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} cannot create an untracked module loader.`);
      }
      accept(node.moduleSpecifier.text);
    }
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && hasRuntimeExport(node)) accept(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literalSpecifier(node.moduleReference.expression);
      if (specifier === undefined) fail("CUT_IMPLEMENTATION_DYNAMIC_IMPORT", `${id} contains a non-literal import-equals module reference.`);
      accept(specifier);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const requireMember = ts.isPropertyAccessExpression(node.expression)
        && ((ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "require" && node.expression.name.text === "resolve")
          || (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "module" && node.expression.name.text === "require"));
      const createRequireCall = (ts.isIdentifier(node.expression) && node.expression.text === createRequirePolicy.importedName)
        || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createRequire");
      const trackedResolve = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "requireFromHere"
        && node.expression.name.text === "resolve";
      const directTrackedLoaderCall = ts.isIdentifier(node.expression) && node.expression.text === "requireFromHere";
      const nativeLoaderDeclaration = ts.isVariableDeclaration(node.parent)
        ? node.parent
        : ts.isAsExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent)
          ? node.parent.parent
          : undefined;
      if (createRequireCall) {
        if (id !== createRequirePolicyModule
          || node.arguments.length !== 1
          || !ts.isIdentifier(node.arguments[0])
          || node.arguments[0].text !== "__filename"
          || !ts.isVariableDeclaration(node.parent)
          || !ts.isIdentifier(node.parent.name)
          || node.parent.name.text !== "requireFromHere") {
          fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} cannot create a computed or local module loader.`);
        }
        createRequireCalls += 1;
      } else if (trackedResolve) {
        if (id !== createRequirePolicyModule || node.arguments.length !== 1 || !safeTrackedResolveArgument(node.arguments[0])) {
          fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} createRequire resolver may address only the closed tracked dependency name or its package.json.`);
        }
        trackedResolveCalls += 1;
      } else if (directTrackedLoaderCall) {
        fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} cannot execute the createRequire loader; only closed external .resolve calls are permitted.`);
      } else if (requireCall
        && id === nativeBinaryLoaderPolicyModule
        && node.arguments.length === 1
        && ts.isIdentifier(node.arguments[0])
        && node.arguments[0].text === "locator"
        && nativeLoaderDeclaration !== undefined
        && ts.isIdentifier(nativeLoaderDeclaration.name)
        && nativeLoaderDeclaration.name.text === "candidate") {
        nativeBinaryLoaderCalls += 1;
      } else if (dynamicImport || requireCall || requireMember) {
        const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : undefined;
        if (specifier === undefined) fail("CUT_IMPLEMENTATION_DYNAMIC_IMPORT", `${id} contains a computed module load that cannot enter the deterministic closure.`);
        if (["node:module", "module"].includes(specifier) && (dynamicImport || requireCall)) {
          fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} cannot acquire a module-loader factory dynamically.`);
        }
        accept(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (id === createRequirePolicyModule && (createRequireCalls !== 1 || trackedResolveCalls < 1)) {
    fail("CUT_IMPLEMENTATION_CREATE_REQUIRE", `${id} must create one bounded resolver and use it only for the tracked external dependency set.`);
  }
  if (id === nativeBinaryLoaderPolicyModule && nativeBinaryLoaderCalls !== 1) {
    fail("CUT_IMPLEMENTATION_DYNAMIC_IMPORT", `${id} must load exactly one authenticated adjacent native binary through its closed locator.`);
  }
  return [...dependencies].sort(([left], [right]) => left.localeCompare(right));
}

export function generateBuiltinImplementationClosure(options = {}) {
  const workspaceRoot = realpathSync(options.workspaceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const libRoot = realpathSync(options.libRoot ?? resolve(workspaceRoot, "lib"));
  const rootsPath = options.rootsPath ?? resolve(libRoot, "language", "builtin-implementation-roots.json");
  const roots = readRoots(rootsPath), overrides = options.sourceOverrides ?? new Map(), usedOverrides = new Set();
  const moduleCache = new Map(), byteCounted = new Set();
  let totalBytes = 0;
  const load = (id, knownPath) => {
    if (moduleCache.has(id)) return moduleCache.get(id);
    const path = knownPath ?? pathForRootId(id, libRoot);
    const override = overrides.get(id), bytes = override === undefined
      ? boundedBytes(path, builtinImplementationClosureLimits.maximumFileBytes, `implementation module ${JSON.stringify(id)}`)
      : Buffer.isBuffer(override) ? override : Buffer.from(String(override), "utf8");
    if (override !== undefined) usedOverrides.add(id);
    if (bytes.byteLength <= 0 || bytes.byteLength > builtinImplementationClosureLimits.maximumFileBytes) {
      fail("CUT_IMPLEMENTATION_FILE_BOUNDS", `implementation module ${JSON.stringify(id)} must contain 1..${builtinImplementationClosureLimits.maximumFileBytes} bytes.`);
    }
    if (!byteCounted.has(id)) {
      byteCounted.add(id); totalBytes += bytes.byteLength;
      if (totalBytes > builtinImplementationClosureLimits.maximumTotalBytes) {
        fail("CUT_IMPLEMENTATION_TOTAL_LIMIT", `implementation closure exceeds ${builtinImplementationClosureLimits.maximumTotalBytes} source bytes.`);
      }
    }
    const record = { id, path, dependencies: runtimeDependencies(id, path, bytes, roots, libRoot) };
    moduleCache.set(id, record);
    return record;
  };
  const packages = {};
  for (const packageName_ of Object.keys(roots.packages).sort()) {
    const seen = new Set(), pending = [...new Set([...roots.shared, ...roots.packages[packageName_]])].sort().reverse();
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      if (seen.size >= builtinImplementationClosureLimits.maximumFilesPerPackage) {
        fail("CUT_IMPLEMENTATION_FILE_LIMIT", `${packageName_} exceeds ${builtinImplementationClosureLimits.maximumFilesPerPackage} implementation files.`);
      }
      seen.add(id);
      for (const [dependencyId, dependencyPath] of load(id).dependencies) {
        if (!moduleCache.has(dependencyId)) load(dependencyId, dependencyPath);
        if (!seen.has(dependencyId)) pending.push(dependencyId);
      }
      pending.sort().reverse();
    }
    packages[packageName_] = [...seen].sort();
  }
  const unusedOverrides = [...overrides.keys()].filter((id) => !usedOverrides.has(id));
  if (unusedOverrides.length) fail("CUT_IMPLEMENTATION_OVERRIDE_UNUSED", `source override(s) do not belong to the generated closure: ${unusedOverrides.sort().join(", ")}.`);
  const manifest = { format: "cut-builtin-implementation-closure", version: 1, packages };
  return { manifest, text: `${JSON.stringify(manifest, null, 2)}\n`, modules: moduleCache.size, bytes: totalBytes };
}

export function checkBuiltinImplementationClosure(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputPath = options.outputPath ?? resolve(workspaceRoot, "lib/language/builtin-implementation-closure.json");
  const generated = generateBuiltinImplementationClosure({ ...options, workspaceRoot });
  let current;
  try { current = readFileSync(outputPath); }
  catch { fail("CUT_IMPLEMENTATION_CLOSURE_MISSING", "generated built-in implementation closure manifest is missing."); }
  if (!current.equals(Buffer.from(generated.text))) {
    fail("CUT_IMPLEMENTATION_CLOSURE_STALE", "generated built-in implementation closure manifest is stale; run the generator with --write.");
  }
  return generated;
}

export function writeBuiltinImplementationClosure(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputPath = options.outputPath ?? resolve(workspaceRoot, "lib/language/builtin-implementation-closure.json");
  const generated = generateBuiltinImplementationClosure({ ...options, workspaceRoot }), temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, generated.text, { encoding: "utf8", flag: "wx", mode: 0o644 });
    renameSync(temporary, outputPath);
  } finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
  return generated;
}

function commandLine(argv) {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0])) {
    fail("CUT_IMPLEMENTATION_USAGE", "usage: generate-builtin-implementation-closure.mjs --check|--write");
  }
  const result = argv[0] === "--write" ? writeBuiltinImplementationClosure() : checkBuiltinImplementationClosure();
  process.stdout.write(`${argv[0] === "--write" ? "wrote" : "verified"} ${Object.keys(result.manifest.packages).length} package closures (${result.modules} modules, ${result.bytes} bytes)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { commandLine(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
