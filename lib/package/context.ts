import { hash } from "../core/stable";
import type { CutModule, Declaration, Expression, Statement, TypeReference } from "../language/ast";
import { builtinPackages, type CutPackageManifest as CutRuntimePackageManifest, type NodeDomain, type PackageParameter, type PackageSymbol } from "../language/packages";
import { packageFail } from "./diagnostics";
import type { CutPackageCapability } from "./manifest";
import type { ResolvedCutPackage, ResolvedCutPackageGraph } from "./resolver";

export type CutPackageComponentImplementation = {
  specifier: string;
  exported: string;
  moduleName: string;
  module: CutModule;
  declaration: Extract<Declaration, { kind: "component" }>;
  package: ResolvedCutPackage;
};

export type CutExternalPackageContext = {
  packages: Map<string, CutRuntimePackageManifest>;
  implementations: Map<string, CutPackageComponentImplementation>;
  modules: Map<string, ResolvedCutPackage>;
};

export function cutPackageImplementationKey(specifier: string, exported: string) { return `${specifier}\0${exported}`; }

function typeText(type: TypeReference): string {
  return type.arguments.length ? `${type.name}<${type.arguments.map(typeText).join(",")}>` : type.name;
}

function componentDomain(returnName: string): NodeDomain {
  return returnName === "Visual" ? "visual" : returnName === "AudioNode" ? "audio" : "av";
}

function componentChildren(domain: NodeDomain): PackageSymbol["children"] {
  return domain === "visual" ? "visual" : domain === "audio" ? "audio" : "any";
}

function packageParameter(parameter: Extract<Declaration, { kind: "component" }> ["parameters"][number]): PackageParameter {
  return { name: parameter.name, type: typeText(parameter.type), ...(parameter.defaultValue ? { optional: true } : {}) };
}

function exportedSymbol(name: string, declaration: Extract<Declaration, { kind: "component" }>, documentation: string): PackageSymbol {
  const returns = declaration.returnType ? typeText(declaration.returnType) : "AVNode", domain = componentDomain(returns);
  return {
    name,
    kind: "component",
    parameters: declaration.parameters.map(packageParameter),
    returns,
    domain,
    children: componentChildren(domain),
    effect: "pure",
    documentation,
  };
}

function calleeName(expression: Expression): string | undefined {
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "member") {
    const parent = calleeName(expression.object);
    return parent ? `${parent}.${expression.property}` : undefined;
  }
  return undefined;
}

function visitExpression(expression: Expression, visitCall: (name: string) => void) {
  if (expression.kind === "call") {
    const name = calleeName(expression.callee); if (name) visitCall(name);
    visitExpression(expression.callee, visitCall);
    expression.positional.forEach((item) => visitExpression(item, visitCall));
    expression.named.forEach((item) => visitExpression(item.value, visitCall));
  } else if (expression.kind === "array") expression.items.forEach((item) => visitExpression(item, visitCall));
  else if (expression.kind === "object") expression.entries.forEach((item) => visitExpression(item.value, visitCall));
  else if (expression.kind === "member") visitExpression(expression.object, visitCall);
  else if (expression.kind === "index") { visitExpression(expression.object, visitCall); visitExpression(expression.index, visitCall); }
  else if (expression.kind === "range") { visitExpression(expression.start, visitCall); visitExpression(expression.end, visitCall); }
  else if (expression.kind === "group" || expression.kind === "unary") visitExpression(expression.value, visitCall);
  else if (expression.kind === "binary") { visitExpression(expression.left, visitCall); visitExpression(expression.right, visitCall); }
}

function visitStatements(statements: Statement[], visitCall: (name: string) => void) {
  for (const statement of statements) {
    if (statement.kind === "let") visitExpression(statement.value, visitCall);
    else if (statement.kind === "node") { visitExpression(statement.expression, visitCall); visitStatements(statement.body, visitCall); }
    else if (statement.kind === "set") { visitExpression(statement.target, visitCall); visitExpression(statement.value, visitCall); }
    else if (statement.kind === "animate") {
      visitExpression(statement.target, visitCall); visitExpression(statement.from, visitCall); visitExpression(statement.to, visitCall); visitExpression(statement.duration, visitCall);
      if (statement.delay) visitExpression(statement.delay, visitCall); if (statement.easing) visitExpression(statement.easing, visitCall);
    } else if (statement.kind === "at") { visitExpression(statement.time, visitCall); visitStatements(statement.body, visitCall); }
    else if (statement.kind === "for") { visitExpression(statement.iterable, visitCall); visitStatements(statement.body, visitCall); }
    else if (statement.kind === "if") { visitExpression(statement.condition, visitCall); visitStatements(statement.consequent, visitCall); visitStatements(statement.alternate, visitCall); }
    else if (statement.kind === "assert") visitExpression(statement.condition, visitCall);
  }
}

function domainCapability(domain: NodeDomain | undefined): CutPackageCapability | undefined {
  return domain === "visual" ? "visual" : domain === "audio" ? "audio" : domain === "av" ? "av" : domain === "data" ? "data" : undefined;
}

function effectCapability(effect: PackageSymbol["effect"]): CutPackageCapability | undefined {
  return effect === "read" ? "media-read" : effect === "analyze" ? "analysis" : effect === "generate" ? "generation" : effect === "external" ? "external" : undefined;
}

function consumesMediaAsset(symbol: PackageSymbol) {
  if (!symbol.native) return false;
  return (symbol.parameters ?? []).some((parameter) => /^(?:Audio|Data|Font|Image|Video)Asset$/.test(parameter.type));
}

export function requiredCutPackageCapabilities(module: CutModule, externalPackages: ReadonlyMap<string, CutRuntimePackageManifest>) {
  const available = new Map<string, CutRuntimePackageManifest>([...builtinPackages, ...externalPackages]), symbols = new Map<string, PackageSymbol>(), required = new Set<CutPackageCapability>();
  for (const [name, symbol] of Object.entries(builtinPackages.get("cut:core")!.symbols)) symbols.set(name, symbol);
  for (const declaration of module.declarations) {
    if (declaration.kind === "import") {
      const package_ = available.get(declaration.module);
      for (const imported of declaration.names) {
        const symbol = package_?.symbols[imported.imported]; if (symbol) symbols.set(imported.local, symbol);
      }
    } else if (declaration.kind === "component") {
      required.add(componentDomain(declaration.returnType?.name ?? "AVNode") === "visual" ? "visual" : componentDomain(declaration.returnType?.name ?? "AVNode") === "audio" ? "audio" : "av");
      declaration.parameters.forEach((parameter) => { if (parameter.defaultValue) visitExpression(parameter.defaultValue, visitCall); });
      visitStatements(declaration.body, visitCall);
    }
  }
  function visitCall(name: string) {
    const symbol = symbols.get(name); if (!symbol) return;
    const domain = domainCapability(symbol.domain), effect = effectCapability(symbol.effect);
    if (domain) required.add(domain); if (effect) required.add(effect); if (consumesMediaAsset(symbol)) required.add("media-read");
  }
  return required;
}

export function assertCutPackageCapabilities(resolved: ResolvedCutPackage, externalPackages: ReadonlyMap<string, CutRuntimePackageManifest>) {
  const required = requiredCutPackageCapabilities(resolved.module, externalPackages);
  for (const capability of [...required].sort()) if (!resolved.manifest.capabilities.includes(capability)) {
    packageFail("CUT_PACKAGE_CAPABILITY_DENIED", `${resolved.manifest.name}.capabilities`, `package source requires undeclared ${capability} capability.`);
  }
  return required;
}

export function createCutExternalPackageContext(graph: ResolvedCutPackageGraph): CutExternalPackageContext {
  const packages = new Map<string, CutRuntimePackageManifest>(), implementations = new Map<string, CutPackageComponentImplementation>(), modules = new Map<string, ResolvedCutPackage>();
  for (const resolved of [...graph.packages.values()].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))) {
    const declarations = new Map(resolved.module.declarations.filter((item): item is Extract<Declaration, { kind: "component" }> => item.kind === "component").map((item) => [item.name, item]));
    const symbols: Record<string, PackageSymbol> = {};
    for (const [exported, contract] of Object.entries(resolved.manifest.exports).sort(([left], [right]) => left.localeCompare(right))) {
      const declaration = declarations.get(contract.declaration);
      if (!declaration) throw new Error(`Resolved CUT package ${resolved.manifest.name} lost exported declaration ${contract.declaration}.`);
      symbols[exported] = exportedSymbol(exported, declaration, contract.documentation);
      implementations.set(cutPackageImplementationKey(resolved.manifest.name, exported), {
        specifier: resolved.manifest.name,
        exported,
        moduleName: `${resolved.manifest.name}/${resolved.manifest.entry}`,
        module: resolved.module,
        declaration,
        package: resolved,
      });
    }
    const specifier = resolved.manifest.name, version = resolved.manifest.version, apiIntegrity = hash({ specifier, version, symbols });
    const implementationIntegrity = resolved.contentIntegrity.slice("sha256-".length), integrity = hash({ apiIntegrity, implementationIntegrity });
    packages.set(specifier, { specifier, version, symbols, apiIntegrity, implementationIntegrity, integrity });
    modules.set(specifier, resolved);
  }
  for (const resolved of modules.values()) assertCutPackageCapabilities(resolved, packages);
  return { packages, implementations, modules };
}
