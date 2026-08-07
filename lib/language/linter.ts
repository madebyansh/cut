import type { CutModule, Declaration, Expression, LanguageDiagnostic, Statement } from "./ast";

type CandidateKind = "import" | "asset" | "const" | "function" | "component" | "timeline";

type Candidate = {
  name: string;
  kind: CandidateKind;
  declaration: Declaration;
  references: Set<string>;
};

function expressionReferences(expression: Expression, shadowed: ReadonlySet<string>, result: Set<string>) {
  if (expression.kind === "identifier") {
    if (!shadowed.has(expression.name)) result.add(expression.name);
    return;
  }
  if (expression.kind === "number" || expression.kind === "string" || expression.kind === "boolean" || expression.kind === "null" || expression.kind === "color") return;
  if (expression.kind === "array") expression.items.forEach((item) => expressionReferences(item, shadowed, result));
  else if (expression.kind === "object") expression.entries.forEach((entry) => expressionReferences(entry.value, shadowed, result));
  else if (expression.kind === "member") expressionReferences(expression.object, shadowed, result);
  else if (expression.kind === "index") {
    expressionReferences(expression.object, shadowed, result);
    expressionReferences(expression.index, shadowed, result);
  } else if (expression.kind === "range") {
    expressionReferences(expression.start, shadowed, result);
    expressionReferences(expression.end, shadowed, result);
  } else if (expression.kind === "group" || expression.kind === "unary") expressionReferences(expression.value, shadowed, result);
  else if (expression.kind === "binary") {
    expressionReferences(expression.left, shadowed, result);
    expressionReferences(expression.right, shadowed, result);
  } else if (expression.kind === "call") {
    expressionReferences(expression.callee, shadowed, result);
    expression.positional.forEach((item) => expressionReferences(item, shadowed, result));
    expression.named.forEach((item) => expressionReferences(item.value, shadowed, result));
  }
}

function statementReferences(statements: readonly Statement[], shadowed: Set<string>, result: Set<string>) {
  for (const statement of statements) {
    if (statement.kind === "let") {
      expressionReferences(statement.value, shadowed, result);
      shadowed.add(statement.name);
    } else if (statement.kind === "node") {
      expressionReferences(statement.expression, shadowed, result);
      statementReferences(statement.body, new Set(shadowed), result);
      if (statement.binding) shadowed.add(statement.binding);
    } else if (statement.kind === "set") {
      expressionReferences(statement.target, shadowed, result);
      expressionReferences(statement.value, shadowed, result);
    } else if (statement.kind === "animate") {
      expressionReferences(statement.target, shadowed, result);
      expressionReferences(statement.from, shadowed, result);
      expressionReferences(statement.to, shadowed, result);
      expressionReferences(statement.duration, shadowed, result);
      if (statement.delay) expressionReferences(statement.delay, shadowed, result);
      if (statement.easing) expressionReferences(statement.easing, shadowed, result);
    } else if (statement.kind === "at") {
      expressionReferences(statement.time, shadowed, result);
      statementReferences(statement.body, new Set(shadowed), result);
    } else if (statement.kind === "for") {
      expressionReferences(statement.iterable, shadowed, result);
      const nested = new Set(shadowed);
      nested.add(statement.item);
      statementReferences(statement.body, nested, result);
    } else if (statement.kind === "if") {
      expressionReferences(statement.condition, shadowed, result);
      statementReferences(statement.consequent, new Set(shadowed), result);
      statementReferences(statement.alternate, new Set(shadowed), result);
    } else expressionReferences(statement.condition, shadowed, result);
  }
}

function declarationReferences(declaration: Declaration) {
  const result = new Set<string>();
  if (declaration.kind === "asset" || declaration.kind === "const" || declaration.kind === "export") {
    expressionReferences(declaration.value, new Set(), result);
  } else if (declaration.kind === "function") {
    const shadowed = new Set<string>();
    for (const parameter of declaration.parameters) {
      if (parameter.defaultValue) expressionReferences(parameter.defaultValue, shadowed, result);
      shadowed.add(parameter.name);
    }
    expressionReferences(declaration.value, shadowed, result);
  } else if (declaration.kind === "component") {
    const shadowed = new Set<string>();
    for (const parameter of declaration.parameters) {
      shadowed.add(parameter.name);
      if (parameter.defaultValue) expressionReferences(parameter.defaultValue, shadowed, result);
    }
    shadowed.add("self");
    statementReferences(declaration.body, shadowed, result);
  } else if (declaration.kind === "timeline") {
    declaration.arguments.forEach((argument) => expressionReferences(argument.value, new Set(), result));
    const timelineScope = new Set<string>();
    for (const item of declaration.items) {
      if (item.kind === "scene") {
        item.arguments.forEach((argument) => expressionReferences(argument.value, timelineScope, result));
        statementReferences(item.body, new Set(timelineScope), result);
      } else statementReferences([item], timelineScope, result);
    }
  }
  return result;
}

function candidates(module: CutModule) {
  const result = new Map<string, Candidate>();
  for (const declaration of module.declarations) {
    if (declaration.kind === "import") {
      for (const item of declaration.names) {
        result.set(item.local, { name: item.local, kind: "import", declaration, references: new Set() });
      }
    } else if (declaration.kind === "asset" || declaration.kind === "const" || declaration.kind === "function" || declaration.kind === "component" || declaration.kind === "timeline") {
      result.set(declaration.name, { name: declaration.name, kind: declaration.kind, declaration, references: declarationReferences(declaration) });
    }
  }
  return result;
}

function reachableNames(module: CutModule, values: ReadonlyMap<string, Candidate>) {
  const reachable = new Set<string>();
  const pending = module.declarations
    .filter((declaration): declaration is Extract<Declaration, { kind: "export" }> => declaration.kind === "export")
    .flatMap((declaration) => [...declarationReferences(declaration)]);
  while (pending.length) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    const candidate = values.get(name);
    if (!candidate) continue;
    reachable.add(name);
    candidate.references.forEach((reference) => pending.push(reference));
  }
  return reachable;
}

function unusedDiagnostic(candidate: Candidate): LanguageDiagnostic {
  const quoted = `“${candidate.name}”`;
  if (candidate.kind === "import") return {
    severity: "warning",
    code: "CUTL1001",
    message: `Imported symbol ${quoted} is not reachable from any exported render target.`,
    span: candidate.declaration.span,
    hint: "Remove the import or use it in an exported audiovisual graph.",
  };
  if (candidate.kind === "asset" || candidate.kind === "const") return {
    severity: "warning",
    code: "CUTL1002",
    message: `${candidate.kind} ${quoted} is not reachable from any exported render target.`,
    span: candidate.declaration.span,
    hint: "Remove the declaration or connect it to an exported timeline.",
  };
  if (candidate.kind === "component") return {
    severity: "warning",
    code: "CUTL1003",
    message: `Component ${quoted} is not reachable from any exported render target.`,
    span: candidate.declaration.span,
    hint: "Remove the component or invoke it from an exported audiovisual graph.",
  };
  if (candidate.kind === "function") return {
    severity: "warning",
    code: "CUTL1006",
    message: `Function ${quoted} is not reachable from any export.`,
    span: candidate.declaration.span,
    hint: "Remove the function or use it from an exported value, function, component, or render graph.",
  };
  return {
    severity: "warning",
    code: "CUTL1004",
    message: `Timeline ${quoted} is not reachable from any exported render target.`,
    span: candidate.declaration.span,
    hint: "Export render(timeline) or remove the unreachable timeline.",
  };
}

/**
 * Perform source-graph lint after parser/type/lowering validation.
 *
 * Reachability starts at formal export declarations and follows top-level
 * imports, values, components, and timelines with lexical-shadow awareness.
 * The linter never treats comments, spelling, or hidden runtime state as
 * executable meaning.
 */
export function lintCutModule(module: CutModule): LanguageDiagnostic[] {
  const values = candidates(module);
  const reachable = reachableNames(module, values);
  const diagnostics: LanguageDiagnostic[] = [];
  if (!module.declarations.some((declaration) => declaration.kind === "export")) diagnostics.push({
    severity: "warning",
    code: "CUTL1005",
    message: "The module has no exported render target.",
    span: module.span,
    hint: "Add `export name = render(timeline);` so the project has an executable delivery target.",
  });
  for (const candidate of values.values()) if (!reachable.has(candidate.name)) diagnostics.push(unusedDiagnostic(candidate));
  return diagnostics.sort((left, right) =>
    left.span.start.offset - right.span.start.offset
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message));
}
